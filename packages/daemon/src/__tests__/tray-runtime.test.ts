import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

// Exercise the real daemon entry point, not dist or a public daemon.json. Only
// communicate after the responding child's pid and private test token match.
test("tray polling is observational and shutdown persists an admitted command", { timeout: 20_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ma-tray-runtime-"));
  const browser = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const port = (browser.address() as AddressInfo).port;
    res.end(JSON.stringify(req.url === "/json/version"
      ? { Browser: "Chrome/130", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }
      : []));
  });
  const wss = new WebSocketServer({ server: browser });
  const target = { targetId: "fixture-target", type: "page", url: "about:blank", title: "test" };
  let holdTargets = false;
  let admitted!: () => void;
  const commandAdmitted = new Promise<void>((resolve) => { admitted = resolve; });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const { id, method } = JSON.parse(data.toString());
      if (method === "Target.getTargets" && holdTargets) {
        admitted();
        await gate;
      }
      const result = method === "Target.getTargets" ? { targetInfos: [target] }
        : method === "Target.attachToTarget" ? { sessionId: "fixture-session" } : {};
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, result }));
    });
  });
  await new Promise<void>((resolve) => browser.listen(0, "127.0.0.1", resolve));
  const cdpPort = (browser.address() as AddressInfo).port;
  const reserved = createServer();
  await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const httpPort = (reserved.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  const daemon = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url)),
    "--host", "127.0.0.1", "--port", String(httpPort), "--cdp-port", String(cdpPort), "--strict-cdp", "--token", "fixture"], {
    env: { ...process.env, BB_BROWSER_HOME: home, BB_CDP_DISCOVERY: "0", MA_BROWSER_NO_LAUNCH: "1", BB_BROWSER_CDP_URL: "", BB_BROWSER_CDP_URLS: "" },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  const exit = once(daemon, "exit");
  const base = `http://127.0.0.1:${httpPort}`;
  let output = "";
  daemon.stderr.on("data", (buf) => { output += buf.toString(); });
  t.after(async () => {
    unblock();
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
    await exit;
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    browser.closeAllConnections();
    await new Promise<void>((resolve) => browser.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  const request = async (route: string, body?: object) => {
    const res = await fetch(`${base}${route}`, { headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      method: body ? "POST" : "GET", body: body && JSON.stringify(body), signal: AbortSignal.timeout(7_000) });
    assert.equal(res.status, 200, `${route}: ${res.status}`);
    return await res.json() as { [key: string]: any };
  };
  const until = async (pred: () => Promise<boolean>, what: string) => {
    const end = Date.now() + 7_000;
    while (!await pred()) {
      if (Date.now() > end || daemon.exitCode !== null) assert.fail(`${what}: ${output}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await until(async () => {
    try {
      const info = JSON.parse(await readFile(join(home, "daemon.json"), "utf8"));
      return info.pid === daemon.pid && info.port === httpPort && info.token === "fixture";
    } catch { return false; }
  }, "daemon did not publish readiness");
  await until(async () => (await request("/status")).cdpConnected === true, "CDP did not connect");
  assert.equal((await fetch(`${base}/api/tray-status`)).status, 401);
  const claim = await request("/command", { id: "claim", action: "tab_claim" });
  assert.equal(claim.success, true);
  const before = await request("/status");
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(await request("/api/tray-status"), { running: true, cdpConnected: true, connectedBrowserCount: 1 });
  }
  assert.deepEqual((await request("/status")).sessions, before.sessions);
  const commands = await request("/api/commands");
  assert.equal(commands.commands.length, 1);
  assert.equal(commands.commands[0].tool, "tab_claim");

  holdTargets = true;
  const command = request("/command", { id: "work", action: "wait", ms: 1 });
  await commandAdmitted;
  await request("/shutdown", {});
  await until(async () => output.includes("Shutting down..."), "drain did not start");
  unblock();
  assert.equal((await command).success, true);
  assert.equal((await exit)[0], 0);
  const journal = JSON.parse(await readFile(join(home, "state", "journal-default.json"), "utf8"));
  assert.equal(journal.entries.at(-1).action, "wait");
  assert.equal(journal.entries.at(-1).success, true);
});
