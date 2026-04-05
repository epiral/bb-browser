#!/usr/bin/env bun

/**
 * bb-browserd — Edge Clip provider for Pinix Hub
 *
 * Thin adapter: reads the command registry, registers ALL commands with Hub,
 * and translates Hub invocations to daemon HTTP POST /command calls.
 *
 * No direct CDP code — all browser interaction goes through the daemon.
 */

import { createClient, type CallOptions } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { fileDesc, serviceDesc } from "@bufbuild/protobuf/codegenv2";
import { COMMANDS, type CommandDef } from "../packages/shared/src/commands.ts";
import { COMMAND_TIMEOUT, generateId } from "../packages/shared/src/index.ts";
import type { Request, Response } from "../packages/shared/src/protocol.ts";
import { readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
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

const DEFAULT_PINIX_URL = "http://127.0.0.1:9000";
const DEFAULT_CLIP_NAME = "browser";
const PROVIDER_NAME_PREFIX = "bb-browserd";
const CLIP_PACKAGE = "browser";
const CLIP_DOMAIN = "浏览器";
const RECONNECT_DELAY_MS = 5000;
const REGISTER_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 15000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Daemon connection
// ---------------------------------------------------------------------------

const DAEMON_DIR = process.env.BB_BROWSER_HOME || join(homedir(), ".bb-browser");
const DAEMON_JSON = join(DAEMON_DIR, "daemon.json");

interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
}

let cachedDaemonInfo: DaemonInfo | null = null;
let daemonReady = false;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpJson<T>(
  method: "GET" | "POST",
  urlPath: string,
  info: { host: string; port: number; token: string },
  body?: unknown,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolveP, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: info.host,
        port: info.port,
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${info.token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Daemon HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolveP(JSON.parse(raw) as T);
          } catch {
            reject(new Error(`Invalid JSON from daemon: ${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Daemon request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function readDaemonJson(): Promise<DaemonInfo | null> {
  try {
    const raw = await readFile(DAEMON_JSON, "utf8");
    const info = JSON.parse(raw) as DaemonInfo;
    if (
      typeof info.pid === "number" &&
      typeof info.host === "string" &&
      typeof info.port === "number" &&
      typeof info.token === "string"
    ) {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

async function deleteDaemonJson(): Promise<void> {
  try {
    await unlink(DAEMON_JSON);
  } catch {}
}

function getDaemonPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  // In dev: ../packages/daemon/dist/index.js
  // In release: ../dist/daemon.js
  const releasePath = resolve(currentDir, "../dist/daemon.js");
  if (existsSync(releasePath)) return releasePath;
  return resolve(currentDir, "../packages/daemon/dist/index.js");
}

async function ensureDaemon(): Promise<void> {
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
      await deleteDaemonJson();
      info = null;
    } else {
      try {
        const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
        if (status.running) {
          cachedDaemonInfo = info;
          daemonReady = true;
          return;
        }
      } catch {
        // Daemon process exists but HTTP not responding — fall through to spawn
      }
    }
  }

  // Spawn daemon (it handles Chrome discovery internally)
  const daemonPath = getDaemonPath();
  console.log(`[bb-browserd] Spawning daemon: ${daemonPath}`);
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for daemon to become healthy (up to 15 seconds — includes Chrome launch time)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    info = await readDaemonJson();
    if (!info) continue;
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (status.running) {
        cachedDaemonInfo = info;
        daemonReady = true;
        console.log(`[bb-browserd] Daemon ready at ${info.host}:${info.port}`);
        return;
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error("bb-browserd: Daemon did not start in time");
}

async function daemonCommand(request: Request): Promise<Response> {
  if (!cachedDaemonInfo) {
    cachedDaemonInfo = await readDaemonJson();
  }
  if (!cachedDaemonInfo) {
    throw new Error("No daemon.json found. Is the daemon running?");
  }
  return httpJson<Response>("POST", "/command", cachedDaemonInfo, request, COMMAND_TIMEOUT);
}

// ---------------------------------------------------------------------------
// Zod → JSON Schema (lightweight inline converter)
// ---------------------------------------------------------------------------

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convertZodType(schema);
}

function convertZodType(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  const typeName: string = def?.typeName ?? "";

  // Unwrap wrappers (preserve outer description)
  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    const outerDesc = def.description;
    const inner = convertZodType(def.innerType);
    if (outerDesc && !inner.description) inner.description = outerDesc;
    return inner;
  }
  if (typeName === "ZodDefault") {
    const outerDesc = def.description;
    const inner = convertZodType(def.innerType);
    inner.default = def.defaultValue();
    if (outerDesc && !inner.description) inner.description = outerDesc;
    return inner;
  }
  if (typeName === "ZodEffects") {
    return convertZodType(def.schema);
  }

  // Get description
  const description = def?.description;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;

  if (typeName === "ZodObject") {
    const shape = def.shape?.() ?? {};
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertZodType(value as z.ZodTypeAny);
      if (!isOptional(value as z.ZodTypeAny)) {
        required.push(key);
      }
    }

    return {
      ...base,
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: true,
    };
  }

  if (typeName === "ZodString") {
    return { ...base, type: "string" };
  }

  if (typeName === "ZodNumber") {
    return { ...base, type: "number" };
  }

  if (typeName === "ZodBoolean") {
    return { ...base, type: "boolean" };
  }

  if (typeName === "ZodEnum") {
    return { ...base, type: "string", enum: def.values };
  }

  if (typeName === "ZodLiteral") {
    return { ...base, const: def.value };
  }

  if (typeName === "ZodUnion") {
    const options = (def.options as z.ZodTypeAny[]).map(convertZodType);
    return { ...base, oneOf: options };
  }

  if (typeName === "ZodArray") {
    return { ...base, type: "array", items: convertZodType(def.type) };
  }

  if (typeName === "ZodRecord") {
    return {
      ...base,
      type: "object",
      additionalProperties: convertZodType(def.valueType),
    };
  }

  // Fallback
  return { ...base, type: "object", additionalProperties: true };
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = (schema as any)._def;
  const typeName: string = def?.typeName ?? "";
  if (typeName === "ZodOptional") return true;
  if (typeName === "ZodDefault") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Command registry → Hub registration
// ---------------------------------------------------------------------------

interface CommandInfoRegistration {
  name: string;
  description: string;
  input: string;
  output: string;
}

const COMMAND_INFOS: CommandInfoRegistration[] = COMMANDS.map((cmd) => ({
  name: cmd.name,
  description: cmd.description,
  input: JSON.stringify(zodToJsonSchema(cmd.args)),
  output: JSON.stringify({ type: "object", additionalProperties: true }),
}));

const COMMAND_NAMES = COMMANDS.map((c) => c.name);

// ---------------------------------------------------------------------------
// ProviderStream protocol types
// ---------------------------------------------------------------------------

type InputObject = Record<string, unknown>;

interface Options {
  pinixUrl: string;
  name: string;
}

interface HubErrorPayload {
  code?: string;
  message?: string;
}

interface RegisterResponsePayload {
  accepted?: boolean;
  message?: string;
}

interface InvokeCommandPayload {
  requestId?: string;
  clipName?: string;
  command?: string;
  input?: Uint8Array;
  clipToken?: string;
}

interface InvokeInputPayload {
  requestId?: string;
  data?: Uint8Array;
  done?: boolean;
}

interface ManageCommandPayload {
  requestId?: string;
  action?: {
    case?: string;
    value?: unknown;
  };
}

interface HeartbeatPayload {
  sentAtUnixMs?: bigint;
}

type HubMessagePayload =
  | { case: "registerResponse"; value: RegisterResponsePayload }
  | { case: "invokeCommand"; value: InvokeCommandPayload }
  | { case: "invokeInput"; value: InvokeInputPayload }
  | { case: "manageCommand"; value: ManageCommandPayload }
  | { case: "pong"; value: HeartbeatPayload }
  | { case: undefined; value?: undefined };

interface HubMessage {
  payload: HubMessagePayload;
}

interface RegisterRequestPayload {
  providerName: string;
  acceptsManage: boolean;
  clips: ClipRegistrationPayload[];
}

interface ClipRegistrationPayload {
  name: string;
  package: string;
  version: string;
  domain: string;
  commands: CommandInfoRegistration[];
  hasWeb: boolean;
  dependencies: string[];
  tokenProtected: boolean;
}

interface InvokeResultPayload {
  requestId: string;
  output?: Uint8Array;
  error?: HubErrorPayload;
  done: boolean;
}

interface ManageResultPayload {
  requestId: string;
  error?: HubErrorPayload;
}

type ProviderMessagePayload =
  | { case: "register"; value: RegisterRequestPayload }
  | { case: "invokeResult"; value: InvokeResultPayload }
  | { case: "ping"; value: HeartbeatPayload }
  | { case: "manageResult"; value: ManageResultPayload }
  | { case: undefined; value?: undefined };

interface ProviderMessage {
  payload: ProviderMessagePayload;
}

interface HubClient {
  providerStream(request: AsyncIterable<ProviderMessage>, options?: CallOptions): AsyncIterable<HubMessage>;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

class PinixInvokeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PinixInvokeError";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toHubError(error: unknown): HubErrorPayload {
  if (error instanceof PinixInvokeError) {
    return { code: error.code, message: error.message };
  }
  return { code: "internal", message: formatError(error) };
}

// ---------------------------------------------------------------------------
// AsyncMessageQueue (unchanged from original)
// ---------------------------------------------------------------------------

class AsyncMessageQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failed: Error | null = null;

  push(value: T): void {
    if (this.closed) {
      throw new Error("provider input queue is closed");
    }
    if (this.failed) {
      throw this.failed;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ done: true, value: undefined as never });
    }
  }

  fail(error: unknown): void {
    if (this.failed) {
      return;
    }
    this.failed = error instanceof Error ? error : new Error(String(error));
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(this.failed);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift()!;
      return Promise.resolve({ done: false, value });
    }
    if (this.failed) {
      return Promise.reject(this.failed);
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined as never });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined as never });
  }

  throw(error?: unknown): Promise<IteratorResult<T>> {
    this.fail(error ?? new Error("provider input queue aborted"));
    return Promise.reject(this.failed);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Protobuf descriptor for HubService
// ---------------------------------------------------------------------------

const file_pinix_v2_hub = fileDesc("ChJwaW5peC92Mi9odWIucHJvdG8SCHBpbml4LnYyIikKCEh1YkVycm9yEgwKBGNvZGUYASABKAkSDwoHbWVzc2FnZRgCIAEoCSJPCgtDb21tYW5kSW5mbxIMCgRuYW1lGAEgASgJEhMKC2Rlc2NyaXB0aW9uGAIgASgJEg0KBWlucHV0GAMgASgJEg4KBm91dHB1dBgEIAEoCSLFAQoIQ2xpcEluZm8SDAoEbmFtZRgBIAEoCRIPCgdwYWNrYWdlGAIgASgJEg8KB3ZlcnNpb24YAyABKAkSEAoIcHJvdmlkZXIYBCABKAkSDgoGZG9tYWluGAUgASgJEicKCGNvbW1hbmRzGAYgAygLMhUucGluaXgudjIuQ29tbWFuZEluZm8SDwoHaGFzX3dlYhgHIAEoCBIXCg90b2tlbl9wcm90ZWN0ZWQYCCABKAgSFAoMZGVwZW5kZW5jaWVzGAkgAygJIsUBCgxDbGlwTWFuaWZlc3QSDAoEbmFtZRgBIAEoCRIPCgdwYWNrYWdlGAIgASgJEg8KB3ZlcnNpb24YAyABKAkSDgoGZG9tYWluGAQgASgJEhMKC2Rlc2NyaXB0aW9uGAUgASgJEicKCGNvbW1hbmRzGAYgAygLMhUucGluaXgudjIuQ29tbWFuZEluZm8SFAoMZGVwZW5kZW5jaWVzGAcgAygJEg8KB2hhc193ZWIYCCABKAgSEAoIcGF0dGVybnMYCSADKAkiWQoMUHJvdmlkZXJJbmZvEgwKBG5hbWUYASABKAkSFgoOYWNjZXB0c19tYW5hZ2UYAiABKAgSDQoFY2xpcHMYAyADKAkSFAoMY29ubmVjdGVkX2F0GAQgASgDIqwCCg9Qcm92aWRlck1lc3NhZ2USLQoIcmVnaXN0ZXIYASABKAsyGS5waW5peC52Mi5SZWdpc3RlclJlcXVlc3RIABIpCgpjbGlwX2FkZGVkGAIgASgLMhMucGluaXgudjIuQ2xpcEFkZGVkSAASLQoMY2xpcF9yZW1vdmVkGAMgASgLMhUucGluaXgudjIuQ2xpcFJlbW92ZWRIABIvCg1pbnZva2VfcmVzdWx0GAQgASgLMhYucGluaXgudjIuSW52b2tlUmVzdWx0SAASIwoEcGluZxgFIAEoCzITLnBpbml4LnYyLkhlYXJ0YmVhdEgAEi8KDW1hbmFnZV9yZXN1bHQYBiABKAsyFi5waW5peC52Mi5NYW5hZ2VSZXN1bHRIAEIJCgdwYXlsb2FkIooCCgpIdWJNZXNzYWdlEjcKEXJlZ2lzdGVyX3Jlc3BvbnNlGAEgASgLMhoucGluaXgudjIuUmVnaXN0ZXJSZXNwb25zZUgAEjEKDmludm9rZV9jb21tYW5kGAIgASgLMhcucGluaXgudjIuSW52b2tlQ29tbWFuZEgAEi0KDGludm9rZV9pbnB1dBgDIAEoCzIVLnBpbml4LnYyLkludm9rZUlucHV0SAASMQoObWFuYWdlX2NvbW1hbmQYBCABKAsyFy5waW5peC52Mi5NYW5hZ2VDb21tYW5kSAASIwoEcG9uZxgFIAEoCzITLnBpbml4LnYyLkhlYXJ0YmVhdEgAQgkKB3BheWxvYWQiawoPUmVnaXN0ZXJSZXF1ZXN0EhUKDXByb3ZpZGVyX25hbWUYASABKAkSFgoOYWNjZXB0c19tYW5hZ2UYAiABKAgSKQoFY2xpcHMYAyADKAsyGi5waW5peC52Mi5DbGlwUmVnaXN0cmF0aW9uIrsBChBDbGlwUmVnaXN0cmF0aW9uEgwKBG5hbWUYASABKAkSDwoHcGFja2FnZRgCIAEoCRIPCgd2ZXJzaW9uGAMgASgJEg4KBmRvbWFpbhgEIAEoCRInCghjb21tYW5kcxgFIAMoCzIVLnBpbml4LnYyLkNvbW1hbmRJbmZvEg8KB2hhc193ZWIYBiABKAgSFAoMZGVwZW5kZW5jaWVzGAcgAygJEhcKD3Rva2VuX3Byb3RlY3RlZBgIIAEoCCJJCglDbGlwQWRkZWQSKAoEY2xpcBgBIAEoCzIaLnBpbml4LnYyLkNsaXBSZWdpc3RyYXRpb24SEgoKcmVxdWVzdF9pZBgCIAEoCSIvCgtDbGlwUmVtb3ZlZBIMCgRuYW1lGAEgASgJEhIKCnJlcXVlc3RfaWQYAiABKAkiYwoMSW52b2tlUmVzdWx0EhIKCnJlcXVlc3RfaWQYASABKAkSDgoGb3V0cHV0GAIgASgMEiEKBWVycm9yGAMgASgLMhIucGluaXgudjIuSHViRXJyb3ISDAoEZG9uZRgEIAEoCCJFCgxNYW5hZ2VSZXN1bHQSEgoKcmVxdWVzdF9pZBgBIAEoCRIhCgVlcnJvchgCIAEoCzISLnBpbml4LnYyLkh1YkVycm9yIjUKEFJlZ2lzdGVyUmVzcG9uc2USEAoIYWNjZXB0ZWQYASABKAgSDwoHbWVzc2FnZRgCIAEoCSJqCg1JbnZva2VDb21tYW5kEhIKCnJlcXVlc3RfaWQYASABKAkSEQoJY2xpcF9uYW1lGAIgASgJEg8KB2NvbW1hbmQYAyABKAkSDQoFaW5wdXQYBCABKAwSEgoKY2xpcF90b2tlbhgFIAEoCSI9CgtJbnZva2VJbnB1dBISCgpyZXF1ZXN0X2lkGAEgASgJEgwKBGRhdGEYAiABKAwSDAoEZG9uZRgDIAEoCCKDAQoNTWFuYWdlQ29tbWFuZBISCgpyZXF1ZXN0X2lkGAEgASgJEiYKA2FkZBgCIAEoCzIXLnBpbml4LnYyLkFkZENsaXBBY3Rpb25IABIsCgZyZW1vdmUYAyABKAsyGi5waW5peC52Mi5SZW1vdmVDbGlwQWN0aW9uSABCCAoGYWN0aW9uIkEKDUFkZENsaXBBY3Rpb24SDgoGc291cmNlGAEgASgJEgwKBG5hbWUYAiABKAkSEgoKY2xpcF90b2tlbhgDIAEoCSIlChBSZW1vdmVDbGlwQWN0aW9uEhEKCWNsaXBfbmFtZRgBIAEoCSIkCglIZWFydGJlYXQSFwoPc2VudF9hdF91bml4X21zGAEgASgDIhIKEExpc3RDbGlwc1JlcXVlc3QiNgoRTGlzdENsaXBzUmVzcG9uc2USIQoFY2xpcHMYASADKAsyEi5waW5peC52Mi5DbGlwSW5mbyIWChRMaXN0UHJvdmlkZXJzUmVxdWVzdCJCChVMaXN0UHJvdmlkZXJzUmVzcG9uc2USKQoJcHJvdmlkZXJzGAEgAygLMhYucGluaXgudjIuUHJvdmlkZXJJbmZvIicKEkdldE1hbmlmZXN0UmVxdWVzdBIRCgljbGlwX25hbWUYASABKAkiPwoTR2V0TWFuaWZlc3RSZXNwb25zZRIoCghtYW5pZmVzdBgBIAEoCzIWLnBpbml4LnYyLkNsaXBNYW5pZmVzdCJLChFHZXRDbGlwV2ViUmVxdWVzdBIRCgljbGlwX25hbWUYASABKAkSDAoEcGF0aBgCIAEoCRIVCg1pZl9ub25lX21hdGNoGAMgASgJIl8KEkdldENsaXBXZWJSZXNwb25zZRIPCgdjb250ZW50GAEgASgMEhQKDGNvbnRlbnRfdHlwZRgCIAEoCRIMCgRldGFnGAMgASgJEhQKDG5vdF9tb2RpZmllZBgEIAEoCCJWCg1JbnZva2VSZXF1ZXN0EhEKCWNsaXBfbmFtZRgBIAEoCRIPCgdjb21tYW5kGAIgASgJEg0KBWlucHV0GAMgASgMEhIKCmNsaXBfdG9rZW4YBCABKAkiQwoOSW52b2tlUmVzcG9uc2USDgoGb3V0cHV0GAEgASgMEiEKBWVycm9yGAIgASgLMhIucGluaXgudjIuSHViRXJyb3IicQoTSW52b2tlU3RyZWFtTWVzc2FnZRIoCgVzdGFydBgBIAEoCzIXLnBpbml4LnYyLkludm9rZVJlcXVlc3RIABIlCgVjaHVuaxgCIAEoCzIULnBpbml4LnYyLklucHV0Q2h1bmtIAEIJCgdwYXlsb2FkIigKCklucHV0Q2h1bmsSDAoEZGF0YRgBIAEoDBIMCgRkb25lGAIgASgIIlQKDkFkZENsaXBSZXF1ZXN0Eg4KBnNvdXJjZRgBIAEoCRIMCgRuYW1lGAIgASgJEhAKCHByb3ZpZGVyGAMgASgJEhIKCmNsaXBfdG9rZW4YBCABKAkiMwoPQWRkQ2xpcFJlc3BvbnNlEiAKBGNsaXAYASABKAsyEi5waW5peC52Mi5DbGlwSW5mbyImChFSZW1vdmVDbGlwUmVxdWVzdBIRCgljbGlwX25hbWUYASABKAkiJwoSUmVtb3ZlQ2xpcFJlc3BvbnNlEhEKCWNsaXBfbmFtZRgBIAEoCTKVBQoKSHViU2VydmljZRJFCg5Qcm92aWRlclN0cmVhbRIZLnBpbml4LnYyLlByb3ZpZGVyTWVzc2FnZRoULnBpbml4LnYyLkh1Yk1lc3NhZ2UoATABEkQKCUxpc3RDbGlwcxIaLnBpbml4LnYyLkxpc3RDbGlwc1JlcXVlc3QaGy5waW5peC52Mi5MaXN0Q2xpcHNSZXNwb25zZRJQCg1MaXN0UHJvdmlkZXJzEh4ucGluaXgudjIuTGlzdFByb3ZpZGVyc1JlcXVlc3QaHy5waW5peC52Mi5MaXN0UHJvdmlkZXJzUmVzcG9uc2USSgoLR2V0TWFuaWZlc3QSHC5waW5peC52Mi5HZXRNYW5pZmVzdFJlcXVlc3QaHS5waW5peC52Mi5HZXRNYW5pZmVzdFJlc3BvbnNlEkcKCkdldENsaXBXZWISGy5waW5peC52Mi5HZXRDbGlwV2ViUmVxdWVzdBocLnBpbml4LnYyLkdldENsaXBXZWJSZXNwb25zZRI9CgZJbnZva2USFy5waW5peC52Mi5JbnZva2VSZXF1ZXN0GhgucGluaXgudjIuSW52b2tlUmVzcG9uc2UwARJLCgxJbnZva2VTdHJlYW0SHS5waW5peC52Mi5JbnZva2VTdHJlYW1NZXNzYWdlGhgucGluaXgudjIuSW52b2tlUmVzcG9uc2UoATABEj4KB0FkZENsaXASGC5waW5peC52Mi5BZGRDbGlwUmVxdWVzdBoZLnBpbml4LnYyLkFkZENsaXBSZXNwb25zZRJHCgpSZW1vdmVDbGlwEhsucGluaXgudjIuUmVtb3ZlQ2xpcFJlcXVlc3QaHC5waW5peC52Mi5SZW1vdmVDbGlwUmVzcG9uc2VCMVovZ2l0aHViLmNvbS9lcGlyYWwvcGluaXgvZ2VuL2dvL3Bpbml4L3YyO3Bpbml4djJiBnByb3RvMw");
const HubServiceDescriptor = serviceDesc(file_pinix_v2_hub, 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLIP_VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printUsage(): void {
  console.log(`Usage: bun run bin/bb-browserd.ts [--pinix <url>] [--name <name>]

Options:
  --pinix <url>  Pinix Hub base URL (default: ${DEFAULT_PINIX_URL})
  --name <name>  Clip name to register (default: ${DEFAULT_CLIP_NAME})
  --help         Show this message`);
}

function parseArgs(argv: string[]): Options {
  let pinixUrl = DEFAULT_PINIX_URL;
  let name = DEFAULT_CLIP_NAME;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pinix") {
      pinixUrl = getFlagValue(argv, index, "--pinix");
      index += 1;
    } else if (arg === "--name") {
      name = getFlagValue(argv, index, "--name");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Clip name must not be empty");
  }

  return {
    pinixUrl: normalizePinixBaseUrl(pinixUrl),
    name: normalizedName,
  };
}

function getFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function normalizePinixBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Pinix URL must not be empty");
  }
  const normalized = trimmed
    .replace(/^ws:\/\//i, "http://")
    .replace(/^wss:\/\//i, "https://");
  const url = new URL(normalized);
  if (url.pathname === "/ws/provider" || url.pathname === "/ws/capability") {
    url.pathname = "";
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function getProviderName(clipName: string): string {
  const suffix = clipName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || DEFAULT_CLIP_NAME;
  return `${PROVIDER_NAME_PREFIX}-${suffix}`;
}

function getPinixCallOptions(signal: AbortSignal): CallOptions {
  const token = readHubToken();
  if (!token) {
    return { signal, timeoutMs: 0 };
  }
  return {
    signal,
    timeoutMs: 0,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

function readHubToken(): string | null {
  for (const key of ["PINIX_HUB_TOKEN", "PINIX_TOKEN"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function asInputObject(value: unknown): InputObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as InputObject;
}

function decodeInvokeInput(data: Uint8Array | undefined): InputObject {
  if (!data || data.length === 0) {
    return {};
  }
  const raw = textDecoder.decode(data).trim();
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PinixInvokeError("invalid_argument", "Invoke input must be valid JSON");
  }
  return asInputObject(parsed);
}

function encodeInvokeOutput(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value ?? {}));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeUnref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

// ---------------------------------------------------------------------------
// Command invocation via daemon
// ---------------------------------------------------------------------------

/**
 * Translate Hub command args into a daemon Request and execute via HTTP.
 *
 * Maps the command registry's field names to the daemon protocol:
 *   - `tab` → `tabId` (short tab ID)
 *   - `action` is set from the CommandDef
 *   - All other fields are passed through directly
 */
// ---------------------------------------------------------------------------
// Site commands — routed through CLI (not daemon)
// ---------------------------------------------------------------------------

function runSiteCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use the installed bb-browser CLI binary, not source (which needs tsup define)
    execFile("bb-browser", ["site", ...args], { timeout: 30000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        // Fallback: try node with dist/cli.js
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

const SITE_HANDLERS: Record<string, (input: InputObject) => Promise<unknown>> = {
  site_list: async () => JSON.parse(await runSiteCli(["list", "--json"])),
  site_search: async (input) => JSON.parse(await runSiteCli(["search", String(input.query || ""), "--json"])),
  site_info: async (input) => JSON.parse(await runSiteCli(["info", String(input.name || ""), "--json"])),
  site_recommend: async (input) => JSON.parse(await runSiteCli(["recommend", "--json", ...(input.days ? ["--days", String(input.days)] : [])])),
  site_run: async (input) => {
    const name = String(input.name || "");
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    return JSON.parse(await runSiteCli(["run", name, ...args, "--json"]));
  },
  site_update: async () => JSON.parse(await runSiteCli(["update", "--json"])),
};

// ---------------------------------------------------------------------------
// Command execution — routes to daemon or CLI based on category
// ---------------------------------------------------------------------------

async function executeViaDaemon(cmdName: string, input: InputObject): Promise<unknown> {
  const cmd = COMMANDS.find((c) => c.name === cmdName);
  if (!cmd) {
    throw new PinixInvokeError("not_found", `Unknown command: ${cmdName}`);
  }

  // Site commands go through CLI, not daemon
  const siteHandler = SITE_HANDLERS[cmdName];
  if (siteHandler) {
    return siteHandler(input);
  }

  await ensureDaemon();

  // Build daemon Request from command args
  const { tab, ...rest } = input;
  const request: Request = {
    id: generateId(),
    action: cmd.action as Request["action"],
    ...rest,
    ...(tab !== undefined ? { tabId: tab } : {}),
  } as Request;

  const response = await daemonCommand(request);

  if (!response.success) {
    throw new PinixInvokeError("internal", response.error || "Command failed");
  }

  return response.data ?? {};
}

// ---------------------------------------------------------------------------
// ProviderStream message builders
// ---------------------------------------------------------------------------

function buildRegisterPayload(options: Options): RegisterRequestPayload {
  return {
    providerName: getProviderName(options.name),
    acceptsManage: false,
    clips: [{
      name: options.name,
      package: CLIP_PACKAGE,
      version: CLIP_VERSION,
      domain: CLIP_DOMAIN,
      commands: COMMAND_INFOS,
      hasWeb: false,
      dependencies: [],
      tokenProtected: false,
    }],
  };
}

function createRegisterMessage(options: Options): ProviderMessage {
  return {
    payload: {
      case: "register",
      value: buildRegisterPayload(options),
    },
  };
}

function createHeartbeatMessage(): ProviderMessage {
  return {
    payload: {
      case: "ping",
      value: {
        sentAtUnixMs: BigInt(Date.now()),
      },
    },
  };
}

function createInvokeResultMessage(
  requestId: string,
  output: Uint8Array | undefined,
  error: HubErrorPayload | undefined,
): ProviderMessage {
  return {
    payload: {
      case: "invokeResult",
      value: {
        requestId,
        output,
        error,
        done: true,
      },
    },
  };
}

function createManageUnsupportedMessage(requestId: string): ProviderMessage {
  return {
    payload: {
      case: "manageResult",
      value: {
        requestId,
        error: {
          code: "permission_denied",
          message: "manage operations are not supported by bb-browserd",
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// PinixBridge — ProviderStream connection to Hub
// ---------------------------------------------------------------------------

class PinixBridge {
  private readonly transport;
  private readonly client: HubClient;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private stopped = false;

  constructor(private readonly options: Options) {
    this.resetTransport();
  }

  private resetTransport(): void {
    this.transport = createGrpcTransport({
      baseUrl: this.options.pinixUrl,
      httpVersion: "2",
    });
    this.client = createClient(HubServiceDescriptor as any, this.transport) as HubClient;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.abortController?.abort();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.resetTransport();
    this.runStream()
      .catch((error) => {
        if (this.stopped) {
          return;
        }
        console.error(`[bb-browserd] Provider stream error: ${formatError(error)}`);
        this.scheduleReconnect();
      });
  }

  private async runStream(): Promise<void> {
    console.log(`[bb-browserd] Connecting to ${this.options.pinixUrl}`);

    const abortController = new AbortController();
    this.abortController = abortController;

    const inputQueue = new AsyncMessageQueue<ProviderMessage>();
    const heartbeatTimer = setInterval(() => {
      if (abortController.signal.aborted) {
        return;
      }
      try {
        inputQueue.push(createHeartbeatMessage());
      } catch {
        // Ignore heartbeat queue failures while reconnecting.
      }
    }, HEARTBEAT_INTERVAL_MS);
    maybeUnref(heartbeatTimer);

    let registerAccepted = false;
    let registerTimedOut = false;
    const registerTimer = setTimeout(() => {
      if (registerAccepted || abortController.signal.aborted) {
        return;
      }
      registerTimedOut = true;
      abortController.abort();
    }, REGISTER_TIMEOUT_MS);
    maybeUnref(registerTimer);

    try {
      const responseStream = this.client.providerStream(
        inputQueue,
        getPinixCallOptions(abortController.signal),
      );

      inputQueue.push(createRegisterMessage(this.options));

      for await (const message of responseStream) {
        if (abortController.signal.aborted && this.stopped) {
          return;
        }

        switch (message.payload.case) {
          case "registerResponse": {
            clearTimeout(registerTimer);
            const accepted = message.payload.value.accepted === true;
            const serverMessage = message.payload.value.message?.trim() || "";
            if (!accepted) {
              throw new Error(serverMessage || "provider registration rejected");
            }

            registerAccepted = true;
            this.clearReconnectTimer();
            console.log(`[bb-browserd] Connected to pinixd at ${this.options.pinixUrl}`);
            console.log(
              `[bb-browserd] Registered clip "${this.options.name}" via provider "${getProviderName(this.options.name)}" with ${COMMAND_NAMES.length} commands: ${COMMAND_NAMES.join(", ")}`,
            );
            break;
          }
          case "invokeCommand": {
            void this.handleInvocation(inputQueue, message.payload.value);
            break;
          }
          case "invokeInput": {
            this.handleInvokeInput(message.payload.value);
            break;
          }
          case "manageCommand": {
            const requestId = message.payload.value.requestId?.trim();
            if (requestId) {
              this.send(inputQueue, createManageUnsupportedMessage(requestId));
            }
            break;
          }
          case "pong": {
            break;
          }
          default: {
            break;
          }
        }
      }

      throw new Error("pinix provider stream closed");
    } catch (error) {
      if (this.stopped) {
        return;
      }
      if (registerTimedOut) {
        throw new Error(`provider registration timed out after ${REGISTER_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(registerTimer);
      inputQueue.close();
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  private async handleInvocation(inputQueue: AsyncMessageQueue<ProviderMessage>, message: InvokeCommandPayload): Promise<void> {
    const requestId = message.requestId?.trim();
    if (!requestId) {
      return;
    }

    try {
      const clipName = message.clipName?.trim() || "";
      if (clipName !== this.options.name) {
        throw new PinixInvokeError("not_found", `Unknown clip: ${clipName || "(empty)"}`);
      }

      const command = message.command?.trim() || "";
      if (!COMMAND_NAMES.includes(command)) {
        throw new PinixInvokeError("not_found", `Unknown command: ${command || "(empty)"}`);
      }

      const input = decodeInvokeInput(message.input);
      const output = await executeViaDaemon(command, input);
      this.send(inputQueue, createInvokeResultMessage(requestId, encodeInvokeOutput(output), undefined));
    } catch (error) {
      this.send(inputQueue, createInvokeResultMessage(requestId, undefined, toHubError(error)));
    }
  }

  private handleInvokeInput(message: InvokeInputPayload): void {
    const requestId = message.requestId?.trim();
    const hasData = Boolean(message.data && message.data.length > 0);
    if (requestId && (hasData || message.done === true)) {
      console.warn(`[bb-browserd] Ignoring InvokeInput for unary command: ${requestId}`);
    }
  }

  private send(queue: AsyncMessageQueue<ProviderMessage>, message: ProviderMessage): void {
    try {
      queue.push(message);
    } catch (error) {
      if (!this.stopped) {
        console.error(`[bb-browserd] Failed to send provider message: ${formatError(error)}`);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }
    console.log(`[bb-browserd] Reconnecting in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function installProcessHandlers(bridge: PinixBridge): void {
  process.on("SIGINT", () => {
    bridge.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bridge.stop();
    process.exit(0);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[bb-browserd] Unhandled rejection: ${formatError(reason)}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[bb-browserd] Uncaught exception: ${formatError(error)}`);
  });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  console.log(`[bb-browserd] Starting Edge Clip adapter (${COMMAND_NAMES.length} commands from registry)`);

  const bridge = new PinixBridge(options);
  installProcessHandlers(bridge);
  bridge.start();
}

try {
  main();
} catch (error) {
  console.error(`[bb-browserd] ${formatError(error)}`);
  process.exit(1);
}
