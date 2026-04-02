/**
 * screenshot 命令 - 截取当前页面
 * 用法：
 *   bb-browser screenshot              # 保存到临时目录
 *   bb-browser screenshot ./page.png   # 保存到指定路径
 *   bb-browser screenshot --json       # 返回 { path, base64 }
 */

import fs from "fs";
import path from "path";
import os from "os";
import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface ScreenshotOptions {
  json?: boolean;
  tabId?: string | number;
}

/**
 * 生成默认截图路径
 */
function getDefaultPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `bb-screenshot-${timestamp}.png`;
  return path.join(os.tmpdir(), filename);
}

/**
 * 解码 data URL 并保存为文件
 */
function saveBase64Image(dataUrl: string, filePath: string): void {
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");
  
  // 确保目录存在
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(filePath, buffer);
}

export async function screenshotCommand(
  outputPath?: string,
  options: ScreenshotOptions = {}
): Promise<void> {
  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 确定保存路径
  const filePath = outputPath ? path.resolve(outputPath) : getDefaultPath();

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "screenshot",
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 处理结果
  if (response.success && response.data?.dataUrl) {
    const dataUrl = response.data.dataUrl as string;
    
    // 保存文件
    saveBase64Image(dataUrl, filePath);

    // 输出结果
    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        path: filePath,
        base64: dataUrl,
      }, null, 2));
    } else {
      console.log(`截图已保存: ${filePath}`);
    }
  } else {
    if (options.json) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      console.error(`错误: ${response.error}`);
    }
    process.exit(1);
  }
}
