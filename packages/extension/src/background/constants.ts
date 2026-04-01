/**
 * bb-browser Extension Constants
 */

export const DEFAULT_DAEMON_PORT = 19824;
export const DEFAULT_DAEMON_HOST = '127.0.0.1';
export const DEFAULT_DAEMON_BASE_URL = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`;

// 保持向后兼容的导出
export const DAEMON_PORT = DEFAULT_DAEMON_PORT;
export const DAEMON_HOST = DEFAULT_DAEMON_HOST;
export const DAEMON_BASE_URL = DEFAULT_DAEMON_BASE_URL;

export const SSE_RECONNECT_DELAY = 3000; // 3 秒
export const SSE_MAX_RECONNECT_ATTEMPTS = 5;

const STORAGE_KEY = 'upstreamUrl';

/**
 * 获取上游 URL（从 storage 读取，无配置时用默认值）
 */
export async function getUpstreamUrl(): Promise<string> {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEY);
    const url = result[STORAGE_KEY];
    if (url && typeof url === 'string' && url.trim()) {
      return url.trim().replace(/\/+$/, ''); // 去掉尾部 /
    }
  } catch {
    // storage 不可用时用默认值
  }
  return DEFAULT_DAEMON_BASE_URL;
}

/**
 * 设置上游 URL
 */
export async function setUpstreamUrl(url: string): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: url });
}
