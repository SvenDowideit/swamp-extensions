/**
 * Wikipedia — a domain client that reads Wikipedia/Wikidata responses from the
 * shared web cache owned by `@svendowideit/web-cache`.
 *
 * This model does **not** fetch or cache anything itself. Fetching, caching,
 * request pacing and rate-limit retry are the responsibility of the
 * `@svendowideit/web-cache` model, which persists every response (body plus
 * HTTP headers) under a shared cache directory (default `~/.swamp/web-cache`),
 * keyed deterministically by URL.
 *
 * The intended workflow seam is:
 *
 *   web-cache.get <url>   →  fetch + cache (populates the shared cache)
 *   wikipedia.get-page    →  read the cached body and parse the domain content
 *
 * To share the cache, both models use the same on-disk layout and URL-only key
 * scheme (`<url-slug>-<fnv1a>`). This model only *reads* entries that
 * `web-cache` has written; when an entry is missing it returns an empty result
 * with `cached: false` rather than making a network request.
 *
 * Methods:
 *   - `search`        parse a cached opensearch response
 *   - `get-page`      parse a cached page (wikitext | html | parsoid | summary | json)
 *   - `get-infobox`   extract an infobox from cached wikitext
 *
 * @module
 */
import { z } from "npm:zod@4";

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST = "https://en.wikipedia.org/api/rest_v1";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  cacheDir: z.string()
    .default("~/.swamp/web-cache")
    .describe(
      "Shared web-cache directory to read cached responses from (must match " +
        "the @svendowideit/web-cache model's cacheDir).",
    ),
  apiUrl: z.string()
    .default(WIKI_API)
    .describe("MediaWiki action API base URL"),
  restUrl: z.string()
    .default(WIKI_REST)
    .describe("Wikipedia REST v1 base URL"),
});

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

const GetPageArgsSchema = z.object({
  title: TitleArg,
  format: FormatArg,
  url: z.string().url()
    .optional()
    .describe(
      "Exact URL to read from the cache. When omitted, derived from " +
        "title/format. Prefer passing this explicitly so it matches the URL a " +
        "web-cache.get step fetched.",
    ),
});

type GetPageArgs = z.infer<typeof GetPageArgsSchema>;

const SearchArgsSchema = z.object({
  query: TitleArg.describe("Search query (tolerant of misspellings)"),
  limit: z.number().int().min(1).max(20)
    .default(5)
    .describe("Maximum number of results"),
  key: z.string()
    .optional()
    .describe("Optional data name for the result (defaults to the query)."),
  url: z.string().url()
    .optional()
    .describe(
      "Exact URL to read from the cache. When omitted, the URL is derived " +
        "from query/limit. Prefer passing this explicitly so it matches the " +
        "URL a web-cache.get step fetched.",
    ),
});

type SearchArgs = z.infer<typeof SearchArgsSchema>;

const GetInfoboxArgsSchema = z.object({
  title: TitleArg,
  template: z.string()
    .optional()
    .describe(
      "Restrict to a specific infobox template name (e.g. 'writer', 'book'). " +
        "Omit to return the first infobox found.",
    ),
  key: z.string()
    .optional()
    .describe(
      "Optional data name for the result (defaults to the title). Pass the " +
        "caller's own logical name so downstream steps reference it directly.",
    ),
  url: z.string().url()
    .optional()
    .describe(
      "Exact wikitext URL to read from the cache. When omitted, derived from " +
        "title. Prefer passing this explicitly so it matches the URL a " +
        "web-cache.get step fetched.",
    ),
});

type GetInfoboxArgs = z.infer<typeof GetInfoboxArgsSchema>;

/** Build a search URL for a query (no fetching). */
const SearchUrlArgsSchema = z.object({
  query: TitleArg.describe("Search query"),
  limit: z.number().int().min(1).max(20)
    .default(5)
    .describe("Maximum number of results"),
});

type SearchUrlArgs = z.infer<typeof SearchUrlArgsSchema>;

/** Build a page URL for a title in a format (no fetching). */
const PageUrlArgsSchema = z.object({
  title: TitleArg,
  format: FormatArg,
});

type PageUrlArgs = z.infer<typeof PageUrlArgsSchema>;

/** Build a batched page-props query URL for candidate titles (no fetching). */
const PagePropsUrlArgsSchema = z.object({
  titles: z.array(z.string().min(1)).min(1).describe("Candidate page titles"),
});

type PagePropsUrlArgs = z.infer<typeof PagePropsUrlArgsSchema>;

/** Parse a cached page-props (action=query&prop=info|pageprops) response. */
const GetPagePropsArgsSchema = z.object({
  titles: z.array(z.string().min(1)).min(1)
    .describe("Candidate page titles to resolve"),
  key: z.string()
    .optional()
    .describe("Optional data name for the result (defaults to joined titles)."),
  url: z.string().url()
    .optional()
    .describe("Exact page-props URL to read from the cache (omit to derive)."),
});

type GetPagePropsArgs = z.infer<typeof GetPagePropsArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by data-producing methods. */
const PageResultSchema = z.object({
  title: z.string(),
  format: z.string(),
  /** Content as a UTF-8 string (wikitext, html, json, …). */
  content: z.string().nullable(),
  /** Whether a cached body was found and used. */
  cached: z.boolean(),
});

type PageResult = z.infer<typeof PageResultSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const SearchResultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    title: z.string(),
    description: z.string().nullable(),
    url: z.string().nullable(),
  })),
  cached: z.boolean(),
});

const InfoboxResultSchema = z.object({
  title: z.string(),
  infobox: z.record(z.string(), z.string().nullable()),
  template: z.string().nullable(),
  cached: z.boolean(),
});

const UrlResultSchema = z.object({
  url: z.string(),
  urls: z.array(z.string()),
});

const PagePropsResultSchema = z.object({
  pages: z.record(
    z.string(),
    z.object({
      title: z.string(),
      url: z.string().nullable(),
      shortdesc: z.string().nullable(),
      wikidataId: z.string().nullable(),
    }),
  ),
  cached: z.boolean(),
});

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
// Shared cache key scheme (must match @svendowideit/web-cache exactly)
// ---------------------------------------------------------------------------

/** Expand `~` to the home directory. */
function expandHome(raw: string): string {
  if (raw.startsWith("~")) {
    const home = Deno.env.get("HOME") ?? "~";
    return raw === "~" ? home : `${home}${raw.slice(1)}`;
  }
  return raw;
}

/**
 * Deterministic 32-bit hash (FNV-1a) of a string. This is deliberately
 * identical to `@svendowideit/web-cache`'s `fnv1a` so both models derive the
 * same cache key for the same URL.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonicalize a URL so that two spellings of the same resource produce the
 * same cache key. This MUST stay byte-for-byte identical to
 * `@svendowideit/web-cache`'s `normalizeUrl` — both models derive the same
 * cache key from the same URL. See that model for the exact rules.
 */
function normalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
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
 * The URL-only cache key. Identical to `@svendowideit/web-cache`'s
 * `webCacheKey`, so a cached body written by `web-cache.get(url)` is found here
 * regardless of query-parameter ordering or minor URL spelling differences.
 */
function webCacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  const safe = normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe}-${fnv1a(normalized)}`;
}

/**
 * Read a cached body for a URL from the shared web-cache directory. Returns
 * null when the entry is absent. This is read-only: it never fetches.
 */
async function readCachedBody(
  dir: string,
  url: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${dir}/${webCacheKey(url)}/body`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wikipedia URL builders
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

/** Build the URL for an opensearch query. */
function searchUrl(ctx: MethodContext, query: string, limit: number): string {
  const params = new URLSearchParams({
    action: "opensearch",
    search: query,
    limit: String(limit),
    format: "json",
    origin: "*",
  });
  return `${ctx.globalArgs.apiUrl}?${params}`;
}

/** Build a batched page-props query URL (action=query&prop=info|pageprops). */
function pagePropsUrl(ctx: MethodContext, titles: string[]): string {
  const params = new URLSearchParams({
    action: "query",
    redirects: "1",
    prop: "info|pageprops",
    titles: titles.join("|"),
    inprop: "url",
    format: "json",
    origin: "*",
  });
  return `${ctx.globalArgs.apiUrl}?${params}`;
}

/**
 * Parse a cached page-props response body into a map of canonical title →
 * { url, shortdesc, wikidataId }, following redirects.
 */
function parsePageProps(body: string | null): Record<
  string,
  {
    title: string;
    url: string | null;
    shortdesc: string | null;
    wikidataId: string | null;
  }
> {
  const out: Record<
    string,
    {
      title: string;
      url: string | null;
      shortdesc: string | null;
      wikidataId: string | null;
    }
  > = {};
  if (!body) return out;
  try {
    const parsed = JSON.parse(body) as {
      query?: {
        pages?: Record<string, {
          title: string;
          canonicalurl?: string;
          fullurl?: string;
          pageprops?: {
            "wikibase-shortdesc"?: string;
            "wikibase_item"?: string;
          };
        }>;
        redirects?: { from: string; to: string }[];
      };
    };
    const redirects = new Map(
      (parsed.query?.redirects ?? []).map((r) => [r.from, r.to]),
    );
    for (const page of Object.values(parsed.query?.pages ?? {})) {
      const title = redirects.get(page.title) ?? page.title;
      out[title] = {
        title,
        url: page.canonicalurl ?? page.fullurl ?? null,
        shortdesc: page.pageprops?.["wikibase-shortdesc"] ?? null,
        wikidataId: page.pageprops?.["wikibase_item"] ?? null,
      };
    }
  } catch {
    // ignore malformed body
  }
  return out;
}

/** Extract the human-readable content string from a parsed action API response. */
function extractContent(format: PageFormat, parsed: unknown): string | null {
  if (format === "parsoid" || format === "summary") {
    return typeof parsed === "string"
      ? parsed
      : JSON.stringify(parsed, null, 2);
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (format === "wikitext") {
    const parse = p["parse"] as Record<string, unknown> | undefined;
    const wt = parse?.["wikitext"];
    // formatversion=2 → plain string; formatversion=1 → {"*": "..."}
    if (typeof wt === "string") return wt;
    if (wt && typeof wt === "object") {
      const star = (wt as Record<string, unknown>)["*"];
      return typeof star === "string" ? star : null;
    }
    return null;
  }
  if (format === "html") {
    const parse = p["parse"] as Record<string, unknown> | undefined;
    const text = parse?.["text"];
    if (typeof text === "string") return text;
    if (text && typeof text === "object") {
      const star = (text as Record<string, unknown>)["*"];
      return typeof star === "string" ? star : null;
    }
    return null;
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

/** A read-only Wikipedia domain client layered over @svendowideit/web-cache. */
export const model = {
  type: "@svendowideit/wikipedia",
  version: "2026.09.20.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    page: {
      description: "A parsed Wikipedia page (content from the shared cache)",
      schema: PageResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    search: {
      description: "Parsed search results (from the shared cache)",
      schema: SearchResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    infobox: {
      description: "Extracted infobox key/value pairs for a page",
      schema: InfoboxResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    url: {
      description: "A built MediaWiki URL (for the fetch seam)",
      schema: UrlResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "page-props": {
      description:
        "Parsed page-props (canonical title, url, shortdesc, wikidataId)",
      schema: PagePropsResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    "search-url": {
      description:
        "Build the opensearch URL for a query (no fetching). Use this to feed " +
        "a web-cache fetch step, then `search` to parse the cached result.",
      arguments: SearchUrlArgsSchema,
      execute: async (args: SearchUrlArgs, context: MethodContext) => {
        const url = searchUrl(context, args.query, args.limit);
        const handle = await context.writeResource("url", "search-url", {
          url,
          urls: [url],
        });
        context.logger.info("Built search URL for {query}", {
          query: args.query,
        });
        return { dataHandles: [handle] };
      },
    },
    "page-url": {
      description:
        "Build the page URL for a title in a format (no fetching). Use this to " +
        "feed a web-cache fetch step, then `get-page` to parse the cached body.",
      arguments: PageUrlArgsSchema,
      execute: async (args: PageUrlArgs, context: MethodContext) => {
        const url = pageUrl(context, args.title, args.format);
        const handle = await context.writeResource("url", "page-url", {
          url,
          urls: [url],
        });
        context.logger.info("Built page URL for {title} ({format})", {
          title: args.title,
          format: args.format,
        });
        return { dataHandles: [handle] };
      },
    },
    "page-props-url": {
      description:
        "Build a batched page-props query URL for candidate titles (no " +
        "fetching). Use this to feed a web-cache fetch step, then " +
        "`get-page-props` to parse the cached result.",
      arguments: PagePropsUrlArgsSchema,
      execute: async (args: PagePropsUrlArgs, context: MethodContext) => {
        const url = pagePropsUrl(context, args.titles);
        const handle = await context.writeResource("url", "page-props-url", {
          url,
          urls: [url],
        });
        context.logger.info("Built page-props URL for {n} titles", {
          n: args.titles.length,
        });
        return { dataHandles: [handle] };
      },
    },
    "get-page-props": {
      description:
        "Parse a cached page-props response into canonical title → url, " +
        "shortdesc and wikidataId. Reads from the shared web cache.",
      arguments: GetPagePropsArgsSchema,
      execute: async (args: GetPagePropsArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const url = args.url ?? pagePropsUrl(context, args.titles);
        const body = await readCachedBody(dir, url);
        const pages = parsePageProps(body);
        const result = { pages, cached: body != null };
        const handle = await context.writeResource(
          "page-props",
          `page-props-${args.key || args.titles.join("|")}`,
          result,
        );
        context.logger.info("Parsed page-props for {n} titles ({src})", {
          n: args.titles.length,
          src: body != null ? "cache" : "miss",
        });
        return { dataHandles: [handle] };
      },
    },
    "search": {
      description:
        "Parse a cached opensearch response for a query into corrected titles, " +
        "short descriptions and URLs. Reads from the shared web cache — run a " +
        "`web-cache.get` step first (or accept an empty result on a miss).",
      arguments: SearchArgsSchema,
      execute: async (args: SearchArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const url = args.url ?? searchUrl(context, args.query, args.limit);
        const body = await readCachedBody(dir, url);

        let titles: string[] = [];
        let descriptions: string[] = [];
        let urls: string[] = [];
        if (body) {
          try {
            const parsed = JSON.parse(body) as [
              string,
              string[],
              string[],
              string[],
            ];
            titles = parsed[1] ?? [];
            descriptions = parsed[2] ?? [];
            urls = parsed[3] ?? [];
          } catch {
            // Body wasn't the expected shape — treat as a miss.
          }
        }

        const result = {
          query: args.query,
          results: titles.map((title, i) => ({
            title,
            description: descriptions[i] ?? null,
            url: urls[i] ?? null,
          })),
          cached: body != null,
        };
        const key = args.key || args.query;
        const handle = await context.writeResource(
          "search",
          `search-${key}`,
          result,
        );
        context.logger.info("Searched {query}: {n} results ({src})", {
          query: args.query,
          n: titles.length,
          src: body != null ? "cache" : "miss",
        });
        return { dataHandles: [handle] };
      },
    },
    "get-page": {
      description:
        "Parse a cached Wikipedia page into content. `format` defaults to " +
        "wikitext; also html, parsoid (REST), summary (REST) and json. Reads " +
        "from the shared web cache — run a `web-cache.get` step first.",
      arguments: GetPageArgsSchema,
      execute: async (args: GetPageArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const url = args.url ?? pageUrl(context, args.title, args.format);
        const body = await readCachedBody(dir, url);

        let content: string | null = null;
        if (body) {
          if (args.format === "parsoid" || args.format === "summary") {
            content = body;
          } else {
            try {
              content = extractContent(args.format, JSON.parse(body));
            } catch {
              content = body;
            }
          }
        }

        const result: PageResult = {
          title: args.title,
          format: args.format,
          content,
          cached: body != null,
        };
        const handle = await context.writeResource(
          "page",
          `page-${args.title}`,
          result,
        );
        context.logger.info("Parsed {title} ({format}) {src}", {
          title: args.title,
          format: args.format,
          src: body != null ? "cache" : "miss",
        });
        return { dataHandles: [handle] };
      },
    },
    "get-infobox": {
      description:
        "Extract a page's infobox into key/value pairs from cached wikitext. " +
        "Optionally restrict to a specific template name. Reads from the shared " +
        "web cache — run a `web-cache.get` step first.",
      arguments: GetInfoboxArgsSchema,
      execute: async (args: GetInfoboxArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const url = args.url ?? pageUrl(context, args.title, "wikitext");
        const body = await readCachedBody(dir, url);

        let content: string | null = null;
        if (body) {
          try {
            content = extractContent("wikitext", JSON.parse(body));
          } catch {
            content = body;
          }
        }

        const infobox = parseInfoboxTemplate(content);
        const infoboxName = detectInfoboxName(content);

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
          cached: body != null,
        };
        const handle = await context.writeResource(
          "infobox",
          `infobox-${args.key || args.title}`,
          result,
        );
        context.logger.info("Extracted infobox from {title} ({template})", {
          title: args.title,
          template: infoboxName ?? "none",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
