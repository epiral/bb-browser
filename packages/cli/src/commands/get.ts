/**
 * get 命令 - 获取页面或元素信息
 * 用法：
 *   bb-browser get text <ref>  获取元素文本
 *   bb-browser get url         获取当前页面 URL
 *   bb-browser get title       获取页面标题
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";
import { parseLocatorInput } from "../locator.js";

export interface GetOptions {
  json?: boolean;
  tabId?: string | number;
}

/** 支持的 get 属性类型 */
export type GetAttribute = "text" | "url" | "title";

export async function getCommand(
  attribute: GetAttribute,
  ref: string | undefined,
  options: GetOptions = {}
): Promise<void> {
  // 验证参数
  if (attribute === "text" && !ref) {
    throw new Error("get text 需要 ref 参数，如: get text @5");
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "get",
    attribute,
    ref: ref ? parseLocatorInput(ref) : undefined,
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const value = response.data?.value ?? "";
      console.log(value);
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
