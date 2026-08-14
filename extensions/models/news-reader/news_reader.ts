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
  llmApiKey: z.string().optional().describe(
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
  outputPath: z.string().optional().describe(
    "If set, also write the HTML to this local file path (e.g., news.html)",
  ),
}).describe("Arguments for the generate method");

type GenerateArgs = z.infer<typeof GenerateArgsSchema>;

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

// ---------------------------------------------------------------------------
// LLM helpers (OpenAI-compatible chat/completions)
// ---------------------------------------------------------------------------

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
    ...(opts?.json
      ? { response_format: { type: "json_object" } }
      : {}),
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `LLM server unreachable at ${url}: ${msg}. Check llmBaseUrl / llmModel global args.`,
    );
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `LLM request failed (${resp.status} ${resp.statusText}): ${errText.slice(0, 300)}`,
    );
  }

  const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(
      `LLM returned no content: ${JSON.stringify(data).slice(0, 300)}`,
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
// Story clustering (cheap, no LLM)
// ---------------------------------------------------------------------------

const STOP_ENTITIES = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "for", "with",
  "by", "from", "at", "to", "is", "are", "was", "were", "has", "had",
  "have", "will", "would", "could", "should", "may", "might", "can",
  "this", "that", "these", "those", "it", "they", "them", "their", "who",
  "what", "when", "where", "which", "why", "how", "not", "no", "yes",
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
      const shared = entities.filter((e) =>
        bEntities.includes(e)
      ).length;
      const urlMatch = canon === bCanon;
      const sameDay = day !== "" && bDay !== "" && day === bDay;
      const nearDay = day !== "" && bDay !== "" &&
        Math.abs(new Date(day).getTime() - new Date(bDay).getTime()) <= 48 * 3600 * 1000;

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
async function withConcurrency<T>(
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
    return `[${i + 1}] ${a.title} (${src}, ${a.publishedAt || "no date"})\n${a.summary ?? ""}`;
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
    id: cluster.key || clusterHash(topic + "::" + entities.map((e) => e.name).join(",")),
    identity: { topic, entities, seedArticleIds: cluster.articles.map((a) => a.id) },
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
${newArticles.map((a, i) =>
    `[${i + 1}] ${a.title} (${a.source || canonicalUrl(a.url)}, ${a.publishedAt || "no date"})\n${a.summary ?? ""}`
  ).join("\n")}`;

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
  const prompt = `You are a meticulous news fusion engine. Given these established
claims and their cited articles, reconcile to:
1. "coreClaims": array of the strongest consolidated claim strings.
2. "conflicts": array of {claimA, claimB, note} for any unresolved contradictions.
3. "status": confirmed|reported|alleged|unresolved.

Established claims:
- ${existing}

Cited articles:
${story.citations.map((c, i) =>
    `[${i + 1}] ${c.title} (${c.source || canonicalUrl(c.url)}, ${c.publishedAt || "no date"})`
  ).join("\n")}

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
  const core: Claim[] = (parsed.coreClaims ?? story.core.map((c) => c.text)).map(
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
): { deduped: Article[]; newCount: number; reusedCount: number; duplicateCount: number } {
  const prevUrlSet = new Set(prevUrls);
  const newArticles = articles.filter((a) => !prevUrlSet.has(a.url));
  const existingDeduped = prevArticles.filter((a) =>
    articles.some((cur) => cur.url === a.url)
  );

  if (newArticles.length === 0) {
    return { deduped: existingDeduped, newCount: 0, reusedCount: existingDeduped.length, duplicateCount: 0 };
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

/** Render a story to inline HTML for the news page. */
export function renderStories(
  stories: Story[],
  title = "Fused stories",
): string {
  if (stories.length === 0) return "";
  const parts: string[] = [
    `<section class="stories"><h2>${escapeHtml(title)}</h2>`,
  ];
  for (const st of stories) {
    parts.push(`<div class="story">`);
    parts.push(
      `<h3>${escapeHtml(st.identity.topic)} <span class="story-status">${escapeHtml(st.status)}</span></h3>`,
    );
    if (st.conflicts.length > 0) {
      parts.push(`<div class="conflicts"><b>Conflicts:</b>`);
      for (const c of st.conflicts) {
        parts.push(
          `<p class="conflict"><span class="claimA">${escapeHtml(c.claimA.text)}</span> ⚠ <span class="claimB">${escapeHtml(c.claimB.text)}</span> <em>${escapeHtml(c.note)}</em></p>`,
        );
      }
      parts.push(`</div>`);
    }
    parts.push(`<ul class="claims">`);
    for (const c of st.core) {
      parts.push(`<li>${escapeHtml(c.text)} <span class="src-count">(${c.sources.length} src)</span></li>`);
    }
    parts.push(`</ul>`);
    parts.push(`<div class="citations">`);
    for (const c of st.citations) {
      parts.push(
        `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title || c.url)}</a> `,
      );
    }
    parts.push(`</div>`);
    parts.push(`</div>`);
  }
  parts.push(`</section>`);
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
function isFeedBody(contentType: string, body: string): boolean {
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
async function fetchFeed(
  url: string,
  maxArticles: number,
): Promise<{
  articles: Article[];
  error?: string;
  isFeed: boolean;
  contentType: string;
}> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "swamp-news-reader/1.0",
        "Accept":
          "application/rss+xml,application/atom+xml,application/feed+json,application/xml,text/xml,*/*",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      return {
        articles: [],
        error: `HTTP ${resp.status}`,
        isFeed: false,
        contentType: "",
      };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const body = await resp.text();
    const isFeed = isFeedBody(contentType, body);
    const articles = isFeed ? parseFeed(body, url).slice(0, maxArticles) : [];
    for (const a of articles) {
      a.id = await hashId(a.url);
    }
    return { articles, isFeed, contentType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { articles: [], error: msg, isFeed: false, contentType: "" };
  }
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

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

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
<div class="meta">${metaText} · generated <span class="generated-at" data-generated="${escapeHtml(generatedAt)}"></span></div>
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
    const articleJson = JSON.stringify({
      articleId: a.id,
      source: a.source,
      title: a.title.slice(0, 200),
      keywords: a.keywords,
    });

    const isSeen = seenSet.has(a.id);
    const isRead = readSet.has(a.id);
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
<a onclick="sendFeedback('interested',${articleJson},event)" title="👍 interested">👍</a>
<a onclick="sendFeedback('ignored',${articleJson},event)" title="👎 ignore">👎</a>
</span></h3>
<span class="source">${
        escapeHtml(a.source)
      } · <span class="pubdate" data-date="${
        escapeHtml(a.publishedAt)
      }"></span>${
        a.keywords.length > 0
          ? " · " + a.keywords.slice(0, 6).map((kw) =>
            `<span class="keyword">${escapeHtml(kw)}</span>`
          ).join("")
          : ""
      }</span>
<span class="score ${scoreClass}">${scoreLabel} ${a.score}</span>
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

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Model definition for fetching RSS feeds and generating news summaries. */
export const model = {
  type: "@svendowideit/news-reader",
  version: "2026.08.08.1",
  globalArguments: GlobalArgsSchema,
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
      description: "Persistent fused story objects (survive age-filter windows)",
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
            nonFeedUrls:
              (snapshotData as unknown as Record<string, unknown>).nonFeedUrls ?? [],
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
              nonFeedUrls:
                (filteredData as unknown as Record<string, unknown>).nonFeedUrls ?? [],
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
        // Normalize feeds: accept string URLs or feed objects from feed-catalog.
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
              "  2. Add feeds to the feed-catalog model first, then run without --input feeds\n\n" +
              "Usage:\n" +
              "  swamp workflow run news --input 'feeds:json=[\"https://feeds.bbci.co.uk/news/technology/rss.xml\"]'\n\n" +
              "Inputs:\n" +
              "  feeds            string[] or feed objects  RSS/Atom feed URLs (or feed-catalog entries)\n" +
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

        for (const feedUrl of feedUrls) {
          logger?.info("Fetching {url}", { url: feedUrl });
          const result = await fetchFeed(feedUrl, args.maxArticlesPerFeed);
          if (result.error) {
            errors.push({ url: feedUrl, message: result.error });
            logger?.info("Failed: {url} — {error}", {
              url: feedUrl,
              error: result.error,
            });
          } else if (!result.isFeed) {
            nonFeedUrls.push({ url: feedUrl, contentType: result.contentType });
            logger?.info("Not a feed (HTML page or unknown): {url}", {
              url: feedUrl,
              contentType: result.contentType,
            });
          } else {
            allArticles.push(...result.articles);
            logger?.info("Got {n} articles from {url}", {
              n: result.articles.length,
              url: feedUrl,
            });
          }
        }

        logger?.info(
          "Fetched {total} articles total, {errors} errors, {nonFeeds} non-feed URLs",
          {
            total: allArticles.length,
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

        const articles = snapshotData.articles;

        // Incremental: only process new URLs, reuse previously deduped results.
        const prevDeduped = (await context.readResource("dedupedUrls-current") as
          | { urls: string[]; articles: Article[] }
          | null);
        const prevUrlSet = new Set(prevDeduped?.urls ?? []);
        const prevArticles = prevDeduped?.articles ?? [];

        const newArticles = articles.filter((a) => !prevUrlSet.has(a.url));
        const existingDeduped = prevArticles.filter((a) =>
          articles.some((cur) => cur.url === a.url)
        );

        if (newArticles.length === 0) {
          logger?.info(
            "No new article URLs — reusing {n} previously deduped articles",
            { n: existingDeduped.length },
          );
          const handle = await context.writeResource(
            "snapshot",
            "feed-snapshot",
            {
              fetchedAt: snapshotData.fetchedAt,
              articles: existingDeduped,
              errors: snapshotData.errors,
              nonFeedUrls:
                (snapshotData as unknown as Record<string, unknown>).nonFeedUrls ?? [],
            },
          );
          return { dataHandles: [handle] };
        }

        // Dedupe only the new articles.
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

        // Merge: keep previously deduped articles that still exist in the
        // current snapshot, plus newly deduped articles.
        const deduped = [...existingDeduped, ...newDeduped];

        logger?.info(
          "Deduped {total} articles ({new} new, {reused} reused): {duplicates} duplicates across {groups} URL groups",
          {
            total: deduped.length,
            new: newArticles.length,
            reused: existingDeduped.length,
            duplicates: duplicateCount,
            groups: urlGroups.size,
          },
        );

        // Persist the URL set + deduped articles for next run's incremental pass.
        const allUrls = deduped.map((a) => a.url);
        await context.writeResource(
          "dedupedUrls",
          "dedupedUrls-current",
          { urls: allUrls, articles: deduped } as unknown as Record<string, unknown>,
        );

        const handle = await context.writeResource(
          "snapshot",
          "feed-snapshot",
          {
            fetchedAt: snapshotData.fetchedAt,
            articles: deduped,
            errors: snapshotData.errors,
            nonFeedUrls:
              (snapshotData as unknown as Record<string, unknown>).nonFeedUrls ?? [],
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
            nonFeedUrls:
              (snapshotData as unknown as Record<string, unknown>).nonFeedUrls ?? [],
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

        const storiesState = await context.readResource("stories-html-current") as
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

        if (args.outputPath) {
          await Deno.writeTextFile(args.outputPath, html);
          logger?.info("HTML also written to {path}", {
            path: args.outputPath,
          });
        }

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
          c.fingerprint = await computeClusterFingerprint(c, ga.llmModel, ga.llmTemperature);
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
            { stories: storiesState?.stories ?? [] } as unknown as Record<string, unknown>,
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
        const uniqueToSeed = selectClustersToSeed(clusters, existing, args.minClusterSize);
        const newStories: Story[] = [];
        const concurrency = ga.llmConcurrency ?? 3;
        await withConcurrency(uniqueToSeed, concurrency, async (c) => {
          try {
            const st = await seedStory(ga, c);
            newStories.push(st);
            logger?.info("Seeded story '{topic}' ({id})", {
              topic: st.identity.topic,
              id: st.id,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.warning("Seed failed for '{topic}': {error}", {
              topic: c.topic,
              error: msg,
            });
          }
        });
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
            { stories: storiesState?.stories ?? [] } as unknown as Record<string, unknown>,
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

        // Fresh clusters: fuse each into the matching existing story.
        const concurrency = ga.llmConcurrency ?? 3;
        await withConcurrency(clusters, concurrency, async (c) => {
          const st = existingById.get(c.key) ?? existingById.get(
            clusterKey(c.topic, c.entities),
          );
          if (!st) return;
          // Skip if cluster unchanged since last run (same articles + same config).
          const prev = prevByKey.get(c.key);
          if (prev && prev.fingerprint && c.fingerprint &&
              prev.fingerprint === c.fingerprint) {
            logger?.info("Skipping unchanged cluster '{topic}'", { topic: c.topic });
            return;
          }
          try {
            const updated = await fuseStory(ga, st, c.articles);
            toUpdate.push(updated);
            logger?.info("Fused {n} articles into story '{topic}'", {
              n: c.articles.length,
              topic: st.identity.topic,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.warning("Fuse failed for '{topic}': {error}", {
              topic: c.topic,
              error: msg,
            });
          }
        });

        // Absorbable articles already matched an existing story at cluster time;
        // re-match by entity overlap and fuse each one individually.
        // Use cached entities from clusterArticles when available.
        for (const a of absorbable ?? []) {
          const aEntities = a.entities ?? extractEntities(a.title, a.summary ?? "");
          let st: Story | undefined;
          for (const s of stories) {
            const sEntities = s.identity.entities.map((e) => e.name.toLowerCase());
            const shared = aEntities.filter((e) =>
              sEntities.includes(e.toLowerCase())
            ).length;
            if (shared >= 2) {
              st = s;
              break;
            }
          }
          if (!st) continue;
          try {
            const updated = await fuseStory(ga, st, [a]);
            toUpdate.push(updated);
            logger?.info("Absorbed article '{title}' into story '{topic}'", {
              title: a.title,
              topic: st.identity.topic,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.warning("Absorb failed for '{topic}': {error}", {
              topic: st.identity.topic,
              error: msg,
            });
          }
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
            { stories: storiesState?.stories ?? [] } as unknown as Record<string, unknown>,
          );
          return { dataHandles: [handle] };
        }
        const storiesState = await context.readResource("stories-current") as
          | { stories: Story[] }
          | null;
        const stories = storiesState?.stories ?? [];
        const updated: Story[] = [];
        for (const st of stories) {
          try {
            updated.push(await regenStory(ga, st));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger?.warning("Regen failed for '{topic}': {error}", {
              topic: st.identity.topic,
              error: msg,
            });
          }
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
        "Render persistent stories to an inline HTML fragment resource (storiesHtml).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;
        const storiesState = await context.readResource("stories-current") as
          | { stories: Story[] }
          | null;
        const stories = storiesState?.stories ?? [];
        const aged = stories.map((s) =>
          ageOutCitations(s, ga.citationRetentionDays)
        );
        const html = renderStories(aged, "Fused stories");
        const handle = await context.writeResource(
          "storiesHtml",
          "stories-html-current",
          { html } as unknown as Record<string, unknown>,
        );
        logger?.info("Rendered {n} fused stories to storiesHtml", {
          n: aged.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
  reports: ["@svendowideit/news-html-report"],
};
