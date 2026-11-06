# Confluence 操作手册（方案 B：WebPilot MCP 命令集）

> 这份手册是**首选路径**：不手写 HTTP、不导 cookie、不开浏览器页面，直接用 WebPilot MCP 的
> 「API 命令集」能力操作 Confluence。离线的纯 Node 客户端（方案 A）见 `README.md`，仅在没有
> 浏览器会话时使用。

---

## 0. 前置条件

| 条件 | 说明 |
|---|---|
| 浏览器已登录 Confluence | 命令集调用复用**当前浏览器会话的 Cookie**，无需自己导 `JSESSIONID` |
| 有一个 Confluence 标签页 | `call_api_command` 在页面内发请求；没有标签页时会因拿不到会话而失败 |
| 命令集已生成 | 若 `list_api_commands` 返回 0 条，先跑一次 `analyze_page_apis`（见 §5） |

---

## 1. 五步工作流

```
① 选：查索引拿 commandId  →  ② 核：get_api_command 核对形态  →  ③ 调：call_api_command
                                              ↓
                                    ⑤ 沉淀：analyze_page_apis 把新发现回灌命令集
④ 写：confirm:true（副作用自负）
```

### ① 选 —— 先查索引，别用 keyword 猜

**生成索引**（对齐「目录条目 ↔ 上游命令集缓存」）：

```powershell
node docs\confluence-replication\mcp-index.mjs --out index.md
```

输出会直接告诉你每条端点该用哪个 `commandId`，以及**能不能调**：

| 状态 | 含义 | 行动 |
|---|---|---|
| ✅ 可直接调 | 命令的 `pathTemplate` 已是带 `/confluence` 前缀形态 | 直接 `call_api_command` |
| ⚠️ 仅裸形态 | 缓存里只有裸形态命令 | **别调**（必 404），见 §4 |

实测分布（2026-11-06，用户目录缓存）：**182 条目录条目 = 122 条可直接调 + 60 条仅裸形态**；
上游 217 条命令里另有 35 条是裸形态重复与噪音路径，索引末节列出了它们的 `commandId`，**勿用**。

### ② 核 —— 用 get_api_command 看真实形态

```jsonc
mcp_invoke(tool_name="mcp__webpilot__get_api_command",
  arguments={"commandId":"cmd_4713470976","domain":"confluence.example.com"})
// → request.pathTemplate = "/confluence/rest/create-dialog/1.0/storage/quick-create"  ✅ 前缀在
// → request.pathTemplate = "/includes/soy/breadcrumbs.soy"                          ❌ 裸形态，调用必 404
```

### ③ 调 —— 只读端点直接调

```jsonc
mcp_invoke(tool_name="mcp__webpilot__call_api_command",
  arguments={"commandId":"cmd_4713470976","domain":"confluence.example.com"})
// → {"status":200,"contentType":"application/json","data":{},"durationMs":93}
```

带参数（参数名对应命令的 `{{param}}` 占位符）：

```jsonc
mcp_invoke(tool_name="mcp__webpilot__call_api_command",
  arguments={"commandId":"cmd_xxx","domain":"confluence.example.com",
             "params":{"id":"<pageId>"}})
```

### ④ 写 —— 必须显式 confirm

写命令（`risk=write`，目录里 23 条）不加 `confirm:true` 时**只返回 `confirmationRequired` 预览，
零网络请求**；确认副作用后再加：

```jsonc
mcp_invoke(tool_name="mcp__webpilot__call_api_command",
  arguments={"commandId":"cmd_yyy","domain":"confluence.example.com",
             "params":{...},"confirm":true})
```

> 目录里 23 条写操作**一条都没实测**（端点与参数形态均来自 bundle 静态推导）。
> 第一次用某条写命令前，先在预览里核对方法、路径、参数名。

### ⑤ 沉淀 —— 把新发现回灌命令集

页面里出现了目录没收录的接口时，抓一轮真实流量并入库：

```jsonc
// start：开始抓包（analysisId 是后续回传的关联键）
mcp_invoke(tool_name="mcp__webpilot__analyze_page_apis",
  arguments={"action":"start","domain":"confluence.example.com"})

// stop_and_analyze：产出报告并写入域名级缓存
mcp_invoke(tool_name="mcp__webpilot__analyze_page_apis",
  arguments={"action":"stop_and_analyze","analysisId":"an_...","captureResponseBody":true})
```

纯静态推导（不打开页面、不需要登录态）用 `action=scan_site`：

```jsonc
mcp_invoke(tool_name="mcp__webpilot__analyze_page_apis",
  arguments={"action":"scan_site","domain":"confluence.example.com",
             "tabId":267012450,"collectViaExtension":true,"discoverBundles":true,
             "includeStaticAssets":false,"maxEndpoints":300,"trustSpec":true})
```

---

## 2. 工具清单

| 工具 | 用途 |
|---|---|
| `list_api_commands` | 列出某域名的命令（注意 keyword 只匹配**命令名**，见 §4） |
| `get_api_command` | 看单条完整定义：`params[]` / `responseFields[]` / `request.pathTemplate` / `health` |
| `call_api_command` | 执行；写命令需 `confirm:true`；支持复合命令按 JSONPath 注入下一步参数 |
| `analyze_page_apis` | `start` / `stop_and_analyze` / `scan_site`，把发现沉淀成命令 |
| `update_api_command` | 人工修正（改名 / 改参数模板 / 标弃用），`manuallyEdited=true` 后不会被 merge 覆盖 |
| `invalidate_api_commands` | `action=disable` / `delete` / `clear_domain` |
| `get_api_command_cache` | 缓存健康度：每条命令的 hits / misses / lastError / disabled |

---

## 3. 缓存文件在哪（分裂成 3 份，务必确认）

`defaultApiCommandCacheFile()` 的解析顺序是
`WEBPILOT_API_COMMAND_DIR` → `WEBPILOT_TASK_LOG_DIR` → `<cwd>/.webpilot-task-logs/api-commands.json`。
所以**同一个仓库、不同启动目录会读不同的缓存文件**。本机实测存在三份：

| 路径 | 大小 | 说明 |
|---|---|---|
| `C:\Users\<user>\.webpilot-task-logs\api-commands.json` | 422 KB | 运行时实际在用（含 217 条 Confluence 命令） |
| `<repo>\.webpilot-task-logs\api-commands.json` | 200 KB | 旧快照，无 Confluence 域 |
| `<repo>\mcp-server\.webpilot-task-logs\api-commands.json` | 250 KB | 旧快照 |

**对策**：生成索引时用 `--cache <绝对路径>` 显式指定，或把 `WEBPILOT_API_COMMAND_DIR` 固定成一个目录，
让 MCP 进程与索引脚本指向同一份缓存。

---

## 4. 坑（全部实测，不是推测）

1. **裸形态 = 404**。`JSESSIONID` 的 `path=/confluence`，裸路径连会话 cookie 都带不上。
   实测裸形态调用 8/8 全 404；同相对路径的带前缀形态实测 200/403/302，无一 404。
   上游命令集里同一相对路径**同时存着裸形态与带前缀两条命令**（60 组并存），
   `list_api_commands` 会把两条都列出来 —— 选错就是 404。用 §1① 的索引避开。
2. **`list_api_commands` 的 `keyword` 只匹配命令名，不匹配路径**。实测
   `keyword=helptips` → 0 条（明明路径里有 helptips），`keyword=tips` → 命中。
   命令名形如 `get.1.0.tips`、`get.json.deletedraft`，**本身没有业务语义**，
   所以想按业务找端点，只能查索引，别靠 keyword 猜。
3. **302 ≠ 端点不可用**。`GET /confluence/pages` 实测 302（跳到带尾斜杠的同一路径），
   MCP 侧按 fail-closed 不跟随，记为一次 miss（`lastError: 检测到重定向，按 fail-closed 策略阻断`）。
   看 `health.misses` 时要区分「404」和「重定向」。
4. **响应结构基本未知**。`captureResponseBody=true` 实测采样数仍为 **0**，
   182 条里只有 1 条拿到了真实响应体（二进制 PNG）。`responseSchema.fields` 为空是常态，
   不要假设返回形状。
5. **写操作零实测**，且 `multipart` 类请求体客户端不构造、方案 B 的命令集也不支持手工构造。
6. **`mcp_invoke` 的参数可能被字符串化**：传 `fields`（数组）或 `tabId`（数字）时曾报
   `must be array / must be number`。**只传字符串参数最稳**；数组/数字参数失败时先去掉再试。
7. **缓存分裂**（见 §3），以及 `get_api_command_cache` 里的 `skippedInvalid[]` / `errors[]` 要看。

---

## 5. 与离线客户端（方案 A）的分工

| 场景 | 用哪条 |
|---|---|
| 有浏览器登录态、要快速查/调一个端点 | **方案 B**（本手册） |
| 自动化脚本、CI、无浏览器环境 | 方案 A（`confluence-api.mjs`，见 README §2） |
| 需要 `multipart` 请求体 | 两条都不行；用 `call_api_command` 的命令集条目（若已沉淀） |
| 需要人工核对写操作副作用 | 方案 B 更好：`confirm:true` 前会给预览 |

方案 A 的目录是同一份 `confluence-catalog.json`，所以两端覆盖的端点集合一致，
区别只在**能不能拿到带前缀形态的命令**：

- 方案 A：目录里 182 条**全是带前缀形态**，客户端自己拼 URL，所以 182 条都能打；
- 方案 B：受上游缓存形态限制，当前只有 **122 条**能直接调，60 条仍需先解决前缀问题。

---

## 6. 还没解决的（缺口定位到标识符）

| 缺口 | 定位 | 影响方案 B 的哪一步 |
|---|---|---|
| 上下文前缀覆盖不足 → 同路径裸/带前缀并存 | `mcp-server/src/api-command-site-scan.ts` 的 `applyContextPath()` / `hasRequestContext()` | §1① 选命令（60 条标 ⚠️ 的根因） |
| 响应体采样未生效 | `mcp-server/src/api-command-service.ts` 抓包分支 + `api-command-evidence.ts` 的 `deriveProvenance()` | §4.4 响应结构未知 |
| fail-closed 把 302/403 记成失败 | `mcp-server/src/api-command-service.ts` 的 `call()` | §4.3 端点可用性判断 |
| 噪音路径过滤漏网 | `api-command-site-scan.ts` 的 `isNoisePath()` / `NOISE_TWO_LETTER_RE` | §1① 末节「勿用」清单 |
| 缓存目录分裂 | `mcp-server/src/api-command-cache.ts` 的 `defaultApiCommandCacheFile()` | §3 |

这些属于产品代码，本手册只记录现象与规避方式，未做任何代码改动。
