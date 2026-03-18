import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sendCommand as sendCliCommand, ensureDaemonRunning } from "@bb-browser/cli/runtime";
import { generateId } from "@bb-browser/shared";
import type { Request, Response } from "@bb-browser/shared";
import { z } from "zod";

declare const __BB_BROWSER_VERSION__: string;

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

async function runCommand(request: Omit<Request, "id">) {
  const id = generateId();

  try {
    await ensureDaemonRunning();
    return await sendCliCommand({ id, ...request });
  } catch (error) {
    return {
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies Response;
  }
}

const tabIdSchema = z.union([z.string(), z.number()]);

const server = new McpServer(
  { name: "bb-browser", version: __BB_BROWSER_VERSION__ },
  { instructions: `bb-browser lets you control the user's real Chrome browser — with their login state, cookies, and sessions.

Your browser is the API. No headless browser, no cookie extraction, no anti-bot bypass.

Key capabilities:
- browser_snapshot: Read page content via accessibility tree (use ref numbers to interact)
- browser_click/fill/type: Interact with elements by ref from snapshot
- browser_eval: Run JavaScript in page context (most powerful — full DOM/fetch access)
- browser_network: Capture network requests/responses (API reverse engineering)
- browser_screenshot: Visual page capture
- browser_tab_list/tab_new: Multi-tab support — use tab parameter for concurrent operations

Site adapters (pre-built commands for popular sites):
- Run via CLI: bb-browser site <name> [args]
- Available: reddit, twitter, github, hackernews, xiaohongshu, zhihu, bilibili, weibo, douban, youtube
- Update: bb-browser site update
- List all: bb-browser site list

To create a new site adapter, run: bb-browser guide` },
);

server.tool(
  "browser_snapshot",
  "Get accessibility tree snapshot of the current page",
  {
    tab: tabIdSchema.optional().describe("Tab ID to target (omit for active tab)"),
    interactive: z.boolean().optional().describe("Only show interactive elements"),
  },
  async ({ tab, interactive }) => {
    const resp = await runCommand({ action: "snapshot", interactive, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.snapshotData?.snapshot || "(empty)");
  }
);

server.tool(
  "browser_click",
  "Click an element by ref",
  {
    ref: z.string().describe("Element ref from snapshot"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ ref, tab }) => {
    const resp = await runCommand({ action: "click", ref, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || "Clicked");
  }
);

server.tool(
  "browser_fill",
  "Fill text into an input",
  {
    ref: z.string().describe("Element ref from snapshot"),
    text: z.string().describe("Text to fill"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ ref, text, tab }) => {
    const resp = await runCommand({ action: "fill", ref, text, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || "Filled");
  }
);

server.tool(
  "browser_type",
  "Type text into an input without clearing",
  {
    ref: z.string().describe("Element ref from snapshot"),
    text: z.string().describe("Text to type"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ ref, text, tab }) => {
    const resp = await runCommand({ action: "type", ref, text, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || "Typed");
  }
);

server.tool(
  "browser_open",
  "Navigate to a URL",
  {
    url: z.string().describe("URL to open"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ url, tab }) => {
    const resp = await runCommand({ action: "open", url, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || `Opened ${url}`);
  }
);

server.tool(
  "browser_tab_list",
  "List all tabs",
  {},
  async () => {
    const resp = await runCommand({ action: "tab_list" });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.tabs || []);
  }
);

server.tool(
  "browser_tab_new",
  "Open a new tab",
  {
    url: z.string().optional().describe("Optional URL to open"),
  },
  async ({ url }) => {
    const resp = await runCommand({ action: "tab_new", url });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || "Opened new tab");
  }
);

server.tool(
  "browser_press",
  "Press a keyboard key",
  {
    key: z.string().describe("Key name to press, e.g. Enter or Control+a"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ key, tab }) => {
    const parts = key.split("+");
    const modifierNames = new Set(["Control", "Alt", "Shift", "Meta"]);
    const modifiers = parts.filter((part) => modifierNames.has(part));
    const mainKey = parts.find((part) => !modifierNames.has(part));
    if (!mainKey) return errorResult("Invalid key format");
    const resp = await runCommand({ action: "press", key: mainKey, modifiers, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || `Pressed ${key}`);
  }
);

server.tool(
  "browser_scroll",
  "Scroll the page",
  {
    direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
    pixels: z.number().optional().default(500).describe("Scroll distance in pixels"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ direction, pixels, tab }) => {
    const resp = await runCommand({ action: "scroll", direction, pixels, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || `Scrolled ${direction} ${pixels}px`);
  }
);

server.tool(
  "browser_eval",
  "Execute JavaScript in page context",
  {
    script: z.string().describe("JavaScript source to execute"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ script, tab }) => {
    const resp = await runCommand({ action: "eval", script, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.result ?? null);
  }
);

server.tool(
  "browser_network",
  "Inspect or clear network activity",
  {
    command: z.enum(["requests", "clear"]).describe("Network command"),
    filter: z.string().optional().describe("Optional URL substring filter"),
    withBody: z.boolean().optional().describe("Include request and response bodies"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ command, filter, withBody, tab }) => {
    const resp = await runCommand({
      action: "network",
      networkCommand: command,
      filter,
      withBody,
      tabId: tab,
    });
    if (!resp.success) return responseError(resp);
    return textResult(command === "requests" ? resp.data?.networkRequests || [] : resp.data || "Cleared");
  }
);

server.tool(
  "browser_screenshot",
  "Take a screenshot",
  {
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ tab }) => {
    const resp = await runCommand({ action: "screenshot", tabId: tab });
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
  }
);

server.tool(
  "browser_get",
  "Get element text or attribute",
  {
    attribute: z.enum(["text", "url", "title", "value", "html"]).describe("Attribute to retrieve"),
    ref: z.string().optional().describe("Optional element ref"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ attribute, ref, tab }) => {
    const resp = await runCommand({ action: "get", attribute, ref, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data?.value ?? "");
  }
);

server.tool(
  "browser_close",
  "Close the current or specified tab",
  {
    tab: tabIdSchema.optional().describe("Tab ID to close"),
  },
  async ({ tab }) => {
    const resp = await runCommand({ action: tab === undefined ? "close" : "tab_close", tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || "Closed tab");
  }
);

server.tool(
  "browser_hover",
  "Hover over an element",
  {
    ref: z.string().describe("Element ref from snapshot"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ ref, tab }) => {
    const resp = await runCommand({ action: "hover", ref, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || "Hovered");
  }
);

server.tool(
  "browser_wait",
  "Wait for a number of milliseconds",
  {
    time: z.number().describe("Time to wait in milliseconds"),
    tab: tabIdSchema.optional().describe("Tab ID to target"),
  },
  async ({ time, tab }) => {
    const resp = await runCommand({ action: "wait", waitType: "time", ms: time, tabId: tab });
    if (!resp.success) return responseError(resp);
    return textResult(resp.data || `Waited ${time}ms`);
  }
);

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 直接运行时自启动
startMcpServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
