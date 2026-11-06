# 高顿 Confluence 知识库 —— 操作手册与动作目录

本目录是「把 Confluence 网页操作转成 API 调用」的一次复刻交付物。
**目录 JSON 是唯一事实源**，Markdown 目录由脚本生成，不手写第二份。

```
docs/confluence-replication/
├── confluence-catalog.json        # 唯一事实源（182 个条目 / 11 个资源域）
├── mcp-index.mjs                  # 方案 B 索引器：目录 ↔ 上游命令集缓存对齐
├── mcp-playbook.md                # 方案 B 主手册（查→核→调→写→沉淀）
├── confluence-api.mjs             # 方案 A 离线客户端（目录驱动，零第三方依赖）
├── gen-catalog-doc.mjs            # 目录文档生成器（fail-closed，幂等）
├── confluence-action-catalog.md   # 按资源域组织的可读目录（生成产物，勿手改）
└── README.md                      # 本文件
docs/confluence-replication-report.md   # 逆向报告（八章）
```

---

## 1. 两条路径怎么选

| | **方案 B：WebPilot MCP 命令集**（首选） | **方案 A：离线 Node 客户端** |
|---|---|---|
| 怎么调 | `call_api_command`，复用浏览器登录态 | 自己导 `JSESSIONID`，自己发 HTTP |
| 需要开页面 | 否（但需有已登录的 Confluence 标签页） | 否 |
| 覆盖端点 | 182 条中**当前 122 条可直接调** | 182 条全部（目录里都是带前缀形态） |
| 写操作 | 需 `confirm:true`，不给则只回预览 | 需 `--confirm-write` |
| 适合 | 交互式探索、快速取数、让 Agent 自己找接口 | 脚本化、CI、无浏览器环境 |
| 手册 | **`mcp-playbook.md`** | 本文 §3 |

两条路径读同一份 `confluence-catalog.json`，覆盖的端点集合一致，只是**能否拿到带前缀形态的命令**
不一样 —— 方案 B 受上游命令集缓存的形态限制（见 §5.1）。

---

## 2. 方案 B：先查索引，再调命令

```powershell
# 生成索引：把目录条目与上游命令集缓存对齐，给出每条端点该用哪个 commandId、能不能调
node docs\confluence-replication\mcp-index.mjs --out index.md
# 自检输出：目录 182 条 = 可直接调 122 + 仅裸形态 60；上游 217 条，其中目录未收录 35 条（勿用）
```

生成结果里每行给出：目录 id、方法、**带前缀规范路径**、**可调 commandId**、命令名、
状态（✅ 可直接调 / ⚠️ 仅裸形态）、证据档、风险、必填参数、健康度。

```jsonc
// 调一条只读端点
mcp_invoke(tool_name="mcp__webpilot__call_api_command",
  arguments={"commandId":"cmd_2a04ef987a","domain":"confluence.gaodunwangxiao.com"})
// → {"status":200,"contentType":"application/json","data":{}}
```

完整流程、工具清单、实测坑位见 **`mcp-playbook.md`**。

---

## 3. 方案 A：离线客户端

### 3.1 凭据怎么拿

Confluence 是会话 cookie 鉴权，只需要一个 `JSESSIONID`：

1. 浏览器登录 `https://confluence.gaodunwangxiao.com/confluence/`；
2. F12 → Network → 任意一个 `/confluence/` 请求 → Request Headers → `Cookie`；
3. **只取 `JSESSIONID` 这一项**，不要整包导出（整包里还有站点埋点 cookie，与本交付物无关且会泄漏设备标识）；
4. 写成一行文本文件（不在本仓库里存）：

```
JSESSIONID=<你复制的值>
```

实测该 cookie 的属性：`path=/confluence`、`secure=true`、`HttpOnly=true`。
`path=/confluence` 意味着**裸路径（不带前缀）请求根本不会带上它**，这也是裸路径必然失败的原因之一。

> 仓库里不留任何凭据值；客户端只从 `--cookie-file` / `--cookie` / 环境变量 `CONFLUENCE_COOKIE` 读。

### 3.2 怎么用

```powershell
# 看有哪些条目（按资源域分组，不需要凭据）
node docs\confluence-replication\confluence-api.mjs --list

# 单动作：用目录里的参数基底跑一条已实测 200 的端点
node docs\confluence-replication\confluence-api.mjs --action get-rest-helptips-1-0-tips \
  --from-catalog --cookie-file E:\tmp\confluence-cookie.txt

# 覆盖单个参数
node docs\confluence-replication\confluence-api.mjs --action get-rest-tinymce-id-content \
  --from-catalog --set id=409338091 --cookie-file E:\tmp\confluence-cookie.txt

# 只取响应体里的某个字段（--pick 的路径相对「响应体本身」，不是相对输出信封）
node docs\confluence-replication\confluence-api.mjs --action get-rest-mywork-latest-status-notification-count \
  --from-catalog --pick count --cookie-file E:\tmp\confluence-cookie.txt

# 批量：REST 站点没有网关批量，逐条独立结算（一个失败不拖垮其余）
node docs\confluence-replication\confluence-api.mjs --multi get-rest-helptips-1-0-tips,get-rest-inlinecomments-1-0-comments \
  --from-catalog --cookie-file E:\tmp\confluence-cookie.txt
```

退出码语义：

| 退出码 | 含义 | 触发条件 |
|---:|---|---|
| 0 | 成功 | HTTP 2xx |
| 2 | 参数错 | 缺凭据 / 缺必填参数 / 目录里没这个条目 / 写操作未加 `--confirm-write` / multipart 拒发 |
| 3 | 被重定向 | 3xx，**不跟随**（fail-closed） |
| 4 | 业务失败 | HTTP 非 2xx |

参数一览：

| 参数 | 说明 |
|---|---|
| `--list` | 按资源域分组列出全部条目（**不需要凭据**） |
| `--action <Id>` | 调单个条目；Id 取自 `--list` 或目录 JSON 的 `id` |
| `--multi A,B,C` | 批量；REST 站点无网关批量，逐条独立结算 |
| `--from-catalog` | 以目录里记录的 `params` 为基底 |
| `--params <json>` / `--params-file <path>` | 整体覆盖参数 |
| `--set k=v` | 单参数覆盖，可重复 |
| `--pick <点路径>` | 只输出响应体里的某个字段（路径相对响应体，如 `--pick count`、`--pick 0.id`） |
| `--raw` | 输出未截断的原始响应体 |
| `--cookie-file <path>` / `--cookie <str>` / `CONFLUENCE_COOKIE` | 凭据来源（三选一） |
| `--host <hostname>` / `--origin <url>` | 覆盖站点默认 |
| `--strict` | 条目不在目录里就拒绝调用 |
| `--confirm-write` | 放行写操作（`risk=write`） |

写操作（`risk=write`，目录里 23 条：json 18 / form 4 / multipart 1）默认**拒发**；确认副作用后再加 `--confirm-write`：

```powershell
node docs\confluence-replication\confluence-api.mjs --action put-rest-create-dialog-1-0-storage-quick-create \
  --params-file body.json --confirm-write --cookie-file E:\tmp\confluence-cookie.txt
```

> `multipart` 条目客户端不手工构造（`--params-file` 只覆盖参数、不改编码），需要时改走方案 B 的
> 命令集条目。

### 3.3 重新生成可读目录

```powershell
node docs\confluence-replication\gen-catalog-doc.mjs            # 缺省读同目录 *-catalog.json，写 *-action-catalog.md
node docs\confluence-replication\gen-catalog-doc.mjs --catalog .\confluence-catalog.json --out .\confluence-action-catalog.md
```

生成器 **fail-closed**：条目缺 `resource`、`resource` 不在 `resources[]`、`id` 重复、
`evidence`/`risk`/`kind` 枚举非法 → 打印问题清单并 `exit(1)`，不产出「看起来完整」的目录。

---

## 4. 接口形态速查

| 项 | 值 |
|---|---|
| 形态 | 传统 REST（无网关、无统一 envelope、无二次编码） |
| 业务主机 | `confluence.gaodunwangxiao.com`（与页面同源） |
| 路径前缀 | **`/confluence`**（应用上下文路径），唯一例外 `/synchrony/heartbeat`（实测在根路径） |
| 成功判定 | **HTTP 2xx**（不是 body 里的 code 字段） |
| 鉴权 | `Cookie: JSESSIONID`（方案 B 由浏览器会话自动携带） |
| 批量 | 无网关批量，客户端逐条独立结算 |
| 写操作 | 23 条，全部**未实测**；body 编码按路径族推断（json / form / multipart） |

---

## 5. 坑位（都来自实测，不是猜测）

1. **路径不带 `/confluence` 前缀 = 404**。实测 8 次裸形态调用全部 404；同一相对路径的带前缀形态实测 200/403/302，无一 404。
   本目录 182 个条目**一律是带前缀形态**。
   **方案 B 额外要注意**：上游命令集缓存里同相对路径**裸形态与带前缀两条并存**（60 组），
   `list_api_commands` 会同时列出，选错即 404 —— 用 `mcp-index.mjs` 生成索引避开。
2. **`JSESSIONID` 的 `path=/confluence`**：裸路径请求连会话 cookie 都带不上。
3. **302 不等于端点不可用**：`GET /confluence/pages` 实测 302（跳到带尾斜杠的同一路径），客户端按 fail-closed 不跟随，记为退出码 3。
4. **返回结构普遍未知**：抓包通道的 `captureResponseBody=true` 实测采样数为 0，182 个条目里只有 1 条拿到了真实响应体（二进制 PNG）。
5. **写操作一条都没实测**：body 编码、参数语义、副作用全部未知，`multipart` 条目客户端直接拒发（退出码 2）。
6. **同相对路径的重复形态**：上游命令集里同一相对路径有「裸路径」和「带前缀」两条命令（裸的实测 404），本目录已归一，被取代的 26 条记在 `catalog.json` 的 `excluded` 里；方案 B 侧用 `mcp-index.mjs` 的状态列区分。
7. **噪音路径漏网**：`/a/b`、`/a/i`、`/v1`、`/data`、`/images/**`、`/s/zh_CN/**` 等 9 条噪音条目进入了上游命令集，本目录已人工剔除；方案 B 侧由索引末节「上游有、目录未收录」清单标出。
8. **缓存目录分裂**：命令集缓存按 `WEBPILOT_API_COMMAND_DIR` → `WEBPILOT_TASK_LOG_DIR` → `<cwd>/.webpilot-task-logs` 解析，本机实测存在三份不同内容的缓存。生成索引时用 `--cache <绝对路径>` 显式指定。

---

## 6. 本目录与「规范」的两处有意偏离（请先读）

| 项 | 规范原文 | 本目录做法 | 原因 |
|---|---|---|---|
| 证据字段 | 给 `provenance` 时 `evidence` 必须等于三维最弱档 | **不写 `provenance`**，另加 `evidenceDetail` 三维；`evidence` 表示「端点+参数形态」的证据档 | 响应一维全 unknown 时，最弱档规则会把 182 条全部压成 `unknown`，掩盖「端点已被观测」这一事实（本仓 `api-command-evidence.ts` 拆 `byDimension` 正是同一动机） |
| 批量 | `--multi` 走 `transport.batch` 网关批量 | REST 站点无网关批量，改为**逐条独立结算** | 规范里「一个失败不拖垮其余」的行为约束在无网关时同样成立 |

其它扩展字段（非规范字段，生成器不校验，仅供溯源）：
`evidenceDetail`（端点/参数/响应三维）、`source`（上游 commandId 与分析批次）、`verification`（实测 HTTP 状态）、`paramDetail`、`bodyEncoding`。
