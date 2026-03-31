/**
 * CDP 客户端 - 与 Chrome DevTools Protocol 通信
 *
 * 支持两种连接路径：
 * 1. Daemon 模式：CLI → Daemon (HTTP:19824) → Chrome Extension → 用户真实浏览器
 * 2. CDP 直连模式：CLI → Managed Chrome (CDP WebSocket)
 *
 * 优先使用 Daemon 模式（可操控用户真实浏览器的登录态），
 * 不可用时回退到 CDP 直连。
 */

import { request as httpRequest } from "node:http";
import type { Request, Response } from "@bb-browser/shared";
import { applyJq } from "./jq.js";
import { sendCommand as sendCdpCommand } from "./cdp-client.js";
import { monitorCommand } from "./monitor-manager.js";

const MONITOR_ACTIONS = new Set(["network", "console", "errors", "trace"]);
const DAEMON_URL = "http://127.0.0.1:19824";

let jqExpression: string | undefined;
let daemonAvailable: boolean | null = null;

export function setJqExpression(expression?: string): void {
  jqExpression = expression;
}

function printJqResults(response: Response): never {
  const target = response.data ?? response;
  const results = applyJq(target, jqExpression || ".");
  for (const result of results) {
    console.log(typeof result === "string" ? result : JSON.stringify(result));
  }
  process.exit(0);
}

export function handleJqResponse(response: Response): void {
  if (jqExpression) {
    printJqResults(response);
  }
}

async function isDaemonConnected(): Promise<boolean> {
  if (daemonAvailable !== null) return daemonAvailable;
  try {
    const res = await fetchJson(`${DAEMON_URL}/status`);
    daemonAvailable = res.running === true && res.extensionConnected === true;
  } catch {
    daemonAvailable = false;
  }
  return daemonAvailable;
}

function fetchJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { timeout: 1500 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 60000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

async function sendDaemonCommand(request: Request): Promise<Response> {
  return await postJson(`${DAEMON_URL}/command`, request) as Response;
}

export async function sendCommand(request: Request): Promise<Response> {
  if (MONITOR_ACTIONS.has(request.action)) {
    try {
      return await monitorCommand(request);
    } catch {
      // Fallback to direct CDP if monitor is unavailable
    }
  }

  // Prefer daemon+extension path (uses real browser with login state)
  if (await isDaemonConnected()) {
    return sendDaemonCommand(request);
  }

  return sendCdpCommand(request);
}
