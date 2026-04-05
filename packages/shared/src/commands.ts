/**
 * Unified command registry — single source of truth for all bb-browser commands.
 *
 * CLI, MCP, and Edge Clip can auto-generate their interfaces from this registry.
 * This module is metadata only — it does not execute anything.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandArg {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
}

export interface CommandDef {
  /** Human-readable name (e.g. "snapshot", "click") */
  name: string;
  /** Maps to command-dispatch case (e.g. "snapshot", "click") */
  action: string;
  /** One-line description */
  description: string;
  /** Command category */
  category: "navigate" | "interact" | "observe" | "tab" | "network" | "site" | "system";
  /** Argument definitions */
  args: Record<string, CommandArg>;
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
    args: {
      url: {
        type: "string",
        description: "URL to open",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID to navigate in (omit to open in a new tab)",
      },
    },
  },
  {
    name: "back",
    action: "back",
    description: "Navigate back in browser history",
    category: "navigate",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "forward",
    action: "forward",
    description: "Navigate forward in browser history",
    category: "navigate",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "refresh",
    action: "refresh",
    description: "Reload the current page",
    category: "navigate",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "close",
    action: "close",
    description: "Close the current tab",
    category: "navigate",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Observe
  // ---------------------------------------------------------------------------
  {
    name: "snapshot",
    action: "snapshot",
    description: "Get accessibility tree snapshot of the current page. Returns ref numbers for interactive elements.",
    category: "observe",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID",
      },
      interactive: {
        type: "boolean",
        description: "Only show interactive elements",
      },
      compact: {
        type: "boolean",
        description: "Remove empty structural nodes for a more concise tree",
      },
      maxDepth: {
        type: "number",
        description: "Limit tree depth",
      },
      selector: {
        type: "string",
        description: "CSS selector to filter the snapshot scope",
      },
    },
  },
  {
    name: "screenshot",
    action: "screenshot",
    description: "Take a screenshot of the current page and return it as a PNG data URL",
    category: "observe",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "get",
    action: "get",
    description: "Get element text, attribute, or page-level values (url, title)",
    category: "observe",
    args: {
      attribute: {
        type: "string",
        description: "Attribute to retrieve",
        required: true,
        enum: ["text", "url", "title", "value", "html"],
      },
      ref: {
        type: "string",
        description: "Element ref from snapshot (optional for url/title)",
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Interact
  // ---------------------------------------------------------------------------
  {
    name: "click",
    action: "click",
    description: "Click an element by ref number from snapshot",
    category: "interact",
    args: {
      ref: {
        type: "string",
        description: "Element ref from snapshot",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "hover",
    action: "hover",
    description: "Hover over an element by ref number from snapshot",
    category: "interact",
    args: {
      ref: {
        type: "string",
        description: "Element ref from snapshot",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "fill",
    action: "fill",
    description: "Clear an input field and fill it with new text",
    category: "interact",
    args: {
      ref: {
        type: "string",
        description: "Element ref from snapshot",
        required: true,
      },
      text: {
        type: "string",
        description: "Text to fill",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "type",
    action: "type",
    description: "Type text into an input field without clearing existing content",
    category: "interact",
    args: {
      ref: {
        type: "string",
        description: "Element ref from snapshot",
        required: true,
      },
      text: {
        type: "string",
        description: "Text to type",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "check",
    action: "check",
    description: "Check a checkbox element",
    category: "interact",
    args: {
      ref: {
        type: "string",
        description: "Element ref from snapshot",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "uncheck",
    action: "uncheck",
    description: "Uncheck a checkbox element",
    category: "interact",
    args: {
      ref: {
        type: "string",
        description: "Element ref from snapshot",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "select",
    action: "select",
    description: "Select a value from a dropdown (select element)",
    category: "interact",
    args: {
      ref: {
        type: "string",
        description: "Element ref from snapshot",
        required: true,
      },
      value: {
        type: "string",
        description: "Option value to select",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "press",
    action: "press",
    description: "Press a keyboard key (e.g. Enter, Tab, Control+a)",
    category: "interact",
    args: {
      key: {
        type: "string",
        description: "Key name to press, e.g. Enter or Control+a",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "scroll",
    action: "scroll",
    description: "Scroll the page in a given direction",
    category: "interact",
    args: {
      direction: {
        type: "string",
        description: "Scroll direction",
        required: true,
        enum: ["up", "down", "left", "right"],
      },
      pixels: {
        type: "number",
        description: "Scroll distance in pixels",
        default: 300,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "eval",
    action: "eval",
    description: "Execute JavaScript in the page context and return the result",
    category: "interact",
    args: {
      script: {
        type: "string",
        description: "JavaScript source to execute",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // System
  // ---------------------------------------------------------------------------
  {
    name: "wait",
    action: "wait",
    description: "Wait for a specified number of milliseconds",
    category: "system",
    args: {
      ms: {
        type: "number",
        description: "Time to wait in milliseconds",
        default: 1000,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "dialog",
    action: "dialog",
    description: "Arm a handler for the next browser dialog (alert, confirm, prompt, beforeunload)",
    category: "system",
    args: {
      dialogResponse: {
        type: "string",
        description: "How to respond to the dialog",
        enum: ["accept", "dismiss"],
        default: "accept",
      },
      promptText: {
        type: "string",
        description: "Text to enter in a prompt dialog (optional, used with accept)",
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "frame",
    action: "frame",
    description: "Switch context to an iframe by CSS selector",
    category: "system",
    args: {
      selector: {
        type: "string",
        description: "CSS selector for the iframe element",
        required: true,
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "frame_main",
    action: "frame_main",
    description: "Switch context back to the main frame",
    category: "system",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Tab
  // ---------------------------------------------------------------------------
  {
    name: "tab_list",
    action: "tab_list",
    description: "List all open browser tabs with their URLs, titles, and short IDs",
    category: "tab",
    args: {},
  },
  {
    name: "tab_new",
    action: "tab_new",
    description: "Open a new browser tab, optionally navigating to a URL",
    category: "tab",
    args: {
      url: {
        type: "string",
        description: "URL to open in the new tab (defaults to about:blank)",
      },
    },
  },
  {
    name: "tab_select",
    action: "tab_select",
    description: "Switch to a tab by short ID or index",
    category: "tab",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID or full target ID",
      },
      index: {
        type: "number",
        description: "Tab index (0-based, used if tab is not specified)",
      },
    },
  },
  {
    name: "tab_close",
    action: "tab_close",
    description: "Close a specific tab by short ID or index",
    category: "tab",
    args: {
      tab: {
        type: "string",
        description: "Tab short ID or full target ID",
      },
      index: {
        type: "number",
        description: "Tab index (0-based, used if tab is not specified)",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Network / observation
  // ---------------------------------------------------------------------------
  {
    name: "network",
    action: "network",
    description: "Inspect or manage network activity. Supports incremental queries with since.",
    category: "network",
    args: {
      networkCommand: {
        type: "string",
        description: "Network sub-command",
        enum: ["requests", "route", "unroute", "clear"],
        default: "requests",
      },
      filter: {
        type: "string",
        description: "URL substring filter for requests",
      },
      since: {
        type: "string",
        description: "Incremental query: 'last_action' for events since last operation, or a seq number",
      },
      method: {
        type: "string",
        description: "Filter by HTTP method (GET, POST, etc.)",
      },
      status: {
        type: "string",
        description: "Filter by status: '4xx', '5xx', or exact code like '200'",
      },
      limit: {
        type: "number",
        description: "Max number of results to return",
      },
      withBody: {
        type: "boolean",
        description: "Include request and response bodies",
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "console",
    action: "console",
    description: "Get or clear console messages from the page",
    category: "network",
    args: {
      consoleCommand: {
        type: "string",
        description: "Console sub-command",
        enum: ["get", "clear"],
        default: "get",
      },
      filter: {
        type: "string",
        description: "Filter console messages by text substring",
      },
      since: {
        type: "string",
        description: "Incremental query: 'last_action' for events since last operation, or a seq number",
      },
      limit: {
        type: "number",
        description: "Max number of results to return",
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "errors",
    action: "errors",
    description: "Get or clear JavaScript errors from the page",
    category: "network",
    args: {
      errorsCommand: {
        type: "string",
        description: "Errors sub-command",
        enum: ["get", "clear"],
        default: "get",
      },
      filter: {
        type: "string",
        description: "Filter errors by text substring",
      },
      since: {
        type: "string",
        description: "Incremental query: 'last_action' for events since last operation, or a seq number",
      },
      limit: {
        type: "number",
        description: "Max number of results to return",
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "trace",
    action: "trace",
    description: "Record user interactions for replay or code generation",
    category: "network",
    args: {
      traceCommand: {
        type: "string",
        description: "Trace sub-command",
        required: true,
        enum: ["start", "stop", "status"],
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
  },
  {
    name: "history",
    action: "history",
    description: "Search browsing history or list domains (not supported in daemon mode)",
    category: "network",
    args: {
      historyCommand: {
        type: "string",
        description: "History sub-command",
        required: true,
        enum: ["search", "domains"],
      },
      tab: {
        type: "string",
        description: "Tab short ID",
      },
    },
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
