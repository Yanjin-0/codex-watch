const statusText = document.getElementById('statusText');
const statusHint = document.getElementById('statusHint');
const statusBadge = document.getElementById('statusBadge');
const fetchedAt = document.getElementById('fetchedAt');
const sourceUrl = document.getElementById('sourceUrl');
const evidence = document.getElementById('evidence');
const excerpt = document.getElementById('excerpt');
const lanUrls = document.getElementById('lanUrls');
const connectionState = document.getElementById('connectionState');
const refreshBtn = document.getElementById('refreshBtn');
const notifyBtn = document.getElementById('notifyBtn');
const copyBtn = document.getElementById('copyBtn');
const pollInfo = document.getElementById('pollInfo');

const POLL_MS = 60_000;
let lastState = null;
let pollTimer = null;
let countdownTimer = null;
let countdownLeft = POLL_MS / 1000;
let meta = null;

function setBadge(state) {
  statusBadge.classList.remove('badge-neutral', 'badge-yes', 'badge-no');
  if (state === 'yes') {
    statusBadge.classList.add('badge-yes');
    statusBadge.textContent = '已重置';
  } else if (state === 'no') {
    statusBadge.classList.add('badge-no');
    statusBadge.textContent = '未重置';
  } else {
    statusBadge.classList.add('badge-neutral');
    statusBadge.textContent = '資訊不足';
  }
}

function formatTime(value) {
  if (!value) return '--';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function updateCountdownLabel() {
  pollInfo.textContent = `${countdownLeft}s`;
}

function startCountdown() {
  countdownLeft = POLL_MS / 1000;
  updateCountdownLabel();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdownLeft -= 1;
    if (countdownLeft <= 0) {
      countdownLeft = POLL_MS / 1000;
    }
    updateCountdownLabel();
  }, 1000);
}

function speakStatusChange(data) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  const title = data.state === 'yes' ? 'Codex 額度已重置' : data.state === 'no' ? 'Codex 額度尚未重置' : 'Codex 額度狀態更新';
  const body = data.evidence || '已收到最新結果。';
  const notification = new Notification(title, {
    body,
    icon: '/icon.svg',
    badge: '/icon.svg',
  });

  setTimeout(() => notification.close(), 6000);
}

async function loadMeta() {
  try {
    const res = await fetch('/api/meta');
    meta = await res.json();
    sourceUrl.textContent = meta.targetUrl;
    lanUrls.innerHTML = meta.urls
      .map((url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`)
      .join('<br />');
  } catch (error) {
    lanUrls.textContent = `無法取得連線資訊：${error.message}`;
  }
}

function renderStatus(data) {
  lastState = data.state;
  if (data.sourceUrl) {
    sourceUrl.textContent = data.sourceUrl;
  }
  statusText.textContent =
    data.state === 'yes' ? '看起來已經重置' : data.state === 'no' ? '目前還沒重置' : '還無法判斷';
  statusHint.textContent = data.evidence || data.error || '沒有更多細節。';
  setBadge(data.state);
  fetchedAt.textContent = formatTime(data.fetchedAt);
  evidence.textContent = data.evidence || '--';
  excerpt.textContent = (data.excerpt || []).join('\n') || '--';
  connectionState.textContent = data.ok ? '連線正常' : data.stale ? '使用暫存資料' : '連線失敗';
  if (data.error) {
    connectionState.textContent = `${connectionState.textContent} · ${data.error}`;
  }
}

async function refresh() {
  refreshBtn.disabled = true;
  connectionState.textContent = '更新中...';

  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    const data = await res.json();
    const previousState = lastState;
    renderStatus(data);

    if (previousState && previousState !== data.state) {
      speakStatusChange(data);
      if (navigator.vibrate) {
        navigator.vibrate([80, 50, 80]);
      }
    }
  } catch (error) {
    connectionState.textContent = `更新失敗：${error.message}`;
    statusHint.textContent = '暫時無法更新，請稍後再試。';
    setBadge('unknown');
  } finally {
    refreshBtn.disabled = false;
    startCountdown();
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    alert('這個瀏覽器不支援通知。');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    notifyBtn.textContent = '通知已開啟';
    notifyBtn.disabled = true;
    new Notification('Codex Reset Watch', {
      body: '已開啟通知，之後狀態變化會提醒你。',
      icon: '/icon.svg',
    });
  }
}

async function copyMobileLink() {
  const url = meta?.urls?.[0] || window.location.origin;
  try {
    await navigator.clipboard.writeText(url);
    copyBtn.textContent = '已複製';
    setTimeout(() => {
      copyBtn.textContent = '複製手機連結';
    }, 1500);
  } catch {
    alert(`請手動開啟這個網址：${url}`);
  }
}

refreshBtn.addEventListener('click', refresh);
notifyBtn.addEventListener('click', enableNotifications);
copyBtn.addEventListener('click', copyMobileLink);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

loadMeta().finally(() => {
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
});

startCountdown();
