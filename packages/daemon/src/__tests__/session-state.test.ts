import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session-state.js";

describe("session security defaults", () => {
  it("defaults new sessions to no-eval", () => {
    const session = new SessionManager().getOrCreate("agent-1");
    assert.equal(session.scope, "no-eval");
  });

  it("requires an explicit full scope", () => {
    const session = new SessionManager().getOrCreate("agent-1", undefined, "full");
    assert.equal(session.scope, "full");
  });

  it("allows tightening but never widening an existing session", () => {
    const manager = new SessionManager();
    assert.equal(manager.getOrCreate("agent-1", undefined, "full").scope, "full");
    assert.equal(manager.getOrCreate("agent-1", undefined, "no-eval").scope, "no-eval");
    assert.equal(manager.getOrCreate("agent-1", undefined, "full").scope, "no-eval");
  });
});
