---
name: webdoc-replication-deliverables
description: |
  Turn "reverse-engineer this site into a UI-less API" into a standard set of deliverables: an
  action/endpoint catalog (evidence-tiered, grouped by resource domain), a catalog-driven runnable
  client, a readable resource-domain catalog doc, a reverse-engineering report, and a gap analysis
  against this repo's own command pipeline.
  Use when the user asks to 逆向分析某个网站 / 把网页转成无 UI 的 API 调用 / 复刻某个控制台或后台 /
  问「这个网站支持哪些资源和动作」/ 产出复刻交付物, or when an earlier engagement needs to be
  standardized into the repo's deliverable shape.
  Triggers on phrases like 逆向分析, 复刻这个网站, 转无UI, 转成 API 调用, 接口清单, 动作目录, 复刻交付物.
  Do NOT use for reading a page once (use webpilot-browser), for changing WebPilot's product code
  itself (use webdoc-api-replication), or for replicating a page's visual design.
descriptions:
  zh-Hans: "把「网站 → 无 UI API」的复刻落成规范交付物：动作目录（证据分档 + 资源域）、目录驱动客户端、按资源域的可读目录、逆向报告、产品缺口分析。"
---

# 网页 API 复刻交付物规范

## 定位

这个 skill 管的是「**一次复刻战役交什么东西、每个东西长什么样、怎么验收**」。

与 `webdoc-api-replication` 的分工（两个 skill 都要读，不要互相替代）：

| | `webdoc-api-replication` | 本 skill |
|---|---|---|
| 管什么 | **口径与手法**：证据怎么分档、覆盖怎么算、路由/网关/鉴权怎么判、产品代码落在哪 | **交付物**：产出哪些文件、什么形状、怎么验收 |
| 何时用 | 改/审 WebPilot 产品链路本身 | 复刻一个具体站点并交付成果 |

手法（认路 → 取数 → 对表、网关模式、鉴权判定、错误码反推参数）见兄弟 skill
`webdoc-api-replication` 里的 `route-and-capture-playbook.md`；证据分档口径见同 skill 的
`evidence-model.md`（都在它的 references 目录下）。**本 skill 不重复这两套内容。**

交付物的字段契约、CLI 契约、报告骨架见 `references/deliverable-shapes.md`（动手前读它）。
本仓一手案例（阿里云 ARMS）见 `references/case-study-arms.md`——坑位清单都在那里。

## Inputs to collect

开工前确认这几件，缺了就问：

1. **目标站点与页面**：具体 URL（含 hash 路由与查询参数）、是否已有登录态。
   为什么：页面 URL 里往往藏着用得上的标识（应用 ID、地域、时间窗），页面 origin 与业务 API 主机常常**不是同一个**。
2. **交付形态**：只要接口清单 / 要可跑客户端（CLI）/ 还要能塞进本仓命令集。形态决定后面走哪条取证通道。
3. **落位目录**：默认 `<repo>/docs/<site-slug>-replication/`，报告放 `docs/<site-slug>-replication-report.md`。
4. **凭据来源**：用户自己导出 cookie，还是由本仓扩展侧代取。**这一项直接决定「能不能脱离浏览器」**（见步骤 2）。

## 当前 WebPilot 路径与交付形态

先复用 WebPilot MCP 命令路径：`api_commands({action:"domains"})` → `api_commands({action:"list", domain})` → `api_commands({action:"get", domain, commandId})`（或 `name`）→ 独立 `api_call({domain, name, params})`。`domains` 纯本地读取缓存有命令的域名摘要，不接收 `domain` / `tabId`，不依赖浏览器；这不代表所有接口都已验证可调用。返回 `{domains:[{domain,total}],warnings:[]}`，仅列有缓存命令的域名并按字典序排列；`total` 含禁用/弃用缓存命令，不是当前可调用数。`list` 默认可能排除禁用条目，必要时传 `includeDisabled:true` 查看，并阅读 `warnings`。未命中再用 `api_discover` 的 `start` → UI 交互 → `stop_and_analyze`，或 `scan_site` 静态扫描。

默认七入口不包含 `api_manage`，高级开关也不展示它。仅在交付/维护需要时按兼容路由调用其 `export` / `import` / `update` / `disable` / `delete` / `clear_domain` / `health`，或原维护工具名。Skill 只描述流程，不是执行引擎；隐藏名称需支持直接 MCP 调用的客户端，不能假定所有宿主可用。不可因此新增工具或执行未授权外部写操作。旧 `analyze_page_apis` / `call_api_command` 等名称保留兼容，新发现与执行调用采用默认入口。

`api_call` 不传 `action`，写命令需 `confirm:true`；未确认只返回预览、不发请求。其余工具严格按 action 分支传参，不能混入其他分支的字段。授权与域名白名单、只读、紧急停止、目标 URL 校验保持不变。

浏览器取证默认采用 `browser_page` 导航、`browser_read` 观察、`browser_act` 操作后重读/等待验证，网络诊断走 `browser_debug`。高级工具仅在 `WEBPILOT_ENABLE_ADVANCED_TOOLS=1` 时展示；task loop 还要求调用环境开启 `enable_task_mode`，不作为默认取证前置条件。

**是否交付独立 CLI 由用户要求决定。** 只需命令复用时优先交付可导入的 WebPilot 命令包及目录/报告；明确要求脱离 MCP 的独立客户端时再生成下述 CLI，并实测其凭据与运行条件。不能因本 skill 有 CLI 骨架就默认绕开 MCP。以下脚手架、CLI 字段及客户端验收仅适用于所选交付形态；证据分档与目录口径不变。

## Procedure

### 1. 先开脚手架，别从空目录手搓

```powershell
node mcp-server/skills/webdoc-replication-deliverables/scripts/scaffold-replication.mjs --slug <slug> --out-dir docs --name "<站点中文名>"
```

脚手架生成客户端、目录 JSON、目录生成器、README 四个骨架，形状已符合规范。
为什么用脚手架：交付物形状靠人手对齐必然漂移，骨架是「第一次就写对」的唯一低成本办法。

### 2. 先判「能不能无 UI」，再决定投入多少

这一步错判，后面所有工作都白做，所以放最前面。

看两件事：

- **会话 cookie 的 `SameSite`**：`Lax`/`Strict` 的会话凭据**不会随跨站 fetch 发送** → 浏览器扩展后台发请求必然带不上 → 无 UI 调用必须由调用方**显式携带 Cookie 头**。
- **有没有页面内计算的签名**（阿里云的 `collina`、各类 `_sign`）：有 → 该部分接口**明确排除**，不要硬啃。

然后用 **A/B/C/D 对照矩阵**实测（同一个请求，四组各打一次）：

| | 有凭据 | 无凭据 |
|---|---|---|
| **有 Origin/Referer** | | |
| **无 Origin/Referer** | | |

矩阵的价值：它把「缺什么」从猜测变成事实。ARMS 实测结论是「凭据与 Origin 缺一不可」，
而最初的直觉「只要 Cookie 就行」被矩阵直接推翻——**别用直觉代替矩阵**。

### 3. 三层取证，层与层之间不能互相冒充

| 层 | 手段 | 产出 |
|---|---|---|
| L1 观测 | CDP 抓包（首屏 + 关键交互） | 真实 URL / 请求体 / 响应样本 |
| L2 推导 | 下前端 bundle，逆向请求构造器 | 网关形态、端点类型枚举、动作名全集 |
| L3 实测 | 逐条目真实请求 | 哪些真的能用、参数形态对不对 |

L2 是发现「这个站是网关型」的唯一可靠途径：REST 站点的路径一眼就看出来，
网关型站点的路径短到只有 `/data/api.json`，**动作名藏在 query 或 body 里**，不逆向 bundle 会整批漏掉。

### 4. 建目录：证据档位 + 资源域 + 风险

每个条目必填 `id / kind / resource / method / path / params / dataShape / evidence / risk`（见 `references/deliverable-shapes.md`）。

- **证据档位**：`observed`（真实请求拿到业务数据）/ `derived`（代码或规格推导）/ `unknown`（只知名字）。
  **错误码是观测到的响应体**：`ParameterMissing` 直接点名必填参数名 → 回填 `params` 后重测，通过就提档到 `observed`。
- **资源域**：按「用户视角的资源」分（调用链 / 标签 / 探针…），不按 URL 前缀。资源域只影响组织与检索。
- **风险**：写操作一律 `risk=write`。网关型站点的 POST 常常是查询（`List*`/`Query*`/`Get*`），但**不要**因此放宽成 read。

### 5. 产客户端：目录驱动 + 退出码语义化

客户端读目录 JSON 拿默认参数，不把参数硬编码在脚本里。硬要求见 `references/deliverable-shapes.md`：

- 凭据只从 `--cookie-file` / 环境变量读，**仓库里不留凭据值**；
- 退出码 `0` 成功 / `2` 参数错 / `3` 被重定向（凭据过期）/ `4` 业务非 200；
- 展开一层二次编码的 JSON（网关的 `data.Data` 常是 JSON 字符串）；
- 批量走网关的 multi 端点，一次 HTTP 拿多个动作。

### 6. 产可读目录文档：脚本生成 + fail-closed

Markdown 目录**由脚本从 JSON 生成**，不手写第二份。生成器必须 fail-closed：
有条目没归类 / `resource` 指向不存在的域 / 档位枚举非法 → 打印问题清单并退出非零。

为什么这么严：手写两份必然漂移；映射漏项会在你不知情时少交付一个动作，而目录看起来是完整的。
（ARMS 实战中这个校验当场抓出过一条漏登记的动作。）

### 7. 产报告 + 验收 + 清理

报告按 `references/deliverable-shapes.md` 的八章骨架写，其中两章最容易被漏掉：

- **「与本仓产品链路的关系」**：写清楚哪些能直接用、哪些有缺口、缺口定位到**标识符**（函数名/常量名，不用行号）。
  **不擅自改产品代码**——缺口给定位与最小方案，由用户决定要不要投入。
  ⚠️ **案例文档里的产品结论是快照，不是事实**：本仓在并行开发，`references/case-study-arms.md` 里的缺口判断
  可能已过期（实例：那里的 P1「form 体无处安放」已被本仓修复）。**写之前必须核对当前代码**，
  别把快照当结论抄进报告。
- **「遗留与风险」**：明确写出**哪些条目一个都没实测过**。

验收四件事：客户端真跑（成功 / 业务失败 / 批量 / 退出码各一次）、生成器幂等（跑两遍比对）、
仓库里搜不到凭据值、临时凭据文件已清理。

## Output contract

```
docs/<site-slug>-replication/
├── <site-slug>-api.mjs              # 目录驱动客户端
├── <site-slug>-catalog.json         # 目录（唯一事实源）
├── gen-catalog-doc.mjs              # 目录文档生成器（fail-closed）
├── <site-slug>-action-catalog.md    # 按资源域组织的可读目录（生成产物）
└── README.md                        # 快速上手（凭据导出 + 用法 + 坑位）
docs/<site-slug>-replication-report.md   # 逆向报告（八章）
```

交付前对照 `references/deliverable-shapes.md` 末尾的自检清单逐条过。

## Failure handling

- **鉴权过不去**：先把「能不能无 UI」的结论写进报告，再决定要不要扩大范围。不要为了跑通而试图绕过登录/风控。
- **大量 `ParameterMissing`**：这是好消息——错误码在点名参数名。回填 `params` 重测，别直接标 `unknown`。
- **`InvalidAction.NotFound`**：多半是**归属错**（动作属于另一个 product），不是端点不存在。换 product 再试。
- **拿到空结果**：先怀疑参数形态与**时间单位**，再怀疑端点不存在。静默空结果（不报错）最危险——它会被当成「这接口没数据」而丢进 `unknown`。
- **bundle 太大下不动**：先用 grep 定位关键词，再按上下文窗口取片段，不要整包进内存。
- **需要人机验证 / 二次验证**：停下来让用户处理，不尝试绕过。
- **改动越界到本仓硬边界**（域名白名单 / 紧急停止 / 目标 URL 校验 / 凭据头剔除）：这些是用户拍板的安全边界，
  不在「交付物」的授权范围内。缺口只报位置，不动代码。

## Examples

**Example 1 — 网关型控制台（ARMS）**

输入：`https://armsnext.console.aliyun.com/tracing#/tracing/cn-hangzhou?appId=...`，要转无 UI API。

产出：66 个动作分 11 个资源域（observed 24 / derived 35 / unknown 7），客户端单动作与批量都跑通，
报告含鉴权 A/B/C/D 矩阵与「控制台壳 API 需要 collina 签名 → 明确排除」。
详见 `references/case-study-arms.md` 与 `docs/arms-tracing-replication-report.md`。

**Example 2 — 「这个网站支持哪些资源和动作」**

用户只想看能力清单，不要求立刻能跑：仍然按同一套走（判鉴权 → L1 观测 → L2 逆向 → 建目录），
但只交付 `catalog.json` + 生成出的资源域目录；报告可以压缩到「结论摘要 + 目录 + 未实测说明」三章。
**目录形状不因交付形态改变**——这样后续要补客户端时不用返工。

## Windows (win32) platform notes

- 脚手架与生成器都是 Node.js ESM，直接 `node <script>` 跑，不依赖任何 npm 包。
- 读文件用 Read/Write 工具优先；必须用 PowerShell 时显式 `-Encoding UTF8`（5.1 默认 ANSI 会写坏中文）。
- 临时凭据放在**仓库外**（如 `$env:TEMP`），不要写进仓库目录。
- 删除临时文件走 `rm -- "<path>"`（可恢复），不要用 `Remove-Item`。
