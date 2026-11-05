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

1. 在 `chrome://extensions/` 开发者模式下，从 `browser-extension/` 加载扩展。该目录随 npm 包一起分发：执行 `npm install -g webpilot-mcp-server` 后，位于 `$(npm root -g)/webpilot-mcp-server/browser-extension/`（Windows：`%APPDATA%\npm\node_modules\webpilot-mcp-server\browser-extension\`）；若从源码构建，则使用本仓库根目录下的 `browser-extension/` 文件夹。
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

4. 启动或重连 MCP 客户端。扩展默认连接本机 `ws://localhost:8765`；若 MCP 服务在别处，可在扩展弹窗的“MCP 服务地址”里改成 `ws://<主机>:<端口>`（会持久化，重启后继续使用）。

扩展会在安装后、Chrome 启动后、以及意外断开后尝试连接，并以 20 秒心跳维持已建立的连接。若 MCP 进程后启动，则每分钟重试一次。点击 **Disconnect（断开）** 会主动关闭自动重连；再次点击 **Connect（连接）** 即可恢复。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEBPILOT_PORT` | `8765` | MCP Server 内置 WebSocket bridge 使用的端口。 |
| `WEBPILOT_HOST` | `127.0.0.1` | bridge 监听的网卡。保持默认仅本机可连；设为 `0.0.0.0`（或具体网卡 IP）可让远程扩展连入，此时扩展端填 `ws://<本机IP>:8765`。 |
| `WEBPILOT_PROXY_PORT` | `WEBPILOT_PORT + 1`（`8766`） | follower 连接 leader 用的内部代理端口。 |
| `WEBPILOT_PROXY_HOST` | `127.0.0.1` | 内部转发代理监听的网卡；仅跨机共享同一个 leader 时才需放开。 |
| `WEBPILOT_LEADER_HOST` | `127.0.0.1` | follower 拨号 leader 的主机；跨机共享 leader 时指向 leader 所在主机。 |
| `WEBPILOT_GROUP_TTL_MIN` | `30` | 空闲会话标签组在被垃圾回收前的保留分钟数（leader 进程）。 |
| `WEBPILOT_MAX_GROUPS` | `5` | 会话标签组的最大数量；最旧的空闲组优先关闭。 |
| `WEBPILOT_API_COMMAND_DIR` | 回退到 `WEBPILOT_TASK_LOG_DIR`，再回退 `.webpilot-task-logs/` | 按精确 hostname 分组的本地 `api-commands.json` 缓存目录（API 命令集专用）。 |

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
| `claim_session` | 把某个闲置标签组明确交给当前会话（传 `groupId` 或 `agentKey`），用于自动认领有歧义的情况。 |
| `browser_status` | 报告 bridge 角色、两个会话身份键、当前活跃实例与全部会话标签组。 |
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
| `analyze_page_apis` | 沉淀为具名、可复用的 API 命令。两种入口：抓包（`start` → 操作 UI → `stop_and_analyze`，`analyze_current` 为兼容入口）；**静态推导 `scan_site`**（直读 JS bundle / HAR / OpenAPI / 声明式命令包，无需打开页面、无需抓包、无需登录会话）。 |
| `export_api_commands` | 把某 hostname 的命令集导出为可审查的 JSON 命令包——这是把命令集分享给他人的交付单元。 |
| `import_api_commands` | 导入 `export_api_commands` 产出的命令包。每条命令都过白名单重建，`urlTemplate` 的主机改写为目标域名，复合命令随包一起导入。 |
| `list_api_commands` | 列出某精确 hostname 的本地 API 命令集（自动加载入口，纯本地缓存读取，从不执行）。 |
| `get_api_command` | 查看单条命令完整定义：`params[]` / `responseFields[]` / `responseSchema` / 健康度 / 来源。 |
| `call_api_command` | 按持久化模板执行命令，无需打开页面、无需抓包缓冲区，复用浏览器当前会话 Cookie。写命令必须 `confirm: true`。 |
| `update_api_command` | 人工改名 / 改参数模板 / 改响应裁剪 / 加备注 / 标记弃用，置 `manuallyEdited: true`，后续分析均保留。 |
| `invalidate_api_commands` | 禁用、删除或清空单条命令 / 整个域名的缓存。 |
| `get_api_command_cache` | 健康度报告：hits / misses / 连续失败 / disabled / 平均耗时，以及被跳过的不良条目。 |
| `ai_search` | AI 搜索摘要：一次调用拿到百度「AI 智能回答」全文 + 引用来源，免开网页、免抓包。走 `chat-ws.baidu.com/baikan/conversation` 的 SSE 生成流（无需签名/token），移动站 SSR 作为兜底。 |

## API 命令集（分析 → 沉淀 → 免开网页调用）
九个工具把「一次性抓包」变成**按精确 hostname 隔离的本地**命令集。发现接口有两条入口，可叠加使用：
1. **抓包分析（真实流量，参数与响应最准）**：`analyze_page_apis({action:"start", captureResponseBody:true})` → 在页面上操作目标功能 → `analyze_page_apis({action:"stop_and_analyze", mode:"merge"})`。报告含 `commandCount`、`needsReview[]`、`diff`、`preservedManualEdits[]`、`warnings[]`。`analyze_current` 一次性解析已有的 `start_network_capture` 缓冲区，不采样响应体，产物一律标为需人工复核。
2. **静态推导（零 UI，整站骨架）**：`analyze_page_apis({action:"scan_site", domain:"example.com", sources:[{kind:"js", url:"https://example.com/static/app.js"}, {kind:"openapi", text:"{...}"}]})`。MCP Server 直接读取前端产物 / 规格 / 归档流量，**不经过浏览器、不 attach debugger、不依赖标签页与登录会话**，一次拿到整站接口骨架；再用 `mode:"merge"` 与真实抓包结果互补。`kind` 支持 `js` / `har` / `openapi` / `commands`，`text` 内联优先于 `url`。详见 [SiteScan 设计](docs/api-command-site-scan-design.md)。
2.1 **登录态补采（bundle 需要会话才能取时）**：加 `collectViaExtension:true`，URL 类数据源改由扩展侧取文本——页面上下文 fetch → Service Worker fetch → 浏览器缓存（CDP `Page.getResourceContent`）三层 fallback，借用页面自身的会话，Node 直读 401 的 bundle 也能拿到；`discoverBundles:true` 还会从当前标签页自动发现已加载的 JS 并补采。取到的文本仍交给**同一个 `scanSources()`** 解析，扫描逻辑只有一份；原文只在内存流转、不落盘、不进日志。详见 [BundleCollect 设计](docs/api-command-bundle-collect-design.md)。
3. **沉淀 / 发现**：命令存于 `WEBPILOT_API_COMMAND_DIR` 下的 `api-commands.json`，按精确 hostname 分组。再次访问同域名时，`navigate` 与 `probe_page_capabilities` 会自动追加 `apiCommands` 摘要（**只推荐、不执行，零网络请求**）。`list_api_commands(domain)` 取回精简卡片，`get_api_command` 查看完整定义，`update_api_command` 用 `manuallyEdited: true` 保护人工修正。
4. **调用**：`call_api_command({name:"list.courses", params:{...}})` 渲染持久化模板，在扩展 service worker 中以 `credentials:'include'` 执行——Cookie 由 Chrome 自身按最终 URL 匹配，无需打开页面、无需标签页、无需抓包缓冲区。写命令（`risk:"write"`）未带 `confirm: true` 时返回脱敏 `preview` 与 `confirmationRequired: true`，**一个网络请求都不发**。
5. **交付 / 接手**：`export_api_commands({domain, path})` 导出可审查的命令集文件；`import_api_commands({domain, path, overwrite})` 把它读回来。**命令包格式本身就是交付单元**——命令集可以被分享、进版本库、在不重新分析站点的前提下直接调用。导入同样走白名单重建，`urlTemplate` 的主机改写为目标域名。复合命令（多步编排，见下）随包一起交付。
**静态推导默认放开，且每项放开都对应一个开关。** 想收紧某一项，改一个入参即可：私网 / 回环地址（`allowPrivateHosts`）、跨 hostname 脚本源（`allowCrossHost` + `extraHosts`）、严格路径判定（`loosePaths: false`）、保守风险判定（`trustSpec: false`）、严格响应脱敏（`strictRedaction: true`）。放开后的默认行为：
- `risk` 按**真实 HTTP method** 判定——GET / HEAD / OPTIONS → `read`，其余 → `write`。静态来源没有响应证据，但已知的 method 足以区分读与写；扩展侧还会按 method 独立重新派生只读属性。
- `needsReview` 只保留**一条**来源标注，不再叠加三条理由。
- 命中敏感字段名黑名单的响应字段**原样返回**；传 `strictRedaction: true` 即回到 `[REDACTED]`。
- 请求头放开为**全部非凭据头**：`Cookie` / `Authorization` / `Proxy-Authorization` / `Set-Cookie` 一律剔除，其余照传。原来的两-header 下限（`accept`、`content-type`）从「上限」变成「保底」。
**静态推导的 host 归属。** 前端 bundle 里的接口路径大多是**裸相对路径**（`/x/kv-frontend/namespace/data`），真正的主机藏在别处——协议相对 URL（`//api.bilibili.com/x/...`）或 HTTP 客户端的 `baseURL`（`baseURL: !s && n.baseURL || a`，`a = "//api.bilibili.com"`）。裸路径若默认挂在扫描域名上必然打不通：B 站实测 `www.bilibili.com/x/web-interface/nav` 返回 **404**，`api.bilibili.com/x/web-interface/nav` 返回 **200**。因此 host 在**同一批扫描内**解析——某条路径若别处出现过协议相对写法就继承那个 host，完全没有 host 证据且客户端 `baseURL` 唯一时挂到 baseURL 上。**有歧义一律不猜**：一条路径对应多个 host、或一个 bundle 里有多个 baseURL，都保持扫描域名。
**`{{param}}` 占位符**：命令模板用双花括号表示渲染期取值——`urlTemplate` / `queryTemplate` / `bodyTemplate` 中是 `{{name}}`（如 `?keyword={{keyword}}`、`{"page":{{page}}}`）；单花括号 `{id}` 只出现在 `pathTemplate` 里，是结构标识与稳定哈希输入，**调用时不替换**。通过 `call_api_command.params` 按参数名传值：query/path 值做 URL 编码，body 值保持 JSON 类型（数字不转字符串），path 值含 `/`、`?`、`#` 一律拒绝。请求里捕获到的常量会被改写成 `{{name}}` 占位符、真值存进 `param.defaultValue`，因此**调用方传值永远优先**，常量只作兜底。`responseFields` 白名单决定返回哪些字段。
**复合命令（多步编排）**：命令可以带 `steps`，把「查列表 → 取 id → 查详情 → 提交」从 Agent 手工串联变成一条命令：
```json
{
  "name": "order.detail",
  "steps": [
    { "name": "list", "commandId": "order.list", "params": { "page": "1" } },
    { "name": "detail", "commandId": "order.get",
      "params": { "orderId": "{{orderId}}" },
      "from": { "orderId": { "from": "$.data.order.id" } } }
  ]
}
```
- **取值路径 = JSONPath**：`$.data.order.id`。支持的子集是 `$` 根、`.name`、`["name"]`、`[n]`、`[*]`；过滤表达式（`?()`）、脚本表达式（`()`）、递归下降（`..`）、通配属性（`.*`）刻意不支持。`[*]` 恒展开为数组，命中 1 个也是数组。
- **依赖 = 显式映射表**：`from` 把步骤参数映射到上一步响应的某个路径。取值优先级是**映射 > 调用方传值 > 步骤固定值**；映射覆盖了调用方传值时，覆盖事实会记录在结果里，不会被静默丢弃。
- **预检零请求**：子命令缺失、写操作未确认、步骤静态参数不合法，都**一个请求都不发**。某步取值路径未命中时，**该步零请求**，已执行的前序步骤列在 `warnings[]` 里。
- **风险只升不降**：步骤不能自述 `read` 把写子命令降级；嵌套复合命令直接拒绝。
**绝不落盘的内容**：Cookie、CSRF token、凭据，以及任何形似真凭据的值（JWT / Bearer / Basic / `Authorization` / token 类 query）一律不进缓存、报告与日志。而**刻意落盘**的是：非凭据请求头的**值**与业务样本值（标量，长度上限 200）——沉淀命令集若不能在日后免重新抓包地调用，就失去意义。响应体采样默认关闭，仅在分析期间对前 20 条匹配的 XHR/fetch + JSON/text + 2xx 响应采样（单条 ≤64KB），且只驻留内存用于推导字段名与类型。`scan_site` 读取的脚本 / 规格 / HAR **原文同样只在内存流转**，产物只含路径结构、HTTP method 与字段名，独立配额（40 源 / 单源 2MB / 总计 16MB / 8s 超时）不占用也不修改上述抓包采样配额。登录态补采的 bundle 原文只在「扩展 → 消息 → 编排层局部变量」中流转，回包后即丢弃，独立配额（10 源 / 单源 2MB / 总计 8MB / 8s 超时）；`options` 白名单不含 `headers` / `cookies` / `method` / `body`，扩展侧也不提供任何请求构造入口。

## AI 搜索摘要（`ai_search`）

`ai_search({query:"Kubernetes 探针有哪几种", maxChars:4000, maxCitations:5})` 一次调用返回 `answer`（markdown 正文）、`citations[]`（标题 / 链接 / 来源站点）与 `via`（实际通道），**不开网页、不抓包、不需要登录态**。

它的接口不是搜索页，而是驱动搜索页顶部那块「AI 智能回答」的生成流：

```
POST https://chat-ws.baidu.com/baikan/conversation?inputMethod=chat_search&llmsearch=1&word={{query}}
→ text/event-stream，正文在 data.message.content.generator，component="markdown-yiyan" 的 data.value 逐段增量
```

实测**不需要** `k_signature` / `pmgr_token` / `k_timestamp` / `lid` / `qid`（真实页面请求里都有，但服务端不校验）；只要 body 带上 `baikan_is_high_time_demand:"1"` 与 `categoryIDs:[20]` 就有正文，缺这两项则只回骨架、`text` 全为空。返回值里的 `sseEndpoint` 就是这条模板，需要时可以自行用 `curl` 复用。

兜底通道是移动站 `m.baidu.com` 搜索页里 **SSR 的 `baikan` 数据块**（`<script type="application/json" data-for="baikan">`，`component="markdown"` 的 `content` 按文档顺序拼接）——它不需要任何 token，但百度在移动站的 AI 覆盖率明显更低（同一查询桌面站有、移动站没有），因此只作兜底。详见 [AI Search 设计](docs/ai-search-design.md)。

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

对 `call_api_command`，扩展侧还会**独立于 MCP 客户端**（完全不读 `confirm`）追加校验：目标 URL 必须 http(s)、hostname 必须与命令所属域名精确相等、且通过域名白名单；只读模式拒绝 `risk:"write"` 命令；重定向用 `redirect:'manual'` + fail-closed（`REDIRECT_BLOCKED`），不逐跳跟随。`confirm` 只是 server 侧防误触发闸门，**不是安全边界**。

**已知风险（存量行为，本次未改）**：存量 `replay_api_request` 仍会透传 `authorization` / `x-csrf-token` 等敏感 header。修改 `REPLAY_FORBIDDEN_HEADERS` 会破坏依赖该行为的既有用户，因此本次为保护既有行为未修改，已列入 Roadmap「存量安全加固」。`call_api_command` 通道**接收 header，但只接收非凭据 header**——`Cookie` / `Authorization` / `Proxy-Authorization` / `Set-Cookie` 在请求发出前就被白名单重建剔除，因此从源头是安全的。

## 双重用途声明

本包依据 npm 的双重用途内容策略发布，并在 `package.json` 中声明
`"contentPolicy": { "class": "dual-use" }`，发布 tarball 根目录带 `DISCLOSURE` 文件。
复用已登录浏览器并求值页面脚本的自动化，在自动扫描器看来确实形似恶意软件，
因此该声明说明本包做什么、应当如何使用。完整文本见 [`DISCLOSURE`](DISCLOSURE)。

## 会话标签组

每个 MCP 进程派生**两个**身份键，因为「隔离」与「重启复用」需要的是两种不同性质：

- `agentKey` —— 归属：这是哪个逻辑会话。宿主注入 `WEBPILOT_SESSION_ID` 时用它，否则用 MCP 客户端名加工作目录哈希。
- `instanceKey` —— 隔离：这是哪个活实例会话。`agentKey` 加一个进程级后缀，因此同一宿主的并发会话互不冲突。

扩展为每个实例分配独立的 Chrome 标签组，命名为 `WebPilot·{agent}-{instance}`：

- 不带显式 `tabId` 的命令作用于自己实例组内最近使用的标签页，组为空时新建一个。
- `tabId` 属于其他实例组的命令会被拒绝——**即使对方与本进程共享同一 `agentKey`**——因此并行 Agent 互不干扰。
- `list_tabs` 只返回调用者自己的组，加上用户未分组的标签页。
- 会话的 MCP 进程断开时，其组被标记为 `·idle`、变灰并折叠；回归的会话**重新认领**它并落在同一页面上。归属键有歧义时拒绝认领，因此会话绝不会继承他人页面或登录态——注入 `WEBPILOT_SESSION_ID` 可让归属精确，或用 `claim_session` 工具显式认领。
- 空闲组在 `WEBPILOT_GROUP_TTL_MIN`（默认 30 分钟）后被垃圾回收，总数受 `WEBPILOT_MAX_GROUPS`（默认 5，最旧空闲组先关）限制。
- 用扩展弹窗的 **清理闲置组** 按钮或 `cleanup_sessions` 工具手动清理（`onlyIdle` 默认 `true`；传 `sessionId` 可关特定组）。
- `browser_status` 报告角色、两个身份键、作用范围与浏览器里的每个组——判断「哪个会话拥有什么」最快的方式。

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
