// 覆盖率口径改造：按**域名**算真实覆盖率（分母显式、批次可对照、跨域不混算）。
//
// 全部导入 ../dist/*.js 编译产物，可被 node --test 直测（无网络、无浏览器）。
// 覆盖：
//   1. buildCoverage 的新口径字段：denominator / coverageRate / dimensionRates；
//   2. 批次对照（batchStats）：批次数字虚高多少一眼可见；
//   3. 按域名的覆盖率明细（byDomain）：跨 host 命令不被算丢；
//   4. 端点数 = 去重后的真实端点数（命令数 ≠ 端点数）；
//   5. 取不到域名全量时如实标 batch 口径并告警（不把批次冒充全域）；
//   6. provenance=false 时产物形状与旧版完全一致（可回退）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCoverage, coverageCountsConsistent, coverageRate, countDistinctEndpoints,
} from "../dist/api-command-evidence.js";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";
import {
  COVERAGE_SCOPE_BATCH_FALLBACK_WARNING,
} from "../dist/api-command-types.js";

const NOW = "2026-01-01T00:00:00.000Z";

const JS_BUNDLE = `
fetch('/api/v1/courses?page=1');
axios.post('/api/v1/orders/search', { page: 1 });
`;

const HAR = JSON.stringify({
  log: {
    entries: [
      { request: { url: "https://example.com/api/v1/orders?page=2", method: "GET" } },
    ],
  },
});

/** 只有协议相对 URL 的 bundle：命令会落到另一个 host（主域名拿不到命令）。 */
const CROSS_HOST_BUNDLE = `
fetch('//api.other.com/api/v1/courses');
`;

async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wp-coverage-"));
  const file = join(dir, "api-commands.json");
  try {
    return await fn(new ApiCommandCache(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const observed = { tier: "observed", endpoint: "observed", params: "observed", response: "unknown" };
const inferred = { tier: "unknown", endpoint: "inferred", params: "inferred", response: "unknown" };

// ---------------------------------------------------------------------------
// 1. 口径字段：分母显式 + 真实覆盖率
// ---------------------------------------------------------------------------

test("coverageRate 分母为 0 时返回 0（没有命令不等于 100% 覆盖）", () => {
  assert.equal(coverageRate(0, 0), 0);
  assert.equal(coverageRate(3, 0), 0);
  assert.equal(coverageRate(1, 4), 0.25);
  assert.equal(coverageRate(1, 3), 0.333);
  assert.equal(coverageRate(-1, 4), 0);
});

test("buildCoverage 给出显式分母与真实覆盖率（不是让调用方自己拿批次当分母）", () => {
  const coverage = buildCoverage({
    scope: "domain",
    batchCommandCount: 1,
    endpointCount: 2,
    provenances: [observed, inferred, inferred, inferred],
    verifiedCount: 0,
    ambiguities: [],
  });
  assert.equal(coverage.denominator, 4);
  assert.equal(coverage.commandCount, 4);
  assert.equal(coverage.coverageRate, 0.25);
  assert.equal(coverage.batchCommandCount, 1);
  assert.ok(coverageCountsConsistent(coverage));
  // 三维分开给比例：响应维恒 0（静态推导没有响应样本），不被总覆盖率掩盖。
  assert.equal(coverage.dimensionRates.endpoint, 0.25);
  assert.equal(coverage.dimensionRates.params, 0.25);
  assert.equal(coverage.dimensionRates.response, 0);
});

test("buildCoverage 缺省口径仍是 batch（旧行为不被静默改掉）", () => {
  const coverage = buildCoverage({
    endpointCount: 1,
    provenances: [observed],
    verifiedCount: 0,
    ambiguities: [],
  });
  assert.equal(coverage.scope, "batch");
  assert.equal(coverage.denominator, 1);
  assert.equal(coverage.coverageRate, 1);
});

// ---------------------------------------------------------------------------
// 2. 批次对照
// ---------------------------------------------------------------------------

test("batchStats 给出本次批次的同口径统计，批次虚高一眼可见", () => {
  const coverage = buildCoverage({
    scope: "domain",
    batchCommandCount: 2,
    endpointCount: 2,
    provenances: [observed, inferred, inferred, inferred],
    verifiedCount: 0,
    ambiguities: [],
    batchProvenances: [observed, observed],
  });
  assert.ok(coverage.batchStats);
  assert.equal(coverage.batchStats.commandCount, 2);
  assert.equal(coverage.batchStats.coverageRate, 1);
  // 批次口径 100%，域名口径只有 25% —— 这正是「数字有点虚」的来源。
  assert.equal(coverage.coverageRate, 0.25);
  assert.ok(coverage.batchStats.coverageRate > coverage.coverageRate);
});

// ---------------------------------------------------------------------------
// 3. 按域名的明细
// ---------------------------------------------------------------------------

test("byDomain 按域名分别给覆盖率（跨域命令不被算丢）", () => {
  const coverage = buildCoverage({
    scope: "domain",
    batchCommandCount: 2,
    endpointCount: 2,
    provenances: [observed, observed],
    verifiedCount: 0,
    ambiguities: [],
    domainProvenances: {
      "example.com": [observed, inferred],
      "api.other.com": [observed],
    },
  });
  assert.ok(coverage.byDomain);
  assert.equal(coverage.byDomain["example.com"].commandCount, 2);
  assert.equal(coverage.byDomain["example.com"].coverageRate, 0.5);
  assert.equal(coverage.byDomain["api.other.com"].commandCount, 1);
  assert.equal(coverage.byDomain["api.other.com"].coverageRate, 1);
});

// ---------------------------------------------------------------------------
// 4. 端点数 = 去重后的真实端点数
// ---------------------------------------------------------------------------

test("countDistinctEndpoints 按 method + host + pathTemplate 去重", () => {
  assert.equal(countDistinctEndpoints([
    { method: "GET", pathTemplate: "/a", host: "x.com" },
    { method: "GET", pathTemplate: "/a", host: "x.com" },
    { method: "POST", pathTemplate: "/a", host: "x.com" },
    { method: "GET", pathTemplate: "/a", host: "y.com" },
    { method: "GET", pathTemplate: "/b", host: "x.com" },
  ]), 4);
  assert.equal(countDistinctEndpoints([]), 0);
  assert.equal(countDistinctEndpoints(undefined), 0);
});

// ---------------------------------------------------------------------------
// 5. 端到端：scan_site 的域名口径覆盖率
// ---------------------------------------------------------------------------

test("scan_site 的覆盖率按域名全量统计，批次数字单独给出（不混算）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    // 第一轮：只有 JS bundle（端点证据 = inferred）。
    const first = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "js", text: JS_BUNDLE }],
    });
    assert.ok(first.coverage);
    assert.equal(first.coverage.scope, "domain");
    assert.equal(first.coverage.coverageRate, 0, "静态推导没有观测证据 → 真实覆盖率为 0");
    assert.equal(first.coverage.dimensionRates.response, 0);

    // 第二轮：补一份 HAR 归档流量（端点证据 = observed）。
    const second = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "har", text: HAR }],
    });
    assert.ok(second.coverage);
    assert.equal(second.coverage.scope, "domain");
    // 分母是**该域名的全量**命令（两轮合并后的全部命令），不是本轮批次。
    assert.equal(second.coverage.commandCount, second.coverage.denominator);
    assert.equal(second.coverage.commandCount, first.coverage.commandCount + second.coverage.batchCommandCount);
    // 批次对照：本轮批次里 HAR 那条是 observed，批次覆盖率必然高于域名口径。
    assert.ok(second.coverage.batchStats);
    assert.ok(second.coverage.batchStats.coverageRate >= second.coverage.coverageRate);
    // 按域名的明细在。
    assert.ok(second.coverage.byDomain);
    assert.ok(second.coverage.byDomain["example.com"]);
    assert.equal(
      second.coverage.byDomain["example.com"].commandCount,
      second.coverage.commandCount,
    );
    // 端点数是去重后的真实端点数。
    assert.ok(second.coverage.endpointCount > 0);
    assert.ok(second.coverage.endpointCount <= second.coverage.commandCount);
  });
});

test("取不到主域名全量命令时如实标 batch 口径并告警（不把批次冒充全域）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "js", text: CROSS_HOST_BUNDLE }],
    });
    assert.ok(report.coverage);
    // 命令全部落在 api.other.com，主域名没有任何命令 → 只能是批次口径。
    assert.equal(report.coverage.scope, "batch");
    assert.ok(report.warnings.includes(COVERAGE_SCOPE_BATCH_FALLBACK_WARNING));
    // 跨域命令仍按它自己的域名给出覆盖率，不被算丢。
    assert.ok(report.coverage.byDomain);
    assert.ok(report.coverage.byDomain["api.other.com"]);
    assert.equal(report.coverage.byDomain["api.other.com"].commandCount, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. 配置化回退
// ---------------------------------------------------------------------------

test("provenance=false 时报告不含 coverage 段（旧产物形状完全不变）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "js", text: JS_BUNDLE }],
      provenance: false,
    });
    assert.equal(report.coverage, undefined);
    assert.ok(report.commandCount > 0, "回退不影响命令产出");
  });
});

test("覆盖率段不含任何样本值 / 凭据", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "har", text: HAR }],
    });
    const serialized = JSON.stringify(report.coverage);
    assert.ok(!serialized.includes("page=2"));
    assert.ok(!serialized.includes("123456789"));
  });
});
