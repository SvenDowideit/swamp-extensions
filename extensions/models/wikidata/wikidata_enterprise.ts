/**
 * Wikimedia Enterprise planning, session and quota support for
 * `@svendowideit/wikipedia`.
 *
 * This module deliberately makes **no HTTP requests**. It knows how to:
 *
 *   - discover credentials in a swamp vault,
 *   - decide whether an Enterprise lookup is allowed (credentials + local
 *     monthly quota + cooldown),
 *   - write a private login/refresh request body and a private bearer-token
 *     file for the fetch layer (`@svendowideit/curl` + `@svendowideit/web-cache`),
 *   - parse the cached Enterprise Wikidata payload into the same entity shape
 *     the public wbgetentities path already produces, and
 *   - persist the JWT session and monthly usage counters.
 *
 * The Enterprise entity URL is an ordinary GET URL, so
 * `@svendowideit/web-cache` can cache it just like a public Wikidata URL. That
 * gives every entity two possible cache locations: the public URL and the
 * Enterprise URL.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Cache helpers (must match @svendowideit/web-cache)
// ---------------------------------------------------------------------------

function expandHome(raw: string): string {
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

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

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

function webCacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  const safe = normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe}-${fnv1a(normalized)}`;
}

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
// Constants and types
// ---------------------------------------------------------------------------

/** Default vault holding Wikimedia Enterprise credentials. */
export const DEFAULT_ENTERPRISE_VAULT = "enterprise-wikimedia";
/** Resource instance that persists the JWT session (sensitives). */
export const SESSION_RESOURCE = "enterprise-session";
/** Resource instance that persists monthly Enterprise usage. */
export const USAGE_RESOURCE = "enterprise-usage";

/** Global arguments specific to Wikimedia Enterprise. */
export interface EnterpriseGlobalArgs {
  cacheDir: string;
  enterpriseVaultName: string;
  enterpriseUsernameKey: string;
  enterprisePasswordKey: string;
  enterpriseAccessTokenKey: string;
  enterpriseRefreshTokenKey: string;
  enterpriseApiUrl: string;
  enterpriseAuthUrl: string;
  enterpriseMonthlyQuota: number;
}

/** A swamp method context augmented with the services Enterprise needs. */
export interface EnterpriseContext {
  globalArgs: EnterpriseGlobalArgs;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
    debug?: (message: string, props?: Record<string, unknown>) => void;
    warn?: (message: string, props?: Record<string, unknown>) => void;
  };
  readResource?: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
}

/** Credentials discovered in the vault. Empty strings mean "not present". */
export interface EnterpriseCredentials {
  username: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

/** Persisted JWT session. */
export interface EnterpriseSession {
  username?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  obtainedAt?: string;
  via?: string;
}

/** Persisted monthly usage counters. */
export interface EnterpriseUsage {
  month: string;
  used: number;
  limit: number;
  remaining: number | null;
  exhausted: boolean;
  rateLimitedUntil: number;
  authFailedUntil: number;
  updatedAt: string;
}

/** Current quota state, including whether Enterprise may be used right now. */
export interface EnterpriseQuota extends EnterpriseUsage {
  available: boolean;
  reason: string;
}

/** The subset of the Enterprise Wikidata payload this extension consumes. */
export interface EnterpriseArticle {
  name?: string;
  identifier?: number;
  url?: string;
  entity?: {
    identifier?: string;
    type?: string;
    labels?: Record<string, string>;
    descriptions?: Record<string, string>;
    sitelinks?: Record<string, unknown>;
    statements?: Record<string, unknown[]>;
  };
  [key: string]: unknown;
}

/** A generic login/refresh request the workflow sends through curl. */
export interface EnterpriseAuthPlan {
  url: string;
  method: "POST";
  /** 0600 file containing the JSON request body. */
  bodyFile: string;
  /** Path curl writes the response body to (maxBodyBytes=0). */
  responseFile: string;
  /** Non-secret account name, used when persisting the session. */
  username: string;
  via: "login" | "refresh";
}

/** The source-selection plan consumed by the wikipedia fetch workflow. */
export interface EnterprisePlan {
  provider: "enterprise" | "public" | "cache";
  reason: string;
  /** Public MediaWiki URL/cache key. */
  publicUrl: string;
  /** Synthetic Enterprise entity URL/cache key. */
  enterpriseUrl: string;
  /** Directory holding the plan's private files. */
  workDir: string;
  /** 0600 bearer-token file for web-cache. */
  tokenFile: string;
  /** Login/refresh request when a new token must be obtained. */
  auth: EnterpriseAuthPlan | null;
  quota: EnterpriseQuota;
  credentials: {
    hasUsername: boolean;
    hasPassword: boolean;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
  };
}

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Vault names to try, normalising the invalid underscore spelling. */
export function enterpriseVaultCandidates(
  ctx: Pick<EnterpriseContext, "globalArgs">,
): string[] {
  const configured = ctx.globalArgs.enterpriseVaultName;
  return dedupe([
    configured,
    configured.replace(/_/g, "-"),
    DEFAULT_ENTERPRISE_VAULT,
    "enterprise_wikimedia",
  ]);
}

async function readVaultSecret(
  ctx: EnterpriseContext,
  keys: string[],
): Promise<string> {
  if (!ctx.vaultService) return "";
  for (const vaultName of enterpriseVaultCandidates(ctx)) {
    for (const key of dedupe(keys)) {
      try {
        const value = await ctx.vaultService.get(
          vaultName,
          key,
          "model:wikipedia",
        );
        if (value) return value;
      } catch {
        // Missing vault/key or invalid name; try the next candidate.
      }
    }
  }
  return "";
}

/** Discover all credential material the vault holds. */
export async function readCredentials(
  ctx: EnterpriseContext,
): Promise<EnterpriseCredentials> {
  const g = ctx.globalArgs;
  const username = await readVaultSecret(ctx, [
    g.enterpriseUsernameKey,
    "username",
    "USERNAME",
    "email",
    "EMAIL",
  ]);
  const password = await readVaultSecret(ctx, [
    g.enterprisePasswordKey,
    "password",
    "PASSWORD",
  ]);
  const accessToken = await readVaultSecret(ctx, [
    g.enterpriseAccessTokenKey,
    "access_token",
    "ACCESS_TOKEN",
    "token",
    "TOKEN",
    "bearer_token",
    "BEARER_TOKEN",
  ]);
  const refreshToken = await readVaultSecret(ctx, [
    g.enterpriseRefreshTokenKey,
    "refresh_token",
    "REFRESH_TOKEN",
  ]);
  return { username, password, accessToken, refreshToken };
}

/** True when the discovered material can produce an access token. */
export function credentialsAvailable(creds: EnterpriseCredentials): boolean {
  return Boolean(
    creds.accessToken ||
      (creds.refreshToken && creds.username) ||
      (creds.username && creds.password),
  );
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

async function readSession(
  ctx: EnterpriseContext,
): Promise<EnterpriseSession | null> {
  if (!ctx.readResource) return null;
  try {
    const raw = await ctx.readResource(SESSION_RESOURCE);
    return raw ? raw as EnterpriseSession : null;
  } catch {
    return null;
  }
}

async function writeSession(
  ctx: EnterpriseContext,
  session: EnterpriseSession,
): Promise<void> {
  try {
    await ctx.writeResource(
      "enterprise-session",
      SESSION_RESOURCE,
      session as Record<string, unknown>,
    );
  } catch {
    // Session persistence is an optimisation; the token file still works.
  }
}

function validSessionToken(session: EnterpriseSession | null): string {
  if (!session?.accessToken) return "";
  if (!session.expiresAt) return session.accessToken;
  const expires = Date.parse(session.expiresAt);
  return Number.isFinite(expires) && expires <= Date.now() + 60_000
    ? ""
    : session.accessToken;
}

function expiresAtFromSeconds(seconds: unknown): string {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(Date.now() + n * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Private files
// ---------------------------------------------------------------------------

function privateDir(ctx: EnterpriseContext, runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
  return `${expandHome(ctx.globalArgs.cacheDir)}/.enterprise/${safe}`;
}

async function ensurePrivateDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) await ensurePrivateDir(path.slice(0, slash));
  await Deno.writeTextFile(path, content);
  try {
    await Deno.chmod(path, 0o600);
  } catch {
    // chmod is best-effort (e.g. on Windows).
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// Quota tracking
// ---------------------------------------------------------------------------

function currentMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

async function readUsage(ctx: EnterpriseContext): Promise<EnterpriseUsage> {
  const month = currentMonth();
  const limit = ctx.globalArgs.enterpriseMonthlyQuota;
  let stored: Partial<EnterpriseUsage> | null = null;
  if (ctx.readResource) {
    try {
      stored = (await ctx.readResource(USAGE_RESOURCE)) as
        | Partial<EnterpriseUsage>
        | null;
    } catch {
      stored = null;
    }
  }
  const sameMonth = stored?.month === month;
  const used = sameMonth && Number.isFinite(stored?.used) ? stored!.used! : 0;
  const remaining = limit > 0 ? Math.max(0, limit - used) : null;
  return {
    month,
    used,
    limit,
    remaining,
    exhausted: limit > 0 && used >= limit,
    rateLimitedUntil: sameMonth && Number.isFinite(stored?.rateLimitedUntil)
      ? stored!.rateLimitedUntil!
      : 0,
    authFailedUntil: sameMonth && Number.isFinite(stored?.authFailedUntil)
      ? stored!.authFailedUntil!
      : 0,
    updatedAt: sameMonth && stored?.updatedAt
      ? stored.updatedAt
      : new Date().toISOString(),
  };
}

async function writeUsage(
  ctx: EnterpriseContext,
  usage: EnterpriseUsage,
): Promise<void> {
  try {
    await ctx.writeResource(
      "enterprise-usage",
      USAGE_RESOURCE,
      usage as unknown as Record<string, unknown>,
    );
  } catch {
    // Usage tracking is best-effort.
  }
}

/** Current quota state, including whether Enterprise may be used right now. */
export async function quotaStatus(
  ctx: EnterpriseContext,
  now = Date.now(),
): Promise<EnterpriseQuota> {
  const usage = await readUsage(ctx);
  const rateLimited = usage.rateLimitedUntil > now;
  const authFailed = usage.authFailedUntil > now;
  const cooling = rateLimited || authFailed;
  const available = !usage.exhausted && !cooling;
  const reason = usage.exhausted
    ? "monthly quota exhausted"
    : rateLimited
    ? "rate-limit cooldown"
    : authFailed
    ? "authentication cooldown"
    : "quota available";
  return { ...usage, available, reason };
}

/** Record one successful Enterprise lookup. */
export async function recordEnterpriseUsage(
  ctx: EnterpriseContext,
): Promise<EnterpriseUsage> {
  const usage = await readUsage(ctx);
  const used = usage.used + 1;
  const limit = ctx.globalArgs.enterpriseMonthlyQuota;
  const updated: EnterpriseUsage = {
    ...usage,
    used,
    limit,
    remaining: limit > 0 ? Math.max(0, limit - used) : null,
    exhausted: limit > 0 && used >= limit,
    updatedAt: new Date().toISOString(),
  };
  await writeUsage(ctx, updated);
  return updated;
}

/** Record a failed Enterprise lookup so the next plan backs off. */
export async function recordEnterpriseFailure(
  ctx: EnterpriseContext,
  kind: "auth" | "rate",
): Promise<EnterpriseUsage> {
  const usage = await readUsage(ctx);
  const updated: EnterpriseUsage = kind === "auth"
    ? {
      ...usage,
      authFailedUntil: Date.now() + 5 * 60_000,
      updatedAt: new Date().toISOString(),
    }
    : {
      ...usage,
      rateLimitedUntil: Date.now() + 60_000,
      updatedAt: new Date().toISOString(),
    };
  await writeUsage(ctx, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Enterprise URL and payload parsing
// ---------------------------------------------------------------------------

/** The synthetic Enterprise Wikidata URL (also the cache key). */
export function enterpriseEntityUrl(
  ctx: Pick<EnterpriseContext, "globalArgs">,
  id: string,
): string {
  const base = ctx.globalArgs.enterpriseApiUrl.replace(/\/+$/, "");
  const clean = id.trim();
  const kind = /^P\d+$/i.test(clean) ? "properties" : "items";
  return `${base}/v2/wikidata/${kind}/${encodeURIComponent(clean)}`;
}

/** Parse a cached Enterprise Wikidata response (array or single object). */
export function parseEnterpriseArticle(
  body: string | null,
): EnterpriseArticle | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) {
      return (parsed[0] as EnterpriseArticle | undefined) ?? null;
    }
    if (parsed && typeof parsed === "object") {
      const candidate = parsed as EnterpriseArticle & {
        status?: number;
        message?: string;
      };
      if (candidate.status && candidate.message && !candidate.name) return null;
      return candidate.name || candidate.entity || candidate.identifier
        ? candidate
        : null;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Convert an Enterprise Wikidata payload into the public wbgetentities shape. */
export function enterpriseEntityToPublic(
  article: EnterpriseArticle,
  fallbackId: string,
): Record<string, unknown> {
  const entity = article.entity ?? {};
  const id = entity.identifier || article.name || fallbackId;
  const labels: Record<string, { language: string; value: string }> = {};
  for (const [lang, value] of Object.entries(entity.labels ?? {})) {
    labels[lang] = { language: lang, value };
  }
  const descriptions: Record<string, { language: string; value: string }> = {};
  for (const [lang, value] of Object.entries(entity.descriptions ?? {})) {
    descriptions[lang] = { language: lang, value };
  }
  const claims: Record<string, unknown[]> = {};
  for (const [pid, statements] of Object.entries(entity.statements ?? {})) {
    claims[pid] = (statements as Array<Record<string, unknown>>).map((stmt) => {
      const value = (stmt.value ?? {}) as {
        content?: string;
        content_data?: Record<string, unknown>;
      };
      const content = value.content ??
        (value.content_data?.id as string | undefined) ?? "";
      const datavalue = /^[QP]\d+$/i.test(content)
        ? { value: { id: content } }
        : { value: { content } };
      return { mainsnak: { datavalue } };
    });
  }
  return {
    id,
    type: entity.type ?? "item",
    labels,
    descriptions,
    sitelinks: entity.sitelinks ?? {},
    claims,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Decide whether an entity should be fetched from Enterprise or the public API.
 *
 * No request is made. When a new token is needed, a 0600 JSON request body is
 * written for curl; when a token is already available, a 0600 token file is
 * written for web-cache. The returned plan contains paths, never secrets.
 */
export async function enterprisePlan(
  ctx: EnterpriseContext,
  id: string,
  publicUrl: string,
  runId: string = crypto.randomUUID(),
): Promise<EnterprisePlan> {
  const workDir = privateDir(ctx, runId);
  await ensurePrivateDir(workDir);
  const tokenFile = `${workDir}/token`;
  const enterpriseUrl = enterpriseEntityUrl(ctx, id);
  const creds = await readCredentials(ctx);
  const quota = await quotaStatus(ctx);
  const credentials = {
    hasUsername: Boolean(creds.username),
    hasPassword: Boolean(creds.password),
    hasAccessToken: Boolean(creds.accessToken),
    hasRefreshToken: Boolean(creds.refreshToken),
  };
  const base: EnterprisePlan = {
    provider: "public",
    reason: "",
    publicUrl,
    enterpriseUrl,
    workDir,
    tokenFile,
    auth: null,
    quota,
    credentials,
  };

  const dir = expandHome(ctx.globalArgs.cacheDir);
  if ((await readCachedBody(dir, publicUrl)) != null) {
    return { ...base, provider: "cache", reason: "public cache" };
  }
  if ((await readCachedBody(dir, enterpriseUrl)) != null) {
    return { ...base, provider: "cache", reason: "enterprise cache" };
  }

  if (!credentialsAvailable(creds)) {
    return { ...base, reason: "no Enterprise credentials" };
  }
  if (!quota.available) {
    return { ...base, reason: quota.reason };
  }

  const session = await readSession(ctx);
  const sessionToken = validSessionToken(session);
  if (sessionToken) {
    await writePrivateFile(tokenFile, sessionToken);
    return { ...base, provider: "enterprise", reason: "session token" };
  }
  if (creds.accessToken) {
    await writePrivateFile(tokenFile, creds.accessToken);
    return { ...base, provider: "enterprise", reason: "vault access token" };
  }

  const authBase = ctx.globalArgs.enterpriseAuthUrl.replace(/\/+$/, "");
  const responseFile = `${workDir}/auth-response.json`;

  const refreshToken = session?.refreshToken || creds.refreshToken;
  const username = session?.username || creds.username;
  if (refreshToken && username) {
    const bodyFile = `${workDir}/auth-request.json`;
    await writePrivateFile(
      bodyFile,
      JSON.stringify({ username, refresh_token: refreshToken }),
    );
    return {
      ...base,
      provider: "enterprise",
      reason: "refresh token",
      auth: {
        url: `${authBase}/v1/token-refresh`,
        method: "POST",
        bodyFile,
        responseFile,
        username,
        via: "refresh",
      },
    };
  }

  if (creds.username && creds.password) {
    const bodyFile = `${workDir}/auth-request.json`;
    await writePrivateFile(
      bodyFile,
      JSON.stringify({
        username: creds.username,
        password: creds.password,
      }),
    );
    return {
      ...base,
      provider: "enterprise",
      reason: "username/password login",
      auth: {
        url: `${authBase}/v1/login`,
        method: "POST",
        bodyFile,
        responseFile,
        username: creds.username,
        via: "login",
      },
    };
  }

  return { ...base, reason: "no usable Enterprise auth" };
}

/**
 * Parse curl's login/refresh response, persist the session, and write the
 * 0600 bearer-token file web-cache will use. Deletes the temporary auth files.
 */
export async function enterpriseSessionFromResponse(
  ctx: EnterpriseContext,
  responseFile: string,
  tokenFile: string,
  bodyFile = "",
): Promise<{
  ok: boolean;
  error?: string;
  expiresAt?: string;
  tokenFile: string;
}> {
  const raw = await readFileOrNull(responseFile);
  await removeFile(responseFile);
  if (bodyFile) await removeFile(bodyFile);
  if (!raw) {
    return { ok: false, error: "auth response file missing", tokenFile };
  }

  let tokens: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    message?: string;
  };
  try {
    tokens = JSON.parse(raw);
  } catch {
    return { ok: false, error: "auth response is not JSON", tokenFile };
  }
  if (!tokens.access_token) {
    return {
      ok: false,
      error: tokens.message ?? "auth response has no access_token",
      tokenFile,
    };
  }

  const creds = await readCredentials(ctx);
  const previous = await readSession(ctx);
  const session: EnterpriseSession = {
    username: previous?.username || creds.username,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || previous?.refreshToken ||
      creds.refreshToken || "",
    expiresAt: expiresAtFromSeconds(tokens.expires_in),
    obtainedAt: new Date().toISOString(),
    via: tokens.refresh_token ? "login" : "refresh",
  };
  const token = session.accessToken!;
  await writeSession(ctx, session);
  await writePrivateFile(tokenFile, token);
  return { ok: true, expiresAt: session.expiresAt, tokenFile };
}

/** Remove temporary files created by a plan (best-effort). */
export async function cleanupEnterpriseFiles(files: string[]): Promise<void> {
  for (const file of files) {
    if (file) await removeFile(file);
  }
}

/** Remove a plan's private work directory, refusing paths outside it. */
export async function cleanupEnterpriseWorkDir(
  ctx: EnterpriseContext,
  workDir: string,
): Promise<void> {
  if (!workDir) return;
  const root = `${expandHome(ctx.globalArgs.cacheDir)}/.enterprise/`;
  if (!workDir.startsWith(root)) {
    // Never delete anything outside the wiki's private enterprise directory.
    return;
  }
  try {
    await Deno.remove(workDir, { recursive: true });
  } catch {
    // Already gone.
  }
}

/** Report credential presence and quota readiness without exposing secrets. */
export async function enterpriseStatus(ctx: EnterpriseContext) {
  const creds = await readCredentials(ctx);
  const session = await readSession(ctx);
  const sessionValid = Boolean(validSessionToken(session));
  const quota = await quotaStatus(ctx);
  const hasCredentials = credentialsAvailable(creds);
  return {
    vaultName: ctx.globalArgs.enterpriseVaultName,
    vaultNames: enterpriseVaultCandidates(ctx),
    project: "wikidata",
    hasUsername: Boolean(creds.username),
    hasPassword: Boolean(creds.password),
    hasAccessToken: Boolean(creds.accessToken),
    hasRefreshToken: Boolean(creds.refreshToken),
    hasCredentials,
    sessionValid,
    sessionVia: session?.via ?? null,
    sessionObtainedAt: session?.obtainedAt ?? null,
    sessionExpiresAt: session?.expiresAt ?? null,
    quota,
    eligible: hasCredentials && quota.available,
    reason: hasCredentials ? quota.reason : "no Enterprise credentials",
  };
}
