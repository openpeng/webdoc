// 会话隔离与认领的回归测试：在 vm 沙箱里加载真实 background.js，用假 chrome API 驱动。
// 覆盖：实例级隔离、跨实例拦截、闲置组认领决策表、list_tabs 越权收紧、旧结构迁移、显式认领。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const BG_PATH = join(here, "..", "..", "browser-extension", "background.js");

// ===== 假 chrome API =====
function createChrome(initialStorage = {}) {
  const storage = { ...initialStorage };
  const tabs = new Map();
  const groups = new Map();
  let nextTabId = 900;
  let nextGroupId = 70;

  const listeners = { message: [], updated: [], removed: [], groupRemoved: [], alarm: [], installed: [], startup: [] };
  const noop = { addListener: fn => listeners.__push?.(fn) };

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
        const tab = { id, url: url || "about:blank", title: url || "about:blank", active: !!active, groupId: -1, windowId: 1, status: "complete", lastAccessed: Date.now() };
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
      onUpdated: { addListener: fn => listeners.updated.push(fn), removeListener: fn => { const i = listeners.updated.indexOf(fn); if (i >= 0) listeners.updated.splice(i, 1); } },
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
    debugger: { async attach() {}, async detach() {}, async sendCommand() { return {}; }, onEvent: { addListener() {}, removeListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  void noop;
  return { chrome, storage, tabs, groups, listeners };
}

// ===== 加载真实 background.js 到沙箱 =====
async function loadExtension(initialStorage = {}) {
  const mock = createChrome(initialStorage);
  const source = readFileSync(BG_PATH, "utf8");
  // 暴露模块内部状态给测试用（脚本作用域内的 let/const 在 vm 中不可从外部访问）
  const hook = `
;globalThis.__wp = {
  get activeSessionInfo(){ return activeSessionInfo; },
  get activeSessions(){ return activeSessions; },
  get sessionGroups(){ return sessionGroups; },
  get sessionLastTab(){ return sessionLastTab; },
  get gcConfig(){ return gcConfig; },
  handleDaemonMessage, handleSessionUpdate, getSessionGroups, saveSessionGroups,
  getTargetTabId, assertTabUsableBySession, addTabToSessionGroup,
  pickReclaimableGroup, liveInstanceCount, getSessionSummaries,
  cmdListTabs, cmdClaimSession, cmdGetSessionStatus, groupTitle
};`;
  const sandbox = { console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval, WebSocket: class {}, ...mock.chrome };
  sandbox.chrome = mock.chrome;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "background.js" });

  // 截获发给 daemon 的消息
  const sent = [];
  sandbox.sendToDaemon = (data) => { sent.push(data); };
  return { sandbox, sent, mock };
}

const sessionUpdate = (sandbox, instances, opts = {}) =>
  sandbox.handleSessionUpdate({
    type: "sessionUpdate",
    activeSessions: instances.map(i => i.instanceKey),
    sessions: instances,
    config: { ttlMinutes: 30, maxGroups: 5, allowCrossAgentReclaim: false, ...opts },
  });

// ===== 用例 =====

test("同一宿主下两个会话实例各自成组，默认 tab 互不串", async () => {
  const { sandbox } = await loadExtension();
  await sessionUpdate(sandbox, [
    { agentKey: "agent-1", instanceKey: "agent-1-aaa", scope: "session" },
    { agentKey: "agent-1", instanceKey: "agent-1-bbb", scope: "session" },
  ]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://a.test/", sessionId: "agent-1-aaa", agentKey: "agent-1", agentScope: "session", requestId: 1 });
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://b.test/", sessionId: "agent-1-bbb", agentKey: "agent-1", agentScope: "session", requestId: 2 });

  const groups = await sandbox.getSessionGroups();
  assert.equal(Object.keys(groups).length, 2, "两个实例应各有一个标签组");
  assert.notEqual(groups["agent-1-aaa"].groupId, groups["agent-1-bbb"].groupId);
  assert.equal(groups["agent-1-aaa"].agentKey, "agent-1");
  assert.equal(groups["agent-1-aaa"].scope, "session");

  const tabA = await sandbox.getTargetTabId(null, "agent-1-aaa");
  const tabB = await sandbox.getTargetTabId(null, "agent-1-bbb");
  assert.notEqual(tabA, tabB, "默认 tab 必须属于各自实例的组");
});

test("显式传别的实例的 tabId 被拒绝", async () => {
  const { sandbox } = await loadExtension();
  await sessionUpdate(sandbox, [
    { agentKey: "agent-1", instanceKey: "agent-1-aaa", scope: "session" },
    { agentKey: "agent-1", instanceKey: "agent-1-bbb", scope: "session" },
  ]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://a.test/", sessionId: "agent-1-aaa", agentKey: "agent-1", agentScope: "session", requestId: 1 });
  const tabA = await sandbox.getTargetTabId(null, "agent-1-aaa");
  await assert.rejects(
    () => sandbox.assertTabUsableBySession(tabA, "agent-1-bbb"),
    /another session instance/,
  );
});

test("list_tabs 只返回本实例组内的标签页", async () => {
  const { sandbox, sent } = await loadExtension();
  await sessionUpdate(sandbox, [
    { agentKey: "agent-1", instanceKey: "agent-1-aaa", scope: "session" },
    { agentKey: "agent-1", instanceKey: "agent-1-bbb", scope: "session" },
  ]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://a.test/", sessionId: "agent-1-aaa", agentKey: "agent-1", agentScope: "session", requestId: 1 });
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://b.test/", sessionId: "agent-1-bbb", agentKey: "agent-1", agentScope: "session", requestId: 2 });
  const tabA = await sandbox.getTargetTabId(null, "agent-1-aaa");
  const tabB = await sandbox.getTargetTabId(null, "agent-1-bbb");

  await sandbox.cmdListTabs(99, "agent-1-aaa");
  const result = sent.find(m => m.type === "listTabsResult");
  assert.ok(result, "应返回 listTabsResult");
  assert.ok(result.tabs.some(t => t.id === tabA), "应包含自己的标签页");
  assert.ok(!result.tabs.some(t => t.id === tabB), "不应包含别的实例的标签页");
});

test("会话级归属键：重启后认领回原组，原标签页保留", async () => {
  const { sandbox } = await loadExtension();
  await sessionUpdate(sandbox, [{ agentKey: "sess-x", instanceKey: "sess-x-111", scope: "session" }]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://x.test/", sessionId: "sess-x-111", agentKey: "sess-x", agentScope: "session", requestId: 1 });
  const tabOld = await sandbox.getTargetTabId(null, "sess-x-111");
  const groupBefore = (await sandbox.getSessionGroups())["sess-x-111"].groupId;

  // 会话退出 → 活跃列表里移除 → 组转闲置
  await sessionUpdate(sandbox, []);
  const groupsIdle = await sandbox.getSessionGroups();
  assert.equal(groupsIdle["sess-x-111"].state, "idle");

  // 重启：同归属键、新实例键
  await sessionUpdate(sandbox, [{ agentKey: "sess-x", instanceKey: "sess-x-222", scope: "session" }]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://x2.test/", sessionId: "sess-x-222", agentKey: "sess-x", agentScope: "session", requestId: 2 });
  const tabNew = await sandbox.getTargetTabId(null, "sess-x-222");

  const groups = await sandbox.getSessionGroups();
  assert.equal(Object.keys(groups).length, 1, "认领后不应新增组");
  assert.equal(groups["sess-x-222"].groupId, groupBefore, "应认领回原来的组");
  assert.ok(!groups["sess-x-111"], "旧实例键应被回收");
  assert.equal(tabNew, tabOld, "默认 tab 应落回原页面");
});

test("宿主级归属键 + 并存实例时不自动认领（安全闸门）", async () => {
  const { sandbox } = await loadExtension();
  await sessionUpdate(sandbox, [
    { agentKey: "host-1", instanceKey: "host-1-aaa", scope: "host" },
    { agentKey: "host-1", instanceKey: "host-1-bbb", scope: "host" },
  ]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://a.test/", sessionId: "host-1-aaa", agentKey: "host-1", agentScope: "host", requestId: 1 });
  const tabA = await sandbox.getTargetTabId(null, "host-1-aaa");
  await sessionUpdate(sandbox, [{ agentKey: "host-1", instanceKey: "host-1-bbb", scope: "host" }]);

  await sessionUpdate(sandbox, [
    { agentKey: "host-1", instanceKey: "host-1-bbb", scope: "host" },
    { agentKey: "host-1", instanceKey: "host-1-ccc", scope: "host" },
  ]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://c.test/", sessionId: "host-1-ccc", agentKey: "host-1", agentScope: "host", requestId: 2 });
  const tabC = await sandbox.getTargetTabId(null, "host-1-ccc");
  assert.notEqual(tabC, tabA, "归属键有歧义时不得认领他人组");
});

test("宿主级归属键 + 唯一候选时可认领", async () => {
  const { sandbox } = await loadExtension();
  await sessionUpdate(sandbox, [{ agentKey: "host-2", instanceKey: "host-2-aaa", scope: "host" }]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://a.test/", sessionId: "host-2-aaa", agentKey: "host-2", agentScope: "host", requestId: 1 });
  const tabA = await sandbox.getTargetTabId(null, "host-2-aaa");
  const groupBefore = (await sandbox.getSessionGroups())["host-2-aaa"].groupId;

  await sessionUpdate(sandbox, []); // 退出 → 闲置
  await sessionUpdate(sandbox, [{ agentKey: "host-2", instanceKey: "host-2-bbb", scope: "host" }]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://b.test/", sessionId: "host-2-bbb", agentKey: "host-2", agentScope: "host", requestId: 2 });
  const tabB = await sandbox.getTargetTabId(null, "host-2-bbb");

  const groups = await sandbox.getSessionGroups();
  assert.equal(Object.keys(groups).length, 1);
  assert.equal(groups["host-2-bbb"].groupId, groupBefore, "唯一候选时应认领");
  assert.equal(tabB, tabA);
});

test("旧结构标签组自动补齐归属键（迁移）", async () => {
  const { sandbox } = await loadExtension({
    sessionGroups: { "legacy-session": { groupId: 70, state: "active", lastActiveAt: 1, color: "blue" } },
  });
  const groups = await sandbox.getSessionGroups();
  assert.equal(groups["legacy-session"].agentKey, "legacy-session");
  assert.equal(groups["legacy-session"].scope, "legacy");
});

test("显式认领：把闲置组接管给当前会话", async () => {
  const { sandbox, sent } = await loadExtension();
  await sessionUpdate(sandbox, [{ agentKey: "sess-y", instanceKey: "sess-y-111", scope: "session" }]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://y.test/", sessionId: "sess-y-111", agentKey: "sess-y", agentScope: "session", requestId: 1 });
  const groupId = (await sandbox.getSessionGroups())["sess-y-111"].groupId;
  await sessionUpdate(sandbox, []);

  await sandbox.cmdClaimSession({ groupId }, 5, "sess-y-222");
  const result = sent.find(m => m.type === "claimSessionResult");
  assert.ok(result?.success, `认领应成功: ${JSON.stringify(result)}`);
  const groups = await sandbox.getSessionGroups();
  assert.equal(groups["sess-y-222"].groupId, groupId, "应接管目标组");
  assert.ok(!groups["sess-y-111"], "旧实例键应被回收");
});

test("显式认领：活跃组不可被抢走", async () => {
  const { sandbox, sent } = await loadExtension();
  await sessionUpdate(sandbox, [{ agentKey: "sess-z", instanceKey: "sess-z-111", scope: "session" }]);
  await sandbox.handleDaemonMessage({ type: "navigate", url: "https://z.test/", sessionId: "sess-z-111", agentKey: "sess-z", agentScope: "session", requestId: 1 });
  const groupId = (await sandbox.getSessionGroups())["sess-z-111"].groupId;
  await sandbox.cmdClaimSession({ groupId }, 6, "sess-z-222");
  const result = sent.find(m => m.type === "claimSessionResult");
  assert.ok(!result?.success, "活跃组不应被认领");
});
