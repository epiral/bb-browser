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
 * Site adapter execution is handled by the daemon. The CLI sends
 * site_list / site_search / site_info / site_run commands to the daemon
 * and formats the output.
 *
 * 目录：
 *   ~/.bb-browser/sites/       私有 adapter（优先）
 *   ~/.bb-browser/bb-sites/    社区 adapter（bb-browser site update 拉取）
 */

import type { Request, Response } from "@bb-browser/shared";
import { handleJqResponse, sendCommand } from "../client.js";
import { getHistoryDomains } from "../history-sqlite.js";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const BB_DIR = join(homedir(), ".bb-browser");
const LOCAL_SITES_DIR = join(BB_DIR, "sites");
const COMMUNITY_SITES_DIR = join(BB_DIR, "bb-sites");
const COMMUNITY_REPO = "https://github.com/epiral/bb-sites.git";

function checkCliUpdate(): void {
  try {
    const current = execSync("bb-browser --version", { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    const latest = execSync("npm view bb-browser version", { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    if (latest && current && latest !== current && latest.localeCompare(current, undefined, { numeric: true }) > 0) {
      console.log(`\n📦 bb-browser ${latest} available (current: ${current}). Run: npm install -g bb-browser`);
    }
  } catch {}
}

export interface SiteOptions {
  json?: boolean;
  tabId?: string | number;
  days?: number;
  jq?: string;
  openclaw?: boolean;
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

interface HistoryDomain {
  domain: string;
  visits: number;
}

interface SiteRecommendation {
  domain: string;
  visits: number;
  adapterCount: number;
  adapters: Array<{
    name: string;
    description: string;
    example: string;
  }>;
}

function exitJsonError(error: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ success: false, error, ...extra }, null, 2));
  process.exit(1);
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
 * 根据 URL 检查是否有对应的 site adapter，返回提示文本
 */
export function getSiteHintForDomain(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    const sites = getAllSites();
    const matched = sites.filter(s => s.domain && (hostname === s.domain || hostname.endsWith("." + s.domain)));
    if (matched.length === 0) return null;
    const names = matched.map(s => s.name);
    const example = matched[0].example || `bb-browser site ${names[0]}`;
    return `该网站有 ${names.length} 个 site adapter 可直接获取数据，无需手动操作浏览器。试试: ${example}`;
  } catch {
    return null;
  }
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

// ── 子命令 ──────────────────────────────────────────────────────

async function siteList(options: SiteOptions): Promise<void> {
  const resp: Response = await sendCommand({
    method: "site_list",
  } as Request);

  if (resp.error) {
    if (options.json) {
      exitJsonError(resp.error.message || "site_list failed");
    }
    console.error(`[error] site list: ${resp.error.message || "failed"}`);
    process.exit(1);
  }

  const sites: Array<{ name: string; description: string; domain: string; source: string }> =
    (resp.result as any)?.sites || [];

  if (sites.length === 0) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log("未找到任何 site adapter。");
    console.log("  安装社区 adapter: bb-browser site update");
    console.log(`  私有 adapter 目录: ${LOCAL_SITES_DIR}`);
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(sites, null, 2));
    return;
  }

  const groups = new Map<string, typeof sites>();
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

async function siteSearch(query: string, options: SiteOptions): Promise<void> {
  const resp: Response = await sendCommand({
    method: "site_search",
    query,
  } as Request);

  if (resp.error) {
    if (options.json) {
      exitJsonError(resp.error.message || "site_search failed");
    }
    console.error(`[error] site search: ${resp.error.message || "failed"}`);
    process.exit(1);
  }

  const matches: Array<{ name: string; description: string; domain: string; source: string }> =
    (resp.result as any)?.sites || [];

  if (matches.length === 0) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log(`未找到匹配 "${query}" 的 adapter。`);
    console.log("  查看所有: bb-browser site list");
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  for (const s of matches) {
    const src = s.source === "local" ? " (local)" : "";
    console.log(`${s.name.padEnd(24)} ${s.description}${src}`);
  }
}

function siteUpdate(options: SiteOptions = {}): void {
  mkdirSync(BB_DIR, { recursive: true });
  const updateMode = existsSync(join(COMMUNITY_SITES_DIR, ".git")) ? "pull" : "clone";

  if (updateMode === "pull") {
    if (!options.json) {
      console.log("更新社区 site adapter 库...");
    }
    try {
      execSync("git pull --ff-only", { cwd: COMMUNITY_SITES_DIR, stdio: "pipe" });
      if (!options.json) {
        console.log("更新完成。");
        console.log("");
        console.log("💡 运行 bb-browser site recommend 看看哪些和你的浏览习惯匹配");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const manualAction = "cd ~/.bb-browser/bb-sites && git pull";
      if (options.json) {
        exitJsonError(`更新失败: ${message}`, { action: manualAction, updateMode });
      }
      console.error(`更新失败: ${e instanceof Error ? e.message : e}`);
      console.error("  手动修复: cd ~/.bb-browser/bb-sites && git pull");
      process.exit(1);
    }
  } else {
    if (!options.json) {
      console.log(`克隆社区 adapter 库: ${COMMUNITY_REPO}`);
    }
    try {
      execSync(`git clone ${COMMUNITY_REPO} ${COMMUNITY_SITES_DIR}`, { stdio: "pipe" });
      if (!options.json) {
        console.log("克隆完成。");
        console.log("");
        console.log("💡 运行 bb-browser site recommend 看看哪些和你的浏览习惯匹配");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const manualAction = `git clone ${COMMUNITY_REPO} ~/.bb-browser/bb-sites`;
      if (options.json) {
        exitJsonError(`克隆失败: ${message}`, { action: manualAction, updateMode });
      }
      console.error(`克隆失败: ${e instanceof Error ? e.message : e}`);
      console.error(`  手动修复: git clone ${COMMUNITY_REPO} ~/.bb-browser/bb-sites`);
      process.exit(1);
    }
  }

  const sites = scanSites(COMMUNITY_SITES_DIR, "community");
  if (options.json) {
    console.log(JSON.stringify({
      success: true,
      updateMode,
      communityRepo: COMMUNITY_REPO,
      communityDir: COMMUNITY_SITES_DIR,
      siteCount: sites.length,
    }, null, 2));
    return;
  }

  console.log(`已安装 ${sites.length} 个社区 adapter。`);
  console.log(`⭐ Like bb-browser? → bb-browser star`);

  // Check for CLI updates
  checkCliUpdate();
}

async function siteInfo(name: string, options: SiteOptions): Promise<void> {
  const resp: Response = await sendCommand({
    method: "site_info",
    siteName: name,
  } as Request);

  if (resp.error) {
    if (options.json) {
      exitJsonError(resp.error.message || `adapter "${name}" not found`, { action: "bb-browser site list" });
    }
    console.error(`[error] site info: ${resp.error.message || `adapter "${name}" not found`}.`);
    console.error("  Try: bb-browser site list");
    process.exit(1);
  }

  const site = resp.result as any;

  if (options.json) {
    console.log(JSON.stringify({
      name: site.name, description: site.description, domain: site.domain,
      args: site.args, example: site.example, readOnly: site.readOnly,
    }, null, 2));
    return;
  }

  console.log(`${site.name} — ${site.description}`);
  console.log();
  console.log("参数：");

  const argEntries = Object.entries(site.args || {});
  if (argEntries.length === 0) {
    console.log("  （无）");
  } else {
    for (const [argName, argDef] of argEntries) {
      const ad = argDef as { required?: boolean; description?: string };
      const requiredText = ad.required ? "必填" : "可选";
      const description = ad.description || "";
      console.log(`  ${argName} (${requiredText})    ${description}`.trimEnd());
    }
  }

  console.log();
  console.log("示例：");
  console.log(`  ${site.example || `bb-browser site ${name}`}`);
  console.log();
  console.log(`域名：${site.domain || "（未声明）"}`);
  console.log(`只读：${site.readOnly ? "是" : "否"}`);
}

async function siteRecommend(options: SiteOptions): Promise<void> {
  const days = options.days ?? 30;
  const historyDomains: HistoryDomain[] = getHistoryDomains(days);
  const sites = getAllSites();
  const sitesByDomain = new Map<string, SiteMeta[]>();

  for (const site of sites) {
    if (!site.domain) continue;
    const domain = site.domain.toLowerCase();
    const existing = sitesByDomain.get(domain) || [];
    existing.push(site);
    sitesByDomain.set(domain, existing);
  }

  const available: SiteRecommendation[] = [];
  const notAvailable: HistoryDomain[] = [];

  for (const item of historyDomains) {
    const adapters = sitesByDomain.get(item.domain.toLowerCase());
    if (adapters && adapters.length > 0) {
      const sortedAdapters = [...adapters].sort((a, b) => a.name.localeCompare(b.name));
      available.push({
        domain: item.domain,
        visits: item.visits,
        adapterCount: sortedAdapters.length,
        adapters: sortedAdapters.map((site) => ({
          name: site.name,
          description: site.description,
          example: site.example || `bb-browser site ${site.name}`,
        })),
      });
    } else if (item.visits >= 5 && item.domain && !item.domain.includes('localhost') && item.domain.includes('.')) {
      notAvailable.push(item);
    }
  }

  const jsonData = {
    days,
    available,
    not_available: notAvailable,
  };

  if (options.jq) {
    handleJqResponse({ result: jsonData as any });
  }

  if (options.json) {
    console.log(JSON.stringify(jsonData, null, 2));
    return;
  }

  console.log(`基于你最近 ${days} 天的浏览记录：`);
  console.log();

  console.log("🎯 你常用这些网站，可以直接用：");
  console.log();
  if (available.length === 0) {
    console.log("  （暂无匹配的 adapter）");
  } else {
    for (const item of available) {
      console.log(`  ${item.domain.padEnd(20)} ${item.visits} 次访问    ${item.adapterCount} 个命令`);
      console.log(`    试试: ${item.adapters[0]?.example || `bb-browser site ${item.adapters[0]?.name || ""}`}`);
      console.log();
    }
  }

  console.log("📋 你常用但还没有 adapter：");
  console.log();
  if (notAvailable.length === 0) {
    console.log("  （暂无）");
  } else {
    for (const item of notAvailable) {
      console.log(`  ${item.domain.padEnd(20)} ${item.visits} 次访问`);
    }
  }

  console.log();
  console.log('💡 跟你的 AI Agent 说 "把 notion.so CLI 化"，它就能自动完成。');
  console.log();
  console.log(`所有分析纯本地完成。用 --days 7 只看最近一周。`);
}

async function siteRun(
  name: string,
  args: string[],
  options: SiteOptions
): Promise<void> {
  // OpenClaw path — alternative execution, kept in CLI
  if (options.openclaw) {
    // Keep this path daemon-free: metadata and adapter source are both local.
    const site = getAllSites().find((candidate) => candidate.name === name);
    if (!site) {
      if (options.json) {
        exitJsonError(`site "${name}" not found`, { action: "bb-browser site list" });
      }
      console.error(`[error] site: "${name}" not found.`);
      console.error("  Try: bb-browser site list");
      process.exit(1);
    }

    // Parse args for openclaw (need arg names from site meta)
    const argNames = Object.keys(site.args || {});
    const argMap: Record<string, string> = {};
    const positionalArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        const flagName = args[i].slice(2);
        if (flagName in (site.args || {}) && args[i + 1]) {
          argMap[flagName] = args[i + 1];
          i++;
        }
      } else {
        positionalArgs.push(args[i]);
      }
    }
    let posIdx = 0;
    for (const argName of argNames) {
      if (!argMap[argName] && posIdx < positionalArgs.length) {
        argMap[argName] = positionalArgs[posIdx++];
      }
    }

    // Fetch JS content from daemon is not feasible, so read locally for openclaw
    // This is a CLI-only fallback path
    const jsContent = readFileSync(site.filePath, "utf-8");
    const jsBody = jsContent.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
    const argsJson = JSON.stringify(argMap);

    const { ocGetTabs, ocFindTabByDomain, ocOpenTab, ocGetTabReference, ocEvaluate } = await import("../openclaw-bridge.js");

    let tabReference: string;

    if (site.domain) {
      const tabs = ocGetTabs();
      const existing = ocFindTabByDomain(tabs, site.domain);
      if (existing) {
        tabReference = ocGetTabReference(existing);
      } else {
        tabReference = ocOpenTab(`https://${site.domain}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } else {
      const tabs = ocGetTabs();
      if (tabs.length === 0) {
        throw new Error("No tabs open in OpenClaw browser");
      }
      tabReference = ocGetTabReference(tabs[0]);
    }

    const wrappedFn = `async () => { const __fn = ${jsBody}; return await __fn(${argsJson}); }`;
    const parsed = ocEvaluate(tabReference, wrappedFn);

    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const errObj = parsed as { error: string; hint?: string };
      const checkText = `${errObj.error} ${errObj.hint || ""}`;
      const isAuthError = /401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth/i.test(checkText);
      const loginHint = isAuthError && site.domain
        ? `Please log in to https://${site.domain} in your OpenClaw browser first, then retry.`
        : undefined;
      const hint = loginHint || errObj.hint;
      const reportHint = `If this is an adapter bug, report via: gh issue create --repo epiral/bb-sites --title "[${name}] <description>" OR: bb-browser site github/issue-create epiral/bb-sites --title "[${name}] <description>"`;

      if (options.json) {
        console.log(JSON.stringify({ error: { message: errObj.error }, hint, reportHint }));
      } else {
        console.error(`[error] site ${name}: ${errObj.error}`);
        if (hint) console.error(`  Hint: ${hint}`);
        console.error(`  Report: gh issue create --repo epiral/bb-sites --title "[${name}] ..."`);
        console.error(`     or: bb-browser site github/issue-create epiral/bb-sites --title "[${name}] ..."`);
      }
      process.exit(1);
    }

    if (options.jq) {
      const { applyJq } = await import("../jq.js");
      const expr = options.jq.replace(/^\.data\./, '.');
      const results = applyJq(parsed, expr);
      for (const r of results) {
        console.log(typeof r === "string" ? r : JSON.stringify(r));
      }
    } else if (options.json) {
      console.log(JSON.stringify({ result: parsed }));
    } else {
      console.log(JSON.stringify(parsed, null, 2));
    }
    return;
  }

  // --- Main path: parse CLI args and send site_run to daemon ---

  // We need arg names to map positional args → named args.
  // Fetch site meta from daemon first.
  const infoResp: Response = await sendCommand({
    method: "site_info",
    siteName: name,
  } as Request);

  // Build argMap from CLI args
  const argMap: Record<string, string> = {};

  if (infoResp.result) {
    const site = infoResp.result as any;
    const argNames = Object.keys(site.args || {});

    const positionalArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        const flagName = args[i].slice(2);
        if (flagName in (site.args || {}) && args[i + 1]) {
          argMap[flagName] = args[i + 1];
          i++;
        }
      } else {
        positionalArgs.push(args[i]);
      }
    }

    let posIdx = 0;
    for (const argName of argNames) {
      if (!argMap[argName] && posIdx < positionalArgs.length) {
        argMap[argName] = positionalArgs[posIdx++];
      }
    }
  } else {
    // Site not found — still try sending to daemon (it will produce a proper error)
    // Parse args as simple --key value pairs
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--") && args[i + 1]) {
        argMap[args[i].slice(2)] = args[i + 1];
        i++;
      }
    }
  }

  // Send site_run to daemon
  const resp: Response = await sendCommand({
    method: "site_run",
    siteName: name,
    siteArgs: argMap,
    ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
  } as Request);

  if (resp.error) {
    if (options.json) {
      console.log(JSON.stringify({ error: { message: resp.error.message || "site_run failed" } }));
    } else {
      console.error(`[error] site ${name}: ${resp.error.message || "site_run failed"}`);
    }
    process.exit(1);
  }

  const result = resp.result?.result;
  if (result === undefined || result === null) {
    if (options.json) {
      console.log(JSON.stringify({ result: null }));
    } else {
      console.log("(no output)");
    }
    return;
  }

  // Parse output
  let parsed: unknown;
  try {
    parsed = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    parsed = result;
  }

  // Check for adapter-returned error
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const errObj = parsed as { error: string; hint?: string };
    const checkText = `${errObj.error} ${errObj.hint || ""}`;
    const isAuthError = /401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth/i.test(checkText);
    // Try to get domain from info resp
    const domain = infoResp.result ? (infoResp.result as any)?.domain : undefined;
    const loginHint = isAuthError && domain
      ? `Please log in to https://${domain} in your browser first, then retry.`
      : undefined;
    const hint = loginHint || errObj.hint;
    const reportHint = `If this is an adapter bug, report via: gh issue create --repo epiral/bb-sites --title "[${name}] <description>" OR: bb-browser site github/issue-create epiral/bb-sites --title "[${name}] <description>"`;

    if (options.json) {
      console.log(JSON.stringify({ error: { message: errObj.error }, hint, reportHint }));
    } else {
      console.error(`[error] site ${name}: ${errObj.error}`);
      if (hint) console.error(`  Hint: ${hint}`);
      console.error(`  Report: gh issue create --repo epiral/bb-sites --title "[${name}] ..."`);
      console.error(`     or: bb-browser site github/issue-create epiral/bb-sites --title "[${name}] ..."`);
    }
    process.exit(1);
  }

  if (options.jq) {
    const { applyJq } = await import("../jq.js");
    const expr = options.jq.replace(/^\.data\./, '.');
    const results = applyJq(parsed, expr);
    for (const r of results) {
      console.log(typeof r === "string" ? r : JSON.stringify(r));
    }
  } else if (options.json) {
    console.log(JSON.stringify({ result: parsed }));
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
  bb-browser site info <name>               查看 adapter 元信息
  bb-browser site recommend                 基于历史记录推荐 adapter
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
    case "list":   await siteList(options); break;
    case "search":
      if (!args[1]) {
        console.error("[error] site search: <query> is required.");
        console.error("  Usage: bb-browser site search <query>");
        process.exit(1);
      }
      await siteSearch(args[1], options);
      break;
    case "info":
      if (!args[1]) {
        console.error("[error] site info: <name> is required.");
        console.error("  Usage: bb-browser site info <name>");
        process.exit(1);
      }
      await siteInfo(args[1], options);
      break;
    case "recommend":
      await siteRecommend(options);
      break;
    case "update":  siteUpdate(options); break;
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
        console.error("  Available: list, info, recommend, search, run, update");
        console.error("  Try: bb-browser site --help");
        process.exit(1);
      }
      break;
  }

  // 静默后台更新社区 adapter
  silentUpdate();
}

function silentUpdate(): void {
  const gitDir = join(COMMUNITY_SITES_DIR, ".git");
  if (!existsSync(gitDir)) return;
  import("node:child_process").then(({ spawn }) => {
    const child = spawn("git", ["pull", "--ff-only"], {
      cwd: COMMUNITY_SITES_DIR,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  }).catch(() => {});
}
