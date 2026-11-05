// BundleCollect（扩展侧带登录态补采 JS bundle）契约测试。
//
// 两部分：
//  A. 纯函数层：apiCheckBundleUrl / rebuildBundleCollectOptions 的白名单与 fail-closed 语义。
//  B. 扩展侧：把 helpers.js + background.js 一起装进 vm 沙箱，用假 chrome / 假页面环境驱动
//     cmdApiBundleCollect，验证「页面上下文 → SW → 浏览器缓存」三层 fallback、host 白名单、
//     配额与「原文只回包、不进日志」的纪律。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import * as T from "../dist/api-command-types.js";
import { ApiCommandService } from "../dist/api-command-service.js";

const here = dirname(fileURLToPath(import.meta.url));
const HELPERS_PATH = join(here, "..", "..", "browser-extension", "api-command-helpers.js");
const BG_PATH = join(here, "..", "..", "browser-extension", "background.js");
const helpersSource = readFileSync(HELPERS_PATH, "utf8");
const backgroundSource = readFileSync(BG_PATH, "utf8");

const PAGE_URL = "https://app.example.com/dashboard";
const ORIGIN = "https://app.example.com";
const HOSTS = ["app.example.com"];

// ===== A. 纯函数层 =====

function loadHelpers() {
  const sandbox = { console: { log() {}, error() {}, warn() {} }, URL, TextDecoder, TextEncoder, Uint8Array };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const hook = ";globalThis.__h = { apiCheckBundleUrl, rebuildBundleCollectOptions, MSG, MSG_RESULT,"
    + " TAB_SCOPED_API_MESSAGES, BUNDLE_COLLECT_ALLOWED_KEYS, BUNDLE_COLLECT_FORBIDDEN_KEYS,"
    + " BUNDLE_COLLECT_MAX_SOURCES, BUNDLE_COLLECT_MAX_SOURCE_BYTES, BUNDLE_COLLECT_MAX_TOTAL_BYTES,"
    + " BUNDLE_COLLECT_TIMEOUT_MS, BUNDLE_COLLECT_WALL_BUDGET_MS,"
    + " BUNDLE_COLLECT_DEFAULT_SOURCES, BUNDLE_COLLECT_VIAS };";
  vm.runInContext(helpersSource + hook, sandbox, { filename: "api-command-helpers.js" });
  return sandbox.__h;
}
const H = loadHelpers();

test("apiCheckBundleUrl：仅 http(s)、无 userinfo、host 必须精确命中", () => {
  assert.equal(H.apiCheckBundleUrl(`${PAGE_URL}/static/app.js`, HOSTS).ok, true);
  // 大小写与尾点归一后仍命中
  assert.equal(H.apiCheckBundleUrl("https://APP.Example.com./a.js", HOSTS).ok, true);
  // 协议非法
  assert.equal(H.apiCheckBundleUrl("file:///etc/passwd", HOSTS).ok, false);
  assert.equal(H.apiCheckBundleUrl("javascript:alert(1)", HOSTS).ok, false);
  // 内嵌凭据
  assert.equal(H.apiCheckBundleUrl("https://u:p@app.example.com/a.js", HOSTS).ok, false);
  // 后缀相似但不是同一 host（不允许后缀匹配）
  assert.equal(H.apiCheckBundleUrl("https://evil-app.example.com/a.js", HOSTS).ok, false);
  assert.equal(H.apiCheckBundleUrl("https://app.example.com.evil.io/a.js", HOSTS).ok, false);
  // hosts 为空 → fail-closed
  assert.equal(H.apiCheckBundleUrl(`${PAGE_URL}/a.js`, []).ok, false);
  assert.equal(H.apiCheckBundleUrl(`${PAGE_URL}/a.js`, undefined).ok, false);
  // reason 是固定枚举，不回显 URL
  const bad = H.apiCheckBundleUrl("https://evil.io/a.js?token=abc", HOSTS);
  assert.equal(bad.reason, "host");
  assert.ok(!JSON.stringify(bad).includes("token"));
});

test("rebuildBundleCollectOptions：禁止字段被丢弃、urls 去重截断、数值 clamp", () => {
  const options = H.rebuildBundleCollectOptions({
    urls: [
      `${PAGE_URL}/a.js`,
      `${PAGE_URL}/a.js`,
      "  ",
      `${PAGE_URL}/b.js`,
    ],
    hosts: ["app.example.com", "APP.example.com.", "app.example.com"],
    discover: true,
    maxSources: 99,
    maxBytes: 99 * 1024 * 1024,
    timeoutMs: 1,
    // 下列字段没有任何入口：必须整体消失
    headers: { cookie: "session=abc" },
    body: "{\"a\":1}",
    method: "POST",
    cookies: "session=abc",
    credentials: "include",
    confirm: true,
    tabId: 7,
    overrides: { url: "https://evil.io" },
  });
  assert.deepEqual([...options.urls], [`${PAGE_URL}/a.js`, `${PAGE_URL}/b.js`]);
  assert.deepEqual([...options.hosts], ["app.example.com"]);
  assert.equal(options.discover, true);
  assert.equal(options.maxSources, H.BUNDLE_COLLECT_MAX_SOURCES);
  assert.equal(options.maxBytes, H.BUNDLE_COLLECT_MAX_SOURCE_BYTES);
  assert.equal(options.timeoutMs, 100);
  assert.equal(options.useBrowserCache, true);
  for (const key of ["headers", "body", "method", "cookies", "credentials", "confirm", "tabId", "overrides"]) {
    assert.equal(Object.hasOwn(options, key), false, `options 不应含 ${key}`);
  }
  // 非法入参退化为空数组，不抛异常
  assert.deepEqual([...H.rebuildBundleCollectOptions(null).urls], []);
  assert.equal(H.rebuildBundleCollectOptions(null).useBrowserCache, true);
});

test("BundleCollect 常量与 dist 逐字一致，且不含任何请求构造入口", () => {
  assert.equal(H.MSG.BUNDLE_COLLECT, T.MSG.BUNDLE_COLLECT);
  assert.equal(H.MSG_RESULT.BUNDLE_COLLECT, T.MSG_RESULT.BUNDLE_COLLECT);
  assert.equal(H.MSG.BUNDLE_COLLECT, "apiBundleCollect");
  assert.equal(H.MSG_RESULT.BUNDLE_COLLECT, "apiBundleCollectResult");
  assert.deepEqual([...H.BUNDLE_COLLECT_VIAS], [...T.BUNDLE_COLLECT_VIAS]);
  assert.deepEqual([...H.BUNDLE_COLLECT_VIAS], ["page", "worker", "cache"]);
  const numeric = [
    "BUNDLE_COLLECT_MAX_SOURCES", "BUNDLE_COLLECT_MAX_SOURCE_BYTES",
    "BUNDLE_COLLECT_MAX_TOTAL_BYTES", "BUNDLE_COLLECT_TIMEOUT_MS",
    "BUNDLE_COLLECT_WALL_BUDGET_MS", "BUNDLE_COLLECT_DEFAULT_SOURCES",
  ];
  for (const key of numeric) assert.equal(H[key], T[key], `${key} 两端不一致`);
  assert.deepEqual([...H.BUNDLE_COLLECT_ALLOWED_KEYS], [...T.BUNDLE_COLLECT_ALLOWED_KEYS]);
  assert.deepEqual([...H.BUNDLE_COLLECT_FORBIDDEN_KEYS], [...T.BUNDLE_COLLECT_FORBIDDEN_KEYS]);
  for (const key of ["headers", "method", "body"]) {
    assert.ok(!T.BUNDLE_COLLECT_ALLOWED_KEYS.includes(key), `allowed 不应含 ${key}`);
  }
  // 配额之间必须自洽：单源 ≤ 总量，默认条数 ≤ 上限
  assert.ok(T.BUNDLE_COLLECT_MAX_SOURCE_BYTES <= T.BUNDLE_COLLECT_MAX_TOTAL_BYTES);
  assert.ok(T.BUNDLE_COLLECT_DEFAULT_SOURCES <= T.BUNDLE_COLLECT_MAX_SOURCES);
  assert.ok(T.BUNDLE_COLLECT_MAX_SOURCE_BYTES <= T.SITE_SCAN_MAX_SOURCE_BYTES);
});

// ===== B. 扩展侧（真实 background.js 装进 vm 沙箱）=====

function makeEnv(overrides = {}) {
  const state = {
    sent: [],
    pageScripts: [],
    resourceEntries: [],
    pageResponse: { ok: false },        // 层 1 默认失败
    workerResponse: { ok: false },      // 层 2 默认失败
    cacheContent: new Map(),            // 层 3 默认空
    attachCount: 0,
    detachCount: 0,
    pageFetchUrls: [],
    workerFetchUrls: [],
    denyInjection: false,
    inPage: false,
  };
  const storage = {};
  const chrome = {
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: {
        async get(keys) {
          if (keys == null) return { ...storage };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in storage) out[key] = storage[key];
          return out;
        },
        async set(obj) { Object.assign(storage, obj); },
        async remove(keys) { for (const key of [].concat(keys)) delete storage[key]; },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId !== 7) throw new Error("No tab with id");
        return { id: 7, url: PAGE_URL, active: true };
      },
      async query() { return []; },
      async create() { return { id: 7, url: PAGE_URL }; },
      async update() { return { id: 7, url: PAGE_URL }; },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {} },
    },
    tabGroups: { async get() { throw new Error("none"); }, async update() {}, async query() { return []; }, onRemoved: { addListener() {} } },
    windows: { async update() {} },
    alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
    runtime: {
      async sendMessage() {},
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (p) => `chrome-extension://mock/${p}`,
      id: "mock",
    },
    scripting: {
      async executeScript({ func, args }) {
        if (state.denyInjection) throw new Error("Cannot access contents of the page");
        // 真实环境里「页面上下文的 fetch」与「SW 的 fetch」是两套；vm 沙箱共享全局，
        // 因此用开关区分，保证三层 fallback 的顺序被测到。
        state.inPage = true;
        try {
          const result = await func(...(Array.isArray(args) ? args : []));
          return [{ result }];
        } catch {
          return [{ result: undefined }];
        } finally {
          state.inPage = false;
        }
      },
    },
    debugger: {
      async attach() { state.attachCount += 1; },
      async detach() { state.detachCount += 1; },
      async sendCommand(_target, method, params) {
        if (method === "Page.enable") return {};
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "FRAME_1", url: PAGE_URL } } };
        if (method === "Page.getResourceContent") {
          const content = state.cacheContent.get(params.url);
          return content === undefined ? {} : { content };
        }
        return {};
      },
      onEvent: { addListener() {}, removeListener() {} },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };

  // 页面环境（隔离世界）：注入函数里的 fetch/document/location/performance 都解析到这里
  // 注意 arrayBuffer() 必须返回**独立**的 ArrayBuffer（Node Buffer 的 .buffer 是共享池，
  // 直接切会带上整池长度，导致误判超配额）。
  const toArrayBuffer = (text) => {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };
  const pageFetch = async (url) => {
    state.pageFetchUrls.push(url);
    const spec = typeof state.pageResponse === "function" ? state.pageResponse(url) : state.pageResponse;
    if (!spec || spec.ok !== true) throw new Error("page fetch failed");
    return {
      ok: true,
      status: 200,
      url: spec.finalUrl || url,
      async arrayBuffer() { return toArrayBuffer(spec.text); },
    };
  };
  const workerFetch = async (url) => {
    state.workerFetchUrls.push(url);
    const spec = typeof state.workerResponse === "function" ? state.workerResponse(url) : state.workerResponse;
    if (!spec || spec.ok !== true) throw new Error("worker fetch failed");
    return {
      ok: true,
      status: 200,
      url: spec.finalUrl || url,
      async arrayBuffer() { return toArrayBuffer(spec.text); },
    };
  };

  const dispatchFetch = (url, init) => (state.inPage ? pageFetch(url, init) : workerFetch(url, init));

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, Buffer,
    AbortController, AbortSignal,
    WebSocket: class {},
    chrome,
    fetch: dispatchFetch,
    location: { href: PAGE_URL },
    document: {
      querySelectorAll: () => state.pageScripts.map((src) => ({ getAttribute: () => src })),
    },
    performance: { getEntriesByType: () => state.resourceEntries },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const hook = `
;globalThis.__bg = {
  cmdApiBundleCollect, assertCommandAllowed, get operationLogs(){ return operationLogs; }
};`;
  // helpers 与 background 拼在同一脚本作用域，等价于真实 SW 的 importScripts
  vm.runInContext(helpersSource + "\n" + backgroundSource + hook, sandbox, { filename: "background.js" });
  sandbox.sendToDaemon = (data) => { state.sent.push(data); };

  return { sandbox, state, storage };
}

const collect = async (env, options, tabId = 7) => {
  await env.sandbox.__bg.cmdApiBundleCollect({ tabId, options }, "req-1");
  return env.state.sent.at(-1);
};

test("层 1 命中页面上下文：回包 via=page，原文不进操作日志", async () => {
  const env = makeEnv();
  env.state.pageResponse = { ok: true, text: "fetch('/api/v1/orders')" };
  const reply = await collect(env, { urls: [`${PAGE_URL}/static/app.js`], hosts: HOSTS });
  assert.equal(reply.type, T.MSG_RESULT.BUNDLE_COLLECT);
  assert.equal(reply.success, true);
  assert.equal(reply.collected, 1);
  assert.equal(reply.sources[0].via, "page");
  assert.match(reply.sources[0].text, /\/api\/v1\/orders/);
  assert.equal(env.state.workerFetchUrls.length, 0, "层 1 命中后不应再走 SW");
  assert.equal(env.state.attachCount, 0, "层 1 命中后不应 attach debugger");
  // 原文只允许出现在回包；操作日志按白名单脱敏
  const logs = JSON.stringify(env.sandbox.__bg.operationLogs);
  assert.ok(!logs.includes("/api/v1/orders"), "操作日志泄了原文");
  assert.deepEqual(env.sandbox.__bg.operationLogs.at(-1).action, "apiBundleCollect");
});

test("层 1 失败退到 Service Worker：via=worker", async () => {
  const env = makeEnv();
  env.state.pageResponse = { ok: false };
  env.state.workerResponse = { ok: true, text: "axios.post('/api/v2/login')" };
  const reply = await collect(env, { urls: [`${PAGE_URL}/static/app.js`], hosts: HOSTS });
  assert.equal(reply.collected, 1);
  assert.equal(reply.sources[0].via, "worker");
  assert.equal(env.state.workerFetchUrls.length, 1);
});

test("前两层失败退到浏览器缓存：via=cache，且 attach/detach 成对", async () => {
  const env = makeEnv();
  const url = `${PAGE_URL}/static/app.js`;
  env.state.cacheContent.set(url, "fetch('/api/v3/cart')");
  const reply = await collect(env, { urls: [url], hosts: HOSTS });
  assert.equal(reply.collected, 1);
  assert.equal(reply.sources[0].via, "cache");
  assert.equal(env.state.attachCount, 1);
  assert.equal(env.state.detachCount, 1);
});

test("三层全失败：给出 failed 警示且不产生空文本条目", async () => {
  const env = makeEnv();
  const reply = await collect(env, { urls: [`${PAGE_URL}/static/app.js`], hosts: HOSTS });
  assert.equal(reply.collected, 0);
  assert.deepEqual([...reply.sources], []);
  assert.ok(reply.warnings.includes(T.BUNDLE_COLLECT_FAILED_WARNING));
});

test("useBrowserCache=false 时不 attach debugger", async () => {
  const env = makeEnv();
  const url = `${PAGE_URL}/static/app.js`;
  env.state.cacheContent.set(url, "fetch('/api/v3/cart')");
  const reply = await collect(env, { urls: [url], hosts: HOSTS, useBrowserCache: false });
  assert.equal(reply.collected, 0);
  assert.equal(env.state.attachCount, 0);
  assert.equal(env.state.detachCount, 0);
});

test("discover：只采同 host 的脚本，外域 CDN 被过滤", async () => {
  const env = makeEnv();
  env.state.pageResponse = (url) => ({ ok: true, text: `/* ${url} */ fetch('/api/v4/x')` });
  env.state.pageScripts = ["/static/app.js", "https://cdn.other.com/lib.js", "/static/vendor.js"];
  env.state.resourceEntries = [
    { name: "https://app.example.com/static/chunk.js", initiatorType: "script" },
    { name: "https://cdn.other.com/extra.js", initiatorType: "script" },
    { name: "https://app.example.com/logo.png", initiatorType: "img" },
  ];
  const reply = await collect(env, { urls: [], hosts: HOSTS, discover: true, maxSources: 10 });
  const urls = reply.sources.map((source) => source.url);
  assert.ok(urls.every((url) => new URL(url).hostname === "app.example.com"), "出现了外域 URL");
  assert.ok(urls.includes(`${ORIGIN}/static/app.js`));
  assert.ok(urls.includes(`${ORIGIN}/static/vendor.js`));
  assert.ok(urls.includes(`${ORIGIN}/static/chunk.js`));
  assert.equal(reply.discovered, 5);
});

test("maxSources 生效：超出上限的 URL 不发起采集", async () => {
  const env = makeEnv();
  env.state.pageResponse = { ok: true, text: "fetch('/api/v5/x')" };
  const urls = [1, 2, 3, 4].map((n) => `${PAGE_URL}/static/${n}.js`);
  const reply = await collect(env, { urls, hosts: HOSTS, maxSources: 2 });
  assert.equal(reply.requested, 2);
  assert.equal(reply.collected, 2);
  assert.equal(env.state.pageFetchUrls.length, 2);
});

test("单源超出 maxBytes 时截断并给出 truncated 警示", async () => {
  const env = makeEnv();
  env.state.pageResponse = { ok: true, text: "x".repeat(64 * 1024) };
  const reply = await collect(env, { urls: [`${PAGE_URL}/static/big.js`], hosts: HOSTS, maxBytes: 2048 });
  assert.equal(reply.collected, 1);
  assert.equal(reply.sources[0].bytes, 2048);
  assert.ok(reply.warnings.includes(T.BUNDLE_COLLECT_TRUNCATED_WARNING));
});

test("assertCommandAllowed：host 不在「页面自身 / 声明 hosts」时整体拒绝", async () => {
  const env = makeEnv();
  const base = {
    type: T.MSG.BUNDLE_COLLECT,
    tabId: 7,
    requestId: "req-2",
    options: { urls: ["https://evil.io/a.js"], hosts: HOSTS },
  };
  await assert.rejects(
    () => env.sandbox.__bg.assertCommandAllowed(base),
    (error) => String(error.message).startsWith("HOST_MISMATCH"),
  );
  // 页面自身 host 无需声明即可（借页面登录态的自然场景）
  await env.sandbox.__bg.assertCommandAllowed({
    ...base,
    options: { urls: [`${PAGE_URL}/static/app.js`], hosts: [] },
  });
  // 非 http(s) 一律拒绝
  await assert.rejects(
    () => env.sandbox.__bg.assertCommandAllowed({
      ...base,
      options: { urls: ["file:///etc/passwd"], hosts: [] },
    }),
    (error) => String(error.message).startsWith("INVALID_URL"),
  );
});

test("域名白名单（storage.allowedDomains）优先于页面自身 host", async () => {
  const env = makeEnv();
  env.storage.allowedDomains = ["other.example.com"];
  await assert.rejects(
    () => env.sandbox.__bg.assertCommandAllowed({
      type: T.MSG.BUNDLE_COLLECT,
      tabId: 7,
      requestId: "req-3",
      options: { urls: [`${PAGE_URL}/static/app.js`], hosts: HOSTS },
    }),
    (error) => String(error.message).startsWith("DOMAIN_NOT_ALLOWED"),
  );
});

// ===== C. 编排层：补采文本必须进入同一条扫描管线 =====

const makeService = (bundleReply) => {
  const sent = [];
  const merged = [];
  const cache = {
    async merge(_domain, commands) {
      merged.push(...commands);
      return {
        warnings: [],
        diff: { added: commands.length, updated: 0, removed: 0, skipped: 0, reviewRequired: 0 },
        preservedManualEdits: [],
        stale: [],
      };
    },
    async list() {
      return { host: "app.example.com", total: merged.length, commands: merged.slice(), stale: [] };
    },
  };
  const send = async (type, params) => {
    sent.push({ type, params });
    if (type === T.MSG.BUNDLE_COLLECT) return bundleReply(params);
    throw new Error(`unexpected message: ${type}`);
  };
  return { service: new ApiCommandService(cache, send), sent, merged };
};

test("scan_site + collectViaExtension：补采文本进入同一套 scanSources 并生成命令", async () => {
  const { service, sent, merged } = makeService(() => ({
    success: true,
    sources: [{
      url: `${ORIGIN}/static/app.js`,
      ok: true,
      text: "axios.post('/api/v1/orders', { page: 1, size: 20 })",
      via: "page",
      bytes: 56,
    }],
    requested: 1, collected: 1, discovered: 0, warnings: [],
  }));
  const report = await service.analyze({
    action: "scan_site",
    domain: "app.example.com",
    sources: [{ kind: "js", url: `${ORIGIN}/static/app.js` }],
    collectViaExtension: true,
    tabId: 7,
  });
  const call = sent.find((item) => item.type === T.MSG.BUNDLE_COLLECT);
  assert.ok(call, "未发送 apiBundleCollect");
  // options 只含白名单字段，且 hosts 来自 domain（不含任何请求构造入口）
  assert.deepEqual([...call.params.options.hosts], ["app.example.com"]);
  assert.deepEqual([...call.params.options.urls], [`${ORIGIN}/static/app.js`]);
  assert.equal(call.params.tabId, 7);
  for (const forbidden of ["headers", "method", "body", "cookies"]) {
    assert.equal(Object.hasOwn(call.params.options, forbidden), false);
  }
  // 文本确实被同一套解析消费：产物里出现 /api/v1/orders
  assert.ok(report.commandCount >= 1);
  assert.ok(merged.some((cmd) => cmd.request.urlTemplate.includes("/api/v1/orders")));
  // 静态推导纪律不变：强制复核 + 默认 write
  assert.ok(report.needsReview.length >= 1);
  assert.ok(merged.every((cmd) => cmd.risk === "write"));
});

test("扩展不可用：固定警示 + 退回直读（内联文本路径不触网）", async () => {
  const { service, sent } = makeService(() => { throw new Error("not connected"); });
  const report = await service.analyze({
    action: "scan_site",
    domain: "app.example.com",
    sources: [{ kind: "js", text: "fetch('/api/v2/items')" }],
    // 纯内联文本不会打扰扩展；只有要求自动发现时才必发消息
    discoverBundles: true,
  });
  assert.ok(sent.some((item) => item.type === T.MSG.BUNDLE_COLLECT));
  assert.ok(report.warnings.includes(T.BUNDLE_COLLECT_NO_EXTENSION_WARNING));
  assert.ok(report.commandCount >= 1);
});

test("纯内联文本 + collectViaExtension：不发扩展消息（无可取 URL）", async () => {
  const { service, sent } = makeService(() => { throw new Error("should not be called"); });
  const report = await service.analyze({
    action: "scan_site",
    domain: "app.example.com",
    sources: [{ kind: "js", text: "fetch('/api/v10/plain')" }],
    collectViaExtension: true,
  });
  assert.equal(sent.length, 0);
  assert.ok(report.commandCount >= 1);
});

test("扩展回包里的跨 host URL 被丢弃（回包不可信）", async () => {
  const { service, merged } = makeService(() => ({
    success: true,
    sources: [{
      url: "https://evil.io/static/x.js",
      ok: true,
      text: "fetch('/api/hacked')",
      via: "page",
      bytes: 20,
    }],
    requested: 0, collected: 1, discovered: 1, warnings: [],
  }));
  const report = await service.analyze({
    action: "scan_site",
    domain: "app.example.com",
    sources: [{ kind: "js", text: "fetch('/api/v9/legit')" }],
    collectViaExtension: true,
  });
  assert.ok(!merged.some((cmd) => cmd.request.urlTemplate.includes("/api/hacked")));
  assert.ok(merged.some((cmd) => cmd.request.urlTemplate.includes("/api/v9/legit")));
  assert.equal(typeof report, "object");
});

test("discoverBundles 且 sources 为空：回包文本必须进入扫描（不再「取了不用」）", async () => {
  const { service, merged } = makeService(() => ({
    success: true,
    sources: [
      { url: `${ORIGIN}/static/app.js`, ok: true, text: "axios.get('/api/v1/orders')", via: "page", bytes: 26 },
      { url: `${ORIGIN}/static/vendor.js`, ok: true, text: "fetch('/api/v2/healthz')", via: "cache", bytes: 22 },
    ],
    requested: 0, collected: 2, discovered: 2, warnings: [],
  }));
  const report = await service.analyze({
    action: "scan_site",
    domain: "app.example.com",
    discoverBundles: true,
  });
  // 真实缺陷回归：曾出现「扩展取回 2 个、扫描读取 0 个」。
  assert.equal(report.commandCount, 2, `应产出 2 条命令，实际 ${report.commandCount}；警示：${report.warnings.join(" / ")}`);
  assert.ok(merged.some((cmd) => cmd.request.urlTemplate.includes("/api/v1/orders")));
  assert.ok(merged.some((cmd) => cmd.request.urlTemplate.includes("/api/v2/healthz")));
  assert.ok(!report.warnings.includes(T.SITE_SCAN_NO_SOURCE_WARNING), "有补采文本时不应再报「未提供数据源」");
});

test("discover 补采与 sources 声明同一 URL 时不重复计入", async () => {
  const { service, merged } = makeService(() => ({
    success: true,
    sources: [
      { url: `${ORIGIN}/static/app.js`, ok: true, text: "axios.get('/api/v1/orders')", via: "page", bytes: 26 },
    ],
    requested: 1, collected: 1, discovered: 1, warnings: [],
  }));
  const report = await service.analyze({
    action: "scan_site",
    domain: "app.example.com",
    sources: [{ kind: "js", url: `${ORIGIN}/static/app.js` }],
    collectViaExtension: true,
  });
  assert.equal(report.commandCount, 1, "同一 URL 只应计入一次");
  assert.equal(merged.length, 1);
});
