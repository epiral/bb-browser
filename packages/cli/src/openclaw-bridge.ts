import { execFileSync } from "node:child_process";
import { parseOpenClawJson } from "./openclaw-json.js";

const OPENCLAW_EVALUATE_TIMEOUT_MS = 120000;
const EXEC_TIMEOUT_BUFFER_MS = 5000;

export interface OCTab {
  targetId: string;
  suggestedTargetId?: string;
  tabId?: string;
  label?: string;
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
  const data = parseOpenClawJson<{ suggestedTargetId?: string; tabId?: string; id?: string; targetId?: string }>(raw);
  const tabReference = data.suggestedTargetId || data.tabId || data.id || data.targetId;
  if (!tabReference) {
    throw new Error("OpenClaw did not return a tab reference after opening the URL");
  }
  return tabReference;
}

export function ocGetTabReference(tab: OCTab): string {
  return tab.suggestedTargetId || tab.tabId || tab.label || tab.targetId;
}

export function ocFocus(tabReference: string): void {
  runOpenClaw(["focus", tabReference], 15000);
}

export function ocEvaluate(tabReference: string, fn: string): unknown {
  // Some OpenClaw releases do not expose evaluate --target-id. Focusing first
  // works with stable tab ids/labels as well as legacy raw target ids.
  ocFocus(tabReference);
  const raw = runOpenClaw(["evaluate", "--fn", fn], OPENCLAW_EVALUATE_TIMEOUT_MS);
  return parseOpenClawJson(raw);
}
