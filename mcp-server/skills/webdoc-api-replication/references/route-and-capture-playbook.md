# 路由定义规范 · 常见模式 · 抓包要分析什么

本文件是**操作手册**：回答「拿到一个站点后，按什么顺序看什么，才能更快复刻」。

它与 `rea-principles.md` 的分工：
- `rea-principles.md` 是**口径**（证据怎么分档、未知怎么表示）——先读那份；
- 本文件是**手法**（路由长什么样、模式有哪些、抓包先看哪个字段）。

**引用纪律不变**：本文件引用的 REA 结论一律用 `docs/<file>.md` 的原句（已逐字校验），
本仓落位一律给**标识符**而不是行号（行号会漂，标识符不会，见 `repo-map.md`）。

---

## 0. 复刻的三段式节奏

复刻不是「扫出接口就完事」，是三段：

| 段 | 产出 | 判据 |
| --- | --- | --- |
| ① 认路 | 端点清单 + 每个端点的参数形态 | 端点身份有证据（`observed`/`derived`），未知部分显式标 `unknown` |
| ② 取数 | 真实响应结构 + 真实数据 | 响应档位为 `observed`（拿到真实样本），否则恒 `unknown` |
| ③ 对表 | 「我这条命令打出去，对不对得上原站」 | 命令能实调，且返回数据结构与原站一致 |

**最快的路径是跳过①的穷举**：先找到一个「列表型」端点，它一次就带回大量真实 ID，
再用这些 ID 去打「详情型」端点——**一次列表调用 = N 个详情调用的 ID 来源**。
本仓的复合命令（`steps` + JSONPath 取值映射）就是把这条链固化成一条命令的机制。

> 本仓实测（`docs/arms-tracing-replication-report.md`）：
> `GetTraceApp`（列表）→ `GetTraceAggr`（详情），
> 首轮 29 个动作里 20 个直接 `code=200`。列表端点是整个复刻的杠杆点。

---

## 1. 路由定义规范

### 1.1 端点身份 = method + origin + pathTemplate

三段合起来才是「一个接口」。少一段就是另一个接口。

> "The view groups request lines by method, WHATWG URL origin and path template, sorted by origin, template and method. Query strings, fragments, credentials, headers and bodies are not copied into groups."
> —— docs/web-network-captures.md (§Derived API surface)

**反过来说**：`?page=1` 与 `?page=2` 是**同一个**接口的两次调用，不是两个接口。
按 query 值裂开会让命令集爆炸。

本仓落位：
- `groupEndpoints()`（`api-command-normalize.ts`）按 `host` + `method` + `pathTemplate` 分组；
- `endpointKey()`（`api-command-normalize.ts`）只吃 method + pathTemplate；
- `candidateKey()`（`api-command-site-scan.ts`）额外把 host 计入去重键。

**host 必须计入去重键**——本仓已踩过：静态推导会把协议相对 URL（`//host/path`）还原到各自 host，
同一路径挂在不同 host 上是**不同接口**，并成一条必然有一半打错地址。

### 1.2 pathTemplate 怎么来

按表序应用于**仍编码的**请求路径，且读于 dot-segment 移除之前：

| 规则 | 匹配 | 占位符 |
| --- | --- | --- |
| `numeric` | 纯 ASCII 数字 | `{numeric}` |
| `uuid` | RFC 9562 UUID（任意版本，大小写不敏感） | `{uuid}` |
| `hex` | ≥32 位十六进制 | `{hex}` |
| `iso-date` | 合法日历日 `YYYY-MM-DD` | `{iso-date}` |

> "Rules apply in table order to the recorded, still-encoded request path, read before WHATWG dot-segment removal, so `/a/%2e%2e/admin` and `/admin` stay distinct."
> —— docs/web-network-captures.md (§Derived API surface)

> "Version prefixes, short opaque IDs and digit-bearing route names stay literal."
> —— docs/web-network-captures.md (§Derived API surface)

**版本前缀保持字面量**是重点：`/v2/users` 与 `/v1/users` 是两个不同接口，
不能把 `v2` 当成动态段吃掉。

> "Samples merge only when method, origin, and exact segment rules match. The view does not infer further cross-sample patterns."
> —— docs/web-network-captures.md (§Derived API surface)

**样本只在同 method + 同 origin + 同分段规则下合并**，不多推一层模式。

本仓落位：`templatePath()`（`api-command-normalize.ts`）做归一；
`toPathTemplate()`（`api-command-site-scan.ts`）把 OpenAPI 的 `{name}`、`${expr}`、`:id`、`<id>` 统一成 `{id}` 风格，
并用 `isUsablePathTemplate()` 拒掉「全是动态段」的模板（无静态锚点 ≈ 必是误报）。

### 1.3 上下文路径（最容易整批打错地址的一层）

> 本仓实测（`docs/arms-tracing-replication-report.md`）：ARMS 的页面 origin 是
> `armsnext.console.aliyun.com`，业务 API 却在 `fecs.console.aliyun.com`——**两者不同**。
> Confluence 同类：bundle 里的 `/rest/webResources/1.0/resources` 实际是
> `/confluence/rest/webResources/1.0/resources`，缺前缀时请求打到 Tomcat 原始 404 页。

**「扫得到、调不通」的第一嫌疑就是上下文前缀 / 业务主机不同源。**
修前缀前后各打一次，对比返回的是「服务器默认页」还是「应用自己的 404」，
能立刻区分「地址空间错了」和「参数/方法错了」。

本仓落位：`normalizeContextPath()` / `applyContextPath()`（`api-command-site-scan.ts`）；
`detectBaseUrlHosts()` 侦测客户端 baseURL 候选（多候选 → `baseUrl` 歧义，不猜）。

---

## 2. 常见模式

### 2.1 资源动作映射表（REST 风格的默认预期）

路径末段语义 → HTTP 方法 → 预期副作用：

| 末段语义 | 典型方法 | 副作用 | 备注 |
| --- | --- | --- | --- |
| 集合资源（`/users`） | GET | 无 | 列表；带分页/筛选参数 |
| 集合资源 | POST | 有 | 建；**但** POST 也可能是「列表查询」（见 2.2） |
| 单体资源（`/users/{id}`） | GET/PATCH/DELETE | 读无 / 改有 / 删有 | `{id}` 是动态段 |
| 子资源（`/users/{id}/orders`） | GET/POST | 读无 / 建有 | 嵌套层级表达归属 |
| 动作词（`/export`、`/batch`、`/sync`） | POST | 视语义 | 非 CRUD，**不要**当成 CRUD 猜 |

> "A `POST`, `PUT`, `PATCH` or `DELETE` with a 2xx or 3xx status, or no status, may change state, unless it is a `POST` whose path has a segment such as `search`, `query`, `list`, `find`, `fuzzy`, `count` or `stats`, which queries state instead."
> —— docs/web-network-captures.md (§Environment state)

本仓落位：`classifyRisk()`（`api-command-generator.ts`）——`GET`/`HEAD`/`OPTIONS` → `read`，其余一律 `write`，
**不做「看起来像只读」的放宽**；`READ_ONLY_SAFE_METHODS`（`api-command-types.ts`）。

### 2.2 「POST 列表查询」——最常见的只读接口被误判成写操作

大量站点用 `POST` 传复杂筛选条件（body 里带 `page`/`keyword`/`filters`），本质是查询。

判据（本仓实现，只看**字段名**与**路径静态段**，绝不读任何字段值）：
- method = POST；
- body/query 字段名命中筛选分页类线索（`FILTER_PARAM_NAME_HINTS`）；
- 路径无状态变更动词。

本仓落位：`looksLikePostListQuery()`（`api-command-generator.ts`）→
命中后**进 `needsReview`**（`POST_LIST_QUERY_REVIEW_REASON`），但 `risk` 仍是 `write`。
理由：只看字段名会误判（`delete` 也可能叫 `removeItem`），放宽 risk 的代价远大于多一次人工确认。

### 2.3 筛选 / 分页 / 排序参数

| 用途 | 常见参数名 |
| --- | --- |
| 分页 | `page` `size` `limit` `offset` `pageNo` `pageSize` `cursor` `after` `before` |
| 筛选 | `keyword` `query` `q` `filter` `search` `from` `to` `sort` `order` |
| 响应分页字段 | `total` `count` `hasMore` `has_more` `next` `nextPage` `pages` `totalCount` |

本仓落位：`PAGINATION_FIELD_NAMES` / `FILTER_PARAM_NAME_HINTS`（`api-command-types.ts`）；
`isPaginationField()`（`api-command-response-schema.ts`）给响应字段打 `isPagination` 标记。

### 2.4 「网关 + 动作名」模式（RPC 风格）

**不是 REST 资源路径，而是「一个端点 + 一个动作名」**。ARMS 就是这一类：

```
POST {网关}/data/api.json?<ActionName>
body: { product, action, region, params }
```

- 端点只有少数几个，**动作名在 query 或 body**，参数在 `params`（JSON 字符串）；
- 端点类型还有 `/data/innerApi.json` `/data/call.json` `/data/httpApi.json` `/data/custom.json`；
- 批量形态：`POST /data/v2/multiApi.json?A1~A2~A3`，body `actions=[{action,params},...]`，
  响应按 `"0"`/`"1"` 索引回每个动作的结果。

**对本仓的意义**：静态扫描从 bundle 里抽路径字面量时，这类站点的路径极其短
（`/data/api.json`），`isApiPath()` 靠 `API_PATH_HINT_RE` 的前缀表可能整批漏掉；
动作名在 query 里，也不在 pathTemplate 里——**必须靠 query 参数名清单才能看出动作维度**。

> REA 侧对应能力：`include_query_parameter_names: true` 的
> `api-surface` 视图会给出每组**观测到的 query 参数名**清单
> （`docs/web-network-captures.md` §Derived API surface）。
> 本仓落位：`parseHarText()` / `scanJsText()` 抽取 `queryPairs`（`api-command-site-scan.ts`）。

### 2.5 批量端点：一次请求换多个动作

批量接口是**加速复刻的原生手段**：一次 HTTP 拿到 N 个动作的真实响应。
本仓复合命令 `steps` 上限 `MAX_COMPOSITE_STEPS = 5`，
每步可用 `{"from": "<jsonpath>"}` 从上一步响应取值注入下一步参数。

> 注意取值映射的三态语义（`api-command-render.ts` 的 `applyStepMappings()`）：
> `overridden`（取值命中，覆盖了调用方传值）、`fallback`（取值未命中，退回调用方传值）、
> `missing`（两边都没有，**不发请求**）。三者方向相反，混用会让告警说反事实。

### 2.6 鉴权模型：先判定「能不能脱离页面」

复刻前必须先回答：**这条接口脱离浏览器还能不能调通？**

| 现象 | 结论 |
| --- | --- |
| 只读 + 无会话依赖 | 可无 UI 复刻 |
| 依赖会话 Cookie，且 Cookie 是 `SameSite=Lax` | **扩展后台发请求带不上**——Lax 不随跨站 fetch 发送 |
| 依赖 `Origin`/`Referer` + 反爬签名（页面内 JS 计算） | **签名无法离线复现** → 该部分明确排除，不硬啃 |

> 本仓实测（ARMS）：`Cookie: login_aliyunid_ticket` **且** `Origin/Referer` 指向控制台域名，
> **缺一不可**（四组对照矩阵实测）。最初「只要 Cookie 就行」的判断被矩阵实验推翻。
> 结论：无 UI 调用必须由调用方**显式携带 Cookie 头**（手工指定不受 SameSite 约束）。

**这是安全边界问题，不是技术问题**：本仓 `API_COMMAND_FORBIDDEN_HEADERS`
（`api-command-types.ts`）明确剔除 `cookie` / `authorization`，
扩展侧 `assertCommandAllowed()` 与 `assertApiTargetUrl()` 是**一行不改的硬边界**。
需要放开时走「显式开关 + 默认关闭」，**不要**改硬边界。

### 2.7 时间单位与静默空结果

> 本仓实测（ARMS）：列表接口 `startTime` 是**毫秒**，而 span 自身的 `startTime` 是**纳秒**。
> 用纳秒调详情接口会返回 `depth=-1` 的**空树**——**不报错、静默空结果**。

「静默空结果」比报错更危险：报错会停下，静默空结果会被当成「这个接口没数据」而丢进 `unknown`。
**遇到空结果先怀疑参数形态与单位，再怀疑端点不存在。**

### 2.8 错误响应是参数契约的信息源

> 本仓实测（ARMS）：首轮 9 个失败里 **7 个是参数错误而非端点不存在**
> （`ParameterMissing` / `MissingAppType` / `MissingResourceId` / `ParameterTimeStampMissing`），
> 错误码**直接点名了必填参数名**。

这与 REA 的「缺失即未知」并不冲突：错误码是**观测到的响应体**，属于 `observed` 证据；
它证明「这个参数名是必填的」，不证明「其他参数不存在」。

**动作**：拿到 4xx 不要只记失败，把错误体里的参数名回填进命令的参数模板。
这是把端点档位从 `derived` 提到 `observed` 的**最快路径**。

---

## 3. 抓包要分析的数据

### 3.1 先分清两种抓包面

| 面 | 拿到什么 | 能得出什么 | 不能得出什么 |
| --- | --- | --- | --- |
| **HAR / SAZ 归档**（离线文件） | 完整请求行、响应头、响应体字节 | 端点身份、真实参数、真实响应结构 | 交互语义（哪个请求由哪个点击触发） |
| **CDP 实时抓包**（扩展侧） | 同上 + initiator + 时间戳 + 响应体样本 | 上面全部 + 触发点线索 | —— |

> "Network observations retain method, status, MIME type, size, type, initiator stack location, and complete URLs with userinfo credentials removed."
> —— docs/browser-observation.md (§Data minimization)

> "Headers are discarded after an allowlisted projection of length/encoding, structured CSP/Link/policy fields, and untrusted agent hints. Cookies and authorization headers are never retained."
> —— docs/browser-observation.md (§Data minimization)

**凭据永远不留值**（头名可留用于诊断）——与本仓 `rea-principles.md` 第 11 条一致。

### 3.2 抓包分析的优先级顺序

按「信息密度 ÷ 成本」排，前三项决定这次抓包值不值：

| 优先级 | 字段 | 为什么 |
| --- | --- | --- |
| **P0** | `method` + `origin` + `pathTemplate` | 端点身份三要素；没有它其余都无从归属 |
| **P0** | **响应体样本** | 唯一能把响应档位从 `unknown` 提到 `observed` 的东西 |
| **P1** | 状态码 + MIME 类型 | 区分「JSON 接口」与「静态资源/HTML 错误页」 |
| **P1** | query **参数名**清单 | 分页/筛选维度；网关式站点的动作维度也在这 |
| **P1** | request body 的**顶层字段名 + JSON 类型名** | POST/PUT/PATCH 的入参形态 |
| **P2** | initiator（触发脚本） | 定位「哪个页面/动作发的」；**不构成因果证明** |
| **P2** | 时间戳 | 排先后、算依赖链；不做因果证明 |
| **P3** | 请求头**名**（不含值） | 判 CSRF/签名/追踪头；凭据头名可留、值不留 |

> "The inventory describes observed names, without inferring required parameters, value types or a complete API schema."
> —— docs/web-network-captures.md (§Derived API surface)

**只拿参数名是刻意的**：参数**值**是样本，可能含凭据/PII；
参数**名**是契约的一部分，安全且信息量高。

> "`body_shape` is derived for `POST`, `PUT` and `PATCH` from the tool's earliest record when it carries an `application/json` or `application/*+json` request body: top-level keys and their JSON type names, never values and never nested structure; a body on a later record adds nothing."
> —— docs/web-network-captures.md (§Environment manifest)

**只要顶层键 + 类型名，不要嵌套结构、不要值**——本仓同款：
`parseBodyFields()`（`api-command-normalize.ts`）、`safeParamName()` 过滤敏感字段名。

### 3.3 抓包覆盖范围：必须显式声明

> "Network and console coverage starts only after REA attaches and enables the relevant CDP domains. `prior_activity_available` is always `false`; absence from these arrays is not evidence that an event never occurred."
> —— docs/browser-observation.md (§Completeness and limits)

> "A page that loaded before attach can therefore list its scripts while `network.requests` lacks the requests that fetched them."
> —— docs/browser-observation.md (§Completeness and limits)

> "The result distinguishes `complete_within_window`, `policy_filtered`, `attach_limited`, and `truncated` coverage."
> —— docs/browser-observation.md (§Completeness and limits)

**这条最容易出事故**：脚本能列出来，不代表抓到过发它的请求。
「没抓到」和「没发生」是两件事——本仓 `coverage.scope`（`domain`/`batch`）就是为这个存在的。

### 3.4 「点了按钮」不等于「这个请求是它发的」

> "Method/path matching does not prove that the UI caused the request: use a path that distinguishes the intended operation from background polling."
> —— docs/browser-scenario-contract.md (§Saved values)

> "Many interactions, such as a search button that renders results in place, change the page without changing the URL."
> —— docs/browser-scenario-contract.md (§Interaction example: capture the visible result)

> "A URL-only capture can be `complete` and still be unable to answer a question about rendered content, so add the relevant artifact and run the scenario again rather than inferring from its absence."
> —— docs/browser-scenario-contract.md (§Interaction example: capture the visible result)

**实操**：要归因一个请求，就得用**能区分目标动作与后台轮询**的路径/参数；
URL 变了不代表页面变了，URL 没变也不代表页面没变——**渲染结果要看 DOM/截图，不看 URL**。

### 3.5 什么绝对不能从抓包推出来

| 不能推 | 原文 |
| --- | --- |
| 处理函数身份 / schema / 因果 | "The view makes no handler-identity, schema or causality claim." |
| 运行时归因与部署真实性 | "Historical evidence does not prove runtime attribution, execution or deployment authenticity." |
| 分段值组合 = 整条路径发生过 | "Segment-value combinations are never evidence that a whole path occurred." |
| 源码关联 = UI 因果 | "Source association does not establish UI causality." |
| 覆盖缺失 = 覆盖完整 | "Missing coverage is unknown: an already loaded script may be absent from a sample." |

### 3.6 什么时候该停止抓包、去补别的东西

抓包是**观测**通道，代价高（要人操作页面、要有登录态）。
以下情形改用其它通道更快：

| 情形 | 改用 | 依据 |
| --- | --- | --- |
| 站点整站覆盖 | `scan_site` 静态推导 | 不开页面、不抓包、一次拿整站骨架 |
| 有 OpenAPI / 命令包 | `openapi` / `commands` 来源 | 档位 `derived`，参数形态直接给 |
| bundle 受登录态保护 | `collectViaExtension` 借页面会话取文本 | 扫描仍走同一套解析 |
| 响应结构未知但端点已知 | `captureResponseBody=true` 限量采样 | 配额独立，不占 Q8 的 20 条 / 64KB |

> REA 给的判据是同一件事：
> "Use it to record an application's API, including writes, when driving the UI for each call would be slower or less exact than calling the endpoint the UI calls."
> —— docs/browser-scenario-contract.md (§Request steps)

**即：什么时候该直接调接口，而不是驱动 UI 去点？** 当接口调用更快或更精确时。
本仓的对应物就是 `call_api_command`——**免开网页、无需抓包缓冲区**，直接按命令模板调用。

---

## 4. 「更快复刻」的具体手法

按投入产出排序：

1. **先找列表型端点**。它一次带回一批真实 ID，是所有详情端点的 ID 来源。
2. **用错误响应反推参数名**。4xx 的错误码点名必填参数，比成功响应更省事（2.8）。
3. **先定鉴权模型**。Lax cookie / 反爬签名会直接决定「无 UI 可行吗」，
   早判定早止损，别在错误方向上堆工作量（2.6）。
4. **用 bundle 补覆盖、用抓包提档位**。两条通道合并，同键自动合并提档
   （`commandId` = `sha256(host\0method\0pathTemplate)`，人工改名不改 ID）。
5. **批量/复合命令固化多步链**。`steps` + JSONPath 把「列表→详情」变成一条命令。
6. **只读命令先跑通再谈写操作**。写操作需 `confirm:true` 且受扩展侧只读门拦截，
   收益却小得多（`risk` 判定是保守的，见 2.1）。
7. **遇到空结果先查参数形态与单位**，再查端点存在性（2.7）。

---

## 5. 与本仓链路的对应速查

| 概念 | 本仓落位 |
| --- | --- |
| 端点身份三要素 | `groupEndpoints()` / `endpointKey()` / `candidateKey()` |
| 路径模板化 | `templatePath()` / `toPathTemplate()` / `isUsablePathTemplate()` |
| 上下文路径 | `normalizeContextPath()` / `applyContextPath()` / `detectBaseUrlHosts()` |
| 端点噪声过滤 | `isNoisePath()` / `TELEMETRY_PATH_KEYWORDS` / `STATIC_RESOURCE_TYPES` |
| 筛选分页线索 | `FILTER_PARAM_NAME_HINTS` / `PAGINATION_FIELD_NAMES` / `isPaginationField()` |
| 响应结构推导 | `emptyResponseSchema()` / `deriveResponseFields()`（只写字段名与类型） |
| 风险判定 | `classifyRisk()` / `looksLikePostListQuery()` / `READ_ONLY_SAFE_METHODS` |
| 复合多步 | `resolveCompositeSteps()` / `applyStepMappings()` / `MAX_COMPOSITE_STEPS` |
| 证据分档与覆盖 | `deriveProvenance()` / `buildCoverage()` / `coverage.scope` |
| 硬边界（不可改） | `assertCommandAllowed()` / `assertApiTargetUrl()` / `API_COMMAND_FORBIDDEN_HEADERS` |

---

## 6. 出处

REA 一手文档（raw）：
- `https://raw.githubusercontent.com/morluto/rea/main/docs/web-network-captures.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/browser-observation.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/browser-scenario-contract.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/web-runtime.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/javascript-route-inventory.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/javascript-runtime-reconciliation.md`

本仓一手：
- `docs/arms-tracing-replication-report.md`（ARMS 无 UI 复刻实测）
- `docs/api-command-confluence-replication-report.md`（Confluence 上下文路径实测）
- `docs/api-command-site-scan-design.md`（放开分级与安全边界）
