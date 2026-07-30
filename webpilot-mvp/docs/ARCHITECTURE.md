# WebPilot 架构

本文回答"WebPilot 是什么结构、为什么这样设计"。使用方式见 [README](../README.md)，安装步骤见 [INSTALL](../INSTALL.md)，适配器编写见 [adapter-authoring](adapter-authoring.md)，沉淀策略见 [task-sedimentation-guide](task-sedimentation-guide.md)。

## 组件总览

```
MCP Agent (Claude Code / Cursor / Codex ...)
    │  stdio (MCP 协议)
    ▼
mcp-server/src/server.ts          工具层：50+ 工具的 schema 与 handler
    │
    ├─ bridge.ts                  BrowserBridge：Leader-Follower 多进程共享
    │      │  ws://127.0.0.1:8765（扩展连接口）
    │      │  ws://127.0.0.1:8766（Follower 转发口，仅 Leader 监听）
    │      ▼
    │  browser-extension/         Chrome 扩展（MV3）
    │      ├─ background.js       WS 客户端 + 命令分发 + 标签页路由
    │      └─ page-tools.js       注入页面世界：resolve 五级定位、快照、提取
    │
    ├─ adapters.ts                声明式只读提取（AdapterRegistry）
    ├─ task-runtime.ts            任务循环：计划/检查点/工作流/登录页人工接管
    ├─ selector-cache.ts          (host, intent) → 耐久选择器缓存
    └─ definitions.ts             JSON 定义加载器（definitions/ 目录）
```

`daemon/` 是早期的独立守护进程方案，已被 Leader-Follower 桥接取代，保留作参考。

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

**JSON 定义运行时加载**（definitions.ts）：内置目录与 `WEBPILOT_ADAPTER_DIR` / `WEBPILOT_WORKFLOW_DEF_DIR` 外部目录按序合并，同 id 后者覆盖前者；单条定义校验失败只跳过不中断。新增站点支持只需编辑 JSON，无需改代码或重新编译。

**选择器缓存**：click/type 带 `intent` 参数时按 `(hostname, intent)` 缓存耐久定位符；命中零观察零 token，连续 4 次失败自动禁用，成功复活。`@eN`/`@wpN` 文档级引用与输入文本永不入缓存。

## 安全边界

由内到外三道防线：

1. **扩展本地开关**（用户在 popup 控制，服务器无法越过）：导航白名单、敏感域拦截、只读模式。
2. **服务器端白名单重建**：外部 JSON 定义不透传——适配器 spec 只保留 fields/list/table 声明式只读键（`computed` 等可执行内容直接丢弃，attribute 仅 href/content）；预置工作流动作按键白名单重建，navigate 限 http(s)，type 文本必须 `{{param}}` 占位符（字面输入与凭据进不了定义文件）。
3. **日志纪律**：任务事件与动作日志剔除 text/script 字段，输入内容与脚本不落盘；选择器缓存加载时逐条白名单校验，篡改注入的条目被跳过。

**凭据策略：不存凭据，登录交给人**。WebPilot 复用真实浏览器的登录态（Chrome 自身持久化 cookie/session）；任务动作后若检测到新进入登录页（URL 特征或出现密码输入框），任务自动暂停交还人工，登录完成后用 `resume_task` 继续。工具本身永不存储、也不代填凭据。

## 目录与产物

- `mcp-server/src/*.ts` → `tsc` → `dist/`；测试（`test/*.test.mjs`，node:test）直接驱动 dist 产物，保证测的是发布物。
- `mcp-server/definitions/` 随包分发，是三层沉淀中前两层的数据载体。
- 运行时生成物默认在 `.webpilot-task-logs/`（任务日志、失败截图、workflows.json、selector-cache.json），可用 `WEBPILOT_TASK_LOG_DIR` 等变量重定向。
- `npm run doctor` 自检环境：Node 版本、构建产物、定义加载、桥接端口、环境变量。
