// background.js — Service Worker，管理 WebSocket 连接和 CDP

const WS_URL = 'ws://localhost:8765';
const AUTO_CONNECT_ALARM = 'webpilot-auto-connect';
const AUTO_CONNECT_RETRY_MINUTES = 1;
const HEARTBEAT_INTERVAL_MS = 20_000;
const SESSION_GROUP_PREFIX = 'WebPilot';
const DEFAULT_SESSION_ID = 'default';
const GROUP_GC_ALARM = 'webpilot-group-gc';
const GROUP_GC_PERIOD_MINUTES = 5;
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const DEFAULT_GROUP_TTL_MINUTES = 30;
const DEFAULT_MAX_GROUPS = 5;
// 必须前台可见的命令：captureVisibleTab / 视口坐标点击，受全局前台锁保护
const FOREGROUND_COMMANDS = new Set(['screenshot', 'clickAt']);

let ws = null;
let isConnected = false;
let connectingPromise = null;
let heartbeatTimer = null;
let managedTabs = new Set();
// sessionId -> { groupId, state: 'active'|'idle', lastActiveAt, color }，持久化到 storage.local
let sessionGroups = null;
let sessionGroupsLoading = null;
const sessionGroupQueues = new Map(); // sessionId -> promise 链，防止并发重复建组
const sessionLastTab = new Map();     // sessionId -> 组内最近使用的 tabId
let activeSessions = new Set();       // Leader 下发的活跃 sessionId 列表
let gcConfig = { ttlMinutes: DEFAULT_GROUP_TTL_MINUTES, maxGroups: DEFAULT_MAX_GROUPS };
const tabQueues = new Map();          // tabId -> promise 链（同 tab 串行）
let foregroundLock = Promise.resolve(); // 全局前台互斥锁
let cdpSocket = null;
let cdpTabId = null;
const MAX_OPERATION_LOGS = 100;
const operationLogs = [];
const READ_ONLY_BLOCKED_COMMANDS = new Set(['click', 'clickAt', 'type']);
// CDP Network capture state: per-tab buffers of captured resources
const networkCaptures = new Map(); // tabId -> { resources: [], active: boolean, filter: object }
const TAB_SCOPED_COMMANDS = new Set([
  'navigate', 'click', 'clickAt', 'type', 'waitFor', 'verify', 'extract',
  'getPageInfo', 'inspect', 'probeSelector', 'getPageText', 'screenshot', 'getResources',
  'evaluate', 'extractTable', 'startNetworkCapture', 'stopNetworkCapture', 'getNetworkResources',
  'hover', 'pressKey', 'scroll', 'selectOption', 'dragDrop', 'waitForDynamic', 'iframeAction',
  'uploadFile', 'handleDialog', 'downloadFile',
  'reload', 'goBackForward', 'getURL', 'fullPageScreenshot', 'elementScreenshot',
  'getConsoleLogs', 'shadowDomAction', 'setViewport', 'setUserAgent',
  'savePDF', 'setGeolocation', 'setNetworkThrottle', 'setTimezone',
  'getCookies', 'setCookie', 'deleteCookie', 'getAllCookies',
  'webmcpGetTools', 'webmcpExecuteTool', 'webmcpHealth',
  'probeCapabilities'
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
  // msg.tabId 已在 handleDaemonMessage 中解析为本 session 的具体 tab
  const tab = msg.type === 'navigate' ? null : await chrome.tabs.get(msg.tabId);
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
  cdpSocket = null;
  cdpTabId = null;
  // Stop all network captures
  for (const [tabId, capture] of networkCaptures) {
    capture.active = false;
    try { chrome.debugger.detach({ tabId }); } catch { /* not attached */ }
  }
  networkCaptures.clear();
  broadcastStatus(false);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { autoConnectEnabled } = await chrome.storage.local.get('autoConnectEnabled');
  if (autoConnectEnabled === undefined) await chrome.storage.local.set({ autoConnectEnabled: true });
  await ensureGroupGcAlarm();
  await restoreManagedTabs();
  await tryAutoConnect();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureGroupGcAlarm();
  void restoreManagedTabs();
  void tryAutoConnect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_CONNECT_ALARM) void tryAutoConnect();
  if (alarm.name === GROUP_GC_ALARM) void runGroupGc();
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
  tabQueues.delete(tabId);
  for (const [sessionId, lastTab] of sessionLastTab) {
    if (lastTab === tabId) sessionLastTab.delete(sessionId);
  }
  if (!managedTabs.delete(tabId)) return;
  chrome.runtime.sendMessage({ type: 'tabCountChange', count: managedTabs.size }).catch(() => {});
});

// 组被用户手动关闭时同步清理 session 映射
chrome.tabGroups.onRemoved.addListener(async (group) => {
  const groups = await getSessionGroups();
  let changed = false;
  for (const sessionId of Object.keys(groups)) {
    if (groups[sessionId].groupId === group.id) {
      delete groups[sessionId];
      sessionLastTab.delete(sessionId);
      changed = true;
    }
  }
  if (changed) await saveSessionGroups();
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
  console.log('[WebPilot] Daemon msg:', msg.type, msg.sessionId ? `(session ${String(msg.sessionId).slice(0, 8)})` : '');

  // Leader 推送的活跃会话列表（无 requestId，单向）
  if (msg.type === 'sessionUpdate') {
    await handleSessionUpdate(msg);
    return;
  }

  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : DEFAULT_SESSION_ID;
  let targetTabId = null;
  try {
    if (TAB_SCOPED_COMMANDS.has(msg.type)) {
      // 默认 tab = 本 session 组内最近使用的 tab；显式 tabId 做跨组校验
      targetTabId = await getTargetTabId(msg.tabId, sessionId);
      msg.tabId = targetTabId;
    }
    await assertCommandAllowed(msg);
    if (targetTabId !== null && msg.type !== 'navigate') {
      await markTabAsManaged(targetTabId, sessionId);
    }
  } catch (error) {
    logOperation({ action: msg.type, tabId: msg.tabId, success: false, error: error.message, policyBlocked: true });
    sendToDaemon({ type: 'error', requestId: msg.requestId, success: false, error: error.message });
    return;
  }

  if (targetTabId === null) {
    await dispatchCommand(msg, sessionId);
    return;
  }

  sessionLastTab.set(sessionId, targetTabId);
  // 同 tab 串行；不同 tab（含跨 session 组）并行；前台命令再套全局前台锁
  await enqueueOnTab(targetTabId, () => FOREGROUND_COMMANDS.has(msg.type)
    ? runWithForegroundLock(targetTabId, () => dispatchCommand(msg, sessionId))
    : dispatchCommand(msg, sessionId));
}

async function dispatchCommand(msg, sessionId) {
  switch (msg.type) {
    case 'navigate':
      await cmdNavigate(msg.url, msg.tabId, msg.requestId, sessionId);
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
      await cmdGetPageInfo(msg.tabId, msg.requestId, msg.structure);
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
    case 'evaluate':
      await cmdEvaluate(msg.expression, msg.options, msg.tabId, msg.requestId);
      break;
    case 'extractTable':
      await cmdExtractTable(msg.spec, msg.tabId, msg.requestId);
      break;
    case 'startNetworkCapture':
      await cmdStartNetworkCapture(msg.filter, msg.tabId, msg.requestId);
      break;
    case 'stopNetworkCapture':
      await cmdStopNetworkCapture(msg.tabId, msg.requestId);
      break;
    case 'getNetworkResources':
      await cmdGetNetworkResources(msg.options, msg.tabId, msg.requestId);
      break;
    
    case 'replayApiRequest':
      await cmdReplayApiRequest(msg.options, msg.tabId, msg.requestId);
      break;
    case 'hover':
      await cmdHover(msg.selector, msg.tabId, msg.requestId);
      break;
    case 'pressKey':
      await cmdPressKey(msg.selector, msg.key, msg.tabId, msg.requestId);
      break;
    case 'scroll':
      await cmdScroll(msg.options, msg.tabId, msg.requestId);
      break;
    case 'selectOption':
      await cmdSelectOption(msg.selector, msg.value, msg.options, msg.tabId, msg.requestId);
      break;
    case 'dragDrop':
      await cmdDragDrop(msg.fromSelector, msg.toSelector, msg.tabId, msg.requestId);
      break;
    case 'waitForDynamic':
      await cmdWaitForDynamic(msg.options, msg.tabId, msg.requestId);
      break;
    case 'iframeAction':
      await cmdIframeAction(msg.options, msg.tabId, msg.requestId);
      break;
    case 'uploadFile':
      await cmdUploadFile(msg.selector, msg.filePath, msg.tabId, msg.requestId);
      break;
    case 'handleDialog':
      await cmdHandleDialog(msg.action, msg.tabId, msg.requestId);
      break;
    case 'downloadFile':
      await cmdDownloadFile(msg.url, msg.filename, msg.tabId, msg.requestId);
      break;
    case 'reload':
      await cmdReload(msg.bypassCache, msg.tabId, msg.requestId);
      break;
    case 'goBackForward':
      await cmdGoBackForward(msg.direction, msg.tabId, msg.requestId);
      break;
    case 'getURL':
      await cmdGetURL(msg.tabId, msg.requestId);
      break;
    case 'fullPageScreenshot':
      await cmdFullPageScreenshot(msg.tabId, msg.requestId);
      break;
    case 'elementScreenshot':
      await cmdElementScreenshot(msg.selector, msg.tabId, msg.requestId);
      break;
    case 'getConsoleLogs':
      await cmdGetConsoleLogs(msg.options, msg.tabId, msg.requestId);
      break;
    case 'shadowDomAction':
      await cmdShadowDomAction(msg.options, msg.tabId, msg.requestId);
      break;
    case 'setViewport':
      await cmdSetViewport(msg.options, msg.tabId, msg.requestId);
      break;
    case 'setUserAgent':
      await cmdSetUserAgent(msg.userAgent, msg.tabId, msg.requestId);
      break;
    case 'savePDF':
      await cmdSavePDF(msg.options, msg.filename, msg.tabId, msg.requestId);
      break;
    case 'setGeolocation':
      await cmdSetGeolocation(msg.options, msg.tabId, msg.requestId);
      break;
    case 'setNetworkThrottle':
      await cmdSetNetworkThrottle(msg.options, msg.tabId, msg.requestId);
      break;
    case 'setTimezone':
      await cmdSetTimezone(msg.timezone, msg.tabId, msg.requestId);
      break;
    case 'getCookies':
      await cmdGetCookies(msg.options, msg.tabId, msg.requestId);
      break;
    case 'getAllCookies':
      await cmdGetAllCookies(msg.tabId, msg.requestId);
      break;
    case 'setCookie':
      await cmdSetCookie(msg.details, msg.tabId, msg.requestId);
      break;
    case 'deleteCookie':
      await cmdDeleteCookie(msg.details, msg.tabId, msg.requestId);
      break;
    case 'webmcpGetTools':
      await cmdWebmcpGetTools(msg.tabId, msg.requestId);
      break;
    case 'webmcpExecuteTool':
      await cmdWebmcpExecuteTool(msg.toolName, msg.input, msg.tabId, msg.requestId);
      break;
    case 'webmcpHealth':
      await cmdWebmcpHealth(msg.tabId, msg.requestId);
      break;
    case 'probeCapabilities':
      await cmdProbeCapabilities(msg.tabId, msg.requestId);
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
    case 'cleanupSessions':
      await cmdCleanupSessions(msg.options, msg.requestId);
      break;
    default:
      sendToDaemon({ type: 'error', requestId: msg.requestId, error: `Unknown command: ${msg.type}` });
  }
}

// ===== 会话标签组：一个 agent = 一个标签组 =====
async function getSessionGroups() {
  if (sessionGroups) return sessionGroups;
  if (!sessionGroupsLoading) {
    // service worker 休眠/浏览器重启后从 storage.local 恢复映射
    sessionGroupsLoading = chrome.storage.local.get(['sessionGroups', 'gcConfig']).then(stored => {
      if (!sessionGroups) sessionGroups = stored.sessionGroups || {};
      if (stored.gcConfig) gcConfig = stored.gcConfig;
      return sessionGroups;
    });
  }
  return sessionGroupsLoading;
}

function saveSessionGroups() {
  return chrome.storage.local.set({ sessionGroups: sessionGroups || {} });
}

function sessionShortId(sessionId) {
  return String(sessionId || DEFAULT_SESSION_ID).slice(0, 12);
}

function groupTitle(sessionId, idle) {
  return `${SESSION_GROUP_PREFIX}·${sessionShortId(sessionId)}${idle ? '·idle' : ''}`;
}

function pickGroupColor(groups) {
  const used = new Set(Object.values(groups).map(entry => entry.color));
  return GROUP_COLORS.find(color => !used.has(color)) || GROUP_COLORS[Object.keys(groups).length % GROUP_COLORS.length];
}

async function getSessionGroupId(sessionId) {
  const groups = await getSessionGroups();
  const entry = groups[sessionId];
  if (!entry) return null;
  try {
    await chrome.tabGroups.get(entry.groupId);
    return entry.groupId;
  } catch {
    // 组已被关闭或浏览器重启后 groupId 失效
    delete groups[sessionId];
    await saveSessionGroups();
    return null;
  }
}

async function assertTabUsableBySession(tabId, sessionId) {
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.groupId !== 'number' || tab.groupId < 0) return; // 用户自己的散 tab，允许认领
  const groups = await getSessionGroups();
  const owner = Object.keys(groups).find(id => groups[id].groupId === tab.groupId);
  if (owner && owner !== sessionId) {
    throw new Error(`Tab ${tabId} belongs to another agent's group "${groupTitle(owner, groups[owner].state === 'idle')}". Use a tab in your own WebPilot group or omit tabId.`);
  }
}

async function getTargetTabId(tabId, sessionId) {
  if (tabId) {
    // sessionId 缺省时为内部调用（tab 已经过跨组校验），直接放行
    if (sessionId) await assertTabUsableBySession(tabId, sessionId);
    return tabId;
  }
  const session = sessionId || DEFAULT_SESSION_ID;
  const groupId = await getSessionGroupId(session);
  if (groupId !== null) {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length) {
      const remembered = sessionLastTab.get(session);
      if (remembered && tabs.some(tab => tab.id === remembered)) return remembered;
      tabs.sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0));
      return tabs[0].id;
    }
  }
  // 组内无 tab：新建空 tab 纳入本组，避免落到其他 agent 的前台 tab
  const created = await chrome.tabs.create({ url: 'about:blank', active: false });
  await markTabAsManaged(created.id, session);
  return created.id;
}

async function addTabToSessionGroup(tabId, sessionId) {
  const groups = await getSessionGroups();
  const tab = await chrome.tabs.get(tabId);
  let entry = groups[sessionId];
  let groupId = await getSessionGroupId(sessionId);

  if (groupId === null) {
    // 复用优先：认领任一 idle 组（保留其 tab 与登录态并重命名），再没有才新建
    const idleId = Object.keys(groups).find(id => id !== sessionId && groups[id].state === 'idle');
    if (idleId) {
      try {
        await chrome.tabGroups.get(groups[idleId].groupId);
        groupId = groups[idleId].groupId;
        entry = { ...groups[idleId] };
      } catch { /* 映射已失效 */ }
      delete groups[idleId];
      sessionLastTab.delete(idleId);
    }
  }

  if (groupId !== null) {
    const group = await chrome.tabGroups.get(groupId);
    // Chrome 标签组只属于一个窗口；把 tab 移到组所在窗口保持单组
    if (group.windowId !== tab.windowId) await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
    if (tab.groupId !== groupId) await chrome.tabs.group({ tabIds: [tabId], groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  }

  const wasActive = entry && entry.groupId === groupId && entry.state === 'active';
  const color = entry?.color || pickGroupColor(groups);
  groups[sessionId] = { groupId, state: 'active', lastActiveAt: Date.now(), color };
  if (!wasActive) {
    await chrome.tabGroups.update(groupId, { title: groupTitle(sessionId, false), color, collapsed: false });
  }
  await saveSessionGroups();
  return groupId;
}

function markTabAsManaged(tabId, sessionId) {
  if (!tabId) throw new Error('No active tab');
  managedTabs.add(tabId);
  const session = sessionId || DEFAULT_SESSION_ID;
  // 每个 session 一条建组队列，防止并发命令重复建组
  const prev = sessionGroupQueues.get(session) || Promise.resolve();
  const queued = prev.then(() => addTabToSessionGroup(tabId, session));
  sessionGroupQueues.set(session, queued.catch(() => {}));
  return queued;
}

async function restoreManagedTabs() {
  const groups = await getSessionGroups();
  for (const sessionId of Object.keys(groups)) {
    try {
      const tabs = await chrome.tabs.query({ groupId: groups[sessionId].groupId });
      for (const tab of tabs) managedTabs.add(tab.id);
    } catch { /* 组已不存在 */ }
  }
}

// ===== 并发控制：同 tab 串行 + 全局前台锁 =====
function enqueueOnTab(tabId, run) {
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  tabQueues.set(tabId, next);
  next.finally(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  }).catch(() => {});
  return next;
}

function runWithForegroundLock(tabId, run) {
  // 抢锁 → 激活 tab → 执行 → 释放；锁粒度为单命令
  const acquired = foregroundLock.catch(() => {}).then(async () => {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return run();
  });
  foregroundLock = acquired.catch(() => {});
  return acquired;
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

// WebMCP 命令须在 MAIN world 执行：页面 JS 将工具注册到 document.modelContext，
// isolated world 读不到主世界的 JS 对象
const MAIN_WORLD_METHODS = new Set(['webmcpHealth', 'webmcpGetTools', 'webmcpExecuteTool', 'probeCapabilities']);

async function callPageTool(tabId, method, args = []) {
  if (!tabId) throw new Error('No active tab');
  const world = MAIN_WORLD_METHODS.has(method) ? 'MAIN' : 'ISOLATED';
  await chrome.scripting.executeScript({ target: { tabId }, world, files: ['page-tools.js'] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func: async (toolMethod, toolArgs) => {
      if (!globalThis.__webpilot?.[toolMethod]) throw new Error(`Page tool is unavailable: ${toolMethod}`);
      return await globalThis.__webpilot[toolMethod](...toolArgs);
    },
    args: [method, args]
  });
  return result.result;
}

// ===== WebMCP 桥接命令 =====
async function cmdWebmcpHealth(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'webmcpHealth');
    sendToDaemon({ type: 'webmcpHealthResult', requestId, success: true, ...result });
  } catch (e) {
    sendToDaemon({ type: 'webmcpHealthResult', requestId, success: false, error: e.message });
  }
}

async function cmdWebmcpGetTools(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'webmcpGetTools');
    logOperation({ action: 'webmcpGetTools', tabId: target, success: true, toolCount: result.count || 0 });
    sendToDaemon({ type: 'webmcpGetToolsResult', requestId, success: true, ...result });
  } catch (e) {
    sendToDaemon({ type: 'webmcpGetToolsResult', requestId, success: false, error: e.message });
  }
}

async function cmdWebmcpExecuteTool(toolName, input, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'webmcpExecuteTool', [toolName, input || {}]);
    logOperation({ action: 'webmcpExecuteTool', tabId: target, tool: toolName, success: result.success !== false });
    sendToDaemon({ type: 'webmcpExecuteToolResult', requestId, success: true, ...result });
  } catch (e) {
    sendToDaemon({ type: 'webmcpExecuteToolResult', requestId, success: false, error: e.message });
  }
}

async function cmdProbeCapabilities(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'probeCapabilities');
    logOperation({ action: 'probeCapabilities', tabId: target, success: true, durationMs: result.durationMs });
    sendToDaemon({ type: 'probeCapabilitiesResult', requestId, success: true, ...result });
  } catch (e) {
    sendToDaemon({ type: 'probeCapabilitiesResult', requestId, success: false, error: e.message });
  }
}

async function cmdNavigate(url, tabId, requestId, sessionId) {
  const startedAt = Date.now();
  // handleDaemonMessage 已把 tabId 解析为本 session 组内的 tab
  const targetTab = tabId;
  if (!targetTab) {
    sendToDaemon({ type: 'navigateResult', requestId, success: false, error: 'No active tab' });
    return;
  }
  try {
    // Mark before navigation so an immediate server-side redirect is covered by
    // the allowlist listener as well.
    await markTabAsManaged(targetTab, sessionId);
    const tab = await chrome.tabs.update(targetTab, { url });
    const loadedTab = await waitForTabLoad(tab.id);
    await markTabAsManaged(tab.id, sessionId);
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

async function cmdGetPageInfo(tabId, requestId, structure) {
  const target = await getTargetTabId(tabId);
  try {
    // structure === 'tree' 时返回语义容器分组树，默认仍为平铺列表
    const result = await callPageTool(target, structure === 'tree' ? 'pageTree' : 'page');
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

// ===== 方案 2: 受控 evaluate =====
async function cmdEvaluate(expression, options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'safeEvaluate', [expression, options || {}]);
    logOperation({ action: 'evaluate', tabId: target, success: !result.error, error: result.error, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'evaluateResult', requestId, success: !result.error, ...result });
  } catch (e) {
    logOperation({ action: 'evaluate', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'evaluateResult', requestId, success: false, error: e.message });
  }
}

// ===== 方案 3: 表格提取（extract 的便捷封装） =====
async function cmdExtractTable(spec, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'extract', [{ table: spec || {} }]);
    logOperation({ action: 'extractTable', tabId: target, success: !result.data?.table?.error, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'extractTableResult', requestId, success: !result.data?.table?.error, ...result });
  } catch (e) {
    logOperation({ action: 'extractTable', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'extractTableResult', requestId, success: false, error: e.message });
  }
}

// ===== 方案 1: CDP Network 域监控 =====
async function cmdStartNetworkCapture(filter, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    // Detach any previous debugger on this tab
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* not attached */ }

    await chrome.debugger.attach({ tabId: target }, '1.3');
    await chrome.debugger.sendCommand({ tabId: target }, 'Network.enable');

    // Initialize capture buffer
    networkCaptures.set(target, {
      resources: [],
      requestDetails: new Map(),
      active: true,
      filter: filter || {},
      startedAt: new Date().toISOString()
    });

    // Listen to network events
    chrome.debugger.onEvent.addListener(function networkListener(source, method, params) {
      if (source.tabId !== target || !networkCaptures.get(target)?.active) return;

      if (method === 'Network.requestWillBeSent') {
        const capture = networkCaptures.get(target);
        if (capture && params.request) {
          // Cap request detail map to avoid memory issues
          if (capture.requestDetails.size > 1000) {
            const firstKey = capture.requestDetails.keys().next().value;
            capture.requestDetails.delete(firstKey);
          }
          capture.requestDetails.set(params.requestId, {
            url: params.request.url,
            method: params.request.method,
            headers: params.request.headers || {},
            postData: params.request.postData || null,
            hasPostData: params.request.hasPostData || false,
            type: params.type,
            initiatorType: params.initiator?.type || null,
            timestamp: params.timestamp
          });
        }
      }

      if (method === 'Network.responseReceived') {
        const capture = networkCaptures.get(target);
        const reqDetail = capture?.requestDetails?.get(params.requestId);
        const entry = {
          url: params.response.url,
          status: params.response.status,
          mimeType: params.response.mimeType,
          protocol: params.response.protocol,
          remoteIP: params.response.remoteIPAddress,
          headers: params.response.headers || {},
          timestamp: params.timestamp,
          requestId: params.requestId,
          type: params.type,
          resourceId: params.resourceId,
          method: reqDetail?.method || null,
          postData: reqDetail?.postData || null
        };

        // Apply filters
        if (capture) {
          if (capture.filter.type === 'image') {
            const isImage = entry.type === 'Image' || /\.(jpg|jpeg|png|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i.test(entry.url);
            if (!isImage) return;
          }
          if (capture.filter.urlContains && !entry.url.includes(capture.filter.urlContains)) return;
          if (capture.filter.mimeType && !entry.mimeType.includes(capture.filter.mimeType)) return;

          capture.resources.push(entry);
          // Cap at 1000 entries to avoid memory issues
          if (capture.resources.length > 1000) capture.resources.shift();
        }
      }
    });

    logOperation({ action: 'startNetworkCapture', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'startNetworkCaptureResult', requestId, success: true, tabId: target, message: 'Network capture started' });
  } catch (e) {
    logOperation({ action: 'startNetworkCapture', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'startNetworkCaptureResult', requestId, success: false, error: e.message });
  }
}

async function cmdStopNetworkCapture(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const capture = networkCaptures.get(target);
    if (capture) capture.active = false;

    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }

    logOperation({ action: 'stopNetworkCapture', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'stopNetworkCaptureResult', requestId, success: true, tabId: target, message: 'Network capture stopped' });
  } catch (e) {
    logOperation({ action: 'stopNetworkCapture', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'stopNetworkCaptureResult', requestId, success: false, error: e.message });
  }
}

async function cmdGetNetworkResources(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const capture = networkCaptures.get(target);
    if (!capture) {
      sendToDaemon({ type: 'getNetworkResourcesResult', requestId, success: false, error: 'No network capture found for this tab. Call startNetworkCapture first.' });
      return;
    }

    let resources = capture.resources;

    // Apply additional filters at read time
    if (options?.urlContains) resources = resources.filter(r => r.url.includes(options.urlContains));
    if (options?.mimeType) resources = resources.filter(r => r.mimeType.includes(options.mimeType));
    if (options?.type) resources = resources.filter(r => r.type === options.type);
    if (typeof options?.minStatus === 'number') resources = resources.filter(r => r.status >= options.minStatus);

    // Sort by timestamp descending (most recent first)
    resources = resources.slice().sort((a, b) => b.timestamp - a.timestamp);

    // Limit results
    const limit = Math.max(1, Math.min(options?.limit || 100, 500));
    resources = resources.slice(0, limit);

    sendToDaemon({
      type: 'getNetworkResourcesResult',
      requestId,
      success: true,
      resources,
      count: resources.length,
      totalCaptured: capture.resources.length,
      active: capture.active,
      startedAt: capture.startedAt,
      tabId: target
    });
  } catch (e) {
    sendToDaemon({ type: 'getNetworkResourcesResult', requestId, success: false, error: e.message });
  }
}

// ===== API 重放命令 =====
const REPLAY_FORBIDDEN_HEADERS = new Set([
  'host', 'connection', 'content-length', 'cookie', 'origin', 'referer',
  'accept-encoding', 'accept-language', 'user-agent', 'sec-fetch-mode',
  'sec-fetch-site', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile',
  'sec-ch-ua-platform', 'upgrade-insecure-requests', 'pragma', 'cache-control'
]);

async function cmdReplayApiRequest(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const capture = networkCaptures.get(target);
    if (!capture || !capture.requestDetails) {
      sendToDaemon({ type: 'replayApiRequestResult', requestId, success: false, error: 'No network capture found for this tab. Call start_network_capture first.' });
      return;
    }

    // Locate the original request by CDP requestId or URL substring
    let detail = null;
    if (options?.captureRequestId != null) {
      detail = capture.requestDetails.get(String(options.captureRequestId));
    } else if (options?.urlContains) {
      for (const d of capture.requestDetails.values()) {
        if (d.url.includes(options.urlContains)) detail = d;
      }
    }
    if (!detail) {
      sendToDaemon({ type: 'replayApiRequestResult', requestId, success: false, error: 'Captured request not found. Provide captureRequestId or urlContains.' });
      return;
    }

    // Build URL with optional query param overrides
    let url = options?.url || detail.url;
    if (options?.queryParams && typeof options.queryParams === 'object') {
      const u = new URL(url);
      for (const [k, v] of Object.entries(options.queryParams)) {
        if (v === null || v === undefined) u.searchParams.delete(k);
        else u.searchParams.set(k, String(v));
      }
      url = u.toString();
    }

    // Build headers: keep original non-forbidden headers (auth tokens etc.)
    const headers = {};
    for (const [k, v] of Object.entries(detail.headers || {})) {
      if (!REPLAY_FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    if (options?.headers && typeof options.headers === 'object') {
      for (const [k, v] of Object.entries(options.headers)) {
        if (!REPLAY_FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k] = v;
      }
    }

    const method = (options?.method || detail.method || 'GET').toUpperCase();
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      if (options?.body !== undefined) {
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        if (!headers['content-type'] && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      } else if (detail.postData) {
        body = detail.postData;
      }
    }

    // Fetch from extension context: bypasses page CSP, carries cookies for the target host
    const maxBodyChars = Math.min(Math.max(options?.maxBodyChars || 50000, 1000), 500000);
    const resp = await fetch(url, { method, headers, body, credentials: 'include', redirect: 'follow' });
    let text = await resp.text();
    let truncated = false;
    if (text.length > maxBodyChars) { text = text.slice(0, maxBodyChars); truncated = true; }
    let json = null;
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      try { json = JSON.parse(text); } catch { /* keep text only */ }
    }

    logOperation({ action: 'replayApiRequest', tabId: target, url, method, status: resp.status, success: resp.ok, durationMs: Date.now() - startedAt });
    sendToDaemon({
      type: 'replayApiRequestResult',
      requestId,
      success: true,
      status: resp.status,
      statusText: resp.statusText,
      contentType,
      body: json !== null ? json : text,
      truncated,
      bodyLength: text.length,
      url,
      method,
      durationMs: Date.now() - startedAt
    });
  } catch (e) {
    logOperation({ action: 'replayApiRequest', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'replayApiRequestResult', requestId, success: false, error: e.message });
  }
}

// ===== 交互类命令 =====
async function cmdHover(selector, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'hover', [selector]);
    logOperation({ action: 'hover', tabId: target, selector, success: result.success !== false, error: result.error, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'hoverResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'hover', tabId: target, selector, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'hoverResult', requestId, success: false, error: e.message });
  }
}

async function cmdPressKey(selector, key, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'pressKey', [selector, key]);
    logOperation({ action: 'pressKey', tabId: target, key, success: result.success !== false, error: result.error, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'pressKeyResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'pressKey', tabId: target, key, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'pressKeyResult', requestId, success: false, error: e.message });
  }
}

async function cmdScroll(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'scroll', [options || {}]);
    logOperation({ action: 'scroll', tabId: target, success: true });
    sendToDaemon({ type: 'scrollResult', requestId, success: true, ...result });
  } catch (e) {
    logOperation({ action: 'scroll', tabId: target, success: false, error: e.message });
    sendToDaemon({ type: 'scrollResult', requestId, success: false, error: e.message });
  }
}

async function cmdSelectOption(selector, value, options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'selectOption', [selector, value, options || {}]);
    logOperation({ action: 'selectOption', tabId: target, selector, success: result.success !== false, error: result.error, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'selectOptionResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'selectOption', tabId: target, selector, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'selectOptionResult', requestId, success: false, error: e.message });
  }
}

async function cmdDragDrop(fromSelector, toSelector, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'dragDrop', [fromSelector, toSelector]);
    logOperation({ action: 'dragDrop', tabId: target, success: result.success !== false, error: result.error, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'dragDropResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'dragDrop', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'dragDropResult', requestId, success: false, error: e.message });
  }
}

async function cmdWaitForDynamic(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const result = await callPageTool(target, 'waitForDynamic', [options || {}]);
    logOperation({ action: 'waitForDynamic', tabId: target, success: result.success !== false, error: result.error, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'waitForDynamicResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'waitForDynamic', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'waitForDynamicResult', requestId, success: false, error: e.message });
  }
}

async function cmdIframeAction(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'iframeAction', [options || {}]);
    logOperation({ action: 'iframeAction', tabId: target, action: options?.action, success: result.success !== false, error: result.error });
    sendToDaemon({ type: 'iframeActionResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'iframeAction', tabId: target, success: false, error: e.message });
    sendToDaemon({ type: 'iframeActionResult', requestId, success: false, error: e.message });
  }
}

// ===== CDP 类命令：文件上传 =====
async function cmdUploadFile(selector, filePath, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    // Use CDP to set file input files
    await chrome.debugger.attach({ tabId: target }, '1.3');

    // Find the file input element via CDP DOM domain
    const root = await chrome.debugger.sendCommand({ tabId: target }, 'DOM.getDocument', { depth: 0 });
    const selectorResult = await chrome.debugger.sendCommand({ tabId: target }, 'DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: selector || 'input[type="file"]'
    });

    if (!selectorResult.nodeId) {
      await chrome.debugger.detach({ tabId: target });
      sendToDaemon({ type: 'uploadFileResult', requestId, success: false, error: `File input not found: ${selector || 'input[type="file"]'}` });
      return;
    }

    // Set the file on the input element
    await chrome.debugger.sendCommand({ tabId: target }, 'DOM.setFileInputFiles', {
      nodeId: selectorResult.nodeId,
      files: [filePath]
    });

    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'uploadFile', tabId: target, selector, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'uploadFileResult', requestId, success: true, selector, filePath, message: 'File uploaded successfully' });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'uploadFile', tabId: target, selector, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'uploadFileResult', requestId, success: false, error: e.message });
  }
}

// ===== CDP 类命令：弹窗处理 =====
async function cmdHandleDialog(action, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    await chrome.debugger.sendCommand({ tabId: target }, 'Page.handleJavaScriptDialog', {
      accept: action !== 'dismiss',
      promptText: action === 'dismiss' ? undefined : action
    });
    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'handleDialog', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'handleDialogResult', requestId, success: true, action, message: `Dialog ${action === 'dismiss' ? 'dismissed' : 'accepted'}` });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'handleDialog', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'handleDialogResult', requestId, success: false, error: e.message });
  }
}

// ===== 文件下载 =====
async function cmdDownloadFile(url, filename, tabId, requestId) {
  const startedAt = Date.now();
  try {
    const downloadId = await chrome.downloads.download({
      url: url,
      filename: filename || undefined,
      saveAs: false
    });
    logOperation({ action: 'downloadFile', tabId, url: url.slice(0, 100), success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'downloadFileResult', requestId, success: true, downloadId, url, filename, message: 'Download started' });
  } catch (e) {
    logOperation({ action: 'downloadFile', tabId, url: url.slice(0, 100), success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'downloadFileResult', requestId, success: false, error: e.message });
  }
}

// ===== 页面刷新 =====
async function cmdReload(bypassCache, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.tabs.reload(target, { bypassCache: bypassCache === true });
    logOperation({ action: 'reload', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'reloadResult', requestId, success: true, message: `Page reloaded ${bypassCache ? '(bypass cache)' : ''}` });
  } catch (e) {
    logOperation({ action: 'reload', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'reloadResult', requestId, success: false, error: e.message });
  }
}

// ===== 浏览器前进/后退 =====
async function cmdGoBackForward(direction, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    const history = await chrome.debugger.sendCommand({ tabId: target }, 'Page.getNavigationHistory');
    const currentIndex = history.currentIndex;
    const entries = history.entries;

    if (direction === 'back' && currentIndex > 0) {
      await chrome.debugger.sendCommand({ tabId: target }, 'Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
      await chrome.debugger.detach({ tabId: target });
      logOperation({ action: 'goBackForward', tabId: target, direction: 'back', success: true, durationMs: Date.now() - startedAt });
      sendToDaemon({ type: 'goBackForwardResult', requestId, success: true, direction: 'back', url: entries[currentIndex - 1].url });
    } else if (direction === 'forward' && currentIndex < entries.length - 1) {
      await chrome.debugger.sendCommand({ tabId: target }, 'Page.navigateToHistoryEntry', { entryId: entries[currentIndex + 1].id });
      await chrome.debugger.detach({ tabId: target });
      logOperation({ action: 'goBackForward', tabId: target, direction: 'forward', success: true, durationMs: Date.now() - startedAt });
      sendToDaemon({ type: 'goBackForwardResult', requestId, success: true, direction: 'forward', url: entries[currentIndex + 1].url });
    } else {
      await chrome.debugger.detach({ tabId: target });
      sendToDaemon({ type: 'goBackForwardResult', requestId, success: false, error: `Cannot go ${direction}: already at ${direction === 'back' ? 'beginning' : 'end'} of history` });
    }
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'goBackForward', tabId: target, direction, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'goBackForwardResult', requestId, success: false, error: e.message });
  }
}

// ===== 获取当前 URL =====
async function cmdGetURL(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const tab = await chrome.tabs.get(target);
    sendToDaemon({ type: 'getURLResult', requestId, success: true, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl });
  } catch (e) {
    sendToDaemon({ type: 'getURLResult', requestId, success: false, error: e.message });
  }
}

// ===== 整页截图 =====
async function cmdFullPageScreenshot(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    // Get full page metrics
    const metrics = await chrome.debugger.sendCommand({ tabId: target }, 'Page.getLayoutMetrics');
    const width = Math.ceil(metrics.cssContentSize.width);
    const height = Math.ceil(metrics.cssContentSize.height);

    const result = await chrome.debugger.sendCommand({ tabId: target }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    });
    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'fullPageScreenshot', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'fullPageScreenshotResult', requestId, success: true, data: result.data, format: 'png', width, height });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'fullPageScreenshot', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'fullPageScreenshotResult', requestId, success: false, error: e.message });
  }
}

// ===== 元素截图 =====
async function cmdElementScreenshot(selector, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    // First get element bounds via page-tools
    const probeResult = await callPageTool(target, 'probe', [selector]);
    if (!probeResult?.matched) {
      sendToDaemon({ type: 'elementScreenshotResult', requestId, success: false, error: `Element not found: ${selector}` });
      return;
    }
    const box = probeResult.element.box;

    await chrome.debugger.attach({ tabId: target }, '1.3');
    const result = await chrome.debugger.sendCommand({ tabId: target }, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
    });
    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'elementScreenshot', tabId: target, selector, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'elementScreenshotResult', requestId, success: true, data: result.data, format: 'png', width: box.width, height: box.height, element: probeResult.element });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'elementScreenshot', tabId: target, selector, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'elementScreenshotResult', requestId, success: false, error: e.message });
  }
}

// ===== 控制台日志捕获 =====
async function cmdGetConsoleLogs(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  const duration = Math.min(options?.duration || 3000, 10000);
  const logs = [];

  const onEvent = (source, method, params) => {
    if (source.tabId !== target) return;
    if (method === 'Runtime.consoleAPICalled') {
      logs.push({
        type: params.type,
        args: (params.args || []).map(a => a.value ?? a.description ?? a.type),
        stackTrace: params.stackTrace?.callFrames?.slice(0, 3).map(f => `${f.functionName || '(anonymous)'}@${f.url}:${f.lineNumber}`),
        timestamp: Date.now()
      });
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry;
      logs.push({
        type: entry.level,
        source: entry.source,
        text: entry.text,
        url: entry.url,
        lineNumber: entry.lineNumber,
        timestamp: entry.timestamp
      });
    }
  };

  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    chrome.debugger.onEvent.addListener(onEvent);
    await chrome.debugger.sendCommand({ tabId: target }, 'Runtime.enable');
    await chrome.debugger.sendCommand({ tabId: target }, 'Log.enable');

    await new Promise(resolve => setTimeout(resolve, duration));

    await chrome.debugger.sendCommand({ tabId: target }, 'Log.disable');
    await chrome.debugger.sendCommand({ tabId: target }, 'Runtime.disable');
    chrome.debugger.onEvent.removeListener(onEvent);
    await chrome.debugger.detach({ tabId: target });

    logOperation({ action: 'getConsoleLogs', tabId: target, success: true, logCount: logs.length, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'getConsoleLogsResult', requestId, success: true, logs, count: logs.length, duration: Date.now() - startedAt });
  } catch (e) {
    try { chrome.debugger.onEvent.removeListener(onEvent); await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'getConsoleLogs', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'getConsoleLogsResult', requestId, success: false, error: e.message });
  }
}

// ===== Shadow DOM 操作 =====
async function cmdShadowDomAction(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'shadowDomAction', [options || {}]);
    logOperation({ action: 'shadowDomAction', tabId: target, subAction: options?.action, success: result.success !== false, error: result.error });
    sendToDaemon({ type: 'shadowDomActionResult', requestId, ...result });
  } catch (e) {
    logOperation({ action: 'shadowDomAction', tabId: target, success: false, error: e.message });
    sendToDaemon({ type: 'shadowDomActionResult', requestId, success: false, error: e.message });
  }
}

// ===== 视口/设备模拟 =====
async function cmdSetViewport(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    const metrics = {
      width: options.width || 1280,
      height: options.height || 800,
      deviceScaleFactor: options.deviceScaleFactor || 1,
      mobile: options.mobile === true,
    };
    if (options.userAgent) {
      await chrome.debugger.sendCommand({ tabId: target }, 'Network.setUserAgentOverride', { userAgent: options.userAgent });
    }
    await chrome.debugger.sendCommand({ tabId: target }, 'Emulation.setDeviceMetricsOverride', metrics);

    if (options.touch === true) {
      await chrome.debugger.sendCommand({ tabId: target }, 'Emulation.setTouchEmulationEnabled', { enabled: true });
    }

    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'setViewport', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setViewportResult', requestId, success: true, message: `Viewport set to ${metrics.width}x${metrics.height}${metrics.mobile ? ' (mobile)' : ''}` });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'setViewport', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setViewportResult', requestId, success: false, error: e.message });
  }
}

// ===== User Agent 覆盖 =====
async function cmdSetUserAgent(userAgent, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    await chrome.debugger.sendCommand({ tabId: target }, 'Network.setUserAgentOverride', {
      userAgent: userAgent,
      acceptLanguage: 'en-US,en;q=0.9',
    });
    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'setUserAgent', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setUserAgentResult', requestId, success: true, message: `User-Agent set to: ${userAgent.slice(0, 80)}` });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'setUserAgent', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setUserAgentResult', requestId, success: false, error: e.message });
  }
}

// ===== 保存 PDF =====
async function cmdSavePDF(options, filename, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    const pdfParams = {
      landscape: options?.landscape === true,
      displayHeaderFooter: options?.displayHeaderFooter === true,
      printBackground: options?.printBackground !== false,
      scale: options?.scale || 1,
      paperWidth: options?.paperWidth || 8.5,
      paperHeight: options?.paperHeight || 11,
      marginTop: options?.marginTop ?? 0.4,
      marginBottom: options?.marginBottom ?? 0.4,
      marginLeft: options?.marginLeft ?? 0.4,
      marginRight: options?.marginRight ?? 0.4,
    };
    const result = await chrome.debugger.sendCommand({ tabId: target }, 'Page.printToPDF', pdfParams);

    // If filename provided, save via downloads API
    if (filename && result.data) {
      const dataUrl = `data:application/pdf;base64,${result.data}`;
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: filename.endsWith('.pdf') ? filename : `${filename}.pdf`,
        saveAs: false
      });
      await chrome.debugger.detach({ tabId: target });
      logOperation({ action: 'savePDF', tabId: target, success: true, durationMs: Date.now() - startedAt });
      sendToDaemon({ type: 'savePDFResult', requestId, success: true, downloadId, filename, message: 'PDF saved to downloads' });
    } else {
      await chrome.debugger.detach({ tabId: target });
      logOperation({ action: 'savePDF', tabId: target, success: true, durationMs: Date.now() - startedAt });
      sendToDaemon({ type: 'savePDFResult', requestId, success: true, data: result.data, format: 'pdf', message: 'PDF generated (base64)' });
    }
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'savePDF', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'savePDFResult', requestId, success: false, error: e.message });
  }
}

// ===== 地理位置覆盖 =====
async function cmdSetGeolocation(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    await chrome.debugger.sendCommand({ tabId: target }, 'Emulation.setGeolocationOverride', {
      latitude: options.latitude,
      longitude: options.longitude,
      accuracy: options.accuracy || 100,
    });
    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'setGeolocation', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setGeolocationResult', requestId, success: true, message: `Geolocation set to ${options.latitude}, ${options.longitude}` });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'setGeolocation', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setGeolocationResult', requestId, success: false, error: e.message });
  }
}

// ===== 网络限速/离线 =====
async function cmdSetNetworkThrottle(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');

    if (options.offline === true) {
      await chrome.debugger.sendCommand({ tabId: target }, 'Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });
      await chrome.debugger.detach({ tabId: target });
      logOperation({ action: 'setNetworkThrottle', tabId: target, success: true, mode: 'offline', durationMs: Date.now() - startedAt });
      sendToDaemon({ type: 'setNetworkThrottleResult', requestId, success: true, message: 'Network set to offline mode' });
    } else if (options.reset === true) {
      await chrome.debugger.sendCommand({ tabId: target }, 'Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await chrome.debugger.detach({ tabId: target });
      logOperation({ action: 'setNetworkThrottle', tabId: target, success: true, mode: 'reset', durationMs: Date.now() - startedAt });
      sendToDaemon({ type: 'setNetworkThrottleResult', requestId, success: true, message: 'Network conditions reset to normal' });
    } else {
      const conditions = {
        offline: false,
        latency: options.latency || 100,
        downloadThroughput: (options.downloadKbps || 1000) * 1024 / 8,
        uploadThroughput: (options.uploadKbps || 500) * 1024 / 8,
      };
      await chrome.debugger.sendCommand({ tabId: target }, 'Network.emulateNetworkConditions', conditions);
      await chrome.debugger.detach({ tabId: target });
      logOperation({ action: 'setNetworkThrottle', tabId: target, success: true, mode: 'throttle', durationMs: Date.now() - startedAt });
      sendToDaemon({ type: 'setNetworkThrottleResult', requestId, success: true, message: `Network throttled: ${options.latency || 100}ms latency, ${options.downloadKbps || 1000}kbps down, ${options.uploadKbps || 500}kbps up` });
    }
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'setNetworkThrottle', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setNetworkThrottleResult', requestId, success: false, error: e.message });
  }
}

// ===== 时区覆盖 =====
async function cmdSetTimezone(timezone, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    await chrome.debugger.attach({ tabId: target }, '1.3');
    await chrome.debugger.sendCommand({ tabId: target }, 'Emulation.setTimezoneOverride', {
      timezoneId: timezone,
    });
    await chrome.debugger.detach({ tabId: target });
    logOperation({ action: 'setTimezone', tabId: target, success: true, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setTimezoneResult', requestId, success: true, message: `Timezone set to ${timezone}` });
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: target }); } catch { /* already detached */ }
    logOperation({ action: 'setTimezone', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setTimezoneResult', requestId, success: false, error: e.message });
  }
}

// ===== Cookie 管理 =====
async function cmdGetCookies(options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const tab = await chrome.tabs.get(target);
    const url = tab.url;
    const cookieParams = { url };
    if (options?.name) cookieParams.name = options.name;
    if (options?.domain) cookieParams.domain = options.domain;
    if (options?.path) cookieParams.path = options.path;
    if (options?.secure !== undefined) cookieParams.secure = options.secure;
    if (options?.session !== undefined) cookieParams.session = options.session;
    const cookies = await chrome.cookies.getAll(cookieParams);
    logOperation({ action: 'getCookies', tabId: target, success: true, cookieCount: cookies.length });
    sendToDaemon({ type: 'getCookiesResult', requestId, success: true, cookies, count: cookies.length, url });
  } catch (e) {
    logOperation({ action: 'getCookies', tabId: target, success: false, error: e.message });
    sendToDaemon({ type: 'getCookiesResult', requestId, success: false, error: e.message });
  }
}

async function cmdGetAllCookies(tabId, requestId) {
  try {
    const tab = await chrome.tabs.get(await getTargetTabId(tabId));
    const url = tab.url;
    let domain;
    try { domain = new URL(url).hostname; } catch { domain = undefined; }
    const cookies = await chrome.cookies.getAll({});
    // If we have a domain, filter to relevant cookies
    const filtered = domain ? cookies.filter(c => c.domain === domain || c.domain === '.' + domain || domain.endsWith(c.domain.replace(/^\./, ''))) : cookies;
    logOperation({ action: 'getAllCookies', tabId, success: true, cookieCount: filtered.length });
    sendToDaemon({ type: 'getAllCookiesResult', requestId, success: true, cookies: filtered, count: filtered.length, totalInBrowser: cookies.length });
  } catch (e) {
    logOperation({ action: 'getAllCookies', tabId, success: false, error: e.message });
    sendToDaemon({ type: 'getAllCookiesResult', requestId, success: false, error: e.message });
  }
}

async function cmdSetCookie(details, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const tab = await chrome.tabs.get(target);
    const url = details.url || tab.url;
    let domain = details.domain;
    if (!domain) {
      try { domain = new URL(url).hostname; } catch { domain = undefined; }
    }
    const cookieDetails = {
      url: url,
      name: details.name,
      value: details.value,
      domain: domain,
      path: details.path || '/',
      secure: details.secure !== undefined ? details.secure : url.startsWith('https'),
      httpOnly: details.httpOnly || false,
      sameSite: details.sameSite || 'unspecified',
    };
    if (details.expirationDate) cookieDetails.expirationDate = details.expirationDate;
    const cookie = await chrome.cookies.set(cookieDetails);
    logOperation({ action: 'setCookie', tabId: target, success: true, cookieName: details.name, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setCookieResult', requestId, success: true, cookie, message: `Cookie '${details.name}' set successfully` });
  } catch (e) {
    logOperation({ action: 'setCookie', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'setCookieResult', requestId, success: false, error: e.message });
  }
}

async function cmdDeleteCookie(details, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    const tab = await chrome.tabs.get(target);
    const url = details.url || tab.url;
    let domain = details.domain;
    if (!domain) {
      try { domain = new URL(url).hostname; } catch { domain = undefined; }
    }
    await chrome.cookies.remove({
      url: url,
      name: details.name,
      storeId: details.storeId,
    });
    logOperation({ action: 'deleteCookie', tabId: target, success: true, cookieName: details.name, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'deleteCookieResult', requestId, success: true, message: `Cookie '${details.name}' deleted` });
  } catch (e) {
    logOperation({ action: 'deleteCookie', tabId: target, success: false, error: e.message, durationMs: Date.now() - startedAt });
    sendToDaemon({ type: 'deleteCookieResult', requestId, success: false, error: e.message });
  }
}

async function cmdScreenshot(tabId, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    // 前台锁已先激活目标 tab；按其所在窗口截取可见区域
    const tab = await chrome.tabs.get(target);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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

// ===== 标签组生命周期：闲置标记、TTL/上限回收、手动清理 =====
function ensureGroupGcAlarm() {
  return chrome.alarms.create(GROUP_GC_ALARM, { periodInMinutes: GROUP_GC_PERIOD_MINUTES });
}

async function handleSessionUpdate(msg) {
  activeSessions = new Set(Array.isArray(msg.activeSessions) ? msg.activeSessions : []);
  if (msg.config) {
    gcConfig = {
      ttlMinutes: Number.isFinite(msg.config.ttlMinutes) ? msg.config.ttlMinutes : DEFAULT_GROUP_TTL_MINUTES,
      maxGroups: Number.isFinite(msg.config.maxGroups) && msg.config.maxGroups > 0 ? msg.config.maxGroups : DEFAULT_MAX_GROUPS
    };
    await chrome.storage.local.set({ gcConfig });
  }
  const groups = await getSessionGroups();
  for (const sessionId of Object.keys(groups)) {
    if (activeSessions.has(sessionId) && groups[sessionId].state === 'idle') {
      await setGroupIdleState(sessionId, false);
    } else if (!activeSessions.has(sessionId) && groups[sessionId].state === 'active') {
      await setGroupIdleState(sessionId, true);
    }
  }
  broadcastSessionSummary();
}

// 会话断开 = 标记闲置（变灰+折叠+·idle），tab 全部保留；恢复时反向
async function setGroupIdleState(sessionId, idle) {
  const groups = await getSessionGroups();
  const entry = groups[sessionId];
  if (!entry) return;
  entry.state = idle ? 'idle' : 'active';
  entry.lastActiveAt = Date.now();
  try {
    await chrome.tabGroups.update(entry.groupId, idle
      ? { title: groupTitle(sessionId, true), color: 'grey', collapsed: true }
      : { title: groupTitle(sessionId, false), color: entry.color || pickGroupColor(groups), collapsed: false });
  } catch {
    delete groups[sessionId];
  }
  await saveSessionGroups();
}

async function closeSessionGroup(sessionId) {
  const groups = await getSessionGroups();
  const entry = groups[sessionId];
  if (!entry) return false;
  try {
    const tabs = await chrome.tabs.query({ groupId: entry.groupId });
    if (tabs.length) await chrome.tabs.remove(tabs.map(tab => tab.id));
  } catch { /* 组已不存在 */ }
  delete groups[sessionId];
  sessionLastTab.delete(sessionId);
  await saveSessionGroups();
  return true;
}

// TTL + 组数上限兜底回收，由 chrome.alarms 周期触发（不依赖 service worker 常驻）
async function runGroupGc() {
  const groups = await getSessionGroups();
  const now = Date.now();
  if (gcConfig.ttlMinutes > 0) {
    const ttlMs = gcConfig.ttlMinutes * 60_000;
    for (const sessionId of Object.keys(groups)) {
      if (groups[sessionId].state === 'idle' && now - groups[sessionId].lastActiveAt > ttlMs) {
        await closeSessionGroup(sessionId);
      }
    }
  }
  // 超上限时关闭最旧的 idle 组（活跃组永不回收）
  const idleOldestFirst = Object.keys(groups)
    .filter(sessionId => groups[sessionId].state === 'idle')
    .sort((left, right) => groups[left].lastActiveAt - groups[right].lastActiveAt);
  while (Object.keys(groups).length > gcConfig.maxGroups && idleOldestFirst.length) {
    await closeSessionGroup(idleOldestFirst.shift());
  }
}

async function cleanupGroups({ onlyIdle = true, sessionId } = {}) {
  const groups = await getSessionGroups();
  const closed = [];
  for (const id of Object.keys(groups)) {
    if (sessionId) {
      if (id !== sessionId) continue;
    } else if (onlyIdle && groups[id].state !== 'idle') {
      continue;
    } else if (!onlyIdle && activeSessions.has(id)) {
      continue; // 活跃会话的组不参与批量清理
    }
    if (await closeSessionGroup(id)) closed.push(id);
  }
  return { closed, remaining: Object.keys(groups).length };
}

async function cmdCleanupSessions(options, requestId) {
  try {
    const result = await cleanupGroups(options || {});
    logOperation({ action: 'cleanupSessions', success: true, closed: result.closed });
    sendToDaemon({ type: 'cleanupSessionsResult', requestId, success: true, ...result });
  } catch (e) {
    logOperation({ action: 'cleanupSessions', success: false, error: e.message });
    sendToDaemon({ type: 'cleanupSessionsResult', requestId, success: false, error: e.message });
  }
}

async function getSessionSummaries() {
  const groups = await getSessionGroups();
  const sessions = [];
  for (const sessionId of Object.keys(groups)) {
    let tabCount = 0;
    try {
      tabCount = (await chrome.tabs.query({ groupId: groups[sessionId].groupId })).length;
    } catch {
      continue;
    }
    sessions.push({
      sessionId,
      state: groups[sessionId].state,
      tabCount,
      title: groupTitle(sessionId, groups[sessionId].state === 'idle'),
      active: activeSessions.has(sessionId)
    });
  }
  return sessions;
}

function broadcastSessionSummary() {
  getSessionSummaries()
    .then(sessions => chrome.runtime.sendMessage({ type: 'sessionSummary', sessions }).catch(() => {}))
    .catch(() => {});
}

function sendToDaemon(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ===== Message Router =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    Promise.all([getSecuritySettings(), getSessionSummaries()])
      .then(([security, sessions]) => sendResponse({ connected: isConnected, wsUrl: WS_URL, tabCount: managedTabs.size, security, sessions }));
    return true;
  }
  if (msg.type === 'cleanupIdleGroups') {
    cleanupGroups({ onlyIdle: true })
      .then(result => getSessionSummaries().then(sessions => sendResponse({ success: true, ...result, sessions })))
      .catch(error => sendResponse({ success: false, error: error.message }));
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
