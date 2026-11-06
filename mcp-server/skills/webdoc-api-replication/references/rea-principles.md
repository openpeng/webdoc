# REA 一手原则与出处

本文件是理念依据。**引用 REA 结论时用这里的原句**，不要转述成二手概括——转述会丢掉
「缺失≠不存在」这类限定语，正是限定语在工程上起作用的地方。

来源仓库：`https://github.com/morluto/rea`（站：`https://rea.tools/`）
一手文档（raw）：
- `https://raw.githubusercontent.com/morluto/rea/main/README.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/tool-design.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/web-network-captures.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/mcp-contracts.md`
- `https://raw.githubusercontent.com/morluto/rea/main/docs/agent-environments.md`

本仓的两份**手法**手册（口径在这里，手法在那两份）：
- `route-and-capture-playbook.md` — 路由定义规范、常见模式、抓包要分析的数据；
- `web-design-replication.md` — 网页设计原则 → 接口发现线索。

---

## 1. 缺失即未知，不是没有

> "Missing coverage is unknown, not absence."
> —— docs/tool-design.md

> "Missing coverage remains `unknown`"
> —— docs/tool-design.md

工程含义：没扫到的接口要记成「未知」，不能记成「不存在」，也不能默默不出现。
本仓落位：响应维度档位恒 `unknown`（无真实样本时），缺失部分计入 `unknown` 档而不冒充已覆盖。

## 2. 证据关系分档，不合并

> "Keep observed, derived, and inferred relationships distinct. Preserve unresolved edges and partial provider facts."
> —— docs/tool-design.md

工程含义：不同强度的证据不能拍平成一个置信度。本仓落位：`COMMAND_TIERS` 四档
（`observed`/`derived`/`inferred`/`unknown`）+ `byDimension` 三维拆分。

## 3. 覆盖要分四种 scope

> "if ten applicable records are discovered, eight are examined, and five are returned, the five returned records do not establish complete coverage of the ten. Keep discovered, applicable, examined, and retained scope distinct."
> —— docs/tool-design.md

> "A filtered page can be complete for its selection while the parent inventory remains partial."
> —— docs/tool-design.md

> "An exhausted page does not establish absence from unselected records."
> —— docs/tool-design.md

工程含义：「本次批次有 10 条」不能推出「这个域名就这 10 条」。本仓落位：
`AnalysisCoverage.scope` 显式区分 `domain`（整域全量）与 `batch`（本次批次），
`batchCommandCount` 与 `commandCount` 分列。

## 4. 解释权归属产生边界

> "Interpretation belongs at the producing boundary"
> —— docs/tool-design.md

工程含义：谁解析谁负责解释格式/协议，消费者不重新解析。本仓落位：解析侧（纯函数层）
拥有协议解释权；编排层只消费结构化结果。

## 5. 不把脚本轨迹说成自主选择

> "Do not claim autonomous-agent selection from a scripted trace"
> —— docs/tool-design.md

工程含义：不要把「按规则筛出来的」包装成「模型判断出来的」。本仓落位：
`provenance` 记录的是**证据来源**，不是「谁决定的」。

## 6. 覆盖预算不能靠假设

> "An assumed agent budget is insufficient justification for a limit"
> —— docs/tool-design.md

工程含义：不能因为「预算有限」就把限制写成事实。本仓落位：任何「最多 N 条」「只取前 M 个」
的限制都要能被证据支撑，或明确标注为限制而非事实。

---

## 网页网络捕获侧的对应原则

来源：`docs/web-network-captures.md`

### 7. Derived API surface 的分组键

按 `method` + WHATWG URL `origin` + `path template` 分组。**query 值、fragment、凭据、头、body 不进分组键**。

工程含义：分组键里放不进 query 值，否则同一个接口会按参数值裂成多条命令。
本仓落位：`groupEndpoints()`（`api-command-normalize.ts`）按 method+host+pathTemplate 分组。

### 8. 路径模板化规则

规则按表序应用于**仍编码的记录路径**，且读于 dot-segment 移除之前，
因此 `/a/%2e%2e/admin` 与 `/admin` 保持不同：

| 规则 | 匹配 | 模板 |
| --- | --- | --- |
| `numeric` | 纯数字 | `{numeric}` |
| `uuid` | UUID | `{uuid}` |
| `hex` | ≥32 位十六进制 | `{hex}` |
| `iso-date` | ISO 日期 | `{iso-date}` |

每条派生规则的 `basis` 是 `"inferred"`——路径模板本身也是推断出来的，不是观测事实。

### 9. 不臆造不可用字段

> "Unavailable response fields, including HAR's `status: 0` and an empty `mimeType`, remain unknown, not invented statuses or MIME types"
> —— docs/web-network-captures.md

> "The view makes no handler-identity, schema or causality claim"
> —— docs/web-network-captures.md

工程含义：拿不到的状态码 / MIME 类型 / 处理函数身份保持 unknown，不要填默认值。
本仓落位：响应档位无样本即 `unknown`；`makeAmbiguity()` 只记录候选，不给「正解」。

### 10. 排除原因要有词表

环境 manifest 的 `excluded` 原因词表：`other-origin` / `ui-page-or-asset` / `non-json`。
网络捕获侧另有 `url-redacted`（空 URL）与 `url-unparseable`（URL 无法解析）。

工程含义：被排除的东西要说明**为什么被排除**，不能静默丢弃。本仓落位：
`isNoisePath()` 区分「页面/静态资源/非 JSON」类噪声。

### 11. 凭据剔除清单

`authorization` / `proxy authorization` / `cookie` / `set-cookie` 的**值**永不保留。
（注意：剔除的是值，**头名**可以保留用于诊断。）

本仓落位：扩展侧凭据头永不透传；导出命令集默认不含凭据头。

### 12. Environment coverage：写操作要说明为什么被扣住

`reads.state` / `reads.recorded` / `reads.recorded_reasons` / `writes.served` / `writes.withheld[]`，
每项 withheld 携带 `reason`、`exemplar_ordinal`、`contradicted_by`、`hint`。

工程含义：没做成的写操作要给出**可执行的下一步**（hint），而不是一句「失败」。

---

## 明确不适用于本仓的部分

REA 的这些能力与本仓无交集，**不要**在实现中仿造：

- 二进制 / 应用 / 运行时逆向主体（Ghidra、Hopper、IDA 适配器）；
- sticky provider 与其 Evidence 认证链（`evidence_id`、`parent_evidence_id` 摘要绑定）；
- REA 自己的 HAR / SAZ / qlog / 浏览器场景解码器；
- protobuf / gRPC 请求体解码；
- REA 私有 manifest 与环境 bundle 格式（`rea-state/v1`、`agentenv` 框架）；
- Node 22+/24+ 运行时要求与 `REA_*` 环境变量族。

本仓只借鉴**口径**：证据分档、未知不冒充缺席、scope 分离、歧义显式、解释权归属产生边界。
