import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";

test("Windows mode requests wait for the tray and respect read-only sessions", { skip: !windows }, async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-mode-test-"));
  const oldHome = process.env.BB_BROWSER_HOME;
  const oldScope = process.env.BB_SESSION_SCOPE;
  process.env.BB_BROWSER_HOME = home;
  delete process.env.BB_SESSION_SCOPE;
  const tray = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$m=New-Object System.Threading.Mutex($false,'Local\\ma-browser-tray'); [Console]::WriteLine('READY'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $m.Dispose()"],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const servers: Server[] = [];
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("test tray mutex did not start")), 5000);
      tray.once("error", reject);
      tray.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
    });
    let mode: "headed" | "headless" = "headless";
    let failNext = false;
    let requestSeen: (() => void) | undefined;
    const listen = async (server: Server) => {
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return (server.address() as { port: number }).port;
    };
    const cdpPort = await listen(createServer((_req, res) => {
      res.end(JSON.stringify({ "User-Agent": mode === "headless" ? "HeadlessChrome/1" : "Chrome/1" }));
    }));
    const daemonPort = await listen(createServer((_req, res) => {
      res.end(JSON.stringify({ cdpConnected: true, cdpPort, sessions: [{ id: "restricted", scope: "read-only" }] }));
    }));
    const browserDir = join(home, "browser");
    mkdirSync(browserDir);
    writeFileSync(join(browserDir, "cdp-port"), String(cdpPort));
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: daemonPort, token: "test" }));
    monitor = setInterval(() => {
      const requestFile = join(browserDir, "mode-request.json");
      if (!existsSync(requestFile)) return;
      const request = JSON.parse(readFileSync(requestFile, "utf8")) as { id: string; mode: "headed" | "headless" };
      unlinkSync(requestFile);
      requestSeen?.();
      const failure = failNext;
      failNext = false;
      setTimeout(() => {
        if (!failure) mode = request.mode;
        writeFileSync(join(browserDir, "mode-result.json"), JSON.stringify({ id: request.id, success: !failure, changed: !failure, error: failure ? "test refusal" : undefined }));
      }, 1000);
    }, 50);

    const { browserMode } = await import("../browser-mode.js");
    assert.equal((await browserMode("status")).mode, "headless");
    assert.equal((await browserMode("headless")).changed, false);
    const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
    const switchInFlight = browserMode("headed");
    await Promise.race([seen, switchInFlight.then(() => { throw new Error("switch finished without a request"); })]);
    await assert.rejects(browserMode("headed"), /正在执行/);
    assert.deepEqual(await switchInFlight, { mode: "headed", connected: true, trayRunning: true, changed: true });
    failNext = true;
    await assert.rejects(browserMode("headless"), /test refusal/);
    await assert.rejects(browserMode("headless", "restricted"), /只读/);
    process.env.BB_SESSION_SCOPE = "read-only";
    await assert.rejects(browserMode("headless"), /只读/);
    assert.equal((await browserMode("status")).mode, "headed");
  } finally {
    if (monitor) clearInterval(monitor);
    tray.stdin.end("\n");
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldHome === undefined) delete process.env.BB_BROWSER_HOME; else process.env.BB_BROWSER_HOME = oldHome;
    if (oldScope === undefined) delete process.env.BB_SESSION_SCOPE; else process.env.BB_SESSION_SCOPE = oldScope;
    rmSync(home, { recursive: true, force: true });
  }
});
