import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WindowModeDriver } from "@ma-browser/shared";
import { BrowserPool, dispatchCdpRequest } from "../browser-pool.js";
import { CdpConnection } from "../cdp-connection.js";
import { TabStateManager } from "../tab-state.js";

type Json = Record<string, unknown>;

interface FakeBrowser {
  port: number;
  close: () => Promise<void>;
}

function startFakeCdpBrowser(pageCount: number): Promise<FakeBrowser> {
  return new Promise((resolve) => {
    const targets = Array.from({ length: pageCount }, (_, i) => ({
      targetId: `T_${i + 1}`,
      type: "page",
      title: `Tab ${i + 1}`,
      url: `https://example.com/${i + 1}`,
    }));
    const sessions = new Map<string, string>();
    let seq = 1;
    const server: Server = createServer((_req, res) => {
      const { port } = server.address() as AddressInfo;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          Browser: "Chrome/132.0.0.0",
          "User-Agent": "Mozilla/5.0 Chrome/132.0.0.0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        }),
      );
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Json;
        const reply = (result: Json) =>
          ws.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result }));
        if (msg.method === "Target.getTargets") return reply({ targetInfos: targets });
        if (msg.method === "Target.attachToTarget") {
          const sid = `S_${seq++}`;
          sessions.set(sid, String((msg.params as Json).targetId));
          return reply({ sessionId: sid });
        }
        return reply({});
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

describe("Daemon multi-browser browser_mode & safety guards", () => {
  it("lists, toggles per-browser and all, skips shared-profile readonly browsers, and restores hidden external windows on detach/shutdown", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "ma-multi-mode-"));
    const oldHome = process.env.BB_BROWSER_HOME;
    process.env.BB_BROWSER_HOME = tempHome;
    const mainBrowser = await startFakeCdpBrowser(2);
    const isolatedBrowser = await startFakeCdpBrowser(1);
    const sharedBrowser = await startFakeCdpBrowser(1);
    const procMain = spawnSleeper();
    const procIsolated = spawnSleeper();
    const procShared = spawnSleeper();

    try {
      const pidMain = procMain.pid!;
      const pidIsolated = procIsolated.pid!;
      const pidShared = procShared.pid!;

      const hiddenPids = new Set<number>();
      const windowCounts = new Map<number, number>([
        [pidMain, 1],
        [pidIsolated, 1],
        [pidShared, 1],
      ]);
      const calls: Array<{ op: string; pid: number; focus?: boolean }> = [];

      const driver: WindowModeDriver = {
        async status(pid) {
          if (!pid) return { trayRunning: true, windowCount: 0, stealth: false };
          return { trayRunning: true, windowCount: windowCounts.get(pid) ?? 0, stealth: hiddenPids.has(pid) };
        },
        async hide(pid) {
          calls.push({ op: "hide", pid });
          hiddenPids.add(pid);
          return { trayRunning: true, affectedCount: 1 };
        },
        async show(pid, focus) {
          calls.push({ op: "show", pid, focus });
          hiddenPids.delete(pid);
          return { trayRunning: true, affectedCount: 1, focused: Boolean(focus) };
        },
        async findManagedPid() {
          return pidMain;
        },
        async findBrowserProcess(port) {
          if (port === isolatedBrowser.port) {
            return { pid: pidIsolated, userDataDir: "D:/Profiles/Chrome-7890" };
          }
          if (port === sharedBrowser.port) {
            // Empty/omitted userDataDir simulates a process sharing the default Chrome profile
            return { pid: pidShared };
          }
          return null;
        },
      };

      const tabManager = new TabStateManager();
      const mainConn = new CdpConnection("127.0.0.1", mainBrowser.port, tabManager);
      const pool = new BrowserPool(mainConn, undefined, {
        windowDriver: driver,
        platform: "win32",
        strictCdp: true,
        forceManaged: true,
      });

      await mainConn.connect();
      await pool.attach({ host: "127.0.0.1", port: isolatedBrowser.port });
      await pool.attach({ host: "127.0.0.1", port: sharedBrowser.port });

      try {
        // 1. status returns all 3 browsers with isolated vs readonly classification
        const statusRes = await pool.handleBrowserMode({ id: "s1", action: "browser_mode", modeAction: "status" });
        assert.equal(statusRes.success, true);
        const modes = statusRes.data?.browserModes ?? [];
        assert.equal(modes.length, 3);
        const mainInfo = modes.find((m) => m.id === String(mainBrowser.port))!;
        const isoInfo = modes.find((m) => m.id === String(isolatedBrowser.port))!;
        const sharedInfo = modes.find((m) => m.id === String(sharedBrowser.port))!;
        assert.equal(mainInfo.canToggle, true);
        assert.equal(mainInfo.managed, true);
        assert.equal(isoInfo.canToggle, true);
        assert.equal(isoInfo.label, "Chrome-7890");
        assert.equal(sharedInfo.canToggle, false);
        assert.match(sharedInfo.readonlyReason ?? "", /共用配置目录/);

        // 2. Switching a single attached browser only hides that browser's PID
        const hideIso = await pool.handleBrowserMode({
          id: "h1",
          action: "browser_mode",
          modeAction: "headless",
          browser: String(isolatedBrowser.port),
        });
        assert.equal(hideIso.success, true);
        assert.equal(hiddenPids.has(pidIsolated), true);
        assert.equal(hiddenPids.has(pidMain), false);
        assert.equal(hiddenPids.has(pidShared), false);

        // 3. Targeting a readonly shared-profile browser is rejected without hiding it
        const hideShared = await pool.handleBrowserMode({
          id: "h2",
          action: "browser_mode",
          modeAction: "headless",
          browser: String(sharedBrowser.port),
        });
        assert.equal(hideShared.success, false);
        assert.match(hideShared.error ?? "", /共用配置目录/);
        assert.equal(hiddenPids.has(pidShared), false);

        // 4. browser: "all" hides all controllable browsers and skips readonly ones
        const hideAll = await pool.handleBrowserMode({
          id: "all1",
          action: "browser_mode",
          modeAction: "headless",
          browser: "all",
        });
        assert.equal(hideAll.success, true);
        assert.equal(hiddenPids.has(pidMain), true);
        assert.equal(hiddenPids.has(pidIsolated), true);
        assert.equal(hiddenPids.has(pidShared), false);

        // 5. Detaching a stealth-hidden external browser restores its window automatically
        const detachRes = await dispatchCdpRequest(pool, {
          id: "d1",
          action: "cdp_detach",
          browser: String(isolatedBrowser.port),
        });
        assert.equal(detachRes.success, true);
        assert.equal(hiddenPids.has(pidIsolated), false);
        assert.equal(calls.some((c) => c.op === "show" && c.pid === pidIsolated && c.focus === false), true);

        // 6. Re-attach and hide isolated browser, then verify restoreExternalHiddenWindows restores only external
        await pool.attach({ host: "127.0.0.1", port: isolatedBrowser.port });
        await pool.handleBrowserMode({
          id: "h3",
          action: "browser_mode",
          modeAction: "headless",
          browser: String(isolatedBrowser.port),
        });
        assert.equal(hiddenPids.has(pidIsolated), true);
        await pool.restoreExternalHiddenWindows();
        assert.equal(hiddenPids.has(pidIsolated), false);
        assert.equal(hiddenPids.has(pidMain), true);
      } finally {
        pool.disconnectAll();
      }
    } finally {
      try { procMain.kill(); } catch {}
      try { procIsolated.kill(); } catch {}
      try { procShared.kill(); } catch {}
      await mainBrowser.close();
      await isolatedBrowser.close();
      await sharedBrowser.close();
      if (oldHome === undefined) delete process.env.BB_BROWSER_HOME;
      else process.env.BB_BROWSER_HOME = oldHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
