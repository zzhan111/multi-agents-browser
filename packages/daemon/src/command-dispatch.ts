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
  TraceStatus,
} from "@ma-browser/shared";
import { CdpConnection, type CdpTargetInfo } from "./cdp-connection.js";
import type { TabState } from "./tab-state.js";
import type { AgentSession } from "./session-state.js";
import type { BindingStore } from "./binding-store.js";
import type { ScratchpadManager } from "./scratchpad-manager.js";
import {
  listAdapters,
  searchAdapters,
  findAdapter,
  fuzzyAdapterNames,
  updateAdapters,
} from "./site-runner.js";
import { invalidateCatalog } from "./site-catalog.js";
import { createAutoHealer } from "./site-autoheal.js";
import { validateUploadFiles, type FileInputInfo } from "./file-upload.js";
import { buildAdapterScript, matchTabOrigin, type SiteAdapter } from "@ma-browser/shared";

const autoHealer = createAutoHealer();

export interface DispatchContext {
  bindingStore?: BindingStore;
  scratchpadManager?: ScratchpadManager;
}

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

  // `[file accept=".pdf" multiple]` so agents can spot upload targets for `upload`.
  const fileInputTag = (node: RawDomElementNode): string => {
    const attrs = node.attributes || {};
    if (node.tagName.toLowerCase() !== "input" || attrs.type?.toLowerCase() !== "file") return "";
    let tag = " [file";
    if (attrs.accept) tag += ` accept=${JSON.stringify(attrs.accept)}`;
    if ("multiple" in attrs) tag += " multiple";
    return tag + "]";
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
      line += fileInputTag(node);
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
    line += fileInputTag(el);
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
    showHighlightElements: !!request.highlight,
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
// File upload
// ---------------------------------------------------------------------------

// Runs on the targeted element; returns the file input to use, or a string
// describing why there is none.
const FIND_FILE_INPUT_FN = `function() {
  const isFile = (el) => el instanceof HTMLInputElement && el.type === 'file';
  if (isFile(this)) return this;
  if (this instanceof HTMLLabelElement && isFile(this.control)) return this.control;
  for (const root of [this, this.shadowRoot]) {
    const inner = root && root.querySelector && root.querySelector('input[type=file]');
    if (inner) return inner;
  }
  return this instanceof Element ? '<' + this.tagName.toLowerCase() + '>' : String(this);
}`;

// Arms one-shot input/change listeners and reports the input's constraints.
const ARM_FILE_INPUT_FN = `function() {
  const seen = { input: false, change: false };
  this.__maUploadEvents = seen;
  this.addEventListener('input', () => { seen.input = true; }, { once: true, capture: true });
  this.addEventListener('change', () => { seen.change = true; }, { once: true, capture: true });
  return { multiple: this.multiple, accept: this.getAttribute('accept') || '', disabled: this.disabled };
}`;

// Fires input/change only if Chrome did not, then reports the input's files.
const FINISH_FILE_INPUT_FN = `function() {
  const seen = this.__maUploadEvents || { input: false, change: false };
  const fired = { input: seen.input, change: seen.change };
  if (!seen.input) this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  if (!seen.change) this.dispatchEvent(new Event('change', { bubbles: true }));
  delete this.__maUploadEvents;
  const files = Array.from(this.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type }));
  return { files, events: fired };
}`;

async function resolveUploadTarget(
  cdp: CdpConnection,
  targetId: string,
  tab: TabState,
  request: Request,
): Promise<{ objectId: string; label: string }> {
  if (request.ref) {
    const backendNodeId = await parseRef(cdp, targetId, tab, request.ref);
    const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(targetId, "DOM.resolveNode", { backendNodeId });
    return { objectId: resolved.object.objectId, label: `@${request.ref}` };
  }
  const selector = request.selector!;
  const found = await cdp.sessionCommand<{
    result: { objectId?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(targetId, "Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  if (found.exceptionDetails) {
    throw new Error(`Invalid selector ${JSON.stringify(selector)}: ${found.exceptionDetails.exception?.description?.split("\n")[0] ?? found.exceptionDetails.text}`);
  }
  if (!found.result.objectId || found.result.subtype === "null") {
    throw new Error(`No element matches selector ${JSON.stringify(selector)}`);
  }
  return { objectId: found.result.objectId, label: JSON.stringify(selector) };
}

async function uploadFiles(
  cdp: CdpConnection,
  targetId: string,
  tab: TabState,
  request: Request,
): Promise<{ files: string[]; uploadedFiles: Array<{ name: string; size: number; type: string }>; uploadEvents: { input: boolean; change: boolean } }> {
  const callOn = async <T>(objectId: string, functionDeclaration: string, returnByValue: boolean) => {
    const call = await cdp.sessionCommand<{
      result: { value?: T; objectId?: string; type?: string; subtype?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(targetId, "Runtime.callFunctionOn", { objectId, functionDeclaration, returnByValue });
    if (call.exceptionDetails) {
      throw new Error(call.exceptionDetails.exception?.description || call.exceptionDetails.text || "Runtime.callFunctionOn failed");
    }
    return call.result;
  };

  const target = await resolveUploadTarget(cdp, targetId, tab, request);
  const found = await callOn<string>(target.objectId, FIND_FILE_INPUT_FN, false);
  if (found.type === "string" || !found.objectId) {
    throw new Error(
      `${target.label} (${found.value ?? "element"}) is not a file input and contains none. ` +
        "Custom upload widgets often hide the real <input type=file>; target it with a selector such as \"input[type=file]\".",
    );
  }
  const inputId = found.objectId;
  const info = (await callOn<FileInputInfo>(inputId, ARM_FILE_INPUT_FN, true)).value!;
  const files = validateUploadFiles(request.files, info, { force: request.force });
  await cdp.sessionCommand(targetId, "DOM.setFileInputFiles", { files, objectId: inputId });
  const done = (await callOn<{ files: Array<{ name: string; size: number; type: string }>; events: { input: boolean; change: boolean } }>(
    inputId,
    FINISH_FILE_INPUT_FN,
    true,
  )).value!;
  return { files, uploadedFiles: done.files, uploadEvents: done.events };
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

async function getInteractablePoint(
  cdp: CdpConnection,
  targetId: string,
  backendNodeId: number,
): Promise<{ x: number; y: number; covered: boolean }> {
  const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
    targetId,
    "DOM.resolveNode",
    { backendNodeId },
  );
  const call = await cdp.sessionCommand<{
    result: { value?: { x?: number; y?: number; covered?: boolean } };
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
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, covered: !(hit && (hit === this || this.contains(hit))) };
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
  return { x: point.x, y: point.y, covered: point.covered === true };
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
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a command request. This is the core function that handles all
 * browser automation commands via CDP.
 */
// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

/** Commands allowed in read-only scope (observe-only, no browser side effects). */
const READ_ONLY_ALLOWED = new Set([
  "snapshot", "get", "screenshot",
  "network", "console", "errors",
  "tab_list",
  "history",
  "wait",
  // Lease management is exempt: a session must always be able to release or
  // reclaim the tab it holds, regardless of scope.
  "tab_release", "tab_claim",
  // Site adapter discovery is pure catalog reads (no browser side effects).
  // site_run is intentionally excluded — it runs arbitrary adapter JS.
  "site_list", "site_search", "site_info",
]);

/** Returns true if the request involves running JavaScript via Runtime.evaluate. */
function isEvalLike(request: Request): boolean {
  return (
    request.action === "eval" ||
    // site_run executes adapter JS via eval, so it requires eval permission.
    request.action === "site_run" ||
    (request.action === "trace" && request.traceCommand === "start")
  );
}

// ---------------------------------------------------------------------------
// Site adapter execution
// ---------------------------------------------------------------------------

/**
 * Poll a freshly-opened tab until the document is ready (best-effort).
 * Adapters typically fetch the site's own API, which needs the document to
 * exist for the origin's cookies — so "interactive" is sufficient.
 */
async function waitForTabReady(
  cdp: CdpConnection,
  targetId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const rs = await cdp.evaluate<string>(targetId, "document.readyState", false);
      if (rs === "complete" || rs === "interactive") return;
    } catch {
      // target may not be attached yet — retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Execute a site adapter: resolve the adapter + its target tab, run the adapter
 * JS via eval, and normalise the result. The adapter runs in the page context
 * of a tab on the adapter's domain so its fetch() calls carry real cookies.
 *
 * A failed run of a generated news package triggers one automatic heal; when
 * the package was regenerated (site moved or changed) the run is retried once.
 */
async function handleSiteRun(
  cdp: CdpConnection,
  request: Request,
  session?: AgentSession,
  autoHeal = true,
): Promise<Response> {
  const outcome: SiteRunOutcome = {};
  const response = await runSiteAdapter(cdp, request, session, outcome);
  // Only failures of the adapter itself (not bad args or busy tabs) can mean the site changed.
  if (response.success || !autoHeal || !outcome.failedAdapter) return response;
  const healed = await autoHealer.heal(outcome.failedAdapter);
  if (!healed) return response;
  if (healed.status === "healed") {
    invalidateCatalog();
    console.error(`[ma-browser] auto-healed ${request.name}: ${healed.from} → ${healed.to}`);
    return handleSiteRun(cdp, request, session, false);
  }
  const detail = healed.status === "broken" ? `broken — ${healed.reason}` : "package still passes its checks";
  return { ...response, error: `${response.error} [auto-heal: ${detail}]` };
}

interface SiteRunOutcome {
  failedAdapter?: SiteAdapter;
}

async function runSiteAdapter(
  cdp: CdpConnection,
  request: Request,
  session: AgentSession | undefined,
  outcome: SiteRunOutcome,
): Promise<Response> {
  if (!request.name) return fail(request.id, "Missing 'name' parameter for site_run");

  const adapter = findAdapter(request.name);
  if (!adapter) {
    const fuzzy = fuzzyAdapterNames(request.name);
    const hint = fuzzy.length
      ? ` Did you mean: ${fuzzy.join(", ")}?`
      : " Run site_list to see available adapters.";
    return fail(request.id, `Site adapter '${request.name}' not found.${hint}`);
  }

  const prep = buildAdapterScript(adapter, request.args ?? [], request.namedArgs ?? {});
  if ("error" in prep) return fail(request.id, prep.error);

  // Resolve target tab: explicit tabId > domain match > new domain tab > active.
  let targetId: string;
  if (request.tabId !== undefined) {
    targetId = (await cdp.ensurePageTarget(String(request.tabId), session)).id;
  } else if (adapter.domain) {
    const pages = (await cdp.getTargets()).filter((t) => t.type === "page");
    // Skip tabs exclusively held by another session — can't run adapter there.
    const match = pages.find((t) => {
      if (!matchTabOrigin(t.url, adapter.domain)) return false;
      const ts = cdp.tabManager.getTab(t.id);
      return !ts || ts.leaseMode !== "exclusive" || ts.leaseOwner === session?.id;
    });
    if (match) {
      targetId = match.id;
      await cdp.attachAndEnable(targetId);
    } else {
      const created = await cdp.browserCommand<{ targetId: string }>(
        "Target.createTarget",
        // Generated packages record their real base (may be http or carry a port).
        { url: autoHealer.generatedBase(adapter) ?? `https://${adapter.domain}`, background: true },
      );
      targetId = created.targetId;
      await cdp.attachAndEnable(targetId);
      await waitForTabReady(cdp, targetId);
    }
  } else {
    targetId = (await cdp.ensurePageTarget(undefined, session)).id;
  }

  return cdp.runOnTab(targetId, async () => {
    const tab = cdp.tabManager.getTab(targetId);
    // Exclusive-lease enforcement (mirrors the main dispatch path).
    if (
      tab &&
      tab.leaseMode === "exclusive" &&
      tab.leaseOwner &&
      tab.leaseOwner !== session?.id
    ) {
      return fail(request.id, `Tab ${tab.shortId} is exclusively held by another session`);
    }
    tab?.recordAction();

    let raw: unknown;
    try {
      raw = await cdp.evaluate<unknown>(targetId, prep.script, true);
    } catch (e) {
      outcome.failedAdapter = adapter;
      return fail(request.id, `Adapter execution failed: ${buildRequestError(e).message}`);
    }

    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }

    // Adapters signal failure by returning an { error } object.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
      const eo = parsed as { error?: unknown; hint?: unknown };
      const base = String(eo.error ?? "adapter error");
      const hint = eo.hint ? ` (${String(eo.hint)})` : "";
      const login = adapter.domain
        ? ` — make sure you are logged in to ${adapter.domain} in Chrome`
        : "";
      outcome.failedAdapter = adapter;
      return fail(request.id, `${base}${hint}${login}`);
    }

    return ok(request.id, parsed as unknown as ExtResponseData);
  });
}

export async function dispatchRequest(
  cdp: CdpConnection,
  request: Request,
  session?: AgentSession,
  ctx?: DispatchContext,
): Promise<Response> {
  const bindingStore = ctx?.bindingStore;
  const scratchpadManager = ctx?.scratchpadManager;
  // Scope enforcement — fast-fail before any CDP work.
  if (session?.scope === "read-only") {
    if (!READ_ONLY_ALLOWED.has(request.action)) {
      return fail(request.id, `Action '${request.action}' is not allowed in read-only scope`);
    }
  } else if (session?.scope === "no-eval") {
    if (isEvalLike(request)) {
      return fail(request.id, `Action '${request.action}' requires eval permission (session scope: no-eval)`);
    }
  }

  // Resolve target from request.tabId (supports short IDs)
  const tabRef = request.tabId;

  // tab_new and tab_list must work even when there are no existing tabs (or
  // when all open tabs are non-page targets), so handle them before
  // ensurePageTarget() which would throw "No page target found".
  if (request.action === "tab_list") {
    const targets = (await cdp.getTargets()).filter((t) => t.type === "page");
    const tabs = targets.map((t, index) => {
      const tState = cdp.tabManager.getTab(t.id);
      const recentActivity = tState ? scratchpadManager?.getRecent(tState.bbTabId) : undefined;
      return {
        index,
        url: t.url,
        title: t.title,
        active: t.id === session?.currentTargetId || (!session?.currentTargetId && index === 0),
        tabId: t.id,
        tab: tState?.shortId ?? t.id.slice(-4).toLowerCase(),
        owner: tState?.leaseOwner,
        lease: tState?.leaseMode === "exclusive" ? "exclusive" : undefined,
        ...(recentActivity ? { recentActivity } : {}),
      };
    });
    return ok(request.id, {
      tabs,
      activeIndex: tabs.findIndex((t) => t.active),
    });
  }

  if (request.action === "tab_new") {
    const url = request.url ?? "about:blank";
    const created = await cdp.browserCommand<{ targetId: string }>(
      "Target.createTarget",
      { url, background: true },
    );
    await cdp.attachAndEnable(created.targetId);
    if (session) session.currentTargetId = created.targetId;
    const newTab = cdp.tabManager.getTab(created.targetId);
    return ok(request.id, {
      tabId: created.targetId,
      url,
      tab: newTab?.shortId ?? created.targetId.slice(-4).toLowerCase(),
      seq: newTab?.recordAction(),
    });
  }

  // Site adapters. Discovery (list/search/info) needs no page target; site_run
  // resolves/creates its own domain-matched tab, so all are handled before
  // ensurePageTarget() (which would throw when no page exists yet).
  if (request.action === "site_list") {
    return ok(request.id, listAdapters() as unknown as ExtResponseData);
  }
  if (request.action === "site_search") {
    return ok(
      request.id,
      searchAdapters(request.query, request.domain) as unknown as ExtResponseData,
    );
  }
  if (request.action === "site_info") {
    if (!request.name) return fail(request.id, "Missing 'name' parameter for site_info");
    const adapter = findAdapter(request.name);
    if (!adapter) return fail(request.id, `Site adapter '${request.name}' not found`);
    return ok(request.id, adapter as unknown as ExtResponseData);
  }
  if (request.action === "site_run") {
    return handleSiteRun(cdp, request, session);
  }
  if (request.action === "site_update") {
    const result = updateAdapters();
    if ("error" in result) return fail(request.id, `${result.error} — manual fix: ${result.action}`);
    return ok(request.id, result as unknown as ExtResponseData);
  }

  const target = await cdp.ensurePageTarget(
    tabRef !== undefined ? String(tabRef) : undefined,
    session,
  );

  const response = await cdp.runOnTab(target.id, async () => {
  const tab = cdp.tabManager.getTab(target.id);
  if (!tab) throw new Error("Internal error: tab state not found");

  // Exclusive lease enforcement: block non-owners from operating on claimed tabs.
  // tab_release is exempt so the owner can always release.
  if (
    request.action !== "tab_release" &&
    tab.leaseMode === "exclusive" &&
    tab.leaseOwner &&
    tab.leaseOwner !== session?.id
  ) {
    return fail(request.id, `Tab ${tab.shortId} is exclusively held by another session`);
  }

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
        const newTarget = await cdp.ensurePageTarget(created.targetId, session);
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
      const recentActivity = scratchpadManager?.getRecent(tab.bbTabId) ?? undefined;
      return ok(request.id, {
        title: target.title,
        url: target.url,
        snapshotData,
        tab: shortId,
        ...(recentActivity ? { recentActivity } : {}),
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
      return ok(request.id, data);
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
      if (request.action === "hover") {
        await cdp.sessionCommand(target.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: point.x, y: point.y, button: "none",
        });
      } else if (point.covered) {
        // Something sits on top of the element; a real mouse click would land
        // on the overlay, so click the element itself (exactly once).
        const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
          target.id,
          "DOM.resolveNode",
          { backendNodeId },
        );
        await cdp.sessionCommand(target.id, "Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: "function() { this.click(); }",
        });
      } else {
        await mouseClick(cdp, target.id, point.x, point.y);
      }
      const ref = tab.refs[request.ref];
      return ok(request.id, { tab: shortId, seq, role: ref?.role, name: ref?.name });
    }

    case "fill":
    case "type": {
      if (!request.ref) return fail(request.id, "Missing ref parameter");
      if (request.text == null) return fail(request.id, "Missing text parameter");
      const seq = tab.recordAction();
      const backendNodeId = await parseRef(cdp, target.id, tab, request.ref);
      await insertTextIntoNode(cdp, target.id, backendNodeId, request.text, request.action === "fill");
      const ref = tab.refs[request.ref];
      return ok(request.id, {
        value: request.text,
        tab: shortId,
        seq,
        role: ref?.role,
        name: ref?.name,
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
      const priorState = await cdp.sessionCommand<{ result: { value: boolean } }>(target.id, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() { const was = this.checked; this.checked = ${desired}; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return was; }`,
        returnByValue: true,
      });
      const wasChecked = priorState?.result?.value ?? false;
      const ref = tab.refs[request.ref];
      return ok(request.id, {
        tab: shortId,
        seq,
        role: ref?.role,
        name: ref?.name,
        ...(desired ? { wasAlreadyChecked: wasChecked } : { wasAlreadyUnchecked: !wasChecked }),
      });
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
      const labelResult = await cdp.sessionCommand<{ result: { value: string | null } }>(target.id, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() { this.value = ${JSON.stringify(request.value)}; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.options && this.selectedIndex >= 0 ? this.options[this.selectedIndex].text : null; }`,
        returnByValue: true,
      });
      const ref = tab.refs[request.ref];
      return ok(request.id, {
        value: request.value,
        tab: shortId,
        seq,
        role: ref?.role,
        name: ref?.name,
        selectedValue: request.value,
        ...(labelResult?.result?.value != null ? { selectedLabel: labelResult.result.value } : {}),
      });
    }

    case "upload": {
      if (!request.ref && !request.selector) return fail(request.id, "Missing ref or selector parameter");
      const seq = tab.recordAction();
      let result: Awaited<ReturnType<typeof uploadFiles>>;
      // No private timeout: the per-action budget in http-server classifies a
      // hung DOM.setFileInputFiles as kind=cdp and feeds /status health.
      try {
        result = await uploadFiles(cdp, target.id, tab, request);
      } catch (error) {
        // Return a plain error response instead of an HTTP 400 wrapper.
        return fail(request.id, error);
      }
      const ref = request.ref ? tab.refs[request.ref] : undefined;
      return ok(request.id, { tab: shortId, seq, role: ref?.role, name: ref?.name, ...result });
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
    // tab_list and tab_new are handled before ensurePageTarget() above.

    case "tab_select": {
      const targets = (await cdp.getTargets()).filter((t) => t.type === "page");
      let selected: CdpTargetInfo | undefined;

      if (request.tabId !== undefined) {
        selected = cdp.findPageTarget(targets, String(request.tabId));
      } else {
        selected = targets[request.index ?? 0];
      }

      if (!selected) return fail(request.id, "Tab not found");
      if (session) session.currentTargetId = selected.id;
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
        selected = cdp.findPageTarget(targets, String(request.tabId));
      } else {
        selected = targets[request.index ?? 0];
      }

      if (!selected) return fail(request.id, "Tab not found");
      const closedTab = cdp.tabManager.getTab(selected.id);
      const closedShort = closedTab?.shortId;
      await cdp.browserCommand("Target.closeTarget", { targetId: selected.id });
      if (session?.currentTargetId === selected.id) {
        session.currentTargetId = undefined;
      }
      return ok(request.id, {
        tabId: selected.id,
        tab: closedShort,
      });
    }

    // -----------------------------------------------------------------------
    // Tab lease
    // -----------------------------------------------------------------------
    case "tab_claim": {
      tab.leaseOwner = session?.id;
      tab.leaseMode = (request.leaseMode ?? "exclusive") as "shared" | "exclusive";
      if (request.intent && session?.agentId && bindingStore) {
        bindingStore.upsert({
          bbTabId: tab.bbTabId,
          agentId: session.agentId,
          anchorUrl: target.url,
          intent: request.intent,
          claimedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return ok(request.id, { tab: shortId, lease: tab.leaseMode, owner: tab.leaseOwner, bbTabId: tab.bbTabId });
    }

    case "tab_release": {
      if (tab.leaseOwner && tab.leaseOwner !== session?.id) {
        return fail(request.id, `Tab ${shortId} is not claimed by this session`);
      }
      tab.leaseOwner = undefined;
      tab.leaseMode = "shared";
      bindingStore?.remove(tab.bbTabId);
      return ok(request.id, { tab: shortId, released: true });
    }

    case "task_update": {
      if (request.progress == null) return fail(request.id, "Missing progress parameter");
      if (!bindingStore) return fail(request.id, "Binding store not available");
      const updated = bindingStore.updateProgress(tab.bbTabId, request.progress);
      if (!updated) return fail(request.id, `Tab ${shortId} has no persistent binding — claim it with an intent first`);
      return ok(request.id, { tab: shortId, bbTabId: tab.bbTabId, progress: request.progress });
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
          tab.traceRecording = true;
          tab.clearTrace();
          await cdp.startTraceInjection(target.id);
          return ok(request.id, {
            traceStatus: { recording: true, eventCount: 0 } satisfies TraceStatus,
            tab: shortId,
          });
        case "stop": {
          tab.traceRecording = false;
          await cdp.stopTraceInjection(target.id);
          const traceResult = tab.getTraceEvents();
          return ok(request.id, {
            traceEvents: traceResult.items,
            traceStatus: { recording: false, eventCount: traceResult.items.length } satisfies TraceStatus,
            tab: shortId,
          });
        }
        case "status": {
          const count = tab.traceEvents.size;
          return ok(request.id, {
            traceStatus: { recording: tab.traceRecording, eventCount: count } satisfies TraceStatus,
            tab: shortId,
          });
        }
        case "events": {
          const traceResult = tab.getTraceEvents({ since: request.since });
          return ok(request.id, {
            traceEvents: traceResult.items,
            traceStatus: { recording: tab.traceRecording, eventCount: tab.traceEvents.size } satisfies TraceStatus,
            tab: shortId,
            cursor: traceResult.cursor,
          });
        }
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
  }); // end runOnTab

  // Record write actions against the actual tab that was operated on.
  if (scratchpadManager) {
    const tabState = cdp.tabManager.getTab(target.id);
    if (tabState) scratchpadManager.record(tabState.bbTabId, request.action, session?.agentId);
  }
  return response;
}
