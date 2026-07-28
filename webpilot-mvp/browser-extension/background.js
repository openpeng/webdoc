// background.js — Service Worker，管理 WebSocket 连接和 CDP

const WS_URL = 'ws://localhost:8765';

let ws = null;
let isConnected = false;
let managedTabs = new Set();
let cdpSocket = null;
let cdpTabId = null;

// ===== WebSocket 客户端 =====
function connectWebSocket(url = WS_URL) {
  return new Promise((resolve, reject) => {
    if (ws && isConnected) {
      resolve({ success: true, alreadyConnected: true });
      return;
    }

    ws = new WebSocket(url);

    ws.onopen = () => {
      isConnected = true;
      broadcastStatus(true, url);
      console.log('[WebPilot] WebSocket connected:', url);
      resolve({ success: true });
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await handleDaemonMessage(msg);
      } catch (e) {
        console.error('[WebPilot] Parse message error:', e);
      }
    };

    ws.onclose = () => {
      isConnected = false;
      ws = null;
      broadcastStatus(false, null, '连接已关闭');
      console.log('[WebPilot] WebSocket disconnected');
    };

    ws.onerror = (err) => {
      isConnected = false;
      ws = null;
      console.error('[WebPilot] WebSocket error:', err);
      reject({ success: false, error: `无法连接到 ${url}，请确认 daemon 已启动` });
    };

    // 5秒超时
    setTimeout(() => {
      if (!isConnected) {
        ws = null;
        reject({ success: false, error: '连接超时，请确认 daemon 已启动' });
      }
    }, 5000);
  });
}

function disconnectWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnected = false;
  managedTabs.clear();
  cdpSocket = null;
  cdpTabId = null;
  broadcastStatus(false);
}

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

  switch (msg.type) {
    case 'navigate':
      await cmdNavigate(msg.url, msg.tabId);
      break;
    case 'click':
      await cmdClick(msg.selector, msg.tabId);
      break;
    case 'type':
      await cmdType(msg.selector, msg.text, msg.tabId);
      break;
    case 'getPageInfo':
      await cmdGetPageInfo(msg.tabId);
      break;
    case 'screenshot':
      await cmdScreenshot(msg.tabId);
      break;
    case 'executeJs':
      await cmdExecuteJs(msg.script, msg.tabId);
      break;
    case 'listTabs':
      await cmdListTabs();
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

async function cmdNavigate(url, tabId) {
  const targetTab = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!targetTab) {
    sendToDaemon({ type: 'navigateResult', success: false, error: 'No active tab' });
    return;
  }
  try {
    const tab = await chrome.tabs.update(targetTab, { url });
    managedTabs.add(tab.id);
    chrome.runtime.sendMessage({ type: 'tabCountChange', count: managedTabs.size }).catch(()=>{});
    sendToDaemon({ type: 'navigateResult', success: true, tabId: tab.id, url: tab.url, title: tab.title });
  } catch (e) {
    sendToDaemon({ type: 'navigateResult', success: false, error: e.message });
  }
}

async function cmdClick(selector, tabId) {
  const target = await getTargetTabId(tabId);
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: target },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { success: false, error: 'Element not found: ' + sel };
        el.click();
        return { success: true, tagName: el.tagName, text: el.textContent?.slice(0, 100) };
      },
      args: [selector]
    });
    sendToDaemon({ type: 'clickResult', ...result.result });
  } catch (e) {
    sendToDaemon({ type: 'clickResult', success: false, error: e.message });
  }
}

async function cmdType(selector, text, tabId) {
  const target = await getTargetTabId(tabId);
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: target },
      func: (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return { success: false, error: 'Element not found: ' + sel };
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, tagName: el.tagName };
      },
      args: [selector, text]
    });
    sendToDaemon({ type: 'typeResult', ...result.result });
  } catch (e) {
    sendToDaemon({ type: 'typeResult', success: false, error: e.message });
  }
}

async function cmdGetPageInfo(tabId) {
  const target = await getTargetTabId(tabId);
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: target },
      func: () => {
        const interactive = Array.from(document.querySelectorAll('a, button, input, textarea, select'))
          .filter(el => el.offsetParent !== null)
          .map((el, i) => ({
            index: i,
            tag: el.tagName.toLowerCase(),
            type: el.type,
            text: el.textContent?.trim().slice(0, 60),
            placeholder: el.placeholder,
            id: el.id,
            class: el.className?.slice(0, 50),
            href: el.href?.slice(0, 100)
          }));
        return {
          url: location.href,
          title: document.title,
          interactiveElements: interactive.slice(0, 30),
          elementCount: interactive.length
        };
      }
    });
    sendToDaemon({ type: 'pageInfoResult', success: true, ...result.result });
  } catch (e) {
    sendToDaemon({ type: 'pageInfoResult', success: false, error: e.message });
  }
}

async function cmdScreenshot(tabId) {
  const target = await getTargetTabId(tabId);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    // 转为 base64 字符串
    const base64 = dataUrl.split(',')[1];
    sendToDaemon({ type: 'screenshotResult', success: true, data: base64, format: 'png' });
  } catch (e) {
    sendToDaemon({ type: 'screenshotResult', success: false, error: e.message });
  }
}

async function cmdExecuteJs(script, tabId) {
  const target = await getTargetTabId(tabId);
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: target },
      func: (code) => {
        try {
          const res = eval(code);
          return { success: true, result: typeof res === 'object' ? JSON.stringify(res) : String(res) };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [script]
    });
    sendToDaemon({ type: 'executeJsResult', ...result.result });
  } catch (e) {
    sendToDaemon({ type: 'executeJsResult', success: false, error: e.message });
  }
}

async function cmdListTabs() {
  const tabs = await chrome.tabs.query({});
  sendToDaemon({
    type: 'listTabsResult',
    success: true,
    tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
  });
}

function sendToDaemon(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ===== Message Router =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({ connected: isConnected, wsUrl: WS_URL, tabCount: managedTabs.size });
    return true;
  }
  if (msg.type === 'connect') {
    connectWebSocket(msg.wsUrl || WS_URL)
      .then(r => sendResponse(r))
      .catch(e => sendResponse(e));
    return true; // async
  }
  if (msg.type === 'disconnect') {
    disconnectWebSocket();
    sendResponse({ success: true });
    return true;
  }
});
