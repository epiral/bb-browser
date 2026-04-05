/**
 * bb-browser 共享常量
 */

/** Daemon HTTP 服务端口 */
export const DAEMON_PORT = 19824;

/** Daemon 主机地址 */
export const DAEMON_HOST = "127.0.0.1";

/** SSE 心跳间隔（毫秒） - 15秒确保 MV3 Service Worker 不休眠 */
export const SSE_HEARTBEAT_INTERVAL = 15000; // 15 秒

/** 命令执行超时时间（毫秒） */
export const COMMAND_TIMEOUT = 30000; // 30 秒

/** SSE 重连延迟（毫秒） */
export const SSE_RECONNECT_DELAY = 3000; // 3 秒

/** SSE 最大重连尝试次数 */
export const SSE_MAX_RECONNECT_ATTEMPTS = 5;
