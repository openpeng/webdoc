# AiSearch：把「首页搜索的 AI 结果」做成固定 API

> 增量变更 · 2026-11-05 · 状态：已实现并通过 245/245 全量回归（存量 204 零回归 + 新增 41）
> 关联：`docs/api-command-set-design.md`、`docs/api-command-site-scan-design.md`、`docs/api-command-bundle-collect-design.md`

## 0. 决策摘要

**需求**：「把首页搜索返回 AI 结果制作为固定 api，方便后续搜索用。」——即百度搜索页顶部那块「AI 智能回答」，要能一句话调用拿到全文，**不用每次重跑「开页面 → 抓包 → 分析 → 存命令」**。

**结论**：真正驱动这块内容的不是搜索页，而是一条**独立的 SSE 生成接口**：

```
POST https://chat-ws.baidu.com/baikan/conversation?inputMethod=chat_search&llmsearch=1&word={{query}}
```

它**不需要任何 token、签名、Cookie 或登录态**，只认查询词 + 一个固定 body。这就是「固定 api」能成立的全部前提。

**为什么不复用 `call_api_command`**：命令通道返回的是**原始 body**（一段 SSE 文本或 2MB HTML），调用方还得自己解析协议、拼增量、洗 markdown。`ai_search` 把「取 + 解析 + 清洗 + 截断」收成一步，直接给 `answer` + `citations[]`。命令通道留给「我自己知道要什么、要原始响应」的场景。

| | 备选 A：做成一条 `api_command` | 备选 B：`get_page_text` 读页面 | 采用方案 |
| --- | --- | --- | --- |
| 需开网页 / 标签页 | 否（但需先抓包沉淀） | **是** | **否** |
| 拿到的形态 | 原始 SSE，需自行解析 | 渲染后文本，混杂推荐位与广告 | 结构化 `answer` + `citations` |
| 首次可用成本 | 每个查询都要抓一次包 | 每次都要开页面等渲染 | **零准备** |
| 跨查询复用 | 模板可复用 | 不可 | 可 |
| 覆盖率 | 取决于抓包那次 | 取决于页面实际渲染 | 桌面站 AI 摘要全覆盖 |

---

## 1. 事实推导链（怎么找到这条接口的）

这一步是整件事的关键，记录完整过程以防后来者重走：

| 步骤 | 假设 | 实测结果 | 结论 |
| --- | --- | --- | --- |
| 1 | 移动站 `m.baidu.com` 是 SSR，答案在 HTML 里 | ✅ 确实在：`<script type="application/json" data-for="baikan">`，`component="markdown"` 的 `content` 即正文 | 这条通道成立，可解析 |
| 2 | 那就用移动站当主通道 | ❌ **覆盖率明显更低**：「Kubernetes 探针有哪几种」「如何排查 Java OOM」在移动站完全没有 AI 卡片，桌面站有 | 移动站降级为**兜底** |
| 3 | 桌面站也是 SSR，答案应该在 HTML 里 | ❌ 1MB HTML 里 `探针一共有` 出现 **0 次**；`baikan` 出现 87 次，全是 CSS 类名 | 桌面站是**客户端渲染**，HTML 无正文 |
| 4 | 抓 XHR / fetch | 无匹配请求 | 不是普通 XHR |
| 5 | 抓全部网络流量 | 发现 `chat-ws.baidu.com/baikan/conversation`，`content-type: text/event-stream` | **SSE 流式生成**，这才是源头 |
| 6 | 照抄真实请求（含 `k_signature` / `pmgr_token` / `k_timestamp` / `lid` / `qid`） | ✅ 出答案 | 能用，但带一堆像签名的东西，不算「固定 api」 |
| 7 | 逐个砍参数，直到只剩 `word` | ✅ 仍出答案；但 `generator.text` 全空 | 签名类参数**服务端不校验**，可全删 |
| 8 | 定位「空答案」的真正原因 | 补上 `searchInfo.baikan_is_high_time_demand:"1"` + `categoryIDs:[20]` 后正常 | 这两个才是分水岭；正文在 `data.value`，不在 `text` |

**第 7 步的结论是整件事的地基**：真实请求里那 5 个看起来像鉴权的东西，全是前端埋点/会话上下文，服务端不校验。所以固定 body 就足够，不需要浏览器、不需要签名算法、不需要登录态。

---

## 2. 两条通道：主 + 备

| 通道 | 端点 | 是否需要会话 | AI 覆盖率 | 拿到的形态 | 角色 |
| --- | --- | --- | --- | --- | --- |
| **主：baikan SSE** | `POST chat-ws.baidu.com/baikan/conversation` | ❌ 完全不需要 | **高**（`/baikan/` 就是驱动这块卡片的接口） | 增量流，需拼装 | 默认路径 |
| **备：移动站 SSR** | `GET m.baidu.com/s?word=` | ❌ 不需要 | 低（同一查询桌面有、移动可能没有） | 现成 JSON 块 | SSE 不可用 / 空答案时兜底 |

**为什么保留兜底**：SSE 是「生成式」接口，有超时、有截断、有服务端偶发返回骨架无正文的可能。兜底通道虽然覆盖率低，但它是**静态 SSR**——只要页面有 AI 卡片就一定能解析出来，失败面完全不同。两条都按同一份 `BaiduAiAnswer` 结构返回，调用方不需要区分。

**兜底为什么还要走扩展**：Node 侧直读的 IP / TLS 指纹与真实浏览器差异明显，实测连续请求十几次后会被百度风控——返回 1438 字节的「安全验证」页且持续数十分钟不恢复。所以兜底通道的顺序是「扩展借浏览器指纹 → Node 直读（带退避重试）」。扩展不可用时静默降级，不影响主通道。

---

## 3. 协议契约（实测）

### 3.1 请求

```http
POST /baikan/conversation?inputMethod=chat_search&llmsearch=1&word=<urlencoded query>
Content-Type: application/json
Accept: text/event-stream
Origin: https://www.baidu.com
Referer: https://www.baidu.com/
```

body 固定，只有 `content.query` 随查询变化：

```jsonc
{
  "message": {
    "inputMethod": "chat_search",
    "isRebuild": false,
    "content": { "query": "…", "qtype": 0 },
    "searchInfo": {
      "is_follow_up": "1",
      "dqa_is_wenda": "1",
      "categoryIDs": [20],                    // ← 必需，否则只有骨架
      "baikan_is_high_time_demand": "1",      // ← 必需，否则只有骨架
      "srcid": "279",
      "order": "1",
      "tplname": "wenda_generate",
      "strategy": "", "ori_lid": "", "re_rank": "",
      "lid": "", "qid": "", "viscate_qid": ""  // 真实请求里由搜索页分配，实测留空即可
    },
    "source": "ala_279",
    "from": "apage_dqa",
    "dqaRewrite": {}
  }
}
```

**可省的参数**（真实页面请求里有，服务端不校验）：`k_signature`、`pmgr_token`、`k_timestamp`（query 里），`lid`、`qid`、`viscate_qid`、`strategy`、`ori_lid`、`re_rank`（body 里）。

### 3.2 响应

`text/event-stream`，事件之间以**空行**分隔，每个事件一行 `data:{json}`：

| 事件内路径 | 含义 |
| --- | --- |
| `data.message.content.generator.component === "markdown-yiyan"` | 正文片段，文本在 `generator.data.value` |
| `data.message.content.generator.component === "reference"` | 引用出处，在 `generator.data.referenceList[]`（`text` / `title`、`url`、`source` / `author_name`） |
| `data.message.metaData.endTurn === true` | 生成结束 |

**`value` 是增量还是快照，服务端两种都出现过**。解析器用一行自适应：

```ts
answer = value.startsWith(answer) && value.length >= answer.length ? value : answer + value;
```

- 若 `value` 以当前 `answer` 开头且不更短 → 判定为**全量快照**，直接替换；
- 否则判定为**增量片段**，追加。

这样两种实现都不需要协商，也不会出现「答案被覆盖成最后一句话」或「整段重复十遍」。

### 3.3 兜底通道的块结构

```html
<script type="application/json" data-for="baikan" data-repeatable>
  {"data":{"component":"markdown","data":{
     "area":"summary",
     "content":"==**OpenSpec 是一个 AI 原生的…**==，旨在…",
     "citationList":[{"title":"…","url":"https://…","source":{"name":"腾讯云"}}]
  }}}
</script>
```

页面里有十几个 `data-for="baikan"` 块，**只有 `component === "markdown"` 承载正文**。按文档顺序拼接 `area: summary` + 若干 `block_summary` 即完整答案。属性顺序不固定，所以匹配方式是「先抓所有 `<script>` 标签，再在属性串里同时匹配 `type` 与 `data-for`」。

---

## 4. 清洗规则

百度在正文里混了一套私有 markdown 语法，不清洗会污染下游：

| 原始 | 含义 | 处理 |
| --- | --- | --- |
| `:ml-search[TEXT]{text="TEXT"}` | 内联「可搜索」锚点 | 只留 `TEXT` |
| `:ml-citation{ref="2" tagName="百度百科" logo="…"}` | 引用角标 | **整段删除**（引用本体在 `citations[]`） |
| `==**加粗**==` | 高亮包裹 | 去 `==`，保留内部 markdown |
| `^3^` / `^3^^5^` | 引用序号角标 | 删除（序号已结构化返回） |
| U+200B–U+200F / U+2060 / U+FEFF | 零宽字符，散落句末 | 删除 |
| `:ml-xxx{…}` | 未来新增的未知指令 | 兜底删除，不让脏标记进正文 |

两个正则陷阱（都踩过）：

1. **`==` 只吃不含 `=` 的成对**：`/==([^=]+)==/g`，否则 `a == b` 这类正文会被误伤。
2. **角标必须以 `^` 收尾**：`/\^\d+(?:\^+\d+)*\^+/g`，不能写成 `\^*`——后者可匹配 0 次，会把 `2^10` 的 `2` 吃掉。这是新增用例里唯一一次红灯（`not ok 41`）。

---

## 5. 契约（MCP 工具）

### 5.1 入参

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `query` | string | ✅ | — | 非空，≤ 200 字符 |
| `maxChars` | number | — | 8000 | clamp 到 [200, 30000] |
| `maxCitations` | number | — | 10 | clamp 到 [0, 20] |
| `timeoutMs` | number | — | 25000 | clamp 到 [3000, 25000] |

### 5.2 出参

```ts
interface AiSearchResult extends BaiduAiAnswer {
  query: string;
  urlTemplate: string;   // 兜底通道模板：https://m.baidu.com/s?word={{query}}
  sseEndpoint: string;   // 主通道模板，可直接 curl 复用
  via: string;           // "baikan-sse" | "extension:<page|worker|cache>" | "node"
  durationMs: number;
  attempts: number;
  warnings: string[];
}
// BaiduAiAnswer: found / answer / sections[] / citations[] / blockCount / truncated
```

`found: false` 是**正常结果**，不是错误——百度并非对所有查询都生成 AI 摘要。此时 `warnings` 会给出可操作提示（「换更具体或更长的问法可提高命中率」），而不是抛异常。

### 5.3 失败模式

| 现象 | `via` | `warnings` | 是否抛错 |
| --- | --- | --- | --- |
| 主通道通、有正文、流正常结束 | `baikan-sse` | 空 | 否 |
| 主通道通、有正文、流被超时截断 | `baikan-sse` | 「生成流未正常结束，收到的是部分答案」 | 否（半截答案优于报错） |
| 主通道通但正文为空 | 兜底通道 | 「主通道返回了流但正文为空，已尝试兜底通道」 | 否 |
| 主通道 HTTP 非 2xx / 超时 / 体积超限 | 兜底通道 | 「主通道未连通（…），已尝试兜底通道」 | 否 |
| 兜底也取不到页面 | — | — | **是**，`NETWORK_ERROR` |
| 百度风控拦截（"安全验证"页） | — | 提示「稍等几十秒重试通常可恢复」 | **是** |
| 答案超 `maxChars` | 任一 | 「已按 maxChars 截断，可调大后重试」 | 否 |

配额（独立于抓包与 SiteScan 的采样配额，互不挤占）：SSE 单次 ≤4MB / 25s；兜底 HTML ≤12MB / 15s / 最多 3 次尝试（退避 800ms、2200ms）。

---

## 6. 安全与隐私

- **只读**：只发一次 `POST`（SSE）或 `GET`（兜底页），不带任何业务写语义。
- **无凭据**：不读 Cookie、不带 `Authorization`、不 attach debugger、不走登录态。`ai_search` 在无浏览器、无扩展、无登录的环境下同样可用。
- **不落盘**：查询词只出现在请求体与返回值里，不写 `api-commands.json`、不进 `operationLogs`、不进日志；返回结构给的是 **URL 模板**（`{{query}}` 占位），不是完整 URL。
- **兜底走扩展时的边界**：复用 `BUNDLE_COLLECT` 消息，`options` 只含白名单字段（`urls` / `hosts` / `maxSources` / `maxBytes` / `useBrowserCache` / `timeoutMs`），URL 与 host 由本层构造（固定 `m.baidu.com`），无法借此发出带自定义 header / cookie / body 的任意请求；回包 URL 再校验一次 host。

---

## 7. 批判性 review（自评局限）

1. **SSE 是生成式接口，耗时不可控**。实测 2.4s … 12.8s，长尾明显（`如何排查 Java OOM` 12.8s）。这是一个真实成本：单次调用可以接受，批量十几条查询就要分钟级。**没有做并发批处理**——并发会显著提高触发百度限流的概率，而限流一旦发生是「数十分钟不恢复」级别的惩罚。
2. **`found: false` 的边界依赖百度策略**。这个接口是内部接口，百度随时可以改 body 字段、加签名、限频。当前实现把「必需字段」和「可省字段」分开注释，是为了改的时候知道从哪下手；但**没有任何自动探测失效的机制**——失效表现就是 `found: false` 与「这个查询本来就没有 AI 摘要」无法区分。`warnings` 只能提示「可能没有摘要」，不能证明。
3. **只支持百度**。`cleanBaiduMarkdown` 里的 `:ml-*` 是百度私有语法，换引擎（Bing / Google / 秘塔）需要新提取器，不能复用。
4. **兜底通道的 `via` 语义偏细**。返回 `extension:page|worker|cache` 三层，但对调用方没有决策价值——它只该关心「拿到了没有」。保留是因为排查风控问题时这层信息很关键。
5. **`sections[]` 在主通道只有一段**（`area: "sse"`）。SSE 是连续增量流，没有天然的分块边界，硬切会把句子切断。兜底通道才有真实的 `summary` / `block_summary` 分块。字段为兼容两侧而统一，但语义不完全对等。
6. **超时是「整段读完」而非「首字节」**。`fetch` + `response.text()` 在 25s 内没读完就 abort，即使已经收到 95% 内容。这里刻意选择保留半截答案（`finished: false` + warning）而不是丢弃，因为对「拿个大概」的场景，半截答案的信息量远大于一个报错。

---

## 8. 验证记录

### 8.1 单测（`mcp-server/test/baidu-ai-search.test.mjs`，41 例 / A–G 七组）

| 组 | 覆盖 | 例数 |
| --- | --- | --- |
| A | URL 构造（含超长 / 空串 / 编码） | 3 |
| B | markdown 清洗（三类指令 + `==` + 角标 + 零宽） | 5 |
| C | 主链路提取（顺序拼接 / 缺块 / 坏 JSON / 属性乱序） | 6 |
| D | 引用列表（去重 / hidden / `text`↔`title` 回落） | 3 |
| E | 截断与配额（clamp 边界） | 4 |
| F | 引用角标（`^3^` / `^3^^5^` / `2^10` 不误伤） | 5 |
| G | SSE 主通道（增量 / 快照自适应 / `endTurn` / 坏事件 / 截断） | 15 |

### 8.2 真机端到端（5 条查询，全部 `via=baikan-sse`）

```
✓ OpenSpec 是什么                2949ms   found=true  blocks=8   chars=400  cites=2
✓ Kubernetes 探针有哪几种         2402ms   found=true  blocks=10  chars=400  cites=2
✓ 如何排查 Java OOM              12779ms  found=true  blocks=17  chars=400  cites=2
✓ React useEffect 依赖数组        9726ms  found=true  blocks=13  chars=400  cites=2
✓ 今天上海天气                    4617ms   found=true  blocks=4   chars=344  cites=2
```

其中第 2、3 条正是此前**移动站完全失败**的两个查询，说明主备换位是对的。

### 8.3 全量回归

`npm run build` → Exit 0；`npm test` → **245/245**（存量 204 零回归 + 新增 41）。扩展侧 **0 行改动**。

---

## 9. 回滚

删除即可，无迁移、无缓存污染：

1. `mcp-server/src/baidu-ai-search.ts` 整文件；
2. `api-command-service.ts` 里 `aiSearch` + 三个私有方法 + `AI_SEARCH_*` 常量区；
3. `server.ts` 里 `ai_search` 的工具定义与 `case`；
4. `test/baidu-ai-search.test.mjs`。

因为 `ai_search` **不写任何缓存**（不进 `api-commands.json`、不进 `operationLogs`），回滚后不留任何残留状态。这是刻意的：它是一条**无状态查询接口**，不是命令集的一部分。

---

## 10. Roadmap

- [ ] **失效探测**：定期跑一组「已知有答案」的固定查询，`found: false` 连续出现即告警，解决 §7.2 的分辨难题。
- [ ] **失败原因细分**：把「无摘要」与「接口变更」在 `warnings` 里分开，而不是统一提示换问法。
- [ ] **多引擎**：抽 `AiAnswerExtractor` 接口，Bing Copilot / Google AI Overview 各实现一份。
- [ ] **答案片段结构化**：`markdown-yiyan` 之外还有 `list` / `table` / `card` 类组件，目前一律只取 `markdown-yiyan`，结构化组件的信息会丢。
