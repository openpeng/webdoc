# 站点适配器

适配器是只读、声明式的 DOM 提取器：服务器选择受信任的适配器定义，扩展仅执行 CSS 选择器和字段读取，返回紧凑 JSON，而不是把整页 DOM 交给模型。

适配器定义以 **JSON 数据文件**沉淀在 `mcp-server/definitions/adapters/` 下，运行时加载。新增、修改或分享适配器只需编辑 JSON，无需改动 TypeScript 或重新编译。

## 当前适配器

- `generic-page-summary`：任意 HTTPS 页面。
- `github-repository`：GitHub 仓库主页。
- `github-issues`：GitHub 仓库 Issues 列表。
- `baidu-search-results`：百度搜索结果页（`/s`）。
- `google-search-results`：Google 搜索结果页（`/search`）。
- `zhihu-question` / `zhihu-search-results`：知乎问题页与搜索结果。
- `xiaohongshu-feed` / `xiaohongshu-note`：小红书发现页/搜索结果与笔记详情。
- `juejin-article` / `juejin-feed`：掘金文章与信息流列表。
- `weixin-article`：微信公众号文章（`mp.weixin.qq.com/s`）。
- `chatglm-conversation` / `doubao-conversation` / `gemini-conversation`：AI 对话站点的会话消息提取。
- `goofish-search-results` / `goofish-item`：闲鱼搜索结果与商品详情。

所有适配器继续经过扩展的域名白名单；只读模式下仍可运行。国内内容站点（小红书、知乎、闲鱼等）的部分内容需要登录态才可见；适配器只读取当前 DOM 中已渲染的内容，不做登录或翻页。AI 对话站点的 DOM 结构改版较频繁，提取失败会自动降级到 `generic-page-summary` 并计入健康度，据此修订选择器。

## 选择与健康度

`extract_with_best_adapter` 会优先尝试域名和路径最具体的适配器；当它因 DOM
变化或页面状态无法提取时，会只读降级到 `generic-page-summary`，并返回
`fallbackUsed` 与 `failedCandidates`。`get_adapter_health` 聚合调用次数、
成功/失败、平均耗时和最近错误。健康度只用于当前 MCP 进程的诊断，不会把
网页数据或输入内容写入其中。

# 定义来源与合并

适配器按以下顺序从目录加载，**同 `id` 定义后者覆盖前者**：

1. 仓库内置目录 `mcp-server/definitions/adapters/`（随仓库分发）；
2. 环境变量 `WEBPILOT_ADAPTER_DIR` 指定的外部目录（个人/团队自定义与覆盖）。

目录内每个 `*.json` 文件可以是单个定义对象，或定义对象数组。单条定义校验失败只会被跳过并在 stderr 打印告警，不影响其它定义加载。

## 新增/修改适配器

在 `mcp-server/definitions/adapters/` 新建或编辑 JSON 文件，每条定义包含：`id`、`name`、`description`、`domains`（非空数组）、可选 `pathPattern`（字符串形式的路径正则，如 `"^/question/\\d+"`）和 `spec`。

`spec` 只能包含 `fields`、`list` 或 `table` 三种只读提取形态。**加载时按白名单重建 spec**：字段只保留 `selector`、`attribute`、`multiple`、`limit`，任何 `computed` 或其它可执行内容都会被丢弃——这是"声明式只读"安全边界的关键，外部 JSON 定义无法注入任意 JavaScript。

字段支持 `text`（默认）、`href`、`content` 属性，以及 `multiple` / `limit`。列表项字段可使用 `$self` 读取匹配的项本身。为稳定性优先使用语义属性、稳定 URL 片段和 metadata，避免样式类名。

分享一个适配器只需把对应 JSON 文件发给他人，放入其内置目录或外部目录即可；PR 审查也只是纯数据 diff。
