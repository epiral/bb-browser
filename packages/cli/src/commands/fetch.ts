/**
 * fetch 命令 - 在浏览器上下文中执行 fetch()，自动处理同源路由
 *
 * 用法：
 *   bb-browser fetch <url> [options]
 *   bb-browser fetch https://www.reddit.com/api/me.json
 *   bb-browser fetch /api/me.json                     # 相对路径，用当前 tab 的 origin
 *   bb-browser fetch https://www.reddit.com/... --json
 *   bb-browser fetch https://x.com/... --method POST --body '{"query":"..."}'
 *
 * 本质：curl，但带浏览器登录态。
 */

import { generateId, type Request, type Response, type TabInfo } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface FetchOptions {
  json?: boolean;
  method?: string;
  body?: string;
  headers?: string;
  output?: string;
  tabId?: string | number;
}

/**
 * 精确匹配 tab 的 origin
 */
function matchTabOrigin(tabUrl: string, targetHostname: string): boolean {
  try {
    const tabHostname = new URL(tabUrl).hostname;
    return tabHostname === targetHostname || tabHostname.endsWith("." + targetHostname);
  } catch {
    return false;
  }
}

/**
 * 找到匹配域名的 tab，如果没有则新建
 */
async function ensureTabForOrigin(origin: string, hostname: string): Promise<number | undefined> {
  const listReq: Request = { id: generateId(), action: "tab_list" };
  const listResp: Response = await sendCommand(listReq);

  if (listResp.success && listResp.data?.tabs) {
    const matchingTab = listResp.data.tabs.find((tab: TabInfo) =>
      matchTabOrigin(tab.url, hostname)
    );

    if (matchingTab) {
      return matchingTab.tabId;
    }
  }

  const newResp: Response = await sendCommand({ id: generateId(), action: "tab_new", url: origin });
  if (!newResp.success) {
    throw new Error(`无法打开 ${origin}: ${newResp.error}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return newResp.data?.tabId;
}

/**
 * 构造浏览器内执行的 fetch JS 代码
 * 修复 Codex review: headers 通过 JSON.stringify 传入，不做字符串拼接
 */
function buildFetchScript(url: string, options: FetchOptions): string {
  const method = (options.method || "GET").toUpperCase();
  const hasBody = options.body && method !== "GET" && method !== "HEAD";

  // headers 通过 JSON.parse 安全传入，避免代码注入
  let headersExpr = "{}";
  if (options.headers) {
    try {
      // 验证是合法 JSON
      JSON.parse(options.headers);
      headersExpr = options.headers;
    } catch {
      throw new Error(`--headers must be valid JSON. Got: ${options.headers}`);
    }
  }

  return `(async () => {
    try {
      const resp = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        credentials: 'include',
        headers: ${headersExpr}${hasBody ? `,\n        body: ${JSON.stringify(options.body)}` : ""}
      });
      const contentType = resp.headers.get('content-type') || '';
      let body;
      if (contentType.includes('application/json') && resp.status !== 204) {
        try { body = await resp.json(); } catch { body = await resp.text(); }
      } else {
        body = await resp.text();
      }
      return JSON.stringify({
        status: resp.status,
        contentType,
        body
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  })()`;
}

export async function fetchCommand(
  url: string,
  options: FetchOptions = {}
): Promise<void> {
  if (!url) {
    throw new Error(
      "缺少 URL 参数\n" +
      "  用法: bb-browser fetch <url> [--json] [--method POST] [--body '{...}']\n" +
      "  示例: bb-browser fetch https://www.reddit.com/api/me.json --json"
    );
  }

  await ensureDaemonRunning();

  const isAbsolute = url.startsWith("http://") || url.startsWith("https://");
  let targetTabId = options.tabId;

  if (isAbsolute) {
    let origin: string;
    let hostname: string;
    try {
      const parsed = new URL(url);
      origin = parsed.origin;
      hostname = parsed.hostname;
    } catch {
      throw new Error(`无效的 URL: ${url}`);
    }

    if (!targetTabId) {
      targetTabId = await ensureTabForOrigin(origin, hostname);
    }
  }

  const script = buildFetchScript(url, options);
  const evalReq: Request = { id: generateId(), action: "eval", script, tabId: targetTabId };
  const evalResp: Response = await sendCommand(evalReq);

  if (!evalResp.success) {
    throw new Error(`Fetch 失败: ${evalResp.error}`);
  }

  const rawResult = evalResp.data?.result;
  if (rawResult === undefined || rawResult === null) {
    throw new Error("Fetch 未返回结果");
  }

  let result: { status?: number; contentType?: string; body?: unknown; error?: string };
  try {
    result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult as typeof result;
  } catch {
    console.log(rawResult);
    return;
  }

  if (result.error) {
    throw new Error(`Fetch error: ${result.error}`);
  }

  // 写文件
  if (options.output) {
    const { writeFileSync } = await import("node:fs");
    const content = typeof result.body === "object"
      ? JSON.stringify(result.body, null, 2)
      : String(result.body);
    writeFileSync(options.output, content, "utf-8");
    console.log(`已写入 ${options.output} (${result.status}, ${content.length} bytes)`);
    return;
  }

  // 输出
  if (typeof result.body === "object") {
    console.log(JSON.stringify(result.body, null, 2));
  } else {
    console.log(result.body);
  }
}
