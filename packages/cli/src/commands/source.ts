/**
 * source 命令 - 搜索已加载的 JavaScript 源码
 *
 * 用法：
 *   bb-browser source grep <pattern> --tab <tabId>
 */

import type { Request, Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";

export interface SourceOptions {
  json?: boolean;
  tabId?: string | number;
}

export async function sourceCommand(
  subCommand: string,
  pattern: string,
  options: SourceOptions = {}
): Promise<void> {
  const request: Request = {
    method: "source",
    sourceCommand: subCommand,
    sourcePattern: pattern,
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (response.error) {
    throw new Error(response.error.message || "Source command failed");
  }

  const data = response.result;
  const results = (data as any)?.sourceResults || [];

  if (results.length === 0) {
    console.log(`No matches found for "${pattern}"`);
    return;
  }

  let totalMatches = 0;
  for (const result of results) {
    totalMatches += result.matches.length;
    console.log(`=== ${result.url} (${result.matches.length} matches) ===`);
    for (const match of result.matches) {
      console.log(`  ${match}`);
    }
    console.log("");
  }

  console.log(`${totalMatches} matches in ${results.length} files`);
}
