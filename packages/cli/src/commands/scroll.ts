/**
 * scroll 命令 - 滚动页面
 * 用法：bb-browser scroll <direction> [pixels]
 *
 * direction: up | down | left | right
 * pixels: 滚动像素数，默认 300
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface ScrollOptions {
  json?: boolean;
  tabId?: string | number;
}

export type ScrollDirection = "up" | "down" | "left" | "right";

const VALID_DIRECTIONS: ScrollDirection[] = ["up", "down", "left", "right"];
const DEFAULT_PIXELS = 300;

export async function scrollCommand(
  direction: string,
  pixels?: string,
  options: ScrollOptions = {}
): Promise<void> {
  // 验证 direction
  if (!direction) {
    throw new Error("缺少 direction 参数");
  }

  if (!VALID_DIRECTIONS.includes(direction as ScrollDirection)) {
    throw new Error(
      `无效的滚动方向: ${direction}，支持: ${VALID_DIRECTIONS.join(", ")}`
    );
  }

  // 解析 pixels
  let pixelValue = DEFAULT_PIXELS;
  if (pixels !== undefined) {
    pixelValue = parseInt(pixels, 10);
    if (isNaN(pixelValue) || pixelValue <= 0) {
      throw new Error(`无效的像素值: ${pixels}`);
    }
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "scroll",
    direction: direction as ScrollDirection,
    pixels: pixelValue,
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      console.log(`已滚动: ${direction} ${pixelValue}px`);
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
