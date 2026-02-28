/**
 * daemon 命令 - Daemon 管理
 * 用法：
 *   bb-browser daemon    前台启动 Daemon
 *   bb-browser start     前台启动 Daemon（别名）
 *   bb-browser stop      停止 Daemon
 */

import { spawn } from "node:child_process";
import { isDaemonRunning, stopDaemon, getDaemonPath } from "../daemon-manager.js";

export interface DaemonOptions {
  json?: boolean;
}

/**
 * 前台启动 Daemon
 * 以子进程方式在前台运行 daemon，继承 stdio 以便用户看到输出
 */
export async function daemonCommand(
  options: DaemonOptions = {}
): Promise<void> {
  // 检查是否已经运行
  if (await isDaemonRunning()) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: "Daemon 已在运行" }));
    } else {
      console.log("Daemon 已在运行");
    }
    return;
  }

  try {
    if (options.json) {
      console.log(JSON.stringify({ success: true, message: "Daemon 启动中..." }));
    } else {
      console.log("Daemon 启动中...");
    }

    // 以前台子进程方式启动，继承 stdio，Ctrl+C 可停止
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [getDaemonPath()], {
        stdio: "inherit",
      });
      child.on("exit", () => resolve());
      child.on("error", reject);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: message }));
    } else {
      console.error(`启动失败: ${message}`);
    }
    process.exit(1);
  }
}

/**
 * 停止 Daemon
 */
export async function stopCommand(options: DaemonOptions = {}): Promise<void> {
  // 检查是否运行中
  if (!(await isDaemonRunning())) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: "Daemon 未运行" }));
    } else {
      console.log("Daemon 未运行");
    }
    return;
  }

  // 发送停止信号
  const stopped = await stopDaemon();

  if (stopped) {
    if (options.json) {
      console.log(JSON.stringify({ success: true, message: "Daemon 已停止" }));
    } else {
      console.log("Daemon 已停止");
    }
  } else {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: "无法停止 Daemon" }));
    } else {
      console.error("无法停止 Daemon");
    }
    process.exit(1);
  }
}

/**
 * 状态命令
 */
export async function statusCommand(
  options: DaemonOptions = {}
): Promise<void> {
  const running = await isDaemonRunning();

  if (options.json) {
    console.log(JSON.stringify({ running }));
  } else {
    console.log(running ? "Daemon 运行中" : "Daemon 未运行");
  }
}
