# WebPilot 架构

本文回答"WebPilot 是什么结构、为什么这样设计"。使用方式见 [README](../README.md)，安装步骤见 [INSTALL](../INSTALL.md)，适配器编写见 [adapter-authoring](adapter-authoring.md)，沉淀策略见 [task-sedimentation-guide](task-sedimentation-guide.md)。

## 组件总览

```
MCP Agent (Claude Code / Cursor / Codex ...)
    │  stdio (MCP 协议)
    ▼
mcp-server/src/server.ts          工具层：50+ 工具的 schema 与 handler（含 7 个 API 命令集工具）
    │
    ├─ bridge.ts                  BrowserBridge：Leader-Follower 多进程共享（传输适配层）
    │      │  ws://127.0.0.1:8765（扩展连接口）
    │      │  ws://127.0.0.1:8766（Follower 转发口，仅 Leader 监听）
    │      ▼
    │  browser-extension/         Chrome 扩展（MV3）
    │      ├─ background.js       WS 客户端 + 命令分发 + 标签页路由 + CDP 抓包/采样/执行
    │      ├─ api-command-helpers.js  与 MCP 侧逐字对齐的常量 + 白名单重建/目标 URL 校验 helper
    │      └─ page-tools.js       注入页面世界：resolve 五级定位、快照、提取
    │
    ├─ api-command-types.ts       契约层：类型 / 消息常量 / 错误码 / 阈值 / 三处白名单 / 脱敏规则
    ├─ api-command-normalize.ts   纯函数解析管线①：CDP 记录归一化、过滤、{id} 模板化、参数推断
    ├─ api-command-response-schema.ts  纯函数解析管线②：响应 schema 推导、裁剪 + [REDACTED] + 截断
    ├─ api-command-generator.ts   纯函数解析管线③：稳定 commandId、命名消歧、risk / confidence / needsReview
    ├─ api-command-render.ts      纯函数解析管线④：参数校验 + {{param}} 渲染 + path 注入防护 + host 复核
    ├─ api-command-service.ts     编排层：7 工具编排、分析会话关联、写确认闸门、错误分类、健康度记账
    ├─ api-command-cache.ts       缓存层：按精确 hostname 的懒加载 / 原子写 / 白名单重建 / full·merge / 状态机
    ├─ baidu-ai-search.ts         纯函数提取器：baikan SSE 流解析 + 移动站 baikan 块提取 + 私有 markdown 清洗
    ├─ adapters.ts                声明式只读提取（AdapterRegistry）
    ├─ task-runtime.ts            任务循环：计划/检查点/工作流/登录页人工接管
    ├─ selector-cache.ts          (host, intent) → 耐久选择器缓存
    └─ definitions.ts             JSON 定义加载器（definitions/ 目录）
```

`daemon/` 是早期的独立守护进程方案，已被 Leader-Follower 桥接取代，保留作参考。

## API 命令集的分层与消息通道

新增能力按**五层**组织，与既有分层互不耦合：

| 层 | 模块 | 关键纪律 |
| --- | --- | --- |
| 契约层 | `api-command-types.ts` ←→ `api-command-helpers.js` | 两端只共享**常量值与字段形状**，不共享代码；`MSG` / `MSG_RESULT` / 27 项错误码 / 阈值 / 正则 / 白名单逐字一致 |
| 纯函数解析管线 | `normalize` / `response-schema` / `generator` / `render` | **无 IO**：不 import `node:fs`、不读环境变量、不读墙钟（时间由编排层 `GenerateContext.now` 注入）、不依赖运行时单例，可被 `node --test` 直接单测 |
| 编排层 | `api-command-service.ts` | 唯一允许发扩展消息与读墙钟的一层；分析会话状态**不放 MCP 进程**，只传 `analysisId` 关联 start/stop |
| 传输适配层 | `server.ts` 7 个 case + `bridge.ts::send()` | `send(type, params)` 对任意 type 透明转发，**协议路由一行不改**；只扩展 `safeParameters` 的日志剥离集合 |
| 缓存层 | `api-command-cache.ts` → `api-commands.json` | 本地运行时资产，按精确 hostname 分组；懒加载 + tmp/rename 原子写 + 逐条 `toCommand()` 白名单重建 |

三条新消息（回包 type = 请求 type + `Result`，原样带回 `requestId` + `success`）：

| type | 方向 | 关键 options | 回包 |
| --- | --- | --- | --- |
| `apiAnalysisStart` | M→E | `analysisId, filter, includeStaticAssets, maxEndpoints, captureResponseBody` | `apiAnalysisStartResult` |
| `apiAnalysisStop` | M→E | `analysisId`（`analyzeCurrent` 走兼容入口） | `apiAnalysisStopResult`（`records[] + samples[] + warnings[]`） |
| `apiCommandExecute` | M→E | `url, method, hostname, risk, body, maxBodyChars, timeoutMs`（**无 headers / confirm / overrides**） | `apiCommandExecuteResult` |
| `apiBundleCollect` | M→E | `urls, hosts, discover, maxSources, maxBytes, timeoutMs, useBrowserCache`（**无 headers / cookies / method / body**） | `apiBundleCollectResult`（`sources[{url, ok, text, via, bytes}]`，`via ∈ page/worker/cache`） |

`apiAnalysisStart` / `apiAnalysisStop` / `apiBundleCollect` 加入 `TAB_SCOPED_COMMANDS` 走跨组拒绝；`apiCommandExecute` **不加入**（免开网页前提）。分析会话状态放扩展侧 `apiAnalysisSessions`，抓包用独立 `apiAnalysisListener` 与既有 `networkCaptures` / `networkListener` 平行；同 tab 已有活跃抓包时复用同一 debugger session，只增删 listener、不重复 attach / 不 detach 别人的。

`apiBundleCollect` 只在 bundle 受登录态保护（Node 直读 401）时使用：取文本三层 fallback（页面上下文 fetch → Service Worker fetch → CDP `Page.getResourceContent` 浏览器缓存），取到的文本回传 MCP 侧交给**同一个** `scanSources()` 解析，扩展侧不做任何接口推断；原文只在内存流转，不写 storage、不进 `operationLogs`、不进缓存 / 报告。

Q11 自动加载只注入两处：`case "navigate"`（文本追加一行摘要）与 `case "webmcp"` 的 `action:"probe"` 分支（`JSON.stringify` 前追加 `result.apiCommands`）。摘要来自纯本地缓存读取，**零网络请求、零自动执行**。

## 一条 call_api_command 的数据流

1. `server.ts` 把入参交给 `ApiCommandService.call()`；`ApiCommandCache.get()` 懒加载读盘并逐条白名单重建。
2. 写命令未带 `confirm` → 返回 `CONFIRMATION_REQUIRED` + 脱敏 `preview`，**零网络请求**（`confirm` 只是防误触发闸门，不是安全边界）。
3. `validateParams()` → `renderRequest()`：query/path 编码、body 保类型、path 值拒含 `/ ? #`、渲染后 hostname 二次复核。
4. 只把渲染后的 `url / method / hostname / risk / body / maxBodyChars / timeoutMs` 下发扩展；`bridge.safeParameters` 再剥离 `body / params / samples / records / postData / queryParams / headers`（双保险）。
5. 扩展 `rebuildExecuteOptions()` 白名单重建（丢弃注入的 `headers` / `confirm` / `overrides` / `tabId`），`assertCommandAllowed()` 按**目标 URL** 校验白名单 + `readOnlyMode && risk==='write'` + 紧急停止，随后 `fetch(url, {credentials:'include', redirect:'manual'})` 由 Chrome 自动匹配 Cookie。
6. 任何 3xx / `opaqueredirect` → `REDIRECT_BLOCKED`（fail-closed，不逐跳跟随）。响应回包经 `redactAndProject()` 白名单裁剪 + 敏感字段 `[REDACTED]` + 数组 ≤5 + `maxBodyChars` 截断；401/403 → `authRequired`（不禁用、不重试），4xx/5xx → `HTTP_ERROR`，结构漂移 → `drifted`。

## ai_search：为什么不是一条 api_command

`ai_search` 是命令集之外的一条**无状态查询工具**，归属上刻意与命令集分离：

| | `call_api_command` | `ai_search` |
| --- | --- | --- |
| 来源 | 抓包 / 静态推导沉淀，存 `api-commands.json` | 固定端点，硬编码在 `baidu-ai-search.ts` |
| 返回 | 原始响应体（可能是一段 SSE 或 2MB HTML） | 已解析的 `answer` + `citations[]` + `via` |
| 缓存 | 有（影响健康度记账） | **无**，不写盘、不进 `operationLogs` |
| 复用前提 | 先跑一次分析 | 零准备，任意查询直接调 |
| 扩展消息 | `apiCommandExecute` | 仅兜底通道复用 `apiBundleCollect` |

分层纪律：`baidu-ai-search.ts` 是**纯函数**（无 IO、无墙钟、无全局状态），可被 `node --test` 直接单测；取流 / 取页 / 重试 / 超时全部收在 `api-command-service.ts`（唯一允许发网络请求与读墙钟的一层）。这与四段纯函数解析管线是同一条纪律。

通道选择逻辑：先打 `chat-ws.baidu.com/baikan/conversation`（SSE，桌面站 AI 摘要的真实来源，无需签名），取到正文即返回；空流 / 非 2xx / 超时才降级到移动站 SSR 的 `baikan` data block。两条通道都返回同一个 `BaiduAiAnswer`，调用方不需要区分。详见 [AI Search 设计](ai-search-design.md)。

## Leader-Follower 桥接（bridge.ts）

多个 MCP Agent 进程共享同一个浏览器扩展连接：

- 第一个抢到 8765 端口的进程成为 **Leader**：持有扩展 WS 连接，并在 8766（仅 127.0.0.1）接受其他进程转发。
- 绑定 8765 失败的进程成为 **Follower**：以 WS 客户端连 8766 转发命令；与 Leader 断开后随机退避重试「绑 8765 → 成则晋升 / 败则重连 8766」。
- 端口可用 `WEBPILOT_PORT` / `WEBPILOT_PROXY_PORT` 覆盖；每个进程有独立 sessionId，各自的标签页组互不干扰。

这样设计避免了独立 daemon 的安装/升级/存活管理成本：任何一个 MCP 进程都能承担 Leader 角色，进程退出时其他进程自动接管。

## 一条 click 命令的数据流

1. Agent 调用 MCP 工具 `click`，server.ts handler 校验参数（timeout 归一化、intent 缓存查询）。
2. `bridge.send("click", params)`：Leader 直接下发扩展；Follower 经 8766 转发给 Leader。
3. background.js 按 tabId（或会话当前标签）路由，把命令注入目标页面执行 page-tools.js。
4. page-tools.js `resolve(selector)` 五级定位：`@wpN` 稳定引用 → `@eN` 快照索引 → `text=` → `role=` → CSS；找到元素后派生耐久定位符、执行点击。
5. 结果沿原路回传，diagnostics 携带 selector/strategy/durationMs/durableSelector/前后 URL；server.ts 据此回写选择器缓存并整理为 MCP 响应。

## 沉淀层：从一次性操作到可复用资产

三层显式沉淀 + 一层自动沉淀，目标是把"Agent 摸索出来的操作"变成下次零摸索的资产：

| 层 | 模块 | 载体 | 粒度 |
| --- | --- | --- | --- |
| 适配器 | adapters.ts | definitions/adapters/*.json | 站点级只读提取 |
| 预置工作流 | task-runtime.ts | definitions/workflows/*.json | 跨页多步操作 |
| 保存的工作流 | task-runtime.ts | workflows.json（运行时生成） | Agent 任务复盘保存 |
| 选择器缓存 | selector-cache.ts | selector-cache.json（自动） | 单元素定位 |
| 域名级 API 命令缓存 | api-command-cache.ts | api-commands.json（`WEBPILOT_API_COMMAND_DIR`，本地运行时生成） | 精确 hostname → 具名 API 命令 |

**JSON 定义运行时加载**（definitions.ts）：内置目录与 `WEBPILOT_ADAPTER_DIR` / `WEBPILOT_WORKFLOW_DEF_DIR` 外部目录按序合并，同 id 后者覆盖前者；单条定义校验失败只跳过不中断。新增站点支持只需编辑 JSON，无需改代码或重新编译。

**选择器缓存**：click/type 带 `intent` 参数时按 `(hostname, intent)` 缓存耐久定位符；命中零观察零 token，连续 4 次失败自动禁用，成功复活。`@eN`/`@wpN` 文档级引用与输入文本永不入缓存。

**域名级 API 命令缓存**：与上面可随包分发的「可审查资产」不同，它是**本地运行时资产**，按精确 hostname 隔离（不合并 `www.` / 子域、不向父域回退），不随 npm 包分发、不做导出导入与团队同步（Q9 否决）。加载与写入两侧都做逐字段白名单重建，外域 URL / 字面凭据 / 可执行字段一律跳过并记入 `skippedInvalid[]`；连续 4 次失败禁用、一次成功复活；`full` / `merge` 合并默认保留人工修正（`manuallyEdited`），未观测到的人工条目保留并标 `stale`，仅 `overwriteManual:true` 才删除。详见 [task-sedimentation-guide.md](task-sedimentation-guide.md)。

## 安全边界

由内到外三道防线：

1. **扩展本地开关**（用户在 popup 控制，服务器无法越过）：导航白名单、敏感域拦截、只读模式、紧急停止。`apiCommandExecute` 按**目标 URL**（而非当前标签 URL）复核白名单与 hostname 精确相等；只读模式拒绝 `risk:"write"`；`confirm` 完全不读，客户端直接置 `true` 也越不过 storage 里的只读开关。
2. **服务器端白名单重建**：外部 JSON 定义不透传——适配器 spec 只保留 fields/list/table 声明式只读键（`computed` 等可执行内容直接丢弃，attribute 仅 href/content）；预置工作流动作按键白名单重建，navigate 限 http(s)，type 文本必须 `{{param}}` 占位符（字面输入与凭据进不了定义文件）。API 命令集把同一纪律前移到分析、缓存与消息三处：`msg.options` 白名单重建丢弃 `headers` / `confirm` / `overrides` / `tabId`，`toCommand()` 逐字段重建缓存条目，只存 header **字段名**、绝不存值。
3. **日志纪律**：任务事件与动作日志剔除 text/script 字段，输入内容与脚本不落盘；选择器缓存加载时逐条白名单校验，篡改注入的条目被跳过。`bridge.safeParameters` 的剥离集合扩展为 `text / script / body / params / samples / records / postData / queryParams / headers`（含 `options` 内嵌），新命令日志只记 `commandId / method / hostname / risk / status / durationMs / success`。
4. **重定向 fail-closed**：新执行通道 `redirect:'manual'` + 任何 3xx / `opaqueredirect` 直接 `REDIRECT_BLOCKED`，不解析 `Location`、不逐跳跟随。存量 `replayApiRequest` 的 `redirect:'follow'` 与 `REPLAY_FORBIDDEN_HEADERS` 保持不变（AC-26 回归），其透传敏感 header 的存量风险已列入 Roadmap。

**凭据策略：不存凭据，登录交给人**。WebPilot 复用真实浏览器的登录态（Chrome 自身持久化 cookie/session）；任务动作后若检测到新进入登录页（URL 特征或出现密码输入框），任务自动暂停交还人工，登录完成后用 `resume_task` 继续。工具本身永不存储、也不代填凭据。

## 目录与产物

- `mcp-server/src/*.ts` → `tsc` → `dist/`；测试（`test/*.test.mjs`，node:test）直接驱动 dist 产物，保证测的是发布物。
- `mcp-server/definitions/` 随包分发，是三层沉淀中前两层的数据载体。
- 运行时生成物默认在 `.webpilot-task-logs/`（任务日志、失败截图、workflows.json、selector-cache.json、api-commands.json），可用 `WEBPILOT_TASK_LOG_DIR` 等变量重定向；`api-commands.json` 可单独用 `WEBPILOT_API_COMMAND_DIR` 指向别处。
- `browser-extension/api-command-helpers.js` 通过 `importScripts` 引入（classic SW，manifest 不改）；与 `api-command-types.ts` 逐字同步常量，两端不共享代码。
- `npm run doctor` 自检环境：Node 版本、构建产物、定义加载、桥接端口、环境变量（含 `WEBPILOT_API_COMMAND_DIR`）与 API 命令缓存加载状态 / 被跳过条目。
