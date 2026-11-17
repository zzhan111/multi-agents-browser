/** #44: `site list/search --json` always print the catalog object; misses carry hint + action. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../../dist/index.js");

function cli(home: string, args: string[]): Promise<{ code: number; data: any }> {
  return new Promise((done, reject) =>
    execFile(process.execPath, [CLI, "site", ...args, "--json"], { env: { ...process.env, BB_BROWSER_HOME: home } }, (error, stdout) => {
      try {
        done({ code: error ? (error.code as number) : 0, data: JSON.parse(stdout) });
      } catch (e) {
        reject(e);
      }
    }),
  );
}

test("CLI discovery JSON: one shape, exit 0 for list/search, exit 1 with recovery for misses", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-cli-sites-"));
  try {
    for (const args of [["list"], ["search", "twitter"]]) {
      const result = await cli(home, args);
      assert.equal(result.code, 0);
      assert.equal(result.data.status, "not_installed");
      assert.deepEqual(result.data.adapters, []);
      assert.equal(result.data.action, "ma-browser site update");
    }
    for (const action of ["info", "run"]) {
      const result = await cli(home, [action, "twitter/tweets"]);
      assert.equal(result.code, 1);
      assert.equal(result.data.status, "not_installed");
      assert.equal(result.data.action, "ma-browser site update");
      assert.ok(result.data.hint);
    }

    const sites = join(home, "sites");
    mkdirSync(sites);
    mkdirSync(join(home, "bb-sites"));
    assert.equal((await cli(home, ["list"])).data.status, "empty");

    writeFileSync(join(sites, "tweets.js"), `/* @meta {"name":"twitter/tweets","domain":"x.com","args":{"screen_name":{"required":true}}} */ async function(){}`);
    assert.equal((await cli(home, ["search", "x.com"])).data.adapters[0].name, "twitter/tweets");
    const none = await cli(home, ["search", "zzz"]);
    assert.equal(none.code, 0);
    assert.equal(none.data.status, "no_match");
    assert.equal(none.data.total, 1);

    rmSync(join(home, "bb-sites"), { recursive: true });
    writeFileSync(join(home, "bb-sites"), "not a directory");
    const degraded = await cli(home, ["list"]);
    assert.equal(degraded.code, 0);
    assert.equal(degraded.data.status, "degraded");
    assert.equal(degraded.data.adapters.length, 1, "readable adapters are still listed");
    assert.equal(degraded.data.diagnostics[0].code, "ENOTDIR");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
