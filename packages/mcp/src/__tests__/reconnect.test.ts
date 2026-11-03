import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("connect-only MCP refreshes its daemon token after a restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "ma-mcp-reconnect-"));
  let token = "first-token";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
    } else if (req.url === "/status") {
      res.end(JSON.stringify({ running: true, cdpConnected: true }));
    } else if (req.url === "/command") {
      res.end(JSON.stringify({ id: "test", success: true, data: { tabs: [] } }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  const saveInfo = () => writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, host: "127.0.0.1", port, token }));
  saveInfo();
  const client = new Client({ name: "reconnect-test", version: "1" });
  try {
    const mcp = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [mcp],
      env: { ...process.env as Record<string, string>, BB_BROWSER_HOME: home, BB_SESSION_ID: "reconnect-test", MA_BROWSER_CONNECT_ONLY: "1" },
    }));
    const first = await client.callTool({ name: "browser_tab_list", arguments: {} });
    assert.notEqual(first.isError, true);
    token = "replacement-token";
    saveInfo();
    const second = await client.callTool({ name: "browser_tab_list", arguments: {} });
    assert.notEqual(second.isError, true);
    assert.deepEqual(JSON.parse((second.content as Array<{ text: string }>)[0].text), []);
  } finally {
    await client.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(home, { recursive: true, force: true });
  }
});
