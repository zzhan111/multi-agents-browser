/**
 * M4 / 路 Y spike: activate ≤8 site adapters as real MCP tools, forward to
 * site_run, deactivate or idle-reclaim, notify list_changed.
 *
 * Gated by BB_MCP_DYNAMIC_TOOLS=1 (default OFF). Not a production platform.
 * See docs/spike-dynamic-tools-v0.13.md.
 */

import { z, type ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const DYNAMIC_TOOLS_ENV = "BB_MCP_DYNAMIC_TOOLS";
export const DYNAMIC_TOOL_CAP = 8;
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;
export const REAPER_INTERVAL_MS = 30_000;

export function isDynamicToolsEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  const v = env[DYNAMIC_TOOLS_ENV]?.trim();
  return v === "1" || v === "true";
}

export function parseIdleMs(env: NodeJS.Dict<string> = process.env): number {
  const raw = env.BB_MCP_DYNAMIC_TOOLS_IDLE_MS?.trim();
  if (!raw) return DEFAULT_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS;
}

export interface AdapterMeta {
  name: string;
  description?: string;
  domain?: string;
  args?: Record<string, { required?: boolean; description?: string }>;
  readOnly?: boolean;
}

export interface SiteRunRequest {
  action: "site_run";
  name: string;
  namedArgs?: Record<string, string>;
  tabId?: string;
}

export interface SiteRunResponse {
  success: boolean;
  error?: string;
  hint?: string;
  action?: string;
  data?: unknown;
}

export type DynamicToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

export interface RegisteredToolHandle {
  remove: () => void;
}

export interface DynamicToolsHost {
  registerTool: (
    name: string,
    config: { title?: string; description?: string; inputSchema: Record<string, ZodTypeAny> },
    handler: DynamicToolHandler,
  ) => RegisteredToolHandle;
  runSite: (request: SiteRunRequest) => Promise<SiteRunResponse>;
  now?: () => number;
  idleMs?: number;
  cap?: number;
}

export interface DynamicToolSlot {
  toolName: string;
  adapterName: string;
  platform: string;
  lastUsedAt: number;
}

export interface ActivateOk {
  ok: true;
  platform: string;
  activated: string[];
  skipped: Array<{ name: string; reason: string }>;
  alreadyActive: boolean;
  cap: number;
  remaining: number;
}

export interface ActivateFail {
  ok: false;
  error: string;
  hint: string;
  action: string;
}

export type ActivateResult = ActivateOk | ActivateFail;

export interface DeactivateResult {
  deactivated: string[];
  remaining: number;
}

function platformOf(adapterName: string): string | null {
  const slash = adapterName.indexOf("/");
  if (slash <= 0) return null;
  return adapterName.slice(0, slash).toLowerCase();
}

export function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

/** `twitter/search` → `site_twitter_search` */
export function dynamicToolName(adapterName: string): string | null {
  const parts = adapterName.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [platform, ...rest] = parts;
  return `site_${platform}_${rest.join("_")}`;
}

export function adaptersForPlatform(adapters: AdapterMeta[], platform: string): AdapterMeta[] {
  const p = normalizePlatform(platform);
  return adapters.filter((a) => platformOf(a.name) === p);
}

export function argsToZodShape(
  args: AdapterMeta["args"] = {},
): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {
    tab: z.string().optional().describe("Optional tab short ID to target"),
  };
  for (const [key, spec] of Object.entries(args)) {
    if (key === "tab") continue;
    const desc = spec?.description ?? key;
    const field = spec?.required
      ? z.string().describe(desc)
      : z.string().optional().describe(desc);
    shape[key] = field;
  }
  return shape;
}

function namedArgsFromToolArgs(raw: Record<string, unknown>): {
  namedArgs: Record<string, string>;
  tab?: string;
} {
  const namedArgs: Record<string, string> = {};
  let tab: string | undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "tab") {
      if (typeof value === "string" && value) tab = value;
      continue;
    }
    if (value === undefined || value === null) continue;
    namedArgs[key] = String(value);
  }
  return { namedArgs, tab };
}

function formatSiteRunError(resp: SiteRunResponse): string {
  const parts = [resp.error || "Unknown error"];
  if (resp.hint) parts.push(`Hint: ${resp.hint}`);
  if (resp.action) parts.push(`Action: ${resp.action}`);
  return `Error: ${parts.join("\n")}`;
}

export class DynamicToolRegistry {
  private readonly host: DynamicToolsHost;
  private readonly cap: number;
  private readonly idleMs: number;
  private readonly slots = new Map<string, DynamicToolSlot & { handle: RegisteredToolHandle }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(host: DynamicToolsHost) {
    this.host = host;
    this.cap = host.cap ?? DYNAMIC_TOOL_CAP;
    this.idleMs = host.idleMs ?? DEFAULT_IDLE_MS;
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  listActive(): DynamicToolSlot[] {
    return [...this.slots.values()].map(({ handle: _h, ...slot }) => slot);
  }

  activeCount(): number {
    return this.slots.size;
  }

  reclaimIdle(): string[] {
    const cutoff = this.now() - this.idleMs;
    const stale: string[] = [];
    for (const [toolName, slot] of this.slots) {
      if (slot.lastUsedAt <= cutoff) stale.push(toolName);
    }
    for (const name of stale) this.removeSlot(name);
    return stale;
  }

  startReaper(intervalMs = REAPER_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reclaimIdle();
    }, intervalMs);
    this.timer.unref?.();
  }

  stopReaper(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  activate(platform: string, adapters: AdapterMeta[]): ActivateResult {
    const p = normalizePlatform(platform);
    if (!p) {
      return {
        ok: false,
        error: "Missing platform",
        hint: "Pass a site platform such as twitter or github",
        action: "site_search twitter",
      };
    }

    this.reclaimIdle();

    const ofPlatform = adaptersForPlatform(adapters, p);
    if (ofPlatform.length === 0) {
      return {
        ok: false,
        error: `No adapters for platform '${p}'`,
        hint: "Use site_search / site_list to find installed platforms",
        action: `site_search ${p}`,
      };
    }

    const skipped: Array<{ name: string; reason: string }> = [];
    const activated: string[] = [];
    const already = this.listActive().filter((s) => s.platform === p).map((s) => s.toolName);

    for (const adapter of ofPlatform) {
      const toolName = dynamicToolName(adapter.name);
      if (!toolName) {
        skipped.push({ name: adapter.name, reason: "invalid adapter name" });
        continue;
      }
      if (this.slots.has(toolName)) {
        this.touch(toolName);
        continue;
      }
      if (this.slots.size >= this.cap) {
        skipped.push({ name: adapter.name, reason: `cap ${this.cap}` });
        continue;
      }
      this.registerAdapter(adapter, p, toolName);
      activated.push(toolName);
    }

    const remaining = this.cap - this.slots.size;
    if (activated.length === 0 && already.length === 0) {
      return {
        ok: false,
        error: `Dynamic tool cap is ${this.cap}`,
        hint: "Deactivate a platform first, or wait for idle reclaim (~5 min)",
        action: "site_deactivate",
      };
    }

    return {
      ok: true,
      platform: p,
      activated: [...already, ...activated],
      skipped,
      alreadyActive: activated.length === 0 && already.length > 0,
      cap: this.cap,
      remaining,
    };
  }

  deactivate(platform?: string): DeactivateResult {
    const p = platform ? normalizePlatform(platform) : undefined;
    const removed: string[] = [];
    for (const [toolName, slot] of [...this.slots]) {
      if (p && slot.platform !== p) continue;
      this.removeSlot(toolName);
      removed.push(toolName);
    }
    return { deactivated: removed, remaining: this.slots.size };
  }

  /** Test helper: invoke a registered dynamic tool handler. */
  async invoke(toolName: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    const slot = this.slots.get(toolName);
    if (!slot) {
      return {
        content: [{ type: "text", text: `Error: Dynamic tool '${toolName}' is not active` }],
        isError: true,
      };
    }
    return this.forwardSiteRun(slot.adapterName, toolName, args);
  }

  private touch(toolName: string): void {
    const slot = this.slots.get(toolName);
    if (slot) slot.lastUsedAt = this.now();
  }

  private removeSlot(toolName: string): void {
    const slot = this.slots.get(toolName);
    if (!slot) return;
    this.slots.delete(toolName);
    slot.handle.remove();
  }

  private registerAdapter(adapter: AdapterMeta, platform: string, toolName: string): void {
    const description = adapter.description
      ? `${adapter.description} (forwards to site_run ${adapter.name})`
      : `Run ${adapter.name} (forwards to site_run)`;
    const handle = this.host.registerTool(
      toolName,
      {
        title: adapter.name,
        description,
        inputSchema: argsToZodShape(adapter.args),
      },
      (raw) => this.forwardSiteRun(adapter.name, toolName, raw),
    );
    this.slots.set(toolName, {
      toolName,
      adapterName: adapter.name,
      platform,
      lastUsedAt: this.now(),
      handle,
    });
  }

  private async forwardSiteRun(
    adapterName: string,
    toolName: string,
    raw: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    this.touch(toolName);
    const { namedArgs, tab } = namedArgsFromToolArgs(raw);
    const request: SiteRunRequest = {
      action: "site_run",
      name: adapterName,
      namedArgs,
      ...(tab ? { tabId: tab } : {}),
    };
    const resp = await this.host.runSite(request);
    if (!resp.success) {
      return {
        content: [{ type: "text", text: formatSiteRunError(resp) }],
        isError: true,
      };
    }
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data ?? null, null, 2);
    return { content: [{ type: "text", text }] };
  }
}

export interface InstallDynamicSiteToolsOptions {
  listAdapters: () => Promise<AdapterMeta[]>;
  runSite: (request: SiteRunRequest) => Promise<SiteRunResponse>;
  now?: () => number;
  idleMs?: number;
  cap?: number;
  startReaper?: boolean;
}

/**
 * Register site_activate / site_deactivate and bind a DynamicToolRegistry to
 * `server.registerTool`. Caller must only invoke this when the feature flag is on.
 */
export function installDynamicSiteTools(
  server: McpServer,
  options: InstallDynamicSiteToolsOptions,
): DynamicToolRegistry {
  const registry = new DynamicToolRegistry({
    registerTool: (name, config, handler) =>
      server.registerTool(
        name,
        {
          title: config.title,
          description: config.description,
          inputSchema: config.inputSchema,
        },
        // SDK callback receives parsed args; extra is unused.
        (args: Record<string, unknown>) => handler(args ?? {}),
      ),
    runSite: options.runSite,
    now: options.now,
    idleMs: options.idleMs,
    cap: options.cap,
  });

  server.tool(
    "site_activate",
    "Spike (BB_MCP_DYNAMIC_TOOLS): register up to 8 adapters for a platform as real MCP tools named site_<platform>_<command>. Forwards to site_run (same eval/scope gate). Does not auto-run on site_recommend.",
    {
      platform: z.string().describe("Site platform to activate, e.g. twitter or github"),
    },
    async ({ platform }: { platform: string }) => {
      try {
        const adapters = await options.listAdapters();
        const result = registry.activate(platform, adapters);
        if (!result.ok) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                { error: result.error, hint: result.hint, action: result.action },
                null,
                2,
              ),
            }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "site_deactivate",
    "Spike (BB_MCP_DYNAMIC_TOOLS): unregister dynamic site tools for a platform, or all if platform is omitted. Sends tools/list_changed.",
    {
      platform: z.string().optional().describe("Platform to deactivate; omit to deactivate all"),
    },
    async ({ platform }: { platform?: string }) => {
      const result = registry.deactivate(platform);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  if (options.startReaper !== false) {
    registry.startReaper();
  }

  return registry;
}
