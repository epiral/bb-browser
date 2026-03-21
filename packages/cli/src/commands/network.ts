/**
 * network 命令 - 网络监控和拦截
 */

import { generateId } from "@bb-browser/shared";
import { sendCommand } from "../client.js";

interface NetworkOptions {
  json?: boolean;
  abort?: boolean;
  body?: string;
  withBody?: boolean;
  tabId?: number;
}

export async function networkCommand(
  subCommand: string,
  urlOrFilter?: string,
  options: NetworkOptions = {}
): Promise<void> {
  const response = await sendCommand({
    id: generateId(),
    action: "network",
    networkCommand: subCommand as "requests" | "route" | "unroute" | "clear",
    url: subCommand === "route" || subCommand === "unroute" ? urlOrFilter : undefined,
    filter: subCommand === "requests" ? urlOrFilter : undefined,
    routeOptions: subCommand === "route" ? {
      abort: options.abort,
      body: options.body,
    } : undefined,
    withBody: subCommand === "requests" ? options.withBody : undefined,
    tabId: options.tabId,
  });

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (!response.success) {
    throw new Error(response.error || "Network command failed");
  }

  const data = response.data;

  switch (subCommand) {
    case "requests": {
      const requests = data?.networkRequests || [];
      if (requests.length === 0) {
        console.log("没有网络请求记录");
        console.log("提示: 使用 network requests 会自动开始监控");
      } else {
        console.log(`网络请求 (${requests.length} 条):\n`);
        for (const req of requests) {
          const status = req.failed 
            ? `FAILED (${req.failureReason})` 
            : (req.status ? `${req.status} ${req.statusText || ''}` : 'pending');
          console.log(`${req.method} ${req.url}`);
          console.log(`  类型: ${req.type}, 状态: ${status}`);
          if (options.withBody) {
            const requestHeaderCount = req.requestHeaders ? Object.keys(req.requestHeaders).length : 0;
            const responseHeaderCount = req.responseHeaders ? Object.keys(req.responseHeaders).length : 0;
            console.log(`  请求头: ${requestHeaderCount}, 响应头: ${responseHeaderCount}`);
            if (req.requestBody !== undefined) {
              const preview = req.requestBody.length > 200 ? `${req.requestBody.slice(0, 200)}...` : req.requestBody;
              console.log(`  请求体: ${preview}`);
            }
            if (req.responseBody !== undefined) {
              const preview = req.responseBody.length > 200 ? `${req.responseBody.slice(0, 200)}...` : req.responseBody;
              console.log(`  响应体: ${preview}`);
            }
            if (req.bodyError) {
              console.log(`  Body错误: ${req.bodyError}`);
            }
          }
          console.log("");
        }
      }
      break;
    }

    case "route": {
      console.log(`已添加拦截规则: ${urlOrFilter}`);
      if (options.abort) {
        console.log("  行为: 阻止请求");
      } else if (options.body) {
        console.log("  行为: 返回 mock 数据");
      } else {
        console.log("  行为: 继续请求");
      }
      console.log(`当前规则数: ${data?.routeCount || 0}`);
      break;
    }

    case "unroute": {
      if (urlOrFilter) {
        console.log(`已移除拦截规则: ${urlOrFilter}`);
      } else {
        console.log("已移除所有拦截规则");
      }
      console.log(`剩余规则数: ${data?.routeCount || 0}`);
      break;
    }

    case "clear": {
      console.log("已清空网络请求记录");
      break;
    }

    default:
      throw new Error(`未知的 network 子命令: ${subCommand}`);
  }
}
