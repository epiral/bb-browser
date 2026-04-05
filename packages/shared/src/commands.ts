/**
 * Unified command registry — single source of truth for all bb-browser commands.
 *
 * CLI, MCP, and Edge Clip can auto-generate their interfaces from this registry.
 * This module is metadata only — it does not execute anything.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandDef {
  /** Human-readable name (e.g. "snapshot", "click") */
  name: string;
  /** Maps to command-dispatch case (e.g. "snapshot", "click") */
  action: string;
  /** One-line description */
  description: string;
  /** Command category */
  category: "navigate" | "interact" | "observe" | "tab" | "network" | "site" | "system";
  /** Zod schema for arguments */
  args: z.ZodObject<any>;
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

export const COMMANDS: CommandDef[] = [
  // ---------------------------------------------------------------------------
  // Navigate
  // ---------------------------------------------------------------------------
  {
    name: "open",
    action: "open",
    description: "Navigate to a URL. Opens in a new tab if no tab is specified.",
    category: "navigate",
    args: z.object({
      url: z.string().describe("URL to open"),
      tab: z.string().optional().describe("Tab short ID to navigate in (omit to open in a new tab)"),
    }),
  },
  {
    name: "back",
    action: "back",
    description: "Navigate back in browser history",
    category: "navigate",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "forward",
    action: "forward",
    description: "Navigate forward in browser history",
    category: "navigate",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "refresh",
    action: "refresh",
    description: "Reload the current page",
    category: "navigate",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "close",
    action: "close",
    description: "Close the current tab",
    category: "navigate",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },

  // ---------------------------------------------------------------------------
  // Observe
  // ---------------------------------------------------------------------------
  {
    name: "snapshot",
    action: "snapshot",
    description: "Get accessibility tree snapshot of the current page. Returns ref numbers for interactive elements.",
    category: "observe",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID"),
      interactive: z.boolean().optional().describe("Only show interactive elements"),
      compact: z.boolean().optional().describe("Remove empty structural nodes for a more concise tree"),
      maxDepth: z.number().optional().describe("Limit tree depth"),
      selector: z.string().optional().describe("CSS selector to filter the snapshot scope"),
    }),
  },
  {
    name: "screenshot",
    action: "screenshot",
    description: "Take a screenshot of the current page and return it as a PNG data URL",
    category: "observe",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "get",
    action: "get",
    description: "Get element text, attribute, or page-level values (url, title)",
    category: "observe",
    args: z.object({
      attribute: z.enum(["text", "url", "title", "value", "html"]).describe("Attribute to retrieve"),
      ref: z.string().optional().describe("Element ref from snapshot (optional for url/title)"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },

  // ---------------------------------------------------------------------------
  // Interact
  // ---------------------------------------------------------------------------
  {
    name: "click",
    action: "click",
    description: "Click an element by ref number from snapshot",
    category: "interact",
    args: z.object({
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "hover",
    action: "hover",
    description: "Hover over an element by ref number from snapshot",
    category: "interact",
    args: z.object({
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "fill",
    action: "fill",
    description: "Clear an input field and fill it with new text",
    category: "interact",
    args: z.object({
      ref: z.string().describe("Element ref from snapshot"),
      text: z.string().describe("Text to fill"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "type",
    action: "type",
    description: "Type text into an input field without clearing existing content",
    category: "interact",
    args: z.object({
      ref: z.string().describe("Element ref from snapshot"),
      text: z.string().describe("Text to type"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "check",
    action: "check",
    description: "Check a checkbox element",
    category: "interact",
    args: z.object({
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "uncheck",
    action: "uncheck",
    description: "Uncheck a checkbox element",
    category: "interact",
    args: z.object({
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "select",
    action: "select",
    description: "Select a value from a dropdown (select element)",
    category: "interact",
    args: z.object({
      ref: z.string().describe("Element ref from snapshot"),
      value: z.string().describe("Option value to select"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "press",
    action: "press",
    description: "Press a keyboard key (e.g. Enter, Tab, Control+a)",
    category: "interact",
    args: z.object({
      key: z.string().describe("Key name to press, e.g. Enter or Control+a"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "scroll",
    action: "scroll",
    description: "Scroll the page in a given direction",
    category: "interact",
    args: z.object({
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
      pixels: z.number().default(300).describe("Scroll distance in pixels"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "eval",
    action: "eval",
    description: "Execute JavaScript in the page context and return the result",
    category: "interact",
    args: z.object({
      script: z.string().describe("JavaScript source to execute"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },

  // ---------------------------------------------------------------------------
  // System
  // ---------------------------------------------------------------------------
  {
    name: "wait",
    action: "wait",
    description: "Wait for a specified number of milliseconds",
    category: "system",
    args: z.object({
      ms: z.number().default(1000).describe("Time to wait in milliseconds"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "dialog",
    action: "dialog",
    description: "Arm a handler for the next browser dialog (alert, confirm, prompt, beforeunload)",
    category: "system",
    args: z.object({
      dialogResponse: z.enum(["accept", "dismiss"]).default("accept").describe("How to respond to the dialog"),
      promptText: z.string().optional().describe("Text to enter in a prompt dialog (optional, used with accept)"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "frame",
    action: "frame",
    description: "Switch context to an iframe by CSS selector",
    category: "system",
    args: z.object({
      selector: z.string().describe("CSS selector for the iframe element"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "frame_main",
    action: "frame_main",
    description: "Switch context back to the main frame",
    category: "system",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },

  // ---------------------------------------------------------------------------
  // Tab
  // ---------------------------------------------------------------------------
  {
    name: "tab_list",
    action: "tab_list",
    description: "List all open browser tabs with their URLs, titles, and short IDs",
    category: "tab",
    args: z.object({}),
  },
  {
    name: "tab_new",
    action: "tab_new",
    description: "Open a new browser tab, optionally navigating to a URL",
    category: "tab",
    args: z.object({
      url: z.string().optional().describe("URL to open in the new tab (defaults to about:blank)"),
    }),
  },
  {
    name: "tab_select",
    action: "tab_select",
    description: "Switch to a tab by short ID or index",
    category: "tab",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID or full target ID"),
      index: z.number().optional().describe("Tab index (0-based, used if tab is not specified)"),
    }),
  },
  {
    name: "tab_close",
    action: "tab_close",
    description: "Close a specific tab by short ID or index",
    category: "tab",
    args: z.object({
      tab: z.string().optional().describe("Tab short ID or full target ID"),
      index: z.number().optional().describe("Tab index (0-based, used if tab is not specified)"),
    }),
  },

  // ---------------------------------------------------------------------------
  // Network / observation
  // ---------------------------------------------------------------------------
  {
    name: "network",
    action: "network",
    description: "Inspect or manage network activity. Supports incremental queries with since.",
    category: "network",
    args: z.object({
      networkCommand: z.enum(["requests", "route", "unroute", "clear"]).default("requests").describe("Network sub-command"),
      filter: z.string().optional().describe("URL substring filter for requests"),
      since: z.union([z.literal("last_action"), z.number()]).optional().describe("Incremental query: 'last_action' for events since last operation, or a seq number"),
      method: z.string().optional().describe("Filter by HTTP method (GET, POST, etc.)"),
      status: z.string().optional().describe("Filter by status: '4xx', '5xx', or exact code like '200'"),
      limit: z.number().optional().describe("Max number of results to return"),
      withBody: z.boolean().optional().describe("Include request and response bodies"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "console",
    action: "console",
    description: "Get or clear console messages from the page",
    category: "network",
    args: z.object({
      consoleCommand: z.enum(["get", "clear"]).default("get").describe("Console sub-command"),
      filter: z.string().optional().describe("Filter console messages by text substring"),
      since: z.union([z.literal("last_action"), z.number()]).optional().describe("Incremental query: 'last_action' for events since last operation, or a seq number"),
      limit: z.number().optional().describe("Max number of results to return"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "errors",
    action: "errors",
    description: "Get or clear JavaScript errors from the page",
    category: "network",
    args: z.object({
      errorsCommand: z.enum(["get", "clear"]).default("get").describe("Errors sub-command"),
      filter: z.string().optional().describe("Filter errors by text substring"),
      since: z.union([z.literal("last_action"), z.number()]).optional().describe("Incremental query: 'last_action' for events since last operation, or a seq number"),
      limit: z.number().optional().describe("Max number of results to return"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "trace",
    action: "trace",
    description: "Record user interactions for replay or code generation",
    category: "network",
    args: z.object({
      traceCommand: z.enum(["start", "stop", "status"]).describe("Trace sub-command"),
      tab: z.string().optional().describe("Tab short ID"),
    }),
  },
  {
    name: "history",
    action: "history",
    description: "Search browsing history or list domains (not supported in daemon mode)",
    category: "network",
    args: z.object({
      historyCommand: z.enum(["search", "domains"]).describe("History sub-command"),
      query: z.string().optional().describe("Search query string (used with 'search' sub-command)"),
      days: z.number().default(30).describe("Number of days to look back"),
    }),
  },

  // ---------------------------------------------------------------------------
  // Site
  // ---------------------------------------------------------------------------
  {
    name: "site_list",
    action: "site_list",
    description: "List all available site adapters",
    category: "site",
    args: z.object({}),
  },
  {
    name: "site_search",
    action: "site_search",
    description: "Search site adapters by name, description, or domain",
    category: "site",
    args: z.object({
      query: z.string().describe("Search query"),
    }),
  },
  {
    name: "site_info",
    action: "site_info",
    description: "Show detailed metadata for a site adapter",
    category: "site",
    args: z.object({
      name: z.string().describe("Adapter name (e.g. reddit/thread)"),
    }),
  },
  {
    name: "site_recommend",
    action: "site_recommend",
    description: "Recommend site adapters based on browsing history",
    category: "site",
    args: z.object({
      days: z.number().default(30).describe("Number of days of history to analyze"),
    }),
  },
  {
    name: "site_run",
    action: "site_run",
    description: "Run a site adapter to extract structured data from a website",
    category: "site",
    args: z.object({
      name: z.string().describe("Adapter name (e.g. reddit/thread, twitter/user)"),
      args: z.string().optional().describe("Arguments to pass to the adapter (space-separated or --flag value)"),
      tab: z.string().optional().describe("Tab short ID (auto-detected from adapter domain if omitted)"),
    }),
  },
  {
    name: "site_update",
    action: "site_update",
    description: "Update community site adapter library (git clone/pull)",
    category: "site",
    args: z.object({}),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a command definition by its action name. */
export function findCommand(action: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.action === action);
}

/** Get all commands in a given category. */
export function getCommandsByCategory(category: CommandDef["category"]): CommandDef[] {
  return COMMANDS.filter((c) => c.category === category);
}
