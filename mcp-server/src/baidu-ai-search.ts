/**
 * 百度 AI 摘要（搜索页顶部的「AI 智能回答」）提取器。
 *
 * ## 两条通道，主 + 备
 *
 * 抓真实搜索页流量后确认的事实：
 *
 * 1. **桌面站（www.baidu.com）** 的答案由一条 SSE 接口流式生成：
 *    `POST https://chat-ws.baidu.com/baikan/conversation?inputMethod=chat_search&word=…&llmsearch=1`
 *    HTML 里**没有**答案正文（`探针一共有` 在 1MB 页面里出现 0 次），只有渲染骨架。
 *    这条通道覆盖了桌面站的全部 AI 摘要，且**不需要任何 token / 签名 / 登录态**：
 *    实测 `k_signature` / `pmgr_token` / `lid` / `qid` 都能省掉，只要 body 里带上
 *    `baikan_is_high_time_demand: "1"` 与 `categoryIDs: [20]`，服务端就会正常生成。
 *    → 这是主通道（`parseBaiduBaikanSse`）。
 *
 * 2. **移动站（m.baidu.com）** 的答案**是**服务端直出的结构化 data block：
 *
 *    ```html
 *    <script type="application/json" data-for="baikan" data-repeatable>
 *      {"data":{"component":"markdown","data":{
 *         "area":"summary",
 *         "content":"==**OpenSpec 是一个 AI 原生的…**==，旨在…",
 *         "citationList":[{"title":"…","url":"https://…","source":{"name":"腾讯云"}}]
 *      }}}
 *    </script>
 *    ```
 *
 *    页面上有十几个 `data-for="baikan"` 块，只有 `component === "markdown"` 承载正文，
 *    按文档顺序（`summary` + 若干 `block_summary`）拼接即完整答案。
 *    但移动站的 **AI 覆盖率明显更低**（实测「Kubernetes 探针有哪几种」「如何排查 Java OOM」
 *    在移动站完全没有 AI 卡片），所以只作为 SSE 不可用时的兜底（`extractBaiduAiAnswer`）。
 *
 * ## 边界
 *
 * - 纯函数：无 IO、无全局状态、无副作用，可直接 `node --test`。
 * - 不是每个查询都有 AI 摘要，`found: false` 是**正常结果**，不是错误。
 * - 只认识 baidu 这一个引擎；换引擎需要新提取器。
 */

/** 主通道：AI 摘要的 SSE 生成接口（`word` 在 URL，其余参数在 body）。 */
export const BAIDU_BAIKAN_SSE_ORIGIN = "https://chat-ws.baidu.com";
export const BAIDU_BAIKAN_SSE_PATH = "/baikan/conversation?inputMethod=chat_search&llmsearch=1&word=";
/** 兜底通道：移动站搜索页（SSR 的 baikan data block）。 */
export const BAIDU_AI_SEARCH_ORIGIN = "https://m.baidu.com";
/** 查询串模板；`{{query}}` 由调用方 URL 编码后填入。 */
export const BAIDU_AI_SEARCH_PATH = "/s?word=";

/** 单条答案的默认 / 最大字符数。 */
export const AI_ANSWER_MAX_CHARS_DEFAULT = 8000;
export const AI_ANSWER_MAX_CHARS_LIMIT = 30000;
/** 引用条数上限。 */
export const AI_CITATIONS_MAX = 20;
/** 单个 baikan 数据块的解析上限（防御异常页面）。 */
export const AI_BAIKAN_BLOCK_MAX_CHARS = 512 * 1024;
/** 查询串长度上限（字符）。 */
export const AI_QUERY_MAX_CHARS = 200;

export interface AiSearchCitation {
  title: string;
  url: string;
  /** 来源站点名（腾讯云 / 知乎 / GitHub…），缺失时为空串。 */
  source: string;
}

export interface AiSearchSection {
  /** 数据块自身的 area 标记：`summary` 或 `block_summary`。 */
  area: string;
  /** 该块清洗后的 markdown 片段。 */
  content: string;
}

export interface BaiduAiAnswer {
  /** 是否真的找到了 AI 摘要。为 false 时其余字段为空，**不视为错误**。 */
  found: boolean;
  /** 拼接并清洗后的完整答案（markdown）。 */
  answer: string;
  /** 逐块片段，便于调用方按需截取或跳过总述。 */
  sections: AiSearchSection[];
  /** 引用来源，已按 url 去重、剔除 hidden。 */
  citations: AiSearchCitation[];
  /** 参与拼接的正文块数量（不含 component≠markdown 的块）。 */
  blockCount: number;
  /** 答案是否因 `maxChars` 被截断。 */
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 极简实体解码：只为去掉 `&quot;` 这类会污染正文的转义，不做完整 HTML 解码。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * 清洗百度答案的私有 markdown 语法。
 *
 * 实测出现过的三类标记：
 *  - `:ml-search[TEXT]{text="TEXT"}` —— 内联「可搜索」锚点，只保留 TEXT；
 *  - `:ml-citation{ref="2" tagName="百度百科" logo="https://…"}` —— 引用角标，
 *    没有任何可见文本（引用本体已由 citationList 单独返回），整段删除；
 *  - `==**加粗**==` —— 高亮包裹，去掉 `==` 但保留内部 markdown。
 * 另有大量零宽字符（U+200B..U+200F / U+2060 / U+FEFF）散落在句末，一并清掉。
 */
export function cleanBaiduMarkdown(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  let text = decodeEntities(raw);
  text = text.replace(/:ml-search\[([^\]]*)\](?:\{[^}]*\})?/g, "$1");
  // 引用角标：连同行内多余空白一起删，避免句末留下悬空空格。
  text = text.replace(/[ \t]*:ml-citation\s*(?:\{[^}]*\})?[ \t]*/g, "");
  // 兜底：未来新增的 :ml-xxx{...} 指令一律去掉，不让脏标记进正文。
  text = text.replace(/[ \t]*:ml-[a-z-]+\s*(?:\{[^}]*\})?[ \t]*/g, "");
  // 只吃「不含 = 的成对 ==」，避免误伤 `a == b` 这类正文内容。
  text = text.replace(/==([^=]+)==/g, "$1");
  // 引用角标 `^3^` / `^3^^5^`：序号已由 citations 单独返回，正文里不留。
  // 必须以 ^ 开头且以 ^ 收尾，避免误伤 `2^10` 这类上标。
  text = text.replace(/\^\d+(?:\^+\d+)*\^+/g, "");
  text = text.replace(/[\u200B-\u200F\u2060\uFEFF]/g, "");
  text = text.replace(/\u00A0/g, " ");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** 构造搜索页 URL；query 为空时返回空串（由调用方当参数错误处理）。 */
export function buildBaiduAiSearchUrl(query: string): string {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed || trimmed.length > AI_QUERY_MAX_CHARS) return "";
  return `${BAIDU_AI_SEARCH_ORIGIN}${BAIDU_AI_SEARCH_PATH}${encodeURIComponent(trimmed)}`;
}

/** 从一段 `<script ... data-for="baikan">` 的 body 中取出正文（只认 component=markdown）。 */
function readMarkdownPayload(body: string): { area: string; content: string; citations: AiSearchCitation[] } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const data = parsed.data;
  if (!isRecord(data) || data.component !== "markdown") return undefined;
  const payload = data.data;
  if (!isRecord(payload)) return undefined;

  const content = typeof payload.content === "string" ? payload.content : "";
  const citations: AiSearchCitation[] = [];
  if (Array.isArray(payload.citationList)) {
    for (const raw of payload.citationList) {
      if (!isRecord(raw)) continue;
      if (raw.hidden === true) continue;
      const url = typeof raw.url === "string" ? raw.url.trim() : "";
      const title = typeof raw.title === "string" ? raw.title.trim() : "";
      if (!url && !title) continue;
      const source = isRecord(raw.source) && typeof raw.source.name === "string" ? raw.source.name.trim() : "";
      citations.push({ title, url, source });
    }
  }
  const area = typeof payload.area === "string" ? payload.area : "";
  return { area, content, citations };
}

/**
 * 从搜索页 HTML 中提取 AI 摘要。
 *
 * @param html 搜索页完整 HTML（不需要预清洗）
 * @param opts.maxChars 答案截断上限，默认 8000，clamp 到 [200, 30000]
 * @param opts.maxCitations 引用条数上限，默认 10，clamp 到 [0, 20]
 */
export function extractBaiduAiAnswer(
  html: string,
  opts: { maxChars?: number; maxCitations?: number } = {},
): BaiduAiAnswer {
  const empty: BaiduAiAnswer = {
    found: false, answer: "", sections: [], citations: [], blockCount: 0, truncated: false,
  };
  if (typeof html !== "string" || html.length === 0) return empty;

  const maxChars = Number.isFinite(opts.maxChars)
    ? Math.min(AI_ANSWER_MAX_CHARS_LIMIT, Math.max(200, Math.floor(Number(opts.maxChars))))
    : AI_ANSWER_MAX_CHARS_DEFAULT;
  const maxCitations = Number.isFinite(opts.maxCitations)
    ? Math.min(AI_CITATIONS_MAX, Math.max(0, Math.floor(Number(opts.maxCitations))))
    : 10;

  const sections: AiSearchSection[] = [];
  const seenUrls = new Set<string>();
  const citations: AiSearchCitation[] = [];

  // 属性顺序不固定：先抓所有 script 标签，再在属性串里同时匹配 type / data-for。
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const attrs = match[1] ?? "";
    if (!/data-for\s*=\s*["']baikan["']/i.test(attrs)) continue;
    if (!/type\s*=\s*["']application\/json["']/i.test(attrs)) continue;
    const body = match[2] ?? "";
    if (body.length === 0 || body.length > AI_BAIKAN_BLOCK_MAX_CHARS) continue;

    const payload = readMarkdownPayload(body);
    if (!payload) continue;
    const content = cleanBaiduMarkdown(payload.content);
    if (content.length > 0) sections.push({ area: payload.area, content });
    for (const citation of payload.citations) {
      const key = citation.url || citation.title;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      citations.push(citation);
    }
  }

  if (sections.length === 0) return { ...empty, citations: [] };

  const joined = sections.map((section) => section.content).join("\n\n").trim();
  const truncated = joined.length > maxChars;
  return {
    found: true,
    answer: truncated ? joined.slice(0, maxChars) : joined,
    sections,
    citations: citations.slice(0, maxCitations),
    blockCount: sections.length,
    truncated,
  };
}

// ===========================================================================
// 主通道：baikan SSE 生成接口
// ===========================================================================

/** 单次生成允许解析的最大事件数（防御异常长流）。 */
export const AI_SSE_MAX_EVENTS = 800;

/**
 * 构造 SSE 接口 URL。
 *
 * 只需要 `word`（查询词）+ 两个固定 query 参数；`k_signature` / `pmgr_token` /
 * `k_timestamp` 在真实请求里存在，但**实测可以全部省略**（服务端不校验）。
 */
export function buildBaiduBaikanSseUrl(query: string): string {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed || trimmed.length > AI_QUERY_MAX_CHARS) return "";
  return `${BAIDU_BAIKAN_SSE_ORIGIN}${BAIDU_BAIKAN_SSE_PATH}${encodeURIComponent(trimmed)}`;
}

/**
 * 构造固定请求体。
 *
 * 两个字段是"有答案 / 空答案"的分水岭（实测）：
 *  - `searchInfo.baikan_is_high_time_demand: "1"` —— 不加就只有骨架没有正文；
 *  - `searchInfo.categoryIDs: [20]` —— 同上。
 * `lid` / `qid` 留空即可（真实请求里是搜索页分配的，服务端不强制）。
 */
export function buildBaiduBaikanRequestBody(query: string): string {
  return JSON.stringify({
    message: {
      inputMethod: "chat_search",
      isRebuild: false,
      content: { query, qtype: 0 },
      searchInfo: {
        is_follow_up: "1",
        dqa_is_wenda: "1",
        categoryIDs: [20],
        baikan_is_high_time_demand: "1",
        srcid: "279",
        order: "1",
        tplname: "wenda_generate",
        strategy: "",
        ori_lid: "",
        re_rank: "",
        lid: "",
        qid: "",
        viscate_qid: "",
      },
      source: "ala_279",
      from: "apage_dqa",
      dqaRewrite: {},
    },
  });
}

/**
 * 解析 SSE 流为答案。
 *
 * 协议要点（实测）：
 *  - 每个事件一行 `data:{json}`，事件之间空行分隔；
 *  - 正文在 `data.message.content.generator`，`component === "markdown-yiyan"` 时
 *    `generator.data.value` 是**增量片段**（逐字 / 逐词）；
 *  - `component === "reference"` 时 `generator.data.referenceList` 是引用出处；
 *  - `metaData.endTurn === true` 或 `state === "generate-complete"` 表示结束。
 *
 * 容错策略：流被截断（超时 / 网络断）时，已收到的片段仍然返回，只把
 * `finished` 置 false —— 半截答案也远胜于报错。
 */
export function parseBaiduBaikanSse(
  raw: string,
  opts: { maxChars?: number; maxCitations?: number } = {},
): BaiduAiAnswer & { finished: boolean } {
  const maxChars = Number.isFinite(opts.maxChars)
    ? Math.min(AI_ANSWER_MAX_CHARS_LIMIT, Math.max(200, Math.floor(Number(opts.maxChars))))
    : AI_ANSWER_MAX_CHARS_DEFAULT;
  const maxCitations = Number.isFinite(opts.maxCitations)
    ? Math.min(AI_CITATIONS_MAX, Math.max(0, Math.floor(Number(opts.maxCitations))))
    : 10;

  const empty = {
    found: false, answer: "", sections: [] as AiSearchSection[],
    citations: [] as AiSearchCitation[], blockCount: 0, truncated: false, finished: false,
  };
  if (typeof raw !== "string" || raw.length === 0) return empty;

  let answer = "";
  let chunkCount = 0;
  let finished = false;
  const seenUrls = new Set<string>();
  const citations: AiSearchCitation[] = [];

  const events = raw.split(/\n{2,}/);
  const limit = Math.min(events.length, AI_SSE_MAX_EVENTS);
  for (let i = 0; i < limit; i += 1) {
    const dataLine = events[i].split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLine.slice(5).trim());
    } catch {
      continue;  // 坏事件跳过，不影响后续片段
    }
    if (!isRecord(payload)) continue;
    const data = payload.data;
    if (!isRecord(data)) continue;
    const message = data.message;
    if (!isRecord(message)) continue;

    const meta = message.metaData;
    if (isRecord(meta) && meta.endTurn === true) finished = true;

    const content = message.content;
    if (!isRecord(content)) continue;
    const generator = content.generator;
    if (!isRecord(generator)) continue;

    if (generator.component === "markdown-yiyan") {
      const inner = generator.data;
      const value = isRecord(inner) && typeof inner.value === "string" ? inner.value : "";
      if (value.length > 0) {
        chunkCount += 1;
        // 兼容两种服务端实现：增量片段（追加）与全量快照（替换）。
        answer = value.startsWith(answer) && value.length >= answer.length ? value : answer + value;
      }
    } else if (generator.component === "reference") {
      const inner = generator.data;
      const list = isRecord(inner) && Array.isArray(inner.referenceList) ? inner.referenceList : [];
      for (const rawRef of list) {
        if (!isRecord(rawRef)) continue;
        const url = typeof rawRef.url === "string" ? rawRef.url.trim() : "";
        const title = typeof rawRef.text === "string" && rawRef.text.trim()
          ? rawRef.text.trim()
          : (typeof rawRef.title === "string" ? rawRef.title.trim() : "");
        if (!url && !title) continue;
        const key = url || title;
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        const source = typeof rawRef.source === "string" && rawRef.source.trim()
          ? rawRef.source.trim()
          : (typeof rawRef.author_name === "string" ? rawRef.author_name.trim() : "");
        citations.push({ title, url, source });
      }
    }
  }

  const cleaned = cleanBaiduMarkdown(answer);
  if (cleaned.length === 0) return { ...empty, finished };

  const truncated = cleaned.length > maxChars;
  const text = truncated ? cleaned.slice(0, maxChars) : cleaned;
  return {
    found: true,
    answer: text,
    sections: chunkCount > 0 ? [{ area: "sse", content: text }] : [],
    citations: citations.slice(0, maxCitations),
    blockCount: chunkCount,
    truncated,
    finished,
  };
}
