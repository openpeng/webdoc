# WebPilot MVP（中文文档）

WebPilot 让兼容 MCP 的 AI 客户端通过本地安装的 Chrome 扩展来控制浏览器。

## 架构

```
AI 客户端 -- stdio --> MCP Server（同时内置 WebSocket bridge） <-- ws://localhost:8765 --> Chrome 扩展
```

MCP Server 现已内置 WebSocket bridge。不要启动旧的 `daemon/` 包：一个 MCP 进程就是唯一需要的本地服务。

组件职责、数据流与设计理由详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

可同时运行多个 MCP 进程。第一个绑定 `8765` 的进程成为 **leader（主进程）**，独占扩展连接；后续进程成为 **follower（从进程）**，通过内部代理端口 `8766` 把命令转发给 leader。完整的 leader-follower 与会话模型见 `INSTALL.md`。

## 安装

1. 在 `chrome://extensions/` 开发者模式下，从 `browser-extension/` 加载扩展。
2. 安装 MCP Server。推荐方式是从 npm 安装（已内含编译后的 server、`definitions/`、`skills/` 与 `browser-extension/`）：

   ```bash
   npm install -g webpilot-mcp-server
   # 或临时使用：npx webpilot-mcp-server
   ```

   也可从源码构建：

   ```bash
   cd mcp-server
   npm install
   npm run build
   ```

3. 把 server 注册到你的 AI 客户端。若从 npm 安装，只需命令名：

   ```json
   {
     "mcpServers": {
       "webpilot": {
         "command": "webpilot-mcp"
       }
     }
   }
   ```

   若从源码构建，将 `args` 指向编译产物（替换为你的绝对路径）：

   ```json
   {
     "mcpServers": {
       "webpilot": {
         "command": "node",
         "args": ["/absolute/path/to/webdoc/mcp-server/dist/server.js"]
       }
     }
   }
   ```

4. 启动或重连 MCP 客户端。扩展会自动连接到 MCP 进程内置的 bridge（`ws://localhost:8765`）。

扩展会在安装后、Chrome 启动后、以及意外断开后尝试连接，并以 20 秒心跳维持已建立的连接。若 MCP 进程后启动，则每分钟重试一次。点击 **Disconnect（断开）** 会主动关闭自动重连；再次点击 **Connect（连接）** 即可恢复。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEBPILOT_PORT` | `8765` | MCP Server 内置 WebSocket bridge 使用的端口。 |
| `WEBPILOT_PROXY_PORT` | `WEBPILOT_PORT + 1`（`8766`） | follower 连接 leader 用的内部 `127.0.0.1` 代理端口。 |
| `WEBPILOT_GROUP_TTL_MIN` | `30` | 空闲会话标签组在被垃圾回收前的保留分钟数（leader 进程）。 |
| `WEBPILOT_MAX_GROUPS` | `5` | 会话标签组的最大数量；最旧的空闲组优先关闭。 |

## 工具列表

| 工具 | 说明 |
| --- | --- |
| `navigate` | 在浏览器标签页打开 URL。 |
| `get_page_info` | 读取页面标题、URL 与可交互元素。默认平铺列表；`structure: "tree"` 按语义容器（main/dialog/list 项）分组，便于消歧义。 |
| `inspect` | 探查页面或聚焦编辑器内的控件（含无名可点击容器）；返回可复用的 `@wpN` 引用与视口坐标。 |
| `probe_selector` | 一次性测试定位符，不等待可见性。 |
| `get_page_text` | 不执行任意 JS / `eval` 读取页面正文。**自动穿透跨域 iframe**（见下）。 |
| `click` | 点击 CSS 定位符。 |
| `click_at` | 点击 `inspect` 或最新截图返回坐标处的可见可操作元素。 |
| `type` | 向 CSS 定位符输入文本。 |
| `screenshot` | 截取浏览器可见区域。 |
| `execute_js` | 已废弃并禁用；请使用受限的观察类工具。 |
| `list_tabs` | 列出浏览器标签页。 |
| `wait_for` | 等待定位符可见 / 已挂载 / 已隐藏。 |
| `get_action_log` | 读取近期操作的耗时与错误（不含输入文本与脚本）。 |
| `cleanup_sessions` | 关闭 WebPilot 会话标签组；默认仅关闭空闲组（`onlyIdle`），或指定 `sessionId`。 |
| `list_adapters` / `extract_with_adapter` | 发现并使用某个只读站点适配器。 |
| `extract_with_best_adapter` | 选择最具体的适配器，失败时降级为通用摘要并附带证据。 |
| `get_adapter_health` | 查看适配器成功率、耗时与近期 DOM 提取错误。 |
| `start_task` | 启动确定性任务会话并记录初始页面状态。 |
| `observe_task` | 刷新任务的页面观察与指纹。 |
| `run_task_step` | 执行一个动作，随后重新观察并运行循环检测。 |
| `verify_task_step` | 评估确定性的完成断言。 |
| `get_task` / `get_task_log` / `cancel_task` | 查看证据或停止任务会话。 |
| `resume_task` | 人工接管（如手动登录）后恢复已暂停的任务。 |
| `create_task_checkpoint` / `restore_task_checkpoint` | 保存或恢复软性 URL/页面指纹检查点。 |
| `set_task_plan` / `run_planned_step` | 存储 Agent 计划并执行一个已验证的计划步骤。 |
| `save_task_as_workflow` / `start_workflow` | 将完成的计划沉淀为参数化、可复用的工作流。 |
| `recommend_workflows` | 推荐匹配当前页面域名的已完成工作流；它从不自动执行。 |
| `get_webmcp_health` | 检测当前页面是否支持 WebMCP（`document.modelContext`），返回 `available` 与在用 API 变体。 |
| `list_webmcp_tools` | 列出页面通过 WebMCP 注册的全部工具（含 `name`、`description`、`inputSchema`、`annotations`）。 |
| `execute_webmcp_tool` | 按名称执行某个 WebMCP 注册工具并传入结构化输入。这是原生通道——比 DOM 自动化更快更稳。 |
| `probe_page_capabilities` | 多维度页面能力扫描：WebMCP 工具、声明式表单、JSON-LD 动作、DOM 语义模式、网络 API 端点。用于决定最优执行策略。 |
| `extract_iframe_text` | 提取页面中 iframe 的正文文本；同源走 DOM，跨域自动降级到网络层（见下）。 |

## WebMCP 双通道

WebPilot 支持 WebMCP 标准协议（`document.modelContext`），构成双通道架构：

1. **原生通道（优先）：** 当页面通过 WebMCP 注册了工具，直接通过 `execute_webmcp_tool` 调用。它执行页面自身的 JavaScript——无需 DOM 解析、截图或点击坐标。
2. **浏览器自动化（降级）：** 无 WebMCP 工具时，使用传统的 `get_page_info` → `click`/`type` 工作流。

在陌生页面用 `probe_page_capabilities` 获取覆盖 5 个维度的结构化能力报告：WebMCP 工具、带 `toolname` 属性的声明式 `<form>`、Schema.org/JSON-LD 结构化数据、DOM 语义模式（搜索、鉴权、表格、筛选、弹窗、上传、编辑器、地图）、以及 API 端点嗅探。

原生通道比基于像素的自动化更快、更准、更稳。带 `readOnlyHint: true` 注解的工具可安全用于只读探索；写类工具执行前应取得用户确认。

## 跨域 iframe 页面

部分站点把真实内容渲染在**与主页面不同源的 iframe** 中。例如 WorkBuddy 文档页（`workbuddy.cn`）把文档嵌在来自 `workbuddy-space-static.codebuddy.work` 的 iframe 里。此时：

- 主页面调用 `get_page_text` 只返回外壳（几十个字符），因为正文在跨域 iframe 内；
- `iframe_action` 报 `No same-origin iframe found`——浏览器禁止跨域 DOM 访问；
- `evaluate` / `execute_js` 被页面 CSP 拦截（不允许 `unsafe-eval`）。

这些已**自动处理，无需手动绕过**：

- **`get_page_text` 自动穿透 iframe。** 当页面含 `<iframe>` 且主页面正文看起来为空时，它会透明地提取 iframe 正文并追加到 `--- iframe 正文 ---` 分隔符之后。同源 iframe 走 DOM 读取；跨域 iframe 降级到下面的网络层。可传入 `iframeUrlContains`（如 `workbuddy-space-static`）来收窄跨域匹配。
- **`extract_iframe_text`** 是只取 iframe 内容的显式工具。同样走降级逻辑：同源 → DOM `getText`；跨域 → `start_network_capture` → `reload`（触发 iframe 的 `Document` 请求）→ `get_network_resources(type:"Document")` → `replay_api_request`（携带原会话 cookie 并绕过 CSP）→ `htmlToText`。

跨域为何走网络层：iframe 文档本身就是一次已由用户登录 cookie 授权的普通 HTTP `GET`。重放这条被捕获的请求即可拿回完整 HTML，而无需触碰（被禁的）iframe DOM。捕获必须在 reload **之前**启动，才能记录到 `Document` 请求；重放完成后停止捕获。

```text
读跨域文档： get_page_text（自动穿透 iframe） 或 extract_iframe_text（iframeUrlContains:"workbuddy-space-static"）
手动降级：   start_network_capture -> reload -> get_network_resources(type:"Document") -> replay_api_request -> htmlToText
```

## 可靠交互

`click` 与 `type` 在动作前会等待一个可见且稳定的目标（默认 10 秒）。除 CSS 选择器外，还支持以下定位格式：

- `@e0`：`get_page_info` 返回的引用；在页面变化前使用。
- `@wp1`：`inspect` 返回的稳定引用；在导航或目标节点被移除前有效。
- `text=Continue`：精确的可视交互元素名称。
- `role=button[name="Continue"]`：可访问的角色与名称。

当下一步 UI 状态很关键时，动作之间用 `wait_for`。超时时会返回最新页面元数据与一小段可交互元素快照以辅助诊断。`get_action_log` 提供有边界、已脱敏的操作时间线。

对于未被可访问性元信息暴露的控件，在猜测 CSS 前先用 `inspect` 并指定 `scope: "focused"` 或 `scope: "composer"`。它会包含因原生语义、指针光标或常见测试/动作属性而看似可操作的可见无名控件。用 `probe_selector` 做即时定位符检查，它从不进行常规的 10 秒可见性重试。最后手段是用 `click_at`，且仅可配合最新 `inspect` 结果或截图返回的边界。

## Agent 任务循环

多步任务请用任务工具，而非发出一长串原始动作。任务以 `start_task` 开始，随后循环 `observe_task` → 一次 `run_task_step` → `verify_task_step`。服务端记录 URL/DOM 指纹，在连续三次相同动作/页面对或五步无变化时自动暂停，并把脱敏的 JSONL 证据写入 `.webpilot-task-logs/`（可用 `WEBPILOT_TASK_LOG_DIR` 覆盖）。任务响应返回紧凑页面视图（url/title/指纹 + 索引化元素行，格式同 `get_page_info`）；富元素字段保留在服务端用于指纹与选择器缓存。

当动作落到登录页（登录型 URL 或出现密码框）时，任务会暂停而非盲目重试：在浏览器手动登录后调用 `resume_task` 继续。凭据从不存储——设计依赖真实浏览器自身会话加人工接管。

动作报错或确定性验证失败时，任务运行时会（在支持浏览器截图时）把失败截图存入同一证据目录。检查点刻意是**软性的**：它们恢复 URL 并比对页面指纹，但绝不声称能恢复表单输入、服务端状态或先前的副作用。

`verify_task_step` 支持 `url_includes`、`url_equals`、`title_includes`、`text_present`、`text_absent`、`locator_visible`、`locator_hidden`、`interactive_count_at_least` 断言。仅在最后一步完成检查时设 `completeOnPass: true`。

## 可复用计划

Agent 可调用 `set_task_plan`，步骤形如：

```json
{
  "objective": "Search for the requested term",
  "action": { "action": "type", "selector": "role=textbox[name=\"Search\"]", "text": "{{query}}" },
  "verification": { "kind": "locator_visible", "selector": "role=button[name=\"Search\"]" }
}
```

`run_planned_step` 执行动作、重新观察并验证；仅当验证通过才推进计划。所有计划步骤通过后调用 `save_task_as_workflow`。工作流存储拒绝字面 `type` 文本：请用 `{{parameter}}` 占位符，并通过 `start_workflow` 提供其值。这样可把可复用经验与任务特定或敏感输入分离。保存的工作流也会保留其完成运行期间观察到的域名。在页面上用 `recommend_workflows` 仅取回匹配的经验，再决定是否实例化工作流。

服务端还内置了 **预设工作流**（id 以 `preset-` 为前缀，定义为 `mcp-server/definitions/workflows/` 下的 JSON 数据文件），覆盖常用站点的常见操作：百度/Google/GitHub/知乎/掘金/小红书/闲鱼的直搜（`{{query}}`，由调用方 URL 编码）、打开公众号文章（`{{articleUrl}}`）、向 ChatGLM/豆包/Gemini 提问（`{{prompt}}`）。预设在 `list_workflows` / `recommend_workflows` 中以 `preset: true` 出现，从不写入 `workflows.json`，且以与保存工作流相同的观察/验证纪律重放。

适配器与预设工作流都在运行时从 JSON 定义文件（`mcp-server/definitions/adapters/` 与 `.../workflows/`）加载，因此新增、编辑或分享定义无需改代码或重新构建——只改 JSON。设置 `WEBPILOT_ADAPTER_DIR` / `WEBPILOT_WORKFLOW_DEF_DIR` 指向外部目录即可按用户/团队增改或覆盖定义（相同 `id` 覆盖内置）。每个定义在加载时都按严格白名单重新校验，所以外部 JSON 永远无法注入可执行 JavaScript 或字面输入文本。

## 选择器缓存

`click` 与 `type` 接受可选的 `intent`——一个稳定的小写操作标签，如 `search-input`。首次成功动作后，服务端推导出一个耐久定位符（`#id`、`[data-testid=…]`、`role=…[name="…"]`、`text=…` 或唯一 CSS 路径）并存入 `(hostname, intent)`。同一站点后续使用相同 intent 的调用命中缓存、无需重新观察页面，因此重复操作不额外消耗快照 token。当缓存定位符失败时，调用回退到显式 `selector`（若提供）并刷新缓存；连续四次失败后该条目被禁用，直到一次成功的显式运行将其复活。临时 `@eN` / `@wpN` 引用永不被缓存，且输入文本永不进入缓存——只缓存定位符。条目持久化在 `WEBPILOT_SELECTOR_CACHE_DIR` 下的 `selector-cache.json`（回退到任务日志目录），加载时按定位符白名单重新校验。用 `get_selector_cache` 查看命中率、失败与禁用条目。

缓存条目仅按 `(hostname, intent)` 键入——在站点所有页面间共享。请选择全站无歧义的 intent（全局搜索框、常驻导航按钮）；页面专属控件请把页面编入名称（如 `settings.save-button`、`profile.nickname-input`）。`text=` / `role=` 定位符在匹配到多个元素时拒绝动作，因此页面不匹配会安全失败而非点错目标。

## 站点适配器

适配器为常访问页面返回紧凑、结构化的只读数据；不暴露任意 JavaScript。当前覆盖 GitHub、百度与 Google 搜索结果、知乎、小红书、掘金、公众号文章、闲鱼，以及 ChatGLM/豆包/Gemini 对话视图，外加任意 HTTPS 页面的通用摘要。先用 `list_adapters`，或用 `extract_with_best_adapter` 优先选用最具体的匹配适配器。若某站点专用提取器在 DOM 变更后失效，工具会降级为通用摘要并返回失败的适配器列表。`get_adapter_health` 让这些失败与耗时可见，便于从容修复适配器。适配器编写的受限声明式契约见 `docs/adapter-authoring.md`；在沉淀页面特定任务时如何选择适配器、工作流与 skill 指引见 `docs/task-sedimentation-guide.md`。

## 安全边界

扩展弹窗在本地强制执行以下控制，因此 MCP 客户端无法绕过：

- **域名白名单：** 每行一个域名（或用逗号分隔）。它作用于 Agent 控制的标签页，并通过把标签带向空白页来阻止跨域重定向。空列表表示不限制域名。
- **只读模式：** 允许观察、截图、等待与导航；阻止点击与输入，包括坐标点击。
- **紧急停止：** 断开 bridge、关闭自动重连并拒绝新的远程命令。点击 **Connect** 可主动恢复。

## 会话标签组

每个 MCP 进程从其 MCP 客户端名加工作目录派生出稳定会话 id，扩展把该会话隔离进自己的 Chrome 标签组 `WebPilot·{short-id}`：

- 不带显式 `tabId` 的命令作用于自己会话组内最近使用的标签页，组为空时新建一个。
- `tabId` 属于其他会话组的命令会被拒绝，因此并行 Agent 互不干扰。
- 会话的 MCP 进程断开时，其组被标记为 `·idle`、变灰并折叠；相同 id 的会话回归时重新认领。
- 空闲组在 `WEBPILOT_GROUP_TTL_MIN`（默认 30 分钟）后被垃圾回收，总数受 `WEBPILOT_MAX_GROUPS`（默认 5，最旧空闲组先关）限制。
- 用扩展弹窗的 **清理闲置组** 按钮或 `cleanup_sessions` 工具手动清理（`onlyIdle` 默认 `true`；传 `sessionId` 可关特定组）。

## 开发

- `npm test`（在 `mcp-server/` 下）构建并运行 `test/` 中的 node:test 套件。测试覆盖编译后的 `dist/` 产物：选择器缓存、定义加载、适配器白名单校验、预设工作流安全闸门。
- `npm run doctor` 检查安装状态：Node 版本、构建产物、定义加载（列出被跳过的条目）、bridge 端口状态与 `WEBPILOT_*` 环境变量。失败时非零退出，可用于 CI 或安装脚本的关卡。
- 包已具备发布条件（`bin`、`files`、`engines`、`prepublishOnly`）；`npm pack --dry-run` 显示精确打包内容。实际发布为人工决策。
- 贡献路径、定义文件的安全约束与提交信息格式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 备注

- 扩展源码已改为在每个响应中附带请求 ID。若它已在 Chrome 中加载，连接前先在 `chrome://extensions/` 中点击其卡片上的 Reload。
- 更新 `page-tools.js` 后请重新加载扩展；它提供页面侧的定位符、等待与诊断辅助。
- `execute_js` 被刻意禁用。扩展使用固定的一组隔离世界页面工具，因此页面 CSP 与任意代码执行不影响控制探索。
- `daemon/` 目录仅作为旧源码保留，本版本不应启动它。
