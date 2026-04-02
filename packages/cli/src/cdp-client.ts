import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { Request, Response, ResponseData, TabInfo, SnapshotData, RefInfo, NetworkRequestInfo, ConsoleMessageInfo, JSErrorInfo, TraceEvent, TraceStatus } from "@bb-browser/shared";
import { COMMAND_TIMEOUT } from "@bb-browser/shared";
import { discoverCdpPort } from "./cdp-discovery.js";

interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

type JsonObject = Record<string, unknown>;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: string;
}

interface RawDomTextNode {
  type: "TEXT_NODE";
  text: string;
  isVisible: boolean;
}

interface RawDomElementNode {
  tagName: string;
  xpath: string | null;
  attributes: Record<string, string>;
  children: string[];
  isVisible?: boolean;
  isInteractive?: boolean;
  isTopElement?: boolean;
  isInViewport?: boolean;
  highlightIndex?: number;
  shadowRoot?: boolean;
}

type RawDomTreeNode = RawDomTextNode | RawDomElementNode;

interface BuildDomTreeResult {
  rootId: string;
  map: Record<string, RawDomTreeNode>;
}

interface DialogHandlerConfig {
  accept: boolean;
  promptText?: string;
}

interface ConnectionState {
  host: string;
  port: number;
  browserWsUrl: string;
  browserSocket: WebSocket;
  browserPending: Map<number, PendingCommand>;
  nextMessageId: number;
  sessions: Map<string, string>;
  attachedTargets: Map<string, string>;
  refsByTarget: Map<string, Record<string, RefInfo>>;
  currentTargetId?: string;
  activeFrameIdByTarget: Map<string, string | null>;
  dialogHandlers: Map<string, DialogHandlerConfig>;
}

let connectionState: ConnectionState | null = null;
let reconnecting: Promise<void> | null = null;

const networkRequests = new Map<string, NetworkRequestInfo>();
let networkEnabled = false;

const consoleMessages: ConsoleMessageInfo[] = [];
let consoleEnabled = false;

const jsErrors: JSErrorInfo[] = [];
let errorsEnabled = false;

let traceRecording = false;
const traceEvents: TraceEvent[] = [];

function getContextFilePath(host: string, port: number): string {
  const safeHost = host.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(os.tmpdir(), `bb-browser-cdp-context-${safeHost}-${port}.json`);
}

function loadPersistedCurrentTargetId(host: string, port: number): string | undefined {
  try {
    const data = JSON.parse(readFileSync(getContextFilePath(host, port), "utf-8")) as {
      currentTargetId?: unknown;
    };
    return typeof data.currentTargetId === "string" && data.currentTargetId ? data.currentTargetId : undefined;
  } catch {
    return undefined;
  }
}

function persistCurrentTargetId(host: string, port: number, currentTargetId?: string): void {
  try {
    writeFileSync(getContextFilePath(host, port), JSON.stringify({ currentTargetId }));
  } catch {}
}

function setCurrentTargetId(targetId?: string): void {
  const state = connectionState;
  if (!state) return;
  state.currentTargetId = targetId;
  persistCurrentTargetId(state.host, state.port, targetId);
}

function buildRequestError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requester = url.startsWith("https:") ? httpsRequest : httpRequest;
    const req = requester(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${(res.statusCode ?? 500)}: ${raw}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getJsonList(host: string, port: number): Promise<CdpTargetInfo[]> {
  const data = await fetchJson(`http://${host}:${port}/json/list`);
  return Array.isArray(data) ? (data as CdpTargetInfo[]) : [];
}

async function getJsonVersion(host: string, port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const data = await fetchJson(`http://${host}:${port}/json/version`) as JsonObject;
  const url = data.webSocketDebuggerUrl;
  if (typeof url !== "string" || !url) {
    throw new Error("CDP endpoint missing webSocketDebuggerUrl");
  }
  return { webSocketDebuggerUrl: url };
}

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => {
      // Allow Node.js to exit even if the WebSocket is still open
      const socket = (ws as any)._socket;
      if (socket && typeof socket.unref === "function") {
        socket.unref();
      }
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

function createState(host: string, port: number, browserWsUrl: string, browserSocket: WebSocket): ConnectionState {
  const state: ConnectionState = {
    host,
    port,
    browserWsUrl,
    browserSocket,
    browserPending: new Map(),
    nextMessageId: 1,
    sessions: new Map(),
    attachedTargets: new Map(),
    refsByTarget: new Map(),
    currentTargetId: loadPersistedCurrentTargetId(host, port),
    activeFrameIdByTarget: new Map(),
    dialogHandlers: new Map(),
  };

  browserSocket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as JsonObject;
    if (typeof message.id === "number") {
      const pending = state.browserPending.get(message.id);
      if (!pending) return;
      state.browserPending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${(message.error as JsonObject).message ?? "Unknown CDP error"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "Target.attachedToTarget") {
      const params = message.params as JsonObject;
      const sessionId = params.sessionId;
      const targetInfo = params.targetInfo as JsonObject;
      if (typeof sessionId === "string" && typeof targetInfo?.targetId === "string") {
        state.sessions.set(targetInfo.targetId, sessionId);
        state.attachedTargets.set(sessionId, targetInfo.targetId);
      }
      return;
    }

    if (message.method === "Target.detachedFromTarget") {
      const params = message.params as JsonObject;
      const sessionId = params.sessionId;
      if (typeof sessionId === "string") {
        const targetId = state.attachedTargets.get(sessionId);
        if (targetId) {
          state.sessions.delete(targetId);
          state.attachedTargets.delete(sessionId);
          state.activeFrameIdByTarget.delete(targetId);
          state.dialogHandlers.delete(targetId);
          if (state.currentTargetId === targetId) {
            state.currentTargetId = undefined;
            persistCurrentTargetId(state.host, state.port, undefined);
          }
        }
      }
      return;
    }

    if (message.method === "Target.receivedMessageFromTarget") {
      // Legacy non-flat protocol
      const params = message.params as JsonObject;
      const sessionId = params.sessionId;
      const messageText = params.message;
      if (typeof sessionId === "string" && typeof messageText === "string") {
        const targetId = state.attachedTargets.get(sessionId);
        if (targetId) {
          handleSessionEvent(targetId, JSON.parse(messageText) as JsonObject).catch(() => {});
        }
      }
      return;
    }

    // Flat protocol: session events come with sessionId directly on the message
    if (typeof message.sessionId === "string" && typeof message.method === "string") {
      const targetId = state.attachedTargets.get(message.sessionId as string);
      if (targetId) {
        handleSessionEvent(targetId, message).catch(() => {});
      }
    }
  });

  browserSocket.on("close", () => {
    if (connectionState === state) {
      connectionState = null;
    }
    for (const pending of state.browserPending.values()) {
      pending.reject(new Error("CDP connection closed"));
    }
    state.browserPending.clear();
  });

  browserSocket.on("error", () => {});

  return state;
}

async function browserCommand<T>(method: string, params: JsonObject = {}): Promise<T> {
  const state = connectionState;
  if (!state) throw new Error("CDP connection not initialized");
  const id = state.nextMessageId++;
  const payload = JSON.stringify({ id, method, params });
  const promise = new Promise<T>((resolve, reject) => {
    state.browserPending.set(id, { resolve, reject, method });
  });
  state.browserSocket.send(payload);
  return promise;
}

async function sessionCommand<T>(targetId: string, method: string, params: JsonObject = {}): Promise<T> {
  const state = connectionState;
  if (!state) throw new Error("CDP connection not initialized");
  const sessionId = state.sessions.get(targetId) ?? await attachTarget(targetId);
  const id = state.nextMessageId++;
  // Flat protocol: send with sessionId directly on the message
  const payload = JSON.stringify({ id, method, params, sessionId });
  return new Promise<T>((resolve, reject) => {
    const check = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as JsonObject;
      // Flat protocol responses come back with the same sessionId
      if (msg.id === id && msg.sessionId === sessionId) {
        state.browserSocket.off("message", check);
        if (msg.error) reject(new Error(`${method}: ${(msg.error as JsonObject).message ?? "Unknown CDP error"}`));
        else resolve(msg.result as T);
      }
    };
    state.browserSocket.on("message", check);
    state.browserSocket.send(payload);
  });
}


function getActiveFrameId(targetId: string): string | undefined {
  const frameId = connectionState?.activeFrameIdByTarget.get(targetId);
  return frameId ?? undefined;
}

async function pageCommand<T>(targetId: string, method: string, params: JsonObject = {}): Promise<T> {
  const frameId = getActiveFrameId(targetId);
  return sessionCommand<T>(targetId, method, frameId ? { ...params, frameId } : params);
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  return Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
}

async function handleSessionEvent(targetId: string, event: JsonObject): Promise<void> {
  const method = event.method;
  const params = (event.params ?? {}) as JsonObject;
  if (typeof method !== "string") return;

  if (method === "Page.javascriptDialogOpening") {
    const handler = connectionState?.dialogHandlers.get(targetId);
    if (handler) {
      await sessionCommand(targetId, "Page.handleJavaScriptDialog", {
        accept: handler.accept,
        ...(handler.promptText !== undefined ? { promptText: handler.promptText } : {}),
      });
    }
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
    const request = params.request as JsonObject | undefined;
    if (!requestId || !request) return;
    networkRequests.set(requestId, {
      requestId,
      url: String(request.url ?? ""),
      method: String(request.method ?? "GET"),
      type: String(params.type ?? "Other"),
      timestamp: Math.round(Number(params.timestamp ?? Date.now()) * 1000),
      requestHeaders: normalizeHeaders(request.headers),
      requestBody: typeof request.postData === "string" ? request.postData : undefined,
    });
    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
    const response = params.response as JsonObject | undefined;
    if (!requestId || !response) return;
    const existing = networkRequests.get(requestId);
    if (!existing) return;
    existing.status = typeof response.status === "number" ? response.status : undefined;
    existing.statusText = typeof response.statusText === "string" ? response.statusText : undefined;
    existing.responseHeaders = normalizeHeaders(response.headers);
    existing.mimeType = typeof response.mimeType === "string" ? response.mimeType : undefined;
    networkRequests.set(requestId, existing);
    return;
  }

  if (method === "Network.loadingFailed") {
    const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
    if (!requestId) return;
    const existing = networkRequests.get(requestId);
    if (!existing) return;
    existing.failed = true;
    existing.failureReason = typeof params.errorText === "string" ? params.errorText : "Unknown error";
    networkRequests.set(requestId, existing);
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    const type = String(params.type ?? "log");
    const args = Array.isArray(params.args) ? params.args as JsonObject[] : [];
    const text = args.map((arg) => {
      if (typeof arg.value === "string") return arg.value;
      if (arg.value !== undefined) return String(arg.value);
      if (typeof arg.description === "string") return arg.description;
      return "";
    }).filter(Boolean).join(" ");
    const stack = params.stackTrace as JsonObject | undefined;
    const firstCallFrame = Array.isArray(stack?.callFrames) ? stack?.callFrames[0] as JsonObject | undefined : undefined;
    consoleMessages.push({
      type: ["log", "info", "warn", "error", "debug"].includes(type) ? type as ConsoleMessageInfo["type"] : "log",
      text,
      timestamp: Math.round(Number(params.timestamp ?? Date.now())),
      url: typeof firstCallFrame?.url === "string" ? firstCallFrame.url : undefined,
      lineNumber: typeof firstCallFrame?.lineNumber === "number" ? firstCallFrame.lineNumber : undefined,
    });
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails as JsonObject | undefined;
    if (!details) return;
    const exception = details.exception as JsonObject | undefined;
    const stackTrace = details.stackTrace as JsonObject | undefined;
    const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames as JsonObject[] : [];
    jsErrors.push({
      message: typeof exception?.description === "string" ? exception.description : String(details.text ?? "JavaScript exception"),
      url: typeof details.url === "string" ? details.url : (typeof callFrames[0]?.url === "string" ? String(callFrames[0].url) : undefined),
      lineNumber: typeof details.lineNumber === "number" ? details.lineNumber : undefined,
      columnNumber: typeof details.columnNumber === "number" ? details.columnNumber : undefined,
      stackTrace: callFrames.length > 0 ? callFrames.map((frame) => `${String(frame.functionName ?? "<anonymous>")} (${String(frame.url ?? "")}:${String(frame.lineNumber ?? 0)}:${String(frame.columnNumber ?? 0)})`).join("\n") : undefined,
      timestamp: Date.now(),
    });
  }
}

async function ensureNetworkMonitoring(targetId: string): Promise<void> {
  if (networkEnabled) return;
  await sessionCommand(targetId, "Network.enable");
  networkEnabled = true;
}

async function ensureConsoleMonitoring(targetId: string): Promise<void> {
  if (consoleEnabled && errorsEnabled) return;
  await sessionCommand(targetId, "Runtime.enable");
  consoleEnabled = true;
  errorsEnabled = true;
}

async function attachTarget(targetId: string): Promise<string> {
  const result = await browserCommand<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  connectionState?.sessions.set(targetId, result.sessionId);
  connectionState?.attachedTargets.set(result.sessionId, targetId);
  connectionState?.activeFrameIdByTarget.set(targetId, connectionState?.activeFrameIdByTarget.get(targetId) ?? null);
  await sessionCommand(targetId, "Page.enable");
  await sessionCommand(targetId, "Runtime.enable");
  await sessionCommand(targetId, "DOM.enable");
  await sessionCommand(targetId, "Accessibility.enable");
  return result.sessionId;
}

async function getTargets(): Promise<CdpTargetInfo[]> {
  const state = connectionState;
  if (!state) throw new Error("CDP connection not initialized");
  try {
    const result = await browserCommand<{ targetInfos: Array<{ targetId: string; type: string; title: string; url: string }> }>("Target.getTargets");
    return (result.targetInfos || []).map((target) => ({
      id: target.targetId,
      type: target.type,
      title: target.title,
      url: target.url,
      webSocketDebuggerUrl: "",
    }));
  } catch {
    return getJsonList(state.host, state.port);
  }
}


async function ensurePageTarget(targetId?: string | number): Promise<CdpTargetInfo> {
  const targets = (await getTargets()).filter((target) => target.type === "page");
  if (targets.length === 0) throw new Error("No page target found");

  const persistedTargetId = targetId === undefined ? connectionState?.currentTargetId : undefined;
  let target: CdpTargetInfo | undefined;
  if (typeof targetId === "number") {
    target = targets[targetId] ?? targets.find((item) => Number(item.id) === targetId);
  } else if (typeof targetId === "string") {
    target = targets.find((item) => item.id === targetId);
    if (!target) {
      const numericTargetId = Number(targetId);
      if (!Number.isNaN(numericTargetId)) {
        target = targets[numericTargetId] ?? targets.find((item) => Number(item.id) === numericTargetId);
      }
    }
  } else if (persistedTargetId) {
    target = targets.find((item) => item.id === persistedTargetId);
  }
  target ??= targets[0];
  setCurrentTargetId(target.id);
  await attachTarget(target.id);
  return target;
}

async function resolveBackendNodeIdByXPath(targetId: string, xpath: string): Promise<number> {
  // Populate the DOM agent's node map — required before performSearch/describeNode
  await sessionCommand(targetId, "DOM.getDocument", { depth: 0 });

  const search = await sessionCommand<{ searchId: string; resultCount: number }>(targetId, "DOM.performSearch", {
    query: xpath,
    includeUserAgentShadowDOM: true,
  });

  try {
    if (!search.resultCount) {
      throw new Error(`Unknown ref xpath: ${xpath}`);
    }

    const { nodeIds } = await sessionCommand<{ nodeIds: number[] }>(targetId, "DOM.getSearchResults", {
      searchId: search.searchId,
      fromIndex: 0,
      toIndex: search.resultCount,
    });

    for (const nodeId of nodeIds) {
      const described = await sessionCommand<{ node: { backendNodeId?: number; nodeName?: string } }>(targetId, "DOM.describeNode", {
        nodeId,
      });
      if (described.node.backendNodeId) {
        return described.node.backendNodeId;
      }
    }

    throw new Error(`XPath resolved but no backend node id found: ${xpath}`);
  } finally {
    await sessionCommand(targetId, "DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
  }
}

async function parseRef(ref: string): Promise<number> {
  const targetId = connectionState?.currentTargetId ?? "";
  let refs = connectionState?.refsByTarget.get(targetId) ?? {};
  if (!refs[ref] && targetId) {
    const persistedRefs = loadPersistedRefs(targetId);
    if (persistedRefs) {
      connectionState?.refsByTarget.set(targetId, persistedRefs);
      refs = persistedRefs;
    }
  }
  const found = refs[ref];
  if (!found) {
    throw new Error(`Unknown ref: ${ref}. Run snapshot first.`);
  }
  if (found.backendDOMNodeId) {
    return found.backendDOMNodeId;
  }
  if (targetId && found.xpath) {
    const backendDOMNodeId = await resolveBackendNodeIdByXPath(targetId, found.xpath);
    found.backendDOMNodeId = backendDOMNodeId;
    connectionState?.refsByTarget.set(targetId, refs);
    const pageUrl = await evaluate<string>(targetId, "location.href", true).catch(() => undefined);
    if (pageUrl) {
      persistRefs(targetId, pageUrl, refs);
    }
    return backendDOMNodeId;
  }
  throw new Error(`Unknown ref: ${ref}. Run snapshot first.`);
}

function getRefsFilePath(targetId: string): string {
  return path.join(os.tmpdir(), `bb-browser-refs-${targetId}.json`);
}

function getCurrentTargetUrl(targetId: string): string | null {
  const state = connectionState;
  if (!state) return null;
  const pages = Array.from(state.sessions.keys());
  void pages;
  return null;
}

function loadPersistedRefs(targetId: string, expectedUrl?: string): Record<string, RefInfo> | null {
  try {
    const data = JSON.parse(readFileSync(getRefsFilePath(targetId), "utf-8")) as {
      targetId?: unknown;
      url?: unknown;
      refs?: unknown;
    };
    if (data.targetId !== targetId) return null;
    if (expectedUrl !== undefined && data.url !== expectedUrl) return null;
    if (!data.refs || typeof data.refs !== "object") return null;
    return data.refs as Record<string, RefInfo>;
  } catch {
    return null;
  }
}

function persistRefs(targetId: string, url: string, refs: Record<string, RefInfo>): void {
  try {
    writeFileSync(getRefsFilePath(targetId), JSON.stringify({ targetId, url, timestamp: Date.now(), refs }));
  } catch {}
}

function clearPersistedRefs(targetId: string): void {
  try {
    unlinkSync(getRefsFilePath(targetId));
  } catch {}
}

function loadBuildDomTreeScript(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Built dist: dist/cli.js → ../packages/shared/buildDomTree.js
    path.resolve(currentDir, "../packages/shared/buildDomTree.js"),
    // Dev mode: packages/cli/src/ → ../../shared/buildDomTree.js
    path.resolve(currentDir, "../../shared/buildDomTree.js"),
    // npm installed: dist/cli.js → same level
    path.resolve(currentDir, "./buildDomTree.js"),
    path.resolve(currentDir, "../buildDomTree.js"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
    }
  }
  throw new Error("Cannot find buildDomTree.js");
}

async function evaluate<T>(targetId: string, expression: string, returnByValue = true): Promise<T> {
  const result = await sessionCommand<{
    result: { type?: string; value?: T; objectId?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(targetId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "Runtime.evaluate failed",
    );
  }
  return (result.result.value ?? result.result) as T;
}

async function resolveNode(targetId: string, backendNodeId: number): Promise<number> {
  const result = await sessionCommand<{ nodeId: number }>(targetId, "DOM.pushNodesByBackendIdsToFrontend", {
    backendNodeIds: [backendNodeId],
  });
  return result.nodeId;
}

async function focusNode(targetId: string, backendNodeId: number): Promise<void> {
  await sessionCommand(targetId, "DOM.focus", { backendNodeId });
}

async function insertTextIntoNode(targetId: string, backendNodeId: number, text: string, clearFirst: boolean): Promise<void> {
  const resolved = await sessionCommand<{ object: { objectId: string } }>(targetId, "DOM.resolveNode", { backendNodeId });

  await sessionCommand(targetId, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: `function(clearFirst) {
      if (typeof this.scrollIntoView === 'function') {
        this.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      }
      if (typeof this.focus === 'function') this.focus();
      if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
        if (clearFirst) {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (typeof this.setSelectionRange === 'function') {
          const end = this.value.length;
          this.setSelectionRange(end, end);
        }
        return true;
      }
      if (this instanceof HTMLElement && this.isContentEditable) {
        if (clearFirst) {
          this.textContent = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(this);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      }
      return false;
    }`,
    arguments: [
      { value: clearFirst },
    ],
    returnByValue: true,
  });

  if (text) {
    await focusNode(targetId, backendNodeId);
    await sessionCommand(targetId, "Input.insertText", { text });
  }
}

async function getInteractablePoint(targetId: string, backendNodeId: number): Promise<{ x: number; y: number }> {
  const resolved = await sessionCommand<{ object: { objectId: string } }>(targetId, "DOM.resolveNode", { backendNodeId });
  const call = await sessionCommand<{
    result: { value?: { x?: number; y?: number } };
    exceptionDetails?: { text?: string };
  }>(targetId, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: `function() {
      if (!(this instanceof Element)) {
        throw new Error('Ref does not resolve to an element');
      }
      this.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      const rect = this.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        throw new Error('Element is not visible');
      }
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }`,
    returnByValue: true,
  });

  if (call.exceptionDetails) {
    throw new Error(call.exceptionDetails.text || "Failed to resolve element point");
  }

  const point = call.result.value;
  if (!point || typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("Failed to resolve element point");
  }

  return point as { x: number; y: number };
}

async function mouseClick(targetId: string, x: number, y: number): Promise<void> {
  await sessionCommand(targetId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await sessionCommand(targetId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sessionCommand(targetId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function getAttributeValue(targetId: string, backendNodeId: number, attribute: string): Promise<string> {
  if (attribute === "text") {
    const resolved = await sessionCommand<{ object: { objectId: string } }>(targetId, "DOM.resolveNode", { backendNodeId });
    const call = await sessionCommand<{ result: { value: string } }>(targetId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: `function() { return (this instanceof HTMLElement ? this.innerText : this.textContent || '').trim(); }`,
      returnByValue: true,
    });
    return String(call.result.value ?? "");
  }
  const result = await sessionCommand<{ object: { objectId: string } }>(targetId, "DOM.resolveNode", { backendNodeId });
  const call = await sessionCommand<{ result: { value: string } }>(targetId, "Runtime.callFunctionOn", {
    objectId: result.object.objectId,
    functionDeclaration: `function() { if (${JSON.stringify(attribute)} === 'url') return this.href || this.src || location.href; if (${JSON.stringify(attribute)} === 'title') return document.title; return this.getAttribute(${JSON.stringify(attribute)}) || ''; }`,
    returnByValue: true,
  });
  return String(call.result.value ?? "");
}

async function buildSnapshot(targetId: string, request: Request): Promise<SnapshotData> {
  const script = loadBuildDomTreeScript();
  const buildArgs = {
    showHighlightElements: true,
    focusHighlightIndex: -1,
    viewportExpansion: -1,
    debugMode: false,
    startId: 0,
    startHighlightIndex: 0,
  };
  const expression = `(() => { ${script}; const fn = globalThis.buildDomTree ?? (typeof window !== 'undefined' ? window.buildDomTree : undefined); if (typeof fn !== 'function') { throw new Error('buildDomTree is not available after script injection'); } return fn(${JSON.stringify({
    ...buildArgs,
  })}); })()`;
  const value = await evaluate<BuildDomTreeResult | null>(targetId, expression, true);
  if (!value || !value.map || !value.rootId) {
    const title = await evaluate<string>(targetId, "document.title", true);
    const pageUrl = await evaluate<string>(targetId, "location.href", true);
    const fallbackSnapshot: SnapshotData = {
      title,
      url: pageUrl,
      lines: [title || pageUrl],
      refs: {},
    };
    connectionState?.refsByTarget.set(targetId, {});
    persistRefs(targetId, pageUrl, {});
    return fallbackSnapshot;
  }

  const snapshot = convertBuildDomTreeResult(value, {
    interactiveOnly: !!request.interactive,
    compact: !!request.compact,
    maxDepth: request.maxDepth,
    selector: request.selector,
  });
  const pageUrl = await evaluate<string>(targetId, "location.href", true);
  connectionState?.refsByTarget.set(targetId, snapshot.refs || {});
  persistRefs(targetId, pageUrl, snapshot.refs || {});
  return snapshot;
}

function convertBuildDomTreeResult(
  result: BuildDomTreeResult,
  options: { interactiveOnly: boolean; compact: boolean; maxDepth?: number; selector?: string },
): SnapshotData {
  const { interactiveOnly, compact, maxDepth, selector } = options;
  const { rootId, map } = result;
  const refs: Record<string, RefInfo> = {};
  const lines: string[] = [];

  const getRole = (node: RawDomElementNode): string => {
    const tagName = node.tagName.toLowerCase();
    const role = node.attributes?.role;
    if (role) return role;
    const type = node.attributes?.type?.toLowerCase() || "text";
    const inputRoleMap: Record<string, string> = {
      text: "textbox", password: "textbox", email: "textbox", url: "textbox", tel: "textbox",
      search: "searchbox", number: "spinbutton", range: "slider", checkbox: "checkbox",
      radio: "radio", button: "button", submit: "button", reset: "button", file: "button",
    };
    const roleMap: Record<string, string> = {
      a: "link", button: "button", input: inputRoleMap[type] || "textbox", select: "combobox",
      textarea: "textbox", img: "image", nav: "navigation", main: "main", header: "banner",
      footer: "contentinfo", aside: "complementary", form: "form", table: "table", ul: "list",
      ol: "list", li: "listitem", h1: "heading", h2: "heading", h3: "heading", h4: "heading",
      h5: "heading", h6: "heading", dialog: "dialog", article: "article", section: "region",
      label: "label", details: "group", summary: "button",
    };
    return roleMap[tagName] || tagName;
  };

  const collectTextContent = (node: RawDomElementNode, nodeMap: Record<string, RawDomTreeNode>, depthLimit = 5): string => {
    const texts: string[] = [];
    const visit = (nodeId: string, depth: number): void => {
      if (depth > depthLimit) return;
      const currentNode = nodeMap[nodeId];
      if (!currentNode) return;
      if ("type" in currentNode && currentNode.type === "TEXT_NODE") {
        const text = currentNode.text.trim();
        if (text) texts.push(text);
        return;
      }
      for (const childId of (currentNode as RawDomElementNode).children || []) visit(childId, depth + 1);
    };
    for (const childId of node.children || []) visit(childId, 0);
    return texts.join(" ").trim();
  };

  const getName = (node: RawDomElementNode): string | undefined => {
    const attrs = node.attributes || {};
    return attrs["aria-label"] || attrs.title || attrs.placeholder || attrs.alt || attrs.value || collectTextContent(node, map) || attrs.name || undefined;
  };

  const truncateText = (text: string, length = 50): string => text.length <= length ? text : `${text.slice(0, length - 3)}...`;

  const selectorText = selector?.trim().toLowerCase();
  const matchesSelector = (node: RawDomElementNode, role: string, name?: string): boolean => {
    if (!selectorText) return true;
    const haystack = [node.tagName, role, name, node.xpath || "", ...Object.values(node.attributes || {})].join(" ").toLowerCase();
    return haystack.includes(selectorText);
  };

  if (interactiveOnly) {
    const interactiveNodes = Object.entries(map)
      .filter(([, node]) => !("type" in node) && node.highlightIndex !== undefined && node.highlightIndex !== null)
      .map(([id, node]) => ({ id, node: node as RawDomElementNode }))
      .sort((a, b) => (a.node.highlightIndex ?? 0) - (b.node.highlightIndex ?? 0));

    for (const { node } of interactiveNodes) {
      const refId = String(node.highlightIndex);
      const role = getRole(node);
      const name = getName(node);
      if (!matchesSelector(node, role, name)) continue;
      let line = `${role} [ref=${refId}]`;
      if (name) line += ` ${JSON.stringify(truncateText(name))}`;
      lines.push(line);
      refs[refId] = {
        xpath: node.xpath || "",
        role,
        name,
        tagName: node.tagName.toLowerCase(),
      } as RefInfo;
    }

    return { snapshot: lines.join("\n"), refs };
  }

  const walk = (nodeId: string, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;
    const node = map[nodeId];
    if (!node) return;

    if ("type" in node && node.type === "TEXT_NODE") {
      const text = node.text.trim();
      if (!text) return;
      lines.push(`${"  ".repeat(depth)}- text ${JSON.stringify(truncateText(text, compact ? 80 : 120))}`);
      return;
    }

    const role = getRole(node);
    const name = getName(node);
    if (!matchesSelector(node, role, name)) {
      for (const childId of node.children || []) walk(childId, depth + 1);
      return;
    }

    const indent = "  ".repeat(depth);
    const refId = node.highlightIndex !== undefined && node.highlightIndex !== null ? String(node.highlightIndex) : null;
    let line = `${indent}- ${role}`;
    if (refId) line += ` [ref=${refId}]`;
    if (name) line += ` ${JSON.stringify(truncateText(name, compact ? 50 : 80))}`;
    if (!compact) line += ` <${node.tagName.toLowerCase()}>`;
    lines.push(line);

    if (refId) {
      refs[refId] = {
        xpath: node.xpath || "",
        role,
        name,
        tagName: node.tagName.toLowerCase(),
      } as RefInfo;
    }

    for (const childId of node.children || []) walk(childId, depth + 1);
  };

  walk(rootId, 0);
  return { snapshot: lines.join("\n"), refs };
}

function ok(id: string, data?: ResponseData): Response {
  return { id, success: true, data };
}

function fail(id: string, error: unknown): Response {
  return { id, success: false, error: buildRequestError(error).message };
}

export async function ensureCdpConnection(): Promise<void> {
  if (connectionState) return;
  if (reconnecting) return reconnecting;
  reconnecting = (async () => {
    const discovered = await discoverCdpPort();
    if (!discovered) {
      throw new Error("No browser connection found");
    }
    const version = await getJsonVersion(discovered.host, discovered.port);
    const wsUrl = version.webSocketDebuggerUrl;
    const socket = await connectWebSocket(wsUrl);
    connectionState = createState(discovered.host, discovered.port, wsUrl, socket);
  })();
  try {
    await reconnecting;
  } finally {
    reconnecting = null;
  }
}


export async function sendCommand(request: Request): Promise<Response> {
  try {
    await ensureCdpConnection();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("请求超时")), COMMAND_TIMEOUT));
    return await Promise.race([dispatchRequest(request), timeout]);
  } catch (error) {
    return fail(request.id, error);
  }
}

async function dispatchRequest(request: Request): Promise<Response> {
  const target = await ensurePageTarget(request.tabId);
  switch (request.action) {
    case "open": {
      if (!request.url) return fail(request.id, "Missing url parameter");
      if (request.tabId === undefined) {
        const created = await browserCommand<{ targetId: string }>("Target.createTarget", { url: request.url, background: true });
        const newTarget = await ensurePageTarget(created.targetId);
        return ok(request.id, { url: request.url, tabId: newTarget.id });
      }
      await pageCommand(target.id, "Page.navigate", { url: request.url });
      connectionState?.refsByTarget.delete(target.id);
      clearPersistedRefs(target.id);
      return ok(request.id, { url: request.url, title: target.title, tabId: target.id });
    }
    case "snapshot": {
      const snapshotData = await buildSnapshot(target.id, request);
      return ok(request.id, { title: target.title, url: target.url, snapshotData });
    }
    case "click":
    case "hover": {
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      const backendNodeId = await parseRef(request.ref);
      const point = await getInteractablePoint(target.id, backendNodeId);
      await sessionCommand(target.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
      if (request.action === "click") await mouseClick(target.id, point.x, point.y);
      return ok(request.id, {});
    }
    case "fill":
    case "type": {
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      if (request.text == null) return fail(request.id, "Missing text parameter");
      const backendNodeId = await parseRef(request.ref);
      await insertTextIntoNode(target.id, backendNodeId, request.text, request.action === "fill");
      return ok(request.id, { value: request.text });
    }
    case "check":
    case "uncheck": {
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      const backendNodeId = await parseRef(request.ref);
      const desired = request.action === "check";
      const resolved = await sessionCommand<{ object: { objectId: string } }>(target.id, "DOM.resolveNode", { backendNodeId });
      await sessionCommand(target.id, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() { this.checked = ${desired}; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      });
      return ok(request.id, {});
    }
    case "select": {
      if (!request.ref || request.value == null) return fail(request.id, "Missing ref or value parameter");
      const backendNodeId = await parseRef(request.ref);
      const resolved = await sessionCommand<{ object: { objectId: string } }>(target.id, "DOM.resolveNode", { backendNodeId });
      await sessionCommand(target.id, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() { this.value = ${JSON.stringify(request.value)}; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      });
      return ok(request.id, { value: request.value });
    }
    case "get": {
      if (!request.attribute) return fail(request.id, "Missing attribute parameter");
      if (request.attribute === "url" && !request.ref) {
        return ok(request.id, { value: await evaluate<string>(target.id, "location.href", true) });
      }
      if (request.attribute === "title" && !request.ref) {
        return ok(request.id, { value: await evaluate<string>(target.id, "document.title", true) });
      }
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      const value = await getAttributeValue(target.id, await parseRef(request.ref), request.attribute);
      return ok(request.id, { value });
    }
    case "screenshot": {
      const result = await sessionCommand<{ data: string }>(target.id, "Page.captureScreenshot", { format: "png", fromSurface: true });
      return ok(request.id, { dataUrl: `data:image/png;base64,${result.data}` });
    }
    case "close": {
      await browserCommand("Target.closeTarget", { targetId: target.id });
      connectionState?.refsByTarget.delete(target.id);
      clearPersistedRefs(target.id);
      return ok(request.id, {});
    }
    case "wait": {
      await new Promise((resolve) => setTimeout(resolve, request.ms ?? 1000));
      return ok(request.id, {});
    }
    case "press": {
      if (!request.key) return fail(request.id, "Missing key parameter");
      await sessionCommand(target.id, "Input.dispatchKeyEvent", { type: "keyDown", key: request.key });
      if (request.key.length === 1) {
        await sessionCommand(target.id, "Input.dispatchKeyEvent", { type: "char", text: request.key, key: request.key });
      }
      await sessionCommand(target.id, "Input.dispatchKeyEvent", { type: "keyUp", key: request.key });
      return ok(request.id, {});
    }
    case "scroll": {
      const deltaY = request.direction === "up" ? -(request.pixels ?? 300) : (request.pixels ?? 300);
      await sessionCommand(target.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY });
      return ok(request.id, {});
    }
    case "back": {
      await evaluate(target.id, "history.back(); undefined");
      return ok(request.id, {});
    }
    case "forward": {
      await evaluate(target.id, "history.forward(); undefined");
      return ok(request.id, {});
    }
    case "refresh": {
      await sessionCommand(target.id, "Page.reload", { ignoreCache: false });
      return ok(request.id, {});
    }
    case "eval": {
      if (!request.script) return fail(request.id, "Missing script parameter");
      const result = await evaluate<unknown>(target.id, request.script, true);
      return ok(request.id, { result });
    }
    case "tab_list": {
      const tabs = (await getTargets()).filter((item) => item.type === "page").map((item, index): TabInfo => ({ index, url: item.url, title: item.title, active: item.id === connectionState?.currentTargetId || (!connectionState?.currentTargetId && index === 0), tabId: item.id }));
      return ok(request.id, { tabs, activeIndex: tabs.findIndex((tab) => tab.active) });
    }
    case "tab_new": {
      const created = await browserCommand<{ targetId: string }>("Target.createTarget", { url: request.url ?? "about:blank", background: true });
      return ok(request.id, { tabId: created.targetId, url: request.url ?? "about:blank" });
    }
    case "tab_select": {
      const tabs = (await getTargets()).filter((item) => item.type === "page");
      const selected = request.tabId !== undefined
        ? tabs.find((item) => item.id === String(request.tabId) || Number(item.id) === request.tabId)
        : tabs[request.index ?? 0];
      if (!selected) return fail(request.id, "Tab not found");
      setCurrentTargetId(selected.id);
      await attachTarget(selected.id);
      return ok(request.id, { tabId: selected.id, url: selected.url, title: selected.title });
    }
    case "tab_close": {
      const tabs = (await getTargets()).filter((item) => item.type === "page");
      const selected = request.tabId !== undefined
        ? tabs.find((item) => item.id === String(request.tabId) || Number(item.id) === request.tabId)
        : tabs[request.index ?? 0];
      if (!selected) return fail(request.id, "Tab not found");
      await browserCommand("Target.closeTarget", { targetId: selected.id });
      connectionState?.refsByTarget.delete(selected.id);
      if (connectionState?.currentTargetId === selected.id) {
        setCurrentTargetId(undefined);
      }
      clearPersistedRefs(selected.id);
      return ok(request.id, { tabId: selected.id });
    }
    case "frame": {
      if (!request.selector) return fail(request.id, "Missing selector parameter");
      const document = await pageCommand<{ root: { nodeId: number } }>(target.id, "DOM.getDocument", {});
      const node = await pageCommand<{ nodeId: number }>(target.id, "DOM.querySelector", { nodeId: document.root.nodeId, selector: request.selector });
      if (!node.nodeId) return fail(request.id, `找不到 iframe: ${request.selector}`);
      const described = await pageCommand<{ node: { frameId?: string; nodeName?: string; attributes?: string[] } }>(target.id, "DOM.describeNode", { nodeId: node.nodeId });
      const frameId = described.node.frameId;
      const nodeName = String(described.node.nodeName ?? "").toLowerCase();
      if (!frameId) return fail(request.id, `无法获取 iframe frameId: ${request.selector}`);
      if (nodeName && nodeName !== "iframe" && nodeName !== "frame") return fail(request.id, `元素不是 iframe: ${nodeName}`);
      connectionState?.activeFrameIdByTarget.set(target.id, frameId);
      const attributes = described.node.attributes ?? [];
      const attrMap: Record<string, string> = {};
      for (let i = 0; i < attributes.length; i += 2) attrMap[String(attributes[i])] = String(attributes[i + 1] ?? "");
      return ok(request.id, { frameInfo: { selector: request.selector, name: attrMap.name ?? "", url: attrMap.src ?? "", frameId } });
    }
    case "frame_main": {
      connectionState?.activeFrameIdByTarget.set(target.id, null);
      return ok(request.id, { frameInfo: { frameId: 0 } });
    }
    case "dialog": {
      connectionState?.dialogHandlers.set(target.id, { accept: request.dialogResponse !== "dismiss", ...(request.promptText !== undefined ? { promptText: request.promptText } : {}) });
      await sessionCommand(target.id, "Page.enable");
      return ok(request.id, { dialog: { armed: true, response: request.dialogResponse ?? "accept" } as ResponseData[keyof ResponseData] });
    }
    case "network": {
      const subCommand = request.networkCommand ?? "requests";
      switch (subCommand) {
        case "requests": {
          await ensureNetworkMonitoring(target.id);
          const requests = Array.from(networkRequests.values()).filter((item) => !request.filter || item.url.includes(request.filter));
          if (request.withBody) {
            await Promise.all(requests.map(async (item) => {
              if (item.failed || item.responseBody !== undefined || item.bodyError !== undefined) return;
              try {
                const body = await sessionCommand<{ body: string; base64Encoded: boolean }>(target.id, "Network.getResponseBody", { requestId: item.requestId });
                item.responseBody = body.body;
                item.responseBodyBase64 = body.base64Encoded;
              } catch (error) {
                item.bodyError = error instanceof Error ? error.message : String(error);
              }
            }));
          }
          return ok(request.id, { networkRequests: requests });
        }
        case "route":
          return ok(request.id, { routeCount: 0 });
        case "unroute":
          return ok(request.id, { routeCount: 0 });
        case "clear":
          networkRequests.clear();
          return ok(request.id, {});
        default:
          return fail(request.id, `Unknown network subcommand: ${subCommand}`);
      }
    }
    case "console": {
      const subCommand = request.consoleCommand ?? "get";
      await ensureConsoleMonitoring(target.id);
      switch (subCommand) {
        case "get":
          return ok(request.id, { consoleMessages: consoleMessages.filter((item) => !request.filter || item.text.includes(request.filter)) });
        case "clear":
          consoleMessages.length = 0;
          return ok(request.id, {});
        default:
          return fail(request.id, `Unknown console subcommand: ${subCommand}`);
      }
    }
    case "errors": {
      const subCommand = request.errorsCommand ?? "get";
      await ensureConsoleMonitoring(target.id);
      switch (subCommand) {
        case "get":
          return ok(request.id, { jsErrors: jsErrors.filter((item) => !request.filter || item.message.includes(request.filter) || item.url?.includes(request.filter)) });
        case "clear":
          jsErrors.length = 0;
          return ok(request.id, {});
        default:
          return fail(request.id, `Unknown errors subcommand: ${subCommand}`);
      }
    }
    case "trace": {
      const subCommand = request.traceCommand ?? "status";
      switch (subCommand) {
        case "start":
          traceRecording = true;
          traceEvents.length = 0;
          return ok(request.id, { traceStatus: { recording: true, eventCount: 0 } satisfies TraceStatus });
        case "stop": {
          traceRecording = false;
          return ok(request.id, { traceEvents: [...traceEvents] satisfies TraceEvent[], traceStatus: { recording: false, eventCount: traceEvents.length } satisfies TraceStatus });
        }
        case "status":
          return ok(request.id, { traceStatus: { recording: traceRecording, eventCount: traceEvents.length } satisfies TraceStatus });
        default:
          return fail(request.id, `Unknown trace subcommand: ${subCommand}`);
      }
    }
    default:
      return fail(request.id, `Action not yet supported in direct CDP mode: ${request.action}`);
  }
}
