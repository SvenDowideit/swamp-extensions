/**
 * Wikipedia — a fetch-free domain client for Wikipedia/Wikidata.
 *
 * All HTTPS goes through other models: `@svendowideit/web-cache` for cached
 * GETs (public MediaWiki and Enterprise article URLs) and
 * `@svendowideit/curl` for the Enterprise login/refresh POST. This model only
 * builds URLs and request plans, reads cached bodies, and parses them.
 *
 * A page may therefore be cached in **two** places:
 *
 *   - the public MediaWiki URL (`pageUrl` / `searchUrl` / `pagePropsUrl`), or
 *   - the synthetic Wikimedia Enterprise article URL (`enterpriseArticleUrl`).
 *
 * The read methods check the public cache first, then the Enterprise cache,
 * and parse whichever shape they find. Missing entries return
 * `cached: false`/`source: "none"` rather than making a network request.
 *
 * Methods:
 *   - `search`              parse a cached public opensearch response
 *   - `get-page`            parse a cached page from either cache
 *   - `get-infobox`         extract an infobox from either cached wikitext
 *   - `get-page-props`      resolve titles from either cache
 *   - `enterprise-plan`     decide Enterprise vs public and write private plans
 *   - `enterprise-session`  persist a login/refresh response
 *   - `enterprise-record`   record one successful Enterprise lookup
 *   - `enterprise-failure`  record an auth/rate-limit cooldown
 *   - `enterprise-cleanup`  delete temporary plan files
 *   - `enterprise-status`   read-only credential/quota report
 *
 * @module
 */
import { z } from "npm:zod@4";

import { expandHome, readCachedBody } from "./wikipedia_http.ts";
import {
  cleanupEnterpriseFiles,
  cleanupEnterpriseWorkDir,
  DEFAULT_ENTERPRISE_VAULT,
  enterpriseArticleUrl,
  enterpriseBodyForFormat,
  type EnterpriseContext,
  enterprisePagePropsBody,
  enterprisePlan,
  enterpriseSessionFromResponse,
  enterpriseStatus,
  parseEnterpriseArticle,
  recordEnterpriseFailure,
  recordEnterpriseUsage,
} from "./wikipedia_enterprise.ts";

export {
  expandHome,
  fnv1a,
  normalizeUrl,
  webCacheKey,
} from "./wikipedia_http.ts";

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
  enterpriseVaultName: z.string()
    .default(DEFAULT_ENTERPRISE_VAULT)
    .describe(
      "Vault checked for Wikimedia Enterprise credentials. The default is " +
        "`enterprise-wikimedia` (swamp vault names cannot contain underscores; " +
        "`enterprise_wikimedia` is also tried as an alias).",
    ),
  enterpriseUsernameKey: z.string()
    .default("username")
    .describe("Vault key holding the Enterprise account username"),
  // swamp-quality-ignore credentials-sensitive-field: holds the vault key name, not the secret
  enterprisePasswordKey: z.string()
    .default("password")
    .describe("Vault key holding the Enterprise account password"),
  // swamp-quality-ignore credentials-sensitive-field: holds the vault key name, not the secret
  enterpriseAccessTokenKey: z.string()
    .default("access_token")
    .describe("Vault key holding an existing Enterprise JWT access token"),
  // swamp-quality-ignore credentials-sensitive-field: holds the vault key name, not the secret
  enterpriseRefreshTokenKey: z.string()
    .default("refresh_token")
    .describe("Vault key holding an Enterprise refresh token"),
  enterpriseApiUrl: z.string()
    .default("https://api.enterprise.wikimedia.com")
    .describe("Wikimedia Enterprise On-demand API base URL"),
  enterpriseAuthUrl: z.string()
    .default("https://auth.enterprise.wikimedia.com")
    .describe("Wikimedia Enterprise authentication base URL"),
  enterpriseProject: z.string()
    .default("enwiki")
    .describe(
      "Enterprise project identifier used to filter article lookups " +
        "(e.g. enwiki, dewiki)",
    ),
  enterpriseMonthlyQuota: z.number().int().nonnegative()
    .default(50_000)
    .describe(
      "Local monthly Enterprise request budget. Enterprise is skipped when " +
        "this many lookups have been recorded this month; 0 means no local " +
        "cap (use the plan's actual dashboard limit).",
    ),
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

/** Which cache location supplied the body. */
const SourceSchema = z.enum([
  "public-cache",
  "enterprise-cache",
  "none",
]);
type Source = z.infer<typeof SourceSchema>;

/** Result returned by data-producing methods. */
const PageResultSchema = z.object({
  title: z.string(),
  format: z.string(),
  /** Content as a UTF-8 string (wikitext, html, json, …). */
  content: z.string().nullable(),
  /** Whether a cached body was found and used. */
  cached: z.boolean(),
  /** Which cache location supplied the body. */
  source: SourceSchema,
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
  source: SourceSchema,
});

const InfoboxResultSchema = z.object({
  title: z.string(),
  infobox: z.record(z.string(), z.string().nullable()),
  template: z.string().nullable(),
  cached: z.boolean(),
  source: SourceSchema,
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
  source: SourceSchema,
});

const EnterpriseSessionSchema = z.object({
  username: z.string().optional(),
  accessToken: z.string().optional().meta({ sensitive: true }),
  refreshToken: z.string().optional().meta({ sensitive: true }),
  expiresAt: z.string().optional(),
  obtainedAt: z.string().optional(),
  via: z.string().optional(),
});

const EnterpriseUsageSchema = z.object({
  month: z.string(),
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nullable(),
  exhausted: z.boolean(),
  rateLimitedUntil: z.number().nonnegative(),
  authFailedUntil: z.number().nonnegative(),
  updatedAt: z.string(),
});

const EnterprisePlanSchema = z.object({
  provider: z.enum(["enterprise", "public", "cache"]),
  reason: z.string(),
  publicUrl: z.string(),
  enterpriseUrl: z.string(),
  workDir: z.string(),
  // swamp-quality-ignore credentials-sensitive-field: holds a token file path, not the secret
  tokenFile: z.string(),
  auth: z.object({
    url: z.string(),
    method: z.string(),
    bodyFile: z.string(),
    responseFile: z.string(),
    username: z.string(),
    via: z.string(),
  }).nullable(),
  quota: EnterpriseUsageSchema.extend({
    available: z.boolean(),
    reason: z.string(),
  }),
  credentials: z.object({
    hasUsername: z.boolean(),
    hasPassword: z.boolean(),
    hasAccessToken: z.boolean(),
    hasRefreshToken: z.boolean(),
  }),
});

const EnterpriseSessionResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  expiresAt: z.string().optional(),
  // swamp-quality-ignore credentials-sensitive-field: holds a token file path, not the secret
  tokenFile: z.string(),
});

const EnterpriseFailureArgsSchema = z.object({
  kind: z.enum(["auth", "rate"]).default("auth")
    .describe("Which cooldown to record"),
});

const EnterpriseCleanupArgsSchema = z.object({
  workDir: z.string().default("")
    .describe("Private Enterprise plan directory to remove (best-effort)"),
  files: z.array(z.string()).default([])
    .describe("Additional temporary files to delete (best-effort)"),
});

const EnterpriseStatusSchema = z.object({
  vaultName: z.string(),
  vaultNames: z.array(z.string()),
  project: z.string(),
  hasUsername: z.boolean(),
  hasPassword: z.boolean(),
  hasAccessToken: z.boolean(),
  hasRefreshToken: z.boolean(),
  hasCredentials: z.boolean(),
  sessionValid: z.boolean(),
  sessionVia: z.string().nullable(),
  sessionObtainedAt: z.string().nullable(),
  sessionExpiresAt: z.string().nullable(),
  quota: EnterpriseUsageSchema.extend({
    available: z.boolean(),
    reason: z.string(),
  }),
  eligible: z.boolean(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type MethodContext = EnterpriseContext & {
  globalArgs: GlobalArgs & EnterpriseContext["globalArgs"];
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// ---------------------------------------------------------------------------
// Wikipedia URL builders
// ---------------------------------------------------------------------------

/** Build the URL for a page fetch in a given format. */
export function pageUrl(
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
export function searchUrl(
  ctx: MethodContext,
  query: string,
  limit: number,
): string {
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
export function pagePropsUrl(ctx: MethodContext, titles: string[]): string {
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
export function parsePageProps(body: string | null): Record<
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
export function extractContent(
  format: PageFormat,
  parsed: unknown,
): string | null {
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
// Dual-cache resolution (public URL first, then Enterprise URL)
// ---------------------------------------------------------------------------

interface ResolvedBody {
  body: string | null;
  source: Source;
}

/** Read a page body from either the public or the Enterprise cache. */
async function resolvePageBody(
  ctx: MethodContext,
  title: string,
  format: PageFormat,
  publicUrl: string,
): Promise<ResolvedBody> {
  const dir = expandHome(ctx.globalArgs.cacheDir);
  const publicBody = await readCachedBody(dir, publicUrl);
  if (publicBody != null) return { body: publicBody, source: "public-cache" };

  const enterpriseUrl = enterpriseArticleUrl(ctx, title);
  const enterpriseBody = await readCachedBody(dir, enterpriseUrl);
  if (enterpriseBody != null) {
    const article = parseEnterpriseArticle(enterpriseBody);
    const converted = article ? enterpriseBodyForFormat(article, format) : null;
    if (converted != null) {
      return { body: converted, source: "enterprise-cache" };
    }
  }
  return { body: null, source: "none" };
}

/** Search is public-only: Enterprise On-demand has no search endpoint. */
async function resolveSearchBody(
  ctx: MethodContext,
  publicUrl: string,
): Promise<ResolvedBody> {
  const dir = expandHome(ctx.globalArgs.cacheDir);
  const body = await readCachedBody(dir, publicUrl);
  return { body, source: body != null ? "public-cache" : "none" };
}

/**
 * Page-props: the public batch response is preferred; for a single title the
 * Enterprise article payload is converted into the same page-props shape.
 */
async function resolvePagePropsBody(
  ctx: MethodContext,
  titles: string[],
  publicUrl: string,
): Promise<ResolvedBody> {
  const dir = expandHome(ctx.globalArgs.cacheDir);
  const publicBody = await readCachedBody(dir, publicUrl);
  if (publicBody != null) return { body: publicBody, source: "public-cache" };

  if (titles.length === 1) {
    const enterpriseBody = await readCachedBody(
      dir,
      enterpriseArticleUrl(ctx, titles[0]),
    );
    if (enterpriseBody != null) {
      const article = parseEnterpriseArticle(enterpriseBody);
      if (article) {
        return {
          body: enterprisePagePropsBody(article, titles[0]),
          source: "enterprise-cache",
        };
      }
    }
  }
  return { body: null, source: "none" };
}

const EnterprisePlanArgsSchema = z.object({
  title: TitleArg,
  format: FormatArg,
  runId: z.string()
    .optional()
    .describe(
      "Workflow run id used to namespace private plan/token files (pass " +
        "${{ run.id }}).",
    ),
  instanceKey: z.string()
    .optional()
    .describe(
      "Unique resource-instance suffix for this plan (pass ${{ run.id }} so " +
        "concurrent page resolutions do not overwrite each other).",
    ),
  url: z.string().url()
    .optional()
    .describe("Public URL override (defaults to the title/format URL)"),
  publicUrl: z.string()
    .optional()
    .describe(
      "Explicit public cache/request URL (used by page-props for a single " +
        "title, where the URL shape differs from page-url)",
    ),
});

type EnterprisePlanArgs = z.infer<typeof EnterprisePlanArgsSchema>;

const EnterpriseSessionArgsSchema = z.object({
  responseFile: z.string()
    .describe("Path curl wrote the login/refresh response body to"),
  // swamp-quality-ignore credentials-sensitive-field: holds a token file path, not the secret
  tokenFile: z.string()
    .describe("0600 bearer-token file web-cache will read"),
  bodyFile: z.string()
    .optional()
    .describe("Optional 0600 login/refresh request body file to delete"),
  instanceKey: z.string()
    .optional()
    .describe(
      "Unique resource-instance suffix for the result (must match the plan)",
    ),
});

type EnterpriseSessionArgs = z.infer<typeof EnterpriseSessionArgsSchema>;

const EnterpriseUsageResultSchema = z.object({
  month: z.string(),
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nullable(),
  exhausted: z.boolean(),
  rateLimitedUntil: z.number().nonnegative(),
  authFailedUntil: z.number().nonnegative(),
  updatedAt: z.string(),
});

const EnterpriseCleanupResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A read-only Wikipedia domain client layered over @svendowideit/web-cache. */
export const model = {
  type: "@svendowideit/wikipedia",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.20.3",
      description: "No schema changes — page-props support",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.20.4",
      description:
        "No schema changes — export URL builders/parsers and add method " +
        "execute-path test coverage",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.23.1",
      description:
        "Honour SWAMP_HOME when resolving ~/.swamp-relative cache paths.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.24.1",
      description:
        "Add dual-cache reads (public + Enterprise URLs) and Enterprise " +
        "planning/session/quota methods. No direct HTTP: fetch through " +
        "web-cache and curl.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.24.2",
      description:
        "Workflow maxFetches defaults to 0 (unlimited); no model-schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
    "enterprise-plan": {
      description:
        "Source-selection plan: public vs Enterprise, cache URLs, private auth files",
      schema: EnterprisePlanSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-session": {
      description:
        "Wikimedia Enterprise JWT session (access/refresh tokens are sensitive)",
      schema: EnterpriseSessionSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-session-result": {
      description: "Result of persisting a login/refresh response",
      schema: EnterpriseSessionResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-usage": {
      description:
        "Wikimedia Enterprise monthly request counter and cooldown state",
      schema: EnterpriseUsageSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-usage-result": {
      description: "Updated Wikimedia Enterprise usage after a record/failure",
      schema: EnterpriseUsageResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-status": {
      description:
        "Read-only Wikimedia Enterprise credential and quota readiness report",
      schema: EnterpriseStatusSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-cleanup": {
      description: "Count of temporary Enterprise plan files removed",
      schema: EnterpriseCleanupResultSchema,
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
        const publicUrl = args.url ?? pagePropsUrl(context, args.titles);
        const resolved = await resolvePagePropsBody(
          context,
          args.titles,
          publicUrl,
        );
        const pages = parsePageProps(resolved.body);
        const result = {
          pages,
          cached: resolved.source !== "none",
          source: resolved.source,
        };
        const handle = await context.writeResource(
          "page-props",
          `page-props-${args.key || args.titles.join("|")}`,
          result,
        );
        context.logger.info("Parsed page-props for {n} titles ({src})", {
          n: args.titles.length,
          src: resolved.source,
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
        const url = args.url ?? searchUrl(context, args.query, args.limit);
        const resolved = await resolveSearchBody(context, url);
        const body = resolved.body;

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
          cached: resolved.source !== "none",
          source: resolved.source,
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
          src: resolved.source,
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
        const publicUrl = args.url ?? pageUrl(context, args.title, args.format);
        const resolved = await resolvePageBody(
          context,
          args.title,
          args.format,
          publicUrl,
        );
        const body = resolved.body;

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
          cached: resolved.source !== "none",
          source: resolved.source,
        };
        const handle = await context.writeResource(
          "page",
          `page-${args.title}`,
          result,
        );
        context.logger.info("Parsed {title} ({format}) {src}", {
          title: args.title,
          format: args.format,
          src: resolved.source,
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
        const publicUrl = args.url ?? pageUrl(context, args.title, "wikitext");
        const resolved = await resolvePageBody(
          context,
          args.title,
          "wikitext",
          publicUrl,
        );
        const body = resolved.body;

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
          cached: resolved.source !== "none",
          source: resolved.source,
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
    "enterprise-plan": {
      description:
        "Decide whether a page should come from Wikimedia Enterprise or the " +
        "public API, and write the private files the fetch workflow needs. " +
        "Makes no request. The returned cache URLs are the public URL and the " +
        "synthetic Enterprise article URL.",
      arguments: EnterprisePlanArgsSchema,
      execute: async (args: EnterprisePlanArgs, context: MethodContext) => {
        const publicUrl = args.publicUrl || args.url ||
          pageUrl(context, args.title, args.format);
        const plan = await enterprisePlan(
          context,
          args.title,
          publicUrl,
          args.runId,
        );
        const planName = args.instanceKey
          ? `enterprise-plan-${args.instanceKey}`
          : "enterprise-plan";
        const handle = await context.writeResource(
          "enterprise-plan",
          planName,
          plan as unknown as Record<string, unknown>,
        );
        context.logger.info(
          "Enterprise plan for {title}: {provider} ({reason})",
          {
            title: args.title,
            provider: plan.provider,
            reason: plan.reason,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "enterprise-session": {
      description:
        "Parse curl's cached login/refresh response, persist the sensitive JWT " +
        "session, and write the 0600 bearer-token file web-cache reads. Deletes " +
        "the temporary auth request/response files.",
      arguments: EnterpriseSessionArgsSchema,
      execute: async (
        args: EnterpriseSessionArgs,
        context: MethodContext,
      ) => {
        const result = await enterpriseSessionFromResponse(
          context,
          args.responseFile,
          args.tokenFile,
          args.bodyFile ?? "",
        );
        const resultName = args.instanceKey
          ? `enterprise-session-result-${args.instanceKey}`
          : "enterprise-session-result";
        const handle = await context.writeResource(
          "enterprise-session-result",
          resultName,
          result as unknown as Record<string, unknown>,
        );
        if (result.ok) {
          context.logger.info(
            "Enterprise session saved (expires {expiresAt})",
            { expiresAt: result.expiresAt ?? "unknown" },
          );
        } else {
          context.logger.warn?.(
            "Enterprise session failed: {error}",
            { error: result.error ?? "unknown" },
          );
        }
        return { dataHandles: [handle] };
      },
    },
    "enterprise-record": {
      description:
        "Record one successful Enterprise article lookup against the local " +
        "monthly budget. Call after the Enterprise fetch succeeds, not on a " +
        "cache hit or a failed request.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const usage = await recordEnterpriseUsage(context);
        const handle = await context.writeResource(
          "enterprise-usage-result",
          "enterprise-usage-result",
          usage as unknown as Record<string, unknown>,
        );
        context.logger.info("Enterprise usage: {used}/{limit}", {
          used: usage.used,
          limit: usage.limit,
        });
        return { dataHandles: [handle] };
      },
    },
    "enterprise-failure": {
      description:
        "Record an Enterprise auth failure or rate-limit so the next plan backs " +
        "off instead of repeating a failing request.",
      arguments: EnterpriseFailureArgsSchema,
      execute: async (
        args: z.infer<typeof EnterpriseFailureArgsSchema>,
        context: MethodContext,
      ) => {
        const usage = await recordEnterpriseFailure(context, args.kind);
        const handle = await context.writeResource(
          "enterprise-usage-result",
          "enterprise-usage-result",
          usage as unknown as Record<string, unknown>,
        );
        context.logger.warn?.("Enterprise {kind} cooldown recorded", {
          kind: args.kind,
        });
        return { dataHandles: [handle] };
      },
    },
    "enterprise-cleanup": {
      description:
        "Delete temporary Enterprise plan/auth files (for example at the end " +
        "of a workflow run). Best-effort and safe to call repeatedly.",
      arguments: EnterpriseCleanupArgsSchema,
      execute: async (
        args: z.infer<typeof EnterpriseCleanupArgsSchema>,
        context: MethodContext,
      ) => {
        await cleanupEnterpriseWorkDir(context, args.workDir);
        await cleanupEnterpriseFiles(args.files);
        const handle = await context.writeResource(
          "enterprise-cleanup",
          "enterprise-cleanup",
          { deleted: args.files.length + (args.workDir ? 1 : 0) },
        );
        context.logger.info("Cleaned up Enterprise plan files", {
          workDir: args.workDir || "none",
        });
        return { dataHandles: [handle] };
      },
    },
    "enterprise-status": {
      description:
        "Report Wikimedia Enterprise readiness without making a request or " +
        "printing a secret: vault keys present, session validity, monthly " +
        "quota usage, cooldown state and the current decision.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const status = await enterpriseStatus(context);
        const handle = await context.writeResource(
          "enterprise-status",
          "enterprise-status",
          status as unknown as Record<string, unknown>,
        );
        context.logger.info("Enterprise status: {reason}", {
          reason: status.reason,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
