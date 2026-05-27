/**
 * eval 命令 - 在页面上下文中执行 JavaScript
 *
 * 支持 --domain 自动路由到匹配的 Tab（或新建），以及 --args 传递 JSON 参数。
 */

import type { Request, Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface EvalOptions {
  json?: boolean;
  tabId?: string | number;
  domain?: string;
  args?: string;
}

export async function evalCommand(
  script: string,
  options: EvalOptions = {}
): Promise<void> {
  if (!script) throw new Error("缺少 script 参数");

  await ensureDaemonRunning();

  // Parse --args as JSON
  let args: Record<string, unknown> | undefined;
  if (options.args) {
    try {
      args = JSON.parse(options.args);
    } catch {
      throw new Error(`--args must be valid JSON: ${options.args}`);
    }
  }

  const request: Request = {
    method: "eval",
    script,
    ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
    ...(args !== undefined ? { args } : {}),
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.result) {
      const result = response.result?.result;
      if (result !== undefined) {
        if (typeof result === "object" && result !== null) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result);
        }
      } else {
        console.log("undefined");
      }
    } else {
      console.error(`错误: ${response.error?.message}`);
      process.exit(1);
    }
  }
}
