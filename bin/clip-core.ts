/**
 * clip-core — transport-agnostic browser-automation core shared by the
 * Pinix Hub provider (`bb-browser-provider.ts`) and the IPC clip
 * (`bb-browser-clip.ts`).
 *
 * This module owns everything that is independent of the wire transport:
 *   - bb-browser daemon connection + command execution
 *   - site-adapter scanning / namespacing
 *   - the browser command catalog (zod -> JSON Schema)
 *
 * It MUST NOT write to stdout: the IPC clip uses stdout exclusively for the
 * NDJSON protocol, so all diagnostics here go to stderr.
 */

import { COMMANDS } from "../packages/shared/src/commands.ts";
import { COMMAND_TIMEOUT, generateId } from "../packages/shared/src/index.ts";
import type { Request, Response } from "../packages/shared/src/protocol.ts";
import {
  type DaemonInfo,
  DAEMON_DIR as SHARED_DAEMON_DIR,
  DAEMON_JSON as SHARED_DAEMON_JSON,
  readDaemonJson,
  isProcessAlive,
  httpJson,
} from "../packages/shared/src/daemon-client.ts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): void;
  execPath: string;
  kill(pid: number, signal: number): void;
  platform: string;
};

// ---------------------------------------------------------------------------
// Logging — stderr only (stdout is reserved for the IPC NDJSON protocol)
// ---------------------------------------------------------------------------

const CORE_LOG_PREFIX = "[bb-browser-core]";

export function logCore(message: string): void {
  console.error(`${CORE_LOG_PREFIX} ${message}`);
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/**
 * Application-level command failure — the command ran but failed in a way the
 * caller can act on (bad URL, element not found, missing tab, site not logged
 * in, ...). Carries a message that is safe to surface to the caller.
 *
 * Anything that is NOT a CommandFailedError (daemon won't start, HTTP/CDP
 * transport failure, unexpected throw) is an *internal* error: it must
 * propagate as-is so the IPC clip crashes and the host cold-restarts
 * it, rather than leaking internal detail as a safe error message.
 */
export class CommandFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandFailedError";
  }
}

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    return pkg.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLIP_VERSION = readPackageVersion();

// ---------------------------------------------------------------------------
// Daemon connection
// ---------------------------------------------------------------------------

let cachedDaemonInfo: DaemonInfo | null = null;
let daemonReady = false;

function getDaemonPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const releasePath = resolve(currentDir, "../dist/daemon.js");
  if (existsSync(releasePath)) return releasePath;
  return resolve(currentDir, "../packages/daemon/dist/index.js");
}

/**
 * Ensure the bb-browser daemon is running, spawning it if necessary.
 * Throws (internal error) if the daemon cannot be started.
 */
export async function ensureDaemon(): Promise<void> {
  if (daemonReady && cachedDaemonInfo) {
    try {
      await httpJson<{ running: boolean }>("GET", "/status", cachedDaemonInfo, undefined, 2000);
      return;
    } catch {
      daemonReady = false;
      cachedDaemonInfo = null;
    }
  }
  let info = await readDaemonJson();
  if (info) {
    if (!isProcessAlive(info.pid)) {
      try { await unlink(SHARED_DAEMON_JSON); } catch {}
      info = null;
    } else {
      try {
        const s = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
        if (s.running) { cachedDaemonInfo = info; daemonReady = true; return; }
      } catch {}
    }
  }
  const daemonPath = getDaemonPath();
  const daemonArgs = [daemonPath];
  if (process.env.CDP_PORT) {
    daemonArgs.push("--cdp-port", process.env.CDP_PORT);
  }
  logCore(`Spawning daemon: ${daemonPath}${process.env.CDP_PORT ? ` --cdp-port ${process.env.CDP_PORT}` : ""}`);
  const child = spawn(process.execPath, daemonArgs, { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    info = await readDaemonJson();
    if (!info) continue;
    try {
      const s = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (s.running) {
        cachedDaemonInfo = info;
        daemonReady = true;
        logCore(`Daemon ready at ${info.host}:${info.port}`);
        return;
      }
    } catch {}
  }
  throw new Error("Daemon did not start in time");
}

/**
 * Send a command to the daemon HTTP server. Rejects (internal error) on
 * transport failure or non-2xx response (e.g. 503 Chrome-not-connected).
 * A command that ran but failed comes back as HTTP 200 + `{ success: false }`
 * and is the caller's job to classify (see executeBrowserCommand).
 */
export async function daemonCommand(request: Request): Promise<Response> {
  if (!cachedDaemonInfo) cachedDaemonInfo = await readDaemonJson();
  if (!cachedDaemonInfo) throw new Error("No daemon.json found. Is the daemon running?");
  return httpJson<Response>("POST", "/command", cachedDaemonInfo, request, COMMAND_TIMEOUT);
}

// ---------------------------------------------------------------------------
// Zod -> JSON Schema (lightweight)
// ---------------------------------------------------------------------------

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convertZodType(schema);
}

function convertZodType(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  const typeName: string = def?.typeName ?? "";
  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    const inner = convertZodType(def.innerType);
    if (def.description && !inner.description) inner.description = def.description;
    return inner;
  }
  if (typeName === "ZodDefault") {
    const inner = convertZodType(def.innerType);
    inner.default = def.defaultValue();
    if (def.description && !inner.description) inner.description = def.description;
    return inner;
  }
  if (typeName === "ZodEffects") return convertZodType(def.schema);
  const base: Record<string, unknown> = {};
  if (def?.description) base.description = def.description;
  if (typeName === "ZodObject") {
    const shape = def.shape?.() ?? {};
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertZodType(value as z.ZodTypeAny);
      const innerDef = (value as any)._def;
      const innerTypeName: string = innerDef?.typeName ?? "";
      if (innerTypeName !== "ZodOptional" && innerTypeName !== "ZodDefault") required.push(key);
    }
    return { ...base, type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: true };
  }
  if (typeName === "ZodString") return { ...base, type: "string" };
  if (typeName === "ZodNumber") return { ...base, type: "number" };
  if (typeName === "ZodBoolean") return { ...base, type: "boolean" };
  if (typeName === "ZodEnum") return { ...base, type: "string", enum: def.values };
  if (typeName === "ZodLiteral") return { ...base, const: def.value };
  if (typeName === "ZodUnion") return { ...base, oneOf: (def.options as z.ZodTypeAny[]).map(convertZodType) };
  if (typeName === "ZodArray") return { ...base, type: "array", items: convertZodType(def.type) };
  if (typeName === "ZodRecord") return { ...base, type: "object", additionalProperties: convertZodType(def.valueType) };
  return { ...base, type: "object", additionalProperties: true };
}

// ---------------------------------------------------------------------------
// Site adapter scanning
// ---------------------------------------------------------------------------

const LOCAL_SITES_DIR = join(SHARED_DAEMON_DIR, "sites");
const COMMUNITY_SITES_DIR = join(SHARED_DAEMON_DIR, "bb-sites");

interface SiteAdapterMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, { required?: boolean; description?: string }>;
}

export interface PlatformClip {
  alias: string;           // e.g. "xhs"
  domain: string;          // first adapter's domain
  commands: { name: string; description: string; inputSchema: string }[];
}

function parseSiteMeta(filePath: string, sitesDir: string): SiteAdapterMeta | null {
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); } catch { return null; }
  const defaultName = relative(sitesDir, filePath).replace(/\.js$/, "").replace(/\\/g, "/");
  const metaMatch = content.match(/\/\*\s*@meta\s*\n([\s\S]*?)\*\//);
  if (!metaMatch) return { name: defaultName, description: "", domain: "", args: {} };
  try {
    const m = JSON.parse(metaMatch[1]);
    return { name: m.name || defaultName, description: m.description || "", domain: m.domain || "", args: m.args || {} };
  } catch {
    return { name: defaultName, description: "", domain: "", args: {} };
  }
}

function scanSitesDir(dir: string): SiteAdapterMeta[] {
  if (!existsSync(dir)) return [];
  const results: SiteAdapterMeta[] = [];
  function walk(d: string) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith(".")) walk(p);
      else if (e.isFile() && e.name.endsWith(".js")) {
        const m = parseSiteMeta(p, dir);
        if (m) results.push(m);
      }
    }
  }
  walk(dir);
  return results;
}

/** Convert @meta args to JSON Schema */
function metaArgsToJsonSchema(args: Record<string, { required?: boolean; description?: string }>): string {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(args)) {
    properties[name] = { type: "string", ...(def.description ? { description: def.description } : {}) };
    if (def.required) required.push(name);
  }
  return JSON.stringify({
    type: "object", properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  });
}

/** Scan sites and group by platform. Returns one PlatformClip per platform directory. */
export function buildPlatformClips(): PlatformClip[] {
  const community = scanSitesDir(COMMUNITY_SITES_DIR);
  const local = scanSitesDir(LOCAL_SITES_DIR);
  // local overrides community by name
  const byName = new Map<string, SiteAdapterMeta>();
  for (const s of community) byName.set(s.name, s);
  for (const s of local) byName.set(s.name, s);

  // Group by platform (first path segment)
  const groups = new Map<string, SiteAdapterMeta[]>();
  for (const adapter of byName.values()) {
    const slash = adapter.name.indexOf("/");
    if (slash <= 0) continue; // skip adapters without platform prefix
    const platform = adapter.name.substring(0, slash);
    const existing = groups.get(platform) || [];
    existing.push(adapter);
    groups.set(platform, existing);
  }

  const clips: PlatformClip[] = [];
  for (const [platform, adapters] of groups) {
    const firstDomain = adapters.find((a) => a.domain)?.domain || "";
    const commands = adapters.map((a) => {
      const cmdName = a.name.substring(platform.length + 1); // strip "platform/"
      return {
        name: cmdName,
        description: a.description,
        inputSchema: metaArgsToJsonSchema(a.args),
      };
    });
    clips.push({ alias: platform, domain: firstDomain, commands });
  }
  return clips;
}

// ---------------------------------------------------------------------------
// Browser command catalog
// ---------------------------------------------------------------------------

/** All non-site browser commands (open, click, snapshot, tab_list, network, ...). */
export const BROWSER_COMMANDS = COMMANDS.filter((c) => c.category !== "site");

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export type InputObject = Record<string, unknown>;

/**
 * Execute a core browser command against the bb-browser daemon.
 *
 * Error contract:
 *   - unknown command / daemon `success:false` -> CommandFailedError
 *     (application error; safe to surface to the caller).
 *   - ensureDaemon()/daemonCommand() transport failures propagate as their
 *     native Error type (internal error; the caller crashes + cold-restarts).
 */
export async function executeBrowserCommand(cmdName: string, input: InputObject): Promise<unknown> {
  const cmd = BROWSER_COMMANDS.find((c) => c.name === cmdName);
  if (!cmd) throw new CommandFailedError(`Unknown browser command: ${cmdName}`);
  await ensureDaemon();
  const { tab, ...rest } = input;
  const request: Request = {
    id: generateId(),
    action: cmd.action as Request["action"],
    ...rest,
    ...(tab !== undefined ? { tabId: tab } : {}),
  } as Request;
  const response = await daemonCommand(request);
  if (!response.success) throw new CommandFailedError(response.error || "Command failed");
  return response.data ?? {};
}

/** Run a site adapter via the bb-browser CLI. */
function runSiteCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("bb-browser", ["site", ...args], { timeout: 30000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const distPath = new URL("../dist/cli.js", import.meta.url).pathname;
        execFile("node", [distPath, "site", ...args], { timeout: 30000, encoding: "utf8" }, (err2, stdout2, stderr2) => {
          if (err2) reject(new Error(stdout2.trim() || stderr2 || err2.message));
          else resolve(stdout2.trim());
        });
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Execute a site-adapter command (`<platform>/<command>`) via the CLI.
 *
 * Site adapters run as a fresh CLI subprocess, so a failure (not logged in,
 * page changed, adapter error) is treated as an application error and surfaced
 * to the caller rather than crashing the shared browser clip.
 */
export async function executeSiteCommand(clipName: string, command: string, input: InputObject): Promise<unknown> {
  // Build CLI args from input
  const cliArgs: string[] = ["run", `${clipName}/${command}`, "--json"];
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== "") {
      cliArgs.push(`--${key}`, String(value));
    }
  }
  let raw: string;
  try {
    raw = await runSiteCli(cliArgs);
  } catch (err) {
    throw new CommandFailedError(err instanceof Error ? err.message : String(err));
  }
  try { return JSON.parse(raw); } catch { return { output: raw }; }
}
