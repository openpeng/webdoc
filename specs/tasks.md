# WebPilot API 命令集升级 - 任务拆解（lite）

> 最后更新：2026-11-05
> 状态说明：⏳ 待开始 | 🔄 进行中 | ✅ 已完成 | ❌ 已阻塞
> lite 版：适用于中小需求（tier3+ 档位），单文件轻量拆解；API 响应契约以 spec.md 为准（lite 版不复制）。

---

## Phase 0：待确认问题

- [ ] **0.1** 复合命令（多步编排）中「上一步响应取值 → 下一步入参」的取值路径语法最终形态（负责人：xiaopeng.lei）
  - 状态：⏳ 待确认（用户已拍板纳入本需求、排最后做；语法细节在 **2.9** 开工前单独确认）
  - 影响面：仅 **2.9**（T9 复合命令）；**2.1**–**2.8** 不依赖本项，不阻塞
  - 处置：不猜、不用假设填空；未确认前 **2.9** 不开工，其余任务照常推进

## Phase 1：数据库变更（如有）

- ✅ **1.1** 本需求无数据库变更（负责人：xiaopeng.lei）
  - 说明：命令集以本地 JSON 文件落盘（`api-commands.json`），不引入任何表结构 / 迁移 / 索引变更
  - 验收：无 DDL 产生，`npm run doctor` 0 fail

## Phase 2：后端开发

> 遵循 Controller → Facade → Service → DAO 分层；接口契约（字段/类型/错误码）以 spec.md 为准，逐字段比对。
> 本需求仓库形态为「MCP Server（后端）+ Chrome MV3 扩展（端侧）」，无独立 Web 前端；扩展侧任务在同一条目内标注「[扩展侧]」。
> 全局硬约束：域名白名单、紧急停止、目标 URL 校验（协议 + hostname 精确相等 + 不跟随跳转）三项**一行不改**。

- [ ] **2.1** T1 静态推导放开：`loosePaths` / `trustSpec` 默认放开 + 扩展侧 bundle 发现优先 + `needsReview` 降为 1 条来源标注（负责人：xiaopeng.lei）
  - 落点：`api-command-types.ts` / `api-command-service.ts` `scanSite()` / `api-command-site-scan.ts`
  - 验收：AC-1 通过（不传 `loosePaths` 端点数 ≥ 1，B 站基线 0）；AC-2 通过（GET/HEAD/OPTIONS → `risk=read`，其余 `write`）；新增用例 ≥ 1 条

- [ ] **2.2** T2 路径归一与 method 修复：协议相对 URL（`//host/path`）不再整体当路径、候选自带 host 并在 host ≠ domain 时标 `crossHost`、`inferMethod` 扩展识别 `axios({method})` / 对象字面量 `method` / `$.ajax({type})`（负责人：xiaopeng.lei）
  - 落点：`api-command-site-scan.ts` / `api-command-generator.ts`
  - 验收：AC-13 通过（petstore OpenAPI 19/19 路径命中）；协议相对 URL 不再被当路径；新增用例 ≥ 1 条

- [ ] **2.3** T4 值落盘放开 + 常量参数改写为 `{{name}}` 占位符 + 响应敏感字段默认不强制打码（负责人：xiaopeng.lei）
  - 落点：`api-command-normalize.ts` / `api-command-cache.ts` / `api-command-generator.ts` / `api-command-render.ts` / `api-command-response-schema.ts`
  - 验收：AC-5 通过（调用方传 `params.nickname="lisi"` 实际发出 `lisi`，基线发出 `zhangsan`）；标量样本值可落盘且字符串长度 ≤ 200；`strictRedaction` 默认 false；新增用例 ≥ 1 条

- [ ] **2.4** T3 请求头放开：全部非凭据头放行，仅剔除 `Cookie` / `Authorization` / `Proxy-Authorization` / `Set-Cookie`（负责人：xiaopeng.lei）
  - 落点：`api-command-types.ts` / `api-command-render.ts` / `api-command-service.ts` / **[扩展侧]** `browser-extension/api-command-helpers.js` `rebuildExecuteOptions()` / `browser-extension/background.js` `cmdApiCommandExecute()`
  - 验收：AC-6 通过（请求含 `X-Requested-With`，不含 `Cookie` / `Authorization`）；`EXECUTE_OPTIONS_ALLOWED_KEYS` 含 `headers`；两端常量逐字同步断言通过；新增用例 ≥ 1 条

- [ ] **2.5** T5 导出 / 导入闭环 + `source.origin` 来源标注 + 成品格式命令包导入（负责人：xiaopeng.lei）
  - 落点：`api-command-types.ts` / `api-command-cache.ts` / `api-command-site-scan.ts` / `server.ts`（新增 `export_api_commands` / `import_api_commands` 两个 MCP 工具）
  - 验收：AC-7 通过（导出 → 清空 → 导入后条数 / 名称 / 参数 / 响应裁剪规则一致且可直接调用）；AC-8 通过（成品格式导入 ≥ 1 条且 `request.urlTemplate` / `risk` / `responseFields` / `manuallyEdited` 被保留）；新增用例 ≥ 1 条

- [ ] **2.6** T6 缓存一致性：写盘前重读并按 hostname 合并 + 唯一 tmp 文件名 + `loadFailed` 保护（负责人：xiaopeng.lei）
  - 落点：`api-command-cache.ts` `persist()` / `ensureLoaded()`
  - 验收：AC-9 通过（两个进程先后写不同域名，磁盘上两个域名的命令都存在）；tmp 名含 pid + 时间戳；读失败状态下只写本次新增域名；新增用例 ≥ 1 条

- [ ] **2.7** T7 破坏性默认值修复 + 只读门改按 method 派生（负责人：xiaopeng.lei）
  - 落点：`server.ts` `invalidate_api_commands` / `api-command-service.ts` `invalidate()` / **[扩展侧]** `browser-extension/background.js` `assertCommandAllowed()`
  - 验收：AC-10 通过（`action` 缺失或非法返回 `INVALID_PARAMS` 且该域名命令不被删除）；AC-12 通过（只读模式下 `risk=read` 但 `method=POST` 被扩展侧拒绝）；三项硬边界一行未改；新增用例 ≥ 1 条

- [ ] **2.8** T8 `ai_search` 修正：SSE 增量判定改显式标记 + 改流式读取 + `timeoutMs` 改跨通道总预算 + `attempts` 真实计数（负责人：xiaopeng.lei）
  - 落点：`baidu-ai-search.ts` `parseBaiduBaikanSse()` / `api-command-service.ts` `fetchBaikanSse()` / `aiSearch()`
  - 验收：AC-14 通过（三个连续「哈」拼接得「哈哈哈」，基线得「哈」）；收到结束标记即返回已收内容；无 ~4× 超时放大；新增用例 ≥ 1 条

- [ ] **2.9** T9 复合命令（多步编排）—— 排最后，前置依赖 2.1–2.8 全部完成（负责人：xiaopeng.lei）
  - 落点：`api-command-types.ts`（`ApiCommand.steps`）/ `api-command-render.ts`（`resolveCompositeSteps()`）/ `api-command-service.ts` `call()`
  - 前置：**0.1** 取值路径语法须先与用户确认
  - 验收：AC-3、AC-4 在复合命令路径同样成立（缺参 → `MISSING_PARAMS`、`risk=write` 未确认 → `CONFIRMATION_REQUIRED`，均零网络请求）；上一步响应按 `from` 路径取值注入下一步 `params`；新增用例 ≥ 1 条

- [ ] **2.10** 扫描与覆盖回填：按 design.md 第八节 AC ↔ 实现位置映射，人工回填执行证据（负责人：xiaopeng.lei）
  - 落点：`test-artifacts/test-coverage-result.v1.json`（由 `orbit_test_artifacts mode=record` 写入）
  - 验收：14 条 AC 均有对应执行用例编号与证据引用；基线 gap `UNMAPPED_ACCEPTANCE_CRITERIA` 显式登记处置（不伪造自动映射）

## Phase 3：测试（QA）

- [ ] **3.1** 功能测试与回归（负责人：xiaopeng.lei）
  - 范围：`npm test` 全绿（存量 245 条零回归 + 各批次新增用例）；`npm run doctor` 0 fail；AC 全部通过，无阻断性 Bug
  - 专项回归：AC-11 —— 扩展域名白名单外的目标被拒绝且零网络请求（硬边界不变）；AC-3 / AC-4 —— 缺参与未确认均零网络请求
  - 验收：AC-1 ~ AC-14 全部通过，无阻断性 Bug

- [ ] **3.2** 真实站点复刻率复测（负责人：xiaopeng.lei）
  - 范围：B 站首页默认配置静态推导召回 ≥ 50%（基线 0%）、实打存活 ≥ 50%；petstore OpenAPI 19/19；免开网页调用成功率 ≥ 90%；导出 → 清空 → 导入闭环一致可调用；并发写不互删；调用方传值真正生效
  - 验收：AC-1 / AC-2 / AC-5 / AC-6 / AC-7 / AC-9 / AC-13 指标达标并留证（数据落 `test-artifacts/`）

- [ ] **3.3** 文档同步（负责人：xiaopeng.lei）
  - 范围：README / README.zh.md 工具表新增 `export_api_commands` / `import_api_commands` 并更新放开项说明；`docs/api-command-set-upgrade-spec.md` 与实现对齐
  - 验收：README 中英一致且与 `spec.md` 契约一致；`docs/` 描述与实际实现逐条对齐

---

**模板版本**：lite v1.0（派生自 full v2.2）
**最后更新**：2026-11-05
