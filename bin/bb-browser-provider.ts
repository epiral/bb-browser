#!/usr/bin/env bun

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
  ProviderMessageSchema,
  RegisterRequestSchema,
  ClipRegistrationSchema,
  InvokeResultSchema,
  HeartbeatSchema,
  HubErrorSchema,
} from "@pinixai/hub-client";
import { COMMANDS, type CommandDef } from "../packages/shared/src/commands.ts";
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
import { execFile } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";
import { spawn } from "node:child_process";
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
const BROWSER_COMMAND_NAMES = BROWSER_COMMANDS.map((c) => c.name);

function buildClipRegistrations() {
  const browserCommands = BROWSER_COMMANDS.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    input: JSON.stringify(zodToJsonSchema(cmd.args)),
    output: JSON.stringify({ type: "object", additionalProperties: true }),
  }));

  const platformClips = buildPlatformClips();

  const browserClip = create(ClipRegistrationSchema, {
    alias: BROWSER_CLIP_ALIAS,
    package: BROWSER_CLIP_PACKAGE,
    version: CLIP_VERSION,
    domain: BROWSER_CLIP_DOMAIN,
    commands: browserCommands,
    hasWeb: false,
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
  const raw = textDecoder.decode(data).trim();
  if (!raw) return {};
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
          if (err2) reject(new Error(stderr2 || stderr || err2.message));
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

      // Send register message
      const { browserClip, siteClips } = buildClipRegistrations();
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
          case "invokeInput": break; // unary commands only
          case "pong": break;
          case "getClipWebCommand": break; // no web assets
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

      if (clipName === BROWSER_CLIP_ALIAS) {
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

  process.on("SIGINT", () => { bridge.stop(); process.exit(0); });
  process.on("SIGTERM", () => { bridge.stop(); process.exit(0); });
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
