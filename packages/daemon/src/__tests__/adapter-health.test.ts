/**
 * M3 adapter health (H1–H5, U3). No Chrome.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../state-store.js";
import { AdapterCache } from "../adapter-cache.js";
import {
  AdapterHealthStore,
  ADAPTER_HEALTH_FILENAME,
  applySiteRunHealth,
  adapterHealthAdvice,
  defaultAdapterHealthFailThreshold,
  extractHttpStatus,
  isAdapterAuthError,
  unknownHealth,
} from "../adapter-health.js";
import { queryCatalog, type SiteAdapter } from "../site-catalog.js";
import type { AdapterHealthStatus } from "@ma-browser/shared";

function adapter(name: string, domain = "www.example.com"): SiteAdapter {
  return {
    name,
    description: `${name} adapter`,
    domain,
    args: {},
    readOnly: true,
    source: "local",
    filePath: `${name}.js`,
  };
}

describe("adapter health store (H1)", () => {
  let dir: string;
  let now: number;
  let health: AdapterHealthStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bb-adapter-health-"));
    now = Date.parse("2026-09-10T00:00:00.000Z");
    health = new AdapterHealthStore({
      store: new StateStore(dir),
      now: () => now,
      failThreshold: 3,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("unknown when never run", () => {
    assert.deepEqual(health.view(adapter("example/search")), unknownHealth());
    assert.equal(health.statusOf("example/search"), "unknown");
  });

  it("success writes healthy and persists", () => {
    const rec = health.record("example/search", { type: "success" });
    assert.equal(rec.status, "healthy");
    assert.equal(rec.consecutiveFails, 0);
    assert.equal(rec.lastOkAt, "2026-09-10T00:00:00.000Z");

    const disk = JSON.parse(
      readFileSync(path.join(dir, ADAPTER_HEALTH_FILENAME), "utf8"),
    ) as Record<string, { status: string }>;
    assert.equal(disk["example/search"].status, "healthy");

    const restored = new AdapterHealthStore({
      store: new StateStore(dir),
      now: () => now,
    });
    assert.equal(restored.statusOf("example/search"), "healthy");
    assert.equal(restored.view(adapter("example/search")).lastOkAt, rec.lastOkAt);
  });

  it("auth failure is degraded; 3 consecutive failures become broken", () => {
    health.record("twitter/search", {
      type: "error",
      error: "HTTP 401",
      hint: "Not logged in?",
    });
    assert.equal(health.statusOf("twitter/search"), "degraded");
    assert.equal(health.get("twitter/search")?.consecutiveFails, 1);
    assert.equal(health.get("twitter/search")?.lastHttpStatus, 401);

    now += 1000;
    health.record("twitter/search", { type: "error", error: "HTTP 403" });
    assert.equal(health.statusOf("twitter/search"), "degraded");
    assert.equal(health.get("twitter/search")?.consecutiveFails, 2);

    now += 1000;
    health.record("twitter/search", { type: "error", error: "unauthorized" });
    assert.equal(health.statusOf("twitter/search"), "broken");
    assert.equal(health.get("twitter/search")?.consecutiveFails, 3);
  });

  it("structural failure is broken immediately", () => {
    health.record("example/search", {
      type: "error",
      error: "Adapter execution failed: boom",
      structural: true,
    });
    assert.equal(health.statusOf("example/search"), "broken");
    assert.equal(health.get("example/search")?.consecutiveFails, 1);
  });

  it("non-auth failure under threshold is unknown, then broken at threshold", () => {
    health.record("example/search", { type: "error", error: "HTTP 500" });
    assert.equal(health.statusOf("example/search"), "unknown");
    health.record("example/search", { type: "error", error: "HTTP 500" });
    assert.equal(health.statusOf("example/search"), "unknown");
    health.record("example/search", { type: "error", error: "HTTP 500" });
    assert.equal(health.statusOf("example/search"), "broken");
  });

  it("one success returns status to healthy (U3.3)", () => {
    health.record("example/search", { type: "error", error: "HTTP 401", hint: "login" });
    health.record("example/search", { type: "error", error: "HTTP 401", hint: "login" });
    health.record("example/search", { type: "error", error: "HTTP 401", hint: "login" });
    assert.equal(health.statusOf("example/search"), "broken");
    now += 1000;
    const rec = health.record("example/search", { type: "success" });
    assert.equal(rec.status, "healthy");
    assert.equal(rec.consecutiveFails, 0);
    assert.ok(rec.lastFailAt);
    assert.ok(rec.lastOkAt);
  });

  it("writes to state/ only (filename adapter-health.json)", () => {
    health.record("example/search", { type: "success" });
    assert.equal(existsSync(path.join(dir, ADAPTER_HEALTH_FILENAME)), true);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

describe("H3 hint/action", () => {
  it("degraded points at open + login for the domain", () => {
    const advice = adapterHealthAdvice("degraded", {
      name: "xueqiu/stock",
      domain: "xueqiu.com",
    });
    assert.match(advice.hint ?? "", /登录/);
    assert.equal(advice.action, "ma-browser open https://xueqiu.com");
  });

  it("broken points at site freeze", () => {
    const advice = adapterHealthAdvice("broken", { name: "example/search" });
    assert.match(advice.hint ?? "", /guide|冻结/);
    assert.equal(advice.action, "ma-browser site freeze --name example/search");
  });

  it("healthy/unknown have no hint/action", () => {
    assert.deepEqual(adapterHealthAdvice("healthy", { name: "a/b" }), {});
    assert.deepEqual(adapterHealthAdvice("unknown", { name: "a/b" }), {});
  });

  it("auth regex matches CLI 401/403/unauthorized/login", () => {
    assert.equal(isAdapterAuthError("HTTP 401", "Not logged in?"), true);
    assert.equal(isAdapterAuthError("forbidden"), true);
    assert.equal(isAdapterAuthError("HTTP 500"), false);
    assert.equal(extractHttpStatus("HTTP 403"), 403);
  });
});

describe("H4 broken invalidates result cache, does not delete adapters", () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bb-health-cache-"));
    now = Date.parse("2026-09-10T00:00:00.000Z");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("broken drops that name's cache entries and leaves files + other names", () => {
    const cacheDir = path.join(dir, "cache");
    const sitesDir = path.join(dir, "sites", "example");
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(sitesDir, { recursive: true });
    const filePath = path.join(sitesDir, "search.js");
    writeFileSync(filePath, "async function() { return { ok: true }; }\n");
    const otherPath = path.join(dir, "other.js");
    writeFileSync(otherPath, "async function() { return { ok: true }; }\n");

    const cache = new AdapterCache({
      dir: cacheDir,
      now: () => now,
      defaultTtlSecs: 300,
    });
    const target: SiteAdapter = {
      name: "example/search",
      description: "search",
      domain: "www.example.com",
      args: { q: { required: true } },
      readOnly: true,
      source: "local",
      filePath,
    };
    const other: SiteAdapter = {
      name: "other/hot",
      description: "hot",
      domain: "other.example.com",
      args: { q: { required: true } },
      readOnly: true,
      source: "local",
      filePath: otherPath,
    };
    cache.store(target, { q: "a" }, { ok: 1 });
    cache.store(other, { q: "a" }, { ok: 2 });
    assert.equal(cache.count(), 2);

    const health = new AdapterHealthStore({
      store: new StateStore(dir),
      now: () => now,
      failThreshold: 3,
    });
    const degraded = applySiteRunHealth({
      health,
      cache,
      adapter: target,
      outcome: { type: "error", error: "HTTP 401", hint: "login" },
    });
    assert.equal(degraded.record.status, "degraded");
    assert.equal(degraded.cacheInvalidated, 0);
    assert.equal(cache.count(), 2);

    const broken = applySiteRunHealth({
      health,
      cache,
      adapter: target,
      outcome: { type: "error", error: "Adapter returned non-JSON", structural: true },
    });
    assert.equal(broken.record.status, "broken");
    assert.equal(broken.cacheInvalidated, 1);
    assert.equal(cache.lookup(target, { q: "a" }), null);
    assert.ok(cache.lookup(other, { q: "a" }));
    assert.equal(existsSync(filePath), true, "must not delete adapter files");
    assert.equal(existsSync(otherPath), true);
  });
});

describe("H5 recommend ranking: heat primary, health secondary", () => {
  it("does not rank broken above healthy at the same heat", () => {
    const adapters = [
      adapter("ex/broken", "example.com"),
      adapter("ex/healthy", "example.com"),
      adapter("ex/unknown", "example.com"),
    ];
    const results = queryCatalog(adapters, {
      recentCallHeat: new Map([
        ["ex/broken", 5],
        ["ex/healthy", 5],
        ["ex/unknown", 5],
      ]),
      healthByName: new Map<string, AdapterHealthStatus>([
        ["ex/broken", "broken"],
        ["ex/healthy", "healthy"],
      ]),
    });
    assert.deepEqual(
      results.map((item) => item.name),
      ["ex/healthy", "ex/unknown", "ex/broken"],
    );
  });

  it("heat still wins when a broken adapter is hotter", () => {
    const adapters = [
      adapter("ex/healthy", "example.com"),
      adapter("ex/broken", "example.com"),
    ];
    const results = queryCatalog(adapters, {
      recentCallHeat: new Map([
        ["ex/broken", 8],
        ["ex/healthy", 2],
      ]),
      healthByName: new Map<string, AdapterHealthStatus>([
        ["ex/broken", "broken"],
        ["ex/healthy", "healthy"],
      ]),
    });
    assert.deepEqual(
      results.map((item) => item.name),
      ["ex/broken", "ex/healthy"],
    );
  });
});

describe("env threshold", () => {
  it("defaults to 3; rejects 0/NaN", () => {
    assert.equal(defaultAdapterHealthFailThreshold({}), 3);
    assert.equal(defaultAdapterHealthFailThreshold({ BB_ADAPTER_HEALTH_FAIL_THRESHOLD: "5" }), 5);
    assert.equal(defaultAdapterHealthFailThreshold({ BB_ADAPTER_HEALTH_FAIL_THRESHOLD: "0" }), 3);
    assert.equal(defaultAdapterHealthFailThreshold({ BB_ADAPTER_HEALTH_FAIL_THRESHOLD: "-1" }), 3);
  });
});
