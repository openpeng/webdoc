# 案例：阿里云 ARMS 应用监控控制台（网关型站点）

本仓第一个按交付物规范落地的复刻。原始报告：`docs/arms-tracing-replication-report.md`。
交付物：`docs/arms-tracing-replication/`。

**这份案例的价值不在 ARMS 本身，在于它暴露了「网关型站点 + 控制台鉴权」这一类站点的通用坑。**

---

## 1. 站点形态

| 项 | 值 |
|---|---|
| 页面 origin | `armsnext.console.aliyun.com` |
| 业务 API 主机 | `fecs.console.aliyun.com` ← **与页面 origin 不同** |
| 传输形态 | `POST {fecs}/data/api.json?<ActionName>`，form-urlencoded |
| body | `product=arms&action=<Action>&region=<Region>&params=<URL编码的 JSON>` |
| 批量 | `POST {fecs}/data/v2/multiApi.json?<A1>~<A2>`，body `actions=[{action,params}]`，响应按 `"0"`/`"1"` 索引 |
| 端点类型枚举 | `OPEN→/data/api.json`、`INNER→/data/innerApi.json`、`CONTAINER→/data/call.json`、`HTTP→/data/httpApi.json`、`CUSTOM→/data/custom.json`、`OPEN_MULTI→/data/v2/multiApi.json` |

**「页面 origin ≠ 业务 API 主机」是这类站点最常见的一号坑**：抓包按标签页域名归属会整批丢掉业务接口。

## 2. 鉴权：Cookie 与 Origin 缺一不可

A/B/C/D 四组对照（同一个 `GetTraceApp`）：

| 变体 | 结果 |
|---|---|
| 无 cookie 无 origin | `403 Forbidden` |
| 无 cookie 有 origin | `ConsoleNeedLogin` |
| 有 cookie 无 origin | `403 Forbidden` |
| **有 cookie 有 origin** | **`200` + 真实数据** |

根因：会话凭据 `login_aliyunid_ticket` 的 `SameSite=Lax` —— 扩展后台的跨站 fetch 带不上它，
所以必须由调用方**显式携带 Cookie 头**（手工指定不受 SameSite 约束）。

> 最初「只要 Cookie 就行」的判断被这张矩阵推翻。**鉴权判定必须靠矩阵，不能靠直觉。**

另外：控制台壳 API（`_fetcher_=Product__Action` 形态）额外要求 `collina=140#...` 反爬签名，
由页面内 `uaction.alicdn.com/AWSC/uab/.../collina.js` 计算 → **无法离线复现 → 明确排除**。

## 3. bundle 逆向拿到了什么

bundle：`g.alicdn.com/alfa/cloud-arms-app-tracing/0.0.174/index.js`（12.5 MB）。

还原出的请求构造器（压缩后形态）：

```js
fecs: "//fecs.console." + regionDomain + ".com"
function b(action, params, region) {
  var url = fecs + "/data/api.json?" + action;   // 动作名进 query
  params.aliyunLang ||= getLang();               // 自动注入 zh/en
  region ||= params.RegionId || currentRegion();
  var body = { product: "arms", action, region, params };
  return post(url, body, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
}
```

从中得到的可复用结论：
- 动作名全在 bundle 里 → 一次 grep 拿到 113 个动作风格字面量，过滤 UI 噪音后得到 ARMS 相关动作全集；
- `product` 默认 `arms`，但存在 cookie `x-arms-hacker-region-user` 时改成 `arms4admin` 并注入 `HackerUserId`（内部账号后门）；
- 端点类型枚举来自 console-base 的 fetcher 类型定义。

## 4. 四个通用坑（每个都踩过）

### 4.1 时间单位不一致，且**静默空结果**

- 列表/聚合接口 `startTime`/`endTime`：**毫秒**
- span 自身 `startTime`：**纳秒**
- `GetTraceChain` 的 `StartTime`/`EndTime`：**毫秒**（传纳秒 → `depth=-1` 的**空树**，不报错）

> 静默空结果比报错危险：报错会停下，空结果会被当成「这接口没数据」而错标档位。
> **遇到空结果先查参数形态与单位，再查端点存在性。**

### 4.2 `InvalidAction.NotFound` ≠ 端点不存在

首轮 29 个动作里 9 个失败：
- **7 个是参数错误**（`ParameterMissing` / `MissingAppType` / `MissingResourceId` / `ParameterTimeStampMissing`）→ 动作存在，缺参数名，**错误码直接点名了参数**；
- 5 个 `InvalidAction.NotFound` → 动作属于 **ResourceManager / tag 等其它 product**，不在 `product=arms` 下 → 换 product 再试。

> 「动作不存在」和「动作不属于这个 product」是两件事，混为一谈会误杀整片接口族。

### 4.3 响应体二次编码

`data.Data` 常常是**JSON 字符串**而非对象，需要再 parse 一次。客户端统一展开一层。

### 4.4 参数名有例外

`GetMetricDatas` 用 `Param` 而不是 `Query`；`GetOTTraceCallstackOverview` 用 `SpanTimeStamp`（比 `GetOTTraceCallstack` 的 `SpanTimestamp` 多一个 T）。
→ **不要假设同前缀动作的参数名一致**，逐个确认。

## 5. 杠杆点：列表型动作

`ListTraceApps` 一次带回 **314 个应用**（含 AppId / Pid / ClusterId / 标签），
是所有详情型动作的参数来源。

> 通用规律：**先找一次能带回大量真实 ID 的列表型动作**，它是整个复刻的杠杆点。
> 本仓的复合命令（`steps` + JSONPath 取值映射）就是把这条链固化成一条命令的机制。

## 6. 实测覆盖率

66 个条目 / 11 个资源域：**observed 24 / derived 35 / unknown 7**。

- 整域未实测：「性能剖析与调试数据」（12 个）、「XTrace」（4 个）——**报告里必须写明**；
- 10 个写操作标 `risk=write`（`SaveTraceAppConfig` / `CreateHeapDump` / `OpenService` / `UpgradeXTrace` 等），
  其中部分会触发线上变更（重启探针、升级链路）。

## 7. 与本仓产品链路的三处缺口（**快照，落笔前必须复核**）

> ⚠️ **本节是 2026-11-06 的快照，不是当前事实。** 本仓在并行开发中会改这些实现，
> 写报告时**必须核对当前代码**，不要照抄本节。
> 实例：本节初稿写「P1 form 体无处安放」，随后被本仓并行修复（`BODY_FORMATS` 增加 `form`、
> `groupBodyEncoding()` / `encodeFormBody()` 落地）——**照抄快照就会写出过时结论**。

| 缺口 | 定位 | 快照结论（需复核） |
|---|---|---|
| **P1** 非 JSON 请求体承载 | `buildBodyTemplate()` / `groupBodyEncoding()`（`api-command-generator.ts`）、`encodeFormBody()`（`api-command-render.ts`）、`BODY_FORMATS`（`api-command-types.ts`） | 初稿：form 体无处安放 → **后被修复为已支持**（复核后：ARMS 的扁平 form body 可被命令模型承载） |
| **P2** 执行期拿不到 Lax 会话 cookie | `cmdApiCommandExecute()`（`browser-extension/background.js`）+ `API_COMMAND_FORBIDDEN_HEADERS`（`api-command-types.ts` 与 `browser-extension/api-command-helpers.js` 两端同步） | 仍成立：扩展后台 fetch 带不上 Lax cookie；`Origin`/`Referer` 不在剔除名单里可以传，所以缺口只在 Cookie 这一项 |
| **P3** 业务 API 域名归属 | `normalizeRecords()` / `filterCandidates()`（`api-command-normalize.ts`） | 仍成立：按「host 精确等于目标域名」过滤（Q13 硬边界）；解法是**显式传 `domain`**，不是改过滤规则 |

> URL 形态本身**兼容**：网关接受 `?GetTraceApp=`（空值）与 `?GetTraceApp`（无等号）两种写法。

**处置原则**：缺口只报定位与最小方案，**不擅自改产品代码**——
域名白名单 / 紧急停止 / 目标 URL 校验 / 凭据头剔除都是用户拍板的安全边界。
