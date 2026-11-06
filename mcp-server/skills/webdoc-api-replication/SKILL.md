---
name: webdoc-api-replication
description: |
  Build or extend WebPilot's "API 复刻网页" capability (analyze_page_apis / scan_site /
  api-command-set pipeline) under REA's evidence discipline: tier every endpoint as
  observed / derived / inferred / unknown, keep discovered / applicable / examined /
  retained scopes separate, record ambiguity instead of guessing, and never let missing
  coverage read as absence. Use this skill when the task is to design, implement, review,
  or change the evidence/coverage contract of that pipeline — e.g. "给 scan_site 加证据
  分级", "覆盖率口径怎么算", "歧义要不要猜", "这份命令集哪些是猜的", "加一个来源类型".
  Do NOT use for ordinary browser automation (use webpilot-browser), for general REA/binary
  reverse engineering, for pure bug-hunting that needs no contract change (just read the
  code), or for one-off questions about how a specific MCP tool call works.
descriptions:
  zh-Hans: "按 REA 证据口径开发 WebPilot 的网页 API 复刻链路：证据分级、覆盖口径、歧义显式化。"
---

# WebPilot API 复刻（REA 证据口径）

本 skill 指导在本仓 `F:\mycode\mcp-servers\webdoc` 内开发/修改「把网页复刻成可复用 API 命令」这条链路。

**本文件是给 agent 主动加载的行为契约，不是仓库背景资料。** 读它是为了照着执行，
不是为了了解项目历史。

借鉴的是 REA（Reverse Engineer Anything）的**口径**，不是它的代码：REA 是二进制逆向工具，
依赖 Node 22+/24+ 与 Hopper/Ghidra 等本地引擎，其 Evidence manifest、HAR/SAZ/qlog 解码器、
protobuf/gRPC 体解码**都不适用于**本仓。不要引入 REA 依赖，也不要试图对齐它的字段名。

**本 skill 的适用边界**：它管的是「口径与产物形状」——证据档位怎么判、覆盖怎么标、
歧义怎么记、文档锚点怎么校。**纯 bug 定位不需要本 skill 的口径部分**，直接读代码即可
（例如「某个来源被静默截断了」这类排障，靠的是读实现，不是靠证据口径）。

## 当前 MCP 入口映射

默认工具面收敛为 `browser_page` / `browser_read` / `browser_act` / `browser_debug` / `api_discover` / `api_commands` / `api_call` 七入口，不改变以下证据与覆盖口径。本文和 references 中的 `analyze_page_apis` 等旧名仍可用于定位实现与兼容调用；新调用使用：

| 原入口 | 当前入口 |
| --- | --- |
| `analyze_page_apis` | `api_discover`，保留 `start` / `stop_and_analyze` / `analyze_current` / `scan_site` action |
| `list_api_commands` / `get_api_command` | `api_commands` 的 `list` / `get` |
| `call_api_command` | 独立 `api_call`，不传 `action`；命令标识及 `params` 沿用原契约 |
| `import_api_commands` / `export_api_commands` / `update_api_command` | `api_manage` 的 `import` / `export` / `update` |
| `invalidate_api_commands` / `get_api_command_cache` | `api_manage` 的 `disable` / `delete` / `clear_domain` / `health` |

先 `api_commands({action:"domains"})` 列缓存有命令的域名，再 `list(domain)` 看域名能力，`get(domain, commandId/name)` 看单个接口，检查后走独立 `api_call`；未命中再 `api_discover`。`domains` 纯本地、不接收 `domain` / `tabId`、不依赖浏览器；域名摘要不意味着端点已验证可调用。返回 `{domains:[{domain,total}],warnings:[]}`，只列有缓存命令的域名并按字典序排列；`total` 含禁用/弃用缓存命令，不等于当前可调用数。`list` 默认可能过滤禁用条目，必要时传 `includeDisabled:true` 查看，并阅读 `warnings`。上表 `api_manage` 仅为按需维护的兼容路由，不在默认或高级工具展示列表中，原维护工具名仍兼容。Skill 只描述流程；隐藏名称须由支持直接 MCP 调用的客户端使用，不能假定所有宿主可调用，也不据此增加工具或执行未授权外部写操作。每个 action 只接受其分支 schema 中的字段，必填项缺失或跨分支字段会在执行前拒绝。写命令仍需 `api_call` 的 `confirm:true`，未确认只返回预览、不发请求；确认不替代域名、只读、紧急停止和目标 URL 安全闸门。

高级工具只有服务端显式设置 `WEBPILOT_ENABLE_ADVANCED_TOOLS=1` 才展示；旧名兼容不代表默认推荐。普通多步浏览采用 `browser_read` → `browser_act` → 重读/等待并验证，不强制 task loop；只有高级任务工具可见且调用环境开启 `enable_task_mode` 时使用任务循环。

## Inputs to collect

开工前必须确认（缺失就问，不要用假设硬上）：

1. **本次要动的是链路的哪一段**：来源解析（`api-command-site-scan.ts`）/ 归一（`api-command-normalize.ts`）
   / 生成（`api-command-generator.ts`）/ 落盘缓存（`api-command-cache.ts`）/ 编排与报告（`api-command-service.ts`）
   / 传输参数（`api-command-args.ts`）/ 扩展侧（`browser-extension/`）。
2. **证据从哪来**：新增一种来源，还是改判已有来源的档位。来源种类现为 `js` / `har` / `openapi` / `commands`
   （`api-command-types.ts` 的 `SITE_SCAN_KINDS`），通道来源现为 `capture` / `scan` / `spec` / `manual`
   （`COMMAND_SOURCE_ORIGINS`）。
3. **开关与回退口径**：新判定是否需要独立开关；关闭时产物形状是否与旧版完全一致。
4. **验收口径**：本次是提高召回、提高可信度、还是提高可诊断性——三者不可互相冒充。

## Procedure

### 1. 先把「事实」与「推断」分开落位

REA 的核心主张是 *missing coverage is unknown, not absence*。本仓的落地是**三维分别判档**：

- `endpoint`：端点身份证据有多强；
- `params`：参数证据有多强；
- `response`：响应结构证据有多强。

判定入口是 `api-command-evidence.ts` 的 `deriveProvenance()`，档位语义与来源映射见
`references/evidence-model.md`。铁律：

- **响应档位只有拿到真实样本才是 `observed`**，否则恒 `unknown`。静态推导永远没有响应样本，
  不要因为「路径猜得准」就顺手把 response 也标成 inferred——那会让三维拆分失去意义。
- **总档位取三维最弱档**（`weakestTier()`）。端点再确定、响应靠猜，整条命令仍不可信。
- **多来源合并取最强档**（`tierForSourceKinds()`）：同一端点既出现在 HAR 又出现在 bundle 里，
  端点身份是被观测到的，bundle 那份弱证据不构成对该端点的否定。
  注意这与「总档位取最弱」不矛盾——前者是**同维度跨来源合并**，后者是**跨维度取弱**。

### 2. 歧义只记录，不猜

REA 反复强调 *preserve unresolved edges*。本仓的三类歧义（`SCAN_AMBIGUITY_KINDS`）：
`host`（同一路径模板有多个 host 证据）、`baseUrl`（客户端 baseURL 多候选）、
`sourceConflict`（同一 method+pathTemplate 被不同来源归到不同真实 host）。

判定歧义时特别小心**假阳性**——这是本仓真实踩过的坑：

- **参数集不同 ≠ 证据矛盾**。HAR 只记某次请求的实际参数，OpenAPI 声明全量，天然不同。
  `sourceConflict` 只能按「归属 host 是否相同」判，不能按参数集判。
- 判据一旦过噪，要先收窄判据，再复测真实站点确认真阳性仍在，**不要**靠放宽断言掩盖噪声。

### 3. 覆盖要区分口径

REA 要求 *keep discovered, applicable, examined, and retained scope distinct*。
本仓的 `buildCoverage()` 用 `scope: "domain" | "batch"` 显式标注统计口径：

- `domain` = 合并后该域名的全量命令集（这才是「覆盖率」的真实含义）；
- `batch` = 仅本次分析批次。

批次口径会把整域可信度高估。**任何对外文案给出覆盖率时必须同时给出 scope**，否则数字会骗人。

`byDimension` 三维拆分是刻意设计的：静态推导的响应档位恒 `unknown`，只看 `byTier`
会被这一维拉平成全 `unknown`，失去区分度。三维拆开后才能看出「端点其实有证据，只是响应没观测到」。

`nextHints` 由**计数触发**、每条固定文案只出现一次，且**不得回显 host、路径、样本值**——
文案与样本数据必须分离。

### 4. 落位到五层分层，不越层

本仓分层硬约束（改动前先确认要动的是哪层）：

| 层 | 文件 | 纪律 |
| --- | --- | --- |
| 契约 | `api-command-types.ts` | 只含类型/常量/正则，无函数、无 IO、无副作用 |
| 纯函数 | `api-command-evidence.ts`、`api-command-site-scan.ts` 等 | 无 `node:fs`、无 `fetch`、无 `Date`、无环境变量；可 `node --test` 直测 |
| 编排 | `api-command-service.ts` | 串起解析→归一→生成→落盘→报告 |
| 传输 | `api-command-args.ts`、`server.ts` | 参数三态归一（`TRI_STATE_BOOLEANS`） |
| 缓存 | `api-command-cache.ts` | 落盘重建，缺失即省略，不臆造 |

解析侧新增任何判定逻辑，优先落在纯函数层并配 `node --test` 直测用例；不要把判定塞进编排层
再靠端到端用例覆盖——那样无法单独验证。

### 5. 两端常量逐字同步

`api-command-types.ts` ↔ `browser-extension/api-command-helpers.js` 的白名单常量必须逐字同步
（如 `SOURCE_ALLOWED_KEYS`、`PROVENANCE_ALLOWED_KEYS`、`COMMAND_TIERS`）。
新增白名单项时**两端都要改**，并在 `api-command-types.test.mjs` 的 parity 列表里加上对应名称。

### 6. 放开项必须配置化，硬边界不动

本仓有三条**本地硬边界，一行不改**：域名白名单、紧急停止、目标 URL 校验
（协议 + hostname 精确相等 + 不跟随跳转）。

其余「放开」类需求（请求头白名单、样本值落盘、响应敏感字段）一律走**开关**：
- 开关关闭 → 行为与旧版完全一致（产物形状相同），可一键回退；
- 显式传 `false` 必须仍是 `false`——放开是默认值，不是强制值；
- 不删代码，不改硬边界。

三态布尔（如 `provenance`）在 `api-command-args.ts` 的 `TRI_STATE_BOOLEANS` 里登记，
未传 → 走默认常量（如 `SITE_SCAN_DEFAULT_PROVENANCE`）。

### 7. 验证三件套

改完必须跑完这三样，缺一不可：

1. **构建零诊断**：`npm run build`（tsc）。
2. **全量用例**：`npm test`（当前 354 条 + 新增）。
3. **基线纪律**：新用例先写 → 回退接线层 → 确认新用例确实 FAIL → 恢复 → 确认全绿。
   只跑通一次不算数；「修前就绿」说明用例没咬到改动。

   回退怎么做，取决于能不能用 git：
   - **可以用 `git stash`**：`git stash push -- <paths>` → 跑用例 → `git checkout 'stash@{0}' -- <file>` 验证 FAIL → `git stash pop`。
     注意 `stash@{0}` 必须加单引号，否则 PowerShell 会报 `unknown switch`。
   - **不能动 git 状态时**（用户禁用 stash / 工作区有他人未提交改动）：把待改文件复制到仓库外的沙箱目录，
     在副本里编译出「回退版」，只把新用例指向那份构建产物，验证修前 FAIL；
     **真实工作区只做「还原 → build → 全量用例 → 召回」四步复验**，不要在真实工作区里停成半回退态。
     直接在真实工作区回退极易编译失败（如新增枚举项被撤掉后其他文件仍引用它），
     且会覆盖或被覆盖他人的并发改动。

4. **真实站点复测召回**：改了扫描/归一逻辑还要确认召回未回退。静态扫描改动很容易「修好了 A、弄坏了 B」。

### 8b. 静默失败是最高风险类别

按长度/体积截断输入的地方，必须能区分两种结局：

- **整体拒绝**（fail-closed + 固定告警）——可接受；
- **切半放行**（slice 到一半继续）——**一律是 bug**。

半截输入通常表现为「解不出但不报错」→ 0 候选、无告警，看起来像「这个站没有接口」。
本仓的真实教训：SAZ 归档走 base64，而 base64 相对二进制膨胀 4/3，普通文本上限会把大归档切半，
解包必然失败却零告警。

新增任何按大小截断的通道时：
- 配额必须**显式常量化**（不要靠默认上限隐式兜底），且按**来源种类**分配额
  （base64 载荷要按 4/3 膨胀算，不按字符数一刀切）；
- 为截断点配 fail-closed 用例：超配额 → 0 端点 + 有告警，而不是「截半后静默 0 端点」。

### 8. 文档引用要核到标识符

改动会让 `file:line` 引用整体漂移。更新文档引用时，每条引用都要核到**确切标识符**
（函数名/常量名），不能只确认那一行非空。裸续行引用（`:668` 形式）必须跟着其文件上下文一起改。

**历史留痕文件不改**：属于上一轮验收留痕的文件（如 `specs/tasks.md` 的执行结果行、
`test-artifacts/test-coverage-result.v1.json` 的历史计数），锚点漂移**也不要回改**——
回改等于伪造历史记录。这类文件在本轮只新增条目，不动旧条目的 `file:line`。

### 9. 动手复刻前先读路由与设计两份手册

本 skill 管**口径**，两份手册管**手法**。开始一次真实复刻（或设计复刻能力）前：

- `references/route-and-capture-playbook.md` — 端点身份三要素、路径模板化规则、常见模式
  （REST 资源 / POST 列表查询 / 网关+动作名 / 批量 / 鉴权模型）、
  抓包字段的优先级顺序、以及「什么时候该停止抓包改走静态扫描」；
- `references/web-design-replication.md` — 设计原则怎么当**接口发现线索**用。

两条最省时间的结论（详见对应文件）：

1. **列表型端点是杠杆点**：一次列表调用带回一批真实 ID，是所有详情端点的 ID 来源。
2. **响应式与主题通常不新增接口**——它们改的是呈现层。别按断点/按主题各找一套接口。

判断口径不变：这两份手册给的是**检索启发式**，不是端点存在性的证明。
端点档位仍按 §1 三维分别判档，未命中的记 `unknown` 而非「不存在」。

## Output contract

一次「API 复刻链路」改动应交付：

- **契约层**：新增/变更的类型与常量，含扩展侧白名单同步；
- **纯函数层**：判定逻辑 + `node --test` 直测用例；
- **产物形状**：报告/缓存里新增字段的语义、默认值、开关行为（关闭时与旧版等价）；
- **验证记录**：构建结果、用例数（含新增条数）、基线回退 FAIL 证据、真实站点复测数字；
- **文档同步**：受影响文档的 `file:line` 引用逐条重校到标识符。

对外文案口径：只给**计数与档位**，不回显 host、路径、样本值。证据档位只反映**证据强度**，
不反映 risk / 可执行性——风险闸门独立判定。

## Failure handling

- **新判定产生假阳性**：先收窄判据（换判据维度，不换断言），再复测真实站点确认真阳性仍在。
- **用例没咬到改动**：回到基线纪律，用 `git stash` 确认修前 FAIL；`git stash push -- <paths>`
  与 `git checkout 'stash@{0}' -- <file>` 的 `stash@{0}` 必须加单引号，否则 PowerShell 会报 `unknown switch`。
- **行号漂移导致文档失效**：用标识符定位重新生成，不要手工猜偏移量。
- **两端常量漂移**：扩展侧与 Node 侧白名单不一致会导致请求头/字段名单不一致，
  跑 `npm test` 里的 parity 用例定位。
- **改动越界到硬边界**：域名白名单、紧急停止、目标 URL 校验任一被改动，立即回退该处——
  这三条是用户拍板的本地安全边界，不在可放开范围内。

## Examples

**Example 1 — 给一种新来源定档位**

输入：新增来源 `fiddler_saz`（抓包归档）。

处理：先查 `SITE_SCAN_KINDS` 与 `api-command-evidence.ts` 的 `SCAN_KIND_TIER`，
确认新来源属「真实流量归档」还是「声明」还是「字符串字面量」，据此定档；
HAR 是 `observed`，OpenAPI/命令包是 `derived`，bundle 字符串是 `inferred`。
两端白名单同步加名。响应档位仍需真实样本才 `observed`。

**Example 2 — 静态推导召回低，怎么定位**

输入：「静态扫描召回太低，怎么提高？」

处理：先读 coverage 报告的 `byDimension`：
- `endpoint` 档位低 → 路径抽取引擎或来源覆盖问题，查 `scanJsText` / `parseHarText` / `parseOpenApiText`；
- `endpoint` 高但 `response` 全 `unknown` → 这是**预期**，静态推导没有响应样本，不要改判定去凑数字，
  应改用 HAR 归档流量或开启 `captureResponseBody`；
- `scope` 是 `batch` 且数字好看 → 先换 `domain` 口径看真实覆盖率。

**Example 3 — 歧义判定是不是过噪**

输入：「静态推导出来的命令 host 老是错，怀疑歧义逻辑有问题。」

处理：先看 `ambiguities` 清单的 `kind` 分布与 `candidateCount`。
若大量 `sourceConflict` 且来源其实是同 host 的不同参数集 → 判据用错了维度，
应改为按归属 host 判（参数集不同 ≠ 证据矛盾）。改完复测真实站点确认真阳性歧义仍在。

## References

- `references/rea-principles.md` — REA 一手原则原文与出处（引用时用这里的原句，不要转述成二手结论）
- `references/evidence-model.md` — 本仓证据档位/歧义/coverage 的完整口径与判定表
- `references/repo-map.md` — 本仓文件落点与关键标识符清单（改动前先查这里，避免记错位置）
- `references/route-and-capture-playbook.md` — 路由定义规范、常见模式、抓包要分析的数据与优先级
  （动手复刻前先读：端点身份怎么定、模式怎么认、该抓哪些字段、何时改走静态扫描）
- `references/web-design-replication.md` — 网页设计原则 → 接口发现线索
  （重点：设计原则用来**决定该找什么接口**，不替代证据口径；响应式与主题通常**不新增**接口）
