/**
 * open 命令 - 打开指定 URL
 * 
 * 用法：
 *   bb-browser open <url>                # 在新 tab 中打开
 *   bb-browser open <url> --tab current  # 在当前 tab 中打开
 *   bb-browser open <url> --tab 123      # 在指定 tabId 的 tab 中打开
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";
import { getSiteHintForDomain } from "./site.js";

export interface OpenOptions {
  json?: boolean;
  tab?: string;  // "current" | tabId 数字字符串 | undefined（新建 tab）
}

export async function openCommand(
  url: string,
  options: OpenOptions = {}
): Promise<void> {
  // 验证 URL
  if (!url) {
    throw new Error("缺少 URL 参数");
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 补全 URL 协议
  let normalizedUrl = url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    normalizedUrl = "https://" + url;
  }

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "open",
    url: normalizedUrl,
  };

  // 处理 --tab 参数
  if (options.tab !== undefined) {
    if (options.tab === "current") {
      // 使用当前活动 tab
      (request as Record<string, unknown>).tabId = "current";
    } else {
      // 使用指定 tabId
      const tabId = parseInt(options.tab, 10);
      if (isNaN(tabId)) {
        throw new Error(`无效的 tabId: ${options.tab}`);
      }
      (request as Record<string, unknown>).tabId = tabId;
    }
  }
  // 不指定 --tab 时，tabId 为 undefined，扩展会创建新 tab

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      console.log(`已打开: ${response.data?.url ?? normalizedUrl}`);
      if (response.data?.title) {
        console.log(`标题: ${response.data.title}`);
      }
      if (response.data?.tabId) {
        console.log(`Tab ID: ${response.data.tabId}`);
      }
      // 提示：如果该域名有 site adapter，引导使用
      const siteHint = getSiteHintForDomain(normalizedUrl);
      if (siteHint) {
        console.log(`\n💡 ${siteHint}`);
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
