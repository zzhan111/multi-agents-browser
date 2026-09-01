// RSS feed generation for the daemon's `/vault/<name>.xml` endpoint.
//
// Design (DESIGN-V5-MINIMAL.md §M2): the feed is regenerated from SQLite on
// every request — no caching, no background build. It answers one question:
// "What did the cron pipeline find while I was away?" and is meant for
// feed readers (Feedly etc.) behind Basic Auth.
//
// Output is Atom 1.0 (RFC 4287), which feed readers accept more uniformly
// than RSS 2.0 for this use case, and validates against the Atom spec.

/** Minimal entry shape — a projection of `Entry` that the feed serializes. */
export interface FeedEntry {
  tweetId: string;
  author: string;
  text: string;
  url: string;
  /** ISO 8601, normalized at ingest (lexical sort == chronological). */
  createdAt: string;
}

export interface FeedMeta {
  /** Feed title, e.g. "vault.x — Twitter/X Research". */
  title: string;
  /** Absolute HTTP URL of this feed (self link). */
  selfUrl: string;
  /** Feed identity; the vault name is enough. */
  id: string;
  /** When the feed was last generated (ISO 8601). */
  updated: string;
}

/** Escape a string for XML text content (both text and attributes). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Trim to first meaningful line and cap length (feeds are summaries, not essays). */
export function summaryOf(text: string, maxChars = 280): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

const ATOM_NS = "http://www.w3.org/2005/Atom";

/**
 * Serialize entries to an Atom 1.0 document. Entries must be pre-ordered
 * newest-first (the manager's `recent()` already returns them that way).
 */
export function buildAtomFeed(meta: FeedMeta, entries: FeedEntry[]): string {
  const entryXml = entries
    .map((e) => {
      const author = e.author.trim() || "unknown";
      const summary = summaryOf(e.text);
      const id = e.url || `urn:ma-browser:vault:entry:${e.tweetId}`;
      const title = summary || `@${author}`;
      return `
  <entry>
    <title>${escapeXml(title)}</title>
    <id>${escapeXml(id)}</id>
    <link rel="alternate" href="${escapeXml(id)}"/>
    <updated>${escapeXml(e.createdAt)}</updated>
    <published>${escapeXml(e.createdAt)}</published>
    <author><name>${escapeXml(author)}</name></author>
    <summary type="text">${escapeXml(summary)}</summary>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="${ATOM_NS}">
  <title>${escapeXml(meta.title)}</title>
  <id>${escapeXml(meta.id)}</id>
  <link rel="self" href="${escapeXml(meta.selfUrl)}"/>
  <updated>${escapeXml(meta.updated)}</updated>
  <generator uri="https://github.com/zzhan111/multi-agents-browser">ma-browser</generator>${entryXml}
</feed>`;
}
