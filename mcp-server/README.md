# webpilot-mcp-server

WebPilot MCP Server——通过 Chrome 扩展控制真实浏览器（复用登录态）的 MCP 工具集，供 Claude Code / Cursor / Codex 等 MCP 兼容 Agent 调用。

- 默认 7 个工具入口：页面、读取、交互、诊断、API 发现、命令查询和独立调用；高级工具显式开启
- WebMCP 双通道：原生调用页面注册的工具（快、准、稳），降级浏览器自动化兜底
- 页面能力探测：5 维度扫描（WebMCP/声明式表单/JSON-LD/DOM 语义/API 端点）
- Leader-Follower 桥接：多个 Agent 进程共享同一个浏览器扩展连接
- 站点资产 JSON 化：适配器与预置工作流是数据文件，新增站点无需改代码
- 选择器缓存：click/type 带 `intent` 参数即可零观察复用历史定位

## 快速开始

```bash
npx webpilot-mcp   # 或 npm install -g webpilot-mcp-server 后运行 webpilot-mcp
```

需要配合 WebPilot 浏览器扩展使用。完整安装步骤、扩展加载、Agent 配置见项目主页：

- 项目文档: https://github.com/openpeng/webdoc/tree/main/webpilot-mvp
- 架构说明: https://github.com/openpeng/webdoc/blob/main/webpilot-mvp/docs/ARCHITECTURE.md

## 默认工具入口

默认 `tools/list` 只展示以下 7 个入口。除独立执行工具 `api_call` 外，其余入口按 `action` 选择严格参数分支；缺少必填字段或携带其他分支字段会在执行前拒绝。

| 工具 | action / 用途 |
| --- | --- |
| `browser_page` | `list_tabs` / `navigate` / `screenshot` / `get_url` / `reload` / `go_back` / `go_forward` / `full_screenshot` / `element_screenshot` / `upload_file` / `download_file` / `save_pdf` / `handle_dialog` |
| `browser_read` | `info` / `inspect` / `text` / `table` / `resources` / `iframe_text` / `iframe_query` / `shadow_query` / `shadow_text` |
| `browser_act` | `click` / `type` / `hover` / `press_key` / `scroll` / `select_option` / `drag_drop` / `wait` / `wait_dynamic` / `click_at` / `iframe_click` / `shadow_click` / `shadow_type` |
| `browser_debug` | `evaluate` / `network_start` / `network_stop` / `network_resources` / `replay` / `console` / `probe_selector` / `selector_cache` / `action_log` |
| `api_discover` | `start` / `stop_and_analyze` / `analyze_current` / `scan_site` |
| `api_commands` | `domains` / `list` / `get`，只查本地命令，不执行 |
| `api_call` | 独立执行入口，不传 `action`；用 `commandId` 或 `name` 定位命令，`params` 提供业务参数 |

常用路径：`browser_read(info)` → `browser_act(click/type)` → `browser_act(wait)` / `browser_read(info)` 验证；API 路径为 `api_commands(domains)` → `list(domain)` → `get(domain, commandId/name)` → 独立 `api_call`，未命中才 `api_discover`。`domains` 纯本地列出缓存有命令的域名摘要，不接收 `domain` / `tabId`，不依赖浏览器；摘要不意味着端点已验证可调用。返回 `{domains:[{domain,total}],warnings:[]}`，仅列有缓存命令的域名，按字典序排列；`total` 包含禁用/弃用命令，不是当前可调用数。`list` 默认可能排除禁用条目，必要时传 `includeDisabled:true` 检查，并阅读 `warnings`。维护按需参照 browser Skill，`api_manage` 和原维护名称仅保留调用兼容，不在默认或高级列表展示。Skill 说明维护流程，本身不是执行引擎；隐藏兼容名称仅适用于支持直接 MCP 调用的客户端，不能假设所有宿主可调用。写命令未传 `confirm:true` 时只返回预览、不发请求；确认不会绕过域名白名单、只读模式、紧急停止或目标 URL 校验。

页面 JavaScript 通过 `browser_debug({action:"evaluate", expression:"..."})` 执行；`execute_js` / `evaluate` 旧名仍兼容，并非禁用。浏览器会话、登录态、标签组归属及安全边界不变。

服务端环境变量 **`WEBPILOT_ENABLE_ADVANCED_TOOLS=1`**（仅字符串 `1` 生效）额外展示 `cleanup_sessions`、`claim_session`、`browser_status`、`browser_config`、`browser_cookie`、`browser_task`、`task_workflow`、`adapter`、`webmcp`、`ai_search`。配置后重启/重连 MCP 客户端。旧独立名称保留调用兼容但不默认展示；新调用使用上表。任务循环还需调用环境开启 `enable_task_mode`，不是默认多步操作的前置条件。

Agent 操作指引见随包附带的 [webpilot-browser Skill](skills/webpilot-browser/SKILL.md)；证据与覆盖契约见 [webdoc-api-replication Skill](skills/webdoc-api-replication/SKILL.md)。

## 自检

```bash
npm run doctor   # 检查 Node 版本、构建产物、站点定义加载、桥接端口
```

## 双用途声明

本包依据 npm《Dual-Use Content Policy》发布，`package.json` 中声明了
`"contentPolicy": { "class": "dual-use" }`，并随包提供根目录 `DISCLOSURE` 文件。
浏览器自动化 + 复用登录态 + 页面脚本执行这类能力在自动化扫描眼中与恶意软件
特征相近，因此在此说明包的能力范围与合规使用方式。完整内容见包内 `DISCLOSURE`。

## License

MIT
