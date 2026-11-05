// 参数校验与 {{param}} 渲染测试：错误路径一律 RenderError(code) 且绝不发请求，
// path 注入防护、渲染后 host 复核、query 编码 / body 保类型（AC-08/21）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateParams, renderRequest, previewFor, RenderError,
} from "../dist/api-command-render.js";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";
import { generateCommands } from "../dist/api-command-generator.js";
import { ERROR_SAFE_MESSAGES, EPOCH_ISO } from "../dist/api-command-types.js";

const DOMAIN = "api.example.com";
const NOW = "2026-01-01T00:00:00.000Z";

const command = (overrides = {}) => ({
  commandId: "cmd_8f3a1c2d90",
  name: "get.users",
  domain: DOMAIN,
  risk: "read",
  confidence: 0.8,
  schemaVersion: 1,
  manuallyEdited: false,
  deprecated: false,
  request: {
    method: "GET",
    urlTemplate: `https://${DOMAIN}/v1/users/{{id}}?page={{page}}&q={{q}}`,
    pathTemplate: "/v1/users/{id}",
    bodyTemplate: null,
    queryTemplate: { page: "{{page}}", q: "{{q}}" },
  },
  params: [
    { name: "id", location: "path", type: "string", required: true },
    { name: "page", location: "query", type: "number", required: false },
    { name: "q", location: "query", type: "string", required: false },
  ],
  responseFields: [],
  responseSchema: { fields: [], depthLimited: false, sampleCount: 0 },
  redactedHeaderNames: [],
  source: { analysisId: "an_test", analyzedAt: NOW, generatedBy: "1.1.1" },
  health: { hits: 0, misses: 0, consecutiveFailures: 0, disabled: false, totalDurationMs: 0 },
  analyzedAt: NOW, lastVerifiedAt: NOW, createdAt: NOW, updatedAt: NOW,
  ...overrides,
});

const expectRenderError = (fn, code) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof RenderError, `应抛 RenderError，实际 ${err?.constructor?.name}`);
    assert.equal(err.code, code);
    assert.ok(typeof err.message === "string" && err.message.length > 0);
    assert.ok(!err.message.includes("SECRET") && !err.message.includes("42"),
      "错误消息必须是固定安全文案，不得含参数值");
    return true;
  });
};

test("validateParams：缺必填 → missingParams[]；可选参数缺失不报错", () => {
  assert.deepEqual(validateParams(command(), {}), {
    missingParams: ["id"], invalidParams: [],
  });
  assert.deepEqual(validateParams(command(), { id: "42" }), {
    missingParams: [], invalidParams: [],
  });
  assert.deepEqual(validateParams(command(), { id: "42", page: 2, q: "abc" }), {
    missingParams: [], invalidParams: [],
  });
  // 显式 undefined / null 等同缺失
  assert.deepEqual(validateParams(command(), { id: undefined }).missingParams, ["id"]);
  assert.deepEqual(validateParams(command(), { id: null }).missingParams, ["id"]);
});

test("validateParams：类型错误 / 未知参数 → invalidParams[]", () => {
  const wrongType = validateParams(command(), { id: "42", page: "not-a-number" });
  assert.deepEqual(wrongType.invalidParams, ["page"]);
  assert.deepEqual(wrongType.missingParams, []);
  const unknown = validateParams(command(), { id: "42", bogus: "x", headers: {} });
  assert.ok(unknown.invalidParams.includes("bogus"));
  assert.ok(unknown.invalidParams.includes("headers"));
  const wrongPath = validateParams(command(), { id: 123 });
  assert.ok(wrongPath.invalidParams.includes("id"));
  const nan = validateParams(command(), { id: "42", page: NaN });
  assert.ok(nan.invalidParams.includes("page"));
  // boolean / object / array 类型逐一校验
  const typed = command({
    request: { ...command().request, urlTemplate: `https://${DOMAIN}/v1/x`, bodyTemplate: {} },
    params: [
      { name: "flag", location: "body", type: "boolean", required: true },
      { name: "obj", location: "body", type: "object", required: true },
      { name: "arr", location: "body", type: "array", required: true },
    ],
  });
  assert.deepEqual(validateParams(typed, { flag: true, obj: {}, arr: [] }).invalidParams, []);
  assert.deepEqual(validateParams(typed, { flag: "true", obj: [], arr: {} }).invalidParams.sort(),
    ["arr", "flag", "obj"]);
});

test("allowedValues 值级校验：仅人工显式写入时生效（自动分析产物无该字段）", () => {
  const manual = command({
    request: { ...command().request, urlTemplate: `https://${DOMAIN}/v1/users/{{id}}` },
    params: [
      { name: "id", location: "path", type: "string", required: true },
      { name: "mode", location: "query", type: "string", required: false, allowedValues: ["a", "b"] },
    ],
  });
  assert.deepEqual(validateParams(manual, { id: "42", mode: "a" }).invalidParams, []);
  assert.deepEqual(validateParams(manual, { id: "42", mode: "c" }).invalidParams, ["mode"]);
  assert.deepEqual(validateParams(manual, { id: "42" }).missingParams, []);
  // 数字 / 布尔型 allowedValues 同样按严格相等校验
  const numeric = command({
    params: [{ name: "size", location: "query", type: "number", required: false, allowedValues: [10, 20] }],
    request: { ...command().request, urlTemplate: `https://${DOMAIN}/v1/x` },
  });
  assert.deepEqual(validateParams(numeric, { size: 10 }).invalidParams, []);
  assert.deepEqual(validateParams(numeric, { size: 11 }).invalidParams, ["size"]);
});

test("renderRequest 缺必填 path 参数 → MISSING_PARAMS，不产生任何最终 URL", () => {
  expectRenderError(() => renderRequest(command(), {}), "MISSING_PARAMS");
  expectRenderError(() => renderRequest(command(), { page: 2 }), "MISSING_PARAMS");
  // 只要有必填 path 参数即可正常渲染，可选 query 参数整段删除
  const ok = renderRequest(command(), { id: "42" });
  assert.equal(ok.url, `https://${DOMAIN}/v1/users/42`);
  assert.equal(ok.body, undefined);
});

test("path 参数含 / ? #（含 URL 编码绕过）→ UNSAFE_PATH_PARAM（AC-08）", () => {
  for (const bad of ["a/b", "a?b", "a#b", "a%2Fb", "a%3Fb", "a%23b", "../evil"]) {
    expectRenderError(() => renderRequest(command(), { id: bad }), "UNSAFE_PATH_PARAM");
  }
  assert.equal(renderRequest(command(), { id: "abc-123_X" }).url,
    `https://${DOMAIN}/v1/users/abc-123_X`);
  assert.equal(renderRequest(command(), { id: "42", page: 2 }).url,
    `https://${DOMAIN}/v1/users/42?page=2`);
});

test("渲染后 hostname / 协议二次复核 → HOST_MISMATCH_AFTER_RENDER / INVALID_URL（Q13）", () => {
  const crossHost = command({
    request: { ...command().request, urlTemplate: "https://evil.example.net/v1/users/{{id}}" },
  });
  expectRenderError(() => renderRequest(crossHost, { id: "42" }), "HOST_MISMATCH_AFTER_RENDER");
  const badProtocol = command({
    request: { ...command().request, urlTemplate: "ftp://api.example.com/v1/users/{{id}}" },
  });
  expectRenderError(() => renderRequest(badProtocol, { id: "42" }), "INVALID_URL");
  const malformed = command({
    request: { ...command().request, urlTemplate: "not-a-url/{{id}}" },
  });
  expectRenderError(() => renderRequest(malformed, { id: "42" }), "INVALID_URL");
  const invalidMethod = command({
    request: { ...command().request, method: "TRACE" },
  });
  expectRenderError(() => renderRequest(invalidMethod, { id: "42" }), "INVALID_PARAMS");
});

test("{{name}} 替换到 path / query / body：query 编码、body 保 number/boolean 类型", () => {
  const cmd = command({
    request: {
      method: "POST",
      urlTemplate: `https://${DOMAIN}/v1/users/{{id}}?page={{page}}&q={{q}}`,
      pathTemplate: "/v1/users/{id}",
      bodyTemplate: { size: "{{size}}", flag: "{{flag}}", name: "{{name}}", fixed: "json", limit: 5 },
      queryTemplate: { page: "{{page}}", q: "{{q}}" },
    },
    params: [
      { name: "id", location: "path", type: "string", required: true },
      { name: "page", location: "query", type: "number", required: true },
      { name: "q", location: "query", type: "string", required: true },
      { name: "size", location: "body", type: "number", required: true },
      { name: "flag", location: "body", type: "boolean", required: true },
      { name: "name", location: "body", type: "string", required: true },
    ],
  });
  const rendered = renderRequest(cmd, {
    id: "a b", page: 2, q: "x&y", size: 10, flag: false, name: "张三",
  });
  assert.equal(rendered.url, `https://${DOMAIN}/v1/users/a%20b?page=2&q=x%26y`);
  assert.equal(rendered.method, "POST");
  const body = JSON.parse(rendered.body);
  assert.deepEqual(body, { size: 10, flag: false, name: "张三", fixed: "json", limit: 5 });
  assert.equal(typeof body.size, "number");
  assert.equal(typeof body.flag, "boolean");
  assert.equal(typeof body.limit, "number");
});

test("可选参数未提供 → 整段 query 删除，不残留 {{param}}；默认值兜底", () => {
  const onlyId = renderRequest(command(), { id: "42" });
  assert.equal(onlyId.url.includes("{{"), false);
  assert.equal(onlyId.url.includes("?"), false);
  const withPage = renderRequest(command(), { id: "42", page: 7 });
  assert.equal(withPage.url, `https://${DOMAIN}/v1/users/42?page=7`);
  assert.equal(withPage.url.includes("{{"), false);

  const withDefault = command({
    request: { ...command().request, urlTemplate: `https://${DOMAIN}/v1/users/{{id}}?format={{format}}` },
    params: [
      { name: "id", location: "path", type: "string", required: true },
      { name: "format", location: "query", type: "string", required: true,
        constant: true, defaultValue: "json" },
    ],
  });
  assert.deepEqual(validateParams(withDefault, { id: "42" }).missingParams, []);
  assert.equal(renderRequest(withDefault, { id: "42" }).url,
    `https://${DOMAIN}/v1/users/42?format=json`);
  // 显式提供值优先于 defaultValue
  assert.equal(renderRequest(withDefault, { id: "9", format: "xml" }).url,
    `https://${DOMAIN}/v1/users/9?format=xml`);
  // RenderError 未传自定义消息时必须回落到固定安全文案
  assert.equal(new RenderError("MISSING_PARAMS").message, ERROR_SAFE_MESSAGES.MISSING_PARAMS);
});

test("previewFor 只含模板与参数名，绝不含任何参数值", () => {
  const preview = previewFor(command({ risk: "write" }));
  assert.deepEqual(preview, {
    method: "GET",
    urlTemplate: `https://${DOMAIN}/v1/users/{{id}}?page={{page}}&q={{q}}`,
    paramNames: ["id", "page", "q"],
    risk: "write",
  });
  assert.ok(!JSON.stringify(preview).includes("42"));
  assert.ok(!JSON.stringify(preview).includes("SECRET"));
});

test("集成：缺必填 / 类型错误 / 写命令未确认，ApiCommandService.sendFn 调用次数均为 0（AC-08/21）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-render-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = new ApiCommandCache(join(dir, "api-commands.json"));
  const writeCmd = command({
    commandId: "cmd_1122334455", name: "create.users", risk: "write",
    request: {
      method: "POST", urlTemplate: `https://${DOMAIN}/v1/users`,
      pathTemplate: "/v1/users", bodyTemplate: { name: "{{name}}" }, queryTemplate: {},
    },
    params: [{ name: "name", location: "body", type: "string", required: true }],
  });
  await cache.merge(DOMAIN, [command(), writeCmd], { mode: "full", overwriteManual: false });

  let calls = 0;
  const send = async () => { calls += 1; throw new Error("不应发送任何扩展消息"); };
  const service = new ApiCommandService(cache, send);

  const missing = await service.call({ domain: DOMAIN, commandId: "cmd_8f3a1c2d90", params: {} });
  assert.equal(missing.error.code, "MISSING_PARAMS");
  assert.equal(missing.warnings.some((w) => w.includes("未发送任何请求")), true);

  const invalid = await service.call({
    domain: DOMAIN, commandId: "cmd_8f3a1c2d90", params: { id: "42", page: "bad" },
  });
  assert.equal(invalid.error.code, "INVALID_PARAMS");

  const unconfirmed = await service.call({
    domain: DOMAIN, commandId: "cmd_1122334455", params: { name: "x" },
  });
  assert.equal(unconfirmed.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(unconfirmed.confirmationRequired, true);
  assert.ok(unconfirmed.preview);
  assert.equal(calls, 0, "三类闸门都不得触发扩展请求（零网络请求）");

  // 确认后且参数合法才真正下发，且只含渲染结果、不含原始 params / headers / confirm
  let sentParams = null;
  const service2 = new ApiCommandService(cache, async (_type, params) => {
    sentParams = params;
    return { success: true, status: 200, body: { ok: true }, durationMs: 5 };
  });
  const ok = await service2.call({
    domain: DOMAIN, commandId: "cmd_1122334455", params: { name: "x" }, confirm: true,
  });
  assert.equal(ok.error, undefined);
  assert.ok(sentParams);
  assert.equal(sentParams.options.method, "POST");
  assert.equal(sentParams.options.url, `https://${DOMAIN}/v1/users`);
  assert.equal(sentParams.options.body, JSON.stringify({ name: "x" }));
  assert.equal(Object.hasOwn(sentParams.options, "params"), false);
  assert.equal(Object.hasOwn(sentParams.options, "headers"), false);
  assert.equal(Object.hasOwn(sentParams.options, "confirm"), false);
});

// ---------------------------------------------------------------------------
// T4 值落盘放开 + 常量参数可被调用方覆盖（AC-5）
// ---------------------------------------------------------------------------

const CONST_REC = (overrides = {}) => ({
  requestId: "r1", host: DOMAIN, method: "POST", path: "/v1/order/submit",
  pathSegments: ["v1", "order", "submit"], queryPairs: [], bodyFields: [],
  bodyIsJson: false, status: 200, mimeType: "application/json",
  resourceType: "xhr", timestamp: 1, headerNames: [],
  ...overrides,
});

/** 生成一条「恒定 body 字段 + 可变 query 字段」的命令。 */
function constantCommand() {
  const generated = generateCommands([{
    method: "POST", pathTemplate: "/v1/order/submit", pathParams: [], host: DOMAIN,
    records: [CONST_REC({
      bodyFields: [
        { name: "nickname", value: "zhangsan", type: "string" },
        { name: "order_no", value: "ord20240001", type: "string" },
        { name: "otp", value: "123456", type: "string" },
      ],
      bodyIsJson: true,
    })],
  }], { domain: DOMAIN, analysisId: "an_t4", generatedBy: "1.1.1", schema: new Map(), now: NOW });
  return generated.commands[0];
}

test("T4：恒定参数写成 {{name}} 占位符，真实值只落在 defaultValue", () => {
  const cmd = constantCommand();
  const body = cmd.request.bodyTemplate;
  assert.ok(body, "应生成 bodyTemplate");
  assert.equal(body.nickname, "{{nickname}}", "恒定参数必须是占位符，不能是字面量");
  assert.equal(body.order_no, "{{order_no}}");
  const nickname = cmd.params.find((p) => p.name === "nickname");
  assert.equal(nickname.constant, true);
  assert.equal(nickname.defaultValue, "zhangsan", "真实值落在 defaultValue");
  assert.equal(nickname.required, false);
  assert.ok(!JSON.stringify(cmd.request).includes("zhangsan"), "请求模板里不得残留样本值");
});

test("T4：调用方传值必须真实生效（覆盖 defaultValue），不传才回落默认值", () => {
  const cmd = constantCommand();
  const overridden = renderRequest(cmd, { nickname: "lisi" });
  const body = JSON.parse(overridden.body);
  assert.equal(body.nickname, "lisi", "调用方传值必须覆盖 defaultValue");
  assert.equal(body.order_no, "ord20240001", "未传的恒定参数回落 defaultValue");

  const fallback = renderRequest(cmd, {});
  assert.equal(JSON.parse(fallback.body).nickname, "zhangsan");
});

test("T4：端到端 —— 恒定参数经 call_api_command 传值后下发给扩展的是调用方的值", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-t4-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = new ApiCommandCache(join(dir, "api-commands.json"));
  const cmd = constantCommand();
  await cache.merge(DOMAIN, [cmd], { mode: "full", overwriteManual: false });

  let sentParams = null;
  const service = new ApiCommandService(cache, async (_type, params) => {
    sentParams = params;
    return { success: true, status: 200, body: { ok: true }, durationMs: 5 };
  });
  const result = await service.call({
    domain: DOMAIN, commandId: cmd.commandId, name: cmd.name,
    params: { nickname: "lisi" }, confirm: true,
  });
  assert.equal(result.error, undefined);
  assert.ok(sentParams);
  assert.equal(sentParams.options.body, JSON.stringify({
    nickname: "lisi", order_no: "ord20240001", otp: "123456",
  }), "下发的 body 必须是调用方的值，不是分析时的旧值");
});
