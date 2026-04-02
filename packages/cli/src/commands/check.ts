/**
 * check/uncheck 命令 - 勾选/取消勾选复选框
 * 用法：
 *   bb-browser check <ref>   勾选复选框
 *   bb-browser uncheck <ref> 取消勾选复选框
 * 
 * ref 支持格式：
 *   - "@5" 或 "5"：使用 snapshot 返回的 ref ID
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface CheckOptions {
  json?: boolean;
  tabId?: string | number;
}

/**
 * 解析 ref 参数，支持 "@5" 或 "5" 格式
 */
function parseRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

/**
 * 勾选复选框
 */
export async function checkCommand(
  ref: string,
  options: CheckOptions = {}
): Promise<void> {
  if (!ref) {
    throw new Error("缺少 ref 参数");
  }

  await ensureDaemonRunning();

  const parsedRef = parseRef(ref);

  const request: Request = {
    id: generateId(),
    action: "check",
    ref: parsedRef,
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const role = response.data?.role ?? "checkbox";
      const name = response.data?.name;
      const wasAlreadyChecked = response.data?.wasAlreadyChecked;
      
      if (wasAlreadyChecked) {
        if (name) {
          console.log(`已勾选（之前已勾选）: ${role} "${name}"`);
        } else {
          console.log(`已勾选（之前已勾选）: ${role}`);
        }
      } else {
        if (name) {
          console.log(`已勾选: ${role} "${name}"`);
        } else {
          console.log(`已勾选: ${role}`);
        }
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}

/**
 * 取消勾选复选框
 */
export async function uncheckCommand(
  ref: string,
  options: CheckOptions = {}
): Promise<void> {
  if (!ref) {
    throw new Error("缺少 ref 参数");
  }

  await ensureDaemonRunning();

  const parsedRef = parseRef(ref);

  const request: Request = {
    id: generateId(),
    action: "uncheck",
    ref: parsedRef,
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const role = response.data?.role ?? "checkbox";
      const name = response.data?.name;
      const wasAlreadyUnchecked = response.data?.wasAlreadyUnchecked;
      
      if (wasAlreadyUnchecked) {
        if (name) {
          console.log(`已取消勾选（之前未勾选）: ${role} "${name}"`);
        } else {
          console.log(`已取消勾选（之前未勾选）: ${role}`);
        }
      } else {
        if (name) {
          console.log(`已取消勾选: ${role} "${name}"`);
        } else {
          console.log(`已取消勾选: ${role}`);
        }
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
