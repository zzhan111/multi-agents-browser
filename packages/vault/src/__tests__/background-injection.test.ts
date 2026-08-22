import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderBackgroundInjection,
  injectionContextFrom,
  type InjectionContext,
} from "../templates/background-injection.js";
import type { Entry, Report } from "../types.js";

function fixtureCtx(): InjectionContext {
  return {
    tweetUrl: "https://x.com/seclink/status/0000000000000000001",
    author: "seclink",
    createdAt: "2026-06-28",
    tweetText: "EverMemOS — open-source LLM long-term memory OS.",
    likes: 42,
    retweets: 7,
    reportTs: "2026-06-28T18:08:41",
    filePath: "C:/Users/zhang/research/x/reports/20260628_180841_report.md",
    reportBodyMd: "## Verdict\nSame lane as mem0 / Letta / Zep.",
  };
}

// Snapshot: the rendered template IS the prompt the orchestrator reads.
// Any change here is deliberate prompt engineering — update with intent.
const SNAPSHOT = `[Background — auto-injected by ma-browser vault feature, no need to re-research]

Original tweet (https://x.com/seclink/status/0000000000000000001) by @seclink on 2026-06-28:
> EverMemOS — open-source LLM long-term memory OS.

Engagement: 42 likes · 7 retweets

Previous agent verdict (2026-06-28T18:08:41, full report at C:/Users/zhang/research/x/reports/20260628_180841_report.md):

## Verdict
Same lane as mem0 / Letta / Zep.

---

User is now asking:
compare with mem0's latest, is the storage layer swappable
`;

test("renderBackgroundInjection produces the pinned snapshot for a full context", () => {
  const out = renderBackgroundInjection(fixtureCtx(), "compare with mem0's latest, is the storage layer swappable");
  assert.equal(out, SNAPSHOT);
});

test("renderBackgroundInjection degrades gracefully on missing optional fields — no null/undefined leakage", () => {
  const ctx = fixtureCtx();
  ctx.likes = null;
  ctx.retweets = null;
  const out = renderBackgroundInjection(ctx, "prompt");
  assert.ok(!out.includes("null"), "output must not contain 'null'");
  assert.ok(!out.includes("undefined"), "output must not contain 'undefined'");
  assert.ok(!out.includes("Engagement:"), "engagement line is omitted when counts are unknown");
});

test("renderBackgroundInjection substitutes (unknown) for empty strings, never leaks them", () => {
  const ctx = fixtureCtx();
  ctx.author = "";
  ctx.reportBodyMd = "";
  const out = renderBackgroundInjection(ctx, "prompt");
  assert.ok(out.includes("by @(unknown)"));
  assert.ok(!out.includes("by @\n"));
  // Empty body still renders a visible placeholder rather than a blank void.
  assert.ok(out.includes("(unknown)"), "empty body degrades to (unknown)");
});

test("renderBackgroundInjection does not truncate a long report body", () => {
  const ctx = fixtureCtx();
  const longBody = "x".repeat(50_000);
  ctx.reportBodyMd = longBody;
  const out = renderBackgroundInjection(ctx, "prompt");
  assert.ok(out.includes(longBody), "full body must survive verbatim");
});

test("renderBackgroundInjection preserves CJK text", () => {
  const ctx = fixtureCtx();
  ctx.tweetText = "百宝箱 — 开源 LLM 长期记忆操作系统。";
  ctx.reportBodyMd = "## 结论\n同赛道：mem0 / Letta / Zep。";
  const out = renderBackgroundInjection(ctx, "和 mem0 最新版对比一下");
  assert.ok(out.includes("百宝箱 — 开源 LLM 长期记忆操作系统。"));
  assert.ok(out.includes("同赛道：mem0 / Letta / Zep。"));
  assert.ok(out.includes("和 mem0 最新版对比一下"));
});

test("injectionContextFrom maps an Entry + Report pair into the context", () => {
  const entry: Entry = {
    tweetId: "0000000000000000001",
    vault: "x",
    author: "seclink",
    text: "EverMemOS — open-source LLM long-term memory OS.",
    url: "https://x.com/seclink/status/0000000000000000001",
    likes: 42,
    retweets: 7,
    createdAt: "2026-06-28",
    indexedAt: "2026-06-28T18:10:00Z",
    reportId: "0000000000000000001",
    tags: [],
    processedBy: [],
    notes: [],
    deleted: false,
  };
  const report: Report = {
    tweetId: "0000000000000000001",
    reportTs: "2026-06-28T18:08:41",
    vault: "x",
    filePath: "C:/Users/zhang/research/x/reports/20260628_180841_report.md",
    orchestratorSessionId: null,
    orchestratorType: null,
    bodyMd: "## Verdict\nSame lane as mem0 / Letta / Zep.",
    frontmatter: null,
  };
  const ctx = injectionContextFrom(entry, report);
  assert.equal(ctx.author, "seclink");
  assert.equal(ctx.likes, 42);
  assert.equal(ctx.reportBodyMd, report.bodyMd);

  const out = renderBackgroundInjection(ctx, "go deeper");
  assert.ok(out.includes("by @seclink"));
  assert.ok(out.includes("User is now asking:\ngo deeper"));
});
