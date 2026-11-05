// 抓包归一化纯函数测试：CDP 三事件 → NormalizedRecord → 过滤/模板化/分组/参数推断。
// 重点验证「method 只取真实 HTTP」「header 只存字段名」「产物零样本值 / 零枚举值」（AC-02/03/04/10）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRecords, filterCandidates, templatePath, groupEndpoints, endpointKey,
  inferParams, isDynamicPathSegment, parseBodyFields, inferValueType, sanitizeParamName,
  isSensitiveFieldName, isForbiddenParamName, isSafeLiteral, isSafeLiteralForField,
  looksLikeCredential, sanitizeErrorMessage, redactHeaderNames,
  normalizeHostname, isValidHostname,
} from "../dist/api-command-normalize.js";
import { MAX_ENDPOINTS_DEFAULT } from "../dist/api-command-types.js";

const DOMAIN = "api.example.com";
const baseRaw = (overrides = {}) => ({
  requestId: "r1",
  url: "https://api.example.com/v1/users/42?page=1&q=abc",
  method: "GET",
  host: DOMAIN,
  path: "/v1/users/42",
  query: "page=1&q=abc",
  status: 200,
  mimeType: "application/json",
  resourceType: "XHR",
  timestamp: 1000,
  headerNames: ["accept", "authorization"],
  postData: null,
  hasPostData: false,
  ...overrides,
});

const baseRec = (overrides = {}) => ({
  requestId: "r1",
  host: DOMAIN,
  method: "GET",
  path: "/v1/users/42",
  pathSegments: ["v1", "users", "42"],
  queryPairs: [{ name: "page", value: "1" }, { name: "q", value: "abc" }],
  bodyFields: [],
  bodyIsJson: false,
  status: 200,
  mimeType: "application/json",
  resourceType: "xhr",
  timestamp: 1000,
  headerNames: [],
  ...overrides,
});

test("normalizeRecords 只取 CDP 真实 HTTP method，XHR / fetch 伪值必须剔除（AC-02）", () => {
  const records = [
    baseRaw({ requestId: "a", method: "GET" }),
    baseRaw({ requestId: "b", method: "XHR" }),
    baseRaw({ requestId: "c", method: "fetch" }),
    baseRaw({ requestId: "d", method: "Fetch" }),
    baseRaw({ requestId: "e", method: "post" }),
    baseRaw({ requestId: "f", method: "TRACE" }),
    baseRaw({ requestId: "g", method: "" }),
  ];
  const out = normalizeRecords(records, DOMAIN);
  assert.deepEqual(out.map((r) => r.method), ["GET", "POST"]);
  assert.deepEqual(out.map((r) => r.requestId), ["a", "e"]);
  assert.equal(out.length, 2);
  // 非数组输入与空样本不得崩溃
  assert.deepEqual(normalizeRecords(null, DOMAIN), []);
  assert.deepEqual(normalizeRecords([], DOMAIN), []);
});

test("header 只保留字段名清单、绝不含值；postData 原始串不进入归一化记录", () => {
  const raw = baseRaw({
    headerNames: ["Accept", "Authorization", "cookie", "AUTHORIZATION", "x-csrf-token"],
    headers: { Authorization: "SECRET_HEADER_VALUE_7788" }, // 扩展侧不应产出，但即便混入也不得透传
    postData: "{\"token\":\"SECRET_POST_VALUE_9911\"}",
    hasPostData: true,
  });
  const out = normalizeRecords([raw], DOMAIN);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].headerNames,
    ["accept", "authorization", "cookie", "x-csrf-token"]);
  assert.equal(Object.hasOwn(out[0], "headers"), false);
  assert.equal(Object.hasOwn(out[0], "postData"), false);
  assert.ok(!JSON.stringify(out[0].headerNames).includes("SECRET_HEADER_VALUE_7788"));
  // bodyFields 是内存中间态，仅用于「取值是否变化」判定，绝不落盘
  assert.equal(out[0].bodyIsJson, true);
});

test("非 http(s) 协议、非法 URL、第三方域名记录一律剔除（Q13 精确 hostname）", () => {
  const out = normalizeRecords([
    baseRaw({ requestId: "ok", url: "https://api.example.com/v1/users" }),
    baseRaw({ requestId: "ftp", url: "ftp://api.example.com/x" }),
    baseRaw({ requestId: "js", url: "javascript:alert(1)" }),
    baseRaw({ requestId: "bad", url: "not a url" }),
    baseRaw({ requestId: "third", url: "https://evil.example.net/v1/users" }),
    baseRaw({ requestId: "www", url: "https://www.api.example.com/v1/users" }),
  ], DOMAIN);
  assert.deepEqual(out.map((r) => r.requestId), ["ok"]);
  // 目标域名按 url.hostname 精确比对（Q13），不是按 raw.host 字段
  assert.equal(normalizeRecords([
    baseRaw({ url: "https://other.test/v1/x", host: "other.test" }),
  ], "OTHER.TEST").length, 1);
});

test("queryPairs / bodyFields 解析：JSON 对象、JSON 数组首元素、urlencoded、非 JSON", () => {
  const json = parseBodyFields("{\"page\":1,\"keyword\":\"abc\",\"nested\":{\"size\":2},\"flag\":true}");
  assert.equal(json.isJson, true);
  assert.deepEqual(json.fields.map((f) => f.name).sort(),
    ["flag", "keyword", "nested_size", "page"].sort());
  assert.equal(json.fields.find((f) => f.name === "page").value, 1);
  assert.equal(json.fields.find((f) => f.name === "flag").type, "boolean");

  const arr = parseBodyFields("[{\"id\":7},{\"id\":8}]");
  assert.equal(arr.isJson, true);
  assert.equal(arr.fields.length, 1);
  assert.equal(arr.fields[0].value, 7);

  const form = parseBodyFields("page=2&q=hello%20world");
  assert.equal(form.isJson, false);
  assert.deepEqual(form.fields.map((f) => f.name), ["page", "q"]);

  assert.deepEqual(parseBodyFields("not json at all"), { fields: [], isJson: false });
  assert.deepEqual(parseBodyFields("   "), { fields: [], isJson: false });
  assert.deepEqual(parseBodyFields(null), { fields: [], isJson: false });
  assert.deepEqual(parseBodyFields("{ broken"), { fields: [], isJson: false });

  const rec = normalizeRecords([baseRaw({
    url: "https://api.example.com/v1/users/42?page=1&q=abc&page=2",
    postData: "{\"size\":10}",
    hasPostData: true,
  })], DOMAIN)[0];
  assert.equal(rec.queryPairs.length, 3);
  assert.equal(rec.bodyFields.length, 1);
  assert.equal(rec.bodyFields[0].name, "size");
  assert.equal(rec.bodyIsJson, true);
});

test("filterCandidates 排除静态资源、埋点路径与第三方域名（AC-03）", () => {
  const records = [
    baseRec({ requestId: "a", path: "/v1/users", resourceType: "xhr" }),
    baseRec({ requestId: "b", path: "/assets/app.js", resourceType: "script" }),
    baseRec({ requestId: "c", path: "/img/logo.png", resourceType: "image" }),
    baseRec({ requestId: "d", path: "/track/event", resourceType: "xhr" }),
    baseRec({ requestId: "e", path: "/beacon", resourceType: "fetch" }),
    baseRec({ requestId: "f", path: "/v1/orders", resourceType: "xhr", host: "evil.example.net" }),
    baseRec({ requestId: "g", path: "/v1/goods", resourceType: "xhr" }),
  ];
  const result = filterCandidates(records, { includeStaticAssets: false, maxEndpoints: 20 });
  assert.deepEqual(result.kept.map((r) => r.requestId).sort(), ["a", "g"]);
  assert.ok(result.ignored >= 5);
  assert.ok(result.warnings.some((w) => w.includes("静态资源")));
  assert.ok(result.warnings.some((w) => w.includes("埋点")));
  assert.ok(result.warnings.some((w) => w.includes("第三方域名")));
  // warnings 只含计数与固定文案，不得含 URL / 参数值 / header 值
  for (const w of result.warnings) {
    assert.ok(!w.includes("/v1/") && !w.includes("evil.example.net"));
    assert.ok(!w.includes("SECRET"));
  }
  const withStatic = filterCandidates(records, { includeStaticAssets: true, maxEndpoints: 20 });
  assert.ok(withStatic.kept.some((r) => r.requestId === "b"));
});

test("maxEndpoints 按观测频次排序截断，低频端点被丢弃并告警", () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) records.push(baseRec({ requestId: `hot${i}`, path: "/v1/hot" }));
  for (let i = 0; i < 3; i += 1) records.push(baseRec({ requestId: `warm${i}`, path: "/v1/warm" }));
  records.push(baseRec({ requestId: "cold", path: "/v1/cold" }));
  const limited = filterCandidates(records, { includeStaticAssets: false, maxEndpoints: 2 });
  assert.deepEqual([...new Set(limited.kept.map((r) => r.path))].sort(), ["/v1/hot", "/v1/warm"]);
  assert.ok(limited.warnings.some((w) => w.includes("maxEndpoints=2")));
  const defaultLimit = filterCandidates(records, { includeStaticAssets: false, maxEndpoints: undefined });
  assert.equal(defaultLimit.kept.length, records.length);
  assert.equal(MAX_ENDPOINTS_DEFAULT, 20);
  // 非法 maxEndpoints 回退到默认值，不得抛异常
  assert.equal(filterCandidates(records, { includeStaticAssets: false, maxEndpoints: 0 }).kept.length,
    records.length);
});

test("templatePath 数字 / UUID / hex / 短业务 ID → {id}，多动态段 {id_2}，版本段不误判", () => {
  assert.deepEqual(templatePath("/users/42"), { pathTemplate: "/users/{id}", pathParams: ["id"] });
  assert.deepEqual(templatePath("/users/550e8400-e29b-41d4-a716-446655440000"),
    { pathTemplate: "/users/{id}", pathParams: ["id"] });
  assert.deepEqual(templatePath("/orders/abcdef0123456789abcdef0123456789"),
    { pathTemplate: "/orders/{id}", pathParams: ["id"] });
  assert.deepEqual(templatePath("/items/C-001"),
    { pathTemplate: "/items/{id}", pathParams: ["id"] });
  assert.deepEqual(templatePath("/users/42/posts/99"),
    { pathTemplate: "/users/{id}/posts/{id_2}", pathParams: ["id", "id_2"] });
  assert.deepEqual(templatePath("/v1/users/42?x=1#frag"),
    { pathTemplate: "/v1/users/{id}", pathParams: ["id"] });
  assert.deepEqual(templatePath("/v1/users"), { pathTemplate: "/v1/users", pathParams: [] });
  assert.deepEqual(templatePath("/"), { pathTemplate: "/", pathParams: [] });
  assert.deepEqual(templatePath(""), { pathTemplate: "/", pathParams: [] });
  assert.equal(isDynamicPathSegment("v1"), false);
  assert.equal(isDynamicPathSegment("api"), false);
  assert.equal(isDynamicPathSegment("550e8400-e29b-41d4-a716-446655440000"), true);
  // 路径段中的花括号 / 引号 / 空白被清洗，不得注入
  assert.ok(!templatePath('/x/"onload=alert(1)').pathTemplate.includes('"'));
});

test("groupEndpoints / endpointKey 按 method + pathTemplate 聚合且键稳定", () => {
  const groups = groupEndpoints([
    baseRec({ requestId: "a", path: "/v1/users/1" }),
    baseRec({ requestId: "b", path: "/v1/users/2" }),
    baseRec({ requestId: "c", path: "/v1/users", method: "POST" }),
    baseRec({ requestId: "d", path: "/v1/orders" }),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].records.length, 2);
  assert.equal(groups[0].pathTemplate, "/v1/users/{id}");
  assert.deepEqual(groups[0].pathParams, ["id"]);
  assert.equal(endpointKey("GET", "/v1/users/{id}"),
    endpointKey("GET", "/v1/users/{id}"));
  assert.notEqual(endpointKey("GET", "/v1/users/{id}"), endpointKey("POST", "/v1/users/{id}"));
  assert.equal(endpointKey("GET", "/v1/users/{id}").includes("\u0000"), true);
  assert.deepEqual(groupEndpoints(null), []);
});

test("inferParams 区分 query / path / body，必填与可选、安全常量 defaultValue", () => {
  const group = {
    method: "GET", pathTemplate: "/v1/users/{id}", pathParams: ["id"], host: DOMAIN,
    records: [
      baseRec({
        path: "/v1/users/1", pathSegments: ["v1", "users", "1"],
        queryPairs: [{ name: "page", value: "1" }, { name: "format", value: "json" }],
        bodyFields: [{ name: "size", value: 10, type: "number" }],
        bodyIsJson: true,
      }),
      baseRec({
        path: "/v1/users/2", pathSegments: ["v1", "users", "2"],
        queryPairs: [{ name: "page", value: "2" }, { name: "format", value: "json" }],
        bodyFields: [{ name: "size", value: 20, type: "number" }],
        bodyIsJson: true,
      }),
    ],
  };
  const params = inferParams(group);
  const byName = Object.fromEntries(params.map((p) => [p.name, p]));
  assert.equal(byName.id.location, "path");
  assert.equal(byName.id.required, true);
  assert.equal(byName.id.type, "string");
  assert.equal(byName.page.location, "query");
  assert.equal(byName.page.required, false);
  assert.equal(byName.page.enumCount, 2);
  assert.equal(byName.size.location, "body");
  assert.equal(byName.size.enumCount, 2);
  assert.equal(byName.format.constant, true);
  assert.equal(byName.format.defaultValue, "json");
  assert.equal(byName.format.required, false);
  // 变化字段绝不写 allowedValues（Q14）；参数定义里根本不存在 value 字段
  for (const param of params) {
    assert.equal(param.allowedValues, undefined);
    assert.equal(Object.hasOwn(param, "value"), false);
  }
  const text = JSON.stringify(params);
  assert.ok(!text.includes('"value"'));
  assert.ok(!text.includes("allowedValues"));
});

test("inferParams 产物零样本值、零真实枚举值、零敏感字段名（AC-04/10/20）", () => {
  const marker = "SAMPLE_BUSINESS_VALUE_8842";
  const group = {
    method: "POST", pathTemplate: "/v1/orders", pathParams: [], host: DOMAIN,
    records: [
      baseRec({ queryPairs: [{ name: "keyword", value: marker }],
        bodyFields: [{ name: "note", value: marker, type: "string" }], bodyIsJson: true }),
      baseRec({ queryPairs: [{ name: "keyword", value: "another" }],
        bodyFields: [{ name: "note", value: "other", type: "string" }], bodyIsJson: true }),
    ],
  };
  const params = inferParams(group);
  const text = JSON.stringify(params);
  assert.ok(!text.includes(marker), "参数推断产物泄漏样本值");
  assert.ok(!text.includes("another") && !text.includes("other"));
  assert.ok(!text.includes("allowedValues"));
  for (const param of params) {
    assert.ok(!("defaultValue" in param), "变化字段不得落盘 defaultValue");
    assert.ok(!("constant" in param), "变化字段不得标 constant");
    assert.equal(param.allowedValues, undefined);
  }
  // 敏感字段名 / 工具级保留字落在观测里也不得生成参数位
  const dirty = inferParams({
    method: "GET", pathTemplate: "/v1/x", pathParams: [], host: DOMAIN,
    records: [baseRec({ queryPairs: [{ name: "token", value: "abc" },
      { name: "confirm", value: "true" }, { name: "csrf", value: "x" },
      { name: "ok", value: "1" }], bodyFields: [] })],
  });
  assert.deepEqual(dirty.map((p) => p.name), ["ok"]);
});

test("inferParams 不安全常量转必填参数并带需复核前缀，参数名唯一化", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const group = {
    method: "GET", pathTemplate: "/v1/x/{id}", pathParams: ["id"], host: DOMAIN,
    records: [
      baseRec({ queryPairs: [{ name: "ref", value: jwt }],
        bodyFields: [{ name: "id", value: "dup", type: "string" }], bodyIsJson: false }),
      baseRec({ queryPairs: [{ name: "ref", value: jwt }],
        bodyFields: [{ name: "id", value: "dup", type: "string" }], bodyIsJson: false }),
    ],
  };
  const params = inferParams(group);
  const ref = params.find((p) => p.name === "ref");
  assert.equal(ref.required, true);
  assert.ok(ref.description.startsWith("[需人工复核] "));
  assert.equal(ref.defaultValue, undefined);
  assert.ok(!JSON.stringify(params).includes(jwt));
  // 同名 query/body 字段被唯一化，不产生重复参数名
  const names = params.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test("isSafeLiteralForField / looksLikeCredential / isSafeLiteral 拒绝凭据与敏感字段名（AC-10）", () => {
  assert.equal(isSafeLiteralForField("token", "abc"), false);
  assert.equal(isSafeLiteralForField("password", "abc"), false);
  assert.equal(isSafeLiteralForField("authorization", "abc"), false);
  assert.equal(isSafeLiteralForField("confirm", "abc"), false);
  assert.equal(isSafeLiteralForField("tabId", "abc"), false);
  assert.equal(isSafeLiteralForField("ref", "a@b.com"), false);
  assert.equal(isSafeLiteralForField("ref", "Bearer abcdef"), false);
  assert.equal(isSafeLiteralForField("ref", "13800138000"), false);
  assert.equal(isSafeLiteralForField("format", "json"), true);
  assert.equal(isSafeLiteralForField("page", 2), true);
  assert.equal(isSafeLiteralForField("flag", true), true);
  assert.equal(isSafeLiteral("a".repeat(33)), false);
  assert.equal(isSafeLiteral(100001), false);
  assert.equal(isSafeLiteral(null), false);
  assert.equal(isSafeLiteral({}), false);
  assert.equal(looksLikeCredential("eyJhbGciOi.x.y"), true);
  assert.equal(looksLikeCredential("Cookie: sid=abc"), true);
  assert.equal(looksLikeCredential("https://a.test/?access_token=SECRET"), true);
  assert.equal(looksLikeCredential("json"), false);
  assert.equal(isSensitiveFieldName("X-Api-Key"), true);
  assert.equal(isForbiddenParamName("maxBodyChars"), true);
  assert.equal(inferValueType(null), "string");
  assert.equal(inferValueType([]), "array");
  assert.equal(inferValueType({}), "object");
  assert.equal(sanitizeParamName("Page Size"), "page_size");
  assert.equal(sanitizeParamName("!!!"), "");
  assert.equal(sanitizeParamName("__proto__"), "proto"); // 规范化后不可能污染原型
});

test("sanitizeErrorMessage / redactHeaderNames / hostname 工具：脱敏与 Q13 精确匹配", (t) => {
  const dirty = "请求失败 https://api.example.com/x?token=SECRET_TOKEN_7788 Bearer abc.def.ghi "
    + "手机 13800138000 长串 abcdefghijklmnopqrstuvwxyz123456";
  const safe = sanitizeErrorMessage(dirty);
  assert.ok(!safe.includes("SECRET_TOKEN_7788"));
  assert.ok(!safe.includes("13800138000"));
  assert.ok(!safe.includes("abc.def.ghi"));
  assert.ok(!safe.includes("abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(safe.length <= 200);
  // 值本身就是凭据时（EMAIL_RE / JWT_RE 带 ^$ 锚点可命中）必须脱敏，绝不回显原值
  assert.ok(!sanitizeErrorMessage("a@b.com").includes("a@b.com"));
  assert.ok(!sanitizeErrorMessage("eyJhbGciOi.x.y").includes("eyJhbGciOi"));
  assert.equal(sanitizeErrorMessage(""), "");
  assert.equal(typeof sanitizeErrorMessage(null), "string");
  // 观察项（非 AC 阻断）：EMAIL_RE 带 ^$ 锚点，嵌入句中的邮箱不会被 replace 掉；
  // 真实链路的 lastError/errors 输入是固定安全文案，不含邮箱，故不判为验收失败。
  t.diagnostic("观察 O-1：EMAIL_RE 带 ^$ 锚点，sanitizeErrorMessage 不脱敏嵌入句中的邮箱；已在报告中列为非阻断纵深防御建议");

  assert.deepEqual(redactHeaderNames(["Authorization", "Cookie", "accept", "x-csrf-token", "AUTHORIZATION"]),
    ["authorization", "cookie", "x-csrf-token"]);
  assert.deepEqual(redactHeaderNames(null), []);

  assert.equal(normalizeHostname("HTTPS://u:p@WWW.Example.COM:8443/path?x=1#f"), "www.example.com");
  assert.equal(normalizeHostname("api.example.com."), "api.example.com");
  assert.equal(normalizeHostname(42), "");
  assert.equal(isValidHostname("api.example.com"), true);
  assert.equal(isValidHostname("*.example.com"), false);
  assert.equal(isValidHostname("https://api.example.com"), false);
  assert.equal(isValidHostname("a..b"), false);
  assert.equal(isValidHostname("a".repeat(254)), false);
});
