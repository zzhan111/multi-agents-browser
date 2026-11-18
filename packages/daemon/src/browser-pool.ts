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
  discoverCdpEndpoints,
  explainCdpFailure,
  inspectCdp,
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

type JsonObject = Record<string, unknown>;

export interface PoolTarget extends CdpTargetInfo {
  browserId: string;
}

export interface BrowserPoolOptions {
  windowDriver?: WindowModeDriver;
  launcher?: (port: number, opts?: LaunchManagedBrowserOptions) => Promise<{ host: string; port: number } | null>;
  platform?: NodeJS.Platform;
  /** Override managed-browser check (for isolated fake-CDP unit tests). */
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
  private readonly forceManaged: boolean;

  private modeSwitchInFlight = false;
  private swapBarrier: Promise<void> | null = null;
  /** Complete admitted commands, including time spent outside CDP and in tab queues. */
  private readonly activeCommands = new Set<Promise<void>>();
  private cachedManagedPid: number | null = null;
  private cachedManagedPort: number | null = null;
  /** Tracks stealth state when running against windowless fake CDP servers in tests. */
  private virtualStealthState: boolean | null = null;
  private stealthSweepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(main: CdpConnection, private readonly store?: StateStore, options: BrowserPoolOptions = {}) {
    this.main = main;
    this.tabManager = main.tabManager;
    this.windowDriver = options.windowDriver ?? windowsStealth;
    this.launcher = options.launcher ?? launchManagedBrowser;
    this.platform = options.platform ?? process.platform;
    this.forceManaged = options.forceManaged ?? false;
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
    this.main.onPageTargetCreated = null;
    for (const c of this.all()) {
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
      this.armStealthPopupGuard(true);
      const pid = await this.resolveManagedPid();
      if (pid) {
        await this.windowDriver.hide(pid).catch(() => {});
      }
    } else {
      this.virtualStealthState = false;
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

  /**
   * Handle `browser_mode` (`status` | `headed` | `headless`).
   * On Windows, switches instantaneously via Win32 window virtualization without
   * restarting Chrome or losing DOM state. Falls back to a daemon-supervised
   * hot-swap (preserving tabs, leases, and short tab IDs) only when migrating
   * out of a native `--headless=new` process or on non-Windows platforms.
   */
  async handleBrowserMode(request: Request, sessions?: SessionManager): Promise<Response> {
    const action = request.modeAction ?? "status";
    if (action === "status") {
      return ok(request.id, { browserMode: await this.getModeStatus() });
    }
    if (action !== "headed" && action !== "headless") {
      return fail(request.id, `无效的浏览器模式：${String(action)}`);
    }
    if (this.modeSwitchInFlight) {
      return fail(request.id, "已有浏览器模式切换请求正在执行，请稍后重试。");
    }
    if (!this.main.connected) {
      return fail(request.id, "受管浏览器尚未连接，请稍后重试。");
    }
    this.modeSwitchInFlight = true;
    try {
      if (!(await this.isMainManaged())) {
        return fail(request.id, "当前默认浏览器不是 ma-browser 受管浏览器，不支持切换有头/无头模式。");
      }
      const current = await this.getModeStatus();
      if (!current.connected || current.mode === null) {
        return fail(request.id, "受管浏览器连接已变化，请稍后重试。");
      }
      const wantNative = Boolean(request.nativeHeadless) || this.platform !== "win32";
      const canStealth = this.platform === "win32" && current.backend === "stealth" && !wantNative;

      if (canStealth) {
        const pid = await this.resolveManagedPid();
        if (current.mode === action) {
          let windowFocused: boolean | undefined;
          let trayRunning = current.trayRunning;
          if (action === "headed" && request.focus && pid) {
            const pages = (await this.main.getTargets().catch(() => [])).filter((t) => t.type === "page");
            if (pages.length === 0) {
              await this.createTarget("about:blank");
            }
            const res = await this.windowDriver.show(pid, true);
            trayRunning = res.trayRunning;
            windowFocused = Boolean(res.focused);
          }
          writePersistedBrowserMode(action);
          return ok(request.id, {
            browserMode: {
              mode: action,
              backend: "stealth",
              connected: true,
              trayRunning,
              changed: false,
              restarted: false,
              ...(windowFocused !== undefined ? { windowFocused } : {}),
            },
          });
        }

        if (action === "headless") {
          this.armStealthPopupGuard(true);
          let trayRunning = current.trayRunning;
          if (pid) {
            const res = await this.windowDriver.hide(pid);
            trayRunning = res.trayRunning;
          }
          this.virtualStealthState = true;
          writePersistedBrowserMode("headless");
          return ok(request.id, {
            browserMode: {
              mode: "headless",
              backend: "stealth",
              connected: true,
              trayRunning,
              changed: true,
              restarted: false,
            },
          });
        }

        // stealth headless -> headed
        this.armStealthPopupGuard(false);
        const pages = (await this.main.getTargets().catch(() => [])).filter((t) => t.type === "page");
        if (pages.length === 0) {
          await this.createTarget("about:blank");
        }
        let trayRunning = current.trayRunning;
        let windowFocused: boolean | undefined;
        if (pid) {
          const res = await this.windowDriver.show(pid, Boolean(request.focus));
          trayRunning = res.trayRunning;
          if (request.focus) windowFocused = Boolean(res.focused);
        }
        this.virtualStealthState = false;
        writePersistedBrowserMode("headed");
        return ok(request.id, {
          browserMode: {
            mode: "headed",
            backend: "stealth",
            connected: true,
            trayRunning,
            changed: true,
            restarted: false,
            ...(windowFocused !== undefined ? { windowFocused } : {}),
          },
        });
      }

      // Fallback path: native `--headless=new` <-> `headed` hot-swap.
      const targetBackend = wantNative && action === "headless" ? "native" : (this.platform === "win32" ? "stealth" : "native");
      if (current.mode === action && current.backend === targetBackend) {
        return ok(request.id, {
          browserMode: {
            mode: action,
            backend: current.backend,
            connected: true,
            trayRunning: current.trayRunning,
            changed: false,
            restarted: false,
          },
        });
      }

      const swapped = await this.hotSwapMainBrowser(
        action,
        targetBackend === "native" && action === "headless",
        Boolean(request.focus),
        sessions,
      );
      return ok(request.id, { browserMode: swapped });
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
      const id = pool.detach(request.browser);
      return ok(request.id, { detached: id, browsers: pool.info() });
    }

    return fail(request.id, `Unknown cdp action: ${request.action}`);
  } catch (err) {
    return fail(request.id, err);
  }
}
