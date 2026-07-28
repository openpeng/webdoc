// popup.js — 连接状态展示

const statusCard = document.getElementById('statusCard');
const statusText = document.getElementById('statusText');
const statusDetail = document.getElementById('statusDetail');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const tabCountEl = document.getElementById('tabCount');

const WS_URL = 'ws://localhost:8765';

function setStatus(state, detail) {
  statusCard.className = 'status-card';
  if (state === 'connected') {
    statusCard.classList.add('status-connected');
    statusText.textContent = '已连接';
    statusDetail.textContent = detail || 'MCP 服务运行正常';
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  } else if (state === 'connecting') {
    statusCard.classList.add('status-pending');
    statusText.textContent = '连接中...';
    statusDetail.textContent = detail || '正在连接本地服务';
    connectBtn.disabled = true;
    disconnectBtn.disabled = true;
  } else {
    statusCard.classList.add('status-disconnected');
    statusText.textContent = '未连接';
    statusDetail.textContent = detail || '请启动本地 MCP 服务';
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }
}

// 加载时查询后台的连接状态
chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
  if (res && res.connected) {
    setStatus('connected', `已连接 ${res.wsUrl || WS_URL}`);
    tabCountEl.textContent = res.tabCount || 0;
  } else {
    setStatus('disconnected');
    tabCountEl.textContent = 0;
  }
});

connectBtn.addEventListener('click', () => {
  setStatus('connecting');
  chrome.runtime.sendMessage({ type: 'connect', wsUrl: WS_URL }, (res) => {
    if (res && res.success) {
      setStatus('connected', `已连接 ${WS_URL}`);
      tabCountEl.textContent = res.tabCount || 0;
    } else {
      setStatus('disconnected', res?.error || '连接失败，请检查本地服务是否启动');
    }
  });
});

disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    setStatus('disconnected');
    tabCountEl.textContent = 0;
  });
});

// 监听来自 background 的状态变化
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'statusChange') {
    if (msg.connected) {
      setStatus('connected', `已连接 ${msg.wsUrl || WS_URL}`);
      tabCountEl.textContent = msg.tabCount || 0;
    } else {
      setStatus('disconnected', msg.reason || '连接已断开');
      tabCountEl.textContent = 0;
    }
  }
  if (msg.type === 'tabCountChange') {
    tabCountEl.textContent = msg.count || 0;
  }
});
