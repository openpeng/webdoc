# BundleCollect：登录态 bundle 补采设计

> 增量变更 · 2026-11-05 · 状态：已实现并通过 204/204 全量回归
> 关联：`docs/api-command-site-scan-design.md`、`docs/api-command-set-design.md`、`docs/api-command-set-prd.md`

## 0. 决策摘要

**现象**：SiteScan 让「发现侧」从「人点过的几条接口」升级到「整站骨架」，但它有一个明确的盲区——**受会话鉴权的 bundle**。企业后台、SaaS、教育类站点的 `app.<hash>.js` 常由网关按 Cookie / SSO 票据放行，MCP Server（Node 进程）直读会拿到 401 或登录页 HTML；解析器于是把「登录页的 JS」当成业务代码扫，产出空结果或错误路径。

**结论**：瓶颈不在解析，而在**取文本这一步缺会话**。解析器是纯函数、必须只有一份（否则两侧规则漂移，命令集不可比）；能下沉的只有「取字节」。

**链路（更优解）**：

```
页面上下文 / Service Worker / 浏览器缓存   ← 借会话取文本（扩展侧，新增）
            ↓ 原文（仅内存）
      scanSources()  ← 唯一解析器（MCP 侧，完全复用）
            ↓ 字段名 + 路径结构
        缓存 / 报告 / call_api_command
```

| | 备选 A：扩展侧也实现一份扫描器 | 备选 B：用 `call_api_command` 逐条试错反推 | 采用方案（取文本下沉，解析复用） |
| --- | --- | --- | --- |
| 规则一致性 | 两份实现，必然漂移 | 无规则，靠试 | **一份**，完全复用 |
| 请求量 | 低 | 高（每条命令一次真实请求） | 低（只读 bundle） |
| 写副作用 | 无 | 有（误判即写） | 无 |
| 新增代码 | 扩展侧整套解析（含 27 错误码同步） | 无 | 一个消息 + 三层取文本 |
| 可测性 | 需维护两套用例 | 差 | 纯函数 + vm 沙箱各测一面 |

**关键取舍**：新增的只是「取」，不是「判」。放开的是**借页面会话读前端产物**，不放开任何执行能力——`call_api_command` 的确认闸门、`toCommand()` 白名单、`EXECUTE_OPTIONS_*` 全部一行未改。

---

## 1. 三条通道的关系（互不替代）

| 通道 | 触发 | 会话 | 解析位置 | 用途 |
| --- | --- | --- | --- | --- |
| Q8 抓包采样 | `start` → 操作 UI → `stop_and_analyze` | 页面 | MCP | 真实流量，参数与响应最准 |
| SiteScan 直读 | `scan_site` + `sources[].url` | **无** | MCP | 公开 bundle / 规格 / HAR |
| BundleCollect | `scan_site` + `collectViaExtension` / `discoverBundles` | **页面** | MCP（同一个 `scanSources()`） | 受登录态保护的 bundle |

三者共用同一套生成 / 缓存 / 报告管线，配额彼此独立：Q8 = 20 条 × 64KB；SiteScan = 40 源 × 2MB / 16MB；BundleCollect = 10 源 × 2MB / 8MB。互不挤占。

---

## 2. 三层 fallback：为什么是这个顺序

单靠一层都不够，三层各自覆盖不同的失败面：

| 层 | 执行环境 | 带 Cookie | CORS | 需 attach debugger | 覆盖的场景 |
| --- | --- | --- | --- | --- | --- |
| 1 `page` | 页面隔离世界 `fetch` | ✅ 全部（同源即同站，`SameSite=Lax/Strict` 也生效） | 同源不受限；跨域需响应头 | ❌ | 主路径：等价于页面自己发请求 |
| 2 `worker` | Service Worker `fetch` | ⚠️ 受 `SameSite` 限制（扩展源相对目标站是跨站） | ✅ 不受限（`host_permissions`） | ❌ | 跨域 CDN、页面被 CSP 限制注入时 |
| 3 `cache` | CDP `Page.getResourceContent` | ✅ 走已完成的真实响应 | ✅ 不适用 | ✅ | 页面已加载过、但 1/2 都拿不到的场景；**字节最保真** |

顺序理由：**先最像页面的那条**。层 1 是「页面自己再请求一次」，语义最准；层 2 能力更强但降级了 `SameSite` 语义；层 3 最保真但会短暂占用 debugger（与 devtools / 进行中的分析会话冲突），因此放最后且失败即静默放弃。

`useBrowserCache:false` 可完全关闭层 3 —— 用在「不想让扩展碰 debugger」的场景。

---

## 3. 放开分级（绿 / 黄 / 红）

| 区 | 项 | 默认 | 说明 |
| --- | --- | --- | --- |
| 绿 | `collectViaExtension` | off | 仅把 URL 类数据源的**取文本**改由扩展完成 |
| 绿 | `discoverBundles` | off | 从 `tabId` 页面发现已加载脚本（隐含上一项） |
| 绿 | `bundleMaxSources` / `bundleUseBrowserCache` | 6 / true | 配额与层 3 开关 |
| 黄 | 跨 hostname（CDN） | 仍受 `allowCrossHost` + `extraHosts` | 与 SiteScan 同一套判定，不额外放开 |
| 黄 | 内网 / 回环 | 仍受 `allowPrivateHosts` | 同上 |
| 红 | 构造 method / header / body / cookie | **永不开放** | `BUNDLE_COLLECT_FORBIDDEN_KEYS`，扩展侧白名单也不接收 |

放开的是「能取到哪些字节」，不是「能发什么请求」。请求固定 `GET` + `credentials:'include'` + 无自定义 header。

---

## 4. 契约

### 4.1 消息

```jsonc
// M → E
{
  "type": "apiBundleCollect",          // MSG.BUNDLE_COLLECT
  "requestId": "…",
  "tabId": 7,                          // tab 作用域（TAB_SCOPED_API_MESSAGES）
  "options": {
    "urls": ["https://app.example.com/static/app.8f3a.js"],
    "hosts": ["app.example.com"],      // 精确 hostname 白名单（domain + extraHosts）
    "discover": false,
    "maxSources": 6,
    "maxBytes": 2097152,
    "timeoutMs": 8000,
    "useBrowserCache": true
  }
}

// E → M
{
  "type": "apiBundleCollectResult",    // MSG_RESULT.BUNDLE_COLLECT
  "requestId": "…",
  "success": true,
  "sources": [
    { "url": "…", "ok": true, "text": "…", "via": "page", "bytes": 1234 }
  ],
  "requested": 1, "collected": 1, "discovered": 0,
  "warnings": []
}
```

`options` 白名单：`urls / discover / maxSources / maxBytes / timeoutMs / useBrowserCache / hosts`。
禁止：`headers / cookies / credentials / method / body / postData / confirm / tabId / overrides`（两端常量逐字一致，测试强制校验）。

### 4.2 常量（`api-command-types.ts` §14 ↔ `api-command-helpers.js`）

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `BUNDLE_COLLECT_MAX_SOURCES` | 10 | 单次请求 URL 上限 |
| `BUNDLE_COLLECT_MAX_SOURCE_BYTES` | 2MB | 单源上限（= `SITE_SCAN_MAX_SOURCE_BYTES`） |
| `BUNDLE_COLLECT_MAX_TOTAL_BYTES` | 8MB | 单次总预算 |
| `BUNDLE_COLLECT_TIMEOUT_MS` | 8000 | 单 URL 超时 |
| `BUNDLE_COLLECT_WALL_BUDGET_MS` | 20000 | 整条命令墙钟预算（必须 < bridge 的 30s 通用超时） |
| `BUNDLE_COLLECT_DEFAULT_SOURCES` | 6 | 未指定时的条数 |
| `BUNDLE_COLLECT_VIAS` | `["page","worker","cache"]` | 与实现顺序逐字一致 |

### 4.3 用法

```jsonc
// 已知 bundle 需要登录态
{"action":"scan_site","domain":"app.example.com",
 "sources":[{"kind":"js","url":"https://app.example.com/static/app.8f3a.js"}],
 "collectViaExtension":true,"tabId":7}

// 连 URL 都不想找：从当前页自动发现
{"action":"scan_site","domain":"app.example.com","discoverBundles":true,"tabId":7}
```

---

## 5. 失败模式

| 现象 | 表现 | 处理 |
| --- | --- | --- |
| 扩展离线 / 超时 | `send` 抛错 | 固定 warning `BUNDLE_COLLECT_NO_EXTENSION_WARNING`，**退回 Node 直读**，不中断静态推导 |
| 三层全失败 | `collected=0` | `BUNDLE_COLLECT_FAILED_WARNING`，该源跳过；其它源继续 |
| 页面是 `about:blank` / `chrome://` | `executeScript` 抛错 | 层 1 跳过，层 2/3 兜底 → 全失败即上面那条 |
| debugger 被 devtools 占用 | `attach` 抛错 | 层 3 静默放弃，不影响前两层结果 |
| 超单源 / 总预算 | 截断 | `BUNDLE_COLLECT_TRUNCATED_WARNING`；截断仍可被正则扫描 |
| 墙钟预算耗尽（20s） | 剩余 URL 不再采集 | 同上 warning；**保证不会撞上 bridge 的 30s 超时** |
| 3xx 跳到外域 | 最终 host 复查失败 | 该层判失败（fail-closed），换下一层 |
| 回包 URL 越权 | MCP 侧 `checkScanUrl` 复核失败 | **丢弃该条**，不进入解析 |

---

## 6. 安全论证

1. **不给请求构造入口**：扩展侧用 `rebuildBundleCollectOptions()` 白名单重建入参，`method` / `headers` / `body` / `cookies` 即便被塞进消息也会被丢弃；请求固定 `GET` + `credentials:'include'` + 仅 `accept`。因此本通道**不可能**被用作「带登录态的任意请求发送器」——那是 `call_api_command` 的职责，且它有自己的确认闸门。
2. **两层校验，主体不同**：扩展侧 `apiCheckBundleUrl()` 是真正的边界（协议、userinfo、host 精确命中、域名白名单存 `chrome.storage.local`）；MCP 侧对回包**再做一次** `checkScanUrl()`。回包不可信——WS 客户端可伪造，因此不复用扩展的判定结果。
3. **tab 归属**：`apiBundleCollect` 进 `TAB_SCOPED_COMMANDS`，复用 `getTargetTabId()` 的跨组拒绝；`assertCommandAllowed` 额外要求每个 URL 的 host ∈ {当前页面 host} ∪ 声明的 `hosts`，防止「借 A 站会话去取 B 站 bundle」。
4. **原文不落盘**：不写 `chrome.storage`、不进 `operationLogs`（`safeLogForApiExecute` 白名单）、不进缓存 / 报告 / warnings；回包发出后不再持有引用。测试用「构造唯一串 → 断言日志中不存在」固化这条纪律。
5. **fail-closed 语义与 SiteScan 一致**：重定向不静默跟随到外域，私网默认拒绝，`hosts` 为空即拒绝。

---

## 7. 批判性 review（自评局限）

| # | 问题 | 影响 | 现状 / 后续 |
| --- | --- | --- | --- |
| R1 | 层 1 在页面隔离世界执行，页面若 `Object.defineProperty(window,'fetch')` 不会影响隔离世界，但**隔离世界的 fetch 仍受页面 CSP 的 `connect-src` 约束** | 严格 CSP 站点层 1 全失败 | 层 2 / 3 兜底；若三层的失败率高，可按站点统计后考虑 `Network.loadNetworkResource`（带 `includeCredentials`） |
| R2 | 层 3 需要临时 `attach`，会闪一次「正在调试此浏览器」提示 | 体验 | 默认只在 1/2 失败后才用；`bundleUseBrowserCache:false` 可关 |
| R3 | 只支持文本型资源，WASM / 二进制 bundle 会被 `TextDecoder` 解成乱码 | 覆盖 | 乱码进正则基本不产误报，但属浪费；后续按 `content-type` 过滤 |
| R4 | `discover` 依赖 `performance` 条目，超出浏览器 buffer（默认 250 条）的早期脚本会漏 | 覆盖 | 同时读 `document.querySelectorAll('script[src]')` 兜底；两者并集已覆盖首屏 |
| R5 | 补采文本不校验「是否真的是 JS」，登录页 HTML 也会被扫 | 噪声 | `scanJsText` 只认 `'/...'` 字面量 + API 前缀/动作词，HTML 基本无产出；且产物强制 `needsReview` |
| R6 | 单次 8MB 回流到 MCP 会带来明显的消息序列化开销 | 性能 | 默认 `maxSources=6` + 单源 2MB 已把常见场景压在 2–4MB；需要更省可只传 `discover` 结果再分批 |

---

## 8. 回滚

单点开关，不需回滚代码：

1. 不传 `collectViaExtension` / `discoverBundles` → 行为与上一轮完全一致（Node 直读）。
2. 需要彻底停用扩展侧通道：从 `background.js` 的 `TAB_SCOPED_COMMANDS` 与 `dispatchCommand` 移除 `apiBundleCollect` 分支即可，MCP 侧会走 `BUNDLE_COLLECT_NO_EXTENSION_WARNING` 兜底，功能降级但不报错。
3. 常量与类型改动均为**追加**：`MSG` / `MSG_RESULT` 只新增键，既有 3 个消息的取值一字未改；27 项错误码未动。

---

## 9. 验证记录

| 项 | 结果 |
| --- | --- |
| `npm run build`（tsc strict） | Exit 0 |
| `npm test` | **204/204**（存量 168 零回归 + 新增 17 + 实测回归 19） |
| `npm run doctor` | `7 pass, 1 info, 0 warn, 0 fail` |
| 扩展侧新增依赖 / 权限 / 消息 | 1 个消息（`apiBundleCollect` + result）；**0 新依赖、0 新权限** |
| 存量改动 | `background.js`：+1 分发 case、+1 白名单分支、+1 集合常量；`api-command-helpers.js`：+5 常量 +2 纯函数；`MSG`/`MSG_RESULT` 仅追加 |
| 新增用例覆盖 | 纯函数（URL 判定 / 白名单重建 / 常量对齐）、三层 fallback 顺序、host 白名单拒绝、配额截断、discover 过滤外域、日志不泄原文、编排层「补采文本进入同一扫描器」、回包越权丢弃 |

---

## 10. Roadmap

| 优先级 | 项 | 价值 |
| --- | --- | --- |
| P0 | ~~登录态 bundle 补采~~ | 已交付 |
| P1 | `provides`/`requires` 依赖图 + 复合命令 | 把「查列表→拿 id→查详情」合成一条命令，UI 依赖进一步归零 |
| P1 | `runtimeRef` 受控字段（CSRF / 一次性 token） | 解决 `{{param}}` 无法表达的动态凭据 |
| P2 | 复刻覆盖率与 UI 依赖率指标 | 量化「还差多少」而不是凭感觉 |
| P2 | 层 3 换 `Network.loadNetworkResource`（带凭据） | 摆脱 attach 冲突与 CSP 限制 |

---

## 11. 实测补充（2026-11-05）

**验证方式**：`navigate` 打开真实页面 → `analyze_page_apis({action:"scan_site", discoverBundles:true})`
→ 观察扩展补采往返 + 产出 + 落盘 + `list_api_commands` 回读。为避免外网站点质量干扰，
另起一个本地可控站点（页面引用含 `/api/v1/*` 的 bundle）跑完整链路。

**实测发现的缺陷（已修）**：

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 扩展取回 3 个 bundle，扫描却「读取 0 个数据源」，同时给出自相矛盾的「未提供任何可读数据源」 | `extensionTexts` 只在遍历 `sources` 时按 URL 消费；`discoverBundles` 发现的 URL 不在 `sources` 里，文本被取回却丢弃 | 记录已消费 URL，剩余补采文本作为独立 `js` 数据源追加（配额与 sources 共用同一套闸门） |

**链路实测结果**（本地站点）：发现 2 个 bundle → 取回 2 个 → 扫描 2 个源 → 5 个端点 → 落盘 → 回读 5 条。
`/telemetry/log` 被正确过滤，`pathTemplate` 与 `method` 正确，`endpointCount == commandCount`（D-1 修复后不再双计数）。

**未能覆盖**：真实登录态站点（无可用账号）。层 1/2/3 的 fallback 顺序由单测用可切换的 `fetch` 桩验证，
真实环境下的 CSP `connect-src` 拦截、SameSite 严格 Cookie 跨站缺失仍属理论推断。
