import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

// MANAGED_PORT_FILE is derived from BB_BROWSER_HOME at import time.
const home = mkdtempSync(path.join(os.tmpdir(), "ma-cdp-discovery-"));
process.env.BB_BROWSER_HOME = home;
const {
  browserIdFor,
  discoverCdpEndpoints,
  envCdpAddresses,
  explainCdpFailure,
  parseCdpAddress,
  resolveCdpEndpoint,
  splitCommandLine,
} = await import("../cdp-discovery.js");

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  rmSync(home, { recursive: true, force: true });
});

/** A fake browser endpoint: answers /json/version and /json/list like Chrome. */
async function fakeCdp(kind: "chrome" | "node-inspector" | "plain-http" = "chrome", pages = 2): Promise<number> {
  const server = createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    res.setHeader("content-type", "application/json");
    if (kind === "plain-http") return res.end("<html>not cdp</html>");
    if (req.url === "/json/version") {
      return res.end(JSON.stringify(kind === "chrome"
        ? { Browser: "Chrome/130.0.0.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-${port}` }
        : { Browser: "node.js/v22.0.0", "Protocol-Version": "1.1" }));
    }
    if (req.url === "/json/list") {
      return res.end(JSON.stringify([...Array(pages)].map(() => ({ type: "page" })).concat({ type: "service_worker" })));
    }
    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => server.close(r));
  return port;
}

function setManagedPort(port: number | null): void {
  const file = path.join(home, "browser", "cdp-port");
  if (port === null) return rmSync(file, { force: true });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, String(port));
}

const isolated = (ports: number[]) => ({ ports, processes: false });

test("parseCdpAddress accepts ports, host:port, URLs and ws debugger URLs", () => {
  assert.deepEqual(parseCdpAddress("9222"), { host: "127.0.0.1", port: 9222 });
  assert.deepEqual(parseCdpAddress(9222), { host: "127.0.0.1", port: 9222 });
  assert.deepEqual(parseCdpAddress("10.0.0.5:9222"), { host: "10.0.0.5", port: 9222 });
  assert.deepEqual(parseCdpAddress("http://localhost:9333/json"), { host: "localhost", port: 9333 });
  assert.deepEqual(parseCdpAddress("ws://127.0.0.1:9222/devtools/browser/abc"), { host: "127.0.0.1", port: 9222 });
  assert.equal(parseCdpAddress("[::1]:9222")?.port, 9222);
  assert.equal(parseCdpAddress("nope"), null);
  assert.equal(parseCdpAddress("70000"), null);
});

test("splitCommandLine unquotes Windows args with spaces", () => {
  assert.deepEqual(
    splitCommandLine('"C:\\Program Files\\chrome.exe" "--user-data-dir=C:\\Users\\A B\\p" --remote-debugging-port=9222'),
    ["C:\\Program Files\\chrome.exe", "--user-data-dir=C:\\Users\\A B\\p", "--remote-debugging-port=9222"],
  );
});

test("browserIdFor folds every loopback form to the bare port", () => {
  assert.equal(browserIdFor("127.0.0.1", 9222), "9222");
  assert.equal(browserIdFor("[::1]", 9222), "9222");
  assert.equal(browserIdFor("localhost", 9222), "9222");
  assert.equal(browserIdFor("10.0.0.5", 9222), "10.0.0.5:9222");
});

test("envCdpAddresses merges BB_BROWSER_CDP_URL and BB_BROWSER_CDP_URLS without duplicates", () => {
  process.env.BB_BROWSER_CDP_URL = "http://127.0.0.1:9222";
  process.env.BB_BROWSER_CDP_URLS = "http://localhost:9222, 19825 ,bogus";
  try {
    assert.deepEqual(envCdpAddresses().map((a) => browserIdFor(a.host, a.port)), ["9222", "19825"]);
  } finally {
    delete process.env.BB_BROWSER_CDP_URL;
    delete process.env.BB_BROWSER_CDP_URLS;
  }
});

test("discovery lists browsers with tab counts and ignores non-browser endpoints", async () => {
  const chrome = await fakeCdp("chrome", 3);
  const inspector = await fakeCdp("node-inspector");
  const plain = await fakeCdp("plain-http");
  const closed = await closedPort();
  const found = await discoverCdpEndpoints(isolated([chrome, inspector, plain, closed]));
  assert.deepEqual(found.map((e) => [e.id, e.tabs, e.managed]), [[String(chrome), 3, false]]);
});

test("resolve priority: explicit > running managed > discovered > launch", async () => {
  const explicit = await fakeCdp();
  const managed = await fakeCdp();
  const user = await fakeCdp();
  setManagedPort(managed);
  try {
    const discover = isolated([user, managed]);
    const a = await resolveCdpEndpoint({ explicit: [{ host: "127.0.0.1", port: explicit }], discover, launch: false });
    assert.deepEqual([a?.port, a?.source], [explicit, "explicit"]);

    const b = await resolveCdpEndpoint({ discover, launch: false });
    assert.deepEqual([b?.port, b?.source], [managed, "managed"], "a running managed browser keeps the agent profile");

    setManagedPort(null);
    const c = await resolveCdpEndpoint({ discover, launch: false });
    assert.equal(c?.source, "discovered");
    assert.ok([user, managed].includes(c!.port));
  } finally {
    setManagedPort(null);
  }
});

test("resolve skips unreachable explicit endpoints and excluded browsers", async () => {
  const user = await fakeCdp();
  const other = await fakeCdp();
  const dead = await closedPort();
  const discover = isolated([user, other]);
  const r = await resolveCdpEndpoint({
    explicit: [{ host: "127.0.0.1", port: dead }],
    exclude: new Set([String(Math.min(user, other))]),
    discover,
    launch: false,
  });
  assert.deepEqual([r?.port, r?.source], [Math.max(user, other), "discovered"]);
  assert.equal(await resolveCdpEndpoint({ exclude: new Set([String(user), String(other)]), discover, launch: false }), null);
});

test("BB_CDP_DISCOVERY=0 disables scanning", async () => {
  const user = await fakeCdp();
  process.env.BB_CDP_DISCOVERY = "0";
  try {
    assert.equal(await resolveCdpEndpoint({ discover: isolated([user]), launch: false }), null);
  } finally {
    delete process.env.BB_CDP_DISCOVERY;
  }
});

test("explainCdpFailure tells a closed port from a non-CDP service", async () => {
  assert.match(await explainCdpFailure("127.0.0.1", await closedPort()), /Nothing is listening.*--remote-debugging-port/);
  assert.match(await explainCdpFailure("127.0.0.1", await fakeCdp("plain-http")), /is open but is not a Chrome DevTools endpoint/);
});
