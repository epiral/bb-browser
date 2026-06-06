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

const DEFAULT_DAEMON_PORT = 19824;

/**
 * Resolve the daemon's real HTTP port + auth token.
 *
 * The tray's Rust side knows the concrete values (the daemon may run on a
 * fallback port like 19826 when 19824 is occupied, and authed endpoints
 * require the token). We ask it via the `get_status` IPC command. Outside
 * Tauri (vite dev) we fall back to the default port with no token.
 */
async function resolveDaemonIdentity() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      const status = await invoke('get_status');
      return {
        port: status?.daemon_port ?? DEFAULT_DAEMON_PORT,
        token: status?.token ?? null,
      };
    } catch {
      // fall through to default
    }
  }
  return { port: DEFAULT_DAEMON_PORT, token: null };
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
    this._port = DEFAULT_DAEMON_PORT;
    this._healthTimer = null;
    this._handlers = new Map();
  }

  _baseUrl() {
    return `http://127.0.0.1:${this._port}`;
  }

  async connect() {
    // Re-resolve the real port + token each connect attempt — the daemon may
    // have restarted onto a different port, or the token may have rotated.
    for (let i = 0; i < 5; i++) {
      const { port, token } = await resolveDaemonIdentity();
      this._port = port;
      try {
        const res = await fetch(`${this._baseUrl()}/ping`);
        if (res.ok) {
          const data = await res.json();
          // Prefer the token from Rust state; fall back to the one /ping
          // echoes (so it also works in vite dev without Tauri IPC).
          this._token = token ?? data.token ?? null;
          this._connected = true;
          this._emit('connected');
          this._startHealthCheck();
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    this._connected = false;
    this._emit('disconnected');
    // Start health check even on failure so we recover automatically when
    // the daemon eventually starts (panel may open before daemon is ready).
    this._startHealthCheck();
    throw new Error(`Cannot connect to daemon at ${this._baseUrl()}`);
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
        // When disconnected, re-resolve port+token — daemon may have restarted
        // on a fallback port, so pinging the old port would never succeed.
        if (!this._connected) {
          const { port, token } = await resolveDaemonIdentity();
          this._port = port;
          if (token) this._token = token;
        }
        const res = await fetch(`${this._baseUrl()}/ping`);
        if (!res.ok) throw new Error('ping failed');
        // Always refresh token from ping response — handles daemon restarts
        // where the old token would cause 401 on authed endpoints.
        const data = await res.json();
        if (data.token) this._token = data.token;
        if (!this._connected) {
          this._connected = true;
          this._emit('connected');
        }
      } catch {
        if (this._connected) {
          this._connected = false;
          this._emit('disconnected');
        }
      }
    }, 5000);
  }

  // ── Core command ──────────────────────────────────────────

  async send(action, params = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;

    const res = await fetch(`${this._baseUrl()}/command`, {
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

  async getStatus() {
    return this._get('/status');
  }

  async getSites(q = '', domain = '') {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (domain) params.set('domain', domain);
    const qs = params.toString();
    return this._get(`/api/sites${qs ? `?${qs}` : ''}`);
  }

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

  async getAgents() {
    return this._get('/api/agents');
  }

  async getBindings(agentId = '') {
    const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return this._get(`/api/bindings${q}`);
  }

  // ── Internal helpers ──────────────────────────────────────

  async _get(path, retry = true) {
    const headers = {};
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;
    const res = await fetch(`${this._baseUrl()}${path}`, { headers });
    if (res.status === 401 && retry) {
      // Token may have rotated (daemon restart). Re-resolve identity once.
      const { port, token } = await resolveDaemonIdentity();
      this._port = port;
      if (token) this._token = token;
      return this._get(path, false);
    }
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
