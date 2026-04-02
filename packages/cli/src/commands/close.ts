/**
 * close 命令 - 关闭当前标签页
 * 用法：bb-browser close
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface CloseOptions {
  json?: boolean;
  tabId?: string | number;
}

export async function closeCommand(options: CloseOptions = {}): Promise<void> {
  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "close",
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const title = response.data?.title ?? "";
      if (title) {
        console.log(`已关闭: "${title}"`);
      } else {
        console.log("已关闭当前标签页");
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
