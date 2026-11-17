/**
 * #44: daemon discovery and exact-name lookups see adapters installed by
 * another process (e.g. `ma-browser site update` in a terminal) without
 * waiting for the 60s cache TTL, and misses explain how to recover.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpConnection } from "../cdp-connection.js";

test("site_list/site_info/site_run report install status and pick up external installs", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-daemon-catalog-"));
  const previous = process.env.BB_BROWSER_HOME;
  process.env.BB_BROWSER_HOME = home; // read when shared's path constants load, so import afterwards
  try {
    const { dispatchRequest } = await import("../command-dispatch.js");
    const { getCatalog, invalidateCatalog } = await import("../site-catalog.js");
    invalidateCatalog();
    const cdp = {} as CdpConnection; // no browser: anything that needs a page fails

    const list = await dispatchRequest(cdp, { id: "1", action: "site_list" });
    assert.equal((list.data as any).status, "not_installed");
    assert.deepEqual((list.data as any).adapters, []);

    const run = await dispatchRequest(cdp, { id: "2", action: "site_run", name: "twitter/tweets" });
    assert.equal(run.success, false);
    assert.equal(run.action, "ma-browser site update");
    assert.ok(run.hint);

    const sites = join(home, "sites");
    mkdirSync(sites);
    const install = (file: string, name: string) =>
      writeFileSync(join(sites, file), `/* @meta {"name":"${name}","domain":"x.com","args":{"screen_name":{"required":true}}} */ async function(){}`);
    install("tweets.js", "twitter/tweets");
    assert.equal(getCatalog().adapters.length, 0, "cache still holds the old snapshot");

    const info = await dispatchRequest(cdp, { id: "3", action: "site_info", name: "twitter/tweets" });
    assert.equal(info.success, true, "an exact-name miss rescans once");
    assert.equal((info.data as any).args.screen_name.required, true);

    install("user.js", "twitter/user");
    const search = await dispatchRequest(cdp, { id: "4", action: "site_search", query: "", domain: "x.com" });
    assert.deepEqual((search.data as any).adapters.map((a: { name: string }) => a.name), ["twitter/tweets", "twitter/user"], "explicit discovery rescans");

    const near = await dispatchRequest(cdp, { id: "5", action: "site_info", name: "twitter" });
    assert.equal(near.success, false);
    assert.match(near.hint!, /twitter\/tweets/);
    invalidateCatalog();
  } finally {
    if (previous === undefined) delete process.env.BB_BROWSER_HOME;
    else process.env.BB_BROWSER_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
