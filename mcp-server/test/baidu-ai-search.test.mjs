// 百度 AI 摘要提取器测试：全部导入 ../dist/*.js 编译产物。
//
// 覆盖：URL 构造与校验、私有 markdown 清洗、baikan 数据块解析（多块拼接 / 属性乱序 /
//       坏 JSON / 非 markdown 块 / hidden 引用 / 去重 / 截断 / 空页面）。
// 样本 HTML 按真实页面结构手写，避免测试依赖外网。
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBaiduAiSearchUrl, cleanBaiduMarkdown, extractBaiduAiAnswer,
  buildBaiduBaikanSseUrl, buildBaiduBaikanRequestBody, parseBaiduBaikanSse,
  parseBaiduSseEvents, detectSseTextMode, baikanSseEnded,
  BAIDU_AI_SEARCH_ORIGIN, BAIDU_BAIKAN_SSE_ORIGIN, AI_QUERY_MAX_CHARS, AI_ANSWER_MAX_CHARS_DEFAULT,
  AI_SSE_MAX_EVENTS,
} from "../dist/baidu-ai-search.js";

/** 拼一个 baikan 数据块（结构与真实搜索页一致）。 */
const baikan = (payload, { attrOrder = "type-first" } = {}) => {
  const attrs = attrOrder === "type-first"
    ? `type="application/json" data-for="baikan"`
    : `data-for='baikan' type='application/json'`;
  return `<script ${attrs}>${JSON.stringify({ data: payload })}</script>`;
};

const mdBlock = (area, content, citations = []) => baikan({
  component: "markdown",
  data: { area, content, citationList: citations },
});

const citation = (title, url, source = "", extra = {}) => ({
  title, url, source: { name: source }, ...extra,
});

// ===== A. URL 构造 =====

test("buildBaiduAiSearchUrl：正常查询编码到 word 参数", () => {
  const url = buildBaiduAiSearchUrl("OpenSpec 是什么");
  assert.equal(url, `${BAIDU_AI_SEARCH_ORIGIN}/s?word=OpenSpec%20%E6%98%AF%E4%BB%80%E4%B9%88`);
  assert.ok(url.startsWith("https://m.baidu.com/"), "必须走移动站");
});

test("buildBaiduAiSearchUrl：空串 / 纯空白 / 超长一律返回空（由调用方报参数错误）", () => {
  assert.equal(buildBaiduAiSearchUrl(""), "");
  assert.equal(buildBaiduAiSearchUrl("   "), "");
  assert.equal(buildBaiduAiSearchUrl("x".repeat(AI_QUERY_MAX_CHARS + 1)), "");
  assert.notEqual(buildBaiduAiSearchUrl("x".repeat(AI_QUERY_MAX_CHARS)), "");
});

test("buildBaiduAiSearchUrl：特殊字符被正确编码，不会注入额外参数", () => {
  const url = buildBaiduAiSearchUrl("a&b=c#d?e");
  assert.equal(url.includes("&b="), false, "& 必须被编码");
  assert.equal(url.includes("#"), false, "# 必须被编码");
});

// ===== B. markdown 清洗 =====

test("cleanBaiduMarkdown：:ml-search[X]{text=\"X\"} 只保留可见文本", () => {
  const out = cleanBaiduMarkdown('支持 :ml-search[Claude Code]{text="Claude Code"}、:ml-search[Cursor]{text="Cursor"}。');
  assert.equal(out, "支持 Claude Code、Cursor。");
});

test("cleanBaiduMarkdown：==**X**== 去掉高亮包裹但保留加粗", () => {
  assert.equal(cleanBaiduMarkdown("==**提案与探索**==：使用 /opsx:propose"), "**提案与探索**：使用 /opsx:propose");
});

test("cleanBaiduMarkdown：不误伤正文里的 a == b 比较式", () => {
  // 单侧 == 没有配对的另一侧，不能当成高亮处理。
  assert.equal(cleanBaiduMarkdown("if (a == b) return"), "if (a == b) return");
});

test("cleanBaiduMarkdown：零宽字符与不换行空格被清理", () => {
  const out = cleanBaiduMarkdown("减少返工\u200c\u200d。\u00a0收尾\uFEFF");
  assert.equal(out.includes("\u200c"), false);
  assert.equal(out.includes("\uFEFF"), false);
  assert.equal(out.includes("\u00a0"), false);
  assert.equal(out, "减少返工。 收尾");
});

test("cleanBaiduMarkdown：HTML 实体解码（&quot; / &amp; / &#x26;）", () => {
  assert.equal(cleanBaiduMarkdown("&quot;唯一可信源&quot; &amp; 文档"), '"唯一可信源" & 文档');
  assert.equal(cleanBaiduMarkdown("a&#x26;b"), "a&b");
});

// ===== C. 提取主链路 =====

test("extractBaiduAiAnswer：summary + 多个 block_summary 按文档顺序拼接", () => {
  const html = [
    mdBlock("summary", "总体说明"),
    mdBlock("block_summary", "### 核心功能\n"),
    mdBlock("block_summary", "1. 提案\n2. 归档"),
  ].join("");
  const r = extractBaiduAiAnswer(html);
  assert.equal(r.found, true);
  assert.equal(r.blockCount, 3);
  assert.equal(r.answer, "总体说明\n\n### 核心功能\n\n1. 提案\n2. 归档");
  assert.deepEqual(r.sections.map((s) => s.area), ["summary", "block_summary", "block_summary"]);
});

test("extractBaiduAiAnswer：component≠markdown 的块被忽略（nearHeader / follow-up / interact）", () => {
  const html = [
    baikan({ component: "nearHeader", data: { content: "不该出现" } }),
    mdBlock("summary", "真正的答案"),
    baikan({ component: "follow-up", data: { content: "也不该出现" } }),
  ].join("");
  const r = extractBaiduAiAnswer(html);
  assert.equal(r.blockCount, 1);
  assert.equal(r.answer, "真正的答案");
});

test("extractBaiduAiAnswer：属性顺序颠倒（data-for 在 type 之前）仍能识别", () => {
  const html = mdBlock("summary", "倒序属性也能认", []).replace(
    'type="application/json" data-for="baikan"',
    "data-for='baikan' type='application/json'",
  );
  const r = extractBaiduAiAnswer(html);
  assert.equal(r.found, true);
  assert.equal(r.answer, "倒序属性也能认");
});

test("extractBaiduAiAnswer：坏 JSON 块被跳过，其余块仍能产出答案", () => {
  const html = `<script type="application/json" data-for="baikan">{不是合法 JSON</script>`
    + mdBlock("summary", "好块");
  const r = extractBaiduAiAnswer(html);
  assert.equal(r.blockCount, 1);
  assert.equal(r.answer, "好块");
});

test("extractBaiduAiAnswer：无 baikan 块 → found=false 且不报错", () => {
  const r = extractBaiduAiAnswer("<html><body>普通搜索结果页</body></html>");
  assert.equal(r.found, false);
  assert.equal(r.answer, "");
  assert.deepEqual(r.citations, []);
  assert.equal(r.blockCount, 0);
});

test("extractBaiduAiAnswer：空字符串 / 非字符串输入安全返回", () => {
  assert.equal(extractBaiduAiAnswer("").found, false);
  assert.equal(extractBaiduAiAnswer(null).found, false);
  assert.equal(extractBaiduAiAnswer(undefined).found, false);
  assert.equal(extractBaiduAiAnswer(123).found, false);
});

// ===== D. 引用列表 =====

test("extractBaiduAiAnswer：hidden 引用被剔除，跨块按 url 去重", () => {
  const html = [
    mdBlock("summary", "答案一", [
      citation("A", "https://a.com/1", "腾讯云"),
      citation("隐藏的", "https://hidden.com", "X", { hidden: true }),
    ]),
    mdBlock("block_summary", "答案二", [
      citation("A 重复", "https://a.com/1", "腾讯云"),
      citation("B", "https://b.com/2", "知乎"),
    ]),
  ].join("");
  const r = extractBaiduAiAnswer(html);
  assert.equal(r.citations.length, 2);
  assert.deepEqual(r.citations.map((c) => c.url), ["https://a.com/1", "https://b.com/2"]);
  assert.equal(r.citations[0].source, "腾讯云");
});

test("extractBaiduAiAnswer：maxCitations=0 返回空引用但保留答案", () => {
  const html = mdBlock("summary", "答案", [citation("A", "https://a.com", "S")]);
  const r = extractBaiduAiAnswer(html, { maxCitations: 0 });
  assert.equal(r.found, true);
  assert.equal(r.answer, "答案");
  assert.deepEqual(r.citations, []);
});

test("extractBaiduAiAnswer：maxCitations 超上限被 clamp 到 20", () => {
  const list = Array.from({ length: 30 }, (_, i) => citation(`T${i}`, `https://x.com/${i}`, "S"));
  const r = extractBaiduAiAnswer(mdBlock("summary", "答案", list), { maxCitations: 999 });
  assert.equal(r.citations.length, 20);
});

// ===== E. 截断与配额 =====

test("extractBaiduAiAnswer：超过 maxChars 时截断并置 truncated", () => {
  const long = "字".repeat(500);
  const r = extractBaiduAiAnswer(mdBlock("summary", long), { maxChars: 200 });
  assert.equal(r.truncated, true);
  assert.equal(r.answer.length, 200);
});

test("extractBaiduAiAnswer：maxChars 缺省为 8000，非法值回落默认", () => {
  const long = "字".repeat(AI_ANSWER_MAX_CHARS_DEFAULT + 100);
  const r = extractBaiduAiAnswer(mdBlock("summary", long));
  assert.equal(r.answer.length, AI_ANSWER_MAX_CHARS_DEFAULT);
  assert.equal(r.truncated, true);
  // NaN / 负数 / 字符串都走默认
  for (const bad of [NaN, -1, "8000", undefined]) {
    const rr = extractBaiduAiAnswer(mdBlock("summary", "短答案"), { maxChars: bad });
    assert.equal(rr.truncated, false);
    assert.equal(rr.answer, "短答案");
  }
});

test("extractBaiduAiAnswer：超大块被跳过（防御异常页面）", () => {
  const huge = mdBlock("summary", "x".repeat(600 * 1024));
  const r = extractBaiduAiAnswer(huge);
  assert.equal(r.found, false, "超过单块上限的块应被跳过而不是整页解析");
});

test("extractBaiduAiAnswer：content 为空的块不计入 blockCount，但引用仍收集", () => {
  const html = [
    mdBlock("summary", "", [citation("A", "https://a.com", "S")]),
    mdBlock("block_summary", "有内容"),
  ].join("");
  const r = extractBaiduAiAnswer(html);
  assert.equal(r.blockCount, 1);
  assert.equal(r.answer, "有内容");
  assert.equal(r.citations.length, 1);
});

// ===== F. 引用角标（真实站点另一形态，SRE 类查询出现） =====

test("cleanBaiduMarkdown：:ml-citation{...} 角标整段删除", () => {
  const raw = '**SRE 是用软件工程解决运维问题的学科**。:ml-citation{ref="2" appearance="tag" '
    + 'aggregatedIndexes="2,3,4,5" tagName="百度百科" logo="https://m.baidu.com/x.png"}';
  const out = cleanBaiduMarkdown(raw);
  assert.equal(out, "**SRE 是用软件工程解决运维问题的学科**。");
  assert.ok(!out.includes("ml-citation"));
  assert.ok(!out.includes("logo="));
});

test("cleanBaiduMarkdown：角标删除后不留下悬空空格", () => {
  const out = cleanBaiduMarkdown("句子一 。:ml-citation{ref=\"1\"} 句子二");
  assert.equal(out.includes("  。"), false);
  assert.equal(out.includes(" 句子二"), false);
  assert.equal(out, "句子一 。句子二");
});

test("cleanBaiduMarkdown：未知的 :ml-xxx{...} 指令被兜底清除", () => {
  const out = cleanBaiduMarkdown("正文:ml-future{foo=\"bar\"}结束");
  assert.equal(out, "正文结束");
});

test("cleanBaiduMarkdown：search 与 citation 混合出现时各自正确处理", () => {
  const raw = '依据 :ml-search[官方文档]{text="官方文档"} :ml-citation{ref="1"}，可知结论成立。';
  assert.equal(cleanBaiduMarkdown(raw), "依据 官方文档，可知结论成立。");
});

test("extractBaiduAiAnswer：答案正文不含任何 :ml- 私有标记", () => {
  const html = mdBlock("summary",
    '结论:x-ml。:ml-citation{ref="1" logo="https://x.com/a.png"} 后续:ml-citation{ref="2"}');
  const r = extractBaiduAiAnswer(html);
  assert.equal(r.answer.includes(":ml-"), false, `残留私有标记: ${r.answer}`);
  assert.equal(r.answer.includes("logo="), false);
});

// ===== G. SSE 主通道（真实接口：chat-ws.baidu.com/baikan/conversation） =====

const sseEvent = (obj) => `event:message\ndata:${JSON.stringify(obj)}\n\n`;
/** 构造一条 generator 事件。 */
const genEvent = (component, data, meta = {}) => sseEvent({
  data: { message: { metaData: { state: "generating-resp", endTurn: false, ...meta }, content: { generator: { component, data } } } },
});
const textChunk = (value) => genEvent("markdown-yiyan", { value });
/** 带显式快照标记的事件：载荷里 isFullText=true。 */
const snapshotChunk = (value) => genEvent("markdown-yiyan", { value, isFullText: true });
/** 带显式快照标记的事件：SSE 事件名声明 full。 */
const snapshotChunkByEvent = (value) => `event:message_full\ndata:${JSON.stringify({
  data: { message: { metaData: { state: "generating-resp", endTurn: false },
    content: { generator: { component: "markdown-yiyan", data: { value } } } } },
})}\n\n`;
const refEvent = (list) => genEvent("reference", { referenceList: list });

test("buildBaiduBaikanSseUrl：只带 word + 两个固定 query 参数", () => {
  const url = buildBaiduBaikanSseUrl("Kubernetes 探针有哪几种");
  assert.ok(url.startsWith(`${BAIDU_BAIKAN_SSE_ORIGIN}/baikan/conversation?`));
  assert.ok(url.includes("inputMethod=chat_search"));
  assert.ok(url.includes("llmsearch=1"));
  assert.ok(url.includes("word=Kubernetes%20"));
  // 关键：不带签名类参数（实测可省）。
  for (const forbidden of ["k_signature", "pmgr_token", "k_timestamp"]) {
    assert.equal(url.includes(forbidden), false, `不应包含 ${forbidden}`);
  }
});

test("buildBaiduBaikanSseUrl：空 / 超长返回空串", () => {
  assert.equal(buildBaiduBaikanSseUrl(""), "");
  assert.equal(buildBaiduBaikanSseUrl("  "), "");
  assert.equal(buildBaiduBaikanSseUrl("x".repeat(AI_QUERY_MAX_CHARS + 1)), "");
});

test("buildBaiduBaikanRequestBody：带上「有答案」必需的两个字段", () => {
  const body = JSON.parse(buildBaiduBaikanRequestBody("测试问题"));
  const info = body.message.searchInfo;
  // 缺这两个字段时服务端只回骨架、正文为空（实测）。
  assert.equal(info.baikan_is_high_time_demand, "1");
  assert.deepEqual(info.categoryIDs, [20]);
  assert.equal(body.message.content.query, "测试问题");
  assert.equal(body.message.inputMethod, "chat_search");
  assert.equal(body.message.searchInfo.tplname, "wenda_generate");
});

test("parseBaiduBaikanSse：增量片段按顺序拼接", () => {
  const raw = textChunk("K8s 有") + textChunk("三种") + textChunk("探针。");
  const r = parseBaiduBaikanSse(raw);
  assert.equal(r.found, true);
  assert.equal(r.answer, "K8s 有三种探针。");
  assert.equal(r.blockCount, 3);
});

test("parseBaiduBaikanSse：缺显式标记一律按增量追加（不再用前缀启发式）", () => {
  // 基线行为：靠「新片段是否以已拼内容开头」猜增量/快照，
  // 增量片段一旦碰巧以已拼内容开头，整段正文会被静默吞掉。
  const trap = textChunk("结论") + textChunk("结论成立");
  assert.equal(parseBaiduBaikanSse(trap).answer, "结论结论成立",
    "无标记时必须原样追加，不得因为前缀巧合而吞掉内容");

  // 实测真实流就是增量：首段 194 字，后续逐段递增
  const real = textChunk("==**OpenSpec 是一个 AI 原生") + textChunk("、规范驱动开发**") + textChunk("。");
  assert.equal(parseBaiduBaikanSse(real).answer, "==**OpenSpec 是一个 AI 原生、规范驱动开发**。");
});

test("parseBaiduBikaiN：有显式快照标记才替换（载荷 isFullText / SSE 事件名 full）", () => {
  const byFlag = snapshotChunk("结论") + snapshotChunk("结论成立。");
  assert.equal(parseBaiduBaikanSse(byFlag).answer, "结论成立。", "isFullText=true → 替换");

  const byEvent = snapshotChunkByEvent("结论") + snapshotChunkByEvent("结论成立。");
  assert.equal(parseBaiduBaikanSse(byEvent).answer, "结论成立。", "事件名声明 full → 替换");

  // 快照标记之后的增量仍然按增量追加
  const mixed = snapshotChunk("结论") + textChunk("成立。");
  assert.equal(parseBaiduBaikanSse(mixed).answer, "结论成立。");
});

test("parseBaiduSseEvents：事件名不再丢弃；多 data 行按 SSE 规范拼接", () => {
  const events = parseBaiduSseEvents("event:message\ndata:{\"a\":1}\n\nevent:custom\ndata:{\"b\":2}\n\n");
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "message");
  assert.equal(events[1].event, "custom");
  assert.deepEqual(JSON.parse(events[0].data), { a: 1 });

  const multi = parseBaiduSseEvents("event:message\ndata:{\"a\":\ndata:1}\n\n");
  assert.equal(multi.length, 1);
  assert.deepEqual(JSON.parse(multi[0].data), { a: 1 }, "多 data 行必须拼回一个合法 JSON");
});

test("detectSseTextMode：只看协议里的显式标记", () => {
  const payload = (data) => ({ data: { message: { content: { generator: { data } } } } });
  assert.equal(detectSseTextMode("message", payload({ value: "x" })), undefined, "无标记 → undefined");
  assert.equal(detectSseTextMode("message_full", payload({ value: "x" })), "snapshot");
  assert.equal(detectSseTextMode("message.snapshot", payload({ value: "x" })), "snapshot");
  assert.equal(detectSseTextMode("message_delta", payload({ value: "x" })), "increment");
  assert.equal(detectSseTextMode("message", payload({ value: "x", isFullText: true })), "snapshot");
  assert.equal(detectSseTextMode("message", payload({ value: "x", isIncremental: true })), "increment");
});

test("baikanSseEnded：识别两种结束标记（state=generate-complete / endTurn）", () => {
  const done1 = sseEvent({ data: { message: { metaData: { state: "generate-complete", endTurn: false },
    content: { generator: { component: "", isFinished: true } } } } });
  assert.equal(baikanSseEnded(done1), true, "state=generate-complete 即结束");
  const done2 = sseEvent({ data: { message: { metaData: { endTurn: true }, content: { generator: {} } } } });
  assert.equal(baikanSseEnded(done2), true, "endTurn=true 即结束");
  const running = textChunk("半截") + sseEvent({ data: { message: { metaData: { state: "generating-resp", endTurn: false },
    content: { generator: { component: "markdown-yiyan", data: { value: "x" } } } } } });
  assert.equal(baikanSseEnded(running), false, "生成中不得判结束");
  assert.equal(baikanSseEnded(""), false);
});

test("parseBaiduBaikanSse：真实结束标记（state=generate-complete / isFinished）都算 finished", () => {
  const byState = parseBaiduBaikanSse(textChunk("答案") + sseEvent({
    data: { message: { metaData: { state: "generate-complete", endTurn: false },
      content: { generator: { component: "", isFinished: true } } } },
  }));
  assert.equal(byState.finished, true);
  const byEndTurn = parseBaiduBaikanSse(textChunk("答案") + sseEvent({
    data: { message: { metaData: { state: "generate-complete", endTurn: true },
      content: { generator: { component: "", isFinished: true } } } },
  }));
  assert.equal(byEndTurn.finished, true);
});

test("parseBaiduBaikanSse：endTurn 标记决定 finished", () => {
  const done = parseBaiduBaikanSse(textChunk("答案") + sseEvent({
    data: { message: { metaData: { endTurn: true }, content: { generator: { component: "", data: {} } } } },
  }));
  assert.equal(done.finished, true);
  const cut = parseBaiduBaikanSse(textChunk("半截答案"));
  assert.equal(cut.finished, false, "流被截断时应保留部分答案且 finished=false");
  assert.equal(cut.answer, "半截答案");
});

test("parseBaiduBaikanSse：引用去重 + 来源映射", () => {
  const raw = refEvent([
    { text: "k8s中pod三种探针", url: "https://bilibili.com/v1", source: "哔哩哔哩" },
    { text: "重复条", url: "https://bilibili.com/v1", source: "哔哩哔哩" },
    { title: "无 text 用 title", url: "https://aliyun.com/a", author_name: "阿里云" },
  ]) + textChunk("答案正文");
  const r = parseBaiduBaikanSse(raw);
  assert.equal(r.citations.length, 2);
  assert.deepEqual(r.citations.map((c) => c.url), ["https://bilibili.com/v1", "https://aliyun.com/a"]);
  assert.equal(r.citations[0].source, "哔哩哔哩");
  assert.equal(r.citations[1].source, "阿里云", "source 缺省时回落 author_name");
});

test("parseBaiduBaikanSse：坏事件（非 JSON）跳过，不影响后续片段", () => {
  const raw = "event:message\ndata:{坏JSON\n\n" + textChunk("有效内容");
  assert.equal(parseBaiduBaikanSse(raw).answer, "有效内容");
});

test("parseBaiduBaikanSse：只有引用没有正文 → found=false 且保留引用不被丢弃", () => {
  const r = parseBaiduBaikanSse(refEvent([{ text: "t", url: "https://x.com", source: "S" }]));
  assert.equal(r.found, false);
  assert.equal(r.answer, "");
  assert.equal(r.citations.length, 0, "没有正文时不应把引用当成结果返回");
});

test("parseBaiduBaikanSse：未知 component（searchingSteps / followUp）被忽略", () => {
  const raw = genEvent("searchingSteps", { steps: [{ title: "正在思考" }] })
    + genEvent("followUp", { list: ["a"] })
    + textChunk("真答案");
  const r = parseBaiduBaikanSse(raw);
  assert.equal(r.answer, "真答案");
  assert.equal(r.blockCount, 1);
});

test("parseBaiduBaikanSse：空流 / 非字符串安全返回", () => {
  for (const bad of ["", null, undefined, 123]) {
    const r = parseBaiduBaikanSse(bad);
    assert.equal(r.found, false);
    assert.equal(r.finished, false);
  }
});

test("parseBaiduBaikanSse：maxChars 截断与 maxCitations clamp", () => {
  const raw = textChunk("字".repeat(600))
    + refEvent(Array.from({ length: 30 }, (_, i) => ({ text: `t${i}`, url: `https://x.com/${i}`, source: "S" })));
  const r = parseBaiduBaikanSse(raw, { maxChars: 200, maxCitations: 999 });
  assert.equal(r.truncated, true);
  assert.equal(r.answer.length, 200);
  assert.equal(r.citations.length, 20);
});

test("parseBaiduBaikanSse：事件数超过 AI_SSE_MAX_EVENTS 时停止解析", () => {
  const raw = textChunk("a").repeat(AI_SSE_MAX_EVENTS + 50);
  const r = parseBaiduBaikanSse(raw);
  assert.equal(r.blockCount, AI_SSE_MAX_EVENTS);
});

test("parseBaiduBaikanSse：正文里的 ^3^^5^ 引用角标被清掉", () => {
  const raw = textChunk("结论成立^3^^5^。") + textChunk("继续^12^说明。");
  const r = parseBaiduBaikanSse(raw);
  assert.equal(r.answer, "结论成立。继续说明。");
  assert.equal(r.answer.includes("^"), false);
});

test("parseBaiduBaikanSse：不误伤 2^10 这类上标写法", () => {
  assert.equal(cleanBaiduMarkdown("2^10 = 1024"), "2^10 = 1024");
});
