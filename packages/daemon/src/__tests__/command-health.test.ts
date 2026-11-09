/**
 * CommandHealth unit tests — state derivation for /status `health` (issue #30).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CommandHealth, LAG_DEGRADED_MS, LAG_STALLED_MS, STALLED_AFTER_TIMEOUTS, recoveryHint } from "../command-health.js";
import type { CommandTimeoutInfo } from "@ma-browser/shared";

const info = (kind: CommandTimeoutInfo["kind"]): CommandTimeoutInfo => ({ kind, action: "eval", budgetMs: 1000, elapsedMs: 1000 });

describe("CommandHealth", () => {
  it("starts ok with no history", () => {
    const h = new CommandHealth();
    const snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.state, "ok");
    assert.equal(snap.hint, undefined);
    assert.equal(snap.lastCommandAt, null);
  });

  it("is disconnected when CDP is down, whatever else happens", () => {
    const h = new CommandHealth();
    assert.equal(h.snapshot({ cdpConnected: false }).state, "disconnected");
    assert.match(h.snapshot({ cdpConnected: false }).hint ?? "", /not connected/);
  });

  it("tracks success, timeouts and orphaned commands", () => {
    let now = 1_000;
    const h = new CommandHealth(() => now);
    const ok = h.start("snapshot", "s1");
    now += 10;
    h.finish(ok, true);
    let snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.lastSuccessAt, 1_010);

    const t = h.start("eval", "s1");
    now += 1_000;
    h.timedOut(t, info("cdp"), "timed out", true);
    snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.state, "degraded");
    assert.equal(snap.orphanedCommands, 1);
    assert.deepEqual(snap.inflight, [{ action: "eval", sessionId: "s1", ageMs: 1_000, orphaned: true }]);
    assert.match(snap.hint ?? "", /CDP/);

    // The orphan's late result neither counts as success nor resets the streak.
    h.finish(t, true);
    snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.orphanedCommands, 0);
    assert.equal(snap.consecutiveTimeouts, 1);
    assert.equal(snap.lastSuccessAt, 1_010);
  });

  it(`is stalled after ${STALLED_AFTER_TIMEOUTS} consecutive timeouts and recovers on success`, () => {
    const h = new CommandHealth();
    for (let i = 0; i < STALLED_AFTER_TIMEOUTS; i++) h.timedOut(h.start("eval", "s"), info("queue"), "q", false);
    let snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.state, "stalled");
    assert.equal(snap.timeouts.queue, STALLED_AFTER_TIMEOUTS);
    assert.match(snap.hint ?? "", /queued/);
    h.finish(h.start("tab_list", "s"), true);
    snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.state, "ok");
    assert.equal(snap.consecutiveTimeouts, 0);
    assert.equal(snap.timeouts.queue, STALLED_AFTER_TIMEOUTS, "totals are kept");
  });

  it("records non-timeout failures as lastError without degrading", () => {
    const h = new CommandHealth();
    h.finish(h.start("click", "s"), false, "Element not found");
    const snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.state, "ok");
    assert.equal(snap.lastError?.message, "Element not found");
  });

  it("derives state from event-loop lag within the window", () => {
    let now = 0;
    const h = new CommandHealth(() => now);
    h.recordLag(LAG_DEGRADED_MS);
    assert.equal(h.snapshot({ cdpConnected: true }).state, "degraded");
    h.recordLag(LAG_STALLED_MS);
    const snap = h.snapshot({ cdpConnected: true });
    assert.equal(snap.state, "stalled");
    assert.match(snap.hint ?? "", /event loop/);
    now += 60_000;
    h.recordLag(0);
    assert.equal(h.snapshot({ cdpConnected: true }).state, "ok", "old samples age out");
  });

  it("has a hint for every timeout kind", () => {
    for (const kind of ["cdp_connect", "queue", "cdp", "dispatch", undefined] as const) {
      assert.ok(recoveryHint("degraded", kind).length > 20);
    }
  });
});
