// 响应体 schema 推导、字段裁剪与脱敏测试（AC-04/09/20）。
// 纪律：schema / 差异描述 / redactedFields 只含字段名与类型名，样本值逐字符串不得出现。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveResponseSchema, deriveResponseFields, redactAndProject, compareSchema,
  describeSchemaDrift, clampBodyChars, clampArraySamples, emptyResponseSchema,
} from "../dist/api-command-response-schema.js";
import { REDACTED_VALUE, MAX_SCHEMA_DEPTH, MAX_ARRAY_SAMPLES } from "../dist/api-command-types.js";

const sample = (bodyText, requestId = "s1") => ({
  requestId, contentType: "application/json", status: 200, bodyText, truncated: false,
});

test("deriveResponseSchema 只输出字段名 + 类型，样本真实值逐字符串不得出现（AC-04）", () => {
  const secrets = ["张三", "13800138000", "SECRET_TITLE_7788", "SECRET_TOKEN_9911"];
  const body = {
    code: 0,
    user: { name: secrets[0], phone: secrets[1], token: secrets[3] },
    items: [{ id: 1, title: secrets[2] }, { id: 2, title: "另一条" }],
    total: 2,
    ok: true,
    nothing: null,
  };
  const schema = deriveResponseSchema([sample(JSON.stringify(body))]);
  const text = JSON.stringify(schema);
  for (const secret of [...secrets, "另一条"]) {
    assert.ok(!text.includes(secret), `schema 泄漏样本值 ${secret}`);
  }
  assert.equal(schema.sampleCount, 1);
  assert.equal(schema.depthLimited, false);
  const paths = schema.fields.map((f) => f.path);
  for (const p of ["code", "user.name", "user.phone", "user.token",
                   "items[].id", "items[].title", "total", "ok", "nothing"]) {
    assert.ok(paths.includes(p), `缺少字段 ${p}`);
  }
  const token = schema.fields.find((f) => f.path === "user.token");
  assert.equal(token.redacted, true);
  const title = schema.fields.find((f) => f.path === "items[].title");
  assert.equal(title.array, true);
  assert.equal(schema.fields.find((f) => f.path === "nothing").type, "null");
  // 每个 field 只允许 5 个声明式键，绝不夹带 value / sample
  for (const field of schema.fields) {
    assert.deepEqual(Object.keys(field).sort(),
      ["array", "isPagination", "path", "redacted", "type"].sort());
    assert.equal(Object.hasOwn(field, "value"), false);
  }
});

test("深度超过 MAX_SCHEMA_DEPTH(6) 标 depthLimited，数组示例不超过 MAX_ARRAY_SAMPLES(5)", () => {
  let nested = 1;
  for (const key of ["i", "h", "g", "f", "e", "d", "c", "b", "a"]) nested = { [key]: nested };
  const deep = deriveResponseSchema([sample(JSON.stringify(nested))]);
  assert.equal(MAX_SCHEMA_DEPTH, 6);
  assert.equal(deep.depthLimited, true, "9 层嵌套应触发深度限制");
  // 纯深层嵌套没有浅层叶子：depth>6 时停止下钻、不产生任何字段（fail-closed）
  assert.equal(deep.fields.length, 0);
  const mixedNested = { top: 1, name: "SAMPLE_SHALLOW_VALUE_3322", deep: nested };
  const mixedSchema = deriveResponseSchema([sample(JSON.stringify(mixedNested))]);
  assert.equal(mixedSchema.depthLimited, true);
  assert.ok(mixedSchema.fields.some((f) => f.path === "top"));
  assert.ok(!JSON.stringify(mixedSchema).includes("SAMPLE_SHALLOW_VALUE_3322"));

  const items = [];
  for (let i = 0; i < 10; i += 1) items.push({ [`k${i}`]: i });
  const withArray = deriveResponseSchema([sample(JSON.stringify({ items }))]);
  assert.equal(MAX_ARRAY_SAMPLES, 5);
  const paths = withArray.fields.map((f) => f.path);
  for (let i = 0; i < 5; i += 1) assert.ok(paths.includes(`items[].k${i}`), `应采样 k${i}`);
  for (let i = 5; i < 10; i += 1) {
    assert.ok(!paths.includes(`items[].k${i}`), `不得采样第 ${i + 1} 个元素`);
  }
  // 空数组 / 顶层数组 / 标量不得抛异常
  assert.equal(deriveResponseSchema([sample("[]")]).depthLimited, false);
  assert.equal(deriveResponseSchema([sample("123")]).fields.length, 0);
});

test("空样本 / 非 JSON body / 截断 JSON / 空 bodyText 一律跳过且零值泄漏", () => {
  assert.deepEqual(deriveResponseSchema([]), emptyResponseSchema());
  assert.deepEqual(deriveResponseSchema(null), emptyResponseSchema());
  const bad = deriveResponseSchema([
    sample(""),
    sample("   "),
    sample("<html>SECRET_HTML_VALUE_1234</html>"),
    sample("{\"code\":1,\"name\":\"SECRET_JSON_VALUE\""), // 被截断的 JSON
  ]);
  assert.equal(bad.sampleCount, 0);
  assert.deepEqual(bad.fields, []);
  assert.ok(!JSON.stringify(bad).includes("SECRET_HTML_VALUE_1234"));
  assert.ok(!JSON.stringify(bad).includes("SECRET_JSON_VALUE"));
  const mixed = deriveResponseSchema([
    sample("<html>not json</html>"),
    sample(JSON.stringify({ ok: true }), "s2"),
  ]);
  assert.equal(mixed.sampleCount, 1);
});

test("deriveResponseFields 输出点路径、排除敏感字段与容器类型、上限 60", () => {
  const schema = {
    fields: [
      { path: "code", type: "number", array: false },
      { path: "data.items[].id", type: "number", array: true },
      { path: "data.token", type: "string", array: false, redacted: true },
      { path: "data", type: "object", array: false },
      { path: "data.items[]", type: "array", array: true },
      { path: "bad..path", type: "string", array: false },
    ],
    depthLimited: false, sampleCount: 2,
  };
  assert.deepEqual(deriveResponseFields(schema), ["code", "data.items[].id"]);
  assert.deepEqual(deriveResponseFields(null), []);
  assert.deepEqual(deriveResponseFields({ fields: [] }), []);
  const many = { fields: Array.from({ length: 100 }, (_, i) => ({
    path: `f${i}`, type: "string", array: false,
  })) };
  assert.equal(deriveResponseFields(many).length, 60);
});

test("redactAndProject 白名单裁剪：fields 为空时 fail-closed 返回空对象，绝不透传未授权字段", () => {
  const data = { code: 0, secretField: "SECRET_UNLISTED_VALUE_4455" };
  const empty = redactAndProject(data, [], 50000);
  assert.deepEqual(empty.data, {});
  assert.equal(empty.truncated, false);
  assert.deepEqual(empty.redactedFields, []);

  const projected = redactAndProject(data, ["code"], 50000);
  assert.deepEqual(projected.data, { code: 0 });
  assert.ok(!JSON.stringify(projected).includes("SECRET_UNLISTED_VALUE_4455"));
  assert.deepEqual(redactAndProject(null, ["code"], 50000).data, {});
  // 非法点路径被丢弃，不会写入结果
  assert.deepEqual(redactAndProject(data, ["bad..path"], 50000).data, {});
});

test("redactAndProject 敏感字段 → [REDACTED]，redactedFields 只放路径、绝不回显原值（AC-09/20）", () => {
  const data = {
    code: 0,
    user: { name: "张三", token: "SECRET_TOKEN_VALUE_6655", password: "SECRET_PWD_VALUE" },
    total: 2,
  };
  const result = redactAndProject(data,
    ["code", "user.name", "user.token", "user.password", "total"], 50000);
  const text = JSON.stringify(result);
  assert.ok(!text.includes("SECRET_TOKEN_VALUE_6655"));
  assert.ok(!text.includes("SECRET_PWD_VALUE"));
  assert.equal(result.data.user.token, REDACTED_VALUE);
  assert.equal(result.data.user.password, REDACTED_VALUE);
  assert.equal(result.data.code, 0); // 运行期业务数据允许含业务值
  assert.equal(result.data.user.name, "张三");
  assert.deepEqual(result.redactedFields.sort(), ["user.password", "user.token"]);
  for (const entry of result.redactedFields) {
    assert.ok(!entry.includes("SECRET"));
    assert.match(entry, /^[a-zA-Z0-9_\-.\[\]]+$/);
  }
});

test("redactAndProject 数组条数上限与 maxBodyChars 超长截断 → truncated:true", () => {
  const data = { items: Array.from({ length: 8 }, (_, i) => ({ id: i })), big: "x".repeat(3000) };
  const limited = redactAndProject(data, ["items[].id"], 50000, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.data.items.length, 2);
  assert.deepEqual(limited.data.items, [{ id: 0 }, { id: 1 }]);

  const oversized = redactAndProject(data, ["big"], 1000);
  assert.equal(oversized.truncated, true);
  assert.equal(typeof oversized.data, "string");
  assert.equal(oversized.data.length, 1000);

  const normal = redactAndProject({ code: 1 }, ["code"], 50000);
  assert.equal(normal.truncated, false);
  assert.deepEqual(normal.data, { code: 1 });
});

test("clampBodyChars 夹到 1000..500000，clampArraySamples 夹到 1..5", () => {
  assert.equal(clampBodyChars(0), 1000);
  assert.equal(clampBodyChars(-1), 1000);
  assert.equal(clampBodyChars(999), 1000);
  assert.equal(clampBodyChars(1000), 1000);
  assert.equal(clampBodyChars(1234.9), 1234);
  assert.equal(clampBodyChars(50000), 50000);
  assert.equal(clampBodyChars(500001), 500000);
  assert.equal(clampBodyChars(1e9), 500000);
  assert.equal(clampBodyChars(NaN), 50000);
  assert.equal(clampBodyChars(undefined), 50000);
  assert.equal(clampBodyChars("5000"), 50000);

  assert.equal(clampArraySamples(0), 1);
  assert.equal(clampArraySamples(-3), 1);
  assert.equal(clampArraySamples(2.9), 2);
  assert.equal(clampArraySamples(5), 5);
  assert.equal(clampArraySamples(99), 5);
  assert.equal(clampArraySamples(undefined), 5);
});

test("compareSchema：true = 结构一致；空基线不得误判漂移（AC-19 漂移语义）", () => {
  const expected = {
    fields: [
      { path: "code", type: "number", array: false, redacted: false },
      { path: "data.items[].id", type: "number", array: true, redacted: false },
      { path: "data.token", type: "string", array: false, redacted: true },
    ],
    depthLimited: false, sampleCount: 3,
  };
  const same = { ...expected, sampleCount: 1 };
  assert.equal(compareSchema(same, expected), true);
  assert.deepEqual(describeSchemaDrift(same, expected), []);

  const missing = {
    fields: expected.fields.filter((f) => f.path !== "data.items[].id"),
    depthLimited: false, sampleCount: 1,
  };
  assert.equal(compareSchema(missing, expected), false);
  assert.ok(describeSchemaDrift(missing, expected).some((d) => d.includes("缺少字段")));

  const changedType = {
    fields: expected.fields.map((f) => f.path === "code" ? { ...f, type: "string" } : f),
    depthLimited: false, sampleCount: 1,
  };
  assert.equal(compareSchema(changedType, expected), false);
  assert.ok(describeSchemaDrift(changedType, expected).some((d) => d.includes("类型由")));

  // expected 为空 schema（sampleCount=0 / fields=[]）→ 无基线，一律返回 true
  assert.equal(compareSchema(missing, emptyResponseSchema()), true);
  assert.equal(compareSchema(changedType, { fields: [], depthLimited: false, sampleCount: 0 }), true);
  // redacted 字段不参与漂移比较
  const onlyRedactedDiff = {
    fields: expected.fields.filter((f) => f.path !== "data.token"),
    depthLimited: false, sampleCount: 1,
  };
  assert.equal(compareSchema(onlyRedactedDiff, expected), true);
});

test("describeSchemaDrift 差异描述只含字段名与类型名，绝不含样本值", () => {
  const expected = {
    fields: [
      { path: "payload.secret", type: "string", array: false, redacted: false, sampleValue: "SECRET_DRIFT_VALUE_1" },
      { path: "payload.count", type: "number", array: false, redacted: false, sampleValue: "SECRET_DRIFT_VALUE_2" },
    ],
    depthLimited: false, sampleCount: 2,
  };
  const actual = {
    fields: [{ path: "payload.count", type: "string", array: false, redacted: false }],
    depthLimited: false, sampleCount: 1,
  };
  const differences = describeSchemaDrift(actual, expected);
  assert.ok(differences.length > 0);
  const text = JSON.stringify(differences);
  assert.ok(!text.includes("SECRET_DRIFT_VALUE_1"));
  assert.ok(!text.includes("SECRET_DRIFT_VALUE_2"));
  assert.ok(!text.includes("sampleValue"));
  assert.ok(differences.every((d) => /字段|类型/.test(d)));
  assert.ok(differences.length <= 20);
});

test("emptyResponseSchema 每次返回全新对象，避免共享可变引用", () => {
  const a = emptyResponseSchema();
  const b = emptyResponseSchema();
  assert.notEqual(a, b);
  assert.notEqual(a.fields, b.fields);
  a.fields.push({ path: "x", type: "string", array: false });
  assert.equal(b.fields.length, 0);
});

// ===== 回归：顶层数组响应（列表接口）曾恒返回 {}（真实执行发现） =====

test("顶层数组 + fields：逐元素投影，保留数组形状", () => {
  // 真实事故：GET /pet/findByStatus 返回 12KB 数组，投影后恒为 {}。
  const list = [
    { id: 1, name: "a", status: "available", photoUrls: ["x"] },
    { id: 2, name: "b", status: "pending", photoUrls: [] },
  ];
  const result = redactAndProject(list, ["id", "status"], 50000);
  assert.ok(Array.isArray(result.data), "必须保持数组形状");
  assert.equal(result.data.length, 2);
  assert.deepEqual(result.data[0], { id: 1, status: "available" });
  assert.deepEqual(result.data[1], { id: 2, status: "pending" });
});

test("顶层数组无 fields：返回空数组而非空对象（形状不能误导）", () => {
  const result = redactAndProject([{ id: 1 }], [], 50000);
  assert.ok(Array.isArray(result.data));
  assert.equal(result.data.length, 0);
});

test("顶层数组投影仍受数组上限与敏感字段约束", () => {
  const list = Array.from({ length: 9 }, (_, i) => ({ id: i, password: `pw${i}` }));
  const result = redactAndProject(list, ["id", "password"], 50000);
  assert.ok(result.data.length <= 5, "数组上限应生效");
  assert.equal(result.truncated, true);
  assert.ok(result.redactedFields.includes("password"));
  assert.ok(!JSON.stringify(result.data).includes("pw0"), "敏感字段不得回显原值");
});

test("顶层标量数组：无法按字段投影时原样保留元素", () => {
  const result = redactAndProject(["a", "b"], ["id"], 50000);
  assert.deepEqual(result.data, ["a", "b"]);
});

test("对象响应路径零回归：仍按白名单裁剪", () => {
  const result = redactAndProject({ a: 1, b: 2 }, ["a"], 50000);
  assert.deepEqual(result.data, { a: 1 });
  assert.equal(result.truncated, false);
});
