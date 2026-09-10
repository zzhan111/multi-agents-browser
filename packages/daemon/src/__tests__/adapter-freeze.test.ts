/**
 * M0 freeze generator contract: NetworkRequestInfo fixtures → adapter JS.
 * No Chrome. Locks F2 ranking and F4 strip checklist (U5.2).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkRequestInfo } from "@ma-browser/shared";
import {
  generateFreezeDraft,
  isFreezeCandidate,
  isJsonMime,
  parseAdapterName,
  planFreeze,
  rankFreezeCandidates,
  requestHostMatchesDomain,
  resolvePrivateAdapterFile,
  secretsFromRequest,
  selectFreezeRequest,
  STRIP_HEADER_NAMES,
} from "../adapter-freeze.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "freeze");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as T;
}

const cookieXhr = loadFixture<NetworkRequestInfo>("cookie-xhr.json");
const csrfGraphql = loadFixture<NetworkRequestInfo>("csrf-graphql.json");
const signedXhr = loadFixture<NetworkRequestInfo>("signed-xhr.json");
const mixedWindow = loadFixture<NetworkRequestInfo[]>("window-mixed.json");

function parseMeta(draft: string): Record<string, unknown> {
  const match = /\/\*\s*@meta\s*([\s\S]*?)\*\//.exec(draft);
  assert.ok(match, "draft must contain /* @meta */");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function stripMeta(draft: string): string {
  return draft.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
}

describe("F2 candidate ranking", () => {
  it("rejects Document / Script / Stylesheet / Image even with 2xx", () => {
    for (const id of ["doc-1", "script-1", "css-1", "img-1"]) {
      const req = mixedWindow.find((r) => r.requestId === id);
      assert.ok(req);
      assert.equal(isFreezeCandidate(req), false, id);
    }
  });

  it("rejects non-2xx XHR even when the path looks like /api/", () => {
    const req = mixedWindow.find((r) => r.requestId === "xhr-404");
    assert.ok(req);
    assert.equal(isFreezeCandidate(req), false);
  });

  it("accepts XHR/fetch with JSON mime or /api/ or graphql", () => {
    for (const id of ["xhr-search", "fetch-graphql", "xhr-hot"]) {
      const req = mixedWindow.find((r) => r.requestId === id);
      assert.ok(req);
      assert.equal(isFreezeCandidate(req), true, id);
    }
  });

  it("returns 0 / 1 / N without silently picking when N > 1", () => {
    const none = selectFreezeRequest(mixedWindow.filter((r) => r.type === "Document"));
    assert.equal(none.kind, "none");
    assert.equal(none.candidates.length, 0);

    const oneReq = mixedWindow.filter((r) => r.requestId === "xhr-search");
    const one = selectFreezeRequest(oneReq);
    assert.equal(one.kind, "one");
    if (one.kind === "one") assert.equal(one.selected.requestId, "xhr-search");

    const many = selectFreezeRequest(mixedWindow);
    assert.equal(many.kind, "many");
    if (many.kind === "many") {
      assert.ok(many.candidates.length > 1);
      assert.deepEqual(
        many.candidates.map((c) => c.requestId).sort(),
        ["fetch-graphql", "xhr-hot", "xhr-search"],
      );
    }
  });

  it("ranks JSON /api/ GET above POST graphql, then lists requestId/url/method/status/mimeType", () => {
    const ranked = rankFreezeCandidates(mixedWindow);
    assert.ok(ranked.length >= 2);
    assert.equal(ranked[0].method, "GET");
    assert.ok(["xhr-hot", "xhr-search"].includes(ranked[0].requestId));
    const gql = ranked.findIndex((c) => c.requestId === "fetch-graphql");
    assert.ok(gql > 0, "POST graphql must rank below GET /api/");
    for (const c of ranked) {
      assert.ok(c.requestId);
      assert.ok(c.url);
      assert.ok(c.method);
      assert.ok(typeof c.status === "number");
      assert.ok("mimeType" in c);
      assert.ok(c.score > 0);
    }
  });

  it("honours an explicit requestId even among N candidates", () => {
    const picked = selectFreezeRequest(mixedWindow, "fetch-graphql");
    assert.equal(picked.kind, "one");
    if (picked.kind === "one") assert.equal(picked.selected.requestId, "fetch-graphql");
  });

  it("reports missing requestId without inventing a candidate", () => {
    const missing = selectFreezeRequest(mixedWindow, "no-such-id");
    assert.equal(missing.kind, "missing");
    if (missing.kind === "missing") assert.equal(missing.requestId, "no-such-id");
  });

  it("treats application/json; charset as JSON mime", () => {
    assert.equal(isJsonMime("application/json; charset=utf-8"), true);
    assert.equal(isJsonMime("text/html"), false);
  });
});

describe("F4 strip checklist", () => {
  it("exports the header names that must never be copied as literals", () => {
    assert.ok(STRIP_HEADER_NAMES.includes("cookie"));
    assert.ok(STRIP_HEADER_NAMES.includes("set-cookie"));
    assert.ok(STRIP_HEADER_NAMES.includes("authorization"));
  });

  it("strips Cookie / Authorization / Set-Cookie literals and response body (U5.2)", () => {
    const result = generateFreezeDraft({ name: "example/search", request: cookieXhr });
    const draft = result.draft;
    assert.ok(draft.length > 0);

    assert.doesNotMatch(draft, /Cookie\s*:/i);
    assert.doesNotMatch(draft, /Set-Cookie/i);
    assert.doesNotMatch(draft, /Authorization\s*:\s*Bearer\s+\S+/i);

    for (const secret of secretsFromRequest(cookieXhr)) {
      assert.equal(draft.includes(secret), false, `draft leaked secret: ${secret.slice(0, 24)}`);
    }

    assert.equal(draft.includes("SECRETCOOKIEVALUE123"), false);
    assert.equal(draft.includes("SECRETBEARERTOKEN456"), false);
    assert.equal(draft.includes("UNIQUE_RESPONSE_BODY_SHOULD_NOT_APPEAR"), false);
    assert.ok(result.strippedHeaders.includes("cookie"));
    assert.ok(result.strippedHeaders.includes("authorization"));
  });

  it("reads CSRF from document.cookie instead of pasting the captured token", () => {
    const result = generateFreezeDraft({ name: "twitter/search", request: csrfGraphql });
    assert.equal(result.tier, 2);
    assert.equal(result.incomplete, true);
    assert.match(result.draft, /document\.cookie\.match\(\/ct0=/);
    assert.equal(result.draft.includes("CSRFSECRET789"), false);
    assert.equal(result.draft.includes("TWITTERAUTHTOKEN999"), false);
    assert.match(result.draft, /x-csrf-token.: csrf/);
  });

  it("marks signed/anti-bot headers as Tier 3 incomplete with guide action", () => {
    const result = generateFreezeDraft({ name: "xiaohongshu/search", request: signedXhr });
    assert.equal(result.tier, 3);
    assert.equal(result.incomplete, true);
    assert.equal(result.action, "ma-browser guide");
    assert.equal(result.draft.includes("SIGNED_X_S_VALUE"), false);
    assert.equal(result.draft.includes("XHSSESSIONSECRET"), false);
  });
});

describe("generated draft shape (site_run runtime)", () => {
  it("emits parseable @meta + async function with freeze-draft source", () => {
    const result = generateFreezeDraft({
      name: "example/search",
      request: cookieXhr,
      createdAt: "2026-09-10T00:00:00.000Z",
      tab: "c416",
      seq: 9,
    });
    const meta = parseMeta(result.draft);
    assert.equal(meta.name, "example/search");
    assert.equal(meta.domain, "www.example.com");
    assert.equal(meta.source, "freeze-draft");
    assert.equal(meta.readOnly, true);
    assert.equal(meta.requestId, "cookie-xhr-1");
    assert.equal(meta.method, "GET");
    assert.equal(meta.tab, "c416");
    assert.equal(meta.seq, 9);
    assert.equal(typeof meta.example, "string");
    assert.ok(typeof meta.sourceUrl === "string" && !String(meta.sourceUrl).includes("hello"));
    assert.ok(typeof meta.sourceUrl === "string" && !String(meta.sourceUrl).includes("1710000000"));

    const body = stripMeta(result.draft);
    assert.match(body, /^async function\s*\(args\)/);
    const fn = new Function(`return (${body})`);
    assert.equal(typeof fn(), "function");
  });

  it("uses relative fetch + credentials include and never invents bb.* APIs", () => {
    const result = generateFreezeDraft({ name: "example/search", request: cookieXhr });
    assert.match(result.draft, /credentials:\s*"include"/);
    assert.match(result.draft, /fetch\(url,/);
    assert.match(result.draft, /\/api\/search/);
    assert.doesNotMatch(result.draft, /\bbb\./);
    assert.doesNotMatch(result.draft, /bb\.goto/);
    assert.match(result.draft, /error:\s*"HTTP " \+ resp\.status/);
  });

  it("turns query keys into args and peels captured values out of sourceUrl", () => {
    const result = generateFreezeDraft({ name: "example/search", request: cookieXhr });
    const meta = parseMeta(result.draft);
    const args = meta.args as Record<string, { required?: boolean }>;
    assert.equal(args.q?.required, true);
    assert.ok(args.page);
    assert.equal(args._t, undefined);
    assert.equal(String(meta.sourceUrl).includes("hello"), false);
  });
});

describe("planFreeze (pure orchestration)", () => {
  const bbHome = path.join("/tmp", "bb-freeze-test-home");

  it("returns candidates when N > 1 and does not produce a draft", () => {
    const plan = planFreeze({
      name: "example/search",
      requests: mixedWindow,
      bbHome,
    });
    assert.equal(plan.kind, "candidates");
    if (plan.kind === "candidates") assert.ok(plan.candidates.length > 1);
  });

  it("produces a draft when exactly one candidate matches", () => {
    const plan = planFreeze({
      name: "example/search",
      requests: mixedWindow.filter((r) => r.requestId === "xhr-search"),
      bbHome,
    });
    assert.equal(plan.kind, "draft");
    if (plan.kind === "draft") {
      assert.match(plan.dest, /sites[/\\]example[/\\]search\.js$/);
      assert.match(plan.preview, /async function/);
      assert.equal(plan.dest.includes("bb-sites"), false);
    }
  });

  it("refuses to overwrite a private adapter without overwrite=true (U5.3)", () => {
    const plan = planFreeze({
      name: "example/search",
      requests: mixedWindow.filter((r) => r.requestId === "xhr-search"),
      bbHome,
      alreadyExists: true,
    });
    assert.equal(plan.kind, "error");
    if (plan.kind === "error") {
      assert.match(plan.error, /already exists/);
      assert.match(String(plan.action), /--overwrite/);
    }
  });

  it("overwrites when overwrite=true", () => {
    const plan = planFreeze({
      name: "example/search",
      requests: mixedWindow.filter((r) => r.requestId === "xhr-search"),
      bbHome,
      alreadyExists: true,
      overwrite: true,
    });
    assert.equal(plan.kind, "draft");
  });

  it("errors on 0 candidates with an actionable hint", () => {
    const plan = planFreeze({
      name: "example/search",
      requests: mixedWindow.filter((r) => r.type === "Document"),
      bbHome,
    });
    assert.equal(plan.kind, "error");
    if (plan.kind === "error") assert.match(plan.error, /No API candidates/);
  });

  it("writes only under private sites/, never bb-sites/", () => {
    const dest = resolvePrivateAdapterFile(bbHome, "example/search");
    assert.ok("path" in dest);
    if ("path" in dest) {
      assert.match(dest.path, /sites[/\\]example[/\\]search\.js$/);
      assert.equal(dest.path.includes(`${path.sep}bb-sites${path.sep}`), false);
    }
    const bad = parseAdapterName("../evil/cmd");
    assert.ok("error" in bad);
    const escaped = resolvePrivateAdapterFile(bbHome, "example/search");
    assert.ok("path" in escaped);
  });
});

describe("name + domain helpers", () => {
  it("accepts platform/command and rejects path escape", () => {
    assert.deepEqual(parseAdapterName("example/search"), { platform: "example", command: "search" });
    assert.ok("error" in parseAdapterName("noslash"));
    assert.ok("error" in parseAdapterName("example/search/extra"));
    assert.ok("error" in parseAdapterName("../x/y"));
  });

  it("matches request host to domain with www stripped", () => {
    assert.equal(requestHostMatchesDomain("https://www.example.com/api", "example.com"), true);
    assert.equal(requestHostMatchesDomain("https://api.example.com/v1", "example.com"), true);
    assert.equal(requestHostMatchesDomain("https://evil.test/api", "example.com"), false);
  });
});
