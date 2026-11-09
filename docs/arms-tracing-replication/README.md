# ARMS Tracing 无 UI API 客户端

阿里云应用实时监控服务（ARMS）应用监控控制台的**无浏览器**调用封装。
逆向分析报告见 [`../arms-tracing-replication-report.md`](../arms-tracing-replication-report.md)；
**按资源域组织的动作目录**见 [`arms-action-catalog.md`](./arms-action-catalog.md)。

本套交付物的形状规范沉淀在 skill `.minimax/skills/webdoc-replication-deliverables`：
字段契约见其 `references/deliverable-shapes.md`，脚手架见其 `scripts/scaffold-replication.mjs`。
新站点用脚手架起一套同形状的交付物。

## 1. 导出会话 Cookie（一次性）

ARMS 的接口需要**会话 cookie + 控制台 Origin** 两个条件，缺一不可（见报告 §三）。
cookie 的 `SameSite=Lax` 决定了它必须由调用方显式放进 `Cookie` 头。

用 WebPilot 从已登录的 Chrome 标签页导出：

```jsonc
// mcp__webpilot__browser_cookie  action="get_all", tabId=<ARMS 标签页>
{
  "cookies": [
    { "name": "login_aliyunid_ticket", "value": "..." },   // ← 会话凭据，必需
    { "name": "login_aliyunid_sc",    "value": "..." },
    { "name": "login_aliyunid",       "value": "..." },
    { "name": "login_aliyunid_pk",    "value": "..." },
    { "name": "login_current_pk",     "value": "..." },
    { "name": "cna", "value": "..." },
    { "name": "aliyun_lang", "value": "zh" },
    { "name": "aliyun_site", "value": "CN" },
    { "name": "isg", "value": "..." }
  ]
}
```

把上面这些拼成一行 `k=v; k=v; ...` 存成 `cookie.txt`（**放在仓库外，别入库**）：

```
login_aliyunid_ticket=...; login_aliyunid_sc=...; login_aliyunid="learning @ 1032850351855561"; ...
```

也可用环境变量 `ARMS_COOKIE` 直接提供同一串内容。

## 2. 用法

```bash
# 列出全部动作（✔=已实测取到数据，~=bundle 逆向推导，?=参数未知）
node arms-api.mjs --list

# 单动作：用目录里的参数形态，临时覆盖 Pid
node arms-api.mjs --action GetTraceApp --from-catalog \
  --set 'Pid=<appId>' \
  --cookie-file cookie.txt

# 只取响应里的某个字段
node arms-api.mjs --action GetTraceApp --from-catalog \
  --set 'Pid=<appId>' \
  --cookie-file cookie.txt --pick data.TraceApp

# 批量：一次 HTTP 调多个动作（multiApi 网关）
node arms-api.mjs --multi GetTraceApp,GetUserInfo --from-catalog \
  --set 'Pid=<appId>' --cookie-file cookie.txt

# 复杂参数走文件（避免命令行引号转义）
node arms-api.mjs --action GetTraceAggr --params-file aggr.json --cookie-file cookie.txt
```

### 参数

| 参数 | 说明 |
|---|---|
| `--action <Name>` | 单个动作名 |
| `--multi A,B,C` | 批量动作（走 `/data/v2/multiApi.json`） |
| `--from-catalog` | 以 `arms-catalog.json` 记录的参数形态为基底 |
| `--params <json>` / `--params-file <path>` | 整体覆盖参数（与目录基底合并，后者优先） |
| `--set k=v` | 单个参数覆盖，可重复 |
| `--pick <点路径>` | 只输出响应中的某个字段 |
| `--cookie-file <path>` / `--cookie <str>` / `ARMS_COOKIE` | 会话 cookie |
| `--region <id>` | 地域，默认 `cn-hangzhou` |
| `--host <hostname>` | API 主机，默认 `fecs.console.aliyun.com`（海外地域为 `fecs.console.aliyuncs.com`） |
| `--origin <url>` | Origin 头，默认 `https://armsnext.console.aliyun.com` |
| `--lang <zh\|en>` | `aliyunLang`，默认 `zh` |
| `--list` | 列出动作目录 |
| `--strict` | 动作不在目录里就拒绝调用 |
| `--raw` | 输出原始响应信封 |

### 退出码

| 码 | 含义 |
|---|---|
| 0 | `code === "200"` |
| 2 | 参数错误（缺 cookie / 动作名非法 / JSON 解析失败） |
| 3 | 被重定向 —— 会话 cookie 已过期，需要重新导出 |
| 4 | 服务端返回了非 200 的业务码（看响应里的 `code` / `message`） |

## 3. 接口形态速查

```
POST https://fecs.console.aliyun.com/data/api.json?<ActionName>
Content-Type: application/x-www-form-urlencoded
Cookie: login_aliyunid_ticket=...; ...
Origin: https://armsnext.console.aliyun.com
Referer: https://armsnext.console.aliyun.com/tracing

product=arms&action=<ActionName>&region=<RegionId>&params=<URL编码的 JSON>
```

批量：

```
POST https://fecs.console.aliyun.com/data/v2/multiApi.json?<A1>~<A2>~...
product=arms&actions=[{"action":"<A1>","params":{...}}, ...]
→ data: {"0":{success,code,data}, "1":{...}}
```

响应信封：`{requestId, code, message, httpStatusCode, data, successResponse}`；
`code` 是**字符串** `"200"` 才算成功；`data.Data` 常是**二次编码的 JSON 字符串**（客户端已自动展开一层）。

## 4. 时间单位（最容易踩的坑）

- 列表/聚合接口的 `startTime` / `endTime`：**毫秒**
- span 自身的 `startTime`：**纳秒**
- `GetTraceChain` 的 `StartTime` / `EndTime`：**毫秒**（传纳秒会静默返回 `depth=-1` 空树，不报错）
