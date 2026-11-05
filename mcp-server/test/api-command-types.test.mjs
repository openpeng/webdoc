// API 命令集常量契约测试：dist/ 编译产物 与 browser-extension/api-command-helpers.js
// 必须「逐字一致」。helpers.js 是 classic service worker 脚本，顶层 const 是 vm 词法绑定，
// 不会挂到 globalThis，因此用 vm.runInContext(source + hook) 暴露后再逐项比较（AC-20/25）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import * as T from "../dist/api-command-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const HELPERS_PATH = join(here, "..", "..", "browser-extension", "api-command-helpers.js");
const helpersSource = readFileSync(HELPERS_PATH, "utf8");

// 需要从 helpers.js 词法环境暴露出来的标识符（常量 + 纯 helper）。
const EXPOSED = [
  "MSG", "MSG_RESULT", "TAB_SCOPED_API_MESSAGES", "API_ERROR_CODES", "ERROR_SAFE_MESSAGES",
  "COMMAND_ALLOWED_KEYS", "COMMAND_FORBIDDEN_KEYS", "REQUEST_TEMPLATE_ALLOWED_KEYS",
  "API_PARAM_ALLOWED_KEYS", "SCHEMA_FIELD_ALLOWED_KEYS", "RESPONSE_SCHEMA_ALLOWED_KEYS",
  "SOURCE_ALLOWED_KEYS", "HEALTH_ALLOWED_KEYS", "CACHE_FILE_ALLOWED_KEYS", "DOMAIN_BUCKET_ALLOWED_KEYS",
  "START_OPTIONS_ALLOWED_KEYS", "FILTER_ALLOWED_KEYS", "STOP_OPTIONS_ALLOWED_KEYS",
  "EXECUTE_OPTIONS_ALLOWED_KEYS", "EXECUTE_OPTIONS_FORBIDDEN_KEYS",
  "API_COMMAND_ALLOWED_HEADERS", "RESPONSE_SENSITIVE_FIELDS", "PARAM_RESERVED_NAMES",
  "REQUEST_PARAM_NAME_DENYLIST", "STATIC_RESOURCE_TYPES", "STATIC_ASSET_EXTENSIONS",
  "TELEMETRY_PATH_KEYWORDS", "SAMPLE_CANDIDATE_RESOURCE_TYPES", "SAMPLE_MIME_KEYWORDS",
  "GENERIC_PATH_SEGMENTS", "PAGINATION_FIELD_NAMES", "FILTER_PARAM_NAME_HINTS",
  "LOG_STRIP_KEYS", "API_LOG_ALLOWED_KEYS",
  "SCHEMA_VERSION", "SUPPORTED_SCHEMA_VERSION", "CACHE_VERSION", "CACHE_FILE_NAME",
  "GENERATED_BY", "EPOCH_ISO", "REDACTED_VALUE", "API_LOG_PREFIX",
  "MAX_CONSECUTIVE_FAILURES", "MAX_ENDPOINTS_DEFAULT", "MAX_RESPONSE_SAMPLES",
  "MAX_RESPONSE_SAMPLE_BYTES", "MAX_SCHEMA_DEPTH", "MAX_ARRAY_SAMPLES",
  "MAX_BODY_CHARS_DEFAULT", "MAX_BODY_CHARS_MIN", "MAX_BODY_CHARS_MAX", "STALE_AFTER_DAYS",
  "MAX_CONCURRENT_ANALYSES", "API_EXEC_TIMEOUT_MS", "API_EXEC_TIMEOUT_MIN_MS",
  "API_EXEC_TIMEOUT_DEFAULT_MS", "MAX_RESPONSE_FIELDS", "MAX_SCHEMA_FIELDS",
  "MAX_SAFE_LITERAL_LENGTH", "MAX_SAFE_INTEGER_ABS", "MAX_NOTE_LENGTH",
  "MAX_ERROR_MESSAGE_LENGTH", "MAX_PATH_TEMPLATE_LENGTH", "MAX_HEADER_NAME_LENGTH",
  "HTTP_METHODS", "RISKS", "PARAM_LOCATIONS", "PARAM_TYPES", "ANALYSIS_MODES",
  "COMMAND_NAME_PATTERN", "PARAM_NAME_PATTERN", "PARAM_PLACEHOLDER_RE", "PLACEHOLDER_ONLY_RE",
  "COMMAND_ID_PATTERN", "HOSTNAME_PATTERN", "RESPONSE_FIELD_PATTERN", "PATH_TEMPLATE_PATTERN",
  "SAFE_LITERAL_STRING_RE", "UUID_PATTERN", "NUMERIC_SEGMENT_RE", "HEX_ID_RE",
  "HIGH_ENTROPY_SEGMENT_RE", "JWT_RE", "EMAIL_RE", "PHONE_RE", "VERSION_PATH_SEGMENT_RE",
  "API_SENSITIVE_HEADER_RE",
  "POST_LIST_QUERY_REVIEW_REASON", "NAME_CONFLICT_REVIEW_REASON", "MISSING_SAMPLE_REVIEW_REASON",
  "LOW_CONFIDENCE_REVIEW_REASON", "ANALYZE_CURRENT_REVIEW_REASON", "NON_JSON_BODY_REVIEW_REASON",
  "UNSAFE_CONSTANT_REVIEW_REASON", "STALE_MANUAL_WARNING", "NO_CACHE_LIST_WARNING",
  "NEEDS_REVIEW_DESCRIPTION_PREFIX",
  "formatApiError", "assertApiTargetUrl", "rebuildStartOptions", "rebuildStopOptions",
  "rebuildExecuteOptions", "isSampleCandidate", "decodeCdpResponseBody",
  "safeLogForApiExecute", "apiRedactHeaderNames", "apiPickWhitelist", "apiClampInt",
  "apiNormalizeHostname",
];

function loadHelpers() {
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, atob, btoa,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const hook = `;globalThis.__helpers = { ${EXPOSED.join(", ")} };`;
  vm.runInContext(helpersSource + hook, sandbox, { filename: "api-command-helpers.js" });
  return sandbox.__helpers;
}
const H = loadHelpers();

// vm realm 的对象/数组与 Node realm 原型不同，deepStrictEqual 会因原型不同而误判：
// 统一 JSON 往返成 Node realm 纯值；正则只比较 source + flags 字符串。
function plain(value) {
  if (value && typeof value === "object"
      && typeof value.source === "string" && typeof value.flags === "string") {
    return { source: value.source, flags: value.flags };
  }
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}
const same = (a, b) => assert.deepEqual(plain(a), plain(b));

test("API_ERROR_CODES 恰好 27 项、无重复、均为大写下划线枚举", () => {
  assert.equal(T.API_ERROR_CODES.length, 27);
  assert.equal(new Set(T.API_ERROR_CODES).size, 27);
  for (const code of T.API_ERROR_CODES) assert.match(code, /^[A-Z][A-Z0-9_]*$/);
  assert.ok(T.API_ERROR_CODES.includes("READ_ONLY_BLOCKED"));
  assert.ok(T.API_ERROR_CODES.includes("REDIRECT_BLOCKED"));
  assert.ok(T.API_ERROR_CODES.includes("AUTH_REQUIRED"));
  assert.ok(T.API_ERROR_CODES.includes("WRITE_FAILED"));
});

test("ERROR_SAFE_MESSAGES 与 27 个错误码一一对应，文案非空且无占位/样本值", () => {
  assert.deepEqual(Object.keys(T.ERROR_SAFE_MESSAGES).sort(), [...T.API_ERROR_CODES].sort());
  for (const code of T.API_ERROR_CODES) {
    const message = T.ERROR_SAFE_MESSAGES[code];
    assert.equal(typeof message, "string", `${code} 缺少安全文案`);
    assert.ok(message.trim().length > 0, `${code} 文案为空`);
    assert.ok(!message.includes("undefined") && !message.includes("NaN"), `${code} 文案含占位符`);
  }
  // 拒发类文案必须明确表达「未发送任何请求」，防止回归成含糊文案
  for (const code of ["MISSING_PARAMS", "INVALID_PARAMS", "UNSAFE_PATH_PARAM",
                      "HOST_MISMATCH_AFTER_RENDER", "CONFIRMATION_REQUIRED"]) {
    assert.match(T.ERROR_SAFE_MESSAGES[code], /未发送任何请求/);
  }
});

test("MSG / MSG_RESULT 与 helpers.js 源码逐字一致", () => {
  same(H.MSG, T.MSG);
  same(H.MSG_RESULT, T.MSG_RESULT);
  // 源码层面的逐字校验：每个值都以字面量形式出现在 helpers.js
  for (const value of [...Object.values(T.MSG), ...Object.values(T.MSG_RESULT)]) {
    assert.ok(helpersSource.includes(`'${value}'`), `helpers.js 缺少字面量 ${value}`);
  }
  assert.equal(T.MSG.COMMAND_EXECUTE, "apiCommandExecute");
  assert.equal(T.MSG_RESULT.COMMAND_EXECUTE, "apiCommandExecuteResult");
});

test("helpers.js 的 27 项错误码与安全文案与 dist 逐字一致", () => {
  same(H.API_ERROR_CODES, T.API_ERROR_CODES);
  same(H.ERROR_SAFE_MESSAGES, T.ERROR_SAFE_MESSAGES);
  // 错误码前缀解析依赖顺序与取值完全一致，不能只比较集合
  same(H.API_ERROR_CODES, T.API_ERROR_CODES);
  assert.equal(H.API_ERROR_CODES.length, 27);
});

test("TAB_SCOPED_API_MESSAGES 含三个 tab 作用域消息，execute 不在其中（免开网页前提）", () => {
  same(H.TAB_SCOPED_API_MESSAGES, T.TAB_SCOPED_API_MESSAGES);
  assert.deepEqual([...T.TAB_SCOPED_API_MESSAGES].sort(),
    [T.MSG.ANALYSIS_START, T.MSG.ANALYSIS_STOP, T.MSG.BUNDLE_COLLECT].sort());
  assert.ok(!T.TAB_SCOPED_API_MESSAGES.includes(T.MSG.COMMAND_EXECUTE));
});

test("阈值常量与超时边界契约（Q8 / Q5 / selector-cache 对齐）", () => {
  const expected = {
    SCHEMA_VERSION: 1, SUPPORTED_SCHEMA_VERSION: 1, CACHE_VERSION: 1,
    CACHE_FILE_NAME: "api-commands.json", GENERATED_BY: "1.1.1",
    EPOCH_ISO: "1970-01-01T00:00:00.000Z", REDACTED_VALUE: "[REDACTED]",
    API_LOG_PREFIX: "[api-command]",
    MAX_CONSECUTIVE_FAILURES: 4, MAX_ENDPOINTS_DEFAULT: 20,
    MAX_RESPONSE_SAMPLES: 20, MAX_RESPONSE_SAMPLE_BYTES: 64 * 1024,
    MAX_SCHEMA_DEPTH: 6, MAX_ARRAY_SAMPLES: 5,
    MAX_BODY_CHARS_DEFAULT: 50000, MAX_BODY_CHARS_MIN: 1000, MAX_BODY_CHARS_MAX: 500000,
    STALE_AFTER_DAYS: 30, MAX_CONCURRENT_ANALYSES: 3,
    API_EXEC_TIMEOUT_MS: 25000, API_EXEC_TIMEOUT_MIN_MS: 100,
    API_EXEC_TIMEOUT_DEFAULT_MS: 10000, MAX_RESPONSE_FIELDS: 60, MAX_SCHEMA_FIELDS: 200,
    MAX_SAFE_LITERAL_LENGTH: 32, MAX_SAFE_INTEGER_ABS: 100000,
    MAX_NOTE_LENGTH: 512, MAX_ERROR_MESSAGE_LENGTH: 200,
    MAX_PATH_TEMPLATE_LENGTH: 512, MAX_HEADER_NAME_LENGTH: 128,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(T[key], value, `dist 常量 ${key}`);
    assert.equal(plain(H[key]), value, `helpers.js 常量 ${key}`);
  }
  // 执行超时必须小于 bridge.ts 的 30s 通用超时，否则会被先掐断
  assert.ok(T.API_EXEC_TIMEOUT_MS < 30000);
  assert.ok(T.API_EXEC_TIMEOUT_MIN_MS < T.API_EXEC_TIMEOUT_DEFAULT_MS);
  assert.ok(T.API_EXEC_TIMEOUT_DEFAULT_MS <= T.API_EXEC_TIMEOUT_MS);
  assert.ok(T.MAX_BODY_CHARS_MIN < T.MAX_BODY_CHARS_DEFAULT);
  assert.ok(T.MAX_BODY_CHARS_DEFAULT < T.MAX_BODY_CHARS_MAX);
});

test("正则契约：命名 / 参数 / commandId / hostname / 路径 / 占位符", () => {
  assert.equal(T.COMMAND_NAME_PATTERN.test("list.users"), true);
  assert.equal(T.COMMAND_NAME_PATTERN.test("get.users-by_id"), true);
  assert.equal(T.COMMAND_NAME_PATTERN.test("List.Users"), false);
  assert.equal(T.COMMAND_NAME_PATTERN.test("get.https://evil.com"), false);
  assert.equal(T.COMMAND_NAME_PATTERN.test("a".repeat(65)), false);
  assert.equal(T.PARAM_NAME_PATTERN.test("page_size"), true);
  assert.equal(T.PARAM_NAME_PATTERN.test("Page"), false);
  assert.equal(T.PARAM_NAME_PATTERN.test("a".repeat(65)), false);
  assert.equal(T.COMMAND_ID_PATTERN.test("cmd_8f3a1c2d90"), true);
  assert.equal(T.COMMAND_ID_PATTERN.test("cmd_8F3A1C2D90"), false);
  assert.equal(T.HOSTNAME_PATTERN.test("api.example.com"), true);
  assert.equal(T.HOSTNAME_PATTERN.test("*.example.com"), false);
  assert.equal(T.HOSTNAME_PATTERN.test("https://api.example.com"), false);
  assert.equal(T.RESPONSE_FIELD_PATTERN.test("data.items[].id"), true);
  assert.equal(T.RESPONSE_FIELD_PATTERN.test("data..id"), false);
  assert.equal(T.PATH_TEMPLATE_PATTERN.test("/api/users/{id}"), true);
  assert.equal(T.PATH_TEMPLATE_PATTERN.test("/api/users?token=1"), false);
  assert.equal(T.PLACEHOLDER_ONLY_RE.test("{{page}}"), true);
  assert.equal(T.PLACEHOLDER_ONLY_RE.test("{{page:number}}"), false);
  assert.equal(T.SAFE_LITERAL_STRING_RE.test("json"), true);
  assert.equal(T.SAFE_LITERAL_STRING_RE.test("Bearer.abc"), false);
  // 所有正则两侧逐字同步
  for (const name of ["COMMAND_NAME_PATTERN", "PARAM_NAME_PATTERN", "PARAM_PLACEHOLDER_RE",
                      "PLACEHOLDER_ONLY_RE", "COMMAND_ID_PATTERN", "HOSTNAME_PATTERN",
                      "RESPONSE_FIELD_PATTERN", "PATH_TEMPLATE_PATTERN", "SAFE_LITERAL_STRING_RE",
                      "UUID_PATTERN", "NUMERIC_SEGMENT_RE", "HEX_ID_RE",
                      "HIGH_ENTROPY_SEGMENT_RE", "JWT_RE", "EMAIL_RE", "PHONE_RE",
                      "VERSION_PATH_SEGMENT_RE", "API_SENSITIVE_HEADER_RE"]) {
    same(H[name], T[name]);
  }
});

test("缓存白名单与禁止字段清单两侧 parity（AC-17）", () => {
  for (const name of ["COMMAND_ALLOWED_KEYS", "COMMAND_FORBIDDEN_KEYS",
                      "REQUEST_TEMPLATE_ALLOWED_KEYS", "API_PARAM_ALLOWED_KEYS",
                      "SCHEMA_FIELD_ALLOWED_KEYS", "RESPONSE_SCHEMA_ALLOWED_KEYS",
                      "SOURCE_ALLOWED_KEYS", "HEALTH_ALLOWED_KEYS",
                      "CACHE_FILE_ALLOWED_KEYS", "DOMAIN_BUCKET_ALLOWED_KEYS"]) {
    same(H[name], T[name]);
  }
  // 可执行/凭据类字段必须三者齐备，且不与允许键相交
  for (const bad of ["computed", "script", "headers", "cookie", "token",
                     "constructor", "__proto__", "prototype"]) {
    assert.ok(T.COMMAND_FORBIDDEN_KEYS.includes(bad), `禁止清单缺 ${bad}`);
    assert.ok(!T.COMMAND_ALLOWED_KEYS.includes(bad));
  }
  // 顶层允许键里绝不能出现可执行/凭据类字段（allowedValues 只属参数级允许键）
  assert.ok(!T.COMMAND_ALLOWED_KEYS.includes("allowedValues"));
});

test("EXECUTE_OPTIONS_FORBIDDEN_KEYS / LOG_STRIP_KEYS / 日志与 header 白名单两侧 parity（AC-22/20）", () => {
  for (const name of ["START_OPTIONS_ALLOWED_KEYS", "FILTER_ALLOWED_KEYS",
                      "STOP_OPTIONS_ALLOWED_KEYS", "EXECUTE_OPTIONS_ALLOWED_KEYS",
                      "EXECUTE_OPTIONS_FORBIDDEN_KEYS", "API_COMMAND_ALLOWED_HEADERS",
                      "RESPONSE_SENSITIVE_FIELDS", "PARAM_RESERVED_NAMES",
                      "REQUEST_PARAM_NAME_DENYLIST", "LOG_STRIP_KEYS", "API_LOG_ALLOWED_KEYS"]) {
    same(H[name], T[name]);
  }
  assert.deepEqual([...T.EXECUTE_OPTIONS_FORBIDDEN_KEYS],
    ["headers", "confirm", "overrides", "tabId"]);
  assert.deepEqual([...T.API_COMMAND_ALLOWED_HEADERS], ["accept", "content-type"]);
  // 禁用键绝不能出现在允许键里；日志剥离键必须覆盖新增消息的敏感载荷
  for (const forbidden of T.EXECUTE_OPTIONS_FORBIDDEN_KEYS) {
    assert.ok(!T.EXECUTE_OPTIONS_ALLOWED_KEYS.includes(forbidden));
  }
  for (const key of ["body", "params", "headers", "samples", "records", "postData",
                     "queryParams", "text", "script"]) {
    assert.ok(T.LOG_STRIP_KEYS.includes(key), `LOG_STRIP_KEYS 缺 ${key}`);
  }
  for (const key of ["action", "commandId", "method", "hostname", "risk",
                     "status", "durationMs", "success"]) {
    assert.ok(T.API_LOG_ALLOWED_KEYS.includes(key));
  }
  assert.ok(!T.API_LOG_ALLOWED_KEYS.includes("url"));
  assert.ok(!T.API_LOG_ALLOWED_KEYS.includes("body"));
});

test("过滤/采样/命名清单与固定文案两侧逐字一致", () => {
  for (const name of ["STATIC_RESOURCE_TYPES", "STATIC_ASSET_EXTENSIONS",
                      "TELEMETRY_PATH_KEYWORDS", "SAMPLE_CANDIDATE_RESOURCE_TYPES",
                      "SAMPLE_MIME_KEYWORDS", "GENERIC_PATH_SEGMENTS",
                      "PAGINATION_FIELD_NAMES", "FILTER_PARAM_NAME_HINTS",
                      "HTTP_METHODS", "RISKS", "PARAM_LOCATIONS", "PARAM_TYPES", "ANALYSIS_MODES"]) {
    same(H[name], T[name]);
  }
  for (const name of ["POST_LIST_QUERY_REVIEW_REASON", "NAME_CONFLICT_REVIEW_REASON",
                      "MISSING_SAMPLE_REVIEW_REASON", "LOW_CONFIDENCE_REVIEW_REASON",
                      "ANALYZE_CURRENT_REVIEW_REASON", "NON_JSON_BODY_REVIEW_REASON",
                      "UNSAFE_CONSTANT_REVIEW_REASON", "STALE_MANUAL_WARNING",
                      "NO_CACHE_LIST_WARNING", "NEEDS_REVIEW_DESCRIPTION_PREFIX"]) {
    assert.equal(plain(H[name]), T[name], `固定文案 ${name} 两侧不一致`);
    assert.ok(!T[name].includes("undefined"), `${name} 含占位符`);
  }
  // needsReview 文案不得拼接任何样本值/URL/header 值
  assert.ok(!/https?:\/\//.test(T.POST_LIST_QUERY_REVIEW_REASON));
  assert.ok(!/Bearer|cookie:/i.test(T.MISSING_SAMPLE_REVIEW_REASON));
});

test("helpers 纯 helper 的常量级行为：错误码前缀、日志脱敏、header 字段名", () => {
  const err = H.formatApiError("READ_ONLY_BLOCKED");
  assert.equal(err, `READ_ONLY_BLOCKED|${T.ERROR_SAFE_MESSAGES.READ_ONLY_BLOCKED}`);
  assert.ok(err.startsWith("READ_ONLY_BLOCKED|"));
  assert.equal(err.includes("SECRET"), false);

  const log = plain(H.safeLogForApiExecute({
    action: "apiCommandExecute", method: "GET", hostname: "api.example.com",
    status: 200, success: true, durationMs: 12,
    body: "SECRET_BODY_VALUE", params: "SECRET_PARAMS_VALUE",
    headers: "SECRET_HEADERS_VALUE", samples: "SECRET_SAMPLES_VALUE",
    url: "https://api.example.com/secret?token=SECRET_URL_VALUE",
  }));
  assert.deepEqual(Object.keys(log).sort(),
    ["action", "method", "hostname", "status", "success", "durationMs"].sort());
  for (const secret of ["SECRET_BODY_VALUE", "SECRET_PARAMS_VALUE", "SECRET_HEADERS_VALUE",
                        "SECRET_SAMPLES_VALUE", "SECRET_URL_VALUE"]) {
    assert.ok(!JSON.stringify(log).includes(secret), `日志泄漏 ${secret}`);
  }

  const names = plain(H.apiRedactHeaderNames([
    "Authorization", "Cookie", "X-CSRF-Token", "x-api-key", "Accept", "Content-Type",
  ]));
  assert.deepEqual(names, ["authorization", "cookie", "x-api-key", "x-csrf-token"]);
  assert.ok(!names.includes("accept") && !names.includes("content-type"));
  assert.equal(H.apiNormalizeHostname("HTTPS://u:p@WWW.Example.COM:8443/path?x=1"), "www.example.com");
  assert.equal(H.apiClampInt(999999, 1000, 500000, 50000), 500000);
  assert.deepEqual(plain(H.apiPickWhitelist({ a: 1, b: 2, __proto__: {} }, ["a"])), { a: 1 });
});
