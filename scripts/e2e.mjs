#!/usr/bin/env node
// End-to-end check of the core contract through the real CLI, in an isolated
// Chromium + daemon + BB_BROWSER_HOME (never touches ~/.bb-browser):
//   browser control, per-agent sessions and tab leases, site adapters, and
//   login cookies surviving a daemon and a browser restart.
// Usage: node scripts/e2e.mjs [path/to/dist]
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const dist = resolve(process.argv[2] ?? "dist");
const home = mkdtempSync(join(tmpdir(), "ma-e2e-"));
const freePort = () => new Promise((r) => { const srv = createServer().listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => r(port)); }); });
const CDP_PORT = await freePort();
const HTTP_PORT = await freePort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const site = createServer((req, res) => {
  if (req.url === "/login") {
    res.setHeader("set-cookie", "sid=agent-ok; Max-Age=86400; Path=/; SameSite=Lax");
    res.setHeader("content-type", "text/html");
    res.end("<title>logged in</title>ok");
  } else if (req.url === "/whoami") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? "" }));
  } else {
    res.setHeader("content-type", "text/html");
    res.end(`<title>form</title><input id="name" aria-label="Name"><button id="go" onclick="window.clicks = (window.clicks || 0) + 1; document.querySelector('#out').textContent = document.querySelector('#name').value">Go</button><p id="out"></p><div style="position:relative"><button id="under" onclick="window.underClicks = (window.underClicks || 0) + 1">Under</button><div style="position:absolute;inset:0"></div></div>`);
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${site.address().port}`;

mkdirSync(join(home, "sites", "e2e"), { recursive: true });
writeFileSync(join(home, "sites", "e2e", "whoami.js"), `/* @meta
{"name":"e2e/whoami","description":"echo cookies (test: cookie)","domain":"127.0.0.1","args":{"tag":{"required":true}}}
*/
async function(args) {
  const r = await fetch("/whoami", { credentials: "include" });
  return { tag: args.tag, ...(await r.json()) };
}`);

let chrome;
let daemon;
async function startBrowser() {
  chrome = spawn(process.env.CHROMIUM ?? "/usr/lib/chromium/chromium", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(home, "browser", "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return; } catch { await sleep(100); } }
  throw new Error("Chromium did not expose CDP");
}
async function startDaemon() {
  rmSync(join(home, "daemon.json"), { force: true });
  daemon = spawn(process.execPath, [join(dist, "daemon.js"), "--port", String(HTTP_PORT), "--cdp-port", String(CDP_PORT)], { env: { ...process.env, BB_BROWSER_HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      const { token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/command`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "ready", action: "tab_list" }) });
      if ((await res.json()).success) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  let log = "";
  try { log = readFileSync(join(home, "logs", "daemon.log"), "utf8").split("\n").slice(-6).join(" | "); } catch { /* no log yet */ }
  throw new Error(`daemon did not become ready (exit ${daemon.exitCode}): ${log}`);
}
const stopped = (child) => new Promise((r) => { if (child.exitCode !== null) r(); else { child.once("exit", r); child.kill(); } });
// Close Chromium the way a user does, so it flushes cookies and releases the profile lock.
async function closeBrowser() {
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  await Promise.race([exited, sleep(10000).then(() => stopped(chrome))]);
}

function cli(session, args, { allowFailure = false } = {}) {
  return new Promise((resolveP, reject) => {
    execFile(process.execPath, [join(dist, "cli.js"), ...args, "--json"], {
      env: { ...process.env, BB_BROWSER_HOME: home, BB_BROWSER_CDP_URL: `http://127.0.0.1:${CDP_PORT}`, BB_SESSION_ID: session },
      timeout: 60000,
    }, (error, stdout) => {
      let json;
      try { json = JSON.parse(stdout); } catch { return reject(new Error(`${args.join(" ")}: ${stdout || error?.message}`)); }
      if (json.success === false && !allowFailure) return reject(new Error(`${args.join(" ")}: ${json.error}`));
      resolveP(json);
    });
  });
}
const ref = (snapshot, tagName) => Object.entries(snapshot.data.snapshotData.refs).find(([, r]) => r.tagName === tagName)?.[0];
const results = [];
async function check(name, fn) {
  const t = performance.now();
  await fn();
  results.push(`PASS ${name} (${Math.round(performance.now() - t)}ms)`);
}

try {
  await startBrowser();
  await startDaemon();

  let tabA;
  let tabB;
  await check("browser control: open, snapshot, fill, click, eval", async () => {
    tabA = (await cli("agent-a", ["open", `${origin}/form`])).data.tab;
    await sleep(500);
    const snap = await cli("agent-a", ["snapshot", "-i", "--tab", tabA]);
    await cli("agent-a", ["fill", ref(snap, "input"), "hello", "--tab", tabA]);
    await cli("agent-a", ["click", ref(snap, "button"), "--tab", tabA]);
    const out = await cli("agent-a", ["eval", "[document.querySelector('#out').textContent, window.clicks]", "--tab", tabA]);
    assert.deepEqual(out.data.result, ["hello", 1], "one click fires the handler once");
  });

  await check("snapshot: no overlay by default, visible numbered boxes with --highlight", async () => {
    const overlay = "(() => { const c = document.getElementById('playwright-highlight-container'); return JSON.stringify(c ? [c.style.display, c.childElementCount > 0] : null); })()";
    await cli("agent-a", ["snapshot", "-i", "--tab", tabA]);
    assert.equal((await cli("agent-a", ["eval", overlay, "--tab", tabA])).data.result, "null");
    await cli("agent-a", ["snapshot", "-i", "--highlight", "--tab", tabA]);
    assert.equal((await cli("agent-a", ["eval", overlay, "--tab", tabA])).data.result, '["block",true]');
  });

  await check("speed: click on a background tab returns within 5s (was ~10s)", async () => {
    const snap = await cli("agent-a", ["snapshot", "-i", "--tab", tabA]);
    const t = performance.now();
    await cli("agent-a", ["click", ref(snap, "button"), "--tab", tabA]);
    assert.ok(performance.now() - t < 5000, `click took ${Math.round(performance.now() - t)}ms`);
  });

  await check("click: a covered element is still clicked exactly once", async () => {
    const snap = await cli("agent-a", ["snapshot", "-i", "--tab", tabA]);
    const under = Object.entries(snap.data.snapshotData.refs).find(([, r]) => r.name === "Under")?.[0];
    await cli("agent-a", ["click", under, "--tab", tabA]);
    assert.equal((await cli("agent-a", ["eval", "window.underClicks", "--tab", tabA])).data.result, 1);
  });

  await check("sessions: each agent keeps its own current tab", async () => {
    tabB = (await cli("agent-b", ["open", `${origin}/login`])).data.tab;
    await sleep(500);
    const a = await cli("agent-a", ["eval", "location.pathname"]);
    const b = await cli("agent-b", ["eval", "location.pathname"]);
    assert.deepEqual([a.data.result, b.data.result], ["/form", "/login"]);
  });

  await check("leases: an exclusive claim blocks other agents until released", async () => {
    await cli("agent-a", ["tab", "claim", "--id", tabA, "--intent", "e2e form"]);
    const blocked = await cli("agent-b", ["eval", "1", "--tab", tabA], { allowFailure: true });
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /exclusively held/);
    assert.equal((await cli("agent-a", ["eval", "2", "--tab", tabA])).data.result, 2);
    await cli("agent-a", ["tab", "release", "--id", tabA]);
    assert.equal((await cli("agent-b", ["eval", "3", "--tab", tabA])).data.result, 3);
  });

  await check("tab refs: a stale short ID errors instead of hitting another tab", async () => {
    await cli("agent-b", ["tab", "close", "--id", tabB]);
    const stale = await cli("agent-a", ["eval", "1", "--tab", tabB], { allowFailure: true });
    assert.equal(stale.success, false);
  });

  await check("adapters: site run executes in the page with the login cookie", async () => {
    const run = await cli("agent-a", ["site", "run", "e2e/whoami", "--tag", "x", "--tab", tabA]);
    assert.deepEqual(run.data, { tag: "x", cookie: "sid=agent-ok" });
    const missing = await cli("agent-a", ["site", "run", "e2e/whoami"], { allowFailure: true });
    assert.equal(missing.success, false);
  });

  await check("network: captured requests keep their response bodies", async () => {
    const net = await cli("agent-a", ["network", "requests", "whoami", "--with-body", "--tab", tabA]);
    const hit = net.data.networkRequests.find((r) => r.url.endsWith("/whoami"));
    assert.match(hit.responseBody, /sid=agent-ok/);
  });

  await check("persistence: cookies survive a daemon restart and a browser restart", async () => {
    await stopped(daemon);
    await startDaemon();
    const afterDaemon = await cli("agent-a", ["site", "run", "e2e/whoami", "d"]);
    assert.equal(afterDaemon.data.cookie, "sid=agent-ok");
    await stopped(daemon);
    await closeBrowser();
    await startBrowser();
    await startDaemon();
    await cli("agent-a", ["open", `${origin}/form`]);
    await sleep(500);
    const afterBrowser = await cli("agent-a", ["site", "run", "e2e/whoami", "b"]);
    assert.equal(afterBrowser.data.cookie, "sid=agent-ok");
  });
  await check("generated adapters run immediately after generation and auto-heal a domain move", async () => {
    const body = "Browser news fixture article content. ".repeat(5);
    function newsSite() {
      let moved;
      const server = createServer((req, res) => {
        if (moved) { res.writeHead(301, { location: moved + (req.url ?? "/").slice(1) }); return res.end(); }
        const base = `http://${req.headers.host}/`;
        if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<link rel="alternate" type="application/rss+xml" href="/rss.xml"><h1>News fixture</h1>'); }
        if (req.url === "/rss.xml") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><item><title>News</title><link>${base}article</link></item></rss>`); }
        if (req.url === "/article") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<title>News</title><article><p>${body}</p></article>`); }
        res.writeHead(404); res.end();
      });
      return { server, move: (url) => { moved = url; } };
    }
    const oldSite = newsSite();
    const newSite = newsSite();
    try {
      const listen = (server, host) => new Promise((r) => server.listen(0, host, () => r(`http://${host}:${server.address().port}/`)));
      const oldBase = await listen(oldSite.server, "127.0.0.1");
      const newBase = await listen(newSite.server, "localhost");
      await cli("agent-a", ["site", "run", "e2e/whoami", "warmup"]); // prime the daemon catalog
      await cli("agent-a", ["open", oldBase]);
      await cli("agent-a", ["site", "generate", "e2e-news", oldBase]);
      const latest = await cli("agent-a", ["site", "run", "e2e-news/latest"]);
      assert.equal(latest.data.items[0].url, `${oldBase}article`);
      assert.equal((await cli("agent-a", ["site", "run", "e2e-news/article", latest.data.items[0].url])).data.title, "News");
      // Domain move: the next normal run heals itself (no `site heal`, no daemon restart, no tab on the new domain).
      oldSite.move(newBase);
      const latest2 = await cli("agent-a", ["site", "run", "e2e-news/latest"]);
      assert.equal(latest2.data.items[0].url, `${newBase}article`);
      assert.equal((await cli("agent-a", ["site", "run", "e2e-news/article", latest2.data.items[0].url])).data.title, "News");
    } finally {
      oldSite.server.close();
      newSite.server.close();
    }
  });
  console.log(results.join("\n"));
} catch (error) {
  console.log(results.join("\n"));
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (daemon) await stopped(daemon);
  if (chrome) await stopped(chrome);
  site.close();
  await sleep(300);
  rmSync(home, { recursive: true, force: true });
}
