/**
 * M2 adapter TTL cache (K1–K6, U2). No Chrome.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SiteAdapter } from "../site-catalog.js";
import { getCatalog, invalidateCatalog } from "../site-catalog.js";
import {
  AdapterCache,
  adapterCacheKey,
  canonicalJson,
  defaultAdapterCacheTtlSecs,
  isAdapterCacheRelPath,
  isAdapterCacheable,
  sanitizeCacheResult,
  DEFAULT_ADAPTER_CACHE_TTL_SECS,
} from "../adapter-cache.js";

function adapterFile(dir: string, name = "example/search"): { filePath: string; adapter: SiteAdapter } {
  const filePath = path.join(dir, `${name.replace("/", "-")}.js`);
  writeFileSync(filePath, "async function(args) { return { ok: true }; }\n");
  const adapter: SiteAdapter = {
    name,
    description: "test",
    domain: "www.example.com",
    args: { q: { required: true } },
    readOnly: true,
    source: "local",
    filePath,
  };
  return { filePath, adapter };
}

describe("adapter TTL cache (K1–K6)", () => {
  let dir: string;
  let now: number;
  let pin: string | undefined;
  let cache: AdapterCache;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bb-adapter-cache-"));
    now = Date.parse("2026-09-10T00:00:00.000Z");
    pin = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    cache = new AdapterCache({
      dir,
      now: () => now,
      getPin: () => pin,
      defaultTtlSecs: 300,
      maxEntries: 8,
      maxEntryBytes: 8 * 1024 * 1024,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("K1: writes atomically and reads back", () => {
    const { adapter } = adapterFile(dir);
    const stored = cache.store(adapter, { q: "hello" }, { items: [1], url: "https://www.example.com/x" });
    assert.equal(stored.stored, true);
    assert.ok(stored.expiresAt);

    const hit = cache.lookup(adapter, { q: "hello" });
    assert.ok(hit);
    assert.equal(hit.cacheHit, true);
    assert.equal(hit.cacheAgeSec, 0);
    assert.equal(hit.cacheExpiresAt, stored.expiresAt);
    assert.deepEqual(hit.entry.result, { items: [1], url: "https://www.example.com/x" });

    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{64}\.json$/);
  });

  it("K1: expired entries miss and are deleted", () => {
    const { adapter } = adapterFile(dir);
    cache.store(adapter, { q: "hello" }, { ok: true });
    now += 301_000;
    assert.equal(cache.lookup(adapter, { q: "hello" }), null);
    assert.equal(cache.count(), 0);
  });

  it("K2: peek hit is the signal to skip Runtime.evaluate (U2)", () => {
    const { adapter } = adapterFile(dir);
    cache.store(adapter, { q: "hello" }, { price: "1.55%" }, { tab: "c416" });
    now += 12_000;

    const hit = cache.peek(adapter, { q: "hello" }, false);
    assert.ok(hit, "hit must skip eval");
    assert.equal(hit.cacheHit, true);
    assert.equal(hit.cacheAgeSec, 12);
    assert.equal(hit.entry.tab, "c416");
    assert.equal(typeof hit.cacheExpiresAt, "string");
    assert.ok(hit.cacheExpiresAt.endsWith("Z"));
  });

  it("K2: canonical arg key is order-insensitive", () => {
    const { adapter } = adapterFile(dir);
    adapter.args = { a: {}, b: {} };
    cache.store(adapter, { b: "2", a: "1" }, { ok: true });
    assert.ok(cache.lookup(adapter, { a: "1", b: "2" }));
    assert.equal(
      adapterCacheKey("n", { b: "2", a: "1" }, "d"),
      adapterCacheKey("n", { a: "1", b: "2" }, "d"),
    );
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("K3: write adapters are never cached", () => {
    const { adapter } = adapterFile(dir);
    adapter.readOnly = false;
    assert.equal(isAdapterCacheable(adapter, 300), false);
    const stored = cache.store(adapter, { q: "hello" }, { ok: true });
    assert.equal(stored.stored, false);
    assert.equal(stored.reason, "not-cacheable");
    assert.equal(cache.peek(adapter, { q: "hello" }, false), null);
  });

  it("K3: missing readOnly is treated as cacheable", () => {
    const { adapter } = adapterFile(dir);
    delete adapter.readOnly;
    assert.equal(isAdapterCacheable(adapter, 300), true);
  });

  it("K3: failure {error} results are not stored", () => {
    const { adapter } = adapterFile(dir);
    const stored = cache.store(adapter, { q: "hello" }, { error: "HTTP 401", hint: "login" });
    assert.equal(stored.stored, false);
    assert.equal(stored.reason, "error-result");
    assert.equal(cache.lookup(adapter, { q: "hello" }), null);
  });

  it("K3/K5: fresh bypasses lookup; store still replaces the entry (U2.4)", () => {
    const { adapter } = adapterFile(dir);
    cache.store(adapter, { q: "hello" }, { v: 1 });
    assert.equal(cache.peek(adapter, { q: "hello" }, true), null);
    now += 5_000;
    const stored = cache.store(adapter, { q: "hello" }, { v: 2 });
    assert.equal(stored.stored, true);
    const hit = cache.lookup(adapter, { q: "hello" });
    assert.deepEqual(hit?.entry.result, { v: 2 });
    assert.equal(hit?.cacheAgeSec, 0);
  });

  it("K4: adapter file mtime change invalidates", () => {
    const { adapter, filePath } = adapterFile(dir);
    const past = new Date(now - 60_000);
    utimesSync(filePath, past, past);
    cache.store(adapter, { q: "hello" }, { ok: true });
    assert.ok(cache.lookup(adapter, { q: "hello" }));

    const later = new Date(now + 1_000);
    utimesSync(filePath, later, later);
    assert.equal(cache.lookup(adapter, { q: "hello" }), null);
  });

  it("K4: site_update clears community entries and keeps private ones", () => {
    const local = adapterFile(dir, "private/search");
    const community = adapterFile(dir, "reddit/hot");
    community.adapter.source = "community";

    cache.store(local.adapter, { q: "a" }, { src: "local" });
    cache.store(community.adapter, { q: "a" }, { src: "community" });
    assert.equal(cache.count(), 2);

    const removed = cache.invalidateCommunity();
    assert.equal(removed, 1);
    assert.ok(cache.lookup(local.adapter, { q: "a" }));
    assert.equal(cache.lookup(community.adapter, { q: "a" }), null);
  });

  it("K4: community pin change misses even before invalidateCommunity", () => {
    const { adapter } = adapterFile(dir, "reddit/hot");
    adapter.source = "community";
    cache.store(adapter, { q: "a" }, { src: "community" });
    pin = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert.equal(cache.lookup(adapter, { q: "a" }), null);
  });

  it("K5: TTL=0 disables cache; per-adapter 0 never caches", () => {
    assert.equal(defaultAdapterCacheTtlSecs({}), DEFAULT_ADAPTER_CACHE_TTL_SECS);
    assert.equal(defaultAdapterCacheTtlSecs({ BB_ADAPTER_CACHE_TTL_SECS: "0" }), 0);
    assert.equal(defaultAdapterCacheTtlSecs({ BB_ADAPTER_CACHE_TTL_SECS: "120" }), 120);
    assert.equal(defaultAdapterCacheTtlSecs({ BB_ADAPTER_CACHE_TTL_SECS: "-1" }), 300);

    const disabled = new AdapterCache({
      dir,
      now: () => now,
      defaultTtlSecs: 0,
    });
    const { adapter } = adapterFile(dir);
    assert.equal(isAdapterCacheable(adapter, 0), false);
    assert.equal(disabled.store(adapter, { q: "x" }, { ok: true }).stored, false);

    adapter.cacheTtlSeconds = 0;
    const enabled = new AdapterCache({ dir, now: () => now, defaultTtlSecs: 300 });
    assert.equal(enabled.store(adapter, { q: "x" }, { ok: true }).stored, false);
  });

  it("K6: cache files never contain daemon token / Bearer / cookie keys", () => {
    const { adapter } = adapterFile(dir);
    const daemonToken = "deadbeefdeadbeefdeadbeefdeadbeef";
    cache.store(adapter, { q: "hello" }, {
      ok: true,
      token: daemonToken,
      authorization: "Bearer super-secret",
      nested: { access_token: "abc", quote: "ok" },
      note: "Authorization: Bearer leaked",
    });
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    const raw = readFileSync(path.join(dir, files[0]), "utf8");
    assert.equal(raw.includes(daemonToken), false);
    assert.equal(raw.includes("super-secret"), false);
    assert.equal(/\btoken\b/.test(raw), false);
    const parsed = JSON.parse(raw) as { result: Record<string, unknown> };
    assert.equal("token" in parsed.result, false);
    assert.equal("authorization" in parsed.result, false);
    assert.deepEqual(parsed.result.nested, { quote: "ok" });
    assert.equal(parsed.result.note, "Authorization: Bearer [redacted]");
  });

  it("K6: diagnostic zip helper skips cache/adapters", () => {
    assert.equal(isAdapterCacheRelPath("cache/adapters"), true);
    assert.equal(isAdapterCacheRelPath("cache/adapters/abc.json"), true);
    assert.equal(isAdapterCacheRelPath("cache\\adapters\\abc.json"), true);
    assert.equal(isAdapterCacheRelPath("state/agents.json"), false);
    assert.equal(isAdapterCacheRelPath("cache/adapters-backup"), false);
  });

  it("evicts oldest when over capacity", () => {
    const { adapter } = adapterFile(dir);
    adapter.args = { q: {} };
    for (let i = 0; i < 10; i++) {
      cache.store(adapter, { q: String(i) }, { i });
      now += 1_000;
    }
    assert.equal(cache.count(), 8);
    assert.equal(cache.lookup(adapter, { q: "0" }), null);
    assert.equal(cache.lookup(adapter, { q: "1" }), null);
    assert.ok(cache.lookup(adapter, { q: "9" }));
  });

  it("skips oversized entries with a warning", () => {
    const tiny = new AdapterCache({
      dir,
      now: () => now,
      defaultTtlSecs: 300,
      maxEntryBytes: 64,
    });
    const { adapter } = adapterFile(dir);
    const stored = tiny.store(adapter, { q: "hello" }, { blob: "x".repeat(200) });
    assert.equal(stored.stored, false);
    assert.equal(stored.reason, "too-large");
    assert.ok(stored.warning);
    assert.equal(tiny.lookup(adapter, { q: "hello" }), null);
  });

  it("sanitizeCacheResult drops secret keys", () => {
    assert.deepEqual(
      sanitizeCacheResult({ token: "x", Cookie: "a=b", keep: 1 }),
      { keep: 1 },
    );
  });
});

describe("site catalog cacheTtlSeconds", () => {
  it("parses @meta.cacheTtlSeconds from private adapters", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bb-cache-ttl-meta-"));
    const dest = path.join(home, "sites", "example", "search.js");
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(
      dest,
      `/* @meta
{
  "name": "example/search",
  "description": "search",
  "domain": "www.example.com",
  "args": {},
  "readOnly": true,
  "cacheTtlSeconds": 60
}
*/
async function(args) { return { ok: true }; }
`,
      { encoding: "utf8", flag: "w" },
    );
    try {
      invalidateCatalog();
      const hit = getCatalog(home).adapters.find((a) => a.name === "example/search");
      assert.ok(hit);
      assert.equal(hit.cacheTtlSeconds, 60);
    } finally {
      invalidateCatalog();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("tmp leftovers", () => {
  it("does not leave .tmp files after a successful write", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bb-cache-tmp-"));
    try {
      const { adapter } = adapterFile(dir);
      const cache = new AdapterCache({ dir, now: () => Date.now(), defaultTtlSecs: 300 });
      cache.store(adapter, { q: "x" }, { ok: true });
      const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
      assert.deepEqual(leftovers, []);
      assert.equal(existsSync(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
