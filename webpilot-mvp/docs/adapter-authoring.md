# 站点适配器

适配器是只读、声明式的 DOM 提取器：服务器选择受信任的适配器定义，扩展仅执行 CSS 选择器和字段读取，返回紧凑 JSON，而不是把整页 DOM 交给模型。

## 当前适配器

- `generic-page-summary`：任意 HTTPS 页面。
- `github-repository`：GitHub 仓库主页。
- `github-issues`：GitHub 仓库 Issues 列表。

所有适配器继续经过扩展的域名白名单；只读模式下仍可运行。

## 选择与健康度

`extract_with_best_adapter` 会优先尝试域名和路径最具体的适配器；当它因 DOM
变化或页面状态无法提取时，会只读降级到 `generic-page-summary`，并返回
`fallbackUsed` 与 `failedCandidates`。`get_adapter_health` 聚合调用次数、
成功/失败、平均耗时和最近错误。健康度只用于当前 MCP 进程的诊断，不会把
网页数据或输入内容写入其中。

## 新增适配器

在 `mcp-server/src/adapters.ts` 增加一个定义：指定 `id`、允许域名、可选路径正则和 `spec`。`spec` 只能包含字段选择器或列表选择器；不允许任意 JavaScript、点击或输入。

字段支持 `text`（默认）、`href`、`content` 属性，以及 `multiple` / `limit`。列表项字段可使用 `$self` 读取匹配的项本身。为稳定性优先使用语义属性、稳定 URL 片段和 metadata，避免样式类名。
