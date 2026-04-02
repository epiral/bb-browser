/**
 * type 命令 - 在元素中逐字符输入文本（不清空原有内容）
 * 用法：bb-browser type <ref> <text>
 * 
 * 与 fill 命令的区别：
 *   - fill：先清空再填入
 *   - type：不清空，逐字符追加输入
 * 
 * ref 支持格式：
 *   - "@5" 或 "5"：使用 snapshot 返回的 ref ID
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface TypeOptions {
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

export async function typeCommand(
  ref: string,
  text: string,
  options: TypeOptions = {}
): Promise<void> {
  // 验证参数
  if (!ref) {
    throw new Error("缺少 ref 参数");
  }

  if (text === undefined || text === null) {
    throw new Error("缺少 text 参数");
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 解析 ref
  const parsedRef = parseRef(ref);

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "type",
    ref: parsedRef,
    text: text,
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
        console.log(`已输入: ${role} "${name}"`);
      } else {
        console.log(`已输入: ${role}`);
      }
      console.log(`内容: "${text}"`);
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
