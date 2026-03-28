/**
 * gstack-bridge — 通过 gstack CLI 与 Electron 主进程交互
 *
 * 与 openclaw-bridge.ts 对称：
 *   openclaw-bridge → `npx openclaw browser <cmd>`
 *   gstack-bridge   → `gstack browser <cmd>`
 *
 * gstack CLI 通过 Unix domain socket (~/.gstack/ipc.sock) 与 Electron 通信。
 */

import { execFileSync } from "node:child_process";

const GSTACK_EVALUATE_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_BUFFER_MS = 5_000;

export interface GstackTab {
  index: number;
  url: string;
  title: string;
  targetId: string;
  type: string;
}

/** 定位 gstack CLI 可执行文件 */
function resolveGstackBin(): string {
  // 优先使用 PATH 中的 gstack
  return "gstack";
}

export function buildGstackArgs(args: string[], timeout: number): string[] {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new Error("gstack browser command requires a subcommand");
  }
  // gstack CLI 不需要 --timeout（socket 通信本身快），但保留接口一致性
  void timeout;
  return ["browser", subcommand, ...rest];
}

export function getGstackExecTimeout(timeout: number): number {
  return timeout + EXEC_TIMEOUT_BUFFER_MS;
}

function runGstack(args: string[], timeout: number): string {
  return execFileSync(resolveGstackBin(), buildGstackArgs(args, timeout), {
    encoding: "utf-8",
    timeout: getGstackExecTimeout(timeout),
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function gstackGetTabs(): GstackTab[] {
  const raw = runGstack(["tabs", "--json"], 15_000);
  const data = JSON.parse(raw) as { tabs?: GstackTab[] };
  return (data.tabs || []).filter((tab: GstackTab) => tab.type === "page");
}

export function gstackFindTabByDomain(tabs: GstackTab[], domain: string): GstackTab | undefined {
  return tabs.find((tab) => {
    try {
      const hostname = new URL(tab.url).hostname;
      return hostname === domain || hostname.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  });
}

export function gstackOpenTab(url: string): string {
  const raw = runGstack(["open", url, "--json"], 30_000);
  const data = JSON.parse(raw) as { targetId?: string; success?: boolean };
  return data.targetId || "default";
}

export function gstackEvaluate(targetId: string, fn: string): unknown {
  const raw = runGstack(
    ["evaluate", "--fn", fn, "--target-id", targetId],
    GSTACK_EVALUATE_TIMEOUT_MS
  );
  return JSON.parse(raw);
}

export function gstackScreenshot(): { success: boolean; data?: string; error?: string } {
  const raw = runGstack(["screenshot", "--json"], 30_000);
  return JSON.parse(raw) as { success: boolean; data?: string; error?: string };
}

export function gstackNavigate(url: string): { success: boolean; url?: string; title?: string } {
  const raw = runGstack(["navigate", url, "--json"], 30_000);
  return JSON.parse(raw) as { success: boolean; url?: string; title?: string };
}
