#!/usr/bin/env node
// Isolated memory/latency benchmark: own Chromium profile, own ports, own BB_BROWSER_HOME.
// Usage: node scripts/bench.mjs [path/to/daemon.js] [--rounds 30] [--keep 6]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const daemonPath = resolve(args.find((a) => a.endsWith(".js")) ?? "dist/daemon.js");
const ROUNDS = opt("rounds", 30);
const KEEP = opt("keep", 6);
const CDP_PORT = 29825 + Math.floor(Math.random() * 500);
const HTTP_PORT = CDP_PORT + 1000;
const home = mkdtempSync(join(tmpdir(), "ma-bench-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (n) => `<!doctype html><title>bench ${n}</title><body>
${Array.from({ length: 400 }, (_, i) => `<div class="row"><a href="#a${i}">link ${i}</a><button>btn ${i}</button><input name="f${i}" value="v${i}"><span>${"text ".repeat(8)}</span></div>`).join("")}
${Array.from({ length: 40 }, (_, i) => `<img src="/img/${n}-${i}.svg">`).join("")}
<script>for(let i=0;i<60;i++)console.log("log",i,"x".repeat(200));
for(let i=0;i<30;i++)fetch("/api/"+i).then(r=>r.text());</script></body>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>`;
const site = createServer((req, res) => {
  if (req.url.startsWith("/img/")) { res.setHeader("content-type", "image/svg+xml"); res.end(svg); return; }
  if (req.url.startsWith("/api/")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: "y".repeat(20000) })); return; }
  res.setHeader("content-type", "text/html"); res.end(page(req.url.slice(1) || "0"));
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${site.address().port}`;

const chrome = spawn(process.env.CHROMIUM ?? "/usr/lib/chromium/chromium", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(home, "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch { await sleep(100); } }
const daemon = spawn(process.execPath, [daemonPath, "--port", String(HTTP_PORT), "--cdp-port", String(CDP_PORT)], { env: { ...process.env, BB_BROWSER_HOME: home }, stdio: "ignore" });
const stop = () => { daemon.kill(); chrome.kill(); site.close(); };
process.on("exit", stop);

let token;
for (let i = 0; i < 100 && !token; i++) {
  try { token = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).token; } catch { await sleep(100); }
}
const latencies = {};
let seq = 0;
async function cmd(action, body = {}, session = "bench-a") {
  const t = performance.now();
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-bb-session": session },
    body: JSON.stringify({ id: `b${++seq}`, action, ...body }),
    signal: AbortSignal.timeout(Number(process.env.BENCH_TIMEOUT ?? 20000)),
  }).catch((e) => { throw new Error(`${action} failed: ${e.message}`); });
  const json = await res.json();
  process.stderr.write(`${action} ${Math.round(performance.now() - t)}ms\n`);
  (latencies[action] ??= []).push(performance.now() - t);
  if (json.success === false) throw new Error(`${action}: ${json.error}`);
  return json;
}
for (let i = 0; i < 100; i++) { try { await cmd("tab_list"); break; } catch { await sleep(200); } }

function treePss(rootPid) {
  const children = new Map();
  for (const p of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try { const ppid = Number(readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1]); (children.get(ppid) ?? children.set(ppid, []).get(ppid)).push(Number(p)); } catch {}
  }
  let kb = 0;
  const walk = (pid) => {
    try { kb += Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))[1]); } catch {}
    for (const c of children.get(pid) ?? []) walk(c);
  };
  walk(rootPid);
  return Math.round(kb / 1024);
}

try {
const open = [];
let snapshotChars = 0;
const t0 = performance.now();
for (let r = 0; r < ROUNDS; r++) {
  const session = r % 2 ? "bench-b" : "bench-a";
  process.stderr.write(`round ${r}\n`);
  const { data } = await cmd("tab_new", { url: `${origin}/${r}` }, session);
  open.push({ tab: data.tab, session });
  await sleep(600);
  const snap = await cmd("snapshot", { tabId: data.tab, interactive: true }, session);
  snapshotChars += JSON.stringify(snap.data).length;
  await cmd("network", { tabId: data.tab, networkCommand: "requests" }, session);
  await cmd("console", { tabId: data.tab, consoleCommand: "get" }, session);
  await cmd("eval", { tabId: data.tab, script: "document.querySelectorAll('div').length" }, session);
  if (open.length > KEEP) { const old = open.shift(); await cmd("tab_close", { tabId: old.tab }, old.session); }
}
const elapsed = performance.now() - t0;
await sleep(1500);
const pct = (xs, p) => Math.round(xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]);
const result = {
  daemon: daemonPath,
  rounds: ROUNDS,
  keepOpen: KEEP,
  daemonPssMB: treePss(daemon.pid),
  chromiumPssMB: treePss(chrome.pid),
  wallSeconds: Math.round(elapsed / 100) / 10,
  avgSnapshotChars: Math.round(snapshotChars / ROUNDS),
  latencyMs: Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, { p50: pct(v, 0.5), p95: pct(v, 0.95) }])),
};
console.log(JSON.stringify(result, null, 2));
} finally {
  stop();
  await sleep(500);
  rmSync(home, { recursive: true, force: true });
}
