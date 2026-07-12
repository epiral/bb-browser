import { execFileSync } from "node:child_process";
import { parseOpenClawJson } from "./openclaw-json.js";

const OPENCLAW_EVALUATE_TIMEOUT_MS = 120000;
const EXEC_TIMEOUT_BUFFER_MS = 5000;
const OPENCLAW_PAGE_LOAD_TIMEOUT_MS = 30000;

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

export function isOpenClawNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const processError = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  const output = [processError.message, processError.stdout, processError.stderr]
    .filter((part) => part !== undefined)
    .map((part) => String(part))
    .join("\n");
  return /execution context was destroyed[^\n]*navigation/i.test(output);
}

function evaluateFocusedTab(fn: string): unknown {
  const raw = runOpenClaw(["evaluate", "--fn", fn], OPENCLAW_EVALUATE_TIMEOUT_MS);
  return parseOpenClawJson(raw);
}

export function ocEvaluate(tabReference: string, fn: string): unknown {
  // Some OpenClaw releases do not expose evaluate --target-id. Focusing first
  // works with stable tab ids/labels as well as legacy raw target ids.
  ocFocus(tabReference);
  try {
    return evaluateFocusedTab(fn);
  } catch (error) {
    if (!isOpenClawNavigationError(error)) throw error;

    // Adapters may navigate by assigning location.href. That necessarily
    // destroys the current evaluate context, so wait for the replacement page
    // and run the adapter once more on the stable tab reference.
    ocFocus(tabReference);
    runOpenClaw(
      ["wait", "--load", "domcontentloaded", "--timeout-ms", String(OPENCLAW_PAGE_LOAD_TIMEOUT_MS)],
      OPENCLAW_PAGE_LOAD_TIMEOUT_MS + EXEC_TIMEOUT_BUFFER_MS,
    );
    return evaluateFocusedTab(fn);
  }
}
