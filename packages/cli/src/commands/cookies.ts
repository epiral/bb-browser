/**
 * cookies 命令 - 获取和管理 Cookies（包括 HttpOnly）
 */

import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

interface CookiesOptions {
  json?: boolean;
  tabId?: number;
}

export async function cookiesCommand(
  subCommand: string,
  name?: string,
  options: CookiesOptions = {}
): Promise<void> {
  await ensureDaemonRunning();

  const response = await sendCommand({
    id: crypto.randomUUID(),
    action: "cookies",
    cookiesCommand: subCommand as "get" | "getByName" | "httpOnly",
    name: name,
    tabId: options.tabId,
  });

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (!response.success) {
    throw new Error(response.error || "Cookies command failed");
  }

  const data = response.data;

  switch (subCommand) {
    case "get": {
      const cookies = data?.cookies || [];
      console.log(`Cookies (${cookies.length} 个, URL: ${data?.url}):\n`);
      for (const cookie of cookies) {
        const flags = [];
        if (cookie.httpOnly) flags.push("HttpOnly");
        if (cookie.secure) flags.push("Secure");
        if (cookie.sameSite) flags.push(`SameSite=${cookie.sameSite}`);
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        console.log(`${cookie.name}: ${cookie.value}${flagStr}`);
        console.log(`  域: ${cookie.domain}, 路径: ${cookie.path}`);
        if (cookie.expires) {
          const expiryDate = new Date(cookie.expires * 1000);
          console.log(`  过期: ${expiryDate.toLocaleString()}`);
        }
        console.log("");
      }
      break;
    }

    case "getByName": {
      const cookie = data?.cookie;
      if (!cookie) {
        console.log(`未找到 Cookie: ${name}`);
        const available = data?.availableCookies || [];
        if (available.length > 0) {
          console.log(`可用的 Cookie: ${available.join(", ")}`);
        }
      } else {
        const flags = [];
        if (cookie.httpOnly) flags.push("HttpOnly");
        if (cookie.secure) flags.push("Secure");
        if (cookie.sameSite) flags.push(`SameSite=${cookie.sameSite}`);
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        console.log(`${cookie.name}: ${cookie.value}${flagStr}`);
        console.log(`  域: ${cookie.domain}, 路径: ${cookie.path}`);
        if (cookie.expires) {
          const expiryDate = new Date(cookie.expires * 1000);
          console.log(`  过期: ${expiryDate.toLocaleString()}`);
        }
      }
      break;
    }

    case "httpOnly": {
      const cookies = data?.cookies || [];
      console.log(`HttpOnly Cookies (${cookies.length} 个, URL: ${data?.url}):\n`);
      for (const cookie of cookies) {
        const flags = ["HttpOnly"];
        if (cookie.secure) flags.push("Secure");
        if (cookie.sameSite) flags.push(`SameSite=${cookie.sameSite}`);
        const flagStr = flags.join(", ");
        console.log(`${cookie.name}: ${cookie.value} [${flagStr}]`);
        console.log(`  域: ${cookie.domain}, 路径: ${cookie.path}`);
        if (cookie.expires) {
          const expiryDate = new Date(cookie.expires * 1000);
          console.log(`  过期: ${expiryDate.toLocaleString()}`);
        }
        console.log("");
      }
      break;
    }

    default:
      throw new Error(`未知的 cookies 子命令: ${subCommand}`);
  }
}
