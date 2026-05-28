/**
 * cookies 命令 - 查看当前页面的 cookies
 *
 * 用法：
 *   bb-browser cookies --tab <tabId>
 *   bb-browser cookies --tab <tabId> --filter <name-or-domain>
 */

import type { Request, Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";

export interface CookiesOptions {
  json?: boolean;
  tabId?: string | number;
  filter?: string;
}

export async function cookiesCommand(
  options: CookiesOptions = {}
): Promise<void> {
  const request: Request = {
    method: "cookies",
    tabId: options.tabId,
    filter: options.filter,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (response.error) {
    throw new Error(response.error.message || "Cookies command failed");
  }

  const data = response.result;
  const cookies = (data as any)?.cookies || [];

  if (cookies.length === 0) {
    console.log("No cookies found");
    return;
  }

  console.log(`Cookies (${cookies.length}):\n`);
  for (const c of cookies) {
    const flags: string[] = [];
    if (c.httpOnly) flags.push("httpOnly");
    if (c.secure) flags.push("secure");
    const expiresStr = c.expires > 0
      ? `expires=${new Date(c.expires * 1000).toISOString().split("T")[0]}`
      : "session";
    const flagStr = flags.length > 0 ? `  ${flags.join("  ")}` : "";
    console.log(`name=${c.name}  domain=${c.domain}  path=${c.path}${flagStr}  ${expiresStr}`);
  }
}
