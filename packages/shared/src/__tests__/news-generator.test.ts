import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateNewsPackage, healNewsPackage, readNewsManifest } from "../news-generator.js";
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
