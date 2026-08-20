# WebPilot 竞品对比与差距分析

> 对比对象：WebPilot（我们的产品） vs BrowserAct vs browser-automation-skill（BrowserSkill）
> 日期：2026-07-30

---

## 1. 三款产品定位

| 产品 | 定位 | 核心架构 | 接入方式 |
|------|------|----------|----------|
| **WebPilot** | AI 浏览器操作助手，复用本地 Chrome | Chrome 扩展 + WebSocket 桥接 + MCP Server | MCP stdio（Claude Code / Cursor / Codex） |
| **BrowserAct** | AI Agent 浏览器执行层，面向生产级 Web 自动化 | CLI + 云端浏览器 + Skill Forge | CLI / MCP / 云工作流 |
| **BrowserSkill** | Claude Code skill + Codex plugin + MCP server，驱动真实浏览器 | 4 种适配器路由（chrome-devtools-mcp / playwright-cli / playwright-lib / obscura）+ 5 级缓存链 | MCP + Claude Code skill + Codex plugin |

---

## 2. 完整能力对比

### 2.1 基础能力

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| MCP 工具数量 | **68 个（最全）** | ~20 个 CLI 命令 | 45 verbs + 6 MCP 工具 |
| 导航 | navigate / reload / go_back_forward | navigate | open |
| 点击 | click / click_at / hover / drag_drop | click | click / hover / drag |
| 输入 | type / press_key / select_option / upload_file | type | fill / press / select / upload |
| 截图 | screenshot / full_page_screenshot / element_screenshot | screenshot | snapshot（无障碍树）+ screenshot |
| 页面读取 | get_page_info / get_page_text / get_url | extract / stealth-extract | snapshot / extract |
| 等待 | wait_for / wait_for_dynamic | wait | wait |
| 标签页管理 | list_tabs | tab-list / tab-switch / tab-close | tab-list / tab-switch / tab-close |
| 网络捕获 | start/stop/get_network_resources | 无独立工具 | inspect（HAR + console + 截图） |
| 高级操作 | shadow_dom_action / iframe_action / save_pdf / set_viewport / set_user_agent / set_geolocation / set_network_throttle / set_timezone | 无 | route（网络 mock） |

### 2.2 页面状态表示

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 元素引用 | @eN 引用 + @wpN 引用（inspect） | 紧凑索引文本（低 token） | eN 索引无障碍树 |
| 定位策略 | CSS / @eN / text=文本 / role=button[name] | 索引 ID + 语义描述 | --ref eN / --selector CSS |
| 页面快照 | 可访问性风格快照 | 压缩索引表示 | aria_yaml + eN refs |

### 2.3 任务编排与工作流

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 任务运行时 | start_task + observe + run_task_step + verify + cancel | 无独立任务运行时 | 无独立任务运行时 |
| 任务计划 | set_task_plan + run_planned_step + advance_plan | Skill Forge 自动生成 | flow run（YAML） |
| 检查点 | create_task_checkpoint + restore_task_checkpoint | 无 | 无 |
| 工作流复用 | save_task_as_workflow + start_workflow + recommend_workflows | Skill Forge → SKILL.md + scripts | flow record（codegen 封装）+ replay + baseline |
| 参数化模板 | {{query}} 占位符 | Skill 参数化 | ${var} + ${refs.NAME} 模板化 |
| 停滞检测 | 连续 3 次相同操作自动暂停 + 5 步无变化暂停 | 无 | 无 |
| 失败截图 | 自动截图保存 | 无 | inspect 聚合截图 |

### 2.4 选择器缓存与自愈

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 选择器缓存 | **无** | Skill Forge 沉淀 | **5 级缓存链** |
| 缓存命中 | 无 | 有（Skill 调用） | 有（零 LLM token） |
| 指纹救援 | 无 | 无 | fingerprint rescue（第 2 级） |
| 本地 VLM 救援 | 无 | 无 | local-VLM rescue（第 3 级） |
| 云 LLM 回退 | 无 | 无 | cloud LLM（第 4 级） |
| 人工修复 | 无 | 无 | user fixup（第 5 级） |
| 自愈机制 | 无 | 无 | 4 次连续失败自动禁用 + 重解析 |
| 遗忘成功检测 | 无 | 无 | oblivious_success 检测 + 自动清理 |

### 2.5 反检测与封锁恢复

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 反检测体系 | **无** | **三层体系** | obscura 适配器 |
| 浏览器指纹伪装 | 无 | 有（30+ 属性随机化） | 无 |
| TLS 指纹轮换 | 无 | 有 | 无 |
| 住宅代理 | 无 | 有 | 无 |
| CAPTCHA 自动解 | 无 | reCAPTCHA / Turnstile / DataDome / HUMAN | 无 |
| 隐身抓取 | 无 | stealth-extract | obscura（单一二进制） |
| 人工接管 | 无 | Remote Assist（远程链接，任意设备） | user fixup |

### 2.6 会话与凭据管理

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 凭据存储 | **无** | 远程接管 + 会话复用 | keychain（macOS）/ libsecret（Linux）+ 明文（带确认） |
| TOTP 轮换 | 无 | 无 | 有 |
| 会话持久化 | 无 | storageState 捕获/恢复 | storageState 捕获/恢复 |
| 自动重登录 | 无 | TTL 自动重登录 | TTL 自动重登录 |
| 浏览器模式 | 仅本地 Chrome | 3 种：Chrome / 隐身隐私 / 固定身份 | 4 种适配器路由 |
| 并发会话 | **单浏览器单会话** | **无限并发 + 容器级隔离** | 多站点会话管理 |
| 会话隔离 | 无 | 每会话独立指纹/代理/cookie | 独立 storageState |

### 2.7 遥测与审计

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 操作日志 | action_log（基础） | 中等 | **OTel 级** |
| 每操作事件 | 无 | 有 | JSONL 事件（OTel 格式） |
| 成功率追踪 | 无 | 有 | 有 |
| 后置条件命中率 | 无 | 无 | 有 |
| Token 消耗追踪 | 无 | 无 | 有（input/output/cached） |
| 耗时统计 | 无 | 有 | p50 耗时 |
| 成本追踪 | 无 | 无 | 美元成本（CLAUDE_USAGE 注入） |
| Pareto 分析 | 无 | 无 | route × verb 表格 |
| 失败模式直方图 | 无 | 无 | 14 值 + unknown_failure |
| 隐形错误检测 | 无 | 无 | oblivious_success 检测 |
| 审计清理 | 无 | 无 | browser-stats prune（自动禁用坏缓存） |

### 2.8 适配器与提取

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 适配器系统 | 3 个提取适配器（通用/GitHub仓库/Issues） | 78 个预置解决方案 | 4 种执行适配器 |
| 自动选择 | extract_with_best_adapter | 无 | 适配器路由 |
| 健康监控 | get_adapter_health | 无 | 有 |
| 适配器编写 | docs/adapter-authoring.md | Skill Forge 自动生成 | 有文档 |

### 2.9 安全控制

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 域名白名单 | **有** | 无 | 无 |
| 只读模式 | **有** | 无 | 无 |
| 紧急停止 | **有** | 无 | 无 |
| 确认门控 | 无 | 有（敏感操作确认） | 无 |
| 凭据不上 argv | 无 | 无 | 有（stdin-only） |
| pre-commit 拦截 | 无 | 无 | 有（凭据泄漏阻断） |
| 密码金丝雀 | 无 | 无 | 有（PASSWORD-CANARY 哨兵） |

### 2.10 测试与工程化

| 能力 | WebPilot | BrowserAct | BrowserSkill |
|------|----------|------------|--------------|
| 测试套件 | **无** | 未公开 | **1202/1202 bats 全绿** |
| 架构文档 | docs/ + README | 有 | docs/ARCHITECTURE.md |
| 贡献指南 | 无 | 有 | CONTRIBUTING.md |
| 安装检查 | 无 | 无 | browser doctor |
| npm 发布 | 无 | 有 | 有（npx 一键安装） |

---

## 3. 六大关键不足

### 3.1 反检测与封锁恢复 — 完全缺失

BrowserAct 的三层反封锁体系是目前最成熟的方案：环境层（指纹伪装、TLS 轮换、住宅代理）吸收大部分阻断，执行层处理已触发的 CAPTCHA（支持 reCAPTCHA、Cloudflare Turnstile、DataDome、HUMAN Security），人工层通过 Remote Assist 远程接管。BrowserSkill 也有 obscura 适配器做隐身抓取。WebPilot 在这方面完全空白，遇到任何反爬机制就会卡住。

### 3.2 选择器缓存与自愈 — 完全缺失

BrowserSkill 的 5 级缓存链是最突出的技术优势：cached selector → fingerprint rescue → local-VLM rescue → cloud LLM → user fixup。命中缓存时零 LLM token 消耗，连续 4 次失败自动禁用并触发重解析。WebPilot 每次操作都需要 LLM 重新解析元素引用，token 成本高且不稳定。BrowserAct 的 Skill Forge 则从另一个角度解决同样的问题——把一次性探索自动转化为可复用的 SKILL.md。

### 3.3 并发会话隔离 — 完全缺失

BrowserAct 支持无限并发，每个会话独立容器、独立指纹、独立代理、独立 cookie。BrowserSkill 支持多站点会话管理。WebPilot 只支持单浏览器单会话，无法同时处理多账号或多任务并行。

### 3.4 凭据与会话管理 — 严重不足

BrowserSkill 把凭据存入系统 keychain（macOS）/ libsecret（Linux），支持 TOTP 共享密钥轮换和 session TTL 自动重登录。BrowserAct 通过 Remote Assist 让人远程处理 2FA 后交回控制权。WebPilot 完全依赖用户手动登录，没有凭据存储、没有 session 持久化、没有自动重登录。

### 3.5 遥测与审计 — 基础级别

BrowserSkill 每次适配器调用都发出一个 OTel 格式的 JSONL 事件，包含成功率、后置条件命中率、token 消耗、p50 耗时、美元成本，还能检测 oblivious_success（适配器说成功了但实际没成功）。WebPilot 只有简单的 action_log，无法做 Pareto 分析、成本追踪或隐形错误检测。

### 3.6 工作流自动化深度不足

BrowserSkill 的 flow record 封装了 playwright codegen，录制时自动把密码字段替换为 `{{secrets.password}}` 占位符，replay 时做逐步结构化 diff，还有 baseline 管理用于回归对比。BrowserAct 的 Skill Forge 能自动探索网站结构并生成完整的 SKILL.md + scripts 包，已积累 78 个预置方案。WebPilot 的 workflow 虽然有参数化模板和 checkpoint，但缺少录制、diff、baseline 这些生产级能力。

---

## 4. WebPilot 的优势

| 优势点 | 说明 |
|--------|------|
| **工具数量最多** | 68 个 MCP 工具，覆盖 shadow DOM、iframe、网络节流、geolocation、timezone 等冷门但实用场景 |
| **任务运行时设计成熟** | 有停滞检测（连续 3 次相同操作自动暂停）、页面指纹对比、失败自动截图、checkpoint 恢复 |
| **安全控制即时可用** | 域名白名单 + 只读模式 + 紧急停止，BrowserSkill 和 BrowserAct 都没有这么细粒度的本地安全开关 |
| **架构轻量** | 不依赖 Playwright/Puppeteer，直接复用用户 Chrome，零额外浏览器安装成本 |
| **网络捕获能力** | start/stop/get_network_resources 提供独立的网络请求捕获能力，竞品中只有 BrowserSkill 的 inspect 间接覆盖 |

---

## 5. 优先补齐建议

### P0：选择器缓存层

**投入产出比最高**，直接降低 LLM token 消耗和操作延迟。

- 参考 BrowserSkill 的 (site, archetype, intent) 三元组缓存模型
- 实现 cache_miss / cache_hit 事件
- 4 次连续失败自动禁用缓存并触发重解析
- 预计降低 40-60% 的重复操作 token 消耗

### P1：凭据与会话持久化

**解决"每次都要手动登录"的核心痛点**。

- 至少做到 storageState 捕获/恢复
- session TTL 自动重登录
- 凭据存储优先使用系统 keychain
- 支持多账号 profile 切换

### P2：OTel 级遥测

**没有可观测性就无法优化**。

- 每次操作记录 JSONL 事件：成功率、耗时、token 消耗
- 补齐 oblivious_success 检测
- Pareto 分析找出最差的 (verb, route) 组合
- 可选：美元成本追踪

### P3：反检测基础层

**视使用场景决定优先级**。如果目标用户主要操作内部系统或已授权站点，可延后。

- 第一阶段：集成 puppeteer-extra-plugin-stealth
- 第二阶段：代理支持 + TLS 指纹轮换
- 第三阶段：CAPTCHA 自动解（接入第三方服务）

### P4：并发会话隔离

**需要架构层面调整**。

- 多 Chrome profile 管理
- 独立 WebSocket 通道
- 容器化隔离（可选）

### 个人使用场景重估：P1 / P4 降级（2026-07）

以个人工作使用为前提重新评估后，P1、P4 的原始清单大部分不成立。根本原因是架构定位不同：BrowserAct / BrowserSkill 驱动的是独立/无头浏览器，每个会话"出生即未登录"，keychain 凭据、storageState、TOTP、自动重登录是它们的生存必需品；而 WebPilot 借用用户日常真实浏览器，登录态由 Chrome 本身持久化，用户每天都在维护。

| 原清单项 | 个人场景结论 |
|----------|--------------|
| 凭据存储（keychain / TOTP） | **不做**。Chrome 密码管理器/passkey 已覆盖；工具再存一份凭据是纯增攻击面，且与"凭据不落盘"安全纪律冲突 |
| storageState 捕获/恢复 | **不做**。Chrome 就是持久化层，重复造轮子 |
| TTL 自动重登录 | **不做**。前提是存凭据；个人场景 session 过期的真实成本是手动登一次 |
| 多账号 profile 切换 | **文档级**。Chrome 多 Profile + `WEBPILOT_PORT` 换端口即可，一个 Profile 一个身份，无需工具内账号管理 |
| 并发隔离（容器/独立指纹） | **不做**。那是 SaaS 批量代理场景的需求；个人并行度已由 Leader-Follower + 会话标签组覆盖 |

个人场景下该方向唯一的真实痛点是：任务跑到一半撞上登录页/session 过期后不明不白地失败。因此 P1 重新定义为**登录态检测 + 人工接管**（已实现）：动作后检测到新进入登录页（URL 特征或出现密码输入框）时任务自动 `paused` 并明确提示，人工在浏览器完成登录后调用 `resume_task` 继续。"复用真人浏览器登录态 + 出事时人接管"本身就是个人工具的最优凭据方案。

---

## 6. 总结

WebPilot 在工具覆盖面（68 个 MCP 工具）、任务编排（停滞检测 + checkpoint + workflow）和安全控制（域名白名单 + 只读模式 + 紧急停止）三个维度有明确优势。但在反检测、选择器缓存、并发隔离、凭据管理、遥测审计五个维度存在显著差距，这些差距直接影响了产品在生产环境中的可靠性、成本效率和可扩展性。

建议按 P0 → P1 → P2 的顺序逐步补齐，其中选择器缓存的投入产出比最高，应作为第一优先级。

---

## Sources

1. BrowserAct, *Best Browser Automation for AI Agents in 2026: The Practical Buyer's Guide*. https://www.browseract.com/blog/best-browser-automation-for-ai-agents
2. BrowserAct, *Browser Automation Tools Comparison*. https://www.browseract.com/blog/browser-automation-tools-comparison
3. browser-automation-skill npm package. https://www.npmjs.com/package/browser-automation-skill
4. 山行AI, *BrowserAct Skills：AI Agent 的浏览器自动化技能库*. https://developer.cloud.tencent.com/article/2707309
5. ProductCool, *BrowserAct 产品介绍*. https://www.productcool.com/product/browseract
