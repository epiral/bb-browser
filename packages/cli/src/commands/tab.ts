/**
 * tab 命令 - 标签页管理
 * 用法：
 *   bb-browser tab                    列出所有标签页
 *   bb-browser tab new [url]          新建标签页
 *   bb-browser tab <n>                切换到第 n 个标签页（按 index）
 *   bb-browser tab close [n]          关闭标签页（按 index）
 *   bb-browser tab select --id <id>   切换到指定 tabId 的标签页
 *   bb-browser tab close --id <id>    关闭指定 tabId 的标签页
 */

import { generateId, type Request, type Response, type TabInfo } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface TabOptions {
  json?: boolean;
  globalTabId?: string;
}

/**
 * 解析 tab 子命令
 * @param args 命令参数数组（已去掉 flags）
 * @param rawArgv 原始 process.argv（用于提取 --id）
 * @returns 解析后的子命令和参数
 */
function parseTabSubcommand(args: string[], rawArgv?: string[]): {
  action: "tab_list" | "tab_new" | "tab_select" | "tab_close";
  url?: string;
  index?: number;
  tabId?: string | number;
} {
  // 提取 --id 参数
  let tabId: number | undefined;
  if (rawArgv) {
    const idIdx = rawArgv.indexOf("--id");
    if (idIdx >= 0 && rawArgv[idIdx + 1]) {
      tabId = parseInt(rawArgv[idIdx + 1], 10);
      if (isNaN(tabId)) {
        throw new Error(`无效的 tabId: ${rawArgv[idIdx + 1]}`);
      }
    }
  }

  if (args.length === 0) {
    return { action: "tab_list" };
  }

  const first = args[0];

  // tab list
  if (first === "list") {
    return { action: "tab_list" };
  }

  // tab new [url]
  if (first === "new") {
    return { action: "tab_new", url: args[1] };
  }

  // tab select --id <tabId>
  if (first === "select") {
    if (tabId !== undefined) {
      return { action: "tab_select", tabId };
    }
    throw new Error("tab select 需要 --id 参数，用法：bb-browser tab select --id <tabId>");
  }

  // tab close [n | --id <tabId>]
  if (first === "close") {
    if (tabId !== undefined) {
      return { action: "tab_close", tabId };
    }
    const indexArg = args[1];
    if (indexArg !== undefined) {
      const index = parseInt(indexArg, 10);
      if (isNaN(index) || index < 0) {
        throw new Error(`无效的标签页索引: ${indexArg}`);
      }
      return { action: "tab_close", index };
    }
    return { action: "tab_close" };
  }

  // tab <n> - 切换到第 n 个标签页
  const index = parseInt(first, 10);
  if (!isNaN(index) && index >= 0) {
    return { action: "tab_select", index };
  }

  throw new Error(`未知的 tab 子命令: ${first}`);
}

/**
 * 格式化标签页列表输出
 */
function formatTabList(tabs: TabInfo[], activeIndex: number): string {
  const lines: string[] = [];
  lines.push(`标签页列表（共 ${tabs.length} 个，当前 #${activeIndex}）：`);

  for (const tab of tabs) {
    const prefix = tab.active ? "*" : " ";
    const title = tab.title || "(无标题)";
    lines.push(`${prefix} [${tab.index}] ${tab.url} - ${title}`);
  }

  return lines.join("\n");
}

export async function tabCommand(
  args: string[],
  options: TabOptions = {}
): Promise<void> {
  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 解析子命令
  const parsed = parseTabSubcommand(args, process.argv);

  // If globalTabId is set and no explicit --id was provided, use globalTabId for close/select
  if (options.globalTabId && parsed.tabId === undefined && parsed.index === undefined) {
    if (parsed.action === "tab_close" || parsed.action === "tab_select") {
      const numId = parseInt(options.globalTabId, 10);
      parsed.tabId = isNaN(numId) ? options.globalTabId : numId;
    }
  }

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: parsed.action,
    url: parsed.url,
    index: parsed.index,
    tabId: parsed.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      switch (parsed.action) {
        case "tab_list": {
          const tabs = response.data?.tabs ?? [];
          const activeIndex = response.data?.activeIndex ?? 0;
          console.log(formatTabList(tabs, activeIndex));
          break;
        }
        case "tab_new": {
          const url = response.data?.url ?? "about:blank";
          console.log(`已创建新标签页: ${url}`);
          break;
        }
        case "tab_select": {
          const title = response.data?.title ?? "(无标题)";
          const url = response.data?.url ?? "";
          console.log(`已切换到标签页 #${parsed.index}: ${title}`);
          console.log(`  URL: ${url}`);
          break;
        }
        case "tab_close": {
          const closedTitle = response.data?.title ?? "(无标题)";
          console.log(`已关闭标签页: ${closedTitle}`);
          break;
        }
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
