/**
 * snapshot 命令 - 获取当前页面快照
 * 用法：bb-browser snapshot [-i|--interactive] [-c|--compact] [-d|--depth N] [-s|--selector SEL]
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface SnapshotOptions {
  json?: boolean;
  /** 只输出可交互元素 */
  interactive?: boolean;
  /** 移除空结构节点 */
  compact?: boolean;
  /** 限制树深度 */
  maxDepth?: number;
  /** CSS 选择器范围 */
  selector?: string;
  tabId?: string | number;
}

export async function snapshotCommand(
  options: SnapshotOptions = {}
): Promise<void> {
  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "snapshot",
    interactive: options.interactive,
    compact: options.compact,
    maxDepth: options.maxDepth,
    selector: options.selector,
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      console.log(`标题: ${response.data?.title ?? "(无标题)"}`);
      console.log(`URL: ${response.data?.url ?? "(未知)"}`);
      // 输出 snapshot 文本
      if (response.data?.snapshotData?.snapshot) {
        console.log("");
        console.log(response.data.snapshotData.snapshot);
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
