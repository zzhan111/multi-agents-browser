/**
 * News-site package generator: turns a news site's base URL into a set of
 * site adapters (`<name>/latest`, `<name>/article`) without any LLM calls.
 *
 * - NEWS_KNOWLEDGE is the domain knowledge base: the task flow news sites share
 *   and the candidate strategies for each step.
 * - generateNewsPackage probes the site, emits one adapter per step, runs each
 *   generated adapter against the live site and keeps the best-scoring strategy
 *   (the self-scoring loop). Nothing is written unless the flow fully passes.
 * - healNewsPackage re-probes a generated package; when the site moved to a new
 *   origin (redirect or canonical URL) it regenerates against the new origin.
 *
 * Generated adapters run in the user's browser through the normal `site_run`
 * path, so login state and cookies come from the real session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface NewsStep {
  command: "latest" | "article";
  description: string;
  keySteps: string[];
}

/** What every news site offers and how to reach it, in task-flow order. */
export const NEWS_KNOWLEDGE: { siteType: "news"; flow: NewsStep[]; feedPaths: string[] } = {
  siteType: "news",
  flow: [
    {
      command: "latest",
      description: "Latest articles (title, url, published, summary)",
      keySteps: ["discover RSS/Atom feed via <link rel=alternate> or common paths", "fetch feed", "parse items"],
    },
    {
      command: "article",
      description: "Read one article (title, author, published, text)",
      keySteps: ["fetch article page", "prefer JSON-LD NewsArticle", "fall back to OpenGraph + <article> paragraphs"],
    },
  ],
  feedPaths: ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"],
};

export interface NewsManifest {
  name: string;
  siteType: "news";
  base: string;
  feedUrl: string;
  generatedAt: string;
  score: NewsScore;
  history: { at: string; event: "generated" | "healed"; base: string }[];
}

export interface NewsScore {
  passed: number;
  total: number;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** In-page helpers shared by all generated adapters (plain JS, no DOM APIs). */
const RUNTIME = String.raw`
  const decode = (s) => String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  const tag = (xml, name) => { const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i")); return m ? decode(m[1]) : ""; };
  const meta = (html, key) => {
    for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
      const t = m[0];
      if (new RegExp("(?:property|name)=[\"']" + key + "[\"']", "i").test(t)) { const c = t.match(/content=["']([^"']*)["']/i); if (c) return decode(c[1]); }
    }
    return "";
  };
  const parseFeed = (xml, base) => {
    const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    return blocks.map((b) => {
      let url = tag(b, "link");
      if (!url) { const h = b.match(/<link[^>]*href=["']([^"']+)["']/i); url = h ? h[1] : ""; }
      try { url = new URL(url, base).href; } catch { /* keep raw */ }
      return { title: tag(b, "title"), url, published: tag(b, "pubDate") || tag(b, "published") || tag(b, "updated"), summary: tag(b, "description") || tag(b, "summary") };
    }).filter((i) => i.title && i.url);
  };
  const parseArticle = (html, url) => {
    let ld = null;
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(m[1]);
        const all = [].concat(data["@graph"] || data);
        ld = all.find((d) => /Article/.test([].concat(d["@type"]).join(" "))) || ld;
      } catch { /* malformed JSON-LD */ }
    }
    const body = html.match(/<article[\s>][\s\S]*?<\/article>/i);
    const paragraphs = body ? [...body[0].matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map((p) => decode(p[0])).filter(Boolean) : [];
    const author = ld && ld.author ? [].concat(ld.author).map((a) => (typeof a === "string" ? a : a.name)).join(", ") : meta(html, "author");
    return {
      url,
      title: (ld && ld.headline) || meta(html, "og:title") || tag(html, "title"),
      author,
      published: (ld && ld.datePublished) || meta(html, "article:published_time"),
      text: (ld && ld.articleBody) || paragraphs.join("\n") || meta(html, "og:description"),
    };
  };
`;

function adapterSource(name: string, step: NewsStep, base: string, feedUrl: string): string {
  const host = new URL(base).hostname;
  const args = step.command === "latest"
    ? { limit: { description: "max items (default 20)" } }
    : { url: { required: true, description: "article URL" } };
  const meta = {
    name: `${name}/${step.command}`,
    description: step.description,
    domain: host,
    args,
    readOnly: true,
    generator: { siteType: "news", base },
    example: step.command === "latest" ? `ma-browser site ${name}/latest 10` : `ma-browser site ${name}/article <url>`,
  };
  const body = step.command === "latest"
    ? `const res = await fetch(${JSON.stringify(feedUrl)}, { credentials: "include" });
  if (!res.ok) return { error: "feed HTTP " + res.status, hint: "site may have moved; run the generator heal step" };
  const items = parseFeed(await res.text(), ${JSON.stringify(base)});
  if (!items.length) return { error: "feed has no items", hint: "site may have changed; run the generator heal step" };
  return { items: items.slice(0, Number(args.limit) || 20) };`
    : `const res = await fetch(args.url, { credentials: "include" });
  if (!res.ok) return { error: "article HTTP " + res.status };
  const article = parseArticle(await res.text(), res.url || args.url);
  if (!article.title || !article.text) return { error: "could not extract article", hint: "page layout changed; run the generator heal step" };
  return article;`;
  return `/* @meta\n${JSON.stringify(meta, null, 2)}\n*/\nasync function(args) {${RUNTIME}\n  ${body}\n}\n`;
}

/** Run an adapter source the way buildAdapterScript + Runtime.evaluate would, but in Node. */
export async function runAdapterSource(source: string, args: Record<string, string>, fetcher: Fetcher = fetch): Promise<any> {
  const body = source.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
  return new Function("fetch", `return (${body})(${JSON.stringify(args)})`)(fetcher);
}

async function scoreFlow(name: string, base: string, feedUrl: string, fetcher: Fetcher) {
  const [latestStep, articleStep] = NEWS_KNOWLEDGE.flow;
  const sources = { latest: adapterSource(name, latestStep, base, feedUrl), article: adapterSource(name, articleStep, base, feedUrl) };
  const checks: NewsScore["checks"] = [];
  const latest = await runAdapterSource(sources.latest, { limit: "5" }, fetcher).catch((e) => ({ error: String(e) }));
  const items = Array.isArray(latest?.items) ? latest.items : [];
  checks.push({ name: "latest returns items", ok: items.length > 0, detail: latest?.error });
  checks.push({ name: "items stay on site", ok: items.length > 0 && items.every((i: any) => new URL(i.url).origin === new URL(base).origin) });
  const article = items[0]
    ? await runAdapterSource(sources.article, { url: items[0].url }, fetcher).catch((e) => ({ error: String(e) }))
    : { error: "no article to read" };
  checks.push({ name: "article has title", ok: Boolean(article?.title), detail: article?.error });
  checks.push({ name: "article has text", ok: String(article?.text || "").length >= 80 });
  return { sources, score: { passed: checks.filter((c) => c.ok).length, total: checks.length, checks } };
}

async function feedCandidates(base: string, fetcher: Fetcher): Promise<string[]> {
  const found: string[] = [];
  try {
    const html = await (await fetcher(base)).text();
    for (const m of html.matchAll(/<link\s[^>]*>/gi)) {
      if (/rel=["']alternate["']/i.test(m[0]) && /(rss|atom)\+xml/i.test(m[0])) {
        const href = m[0].match(/href=["']([^"']+)["']/i);
        if (href) found.push(new URL(href[1], base).href);
      }
    }
  } catch { /* homepage unreachable: fall back to common paths */ }
  for (const path of NEWS_KNOWLEDGE.feedPaths) found.push(new URL(path, base).href);
  return [...new Set(found)];
}

export interface GenerateResult {
  ok: boolean;
  manifest?: NewsManifest;
  files: string[];
  score: NewsScore;
  tried: { feedUrl: string; passed: number }[];
}

/**
 * Generate `<sitesDir>/<name>/{latest,article}.js` plus `_package.json` for a
 * news site. Writes only when every check of the task flow passes.
 */
export async function generateNewsPackage(opts: {
  name: string;
  base: string;
  sitesDir: string;
  fetcher?: Fetcher;
  history?: NewsManifest["history"];
}): Promise<GenerateResult> {
  const fetcher = opts.fetcher ?? fetch;
  const base = new URL(opts.base).origin + "/";
  const tried: GenerateResult["tried"] = [];
  let best: (Awaited<ReturnType<typeof scoreFlow>> & { feedUrl: string }) | undefined;
  for (const feedUrl of await feedCandidates(base, fetcher)) {
    const attempt = await scoreFlow(opts.name, base, feedUrl, fetcher);
    tried.push({ feedUrl, passed: attempt.score.passed });
    if (!best || attempt.score.passed > best.score.passed) best = { ...attempt, feedUrl };
    if (attempt.score.passed === attempt.score.total) break;
  }
  if (!best) return { ok: false, files: [], score: { passed: 0, total: 0, checks: [] }, tried };
  if (best.score.passed < best.score.total) return { ok: false, files: [], score: best.score, tried };

  const dir = join(opts.sitesDir, opts.name);
  mkdirSync(dir, { recursive: true });
  const files = Object.entries(best.sources).map(([command, source]) => {
    const file = join(dir, `${command}.js`);
    writeFileSync(file, source);
    return file;
  });
  const at = new Date().toISOString();
  const manifest: NewsManifest = {
    name: opts.name,
    siteType: "news",
    base,
    feedUrl: best.feedUrl,
    generatedAt: at,
    score: best.score,
    history: [...(opts.history ?? []), { at, event: opts.history ? "healed" : "generated", base }],
  };
  writeFileSync(join(dir, "_package.json"), JSON.stringify(manifest, null, 2));
  return { ok: true, manifest, files, score: best.score, tried };
}

export function readNewsManifest(sitesDir: string, name: string): NewsManifest | undefined {
  const file = join(sitesDir, name, "_package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** Where does the site live now? Follows redirects and the canonical/og:url. */
async function currentOrigin(base: string, fetcher: Fetcher): Promise<string> {
  try {
    const res = await fetcher(base);
    let origin = new URL(res.url || base).origin;
    const html = await res.text();
    const canonical = html.match(/<link\s[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta\s[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
    if (canonical && /^https?:/i.test(canonical)) origin = new URL(canonical).origin;
    return origin + "/";
  } catch {
    return new URL(base).origin + "/";
  }
}

export type HealResult =
  | { status: "healthy"; manifest: NewsManifest; score: NewsScore }
  | { status: "healed"; from: string; to: string; manifest: NewsManifest; score: NewsScore }
  | { status: "broken"; reason: string; score?: NewsScore };

/** Re-check a generated package; regenerate it when the site moved or changed. */
export async function healNewsPackage(opts: { name: string; sitesDir: string; fetcher?: Fetcher }): Promise<HealResult> {
  const fetcher = opts.fetcher ?? fetch;
  const manifest = readNewsManifest(opts.sitesDir, opts.name);
  if (!manifest) return { status: "broken", reason: `no generated package '${opts.name}'` };

  const to = await currentOrigin(manifest.base, fetcher);
  if (to === manifest.base) {
    const { score } = await scoreFlow(manifest.name, manifest.base, manifest.feedUrl, fetcher);
    if (score.passed === score.total) return { status: "healthy", manifest, score };
  }
  const result = await generateNewsPackage({ name: manifest.name, base: to, sitesDir: opts.sitesDir, fetcher, history: manifest.history });
  if (!result.ok || !result.manifest) return { status: "broken", reason: "regeneration did not pass the task flow", score: result.score };
  return { status: "healed", from: manifest.base, to, manifest: result.manifest, score: result.score };
}
