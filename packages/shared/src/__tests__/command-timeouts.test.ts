import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CLIENT_TIMEOUT_GRACE_MS,
  MAX_COMMAND_TIMEOUT_MS,
  actionTimeoutEnvName,
  clientCommandTimeoutMs,
  commandTimeoutMs,
} from "../command-timeouts.js";
import { DaemonTimeoutError, describeDaemonTimeout, httpJson } from "../daemon-client.js";
import { COMMAND_TIMEOUT } from "../constants.js";

describe("commandTimeoutMs", () => {
  it("keeps the 30s default for ordinary actions", () => {
    assert.equal(commandTimeoutMs({ action: "click" }, {}), COMMAND_TIMEOUT);
    assert.equal(commandTimeoutMs({ action: "tab_list" }, {}), COMMAND_TIMEOUT);
  });

  it("gives slow actions a larger tier", () => {
    assert.equal(commandTimeoutMs({ action: "screenshot" }, {}), 60_000);
    assert.equal(commandTimeoutMs({ action: "eval" }, {}), 60_000);
    assert.equal(commandTimeoutMs({ action: "site_run" }, {}), 120_000);
  });

  it("lets `wait` run past 30s when asked to", () => {
    assert.equal(commandTimeoutMs({ action: "wait", ms: 1_000 }, {}), COMMAND_TIMEOUT);
    assert.equal(commandTimeoutMs({ action: "wait", ms: 45_000 }, {}), 50_000);
  });

  it("honours per-action and global env overrides", () => {
    assert.equal(actionTimeoutEnvName("site_run"), "BB_COMMAND_TIMEOUT_SITE_RUN_MS");
    assert.equal(commandTimeoutMs({ action: "eval" }, { BB_COMMAND_TIMEOUT_EVAL_MS: "5000" }), 5_000);
    // Global is a floor: raises small tiers, never lowers big ones.
    assert.equal(commandTimeoutMs({ action: "click" }, { BB_COMMAND_TIMEOUT_MS: "90000" }), 90_000);
    assert.equal(commandTimeoutMs({ action: "site_run" }, { BB_COMMAND_TIMEOUT_MS: "10000" }), 120_000);
    // Garbage is ignored.
    assert.equal(commandTimeoutMs({ action: "click" }, { BB_COMMAND_TIMEOUT_MS: "abc" }), COMMAND_TIMEOUT);
  });

  it("prefers request.timeoutMs and clamps it", () => {
    assert.equal(commandTimeoutMs({ action: "click", timeoutMs: 2_500 }, { BB_COMMAND_TIMEOUT_CLICK_MS: "9000" }), 2_500);
    assert.equal(commandTimeoutMs({ action: "click", timeoutMs: 1 }, {}), 1_000);
    assert.equal(commandTimeoutMs({ action: "click", timeoutMs: 1e9 }, {}), MAX_COMMAND_TIMEOUT_MS);
  });

  it("client waits budget + grace so the daemon answers first", () => {
    assert.equal(clientCommandTimeoutMs({ action: "eval" }, {}), 60_000 + CLIENT_TIMEOUT_GRACE_MS);
  });
});

function serve(handler: (status: (code: number, body: string) => void) => void): Promise<{ info: { host: string; port: number; token: string }; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => handler((code, body) => res.writeHead(code).end(body)));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        info: { host: "127.0.0.1", port, token: "t" },
        close: () => {
          server.closeAllConnections();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

describe("httpJson", () => {
  it("resolves opted-in failure statuses with their JSON body", async () => {
    const srv = await serve((send) => send(504, JSON.stringify({ success: false, error: "x", timeout: { kind: "cdp" } })));
    try {
      const body = await httpJson<{ timeout: { kind: string } }>("POST", "/command", srv.info, {}, 2000, { resolveStatuses: [504] });
      assert.equal(body.timeout.kind, "cdp");
      await assert.rejects(httpJson("POST", "/command", srv.info, {}, 2000), /Daemon HTTP 504/);
    } finally {
      await srv.close();
    }
  });

  it("rejects with DaemonTimeoutError when no response arrives", async () => {
    const srv = await serve(() => {});
    try {
      await assert.rejects(httpJson("GET", "/status", srv.info, undefined, 100), (err: unknown) => {
        assert.ok(err instanceof DaemonTimeoutError);
        assert.equal(err.timeoutMs, 100);
        return true;
      });
    } finally {
      await srv.close();
    }
  });
});

describe("describeDaemonTimeout", () => {
  const info = { host: "127.0.0.1", port: 1, token: "t" };

  it("blames the command when /status still answers", async () => {
    const probe = (async () => ({ health: { state: "degraded", reasons: ["1 consecutive command timeout(s)"], hint: "Close the tab." } })) as typeof httpJson;
    const msg = await describeDaemonTimeout(info, "screenshot", 65_000, probe);
    assert.match(msg, /"screenshot".*65s/);
    assert.match(msg, /\/status still answers/);
    assert.match(msg, /degraded/);
    assert.match(msg, /Close the tab\./);
  });

  it("blames the daemon when /status is silent too", async () => {
    const probe = (async () => {
      throw new Error("nope");
    }) as typeof httpJson;
    const msg = await describeDaemonTimeout(info, "eval", 35_000, probe);
    assert.match(msg, /unresponsive \(event loop blocked\) or restarting/);
  });
});
