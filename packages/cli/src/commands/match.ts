/**
 * match 命令 - 高亮匹配到的元素，便于肉眼确认 locator 是否正确
 * 用法：bb-browser match <ref>
 *
 * ref 支持格式：
 *   - "@5" 或 "5"：使用 snapshot 返回的 ref ID
 *   - "@@searchBox"：使用持久化 tag
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";
import { parseLocatorInput } from "../locator.js";

export interface MatchOptions {
  json?: boolean;
  tabId?: string | number;
}

export async function matchCommand(
  ref: string,
  options: MatchOptions = {},
): Promise<void> {
  if (!ref) {
    throw new Error("缺少 ref 参数");
  }

  await ensureDaemonRunning();

  const request: Request = {
    id: generateId(),
    action: "match",
    ref: parseLocatorInput(ref),
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else if (response.success) {
    const role = response.data?.role ?? "element";
    const name = response.data?.name;
    if (name) {
      console.log(`已高亮匹配: ${role} "${name}"`);
    } else {
      console.log(`已高亮匹配: ${role}`);
    }
  } else {
    console.error(`错误: ${response.error}`);
    process.exit(1);
  }
}
