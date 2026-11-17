import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserFetcher, createTabProbe, generateNewsPackage, healNewsPackage, matchTabBase, readNewsManifest } from "../news-generator.js";
import { buildAdapterScript, loadAdapters } from "../site-adapters.js";

const BODY = "这是一篇用于验证生成器的新闻正文，内容足够长以通过正文长度检查。".repeat(4);

/** A tiny news site. `layout` switches homepage/feed/article markup to mimic a redesign. */
function newsSite(layout: "v1" | "v2") {
  let redirectTo: string | null = null;
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (redirectTo) {
      res.writeHead(301, { location: redirectTo + (req.url ?? "/").slice(1) });
      return res.end();
    }
    const send = (type: string, body: string) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (req.url === "/") {
      // v1 hides its feed (generator must fall back to common paths); v2 advertises it.
      const link = layout === "v2" ? `<link rel="alternate" type="application/rss+xml" href="/feed.xml">` : "";
      return send("text/html", `<html><head>${link}<link rel="canonical" href="${origin}/"></head><body>home</body></html>`);
    }
    if (layout === "v1" && req.url === "/rss") {
      return send("application/rss+xml", `<rss><channel>${[1, 2, 3].map((n) =>
        `<item><title><![CDATA[第${n}条 &amp; 快讯]]></title><link>${origin}/p/${n}</link><pubDate>Sat, 31 Oct 2026 0${n}:00:00 GMT</pubDate><description>摘要${n}</description></item>`).join("")}</channel></rss>`);
    }
    if (layout === "v2" && req.url === "/feed.xml") {
      return send("application/atom+xml", `<feed>${[1, 2].map((n) =>
        `<entry><title>新站第${n}条</title><link href="/articles/${n}"/><published>2026-10-31T0${n}:00:00Z</published><summary>摘要${n}</summary></entry>`).join("")}</feed>`);
    }
    const article = req.url?.match(layout === "v1" ? /^\/p\/(\d+)$/ : /^\/articles\/(\d+)$/);
    if (article) {
      const n = article[1];
      return send("text/html", layout === "v1"
        ? `<html><head><meta property="og:title" content="第${n}条 &amp; 快讯"><meta name="author" content="记者甲"></head><body><article><p>${BODY}</p></article></body></html>`
        : `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: `新站第${n}条`, author: [{ name: "记者乙" }], datePublished: "2026-10-31", articleBody: BODY })}</script></head><body></body></html>`);
    }
    res.writeHead(404);
    res.end();
  });
  return { server, moveTo: (url: string) => { redirectTo = url; } };
}

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return `http://${host}:${(server.address() as AddressInfo).port}/`;
}

/** Run an adapter through the production path (catalog → buildAdapterScript), zero LLM calls. */
async function runSite(sitesDir: string, name: string, args: string[]) {
  const adapter = loadAdapters(sitesDir, join(sitesDir, "..", "none")).find((a) => a.name === name);
  assert.ok(adapter, `adapter ${name} is in the catalog`);
  const built = buildAdapterScript(adapter, args);
  assert.ok("script" in built);
  return { adapter, result: await new Function(`return ${built.script}`)() };
}

test("news generator: generate CLI package, run the task flow, survive a domain move (PASS/FAIL judge)", async () => {
  const sitesDir = mkdtempSync(join(tmpdir(), "ma-news-"));
  const oldSite = newsSite("v1");
  const newSite = newsSite("v2");
  try {
    const oldBase = await listen(oldSite.server, "127.0.0.1");
    const newBase = await listen(newSite.server, "localhost");

    // 1. Generate: homepage hides the feed, so the self-scoring loop must try paths until all checks pass.
    const gen = await generateNewsPackage({ name: "demo-news", base: oldBase, sitesDir });
    assert.equal(gen.ok, true, JSON.stringify(gen.score));
    assert.ok(gen.tried.length > 1, "fell back past the first failing feed candidate");
    assert.equal(gen.manifest?.feedUrl, `${oldBase}rss`);

    // 2. Zero-token task flow through the site catalog: latest → article.
    const latest = await runSite(sitesDir, "demo-news/latest", ["2"]);
    assert.equal(latest.adapter.domain, "127.0.0.1");
    assert.deepEqual(latest.result.items.map((i: any) => i.title), ["第1条 & 快讯", "第2条 & 快讯"]);
    const article = await runSite(sitesDir, "demo-news/article", [latest.result.items[0].url]);
    assert.equal(article.result.title, "第1条 & 快讯");
    assert.equal(article.result.author, "记者甲");
    assert.ok(article.result.text.length >= 80);

    // 3. Healthy site: heal is a no-op.
    assert.equal((await healNewsPackage({ name: "demo-news", sitesDir })).status, "healthy");

    // 4. Domain change + redesign: old origin 301s to the new one, which has a different feed and article layout.
    oldSite.moveTo(newBase);
    const healed = await healNewsPackage({ name: "demo-news", sitesDir });
    assert.equal(healed.status, "healed", JSON.stringify(healed));
    if (healed.status !== "healed") return;
    assert.equal(healed.from, oldBase);
    assert.equal(healed.to, newBase);
    assert.deepEqual(readNewsManifest(sitesDir, "demo-news")?.history.map((h) => h.event), ["generated", "healed"]);

    // 5. Same commands, same calls, still pass after the move.
    const latest2 = await runSite(sitesDir, "demo-news/latest", []);
    assert.equal(latest2.adapter.domain, "localhost");
    assert.equal(latest2.result.items[0].url, `${newBase}articles/1`);
    const article2 = await runSite(sitesDir, "demo-news/article", [latest2.result.items[0].url]);
    assert.equal(article2.result.title, "新站第1条");
    assert.equal(article2.result.author, "记者乙");
    assert.ok(!readFileSync(join(sitesDir, "demo-news", "latest.js"), "utf8").includes(oldBase));
  } finally {
    oldSite.server.close();
    newSite.server.close();
    rmSync(sitesDir, { recursive: true, force: true });
  }
});

test("news generator refuses to write a package that fails the task flow", async () => {
  const sitesDir = mkdtempSync(join(tmpdir(), "ma-news-"));
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  try {
    const base = await listen(server, "127.0.0.1");
    const gen = await generateNewsPackage({ name: "dead", base, sitesDir });
    assert.equal(gen.ok, false);
    assert.equal(gen.files.length, 0);
    assert.equal(readNewsManifest(sitesDir, "dead"), undefined);
    assert.equal((await healNewsPackage({ name: "dead", sitesDir })).status, "broken");
  } finally {
    server.close();
    rmSync(sitesDir, { recursive: true, force: true });
  }
});

test("news package names cannot escape the sites directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ma-news-name-"));
  const sitesDir = join(root, "sites");
  const site = newsSite("v1");
  let requests = 0;
  const fetcher = (url: string, init?: RequestInit) => { requests++; return fetch(url, init); };
  try {
    const base = await listen(site.server, "127.0.0.1");
    for (const name of ["../escaped", "..", ".", "", "/absolute", "nested/name", "..\\escaped", "\0", ".. ", ".hidden", "trailing."]) {
      await assert.rejects(generateNewsPackage({ name, base, sitesDir, fetcher }), /invalid news package name/i);
      assert.throws(() => readNewsManifest(sitesDir, name), /invalid news package name/i);
      await assert.rejects(healNewsPackage({ name, sitesDir }), /invalid news package name/i);
    }
    assert.equal(requests, 0);
  } finally {
    site.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("news generator refuses existing packages even with supplied history", async () => {
  const sitesDir = mkdtempSync(join(tmpdir(), "ma-news-existing-"));
  const dir = join(sitesDir, "existing");
  mkdirSync(dir);
  writeFileSync(join(dir, "latest.js"), "user latest");
  const base = "https://news.example.test/";
  let requests = 0;
  const fetcher = async (url: string) => {
    requests++;
    if (url === base) return new Response('<link rel="alternate" type="application/rss+xml" href="/feed">');
    if (url === `${base}feed`) return new Response(`<rss><item><title>Title</title><link>${base}story</link></item></rss>`);
    return new Response(`<title>Title</title><article><p>${BODY}</p></article>`);
  };
  try {
    await assert.rejects(generateNewsPackage({ name: "existing", base, sitesDir, fetcher, history: [] }), /already exists/i);
    assert.equal(requests, 0);
    assert.equal(readFileSync(join(dir, "latest.js"), "utf8"), "user latest");
  } finally {
    rmSync(sitesDir, { recursive: true, force: true });
  }
});

test("heal rejects a manifest that names a different package", async () => {
  const sitesDir = mkdtempSync(join(tmpdir(), "ma-news-manifest-"));
  const source = join(sitesDir, "source");
  const victim = join(sitesDir, "victim");
  mkdirSync(source);
  mkdirSync(victim);
  writeFileSync(join(victim, "latest.js"), "user latest");
  writeFileSync(join(source, "_package.json"), JSON.stringify({
    name: "victim", base: "https://old.example.test/", feedUrl: "https://old.example.test/feed", history: [],
  }));
  let requests = 0;
  const fetcher = async (url: string) => {
    requests++;
    if (url === "https://old.example.test/") return new Response('<link rel="canonical" href="https://new.example.test/">');
    if (url === "https://new.example.test/") return new Response('<link rel="alternate" type="application/rss+xml" href="/feed">');
    if (url === "https://new.example.test/feed") return new Response('<rss><item><title>Title</title><link>https://new.example.test/story</link></item></rss>');
    return new Response(`<title>Title</title><article><p>${BODY}</p></article>`);
  };
  try {
    const result = await healNewsPackage({ name: "source", sitesDir, fetcher });
    assert.equal(result.status, "broken");
    assert.equal(requests, 0);
    assert.equal(readFileSync(join(victim, "latest.js"), "utf8"), "user latest");
  } finally {
    rmSync(sitesDir, { recursive: true, force: true });
  }
});

test("a malformed feed item does not block a valid fallback feed", async () => {
  const sitesDir = mkdtempSync(join(tmpdir(), "ma-news-feed-"));
  const base = "https://news.example.test/";
  const requested: string[] = [];
  let mixed = false;
  const good = `<item><title>Good</title><link>${base}story</link></item>`;
  const fetcher = async (url: string) => {
    requested.push(url);
    if (url === base) return new Response('<link rel="alternate" type="application/rss+xml" href="/broken">');
    if (url === `${base}broken`) return new Response(`<rss><item><title>Bad</title><link>http://[</link></item><item><title>No link</title></item>${mixed ? good : ""}</rss>`);
    if (url === `${base}feed`) return new Response(`<rss>${good}</rss>`);
    if (url === `${base}story`) return new Response(`<title>Good</title><article><p>${BODY}</p></article>`);
    return new Response("", { status: 404 });
  };
  try {
    const gen = await generateNewsPackage({ name: "valid-name", base, sitesDir, fetcher });
    assert.equal(gen.ok, true, JSON.stringify(gen.score));
    assert.ok(requested.includes(`${base}feed`));
    assert.equal(gen.manifest?.feedUrl, `${base}feed`);
    mixed = true;
    const mixedGen = await generateNewsPackage({ name: "新闻.example-1", base, sitesDir, fetcher });
    assert.equal(mixedGen.ok, true, JSON.stringify(mixedGen.score));
    assert.equal(mixedGen.manifest?.feedUrl, `${base}broken`);
  } finally {
    rmSync(sitesDir, { recursive: true, force: true });
  }
});

test("browserFetcher: a login-only news site generates through the browser session without leaking the cookie", async () => {
  const SECRET = "sid=secret-session-7f3a";
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.headers.cookie !== SECRET) { res.writeHead(401); return res.end("login required"); }
    const send = (type: string, body: string) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (req.url === "/") return send("text/html", `<link rel="alternate" type="application/rss+xml" href="/rss.xml">`);
    if (req.url === "/rss.xml") return send("application/rss+xml", `<rss><item><title>会员头条</title><link>${origin}/p/1</link></item></rss>`);
    if (req.url === "/p/1") return send("text/html", `<title>会员头条</title><article><p>${BODY}</p></article>`);
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const sitesDir = mkdtempSync(join(tmpdir(), "ma-news-auth-"));
  // Stands in for a logged-in tab: runs the page script with the browser's cookie jar.
  const origins: string[] = [];
  const evaluate = async (origin: string, script: string) => {
    origins.push(origin);
    const pageFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, headers: { cookie: SECRET } });
    return new Function("fetch", `return ${script}`)(pageFetch);
  };
  try {
    const anonymous = await generateNewsPackage({ name: "members", base, sitesDir });
    assert.equal(anonymous.ok, false, "without the browser session the site is not readable");

    const gen = await generateNewsPackage({ name: "members", base, sitesDir, fetcher: browserFetcher(evaluate) });
    assert.equal(gen.ok, true, JSON.stringify(gen.score));
    assert.ok(origins.length > 0 && origins.every((o) => o === new URL(base).origin), "every request ran in a same-origin page");
    for (const file of [...gen.files, join(sitesDir, "members", "_package.json")]) {
      assert.ok(!readFileSync(file, "utf8").includes("secret-session"), `${file} holds no credentials`);
    }
    const healed = await healNewsPackage({ name: "members", sitesDir, fetcher: browserFetcher(evaluate) });
    assert.equal(healed.status, "healthy");
  } finally {
    server.close();
    rmSync(sitesDir, { recursive: true, force: true });
  }
});

test("browserFetcher: browser-side network errors fall back, HTTP errors do not", async () => {
  const fallbackCalls: string[] = [];
  const fallback = async (url: string) => { fallbackCalls.push(url); return new Response("from node"); };
  const fetcher = browserFetcher(async (_origin, script) => new Function("fetch", `return ${script}`)(async (url: string) => {
    if (url.includes("cors")) throw new TypeError("Failed to fetch");
    return new Response(url.includes("gone") ? "" : "page", { status: url.includes("gone") ? 410 : 200, headers: { "content-type": "text/html" } });
  }), { fallback });
  assert.equal(await (await fetcher("https://a.test/cors")).text(), "from node");
  const gone = await fetcher("https://a.test/gone");
  assert.equal(gone.status, 410);
  assert.equal(gone.url, "https://a.test/gone");
  assert.deepEqual(fallbackCalls, ["https://a.test/cors"]);
});

test("browserFetcher: a hung browser or in-page timeout fails instead of falling back", async () => {
  const fallback = async () => new Response("from node");
  const hung = browserFetcher(() => new Promise(() => {}), { fallback, timeoutMs: 20 });
  await assert.rejects(hung("https://a.test/"), /timed out/);
  const aborted = browserFetcher(async () => JSON.stringify({ error: "signal timed out", name: "TimeoutError" }), { fallback });
  await assert.rejects(aborted("https://a.test/"), /timed out/);
  const down = browserFetcher(async () => { throw new Error("daemon not running"); }, { fallback });
  await assert.rejects(down("https://a.test/"), /daemon not running/);
  const strict = browserFetcher(async () => JSON.stringify({ error: "Failed to fetch", name: "TypeError" }), { fallback: null });
  await assert.rejects(strict("https://a.test/"), /Failed to fetch/);
});

function fakeTabs(initial: Array<{ id: string; url: string }>, opts: { loads?: boolean } = {}) {
  const tabs = new Map(initial.map((t) => [t.id, t.url]));
  const log = { opened: [] as string[], closed: [] as string[], evaluatedIn: [] as string[] };
  let n = 0;
  return {
    log,
    tabs,
    ops: {
      list: async () => [...tabs].map(([id, url]) => ({ id, url })),
      open: async (url: string) => { const id = `new${++n}`; tabs.set(id, opts.loads === false ? "about:blank" : url); log.opened.push(id); return id; },
      evaluate: async (id: string, script: string) => {
        if (script === "location.origin") { const u = tabs.get(id)!; return u.startsWith("http") ? new URL(u).origin : "null"; }
        log.evaluatedIn.push(id);
        return id;
      },
      close: async (id: string) => { tabs.delete(id); log.closed.push(id); },
    },
  };
}

test("createTabProbe: reuses a tab of the exact origin, opens one for another port and closes only that", async () => {
  const fake = fakeTabs([{ id: "user", url: "http://localhost:1111/old" }, { id: "exact", url: "http://localhost:2222/page" }]);
  const probe = createTabProbe(fake.ops, { pollMs: 1 });
  assert.equal(await probe.evaluate("http://localhost:2222", "x"), "exact");
  assert.equal(await probe.evaluate("http://localhost:3333", "x"), "new1", "same hostname, other port: a new tab");
  assert.equal(await probe.evaluate("http://localhost:3333", "y"), "new1", "the opened tab is reused");
  await probe.dispose();
  assert.deepEqual(fake.log.opened, ["new1"]);
  assert.deepEqual(fake.log.closed, ["new1"], "existing tabs stay open");
  assert.ok(fake.tabs.has("user") && fake.tabs.has("exact"));
});

test("createTabProbe: a tab that never reaches its origin fails within the ready timeout and is cleaned up", async () => {
  const fake = fakeTabs([], { loads: false });
  const probe = createTabProbe(fake.ops, { readyTimeoutMs: 30, pollMs: 5 });
  await assert.rejects(probe.evaluate("https://slow.test", "x"), /did not load within 30ms/);
  assert.deepEqual(fake.log.evaluatedIn, [], "nothing ran in a page of the wrong origin");
  await probe.dispose();
  assert.deepEqual(fake.log.closed, ["new1"]);
});

test("matchTabBase compares scheme, host and port", () => {
  assert.equal(matchTabBase("http://localhost:2222/a", "http://localhost:2222/"), true);
  assert.equal(matchTabBase("http://localhost:1111/a", "http://localhost:2222/"), false);
  assert.equal(matchTabBase("https://localhost:2222/a", "http://localhost:2222/"), false);
  assert.equal(matchTabBase("about:blank", "http://localhost:2222/"), false);
});

test("browserFetcher: a logged-out session (401) fails generation and keeps the existing package", async () => {
  let loggedIn = true;
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (!loggedIn) { res.writeHead(401); return res.end("login required"); }
    const send = (type: string, body: string) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (req.url === "/") return send("text/html", `<link rel="alternate" type="application/rss+xml" href="/rss.xml">`);
    if (req.url === "/rss.xml") return send("application/rss+xml", `<rss><item><title>T</title><link>${origin}/p/1</link></item></rss>`);
    if (req.url === "/p/1") return send("text/html", `<title>T</title><article><p>${BODY}</p></article>`);
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const sitesDir = mkdtempSync(join(tmpdir(), "ma-news-logout-"));
  const evaluate = async (_origin: string, script: string) => new Function("fetch", `return ${script}`)(fetch);
  try {
    assert.equal((await generateNewsPackage({ name: "m", base, sitesDir, fetcher: browserFetcher(evaluate) })).ok, true);
    const before = readFileSync(join(sitesDir, "m", "latest.js"), "utf8");
    loggedIn = false;
    const healed = await healNewsPackage({ name: "m", sitesDir, fetcher: browserFetcher(evaluate) });
    assert.equal(healed.status, "broken");
    assert.equal(readFileSync(join(sitesDir, "m", "latest.js"), "utf8"), before, "the working package is not overwritten");
  } finally {
    server.close();
    rmSync(sitesDir, { recursive: true, force: true });
  }
});
