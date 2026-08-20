# 面向 Agent 的任务闭环规划

## 目标与边界

目标不是让插件自行调用大模型，而是让 MCP 客户端能够以低 Token、可恢复、可验证的方式完成多步网页任务。浏览器扩展继续负责本地执行和安全策略；任务编排、计划和验证放在 `mcp-server`，以便兼容 Codex、Claude Code 等不同 Agent。

每次页面写操作后必须回到“观察”状态，不允许根据过期 DOM 连续执行动作。

```
任务目标 → Planner → Observe → 单步 Act → Verify ─┐
                ↑            │          │            │
                └── 修订计划 ←┴── 失败证据 └→ 完成/暂停
```

## 采用的开源模式

| 模式 | 引用实现 | WebPilot 的落点 |
| --- | --- | --- |
| 观察、动作、结构化提取分离 | [Stagehand](https://github.com/browserbase/stagehand) | `observe` 返回紧凑快照；`act` 只执行一项操作；`verify` 返回结构化断言。 |
| 页面变更后中止后续动作 | [Browser Use agent service](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/service.py) | URL、焦点或页面指纹变化后立即重新观察，不复用旧 `@eN`。 |
| 重复动作 + 页面停滞检测 | [Browser Use loop detector](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/views.py) | 滑动窗口记录“动作哈希 + 页面指纹”；达到阈值暂停并把证据交给 Agent。 |
| 计划、运行工件、视觉自检 | [Microsoft Webwright](https://github.com/microsoft/Webwright) | 每个任务持久化计划、步骤证据、失败截图和最终摘要。 |

## 第一阶段：确定性闭环（优先开发，约 2 周）

**当前进度：核心任务会话、单步执行、观察/验证、指纹循环检测、JSONL 证据日志、失败截图和软检查点恢复已实现。软检查点只恢复 URL 并比较页面指纹，不回滚表单或服务端副作用。任务观察已压缩为紧凑索引行（富字段留服务端），动作后撞登录页会自动暂停并交还人工，登录完成后用 `resume_task` 恢复。**

不引入内置 LLM；先让任意 MCP Agent 可以可靠地运行闭环。

1. **任务会话与状态机**
   - `start_task` 创建任务 ID、目标、最大步数和初始安全策略快照。
   - 状态：`planning → observing → acting → verifying → completed | paused | failed | cancelled`；`paused` 任务经 `resume_task` 清零停滞计数并回到 `observing`。
   - `cancel_task` 与插件一键停止联动。

2. **三个窄工具**
   - `observe`: 调用 `get_page_info`，生成页面指纹（URL、标题、交互元素数量、可交互文本哈希）。
   - `act`: 一次只允许一个既有操作；导航、点击、输入之后强制失效旧元素引用。
   - `verify`: 支持 URL、元素可见性/消失、文本、元素数量变化等确定性断言；返回 `pass/fail/inconclusive` 和证据。

3. **执行保护**
   - 每步都有超时、重试预算和前后页面指纹。
   - 同一个“动作哈希 + 页面指纹”连续出现 3 次，或 5 步没有指纹变化时自动暂停。
   - 仅对“元素短暂不可见、页面仍在加载”重试；绝不盲目重试提交、删除、发送等写操作。

4. **可观测性**
   - 任务日志为 JSONL：计划、观察、动作、验证、耗时、失败原因；继续排除输入文本和脚本。
   - 失败时保存动作前后快照；按需保存截图而非每步截图，控制存储与 Token。

验收：使用固定站点演示完成“搜索 → 筛选 → 打开详情 → 提取字段”任务；页面跳转后不发生过期元素点击；停滞时在预算内暂停而非循环。

## 第二阶段：Agent 计划与验证（约 2 周）

**当前进度：已实现结构化计划接入、按步骤执行/验证/推进，以及从完成计划保存并参数化复用工作流。内置 LLM Planner/Validator 仍未引入，继续由 MCP Agent 生成计划。**

- 为 Planner 规定 JSON 输出：目标、前置条件、单步预期、完成条件、风险等级。
- 增加 Validator：优先运行确定性 `verify`；只有断言无法判断时才使用模型审阅紧凑快照/截图。
- Planner 只在任务开始、验证失败、页面指纹大幅变化时运行；Navigator 只决定下一步。这比每步全量规划更省 Token。
- 失败恢复按顺序尝试：重新观察 → 同语义定位器的单次回退 → 回退到计划检查点 → 请求用户输入。禁止静默扩大权限或绕过安全策略。其中"请求用户输入"已在登录场景落地：检测到动作后新进入登录页（URL 特征或密码框）即暂停，人工登录后 `resume_task` 继续；全程不存储、不代填凭据。

验收：记录每个任务的成功率、平均步数、重试次数、停滞次数、每任务 Token；与当前“直接调用 MCP 原语”的基线比较。

## 第三阶段：工作流与适配器（后续）

**当前进度：单步操作的自动沉淀已通过选择器缓存落地——`click`/`type` 带 `intent` 时，首次成功自动派生耐久定位符并按 `(站点, intent)` 持久化，命中即零观察执行，连续失败自动禁用；`@eN/@wpN` 与输入文本永不入缓存。完整多步流程沉淀仍走 `save_task_as_workflow`。**

- 从成功任务轨迹提取可参数化工作流；每次回放先做元素/页面指纹校验。
- 高频站点提供适配器，直接产出结构化数据，减少 LLM 阅读整页 DOM。
- 适配器必须声明所需域名、只读/写入能力和验证器，继续受插件白名单与只读模式约束。

## 暂不做

- 不在插件内置模型密钥或规划器。
- 不做无上限的自主循环、多 Agent 并发写操作或 CAPTCHA 绕过。
- 不提供任意 `execute_js`。对无语义控件使用受控的 `inspect`、`probe_selector` 和基于新鲜观察结果的 `click_at`。
