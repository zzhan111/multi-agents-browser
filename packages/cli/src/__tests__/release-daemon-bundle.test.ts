/**
 * Release-bundle regression for GitHub issue #15.
 *
 * `pnpm build:release` inlines most deps into dist/daemon.js. CJS packages
 * like yaml (`require("process")`) and better-sqlite3 (`require("fs")`) then
 * throw `Dynamic require of "..." is not supported` before --help can run.
 *
 * Skipped when the release bundle is absent (package-only turbo test).
 * `pnpm build` / `pnpm build:release` always produce dist/daemon.js first.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const RELEASE_DAEMON = path.resolve(
  import.meta.dirname,
  "../../../../dist/daemon.js",
);

describe("release dist/daemon.js bundle (#15)", () => {
  it("node dist/daemon.js --help starts without yaml ESM dynamic require", {
    skip: !existsSync(RELEASE_DAEMON),
  }, () => {
    const result = spawnSync(process.execPath, [RELEASE_DAEMON, "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /Dynamic require of /);
    assert.match(output, /ma-browser-daemon/);
  });
});
