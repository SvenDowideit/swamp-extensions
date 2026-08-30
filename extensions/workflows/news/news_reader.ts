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

const GlobalArgsSchema = z.object({
  /** Base URL of an OpenAI-compatible LLM server (Ollama: http://localhost:11434). */
  llmBaseUrl: z.string().url().default("http://localhost:11434").describe(
    "Base URL of an OpenAI-compatible LLM server. The /v1/chat/completions path is used. Defaults to a local Ollama instance.",
  ),
  /** Model tag used for fusion (Ollama model, e.g. llama3, mistral, qwen2.5). */
  llmModel: z.string().default("").describe(
    "LLM model tag used for story fusion (Ollama model, e.g. llama3, mistral, qwen2.5).",
  ),
  /** API key for LLM servers that require auth (Ollama usually does not). */
  llmApiKey: z.string().optional().meta({ sensitive: true }).describe(
    "Optional API key for LLM servers that require authentication. Ollama typically does not need one.",
  ),
  /** Sampling temperature for fusion LLM calls (low = deterministic). */
  llmTemperature: z.number().min(0).max(2).default(0.1).describe(
    "Sampling temperature for fusion LLM calls. Low values keep extraction deterministic.",
  ),
  /** Minimum articles per cluster before LLM fusion triggers (conservative by default). */
  fusionMinClusterSize: z.number().int().min(1).default(2).describe(
    "Minimum cluster size to trigger LLM fusion. Singletons stay as ordinary summaries unless a story already exists.",
  ),
  /** How long article citations live before aging out; core facts are never dropped. */
  citationRetentionDays: z.number().int().min(0).default(30).describe(
    "How long article citations live before aging out of a story. Core facts always survive.",
  ),
  /** Max concurrent LLM requests for fusion steps (tune per model backend). */
  llmConcurrency: z.number().int().min(1).max(20).default(3).describe(
    "Max concurrent LLM requests for fusion steps. Start at 1 and increase if the server supports it.",
  ),
  /** Hard cap on LLM calls per fusion step; the step stops after this many and the workflow moves on. */
  maxFusions: z.number().int().min(1).default(25).describe(
    "Hard cap on the number of LLM fusion calls made within a single fusion step (fuseStories / seedStories / regenStories). Once reached, the remaining clusters are skipped and persisted as-is.",
  ),
  /** Per-call timeout in seconds for LLM chat/completions requests (default 120s). */
  llmTimeoutSec: z.number().int().min(1).max(600).default(120).describe(
    "Per-call timeout (seconds) for LLM chat/completions requests. Lower values surface server outages faster.",
  ),
  /** Number of server-side LLM failures before the current step halts and the workflow moves on. */
  llmFailureThreshold: z.number().int().min(1).default(3).describe(
    "Server-side LLM failures (outage / timeout / HTTP 5xx) tolerated in a step before the step halts. 1 = fail fast on the first server error. Client-side errors are not counted.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Parse a newsAge string (e.g., "3d", "2h", "4w", "1m") into milliseconds. */
export function parseNewsAge(ageStr: string): number {
  const match = ageStr.match(/^(\d+)([hdwm])$/i);
  if (!match) {
    throw new Error(
      `Invalid newsAge format: "${ageStr}". Use h (hours), d (days), w (weeks), or m (months). Example: "3d" for 3 days.`,
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    case "m":
      return value * 30 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown age unit: ${unit}`);
  }
}

/** Filter articles by age based on publication date. */
export function filterArticlesByAge(
  articles: Article[],
  maxAgeMs: number,
  nowMs?: number,
): Article[] {
  const now = nowMs ?? Date.now();
  const cutoff = now - maxAgeMs;
  return articles.filter((a) => {
    const pubDate = new Date(a.publishedAt).getTime();
    return pubDate >= cutoff && pubDate <= now;
  });
}

const FeedInputSchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
  category: z.string().optional(),
  addedAt: z.string().optional(),
  duplicate: z.boolean().optional(),
  duplicateOf: z.string().optional(),
  invalid: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).describe("A feed from the news-feed-catalog");

const FetchArgsSchema = z.object({
  feeds: z.array(z.union([z.string().url(), FeedInputSchema])).default([])
    .describe(
      "RSS/Atom feed URLs to fetch — either string URLs or feed objects from news-feed-catalog",
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
  outputPath: z
    .string()
    .optional()
    .describe(
      "If set, also write the HTML to this local file path. Defaults to `~/.swamp/news-pages/news.html` when omitted.",
    ),
}).describe("Arguments for the generate method");

type GenerateArgs = z.infer<typeof GenerateArgsSchema>;

const GenerateMobileArgsSchema = z.object({
  topN: z.number().int().min(0).max(500).default(0).describe(
    "Number of articles to include in the mobile HTML report (0 = all articles, default 0)",
  ),
  title: z.string().default("News").describe(
    "Title for the mobile HTML report page",
  ),
  outputPath: z
    .string()
    .optional()
    .describe(
      "If set, also write the mobile HTML to this local file path. Defaults to `~/.swamp/news-pages/news-mobile.html` when omitted.",
    ),
}).describe("Arguments for the generateMobile method");

type GenerateMobileArgs = z.infer<typeof GenerateMobileArgsSchema>;

const DedupeArticlesArgsSchema = z.object({}).describe(
  "Group articles by URL, mark duplicates, and annotate primary articles with duplicate source info",
);

type DedupeArticlesArgs = z.infer<typeof DedupeArticlesArgsSchema>;

const FilterByAgeArgsSchema = z.object({
  newsAge: z.string().default("3d").describe(
    "Time range of news to show (e.g., 2h, 7d, 4w, 1m). Supports h (hours), d (days), w (weeks), m (months). Defaults to 3 days.",
  ),
}).describe("Arguments for the filterByAge method");

type FilterByAgeArgs = z.infer<typeof FilterByAgeArgsSchema>;

const CleanupCdataArgsSchema = z.object({}).describe(
  "Strip CDATA wrappers from existing keywords in snapshots and preferences",
);

type CleanupCdataArgs = z.infer<typeof CleanupCdataArgsSchema>;

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

const GatherFeedbackArgsSchema = z.object({
  serverUrl: z.string().default("http://localhost:8765").describe(
    "URL of the feedback queue HTTP server",
  ),
  batchSize: z.number().int().min(1).max(100).default(100).describe(
    "Number of feedback entries to process per batch",
  ),
  maxBatches: z.number().int().min(1).max(50).default(20).describe(
    "Maximum number of batches to process in one run",
  ),
}).describe("Arguments for the gatherFeedback method");

const GatherPagesArgsSchema = z.object({
  serverUrl: z.string().default("http://localhost:8765").describe(
    "URL of the pages queue HTTP server",
  ),
  batchSize: z.number().int().min(1).max(100).default(100).describe(
    "Number of queued pages to process per batch",
  ),
  maxBatches: z.number().int().min(1).max(50).default(20).describe(
    "Maximum number of batches to process in one run",
  ),
  category: z.string().optional().describe(
    "Category tag applied to each page when adding to the catalog",
  ),
}).describe("Arguments for the gatherPages method");

type GatherFeedbackArgs = z.infer<typeof GatherFeedbackArgsSchema>;

type GatherPagesArgs = z.infer<typeof GatherPagesArgsSchema>;

/** A queued page returned by the pages queue HTTP server. */
export interface QueuedPage {
  id: string;
  url: string;
  createdAt: string;
}

/** A page entry normalized for catalog upsert. */
export interface PageEntry {
  url: string;
  name?: string;
  category?: string;
}

/** Derive a human-readable name from a page URL hostname. */
function extractPageName(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/https?:\/\//, "").replace(/\/$/, "");
  }
}

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
  /** True if this article is a duplicate of another (filtered from output). */
  duplicate?: boolean;
  /** The article ID of the primary article this duplicates. */
  duplicateOf?: string;
  /** For primary articles: list of source names that also carry this article. */
  duplicateSources?: string[];
  /** For primary articles: how many other feeds carry this same article. */
  duplicateCount?: number;
  /** Cached entity extraction (populated by clusterArticles, reused by fuseStories). */
  entities?: string[];
}

/** A snapshot of all fetched articles from all feeds. */
export interface FeedSnapshot {
  /** ISO-8601 timestamp of the fetch. */
  fetchedAt: string;
  /** All articles from all feeds. */
  articles: Article[];
  /** Feed URLs that failed to fetch. */
  errors: { url: string; message: string }[];
  /** Per-feed ETag/Last-Modified cache carried across runs. */
  feedCache?: Record<string, { etag?: string; lastModified?: string }>;
  /** Per-feed article IDs already seen (for incremental reuse). */
  feedArticleIds?: Record<string, string[]>;
}

/** User preference data accumulated from feedback. */
export interface Preferences {
  /** Articles the user marked as interesting. */
  interested: FeedbackEntry[];
  /** Articles the user marked as ignored. */
  ignored: FeedbackEntry[];
  /** Article IDs the user has scrolled into view (seen). */
  seen: string[];
  /** Article IDs the user has opened (clicked the link). */
  read: string[];
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
  /** Per-feed engagement score (interested*3 + read*2 - ignored*3). */
  feedScore?: number;
}

// ---------------------------------------------------------------------------
// Story fusion data model (persistent story objects)
// ---------------------------------------------------------------------------

/** A canonical entity reference (IDs, not bare names). */
export interface EntityRef {
  /** Canonical entity name (e.g. "BBC", "Tesla", "Gaza"). */
  name: string;
  /** Canonical URL/ID when available (feed origin, canonical link). */
  canonicalUrl?: string;
  /** Entity kind (person, org, place, product). */
  kind?: string;
}

/** A claim — the atomic unit of a story. Every fact, not every article. */
export interface Claim {
  /** Claim text. Uncertainty markers ("reportedly", "alleged") preserved. */
  text: string;
  /** Article URLs that support this claim. */
  sources: string[];
  /** Confidence status. "conflicting" when in a Conflict. */
  status: "confirmed" | "reported" | "alleged" | "conflicting";
  /** True if introduced since the last run. */
  isDelta: boolean;
  /** Added timestamp (ISO). */
  addedAt: string;
}

/** An unresolved disagreement between two claims. Never reconciled. */
export interface Conflict {
  claimA: Claim;
  claimB: Claim;
  /** Human note, e.g. "death toll discrepancy between sources". */
  note: string;
  /** When resolved, if ever. */
  resolvedAt?: string;
}

/** Persistent story object — accumulates across runs, survives filter windows. */
export interface Story {
  /** Stable ID: hash of (canonical topic + entities). */
  id: string;
  /** Frozen at seed time; new articles must match it. */
  identity: {
    topic: string;
    entities: EntityRef[];
    seedArticleIds: string[];
  };
  /** Stable established facts (survive the age filter window). */
  core: Claim[];
  /** Delta since last run, newest first. */
  updates: Claim[];
  /** Unresolved disagreements. */
  conflicts: Conflict[];
  status: "confirmed" | "reported" | "alleged" | "unresolved";
  /** Age-managed article references; core facts never dropped. */
  citations: ArticleRef[];
  createdAt: string;
  lastUpdatedAt: string;
  lastRegenAt: string;
}

/** A lightweight article reference for story citations. */
export interface ArticleRef {
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  firstSeenAt: string;
}

/** A cluster of articles judged to be the same story (cheap, pre-LLM). */
export interface StoryCluster {
  /** Canonical topic candidate (from the earliest article). */
  topic: string;
  /** Candidate entities. */
  entities: EntityRef[];
  /** Articles in the cluster. */
  articles: Article[];
  /** True if entity/URL matching was ambiguous — needs the "same story?" LLM gate. */
  needsGate: boolean;
  /** Stable cluster hash for grouping. */
  key: string;
  /** Fingerprint of article IDs + config for change detection. */
  fingerprint?: string;
}

/** Output of an LLM fusion pass. */
export interface FuseResult {
  /** Genuinely new claims (quote-first, deduped against existing core). */
  newClaims: Claim[];
  /** Conflicts surfaced between new claims and existing core. */
  conflicts: Conflict[];
  /** Updated story status. */
  status: Story["status"];
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
  duplicate: z.boolean().optional(),
  duplicateOf: z.string().optional(),
  duplicateSources: z.array(z.string()).optional(),
  duplicateCount: z.number().int().optional(),
});

const FeedSnapshotSchema = z.object({
  fetchedAt: z.iso.datetime(),
  articles: z.array(ArticleSchema),
  errors: z.array(z.object({ url: z.string(), message: z.string() })),
  nonFeedUrls: z.array(
    z.object({ url: z.string().url(), contentType: z.string() }),
  ),
  feedCache: z.record(
    z.string(),
    z.object({
      etag: z.string().optional(),
      lastModified: z.string().optional(),
    }),
  ).optional(),
  feedArticleIds: z.record(z.string(), z.array(z.string())).optional(),
});

const FeedbackEntrySchema = z.object({
  articleId: z.string(),
  recordedAt: z.iso.datetime(),
  source: z.string(),
  title: z.string(),
  keywords: z.array(z.string()),
});

const FilteredSnapshotSchema = FeedSnapshotSchema.extend({
  filteredAt: z.iso.datetime(),
  ageFilter: z.string(),
});

const PreferencesSchema = z.object({
  interested: z.array(FeedbackEntrySchema),
  ignored: z.array(FeedbackEntrySchema),
  seen: z.array(z.string()),
  read: z.array(z.string()),
  keywordWeights: z.record(z.string(), z.number()),
});

const PageEntrySchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
  category: z.string().optional(),
});

const PagesQueueSchema = z.object({
  pages: z.array(PageEntrySchema),
  gatheredAt: z.iso.datetime(),
});

const StorySchema = z.object({
  id: z.string(),
  identity: z.object({
    topic: z.string(),
    entities: z.array(z.object({
      name: z.string(),
      canonicalUrl: z.string().optional(),
      kind: z.string().optional(),
    })),
    seedArticleIds: z.array(z.string()),
  }),
  core: z.array(z.object({
    text: z.string(),
    sources: z.array(z.string()),
    status: z.enum(["confirmed", "reported", "alleged", "conflicting"]),
    isDelta: z.boolean(),
    addedAt: z.string(),
  })),
  updates: z.array(z.object({
    text: z.string(),
    sources: z.array(z.string()),
    status: z.enum(["confirmed", "reported", "alleged", "conflicting"]),
    isDelta: z.boolean(),
    addedAt: z.string(),
  })),
  conflicts: z.array(z.object({
    claimA: z.object({
      text: z.string(),
      sources: z.array(z.string()),
      status: z.enum(["confirmed", "reported", "alleged", "conflicting"]),
      isDelta: z.boolean(),
      addedAt: z.string(),
    }),
    claimB: z.object({
      text: z.string(),
      sources: z.array(z.string()),
      status: z.enum(["confirmed", "reported", "alleged", "conflicting"]),
      isDelta: z.boolean(),
      addedAt: z.string(),
    }),
    note: z.string(),
    resolvedAt: z.string().optional(),
  })),
  status: z.enum(["confirmed", "reported", "alleged", "unresolved"]),
  citations: z.array(z.object({
    url: z.string(),
    title: z.string(),
    source: z.string(),
    publishedAt: z.string(),
    firstSeenAt: z.string(),
  })),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  lastRegenAt: z.string(),
});

const StoriesStateSchema = z.object({
  stories: z.array(StorySchema),
});

const ClusterSchema = z.object({
  topic: z.string(),
  entities: z.array(z.object({
    name: z.string(),
    canonicalUrl: z.string().optional(),
    kind: z.string().optional(),
  })),
  articles: z.array(z.unknown()),
  needsGate: z.boolean(),
  key: z.string(),
});

const ClustersStateSchema = z.object({
  clusters: z.array(ClusterSchema),
  absorbable: z.array(ArticleSchema),
});

// ---------------------------------------------------------------------------
// Shared context type
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  repoDir?: string;
  modelType?: string | { raw: string; normalized: string };
  modelId?: string;
  definition?: {
    id: string;
    name: string;
    version: string;
    tags: Record<string, string>;
  };
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
export async function hashId(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 6).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** Decode common HTML entities (named, numeric, hex, and double-escaped forms). */
export function decodeEntities(s: string): string {
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur
      .replace(/&lt;|&#60;|&#x3C;|&#x3c;/g, "<")
      .replace(/&gt;|&#62;|&#x3E;|&#x3e;/g, ">")
      .replace(/&quot;|&#34;|&#x22;/g, '"')
      .replace(/&apos;|&#39;|&#039;|&#x27;/g, "'")
      .replace(/&nbsp;|&#160;|&#xA0;|&#xa0;/g, " ")
      .replace(/&amp;|&#38;|&#x26;/g, "&");
  } while (cur !== prev);
  return cur;
}

/**
 * Home directory at runtime. Read lazily (not at module top-level) so the
 * module can be imported under `deno test` where `Deno.env` may be
 * unpermitted; falls back to `/tmp` in that case.
 */
export function homeDir(): string {
  try {
    return Deno.env.get("HOME") || "/tmp";
  } catch {
    return "/tmp";
  }
}

/**
 * Resolves an optional HTML output path to a canonical destination, defaulting
 * to `~/.swamp/news-pages/news.html`, and ensures the output directory
 * exists before the file is written. The server-side feedback server reads
 * from the same default, so the two stay consistent.
 */
export async function resolveNewsPagePath(
  outputPath?: string,
): Promise<string> {
  const target = outputPath || `${homeDir()}/.swamp/news-pages/news.html`;
  const dir = target.slice(0, target.lastIndexOf("/"));
  if (dir) {
    await Deno.mkdir(dir, { recursive: true });
  }
  return target;
}

/**
 * Resolves an optional mobile HTML output path to a canonical destination,
 * defaulting to `~/.swamp/news-pages/news-mobile.html`. Ensures the output
 * directory exists before the file is written.
 */
export async function resolveMobileNewsPagePath(
  outputPath?: string,
): Promise<string> {
  const target = outputPath ||
    `${homeDir()}/.swamp/news-pages/news-mobile.html`;
  const dir = target.slice(0, target.lastIndexOf("/"));
  if (dir) {
    await Deno.mkdir(dir, { recursive: true });
  }
  return target;
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Escape HTML special characters. */
export function escapeHtml(s: string): string {
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

// ---------------------------------------------------------------------------
// LLM helpers (OpenAI-compatible chat/completions)
// ---------------------------------------------------------------------------

/**
 * An LLM-call failure, classified as server-side vs client-side.
 *
 * Server-side failures (connection refused / timeout / HTTP 5xx) indicate a
 * transient outage of the LLM backend. Callers should stop retrying in the
 * same step so the workflow can continue on to the next step. Client-side
 * failures (invalid model tag, malformed response) suggest misconfiguration
 * and are not useful to keep retrying.
 */
export class LlmError extends Error {
  /** True when the failure is likely a server outage / transient network issue. */
  readonly serverError: boolean;
  constructor(message: string, serverError: boolean) {
    super(message);
    this.name = "LlmError";
    this.serverError = serverError;
  }
}

/** A lightweight per-method circuit breaker for LLM calls. */
export class CircuitBreaker {
  private failures = 0;
  private readonly threshold: number;
  constructor(threshold: number) {
    this.threshold = Number.isFinite(threshold) && threshold >= 1
      ? Math.floor(threshold)
      : 1;
  }
  recordSuccess(): void {
    this.failures = 0;
  }
  recordFailure(err: unknown): void {
    if (isLlmServerError(err)) this.failures += 1;
  }
  shouldStop(): boolean {
    return this.failures >= this.threshold;
  }
  tripCount(): number {
    return this.failures;
  }
}

/** True when the error is an LlmError caused by a server-side failure. */
export function isLlmServerError(err: unknown): boolean {
  return err instanceof LlmError && err.serverError;
}

/** A chat message for an OpenAI-compatible endpoint. */
type ChatMessage = { role: "system" | "user"; content: string };

/**
 * Call an OpenAI-compatible /v1/chat/completions endpoint (works with Ollama
 * and most local/remote servers). Returns the assistant message content.
 */
export async function chatCompletion(
  args: GlobalArgs,
  messages: ChatMessage[],
  opts?: { json?: boolean },
): Promise<string> {
  const base = args.llmBaseUrl.replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.llmApiKey) headers.Authorization = `Bearer ${args.llmApiKey}`;

  const body = {
    model: args.llmModel,
    messages,
    temperature: args.llmTemperature,
    stream: false,
    ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
  };

  const timeoutMs = Math.max(1, Number(args.llmTimeoutSec) || 120) * 1000;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmError(
      `LLM server unreachable at ${url}: ${msg}. Check llmBaseUrl / llmModel global args.`,
      true,
    );
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new LlmError(
      `LLM request failed (${resp.status} ${resp.statusText}): ${
        errText.slice(0, 300)
      }`,
      resp.status >= 500,
    );
  }

  const data = await resp.json() as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new LlmError(
      `LLM returned no content: ${JSON.stringify(data).slice(0, 300)}`,
      false,
    );
  }
  return content;
}

/**
 * Extract the first JSON object from an LLM response, tolerating markdown
 * code fences and surrounding prose.
 */
export function extractJsonObject<T = Record<string, unknown>>(
  raw: string,
): T {
  let text = raw.trim();
  // Strip markdown code fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Fall back to the first {...} span if fences are absent.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object in LLM response: ${raw.slice(0, 300)}`);
  }
  const json = text.slice(start, end + 1);
  return JSON.parse(json) as T;
}

// ---------------------------------------------------------------------------
// LLM connectivity probing (used by the `setup` method to test settings live)
// ---------------------------------------------------------------------------

/** A single connectivity check with an optional remediation hint. */
export interface LlmProbeCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  remediation?: string;
}

/** Structured result of probing an LLM server with a candidate model tag. */
export interface LlmProbeResult {
  baseUrl: string;
  model: string;
  checks: LlmProbeCheck[];
  availableModels: string[];
  suggestedModel?: string;
  ok: boolean;
}

/** Common LLM server ports, probed when the configured port is refused. */
const COMMON_LLM_PORTS = [
  11434, // Ollama
  1234, // LM Studio
  8080, // llama.cpp / text-generation-webui
  8000, // vLLM / LM Studio (older)
  5000, // text-generation-webui (older)
  5001, // KoboldCpp
];

/** Levenshtein edit distance for spelling suggestions. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/** Suggest the closest model tag from a list of available models. */
export function suggestModelSpelling(
  model: string,
  available: string[],
  maxDistance = 3,
): string | undefined {
  if (!model || available.length === 0) return undefined;
  const target = model.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const cand of available) {
    const c = cand.toLowerCase();
    // Prefer a match on the base name (before any `:tag`).
    const base = c.split(":")[0];
    const dist = Math.min(
      levenshtein(target, c),
      levenshtein(target, base),
    );
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return bestDist <= maxDistance ? best : undefined;
}

/**
 * Probe an OpenAI-compatible LLM server end-to-end: URL/scheme, DNS, TCP port,
 * model list (Ollama `/api/tags` and OpenAI `/v1/models`), model spelling, auth,
 * and a tiny completion. Returns a structured result with remediation hints.
 */
export async function probeLlm(
  baseUrl: string,
  model: string,
  apiKey?: string,
): Promise<LlmProbeResult> {
  const checks: LlmProbeCheck[] = [];
  const availableModels: string[] = [];
  let suggestedModel: string | undefined;

  // 1. URL parse + scheme.
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {
      baseUrl,
      model,
      checks: [{
        name: "url",
        status: "fail",
        detail: `"${baseUrl}" is not a valid URL`,
        remediation:
          "Include the scheme, e.g. http://localhost:11434 (not localhost:11434).",
      }],
      availableModels,
      ok: false,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    checks.push({
      name: "url",
      status: "fail",
      detail: `unsupported scheme "${parsed.protocol}"`,
      remediation: "Use http:// or https://.",
    });
    return { baseUrl, model, checks, availableModels, ok: false };
  }
  checks.push({
    name: "url",
    status: "pass",
    detail: `parsed ${parsed.protocol}//${parsed.host}`,
  });

  const host = parsed.hostname;
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
    ? 443
    : 80;

  // 2. DNS resolution.
  try {
    await Deno.resolveDns(host, "A");
    checks.push({ name: "dns", status: "pass", detail: `resolved ${host}` });
  } catch {
    checks.push({
      name: "dns",
      status: "fail",
      detail: `hostname "${host}" does not resolve`,
      remediation:
        "Check the hostname spelling. Note that .local/.home mDNS names only resolve on the local subnet.",
    });
    return { baseUrl, model, checks, availableModels, ok: false };
  }

  // 3. TCP connect to the configured port.
  try {
    const conn = await Deno.connect({ hostname: host, port });
    conn.close();
    checks.push({
      name: "port",
      status: "pass",
      detail: `connected to ${host}:${port}`,
    });
  } catch {
    // Probe common ports to suggest the right one.
    const openPorts: number[] = [];
    for (const p of COMMON_LLM_PORTS) {
      if (p === port) continue;
      try {
        const c = await Deno.connect({ hostname: host, port: p });
        c.close();
        openPorts.push(p);
      } catch {
        // ignore
      }
    }
    const remediation = openPorts.length > 0
      ? `port ${port} refused; ${
        openPorts.join(", ")
      } is open — try http://${host}:${openPorts[0]}`
      : `port ${port} refused and no common LLM port is open on ${host} — is the server running?`;
    checks.push({
      name: "port",
      status: "fail",
      detail: `could not connect to ${host}:${port}`,
      remediation,
    });
    return { baseUrl, model, checks, availableModels, ok: false };
  }

  // 4. Model list — try Ollama then OpenAI surfaces.
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let listSource = "";
  try {
    const ollama = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (ollama.ok) {
      const data = await ollama.json() as {
        models?: { name: string }[];
      };
      for (const m of data.models ?? []) availableModels.push(m.name);
      listSource = "ollama";
    }
  } catch {
    // ignore
  }

  if (availableModels.length === 0) {
    try {
      const openai = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (openai.ok) {
        const data = await openai.json() as {
          data?: { id: string }[];
        };
        for (const m of data.data ?? []) availableModels.push(m.id);
        listSource = "openai";
      }
    } catch {
      // ignore
    }
  }

  if (availableModels.length > 0) {
    checks.push({
      name: "model-list",
      status: "pass",
      detail: `${availableModels.length} models via ${listSource}`,
    });
  } else {
    checks.push({
      name: "model-list",
      status: "warn",
      detail: "server reachable but no model list returned",
      remediation:
        "The server may not expose /api/tags (Ollama) or /v1/models (OpenAI). Verify the endpoint.",
    });
  }

  // 5. Model spelling suggestion.
  if (model && availableModels.length > 0) {
    const exact = availableModels.some((m) =>
      m.toLowerCase() === model.toLowerCase()
    );
    if (!exact) {
      suggestedModel = suggestModelSpelling(model, availableModels);
      checks.push({
        name: "model",
        status: suggestedModel ? "warn" : "fail",
        detail: `model "${model}" not in the server's model list`,
        remediation: suggestedModel
          ? `Did you mean "${suggestedModel}"?`
          : `Available models: ${availableModels.slice(0, 10).join(", ")}`,
      });
    } else {
      checks.push({
        name: "model",
        status: "pass",
        detail: `model "${model}" is available`,
      });
    }
  }

  // 6. Auth check (only when a key is set).
  if (apiKey) {
    try {
      const authResp = await fetch(
        `${baseUrl.replace(/\/+$/, "")}/v1/models`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      if (authResp.status === 401 || authResp.status === 403) {
        checks.push({
          name: "auth",
          status: "fail",
          detail: `HTTP ${authResp.status} with the provided key`,
          remediation:
            "The key was rejected. If this is Ollama, it does not need a key — remove llmApiKey.",
        });
      } else {
        checks.push({
          name: "auth",
          status: "pass",
          detail: `key accepted (HTTP ${authResp.status})`,
        });
      }
    } catch {
      checks.push({
        name: "auth",
        status: "warn",
        detail: "could not verify the key",
      });
    }
  }

  // 7. Tiny end-to-end completion.
  if (model) {
    try {
      const started = Date.now();
      const content = await chatCompletion(
        {
          llmBaseUrl: baseUrl,
          llmModel: model,
          llmApiKey: apiKey,
          llmTemperature: 0,
          fusionMinClusterSize: 2,
          citationRetentionDays: 30,
          llmConcurrency: 1,
          maxFusions: 1,
          llmTimeoutSec: 30,
          llmFailureThreshold: 1,
        },
        [
          { role: "system", content: "Reply with the single word OK." },
          { role: "user", content: "OK" },
        ],
      );
      const ms = Date.now() - started;
      checks.push({
        name: "completion",
        status: "pass",
        detail: `model responded in ${ms}ms`,
        remediation: ms > 10000
          ? "Completion was slow — the model may be cold-loading; consider a smaller model."
          : undefined,
      });
      if (!content.trim()) {
        checks.push({
          name: "completion",
          status: "warn",
          detail: "model returned empty content",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "completion",
        status: "fail",
        detail: msg,
        remediation:
          "The model may not be pulled yet (e.g. `ollama pull <model>`), or the endpoint path is wrong.",
      });
    }
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { baseUrl, model, checks, availableModels, suggestedModel, ok };
}

/**
 * Format global arguments as a copy-paste YAML `globalArguments:` block for the
 * model definition file. The API key is redacted — the user must fill it in
 * themselves (or leave it empty for keyless servers like Ollama).
 */
export function formatGlobalArgsYaml(
  args: GlobalArgs,
  redactApiKey = true,
): string {
  const lines: string[] = ["globalArguments:"];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "llmApiKey" && redactApiKey) {
      lines.push(`  ${key}: "***REDACTED — paste your key here***"`);
      continue;
    }
    if (typeof value === "number") {
      lines.push(`  ${key}: ${value}`);
    } else {
      lines.push(`  ${key}: "${String(value).replace(/"/g, '\\"')}"`);
    }
  }
  return lines.join("\n");
}

/**
 * Format only the global arguments that differ from the current persisted
 * values, as a copy-paste YAML `globalArguments:` block. Used by `setup` to
 * show the exact keys to change (and nothing else). The API key is redacted.
 */
export function formatGlobalArgsDiffYaml(
  current: GlobalArgs,
  next: GlobalArgs,
): string {
  const lines: string[] = ["globalArguments:"];
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === "") continue;
    const cur = (current as Record<string, unknown>)[key];
    if (cur === value) continue;
    if (key === "llmApiKey") {
      lines.push(`  ${key}: "***REDACTED — paste your key here***"`);
      continue;
    }
    if (typeof value === "number") {
      lines.push(`  ${key}: ${value}`);
    } else {
      lines.push(`  ${key}: "${String(value).replace(/"/g, '\\"')}"`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Story clustering (cheap, no LLM)
// ---------------------------------------------------------------------------

const STOP_ENTITIES = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "in",
  "on",
  "for",
  "with",
  "by",
  "from",
  "at",
  "to",
  "is",
  "are",
  "was",
  "were",
  "has",
  "had",
  "have",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "they",
  "them",
  "their",
  "who",
  "what",
  "when",
  "where",
  "which",
  "why",
  "how",
  "not",
  "no",
  "yes",
]);

/** Heuristic entity candidates from title + summary (proper nouns / key terms). */
export function extractEntities(
  title: string,
  summary: string,
  maxEntities = 5,
): string[] {
  const text = `${title} ${summary}`;
  const candidates = text.match(/[A-Z][A-Za-z0-9&'.\-]+/g) ?? [];
  const out: string[] = [];
  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (STOP_ENTITIES.has(lower)) continue;
    if (lower.length < 3) continue;
    if (!out.includes(c)) out.push(c);
    if (out.length >= maxEntities) break;
  }
  // Fall back to keywords if no capitalized entities were found.
  if (out.length === 0) {
    return extractKeywords(title, summary, maxEntities).map((k) =>
      k.charAt(0).toUpperCase() + k.slice(1)
    );
  }
  return out;
}

/** Normalize an article URL to a canonical key (lowercase, strip query/fragment). */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

/** Day-normalized publish key for date proximity (e.g. 2026-08-13). */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Stable cluster key from topic + entities. */
export function clusterKey(topic: string, entities: EntityRef[]): string {
  const names = entities.map((e) => e.name.toLowerCase()).sort();
  return clusterHash(`${topic.toLowerCase()}::${names.join(",")}`);
}

/**
 * Conservatively cluster articles by extracted entities, canonical URLs and
 * date proximity. Ambiguous pairs are flagged with needsGate for the LLM
 * "same story?" check instead of being force-joined.
 */
export function clusterStories(
  articles: Article[],
  existing: Story[] = [],
  maxClusterSize = 40,
): { clusters: StoryCluster[]; absorbable: Article[] } {
  const clusters: StoryCluster[] = [];

  // Existing stories can absorb matching articles; seed new clusters otherwise.
  const absorbable: Article[] = [];
  const leftovers: Article[] = [];

  for (const a of articles) {
    const entities = extractEntities(a.title, a.summary ?? "");
    a.entities = entities;
    const canon = canonicalUrl(a.url);
    let matched = false;

    for (const st of existing) {
      const stCanons = st.citations.map((c) => canonicalUrl(c.url));
      const stEntities = st.identity.entities.map((e) => e.name.toLowerCase());
      const entMatch = entities.filter((e) =>
        stEntities.includes(e.toLowerCase())
      ).length;
      const urlMatch = stCanons.includes(canon);

      // Conservative: require a concrete entity hit OR canonical-URL match.
      if (urlMatch || entMatch >= 2) {
        matched = true;
        absorbable.push(a);
        break;
      }
    }
    if (!matched) leftovers.push(a);
  }

  // Group leftovers into fresh clusters by entity overlap + date proximity.
  const used = new Set<string>();
  for (const a of leftovers) {
    if (used.has(a.id)) continue;
    const entities = extractEntities(a.title, a.summary ?? "");
    a.entities = entities;
    const canon = canonicalUrl(a.url);
    const day = dayKey(a.publishedAt);

    const group: Article[] = [a];
    used.add(a.id);
    let needsGate = false;

    for (const b of leftovers) {
      if (used.has(b.id)) continue;
      const bEntities = extractEntities(b.title, b.summary ?? "");
      b.entities = bEntities;
      const bCanon = canonicalUrl(b.url);
      const bDay = dayKey(b.publishedAt);
      const shared = entities.filter((e) => bEntities.includes(e)).length;
      const urlMatch = canon === bCanon;
      const sameDay = day !== "" && bDay !== "" && day === bDay;
      const nearDay = day !== "" && bDay !== "" &&
        Math.abs(new Date(day).getTime() - new Date(bDay).getTime()) <=
          48 * 3600 * 1000;

      if (shared >= 2 || (shared >= 1 && sameDay) || urlMatch) {
        group.push(b);
        used.add(b.id);
      } else if (shared === 1 && nearDay) {
        needsGate = true;
      }
    }

    const topic = group[0].title.replace(/\s+/g, " ").trim().slice(0, 120);
    const entRefs: EntityRef[] = [];
    for (const e of extractEntities(group[0].title, group[0].summary ?? "")) {
      entRefs.push({ name: e, kind: guessEntityKind(e) });
    }
    const key = clusterKey(topic, entRefs);
    clusters.push({
      topic,
      entities: entRefs,
      articles: group.slice(0, maxClusterSize),
      needsGate,
      key,
    });
  }

  // Merge any absorbable articles back into their matched clusters below;
  // they are handled by fuseStory against the existing Story directly.
  return { clusters, absorbable };
}

/** Crude entity kind heuristic (person/org/place/product). */
export function guessEntityKind(name: string): string {
  if (/^[A-Z][a-z]+$/.test(name) && name.length <= 20) return "person";
  if (/[A-Z]{2,}/.test(name)) return "org";
  return "place";
}

export function clusterHash(input: string): string {
  const data = new TextEncoder().encode(input);
  return [...new Uint8Array(data)].reduce(
    (acc, b) => (acc + b * 31) % 2147483647,
    7,
  ).toString(36).slice(0, 10);
}

// ---------------------------------------------------------------------------
// LLM fusion (seed / delta / regen)
// ---------------------------------------------------------------------------

/** Run async tasks with a concurrency limit (index-based, thread-safe). */
export async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** Render a cluster's articles for the LLM seed prompt. */
function articlesForPrompt(cluster: StoryCluster): string {
  return cluster.articles.map((a, i) => {
    const src = a.source || canonicalUrl(a.url);
    return `[${i + 1}] ${a.title} (${src}, ${a.publishedAt || "no date"})\n${
      a.summary ?? ""
    }`;
  }).join("\n");
}

/**
 * Seed a new story from a cluster. Uses the LLM to extract core facts
 * (confirmed claims) and candidate entities, then persists a Story object.
 */
export async function seedStory(
  args: GlobalArgs,
  cluster: StoryCluster,
): Promise<Story> {
  const prompt = `You are a meticulous news fusion engine. Given the following
articles that all cover the SAME story, extract:
1. "topic": a concise canonical topic phrase (no quotes, lowercase-ish).
2. "entities": array of {name, kind} for the key named entities (person/org/place/product).
3. "claims": array of core fact strings that are SUPPORTED by the articles.
   Preserve uncertainty markers ("reportedly", "allegedly", "about").
4. "status": one of confirmed|reported|alleged|unresolved.

Be conservative: do not invent facts. Return ONLY JSON, no prose.

Articles:
${articlesForPrompt(cluster)}`;

  const raw = await chatCompletion(args, [
    { role: "system", content: "You output strictly valid JSON. No markdown." },
    { role: "user", content: prompt },
  ], { json: true });

  const parsed = extractJsonObject<{
    topic?: string;
    entities?: { name: string; kind?: string }[];
    claims?: string[];
    status?: Story["status"];
  }>(raw);

  const topic = parsed.topic || cluster.topic;
  const entities: EntityRef[] = (parsed.entities ?? []).map((e) => ({
    name: e.name,
    kind: e.kind ?? guessEntityKind(e.name),
  }));
  if (entities.length === 0) {
    entities.push(...cluster.entities);
  }

  const now = new Date().toISOString();
  const claims: Claim[] = (parsed.claims ?? []).map((text) => ({
    text,
    sources: cluster.articles.map((a) => a.url),
    status: "confirmed",
    isDelta: true,
    addedAt: now,
  }));

  const citations: ArticleRef[] = cluster.articles.map((a) => ({
    url: a.url,
    title: a.title,
    source: a.source,
    publishedAt: a.publishedAt,
    firstSeenAt: now,
  }));

  return {
    id: cluster.key ||
      clusterHash(topic + "::" + entities.map((e) => e.name).join(",")),
    identity: {
      topic,
      entities,
      seedArticleIds: cluster.articles.map((a) => a.id),
    },
    core: claims,
    updates: claims,
    conflicts: [],
    status: parsed.status ?? "reported",
    citations,
    createdAt: now,
    lastUpdatedAt: now,
    lastRegenAt: now,
  };
}

/** Merge new cluster articles into an existing story via the LLM delta pass. */
export async function fuseStory(
  args: GlobalArgs,
  story: Story,
  newArticles: Article[],
): Promise<Story> {
  if (newArticles.length === 0) return story;

  const existingClaims = story.core.map((c) => c.text).join("\n- ");
  const prompt = `You are a meticulous news fusion engine. A story already has
these established core claims:
- ${existingClaims}

New articles on the same story follow. Extract:
1. "newClaims": array of GENUINELY NEW fact strings (quote-first) supported by
   the new articles. Do NOT repeat existing claims. Preserve uncertainty markers.
2. "conflicts": array of {claimA, claimB, note} ONLY when a new claim
   contradicts an existing one (e.g. different figures). Never reconcile.
3. "status": confirmed|reported|alleged|unresolved.

Be conservative. Return ONLY JSON, no prose.

New articles:
${
    newArticles.map((a, i) =>
      `[${i + 1}] ${a.title} (${a.source || canonicalUrl(a.url)}, ${
        a.publishedAt || "no date"
      })\n${a.summary ?? ""}`
    ).join("\n")
  }`;

  const raw = await chatCompletion(args, [
    { role: "system", content: "You output strictly valid JSON. No markdown." },
    { role: "user", content: prompt },
  ], { json: true });

  const parsed = extractJsonObject<{
    newClaims?: string[];
    conflicts?: { claimA: string; claimB: string; note: string }[];
    status?: Story["status"];
  }>(raw);

  const now = new Date().toISOString();
  const newClaims: Claim[] = (parsed.newClaims ?? []).map((text) => ({
    text,
    sources: newArticles.map((a) => a.url),
    status: "confirmed",
    isDelta: true,
    addedAt: now,
  }));

  const conflicts: Conflict[] = (parsed.conflicts ?? []).map((c) => ({
    claimA: {
      text: c.claimA,
      sources: newArticles.map((a) => a.url),
      status: "conflicting",
      isDelta: true,
      addedAt: now,
    },
    claimB: {
      text: c.claimB,
      sources: story.citations.map((c2) => c2.url),
      status: "conflicting",
      isDelta: false,
      addedAt: story.lastUpdatedAt,
    },
    note: c.note,
  }));

  // Claim dedup: drop new claims already present in core.
  const coreTexts = new Set(story.core.map((c) => c.text.toLowerCase()));
  const deduped = newClaims.filter((c) => !coreTexts.has(c.text.toLowerCase()));

  const newCitations: ArticleRef[] = newArticles.map((a) => ({
    url: a.url,
    title: a.title,
    source: a.source,
    publishedAt: a.publishedAt,
    firstSeenAt: now,
  }));

  return {
    ...story,
    core: [...story.core, ...deduped],
    updates: [...deduped, ...conflicts.map((c) => c.claimA)],
    conflicts: [...story.conflicts, ...conflicts],
    status: parsed.status ?? story.status,
    citations: [...story.citations, ...newCitations],
    lastUpdatedAt: now,
  };
}

/** Full re-fusion pass over all citations (flush drift, P3). */
export async function regenStory(
  args: GlobalArgs,
  story: Story,
): Promise<Story> {
  const existing = story.core.map((c) => c.text).join("\n- ");
  const prompt =
    `You are a meticulous news fusion engine. Given these established
claims and their cited articles, reconcile to:
1. "coreClaims": array of the strongest consolidated claim strings.
2. "conflicts": array of {claimA, claimB, note} for any unresolved contradictions.
3. "status": confirmed|reported|alleged|unresolved.

Established claims:
- ${existing}

Cited articles:
${
      story.citations.map((c, i) =>
        `[${i + 1}] ${c.title} (${c.source || canonicalUrl(c.url)}, ${
          c.publishedAt || "no date"
        })`
      ).join("\n")
    }

Return ONLY JSON, no prose.`;

  const raw = await chatCompletion(args, [
    { role: "system", content: "You output strictly valid JSON. No markdown." },
    { role: "user", content: prompt },
  ], { json: true });

  const parsed = extractJsonObject<{
    coreClaims?: string[];
    conflicts?: { claimA: string; claimB: string; note: string }[];
    status?: Story["status"];
  }>(raw);

  const now = new Date().toISOString();
  const allUrls = story.citations.map((c) => c.url);
  const core: Claim[] = (parsed.coreClaims ?? story.core.map((c) => c.text))
    .map(
      (text) => ({
        text,
        sources: allUrls,
        status: "confirmed",
        isDelta: false,
        addedAt: story.lastUpdatedAt,
      }),
    );

  const parsedConflicts = parsed.conflicts ?? [];
  const conflicts: Conflict[] = [
    ...parsedConflicts.map((c) => ({
      claimA: {
        text: c.claimA,
        sources: allUrls,
        status: "conflicting" as const,
        isDelta: false,
        addedAt: now,
      },
      claimB: {
        text: c.claimB,
        sources: allUrls,
        status: "conflicting" as const,
        isDelta: false,
        addedAt: now,
      },
      note: c.note,
    })),
    ...(story.conflicts ?? []),
  ];

  return {
    ...story,
    core,
    conflicts,
    status: parsed.status ?? story.status,
    lastUpdatedAt: now,
    lastRegenAt: now,
  };
}

/** Age out citations older than the retention window; core facts survive. */
export function ageOutCitations(
  story: Story,
  retentionDays: number,
): Story {
  if (retentionDays <= 0) return story;
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  const citations = story.citations.filter(
    (c) => new Date(c.firstSeenAt).getTime() >= cutoff,
  );
  return { ...story, citations };
}

/**
 * Compute a cluster fingerprint for change detection.
 * Includes article IDs and LLM config so model/temperature changes trigger re-fusion.
 */
export async function computeClusterFingerprint(
  cluster: StoryCluster,
  llmModel: string,
  llmTemperature: number,
): Promise<string> {
  const articleIds = cluster.articles.map((a) => a.id).sort();
  const configFingerprint = `${llmModel}:${llmTemperature}`;
  return await hashId(articleIds.join(",") + "|" + configFingerprint);
}

/**
 * Check whether a cluster should be skipped (unchanged since last run).
 */
export function shouldSkipCluster(
  cluster: StoryCluster,
  prevByKey: Map<string, StoryCluster>,
): boolean {
  const prev = prevByKey.get(cluster.key);
  return !!(prev && prev.fingerprint && cluster.fingerprint &&
    prev.fingerprint === cluster.fingerprint);
}

/**
 * Pre-compute which clusters need seeding (no LLM calls yet).
 * Deduplicates by key to avoid race conditions with parallel seeds.
 */
export function selectClustersToSeed(
  clusters: StoryCluster[],
  existingStories: Story[],
  minClusterSize: number,
): StoryCluster[] {
  const existingKeys = new Set(existingStories.map((s) => s.id));
  const toSeed = clusters.filter((c) =>
    c.articles.length >= minClusterSize &&
    !existingKeys.has(c.key) &&
    !existingKeys.has(clusterKey(c.topic, c.entities))
  );
  const seenKeys = new Set<string>();
  return toSeed.filter((c) => {
    if (seenKeys.has(c.key)) return false;
    seenKeys.add(c.key);
    return true;
  });
}

/**
 * Incremental dedupe: split articles into new (not previously seen) and
 * existing (reuse previous dedupe result). Returns the merged deduped list.
 */
export function dedupeArticlesIncremental(
  articles: Article[],
  prevUrls: string[],
  prevArticles: Article[],
): {
  deduped: Article[];
  newCount: number;
  reusedCount: number;
  duplicateCount: number;
} {
  const prevUrlSet = new Set(prevUrls);
  const newArticles = articles.filter((a) => !prevUrlSet.has(a.url));
  const existingDeduped = prevArticles.filter((a) =>
    articles.some((cur) => cur.url === a.url)
  );

  if (newArticles.length === 0) {
    return {
      deduped: existingDeduped,
      newCount: 0,
      reusedCount: existingDeduped.length,
      duplicateCount: 0,
    };
  }

  const urlGroups = new Map<string, Article[]>();
  for (const a of newArticles) {
    const existing = urlGroups.get(a.url) ?? [];
    existing.push(a);
    urlGroups.set(a.url, existing);
  }

  let duplicateCount = 0;
  const newDeduped: Article[] = [];

  for (const [_url, group] of urlGroups) {
    if (group.length === 1) {
      newDeduped.push(group[0]);
      continue;
    }

    group.sort((a, b) => a.source.localeCompare(b.source));
    const primary = group[0];
    const dupSources = group.slice(1).map((a) => a.source);

    newDeduped.push({
      ...primary,
      duplicateSources: dupSources,
      duplicateCount: dupSources.length,
    });

    for (const dup of group.slice(1)) {
      newDeduped.push({
        ...dup,
        duplicate: true,
        duplicateOf: primary.id,
      });
      duplicateCount++;
    }
  }

  return {
    deduped: [...existingDeduped, ...newDeduped],
    newCount: newArticles.length,
    reusedCount: existingDeduped.length,
    duplicateCount,
  };
}

/** Compact CSS shared by the inline stories fragment and the standalone stories page. */
const CITATION_CARD_STYLE = `
.citations { margin-top: 10px; }
.citation-box { margin-bottom: 6px; padding: 8px 10px; }
.citation-box::before { width: 56px; height: 56px; background-size: 56px; top: 2px; left: 2px; }
.citation-box h3 { margin: 0 0 2px 0; font-size: 0.95em; }
.citation-box h3 a { color: #1a5276; text-decoration: none; }
.citation-box h3 a:hover { text-decoration: underline; }
.citation-box .article-actions { font-size: 0.85em; }
.citation-box .article-actions a { margin-left: 6px; }
.citation-box .article-indicators { font-size: 0.75em; margin-left: 6px; }
.citation-box .source { font-size: 0.8em; }
`;

/** Render one compact article card (a fused article) with read/seen counts and 👍/👎 feedback. */
function renderCitationCard(
  id: string,
  c: ArticleRef,
  prefs: Preferences,
): string {
  const seenSet = new Set(prefs.seen ?? []);
  const readSet = new Set(prefs.read ?? []);
  const isSeen = seenSet.has(id);
  const isRead = readSet.has(id);
  const stateClass = isRead ? " read" : isSeen ? " seen" : "";
  const domain = (() => {
    try {
      return new URL(c.url).hostname;
    } catch {
      return c.source;
    }
  })();
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${
    encodeURIComponent(domain)
  }&sz=64`;
  const articleJson = JSON.stringify({
    articleId: id,
    source: c.source,
    title: (c.title || c.url).slice(0, 200),
    keywords: [],
  });
  const indicators = (isSeen || isRead)
    ? `<span class="article-indicators">${
      isRead
        ? `<span class="read-badge" title="read">📖 ${prefs.read.length} 👁 ${prefs.seen.length}</span>`
        : ""
    }${
      isSeen && !isRead
        ? `<span class="seen-badge" title="seen">👁 ${prefs.seen.length}</span>`
        : ""
    }</span>`
    : "";
  return `<div class="article citation-box${stateClass}" tabindex="0" data-article-id="${
    escapeHtml(id)
  }" style="--watermark: url('${faviconUrl}')">
<h3><a href="${escapeHtml(c.url)}" target="_blank" data-article-id="${
    escapeHtml(id)
  }">${escapeHtml(c.title || c.url)}</a>${indicators}
<span class="article-actions">
<a onclick="sendFeedback('interested',${
    escapeHtml(articleJson)
  },event)" title="👍 interested">👍</a>
<a onclick="sendFeedback('ignored',${
    escapeHtml(articleJson)
  },event)" title="👎 ignore">👎</a>
</span></h3>
<span class="source">${
    escapeHtml(c.source)
  } · <span class="pubdate" data-date="${
    escapeHtml(c.publishedAt)
  }"></span></span>
</div>`;
}

/** Render stories as inline HTML for the news page, with one compact card per fused article. */
export async function renderStories(
  stories: Story[],
  prefs: Preferences,
  title = "Fused stories",
): Promise<string> {
  if (stories.length === 0) return "";
  const parts: string[] = [
    `<style>${CITATION_CARD_STYLE}</style>`,
    `<section class="stories"><h2>${escapeHtml(title)}</h2>`,
  ];
  for (const st of stories) {
    parts.push(`<div class="story">`);
    parts.push(
      `<h3>${escapeHtml(st.identity.topic)} <span class="story-status">${
        escapeHtml(st.status)
      }</span></h3>`,
    );
    if (st.conflicts.length > 0) {
      parts.push(`<div class="conflicts"><b>Conflicts:</b>`);
      for (const c of st.conflicts) {
        parts.push(
          `<p class="conflict"><span class="claimA">${
            escapeHtml(c.claimA.text)
          }</span> ⚠ <span class="claimB">${
            escapeHtml(c.claimB.text)
          }</span> <em>${escapeHtml(c.note)}</em></p>`,
        );
      }
      parts.push(`</div>`);
    }
    parts.push(`<ul class="claims">`);
    for (const c of st.core) {
      parts.push(
        `<li>${
          escapeHtml(c.text)
        } <span class="src-count">(${c.sources.length} src)</span></li>`,
      );
    }
    parts.push(`</ul>`);
    parts.push(`<div class="citations">`);
    for (const c of st.citations) {
      const id = await hashId(c.url);
      parts.push(await renderCitationCard(id, c, prefs));
    }
    parts.push(`</div>`);
    parts.push(`</div>`);
  }
  parts.push(`</section>`);
  return parts.join("\n");
}

/** Render persistent stories as a standalone full HTML page (same shell as the news page). */
export async function renderStoriesPage(
  stories: Story[],
  prefs: Preferences,
  title = "Fused stories",
  generatedAt: string,
): Promise<string> {
  const sorted = [...stories].sort((a, b) => {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
  });

  const metaText = `${sorted.length} fused stories · ${
    sorted.reduce((n, s) => n + s.citations.length, 0)
  } citations · ${prefs.interested.length} interested, ${prefs.ignored.length} ignored`;

  const extraStyles = `
.stories { margin-top: 20px; }
.story { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: white; }
.story-status { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 0.75em; background: #e8e0f0; color: #6c4a9e; }
.conflicts { background: #fff3cd; border: 1px solid #ffe8a0; border-radius: 6px; padding: 10px 12px; margin: 10px 0; font-size: 0.9em; }
.claims { margin: 10px 0; padding-left: 20px; }
.claims li { margin-bottom: 4px; }
.src-count { color: #666; font-size: 0.8em; }
` + CITATION_CARD_STYLE;

  const parts: string[] = [
    pageShell(title, metaText, generatedAt, extraStyles),
    `<div class="add-url">
<input id="add-url-input" type="url" placeholder="https://example.com/feed-or-page" autocomplete="off">
<button id="add-url-btn" onclick="submitUrl()">Add</button>
<span id="add-status" class="add-status"></span>
</div>`,
    `<div class="toggle-bar">
<button class="toggle-btn" id="toggle-read" onclick="toggleRead()">📖 Read (${prefs.read.length})</button>
<button class="toggle-btn" id="toggle-seen" onclick="toggleSeen()">👁 Seen (${prefs.seen.length})</button>
</div>`,
    `<section class="stories"><h2>${escapeHtml(title)}</h2>`,
  ];

  for (const st of sorted) {
    parts.push(`<div class="story">`);
    parts.push(
      `<h3>${escapeHtml(st.identity.topic)} <span class="story-status">${
        escapeHtml(st.status)
      }</span></h3>`,
    );
    if (st.conflicts.length > 0) {
      parts.push(`<div class="conflicts"><b>Conflicts:</b>`);
      for (const c of st.conflicts) {
        parts.push(
          `<p class="conflict"><span class="claimA">${
            escapeHtml(c.claimA.text)
          }</span> ⚠ <span class="claimB">${
            escapeHtml(c.claimB.text)
          }</span> <em>${escapeHtml(c.note)}</em></p>`,
        );
      }
      parts.push(`</div>`);
    }
    parts.push(`<ul class="claims">`);
    for (const c of st.core) {
      parts.push(
        `<li>${
          escapeHtml(c.text)
        } <span class="src-count">(${c.sources.length} src)</span></li>`,
      );
    }
    parts.push(`</ul>`);
    parts.push(`<div class="citations">`);
    for (const c of st.citations) {
      const id = await hashId(c.url);
      parts.push(await renderCitationCard(id, c, prefs));
    }
    parts.push(`</div>`);
    parts.push(`</div>`);
  }
  parts.push(`</section>`);
  parts.push(pageScript());
  return parts.join("\n");
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
    while ((m = textRe.exec(xml)) !== null) {
      results.push(stripCdata(m[1].trim()));
    }
  }
  return results;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
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
      (isAtom ? extractTag(item, "updated") : null) ??
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

/** Detect whether a fetched body looks like an RSS/Atom/JSON feed. */
export function isFeedBody(contentType: string, body: string): boolean {
  const ct = contentType.toLowerCase();
  // 1. Content-type header: definite feed types win immediately.
  if (
    ct.includes("rss+xml") ||
    ct.includes("atom+xml") ||
    ct.includes("feed+json") ||
    ct.includes("text/xml") ||
    ct.includes("application/xml")
  ) {
    return true;
  }
  // 2. Content-type header: definite HTML pages are not feeds.
  if (ct.includes("html") || ct.includes("xhtml")) return false;

  // 3. Body content detection — many servers send no/odd content-type, so
  //    inspect the body markers directly.
  const trimmed = body.trimStart().slice(0, 300).toLowerCase();
  // Feed bodies: XML/RSS/Atom/JSON-feed markers.
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("{")) {
    return trimmed.includes("<rss") ||
      trimmed.includes("<feed") ||
      trimmed.includes("<rdf:rdf") ||
      (trimmed.includes('"version"') && trimmed.includes('"items"'));
  }
  // HTML bodies: well-known structural tags mark a page, not a feed.
  if (
    trimmed.startsWith("<!doctype") ||
    trimmed.includes("<html") ||
    trimmed.includes("<head") ||
    trimmed.includes("<body") ||
    trimmed.includes("<title")
  ) {
    return false;
  }
  // Unknown → treat as not-a-feed so it gets flagged for re-discovery.
  return false;
}

/** Fetch a single feed URL and parse articles. */
export async function fetchFeed(
  url: string,
  maxArticles: number,
  cacheHeaders?: { etag?: string; lastModified?: string },
): Promise<{
  articles: Article[];
  error?: string;
  isFeed: boolean;
  contentType: string;
  notModified?: boolean;
  newEtag?: string;
  newLastModified?: string;
}> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": "swamp-news-reader/1.0",
      "Accept":
        "application/rss+xml,application/atom+xml,application/feed+json,application/xml,text/xml,*/*",
    };
    if (cacheHeaders?.etag) headers["If-None-Match"] = cacheHeaders.etag;
    if (cacheHeaders?.lastModified) {
      headers["If-Modified-Since"] = cacheHeaders.lastModified;
    }

    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 304) {
      return {
        articles: [],
        isFeed: true,
        contentType: "",
        notModified: true,
      };
    }

    if (!resp.ok) {
      return {
        articles: [],
        error: `HTTP ${resp.status}`,
        isFeed: false,
        contentType: "",
      };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const newEtag = resp.headers.get("etag") ?? undefined;
    const newLastModified = resp.headers.get("last-modified") ?? undefined;
    const body = await resp.text();
    const isFeed = isFeedBody(contentType, body);
    const articles = isFeed ? parseFeed(body, url).slice(0, maxArticles) : [];
    for (const a of articles) {
      a.id = await hashId(a.url);
    }
    return { articles, isFeed, contentType, newEtag, newLastModified };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { articles: [], error: msg, isFeed: false, contentType: "" };
  }
}

/** Shape returned by fetchFeed for a single feed (Phase 1.6 ETag caching). */
export type FeedFetchResult = {
  articles: Article[];
  error?: string;
  isFeed: boolean;
  contentType: string;
  notModified?: boolean;
  newEtag?: string;
  newLastModified?: string;
};

export type FeedCacheEntry = { etag?: string; lastModified?: string };

/**
 * Merge a single feed's fetch result into the snapshot accumulators (Phase 1.6).
 * Pure helper so the 304-reuse + cache-persistence logic is unit-testable.
 *
 * - 304 (notModified): reuse previous cache headers and previous article IDs,
 *   carrying the prior articles forward.
 * - error / non-feed: no articles, no cache entry.
 * - 200 feed: persist new ETag/Last-Modified, record new article IDs.
 */
export function mergeFeedFetchResult(
  feedUrl: string,
  result: FeedFetchResult,
  prev: {
    prevFeedCache: Record<string, FeedCacheEntry>;
    prevFeedArticleIds: Record<string, string[]>;
    prevArticlesById: Map<string, Article>;
  },
): {
  articles: Article[];
  error?: { url: string; message: string };
  nonFeedUrl?: { url: string; contentType: string };
  feedCache?: FeedCacheEntry;
  feedArticleIds?: string[];
  notModified?: boolean;
} {
  if (result.notModified) {
    const prevIds = prev.prevFeedArticleIds[feedUrl] ?? [];
    const articles: Article[] = [];
    for (const id of prevIds) {
      const prevArticle = prev.prevArticlesById.get(id);
      if (prevArticle) articles.push(prevArticle);
    }
    const prevEntry = prev.prevFeedCache[feedUrl];
    return {
      articles,
      feedCache: prevEntry && (prevEntry.etag || prevEntry.lastModified)
        ? prevEntry
        : undefined,
      feedArticleIds: prevIds,
      notModified: true,
    };
  }

  if (result.error) {
    return { articles: [], error: { url: feedUrl, message: result.error } };
  }

  if (!result.isFeed) {
    return {
      articles: [],
      nonFeedUrl: { url: feedUrl, contentType: result.contentType },
    };
  }

  const feedCache: FeedCacheEntry = {};
  if (result.newEtag) feedCache.etag = result.newEtag;
  if (result.newLastModified) feedCache.lastModified = result.newLastModified;
  return {
    articles: result.articles,
    feedCache: feedCache.etag || feedCache.lastModified ? feedCache : undefined,
    feedArticleIds: result.articles.map((a) => a.id),
  };
}

/** Normalize loaded preferences to ensure all fields exist (backward compat). */
function normalizePrefs(raw: Record<string, unknown> | null): Preferences {
  if (!raw) {
    return {
      interested: [],
      ignored: [],
      seen: [],
      read: [],
      keywordWeights: {},
    };
  }
  return {
    interested: (raw.interested as FeedbackEntry[]) ?? [],
    ignored: (raw.ignored as FeedbackEntry[]) ?? [],
    seen: (raw.seen as string[]) ?? [],
    read: (raw.read as string[]) ?? [],
    keywordWeights: (raw.keywordWeights as Record<string, number>) ?? {},
  };
}

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

/**
 * Compute per-feed engagement scores keyed by source (lowercased hostname).
 * Mirrors the feed catalog's ranking: interested * 3 + read * 2 - ignored * 3.
 */
export function computeFeedScores(
  prefs: Preferences,
  articles: Article[],
): Record<string, number> {
  const interested = prefs.interested ?? [];
  const ignored = prefs.ignored ?? [];
  const readSet = new Set(prefs.read ?? []);

  const counts = new Map<
    string,
    { interested: number; read: number; ignored: number }
  >();
  const get = (src: string) => {
    const k = (src ?? "").toLowerCase();
    let c = counts.get(k);
    if (!c) {
      c = { interested: 0, read: 0, ignored: 0 };
      counts.set(k, c);
    }
    return c;
  };
  for (const e of interested) get(e.source).interested++;
  for (const e of ignored) get(e.source).ignored++;
  for (const a of articles) {
    if (readSet.has(a.id)) get(a.source).read++;
  }

  const scores: Record<string, number> = {};
  for (const [src, c] of counts) {
    scores[src] = c.interested * 3 + c.read * 2 - c.ignored * 3;
  }
  return scores;
}

/** Render a score pill (★/↑/↓/·) for a numeric score. */
function scorePill(score: number): string {
  const cls = score > 2
    ? "score-high"
    : score > 0
    ? "score-mid"
    : score < 0
    ? "score-low"
    : "score-zero";
  const label = score > 2 ? "★" : score > 0 ? "↑" : score < 0 ? "↓" : "·";
  return `<span class="score ${cls}">${label} ${score}</span>`;
}

/**
 * Scores a set of articles against learned preferences and sorts them by
 * interest (feed score + keyword score, newest first as a tiebreak).
 * Returns the scored array already ranked for HTML generation.
 */
export function scoreAndSortArticles(
  articles: Article[],
  prefs: Preferences,
): ScoredArticle[] {
  const feedScores = computeFeedScores(prefs, articles);
  const scored: ScoredArticle[] = articles.map((a) => {
    const { score, reasons } = scoreArticle(a, prefs.keywordWeights);
    return {
      ...a,
      score,
      reasons,
      feedScore: feedScores[(a.source ?? "").toLowerCase()] ?? 0,
    };
  });

  scored.sort((a, b) =>
    (b.feedScore ?? 0) + b.score - ((a.feedScore ?? 0) + a.score) ||
    b.publishedAt.localeCompare(a.publishedAt)
  );

  return scored;
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

const PAGE_STYLE = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #fafafa; color: #222; }
.header a { color: #1a5276; text-decoration: none; font-size: 0.9em; }
.header a:hover { text-decoration: underline; }
h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
.meta { color: #666; font-size: 0.9em; margin-bottom: 20px; }
.article { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 12px; background: white; transition: border-color 0.2s; position: relative; }
.article::before { content: ''; position: absolute; top: 4px; left: 4px; width: 128px; height: 128px; background-image: var(--watermark); background-size: 128px; background-repeat: no-repeat; opacity: 0.1; pointer-events: none; }
.article:hover { border-color: #4a90d9; }
.article.seen { border-left: 3px solid #ffc107; }
.article.read { border-left: 3px solid #28a745; opacity: 0.85; }
.article.hidden { display: none; }
.toggle-bar { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.toggle-btn { padding: 4px 12px; border: 1px solid #ccc; border-radius: 4px; background: white; cursor: pointer; font-size: 0.85em; }
.toggle-btn:hover { border-color: #4a90d9; }
.toggle-btn.active { background: #4a90d9; color: white; border-color: #4a90d9; }
.article h3 { margin: 0 0 8px 0; }
.article h3 a { color: #1a5276; text-decoration: none; }
.article h3 a:hover { text-decoration: underline; }
.article-actions { float: right; }
.article-actions a { color: #888; text-decoration: none; cursor: pointer; margin-left: 8px; font-size: 0.85em; }
.article-actions a:hover { color: #4a90d9; }
.article-indicators { display: inline-block; margin-left: 8px; font-size: 0.8em; }
.article-indicators .seen-badge { color: #ffc107; }
.article-indicators .read-badge { color: #28a745; }
.dup-badge { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 10px; font-size: 0.75em; background: #e8e0f0; color: #6c4a9e; cursor: help; }
.source { color: #888; font-size: 0.85em; }
.score { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: bold; }
.score-high { background: #d4edda; color: #155724; }
.score-mid { background: #fff3cd; color: #856404; }
.score-low { background: #f8d7da; color: #721c24; }
.score-zero { background: #e2e3e5; color: #6c757d; }
.summary { color: #555; margin-top: 8px; font-size: 0.95em; line-height: 1.5; }
.keyword { display: inline-block; background: #e8f0fe; color: #1a73e8; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; margin-right: 4px; }

.stats { background: #e8f0fe; padding: 12px; border-radius: 8px; margin-bottom: 20px; }
.add-url { display: flex; gap: 8px; align-items: center; margin-bottom: 20px; }
.add-url input { flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em; }
.add-url button { padding: 6px 14px; border: 1px solid #4a90d9; border-radius: 4px; background: #4a90d9; color: white; cursor: pointer; font-size: 0.95em; }
.add-url button:hover { background: #3577b8; }
.add-status { font-size: 0.85em; color: #666; min-width: 120px; margin-left: 8px; }
.add-status.ok { color: #28a745; }
.add-status.err { color: #d9534f; }
`;

function pageShell(
  title: string,
  metaText: string,
  generatedAt: string,
  extraStyles = "",
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
` + `<style>${PAGE_STYLE}${extraStyles}</style>` + `
</head>
<body>
<nav class="header"><a href="/feeds.html">Feeds catalog →</a></nav>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${metaText} · generated <span class="generated-at" data-generated="${
    escapeHtml(generatedAt)
  }"></span></div>
<div class="add-url">
<input id="add-url-input" type="url" placeholder="https://example.com/feed-or-page" autocomplete="off">
<button id="add-url-btn" onclick="submitUrl()">Add</button>
<span id="add-status" class="add-status"></span>
</div>`;
}

function pageScript(): string {
  return `
<script>
const FEEDBACK_URL = '/api/feedback';

async function sendFeedback(action, article, event) {
  const el = event.target;
  el.textContent = '…';
  try {
    const res = await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...article, action })
    });
    if (res.ok) {
      el.textContent = '✓';
      setTimeout(() => el.textContent = action === 'interested' ? '👍' : '👎', 2000);
    } else {
      el.textContent = '✗';
      setTimeout(() => el.textContent = action === 'interested' ? '👍' : '👎', 2000);
    }
  } catch {
    el.textContent = '✗';
    setTimeout(() => el.textContent = action === 'interested' ? '👍' : '👎', 2000);
  }
}

async function sendSeen(articleId) {
  try {
    await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, action: 'seen' })
    });
  } catch {}
}

async function sendRead(articleId) {
  try {
    await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, action: 'read' })
    });
  } catch {}
}

const seenSent = new Set();
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.getAttribute('data-article-id');
      if (id && !seenSent.has(id)) {
        seenSent.add(id);
        sendSeen(id);
      }
    }
  });
}, { threshold: 0.3 });

document.querySelectorAll('.article').forEach(el => observer.observe(el));

document.querySelectorAll('.article h3 a[data-article-id]').forEach(link => {
  link.addEventListener('mousedown', () => {
    const id = link.getAttribute('data-article-id');
    if (id) sendRead(id);
  });
});

function toggleRead() {
  const btn = document.getElementById('toggle-read');
  const show = btn.classList.toggle('active');
  document.querySelectorAll('.article.read').forEach(el => {
    el.classList.toggle('hidden', !show);
  });
}

function toggleSeen() {
  const btn = document.getElementById('toggle-seen');
  const show = btn.classList.toggle('active');
  document.querySelectorAll('.article.seen:not(.read)').forEach(el => {
    el.classList.toggle('hidden', !show);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const articles = document.querySelectorAll('.article');
  let current = document.activeElement;
  let idx = current ? Array.from(articles).indexOf(current) : -1;
  if (e.key === 'j') { idx = Math.min(idx + 1, articles.length - 1); articles[idx]?.focus(); }
  if (e.key === 'k') { idx = Math.max(idx - 1, 0); articles[idx]?.focus(); }
});

document.querySelectorAll('.pubdate').forEach(el => {
  const dateStr = el.getAttribute('data-date');
  if (dateStr) {
    try {
      const date = new Date(dateStr);
      const formatted = date.toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      el.textContent = formatted;
    } catch (err) {
      el.textContent = dateStr;
    }
  }
});

document.querySelectorAll('.generated-at').forEach(el => {
  const dateStr = el.getAttribute('data-generated');
  if (dateStr) {
    try {
      const date = new Date(dateStr);
      const formatted = date.toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      el.textContent = formatted;
    } catch (err) {
      el.textContent = dateStr;
    }
  }
});

const PAGES_URL = '/api/pages';
const addInput = document.getElementById('add-url-input');
const addStatus = document.getElementById('add-status');

async function submitUrl() {
  const url = addInput.value.trim();
  if (!url) return;
  const btn = document.getElementById('add-url-btn');
  btn.textContent = '…';
  addStatus.textContent = '';
  addStatus.className = 'add-status';
  try {
    const res = await fetch(PAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      addStatus.textContent = '✓ submitted';
      addStatus.className = 'add-status ok';
      addInput.value = '';
    } else {
      addStatus.textContent = '✗ failed';
      addStatus.className = 'add-status err';
    }
  } catch {
    addStatus.textContent = '✗ failed';
    addStatus.className = 'add-status err';
  }
  btn.textContent = 'Add';
}

addInput.addEventListener('input', () => {
  addStatus.textContent = '';
  addStatus.className = 'add-status';
});
</script>
</body>
</html>`;
}

/** Generate a static HTML page from scored articles. */
export function generateHtml(
  articles: ScoredArticle[],
  prefs: Preferences,
  title: string,
  generatedAt: string,
  ageFilter?: string,
  storiesHtml?: string,
): string {
  const top = articles;
  const sections: string[] = [];
  const seenSet = new Set(prefs.seen ?? []);
  const readSet = new Set(prefs.read ?? []);
  const feedScores = computeFeedScores(prefs, articles);

  let metaText = `${articles.length} articles from ${
    new Set(articles.map((a) => a.source)).size
  } sources · ${prefs.interested.length} interested, ${prefs.ignored.length} ignored`;

  if (ageFilter && ageFilter !== "") {
    metaText += ` · Filtering last ${escapeHtml(ageFilter)}`;
  }

  sections.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #fafafa; color: #222; }
.header a { color: #1a5276; text-decoration: none; font-size: 0.9em; }
.header a:hover { text-decoration: underline; }
h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
.meta { color: #666; font-size: 0.9em; margin-bottom: 20px; }
.article { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 12px; background: white; transition: border-color 0.2s; position: relative; }
.article::before { content: ''; position: absolute; top: 4px; left: 4px; width: 128px; height: 128px; background-image: var(--watermark); background-size: 128px; background-repeat: no-repeat; opacity: 0.1; pointer-events: none; }
.article:hover { border-color: #4a90d9; }
.article.seen { border-left: 3px solid #ffc107; }
.article.read { border-left: 3px solid #28a745; opacity: 0.85; }
.article.hidden { display: none; }
.toggle-bar { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.toggle-btn { padding: 4px 12px; border: 1px solid #ccc; border-radius: 4px; background: white; cursor: pointer; font-size: 0.85em; }
.toggle-btn:hover { border-color: #4a90d9; }
.toggle-btn.active { background: #4a90d9; color: white; border-color: #4a90d9; }
.article h3 { margin: 0 0 8px 0; }
.article h3 a { color: #1a5276; text-decoration: none; }
.article h3 a:hover { text-decoration: underline; }
.article-actions { float: right; }
.article-actions a { color: #888; text-decoration: none; cursor: pointer; margin-left: 8px; font-size: 0.85em; }
.article-actions a:hover { color: #4a90d9; }
.article-indicators { display: inline-block; margin-left: 8px; font-size: 0.8em; }
.article-indicators .seen-badge { color: #ffc107; }
.article-indicators .read-badge { color: #28a745; }
.dup-badge { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 10px; font-size: 0.75em; background: #e8e0f0; color: #6c4a9e; cursor: help; }
.source { color: #888; font-size: 0.85em; }
.score { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: bold; }
.score-high { background: #d4edda; color: #155724; }
.score-mid { background: #fff3cd; color: #856404; }
.score-low { background: #f8d7da; color: #721c24; }
.score-zero { background: #e2e3e5; color: #6c757d; }
.summary { color: #555; margin-top: 8px; font-size: 0.95em; line-height: 1.5; }
.keyword { display: inline-block; background: #e8f0fe; color: #1a73e8; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; margin-right: 4px; }

.stats { background: #e8f0fe; padding: 12px; border-radius: 8px; margin-bottom: 20px; }
.add-url { display: flex; gap: 8px; align-items: center; margin-bottom: 20px; }
.add-url input { flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em; }
.add-url button { padding: 6px 14px; border: 1px solid #4a90d9; border-radius: 4px; background: #4a90d9; color: white; cursor: pointer; font-size: 0.95em; }
.add-url button:hover { background: #3577b8; }
.add-status { font-size: 0.85em; color: #666; min-width: 120px; margin-left: 8px; }
.add-status.ok { color: #28a745; }
.add-status.err { color: #d9534f; }
</style>
</head>
<body>
<nav class="header"><a href="/feeds.html">Feeds catalog →</a></nav>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${metaText} · generated <span class="generated-at" data-generated="${
    escapeHtml(generatedAt)
  }"></span></div>
<div class="add-url">
<input id="add-url-input" type="url" placeholder="https://example.com/feed-or-page" autocomplete="off">
<button id="add-url-btn" onclick="submitUrl()">Add</button>
<span id="add-status" class="add-status"></span>
</div>`);

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

  const readArticleCount = top.filter((a) => readSet.has(a.id)).length;
  const seenNotReadCount =
    top.filter((a) => seenSet.has(a.id) && !readSet.has(a.id)).length;

  sections.push(`<div class="toggle-bar">
<button class="toggle-btn" id="toggle-read" onclick="toggleRead()">📖 Read (${readArticleCount})</button>
<button class="toggle-btn" id="toggle-seen" onclick="toggleSeen()">👁 Seen (${seenNotReadCount})</button>
</div>`);

  sections.push("<div id='articles'>");

  for (const a of top) {
    const isSeen = seenSet.has(a.id);
    const isRead = readSet.has(a.id);
    const feedScore = a.feedScore ??
      feedScores[(a.source ?? "").toLowerCase()] ?? 0;
    const keywordScore = a.score + (isRead ? 2 : 0);
    const scoreClass = keywordScore > 2
      ? "score-high"
      : keywordScore > 0
      ? "score-mid"
      : keywordScore < 0
      ? "score-low"
      : "score-zero";
    const scoreLabel = keywordScore > 2
      ? "★"
      : keywordScore > 0
      ? "↑"
      : keywordScore < 0
      ? "↓"
      : "·";
    const articleJson = JSON.stringify({
      articleId: a.id,
      source: a.source,
      title: a.title.slice(0, 200),
      keywords: a.keywords,
    });

    const stateClass = isRead ? " read hidden" : isSeen ? " seen hidden" : "";
    const seenCount = prefs.seen.length;
    const readCount = prefs.read.length;
    const indicators = (isSeen || isRead)
      ? `<span class="article-indicators">${
        isRead
          ? `<span class="read-badge" title="read">📖 ${readCount} 👁 ${seenCount}</span>`
          : ""
      }${
        isSeen && !isRead
          ? `<span class="seen-badge" title="seen">👁 ${seenCount}</span>`
          : ""
      }</span>`
      : "";

    const dupBadge = (a.duplicateSources && a.duplicateSources.length > 0)
      ? `<span class="dup-badge" title="Also from: ${
        a.duplicateSources.map((s) => escapeHtml(s)).join(", ")
      }">↗ ${a.duplicateCount} feed${a.duplicateCount === 1 ? "" : "s"}</span>`
      : "";

    const domain = a.source.includes(".") ? a.source : (() => {
      try {
        return new URL(a.url).hostname;
      } catch {
        return a.source;
      }
    })();
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${
      encodeURIComponent(domain)
    }&sz=64`;
    sections.push(
      `<div class="article${stateClass}" tabindex="0" data-article-id="${
        escapeHtml(a.id)
      }" style="--watermark: url('${faviconUrl}')">
<h3><a href="${escapeHtml(a.url)}" target="_blank" data-article-id="${
        escapeHtml(a.id)
      }">${escapeHtml(a.title)}</a>${indicators}${dupBadge}
<span class="article-actions">
<a onclick="sendFeedback('interested',${
        escapeHtml(articleJson)
      },event)" title="👍 interested">👍</a>
<a onclick="sendFeedback('ignored',${
        escapeHtml(articleJson)
      },event)" title="👎 ignore">👎</a>
</span></h3>
<span class="source">${escapeHtml(a.source)} ${
        scorePill(feedScore)
      } · <span class="pubdate" data-date="${
        escapeHtml(a.publishedAt)
      }"></span>${
        a.keywords.length > 0
          ? " · " + a.keywords.slice(0, 6).map((kw) =>
            `<span class="keyword">${escapeHtml(kw)}</span>`
          ).join("")
          : ""
      }</span>
<span class="score ${scoreClass}">${scoreLabel} ${keywordScore}</span>
<div class="summary">${escapeHtml(a.summary.slice(0, 200))}${
        a.summary.length > 200 ? "…" : ""
      }</div>`,
    );
    sections.push("</div>");
  }

  sections.push("</div>");
  if (storiesHtml && storiesHtml.trim() !== "") {
    sections.push(storiesHtml);
  }
  sections.push(`
<script>
const FEEDBACK_URL = '/api/feedback';

async function sendFeedback(action, article, event) {
  const el = event.target;
  el.textContent = '…';
  try {
    const res = await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...article, action })
    });
    if (res.ok) {
      el.textContent = '✓';
      setTimeout(() => el.textContent = action === 'interested' ? '👍' : '👎', 2000);
    } else {
      el.textContent = '✗';
      setTimeout(() => el.textContent = action === 'interested' ? '👍' : '👎', 2000);
    }
  } catch {
    el.textContent = '✗';
    setTimeout(() => el.textContent = action === 'interested' ? '👍' : '👎', 2000);
  }
}

async function sendSeen(articleId) {
  try {
    await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, action: 'seen' })
    });
  } catch {}
}

async function sendRead(articleId) {
  try {
    await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, action: 'read' })
    });
  } catch {}
}

const seenSent = new Set();
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.getAttribute('data-article-id');
      if (id && !seenSent.has(id)) {
        seenSent.add(id);
        sendSeen(id);
      }
    }
  });
}, { threshold: 0.3 });

document.querySelectorAll('.article').forEach(el => observer.observe(el));

document.querySelectorAll('.article h3 a[data-article-id]').forEach(link => {
  link.addEventListener('mousedown', () => {
    const id = link.getAttribute('data-article-id');
    if (id) sendRead(id);
  });
});

function toggleRead() {
  const btn = document.getElementById('toggle-read');
  const show = btn.classList.toggle('active');
  document.querySelectorAll('.article.read').forEach(el => {
    el.classList.toggle('hidden', !show);
  });
}

function toggleSeen() {
  const btn = document.getElementById('toggle-seen');
  const show = btn.classList.toggle('active');
  document.querySelectorAll('.article.seen:not(.read)').forEach(el => {
    el.classList.toggle('hidden', !show);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const articles = document.querySelectorAll('.article');
  let current = document.activeElement;
  let idx = current ? Array.from(articles).indexOf(current) : -1;
  if (e.key === 'j') { idx = Math.min(idx + 1, articles.length - 1); articles[idx]?.focus(); }
  if (e.key === 'k') { idx = Math.max(idx - 1, 0); articles[idx]?.focus(); }
});

document.querySelectorAll('.pubdate').forEach(el => {
  const dateStr = el.getAttribute('data-date');
  if (dateStr) {
    try {
      const date = new Date(dateStr);
      const formatted = date.toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      el.textContent = formatted;
    } catch (err) {
      el.textContent = dateStr;
    }
  }
});

document.querySelectorAll('.generated-at').forEach(el => {
  const dateStr = el.getAttribute('data-generated');
  if (dateStr) {
    try {
      const date = new Date(dateStr);
      const formatted = date.toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      el.textContent = formatted;
    } catch (err) {
      el.textContent = dateStr;
    }
  }
});

const PAGES_URL = '/api/pages';
const addInput = document.getElementById('add-url-input');
const addStatus = document.getElementById('add-status');

async function submitUrl() {
  const url = addInput.value.trim();
  if (!url) return;
  const btn = document.getElementById('add-url-btn');
  btn.textContent = '…';
  addStatus.textContent = '';
  addStatus.className = 'add-status';
  try {
    const res = await fetch(PAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      addStatus.textContent = '✓ submitted';
      addStatus.className = 'add-status ok';
      addInput.value = '';
    } else {
      addStatus.textContent = '✗ failed';
      addStatus.className = 'add-status err';
    }
  } catch {
    addStatus.textContent = '✗ failed';
    addStatus.className = 'add-status err';
  }
  btn.textContent = 'Add';
}

addInput.addEventListener('input', () => {
  addStatus.textContent = '';
  addStatus.className = 'add-status';
});
</script>
</body>
</html>`);
  return sections.join("\n");
}

/**
 * Generates a swipe-driven, phone/e-ink-optimised news summary page.
 *
 * The page paginates the ranked articles into pages of PER_PAGE (3..8),
 * navigates with a left/right swipe gesture on any article box, and opens an
 * article in an embedded iframe by sliding the article list to a thin icon
 * column and replacing the freed space with a reader iframe. Each article's
 * URL is carried on its element as a `data-url` attribute so the reader can
 * be opened purely client-side from the static HTML.
 */
export function generateMobileHtml(
  articles: ScoredArticle[],
  prefs: Preferences,
  title: string,
  generatedAt: string,
  ageFilter?: string,
): string {
  const seenSet = new Set(prefs.seen ?? []);
  const readSet = new Set(prefs.read ?? []);
  const top = articles;
  const domainCache = new Map<string, string>();
  const domainOf = (a: ScoredArticle): string => {
    let d = domainCache.get(a.id);
    if (!d) {
      d = a.source.includes(".")
        ? a.source
        : (() => {
          try {
            return new URL(a.url).hostname;
          } catch {
            return a.source;
          }
        })();
      domainCache.set(a.id, d);
    }
    return d;
  };

  const total = top.length;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  let metaText = `${total} articles from ${
    new Set(top.map((a) => a.source)).size
  } sources · ${prefs.interested.length} interested, ${prefs.ignored.length} ignored`;
  if (ageFilter && ageFilter !== "") {
    metaText += ` · Filtering last ${escapeHtml(ageFilter)}`;
  }

  const cards = top.map((a, i) =>
    mobileCard(a, i, domainOf(a), seenSet, readSet)
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
${MOBILE_PAGE_STYLE}
</head>
<body>
<header class="page-bar" id="page-bar"><span class="page-label" id="page-label">1 / ${pageCount}</span><span class="page-meta">${metaText} · generated <span class="generated-at" data-generated="${escapeHtml(generatedAt)}"></span></span><span class="toggle-box"><button class="toggle-btn" id="toggle-seen" onclick="toggleSeen()">👁<span id="seen-count"></span></button><button class="toggle-btn" id="toggle-read" onclick="toggleRead()">📖<span id="read-count"></span></button></span><button id="list-close" onclick="closeReader()">✕</button></header>
<div class="main">
<div id="list">
${cards}
</div>
<div id="reader"><div class="reader-head"><button id="reader-close" onclick="closeReader()">✕</button></div><iframe id="reader-frame" title="Article reader"></iframe></div>
</div>
<script>
const PAGE_SIZE = ${PER_PAGE};
const TOTAL = ${total};
let page = 0;
let totalPages = Math.max(1, Math.ceil(TOTAL / PAGE_SIZE));
const list = document.getElementById('list');
const allCards = Array.from(document.querySelectorAll('.article'));
const FEEDBACK_URL = '/api/feedback';

function visibleCards() {
  return allCards.filter(c => !c.classList.contains('hidden'));
}

// Show only the visible cards belonging to the current page; hide the rest.
function renderPage() {
  const vis = visibleCards();
  totalPages = Math.max(1, Math.ceil(vis.length / PAGE_SIZE));
  if (page >= totalPages) page = totalPages - 1;
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, vis.length);
  allCards.forEach(c => {
    const idx = vis.indexOf(c);
    c.style.display = (idx >= start && idx < end) ? '' : 'none';
  });
  list.style.transform = 'translateX(0)';
  updatePageBar();
}

async function sendSeen(articleId) {
  try {
    await fetch(FEEDBACK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ articleId, action:'seen' }) });
  } catch {}
}

async function sendRead(articleId) {
  try {
    await fetch(FEEDBACK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ articleId, action:'read' }) });
  } catch {}
}

function updatePageBar() {
  const vis = visibleCards();
  const first = vis.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min((page + 1) * PAGE_SIZE, vis.length);
  document.getElementById('page-label').textContent =
    (vis.length === 0 ? '0 / 0' : (first + '–' + last)) + ' / ' + vis.length;
}

function goToPage(p) {
  if (p < 0 || p >= totalPages) return;
  page = p;
  renderPage();
}

function goNext() { if (page < totalPages - 1) goToPage(page + 1); }
function goPrev() { if (page > 0) goToPage(page - 1); }

document.getElementById('seen-count').textContent =
  ' ' + allCards.filter(c => c.classList.contains('seen')).length;
document.getElementById('read-count').textContent =
  ' ' + allCards.filter(c => c.classList.contains('read')).length;

function toggleSeen() {
  const btn = document.getElementById('toggle-seen');
  const show = btn.classList.toggle('active');
  allCards.forEach(el => {
    if (el.classList.contains('seen')) el.classList.toggle('hidden', !show);
  });
  page = 0;
  renderPage();
}

function toggleRead() {
  const btn = document.getElementById('toggle-read');
  const show = btn.classList.toggle('active');
  allCards.forEach(el => {
    if (el.classList.contains('read')) el.classList.toggle('hidden', !show);
  });
  page = 0;
  renderPage();
}

const FRAME_TIMEOUT_MS = 6000;

// Client-side block detection is unreliable for cross-origin frames:
//   - X-Frame-Options   -> Firefox shows a same-origin error page we can read.
//   - CSP frame-ancestors -> the frame is blank and opaque (contentDocument is
//     null, indistinguishable from a healthy cross-origin embed).
// So the primary detector is a server-side header probe (/api/frame-check),
// which inspects the real response headers. We keep the onLoad content-scan as
// a secondary fallback for the X-Frame-Options case.
function frameIsBlocked(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return false; // opaque = healthy cross-origin embed (or CSP blank)
    const text = (doc.body && doc.body.innerText) || '';
    return /will not allow|refused to connect|denied|frame|embed|X-Frame|not display/i.test(text);
  } catch {
    return false;
  }
}

function openArticle(id) {
  document.body.classList.add('reading');
  const iframe = document.getElementById('reader-frame');
  const url = document.querySelector('.article[data-article-id="' + id + '"]').getAttribute('data-url');
  let redirected = false;
  console.log('[reader] openArticle', id, url);

  const failOpen = (reason) => {
    if (redirected) return;
    redirected = true;
    clearTimeout(failTimer);
    console.log('[reader] frame-blocked, redirecting because', reason);
    window.location = url;
  };

  // Probe response headers server-side. This is the reliable detector for both
  // X-Frame-Options and CSP frame-ancestors.
  fetch('/api/frame-check?url=' + encodeURIComponent(url))
    .then(r => {
      console.log('[reader] frame-check status', r.status);
      return r.json();
    })
    .then(data => {
      console.log('[reader] frame-check result', data);
      if (data && data.blocked) { failOpen(data.reason); return; }
    })
    .catch(err => {
      console.log('[reader] frame-check probe failed (falling back to frame scan)', err);
    });

  const onLoad = () => {
    if (frameIsBlocked(iframe)) {
      failOpen('frame-scan detected block page');
      return;
    }
    clearTimeout(failTimer);
  };

  const onError = (e) => { console.log('[reader] iframe error event', e); failOpen('iframe error'); };

  let failTimer = setTimeout(() => failOpen('timeout'), FRAME_TIMEOUT_MS);
  iframe.addEventListener('error', onError);
  iframe.addEventListener('load', onLoad);

  iframe.src = url;
  sendRead(id);
}

function closeReader() {
  if (!document.body.classList.contains('reading')) return;
  document.body.classList.remove('reading');
  const iframe = document.getElementById('reader-frame');
  iframe.removeAttribute('src');
}

function goBack() {
  if (document.body.classList.contains('reading')) closeReader();
  else history.back();
}

// When the article fallback navigates away (window.location = url), this page is
// saved in the browser's bfcache with body.reading still set. On back-navigation
// the page is restored collapsed, showing a thin icon column + stale iframe.
// Reset the reading state so the full-width article list is restored.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  document.body.classList.remove('reading');
  const iframe = document.getElementById('reader-frame');
  iframe.removeAttribute('src');
  renderPage();
});

list.addEventListener('click', (e) => {
  const card = e.target.closest('.article');
  if (!card) return;
  openArticle(card.getAttribute('data-article-id'));
});

let touchStart = null;
let touchX = null;
list.addEventListener('touchstart', (e) => {
  touchX = e.touches[0].clientX;
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
list.addEventListener('touchmove', (e) => {
  if (!touchStart) return;
  const dx = e.touches[0].clientX - touchStart.x;
  const dy = e.touches[0].clientY - touchStart.y;
  if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
}, { passive: false });
list.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 40) dx < 0 ? goNext() : goPrev();
  touchX = null;
  touchStart = null;
});

list.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const onMouseMove = (ev) => {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 60) {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      dx < 0 ? goNext() : goPrev();
    }
  };
  const onMouseUp = () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'IFRAME') return;
  if (e.key === 'ArrowLeft') goPrev();
  else if (e.key === 'ArrowRight') goNext();
  else if (e.key === 'Escape') closeReader();
});

document.querySelectorAll('.article').forEach(el => {
  const id = el.getAttribute('data-article-id');
  if (id) sendSeen(id);
});

document.querySelectorAll('.generated-at').forEach(el => {
  const dateStr = el.getAttribute('data-generated');
  if (dateStr) {
    try {
      const date = new Date(dateStr);
      el.textContent = date.toLocaleString('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (err) {
      el.textContent = dateStr;
    }
  }
});

updatePageBar();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Mobile HTML generation
// ---------------------------------------------------------------------------

/** Article boxes per page in the mobile/tablet UI (3..8). */
const PER_PAGE = 5;

const MOBILE_PAGE_STYLE = `
<style>
:root { --ink:#222; --mut:#888; --line:#e0e0e0; --card:#fff; --bg:#fafafa; --acc:#4a90d9; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin:0; padding:0; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--ink); }
body { height:100vh; height:100dvh; overflow:hidden; display:flex; flex-direction:column; }

.page-bar { display:flex; align-items:center; gap:10px; padding:6px 14px; color:var(--mut); font-size:0.8em; border-bottom:1px solid var(--line); background:#fff; flex:0 0 auto; }
.page-label { flex:0 0 auto; }
.page-meta { flex:1 1 auto; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.toggle-box { flex:0 0 auto; display:flex; gap:4px; }
.toggle-btn { padding:2px 8px; border:1px solid var(--line); border-radius:4px; background:#fff; cursor:pointer; font-size:0.8em; color:var(--ink); }
.toggle-btn.active { background:var(--acc); color:#fff; border-color:var(--acc); }
.toggle-btn .count { font-weight:600; }
#list-close { display:none; border:none; background:none; font-size:1.2em; cursor:pointer; color:#999; }

.main { flex:1 1 auto; position:relative; overflow:hidden; display:flex; }

#list { flex:1 1 auto; position:relative; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:12px; display:flex; flex-direction:column; gap:12px; }

.article { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px; cursor:pointer; flex:0 0 auto; }
.article.hidden { display:none; }
.article.seen { border-left:3px solid #ffc107; }
.article.read { border-left:3px solid #28a745; opacity:0.85; }
.article h3 { margin:0 0 6px 0; font-size:1.05em; line-height:1.3; }
.card-title { color:#1a5276; }
.source { color:var(--mut); font-size:0.8em; }
.summary { color:#555; margin-top:8px; font-size:0.9em; line-height:1.5; }
.score { display:inline-block; padding:1px 6px; border-radius:12px; font-size:0.75em; font-weight:bold; }
.score-high { background:#d4edda; color:#155724; }
.score-mid { background:#fff3cd; color:#856404; }
.score-low { background:#f8d7da; color:#721c24; }
.score-zero { background:#e2e3e5; color:#6c757d; }
.dup-badge { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:10px; font-size:0.75em; background:#e8e0f0; color:#6c4a9e; }
.card-icon { width:20px; height:20px; background-size:contain; background-repeat:no-repeat; margin-bottom:4px; opacity:0.6; }

#reader { flex:0 0 0px; width:0; overflow:hidden; background:#fff; display:flex; flex-direction:column; transition:flex-basis 0.3s ease; }
.reader-head { display:flex; justify-content:flex-end; padding:4px; background:#fff; border-bottom:1px solid var(--line); }
#reader-close { border:none; background:none; font-size:1.2em; cursor:pointer; color:#999; padding:2px 8px; }
#reader-frame { flex:1; width:100%; border:none; background:#fff; }

body.reading #reader { flex:1 1 auto; width:auto; }
body.reading #list { flex:0 0 56px; width:56px; padding:6px; gap:6px; }
body.reading #list .article .card-title,
body.reading #list .article .source,
body.reading #list .article .summary,
body.reading #list .article .dup-badge { display:none; }
body.reading #list .article { padding:6px; font-size:0; text-align:center; }
body.reading #list-close { display:inline-block; }
</style>`;

function mobileCard(
  a: ScoredArticle,
  index: number,
  domain: string,
  seenSet: Set<string>,
  readSet: Set<string>,
): string {
  const faviconUrl =
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  const isSeen = seenSet.has(a.id);
  const isRead = readSet.has(a.id);
  const keywordScore = a.score + (isRead ? 2 : 0);
  const scoreClass = keywordScore > 2
    ? "score-high"
    : keywordScore > 0
    ? "score-mid"
    : keywordScore < 0
    ? "score-low"
    : "score-zero";
  const scoreLabel = keywordScore > 2
    ? "★"
    : keywordScore > 0
    ? "↑"
    : keywordScore < 0
    ? "↓"
    : "·";
  const stateClass = isRead ? " read hidden" : isSeen ? " seen hidden" : "";

  const dupBadge = (a.duplicateSources && a.duplicateSources.length > 0)
    ? `<span class="dup-badge" title="Also from: ${
      a.duplicateSources.map((s) => escapeHtml(s)).join(", ")
    }">↗ ${a.duplicateCount} feed${a.duplicateCount === 1 ? "" : "s"}</span>`
    : "";

  return `<div class="article${stateClass}" data-index="${index}" data-url="${
    escapeHtml(a.url)
  }" data-article-id="${escapeHtml(a.id)}">
<div class="card-icon" style="background-image:url('${faviconUrl}')"></div>
<h3><span class="card-title">${escapeHtml(a.title)}</span>${dupBadge}</h3>
<span class="source">${escapeHtml(domain)} · ${scorePill(a.feedScore ?? 0)} · <span class="score ${scoreClass}">${scoreLabel} ${keywordScore}</span></span>
<div class="summary">${escapeHtml(a.summary.slice(0, 200))}${
    a.summary.length > 200 ? "…" : ""
  }</div>
</div>`;
}

// Model definition
// ---------------------------------------------------------------------------

/** Model definition for fetching RSS feeds and generating news summaries. */
export const model = {
  type: "@svendowideit/news-reader",
  version: "2026.08.08.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.08.08.1",
      description:
        "Baseline version for @svendowideit/news-reader, no globalArguments schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    snapshot: {
      description: "Latest fetched feed snapshot",
      schema: FeedSnapshotSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    filteredSnapshot: {
      description: "Age-filtered snapshot for HTML generation",
      schema: FilteredSnapshotSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    preferences: {
      description: "User article preferences and learned keyword weights",
      schema: PreferencesSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    pagesQueue: {
      description: "Page URLs pulled from the pages queue for catalog upsert",
      schema: PagesQueueSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    stories: {
      description:
        "Persistent fused story objects (survive age-filter windows)",
      schema: StoriesStateSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    clusters: {
      description: "Transient story clusters awaiting LLM seed/fuse",
      schema: ClustersStateSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    storiesHtml: {
      description: "Rendered inline HTML fragment for fused stories",
      schema: z.object({ html: z.string() }),
      lifetime: "7d",
      garbageCollection: 20,
    },
    dedupedUrls: {
      description: "Previously deduped article URLs for incremental dedupe",
      schema: z.object({
        urls: z.array(z.string()),
        articles: z.array(z.unknown()),
      }),
      lifetime: "7d",
      garbageCollection: 20,
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
    setup: {
      description:
        "Interactive configuration helper. Run with no inputs to list the model's config params (name, kind, default, current value); pass inputs to validate them, test the LLM settings live, and print the exact `swamp model edit` command to persist only the changed values. NOTE: setup does NOT persist values itself.",
      arguments: z.object({
        llmBaseUrl: z.string().url().optional().describe(
          "Base URL of an OpenAI-compatible LLM server (e.g. http://localhost:11434)",
        ),
        llmModel: z.string().optional().describe(
          "LLM model tag for story fusion. Empty = fusion disabled; set a tag to enable.",
        ),
        llmApiKey: z.string().optional().meta({ sensitive: true }).describe(
          "Optional API key for LLM servers that require authentication.",
        ),
        llmTemperature: z.number().min(0).max(2).optional().describe(
          "Sampling temperature (0..2). Low values keep extraction deterministic.",
        ),
        fusionMinClusterSize: z.number().int().min(1).optional().describe(
          "Minimum cluster size to trigger LLM fusion.",
        ),
        citationRetentionDays: z.number().int().min(0).optional().describe(
          "How long article citations live before aging out.",
        ),
        llmConcurrency: z.number().int().min(1).max(20).optional().describe(
          "Max parallel LLM requests.",
        ),
        maxFusions: z.number().int().min(1).optional().describe(
          "Hard cap on LLM fusion calls per step before the step stops and the workflow continues.",
        ),
        llmTimeoutSec: z.number().int().min(1).max(600).optional().describe(
          "Per-call LLM request timeout in seconds.",
        ),
        llmFailureThreshold: z.number().int().min(1).optional().describe(
          "Server-side LLM failures tolerated in a step before the step halts.",
        ),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;

        // Build the config surface from the model's globalArguments schema.
        // Redact the API key so it never appears in logs.
        const specs: Array<{
          name: string;
          kind: string;
          default: string;
          current: string;
          description: string;
        }> = [];
        for (const [key, schema] of Object.entries(GlobalArgsSchema.shape)) {
          const outerDef = (schema as z.ZodTypeAny)._def as unknown as Record<
            string,
            unknown
          >;
          const defaultValue = "defaultValue" in outerDef
            ? outerDef.defaultValue
            : undefined;
          const description = typeof outerDef.description === "string"
            ? outerDef.description
            : "";
          const innerDef =
            outerDef.typeName === "ZodDefault" && outerDef.innerType
              ? ((outerDef.innerType as z.ZodTypeAny)._def as unknown as Record<
                string,
                unknown
              >)
              : outerDef;
          const kind = innerDef.typeName === "ZodNumber" ? "number" : "string";
          const raw = ga[key as keyof GlobalArgs];
          const current = key === "llmApiKey" && raw
            ? "***redacted***"
            : String(raw);
          specs.push({
            name: key,
            kind,
            default: String(defaultValue),
            current,
            description,
          });
        }

        if (Object.keys(args).length === 0) {
          logger?.info("@svendowideit/news setup — config params", {});
          for (const s of specs) {
            logger?.info(
              "{name} [{kind}] default={default} current={current} — {description}",
              {
                name: s.name,
                kind: s.kind,
                default: s.default,
                current: s.current,
                description: s.description,
              },
            );
          }
          logger?.info(
            "To enable LLM story fusion, pass --input llmModel=<tag> (e.g. llama3) and llmBaseUrl=<url>.",
            {},
          );
          logger?.info(
            "Settings are tested live whenever a model is configured. To persist values, use `swamp model edit <name>`.",
            {},
          );
          return { dataHandles: [] };
        }

        // Validate provided values against the globalArguments schema.
        const issues: string[] = [];
        for (const [key, value] of Object.entries(args)) {
          if (value === undefined || value === null) continue;
          const field =
            GlobalArgsSchema.shape[key as keyof typeof GlobalArgsSchema.shape];
          const res = field.safeParse(value);
          if (!res.success) {
            issues.push(
              `${key}: ${res.error.issues.map((i) => i.message).join("; ")}`,
            );
          }
        }

        if (issues.length > 0) {
          for (const issue of issues) {
            logger?.warning("setup: {issue}", { issue });
          }
          throw new Error(
            `setup: ${issues.length} invalid config value(s): ${
              issues.join(", ")
            }`,
          );
        }

        const merged = { ...ga, ...args } as GlobalArgs;
        logger?.info("Validated config values OK.", {});
        if (merged.llmModel && merged.llmModel.length > 0) {
          logger?.info(
            "Fusion enabled — llmModel={model}, llmBaseUrl={base}",
            { model: merged.llmModel, base: merged.llmBaseUrl },
          );
        } else {
          logger?.info(
            "Fusion disabled (llmModel empty). Pass --input llmModel=<tag> to enable.",
            {},
          );
        }

        // Live test phase — probe the LLM server with the merged settings and
        // report remediation hints. Runs whenever a model is configured, so the
        // user learns immediately whether the inputs actually work.
        if (merged.llmModel) {
          logger?.info(
            "Testing LLM settings live against {base} (model {model})…",
            { base: merged.llmBaseUrl, model: merged.llmModel },
          );
          const result = await probeLlm(
            merged.llmBaseUrl,
            merged.llmModel,
            merged.llmApiKey,
          );
          for (const check of result.checks) {
            const level = check.status === "fail"
              ? "warning"
              : check.status === "warn"
              ? "warning"
              : "info";
            const msg = `[${check.status}] ${check.name}: ${check.detail}`;
            if (check.remediation) {
              logger?.[level]?.(
                "{msg} — remediation: {remediation}",
                { msg, remediation: check.remediation },
              );
            } else {
              logger?.[level]?.(msg, {});
            }
          }
          if (result.suggestedModel) {
            logger?.warning(
              "Suggested model spelling: {suggested} (you passed {model})",
              { suggested: result.suggestedModel, model: merged.llmModel },
            );
          }
          if (result.ok) {
            logger?.info(
              "LLM settings verified — the server is reachable and the model responds.",
              {},
            );
          } else {
            logger?.warning(
              "LLM settings have problems — see the checks above for remediation.",
              {},
            );
          }
        }

        // Print the exact command to persist the changed values. Only the keys
        // that differ from the current globalArgs are emitted.
        const defName = context.definition?.name ?? "<name>";

        const diffYaml = formatGlobalArgsDiffYaml(ga, merged);
        if (diffYaml === "globalArguments:") {
          logger?.info(
            "No changes needed — the current globalArguments already match these values.",
            {},
          );
          return { dataHandles: [] };
        }

        logger?.info(
          "To persist these values, run `swamp model edit {name}` and set:",
          { name: defName },
        );
        logger?.info("{yaml}", { yaml: diffYaml });
        logger?.info(
          "setup does not write globalArguments itself.",
          {},
        );
        return { dataHandles: [] };
      },
    },
    cleanupCdata: {
      description:
        "Strip CDATA wrappers from existing keywords in snapshots and preferences. Run once to clean up data from before the CDATA-stripping fix.",
      arguments: CleanupCdataArgsSchema,
      execute: async (
        _args: CleanupCdataArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const handles: Array<{ name: string }> = [];

        const strip = (s: string) =>
          s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();

        const snapshotData = await context.readResource("feed-snapshot") as
          | FeedSnapshot
          | null;
        if (snapshotData?.articles) {
          let fixed = 0;
          for (const a of snapshotData.articles) {
            const before = a.keywords.length;
            a.keywords = a.keywords.map(strip).filter((k) => k.length > 0);
            if (a.keywords.length !== before) fixed++;
          }
          const h = await context.writeResource("snapshot", "feed-snapshot", {
            fetchedAt: snapshotData.fetchedAt,
            articles: snapshotData.articles,
            errors: snapshotData.errors,
            nonFeedUrls: (snapshotData as unknown as Record<string, unknown>)
              .nonFeedUrls ?? [],
            feedCache: snapshotData.feedCache ?? {},
            feedArticleIds: snapshotData.feedArticleIds ?? {},
          });
          handles.push(h);
          logger?.info("Cleaned {fixed} articles in snapshot", { fixed });
        }

        const filteredData = await context.readResource("filtered-snapshot") as
          | (FeedSnapshot & { filteredAt: string; ageFilter: string })
          | null;
        if (filteredData?.articles) {
          let fixed = 0;
          for (const a of filteredData.articles) {
            const before = a.keywords.length;
            a.keywords = a.keywords.map(strip).filter((k) => k.length > 0);
            if (a.keywords.length !== before) fixed++;
          }
          const h = await context.writeResource(
            "filteredSnapshot",
            "filtered-snapshot",
            {
              fetchedAt: filteredData.fetchedAt,
              articles: filteredData.articles,
              errors: filteredData.errors,
              nonFeedUrls: (filteredData as unknown as Record<string, unknown>)
                .nonFeedUrls ?? [],
              filteredAt: filteredData.filteredAt,
              ageFilter: filteredData.ageFilter,
            },
          );
          handles.push(h);
          logger?.info("Cleaned {fixed} articles in filtered snapshot", {
            fixed,
          });
        }

        const prefsData = await context.readResource("prefs-current") as
          | Record<string, unknown>
          | null;
        if (prefsData) {
          const prefs = normalizePrefs(prefsData);
          let fixed = 0;
          for (const e of prefs.interested) {
            const before = e.keywords.length;
            e.keywords = e.keywords.map(strip).filter((k) => k.length > 0);
            if (e.keywords.length !== before) fixed++;
          }
          for (const e of prefs.ignored) {
            const before = e.keywords.length;
            e.keywords = e.keywords.map(strip).filter((k) => k.length > 0);
            if (e.keywords.length !== before) fixed++;
          }
          prefs.keywordWeights = computeKeywordWeights(prefs);
          const h = await context.writeResource(
            "preferences",
            "prefs-current",
            {
              interested: prefs.interested,
              ignored: prefs.ignored,
              seen: prefs.seen,
              read: prefs.read,
              keywordWeights: prefs.keywordWeights,
            },
          );
          handles.push(h);
          logger?.info("Cleaned {fixed} feedback entries in preferences", {
            fixed,
          });
        }

        return { dataHandles: handles };
      },
    },
    fetch: {
      description: "Fetch RSS/Atom feeds and store articles",
      arguments: FetchArgsSchema,
      execute: async (
        args: FetchArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;
        // Normalize feeds: accept string URLs or feed objects from news-feed-catalog.
        // Skip feeds marked as duplicates, invalid, or disabled.
        const skipped: string[] = [];
        const feedUrls: string[] = args.feeds.reduce<string[]>((acc, f) => {
          if (typeof f === "string") {
            acc.push(f);
            return acc;
          }
          if (f.duplicate === true) {
            skipped.push(f.url);
            return acc;
          }
          if (f.invalid === true) {
            skipped.push(f.url);
            return acc;
          }
          if (f.enabled === false) {
            skipped.push(f.url);
            return acc;
          }
          acc.push(f.url);
          return acc;
        }, []);

        if (feedUrls.length === 0) {
          throw new Error(
            "No feed URLs provided. Either:\n" +
              "  1. Pass feeds directly: --input 'feeds:json=[\"https://...\"]'\n" +
              "  2. Add feeds to the news-feed-catalog model first, then run without --input feeds\n\n" +
              "Usage:\n" +
              "  swamp workflow run @svendowideit/news-fetch --input 'feeds:json=[\"https://feeds.bbci.co.uk/news/technology/rss.xml\"]'\n\n" +
              "Inputs:\n" +
              "  feeds            string[] or feed objects  RSS/Atom feed URLs (or news-feed-catalog entries)\n" +
              "  maxArticlesPerFeed integer default: 25  Max articles per feed",
          );
        }
        logger?.info("Fetching {count} feeds", { count: feedUrls.length });
        if (skipped.length > 0) {
          logger?.info("Skipped {n} duplicate/invalid/disabled feeds: {urls}", {
            n: skipped.length,
            urls: skipped.join(", "),
          });
        }

        const allArticles: Article[] = [];
        const errors: { url: string; message: string }[] = [];
        const nonFeedUrls: { url: string; contentType: string }[] = [];
        const newFeedCache: Record<
          string,
          { etag?: string; lastModified?: string }
        > = {};
        const newFeedArticleIds: Record<string, string[]> = {};
        let notModifiedCount = 0;

        const prevSnapshot = await context.readResource("feed-snapshot") as
          | {
            articles: Article[];
            feedCache?: Record<
              string,
              { etag?: string; lastModified?: string }
            >;
            feedArticleIds?: Record<string, string[]>;
          }
          | null;
        const prevArticlesById = new Map(
          (prevSnapshot?.articles ?? []).map((a) => [a.id, a]),
        );
        const prevFeedCache = prevSnapshot?.feedCache ?? {};
        const prevFeedArticleIds = prevSnapshot?.feedArticleIds ?? {};

        for (const feedUrl of feedUrls) {
          logger?.info("Fetching {url}", { url: feedUrl });
          const cacheHeaders = prevFeedCache[feedUrl];
          const result = await fetchFeed(
            feedUrl,
            args.maxArticlesPerFeed,
            cacheHeaders,
          );
          const merged = mergeFeedFetchResult(feedUrl, result, {
            prevFeedCache,
            prevFeedArticleIds,
            prevArticlesById,
          });

          allArticles.push(...merged.articles);
          if (merged.feedCache) newFeedCache[feedUrl] = merged.feedCache;
          if (merged.feedArticleIds) {
            newFeedArticleIds[feedUrl] = merged.feedArticleIds;
          }
          if (merged.notModified) {
            notModifiedCount++;
            logger?.info("Not modified (304): {url}", { url: feedUrl });
          } else if (merged.error) {
            errors.push(merged.error);
            logger?.info("Failed: {url} — {error}", {
              url: feedUrl,
              error: merged.error.message,
            });
          } else if (merged.nonFeedUrl) {
            nonFeedUrls.push(merged.nonFeedUrl);
            logger?.info("Not a feed (HTML page or unknown): {url}", {
              url: feedUrl,
              contentType: merged.nonFeedUrl.contentType,
            });
          } else {
            logger?.info("Got {n} articles from {url}", {
              n: merged.articles.length,
              url: feedUrl,
            });
          }
        }

        logger?.info(
          "Fetched {total} articles total ({notModified} feeds not modified), {errors} errors, {nonFeeds} non-feed URLs",
          {
            total: allArticles.length,
            notModified: notModifiedCount,
            errors: errors.length,
            nonFeeds: nonFeedUrls.length,
          },
        );

        const handle = await context.writeResource(
          "snapshot",
          "feed-snapshot",
          {
            fetchedAt: new Date().toISOString(),
            articles: allArticles,
            errors,
            nonFeedUrls,
            feedCache: newFeedCache,
            feedArticleIds: newFeedArticleIds,
          },
        );

        return { dataHandles: [handle] };
      },
    },
    dedupeArticles: {
      description:
        "Group articles by URL, mark duplicates, and annotate primary articles with duplicate source info",
      arguments: DedupeArticlesArgsSchema,
      execute: async (
        _args: DedupeArticlesArgs,
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

        const prevDeduped = await context.readResource("dedupedUrls-current") as
          | { urls: string[]; articles: Article[] }
          | null;
        const result = dedupeArticlesIncremental(
          snapshotData.articles,
          prevDeduped?.urls ?? [],
          prevDeduped?.articles ?? [],
        );

        logger?.info(
          "Deduped {total} articles ({new} new, {reused} reused): {duplicates} duplicates",
          {
            total: result.deduped.length,
            new: result.newCount,
            reused: result.reusedCount,
            duplicates: result.duplicateCount,
          },
        );

        // Persist the URL set + deduped articles for next run's incremental pass.
        const allUrls = result.deduped.map((a) => a.url);
        await context.writeResource(
          "dedupedUrls",
          "dedupedUrls-current",
          { urls: allUrls, articles: result.deduped } as unknown as Record<
            string,
            unknown
          >,
        );

        const handle = await context.writeResource(
          "snapshot",
          "feed-snapshot",
          {
            fetchedAt: snapshotData.fetchedAt,
            articles: result.deduped,
            errors: snapshotData.errors,
            nonFeedUrls: (snapshotData as unknown as Record<string, unknown>)
              .nonFeedUrls ?? [],
            feedCache: snapshotData.feedCache ?? {},
            feedArticleIds: snapshotData.feedArticleIds ?? {},
          },
        );

        return { dataHandles: [handle] };
      },
    },
    filterByAge: {
      description:
        "Filter articles by age and store filtered snapshot for HTML generation",
      arguments: FilterByAgeArgsSchema,
      execute: async (
        args: FilterByAgeArgs,
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

        const maxAgeMs = parseNewsAge(args.newsAge);
        const now = new Date().getTime();
        const cutoff = now - maxAgeMs;

        logger?.info("Filtering {total} articles by age (max: {age})", {
          total: snapshotData.articles.length,
          age: args.newsAge,
        });

        const filteredArticles = snapshotData.articles.filter((a) => {
          if (a.duplicate === true) return false;
          const pubDate = new Date(a.publishedAt).getTime();
          return pubDate >= cutoff && pubDate <= now;
        });

        logger?.info("Filtered to {n} articles within last {age}", {
          n: filteredArticles.length,
          age: args.newsAge,
        });

        const handle = await context.writeResource(
          "filteredSnapshot",
          "filtered-snapshot",
          {
            fetchedAt: new Date().toISOString(),
            articles: filteredArticles,
            errors: snapshotData.errors,
            nonFeedUrls: (snapshotData as unknown as Record<string, unknown>)
              .nonFeedUrls ?? [],
            filteredAt: new Date().toISOString(),
            ageFilter: args.newsAge,
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

        let snapshotData = await context.readResource("filtered-snapshot") as
          | (FeedSnapshot & { filteredAt: string; ageFilter: string })
          | null;

        if (!snapshotData) {
          snapshotData = await context.readResource("feed-snapshot") as
            | (FeedSnapshot & { filteredAt: string; ageFilter: string })
            | null;
          if (
            !snapshotData || !snapshotData.articles ||
            snapshotData.articles.length === 0
          ) {
            throw new Error(
              "No articles found — run the 'fetch' method first with some feed URLs",
            );
          }
        } else {
          logger?.info("Using filtered snapshot from {ageFilter}", {
            ageFilter: snapshotData.ageFilter,
          });
        }

        const prefsData = await context.readResource("prefs-current") as
          | Record<string, unknown>
          | null;
        const prefs = normalizePrefs(prefsData);

        logger?.info(
          "Scoring {articles} articles against {interested} interested, {ignored} ignored",
          {
            articles: snapshotData.articles.length,
            interested: prefs.interested.length,
            ignored: prefs.ignored.length,
          },
        );

        const scored = scoreAndSortArticles(
          snapshotData.articles,
          prefs,
        );
        const top = args.topN > 0 ? scored.slice(0, args.topN) : scored;
        const generatedAt = new Date().toISOString();

        logger?.info("Generating HTML with {count} articles", {
          count: top.length,
        });

        const storiesState = await context.readResource(
          "stories-html-current",
        ) as
          | { html: string }
          | null;
        const html = generateHtml(
          top,
          prefs,
          args.title,
          generatedAt,
          snapshotData.filteredAt ? snapshotData.ageFilter : undefined,
          storiesState?.html,
        );

        const writer = context.createFileWriter("report", "news-page");
        const handle = await writer.writeText(html);

        logger?.info("HTML report written ({size} bytes)", {
          size: html.length,
        });

        const outPath = await resolveNewsPagePath(args.outputPath);
        await Deno.writeTextFile(outPath, html);
        logger?.info("HTML report written to {path}", { path: outPath });

        return { dataHandles: [handle] };
      },
    },
    generateMobile: {
      description:
        "Generate the mobile/tablet-optimised news summary page (swipe pagination + in-page article reader iframe) from the latest articles, ranked by interest. Writes to `~/.swamp/news-pages/news-mobile.html` by default.",
      arguments: GenerateMobileArgsSchema,
      execute: async (
        args: GenerateMobileArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        let snapshotData = await context.readResource("filtered-snapshot") as
          | (FeedSnapshot & { filteredAt: string; ageFilter: string })
          | null;

        if (!snapshotData) {
          snapshotData = await context.readResource("feed-snapshot") as
            | (FeedSnapshot & { filteredAt: string; ageFilter: string })
            | null;
          if (
            !snapshotData || !snapshotData.articles ||
            snapshotData.articles.length === 0
          ) {
            throw new Error(
              "No articles found — run the 'fetch' method first with some feed URLs",
            );
          }
        }

        const prefsData = await context.readResource("prefs-current") as
          | Record<string, unknown>
          | null;
        const prefs = normalizePrefs(prefsData);

        const scored = scoreAndSortArticles(snapshotData.articles, prefs);
        const top = args.topN > 0 ? scored.slice(0, args.topN) : scored;
        const generatedAt = new Date().toISOString();

        logger?.info("Generating mobile HTML with {count} articles", {
          count: top.length,
        });

        const html = generateMobileHtml(
          top,
          prefs,
          args.title,
          generatedAt,
          snapshotData.filteredAt ? snapshotData.ageFilter : undefined,
        );

        const writer = context.createFileWriter("report", "news-page");
        const handle = await writer.writeText(html);

        const outPath = await resolveMobileNewsPagePath(args.outputPath);
        await Deno.writeTextFile(outPath, html);
        logger?.info("Mobile HTML report written to {path}", { path: outPath });

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
          | Record<string, unknown>
          | null;
        const prefs = normalizePrefs(prefsData);

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
            seen: prefs.seen,
            read: prefs.read,
            keywordWeights: prefs.keywordWeights,
          },
        );

        return { dataHandles: [handle] };
      },
    },
    gatherFeedback: {
      description:
        "Poll the feedback queue HTTP server, import entries into preferences, and delete processed entries",
      arguments: GatherFeedbackArgsSchema,
      execute: async (
        args: GatherFeedbackArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const prefsData = await context.readResource("prefs-current") as
          | Record<string, unknown>
          | null;
        const prefs = normalizePrefs(prefsData);

        let totalProcessed = 0;
        let batchCount = 0;
        let queued = 1; // assume pending until first poll reports otherwise

        while (batchCount < args.maxBatches && queued > 0) {
          const getUrl =
            `${args.serverUrl}/api/feedback?limit=${args.batchSize}`;
          logger?.info("Polling feedback queue: {url}", { url: getUrl });

          let resp: Response;
          try {
            resp = await fetch(getUrl, {
              signal: AbortSignal.timeout(10000),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.info("Feedback server unreachable: {error}", {
              error: msg,
            });
            break;
          }

          if (!resp.ok) {
            logger?.info("Feedback server returned {status}", {
              status: resp.status,
            });
            break;
          }

          const body = await resp.json() as {
            items: Array<{
              id: string;
              articleId: string;
              action: "interested" | "ignored" | "seen" | "read";
              source: string;
              title: string;
              keywords: string[];
            }>;
            remaining: number;
            queued: number;
          };

          if (!body.items || body.items.length === 0) {
            logger?.info("No pending feedback entries");
            break;
          }

          queued = body.queued ?? body.items.length;

          logger?.info("Processing {count} feedback entries (batch {batch})", {
            count: body.items.length,
            batch: batchCount + 1,
          });

          const processedIds: string[] = [];

          for (const item of body.items) {
            if (item.action === "seen") {
              if (!prefs.seen.includes(item.articleId)) {
                prefs.seen.push(item.articleId);
              }
            } else if (item.action === "read") {
              if (!prefs.read.includes(item.articleId)) {
                prefs.read.push(item.articleId);
              }
            } else {
              const entry: FeedbackEntry = {
                articleId: item.articleId,
                recordedAt: new Date().toISOString(),
                source: item.source ?? "",
                title: item.title ?? "",
                keywords: item.keywords ?? [],
              };

              if (item.action === "interested") {
                prefs.ignored = prefs.ignored.filter((e) =>
                  e.articleId !== item.articleId
                );
                if (
                  !prefs.interested.some((e) => e.articleId === item.articleId)
                ) {
                  prefs.interested.push(entry);
                }
              } else {
                prefs.interested = prefs.interested.filter((e) =>
                  e.articleId !== item.articleId
                );
                if (
                  !prefs.ignored.some((e) => e.articleId === item.articleId)
                ) {
                  prefs.ignored.push(entry);
                }
              }
            }

            processedIds.push(item.id);
            totalProcessed++;
          }

          prefs.keywordWeights = computeKeywordWeights(prefs);

          const deleteUrl = `${args.serverUrl}/api/feedback?ids=${
            processedIds.join(",")
          }`;
          try {
            await fetch(deleteUrl, {
              method: "DELETE",
              signal: AbortSignal.timeout(5000),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.info("Failed to delete processed entries: {error}", {
              error: msg,
            });
          }

          batchCount++;
        }

        logger?.info(
          "Gathered {count} feedback entries across {batches} batches",
          { count: totalProcessed, batches: batchCount },
        );

        const handle = await context.writeResource(
          "preferences",
          "prefs-current",
          {
            interested: prefs.interested,
            ignored: prefs.ignored,
            seen: prefs.seen,
            read: prefs.read,
            keywordWeights: prefs.keywordWeights,
          },
        );

        return { dataHandles: [handle] };
      },
    },
    gatherPages: {
      description:
        "Poll the pages queue HTTP server, return queued page URLs as a data resource",
      arguments: GatherPagesArgsSchema,
      execute: async (
        args: GatherPagesArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const pages: PageEntry[] = [];
        let batchCount = 0;
        let queued = 1; // assume pending until first poll reports otherwise

        while (batchCount < args.maxBatches && queued > 0) {
          const getUrl = `${args.serverUrl}/api/pages?limit=${args.batchSize}`;
          logger?.info("Polling pages queue: {url}", { url: getUrl });

          let resp: Response;
          try {
            resp = await fetch(getUrl, {
              signal: AbortSignal.timeout(10000),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.info("Pages queue server unreachable: {error}", {
              error: msg,
            });
            break;
          }

          if (!resp.ok) {
            logger?.info("Pages queue returned {status}", {
              status: resp.status,
            });
            break;
          }

          const body = await resp.json() as { items: QueuedPage[] };
          if (!body.items || body.items.length === 0) {
            logger?.info("No queued pages");
            break;
          }

          queued = body.items.length;

          logger?.info("Processing {count} queued pages (batch {batch})", {
            count: body.items.length,
            batch: batchCount + 1,
          });

          const processedIds: string[] = [];
          for (const item of body.items) {
            logger?.info("Queued page: {url}", { url: item.url });
            pages.push({
              url: item.url,
              name: extractPageName(item.url),
              category: args.category,
            });
            processedIds.push(item.id);
          }

          const deleteUrl = `${args.serverUrl}/api/pages?ids=${
            processedIds.join(",")
          }`;
          try {
            await fetch(deleteUrl, { method: "DELETE" });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.info("Failed to delete processed pages: {error}", {
              error: msg,
            });
          }

          batchCount++;
        }

        logger?.info("Gathered {count} pages from queue", {
          count: pages.length,
        });

        const handle = await context.writeResource(
          "pagesQueue",
          "pages-current",
          {
            pages,
            gatheredAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },
    clusterArticles: {
      description:
        "Conservatively cluster filtered articles into same-story groups (no LLM). Requires a filtered-snapshot resource.",
      arguments: z.object({
        snapshotName: z.string().default("filtered-snapshot"),
        maxClusterSize: z.number().int().min(1).max(100).default(40),
      }),
      execute: async (
        args: { snapshotName: string; maxClusterSize: number },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;
        const snap = await context.readResource(args.snapshotName) as
          | { articles: Article[] }
          | null;
        if (!snap || !snap.articles || snap.articles.length === 0) {
          throw new Error("No articles — run 'fetch' first with some feeds.");
        }
        const storiesState = await context.readResource("stories-current") as
          | { stories: Story[] }
          | null;
        const clusters = clusterStories(
          snap.articles,
          storiesState?.stories ?? [],
          args.maxClusterSize,
        );
        // Compute fingerprints for change detection (article IDs + LLM config).
        for (const c of clusters.clusters) {
          c.fingerprint = await computeClusterFingerprint(
            c,
            ga.llmModel,
            ga.llmTemperature,
          );
        }
        const handle = await context.writeResource(
          "clusters",
          "clusters-current",
          {
            clusters: clusters.clusters,
            absorbable: clusters.absorbable,
          } as unknown as Record<string, unknown>,
        );
        logger?.info(
          "Clustered {n} articles into {c} story clusters ({gate} ambiguous, {absorb} absorbed)",
          {
            n: snap.articles.length,
            c: clusters.clusters.length,
            gate: clusters.clusters.filter((x) => x.needsGate).length,
            absorb: clusters.absorbable.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    seedStories: {
      description:
        "LLM-seed persistent Story objects from the current clusters resource.",
      arguments: z.object({
        minClusterSize: z.number().int().min(1).default(2),
      }),
      execute: async (
        args: { minClusterSize: number },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;
        if (!ga.llmModel) {
          logger?.info(
            "Fusion skipped: no llmModel configured (set globalArguments.llmModel + llmBaseUrl to enable)",
          );
          const storiesState = await context.readResource("stories-current") as
            | { stories: Story[] }
            | null;
          const handle = await context.writeResource(
            "stories",
            "stories-current",
            { stories: storiesState?.stories ?? [] } as unknown as Record<
              string,
              unknown
            >,
          );
          return { dataHandles: [handle] };
        }
        const clustersState = await context.readResource("clusters-current") as
          | { clusters: StoryCluster[] }
          | null;
        const clusters = clustersState?.clusters ?? [];
        if (!clusters || clusters.length === 0) {
          throw new Error("No clusters — run 'clusterArticles' first.");
        }
        const storiesState = await context.readResource("stories-current") as
          | { stories: Story[] }
          | null;
        const existing = storiesState?.stories ?? [];
        const uniqueToSeed = selectClustersToSeed(
          clusters,
          existing,
          args.minClusterSize,
        );
        const newStories: Story[] = [];
        const concurrency = ga.llmConcurrency ?? 3;
        const breaker = new CircuitBreaker(ga.llmFailureThreshold ?? 3);
        let calls = 0;
        let hardCapped = false;
        await withConcurrency(uniqueToSeed, concurrency, async (c) => {
          if (breaker.shouldStop()) return;
          if (calls >= (ga.maxFusions ?? 25)) {
            if (!hardCapped) {
              hardCapped = true;
              logger?.warning(
                "maxFusions={n} reached in seedStories — remaining {r} clusters skipped",
                { n: ga.maxFusions, r: uniqueToSeed.length - calls },
              );
            }
            return;
          }
          calls += 1;
          try {
            const st = await seedStory(ga, c);
            breaker.recordSuccess();
            newStories.push(st);
            logger?.info("Seeded story '{topic}' ({id})", {
              topic: st.identity.topic,
              id: st.id,
            });
          } catch (err) {
            breaker.recordFailure(err);
            const msg = err instanceof Error ? err.message : String(err);
            if (isLlmServerError(err)) {
              logger?.warning(
                "Seed failed for '{topic}' due to server error ({error}); breaker {b}/{t}",
                {
                  topic: c.topic,
                  error: msg,
                  b: breaker.tripCount(),
                  t: ga.llmFailureThreshold ?? 3,
                },
              );
            } else {
              logger?.warning("Seed failed for '{topic}': {error}", {
                topic: c.topic,
                error: msg,
              });
            }
          }
        });
        if (breaker.shouldStop()) {
          logger?.warning(
            "seedStories aborted early: LLM server errors hit the {t} failure threshold — continuing with {n} seeded stories",
            { t: ga.llmFailureThreshold ?? 3, n: newStories.length },
          );
        }
        const merged = [...existing, ...newStories];
        const handle = await context.writeResource(
          "stories",
          "stories-current",
          { stories: merged } as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    fuseStories: {
      description:
        "LLM-delta pass: absorb new cluster articles into existing stories and persist.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;
        if (!ga.llmModel) {
          logger?.info(
            "Fusion skipped: no llmModel configured (set globalArguments.llmModel + llmBaseUrl to enable)",
          );
          const storiesState = await context.readResource("stories-current") as
            | { stories: Story[] }
            | null;
          const handle = await context.writeResource(
            "stories",
            "stories-current",
            { stories: storiesState?.stories ?? [] } as unknown as Record<
              string,
              unknown
            >,
          );
          return { dataHandles: [handle] };
        }
        const stories = (await context.readResource("stories-current") as
          | { stories: Story[] }
          | null)?.stories ?? [];
        const clustersState = await context.readResource("clusters-current") as
          | { clusters: StoryCluster[]; absorbable: Article[] }
          | null;
        const clusters = clustersState?.clusters ?? [];
        const absorbable = clustersState?.absorbable ?? [];
        const existingById = new Map(stories.map((s) => [s.id, s]));
        const toUpdate: Story[] = [];

        // Read previous clusters for fingerprint-based skip.
        const prevClusters = (await context.readResource("clusters-previous") as
          | { clusters: StoryCluster[] }
          | null)?.clusters ?? [];
        const prevByKey = new Map(prevClusters.map((c) => [c.key, c]));

        // Error budget shared by the fresh-cluster pass and the absorbable
        // pass: one circuit breaker (server-side failures) and one hard cap on
        // total LLM calls. Either trip stops the remaining work so the step
        // can finish and the workflow can continue on to the next step.
        const breaker = new CircuitBreaker(ga.llmFailureThreshold ?? 3);
        const maxFusions = ga.maxFusions ?? 25;
        let calls = 0;
        let hardCapped = false;
        const callGated = () => {
          if (breaker.shouldStop()) return { stop: true as const };
          if (calls >= maxFusions) {
            if (!hardCapped) {
              hardCapped = true;
              logger?.warning(
                "maxFusions={n} reached in fuseStories — remaining work skipped",
                { n: maxFusions },
              );
            }
            return { stop: true as const };
          }
          calls += 1;
          return { stop: false as const };
        };

        // Fresh clusters: fuse each into the matching existing story.
        const concurrency = ga.llmConcurrency ?? 3;
        await withConcurrency(clusters, concurrency, async (c) => {
          const st = existingById.get(c.key) ?? existingById.get(
            clusterKey(c.topic, c.entities),
          );
          if (!st) return;
          // Skip if cluster unchanged since last run (same articles + same config).
          const prev = prevByKey.get(c.key);
          if (
            prev && prev.fingerprint && c.fingerprint &&
            prev.fingerprint === c.fingerprint
          ) {
            logger?.info("Skipping unchanged cluster '{topic}'", {
              topic: c.topic,
            });
            return;
          }
          if (callGated().stop) return;
          try {
            const updated = await fuseStory(ga, st, c.articles);
            breaker.recordSuccess();
            toUpdate.push(updated);
            logger?.info("Fused {n} articles into story '{topic}'", {
              n: c.articles.length,
              topic: st.identity.topic,
            });
          } catch (err) {
            breaker.recordFailure(err);
            const msg = err instanceof Error ? err.message : String(err);
            if (isLlmServerError(err)) {
              logger?.warning(
                "Fuse failed for '{topic}' due to server error ({error}); breaker {b}/{t}",
                {
                  topic: c.topic,
                  error: msg,
                  b: breaker.tripCount(),
                  t: ga.llmFailureThreshold ?? 3,
                },
              );
            } else {
              logger?.warning("Fuse failed for '{topic}': {error}", {
                topic: c.topic,
                error: msg,
              });
            }
          }
        });

        // Absorbable articles already matched an existing story at cluster time;
        // re-match by entity overlap and fuse each one individually.
        // Use cached entities from clusterArticles when available.
        for (const a of absorbable ?? []) {
          const aEntities = a.entities ??
            extractEntities(a.title, a.summary ?? "");
          let st: Story | undefined;
          for (const s of stories) {
            const sEntities = s.identity.entities.map((e) =>
              e.name.toLowerCase()
            );
            const shared = aEntities.filter((e) =>
              sEntities.includes(e.toLowerCase())
            ).length;
            if (shared >= 2) {
              st = s;
              break;
            }
          }
          if (!st) continue;
          if (callGated().stop) continue;
          try {
            const updated = await fuseStory(ga, st, [a]);
            breaker.recordSuccess();
            toUpdate.push(updated);
            logger?.info("Absorbed article '{title}' into story '{topic}'", {
              title: a.title,
              topic: st.identity.topic,
            });
          } catch (err) {
            breaker.recordFailure(err);
            const msg = err instanceof Error ? err.message : String(err);
            if (isLlmServerError(err)) {
              logger?.warning(
                "Absorb failed for '{topic}' due to server error ({error}); breaker {b}/{t}",
                {
                  topic: st.identity.topic,
                  error: msg,
                  b: breaker.tripCount(),
                  t: ga.llmFailureThreshold ?? 3,
                },
              );
            } else {
              logger?.warning("Absorb failed for '{topic}': {error}", {
                topic: st.identity.topic,
                error: msg,
              });
            }
          }
        }
        if (breaker.shouldStop()) {
          logger?.warning(
            "fuseStories aborted early: LLM server errors hit the {t} failure threshold — continuing with {n} updated stories",
            { t: ga.llmFailureThreshold ?? 3, n: toUpdate.length },
          );
        }

        const merged = stories.map((s) => {
          const upd = toUpdate.find((u) => u.id === s.id);
          return upd ?? s;
        });
        const handle = await context.writeResource(
          "stories",
          "stories-current",
          { stories: merged } as unknown as Record<string, unknown>,
        );
        // Persist clusters for next run's fingerprint comparison.
        await context.writeResource(
          "clusters",
          "clusters-previous",
          { clusters } as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    regenStories: {
      description:
        "Throttled P3 pass: full LLM re-fusion of each story from its citations.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;
        if (!ga.llmModel) {
          logger?.info(
            "Fusion skipped: no llmModel configured (set globalArguments.llmModel + llmBaseUrl to enable)",
          );
          const storiesState = await context.readResource("stories-current") as
            | { stories: Story[] }
            | null;
          const handle = await context.writeResource(
            "stories",
            "stories-current",
            { stories: storiesState?.stories ?? [] } as unknown as Record<
              string,
              unknown
            >,
          );
          return { dataHandles: [handle] };
        }
        const storiesState = await context.readResource("stories-current") as
          | { stories: Story[] }
          | null;
        const stories = storiesState?.stories ?? [];
        const updated: Story[] = [];
        const breaker = new CircuitBreaker(ga.llmFailureThreshold ?? 3);
        const maxFusions = ga.maxFusions ?? 25;
        let calls = 0;
        for (const st of stories) {
          if (breaker.shouldStop() || calls >= maxFusions) break;
          calls += 1;
          try {
            updated.push(await regenStory(ga, st));
            breaker.recordSuccess();
          } catch (err) {
            breaker.recordFailure(err);
            const msg = err instanceof Error ? err.message : String(err);
            if (isLlmServerError(err)) {
              logger?.warning(
                "Regen failed for '{topic}' due to server error ({error}); breaker {b}/{t}",
                {
                  topic: st.identity.topic,
                  error: msg,
                  b: breaker.tripCount(),
                  t: ga.llmFailureThreshold ?? 3,
                },
              );
            } else {
              logger?.warning("Regen failed for '{topic}': {error}", {
                topic: st.identity.topic,
                error: msg,
              });
            }
          }
        }
        if (breaker.shouldStop()) {
          logger?.warning(
            "regenStories aborted early: LLM server errors hit the {t} failure threshold — continuing with {n} regenerated stories",
            { t: ga.llmFailureThreshold ?? 3, n: updated.length },
          );
        }
        const handle = await context.writeResource(
          "stories",
          "stories-current",
          { stories: updated } as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    renderStories: {
      description:
        "Render persistent stories to an inline HTML fragment resource (storiesHtml) and optionally a standalone stories.html page.",
      arguments: z.object({
        outputPath: z
          .string()
          .optional()
          .describe(
            "If set, write the standalone stories page to this local file path. Defaults to `~/.swamp/news-pages/stories.html` when omitted.",
          ),
      }).describe("Arguments for the renderStories method"),
      execute: async (
        args: { outputPath?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;
        const storiesState = await context.readResource("stories-current") as
          | { stories: Story[] }
          | null;
        const prefsData = await context.readResource("prefs-current") as
          | Record<string, unknown>
          | null;
        const prefs = normalizePrefs(prefsData);
        const stories = storiesState?.stories ?? [];
        const aged = stories.map((s) =>
          ageOutCitations(s, ga.citationRetentionDays)
        );
        const html = await renderStories(aged, prefs, "Fused stories");
        const handle = await context.writeResource(
          "storiesHtml",
          "stories-html-current",
          { html } as unknown as Record<string, unknown>,
        );
        logger?.info("Rendered {n} fused stories to storiesHtml", {
          n: aged.length,
        });
        const generatedAt = new Date().toISOString();
        const outPath = args.outputPath ||
          `${homeDir()}/.swamp/news-pages/stories.html`;
        const dir = outPath.slice(0, outPath.lastIndexOf("/"));
        if (dir) {
          await Deno.mkdir(dir, { recursive: true });
        }
        const page = await renderStoriesPage(
          aged,
          prefs,
          "Fused stories",
          generatedAt,
        );
        await Deno.writeTextFile(outPath, page);
        logger?.info("Full stories page written to {path}", { path: outPath });
        return { dataHandles: [handle] };
      },
    },
  },
  reports: ["@svendowideit/news-html-report"],
};
