/**
 * goto 命令 - 在当前 tab 中导航到新 URL（保持 tab 上下文）
 *
 * 用法：
 *   bb-browser goto <url> --tab <tabId>
 */

import type { Request, Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface GotoOptions {
  json?: boolean;
  tabId?: string | number;
}

export async function gotoCommand(
  url: string,
  options: GotoOptions = {}
): Promise<void> {
  if (!url) {
    throw new Error("Missing URL parameter");
  }

  await ensureDaemonRunning();

  const request: Request = {
    method: "goto",
    url,
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.result) {
      console.log(`tab: ${response.result.tab}`);
      console.log(`url: ${response.result.url}`);
    } else {
      console.error(`Error: ${response.error?.message}`);
      process.exit(1);
    }
  }
}
