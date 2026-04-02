/**
 * click 命令 - 点击元素
 * 用法：bb-browser click <ref>
 * 
 * ref 支持格式：
 *   - "@5" 或 "5"：使用 snapshot 返回的 ref ID
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface ClickOptions {
  json?: boolean;
  tabId?: string | number;
}

/**
 * 解析 ref 参数，支持 "@5" 或 "5" 格式
 */
function parseRef(ref: string): string {
  // 移除 @ 前缀（如果有）
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

export async function clickCommand(
  ref: string,
  options: ClickOptions = {}
): Promise<void> {
  // 验证 ref
  if (!ref) {
    throw new Error("缺少 ref 参数");
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 解析 ref
  const parsedRef = parseRef(ref);

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "click",
    ref: parsedRef,
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const role = response.data?.role ?? "element";
      const name = response.data?.name;
      if (name) {
        console.log(`已点击: ${role} "${name}"`);
      } else {
        console.log(`已点击: ${role}`);
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
