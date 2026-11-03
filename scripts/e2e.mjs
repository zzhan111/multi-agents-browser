#!/usr/bin/env node
// End-to-end check of the core contract through the real CLI, in an isolated
// Chromium + daemon + BB_BROWSER_HOME (never touches ~/.bb-browser):
//   browser control, per-agent sessions and tab leases, site adapters, and
//   login cookies surviving a daemon and a browser restart.
// Usage: node scripts/e2e.mjs [path/to/dist]   (E2E_ONLY=<regex>, E2E_EVIDENCE_DIR=<dir> for screenshots)
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  chrome = spawn(process.env.CHROMIUM ?? "/usr/lib/chromium/chromium", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(home, "browser", "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", openSync(join(home, "chromium.log"), "a")] });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return; } catch { await sleep(100); } }
  throw new Error("Chromium did not expose CDP");
}
// --strict-cdp keeps the daemon off the user's real browser even when our
// Chromium is slow or restarting; assertIsolated double-checks it.
async function daemonStatus() {
  const { token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
  return (await fetch(`http://127.0.0.1:${HTTP_PORT}/status`, { headers: { authorization: `Bearer ${token}` } })).json();
}
async function assertIsolated() {
  const { cdpPort } = await daemonStatus();
  if (cdpPort !== CDP_PORT) throw new Error(`daemon attached to CDP port ${cdpPort}, not the isolated Chromium on ${CDP_PORT}`);
}
async function startDaemon() {
  rmSync(join(home, "daemon.json"), { force: true });
  daemon = spawn(process.execPath, [join(dist, "daemon.js"), "--port", String(HTTP_PORT), "--cdp-port", String(CDP_PORT), "--strict-cdp"], { env: { ...process.env, BB_BROWSER_HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await daemonStatus()).cdpConnected) return await assertIsolated();
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
  // Bind this instance: a late fallback kill must not hit the browser started next.
  const old = chrome;
  const exited = new Promise((r) => (old.exitCode !== null ? r() : old.once("exit", r)));
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  let timer;
  await Promise.race([exited, new Promise((r) => { timer = setTimeout(r, 10000); }).then(() => stopped(old))]);
  clearTimeout(timer);
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
// E2E_ONLY=<regex> runs just the matching checks (each generated-package check is self-contained).
async function check(name, fn) {
  if (process.env.E2E_ONLY && !new RegExp(process.env.E2E_ONLY).test(name)) return results.push(`SKIP ${name}`);
  const t = performance.now();
  await fn();
  await assertIsolated();
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
      await cli("agent-a", ["open", `${origin}/form`]); // self-contained under E2E_ONLY
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
  await check("login-only news site: --browser generation, origin-exact tabs, and auto-heal with the login state", async () => {
    const body = "Members-only fixture article content. ".repeat(5);
    let feedPath = "/rss.xml";
    const runs = [];
    const members = createServer((req, res) => {
      const base = `http://${req.headers.host}/`;
      const url = new URL(req.url, base);
      const html = (b) => { res.writeHead(200, { "content-type": "text/html" }); res.end(b); };
      if (url.pathname === "/login") { res.writeHead(200, { "set-cookie": "member=e2e-secret; Path=/; SameSite=Lax", "content-type": "text/html" }); return res.end("<title>member</title>logged in"); }
      // Evidence page: renders what the CLI runs returned so far (no login needed, no cookie shown).
      if (url.pathname === "/report") return html(`<meta charset="utf-8"><title>e2e report</title><style>body{font:14px sans-serif;margin:16px}td,th{border:1px solid #999;padding:4px 8px;text-align:left}</style><h2>login-only news package — ${url.searchParams.get("step")}</h2><table><tr><th>step</th><th>result</th></tr>${runs.map(([k, v]) => `<tr><td>${k}</td><td>${v.replace(/</g, "&lt;")}</td></tr>`).join("")}</table>`);
      if (!/(^|; )member=e2e-secret(;|$)/.test(req.headers.cookie ?? "")) { res.writeHead(401); return res.end("login required"); }
      if (url.pathname === "/") return html(`<link rel="alternate" type="application/rss+xml" href="${feedPath}">`);
      if (url.pathname === feedPath) { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><item><title>Members</title><link>${base}story</link></item></rss>`); }
      if (url.pathname === "/story") return html(`<title>Members</title><article><p>${body}</p></article>`);
      res.writeHead(404); res.end();
    });
    // Same hostname, other port: a tab here must not serve the generated package.
    const decoy = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>decoy</title>other origin"); });
    const listen = (server) => new Promise((r) => server.listen(0, "localhost", () => r(`http://localhost:${server.address().port}/`)));
    const tabs = async () => (await cli("agent-a", ["tab"])).data.tabs;
    const evidence = process.env.E2E_EVIDENCE_DIR;
    // Evidence: a one-shot Chromium (own throwaway profile) renders the report page.
    const shot = (step) => evidence && new Promise((r, reject) => execFile(process.env.CHROMIUM ?? "/usr/lib/chromium/chromium", ["--headless=new", `--user-data-dir=${join(home, "shot-profile")}`, `--screenshot=${join(evidence, `${step}.png`)}`, "--window-size=1000,420", `${base}report?step=${encodeURIComponent(step)}`], { timeout: 30000 }, (e) => (e ? reject(e) : r())));
    let base;
    try {
      base = await listen(members);
      const decoyBase = await listen(decoy);
      const decoyTab = (await cli("agent-a", ["open", decoyBase])).data.tab;
      const loginTab = (await cli("agent-a", ["open", `${base}login`])).data.tab;
      await sleep(500);
      const anonymous = await cli("agent-a", ["site", "generate", "e2e-members", base], { allowFailure: true });
      assert.equal(anonymous.success, false, "the generator's own requests carry no login state");
      assert.ok(!existsSync(join(home, "sites", "e2e-members")), "a failed generation writes nothing");
      runs.push(["generate (no --browser)", `failed: ${anonymous.score.passed}/${anonymous.score.total} checks, nothing written`]);

      const before = (await tabs()).length;
      const gen = await cli("agent-a", ["site", "generate", "e2e-members", base, "--browser"]);
      assert.equal(gen.manifest.feedUrl, `${base}rss.xml`);
      assert.equal((await tabs()).length, before, "generation reuses the logged-in tab and leaves no tab behind");
      for (const file of [...gen.files, join(home, "sites", "e2e-members", "_package.json")]) {
        assert.ok(!readFileSync(file, "utf8").includes("e2e-secret"), `${file} holds no credentials`);
      }
      runs.push(["generate --browser", `ok, feed ${gen.manifest.feedUrl}`]);

      // Only the decoy (same hostname, other port) is open: site run must open the manifest's origin instead.
      await cli("agent-a", ["close", "--tab", loginTab]);
      const runFlow = async (label) => {
        const latest = await cli("agent-a", ["site", "run", "e2e-members/latest"]);
        assert.equal(latest.data.items[0].url, `${base}story`);
        const article = await cli("agent-a", ["site", "run", "e2e-members/article", latest.data.items[0].url]);
        assert.equal(article.data.title, "Members");
        assert.ok(article.data.text.length >= 80);
        runs.push([label, `latest → ${latest.data.items[0].url}; article "${article.data.title}" (${article.data.text.length} chars)`]);
      };
      await runFlow("site run latest → article");
      const decoyNow = (await tabs()).find((t) => t.tab === decoyTab);
      assert.equal(decoyNow?.url, decoyBase, "the other-origin tab is neither used nor navigated");
      await shot("1-generated-and-run");

      const membersTab = (await tabs()).find((t) => t.url.startsWith(base)).tab;
      const explicit = await cli("agent-a", ["site", "run", "e2e-members/latest", "--tab", membersTab]);
      assert.equal(explicit.data.items[0].url, `${base}story`, "an explicit --tab is still honoured");

      const heal = await cli("agent-a", ["site", "heal", "e2e-members", "--browser"]);
      assert.equal(heal.results[0].status, "healthy");
      runs.push(["site heal --browser", heal.results[0].status]);

      // Site change: the feed moves. Only the logged-in browser can re-probe it.
      feedPath = "/feed.xml";
      runs.push(["site change", "feed moved /rss.xml → /feed.xml"]);
      const beforeHeal = (await tabs()).length;
      await runFlow("site run after change (auto-heal)");
      assert.equal(JSON.parse(readFileSync(join(home, "sites", "e2e-members", "_package.json"), "utf8")).feedUrl, `${base}feed.xml`);
      assert.equal((await tabs()).length, beforeHeal, "auto-heal closes only the tabs it opened");
      assert.ok((await tabs()).some((t) => t.tab === decoyTab), "existing tabs stay open");
      await shot("2-changed-and-auto-healed");
    } finally {
      members.close();
      decoy.close();
    }
  });
  console.log(results.join("\n"));
} catch (error) {
  console.log(results.join("\n"));
  console.error(`FAIL ${error.message}`);
  try { console.error(readFileSync(join(home, "logs", "daemon.log"), "utf8").split("\n").slice(-15).join("\n")); } catch { /* no log */ }
  try { console.error(readFileSync(join(home, "chromium.log"), "utf8").split("\n").filter((l) => !/DEPRECATED_ENDPOINT|DevTools listening/.test(l)).slice(-10).join("\n")); } catch { /* no log */ }
  try { console.error(JSON.stringify((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).map((t) => `${t.type} ${t.url}`))); } catch { /* browser gone */ }
  process.exitCode = 1;
} finally {
  if (daemon) await stopped(daemon);
  if (chrome) await stopped(chrome);
  site.close();
  await sleep(300);
  rmSync(home, { recursive: true, force: true });
}
