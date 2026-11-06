// T14 · 应用上下文路径（context path）复刻修复的回归用例。
//
// 背景（实测 Confluence 复刻）：
//   前端 bundle 把接口路径写成「上下文前缀 + 相对路径」，
//   例如 AJS.contextPath()+"/rest/webResources/1.0/resources"；
//   而 Confluence 真实地址是 /confluence/rest/webResources/1.0/resources。
//   静态推导只拿到裸路径 /rest/... → 命令打过去 404（实测已复现）。
//
// 本文件覆盖三层：
//   A. 纯函数层：normalizeContextPath / isNoisePath / applyContextPath / scanJsTextDetailed / scanSources
//   B. 扩展侧：normalizeApiContextPath 与页面上下文取值 + cmdApiBundleCollect 回包
//   C. 契约层：常量逐字同步 + coverage 口径字段
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import * as T from "../dist/api-command-types.js";
import {
  normalizeContextPath,
  isNoisePath,
  applyContextPath,
  scanJsTextDetailed,
  scanSources,
} from "../dist/api-command-site-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const HELPERS_PATH = join(here, "..", "..", "browser-extension", "api-command-helpers.js");
const BG_PATH = join(here, "..", "..", "browser-extension", "background.js");
const helpersSource = readFileSync(HELPERS_PATH, "utf8");
const backgroundSource = readFileSync(BG_PATH, "utf8");

const CONTEXT_PATH = "/confluence";

// ===== A. 纯函数层 =====

test("normalizeContextPath：只接受「/ 开头、无协议/查询串/片段/.. /反斜杠/空白/引号」的路径", () => {
  assert.equal(normalizeContextPath("/confluence"), "/confluence");
  assert.equal(normalizeContextPath("  /confluence  "), "/confluence");
  assert.equal(normalizeContextPath("/confluence/"), "/confluence");
  // 站点部署在根路径 → 空串（与「取不到」区分开，由编排层决定告警口径）
  assert.equal(normalizeContextPath("/"), "");
  assert.equal(normalizeContextPath(""), "");
  // 非字符串
  assert.equal(normalizeContextPath(undefined), "");
  assert.equal(normalizeContextPath(123), "");
  // 缺 / 前缀
  assert.equal(normalizeContextPath("confluence"), "");
  // 协议相对 URL 会把 host 带进来 → 拒绝
  assert.equal(normalizeContextPath("//evil.example.com"), "");
  // 查询串 / 片段
  assert.equal(normalizeContextPath("/confluence?a=1"), "");
  assert.equal(normalizeContextPath("/confluence#x"), "");
  // 目录穿越 / 反斜杠
  assert.equal(normalizeContextPath("/confluence/../etc"), "");
  assert.equal(normalizeContextPath("/confluence\\etc"), "");
  // 空白与引号（会被拼进 URL，属于注入面）
  assert.equal(normalizeContextPath("/confluence evil"), "");
  assert.equal(normalizeContextPath("/confluence\""), "");
  // 超长
  assert.equal(normalizeContextPath(`/${"a".repeat(T.API_CONTEXT_PATH_MAX_LENGTH)}`), "");
});

test("isNoisePath：形状像噪音 **且** 无请求上下文才丢；有请求上下文一律保留", () => {
  // 极短无语义路径（实测来自普通字符串常量）
  assert.equal(isNoisePath("/a/i", false), true);
  assert.equal(isNoisePath("/a/b", false), true);
  // 同一路径一旦出现在请求上下文里 → 保留（双重保险）
  assert.equal(isNoisePath("/a/i", true), false);
  // 静态资源
  assert.equal(isNoisePath("/includes/soy/dialog.soy", false), true);
  assert.equal(isNoisePath("/images/icons/emoticons", false), true);
  // 真接口不能被误伤
  assert.equal(isNoisePath("/rest/webResources/1.0/resources", false), false);
  // download 不在静态资源集里 —— Confluence 的 /download/resources 是真接口
  assert.equal(isNoisePath("/download/resources", false), false);
});

test("applyContextPath：只给「相对 context」的裸路径补前缀", () => {
  assert.equal(applyContextPath("/rest/x", CONTEXT_PATH, true), "/confluence/rest/x");
  assert.equal(applyContextPath("/rest/x", CONTEXT_PATH, false), "/rest/x");
  // 取不到前缀 → 保持原样（由上层显式告警，不静默改写）
  assert.equal(applyContextPath("/rest/x", "", true), "/rest/x");
  // 已带前缀 → 不重复加
  assert.equal(applyContextPath("/confluence/rest/x", CONTEXT_PATH, true), "/confluence/rest/x");
  assert.equal(applyContextPath("/confluence/rest/x", CONTEXT_PATH, false), "/confluence/rest/x");
});

test("scanJsTextDetailed：识别三类「相对应用上下文路径」的写法", () => {
  const detailed = scanJsTextDetailed(
    [
      'var a = AJS.contextPath()+"/rest/webResources/1.0/resources";',
      'var b = f.CONTEXT_PATH+"/json/pagechildren.action";',
      'var c = AJS.Confluence.getContextPath()+"/ajax/spaceavailable.action";',
    ].join("\n"),
    { loose: true },
  );
  const paths = detailed.candidates.map((c) => c.pathTemplate);
  assert.ok(paths.includes("/rest/webResources/1.0/resources"), `实际: ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("/json/pagechildren.action"), `实际: ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("/ajax/spaceavailable.action"), `实际: ${JSON.stringify(paths)}`);
  const relative = detailed.candidates.filter((c) => c.relativeToContext === true);
  assert.equal(relative.length, 3, "三条都应标记为相对 context");
});

test("scanJsTextDetailed：字面量拼接的前半段本身就是前缀，不依赖 context 取值", () => {
  const detailed = scanJsTextDetailed(
    'var d = soy.$$escapeHtml("/confluence") + "/json/addwatch.action";',
    { loose: true },
  );
  const paths = detailed.candidates.map((c) => c.pathTemplate);
  assert.ok(paths.includes("/confluence/json/addwatch.action"), `实际: ${JSON.stringify(paths)}`);
  // 字面量前缀形态**不是**「相对 context」——它自带前缀，不需要再补
  const target = detailed.candidates.find((c) => c.pathTemplate === "/confluence/json/addwatch.action");
  assert.notEqual(target.relativeToContext, true);
});

test("scanJsTextDetailed：普通字符串常量 / 注释里的静态资源路径被当噪音丢掉", () => {
  const detailed = scanJsTextDetailed(
    [
      'var flag = "/a/i";',
      'var other = "/a/b";',
      '// see /includes/soy/dialog.soy for details',
      'var icon = staticResourceUrlPrefix + "/images/icons/emoticons";',
      'fetch("/rest/webResources/1.0/resources");',
    ].join("\n"),
    { loose: true },
  );
  const paths = detailed.candidates.map((c) => c.pathTemplate);
  assert.ok(!paths.includes("/a/i"), "普通字符串常量不应成为端点");
  assert.ok(!paths.includes("/a/b"), "普通字符串常量不应成为端点");
  assert.ok(!paths.some((p) => p.includes("/includes/soy/")), "注释里的静态资源不应成为端点");
  assert.ok(!paths.some((p) => p.includes("/images/icons/")), "静态资源目录不应成为端点");
  // 真接口仍在
  assert.ok(paths.includes("/rest/webResources/1.0/resources"), `实际: ${JSON.stringify(paths)}`);
  assert.ok(detailed.noiseDropped > 0, "应统计到被丢弃的噪音条数");
});

test("scanSources：拿到 context 前缀时补齐路径并给出「已应用」告警", () => {
  const result = scanSources(
    [{ kind: "js", text: 'var a = AJS.contextPath()+"/rest/webResources/1.0/resources";' }],
    { domain: "confluence.gaodunwangxiao.com", loose: true, contextPath: CONTEXT_PATH },
  );
  const paths = result.candidates.map((c) => c.pathTemplate);
  assert.ok(paths.includes("/confluence/rest/webResources/1.0/resources"), `实际: ${JSON.stringify(paths)}`);
  assert.equal(result.contextPath, CONTEXT_PATH);
  assert.ok(result.relativePathCount >= 1);
  assert.ok(result.contextPathAppliedCount >= 1);
  assert.ok(result.warnings.includes(T.SITE_SCAN_CONTEXT_PATH_APPLIED_WARNING));
  assert.ok(!result.warnings.includes(T.SITE_SCAN_CONTEXT_PATH_MISSING_WARNING));
});

test("scanSources：取不到 context 前缀时保持原样并显式告警（不静默放过）", () => {
  const result = scanSources(
    [{ kind: "js", text: 'var a = AJS.contextPath()+"/rest/webResources/1.0/resources";' }],
    { domain: "confluence.gaodunwangxiao.com", loose: true },
  );
  const paths = result.candidates.map((c) => c.pathTemplate);
  assert.ok(paths.includes("/rest/webResources/1.0/resources"), "没有前缀值时不得凭空造前缀");
  assert.equal(result.contextPath, "");
  assert.ok(result.relativePathCount >= 1);
  assert.equal(result.contextPathAppliedCount, 0);
  assert.ok(result.warnings.includes(T.SITE_SCAN_CONTEXT_PATH_MISSING_WARNING));
  assert.ok(!result.warnings.includes(T.SITE_SCAN_CONTEXT_PATH_APPLIED_WARNING));
});

test("scanSources：噪音路径被丢弃时给出「已丢弃」告警", () => {
  const result = scanSources(
    [{ kind: "js", text: 'var flag = "/a/i"; var other = "/a/b";' }],
    { domain: "confluence.gaodunwangxiao.com", loose: true, contextPath: CONTEXT_PATH },
  );
  assert.equal(result.candidates.length, 0);
  assert.ok(result.noiseDroppedCount >= 2);
  assert.ok(result.warnings.includes(T.SITE_SCAN_NOISE_PATH_WARNING));
});

// ===== B. 扩展侧 =====

function loadHelpers() {
  const sandbox = { console: { log() {}, error() {}, warn() {} }, URL, TextDecoder, TextEncoder, Uint8Array };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const hook = ";globalThis.__h = { normalizeApiContextPath, apiNormalizeHostname, API_CONTEXT_PATH_MAX_LENGTH,"
    + " MSG_RESULT };";
  vm.runInContext(helpersSource + hook, sandbox, { filename: "api-command-helpers.js" });
  return sandbox.__h;
}
const H = loadHelpers();

test("扩展侧常量与 dist 逐字一致", () => {
  assert.equal(H.API_CONTEXT_PATH_MAX_LENGTH, T.API_CONTEXT_PATH_MAX_LENGTH);
});

test("normalizeApiContextPath 与 MCP 侧 normalizeContextPath 行为逐项一致", () => {
  const cases = [
    "/confluence", "  /confluence  ", "/confluence/", "/", "", "confluence",
    "//evil.example.com", "/confluence?a=1", "/confluence#x", "/confluence/../etc",
    "/confluence\\etc", "/confluence evil", "/confluence\"",
    `/${"a".repeat(T.API_CONTEXT_PATH_MAX_LENGTH)}`,
  ];
  for (const value of cases) {
    assert.equal(H.normalizeApiContextPath(value), normalizeContextPath(value), `输入: ${JSON.stringify(value)}`);
  }
  assert.equal(H.normalizeApiContextPath(undefined), "");
  assert.equal(H.normalizeApiContextPath(123), "");
});

test("apiDetectContextPathInPage：优先读 AJS.contextPath()，其次 Confluence.getContextPath()，再退到全局变量", () => {
  const PAGE_FN = makeEnv().sandbox.__bg.apiDetectContextPathInPage;
  // 没有任何上下文来源 → 返回空串，不瞎猜
  const bare = {
    location: { origin: "https://confluence.gaodunwangxiao.com" },
    window: {},
    document: { querySelector: () => null },
  };
  bare.globalThis = bare;
  vm.createContext(bare);
  vm.runInContext(PAGE_FN.toString(), bare);
  const empty = vm.runInContext("apiDetectContextPathInPage()", bare);
  assert.equal(empty.contextPath, "");
  assert.equal(empty.origin, "https://confluence.gaodunwangxiao.com");

  const sandbox = {
    location: { origin: "https://confluence.gaodunwangxiao.com" },
    window: { AJS: { contextPath: () => "/confluence" } },
    document: { querySelector: () => null },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PAGE_FN.toString(), sandbox);
  const out = vm.runInContext("apiDetectContextPathInPage()", sandbox);
  assert.equal(out.contextPath, "/confluence");
  assert.equal(out.origin, "https://confluence.gaodunwangxiao.com");

  // AJS.Confluence.getContextPath() 次选
  const sandbox2 = {
    location: { origin: "https://confluence.gaodunwangxiao.com" },
    window: { AJS: { Confluence: { getContextPath: () => "/confluence" } } },
    document: { querySelector: () => null },
  };
  sandbox2.globalThis = sandbox2;
  vm.createContext(sandbox2);
  vm.runInContext(PAGE_FN.toString(), sandbox2);
  assert.equal(vm.runInContext("apiDetectContextPathInPage()", sandbox2).contextPath, "/confluence");

  // 全局变量兜底（实测形态：var contextPath = '/confluence';）
  const sandbox3 = {
    location: { origin: "https://confluence.gaodunwangxiao.com" },
    window: { contextPath: "/confluence" },
    document: { querySelector: () => null },
  };
  sandbox3.globalThis = sandbox3;
  vm.createContext(sandbox3);
  vm.runInContext(PAGE_FN.toString(), sandbox3);
  assert.equal(vm.runInContext("apiDetectContextPathInPage()", sandbox3).contextPath, "/confluence");
});

function makeEnv({ origin = "https://app.example.com", hosts = ["app.example.com"], pageContextPath = "" } = {}) {
  const state = { sent: [], pageResponse: { ok: true, text: "fetch('/api/v1/orders')" } };
  const chrome = {
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: {
        async get(keys) {
          if (keys == null) return {};
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in state) out[key] = state[key];
          return out;
        },
        async set() {}, async remove() {},
      },
    },
    tabs: {
      async get() { return { id: 7, url: `${origin}/x`, active: true }; },
      async query() { return []; }, async create() { return { id: 7, url: origin }; },
      async update() { return { id: 7, url: origin }; },
      onUpdated: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {} },
    },
    tabGroups: { async get() { throw new Error("none"); }, async update() {}, async query() { return []; }, onRemoved: { addListener() {} } },
    windows: { async update() {} },
    alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
    runtime: {
      async sendMessage() {}, onMessage: { addListener() {} },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      getURL: (p) => `chrome-extension://mock/${p}`, id: "mock",
    },
    scripting: {
      async executeScript({ func, args }) {
        try {
          const result = await func(...(Array.isArray(args) ? args : []));
          return [{ result }];
        } catch {
          return [{ result: undefined }];
        }
      },
    },
    debugger: {
      async attach() {}, async detach() {},
      async sendCommand() { return {}; }, onEvent: { addListener() {} },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, Buffer,
    AbortController, AbortSignal,
    WebSocket: class {},
    chrome,
    fetch: async () => { throw new Error("no fetch in this test"); },
    location: { href: `${origin}/x`, origin },
    window: pageContextPath ? { AJS: { contextPath: () => pageContextPath } } : {},
    document: { querySelectorAll: () => [], querySelector: () => null },
    performance: { getEntriesByType: () => [] },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const hook = ";globalThis.__bg = { cmdApiBundleCollect, apiDetectContextPathInPage };";
  vm.runInContext(helpersSource + "\n" + backgroundSource + hook, sandbox, { filename: "background.js" });
  sandbox.sendToDaemon = (data) => { state.sent.push(data); };
  return { sandbox, state };
}

test("cmdApiBundleCollect：回包带 contextPath，且只在页面 origin 命中 hosts 时才采信", async () => {
  const env = makeEnv({ pageContextPath: "/confluence" });
  await env.sandbox.__bg.cmdApiBundleCollect(
    { tabId: 7, options: { urls: ["https://app.example.com/static/app.js"], hosts: ["app.example.com"] } },
    "req-1",
  );
  const reply = env.state.sent.at(-1);
  assert.equal(reply.type, T.MSG_RESULT.BUNDLE_COLLECT);
  assert.equal(reply.contextPath, "/confluence");
});

test("cmdApiBundleCollect：页面 origin 不在 hosts 内 → contextPath 置空（跨站页面给出的前缀是污染）", async () => {
  const env = makeEnv({ origin: "https://evil.example.com", pageContextPath: "/confluence" });
  await env.sandbox.__bg.cmdApiBundleCollect(
    { tabId: 7, options: { urls: ["https://app.example.com/static/app.js"], hosts: ["app.example.com"] } },
    "req-1",
  );
  assert.equal(env.state.sent.at(-1).contextPath, "");
});

test("cmdApiBundleCollect：页面给出的非法前缀被丢弃", async () => {
  for (const bad of ["//evil.example.com", "confluence", "/confluence?a=1", "/confluence/../etc"]) {
    const env = makeEnv({ pageContextPath: bad });
    await env.sandbox.__bg.cmdApiBundleCollect(
      { tabId: 7, options: { urls: ["https://app.example.com/static/app.js"], hosts: ["app.example.com"] } },
      "req-1",
    );
    assert.equal(env.state.sent.at(-1).contextPath, "", `非法前缀应被丢弃: ${bad}`);
  }
});

// ===== C. 契约层 =====

test("AnalysisCoverage 显式带 scope 口径与 batchCommandCount", () => {
  const coverage = {
    scope: "domain",
    batchCommandCount: 14,
    endpointCount: 54,
    commandCount: 54,
    byTier: { observed: 10, derived: 0, inferred: 4, unknown: 40 },
    byDimension: {
      endpoint: { observed: 10, derived: 0, inferred: 4, unknown: 40 },
      params: { observed: 10, derived: 0, inferred: 4, unknown: 40 },
      response: { observed: 10, derived: 0, inferred: 4, unknown: 40 },
    },
    verifiedCount: 10,
    ambiguities: [],
    nextHints: [],
  };
  // 口径字段必须能承载「批次 14 条 / 域名 54 条」这种场景
  assert.equal(coverage.scope, "domain");
  assert.equal(coverage.batchCommandCount, 14);
  assert.equal(coverage.commandCount, 54);
  const sum = coverage.byTier.observed + coverage.byTier.derived
    + coverage.byTier.inferred + coverage.byTier.unknown;
  assert.equal(sum, coverage.commandCount, "各档之和必须等于命令总数");
});

test("SiteScanResult / AnalysisReport 契约带 contextPath 与相对路径计数", () => {
  assert.equal(typeof T.SITE_SCAN_CONTEXT_PATH_APPLIED_WARNING, "string");
  assert.equal(typeof T.SITE_SCAN_CONTEXT_PATH_MISSING_WARNING, "string");
  assert.equal(typeof T.SITE_SCAN_NOISE_PATH_WARNING, "string");
  // 告警文案不得回显前缀本身（路径结构属站点信息，可从命令里看到）
  for (const text of [
    T.SITE_SCAN_CONTEXT_PATH_APPLIED_WARNING,
    T.SITE_SCAN_CONTEXT_PATH_MISSING_WARNING,
    T.SITE_SCAN_NOISE_PATH_WARNING,
  ]) {
    assert.ok(!text.includes("/confluence"), "告警文案不得回显具体前缀");
    assert.ok(!text.includes("http"), "告警文案不得回显 URL");
  }
});
