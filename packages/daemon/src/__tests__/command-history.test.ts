import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CommandHistory } from "../command-history.js";

describe("CommandHistory", () => {
  it("derives recency-weighted adapter heat from the 200-entry ring", () => {
    const history = new CommandHistory();
    history.record("site_run", { name: "alpha/search" }, "agent-a")(true, "a001");
    history.record("site_run", { name: "beta/search" }, "agent-b")(true, "b001");
    history.record("site_run", { name: "alpha/search" }, "agent-a")(true, "a001");

    const heat = history.siteHeat();
    assert.equal(heat.get("alpha/search"), 4);
    assert.equal(heat.get("beta/search"), 2);
  });

  it("keeps tab and command sequence attribution for errors", () => {
    const history = new CommandHistory();
    const finish = history.record("click", { ref: "e1" }, "agent-a");
    finish(false, "cafe");

    const [record] = history.recent(1);
    assert.equal(record.seq, 1);
    assert.equal(record.tab, "cafe");
    assert.equal(record.sessionId, "agent-a");
    assert.equal(record.status, "error");
  });

  it("does not retain adapter heat after the 200-entry ring evicts it", () => {
    const history = new CommandHistory();
    history.record("site_run", { name: "evicted/search" });
    for (let i = 0; i < 200; i++) {
      history.record("snapshot", { index: i });
    }

    assert.equal(history.recent(250).length, 200);
    assert.equal(history.siteHeat().has("evicted/search"), false);
  });
});
