/**
 * News reader — fetches RSS/Atom feeds, parses articles, learns user
 * preferences, and generates a static HTML news summary page ranked by
 * predicted interest.
 *
 * Cross-platform: uses only Deno runtime APIs (fetch, crypto.subtle,
 * TextDecoder). The RSS parser is a lightweight regex-based implementation
 * that handles both RSS 2.0 and Atom feeds, including CDATA sections.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const FeedInputSchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
  category: z.string().optional(),
  addedAt: z.string().optional(),
}).describe("A feed from the feed-catalog");

const FetchArgsSchema = z.object({
  feeds: z.array(z.union([z.string().url(), FeedInputSchema])).default([])
    .describe(
      "RSS/Atom feed URLs to fetch — either string URLs or feed objects from feed-catalog",
    ),
  maxArticlesPerFeed: z.number().int().min(1).max(100).default(25).describe(
    "Maximum articles to keep per feed (default 25)",
  ),
}).describe("Arguments for the fetch method");

type FetchArgs = z.infer<typeof FetchArgsSchema>;

const GenerateArgsSchema = z.object({
  topN: z.number().int().min(0).max(500).default(0).describe(
    "Number of articles to include in the HTML report (0 = all articles, default 0)",
  ),
  title: z.string().default("News Summary").describe(
    "Title for the HTML report page",
  ),
}).describe("Arguments for the generate method");

type GenerateArgs = z.infer<typeof GenerateArgsSchema>;

const FeedbackArgsSchema = z.object({
  articleId: z.string().describe("Article ID (hash of URL)"),
  action: z.enum(["interested", "ignored"]).describe(
    "Whether the user found this article interesting or ignored it",
  ),
  source: z.string().optional().describe("Feed source name"),
  title: z.string().optional().describe("Article title"),
  keywords: z.array(z.string()).optional().describe(
    "Keywords/tags from the article",
  ),
}).describe("Arguments for the feedback method");

type FeedbackArgs = z.infer<typeof FeedbackArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single article parsed from an RSS/Atom feed. */
export interface Article {
  /** Stable ID (SHA-256 hash of the article URL, first 12 hex chars). */
  id: string;
  /** Article title. */
  title: string;
  /** Article URL (link). */
  url: string;
  /** Feed source name. */
  source: string;
  /** ISO-8601 publish date (if available). */
  publishedAt: string;
  /** Summary/snippet text (plain text, HTML stripped). */
  summary: string;
  /** Keywords/tags extracted from the article. */
  keywords: string[];
}

/** A snapshot of all fetched articles from all feeds. */
export interface FeedSnapshot {
  /** ISO-8601 timestamp of the fetch. */
  fetchedAt: string;
  /** All articles from all feeds. */
  articles: Article[];
  /** Feed URLs that failed to fetch. */
  errors: { url: string; message: string }[];
}

/** User preference data accumulated from feedback. */
export interface Preferences {
  /** Articles the user marked as interesting. */
  interested: FeedbackEntry[];
  /** Articles the user marked as ignored. */
  ignored: FeedbackEntry[];
  /** Computed keyword weights (positive = interesting, negative = ignored). */
  keywordWeights: Record<string, number>;
}

/** A single feedback record. */
export interface FeedbackEntry {
  /** Article ID. */
  articleId: string;
  /** ISO-8601 timestamp of the feedback. */
  recordedAt: string;
  /** Feed source name. */
  source: string;
  /** Article title. */
  title: string;
  /** Keywords/tags associated with the article. */
  keywords: string[];
}

/** An article with an interest score attached. */
export interface ScoredArticle extends Article {
  /** Interest score (higher = more interesting). */
  score: number;
  /** Why this score was assigned (which keywords matched). */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Zod schemas for resources
// ---------------------------------------------------------------------------

const ArticleSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  source: z.string(),
  publishedAt: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
});

const FeedSnapshotSchema = z.object({
  fetchedAt: z.iso.datetime(),
  articles: z.array(ArticleSchema),
  errors: z.array(z.object({ url: z.string(), message: z.string() })),
});

const FeedbackEntrySchema = z.object({
  articleId: z.string(),
  recordedAt: z.iso.datetime(),
  source: z.string(),
  title: z.string(),
  keywords: z.array(z.string()),
});

const PreferencesSchema = z.object({
  interested: z.array(FeedbackEntrySchema),
  ignored: z.array(FeedbackEntrySchema),
  keywordWeights: z.record(z.string(), z.number()),
});

// ---------------------------------------------------------------------------
// Shared context type
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  createFileWriter: (
    specName: string,
    instanceName: string,
    overrides?: Record<string, unknown>,
  ) => { writeText: (text: string) => Promise<{ name: string }> };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash a string to a 12-char hex ID. */
async function hashId(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 6).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** Strip HTML tags and CDATA from a string, returning plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape HTML special characters. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Extract keywords from article title and summary. */
export function extractKeywords(
  title: string,
  summary: string,
  maxKeywords = 10,
): string[] {
  const text = `${title} ${summary}`.toLowerCase();
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "it",
    "this",
    "that",
    "as",
    "be",
    "are",
    "was",
    "were",
    "been",
    "have",
    "has",
    "had",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "do",
    "does",
    "did",
    "not",
    "no",
    "yes",
    "if",
    "then",
    "else",
    "when",
    "where",
    "which",
    "who",
    "whom",
    "whose",
    "what",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "also",
    "now",
    "here",
    "there",
    "about",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "up",
    "down",
    "out",
    "off",
    "over",
    "under",
  ]);
  const words = text.match(/[a-z]{3,}/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (stopWords.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([w]) => w);
}

/** Extract the first occurrence of an XML tag's text content. */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(re);
  return match ? stripHtml(match[1]).trim() : null;
}

/** Extract all occurrences of a tag's text or term attribute. */
function extractAllTags(xml: string, tag: string): string[] {
  const termRe = new RegExp(
    `<${tag}[^>]*\\bterm=["']([^"']+)["'][^>]*>`,
    "gi",
  );
  const textRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = termRe.exec(xml)) !== null) results.push(m[1]);
  if (results.length === 0) {
    while ((m = textRe.exec(xml)) !== null) results.push(m[1].trim());
  }
  return results;
}

/** Parse an RSS/Atom XML feed string into articles. */
export function parseFeed(xml: string, feedUrl: string): Article[] {
  const articles: Article[] = [];
  const sourceName = feedUrl.split("/")[2] ?? feedUrl;

  const isAtom = xml.includes("<entry") || xml.includes("<feed");
  const itemRegex = isAtom
    ? /<entry[\s>][\s\S]*?<\/entry>/gi
    : /<item[\s>][\s\S]*?<\/item>/gi;
  const items = xml.match(itemRegex) ?? [];

  for (const item of items) {
    const title = extractTag(item, "title") ?? "(untitled)";
    let link: string;
    if (isAtom) {
      const linkMatch = item.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
      link = linkMatch?.[1] ?? "";
    } else {
      link = extractTag(item, "link") ?? "";
    }
    if (!link) continue;

    const summary = stripHtml(
      extractTag(item, isAtom ? "summary" : "description") ?? "",
    ).slice(0, 500);
    const publishedAt = extractTag(item, isAtom ? "published" : "pubDate") ??
      new Date().toISOString();
    const categories = extractAllTags(item, "category")
      .map((c) => c.toLowerCase())
      .slice(0, 5);

    const keywords = [
      ...new Set([
        ...categories,
        ...extractKeywords(title, summary, 8),
      ]),
    ].slice(0, 10);

    articles.push({
      id: "",
      title,
      url: link,
      source: sourceName,
      publishedAt,
      summary,
      keywords,
    });
  }

  return articles;
}

/** Fetch a single feed URL and parse articles. */
async function fetchFeed(
  url: string,
  maxArticles: number,
): Promise<{ articles: Article[]; error?: string }> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "swamp-news-reader/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      return { articles: [], error: `HTTP ${resp.status}` };
    }
    const xml = await resp.text();
    const articles = parseFeed(xml, url).slice(0, maxArticles);
    for (const a of articles) {
      a.id = await hashId(a.url);
    }
    return { articles };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { articles: [], error: msg };
  }
}

// ---------------------------------------------------------------------------
// Preference scoring
// ---------------------------------------------------------------------------

/** Recompute keyword weights from feedback entries. */
export function computeKeywordWeights(
  prefs: Preferences,
): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const entry of prefs.interested) {
    for (const kw of entry.keywords) {
      weights[kw] = (weights[kw] ?? 0) + 1;
    }
  }
  for (const entry of prefs.ignored) {
    for (const kw of entry.keywords) {
      weights[kw] = (weights[kw] ?? 0) - 1;
    }
  }
  return weights;
}

/** Score an article based on keyword weights. */
export function scoreArticle(
  article: Article,
  keywordWeights: Record<string, number>,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const kw of article.keywords) {
    const w = keywordWeights[kw];
    if (w !== undefined && w !== 0) {
      score += w;
      reasons.push(`${kw} (${w > 0 ? "+" : ""}${w})`);
    }
  }
  return { score, reasons };
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

/** Generate a static HTML page from scored articles. */
export function generateHtml(
  articles: ScoredArticle[],
  prefs: Preferences,
  title: string,
  generatedAt: string,
): string {
  const top = articles;
  const sections: string[] = [];

  sections.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #fafafa; color: #222; }
h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
.meta { color: #666; font-size: 0.9em; margin-bottom: 20px; }
.article { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 12px; background: white; transition: border-color 0.2s; }
.article:hover { border-color: #4a90d9; }
.article h3 { margin: 0 0 8px 0; }
.article h3 a { color: #1a5276; text-decoration: none; }
.article h3 a:hover { text-decoration: underline; }
.source { color: #888; font-size: 0.85em; }
.score { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: bold; }
.score-high { background: #d4edda; color: #155724; }
.score-mid { background: #fff3cd; color: #856404; }
.score-low { background: #f8d7da; color: #721c24; }
.score-zero { background: #e2e3e5; color: #6c757d; }
.summary { color: #555; margin-top: 8px; font-size: 0.95em; line-height: 1.5; }
.keywords { margin-top: 8px; }
.keyword { display: inline-block; background: #e8f0fe; color: #1a73e8; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-right: 4px; }
.feedback { margin-top: 8px; font-size: 0.85em; }
.feedback a { color: #4a90d9; text-decoration: none; margin-right: 12px; cursor: pointer; }
.feedback a:hover { text-decoration: underline; }
.stats { background: #e8f0fe; padding: 12px; border-radius: 8px; margin-bottom: 20px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">Generated ${
    escapeHtml(generatedAt)
  } · ${articles.length} articles from ${
    new Set(articles.map((a) => a.source)).size
  } sources · ${prefs.interested.length} interested, ${prefs.ignored.length} ignored</div>`);

  // Interest profile section
  const topKeywords = Object.entries(prefs.keywordWeights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 10);
  if (topKeywords.length > 0) {
    sections.push('<div class="stats"><b>Your interest profile:</b> ');
    sections.push(
      topKeywords.map(([kw, w]) =>
        `<span class="keyword" style="${
          w > 0
            ? "background:#d4edda;color:#155724"
            : "background:#f8d7da;color:#721c24"
        }">${escapeHtml(kw)} (${w > 0 ? "+" : ""}${w})</span>`
      ).join(" "),
    );
    sections.push("</div>");
  }

  sections.push("<div id='articles'>");

  for (const a of top) {
    const scoreClass = a.score > 2
      ? "score-high"
      : a.score > 0
      ? "score-mid"
      : a.score < 0
      ? "score-low"
      : "score-zero";
    const scoreLabel = a.score > 2
      ? "★"
      : a.score > 0
      ? "↑"
      : a.score < 0
      ? "↓"
      : "·";
    sections.push(`<div class="article" tabindex="0">
<h3><a href="${escapeHtml(a.url)}" target="_blank">${
      escapeHtml(a.title)
    }</a></h3>
<span class="source">${escapeHtml(a.source)} · ${
      escapeHtml(a.publishedAt)
    }</span>
<span class="score ${scoreClass}">${scoreLabel} ${a.score}</span>
<div class="summary">${escapeHtml(a.summary.slice(0, 200))}${
      a.summary.length > 200 ? "…" : ""
    }</div>`);
    if (a.keywords.length > 0) {
      sections.push('<div class="keywords">');
      for (const kw of a.keywords.slice(0, 6)) {
        sections.push(`<span class="keyword">${escapeHtml(kw)}</span>`);
      }
      sections.push("</div>");
    }
    // Feedback links — copy a CLI command to clipboard
    const feedbackCmd = (action: string) =>
      `swamp workflow run news --input action=feedback --input articleId=${a.id} --input feedbackAction=${action} --input 'source=${
        encodeURIComponent(a.source)
      }' --input 'title=${encodeURIComponent(a.title.slice(0, 80))}'`;
    sections.push(`<div class="feedback">
<a onclick="navigator.clipboard.writeText('${
      escapeHtml(feedbackCmd("interested"))
    }').then(()=>{this.textContent='✓ copied';setTimeout(()=>this.textContent='👍 interested',2000)})">👍 interested</a>
<a onclick="navigator.clipboard.writeText('${
      escapeHtml(feedbackCmd("ignored"))
    }').then(()=>{this.textContent='✓ copied';setTimeout(()=>this.textContent='👎 ignore',2000)})">👎 ignore</a>
${
      a.reasons.length > 0
        ? `<span style="color:#aaa">because: ${
          escapeHtml(a.reasons.join(", "))
        }</span>`
        : ""
    }
</div>`);
    sections.push("</div>");
  }

  sections.push("</div>");
  sections.push(`
<script>
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const articles = document.querySelectorAll('.article');
  let current = document.activeElement;
  let idx = current ? Array.from(articles).indexOf(current) : -1;
  if (e.key === 'j') { idx = Math.min(idx + 1, articles.length - 1); articles[idx]?.focus(); }
  if (e.key === 'k') { idx = Math.max(idx - 1, 0); articles[idx]?.focus(); }
});
</script>
</body>
</html>`);
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Model definition for fetching RSS feeds and generating news summaries. */
export const model = {
  type: "@svendowideit/news-reader",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    snapshot: {
      description: "Latest fetched feed snapshot",
      schema: FeedSnapshotSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    preferences: {
      description: "User article preferences and learned keyword weights",
      schema: PreferencesSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    report: {
      description: "Static HTML news summary page",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    fetch: {
      description: "Fetch RSS/Atom feeds and store articles",
      arguments: FetchArgsSchema,
      execute: async (
        args: FetchArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;
        // Normalize feeds: accept string URLs or feed objects from feed-catalog
        const feedUrls: string[] = args.feeds.map((f) =>
          typeof f === "string" ? f : f.url
        );

        if (feedUrls.length === 0) {
          throw new Error(
            "No feed URLs provided. Either:\n" +
              "  1. Pass feeds directly: --input 'feeds:json=[\"https://...\"]'\n" +
              "  2. Add feeds to the feed-catalog model first, then run without --input feeds\n\n" +
              "Usage:\n" +
              "  swamp workflow run news --input 'feeds:json=[\"https://feeds.bbci.co.uk/news/technology/rss.xml\"]'\n\n" +
              "Inputs:\n" +
              "  feeds            string[] or feed objects  RSS/Atom feed URLs (or feed-catalog entries)\n" +
              "  maxArticlesPerFeed integer default: 25  Max articles per feed",
          );
        }
        logger?.info("Fetching {count} feeds", { count: feedUrls.length });

        const allArticles: Article[] = [];
        const errors: { url: string; message: string }[] = [];

        for (const feedUrl of feedUrls) {
          logger?.info("Fetching {url}", { url: feedUrl });
          const result = await fetchFeed(feedUrl, args.maxArticlesPerFeed);
          if (result.error) {
            errors.push({ url: feedUrl, message: result.error });
            logger?.info("Failed: {url} — {error}", {
              url: feedUrl,
              error: result.error,
            });
          } else {
            allArticles.push(...result.articles);
            logger?.info("Got {n} articles from {url}", {
              n: result.articles.length,
              url: feedUrl,
            });
          }
        }

        logger?.info("Fetched {total} articles total, {errors} errors", {
          total: allArticles.length,
          errors: errors.length,
        });

        const handle = await context.writeResource(
          "snapshot",
          "feed-snapshot",
          {
            fetchedAt: new Date().toISOString(),
            articles: allArticles,
            errors,
          },
        );

        return { dataHandles: [handle] };
      },
    },
    generate: {
      description:
        "Generate static HTML report from latest articles, ranked by interest",
      arguments: GenerateArgsSchema,
      execute: async (
        args: GenerateArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const snapshotData = await context.readResource("feed-snapshot") as
          | FeedSnapshot
          | null;
        if (
          !snapshotData || !snapshotData.articles ||
          snapshotData.articles.length === 0
        ) {
          throw new Error(
            "No articles found — run the 'fetch' method first with some feed URLs",
          );
        }

        const prefsData = await context.readResource("prefs-current") as
          | Preferences
          | null;
        const prefs: Preferences = prefsData ?? {
          interested: [],
          ignored: [],
          keywordWeights: {},
        };

        logger?.info(
          "Scoring {articles} articles against {interested} interested, {ignored} ignored",
          {
            articles: snapshotData.articles.length,
            interested: prefs.interested.length,
            ignored: prefs.ignored.length,
          },
        );

        const scored: ScoredArticle[] = snapshotData.articles.map((a) => {
          const { score, reasons } = scoreArticle(a, prefs.keywordWeights);
          return { ...a, score, reasons };
        });

        scored.sort((a, b) =>
          b.score - a.score || b.publishedAt.localeCompare(a.publishedAt)
        );

        const top = args.topN > 0 ? scored.slice(0, args.topN) : scored;
        const generatedAt = new Date().toISOString();

        logger?.info("Generating HTML with {count} articles", {
          count: top.length,
        });

        const html = generateHtml(top, prefs, args.title, generatedAt);

        const writer = context.createFileWriter("report", "news-page");
        const handle = await writer.writeText(html);

        logger?.info("HTML report written ({size} bytes)", {
          size: html.length,
        });

        return { dataHandles: [handle] };
      },
    },
    feedback: {
      description: "Record user feedback on an article (interested or ignored)",
      arguments: FeedbackArgsSchema,
      execute: async (
        args: FeedbackArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const prefsData = await context.readResource("prefs-current") as
          | Preferences
          | null;
        const prefs: Preferences = prefsData ?? {
          interested: [],
          ignored: [],
          keywordWeights: {},
        };

        const entry: FeedbackEntry = {
          articleId: args.articleId,
          recordedAt: new Date().toISOString(),
          source: args.source ?? "",
          title: args.title ?? "",
          keywords: args.keywords ?? [],
        };

        if (args.action === "interested") {
          prefs.ignored = prefs.ignored.filter((e) =>
            e.articleId !== args.articleId
          );
          if (!prefs.interested.some((e) => e.articleId === args.articleId)) {
            prefs.interested.push(entry);
          }
        } else {
          prefs.interested = prefs.interested.filter((e) =>
            e.articleId !== args.articleId
          );
          if (!prefs.ignored.some((e) => e.articleId === args.articleId)) {
            prefs.ignored.push(entry);
          }
        }

        prefs.keywordWeights = computeKeywordWeights(prefs);

        logger?.info("Recorded {action} for article {id}", {
          action: args.action,
          id: args.articleId,
        });

        const handle = await context.writeResource(
          "preferences",
          "prefs-current",
          {
            interested: prefs.interested,
            ignored: prefs.ignored,
            keywordWeights: prefs.keywordWeights,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
  reports: ["@svendowideit/news-html-report"],
};
