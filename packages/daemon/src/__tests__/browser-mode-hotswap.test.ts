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
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  close: () => Promise<void>;
}

function startFakeBrowser(opts: {
  userAgent: string;
  initialTargets: FakeTarget[];
}): Promise<FakeCdpHandle> {
  return new Promise((resolve) => {
    const targets: FakeTarget[] = opts.initialTargets.map((t) => ({ ...t }));
    const createdUrls: string[] = [];
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
          case "Target.attachToTarget":
            return reply({ sessionId: `S_${nextSessionSeq++}` });
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
            return reply({ result: { type: "string", value: `eval:${expr}` } });
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
        close,
      });
    });
  });
}

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
    testHome = mkdtempSync(join(tmpdir(), "ma-daemon-mode-"));
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
