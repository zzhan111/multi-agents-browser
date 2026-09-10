/**
 * Adapter freeze generator — NetworkRequestInfo → private adapter JS draft.
 *
 * Pure functions only (no Chrome, no filesystem writes). M1 wires these into
 * `site_freeze`. Generated code uses the real site_run runtime (fetch +
 * document.cookie + credentials:'include') and must never invent `bb.*` APIs.
 */

import path from "node:path";
import type { NetworkRequestInfo } from "@ma-browser/shared";

// ---------------------------------------------------------------------------
// F2 candidate ranking
// ---------------------------------------------------------------------------

/**
 * A request is an API freeze candidate when all of the following hold:
 *
 *   1. Resource type is XHR or Fetch (never Document / Script / Stylesheet /
 *      Image / Font / Media / Manifest / WebSocket / Ping / Other).
 *   2. HTTP status is 2xx (pending and failed requests are excluded).
 *   3. JSON mime (`application/json`, `+json`, or mime containing `json`)
 *      OR the URL path contains `/api/` or `graphql` (case-insensitive).
 *
 * Ranking is for *listing* only. F2: if more than one candidate matches,
 * do not silently pick one — return the ranked list for a second call.
 *
 * Score (higher first), then newer timestamp, then requestId:
 *   JSON mime                         +40
 *   path contains `/api/`             +25
 *   path or URL contains `graphql`    +25
 *   GET                               +10
 *   POST                              +5
 */
export const RESOURCE_TYPES_NEVER_API = [
  "Document",
  "Script",
  "Stylesheet",
  "Image",
  "Font",
  "Media",
  "Manifest",
  "WebSocket",
  "Ping",
  "CSPViolationReport",
  "Preflight",
  "Other",
] as const;

export interface FreezeCandidate {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  score: number;
}

export type FreezeTier = 1 | 2 | 3;

export interface FreezeGenerateInput {
  name: string;
  request: NetworkRequestInfo;
  /** Optional domain from last main-frame navigation. */
  domain?: string;
  createdAt?: string;
  tab?: string;
  seq?: number;
}

export interface FreezeGenerateResult {
  draft: string;
  warnings: string[];
  incomplete: boolean;
  tier: FreezeTier;
  strippedHeaders: string[];
  sourceUrl: string;
  domain: string;
  action?: string;
}

export type FreezeSelectResult =
  | { kind: "none"; candidates: FreezeCandidate[] }
  | { kind: "one"; candidates: FreezeCandidate[]; selected: NetworkRequestInfo }
  | { kind: "many"; candidates: FreezeCandidate[] }
  | { kind: "missing"; requestId: string; candidates: FreezeCandidate[] };

export interface FreezePlanInput {
  name: string;
  requests: NetworkRequestInfo[];
  requestId?: string;
  overwrite?: boolean;
  alreadyExists?: boolean;
  bbHome: string;
  domain?: string;
  tab?: string;
  seq?: number;
  createdAt?: string;
}

export type FreezePlan =
  | { kind: "candidates"; candidates: FreezeCandidate[] }
  | {
      kind: "draft";
      dest: string;
      draft: string;
      preview: string;
      warnings: string[];
      incomplete: boolean;
      tier: FreezeTier;
      action?: string;
    }
  | { kind: "error"; error: string; hint?: string; action?: string };

/**
 * F4 strip checklist — header names (lowercase) that must never appear as
 * literals in generated adapter source. Values are dropped, not redacted
 * in-place, so a grep of the draft cannot recover Cookie / Authorization.
 */
export const STRIP_HEADER_NAMES = [
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-auth-token",
  "x-access-token",
  "api-key",
  "x-api-key",
  "apikey",
] as const;

const CSRF_HEADER_NAMES = [
  "x-csrf-token",
  "x-xsrf-token",
  "csrf-token",
  "x-csrf",
  "anti-csrf-token",
  "x-anti-csrf",
];

const CSRF_COOKIE_NAMES = [
  "ct0",
  "csrftoken",
  "csrf_token",
  "xsrf-token",
  "xsrf_token",
  "_csrf",
  "csrf",
  "csrf-token",
];

/** Headers that indicate a signed / webpack-injected request (Tier 3). */
const SIGNED_HEADER_NAMES = [
  "x-s",
  "x-t",
  "x-bogus",
  "x-gorgon",
  "x-khronos",
  "x-argus",
  "x-ladon",
  "x-mini-gid",
  "x-sign",
  "x-signature",
  "x-ssr-signature",
];

const SAFE_PASSTHROUGH_HEADERS = ["accept", "content-type", "x-requested-with"];

const TRACKING_OR_SECRET_PARAM = /^(utm_|h_|_|token$|access_token$|refresh_token$|api[_-]?key$|auth$|signature$|sig$|sign$|nonce$|timestamp$|_t$|ts$|x-s$|x-t$)/i;

const REQUIRED_ARG_NAMES = new Set([
  "q",
  "query",
  "keyword",
  "id",
  "slug",
  "username",
  "user",
  "uid",
  "screen_name",
]);

const ADAPTER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*\/[a-zA-Z][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Name + private path
// ---------------------------------------------------------------------------

export function parseAdapterName(
  name: string,
): { platform: string; command: string } | { error: string } {
  const trimmed = name.trim();
  if (!ADAPTER_NAME_RE.test(trimmed)) {
    return {
      error: "Adapter name must be platform/command (letters, digits, _ or - per segment)",
    };
  }
  const [platform, command] = trimmed.split("/");
  return { platform, command };
}

/**
 * Resolve `$BB_BROWSER_HOME/sites/<platform>/<command>.js`.
 * Refuses path escape and any path under `bb-sites/` (community repo).
 */
export function resolvePrivateAdapterFile(
  bbHome: string,
  name: string,
): { path: string } | { error: string } {
  const parsed = parseAdapterName(name);
  if ("error" in parsed) return parsed;
  const sitesRoot = path.resolve(bbHome, "sites");
  const dest = path.resolve(sitesRoot, parsed.platform, `${parsed.command}.js`);
  const rel = path.relative(sitesRoot, dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: "Refusing to write outside the private sites directory" };
  }
  const communityRoot = path.resolve(bbHome, "bb-sites");
  const relCommunity = path.relative(communityRoot, dest);
  if (relCommunity === "" || (!relCommunity.startsWith("..") && !path.isAbsolute(relCommunity))) {
    return { error: "Refusing to write into the community adapter repository" };
  }
  return { path: dest };
}

// ---------------------------------------------------------------------------
// F2
// ---------------------------------------------------------------------------

function resourceType(req: NetworkRequestInfo): string {
  return (req.type ?? "Other").trim();
}

function isXhrOrFetch(req: NetworkRequestInfo): boolean {
  const t = resourceType(req).toLowerCase();
  return t === "xhr" || t === "fetch";
}

function is2xx(req: NetworkRequestInfo): boolean {
  return typeof req.status === "number" && req.status >= 200 && req.status < 300 && !req.failed;
}

export function isJsonMime(mime?: string): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase().split(";")[0].trim();
  return m === "application/json" || m === "text/json" || m.endsWith("+json") || m.includes("json");
}

function urlPathAndSearch(url: string): { pathname: string; search: string; host: string } | null {
  try {
    const u = new URL(url);
    return { pathname: u.pathname, search: u.search, host: u.hostname };
  } catch {
    return null;
  }
}

function pathLooksLikeApi(url: string): boolean {
  const parsed = urlPathAndSearch(url);
  const hay = parsed ? `${parsed.pathname}${parsed.search}` : url;
  const lower = hay.toLowerCase();
  return lower.includes("/api/") || lower.startsWith("/api") || /graphql/i.test(lower);
}

export function isFreezeCandidate(req: NetworkRequestInfo): boolean {
  if (!isXhrOrFetch(req)) return false;
  if (!is2xx(req)) return false;
  return isJsonMime(req.mimeType) || pathLooksLikeApi(req.url);
}

export function scoreFreezeCandidate(req: NetworkRequestInfo): number {
  let score = 0;
  if (isJsonMime(req.mimeType)) score += 40;
  const parsed = urlPathAndSearch(req.url);
  const pathName = (parsed?.pathname ?? req.url).toLowerCase();
  if (pathName.includes("/api/") || pathName === "/api" || pathName.startsWith("/api/")) score += 25;
  if (/graphql/i.test(pathName) || /graphql/i.test(req.url)) score += 25;
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET") score += 10;
  else if (method === "POST") score += 5;
  return score;
}

export function rankFreezeCandidates(requests: NetworkRequestInfo[]): FreezeCandidate[] {
  return requests
    .filter(isFreezeCandidate)
    .map((req) => ({
      requestId: req.requestId,
      url: req.url,
      method: req.method,
      status: req.status,
      mimeType: req.mimeType,
      score: scoreFreezeCandidate(req),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = requests.find((r) => r.requestId === a.requestId)?.timestamp ?? 0;
      const tb = requests.find((r) => r.requestId === b.requestId)?.timestamp ?? 0;
      if (tb !== ta) return tb - ta;
      return a.requestId.localeCompare(b.requestId);
    });
}

export function selectFreezeRequest(
  requests: NetworkRequestInfo[],
  requestId?: string,
): FreezeSelectResult {
  const candidates = rankFreezeCandidates(requests);
  if (requestId) {
    const selected = requests.find((r) => r.requestId === requestId);
    if (!selected) return { kind: "missing", requestId, candidates };
    return { kind: "one", candidates, selected };
  }
  if (candidates.length === 0) return { kind: "none", candidates };
  if (candidates.length > 1) return { kind: "many", candidates };
  const selected = requests.find((r) => r.requestId === candidates[0].requestId);
  if (!selected) return { kind: "none", candidates: [] };
  return { kind: "one", candidates, selected };
}

// ---------------------------------------------------------------------------
// Domain / host
// ---------------------------------------------------------------------------

function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function requestHostMatchesDomain(requestUrl: string, domain: string): boolean {
  const parsed = urlPathAndSearch(requestUrl);
  if (!parsed) return false;
  const host = stripWww(parsed.host);
  const d = stripWww(domain);
  return host === d || host.endsWith("." + d);
}

function domainFromRequest(url: string): string {
  const parsed = urlPathAndSearch(url);
  return parsed ? parsed.host : "";
}

// ---------------------------------------------------------------------------
// Args + URL peeling
// ---------------------------------------------------------------------------

interface ArgDef {
  required?: boolean;
  description?: string;
}

function isSkippedParam(key: string): boolean {
  return TRACKING_OR_SECRET_PARAM.test(key);
}

function collectQueryArgs(url: string): Record<string, ArgDef> {
  const args: Record<string, ArgDef> = {};
  try {
    const u = new URL(url);
    for (const key of u.searchParams.keys()) {
      if (!key || isSkippedParam(key)) continue;
      args[key] = {
        required: REQUIRED_ARG_NAMES.has(key.toLowerCase()),
        description: `${key} query parameter`,
      };
    }
  } catch {
    /* ignore */
  }
  return args;
}

function parseJsonBody(body?: string): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function collectBodyArgs(body?: string): Record<string, ArgDef> {
  const json = parseJsonBody(body);
  if (!json) return {};
  const args: Record<string, ArgDef> = {};
  for (const key of Object.keys(json)) {
    if (!key || isSkippedParam(key)) continue;
    const value = json[key];
    if (value !== null && typeof value === "object") continue;
    args[key] = {
      required: REQUIRED_ARG_NAMES.has(key.toLowerCase()),
      description: `${key} request body field`,
    };
  }
  return args;
}

function peelSourceUrl(url: string): string {
  try {
    const u = new URL(url);
    const peeled = new URLSearchParams();
    for (const key of u.searchParams.keys()) {
      if (isSkippedParam(key)) continue;
      peeled.append(key, "");
    }
    u.search = peeled.toString();
    return u.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

// ---------------------------------------------------------------------------
// Headers / F4
// ---------------------------------------------------------------------------

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (k) out[k.toLowerCase()] = v;
  }
  return out;
}

function headerLooksSigned(name: string): boolean {
  return SIGNED_HEADER_NAMES.includes(name) || /^(x-s|x-t|sign|signature)$/i.test(name);
}

function detectCsrfCookieName(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  const names = cookieHeader.split(";").map((part) => part.trim().split("=")[0]?.trim() ?? "");
  for (const known of CSRF_COOKIE_NAMES) {
    const hit = names.find((n) => n.toLowerCase() === known.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

function cookieLiteralValues(cookieHeader?: string): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq >= 0 ? part.slice(eq + 1).trim() : "";
    })
    .filter((v) => v.length >= 6);
}

/** Values that F4 forbids appearing in generated source (U5.2). */
export function secretsFromRequest(req: NetworkRequestInfo): string[] {
  const headers = normalizeHeaders(req.requestHeaders);
  const secrets = cookieLiteralValues(headers.cookie);
  if (headers.authorization) {
    const token = headers.authorization.replace(/^(Bearer|Basic|Digest)\s+/i, "").trim();
    if (token) secrets.push(token);
    secrets.push(headers.authorization);
  }
  for (const name of STRIP_HEADER_NAMES) {
    if (name !== "cookie" && name !== "authorization" && headers[name]) secrets.push(headers[name]);
  }
  for (const name of CSRF_HEADER_NAMES) {
    if (headers[name]) secrets.push(headers[name]);
  }
  if (req.responseBody && req.responseBody.length >= 8) secrets.push(req.responseBody);
  return secrets.filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Codegen
// ---------------------------------------------------------------------------

function jsStr(value: string): string {
  return JSON.stringify(value);
}

function indent(lines: string[], spaces = 2): string {
  const pad = " ".repeat(spaces);
  return lines.map((line) => (line.length ? pad + line : line)).join("\n");
}

function mergeArgs(...groups: Array<Record<string, ArgDef>>): Record<string, ArgDef> {
  const out: Record<string, ArgDef> = {};
  for (const group of groups) {
    for (const [k, def] of Object.entries(group)) {
      if (!out[k]) out[k] = def;
      else if (def.required) out[k] = { ...out[k], required: true };
    }
  }
  return out;
}

function buildUrlJs(pathname: string, queryKeys: string[]): string[] {
  if (queryKeys.length === 0) {
    return [`const url = ${jsStr(pathname)};`];
  }
  const lines = ["const params = new URLSearchParams();"];
  for (const key of queryKeys) {
    lines.push(
      `if (args[${jsStr(key)}] !== undefined && args[${jsStr(key)}] !== "") params.set(${jsStr(key)}, String(args[${jsStr(key)}]));`,
    );
  }
  lines.push("const qs = params.toString();");
  lines.push(`const url = ${jsStr(pathname)} + (qs ? "?" + qs : "");`);
  return lines;
}

function buildBodyJs(bodyKeys: string[], json: Record<string, unknown> | null): string[] {
  if (!json || bodyKeys.length === 0) return [];
  const lines = ["const body = {};"];
  for (const key of bodyKeys) {
    lines.push(
      `if (args[${jsStr(key)}] !== undefined && args[${jsStr(key)}] !== "") body[${jsStr(key)}] = args[${jsStr(key)}];`,
    );
  }
  return lines;
}

export function generateFreezeDraft(input: FreezeGenerateInput): FreezeGenerateResult {
  const warnings: string[] = [];
  const strippedHeaders: string[] = [];
  const parsedName = parseAdapterName(input.name);
  if ("error" in parsedName) {
    return {
      draft: "",
      warnings: [parsedName.error],
      incomplete: true,
      tier: 3,
      strippedHeaders: [],
      sourceUrl: input.request.url,
      domain: input.domain ?? "",
      action: "ma-browser guide",
    };
  }

  const req = input.request;
  const headers = normalizeHeaders(req.requestHeaders);
  const cookieHeader = headers.cookie;
  const sourceUrl = peelSourceUrl(req.url);
  let domain = domainFromRequest(req.url);
  if (input.domain && !requestHostMatchesDomain(req.url, input.domain)) {
    warnings.push(
      `Navigation domain ${input.domain} does not match request host; using request host ${domain}`,
    );
  }
  if (!domain) domain = input.domain ?? "example.com";

  const queryArgs = collectQueryArgs(req.url);
  const bodyJson = parseJsonBody(req.requestBody);
  const bodyArgs = collectBodyArgs(req.requestBody);
  const args = mergeArgs(queryArgs, bodyArgs);

  const method = (req.method ?? "GET").toUpperCase();
  let tier: FreezeTier = 1;
  let incomplete = false;
  let action: string | undefined;

  const csrfHeader = CSRF_HEADER_NAMES.find((n) => n in headers);
  const signedHeaders = Object.keys(headers).filter(headerLooksSigned);
  const authHeader = headers.authorization;
  const hasSecretHeader = STRIP_HEADER_NAMES.some((n) => n in headers);

  if (signedHeaders.length > 0) {
    tier = 3;
    incomplete = true;
    action = "ma-browser guide";
    warnings.push(
      `Signed/anti-bot headers detected (${signedHeaders.join(", ")}); freeze cannot generate webpack/Pinia injection. Marked incomplete.`,
    );
  } else if (csrfHeader || authHeader) {
    tier = 2;
    incomplete = true;
    warnings.push(
      csrfHeader
        ? `Extra header ${csrfHeader} required — generated document.cookie read; verify cookie name before use.`
        : "Authorization header present — value stripped. If this site uses a public client Bearer, add it after verifying.",
    );
  }

  for (const name of STRIP_HEADER_NAMES) {
    if (name in headers || (name === "set-cookie" && req.responseHeaders && Object.keys(normalizeHeaders(req.responseHeaders)).includes("set-cookie"))) {
      strippedHeaders.push(name);
    }
  }
  if (req.responseHeaders) {
    const rh = normalizeHeaders(req.responseHeaders);
    if ("set-cookie" in rh && !strippedHeaders.includes("set-cookie")) strippedHeaders.push("set-cookie");
  }
  if (hasSecretHeader) {
    warnings.push("Stripped Cookie / Authorization / secret header literals from the draft.");
  }

  if (method !== "GET" && method !== "HEAD") {
    warnings.push(`HTTP ${method} may mutate state; draft is still readOnly: true — review before use.`);
  }

  const csrfCookie = detectCsrfCookieName(cookieHeader);
  const parsedUrl = urlPathAndSearch(req.url);
  const pathname = parsedUrl?.pathname || "/";
  const sameOrigin = requestHostMatchesDomain(req.url, domain);
  if (!sameOrigin) {
    warnings.push("Request host is cross-origin relative to @meta.domain; draft uses an absolute URL.");
  }

  const queryKeys = Object.keys(queryArgs);
  const bodyKeys = Object.keys(bodyArgs);
  let fetchPath = pathname;
  if (!sameOrigin) {
    try {
      fetchPath = new URL(req.url).origin + pathname;
    } catch {
      fetchPath = pathname;
    }
  }

  const fnLines: string[] = [];
  for (const [argName, def] of Object.entries(args)) {
    if (def.required) {
      fnLines.push(`if (!args[${jsStr(argName)}]) return {error: "Missing argument: ${argName}"};`);
    }
  }

  if (csrfHeader) {
    const cookieName = csrfCookie ?? "csrftoken";
    if (!csrfCookie) {
      warnings.push(`CSRF header ${csrfHeader} present but no known CSRF cookie; guessed '${cookieName}'.`);
    }
    fnLines.push(
      `const csrf = document.cookie.match(/${escapeRegExp(cookieName)}=([^;]+)/)?.[1];`,
      `if (!csrf) return {error: "CSRF token not found", hint: "Not logged in?"};`,
    );
  }

  fnLines.push(...buildUrlJs(fetchPath, queryKeys));
  fnLines.push(...buildBodyJs(bodyKeys, bodyJson));

  const headerLines: string[] = [];
  for (const name of SAFE_PASSTHROUGH_HEADERS) {
    if (headers[name]) headerLines.push(`${jsStr(name)}: ${jsStr(headers[name])}`);
  }
  if (bodyKeys.length > 0 && !headers["content-type"]) {
    headerLines.push(`${jsStr("content-type")}: ${jsStr("application/json")}`);
  }
  if (csrfHeader) {
    headerLines.push(`${jsStr(csrfHeader)}: csrf`);
  }
  if (authHeader && tier !== 3) {
    headerLines.push("// authorization stripped — fill a public client Bearer only after verifying");
  }

  const fetchOpts: string[] = [];
  if (method !== "GET") fetchOpts.push(`method: ${jsStr(method)}`);
  fetchOpts.push("credentials: \"include\"");
  if (headerLines.length > 0) {
    fetchOpts.push(`headers: {\n${indent(headerLines, 6)}\n    }`);
  }
  if (bodyKeys.length > 0) {
    fetchOpts.push("body: JSON.stringify(body)");
  }

  fnLines.push("const resp = await fetch(url, {");
  fnLines.push(indent(fetchOpts.map((o) => o + ","), 4));
  fnLines.push("});");
  fnLines.push('if (!resp.ok) return {error: "HTTP " + resp.status, hint: "Not logged in?"};');
  fnLines.push("return await resp.json();");

  const requiredArgs = Object.entries(args).filter(([, d]) => d.required).map(([k]) => k);
  const exampleArg = requiredArgs[0];
  const example = exampleArg
    ? `ma-browser site ${input.name} <${exampleArg}>`
    : `ma-browser site ${input.name}`;

  const description = `${parsedName.command} (${method} ${pathname}: freeze-draft)`;

  const meta: Record<string, unknown> = {
    name: input.name,
    description,
    domain,
    args,
    readOnly: true,
    example,
    source: "freeze-draft",
    requestId: req.requestId,
    sourceUrl,
    method,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.tab) meta.tab = input.tab;
  if (input.seq !== undefined) meta.seq = input.seq;

  const draft = [
    "/* @meta",
    JSON.stringify(meta, null, 2),
    "*/",
    "async function(args) {",
    indent(fnLines, 2),
    "}",
    "",
  ].join("\n");

  return {
    draft,
    warnings,
    incomplete,
    tier,
    strippedHeaders,
    sourceUrl,
    domain,
    action,
  };
}

/**
 * Plan a freeze without touching disk or Chrome.
 * Caller applies since/method/status filters (or the full ring when requestId
 * is set) before passing `requests`.
 */
export function planFreeze(input: FreezePlanInput): FreezePlan {
  const dest = resolvePrivateAdapterFile(input.bbHome, input.name);
  if ("error" in dest) {
    return { kind: "error", error: dest.error, action: "ma-browser site freeze --name platform/command" };
  }
  if (input.alreadyExists && !input.overwrite) {
    return {
      kind: "error",
      error: `Private adapter '${input.name}' already exists`,
      hint: "Re-run with overwrite to replace the private draft. Community adapters are never overwritten.",
      action: `ma-browser site freeze --name ${input.name} --overwrite`,
    };
  }

  const selected = selectFreezeRequest(input.requests, input.requestId);
  if (selected.kind === "missing") {
    return {
      kind: "error",
      error: `Network request '${selected.requestId}' not found on this tab`,
      hint: "Use network requests --with-body to list request IDs, then pass --request-id.",
      action: "ma-browser network requests --with-body --json",
    };
  }
  if (selected.kind === "none") {
    return {
      kind: "error",
      error: "No API candidates in the current network window",
      hint: "Candidates are XHR/fetch, 2xx, and JSON mime or a path containing /api/ or graphql. Trigger the request again after network clear.",
      action: "ma-browser network requests --with-body --since last_action --json",
    };
  }
  if (selected.kind === "many") {
    return { kind: "candidates", candidates: selected.candidates };
  }

  if (input.domain && !requestHostMatchesDomain(selected.selected.url, input.domain) && !input.requestId) {
    return {
      kind: "error",
      error: "Request host does not match the tab domain",
      hint: "Pass requestId to freeze a cross-origin call only when the URL host matches @meta.domain.",
      action: "ma-browser site freeze --name " + input.name + " --request-id <id>",
    };
  }

  const generated = generateFreezeDraft({
    name: input.name,
    request: selected.selected,
    domain: input.domain,
    createdAt: input.createdAt,
    tab: input.tab,
    seq: input.seq,
  });

  if (!generated.draft) {
    return {
      kind: "error",
      error: generated.warnings[0] ?? "Failed to generate adapter draft",
      action: generated.action ?? "ma-browser guide",
    };
  }

  return {
    kind: "draft",
    dest: dest.path,
    draft: generated.draft,
    preview: generated.draft,
    warnings: generated.warnings,
    incomplete: generated.incomplete,
    tier: generated.tier,
    action: generated.action,
  };
}
