/**
 * `@svendowideit/garmin-connect` — the authenticated transport layer for the
 * `@svendowideit/garmin` extension family.
 *
 * Garmin Connect's API is **not** a set of anonymous GETs: it needs a signed
 * OAuth1 handshake to mint a rotating OAuth2 bearer token, and it rate-limits
 * aggressively. Rather than duplicate that in every data model, this model owns
 * *all* of it — one login, one token rotation, one rate-limit budget — and
 * exposes three things to the domain models:
 *
 *   - `login`        run the SSO → OAuth1 → OAuth2 chain (MFA-aware) and write
 *                    the `session` resource (tokens marked sensitive).
 *   - `import-tokens` seed the session from a `garth` token store without ever
 *                    handling a password.
 *   - `fetch` / `fetch-many`  authenticated GET of one or many `connectapi`
 *                    paths, cached on disk under `~/.swamp/garmin-cache` and
 *                    paced to respect Garmin's rate limits.
 *   - `download`     authenticated GET of a binary export (FIT/TCX/GPX/KML/CSV),
 *                    written as a model file artefact.
 *   - `setup`        report exactly what is configured and what is missing.
 *
 * Domain models never call `fetch` themselves and never see a token: a workflow
 * runs `fetch` for the raw responses it needs, then the domain model reads the
 * cached body and parses it — the same seam as `@svendowideit/web-cache` →
 * `@svendowideit/wikidata`.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  bearerUsable,
  beginLogin,
  completeLogin,
  completeMfa,
  CONNECTAPI_HOST,
  connectapiGet,
  createSession,
  exchangeOAuth2,
  type GarminAuthError,
  importTokenStore,
  type OAuth1Token,
  type OAuth2Token,
  redact,
  type TokenPair,
} from "./garmin_auth.ts";
import {
  type CacheEntry,
  cacheKey,
  expandHome,
  isFresh,
  loadBody,
  loadEntry,
  markRequestAt,
  normalizePath,
  readLastRequestAt,
  sleep,
  storeEntry,
} from "./garmin_cache.ts";

export {
  type CacheEntry,
  cacheKey,
  expandHome,
  fnv1a,
  isFresh,
  normalizePath,
  readCachedByPath,
} from "./garmin_cache.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default shared cache directory for raw Garmin responses. */
export const DEFAULT_CACHE_DIR = "~/.swamp/garmin-cache";
/** Default vault holding Garmin credentials and the persisted session. */
export const DEFAULT_VAULT = "garmin-secrets";
/** User-Agent sent on `connectapi` requests (matches garth's iOS client). */
export const API_USER_AGENT = "GCM-iOS-5.22.1.4";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  domain: z.string().default("garmin.com").describe(
    "Garmin region domain; use garmin.cn for the China region",
  ),
  vaultName: z.string().default(DEFAULT_VAULT).describe(
    "Vault the model reads credentials from and persists the session into",
  ),
  usernameKey: z.string().default("GARMIN_EMAIL").describe(
    "Vault key holding the Garmin account email",
  ),
  passwordKey: z.string().default("GARMIN_PASSWORD").describe(
    "Vault key holding the Garmin account password",
  ),
  mfaCodeKey: z.string().default("GARMIN_MFA_CODE").describe(
    "Vault key holding a one-time MFA code for a non-interactive first login",
  ),
  tokenStoreKey: z.string().default("GARMIN_TOKEN_STORE").describe(
    "Vault key holding a base64 `garth` token store (preferred: no password)",
  ),
  username: z.string().optional().describe(
    "Garmin email; normally left empty and read from the vault",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Garmin password; normally left empty and read from the vault",
  ),
  tokenStore: z.string().optional().meta({ sensitive: true }).describe(
    "Inline base64 token store; normally left empty and read from the vault",
  ),
  cacheDir: z.string().default(DEFAULT_CACHE_DIR).describe(
    "Shared directory raw Garmin responses are cached under",
  ),
  requestDelayMs: z.number().int().nonnegative().default(500).describe(
    "Minimum delay between origin requests, across runs (0 disables pacing)",
  ),
  maxRetries: z.number().int().nonnegative().default(2).describe(
    "Retries after HTTP 429/5xx, with exponential backoff",
  ),
  retryDelayMs: z.number().int().nonnegative().default(2000).describe(
    "Base backoff after a retryable failure (Retry-After takes precedence)",
  ),
  requestTimeoutMs: z.number().int().positive().default(30_000).describe(
    "Wall-clock budget for a single Garmin request",
  ),
  maxFetchesPerCall: z.number().int().positive().default(100).describe(
    "Maximum origin fetches a single fetch-many call makes (cached hits are free)",
  ),
  defaultMaxAgeMs: z.number().int().nonnegative().default(0).describe(
    "Default freshness window for cached responses (0 = always prefer the cache)",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const PathArg = z.string().min(1).describe(
  "connectapi path, e.g. /userprofile-service/socialProfile",
);

const FreshnessArgs = z.object({
  maxAgeMs: z.number().int().nonnegative().optional().describe(
    "Reject cache entries older than this (omit = global defaultMaxAgeMs)",
  ),
  forceRefresh: z.boolean().default(false).describe(
    "Bypass the cache and re-fetch from Garmin",
  ),
});

const LoginArgsSchema = z.object({
  interactiveMfa: z.string().optional().describe(
    "One-time MFA code to complete a challenge raised on a previous login run",
  ),
});

const ImportTokensArgsSchema = z.object({
  tokenStore: z.string().optional().describe(
    "Base64 `garth` token store; omit to read it from the vault",
  ),
});

const FetchArgsSchema = z.object({ path: PathArg }).extend(FreshnessArgs.shape);

const FetchManyArgsSchema = z.object({
  paths: z.array(z.string()).min(1).describe(
    "connectapi paths to fetch (each cached independently; blanks skipped)",
  ),
  maxFetches: z.number().int().positive().optional().describe(
    "Cap on origin fetches this call (omit = global maxFetchesPerCall)",
  ),
}).extend(FreshnessArgs.shape);

const DownloadArgsSchema = z.object({
  activityId: z.string().min(1).describe("Garmin activity id (numeric string)"),
  format: z.enum(["fit", "tcx", "gpx", "kml", "csv"]).default("fit").describe(
    "Export format; fit returns Garmin's original ZIP-wrapped FIT file",
  ),
});

const DownloadManyArgsSchema = z.object({
  activityIds: z.array(z.string()).min(1).describe(
    "Activity ids to download. Already-downloaded ids are skipped, so a " +
      "backlog drains across runs.",
  ),
  format: z.enum(["fit", "tcx", "gpx", "kml", "csv"]).default("fit").describe(
    "Export format applied to every id",
  ),
  maxDownloads: z.number().int().positive().optional().describe(
    "Cap on downloads this call (omit = global maxFetchesPerCall). Ids beyond " +
      "the cap are left for a later run.",
  ),
  skipExisting: z.boolean().default(true).describe(
    "Skip ids whose export is already stored, so re-runs are cheap",
  ),
});

const SetupArgsSchema = z.object({});

const EnsureArgsSchema = z.object({});

const ProfileArgsSchema = z.object({
  displayName: z.string().optional().describe(
    "Set the display name directly, skipping the network call",
  ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

/**
 * Authenticated session. Token values are marked `sensitive`, so swamp stores
 * them in the vault, never in the resource file.
 */
const SessionSchema = z.object({
  signedInAt: z.string(),
  via: z.string(),
  domain: z.string(),
  displayName: z.string().nullable(),
  expiresAt: z.string().nullable(),
  refreshTokenExpiresAt: z.string().nullable(),
  hasRefreshToken: z.boolean(),
  oauth1: z.object({
    oauth_token: z.string().meta({ sensitive: true }),
    oauth_token_secret: z.string().meta({ sensitive: true }),
    domain: z.string(),
  }),
  oauth2: z.object({
    scope: z.string(),
    token_type: z.string(),
    access_token: z.string().meta({ sensitive: true }),
    refresh_token: z.string().meta({ sensitive: true }),
    expires_in: z.number(),
    expires_at: z.number(),
    refresh_token_expires_in: z.number(),
    refresh_token_expires_at: z.number(),
  }),
});

const FetchResultSchema = z.object({
  path: z.string(),
  url: z.string(),
  key: z.string(),
  status: z.number().int().nullable(),
  contentType: z.string().nullable(),
  fromCache: z.boolean(),
  refreshed: z.boolean(),
  fetchedAt: z.string().nullable(),
  size: z.number().int().nonnegative(),
  /** The response body as UTF-8. Null when the fetch failed. */
  body: z.string().nullable(),
});

const BatchSummarySchema = z.object({
  processed: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  maxFetches: z.number().int().positive(),
  truncated: z.boolean(),
});

const DownloadResultSchema = z.object({
  activityId: z.string(),
  format: z.string(),
  path: z.string(),
  url: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  contentType: z.string().nullable(),
  downloadedAt: z.string(),
});

/** Summary of a `download-many` call. */
const DownloadBatchSchema = z.object({
  requested: z.number().int().nonnegative(),
  downloaded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  maxDownloads: z.number().int().positive(),
  truncated: z.boolean(),
  /** Ids that failed this call, so a later run can retry just those. */
  failedIds: z.array(z.string()),
});

/**
 * The account's social profile. Several Garmin endpoints are addressed by the
 * user's *display name* (e.g. the wellness daily summary and heart-rate
 * endpoints), so those paths cannot be built until it is known. Keeping it here
 * means every domain model reads it from one place instead of re-fetching it.
 */
const ProfileSchema = z.object({
  displayName: z.string(),
  /** `encodeURIComponent(displayName)` — what the path builders need. */
  displayNameEncoded: z.string(),
  fullName: z.string(),
  profileId: z.string().nullable(),
  fetchedAt: z.string(),
});

const SetupSchema = z.object({ report: z.string() });

/**
 * Session readiness after an `ensure` call. Written even when the session is
 * absent, so a workflow can guard on `ready` and assert on `reason`.
 */
const StatusSchema = z.object({
  ready: z.boolean(),
  reason: z.string(),
  checkedAt: z.string(),
  domain: z.string(),
  displayName: z.string().nullable(),
  bearerValid: z.boolean(),
  refreshValid: z.boolean(),
  refreshed: z.boolean(),
  expiresAt: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type ResDataHandle = { name: string };

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info(msg: string, p?: Record<string, unknown>): void;
    debug?(msg: string, p?: Record<string, unknown>): void;
    warn?(msg: string, p?: Record<string, unknown>): void;
  };
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<ResDataHandle>;
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: Record<string, unknown>,
  ) => {
    writeAll(content: Uint8Array): Promise<ResDataHandle>;
    writeText(text: string): Promise<ResDataHandle>;
  };
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
};

// ---------------------------------------------------------------------------
// Token/session helpers
// ---------------------------------------------------------------------------

/** Extract a token pair from a `session` resource payload. */
export function tokensFromSession(
  session: Record<string, unknown> | null,
): TokenPair | null {
  if (!session) return null;
  const oauth1 = session.oauth1 as OAuth1Token | undefined;
  const oauth2 = session.oauth2 as OAuth2Token | undefined;
  if (!oauth1?.oauth_token || !oauth2?.access_token) return null;
  return { oauth1, oauth2 };
}

/** Read a secret from the configured vault, returning "" when absent. */
async function readVaultSecret(
  ctx: MethodContext,
  key: string,
): Promise<string> {
  if (!ctx.vaultService) return "";
  try {
    return await ctx.vaultService.get(
      ctx.globalArgs.vaultName,
      key,
      "model:garmin-connect",
    );
  } catch {
    return "";
  }
}

/** Persist a token pair into the `session` resource (tokens sensitive). */
async function writeSession(
  ctx: MethodContext,
  pair: TokenPair,
  via: string,
  displayName: string | null,
  nowMs: number,
): Promise<ResDataHandle> {
  const { oauth1, oauth2 } = pair;
  return await ctx.writeResource("session", "session-auth", {
    signedInAt: new Date(nowMs).toISOString(),
    via,
    domain: oauth1.domain,
    displayName,
    expiresAt: Number.isFinite(oauth2.expires_at)
      ? new Date(oauth2.expires_at * 1000).toISOString()
      : null,
    refreshTokenExpiresAt: Number.isFinite(oauth2.refresh_token_expires_at)
      ? new Date(oauth2.refresh_token_expires_at * 1000).toISOString()
      : null,
    hasRefreshToken: Boolean(oauth2.refresh_token),
    oauth1,
    oauth2,
  });
}

/**
 * Build a session with a *usable* bearer token.
 *
 * Prefers the stored session; refreshes the bearer when it has expired (using
 * the stored OAuth1 token, no credentials); falls back to a full login only
 * when nothing else works.
 */
async function authedSession(
  ctx: MethodContext,
): Promise<
  { session: Awaited<ReturnType<typeof createSession>>; oauth2: OAuth2Token }
> {
  const g = ctx.globalArgs;
  const stored = tokensFromSession(await ctx.readResource("session-auth"));
  if (!stored) {
    throw new Error(
      "No Garmin session. Run `login` (or `import-tokens`) first: " +
        `swamp model @svendowideit/garmin-connect method run login <name>`,
    );
  }
  const session = await createSession(g.domain);
  const nowSec = Math.floor(Date.now() / 1000);
  if (bearerUsable(stored.oauth2, nowSec)) {
    return { session, oauth2: stored.oauth2 };
  }

  ctx.logger.info(
    "Bearer token expired; refreshing with the stored OAuth1 token",
  );
  const oauth2 = await exchangeOAuth2(session, stored.oauth1, false);
  await writeSession(
    ctx,
    { oauth1: stored.oauth1, oauth2 },
    "refresh",
    null,
    Date.now(),
  );
  return { session, oauth2 };
}

/** Error text without ever echoing a secret. */
function safeMessage(err: unknown): string {
  const e = err as Partial<GarminAuthError>;
  return e?.message ?? String(err);
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

/** Outcome of a cached authenticated GET. */
interface FetchOutcome {
  body: string | null;
  entry: CacheEntry | null;
  fromCache: boolean;
  refreshed: boolean;
}

/**
 * Perform an authenticated, paced, cached GET of one `connectapi` path.
 *
 * Cache-first unless bypassed or stale. On 429/5xx it backs off and retries,
 * then falls back to a stale cached body if one exists, so a rate-limited run
 * degrades to last-known data instead of failing.
 */
async function cachedFetch(
  ctx: MethodContext,
  session: Awaited<ReturnType<typeof createSession>>,
  oauth2: OAuth2Token,
  path: string,
  opts: { maxAgeMs?: number; forceRefresh?: boolean },
): Promise<FetchOutcome> {
  const g = ctx.globalArgs;
  const dir = expandHome(g.cacheDir);
  const key = cacheKey(path);
  const maxAgeMs = opts.maxAgeMs ?? g.defaultMaxAgeMs;
  await Deno.mkdir(dir, { recursive: true });

  const existing = await loadEntry(dir, key);
  if (
    existing && !opts.forceRefresh && isFresh(existing, maxAgeMs, Date.now())
  ) {
    return {
      body: await loadBody(dir, key),
      entry: existing,
      fromCache: true,
      refreshed: false,
    };
  }

  const url = `https://${CONNECTAPI_HOST}${normalizePath(path)}`;
  let attempt = 0;
  while (true) {
    const delay = g.requestDelayMs;
    if (delay > 0) {
      const last = await readLastRequestAt(dir);
      const wait = Math.max(0, last + delay - Date.now());
      if (wait > 0) await sleep(wait);
    }
    try {
      const res = await session.fetchImpl(url, {
        headers: {
          "User-Agent": API_USER_AGENT,
          Authorization: `Bearer ${oauth2.access_token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(g.requestTimeoutMs),
      });
      await markRequestAt(dir);

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < g.maxRetries) {
        attempt += 1;
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
        const wait = Number.isNaN(retryAfter)
          ? g.retryDelayMs * attempt
          : retryAfter * 1000;
        ctx.logger.warn?.(
          "GET {path} HTTP {status}; retry {n}/{max} after {wait}ms",
          { path, status: res.status, n: attempt, max: g.maxRetries, wait },
        );
        await sleep(wait);
        continue;
      }

      const body = await res.text();
      if (!res.ok) {
        ctx.logger.warn?.("GET {path} failed HTTP {status}", {
          path,
          status: res.status,
        });
        if (existing) {
          return {
            body: await loadBody(dir, key),
            entry: existing,
            fromCache: true,
            refreshed: false,
          };
        }
        return { body: null, entry: null, fromCache: false, refreshed: false };
      }

      const entry: CacheEntry = {
        key,
        path: normalizePath(path),
        url,
        status: res.status,
        ok: true,
        fetchedAt: new Date().toISOString(),
        contentType: res.headers.get("content-type"),
        size: new TextEncoder().encode(body).byteLength,
      };
      await storeEntry(dir, entry, body);
      return {
        body,
        entry,
        fromCache: false,
        refreshed: existing != null,
      };
    } catch (err) {
      await markRequestAt(dir);
      if (attempt < g.maxRetries) {
        attempt += 1;
        const wait = g.retryDelayMs * attempt;
        ctx.logger.warn?.(
          "GET {path} error ({err}); retry {n}/{max} after {wait}ms",
          { path, err: safeMessage(err), n: attempt, max: g.maxRetries, wait },
        );
        await sleep(wait);
        continue;
      }
      if (existing) {
        return {
          body: await loadBody(dir, key),
          entry: existing,
          fromCache: true,
          refreshed: false,
        };
      }
      return { body: null, entry: null, fromCache: false, refreshed: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Download paths
// ---------------------------------------------------------------------------

const DOWNLOAD_PREFIX: Record<string, string> = {
  fit: "/download-service/files/activity",
  tcx: "/download-service/export/tcx/activity",
  gpx: "/download-service/export/gpx/activity",
  kml: "/download-service/export/kml/activity",
  csv: "/download-service/export/csv/activity",
};

/** Build the `connectapi` download path for an activity + format. */
export function downloadPath(activityId: string, format: string): string {
  const prefix = DOWNLOAD_PREFIX[format];
  if (!prefix) throw new Error(`unsupported download format: ${format}`);
  return `${prefix}/${encodeURIComponent(activityId)}`;
}

/** Hex SHA-256 of a byte array. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Metadata recorded for one stored export. */
interface DownloadMeta {
  activityId: string;
  format: string;
  path: string;
  url: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
  downloadedAt: string;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

/**
 * Download one export and store it as a file artefact + metadata resource.
 *
 * Shared by `download` and `download-many` so both record identical metadata.
 * Returns `null` (rather than throwing) so a fan-out can continue past one bad
 * id; the caller decides whether a null is fatal.
 */
async function downloadOne(
  ctx: MethodContext,
  session: Awaited<ReturnType<typeof createSession>>,
  oauth2: OAuth2Token,
  activityId: string,
  format: string,
): Promise<{ meta: DownloadMeta; handles: ResDataHandle[] } | null> {
  const g = ctx.globalArgs;
  const path = downloadPath(activityId, format);
  const url = `https://${CONNECTAPI_HOST}${path}`;

  const res = await session.fetchImpl(url, {
    headers: {
      "User-Agent": API_USER_AGENT,
      Authorization: `Bearer ${oauth2.access_token}`,
      Accept: "application/octet-stream",
    },
    signal: AbortSignal.timeout(g.requestTimeoutMs),
  });
  if (!res.ok) {
    ctx.logger.warn?.("Download {id}.{fmt} failed HTTP {status}", {
      id: activityId,
      fmt: format,
      status: res.status,
    });
    return null;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = await sha256Hex(bytes);
  const instance = `${activityId}-${format}`;
  const writer = ctx.createFileWriter("export", instance);
  const fileHandle = await writer.writeAll(bytes);
  const meta: DownloadMeta = {
    activityId,
    format,
    path,
    url,
    bytes: bytes.byteLength,
    sha256: digest,
    contentType: res.headers.get("content-type"),
    downloadedAt: new Date().toISOString(),
  };
  const metaHandle = await ctx.writeResource("download", instance, meta);
  return { meta, handles: [fileHandle, metaHandle] };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The `@svendowideit/garmin-connect` model definition. */
export const model = {
  type: "@svendowideit/garmin-connect",
  version: "2026.09.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    session: {
      description:
        "Authenticated Garmin session; tokens are sensitive and stored in the vault",
      schema: SessionSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    fetch: {
      description: "One cached connectapi response (metadata + raw body)",
      schema: FetchResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    batch: {
      description: "Summary of a fetch-many call",
      schema: BatchSummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    download: {
      description: "Metadata for a downloaded binary activity export",
      schema: DownloadResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    downloads: {
      description: "Summary of a download-many call",
      schema: DownloadBatchSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    profile: {
      description:
        "The account's social profile, including the display name several " +
        "Garmin wellness endpoints are addressed by",
      schema: ProfileSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    setup: {
      description: "Configuration-readiness report",
      schema: SetupSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    status: {
      description:
        "Session readiness written by `ensure`, so a workflow can guard on " +
        "`ready` and assert on `reason`",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
  },
  files: {
    export: {
      description: "A downloaded activity export (FIT/TCX/GPX/KML/CSV)",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    setup: {
      description:
        "Report Garmin configuration readiness (region, vault keys, session " +
        "state) and the exact commands to fix gaps. Read-only; prints no secret.",
      arguments: SetupArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const session = await ctx.readResource("session-auth");
        const lines: string[] = [];
        lines.push("Garmin connect configuration");
        lines.push(`  region domain:   ${g.domain}`);
        lines.push(`  vault:           ${g.vaultName}`);
        lines.push(`  cache dir:       ${expandHome(g.cacheDir)}`);
        lines.push(`  pacing:          ${g.requestDelayMs}ms between requests`);
        lines.push("");
        lines.push("Credential source (first available wins):");
        for (const key of [g.tokenStoreKey, g.usernameKey, g.passwordKey]) {
          const value = await readVaultSecret(ctx, key);
          lines.push(`  ${key}: ${value ? "set" : "unset"}`);
        }
        lines.push("");
        const pair = tokensFromSession(session);
        if (pair) {
          const nowSec = Math.floor(Date.now() / 1000);
          lines.push(
            `Session: signed in ${session?.signedInAt ?? "?"} via ` +
              `${session?.via ?? "?"}`,
          );
          lines.push(
            `  bearer token: ${
              bearerUsable(pair.oauth2, nowSec)
                ? "valid"
                : "expired (will refresh)"
            }`,
          );
          lines.push(
            `  refresh token expires: ${
              session?.refreshTokenExpiresAt ?? "unknown"
            }`,
          );
          lines.push(`  account: ${session?.displayName ?? "(unknown)"}`);
        } else {
          lines.push("Session: none — log in first.");
        }
        lines.push("");
        lines.push("To fix a gap:");
        lines.push(
          `  swamp vault put ${g.vaultName} ${g.tokenStoreKey}   # preferred: base64 garth token store`,
        );
        lines.push(
          `  swamp vault put ${g.vaultName} ${g.usernameKey}`,
        );
        lines.push(
          `  swamp vault put ${g.vaultName} ${g.passwordKey}`,
        );
        lines.push(
          `  swamp model @svendowideit/garmin-connect method run login garmin-connect`,
        );
        const report = lines.join("\n");
        const handle = await ctx.writeResource("setup", "report", { report });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    "import-tokens": {
      description:
        "Seed the session from a base64 `garth` token store (Client.dumps " +
        "format), so no password is ever handled. Preferred for scheduled use.",
      arguments: ImportTokensArgsSchema,
      execute: async (
        args: z.infer<typeof ImportTokensArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const encoded = args.tokenStore?.trim() ||
          await readVaultSecret(ctx, g.tokenStoreKey);
        if (!encoded) {
          throw new Error(
            `No token store supplied. Store one in the vault: ` +
              `swamp vault put ${g.vaultName} ${g.tokenStoreKey}`,
          );
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const pair = importTokenStore(encoded, nowSec, g.domain);
        const handle = await writeSession(
          ctx,
          pair,
          "imported token store",
          null,
          Date.now(),
        );
        ctx.logger.info("Imported Garmin token store (region {domain})", {
          domain: pair.oauth1.domain,
        });
        return { dataHandles: [handle] };
      },
    },
    ensure: {
      description:
        "Ensure a usable Garmin session: reuse the stored bearer token when " +
        "valid, refresh it from the stored OAuth1 token when expired, and " +
        "otherwise report not-ready. Writes a `status` resource a workflow can " +
        "guard on. Requires no credentials — a refresh uses no password.",
      arguments: EnsureArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const nowSec = Math.floor(Date.now() / 1000);
        const stored = tokensFromSession(
          await ctx.readResource("session-auth"),
        );

        const notReady = async (reason: string) => {
          const handle = await ctx.writeResource("status", "session-status", {
            ready: false,
            reason,
            checkedAt: new Date().toISOString(),
            domain: g.domain,
            displayName: null,
            bearerValid: false,
            refreshValid: false,
            refreshed: false,
            expiresAt: null,
          });
          ctx.logger.warn?.("Garmin session not ready: {reason}", { reason });
          return { dataHandles: [handle] };
        };

        if (!stored) {
          return await notReady(
            "No session. Run `login` / `import-tokens`, or the garmin-session workflow.",
          );
        }

        const refreshValid = stored.oauth2.refresh_token_expires_at === 0 ||
          stored.oauth2.refresh_token_expires_at - 60 > nowSec;
        let refreshed = false;
        let oauth2 = stored.oauth2;

        if (!bearerUsable(oauth2, nowSec)) {
          if (!refreshValid) {
            return await notReady(
              "Refresh token expired. Re-login or import a fresh token store.",
            );
          }
          ctx.logger.info("Refreshing expired Garmin bearer token");
          const session = await createSession(g.domain);
          oauth2 = await exchangeOAuth2(session, stored.oauth1, false);
          refreshed = true;
          await writeSession(
            ctx,
            { oauth1: stored.oauth1, oauth2 },
            "refresh",
            null,
            Date.now(),
          );
        }

        const handle = await ctx.writeResource("status", "session-status", {
          ready: true,
          reason: refreshed ? "refreshed bearer token" : "bearer token valid",
          checkedAt: new Date().toISOString(),
          domain: g.domain,
          displayName: null,
          bearerValid: bearerUsable(oauth2, nowSec),
          refreshValid,
          refreshed,
          expiresAt: Number.isFinite(oauth2.expires_at)
            ? new Date(oauth2.expires_at * 1000).toISOString()
            : null,
        });
        ctx.logger.info("Garmin session ready ({how})", {
          how: refreshed ? "refreshed" : "valid",
        });
        return { dataHandles: [handle] };
      },
    },
    profile: {
      description:
        "Fetch the account's social profile and write the `profile` resource. " +
        "Several Garmin wellness endpoints are addressed by the user's display " +
        "name; domain models read it from here (with `displayNameEncoded` ready " +
        "for a URL path) instead of re-fetching it. Cache-first, like `fetch`. " +
        "Pass `displayName` to set it directly without a network call.",
      arguments: ProfileArgsSchema,
      execute: async (
        args: z.infer<typeof ProfileArgsSchema>,
        ctx: MethodContext,
      ) => {
        // An explicit display name skips the network entirely — useful when the
        // endpoint is unreachable or the value is known.
        let displayName = args.displayName?.trim() ?? "";
        let raw: Record<string, unknown> = {};
        if (!displayName) {
          const { session, oauth2 } = await authedSession(ctx);
          const out = await cachedFetch(
            ctx,
            session,
            oauth2,
            "/userprofile-service/socialProfile",
            {},
          );
          if (out.body === null) {
            throw new Error(
              "Could not fetch the Garmin social profile (no cached copy and " +
                "the request failed). Pass `displayName` to set it directly.",
            );
          }
          try {
            raw = JSON.parse(out.body) as Record<string, unknown>;
          } catch {
            throw new Error("Garmin social profile response was not JSON");
          }
          displayName = String(raw.displayName ?? raw.userName ?? "");
        }
        if (!displayName) {
          throw new Error(
            "Garmin social profile has no displayName; several wellness " +
              "endpoints cannot be addressed without it.",
          );
        }
        const handle = await ctx.writeResource("profile", "profile", {
          displayName,
          displayNameEncoded: encodeURIComponent(displayName),
          fullName: String(raw.fullName ?? ""),
          profileId: raw.profileId != null ? String(raw.profileId) : null,
          fetchedAt: new Date().toISOString(),
        });
        ctx.logger.info("Recorded Garmin profile for {name}", {
          name: displayName,
        });
        return { dataHandles: [handle] };
      },
    },
    login: {
      description:
        "Run the Garmin SSO → OAuth1 → OAuth2 login and persist the session. " +
        "If Garmin requires MFA, the run suspends with a challenge message; " +
        "re-run with interactiveMfa set to the one-time code. Credentials and " +
        "tokens are never logged.",
      arguments: LoginArgsSchema,
      execute: async (
        args: z.infer<typeof LoginArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const session = await createSession(g.domain);
        const nowMs = Date.now();

        let ticket: string;
        if (args.interactiveMfa) {
          ctx.logger.info("Completing MFA challenge");
          ticket = await completeMfa(session, args.interactiveMfa);
        } else {
          const username = g.username?.trim() ||
            await readVaultSecret(ctx, g.usernameKey);
          const password = g.password?.trim() ||
            await readVaultSecret(ctx, g.passwordKey);
          if (!username || !password) {
            throw new Error(
              `Garmin credentials missing. Store them: swamp vault put ` +
                `${g.vaultName} ${g.usernameKey} && swamp vault put ` +
                `${g.vaultName} ${g.passwordKey} — or import a token store ` +
                `instead.`,
            );
          }
          ctx.logger.info("Signing in to Garmin ({domain})", {
            domain: g.domain,
          });
          const result = await beginLogin(session, username, password);
          if (typeof result !== "string") {
            const mfa = Deno.env.get("GARMIN_MFA_CODE")?.trim() ||
              g.mfaCodeKey && await readVaultSecret(ctx, g.mfaCodeKey);
            if (mfa) {
              ctx.logger.info("MFA_REQUIRED — using the configured MFA code");
              ticket = await completeMfa(session, mfa, result.method);
            } else {
              throw new Error(
                `Garmin requires MFA (method: ${result.method}). Re-run with ` +
                  `the one-time code: swamp model @svendowideit/garmin-connect ` +
                  `method run login garmin-connect --input interactiveMfa=<code>`,
              );
            }
          } else {
            ticket = result;
          }
        }

        const pair = await completeLogin(session, ticket);
        const profile = await connectapiGet(
          session,
          pair.oauth2,
          "/userprofile-service/socialProfile",
        ) as Record<string, unknown>;
        const displayName = String(
          profile.displayName ?? profile.userName ?? "",
        ) || null;

        const handle = await writeSession(
          ctx,
          pair,
          args.interactiveMfa ? "mfa resume" : "password grant",
          displayName,
          nowMs,
        );
        ctx.logger.info(
          "Signed in to Garmin as {who}; session persisted (tokens redacted)",
          { who: displayName ?? "(unknown)", redacted: redact(pair.oauth2) },
        );
        return { dataHandles: [handle] };
      },
    },
    fetch: {
      description:
        "Authenticated GET of one connectapi path, cached on disk under " +
        "cacheDir. Domain models read the cached body via this result rather " +
        "than fetching themselves. Prefer fetch-many for several paths.",
      arguments: FetchArgsSchema,
      execute: async (
        args: z.infer<typeof FetchArgsSchema>,
        ctx: MethodContext,
      ) => {
        const { session, oauth2 } = await authedSession(ctx);
        const out = await cachedFetch(ctx, session, oauth2, args.path, args);
        const handle = await ctx.writeResource("fetch", cacheKey(args.path), {
          path: normalizePath(args.path),
          url: `https://${CONNECTAPI_HOST}${normalizePath(args.path)}`,
          key: cacheKey(args.path),
          status: out.entry?.status ?? null,
          contentType: out.entry?.contentType ?? null,
          fromCache: out.fromCache,
          refreshed: out.refreshed,
          fetchedAt: out.entry?.fetchedAt ?? null,
          size: out.entry?.size ?? 0,
          body: out.body,
        });
        ctx.logger.info("GET {path} ({src})", {
          path: args.path,
          src: out.fromCache
            ? "cache"
            : out.refreshed
            ? "refreshed"
            : "fetched",
        });
        return { dataHandles: [handle] };
      },
    },
    "fetch-many": {
      description:
        "Authenticated GET of many connectapi paths in one call, each cached " +
        "independently. Writes one fetch resource per path (keyed by cache " +
        "key) plus a batch summary. Origin fetches are capped (cached hits are " +
        "free), so a large backlog spreads across runs. Prefer this over " +
        "fanning out parallel fetch calls — one per-model lock acquisition.",
      arguments: FetchManyArgsSchema,
      execute: async (
        args: z.infer<typeof FetchManyArgsSchema>,
        ctx: MethodContext,
      ) => {
        const { session, oauth2 } = await authedSession(ctx);
        const maxFetches = args.maxFetches ?? ctx.globalArgs.maxFetchesPerCall;
        const handles: ResDataHandle[] = [];
        let fetched = 0;
        let cached = 0;
        let skipped = 0;
        let processed = 0;
        let capped = false;
        const seen = new Set<string>();
        for (const path of args.paths) {
          if (!path || path.trim() === "") {
            skipped += 1;
            processed += 1;
            continue;
          }
          const key = cacheKey(path);
          if (seen.has(key)) {
            skipped += 1;
            processed += 1;
            continue;
          }
          seen.add(key);
          if (fetched >= maxFetches) {
            capped = true;
            break;
          }
          const out = await cachedFetch(ctx, session, oauth2, path, args);
          processed += 1;
          const handle = await ctx.writeResource("fetch", key, {
            path: normalizePath(path),
            url: `https://${CONNECTAPI_HOST}${normalizePath(path)}`,
            key,
            status: out.entry?.status ?? null,
            contentType: out.entry?.contentType ?? null,
            fromCache: out.fromCache,
            refreshed: out.refreshed,
            fetchedAt: out.entry?.fetchedAt ?? null,
            size: out.entry?.size ?? 0,
            body: out.body,
          });
          handles.push(handle);
          if (out.fromCache) cached += 1;
          else fetched += 1;
        }
        const summary = {
          processed,
          fetched,
          cached,
          skipped,
          remaining: args.paths.length - processed,
          maxFetches,
          truncated: capped,
        };
        const summaryHandle = await ctx.writeResource(
          "batch",
          "fetch-many",
          summary,
        );
        handles.push(summaryHandle);
        ctx.logger.info(
          "GET many: {fetched} fetched, {cached} cache, {skipped} skipped, {remaining} left",
          { ...summary },
        );
        return { dataHandles: handles };
      },
    },
    download: {
      description:
        "Download one activity export (fit/tcx/gpx/kml/csv) and store it as a " +
        "model file artefact, returning its path, size and sha256. `fit` is " +
        "Garmin's original ZIP-wrapped FIT file.",
      arguments: DownloadArgsSchema,
      execute: async (
        args: z.infer<typeof DownloadArgsSchema>,
        ctx: MethodContext,
      ) => {
        const { session, oauth2 } = await authedSession(ctx);
        const result = await downloadOne(
          ctx,
          session,
          oauth2,
          args.activityId,
          args.format,
        );
        if (!result) {
          throw new Error(
            `Download ${args.activityId}.${args.format} failed — see the ` +
              `warning above for the HTTP status.`,
          );
        }
        ctx.logger.info(
          "Downloaded activity {id} as {format} ({bytes} bytes, {sha})",
          {
            id: args.activityId,
            format: args.format,
            bytes: result.meta.bytes,
            sha: result.meta.sha256.slice(0, 12),
          },
        );
        return { dataHandles: result.handles };
      },
    },
    "download-many": {
      description:
        "Download many activity exports in one call, storing each as a file " +
        "artefact. Skips ids already downloaded, caps downloads per call so a " +
        "backlog drains across runs, and continues past a single failure. " +
        "Prefer this over fanning out parallel download calls — one per-model " +
        "lock acquisition and one summary.",
      arguments: DownloadManyArgsSchema,
      execute: async (
        args: z.infer<typeof DownloadManyArgsSchema>,
        ctx: MethodContext,
      ) => {
        const { session, oauth2 } = await authedSession(ctx);
        const maxDownloads = args.maxDownloads ??
          ctx.globalArgs.maxFetchesPerCall;
        const handles: ResDataHandle[] = [];
        let downloaded = 0;
        let skipped = 0;
        let failed = 0;
        let processed = 0;
        let capped = false;
        const failedIds: string[] = [];

        for (const id of args.activityIds) {
          if (!id || id.trim() === "") {
            skipped += 1;
            processed += 1;
            continue;
          }
          if (args.skipExisting) {
            const existing = await ctx.readResource(`${id}-${args.format}`);
            if (existing) {
              skipped += 1;
              processed += 1;
              continue;
            }
          }
          if (downloaded >= maxDownloads) {
            capped = true;
            break;
          }
          const result = await downloadOne(
            ctx,
            session,
            oauth2,
            id,
            args.format,
          );
          processed += 1;
          if (result) {
            handles.push(...result.handles);
            downloaded += 1;
          } else {
            failed += 1;
            failedIds.push(id);
          }
        }

        const summary = {
          requested: args.activityIds.length,
          downloaded,
          skipped,
          failed,
          remaining: args.activityIds.length - processed,
          maxDownloads,
          truncated: capped,
          failedIds,
        };
        const summaryHandle = await ctx.writeResource(
          "downloads",
          "download-many",
          summary,
        );
        handles.push(summaryHandle);
        ctx.logger.info(
          "Downloaded {downloaded}, skipped {skipped}, failed {failed}, {remaining} left{cap}",
          {
            ...summary,
            cap: capped ? ` (cap ${maxDownloads})` : "",
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};
