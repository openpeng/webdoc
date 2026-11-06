// T13：证据分级 / 歧义显式 / 覆盖率报告 —— 纯函数层与端到端回归测试。
// 全部导入 ../dist/*.js 编译产物，可被 node --test 直测（无 IO、无网络、无浏览器）。
//
// 覆盖：
//   1. 证据档位推导：来源种类 → 档位映射、三维取最弱、总档位。
//   2. 歧义显式化：host 多解 / baseURL 多解 / 来源冲突三类歧义必须被显式记录。
//   3. 覆盖率聚合：分档计数自洽（各档之和 == 命令数）、verifiedCount、nextHints。
//   4. 落盘与回读：provenance 经 cache 写入后能原样读回（旧缓存缺该字段时不臆造）。
//   5. 配置化回退：provenance=false 时产物形状与旧版完全一致（可回退）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeTier, weakestTier, tierForSourceKind, tierForSourceKinds, tierForOrigin,
  deriveProvenance, sameSourceKinds, makeAmbiguity, hostAmbiguity, baseUrlAmbiguity,
  buildCoverage, coverageCountsConsistent,
} from "../dist/api-command-evidence.js";
import { scanSources, toScanRecords } from "../dist/api-command-site-scan.js";
import { groupEndpoints } from "../dist/api-command-normalize.js";
import { generateCommands } from "../dist/api-command-generator.js";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";
import {
  COMMAND_TIERS, SITE_SCAN_DEFAULT_PROVENANCE, SITE_SCAN_DEFAULT_LOOSE,
  SITE_SCAN_DEFAULT_TRUST_SPEC,
} from "../dist/api-command-types.js";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const JS_BUNDLE = `
const API = '/api/v1';
fetch('/api/v1/courses?page=1&size=20');
axios.post('/api/v1/orders/search', { page: 1, size: 20 });
`;

const OPENAPI = JSON.stringify({
  paths: {
    "/api/v1/courses": {
      get: { parameters: [{ name: "page", in: "query" }, { name: "size", in: "query" }] },
    },
  },
});

const HAR = JSON.stringify({
  log: {
    entries: [
      { request: { url: "https://example.com/api/v1/courses?page=2", method: "GET" } },
    ],
  },
});

const NOW = "2026-01-01T00:00:00.000Z";

async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wp-evidence-"));
  const file = join(dir, "api-commands.json");
  try {
    await fn(new ApiCommandCache(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 证据档位推导
// ---------------------------------------------------------------------------

test("T13：档位常量四档且由强到弱，normalizeTier 对非法输入归 unknown", () => {
  assert.deepEqual([...COMMAND_TIERS], ["observed", "derived", "inferred", "unknown"]);
  assert.equal(normalizeTier("observed"), "observed");
  assert.equal(normalizeTier("inferred"), "inferred");
  // 非法 / 缺失一律归 unknown —— 缺失即未知，不臆造档位。
  assert.equal(normalizeTier("bogus"), "unknown");
  assert.equal(normalizeTier(undefined), "unknown");
  assert.equal(normalizeTier(null), "unknown");
  assert.equal(normalizeTier(123), "unknown");
});

test("T13：weakestTier 取最弱一档；全缺失时为 unknown", () => {
  assert.equal(weakestTier(["observed", "derived", "inferred"]), "inferred");
  assert.equal(weakestTier(["observed", "unknown"]), "unknown");
  assert.equal(weakestTier([]), "unknown");
  assert.equal(weakestTier([undefined, undefined]), "unknown");
});

test("T13：来源种类 → 档位映射（HAR 观测 / 规格声明 / bundle 推断）", () => {
  // HAR 是真实流量归档 → observed
  assert.equal(tierForSourceKind("har"), "observed");
  // OpenAPI / 声明式命令包是权威声明 → derived
  assert.equal(tierForSourceKind("openapi"), "derived");
  assert.equal(tierForSourceKind("commands"), "derived");
  // 前端 bundle 里的路径字面量 → inferred
  assert.equal(tierForSourceKind("js"), "inferred");
  assert.equal(tierForSourceKind(undefined), "unknown");
});

test("T13：多来源合并取最强档（弱证据不否定强观测）", () => {
  assert.equal(tierForSourceKinds(["js", "har"]), "observed");
  assert.equal(tierForSourceKinds(["js", "openapi"]), "derived");
  assert.equal(tierForSourceKinds(["js"]), "inferred");
  assert.equal(tierForSourceKinds([]), "unknown");
  assert.equal(tierForSourceKinds(undefined), "unknown");
});

test("T13：通道来源 → 档位（抓包 observed / 人工与规格 derived / 未知 unknown）", () => {
  assert.equal(tierForOrigin("capture"), "observed");
  assert.equal(tierForOrigin("manual"), "derived");
  assert.equal(tierForOrigin("spec"), "derived");
  assert.equal(tierForOrigin("scan"), "unknown");
  assert.equal(tierForOrigin(undefined), "unknown");
});

test("T13：deriveProvenance 三维判定，总档位取最弱", () => {
  // 静态推导：端点 inferred、参数 inferred、响应无样本 → unknown，总档位 unknown
  const scanOnly = deriveProvenance({ sourceKinds: ["js"], origin: "scan" });
  assert.equal(scanOnly.endpoint, "inferred");
  assert.equal(scanOnly.params, "inferred");
  assert.equal(scanOnly.response, "unknown");
  assert.equal(scanOnly.tier, "unknown");

  // HAR 观测 + 有响应样本 → 三维全 observed，总档位 observed
  const observed = deriveProvenance({
    sourceKinds: ["har"], origin: "scan", hasResponseSample: true,
  });
  assert.equal(observed.endpoint, "observed");
  assert.equal(observed.params, "observed");
  assert.equal(observed.response, "observed");
  assert.equal(observed.tier, "observed");

  // 端点确定但响应无样本 → 总档位必须被最弱维度拉低
  const half = deriveProvenance({ sourceKinds: ["har"], origin: "scan" });
  assert.equal(half.endpoint, "observed");
  assert.equal(half.response, "unknown");
  assert.equal(half.tier, "unknown");

  // 抓包通道：端点与参数均为真实观测
  const capture = deriveProvenance({ origin: "capture", hasObservedParams: true });
  assert.equal(capture.endpoint, "observed");
  assert.equal(capture.params, "observed");
});

test("T13：sameSourceKinds 忽略顺序与重复", () => {
  assert.equal(sameSourceKinds(["js", "har"], ["har", "js"]), true);
  assert.equal(sameSourceKinds(["js", "js"], ["js"]), true);
  assert.equal(sameSourceKinds(["js"], ["js", "har"]), false);
  assert.equal(sameSourceKinds(undefined, undefined), true);
});

// ---------------------------------------------------------------------------
// 2. 歧义显式化
// ---------------------------------------------------------------------------

test("T13：makeAmbiguity 去重并记候选数；来源冲突候选为空", () => {
  const amb = makeAmbiguity("host", ["a.com", "b.com", "a.com"], "/api/x");
  assert.equal(amb.kind, "host");
  assert.equal(amb.candidateCount, 2);
  assert.deepEqual(amb.candidates, ["a.com", "b.com"]);
  assert.equal(amb.pathTemplate, "/api/x");

  const conflict = makeAmbiguity("sourceConflict", [], "/api/x");
  assert.equal(conflict.candidateCount, 0);
  assert.deepEqual(conflict.candidates, []);
});

test("T13：hostAmbiguity / baseUrlAmbiguity 仅在候选 >1 时产出", () => {
  assert.equal(hostAmbiguity("/api/x", ["a.com"]), undefined);
  assert.equal(hostAmbiguity("/api/x", []), undefined);
  const host = hostAmbiguity("/api/x", ["a.com", "b.com"]);
  assert.ok(host);
  assert.equal(host.kind, "host");
  assert.equal(host.candidateCount, 2);

  assert.equal(baseUrlAmbiguity(["a.com"]), undefined);
  const base = baseUrlAmbiguity(["a.com", "b.com"]);
  assert.ok(base);
  assert.equal(base.kind, "baseUrl");
  assert.equal(base.pathTemplate, undefined);
});

// ---------------------------------------------------------------------------
// 3. 覆盖率聚合
// ---------------------------------------------------------------------------

test("T13：buildCoverage 分档计数自洽，各档之和恒等于命令数", () => {
  const coverage = buildCoverage({
    endpointCount: 3,
    provenances: [
      { tier: "observed", endpoint: "observed", params: "observed", response: "observed" },
      { tier: "derived", endpoint: "derived", params: "derived", response: "unknown" },
      { tier: "inferred", endpoint: "inferred", params: "inferred", response: "unknown" },
      { tier: "unknown", endpoint: "unknown", params: "unknown", response: "unknown" },
      { tier: "unknown", endpoint: "unknown", params: "unknown", response: "unknown" },
    ],
    verifiedCount: 1,
    ambiguities: [],
  });
  assert.equal(coverage.commandCount, 5);
  assert.equal(coverage.endpointCount, 3);
  assert.equal(coverage.byTier.observed, 1);
  assert.equal(coverage.byTier.derived, 1);
  assert.equal(coverage.byTier.inferred, 1);
  assert.equal(coverage.byTier.unknown, 2);
  assert.equal(coverage.verifiedCount, 1);
  assert.ok(coverageCountsConsistent(coverage));
});

test("T13：byDimension 三维分别统计 —— 端点有证据但响应未观测时能看出差异", () => {
  // 静态推导的典型形状：端点 inferred，响应恒 unknown。
  const coverage = buildCoverage({
    endpointCount: 1,
    provenances: [
      { tier: "unknown", endpoint: "inferred", params: "inferred", response: "unknown" },
    ],
    verifiedCount: 0,
    ambiguities: [],
  });
  assert.equal(coverage.byDimension.endpoint.inferred, 1);
  assert.equal(coverage.byDimension.params.inferred, 1);
  assert.equal(coverage.byDimension.response.unknown, 1);
  assert.equal(coverage.byDimension.response.observed, 0);
  // 总档位被最弱维（响应）拉平，但维度拆分仍能看出端点其实有证据。
  assert.equal(coverage.byTier.unknown, 1);
  assert.equal(coverage.byDimension.endpoint.unknown, 0);
});

test("T13：buildCoverage 对空输入产出全 0 且仍然自洽", () => {
  const coverage = buildCoverage({
    endpointCount: 0, provenances: [], verifiedCount: 0, ambiguities: [],
  });
  assert.equal(coverage.commandCount, 0);
  assert.equal(coverage.byTier.observed, 0);
  assert.ok(coverageCountsConsistent(coverage));
  assert.deepEqual(coverage.ambiguities, []);
});

test("T13：nextHints 按计数触发且每条文案只出现一次", () => {
  const coverage = buildCoverage({
    endpointCount: 2,
    provenances: [
      { tier: "unknown", endpoint: "inferred", params: "inferred", response: "unknown" },
      { tier: "unknown", endpoint: "unknown", params: "unknown", response: "unknown" },
    ],
    verifiedCount: 0,
    ambiguities: [hostAmbiguity("/api/x", ["a.com", "b.com"])],
  });
  // inferred 与 unknown 都触发提示，unknown 同时命中「缺响应样本」提示。
  assert.ok(coverage.nextHints.length >= 3);
  assert.equal(new Set(coverage.nextHints).size, coverage.nextHints.length);
  // 全部提示只含固定文案，不含样本值 / host / 路径。
  for (const hint of coverage.nextHints) {
    assert.ok(!hint.includes("a.com"));
    assert.ok(!hint.includes("/api/x"));
  }
});

// ---------------------------------------------------------------------------
// 4. 扫描侧：同键合并与歧义产出
// ---------------------------------------------------------------------------

test("T13：同键候选合并 —— 来源种类取并集、参数名取并集，不再首胜丢弃", () => {
  // JS 与 OpenAPI 都声明了 /api/v1/courses，但参数集不同。
  const result = scanSources([
    { kind: "js", text: JS_BUNDLE },
    { kind: "openapi", text: OPENAPI },
  ], { domain: "example.com", maxEndpoints: 50 });
  const courses = result.candidates.find((c) => c.pathTemplate === "/api/v1/courses");
  assert.ok(courses, "应产出 /api/v1/courses 候选");
  // 来源并集
  assert.deepEqual([...(courses.sourceKinds ?? [])].sort(), ["js", "openapi"]);
  // 参数并集：JS 侧看到 page/size，OpenAPI 侧也声明 page/size
  assert.deepEqual([...courses.queryNames].sort(), ["page", "size"]);
});

test("T13：合并后 tier 取最强来源（HAR 观测压过 bundle 推断）", () => {
  const result = scanSources([
    { kind: "js", text: JS_BUNDLE },
    { kind: "har", text: HAR },
  ], { domain: "example.com", maxEndpoints: 50 });
  const courses = result.candidates.find((c) => c.pathTemplate === "/api/v1/courses");
  assert.ok(courses);
  assert.deepEqual([...(courses.sourceKinds ?? [])].sort(), ["har", "js"]);
  // HAR 是真实归档流量 → observed
  assert.equal(tierForSourceKinds(courses.sourceKinds), "observed");
});

test("T13：参数集不同**不算**冲突（HAR 只记某次请求的参数，规格声明的是全量）", () => {
  const jsOnly = `
fetch('/api/v1/orders/search?keyword=1');
`;
  const openapiOnly = JSON.stringify({
    paths: {
      "/api/v1/orders/search": {
        get: { parameters: [{ name: "page", in: "query" }] },
      },
    },
  });
  const result = scanSources([
    { kind: "js", text: jsOnly },
    { kind: "openapi", text: openapiOnly },
  ], { domain: "example.com", maxEndpoints: 50 });
  // 参数集确实不同（并集后是 keyword + page），但这不是「证据矛盾」。
  const orders = result.candidates.find((c) => c.pathTemplate === "/api/v1/orders/search");
  assert.ok(orders);
  assert.deepEqual([...orders.queryNames].sort(), ["keyword", "page"]);
  const conflicts = (result.ambiguities ?? []).filter((a) => a.kind === "sourceConflict");
  assert.equal(conflicts.length, 0, "观察面不同不构成来源冲突");
});

test("T13：同一端点被不同来源归到不同 host → 记来源冲突歧义", () => {
  // js 用协议相对 URL 指向 api-a.example.com，命令包则声明 api-b.example.com。
  const js = `
fetch('//api-a.example.com/api/v1/courses');
`;
  const commands = JSON.stringify({
    commands: [{
      name: "list.courses",
      method: "GET",
      request: {
        method: "GET",
        urlTemplate: "https://api-b.example.com/api/v1/courses",
        pathTemplate: "/api/v1/courses",
      },
    }],
  });
  const result = scanSources([
    { kind: "js", text: js },
    { kind: "commands", text: commands },
  ], { domain: "example.com", maxEndpoints: 50 });
  const conflicts = (result.ambiguities ?? []).filter((a) => a.kind === "sourceConflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].pathTemplate, "/api/v1/courses");
  assert.equal(conflicts[0].candidateCount, 2);
  assert.deepEqual([...conflicts[0].candidates].sort(),
    ["api-a.example.com", "api-b.example.com"]);
});

test("T13：同一路径跨多个 origin 的 HAR → 显式 host 歧义（不再静默拍平）", () => {
  const multiOriginHar = JSON.stringify({
    log: {
      entries: [
        { request: { url: "https://a.example.com/api/v1/courses", method: "GET" } },
        { request: { url: "https://b.example.com/api/v1/courses", method: "GET" } },
      ],
    },
  });
  const result = scanSources([
    { kind: "har", text: multiOriginHar },
  ], { domain: "example.com", maxEndpoints: 50 });
  const hostAmb = (result.ambiguities ?? []).filter((a) => a.kind === "host");
  assert.equal(hostAmb.length, 1);
  assert.equal(hostAmb[0].pathTemplate, "/api/v1/courses");
  assert.equal(hostAmb[0].candidateCount, 2);
  // 候选只记 origin 集合，不回显路径以外的信息
  assert.ok(hostAmb[0].candidates.includes("a.example.com"));
});

test("T13：baseURL 多解 → 显式 baseUrl 歧义（不再静默跳过推断）", () => {
  const js = `
const cfg = { baseURL: "//api-a.example.com" };
const cfg2 = { baseURL: "//api-b.example.com" };
fetch('/api/v1/courses');
`;
  const result = scanSources([
    { kind: "js", text: js },
  ], { domain: "example.com", maxEndpoints: 50 });
  const baseAmb = (result.ambiguities ?? []).filter((a) => a.kind === "baseUrl");
  assert.equal(baseAmb.length, 1);
  assert.equal(baseAmb[0].candidateCount, 2);
});

test("T13：来源种类经 记录 → 分组 透传（toScanRecords / groupEndpoints）", () => {
  const result = scanSources([
    { kind: "js", text: JS_BUNDLE },
    { kind: "har", text: HAR },
  ], { domain: "example.com", maxEndpoints: 50 });
  const records = toScanRecords(result.candidates, "example.com");
  assert.ok(records.length > 0);
  const groups = groupEndpoints(records);
  const courses = groups.find((g) => g.pathTemplate === "/api/v1/courses");
  assert.ok(courses);
  assert.deepEqual([...(courses.sourceKinds ?? [])].sort(), ["har", "js"]);
});

// ---------------------------------------------------------------------------
// 5. 生成层：命令落盘带 provenance
// ---------------------------------------------------------------------------

test("T13：generateCommands 标注 provenance 时命令带三维档位", () => {
  const result = scanSources([
    { kind: "js", text: JS_BUNDLE },
    { kind: "har", text: HAR },
  ], { domain: "example.com", maxEndpoints: 50 });
  const records = toScanRecords(result.candidates, "example.com");
  const groups = groupEndpoints(records);
  const generated = generateCommands(groups, {
    domain: "example.com",
    analysisId: "an_test",
    generatedBy: "test",
    schema: new Map(),
    now: NOW,
    sourceOrigin: "scan",
    provenance: true,
  });
  assert.ok(generated.commands.length > 0);
  const courses = generated.commands.find((c) => c.request.pathTemplate === "/api/v1/courses");
  assert.ok(courses);
  assert.ok(courses.source.provenance);
  assert.equal(courses.source.provenance.endpoint, "observed");
  assert.equal(courses.source.provenance.response, "unknown");
  assert.equal(courses.source.provenance.tier, "unknown");
});

test("T13：provenance 未开启时命令不带该字段（缺省即旧版形状）", () => {
  const result = scanSources([
    { kind: "js", text: JS_BUNDLE },
  ], { domain: "example.com", maxEndpoints: 50 });
  const records = toScanRecords(result.candidates, "example.com");
  const groups = groupEndpoints(records);
  const generated = generateCommands(groups, {
    domain: "example.com",
    analysisId: "an_test",
    generatedBy: "test",
    schema: new Map(),
    now: NOW,
    sourceOrigin: "scan",
  });
  assert.ok(generated.commands.length > 0);
  for (const command of generated.commands) {
    assert.equal(command.source.provenance, undefined);
  }
});

// ---------------------------------------------------------------------------
// 6. 缓存往返：provenance 写盘后能原样读回
// ---------------------------------------------------------------------------

test("T13：provenance 经缓存写入后原样读回", async () => {
  await withCache(async (cache, file) => {
    const result = scanSources([
      { kind: "js", text: JS_BUNDLE },
      { kind: "har", text: HAR },
    ], { domain: "example.com", maxEndpoints: 50 });
    const records = toScanRecords(result.candidates, "example.com");
    const groups = groupEndpoints(records);
    const generated = generateCommands(groups, {
      domain: "example.com",
      analysisId: "an_test",
      generatedBy: "test",
      schema: new Map(),
      now: NOW,
      sourceOrigin: "scan",
      provenance: true,
    });
    const merged = await cache.merge("example.com", generated.commands, { mode: "merge" });
    assert.equal(merged.diff.added, generated.commands.length);

    const reloaded = new ApiCommandCache(file);
    const listed = await reloaded.list("example.com");
    assert.equal(listed.commands.length, generated.commands.length);
    // 取「HAR 与 JS 都观察到」的那条命令：它的端点档位应为 observed。
    const courses = generated.commands.find((c) => c.request.pathTemplate === "/api/v1/courses");
    assert.ok(courses, "应产出 /api/v1/courses 命令");
    const stored = await reloaded.get("example.com", { commandId: courses.commandId });
    assert.ok(stored);
    assert.ok(stored.source.provenance, "落盘后 provenance 必须读回");
    assert.equal(stored.source.provenance.tier, "unknown");
    assert.equal(stored.source.provenance.endpoint, "observed");
    // 档位值必须仍是合法枚举
    for (const key of ["tier", "endpoint", "params", "response"]) {
      assert.ok(COMMAND_TIERS.includes(stored.source.provenance[key]));
    }
  });
});

test("T13：旧缓存无 provenance 字段时不臆造档位", async () => {
  await withCache(async (cache, file) => {
    const { writeFile } = await import("node:fs/promises");
    // 手工写一份「旧形状」缓存：source 里没有 provenance。
    await writeFile(file, JSON.stringify({
      version: 1,
      generatedBy: "old",
      updatedAt: NOW,
      domains: {
        "example.com": {
          host: "example.com",
          updatedAt: NOW,
          commands: [{
            commandId: "cmd_aaaaaaaaaa",
            name: "list.courses",
            domain: "example.com",
            risk: "read",
            confidence: 0.9,
            schemaVersion: 1,
            manuallyEdited: false,
            deprecated: false,
            request: { method: "GET", urlTemplate: "https://example.com/api/v1/courses", pathTemplate: "/api/v1/courses" },
            params: [],
            responseFields: [],
            responseSchema: { fields: [], depthLimited: false, sampleCount: 0 },
            redactedHeaderNames: [],
            source: { analysisId: "an_old", analyzedAt: NOW, generatedBy: "old", origin: "capture" },
            health: { hits: 0, misses: 0, consecutiveFailures: 0, disabled: false, totalDurationMs: 0 },
            analyzedAt: NOW, lastVerifiedAt: NOW, createdAt: NOW, updatedAt: NOW,
          }],
        },
      },
    }), "utf8");

    const reloaded = new ApiCommandCache(file);
    const stored = await reloaded.get("example.com", { commandId: "cmd_aaaaaaaaaa" });
    assert.ok(stored);
    assert.equal(stored.source.provenance, undefined, "旧缓存不得被补出 provenance");
  });
});

// ---------------------------------------------------------------------------
// 7. 端到端：scan_site 报告输出 coverage 段
// ---------------------------------------------------------------------------

test("T13：scan_site 报告输出 coverage 段且分档自洽", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "js", text: JS_BUNDLE }, { kind: "har", text: HAR }],
    });
    assert.ok(report.coverage, "开启证据分级时报告必须带 coverage 段");
    assert.equal(report.coverage.commandCount, report.commandCount);
    assert.equal(report.coverage.endpointCount, report.endpointCount);
    assert.ok(coverageCountsConsistent(report.coverage));
    // 静态推导无响应样本 → 响应档位恒 unknown → verifiedCount 为 0
    assert.equal(report.coverage.verifiedCount, 0);
    assert.ok(Array.isArray(report.coverage.ambiguities));
    assert.ok(Array.isArray(report.coverage.nextHints));
  });
});

test("T13：provenance=false 时报告不含 coverage 段（配置化完全回退）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "js", text: JS_BUNDLE }],
      provenance: false,
    });
    assert.equal(report.coverage, undefined, "显式 false 必须完全回退");
    assert.ok(report.commandCount > 0, "回退不影响命令产出");
  });
});

test("T13：默认开启证据分级（配置化放开的默认值可达）", () => {
  assert.equal(SITE_SCAN_DEFAULT_PROVENANCE, true);
});

test("T13：覆盖报告不含任何样本值 / 凭据", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "js", text: JS_BUNDLE }, { kind: "har", text: HAR }],
    });
    const serialized = JSON.stringify(report.coverage);
    // HAR 里的 page=2 是样本值，绝不能出现在覆盖报告里。
    assert.ok(!serialized.includes("page=2"));
    assert.ok(!serialized.includes("123456789"));
  });
});
