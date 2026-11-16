/**
 * Issue #44: discovery must tell "not installed", "empty", "unreadable" and
 * "no match" apart instead of returning a bare [] for all of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_CATALOG_DIAGNOSTICS,
  SITE_UPDATE_ACTION,
  adapterNotFound,
  isAdapterCatalogResult,
  loadAdapterCatalog,
  loadAdapters,
  queryAdapterCatalog,
  type CatalogFs,
} from "../site-adapters.js";

const TWEETS = `/* @meta\n{"name":"twitter/tweets","description":"User tweets","domain":"x.com","args":{"screen_name":{"required":true},"count":{}}}\n*/\nasync function(args) { return args; }`;

function home() {
  const root = mkdtempSync(join(tmpdir(), "ma-catalog-"));
  return { root, local: join(root, "sites"), community: join(root, "bb-sites") };
}

function write(dir: string, rel: string, content: string) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function eaccesOn(path: string, op: "readdir" | "readFile"): CatalogFs {
  const fail = () => Object.assign(new Error(`EACCES: permission denied, ${op} '${path}'`), { code: "EACCES" });
  return {
    readdirSync: ((p: string, o: unknown) => {
      if (op === "readdir" && p === path) throw fail();
      return readdirSync(p, o as never);
    }) as CatalogFs["readdirSync"],
    readFileSync: ((p: string, o: unknown) => {
      if (op === "readFile" && p === path) throw fail();
      return readFileSync(p, o as never);
    }) as CatalogFs["readFileSync"],
  };
}

test("both directories missing → not_installed with site update action, nothing created", () => {
  const h = home();
  try {
    const result = queryAdapterCatalog(loadAdapterCatalog(h.local, h.community), { domain: "x.com" });
    assert.equal(result.status, "not_installed");
    assert.deepEqual(result.adapters, []);
    assert.equal(result.total, 0);
    assert.equal(result.action, SITE_UPDATE_ACTION);
    assert.deepEqual(result.sources.map((s) => s.status), ["missing", "missing"]);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(readdirSync(h.root), [], "discovery must not create directories");
    assert.ok(isAdapterCatalogResult(result));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("existing but empty directories → empty, not not_installed", () => {
  const h = home();
  try {
    mkdirSync(h.local);
    mkdirSync(h.community);
    const result = queryAdapterCatalog(loadAdapterCatalog(h.local, h.community));
    assert.equal(result.status, "empty");
    assert.equal(result.action, "", "an existing community dir cannot be fixed by a blind clone");
    assert.deepEqual(result.sources.map((s) => s.status), ["empty", "empty"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("installed library: domain-only search finds twitter/tweets; unmatched query is no_match", () => {
  const h = home();
  try {
    write(h.community, "twitter/tweets.js", TWEETS);
    const catalog = loadAdapterCatalog(h.local, h.community);

    const byDomain = queryAdapterCatalog(catalog, { domain: "x.com" }, 7);
    assert.equal(byDomain.status, "ok");
    assert.deepEqual(byDomain.adapters.map((a) => a.name), ["twitter/tweets"]);
    assert.equal(byDomain.cacheAge, 7);

    const byName = queryAdapterCatalog(catalog, { q: "twitter" });
    assert.deepEqual(byName.adapters.map((a) => a.name), ["twitter/tweets"]);

    const none = queryAdapterCatalog(catalog, { q: "zzz-nothing" });
    assert.equal(none.status, "no_match");
    assert.equal(none.total, 1, "total counts the whole catalog, not the matches");
    assert.equal(none.action, "");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("private adapters only: ok, and the missing community library is still reported", () => {
  const h = home();
  try {
    write(h.local, "mine/feed.js", `/* @meta\n{"name":"mine/feed","domain":"mine.test"}\n*/\nasync function() {}`);
    const catalog = loadAdapterCatalog(h.local, h.community);
    const all = queryAdapterCatalog(catalog);
    assert.equal(all.status, "ok");
    assert.match(all.hint, /community/);
    assert.deepEqual(all.sources.map((s) => [s.source, s.status]), [["local", "ok"], ["community", "missing"]]);

    const miss = queryAdapterCatalog(catalog, { domain: "x.com" });
    assert.equal(miss.status, "no_match");
    assert.equal(miss.action, SITE_UPDATE_ACTION, "community may have it");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("unreadable root → degraded with errno diagnostics, not missing", () => {
  const h = home();
  try {
    mkdirSync(h.community);
    const result = queryAdapterCatalog(loadAdapterCatalog(h.local, h.community, eaccesOn(h.community, "readdir")));
    assert.equal(result.status, "degraded");
    const community = result.sources.find((s) => s.source === "community")!;
    assert.equal(community.status, "error");
    assert.equal(community.skipped, 1);
    assert.equal(result.diagnostics[0].code, "EACCES");
    assert.equal(result.diagnostics[0].path, h.community);
    assert.match(result.diagnostics[0].hint, /[Pp]ermission/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a file in place of the library directory (ENOTDIR) is degraded, not missing", () => {
  const h = home();
  try {
    writeFileSync(h.community, "not a dir");
    const result = queryAdapterCatalog(loadAdapterCatalog(h.local, h.community));
    assert.equal(result.status, "degraded");
    assert.equal(result.diagnostics[0].code, "ENOTDIR");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("one unreadable file keeps the readable adapters but marks the result degraded", () => {
  const h = home();
  try {
    write(h.community, "twitter/tweets.js", TWEETS);
    write(h.community, "twitter/user.js", TWEETS.replace("twitter/tweets", "twitter/user"));
    const broken = join(h.community, "twitter", "user.js");
    const result = queryAdapterCatalog(loadAdapterCatalog(h.local, h.community, eaccesOn(broken, "readFile")), { q: "zzz" });
    assert.equal(result.status, "degraded", "a zero-match over an incomplete scan is not a trustworthy no_match");
    assert.equal(result.total, 1);
    assert.equal(result.sources[1].adapterCount, 1);
    assert.equal(result.sources[1].skipped, 1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("diagnostics are capped and flagged as truncated; skipped keeps the full count", () => {
  const h = home();
  try {
    const n = MAX_CATALOG_DIAGNOSTICS + 5;
    for (let i = 0; i < n; i++) write(h.community, `s${i}/a.js`, TWEETS.replace("twitter/tweets", `s${i}/a`));
    const fs: CatalogFs = {
      readdirSync,
      readFileSync: (() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }) as unknown as CatalogFs["readFileSync"],
    };
    const result = queryAdapterCatalog(loadAdapterCatalog(h.local, h.community, fs));
    assert.equal(result.diagnostics.length, MAX_CATALOG_DIAGNOSTICS);
    assert.equal(result.truncated, true);
    assert.equal(result.sources[1].skipped, n);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("adapterNotFound points at site update when nothing is installed, else suggests names", () => {
  const h = home();
  try {
    const empty = adapterNotFound(loadAdapterCatalog(h.local, h.community), "twitter/tweets");
    assert.equal(empty.status, "not_installed");
    assert.equal(empty.action, SITE_UPDATE_ACTION);

    write(h.community, "twitter/tweets.js", TWEETS);
    const near = adapterNotFound(loadAdapterCatalog(h.local, h.community), "twitter/tweet", ["twitter/tweets"]);
    assert.equal(near.status, "ok");
    assert.match(near.hint, /twitter\/tweets/);
    assert.equal(near.action, "");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("loadAdapters keeps its array contract", () => {
  const h = home();
  try {
    write(h.community, "twitter/tweets.js", TWEETS);
    assert.deepEqual(loadAdapters(h.local, h.community).map((a) => a.name), ["twitter/tweets"]);
    assert.deepEqual(loadAdapters(join(h.root, "x"), join(h.root, "y")), []);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("isAdapterCatalogResult rejects a pre-#44 daemon response", () => {
  assert.equal(isAdapterCatalogResult({ adapters: [], total: 0, cacheAge: 0 }), false);
  assert.equal(isAdapterCatalogResult([]), false);
  assert.equal(isAdapterCatalogResult({ adapters: [], sources: [], total: 0, status: "weird" }), false);
});
