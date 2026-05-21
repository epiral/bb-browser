/**
 * bb-browser-provider — Edge Clip provider for Pinix Hub
 *
 * Uses @pinixai/hub-client + @bufbuild/protobuf for typed ProviderStream.
 * Registers a "browser" clip (core commands) plus one clip per site platform.
 */

import { create } from "@bufbuild/protobuf";
import { createClient, type CallOptions } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  HubService,
  type ProviderMessage,
  type HubMessage,
  type InvokeCommand,
  type DataCommand,
  ProviderMessageSchema,
  RegisterRequestSchema,
  ClipRegistrationSchema,
  InvokeResultSchema,
  DataResultSchema,
  DataEntrySchema,
  DataStatSchema,
  HeartbeatSchema,
  HubErrorSchema,
} from "@pinixai/hub-client";
// GetClipWebResultSchema is not re-exported from @pinixai/hub-client index;
// import directly from the gen file via relative path to node_modules.
import { GetClipWebResultSchema, type GetClipWebCommand } from "../node_modules/@pinixai/hub-client/src/gen/hub_pb.ts";
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
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { unlink, readFile as readFileAsync } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname, resolve, relative, extname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
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
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[bb-browser-provider]";
const DEFAULT_HUB_URL = "http://127.0.0.1:9000";
const PROVIDER_NAME = "bb-browser";
const BROWSER_CLIP_ALIAS = "browser";
const BROWSER_CLIP_PACKAGE = "browser";
const BROWSER_CLIP_DOMAIN = "浏览器";
const RECONNECT_DELAY_MS = 5000;
const REGISTER_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 15000;

const VIEWER_PORT = "3334";
const VIEWER_API_BASE = `http://127.0.0.1:${VIEWER_PORT}`;
let viewerProcess: ReturnType<typeof spawn> | null = null;

const LOCAL_SITES_DIR = join(SHARED_DAEMON_DIR, "sites");
const COMMUNITY_SITES_DIR = join(SHARED_DAEMON_DIR, "bb-sites");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

const CLIP_VERSION = readPackageVersion();

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

async function ensureDaemon(): Promise<void> {
  if (daemonReady && cachedDaemonInfo) {
    try { await httpJson<{ running: boolean }>("GET", "/status", cachedDaemonInfo, undefined, 2000); return; }
    catch { daemonReady = false; cachedDaemonInfo = null; }
  }
  let info = await readDaemonJson();
  if (info) {
    if (!isProcessAlive(info.pid)) { try { await unlink(SHARED_DAEMON_JSON); } catch {} info = null; }
    else {
      try {
        const s = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
        if (s.running) { cachedDaemonInfo = info; daemonReady = true; return; }
      } catch {}
    }
  }
  const daemonPath = getDaemonPath();
  console.log(`${LOG_PREFIX} Spawning daemon: ${daemonPath}`);
  const child = spawn(process.execPath, [daemonPath], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    info = await readDaemonJson();
    if (!info) continue;
    try {
      const s = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (s.running) { cachedDaemonInfo = info; daemonReady = true; console.log(`${LOG_PREFIX} Daemon ready at ${info.host}:${info.port}`); return; }
    } catch {}
  }
  throw new Error("Daemon did not start in time");
}

async function daemonCommand(request: Request): Promise<Response> {
  if (!cachedDaemonInfo) cachedDaemonInfo = await readDaemonJson();
  if (!cachedDaemonInfo) throw new Error("No daemon.json found. Is the daemon running?");
  return httpJson<Response>("POST", "/command", cachedDaemonInfo, request, COMMAND_TIMEOUT);
}

// ---------------------------------------------------------------------------
// TURN ephemeral credentials (TURN REST API / RFC 7635 time-limited)
// ---------------------------------------------------------------------------

function generateTurnCredentials(secret: string, ttlSeconds = 86400): { username: string; password: string } {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:bbviewer`;
  const password = createHmac("sha1", secret).update(username).digest("base64");
  return { username, password };
}

// ---------------------------------------------------------------------------
// Viewer sidecar management
// ---------------------------------------------------------------------------

function findViewerBinary(): string | null {
  const localPath = join(SHARED_DAEMON_DIR, "bin", "bb-viewer");
  if (existsSync(localPath)) return localPath;
  // Fall back to PATH
  return "bb-viewer";
}

async function ensureViewer(): Promise<void> {
  if (viewerProcess && !viewerProcess.killed) {
    try {
      const resp = await fetch(`${VIEWER_API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return;
    } catch {}
    // Not healthy — kill and respawn
    try { viewerProcess.kill(); } catch {}
    viewerProcess = null;
  }

  const bin = findViewerBinary();
  if (!bin) throw new Error("bb-viewer binary not found");

  const cdpPort = cachedDaemonInfo?.cdpPort?.toString() || process.env.CDP_PORT || "9222";
  const args = ["--api-only", "--cdp-port", cdpPort, "--port", VIEWER_PORT];

  // Generate ephemeral TURN credentials (valid 24h). Both bb-viewer (Pion
  // relay candidate gathering) and the frontend (WebRTC connection) use
  // the same credentials. If the viewer runs >24h, it will be restarted
  // with fresh credentials on the next view.start.
  const turnUrl = process.env.TURN_URL;
  const turnSecret = process.env.TURN_SECRET;
  if (turnUrl && turnSecret) {
    const { username, password } = generateTurnCredentials(turnSecret);
    args.push("--turn-url", turnUrl, "--turn-user", username, "--turn-cred", password);
  } else if (turnUrl) {
    args.push("--turn-url", turnUrl);
  }

  console.log(`${LOG_PREFIX} Spawning viewer: ${bin} ${args.join(" ")}`);
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  viewerProcess = child;

  child.stdout?.on("data", (d: Buffer) => {
    const lines = d.toString().trim().split("\n");
    for (const line of lines) console.log(`${LOG_PREFIX} [viewer] ${line}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const lines = d.toString().trim().split("\n");
    for (const line of lines) console.error(`${LOG_PREFIX} [viewer] ${line}`);
  });
  child.on("exit", (code) => {
    console.log(`${LOG_PREFIX} [viewer] exited with code ${code}`);
    if (viewerProcess === child) viewerProcess = null;
  });

  // Wait for health check
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const resp = await fetch(`${VIEWER_API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        console.log(`${LOG_PREFIX} Viewer ready at port ${VIEWER_PORT}`);
        return;
      }
    } catch {}
  }
  throw new Error("Viewer did not become healthy in 10s");
}

function stopViewer(): void {
  if (viewerProcess && !viewerProcess.killed) {
    console.log(`${LOG_PREFIX} Stopping viewer`);
    try { viewerProcess.kill(); } catch {}
    viewerProcess = null;
  }
}

async function viewerCommand(path: string, body?: unknown): Promise<unknown> {
  await ensureViewer();
  const url = `${VIEWER_API_BASE}${path}`;
  const opts: RequestInit = {
    method: body ? "POST" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  };
  const resp = await fetch(url, opts);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Viewer ${path} failed (${resp.status}): ${text}`);
  try { return JSON.parse(text); } catch { return { output: text }; }
}

// ---------------------------------------------------------------------------
// Zod -> JSON Schema (lightweight)
// ---------------------------------------------------------------------------

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
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

interface SiteAdapterMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, { required?: boolean; description?: string }>;
}

interface PlatformClip {
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
function buildPlatformClips(): PlatformClip[] {
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
// Build clip registrations
// ---------------------------------------------------------------------------

const BROWSER_COMMANDS = COMMANDS.filter((c) => c.category !== "site");

const VIEW_COMMANDS = [
  {
    name: "view.start",
    description: "Start remote viewing: creates a WebRTC peer and returns offer SDP + ICE candidates",
    inputSchema: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }),
  },
  {
    name: "view.answer",
    description: "Complete WebRTC connection: accepts answer SDP + ICE candidates, starts video streaming",
    inputSchema: JSON.stringify({
      type: "object",
      properties: {
        answer_sdp: { type: "string", description: "Answer SDP from the remote peer" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              candidate: { type: "string" },
              sdpMLineIndex: { type: "number" },
            },
            required: ["candidate", "sdpMLineIndex"],
          },
          description: "ICE candidates from the remote peer",
        },
      },
      required: ["answer_sdp"],
      additionalProperties: true,
    }),
  },
  {
    name: "view.close",
    description: "Stop remote viewing and close the WebRTC peer",
    inputSchema: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }),
  },
];

const BROWSER_COMMAND_NAMES = [
  ...BROWSER_COMMANDS.map((c) => c.name),
  "view.start",
  "view.answer",
  "view.close",
];

function buildClipRegistrations() {
  const browserCommands = [
    ...BROWSER_COMMANDS.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      input: JSON.stringify(zodToJsonSchema(cmd.args)),
      output: JSON.stringify({ type: "object", additionalProperties: true }),
    })),
    ...VIEW_COMMANDS.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      input: cmd.inputSchema,
      output: JSON.stringify({ type: "object", additionalProperties: true }),
    })),
  ];

  const platformClips = buildPlatformClips();

  const browserClip = create(ClipRegistrationSchema, {
    alias: BROWSER_CLIP_ALIAS,
    package: BROWSER_CLIP_PACKAGE,
    version: CLIP_VERSION,
    domain: BROWSER_CLIP_DOMAIN,
    commands: browserCommands,
    hasWeb: true,
    dependencies: [],
    tokenProtected: false,
  });

  const siteClips = platformClips.map((pc) =>
    create(ClipRegistrationSchema, {
      alias: pc.alias,
      package: `browser-site-${pc.alias}`,
      version: CLIP_VERSION,
      domain: pc.domain,
      commands: pc.commands.map((c) => ({
        name: c.name,
        description: c.description,
        input: c.inputSchema,
        output: JSON.stringify({ type: "object", additionalProperties: true }),
      })),
      hasWeb: false,
      dependencies: [BROWSER_CLIP_ALIAS],
      tokenProtected: false,
    }),
  );

  return { browserClip, siteClips, platformClips };
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

type InputObject = Record<string, unknown>;

function decodeInput(data: Uint8Array | undefined): InputObject {
  if (!data || data.length === 0) return {};
  let raw = textDecoder.decode(data).trim();
  if (!raw) return {};
  // Wrap large integers (>=16 digits) as strings before JSON.parse
  // to prevent precision loss for IDs like Twitter/Snowflake IDs
  raw = raw.replace(
    /"(?:[^"\\]|\\.)*"|\d{16,}/g,
    (m) => m.startsWith('"') ? m : `"${m}"`
  );
  try { return JSON.parse(raw) as InputObject; }
  catch { throw new Error("Invoke input must be valid JSON"); }
}

function encodeOutput(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value ?? {}));
}

/** Run a site adapter via CLI */
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

async function executeBrowserCommand(cmdName: string, input: InputObject): Promise<unknown> {
  const cmd = BROWSER_COMMANDS.find((c) => c.name === cmdName);
  if (!cmd) throw new Error(`Unknown browser command: ${cmdName}`);
  await ensureDaemon();
  const { tab, ...rest } = input;
  const request: Request = {
    id: generateId(),
    action: cmd.action as Request["action"],
    ...rest,
    ...(tab !== undefined ? { tabId: tab } : {}),
  } as Request;
  const response = await daemonCommand(request);
  if (!response.success) throw new Error(response.error || "Command failed");
  return response.data ?? {};
}

async function executeSiteCommand(clipName: string, command: string, input: InputObject): Promise<unknown> {
  // Build CLI args from input
  const cliArgs: string[] = ["run", `${clipName}/${command}`, "--json"];
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== "") {
      cliArgs.push(`--${key}`, String(value));
    }
  }
  const raw = await runSiteCli(cliArgs);
  try { return JSON.parse(raw); } catch { return { output: raw }; }
}

// ---------------------------------------------------------------------------
// Clip Data file I/O
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { statSync, readdirSync as readdirSyncNative } from "node:fs";

const PINIX_DATA_ROOT = join(process.env.PINIX_HOME || join(homedir(), ".pinix"), "data");

function clipDataDir(clipName: string): string {
  return join(PINIX_DATA_ROOT, clipName);
}

function validateDataPath(p: string): void {
  if (!p && p !== "") return;
  if (p.startsWith("/") || p.startsWith("\\")) throw new Error("Absolute paths not allowed");
  const cleaned = p.replace(/\\/g, "/").split("/").filter(s => s !== ".");
  if (cleaned.some(s => s === "..")) throw new Error(`Path "${p}" escapes data directory`);
}

function guessMime(name: string): string {
  const ext = extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json",
    ".txt": "text/plain", ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
    ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  };
  return map[ext] || "application/octet-stream";
}

async function handleDataCommand(cmd: DataCommand): Promise<Uint8Array> {
  const clipName = cmd.clipName?.trim() || "";
  const operation = cmd.operation?.trim().toLowerCase() || "";
  const dataPath = cmd.path?.trim() || "";

  if (!clipName) throw new Error("clip_name is required");
  if (!operation) throw new Error("operation is required");
  if (operation !== "list" && !dataPath) throw new Error("path is required");
  validateDataPath(dataPath);

  const dataDir = clipDataDir(clipName);
  const fullPath = dataPath ? join(dataDir, dataPath) : dataDir;

  switch (operation) {
    case "read": {
      const content = await readFileAsync(fullPath);
      return textEncoder.encode(JSON.stringify({ content: Buffer.from(content).toString("base64") }));
    }
    case "write": {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, cmd.content);
      const uri = `pinix://${clipName}/${dataPath}`;
      return textEncoder.encode(JSON.stringify({ uri }));
    }
    case "list": {
      mkdirSync(fullPath, { recursive: true });
      const entries = readdirSyncNative(fullPath, { withFileTypes: true }).map(e => {
        const entryPath = dataPath ? `${dataPath}/${e.name}` : e.name;
        let size = 0;
        try { size = statSync(join(fullPath, e.name)).size; } catch {}
        return {
          name: e.name,
          path: `pinix://${clipName}/${entryPath}`,
          type: e.isDirectory() ? "directory" : "file",
          size,
          mime: e.isDirectory() ? "" : guessMime(e.name),
        };
      });
      return textEncoder.encode(JSON.stringify({ entries }));
    }
    case "delete": {
      const { unlinkSync: unlinkSyncNative } = await import("node:fs");
      unlinkSyncNative(fullPath);
      return textEncoder.encode(JSON.stringify({ uri: `pinix://${clipName}/${dataPath}` }));
    }
    case "stat": {
      const info = statSync(fullPath);
      return textEncoder.encode(JSON.stringify({
        stat: { size: info.size, mime: guessMime(dataPath), modified: info.mtime.toISOString() },
      }));
    }
    default:
      throw new Error(`Unsupported data operation: ${operation}`);
  }
}

// ---------------------------------------------------------------------------
// AsyncMessageQueue
// ---------------------------------------------------------------------------

class AsyncMessageQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private closed = false;
  private failed: Error | null = null;

  push(value: T): void {
    if (this.closed) throw new Error("queue is closed");
    if (this.failed) throw this.failed;
    const w = this.waiters.shift();
    if (w) { w.resolve({ done: false, value }); return; }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.resolve({ done: true, value: undefined as never });
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = error instanceof Error ? error : new Error(String(error));
    while (this.waiters.length) this.waiters.shift()!.reject(this.failed);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed) return Promise.resolve({ done: true, value: undefined as never });
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  return(): Promise<IteratorResult<T>> { this.close(); return Promise.resolve({ done: true, value: undefined as never }); }
  throw(e?: unknown): Promise<IteratorResult<T>> { this.fail(e ?? new Error("aborted")); return Promise.reject(this.failed); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }
}

// ---------------------------------------------------------------------------
// ProviderStream bridge
// ---------------------------------------------------------------------------

interface ProviderClient {
  providerStream(request: AsyncIterable<ProviderMessage>, options?: CallOptions): AsyncIterable<HubMessage>;
}

class HubBridge {
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly hubUrl: string;
  private platformClipAliases: Set<string>;

  constructor(hubUrl: string, private readonly platformClips: PlatformClip[]) {
    this.hubUrl = hubUrl;
    this.platformClipAliases = new Set(platformClips.map((p) => p.alias));
  }

  start(): void { this.connect(); }
  stop(): void { this.stopped = true; this.clearReconnect(); this.abortController?.abort(); }

  private connect(): void {
    if (this.stopped) return;
    this.runStream().catch((err) => {
      if (this.stopped) return;
      console.error(`${LOG_PREFIX} Stream error: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
    });
  }

  private async runStream(): Promise<void> {
    console.log(`${LOG_PREFIX} Connecting to ${this.hubUrl}`);
    const transport = createGrpcTransport({ baseUrl: this.hubUrl, httpVersion: "2" });
    const client = createClient(HubService, transport) as unknown as ProviderClient;

    const ac = new AbortController();
    this.abortController = ac;

    const queue = new AsyncMessageQueue<ProviderMessage>();
    const heartbeat = setInterval(() => {
      if (ac.signal.aborted) return;
      try {
        queue.push(create(ProviderMessageSchema, {
          payload: { case: "ping", value: create(HeartbeatSchema, { sentAtUnixMs: BigInt(Date.now()) }) },
        }));
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);

    let registerAccepted = false;
    const registerTimeout = setTimeout(() => {
      if (registerAccepted || ac.signal.aborted) return;
      ac.abort();
    }, REGISTER_TIMEOUT_MS);

    try {
      const callOpts = this.getCallOptions(ac.signal);
      const stream = client.providerStream(queue, callOpts);

      // Send register message (re-scan adapters on each reconnect)
      const { browserClip, siteClips, platformClips } = buildClipRegistrations();
      this.platformClipAliases = new Set(platformClips.map((p) => p.alias));
      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "register",
          value: create(RegisterRequestSchema, {
            providerName: PROVIDER_NAME,
            clips: [browserClip, ...siteClips],
          }),
        },
      }));

      for await (const msg of stream) {
        if (ac.signal.aborted && this.stopped) return;
        switch (msg.payload.case) {
          case "registerResponse": {
            clearTimeout(registerTimeout);
            if (!msg.payload.value.accepted) {
              throw new Error(msg.payload.value.message || "Registration rejected");
            }
            registerAccepted = true;
            this.clearReconnect();
            const totalCmds = BROWSER_COMMAND_NAMES.length + this.platformClips.reduce((n, p) => n + p.commands.length, 0);
            console.log(`${LOG_PREFIX} Registered ${1 + this.platformClips.length} clips (${totalCmds} commands) at ${this.hubUrl}`);
            break;
          }
          case "invokeCommand": {
            void this.handleInvoke(queue, msg.payload.value);
            break;
          }
          case "dataCommand": {
            void this.handleData(queue, msg.payload.value);
            break;
          }
          case "invokeInput": break; // unary commands only
          case "pong": break;
          case "getClipWebCommand": {
            void this.handleGetClipWeb(queue, msg.payload.value);
            break;
          }
          default: break;
        }
      }
      throw new Error("Provider stream closed");
    } catch (err) {
      if (this.stopped) return;
      throw err;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(registerTimeout);
      queue.close();
      if (this.abortController === ac) this.abortController = null;
    }
  }

  private async handleInvoke(queue: AsyncMessageQueue<ProviderMessage>, inv: InvokeCommand): Promise<void> {
    const requestId = inv.requestId?.trim();
    if (!requestId) return;

    try {
      const clipName = inv.clipName?.trim() || "";
      const command = inv.command?.trim() || "";
      const input = decodeInput(inv.input);
      let result: unknown;

      if (clipName === BROWSER_CLIP_ALIAS && command === "view.start") {
        result = await viewerCommand("/peer/create");
      } else if (clipName === BROWSER_CLIP_ALIAS && command === "view.answer") {
        result = await viewerCommand("/peer/answer", input);
      } else if (clipName === BROWSER_CLIP_ALIAS && command === "view.close") {
        result = await viewerCommand("/peer/close");
      } else if (clipName === BROWSER_CLIP_ALIAS) {
        result = await executeBrowserCommand(command, input);
      } else if (this.platformClipAliases.has(clipName)) {
        result = await executeSiteCommand(clipName, command, input);
      } else {
        throw new Error(`Unknown clip: ${clipName}`);
      }

      this.send(queue, requestId, encodeOutput(result), undefined);
    } catch (err) {
      this.send(queue, requestId, undefined, err);
    }
  }

  private async handleData(queue: AsyncMessageQueue<ProviderMessage>, cmd: DataCommand): Promise<void> {
    const requestId = cmd.requestId?.trim();
    if (!requestId) return;

    try {
      const output = await handleDataCommand(cmd);
      this.sendDataResult(queue, requestId, output, undefined);
    } catch (err) {
      this.sendDataResult(queue, requestId, undefined, err);
    }
  }

  private async handleGetClipWeb(queue: AsyncMessageQueue<ProviderMessage>, cmd: GetClipWebCommand): Promise<void> {
    const requestId = cmd.requestId?.trim();
    if (!requestId) return;

    try {
      let filePath = cmd.path?.trim() || "";
      // Default to view.html
      if (!filePath || filePath === "/" || filePath === "index.html") filePath = "view.html";
      // Strip leading slash
      if (filePath.startsWith("/")) filePath = filePath.slice(1);

      // Security: prevent directory traversal
      if (filePath.includes("..") || filePath.startsWith("/")) {
        throw new Error("Invalid path");
      }

      // Resolve relative to web/ directory alongside the source file
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const webDir = resolve(currentDir, "../web");
      const fullPath = join(webDir, filePath);

      // Ensure the resolved path is within webDir
      const resolvedFull = resolve(fullPath);
      const resolvedWeb = resolve(webDir);
      if (!resolvedFull.startsWith(resolvedWeb)) {
        throw new Error("Invalid path");
      }

      const content = await readFileAsync(fullPath);

      // Content type
      const ext = extname(filePath).toLowerCase();
      const MIME_MAP: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
      };
      const contentType = MIME_MAP[ext] || "application/octet-stream";

      // ETag based on content length (simple)
      const etag = `"${content.length.toString(16)}"`;

      // Handle if-none-match
      if (cmd.ifNoneMatch && cmd.ifNoneMatch === etag) {
        queue.push(create(ProviderMessageSchema, {
          payload: {
            case: "getClipWebResult",
            value: create(GetClipWebResultSchema, {
              requestId,
              notModified: true,
              etag,
              totalSize: BigInt(content.length),
            }),
          },
        }));
        return;
      }

      // Handle range requests (offset/length)
      const offset = Number(cmd.offset || 0n);
      const length = Number(cmd.length || 0n);
      let slice: Uint8Array;
      if (length > 0) {
        slice = new Uint8Array(content.buffer, content.byteOffset + offset, Math.min(length, content.length - offset));
      } else if (offset > 0) {
        slice = new Uint8Array(content.buffer, content.byteOffset + offset);
      } else {
        slice = new Uint8Array(content);
      }

      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "getClipWebResult",
          value: create(GetClipWebResultSchema, {
            requestId,
            content: slice,
            contentType,
            etag,
            totalSize: BigInt(content.length),
          }),
        },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message === "Invalid path" ? "invalid_argument" : "not_found";
      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "getClipWebResult",
          value: create(GetClipWebResultSchema, {
            requestId,
            error: create(HubErrorSchema, { code, message }),
          }),
        },
      }));
    }
  }

  private sendDataResult(queue: AsyncMessageQueue<ProviderMessage>, requestId: string, output: Uint8Array | undefined, error: unknown): void {
    try {
      const hubError = error
        ? create(HubErrorSchema, { code: "internal", message: error instanceof Error ? error.message : String(error) })
        : undefined;
      // Parse the JSON output into DataResult fields
      let parsed: Record<string, unknown> = {};
      if (output) {
        try { parsed = JSON.parse(textDecoder.decode(output)); } catch {}
      }
      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "dataResult",
          value: create(DataResultSchema, {
            requestId,
            content: parsed.content ? new Uint8Array(Buffer.from(parsed.content as string, "base64")) : undefined,
            uri: (parsed.uri as string) || "",
            entries: Array.isArray(parsed.entries)
              ? (parsed.entries as Array<Record<string, unknown>>).map(e => create(DataEntrySchema, {
                  name: (e.name as string) || "",
                  path: (e.path as string) || "",
                  type: (e.type as string) || "file",
                  size: BigInt((e.size as number) || 0),
                  mime: (e.mime as string) || "",
                }))
              : [],
            stat: parsed.stat
              ? create(DataStatSchema, {
                  size: BigInt(((parsed.stat as Record<string, unknown>).size as number) || 0),
                  mime: ((parsed.stat as Record<string, unknown>).mime as string) || "",
                  modified: ((parsed.stat as Record<string, unknown>).modified as string) || "",
                })
              : undefined,
            error: hubError,
          }),
        },
      }));
    } catch (e) {
      if (!this.stopped) console.error(`${LOG_PREFIX} Failed to send data result: ${e instanceof Error ? e.message : e}`);
    }
  }

  private send(queue: AsyncMessageQueue<ProviderMessage>, requestId: string, output: Uint8Array | undefined, error: unknown): void {
    try {
      const hubError = error
        ? create(HubErrorSchema, { code: "internal", message: error instanceof Error ? error.message : String(error) })
        : undefined;
      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "invokeResult",
          value: create(InvokeResultSchema, { requestId, output, error: hubError, done: true }),
        },
      }));
    } catch (e) {
      if (!this.stopped) console.error(`${LOG_PREFIX} Failed to send result: ${e instanceof Error ? e.message : e}`);
    }
  }

  private getCallOptions(signal: AbortSignal): CallOptions {
    const token = process.env.PINIX_HUB_TOKEN?.trim() || process.env.PINIX_TOKEN?.trim();
    const opts: CallOptions = { signal, timeoutMs: 0 };
    if (token) opts.headers = { Authorization: `Bearer ${token}` };
    return opts;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    console.log(`${LOG_PREFIX} Reconnecting in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_DELAY_MS);
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): string {
  let hubUrl = DEFAULT_HUB_URL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hub-url" || arg === "--pinix-url") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      hubUrl = val; i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bb-browser-provider [--hub-url <url>]\n\nOptions:\n  --hub-url <url>  Hub gRPC URL (default: ${DEFAULT_HUB_URL})`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // Normalize URL
  let normalized = hubUrl.trim()
    .replace(/^ws:\/\//i, "http://")
    .replace(/^wss:\/\//i, "https://");
  const url = new URL(normalized);
  if (url.pathname === "/ws/provider" || url.pathname === "/ws/capability") url.pathname = "";
  url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const hubUrl = parseArgs(process.argv.slice(2));
  const platformClips = buildPlatformClips();

  console.log(`${LOG_PREFIX} Starting (${BROWSER_COMMAND_NAMES.length} browser commands, ${platformClips.length} site platforms)`);

  const bridge = new HubBridge(hubUrl, platformClips);

  process.on("SIGINT", () => { stopViewer(); bridge.stop(); process.exit(0); });
  process.on("SIGTERM", () => { stopViewer(); bridge.stop(); process.exit(0); });
  process.on("unhandledRejection", (r) => { console.error(`${LOG_PREFIX} Unhandled rejection: ${r instanceof Error ? r.message : r}`); });
  process.on("uncaughtException", (e) => { console.error(`${LOG_PREFIX} Uncaught exception: ${e instanceof Error ? e.message : e}`); });

  bridge.start();
}

try {
  main();
} catch (error) {
  console.error(`${LOG_PREFIX} ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
