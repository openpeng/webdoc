// 命令生成纯函数测试：稳定 ID、risk、命名消歧、{id} 与 {{name}} 分离、
// 零敏感值、analyze_current 兼容入口、产物可通过缓存白名单重建（AC-01/05/10/12/17）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stableCommandId, classifyRisk, looksLikePostListQuery, generateCommands,
  computeConfidence, toRenderPath, deriveResource, sanitizeCommandName,
  findQualifier, nameConflictSuffix,
} from "../dist/api-command-generator.js";
import { endpointKey, redactHeaderNames } from "../dist/api-command-normalize.js";
import { toCommand } from "../dist/api-command-cache.js";
import {
  COMMAND_NAME_PATTERN, COMMAND_ID_PATTERN, EPOCH_ISO,
  POST_LIST_QUERY_REVIEW_REASON, NAME_CONFLICT_REVIEW_REASON,
  MISSING_SAMPLE_REVIEW_REASON, ANALYZE_CURRENT_REVIEW_REASON,
  UNSAFE_CONSTANT_REVIEW_REASON, GENERATED_BY,
} from "../dist/api-command-types.js";

const DOMAIN = "api.example.com";

const rec = (overrides = {}) => ({
  requestId: "r1", host: DOMAIN, method: "GET", path: "/v1/users/1",
  pathSegments: ["v1", "users", "1"], queryPairs: [], bodyFields: [],
  bodyIsJson: false, status: 200, mimeType: "application/json",
  resourceType: "xhr", timestamp: 1, headerNames: [],
  ...overrides,
});
const group = (overrides = {}) => ({
  method: "GET", pathTemplate: "/v1/users/{id}", pathParams: ["id"],
  host: DOMAIN, records: [rec()],
  ...overrides,
});
const ctx = (overrides = {}) => ({
  domain: DOMAIN, analysisId: "an_test_001", generatedBy: GENERATED_BY,
  schema: new Map(), ...overrides,
});

test("stableCommandId 稳定、符合正则、改名不变，仅由 domain/method/pathTemplate 决定（AC-05）", () => {
  const id = stableCommandId(DOMAIN, "GET", "/v1/users/{id}");
  assert.match(id, COMMAND_ID_PATTERN);
  assert.equal(id, stableCommandId(DOMAIN, "GET", "/v1/users/{id}"));
  assert.equal(id, stableCommandId("HTTPS://API.EXAMPLE.COM:443/x", "GET", "/v1/users/{id}"));
  assert.notEqual(id, stableCommandId(DOMAIN, "POST", "/v1/users/{id}"));
  assert.notEqual(id, stableCommandId(DOMAIN, "GET", "/v1/orders/{id}"));
  assert.notEqual(id, stableCommandId("other.example.com", "GET", "/v1/users/{id}"));
  // 人工改名绝不参与哈希：改名后的 id 与原 id 一致
  const generated = generateCommands([group()], ctx()).commands[0];
  assert.ok(generated);
  assert.equal(stableCommandId(DOMAIN, generated.request.method, generated.request.pathTemplate),
    generated.commandId);
});

test("classifyRisk：GET/HEAD/OPTIONS=read，其余一律 write；POST 列表查询不可放宽（Q3）", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(classifyRisk(method, group()), "read");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(classifyRisk(method, group()), "write");

  const postList = group({
    method: "POST", pathTemplate: "/v1/orders/search", pathParams: [],
    records: [rec({ method: "POST", bodyIsJson: true, bodyFields: [
      { name: "page", value: 1, type: "number" },
      { name: "keyword", value: "abc", type: "string" },
      { name: "size", value: 20, type: "number" },
    ] })],
  });
  assert.equal(looksLikePostListQuery(postList), true);
  assert.equal(classifyRisk("POST", postList), "write", "POST 列表查询人工确认前一律 write");
  const generated = generateCommands([postList], ctx());
  assert.equal(generated.commands[0].risk, "write");
  assert.ok(generated.needsReview.some((r) => r.reason === POST_LIST_QUERY_REVIEW_REASON));
  // 只按字段名判定，绝不读取字段值；状态变更动词路径不判为列表查询
  assert.equal(looksLikePostListQuery(group({
    method: "POST", pathTemplate: "/v1/orders/create", pathParams: [],
    records: [rec({ method: "POST", bodyFields: [{ name: "page", value: 1, type: "number" }] })],
  })), false);
  assert.equal(looksLikePostListQuery(group({ method: "GET" })), false);
  assert.equal(looksLikePostListQuery(group({
    method: "POST", pathTemplate: "/v1/orders/search", pathParams: [],
    records: [rec({ method: "POST", bodyFields: [], queryPairs: [] })],
  })), false);
});

test("命令名符合 <verb>.<resource> 正则、不含动态值 / 协议 / 端口 / query 原文", () => {
  const generated = generateCommands([
    group(),
    group({ method: "POST", pathTemplate: "/v1/users", pathParams: [], records: [rec({ method: "POST" })] }),
    group({ method: "GET", pathTemplate: "/v1/orders/search", pathParams: [], records: [rec()] }),
  ], ctx());
  for (const command of generated.commands) {
    assert.match(command.name, COMMAND_NAME_PATTERN, `命名非法: ${command.name}`);
    assert.equal(command.name.includes("{"), false);
    assert.equal(command.name.includes("/"), false);
    assert.equal(command.name.includes("?"), false);
    assert.equal(command.name.includes(":"), false);
  }
  assert.equal(generated.commands[0].name, "get.users");
  assert.equal(generated.commands[2].name, "search.orders");
  assert.equal(deriveResource("/api/v1/users/{id}/search", "search"), "users");
  assert.equal(deriveResource("/v1", "get"), "root");
  assert.equal(sanitizeCommandName("Get.Users?x=1"), "get.users_x_1");
  assert.equal(sanitizeCommandName("!!!"), "cmd.root");
});

test("命令名冲突逐级消歧并把 NAME_CONFLICT_REVIEW_REASON 写入 needsReview[]（AC-05）", () => {
  const groups = [
    group({ pathTemplate: "/v1/users", pathParams: [], records: [rec({ path: "/v1/users" })] }),
    group({ pathTemplate: "/v2/users", pathParams: [], records: [rec({ path: "/v2/users" })] }),
    group({ pathTemplate: "/v3/users", pathParams: [], records: [rec({ path: "/v3/users" })] }),
  ];
  const generated = generateCommands(groups, ctx());
  assert.equal(generated.commands.length, 3);
  const names = generated.commands.map((c) => c.name);
  assert.equal(new Set(names).size, 3, "冲突命令名必须唯一");
  for (const name of names) assert.match(name, COMMAND_NAME_PATTERN);
  assert.ok(generated.needsReview.some((r) => r.reason === NAME_CONFLICT_REVIEW_REASON));
  // 限定词消歧：第二条带合法 query 字段名时可生成 by_xxx 名称
  const withQualifier = generateCommands([
    group({ pathTemplate: "/v1/users", pathParams: [] }),
    group({ pathTemplate: "/v2/users", pathParams: [], records: [rec({
      queryPairs: [{ name: "keyword", value: "x" }],
    })] }),
  ], ctx());
  assert.ok(withQualifier.commands[1].name.includes("by_keyword"));
  assert.equal(findQualifier(group({ records: [rec({ queryPairs: [{ name: "sort", value: "x" }] })] })), "sort");
  assert.equal(findQualifier(group()), "");
  assert.match(nameConflictSuffix("GET", "/v1/users"), /^[0-9a-f]{6}$/);
  assert.equal(nameConflictSuffix("GET", "/v1/users"), nameConflictSuffix("GET", "/v1/users"));
});

test("{id}（结构）与 {{name}}（渲染）严格分离，绝不混用（Q12）", () => {
  assert.equal(toRenderPath("/v1/users/{id}"), "/v1/users/{{id}}");
  assert.equal(toRenderPath("/a/{id}/b/{id_2}"), "/a/{{id}}/b/{{id_2}}");
  assert.equal(toRenderPath("/v1/users"), "/v1/users");

  const g = group({
    records: [rec({ queryPairs: [{ name: "page", value: "1" }, { name: "page", value: "2" }] })],
  });
  const command = generateCommands([g], ctx()).commands[0];
  assert.ok(command.request.pathTemplate.includes("{id}"));
  assert.ok(!command.request.pathTemplate.includes("{{"), "pathTemplate 不得含渲染占位符");
  assert.ok(!/\{\{[a-z0-9_]+\}\}/.test(command.request.pathTemplate));
  assert.ok(command.request.urlTemplate.includes("{{id}}"));
  assert.ok(command.request.urlTemplate.includes("{{page}}"));
  const strippedUrl = command.request.urlTemplate.replace(/\{\{[a-z0-9_]+\}\}/g, "");
  assert.ok(!/[{}]/.test(strippedUrl), "urlTemplate 不得残留单花括号结构占位符");
  assert.deepEqual(command.request.queryTemplate, { page: "{{page}}" });
  assert.ok(command.request.urlTemplate.startsWith(`https://${DOMAIN}/`));
});

test("analyze_current 兼容入口：强制 needsReview + 空 responseSchema（即使 schema Map 有内容）", () => {
  const g = group();
  const key = endpointKey(g.method, g.pathTemplate);
  const nonEmpty = {
    fields: [{ path: "code", type: "number", array: false, redacted: false }],
    depthLimited: false, sampleCount: 2,
  };
  const schema = new Map([[key, nonEmpty]]);
  const normal = generateCommands([g], ctx({ schema }));
  assert.equal(normal.commands[0].responseSchema.sampleCount, 2);
  assert.ok(normal.commands[0].responseFields.includes("code"));

  const forced = generateCommands([g], ctx({
    schema, forceNeedsReview: true, emptyResponseSchema: true,
  }));
  assert.equal(forced.commands.length, 1);
  const command = forced.commands[0];
  assert.equal(command.responseSchema.sampleCount, 0);
  assert.deepEqual(command.responseSchema.fields, []);
  assert.deepEqual(command.responseFields, []);
  assert.ok(forced.needsReview.some((r) => r.reason === ANALYZE_CURRENT_REVIEW_REASON));
  assert.ok(forced.needsReview.some((r) => r.reason === MISSING_SAMPLE_REVIEW_REASON));
  assert.ok(forced.needsReview.every((r) => r.commandId === command.commandId));
  // 只传设计契约的 4 个字段也合法，且时间由调用方注入（缺省 EPOCH_ISO，不读墙钟）
  const minimal = generateCommands([g], {
    domain: DOMAIN, analysisId: "an_min", generatedBy: GENERATED_BY, schema: new Map(),
  });
  assert.equal(minimal.commands[0].createdAt, EPOCH_ISO);
  assert.equal(minimal.commands[0].updatedAt, EPOCH_ISO);
  assert.equal(minimal.commands[0].source.generatedBy, GENERATED_BY);
  const injected = generateCommands([g], ctx({ now: "2026-01-01T00:00:00.000Z", scheme: "http" }));
  assert.equal(injected.commands[0].createdAt, "2026-01-01T00:00:00.000Z");
  assert.ok(injected.commands[0].request.urlTemplate.startsWith(`http://${DOMAIN}/`));
});

test("generateCommands 产物可通过 cache.toCommand() 白名单重建（AC-17 写入侧）", () => {
  const g = group({
    records: [
      rec({ queryPairs: [{ name: "page", value: "1" }], headerNames: ["accept", "authorization"] }),
      rec({ queryPairs: [{ name: "page", value: "2" }], headerNames: ["accept", "cookie"] }),
    ],
  });
  const generated = generateCommands([g], ctx({ now: "2026-02-02T00:00:00.000Z" }));
  const diag = { skippedInvalid: [], errors: [] };
  for (const command of generated.commands) {
    const rebuilt = toCommand(command, DOMAIN, diag);
    assert.ok(rebuilt, `toCommand 拒绝了自己生成的命令: ${JSON.stringify(diag)}`);
    assert.equal(rebuilt.commandId, command.commandId);
    assert.equal(rebuilt.name, command.name);
    assert.equal(rebuilt.domain, DOMAIN);
    assert.equal(new URL(rebuilt.request.urlTemplate).hostname, DOMAIN);
    assert.deepEqual(diag.skippedInvalid, []);
    assert.deepEqual(diag.errors, []);
  }
});

test("生成物零 header 值与零凭据；业务样本值只落在 param.defaultValue（放开后的新契约）", () => {
  const secret = "SECRET_SAMPLE_VALUE_8842";
  const headerValue = "AUTH_HEADER_VALUE_7788";
  const g = group({
    records: [rec({
      queryPairs: [{ name: "keyword", value: secret }],
      bodyFields: [{ name: "note", value: secret, type: "string" }],
      bodyIsJson: true,
      headerNames: ["Authorization", "Cookie", "x-csrf-token", "accept"],
      headers: { Authorization: headerValue }, // 混入原值也绝不能被读取
    })],
  });
  const generated = generateCommands([g], ctx());
  const command = generated.commands[0];
  const templateText = JSON.stringify({
    request: command.request,
    needsReview: generated.needsReview,
    redactedHeaders: generated.redactedHeaders,
    note: command.note,
  });
  assert.ok(!templateText.includes(secret), "请求模板 / needsReview / redactedHeaders 不得含业务样本值");
  assert.ok(!templateText.includes(headerValue), "命令定义泄漏 header 值");
  assert.ok(!templateText.includes("Bearer") && !templateText.includes("cookie:"));
  assert.deepEqual(generated.redactedHeaders, ["authorization", "cookie", "x-csrf-token"]);
  assert.deepEqual(command.redactedHeaderNames, redactHeaderNames([
    "Authorization", "Cookie", "x-csrf-token", "accept",
  ]));
  // 【放开·绿区】恒定标量值可落盘，且**只**落在 param.defaultValue；
  // 请求模板里必须是 {{name}} 占位符 —— 否则调用方传值会被静默忽略。
  const defaults = command.params.filter((p) => p.defaultValue !== undefined);
  assert.ok(defaults.length > 0, "恒定字段的值应落到 defaultValue");
  for (const param of defaults) {
    assert.equal(param.constant, true);
    assert.equal(param.required, false);
  }
  const template = JSON.stringify(command.request);
  assert.ok(template.includes("{{keyword}}"), "query 恒定参数必须是占位符");
  assert.ok(template.includes("{{note}}"), "body 恒定参数必须是占位符");
  assert.ok(!template.includes(secret), "请求模板里不得残留样本值字面量");
  for (const item of generated.needsReview) {
    assert.ok(!item.reason.includes(secret), "needsReview 理由不得拼接样本值");
    assert.equal(item.reason.includes("http"), false);
  }
  for (const cmd of generated.commands) {
    assert.ok(!JSON.stringify(cmd.params).includes("allowedValues"));
    for (const param of cmd.params) assert.equal(param.allowedValues, undefined);
  }
});

test("真凭据形态（JWT / Bearer / token 类 query）仍然拒绝落盘，转为必填参数", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const g = group({
    records: [rec({
      queryPairs: [{ name: "ref", value: jwt }],
      bodyFields: [],
      bodyIsJson: false,
      headerNames: [],
    })],
  });
  const generated = generateCommands([g], ctx());
  const params = generated.commands[0].params;
  const ref = params.find((p) => p.name === "ref");
  assert.ok(ref, "应保留该参数位");
  assert.equal(ref.constant, undefined);
  assert.equal(ref.defaultValue, undefined, "JWT 绝不落盘");
  assert.equal(ref.required, true, "真凭据字段必须转为必填参数");
  assert.ok(!JSON.stringify(generated.commands).includes(jwt));
});

test("computeConfidence 落在 0..1，样本数与 schema 提升置信度，低置信度进 needsReview", () => {
  const g1 = group();
  const params = [{ name: "id", location: "path", type: "string", required: true }];
  const empty = { fields: [], depthLimited: false, sampleCount: 0 };
  const withSchema = {
    fields: [{ path: "code", type: "number", array: false, redacted: false }],
    depthLimited: false, sampleCount: 2,
  };
  const c1 = computeConfidence(g1, params, empty);
  const c2 = computeConfidence(group({ records: [rec(), rec(), rec()] }), params, withSchema);
  assert.ok(c1 >= 0 && c1 <= 1);
  assert.ok(c2 >= 0 && c2 <= 1);
  assert.ok(c2 > c1, "样本数 + schema 应提高置信度");
  assert.equal(computeConfidence(g1, params, empty), c1, "纯函数必须对相同输入返回相同结果");

  // 构造低置信度：非 JSON body + 需复核参数 + path 动态段
  const lowGroup = group({
    pathParams: ["id"],
    records: [rec({ bodyFields: [{ name: "note", value: "x", type: "string" }], bodyIsJson: false })],
  });
  const lowParams = [{ name: "id", location: "path", type: "string", required: true,
    description: "[需人工复核] 请人工提供" }];
  const low = computeConfidence(lowGroup, lowParams, empty);
  assert.ok(low < 0.6, `期望低置信度，实际 ${low}`);
  const generated = generateCommands([lowGroup], ctx());
  assert.ok(generated.commands[0].confidence < 0.6);
});

test("空输入 / 空记录组不产生命令；报告字段齐全且 reasons 不重复", () => {
  assert.deepEqual(generateCommands([], ctx()), { commands: [], needsReview: [], redactedHeaders: [] });
  assert.deepEqual(generateCommands(null, ctx()).commands, []);
  assert.equal(generateCommands([group({ records: [] })], ctx()).commands.length, 0);
  const generated = generateCommands([group()], ctx());
  assert.equal(generated.commands.length, 1);
  const command = generated.commands[0];
  for (const key of ["commandId", "name", "domain", "risk", "confidence", "schemaVersion",
                     "manuallyEdited", "deprecated", "request", "params", "responseFields",
                     "responseSchema", "redactedHeaderNames", "source", "health",
                     "analyzedAt", "lastVerifiedAt", "createdAt", "updatedAt"]) {
    assert.ok(Object.hasOwn(command, key), `命令缺少字段 ${key}`);
  }
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.manuallyEdited, false);
  assert.equal(command.health.hits, 0);
  const keys = generated.needsReview.map((r) => `${r.commandId}\u0000${r.reason}`);
  assert.equal(new Set(keys).size, keys.length, "needsReview 理由不应重复");
});
