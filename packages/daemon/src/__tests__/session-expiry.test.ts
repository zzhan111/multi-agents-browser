import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, expireIdleSessions } from "../session-state.js";
import { TabStateManager } from "../tab-state.js";

test("idle sessions expire and release the tab leases they hold", () => {
  const sessions = new SessionManager();
  const tabs = new TabStateManager();
  const stale = tabs.addTab("AAAA0000000000000000000000000001");
  const active = tabs.addTab("AAAA0000000000000000000000000002");
  sessions.getOrCreate("gone-agent").lastSeen = 1_000;
  sessions.getOrCreate("busy-agent").lastSeen = 9_000;
  Object.assign(stale, { leaseOwner: "gone-agent", leaseMode: "exclusive" });
  Object.assign(active, { leaseOwner: "busy-agent", leaseMode: "exclusive" });

  const removed = expireIdleSessions(sessions, tabs.allTabs(), 5_000, 10_000);

  assert.deepEqual(removed, ["gone-agent"]);
  assert.deepEqual(sessions.all().map((s) => s.id), ["busy-agent"]);
  assert.deepEqual([stale.leaseOwner, stale.leaseMode], [undefined, "shared"]);
  assert.deepEqual([active.leaseOwner, active.leaseMode], ["busy-agent", "exclusive"]);
});
