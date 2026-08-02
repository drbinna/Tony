'use strict';
/**
 * ExtensionBridge — the Chrome-extension counterpart of Pilot.
 *
 * Same surface the Lesson loop already drives (snapshot / highlight / click /
 * type / press / goto / url / alive), but perception and action happen inside
 * the learner's OWN Chrome via the Tony content script, over a localhost
 * WebSocket. Their login, their tabs, their session — Tony just sees the
 * console page they have open and acts in it with consent.
 *
 * Bound to 127.0.0.1 only. The newest console tab to say hello is the active
 * one; a tab that navigates away simply stops answering and the next hello
 * takes over.
 */
const { WebSocketServer } = require('ws');

class ExtensionBridge {
  constructor({ port = 8787, log = console } = {}) {
    this.port = port;
    this.log = log;
    this.wss = null;
    this.sock = null;
    this.lastUrl = null;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.seq = 0;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port, path: '/tony' });
      this.wss.on('error', reject);
      this.wss.on('listening', () => resolve(this));
      this.wss.on('connection', (sock, req) => {
        // Ordinary web pages CAN open sockets to localhost, and a malicious
        // page impersonating the extension could feed Tony fake snapshots or
        // watch his commands. Browsers stamp an unforgeable Origin on browser-
        // context connections, so require the extension's. (A hostile native
        // process can still forge the header — that's outside this threat
        // model; the browser is the boundary this bridge defends.)
        const origin = req.headers.origin || '';
        if (!origin.startsWith('chrome-extension://')) {
          this.log.warn?.(`[bridge] REJECTED connection from origin "${origin || '<none>'}"`);
          sock.close(1008, 'origin not allowed');
          return;
        }
        this.sock = sock;
        sock.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg.event === 'hello') {
            this.lastUrl = msg.url;
            this.extVersion = msg.version ?? null;
            this.log.log?.(`[bridge] console tab connected (extension v${this.extVersion ?? '<0.5 — RELOAD the extension>'})`);
            return;
          }
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(msg.error || 'extension error'));
        });
        sock.on('close', () => { if (this.sock === sock) this.sock = null; });
      });
    });
  }

  alive() {
    return !!this.sock && this.sock.readyState === 1;
  }

  url() {
    return this.lastUrl;
  }

  request(cmd, args = {}, timeoutMs = 12000) {
    if (!this.alive()) {
      return Promise.reject(new Error('no console tab connected — is the Tony extension loaded and an AWS console tab open?'));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension ${cmd} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.send(JSON.stringify({ id, cmd, args }));
    });
  }

  // ---- Pilot-compatible surface (what browser/lesson.js drives) ----

  async snapshot() {
    const snap = await this.request('snapshot');
    this.lastUrl = snap.url;
    return snap;
  }

  async highlight({ role, name, nth = 0 }) {
    // Returns proof from the page: the matched role/name and its rect.
    return await this.request('highlight', { role, name, nth });
  }

  async click({ role, name, nth = 0 }) {
    await this.request('click', { role, name, nth });
  }

  async type({ role, name, nth = 0 }, text) {
    await this.request('type', { role, name, nth, text });
  }

  async press(key) {
    await this.request('press', { key });
  }

  async goto(url) {
    await this.request('goto', { url });
  }

  async screenshot() {
    throw new Error('screenshots are not available through the extension bridge');
  }

  async close() {
    this.wss?.close();
    this.wss = null;
    this.sock = null;
  }
}

module.exports = { ExtensionBridge };
