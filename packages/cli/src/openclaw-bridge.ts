import { execFileSync } from "node:child_process";
import { parseOpenClawJson } from "./openclaw-json.js";

const OPENCLAW_EVALUATE_TIMEOUT_MS = 120000;
const EXEC_TIMEOUT_BUFFER_MS = 5000;

export interface OCTab {
  targetId: string;
  url: string;
  title: string;
  type: string;
}

export function buildOpenClawArgs(args: string[], timeout: number): string[] {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new Error("OpenClaw browser command requires a subcommand");
  }

  const browserLevelFlags: string[] = [];
  const subcommandArgs: string[] = [];
  for (const arg of rest) {
    if (arg === "--json") {
      browserLevelFlags.push(arg);
      continue;
    }
    subcommandArgs.push(arg);
  }

  return ["openclaw", "browser", ...browserLevelFlags, "--timeout", String(timeout), subcommand, ...subcommandArgs];
}

export function getOpenClawExecTimeout(timeout: number): number {
  return timeout + EXEC_TIMEOUT_BUFFER_MS;
}

function runOpenClaw(args: string[], timeout: number): string {
  return execFileSync("npx", buildOpenClawArgs(args, timeout), {
    encoding: "utf-8",
    timeout: getOpenClawExecTimeout(timeout),
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function ocGetTabs(): OCTab[] {
  const raw = runOpenClaw(["tabs", "--json"], 15000);
  const data = parseOpenClawJson<{ tabs?: OCTab[] }>(raw);
  return (data.tabs || []).filter((tab: OCTab) => tab.type === "page");
}

export function ocFindTabByDomain(tabs: OCTab[], domain: string): OCTab | undefined {
  return tabs.find((tab) => {
    try {
      const hostname = new URL(tab.url).hostname;
      return hostname === domain || hostname.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  });
}

export function ocOpenTab(url: string): string {
  const raw = runOpenClaw(["open", url, "--json"], 30000);
  const data = parseOpenClawJson<{ id?: string; targetId?: string }>(raw);
  return data.id || data.targetId;
}

export function ocEvaluate(targetId: string, fn: string): unknown {
  const raw = runOpenClaw(["evaluate", "--fn", fn, "--target-id", targetId], OPENCLAW_EVALUATE_TIMEOUT_MS);
  return parseOpenClawJson(raw);
}
