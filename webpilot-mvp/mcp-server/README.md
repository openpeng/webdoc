# webpilot-mcp-server

WebPilot MCP Server——通过 Chrome 扩展控制真实浏览器（复用登录态）的 MCP 工具集，供 Claude Code / Cursor / Codex 等 MCP 兼容 Agent 调用。

- 50+ 浏览器工具：导航、点击、输入、快照、提取、任务循环、工作流
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

## 自检

```bash
npm run doctor   # 检查 Node 版本、构建产物、站点定义加载、桥接端口
```

## License

MIT
