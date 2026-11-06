# T14 真实站点复刻报告：Confluence（应用上下文路径）

> 目标站点：`https://confluence.example.com/confluence/#all-updates`（已登录态）
> 复刻目标：用 WebPilot 的「网站 → API 命令集」链路，扫出 Confluence 的真实接口命令集，并**实测调用**验证可用。
> 结论：首轮复刻暴露 **1 个主缺陷 + 3 个次缺陷**，本轮全部修复并复测通过。

本报告是 T14 的实测留证，与 `specs/tasks.md` 的 T14 条目、`docs/api-command-set-upgrade-spec.md` 的
T14 设计段、`test-artifacts/t14-bilibili-recall.json` 的回归数据配套阅读。

---

## 一、复刻过程与实测数据

### 1.1 首轮扫描：命令集「能生成，但打不通」

| 项 | 值 |
|---|---|
| 分析 ID | `an_scan_1793943661288` |
| `contextPath` | `""`（**取不到应用上下文前缀**） |
| 端点数 | 69 |
| 告警 | 「部分静态推导端点为『相对应用上下文路径』但未能取到上下文前缀……」 |

首轮就出现了「扫得到、调不通」的现象：bundle 里静态推导出的路径形如
`/rest/webResources/1.0/resources`，但 Confluence 真实部署在 `/confluence` 下，
真实接口是 `/confluence/rest/webResources/1.0/resources`。

**实测对照（同一批命令，修前缀前后各跑一次）**：

| 形态 | 请求 | 实测结果 |
|---|---|---|
| 修复前（裸路径） | `GET /rest/webResources/1.0/resources` | **Tomcat 原始 404 页** —— 请求根本没进 Confluence 的 REST servlet |
| 修复后（带前缀） | `GET /confluence/rest/webResources/1.0/resources` | 到达应用，返回 **Confluence 自己的 404 / 405** |

即：修复前命令打到了「错误的地址空间」，修复后请求被正确路由到应用（剩下的是参数/方法层面的
业务错误）。**这与已修的 D-2（OpenAPI `basePath` 丢失）是同一类缺陷**：
OpenAPI 侧的口径是「规格里的 paths 相对 `servers`」，JS 侧的等价物是「bundle 里的路径相对
应用上下文路径」—— 之前 JS 侧根本没有这个概念。

### 1.2 修复后扫描：上下文前缀补齐

| 项 | 值 |
|---|---|
| 分析 ID | `an_scan_1793943765310` |
| `bundleSource` | `extension`（扩展侧采到 bundle） |
| `contextPath` | `/confluence` |
| 端点数 / 命令数 | 68 / 68 |
| 合并 diff | `added: 39`、`updated: 29`、`skipped: 40` |
| 告警 | 「已识别应用上下文路径并补到相对路径前」+「已丢弃部分无请求上下文的路径字面量」 |

### 1.3 抓包通道与合并（次缺陷 F3）

| 项 | 值 |
|---|---|
| 抓包分析 ID | `an_20261106054449226_001` |
| 抓包端点 / 命令 | 14 / 14 |
| `sampledResponseCount` | 20 |
| 合并后缓存总量 | **120** 条（scan 106 + capture 14） |

逐条与扫描报告快照比对的结果：

- **66 条**仍为 scan 来源；
- **2 条**被 capture 同化并**提档**（`/confluence/rest/webResources/1.0/resources` 三维全 `observed`；
  `/confluence/plugins/editor-loader/editor.action` 端点/参数 `observed`、响应 `unknown`）；
- **0 条丢失**，`diff.updated = 2`。

> F3（scan / capture 重复端点）**不需要独立实现**：前缀补齐后 `pathTemplate` 一致，
> `commandId`（`sha256(host\0method\0pathTemplate)`）自然自对齐，合并时自动合并并提档。

### 1.4 覆盖率口径（次缺陷 F2）

抓包报告的 `coverage` 实测值：

```json
{
  "scope": "domain",
  "batchCommandCount": 14,
  "commandCount": 120,
  "endpointCount": 120,
  "byTier": { "observed": 9, "unknown": 111 },
  "verifiedCount": 9,
  "denominator": 120,
  "coverageRate": 0.075,
  "dimensionRates": { "endpoint": 0.117, "params": 0.117, "response": 0.075 }
}
```

**旧口径的问题**：分母取的是「本次批次命令数」（14 条里 10 条有响应样本 → 10/54 ≈ 19%），
却被显示成 **71%**（把域名级已验证数放在批次级分母上）。修复后覆盖率是**域名级真值**：
该域缓存里 120 条命令中 9 条三维可验证 → 7.5%。`scope` 字段显式说明口径，
`batchCommandCount` 保留批次信息以便对照。scan 与 capture 两条通道口径统一。

### 1.5 调用闭环（免开网页实调）

取「scan 来源 + 带 `/confluence` 前缀 + GET + risk=read」的 **33 条**命令逐条实调：

| 结果 | 条数 |
|---|---|
| **200 命中** | **12** |
| 404 | 14 |
| 405 | 3 |
| 400 | 1 |
| `REDIRECT_BLOCKED` | 2 |
| `MISSING_PARAMS` | 1 |

命中的 12 条（即「静态推导 + 上下文前缀」这一路径**确实可调用**）：

| 命令名 | 路径 |
|---|---|
| `get.profile.editmyprofilepicture` | `/confluence/users/profile/editmyprofilepicture.action` |
| `get.pages.createpage` | `/confluence/pages/createpage.action?spacekey={{spacekey}}` |
| `get.storage.quick-create` | `/confluence/rest/create-dialog/1.0/storage/quick-create` |
| `get.1.0.spaces` | `/confluence/rest/create-dialog/1.0/spaces` |
| `get.pages.createpage-entervariables` | `/confluence/pages/createpage-entervariables.action?templateid={{templateid}}` |
| `get.ajax.spaceavailable` | `/confluence/ajax/spaceavailable.action` |
| `get.latest.enabled` | `/confluence/rest/confluenceshortcuts/latest/enabled` |
| `get.latest.admin` | `/confluence/rest/menu/latest/admin` |
| `get.1.0.spacesmenu` | `/confluence/rest/ia/1.0/spacesmenu` |
| `get.latest.appswitcher` | `/confluence/rest/menu/latest/appswitcher` |
| `get.applinks.listapplicationlinks` | `/confluence/plugins/servlet/applinks/listApplicationLinks` |
| `get.inlinetasks.mytasks` | `/confluence/plugins/inlinetasks/mytasks.action` |

> 其余 21 条不是「命令生成错」，而是**真实接口对参数/方法/重定向的要求**（缺参、只允许 POST、
> 触发跳转）—— 这恰恰说明命令打到的是**正确的应用**，而不是打不通的地址空间。

---

## 二、缺陷与修复

### 2.1 主缺陷：静态推导丢失「应用上下文路径」

**根因**：`api-command-site-scan.ts` 的 JS 来源路径解析里，没有「路径相对应用上下文」的概念。
bundle 里普遍写成「上下文前缀 + 相对路径」：

```js
AJS.contextPath() + "/rest/webResources/1.0/resources"
f.CONTEXT_PATH + "/json/pagechildren.action"
AJS.Confluence.getContextPath() + "/ajax/spaceavailable.action"
"".concat(n, "//").concat(v.Z.apiHost, "/x/web-frontend/getbuvid")   // 字面量拼接形态
```

**修复机制**（两侧配合，缺一不可）：

| 侧 | 做什么 | 落点 |
|---|---|---|
| 静态侧 | 识别「相对 context 的路径」，标记 `relativeToContext` | `api-command-site-scan.ts:406` `CONTEXT_PATH_TOKEN_RE`、`:414` `LITERAL_PREFIX_RE`、`:529` `scanJsTextDetailed()` |
| 静态侧 | 拿到前缀后统一补齐 | `api-command-site-scan.ts:487` `applyContextPath()`、`:1177` `scanSources()` 接线 |
| 扩展侧 | 在**页面上下文**里取值 | `browser-extension/background.js:2088` `apiDetectContextPathInPage()`、`:2133` `apiDetectContextPath()` |
| 编排侧 | 回包校验 + 报告输出 | `api-command-service.ts:928` `normalizeContextPath(reply.contextPath)`、`:1130` `report.contextPath` |

**扩展侧取值优先级**（自包含，页面上下文注入函数，逐级回退）：
`AJS.contextPath()` → `AJS.Confluence.getContextPath()` → `window.contextPath` →
`meta[name="ajs-context-path"|"context-path"]`。

**取值的安全约束**（三条，缺一不可）：

1. 页面 origin 必须**精确命中**本次扫描的允许域名集合，否则返回空串（跨站页面取到的前缀无意义）；
2. 前缀必须能通过 `normalizeContextPath()`（`/confluence`、`confluence` → `/confluence`；
   根路径 → 空串；长度 ≤ `API_CONTEXT_PATH_MAX_LENGTH = 128`；拒绝含 `?` `#` `//` `..` `\` 空白与引号）；
3. 回包里的 `contextPath` 在 MCP 侧**再校验一次**（不信任扩展侧回包）。

**两种结局都必须显式告警**（不静默放过）：

- 补上了 → `SITE_SCAN_CONTEXT_PATH_APPLIED_WARNING`；
- 没补上 → `SITE_SCAN_CONTEXT_PATH_MISSING_WARNING`（命令可能因缺前缀而 404，可带 `tabId` 重跑）。

### 2.2 次缺陷 F2：覆盖率口径（批次级 → 域名级）

见 §1.4。落点：`api-command-evidence.ts:238` `scope` / `:240` `batchCommandCount` /
`:298` `buildCoverage()`；`api-command-service.ts:1263`（scan 通道）与 `:1419`（抓包通道）两条通道统一。

### 2.3 次缺陷 F3：scan / capture 重复端点

见 §1.3。**不需要独立机制**：前缀对齐 → `pathTemplate` 一致 → `commandId` 自对齐 → 合并提档。

### 2.4 次缺陷 F4：噪音路径误报

首轮扫描里混进了普通字符串常量与注释里的路径：`/a/i`、`/a/b`、
`/includes/soy/{dialog,manage-watchers,...}.soy`、`/images/icons/emoticons`。

**过滤规则（双重保险）**：形状像噪音 **且** 不在任何请求上下文里才丢 —— 只要有一方说它像接口就保留，
避免「上下文没识别出来」导致误伤真接口。

- 形状判定：静态资源后缀（含新增 `.soy` / `.less` / `.xhtml` / `.vm`）、静态资源首段集
  （`images` / `image` / `icons` / `icon` / `includes` / `stylesheets` / `themes` / `fonts`，
  **刻意不含 `download`** —— Confluence 的 `/download/resources` 是真接口）、`^\/[a-z]\/[a-z]$`；
- 请求上下文判定：url 类字段赋值（`url` / `href` / `path` / `endpoint` / `api` / `action`）
  或请求调用点（`fetch(` / `ajax(` / `.get(` / `axios(` …）。

落点：`api-command-site-scan.ts:469` `isNoisePath()`、`:427` `STATIC_RESOURCE_SEGMENTS`、
`:432` `NOISE_TWO_LETTER_RE`；告警 `SITE_SCAN_NOISE_PATH_WARNING`。

---

## 三、回归验证

### 3.1 用例

- 新增 `mcp-server/test/api-command-context-path.test.mjs` **17 条**：`normalizeContextPath` 边界、
  `isNoisePath` 双重保险、`applyContextPath`、`scanJsTextDetailed` 三类 context 写法 + 字面量拼接 +
  噪音丢弃、`scanSources` 补前缀 / 缺前缀告警、扩展常量 parity、`normalizeApiContextPath` 与
  MCP 侧逐项对拍、`apiDetectContextPathInPage` 三级取值、`cmdApiBundleCollect` 回包 / 跨站拒绝 /
  非法前缀丢弃、coverage 口径字段、告警文案不回显前缀。
- `npm run build` tsc **零诊断**；`npm test` **全绿**；`npm run doctor` 5 pass / 3 info / 0 warn / 0 fail。

### 3.2 B 站真实站点召回回归（`test-artifacts/t14-bilibili-recall.json`）

**口径修订（重要）**：T10 脚本用的是**逐 bundle 累加**（每个 bundle 单独扫再合并计数）；
现行口径是**整批扫描**（所有 bundle 作为同一批交给 `scanSources()`，与 `scan_site` 工具实际行为一致，
T11 起「host 在同一批扫描内解析」）。两个口径都记进了产物。

| 口径 | HEAD(T13) | T14 | 结论 |
|---|---|---|---|
| 整批 · loose=true | 140 候选 / 133 unique / **35 hit / recall 1.0** | 139 候选 / 132 unique / **35 hit / recall 1.0** | **召回未回退**（候选 -1，见下） |
| 整批 · loose=false | 9 / 9 / 0 hit | 9 / 9 / 0 hit | 与基线一致 |
| 逐 bundle · loose=true | 237 / 133 / 32 hit | 236 / 132 / 32 hit | **两者完全一致 → 非 T14 引入** |

- 候选少的那 1 条是 `/a/i` —— 正是 F4 要丢的噪音形态（HEAD 保留、T14 丢弃），**没有误伤真接口**。
- 逐 bundle 口径下丢的 3 条（`/x/web-frontend/getbuvid`、`/x/frontend/finger/spi`、
  `/x/frontend/finger/spi_v2`）是因为它们的真实 host（`api.bilibili.com`）只在**别的 bundle** 里有证据
  （`log-reporter.js` 里的 `apiHost:"api.bilibili.com"`），逐 bundle 扫时无法跨 bundle 汇聚 ——
  HEAD(T13) 与 T14 **同样**丢这 3 条，属于 T11 起 host 归属口径变化的必然结果，不是 T14 的回归。
- 实打存活（对命中 oracle 的条目逐条真实请求）：**35 试 / 24 活 / 68.57%**，与 T10 基线（24/35）持平，
  且与 oracle 自身上限一致。

### 3.3 三项本地硬边界

域名白名单、紧急停止、目标 URL 校验（协议 + hostname 精确相等 + 不跟随跳转）**一行未改**。
新增的 context path 取值额外受「页面 origin 必须精确命中允许域名集合」约束。

---

## 四、遗留与观察

1. **命令名重名**：命令名由路径派生，补前缀后 `/rest/...` 与 `/confluence/rest/...` 会派生出同名命令
   （如 `get.latest.shortcuts`）。缓存里旧的「无前缀」条目仍是 stale 状态，重扫后会被带前缀版本取代，
   但历史条目不会自动消失。下一步可考虑按 `commandId` 做同端点收敛。
2. **扩展无法自动重载**：`chrome.debugger` 对 `chrome://` 页面报 `Cannot access a chrome:// URL`，
   扩展自身也拦截了对 `chrome://extensions/` 的 evaluate —— 本轮扩展重载由人工在
   `chrome://extensions` 完成。
3. **宿主 MCP 进程未重启**：live 复测用独立 stdio 直连进程跑新构建的 `dist/server.js`
   （`WEBPILOT_SESSION_ID` 对齐标签组），宿主进程仍是旧代码。
4. **复合命令**（T9）本轮未纳入复刻验证，按既定排期排在最后。
