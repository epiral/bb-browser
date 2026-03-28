/**
 * history 命令 - 查询 Chrome 浏览历史
 *
 * 用法：
 *   bb-browser history search [query]   搜索历史记录
 *   bb-browser history domains          查看访问最多的域名
 */

import { getHistoryDomains, searchHistory } from "../history-sqlite.js";
import { generateId } from "@bb-browser/shared";

interface HistoryOptions {
  json?: boolean;
  days?: number;
  query?: string;
}

export async function historyCommand(
  subCommand: 'search' | 'domains',
  options: HistoryOptions = {}
): Promise<void> {
  const days = options.days || 30;
  const data = subCommand === "search"
    ? { historyItems: searchHistory(options.query, days) }
    : { historyDomains: getHistoryDomains(days) };

  if (options.json) {
    console.log(JSON.stringify({
      id: generateId(),
      success: true,
      data,
    }));
    return;
  }

  switch (subCommand) {
    case "search": {
      const items = data?.historyItems || [];

      console.log(`找到 ${items.length} 条历史记录\n`);

      if (items.length === 0) {
        console.log("没有找到匹配的历史记录");
        break;
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        console.log(`${i + 1}. ${item.title || '(无标题)'}`);
        console.log(`   ${item.url}`);
        console.log(`   访问次数: ${item.visitCount}`);
      }
      break;
    }

    case "domains": {
      const domains = data?.historyDomains || [];

      console.log(`找到 ${domains.length} 个域名\n`);

      if (domains.length === 0) {
        console.log("没有找到历史记录");
        break;
      }

      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        console.log(`${i + 1}. ${domain.domain}`);
        console.log(`   访问次数: ${domain.visits}`);
      }
      break;
    }

    default:
      throw new Error(`未知的 history 子命令: ${subCommand}`);
  }
}
