#!/usr/bin/env bun

import { createClient, type CallOptions } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { fileDesc, serviceDesc } from "@bufbuild/protobuf/codegenv2";
import { COMMAND_TIMEOUT } from "../packages/shared/src/constants.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

const DEFAULT_PINIX_URL = "http://127.0.0.1:9000";
const DEFAULT_CLIP_NAME = "browser";
const PROVIDER_NAME_PREFIX = "bb-browserd";
const CLIP_PACKAGE = "browser";
const CLIP_DOMAIN = "浏览器";
const RECONNECT_DELAY_MS = 5000;
const REGISTER_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_CDP_PORT = 19825;
const CDP_PORT_FILE = join(homedir(), ".bb-browser", "browser", "cdp-port");
const WAIT_POLL_INTERVAL = 200;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CAPABILITIES = [
  "navigate",
  "click",
  "type",
  "evaluate",
  "screenshot",
  "getCookies",
  "waitForSelector",
] as const;

type CapabilityCommand = (typeof CAPABILITIES)[number];
type InputObject = Record<string, unknown>;

interface Options {
  pinixUrl: string;
  name: string;
}

interface CommandRegistration {
  name: CapabilityCommand;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
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

interface CommandInfoRegistration {
  name: string;
  description: string;
  input: string;
  output: string;
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

interface RegisterRequestPayload {
  providerName: string;
  acceptsManage: boolean;
  clips: ClipRegistrationPayload[];
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

class PinixInvokeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PinixInvokeError";
  }
}

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

const COMMAND_REGISTRATIONS: Record<CapabilityCommand, CommandRegistration> = {
  navigate: {
    name: "navigate",
    description: "打开页面",
    input: {
      type: "object",
      properties: {
        url: { type: "string", description: "目标 URL" },
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description: "等待策略（当前仅作兼容保留）",
        },
      },
      required: ["url"],
      additionalProperties: true,
    },
    output: {
      type: "object",
      properties: {
        url: { type: "string" },
        title: { type: "string" },
      },
      required: ["url", "title"],
      additionalProperties: false,
    },
  },
  click: {
    name: "click",
    description: "点击元素",
    input: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器" },
      },
      required: ["selector"],
      additionalProperties: true,
    },
    output: {
      type: "object",
      additionalProperties: false,
    },
  },
  type: {
    name: "type",
    description: "向输入框追加文本",
    input: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器" },
        text: { type: "string", description: "要输入的文本" },
        delay: { type: "number", description: "字符延迟（当前忽略）" },
      },
      required: ["selector", "text"],
      additionalProperties: true,
    },
    output: {
      type: "object",
      additionalProperties: false,
    },
  },
  evaluate: {
    name: "evaluate",
    description: "执行页面 JavaScript",
    input: {
      type: "object",
      properties: {
        js: { type: "string", description: "要执行的 JavaScript" },
      },
      required: ["js"],
      additionalProperties: true,
    },
    output: {
      type: "object",
      properties: {
        result: {},
      },
      required: ["result"],
      additionalProperties: false,
    },
  },
  screenshot: {
    name: "screenshot",
    description: "截取当前页面 PNG",
    input: {
      type: "object",
      properties: {
        fullPage: { type: "boolean", description: "整页截图（当前忽略）" },
      },
      additionalProperties: true,
    },
    output: {
      type: "object",
      properties: {
        base64: { type: "string", description: "PNG base64 数据" },
      },
      required: ["base64"],
      additionalProperties: false,
    },
  },
  getCookies: {
    name: "getCookies",
    description: "读取当前页面 Cookie",
    input: {
      type: "object",
      additionalProperties: true,
    },
    output: {
      type: "object",
      properties: {
        cookies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              domain: { type: "string" },
              path: { type: "string" },
            },
            required: ["name", "value", "domain", "path"],
            additionalProperties: false,
          },
        },
      },
      required: ["cookies"],
      additionalProperties: false,
    },
  },
  waitForSelector: {
    name: "waitForSelector",
    description: "等待元素出现",
    input: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器" },
        timeout: { type: "number", description: "超时时间（毫秒）" },
      },
      required: ["selector"],
      additionalProperties: true,
    },
    output: {
      type: "object",
      additionalProperties: false,
    },
  },
};

const file_pinix_v2_hub = fileDesc("ChJwaW5peC92Mi9odWIucHJvdG8SCHBpbml4LnYyIikKCEh1YkVycm9yEgwKBGNvZGUYASABKAkSDwoHbWVzc2FnZRgCIAEoCSJPCgtDb21tYW5kSW5mbxIMCgRuYW1lGAEgASgJEhMKC2Rlc2NyaXB0aW9uGAIgASgJEg0KBWlucHV0GAMgASgJEg4KBm91dHB1dBgEIAEoCSLFAQoIQ2xpcEluZm8SDAoEbmFtZRgBIAEoCRIPCgdwYWNrYWdlGAIgASgJEg8KB3ZlcnNpb24YAyABKAkSEAoIcHJvdmlkZXIYBCABKAkSDgoGZG9tYWluGAUgASgJEicKCGNvbW1hbmRzGAYgAygLMhUucGluaXgudjIuQ29tbWFuZEluZm8SDwoHaGFzX3dlYhgHIAEoCBIXCg90b2tlbl9wcm90ZWN0ZWQYCCABKAgSFAoMZGVwZW5kZW5jaWVzGAkgAygJIsUBCgxDbGlwTWFuaWZlc3QSDAoEbmFtZRgBIAEoCRIPCgdwYWNrYWdlGAIgASgJEg8KB3ZlcnNpb24YAyABKAkSDgoGZG9tYWluGAQgASgJEhMKC2Rlc2NyaXB0aW9uGAUgASgJEicKCGNvbW1hbmRzGAYgAygLMhUucGluaXgudjIuQ29tbWFuZEluZm8SFAoMZGVwZW5kZW5jaWVzGAcgAygJEg8KB2hhc193ZWIYCCABKAgSEAoIcGF0dGVybnMYCSADKAkiWQoMUHJvdmlkZXJJbmZvEgwKBG5hbWUYASABKAkSFgoOYWNjZXB0c19tYW5hZ2UYAiABKAgSDQoFY2xpcHMYAyADKAkSFAoMY29ubmVjdGVkX2F0GAQgASgDIqwCCg9Qcm92aWRlck1lc3NhZ2USLQoIcmVnaXN0ZXIYASABKAsyGS5waW5peC52Mi5SZWdpc3RlclJlcXVlc3RIABIpCgpjbGlwX2FkZGVkGAIgASgLMhMucGluaXgudjIuQ2xpcEFkZGVkSAASLQoMY2xpcF9yZW1vdmVkGAMgASgLMhUucGluaXgudjIuQ2xpcFJlbW92ZWRIABIvCg1pbnZva2VfcmVzdWx0GAQgASgLMhYucGluaXgudjIuSW52b2tlUmVzdWx0SAASIwoEcGluZxgFIAEoCzITLnBpbml4LnYyLkhlYXJ0YmVhdEgAEi8KDW1hbmFnZV9yZXN1bHQYBiABKAsyFi5waW5peC52Mi5NYW5hZ2VSZXN1bHRIAEIJCgdwYXlsb2FkIooCCgpIdWJNZXNzYWdlEjcKEXJlZ2lzdGVyX3Jlc3BvbnNlGAEgASgLMhoucGluaXgudjIuUmVnaXN0ZXJSZXNwb25zZUgAEjEKDmludm9rZV9jb21tYW5kGAIgASgLMhcucGluaXgudjIuSW52b2tlQ29tbWFuZEgAEi0KDGludm9rZV9pbnB1dBgDIAEoCzIVLnBpbml4LnYyLkludm9rZUlucHV0SAASMQoObWFuYWdlX2NvbW1hbmQYBCABKAsyFy5waW5peC52Mi5NYW5hZ2VDb21tYW5kSAASIwoEcG9uZxgFIAEoCzITLnBpbml4LnYyLkhlYXJ0YmVhdEgAQgkKB3BheWxvYWQiawoPUmVnaXN0ZXJSZXF1ZXN0EhUKDXByb3ZpZGVyX25hbWUYASABKAkSFgoOYWNjZXB0c19tYW5hZ2UYAiABKAgSKQoFY2xpcHMYAyADKAsyGi5waW5peC52Mi5DbGlwUmVnaXN0cmF0aW9uIrsBChBDbGlwUmVnaXN0cmF0aW9uEgwKBG5hbWUYASABKAkSDwoHcGFja2FnZRgCIAEoCRIPCgd2ZXJzaW9uGAMgASgJEg4KBmRvbWFpbhgEIAEoCRInCghjb21tYW5kcxgFIAMoCzIVLnBpbml4LnYyLkNvbW1hbmRJbmZvEg8KB2hhc193ZWIYBiABKAgSFAoMZGVwZW5kZW5jaWVzGAcgAygJEhcKD3Rva2VuX3Byb3RlY3RlZBgIIAEoCCJJCglDbGlwQWRkZWQSKAoEY2xpcBgBIAEoCzIaLnBpbml4LnYyLkNsaXBSZWdpc3RyYXRpb24SEgoKcmVxdWVzdF9pZBgCIAEoCSIvCgtDbGlwUmVtb3ZlZBIMCgRuYW1lGAEgASgJEhIKCnJlcXVlc3RfaWQYAiABKAkiYwoMSW52b2tlUmVzdWx0EhIKCnJlcXVlc3RfaWQYASABKAkSDgoGb3V0cHV0GAIgASgMEiEKBWVycm9yGAMgASgLMhIucGluaXgudjIuSHViRXJyb3ISDAoEZG9uZRgEIAEoCCJFCgxNYW5hZ2VSZXN1bHQSEgoKcmVxdWVzdF9pZBgBIAEoCRIhCgVlcnJvchgCIAEoCzISLnBpbml4LnYyLkh1YkVycm9yIjUKEFJlZ2lzdGVyUmVzcG9uc2USEAoIYWNjZXB0ZWQYASABKAgSDwoHbWVzc2FnZRgCIAEoCSJqCg1JbnZva2VDb21tYW5kEhIKCnJlcXVlc3RfaWQYASABKAkSEQoJY2xpcF9uYW1lGAIgASgJEg8KB2NvbW1hbmQYAyABKAkSDQoFaW5wdXQYBCABKAwSEgoKY2xpcF90b2tlbhgFIAEoCSI9CgtJbnZva2VJbnB1dBISCgpyZXF1ZXN0X2lkGAEgASgJEgwKBGRhdGEYAiABKAwSDAoEZG9uZRgDIAEoCCKDAQoNTWFuYWdlQ29tbWFuZBISCgpyZXF1ZXN0X2lkGAEgASgJEiYKA2FkZBgCIAEoCzIXLnBpbml4LnYyLkFkZENsaXBBY3Rpb25IABIsCgZyZW1vdmUYAyABKAsyGi5waW5peC52Mi5SZW1vdmVDbGlwQWN0aW9uSABCCAoGYWN0aW9uIkEKDUFkZENsaXBBY3Rpb24SDgoGc291cmNlGAEgASgJEgwKBG5hbWUYAiABKAkSEgoKY2xpcF90b2tlbhgDIAEoCSIlChBSZW1vdmVDbGlwQWN0aW9uEhEKCWNsaXBfbmFtZRgBIAEoCSIkCglIZWFydGJlYXQSFwoPc2VudF9hdF91bml4X21zGAEgASgDIhIKEExpc3RDbGlwc1JlcXVlc3QiNgoRTGlzdENsaXBzUmVzcG9uc2USIQoFY2xpcHMYASADKAsyEi5waW5peC52Mi5DbGlwSW5mbyIWChRMaXN0UHJvdmlkZXJzUmVxdWVzdCJCChVMaXN0UHJvdmlkZXJzUmVzcG9uc2USKQoJcHJvdmlkZXJzGAEgAygLMhYucGluaXgudjIuUHJvdmlkZXJJbmZvIicKEkdldE1hbmlmZXN0UmVxdWVzdBIRCgljbGlwX25hbWUYASABKAkiPwoTR2V0TWFuaWZlc3RSZXNwb25zZRIoCghtYW5pZmVzdBgBIAEoCzIWLnBpbml4LnYyLkNsaXBNYW5pZmVzdCJLChFHZXRDbGlwV2ViUmVxdWVzdBIRCgljbGlwX25hbWUYASABKAkSDAoEcGF0aBgCIAEoCRIVCg1pZl9ub25lX21hdGNoGAMgASgJIl8KEkdldENsaXBXZWJSZXNwb25zZRIPCgdjb250ZW50GAEgASgMEhQKDGNvbnRlbnRfdHlwZRgCIAEoCRIMCgRldGFnGAMgASgJEhQKDG5vdF9tb2RpZmllZBgEIAEoCCJWCg1JbnZva2VSZXF1ZXN0EhEKCWNsaXBfbmFtZRgBIAEoCRIPCgdjb21tYW5kGAIgASgJEg0KBWlucHV0GAMgASgMEhIKCmNsaXBfdG9rZW4YBCABKAkiQwoOSW52b2tlUmVzcG9uc2USDgoGb3V0cHV0GAEgASgMEiEKBWVycm9yGAIgASgLMhIucGluaXgudjIuSHViRXJyb3IicQoTSW52b2tlU3RyZWFtTWVzc2FnZRIoCgVzdGFydBgBIAEoCzIXLnBpbml4LnYyLkludm9rZVJlcXVlc3RIABIlCgVjaHVuaxgCIAEoCzIULnBpbml4LnYyLklucHV0Q2h1bmtIAEIJCgdwYXlsb2FkIigKCklucHV0Q2h1bmsSDAoEZGF0YRgBIAEoDBIMCgRkb25lGAIgASgIIlQKDkFkZENsaXBSZXF1ZXN0Eg4KBnNvdXJjZRgBIAEoCRIMCgRuYW1lGAIgASgJEhAKCHByb3ZpZGVyGAMgASgJEhIKCmNsaXBfdG9rZW4YBCABKAkiMwoPQWRkQ2xpcFJlc3BvbnNlEiAKBGNsaXAYASABKAsyEi5waW5peC52Mi5DbGlwSW5mbyImChFSZW1vdmVDbGlwUmVxdWVzdBIRCgljbGlwX25hbWUYASABKAkiJwoSUmVtb3ZlQ2xpcFJlc3BvbnNlEhEKCWNsaXBfbmFtZRgBIAEoCTKVBQoKSHViU2VydmljZRJFCg5Qcm92aWRlclN0cmVhbRIZLnBpbml4LnYyLlByb3ZpZGVyTWVzc2FnZRoULnBpbml4LnYyLkh1Yk1lc3NhZ2UoATABEkQKCUxpc3RDbGlwcxIaLnBpbml4LnYyLkxpc3RDbGlwc1JlcXVlc3QaGy5waW5peC52Mi5MaXN0Q2xpcHNSZXNwb25zZRJQCg1MaXN0UHJvdmlkZXJzEh4ucGluaXgudjIuTGlzdFByb3ZpZGVyc1JlcXVlc3QaHy5waW5peC52Mi5MaXN0UHJvdmlkZXJzUmVzcG9uc2USSgoLR2V0TWFuaWZlc3QSHC5waW5peC52Mi5HZXRNYW5pZmVzdFJlcXVlc3QaHS5waW5peC52Mi5HZXRNYW5pZmVzdFJlc3BvbnNlEkcKCkdldENsaXBXZWISGy5waW5peC52Mi5HZXRDbGlwV2ViUmVxdWVzdBocLnBpbml4LnYyLkdldENsaXBXZWJSZXNwb25zZRI9CgZJbnZva2USFy5waW5peC52Mi5JbnZva2VSZXF1ZXN0GhgucGluaXgudjIuSW52b2tlUmVzcG9uc2UwARJLCgxJbnZva2VTdHJlYW0SHS5waW5peC52Mi5JbnZva2VTdHJlYW1NZXNzYWdlGhgucGluaXgudjIuSW52b2tlUmVzcG9uc2UoATABEj4KB0FkZENsaXASGC5waW5peC52Mi5BZGRDbGlwUmVxdWVzdBoZLnBpbml4LnYyLkFkZENsaXBSZXNwb25zZRJHCgpSZW1vdmVDbGlwEhsucGluaXgudjIuUmVtb3ZlQ2xpcFJlcXVlc3QaHC5waW5peC52Mi5SZW1vdmVDbGlwUmVzcG9uc2VCMVovZ2l0aHViLmNvbS9lcGlyYWwvcGluaXgvZ2VuL2dvL3Bpbml4L3YyO3Bpbml4djJiBnByb3RvMw");
const HubServiceDescriptor = serviceDesc(file_pinix_v2_hub, 0);

const COMMAND_INFOS = CAPABILITIES.map((command) => ({
  name: command,
  description: COMMAND_REGISTRATIONS[command].description,
  input: JSON.stringify(COMMAND_REGISTRATIONS[command].input),
  output: JSON.stringify(COMMAND_REGISTRATIONS[command].output),
} satisfies CommandInfoRegistration));

const CLIP_VERSION = readPackageVersion();

// CDP client

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

let cdpSocket: WebSocket | null = null;
let cdpNextId = 1;
let cdpSessionId: string | null = null;
let cdpTargetId: string | null = null;
const cdpPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function discoverCdpPort(): number {
  try {
    const content = readFileSync(CDP_PORT_FILE, "utf-8").trim();
    const port = parseInt(content, 10);
    return isNaN(port) ? DEFAULT_CDP_PORT : port;
  } catch {
    return DEFAULT_CDP_PORT;
  }
}

async function ensureCdp(): Promise<void> {
  if (cdpSocket && cdpSocket.readyState === WebSocket.OPEN && cdpSessionId) {
    return;
  }

  const port = discoverCdpPort();
  const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!versionRes.ok) {
    throw new Error(`Chrome not reachable at port ${port}`);
  }
  const version = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error("Chrome CDP missing webSocketDebuggerUrl");
  }

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      cdpSocket = ws;
      console.log(`[bb-browserd] CDP connected to ${wsUrl}`);
      resolve();
    };
    ws.onerror = () => reject(new Error("CDP WebSocket connection failed"));
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string"
          ? event.data
          : readBinaryText(event.data);
        if (!data) {
          return;
        }
        const msg = JSON.parse(data) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === "number") {
          const pending = cdpPending.get(msg.id);
          if (pending) {
            cdpPending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message || "CDP error"));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore malformed CDP frames.
      }
    };
    ws.onclose = () => {
      cdpSocket = null;
      cdpSessionId = null;
      cdpTargetId = null;
      console.error("[bb-browserd] CDP disconnected");
    };
  });

  const targetsRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await targetsRes.json()) as CdpTarget[];
  const page = targets.find((target) => target.type === "page");
  if (!page) {
    throw new Error("No page target found in Chrome");
  }

  const attachResult = await cdpBrowserCommand<{ sessionId: string }>("Target.attachToTarget", {
    targetId: page.id,
    flatten: true,
  });
  cdpSessionId = attachResult.sessionId;
  cdpTargetId = page.id;
  console.log(`[bb-browserd] Attached to target: ${page.title} (${page.url})`);
}

function cdpBrowserCommand<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("CDP not connected"));
  }
  const id = cdpNextId++;
  return new Promise<T>((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpSocket!.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (cdpPending.has(id)) {
        cdpPending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }
    }, COMMAND_TIMEOUT);
  });
}

function cdpSessionCommand<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN || !cdpSessionId) {
    return Promise.reject(new Error("CDP session not available"));
  }
  const id = cdpNextId++;
  return new Promise<T>((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpSocket!.send(JSON.stringify({ id, method, params, sessionId: cdpSessionId }));
    setTimeout(() => {
      if (cdpPending.has(id)) {
        cdpPending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }
    }, COMMAND_TIMEOUT);
  });
}

// Browser commands

async function cmdNavigate(input: InputObject): Promise<unknown> {
  const url = getRequiredString(input, "url");
  await ensureCdp();
  await cdpSessionCommand("Page.navigate", { url });
  await delay(1000);
  const result = await cdpSessionCommand<{ result: { value: unknown } }>("Runtime.evaluate", {
    expression: "JSON.stringify({url: location.href, title: document.title})",
    returnByValue: true,
  });
  return JSON.parse(String(result.result.value));
}

async function cmdClick(input: InputObject): Promise<unknown> {
  const selector = getRequiredString(input, "selector", "ref");
  await ensureCdp();
  await cdpSessionCommand("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`Element not found: ${selector}`)}); el.click(); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return {};
}

async function cmdType(input: InputObject): Promise<unknown> {
  const selector = getRequiredString(input, "selector", "ref");
  const text = getRequiredStringAllowEmpty(input, "text");
  await ensureCdp();
  await cdpSessionCommand("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`Element not found: ${selector}`)}); el.focus(); el.value += ${JSON.stringify(text)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return {};
}

async function cmdEvaluate(input: InputObject): Promise<unknown> {
  const js = getRequiredString(input, "js", "script");
  await ensureCdp();
  const result = await cdpSessionCommand<{
    result: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression: js,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "Runtime.evaluate failed",
    );
  }
  return { result: result.result.value ?? null };
}

async function cmdScreenshot(_input: InputObject): Promise<unknown> {
  await ensureCdp();
  const result = await cdpSessionCommand<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  return { base64: result.data };
}

async function cmdGetCookies(_input: InputObject): Promise<unknown> {
  await ensureCdp();
  const result = await cdpSessionCommand<{ cookies: Array<{ name: string; value: string; domain: string; path: string }> }>(
    "Network.getCookies",
    {},
  );
  return {
    cookies: result.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
    })),
  };
}

async function cmdWaitForSelector(input: InputObject): Promise<unknown> {
  const selector = getRequiredString(input, "selector", "ref");
  const timeout = typeof input.timeout === "number" ? input.timeout : 10000;
  await ensureCdp();

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await cdpSessionCommand<{ result: { value: unknown } }>("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
      returnByValue: true,
    });
    if (result.result.value === true) {
      return {};
    }
    await delay(WAIT_POLL_INTERVAL);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

const COMMAND_HANDLERS: Record<CapabilityCommand, (input: InputObject) => Promise<unknown>> = {
  navigate: cmdNavigate,
  click: cmdClick,
  type: cmdType,
  evaluate: cmdEvaluate,
  screenshot: cmdScreenshot,
  getCookies: cmdGetCookies,
  waitForSelector: cmdWaitForSelector,
};

async function executeCommand(command: CapabilityCommand, input: InputObject): Promise<unknown> {
  return COMMAND_HANDLERS[command](input);
}

// Helpers

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

function isCapabilityCommand(command: string): command is CapabilityCommand {
  return (CAPABILITIES as readonly string[]).includes(command);
}

function asInputObject(value: unknown): InputObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as InputObject;
}

function getRequiredString(input: InputObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  throw new PinixInvokeError("invalid_argument", `Missing or invalid "${keys[0]}"`);
}

function getRequiredStringAllowEmpty(input: InputObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  throw new PinixInvokeError("invalid_argument", `Missing or invalid "${keys[0]}"`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readBinaryText(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
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

function toHubError(error: unknown): HubErrorPayload {
  if (error instanceof PinixInvokeError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  return {
    code: "internal",
    message: formatError(error),
  };
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeUnref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

// Pinix bridge

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
              `[bb-browserd] Registered clip "${this.options.name}" via provider "${getProviderName(this.options.name)}" with commands: ${CAPABILITIES.join(", ")}`,
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
      if (!isCapabilityCommand(command)) {
        throw new PinixInvokeError("not_found", `Unknown browser command: ${command || "(empty)"}`);
      }

      const input = decodeInvokeInput(message.input);
      const output = await executeCommand(command, input);
      this.send(inputQueue, createInvokeResultMessage(requestId, encodeInvokeOutput(output), undefined));
    } catch (error) {
      this.send(inputQueue, createInvokeResultMessage(requestId, undefined, toHubError(error)));
    }
  }

  private handleInvokeInput(message: InvokeInputPayload): void {
    const requestId = message.requestId?.trim();
    const hasData = Boolean(message.data && message.data.length > 0);
    if (requestId && (hasData || message.done === true)) {
      console.warn(`[bb-browserd] Ignoring InvokeInput for unary browser command: ${requestId}`);
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

// Main

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
