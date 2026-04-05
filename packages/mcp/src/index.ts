import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DAEMON_BASE_URL, COMMAND_TIMEOUT, COMMANDS, generateId } from "@bb-browser/shared";
import type { CommandDef, Request, Response } from "@bb-browser/shared";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

declare const __BB_BROWSER_VERSION__: string;

const CHROME_NOT_CONNECTED_HINT = [
  "Chrome is not connected to the daemon.",
  "",
  "Make sure Chrome is running and the daemon can connect to it via CDP.",
  "Run: bb-browser daemon --help for details.",
].join("\n");

const sessionOpenedTabs = new Set<string>();

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getDaemonPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sameDirPath = resolve(currentDir, "daemon.js");
  if (existsSync(sameDirPath)) return sameDirPath;
  return resolve(currentDir, "../../daemon/dist/index.js");
}

function getCliPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sameDirPath = resolve(currentDir, "cli.js");
  if (existsSync(sameDirPath)) return sameDirPath;
  return resolve(currentDir, "../../cli/dist/index.js");
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

async function isDaemonRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DAEMON_BASE_URL}/status`, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  // Discover CDP port first (auto-launches Chrome if needed)
  let cdpArgs: string[] = [];
  try {
    const cliPath = getCliPath();
    await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [cliPath, "daemon", "status", "--json"], { timeout: 15000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
    // If CLI daemon status succeeded, daemon is already running
    if (await isDaemonRunning()) return;
  } catch {
    // CLI failed — daemon not running, try spawning with CDP discovery
    // Read managed port file as fallback
    const { readFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    try {
      const portFile = path.join(os.default.homedir(), ".bb-browser", "browser", "cdp-port");
      const port = (await readFile(portFile, "utf8")).trim();
      if (port) cdpArgs = ["--cdp-port", port];
    } catch {}
  }

  const child = spawn(process.execPath, [getDaemonPath(), ...cdpArgs], {
    detached: true, stdio: "ignore", env: { ...process.env },
  });
  child.unref();
  // wait up to 10s
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await isDaemonRunning()) return;
  }
}

// ---------------------------------------------------------------------------
// Command transport
// ---------------------------------------------------------------------------

async function sendCommand(request: Request): Promise<Response> {
  await ensureDaemon();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COMMAND_TIMEOUT);
  try {
    const response = await fetch(`${DAEMON_BASE_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.status === 503) {
      return { id: request.id, success: false, error: CHROME_NOT_CONNECTED_HINT };
    }
    return (await response.json()) as Response;
  } catch {
    clearTimeout(timeoutId);
    return { id: request.id, success: false, error: "Failed to start daemon. Run manually: bb-browser daemon" };
  }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function responseError(resp: Response) {
  return errorResult(resp.error || "Unknown error");
}

function textResult(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

async function runCommand(request: Omit<Request, "id"> & Record<string, unknown>) {
  return sendCommand({ id: generateId(), ...request } as Request);
}

// ---------------------------------------------------------------------------
// Session tab tracking
// ---------------------------------------------------------------------------

function normalizeTabId(tabId: string | number | undefined): string | undefined {
  if (typeof tabId === "string" && tabId) {
    return tabId;
  }
  if (typeof tabId === "number" && Number.isFinite(tabId)) {
    return String(tabId);
  }
  return undefined;
}

function rememberSessionTab(tabId: string | number | undefined): void {
  const normalizedTabId = normalizeTabId(tabId);
  if (normalizedTabId) {
    sessionOpenedTabs.add(normalizedTabId);
  }
}

function forgetSessionTab(tabId: string | number | undefined): void {
  const normalizedTabId = normalizeTabId(tabId);
  if (normalizedTabId) {
    sessionOpenedTabs.delete(normalizedTabId);
  }
}

function rememberSessionTabFromResponse(data: Response["data"]): void {
  if (!data) return;
  rememberSessionTab((data as Response["data"] & { tabId?: string | number }).tabId);
}

// ---------------------------------------------------------------------------
// Site CLI helpers
// ---------------------------------------------------------------------------

function tryParseJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {}

  const lines = trimmed.split(/\r?\n/);
  for (let end = lines.length; end > 0; end -= 1) {
    for (let start = end - 1; start >= 0; start -= 1) {
      const candidate = lines.slice(start, end).join("\n").trim();
      if (!candidate) {
        continue;
      }

      try {
        return JSON.parse(candidate) as T;
      } catch {}
    }
  }

  return null;
}

function formatSiteCliError(value: unknown, stderr: string, stdout: string): string {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") {
    const lines = [value.error];

    if ("hint" in value && typeof value.hint === "string" && value.hint) {
      lines.push(`Hint: ${value.hint}`);
    }
    if ("action" in value && typeof value.action === "string" && value.action) {
      lines.push(`Action: ${value.action}`);
    }
    if ("reportHint" in value && typeof value.reportHint === "string" && value.reportHint) {
      lines.push(`Report: ${value.reportHint}`);
    }
    if ("suggestions" in value && Array.isArray(value.suggestions) && value.suggestions.length > 0) {
      lines.push(`Suggestions: ${value.suggestions.join(", ")}`);
    }

    return lines.join("\n");
  }

  const fallback = [stderr.trim(), stdout.trim()].find(Boolean);
  return fallback || "bb-browser site command failed";
}

async function runSiteCli(args: string[]): Promise<unknown> {
  const cliPath = getCliPath();

  const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolvePromise) => {
    execFile(
      process.execPath,
      [cliPath, "site", ...args],
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          stdout,
          stderr,
        });
      },
    );
  });

  const parsed = tryParseJson<unknown>(result.stdout);

  if (parsed && typeof parsed === "object" && parsed !== null && "success" in parsed && parsed.success === false) {
    throw new Error(formatSiteCliError(parsed, result.stderr, result.stdout));
  }

  if (!result.ok) {
    throw new Error(formatSiteCliError(parsed, result.stderr, result.stdout));
  }

  return parsed ?? result.stdout.trim();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "bb-browser", version: __BB_BROWSER_VERSION__ },
  { instructions: `bb-browser lets you control the user's real Chrome browser via CDP (Chrome DevTools Protocol).

Your browser is the API. No headless browser, no cookie extraction, no anti-bot bypass.

Key capabilities:
- browser_snapshot: Read page content via accessibility tree (use ref numbers to interact)
- browser_click/fill/type: Interact with elements by ref from snapshot
- browser_eval: Run JavaScript in page context (most powerful — full DOM/fetch access)
- browser_network: Capture network requests/responses (API reverse engineering). Supports incremental queries with since: "last_action"
- browser_console: Read console messages. Supports since/filter/limit
- browser_errors: Read JavaScript errors. Supports since/limit
- browser_screenshot: Visual page capture
- browser_tab_list/tab_new: Multi-tab support — use tab parameter (short ID like "c416") for concurrent operations
- browser_close_all: Close tabs opened by bb-browser during the current MCP session

Tab management:
- Tab IDs are short hex strings (e.g. "c416") returned by tab_list or open commands
- Pass tab short ID to any tool to target a specific tab
- Omit tab to target the active tab

Site adapters (pre-built commands for popular sites):
- site_list/site_search/site_info: Discover available adapters and their signatures
- site_recommend: Suggest adapters based on browsing history
- site_run: Execute an adapter directly from MCP
- site_update: Pull the community adapter repository
- Available: reddit, twitter, github, hackernews, xiaohongshu, zhihu, bilibili, weibo, douban, youtube

To create a new site adapter, run: bb-browser guide` },
);

// ---------------------------------------------------------------------------
// Build args→request mapping: remap "tab" → "tabId" for daemon protocol
// ---------------------------------------------------------------------------

function buildRequest(cmd: CommandDef, args: Record<string, unknown>): Omit<Request, "id"> & Record<string, unknown> {
  const { tab, ...rest } = args;
  const request: Record<string, unknown> = { action: cmd.action, ...rest };
  if (tab !== undefined) {
    request.tabId = tab;
  }
  return request as Omit<Request, "id"> & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Commands that need special handling — keyed by command name
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}>;

const specialHandlers: Record<string, (cmd: CommandDef) => ToolHandler> = {
  snapshot: (cmd) => async (args) => {
    const resp = await runCommand(buildRequest(cmd, args));
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.snapshotData?.snapshot || "(empty)");
  },

  screenshot: (cmd) => async (args) => {
    const resp = await runCommand(buildRequest(cmd, args));
    if (!resp.success) return responseError(resp);
    const dataUrl = resp.data?.dataUrl;
    if (typeof dataUrl !== "string") return errorResult("Screenshot data missing");
    return {
      content: [{
        type: "image" as const,
        data: dataUrl.replace(/^data:image\/png;base64,/, ""),
        mimeType: "image/png",
      }],
    };
  },

  eval: (cmd) => async (args) => {
    const resp = await runCommand(buildRequest(cmd, args));
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.result ?? null);
  },

  get: (cmd) => async (args) => {
    const resp = await runCommand(buildRequest(cmd, args));
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.value ?? "");
  },

  tab_list: (cmd) => async (args) => {
    const resp = await runCommand(buildRequest(cmd, args));
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.tabs || []);
  },

  open: (cmd) => async (args) => {
    const resp = await runCommand(buildRequest(cmd, args));
    if (!resp.success) return responseError(resp);
    if (args.tab === undefined) {
      rememberSessionTabFromResponse(resp.data);
    }
    return textResult(resp.data || `Opened ${args.url}`);
  },

  tab_new: (cmd) => async (args) => {
    const resp = await runCommand(buildRequest(cmd, args));
    if (!resp.success) return responseError(resp);
    rememberSessionTabFromResponse(resp.data);
    return textResult(resp.data || "Opened new tab");
  },

  close: (_cmd) => async (args) => {
    const action = args.tab === undefined ? "close" : "tab_close";
    const { tab, ...rest } = args;
    const request: Record<string, unknown> = { action, ...rest };
    if (tab !== undefined) request.tabId = tab;
    const resp = await runCommand(request as Omit<Request, "id"> & Record<string, unknown>);
    if (!resp.success) return responseError(resp);
    forgetSessionTab(args.tab as string | undefined);
    return textResult(resp.data || "Closed tab");
  },

  press: (_cmd) => async (args) => {
    const key = args.key as string;
    const parts = key.split("+");
    const modifierNames = new Set(["Control", "Alt", "Shift", "Meta"]);
    const modifiers = parts.filter((part) => modifierNames.has(part));
    const mainKey = parts.find((part) => !modifierNames.has(part));
    if (!mainKey) return errorResult("Invalid key format");
    const { tab, ...rest } = args;
    const request: Record<string, unknown> = {
      action: "press",
      ...rest,
      key: mainKey,
      modifiers,
    };
    if (tab !== undefined) request.tabId = tab;
    const resp = await runCommand(request as Omit<Request, "id"> & Record<string, unknown>);
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || `Pressed ${key}`);
  },

  wait: (_cmd) => async (args) => {
    const ms = args.ms ?? (args as Record<string, unknown>).time ?? 1000;
    const { tab, ...rest } = args;
    const request: Record<string, unknown> = {
      action: "wait",
      waitType: "time",
      ...rest,
      ms,
    };
    // Remove legacy arg name if present
    delete (request as Record<string, unknown>).time;
    if (tab !== undefined) request.tabId = tab;
    const resp = await runCommand(request as Omit<Request, "id"> & Record<string, unknown>);
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || `Waited ${ms}ms`);
  },

  network: (cmd) => async (args) => {
    // Backward compat: accept old "command" arg name
    const networkCommand = args.networkCommand ?? (args as Record<string, unknown>).command ?? "requests";
    const mappedArgs = { ...args, networkCommand };
    delete (mappedArgs as Record<string, unknown>).command;
    const resp = await runCommand(buildRequest(cmd, mappedArgs));
    if (!resp.success) return responseError(resp);
    const nc = networkCommand as string | undefined;
    if (nc === "requests" || nc === undefined) {
      const data = resp.data as Record<string, unknown>;
      return textResult({
        requests: data?.networkRequests || data?.requests || [],
        cursor: data?.cursor,
      });
    }
    return textResult(resp.data || "Done");
  },

  console: (cmd) => async (args) => {
    // Backward compat: accept old "command" arg name
    const consoleCommand = args.consoleCommand ?? (args as Record<string, unknown>).command ?? "get";
    const mappedArgs = { ...args, consoleCommand };
    delete (mappedArgs as Record<string, unknown>).command;
    const resp = await runCommand(buildRequest(cmd, mappedArgs));
    if (!resp.success) return responseError(resp);
    const cc = consoleCommand as string | undefined;
    if (cc === "get" || cc === undefined) {
      const data = resp.data as Record<string, unknown>;
      return textResult({
        messages: data?.consoleMessages || data?.messages || [],
        cursor: data?.cursor,
      });
    }
    return textResult(resp.data || "Cleared");
  },

  errors: (cmd) => async (args) => {
    // Backward compat: accept old "command" arg name
    const errorsCommand = args.errorsCommand ?? (args as Record<string, unknown>).command ?? "get";
    const mappedArgs = { ...args, errorsCommand };
    delete (mappedArgs as Record<string, unknown>).command;
    const resp = await runCommand(buildRequest(cmd, mappedArgs));
    if (!resp.success) return responseError(resp);
    const ec = errorsCommand as string | undefined;
    if (ec === "get" || ec === undefined) {
      const data = resp.data as Record<string, unknown>;
      return textResult({
        errors: data?.jsErrors || data?.errors || [],
        cursor: data?.cursor,
      });
    }
    return textResult(resp.data || "Cleared");
  },
};

// ---------------------------------------------------------------------------
// Auto-generate tools from COMMANDS registry
// ---------------------------------------------------------------------------

for (const cmd of COMMANDS) {
  // Site commands use CLI, not daemon — handled separately below
  if (cmd.category === "site") continue;

  const toolName = "browser_" + cmd.name;
  const handler = specialHandlers[cmd.name];

  if (handler) {
    // Command with special handling
    server.tool(toolName, cmd.description, cmd.args.shape, handler(cmd));
  } else {
    // Standard command: send to daemon and return data
    server.tool(toolName, cmd.description, cmd.args.shape, async (args: Record<string, unknown>) => {
      const resp = await runCommand(buildRequest(cmd, args));
      if (!resp.success) return responseError(resp);
      return textResult(resp.data || "Done");
    });
  }
}

// ---------------------------------------------------------------------------
// browser_close_all — session-scoped, not in COMMANDS registry
// ---------------------------------------------------------------------------

server.tool(
  "browser_close_all",
  "Close tabs opened by bb-browser during the current MCP session",
  {},
  async () => {
    const closedTabs: string[] = [];
    const alreadyClosedTabs: string[] = [];
    const failedTabs: Array<{ tabId: string; error: string }> = [];

    for (const tabId of Array.from(sessionOpenedTabs)) {
      const resp = await runCommand({ action: "tab_close", tabId });
      if (resp.success) {
        sessionOpenedTabs.delete(tabId);
        closedTabs.push(tabId);
        continue;
      }

      const error = resp.error || "Unknown error";
      if (/tab not found/i.test(error)) {
        sessionOpenedTabs.delete(tabId);
        alreadyClosedTabs.push(tabId);
        continue;
      }

      sessionOpenedTabs.delete(tabId);
      failedTabs.push({ tabId, error });
    }

    return textResult({
      closedTabs,
      alreadyClosedTabs,
      failedTabs,
      remainingTrackedTabs: Array.from(sessionOpenedTabs),
    });
  }
);

// ---------------------------------------------------------------------------
// Site tools — route through CLI instead of daemon
// ---------------------------------------------------------------------------

server.tool(
  "site_list",
  "List installed site adapters",
  {},
  async () => {
    try {
      const result = await runSiteCli(["list", "--json"]);
      return textResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
);

server.tool(
  "site_search",
  "Search installed site adapters by name, description, or domain",
  {
    query: z.string().describe("Search query"),
  },
  async ({ query }) => {
    try {
      const result = await runSiteCli(["search", query, "--json"]);
      return textResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
);

server.tool(
  "site_info",
  "Get adapter metadata including args, example, and domain",
  {
    name: z.string().describe("Adapter name, e.g. twitter/search"),
  },
  async ({ name }) => {
    try {
      const result = await runSiteCli(["info", name, "--json"]);
      return textResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
);

server.tool(
  "site_recommend",
  "Recommend adapters based on recent browsing history",
  {
    days: z.number().int().positive().optional().describe("How many recent days of history to inspect"),
  },
  async ({ days }) => {
    try {
      const args = ["recommend", "--json"];
      if (days !== undefined) {
        args.push("--days", String(days));
      }
      const result = await runSiteCli(args);
      return textResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
);

server.tool(
  "site_run",
  "Run a site adapter and return its structured data",
  {
    name: z.string().describe("Adapter name, e.g. twitter/search"),
    args: z.array(z.string()).optional().describe("Positional arguments in adapter-defined order"),
    namedArgs: z.record(z.string()).optional().describe("Named adapter arguments passed as --key value"),
    tab: z.string().optional().describe("Optional tab short ID to target"),
    openclaw: z.boolean().optional().describe("Prefer the OpenClaw browser instead of the extension flow"),
  },
  async ({ name, args, namedArgs, tab, openclaw }) => {
    try {
      const cliArgs = ["run", name];

      for (const arg of args || []) {
        cliArgs.push(arg);
      }

      for (const [key, value] of Object.entries(namedArgs || {})) {
        cliArgs.push(`--${key}`, value);
      }

      if (tab !== undefined) {
        cliArgs.push("--tab", String(tab));
      }
      if (openclaw) {
        cliArgs.push("--openclaw");
      }
      cliArgs.push("--json");

      const result = await runSiteCli(cliArgs);
      const unwrapped = result && typeof result === "object" && "data" in result ? result.data : result;
      return textResult(unwrapped);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
);

server.tool(
  "site_update",
  "Pull or clone the community adapter repository",
  {},
  async () => {
    try {
      const result = await runSiteCli(["update", "--json"]);
      return textResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 直接运行时自启动
startMcpServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
