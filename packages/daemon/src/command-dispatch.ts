/**
 * Command dispatch — handles all browser commands via CDP.
 *
 * Ported from cli/cdp-client.ts dispatchRequest, adapted to use
 * CdpConnection + TabStateManager for per-tab state and seq tracking.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Request,
  Response,
  ResponseData,
  RefInfo,
  SnapshotData,
  TraceEvent,
  TraceStatus,
} from "@bb-browser/shared";
import { CdpConnection, type CdpTargetInfo } from "./cdp-connection.js";
import type { TabState } from "./tab-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequestError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Extended response data with daemon-specific fields.
 * Relaxes frameInfo.frameId to accept string (CDP uses string frame IDs).
 */
type ExtResponseData = Omit<ResponseData, "tabs" | "frameInfo"> & {
  tabs?: Array<Record<string, unknown>>;
  frameInfo?: {
    selector?: string;
    name?: string;
    url?: string;
    frameId?: string | number;
  };
};

function ok(id: string, data?: ExtResponseData): Response {
  return { id, success: true, data: data as ResponseData };
}

function fail(id: string, error: unknown): Response {
  return { id, success: false, error: buildRequestError(error).message };
}

// ---------------------------------------------------------------------------
// buildDomTree script loading
// ---------------------------------------------------------------------------

let cachedBuildDomTreeScript: string | null = null;

function loadBuildDomTreeScript(): string {
  if (cachedBuildDomTreeScript) return cachedBuildDomTreeScript;

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Built dist: dist/daemon.js → ../packages/shared/buildDomTree.js
    path.resolve(currentDir, "../packages/shared/buildDomTree.js"),
    // Dev mode: packages/daemon/src/ → ../../shared/buildDomTree.js
    path.resolve(currentDir, "../../shared/buildDomTree.js"),
    // npm installed: dist/daemon.js → same level
    path.resolve(currentDir, "./buildDomTree.js"),
    path.resolve(currentDir, "../buildDomTree.js"),
  ];
  for (const candidate of candidates) {
    try {
      cachedBuildDomTreeScript = readFileSync(candidate, "utf8");
      return cachedBuildDomTreeScript;
    } catch {}
  }
  throw new Error("Cannot find buildDomTree.js");
}

// ---------------------------------------------------------------------------
// Snapshot building
// ---------------------------------------------------------------------------

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

  const truncateText = (text: string, length = 50): string =>
    text.length <= length ? text : `${text.slice(0, length - 3)}...`;

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
      refs[refId] = { xpath: node.xpath || "", role, name, tagName: node.tagName.toLowerCase() } as RefInfo;
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

    const el = node as RawDomElementNode;
    const role = getRole(el);
    const name = getName(el);
    if (!matchesSelector(el, role, name)) {
      for (const childId of el.children || []) walk(childId, depth + 1);
      return;
    }

    const indent = "  ".repeat(depth);
    const refId = el.highlightIndex !== undefined && el.highlightIndex !== null ? String(el.highlightIndex) : null;
    let line = `${indent}- ${role}`;
    if (refId) line += ` [ref=${refId}]`;
    if (name) line += ` ${JSON.stringify(truncateText(name, compact ? 50 : 80))}`;
    if (!compact) line += ` <${el.tagName.toLowerCase()}>`;
    lines.push(line);

    if (refId) {
      refs[refId] = { xpath: el.xpath || "", role, name, tagName: el.tagName.toLowerCase() } as RefInfo;
    }

    for (const childId of el.children || []) walk(childId, depth + 1);
  };

  walk(rootId, 0);
  return { snapshot: lines.join("\n"), refs };
}

async function buildSnapshot(
  cdp: CdpConnection,
  targetId: string,
  tab: TabState,
  request: Request,
): Promise<SnapshotData> {
  const script = loadBuildDomTreeScript();
  const buildArgs = {
    showHighlightElements: true,
    focusHighlightIndex: -1,
    viewportExpansion: -1,
    debugMode: false,
    startId: 0,
    startHighlightIndex: 0,
  };
  const expression = `(() => { ${script}; const fn = globalThis.buildDomTree ?? (typeof window !== 'undefined' ? window.buildDomTree : undefined); if (typeof fn !== 'function') { throw new Error('buildDomTree is not available after script injection'); } return fn(${JSON.stringify(buildArgs)}); })()`;
  const value = await cdp.evaluate<BuildDomTreeResult | null>(targetId, expression, true);

  if (!value || !value.map || !value.rootId) {
    const title = await cdp.evaluate<string>(targetId, "document.title", true);
    const pageUrl = await cdp.evaluate<string>(targetId, "location.href", true);
    tab.refs = {};
    return { snapshot: title || pageUrl, refs: {} };
  }

  const snapshot = convertBuildDomTreeResult(value, {
    interactiveOnly: !!request.interactive,
    compact: !!request.compact,
    maxDepth: request.maxDepth,
    selector: request.selector,
  });
  tab.refs = snapshot.refs || {};
  return snapshot;
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

async function resolveBackendNodeIdByXPath(
  cdp: CdpConnection,
  targetId: string,
  xpath: string,
): Promise<number> {
  await cdp.sessionCommand(targetId, "DOM.getDocument", { depth: 0 });
  const search = await cdp.sessionCommand<{ searchId: string; resultCount: number }>(
    targetId,
    "DOM.performSearch",
    { query: xpath, includeUserAgentShadowDOM: true },
  );

  try {
    if (!search.resultCount) {
      throw new Error(`Unknown ref xpath: ${xpath}`);
    }
    const { nodeIds } = await cdp.sessionCommand<{ nodeIds: number[] }>(
      targetId,
      "DOM.getSearchResults",
      { searchId: search.searchId, fromIndex: 0, toIndex: search.resultCount },
    );

    for (const nodeId of nodeIds) {
      const described = await cdp.sessionCommand<{
        node: { backendNodeId?: number };
      }>(targetId, "DOM.describeNode", { nodeId });
      if (described.node.backendNodeId) {
        return described.node.backendNodeId;
      }
    }
    throw new Error(`XPath resolved but no backend node id found: ${xpath}`);
  } finally {
    await cdp.sessionCommand(targetId, "DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
  }
}

async function parseRef(cdp: CdpConnection, targetId: string, tab: TabState, ref: string): Promise<number> {
  const found = tab.refs[ref];
  if (!found) {
    throw new Error(`Unknown ref: ${ref}. Run snapshot first.`);
  }
  if (found.backendDOMNodeId) {
    return found.backendDOMNodeId;
  }
  if (found.xpath) {
    const backendDOMNodeId = await resolveBackendNodeIdByXPath(cdp, targetId, found.xpath);
    found.backendDOMNodeId = backendDOMNodeId;
    return backendDOMNodeId;
  }
  throw new Error(`Unknown ref: ${ref}. Run snapshot first.`);
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

async function getInteractablePoint(
  cdp: CdpConnection,
  targetId: string,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
    targetId,
    "DOM.resolveNode",
    { backendNodeId },
  );
  const call = await cdp.sessionCommand<{
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
  if (
    !point ||
    typeof point.x !== "number" ||
    typeof point.y !== "number" ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    throw new Error("Failed to resolve element point");
  }
  return point as { x: number; y: number };
}

async function mouseClick(cdp: CdpConnection, targetId: string, x: number, y: number): Promise<void> {
  await cdp.sessionCommand(targetId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none",
  });
  await cdp.sessionCommand(targetId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await cdp.sessionCommand(targetId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
}

async function insertTextIntoNode(
  cdp: CdpConnection,
  targetId: string,
  backendNodeId: number,
  text: string,
  clearFirst: boolean,
): Promise<void> {
  const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
    targetId,
    "DOM.resolveNode",
    { backendNodeId },
  );

  await cdp.sessionCommand(targetId, "Runtime.callFunctionOn", {
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
    arguments: [{ value: clearFirst }],
    returnByValue: true,
  });

  if (text) {
    await cdp.sessionCommand(targetId, "DOM.focus", { backendNodeId });
    await cdp.sessionCommand(targetId, "Input.insertText", { text });
  }
}

async function getAttributeValue(
  cdp: CdpConnection,
  targetId: string,
  backendNodeId: number,
  attribute: string,
): Promise<string> {
  if (attribute === "text") {
    const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
      targetId,
      "DOM.resolveNode",
      { backendNodeId },
    );
    const call = await cdp.sessionCommand<{ result: { value: string } }>(
      targetId,
      "Runtime.callFunctionOn",
      {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() { return (this instanceof HTMLElement ? this.innerText : this.textContent || '').trim(); }`,
        returnByValue: true,
      },
    );
    return String(call.result.value ?? "");
  }
  const result = await cdp.sessionCommand<{ object: { objectId: string } }>(
    targetId,
    "DOM.resolveNode",
    { backendNodeId },
  );
  const call = await cdp.sessionCommand<{ result: { value: string } }>(
    targetId,
    "Runtime.callFunctionOn",
    {
      objectId: result.object.objectId,
      functionDeclaration: `function() { if (${JSON.stringify(attribute)} === 'url') return this.href || this.src || location.href; if (${JSON.stringify(attribute)} === 'title') return document.title; return this.getAttribute(${JSON.stringify(attribute)}) || ''; }`,
      returnByValue: true,
    },
  );
  return String(call.result.value ?? "");
}

// ---------------------------------------------------------------------------
// Trace state (global, not per-tab — matches original behavior)
// ---------------------------------------------------------------------------

let traceRecording = false;
const traceEvents: TraceEvent[] = [];

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a command request. This is the core function that handles all
 * browser automation commands via CDP.
 */
export async function dispatchRequest(
  cdp: CdpConnection,
  request: Request,
): Promise<Response> {
  // Resolve target from request.tabId (supports short IDs)
  const tabRef = request.tabId;

  // tab_new must work even when there are no existing tabs,
  // so handle it before ensurePageTarget().
  if (request.action === "tab_new") {
    const url = request.url ?? "about:blank";
    const created = await cdp.browserCommand<{ targetId: string }>(
      "Target.createTarget",
      { url, background: true },
    );
    await cdp.attachAndEnable(created.targetId);
    const newTab = cdp.tabManager.getTab(created.targetId);
    return ok(request.id, {
      tabId: created.targetId,
      url,
      tab: newTab?.shortId ?? created.targetId.slice(-4).toLowerCase(),
      seq: newTab?.recordAction(),
    });
  }

  const target = await cdp.ensurePageTarget(
    tabRef !== undefined ? String(tabRef) : undefined,
  );
  const tab = cdp.tabManager.getTab(target.id);
  if (!tab) throw new Error("Internal error: tab state not found");

  const shortId = tab.shortId;

  switch (request.action) {
    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------
    case "open": {
      if (!request.url) return fail(request.id, "Missing url parameter");
      const seq = tab.recordAction();
      if (tabRef === undefined) {
        // No specific tab requested — open in new tab
        const created = await cdp.browserCommand<{ targetId: string }>(
          "Target.createTarget",
          { url: request.url, background: true },
        );
        const newTarget = await cdp.ensurePageTarget(created.targetId);
        const newTab = cdp.tabManager.getTab(newTarget.id);
        return ok(request.id, {
          url: request.url,
          tabId: newTarget.id,
          tab: newTab?.shortId ?? shortId,
          seq,
        });
      }
      await cdp.pageCommand(target.id, "Page.navigate", { url: request.url });
      tab.refs = {};
      return ok(request.id, {
        url: request.url,
        title: target.title,
        tabId: target.id,
        tab: shortId,
        seq,
      });
    }

    case "back": {
      const seq = tab.recordAction();
      await cdp.evaluate(target.id, "history.back(); undefined");
      return ok(request.id, { tab: shortId, seq });
    }

    case "forward": {
      const seq = tab.recordAction();
      await cdp.evaluate(target.id, "history.forward(); undefined");
      return ok(request.id, { tab: shortId, seq });
    }

    case "refresh": {
      const seq = tab.recordAction();
      await cdp.sessionCommand(target.id, "Page.reload", { ignoreCache: false });
      return ok(request.id, { tab: shortId, seq });
    }

    case "close": {
      const seq = tab.recordAction();
      await cdp.browserCommand("Target.closeTarget", { targetId: target.id });
      tab.refs = {};
      return ok(request.id, { tab: shortId, seq });
    }

    // -----------------------------------------------------------------------
    // Snapshot / observation
    // -----------------------------------------------------------------------
    case "snapshot": {
      const snapshotData = await buildSnapshot(cdp, target.id, tab, request);
      return ok(request.id, {
        title: target.title,
        url: target.url,
        snapshotData,
        tab: shortId,
      });
    }

    case "screenshot": {
      const result = await cdp.sessionCommand<{ data: string }>(
        target.id,
        "Page.captureScreenshot",
        { format: "png", fromSurface: true },
      );
      return ok(request.id, {
        dataUrl: `data:image/png;base64,${result.data}`,
        tab: shortId,
      });
    }

    // -----------------------------------------------------------------------
    // Element interaction
    // -----------------------------------------------------------------------
    case "click":
    case "hover": {
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      const seq = tab.recordAction();
      const backendNodeId = await parseRef(cdp, target.id, tab, request.ref);
      const point = await getInteractablePoint(cdp, target.id, backendNodeId);
      await cdp.sessionCommand(target.id, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: point.x, y: point.y, button: "none",
      });
      if (request.action === "click") {
        await mouseClick(cdp, target.id, point.x, point.y);
      }
      return ok(request.id, { tab: shortId, seq });
    }

    case "fill":
    case "type": {
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      if (request.text == null) return fail(request.id, "Missing text parameter");
      const seq = tab.recordAction();
      const backendNodeId = await parseRef(cdp, target.id, tab, request.ref);
      await insertTextIntoNode(cdp, target.id, backendNodeId, request.text, request.action === "fill");
      return ok(request.id, {
        value: request.text,
        tab: shortId,
        seq,
      });
    }

    case "check":
    case "uncheck": {
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      const seq = tab.recordAction();
      const desired = request.action === "check";
      const backendNodeId = await parseRef(cdp, target.id, tab, request.ref);
      const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
        target.id,
        "DOM.resolveNode",
        { backendNodeId },
      );
      await cdp.sessionCommand(target.id, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() { this.checked = ${desired}; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      });
      return ok(request.id, { tab: shortId, seq });
    }

    case "select": {
      if (!request.ref || request.value == null) return fail(request.id, "Missing ref or value parameter");
      const seq = tab.recordAction();
      const backendNodeId = await parseRef(cdp, target.id, tab, request.ref);
      const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
        target.id,
        "DOM.resolveNode",
        { backendNodeId },
      );
      await cdp.sessionCommand(target.id, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() { this.value = ${JSON.stringify(request.value)}; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      });
      return ok(request.id, {
        value: request.value,
        tab: shortId,
        seq,
      });
    }

    case "get": {
      if (!request.attribute) return fail(request.id, "Missing attribute parameter");
      if (request.attribute === "url" && !request.ref) {
        return ok(request.id, {
          value: await cdp.evaluate<string>(target.id, "location.href", true),
          tab: shortId,
        });
      }
      if (request.attribute === "title" && !request.ref) {
        return ok(request.id, {
          value: await cdp.evaluate<string>(target.id, "document.title", true),
          tab: shortId,
        });
      }
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      const value = await getAttributeValue(
        cdp,
        target.id,
        await parseRef(cdp, target.id, tab, request.ref),
        request.attribute,
      );
      return ok(request.id, { value, tab: shortId });
    }

    case "press": {
      if (!request.key) return fail(request.id, "Missing key parameter");
      const seq = tab.recordAction();
      await cdp.sessionCommand(target.id, "Input.dispatchKeyEvent", {
        type: "keyDown", key: request.key,
      });
      if (request.key.length === 1) {
        await cdp.sessionCommand(target.id, "Input.dispatchKeyEvent", {
          type: "char", text: request.key, key: request.key,
        });
      }
      await cdp.sessionCommand(target.id, "Input.dispatchKeyEvent", {
        type: "keyUp", key: request.key,
      });
      return ok(request.id, { tab: shortId, seq });
    }

    case "scroll": {
      const seq = tab.recordAction();
      const pixels = request.pixels ?? 300;
      let deltaX = 0;
      let deltaY = 0;
      switch (request.direction) {
        case "up": deltaY = -pixels; break;
        case "down": deltaY = pixels; break;
        case "left": deltaX = -pixels; break;
        case "right": deltaX = pixels; break;
      }
      await cdp.sessionCommand(target.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 0, y: 0, deltaX, deltaY,
      });
      return ok(request.id, { tab: shortId, seq });
    }

    case "wait": {
      await new Promise((resolve) => setTimeout(resolve, request.ms ?? 1000));
      return ok(request.id, { tab: shortId });
    }

    case "eval": {
      if (!request.script) return fail(request.id, "Missing script parameter");
      const seq = tab.recordAction();
      const result = await cdp.evaluate<unknown>(target.id, request.script, true);
      return ok(request.id, {
        result,
        tab: shortId,
        seq,
      });
    }

    // -----------------------------------------------------------------------
    // Tab management
    // -----------------------------------------------------------------------
    case "tab_list": {
      const targets = (await cdp.getTargets()).filter((t) => t.type === "page");
      const tabs = targets.map((t, index) => {
        const tState = cdp.tabManager.getTab(t.id);
        return {
          index,
          url: t.url,
          title: t.title,
          active: t.id === cdp.currentTargetId || (!cdp.currentTargetId && index === 0),
          tabId: t.id,
          tab: tState?.shortId ?? t.id.slice(-4).toLowerCase(),
        };
      });
      return ok(request.id, {
        tabs,
        activeIndex: tabs.findIndex((t) => t.active),
      });
    }

    // tab_new is handled before ensurePageTarget() above

    case "tab_select": {
      const targets = (await cdp.getTargets()).filter((t) => t.type === "page");
      let selected: CdpTargetInfo | undefined;

      if (request.tabId !== undefined) {
        const tabIdStr = String(request.tabId);
        // Try short ID
        const resolvedId = cdp.tabManager.resolveShortId(tabIdStr);
        if (resolvedId) {
          selected = targets.find((t) => t.id === resolvedId);
        }
        // Try full target ID
        if (!selected) {
          selected = targets.find((t) => t.id === tabIdStr);
        }
        // Try numeric index
        if (!selected) {
          const num = Number(tabIdStr);
          if (!Number.isNaN(num)) {
            selected = targets[num];
          }
        }
      } else {
        selected = targets[request.index ?? 0];
      }

      if (!selected) return fail(request.id, "Tab not found");
      cdp.currentTargetId = selected.id;
      await cdp.attachAndEnable(selected.id);
      const selTab = cdp.tabManager.getTab(selected.id);
      return ok(request.id, {
        tabId: selected.id,
        url: selected.url,
        title: selected.title,
        tab: selTab?.shortId,
      });
    }

    case "tab_close": {
      const targets = (await cdp.getTargets()).filter((t) => t.type === "page");
      let selected: CdpTargetInfo | undefined;

      if (request.tabId !== undefined) {
        const tabIdStr = String(request.tabId);
        const resolvedId = cdp.tabManager.resolveShortId(tabIdStr);
        if (resolvedId) {
          selected = targets.find((t) => t.id === resolvedId);
        }
        if (!selected) {
          selected = targets.find((t) => t.id === tabIdStr);
        }
        if (!selected) {
          const num = Number(tabIdStr);
          if (!Number.isNaN(num)) {
            selected = targets[num];
          }
        }
      } else {
        selected = targets[request.index ?? 0];
      }

      if (!selected) return fail(request.id, "Tab not found");
      const closedTab = cdp.tabManager.getTab(selected.id);
      const closedShort = closedTab?.shortId;
      await cdp.browserCommand("Target.closeTarget", { targetId: selected.id });
      if (cdp.currentTargetId === selected.id) {
        cdp.currentTargetId = undefined;
      }
      return ok(request.id, {
        tabId: selected.id,
        tab: closedShort,
      });
    }

    // -----------------------------------------------------------------------
    // Frame navigation
    // -----------------------------------------------------------------------
    case "frame": {
      if (!request.selector) return fail(request.id, "Missing selector parameter");
      const seq = tab.recordAction();
      const document = await cdp.pageCommand<{ root: { nodeId: number } }>(
        target.id,
        "DOM.getDocument",
        {},
      );
      const node = await cdp.pageCommand<{ nodeId: number }>(
        target.id,
        "DOM.querySelector",
        { nodeId: document.root.nodeId, selector: request.selector },
      );
      if (!node.nodeId) return fail(request.id, `iframe not found: ${request.selector}`);
      const described = await cdp.pageCommand<{
        node: { frameId?: string; nodeName?: string; attributes?: string[] };
      }>(target.id, "DOM.describeNode", { nodeId: node.nodeId });
      const frameId = described.node.frameId;
      const nodeName = String(described.node.nodeName ?? "").toLowerCase();
      if (!frameId) return fail(request.id, `Cannot get iframe frameId: ${request.selector}`);
      if (nodeName && nodeName !== "iframe" && nodeName !== "frame") {
        return fail(request.id, `Element is not an iframe: ${nodeName}`);
      }
      tab.activeFrameId = frameId;
      const attributes = described.node.attributes ?? [];
      const attrMap: Record<string, string> = {};
      for (let i = 0; i < attributes.length; i += 2) {
        attrMap[String(attributes[i])] = String(attributes[i + 1] ?? "");
      }
      return ok(request.id, {
        frameInfo: {
          selector: request.selector,
          name: attrMap.name ?? "",
          url: attrMap.src ?? "",
          frameId,
        },
        tab: shortId,
        seq,
      });
    }

    case "frame_main": {
      const seq = tab.recordAction();
      tab.activeFrameId = null;
      return ok(request.id, {
        frameInfo: { frameId: 0 },
        tab: shortId,
        seq,
      });
    }

    // -----------------------------------------------------------------------
    // Dialog
    // -----------------------------------------------------------------------
    case "dialog": {
      const seq = tab.recordAction();
      tab.dialogHandler = {
        accept: request.dialogResponse !== "dismiss",
        ...(request.promptText !== undefined ? { promptText: request.promptText } : {}),
      };
      await cdp.sessionCommand(target.id, "Page.enable");
      return ok(request.id, {
        dialogInfo: {
          type: "armed",
          message: `Dialog handler armed: ${request.dialogResponse ?? "accept"}`,
          handled: false,
        },
        tab: shortId,
        seq,
      });
    }

    // -----------------------------------------------------------------------
    // Network observation
    // -----------------------------------------------------------------------
    case "network": {
      const subCommand = request.networkCommand ?? "requests";
      switch (subCommand) {
        case "requests": {
          const queryResult = tab.getNetworkRequests({
            since: request.since,
            filter: request.filter,
            method: request.method,
            status: request.status,
            limit: request.limit,
          });

          const items = queryResult.items;
          // Fetch response bodies if requested
          if (request.withBody) {
            await Promise.all(
              items.map(async (item) => {
                if (item.failed || item.responseBody !== undefined || item.bodyError !== undefined) return;
                try {
                  const body = await cdp.sessionCommand<{ body: string; base64Encoded: boolean }>(
                    target.id,
                    "Network.getResponseBody",
                    { requestId: item.requestId },
                  );
                  item.responseBody = body.body;
                  item.responseBodyBase64 = body.base64Encoded;
                } catch (error) {
                  item.bodyError = error instanceof Error ? error.message : String(error);
                }
              }),
            );
          }

          return ok(request.id, {
            networkRequests: items,
            tab: shortId,
            cursor: queryResult.cursor,
          });
        }
        case "route":
          return ok(request.id, { routeCount: 0, tab: shortId });
        case "unroute":
          return ok(request.id, { routeCount: 0, tab: shortId });
        case "clear":
          tab.clearNetwork();
          return ok(request.id, { tab: shortId });
        default:
          return fail(request.id, `Unknown network subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // Console observation
    // -----------------------------------------------------------------------
    case "console": {
      const subCommand = request.consoleCommand ?? "get";
      switch (subCommand) {
        case "get": {
          const queryResult = tab.getConsoleMessages({
            since: request.since,
            filter: request.filter,
            limit: request.limit,
          });
          return ok(request.id, {
            consoleMessages: queryResult.items,
            tab: shortId,
            cursor: queryResult.cursor,
          });
        }
        case "clear":
          tab.clearConsole();
          return ok(request.id, { tab: shortId });
        default:
          return fail(request.id, `Unknown console subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // JS Errors observation
    // -----------------------------------------------------------------------
    case "errors": {
      const subCommand = request.errorsCommand ?? "get";
      switch (subCommand) {
        case "get": {
          const queryResult = tab.getJSErrors({
            since: request.since,
            filter: request.filter,
            limit: request.limit,
          });
          return ok(request.id, {
            jsErrors: queryResult.items,
            tab: shortId,
            cursor: queryResult.cursor,
          });
        }
        case "clear":
          tab.clearErrors();
          return ok(request.id, { tab: shortId });
        default:
          return fail(request.id, `Unknown errors subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // Trace
    // -----------------------------------------------------------------------
    case "trace": {
      const subCommand = request.traceCommand ?? "status";
      switch (subCommand) {
        case "start":
          traceRecording = true;
          traceEvents.length = 0;
          return ok(request.id, {
            traceStatus: { recording: true, eventCount: 0 } satisfies TraceStatus,
            tab: shortId,
          });
        case "stop": {
          traceRecording = false;
          return ok(request.id, {
            traceEvents: [...traceEvents],
            traceStatus: { recording: false, eventCount: traceEvents.length } satisfies TraceStatus,
            tab: shortId,
          });
        }
        case "status":
          return ok(request.id, {
            traceStatus: { recording: traceRecording, eventCount: traceEvents.length } satisfies TraceStatus,
            tab: shortId,
          });
        default:
          return fail(request.id, `Unknown trace subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // History (not implemented in daemon yet)
    // -----------------------------------------------------------------------
    case "history": {
      return fail(request.id, "History command is not supported in daemon mode");
    }

    default:
      return fail(request.id, `Unknown action: ${request.action}`);
  }
}
