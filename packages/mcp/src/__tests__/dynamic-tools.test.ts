/**
 * M4 / 路 Y spike tests (Y1, Y4). No Chrome.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DYNAMIC_TOOL_CAP,
  DEFAULT_IDLE_MS,
  DynamicToolRegistry,
  adaptersForPlatform,
  argsToZodShape,
  dynamicToolName,
  installDynamicSiteTools,
  isDynamicToolsEnabled,
  parseIdleMs,
  type AdapterMeta,
  type DynamicToolHandler,
  type SiteRunRequest,
  type SiteRunResponse,
} from "../dynamic-tools.js";

function fixtureAdapters(platform: string, n: number, extra?: Partial<AdapterMeta>): AdapterMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `${platform}/cmd${i + 1}`,
    description: `${platform} command ${i + 1} (keyword: quote)`,
    args: i === 0
      ? { query: { required: true, description: "Search query" } }
      : { count: { required: false, description: "Limit" } },
    readOnly: true,
    ...extra,
  }));
}

function mockHost(runSite?: (req: SiteRunRequest) => Promise<SiteRunResponse>) {
  const tools = new Map<string, DynamicToolHandler>();
  const calls: SiteRunRequest[] = [];
  let now = 1_000_000;
  const registryHost = {
    registerTool: (
      name: string,
      _config: { title?: string; description?: string; inputSchema: Record<string, z.ZodTypeAny> },
      handler: DynamicToolHandler,
    ) => {
      tools.set(name, handler);
      return { remove: () => { tools.delete(name); } };
    },
    runSite: async (req: SiteRunRequest) => {
      calls.push(req);
      if (runSite) return runSite(req);
      return { success: true, data: { ok: true, name: req.name, namedArgs: req.namedArgs } };
    },
    now: () => now,
    idleMs: DEFAULT_IDLE_MS,
    cap: DYNAMIC_TOOL_CAP,
  };
  return {
    host: registryHost,
    tools,
    calls,
    setNow: (t: number) => { now = t; },
    advance: (ms: number) => { now += ms; },
  };
}

describe("flag (default off)", () => {
  it("is off unless BB_MCP_DYNAMIC_TOOLS is 1 or true", () => {
    assert.equal(isDynamicToolsEnabled({}), false);
    assert.equal(isDynamicToolsEnabled({ BB_MCP_DYNAMIC_TOOLS: "" }), false);
    assert.equal(isDynamicToolsEnabled({ BB_MCP_DYNAMIC_TOOLS: "0" }), false);
    assert.equal(isDynamicToolsEnabled({ BB_MCP_DYNAMIC_TOOLS: "yes" }), false);
    assert.equal(isDynamicToolsEnabled({ BB_MCP_DYNAMIC_TOOLS: "1" }), true);
    assert.equal(isDynamicToolsEnabled({ BB_MCP_DYNAMIC_TOOLS: "true" }), true);
  });

  it("parses idle ms with a 5-minute default", () => {
    assert.equal(parseIdleMs({}), DEFAULT_IDLE_MS);
    assert.equal(parseIdleMs({ BB_MCP_DYNAMIC_TOOLS_IDLE_MS: "" }), DEFAULT_IDLE_MS);
    assert.equal(parseIdleMs({ BB_MCP_DYNAMIC_TOOLS_IDLE_MS: "0" }), DEFAULT_IDLE_MS);
    assert.equal(parseIdleMs({ BB_MCP_DYNAMIC_TOOLS_IDLE_MS: "abc" }), DEFAULT_IDLE_MS);
    assert.equal(parseIdleMs({ BB_MCP_DYNAMIC_TOOLS_IDLE_MS: "1500" }), 1500);
  });
});

describe("naming + schema", () => {
  it("maps platform/command to site_<platform>_<command>", () => {
    assert.equal(dynamicToolName("twitter/search"), "site_twitter_search");
    assert.equal(dynamicToolName("xiaohongshu/user-posts"), "site_xiaohongshu_user-posts");
    assert.equal(dynamicToolName("broken"), null);
  });

  it("filters adapters by platform (case-insensitive)", () => {
    const list = [
      ...fixtureAdapters("twitter", 2),
      ...fixtureAdapters("github", 1),
    ];
    assert.equal(adaptersForPlatform(list, "Twitter").length, 2);
    assert.equal(adaptersForPlatform(list, "github").length, 1);
  });

  it("maps @meta.args to z.string required/optional plus tab", () => {
    const shape = argsToZodShape({
      query: { required: true, description: "Search query" },
      count: { required: false, description: "Limit" },
    });
    const schema = z.object(shape);
    const ok = schema.parse({ query: "hi" });
    assert.equal(ok.query, "hi");
    assert.equal(ok.tab, undefined);
    assert.throws(() => schema.parse({}), /Required/);
  });
});

describe("Y1 activate / cap / deactivate / reclaim", () => {
  it("caps simultaneous tools at 8", () => {
    assert.equal(DYNAMIC_TOOL_CAP, 8);
    const { host, tools } = mockHost();
    const registry = new DynamicToolRegistry(host);
    const result = registry.activate("twitter", fixtureAdapters("twitter", 9));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.activated.length, 8);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.reason, "cap 8");
    assert.equal(result.remaining, 0);
    assert.equal(tools.size, 8);
    assert.equal(registry.activeCount(), 8);
  });

  it("refuses a second platform when cap is full", () => {
    const { host } = mockHost();
    const registry = new DynamicToolRegistry(host);
    registry.activate("twitter", fixtureAdapters("twitter", 8));
    const second = registry.activate("github", fixtureAdapters("github", 2));
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.match(second.error, /cap is 8/);
    assert.equal(second.action, "site_deactivate");
  });

  it("deactivates a platform and frees slots", () => {
    const { host, tools } = mockHost();
    const registry = new DynamicToolRegistry(host);
    registry.activate("twitter", fixtureAdapters("twitter", 3));
    registry.activate("github", fixtureAdapters("github", 2));
    const out = registry.deactivate("twitter");
    assert.equal(out.deactivated.length, 3);
    assert.equal(out.remaining, 2);
    assert.equal(tools.size, 2);
    assert.ok([...tools.keys()].every((n) => n.startsWith("site_github_")));
  });

  it("reclaims tools idle for ~5 minutes", () => {
    const { host, tools, advance } = mockHost();
    const registry = new DynamicToolRegistry(host);
    registry.activate("twitter", fixtureAdapters("twitter", 2));
    assert.equal(tools.size, 2);
    advance(DEFAULT_IDLE_MS + 1);
    const reclaimed = registry.reclaimIdle();
    assert.equal(reclaimed.length, 2);
    assert.equal(tools.size, 0);
    assert.equal(registry.activeCount(), 0);
  });

  it("does not reclaim a recently used tool", async () => {
    const { host, tools, advance } = mockHost();
    const registry = new DynamicToolRegistry(host);
    registry.activate("twitter", fixtureAdapters("twitter", 2));
    advance(DEFAULT_IDLE_MS - 1_000);
    await registry.invoke("site_twitter_cmd1", { query: "x" });
    advance(2_000);
    const reclaimed = registry.reclaimIdle();
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0], "site_twitter_cmd2");
    assert.equal(tools.has("site_twitter_cmd1"), true);
  });
});

describe("Y4 same site_run eval/scope gate", () => {
  it("forwards dynamic tool calls as action site_run (never a side path)", async () => {
    const { host, calls } = mockHost();
    const registry = new DynamicToolRegistry(host);
    registry.activate("twitter", fixtureAdapters("twitter", 1));
    const result = await registry.invoke("site_twitter_cmd1", { query: "hello", tab: "c416" });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      action: "site_run",
      name: "twitter/cmd1",
      namedArgs: { query: "hello" },
      tabId: "c416",
    });
  });

  it("activate itself does not call site_run", () => {
    const { host, calls } = mockHost();
    const registry = new DynamicToolRegistry(host);
    registry.activate("twitter", fixtureAdapters("twitter", 3));
    assert.equal(calls.length, 0);
  });

  it("no-eval cannot bypass: dynamic tool still hits site_run and is rejected", async () => {
    const { host, calls } = mockHost(async (req) => ({
      success: false,
      error: `Action '${req.action}' requires eval permission (session scope: no-eval)`,
    }));
    const registry = new DynamicToolRegistry(host);
    const activated = registry.activate("twitter", fixtureAdapters("twitter", 1));
    assert.equal(activated.ok, true);
    const result = await registry.invoke("site_twitter_cmd1", { query: "x" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /requires eval permission \(session scope: no-eval\)/);
    assert.equal(calls[0]?.action, "site_run");
    assert.equal(calls[0]?.name, "twitter/cmd1");
  });

  it("read-only cannot bypass: dynamic tool still hits site_run and is rejected", async () => {
    const { host, calls } = mockHost(async (req) => ({
      success: false,
      error: `Action '${req.action}' is not allowed in read-only scope`,
    }));
    const registry = new DynamicToolRegistry(host);
    registry.activate("twitter", fixtureAdapters("twitter", 1));
    const result = await registry.invoke("site_twitter_cmd1", { query: "x" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /not allowed in read-only scope/);
    assert.equal(calls[0]?.action, "site_run");
  });
});

describe("MCP registerTool + list_changed (protocol smoke, no Chrome)", () => {
  let registry: ReturnType<typeof installDynamicSiteTools> | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    registry?.stopReaper();
    registry = undefined;
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    client = undefined;
    server = undefined;
  });

  it("emits notifications/tools/list_changed and new tools are listable + callable", async () => {
    const siteRunCalls: SiteRunRequest[] = [];
    server = new McpServer({ name: "ma-browser-spike", version: "0.12.1" });
    registry = installDynamicSiteTools(server, {
      startReaper: false,
      listAdapters: async () => fixtureAdapters("twitter", 2),
      runSite: async (req) => {
        siteRunCalls.push(req);
        return { success: true, data: { forwarded: req.name } };
      },
    });

    client = new Client({ name: "spike-harness", version: "0.12.1" });
    const notifications: Array<{ method: string }> = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => {
      notifications.push({ method: n.method });
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const before = await client.listTools();
    const beforeNames = before.tools.map((t) => t.name).sort();
    assert.ok(beforeNames.includes("site_activate"));
    assert.ok(beforeNames.includes("site_deactivate"));
    assert.ok(!beforeNames.includes("site_twitter_cmd1"));

    const activate = await client.callTool({
      name: "site_activate",
      arguments: { platform: "twitter" },
    });
    assert.equal(activate.isError, undefined);
    const activateText = (activate.content[0] as { text: string }).text;
    const activateJson = JSON.parse(activateText) as { activated: string[]; cap: number };
    assert.equal(activateJson.cap, 8);
    assert.ok(activateJson.activated.includes("site_twitter_cmd1"));

    // registerTool sends list_changed per add; wait a tick for in-memory delivery
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      notifications.some((n) => n.method === "notifications/tools/list_changed"),
      `expected list_changed, got ${JSON.stringify(notifications)}`,
    );

    const after = await client.listTools();
    const afterNames = after.tools.map((t) => t.name);
    assert.ok(afterNames.includes("site_twitter_cmd1"));
    assert.ok(afterNames.includes("site_twitter_cmd2"));

    const call = await client.callTool({
      name: "site_twitter_cmd1",
      arguments: { query: "hello" },
    });
    assert.equal(call.isError, undefined);
    assert.equal(siteRunCalls[0]?.action, "site_run");
    assert.equal(siteRunCalls[0]?.name, "twitter/cmd1");
    assert.deepEqual(siteRunCalls[0]?.namedArgs, { query: "hello" });

    await client.callTool({ name: "site_deactivate", arguments: { platform: "twitter" } });
    await new Promise((r) => setTimeout(r, 20));
    const gone = await client.listTools();
    assert.ok(!gone.tools.some((t) => t.name === "site_twitter_cmd1"));
  });

  it("does not install activate tools unless the caller wires installDynamicSiteTools", async () => {
    server = new McpServer({ name: "ma-browser-static", version: "0.12.1" });
    server.tool("site_run", "static", { name: z.string() }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    client = new Client({ name: "spike-harness", version: "0.12.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    assert.deepEqual(names, ["site_run"]);
  });
});
