# 页面特定任务的沉淀分层与发展规划

当 Agent 针对特定页面反复执行某类任务时，一次性的对话指令无法复用，需要把任务经验沉淀为项目资产。本文定义 WebPilot 的三层沉淀模型、选择标准，以及按产品阶段划分的后续发展方向。

## 三层沉淀模型

| 层 | 沉淀什么 | 载体 | 消费方式 |
| --- | --- | --- | --- |
| 站点适配器 | 只读结构化提取：从特定页面拿列表、字段、元信息 | `mcp-server/definitions/adapters/` 下的声明式 JSON 定义 | `extract_with_best_adapter` / `extract_with_adapter` |
| Workflow | 操作型流程：在特定页面上的多步交互（搜索、填表、跳转、核对） | 预置工作流为 `mcp-server/definitions/workflows/` 下的 JSON；临时录制的用 `save_task_as_workflow` 持久化到 `workflows.json` | `recommend_workflows` 发现 → `start_workflow` 带参重放 |
| Skill 指引 | 站点经验与策略：登录态检查方式、不稳定控件的处理、风险动作约定 | `skills/webpilot-browser/SKILL.md` 及站点专项指引 | Agent 处理相关站点前读取 |

三层的职责一句话概括：**适配器负责"读得准"，Workflow 负责"做得对"，Skill 负责"知道怎么办"**。针对同一个目标站点，三层通常配合使用。

三层之下还有一层自动沉淀：**选择器缓存**。`click` / `type` 带上可选的 `intent` 后，首次成功操作会自动派生耐久定位符并按 `(站点, intent)` 存入 `selector-cache.json`，后续同意图操作命中缓存时无需重新观察页面。它与 Workflow 的关系是互补而非替代：Workflow 是手动沉淀的完整多步流程，选择器缓存是单步操作的自动沉淀，连续 4 次失败自动禁用，用 `get_selector_cache` 可查看命中率与失效条目。

再往下还有一层**本地运行时资产**：按精确 hostname 隔离的 API 命令集（`api-commands.json`）。它与上面三层「可随包分发、可人工审查」的资产性质不同——它是分析时自动生成的本地缓存，**不随 npm 包分发、不做导出导入与团队同步**（Q9 已否决）。消费方式是「先 `list_api_commands` 免开网页取回能力，未命中再 `analyze_page_apis`」，详见下节。

**不是所有能力都该走沉淀。** 当某个接口本身就是稳定的、无鉴权的、任意参数都能直接调时，把它做成**固定 API**（如 [`ai_search`](ai-search-design.md)）比沉淀成命令更划算：后者要求「先抓一次包」，前者零准备，且返回的是解析后的结构化结果而不是原始 body。判断标准是「**这条接口能不能在完全没有会话、没有页面、没有签名的情况下，用固定模板复现**」——能，就写死成工具；不能（依赖会话 Cookie、依赖页面分配的 token），才沉淀成命令。

### 第一层：站点适配器（只读提取优先考虑）

适配器是最稳、最安全的沉淀层：声明式、只读、不含任意 JavaScript，由服务器选择受信任的定义，扩展仅执行 CSS 选择器和字段读取。它自带两重保障：

- 健康度监控：`get_adapter_health` 聚合调用次数、成功/失败、平均耗时和最近错误，DOM 变化导致的失效可以被主动发现和修复。
- 降级机制：`extract_with_best_adapter` 提取失败时只读回退到 `generic-page-summary`，并返回 `fallbackUsed` 与 `failedCandidates` 证据。

适用判断：任务本质是"从某类页面提取数据"，不需要点击或输入。编写规范见 [adapter-authoring.md](./adapter-authoring.md)。

### 第二层：Workflow（操作型流程）

任务需要在页面上执行一套固定操作时，先用任务闭环（`start_task` → `set_task_plan` → `run_planned_step`）跑通一次，完成后用 `save_task_as_workflow` 保存。该机制内置以下约束：

- 绑定 `domains`：workflow 天然与完成运行时观察到的域名关联，天然就是"针对特定页面"的。
- 强制参数化：`type` 动作必须使用 `{{parameter}}` 占位符，字面文本（尤其是敏感文本）会被存储层拒绝，可复用经验与任务专属输入严格分离。
- 安全检查：保存前经过 `assertWorkflowSafe` 校验；只有已完成（`completed`）且带计划的任务才允许保存。
- 回放纪律：`start_workflow` 提供参数值后，仍需按"观察 → 单步执行 → 验证"的纪律推进，不做无校验的盲放。

适用判断：任务包含交互动作、有明确的步骤与验证条件，且预期会重复执行。

### 第三层：Skill 指引（经验与策略）

要沉淀的不是可执行步骤，而是"针对某站点该怎么办"的经验时，写入 Skill 文档。例如：某站点的登录态检查方式、哪些控件无语义需要用 `inspect` 探查、哪些动作属于高风险需要先确认。这类内容让模型每次处理该站点时先具备背景知识，再选择合适的工具路径。

### 选择流程

```
任务是否需要点击/输入？
├── 否（只读提取）──→ 站点适配器
└── 是
    ├── 步骤固定、可参数化、会重复执行 ──→ Workflow
    └── 只是站点经验/策略，无固定步骤 ──→ Skill 指引
```

一个复杂任务可以拆分沉淀：提取部分做成适配器，操作部分做成 workflow，注意事项写进 Skill。

### 实战案例：后台分页列表批量导出（已脱敏）

目标：从某内部后台的课程管理列表页，导出某项目筛选下的 100 条课程数据（该筛选下共约 500 条，页面默认每页 10 条）。完整过程体现了三层模型的分工：

> **已产品化**：下面第 2–3 步的「手工拼 replay」流程现已由 `analyze_page_apis` → `list_api_commands` → `call_api_command` 取代。保留原文说明演进来源，实操请优先用新工具。

原手工流程（历史做法）：

1. **能力探测定通道**（Skill 层决策）：`probe_page_capabilities` 确认页面无 WebMCP 工具，走浏览器自动化 + API 嗅探通道。
2. **抓包获取列表 API**：`start_network_capture` 后在 UI 上选中目标项目筛选项并点击查询，抓包记录到列表接口（POST，请求体含 `project_id` 枚举值与 `page`/`size` 分页字段）。这一步同时破解了"筛选名称 → 枚举值"的映射。
3. **重放拉全量**：`replay_api_request` 以捕获的请求为模板覆写 `size: 100`，一次拿到结构化 JSON——自动携带登录 Cookie、绕过页面 CSP，替代逐页翻 DOM 提取。
4. **本地后处理**：小脚本转 CSV/JSON 并补齐字段枚举映射（如课程类型编码 → 名称）。

新工具流程（推荐）：

1. `analyze_page_apis({action:"start", captureResponseBody:true})` → UI 上选中筛选项并查询 → `analyze_page_apis({action:"stop_and_analyze", mode:"merge"})`。解析器自动识别真实 HTTP method、把路径归一为 `{id}`、区分 query/path/body 参数、推导响应字段与类型，产出具名命令（如 `list.courses`）并写入按精确 hostname 隔离的本地缓存。报告给出 `needsReview[]`（POST 列表查询在人工确认前一律 `write`）、`diff` 与 `preservedManualEdits[]`。
2. 之后再到同域名：`navigate` / `probe_page_capabilities` 自动附带 `apiCommands` 摘要（**只推荐不执行**），或 `list_api_commands(domain)` 取回完整清单（≤1 次工具调用）。用 `get_api_command` 看完整定义、`update_api_command` 改名/改参数（后续 `merge` / `full` 都保留人工修正）。
3. `call_api_command({name:"list.courses", params:{page:1, size:100}})` 直接取回结构化数据——无需打开页面、无需抓包缓冲区、无需现场定位 `captureRequestId`；写命令需 `confirm:true`。响应经 `responseFields` 白名单裁剪、敏感字段 `[REDACTED]`、数组 ≤5、超长截断。

**零 UI 整站复刻（补充）**：若目标是「把整站功能抽象成命令集」而非解析某一次操作，优先用 `analyze_page_apis({action:"scan_site", domain, sources})` 静态推导——直接读 JS bundle / HAR / OpenAPI / 声明式命令包，不经浏览器、不 attach debugger、不依赖标签页与登录会话，一次拿到整站接口骨架；产物强制 `needsReview`、空 `responseSchema`、默认全部按 `write` 保守处理，再用上面的抓包流程 `mode:"merge"` 补齐真实参数与响应结构。两条通道互补：**静态推导给覆盖率，真实抓包给可信度**。放开分级、黄区开关与 SSRF 边界见 [api-command-site-scan-design.md](./api-command-site-scan-design.md)。

**bundle 需要登录态时（Node 直读 401）**：在同一调用上加 `collectViaExtension:true`，URL 类数据源改由扩展侧取文本——页面上下文 fetch → Service Worker fetch → 浏览器缓存（CDP）三层 fallback，借用页面自身的会话；连 URL 都不想找就加 `discoverBundles:true`，从当前标签页自动发现已加载的 JS。取到的文本仍交给同一个 `scanSources()` 解析（扫描逻辑只有一份），原文只在内存流转、不落盘、不进日志。配额 10 源 / 单源 2MB / 总计 8MB，`useBrowserCache:false` 可完全关掉 debugger 那一层。详见 [api-command-bundle-collect-design.md](./api-command-bundle-collect-design.md)。

关键经验（不变）：

- 自定义 `Select` 组件常无搜索框，重新展开下拉后用选项的 `title`/文本属性定位点击，不要浪费时间尝试输入。
- 下拉面板会在命令间隙关闭，展开与选点要连续执行。
- **沉淀边界**：内部域名、接口路径、枚举值、业务数据本身一律不写入 workflow/适配器/Skill，只沉淀通用策略（本例的通用策略已收录进 `SKILL.md` 的 Bulk data export 一节）。
- **本地运行时资产 vs 可分发资产**：`api-commands.json` 虽含接口路径与参数结构，但它是**本地运行时缓存**——按精确 hostname 隔离、只存 header 字段名不存值、不记真实枚举值（只记 `enumCount`）、不存凭据与业务样本值、不随包分发、不做导出导入与团队同步（Q9 否决）。它不属于可审查、可分发的三层资产；任何要写进 workflow / 适配器 / Skill 的内容仍必须遵守上面的边界。需要跨机器复用时，重新在目标机器 `analyze_page_apis` 一次即可。

三层落点：本任务的**通用策略**沉淀为 Skill 指引（可迁移到任何后台列表页）；若该导出是高频需求，可将筛选+查询步骤沉淀为参数化 Workflow；列表页的只读字段提取则可做成适配器；具名 API 命令只作为本机运行时加速，不进入上述任何一层。

## 后续发展方向

以下规划与 [agent-task-loop-plan.md](./agent-task-loop-plan.md) 第三阶段（工作流与适配器）衔接，按近、中、远期展开。

### 近期：把三层沉淀用起来（当前阶段的延续）

- **高频站点适配器覆盖**：为团队高频访问的站点补充适配器，减少 LLM 阅读整页 DOM 的 Token 消耗；以 `get_adapter_health` 数据驱动适配器的修复优先级。
- **Workflow 库的自然积累**：完成的任务计划及时保存为 workflow，形成按域名组织的经验库；`recommend_workflows` 保证经验只在匹配页面出现，不污染无关上下文。
- **回放前置校验加强**：workflow 回放前做元素/页面指纹校验，DOM 已漂移时提前失败并给出证据，而不是执行到一半出错。

### 中期：从"手动沉淀"走向"辅助沉淀"

- **任务轨迹自动提炼**：从成功任务的 JSONL 证据日志中自动提取 workflow 候选（步骤、验证条件、可参数化的输入位），由人确认后入库，降低沉淀成本。
- **Workflow 版本化与失效管理**：为 workflow 增加版本、最近成功回放时间和连续失败计数；连续失败的 workflow 自动降级为"需修复"，与适配器健康度机制对齐。
- **站点专项 Skill 目录**：在 `skills/webpilot-browser/` 下按站点组织专项指引，与 workflow 的 `domains`、适配器的域名匹配规则共享同一套站点标识。
- **多 Agent 共享经验**：结合 Leader-Follower 架构，让同一台机器上的多个 MCP 会话共享 workflow 库与适配器健康度数据（读共享、写经 leader 序列化），避免每个会话各自积累孤立经验。

### 远期：统一经验中心

- **三层资产统一目录**：把适配器、workflow、Skill 指引纳入统一的"站点经验"索引，Agent 到达一个页面时一次查询即可获知：可用的提取器、可复用的流程、需要注意的策略。
- **推荐引擎扩展**：`recommend_workflows` 从"仅按域名推荐 workflow"扩展为按域名 + 路径 + 页面指纹推荐全部三层资产，并附带健康度/最近成功信息辅助 Agent 决策。
- **效果度量**：延续第二阶段的验收指标（成功率、平均步数、重试次数、每任务 Token），对比"有沉淀资产"与"裸调用 MCP 原语"两种路径，用数据验证沉淀的价值。
- **跨机器分发（可选）**：workflow 与适配器定义作为可审查的 JSON/TS 资产随仓库分发；不同步任何包含页面数据或用户输入的运行时记录。

### 边界（继续不做）

沿用任务闭环规划中的约束：不在插件内置模型密钥或规划器；不做无上限自主循环、多 Agent 并发写操作或 CAPTCHA 绕过；不提供任意 `execute_js`；workflow 与适配器沉淀的是"结构与流程"，绝不沉淀凭据、敏感输入或页面数据本身。
