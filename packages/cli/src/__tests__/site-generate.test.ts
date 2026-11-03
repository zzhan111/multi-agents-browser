/**
 * `ma-browser site generate` / `site heal` — the CLI entry of the news-site
 * package generator. Drives the real CLI as a subprocess against a local
 * fixture news site: generate → run the task flow from the catalog → domain
 * move → heal → run again. No daemon or Chrome needed for generate/heal.
 * Uses the compiled dist (the pre-commit hook builds before tests).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAdapterScript, loadAdapters } from "@ma-browser/shared";

const CLI = resolve(import.meta.dirname, "../../dist/index.js");
const BODY = "用于验证 site generate 命令的新闻正文，长度足以通过正文检查。".repeat(4);

function newsSite(articlePath: string) {
  let redirectTo: string | null = null;
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (redirectTo) {
      res.writeHead(301, { location: redirectTo + (req.url ?? "/").slice(1) });
      return res.end();
    }
    const send = (type: string, body: string) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (req.url === "/") return send("text/html", `<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>`);
    if (req.url === "/rss.xml") {
      return send("application/rss+xml", `<rss><channel><item><title>头条</title><link>${origin}${articlePath}1</link></item></channel></rss>`);
    }
    if (req.url === `${articlePath}1`) {
      return send("text/html", `<html><head><meta property="og:title" content="头条"></head><body><article><p>${BODY}</p></article></body></html>`);
    }
    res.writeHead(404);
    res.end();
  });
  return { server, moveTo: (url: string) => { redirectTo = url; } };
}

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((done) => server.listen(0, host, done));
  return `http://${host}:${(server.address() as AddressInfo).port}/`;
}

function cli(home: string, args: string[]): Promise<{ code: number; json: any; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, BB_BROWSER_HOME: home } }, (err, stdout, stderr) => {
      let json: any = null;
      try { json = JSON.parse(stdout); } catch { /* not JSON */ }
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, json, stderr });
    });
  });
}

async function runSite(home: string, name: string, args: string[]) {
  const sitesDir = join(home, "sites");
  const adapter = loadAdapters(sitesDir, join(home, "none")).find((a) => a.name === name);
  assert.ok(adapter, `${name} is in the catalog`);
  const built = buildAdapterScript(adapter, args);
  assert.ok("script" in built);
  return { adapter, result: await new Function(`return ${built.script}`)() };
}

test("site generate + site heal: CLI builds a news package and follows a domain move", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  const oldSite = newsSite("/p/");
  const newSite = newsSite("/news/");
  try {
    const oldBase = await listen(oldSite.server, "127.0.0.1");
    const newBase = await listen(newSite.server, "localhost");

    const gen = await cli(home, ["site", "generate", "fixture-news", oldBase, "--json"]);
    assert.equal(gen.code, 0, gen.stderr);
    assert.equal(gen.json.success, true);
    assert.equal(gen.json.manifest.feedUrl, `${oldBase}rss.xml`);

    const latest = await runSite(home, "fixture-news/latest", ["1"]);
    assert.equal(latest.result.items[0].url, `${oldBase}p/1`);
    assert.equal((await runSite(home, "fixture-news/article", [latest.result.items[0].url])).result.title, "头条");

    const healthy = await cli(home, ["site", "heal", "--json"]);
    assert.equal(healthy.code, 0, healthy.stderr);
    assert.deepEqual(healthy.json.results.map((r: any) => [r.name, r.status]), [["fixture-news", "healthy"]]);

    oldSite.moveTo(newBase);
    const healed = await cli(home, ["site", "heal", "fixture-news", "--json"]);
    assert.equal(healed.code, 0, healed.stderr);
    assert.equal(healed.json.results[0].status, "healed");
    assert.equal(healed.json.results[0].to, newBase);

    const latest2 = await runSite(home, "fixture-news/latest", []);
    assert.equal(latest2.adapter.domain, "localhost");
    assert.equal(latest2.result.items[0].url, `${newBase}news/1`);
    assert.equal((await runSite(home, "fixture-news/article", [latest2.result.items[0].url])).result.title, "头条");
  } finally {
    oldSite.server.close();
    newSite.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("generate and heal immediately refresh an already-running daemon catalog", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  const oldSite = newsSite("/p/");
  const newSite = newsSite("/news/");
  const requests: Array<{ url?: string; auth?: string }> = [];
  const daemon = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ adapters: [], total: 0, cacheAge: 0 }));
  });
  try {
    const oldBase = await listen(oldSite.server, "127.0.0.1");
    const newBase = await listen(newSite.server, "localhost");
    const daemonBase = new URL(await listen(daemon, "127.0.0.1"));
    writeFileSync(join(home, "daemon.json"), JSON.stringify({
      pid: process.pid, host: daemonBase.hostname, port: Number(daemonBase.port), token: "test-token",
    }));

    assert.equal((await cli(home, ["site", "generate", "fixture-news", oldBase, "--json"])).code, 0);
    assert.deepEqual(requests, [{ url: "/api/sites?invalidate=1", auth: "Bearer test-token" }]);
    oldSite.moveTo(newBase);
    const healed = await cli(home, ["site", "heal", "fixture-news", "--json"]);
    assert.equal(healed.code, 0, healed.stderr);
    assert.equal(healed.json.results[0].status, "healed");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "/api/sites?invalidate=1");
  } finally {
    oldSite.server.close();
    newSite.server.close();
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("site generate does not overwrite an existing private adapter", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  const site = newsSite("/p/");
  const dir = join(home, "sites", "existing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "latest.js"), "user latest");
  writeFileSync(join(dir, "article.js"), "user article");
  try {
    const base = await listen(site.server, "127.0.0.1");
    const gen = await cli(home, ["site", "generate", "existing", base, "--json"]);
    assert.equal(gen.code, 1);
    assert.equal(gen.json.success, false);
    assert.equal(readFileSync(join(dir, "latest.js"), "utf8"), "user latest");
    assert.equal(readFileSync(join(dir, "article.js"), "utf8"), "user article");
  } finally {
    site.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent generation of the same name does not overwrite a package", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  const site = newsSite("/p/");
  try {
    const base = await listen(site.server, "127.0.0.1");
    const results = await Promise.all([0, 1].map(() => cli(home, ["site", "generate", "race", base, "--json"])));
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
    assert.ok(existsSync(join(home, "sites", "race", "latest.js")));
    assert.ok(existsSync(join(home, "sites", "race", "article.js")));
  } finally {
    site.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a live daemon refresh failure is reported and a later heal can retry it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  const site = newsSite("/p/");
  let fail = true;
  const daemon = createServer((_req, res) => {
    res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ adapters: [] }));
  });
  try {
    const base = await listen(site.server, "127.0.0.1");
    const daemonBase = new URL(await listen(daemon, "127.0.0.1"));
    writeFileSync(join(home, "daemon.json"), JSON.stringify({
      pid: process.pid, host: daemonBase.hostname, port: Number(daemonBase.port), token: "test-token",
    }));
    const gen = await cli(home, ["site", "generate", "news", base, "--json"]);
    assert.equal(gen.code, 1);
    assert.equal(gen.json.success, false);
    assert.match(gen.json.error, /written.*catalog.*refresh/i);
    assert.ok(existsSync(join(home, "sites", "news", "_package.json")));
    fail = false;
    const healed = await cli(home, ["site", "heal", "news", "--json"]);
    assert.equal(healed.code, 0, healed.stderr);
    assert.equal(healed.json.results[0].status, "healthy");
  } finally {
    site.server.close();
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("site generate works with a stale stopped-daemon record", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  const site = newsSite("/p/");
  const stopped = createServer((_req, res) => { res.writeHead(503); res.end(); });
  try {
    const base = await listen(site.server, "127.0.0.1");
    const staleBase = new URL(await listen(stopped, "127.0.0.1"));
    writeFileSync(join(home, "daemon.json"), JSON.stringify({
      pid: 2147483647, host: staleBase.hostname, port: Number(staleBase.port), token: "stale-token",
    }));
    const gen = await cli(home, ["site", "generate", "news", base, "--json"]);
    assert.equal(gen.code, 0, gen.stderr);
    assert.equal(gen.json.success, true);
  } finally {
    site.server.close();
    stopped.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("site generate --json returns a JSON error for missing arguments", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  try {
    for (const args of [["site", "generate", "--json"], ["site", "generate", "news", "--json"]]) {
      const result = await cli(home, args);
      assert.equal(result.code, 1);
      assert.equal(result.json?.success, false);
      assert.match(result.json.error, /required/i);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("site generate fails with a non-zero exit and writes nothing when the flow does not pass", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-site-gen-"));
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  try {
    const base = await listen(server, "127.0.0.1");
    const gen = await cli(home, ["site", "generate", "dead-news", base, "--json"]);
    assert.equal(gen.code, 1);
    assert.equal(gen.json.success, false);
    assert.ok(!existsSync(join(home, "sites", "dead-news")));

    const missing = await cli(home, ["site", "heal", "nope", "--json"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.json.results[0].status, "broken");
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
