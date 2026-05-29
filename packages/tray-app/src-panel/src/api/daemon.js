/**
 * Daemon HTTP 客户端 — 控制面板版
 *
 * 在原 web/src/api/daemon.js 基础上增加：
 *   getOverview()  → GET /api/overview
 *   getCommands()  → GET /api/commands?limit=N
 *   getLogs()      → GET /api/logs?level=&limit=N
 *
 * 端口/Token 从 daemon 的 /ping 端点自动获取（复用 web 版逻辑）。
 */

// Tauri 环境下通过 Rust 的 get_status 命令获取端口；
// 开发环境（vite dev）下回退到默认端口。
function getBaseUrl() {
  // 控制面板运行在 Tauri WebView 内时，通过 Tauri IPC 获取端口。
  // 暂时用固定端口；Phase D 会从 Tauri state 读取实际端口。
  const port = window.__PANEL_DAEMON_PORT__ ?? 19824;
  return `http://127.0.0.1:${port}`;
}

function generateId() {
  return crypto.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

export class DaemonClient {
  constructor() {
    this._connected = false;
    this._token = null;
    this._healthTimer = null;
    this._handlers = new Map();
  }

  async connect() {
    const base = getBaseUrl();
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${base}/ping`);
        if (res.ok) {
          const data = await res.json();
          this._token = data.token ?? null;
          this._connected = true;
          this._emit('connected');
          this._startHealthCheck();
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Cannot connect to daemon at ${base}`);
  }

  disconnect() {
    clearInterval(this._healthTimer);
    this._healthTimer = null;
    this._connected = false;
  }

  _startHealthCheck() {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(async () => {
      try {
        const res = await fetch(`${getBaseUrl()}/ping`);
        if (!res.ok) throw new Error('ping failed');
        this._connected = true;
      } catch {
        this._connected = false;
        this._emit('disconnected');
      }
    }, 5000);
  }

  // ── Core command ──────────────────────────────────────────

  async send(action, params = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;

    const res = await fetch(`${getBaseUrl()}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: generateId(), action, ...params }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── New MVP 2 endpoints ───────────────────────────────────

  async getOverview() {
    return this._get('/api/overview');
  }

  async getCommands(limit = 50) {
    return this._get(`/api/commands?limit=${limit}`);
  }

  async getLogs(level = '', limit = 200) {
    const q = new URLSearchParams();
    if (level) q.set('level', level);
    q.set('limit', String(limit));
    return this._get(`/api/logs?${q}`);
  }

  // ── Internal helpers ──────────────────────────────────────

  async _get(path) {
    const headers = {};
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;
    const res = await fetch(`${getBaseUrl()}${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  on(event, cb) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(cb);
  }

  off(event, cb) {
    const list = this._handlers.get(event);
    if (!list) return;
    const i = list.indexOf(cb);
    if (i !== -1) list.splice(i, 1);
  }

  _emit(event, data) {
    for (const cb of this._handlers.get(event) ?? []) {
      try { cb(data); } catch {}
    }
  }

  isConnected() { return this._connected; }
}

// 单例
export const daemon = new DaemonClient();
