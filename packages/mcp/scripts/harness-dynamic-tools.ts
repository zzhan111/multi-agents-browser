/**
 * Reproducible 路 Y harness (Y2).
 *
 * Default: in-process MCP Client ↔ McpServer (InMemoryTransport). No Chrome.
 *   pnpm --filter @ma-browser/mcp exec tsx scripts/harness-dynamic-tools.ts
 *
 * Optional live stdio against the built MCP process (needs dist + flag):
 *   pnpm --filter @ma-browser/mcp exec tsx scripts/harness-dynamic-tools.ts --stdio
 *
 * Live Cursor / Claude Code still needs a human: see docs/spike-dynamic-tools-v0.13.md.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  DYNAMIC_TOOL_CAP,
  installDynamicSiteTools,
  type AdapterMeta,
} from "../src/dynamic-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DIST = resolve(HERE, "../dist/index.js");

const FIXTURE: AdapterMeta[] = [
  {
    name: "twitter/search",
    description: "搜索推文 (stock quote: n/a)",
    args: { query: { required: true, description: "Search query" } },
    readOnly: true,
  },
  {
    name: "twitter/user",
    description: "用户资料",
    args: { screen_name: { required: true, description: "Handle" } },
    readOnly: true,
  },
];

type ToolRow = { name: string; description?: string };

async function inMemoryHarness() {
  const listChangedAt: string[] = [];
  const server = new McpServer(
    { name: "ma-browser", version: "0.12.1" },
    { instructions: "spike harness" },
  );
  const siteRunCalls: Array<{ action: string; name: string }> = [];
  installDynamicSiteTools(server, {
    startReaper: false,
    listAdapters: async () => FIXTURE,
    runSite: async (req) => {
      siteRunCalls.push({ action: req.action, name: req.name });
      return { success: true, data: { harness: true, name: req.name } };
    },
  });

  const client = new Client({ name: "ma-browser-dynamic-tools-harness", version: "0.12.1" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => {
    listChangedAt.push(`${new Date().toISOString()} ${n.method}`);
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const before = await client.listTools();
  await client.callTool({ name: "site_activate", arguments: { platform: "twitter" } });
  await new Promise((r) => setTimeout(r, 30));
  const after = await client.listTools();
  const call = await client.callTool({
    name: "site_twitter_search",
    arguments: { query: "harness" },
  });
  await client.callTool({ name: "site_deactivate", arguments: { platform: "twitter" } });
  await new Promise((r) => setTimeout(r, 30));
  const gone = await client.listTools();

  await client.close();
  await server.close();

  return {
    mode: "in-memory",
    date: new Date().toISOString(),
    client: { name: "ma-browser-dynamic-tools-harness", version: "0.12.1" },
    sdk: "@modelcontextprotocol/sdk (InMemoryTransport Client)",
    cap: DYNAMIC_TOOL_CAP,
    listChangedNotifications: listChangedAt,
    toolsBeforeActivate: (before.tools as ToolRow[]).map((t) => t.name),
    toolsAfterActivate: (after.tools as ToolRow[]).map((t) => ({
      name: t.name,
      description: t.description,
    })),
    callSiteTwitterSearch: {
      isError: call.isError ?? false,
      text: (call.content[0] as { text?: string })?.text,
      siteRunCalls,
    },
    toolsAfterDeactivate: (gone.tools as ToolRow[]).map((t) => t.name),
    protocolVerdict: listChangedAt.length > 0
      && after.tools.some((t) => t.name === "site_twitter_search")
      && siteRunCalls[0]?.action === "site_run"
      ? "A (SDK client: list_changed received, tool listed, call forwarded to site_run)"
      : "C (SDK client did not observe usable tools)",
  };
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.BB_MCP_DYNAMIC_TOOLS = "1";
  env.MA_BROWSER_CONNECT_ONLY = "1";
  return env;
}

async function stdioHarness() {
  if (!existsSync(MCP_DIST)) {
    return {
      mode: "stdio",
      skipped: true,
      reason: `MCP dist missing at ${MCP_DIST}; run pnpm build first`,
    };
  }

  const listChangedAt: string[] = [];
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_DIST],
    env: inheritedEnv(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(String(chunk));
  });

  const client = new Client({ name: "ma-browser-dynamic-tools-harness-stdio", version: "0.12.1" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => {
    listChangedAt.push(`${new Date().toISOString()} ${n.method}`);
  });

  const connectTimeoutMs = 15_000;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`stdio connect timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
      }),
    ]);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    const hasActivate = names.includes("site_activate");
    let activateText: string | undefined;
    let afterNames: string[] = [];
    if (hasActivate) {
      const activate = await client.callTool({
        name: "site_activate",
        arguments: { platform: "npm" },
      });
      activateText = (activate.content[0] as { text?: string })?.text;
      await new Promise((r) => setTimeout(r, 50));
      afterNames = (await client.listTools()).tools.map((t) => t.name);
    }
    await client.close();
    return {
      mode: "stdio",
      date: new Date().toISOString(),
      client: { name: "ma-browser-dynamic-tools-harness-stdio", version: "0.12.1" },
      flagOn: true,
      hasSiteActivate: hasActivate,
      staticToolCount: names.length,
      listChangedNotifications: listChangedAt,
      activateResponse: activateText,
      toolsAfterActivate: afterNames,
      stderr: stderrChunks.join("").slice(0, 2000),
      note: "Live Cursor/Claude Code rendering is NOT this stdio client. Human still needed for U4.",
    };
  } catch (error) {
    const pid = transport.pid;
    await client.close().catch(() => undefined);
    if (pid) {
      try { process.kill(pid); } catch {}
    }
    return {
      mode: "stdio",
      error: error instanceof Error ? error.message : String(error),
      stderr: stderrChunks.join("").slice(0, 2000),
    };
  }
}

const wantStdio = process.argv.includes("--stdio");
const inMemory = await inMemoryHarness();
const stdio = wantStdio ? await stdioHarness() : { mode: "stdio", skipped: true, reason: "pass --stdio to spawn dist/index.js" };

const record = {
  title: "ma-browser v0.13 M4 路 Y harness record",
  date: new Date().toISOString(),
  liveCursorOrClaudeCode: "pending human",
  inMemory,
  stdio,
};

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
