/**
 * Web cache — a disk-backed HTTP GET cache with pacing and retry.
 *
 * This is a *managed resource*: every GET is cached on disk (body plus the full
 * set of response headers) under a shared cache directory (default
 * `~/.swamp/web-cache`), keyed deterministically by URL. Repeated calls always
 * prefer the cached copy and make no network request unless the entry is
 * missing, explicitly bypassed (`forceRefresh`), or stale.
 *
 * Origin requests are paced with a tunable minimum delay persisted across runs,
 * and HTTP 429 responses are retried with backoff, so bulk use stays within the
 * origin's acceptable request rate.
 *
 * Because it owns the cache, other models (e.g. `@svendowideit/wikipedia`) can
 * *read* entries it has written from the shared directory, and this model is
 * the single place to `invalidate` or inspect (`cache-info`) the cache.
 *
 * Methods:
 *   - `get`          fetch a URL and return the raw body
 *   - `get-json`     fetch a URL and return the parsed JSON body
 *   - `invalidate`   drop one entry, one URL, or the whole cache
 *   - `cache-info`   report cache size, age, freshness, and stored headers
 *
 * @module
 */
import { z } from "npm:zod@4";

const USER_AGENT = "swamp-web-cache/1.0 (local caching client)";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  cacheDir: z.string()
    .default("~/.swamp/web-cache")
    .describe("Directory to cache fetched responses under"),
  userAgent: z.string()
    .default(USER_AGENT)
    .describe("User-Agent header sent with requests"),
  defaultMaxAgeMs: z.number().int().nonnegative()
    .default(0)
    .describe(
      "Default freshness window for cached responses (0 = always prefer the " +
        "cache; a positive value expires entries after that many ms)",
    ),
  requestDelayMs: z.number().int().nonnegative()
    .default(1000)
    .describe(
      "Minimum delay between origin requests (across runs, persisted in the " +
        "cache dir). 0 disables pacing.",
    ),
  retryDelayMs: z.number().int().nonnegative()
    .default(5000)
    .describe(
      "Wait this long after a 429 rate-limit before a retry (the origin's " +
        "Retry-After header takes precedence when present).",
    ),
  maxRetries: z.number().int().nonnegative()
    .default(1)
    .describe("Number of retries after a 429 (backing off each time)."),
  acceptHeader: z.string()
    .default("application/json")
    .describe("Accept header sent with requests"),
}).passthrough();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const UrlArg = z.string().url().describe("Full URL to fetch");

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

const GetArgsSchema = z.object({ url: UrlArg }).extend(FreshnessArgs.shape);
type GetArgs = z.infer<typeof GetArgsSchema>;

const GetJsonArgsSchema = z.object({ url: UrlArg }).extend(FreshnessArgs.shape);
type GetJsonArgs = z.infer<typeof GetJsonArgsSchema>;

const InvalidateArgsSchema = z.object({
  key: z.string()
    .optional()
    .describe("Cache key to drop (see cache-info). Omit to clear everything."),
  url: z.string()
    .optional()
    .describe("Alternative: drop the cache entry for this URL"),
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

/** A cached response: body plus metadata captured at fetch time. */
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

/** Result of a get / get-json. */
const FetchResultSchema = z.object({
  url: z.string(),
  key: z.string(),
  /** Raw response body as UTF-8 (or null on failure). */
  body: z.string().nullable(),
  status: z.number().int().nullable(),
  headers: z.record(z.string(), z.string()),
  fromCache: z.boolean(),
  refreshed: z.boolean(),
});

type FetchResult = z.infer<typeof FetchResultSchema>;

/** Result of get-json (body parsed as JSON). */
const JsonResultSchema = z.object({
  url: z.string(),
  key: z.string(),
  /** Parsed JSON (or null when the body isn't valid JSON / the fetch failed). */
  json: z.unknown(),
  status: z.number().int().nullable(),
  fromCache: z.boolean(),
  refreshed: z.boolean(),
});

type JsonResult = z.infer<typeof JsonResultSchema>;

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
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonicalize a URL so that two spellings of the same resource produce the
 * same cache key. This makes the cache key insensitive to:
 *   - query-parameter ordering (`?a=1&b=2` == `?b=2&a=1`),
 *   - scheme/host case and default ports (`:80`/`:443`),
 *   - the fragment (never sent to the origin),
 *   - `+` vs `%20` in query values (normalized via URLSearchParams).
 *
 * This MUST stay byte-for-byte identical to `@svendowideit/wikipedia`'s
 * `normalizeUrl` — both models derive the same cache key from the same URL.
 */
export function normalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Not parseable — fall back to the raw string so we still cache it.
    return url;
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if (u.protocol === "http:" && u.port === "80") u.port = "";
  if (u.protocol === "https:" && u.port === "443") u.port = "";
  u.hash = "";

  const entries = [...u.searchParams.entries()].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : 1;
  });
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.append(k, v);
  u.search = sp.toString();

  return u.toString();
}

/**
 * Build the filesystem-safe cache key for a URL. This is the canonical key
 * shared across models that read this cache — it depends only on the
 * normalized URL, so any model that knows the URL can locate the entry.
 */
export function webCacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  const safe = normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe}-${fnv1a(normalized)}`;
}

/** Parse an HTTP-date (RFC 7231) or ISO timestamp into epoch milliseconds. */
function parseHttpDate(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Decide whether a cached entry is still usable. Sticky by default: `maxAgeMs`
 * of `0` (or unset) means "never expire". A positive `maxAgeMs` expires the
 * entry after that many milliseconds. Origin caching directives are *recorded*
 * on the entry and surfaced by `cache-info`, but not enforced here by default —
 * the point is to avoid external traffic.
 */
function computeFreshnessMs(entry: CacheEntry, maxAgeMs: number): number {
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
  try {
    const raw = await Deno.readTextFile(`${dir}/${key}/meta.json`);
    return CacheEntrySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Load a cache entry's body from disk, or null when absent. */
async function loadCacheBody(dir: string, key: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${dir}/${key}/body`);
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
 * Sleep until the minimum inter-request delay has elapsed since the last origin
 * request (which may have been a previous run). Returns the delay applied.
 */
async function paceRequest(ctx: MethodContext, dir: string): Promise<number> {
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
  accept: string,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, "Accept": accept },
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

/**
 * Fetch a URL through the disk cache. Prefers the cached copy; re-fetches only
 * when missing, bypassed, or stale. Returns null body on failure.
 */
async function cachedFetch(
  ctx: MethodContext,
  url: string,
  opts: { maxAgeMs?: number; forceRefresh?: boolean },
  signal?: AbortSignal,
): Promise<
  {
    body: string | null;
    entry: CacheEntry | null;
    fromCache: boolean;
    refreshed: boolean;
  }
> {
  const dir = expandHome(ctx.globalArgs.cacheDir);
  const key = webCacheKey(url);
  const maxAgeMs = opts.maxAgeMs ?? ctx.globalArgs.defaultMaxAgeMs;

  await Deno.mkdir(dir, { recursive: true });

  const existing = await loadCacheEntry(dir, key);

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

  const maxRetries = ctx.globalArgs.maxRetries;
  const retryDelayMs = ctx.globalArgs.retryDelayMs;
  let attempt = 0;

  while (true) {
    const waited = await paceRequest(ctx, dir);
    if (waited > 0) {
      ctx.logger.debug?.("Paced {waited}ms before requesting {url}", {
        waited,
        url,
      });
    }
    try {
      const res = await httpGet(
        url,
        ctx.globalArgs.userAgent,
        ctx.globalArgs.acceptHeader,
        signal,
      );
      await markRequestAt(dir);
      const body = await res.text();
      if (!res.ok) {
        ctx.logger.warn?.("Request failed {status} {url}", {
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
      if (existing) {
        const body = await loadCacheBody(dir, key);
        return { body, entry: existing, fromCache: true, refreshed: false };
      }
      return { body: null, entry: null, fromCache: false, refreshed: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A managed, disk-backed HTTP GET cache with pacing and retry. */
export const model = {
  type: "@svendowideit/web-cache",
  version: "2026.09.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    fetch: {
      description: "Result of a get (raw body, headers, cache state)",
      schema: FetchResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    json: {
      description: "Result of a get-json (parsed JSON, cache state)",
      schema: JsonResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    cache: {
      description: "Cache inspection / invalidation result",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    "get": {
      description:
        "Fetch a URL and return its raw body (UTF-8). Cached on disk; " +
        "prefers the cache unless bypassed or stale.",
      arguments: GetArgsSchema,
      execute: async (args: GetArgs, context: MethodContext) => {
        const res = await cachedFetch(context, args.url, args);
        const result: FetchResult = {
          url: args.url,
          key: webCacheKey(args.url),
          body: res.body,
          status: res.entry?.status ?? null,
          headers: res.entry?.headers ?? {},
          fromCache: res.fromCache,
          refreshed: res.refreshed,
        };
        const handle = await context.writeResource(
          "fetch",
          webCacheKey(args.url),
          result,
        );
        context.logger.info("GET {url} ({src})", {
          url: args.url,
          src: res.fromCache
            ? "cache"
            : res.refreshed
            ? "refreshed"
            : "fetched",
        });
        return { dataHandles: [handle] };
      },
    },
    "get-json": {
      description:
        "Fetch a URL and return its body parsed as JSON. Cached on disk.",
      arguments: GetJsonArgsSchema,
      execute: async (args: GetJsonArgs, context: MethodContext) => {
        const res = await cachedFetch(context, args.url, args);
        let json: unknown = null;
        if (res.body) {
          try {
            json = JSON.parse(res.body);
          } catch {
            json = null;
          }
        }
        const result: JsonResult = {
          url: args.url,
          key: webCacheKey(args.url),
          json,
          status: res.entry?.status ?? null,
          fromCache: res.fromCache,
          refreshed: res.refreshed,
        };
        const handle = await context.writeResource(
          "json",
          webCacheKey(args.url),
          result,
        );
        context.logger.info("GET JSON {url} ({src})", {
          url: args.url,
          src: res.fromCache
            ? "cache"
            : res.refreshed
            ? "refreshed"
            : "fetched",
        });
        return { dataHandles: [handle] };
      },
    },
    "invalidate": {
      description:
        "Drop cached entries. Pass a `key` (see cache-info) to drop one entry, " +
        "or `url` to drop the entry for that URL; omit both to clear everything.",
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
        } else if (args.url) {
          const key = webCacheKey(args.url);
          if (keys.includes(key)) {
            await deleteCacheEntry(dir, key);
            removed = [key];
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
