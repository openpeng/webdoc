# 复刻交付物形状规范

本文件定义「一次网站 → API 复刻」应当落成哪些文件、每个文件是什么形状。
**它是规范，不是模板**：照着做能保证不同站点的交付物口径一致、可被下一个模型读懂。

落位目录约定：`<repo>/docs/<site-slug>-replication/`

```
docs/<site-slug>-replication/
├── <site-slug>-api.mjs        # 客户端（目录驱动）
├── <site-slug>-catalog.json   # 目录（唯一事实源）
├── gen-catalog-doc.mjs        # 目录文档生成器（fail-closed）
├── <site-slug>-action-catalog.md  # 按资源域组织的可读目录（生成产物）
└── README.md                  # 快速上手
docs/<site-slug>-replication-report.md   # 逆向报告（放 docs/ 根，与交付目录同级）
```

---

## 1. `<site-slug>-catalog.json` —— 唯一事实源

机器读的目录。**所有**参数形态、证据档位、风险、资源域归属都在这里；
Markdown 目录由脚本从它生成，不手写第二份。

```jsonc
{
  "version": 1,

  "site": {
    "name": "站点中文名",
    "pageUrl": "带参数的目标页面 URL",
    "pageOrigin": "armsnext.console.aliyun.com",     // 页面 origin
    "apiHosts": ["fecs.console.aliyun.com"],          // 业务 API 主机（可能 ≠ pageOrigin）
    "region": "cn-hangzhou",
    "regionNote": "主机名/参数随地域变化的规律"
  },

  "transport": {
    "kind": "rpc-gateway",        // rpc-gateway | rest | graphql | mixed
    "endpoint": "/data/api.json",
    "method": "POST",
    "contentType": "application/x-www-form-urlencoded",
    "body": "product=arms&action=<Action>&region=<Region>&params=<URL编码的 JSON>",
    "batch": {
      "endpoint": "/data/v2/multiApi.json",
      "query": "<A1>~<A2>~...",
      "body": "product=arms&actions=[{\"action\":\"...\",\"params\":{...}}]",
      "responseIndex": "data 按 \"0\"、\"1\" 索引回每个动作的结果"
    },
    "auth": {
      "required": ["Cookie: login_xxx", "Origin: https://..."],
      "abMatrix": { "有cookie有origin": "200", "无cookie有origin": "ConsoleNeedLogin" },
      "conclusion": "一句话结论：能不能脱离浏览器、缺什么",
      "sameSiteNote": "会话 cookie 的 SameSite 值及其后果",
      "excluded": ["依赖页面内反爬签名、无法离线复现的接口族"]
    },
    "response": {
      "envelope": "{requestId, code, message, data, successResponse}",
      "successRule": "code === \"200\"（字符串）",
      "doubleEncodedFields": ["data.Data"]
    }
  },

  "resources": [
    { "id": "应用与配置", "description": "应用元信息、模块与探针配置" }
  ],

  "entries": [
    {
      "id": "GetTraceApp",
      "kind": "action",            // action（网关动作） | endpoint（REST 端点）
      "resource": "应用与配置",     // 必须命中 resources[].id
      "method": "POST",
      "path": "/data/api.json",
      "params": { "RegionId": "cn-hangzhou", "Pid": "<pid>" },
      "dataShape": "TraceApp（AppName / AppId / Pid / Tags ...）",
      "evidence": "observed",      // observed | derived | unknown
      "provenance": {              // 可选：三维细分；给出时 evidence 应等于三维里的最弱档
        "endpoint": "derived", "params": "derived", "response": "unknown"
      },
      "risk": "read",              // read | write
      "note": "查应用元信息；Pid 取自页面 URL 的 appId"
    }
  ],

  "excluded": [
    { "host": "...", "actions": ["..."], "reason": "需要 collina 反爬签名，无 UI 模式不可复现" }
  ]
}
```

### 字段规则（生成器会逐条校验）

| 字段 | 规则 |
|---|---|
| `entries[].id` | 全表唯一 |
| `entries[].kind` | `action` 或 `endpoint` |
| `entries[].resource` | **必须**命中 `resources[].id`；命中不了 → 生成器报错退出 |
| `entries[].evidence` | `observed` / `derived` / `unknown`，三选一 |
| `entries[].provenance` | 可选三维细分（endpoint/params/response）；给出时 `evidence` 必须等于三维里的**最弱档** |
| `entries[].risk` | `read` / `write` |
| `entries[].params` | **样例形态**，不是 schema；`params` 这类嵌套值允许是 JSON 字符串 |
| `entries[].dataShape` | 返回结构描述，只写结构不写样本值 |

### 三档证据的判据

| 档位 | 判据 | 不算 observed 的情形 |
|---|---|---|
| `observed` | 真实请求返回业务成功且拿到数据 | 只拿到错误码、拿到空结果、只从 bundle 推出来的 |
| `derived` | 动作名/端点与参数形态来自前端代码或规格 | 未发过真实请求 |
| `unknown` | 只确认名字存在 | 连参数名都不知道 |

**错误码是观测到的响应体**，属于 observed 证据：它证明「这个参数名必填」，不证明「其它参数不存在」。
拿到 `ParameterMissing` 就把参数名回填进 `params` 并标 `derived`→（补齐后重测成功再标 `observed`）。

### 单一档位 vs 三维细分

交付物口径用**单一 `evidence`**（读者一眼能懂）；需要更细时补 `provenance` 三维
（endpoint / params / response），此时 `evidence` = 三维最弱档。
典型场景：端点与参数都确认了，但响应结构没拿到样本 → `provenance={derived,derived,unknown}`，
`evidence=unknown`。**只写三维不写总档位，读者无法排序**；只写总档位不写三维，读者无法定位短板。

### 资源域（resource）是给人看的维度

- 资源域只影响**组织与检索**，不影响客户端执行；
- 分域标准按「用户视角的资源」而不是按 URL 前缀（如「调用链 Trace」「标签与资源组」）；
- 一个条目只能属于一个域；域名在 `resources[]` 里登记后才允许被引用。

---

## 2. `<site-slug>-api.mjs` —— 客户端

Node.js ESM，**零第三方依赖**（只用 `node:fs` / `node:path` + 全局 `fetch`）。

### CLI 契约

| 参数 | 说明 |
|---|---|
| `--action <Id>` | 调单个条目（`kind=action` 用 `id`；`kind=endpoint` 用 `id`） |
| `--multi A,B,C` | 批量（网关型站点走 `transport.batch`） |
| `--from-catalog` | 以目录里记录的 `params` 为基底 |
| `--params <json>` / `--params-file <path>` | 整体覆盖参数 |
| `--set k=v` | 单参数覆盖，可重复 |
| `--pick <点路径>` | 只输出响应中的某字段 |
| `--cookie-file <path>` / `--cookie <str>` / `ARMS_COOKIE` | 凭据来源（三选一） |
| `--host <hostname>` / `--region <id>` | 覆盖站点默认 |
| `--list` | 按资源域分组列出全部条目 |
| `--strict` | 条目不在目录里就拒绝调用 |

### 行为约束

1. **凭据只从 `--cookie-file` / `--cookie` / 环境变量读**，绝不硬编码进仓库；仓库里只留占位符。
2. **退出码语义化**：`0` 成功 / `2` 参数错（含缺凭据）/ `3` 被重定向（凭据过期）/ `4` 业务返回非 200。
3. **展开一层二次编码**：很多网关的 `data.Data` 是 JSON 字符串，客户端自动 parse 一次。
4. **不发请求就退出**：参数校验不过时零网络请求（与本仓 `call_api_command` 的闸门一致）。
5. `--multi` 的每个条目独立结算：一个失败不拖垮其余，输出里逐条标 `success` / `code`。

### 最小可用骨架

```js
// 目录驱动的核心循环（示意）
const entry = catalog.entries.find((e) => e.id === action);
const params = { ...(args["from-catalog"] ? entry?.params : {}), ...overrides };
const url = `https://${host}${transport.endpoint}?${encodeURIComponent(action)}`;
const body = new URLSearchParams({ product, action, region, params: JSON.stringify(params) }).toString();
const resp = await fetch(url, { method: "POST", headers: { /* Cookie + Origin + Referer */ }, body, redirect: "manual" });
```

---

## 3. `gen-catalog-doc.mjs` —— 目录文档生成器

**目录 JSON 是唯一事实源，Markdown 由脚本生成。** 手写两份必然漂移。

### 硬要求

1. **fail-closed 校验**：条目缺 `resource` / `resource` 不在 `resources[]` 里 / `id` 重复 /
   `evidence`·`risk`·`kind` 枚举非法 → 打印问题清单并 `exit(1)`。
   为什么要这么严：漏项会在你不知情的时候少交付一个动作，而目录本身看起来是完整的。
2. **幂等**：跑两遍输出稳定（只允许 JSON 回写字段，不允许追加重复内容）。
3. **只校验，不改写**：`entries[].resource` 由作者直接写进目录 JSON，生成器只做校验与生成，
   不回写任何字段——避免「脚本悄悄改了事实源」这类说不清的副作用。
4. 只用 `node:fs`；不联网、不读凭据。

### 生成的 Markdown 结构

```
# <站点> 动作目录（按资源域）
## 总览（资源域 × 档位 交叉表 + 合计）
## 调用形态（所有条目共用）
## <资源域>（每个域一张表：动作 | 档位 | 风险 | 关键参数 | 返回结构 | 说明）
## 实测样例（真实数据）
## 已知坑
```

---

## 4. `<site-slug>-replication-report.md` —— 逆向报告

固定八章，缺哪章就说明那一块没做（写「未做」也比删掉好）：

| 章 | 内容 | 判据 |
|---|---|---|
| 一、结论摘要 | 表格：接口形态 / 业务主机 / 鉴权 / 批量 / 目录规模 / 无 UI 可行性 | 读完这一章能决定要不要用 |
| 二、逆向方法与证据来源 | 分层取证表（L1 观测 / L2 推导 / L3 实测）+ 关键代码还原 | 每条结论能追到某一层 |
| 三、鉴权模型 | A/B/C/D 对照矩阵 + 结论 + 为什么某条路走不通 | 有矩阵，不只有结论 |
| 四、动作目录与实测覆盖率 | 资源域 × 档位交叉表 + 实测统计 + 真实数据抽样 | 覆盖率按域名级真值给 |
| 五、端到端调用链 | 实际跑通的链路（列表→详情、下钻、多步） | 贴真实请求形态 |
| 六、与本仓产品链路的关系 | 能用什么 / 不能用什么 / 缺口定位到**标识符** | 缺口给定位与最小方案，**不改产品代码** |
| 七、交付物 | 文件清单 + 用途 + 用法示例 | 文件确实存在 |
| 八、遗留与风险 | 未实测的域 / 写操作副作用 / 凭据管理 / 地域差异 / 明确排除的部分 | 诚实标注覆盖边界 |

### 写作纪律

- **引用定位用标识符，不用行号**（`buildBodyTemplate()`、`cmdApiCommandExecute()`），行号会漂；
- 报告里**不回显凭据值**，只写字段名；
- 覆盖率必须带口径（域名级 / 批次级），批次级会高估；
- 明确写出**哪些条目一个都没实测过**（例：「性能剖析与调试数据」整域未实测）。

---

## 5. README.md —— 快速上手

面向「拿到交付物的人」，三块：

1. **凭据怎么拿**（从浏览器导出的具体步骤、只取哪些 cookie、别整包导出）；
2. **怎么用**（可直接复制的命令示例，含单动作 / 批量 / 取字段）；
3. **接口形态速查 + 坑位**（时间单位、二次编码、参数名例外）。

---

## 6. 交付前自检清单

- [ ] 目录 JSON 里 `entries[].resource` 100% 命中 `resources[].id`
- [ ] 生成器跑两遍输出稳定（幂等）
- [ ] 客户端四类各验一次：成功 / 业务失败 / 批量 / 退出码
- [ ] 报告与目录里的**动作数、档位分布、资源域数**一致（改了目录要同步报告）
- [ ] 仓库里搜不到凭据值（`grep` 一遍 cookie / ticket / token 字面量）
- [ ] 临时凭据文件已清理
- [ ] 明确写出未实测的域与明确排除的接口族
