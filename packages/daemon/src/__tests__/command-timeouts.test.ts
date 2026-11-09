/**
 * Issue #30: command timeouts are classified (cdp / dispatch / queue), slow
 * but healthy commands within their budget succeed, and /status `health`
 * reflects a half-dead daemon. Runs a real HttpServer + CdpConnection against
 * a fake CDP endpoint, so no browser is needed.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { CdpConnection } from "../cdp-connection.js";
import { HttpServer } from "../http-server.js";
import { TabStateManager } from "../tab-state.js";

type Json = Record<string, unknown>;

/** Fake browser: answers everything, except Runtime.evaluate("hang") never and "slow" after 1.2s. */
function startFakeCdp(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const { port } = server.address() as AddressInfo;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ Browser: "Chrome/130.0.0.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Json;
        const reply = (result: Json) =>
          ws.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result }));
        switch (msg.method) {
          case "Target.getTargets":
            return reply({ targetInfos: [{ targetId: "T1", type: "page", title: "t", url: "https://example.com/" }] });
          case "Target.attachToTarget":
            return reply({ sessionId: "S1" });
          case "Runtime.evaluate": {
            const expr = (msg.params as Json).expression;
            if (expr === "hang") return;
            if (expr === "slow") {
              setTimeout(() => reply({ result: { type: "string", value: "slow-ok" } }), 1200);
              return;
            }
            return reply({ result: { type: "string", value: "ok" } });
          }
          default:
            return reply({});
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
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

describe("command timeouts + health (issue #30)", () => {
  let fake: { server: Server; port: number };
  let cdp: CdpConnection;
  let http: HttpServer;
  let port: number;

  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Json };
  };

  before(async () => {
    fake = await startFakeCdp();
    cdp = new CdpConnection("127.0.0.1", fake.port, new TabStateManager());
    await cdp.connect();
    port = await freePort();
    http = new HttpServer({ host: "127.0.0.1", port, cdp });
    await http.start();
  });

  after(async () => {
    await http.stop();
    cdp.disconnect();
    fake.server.closeAllConnections?.();
    await new Promise((r) => fake.server.close(r));
  });

  it("a healthy command succeeds and health is ok", async () => {
    const { status, json } = await call("POST", "/command", { id: "1", action: "eval", script: "fast" });
    assert.equal(status, 200);
    assert.equal(json.success, true);
    const st = await call("GET", "/status");
    const health = st.json.health as Json;
    assert.equal(health.state, "ok");
    assert.equal(typeof health.lastSuccessAt, "number");
  });

  it("a slow command within its budget is not killed", async () => {
    const { status, json } = await call("POST", "/command", { id: "2", action: "eval", script: "slow", timeoutMs: 3000 });
    assert.equal(status, 200);
    assert.equal(json.success, true);
  });

  it("a CDP call the browser never answers times out as kind=cdp with the method", async () => {
    const t0 = Date.now();
    const { status, json } = await call("POST", "/command", { id: "3", action: "eval", script: "hang", timeoutMs: 1000 });
    assert.equal(status, 504);
    assert.equal(json.success, false);
    const timeout = json.timeout as Json;
    assert.equal(timeout.kind, "cdp");
    assert.equal(timeout.cdpMethod, "Runtime.evaluate");
    assert.equal(timeout.budgetMs, 1000);
    assert.match(String(json.error), /timed out after 1s \[cdp\]/);
    assert.ok(Date.now() - t0 < 3000, "answered at the budget, not later");

    const health = (await call("GET", "/status")).json.health as Json;
    assert.equal(health.state, "degraded");
    assert.equal(health.consecutiveTimeouts, 1);
    assert.equal(health.orphanedCommands, 1);
    assert.equal(((health.timeouts as Json).cdp), 1);
    assert.ok(typeof health.hint === "string" && health.hint.length > 0);
  });

  it("daemon-side stalls time out as kind=dispatch", async () => {
    const { status, json } = await call("POST", "/command", { id: "4", action: "wait", ms: 2500, timeoutMs: 1000 });
    assert.equal(status, 504);
    assert.equal((json.timeout as Json).kind, "dispatch");
  });

  it("repeated timeouts mark the daemon stalled; a success resets the streak", async () => {
    // The earlier hung eval still holds the tab's serial queue, so this one
    // never reaches the browser: a daemon-side (dispatch) timeout that names
    // the cause.
    const blocked = await call("POST", "/command", { id: "5", action: "eval", script: "hang", timeoutMs: 1000 });
    assert.equal((blocked.json.timeout as Json).kind, "dispatch");
    assert.match(String(blocked.json.error), /queued behind \d+ earlier timed-out command/);
    let health = (await call("GET", "/status")).json.health as Json;
    assert.equal(health.state, "stalled");
    assert.equal(health.consecutiveTimeouts, 3);
    assert.equal(((health.lastError as Json).timeout as Json).kind, "dispatch");
    assert.equal((health.cdpPending as Json).count, 1, "the hung CDP call is visible");
    assert.equal((health.cdpPending as Json).oldestMethod, "Runtime.evaluate");

    // tab_list skips the per-tab queue, so it still succeeds — the
    // "can list tabs but can't eval" half-dead state from the issue.
    const list = await call("POST", "/command", { id: "6", action: "tab_list" });
    assert.equal(list.json.success, true);
    health = (await call("GET", "/status")).json.health as Json;
    assert.equal(health.consecutiveTimeouts, 0);
    // The hung evals are still running in the background → still degraded.
    assert.equal(health.state, "degraded");
  });
});
