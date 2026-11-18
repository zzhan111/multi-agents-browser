import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { CdpConnection } from "../cdp-connection.js";
import { TabStateManager } from "../tab-state.js";

async function fake() {
  let mode: "http-hang" | "init-hang" | "ok" = "ok";
  let pages = ["one"];
  const server = createServer((_req, res) => {
    if (mode === "http-hang") return;
    const port = (server.address() as AddressInfo).port;
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", ws => {
    ws.on("message", raw => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: { targetId?: string } };
      if (mode === "init-hang" && msg.method === "Target.getTargets") return;
      const result = msg.method === "Target.getTargets"
        ? { targetInfos: pages.map(targetId => ({ targetId, type: "page", title: "", url: "" })) }
        : msg.method === "Target.attachToTarget" ? { sessionId: `session-${msg.params.targetId}` } : {};
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port, wss,
    setMode(value: typeof mode) { mode = value; },
    setPages(value: string[]) { pages = value; },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test("deadline covers discovery and initialization, then retries cleanly", async () => {
  const server = await fake();
  const cdp = new CdpConnection("127.0.0.1", server.port, new TabStateManager(), 100);
  try {
    server.setMode("http-hang");
    await assert.rejects(cdp.connect(), /timed out/);
    server.setMode("init-hang");
    const connecting = cdp.connect();
    const ready = cdp.waitUntilReady();
    assert.equal(cdp.connected, false);
    assert.equal(cdp.debuggerUrl, null);
    await assert.rejects(connecting, /timed out/);
    await assert.rejects(ready, /timed out/);
    assert.equal(cdp.pendingStats().count, 0);
    server.setMode("ok");
    await cdp.connect();
    await cdp.waitUntilReady();
    assert.equal(cdp.debuggerUrl, `ws://127.0.0.1:${server.port}/devtools/browser/fake`);
    assert.equal(cdp.hasSession("one"), true);
  } finally { cdp.disconnect(); await server.close(); }
});

test("deadline terminates a stalled WebSocket handshake", async () => {
  const server = createServer((_req, res) => {
    const port = (server.address() as AddressInfo).port;
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/stall` }));
  });
  server.on("upgrade", (_req, socket) => { socket.on("error", () => {}); socket.on("end", () => socket.destroy()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const cdp = new CdpConnection("127.0.0.1", (server.address() as AddressInfo).port, new TabStateManager(), 100);
  try {
    await assert.rejects(cdp.connect(), /timed out/);
    assert.equal(cdp.connected, false);
  } finally {
    cdp.disconnect();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("disconnect cancels initialization and stale socket close cannot break retry", async () => {
  const server = await fake();
  const cdp = new CdpConnection("127.0.0.1", server.port, new TabStateManager(), 500);
  try {
    server.setMode("init-hang");
    const first = cdp.connect();
    // Wait for the fake to observe the initialization command.
    while (cdp.pendingStats().oldestMethod !== "Target.getTargets") await new Promise(resolve => setTimeout(resolve, 5));
    cdp.disconnect();
    server.setMode("ok");
    const retry = cdp.connect();
    await assert.rejects(first, /closed/);
    await retry;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(cdp.connected, true);
    assert.equal(cdp.hasSession("one"), true);
  } finally { cdp.disconnect(); await server.close(); }
});

test("unexpected close rejects pending calls and allows reconnect", async () => {
  const server = await fake();
  const cdp = new CdpConnection("127.0.0.1", server.port, new TabStateManager(), 500);
  try {
    await cdp.connect();
    let closes = 0;
    cdp.onUnexpectedClose = () => { closes++; };
    server.setMode("init-hang");
    const pending = cdp.browserCommand("Target.getTargets");
    for (const socket of server.wss.clients) socket.terminate();
    await assert.rejects(pending, /closed/);
    assert.equal(closes, 1);
    assert.equal(cdp.pendingStats().count, 0);
    assert.equal(cdp.debuggerUrl, null);
    server.setMode("ok");
    await cdp.connect();
    assert.equal(cdp.connected, true);
  } finally { cdp.disconnect(); await server.close(); }
});

test("reconnect removes only this connection's missing tabs and preserves swap state", async () => {
  const a = await fake();
  const b = await fake();
  b.setPages(["other"]);
  const tabs = new TabStateManager();
  const first = new CdpConnection("127.0.0.1", a.port, tabs, 500);
  const second = new CdpConnection("127.0.0.1", b.port, tabs, 500);
  try {
    await first.connect();
    await second.connect();
    const original = tabs.getTab("one");
    first.disconnect();
    a.setPages(["new"]);
    first.preservingTabsForSwap = true;
    await first.connect();
    assert.equal(tabs.getTab("one"), original);
    first.preservingTabsForSwap = false;
    first.disconnect();
    await first.connect();
    assert.equal(tabs.getTab("one"), undefined);
    assert.ok(tabs.getTab("new"));
    assert.ok(tabs.getTab("other"));
  } finally { first.disconnect(); second.disconnect(); await a.close(); await b.close(); }
});
