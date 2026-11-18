/**
 * CdpConnection — manages the browser-level WebSocket to Chrome DevTools
 * Protocol. Handles target discovery, auto-attach, session multiplexing,
 * and routes per-target session events to the TabStateManager.
 *
 * Merged from cli/cdp-client.ts (connection management) and
 * cli/cdp-monitor.ts (persistent connection + event listening).
 */

import { request as httpRequest } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket from "ws";
import { browserIdFor, type TraceEvent } from "@ma-browser/shared";
import { TabStateManager } from "./tab-state.js";
import { TRACE_INJECTION_SCRIPT, TRACE_PREFIX } from "./trace-inject.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: string;
  /** Date.now() when the command was sent (for stuck-call diagnostics). */
  startedAt: number;
  /** Leak guard: rejects the command if the browser never answers. */
  timer: ReturnType<typeof setTimeout>;
  /** cdpCallContext token of the dispatch that sent it, if any. */
  owner?: number;
}

/**
 * Async context naming which /command dispatch issued a CDP call (a token from
 * CommandHealth). Lets a timed-out command check whether *its own* CDP calls
 * are still waiting on the browser, without threading an id through dispatch.
 */
export const cdpCallContext = new AsyncLocalStorage<number>();

/**
 * Hard ceiling for a single CDP call. Not a policy timeout (that is the
 * per-action budget in http-server) — it only guarantees a call the browser
 * never answers is eventually rejected and dropped from `pending`, instead of
 * leaking for the rest of a long session.
 */
const CDP_COMMAND_HARD_TIMEOUT_MS = (() => {
  const n = Number(process.env.BB_CDP_COMMAND_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 600_000;
})();

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode ?? 500}: ${raw}`));
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

function connectWebSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const ws = new WebSocket(url);
    const abort = () => { ws.terminate(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    ws.once("open", () => { signal.removeEventListener("abort", abort); resolve(ws); });
    ws.once("error", (err) => { signal.removeEventListener("abort", abort); reject(err); });
    ws.once("close", () => { signal.removeEventListener("abort", abort); reject(new Error("CDP WebSocket closed during handshake")); });
  });
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

// ---------------------------------------------------------------------------
// CdpConnection
// ---------------------------------------------------------------------------

export class CdpConnection {
  private socket: WebSocket | null = null;
  private pending = new Map<number, PendingCommand>();
  private nextId = 1;

  /** targetId -> sessionId (flat-mode) */
  private sessions = new Map<string, string>();
  /** sessionId -> targetId */
  private attachedTargets = new Map<string, string>();

  host: string;
  port: number;
  readonly tabManager: TabStateManager;

  private connectionPromise: Promise<void> | null = null;
  private _connected = false;
  private attempt: AbortController | null = null;
  private ownedTargets = new Set<string>();
  /** Browser-level debugger URL of the currently ready connection. */
  get debuggerUrl(): string | null {
    return this.connected ? this.socket!.url : null;
  }

  /** Last connection error (for diagnostics in 503 responses). */
  lastError: string | null = null;

  /** Chrome version string extracted from /json/version (e.g. "130.0.6723.116"). */
  chromeVersion: string | null = null;

  /** Browser User-Agent string from /json/version (used to distinguish HeadlessChrome vs GUI Chrome). */
  userAgent: string | null = null;

  /** Optional hook notified when a new page target is created (e.g. popup window stealth guard). */
  onPageTargetCreated: ((targetId: string) => void) | null = null;

  /** When true (during a hot-swap restart), suppress removeTab on targetDestroyed/detached so TabState can be rebound. */
  preservingTabsForSwap = false;

  /** Resolvers for commands queued before CDP is ready. */
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  /**
   * Invoked when an established WebSocket drops unexpectedly (e.g. the user
   * closed Chrome). The owner (index.ts) wires this to restart the CDP
   * bring-up loop so the daemon self-heals. Not called on an intentional
   * `disconnect()`.
   */
  onUnexpectedClose: (() => void) | null = null;

  /** True once `disconnect()` was called, to suppress reconnect on shutdown. */
  private intentionallyClosed = false;

  constructor(host: string, port: number, tabManager: TabStateManager, private readonly connectTimeoutMs = 15_000) {
    this.host = host;
    this.port = port;
    this.tabManager = tabManager;
  }

  /** Browser ID for --browser routing: the port for loopback, else host:port. */
  get browserId(): string {
    return browserIdFor(this.host, this.port);
  }

  get connected(): boolean {
    return this._connected && this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Re-point this connection at a new endpoint before a (re)connect attempt.
   * Only valid while disconnected — the background bring-up loop uses this
   * when discovery resolves a different host/port (e.g. a managed browser
   * that came up on a fallback port).
   */
  repoint(host: string, port: number): void {
    this.host = host;
    this.port = port;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to Chrome's browser-level WebSocket endpoint.
   * Idempotent — returns immediately if already connected.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectionPromise) return this.connectionPromise;

    this.intentionallyClosed = false;
    this.lastError = null;
    const attempt = new AbortController();
    this.attempt = attempt;
    const timer = setTimeout(() => attempt.abort(new Error(`CDP connection timed out after ${this.connectTimeoutMs}ms`)), this.connectTimeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), { once: true });
    });
    const promise = (async () => {
      try {
        await Promise.race([this.doConnect(attempt.signal), aborted]);
        if (attempt.signal.aborted) throw attempt.signal.reason;
        this.lastError = null;
      } catch (err) {
        if (this.attempt === attempt) {
          this.lastError = err instanceof Error ? err.message : String(err);
          this.cleanup(new Error(this.lastError));
        }
        throw err;
      } finally {
        clearTimeout(timer);
        if (this.attempt === attempt) this.attempt = null;
      }
    })();
    this.connectionPromise = promise;
    try { await promise; } finally {
      if (this.connectionPromise === promise) this.connectionPromise = null;
    }
  }

  private async doConnect(signal: AbortSignal): Promise<void> {
    const versionData = (await fetchJson(
      `http://${this.host}:${this.port}/json/version`, signal,
    )) as JsonObject;
    signal.throwIfAborted();
    const wsUrl = versionData.webSocketDebuggerUrl;
    if (typeof wsUrl !== "string" || !wsUrl) {
      throw new Error("CDP endpoint missing webSocketDebuggerUrl");
    }

    // Extract Chrome version from "Chrome/130.0.6723.116" Browser string.
    const browser = versionData.Browser ?? versionData.browser;
    if (typeof browser === "string") {
      const m = /Chrome\/([\d.]+)/.exec(browser);
      if (m) this.chromeVersion = m[1];
    }
    const ua = versionData["User-Agent"] ?? versionData.userAgent;
    this.userAgent = typeof ua === "string" ? ua : (typeof browser === "string" ? browser : null);

    const ws = await connectWebSocket(wsUrl, signal);
    if (signal.aborted) { ws.terminate(); throw signal.reason; }
    this.socket = ws;
    this.setupListeners(ws);

    // Discover + auto-attach existing page targets
    await this.browserCommand("Target.setDiscoverTargets", { discover: true });
    const result = await this.browserCommand<{
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
    }>("Target.getTargets");

    signal.throwIfAborted();
    const pages = (result.targetInfos || []).filter((t) => t.type === "page");
    const liveTargets = new Set(pages.map((page) => page.targetId));
    if (!this.preservingTabsForSwap) {
      for (const targetId of this.ownedTargets) {
        if (!liveTargets.has(targetId) && !this.sessions.has(targetId)) {
          this.tabManager.removeTab(targetId);
          this.ownedTargets.delete(targetId);
        }
      }
    }
    for (const page of pages) {
      await this.attachAndEnable(page.targetId).catch(() => {});
      signal.throwIfAborted();
    }
    if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) throw new Error("CDP connection closed during initialization");
    this._connected = true;

    // Notify any waiters that CDP is ready
    for (const waiter of this.readyWaiters) {
      waiter.resolve();
    }
    this.readyWaiters = [];
  }

  /** Wait until CDP connection is established (for two-phase startup). */
  waitUntilReady(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.lastError) return Promise.reject(new Error(this.lastError));
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /** Gracefully close the CDP connection. */
  disconnect(): void {
    // Mark intentional so the ws "close" handler does not trigger self-heal.
    this.intentionallyClosed = true;
    const error = new Error("CDP connection closed");
    this.attempt?.abort(error);
    this.attempt = null;
    this.connectionPromise = null;
    this.cleanup(error);
  }

  private cleanup(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    this._connected = false;
    if (socket) {
      try { socket.terminate(); } catch {}
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.sessions.clear();
    this.attachedTargets.clear();
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters = [];
  }

  // ---------------------------------------------------------------------------
  // WebSocket message handling
  // ---------------------------------------------------------------------------

  private setupListeners(ws: WebSocket): void {
    ws.on("message", (raw) => {
      if (this.socket !== ws) return;
      const message = JSON.parse(raw.toString()) as JsonObject;

      // Response to a browser-level command
      if (typeof message.id === "number") {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) {
          p.reject(
            new Error(
              `${p.method}: ${(message.error as JsonObject).message ?? "Unknown CDP error"}`,
            ),
          );
        } else {
          p.resolve(message.result);
        }
        return;
      }


      // Flat-mode attach
      if (message.method === "Target.attachedToTarget") {
        const params = message.params as JsonObject;
        const sessionId = params.sessionId;
        const targetInfo = params.targetInfo as JsonObject;
        if (typeof sessionId === "string" && typeof targetInfo?.targetId === "string") {
          this.sessions.set(targetInfo.targetId, sessionId);
          this.attachedTargets.set(sessionId, targetInfo.targetId);
        }
        return;
      }

      if (message.method === "Target.detachedFromTarget") {
        const params = message.params as JsonObject;
        const sessionId = params.sessionId;
        if (typeof sessionId === "string") {
          const targetId = this.attachedTargets.get(sessionId);
          if (targetId) {
            this.sessions.delete(targetId);
            this.attachedTargets.delete(sessionId);
            if (!this.preservingTabsForSwap) {
              this.tabManager.removeTab(targetId);
              this.ownedTargets.delete(targetId);
            }
          }
        }
        return;
      }

      // New target auto-attach
      if (message.method === "Target.targetCreated") {
        const params = message.params as JsonObject;
        const targetInfo = params.targetInfo as JsonObject;
        if (targetInfo?.type === "page" && typeof targetInfo.targetId === "string") {
          this.attachAndEnable(targetInfo.targetId).catch(() => {});
          this.onPageTargetCreated?.(targetInfo.targetId);
        }
        return;
      }

      if (message.method === "Target.targetDestroyed") {
        const params = message.params as JsonObject;
        const targetId = params.targetId;
        if (typeof targetId === "string") {
          const sessionId = this.sessions.get(targetId);
          if (sessionId) {
            this.sessions.delete(targetId);
            this.attachedTargets.delete(sessionId);
          }
          if (!this.preservingTabsForSwap) {
            this.tabManager.removeTab(targetId);
            this.ownedTargets.delete(targetId);
          }
        }
        return;
      }

      // Flat protocol: session events carry sessionId directly
      if (typeof message.sessionId === "string" && typeof message.method === "string") {
        const targetId = this.attachedTargets.get(message.sessionId as string);
        if (targetId) {
          this.handleSessionEvent(targetId, message).catch(() => {});
        }
      }
    });

    ws.on("close", () => {
      if (this.socket !== ws) return;
      const wasReady = this._connected;
      this.lastError = "CDP WebSocket closed unexpectedly";
      const error = new Error(this.lastError);
      this.attempt?.abort(error);
      this.cleanup(error);
      if (wasReady && !this.intentionallyClosed) this.onUnexpectedClose?.();
    });

    ws.on("error", () => {});
  }

  // ---------------------------------------------------------------------------
  // Session event routing (network, console, errors, dialog)
  // ---------------------------------------------------------------------------

  private async handleSessionEvent(targetId: string, event: JsonObject): Promise<void> {
    const method = event.method;
    const params = (event.params ?? {}) as JsonObject;
    if (typeof method !== "string") return;

    const tab = this.tabManager.getTab(targetId);
    if (!tab) return;

    // Dialog handling. An open JavaScript dialog blocks the page's renderer
    // thread, so every subsequent CDP command to this target hangs until the
    // dialog is resolved. Always resolve it: use the tab's explicit handler if
    // set, otherwise dismiss (accept:false) — the Playwright-like safe default
    // that unblocks the tab without confirming a destructive action.
    if (method === "Page.javascriptDialogOpening") {
      const handler = tab.dialogHandler ?? { accept: false };
      await this.sessionCommand(targetId, "Page.handleJavaScriptDialog", {
        accept: handler.accept,
        ...(handler.promptText !== undefined
          ? { promptText: handler.promptText }
          : {}),
      }).catch(() => {});
      return;
    }

    // Trace: re-inject event listeners after navigation + record main-frame nav
    if (method === "Page.frameNavigated") {
      if (tab.traceRecording) {
        const frame = params.frame as JsonObject | undefined;
        const isMainFrame = !!frame && !frame.parentId;
        const newUrl = typeof frame?.url === "string" ? frame.url : "";
        this.evaluate(targetId, TRACE_INJECTION_SCRIPT, true).catch(() => {});
        if (isMainFrame && newUrl && !newUrl.startsWith("chrome-error://")) {
          tab.addTraceNavigation(newUrl);
        }
      }
      return;
    }


    // Network events
    if (method === "Network.requestWillBeSent") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const request = params.request as JsonObject | undefined;
      if (!requestId || !request) return;
      tab.addNetworkRequest(requestId, {
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
      tab.updateNetworkResponse(requestId, {
        status: typeof response.status === "number" ? response.status : undefined,
        statusText: typeof response.statusText === "string" ? response.statusText : undefined,
        responseHeaders: normalizeHeaders(response.headers),
        mimeType: typeof response.mimeType === "string" ? response.mimeType : undefined,
      });
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      if (!requestId) return;
      tab.updateNetworkFailure(
        requestId,
        typeof params.errorText === "string" ? params.errorText : "Unknown error",
      );
      return;
    }

    // Console events
    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type ?? "log");
      const args = Array.isArray(params.args) ? (params.args as JsonObject[]) : [];
      const text = args
        .map((arg) => {
          if (typeof arg.value === "string") return arg.value;
          if (arg.value !== undefined) return String(arg.value);
          if (typeof arg.description === "string") return arg.description;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      const stack = params.stackTrace as JsonObject | undefined;
      const firstCallFrame = Array.isArray(stack?.callFrames)
        ? (stack?.callFrames[0] as JsonObject | undefined)
        : undefined;
      // Chrome CDP sends "warning" for console.warn(); normalize it
      const consoleTypeMap: Record<string, string> = { warning: "warn" };
      const normalizedType = consoleTypeMap[type] || type;
      // Trace: intercept console.log fallback from injected listeners
      if (text.startsWith(TRACE_PREFIX) && tab.traceRecording) {
        try {
          const payload = text.slice(TRACE_PREFIX.length);
          const parsed = JSON.parse(payload) as {
            type: string; timestamp: number; url: string;
            ref?: number; xpath?: string; cssSelector?: string;
            value?: string; key?: string; direction?: string;
            pixels?: number; checked?: boolean;
            elementRole?: string; elementName?: string; elementTag?: string;
          };
          const allowedTypes = new Set(["click", "fill", "select", "press", "scroll", "check", "navigation"]);
          if (!parsed || typeof parsed.type !== "string" || !allowedTypes.has(parsed.type)) {
            return;
          }
          const direction = parsed.direction === "up" || parsed.direction === "down" ? parsed.direction : undefined;
          const pickStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
          const pickNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
          const pickBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
          if (parsed.type === "navigation") {
            tab.addTraceNavigation(pickStr(parsed.url) ?? "");
          } else {
            tab.addTraceEvent({
              type: parsed.type as TraceEvent["type"],
              timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
              url: pickStr(parsed.url) ?? "",
              ref: pickNum(parsed.ref),
              xpath: pickStr(parsed.xpath),
              cssSelector: pickStr(parsed.cssSelector),
              value: pickStr(parsed.value),
              key: pickStr(parsed.key),
              direction,
              pixels: pickNum(parsed.pixels),
              checked: pickBool(parsed.checked),
              elementRole: pickStr(parsed.elementRole),
              elementName: pickStr(parsed.elementName),
              elementTag: pickStr(parsed.elementTag),
            });
          }
          return; // Don't add to regular console messages
        } catch {
          // Parse failed — fall through to regular console handler
        }
      }

      tab.addConsoleMessage({
        type: ["log", "info", "warn", "error", "debug"].includes(normalizedType)
          ? (normalizedType as "log" | "info" | "warn" | "error" | "debug")
          : "log",
        text,
        timestamp: Math.round(Number(params.timestamp ?? Date.now())),
        url:
          typeof firstCallFrame?.url === "string" ? firstCallFrame.url : undefined,
        lineNumber:
          typeof firstCallFrame?.lineNumber === "number"
            ? firstCallFrame.lineNumber
            : undefined,
      });
      return;
    }

    // JS Error events
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as JsonObject | undefined;
      if (!details) return;
      const exception = details.exception as JsonObject | undefined;
      const stackTrace = details.stackTrace as JsonObject | undefined;
      const callFrames = Array.isArray(stackTrace?.callFrames)
        ? (stackTrace.callFrames as JsonObject[])
        : [];
      tab.addJSError({
        message:
          typeof exception?.description === "string"
            ? exception.description
            : String(details.text ?? "JavaScript exception"),
        url:
          typeof details.url === "string"
            ? details.url
            : typeof callFrames[0]?.url === "string"
              ? String(callFrames[0].url)
              : undefined,
        lineNumber:
          typeof details.lineNumber === "number" ? details.lineNumber : undefined,
        columnNumber:
          typeof details.columnNumber === "number" ? details.columnNumber : undefined,
        stackTrace:
          callFrames.length > 0
            ? callFrames
                .map(
                  (frame) =>
                    `${String(frame.functionName ?? "<anonymous>")} (${String(frame.url ?? "")}:${String(frame.lineNumber ?? 0)}:${String(frame.columnNumber ?? 0)})`,
                )
                .join("\n")
            : undefined,
        timestamp: Date.now(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Target management
  // ---------------------------------------------------------------------------

  /** Attach to a target and enable required CDP domains. */
  async attachAndEnable(targetId: string): Promise<string> {
    if (this.sessions.has(targetId)) {
      // Already attached — register tab state if not present
      this.ownedTargets.add(targetId);
      this.tabManager.addTab(targetId).browserId = this.browserId;
      return this.sessions.get(targetId)!;
    }

    const socket = this.socket;
    const result = await this.browserCommand<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    if (!socket || this.socket !== socket) throw new Error("CDP connection closed");
    this.ownedTargets.add(targetId);
    this.sessions.set(targetId, result.sessionId);
    this.attachedTargets.set(result.sessionId, targetId);

    // Register in tab state manager
    this.tabManager.addTab(targetId).browserId = this.browserId;

    // Enable domains
    const domains: Array<[string, JsonObject?]> = [
      ["Page.enable"], ["Runtime.enable"],
      ["Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 }],
      ["DOM.enable"], ["Emulation.setFocusEmulationEnabled", { enabled: true }],
    ];
    for (const [method, params] of domains) {
      if (this.socket !== socket) throw new Error("CDP connection closed");
      await this.sessionCommand(targetId, method, params).catch(() => {});
    }
    if (this.socket !== socket) throw new Error("CDP connection closed");

    return result.sessionId;
  }

  /** Get all targets via CDP Target.getTargets. */
  async getTargets(): Promise<CdpTargetInfo[]> {
    const result = await this.browserCommand<{
      targetInfos: Array<{
        targetId: string;
        type: string;
        title: string;
        url: string;
      }>;
    }>("Target.getTargets");

    return (result.targetInfos || []).map((t) => ({
      id: t.targetId,
      type: t.type,
      title: t.title,
      url: t.url,
    }));
  }

  /** Check if a session exists for a given targetId. */
  hasSession(targetId: string): boolean {
    return this.sessions.has(targetId);
  }

  // ---------------------------------------------------------------------------
  // CDP command sending
  // ---------------------------------------------------------------------------

  /** Send a browser-level CDP command. */
  async browserCommand<T = unknown>(method: string, params: JsonObject = {}): Promise<T> {
    if (!this.socket) throw new Error("CDP not connected");
    return this.send<T>(method, params);
  }

  /** Send a session-level CDP command (flat protocol). */
  async sessionCommand<T = unknown>(
    targetId: string,
    method: string,
    params: JsonObject = {},
  ): Promise<T> {
    if (!this.socket) throw new Error("CDP not connected");
    const sessionId =
      this.sessions.get(targetId) ?? (await this.attachAndEnable(targetId));
    return this.send<T>(method, params, sessionId);
  }

  /**
   * Send one CDP command. Browser- and session-level responses are both
   * matched by id in the single `message` listener, so a call that never gets
   * an answer is rejected on socket close (or the hard timeout) instead of
   * leaving a per-call listener attached for the rest of the session.
   */
  private send<T>(method: string, params: JsonObject, sessionId?: string): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("CDP not connected"));
    const id = this.nextId++;
    const payload = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method}: CDP command timed out after ${Math.round(CDP_COMMAND_HARD_TIMEOUT_MS / 1000)}s`));
      }, CDP_COMMAND_HARD_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        startedAt: Date.now(),
        timer,
        owner: cdpCallContext.getStore(),
      });
      try {
        socket.send(payload, (err) => {
          if (!err || !this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(err);
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * In-flight CDP calls (optionally only those issued under `owner`): count
   * plus the oldest one still waiting on the browser. Used to tell "the browser stopped answering" (kind=cdp) apart from
   * daemon-side stalls when a command times out, and surfaced in /status.
   */
  pendingStats(now = Date.now(), owner?: number): { count: number; oldestMethod?: string; oldestAgeMs?: number } {
    let oldest: PendingCommand | undefined;
    let count = 0;
    for (const p of this.pending.values()) {
      if (owner !== undefined && p.owner !== owner) continue;
      count += 1;
      if (!oldest || p.startedAt < oldest.startedAt) oldest = p;
    }
    return oldest
      ? { count, oldestMethod: oldest.method, oldestAgeMs: now - oldest.startedAt }
      : { count: 0 };
  }

  /**
   * Send a page-scoped command. If the tab has an active iframe,
   * the frameId is injected into the params.
   */
  async pageCommand<T = unknown>(
    targetId: string,
    method: string,
    params: JsonObject = {},
  ): Promise<T> {
    const tab = this.tabManager.getTab(targetId);
    const frameId = tab?.activeFrameId;
    return this.sessionCommand<T>(
      targetId,
      method,
      frameId ? { ...params, frameId } : params,
    );
  }

  /** Inject trace event listeners into a page (start recording). */
  async startTraceInjection(targetId: string): Promise<void> {
    // Order matters: set the recording flag BEFORE running the injection script,
    // so that when the script walks frames and copies `__bbBrowserTraceRecording`
    // into each same-origin frame, the value being copied is already `true`.
    await this.evaluate(targetId, "window.__bbBrowserTraceRecording = true", true);
    await this.evaluate(targetId, TRACE_INJECTION_SCRIPT, true);
    // Defensive: force-sync recording state into all accessible frames.
    // Covers (a) frames whose contentWindow was unreadable during initial walk
    // and (b) frames injected by a previous start() with recording=false.
    await this.evaluate(
      targetId,
      `(function(){
        Array.from(document.querySelectorAll('frame, iframe')).forEach(function(el){
          try {
            var fw = el.contentWindow;
            if (fw) fw.__bbBrowserTraceRecording = true;
          } catch(e) {}
        });
      })()`,
      true,
    );
    // Health check: verify the injection actually took effect (e.g. console.log
    // wasn't overridden, no CSP/sandbox blocking the script).
    const injected = await this.evaluate<boolean>(
      targetId,
      "!!window.__bbBrowserTraceInjected",
      true,
    );
    if (!injected) {
      throw new Error(
        "Trace injection failed: __bbBrowserTraceInjected flag not set (page may override console or block script execution)",
      );
    }
  }

  /** Remove trace recording flag from a page (stop recording). */
  async stopTraceInjection(targetId: string): Promise<void> {
    await this.evaluate(
      targetId,
      `window.__bbBrowserTraceRecording = false;
       Array.from(document.querySelectorAll('frame,iframe')).forEach(function(el){
         try{ if(el.contentWindow) el.contentWindow.__bbBrowserTraceRecording=false; }catch(e){}
       });`,
      true,
    );
  }

  /**
   * Evaluate JavaScript expression on a target.
   */
  async evaluate<T>(
    targetId: string,
    expression: string,
    returnByValue = true,
  ): Promise<T> {
    const result = await this.sessionCommand<{
      result: { type?: string; value?: T; objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(targetId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Runtime.evaluate failed",
      );
    }
    return (result.result.value ?? result.result) as T;
  }
}
