# __SITE_NAME__ —— 无 UI API 客户端

> 交付物规范见 `.minimax/skills/webdoc-replication-deliverables/references/deliverable-shapes.md`。
> 逆向报告见 `docs/__SLUG__-replication-report.md`。

## 1. 导出会话凭据

<!-- TODO：写清从哪个浏览器扩展/工具导出、只取哪些 cookie、为什么不能整包导出 -->

## 2. 用法

```bash
# 列出全部条目（按资源域分组）
node __SLUG__-api.mjs --list

# 单条目
node __SLUG__-api.mjs --action <Id> --from-catalog --set k=v --cookie-file cookie.txt

# 批量
node __SLUG__-api.mjs --multi <Id1>,<Id2> --from-catalog --cookie-file cookie.txt
```

### 参数

| 参数 | 说明 |
|---|---|
| `--action <Id>` | 调单个条目 |
| `--multi A,B,C` | 批量（走网关 multi 端点） |
| `--from-catalog` | 以目录里记录的 `params` 为基底 |
| `--params <json>` / `--params-file <path>` | 整体覆盖参数 |
| `--set k=v` | 单参数覆盖，可重复 |
| `--pick <点路径>` | 只输出响应中的某字段 |
| `--cookie-file <path>` / `--cookie <str>` / `SITE_COOKIE` | 会话凭据 |
| `--host <hostname>` / `--region <id>` | 覆盖站点默认 |
| `--origin <url>` | Origin 头 |
| `--list` | 按资源域分组列出全部条目 |
| `--strict` | 条目不在目录里就拒绝调用 |
| `--raw` | 输出原始响应信封 |

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 业务成功 |
| 2 | 参数错误（缺凭据 / 动作名非法 / JSON 解析失败） |
| 3 | 被重定向 —— 会话凭据已过期 |
| 4 | 服务端返回了非 200 的业务码 |

## 3. 接口形态速查

```
<!-- TODO：贴真实的请求形态（URL / Content-Type / body 字段 / 响应信封） -->
```

## 4. 已知坑

<!-- TODO：时间单位、二次编码、参数名例外、product 归属…… -->
