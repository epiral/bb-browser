/**
 * console 命令 - 查看控制台消息
 */

import { generateId, type Request } from "@bb-browser/shared";
import { sendCommand } from "../client.js";

interface ConsoleOptions {
  json?: boolean;
  clear?: boolean;
  tabId?: string | number;
  since?: string;        // "last_action" or a seq number
}

export async function consoleCommand(options: ConsoleOptions = {}): Promise<void> {
  // Parse since: if numeric string, convert to number
  let since: string | number | undefined;
  if (options.since) {
    const num = parseInt(options.since, 10);
    since = (!isNaN(num) && String(num) === options.since) ? num : options.since;
  }

  const request: Request & { since?: string | number } = {
    id: generateId(),
    action: "console",
    consoleCommand: options.clear ? "clear" : "get",
    tabId: options.tabId,
    since,
  };
  const response = await sendCommand(request as Request);

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (!response.success) {
    throw new Error(response.error || "Console command failed");
  }

  if (options.clear) {
    console.log("已清空控制台消息");
    return;
  }

  const messages = response.data?.consoleMessages || [];
  
  if (messages.length === 0) {
    console.log("没有控制台消息");
    console.log("提示: console 命令会自动开始监控");
    return;
  }

  console.log(`控制台消息 (${messages.length} 条):\n`);

  const typeColors: Record<string, string> = {
    log: "",
    info: "[INFO]",
    warn: "[WARN]",
    error: "[ERROR]",
    debug: "[DEBUG]",
  };

  for (const msg of messages) {
    const prefix = typeColors[msg.type] || `[${msg.type.toUpperCase()}]`;
    const location = msg.url ? ` (${msg.url}${msg.lineNumber ? `:${msg.lineNumber}` : ""})` : "";
    
    if (prefix) {
      console.log(`${prefix} ${msg.text}${location}`);
    } else {
      console.log(`${msg.text}${location}`);
    }
  }
}
