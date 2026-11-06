# 本仓证据模型：档位、歧义、覆盖口径

本文件是**判定表**。写判定逻辑前先查这里，避免同一语义在两处被写成两套口径。

实现位置（`F:\mycode\mcp-servers\webdoc\mcp-server\src\`）：
纯函数层 `api-command-evidence.ts`（无 IO、无 `Date`、无环境变量，可 `node --test` 直测）
契约层 `api-command-types.ts`（只含类型与常量）

---

## 1. 四档语义

`api-command-types.ts`：`COMMAND_TIERS = ["observed","derived","inferred","unknown"]`
强度表 `COMMAND_TIER_STRENGTH`：observed=3 / derived=2 / inferred=1 / unknown=0。

| 档位 | 含义 | 典型来源 |
| --- | --- | --- |
| `observed` | 该维度的事实被**真实观测**到 | HAR 归档流量、真实抓包 |
| `derived` | 由**权威声明**推导，但未经机器验证 | OpenAPI 规格、声明式命令包、人工录入 |
| `inferred` | 由**非权威信号**推断，可能来自注释/死代码/实验分支 | 前端 bundle 里的路径字面量 |
| `unknown` | 没有任何证据支撑 | 无来源、字段缺失 |

档位只反映**证据强度**，不反映 risk / 可执行性。风险（`classifyRisk()`）是独立判定。

## 2. 来源 → 档位映射

静态推导来源种类（`api-command-types.ts` 的 `SITE_SCAN_KINDS`）→ 端点档位，
实现在 `api-command-evidence.ts` 的 `SCAN_KIND_TIER` / `tierForSourceKind()`：

| 来源种类 | 端点档位 | 理由 |
| --- | --- | --- |
| `har` | `observed` | HAR 是真实流量归档，端点确实被调用过 |
| `openapi` | `derived` | 权威声明 |
| `commands` | `derived` | 权威声明 |
| `js` | `inferred` | bundle 字符串字面量，可能来自注释/死代码 |

通道来源（`COMMAND_SOURCE_ORIGINS`）→ 档位，`tierForOrigin()`：

| 通道 | 档位 |
| --- | --- |
| `capture` | `observed` |
| `manual` | `derived` |
| `spec` | `derived` |
| `scan` | 取决于具体来源种类；无种类时 `unknown` |

**多来源合并取最强**（`tierForSourceKinds()`）：同一端点若既在 HAR 又在 bundle，
端点身份是被观测到的，bundle 的弱证据不构成对端点的否定。

## 3. 三维判定

`deriveProvenance()`（`api-command-evidence.ts`）产出 `CommandProvenance`
（`api-command-types.ts`）：`{ tier, endpoint, params, response }`。

- `endpoint` = 来源种类/通道决定；
- `params` = 静态推导按来源种类；抓包通道 `hasObservedParams=true` 时为 `observed`；
- `response` = **仅当 `hasResponseSample === true` 才是 `observed`，否则恒 `unknown`**；
- `tier` = `weakestTier([endpoint, params, response])`（三维最弱档）。

两条容易搞混的规则，务必分清：

- 同维度跨来源合并 → **取最强**（`tierForSourceKinds`）；
- 跨维度定总档位 → **取最弱**（`weakestTier`）。

## 4. 歧义三类

`api-command-types.ts`：`SCAN_AMBIGUITY_KINDS = ["host","baseUrl","sourceConflict"]`
结构 `ScanAmbiguity`：`{ kind, pathTemplate?, candidates, candidateCount }`。

| kind | 触发 | 构造函数 |
| --- | --- | --- |
| `host` | 同一 pathTemplate 出现多个 host 证据 | `hostAmbiguity(pathTemplate, hosts)` |
| `baseUrl` | 前端客户端配置了多个 baseURL 候选 | `baseUrlAmbiguity(hosts)` |
| `sourceConflict` | 同一 (method, pathTemplate) 被不同来源归到**不同的真实 host** | `scanSources()` 内构造 |

**不猜**：三类歧义都只记录候选，绝不挑一个当真值。

### sourceConflict 的判据陷阱

判据必须是「归属 host 是否相同」，**不能**是「参数集是否相同」。

原因：HAR 只记某次请求的实际参数，OpenAPI 声明全量参数，两者天然不同。
按参数集判会把正常的多来源覆盖误报成矛盾——这是本仓真实踩过的坑（初版过噪，
live 实测才发现；收窄判据后 B 站 `/x/web-interface/nav` 仍命中真阳性：
候选 `api.bilibili.com` 与 `main-api.biligame.com`）。

### host 归属的独立字段

HAR 观测到的真实 origin 记在独立的 `observedHosts` 字段（仅跨 origin 时出现），
**不**用来改变命令的 host 归属。理由：把第三方 origin 变成新命令会扩大跨 host 攻击面。
跨 origin 这一信号由 `host` 歧义承载。

## 5. coverage 口径

`buildCoverage()`（`api-command-evidence.ts`）产出 `AnalysisCoverage`
（`api-command-types.ts`）。

| 字段 | 含义 |
| --- | --- |
| `scope` | `"domain"`（该域名全量命令集）/ `"batch"`（仅本次批次）。缺省 `batch` |
| `batchCommandCount` | 本次批次的命令数 |
| `endpointCount` | 本次产出的端点数 |
| `commandCount` | 统计口径内的命令数 |
| `byTier` | 按总档位计数，**各档之和恒等于 `commandCount`** |
| `byDimension` | `{endpoint, params, response}` 三维分别计数 |
| `verifiedCount` | 响应已验证（response 档位为 `observed`）的命令数 |
| `ambiguities` | 歧义清单 |
| `nextHints` | 由计数触发的下一步提示 |

自检：`coverageCountsConsistent()` 校验 `byTier` 之和 == `commandCount`。

### 为什么必须拆 byDimension

静态推导的响应档位恒 `unknown`。只看 `byTier` 会被这一维拉平成全 `unknown`，
完全看不出「端点其实有观测证据，只是响应没观测到」。三维拆开后才有区分度。

### 为什么必须标 scope

实测（Confluence 复刻）：批次口径显示 observed=10 / unknown=4（看着像 71% 覆盖），
域名缓存实为 54 条（真实 10/54 ≈ 19%）。**给出覆盖率必须同时给 scope**。

### nextHints 文案纪律

- 每条固定文案只出现一次（去重）；
- 触发条件是**计数**，不是具体条目；
- **不得回显 host、路径、样本值**——文案与样本数据必须分离。

固定文案常量在 `api-command-types.ts`：`COVERAGE_HINT_MISSING_RESPONSE` /
`COVERAGE_HINT_INFERRED` / `COVERAGE_HINT_DERIVED` / `COVERAGE_HINT_AMBIGUOUS` /
`COVERAGE_HINT_UNVERIFIED`。
歧义告警文案：`AMBIGUITY_HOST_WARNING` / `AMBIGUITY_BASE_URL_WARNING` /
`AMBIGUITY_SOURCE_CONFLICT_WARNING`——同样只给条数，不回显 host/路径。

## 6. 开关三态

`provenance` 开关：

- 未传 → `SITE_SCAN_DEFAULT_PROVENANCE`（`api-command-types.ts`，当前 `true`）；
- 显式 `true` / `false` → 按调用方意愿，**显式 false 仍是 false**；
- 置 false → 产物形状与旧版完全一致（无 coverage 段），可一键回退。

三态布尔在 `api-command-args.ts` 的 `TRI_STATE_BOOLEANS` 登记；
工具入参 schema 在 `server.ts` 的 `analyze_page_apis` inputSchema 里声明。

## 7. 两端同步白名单

`api-command-types.ts` ↔ `browser-extension/api-command-helpers.js` 必须逐字同步：

| 常量 | Node 侧 | 扩展侧 |
| --- | --- | --- |
| `SOURCE_ALLOWED_KEYS` | `api-command-types.ts` | `api-command-helpers.js` |
| `PROVENANCE_ALLOWED_KEYS` | `api-command-types.ts` | `api-command-helpers.js` |
| `COMMAND_TIERS` | `api-command-types.ts` | `api-command-helpers.js` |

扩展侧另有 `API_CONTEXT_PATH_MAX_LENGTH`（上下文路径长度上限，两端各写一份，当前均为 128）。
注意它**不在** parity 列表里 —— 两端漂移不会被测出来，改这一类常量时要手工逐字核对两端。

parity 检查在 `mcp-server/test/api-command-types.test.mjs` 里（当前已覆盖
`SOURCE_ALLOWED_KEYS` / `PROVENANCE_ALLOWED_KEYS` / `COMMAND_TIERS` 等），
加新白名单项时同步加进 parity 列表。
