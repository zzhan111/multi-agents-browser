// BACKGROUND_INJECTION_TEMPLATE renderer (design Q2): the literal prompt the
// orchestrator reads when a deep-dive must open a NEW session because the
// original one is gone (v0 report without frontmatter, or session 404).
// This text is a prompt asset — the snapshot test pins it; change it only
// with intent.

import type { Entry, Report } from "../types.js";

/**
 * Inputs are intentionally loose: a deep-dive can fire on a legacy report
 * (frontmatter null) or an entry with unknown engagement. Anything missing
 * degrades to an honest placeholder — the output must never contain the
 * strings "null" or "undefined".
 */
export interface InjectionContext {
  tweetUrl: string;
  author: string;
  createdAt: string;
  tweetText: string;
  likes: number | null;
  retweets: number | null;
  reportTs: string;
  filePath: string;
  reportBodyMd: string;
}

/** Build the injection context from an indexed entry + report pair. */
export function injectionContextFrom(entry: Entry, report: Report): InjectionContext {
  return {
    tweetUrl: entry.url,
    author: entry.author,
    createdAt: entry.createdAt,
    tweetText: entry.text,
    likes: entry.likes ?? null,
    retweets: entry.retweets ?? null,
    reportTs: report.reportTs,
    filePath: report.filePath,
    reportBodyMd: report.bodyMd,
  };
}

// Template structure (kept in sync with the rendered string below):
//
//   [Background — auto-injected by ma-browser vault feature]
//   ├─ tweet header   : url, author, date
//   ├─ tweet body     : blockquoted text
//   ├─ engagement     : likes · retweets          (omitted when unknown)
//   ├─ verdict ref    : report_ts + file path
//   ├─ verdict body   : full report markdown
//   └─ separator + the user's actual question
//
function fmtCount(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : null;
}

function orUnknown(v: string | null | undefined): string {
  return v && v.length > 0 ? v : "(unknown)";
}

export function renderBackgroundInjection(ctx: InjectionContext, userPrompt: string): string {
  const likes = fmtCount(ctx.likes);
  const retweets = fmtCount(ctx.retweets);
  const engagement =
    likes !== null && retweets !== null ? `Engagement: ${likes} likes · ${retweets} retweets\n\n` : "";

  return `[Background — auto-injected by ma-browser vault feature, no need to re-research]

Original tweet (${orUnknown(ctx.tweetUrl)}) by @${orUnknown(ctx.author)} on ${orUnknown(ctx.createdAt)}:
> ${orUnknown(ctx.tweetText)}

${engagement}Previous agent verdict (${orUnknown(ctx.reportTs)}, full report at ${orUnknown(ctx.filePath)}):

${orUnknown(ctx.reportBodyMd)}

---

User is now asking:
${userPrompt}
`;
}
