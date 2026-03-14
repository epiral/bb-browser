/**
 * site 命令 - 管理和运行社区/私有网站适配器
 *
 * 用法：
 *   bb-browser site list                      列出所有可用 site adapter
 *   bb-browser site search <query>            搜索
 *   bb-browser site <name> [args...]          运行（简写）
 *   bb-browser site run <name> [args...]      运行
 *   bb-browser site update                    更新社区 adapter 库
 *
 * 目录：
 *   ~/.bb-browser/sites/       私有 adapter（优先）
 *   ~/.bb-browser/bb-sites/    社区 adapter（bb-browser site update 拉取）
 */

import { generateId, type Request, type Response, type TabInfo } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const BB_DIR = join(homedir(), ".bb-browser");
const LOCAL_SITES_DIR = join(BB_DIR, "sites");
const COMMUNITY_SITES_DIR = join(BB_DIR, "bb-sites");
const COMMUNITY_REPO = "https://github.com/epiral/bb-sites.git";

export interface SiteOptions {
  json?: boolean;
  tabId?: number;
}

/** Adapter 参数定义 */
interface ArgDef {
  required?: boolean;
  description?: string;
}

/** Adapter 元数据 */
interface SiteMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, ArgDef>;
  capabilities?: string[];
  readOnly?: boolean;
  example?: string;
  filePath: string;
  source: "local" | "community";
}

/**
 * 从 JS 文件的 /* @meta JSON * / 块解析元数据
 */
function parseSiteMeta(filePath: string, source: "local" | "community"): SiteMeta | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // 从文件路径推断默认 name
  const sitesDir = source === "local" ? LOCAL_SITES_DIR : COMMUNITY_SITES_DIR;
  const relPath = relative(sitesDir, filePath);
  const defaultName = relPath.replace(/\.js$/, "").replace(/\\/g, "/");

  // 解析 /* @meta { ... } */ 块
  const metaMatch = content.match(/\/\*\s*@meta\s*\n([\s\S]*?)\*\//);
  if (metaMatch) {
    try {
      const metaJson = JSON.parse(metaMatch[1]);
      return {
        name: metaJson.name || defaultName,
        description: metaJson.description || "",
        domain: metaJson.domain || "",
        args: metaJson.args || {},
        capabilities: metaJson.capabilities,
        readOnly: metaJson.readOnly,
        example: metaJson.example,
        filePath,
        source,
      };
    } catch {
      // JSON 解析失败，回退到 @tag 模式
    }
  }

  // 回退：解析 // @tag 格式（兼容旧格式）
  const meta: SiteMeta = {
    name: defaultName,
    description: "",
    domain: "",
    args: {},
    filePath,
    source,
  };

  const tagPattern = /\/\/\s*@(\w+)[ \t]+(.*)/g;
  let match;
  while ((match = tagPattern.exec(content)) !== null) {
    const [, key, value] = match;
    switch (key) {
      case "name": meta.name = value.trim(); break;
      case "description": meta.description = value.trim(); break;
      case "domain": meta.domain = value.trim(); break;
      case "args":
        for (const arg of value.trim().split(/[,\s]+/).filter(Boolean)) {
          meta.args[arg] = { required: true };
        }
        break;
      case "example": meta.example = value.trim(); break;
    }
  }

  return meta;
}

/**
 * 扫描目录下所有 .js 文件
 */
function scanSites(dir: string, source: "local" | "community"): SiteMeta[] {
  if (!existsSync(dir)) return [];
  const sites: SiteMeta[] = [];

  function walk(currentDir: string): void {
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const meta = parseSiteMeta(fullPath, source);
        if (meta) sites.push(meta);
      }
    }
  }

  walk(dir);
  return sites;
}

/**
 * 获取所有 adapter（私有优先）
 */
function getAllSites(): SiteMeta[] {
  const community = scanSites(COMMUNITY_SITES_DIR, "community");
  const local = scanSites(LOCAL_SITES_DIR, "local");

  const byName = new Map<string, SiteMeta>();
  for (const s of community) byName.set(s.name, s);
  for (const s of local) byName.set(s.name, s);

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 精确匹配 tab 的 origin
 */
function matchTabOrigin(tabUrl: string, domain: string): boolean {
  try {
    const tabOrigin = new URL(tabUrl).hostname;
    return tabOrigin === domain || tabOrigin.endsWith("." + domain);
  } catch {
    return false;
  }
}

// ── 子命令 ──────────────────────────────────────────────────────

function siteList(options: SiteOptions): void {
  const sites = getAllSites();

  if (sites.length === 0) {
    console.log("未找到任何 site adapter。");
    console.log("  安装社区 adapter: bb-browser site update");
    console.log(`  私有 adapter 目录: ${LOCAL_SITES_DIR}`);
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(sites.map(s => ({
      name: s.name, description: s.description, domain: s.domain,
      args: s.args, source: s.source,
    })), null, 2));
    return;
  }

  const groups = new Map<string, SiteMeta[]>();
  for (const s of sites) {
    const platform = s.name.split("/")[0];
    if (!groups.has(platform)) groups.set(platform, []);
    groups.get(platform)!.push(s);
  }

  for (const [platform, items] of groups) {
    console.log(`\n${platform}/`);
    for (const s of items) {
      const cmd = s.name.split("/").slice(1).join("/");
      const src = s.source === "local" ? " (local)" : "";
      const desc = s.description ? ` - ${s.description}` : "";
      console.log(`  ${cmd.padEnd(20)}${desc}${src}`);
    }
  }
  console.log();
}

function siteSearch(query: string, options: SiteOptions): void {
  const sites = getAllSites();
  const q = query.toLowerCase();
  const matches = sites.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.domain.toLowerCase().includes(q)
  );

  if (matches.length === 0) {
    console.log(`未找到匹配 "${query}" 的 adapter。`);
    console.log("  查看所有: bb-browser site list");
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(matches.map(s => ({
      name: s.name, description: s.description, domain: s.domain, source: s.source,
    })), null, 2));
    return;
  }

  for (const s of matches) {
    const src = s.source === "local" ? " (local)" : "";
    console.log(`${s.name.padEnd(24)} ${s.description}${src}`);
  }
}

function siteUpdate(): void {
  mkdirSync(BB_DIR, { recursive: true });

  if (existsSync(join(COMMUNITY_SITES_DIR, ".git"))) {
    console.log("更新社区 site adapter 库...");
    try {
      execSync("git pull --ff-only", { cwd: COMMUNITY_SITES_DIR, stdio: "pipe" });
      console.log("更新完成。");
    } catch (e) {
      console.error(`更新失败: ${e instanceof Error ? e.message : e}`);
      console.error("  手动修复: cd ~/.bb-browser/bb-sites && git pull");
      process.exit(1);
    }
  } else {
    console.log(`克隆社区 adapter 库: ${COMMUNITY_REPO}`);
    try {
      execSync(`git clone ${COMMUNITY_REPO} ${COMMUNITY_SITES_DIR}`, { stdio: "pipe" });
      console.log("克隆完成。");
    } catch (e) {
      console.error(`克隆失败: ${e instanceof Error ? e.message : e}`);
      console.error(`  手动修复: git clone ${COMMUNITY_REPO} ~/.bb-browser/bb-sites`);
      process.exit(1);
    }
  }

  const sites = scanSites(COMMUNITY_SITES_DIR, "community");
  console.log(`已安装 ${sites.length} 个社区 adapter。`);
}

async function siteRun(
  name: string,
  args: string[],
  options: SiteOptions
): Promise<void> {
  const sites = getAllSites();
  const site = sites.find(s => s.name === name);

  if (!site) {
    const fuzzy = sites.filter(s => s.name.includes(name));
    console.error(`[error] site: "${name}" not found.`);
    if (fuzzy.length > 0) {
      console.error("  Did you mean:");
      for (const s of fuzzy.slice(0, 5)) {
        console.error(`    bb-browser site ${s.name}`);
      }
    } else {
      console.error("  Try: bb-browser site list");
      console.error("  Or:  bb-browser site update");
    }
    process.exit(1);
  }

  // 解析参数
  const argNames = Object.keys(site.args);
  const argMap: Record<string, string> = {};

  // 过滤掉 --flag value 对，收集位置参数
  const positionalArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const flagName = args[i].slice(2);
      if (flagName in site.args && args[i + 1]) {
        argMap[flagName] = args[i + 1];
        i++; // 跳过值
      }
    } else {
      positionalArgs.push(args[i]);
    }
  }

  // 位置参数按 argNames 顺序填入（跳过已通过 --flag 提供的）
  let posIdx = 0;
  for (const argName of argNames) {
    if (!argMap[argName] && posIdx < positionalArgs.length) {
      argMap[argName] = positionalArgs[posIdx++];
    }
  }

  // 只检查 required 参数
  for (const [argName, argDef] of Object.entries(site.args)) {
    if (argDef.required && !argMap[argName]) {
      console.error(`[error] site ${name}: missing required argument "${argName}".`);
      const usage = argNames.map(a => {
        const def = site.args[a];
        return def.required ? `<${a}>` : `[${a}]`;
      }).join(" ");
      console.error(`  Usage: bb-browser site ${name} ${usage}`);
      if (site.example) console.error(`  Example: ${site.example}`);
      process.exit(1);
    }
  }

  // 读取并解析 JS
  const jsContent = readFileSync(site.filePath, "utf-8");

  // 移除 /* @meta ... */ 块，保留函数体
  const jsBody = jsContent.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();

  // 构造执行脚本
  // Wrap adapter execution with a fetch() override that drops credentials
  // for cross-origin requests. Browsers block cross-origin fetch with
  // credentials: 'include' unless the server explicitly allows it via
  // Access-Control-Allow-Credentials. Most site adapters set credentials
  // for same-origin cookie auth, but this breaks when they also make
  // cross-origin API calls. The wrapper detects cross-origin requests
  // and downgrades them to credentials: 'omit'.
  const argsJson = JSON.stringify(argMap);
  const script = `(async () => {
    const __origFetch = window.fetch.bind(window);
    const __pageOrigin = location.origin;
    window.fetch = function(input, init) {
      try {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.startsWith('http') && !url.startsWith(__pageOrigin)) {
          init = Object.assign({}, init || {});
          if (init.credentials === 'include') {
            init.credentials = 'omit';
          }
        }
      } catch(e) {}
      return __origFetch(input, init);
    };
    try {
      return await (${jsBody})(${argsJson});
    } finally {
      window.fetch = __origFetch;
    }
  })()`;

  await ensureDaemonRunning();

  // 确定目标 tab
  let targetTabId: number | undefined = options.tabId;

  // 如果用户没指定 --tab，自动查找匹配域名的 tab
  if (!targetTabId && site.domain) {
    const listReq: Request = { id: generateId(), action: "tab_list" };
    const listResp: Response = await sendCommand(listReq);

    if (listResp.success && listResp.data?.tabs) {
      const matchingTab = listResp.data.tabs.find((tab: TabInfo) =>
        matchTabOrigin(tab.url, site.domain)
      );
      if (matchingTab) {
        targetTabId = matchingTab.tabId;
      }
    }

    if (!targetTabId) {
      const newResp = await sendCommand({
        id: generateId(),
        action: "tab_new",
        url: `https://${site.domain}`,
      });
      targetTabId = newResp.data?.tabId;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // 执行
  const evalReq: Request = { id: generateId(), action: "eval", script, tabId: targetTabId };
  const evalResp: Response = await sendCommand(evalReq);

  if (!evalResp.success) {
    const hint = site.domain
      ? `Open https://${site.domain} in your browser, make sure you are logged in, then retry.`
      : undefined;
    if (options.json) {
      console.log(JSON.stringify({ id: evalReq.id, success: false, error: evalResp.error || "eval failed", hint }));
    } else {
      console.error(`[error] site ${name}: ${evalResp.error || "eval failed"}`);
      if (hint) console.error(`  Hint: ${hint}`);
    }
    process.exit(1);
  }

  const result = evalResp.data?.result;
  if (result === undefined || result === null) {
    if (options.json) {
      console.log(JSON.stringify({ id: evalReq.id, success: true, data: null }));
    } else {
      console.log("(no output)");
    }
    return;
  }

  // 解析输出
  let parsed: unknown;
  try {
    parsed = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    parsed = result;
  }

  // 检查 adapter 返回的 error
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const errObj = parsed as { error: string; hint?: string };

    // 检测是否为登录问题（检查 error 和 hint 文本）
    const checkText = `${errObj.error} ${errObj.hint || ""}`;
    const isAuthError = /401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth/i.test(checkText);
    const loginHint = isAuthError && site.domain
      ? `Please log in to https://${site.domain} in your browser first, then retry.`
      : undefined;
    const hint = loginHint || errObj.hint;
    const reportHint = `If this is an adapter bug, report via: gh issue create --repo epiral/bb-sites --title "[${name}] <description>" OR: bb-browser site github/issue-create epiral/bb-sites --title "[${name}] <description>"`;

    if (options.json) {
      console.log(JSON.stringify({ id: evalReq.id, success: false, error: errObj.error, hint, reportHint }));
    } else {
      console.error(`[error] site ${name}: ${errObj.error}`);
      if (hint) console.error(`  Hint: ${hint}`);
      console.error(`  Report: gh issue create --repo epiral/bb-sites --title "[${name}] ..."`);
      console.error(`     or: bb-browser site github/issue-create epiral/bb-sites --title "[${name}] ..."`);
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({ id: evalReq.id, success: true, data: parsed }));
  } else {
    console.log(JSON.stringify(parsed, null, 2));
  }
}

// ── 入口 ────────────────────────────────────────────────────────

export async function siteCommand(
  args: string[],
  options: SiteOptions = {}
): Promise<void> {
  const subCommand = args[0];

  if (!subCommand || subCommand === "--help" || subCommand === "-h") {
    console.log(`bb-browser site - 网站 CLI 化（管理和运行 site adapter）

用法:
  bb-browser site list                      列出所有可用 adapter
  bb-browser site search <query>            搜索 adapter
  bb-browser site <name> [args...]          运行 adapter（简写）
  bb-browser site run <name> [args...]      运行 adapter
  bb-browser site update                    更新社区 adapter 库 (git clone/pull)

目录:
  ${LOCAL_SITES_DIR}      私有 adapter（优先）
  ${COMMUNITY_SITES_DIR}   社区 adapter

示例:
  bb-browser site update
  bb-browser site list
  bb-browser site reddit/thread https://www.reddit.com/r/LocalLLaMA/comments/...
  bb-browser site twitter/user yan5xu
  bb-browser site search reddit

创建新 adapter: bb-browser guide
报告问题: gh issue create --repo epiral/bb-sites --title "[adapter-name] 描述"
贡献社区: https://github.com/epiral/bb-sites`);
    return;
  }

  switch (subCommand) {
    case "list":   siteList(options); break;
    case "search":
      if (!args[1]) {
        console.error("[error] site search: <query> is required.");
        console.error("  Usage: bb-browser site search <query>");
        process.exit(1);
      }
      siteSearch(args[1], options);
      break;
    case "update":  siteUpdate(); break;
    case "run":
      if (!args[1]) {
        console.error("[error] site run: <name> is required.");
        console.error("  Usage: bb-browser site run <name> [args...]");
        console.error("  Try: bb-browser site list");
        process.exit(1);
      }
      await siteRun(args[1], args.slice(2), options);
      break;
    default:
      if (subCommand.includes("/")) {
        await siteRun(subCommand, args.slice(1), options);
      } else {
        console.error(`[error] site: unknown subcommand "${subCommand}".`);
        console.error("  Available: list, search, run, update");
        console.error("  Try: bb-browser site --help");
        process.exit(1);
      }
      break;
  }
}
