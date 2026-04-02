/**
 * errors 命令 - 查看 JS 错误
 */

import { generateId, type Request } from "@bb-browser/shared";
import { sendCommand } from "../client.js";

interface ErrorsOptions {
  json?: boolean;
  clear?: boolean;
  tabId?: string | number;
  since?: string;        // "last_action" or a seq number
}

export async function errorsCommand(options: ErrorsOptions = {}): Promise<void> {
  // Parse since: if numeric string, convert to number
  let since: string | number | undefined;
  if (options.since) {
    const num = parseInt(options.since, 10);
    since = (!isNaN(num) && String(num) === options.since) ? num : options.since;
  }

  const request: Request & { since?: string | number } = {
    id: generateId(),
    action: "errors",
    errorsCommand: options.clear ? "clear" : "get",
    tabId: options.tabId,
    since,
  };
  const response = await sendCommand(request as Request);

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (!response.success) {
    throw new Error(response.error || "Errors command failed");
  }

  if (options.clear) {
    console.log("已清空 JS 错误记录");
    return;
  }

  const errors = response.data?.jsErrors || [];
  
  if (errors.length === 0) {
    console.log("没有 JS 错误");
    console.log("提示: errors 命令会自动开始监控");
    return;
  }

  console.log(`JS 错误 (${errors.length} 条):\n`);

  for (const err of errors) {
    console.log(`[ERROR] ${err.message}`);
    if (err.url) {
      console.log(`  位置: ${err.url}:${err.lineNumber || 0}:${err.columnNumber || 0}`);
    }
    if (err.stackTrace) {
      console.log(`  堆栈:`);
      console.log(err.stackTrace.split('\n').map(line => `    ${line}`).join('\n'));
    }
    console.log("");
  }
}
