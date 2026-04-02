/**
 * press 命令 - 发送键盘按键
 * 用法：bb-browser press <key>
 *
 * key 支持格式：
 *   - 单键："Enter", "Tab", "Escape", "Backspace", "ArrowUp" 等
 *   - 组合键："Control+a", "Control+c", "Control+v"（用 + 分隔）
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface PressOptions {
  json?: boolean;
  tabId?: string | number;
}

/**
 * 解析按键字符串，提取修饰键和主键
 * 例如：
 *   "Enter" -> { key: "Enter", modifiers: [] }
 *   "Control+a" -> { key: "a", modifiers: ["Control"] }
 *   "Control+Shift+Delete" -> { key: "Delete", modifiers: ["Control", "Shift"] }
 */
function parseKey(keyString: string): { key: string; modifiers: string[] } {
  const parts = keyString.split("+");
  const modifierNames = ["Control", "Alt", "Shift", "Meta"];

  const modifiers: string[] = [];
  let key = "";

  for (const part of parts) {
    if (modifierNames.includes(part)) {
      modifiers.push(part);
    } else {
      key = part;
    }
  }

  return { key, modifiers };
}

export async function pressCommand(
  keyString: string,
  options: PressOptions = {}
): Promise<void> {
  // 验证参数
  if (!keyString) {
    throw new Error("缺少 key 参数");
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 解析按键
  const { key, modifiers } = parseKey(keyString);

  if (!key) {
    throw new Error("无效的按键格式");
  }

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "press",
    key,
    modifiers,
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const displayKey = modifiers.length > 0 ? `${modifiers.join("+")}+${key}` : key;
      console.log(`已按下: ${displayKey}`);
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
