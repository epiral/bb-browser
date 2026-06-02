/**
 * Site adapter execution — loads and runs site adapters directly in the daemon.
 *
 * Ported from cli/src/commands/site.ts. The daemon has direct access to
 * CdpConnection and TabStateManager, so no HTTP round-trips are needed
 * for tab_list/tab_new/eval.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import type { CdpConnection } from "./cdp-connection.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BB_DIR = join(homedir(), ".bb-browser");
const LOCAL_SITES_DIR = join(BB_DIR, "sites");
const COMMUNITY_SITES_DIR = join(BB_DIR, "bb-sites");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArgDef {
  required?: boolean;
  description?: string;
}

export interface SiteMeta {
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

export interface SiteRunResult {
  tab?: string;
  result: unknown;
}

// ---------------------------------------------------------------------------
// Scanning & parsing
// ---------------------------------------------------------------------------

/**
 * Parse @meta JSON block from a site adapter JS file.
 * Falls back to legacy // @tag format.
 */
function parseSiteMeta(filePath: string, source: "local" | "community"): SiteMeta | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const sitesDir = source === "local" ? LOCAL_SITES_DIR : COMMUNITY_SITES_DIR;
  const relPath = relative(sitesDir, filePath);
  const defaultName = relPath.replace(/\.js$/, "").replace(/\\/g, "/");

  // Parse /* @meta { ... } */ block
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
      // JSON parse failed, fall through to @tag mode
    }
  }

  // Fallback: parse // @tag format (legacy)
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
 * Walk a directory tree and collect all .js site adapter files.
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
 * Get all site adapters. Local sites override community ones on name collision.
 */
export function getAllSites(): SiteMeta[] {
  const community = scanSites(COMMUNITY_SITES_DIR, "community");
  const local = scanSites(LOCAL_SITES_DIR, "local");

  const byName = new Map<string, SiteMeta>();
  for (const s of community) byName.set(s.name, s);
  for (const s of local) byName.set(s.name, s);

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check if a tab's URL hostname matches the adapter's domain
 * (exact match or subdomain).
 */
function matchTabOrigin(tabUrl: string, domain: string): boolean {
  try {
    const tabOrigin = new URL(tabUrl).hostname;
    return tabOrigin === domain || tabOrigin.endsWith("." + domain);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a site adapter via CDP.
 *
 * - Finds adapter by name
 * - Validates required args
 * - If adapter has a domain: finds matching tab or creates one
 * - Reads JS file, strips @meta, composes IIFE, evaluates via CDP
 */
export async function executeSiteAdapter(
  cdp: CdpConnection,
  name: string,
  args: Record<string, string>,
  tabId?: string | number,
): Promise<SiteRunResult> {
  const sites = getAllSites();
  const site = sites.find(s => s.name === name);

  if (!site) {
    const fuzzy = sites.filter(s => s.name.includes(name));
    const suggestions = fuzzy.slice(0, 5).map(s => s.name);
    throw new Error(
      `Site adapter "${name}" not found` +
      (suggestions.length > 0 ? `. Did you mean: ${suggestions.join(", ")}` : ""),
    );
  }

  // Validate required args
  for (const [argName, argDef] of Object.entries(site.args)) {
    if (argDef.required && !args[argName]) {
      const usage = Object.keys(site.args).map(a => {
        const def = site.args[a];
        return def.required ? `<${a}>` : `[${a}]`;
      }).join(" ");
      throw new Error(
        `Missing required argument "${argName}". Usage: site_run ${name} ${usage}`,
      );
    }
  }

  // Determine target tab
  let targetId: string | undefined;
  let shortId: string | undefined;

  if (tabId !== undefined) {
    // User specified a tab — resolve it
    const target = await cdp.ensurePageTarget(
      typeof tabId === "number" ? String(tabId) : tabId,
      { activate: true },
    );
    targetId = target.id;
    shortId = cdp.tabManager.getTab(target.id)?.shortId;
  } else if (site.domain) {
    // Search existing tabs for a matching domain
    const targets = (await cdp.getTargets()).filter(t => t.type === "page");
    for (const t of targets) {
      if (matchTabOrigin(t.url, site.domain)) {
        await cdp.attachAndEnable(t.id);
        targetId = t.id;
        shortId = cdp.tabManager.getTab(t.id)?.shortId;
        break;
      }
    }

    // No matching tab found — create one
    if (!targetId) {
      const created = await cdp.browserCommand<{ targetId: string }>(
        "Target.createTarget",
        { url: `https://${site.domain}` },
      );
      await cdp.attachAndEnable(created.targetId);
      targetId = created.targetId;
      shortId = cdp.tabManager.getTab(created.targetId)?.shortId;

      // Wait for page to load (simple delay, same as CLI)
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  // If still no target, use the current/first page
  if (!targetId) {
    const target = await cdp.ensurePageTarget();
    targetId = target.id;
    shortId = cdp.tabManager.getTab(target.id)?.shortId;
  }

  // Read adapter JS, strip @meta block, compose IIFE.
  // If a _helper.js exists in the same directory, prepend it so that shared
  // functions (e.g. findTransactionIdGenerator for Twitter) are available.
  const adapterDir = join(site.filePath, "..");
  const helperPath = join(adapterDir, "_helper.js");
  const helperScript = existsSync(helperPath)
    ? readFileSync(helperPath, "utf-8") + "\n"
    : "";
  const jsContent = readFileSync(site.filePath, "utf-8");
  const jsBody = jsContent.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
  const argsJson = JSON.stringify(args);
  const script = `(async function(){${helperScript}\nreturn (${jsBody})(${argsJson});})()`;

  // Evaluate via CDP (awaitPromise = true)
  const result = await cdp.evaluate<unknown>(targetId, script, true);

  return {
    tab: shortId,
    result,
  };
}
