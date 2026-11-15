/** #44: MCP discovery returns install status and never falls back across a remote boundary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdapterCatalog, queryAdapterCatalog, type DaemonInfo } from "@ma-browser/shared";
import { discoverSiteCatalog, STALE_DAEMON_HINT, type SiteDiscoveryDeps } from "../site-discovery.js";

const local: DaemonInfo = { host: "127.0.0.1", port: 1234, pid: 1, token: "t" };
const offline = async () => { throw new TypeError("fetch failed"); };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ma-mcp-sites-"));
  const sites = join(root, "sites");
  mkdirSync(sites);
  writeFileSync(join(sites, "tweets.js"), `/* @meta {"name":"twitter/tweets","domain":"x.com"} */ async function(){}`);
  writeFileSync(join(sites, "other.js"), `/* @meta {"name":"other/user","domain":"other.test"} */ async function(){}`);
  return { root, catalog: loadAdapterCatalog(sites, join(root, "bb-sites")) };
}

function deps(over: Partial<SiteDiscoveryDeps>): SiteDiscoveryDeps {
  return {
    info: local,
    connectOnly: false,
    baseUrl: (i) => `http://${i.host}:${i.port}`,
    headers: () => ({}),
    localCatalog: async () => { throw new Error("must not fall back"); },
    ...over,
  };
}

test("daemon and offline-CLI paths agree, including domain-only search", async () => {
  const { root, catalog } = fixture();
  try {
    const cliOutput = queryAdapterCatalog(catalog);
    const viaCli = await discoverSiteCatalog({ domain: "x.com" }, deps({ fetch: offline, localCatalog: async () => cliOutput }));
    assert.deepEqual(viaCli.adapters.map((a) => a.name), ["twitter/tweets"]);
    assert.equal(viaCli.total, 2);

    const viaDaemon = await discoverSiteCatalog({ domain: "x.com" }, deps({
      fetch: (async (url: string) => {
        const u = new URL(url);
        assert.equal(u.searchParams.get("invalidate"), "1", "explicit discovery must rescan");
        return new Response(JSON.stringify(queryAdapterCatalog(catalog, { domain: u.searchParams.get("domain") ?? undefined })));
      }) as typeof fetch,
    }));
    assert.deepEqual(viaDaemon, JSON.parse(JSON.stringify(viaCli)), "same payload over HTTP as from the CLI");

    const none = await discoverSiteCatalog({ q: "zzz" }, deps({ fetch: offline, localCatalog: async () => cliOutput }));
    assert.equal(none.status, "no_match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote, connect-only, HTTP errors and stale daemons never fall back to local directories", async () => {
  let fallbacks = 0;
  const counting = { localCatalog: async () => { fallbacks++; return {}; } };
  await assert.rejects(discoverSiteCatalog({}, deps({ ...counting, info: { ...local, host: "192.0.2.1" }, fetch: offline })), /not read locally/);
  await assert.rejects(discoverSiteCatalog({}, deps({ ...counting, connectOnly: true, fetch: offline })), /not read locally/);
  await assert.rejects(discoverSiteCatalog({}, deps({ ...counting, info: null, connectOnly: true })), /connect-only/);
  await assert.rejects(discoverSiteCatalog({}, deps({ ...counting, info: null, hostOverride: "192.0.2.1" })), /BB_DAEMON_HOST/);
  for (const status of [401, 403, 500]) {
    await assert.rejects(
      discoverSiteCatalog({}, deps({ ...counting, fetch: (async () => new Response("{}", { status })) as typeof fetch })),
      new RegExp(`HTTP ${status}`),
    );
  }
  const preIssue44 = (async () => new Response(JSON.stringify({ adapters: [], total: 0, cacheAge: 0 }))) as typeof fetch;
  await assert.rejects(discoverSiteCatalog({}, deps({ ...counting, fetch: preIssue44 })), { message: STALE_DAEMON_HINT });
  assert.equal(fallbacks, 0);

  await assert.rejects(discoverSiteCatalog({}, deps({ info: null, localCatalog: async () => [] })), /without install status/);
});
