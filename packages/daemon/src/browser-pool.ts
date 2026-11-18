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

import path from "node:path";
import {
  browserIdFor,
  currentManagedBrowserDir,
  isManagedDebugger,
  discoverCdpEndpoints,
  explainCdpFailure,
  inspectCdp,
  isIsolatedUserDataDir,
  isLoopbackHost,
  isProcessAlive,
  launchManagedBrowser,
  parseCdpAddress,
  readManagedPid,
  readManagedPort,
  readPersistedBrowserMode,
  resolveInitialBrowserMode,
  windowsStealth,
  writePersistedBrowserMode,
  type BrowserDisplayMode,
  type BrowserInfo,
  type BrowserModeInfo,
  type BrowserWindowModeInfo,
  type CdpAddress,
  type LaunchManagedBrowserOptions,
  type Request,
  type Response,
  type ResponseData,
  type WindowModeDriver,
} from "@ma-browser/shared";
import { CdpConnection, type CdpTargetInfo } from "./cdp-connection.js";
import type { TabStateManager } from "./tab-state.js";
import type { AgentSession, SessionManager } from "./session-state.js";
import type { StateStore } from "./state-store.js";

/** Attached browsers, re-attached on the next daemon start (e.g. after a tray mode switch). */
const ATTACHED_FILE = "attached-browsers.json";

type AttachmentResult = { id: string; already: boolean };
interface Attaching {
  controller: AbortController;
  conn?: CdpConnection;
  result: Promise<AttachmentResult>;
}

type JsonObject = Record<string, unknown>;

export interface PoolTarget extends CdpTargetInfo {
  browserId: string;
}

export interface BrowserPoolOptions {
  windowDriver?: WindowModeDriver;
  launcher?: (port: number, opts?: LaunchManagedBrowserOptions) => Promise<{ host: string; port: number } | null>;
  platform?: NodeJS.Platform;
  /** Do not load, persist or restore other runs' attachments in a pinned daemon. */
  strictCdp?: boolean;
  /** Force `main` to be treated as managed (tests). */
  forceManaged?: boolean;
}

export class BrowserPool {
  readonly main: CdpConnection;
  readonly tabManager: TabStateManager;
  /** Browsers attached beyond `main`, keyed by browser ID. */
  private readonly extra = new Map<string, CdpConnection>();
  /** Per-target serial queue: commands on the same tab run one at a time. */
  private tabQueues = new Map<string, Promise<void>>();
  private readonly windowDriver: WindowModeDriver;
  private readonly launcher: (port: number, opts?: LaunchManagedBrowserOptions) => Promise<{ host: string; port: number } | null>;
  private readonly platform: NodeJS.Platform;
  private readonly strictCdp: boolean;
  private readonly forceManaged: boolean;
  private readonly desired = new Map<string, CdpAddress>();
  private readonly attaching = new Map<string, Attaching>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  private modeSwitchInFlight = false;
  private swapBarrier: Promise<void> | null = null;
  /** Complete admitted commands, including time spent outside CDP and in tab queues. */
  private readonly activeCommands = new Set<Promise<void>>();
  private guardEpoch = 0;
  private stealthSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stealthSweepTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private virtualStealthState: boolean | null = null;
  private readonly virtualStealthStates = new Map<string, boolean>();
  private cachedManagedPid: number | null = null;
  private cachedManagedPort: number | null = null;
  private readonly browserProcessCache = new Map<string, { debuggerUrl: string | null; pid: number | null; userDataDir?: string }>();

  constructor(main: CdpConnection, private readonly store?: StateStore, options: BrowserPoolOptions = {}) {
    this.main = main;
    this.tabManager = main.tabManager;
    this.windowDriver = options.windowDriver ?? windowsStealth;
    this.launcher = options.launcher ?? launchManagedBrowser;
    this.platform = options.platform ?? process.platform;
    this.strictCdp = options.strictCdp ?? false;
    this.forceManaged = options.forceManaged ?? false;
    const saved = this.strictCdp ? [] : store?.read<CdpAddress[]>(ATTACHED_FILE);
    if (Array.isArray(saved)) {
      for (const addr of saved) {
        if (addr && typeof addr.host === "string" && Number.isInteger(addr.port) && addr.port > 0 && addr.port <= 65535) {
          this.desired.set(browserIdFor(addr.host, addr.port), addr);
        }
      }
    }
  }

  /** Try each desired endpoint once now. Offline entries keep retrying until detached. */
  async restoreAttachments(): Promise<void> {
    if (this.strictCdp || this.stopped) return;
    await Promise.all([...this.desired].map(async ([id, addr]) => {
      try { await this.attach(addr); } catch { this.scheduleRetry(id, 0); }
    }));
  }

  private saveAttachments(): void {
    if (!this.strictCdp) this.store?.write(ATTACHED_FILE, [...this.desired.values()]);
  }

  private all(): CdpConnection[] {
    return [this.main, ...this.extra.values()];
  }

  /** The browser used when nothing else picks one: `main`, else the first live attached browser. */
  primary(): CdpConnection {
    if (this.main.connected) return this.main;
    return [...this.extra.values()].find((c) => c.connected) ?? this.main;
  }

  get connectedBrowserCount(): number {
    let count = this.main.connected ? 1 : 0;
    for (const conn of this.extra.values()) if (conn.connected) count++;
    return count;
  }

  get connected(): boolean {
    return this.all().some((c) => c.connected);
  }

  get host(): string { return this.primary().host; }
  get port(): number { return this.primary().port; }
  get lastError(): string | null { return this.primary().lastError; }
  get chromeVersion(): string | null { return this.primary().chromeVersion; }

  /** Aggregate in-flight CDP call stats across all browsers in the pool. */
  pendingStats(now = Date.now(), owner?: number): { count: number; oldestMethod?: string; oldestAgeMs?: number } {
    let count = 0;
    let oldestMethod: string | undefined;
    let oldestAgeMs: number | undefined;
    for (const c of this.all()) {
      const s = c.pendingStats(now, owner);
      count += s.count;
      if (s.oldestAgeMs !== undefined && (oldestAgeMs === undefined || s.oldestAgeMs > oldestAgeMs)) {
        oldestAgeMs = s.oldestAgeMs;
        oldestMethod = s.oldestMethod;
      }
    }
    return oldestMethod !== undefined ? { count, oldestMethod, oldestAgeMs } : { count: 0 };
  }

  /** Disconnect all browsers in the pool (for daemon shutdown). */
  disconnectAll(): void {
    if (this.stealthSweepTimer) {
      clearTimeout(this.stealthSweepTimer);
      this.stealthSweepTimer = null;
    }
    for (const timer of this.stealthSweepTimers.values()) clearTimeout(timer);
    this.stealthSweepTimers.clear();
    for (const c of this.all()) {
      c.onPageTargetCreated = null;
      c.disconnect();
    }
  }

  /**
   * Admit a complete command before it resolves any target IDs. Once a swap
   * closes admission, new commands wait while already admitted commands drain.
   * The check and registration deliberately have no intervening await.
   */
  async runCommand<T>(fn: () => Promise<T>): Promise<T> {
    while (this.swapBarrier) {
      await this.swapBarrier;
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.activeCommands.add(done);
    try {
      return await fn();
    } finally {
      this.activeCommands.delete(done);
      finish();
    }
  }

  private async drainCommands(timeoutMs: number): Promise<void> {
    if (this.activeCommands.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.activeCommands]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("仍有浏览器命令执行中，已取消模式切换，请稍后重试。")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** True while `main` is undergoing a fallback hot-swap restart. */
  isSwapping(): boolean {
    return this.swapBarrier !== null;
  }

  /** Wait for an in-flight fallback hot-swap to complete (no-op if none). */
  async waitForSwap(): Promise<void> {
    if (this.swapBarrier) {
      await this.swapBarrier;
    }
  }

  /** Resolves once any browser is connected (and any hot-swap has finished). */
  async waitUntilReady(): Promise<void> {
    if (this.swapBarrier) {
      await this.swapBarrier;
    }
    if (this.connected) return;
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
    this.armStealthPopupGuardFor(conn, 0, false);
    this.virtualStealthStates.delete(id);
    this.browserProcessCache.delete(id);
    this.extra.delete(id);
    this.saveAttachments();
    conn.disconnect();
    for (const tab of this.tabManager.allTabs()) {
      if (tab.browserId === id) this.tabManager.removeTab(tab.targetId);
    }
    console.error(`[Daemon] Detached browser ${id}`);
    return id;
  }

  /** Restore a stealth-hidden external browser before detaching so it never becomes a lost ghost window. */
  async detachAndRestore(ref: string): Promise<string> {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Browser not attached: ${ref}`);
    if (conn === this.main) {
      throw new Error(`Browser ${conn.browserId} is the daemon's default browser and can't be detached; stop the daemon instead`);
    }
    await this.restoreExternalConnectionIfHidden(conn);
    return this.detach(ref);
  }

  /** Restore any stealth-hidden external (non-managed) browser windows on daemon shutdown. */
  async restoreExternalHiddenWindows(): Promise<void> {
    if (this.platform !== "win32") return;
    const candidates = [this.main, ...this.extra.values()];
    await Promise.all(candidates.map(async (conn) => {
      if (!conn.connected) return;
      if (conn === this.main && (await this.isMainManaged())) return;
      await this.restoreExternalConnectionIfHidden(conn);
    }));
  }

  private async restoreExternalConnectionIfHidden(conn: CdpConnection): Promise<void> {
    if (this.platform !== "win32" || !conn.connected || !isLoopbackHost(conn.host)) return;
    if (await this.isConnectionManaged(conn)) return;
    const proc = await this.resolveExtraProcess(conn);
    if (!proc.pid || !isProcessAlive(proc.pid) || !isIsolatedUserDataDir(proc.userDataDir)) return;
    const trackedHidden = this.virtualStealthStates.get(conn.browserId) === true;
    const winHidden = trackedHidden
      ? true
      : await this.windowDriver.status(proc.pid).then((s) => s.windowCount > 0 && s.stealth).catch(() => false);
    if (winHidden) {
      this.armStealthPopupGuardFor(conn, 0, false);
      await this.windowDriver.show(proc.pid, false).catch(() => {});
      this.virtualStealthStates.set(conn.browserId, false);
    }
  }

  /** Reconnect a dropped attached browser with capped backoff until it returns or is detached. */
  private async reconnect(id: string, conn: CdpConnection): Promise<void> {
    console.error(`[Daemon] Attached browser ${id} dropped; reconnecting in the background...`);
    for (let attempt = 0; this.extra.get(id) === conn && !conn.connected; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** Math.min(attempt, 4))));
      if (this.extra.get(id) !== conn) return;
      try {
        await conn.connect();
        this.browserProcessCache.delete(id);
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

  // ---------------------------------------------------------------------------
  // Managed browser mode (Stealth zero-restart + Hot-swap fallback)
  // ---------------------------------------------------------------------------

  private isNativeHeadlessConnection(): boolean {
    return /\bHeadlessChrome\b/i.test(this.main.userAgent ?? "");
  }

  private async resolveManagedPid(): Promise<number | null> {
    const mPort = readManagedPort();
    if (!isLoopbackHost(this.main.host) || (mPort !== null && mPort !== this.main.port)) {
      this.cachedManagedPid = null;
      this.cachedManagedPort = null;
      return null;
    }

    // A PID file identifies the managed process, not whichever browser `main`
    // happens to drive. Only trust it when the recorded endpoint matches.
    const filePid = mPort === this.main.port ? readManagedPid() : null;
    if (filePid && isProcessAlive(filePid)) {
      this.cachedManagedPid = filePid;
      this.cachedManagedPort = this.main.port;
      return filePid;
    }
    if (this.cachedManagedPort === this.main.port && this.cachedManagedPid && isProcessAlive(this.cachedManagedPid)) {
      return this.cachedManagedPid;
    }
    this.cachedManagedPid = null;
    this.cachedManagedPort = null;
    if (this.platform === "win32" && this.windowDriver.findManagedPid && this.main.connected) {
      const profileDir = path.join(currentManagedBrowserDir(), "profile");
      const found = await this.windowDriver.findManagedPid(this.main.port, profileDir).catch(() => null);
      if (found && isProcessAlive(found)) {
        this.cachedManagedPid = found;
        this.cachedManagedPort = this.main.port;
        return found;
      }
    }
    return null;
  }

  private async isMainManaged(): Promise<boolean> {
    if (this.forceManaged) return true;
    if (!isLoopbackHost(this.main.host)) return false;
    const mPort = readManagedPort();
    if (mPort !== null) return mPort === this.main.port;
    const pid = await this.resolveManagedPid();
    if (pid !== null) return true;
    try {
      const eps = await discoverCdpEndpoints({ ports: [this.main.port], processes: true, thorough: true });
      return eps.some((e) => isLoopbackHost(e.host) && e.port === this.main.port && e.managed);
    } catch {
      return false;
    }
  }

  private isNativeHeadless(conn: CdpConnection): boolean {
    return /\bHeadlessChrome\b/i.test(conn.userAgent ?? "");
  }

  private async isConnectionManaged(conn: CdpConnection): Promise<boolean> {
    if (conn === this.main) return this.isMainManaged();
    return isLoopbackHost(conn.host) && isManagedDebugger(conn.host, conn.port, conn.debuggerUrl);
  }

  private async resolveExtraProcess(conn: CdpConnection): Promise<{ pid: number | null; userDataDir?: string }> {
    if (!conn.connected || !isLoopbackHost(conn.host) || this.platform !== "win32") {
      return { pid: null };
    }
    const cached = this.browserProcessCache.get(conn.browserId);
    if (cached && cached.debuggerUrl === conn.debuggerUrl && cached.pid && isProcessAlive(cached.pid)) {
      return { pid: cached.pid, userDataDir: cached.userDataDir };
    }
    if (!this.windowDriver.findBrowserProcess) {
      return { pid: null };
    }
    const match = await this.windowDriver.findBrowserProcess(conn.port).catch(() => null);
    const result = match && isProcessAlive(match.pid)
      ? { pid: match.pid, userDataDir: match.userDataDir }
      : { pid: null };
    this.browserProcessCache.set(conn.browserId, {
      debuggerUrl: conn.debuggerUrl,
      pid: result.pid,
      userDataDir: result.userDataDir,
    });
    return result;
  }

  private buildBrowserLabel(managed: boolean, userDataDir?: string, origin?: "auto" | "attached"): string {
    if (managed) return "受管";
    if (userDataDir) {
      const base = path.basename(userDataDir.replace(/(?:\|\/)+$/, ""));
      if (base) return base;
    }
    return origin === "auto" ? "外部默认" : "用户";
  }

  private armStealthPopupGuard(enabled: boolean): void {
    if (this.stealthSweepTimer) {
      clearTimeout(this.stealthSweepTimer);
      this.stealthSweepTimer = null;
    }
    if (!enabled || this.platform !== "win32") {
      this.main.onPageTargetCreated = null;
      return;
    }
    this.main.onPageTargetCreated = () => {
      if (this.stealthSweepTimer) return;
      this.stealthSweepTimer = setTimeout(() => {
        this.stealthSweepTimer = null;
        void this.resolveManagedPid().then((pid) => {
          if (pid) void this.windowDriver.hide(pid).catch(() => {});
        });
      }, 80);
      this.stealthSweepTimer.unref?.();
    };
  }

  private armStealthPopupGuardFor(conn: CdpConnection, pid: number, enabled: boolean): void {
    if (conn === this.main) {
      this.armStealthPopupGuard(enabled);
      return;
    }
    const existing = this.stealthSweepTimers.get(conn.browserId);
    if (existing) {
      clearTimeout(existing);
      this.stealthSweepTimers.delete(conn.browserId);
    }
    if (!enabled || this.platform !== "win32" || !pid) {
      conn.onPageTargetCreated = null;
      return;
    }
    conn.onPageTargetCreated = () => {
      if (this.stealthSweepTimers.has(conn.browserId)) return;
      const timer = setTimeout(() => {
        this.stealthSweepTimers.delete(conn.browserId);
        void this.resolveExtraProcess(conn).then((proc) => {
          if (proc.pid && isProcessAlive(proc.pid)) {
            void this.windowDriver.hide(proc.pid).catch(() => {});
          }
        });
      }, 80);
      timer.unref?.();
      this.stealthSweepTimers.set(conn.browserId, timer);
    };
  }

  /**
   * Ensure the managed browser's OS window matches the configured initial mode
   * immediately after connecting (or reconnecting).
   */
  async syncInitialWindowMode(): Promise<void> {
    if (this.platform !== "win32" || !this.main.connected || this.isNativeHeadlessConnection()) {
      this.armStealthPopupGuard(false);
      return;
    }
    if (!(await this.isMainManaged())) return;
    const desired = resolveInitialBrowserMode();
    if (desired.mode === "headless" && !desired.nativeHeadless) {
      this.virtualStealthState = true;
      this.virtualStealthStates.set(this.main.browserId, true);
      this.armStealthPopupGuard(true);
      const pid = await this.resolveManagedPid();
      if (pid) {
        await this.windowDriver.hide(pid).catch(() => {});
      }
    } else {
      this.virtualStealthState = false;
      this.virtualStealthStates.set(this.main.browserId, false);
      this.armStealthPopupGuard(false);
    }
  }

  /** Query the current display mode of the managed browser. */
  async getModeStatus(): Promise<BrowserModeInfo> {
    if (this.main.connected && !(await this.isMainManaged())) {
      const trayRunning = this.platform === "win32"
        ? await this.windowDriver.status(0).then((st) => st.trayRunning).catch(() => false)
        : false;
      return { mode: null, backend: null, connected: true, trayRunning };
    }
    if (this.platform === "win32") {
      if (!this.main.connected) {
        const st = await this.windowDriver.status(0).catch(() => ({ trayRunning: false, windowCount: 0, stealth: false }));
        return { mode: null, backend: null, connected: false, trayRunning: st.trayRunning };
      }
      if (this.isNativeHeadlessConnection()) {
        const st = await this.windowDriver.status(0).catch(() => ({ trayRunning: false, windowCount: 0, stealth: false }));
        return { mode: "headless", backend: "native", connected: true, trayRunning: st.trayRunning };
      }
      const pid = await this.resolveManagedPid();
      const st = await this.windowDriver.status(pid).catch(() => ({ trayRunning: false, windowCount: 0, stealth: false }));
      const isStealth = st.windowCount > 0
        ? st.stealth
        : (this.virtualStealthState ?? readPersistedBrowserMode() === "headless");
      return {
        mode: isStealth ? "headless" : "headed",
        backend: "stealth",
        connected: true,
        trayRunning: st.trayRunning,
      };
    }

    if (!this.main.connected) {
      return { mode: null, backend: null, connected: false, trayRunning: false };
    }
    return {
      mode: this.isNativeHeadlessConnection() ? "headless" : "headed",
      backend: "native",
      connected: true,
      trayRunning: false,
    };
  }

  private async inspectAllBrowserModes(knownTrayRunning?: boolean): Promise<{
    modes: BrowserWindowModeInfo[];
    conns: Map<string, CdpConnection>;
    pids: Map<string, number>;
    trayRunning: boolean;
  }> {
    const primary = this.primary();
    const tabs = this.tabManager.allTabs();
    const list = this.all().filter((c) => c !== this.main || c.connected || this.extra.size === 0);
    const conns = new Map<string, CdpConnection>();
    const pids = new Map<string, number>();

    let trayRunning = knownTrayRunning ?? false;
    if (knownTrayRunning === undefined && this.platform === "win32") {
      trayRunning = await this.windowDriver.status(0).then((s) => s.trayRunning).catch(() => false);
    }

    const meta = await Promise.all(list.map(async (conn) => {
      conns.set(conn.browserId, conn);
      const managed = conn.connected ? await this.isConnectionManaged(conn) : false;
      let pid: number | null = null;
      let userDataDir: string | undefined;
      if (conn.connected && this.platform === "win32" && isLoopbackHost(conn.host) && !this.isNativeHeadless(conn)) {
        if (conn === this.main && managed) {
          pid = await this.resolveManagedPid();
        } else {
          const proc = await this.resolveExtraProcess(conn);
          pid = proc.pid;
          userDataDir = proc.userDataDir;
        }
      }
      return { conn, managed, pid, userDataDir };
    }));

    const pidCounts = new Map<number, number>();
    for (const item of meta) {
      if (item.pid && isProcessAlive(item.pid)) {
        pidCounts.set(item.pid, (pidCounts.get(item.pid) ?? 0) + 1);
      }
    }

    const modes = await Promise.all(meta.map(async ({ conn, managed, pid, userDataDir }): Promise<BrowserWindowModeInfo> => {
      const origin: "auto" | "attached" = conn === this.main ? "auto" : "attached";
      const tabCount = tabs.filter((t) => t.browserId === conn.browserId).length;
      const base = {
        id: conn.browserId,
        host: conn.host,
        port: conn.port,
        managed,
        label: this.buildBrowserLabel(managed, userDataDir, origin),
        tabs: tabCount,
        connected: conn.connected,
        default: conn === primary,
        origin,
        ...(userDataDir ? { userDataDir } : {}),
        ...(pid ? { pid } : {}),
      };

      if (!conn.connected) {
        return { ...base, mode: null, backend: null, canStealth: false, canToggle: false, readonlyReason: "重连中" };
      }
      if (!isLoopbackHost(conn.host)) {
        const native = this.isNativeHeadless(conn);
        return {
          ...base,
          mode: native ? "headless" : "headed",
          backend: native ? "native" : null,
          canStealth: false,
          canToggle: false,
          readonlyReason: "远程浏览器不支持窗口隐身",
        };
      }
      if (this.isNativeHeadless(conn)) {
        const canToggle = conn === this.main && managed;
        return {
          ...base,
          mode: "headless",
          backend: "native",
          canStealth: false,
          canToggle,
          ...(canToggle ? {} : { readonlyReason: "原生无头实例不支持窗口显隐" }),
        };
      }
      if (this.platform !== "win32") {
        const canToggle = conn === this.main && managed;
        return {
          ...base,
          mode: "headed",
          backend: "native",
          canStealth: false,
          canToggle,
          ...(canToggle ? {} : { readonlyReason: "非 Windows 平台不支持接管窗口隐身" }),
        };
      }

      if (conn === this.main && managed) {
        const st = await this.windowDriver.status(pid).catch(() => ({ trayRunning: false, windowCount: 0, stealth: false }));
        trayRunning = trayRunning || st.trayRunning;
        const isStealth = st.windowCount > 0
          ? st.stealth
          : (this.virtualStealthState ?? readPersistedBrowserMode() === "headless");
        if (pid) pids.set(conn.browserId, pid);
        return {
          ...base,
          mode: isStealth ? "headless" : "headed",
          backend: "stealth",
          canStealth: true,
          canToggle: true,
        };
      }

      if (!pid || !isProcessAlive(pid)) {
        return {
          ...base,
          mode: "headed",
          backend: null,
          canStealth: false,
          canToggle: false,
          readonlyReason: "未定位到独立本机浏览器进程，仅支持查看",
        };
      }
      if (!isIsolatedUserDataDir(userDataDir)) {
        return {
          ...base,
          mode: "headed",
          backend: null,
          canStealth: false,
          canToggle: false,
          readonlyReason: "与日常浏览器共用配置目录，仅支持查看，禁止隐藏以免误藏主窗口",
        };
      }
      if ((pidCounts.get(pid) ?? 0) > 1) {
        return {
          ...base,
          mode: "headed",
          backend: null,
          canStealth: false,
          canToggle: false,
          readonlyReason: "与其他窗口共用浏览器进程，仅支持查看",
        };
      }

      const st = await this.windowDriver.status(pid).catch(() => ({ trayRunning: false, windowCount: 0, stealth: false }));
      trayRunning = trayRunning || st.trayRunning;
      const isStealth = st.windowCount > 0
        ? st.stealth
        : (this.virtualStealthStates.get(conn.browserId) ?? false);
      this.virtualStealthStates.set(conn.browserId, isStealth);
      pids.set(conn.browserId, pid);
      return {
        ...base,
        mode: isStealth ? "headless" : "headed",
        backend: "stealth",
        canStealth: true,
        canToggle: true,
      };
    }));

    return { modes, conns, pids, trayRunning };
  }

  private async applyStealthToConnection(
    conn: CdpConnection,
    pid: number | null,
    managed: boolean,
    currentMode: "headed" | "headless" | null,
    action: BrowserDisplayMode,
    focus: boolean,
    knownTrayRunning: boolean,
  ): Promise<BrowserModeInfo> {
    if (currentMode === action) {
      let windowFocused: boolean | undefined;
      let trayRunning = knownTrayRunning;
      if (action === "headed" && focus && pid) {
        const pages = (await conn.getTargets().catch(() => [])).filter((t) => t.type === "page");
        if (pages.length === 0) {
          const created = await conn.browserCommand<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
          await conn.attachAndEnable(created.targetId);
        }
        const res = await this.windowDriver.show(pid, true);
        trayRunning = res.trayRunning;
        windowFocused = Boolean(res.focused);
      }
      if (conn === this.main && managed) {
        writePersistedBrowserMode(action);
      }
      return {
        mode: action,
        backend: "stealth",
        connected: true,
        trayRunning,
        changed: false,
        restarted: false,
        ...(windowFocused !== undefined ? { windowFocused } : {}),
      };
    }

    if (action === "headless") {
      this.armStealthPopupGuardFor(conn, pid ?? 0, true);
      let trayRunning = knownTrayRunning;
      if (pid) {
        const res = await this.windowDriver.hide(pid);
        trayRunning = res.trayRunning;
      }
      this.virtualStealthStates.set(conn.browserId, true);
      if (conn === this.main && managed) {
        this.virtualStealthState = true;
        writePersistedBrowserMode("headless");
      }
      return {
        mode: "headless",
        backend: "stealth",
        connected: true,
        trayRunning,
        changed: true,
        restarted: false,
      };
    }

    // stealth headless -> headed
    this.armStealthPopupGuardFor(conn, pid ?? 0, false);
    const pages = (await conn.getTargets().catch(() => [])).filter((t) => t.type === "page");
    if (pages.length === 0) {
      const created = await conn.browserCommand<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
      await conn.attachAndEnable(created.targetId);
    }
    let trayRunning = knownTrayRunning;
    let windowFocused: boolean | undefined;
    if (pid) {
      const res = await this.windowDriver.show(pid, focus);
      trayRunning = res.trayRunning;
      if (focus) windowFocused = Boolean(res.focused);
    }
    this.virtualStealthStates.set(conn.browserId, false);
    if (conn === this.main && managed) {
      this.virtualStealthState = false;
      writePersistedBrowserMode("headed");
    }
    return {
      mode: "headed",
      backend: "stealth",
      connected: true,
      trayRunning,
      changed: true,
      restarted: false,
      ...(windowFocused !== undefined ? { windowFocused } : {}),
    };
  }

  private async switchManagedMain(
    action: BrowserDisplayMode,
    wantNative: boolean,
    focus: boolean,
    sessions?: SessionManager,
  ): Promise<BrowserModeInfo> {
    const current = await this.getModeStatus();
    if (!current.connected || current.mode === null) {
      throw new Error("受管浏览器连接已变化，请稍后重试。");
    }
    const canStealth = this.platform === "win32" && current.backend === "stealth" && !(wantNative || this.platform !== "win32");
    if (canStealth) {
      const pid = await this.resolveManagedPid();
      return this.applyStealthToConnection(this.main, pid, true, current.mode, action, focus, current.trayRunning);
    }

    const targetBackend = (wantNative || this.platform !== "win32") && action === "headless"
      ? "native"
      : (this.platform === "win32" ? "stealth" : "native");
    if (current.mode === action && current.backend === targetBackend) {
      return {
        mode: action,
        backend: current.backend,
        connected: true,
        trayRunning: current.trayRunning,
        changed: false,
        restarted: false,
      };
    }
    return this.hotSwapMainBrowser(
      action,
      targetBackend === "native" && action === "headless",
      focus,
      sessions,
    );
  }

  /**
   * Handle `browser_mode` (`status` | `headed` | `headless`), targeting either
   * the managed `main` browser (default), a specific browser ID (`request.browser`),
   * or `"all"` controllable local browsers.
   */
  async handleBrowserMode(request: Request, sessions?: SessionManager): Promise<Response> {
    const action = request.modeAction ?? "status";
    const targetRef = request.browser?.trim();

    if (action === "status") {
      const mainStatus = await this.getModeStatus();
      const { modes } = await this.inspectAllBrowserModes(mainStatus.trayRunning);
      if (targetRef && targetRef !== "all") {
        const resolved = this.find(targetRef)?.browserId ?? targetRef;
        const entry = modes.find((m) => m.id === resolved);
        const browserMode: BrowserModeInfo = entry
          ? {
              mode: entry.mode,
              backend: entry.backend,
              connected: entry.connected,
              trayRunning: mainStatus.trayRunning,
            }
          : { mode: null, backend: null, connected: false, trayRunning: mainStatus.trayRunning };
        return ok(request.id, { browserMode, browserModes: modes });
      }
      return ok(request.id, { browserMode: mainStatus, browserModes: modes });
    }

    if (action !== "headed" && action !== "headless") {
      return fail(request.id, `无效的浏览器模式：${String(action)}`);
    }
    if (this.modeSwitchInFlight) {
      return fail(request.id, "已有浏览器模式切换请求正在执行，请稍后重试。");
    }
    if (!targetRef && !this.main.connected) {
      return fail(request.id, "受管浏览器尚未连接，请稍后重试。");
    }

    this.modeSwitchInFlight = true;
    try {
      if (!targetRef) {
        if (!(await this.isMainManaged())) {
          return fail(request.id, "当前默认浏览器不是 ma-browser 受管浏览器，不支持切换有头/无头模式。");
        }
        const browserMode = await this.switchManagedMain(
          action,
          Boolean(request.nativeHeadless),
          Boolean(request.focus),
          sessions,
        );
        const { modes } = await this.inspectAllBrowserModes(browserMode.trayRunning);
        return ok(request.id, { browserMode, browserModes: modes });
      }

      if (targetRef === "all") {
        const { modes, conns, pids, trayRunning: initTray } = await this.inspectAllBrowserModes();
        const controllable = modes.filter((m) => m.connected && m.canToggle);
        if (controllable.length === 0) {
          return fail(request.id, "当前没有可切换窗口显隐的已连接浏览器。");
        }
        const focusTarget = controllable.find((m) => m.default)?.id ?? controllable[controllable.length - 1].id;
        let changed = false;
        let restarted = false;
        let trayRunning = initTray;
        let windowFocused: boolean | undefined;
        let anySucceeded = false;
        const failures: string[] = [];

        for (const entry of controllable) {
          const shouldFocus = Boolean(request.focus) && action === "headed" && entry.id === focusTarget;
          try {
            let res: BrowserModeInfo;
            if (entry.id === this.main.browserId && entry.managed) {
              res = await this.switchManagedMain(action, Boolean(request.nativeHeadless), shouldFocus, sessions);
            } else {
              const conn = conns.get(entry.id);
              const pid = pids.get(entry.id) ?? null;
              if (!conn || !pid) throw new Error(`未定位到浏览器 ${entry.id} 的进程`);
              res = await this.applyStealthToConnection(conn, pid, entry.managed, entry.mode, action, shouldFocus, trayRunning);
            }
            anySucceeded = true;
            changed = changed || Boolean(res.changed);
            restarted = restarted || Boolean(res.restarted);
            trayRunning = trayRunning || res.trayRunning;
            if (res.windowFocused !== undefined) {
              windowFocused = Boolean(windowFocused) || res.windowFocused;
            }
          } catch (err) {
            failures.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (!anySucceeded) {
          return fail(request.id, failures.join("；") || "切换全部浏览器窗口失败。");
        }
        const { modes: updatedModes } = await this.inspectAllBrowserModes(trayRunning);
        if (failures.length > 0) {
          return fail(request.id, `部分浏览器切换失败：${failures.join("；")}`);
        }
        const browserMode: BrowserModeInfo = {
          mode: action,
          backend: "stealth",
          connected: true,
          trayRunning,
          changed,
          restarted,
          ...(windowFocused !== undefined ? { windowFocused } : {}),
        };
        return ok(request.id, { browserMode, browserModes: updatedModes });
      }

      // Specific browser target
      const conn = this.find(targetRef);
      if (!conn) {
        return fail(request.id, `未找到浏览器：${targetRef}`);
      }
      if (!conn.connected) {
        return fail(request.id, `浏览器 ${conn.browserId} 尚未连接，请稍后重试。`);
      }
      const managed = await this.isConnectionManaged(conn);
      if (conn === this.main && managed) {
        const browserMode = await this.switchManagedMain(
          action,
          Boolean(request.nativeHeadless),
          Boolean(request.focus),
          sessions,
        );
        const { modes } = await this.inspectAllBrowserModes(browserMode.trayRunning);
        return ok(request.id, { browserMode, browserModes: modes });
      }

      const { modes, pids, trayRunning } = await this.inspectAllBrowserModes();
      const entry = modes.find((m) => m.id === conn.browserId);
      if (!entry || !entry.canStealth) {
        return fail(request.id, entry?.readonlyReason ?? `浏览器 ${conn.browserId} 不支持窗口显隐控制。`);
      }
      const pid = pids.get(conn.browserId) ?? null;
      const browserMode = await this.applyStealthToConnection(
        conn,
        pid,
        managed,
        entry.mode,
        action,
        Boolean(request.focus),
        trayRunning,
      );
      const { modes: updatedModes } = await this.inspectAllBrowserModes(browserMode.trayRunning);
      return ok(request.id, { browserMode, browserModes: updatedModes });
    } catch (err) {
      return fail(request.id, err);
    } finally {
      this.modeSwitchInFlight = false;
    }
  }

  /**
   * Restart ONLY the managed browser under the live daemon, snapshotting open
   * page URLs, backfilling any tabs dropped by Chrome session restore, and
   * rebinding pre-existing `shortId`s & session cursors to the new targets.
   */
  private async hotSwapMainBrowser(
    targetMode: BrowserDisplayMode,
    useNativeHeadless: boolean,
    focus: boolean,
    sessions?: SessionManager,
  ): Promise<BrowserModeInfo> {
    let releaseBarrier!: () => void;
    this.swapBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const savedOnUnexpectedClose = this.main.onUnexpectedClose;
    this.main.onUnexpectedClose = null;

    try {
      // 1. Admission is closed by swapBarrier. Drain complete commands first:
      // a wait, tab queue or scheduler-admitted dispatch may have no CDP calls.
      // On timeout, leave the browser running instead of invalidating live work.
      const drainDeadline = Date.now() + 3_000;
      await this.drainCommands(Math.max(0, drainDeadline - Date.now()));
      while (this.main.pendingStats().count > 0 && Date.now() < drainDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.main.pendingStats().count > 0) {
        throw new Error("仍有浏览器请求执行中，已取消模式切换，请稍后重试。");
      }

      // 2. Snapshot all live page tabs of `main` so none can be lost.
      const beforePages = (await this.main.getTargets().catch(() => [])).filter((t) => t.type === "page");
      const snapshots = beforePages.map((t) => ({ oldTargetId: t.id, url: t.url }));
      const oldPid = await this.resolveManagedPid();
      const previousPort = this.main.port;

      // 3. Persist target mode and close old browser while preserving TabState entries.
      writePersistedBrowserMode(targetMode);
      this.armStealthPopupGuard(false);
      this.main.preservingTabsForSwap = true;
      await this.main.browserCommand("Browser.close").catch(() => {});
      this.main.disconnect();
      this.cachedManagedPid = null;
      this.cachedManagedPort = null;

      if (oldPid && isProcessAlive(oldPid)) {
        const exitDeadline = Date.now() + 5_000;
        while (isProcessAlive(oldPid) && Date.now() < exitDeadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // 4. Launch replacement managed browser and connect `main`.
      const launched = await this.launcher(previousPort, {
        mode: targetMode,
        nativeHeadless: useNativeHeadless,
        restoreSession: true,
        bypassGrace: true,
      });
      if (!launched) {
        throw new Error("切换后无法启动受管浏览器。");
      }

      this.main.repoint(launched.host, launched.port);
      await this.main.connect();

      // 5. Reconcile restored targets against pre-switch snapshot & rebind shortIds.
      const afterPages = (await this.main.getTargets().catch(() => [])).filter((t) => t.type === "page");
      const unclaimed = [...afterPages];
      const reboundOldIds = new Set<string>();

      const bindPair = (oldId: string, newId: string) => {
        const rebound = this.tabManager.rebindTab(oldId, newId);
        if (rebound) {
          rebound.browserId = this.main.browserId;
        }
        sessions?.remapTarget(oldId, newId);
        reboundOldIds.add(oldId);
      };

      const isBlankLike = (u: string) => !u || u === "about:blank" || u.startsWith("chrome://newtab");

      // Pass 1: exact URL match for non-blank pages.
      const remainingSnaps: typeof snapshots = [];
      for (const snap of snapshots) {
        if (!isBlankLike(snap.url)) {
          const idx = unclaimed.findIndex((t) => t.url === snap.url);
          if (idx >= 0) {
            const [matched] = unclaimed.splice(idx, 1);
            bindPair(snap.oldTargetId, matched.id);
            continue;
          }
        }
        remainingSnaps.push(snap);
      }

      // Pass 2: backfill any non-blank page that Chrome's session restore missed.
      const blankSnaps: typeof snapshots = [];
      for (const snap of remainingSnaps) {
        if (!isBlankLike(snap.url)) {
          const created = await this.main.browserCommand<{ targetId: string }>("Target.createTarget", {
            url: snap.url,
            background: true,
          });
          await this.main.attachAndEnable(created.targetId);
          bindPair(snap.oldTargetId, created.targetId);
        } else {
          blankSnaps.push(snap);
        }
      }

      // Pass 3: restore every blank/newtab, without assigning its logical ID or
      // lease to an unrelated page that happened to be restored by Chrome.
      const blankKey = (url: string) => (url || "about:blank").replace(/\/$/, "");
      for (const snap of blankSnaps) {
        const idx = unclaimed.findIndex((t) => isBlankLike(t.url) && blankKey(t.url) === blankKey(snap.url));
        if (idx >= 0) {
          const [matched] = unclaimed.splice(idx, 1);
          bindPair(snap.oldTargetId, matched.id);
        } else {
          const created = await this.main.browserCommand<{ targetId: string }>("Target.createTarget", {
            url: snap.url || "about:blank",
            background: true,
          });
          await this.main.attachAndEnable(created.targetId);
          bindPair(snap.oldTargetId, created.targetId);
        }
      }

      // Drop any un-rebound stale entries from the previous browser instance.
      for (const snap of snapshots) {
        if (!reboundOldIds.has(snap.oldTargetId)) {
          this.tabManager.removeTab(snap.oldTargetId);
        }
      }

      // 6. Apply Windows stealth/foreground state if applicable.
      let windowFocused: boolean | undefined;
      let trayRunning = false;
      if (this.platform === "win32") {
        const newPid = await this.resolveManagedPid();
        if (targetMode === "headless" && !useNativeHeadless) {
          this.virtualStealthState = true;
          this.armStealthPopupGuard(true);
          if (newPid) {
            const res = await this.windowDriver.hide(newPid);
            trayRunning = res.trayRunning;
          }
        } else {
          this.virtualStealthState = false;
          this.armStealthPopupGuard(false);
          if (newPid && targetMode === "headed") {
            const res = await this.windowDriver.show(newPid, focus);
            trayRunning = res.trayRunning;
            if (focus) windowFocused = Boolean(res.focused);
          } else {
            const st = await this.windowDriver.status(0).catch(() => ({ trayRunning: false, windowCount: 0, stealth: false }));
            trayRunning = st.trayRunning;
          }
        }
      }

      const finalBackend = useNativeHeadless ? "native" : (this.platform === "win32" ? "stealth" : "native");
      return {
        mode: targetMode,
        backend: finalBackend,
        connected: true,
        trayRunning,
        changed: true,
        restarted: true,
        ...(windowFocused !== undefined ? { windowFocused } : {}),
      };
    } finally {
      this.main.preservingTabsForSwap = false;
      this.main.onUnexpectedClose = savedOnUnexpectedClose;
      this.swapBarrier = null;
      releaseBarrier();
      if (!this.main.connected && savedOnUnexpectedClose) {
        savedOnUnexpectedClose();
      }
    }
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
      const id = await pool.detachAndRestore(request.browser);
      return ok(request.id, { detached: id, browsers: pool.info() });
    }

    return fail(request.id, `Unknown cdp action: ${request.action}`);
  } catch (err) {
    return fail(request.id, err);
  }
}
