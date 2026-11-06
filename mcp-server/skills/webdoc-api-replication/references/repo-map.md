# 本仓落点地图

仓根：`F:\mycode\mcp-servers\webdoc`
本文件列**文件 + 关键标识符**，不给行号——行号随每批次改动漂移，标识符不会。
需要行号时用标识符现场定位（`grep` 标识符名），不要凭记忆写行号。

---

## 分层与文件

| 层 | 文件（相对 `mcp-server/src/`） | 职责 | 硬约束 |
| --- | --- | --- | --- |
| 契约 | `api-command-types.ts` | 类型、常量、正则 | 无函数、无 IO、无副作用 |
| 纯函数 | `api-command-evidence.ts` | 证据分档、歧义、coverage 聚合 | 无 `node:fs`、无 `fetch`、无 `Date`、无环境变量 |
| 纯函数 | `api-command-site-scan.ts` | 来源解析（js/har/openapi/commands）、host 交叉引用、baseURL 侦测 | 同上 |
| 纯函数 | `api-command-normalize.ts` | 分组归一（`groupEndpoints()`） | 同上 |
| 纯函数 | `api-command-generator.ts` | 命令生成、命名、risk 判定 | 同上 |
| 纯函数 | `api-command-render.ts` | 模板渲染、复合步骤取值 | 同上 |
| 纯函数 | `api-command-response-schema.ts` | 响应结构提取 | 同上 |
| 编排 | `api-command-service.ts` | `analyze()` / `call()` / `invalidate()`，串起全链路 | 可 IO |
| 传输 | `api-command-args.ts` | 参数归一、三态布尔 `TRI_STATE_BOOLEANS` | 可 IO |
| 传输 | `server.ts` | MCP 工具注册与 inputSchema | 可 IO |
| 缓存 | `api-command-cache.ts` | 落盘、按 hostname 合并、`rebuildSource()` / `rebuildProvenance()` | 可 IO |
| 扩展 | `browser-extension/api-command-helpers.js` | 白名单常量、`assertApiTargetUrl()` | 与 Node 侧常量逐字同步 |
| 扩展 | `browser-extension/background.js` | `assertCommandAllowed()`、紧急停止、域名白名单 | 硬边界，一行不改 |

## 关键标识符

### 契约层 `api-command-types.ts`

- `COMMAND_TIERS`、`COMMAND_TIER_STRENGTH` — 四档与强度
- `CommandProvenance` — `{ tier, endpoint, params, response }`
- `SCAN_AMBIGUITY_KINDS`、`ScanAmbiguity` — 歧义种类与结构
- `AnalysisCoverage` — coverage 报告结构（含 `scope`、`byDimension`、`nextHints`）
- `SOURCE_ALLOWED_KEYS`、`PROVENANCE_ALLOWED_KEYS` — 扩展侧同步白名单
- `SITE_SCAN_KINDS` — `js`/`har`/`openapi`/`commands`
- `COMMAND_SOURCE_ORIGINS` — `capture`/`scan`/`spec`/`manual`
- `SITE_SCAN_DEFAULT_PROVENANCE` — provenance 默认开关值
- `COVERAGE_HINT_*`、`AMBIGUITY_*_WARNING` — 固定文案（只给条数，不回显样本）

### 纯函数层 `api-command-evidence.ts`

- `normalizeTier()` / `weakestTier()` — 档位归一与取最弱
- `tierForSourceKind()` / `tierForSourceKinds()` — 来源 → 档位（多来源取最强）
- `tierForOrigin()` — 通道 → 档位
- `deriveProvenance()` — 三维档位组装
- `sameSourceKinds()` — 来源集合比较
- `makeAmbiguity()` / `hostAmbiguity()` / `baseUrlAmbiguity()` — 歧义构造
- `buildCoverage()` — coverage 聚合
- `coverageCountsConsistent()` — `byTier` 之和自检

### 解析层 `api-command-site-scan.ts`

- `scanJsText()` / `scanJsTextDetailed()` — bundle 路径字面量
- `parseHarText()` — HAR 归档流量
- `parseOpenApiText()` — OpenAPI 规格
- `parseCommandSetText()` — 声明式命令包
- `splitProtocolRelativeUrl()` / `detectBaseUrlHosts()` / `normalizeContextPath()`
- `isNoisePath()` — 噪声路径判定（页面/资源/非 JSON）
- `applyHostCrossReference()` — 跨来源 host 交叉引用，返回 `{ inferred, ambiguities }`
- `scanSources()` — 同键候选合并 + 歧义产出
- `toScanRecords()` — 候选 → 归一记录（透传 `sourceKinds`）
- `isSpecOrigin()` — 规格类来源判定
- `checkScanUrl()` / `isPrivateHost()` — URL 校验与私网判定

### 生成与编排

- `api-command-generator.ts`：`generateCommands()`、`groupEndpoints()` 归一结果输入、
  `stableCommandId()`、`classifyRisk()`、`deriveResource()`、`sanitizeCommandName()`
- `api-command-service.ts`：`analyze()`、`call()`、`invalidate()`
- `api-command-cache.ts`：`rebuildSource()`、`rebuildProvenance()`（重建，缺失即省略）

### 扩展侧硬边界

- `browser-extension/background.js`：`assertCommandAllowed()` — 紧急停止、只读门、域名白名单
- `browser-extension/api-command-helpers.js`：`assertApiTargetUrl()` — 目标 URL 校验
  （协议 + hostname 精确相等 + 不跟随跳转）

## 测试落点

`mcp-server/test/` 下 `api-command-*.test.mjs`：

| 文件 | 覆盖 |
| --- | --- |
| `api-command-evidence.test.mjs` | 证据分档、歧义、coverage |
| `api-command-site-scan.test.mjs` | 来源解析、host 推断 |
| `api-command-host-infer.test.mjs` | 跨源 host 交叉引用 |
| `api-command-types.test.mjs` | 契约常量 + **两端 parity 列表** |
| `api-command-security.test.mjs` | 硬边界（域名白名单、只读门、URL 校验） |
| `api-command-composite.test.mjs` | 复合命令 |
| `api-command-generator.test.mjs` / `-normalize` / `-render` / `-response-schema` | 各纯函数层 |

新增常量后必须在 `api-command-types.test.mjs` 的 parity 列表补名，否则两端漂移不会被测出来。

## 命令

工作目录均为 `F:\mycode\mcp-servers\webdoc\mcp-server`：

```
npm run build     # tsc 构建，零诊断
npm test          # 全量用例
npm run doctor    # 健康检查
```

基线纪律用到的 git 命令（PowerShell 注意引号）：

```
git stash push -- <paths>
git checkout 'stash@{0}' -- <file>     # stash@{0} 必须加单引号
git stash pop
```

删除文件用 `rm -- "<绝对路径>"`（本机禁止 PowerShell 永久删除）。
提交一律显式路径 `git add <path>`，**不要** `git add -A`（工作区可能有非本次产生的未跟踪项）。

## 文档引用纪律

需要写 `file:line` 引用时：

1. 用标识符定位真实行号（`grep` 标识符名），不靠记忆或偏移量推算；
2. 核到**确切标识符**，不只是确认那一行非空；
3. 裸续行引用（`:668` 形式）必须跟着其文件上下文一起修正；
4. 改动会让引用整体漂移——改了文件就要重校全部引用，不是只改被改的那条。

受影响文档：`specs/design.md`、`specs/tasks.md`、`docs/api-command-set-upgrade-spec.md`、
`task-list.json`、`test-artifacts/test-coverage-result.v1.json`。
