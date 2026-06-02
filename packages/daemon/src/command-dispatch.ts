/**
 * Command dispatch — handles all browser commands via CDP.
 *
 * Ported from cli/cdp-client.ts dispatchRequest, adapted to use
 * CdpConnection + TabStateManager for per-tab state and seq tracking.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type {
  Request,
  Response,
  ResponseData,
  RefInfo,
  SnapshotData,
  TraceEntry,
  TraceStatus,
} from "@bb-browser/shared";
import { CdpConnection } from "./cdp-connection.js";
import type { TabState } from "./tab-state.js";
import { getAllSites, executeSiteAdapter } from "./site-adapter.js";

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

function ok(data?: ExtResponseData): Response {
  return { result: data as ResponseData };
}

function fail(error: unknown): Response {
  return { error: { message: buildRequestError(error).message } };
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

const CLEANUP_HIGHLIGHTS_SCRIPT = `(() => {
  if (window._highlightCleanupFunctions && window._highlightCleanupFunctions.length) {
    window._highlightCleanupFunctions.forEach(fn => { try { fn(); } catch {} });
    window._highlightCleanupFunctions = [];
  }
  const c = document.getElementById('playwright-highlight-container');
  if (c) c.remove();
})()`;

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
// Static asset detection (shared by trace --exclude-static and network --exclude-static)
// ---------------------------------------------------------------------------

function isStaticAsset(url: string): boolean {
  if (url.includes("/_next/static/")) return true;
  const ext = url.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase();
  return ["js", "css", "png", "jpg", "jpeg", "gif", "svg", "ico", "woff", "woff2", "ttf", "eot", "map"].includes(ext || "");
}

// Trace state is now managed by TabStateManager.traceSession

// ---------------------------------------------------------------------------
// Domain-based tab routing
// ---------------------------------------------------------------------------

/**
 * Check if a tab's URL hostname matches a domain (exact or subdomain).
 */
function matchTabDomain(tabUrl: string, domain: string): boolean {
  try {
    const hostname = new URL(tabUrl).hostname;
    return hostname === domain || hostname.endsWith("." + domain);
  } catch {
    return false;
  }
}

/**
 * Resolve a tab by domain: find an existing tab matching the domain, or
 * create a new one.  Returns the targetId, shortId, and TabState.
 */
async function resolveTabByDomain(
  cdp: CdpConnection,
  domain: string,
): Promise<{ targetId: string; shortId: string; tab: TabState }> {
  // Search existing tabs for a hostname match
  const targets = (await cdp.getTargets()).filter(t => t.type === "page");
  for (const t of targets) {
    if (matchTabDomain(t.url, domain)) {
      await cdp.attachAndEnable(t.id);
      const tabState = cdp.tabManager.getTab(t.id);
      if (tabState) {
        return { targetId: t.id, shortId: tabState.shortId, tab: tabState };
      }
    }
  }

  // No matching tab — create one and wait for initial load
  const created = await cdp.browserCommand<{ targetId: string }>(
    "Target.createTarget",
    { url: `https://${domain}` },
  );
  await cdp.attachAndEnable(created.targetId);

  // Wait for the page to reach a loadable state (DOMContentLoaded or timeout)
  const LOAD_TIMEOUT = 10_000;
  await Promise.race([
    new Promise<void>(resolve => {
      const check = (): void => {
        const tab = cdp.tabManager.getTab(created.targetId);
        // Consider loaded once the TabStateManager has tracked the new target
        if (tab) {
          resolve();
          return;
        }
        setTimeout(check, 200);
      };
      // Give CDP events a tick to propagate the new target
      setTimeout(check, 500);
    }),
    new Promise<void>(resolve => setTimeout(resolve, LOAD_TIMEOUT)),
  ]);

  // Additional settle time for JS-heavy pages
  await new Promise(resolve => setTimeout(resolve, 2000));

  const tabState = cdp.tabManager.getTab(created.targetId);
  if (!tabState) throw new Error(`Failed to create tab for domain: ${domain}`);

  return { targetId: created.targetId, shortId: tabState.shortId, tab: tabState };
}

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
  if (request.method === "tab_new") {
    const url = request.url ?? "about:blank";
    const created = await cdp.browserCommand<{ targetId: string }>(
      "Target.createTarget",
      { url, background: true },
    );
    await cdp.attachAndEnable(created.targetId);
    const newTab = cdp.tabManager.getTab(created.targetId);
    return ok({
      tabId: created.targetId,
      url,
      tab: newTab?.shortId ?? created.targetId.slice(-4).toLowerCase(),
      seq: newTab?.recordAction({ action: 'tab_new', url: url }),
    });
  }

  // eval with domain routing: resolve tab by domain before ensurePageTarget,
  // because there may be no existing tabs yet.
  if (request.method === "eval" && request.domain && tabRef === undefined) {
    if (!request.script) return fail("Missing script parameter");
    try {
      const resolved = await resolveTabByDomain(cdp, request.domain);
      const seq = resolved.tab.recordAction({ action: 'eval', url: request.domain });

      let script = request.script;
      if (request.args !== undefined) {
        const argsJson = JSON.stringify(request.args);
        script = `(async function(){return (${script})(${argsJson});})()`;
      }

      const result = await cdp.evaluate<unknown>(resolved.targetId, script, true);
      return ok({ result, tab: resolved.shortId, seq });
    } catch (error) {
      return fail(error);
    }
  }

  const target = await cdp.ensurePageTarget(
    tabRef !== undefined ? String(tabRef) : undefined,
    { activate: tabRef !== undefined },
  );
  const tab = cdp.tabManager.getTab(target.id);
  if (!tab) throw new Error("Internal error: tab state not found");

  const shortId = tab.shortId;

  switch (request.method) {
    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------
    case "open": {
      if (!request.url) return fail("Missing url parameter");
      const seq = tab.recordAction({ action: 'open', url: request.url });
      if (tabRef === undefined) {
        // No specific tab requested — open in new tab
        const created = await cdp.browserCommand<{ targetId: string }>(
          "Target.createTarget",
          { url: request.url, background: true },
        );
        const newTarget = await cdp.ensurePageTarget(created.targetId);
        const newTab = cdp.tabManager.getTab(newTarget.id);
        return ok({
          url: request.url,
          tabId: newTarget.id,
          tab: newTab?.shortId ?? shortId,
          seq,
        });
      }
      await cdp.pageCommand(target.id, "Page.navigate", { url: request.url });
      tab.refs = {};
      return ok({
        url: request.url,
        title: target.title,
        tabId: target.id,
        tab: shortId,
        seq,
      });
    }

    case "goto": {
      if (!request.url) return fail("Missing url");
      let url = request.url;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
      }
      const seq = tab.recordAction({ action: "goto", url });
      await cdp.pageCommand(target.id, "Page.navigate", { url });
      // Wait briefly for navigation
      await new Promise(r => setTimeout(r, 500));
      tab.refs = {};
      return ok({ tab: shortId, seq, url });
    }

    case "back": {
      const seq = tab.recordAction({ action: 'back' });
      await cdp.evaluate(target.id, "history.back(); undefined");
      return ok({ tab: shortId, seq });
    }

    case "forward": {
      const seq = tab.recordAction({ action: 'forward' });
      await cdp.evaluate(target.id, "history.forward(); undefined");
      return ok({ tab: shortId, seq });
    }

    case "reload": {
      const seq = tab.recordAction({ action: 'reload' });
      await cdp.sessionCommand(target.id, "Page.reload", { ignoreCache: false });
      return ok({ tab: shortId, seq });
    }

    case "close": {
      const seq = tab.recordAction({ action: 'close' });
      await cdp.browserCommand("Target.closeTarget", { targetId: target.id });
      tab.refs = {};
      return ok({ tab: shortId, seq });
    }

    // -----------------------------------------------------------------------
    // Snapshot / observation
    // -----------------------------------------------------------------------
    case "snap": {
      const snapshotData = await buildSnapshot(cdp, target.id, tab, request);
      return ok({
        title: target.title,
        url: target.url,
        snapshotData,
        tab: shortId,
      });
    }

    case "screenshot": {
      await cdp.evaluate(target.id, CLEANUP_HIGHLIGHTS_SCRIPT, true).catch(() => {});
      const result = await cdp.sessionCommand<{ data: string }>(
        target.id,
        "Page.captureScreenshot",
        { format: "png", fromSurface: true },
      );
      const dataDir = path.join(process.env.PINIX_HOME || path.join(os.homedir(), ".pinix"), "data", "browser", "screenshots");
      mkdirSync(dataDir, { recursive: true });
      const filename = `${Date.now()}.png`;
      writeFileSync(path.join(dataDir, filename), Buffer.from(result.data, "base64"));
      const data: Record<string, unknown> = {
        path: `pinix://browser/screenshots/${filename}`,
        tab: shortId,
      };
      if (request.includeBase64) {
        data.dataUrl = `data:image/png;base64,${result.data}`;
      }
      return ok(data);
    }

    // -----------------------------------------------------------------------
    // Element interaction
    // -----------------------------------------------------------------------
    case "click":
    case "hover": {
      if (!request.ref) return fail("Missing ref parameter");
      const refInfo = tab.refs[request.ref];
      const seq = tab.recordAction({
        action: request.method,
        ref: Number(request.ref),
        text: refInfo?.name?.slice(0, 80),
        role: refInfo?.role,
        tag: refInfo?.tagName,
      });
      const backendNodeId = await parseRef(cdp, target.id, tab, request.ref);
      const point = await getInteractablePoint(cdp, target.id, backendNodeId);
      await cdp.sessionCommand(target.id, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: point.x, y: point.y, button: "none",
      });
      if (request.method === "click") {
        await mouseClick(cdp, target.id, point.x, point.y);
      }
      return ok({ tab: shortId, seq });
    }

    case "fill":
    case "type": {
      if (!request.ref) return fail("Missing ref parameter");
      if (request.text == null) return fail("Missing text parameter");
      const fillRefInfo = tab.refs[request.ref];
      const seq = tab.recordAction({
        action: request.method,
        ref: Number(request.ref),
        value: request.text,
        text: fillRefInfo?.name?.slice(0, 80),
        role: fillRefInfo?.role,
        tag: fillRefInfo?.tagName,
      });
      const backendNodeId = await parseRef(cdp, target.id, tab, request.ref);
      await insertTextIntoNode(cdp, target.id, backendNodeId, request.text, request.method === "fill");
      return ok({
        value: request.text,
        tab: shortId,
        seq,
      });
    }

    case "check":
    case "uncheck": {
      if (!request.ref) return fail("Missing ref parameter");
      const seq = tab.recordAction({ action: request.method, ref: Number(request.ref) });
      const desired = request.method === "check";
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
      return ok({ tab: shortId, seq });
    }

    case "select": {
      if (!request.ref || request.value == null) return fail("Missing ref or value parameter");
      const seq = tab.recordAction({ action: 'select', ref: Number(request.ref), value: request.value });
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
      return ok({
        value: request.value,
        tab: shortId,
        seq,
      });
    }

    case "get": {
      if (!request.attribute) return fail("Missing attribute parameter");
      if (request.attribute === "url" && !request.ref) {
        return ok({
          value: await cdp.evaluate<string>(target.id, "location.href", true),
          tab: shortId,
        });
      }
      if (request.attribute === "title" && !request.ref) {
        return ok({
          value: await cdp.evaluate<string>(target.id, "document.title", true),
          tab: shortId,
        });
      }
      if (!request.ref) return fail("Missing ref parameter");
      const value = await getAttributeValue(
        cdp,
        target.id,
        await parseRef(cdp, target.id, tab, request.ref),
        request.attribute,
      );
      return ok({ value, tab: shortId });
    }

    case "press": {
      if (!request.key) return fail("Missing key parameter");
      const seq = tab.recordAction({ action: 'press', key: request.key });
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
      return ok({ tab: shortId, seq });
    }

    case "scroll": {
      const seq = tab.recordAction({ action: 'scroll', direction: request.direction });
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
      return ok({ tab: shortId, seq });
    }

    case "eval": {
      // Note: eval with domain routing (no explicit tab) is handled before
      // ensurePageTarget() above.  This branch handles eval with an explicit
      // tab, or eval without domain.
      if (!request.script) return fail("Missing script parameter");
      const seq = tab.recordAction({ action: 'eval' });

      // If args are provided, wrap the script in an IIFE that receives them.
      let script = request.script;
      if (request.args !== undefined) {
        const argsJson = JSON.stringify(request.args);
        script = `(async function(){return (${script})(${argsJson});})()`;
      }

      const result = await cdp.evaluate<unknown>(target.id, script, true);
      return ok({ result, tab: shortId, seq });
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
      return ok({
        tabs,
        activeIndex: tabs.findIndex((t) => t.active),
      });
    }

    // tab_new is handled before ensurePageTarget() above

    // -----------------------------------------------------------------------
    // Frame navigation
    // -----------------------------------------------------------------------
    case "frame": {
      if (!request.selector) return fail("Missing selector parameter");
      const seq = tab.recordAction({ action: 'frame' });
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
      if (!node.nodeId) return fail(`iframe not found: ${request.selector}`);
      const described = await cdp.pageCommand<{
        node: { frameId?: string; nodeName?: string; attributes?: string[] };
      }>(target.id, "DOM.describeNode", { nodeId: node.nodeId });
      const frameId = described.node.frameId;
      const nodeName = String(described.node.nodeName ?? "").toLowerCase();
      if (!frameId) return fail(`Cannot get iframe frameId: ${request.selector}`);
      if (nodeName && nodeName !== "iframe" && nodeName !== "frame") {
        return fail(`Element is not an iframe: ${nodeName}`);
      }
      tab.activeFrameId = frameId;
      const attributes = described.node.attributes ?? [];
      const attrMap: Record<string, string> = {};
      for (let i = 0; i < attributes.length; i += 2) {
        attrMap[String(attributes[i])] = String(attributes[i + 1] ?? "");
      }
      return ok({
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
      const seq = tab.recordAction({ action: 'frame_main' });
      tab.activeFrameId = null;
      return ok({
        frameInfo: { frameId: 0 },
        tab: shortId,
        seq,
      });
    }

    // -----------------------------------------------------------------------
    // Dialog
    // -----------------------------------------------------------------------
    case "dialog": {
      const seq = tab.recordAction({ action: 'dialog' });
      tab.dialogHandler = {
        accept: request.dialogResponse !== "dismiss",
        ...(request.promptText !== undefined ? { promptText: request.promptText } : {}),
      };
      await cdp.sessionCommand(target.id, "Page.enable");
      return ok({
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
      const subCommand = request.action ?? request.networkCommand ?? "requests";
      switch (subCommand) {
        case "requests": {
          const queryResult = tab.getNetworkRequests({
            since: request.since,
            filter: request.filter,
            method: request.httpMethod,
            status: request.status,
            limit: request.limit,
          });

          let items = queryResult.items;

          // Exclude static assets if requested
          if (request.excludeStatic) {
            items = items.filter(item => !isStaticAsset(item.url));
          }
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

          return ok({
            networkRequests: items,
            tab: shortId,
            cursor: queryResult.cursor,
          });
        }
        case "route":
          return ok({ routeCount: 0, tab: shortId });
        case "unroute":
          return ok({ routeCount: 0, tab: shortId });
        case "clear":
          tab.clearNetwork();
          return ok({ tab: shortId });
        default:
          return fail(`Unknown network subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // Console observation
    // -----------------------------------------------------------------------
    case "console": {
      const subCommand = request.action ?? request.consoleCommand ?? "get";
      switch (subCommand) {
        case "get": {
          const queryResult = tab.getConsoleMessages({
            since: request.since,
            filter: request.filter,
            limit: request.limit,
          });
          return ok({
            consoleMessages: queryResult.items,
            tab: shortId,
            cursor: queryResult.cursor,
          });
        }
        case "clear":
          tab.clearConsole();
          return ok({ tab: shortId });
        default:
          return fail(`Unknown console subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // JS Errors observation
    // -----------------------------------------------------------------------
    case "errors": {
      const subCommand = request.action ?? request.errorsCommand ?? "get";
      switch (subCommand) {
        case "get": {
          const queryResult = tab.getJSErrors({
            since: request.since,
            filter: request.filter,
            limit: request.limit,
          });
          return ok({
            jsErrors: queryResult.items,
            tab: shortId,
            cursor: queryResult.cursor,
          });
        }
        case "clear":
          tab.clearErrors();
          return ok({ tab: shortId });
        default:
          return fail(`Unknown errors subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // Trace
    // -----------------------------------------------------------------------
    case "trace": {
      const subCommand = request.action ?? request.traceCommand ?? "status";
      const tm = cdp.tabManager;
      switch (subCommand) {
        case "start": {
          // Resolve target tab if specified
          let traceTargetId: string | undefined;
          if (tabRef !== undefined) {
            traceTargetId = target.id;
          }
          const session = tm.traceStart(traceTargetId);
          // Enable human action capture on traced tabs
          for (const tid of session.tracedTabs) {
            cdp.enableHumanCapture(tid).catch(() => {});
          }
          const tracedShortIds = Array.from(session.tracedTabs)
            .map(tid => tm.getTabShortId(tid))
            .filter(Boolean) as string[];
          return ok({
            traceStatus: { recording: true, eventCount: 0, tracedTabs: tracedShortIds } satisfies TraceStatus,
            tab: shortId,
          });
        }
        case "stop": {
          const session = tm.traceSession;
          tm.traceStop();
          return ok({
            traceStatus: {
              recording: false,
              eventCount: session?.timeline.length ?? 0,
              tracedTabs: session ? Array.from(session.tracedTabs).map(tid => tm.getTabShortId(tid)).filter(Boolean) as string[] : [],
            } satisfies TraceStatus,
            tab: shortId,
          });
        }
        case "status": {
          const session = tm.traceSession;
          return ok({
            traceStatus: {
              recording: session?.active ?? false,
              eventCount: session?.timeline.length ?? 0,
              tracedTabs: session ? Array.from(session.tracedTabs).map(tid => tm.getTabShortId(tid)).filter(Boolean) as string[] : [],
            } satisfies TraceStatus,
            tab: shortId,
          });
        }
        case "events": {
          const session = tm.traceSession;
          if (!session) return ok({ traceEvents: [], cursor: 0, tab: shortId });

          let events: TraceEntry[] = [...session.timeline];

          // Filter by tab
          if (request.tabId !== undefined) {
            const filterTab = String(request.tabId);
            events = events.filter(e => e.tab === filterTab);
          }

          // Filter by type
          if (request.traceType) {
            events = events.filter(e => e.type === request.traceType);
          }

          // Incremental query (since)
          if (request.since !== undefined) {
            const threshold = typeof request.since === 'number' ? request.since : 0;
            events = events.filter(e => e.seq > threshold);
          }

          // Exclude static assets (both requests and their responses)
          if (request.excludeStatic) {
            const excludedRequestIds = new Set<string>();
            events = events.filter((e: TraceEntry) => {
              if (e.type === "request") {
                if (isStaticAsset(e.url)) {
                  excludedRequestIds.add(e.requestId);
                  return false;
                }
                return true;
              }
              if (e.type === "response") {
                return !excludedRequestIds.has(e.requestId);
              }
              return true;
            });
          }

          // Text/URL filter
          if (request.filter) {
            const f = request.filter.toLowerCase();
            events = events.filter(e => {
              if (e.type === 'request') return e.url.toLowerCase().includes(f);
              if (e.type === 'navigation') return e.url.toLowerCase().includes(f);
              if (e.type === 'action') return (e.text || e.action || '').toLowerCase().includes(f);
              return false;
            });
          }

          // Limit
          if (request.limit !== undefined && request.limit > 0 && events.length > request.limit) {
            events = events.slice(-request.limit);
          }

          const cursor = events.length > 0 ? events[events.length - 1].seq : (typeof request.since === 'number' ? request.since : 0);
          return ok({ traceEvents: events, cursor, tab: shortId });
        }
        case "body": {
          if (!request.requestId) return fail("Missing requestId parameter");
          const session = tm.traceSession;
          if (!session) return fail("No trace session");

          // Find the request entry to get its tab
          const reqEntry = session.timeline.find(
            e => e.type === 'request' && e.requestId === request.requestId,
          );
          if (!reqEntry || reqEntry.type !== 'request') return fail(`Request ${request.requestId} not found in trace`);

          // Resolve the tab's targetId to fetch the body
          const reqTabShortId = reqEntry.tab;
          const reqTargetId = tm.resolveShortId(reqTabShortId);
          if (!reqTargetId) return fail(`Tab ${reqTabShortId} no longer exists`);

          try {
            const body = await cdp.sessionCommand<{ body: string; base64Encoded: boolean }>(
              reqTargetId,
              "Network.getResponseBody",
              { requestId: request.requestId },
            );
            // Also include request body from trace timeline if available
            const traceRequestBody = reqEntry.body;
            return ok({
              traceBody: {
                requestId: request.requestId,
                body: body.body,
                base64Encoded: body.base64Encoded,
                requestBody: traceRequestBody,
              },
              tab: shortId,
            });
          } catch (error) {
            // Even if response body fetch fails, try to return the request body
            const traceRequestBody = reqEntry.body;
            if (traceRequestBody) {
              return ok({
                traceBody: {
                  requestId: request.requestId,
                  body: "",
                  base64Encoded: false,
                  requestBody: traceRequestBody,
                },
                tab: shortId,
              });
            }
            return fail(error);
          }
        }
        default:
          return fail(`Unknown trace subcommand: ${subCommand}`);
      }
    }

    // -----------------------------------------------------------------------
    // Cookies
    // -----------------------------------------------------------------------
    case "cookies": {
      const seq = tab.recordAction({ action: "cookies" });
      const { cookies } = await cdp.sessionCommand<{ cookies: any[] }>(target.id, "Network.getCookies", {});
      let filtered = cookies;
      if (request.filter) {
        const f = request.filter.toLowerCase();
        filtered = cookies.filter((c: any) =>
          c.name.toLowerCase().includes(f) || c.domain.toLowerCase().includes(f)
        );
      }
      return ok({
        tab: shortId,
        seq,
        cookies: filtered.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
        })),
      });
    }

    // -----------------------------------------------------------------------
    // Source search
    // -----------------------------------------------------------------------
    case "source": {
      const subCmd = request.action ?? request.sourceCommand;
      if (subCmd !== "grep") return fail("Unknown source subcommand. Use: source --action grep --pattern <pattern>");
      const pattern = request.pattern ?? request.sourcePattern;
      if (!pattern) return fail("Missing search pattern");

      const seq = tab.recordAction({ action: "source", url: `grep ${pattern}` });

      // Get all frames and their resources
      const { frameTree } = await cdp.sessionCommand<any>(target.id, "Page.getResourceTree", {});

      // Collect all script URLs from the resource tree
      const scripts: { url: string; frameId: string }[] = [];
      function collectScripts(node: any) {
        if (node.resources) {
          for (const r of node.resources) {
            if (r.type === "Script" && r.url && !r.url.startsWith("data:")) {
              scripts.push({ url: r.url, frameId: node.frame.id });
            }
          }
        }
        if (node.childFrames) {
          for (const child of node.childFrames) collectScripts(child);
        }
      }
      collectScripts(frameTree);

      // Search each script
      const sourceResults: { url: string; matches: string[] }[] = [];
      for (const script of scripts) {
        try {
          const { content } = await cdp.sessionCommand<{ content: string }>(
            target.id, "Page.getResourceContent",
            { frameId: script.frameId, url: script.url }
          );
          if (!content) continue;

          // Find all lines containing the pattern
          const regex = new RegExp(pattern, "gi");
          const lines = content.split("\n");
          const matches: string[] = [];
          for (const line of lines) {
            if (regex.test(line)) {
              // Extract a short context around the match (trim to 200 chars)
              const trimmed = line.trim().slice(0, 200);
              matches.push(trimmed);
              regex.lastIndex = 0; // Reset regex state
            }
          }
          if (matches.length > 0) {
            // Shorten URL for display
            const shortUrl = script.url.replace(/^https?:\/\/[^/]+/, "");
            sourceResults.push({ url: shortUrl, matches });
          }
        } catch {
          // Skip scripts that can't be fetched (e.g., cross-origin)
          continue;
        }
      }

      return ok({ tab: shortId, seq, sourceResults });
    }

    // -----------------------------------------------------------------------
    // Site adapters
    // -----------------------------------------------------------------------
    case "site_list": {
      const sites = getAllSites();
      return ok({
        sites: sites.map(s => ({
          name: s.name, description: s.description, domain: s.domain, source: s.source,
        })),
      } as ExtResponseData);
    }

    case "site_info": {
      const name = request.siteName;
      if (!name) return fail("Missing siteName");
      const sites = getAllSites();
      const site = sites.find(s => s.name === name);
      if (!site) return fail(`Site adapter "${name}" not found`);
      return ok({
        name: site.name, description: site.description, domain: site.domain,
        args: site.args, example: site.example, readOnly: site.readOnly,
      } as ExtResponseData);
    }

    case "site_search": {
      const query = (request.query || "").toLowerCase();
      const sites = getAllSites();
      const matches = sites.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.description?.toLowerCase().includes(query) ||
        s.domain?.toLowerCase().includes(query),
      );
      return ok({
        sites: matches.map(s => ({
          name: s.name, description: s.description, domain: s.domain, source: s.source,
        })),
      } as ExtResponseData);
    }

    case "site_run": {
      const name = request.siteName;
      const args = request.siteArgs || {};
      if (!name) return fail("Missing siteName");
      try {
        const result = await executeSiteAdapter(cdp, name, args, request.tabId);
        return ok({
          tab: result.tab,
          result: result.result,
        } as ExtResponseData);
      } catch (error) {
        return fail(error);
      }
    }

    default:
      return fail(`Unknown method: ${request.method}`);
  }
}
