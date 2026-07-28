# WebPilot MVP — AI 浏览器操作助手

浏览器插件 + MCP Server + 本地桥接 Daemon 的极简组合，让 AI Agent 可以操控浏览器。

## 架构

```
┌─────────────────┐      WebSocket       ┌──────────────┐      Stdio       ┌─────────────────┐
│  Chrome 扩展     │ ◄──────────────────► │   Daemon     │ ◄──────────────► │   MCP Server    │
│  (操作浏览器)     │   ws://localhost:8765 │  (消息中转)   │                  │ (供 AI Agent 调用)│
└─────────────────┘                      └──────────────┘                  └─────────────────┘
```

- **浏览器扩展** (`browser-extension/`): 通过 Chrome Extension API 执行导航、点击、输入、截图等操作
- **Daemon** (`daemon/`): WebSocket 服务端，负责扩展与 MCP Server 之间的消息转发
- **MCP Server** (`mcp-server/`): 基于 Model Context Protocol，向 Claude Code / Cursor / Codex 等 AI 工具暴露浏览器操作能力

## 快速开始

### 1. 启动 Daemon

```bash
cd daemon
npm install
npm run build
npm start
```

Daemon 默认监听 `ws://localhost:8765`。

### 2. 安装浏览器扩展

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `browser-extension` 文件夹
5. 扩展图标将出现在工具栏，点击可查看连接状态

### 3. 启动 MCP Server

```bash
cd mcp-server
npm install
npm run build
npm start
```

MCP Server 通过 stdio 与 AI Agent 通信，同时通过 WebSocket 连接到 Daemon。

## MCP 接入配置

### Claude Code

在 Claude Code 的配置文件中添加：

```json
{
  "mcpServers": {
    "webpilot": {
      "command": "node",
      "args": ["/absolute/path/to/webpilot-mvp/mcp-server/dist/server.js"],
      "env": {
        "WEBPILOT_DAEMON_URL": "ws://localhost:8765"
      }
    }
  }
}
```

### Cursor

在 Cursor Settings → MCP 中添加：

- **Type**: Command
- **Command**: `node /absolute/path/to/webpilot-mvp/mcp-server/dist/server.js`

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `WEBPILOT_DAEMON_URL` | `ws://localhost:8765` | MCP Server 连接 Daemon 的地址 |
| `WEBPILOT_PORT` | `8765` | Daemon 监听的端口 |

## 可用工具

MCP Server 暴露以下工具供 AI 调用：

| 工具名 | 功能 |
|--------|------|
| `navigate` | 打开指定 URL |
| `get_page_info` | 获取页面标题、URL、可交互元素列表 |
| `click` | 点击指定 CSS 选择器的元素 |
| `type` | 在输入框中输入文本 |
| `screenshot` | 截取当前页面可见区域 |
| `execute_js` | 执行 JavaScript 代码 |
| `list_tabs` | 列出所有标签页 |

## 使用流程

1. 确保 Daemon 已启动（`npm start`）
2. 在 Chrome 中打开 WebPilot 扩展，点击「连接」按钮
3. 启动 MCP Server（由 AI Agent 自动管理）
4. 在 AI Agent 中直接调用浏览器操作工具

## 开发

```bash
# Daemon 热重载
cd daemon && npm run dev

# MCP Server 热重载
cd mcp-server && npm run dev
```

## 文件结构

```
webpilot-mvp/
├── browser-extension/
│   ├── manifest.json      # 扩展配置
│   ├── popup.html         # 弹出面板 UI
│   ├── popup.js           # 面板交互逻辑
│   ├── background.js      # Service Worker（WebSocket + CDP 操作）
│   └── icons/             # 扩展图标
├── daemon/
│   ├── src/index.ts       # WebSocket 中转服务
│   ├── package.json
│   └── tsconfig.json
├── mcp-server/
│   ├── src/server.ts      # MCP Server 实现
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

## 许可证

MIT
