# WebPilot API 命令集升级：Spec / Design / Tasks

> 需求：[TAPD #1137748852001393342](https://www.tapd.cn/tapd_fe/37748852/iteration/card/1137748852001004376?q=6760d679d64c76ca429a83d360cc9261&dialog_preview_id=story_1137748852001393342) 《【工具】WebPilot 网站操作模版升级》
> 文档分支：`spec/webpilot-api-command-set-s1137748852001393342`
> 代码分支：`feature/webpilot-api-command-set-s1137748852001393342`
> 状态：已实现的基础链路见 `docs/api-command-set-design.md` / `docs/api-command-site-scan-design.md` / `docs/api-command-bundle-collect-design.md` / `docs/ai-search-design.md`
> 本文档同时充当 **Spec（做什么）**、**Design（怎么做）**、**Tasks（按什么顺序做）**。

---

## 1. 背景与目标

现有「网站操作模版」是 UI 操作序列（点击 / 输入 / 选择器），与站点页面结构强耦合：站点一改版就失效，且每个任务都要开浏览器逐个页面操作。

站点功能背后几乎都有对应 HTTP 接口。把「页面操作背后的网络请求」沉淀成可复用的 **API 命令**，就能把「操作一个网页」变成「执行一条命令」——不开页面、不依赖抓包缓冲区、不依赖 debugger。

本需求收口三件事：

| # | 增量 | 目标状态 |
|---|---|---|
| A | **发现覆盖** | 从「人点过的路径」扩展到「站点接口骨架」，静态推导在现代站点上不再产出为 0 |
| B | **调用能力** | 补齐站点校验必需请求头；解除单条命令只能一步调用的限制 |
| C | **可分发** | 命令集可导出、可导入、可交付他人直接使用，且标注来源可信度 |

**验收主线**：对至少 2 个真实站点（含 1 个有公开 OpenAPI 规格的站点）跑通「发现 → 生成命令 → 免开网页调用」全链路。

---

## 2. 实测基线（本需求的设计依据）

用仓库自身 `dist` 实现 + 真实站点实测，不是估算。

### 2.1 发现能力（B 站首页，浏览器实测 68 次 XHR，剔除 CDN 静态资源与埋点后 14 个真实业务端点）

| 输入源 | 发现命令 | 命中真值 | 召回 | 实打存活率 |
|---|---|---|---|---|
| Node 侧 HTML 正则 bundle（只看到 5/13 个）+ `loosePaths=true` | 5 | 2 | 14% | — |
| Node 侧 HTML 正则 bundle，**默认 `loosePaths=false`** | **0** | 0 | **0%** | — |
| 浏览器真实 bundle（13 个）+ `loosePaths=true` | 67 | 8 | 57% | **55%**（33/60 活） |
| 浏览器真实 bundle，**默认 `loosePaths=false`** | **0** | 0 | **0%** | — |
| 同站 OpenAPI 规格驱动 | 19 | 19 | **100%** | 路径全对 |

### 2.2 三个结构性缺口

1. **默认配置在现代站点上等于零产出**：`API_PATH_HINT_RE` 不含 `x` / `pgc` / `bapis` 这类前缀，`loosePaths=false` 时一条都发现不了。
2. **Node 侧只看得到 1/3 的 bundle**：浏览器实际加载 13 个，Node 的 HTML 正则只识别 5 个。
3. **主要误报模式是 host 前缀丢失**，不是「猜错路径」：`/cm/api/fees/pc` 实际在 `cm.bilibili.com`，被拼到 `api.bilibili.com` 上就 404。

### 2.3 其它已复现缺陷

| 现象 | 根因 |
|---|---|
| 协议相对 URL 被整体当成路径 | `STRING_LITERAL_RE` 匹配 `//host/path` |
| JS 扫描的 method 推断出错（实测 `POST /x/vip/ads/materials` 真实是 GET） | `inferMethod` 只认紧邻字面量的最后一个 `.verb(` |
| 真实业务值原样落盘，且**调用方传入值被静默忽略** | `inferParams` 把单条抓包的所有标量字段判为恒定 → 真值进 `defaultValue` → `bodyTemplate` 写成字面量 |
| 成品格式命令包导入产出 0 条 | `parseCommandSetText` 只认线索格式 `{method, path, params}` |
| 两个 MCP 进程先后写缓存，后写者把先写者的域名整片抹掉（无备份） | `persist()` 整文件 last-writer-wins，无锁、无写前重读、tmp 名固定 |
| SSE 增量拼接吞正文：三个连续「哈」→ 结果「哈」 | `value.startsWith(answer)` 前缀启发式把增量误判成快照 |
| SSE 流不关闭 → 已收齐的答案被整段丢弃 | `await response.text()` 只在流结束时 resolve |

---

## 3. 安全放开清单（明确边界）

定位为个人 / 内部使用工具。**放开的是「能不能用」，保留的是「能不能越权」。**

### 3.1 放开（用户已拍板）

| 项 | 之前 | 之后 |
|---|---|---|
| 静态推导 `risk` | 一律 `write` | 按真实 HTTP method 判定（GET/HEAD/OPTIONS → read） |
| 静态推导 `needsReview` | 3 条理由叠加 | 1 条来源标注 |
| 路径判定 `loosePaths` | 默认 false | 默认 true |
| 响应敏感字段 | 强制 `[REDACTED]` | 默认放行（保留开关可关） |
| 请求头白名单 | 仅 `accept` / `content-type` | **全部非凭据头**，仅排除 `Cookie` / `Authorization` |
| 样本值落盘 | `isSafeLiteral` 语法门槛拦截 | 允许标量值落盘（长度有上限） |

### 3.2 保留（本地硬边界，**一行不改**）

| 项 | 位置 |
|---|---|
| 域名白名单 | `background.js` `assertCommandAllowed` / `assertApiTargetUrl` |
| 紧急停止 | `background.js` `settings.emergencyStopped` |
| 目标 URL 校验（协议 + hostname 精确相等 + 不跟随跳转） | `background.js` `cmdApiCommandExecute` |
| 扩展侧只读模式 | `background.js` `assertCommandAllowed`（**但判定依据改为按 method 派生，见 T7**） |

### 3.3 实现方式

**配置化放开，不删代码。** 每个放开项对应一个开关（环境变量或工具入参），默认放开，需要收紧时改一个值即可回退。

---

## 4. Design

### T1 · 静态推导放开（发现覆盖）

**现状**：`api-command-service.ts` `scanSite()` 里 `trustSpec` 默认 false → 全部命令 `risk:"write"`；`loosePaths` 默认 false → 现代站点产出 0 条；`needsReview` 叠加 3 条理由。

**改动**：

| 文件 | 改动 |
|---|---|
| `api-command-types.ts` | 新增 `SITE_SCAN_DEFAULT_LOOSE = true`、`SITE_SCAN_DEFAULT_TRUST_SPEC = true`、`SITE_SCAN_REVIEW_REASON` 保留 |
| `api-command-service.ts` `scanSite()` | `trustSpec` 默认取常量；`loose` 默认取常量；`needsReview` 只保留来源标注 + 缺样本提示 |
| `api-command-site-scan.ts` `API_PATH_HINT_RE` | 保留高置信前缀层；`loose` 分支从「≥3 段」扩展为「≥2 段且首段是短标识符（≤4 位小写/数字，如 `x`/`pgc`/`api`/`v1`）」 |
| `api-command-service.ts` | `scan_site` 默认输入源改为「扩展侧 `discoverBundles` 优先 → Node 直读兜底」，需 `tabId`；无 tab 时回退纯 Node 并在报告里标注 `bundleSource:"node-html"` |

**行为**：B 站默认配置下应从 0 条变为 50+ 条候选。

### T2 · 路径归一与 method 修复（精确率）

| 文件 | 改动 |
|---|---|
| `api-command-site-scan.ts` `STRING_LITERAL_RE` | 命中后检查是否为协议相对 URL（`//host/...`），是则取其 pathname 并记录 host，不把 host 当路径 |
| `api-command-site-scan.ts` `SiteScanCandidate` | 新增 `host?: string`；`toPathTemplate` 返回 `{pathTemplate, host}` |
| `api-command-service.ts` / `api-command-generator.ts` | 命令 `urlTemplate` 使用候选自带 host（当 host 与传入 domain 不同时，标记 `crossHost: true` 并在报告 warning 里提示；执行前仍走域名白名单） |
| `api-command-site-scan.ts` `inferMethod()` | 扩展识别：`axios({method:'POST'})`、对象字面量 `method:` 字段、`request.post`、`$.ajax({type:'POST'})`；冲突时取显式声明优先，仍不可判则 GET |

**行为**：B 站 10 条 404 误报中 host 前缀丢失的那批应转为可执行；命中项 method 与真实流量一致。

### T3 · 请求头放开（调用能力）

| 文件 | 改动 |
|---|---|
| `api-command-types.ts` | 新增 `API_COMMAND_FORBIDDEN_HEADERS = ["cookie","authorization","proxy-authorization","set-cookie"]`；`API_COMMAND_ALLOWED_HEADERS` 保留为「最低保证集」不再作上限 |
| `api-command-types.ts` `EXECUTE_OPTIONS_ALLOWED_KEYS` | 增加 `"headers"` |
| `api-command-types.ts` `COMMAND_ALLOWED_KEYS` / `REQUEST_TEMPLATE_ALLOWED_KEYS` | `request` 增加 `headers` 模板 |
| `browser-extension/api-command-helpers.js` | `rebuildExecuteOptions` 接受 `headers`（`Record<string,string>`），按 forbidden 名单剔除；`EXECUTE_OPTIONS_FORBIDDEN_KEYS` 去掉 `"headers"` |
| `browser-extension/background.js` `cmdApiCommandExecute` | 把过滤后的 headers 拼进 `fetch`（`Accept` / `Content-Type` 仍由代码保证） |
| `api-command-render.ts` | 渲染请求头模板：`{{name}}` 占位符 → 调用方 `headers` 入参；字面量 → 命令定义里的值 |
| `api-command-service.ts` `call()` | 新增 `headers?: Record<string,string>` 入参；下发 `options.headers` |

**边界**：`Cookie` / `Authorization` / `Proxy-Authorization` / `Set-Cookie` 一律丢弃（不报错、静默剔除），**不落盘**。

### T4 · 值落盘放开 + 常量参数可覆盖（功能修复）

| 文件 | 改动 |
|---|---|
| `api-command-normalize.ts` | 新增 `isPersistableLiteral(value)`：允许任意标量（string/number/boolean），字符串长度 ≤ `MAX_PERSISTED_VALUE_LENGTH`（200）；`isSafeLiteral` 保留为严格模式开关 |
| `api-command-cache.ts` `rebuildParams` / `rebuildBodyTemplate` / `rebuildQueryTemplate` | 改用 `isPersistableLiteral`；`note` / `description` 同步放开（长度受限） |
| `api-command-generator.ts` `buildBodyTemplate` / `buildQueryTemplate` | **常量参数写成 `{{name}}` 占位符**，把真值放到 `param.defaultValue`；`renderRequest` 优先用调用方传入值，缺省才回落 `defaultValue` |
| `api-command-response-schema.ts` | `RESPONSE_SENSITIVE_FIELDS` 命中不再强制 `[REDACTED]`，改为可配置 `strictRedaction`（默认 false） |

**行为**：调用方传 `nickname:"lisi"` 必须真正发出 `lisi`（当前实测发出 `zhangsan`）。

### T5 · 导出 / 导入闭环 + 来源标注

| 文件 | 改动 |
|---|---|
| `api-command-types.ts` `ApiCommand` | 新增 `source.origin: "capture" \| "scan" \| "spec" \| "manual"`（原 `source.generatedBy` 保留） |
| `api-command-cache.ts` | 新增 `export(domain, opts)`：导出为可审查 JSON（含来源、参数、响应裁剪规则）；`import(domain, payload, opts)`：导入成品格式 |
| `api-command-site-scan.ts` `parseCommandSetText` | 同时接受**成品格式**（`request.urlTemplate` / `risk` / `responseFields` / `manuallyEdited` / `note`）与**线索格式**；成品格式优先，保全字段，不再被降级 |
| `mcp-server/src/server.ts` | 新增 2 个 MCP 工具：`export_api_commands`（`domain` / `path` / `includeDisabled`）、`import_api_commands`（`domain` / `path` / `overwrite`） |

**行为**：A 导出 → B 导入 → 命令条数、名称、参数、响应裁剪规则完整保留且可直接调用。

### T6 · 缓存一致性（跨进程数据丢失）

| 文件 | 改动 |
|---|---|
| `api-command-cache.ts` `persist()` | 写前**重读磁盘文件并按 hostname 合并**（本进程内存 ∪ 磁盘 ∪ 本次变更），再整文件写；tmp 名改唯一（`${file}.${pid}.${ts}.tmp`） |
| `api-command-cache.ts` `ensureLoaded()` | 读失败时置 `loadFailed=true`；`loadFailed` 状态下 `persist()` **只写本次新增的域名**，不覆盖已有内容 |

**行为**：两个进程先后写不同域名，双方数据都在。

### T7 · 破坏性默认值与只读门修正

| 文件 | 改动 |
|---|---|
| `server.ts` + `api-command-service.ts` `invalidate()` | 只认字面量 `"clear_domain"`；其余值（含缺失）一律 `INVALID_PARAMS`，**不再兜底成全域删除** |
| `browser-extension/background.js` `assertCommandAllowed` | 只读门的判定依据从客户端上报的 `options.risk` 改为**按 `options.method` 派生**（GET/HEAD/OPTIONS → read，其余 → write） |

### T8 · ai_search 修正

| 文件 | 改动 |
|---|---|
| `baidu-ai-search.ts` `parseBaiduBaikanSse` | 增量 / 快照判定不再用前缀启发式；改用事件里的显式标记，缺标记时一律按增量追加 |
| `api-command-service.ts` `fetchBaikanSse` | 改 `ReadableStream` 读取，收到 `endTurn` 即停止并返回已收内容；超时按已收内容降级返回 |
| `api-command-service.ts` `aiSearch` | `timeoutMs` 改为**跨通道总预算**（SSE + 兜底 + 重试共享），修掉当前 ~4× 超时放大 |
| `api-command-service.ts` `buildAiSearchResult` | `attempts` 真实计数 |

### T9 · 复合命令（多步编排）—— 排最后

> **语法在 2026-11-05 由用户拍板定案**，与初版设计不同，下表为最终实现。
> 取值路径 = **JSONPath**；依赖声明 = **显式映射表**；复合命令作为**命令集条目落盘**，
> 靠**导入命令包**交付（不新增独立工具）。

| 文件 | 改动 |
|---|---|
| `api-command-types.ts` | `ApiCommand` 新增 `steps?: CommandStep[]`；`CommandStep = { name?, commandId, params?, risk?, note? }`；白名单 `COMMAND_STEP_ALLOWED_KEYS`；上限 `MAX_COMPOSITE_STEPS=5` / `MAX_JSONPATH_LENGTH=256` / `MAX_JSONPATH_SEGMENTS=16`；`ExecuteResult` 新增 `stepResults?` |
| `api-command-render.ts` | 新增 `parseJsonPath` / `evalJsonPath` / `isStepValueMapping` / `resolveCompositeSteps` / `applyStepMappings`（全部纯函数、无 IO） |
| `api-command-cache.ts` | 新增 `rebuildSteps()` / `rebuildStepParams()` / `isPersistableStepValue()`；`toCommand()` 接入 `steps`；`export` / `import` 自动带 steps |
| `api-command-service.ts` | `call()` 走多步编排分支；新增 `callComposite()` / `executeCommandRequest()` / `collectCompositeParams()` / `staticStepParams()` / `filterParamsForCommand()` |
| `server.ts` | `call_api_command` / `import_api_commands` 工具描述补充复合命令说明 |
| `browser-extension/api-command-helpers.js` | `COMMAND_ALLOWED_KEYS` 增加 `'steps'`（两端常量逐字同步） |

**JSONPath 子集（刻意收窄）**：只支持 `$` 根 + `.name` + `["name"]` + `[n]` + `[*]`。
刻意拒绝过滤表达式 `?()`、脚本 `()`、递归下降 `..`、通配属性 `.*`、切片。
`[*]` 恒展开为数组（命中 1 个也是数组）。路径未命中 → `MISSING_PARAMS`。

**取值优先级（定案）**：**映射 > 调用方传值 > 步骤固定值**。
映射覆盖调用方传值时必须记入 `overridden`（留痕），不得静默忽略——
呼应 AC-5「调用方传值被静默忽略」这一原始缺陷。
路径未命中且调用方给了值 → 退化用调用方值；仍无值 → `MISSING_PARAMS`。

**预检 vs 运行时**：

| 情形 | 行为 |
|---|---|
| 子命令缺失 | 预检**零请求**，`COMMAND_NOT_FOUND` |
| 写操作未确认 | 预检**零请求**，`CONFIRMATION_REQUIRED` |
| 步骤静态参数不合法 | 预检**零请求**，`INVALID_PARAMS` / `MISSING_PARAMS` |
| 某步取值路径未命中 | **该步零请求**；前序步骤已执行的事实写入 `warnings[]`，不伪装成「零请求」 |

**风险只升不降**：步骤自述的 `risk:"read"` 不能把子命令的 `write` 降级
（与 T7「只读门按 method 派生、不采信客户端自述 risk」同一纪律）；
扩展侧仍按 HTTP method 独立设门，纵深防御。

**嵌套复合命令不支持**（拒绝并零请求）。

**目的**：把「查列表 → 取 id → 查详情 → 提交」从 Agent 手工串联变成一条命令。

### T13 · 证据分级 + 歧义显式 + coverage 报告

> 借鉴 REA（Reverse Engineer Anything）的**口径**而非代码。不引入 REA 依赖：它需 Node 22+/24+ 与
> Hopper / Ghidra 等本地逆向引擎、manifest 格式私有、其 `Evidence` 格式与本项目不兼容。
> 其二进制 / 应用逆向主体、sticky provider、HAR / SAZ / qlog 解码器、protobuf / gRPC 体解码
> 对本项目均不适用。真正借鉴的是它的一句主张 —— **「缺失的覆盖是未知，不是没有」**：
> 本项目落地为「缺失的响应证据 = `unknown`，不是 `observed`」。

| 文件 | 改动 |
|---|---|
| `api-command-types.ts` | 新增 `COMMAND_TIERS`（`observed`/`derived`/`inferred`/`unknown`）、`COMMAND_TIER_STRENGTH`（3/2/1/0）、`CommandProvenance`（`tier` + `endpoint`/`params`/`response` 三维）、`SCAN_AMBIGUITY_KINDS`（`host`/`baseUrl`/`sourceConflict`）、`ScanAmbiguity`、`AnalysisCoverage`；`SOURCE_ALLOWED_KEYS` 追加 `provenance`，新增 `PROVENANCE_ALLOWED_KEYS`；新增 `SITE_SCAN_DEFAULT_PROVENANCE = true` 与 3 条歧义告警 + 5 条 coverage 提示固定文案 |
| `api-command-evidence.ts`（新建，纯函数层） | `normalizeTier()` / `weakestTier()` / `tierForSourceKind()` / `tierForSourceKinds()` / `tierForOrigin()` / `deriveProvenance()` / `sameSourceKinds()` / `makeAmbiguity()` / `hostAmbiguity()` / `baseUrlAmbiguity()` / `buildCoverage()` / `coverageCountsConsistent()`。无 IO、无 `Date`、无环境变量，`node --test` 可直测 |
| `api-command-site-scan.ts` | `applyHostCrossReference()` 改返回 `{ inferred, ambiguities }`；`parseHarText()` 统计同路径跨 origin 并记 `observedHosts`；`scanSources()` 同键候选**合并**（来源种类并集 + 参数名并集）而非首胜丢弃，并产出三类歧义；`toScanRecords()` 透传 `sourceKinds` |
| `api-command-normalize.ts` | `groupEndpoints()` 取 `sourceKinds` 并集 |
| `api-command-generator.ts` | `generateCommands()` 新增 `ctx.provenance` 开关，把 `deriveProvenance()` 结果写入 `source.provenance` |
| `api-command-cache.ts` | `rebuildSource()` 新增 `rebuildProvenance()`：逐字段重建，缺失或非法时**整体省略、不臆造档位** |
| `api-command-service.ts` | 抓包通道与 scan 通道都接 `provenance` 三态开关；两条通道都输出 `report.coverage`；歧义按类推送对应 warning |
| `api-command-args.ts` | `TRI_STATE_BOOLEANS` 追加 `provenance`（三态，undefined 原样透传） |
| `server.ts` | `analyze_page_apis` inputSchema 新增 `provenance` 布尔项（默认 true，置 false 完全回退） |
| `browser-extension/api-command-helpers.js` | `SOURCE_ALLOWED_KEYS` 追加 `provenance`；新增 `PROVENANCE_ALLOWED_KEYS` 与 `COMMAND_TIERS`（两端常量逐字同步） |

**档位映射（口径）**：

| 证据来源 | 端点档位 |
|---|---|
| 抓包实测（capture） | `observed` |
| 规格声明（OpenAPI / 声明式命令包） | `derived` |
| 人工命令（manual） | `derived` |
| 静态扫描 + JS bundle | `inferred` |
| 静态扫描 + HAR 归档流量 | `observed` |
| 无来源 | `unknown` |

- **总档位取三维最弱**：端点再确定、响应靠猜，整条命令仍不可信。
- **多来源合并取最强档**：同一端点既在 HAR 又在 bundle 里，bundle 的弱证据不构成对端点身份的否定。
- **响应维度恒定**：有样本才 `observed`，否则恒 `unknown`。
- **`byDimension` 拆分的原因**：静态推导的响应档位恒 `unknown`，只看 `byTier` 会被这一维拉平成全 `unknown`、失去区分度；拆成三维后才能看出「端点其实有证据，只是响应结构没观测到」。

**歧义三类（全部「不猜」，只记录）**：

| 类别 | 判据 |
|---|---|
| `host` | 同一路径在多个 host 上有证据（含 HAR 同路径跨多个 origin） |
| `baseUrl` | 客户端配置的 baseURL 有多个候选 |
| `sourceConflict` | 同一 `(method, pathTemplate)` 被不同来源归到**不同的真实 host** |

> `sourceConflict` 的判据经过一次修正：初版按「参数集不同」判冲突 —— 实测 HAR 只记某次请求的参数、
> OpenAPI 声明的是全量，两者天然不同，会被误报。**参数集不同 ≠ 证据矛盾**，已改为按真实 host 分歧判定。

**行为**：命令带 `source.provenance`（端点 / 参数 / 响应三维档位 + 总档位），报告带 `coverage` 段
（`endpointCount` / `commandCount` / `byTier` / `byDimension` / `verifiedCount` / `ambiguities` / `nextHints`）。
`provenance=false` 时命令不带该字段、报告不带 `coverage` 段，**产物形状与旧版完全一致**。

---

## 5. Tasks（执行顺序）

| # | 任务 | 依赖 | 落点 | commit | 状态 |
|---|---|---|---|---|---|
| 1 | T1 静态推导放开 | — | `api-command-types.ts` / `api-command-service.ts` / `api-command-site-scan.ts` | `c60be17` | ✅ |
| 2 | T2 路径归一 + method 修复 | — | `api-command-site-scan.ts` / `api-command-generator.ts` | `660eb45` | ✅ |
| 3 | T4 值落盘放开 + 常量参数可覆盖 | — | `api-command-normalize.ts` / `api-command-cache.ts` / `api-command-generator.ts` / `api-command-render.ts` / `api-command-response-schema.ts` | `7b14d7c` | ✅ |
| 4 | T3 请求头放开 | 3 | `api-command-types.ts` / `api-command-render.ts` / `api-command-service.ts` / `api-command-helpers.js` / `background.js` | `9628be5` | ✅ |
| 5 | T5 导出 / 导入闭环 + 来源标注 | 1,2,3 | `api-command-types.ts` / `api-command-cache.ts` / `api-command-site-scan.ts` / `server.ts` | `e27a872` | ✅ |
| 6 | T6 缓存一致性 | — | `api-command-cache.ts` | `5276030` | ✅ |
| 7 | T7 破坏性默认值 + 只读门按 method 派生 | 4 | `server.ts` / `api-command-service.ts` / `background.js` | `38e6085` | ✅ |
| 8 | T8 ai_search 修正 | — | `baidu-ai-search.ts` / `api-command-service.ts` | `4c44d8f` + `06a2ff0` | ✅ |
| 9 | T9 复合命令 | 1..7 | `api-command-types.ts` / `api-command-render.ts` / `api-command-cache.ts` / `api-command-service.ts` / `server.ts` / `api-command-helpers.js` | `ed52b71` | ✅ |
| 10 | T10a host 交叉引用 + baseURL 侦测 | 1,2 | `api-command-site-scan.ts` / `api-command-types.ts` | `982413e` | ✅ |
| 11 | T10b README 中英同步 | 1..10 | `README.md` / `README.zh.md` | `78ae4ac` | ✅ |
| 12 | T10c 规格回填（AC↔实现位置映射） | 1..11 | `docs/api-command-set-upgrade-spec.md` | 本次提交 | ✅ |
| 13 | T11 代码审查缺陷修复（占位 baseURL / 变量绑定首匹配 / 取值留痕信号混用） | 9,10 | `api-command-site-scan.ts` / `api-command-render.ts` / `api-command-service.ts` / `api-command-types.ts` | `cd4c78a` | ✅ |
| 14 | T12 传输层布尔强转修复（未传开关被压成 false） | 1..11 | `api-command-args.ts` / `server.ts` / `api-command-service.ts` | `171d327` | ✅ |
| 15 | T13 证据分级 + 歧义显式 + coverage 报告（借鉴 REA 证据口径） | 1..14 | `api-command-types.ts` / `api-command-evidence.ts` / `api-command-site-scan.ts` / `api-command-normalize.ts` / `api-command-generator.ts` / `api-command-cache.ts` / `api-command-service.ts` / `api-command-args.ts` / `server.ts` / `api-command-helpers.js` | 本次提交 | ✅ |

**用例规模**：存量 245 条零回归 → 终态 **354 条全绿**（新增 109 条：T1–T10 累计 64 条 + T11 审查回归 8 条 + T12 传输层修复回归 9 条 + T13 证据分级回归 28 条）。

新增用例分布：`api-command-composite.test.mjs` 19（T9）、`api-command-host-infer.test.mjs` 9（T10a）、
`api-command-evidence.test.mjs` 28（T13）、`api-command-types.test.mjs` 常量契约 1、其余分散补入既有测试文件。

**每个任务附带**：至少 1 条新增用例（`node --test`，`dist/` 上跑），存量 245 条零回归。

---

## 6. 验收

| # | 验收项 | 口径 | 实现位置 | 实测结果 |
|---|---|---|---|---|
| A1 | 规格驱动路径命中 | petstore OpenAPI：19 个端点路径命中 19/19，0 未命中 | `api-command-site-scan.ts` `parseOpenApiText` / `scanSources` | 19/19 ✅ |
| A2 | 静态推导召回 | B 站首页默认配置（放开后）：召回 ≥ 50%（基线 0%） | `api-command-service.ts:1064` `loose` → `api-command-site-scan.ts:753` `scanSources` → `:705` `applyHostCrossReference` → `:228` `detectBaseUrlHosts` | **100%**（35/35，loose=false 旧默认 0%）✅ |
| A3 | 静态推导存活 | B 站首页：实打存活率 ≥ 50%（基线 55%，修复后应更高） | 同 A2（同一批扫描口径） | **68.6%**（24/35，与 oracle 自身上限 68.6% 持平）✅ |
| A4 | 免开网页调用 | 全新会话 + 页面未开 + 无抓包缓冲区，成功率 ≥ 90% | `api-command-service.ts` `call` → `executeCommandRequest` → 扩展 `background.js:2194` `cmdApiCommandExecute` | ✅ 见下方「A4 实测记录」 |
| A5 | 导出导入闭环 | 导出 → 清空 → 导入 → 命令条数 / 名称 / 参数 / 响应裁剪规则一致，可直接调用 | `api-command-cache.ts:1145` `export` / `:1192` `import` / `:742` `rewriteCommandHost`；`api-command-service.ts:1359` / `:1371`；`server.ts:994` / `:1007` | 闭环一致，复合命令随包往返 ✅ |
| A6 | 并发写 | 两个进程先后写不同域名，双方数据都存活 | `api-command-cache.ts:79` `buildCacheTmpName` / `ensureLoaded` / `persist`（写前重读合并） | 双方数据都存活 ✅ |
| A7 | 参数可覆盖 | 调用方传值必须生效（当前实测被忽略） | `api-command-normalize.ts:656` `param.defaultValue` / `api-command-generator.ts:182` `buildQueryTemplate` / `:195` `buildBodyTemplate`；`api-command-render.ts:145` `renderRequest`；`api-command-service.ts:1784` `filterParamsForCommand` | 调用方传值生效 ✅ |
| A8 | 测试 | `npm test` 全绿（存量 245 零回归 + 新增用例），`npm run doctor` 0 fail | `mcp-server/test/*` | **354/354 pass**（存量 245 零回归 + 新增 109）；`doctor` 5 pass / 0 warn / 0 fail ✅ |
| A9 | 文档 | README 中英工具表 + `docs/` 与实现一致 | `README.md` / `README.zh.md` / `docs/api-command-set-upgrade-spec.md` | 中英 19 节同构、工具表各 44 条完全一致 ✅ |
| A10 | 证据分级 + 歧义显式 + coverage 报告（T13） | 每条命令按 `observed`/`derived`/`inferred`/`unknown` 标注证据档位（端点 / 参数 / 响应三维分别判定，总档位取最弱）；多解证据显式列为歧义而不猜；报告输出 `coverage` 段且各档计数自洽；`provenance=false` 时产物形状与旧版完全一致 | `api-command-types.ts:645` `COMMAND_TIERS` / `:662` `CommandProvenance` / `:674` `SCAN_AMBIGUITY_KINDS` / `:699` `AnalysisCoverage` / `:1091` `SITE_SCAN_DEFAULT_PROVENANCE`；`api-command-evidence.ts:146` `deriveProvenance()` / `:184` `makeAmbiguity()` / `:240` `buildCoverage()`；`api-command-site-scan.ts:753` `scanSources()`；`api-command-service.ts:1177` / `:1314` `report.coverage`；`api-command-args.ts:37` `TRI_STATE_BOOLEANS`；`server.ts:988` inputSchema | live 实测：三源 → `endpointCount=3 / commandCount=3`，`byDimension.endpoint={observed:1, inferred:2}`、`byDimension.response` 全 `unknown`、`verifiedCount=0`、`ambiguities=[]`、3 条 nextHints；负向对照 `provenance=false` → 无 `coverage` 段；真实 B 站 bundle 复测召回未回退（113 候选 / 48 个归属 `api.bilibili.com`）并检出 1 条真阳性歧义 ✅ |

**A2 / A3 实测口径（重要，不可沿用旧口径）**：

- oracle 的裸路径 host 由**实际探测**确定（逐个 GET 候选 host，取返回 2xx 且 content-type 含 json 的那个），
  **不得**默认记成扫描目标域名。
- 早期口径把裸路径记成 `www.bilibili.com`，与静态推导犯同样的错，导致召回虚高 100% / 存活只有 7%，**已废弃**。
- 静态推导口径 = 所有 bundle **一次 `scanSources()` 调用**（与服务一致，跨源交叉引用与 baseURL 侦测需要同批作用域）。
- 存活判定 = 2xx 且响应体以 `{` / `[` 开头且不含 `"code": -404/-400/-403`；请求带 UA + `referer: https://www.bilibili.com/`。
- 产出物：`test-artifacts/t10-bilibili-recall.json`（8 bundle / 3.96 MB / oracle 35 条）。

**A2 / A3 的根因与修复**：bundle 里接口路径绝大多数是**裸相对路径**，主机藏在两处——
协议相对 URL（全文仅 2 条）与 HTTP 客户端 **baseURL**（`baseURL: !s && n.baseURL || a`，`a = "//api.bilibili.com"`）。
裸路径若挂到扫描目标域名必然 404（实测 `www.bilibili.com/x/web-interface/nav` → 404，
`api.bilibili.com/x/web-interface/nav` → 200）。修复放在编排层 `scanSources()`（纯函数、批次作用域），
**只在唯一解时生效，有歧义一律不猜**；解析层 `scanJsText` 不猜 host，保持语义纯净。

**A4 实测记录（免开网页调用）**：

| 断言 | 位置 | 结果 |
|---|---|---|
| 抓包缓冲区为空（`networkCaptures.size === 0`） | `test/api-command-security.test.mjs:208` A.1 | ✅ |
| 未打开任何标签页（`mock.tabs.size === 0`） | 同上 | ✅ |
| `apiCommandExecute` 不在 `TAB_SCOPED_COMMANDS`（不依赖 tab） | 同上 | ✅ |
| 仍真正走到 `fetch`（`fetchCalls.length === 1`，URL / method 正确） | 同上 | ✅ |
| 执行全程不创建抓包会话（执行后 `networkCaptures.size` 仍为 0） | 同上 | ✅ |
| 响应正常回传（`success:true` / `status:200` / `authRequired:false`） | 同上 | ✅ |
| `fetch` 带 `credentials:'include'` 与 `redirect:'manual'` | `test/api-command-security.test.mjs:228` A.2 | ✅ |
| 放开后：非凭据请求头原样下发，凭据头（Cookie / Authorization 等）一律剔除 | `test/api-command-security.test.mjs:279` A.3b | ✅ |
| 只读模式不可绕过：`risk=write` + `confirm:true` 仍 `READ_ONLY_BLOCKED`，fetch 0 次 | `test/api-command-security.test.mjs:311` A.4 | ✅ |
| 只读门按 method 派生：`risk=read` 但 `method=POST` 仍被拒 | `test/api-command-security.test.mjs:329` T7 | ✅ |

调用链：MCP `call_api_command` → `api-command-service.ts` `call` → `executeCommandRequest` →
扩展 `background.js` `cmdApiCommandExecute` → `fetch(credentials:'include')`。
全程不打开页面、不 attach debugger、不需要抓包缓冲区；Cookie 由 Chrome 自身按最终 URL 匹配。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 放开后 `api-commands.json` 含真实业务值 | 已由用户拍板接受；所有放开项均可通过开关回退为保守模式 |
| 请求头放开可能被用于跨站伪造 | 目标 URL 校验 + 域名白名单 + 紧急停止三项硬边界不变；`Cookie`/`Authorization` 永不透传 |
| 缓存读改写引入新的竞争 | 合并按 hostname 粒度，单域名仍 last-writer-wins（可接受：同名域名多人协作属边缘场景） |
| 改动面大（跨 MCP 侧与扩展侧） | 按 Tasks 顺序分批，每批独立可测；每批一个 commit，便于逐批回滚 |

**回滚方式**：每个放开项一个开关 → 改开关即回退；整体回滚 → `git revert` 对应 commit。

---

## 8. 不做（本需求明确排除）

- CAPTCHA / SSO / 二次验证自动化
- 无上限自主循环、并发写操作
- 任意 JS 执行能力（`execute_js` 保持禁用）
- 把命令集写入 `definitions/` 随包分发（导出文件由使用者自行决定是否分发）
