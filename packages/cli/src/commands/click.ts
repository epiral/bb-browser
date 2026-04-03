/**
 * click 命令 - 点击元素
 * 用法：
 *   bb-browser click <ref>
 *   bb-browser click --selector <css选择器>
 *   bb-browser click --coord <x,y>
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
  ref?: string;
  selector?: string;
  coord?: string;
}

/**
 * 解析 ref 参数，支持 "@5" 或 "5" 格式
 */
function parseRef(ref: string): string {
  // 移除 @ 前缀（如果有）
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

export async function clickCommand(
  options: ClickOptions = {}
): Promise<void> {
  const { ref, selector, coord } = options;

  // 验证
  if (!coord && !selector && !ref) {
    throw new Error("缺少参数：需要 ref、--selector 或 --coord");
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "click",
    tabId: options.tabId,
  };

  if (coord) {
    const parts = coord.split(",");
    const x = parseFloat(parts[0] ?? "");
    const y = parseFloat(parts[1] ?? "");
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`--coord 格式无效，应为 "x,y"，如 "320,200"`);
    }
    request.x = x;
    request.y = y;
  } else if (selector) {
    request.selector = selector;
  } else if (ref) {
    request.ref = parseRef(ref);
  }

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const role = (response.data as any)?.role ?? "element";
      const name = (response.data as any)?.name;
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
