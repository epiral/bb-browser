/**
 * 浏览器连接管理器 - 检测并连接 CDP
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ensureCdpConnection } from "./cdp-client.js";
import { isManagedBrowserRunning } from "./cdp-discovery.js";

export function getDaemonPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const sameDirPath = resolve(currentDir, "daemon.js");
  if (existsSync(sameDirPath)) {
    return sameDirPath;
  }
  return resolve(currentDir, "../../daemon/dist/index.js");
}

export async function isDaemonRunning(): Promise<boolean> {
  return await isManagedBrowserRunning();
}

export async function stopDaemon(): Promise<boolean> {
  return false;
}

export async function ensureDaemonRunning(): Promise<void> {
  try {
    await ensureCdpConnection();
  } catch (error) {
    if (error instanceof Error && error.message.includes("No browser connection found")) {
      throw new Error([
        "bb-browser: Could not start browser.",
        "",
        "Make sure Chrome is installed, then try again.",
        "Or specify a CDP port manually: bb-browser --port 9222",
      ].join("\n"));
    }
    throw error;
  }
}
