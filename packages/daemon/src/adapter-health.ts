/**
 * Adapter health — local-only status per adapter name.
 *
 * Written on every live site_run end (success and failure). Persisted to
 * $BB_BROWSER_HOME/state/adapter-health.json via StateStore (atomic
 * tmp→rename). Never uploaded. Never deletes adapter files or disables
 * the community library.
 */

import path from "node:path";
import { DAEMON_DIR } from "@ma-browser/shared";
import type { AdapterHealthInfo, AdapterHealthStatus } from "@ma-browser/shared";
import type { AdapterCache } from "./adapter-cache.js";
import { StateStore } from "./state-store.js";

export const ADAPTER_HEALTH_FILENAME = "adapter-health.json";
export const DEFAULT_ADAPTER_HEALTH_FAIL_THRESHOLD = 3;

/** Same regex the CLI uses in site.ts (openclaw auth detection). */
export const ADAPTER_AUTH_ERROR_RE =
  /401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth/i;

export interface HealthAdapterRef {
  name: string;
  domain?: string;
  origin?: string;
}

export interface StoredAdapterHealth {
  status: AdapterHealthStatus;
  lastOkAt?: string;
  lastFailAt?: string;
  lastError?: string;
  consecutiveFails: number;
  lastHttpStatus?: number;
}

export type SiteRunOutcome =
  | { type: "success" }
  | { type: "error"; error: string; hint?: string; structural?: boolean };

export interface AdapterHealthStoreOptions {
  store: StateStore;
  now?: () => number;
  failThreshold?: number;
}

export interface ApplySiteRunHealthResult {
  record: StoredAdapterHealth;
  view: AdapterHealthInfo;
  cacheInvalidated: number;
}

const STATUSES = new Set<AdapterHealthStatus>([
  "unknown",
  "healthy",
  "degraded",
  "broken",
]);

export function defaultAdapterHealthFailThreshold(
  env: NodeJS.Dict<string> = process.env,
): number {
  const raw = env.BB_ADAPTER_HEALTH_FAIL_THRESHOLD;
  if (raw === undefined || raw === "") return DEFAULT_ADAPTER_HEALTH_FAIL_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ADAPTER_HEALTH_FAIL_THRESHOLD;
  return n;
}

export function isAdapterAuthError(error: string, hint?: string): boolean {
  return ADAPTER_AUTH_ERROR_RE.test(`${error} ${hint ?? ""}`);
}

export function extractHttpStatus(text: string): number | undefined {
  const http = /HTTP\s+(\d{3})/i.exec(text);
  if (http) return Number.parseInt(http[1], 10);
  const code = /\b(401|403)\b/.exec(text);
  if (code) return Number.parseInt(code[1], 10);
  return undefined;
}

export function healthSortRank(status: AdapterHealthStatus | undefined): number {
  switch (status) {
    case "healthy":
      return 0;
    case "degraded":
      return 1;
    case "broken":
      return 3;
    default:
      return 2;
  }
}

export function adapterHealthAdvice(
  status: AdapterHealthStatus,
  adapter: HealthAdapterRef,
): { hint?: string; action?: string } {
  if (status === "degraded") {
    const domain = adapter.domain;
    return {
      hint: domain
        ? `需要先登录 ${domain}，请先在 Chrome 中打开该站点并登录`
        : "需要先在 Chrome 中打开并登录对应站点",
      action: domain
        ? `ma-browser open https://${domain}`
        : "ma-browser guide",
    };
  }
  if (status === "broken") {
    return {
      hint: "adapter 连续失败或返回结构异常，建议重新冻结或运行 ma-browser guide",
      action: `ma-browser site freeze --name ${adapter.name}`,
    };
  }
  return {};
}

export function unknownHealth(): AdapterHealthInfo {
  return { status: "unknown", consecutiveFails: 0 };
}

function isStoredRecord(value: unknown): value is StoredAdapterHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.status !== "string" || !STATUSES.has(rec.status as AdapterHealthStatus)) {
    return false;
  }
  if (typeof rec.consecutiveFails !== "number" || !Number.isFinite(rec.consecutiveFails)) {
    return false;
  }
  return true;
}

export class AdapterHealthStore {
  private readonly files: StateStore;
  private readonly now: () => number;
  private readonly failThreshold: number;
  private data: Record<string, StoredAdapterHealth> = {};

  constructor(options: AdapterHealthStoreOptions) {
    this.files = options.store;
    this.now = options.now ?? (() => Date.now());
    this.failThreshold = options.failThreshold ?? defaultAdapterHealthFailThreshold();
    this.load();
  }

  get(name: string): StoredAdapterHealth | undefined {
    return this.data[name];
  }

  statusOf(name: string): AdapterHealthStatus {
    return this.data[name]?.status ?? "unknown";
  }

  /** Snapshot of known statuses for recommend ranking (missing = unknown). */
  statusMap(): ReadonlyMap<string, AdapterHealthStatus> {
    const map = new Map<string, AdapterHealthStatus>();
    for (const [name, rec] of Object.entries(this.data)) {
      map.set(name, rec.status);
    }
    return map;
  }

  view(adapter: HealthAdapterRef): AdapterHealthInfo {
    const rec = this.data[adapter.name];
    if (!rec) return unknownHealth();
    const advice = adapterHealthAdvice(rec.status, adapter);
    return {
      status: rec.status,
      consecutiveFails: rec.consecutiveFails,
      ...(rec.lastOkAt ? { lastOkAt: rec.lastOkAt } : {}),
      ...(rec.lastFailAt ? { lastFailAt: rec.lastFailAt } : {}),
      ...(rec.lastError ? { lastError: rec.lastError } : {}),
      ...(rec.lastHttpStatus !== undefined ? { lastHttpStatus: rec.lastHttpStatus } : {}),
      ...advice,
    };
  }

  record(name: string, outcome: SiteRunOutcome): StoredAdapterHealth {
    const prev = this.data[name];
    const iso = new Date(this.now()).toISOString();
    let next: StoredAdapterHealth;

    if (outcome.type === "success") {
      next = {
        status: "healthy",
        consecutiveFails: 0,
        lastOkAt: iso,
        ...(prev?.lastFailAt ? { lastFailAt: prev.lastFailAt } : {}),
        ...(prev?.lastError ? { lastError: prev.lastError } : {}),
        ...(prev?.lastHttpStatus !== undefined ? { lastHttpStatus: prev.lastHttpStatus } : {}),
      };
    } else {
      const consecutiveFails = (prev?.consecutiveFails ?? 0) + 1;
      const lastHttpStatus = extractHttpStatus(`${outcome.error} ${outcome.hint ?? ""}`);
      let status: AdapterHealthStatus;
      if (outcome.structural || consecutiveFails >= this.failThreshold) {
        status = "broken";
      } else if (isAdapterAuthError(outcome.error, outcome.hint)) {
        status = "degraded";
      } else {
        status = "unknown";
      }
      next = {
        status,
        consecutiveFails,
        lastFailAt: iso,
        lastError: outcome.error,
        ...(prev?.lastOkAt ? { lastOkAt: prev.lastOkAt } : {}),
        ...(lastHttpStatus !== undefined ? { lastHttpStatus } : {}),
      };
    }

    this.data[name] = next;
    this.save();
    return next;
  }

  private load(): void {
    const raw = this.files.read<Record<string, unknown>>(ADAPTER_HEALTH_FILENAME);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const data: Record<string, StoredAdapterHealth> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof name === "string" && name && isStoredRecord(value)) {
        data[name] = {
          status: value.status,
          consecutiveFails: Math.max(0, Math.floor(value.consecutiveFails)),
          ...(typeof value.lastOkAt === "string" ? { lastOkAt: value.lastOkAt } : {}),
          ...(typeof value.lastFailAt === "string" ? { lastFailAt: value.lastFailAt } : {}),
          ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
          ...(typeof value.lastHttpStatus === "number" && Number.isFinite(value.lastHttpStatus)
            ? { lastHttpStatus: value.lastHttpStatus }
            : {}),
        };
      }
    }
    this.data = data;
  }

  private save(): void {
    this.files.write(ADAPTER_HEALTH_FILENAME, this.data);
  }
}

/**
 * Record a live site_run outcome. Cache hits must not call this.
 * When status becomes/stays broken, drop that name's result cache (H4).
 * Does not delete adapter files or disable the community library.
 */
export function applySiteRunHealth(opts: {
  health: AdapterHealthStore;
  cache?: AdapterCache | null;
  adapter: HealthAdapterRef;
  outcome: SiteRunOutcome;
}): ApplySiteRunHealthResult {
  const record = opts.health.record(opts.adapter.name, opts.outcome);
  let cacheInvalidated = 0;
  if (record.status === "broken" && opts.cache) {
    cacheInvalidated = opts.cache.invalidateByName(opts.adapter.name);
  }
  return {
    record,
    view: opts.health.view(opts.adapter),
    cacheInvalidated,
  };
}

let defaultHealth: AdapterHealthStore | null = null;

export function getAdapterHealth(): AdapterHealthStore {
  if (!defaultHealth) {
    defaultHealth = new AdapterHealthStore({
      store: new StateStore(path.join(DAEMON_DIR, "state")),
    });
  }
  return defaultHealth;
}

/** Test-only: drop the process-wide singleton. */
export function resetAdapterHealthForTests(): void {
  defaultHealth = null;
}
