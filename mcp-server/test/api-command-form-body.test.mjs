// P1 修复：表单编码（application/x-www-form-urlencoded）请求体的命令生成与渲染。
//
// 修复前：归一化层能解析出表单字段，但生成层只在 bodyIsJson 时产出 bodyTemplate，
// 表单体被整体丢弃 → 命令「URL 正确、请求体为空」→ 服务端按缺参拒绝。
// 修复后：表单体同样生成 bodyTemplate，并带 bodyFormat="form"，
// 渲染层按表单形态编码 + 补 Content-Type。
//
// 口径：
//  - bodyFormat 缺省即 json —— 与修复前的产物形状、渲染行为完全等价（旧缓存无需迁移）；
//  - json / form 可被命令模型完整承载；其余形态（有体但解析不出 / 组内形态不一致）
//    一律不生成 bodyTemplate 并显式进 needsReview（fail-closed，绝不静默截断）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRecords, resolveBodyEncoding,
} from "../dist/api-command-normalize.js";
import { generateCommands, groupBodyEncoding } from "../dist/api-command-generator.js";
import { renderRequest } from "../dist/api-command-render.js";
import { toCommand } from "../dist/api-command-cache.js";
import {
  BODY_FORMATS, BODY_ENCODINGS, FORM_BODY_REVIEW_REASON, NON_JSON_BODY_REVIEW_REASON,
  GENERATED_BY,
} from "../dist/api-command-types.js";

const DOMAIN = "fecs.console.aliyun.com";

/** 抓包原始记录（CDP 形态）：表单体 / JSON 体 / 无体 / 无法解析的体。 */
const raw = (overrides = {}) => ({
  requestId: "r1",
  url: `https://${DOMAIN}/data/api.json?GetTraceApp`,
  method: "POST",
  host: DOMAIN,
  path: "/data/api.json",
  query: "GetTraceApp=",
  status: 200,
  mimeType: "application/json",
  resourceType: "xhr",
  timestamp: 1,
  headerNames: ["content-type"],
  postData: null,
  hasPostData: false,
  ...overrides,
});

const ctx = (overrides = {}) => ({
  domain: DOMAIN, analysisId: "an_form_001", generatedBy: GENERATED_BY,
  schema: new Map(), ...overrides,
});

// ---------------------------------------------------------------------------
// A. 归一层：请求体形态判定
// ---------------------------------------------------------------------------

test("A1 归一化层识别表单编码请求体，bodyFormat=form", () => {
  const record = normalizeRecords([raw({
    postData: "product=arms&region=cn-hangzhou&params=%7B%22Pid%22%3A%22x%22%7D",
    hasPostData: true,
  })], DOMAIN)[0];
  assert.equal(record.bodyFormat, "form");
  assert.equal(record.bodyIsJson, false);
  assert.deepEqual(record.bodyFields.map((f) => f.name), ["product", "region", "params"]);
  assert.equal(resolveBodyEncoding(record), "form");
});

test("A2 归一化层识别 JSON 请求体，bodyFormat=json", () => {
  const record = normalizeRecords([raw({
    postData: "{\"size\":10}",
    hasPostData: true,
  })], DOMAIN)[0];
  assert.equal(record.bodyFormat, "json");
  assert.equal(record.bodyIsJson, true);
});

test("A3 无请求体 → none；有体但解析不出字段 → other（显式标注，绝不静默当无体）", () => {
  const empty = normalizeRecords([raw()], DOMAIN)[0];
  assert.equal(empty.bodyFormat, "none");

  const opaque = normalizeRecords([raw({
    postData: "not a structured body",
    hasPostData: true,
  })], DOMAIN)[0];
  assert.equal(opaque.bodyFormat, "other");
  assert.equal(opaque.bodyFields.length, 0);
});

test("A4 旧记录（无 bodyFormat）按既有事实回退推导，语义不变", () => {
  // 归一化层只有 urlencoded 分支会解析出非 JSON 字段 —— 回退是推导，不是猜测。
  assert.equal(resolveBodyEncoding({ bodyIsJson: true, bodyFields: [] }), "json");
  assert.equal(resolveBodyEncoding({ bodyIsJson: false, bodyFields: [{ name: "a" }] }), "form");
  assert.equal(resolveBodyEncoding({ bodyIsJson: false, bodyFields: [] }), "none");
  assert.equal(resolveBodyEncoding(null), "none");
});

// ---------------------------------------------------------------------------
// B. 生成层：表单体模板 + bodyFormat 落盘
// ---------------------------------------------------------------------------

test("B1 表单体的组生成 bodyTemplate，且带 bodyFormat=form", () => {
  const records = normalizeRecords([raw({
    postData: "product=arms&region=cn-hangzhou&size=10",
    hasPostData: true,
  })], DOMAIN);
  const group = {
    method: "POST", pathTemplate: "/data/api.json", pathParams: [],
    host: DOMAIN, records,
  };
  assert.equal(groupBodyEncoding(group), "form");

  const generated = generateCommands([group], ctx());
  const command = generated.commands[0];
  assert.ok(command, "应生成命令");
  assert.equal(command.request.bodyFormat, "form");
  assert.ok(command.request.bodyTemplate, "表单体必须生成 bodyTemplate");
  assert.deepEqual(Object.keys(command.request.bodyTemplate).sort(), ["product", "region", "size"]);
  for (const value of Object.values(command.request.bodyTemplate)) {
    assert.match(String(value), /^\{\{[a-z0-9_]+\}\}$/, "bodyTemplate 只放占位符，绝不落样本值");
  }
});

test("B2 JSON 体的命令不带 bodyFormat —— 产物形状与修复前完全等价", () => {
  const records = normalizeRecords([raw({ postData: "{\"size\":10}", hasPostData: true })], DOMAIN);
  const group = {
    method: "POST", pathTemplate: "/data/api.json", pathParams: [], host: DOMAIN, records,
  };
  const command = generateCommands([group], ctx()).commands[0];
  assert.equal(command.request.bodyFormat, undefined, "JSON 体不得新增字段");
  assert.ok(command.request.bodyTemplate);
});

test("B3 表单体进 needsReview（字段映射需人工确认）；无法承载的体用既有文案", () => {
  const formRecords = normalizeRecords([raw({
    postData: "product=arms&region=cn-hangzhou", hasPostData: true,
  })], DOMAIN);
  const formCommand = generateCommands([{
    method: "POST", pathTemplate: "/data/api.json", pathParams: [], host: DOMAIN, records: formRecords,
  }], ctx());
  assert.ok(formCommand.needsReview.some((r) => r.reason === FORM_BODY_REVIEW_REASON));
  assert.ok(!formCommand.needsReview.some((r) => r.reason === NON_JSON_BODY_REVIEW_REASON),
    "表单体已被完整承载，不得再报「未生成 bodyTemplate」");

  const opaqueRecords = normalizeRecords([raw({
    postData: "opaque text body", hasPostData: true,
  })], DOMAIN);
  const opaqueCommand = generateCommands([{
    method: "POST", pathTemplate: "/data/api.json", pathParams: [], host: DOMAIN, records: opaqueRecords,
  }], ctx());
  assert.equal(opaqueCommand.commands[0].request.bodyTemplate, null);
  assert.equal(opaqueCommand.commands[0].request.bodyFormat, undefined);
  assert.ok(opaqueCommand.needsReview.some((r) => r.reason === NON_JSON_BODY_REVIEW_REASON),
    "无法承载的请求体必须显式进 needsReview");
});

test("B4 组内 json 与 form 形态不一致 → 判为 other（歧义只记录，不猜）", () => {
  const records = [
    ...normalizeRecords([raw({ postData: "{\"a\":1}", hasPostData: true })], DOMAIN),
    ...normalizeRecords([raw({ requestId: "r2", postData: "a=1", hasPostData: true })], DOMAIN),
  ];
  const group = {
    method: "POST", pathTemplate: "/data/api.json", pathParams: [], host: DOMAIN, records,
  };
  assert.equal(groupBodyEncoding(group), "other");
});

// ---------------------------------------------------------------------------
// C. 渲染层：按 bodyFormat 编码
// ---------------------------------------------------------------------------

const renderable = (overrides = {}) => ({
  commandId: "cmd_0123456789",
  name: "post.api",
  domain: DOMAIN,
  risk: "write",
  confidence: 0.7,
  schemaVersion: 1,
  manuallyEdited: false,
  deprecated: false,
  request: {
    method: "POST",
    urlTemplate: `https://${DOMAIN}/data/api.json`,
    pathTemplate: "/data/api.json",
    bodyTemplate: { product: "{{product}}", region: "{{region}}", size: "{{size}}" },
    queryTemplate: {},
    ...overrides.request,
  },
  params: overrides.params || [
    { name: "product", location: "body", type: "string", required: false },
    { name: "region", location: "body", type: "string", required: false },
    { name: "size", location: "body", type: "number", required: false },
  ],
  responseFields: [],
  responseSchema: { fields: [], depthLimited: false, sampleCount: 0 },
  redactedHeaderNames: [],
  source: { analysisId: "an_form_001", analyzedAt: "2026-01-01T00:00:00.000Z", generatedBy: GENERATED_BY, origin: "capture" },
  health: { hits: 0, misses: 0, consecutiveFailures: 0, disabled: false, totalDurationMs: 0 },
  analyzedAt: "2026-01-01T00:00:00.000Z",
  lastVerifiedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("C1 bodyFormat=form → 表单编码请求体 + 对应 Content-Type", () => {
  const rendered = renderRequest(
    renderable({ request: { bodyFormat: "form" } }),
    { product: "arms", region: "cn-hangzhou", size: 10 },
  );
  assert.equal(rendered.body, "product=arms&region=cn-hangzhou&size=10");
  assert.equal(rendered.headers["Content-Type"], "application/x-www-form-urlencoded");
});

test("C2 表单编码的键与值都做百分号编码，空格编成 +（与 URLSearchParams 一致）", () => {
  const rendered = renderRequest(
    renderable({
      request: { bodyFormat: "form", bodyTemplate: { note: "{{note}}" } },
      params: [{ name: "note", location: "body", type: "string", required: false }],
    }),
    { note: "a b&c=d" },
  );
  assert.equal(rendered.body, "note=a+b%26c%3Dd");
});

test("C3 缺省 bodyFormat → JSON 请求体（与修复前逐字一致）", () => {
  const rendered = renderRequest(
    renderable(),
    { product: "arms", region: "cn-hangzhou", size: 10 },
  );
  assert.equal(rendered.body, "{\"product\":\"arms\",\"region\":\"cn-hangzhou\",\"size\":10}");
  assert.equal(rendered.headers?.["Content-Type"], undefined, "JSON 体沿用扩展侧的默认 content-type");
});

test("C4 命令自带 / 调用方传入的 content-type 优先，不被表单默认值覆盖", () => {
  const withTemplate = renderRequest(
    renderable({ request: { bodyFormat: "form", headers: { "Content-Type": "text/plain" } } }),
    { product: "arms" },
  );
  assert.equal(withTemplate.headers["Content-Type"], "text/plain");

  const withCaller = renderRequest(
    renderable({ bodyFormat: "form" }),
    { product: "arms" },
    { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
  );
  assert.equal(withCaller.headers["content-type"], "application/x-www-form-urlencoded; charset=utf-8");
});

// ---------------------------------------------------------------------------
// D. 缓存层：bodyFormat 白名单重建 + 旧缓存兼容
// ---------------------------------------------------------------------------

const cacheEntry = (overrides = {}) => ({
  commandId: "cmd_0123456789",
  name: "post.api",
  domain: DOMAIN,
  risk: "write",
  confidence: 0.7,
  schemaVersion: 1,
  manuallyEdited: false,
  deprecated: false,
  request: {
    method: "POST",
    urlTemplate: `https://${DOMAIN}/data/api.json`,
    pathTemplate: "/data/api.json",
    bodyTemplate: { product: "{{product}}" },
    queryTemplate: {},
    ...overrides.request,
  },
  params: [{ name: "product", location: "body", type: "string", required: false }],
  responseFields: [],
  responseSchema: { fields: [], depthLimited: false, sampleCount: 0 },
  redactedHeaderNames: [],
  source: { analysisId: "an_form_001", analyzedAt: "2026-01-01T00:00:00.000Z", generatedBy: GENERATED_BY, origin: "capture" },
  health: { hits: 0, misses: 0, consecutiveFailures: 0, disabled: false, totalDurationMs: 0 },
  analyzedAt: "2026-01-01T00:00:00.000Z",
  lastVerifiedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const rebuild = (entry) => {
  const diag = { skippedInvalid: [], errors: [] };
  const command = toCommand(entry, DOMAIN, diag);
  return { command, diag };
};

test("D1 缓存重建保留 bodyFormat=form", () => {
  const { command, diag } = rebuild(cacheEntry({ request: { bodyFormat: "form" } }));
  assert.ok(command, `应重建成功：${JSON.stringify(diag.skippedInvalid)}`);
  assert.equal(command.request.bodyFormat, "form");
});

test("D2 缺省 bodyFormat → 不带该字段（旧缓存无需迁移，行为等同 json）", () => {
  const { command } = rebuild(cacheEntry());
  assert.ok(command);
  assert.equal(command.request.bodyFormat, undefined);
});

test("D3 非法 bodyFormat → 命令被跳过（fail-closed，绝不透传未知值）", () => {
  const { command, diag } = rebuild(cacheEntry({ request: { bodyFormat: "xml" } }));
  assert.equal(command, undefined);
  assert.equal(diag.skippedInvalid.length, 1);
});

test("D4 契约常量：bodyFormat 只允许 json / form；记录级形态含 none / other", () => {
  assert.deepEqual([...BODY_FORMATS], ["json", "form"]);
  assert.deepEqual([...BODY_ENCODINGS], ["none", "json", "form", "other"]);
});

// ---------------------------------------------------------------------------
// E. 端到端：阿里云控制台网关形态（同一 URL + 动作名在 query + 参数在表单体）
// ---------------------------------------------------------------------------

test("E1 网关形态端到端：渲染出的请求体与真实抓包逐字一致", () => {
  const postData = "product=arms&region=cn-hangzhou&size=10";
  const records = normalizeRecords([raw({ postData, hasPostData: true })], DOMAIN);
  const generated = generateCommands([{
    method: "POST", pathTemplate: "/data/api.json", pathParams: [], host: DOMAIN, records,
  }], ctx());
  const command = generated.commands[0];
  assert.equal(command.request.bodyFormat, "form");

  const rendered = renderRequest(command, { product: "arms", region: "cn-hangzhou", size: 10 });
  assert.equal(rendered.body, postData, "渲染出的请求体必须与真实抓包逐字一致");
  assert.equal(rendered.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(rendered.url, `https://${DOMAIN}/data/api.json`);
});
