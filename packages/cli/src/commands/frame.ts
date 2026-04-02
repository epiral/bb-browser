/**
 * frame 命令 - 切换到 iframe 或返回主 frame
 * 用法：
 *   bb-browser frame <selector>   切换到指定 iframe
 *   bb-browser frame main         返回主 frame
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface FrameOptions {
  json?: boolean;
  tabId?: string | number;
}

/**
 * 切换到指定 iframe
 * @param selector CSS 选择器，用于定位 iframe 元素
 */
export async function frameCommand(
  selector: string,
  options: FrameOptions = {}
): Promise<void> {
  if (!selector) {
    throw new Error("缺少 selector 参数");
  }

  await ensureDaemonRunning();

  const request: Request = {
    id: generateId(),
    action: "frame",
    selector,
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const frameInfo = response.data?.frameInfo;
      if (frameInfo?.url) {
        console.log(`已切换到 frame: ${selector} (${frameInfo.url})`);
      } else {
        console.log(`已切换到 frame: ${selector}`);
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}

/**
 * 返回主 frame
 */
export async function frameMainCommand(
  options: FrameOptions = {}
): Promise<void> {
  await ensureDaemonRunning();

  const request: Request = {
    id: generateId(),
    action: "frame_main",
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      console.log("已返回主 frame");
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
