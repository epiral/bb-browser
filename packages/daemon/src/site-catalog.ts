/**
 * Site adapter catalog — reads @meta blocks from adapter JS files and serves
 * a queryable catalog. Results are cached for CACHE_TTL_MS to avoid
 * repeated disk I/O on every panel refresh or agent query.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiteAdapter {
  name: string;
  description: string;
  domain: string;
  args: Record<string, { required?: boolean; description?: string }>;
  capabilities?: string[];
  readOnly?: boolean;
  example?: string;
  source: "local" | "community";
  filePath: string;
}

// ---------------------------------------------------------------------------
// @meta parser (mirrors packages/cli/src/commands/site.ts logic)
// ---------------------------------------------------------------------------

function parseMeta(filePath: string, source: "local" | "community"): SiteAdapter | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  // Extract /* @meta ... */ block
  const blockMatch = /\/\*\s*@meta\s*([\s\S]*?)\*\//.exec(content);
  if (!blockMatch) return null;

  const inner = blockMatch[1].trim();

  // Try JSON format first
  try {
    const json = JSON.parse(inner) as Partial<SiteAdapter>;
    if (!json.name || !json.domain) return null;
    return {
      name: json.name,
      description: json.description ?? "",
      domain: json.domain,
      args: json.args ?? {},
      capabilities: json.capabilities,
      readOnly: json.readOnly,
      example: json.example,
      source,
      filePath,
    };
  } catch {
    // Fall through to @tag format
  }

  // @tag format: // @name ..., // @domain ..., etc.
  const tag = (key: string) => {
    const m = new RegExp(`//\\s*@${key}[ \\t]+(.*)`, "m").exec(inner);
    return m ? m[1].trim() : undefined;
  };

  const name = tag("name");
  const domain = tag("domain");
  if (!name || !domain) return null;

  return {
    name,
    description: tag("description") ?? "",
    domain,
    args: {},
    readOnly: tag("readOnly") === "true",
    example: tag("example"),
    source,
    filePath,
  };
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

function walkDir(dir: string, source: "local" | "community"): SiteAdapter[] {
  const results: SiteAdapter[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }

    if (st.isDirectory()) {
      results.push(...walkDir(full, source));
    } else if (entry.endsWith(".js")) {
      const meta = parseMeta(full, source);
      if (meta) results.push(meta);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Catalog with TTL cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

interface Cache {
  adapters: SiteAdapter[];
  builtAt: number;
}

let cache: Cache | null = null;

function buildCatalog(bbHome: string): SiteAdapter[] {
  const local = walkDir(path.join(bbHome, "sites"), "local");
  const community = walkDir(path.join(bbHome, "bb-sites"), "community");

  // Local takes precedence: dedupe by name
  const seen = new Set(local.map((a) => a.name));
  const merged = [...local, ...community.filter((a) => !seen.has(a.name))];
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCatalog(bbHome: string): { adapters: SiteAdapter[]; cacheAge: number } {
  const now = Date.now();
  if (!cache || now - cache.builtAt > CACHE_TTL_MS) {
    cache = { adapters: buildCatalog(bbHome), builtAt: now };
  }
  return { adapters: cache.adapters, cacheAge: Math.floor((now - cache.builtAt) / 1000) };
}

/** Force a cache refresh on next call (e.g. after site_update). */
export function invalidateCatalog(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function queryCatalog(
  adapters: SiteAdapter[],
  options: { q?: string; domain?: string },
): SiteAdapter[] {
  let results = adapters;

  if (options.domain) {
    const d = options.domain.toLowerCase().replace(/^www\./, "");
    results = results.filter((a) => a.domain.toLowerCase().replace(/^www\./, "").includes(d));
  }

  if (options.q) {
    const q = options.q.toLowerCase();
    results = results.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.domain.toLowerCase().includes(q),
    );
  }

  return results;
}
