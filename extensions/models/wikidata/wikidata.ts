/**
 * Wikidata — a domain client that reads Wikidata responses from the shared web
 * cache owned by `@svendowideit/web-cache`.
 *
 * Like `@svendowideit/wikipedia`, this model **fetches nothing itself**: it
 * parses responses that `web-cache` has already fetched and cached. It exposes
 * the generalised Wikidata operations an entity-resolution pipeline needs —
 * searching for entities, resolving a Wikipedia page title to a Wikidata QID
 * via its sitelink, fetching an entity's claims/descriptions/labels, and
 * extracting structured claims (e.g. `instance of` / P31) into simple
 * `key → [values]` form.
 *
 * The workflow seam is the same as wikipedia:
 *
 *   web-cache.get <url>    →  fetch + cache
 *   wikidata.get-entity    →  read the cached body and parse the entity
 *
 * Both models share the same `cacheDir` (default `~/.swamp/web-cache`) and the
 * same URL-normalizing cache-key scheme.
 *
 * Methods:
 *   - `search`          parse a cached wbsearchentities response
 *   - `get-entity`      parse a cached wbgetentities response into entities
 *   - `resolve-title`   parse a cached sitelink lookup (Wikipedia title → QID)
 *   - `get-claims`      extract one property's claims (e.g. P31) from an entity
 *   - `get-instance-of` convenience: extract P31 values from an entity
 *
 * @module
 */
import { z } from "npm:zod@4";

import {
  cleanupEnterpriseFiles,
  cleanupEnterpriseWorkDir,
  DEFAULT_ENTERPRISE_VAULT,
  type EnterpriseContext,
  enterpriseEntityToPublic,
  enterpriseEntityUrl,
  enterprisePlan,
  enterpriseSessionFromResponse,
  enterpriseStatus,
  parseEnterpriseArticle,
  recordEnterpriseFailure,
  recordEnterpriseUsage,
} from "./wikidata_enterprise.ts";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

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
    .default(WIKIDATA_API)
    .describe("Wikidata action API base URL"),
  language: z.string()
    .default("en")
    .describe("Language for labels, descriptions and search"),
  site: z.string()
    .default("enwiki")
    .describe("Site id used for sitelink lookups (e.g. enwiki, commonswiki)"),
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
  enterpriseMonthlyQuota: z.number().int().nonnegative()
    .default(50_000)
    .describe(
      "Local monthly Enterprise Wikidata lookup budget. Enterprise is skipped " +
        "when this many lookups have been recorded this month; 0 means no " +
        "local cap.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

/** Shared freshness/cache args: an explicit URL to read from the cache. */
const UrlArg = z.string().url()
  .optional()
  .describe(
    "Exact URL to read from the cache. When omitted, derived from the other " +
      "inputs. Prefer passing this explicitly so it matches the URL a " +
      "web-cache.get step fetched.",
  );

const SearchArgsSchema = z.object({
  query: z.string().min(1).describe("Search query (an entity label)"),
  limit: z.number().int().min(1).max(50)
    .default(10)
    .describe("Maximum number of results"),
  language: z.string().optional().describe("Override the global language"),
  url: UrlArg,
});

type SearchArgs = z.infer<typeof SearchArgsSchema>;

const GetEntityArgsSchema = z.object({
  id: z.string().min(1).describe("Wikidata QID, e.g. 'Q286116'"),
  url: UrlArg,
});

type GetEntityArgs = z.infer<typeof GetEntityArgsSchema>;

const ResolveTitleArgsSchema = z.object({
  title: z.string().min(1).describe(
    "Page title to resolve (e.g. 'Alfred Bester')",
  ),
  site: z.string().optional().describe("Override the global site id"),
  url: UrlArg,
});

type ResolveTitleArgs = z.infer<typeof ResolveTitleArgsSchema>;

const GetClaimsArgsSchema = z.object({
  id: z.string().min(1).describe("Wikidata QID whose claims to extract"),
  property: z.string().min(1).describe("Property ID, e.g. 'P31' (instance of)"),
  url: UrlArg,
});

type GetClaimsArgs = z.infer<typeof GetClaimsArgsSchema>;

const GetInstanceOfArgsSchema = z.object({
  id: z.string().min(1).describe(
    "Wikidata QID whose instance-of (P31) to extract",
  ),
  key: z.string()
    .optional()
    .describe("Optional data name for the result (defaults to the QID)."),
  url: UrlArg,
});

type GetInstanceOfArgs = z.infer<typeof GetInstanceOfArgsSchema>;

/** Build a wbsearchentities URL (no fetching). */
const SearchUrlArgsSchema = z.object({
  query: z.string().min(1).describe("Search query (an entity label)"),
  limit: z.number().int().min(1).max(50)
    .default(10)
    .describe("Maximum number of results"),
});

type SearchUrlArgs = z.infer<typeof SearchUrlArgsSchema>;

/** Build a wbgetentities URL for a QID (no fetching). */
const EntityUrlArgsSchema = z.object({
  id: z.string().min(1).describe("Wikidata QID, e.g. 'Q286116'"),
});

type EntityUrlArgs = z.infer<typeof EntityUrlArgsSchema>;

/** Build a sitelink-lookup URL (title → QID) (no fetching). */
const ResolveTitleUrlArgsSchema = z.object({
  title: z.string().min(1).describe("Page title to resolve"),
  site: z.string().optional().describe("Override the global site id"),
});

type ResolveTitleUrlArgs = z.infer<typeof ResolveTitleUrlArgsSchema>;

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
// Shared cache key scheme (must match @svendowideit/web-cache exactly)
// ---------------------------------------------------------------------------

/** Expand `~` to the home directory. Exported so tests can cover it directly. */
export function expandHome(raw: string): string {
  if (raw === "~") {
    return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "~";
  }
  if (raw.startsWith("~/")) {
    if (raw === "~/.swamp" || raw.startsWith("~/.swamp/")) {
      const swampHome = Deno.env.get("SWAMP_HOME");
      if (swampHome) {
        const base = swampHome.replace(/\/+$/, "");
        const suffix = raw.slice("~/.swamp".length);
        return suffix ? `${base}${suffix}` : base;
      }
    }
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (home) return `${home}${raw.slice(1)}`;
  }
  return raw;
}

/** Deterministic 32-bit hash (FNV-1a), identical to web-cache's fnv1a. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Canonicalize a URL, identical to web-cache's normalizeUrl. */
export function normalizeUrl(url: string): string {
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

/** URL-only cache key, identical to web-cache's webCacheKey. */
export function webCacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  const safe = normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe}-${fnv1a(normalized)}`;
}

/** Read a cached body for a URL from the shared cache dir (read-only). */
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
// URL builders
// ---------------------------------------------------------------------------

/** Build the wbsearchentities URL. */
export function searchUrl(
  ctx: MethodContext,
  query: string,
  limit: number,
  lang: string,
): string {
  const params = new URLSearchParams({
    action: "wbsearchentities",
    search: query,
    language: lang,
    limit: String(limit),
    format: "json",
    origin: "*",
    type: "item",
  });
  return `${ctx.globalArgs.apiUrl}?${params}`;
}

/** Build the wbgetentities URL for one or more QIDs. */
export function entityUrl(ctx: MethodContext, id: string): string {
  const params = new URLSearchParams({
    action: "wbgetentities",
    ids: id,
    props: "claims|descriptions|labels|sitelinks",
    languages: ctx.globalArgs.language,
    format: "json",
    origin: "*",
  });
  return `${ctx.globalArgs.apiUrl}?${params}`;
}

/** Build the sitelink-lookup URL (Wikipedia title → Wikidata entity). */
export function sitelinkUrl(
  ctx: MethodContext,
  title: string,
  site: string,
): string {
  const params = new URLSearchParams({
    action: "wbgetentities",
    sites: site,
    titles: title,
    props: "claims|descriptions|labels|sitelinks",
    languages: ctx.globalArgs.language,
    format: "json",
    origin: "*",
  });
  return `${ctx.globalArgs.apiUrl}?${params}`;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** The shape of a wbgetentities response's entity object (loose). */
interface Entity {
  id: string;
  type: string;
  labels?: Record<string, { language: string; value: string }>;
  descriptions?: Record<string, { language: string; value: string }>;
  sitelinks?: Record<string, { site: string; title: string; url?: string }>;
  claims?: Record<string, unknown>;
  missing?: boolean;
}

/** Extract the `entities` map from a wbgetentities response. */
export function parseEntities(parsed: unknown): Record<string, Entity> | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = (parsed as Record<string, unknown>)["entities"];
  return (e && typeof e === "object" ? e : null) as
    | Record<string, Entity>
    | null;
}

/** Resolve a label/description for a given language (falls back to first). */
export function localized(
  map: Record<string, { language: string; value: string }> | undefined,
  lang: string,
): string | null {
  if (!map) return null;
  if (map[lang]) return map[lang]!.value;
  const first = Object.values(map)[0];
  return first ? first.value : null;
}

/**
 * Extract the value QIDs from a single property's claims. Handles the common
 * "value" and "somevalue"/"novalue" snak shapes.
 */
export function extractClaimValues(claims: unknown[] | undefined): string[] {
  if (!Array.isArray(claims)) return [];
  const out: string[] = [];
  for (const claim of claims) {
    const mainsnak = (claim as Record<string, unknown>)["mainsnak"] as
      | Record<string, unknown>
      | undefined;
    const datavalue = mainsnak?.["datavalue"] as
      | { value?: { id?: string } }
      | undefined;
    const id = datavalue?.value?.id;
    if (id) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const SourceSchema = z.enum(["public-cache", "enterprise-cache", "none"]);
type Source = z.infer<typeof SourceSchema>;

const SearchResultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    id: z.string(),
    label: z.string().nullable(),
    description: z.string().nullable(),
    url: z.string().nullable(),
  })),
  cached: z.boolean(),
  source: SourceSchema,
});

const EntityResultSchema = z.object({
  id: z.string(),
  entity: z.object({
    id: z.string(),
    label: z.string().nullable(),
    description: z.string().nullable(),
    sitelinks: z.record(z.string(), z.unknown()).nullable(),
    claims: z.record(z.string(), z.unknown()).nullable(),
  }).nullable(),
  missing: z.boolean(),
  cached: z.boolean(),
  source: SourceSchema,
});

const ResolutionResultSchema = z.object({
  title: z.string(),
  site: z.string(),
  id: z.string().nullable(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  cached: z.boolean(),
  source: SourceSchema,
});

const ClaimsResultSchema = z.object({
  id: z.string(),
  property: z.string(),
  values: z.array(z.string()),
  cached: z.boolean(),
  source: SourceSchema,
});

const InstanceOfResultSchema = z.object({
  id: z.string(),
  instanceOf: z.array(z.string()),
  cached: z.boolean(),
  source: SourceSchema,
});

const UrlResultSchema = z.object({
  url: z.string(),
  urls: z.array(z.string()),
});

const EnterprisePlanArgsSchema = z.object({
  id: z.string().min(1).describe("Wikidata QID or PID"),
  runId: z.string().optional()
    .describe("Workflow run id used to namespace private plan/token files"),
  instanceKey: z.string().optional()
    .describe("Unique resource-instance suffix (pass ${{ run.id }})"),
  url: z.string().url().optional()
    .describe("Public URL override (defaults to the entity URL)"),
  publicUrl: z.string().optional()
    .describe("Explicit public cache/request URL"),
});

const EnterpriseSessionArgsSchema = z.object({
  responseFile: z.string()
    .describe("Path curl wrote the login/refresh response body to"),
  // swamp-quality-ignore credentials-sensitive-field: holds a token file path, not the secret
  tokenFile: z.string()
    .describe("0600 bearer-token file web-cache will read"),
  bodyFile: z.string().optional()
    .describe("Optional 0600 login/refresh request body file to delete"),
  instanceKey: z.string().optional()
    .describe("Unique resource-instance suffix for the result"),
});

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

const EnterpriseFailureArgsSchema = z.object({
  kind: z.enum(["auth", "rate"]).default("auth"),
});

const EnterpriseCleanupArgsSchema = z.object({
  workDir: z.string().default(""),
  files: z.array(z.string()).default([]),
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
  quota: EnterpriseUsageResultSchema.extend({
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
  quota: EnterpriseUsageResultSchema.extend({
    available: z.boolean(),
    reason: z.string(),
  }),
  eligible: z.boolean(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Dual-cache resolution (public URL first, then Enterprise URL)
// ---------------------------------------------------------------------------

interface ResolvedEntity {
  entity: Entity | null;
  source: Source;
}

async function resolveEntity(
  ctx: MethodContext,
  id: string,
  publicUrl: string,
): Promise<ResolvedEntity> {
  const dir = expandHome(ctx.globalArgs.cacheDir);
  const publicBody = await readCachedBody(dir, publicUrl);
  if (publicBody != null) {
    try {
      const entities = parseEntities(JSON.parse(publicBody));
      if (entities) {
        const entity = entities[id] ??
          (Object.keys(entities).length === 1
            ? Object.values(entities)[0]!
            : null);
        if (entity) return { entity, source: "public-cache" };
      }
    } catch {
      // treat as a miss
    }
  }

  const enterpriseBody = await readCachedBody(
    dir,
    enterpriseEntityUrl(ctx, id),
  );
  if (enterpriseBody != null) {
    const article = parseEnterpriseArticle(enterpriseBody);
    if (article) {
      return {
        entity: enterpriseEntityToPublic(article, id) as unknown as Entity,
        source: "enterprise-cache",
      };
    }
  }
  return { entity: null, source: "none" };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A read-only Wikidata domain client layered over @svendowideit/web-cache. */
export const model = {
  type: "@svendowideit/wikidata",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.20.3",
      description:
        "No schema changes — export URL builders/cache helpers for testing and " +
        "add method execute-path test coverage",
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
        "Add dual-cache reads (public + Enterprise Wikidata URLs) and " +
        "Enterprise planning/session/quota methods; propagate the run-level " +
        "maxFetches budget through the workflows. No direct HTTP.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.24.2",
      description:
        "Add Wikimedia Enterprise Wikidata lookups (items/properties) with " +
        "dual-cache reads, Enterprise planning/session/quota and public " +
        "fallback; maxFetches=0 is unlimited.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    search: {
      description: "Parsed wbsearchentities results",
      schema: SearchResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    entity: {
      description: "A parsed Wikidata entity (claims, labels, descriptions)",
      schema: EntityResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    resolution: {
      description: "Resolved Wikipedia title → Wikidata QID via its sitelink",
      schema: ResolutionResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    claims: {
      description: "Extracted property claim values for an entity",
      schema: ClaimsResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "instance-of": {
      description: "Instance-of (P31) value QIDs for an entity",
      schema: InstanceOfResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    url: {
      description: "A built Wikidata URL (for the fetch seam)",
      schema: UrlResultSchema,
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
      schema: z.object({
        username: z.string().optional(),
        accessToken: z.string().optional().meta({ sensitive: true }),
        refreshToken: z.string().optional().meta({ sensitive: true }),
        expiresAt: z.string().optional(),
        obtainedAt: z.string().optional(),
        via: z.string().optional(),
      }),
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
        "Wikimedia Enterprise Wikidata monthly request counter and cooldown state",
      schema: EnterpriseUsageResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-usage-result": {
      description: "Updated Enterprise Wikidata usage after a record/failure",
      schema: EnterpriseUsageResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-status": {
      description:
        "Read-only Wikimedia Enterprise Wikidata credential and quota report",
      schema: EnterpriseStatusSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "enterprise-cleanup": {
      description: "Count of temporary Enterprise plan files removed",
      schema: z.object({ deleted: z.number().int().nonnegative() }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    "search-url": {
      description:
        "Build the wbsearchentities URL (no fetching). Use this to feed a " +
        "web-cache fetch step, then `search` to parse the cached result.",
      arguments: SearchUrlArgsSchema,
      execute: async (args: SearchUrlArgs, context: MethodContext) => {
        const url = searchUrl(
          context,
          args.query,
          args.limit,
          context.globalArgs.language,
        );
        const handle = await context.writeResource("url", "search-url", {
          url,
          urls: [url],
        });
        context.logger.info("Built Wikidata search URL for {query}", {
          query: args.query,
        });
        return { dataHandles: [handle] };
      },
    },
    "entity-url": {
      description:
        "Build the wbgetentities URL for a QID (no fetching). Use this to feed " +
        "a web-cache fetch step, then `get-entity` / `get-claims` / " +
        "`get-instance-of` to parse the cached result.",
      arguments: EntityUrlArgsSchema,
      execute: async (args: EntityUrlArgs, context: MethodContext) => {
        const url = entityUrl(context, args.id);
        const handle = await context.writeResource("url", "entity-url", {
          url,
          urls: [url],
        });
        context.logger.info("Built Wikidata entity URL for {id}", {
          id: args.id,
        });
        return { dataHandles: [handle] };
      },
    },
    "resolve-title-url": {
      description:
        "Build the sitelink-lookup URL (title → QID) (no fetching). Use this " +
        "to feed a web-cache fetch step, then `resolve-title` to parse.",
      arguments: ResolveTitleUrlArgsSchema,
      execute: async (args: ResolveTitleUrlArgs, context: MethodContext) => {
        const site = args.site ?? context.globalArgs.site;
        const url = sitelinkUrl(context, args.title, site);
        const handle = await context.writeResource(
          "url",
          "resolve-title-url",
          { url, urls: [url] },
        );
        context.logger.info("Built sitelink URL for {title}", {
          title: args.title,
        });
        return { dataHandles: [handle] };
      },
    },
    "search": {
      description:
        "Parse a cached wbsearchentities response into matching entities " +
        "(id, label, description). Reads from the shared web cache.",
      arguments: SearchArgsSchema,
      execute: async (args: SearchArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const lang = args.language ?? context.globalArgs.language;
        const url = args.url ??
          searchUrl(context, args.query, args.limit, lang);
        const body = await readCachedBody(dir, url);

        const results: {
          id: string;
          label: string | null;
          description: string | null;
          url: string | null;
        }[] = [];
        if (body) {
          try {
            const parsed = JSON.parse(body) as {
              search?: {
                id?: string;
                label?: string;
                description?: string;
                url?: string;
              }[];
            };
            for (const hit of parsed.search ?? []) {
              results.push({
                id: hit.id ?? "",
                label: hit.label ?? null,
                description: hit.description ?? null,
                url: hit.url ?? null,
              });
            }
          } catch {
            // ignore — treat as miss
          }
        }

        const result = {
          query: args.query,
          results,
          cached: body != null,
          source: body != null ? "public-cache" : "none",
        };
        const handle = await context.writeResource(
          "search",
          `search-${args.query}`,
          result,
        );
        context.logger.info("Searched {query}: {n} results ({src})", {
          query: args.query,
          n: results.length,
          src: body != null ? "cache" : "miss",
        });
        return { dataHandles: [handle] };
      },
    },
    "get-entity": {
      description:
        "Parse a cached wbgetentities response for a QID into its entity " +
        "(id, label, description, sitelinks, and raw claims).",
      arguments: GetEntityArgsSchema,
      execute: async (args: GetEntityArgs, context: MethodContext) => {
        const publicUrl = args.url ?? entityUrl(context, args.id);
        const resolved = await resolveEntity(context, args.id, publicUrl);
        const entity = resolved.entity;

        const lang = context.globalArgs.language;
        const result = {
          id: args.id,
          entity: entity
            ? {
              id: entity.id,
              label: localized(entity.labels, lang),
              description: localized(entity.descriptions, lang),
              sitelinks: entity.sitelinks ?? null,
              claims: entity.claims ?? null,
            }
            : null,
          missing: entity?.missing === true,
          cached: resolved.source !== "none",
          source: resolved.source,
        };
        const handle = await context.writeResource(
          "entity",
          `entity-${args.id}`,
          result,
        );
        context.logger.info("Got entity {id} ({src})", {
          id: args.id,
          src: resolved.source,
        });
        return { dataHandles: [handle] };
      },
    },
    "resolve-title": {
      description:
        "Resolve a page title to a Wikidata QID via its sitelink. Returns the " +
        "entity id (and label/description) for the matching site+title.",
      arguments: ResolveTitleArgsSchema,
      execute: async (args: ResolveTitleArgs, context: MethodContext) => {
        const dir = expandHome(context.globalArgs.cacheDir);
        const site = args.site ?? context.globalArgs.site;
        const url = args.url ?? sitelinkUrl(context, args.title, site);
        const body = await readCachedBody(dir, url);

        let id: string | null = null;
        let entity: Entity | null = null;
        if (body) {
          try {
            const entities = parseEntities(JSON.parse(body));
            for (const e of Object.values(entities ?? {})) {
              if (e.sitelinks?.[site]?.title === args.title) {
                id = e.id;
                entity = e;
                break;
              }
            }
            // Fall back to the only entity returned.
            if (!id && entities && Object.keys(entities).length === 1) {
              const only = Object.values(entities)[0]!;
              id = only.id;
              entity = only;
            }
          } catch {
            // ignore
          }
        }

        const lang = context.globalArgs.language;
        const result = {
          title: args.title,
          site,
          id,
          label: entity ? localized(entity.labels, lang) : null,
          description: entity ? localized(entity.descriptions, lang) : null,
          cached: body != null,
          source: body != null ? "public-cache" : "none",
        };
        const handle = await context.writeResource(
          "resolution",
          `resolution-${args.title}`,
          result,
        );
        context.logger.info("Resolved {title} → {id} ({src})", {
          title: args.title,
          id: id ?? "not-found",
          src: body != null ? "cache" : "miss",
        });
        return { dataHandles: [handle] };
      },
    },
    "get-claims": {
      description:
        "Extract the value QIDs for a single property (e.g. P31) from a cached " +
        "entity. Returns the list of claim value ids.",
      arguments: GetClaimsArgsSchema,
      execute: async (args: GetClaimsArgs, context: MethodContext) => {
        const publicUrl = args.url ?? entityUrl(context, args.id);
        const resolved = await resolveEntity(context, args.id, publicUrl);
        const entity = resolved.entity;
        const claims = entity?.claims?.[args.property] as
          | unknown[]
          | undefined;
        const values = extractClaimValues(claims);

        const result = {
          id: args.id,
          property: args.property,
          values,
          cached: resolved.source !== "none",
          source: resolved.source,
        };
        const handle = await context.writeResource(
          "claims",
          `claims-${args.id}-${args.property}`,
          result,
        );
        context.logger.info(
          "Extracted {property} from {id}: {n} values ({src})",
          {
            property: args.property,
            id: args.id,
            n: values.length,
            src: resolved.source,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "get-instance-of": {
      description:
        "Convenience: extract the instance-of (P31) value QIDs from a cached " +
        "entity. Useful for classifying what a thing is (person vs book vs …).",
      arguments: GetInstanceOfArgsSchema,
      execute: async (args: GetInstanceOfArgs, context: MethodContext) => {
        const publicUrl = args.url ?? entityUrl(context, args.id);
        const resolved = await resolveEntity(context, args.id, publicUrl);
        const entity = resolved.entity;
        const claims = entity?.claims?.["P31"] as unknown[] | undefined;
        const values = extractClaimValues(claims);

        const result = {
          id: args.id,
          instanceOf: values,
          cached: resolved.source !== "none",
          source: resolved.source,
        };
        const handle = await context.writeResource(
          "instance-of",
          `instance-of-${args.key || args.id}`,
          result,
        );
        context.logger.info("Instance-of {id}: {n} values ({src})", {
          id: args.id,
          n: values.length,
          src: resolved.source,
        });
        return { dataHandles: [handle] };
      },
    },
    "enterprise-plan": {
      description:
        "Decide whether an entity should come from Wikimedia Enterprise or the " +
        "public API, and write the private files the fetch workflow needs. " +
        "Makes no request. The returned cache URLs are the public entity URL and " +
        "the synthetic Enterprise Wikidata URL.",
      arguments: EnterprisePlanArgsSchema,
      execute: async (
        args: z.infer<typeof EnterprisePlanArgsSchema>,
        context: MethodContext,
      ) => {
        const publicUrl = args.publicUrl || args.url ||
          entityUrl(context, args.id);
        const plan = await enterprisePlan(
          context,
          args.id,
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
          "Enterprise Wikidata plan for {id}: {provider} ({reason})",
          { id: args.id, provider: plan.provider, reason: plan.reason },
        );
        return { dataHandles: [handle] };
      },
    },
    "enterprise-session": {
      description:
        "Parse curl's login/refresh response, persist the session and write the " +
        "0600 bearer-token file web-cache reads. Deletes the temporary auth files.",
      arguments: EnterpriseSessionArgsSchema,
      execute: async (
        args: z.infer<typeof EnterpriseSessionArgsSchema>,
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
            "Enterprise Wikidata session saved (expires {expiresAt})",
            { expiresAt: result.expiresAt ?? "unknown" },
          );
        } else {
          context.logger.warn?.("Enterprise Wikidata session failed: {error}", {
            error: result.error ?? "unknown",
          });
        }
        return { dataHandles: [handle] };
      },
    },
    "enterprise-record": {
      description:
        "Record one successful Enterprise Wikidata lookup against the local " +
        "monthly budget. Call only after an origin fetch, not on a cache hit.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const usage = await recordEnterpriseUsage(context);
        const handle = await context.writeResource(
          "enterprise-usage-result",
          "enterprise-usage-result",
          usage as unknown as Record<string, unknown>,
        );
        context.logger.info("Enterprise Wikidata usage: {used}/{limit}", {
          used: usage.used,
          limit: usage.limit,
        });
        return { dataHandles: [handle] };
      },
    },
    "enterprise-failure": {
      description:
        "Record an Enterprise Wikidata auth failure or allowance/rate-limit so " +
        "the next plan backs off and falls back to public.",
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
        context.logger.warn?.(
          "Enterprise Wikidata {kind} cooldown recorded",
          { kind: args.kind },
        );
        return { dataHandles: [handle] };
      },
    },
    "enterprise-cleanup": {
      description:
        "Delete temporary Enterprise plan/auth files. Best-effort and safe to " +
        "call repeatedly.",
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
        context.logger.info("Cleaned up Enterprise Wikidata plan files", {
          workDir: args.workDir || "none",
        });
        return { dataHandles: [handle] };
      },
    },
    "enterprise-status": {
      description:
        "Report Wikimedia Enterprise Wikidata readiness without making a request " +
        "or printing a secret: vault keys present, session validity, monthly " +
        "quota usage, cooldown state and the current decision.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const status = await enterpriseStatus(context);
        const handle = await context.writeResource(
          "enterprise-status",
          "enterprise-status",
          status as unknown as Record<string, unknown>,
        );
        context.logger.info("Enterprise Wikidata status: {reason}", {
          reason: status.reason,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
