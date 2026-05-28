/**
 * Unified command registry — single source of truth for all bb-browser commands.
 *
 * Every consumer (CLI, daemon dispatch, Hub registration) reads from this file.
 * This module is metadata only — it does not execute anything.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParamDef {
  type: "string" | "number" | "boolean";
  required?: boolean;
  /** CLI positional arg index (0-based). Omit for flag-only params. */
  position?: number;
  description: string;
  default?: string | number | boolean;
}

export interface CommandDef {
  /** Protocol method name (e.g. "snap", "open") */
  method: string;
  /** Command group */
  group: "navigate" | "observe" | "interact" | "tab" | "frame" | "site" | "debug";
  /** One-line description */
  description: string;
  /** Whether --tab is required (CLI enforcement) */
  requiresTab: boolean;
  /** Parameter definitions (tab is included where applicable) */
  params: Record<string, ParamDef>;
  // result schema is NOT needed here — it's daemon's concern
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

export const COMMANDS: CommandDef[] = [
  // ---------------------------------------------------------------------------
  // Navigate
  // ---------------------------------------------------------------------------
  {
    method: "open", group: "navigate",
    description: "Navigate to a URL. Opens in a new tab if no tab is specified.",
    requiresTab: false,
    params: {
      url: { type: "string", required: true, position: 0, description: "URL to open" },
      tab: { type: "string", required: false, description: "Tab short ID to navigate in (omit to open in a new tab)" },
    },
  },
  {
    method: "goto", group: "navigate",
    description: "Navigate current tab to a URL (keeps tab context)",
    requiresTab: true,
    params: {
      url: { type: "string", required: true, position: 0, description: "URL to navigate to" },
      tab: { type: "string", required: false, description: "Tab ID" },
    },
  },
  {
    method: "back", group: "navigate",
    description: "Navigate back in browser history",
    requiresTab: true,
    params: {
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "forward", group: "navigate",
    description: "Navigate forward in browser history",
    requiresTab: true,
    params: {
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "reload", group: "navigate",
    description: "Reload the current page",
    requiresTab: true,
    params: {
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "close", group: "navigate",
    description: "Close the current tab",
    requiresTab: true,
    params: {
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },

  // ---------------------------------------------------------------------------
  // Observe
  // ---------------------------------------------------------------------------
  {
    method: "snap", group: "observe",
    description: "Get accessibility tree snapshot of the current page. Returns ref numbers for interactive elements.",
    requiresTab: true,
    params: {
      tab: { type: "string", required: true, description: "Tab short ID" },
      interactive: { type: "boolean", required: false, description: "Only show interactive elements" },
      compact: { type: "boolean", required: false, description: "Remove empty structural nodes for a more concise tree" },
      maxDepth: { type: "number", required: false, description: "Limit tree depth" },
      selector: { type: "string", required: false, description: "CSS selector to filter the snapshot scope" },
    },
  },
  {
    method: "screenshot", group: "observe",
    description: "Take a screenshot of the current page and return it as a PNG data URL",
    requiresTab: true,
    params: {
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "get", group: "observe",
    description: "Get element text, attribute, or page-level values (url, title)",
    requiresTab: true,
    params: {
      attribute: { type: "string", required: true, position: 0, description: "Attribute to retrieve (text/url/title/value/html)" },
      ref: { type: "string", required: false, description: "Element ref from snapshot (optional for url/title)" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "eval", group: "observe",
    description: "Execute JavaScript in the page context and return the result",
    requiresTab: false,
    params: {
      script: { type: "string", required: true, position: 0, description: "JavaScript source to execute" },
      tab: { type: "string", required: false, description: "Tab short ID (optional when domain is set)" },
      domain: { type: "string", required: false, description: "Target domain — auto-routes to a matching tab or creates one" },
      args: { type: "string", required: false, description: "JSON arguments to pass to the script (accessible as first arg in an IIFE)" },
    },
  },

  // ---------------------------------------------------------------------------
  // Interact
  // ---------------------------------------------------------------------------
  {
    method: "click", group: "interact",
    description: "Click an element by ref number from snapshot",
    requiresTab: true,
    params: {
      ref: { type: "string", required: true, position: 0, description: "Element ref from snapshot" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "hover", group: "interact",
    description: "Hover over an element by ref number from snapshot",
    requiresTab: true,
    params: {
      ref: { type: "string", required: true, position: 0, description: "Element ref from snapshot" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "fill", group: "interact",
    description: "Clear an input field and fill it with new text",
    requiresTab: true,
    params: {
      ref: { type: "string", required: true, position: 0, description: "Element ref from snapshot" },
      text: { type: "string", required: true, position: 1, description: "Text to fill" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "type", group: "interact",
    description: "Type text into an input field without clearing existing content",
    requiresTab: true,
    params: {
      ref: { type: "string", required: true, position: 0, description: "Element ref from snapshot" },
      text: { type: "string", required: true, position: 1, description: "Text to type" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "check", group: "interact",
    description: "Check a checkbox element",
    requiresTab: true,
    params: {
      ref: { type: "string", required: true, position: 0, description: "Element ref from snapshot" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "uncheck", group: "interact",
    description: "Uncheck a checkbox element",
    requiresTab: true,
    params: {
      ref: { type: "string", required: true, position: 0, description: "Element ref from snapshot" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "select", group: "interact",
    description: "Select a value from a dropdown (select element)",
    requiresTab: true,
    params: {
      ref: { type: "string", required: true, position: 0, description: "Element ref from snapshot" },
      value: { type: "string", required: true, position: 1, description: "Option value to select" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "press", group: "interact",
    description: "Press a keyboard key (e.g. Enter, Tab, Control+a)",
    requiresTab: true,
    params: {
      key: { type: "string", required: true, position: 0, description: "Key name to press, e.g. Enter or Control+a" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "scroll", group: "interact",
    description: "Scroll the page in a given direction",
    requiresTab: true,
    params: {
      direction: { type: "string", required: true, position: 0, description: "Scroll direction (up/down/left/right)" },
      pixels: { type: "number", required: false, description: "Scroll distance in pixels", default: 300 },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },

  // ---------------------------------------------------------------------------
  // Tab
  // ---------------------------------------------------------------------------
  {
    method: "tab_list", group: "tab",
    description: "List all open browser tabs with their URLs, titles, and short IDs",
    requiresTab: false,
    params: {},
  },
  {
    method: "tab_new", group: "tab",
    description: "Open a new browser tab, optionally navigating to a URL",
    requiresTab: false,
    params: {
      url: { type: "string", required: false, position: 0, description: "URL to open in the new tab (defaults to about:blank)" },
    },
  },

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------
  {
    method: "frame", group: "frame",
    description: "Switch context to an iframe by CSS selector",
    requiresTab: true,
    params: {
      selector: { type: "string", required: true, position: 0, description: "CSS selector for the iframe element" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "frame_main", group: "frame",
    description: "Switch context back to the main frame",
    requiresTab: true,
    params: {
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "dialog", group: "frame",
    description: "Arm a handler for the next browser dialog (alert, confirm, prompt, beforeunload)",
    requiresTab: true,
    params: {
      dialogResponse: { type: "string", required: true, position: 0, description: "How to respond: accept or dismiss", default: "accept" },
      promptText: { type: "string", required: false, description: "Text to enter in a prompt dialog (optional, used with accept)" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },

  // ---------------------------------------------------------------------------
  // Site
  // ---------------------------------------------------------------------------
  {
    method: "site_list", group: "site",
    description: "List all available site adapters",
    requiresTab: false,
    params: {},
  },
  {
    method: "site_search", group: "site",
    description: "Search site adapters by name, description, or domain",
    requiresTab: false,
    params: {
      query: { type: "string", required: true, position: 0, description: "Search query" },
    },
  },
  {
    method: "site_info", group: "site",
    description: "Show detailed metadata for a site adapter",
    requiresTab: false,
    params: {
      siteName: { type: "string", required: true, position: 0, description: "Adapter name (e.g. reddit/thread)" },
    },
  },
  {
    method: "site_run", group: "site",
    description: "Run a site adapter to extract structured data from a website",
    requiresTab: false,
    params: {
      siteName: { type: "string", required: true, position: 0, description: "Adapter name (e.g. reddit/thread, twitter/user)" },
      tab: { type: "string", required: false, description: "Tab short ID (auto-detected from adapter domain if omitted)" },
    },
  },

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------
  {
    method: "network", group: "debug",
    description: "Inspect or manage network activity. Supports incremental queries with since.",
    requiresTab: true,
    params: {
      networkCommand: { type: "string", required: false, position: 0, description: "Network sub-command (requests/route/unroute/clear)", default: "requests" },
      filter: { type: "string", required: false, description: "URL substring filter for requests" },
      since: { type: "string", required: false, description: "Incremental query: 'last_action' for events since last operation, or a seq number" },
      method: { type: "string", required: false, description: "Filter by HTTP method (GET, POST, etc.)" },
      status: { type: "string", required: false, description: "Filter by status: '4xx', '5xx', or exact code like '200'" },
      limit: { type: "number", required: false, description: "Max number of results to return" },
      withBody: { type: "boolean", required: false, description: "Include request and response bodies" },
      excludeStatic: { type: "boolean", required: false, description: "Exclude static assets (.js, .css, .png, etc.)" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "console", group: "debug",
    description: "Get or clear console messages from the page",
    requiresTab: true,
    params: {
      consoleCommand: { type: "string", required: false, description: "Console sub-command (get or clear)", default: "get" },
      filter: { type: "string", required: false, description: "Filter console messages by text substring" },
      since: { type: "string", required: false, description: "Incremental query: 'last_action' for events since last operation, or a seq number" },
      limit: { type: "number", required: false, description: "Max number of results to return" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "errors", group: "debug",
    description: "Get or clear JavaScript errors from the page",
    requiresTab: true,
    params: {
      errorsCommand: { type: "string", required: false, description: "Errors sub-command (get or clear)", default: "get" },
      filter: { type: "string", required: false, description: "Filter errors by text substring" },
      since: { type: "string", required: false, description: "Incremental query: 'last_action' for events since last operation, or a seq number" },
      limit: { type: "number", required: false, description: "Max number of results to return" },
      tab: { type: "string", required: true, description: "Tab short ID" },
    },
  },
  {
    method: "trace", group: "debug",
    description: "Record a unified timeline of actions + network requests for site adapter creation",
    requiresTab: false,
    params: {
      traceCommand: { type: "string", required: true, position: 0, description: "Trace sub-command (start/stop/status/events/body)" },
      tab: { type: "string", required: false, description: "Tab short ID (start: trace only this tab; events: filter by tab)" },
      since: { type: "string", required: false, description: "Incremental query cursor (seq number)" },
      type: { type: "string", required: false, description: "Filter by event type: action, request, response, navigation" },
      filter: { type: "string", required: false, description: "URL or text substring filter" },
      limit: { type: "number", required: false, description: "Max number of events to return" },
      requestId: { type: "string", required: false, description: "Request ID (for trace body)" },
      excludeStatic: { type: "boolean", required: false, description: "Exclude static assets (.js, .css, .png, etc.)" },
    },
  },
  {
    method: "cookies", group: "debug",
    description: "List cookies for the current page",
    requiresTab: true,
    params: {
      tab: { type: "string", required: false, description: "Tab ID" },
      filter: { type: "string", required: false, description: "Filter by cookie name or domain" },
    },
  },
  {
    method: "source", group: "debug",
    description: "Search loaded JavaScript sources (e.g. source grep '/api/')",
    requiresTab: true,
    params: {
      sourceCommand: { type: "string", required: true, position: 0, description: "Subcommand: grep" },
      sourcePattern: { type: "string", required: true, position: 1, description: "Search pattern (string or regex)" },
      tab: { type: "string", required: false, description: "Tab ID" },
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert ParamDef record to JSON Schema string for Hub registration.
 * The `tab` param is excluded — Hub handles tab routing separately.
 */
export function commandToJsonSchema(cmd: CommandDef): string {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(cmd.params)) {
    if (name === "tab") continue; // tab is handled separately by Hub
    const prop: Record<string, unknown> = { type: def.type, description: def.description };
    if (def.default !== undefined) prop.default = def.default;
    properties[name] = prop;
    if (def.required) required.push(name);
  }
  return JSON.stringify({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  });
}

/** Find a command definition by its method name. */
export function getCommand(method: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.method === method);
}

/** Get all commands in a given group. */
export function getCommandsByGroup(group: CommandDef["group"]): CommandDef[] {
  return COMMANDS.filter((c) => c.group === group);
}
