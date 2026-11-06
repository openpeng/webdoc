# WebPilot API 命令集升级 - 任务拆解（lite）

> 最后更新：2026-11-05
> 状态说明：⏳ 待开始 | 🔄 进行中 | ✅ 已完成 | ❌ 已阻塞
> lite 版：适用于中小需求（tier3+ 档位），单文件轻量拆解；API 响应契约以 spec.md 为准（lite 版不复制）。

---

## Phase 0：待确认问题

- [x] **0.1** 复合命令（多步编排）中「上一步响应取值 → 下一步入参」的取值路径语法最终形态（负责人：xiaopeng.lei）
  - **完成**：2026-11-05 用户 `ask_user` 拍板定案：取值路径 = **JSONPath**（`$.data.order.id`）；依赖声明 = **显式映射表**（`{"orderId": {"from": "$.data.order.id"}}`）；复合命令作为命令集条目落盘，靠导入命令包交付。实现见 `api-command-render.ts` `parseJsonPath` / `evalJsonPath` / `isStepValueMapping` / `resolveCompositeSteps` / `applyStepMappings`（commit `ed52b71`）。
  - 状态：⏳ 待确认（用户已拍板纳入本需求、排最后做；语法细节在 **2.9** 开工前单独确认）
  - 影响面：仅 **2.9**（T9 复合命令）；**2.1**–**2.8** 不依赖本项，不阻塞
  - 处置：不猜、不用假设填空；未确认前 **2.9** 不开工，其余任务照常推进

## Phase 1：数据库变更（如有）

- ✅ **1.1** 本需求无数据库变更（负责人：xiaopeng.lei）
  - **完成**：无 DDL 产生；`npm run doctor` 0 fail（5 pass / 3 info / 0 warn / 0 fail）。
  - 说明：命令集以本地 JSON 文件落盘（`api-commands.json`），不引入任何表结构 / 迁移 / 索引变更
  - 验收：无 DDL 产生，`npm run doctor` 0 fail

## Phase 2：后端开发

> 遵循 Controller → Facade → Service → DAO 分层；接口契约（字段/类型/错误码）以 spec.md 为准，逐字段比对。
> 本需求仓库形态为「MCP Server（后端）+ Chrome MV3 扩展（端侧）」，无独立 Web 前端；扩展侧任务在同一条目内标注「[扩展侧]」。
> 全局硬约束：域名白名单、紧急停止、目标 URL 校验（协议 + hostname 精确相等 + 不跟随跳转）三项**一行不改**。

- [x] **2.1** T1 静态推导放开：`loosePaths` / `trustSpec` 默认放开 + 扩展侧 bundle 发现优先 + `needsReview` 降为 1 条来源标注（负责人：xiaopeng.lei）
  - **完成**：`c60be17` — `SITE_SCAN_DEFAULT_LOOSE` / `SITE_SCAN_DEFAULT_TRUST_SPEC` 默认 true；`needsReview` 降为 1 条来源标注；risk 按真实 method 判定。用例：`api-command-site-scan.test.mjs:500`/`:523`/`:539`/`:556`。
  - 落点：`api-command-types.ts` / `api-command-service.ts` `scanSite()` / `api-command-site-scan.ts`
  - 验收：AC-1 通过（不传 `loosePaths` 端点数 ≥ 1，B 站基线 0）；AC-2 通过（GET/HEAD/OPTIONS → `risk=read`，其余 `write`）；新增用例 ≥ 1 条

- [x] **2.2** T2 路径归一与 method 修复：协议相对 URL（`//host/path`）不再整体当路径、候选自带 host 并在 host ≠ domain 时标 `crossHost`、`inferMethod` 扩展识别 `axios({method})` / 对象字面量 `method` / `$.ajax({type})`（负责人：xiaopeng.lei）
  - **完成**：`660eb45` — 协议相对 URL 拆 host（`splitProtocolRelativeUrl`）；候选自带 host + `crossHost` 标记；`inferMethod` 扩展。用例：`api-command-site-scan.test.mjs:574`/`:581`/`:590`/`:609`。
  - 落点：`api-command-site-scan.ts` / `api-command-generator.ts`
  - 验收：AC-13 通过（petstore OpenAPI 19/19 路径命中）；协议相对 URL 不再被当路径；新增用例 ≥ 1 条

- [x] **2.3** T4 值落盘放开 + 常量参数改写为 `{{name}}` 占位符 + 响应敏感字段默认不强制打码（负责人：xiaopeng.lei）
  - **完成**：`7b14d7c` — `isPersistableLiteral` 放开标量落盘（≤200 字符，真凭据形态仍拒）；常量改写 `{{name}}` + `param.defaultValue`；`strictRedaction` 默认 false。用例：`api-command-render.test.mjs:354`/`:367`/`:378`、`api-command-response-schema.test.mjs:137`。
  - 落点：`api-command-normalize.ts` / `api-command-cache.ts` / `api-command-generator.ts` / `api-command-render.ts` / `api-command-response-schema.ts`
  - 验收：AC-5 通过（调用方传 `params.nickname="lisi"` 实际发出 `lisi`，基线发出 `zhangsan`）；标量样本值可落盘且字符串长度 ≤ 200；`strictRedaction` 默认 false；新增用例 ≥ 1 条

- [x] **2.4** T3 请求头放开：全部非凭据头放行，仅剔除 `Cookie` / `Authorization` / `Proxy-Authorization` / `Set-Cookie`（负责人：xiaopeng.lei）
  - **完成**：`9628be5` — `API_COMMAND_FORBIDDEN_HEADERS` 剔除凭据头，其余全量下发；`EXECUTE_OPTIONS_ALLOWED_KEYS` 含 `headers`；两端常量逐字同步。用例：`api-command-render.test.mjs:285`/`:315`、`api-command-security.test.mjs:279`、`api-command-types.test.mjs:236`。
  - 落点：`api-command-types.ts` / `api-command-render.ts` / `api-command-service.ts` / **[扩展侧]** `browser-extension/api-command-helpers.js` `rebuildExecuteOptions()` / `browser-extension/background.js` `cmdApiCommandExecute()`
  - 验收：AC-6 通过（请求含 `X-Requested-With`，不含 `Cookie` / `Authorization`）；`EXECUTE_OPTIONS_ALLOWED_KEYS` 含 `headers`；两端常量逐字同步断言通过；新增用例 ≥ 1 条

- [x] **2.5** T5 导出 / 导入闭环 + `source.origin` 来源标注 + 成品格式命令包导入（负责人：xiaopeng.lei）
  - **完成**：`e27a872` — 新增 `export_api_commands` / `import_api_commands` 两个 MCP 工具；`source.origin` 来源标注；成品格式导入保全字段。用例：`api-command-cache.test.mjs:113`/`:164`/`:190`、`api-command-site-scan.test.mjs:662`。
  - 落点：`api-command-types.ts` / `api-command-cache.ts` / `api-command-site-scan.ts` / `server.ts`（新增 `export_api_commands` / `import_api_commands` 两个 MCP 工具）
  - 验收：AC-7 通过（导出 → 清空 → 导入后条数 / 名称 / 参数 / 响应裁剪规则一致且可直接调用）；AC-8 通过（成品格式导入 ≥ 1 条且 `request.urlTemplate` / `risk` / `responseFields` / `manuallyEdited` 被保留）；新增用例 ≥ 1 条

- [x] **2.6** T6 缓存一致性：写盘前重读并按 hostname 合并 + 唯一 tmp 文件名 + `loadFailed` 保护（负责人：xiaopeng.lei）
  - **完成**：`5276030` — `persist` 写前重读磁盘按 hostname 合并；tmp 名含 pid + 时间戳 + 序号；`loadFailed` 态只写本次新增域名。用例：`api-command-cache.test.mjs:529`/`:553`/`:569`/`:587`。
  - 落点：`api-command-cache.ts` `persist()` / `ensureLoaded()`
  - 验收：AC-9 通过（两个进程先后写不同域名，磁盘上两个域名的命令都存在）；tmp 名含 pid + 时间戳；读失败状态下只写本次新增域名；新增用例 ≥ 1 条

- [x] **2.7** T7 破坏性默认值修复 + 只读门改按 method 派生（负责人：xiaopeng.lei）
  - **完成**：`38e6085` — `invalidate` 只认字面量 `clear_domain`，其余 `INVALID_PARAMS` 且不删数据；扩展只读门改按 `options.method` 派生；域名白名单 / 紧急停止 / 目标 URL 校验三项硬边界一行未改。用例：`api-command-security.test.mjs:711`/`:329`/`:311`/`:363`/`:395`。
  - 落点：`server.ts` `invalidate_api_commands` / `api-command-service.ts` `invalidate()` / **[扩展侧]** `browser-extension/background.js` `assertCommandAllowed()`
  - 验收：AC-10 通过（`action` 缺失或非法返回 `INVALID_PARAMS` 且该域名命令不被删除）；AC-12 通过（只读模式下 `risk=read` 但 `method=POST` 被扩展侧拒绝）；三项硬边界一行未改；新增用例 ≥ 1 条

- [x] **2.8** T8 `ai_search` 修正：SSE 增量判定改显式标记 + 改流式读取 + `timeoutMs` 改跨通道总预算 + `attempts` 真实计数（负责人：xiaopeng.lei）
  - **完成**：`4c44d8f` + `06a2ff0` — SSE 增量判定改显式标记；`ReadableStream` 读取 + 结束标记即收尾；`timeoutMs` 改跨通道总预算；`attempts` 真实计数。用例：`baidu-ai-search.test.mjs:317`、`api-command-ai-search.test.mjs:47`/`:83`/`:116`。
  - 落点：`baidu-ai-search.ts` `parseBaiduBaikanSse()` / `api-command-service.ts` `fetchBaikanSse()` / `aiSearch()`
  - 验收：AC-14 通过（三个连续「哈」拼接得「哈哈哈」，基线得「哈」）；收到结束标记即返回已收内容；无 ~4× 超时放大；新增用例 ≥ 1 条

- [x] **2.9** T9 复合命令（多步编排）—— 排最后，前置依赖 2.1–2.8 全部完成（负责人：xiaopeng.lei）
  - **完成**：`ed52b71` — `ApiCommand.steps` + JSONPath 取值 + 显式映射表；`call` 走多步编排分支；预检零请求；风险只升不降；拒绝嵌套复合命令；随命令包导入导出。用例：`api-command-composite.test.mjs` 19 条、`api-command-types.test.mjs:215`。
  - 落点：`api-command-types.ts`（`ApiCommand.steps`）/ `api-command-render.ts`（`resolveCompositeSteps()`）/ `api-command-service.ts` `call()`
  - 前置：**0.1** 取值路径语法须先与用户确认
  - 验收：AC-3、AC-4 在复合命令路径同样成立（缺参 → `MISSING_PARAMS`、`risk=write` 未确认 → `CONFIRMATION_REQUIRED`，均零网络请求）；上一步响应按 `from` 路径取值注入下一步 `params`；新增用例 ≥ 1 条

- [x] **2.10** 扫描与覆盖回填：按 design.md 第八节 AC ↔ 实现位置映射，人工回填执行证据（负责人：xiaopeng.lei）
  - **完成**：`442f3e1` — 产出 `test-artifacts/test-coverage-result.v1.json`（14 条 AC 全通过 + 证据用例 + 实现位置行号，已逐条复核 37 条用例引用 / 44 条实现引用全部命中）；`specs/design.md` 第八节 AC ↔ 实现位置表行号已按当前 HEAD 重校；基线 gap `NO_ENDPOINT_DISCOVERED` / `UNMAPPED_ACCEPTANCE_CRITERIA` 显式登记处置，不伪造自动映射。
  - 落点：`test-artifacts/test-coverage-result.v1.json`（由 `orbit_test_artifacts mode=record` 写入）
  - 验收：14 条 AC 均有对应执行用例编号与证据引用；基线 gap `UNMAPPED_ACCEPTANCE_CRITERIA` 显式登记处置（不伪造自动映射）

- [x] **2.12** T12 传输层布尔强转缺陷修复：未传的开关被压成 false，摧毁 scan_site 三项文档默认值（负责人：xiaopeng.lei）
  - **完成**：`171d327` — 在 `deploy_to_test` 的真实 MCP 调用复测中暴露：`server.ts` 对可选布尔开关一律用 `args.X === true` 归一化，把「未传（undefined）」压成「显式 false」，而服务层为 `loosePaths` / `trustSpec` / `discoverBundles` 定义了「undefined → 默认值（true）」语义，被传输层摧毁。真实调用 `analyze_page_apis action=scan_site` 对真实现代站点返回 `endpointCount=0 / commandCount=0`（裸路径识别、method 判定、bundle 自动发现三项默认值全失效），而直调解析层 `scanJsText` 对同一份 JS 有 1 条候选 → 定位为传输层与服务层行为不一致。修复：新增纯函数层 `mcp-server/src/api-command-args.ts`（`AnalyzeAction`/`AnalyzeArgs` 契约 + `toBooleanArg` 三态/二态 + `toAnalyzeArgs` 归一化入口），`server.ts` 只剩一行 `apiCommandService.analyze(toAnalyzeArgs(args))`；显式传 false 仍是 false（放开是默认值不是强制值）。新增 9 条回归用例。
  - 落点：`mcp-server/src/api-command-args.ts`（新建） / `mcp-server/src/server.ts` `analyze_page_apis` 分支 / `mcp-server/src/api-command-service.ts`（契约移入 args 模块并再导出）
  - 验收：修复后 `npm test` **326/326 pass**（317 + 9）；基线复核——临时把 `toBooleanArg` 复刻成修复前行为（`value === true`）重编译后，9 条新用例中 5 条 FAIL（#1/#5/#6/#8/#9），确认为真实回归护栏；`npm run build` tsc 零诊断；本机部署后 live 调用 `endpointCount` 由 0 变 1、`commandCount` 由 0 变 1（`get.web-interface.nav`，risk=read），负向对照显式 `loosePaths=false` 仍为 0/0


- [x] **2.11** T11 代码审查缺陷修复：占位 baseURL 泄漏、变量绑定首匹配掩盖歧义、取值命中/未命中留痕信号混用（负责人：xiaopeng.lei）
  - **完成**：`T11` — 独立 verifier 会话审查 T9/T10 新代码，主开发复核并逐条实证。3 个可复现缺陷全部修复：(D1) 占位默认 baseURL `api.domain.com` 在 `baseURL: <expr> || <var>` 形态下未被排除 → 裸路径被挂到占位 host，命令必然打不通，抽出 `SITE_SCAN_PLACEHOLDER_BASE_HOST` 两形态统一排除；(D2) 回查变量绑定只取首个匹配，把「变量被重新赋值」这一真实歧义藏起来 → 收齐全部绑定，全部指向同一 host 才算唯一解，出现分歧即不猜；(D3) 取值命中与未命中共用 `overridden` 信号 → 告警与事实相反，拆成 `overridden` / `fallback` 两个信号，服务层分别给出方向相反的告警。新增 8 条回归用例（6 条在修复前基线实测失败）。
  - 落点：`mcp-server/src/api-command-site-scan.ts` `detectBaseUrlHosts()` / `mcp-server/src/api-command-render.ts` `applyStepMappings()` / `mcp-server/src/api-command-service.ts` `callComposite()` / `mcp-server/src/api-command-types.ts` `SITE_SCAN_PLACEHOLDER_BASE_HOST`
  - 验收：修复后 `npm test` **317/317 pass**（309 + 8，2.12 完成后为 326/326）；修复前基线实测 6 条新用例失败；真实 B 站主 bundle（1605288 字节）复测召回未回退（113 候选中 48 个归属 `api.bilibili.com`，host 推断告警仍触发，无候选被占位 host 污染）

- [x] **2.13** T13 证据分级 + 歧义显式 + coverage 报告：借鉴 REA 的「证据口径」，让每条命令自证可信度、让多解证据显式暴露而非静默拍平（负责人：xiaopeng.lei）
  - **完成**：`T13` — 借鉴 REA（Reverse Engineer Anything）的**口径**而非代码（不引入 REA 依赖：需 Node 22+/24+ 与 Hopper/Ghidra 等本地引擎、manifest 格式私有、其 Evidence 格式不兼容；其二进制/应用逆向主体、sticky provider、HAR/SAZ/qlog 解码器、protobuf/gRPC 体解码对本项目均不适用）。落地三条纪律：(a) **证据分级** —— 新增 `COMMAND_TIERS`（`observed` / `derived` / `inferred` / `unknown`）+ `COMMAND_TIER_STRENGTH` + `CommandProvenance`，按**端点 / 参数 / 响应三维分别判定**、总档位取最弱；档位映射：抓包→`observed`，规格（OpenAPI / 声明式命令包）与人工命令→`derived`，静态扫描 + JS bundle→`inferred`，扫描 + HAR 归档流量→`observed`，无来源→`unknown`；响应维度有样本才 `observed`，否则恒 `unknown`。(b) **歧义显式** —— `scanSources()` 由「同键首胜丢弃」改为**同键候选合并**（来源种类并集 + 参数名并集），并产出 `ambiguities` 三类（`host` 同一路径多 host 证据 / `baseUrl` 客户端 baseURL 多候选 / `sourceConflict` 同一 (method, pathTemplate) 被不同来源归到不同真实 host），全部「不猜」只记录。(c) **coverage 报告** —— 报告新增 `coverage` 段（`byTier` + `byDimension` 三维拆分 + `verifiedCount` + `ambiguities` + `nextHints`）；`byDimension` 拆三维的原因：静态推导的响应档位恒 `unknown`，只看 `byTier` 会被这一维拉平成全 `unknown`、失去区分度。新增纯函数层 `mcp-server/src/api-command-evidence.ts`（无 IO / 无 `Date` / 无环境变量，可 `node --test` 直测）。开关 `provenance` 三态：未传 → `SITE_SCAN_DEFAULT_PROVENANCE`（true），显式 false 仍是 false（放开是默认值不是强制值），置 false 时命令不带 `source.provenance`、报告不带 `coverage` 段，产物形状与旧版完全一致。用例：`api-command-evidence.test.mjs` 28 条、`api-command-types.test.mjs:196`/`:236`（两端常量 parity 扩到 `PROVENANCE_ALLOWED_KEYS` / `COMMAND_TIERS`）。
  - 落点：`mcp-server/src/api-command-types.ts`（`:659` `COMMAND_TIERS` / `:663` `COMMAND_TIER_STRENGTH` / `:676` `CommandProvenance` / `:688` `SCAN_AMBIGUITY_KINDS` / `:732` `AnalysisCoverage` / `:281` `SOURCE_ALLOWED_KEYS` / `:283` `PROVENANCE_ALLOWED_KEYS` / `:1253` `SITE_SCAN_DEFAULT_PROVENANCE`） / `mcp-server/src/api-command-evidence.ts`（新建，`:149` `deriveProvenance()` / `:298` `buildCoverage()` / `:187` `makeAmbiguity()`） / `mcp-server/src/api-command-site-scan.ts`（`:1129` `applyHostCrossReference()` 返回 `{ inferred, ambiguities }` / `:1177` `scanSources()` 同键合并 / `:601` HAR 跨 origin 统计 / `:1329` `toScanRecords()` 透传 `sourceKinds`） / `mcp-server/src/api-command-normalize.ts`（`:520` `groupEndpoints()` 取来源并集） / `mcp-server/src/api-command-generator.ts`（`:312` 开关 / `:400` 写入 `source.provenance`） / `mcp-server/src/api-command-cache.ts`（`:599` `rebuildProvenance()`，缺失或非法即整体省略、**不臆造档位**） / `mcp-server/src/api-command-service.ts`（`:1419` 抓包通道 `report.coverage` / `:1263` scan 通道 `report.coverage`） / `mcp-server/src/api-command-args.ts`（`:37` `TRI_STATE_BOOLEANS` 含 `provenance`） / `mcp-server/src/server.ts`（`:988` inputSchema 新增 `provenance`） / **[扩展侧]** `browser-extension/api-command-helpers.js`（`:195` / `:197` / `:212` 常量逐字同步）
  - 验收：`npm test` **354/354 pass**（326 + 28）；基线复核——`git stash` 回退接线层后新增用例 **10 条 FAIL**（#13/#14/#15/#16/#17/#18/#19/#21/#23/#26，逐条对应合并 / tier / 冲突 / host 歧义 / baseURL 歧义 / 透传 / 生成 / 缓存往返 / coverage），恢复后全绿；`npm run build` tsc 零诊断；live 实测（stdio JSON-RPC 直连新构建 `dist/server.js`）三源（js + har + openapi）→ `endpointCount=3 / commandCount=3`，`coverage.byDimension.endpoint={observed:1, inferred:2}`、`byDimension.response` 全 `unknown`、`verifiedCount=0`、`ambiguities=[]`、3 条 nextHints；负向对照 `provenance=false` → **无 coverage 段**、仍产出 `endpointCount=1 / commandCount=1`；真实 B 站主 bundle（1605288 字节）复测召回**未回退**（113 候选 / 48 个归属 `api.bilibili.com`，与 T11 基线完全一致），并正确检出 1 条真阳性歧义（`/x/web-interface/nav` 候选 `api.bilibili.com` + `main-api.biligame.com`）；三项本地硬边界（域名白名单 / 紧急停止 / 目标 URL 校验）**一行未改**

- [x] **2.14** T14 真实站点复刻（Confluence）：补「应用上下文路径」概念 + 覆盖率口径改域名级 + 噪音路径过滤（负责人：xiaopeng.lei）
  - **完成**：`T14` — 对 `https://confluence.gaodunwangxiao.com/confluence/#all-updates`（已登录）做一次真实的「网站 → API 命令集」复刻。首轮即暴露 **1 个主缺陷 + 3 个次缺陷**，全部修复并复测通过；完整复刻报告见 `docs/api-command-confluence-replication-report.md`。
    - **主缺陷（T14-D1，高）**：JS 来源路径缺「应用上下文路径」概念。前端 bundle 普遍把接口写成「上下文前缀 + 相对路径」（`AJS.contextPath()+"/rest/webResources/1.0/resources"`、`f.CONTEXT_PATH+"/json/pagechildren.action"`、`"".concat(n,"//").concat(v.Z.apiHost,"/x/web-frontend/getbuvid")`），扫出来是裸路径 `/rest/...`，而真实地址是 `/confluence/rest/...`。**实测裸路径请求返回 Tomcat 原始 404 页**（根本没进 Confluence 的 REST servlet），命令集整体不可用 —— 与已修的 D-2（OpenAPI `basePath` 丢失）同类：OpenAPI 侧的口径是「规格里的 paths 相对 servers」，JS 侧的等价物是「bundle 里的路径相对应用上下文路径」。修复：静态侧识别「相对 context 的路径」（`CONTEXT_PATH_TOKEN_RE` / `LITERAL_PREFIX_RE`）并标记 `relativeToContext`，扩展侧在**页面上下文**取值，`scanSources()` 在**合并之前**统一补前缀。
    - **取值的三条硬约束**（安全边界，不是功能开关）：页面 origin 必须**精确命中**本次扫描的允许域名集合，否则返回空串（跨站页面给出的前缀是污染）；前缀必须通过 `normalizeContextPath()`（必须 `/` 开头，无协议 / 查询串 / `..` / `\` / 空白 / 引号，长度 ≤ `API_CONTEXT_PATH_MAX_LENGTH = 128`，根路径归一成空串）；MCP 侧对扩展回包**再校验一次**（不信任回包）。补上与没补上**两种结局都显式告警**，不静默放过。
    - **次缺陷 F2（T14-D2，中）**：coverage 用批次级分母，域名级真值被显示成 **71%**（实测该域缓存实有 54 条命令、真实覆盖只有 10/54 ≈ 19%）。改为**域名级全量**口径（分母 = 该域缓存全量命令数），显式加 `scope` 字段（`domain` / `batch`），批次信息单列到 `batchCommandCount`；scan 与 capture 两条通道口径统一，取不到域名全量时回落 batch 口径并告警。
    - **次缺陷 F3（T14-D3，中）**：scan 与 capture 侧同一端点裂成两条命令（`/rest/...` vs `/confluence/rest/...`）。**不需要独立机制** —— 补齐前缀后 `pathTemplate` 一致 → `commandId`（`sha256(host\0method\0pathTemplate)`）自对齐 → 合并时自动合并并**提档**（实测 2 条被 capture 同化提档、0 条丢失）。
    - **次缺陷 F4（T14-D4，低）**：静态推导把普通字符串常量与注释里的路径当接口（`/a/i`、`/a/b`、`/includes/soy/*.soy`、`/images/icons/emoticons`）。**双重保险**过滤：形状像噪音（静态资源后缀 / 静态资源首段集 / `^\/[a-z]\/[a-z]$`）**且** 不在任何请求上下文（url 字段赋值或请求调用点）里才丢 —— 只要有一方说它像接口就保留。静态资源首段集**刻意不含 `download`**（Confluence 的 `/download/resources` 是真接口）。
  - 落点：`mcp-server/src/api-command-types.ts`（`:103` `API_CONTEXT_PATH_MAX_LENGTH` / `:932` `AnalysisReport.contextPath` / `:1187` `relativeToContext` / `:1195` `hasRequestContext` / `:1205` `SiteScanResult` / `:1217` `contextPath` / `:1219` `relativePathCount` / `:1221` `contextPathAppliedCount` / `:1223` `noiseDroppedCount` / `:1273` / `:1279` / `:1283` 三条告警 / `:742` `scope` / `:744` `batchCommandCount`） / `mcp-server/src/api-command-site-scan.ts`（`:406` `CONTEXT_PATH_TOKEN_RE` / `:414` `LITERAL_PREFIX_RE` / `:427` `STATIC_RESOURCE_SEGMENTS` / `:432` `NOISE_TWO_LETTER_RE` / `:440` `normalizeContextPath()` / `:469` `isNoisePath()` / `:487` `applyContextPath()` / `:529` `scanJsTextDetailed()` / `:1177` `scanSources()` 接线） / `mcp-server/src/api-command-evidence.ts`（`:238` / `:240` `CoverageInput.scope` / `batchCommandCount` / `:298` `buildCoverage()`） / `mcp-server/src/api-command-cache.ts`（`:599` / `:711` 透出 `provenance`） / `mcp-server/src/api-command-service.ts`（`:928` 回包复验 / `:1130` `report.contextPath` / `:1133` 传 `contextPath` / `:1255` `domainCards` / `:1264` / `:1265` / `:1419` 抓包通道同口径） / **[扩展侧]** `browser-extension/api-command-helpers.js`（`:71` `API_CONTEXT_PATH_MAX_LENGTH` / `:468` `normalizeApiContextPath()`） / `browser-extension/background.js`（`:1950` 取值 / `:2088` `apiDetectContextPathInPage()` / `:2133` `apiDetectContextPath()` / `:1976` / `:2008` 两个回包分支） / `mcp-server/test/api-command-context-path.test.mjs`（17 条）
  - 验收：新增用例 **17 条**（`api-command-context-path.test.mjs`），`npm test` **371/371 pass**（354 基线 + 17）；`npm run build` tsc **零诊断**；`npm run doctor` 5 pass / 3 info / 0 warn / 0 fail。live 实测（stdio JSON-RPC 直连新构建 `dist/server.js` + 人工重载扩展）：重载前 `an_scan_1793943661288` 的 `contextPath` 为空、69 端点；重载后 `an_scan_1793943765310` 的 `contextPath=/confluence`、68 端点 / 68 命令、`diff={added:39, updated:29, skipped:40}`。抓包 `an_20261106054449226_001`（14 端点 / 14 命令 / `sampledResponseCount=20`）与 scan 合并后缓存 **120** 条（scan 106 + capture 14）：逐条比对 **66 条**仍为 scan 来源、**2 条**被 capture 同化提档（`/confluence/rest/webResources/1.0/resources` 三维全 `observed`；`/confluence/plugins/editor-loader/editor.action` 端点/参数 `observed`、响应 `unknown`）、**0 条丢失**、`diff.updated=2`。coverage 实测 `{scope:"domain", batchCommandCount:14, commandCount:120, byTier:{observed:9,unknown:111}, verifiedCount:9, denominator:120, coverageRate:0.075, dimensionRates:{endpoint:0.117, params:0.117, response:0.075}}`。**调用闭环**：33 条「scan 来源 + 带 `/confluence` 前缀 + GET + read」命令实调，**200 命中 12**、404×14 / 405×3 / 400×1 / `REDIRECT_BLOCKED`×2 / `MISSING_PARAMS`×1 —— 修复前同一批命令指向裸路径实测进不了 REST servlet（Tomcat 原始 404 页），修复后 404 变成 Confluence 自己的 404/405，说明请求已正确路由到应用。**B 站真实站点召回复测**（`test-artifacts/t14-bilibili-recall.json`）：整批口径 `loose=true` **139 候选 / 132 unique / 35 hit / recall 1.0**，与 T10 基线（140 / 133 / 35 / 1.0）持平，少的 1 条是噪音 `/a/i`；实打存活 **24/35 = 68.57%** 与基线一致。三项本地硬边界（域名白名单 / 紧急停止 / 目标 URL 校验）**一行未改**。

## Phase 3：测试（QA）

- [x] **3.1** 功能测试与回归（负责人：xiaopeng.lei）
  - **完成**：`npm test` → **354/354 pass**（存量 245 条零回归 + 新增 109 条：T1–T10 累计 64 条 + T11 审查回归 8 条 + T12 传输层修复回归 9 条 + T13 证据分级回归 28 条）；`npm run doctor` → 5 pass / 3 info / 0 warn / 0 fail。AC-11 专项：扩展域名白名单外目标被拒且零网络请求（`api-command-security.test.mjs:363`/`:395`）；AC-3 / AC-4：缺参与未确认均零网络请求（`api-command-render.test.mjs:227`）；T13 专项：新增用例在修复前基线实测 10 条 FAIL（回退接线层验证），恢复后 28/28 通过。
  - 范围：`npm test` 全绿（存量 245 条零回归 + 各批次新增用例）；`npm run doctor` 0 fail；AC 全部通过，无阻断性 Bug
  - 专项回归：AC-11 —— 扩展域名白名单外的目标被拒绝且零网络请求（硬边界不变）；AC-3 / AC-4 —— 缺参与未确认均零网络请求
  - 验收：AC-1 ~ AC-14 全部通过，无阻断性 Bug

- [x] **3.2** 真实站点复刻率复测（负责人：xiaopeng.lei）
  - **完成**：产出 `test-artifacts/t10-bilibili-recall.json`（8 bundle / 3.96 MB / oracle 35 条）：召回 **100%**（35/35，loose=false 旧默认 0%）、实打存活 **68.6%**（24/35，与 oracle 自身上限持平）；petstore OpenAPI 19/19；免开网页调用证据见 `api-command-security.test.mjs:208`–`:226`；导出导入闭环见 `api-command-cache.test.mjs:113`；并发写见 `api-command-cache.test.mjs:529`；调用方传值生效见 `api-command-render.test.mjs:367`。**口径说明**：oracle 裸路径 host 由实际探测确定，旧口径（裸路径记成扫描目标域名）已废弃。
  - 范围：B 站首页默认配置静态推导召回 ≥ 50%（基线 0%）、实打存活 ≥ 50%；petstore OpenAPI 19/19；免开网页调用成功率 ≥ 90%；导出 → 清空 → 导入闭环一致可调用；并发写不互删；调用方传值真正生效
  - 验收：AC-1 / AC-2 / AC-5 / AC-6 / AC-7 / AC-9 / AC-13 指标达标并留证（数据落 `test-artifacts/`）

- [x] **3.3** 文档同步（负责人：xiaopeng.lei）
  - **完成**：`78ae4ac` + `442f3e1` + `171d327` + `211fcbf` + 本次提交 — README 工具表新增 `export_api_commands` / `import_api_commands`；放开项说明按 T1–T10 实现重写；新增复合命令与 host 归属说明；中英 19 节同构、工具表各 44 条完全一致；`docs/api-command-set-upgrade-spec.md` §6 补「实现位置 + 实测结果」列；T12 后按新 HEAD `171d327` 重校 `specs/design.md` 第八节与覆盖报告的全部 file:line 引用（`api-command-service.ts` / `server.ts` 行号整体前移），并回填 T12 缺陷与 9 条回归用例；**T13 后再次全量重校** —— 新增 `api-command-evidence.ts` 与多处契约常量导致 8 个源文件行号再次整体漂移，`specs/design.md`（含新增 §8.1 T13 实现位置映射表）、`docs/api-command-set-upgrade-spec.md`、`test-artifacts/test-coverage-result.v1.json` 中的全部 `file:line` 已逐条核对到**确切标识符**（不只是非空行），并同步 326 → 354 用例计数与 T13 能力段落。
  - 范围：README / README.zh.md 工具表新增 `export_api_commands` / `import_api_commands` 并更新放开项说明；`docs/api-command-set-upgrade-spec.md` 与实现对齐
  - 验收：README 中英一致且与 `spec.md` 契约一致；`docs/` 描述与实际实现逐条对齐

---

**模板版本**：lite v1.0（派生自 full v2.2）
**最后更新**：2026-11-05

---

**执行结果（2026-11-05）**：`npm test` 354/354 pass ｜ `npm run doctor` 5 pass / 3 info / 0 warn / 0 fail ｜ 14/14 AC 通过 ｜ 代码审查 T11 修复 3 个可复现缺陷（补 8 条回归用例）+ T12 修复 1 个传输层强转可复现缺陷（补 9 条回归用例）+ T13 证据分级 / 歧义显式 / coverage 报告（补 28 条回归用例，修复前基线实测 10 条 FAIL）｜ 基线 gap 0 阻断 ｜ 本机部署实测通过（orbit §2.5 非 CI 路径）。

**产出物索引**：

| 产物 | 路径 |
|---|---|
| 覆盖结果（AC ↔ 用例 ↔ 实现位置） | `test-artifacts/test-coverage-result.v1.json` |
| 真实站点复刻率数据 | `test-artifacts/t10-bilibili-recall.json` |
| 升级规格（含 AC↔实现位置表） | `docs/api-command-set-upgrade-spec.md` |
| T13 证据分级 / 歧义 / coverage 回归用例 | `mcp-server/test/api-command-evidence.test.mjs` |
| T13 纯函数层（档位推导 / 歧义构造 / coverage 聚合） | `mcp-server/src/api-command-evidence.ts` |
| 任务状态 | `task-list.json` |

