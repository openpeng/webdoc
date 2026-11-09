# 逆向复刻报告：阿里云 ARMS 应用监控控制台（无 UI API 模式）

> 目标站点：`https://armsnext.console.aliyun.com/tracing#/tracing/cn-hangzhou?appId=<appId>&tab=appOverview&source=TRACE&language=java`（已登录态）
> 复刻目标：把 ARMS 应用监控控制台从「必须开页面」转成「可直接调用的 API」，
> 并给出可复现的动作目录、鉴权模型与端到端验证证据。
> 结论：**已达成**。65 个动作入目录（24 个实测取到业务数据），纯 HTTP 无浏览器调用闭环跑通。

配套产物：`docs/arms-tracing-replication/`（客户端 + 动作目录）。

---

## 一、结论摘要

| 项 | 结论 |
|---|---|
| 接口形态 | **单一 RPC 网关**：`POST {fecs}/data/api.json?<ActionName>`，动作名在 query，参数在 form body 的 `params`（JSON 字符串） |
| 业务主机 | `fecs.console.aliyun.com`（页面 origin 是 `armsnext.console.aliyun.com`，**两者不同**） |
| 鉴权 | `Cookie: login_aliyunid_ticket` **且** `Origin/Referer` 指向控制台域名 —— **缺一不可**（实测四组对照） |
| 批量 | `POST /data/v2/multiApi.json?<A1>~<A2>...`，body 为 `product=arms&actions=[...]` —— 实测 4 个动作一次 HTTP 全通 |
| 动作目录 | 66 个（observed 24 / derived 35 / unknown 7），按 **11 个资源域**组织，其中 10 个写操作已标 `risk=write` |
| 无 UI 调用 | ✅ 已验证：纯 Node `fetch` + 显式 Cookie 头，拿到真实拓扑、慢接口、调用链数据 |

---

## 二、逆向方法与证据来源

按「先观测、后推导、再实测」三层取证，不靠猜：

| 证据层 | 来源 | 产出 |
|---|---|---|
| L1 观测 | CDP 抓包（WebPilot `start_network_capture`），刷新首屏 | 16 条 `fecs` 业务调用（真实 URL + 真实 body） |
| L2 推导 | 前端 bundle `g.alicdn.com/alfa/cloud-arms-app-tracing/0.0.174/index.js`（12.5 MB）逆向 | 网关构造器代码 + 113 个动作字面量 |
| L3 实测 | 自建客户端逐动作真实请求 | 24 个动作拿到业务数据，错误码反推参数缺口 |

**L2 的关键收获**（bundle 内的请求构造器，已还原）：

```js
// fecs 主机：按地域后缀切换
fecs: "//fecs.console." + regionDomain + ".com"      // cn-* → aliyun.com，海外 → aliyuncs.com

// 单动作请求
function b(action, params, region) {
  var url = fecs + "/data/api.json?" + action;         // ← 动作名进 query
  params.aliyunLang ||= getLang();                     // 自动注入 zh/en
  region ||= params.RegionId || currentRegion();
  var body = { product: "arms", action, region, params };
  return post(url, body, {                            // ← form-urlencoded，不是 JSON
    transformRequest: [ /* URLSearchParams 风格编码 */ ],
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
}
```

附带还原出的端点类型枚举（console-base 的 fetcher 类型）：

```
OPEN → /data/api.json        INNER → /data/innerApi.json
CONTAINER → /data/call.json  HTTP → /data/httpApi.json
CUSTOM → /data/custom.json   OPEN_MULTI → /data/v2/multiApi.json
```

以及一处内部账号后门（正常用户不受影响）：存在 cookie `x-arms-hacker-region-user` 时，
`product` 会被改成 `arms4admin` 并向 params 注入 `HackerUserId`。

---

## 三、鉴权模型（实测四组对照）

同一个 `GetTraceApp` 请求，只改「有没有 Cookie」与「有没有 Origin/Referer」：

| 变体 | 结果 |
|---|---|
| A 无 cookie、无 origin | `code=403 Forbidden` |
| B 无 cookie、有 origin | `code=ConsoleNeedLogin` |
| C 有 cookie、无 origin | `code=403 Forbidden` |
| D **有 cookie、有 origin** | **`code=200`，拿到 AppName=<appName-1>** |

**两个变量缺一不可**，且失败顺序是「先查 origin，再查登录态」。

> ⚠️ 我最初判断「只要 Cookie 就行」是错的 —— 矩阵实验推翻了它。结论已按实测修正。

### 为什么「扩展上下文执行」这条路走不通

会话凭据 `login_aliyunid_ticket` 的 `SameSite=Lax`。浏览器扩展后台发起的 `fetch` 是**跨站请求**，
Lax cookie 不会被带上网关 → 网关判定未登录 → 302 到登录页（实测重放拿到的是淘宝错误页）。
实测的 cookie 清单里只有 `cna / aliyun_lang / aliyun_site / isg / tfstk / SCHEDULERX-XSRF-TOKEN`
这几个是 `SameSite=None`（可跨站），真正的会话 cookie 全是 Lax。

**结论：ARMS 的无 UI 调用必须由调用方显式携带 `Cookie` 头**（手工指定 Cookie 头不受 SameSite 约束）。

### 控制台壳 API 另有一道签名

`armsnext.console.aliyun.com` 上的壳 API（ResourceCenter / notifications / Workorder 等）额外带
`collina=140#...` 反爬签名，由页面内 `uaction.alicdn.com/AWSC/uab/1.140.0/collina.js` 计算。
**该签名无法在无 UI 模式下离线复现** → 这部分接口标记为「壳功能，不纳入无 UI 复刻」。

---

## 四、动作目录与实测覆盖率

目录见 `docs/arms-tracing-replication/arms-catalog.json`（66 个动作，按 11 个资源域组织）。
**按资源域分组的可读版**见 `docs/arms-tracing-replication/arms-action-catalog.md`。

| 资源域 | 动作数 | observed | derived | unknown |
|---|---:|---:|---:|---:|
| 应用与配置 | 8 | 4 | 3 | 1 |
| 拓扑与聚合指标 | 7 | 4 | 3 | 0 |
| 调用链 Trace | 7 | 4 | 3 | 0 |
| 实例与探针 | 6 | 3 | 3 | 0 |
| 告警与事件 | 2 | 2 | 0 | 0 |
| 标签与资源组 | 6 | 1 | 0 | 5 |
| 数据源与 SLS | 8 | 3 | 5 | 0 |
| 商业化与配额 | 3 | 2 | 0 | 1 |
| 性能剖析与调试数据 | 12 | 0 | 12 | 0 |
| XTrace（新版链路追踪） | 4 | 0 | 4 | 0 |
| 用户与通用 | 3 | 1 | 2 | 0 |
| **合计** | **66** | **24** | **35** | **7** |

档位含义：`observed` = 真实请求验证过 `code=200` 且拿到业务数据，参数形态已实测；
`derived` = 动作名 + 参数形态来自 bundle 逆向，未逐个实测或未取到业务数据；
`unknown` = 仅确认动作名存在，参数形态未知（**不猜**）。

实测统计（首轮 29 个动作 → 20 个直接 `code=200`；参数修正后累计 24 个 observed）：

- 首轮 9 个失败项里，**7 个是参数错误而非端点不存在**（`ParameterMissing` / `MissingAppType` /
  `MissingResourceId` / `ParameterTimeStampMissing`）→ 动作确实存在，缺的是参数名；
- 5 个返回 `InvalidAction.NotFound`（`DescribeUserQuota` / `GetResourceGroup` / `ListResourceGroups` /
  `ListTagKeys` / `ListTagValues`）→ 这些属 **ResourceManager / tag 等其它 product**，不在 `product=arms` 下；
- `QueryTopology` 返回 `InternalError` → 端点在、payload 形态未还原，保持 `derived`，不猜。

实测取到的真实数据（节选）：

| 接口 | 真实返回 |
|---|---|
| `ListTraceApps` | **314 个应用**（含 `<appName-pattern>` 系列，AppId / ClusterId / 标签） |
| `GetTraceAggr` | `topologyMap.nodes`（`<appName-2>`、`mysql`…）+ `edges`（`source/target` 含 `mysql`/`redis`）+ `spanTraceStatInfo[]`（`rpc=/portal/v1/<module>/<action>`、`count`、`elapsedSum`） |
| `GetMetricDatas` | `count = 49,834,253`（窗口内调用总量） |
| `GetTraceChain` | `depth=3`、`traceChainComplete=true`、`roots[0]` 含 `serviceName / ip / resources.acs.cms.workspace / telemetry.sdk.name=zipkin` |
| `GetAgentInfoByPage` | 8 个探针实例（版本 `3.2.10`、`Hostname`、运行时长 `4天0小时38分`） |
| `DescribeTraceEndpoint` | SLS `Project=proj-xtrace-…-cn-hangzhou`、`Logstore=logstore-tracing`（Token/LicenseKey 服务端已打码） |

---

## 五、端到端无 UI 调用链（实测闭环）

### 5.1 应用概览

```
GetTraceApp（应用元信息）
  └─ GetTraceAggr（RegionId, Pid, Datasource=clickhouse, Query{startTime,endTime,pageSize}）
       → 拓扑 + 慢接口统计
```

### 5.2 调用链下钻（三跳）

```
GetOTTraceBriefInfos（Datasource=sls, Query{startTime,endTime,page,pageSize}）
  → spans[]: {traceId, spanId, serviceName, spanName, duration, startTime(纳秒)}

GetTraceChain（RegionId, TraceId, Datasource=sls, StartTime/EndTime(毫秒), FilterComponentNames）
  → {depth, roots[], spanNums, componentNames, maxDuration}
```

> **时间单位是这条链的坑**：列表接口的 `startTime` 是毫秒，而 span 自身的 `startTime` 是**纳秒**。
> `GetTraceChain` 的 `StartTime/EndTime` 必须用毫秒；用纳秒会返回 `depth=-1` 的空树（不报错，静默空结果）。

### 5.3 批量

```
POST /data/v2/multiApi.json?GetTraceApp~GetUserInfo~GetTraceGroupBy~GetTraceCommercialStatus
body: product=arms&actions=[{action,params},...]
→ data: {"0":{success:true,code:"200",data:{...}}, "1":{...}, "2":{...}, "3":{...}}
```

实测 4 个动作**一次 HTTP 全部 success=true**。

---

## 六、与本仓产品链路的关系（能用什么 / 不能用什么）

> ⚠️ **本章结论已按工作区当前实现复核过。** 初次分析时我判定「form 请求体无处安放」（P1），
> 该结论**已过时**：本仓在本次复刻期间由并行开发把 form 承载补上了。下表是复核后的现状。

### P1 · form-urlencoded 请求体 —— ✅ **已修复**（本仓当前实现已支持）

- 归一化层解析 form 体：`api-command-normalize.ts` 的 `parseBodyFields()` 解析出
  `product / action / region / params` 四个 body 字段（`isJson:false`）。
- 生成层当前**已支持** form：`api-command-types.ts` 的 `BODY_FORMATS = ["json","form"]`；
  `api-command-generator.ts` 的 `groupBodyEncoding()` 按记录判 `json / form / other / none`，
  `buildBodyTemplate()` 对 `form` 同样产出模板，并回填 `request.bodyFormat`。
- 渲染层 `api-command-render.ts` 的 `encodeFormBody()` 按 `URLSearchParams` 语义编码
  （空格编成 `+`，对象/数组按 JSON 字符串落盘）—— 恰好匹配 ARMS 的
  `product=arms&action=X&region=Y&params=<JSON>` 形态（四个扁平字符串字段）。
- 形态无法表示的体（纯文本/二进制/JSON 数组）走 `other` 分支：**不生成 bodyTemplate 并显式进 needsReview**，
  不做静默截断。

> 结论：**ARMS 的请求体现在可以被本仓命令模型完整承载**。

### P2 · 执行期拿不到 Lax 会话 cookie —— ❌ 仍在（有意为之的安全边界）

`browser-extension/background.js` 的 `cmdApiCommandExecute()` 在**扩展后台**发 `fetch(credentials:'include')`，
且 `API_COMMAND_FORBIDDEN_HEADERS`（`api-command-types.ts` 与 `browser-extension/api-command-helpers.js` 两端同步）
仍明确剔除 `cookie` —— 而 ARMS 的会话 cookie 是 Lax，扩展后台带不上。
`Origin` / `Referer` **不在**剔除名单里（可以传），所以缺口只集中在 Cookie 这一项。

这是**用户拍板的安全边界**，本轮未动、也不建议放开。

### P3 · 抓包通道的域名归属 —— ⚠️ 使用约束，非阻塞

业务 API 在 `fecs.console.aliyun.com`，页面 origin 在 `armsnext.console.aliyun.com`。
`normalizeRecords()` / `filterCandidates()` 按「host 必须精确等于目标域名」过滤（Q13 硬边界）。
解法是**显式传 `domain="fecs.console.aliyun.com"`**，而不是改过滤规则。

### 结论（复核后）

| 目标 | 可行性 |
|---|---|
| 独立脚本 / CI 定时任务调 ARMS 数据 | ✅ **已交付**（`arms-api.mjs`，本轮全程实测） |
| WebPilot 内 `list_api_commands` 管理 ARMS 命令 | ✅ 可行（form 体已能承载；命令来源用成品命令包 `kind:"commands"`，或抓包通道 + 显式 `domain`） |
| WebPilot 内 `call_api_command` 直接跑 ARMS | ❌ 仍卡在 P2：扩展后台带不上 Lax 会话 cookie，且 cookie 是有意的剔除项 |

> 即：**命令可以进 WebPilot 了，但要在 WebPilot 内直接执行还得解决 cookie 传递**。
> 在那之前，独立客户端（显式带 Cookie 头）是唯一跑通的执行路径。

---

## 七、交付物

| 文件 | 说明 |
|---|---|
| `docs/arms-tracing-replication/arms-api.mjs` | 无 UI 客户端：单动作 / 批量 multiApi / `--from-catalog` 取目录参数 / `--set k=v` 覆盖 / `--pick` 取值 / `--list` 列目录 |
| `docs/arms-tracing-replication/arms-catalog.json` | 66 个动作的目录：资源域、参数形态、数据结构、证据档位、风险标记、鉴权模型、端点类型枚举 |
| `docs/arms-tracing-replication/arms-action-catalog.md` | **按 11 个资源域分组的可读版动作目录**（由 `gen-catalog-doc.mjs` 从 JSON 生成） |
| `docs/arms-tracing-replication/gen-catalog-doc.mjs` | 目录文档生成器：校验资源域/档位/风险合法性（fail-closed）+ 生成 Markdown；不改动目录 JSON |
| `docs/arms-tracing-replication/README.md` | 快速上手（含 cookie 导出步骤） |
| `docs/arms-tracing-replication-report.md` | 本报告 |

**交付物形状规范**已沉淀为 skill `.minimax/skills/webdoc-replication-deliverables`：
字段契约见其 `references/deliverable-shapes.md`，坑位与手法见 `references/case-study-arms.md`，
脚手架 `scripts/scaffold-replication.mjs` 可为新站点生成同形状的一套交付物。
本套交付物即按该规范产出（目录 JSON 为唯一事实源，Markdown 目录由脚本生成且生成器 fail-closed）。

**用法**（先导出 cookie，见 README）：

```bash
node docs/arms-tracing-replication/arms-api.mjs --list
node docs/arms-tracing-replication/arms-api.mjs \
  --action GetTraceApp --from-catalog --set 'Pid=<appId>' \
  --cookie-file cookie.txt --pick data.TraceApp
node docs/arms-tracing-replication/arms-api.mjs \
  --multi GetTraceApp,GetUserInfo --from-catalog --cookie-file cookie.txt
```

---

## 八、遗留与风险

1. **凭据管理**：会话 cookie 有效期约等于浏览器登录态，客户端不做续期；cookie 文件请勿入库。
   导出时只取 `.aliyun.com` 域下的会话 cookie，不要整包导出浏览器全部 cookie。
2. **`derived` 档 35 个动作**参数形态来自 bundle 静态推导，未逐个实测；接入前请先用真实请求验证，
   不要直接当作已知契约使用。其中「性能剖析与调试数据」「XTrace」两个资源域 **一个都没实测过**。
3. **`QueryTopology` / `SearchTraceAppByName`** 的必填参数名未还原，保持 `unknown`，未猜。
4. **写操作 10 个**（`SaveTraceAppConfig` / `CreateHeapDump` / `OpenService` / `UpgradeXTrace` 等）已标
   `risk=write`，但其中部分会触发线上变更（重启探针、升级链路），接入前必须人工确认。
5. **地域差异**：`fecs` 主机名按地域后缀切换，海外地域为 `fecs.console.aliyuncs.com`，
   客户端已支持 `--host` / `--region` 覆盖。
6. **未纳入复刻**：控制台壳 API（ResourceCenter / notifications / Workorder / occa-myalicloud），
   原因见 §三（`collina` 反爬签名不可离线复现）。
7. **产品改动未做**：本轮未改产品代码、未动任何硬边界（域名白名单 / 紧急停止 / 目标 URL 校验 / 凭据头剔除）。
   §六 的 P1（form 体承载）已由本仓并行开发修复，本报告结论按当前实现复核过；
   剩下的 P2（cookie 传递）是有意的安全边界，**不建议放开**——需要时走「显式开关 + 默认关闭」。
