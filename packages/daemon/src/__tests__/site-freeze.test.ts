/**
 * M1 freeze gate: isEvalLike includes site_freeze (U5.1), no Chrome.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isEvalLike } from "../command-dispatch.js";
import { getCatalog, invalidateCatalog } from "../site-catalog.js";

describe("isEvalLike (F6)", () => {
  it("treats site_freeze as eval-like alongside eval and site_run", () => {
    assert.equal(isEvalLike({ action: "site_freeze" }), true);
    assert.equal(isEvalLike({ action: "site_run" }), true);
    assert.equal(isEvalLike({ action: "eval" }), true);
    assert.equal(isEvalLike({ action: "trace", traceCommand: "start" }), true);
    assert.equal(isEvalLike({ action: "trace", traceCommand: "stop" }), false);
    assert.equal(isEvalLike({ action: "site_list" }), false);
    assert.equal(isEvalLike({ action: "network" }), false);
  });
});

describe("site catalog freeze-draft origin (F8)", () => {
  it("exposes origin=freeze-draft from @meta.source for private drafts", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "bb-freeze-catalog-"));
    const dest = path.join(home, "sites", "example", "search.js");
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(
      dest,
      `/* @meta
{
  "name": "example/search",
  "description": "search (GET /api/search: freeze-draft)",
  "domain": "www.example.com",
  "args": {},
  "readOnly": true,
  "source": "freeze-draft"
}
*/
async function(args) { return { ok: true }; }
`,
      "utf8",
    );
    try {
      invalidateCatalog();
      const { adapters } = getCatalog(home);
      const hit = adapters.find((a) => a.name === "example/search");
      assert.ok(hit);
      assert.equal(hit.source, "local");
      assert.equal(hit.origin, "freeze-draft");
    } finally {
      invalidateCatalog();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
