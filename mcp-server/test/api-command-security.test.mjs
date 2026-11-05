// 独立安全验证（本次最高价值）：用 vm 沙箱加载真实 helpers.js + background.js，
// stub fetch/chrome/WebSocket，直接 dispatch 消息，用断言证明安全边界真的生效。
// 覆盖 AC-06/07/12/20/21/22/23/24 + 并发/analysisId/schema 漂移等错误路径。
// 注意：这是**逻辑级**验证，不是真实 Chrome 扩展 E2E（见最终报告「需浏览器实测」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";
import { generateCommands } from "../dist/api-command-generator.js";
import {
  MSG, MSG_RESULT, ERROR_SAFE_MESSAGES, LOG_STRIP_KEYS, API_LOG_ALLOWED_KEYS,
  EXECUTE_OPTIONS_FORBIDDEN_KEYS, API_COMMAND_ALLOWED_HEADERS,
  MISSING_SAMPLE_REVIEW_REASON, GENERATED_BY,
} from "../dist/api-command-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const BG_PATH = join(here, "..", "..", "browser-extension", "background.js");
const HELPERS_PATH = join(here, "..", "..", "browser-extension", "api-command-helpers.js");
const bgSource = readFileSync(BG_PATH, "utf8");
const helpersSource = readFileSync(HELPERS_PATH, "utf8");
const DOMAIN = "api.example.com";
const URL_OK = `https://${DOMAIN}/v1/users/42`;

// ===== 假 chrome API（沿用 session-isolation.test.mjs 的范式，去掉无关分支）=====
function createChrome(initialStorage = {}) {
  const storage = { ...initialStorage };
  const tabs = new Map();
  const groups = new Map();
  let nextTabId = 900;
  let nextGroupId = 70;
  const listeners = { message: [], updated: [], removed: [], groupRemoved: [], alarm: [], installed: [], startup: [] };
  const chrome = {
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: {
        async get(keys) {
          if (keys == null) return { ...storage };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in storage) out[k] = storage[k];
          return out;
        },
        async set(obj) { Object.assign(storage, obj); },
        async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k]; },
      },
    },
    tabs: {
      async query(info = {}) {
        let list = [...tabs.values()];
        if (typeof info.groupId === "number") list = list.filter(t => t.groupId === info.groupId);
        if (info.active === true) list = list.filter(t => t.active);
        return list.map(t => ({ ...t }));
      },
      async get(tabId) {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        return { ...t };
      },
      async create({ url, active }) {
        const id = nextTabId++;
        const tab = { id, url: url || "about:blank", title: url || "about:blank",
          active: !!active, groupId: -1, windowId: 1, status: "complete", lastAccessed: Date.now() };
        tabs.set(id, tab);
        return { ...tab };
      },
      async update(tabId, props) {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        Object.assign(t, props, { status: "complete", title: props.url || t.title });
        return { ...t };
      },
      async move(tabId, props) { const t = tabs.get(tabId); Object.assign(t, props); return { ...t }; },
      async group({ tabIds, groupId }) {
        let gid = groupId;
        if (gid == null) { gid = nextGroupId++; groups.set(gid, { id: gid, windowId: 1, title: "", color: "blue", collapsed: false }); }
        if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: 1, title: "", color: "blue", collapsed: false });
        for (const id of tabIds) { const t = tabs.get(id); if (t) { t.groupId = gid; t.windowId = groups.get(gid).windowId; } }
        return gid;
      },
      async remove(tabIds) { for (const id of [].concat(tabIds)) tabs.delete(id); },
      async sendMessage() { return []; },
      onUpdated: { addListener: fn => listeners.updated.push(fn), removeListener() {} },
      onRemoved: { addListener: fn => listeners.removed.push(fn) },
    },
    tabGroups: {
      async get(groupId) { const g = groups.get(groupId); if (!g) throw new Error(`Invalid group id: ${groupId}`); return { ...g }; },
      async update(groupId, props) { const g = groups.get(groupId); if (!g) throw new Error(`Invalid group id: ${groupId}`); Object.assign(g, props); return { ...g }; },
      async query() { return [...groups.values()].map(g => ({ ...g })); },
      onRemoved: { addListener: fn => listeners.groupRemoved.push(fn) },
    },
    windows: { async update() {} },
    alarms: { async create() {}, async clear() {}, onAlarm: { addListener: fn => listeners.alarm.push(fn) } },
    runtime: {
      async sendMessage() { return undefined; },
      onMessage: { addListener: fn => listeners.message.push(fn) },
      onInstalled: { addListener: fn => listeners.installed.push(fn) },
      onStartup: { addListener: fn => listeners.startup.push(fn) },
      getURL: p => `chrome-extension://mock/${p}`,
      id: "mock",
    },
    scripting: { async executeScript() { return [{ result: null }]; } },
    debugger: {
      async attach() {}, async detach() {}, async sendCommand() { return {}; },
      onEvent: { addListener() {}, removeListener() {} },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  return { chrome, storage, tabs, groups, listeners };
}

const okResponse = (overrides = {}) => ({
  type: "basic", status: 200, ok: true, statusText: "OK",
  headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "application/json" : "" },
  text: async () => JSON.stringify({ ok: true, code: 0 }),
  ...overrides,
});

/**
 * 在 vm 中加载真实扩展源码。关键：先在 createContext 之后注入 importScripts，
 * 让 background.js 顶部的 typeof 守卫真正把 helpers.js 加载进同一词法环境（只加载一次）。
 */
function loadExtension({ initialStorage = {}, fetchImpl } = {}) {
  const mock = createChrome(initialStorage);
  const sent = [];
  const fetchCalls = [];
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: class { static OPEN = 1; },
    URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, atob, btoa,
    AbortController, AbortSignal, crypto: globalThis.crypto,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return fetchImpl ? fetchImpl(url, init, fetchCalls) : okResponse();
    },
    ...mock.chrome,
  };
  sandbox.chrome = mock.chrome;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = () => vm.runInContext(helpersSource, sandbox, { filename: "api-command-helpers.js" });

  const hook = `;globalThis.__wp = {
    get operationLogs(){ return operationLogs; },
    get apiAnalysisSessions(){ return apiAnalysisSessions; },
    get networkCaptures(){ return networkCaptures; },
    handleDaemonMessage, dispatchCommand, getSecuritySettings, assertCommandAllowed,
    assertApiTargetUrl, rebuildExecuteOptions, rebuildStartOptions, rebuildStopOptions,
    safeLogForApiExecute, isSampleCandidate, decodeCdpResponseBody,
    apiRedactHeaderNames, formatApiError, apiNormalizeHostname,
    MSG, MSG_RESULT, API_ERROR_CODES, ERROR_SAFE_MESSAGES,
    API_EXECUTION_TYPES, TAB_SCOPED_COMMANDS, MAX_CONCURRENT_ANALYSES,
    EXECUTE_OPTIONS_ALLOWED_KEYS, EXECUTE_OPTIONS_FORBIDDEN_KEYS,
    LOG_STRIP_KEYS, API_LOG_ALLOWED_KEYS, API_COMMAND_ALLOWED_HEADERS
  };`;
  vm.runInContext(bgSource + hook, sandbox, { filename: "background.js" });
  sandbox.sendToDaemon = (data) => { sent.push(data); };
  return { sandbox, sent, mock, fetchCalls };
}

const executeMsg = (options = {}, overrides = {}) => ({
  type: MSG.COMMAND_EXECUTE,
  requestId: 1,
  sessionId: "qa-session",
  options: {
    url: URL_OK, method: "GET", hostname: DOMAIN, risk: "read",
    body: null, maxBodyChars: 50000, timeoutMs: 10000,
    ...options,
  },
  ...overrides,
});
const lastReply = (sent) => sent[sent.length - 1];

// ===== MCP 侧夹具：真实缓存 + 真实服务，只替换会发扩展消息的 sendFn =====
const baseRec = (overrides = {}) => ({
  requestId: "r1", host: DOMAIN, method: "GET", path: "/v1/users/42",
  pathSegments: ["v1", "users", "42"], queryPairs: [], bodyFields: [],
  bodyIsJson: false, status: 200, mimeType: "application/json",
  resourceType: "xhr", timestamp: 1, headerNames: [],
  ...overrides,
});
const generatedCommands = () => generateCommands([
  { method: "GET", pathTemplate: "/v1/users/{id}", pathParams: ["id"], host: DOMAIN,
    records: [baseRec()] },
], { domain: DOMAIN, analysisId: "an_sec", generatedBy: GENERATED_BY,
     schema: new Map(), now: "2026-01-01T00:00:00.000Z" }).commands;

async function makeCache(t, commands) {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-sec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "api-commands.json");
  const cache = new ApiCommandCache(file);
  const list = commands || generatedCommands();
  await cache.merge(DOMAIN, list, { mode: "full", overwriteManual: false });
  return { cache, commands: list, file };
}

// ---------------------------------------------------------------------------
// A. 扩展侧逻辑级验证
// ---------------------------------------------------------------------------

test("A.1 免开网页：0 抓包缓冲区、0 标签页，命令仍走到 fetch 且参数正确（AC-06 核心证据）", async () => {
  const { sandbox, sent, fetchCalls, mock } = loadExtension();
  assert.equal(sandbox.__wp.networkCaptures.size, 0, "不设置任何抓包缓冲区");
  assert.equal(mock.tabs.size, 0, "不打开任何页面");
  assert.equal(sandbox.__wp.TAB_SCOPED_COMMANDS.has(MSG.COMMAND_EXECUTE), false,
    "apiCommandExecute 不得加入 TAB_SCOPED_COMMANDS");

  await sandbox.handleDaemonMessage(executeMsg());
  assert.equal(fetchCalls.length, 1, "必须真正走到 fetch");
  assert.equal(fetchCalls[0].url, URL_OK);
  assert.equal(fetchCalls[0].init.method, "GET");
  const reply = sent.find((m) => m.type === MSG_RESULT.COMMAND_EXECUTE);
  assert.ok(reply, "应返回 apiCommandExecuteResult");
  assert.equal(reply.success, true);
  assert.equal(reply.status, 200);
  assert.equal(reply.requestId, 1);
  assert.equal(reply.authRequired, false);
  assert.equal(sandbox.__wp.networkCaptures.size, 0, "执行不得创建抓包会话");
});

test("A.2 fetch 带 credentials:'include' 与 redirect:'manual'，header 只有最小白名单（AC-07/23）", async () => {
  const { sandbox, fetchCalls } = loadExtension();
  await sandbox.handleDaemonMessage(executeMsg());
  const init = fetchCalls[0].init;
  assert.equal(init.credentials, "include");
  assert.equal(init.redirect, "manual");
  assert.deepEqual(Object.keys(init.headers), ["Accept"]);
  assert.equal(init.headers.Accept, "application/json");
  assert.ok(!JSON.stringify(init.headers).includes("Authorization"));
  assert.ok(!JSON.stringify(init.headers).includes("Cookie"));

  const withBody = loadExtension();
  await withBody.sandbox.handleDaemonMessage(executeMsg({ body: "{\"page\":1}" }));
  assert.deepEqual(Object.keys(withBody.fetchCalls[0].init.headers).sort(), ["Accept", "Content-Type"]);
  assert.equal(withBody.fetchCalls[0].init.headers["Content-Type"], "application/json");
  assert.equal(withBody.fetchCalls[0].init.body, "{\"page\":1}");
  assert.deepEqual([...withBody.sandbox.__wp.API_COMMAND_ALLOWED_HEADERS].sort(),
    [...API_COMMAND_ALLOWED_HEADERS].sort());
});

test("A.3 EXECUTE_OPTIONS_FORBIDDEN_KEYS 生效：headers/confirm/overrides/tabId 全部被丢弃", async () => {
  const injected = {
    headers: { Authorization: "SECRET_AUTH_VALUE", Cookie: "SECRET_COOKIE_VALUE" },
    confirm: true,
    overrides: { url: "https://evil.test/x", risk: "read" },
    tabId: 999,
    unknownInject: "SHOULD_BE_DROPPED",
  };
  const { sandbox, sent, fetchCalls } = loadExtension();
  const msg = executeMsg(injected);
  const rebuilt = JSON.parse(JSON.stringify(sandbox.__wp.rebuildExecuteOptions(msg.options)));
  for (const key of EXECUTE_OPTIONS_FORBIDDEN_KEYS) {
    assert.equal(Object.hasOwn(rebuilt, key), false, `rebuildExecuteOptions 泄漏 ${key}`);
  }
  assert.equal(Object.hasOwn(rebuilt, "unknownInject"), false);
  assert.equal(rebuilt.url, URL_OK);
  assert.equal(rebuilt.risk, "read");

  await sandbox.handleDaemonMessage(msg);
  assert.equal(fetchCalls.length, 1);
  const init = fetchCalls[0].init;
  for (const key of ["confirm", "overrides", "tabId", "headers"]) {
    if (key !== "headers") assert.equal(Object.hasOwn(init, key), false, `fetch 入参泄漏 ${key}`);
  }
  assert.ok(!JSON.stringify(init.headers).includes("SECRET_AUTH_VALUE"));
  assert.ok(!JSON.stringify(init.headers).includes("SECRET_COOKIE_VALUE"));
  assert.deepEqual(Object.keys(init.headers), ["Accept"]);
  const reply = sent.find((m) => m.type === MSG_RESULT.COMMAND_EXECUTE);
  assert.ok(reply, "注入字段不应导致执行失败");
});

test("A.3b 放开后：非凭据请求头原样下发，凭据头（Cookie / Authorization 等）一律剔除（AC-06/22）", async () => {
  const injected = {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://example.com/",
      Cookie: "SECRET_COOKIE_VALUE",
      Authorization: "SECRET_AUTH_VALUE",
      "Proxy-Authorization": "SECRET_PROXY_VALUE",
      "Set-Cookie": "SECRET_SETCOOKIE_VALUE",
    },
  };
  const { sandbox, sent, fetchCalls } = loadExtension();
  const msg = executeMsg(injected);
  const rebuilt = JSON.parse(JSON.stringify(sandbox.__wp.rebuildExecuteOptions(msg.options)));
  assert.equal(rebuilt.headers["X-Requested-With"], "XMLHttpRequest", "非凭据头必须保留");
  assert.equal(rebuilt.headers.Referer, "https://example.com/");
  for (const secret of ["Cookie", "Authorization", "Proxy-Authorization", "Set-Cookie"]) {
    assert.equal(Object.hasOwn(rebuilt.headers, secret), false, `凭据头必须剔除：${secret}`);
  }

  await sandbox.handleDaemonMessage(msg);
  assert.equal(fetchCalls.length, 1);
  const init = fetchCalls[0].init;
  assert.equal(init.headers["X-Requested-With"], "XMLHttpRequest", "请求头必须真的进 fetch");
  assert.equal(init.headers.Referer, "https://example.com/");
  for (const secret of ["SECRET_COOKIE_VALUE", "SECRET_AUTH_VALUE", "SECRET_PROXY_VALUE", "SECRET_SETCOOKIE_VALUE"]) {
    assert.ok(!JSON.stringify(init.headers).includes(secret), `凭据值不得进 fetch：${secret}`);
  }
  const reply = sent.find((m) => m.type === MSG_RESULT.COMMAND_EXECUTE);
  assert.ok(reply, "请求头放开不应导致执行失败");
});

test("A.4 只读模式不可绕过：risk=write + confirm:true 仍 READ_ONLY_BLOCKED，fetch 调用 0 次（AC-22）", async () => {  const { sandbox, sent, fetchCalls } = loadExtension({ initialStorage: { readOnlyMode: true } });
  await sandbox.handleDaemonMessage(executeMsg(
    { risk: "write", method: "POST", body: "{}", confirm: true },
    { confirm: true },
  ));
  assert.equal(fetchCalls.length, 0, "confirm:true 不能越过本地只读边界");
  const reply = lastReply(sent);
  assert.equal(reply.type, "error");
  assert.equal(reply.success, false);
  assert.ok(reply.error.includes("READ_ONLY_BLOCKED"), `实际: ${reply.error}`);
  assert.ok(reply.error.includes(ERROR_SAFE_MESSAGES.READ_ONLY_BLOCKED));

  // read 命令在只读模式下应放行
  const readOnlyRead = loadExtension({ initialStorage: { readOnlyMode: true } });
  await readOnlyRead.sandbox.handleDaemonMessage(executeMsg({ risk: "read" }));
  assert.equal(readOnlyRead.fetchCalls.length, 1);
});

test("T7：只读门按 method 派生 —— risk=read 但 method=POST 仍被拒（AC-12）", async () => {
  // 客户端自述 risk=read、方法却是 POST：只读边界必须按 method 判定，不能被自述字段绕过。
  const { sandbox, sent, fetchCalls } = loadExtension({ initialStorage: { readOnlyMode: true } });
  await sandbox.handleDaemonMessage(executeMsg({ risk: "read", method: "POST", body: "{}" }));
  assert.equal(fetchCalls.length, 0, "只读模式下 POST 不得发出任何请求");
  const reply = lastReply(sent);
  assert.equal(reply.type, "error");
  assert.equal(reply.success, false);
  assert.ok(reply.error.includes("READ_ONLY_BLOCKED"), `实际: ${reply.error}`);

  // 其余写方法同样按 method 拦下
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const blocked = loadExtension({ initialStorage: { readOnlyMode: true } });
    await blocked.sandbox.handleDaemonMessage(executeMsg({ risk: "read", method, body: "{}" }));
    assert.equal(blocked.fetchCalls.length, 0, `${method} 在只读模式下必须被拦下`);
    assert.ok(lastReply(blocked.sent).error.includes("READ_ONLY_BLOCKED"));
  }

  // method 缺失 / 非法 → fail-closed，一律按写操作拦下
  for (const method of ["", undefined, "TRACE", "GETT"]) {
    const blocked = loadExtension({ initialStorage: { readOnlyMode: true } });
    await blocked.sandbox.handleDaemonMessage(executeMsg({ risk: "read", method }));
    assert.equal(blocked.fetchCalls.length, 0, `method=${String(method)} 必须 fail-closed`);
    assert.ok(lastReply(blocked.sent).error.includes("READ_ONLY_BLOCKED"));
  }

  // 只读安全方法仍然放行（GET / HEAD / OPTIONS）
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const allowed = loadExtension({ initialStorage: { readOnlyMode: true } });
    await allowed.sandbox.handleDaemonMessage(executeMsg({ risk: "read", method }));
    assert.equal(allowed.fetchCalls.length, 1, `${method} 在只读模式下应放行`);
  }
});

test("A.5 目标 URL 白名单：跨 host / 非 http(s) / 白名单外域名 / overrides 跨 host（AC-23）", async () => {
  // 跨 host（url 与命令 hostname 不一致）
  const crossHost = loadExtension();
  await crossHost.sandbox.handleDaemonMessage(executeMsg({ url: "https://evil.test/x" }));
  assert.equal(crossHost.fetchCalls.length, 0);
  assert.ok(lastReply(crossHost.sent).error.includes("HOST_MISMATCH"));

  // 非 http(s) 协议
  const badProtocol = loadExtension();
  await badProtocol.sandbox.handleDaemonMessage(executeMsg({ url: "javascript:alert(1)" }));
  assert.equal(badProtocol.fetchCalls.length, 0);
  assert.ok(lastReply(badProtocol.sent).error.includes("INVALID_URL"));

  // 白名单外域名（url 与 hostname 一致，但不在 allowedDomains）
  const outside = loadExtension({ initialStorage: { allowedDomains: ["allowed.test"] } });
  await outside.sandbox.handleDaemonMessage(executeMsg());
  assert.equal(outside.fetchCalls.length, 0);
  assert.ok(lastReply(outside.sent).error.includes("DOMAIN_NOT_ALLOWED"));

  // 白名单内域名放行
  const inside = loadExtension({ initialStorage: { allowedDomains: [DOMAIN] } });
  await inside.sandbox.handleDaemonMessage(executeMsg());
  assert.equal(inside.fetchCalls.length, 1);

  // overrides.url 试图把请求导向外域 → 被白名单重建丢弃，实际请求仍是原 URL
  const override = loadExtension();
  await override.sandbox.handleDaemonMessage(executeMsg({ overrides: { url: "https://evil.test/x" } }));
  assert.equal(override.fetchCalls.length, 1);
  assert.equal(override.fetchCalls[0].url, URL_OK);
  assert.ok(!override.fetchCalls[0].url.includes("evil.test"));
});

test("A.6 重定向 fail-closed：opaqueredirect / status 0 / 302 全部 REDIRECT_BLOCKED 且无第二次请求（AC-23）", async () => {
  const variants = [
    okResponse({ type: "opaqueredirect", status: 0, ok: false }),
    okResponse({ type: "basic", status: 0, ok: false }),
    okResponse({ type: "basic", status: 302, ok: false, statusText: "Found" }),
  ];
  for (const response of variants) {
    const ext = loadExtension({ fetchImpl: async () => response });
    await ext.sandbox.handleDaemonMessage(executeMsg());
    assert.equal(ext.fetchCalls.length, 1, "不得发出第二次请求（不跟随重定向）");
    const reply = lastReply(ext.sent);
    assert.equal(reply.success, false);
    assert.ok(reply.error.includes("REDIRECT_BLOCKED"), `实际回包: ${JSON.stringify(reply)}`);
    assert.equal(reply.errorCode, "REDIRECT_BLOCKED");
  }
});

test("A.7 401/403 → AUTH_REQUIRED 且不计连续失败；紧急停止拒绝全部消息（AC-07/19/22）", async (t) => {
  for (const status of [401, 403]) {
    const ext = loadExtension({
      fetchImpl: async () => okResponse({
        status, ok: false, statusText: "Unauthorized",
        text: async () => "{\"needLogin\":true}",
      }),
    });
    await ext.sandbox.handleDaemonMessage(executeMsg());
    const reply = ext.sent.find((m) => m.type === MSG_RESULT.COMMAND_EXECUTE);
    assert.ok(reply, "传输层回包仍应到达（业务状态由 status 表达）");
    assert.equal(reply.status, status);
    assert.equal(reply.authRequired, true);
    assert.equal(reply.errorCode, "AUTH_REQUIRED");

    // 把扩展回包喂给真实 MCP 服务层，用 report() 证明「不禁用、不计连续失败」
    const { cache, commands } = await makeCache(t);
    const service = new ApiCommandService(cache, async () => reply);
    const result = await service.call({ domain: DOMAIN, commandId: commands[0].commandId,
      params: { id: "42" } });
    assert.equal(result.error.code, "AUTH_REQUIRED");
    assert.equal(result.authRequired, true);
    const report = await cache.report(DOMAIN);
    assert.equal(report.perCommand[0].consecutiveFailures, 0);
    assert.equal(report.perCommand[0].disabled, false);
    assert.equal(report.perCommand[0].misses, 0);
  }

  // 紧急停止：execute 与 navigate 均被拒
  const stopped = loadExtension({ initialStorage: { emergencyStopped: true } });
  await stopped.sandbox.handleDaemonMessage(executeMsg());
  assert.equal(stopped.fetchCalls.length, 0);
  assert.ok(/stopped locally/i.test(lastReply(stopped.sent).error));
  await stopped.sandbox.handleDaemonMessage({
    type: "navigate", url: `https://${DOMAIN}/`, requestId: 2, sessionId: "qa-session",
  });
  assert.ok(!stopped.sent.some((m) => m.type === "navigateResult" && m.success));
  assert.ok(stopped.sent.filter((m) => m.type === "error").length >= 2);
});

test("A.8 safeLogForApiExecute + LOG_STRIP_KEYS：日志与回包检索不到 body/params/headers 的值（AC-20）", async () => {
  const secrets = [
    "SECRET_BODY_VALUE_11", "SECRET_PARAMS_VALUE_22", "SECRET_HEADERS_VALUE_33",
    "SECRET_SAMPLES_VALUE_44", "SECRET_RECORDS_VALUE_55", "SECRET_POSTDATA_VALUE_66",
    "SECRET_QUERYPARAMS_VALUE_77", "SECRET_TEXT_VALUE_88", "SECRET_SCRIPT_VALUE_99",
  ];
  const { sandbox, sent, fetchCalls } = loadExtension();
  const msg = executeMsg({
    body: JSON.stringify({ token: secrets[0] }),
    params: { p: secrets[1] },
    headers: { Authorization: secrets[2], Cookie: secrets[2] },
    samples: [secrets[3]], records: [secrets[4]], postData: secrets[5],
    queryParams: secrets[6], text: secrets[7], script: secrets[8],
  });
  await sandbox.handleDaemonMessage(msg);
  assert.equal(fetchCalls.length, 1);

  const logsText = JSON.stringify(sandbox.__wp.operationLogs);
  const repliesText = JSON.stringify(sent);
  for (const secret of secrets) {
    assert.ok(!logsText.includes(secret), `操作日志泄漏 ${secret}`);
    assert.ok(!repliesText.includes(secret), `回包泄漏 ${secret}`);
  }
  assert.ok(!JSON.stringify(fetchCalls[0].init.headers).includes(secrets[2]),
    "敏感 header 值不得进入 fetch");
  // 逐字 parity：扩展侧日志剥离集合与 dist 一致
  assert.deepEqual([...sandbox.__wp.LOG_STRIP_KEYS], [...LOG_STRIP_KEYS]);
  assert.deepEqual([...sandbox.__wp.API_LOG_ALLOWED_KEYS], [...API_LOG_ALLOWED_KEYS]);
  // safeLogForApiExecute 只保留允许键
  const safe = JSON.parse(JSON.stringify(sandbox.__wp.safeLogForApiExecute({
    action: "apiCommandExecute", commandId: "cmd_8f3a1c2d90", method: "GET",
    hostname: DOMAIN, risk: "read",
    status: 200, success: true, durationMs: 3,
    body: secrets[0], params: secrets[1], headers: secrets[2],
    url: "https://x.test/?token=SECRET_URL_VALUE",
  })));
  assert.deepEqual(Object.keys(safe).sort(), [...API_LOG_ALLOWED_KEYS].sort());
  assert.ok(!JSON.stringify(safe).includes("SECRET_URL_VALUE"));
  assert.equal(Object.hasOwn(safe, "body"), false);
});

test("A.9 helpers 纯 helper 逻辑级验证：白名单重建 / 采样候选 / CDP 解码 / 目标 URL 断言", () => {
  const { sandbox } = loadExtension();
  const H = sandbox.__wp;

  // rebuildStartOptions / rebuildStopOptions：注入字段一律丢弃
  const start = JSON.parse(JSON.stringify(H.rebuildStartOptions({
    analysisId: "an_1", includeStaticAssets: true, maxEndpoints: 999,
    captureResponseBody: true, confirm: true, headers: { Authorization: "SECRET" },
    filter: { urlContains: "abc", mimeType: "json", bad: "drop" },
  })));
  assert.deepEqual(start, {
    analysisId: "an_1", includeStaticAssets: true, maxEndpoints: 200,
    captureResponseBody: true, filter: { urlContains: "abc", mimeType: "json" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(H.rebuildStopOptions({
    analysisId: "an_2", confirm: true, records: ["SECRET"],
  }))), { analysisId: "an_2" });

  // isSampleCandidate：只看元数据，不读响应体
  assert.equal(H.isSampleCandidate({ type: "XHR", mimeType: "application/json", status: 200 }), true);
  assert.equal(H.isSampleCandidate({ type: "fetch", mimeType: "text/plain", status: 204 }), true);
  assert.equal(H.isSampleCandidate({ type: "Image", mimeType: "application/json", status: 200 }), false);
  assert.equal(H.isSampleCandidate({ type: "xhr", mimeType: "application/octet-stream", status: 200 }), false);
  assert.equal(H.isSampleCandidate({ type: "xhr", mimeType: "application/json", status: 404 }), false);
  assert.equal(H.isSampleCandidate(null), false);

  // decodeCdpResponseBody：64KB 上限 + base64 解码
  assert.equal(H.decodeCdpResponseBody({ body: "{\"ok\":true}", base64Encoded: false }), "{\"ok\":true}");
  assert.equal(H.decodeCdpResponseBody({ body: btoa("{\"ok\":true}"), base64Encoded: true }), "{\"ok\":true}");
  assert.equal(H.decodeCdpResponseBody({ body: "x".repeat(70000), base64Encoded: false }), null);
  assert.equal(H.decodeCdpResponseBody({ body: "!!!not-base64!!!", base64Encoded: true }), null);
  assert.equal(H.decodeCdpResponseBody(null), null);

  // assertApiTargetUrl：协议 / 精确 host / 白名单
  assert.doesNotThrow(() => H.assertApiTargetUrl("https://a.test/x", "a.test", ["a.test"]));
  assert.throws(() => H.assertApiTargetUrl("https://b.test/x", "a.test", ["a.test"]), /HOST_MISMATCH/);
  assert.throws(() => H.assertApiTargetUrl("file:///etc/passwd", "a.test", []), /INVALID_URL/);
  assert.throws(() => H.assertApiTargetUrl("https://evil.test/x", "evil.test", ["a.test"]), /DOMAIN_NOT_ALLOWED/);
  assert.throws(() => H.assertApiTargetUrl("not a url", "a.test", []), /INVALID_URL/);
  assert.equal(H.formatApiError("HOST_MISMATCH"),
    `HOST_MISMATCH|${ERROR_SAFE_MESSAGES.HOST_MISMATCH}`);
  assert.deepEqual(JSON.parse(JSON.stringify(H.apiRedactHeaderNames(["Authorization", "Accept"]))),
    ["authorization"]);
});

// ---------------------------------------------------------------------------
// B. 零网络请求与自动加载
// ---------------------------------------------------------------------------

test("B autoLoadSummary：sendFn 会抛异常也不被调用，返回命令摘要（AC-12 零网络请求）", async (t) => {
  const { cache, commands } = await makeCache(t);
  let calls = 0;
  const explodingSend = async () => {
    calls += 1;
    throw new Error("autoLoadSummary 不得发送任何扩展消息");
  };
  const service = new ApiCommandService(cache, explodingSend);
  // 若 autoLoadSummary 调用了 sendFn（会抛异常），本行会直接让用例失败
  const summary = await service.autoLoadSummary(DOMAIN);
  assert.equal(calls, 0, "只推荐不执行，零网络请求");
  assert.equal(summary.length, 1);
  assert.equal(summary[0].commandId, commands[0].commandId);
  assert.equal(summary[0].available, true);
  assert.equal(summary[0].manuallyEdited, false);
  assert.equal(summary[0].risk, "read");
  // 其余纯本地入口同样零网络
  await service.list({ domain: DOMAIN });
  await service.cacheReport(DOMAIN);
  await service.get({ domain: DOMAIN, commandId: commands[0].commandId });
  assert.equal(calls, 0);
  assert.deepEqual(await service.autoLoadSummary(""), []);
});

// ---------------------------------------------------------------------------
// D. 边界与错误路径（独立验证，不只 happy path）
// ---------------------------------------------------------------------------

test("D.1 空样本 / 非 JSON 响应体：分析管线不崩溃，产物零样本值且强制 needsReview", async (t) => {
  const { cache, file } = await makeCache(t);
  const headerValue = "SECRET_HEADER_VALUE_D1";
  const records = [{
    requestId: "r1", url: `https://${DOMAIN}/v1/users?page=1`, method: "GET",
    host: DOMAIN, path: "/v1/users", query: "page=1", status: 200,
    mimeType: "application/json", resourceType: "XHR", timestamp: 1,
    headerNames: ["authorization", "cookie"],
    headers: { Authorization: headerValue }, // 混入原值也绝不进入产物
    postData: null, hasPostData: false,
  }];
  const emptySend = async () => ({ records: [], samples: [], warnings: [], analysisId: "an_empty" });
  const emptyService = new ApiCommandService(cache, emptySend);
  const emptyReport = await emptyService.analyze({ action: "stop_and_analyze", domain: DOMAIN });
  assert.equal(emptyReport.commandCount, 0);
  assert.equal(emptyReport.endpointCount, 0);
  assert.ok(emptyReport.warnings.some((w) => w.includes("未捕获到任何网络请求")));

  const dirtySample = "SECRET_SAMPLE_HTML_D1";
  const service = new ApiCommandService(cache, async () => ({
    records,
    samples: [{ requestId: "r1", contentType: "text/html", status: 200,
      bodyText: `<html>${dirtySample}</html>`, truncated: false }],
    warnings: [], analysisId: "an_dirty",
  }));
  const report = await service.analyze({ action: "stop_and_analyze", domain: DOMAIN });
  assert.equal(report.commandCount, 1);
  assert.equal(report.sampledResponseCount, 1);
  assert.ok(report.needsReview.some((r) => r.reason === MISSING_SAMPLE_REVIEW_REASON));
  const reportText = JSON.stringify(report);
  assert.ok(!reportText.includes(dirtySample), "分析报告泄漏响应样本值");
  assert.ok(!reportText.includes(headerValue), "分析报告泄漏 header 值");
  assert.ok(!reportText.includes("page=1"), "分析报告不得回显真实 URL query");
  assert.deepEqual(report.redactedHeaders, ["authorization", "cookie"]);
  const cacheText = await readFile(file, "utf8");
  assert.ok(!cacheText.includes(dirtySample), "缓存文件泄漏响应样本值");
  assert.ok(!cacheText.includes(headerValue), "缓存文件泄漏 header 值");
});

test("D.2 并发分析上限与 analysisId 不匹配：返回 ANALYSIS_IN_PROGRESS / NO_ANALYSIS_SESSION", async () => {
  const ext = loadExtension();
  const startMsg = (i, tabId) => ({
    type: MSG.ANALYSIS_START, requestId: 100 + i, sessionId: "qa-session", tabId,
    options: { analysisId: `an_${i}`, includeStaticAssets: false,
      maxEndpoints: 20, captureResponseBody: false },
  });
  const startAt = (i, tabId) => ext.sandbox.dispatchCommand(startMsg(i, tabId), "qa-session");
  await startAt(0, 501);
  await startAt(1, 502);
  await startAt(2, 503);
  assert.equal(ext.sandbox.__wp.apiAnalysisSessions.size, 3);
  assert.equal(ext.sandbox.__wp.MAX_CONCURRENT_ANALYSES, 3);
  await startAt(3, 504); // 超过 MAX_CONCURRENT_ANALYSES=3
  assert.equal(ext.sandbox.__wp.apiAnalysisSessions.size, 3, "不得超过全局并发上限");
  assert.ok(ext.sent.some((m) => String(m.error).includes("ANALYSIS_IN_PROGRESS")));
  // 同 tab 重复 start 同样拒绝
  await startAt(4, 501);
  assert.ok(ext.sent.filter((m) => String(m.error).includes("ANALYSIS_IN_PROGRESS")).length >= 2);

  const mismatched = loadExtension();
  await mismatched.sandbox.dispatchCommand({
    type: MSG.ANALYSIS_STOP, requestId: 9, sessionId: "qa-session", tabId: 777,
    options: { analysisId: "an_does_not_exist" },
  }, "qa-session");
  assert.ok(mismatched.sent.some((m) => String(m.error).includes("NO_ANALYSIS_SESSION")));
});

test("D.3 schema 漂移：只标 drifted 不自动禁用，回包带固定文案（AC-19）", async (t) => {
  const [base] = generatedCommands();
  const withSchema = JSON.parse(JSON.stringify(base));
  withSchema.responseSchema = {
    fields: [{ path: "code", type: "number", array: false, isPagination: false, redacted: false }],
    depthLimited: false, sampleCount: 1,
  };
  withSchema.responseFields = ["code"];
  const { cache, commands } = await makeCache(t, [withSchema]);
  const service = new ApiCommandService(cache, async () => ({
    success: true, status: 200, contentType: "application/json",
    body: { code: "now-a-string" }, durationMs: 3, truncated: false,
  }));
  const result = await service.call({ domain: DOMAIN, commandId: commands[0].commandId,
    params: { id: "42" } });
  assert.equal(result.error, undefined, "漂移不得阻断返回");
  assert.ok(result.warnings.some((w) => w.includes(ERROR_SAFE_MESSAGES.DRIFTED)));
  const stored = await cache.get(DOMAIN, { commandId: commands[0].commandId });
  assert.ok(stored, "漂移绝不自动禁用命令");
  assert.equal(stored.health.drifted, true);
  assert.equal(stored.health.disabled, false);
  assert.equal(stored.health.consecutiveFailures, 0);
});

test("D.4 参数名注入 / __proto__ / constructor：INVALID_PARAMS 且零网络，不污染原型", async (t) => {
  const { cache, commands } = await makeCache(t);
  let calls = 0;
  const service = new ApiCommandService(cache, async () => {
    calls += 1;
    return okResponse();
  });
  const injected = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true},"id":"42","headers":"SECRET_INJECT"}');
  const result = await service.call({ domain: DOMAIN, commandId: commands[0].commandId,
    params: injected });
  assert.equal(result.error.code, "INVALID_PARAMS");
  assert.equal(calls, 0, "非法参数不得发出任何请求");
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal({}.constructor, Object);
  // path 注入同样零网络
  const unsafe = await service.call({ domain: DOMAIN, commandId: commands[0].commandId,
    params: { id: "../evil" } });
  assert.equal(unsafe.error.code, "UNSAFE_PATH_PARAM");
  assert.equal(calls, 0);
});

test("D.5 空响应 / 超大响应 / 超长字段：服务层裁剪与截断不崩溃", async (t) => {
  const { cache, commands } = await makeCache(t);
  const id = commands[0].commandId;
  const empty = new ApiCommandService(cache, async () => ({
    success: true, status: 200, body: null, durationMs: 1,
  }));
  assert.equal((await empty.call({ domain: DOMAIN, commandId: id, params: { id: "42" } })).error, undefined);

  const huge = new ApiCommandService(cache, async () => ({
    success: true, status: 200, contentType: "application/json",
    body: { blob: "Z".repeat(200000) }, durationMs: 1, truncated: false,
  }));
  const bigResult = await huge.call({ domain: DOMAIN, commandId: id,
    params: { id: "42" }, fields: ["blob"], maxBodyChars: 1000 });
  assert.equal(bigResult.truncated, true);
  assert.equal(bigResult.error, undefined);
  assert.equal(typeof bigResult.data, "string");
  assert.ok(String(bigResult.data).length <= 1000);

  // 命令禁用后 call 返回 COMMAND_DISABLED，且零网络
  await cache.invalidate(DOMAIN, { commandId: id, action: "disable" });
  let calls = 0;
  const blocked = new ApiCommandService(cache, async () => { calls += 1; return okResponse(); });
  const disabled = await blocked.call({ domain: DOMAIN, commandId: id, params: { id: "42" } });
  assert.equal(disabled.error.code, "COMMAND_DISABLED");
  assert.equal(calls, 0);
});

test("T7：invalidate_api_commands 的 action 缺失或非法 → INVALID_PARAMS，且命令不被删除（AC-10）", async (t) => {
  const { cache, commands } = await makeCache(t);
  const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });

  // 基线行为：非法 action 被兜底成 clear_domain，整个域名的命令集一次抹光。
  for (const action of ["", "clear", "CLEAR_DOMAIN", "drop", "disable ", undefined, null]) {
    await assert.rejects(
      () => service.invalidate({ domain: DOMAIN, commandId: commands[0].commandId, action }),
      (err) => {
        assert.equal(err.code, "INVALID_PARAMS", `action=${String(action)} 必须报 INVALID_PARAMS`);
        return true;
      },
      `action=${String(action)} 必须被拒绝`,
    );
  }

  // 关键：一条命令都不能被删掉
  const listed = await cache.list(DOMAIN);
  assert.equal(listed.total, 1, "非法 action 不得删除任何命令");
  const report = await cache.report(DOMAIN);
  assert.equal(report.domains.length, 1);
  assert.equal(report.domains[0].commandCount, 1, "非法 action 不得整域删除");
  const still = await cache.get(DOMAIN, { commandId: commands[0].commandId });
  assert.ok(still, "命令必须仍在缓存中");

  // 合法 action 仍然正常工作
  const ok = await service.invalidate({ domain: DOMAIN, commandId: commands[0].commandId, action: "disable" });
  assert.equal(ok.affected, 1);
  assert.equal(ok.remaining, 1);
});
