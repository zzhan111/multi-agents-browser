import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { findBrowserExecutable, launchManagedBrowser } from "../browser-launcher.js";

/** A CDP-looking endpoint, so a launch attempt resolves to it instead of spawning a browser. */
async function withFakeCdp<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/json/version" ? 200 : 404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("MA_BROWSER_NO_LAUNCH=1 makes launchManagedBrowser a no-op", async (t) => {
  const previous = process.env.MA_BROWSER_NO_LAUNCH;
  t.after(() => {
    if (previous === undefined) delete process.env.MA_BROWSER_NO_LAUNCH;
    else process.env.MA_BROWSER_NO_LAUNCH = previous;
  });

  await withFakeCdp(async (port) => {
    process.env.MA_BROWSER_NO_LAUNCH = "1";
    assert.equal(await launchManagedBrowser(port), null);

    // Without the opt-out the same call adopts the reachable endpoint, which
    // proves the null above came from the opt-out. Needs an installed browser
    // to get past the executable check; nothing is spawned either way.
    if (findBrowserExecutable()) {
      delete process.env.MA_BROWSER_NO_LAUNCH;
      assert.deepEqual(await launchManagedBrowser(port), { host: "127.0.0.1", port });
    }
  });
});
