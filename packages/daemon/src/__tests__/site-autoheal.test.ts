import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNewsPackage, loadAdapters, type HealResult, type SiteAdapter } from "@ma-browser/shared";
import { createAutoHealer } from "../site-autoheal.js";

const BODY = "Auto-heal fixture article body, long enough for the text check. ".repeat(3);

/** A news site that can move (301 everywhere) or drop its feed. */
function newsSite() {
  let moved: string | null = null;
  let feed = true;
  const server = createServer((req, res) => {
    if (moved) { res.writeHead(301, { location: moved + (req.url ?? "/").slice(1) }); return res.end(); }
    const base = `http://${req.headers.host}/`;
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<link rel="canonical" href="${base}">home`); }
    if (feed && req.url === "/rss.xml") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><item><title>News</title><link>${base}article</link></item></rss>`); }
    if (req.url === "/article") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<title>News</title><article><p>${BODY}</p></article>`); }
    res.writeHead(404); res.end();
  });
  return { server, moveTo: (url: string) => { moved = url; }, dropFeed: () => { feed = false; } };
}

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return `http://${host}:${(server.address() as AddressInfo).port}/`;
}

function adapter(sitesDir: string, name: string): SiteAdapter {
  const found = loadAdapters(sitesDir, join(sitesDir, "..", "none")).find((a) => a.name === name);
  assert.ok(found, `adapter ${name} is in the catalog`);
  return found;
}

describe("site auto-heal", () => {
  it("ignores hand-written adapters and community adapters", async () => {
    const sitesDir = mkdtempSync(join(tmpdir(), "ma-autoheal-"));
    mkdirSync(join(sitesDir, "mine"));
    writeFileSync(join(sitesDir, "mine", "feed.js"), `/* @meta\n{"name":"mine/feed","domain":"example.com"}\n*/\nasync function(){ return {}; }`);
    let calls = 0;
    const healer = createAutoHealer({ sitesDir, heal: async () => { calls++; return { status: "broken", reason: "x" }; } });
    const mine = adapter(sitesDir, "mine/feed");
    assert.equal(await healer.heal(mine), undefined);
    assert.equal(await healer.heal({ ...mine, source: "community" }), undefined);
    assert.equal(healer.generatedBase(mine), undefined);
    assert.equal(calls, 0, "never re-probes a package without a generator manifest");
  });

  it("heals with the fetcher of the run that started it (the browser session)", async () => {
    const sitesDir = mkdtempSync(join(tmpdir(), "ma-autoheal-"));
    mkdirSync(join(sitesDir, "gen"));
    writeFileSync(join(sitesDir, "gen", "latest.js"), `/* @meta\n{"name":"gen/latest","domain":"example.com"}\n*/\nasync function(){ return {}; }`);
    writeFileSync(join(sitesDir, "gen", "_package.json"), JSON.stringify({ name: "gen", base: "http://example.com/" }));
    const browser = async () => new Response("from the browser");
    let used: unknown;
    const healer = createAutoHealer({ sitesDir, heal: async ({ fetcher }) => { used = fetcher; return { status: "broken", reason: "x" }; } });
    await healer.heal(adapter(sitesDir, "gen/latest"), browser);
    assert.equal(used, browser);
  });

  it("shares one heal across concurrent failures and cools down between attempts", async () => {
    const sitesDir = mkdtempSync(join(tmpdir(), "ma-autoheal-"));
    mkdirSync(join(sitesDir, "gen"));
    writeFileSync(join(sitesDir, "gen", "latest.js"), `/* @meta\n{"name":"gen/latest","domain":"example.com"}\n*/\nasync function(){ return {}; }`);
    writeFileSync(join(sitesDir, "gen", "_package.json"), JSON.stringify({ name: "gen", base: "http://example.com/" }));
    let clock = 0;
    const names: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const healer = createAutoHealer({
      sitesDir,
      now: () => clock,
      cooldownMs: 1000,
      heal: async ({ name }) => { names.push(name); await gate; return { status: "broken", reason: "still broken" } as HealResult; },
    });
    const gen = adapter(sitesDir, "gen/latest");
    assert.equal(healer.generatedBase(gen), "http://example.com/");
    const both = Promise.all([healer.heal(gen), healer.heal(gen)]);
    release();
    const [a, b] = await both;
    assert.equal(a?.status, "broken");
    assert.equal(b, a, "concurrent failures share the in-flight heal");
    clock = 999;
    assert.equal(await healer.heal(gen), undefined, "no re-probe inside the cooldown");
    clock = 1000;
    assert.equal((await healer.heal(gen))?.status, "broken");
    assert.deepEqual(names, ["gen", "gen"]);
  });

  it("heals a generated package after a domain move and keeps a working package when healing fails", async () => {
    const sitesDir = mkdtempSync(join(tmpdir(), "ma-autoheal-"));
    const oldSite = newsSite();
    const newSite = newsSite();
    try {
      const oldBase = await listen(oldSite.server, "127.0.0.1");
      const newBase = await listen(newSite.server, "localhost");
      assert.equal((await generateNewsPackage({ name: "auto-news", base: oldBase, sitesDir })).ok, true);
      const healer = createAutoHealer({ sitesDir, cooldownMs: 0 });

      oldSite.moveTo(newBase);
      const moved = await healer.heal(adapter(sitesDir, "auto-news/latest"));
      assert.equal(moved?.status, "healed");
      assert.equal(adapter(sitesDir, "auto-news/latest").domain, "localhost");
      assert.equal(healer.generatedBase(adapter(sitesDir, "auto-news/latest")), newBase);

      // Unrecoverable change: no feed anywhere. Heal must fail loudly and leave the package untouched.
      const before = readFileSync(join(sitesDir, "auto-news", "latest.js"), "utf8");
      newSite.dropFeed();
      const broken = await healer.heal(adapter(sitesDir, "auto-news/latest"));
      assert.equal(broken?.status, "broken");
      assert.equal(readFileSync(join(sitesDir, "auto-news", "latest.js"), "utf8"), before);
    } finally {
      oldSite.server.close();
      newSite.server.close();
    }
  });
});
