// background.js — Service Worker，管理 WebSocket 连接和 CDP

const WS_URL = 'ws://localhost:8765';
const AUTO_CONNECT_ALARM = 'webpilot-auto-connect';
const AUTO_CONNECT_RETRY_MINUTES = 1;
const HEARTBEAT_INTERVAL_MS = 20_000;
const WEBPILOT_TAB_GROUP_TITLE = 'webpilot';

let ws = null;
let isConnected = false;
let connectingPromise = null;
let heartbeatTimer = null;
let managedTabs = new Set();
let webpilotTabGroupId = null;
let webpilotTabGroupQueue = Promise.resolve();
let cdpSocket = null;
let cdpTabId = null;
const MAX_OPERATION_LOGS = 100;
const operationLogs = [];
const READ_ONLY_BLOCKED_COMMANDS = new Set(['click', 'clickAt', 'type']);
const TAB_SCOPED_COMMANDS = new Set([
  'navigate', 'click', 'clickAt', 'type', 'waitFor', 'verify', 'extract',
  'getPageInfo', 'inspect', 'probeSelector', 'getPageText', 'screenshot', 'getResources'
]);

function normalizeAllowedDomains(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  return [...new Set(values.map(entry => {
    const candidate = String(entry).trim().toLowerCase();
    if (!candidate) return '';
    try { return candidate.includes('://') ? new URL(candidate).hostname : candidate.replace(/^\*\./, '').replace(/\/.*$/, ''); }
    catch { return candidate.replace(/^\*\./, '').replace(/\/.*$/, ''); }
  }).filter(Boolean))];
}

async function getSecuritySettings() {
  const stored = await chrome.storage.local.get(['allowedDomains', 'readOnlyMode', 'emergencyStopped']);
  return {
    allowedDomains: normalizeAllowedDomains(stored.allowedDomains),
    readOnlyMode: stored.readOnlyMode === true,
    emergencyStopped: stored.emergencyStopped === true
  };
}

function isUrlAllowed(url, allowedDomains) {
  if (!allowedDomains.length) return true;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function assertCommandAllowed(msg) {
  const settings = await getSecuritySettings();
  if (settings.emergencyStopped) throw new Error('WebPilot has been stopped locally. Re-enable it from the extension popup before continuing.');
  if (settings.readOnlyMode && READ_ONLY_BLOCKED_COMMANDS.has(msg.type)) throw new Error(`Blocked by read-only mode: ${msg.type}`);
  if (!settings.allowedDomains.length || !TAB_SCOPED_COMMANDS.has(msg.type)) return;
  const tab = msg.type === 'navigate'
    ? null
    : await chrome.tabs.get(await getTargetTabId(msg.tabId));
  const url = msg.type === 'navigate' ? msg.url : tab?.url;
  if (!isUrlAllowed(url, settings.allowedDomains)) throw new Error(`Blocked by domain allowlist: ${url || 'unknown URL'}`);
}

// ===== WebSocket 客户端 =====
function connectWebSocket(url = WS_URL) {
  if (ws?.readyState === WebSocket.OPEN && isConnected) {
    return Promise.resolve({ success: true, alreadyConnected: true });
  }
  if (connectingPromise) return connectingPromise;

  // Retire a socket that is still connecting or has become stale. Its guarded
  // callbacks cannot clear the state of the new connection.
  if (ws) {
    const staleSocket = ws;
    ws = null;
    try { staleSocket.close(); } catch { /* already closed */ }
  }

  const socket = new WebSocket(url);
  ws = socket;
  const attempt = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    socket.onopen = () => {
      if (ws !== socket) {
        socket.close();
        settle(reject, { success: false, error: 'Connection was superseded by a newer attempt' });
        return;
      }
      isConnected = true;
      startHeartbeat(socket);
      broadcastStatus(true, url);
      console.log('[WebPilot] WebSocket connected:', url);
      settle(resolve, { success: true });
    };

    socket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await handleDaemonMessage(msg);
      } catch (e) {
        console.error('[WebPilot] Parse message error:', e);
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      stopHeartbeat();
      isConnected = false;
      ws = null;
      broadcastStatus(false, null, '连接已关闭');
      scheduleAutoConnect();
      console.log('[WebPilot] WebSocket disconnected');
    };

    socket.onerror = (err) => {
      console.error('[WebPilot] WebSocket error:', err);
      settle(reject, { success: false, error: `无法连接到 ${url}，请确认 MCP 服务已启动` });
    };

    // 5秒超时
    setTimeout(() => {
      if (ws === socket && !isConnected) {
        try { socket.close(); } catch { /* already closed */ }
        settle(reject, { success: false, error: '连接超时，请确认 MCP 服务已启动' });
      }
    }, 5000);
  });

  let trackedAttempt;
  trackedAttempt = attempt.finally(() => {
    if (connectingPromise === trackedAttempt) connectingPromise = null;
  });
  connectingPromise = trackedAttempt;
  return connectingPromise;
}

function startHeartbeat(socket) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'heartbeat' }));
    } catch {
      socket.close();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function isAutoConnectEnabled() {
  const { autoConnectEnabled } = await chrome.storage.local.get('autoConnectEnabled');
  // Existing users get automatic reconnection without opening the popup once.
  return autoConnectEnabled !== false;
}

async function scheduleAutoConnect() {
  if (!(await isAutoConnectEnabled()) || isConnected) return;
  await chrome.alarms.create(AUTO_CONNECT_ALARM, {
    delayInMinutes: AUTO_CONNECT_RETRY_MINUTES,
    periodInMinutes: AUTO_CONNECT_RETRY_MINUTES
  });
}

async function tryAutoConnect() {
  if (!(await isAutoConnectEnabled()) || isConnected) return;
  try {
    await connectWebSocket();
    await chrome.alarms.clear(AUTO_CONNECT_ALARM);
  } catch {
    // The persistent alarm retries after the local MCP process becomes ready.
  }
}

function disconnectWebSocket() {
  const socket = ws;
  ws = null;
  stopHeartbeat();
  if (socket) socket.close();
  isConnected = false;
  managedTabs.clear();
  webpilotTabGroupId = null;
  cdpSocket = null;
  cdpTabId = null;
  broadcastStatus(false);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { autoConnectEnabled } = await chrome.storage.local.get('autoConnectEnabled');
  if (autoConnectEnabled === undefined) await chrome.storage.local.set({ autoConnectEnabled: true });
  await restoreManagedTabs();
  await tryAutoConnect();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreManagedTabs();
  void tryAutoConnect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_CONNECT_ALARM) void tryAutoConnect();
});

// A click can trigger a navigation without an explicit navigate command. For
// tabs WebPilot has taken over, stop such cross-domain redirects at the edge.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!managedTabs.has(tabId) || !changeInfo.url) return;
  const { allowedDomains } = await getSecuritySettings();
  if (!allowedDomains.length || isUrlAllowed(changeInfo.url, allowedDomains)) return;
  managedTabs.delete(tabId);
  logOperation({ action: 'navigation', tabId, success: false, error: `Blocked by domain allowlist: ${changeInfo.url}`, policyBlocked: true });
  await chrome.tabs.update(tabId, { url: 'about:blank' });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!managedTabs.delete(tabId)) return;
  chrome.runtime.sendMessage({ type: 'tabCountChange', count: managedTabs.size }).catch(() => {});
});

chrome.tabGroups.onRemoved.addListener((group) => {
  if (group.id === webpilotTabGroupId) webpilotTabGroupId = null;
});

// 向所有监听者广播状态变化
function broadcastStatus(connected, wsUrl, reason) {
  chrome.runtime.sendMessage({
    type: 'statusChange',
    connected,
    wsUrl,
    reason,
    tabCount: managedTabs.size
  }).catch(() => {});
}

// ===== 处理 Daemon 发来的指令 =====
async function handleDaemonMessage(msg) {
  console.log('[WebPilot] Daemon msg:', msg.type);

  try {
    await assertCommandAllowed(msg);
    if (TAB_SCOPED_COMMANDS.has(msg.type) && msg.type !== 'navigate') {
      await markTabAsManaged(await getTargetTabId(msg.tabId));
    }
  } catch (error) {
    logOperation({ action: msg.type, tabId: msg.tabId, success: false, error: error.message, policyBlocked: true });
    sendToDaemon({ type: 'error', requestId: msg.requestId, success: false, error: error.message });
    return;
  }

  switch (msg.type) {
    case 'navigate':
      await cmdNavigate(msg.url, msg.tabId, msg.requestId);
      break;
    case 'click':
      await cmdClick(msg.selector, msg.tabId, msg.requestId, msg.timeoutMs);
      break;
    case 'clickAt':
      await cmdClickAt(msg.x, msg.y, msg.tabId, msg.requestId);
      break;
    case 'type':
      await cmdType(msg.selector, msg.text, msg.tabId, msg.requestId, msg.timeoutMs);
      break;
    case 'waitFor':
      await cmdWaitFor(msg.selector, msg.tabId, msg.requestId, msg.state, msg.timeoutMs, msg.stableMs);
      break;
    case 'verify':
      await cmdVerify(msg.assertion, msg.tabId, msg.requestId);
      break;
    case 'extract':
      await cmdExtract(msg.spec, msg.tabId, msg.requestId);
      break;
    case 'getPageInfo':
      await cmdGetPageInfo(msg.tabId, msg.requestId);
      break;
    case 'inspect':
      await cmdInspect(msg.options, msg.tabId, msg.requestId);
      break;
    case 'probeSelector':
      await cmdProbeSelector(msg.selector, msg.tabId, msg.requestId);
      break;
    case 'getPageText':
      await cmdGetPageText(msg.tabId, msg.maxChars, msg.requestId);
      break;
    case 'getResources':
      await cmdGetResources(msg.options, msg.tabId, msg.requestId);
      break;
    case 'screenshot':
      await cmdScreenshot(msg.tabId, msg.requestId);
      break;
    case 'listTabs':
      await cmdListTabs(msg.requestId);
      break;
    case 'getOperationLog':
      await cmdGetOperationLog(msg.requestId);
      break;
    default:
      sendToDaemon({ type: 'error', requestId: msg.requestId, error: `Unknown command: ${msg.type}` });
  }
}

// ===== CDP 操作封装 =====
async function getTargetTabId(tabId) {
  if (tabId) return tabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function findWebPilotTabGroup() {
  if (typeof webpilotTabGroupId === 'number') {
    try {
      const group = await chrome.tabGroups.get(webpilotTabGroupId);
      if (group.title === WEBPILOT_TAB_GROUP_TITLE) return group;
    } catch {
      // The group may have been closed or moved while the service worker slept.
    }
    webpilotTabGroupId = null;
  }

  const groups = await chrome.tabGroups.query({ title: WEBPILOT_TAB_GROUP_TITLE });
  const group = groups.sort((left, right) => left.id - right.id)[0];
  if (group) webpilotTabGroupId = group.id;
  return group || null;
}

async function addTabToWebPilotGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let group = await findWebPilotTabGroup();

  // Chrome tab groups are scoped to one window. Keep a single WebPilot group
  // by moving a tool-managed tab into the window that owns the existing group.
  if (group && group.windowId !== tab.windowId) {
    await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
  }

  const groupId = group
    ? await chrome.tabs.group({ tabIds: [tabId], groupId: group.id })
    : await chrome.tabs.group({ tabIds: [tabId] });

  if (!group) await chrome.tabGroups.update(groupId, { title: WEBPILOT_TAB_GROUP_TITLE });
  webpilotTabGroupId = groupId;
  return groupId;
}

function markTabAsManaged(tabId) {
  if (!tabId) throw new Error('No active tab');
  managedTabs.add(tabId);
  // Commands arrive serially from the bridge most of the time, but this queue
  // also prevents simultaneous commands from creating duplicate tab groups.
  const queued = webpilotTabGroupQueue.then(() => addTabToWebPilotGroup(tabId));
  webpilotTabGroupQueue = queued.catch(() => {});
  return queued;
}

async function restoreManagedTabs() {
  const group = await findWebPilotTabGroup();
  if (!group) return;
  const tabs = await chrome.tabs.query({ groupId: group.id });
  for (const tab of tabs) managedTabs.add(tab.id);
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (callback, value) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      callback(value);
    };
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(resolve, tab);
    };
    const timeout = setTimeout(() => finish(reject, new Error(`Navigation did not finish within ${timeoutMs}ms`)), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish(resolve, tab);
    }).catch(error => finish(reject, error));
  });
}

function logOperation(entry) {
  operationLogs.push({ timestamp: new Date().toISOString(), ...entry });
  if (operationLogs.length > MAX_OPERATION_LOGS) operationLogs.shift();
}

async function callPageTool(tabId, method, args = []) {
  if (!tabId) throw new Error('No active tab');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page-tools.js'] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (toolMethod, toolArgs) => {
      if (!globalThis.__webpilot?.[toolMethod]) throw new Error(`Page tool is unavailable: ${toolMethod}`);
      return await globalThis.__webpilot[toolMethod](...toolArgs);
    },
    args: [method, args]
  });
  return result.result;
}

async function cmdNavigate(url, tabId, requestId) {
  const startedAt = Date.now();
  const targetTab = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!targetTab) {
    sendToDaemon({ type: 'navigateResult', requestId, success: false, error: 'No active tab' });
    return;
  }
  try {
    // Mark before navigation so an immediate server-side redirect is covered by
    // the allowlist listener as well.
    await markTabAsManaged(targetTab);
    const tab = await chrome.tabs.update(targetTab, { url });
    const loadedTab = await waitForTabLoad(tab.id);
    await markTabAsManaged(tab.id);
    chrome.runtime.sendMessage({ type: 'tabCountChange', count: managedTabs.size }).catch(()=>{});
    const result = { success: true, tabId: tab.id, url: loadedTab.url, title: loadedTab.title, diagnostics: { durationMs: Date.now() - startedAt } };
    logOperation({ action: 'navigate', tabId: tab.id, url, success: true, durationMs: result.diagnostics.durationMs });
    sendToDaemon({ type: 'navigateResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'navigate', tabId: targetTab, url, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'navigateResult', requestId, success: false, error: e.message });
  }
}

async function cmdClick(selector, tabId, requestId, timeoutMs) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'click', [selector, timeoutMs]);
    result.diagnostics = { ...result.diagnostics, durationMs: Date.now() - startedAt };
    logOperation({ action: 'click', tabId: target, selector, success: result.success, error: result.error, durationMs: result.diagnostics.durationMs });
    sendToDaemon({ type: 'clickResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'click', tabId: target, selector, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'clickResult', requestId, success: false, error: e.message });
  }
}

async function cmdType(selector, text, tabId, requestId, timeoutMs) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'fill', [selector, text, timeoutMs]);
    result.diagnostics = { ...result.diagnostics, durationMs: Date.now() - startedAt };
    logOperation({ action: 'type', tabId: target, selector, success: result.success, error: result.error, durationMs: result.diagnostics.durationMs });
    sendToDaemon({ type: 'typeResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'type', tabId: target, selector, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'typeResult', requestId, success: false, error: e.message });
  }
}

async function cmdClickAt(x, y, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'clickAt', [x, y]);
    result.diagnostics = { ...result.diagnostics, durationMs: Date.now() - startedAt };
    logOperation({ action: 'click_at', tabId: target, x, y, success: result.success, error: result.error, durationMs: result.diagnostics.durationMs });
    sendToDaemon({ type: 'clickAtResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'click_at', tabId: target, x, y, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'clickAtResult', requestId, success: false, error: e.message });
  }
}

async function cmdWaitFor(selector, tabId, requestId, state, timeoutMs, stableMs) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'waitFor', [selector, state, timeoutMs, stableMs]);
    result.diagnostics = { ...result.diagnostics, durationMs: Date.now() - startedAt };
    logOperation({ action: 'wait_for', tabId: target, selector, state, success: result.success, error: result.error, durationMs: result.diagnostics.durationMs });
    sendToDaemon({ type: 'waitForResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'wait_for', tabId: target, selector, state, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'waitForResult', requestId, success: false, error: e.message });
  }
}

async function cmdVerify(assertion, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'verify', [assertion]);
    logOperation({ action: 'verify', tabId: target, assertion: assertion?.kind, success: result.pass === true });
    sendToDaemon({ type: 'verifyResult', requestId, success: true, ...result });
  } catch (e) {
    logOperation({ action: 'verify', tabId: target, assertion: assertion?.kind, success: false, error: e.message });
    sendToDaemon({ type: 'verifyResult', requestId, success: false, error: e.message });
  }
}

async function cmdExtract(spec, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'extract', [spec]);
    logOperation({ action: 'extract', tabId: target, success: true });
    sendToDaemon({ type: 'extractResult', requestId, success: true, ...result });
  } catch (e) {
    logOperation({ action: 'extract', tabId: target, success: false, error: e.message });
    sendToDaemon({ type: 'extractResult', requestId, success: false, error: e.message });
  }
}

async function cmdGetPageInfo(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'page');
    sendToDaemon({ type: 'pageInfoResult', requestId, success: true, ...result });
  } catch (e) {
    sendToDaemon({ type: 'pageInfoResult', requestId, success: false, error: e.message });
  }
}

async function cmdInspect(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'inspect', [options || {}]);
    logOperation({ action: 'inspect', tabId: target, scope: options?.scope || 'page', success: true });
    sendToDaemon({ type: 'inspectResult', requestId, success: true, ...result });
  } catch (e) {
    logOperation({ action: 'inspect', tabId: target, success: false, error: e.message });
    sendToDaemon({ type: 'inspectResult', requestId, success: false, error: e.message });
  }
}

async function cmdProbeSelector(selector, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'probe', [selector]);
    logOperation({ action: 'probe_selector', tabId: target, selector, success: result.matched === true });
    sendToDaemon({ type: 'probeSelectorResult', requestId, success: true, ...result });
  } catch (e) {
    logOperation({ action: 'probe_selector', tabId: target, selector, success: false, error: e.message });
    sendToDaemon({ type: 'probeSelectorResult', requestId, success: false, error: e.message });
  }
}

async function cmdGetPageText(tabId, maxChars, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'readText', [maxChars]);
    sendToDaemon({ type: 'pageTextResult', requestId, success: true, ...result });
  } catch (e) {
    sendToDaemon({ type: 'pageTextResult', requestId, success: false, error: e.message });
  }
}

async function cmdGetResources(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'getResourceList', [options || {}]);
    logOperation({ action: 'getResources', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'getResourcesResult', requestId, success: true, ...result });
  } catch (e) {
    logOperation({ action: 'getResources', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'getResourcesResult', requestId, success: false, error: e.message });
  }
}

async function cmdScreenshot(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    // 转为 base64 字符串
    const base64 = dataUrl.split(',')[1];
    sendToDaemon({ type: 'screenshotResult', requestId, success: true, data: base64, format: 'png' });
  } catch (e) {
    sendToDaemon({ type: 'screenshotResult', requestId, success: false, error: e.message });
  }
}

async function cmdListTabs(requestId) {
  const tabs = await chrome.tabs.query({});
  const { allowedDomains } = await getSecuritySettings();
  const visibleTabs = allowedDomains.length ? tabs.filter(tab => isUrlAllowed(tab.url, allowedDomains)) : tabs;
  sendToDaemon({
    type: 'listTabsResult',
    requestId,
    success: true,
    tabs: visibleTabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
  });
}

async function cmdGetOperationLog(requestId) {
  sendToDaemon({ type: 'operationLogResult', requestId, success: true, entries: operationLogs });
}

function sendToDaemon(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ===== Message Router =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    getSecuritySettings().then(security => sendResponse({ connected: isConnected, wsUrl: WS_URL, tabCount: managedTabs.size, security }));
    return true;
  }
  if (msg.type === 'getSecuritySettings') {
    getSecuritySettings().then(sendResponse);
    return true;
  }
  if (msg.type === 'saveSecuritySettings') {
    const allowedDomains = normalizeAllowedDomains(msg.allowedDomains);
    chrome.storage.local.set({ allowedDomains, readOnlyMode: msg.readOnlyMode === true })
      .then(() => sendResponse({ success: true, allowedDomains, readOnlyMode: msg.readOnlyMode === true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (msg.type === 'emergencyStop') {
    chrome.storage.local.set({ emergencyStopped: true, autoConnectEnabled: false })
      .then(() => chrome.alarms.clear(AUTO_CONNECT_ALARM))
      .then(() => {
        disconnectWebSocket();
        sendResponse({ success: true });
      });
    return true;
  }
  if (msg.type === 'connect') {
    chrome.storage.local.set({ autoConnectEnabled: true, emergencyStopped: false })
      .then(() => connectWebSocket(msg.wsUrl || WS_URL))
      .then(r => sendResponse(r))
      .catch(e => sendResponse(e));
    return true; // async
  }
  if (msg.type === 'disconnect') {
    chrome.storage.local.set({ autoConnectEnabled: false });
    chrome.alarms.clear(AUTO_CONNECT_ALARM);
    disconnectWebSocket();
    sendResponse({ success: true });
    return true;
  }
});
