/**
 * BrowserPool — the set of browsers this daemon drives in parallel.
 *
 * `main` is the default browser, owned by the daemon's bring-up loop
 * (explicit endpoint > running managed browser > discovered browser > managed
 * launch). Further browsers join through `cdp_attach` (or `BB_BROWSER_CDP_URLS`
 * / `BB_CDP_DISCOVERY=all`) and reconnect on their own if they drop.
 *
 * All connections share one TabStateManager, so short tab IDs stay globally
 * unique and every tab-scoped call routes to the browser that owns the tab.
 * Calls without a tab go to the caller's current tab's browser, then `main`.
 */

import {
  browserIdFor,
  discoverCdpEndpoints,
  explainCdpFailure,
  inspectCdp,
  isLoopbackHost,
  parseCdpAddress,
  type BrowserInfo,
  type CdpAddress,
  type Request,
  type Response,
  type ResponseData,
} from "@ma-browser/shared";
import { CdpConnection, type CdpTargetInfo } from "./cdp-connection.js";
import type { TabStateManager } from "./tab-state.js";
import type { AgentSession } from "./session-state.js";
import type { StateStore } from "./state-store.js";

/** Attached browsers, re-attached on the next daemon start (e.g. after a tray mode switch). */
const ATTACHED_FILE = "attached-browsers.json";

type JsonObject = Record<string, unknown>;

export interface PoolTarget extends CdpTargetInfo {
  browserId: string;
}

export class BrowserPool {
  readonly main: CdpConnection;
  readonly tabManager: TabStateManager;
  /** Browsers attached beyond `main`, keyed by browser ID. */
  private readonly extra = new Map<string, CdpConnection>();
  /** Per-target serial queue: commands on the same tab run one at a time. */
  private tabQueues = new Map<string, Promise<void>>();

  constructor(main: CdpConnection, private readonly store?: StateStore) {
    this.main = main;
    this.tabManager = main.tabManager;
  }

  /** Browsers attached in a previous daemon run. */
  savedAttachments(): CdpAddress[] {
    return this.store?.read<CdpAddress[]>(ATTACHED_FILE) ?? [];
  }

  private saveAttachments(): void {
    this.store?.write(ATTACHED_FILE, [...this.extra.values()].map((c) => ({ host: c.host, port: c.port })));
  }

  /** Drop a saved attachment that could not be restored. */
  forgetAttachment(addr: CdpAddress): void {
    const id = browserIdFor(addr.host, addr.port);
    this.store?.write(ATTACHED_FILE, this.savedAttachments().filter((a) => browserIdFor(a.host, a.port) !== id));
  }

  private all(): CdpConnection[] {
    return [this.main, ...this.extra.values()];
  }

  /** The browser used when nothing else picks one: `main`, else the first live attached browser. */
  primary(): CdpConnection {
    if (this.main.connected) return this.main;
    return [...this.extra.values()].find((c) => c.connected) ?? this.main;
  }

  get connected(): boolean {
    return this.all().some((c) => c.connected);
  }

  get host(): string { return this.primary().host; }
  get port(): number { return this.primary().port; }
  get lastError(): string | null { return this.primary().lastError; }
  get chromeVersion(): string | null { return this.primary().chromeVersion; }

  /** Resolves once any browser is connected. */
  waitUntilReady(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return Promise.any(this.all().map((c) => c.waitUntilReady())).catch((err: AggregateError) => {
      throw err.errors?.[0] ?? err;
    });
  }

  /** IDs of attached (non-main) browsers, so the bring-up loop never connects `main` to one twice. */
  extraIds(): Set<string> {
    return new Set(this.extra.keys());
  }

  hasLiveExtra(): boolean {
    return [...this.extra.values()].some((c) => c.connected);
  }

  /** Find a browser by ID, port, or address. */
  find(ref: string): CdpConnection | undefined {
    const addr = parseCdpAddress(ref);
    const id = addr ? browserIdFor(addr.host, addr.port) : ref;
    const matches = this.all().filter((c) => c.browserId === id || c.browserId === ref);
    return matches.find((c) => c.connected) ?? matches[0];
  }

  /** A connected browser for `ref`, with a readable error when it isn't usable. */
  resolveBrowser(ref: string): CdpConnection {
    const conn = this.find(ref);
    if (!conn || (conn === this.main && !conn.connected)) {
      const ids = this.info().filter((b) => b.connected).map((b) => b.id);
      throw new Error(`Browser not attached: ${ref}. Attached: ${ids.join(", ") || "none"}. Try: ma-browser cdp attach ${ref}`);
    }
    if (!conn.connected) {
      throw new Error(`Browser ${conn.browserId} is disconnected (${conn.lastError ?? "reconnecting"}); retrying in the background`);
    }
    return conn;
  }

  // ---------------------------------------------------------------------------
  // Targets
  // ---------------------------------------------------------------------------

  /** Targets across connected browsers (primary first), optionally limited to one browser. */
  async getTargets(browser?: string): Promise<PoolTarget[]> {
    const conns = browser ? [this.resolveBrowser(browser)] : this.ordered();
    const lists = await Promise.all(
      conns.map(async (c) => {
        try {
          return (await c.getTargets()).map((t) => ({ ...t, browserId: c.browserId }));
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
  }

  private ordered(): CdpConnection[] {
    const primary = this.primary();
    return [primary, ...this.all().filter((c) => c !== primary)].filter((c) => c.connected);
  }

  /**
   * Resolve a tab reference: short ID, full target ID, or (1-3 digits only) a
   * list index. Short IDs are at least 4 hex chars, so an unknown or stale
   * short ID never falls back to "whatever tab sits at that index".
   */
  findPageTarget<T extends CdpTargetInfo>(targets: T[], ref: string): T | undefined {
    const resolved = this.tabManager.resolveShortId(ref);
    return (resolved ? targets.find((t) => t.id === resolved) : undefined)
      ?? targets.find((t) => t.id === ref)
      ?? (/^\d{1,3}$/.test(ref) ? targets[Number(ref)] : undefined);
  }

  /**
   * Ensure we have a valid page target and return it. Supports resolution by:
   *   - short ID string
   *   - full target ID string
   *   - numeric index
   *   - undefined (use session.currentTargetId or first page)
   *
   * `browser` limits the search to one browser. When `session` is provided,
   * the resolved target is recorded back into session.currentTargetId so each
   * caller maintains its own "current tab".
   */
  async ensurePageTarget(tabRef?: string | number, session?: AgentSession, browser?: string): Promise<PoolTarget> {
    const targets = (await this.getTargets(browser)).filter((t) => t.type === "page");
    if (targets.length === 0) throw new Error(browser ? `No page target found in browser ${browser}` : "No page target found");

    let target: PoolTarget | undefined;

    if (typeof tabRef === "string") {
      target = this.findPageTarget(targets, tabRef);
    } else if (typeof tabRef === "number") {
      target = targets[tabRef];
    } else if (session?.currentTargetId) {
      target = targets.find((t) => t.id === session.currentTargetId);
    }

    if (typeof tabRef === "string" && !target) {
      const known = this.tabManager.getTab(this.tabManager.resolveShortId(tabRef) ?? tabRef);
      const owner = known?.browserId ? this.find(known.browserId) : undefined;
      if (owner && !owner.connected) {
        throw new Error(`Tab ${tabRef} is in browser ${owner.browserId}, which is disconnected (${owner.lastError ?? "reconnecting"})`);
      }
      // A browser that closed gracefully destroyed its tabs first; say which one is down.
      const down = [...this.extra.values()].filter((c) => !c.connected).map((c) => c.browserId);
      throw new Error(`Tab not found: ${tabRef}${down.length ? ` (browser ${down.join(", ")} is disconnected; its tabs are gone)` : ""}`);
    }

    target ??= targets[0];
    if (session) session.currentTargetId = target.id;
    await this.attachAndEnable(target.id);
    return target;
  }

  /** The connection that owns `targetId`. */
  async connFor(targetId: string): Promise<CdpConnection> {
    const attached = this.all().find((c) => c.connected && c.hasSession(targetId));
    if (attached) return attached;
    for (const c of this.ordered()) {
      try {
        if ((await c.getTargets()).some((t) => t.id === targetId)) return c;
      } catch {}
    }
    throw new Error(`Tab not found: ${targetId}`);
  }

  /** Browser for a new tab: explicit `browser`, else the session's current tab's browser, else primary. */
  private browserForNewTab(browser?: string, session?: AgentSession): CdpConnection {
    if (browser) return this.resolveBrowser(browser);
    const current = session?.currentTargetId;
    const owner = current ? this.all().find((c) => c.connected && c.hasSession(current)) : undefined;
    const primary = this.primary();
    if (!owner && !primary.connected) throw new Error("CDP not connected");
    return owner ?? primary;
  }

  /** Open a background tab and attach to it. Returns its targetId. */
  async createTarget(url: string, browser?: string, session?: AgentSession): Promise<string> {
    const conn = this.browserForNewTab(browser, session);
    const created = await conn.browserCommand<{ targetId: string }>("Target.createTarget", { url, background: true });
    await conn.attachAndEnable(created.targetId);
    return created.targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    await (await this.connFor(targetId)).browserCommand("Target.closeTarget", { targetId });
  }

  async attachAndEnable(targetId: string): Promise<string> {
    return (await this.connFor(targetId)).attachAndEnable(targetId);
  }

  async sessionCommand<T = unknown>(targetId: string, method: string, params: JsonObject = {}): Promise<T> {
    return (await this.connFor(targetId)).sessionCommand<T>(targetId, method, params);
  }

  async pageCommand<T = unknown>(targetId: string, method: string, params: JsonObject = {}): Promise<T> {
    return (await this.connFor(targetId)).pageCommand<T>(targetId, method, params);
  }

  async evaluate<T>(targetId: string, expression: string, returnByValue = true): Promise<T> {
    return (await this.connFor(targetId)).evaluate<T>(targetId, expression, returnByValue);
  }

  async startTraceInjection(targetId: string): Promise<void> {
    return (await this.connFor(targetId)).startTraceInjection(targetId);
  }

  async stopTraceInjection(targetId: string): Promise<void> {
    return (await this.connFor(targetId)).stopTraceInjection(targetId);
  }

  /**
   * Run `fn` on the given tab serially. Concurrent calls for the same targetId
   * are queued; calls for different tabs run in parallel.
   *
   * The queue always advances even if a previous item errored, so a single
   * failing command never blocks the tab permanently.
   */
  runOnTab<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tabQueues.get(targetId) ?? Promise.resolve();
    const result = prev.then(() => fn(), () => fn());
    const tail = result.then(() => {}, () => {});
    this.tabQueues.set(targetId, tail);
    tail.then(() => {
      if (this.tabQueues.get(targetId) === tail) {
        this.tabQueues.delete(targetId);
      }
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Attach / detach
  // ---------------------------------------------------------------------------

  /** Attach a browser at `addr`. Returns false if it was already attached. */
  async attach(addr: CdpAddress): Promise<{ id: string; already: boolean }> {
    const id = browserIdFor(addr.host, addr.port);
    const existing = this.find(id);
    if (existing && (existing !== this.main || this.main.connected)) return { id, already: true };

    const ep = await inspectCdp(addr.host, addr.port);
    if (!ep) throw new Error(await explainCdpFailure(addr.host, addr.port));

    const conn = new CdpConnection(ep.host, ep.port, this.tabManager);
    this.extra.set(id, conn);
    try {
      await conn.connect();
    } catch (err) {
      this.extra.delete(id);
      conn.disconnect();
      throw new Error(`Attach to ${id} was interrupted: ${err instanceof Error ? err.message : String(err)}`);
    }
    conn.onUnexpectedClose = () => void this.reconnect(id, conn);
    this.saveAttachments();
    console.error(`[Daemon] Attached browser ${id} (${conn.tabManager.allTabs().filter((t) => t.browserId === id).length} tab(s))`);
    return { id, already: false };
  }

  /** Detach an attached browser. Never closes the browser itself. */
  detach(ref: string): string {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Browser not attached: ${ref}`);
    if (conn === this.main) {
      throw new Error(`Browser ${conn.browserId} is the daemon's default browser and can't be detached; stop the daemon instead`);
    }
    const id = conn.browserId;
    this.extra.delete(id);
    this.saveAttachments();
    conn.disconnect();
    for (const tab of this.tabManager.allTabs()) {
      if (tab.browserId === id) this.tabManager.removeTab(tab.targetId);
    }
    console.error(`[Daemon] Detached browser ${id}`);
    return id;
  }

  /** Reconnect a dropped attached browser with capped backoff until it returns or is detached. */
  private async reconnect(id: string, conn: CdpConnection): Promise<void> {
    console.error(`[Daemon] Attached browser ${id} dropped; reconnecting in the background...`);
    for (let attempt = 0; this.extra.get(id) === conn && !conn.connected; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** Math.min(attempt, 4))));
      if (this.extra.get(id) !== conn) return;
      try {
        await conn.connect();
        console.error(`[Daemon] Attached browser ${id} reconnected`);
        return;
      } catch {}
    }
  }

  info(): BrowserInfo[] {
    const primary = this.primary();
    const tabs = this.tabManager.allTabs();
    return this.all()
      .filter((c) => c !== this.main || c.connected || this.extra.size === 0)
      .map((c) => ({
        id: c.browserId,
        host: c.host,
        port: c.port,
        connected: c.connected,
        default: c === primary,
        origin: c === this.main ? "auto" as const : "attached" as const,
        chromeVersion: c.chromeVersion ?? undefined,
        tabs: tabs.filter((t) => t.browserId === c.browserId).length,
        lastError: c.connected ? undefined : c.lastError ?? undefined,
      }));
  }
}

// ---------------------------------------------------------------------------
// cdp_list / cdp_attach / cdp_detach — need no connected browser
// ---------------------------------------------------------------------------

function allowRemote(request: Request): boolean {
  return request.allowRemote === true || process.env.BB_CDP_ALLOW_REMOTE === "1";
}

async function listBrowsers(pool: BrowserPool): Promise<BrowserInfo[]> {
  const live = pool.info();
  const found = await discoverCdpEndpoints({ thorough: true });
  const rows: BrowserInfo[] = found.map((ep) => {
    const held = live.find((b) => b.id === ep.id);
    return {
      id: ep.id,
      host: ep.host,
      port: ep.port,
      browser: ep.browser,
      managed: ep.managed,
      userDataDir: ep.userDataDir,
      pid: ep.pid,
      tabs: ep.tabs,
      attached: !!held,
      connected: held?.connected ?? false,
      default: held?.default ?? false,
      origin: held?.origin,
    };
  });
  // Attached browsers the scan can't see (remote hosts, or currently down).
  for (const b of live) {
    if (!rows.some((r) => r.id === b.id)) rows.push({ ...b, attached: true });
  }
  return rows;
}

function ok(id: string, data: Record<string, unknown>): Response {
  return { id, success: true, data: data as ResponseData };
}

function fail(id: string, error: unknown): Response {
  return { id, success: false, error: error instanceof Error ? error.message : String(error) };
}

export async function dispatchCdpRequest(pool: BrowserPool, request: Request): Promise<Response> {
  try {
    if (request.action === "cdp_list") {
      return ok(request.id, { browsers: await listBrowsers(pool) });
    }

    if (request.action === "cdp_attach") {
      if (request.all) {
        const found = await discoverCdpEndpoints({ thorough: true });
        if (found.length === 0) {
          return fail(request.id, "No CDP endpoints found on this machine. Start Chrome with --remote-debugging-port=9222 (and a non-default --user-data-dir), then retry");
        }
        const attached: string[] = [];
        const failed: Array<{ id: string; error: string }> = [];
        for (const ep of found) {
          try {
            const r = await pool.attach(ep);
            if (!r.already) attached.push(r.id);
          } catch (err) {
            failed.push({ id: ep.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return ok(request.id, { attached, failed, browsers: pool.info() });
      }
      if (!request.browser) return fail(request.id, "Missing browser: pass a port, host:port or URL, or all");
      const addr = parseCdpAddress(request.browser);
      if (!addr) return fail(request.id, `Invalid CDP address: ${request.browser}`);
      if (!isLoopbackHost(addr.host) && !allowRemote(request)) {
        return fail(request.id, `Refusing non-loopback CDP host ${addr.host}: anyone who can reach that port controls the browser. Pass --allow-remote (or set BB_CDP_ALLOW_REMOTE=1) if you trust it`);
      }
      const r = await pool.attach(addr);
      return ok(request.id, { attached: r.already ? [] : [r.id], already: r.already, browser: r.id, browsers: pool.info() });
    }

    if (request.action === "cdp_detach") {
      if (!request.browser) return fail(request.id, "Missing browser to detach");
      const id = pool.detach(request.browser);
      return ok(request.id, { detached: id, browsers: pool.info() });
    }

    return fail(request.id, `Unknown cdp action: ${request.action}`);
  } catch (err) {
    return fail(request.id, err);
  }
}
