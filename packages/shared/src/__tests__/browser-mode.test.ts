import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserMode } from "../browser-mode.js";
import { WindowsWindowController } from "../windows-stealth.js";

const windows = process.platform === "win32";

test("browserMode delegates to daemon browser_mode, enforces read-only scope, and handles concurrency", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-mode-test-"));
  const oldHome = process.env.BB_BROWSER_HOME;
  const oldScope = process.env.BB_SESSION_SCOPE;
  process.env.BB_BROWSER_HOME = home;
  delete process.env.BB_SESSION_SCOPE;

  let currentMode: "headed" | "headless" = "headless";
  let switching = false;
  let failNext = false;
  let requestSeen: (() => void) | undefined;

  const daemon = createServer((req, res) => {
    const session = req.headers["x-bb-session"];
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/command" && req.method === "POST") {
        const body = JSON.parse(raw) as { id: string; action: string; modeAction?: "status" | "headed" | "headless"; focus?: boolean };
        const action = body.modeAction ?? "status";
        if (action !== "status" && session === "restricted") {
          res.writeHead(403);
          res.end(JSON.stringify({ id: body.id, success: false, error: "只读会话不能切换浏览器模式。" }));
          return;
        }
        if (action === "status") {
          res.end(JSON.stringify({
            id: body.id,
            success: true,
            data: { browserMode: { mode: currentMode, backend: "stealth", connected: true, trayRunning: true } },
          }));
          return;
        }
        if (switching) {
          res.writeHead(409);
          res.end(JSON.stringify({ id: body.id, success: false, error: "已有浏览器模式切换请求正在执行，请稍后重试。" }));
          return;
        }
        if (failNext) {
          failNext = false;
          res.end(JSON.stringify({ id: body.id, success: false, error: "test refusal" }));
          return;
        }
        if (currentMode === action) {
          res.end(JSON.stringify({
            id: body.id,
            success: true,
            data: { browserMode: { mode: currentMode, backend: "stealth", connected: true, trayRunning: true, changed: false, restarted: false } },
          }));
          return;
        }
        switching = true;
        requestSeen?.();
        setTimeout(() => {
          currentMode = action;
          switching = false;
          res.end(JSON.stringify({
            id: body.id,
            success: true,
            data: {
              browserMode: {
                mode: currentMode,
                backend: "stealth",
                connected: true,
                trayRunning: true,
                changed: true,
                restarted: false,
                ...(body.focus ? { windowFocused: true } : {}),
              },
            },
          }));
        }, 120);
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });

  const servers: Server[] = [daemon];
  try {
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const daemonPort = (daemon.address() as { port: number }).port;
    writeFileSync(
      join(home, "daemon.json"),
      JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: daemonPort, token: "test" }),
    );

    assert.equal((await browserMode("status")).mode, "headless");
    assert.equal((await browserMode("headless")).changed, false);

    const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
    const switchInFlight = browserMode("headed", "default", { focus: true });
    await seen;
    await assert.rejects(browserMode("headed"), /正在执行/);
    assert.deepEqual(await switchInFlight, {
      mode: "headed",
      backend: "stealth",
      connected: true,
      trayRunning: true,
      changed: true,
      restarted: false,
      windowFocused: true,
    });

    failNext = true;
    await assert.rejects(browserMode("headless"), /test refusal/);
    await assert.rejects(browserMode("headless", "restricted"), /只读/);
    process.env.BB_SESSION_SCOPE = "read-only";
    await assert.rejects(browserMode("headless"), /只读/);
    assert.equal((await browserMode("status")).mode, "headed");
  } finally {
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
    if (oldHome === undefined) delete process.env.BB_BROWSER_HOME;
    else process.env.BB_BROWSER_HOME = oldHome;
    if (oldScope === undefined) delete process.env.BB_SESSION_SCOPE;
    else process.env.BB_SESSION_SCOPE = oldScope;
    rmSync(home, { recursive: true, force: true });
  }
});

test("WindowsWindowController hides and restores a real Win32 window without closing it", { skip: !windows }, async () => {
  const controller = new WindowsWindowController();
  // Spawn a minimal off-screen WinForms window so nothing flashes on the user's screen.
  const winProc = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
        "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern int GetWindowLongW(IntPtr h, int i);' -Name Win -Namespace T; " +
        "$f = New-Object System.Windows.Forms.Form; $f.Text = 'ma-stealth-test'; " +
        "$f.StartPosition = 'Manual'; $f.Bounds = New-Object System.Drawing.Rectangle(240, 180, 640, 480); " +
        "$f.Opacity = 0.01; $f.ShowInTaskbar = $false; " +
        "$tm = New-Object System.Windows.Forms.Timer; $tm.Interval = 15000; $tm.Add_Tick({ $f.Close() }); $tm.Start(); " +
        "$ready = $false; $vis = New-Object System.Windows.Forms.Timer; $vis.Interval = 30; " +
        "$vis.Add_Tick({ if (-not $ready) { [T.Win]::ShowWindow($f.Handle, 4) | Out-Null; if (([T.Win]::GetWindowLongW($f.Handle, -16) -band 0x10000000) -ne 0) { $ready = $true; $vis.Stop(); [Console]::Out.WriteLine('READY:' + $PID); [Console]::Out.Flush() } } }); " +
        "$vis.Start(); [System.Windows.Forms.Application]::Run($f)",
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );

  try {
    const reportedPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error(`test WinForms window did not start (buf=${buf})`)), 10_000);
      winProc.once("error", reject);
      winProc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const m = /READY:(\d+)/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
    });

    const initial = await controller.status(reportedPid, "*");
    assert.equal(initial.windowCount, 1);
    assert.equal(initial.stealth, false);

    const hidden = await controller.hide(reportedPid, "*");
    assert.equal(hidden.affectedCount, 1);

    const afterHide = await controller.status(reportedPid, "*");
    assert.equal(afterHide.windowCount, 1);
    assert.equal(afterHide.stealth, true);

    const shown = await controller.show(reportedPid, false, "*");
    assert.equal(shown.affectedCount, 1);

    const afterShow = await controller.status(reportedPid, "*");
    assert.equal(afterShow.windowCount, 1);
    assert.equal(afterShow.stealth, false);
  } finally {
    controller.close();
    try { winProc.kill(); } catch {}
  }
});
