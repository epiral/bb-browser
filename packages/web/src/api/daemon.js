/**
 * Daemon HTTP 客户端
 * 连接 bb-browser daemon，发送命令并接收响应
 */

const DAEMON_HOST = 'localhost';
const DAEMON_PORT = 19824;
const BASE_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`;

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export class DaemonClient {
  constructor() {
    this._connected = false;
    this._token = null;
    this.connectedCheckInterval = null;
    this.eventHandlers = new Map();
  }

  /**
   * 连接到 daemon — 通过 /ping 获取 token
   */
  async connect() {
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${BASE_URL}/ping`);
        if (res.ok) {
          const data = await res.json();
          this._token = data.token || null;
          this._connected = true;
          this.emit('connected');
          this._startHealthCheck();
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Cannot connect to daemon at ' + BASE_URL);
  }

  _startHealthCheck() {
    if (this.connectedCheckInterval) return;
    this.connectedCheckInterval = setInterval(async () => {
      try {
        const res = await fetch(`${BASE_URL}/ping`);
        if (!res.ok) throw new Error('Ping failed');
        this._connected = true;
      } catch {
        this._connected = false;
        this.emit('disconnected');
      }
    }, 5000);
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.connectedCheckInterval) {
      clearInterval(this.connectedCheckInterval);
      this.connectedCheckInterval = null;
    }
    this._connected = false;
  }

  /**
   * 发送命令
   */
  async send(action, params = {}) {
    const request = {
      id: generateId(),
      action,
      ...params,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (this._token) {
      headers['Authorization'] = `Bearer ${this._token}`;
    }

    const res = await fetch(`${BASE_URL}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  /**
   * 事件监听
   */
  on(event, callback) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(callback);
  }

  /**
   * 取消事件监听
   */
  off(event, callback) {
    if (this.eventHandlers.has(event)) {
      const handlers = this.eventHandlers.get(event);
      const index = handlers.indexOf(callback);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * 触发事件
   */
  emit(event, data) {
    if (this.eventHandlers.has(event)) {
      this.eventHandlers.get(event).forEach((callback) => {
        try {
          callback(data);
        } catch (err) {
          console.error(`Error in ${event} handler:`, err);
        }
      });
    }
  }

  /**
   * 获取连接状态
   */
  isConnected() {
    return this._connected;
  }
}

// 单例
export const daemon = new DaemonClient();
