/**
 * bb-browser Daemon 主入口
 *
 * HTTP Server + SSE 推送架构
 *
 * 职责：
 * 1. 启动 HTTP 服务器监听 localhost:19824
 * 2. 处理 CLI 命令请求 (POST /command)
 * 3. 管理扩展 SSE 连接 (GET /sse)
 * 4. 接收扩展结果回传 (POST /result)
 */

import { parseArgs } from "node:util";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { DAEMON_PORT, DAEMON_HOST } from "@bb-browser/shared";
import { HttpServer } from "./http-server.js";

const PID_FILE_PATH = "/tmp/bb-browser.pid";

interface DaemonOptions {
  host: string;
  port: number;
}

/**
 * 解析命令行参数
 */
function parseOptions(): DaemonOptions {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      host: {
        type: "string",
        short: "H",
        default: DAEMON_HOST,
      },
      port: {
        type: "string",
        short: "p",
        default: String(DAEMON_PORT),
      },
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
    },
  });

  if (values.help) {
    console.error(`
bb-browser daemon - HTTP server daemon for bb-browser

Usage:
  bb-browser daemon [options]

Options:
  -H, --host <host>  HTTP server host (default: ${DAEMON_HOST})
  -p, --port <port>  HTTP server port (default: ${DAEMON_PORT})
  -h, --help         Show this help message

Endpoints:
  POST /command      Send command and wait for result (CLI)
  GET  /sse          Subscribe to command stream (Extension)
  POST /result       Report command result (Extension)
  GET  /status       Query daemon status
`);
    process.exit(0);
  }

  return {
    host: values.host ?? DAEMON_HOST,
    port: parseInt(values.port ?? String(DAEMON_PORT), 10),
  };
}

/**
 * 写入 PID 文件
 */
function writePidFile(): void {
  writeFileSync(PID_FILE_PATH, String(process.pid), "utf-8");
}

/**
 * 清理 PID 文件
 */
function cleanupPidFile(): void {
  if (existsSync(PID_FILE_PATH)) {
    try {
      unlinkSync(PID_FILE_PATH);
    } catch {
      // 忽略清理失败
    }
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const options = parseOptions();

  // 优雅关闭
  const shutdown = async () => {
    console.error("[Daemon] Shutting down...");
    await httpServer.stop();
    cleanupPidFile();
    process.exit(0);
  };

  // 创建 HTTP 服务器
  const httpServer = new HttpServer({
    host: options.host,
    port: options.port,
    onShutdown: shutdown,
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 启动服务器
  await httpServer.start();

  // 写入 PID 文件
  writePidFile();

  console.error(`[Daemon] HTTP server listening on http://${options.host}:${options.port}`);
  console.error("[Daemon] Waiting for extension connection...");
}

// 启动 Daemon
main().catch((error) => {
  console.error("[Daemon] Fatal error:", error);
  cleanupPidFile();
  process.exit(1);
});
