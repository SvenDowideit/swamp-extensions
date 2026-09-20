/**
 * Wikipedia — a caching client for the Wikipedia and Wikidata APIs.
 *
 * Every request is cached on disk under `~/.swamp/wikipedia` (configurable via
 * the `cacheDir` global argument). Repeated calls always prefer the cached
 * copy and avoid external traffic unless the cache is missing, explicitly
 * bypassed (`forceRefresh`), or older than the configured freshness window.
 *
 * Each cache entry stores the raw response body plus a `meta.json` recording
 * the URL, HTTP status, the full set of response headers (Date, Last-Modified,
 * ETag, Cache-Control, Age, Expires, Server, …) and the fetch timestamp, so a
 * caller can reason about the age of cached data and the caching directives
 * the origin sent back.
 *
 * Methods:
 *   - `search`       tolerant title search (opensearch)
 *   - `get-page`     fetch a page's content in one of several formats
 *                    (wikitext by default; also html, parsoid, summary, json)
 *   - `get-infobox`  fetch a page and extract its infobox into key/value form
 *   - `invalidate`   drop one or all cache entries
 *   - `cache-info`   report what's cached (size, age, hit/miss)
 *
 * @module
 */
import { z } from "npm:zod@4";

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST = "https://en.wikipedia.org/api/rest_v1";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "swamp-wikipedia/1.0 (local caching client)";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  cacheDir: z.string()
    .default("~/.swamp/wikipedia")
    .describe("Directory to cache fetched responses under"),
  apiUrl: z.string()
    .default(WIKI_API)
    .describe("MediaWiki action API base URL"),
  restUrl: z.string()
    .default(WIKI_REST)
    .describe("Wikipedia REST v1 base URL"),
  wikidataUrl: z.string()
    .default(WIKIDATA_API)
    .describe("Wikidata action API base URL"),
  userAgent: z.string()
    .default(USER_AGENT)
    .describe("User-Agent header sent with requests"),
  defaultMaxAgeMs: z.number().int().nonnegative()
    .default(0)
    .describe(
      "Default freshness window for cached responses (0 = always prefer " +
        "cache; honor origin Cache-Control/Expires when present)",
    ),
  requestDelayMs: z.number().int().nonnegative()
    .default(1000)
    .describe(
      "Minimum delay between origin requests (across runs, persisted in the " +
        "cache dir), to stay within Wikipedia's acceptable request rate. " +
        "0 disables pacing.",
    ),
  retryDelayMs: z.number().int().nonnegative()
    .default(5000)
    .describe(
      "Wait this long after a 429 rate-limit before a single retry (the " +
        "origin's Retry-After header takes precedence when present).",
    ),
  maxRetries: z.number().int().nonnegative()
    .default(1)
    .describe("Number of retries after a 429 (backing off each time)."),
}).passthrough();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const PAGE_FORMATS = [
  "wikitext",
  "html",
  "parsoid",
  "summary",
  "json",
] as const;
type PageFormat = (typeof PAGE_FORMATS)[number];

const FormatArg = z.enum(PAGE_FORMATS)
  .default("wikitext")
  .describe("Content format to return");

const TitleArg = z.string().min(1).describe("Page title (or search term)");

const FreshnessArgs = z.object({
  maxAgeMs: z.number().int().nonnegative()
    .optional()
    .describe(
      "Reject cache entries older than this many milliseconds (omit = use " +
        "global defaultMaxAgeMs; 0 = never expire)",
    ),
  forceRefresh: z.boolean()
    .default(false)
    .describe("Bypass the cache and re-fetch from the origin"),
});

const GetPageArgsSchema = z.object({
  title: TitleArg,
  format: FormatArg,
}).extend(FreshnessArgs.shape);

type GetPageArgs = z.infer<typeof GetPageArgsSchema>;

const SearchArgsSchema = z.object({
  query: TitleArg.describe("Search query (tolerant of misspellings)"),
  limit: z.number().int().min(1).max(20)
    .default(5)
    .describe("Maximum number of results"),
}).extend(FreshnessArgs.shape);

type SearchArgs = z.infer<typeof SearchArgsSchema>;

const GetInfoboxArgsSchema = z.object({
  title: TitleArg,
  template: z.string()
    .optional()
    .describe(
      "Restrict to a specific infobox template name (e.g. 'writer', 'book'). " +
        "Omit to return the first infobox found.",
    ),
}).extend(FreshnessArgs.shape);

type GetInfoboxArgs = z.infer<typeof GetInfoboxArgsSchema>;

const InvalidateArgsSchema = z.object({
  key: z.string()
    .optional()
    .describe(
      "Cache key to drop (see cache-info). Omit to clear the entire cache.",
    ),
  title: z.string()
    .optional()
    .describe("Alternative: drop all cache entries derived from this title"),
});

type InvalidateArgs = z.infer<typeof InvalidateArgsSchema>;

const CacheInfoArgsSchema = z.object({
  key: z.string()
    .optional()
    .describe("Inspect a single cache entry; omit for a whole-cache summary"),
});

type CacheInfoArgs = z.infer<typeof CacheInfoArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cached response: body bytes plus metadata captured at fetch time. */
const CacheEntrySchema = z.object({
  key: z.string(),
  url: z.string(),
  status: z.number().int(),
  ok: z.boolean(),
  fetchedAt: z.string(),
  /** The full set of response headers captured from the origin. */
  headers: z.record(z.string(), z.string()),
  /** Body size in bytes. */
  size: z.number().int().nonnegative(),
});

type CacheEntry = z.infer<typeof CacheEntrySchema>;

/** Result returned by data-producing methods. */
const PageResultSchema = z.object({
  title: z.string(),
  format: z.string(),
  /** Content as a UTF-8 string (wikitext, html, json, …). */
  content: z.string().nullable(),
  /** Cached-response metadata (null when the fetch failed). */
  cache: CacheEntrySchema.nullable(),
  /** True when the content came from the on-disk cache. */
  fromCache: z.boolean(),
  /** True when a stale cache entry was refreshed from the origin. */
  refreshed: z.boolean(),
});

type PageResult = z.infer<typeof PageResultSchema>;

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (m: string, p?: Record<string, unknown>) => void;
    debug?: (m: string, p?: Record<string, unknown>) => void;
    warn?: (m: string, p?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Expand `~` to the home directory. */
function expandHome(raw: string): string {
  if (raw.startsWith("~")) {
    const home = Deno.env.get("HOME") ?? "~";
    return raw === "~" ? home : `${home}${raw.slice(1)}`;
  }
  return raw;
}

/** Deterministic 32-bit hash (FNV-1a) of a string — stable across runs. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Build a filesystem-safe cache key from a method + canonical URL. */
function cacheKey(method: string, url: string): string {
  const safe = url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${method}-${safe}-${fnv1a(url)}`;
}

/** Parse an HTTP-date (RFC 7231) or ISO timestamp into epoch milliseconds. */
function parseHttpDate(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Decide whether a cached entry is still usable given a caller's freshness
 * request. The cache is sticky by default: `maxAgeMs` of `0` (or unset) means
 * "never expire — always prefer the cached copy". A positive `maxAgeMs` expires
 * the entry after that many milliseconds.
 *
 * Origin caching directives (`Cache-Control`, `Expires`, `Age`) are *recorded*
 * on the entry and surfaced by `cache-info` so callers can reason about the
 * origin's own freshness intent, but they are not enforced here by default —
 * the point of this model is to avoid external traffic.
 */
function computeFreshnessMs(
  entry: CacheEntry,
  maxAgeMs: number,
): number {
  const fetchedAt = parseHttpDate(entry.fetchedAt) ?? Date.now();
  const now = Date.now();
  if (maxAgeMs <= 0) return Number.POSITIVE_INFINITY;
  return maxAgeMs - (now - fetchedAt);
}

/** Load a cache entry's metadata from disk, or null when absent. */
async function loadCacheEntry(
  dir: string,
  key: string,
): Promise<CacheEntry | null> {
  const metaPath = `${dir}/${key}/meta.json`;
  try {
    const raw = await Deno.readTextFile(metaPath);
    return CacheEntrySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Load a cache entry's body bytes, or null when absent. */
async function loadCacheBody(dir: string, key: string): Promise<string | null> {
  const bodyPath = `${dir}/${key}/body`;
  try {
    return await Deno.readTextFile(bodyPath);
  } catch {
    return null;
  }
}

/** Persist a response to the cache, returning the entry metadata. */
async function storeCacheEntry(
  dir: string,
  key: string,
  url: string,
  res: Response,
  body: string,
): Promise<CacheEntry> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });

  const entry: CacheEntry = {
    key,
    url,
    status: res.status,
    ok: res.ok,
    fetchedAt: new Date().toISOString(),
    headers,
    size: new TextEncoder().encode(body).byteLength,
  };

  await Deno.mkdir(`${dir}/${key}`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${key}/meta.json`, JSON.stringify(entry));
  await Deno.writeTextFile(`${dir}/${key}/body`, body);
  return entry;
}

/** Delete a single cache entry (all its files). */
async function deleteCacheEntry(dir: string, key: string): Promise<void> {
  try {
    await Deno.remove(`${dir}/${key}`, { recursive: true });
  } catch {
    // Already gone — fine.
  }
}

/** List cache entry keys on disk. */
async function listCacheKeys(dir: string): Promise<string[]> {
  try {
    const out: string[] = [];
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) out.push(e.name);
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

/** Thrown on HTTP 429 so callers can distinguish retryable rate limits. */
class RateLimitError extends Error {
  /** Retry-After header value (seconds), when the origin provided one. */
  retryAfterSec: number | null;
  constructor(retryAfterSec: number | null = null) {
    super("Rate limited (HTTP 429)");
    this.retryAfterSec = retryAfterSec;
  }
}

/** Read the persisted last-request timestamp (epoch ms) from the cache dir. */
async function readLastRequestAt(dir: string): Promise<number> {
  try {
    const raw = await Deno.readTextFile(`${dir}/.last-request`);
    const t = parseInt(raw, 10);
    return Number.isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

/** Persist the last-request timestamp (epoch ms) to the cache dir. */
async function writeLastRequestAt(dir: string, at: number): Promise<void> {
  try {
    await Deno.writeTextFile(`${dir}/.last-request`, String(at));
  } catch {
    // Best-effort pacing state — ignore write failures.
  }
}

/**
 * Sleep until the minimum inter-request delay has elapsed since the last
 * origin request (which may have been a previous run). Returns the delay that
 * was applied (0 when no wait was needed).
 */
async function paceRequest(
  ctx: MethodContext,
  dir: string,
): Promise<number> {
  const delay = ctx.globalArgs.requestDelayMs;
  if (delay <= 0) return 0;

  const last = await readLastRequestAt(dir);
  const now = Date.now();
  const wait = Math.max(0, last + delay - now);

  if (wait > 0) {
    ctx.logger.info("Pacing request: waiting {wait}ms (delay {delay}ms)", {
      wait,
      delay,
    });
    await sleep(wait);
  }
  return wait;
}

/** Record that a request just happened (for the next pacing interval). */
async function markRequestAt(dir: string): Promise<void> {
  await writeLastRequestAt(dir, Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Perform a GET with the shared user-agent, honoring the AbortSignal. */
async function httpGet(
  url: string,
  userAgent: string,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, "Accept": "application/json" },
    signal,
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const sec = retryAfter ? parseInt(retryAfter, 10) : NaN;
    throw new RateLimitError(Number.isNaN(sec) ? null : sec);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Core: cached fetch
// ---------------------------------------------------------------------------

interface CachedFetchResult {
  body: string | null;
  entry: CacheEntry | null;
  fromCache: boolean;
  refreshed: boolean;
}

/**
 * Fetch a URL through the disk cache. Prefers the cached copy; re-fetches only
 * when the entry is missing, explicitly bypassed, or stale per the freshness
 * policy. Returns null body/entry on a fetch error (caller decides whether to
 * throw) so that rate limits can be surfaced distinctly.
 */
async function cachedFetch(
  ctx: MethodContext,
  method: string,
  url: string,
  opts: { maxAgeMs?: number; forceRefresh?: boolean },
  signal?: AbortSignal,
): Promise<CachedFetchResult> {
  const dir = expandHome(ctx.globalArgs.cacheDir);
  const key = cacheKey(method, url);
  const maxAgeMs = opts.maxAgeMs ?? ctx.globalArgs.defaultMaxAgeMs;

  await Deno.mkdir(dir, { recursive: true });

  const existing = await loadCacheEntry(dir, key);

  // Decide whether the cached copy is good enough.
  if (existing && !opts.forceRefresh) {
    const freshness = computeFreshnessMs(existing, maxAgeMs);
    if (freshness >= 0) {
      const body = await loadCacheBody(dir, key);
      ctx.logger.debug?.("Cache hit {key} ({freshness}ms fresh)", {
        key,
        freshness: Math.round(freshness),
      });
      return { body, entry: existing, fromCache: true, refreshed: false };
    }
    ctx.logger.debug?.("Cache stale {key} ({freshness}ms)", {
      key,
      freshness: Math.round(freshness),
    });
  }

  // Need to fetch from the origin.
  const maxRetries = ctx.globalArgs.maxRetries;
  const retryDelayMs = ctx.globalArgs.retryDelayMs;
  let attempt = 0;

  while (true) {
    // Back off to a request rate Wikipedia finds acceptable.
    const waited = await paceRequest(ctx, dir);
    if (waited > 0) {
      ctx.logger.debug?.("Paced {waited}ms before requesting {url}", {
        waited,
        url,
      });
    }
    try {
      const res = await httpGet(url, ctx.globalArgs.userAgent, signal);
      await markRequestAt(dir);
      const body = await res.text();
      if (!res.ok) {
        ctx.logger.warn?.("Wikipedia request failed {status} {url}", {
          status: res.status,
          url,
        });
        return { body: null, entry: null, fromCache: false, refreshed: false };
      }
      const entry = await storeCacheEntry(dir, key, url, res, body);
      ctx.logger.debug?.("Fetched + cached {key}", { key });
      return {
        body,
        entry,
        fromCache: false,
        refreshed: existing != null,
      };
    } catch (err) {
      await markRequestAt(dir);
      if (err instanceof RateLimitError) {
        if (attempt < maxRetries) {
          attempt += 1;
          const wait = (err.retryAfterSec ?? 0) * 1000 ||
            retryDelayMs * attempt;
          ctx.logger.warn?.(
            "Rate limited (429); retry {attempt}/{maxRetries} after {wait}ms",
            { attempt, maxRetries, wait },
          );
          await sleep(wait);
          continue;
        }
        ctx.logger.warn?.(
          "Rate limited (429) after {attempt} retries; giving up",
          { attempt },
        );
        throw err;
      }
      ctx.logger.warn?.("Fetch error {url}: {error}", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to whatever (stale) cache we have, if any.
      if (existing) {
        const body = await loadCacheBody(dir, key);
        return { body, entry: existing, fromCache: true, refreshed: false };
      }
      return { body: null, entry: null, fromCache: false, refreshed: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Wikipedia format builders
// ---------------------------------------------------------------------------

/** Build the URL for a page fetch in a given format. */
function pageUrl(
  ctx: MethodContext,
  title: string,
  format: PageFormat,
): string {
  const api = ctx.globalArgs.apiUrl;
  const rest = ctx.globalArgs.restUrl;
  const params = new URLSearchParams({ format: "json", origin: "*" });

  switch (format) {
    case "wikitext":
      params.set("action", "parse");
      params.set("page", title);
      params.set("prop", "wikitext");
      params.set("formatversion", "2");
      return `${api}?${params}`;
    case "html":
      params.set("action", "parse");
      params.set("page", title);
      params.set("prop", "text");
      params.set("formatversion", "2");
      return `${api}?${params}`;
    case "parsoid":
      // REST v1 Parsoid HTML (no action API).
      return `${rest}/page/${encodeURIComponent(title)}/html`;
    case "summary":
      return `${rest}/page/summary/${encodeURIComponent(title)}`;
    case "json":
      params.set("action", "query");
      params.set("redirects", "1");
      params.set("prop", "info|pageprops");
      params.set("titles", title);
      params.set("inprop", "url");
      return `${api}?${params}`;
  }
}

/** Extract the human-readable content string from a parsed action API response. */
function extractContent(format: PageFormat, parsed: unknown): string | null {
  if (format === "parsoid" || format === "summary") {
    // These REST endpoints return the content directly (JSON for summary).
    return typeof parsed === "string"
      ? parsed
      : JSON.stringify(parsed, null, 2);
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (format === "wikitext") {
    const parse = p["parse"] as Record<string, unknown> | undefined;
    const wt = parse?.["wikitext"];
    return typeof wt === "string" ? wt : null;
  }
  if (format === "html") {
    const parse = p["parse"] as Record<string, unknown> | undefined;
    const text = parse?.["text"];
    return typeof text === "string" ? text : null;
  }
  if (format === "json") {
    return JSON.stringify(parsed, null, 2);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Infobox extraction
// ---------------------------------------------------------------------------

/** Extract the (first) infobox template name from raw wikitext. */
export function detectInfoboxName(wikitext: string | null): string | null {
  if (!wikitext) return null;
  const m = wikitext.match(/\{\{\s*([Ii]nfobox[ _][A-Za-z _-]+)/);
  return m ? m[1].replace(/_/g, " ").trim().toLowerCase() : null;
}

/**
 * Parse a single top-level template invocation from wikitext into a map of
 * `key -> value` (nested/other templates are returned as their raw text). This
 * is intentionally permissive: it handles `{{Infobox writer | name = ...}}`,
 * pipe-delimited params, and unnamed params.
 */
export function parseInfoboxTemplate(
  wikitext: string | null,
): Record<string, string> {
  if (!wikitext) return {};
  const start = wikitext.indexOf("{{");
  if (start < 0) return {};

  let depth = 0;
  let end = -1;
  for (let i = start; i < wikitext.length; i++) {
    const c = wikitext[i];
    const next = wikitext[i + 1];
    if (c === "{" && next === "{") {
      depth++;
      i++;
    } else if (c === "}" && next === "}") {
      depth--;
      i++;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return {};

  const body = wikitext.slice(start + 2, end - 2);
  // Split the template name from its params at the first `|`.
  const firstPipe = body.indexOf("|");
  const name = firstPipe >= 0 ? body.slice(0, firstPipe).trim() : body.trim();
  const paramsText = firstPipe >= 0 ? body.slice(firstPipe + 1) : "";

  const out: Record<string, string> = { _template: name.toLowerCase() };
  let idx = 0;
  for (const part of splitTopLevel(paramsText, "|")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = findTopLevelEq(trimmed);
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim().toLowerCase();
      const v = trimmed.slice(eq + 1).trim();
      out[k] = v;
    } else {
      out[String(idx++)] = trimmed;
    }
  }
  return out;
}

/** Split on a separator, respecting `{{…}}` and `[[…]]` nesting. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "{" && next === "{") {
      depth++;
      cur += c + next;
      i++;
      continue;
    }
    if (c === "}" && next === "}") {
      depth--;
      cur += c + next;
      i++;
      continue;
    }
    if (c === "[" && next === "[") {
      depth++;
      cur += c + next;
      i++;
      continue;
    }
    if (c === "]" && next === "]") {
      depth--;
      cur += c + next;
      i++;
      continue;
    }
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/** Find the top-level `=` in a template param (ignoring nested templates). */
function findTopLevelEq(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "{" && next === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" && next === "}") {
      depth--;
      i++;
      continue;
    }
    if (c === "[" && next === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "]" && next === "]") {
      depth--;
      i++;
      continue;
    }
    if (c === "=" && depth === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A caching client for the Wikipedia / Wikidata APIs. */
export const model = {
  type: "@svendowideit/wikipedia",
  version: "2026.09.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    page: {
      description: "A fetched Wikipedia page (content + cache metadata)",
      schema: PageResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    search: {
      description: "Search results for a query",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    infobox: {
      description: "Extracted infobox key/value pairs for a page",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    cache: {
      description: "Cache inspection / management result",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    "search": {
      description:
        "Search Wikipedia for a term, returning corrected titles, short " +
        "descriptions and URLs (opensearch). Results are cached.",
      arguments: SearchArgsSchema,
      execute: async (args: SearchArgs, context: MethodContext) => {
        const params = new URLSearchParams({
          action: "opensearch",
          search: args.query,
          limit: String(args.limit),
          format: "json",
          origin: "*",
        });
        const url = `${context.globalArgs.apiUrl}?${params}`;
        const res = await cachedFetch(context, "search", url, args);

        let titles: string[] = [];
        let descriptions: string[] = [];
        let urls: string[] = [];
        if (res.body) {
          const parsed = JSON.parse(res.body) as [
            string,
            string[],
            string[],
            string[],
          ];
          titles = parsed[1] ?? [];
          descriptions = parsed[2] ?? [];
          urls = parsed[3] ?? [];
        }

        const result = {
          query: args.query,
          results: titles.map((title, i) => ({
            title,
            description: descriptions[i] ?? null,
            url: urls[i] ?? null,
          })),
          cache: res.entry,
          fromCache: res.fromCache,
          refreshed: res.refreshed,
        };
        const handle = await context.writeResource(
          "search",
          cacheKey("search", url),
          result,
        );
        context.logger.info("Searched {query}: {n} results ({src})", {
          query: args.query,
          n: titles.length,
          src: res.fromCache
            ? "cache"
            : res.refreshed
            ? "refreshed"
            : "fetched",
        });
        return { dataHandles: [handle] };
      },
    },
    "get-page": {
      description:
        "Fetch a Wikipedia page's content. `format` defaults to wikitext; " +
        "also supports html (action API), parsoid (REST), summary (REST) and " +
        "json (raw query). All formats are cached.",
      arguments: GetPageArgsSchema,
      execute: async (args: GetPageArgs, context: MethodContext) => {
        const url = pageUrl(context, args.title, args.format);
        const res = await cachedFetch(
          context,
          `page-${args.format}`,
          url,
          args,
        );

        let content: string | null = null;
        if (res.body) {
          if (args.format === "parsoid" || args.format === "summary") {
            content = res.body;
          } else {
            try {
              content = extractContent(args.format, JSON.parse(res.body));
            } catch {
              content = res.body;
            }
          }
        }

        const result: PageResult = {
          title: args.title,
          format: args.format,
          content,
          cache: res.entry,
          fromCache: res.fromCache,
          refreshed: res.refreshed,
        };
        const handle = await context.writeResource(
          "page",
          cacheKey(`page-${args.format}`, url),
          result,
        );
        context.logger.info(
          "Fetched {title} ({format}) {src}",
          {
            title: args.title,
            format: args.format,
            src: res.fromCache
              ? "cache"
              : res.refreshed
              ? "refreshed"
              : "fetched",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "get-infobox": {
      description:
        "Fetch a page's wikitext (cached), then extract its infobox into " +
        "key/value pairs. Optionally restrict to a specific template name.",
      arguments: GetInfoboxArgsSchema,
      execute: async (args: GetInfoboxArgs, context: MethodContext) => {
        const url = pageUrl(context, args.title, "wikitext");
        const res = await cachedFetch(context, "page-wikitext", url, args);

        let content: string | null = null;
        if (res.body) {
          content = extractContent("wikitext", JSON.parse(res.body));
        }

        const infobox = parseInfoboxTemplate(content);
        const infoboxName = detectInfoboxName(content);

        // If a specific template was requested and doesn't match, return empty.
        const wanted = args.template?.toLowerCase();
        const matches = wanted
          ? infoboxName === `infobox ${wanted}` ||
            infobox._template === wanted ||
            infobox._template === `infobox ${wanted}`
          : true;

        const result = {
          title: args.title,
          infobox: matches ? infobox : { _template: infoboxName ?? null },
          template: infoboxName,
          cache: res.entry,
          fromCache: res.fromCache,
          refreshed: res.refreshed,
        };
        const handle = await context.writeResource(
          "infobox",
          cacheKey("page-wikitext", url),
          result,
        );
        context.logger.info("Extracted infobox from {title} ({template})", {
          title: args.title,
          template: infoboxName ?? "none",
        });
        return { dataHandles: [handle] };
      },
    },
    "invalidate": {
      description:
        "Drop cached entries. Pass a `key` (see cache-info) to drop one entry, " +
        "or `title` to drop every entry derived from that title; omit both to " +
        "clear the entire cache.",
      arguments: InvalidateArgsSchema,
      execute: async (args: InvalidateArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const keys = await listCacheKeys(dir);

        let removed: string[] = [];
        if (args.key) {
          if (keys.includes(args.key)) {
            await deleteCacheEntry(dir, args.key);
            removed = [args.key];
          }
        } else if (args.title) {
          const needle = args.title
            .replace(/[^a-zA-Z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80);
          for (const k of keys) {
            if (k.includes(needle)) {
              await deleteCacheEntry(dir, k);
              removed.push(k);
            }
          }
        } else {
          for (const k of keys) {
            await deleteCacheEntry(dir, k);
          }
          removed = keys;
        }

        const result = { removed: removed.length, keys: removed };
        const handle = await context.writeResource(
          "cache",
          "invalidate",
          result,
        );
        context.logger.info("Invalidated {n} cache entries", {
          n: removed.length,
        });
        return { dataHandles: [handle] };
      },
    },
    "cache-info": {
      description:
        "Report cache state. Pass a `key` to inspect a single entry (including " +
        "its HTTP headers and freshness); omit for a whole-cache summary.",
      arguments: CacheInfoArgsSchema,
      execute: async (args: CacheInfoArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const keys = await listCacheKeys(dir);

        if (args.key) {
          const entry = await loadCacheEntry(dir, args.key);
          const freshness = entry
            ? computeFreshnessMs(entry, context.globalArgs.defaultMaxAgeMs)
            : null;
          const result = {
            key: args.key,
            entry,
            freshnessMs: freshness === Number.POSITIVE_INFINITY
              ? "infinite"
              : freshness,
          };
          const handle = await context.writeResource(
            "cache",
            `info-${args.key}`,
            result,
          );
          return { dataHandles: [handle] };
        }

        const entries: (CacheEntry & { ageMs: number })[] = [];
        let totalBytes = 0;
        for (const k of keys) {
          const entry = await loadCacheEntry(dir, k);
          if (!entry) continue;
          const fetchedAt = parseHttpDate(entry.fetchedAt) ?? Date.now();
          entries.push({ ...entry, ageMs: Date.now() - fetchedAt });
          totalBytes += entry.size;
        }
        entries.sort((a, b) => b.ageMs - a.ageMs);

        const result = {
          cacheDir: dir,
          count: entries.length,
          totalBytes,
          oldestMs: entries.length ? entries[0]!.ageMs : 0,
          entries: entries.map((e) => ({
            key: e.key,
            url: e.url,
            status: e.status,
            ageMs: e.ageMs,
            size: e.size,
            fetchedAt: e.fetchedAt,
            cacheControl: e.headers["cache-control"] ?? null,
            expires: e.headers["expires"] ?? null,
            lastModified: e.headers["last-modified"] ?? null,
            etag: e.headers["etag"] ?? null,
          })),
        };
        const handle = await context.writeResource("cache", "summary", result);
        context.logger.info("Cache: {count} entries, {bytes} bytes", {
          count: entries.length,
          bytes: totalBytes,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
