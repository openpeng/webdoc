# 高顿 Confluence 复刻 —— 逆向报告

- 站点：`https://confluence.gaodunwangxiao.com/confluence/`
- 复刻对象：把 Confluence 的页面操作转成无 UI 的 API 调用
- 本轮动作：**用 REA 证据纪律复核现有复刻 → 规范化产出物 → 重跑一次 live 取证**
- 交付物：`docs/confluence-replication/`（目录 JSON + 目录驱动客户端 + fail-closed 生成器 + 可读目录 + README），报告即本文件
- 取证时间：2026-11-06（实测记录均带日期与命令标识符）

---

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 接口形态 | 传统 REST；路径统一挂在应用上下文前缀 `/confluence` 之下；无网关、无统一 envelope、无二次编码 |
| 业务主机 | `confluence.gaodunwangxiao.com`（与页面同源，无独立 API 主机） |
| 鉴权 | `Cookie: JSESSIONID`（`path=/confluence`、`secure`、`HttpOnly`）；离开浏览器可行，只需这一个 cookie |
| 批量 | 无网关批量；客户端逐条独立结算 |
| 目录规模 | 182 个条目 / 11 个资源域（上游命令集 217 条 → 归一后 182 条 + 26 条被取代 + 9 条噪音剔除） |
| 无 UI 可行性 | **可行且已实测**：客户端对已观测端点拿到 HTTP 200（含一次真实二进制响应体） |
| 端点维度实测覆盖率 | 17/182 ≈ **9.3%**（口径：域名级，被真实观测过的端点数 ÷ 归一后条目数） |
| 响应维度实测覆盖率 | 1/182 ≈ **0.5%**（口径：域名级，拿到真实响应体的条目数 ÷ 归一后条目数） |
| 最大风险 | 写操作 23 条**一条都没实测**；响应结构几乎全未知；上游命令集存在同路径重复形态 |

一句话：**读路径可以脱离浏览器直接调（前提是路径必须带 `/confluence` 前缀）；写路径本轮不具备可交付证据，禁止在生产实例上直接使用。**

---

## 二、逆向方法与证据来源

### 2.1 分层取证表

| 层 | 手段 | 本轮实际产出 | 规模 |
|---|---|---|---|
| L1 观测 | 浏览器扩展抓包（`analyze_page_apis` action=start / stop_and_analyze） | 14 个端点被真实请求触达（端点 + 参数形态） | 14 条命令 |
| L1 观测 | 直连复刻客户端发真实请求（`call_api_command`） | 14 次真实 HTTP 调用：裸形态 8 次全 404；带前缀 6 次（200×3 / 302×1 / 403×1 / 404×1） | 14 次调用 |
| L2 推导 | 静态扫描前端 bundle（`scan_site` + 扩展借登录态取 6 个 JS 源） | 175 条静态推导命令（端点为 bundle 字面量，属「推断」级证据） | 175 条命令 |
| L3 实测 | 对 L2 产出的争议形态做 A/B 对照实测 | 3 组同相对路径「裸 vs 带前缀」对照 + 5 组裸形态单独实测 | 8 组 |
| L3 实测 | 交付客户端端到端验收 | 6 次真实 HTTP 调用（200×2、404×2、302×1、200 HTML×1），退出码 0 / 2 / 3 / 4 全部按契约触发 | 10 次调用 |

### 2.2 关键代码还原（定位用标识符，非行号）

| 环节 | 标识符 | 作用 / 本轮观察 |
|---|---|---|
| 上下文路径识别（扩展侧） | `apiDetectContextPathInPage()` / `apiDetectContextPath()` | 从页面 `AJS.contextPath()` 取到 `/confluence`，本轮 `scan_site` 返回的 `contextPath` 字段确认为 `/confluence` |
| 上下文路径拼接（Node 侧） | `applyContextPath()` | 把「请求上下文形态」的相对路径补成带前缀形态；**覆盖面不全**（见 6.1） |
| 噪音路径过滤 | `isNoisePath()` | 拦掉静态资源与无上下文字面量；**漏网**（见 6.3） |
| 端点推断 | `scanJsTextDetailed()` / `scanSources()` | 从 bundle 文本里抽路径字面量并做来源归属 |
| 其它数据源解析 | `parseFiddleText()` / `parseHarText()` / `parseOpenApiText()` / `parseCommandSetText()` | HAR / SAZ / OpenAPI / 声明式命令包解析入口 |
| 证据档位 | `deriveProvenance()` / `tierForOrigin()` / `tierForSourceKinds()` / `weakestTier()` | 通道 capture → 端点档位 `observed`；响应档位**仅当 `hasResponseSample` 为真**才是 `observed` |
| 覆盖率 | `buildCoverage()` / `coverageRate()` / `countDistinctEndpoints()` | `scope=domain` 与 `scope=batch` 两套口径 |
| 调用闸门 | `call()` / `callComposite()` / `filterParamsForCommand()` | 写命令需 `confirm`，缺参不发请求，重定向 fail-closed |
| 缓存 | `api-command-cache.ts` / `invalidate()` | 域名级缓存，按域名分文件 |

### 2.3 本轮观察到的上游数据形态（缓存实测）

- 三份缓存目录并存，运行中的 MCP 进程读的是 `C:\Users\gaodun\.webpilot-task-logs\api-commands.json`（本轮实测该文件被写入、更新时间为 2026-11-06T08:22Z）。
- 缓存结构：`domains[host] = { host, updatedAt, commands[] }`；命令条目含 `request{method,urlTemplate,pathTemplate,bodyTemplate,queryTemplate}`、`params[]`、`responseFields[]`、`responseSchema`、`source{analysisId,analyzedAt,generatedBy,origin,provenance}`、`health{hits,misses,consecutiveFailures,disabled,lastError}`。
- 按 `source.analyzedAt` 分批：`05:16:44Z` 扫描 33 条、`05:17:42Z` 抓包 9 条、`08:22:22Z` 扫描 175 条、`08:27:16Z` 抓包 14 条 —— 共 217 条。

---

## 三、鉴权模型

### 3.1 A/B/C/D 对照矩阵（实测）

| 编号 | 条件 | 观测结果 | 样本数 |
|---|---|---|---|
| A | 有 `JSESSIONID` + 带 `/confluence` 前缀 | `200`（含 `image/png` 与 `application/json`）、`403`（端点存在，鉴权/权限不足）、`302`（服务端重定向） | 6 |
| B | 有 `JSESSIONID` + **裸路径** | `404`（8/8 全部 404） | 8 |
| C | 无 `JSESSIONID` | 未逐一实测（预期 401/403 或跳登录页） | 0 |
| D | 403 形态（端点存在但当前身份无权） | `403 AUTH_REQUIRED`，本仓提示「登录态可能已失效，请人工重新登录后重试」 | 1 |

### 3.2 结论

- **能脱离浏览器**。只需要 `JSESSIONID` 一个 cookie，不需要 CSRF token，不需要页面内 JS 计算的签名。
- **路径前缀是硬前提**，比 cookie 更严格：`JSESSIONID` 的 `path=/confluence`，裸路径请求连 cookie 都不会带上；裸形态 8/8 直接 404。
- **唯一的真·根路径例外**：`GET /synchrony/heartbeat` 在抓包中被观测于根路径（协作心跳服务独立部署）；`GET /confluence/synchrony-proxy/heartbeat` 则在带前缀路径下 —— 两者形态不同，说明「前缀规则」不是无例外的字符串替换，而是「业务端点挂在应用上下文下、协作心跳挂在根下」。

### 3.3 为什么某条路走不通

- **想把裸路径当「另一个域」**：不可行。裸路径 404 是站点路由层的结果，不是鉴权问题；改 header / 加 token 都不会让它出现。
- **想靠浏览器会话自动带 cookie**：可行但违背「无 UI」目标 —— 本交付物只用 cookie 文件，证明不依赖扩展常驻。
- **想把页面路由（`/confluence/pages`）当 API**：实测 302（跳到带尾斜杠的同一路径），本仓与交付客户端都按 fail-closed 不跟随，记为失败/退出码 3。它不是端点，只是路由。

---

## 四、动作目录与实测覆盖率

### 4.1 资源域 × 档位交叉表（归一后 182 条目）

| 资源域 | 条目 | observed | derived | 说明 |
|---|---:|---:|---:|---|
| 页面与内容 | 31 | 0 | 31 | 页面正文、CQL 查询、内容原型、草稿与附件搜索 |
| 编辑器、宏与创建对话框 | 36 | 0 | 36 | 编辑器加载、宏浏览器、创建对话框、高亮面板与路线图 |
| 集成与第三方连接 | 29 | 1 | 28 | 应用链接、Jira 集成、宏应用与 Gadget |
| 交互与个人状态 | 29 | 0 | 29 | 收藏、关注、通知数、快捷方式、菜单、权限与个人资料 |
| 管理、运维与实例状态 | 15 | 0 | 15 | 管理后台、实例状态、许可横幅与功能发现 |
| 附件与文件资源 | 14 | 0 | 14 | 附件上传、拖拽上传、文档转换、头像与空间设置 |
| 空间与导航 | 10 | 0 | 10 | 空间列表、页面树、面包屑与链接面板 |
| 账号与组织 | 6 | 0 | 6 | 用户、邀请、目录与第三方账号 |
| 协作同步（Synchrony） | 6 | 0 | 6 | 实时协作通道、同步代理与内容同步 |
| 评论与任务 | 5 | 0 | 5 | 行内评论、任务面板与草稿删除 |
| 页面路由（非 REST，仅作重定向证据） | 1 | 0 | 1 | 实测 302，仅作证据 |
| **合计** | **182** | **1** | **181** | |

（表中 observed 只统计「拿到真实响应体」的条目；**端点维度**被观测过的条目共 17 个 —— 见 4.3 口径说明。）

### 4.2 覆盖率（必须带口径）

| 口径 | 定义 | 数值 |
|---|---|---|
| 域名级 · 端点维度 | 被真实请求触达或确认存在的不同端点数 ÷ 归一后条目数（抓包 14 + 直调新增 3 = 17） | 17 / 182 ≈ **9.3%** |
| 域名级 · 响应维度 | 拿到过真实响应体的条目数 ÷ 归一后条目数 | 1 / 182 ≈ **0.5%** |
| 批次级（上游 `scan_site` 自报） | 本批次命令数 ÷ 本批次命令数 | 100%（**会高估，不作为交付口径**） |
| 上游域名级 `coverageRate` | 本仓 `buildCoverage()` 输出 | 0.065（口径 `scope=domain`，分母 217） |

> 批次级口径在本次实测里出现了「批次 coverageRate=1、域名级 0.065」的典型失真：分母从 217 降到批次内 14，覆盖率被放大 15 倍。**对外只报域名级口径。**

### 4.3 真实数据抽样（实测响应，非样本猜测）

| 命令 | 方法与路径 | 实测结果 | 判定 |
|---|---|---|---|
| `cmd_ab1711025c` | `GET /confluence/plugins/servlet/confluence/placeholder/unknown-attachment` | `200`，`image/png`，拿到二进制响应体 | **observed** |
| `cmd_a22356ecae` | `GET /confluence/rest/mywork/latest/status/notification/count` | `200`，`application/json`，响应体为空/未采样 | derived（空结果不计 observed） |
| `cmd_24cff768f2` | `GET /confluence/rest/helptips/1.0/tips` | `200`，`application/json`，空数组 | derived |
| `cmd_fa17d9d8cd` | `GET /confluence/rest/inlinecomments/1.0/comments` | `404` | derived（端点存在，参数形态存疑） |
| `cmd_b756bc5353` | `GET /confluence/pages` | `302` → fail-closed 阻断 | derived（路由非端点） |
| `cmd_5dfd2e102d` | `GET /confluence/plugins/drag-and-drop/upload.action` | `403 AUTH_REQUIRED` | derived（端点存在） |
| `cmd_44c77ff9f7` | `GET /pages` | `404` | 裸形态不成立 |

### 4.4 归一：217 → 182 的构成

| 项 | 数量 | 处理 |
|---|---:|---|
| 上游命令集总数 | 217 | — |
| 同相对路径的裸形态重复项（实测裸形态 404） | 26 | 剔除，记入 `excluded` |
| 噪音路径条目（`/a/b`、`/a/i`、`/v1`、`/data`、`/images/**`、`/s/zh_CN/**` 等） | 9 | 剔除，记入 `excluded` |
| 静态资源族 / 埋点族（上游扫描阶段已丢弃） | 2 | 记入 `excluded` |
| **归一后条目** | **182** | 其中 60 条的规范路径由「裸形态」按 A/B 证据推定为带前缀形态，`source.barePath` 保留原形态 |

---

## 五、端到端调用链

### 5.1 跑通的链路（交付客户端，真实 HTTP）

```
confluence-catalog.json（唯一事实源）
   │  目录驱动：id → method / path / params / bodyEncoding
   ▼
confluence-api.mjs
   │  ① 读凭据（--cookie-file / CONFLUENCE_COOKIE）
   │  ② 必填参数闸门（缺失 → 退出码 2，零网络请求）
   │  ③ 写操作闸门（未 --confirm-write → 退出码 2）
   │  ④ path 占位替换 + query/body 拆分
   ▼
fetch(https://confluence.gaodunwangxiao.com/confluence/..., redirect: "manual")
   │
   ▼
HTTP 200 image/png   ← 已实测
```

单动作实测形态：

```
GET https://confluence.gaodunwangxiao.com/confluence/plugins/servlet/confluence/placeholder/unknown-attachment
Cookie: JSESSIONID=…
Accept: application/json, text/plain, */*
Origin: https://confluence.gaodunwangxiao.com
Referer: https://confluence.gaodunwangxiao.com/confluence/
→ HTTP 200  Content-Type: image/png
```

### 5.2 批量（逐条独立结算）

```
--multi get-rest-helptips-1-0-tips,get-rest-inlinecomments-1-0-comments
→ 第 1 条：HTTP 200 application/json
→ 第 2 条：HTTP 404 application/json
→ 批量结果：get-rest-helptips-1-0-tips=success, get-rest-inlinecomments-1-0-comments=fail(404)
→ 退出码 4（一个失败不拖垮其余）
```

### 5.3 退出码实测矩阵

| 场景 | 退出码 | 实测输出 |
|---|---:|---|
| `--list` | 0 | 11 个资源域 / 182 条目 |
| 成功（200 二进制） | 0 | `HTTP 200 image/png` |
| 业务失败（404） | 4 | `HTTP 404 application/json` |
| 重定向（302） | 3 | `HTTP 302 被重定向到 …/confluence/pages/（不跟随）` |
| 缺凭据 | 2 | `缺少凭据：用 --cookie-file <path>、--cookie <str> 或环境变量 CONFLUENCE_COOKIE …` |
| 目录里没这个条目（`--strict`） | 2 | 拒绝调用 |
| 必填参数缺失 | 2 | `条目 get-rest-tinymce-id-content 缺少必填参数：id`（零网络请求） |
| 写操作未确认 | 2 | `是写操作（risk=write），默认拒发` |

---

## 六、与本仓产品链路的关系

### 6.0 结论

- **能用什么**：`scan_site` / `analyze_page_apis` 的静态扫描 + 抓包双通道已经把 Confluence 的端点骨架拉出来了；本交付物证明这批端点**可以脱离浏览器调用**。
- **不能用什么**：本轮**不产生**「用命令集驱动 Confluence 完成业务动作」的闭环 —— 写操作 23 条一条都没实测，响应结构 99.5% 未知。
- **改什么**：下述 5 条是本轮 REA 复核得到的具体缺口，**只给定位与最小方案，本次不改产品代码**。

### 6.1 缺口一：上下文前缀覆盖面不足 → 同路径重复端点，分母被撑大

- **定位**：`api-command-site-scan.ts` 的 `applyContextPath()`；配套的路径形态判定 `hasRequestContext()` / `relativeToContext()` / `LITERAL_PREFIX_RE`。
- **现象**：前缀只补在「请求上下文形态」的路径上；bundle 里裸字符串字面量形态的同一路径不补。同一相对路径因此产生**两条命令**（`commandId` 按 `sha256(host\0method\0pathTemplate)` 计算，形态不同即永不合并）。
- **实测**：217 条命令里 **26 组**同相对路径重复（裸形态实测 404，带前缀形态实测 200/403/302）；归一后真实端点比命令数少 26。覆盖率分母被虚增，`coverageRate` 被低估。
- **最小方案**：在写入缓存前增加一次「按当前域名已知 `contextPath` 归一」的收敛步骤 —— 对每个待写命令，若 `pathTemplate` 以裸相对路径形态存在且同 `host+method` 已有带前缀形态，则合并到带前缀那条（或统一按 `contextPath` 重写后再算 `commandId`）。收敛点建议放在 `api-command-cache.ts` 的写入侧，与 `applyContextPath()` 同一层，不动解析层。

### 6.2 缺口二：响应体采样未生效 → 证据档位塌陷，且 merge 会覆盖已有 observed 证据

- **定位**：`api-command-service.ts` 的 `stop_and_analyze` 分支与响应采样开关；证据侧 `api-command-evidence.ts` 的 `deriveProvenance()`（响应档位仅当 `hasResponseSample` 为真才是 `observed`）。
- **现象 A**：显式传 `captureResponseBody=true` 后，`sampledResponseCount` 仍为 **0**，14 个被抓包观测到的端点全部 `responseFields: []`、响应一维 `unknown`。
- **现象 B（更严重）**：merge 模式下，这次**没有响应体**的重捕获把上一批已带响应样本的 6 条命令**覆盖清空**（`diff.updated=14`，`responseFields` 从 6/3/3/5/18/3 变为 0），档位从 `observed` 退化为 `unknown` —— **观测过的证据被后续无信息批次抹掉**。实测缓存内 `responseFields>0` 的命令数为 0，域内 tier 计数 217/217 全是 `unknown`。
- **最小方案**：两处独立。
  1. 采样侧：抓包通道改用 CDP `Network.getResponseBody` 按需拉取（或在 `start` 阶段就打开采样并把样本随请求一起留存），而不是在 stop 时依赖已被回收的缓冲。
  2. 合并侧：**空样本不得覆盖非空样本** —— 合并时若新批次的 `responseSchema.sampleCount === 0` 而旧条目有样本，保留旧样本并保留旧档位；`mode=merge` 的语义应是「补强」而不是「以最新批次为准」。
  3. 建议在 `api-command-evidence.ts` 增一个「证据单调性」约束：已被观测过的维度不因后续弱证据批次而降级。

### 6.3 缺口三：噪音路径过滤漏网

- **定位**：`api-command-site-scan.ts` 的 `isNoisePath()`（配套 `NOISE_TWO_LETTER_RE` / `STATIC_RESOURCE_SEGMENTS`）。
- **现象**：`/a/b`、`/a/i`、`/v1`、`/data`、`/images/icons/emoticons`、`/s/zh_CN/...` 等 **9 条**噪音条目进入了命令集（`/a/b`、`/a/i` 是典型两字母段，本应被两字母噪音规则拦下）。
- **最小方案**：扩展 `isNoisePath()` 的判定面：① 整路径只有 1~2 段且末段 ≤2 字符；② 路径段形如 `v\d+` 的版本段独占整条路径；③ 静态资源扩展名补齐 `emoticons`、`/s/**` 本地化资源前缀；④ 单段路径（`/data`、`/status`、`/v1`）默认判为噪音，除非它被真实抓包观测到（观测到的可以豁免）。

### 6.4 缺口四：缓存目录分裂 + 运行中进程读旧缓存

- **定位**：缓存根目录的解析入口（用户目录 vs 仓库目录两份 `.webpilot-task-logs/`），以及 `api-command-cache.ts` 的读写路径。
- **现象**：本机同时存在三份 `api-commands.json`（用户目录一份含 54 条旧命令、仓库 `mcp-server/` 一份 120 条、仓库根一份 113 条其它域）；**运行中的 MCP 进程加载的是用户目录那份**，即 T14 修复前的旧状态。
- **影响**：本轮第一次 `scan_site` 写进的 175 条落在用户目录那份上，而仓库目录那份仍是旧的 120 条 —— 任何基于「仓库里那份缓存」做的统计都会与实际运行态不一致。
- **最小方案**：缓存根目录做成单一来源（配置项 + 环境变量覆盖优先级固定），并在 `get_api_command_cache` 的返回里带上**缓存文件绝对路径 + mtime + 命令数**，让「读的是哪一份」成为可见事实而不是猜。

### 6.5 缺口五：fail-closed 的重定向策略把「可用端点」记成失败

- **定位**：`api-command-service.ts` 的 `call()`（重定向判定）；扩展侧 `browser-extension/api-command-helpers.js` 的 `rebuildExecuteOptions()`。
- **现象**：`GET /confluence/pages` 服务端返回 `302`（跳到 `/confluence/pages/`），本仓按「不跟随跳转」直接判 `REDIRECT_BLOCKED`；`GET /confluence/plugins/drag-and-drop/upload.action` 的 `403` 被记为 `AUTH_REQUIRED`。二者都会写进 `health.misses` / `consecutiveFailures`，把「端点存在但当前形态被重定向」「端点存在但权限不足」和「端点不存在」混为一谈。
- **最小方案**：把「不可用」拆成三态 —— 端点不存在（404）/ 存在但被重定向（3xx，附 Location）/ 存在但受限（401/403），只把 404 计入端点失效；`health` 增加一个 `blocked` 计数，不与 `misses` 相加。

### 6.6 附：扩展通道超时的可观测性缺口

- **现象**：抓包会话所在标签页发生页面导航后，`stop_and_analyze` 连续两次返回 `EXTENSION_TIMEOUT`（30s），改用另一个标签页重开抓包才恢复；期间 MCP 侧没有「该会话已失效，请重开 capture」的提示。
- **最小方案**：扩展侧在抓包会话的宿主页面卸载时，主动回一条明确的失效状态；MCP 侧把 `EXTENSION_TIMEOUT` 与「会话失效」区分开，给出可操作提示（换标签页重开 `start`），而不是笼统超时。

---

## 七、交付物

| 文件 | 用途 |
|---|---|
| `docs/confluence-replication/confluence-catalog.json` | **唯一事实源**：182 条目 / 11 资源域 / 证据档位 / 风险 / 参数形态 / 实测记录 / 已知坑 |
| `docs/confluence-replication/confluence-api.mjs` | 目录驱动客户端（零第三方依赖），凭据只从 `--cookie-file` / `--cookie` / `CONFLUENCE_COOKIE` 读 |
| `docs/confluence-replication/gen-catalog-doc.mjs` | 目录文档生成器：fail-closed 校验 + 幂等 + 不回写事实源 |
| `docs/confluence-replication/confluence-action-catalog.md` | 按资源域组织的可读目录（**生成产物**，勿手改） |
| `docs/confluence-replication/README.md` | 快速上手：凭据怎么拿 / 怎么用 / 接口形态速查 / 坑位 / 与规范的有意偏离 |
| `docs/confluence-replication-report.md` | 本报告 |

用法示例：

```bash
node docs/confluence-replication/confluence-api.mjs --list
node docs/confluence-replication/confluence-api.mjs \
  --action get-plugins-servlet-confluence-placeholder-unknown-attachment \
  --from-catalog --cookie-file <你的 cookie 文件>
node docs/confluence-replication/gen-catalog-doc.mjs     # 重新生成可读目录
```

---

## 八、遗留与风险

1. **写操作零实测**：23 条 `risk=write` 条目（含创建对话框、文档转换、空间设置、菜单个性化）全部没有业务成功样本；body 编码按路径族推断（json / form / multipart），`multipart` 条目客户端直接拒发。**禁止在生产实例上直接调用。**
2. **响应结构几乎全未知**：只有 1 条拿到真实响应体。任何依赖响应字段的自动化都无法基于本目录写。
3. **明确未实测的域**：「账号与组织」「协作同步（Synchrony）」「评论与任务」「管理、运维与实例状态」四域**一个都没实测**；「附件与文件资源」只有一条 200 二进制样本。
4. **端点形态仍有推定成分**：60 个条目的规范路径是按 3 组 A/B 对照 + 13/14 抓包形态**推定**为带前缀形态，逐条未实测 —— 推定依据强，但不是逐条证据。
5. **凭据管理**：只用了 `JSESSIONID` 一个 cookie；该 cookie 随登录态失效（本轮 403 即为鉴权拦截），交付方需自备刷新流程；仓库与本目录均不含凭据值。
6. **站点侧差异**：本实例为单实例部署、无地域维度；若换实例，`/confluence` 前缀、`/synchrony/heartbeat` 的根路径例外都可能不同。
7. **明确排除**：静态资源族（24 个端点）、埋点/监控端点（1 个）、页面路由 `/confluence/pages`（302，仅作证据保留 1 条）、噪音路径 9 条、同路径重复形态 26 条。
8. **本轮未产出闭环**：本次交付的是「可调用的端点目录 + 客户端 + 报告」，**不是**「用命令集完成 Confluence 业务动作」的业务脚本；后者需要先补写操作实测与响应结构样本。
9. **上游缓存状态**：本轮实测写入了运行中进程使用的用户目录缓存（`C:\Users\gaodun\.webpilot-task-logs\api-commands.json`），该目录与仓库内另两份缓存内容不一致（见 6.4），尚未归一。
10. **副作用记录**：本轮为验证「创建空白页」入口而在 Confluence 里产生过 1 个**未发布的空白草稿**（页面 `/confluence/pages/resumedraft.action?draftId=656506968`）；仅草稿，未发布，未改任何既有页面内容。
