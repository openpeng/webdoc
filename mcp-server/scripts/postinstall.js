/**
 * postinstall.js — 安装后引导用户完成配置
 * 打印：1) 如何加载浏览器扩展  2) 如何配置 Agent  3) 如何安装 Skill
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

console.log(`
┌──────────────────────────────────────────────────────────────┐
│  WebPilot MCP Server 安装成功!                               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  快速开始（3 步）:                                            │
│                                                              │
│  1. 安装浏览器扩展                                           │
│     chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序  │
│     选择目录: ${pkgRoot}/browser-extension                    │
│     然后打开扩展弹窗点击 Connect                              │
│                                                              │
│  2. 配置 Agent (Claude Code / Cursor / Codex 等)             │
│     在 MCP 配置中添加:                                       │
│     {                                                        │
│       "mcpServers": {                                        │
│         "webpilot": {                                        │
│           "command": "npx",                                  │
│           "args": ["webpilot-mcp"]                           │
│         }                                                    │
│       }                                                      │
│     }                                                        │
│                                                              │
│  3. 安装 Skill（可选，增强 Agent 使用体验）                   │
│     将本包内的 skill/SKILL.md 复制到你的 Agent 技能目录:      │
│     ${pkgRoot}/skill/SKILL.md                                │
│     参考: https://github.com/openpeng/webdoc/blob/main/      │
│           webpilot-mvp/INSTALL.md                            │
│                                                              │
│  文档: https://github.com/openpeng/webdoc/tree/main/         │
│        webpilot-mvp                                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
`);
