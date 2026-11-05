// T9 复合命令：JSONPath 取值 + 显式映射表 + 多步编排。
//
// 覆盖：
//  - JSONPath 子集解析 / 求值（只支持 $ 根 + .name + ["name"] + [n] + [*]）；
//  - 缓存层 steps 白名单重建（步数上限 / 禁止字段 / 非法路径 / 不可落盘值）；
//  - 服务层多步编排（取值注入 / 预检零请求 / 风险只升不降 / 嵌套禁止）；
//  - 导出 → 导入闭环后 steps 不丢、仍可直接调用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJsonPath, evalJsonPath, isStepValueMapping,
  resolveCompositeSteps, applyStepMappings,
} from "../dist/api-command-render.js";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";
import { MAX_COMPOSITE_STEPS, MAX_JSONPATH_LENGTH, MAX_JSONPATH_SEGMENTS } from "../dist/api-command-types.js";

const DOMAIN = "shop.example.com";
const NOW = "2026-01-01T00:00:00.000Z";

const base = (overrides = {}) => ({
  commandId: "cmd_8f3a1c2d90",
  name: "get.order",
  domain: DOMAIN,
  risk: "read",
  confidence: 0.8,
  schemaVersion: 1,
  manuallyEdited: false,
  deprecated: false,
  request: {
    method: "GET",
    urlTemplate: `https://${DOMAIN}/v1/orders/{{id}}`,
    pathTemplate: "/v1/orders/{id}",
    bodyTemplate: null,
    queryTemplate: {},
  },
  params: [{ name: "id", location: "path", type: "string", required: true }],
  responseFields: [],
  responseSchema: { fields: [], depthLimited: false, sampleCount: 0 },
  redactedHeaderNames: [],
  source: { analysisId: "an_test", analyzedAt: NOW, generatedBy: "1.1.1" },
  health: { hits: 0, misses: 0, consecutiveFailures: 0, disabled: false, totalDurationMs: 0 },
  analyzedAt: NOW, lastVerifiedAt: NOW, createdAt: NOW, updatedAt: NOW,
  ...overrides,
});

/** 建单：POST /v1/orders，响应 { data: { order: { id: "ord-1" } } }。 */
const createCmd = (overrides = {}) => base({
  commandId: "cmd_1111111111",
  name: "create.order",
  risk: "write",
  request: {
    method: "POST",
    urlTemplate: `https://${DOMAIN}/v1/orders`,
    pathTemplate: "/v1/orders",
    bodyTemplate: { sku: "{{sku}}" },
    queryTemplate: {},
  },
  params: [{ name: "sku", location: "body", type: "string", required: true }],
  ...overrides,
});

/** 建单 + 查单：第二步用上一步响应里的 order id。 */
const compositeCmd = (overrides = {}) => base({
  commandId: "cmd_2222222222",
  name: "flow.create_then_get",
  risk: "write",
  request: {
    method: "GET",
    urlTemplate: `https://${DOMAIN}/v1/orders/{{id}}`,
    pathTemplate: "/v1/orders/{id}",
    bodyTemplate: null,
    queryTemplate: {},
  },
  params: [],
  steps: [
    { name: "create.order", params: { sku: "SKU-1" } },
    { name: "get.order", params: { id: { from: "$.data.order.id" } } },
  ],
  ...overrides,
});

const makeService = async (commands, send) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-t9-"));
  const cache = new ApiCommandCache(join(dir, "api-commands.json"));
  await cache.merge(DOMAIN, commands, { mode: "full", overwriteManual: false });
  return { dir, cache, service: new ApiCommandService(cache, send) };
};

// ---------------------------------------------------------------------------
// JSONPath 子集
// ---------------------------------------------------------------------------

test("T9：parseJsonPath 接受 $ 根 + .name / [\"name\"] / [n] / [*]", () => {
  const cases = [
    "$",
    "$.data",
    "$.data.order.id",
    '$["data"]["order"]["id"]',
    "$.data.items[0].id",
    "$.data.items[*].id",
    "$.data.items[0][*].name",
  ];
  for (const path of cases) {
    const parsed = parseJsonPath(path);
    assert.equal(parsed.ok, true, `应接受 ${path}：${parsed.reason ?? ""}`);
  }
});

test("T9：parseJsonPath 拒绝过滤 / 脚本 / 递归 / 通配属性 / 切片（fail-closed）", () => {
  const rejected = [
    "$.data[?(@.id==1)].name",   // 过滤表达式
    "$.data.(script)",            // 脚本
    "$..id",                      // 递归下降
    "$.*.id",                     // 通配属性
    "$.data[0:2]",                // 切片
    "data.order.id",              // 缺 $ 根
    "",                           // 空
  ];
  for (const path of rejected) {
    const parsed = parseJsonPath(path);
    assert.equal(parsed.ok, false, `应拒绝 ${path}`);
    assert.equal(parsed.segments.length, 0);
  }
});

test("T9：parseJsonPath 长度 / 段数有上限", () => {
  assert.equal(parseJsonPath("$" + "a".repeat(MAX_JSONPATH_LENGTH)).ok, false);
  const tooMany = "$" + Array.from({ length: MAX_JSONPATH_SEGMENTS + 1 }, () => ".a").join("");
  assert.equal(parseJsonPath(tooMany).ok, false);
});

test("T9：evalJsonPath 按 JSONPath 语义求值，[*] 恒为数组", () => {
  const root = { data: { order: { id: "ord-1" }, items: [{ id: "a" }, { id: "b" }] } };
  assert.deepEqual(evalJsonPath(root, "$.data.order.id"), { found: true, value: "ord-1" });
  assert.deepEqual(evalJsonPath(root, "$.data.items[0].id"), { found: true, value: "a" });
  assert.deepEqual(evalJsonPath(root, "$.data.items[*].id"),
    { found: true, value: ["a", "b"] });
  assert.deepEqual(evalJsonPath(root, "$.data.missing"), { found: false });
  assert.deepEqual(evalJsonPath(root, "$.data.items[9].id"), { found: false });
  // 命中 1 个时 [*] 仍是数组（不是标量）
  assert.deepEqual(evalJsonPath({ a: [{ b: 1 }] }, "$.a[*].b"), { found: true, value: [1] });
});

test("T9：isStepValueMapping 只认纯 {from: string}", () => {
  assert.equal(isStepValueMapping({ from: "$.a" }), true);
  assert.equal(isStepValueMapping({ from: "$.a", extra: 1 }), false);
  assert.equal(isStepValueMapping({ path: "$.a" }), false);
  assert.equal(isStepValueMapping({ from: 123 }), false);
  assert.equal(isStepValueMapping("$.a"), false);
  assert.equal(isStepValueMapping(null), false);
});

// ---------------------------------------------------------------------------
// 缓存层 steps 白名单重建
// ---------------------------------------------------------------------------

test("T9：缓存层保留合法 steps，并按白名单丢弃未知键", async (t) => {
  const { dir, cache } = await makeService([
    compositeCmd({
      steps: [
        { name: "create.order", params: { sku: "SKU-1" }, note: "建单", extra: "dropped" },
        { commandId: "cmd_8f3a1c2d90", params: { id: { from: "$.data.order.id" } } },
      ],
    }),
  ], async () => ({}));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const stored = await cache.get(DOMAIN, { name: "flow.create_then_get" });
  assert.ok(stored);
  assert.equal(stored.steps.length, 2);
  assert.equal(stored.steps[0].name, "create.order");
  assert.equal(stored.steps[0].note, "建单");
  assert.equal(Object.hasOwn(stored.steps[0], "extra"), false, "未知键必须丢弃");
  assert.deepEqual(stored.steps[1].params, { id: { from: "$.data.order.id" } });
});

test("T9：缓存层拒绝非法 steps（步数超限 / 禁止字段 / 非法取值路径 / 不可落盘值）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-t9-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = new ApiCommandCache(join(dir, "api-commands.json"));

  const cases = [
    // 步数超限
    compositeCmd({
      commandId: "cmd_3333333333",
      steps: Array.from({ length: MAX_COMPOSITE_STEPS + 1 }, () => ({ name: "create.order" })),
    }),
    // 可执行字段：整条命令跳过
    compositeCmd({
      commandId: "cmd_4444444444",
      steps: [{ name: "create.order", script: "rm -rf /" }],
    }),
    // 非法取值路径（过滤表达式）
    compositeCmd({
      commandId: "cmd_5555555555",
      steps: [{ name: "get.order", params: { id: { from: "$.data[?(@.x)].id" } } }],
    }),
    // 嵌套对象里夹带敏感字段名
    compositeCmd({
      commandId: "cmd_6666666666",
      steps: [{ name: "get.order", params: { id: { token: "abc" } } }],
    }),
    // 凭据形态的值不得落盘
    compositeCmd({
      commandId: "cmd_9999999998",
      steps: [{ name: "get.order", params: { id: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" } }],
    }),
    // name 非法
    compositeCmd({
      commandId: "cmd_7777777777",
      steps: [{ name: "Create Order!" }],
    }),
    // 既无 name 也无 commandId
    compositeCmd({
      commandId: "cmd_8888888888",
      steps: [{ params: { id: "x" } }],
    }),
  ];
  for (const cmd of cases) {
    await cache.merge(DOMAIN, [cmd], { mode: "full", overwriteManual: false });
    const stored = await cache.get(DOMAIN, { commandId: cmd.commandId });
    assert.equal(stored, undefined, `非法 steps 必须被拒收：${cmd.commandId}`);
  }
});

// ---------------------------------------------------------------------------
// 服务层多步编排
// ---------------------------------------------------------------------------

test("T9：多步编排按序执行，上一步响应的值注入下一步参数", async (t) => {
  const sent = [];
  const { dir, service } = await makeService(
    [createCmd(), base(), compositeCmd()],
    async (_type, params) => {
      sent.push(params.options);
      if (params.options.method === "POST") {
        return { success: true, status: 200, body: { data: { order: { id: "ord-1" } } }, durationMs: 5 };
      }
      return { success: true, status: 200, body: { data: { order: { id: "ord-1" } } }, durationMs: 5 };
    },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({
    domain: DOMAIN, name: "flow.create_then_get", confirm: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(sent.length, 2, "两步都要发出");
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].body, JSON.stringify({ sku: "SKU-1" }));
  assert.equal(sent[1].method, "GET");
  assert.equal(sent[1].url, `https://${DOMAIN}/v1/orders/ord-1`, "第二步的 id 必须来自上一步响应");
  assert.equal(result.stepResults.length, 2);
  assert.equal(result.stepResults[0].index, 0);
  assert.equal(result.stepResults[1].status, 200);
});

test("T9：含写操作步骤但未确认 → CONFIRMATION_REQUIRED 且零网络请求", async (t) => {
  let calls = 0;
  const { dir, service } = await makeService(
    [createCmd(), base(), compositeCmd()],
    async () => { calls += 1; return { success: true, status: 200, body: {} }; },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({ domain: DOMAIN, name: "flow.create_then_get" });
  assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(result.confirmationRequired, true);
  assert.equal(calls, 0, "未确认时不得发出任何请求");
});

test("T9：子命令缺失 → COMMAND_NOT_FOUND 且零网络请求", async (t) => {
  let calls = 0;
  const { dir, service } = await makeService(
    [compositeCmd({ steps: [{ name: "missing.command" }] })],
    async () => { calls += 1; return { success: true, status: 200, body: {} }; },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({
    domain: DOMAIN, name: "flow.create_then_get", confirm: true,
  });
  assert.equal(result.error.code, "COMMAND_NOT_FOUND");
  assert.equal(calls, 0);
});

test("T9：取值路径未命中 → MISSING_PARAMS，且该步零网络请求", async (t) => {
  const sent = [];
  const { dir, service } = await makeService(
    [createCmd(), base(), compositeCmd({
      steps: [
        { name: "create.order", params: { sku: "SKU-1" } },
        { name: "get.order", params: { id: { from: "$.data.nothing.here" } } },
      ],
    })],
    async (_type, params) => {
      sent.push(params.options);
      return { success: true, status: 200, body: { data: { order: { id: "ord-1" } } }, durationMs: 5 };
    },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({
    domain: DOMAIN, name: "flow.create_then_get", confirm: true,
  });
  assert.equal(result.error.code, "MISSING_PARAMS");
  assert.equal(sent.length, 1, "取值失败的步骤不得发出请求");
  assert.equal(result.stepResults.length, 1, "已完成的步骤结果要保留");
  assert.ok(result.warnings.some((w) => w.includes("未发送任何请求")));
});

test("T9：步骤 risk 不能把子命令的 write 降级成 read（风险只升不降）", async (t) => {
  let calls = 0;
  const { dir, service } = await makeService(
    [createCmd(), base(), compositeCmd({
      risk: "read",
      steps: [
        { name: "create.order", params: { sku: "SKU-1" }, risk: "read" },
        { name: "get.order", params: { id: { from: "$.data.order.id" } } },
      ],
    })],
    async () => { calls += 1; return { success: true, status: 200, body: {} }; },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({ domain: DOMAIN, name: "flow.create_then_get" });
  assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(calls, 0, "子命令是 write 就必须确认，步骤自述 read 不能降级");
});

test("T9：步骤固定参数不在子命令声明里 → INVALID_PARAMS 且零网络请求", async (t) => {
  let calls = 0;
  const { dir, service } = await makeService(
    [createCmd(), base(), compositeCmd({
      steps: [{ name: "get.order", params: { unknown_param: "x" } }],
    })],
    async () => { calls += 1; return { success: true, status: 200, body: {} }; },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({
    domain: DOMAIN, name: "flow.create_then_get", confirm: true,
  });
  assert.equal(result.error.code, "INVALID_PARAMS");
  assert.equal(calls, 0);
});

test("T9：调用方传值覆盖步骤固定值；未被任何步骤声明的参数被忽略并留痕", async (t) => {
  const sent = [];
  const { dir, service } = await makeService(
    [createCmd(), base(), compositeCmd({
      steps: [{ name: "create.order", params: { sku: "SKU-DEFAULT" } }],
    })],
    async (_type, params) => {
      sent.push(params.options);
      return { success: true, status: 200, body: { data: { order: { id: "ord-1" } } }, durationMs: 5 };
    },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({
    domain: DOMAIN, name: "flow.create_then_get", confirm: true,
    params: { sku: "SKU-FROM-CALLER", not_declared: "x" },
  });
  assert.equal(result.error, undefined);
  assert.equal(sent[0].body, JSON.stringify({ sku: "SKU-FROM-CALLER" }),
    "调用方传值必须覆盖步骤固定值");
  assert.ok(result.warnings.some((w) => w.includes("not_declared")),
    "未被声明的参数要留痕，不能静默");
});

test("T9：嵌套复合命令被拒绝（不支持复合套复合）", async (t) => {
  let calls = 0;
  const { dir, service } = await makeService(
    [compositeCmd({ commandId: "cmd_9999999999", name: "flow.inner" }), compositeCmd({
      commandId: "cmd_2222222222",
      steps: [{ name: "flow.inner" }],
    })],
    async () => { calls += 1; return { success: true, status: 200, body: {} }; },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await service.call({
    domain: DOMAIN, name: "flow.create_then_get", confirm: true,
  });
  assert.equal(result.error.code, "INVALID_PARAMS");
  assert.equal(calls, 0);
});

test("T9：applyStepMappings 取值优先级 —— 映射 > 调用方 > 固定值", () => {
  const plan = resolveCompositeSteps({
    ...base(),
    steps: [{ name: "get.order", params: { id: { from: "$.data.order.id" }, page: 1 } }],
  })[0];
  assert.deepEqual(plan.mappings, [{ param: "id", path: "$.data.order.id" }]);
  assert.deepEqual(plan.literalParams, { page: 1 });

  // 映射命中 → 覆盖调用方传值，并留痕
  const hit = applyStepMappings(plan, { data: { order: { id: "ord-9" } } }, { id: "from-caller" });
  assert.equal(hit.params.id, "ord-9");
  assert.ok(hit.overridden.includes("id"), "映射覆盖调用方传值必须留痕");
  assert.deepEqual(hit.missing, []);

  // 映射未命中且调用方给了值 → 用调用方的值
  const rescued = applyStepMappings(plan, { data: {} }, { id: "from-caller" });
  assert.equal(rescued.params.id, "from-caller");
  assert.deepEqual(rescued.missing, []);

  // 映射未命中且调用方没给 → 缺参
  const missed = applyStepMappings(plan, { data: {} }, {});
  assert.deepEqual(missed.missing, ["id"]);

  // 非映射参数：调用方传值覆盖固定值
  const literal = applyStepMappings(plan, { data: { order: { id: "x" } } }, { page: 7 });
  assert.equal(literal.params.page, 7);
});

test("T9：resolveCompositeSteps 只拆参数不求值，步数按上限截断", () => {
  const plans = resolveCompositeSteps({
    ...base(),
    steps: [
      { name: "a.cmd", params: { x: 1, y: { from: "$.z" } } },
      { name: "b.cmd" },
    ],
  });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].index, 0);
  assert.deepEqual(plans[0].literalParams, { x: 1 });
  assert.deepEqual(plans[0].mappings, [{ param: "y", path: "$.z" }]);
  assert.deepEqual(plans[1].literalParams, {});

  const many = resolveCompositeSteps({
    ...base(),
    steps: Array.from({ length: MAX_COMPOSITE_STEPS + 3 }, () => ({ name: "a.cmd" })),
  });
  assert.equal(many.length, MAX_COMPOSITE_STEPS);
});

// ---------------------------------------------------------------------------
// 导出 / 导入闭环（复合命令靠导入交付）
// ---------------------------------------------------------------------------

test("T9：导出 → 清空 → 导入闭环后 steps 不丢，且仍可直接调用", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-t9-io-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "api-commands.json");
  const pkg = join(dir, "bundle.json");

  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, [createCmd(), base(), compositeCmd()], { mode: "full", overwriteManual: false });

  const exported = await cache.export(DOMAIN, pkg, {});
  assert.equal(exported.exported, 3);
  const payload = JSON.parse(await readFile(pkg, "utf8"));
  const composite = payload.commands.find((c) => c.name === "flow.create_then_get");
  assert.ok(composite, "导出件必须含复合命令");
  assert.equal(composite.steps.length, 2, "导出件必须带上 steps");
  assert.deepEqual(composite.steps[1].params, { id: { from: "$.data.order.id" } });

  // 清空后导入
  const fresh = new ApiCommandCache(file);
  await fresh.invalidate(DOMAIN, { action: "clear_domain" });
  const imported = await fresh.import(DOMAIN, pkg, {});
  assert.equal(imported.imported, 3);

  const stored = await fresh.get(DOMAIN, { name: "flow.create_then_get" });
  assert.ok(stored);
  assert.equal(stored.steps.length, 2);

  // 导入后可直接调用（走完整编排链路）
  const sent = [];
  const service = new ApiCommandService(fresh, async (_type, params) => {
    sent.push(params.options);
    return { success: true, status: 200, body: { data: { order: { id: "ord-1" } } }, durationMs: 5 };
  });
  const result = await service.call({
    domain: DOMAIN, name: "flow.create_then_get", confirm: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].url, `https://${DOMAIN}/v1/orders/ord-1`);
});

test("T9：导入件里的非法 steps 被拒收（不污染命令集）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-t9-badimport-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "api-commands.json");
  const pkg = join(dir, "bundle.json");

  await writeFile(pkg, JSON.stringify({
    version: 1,
    kind: "webpilot-api-command-set",
    domain: DOMAIN,
    commands: [
      {
        ...compositeCmd(),
        steps: [{ name: "create.order", script: "rm -rf /" }],
      },
    ],
  }), "utf8");

  const cache = new ApiCommandCache(file);
  const imported = await cache.import(DOMAIN, pkg, {});
  assert.equal(imported.imported, 0);
  assert.ok(imported.skipped >= 1);
  const stored = await cache.get(DOMAIN, { name: "flow.create_then_get" });
  assert.equal(stored, undefined);
});
