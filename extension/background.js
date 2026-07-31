'use strict';
/**
 * Tony bridge — background service worker.
 *
 * Owns the WebSocket to the local Tony app. The AWS console's CSP blocks
 * WebSockets opened from content scripts (they inherit the page's
 * connect-src), so the socket lives here in extension context and commands
 * are relayed to the console tab via chrome.tabs.sendMessage.
 *
 * A ping every 20s keeps both the socket and this worker alive (Chrome 116+
 * extends service-worker lifetime on active WebSocket traffic).
 */

const TONY_WS = 'ws://127.0.0.1:8787/tony';
const CONSOLE_URLS = [
  'https://*.console.aws.amazon.com/*',
  'https://console.aws.amazon.com/*',
  'https://health.aws.amazon.com/*',
];

let ws = null;
let retryMs = 1000;
let pingTimer = null;

async function consoleTab() {
  // Prefer the focused console tab; fall back to the most recently active one.
  const active = await chrome.tabs.query({ url: CONSOLE_URLS, active: true, lastFocusedWindow: true });
  if (active[0]) return active[0];
  const any = await chrome.tabs.query({ url: CONSOLE_URLS });
  any.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return any[0] ?? null;
}

async function handle(msg) {
  const { id, cmd, args = {} } = msg;
  try {
    const tab = await consoleTab();
    if (!tab) throw new Error('no AWS console tab open');
    const res = await chrome.tabs.sendMessage(tab.id, { cmd, args });
    if (!res) throw new Error('console tab did not answer — reload the tab');
    ws?.send(JSON.stringify({ id, ok: res.ok, data: res.data, error: res.error }));
  } catch (e) {
    ws?.send(JSON.stringify({ id, ok: false, error: String(e.message || e).slice(0, 200) }));
  }
}

function connect() {
  try { ws = new WebSocket(TONY_WS); } catch { scheduleRetry(); return; }
  ws.onopen = async () => {
    retryMs = 1000;
    const tab = await consoleTab().catch(() => null);
    ws.send(JSON.stringify({ event: 'hello', url: tab?.url ?? null, title: tab?.title ?? null }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ event: 'ping' }));
    }, 20000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.cmd) handle(msg);
  };
  ws.onclose = () => { ws = null; clearInterval(pingTimer); scheduleRetry(); };
  ws.onerror = () => { try { ws?.close(); } catch { /* already closed */ } };
}

function scheduleRetry() {
  setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 15000);
}

connect();
// Also reconnect on browser startup / extension reload.
chrome.runtime.onStartup?.addListener(() => { if (!ws) connect(); });
