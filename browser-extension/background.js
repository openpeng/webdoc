// background.js — Service Worker，管理 WebSocket 连接和 CDP

// classic service worker（manifest 未声明 "type":"module"），用 importScripts 引入
// 与 MCP 侧 api-command-types.ts 逐字对齐的共享常量与安全 helper。
// 顶层 const / function 与本文件共享同一全局词法环境；helpers 不得引用任何 MCP 模块。
//
// 兼容性：node --test 的 session-isolation 测试用 vm.runInContext 只加载本文件源码，
// 沙箱里既没有 importScripts，也不会加载 api-command-helpers.js。故加 typeof 守卫，
// 并保证「加载期 + 普通命令路径」不引用 helpers 提供的标识符（见下方 TAB_SCOPED_COMMANDS /
// API_EXECUTION_TYPES / dispatchCommand 的 case 均使用与 MSG 逐字一致的字面量）。
// 真实 Chrome SW 中 importScripts 存在，helpers 会被正常加载；命令函数体内的 helpers
// 引用只在真正调用对应命令时才求值，不影响存量会话隔离测试。
if (typeof importScripts === 'function') {
  importScripts('api-command-helpers.js');
}

const DEFAULT_WS_URL = 'ws://localhost:8765';
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
// 目标 MCP 服务地址，持久化到 storage.local；默认本机，可指向任意远程 MCP 服务。
let currentWsUrl = DEFAULT_WS_URL;
// sessionId -> { groupId, agentKey, scope, state: 'active'|'idle', lastActiveAt, color }，持久化到 storage.local
// 键为「实例键 instanceKey」：每个并发会话实例独占一个组，互不串页面。
let sessionGroups = null;
let sessionGroupsLoading = null;
const sessionGroupQueues = new Map(); // sessionId -> promise 链，防止并发重复建组
const sessionLastTab = new Map();     // sessionId -> 组内最近使用的 tabId
let activeSessions = new Set();       // Leader 下发的活跃实例键列表
// instanceKey -> { agentKey, scope }：归属键与粒度，用于判断能否安全认领闲置组
const activeSessionInfo = new Map();
// 最近一次认领尝试的诊断信息（便于排查「为什么没认领」）
let lastReclaim = null;
let gcConfig = { ttlMinutes: DEFAULT_GROUP_TTL_MINUTES, maxGroups: DEFAULT_MAX_GROUPS, allowCrossAgentReclaim: false };
const tabQueues = new Map();          // tabId -> promise 链（同 tab 串行）
let foregroundLock = Promise.resolve(); // 全局前台互斥锁
let cdpSocket = null;
let cdpTabId = null;
const MAX_OPERATION_LOGS = 100;
const operationLogs = [];
const READ_ONLY_BLOCKED_COMMANDS = new Set(['click', 'clickAt', 'type']);
// CDP Network capture state: per-tab buffers of captured resources
// 【回归红线】networkCaptures / networkListener / REPLAY_FORBIDDEN_HEADERS / 现有 replay 一行不改。
const networkCaptures = new Map(); // tabId -> { resources: [], active: boolean, filter: object }

// ===== API 命令集：分析会话状态（放扩展侧，Leader/Follower 最终连同一扩展，天然一致）=====
// analysisId -> {
//   analysisId, tabId, sessionId, options, ownedDebugger, startedAt,
//   requestDetails: Map<requestId, {url, method, headerNames(仅字段名), postData, hasPostData, type, initiatorType, timestamp}>,
//   responses: Map<requestId, {url, status, mimeType, type, timestamp}>,
//   samples: ResponseBodySample[]（Q8，仅内存，stop 后立即丢弃）,
//   samplePending: Set<Promise>, redactedHeaderNames: Set<string>, warnings: string[]
// }
const apiAnalysisSessions = new Map();
let apiAnalysisListenerActive = false;

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
  'probeCapabilities',
  // 仅增量追加这三个（TAB_SCOPED_API_MESSAGES）；apiCommandExecute 不加入（免开网页前提）。
  // 使用字面量而非 MSG.*：MSG 由 api-command-helpers.js 提供，vm 沙箱加载器不执行该文件；
  // 值与 MSG.ANALYSIS_START / MSG.ANALYSIS_STOP / MSG.BUNDLE_COLLECT 逐字一致。
  'apiAnalysisStart', 'apiAnalysisStop', 'apiBundleCollect'
]);
// 需要按「目标 URL」而非当前标签 URL 做安全校验的消息类型（扩展侧真正的安全边界）。
// 字面量 'apiCommandExecute' 与 MSG.COMMAND_EXECUTE 逐字一致，加载期不依赖 helpers。
const API_EXECUTION_TYPES = new Set(['apiCommandExecute']);
// bundle 补采：不执行任何写操作，但会带着页面登录态去取文本 —— 必须逐个 URL 过域名白名单。
const BUNDLE_COLLECT_TYPES = new Set(['apiBundleCollect']);

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

  // ===== API 命令集安全补齐（设计 1.3.5 落点 #3，仅新增类型分支，不改既有行为）=====
  // 扩展侧完全不读 confirm：它不是安全边界（客户端可随意置 true）。
  // 真正的边界是 popup 写入的 chrome.storage.local（WS 客户端不可写）。
  if (API_EXECUTION_TYPES.has(msg.type)) {
    if (settings.readOnlyMode && msg.options && msg.options.risk === 'write') {
      throw new Error(formatApiError('READ_ONLY_BLOCKED'));
    }
    // 按目标 URL 校验：协议 http(s) + hostname 精确相等（Q13）+ 域名白名单。
    // 校验的是 msg.options.url，而非当前标签 URL，避免「页面在白名单、请求打到外域」。
    assertApiTargetUrl(msg.options?.url, msg.options?.hostname, settings.allowedDomains);
  }

  // bundle 补采：只读，但会带着页面登录态去取文本。逐个 URL 校验，任一不合法即整体拒绝
  // （fail-closed，避免「一部分取到了才报错」造成半截数据）。
  if (BUNDLE_COLLECT_TYPES.has(msg.type)) {
    const urls = Array.isArray(msg.options?.urls) ? msg.options.urls : [];
    const declared = (Array.isArray(msg.options?.hosts) ? msg.options.hosts : [])
      .map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
    let tabHost = '';
    if (msg.tabId) {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        tabHost = tab && tab.url ? new URL(tab.url).hostname.toLowerCase() : '';
      } catch { /* tab 已关闭时留空，按 declared 校验 */ }
    }
    for (const raw of urls.slice(0, 10)) {
      let parsed;
      try {
        parsed = new URL(String(raw || ''));
      } catch {
        throw new Error(formatApiError('INVALID_URL'));
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(formatApiError('INVALID_URL'));
      }
      if (parsed.username || parsed.password) throw new Error(formatApiError('INVALID_URL'));
      const host = parsed.hostname.toLowerCase();
      // 只允许「当前页面自身」或调用方显式声明的 host —— 不允许顺手取任意站点的 bundle。
      if (host !== tabHost && !declared.includes(host)) throw new Error(formatApiError('HOST_MISMATCH'));
      if (settings.allowedDomains.length > 0
          && !settings.allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) {
        throw new Error(formatApiError('DOMAIN_NOT_ALLOWED'));
      }
    }
  }

  if (!settings.allowedDomains.length || !TAB_SCOPED_COMMANDS.has(msg.type)) return;
  // msg.tabId 已在 handleDaemonMessage 中解析为本 session 的具体 tab
  const tab = msg.type === 'navigate' ? null : await chrome.tabs.get(msg.tabId);
  const url = msg.type === 'navigate' ? msg.url : tab?.url;
  if (!isUrlAllowed(url, settings.allowedDomains)) throw new Error(`Blocked by domain allowlist: ${url || 'unknown URL'}`);
}

// ===== WebSocket 客户端 =====

// 校验并归一化地址：缺省协议自动补 ws://，http(s) 映射为 ws(s)://；
// 非法值返回空串，由调用方回退到默认地址。
function normalizeWsUrl(value) {
  let candidate = String(value || '').trim();
  if (!candidate) return '';
  if (!candidate.includes('://')) candidate = `ws://${candidate}`;
  try {
    const parsed = new URL(candidate);
    let protocol = parsed.protocol;
    if (protocol === 'http:') protocol = 'ws:';
    else if (protocol === 'https:') protocol = 'wss:';
    if (protocol !== 'ws:' && protocol !== 'wss:') return '';
    if (!parsed.hostname) return '';
    const suffix = `${parsed.pathname}${parsed.search}`.replace(/\/+$/, '');
    return `${protocol}//${parsed.host}${suffix}`;
  } catch {
    return '';
  }
}

async function loadWsUrl() {
  const { wsUrl } = await chrome.storage.local.get('wsUrl');
  currentWsUrl = normalizeWsUrl(wsUrl) || DEFAULT_WS_URL;
  return currentWsUrl;
}

async function saveWsUrl(value) {
  const url = normalizeWsUrl(value) || DEFAULT_WS_URL;
  currentWsUrl = url;
  await chrome.storage.local.set({ wsUrl: url });
  return url;
}

// 其他上下文（如 popup 保存）改动地址后同步到内存缓存
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.wsUrl) {
    currentWsUrl = normalizeWsUrl(changes.wsUrl.newValue) || DEFAULT_WS_URL;
  }
});

void loadWsUrl();

async function connectWebSocket(url) {
  const targetUrl = normalizeWsUrl(url) || await loadWsUrl();
  if (ws?.readyState === WebSocket.OPEN && isConnected) {
    return { success: true, alreadyConnected: true };
  }
  if (connectingPromise) return connectingPromise;

  // Retire a socket that is still connecting or has become stale. Its guarded
  // callbacks cannot clear the state of the new connection.
  if (ws) {
    const staleSocket = ws;
    ws = null;
    try { staleSocket.close(); } catch { /* already closed */ }
  }

  const socket = new WebSocket(targetUrl);
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
      currentWsUrl = targetUrl;
      startHeartbeat(socket);
      broadcastStatus(true, targetUrl);
      console.log('[WebPilot] WebSocket connected:', targetUrl);
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
      settle(reject, { success: false, error: `无法连接到 ${targetUrl}，请确认 MCP 服务已启动` });
    };

    // 5秒超时
    setTimeout(() => {
      if (ws === socket && !isConnected) {
        try { socket.close(); } catch { /* already closed */ }
        settle(reject, { success: false, error: `连接 ${targetUrl} 超时，请确认 MCP 服务已启动` });
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
  // 新增落点 #7：断连时一并清空分析会话（含 Q8 样本）、移除独立 listener、
  // 只 detach 分析会话自己独占的 debugger（绝不 detach 别人的）。
  cleanupApiAnalysisSessions();
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
  // 记录该实例的归属键与粒度（认领决策需要）
  if (msg.agentKey) {
    activeSessionInfo.set(sessionId, {
      agentKey: String(msg.agentKey),
      scope: msg.agentScope === 'session' ? 'session' : 'host'
    });
  }
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
      await cmdGetPageText(msg.tabId, msg.maxChars, msg.returnHtml, msg.requestId);
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

    // ===== API 命令集：3 个新消息（回包原样带 requestId + success）=====
    // case 表达式在 switch 求值时会被依次计算，故这里必须用字面量而非 MSG.*：
    // 值与 MSG.ANALYSIS_START / MSG.ANALYSIS_STOP / MSG.COMMAND_EXECUTE 逐字一致，
    // 保证 background.js 在「未加载 helpers.js」的 vm 沙箱中也能完成 switch 分发。
    case 'apiAnalysisStart':
      await cmdApiAnalysisStart(msg, msg.requestId);
      break;
    case 'apiAnalysisStop':
      await cmdApiAnalysisStop(msg, msg.requestId);
      break;
    case 'apiCommandExecute':
      await cmdApiCommandExecute(msg, msg.requestId, sessionId);
      break;
    case 'apiBundleCollect':
      await cmdApiBundleCollect(msg, msg.requestId);
      break;

    case 'screenshot':
      await cmdScreenshot(msg.tabId, msg.requestId);
      break;
    case 'listTabs':
      await cmdListTabs(msg.requestId, sessionId);
      break;
    case 'claimSession':
      await cmdClaimSession(msg.options, msg.requestId, sessionId);
      break;
    case 'getSessionStatus':
      await cmdGetSessionStatus(msg.requestId);
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

// ===== 会话标签组：一个会话实例 = 一个标签组 =====
async function getSessionGroups() {
  if (sessionGroups) return sessionGroups;
  if (!sessionGroupsLoading) {
    // service worker 休眠/浏览器重启后从 storage.local 恢复映射
    sessionGroupsLoading = chrome.storage.local.get(['sessionGroups', 'gcConfig']).then(stored => {
      if (!sessionGroups) sessionGroups = stored.sessionGroups || {};
      if (stored.gcConfig) gcConfig = { ...gcConfig, ...stored.gcConfig };
      // 迁移：旧结构没有 agentKey/scope，归属键取原键（legacy 组，仅供认领兼容）
      let migrated = false;
      for (const [key, entry] of Object.entries(sessionGroups)) {
        if (!entry || typeof entry !== 'object') { delete sessionGroups[key]; migrated = true; continue; }
        if (!entry.agentKey) { entry.agentKey = key; entry.scope = 'legacy'; migrated = true; }
        if (!entry.state) { entry.state = 'active'; migrated = true; }
      }
      if (migrated) saveSessionGroups();
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

/** 标签组标题：归属键 + 实例后缀，肉眼可分辨是哪个会话实例。 */
function groupTitle(sessionKey, idle, entry) {
  const agent = (entry && entry.agentKey) || sessionKey;
  const instance = entry && entry.agentKey && entry.agentKey !== sessionKey
    ? String(sessionKey).slice(-6)
    : '';
  const label = `${String(agent).slice(0, 20)}${instance ? '-' + instance : ''}`;
  return `${SESSION_GROUP_PREFIX}·${label}${idle ? '·idle' : ''}`;
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
  // 组键是实例键：同归属键的另一个并发实例同样视为「别人的组」，一并拒绝
  if (owner && owner !== sessionId) {
    throw new Error(`Tab ${tabId} belongs to another session instance's group "${groupTitle(owner, groups[owner].state === 'idle', groups[owner])}". Use a tab in your own WebPilot group or omit tabId.`);
  }
}

async function getTargetTabId(tabId, sessionId) {
  if (tabId) {
    // sessionId 缺省时为内部调用（tab 已经过跨组校验），直接放行
    if (sessionId) await assertTabUsableBySession(tabId, sessionId);
    return tabId;
  }
  const session = sessionId || DEFAULT_SESSION_ID;
  let groupId = await getSessionGroupId(session);
  if (groupId === null) {
    // 先认领闲置组（会话重启后回到自己的组），认领不到再新建
    groupId = await claimIdleGroupFor(session);
  }
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

// ===== 认领（接管闲置组）=====

/** 统计同一归属键下当前存活的实例数（含当前实例）。 */
function liveInstanceCount(agentKey, currentInstanceKey) {
  let count = 0;
  for (const [instanceKey, info] of activeSessionInfo.entries()) {
    if (instanceKey !== currentInstanceKey && !activeSessions.has(instanceKey)) continue;
    if (info.agentKey === agentKey) count++;
  }
  return count;
}

/**
 * 自动认领决策：
 *  规则1 同一归属键下有 ≥2 个存活实例 → 归属键区分不了会话 → 不认领（避免认错他人组）
 *  规则2 归属键会话级(scope=session) → 认领最近活动的同归属键闲置组
 *  规则3 归属键宿主级 + 仅 1 个候选 → 认领（候选唯一，歧义消失）
 *  规则4 其余情况 → 不认领，另建新组
 */
function pickReclaimableGroup(groups, instanceKey) {
  const info = activeSessionInfo.get(instanceKey) || { agentKey: instanceKey, scope: 'host' };
  const liveCount = liveInstanceCount(info.agentKey, instanceKey);
  const diag = { instanceKey, agentKey: info.agentKey, scope: info.scope, liveCount };
  if (liveCount >= 2) { // 规则1
    lastReclaim = { ...diag, rule: "r1-ambiguous", claimed: null };
    return null;
  }
  const candidates = Object.keys(groups)
    .filter(key => key !== instanceKey && groups[key] && groups[key].state === 'idle'
      && (groups[key].agentKey || key) === info.agentKey)
    .sort((a, b) => (groups[b].lastActiveAt || 0) - (groups[a].lastActiveAt || 0));
  if (!candidates.length) {
    lastReclaim = { ...diag, rule: "no-candidate", claimed: null };
    return null;
  }
  if (info.scope === 'session') {
    lastReclaim = { ...diag, rule: "r2-session-scope", claimed: candidates[0] };
    return candidates[0];
  }
  if (candidates.length === 1) {
    lastReclaim = { ...diag, rule: "r3-single-candidate", claimed: candidates[0] };
    return candidates[0];
  }
  lastReclaim = { ...diag, rule: "r4-multi-candidate", claimed: null };
  return null;
}

/** 跨归属键认领（默认关闭：会连带继承他人标签页与登录态）。 */
function pickAnyIdleGroup(groups, instanceKey) {
  const candidates = Object.keys(groups)
    .filter(key => key !== instanceKey && groups[key] && groups[key].state === 'idle')
    .sort((a, b) => (groups[a].lastActiveAt || 0) - (groups[b].lastActiveAt || 0));
  return candidates[0] || null;
}

/**
 * 认领一个闲置组给当前会话实例（幂等）：会话重启后回到自己的组，保留原 tab 与登录态。
 * 认领顺序必须在「解析默认 tab」之前，否则会先建新 tab 再认领，认不回原来的页面。
 */
async function claimIdleGroupFor(session) {
  const groups = await getSessionGroups();
  if (groups[session]) return groups[session].groupId; // 已有组，无需认领
  const reclaimKey = pickReclaimableGroup(groups, session)
    || (gcConfig.allowCrossAgentReclaim ? pickAnyIdleGroup(groups, session) : null);
  if (!reclaimKey) return null;
  const reclaimed = groups[reclaimKey];
  const info = activeSessionInfo.get(session) || { agentKey: session, scope: 'host' };
  groups[session] = {
    groupId: reclaimed.groupId,
    agentKey: info.agentKey,
    scope: info.scope,
    state: 'active',
    lastActiveAt: Date.now(),
    color: reclaimed.color
  };
  delete groups[reclaimKey];
  // 记住原会话最后使用的 tab：认领后默认落回同一个页面
  const remembered = sessionLastTab.get(reclaimKey);
  if (remembered) sessionLastTab.set(session, remembered);
  sessionLastTab.delete(reclaimKey);
  await saveSessionGroups();
  logOperation({ action: 'reclaimGroup', success: true, sessionId: session, details: `reclaimed ${reclaimKey}` });
  try {
    await chrome.tabGroups.update(reclaimed.groupId, {
      title: groupTitle(session, false, groups[session]),
      color: reclaimed.color || pickGroupColor(groups),
      collapsed: false
    });
  } catch { /* 组可能已被关闭 */ }
  // 认领来的 tab 纳入受管集合（域名白名单跳转拦截需要）
  try {
    for (const tab of await chrome.tabs.query({ groupId: reclaimed.groupId })) managedTabs.add(tab.id);
  } catch { /* 组已失效 */ }
  return reclaimed.groupId;
}

async function addTabToSessionGroup(tabId, sessionId) {
  const groups = await getSessionGroups();
  const tab = await chrome.tabs.get(tabId);
  const session = sessionId || DEFAULT_SESSION_ID;
  let entry = groups[session];
  let groupId = await getSessionGroupId(session);

  if (groupId === null) {
    // 会话还没有组：先认领同归属键的闲置组，认领不到才新建
    groupId = await claimIdleGroupFor(session);
    entry = groups[session];
  }

  if (groupId !== null) {
    const group = await chrome.tabGroups.get(groupId);
    // Chrome 标签组只属于一个窗口；把 tab 移到组所在窗口保持单组
    if (group.windowId !== tab.windowId) await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
    if (tab.groupId !== groupId) await chrome.tabs.group({ tabIds: [tabId], groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  }

  const info = activeSessionInfo.get(session) || { agentKey: session, scope: 'host' };
  const wasActive = entry && entry.groupId === groupId && entry.state === 'active';
  const color = entry?.color || pickGroupColor(groups);
  groups[session] = {
    groupId,
    agentKey: info.agentKey,
    scope: info.scope,
    state: 'active',
    lastActiveAt: Date.now(),
    color
  };
  if (!wasActive) {
    await chrome.tabGroups.update(groupId, { title: groupTitle(session, false, groups[session]), color, collapsed: false });
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

// 目标页不可注入时，给调用方一句能照着做的说明，而不是把 Chrome 的原文直接抛出去。
// about:blank（会话组里还没有页面时新建的占位页）、chrome://、扩展商店页面都无法注入。
// 注：chrome.scripting 的 InjectionTarget 不接受 matchAboutBlank（实测会被 Chrome 以
// Unexpected property 拒绝），所以 about:blank 只能靠 CDP 通道或先 navigate 来覆盖。
function describeInjectionFailure(error, tab) {
  const message = String(error?.message || error || '');
  const url = String(tab?.url || '');
  if (!url || url === 'about:blank' || /^(about|chrome|edge|devtools|view-source):/i.test(url) || /chromewebstore\.google\.com/i.test(url)) {
    return `目标标签页当前是 ${url || '(空白页)'}，扩展无法在其上执行页面操作：请先用 navigate 打开目标网址，或用 tabId 指定一个普通网页。`;
  }
  if (/must request permission|Cannot access contents/i.test(message)) {
    return `扩展无权访问该页面（${url}）：chrome://、扩展商店等浏览器保留页面不允许注入，请改用普通 http(s) 页面。`;
  }
  return message;
}

async function callPageTool(tabId, method, args = []) {
  if (!tabId) throw new Error('No active tab');
  const world = MAIN_WORLD_METHODS.has(method) ? 'MAIN' : 'ISOLATED';
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* tab 已关闭，交给下面的注入报错 */ }
  try {
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
  } catch (error) {
    throw new Error(describeInjectionFailure(error, tab));
  }
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

async function cmdGetPageText(tabId, maxChars, returnHtml, requestId) {
  const target = await getTargetTabId(tabId);
  try {
    const result = await callPageTool(target, 'readText', [maxChars, !!returnHtml]);
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

// ===== 方案 2: 页面代码执行 =====
// 目标页面的 CSP 常禁止 eval / new Function（'unsafe-eval' 不在 script-src 白名单），
// 注入执行会直接失败：Evaluating a string as JavaScript violates ... Content Security Policy。
// 因此优先走 CDP Runtime.evaluate —— 调试器通道不受页面 CSP 限制，任何页面都能执行代码；
// 只有调试通道本身不可用时（DevTools 已占用、chrome:// 页面等）才退回注入执行。
async function evaluateViaCdp(tabId, expression, timeoutMs) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const response = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...(typeof timeoutMs === 'number' && timeoutMs > 0 ? { timeout: timeoutMs } : {})
    });
    if (response?.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Evaluation failed';
      return { error: `Evaluation failed: ${detail}` };
    }
    const remote = response?.result || {};
    const value = 'value' in remote ? remote.value : remote.description;
    const type = remote.type === 'object' ? (Array.isArray(value) ? 'array' : 'object') : remote.type;
    return { result: value, type };
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* already detached */ }
  }
}

async function cmdEvaluate(expression, options, tabId, requestId) {
  const target = await getTargetTabId(tabId);
  const startedAt = Date.now();
  try {
    let result;
    try {
      result = await evaluateViaCdp(target, expression, options?.timeoutMs);
    } catch (cdpError) {
      logOperation({ action: 'evaluateCdp', tabId: target, success: false, error: cdpError.message });
      try {
        result = await callPageTool(target, 'safeEvaluate', [expression, options || {}]);
      } catch (fallbackError) {
        throw new Error(`${fallbackError.message}（CDP 通道不可用: ${cdpError.message}）`);
      }
    }
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

// ===========================================================================
// ===== API 命令集：分析会话 + Q8 采样 + 免开网页执行（与现有抓包平行，互不干扰）=====
//
// 回归红线：本区块**不修改** networkCaptures / networkListener / REPLAY_FORBIDDEN_HEADERS /
// cmdReplayApiRequest 的 redirect:'follow'。分析用独立 apiAnalysisSessions + 独立
// apiAnalysisListener，start 时 addListener、stop 时 removeListener；
// 同 tab 已有活跃 networkCaptures 时复用同一 debugger session，只加 listener、不重复
// attach，也绝不 detach 别人的。
// ===========================================================================

/** 断连 / 扩展重载时清空分析会话（含 Q8 样本），只 detach 自己独占的 debugger。 */
function cleanupApiAnalysisSessions() {
  for (const session of apiAnalysisSessions.values()) {
    session.samples.length = 0;          // Q8 样本值立即丢弃
    session.samplePending.clear();
    session.requestDetails.clear();
    session.responses.clear();
    if (session.ownedDebugger) {
      try { chrome.debugger.detach({ tabId: session.tabId }); } catch { /* already detached */ }
    }
  }
  apiAnalysisSessions.clear();
  if (apiAnalysisListenerActive) {
    try { chrome.debugger.onEvent.removeListener(apiAnalysisListener); } catch { /* not added */ }
    apiAnalysisListenerActive = false;
  }
}

/** AbortSignal.timeout 兜底（部分 Chrome 版本缺失时退回 AbortController）。 */
function apiAbortSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

/**
 * 独立的 CDP Network 事件监听器（与现有 networkListener 平行）。
 * 按 source.tabId 分发到该 tab 的分析会话；header **只取字段名，绝不取值**；
 * postData 只在内存供 MCP 侧参数推断，绝不落盘、绝不进日志。
 */
function apiAnalysisListener(source, method, params) {
  if (!source || typeof source.tabId !== 'number') return;
  for (const session of apiAnalysisSessions.values()) {
    if (session.tabId !== source.tabId) continue;
    handleAnalysisEvent(session, method, params || {});
  }
}

function handleAnalysisEvent(session, method, params) {
  if (method === 'Network.requestWillBeSent') {
    const request = params.request || {};
    const headerNames = Object.keys(request.headers || {}).map((key) => String(key).toLowerCase());
    for (const name of apiRedactHeaderNames(headerNames)) session.redactedHeaderNames.add(name);
    // 与现有抓包一致：请求详情 Map 上限 1000，防止内存膨胀。
    if (session.requestDetails.size > 1000) {
      const firstKey = session.requestDetails.keys().next().value;
      session.requestDetails.delete(firstKey);
    }
    session.requestDetails.set(params.requestId, {
      url: typeof request.url === 'string' ? request.url : '',
      method: String(request.method || '').toUpperCase(),  // CDP 真实 HTTP method
      headerNames: headerNames.slice(0, MAX_HEADER_NAME_LENGTH),
      postData: typeof request.postData === 'string' ? request.postData : null,
      hasPostData: request.hasPostData === true || typeof request.postData === 'string',
      type: String(params.type || '').toLowerCase(),
      initiatorType: String((params.initiator && params.initiator.type) || ''),
      timestamp: Number(params.timestamp) || 0
    });
    return;
  }

  if (method === 'Network.responseReceived') {
    const response = params.response || {};
    session.responses.set(params.requestId, {
      url: typeof response.url === 'string' ? response.url : '',
      status: Number(response.status) || 0,
      mimeType: String(response.mimeType || '').toLowerCase(),
      type: String(params.type || '').toLowerCase(),
      timestamp: Number(params.timestamp) || 0
    });
    return;
  }

  // Q8：仅 captureResponseBody=true 时，在 loadingFinished 后限量取响应体。
  if (method === 'Network.loadingFinished' && session.options.captureResponseBody === true) {
    collectResponseBodySample(session, params.requestId);
  }
}

/** Q8 采样：候选判定 → Network.getResponseBody → 只把样本留在会话内存。 */
function collectResponseBodySample(session, requestId) {
  if (session.samples.length + session.samplePending.size >= MAX_RESPONSE_SAMPLES) return;
  const detail = session.requestDetails.get(requestId);
  const response = session.responses.get(requestId);
  const candidate = {
    type: (detail && detail.type) || (response && response.type) || '',
    mimeType: (response && response.mimeType) || '',
    status: response ? response.status : 0
  };
  if (!isSampleCandidate(candidate)) return;
  const task = chrome.debugger.sendCommand(
    { tabId: session.tabId },
    'Network.getResponseBody',
    { requestId }
  ).then((result) => {
    const bodyText = decodeCdpResponseBody(result);
    if (!bodyText || session.samples.length >= MAX_RESPONSE_SAMPLES) return;
    session.samples.push({
      requestId,
      contentType: candidate.mimeType,
      status: candidate.status,
      bodyText,
      truncated: false
    });
  }).catch(() => {
    // 缓存命中 / 重定向 / body 不可用等情况直接跳过，绝不猜测或回显内容。
  }).finally(() => {
    session.samplePending.delete(task);
  });
  session.samplePending.add(task);
}

/** 把会话内 join 好的 CDP 数据组装成 RawCapturedRecord[]（只含 header 字段名）。 */
function buildAnalysisRecords(session) {
  const records = [];
  const filter = session.options.filter || {};
  for (const [requestId, detail] of session.requestDetails) {
    if (filter.urlContains && !detail.url.includes(filter.urlContains)) continue;
    const response = session.responses.get(requestId);
    if (filter.mimeType && !(response && response.mimeType || '').includes(filter.mimeType)) continue;
    let host = '';
    let path = '/';
    let query = '';
    try {
      const parsed = new URL(detail.url);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname || '/';
      query = parsed.search.replace(/^\?/, '');
    } catch { /* URL 非法时留空，由 MCP 侧 normalizeRecords 跳过 */ }
    records.push({
      requestId,
      url: detail.url,
      method: detail.method,
      host,
      path,
      query,
      status: response ? response.status : 0,
      mimeType: response ? response.mimeType : '',
      resourceType: detail.type || (response && response.type) || '',
      initiatorType: detail.initiatorType,
      timestamp: detail.timestamp,
      headerNames: detail.headerNames,
      postData: detail.postData,
      hasPostData: detail.hasPostData
    });
  }
  return records;
}

/**
 * analyze_current 兼容入口：从现有 networkCaptures 缓冲区一次性解析。
 * 只读 `requestDetails` / `resources` 的字段名与元数据，**不新建会话、不采样响应体**。
 * 注意：networkCaptures.requestDetails 里的 headers 是原值，这里只取 Object.keys（字段名）。
 */
function buildCurrentRecords(capture) {
  const records = [];
  if (!capture) return records;
  const responsesByRequestId = new Map();
  for (const entry of (capture.resources || [])) {
    if (entry && entry.requestId) responsesByRequestId.set(entry.requestId, entry);
  }
  for (const [requestId, detail] of (capture.requestDetails || new Map())) {
    const response = responsesByRequestId.get(requestId);
    let host = '';
    let path = '/';
    let query = '';
    try {
      const parsed = new URL(detail.url);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname || '/';
      query = parsed.search.replace(/^\?/, '');
    } catch { /* 同上 */ }
    records.push({
      requestId,
      url: typeof detail.url === 'string' ? detail.url : '',
      method: String(detail.method || '').toUpperCase(),
      host,
      path,
      query,
      status: Number(response && response.status) || 0,
      mimeType: String((response && response.mimeType) || '').toLowerCase(),
      resourceType: String(detail.type || (response && response.type) || '').toLowerCase(),
      initiatorType: String(detail.initiatorType || ''),
      timestamp: Number(detail.timestamp) || 0,
      headerNames: Object.keys(detail.headers || {}).map((key) => String(key).toLowerCase()),
      postData: typeof detail.postData === 'string' ? detail.postData : null,
      hasPostData: detail.hasPostData === true || typeof detail.postData === 'string'
    });
  }
  return records;
}

/** apiAnalysisStart：按 tab 唯一 + 全局并发上限；debugger 冲突时复用 session。 */
async function cmdApiAnalysisStart(msg, requestId) {
  const startedAt = Date.now();
  const options = rebuildStartOptions(msg.options);
  const tabId = msg.tabId;  // 已由 handleDaemonMessage 经 getTargetTabId 解析（TAB_SCOPED）
  try {
    for (const session of apiAnalysisSessions.values()) {
      if (session.tabId === tabId) {
        sendToDaemon({
          type: MSG_RESULT.ERROR,
          requestId,
          success: false,
          error: formatApiError('ANALYSIS_IN_PROGRESS', session.analysisId)
        });
        return;
      }
    }
    if (apiAnalysisSessions.size >= MAX_CONCURRENT_ANALYSES) {
      sendToDaemon({
        type: MSG_RESULT.ERROR,
        requestId,
        success: false,
        error: formatApiError('ANALYSIS_IN_PROGRESS', '全局并发上限')
      });
      return;
    }

    const analysisId = options.analysisId || `an_${Date.now()}_auto`;
    // 待明确 7：已有活跃 networkCaptures → 复用同一 debugger，只 addListener、不重复 attach。
    const existingCapture = networkCaptures.get(tabId);
    const reuseDebugger = !!(existingCapture && existingCapture.active);
    let ownedDebugger = false;
    if (!reuseDebugger) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* not attached */ }
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
      ownedDebugger = true;
    }

    apiAnalysisSessions.set(analysisId, {
      analysisId,
      tabId,
      options,
      ownedDebugger,
      startedAt: new Date().toISOString(),
      requestDetails: new Map(),
      responses: new Map(),
      samples: [],
      samplePending: new Set(),
      redactedHeaderNames: new Set(),
      warnings: []
    });
    if (!apiAnalysisListenerActive) {
      chrome.debugger.onEvent.addListener(apiAnalysisListener);
      apiAnalysisListenerActive = true;
    }

    logOperation(safeLogForApiExecute({
      action: 'apiAnalysisStart', success: true, durationMs: Date.now() - startedAt
    }));
    sendToDaemon({
      type: MSG_RESULT.ANALYSIS_START,
      requestId,
      success: true,
      analysisId,
      tabId,
      captureResponseBody: options.captureResponseBody,
      message: 'API analysis session started'
    });
  } catch (e) {
    logOperation(safeLogForApiExecute({
      action: 'apiAnalysisStart', success: false, durationMs: Date.now() - startedAt
    }));
    sendToDaemon({
      type: MSG_RESULT.ERROR,
      requestId,
      success: false,
      error: formatApiError('ANALYSIS_IN_PROGRESS')
    });
  }
}

/** apiAnalysisStop：停止并回传 records[] + samples[]，随后立即清空会话内存。 */
async function cmdApiAnalysisStop(msg, requestId) {
  const startedAt = Date.now();
  const options = rebuildStopOptions(msg.options);
  const tabId = msg.tabId;
  // analyze_current 兼容入口：显式标记，不新建会话、不采样、只读现有缓冲区。
  const analyzeCurrent = msg.analyzeCurrent === true;

  if (analyzeCurrent) {
    const records = buildCurrentRecords(networkCaptures.get(tabId));
    const warnings = [ANALYZE_CURRENT_REVIEW_REASON];
    logOperation(safeLogForApiExecute({
      action: 'apiAnalysisStop', success: true, durationMs: Date.now() - startedAt
    }));
    sendToDaemon({
      type: MSG_RESULT.ANALYSIS_STOP,
      requestId,
      success: true,
      analysisId: options.analysisId || '',
      records,
      samples: [],                        // 兼容入口绝不采样响应体
      redactedHeaderNames: [],
      warnings,
      sampledResponseCount: 0,
      tabId
    });
    return;
  }

  let session = options.analysisId ? apiAnalysisSessions.get(options.analysisId) : null;
  if (!session) {
    // Follower 进程可能丢失 analysisId 提示：按 tab 兜底定位会话。
    for (const candidate of apiAnalysisSessions.values()) {
      if (candidate.tabId === tabId) { session = candidate; break; }
    }
  }
  if (!session) {
    sendToDaemon({
      type: MSG_RESULT.ERROR,
      requestId,
      success: false,
      error: formatApiError('NO_ANALYSIS_SESSION')
    });
    return;
  }

  // 等待在途的 getResponseBody，避免漏掉最后几条样本（样本值仍在内存）。
  if (session.samplePending.size > 0) {
    await Promise.allSettled([...session.samplePending]);
  }
  const records = buildAnalysisRecords(session);
  const samples = session.samples.slice(0, MAX_RESPONSE_SAMPLES);
  const redactedHeaderNames = [...session.redactedHeaderNames].sort();
  const warnings = [...session.warnings];
  const analysisId = session.analysisId;
  const ownedDebugger = session.ownedDebugger;

  // 只 removeListener 自己的；不 detach 别人的（复用 networkCaptures 时 ownedDebugger=false）。
  apiAnalysisSessions.delete(analysisId);
  if (apiAnalysisSessions.size === 0 && apiAnalysisListenerActive) {
    try { chrome.debugger.onEvent.removeListener(apiAnalysisListener); } catch { /* not added */ }
    apiAnalysisListenerActive = false;
  }
  if (ownedDebugger) {
    try { await chrome.debugger.detach({ tabId: session.tabId }); } catch { /* already detached */ }
  }
  // 回包发出后立刻丢弃引用：样本值不驻留、不落盘、不进日志。
  session.samples.length = 0;
  session.requestDetails.clear();
  session.responses.clear();

  logOperation(safeLogForApiExecute({
    action: 'apiAnalysisStop', success: true, durationMs: Date.now() - startedAt
  }));
  sendToDaemon({
    type: MSG_RESULT.ANALYSIS_STOP,
    requestId,
    success: true,
    analysisId,
    records,
    samples,
    redactedHeaderNames,
    warnings,
    sampledResponseCount: samples.length,
    tabId
  });
}

/**
 * apiBundleCollect：扩展侧「带登录态补采 JS bundle」。
 *
 * 动机：登录态站点的 bundle 常按会话鉴权，Node 直读 401；浏览器页面上下文天然持有会话。
 * 因此把「取文本」下沉到扩展，取到的文本回传 MCP 侧交给**同一个 scanSources()** 解析
 * —— 扫描逻辑只有一份，扩展侧不做任何接口推断。
 *
 * 三层 fallback，任一层拿到即停（顺序与 BUNDLE_COLLECT_VIAS 逐字一致）：
 *   page   页面上下文 fetch：与页面同源同站，SameSite=Lax/Strict 的会话 Cookie 全部生效；
 *   worker Service Worker fetch：有 host_permissions、不受 CORS 限制；但跨站时 SameSite 严格
 *          Cookie 可能不被带上，故排在页面上下文之后；
 *   cache  CDP Page.getResourceContent：直接读浏览器缓存里已加载过的原始字节，最保真；
 *          需要临时 attach debugger，被 devtools / 分析会话占用时静默跳过该层。
 *
 * 硬约束：只取文本，不取 header / cookie；请求固定 GET + credentials:'include'，
 * 不给调用方任何注入 method / header / body 的入口；原文只在局部变量与回包中流转，
 * 不写 chrome.storage、不进 operationLogs、不跨调用驻留。
 */
async function cmdApiBundleCollect(msg, requestId) {
  const startedAt = Date.now();
  const tabId = msg.tabId;
  const options = rebuildBundleCollectOptions(msg.options);
  const warnings = [];
  try {
    if (!tabId) throw new Error(formatApiError('NO_ANALYSIS_SESSION'));

    // 二次防御：assertCommandAllowed 已校验过一遍，这里仍逐个 URL 复核（不经存储状态）。
    for (const url of options.urls) {
      const verdict = apiCheckBundleUrl(url, options.hosts);
      if (!verdict.ok) {
        throw new Error(formatApiError(verdict.reason === 'host' ? 'HOST_MISMATCH' : 'INVALID_URL'));
      }
    }

    // 1) 发现：只取 URL 列表，不取内容。
    let candidates = options.urls.slice();
    let discovered = 0;
    if (options.discover) {
      const scanned = await apiWithTimeout(
        runInPageContext(tabId, apiCollectBundleCandidatesInPage, []),
        options.timeoutMs + 2000
      );
      if (Array.isArray(scanned)) {
        discovered = scanned.length;
        for (const raw of scanned) {
          const verdict = apiCheckBundleUrl(raw, options.hosts);
          if (verdict.ok && candidates.indexOf(verdict.url) === -1) candidates.push(verdict.url);
        }
      }
    }
    candidates = candidates.slice(0, options.maxSources);
    if (candidates.length === 0) {
      warnings.push(BUNDLE_COLLECT_EMPTY_WARNING);
      logOperation(safeLogForApiExecute({
        action: 'apiBundleCollect', success: true, durationMs: Date.now() - startedAt
      }));
      sendToDaemon({
        type: MSG_RESULT.BUNDLE_COLLECT, requestId, success: true,
        sources: [], requested: 0, collected: 0, discovered, warnings
      });
      return;
    }

    // 2) 逐条三层补采；总量预算与墙钟预算用尽即停止后续 URL（避免撞上 bridge 的 30s 超时）。
    const sources = [];
    const deadline = startedAt + BUNDLE_COLLECT_WALL_BUDGET_MS;
    let totalBytes = 0;
    let failures = 0;
    let truncated = false;
    for (const url of candidates) {
      const remaining = BUNDLE_COLLECT_MAX_TOTAL_BYTES - totalBytes;
      if (remaining <= 0) { truncated = true; break; }
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 500) { truncated = true; break; }
      const budget = Math.min(options.maxBytes, remaining);
      const perCall = Math.min(options.timeoutMs, timeLeft);
      const collected = await collectOneBundle(tabId, url, budget, perCall, options.hosts, options.useBrowserCache);
      if (!collected) { failures += 1; continue; }
      totalBytes += collected.bytes;
      if (collected.truncated) truncated = true;
      sources.push({ url, ok: true, text: collected.text, via: collected.via, bytes: collected.bytes });
    }
    if (failures > 0) warnings.push(BUNDLE_COLLECT_FAILED_WARNING);
    if (truncated) warnings.push(BUNDLE_COLLECT_TRUNCATED_WARNING);

    logOperation(safeLogForApiExecute({
      action: 'apiBundleCollect', success: true, durationMs: Date.now() - startedAt
    }));
    sendToDaemon({
      type: MSG_RESULT.BUNDLE_COLLECT, requestId, success: true,
      sources, requested: candidates.length, collected: sources.length, discovered, warnings
    });
  } catch (e) {
    logOperation(safeLogForApiExecute({
      action: 'apiBundleCollect', success: false, durationMs: Date.now() - startedAt
    }));
    sendToDaemon({ type: MSG_RESULT.ERROR, requestId, success: false, error: e.message });
  }
}

/** 给 executeScript 的等待套一层上限，避免注入环境卡死拖垮整条命令。 */
async function apiWithTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => undefined),
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 在页面上下文执行一个自包含函数；页面受限 / 注入失败时返回 undefined。 */
async function runInPageContext(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    const first = Array.isArray(results) ? results[0] : null;
    return first ? first.result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 注入页面上下文：列出当前页面已加载的脚本 URL。
 * 只读 DOM 与 performance 条目，**不取任何内容**、不发任何请求。
 */
function apiCollectBundleCandidatesInPage() {
  const out = [];
  const push = (raw) => {
    if (!raw) return;
    try {
      const url = new URL(String(raw), location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      const value = url.toString();
      if (out.indexOf(value) === -1) out.push(value);
    } catch { /* 非法 URL 跳过 */ }
  };
  try {
    const scripts = document.querySelectorAll('script[src]');
    for (let i = 0; i < scripts.length; i += 1) push(scripts[i].getAttribute('src'));
  } catch { /* ignore */ }
  try {
    const entries = performance.getEntriesByType('resource');
    for (let i = 0; i < entries.length; i += 1) {
      const kind = String(entries[i].initiatorType || '').toLowerCase();
      const name = String(entries[i].name || '');
      if (kind === 'script' || /\.(?:m?js|cjs|jsx|ts|tsx)(?:$|[?#])/i.test(name)) push(name);
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * 注入页面上下文：在页面里 fetch 一段文本。
 * 与页面同源同站 → SameSite 严格 / Lax 的会话 Cookie 都会被带上，等价于页面自己发请求。
 * 跳转后复查最终 host（防 3xx 跳到外域），超预算按字节截断并标记。
 */
async function apiFetchBundleInPage(targetUrl, timeoutMs, maxBytes, allowedHosts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(targetUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'force-cache',
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: '*/*' }
    });
    if (!resp.ok) return { ok: false };
    let finalHost = '';
    try { finalHost = new URL(resp.url || targetUrl).hostname.toLowerCase(); } catch { finalHost = ''; }
    const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
    if (!finalHost || hosts.indexOf(finalHost) === -1) return { ok: false };
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(maxBytes > 0 && buffer.byteLength > maxBytes ? buffer.slice(0, maxBytes) : buffer);
    const text = new TextDecoder('utf-8').decode(bytes);
    if (!text) return { ok: false };
    return { ok: true, text, truncated: buffer.byteLength > bytes.byteLength };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** 层 2：Service Worker fetch（host_permissions 生效，不受 CORS 限制）。 */
async function apiFetchBundleFromWorker(targetUrl, timeoutMs, maxBytes, hosts) {
  try {
    const resp = await fetch(targetUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'force-cache',
      redirect: 'follow',
      headers: { accept: '*/*' },
      signal: apiAbortSignal(timeoutMs)
    });
    if (!resp.ok) return null;
    let finalHost = '';
    try { finalHost = new URL(resp.url || targetUrl).hostname.toLowerCase(); } catch { finalHost = ''; }
    if (!finalHost || (hosts.length > 0 && hosts.indexOf(finalHost) === -1)) return null;
    const buffer = await resp.arrayBuffer();
    const exceeded = maxBytes > 0 && buffer.byteLength > maxBytes;
    const bytes = new Uint8Array(exceeded ? buffer.slice(0, maxBytes) : buffer);
    const text = new TextDecoder('utf-8').decode(bytes);
    if (!text) return null;
    return { text, via: 'worker', bytes: text.length, truncated: exceeded };
  } catch {
    return null;
  }
}

/** 层 3：CDP 读浏览器缓存里「已加载过」的原始响应字节（最保真）。 */
async function apiCollectBundlesFromBrowserCache(tabId, urls) {
  const found = new Map();
  if (!urls.length) return found;
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
  } catch {
    return found;   // devtools / 分析会话已占用 → 放弃该层，不影响前两层结果
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    const tree = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
    const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
    if (!frameId) return found;
    for (const url of urls) {
      try {
        const res = await chrome.debugger.sendCommand({ tabId }, 'Page.getResourceContent', { frameId, url });
        if (res && typeof res.content === 'string' && res.content) found.set(url, res.content);
      } catch { /* 未加载过 / 已过期 → 跳过 */ }
    }
  } catch { /* Page domain 不可用 → 放弃该层 */ } finally {
    if (attached) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
    }
  }
  return found;
}

/** 单 URL 三层补采；全部失败返回 null。 */
async function collectOneBundle(tabId, url, maxBytes, timeoutMs, hosts, useBrowserCache) {
  // 层 1：页面上下文
  const page = await apiWithTimeout(
    runInPageContext(tabId, apiFetchBundleInPage, [url, timeoutMs, maxBytes, hosts]),
    timeoutMs + 2000
  );
  if (page && page.ok === true && typeof page.text === 'string' && page.text) {
    return { text: page.text, via: 'page', bytes: page.text.length, truncated: page.truncated === true };
  }
  // 层 2：Service Worker
  const worker = await apiFetchBundleFromWorker(url, timeoutMs, maxBytes, hosts);
  if (worker) return worker;
  // 层 3：浏览器缓存
  if (useBrowserCache) {
    const cached = await apiCollectBundlesFromBrowserCache(tabId, [url]);
    const text = cached.get(url);
    if (typeof text === 'string' && text) {
      const exceeded = maxBytes > 0 && text.length > maxBytes;
      return {
        text: exceeded ? text.slice(0, maxBytes) : text,
        via: 'cache',
        bytes: exceeded ? maxBytes : text.length,
        truncated: exceeded
      };
    }
  }
  return null;
}

/**
 * apiCommandExecute：免开网页执行（完全不读 networkCaptures.requestDetails）。
 * 输入是「持久化模板 + params 渲染后的最终 url」，用扩展 SW 的 fetch 由 Chrome
 * 自动按最终 URL 匹配 Cookie（credentials:'include'），不手工拼 Cookie、不落盘凭据。
 * 安全：目标 URL 白名单 + hostname 精确相等 + readOnly/emergencyStop（assertCommandAllowed）；
 * 请求 header 只用 accept/content-type 最小白名单；redirect:'manual' + fail-closed。
 */
async function cmdApiCommandExecute(msg, requestId, sessionId) {
  const startedAt = Date.now();
  const options = rebuildExecuteOptions(msg.options);
  const logBase = {
    action: 'apiCommandExecute',
    method: options.method,
    hostname: options.hostname,
    risk: options.risk
  };
  try {
    // 待明确 4：允许省略 tabId（免开网页前提）；显式传时沿用 getTargetTabId 跨组拒绝。
    if (typeof msg.tabId === 'number' && Number.isFinite(msg.tabId)) {
      try {
        await getTargetTabId(msg.tabId, sessionId);
      } catch {
        throw new Error(formatApiError('DOMAIN_NOT_ALLOWED'));
      }
    }
    if (!options.url || !options.method || !options.hostname) {
      throw new Error(formatApiError('INVALID_URL'));
    }
    // 二次防御：即使 assertCommandAllowed 被绕过，这里仍按目标 URL 复核。
    const settings = await getSecuritySettings();
    if (settings.emergencyStopped) throw new Error(formatApiError('EMERGENCY_STOPPED'));
    assertApiTargetUrl(options.url, options.hostname, settings.allowedDomains);

    // 请求 header 最小白名单：绝不从缓存 / 抓包 / 消息恢复任何 header 值。
    const headers = {};
    if (API_COMMAND_ALLOWED_HEADERS.includes('accept')) headers['Accept'] = 'application/json';
    if (options.body !== null && API_COMMAND_ALLOWED_HEADERS.includes('content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(options.url, {
      method: options.method,
      headers,
      ...(options.body !== null ? { body: options.body } : {}),
      credentials: 'include',
      redirect: 'manual',
      signal: apiAbortSignal(Math.min(options.timeoutMs, API_EXEC_TIMEOUT_MS))
    });

    // fail-closed：3xx / opaqueredirect（status 0、Location 不可读）一律阻断，不逐跳跟随。
    if (resp.type === 'opaqueredirect' || resp.status === 0
        || (resp.status >= 300 && resp.status < 400)) {
      throw new Error(formatApiError('REDIRECT_BLOCKED'));
    }

    let text = await resp.text();
    let truncated = false;
    if (text.length > options.maxBodyChars) {
      text = text.slice(0, options.maxBodyChars);
      truncated = true;
    }
    const contentType = resp.headers.get('content-type') || '';
    let body = text;
    if (contentType.includes('json')) {
      try { body = JSON.parse(text); } catch { /* 保留截断文本 */ }
    }
    const durationMs = Date.now() - startedAt;
    const authRequired = resp.status === 401 || resp.status === 403;
    const errorCode = !resp.ok ? (authRequired ? 'AUTH_REQUIRED' : 'HTTP_ERROR') : undefined;

    // 日志只含 action/method/hostname/risk/status/success/durationMs，绝不记 url / body / 响应体 / header 值。
    logOperation(safeLogForApiExecute({
      ...logBase, status: resp.status, success: resp.ok, durationMs
    }));
    sendToDaemon({
      type: MSG_RESULT.COMMAND_EXECUTE,
      requestId,
      success: true,          // 传输层成功；业务状态由 status / errorCode 表达
      status: resp.status,
      statusText: resp.statusText,
      contentType,
      body,
      bodyLength: text.length,
      truncated,
      durationMs,
      httpOk: resp.ok,
      authRequired,
      ...(errorCode ? { errorCode } : {})
    });
  } catch (e) {
    const raw = String((e && e.message) || '');
    let code = 'NETWORK_ERROR';
    const pipe = raw.indexOf('|');
    if (pipe > 0 && API_ERROR_CODES.includes(raw.slice(0, pipe))) {
      code = raw.slice(0, pipe);
    } else if (/abort|timeout/i.test(raw)) {
      code = 'EXTENSION_TIMEOUT';
    }
    logOperation(safeLogForApiExecute({
      ...logBase, status: 0, success: false, durationMs: Date.now() - startedAt
    }));
    sendToDaemon({
      type: MSG_RESULT.ERROR,
      requestId,
      success: false,
      error: formatApiError(code),
      errorCode: code
    });
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

async function cmdListTabs(requestId, sessionId) {
  const tabs = await chrome.tabs.query({});
  const { allowedDomains } = await getSecuritySettings();
  let visibleTabs = allowedDomains.length ? tabs.filter(tab => isUrlAllowed(tab.url, allowedDomains)) : tabs;
  // 会话内可见：过滤掉其它会话实例组里的 tab（避免泄露别的会话的页面与凭据）
  const groups = await getSessionGroups();
  const myGroupId = sessionId ? groups[sessionId]?.groupId : undefined;
  visibleTabs = visibleTabs.filter(tab =>
    typeof tab.groupId !== 'number' || tab.groupId < 0 || tab.groupId === myGroupId);
  sendToDaemon({
    type: 'listTabsResult',
    requestId,
    success: true,
    tabs: visibleTabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
  });
}

// 显式认领：把指定的闲置组接管给当前会话实例（自动认领不可用时的兜底）
async function cmdClaimSession(options, requestId, sessionId) {
  try {
    const groups = await getSessionGroups();
    const session = sessionId || DEFAULT_SESSION_ID;
    const ownGroupId = groups[session]?.groupId;
    let targetKey = null;
    if (options && typeof options.groupId === 'number') {
      targetKey = Object.keys(groups).find(key => groups[key].groupId === options.groupId) || null;
    } else if (options && typeof options.agentKey === 'string') {
      targetKey = Object.keys(groups).find(key => (groups[key].agentKey || key) === options.agentKey) || null;
    }
    if (!targetKey) {
      sendToDaemon({ type: 'claimSessionResult', requestId, success: false, error: '未找到可认领的标签组' });
      return;
    }
    const entry = groups[targetKey];
    if (entry.state !== 'idle') {
      sendToDaemon({ type: 'claimSessionResult', requestId, success: false, error: '目标标签组正在被其他会话使用，无法认领' });
      return;
    }
    if (ownGroupId && ownGroupId !== entry.groupId) {
      sendToDaemon({ type: 'claimSessionResult', requestId, success: false, error: '当前会话已持有标签组，无法同时认领第二个' });
      return;
    }
    const info = activeSessionInfo.get(session) || { agentKey: session, scope: 'host' };
    groups[session] = {
      groupId: entry.groupId,
      agentKey: info.agentKey,
      scope: info.scope,
      state: 'active',
      lastActiveAt: Date.now(),
      color: entry.color
    };
    delete groups[targetKey];
    sessionLastTab.delete(targetKey);
    await saveSessionGroups();
    const tabs = await chrome.tabs.query({ groupId: entry.groupId });
    await chrome.tabGroups.update(entry.groupId, {
      title: groupTitle(session, false, groups[session]),
      color: entry.color || pickGroupColor(groups),
      collapsed: false
    });
    logOperation({ action: 'claimSession', success: true, sessionId: session, details: `claimed ${targetKey}` });
    sendToDaemon({
      type: 'claimSessionResult',
      requestId,
      success: true,
      groupId: entry.groupId,
      tabCount: tabs.length,
      agentKey: info.agentKey,
      instanceKey: session
    });
  } catch (e) {
    logOperation({ action: 'claimSession', success: false, error: e.message });
    sendToDaemon({ type: 'claimSessionResult', requestId, success: false, error: e.message });
  }
}

// 会话状态：实例列表 + 标签组 + 归属键粒度（便于排查隔离/认领行为）
async function cmdGetSessionStatus(requestId) {
  try {
    const groups = await getSessionGroups();
    const sessions = await getSessionSummaries();
    const live = [];
    for (const [instanceKey, info] of activeSessionInfo.entries()) {
      live.push({ instanceKey, agentKey: info.agentKey, scope: info.scope, alive: activeSessions.has(instanceKey) });
    }
    sendToDaemon({
      type: 'sessionStatusResult',
      requestId,
      success: true,
      sessions,
      live,
      lastReclaim,
      activeSessions: [...activeSessions],
      config: gcConfig
    });
  } catch (e) {
    sendToDaemon({ type: 'sessionStatusResult', requestId, success: false, error: e.message });
  }
}

async function cmdGetOperationLog(requestId) {
  sendToDaemon({ type: 'operationLogResult', requestId, success: true, entries: operationLogs });
}

// ===== 标签组生命周期：闲置标记、TTL/上限回收、手动清理 =====
function ensureGroupGcAlarm() {
  return chrome.alarms.create(GROUP_GC_ALARM, { periodInMinutes: GROUP_GC_PERIOD_MINUTES });
}

async function handleSessionUpdate(msg) {
  const ids = Array.isArray(msg.activeSessions) ? msg.activeSessions.filter(id => typeof id === 'string') : [];
  activeSessions = new Set(ids);
  // 新版服务端会下发完整身份列表；旧版只有实例键列表 → 归属键退化为实例键本身（不自动认领）
  const sessions = Array.isArray(msg.sessions) ? msg.sessions : null;
  activeSessionInfo.clear();
  if (sessions && sessions.length) {
    for (const s of sessions) {
      if (!s || typeof s.instanceKey !== 'string') continue;
      activeSessionInfo.set(s.instanceKey, {
        agentKey: typeof s.agentKey === 'string' && s.agentKey ? s.agentKey : s.instanceKey,
        scope: s.scope === 'session' ? 'session' : 'host'
      });
    }
  } else {
    for (const id of ids) activeSessionInfo.set(id, { agentKey: id, scope: 'host' });
  }
  if (msg.config) {
    gcConfig = {
      ttlMinutes: Number.isFinite(msg.config.ttlMinutes) ? msg.config.ttlMinutes : DEFAULT_GROUP_TTL_MINUTES,
      maxGroups: Number.isFinite(msg.config.maxGroups) && msg.config.maxGroups > 0 ? msg.config.maxGroups : DEFAULT_MAX_GROUPS,
      allowCrossAgentReclaim: msg.config.allowCrossAgentReclaim === true
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
      ? { title: groupTitle(sessionId, true, entry), color: 'grey', collapsed: true }
      : { title: groupTitle(sessionId, false, entry), color: entry.color || pickGroupColor(groups), collapsed: false });
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
    const entry = groups[sessionId];
    let tabCount = 0;
    try {
      tabCount = (await chrome.tabs.query({ groupId: entry.groupId })).length;
    } catch {
      continue;
    }
    sessions.push({
      sessionId,
      instanceKey: sessionId,
      agentKey: entry.agentKey || sessionId,
      scope: entry.scope || 'host',
      state: entry.state,
      tabCount,
      title: groupTitle(sessionId, entry.state === 'idle', entry),
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
    Promise.all([getSecuritySettings(), getSessionSummaries(), loadWsUrl()])
      .then(([security, sessions, wsUrl]) => sendResponse({ connected: isConnected, wsUrl, tabCount: managedTabs.size, security, sessions }));
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
      .then(() => saveWsUrl(msg.wsUrl))
      .then(url => connectWebSocket(url))
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
