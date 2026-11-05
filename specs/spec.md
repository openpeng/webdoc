# WebPilot API 命令集升级 - 接口规格（lite）

> 最后更新：2026-11-05
> 本文档是前后端接口契约，代码须与此文档保持一致。
> lite 版：适用于中小需求（tier3+ 档位），仅保留契约骨架；字段级测试点/六维 AC 派生等完整要求见 full 版 spec.md。

---

## 变更背景与目标

- **背景**：现有「网站操作模版」是 UI 操作序列，与站点页面结构强耦合、站点一改版就失效；站点功能背后几乎都有对应 HTTP 接口，却没有被沉淀下来。
- **目标**：把「页面操作背后的网络请求」沉淀成可复用的 API 命令——更全地发现站点接口、更少约束地调用、可导出交付他人直接使用。
- **非目标**：不做 CAPTCHA / SSO / 二次验证自动化，不做无上限自主循环与并发写操作，不新增任意 JS 执行能力。

## 概述

**所属能力**：`webpilot-api-command-set`
**涉及项目**：后端 `webpilot-mcp-server`（+ 浏览器扩展 `webpilot-browser-extension`），无前端
**接口路由前缀**：`MCP tool:`（本能力对外暴露的是 MCP 工具，非 HTTP 路由；下列「路径」列均为 MCP 工具名）

> 未确认事项集中登记到文末「待确认问题」节，禁止用假设填空。

---

## 验收标准（AC）

> 每条 AC 编号唯一、可观察（Given/When/Then），能映射到接口/业务规则。
> lite 版覆盖要求：每个接口至少 1 条主流程 + 1 条异常 AC；涉及权限的加 1 条越权 AC；每条 BR 正反各 1 条。

| AC ID | Given / When / Then | 对应接口 | 优先级 |
|-------|---------------------|----------|--------|
| AC-1 | Given 一个仅有 JS bundle 的现代站点，When 调用 `analyze_page_apis` 且 `action=scan_site`、不传 `loosePaths`，Then 产出端点数 ≥ 1（基线为 0） | `analyze_page_apis` | P0 |
| AC-2 | Given 静态推导产出含 GET 端点，When 查看命令 `risk` 字段，Then GET/HEAD/OPTIONS 为 `read`、其余为 `write`（基线全部为 `write`） | `analyze_page_apis` | P0 |
| AC-3 | Given 命令声明了必填参数，When 调用 `call_api_command` 缺该参数，Then 返回 `MISSING_PARAMS` 且**不发出任何请求** | `call_api_command` | P0 |
| AC-4 | Given 命令 `risk=write`，When 调用 `call_api_command` 不传 `confirm=true`，Then 返回 `CONFIRMATION_REQUIRED` 且**不发出任何请求** | `call_api_command` | P0 |
| AC-5 | Given 命令参数 `nickname` 在分析时被观测为恒定值，When 调用 `call_api_command` 传 `params.nickname="lisi"`，Then 实际请求体为 `lisi`（基线被静默忽略、发出分析时的旧值） | `call_api_command` | P0 |
| AC-6 | Given 调用方传 `headers={"X-Requested-With":"XMLHttpRequest","Cookie":"a=b","Authorization":"Bearer x"}`，When 调用 `call_api_command`，Then 实际请求含 `X-Requested-With`、**不含** `Cookie` 与 `Authorization` | `call_api_command` | P0 |
| AC-7 | Given 某域名已沉淀命令集，When `export_api_commands` 导出后清空缓存再 `import_api_commands` 导入，Then 导入后命令条数、名称、参数、响应裁剪规则与导出前一致且可直接调用 | `export_api_commands` / `import_api_commands` | P0 |
| AC-8 | Given 一个成品格式命令包（含 `request.urlTemplate` / `risk` / `responseFields` / `manuallyEdited`），When 调用 `analyze_page_apis` 且 `action=scan_site`、`sources.kind=commands`，Then 产出 ≥ 1 条命令且上述字段被保留（基线产出 0 条） | `analyze_page_apis` | P0 |
| AC-9 | Given 两个 MCP 进程先后写不同域名的命令集，When 后者写盘，Then 磁盘上两个域名的命令都存在（基线先写者被整片抹除） | `get_api_command_cache` | P0 |
| AC-10 | Given 某域名已有命令集，When 调用 `invalidate_api_commands` 且 `action` 缺失或为非法值，Then 返回 `INVALID_PARAMS` 且该域名命令**不被删除**（基线：兜底成全域删除） | `invalidate_api_commands` | P0 |
| AC-11 | Given 扩展弹窗配置了域名白名单且不含目标域，When 调用 `call_api_command` 命中该域，Then 被扩展侧拒绝且**不发出请求** | `call_api_command` | P0 |
| AC-12 | Given 扩展处于只读模式，When 对端声明 `risk=read` 但 `method=POST`，Then 扩展侧按 method 判定为写操作并拒绝（基线：只读模式被绕过） | `call_api_command` | P0 |
| AC-13 | Given 某站点 OpenAPI 规格声明 19 个端点，When 调用 `analyze_page_apis` 且 `sources.kind=openapi`，Then 产出 19 条命令且路径模板 19/19 命中规格路径 | `analyze_page_apis` | P1 |
| AC-14 | Given `ai_search` 的 SSE 流收到多个增量片段且含重复相邻字符，When 解析，Then 答案完整拼接不丢字（基线：三个连续「哈」得到「哈」） | `ai_search` | P1 |

## 业务规则

| BR ID | 条件 | 处理动作/结果 | 错误码 |
|-------|------|---------------|--------|
| BR-1 | 静态推导来源非权威规格（js / har） | 按真实 method 判定 risk；命令标注来源 `scan`；`needsReview` 只保留 1 条来源标注 | — |
| BR-2 | 路径参数取值含 `/` `?` `#`（原始或 URL 解码后） | 拒绝渲染，零网络请求 | `UNSAFE_PATH_PARAM` |
| BR-3 | 渲染后 URL 的 hostname 与命令所属域名不一致 | 拒绝渲染，零网络请求 | `HOST_MISMATCH_AFTER_RENDER` |
| BR-4 | 请求头名命中 `cookie` / `authorization` / `proxy-authorization` / `set-cookie` | 静默剔除，不报错、不落盘 | — |
| BR-5 | `invalidate_api_commands` 的 `action` 非 `disable` / `delete` / `clear_domain` 字面量 | 拒绝执行，不修改任何缓存 | `INVALID_PARAMS` |
| BR-6 | 命令 `risk=write` 且未传 `confirm=true` | 拒绝执行，零网络请求 | `CONFIRMATION_REQUIRED` |
| BR-7 | 上游返回 401 / 403 | 标记 `authRequired`，不计连续失败、不禁用命令、不重试 | `AUTH_REQUIRED` |
| BR-8 | 目标 URL 在域名白名单外 / 非 http(s) / 跨 host | 扩展侧拒绝，零网络请求 | `DOMAIN_NOT_ALLOWED` / `HOST_MISMATCH` / `INVALID_URL` |
| BR-9 | 缓存写盘前发现磁盘上有本进程未加载的域名 | 写前重读并按 hostname 合并后再落盘 | — |
| BR-10 | 缓存文件读取失败 | 标记 `loadFailed`，后续写盘只写本次新增域名，不覆盖既有内容 | — |

---

## Scenario 1：静态推导生成站点命令

### 接口定义

| 字段 | 内容 |
|------|------|
| 路径 | `analyze_page_apis`（`action=scan_site`） |
| 方法 | MCP tool call |
| 鉴权 | 不需要 |
| 说明 | 直接读取 JS bundle / HAR / OpenAPI / 声明式命令包，一次拿到整站接口骨架；不经过浏览器、不依赖标签页与登录会话 |

### Request

```json
{
  "action": "scan_site",
  "domain": "api.example.com",
  "sources": [
    { "kind": "js", "url": "https://api.example.com/static/app.js" },
    { "kind": "openapi", "text": "{\"paths\":{\"/api/v1/orders\":{\"get\":{}}}}" }
  ],
  "mode": "merge",
  "trustSpec": true,
  "loosePaths": true,
  "collectViaExtension": false,
  "discoverBundles": false
}
```

**字段说明**

| 字段 | 类型 | 必填 | 说明 | 校验规则 |
|------|------|------|------|----------|
| action | String | 是 | 分析动作 | 枚举 `start` / `stop_and_analyze` / `analyze_current` / `scan_site` |
| domain | String | 是 | 精确 hostname | 小写去端口，不合并 www. |
| sources | Array | 否 | 数据源列表 | `kind` ∈ `js`/`har`/`openapi`/`commands`；`text` 优先于 `url`；上限 40 源 |
| mode | String | 否 | `merge`（默认）/ `full` | `full` 移除未观测到的非人工条目 |
| trustSpec | Boolean | 否 | 规格类来源按声明 method 判 risk | 默认 true（放开后） |
| loosePaths | Boolean | 否 | 放宽路径前缀判定 | 默认 true（放开后） |
| collectViaExtension | Boolean | 否 | URL 类源改由扩展借登录态取文本 | 默认 false |
| discoverBundles | Boolean | 否 | 从当前标签页自动发现并补采 bundle | 默认 false |

### Response

```json
{
  "analysisId": "an_20261105T120000_001",
  "domain": "api.example.com",
  "cacheWritten": true,
  "endpointCount": 19,
  "commandCount": 19,
  "commands": [
    {
      "commandId": "cmd_46d73cf501",
      "name": "get.orders",
      "method": "GET",
      "pathTemplate": "/api/v1/orders",
      "risk": "read",
      "params": [{ "name": "page", "location": "query", "type": "string", "required": false }],
      "responseFields": [],
      "source": { "origin": "scan" }
    }
  ],
  "needsReview": [{ "commandId": "cmd_46d73cf501", "reason": "静态推导产物：接口来自前端代码 / 规格 / 归档流量，未经真实响应验证" }],
  "warnings": [],
  "diff": { "added": 19, "updated": 0, "removed": 0, "skipped": 0, "reviewRequired": 19 }
}
```

**响应字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| endpointCount | Integer | 归组后的端点数 |
| commandCount | Integer | 生成的命令数 |
| commands | Array | 命令卡片（含 `source.origin` 来源标注） |
| needsReview | Array | 待人工复核项（`commandId` + `reason`） |
| warnings | Array | 固定文案告警，不含任何样本值 |

### 异常情况

| 错误码 | 场景 | 提示文案 |
|--------|------|----------|
| `INVALID_PARAMS` | `action` 非法或 `domain` 非法 | 未知的 analyze action |
| `NO_CACHE_LIST_WARNING` | 域名无缓存 | 该域名尚未沉淀 API 命令 |
| `SITE_SCAN_SOURCE_FAILED_WARNING` | 数据源读取失败 / 超限 / 私网或跨 host 被拒 | 固定安全文案，不回显 URL |

---

## Scenario 2：免开网页调用命令

### 接口定义

| 字段 | 内容 |
|------|------|
| 路径 | `call_api_command` |
| 方法 | MCP tool call |
| 鉴权 | 不需要（复用浏览器已登录会话的 Cookie，Cookie 不落盘） |
| 说明 | 按命令名 + 参数直接发起请求；不依赖目标页面打开、不依赖抓包缓冲区 |

### Request

```json
{
  "domain": "api.example.com",
  "name": "get.orders",
  "params": { "page": 1 },
  "headers": { "X-Requested-With": "XMLHttpRequest" },
  "fields": ["id", "title"],
  "confirm": true
}
```

**字段说明**

| 字段 | 类型 | 必填 | 说明 | 校验规则 |
|------|------|------|------|----------|
| domain | String | 是 | 精确 hostname | 小写去端口 |
| commandId / name | String | 条件必填 | 二选一指定命令 | 至少给一个 |
| params | Object | 否 | 命令参数 | 未知参数 → `INVALID_PARAMS`；缺失必填 → `MISSING_PARAMS` |
| headers | Object | 否 | 附加请求头 | `cookie` / `authorization` / `proxy-authorization` / `set-cookie` 静默剔除 |
| fields | Array | 否 | 响应字段裁剪白名单 | 覆盖命令自带的 `responseFields` |
| confirm | Boolean | 否 | 写操作确认 | `risk=write` 时必须为 `true` |

### Response

```json
{
  "commandId": "cmd_46d73cf501",
  "name": "get.orders",
  "request": { "method": "GET", "urlTemplate": "https://api.example.com/api/v1/orders?page={{page}}", "durationMs": 143 },
  "status": 200,
  "contentType": "application/json",
  "data": { "id": 1, "title": "示例" },
  "truncated": false,
  "cacheHit": true,
  "authRequired": false,
  "warnings": []
}
```

**响应字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| request.urlTemplate | String | 模板，非真实 URL；不含任何 header 值或业务样本值 |
| data | Object / Array | 按白名单裁剪后的响应体 |
| authRequired | Boolean | 上游返回 401/403 时为 true，命令**不**被禁用 |
| warnings | Array | 固定文案（如结构漂移） |

### 异常情况

| 错误码 | 场景 | 提示文案 |
|--------|------|----------|
| `CONFIRMATION_REQUIRED` | 写操作未确认 | 写命令需显式确认 |
| `MISSING_PARAMS` | 缺必填参数 | 缺少必填参数：xxx；未发送任何请求 |
| `INVALID_PARAMS` | 参数类型/取值不符或含未知参数 | 参数类型或取值不符合约束 |
| `UNSAFE_PATH_PARAM` | 路径参数含 `/ ? #` | 路径参数含非法字符 |
| `HOST_MISMATCH_AFTER_RENDER` | 渲染后 hostname 与命令域名不符 | 渲染后主机名与命令域名不一致 |
| `AUTH_REQUIRED` | 上游 401/403 | 登录态可能已失效，请重新登录后重试 |
| `HTTP_ERROR` | 上游 4xx/5xx | HTTP 状态错误 |
| `DOMAIN_NOT_ALLOWED` / `HOST_MISMATCH` / `REDIRECT_BLOCKED` / `READ_ONLY_BLOCKED` | 扩展侧本地边界拒绝 | 固定安全文案 |

---

## Scenario 3：命令集导出与导入

### 接口定义

| 字段 | 内容 |
|------|------|
| 路径 | `export_api_commands` / `import_api_commands` |
| 方法 | MCP tool call |
| 鉴权 | 不需要 |
| 说明 | 把某域名已沉淀的命令集导出为可审查 JSON，并支持导入他人交付的命令集 |

### Request

```json
{
  "domain": "api.example.com",
  "path": "C:/workspace/api-commands.example.com.json",
  "includeDisabled": false,
  "overwrite": true
}
```

**字段说明**

| 字段 | 类型 | 必填 | 说明 | 校验规则 |
|------|------|------|------|----------|
| domain | String | 是 | 精确 hostname | 小写去端口 |
| path | String | 是 | 导出文件路径 / 导入文件路径 | 导出需可写；导入需存在且为合法 JSON |
| includeDisabled | Boolean | 否 | 导出时包含已禁用命令 | 默认 false |
| overwrite | Boolean | 否 | 导入时覆盖同名命令 | 默认 false，同名跳过并计入 `skipped` |

### Response

```json
{
  "domain": "api.example.com",
  "exported": 19,
  "imported": 19,
  "skipped": 0,
  "path": "C:/workspace/api-commands.example.com.json",
  "redactedFields": [],
  "warnings": []
}
```

**响应字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| exported / imported | Integer | 成功导出的命令数 / 成功导入的命令数 |
| skipped | Integer | 因同名或非法被跳过的命令数 |
| warnings | Array | 固定文案，不含任何样本值 |

### 异常情况

| 错误码 | 场景 | 提示文案 |
|--------|------|----------|
| `INVALID_PARAMS` | `domain` / `path` 非法 | 参数不合法 |
| `WRITE_FAILED` | 导出文件写入失败 | 写入失败 |
| `NO_CACHE_LIST_WARNING` | 导出时该域名无命令 | 该域名尚未沉淀 API 命令 |

---

## 待确认问题

| 问题 | 信息源 | 状态 |
|------|--------|------|
| 复合命令（多步编排）中「上一步响应取值 → 下一步入参」的取值路径语法最终形态 | 用户拍板：纳入本需求、排最后做；语法细节待实现时与用户确认 | 待确认（本期仅预留接口） |
| 导出的命令集文件是否需要随 npm 包分发 | PRD Q9 已否决随包分发；导出文件由使用者自行决定分发范围 | 已闭环 |
| 响应敏感字段完全放开后，是否需要保留一个「严格打码」开关以备回归 | 用户拍板：全放开 | 已闭环（保留开关，默认关） |

---

## 变更记录

| 日期 | 变更内容 |
|------|----------|
| 2026-11-05 | 初始版本 |
