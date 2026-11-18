/**
 * Contract tests for daemon-managed browser mode switching:
 *   1. Windows Stealth mode: zero-restart instant toggle (`restarted: false`),
 *      preserving CDP socket, DOM state, short tab IDs, leases, and `seq`.
 *   2. Fallback Hot-Swap mode (e.g. migrating out of a native `--headless=new`
 *      browser): daemon stays alive, missing CDP background tabs are backfilled,
 *      existing `--tab <shortId>` and `tab_claim` leases survive across the
 *      browser restart, and concurrent commands wait on the swap barrier.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WindowModeDriver } from "@ma-browser/shared";
import { BrowserPool } from "../browser-pool.js";
import { CdpConnection } from "../cdp-connection.js";
import { HttpServer } from "../http-server.js";
import { TabStateManager } from "../tab-state.js";

type Json = Record<string, unknown>;

interface FakeTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface FakeCdpHandle {
  port: number;
  targets: FakeTarget[];
  createdUrls: string[];
  browserClosedCount: number;
  requests: Array<{ method: string; expression?: string; targetId?: string }>;
  close: () => Promise<void>;
}

function startFakeBrowser(opts: {
  userAgent: string;
  initialTargets: FakeTarget[];
}): Promise<FakeCdpHandle> {
  return new Promise((resolve) => {
    const targets: FakeTarget[] = opts.initialTargets.map((t) => ({ ...t }));
    const createdUrls: string[] = [];
    const requests: FakeCdpHandle["requests"] = [];
    const sessions = new Map<string, string>();
    let browserClosedCount = 0;
    let nextTargetSeq = 1;
    let nextSessionSeq = 1;

    const server: Server = createServer((_req, res) => {
      const { port } = server.address() as AddressInfo;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          Browser: opts.userAgent,
          "User-Agent": opts.userAgent,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        }),
      );
    });

    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Json;
        requests.push({
          method: String(msg.method),
          expression: (msg.params as Json)?.expression as string | undefined,
          targetId: sessions.get(String(msg.sessionId)),
        });
        const reply = (result: Json) =>
          ws.send(
            JSON.stringify({
              id: msg.id,
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
              result,
            }),
          );

        switch (msg.method) {
          case "Target.getTargets":
            return reply({ targetInfos: targets });
          case "Target.attachToTarget": {
            const sessionId = `S_${nextSessionSeq++}`;
            sessions.set(sessionId, String((msg.params as Json).targetId));
            return reply({ sessionId });
          }
          case "Target.createTarget": {
            const url = String((msg.params as Json)?.url ?? "about:blank");
            const targetId = `CREATED_${nextTargetSeq++}_${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
            createdUrls.push(url);
            targets.push({ targetId, type: "page", title: url, url });
            return reply({ targetId });
          }
          case "Browser.close": {
            browserClosedCount += 1;
            // Emit targetDestroyed like real Chrome does during shutdown!
            for (const t of targets) {
              ws.send(JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: t.targetId } }));
            }
            reply({});
            setTimeout(() => {
              try { ws.close(); } catch {}
            }, 10);
            return;
          }
          case "Runtime.evaluate": {
            const expr = String((msg.params as Json)?.expression ?? "");
            const target = targets.find((t) => t.targetId === sessions.get(String(msg.sessionId)));
            return reply({ result: { type: "string", value: expr === "location.href" ? target?.url : `eval:${expr}` } });
          }
          default:
            return reply({});
        }
      });
    });

    const close = async () => {
      for (const client of wss.clients) {
        try { client.terminate(); } catch {}
      }
      await new Promise<void>((r) => wss.close(() => r()));
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    };

    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        get targets() { return targets; },
        get createdUrls() { return createdUrls; },
        get browserClosedCount() { return browserClosedCount; },
        requests,
        close,
      });
    });
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function page(targetId: string, url: string): FakeTarget {
  return { targetId, type: "page", title: url, url };
}

const windowDriver: WindowModeDriver = {
  async status() { return { trayRunning: true, windowCount: 1, stealth: false }; },
  async hide() { return { trayRunning: true, affectedCount: 1 }; },
  async show() { return { trayRunning: true, affectedCount: 1 }; },
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("Daemon browser_mode: stealth zero-restart & hot-swap continuity", () => {
  const savedHome = process.env.BB_BROWSER_HOME;
  const savedDiscovery = process.env.BB_CDP_DISCOVERY;
  const savedNoLaunch = process.env.MA_BROWSER_NO_LAUNCH;
  let testHome = "";

  before(() => {
    const scratch = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), ".alma");
    mkdirSync(scratch, { recursive: true });
    testHome = mkdtempSync(join(scratch, "ma-daemon-mode-"));
    process.env.BB_BROWSER_HOME = testHome;
    process.env.BB_CDP_DISCOVERY = "0";
    process.env.MA_BROWSER_NO_LAUNCH = "1";
  });

  after(() => {
    if (savedHome === undefined) delete process.env.BB_BROWSER_HOME;
    else process.env.BB_BROWSER_HOME = savedHome;
    if (savedDiscovery === undefined) delete process.env.BB_CDP_DISCOVERY;
    else process.env.BB_CDP_DISCOVERY = savedDiscovery;
    if (savedNoLaunch === undefined) delete process.env.MA_BROWSER_NO_LAUNCH;
    else process.env.MA_BROWSER_NO_LAUNCH = savedNoLaunch;
    rmSync(testHome, { recursive: true, force: true });
  });

  async function fixture(opts: {
    targets?: FakeTarget[];
    restored?: FakeTarget[];
    forceManaged?: boolean;
    native?: boolean;
    driver?: WindowModeDriver;
    launchGate?: ReturnType<typeof deferred>;
  } = {}) {
    const browserDir = join(testHome, "browser");
    mkdirSync(browserDir, { recursive: true });
    const original = opts.targets ?? [page("OLD_A111", "https://app.example.com/a")];
    const oldBrowser = await startFakeBrowser({
      userAgent: opts.native ? "HeadlessChrome/131" : "Chrome/131",
      initialTargets: original,
    });
    writeFileSync(join(browserDir, "browser-pid"), String(process.pid));
    writeFileSync(join(browserDir, "cdp-port"), String(oldBrowser.port));
    const replacements: FakeCdpHandle[] = [];
    const tabManager = new TabStateManager();
    const cdp = new CdpConnection("127.0.0.1", oldBrowser.port, tabManager);
    const pool = new BrowserPool(cdp, undefined, {
      platform: "win32",
      forceManaged: opts.forceManaged ?? true,
      windowDriver: opts.driver ?? windowDriver,
      launcher: async () => {
        await opts.launchGate?.promise;
        const replacement = await startFakeBrowser({
          userAgent: "Chrome/131",
          initialTargets: opts.restored ?? original.map((t, i) => ({ ...t, targetId: `NEW_${9000 + i}` })),
        });
        replacements.push(replacement);
        writeFileSync(join(browserDir, "cdp-port"), String(replacement.port));
        return { host: "127.0.0.1", port: replacement.port };
      },
    });
    const port = await freePort();
    const http = new HttpServer({ host: "127.0.0.1", port, token: "fixture", cdp: pool });
    await http.start();
    await cdp.connect();
    const post = async (body: Json, session = "agent-1") => {
      const response = await fetch(`http://127.0.0.1:${port}/command`, {
        method: "POST",
        headers: { Authorization: "Bearer fixture", "Content-Type": "application/json", "X-BB-Session": session },
        body: JSON.stringify({ id: `test-${Math.random()}`, ...body }),
      });
      return await response.json() as { success: boolean; data?: Json; error?: string };
    };
    const scheduler = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: "Bearer fixture" } });
      return (await response.json() as { scheduler: { globalInFlight: number; queueDepth: number } }).scheduler;
    };
    return {
      oldBrowser, replacements, pool, cdp, tabManager, post, scheduler, browserDir,
      async close() {
        opts.launchGate?.release();
        pool.disconnectAll();
        await http.stop();
        await oldBrowser.close();
        for (const replacement of replacements) await replacement.close();
      },
    };
  }

  for (const mismatch of ["different managed port", "remote host with same port"] as const) {
    it(`Rejects external main with ${mismatch} despite a live managed PID`, async () => {
      let hideCalls = 0;
      let showCalls = 0;
      const f = await fixture({ forceManaged: false, driver: {
        ...windowDriver,
        async hide(pid) { hideCalls++; return windowDriver.hide(pid); },
        async show(pid, focus) { showCalls++; return windowDriver.show(pid, focus); },
      } });
      const managedA = await startFakeBrowser({ userAgent: "Chrome/131", initialTargets: [] });
      try {
        if (mismatch === "different managed port") {
          writeFileSync(join(f.browserDir, "cdp-port"), String(managedA.port));
        } else {
          // Keep the fake local WebSocket; change only the public endpoint identity.
          f.cdp.host = "192.0.2.1";
        }
        const rejected = await f.post({ action: "browser_mode", modeAction: "headless" });
        assert.equal(rejected.success, false, JSON.stringify(rejected));
        const headed = await f.post({ action: "browser_mode", modeAction: "headed", focus: true });
        assert.equal(headed.success, false, JSON.stringify(headed));
        assert.equal(hideCalls, 0);
        assert.equal(showCalls, 0);
        assert.equal(f.oldBrowser.browserClosedCount, 0);
        assert.equal(managedA.browserClosedCount, 0);
        const status = await f.post({ action: "browser_mode", modeAction: "status" });
        assert.equal(status.success, true);
        const mode = status.data?.browserMode as Json;
        assert.equal(mode.mode, null);
        assert.equal(mode.backend, null);
      } finally {
        await f.close();
        await managedA.close();
      }
    });
  }

  it("Serializes mode requests before asynchronous ownership checks and releases the lock after rejection", async () => {
    const f = await fixture();
    const gate = deferred();
    let calls = 0;
    // Isolate the private ownership seam so no real process discovery runs.
    const ownership = f.pool as unknown as { isMainManaged(): Promise<boolean> };
    const original = ownership.isMainManaged;
    ownership.isMainManaged = async () => { calls++; await gate.promise; return false; };
    let first: ReturnType<typeof f.post> | undefined;
    let second: ReturnType<typeof f.post> | undefined;
    try {
      first = f.post({ action: "browser_mode", modeAction: "headless" });
      await eventually(() => calls === 1, "first request must reach ownership check");
      let secondResult: Awaited<ReturnType<typeof f.post>> | undefined;
      second = f.post({ action: "browser_mode", modeAction: "headed" }).then((r) => { secondResult = r; return r; });
      await eventually(() => secondResult !== undefined, "second request must reject without awaiting ownership gate");
      assert.equal(secondResult!.success, false);
      assert.match(secondResult!.error ?? "", /正在执行|切换|in progress/i);
      assert.equal(calls, 1, "second request must not enter ownership check");
      gate.release();
      assert.equal((await first).success, false);
      ownership.isMainManaged = original;
      assert.equal((await f.post({ action: "browser_mode", modeAction: "headless" })).success, true);
      assert.equal(f.oldBrowser.browserClosedCount, 0);
    } finally {
      gate.release();
      await Promise.allSettled([first, second]);
      ownership.isMainManaged = original;
      await f.close();
    }
  });

  for (const limits of ["tab queue", "session limit 1", "global limit 1"] as const) {
    it(`HTTP hot-swap drains wait and queued eval, then admits new eval after rebinding (${limits})`, async () => {
      const savedGlobal = process.env.BB_SCHED_GLOBAL_LIMIT;
      const savedSession = process.env.BB_SCHED_SESSION_LIMIT;
      process.env.BB_SCHED_GLOBAL_LIMIT = limits === "global limit 1" ? "1" : "12";
      process.env.BB_SCHED_SESSION_LIMIT = limits === "session limit 1" ? "1" : "4";
      const launchGate = deferred();
      const f = await fixture({ native: true, launchGate });
      const pending: Array<ReturnType<typeof f.post>> = [];
      try {
        assert.equal((await f.post({ action: "tab_select", tabId: "a111" })).success, true);
        const wait = f.post({ action: "wait", ms: 700, tabId: "a111" });
        pending.push(wait);
        await eventually(async () => (await f.scheduler()).globalInFlight === 1, "wait must be admitted");
        const queued = f.post({ action: "eval", script: "before-swap", tabId: "a111" });
        pending.push(queued);
        await eventually(async () => {
          const stats = await f.scheduler();
          return limits === "tab queue" ? stats.globalInFlight === 2 : stats.queueDepth === 1;
        }, "eval must enter the tab or scheduler queue before switching");
        assert.equal(f.oldBrowser.requests.some((r) => r.expression === "before-swap"), false);
        const switching = f.post({ action: "browser_mode", modeAction: "headed" }, "mode-agent");
        pending.push(switching);
        await eventually(() => f.oldBrowser.browserClosedCount === 1, "switch should close after dispatch drains");
        let midDone = false;
        const mid = f.post({ action: "eval", script: "during-swap", tabId: "a111" }, "mid-agent")
          .then((r) => { midDone = true; return r; });
        pending.push(mid);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(midDone, false, "mid-swap eval must wait for replacement");
        launchGate.release();
        const responses = await Promise.all([wait, queued, switching, mid]);
        for (const response of responses) assert.equal(response.success, true, JSON.stringify(response));
        const closeIndex = f.oldBrowser.requests.findIndex((r) => r.method === "Browser.close");
        const evalIndex = f.oldBrowser.requests.findIndex((r) => r.expression === "before-swap");
        // Already admitted dispatches must drain on old Chrome; scheduler waiters may run after rebinding.
        if (limits === "tab queue") assert.ok(evalIndex >= 0 && evalIndex < closeIndex, "queued dispatch must finish before Browser.close");
        assert.equal(responses[3].data?.tab, "a111");
        assert.equal(f.oldBrowser.requests.some((r) => r.expression === "during-swap"), false);
        assert.ok(f.replacements[0].requests.some((r) => r.expression === "during-swap"));
      } finally {
        launchGate.release();
        await Promise.allSettled(pending);
        await f.close();
        if (savedGlobal === undefined) delete process.env.BB_SCHED_GLOBAL_LIMIT;
        else process.env.BB_SCHED_GLOBAL_LIMIT = savedGlobal;
        if (savedSession === undefined) delete process.env.BB_SCHED_SESSION_LIMIT;
        else process.env.BB_SCHED_SESSION_LIMIT = savedSession;
      }
    });
  }

  it("HTTP drain timeout rejects only the switch and leaves the running command and browser alive", async () => {
    const f = await fixture({ native: true });
    let running: ReturnType<typeof f.post> | undefined;
    try {
      assert.equal((await f.post({ action: "tab_select", tabId: "a111" })).success, true);
      running = f.post({ action: "wait", ms: 3800, tabId: "a111" });
      await eventually(async () => (await f.scheduler()).globalInFlight === 1, "wait must be running");
      const switched = await f.post({ action: "browser_mode", modeAction: "headed" }, "mode-agent");
      assert.equal(switched.success, false, "a command exceeding the 3s drain budget must cancel the switch");
      assert.equal(f.oldBrowser.browserClosedCount, 0);
      assert.equal(f.replacements.length, 0);
      assert.equal((await running).success, true);
      const next = await f.post({ action: "eval", script: "after-cancel", tabId: "a111" });
      assert.equal(next.success, true, JSON.stringify(next));
      assert.equal(next.data?.tab, "a111");
      assert.ok(f.oldBrowser.requests.some((r) => r.expression === "after-cancel"));
    } finally {
      await running;
      await f.close();
    }
  });

  it("Hot-swap preserves duplicate blank tabs, newtab URLs, leases and the selected blank session", async () => {
    const f = await fixture({
      native: true,
      targets: [page("OLD_A111", "https://app.example.com/a"), page("OLD_B222", "about:blank"),
        page("OLD_C333", "about:blank"), page("OLD_D444", "chrome://newtab")],
      restored: [page("NEW_9001", "https://app.example.com/a"), page("NEW_9002", "https://unrelated.example.com/")],
    });
    try {
      const expected = new Map<string, { url: string; bbTabId: unknown }>();
      for (const [shortId, url] of [["a111", "https://app.example.com/a"], ["b222", "about:blank"],
        ["c333", "about:blank"], ["d444", "chrome://newtab"]]) {
        const claim = await f.post({ action: "tab_claim", tabId: shortId });
        assert.equal(claim.success, true);
        expected.set(shortId, { url, bbTabId: claim.data?.bbTabId });
      }
      assert.equal((await f.post({ action: "tab_select", tabId: "c333" })).success, true);
      const switched = await f.post({ action: "browser_mode", modeAction: "headed" });
      assert.equal(switched.success, true, JSON.stringify(switched));
      // Check selection before explicit evals update the session's current tab.
      const implicit = await f.post({ action: "eval", script: "location.href" });
      assert.equal(implicit.success, true);
      assert.equal(implicit.data?.tab, "c333");
      assert.equal(implicit.data?.result, "about:blank");
      const targetIds = new Set<string>();
      for (const [shortId, before] of expected) {
        const targetId = f.tabManager.resolveShortId(shortId);
        assert.ok(targetId, `missing old shortId ${shortId}`);
        targetIds.add(targetId);
        const state = f.tabManager.getTab(targetId)!;
        assert.equal(state.bbTabId, before.bbTabId);
        assert.equal(state.leaseOwner, "agent-1");
        const readUrl = await f.post({ action: "eval", script: "location.href", tabId: shortId });
        assert.equal(readUrl.success, true, JSON.stringify(readUrl));
        assert.equal(readUrl.data?.result, before.url, `${shortId} must retain its own URL`);
        const intruder = await f.post({ action: "eval", script: "location.href", tabId: shortId }, "agent-2");
        assert.equal(intruder.success, false);
        assert.match(intruder.error ?? "", /exclusively held/);
      }
      assert.equal(targetIds.size, 4, "duplicate blank pages must remain distinct logical tabs");
      assert.deepEqual(f.replacements[0].createdUrls.sort(), ["about:blank", "about:blank", "chrome://newtab"].sort());
      assert.ok(f.replacements[0].targets.some((t) => t.targetId === "NEW_9002" && t.url === "https://unrelated.example.com/"));
      assert.equal(f.tabManager.allTabs().length, 5, "unrelated restored page must not be consumed as an old blank tab");
    } finally {
      await f.close();
    }
  });

  it("Windows stealth mode switches without restarting Chrome or losing tab state", async () => {
    const browserDir = join(testHome, "browser");
    mkdirSync(browserDir, { recursive: true });
    writeFileSync(join(browserDir, "browser-pid"), String(process.pid), "utf8");

    const fakeCdp = await startFakeBrowser({
      userAgent: "Mozilla/5.0 Chrome/131.0.0.0",
      initialTargets: [{ targetId: "PAGE_AAA_1001", type: "page", title: "Login", url: "https://xueqiu.com/login" }],
    });
    writeFileSync(join(browserDir, "cdp-port"), String(fakeCdp.port), "utf8");

    let stealthHidden = false;
    let lastFocus = false;
    let hideCalls = 0;
    let showCalls = 0;

    const mockWinDriver: WindowModeDriver = {
      async status() {
        return { trayRunning: true, windowCount: 1, stealth: stealthHidden };
      },
      async hide() {
        hideCalls += 1;
        stealthHidden = true;
        return { trayRunning: true, affectedCount: 1 };
      },
      async show(_pid, focus) {
        showCalls += 1;
        stealthHidden = false;
        lastFocus = Boolean(focus);
        return { trayRunning: true, affectedCount: 1, focused: Boolean(focus) };
      },
    };

    const tabManager = new TabStateManager();
    const cdp = new CdpConnection("127.0.0.1", fakeCdp.port, tabManager);
    const pool = new BrowserPool(cdp, undefined, {
      platform: "win32",
      windowDriver: mockWinDriver,
      forceManaged: true,
    });
    const daemonPort = await freePort();
    const http = new HttpServer({ host: "127.0.0.1", port: daemonPort, token: "tok", cdp: pool });

    await http.start();
    await cdp.connect();

    const post = async (body: Json, headers: Record<string, string> = {}) => {
      const r = await fetch(`http://127.0.0.1:${daemonPort}/command`, {
        method: "POST",
        headers: { Authorization: "Bearer tok", "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ id: `req-${Math.random()}`, ...body }),
      });
      return (await r.json()) as { success: boolean; data?: Json; error?: string };
    };

    try {
      // Claim the tab before switching modes
      const claim = await post({ action: "tab_claim", tabId: "1001" }, { "X-BB-Session": "agent-1" });
      assert.equal(claim.success, true);
      assert.equal(claim.data?.tab, "1001");

      // Query initial status -> headed stealth
      const st1 = await post({ action: "browser_mode", modeAction: "status" });
      assert.deepEqual(st1.data?.browserMode, {
        mode: "headed",
        backend: "stealth",
        connected: true,
        trayRunning: true,
      });

      // Read-only session can query status, but cannot switch mode
      const roStatus = await post(
        { action: "browser_mode", modeAction: "status" },
        { "X-BB-Session": "ro-agent", "X-BB-Session-Scope": "read-only" },
      );
      assert.equal(roStatus.success, true);

      const roSwitch = await post(
        { action: "browser_mode", modeAction: "headless" },
        { "X-BB-Session": "ro-agent", "X-BB-Session-Scope": "read-only" },
      );
      assert.equal(roSwitch.success, false);
      assert.match(roSwitch.error ?? "", /只读/);

      // Switch to headless -> zero restart!
      const toHeadless = await post({ action: "browser_mode", modeAction: "headless" });
      assert.equal(toHeadless.success, true);
      assert.deepEqual(toHeadless.data?.browserMode, {
        mode: "headless",
        backend: "stealth",
        connected: true,
        trayRunning: true,
        changed: true,
        restarted: false,
      });
      assert.equal(hideCalls, 1);
      assert.equal(fakeCdp.browserClosedCount, 0, "Chrome must NOT be closed in stealth mode");

      // Tab shortId and exclusive lease remain 100% intact
      const blocked = await post({ action: "eval", script: "1", tabId: "1001" }, { "X-BB-Session": "agent-2" });
      assert.equal(blocked.success, false);
      assert.match(blocked.error ?? "", /exclusively held/);

      const allowed = await post({ action: "eval", script: "1+1", tabId: "1001" }, { "X-BB-Session": "agent-1" });
      assert.equal(allowed.success, true);
      assert.equal(allowed.data?.tab, "1001");

      // One-click pop-up back to headed with focus=true -> zero restart!
      const toHeaded = await post({ action: "browser_mode", modeAction: "headed", focus: true });
      assert.equal(toHeaded.success, true);
      assert.deepEqual(toHeaded.data?.browserMode, {
        mode: "headed",
        backend: "stealth",
        connected: true,
        trayRunning: true,
        changed: true,
        restarted: false,
        windowFocused: true,
      });
      assert.equal(showCalls, 1);
      assert.equal(lastFocus, true);
      assert.equal(fakeCdp.browserClosedCount, 0);
    } finally {
      pool.disconnectAll();
      await http.stop();
      await fakeCdp.close();
    }
  });

  it("Fallback hot-swap preserves daemon, backfills dropped tabs, rebinds shortIds & leases, and queues concurrent commands", async () => {
    const browserDir = join(testHome, "browser");
    mkdirSync(browserDir, { recursive: true });
    writeFileSync(join(browserDir, "browser-pid"), String(process.pid), "utf8");

    // Old browser is a legacy native `--headless=new` instance with 2 tabs:
    //   - Tab A ("a111"): https://app.example.com/dashboard
    //   - Tab B ("b222"): https://app.example.com/background-task (simulates a CDP background tab dropped by Chrome session restore)
    const oldBrowser = await startFakeBrowser({
      userAgent: "Mozilla/5.0 HeadlessChrome/131.0.0.0",
      initialTargets: [
        { targetId: "OLD_T_A111", type: "page", title: "Dashboard", url: "https://app.example.com/dashboard" },
        { targetId: "OLD_T_B222", type: "page", title: "BG Task", url: "https://app.example.com/background-task" },
      ],
    });
    writeFileSync(join(browserDir, "cdp-port"), String(oldBrowser.port), "utf8");

    let newBrowser: FakeCdpHandle | null = null;
    const mockWinDriver: WindowModeDriver = {
      async status() { return { trayRunning: true, windowCount: 1, stealth: false }; },
      async hide() { return { trayRunning: true, affectedCount: 1 }; },
      async show(_pid, focus) { return { trayRunning: true, affectedCount: 1, focused: Boolean(focus) }; },
    };

    const tabManager = new TabStateManager();
    const cdp = new CdpConnection("127.0.0.1", oldBrowser.port, tabManager);
    const pool = new BrowserPool(cdp, undefined, {
      platform: "win32",
      windowDriver: mockWinDriver,
      forceManaged: true,
      launcher: async () => {
        // Simulate 150ms browser restart delay so we can test concurrent command queuing
        await new Promise((r) => setTimeout(r, 150));
        // Replacement GUI browser only restored Tab A (with a BRAND NEW targetId!), dropping Tab B!
        newBrowser = await startFakeBrowser({
          userAgent: "Mozilla/5.0 Chrome/131.0.0.0",
          initialTargets: [
            { targetId: "NEW_T_9999", type: "page", title: "Dashboard", url: "https://app.example.com/dashboard" },
          ],
        });
        writeFileSync(join(browserDir, "cdp-port"), String(newBrowser.port), "utf8");
        return { host: "127.0.0.1", port: newBrowser.port };
      },
    });

    const daemonPort = await freePort();
    const http = new HttpServer({ host: "127.0.0.1", port: daemonPort, token: "tok2", cdp: pool });

    await http.start();
    await cdp.connect();

    const post = async (body: Json, session = "agent-1") => {
      const r = await fetch(`http://127.0.0.1:${daemonPort}/command`, {
        method: "POST",
        headers: {
          Authorization: "Bearer tok2",
          "Content-Type": "application/json",
          "X-BB-Session": session,
        },
        body: JSON.stringify({ id: `req-${Math.random()}`, ...body }),
      });
      return (await r.json()) as { success: boolean; data?: Json; error?: string };
    };

    try {
      // Select Tab B as agent-1's current tab, and claim Tab A exclusively for agent-1
      const selB = await post({ action: "tab_select", tabId: "b222" }, "agent-1");
      assert.equal(selB.success, true);
      const claimA = await post({ action: "tab_claim", tabId: "a111" }, "agent-1");
      assert.equal(claimA.success, true);
      const bbTabIdBefore = claimA.data?.bbTabId;

      const evalBefore = await post({ action: "eval", script: "before", tabId: "a111" }, "agent-1");
      const seqBefore = Number(evalBefore.data?.seq ?? 0);

      // Start mode switch from native headless -> headed, and fire an eval mid-swap!
      const switchPromise = post({ action: "browser_mode", modeAction: "headed", focus: true }, "agent-1");
      await new Promise((r) => setTimeout(r, 40));
      const midSwapEval = post({ action: "eval", script: "during-swap", tabId: "b222" }, "agent-1");

      const [switchRes, midRes] = await Promise.all([switchPromise, midSwapEval]);

      assert.equal(switchRes.success, true);
      assert.deepEqual(switchRes.data?.browserMode, {
        mode: "headed",
        backend: "stealth",
        connected: true,
        trayRunning: true,
        changed: true,
        restarted: true,
        windowFocused: true,
      });

      // Mid-swap command waited on the swap barrier and succeeded on rebound shortId "b222"!
      assert.equal(midRes.success, true, `mid-swap eval failed: ${midRes.error}`);
      assert.equal(midRes.data?.tab, "b222");
      assert.ok(Number(midRes.data?.seq) > seqBefore, "seq remained monotonically increasing");

      // Missing background tab URL was automatically recreated via Target.createTarget!
      assert.ok(newBrowser !== null);
      assert.deepEqual((newBrowser as FakeCdpHandle).createdUrls, ["https://app.example.com/background-task"]);

      // Both original shortIds ("a111" and "b222") still resolve cleanly!
      const listAfter = await post({ action: "tab_list" }, "agent-1");
      const shortIds = ((listAfter.data?.tabs as Array<{ tab: string }>) ?? []).map((t) => t.tab).sort();
      assert.deepEqual(shortIds, ["a111", "b222"]);

      // Exclusive lease on "a111" survived the browser restart!
      const blockedOther = await post({ action: "eval", script: "intrude", tabId: "a111" }, "agent-2");
      assert.equal(blockedOther.success, false);
      assert.match(blockedOther.error ?? "", /exclusively held/);

      // Session's currentTargetId (which pointed at OLD_T_B222) was remapped to the new Tab B!
      const implicitTabEval = await post({ action: "eval", script: "implicit-current" }, "agent-1");
      assert.equal(implicitTabEval.success, true);
      assert.equal(implicitTabEval.data?.tab, "b222");

      // bbTabId of "a111" remained identical across the hot-swap
      assert.equal(tabManager.getTab(tabManager.resolveShortId("a111")!)?.bbTabId, bbTabIdBefore);
    } finally {
      pool.disconnectAll();
      await http.stop();
      await oldBrowser.close();
      if (newBrowser) await (newBrowser as FakeCdpHandle).close();
    }
  });
});
