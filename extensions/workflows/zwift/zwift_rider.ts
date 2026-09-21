/**
 * Zwift rider history — retrieves a rider's profile and ride history, and
 * derives the decayed ability and habit profile the recommender consumes.
 *
 * This model type wraps the parts of Zwift's undocumented API that describe
 * *you*: the athlete profile (`GET /api/profiles/me`), the activity history
 * (`GET /api/profiles/{id}/activities`), the best-power curve
 * (`GET /api/power-curve/best/all-time`), and the current racing score
 * (`GET /api/scoring/current`).
 *
 * Authentication is deliberately credential-agnostic: supply a username +
 * password, or a pre-obtained refresh token. Either can be given as a global
 * argument (normally a `${{ vault.get(...) }}` expression) or read directly
 * from the configured vault. A successful sign-in rotates the refresh token,
 * which is persisted in a `session` resource with the token marked
 * `sensitive: true` — swamp stores it in the vault, so subsequent runs reuse it
 * without re-sending the password.
 *
 * Everything that can be computed without a network call — local-time bucketing,
 * recency decay, power-to-weight bands — lives in `zwift_util.ts` and is
 * unit-tested separately.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { getAccessToken, type ZwiftTokens } from "./zwift_auth.ts";
import {
  clamp,
  decayWeight,
  DURATION_BUCKET_MINUTES,
  DURATION_BUCKETS,
  durationBucketIndex,
  durationBucketLabel,
  type LocalParts,
  localParts,
  mean,
  normalizeHistogram,
  parseTimeMs,
} from "./zwift_util.ts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  vaultName: z.string().default("zwift-secrets").describe(
    "Vault the model reads credentials from (and where it persists the " +
      "rotated refresh token)",
  ),
  usernameKey: z.string().default("ZWIFT_USERNAME").describe(
    "Vault key holding the Zwift account email/username",
  ),
  passwordKey: z.string().default("ZWIFT_PASSWORD").describe(
    "Vault key holding the Zwift account password",
  ),
  refreshTokenKey: z.string().default("ZWIFT_REFRESH_TOKEN").describe(
    "Vault key holding a pre-obtained refresh token (preferred over a password)",
  ),
  username: z.string().optional().describe(
    "Zwift username; normally left empty and read from the vault",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Zwift password; normally left empty and read from the vault",
  ),
  refreshToken: z.string().optional().meta({ sensitive: true }).describe(
    "Pre-obtained refresh token; normally left empty and read from the vault",
  ),
  apiBase: z.string().default("https://us-or-rly101.zwift.com").describe(
    "Zwift REST API base URL",
  ),
  authBase: z.string().default("https://secure.zwift.com").describe(
    "Zwift Keycloak base URL",
  ),
  timezone: z.string().default("").describe(
    "IANA timezone for bucketing ride start times (e.g. Australia/Brisbane). " +
      "Empty uses the host's local timezone.",
  ),
  historyDays: z.number().int().positive().default(120).describe(
    "Only rides within this many days are kept in the history and habit profile",
  ),
  halfLifeDays: z.number().positive().default(21).describe(
    "Recency half-life: a ride this many days old counts half as much as one " +
      "from today",
  ),
  maxActivities: z.number().int().positive().max(2000).default(400).describe(
    "Maximum activities to request from the history endpoint",
  ),
  sport: z.enum(["", "CYCLING", "RUNNING"]).default("").describe(
    "Only keep rides of this sport; empty keeps every sport",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const SyncArgsSchema = z.object({
  historyDays: z.number().int().positive().optional().describe(
    "Override the global historyDays for this run",
  ),
  maxActivities: z.number().int().positive().max(2000).optional().describe(
    "Override the global maxActivities for this run",
  ),
  includeAbility: z.boolean().default(true).describe(
    "Also fetch the power curve + racing score and write the `ability` " +
      "resource the recommender reads",
  ),
});

const SetupArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

/** One completed ride, normalised across Zwift's varying field names. */
export interface Activity {
  /** Zwift activity id (string, so it is stable as a resource instance name). */
  id: string;
  /** Human-readable activity title. */
  name: string;
  /** ISO-8601 instant of the activity start (UTC). */
  startTime: string;
  /** Epoch milliseconds of the activity start. */
  startMs: number;
  /** Local hour the ride started, in the configured timezone. */
  localHour: number;
  /** Local minute the ride started. */
  localMinute: number;
  /** Local calendar date the ride started, `YYYY-MM-DD`. */
  localDate: string;
  /** Local ISO weekday, 1 (Monday) - 7 (Sunday). */
  isoDayOfWeek: number;
  /** Sport, upper-cased (`CYCLING` or `RUNNING`). */
  sport: string;
  /** Distance ridden, in metres. */
  distanceMeters: number;
  /** Elevation gained, in metres. */
  elevationMeters: number;
  /** Total elapsed duration, in seconds. */
  durationSeconds: number;
  /** Moving duration, in seconds (falls back to `durationSeconds`). */
  movingSeconds: number;
  /** Average power in watts, when Zwift recorded it. */
  avgPower: number | null;
  /** Average heart rate in bpm, when recorded. */
  avgHeartRate: number | null;
  /** Average cadence in rpm, when recorded. */
  avgCadence: number | null;
  /** Average speed in km/h, derived from distance/duration when absent. */
  avgSpeedKph: number | null;
  /** Calories burned, when recorded. */
  calories: number | null;
  /** Zwift world id. */
  worldId: number | null;
  /** Zwift route id. */
  routeId: number | null;
  /** Zwift event id, when the ride was an event. */
  eventId: number | null;
  /** Recency-decayed weight in `(0, 1]` used by the habit profile. */
  decayWeight: number;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

const ActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  startTime: z.string(),
  startMs: z.number(),
  localHour: z.number(),
  localMinute: z.number(),
  localDate: z.string(),
  isoDayOfWeek: z.number(),
  sport: z.string(),
  distanceMeters: z.number(),
  elevationMeters: z.number(),
  durationSeconds: z.number(),
  movingSeconds: z.number(),
  avgPower: z.number().nullable(),
  avgHeartRate: z.number().nullable(),
  avgCadence: z.number().nullable(),
  avgSpeedKph: z.number().nullable(),
  calories: z.number().nullable(),
  worldId: z.number().nullable(),
  routeId: z.number().nullable(),
  eventId: z.number().nullable(),
  decayWeight: z.number(),
});

/** The athlete's public profile, in SWE-normalised units. */
const ProfileSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  ftpWatts: z.number().nullable(),
  weightKg: z.number().nullable(),
  wPerKg: z.number().nullable(),
  level: z.number().nullable(),
  totalDistanceKm: z.number().nullable(),
  totalClimbedM: z.number().nullable(),
  totalTimeMinutes: z.number().nullable(),
  totalXp: z.number().nullable(),
  fetchedAt: z.string(),
});

/** Derived, recency-decayed ability + habit profile for the recommender. */
export interface AbilityProfile {
  /** ISO-8601 instant the profile was computed. */
  generatedAt: string;
  /** Timezone used for the local-time histograms (`system` for host local). */
  timeZone: string;
  /** Recency half-life in days. */
  halfLifeDays: number;
  /** Number of rides included. */
  rideCount: number;
  /** History window in days. */
  windowDays: number;
  /** FTP in watts, from the profile or the power curve. */
  ftpWatts: number | null;
  /** Where the FTP value came from. */
  ftpSource: string;
  /** Rider weight in kilograms. */
  weightKg: number | null;
  /** FTP per kilogram. */
  wPerKg: number | null;
  /** Zwift racing score, when available. */
  racingScore: number | null;
  /** Ability mapped onto a 0-100 scale for ranking. */
  abilityScore: number;
  /** Zwift-style category band (A-E) inferred from w/kg. */
  categoryBand: string;
  /** Decay-weighted typical ride duration, in minutes. */
  typicalDurationMinutes: number | null;
  /** Mean ride distance, in kilometres. */
  typicalDistanceKm: number | null;
  /** Mean average power, in watts. */
  typicalAvgPower: number | null;
  /** Mean average speed, in km/h. */
  typicalAvgSpeedKph: number | null;
  /** Decay-weighted hour-of-day distribution (24 values summing to 1). */
  hourHistogram: number[];
  /** Decay-weighted weekday distribution (7 values summing to 1). */
  weekdayHistogram: number[];
  /** Decay-weighted duration distribution (one value per duration bucket). */
  durationHistogram: number[];
  /** Width of each duration bucket, in minutes. */
  durationBucketMinutes: number;
  /** Human labels for the duration buckets. */
  durationBucketLabels: string[];
  /** The three most common local start hours. */
  preferredHours: number[];
  /** Confidence in `[0, 1]`, rising with decayed ride volume. */
  confidence: number;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

const AbilitySchema = z.object({
  generatedAt: z.string(),
  timeZone: z.string(),
  halfLifeDays: z.number(),
  rideCount: z.number(),
  windowDays: z.number(),
  ftpWatts: z.number().nullable(),
  ftpSource: z.string(),
  weightKg: z.number().nullable(),
  wPerKg: z.number().nullable(),
  racingScore: z.number().nullable(),
  abilityScore: z.number(),
  categoryBand: z.string(),
  typicalDurationMinutes: z.number().nullable(),
  typicalDistanceKm: z.number().nullable(),
  typicalAvgPower: z.number().nullable(),
  typicalAvgSpeedKph: z.number().nullable(),
  hourHistogram: z.array(z.number()),
  weekdayHistogram: z.array(z.number()),
  durationHistogram: z.array(z.number()),
  durationBucketMinutes: z.number(),
  durationBucketLabels: z.array(z.string()),
  preferredHours: z.array(z.number()),
  confidence: z.number(),
});

/** Cached auth session. The refresh token is stored in the vault. */
const SessionSchema = z.object({
  signedInAt: z.string(),
  via: z.string(),
  expiresAt: z.string().nullable(),
  hasRefreshToken: z.boolean(),
  refreshToken: z.string().nullable().meta({ sensitive: true }),
});

const SyncSummarySchema = z.object({
  riderId: z.string(),
  activities: z.number(),
  windowDays: z.number(),
  timeZone: z.string(),
  abilityScore: z.number(),
  categoryBand: z.string(),
  preferredHours: z.array(z.number()),
  syncedAt: z.string(),
});

const SetupSchema = z.object({
  report: z.string(),
});

/** Compact ride row the recommender consumes (via workflow CEL wiring). */
const RideRowSchema = z.object({
  id: z.string(),
  startMs: z.number(),
  localHour: z.number(),
  localMinute: z.number(),
  localDate: z.string(),
  isoDayOfWeek: z.number(),
  durationMinutes: z.number(),
  distanceKm: z.number(),
  sport: z.string(),
  eventId: z.number().nullable(),
  routeId: z.number().nullable(),
  worldId: z.number().nullable(),
  decayWeight: z.number(),
});

/** All recent rides in one resource, so a workflow can pass them as an array. */
const HistorySchema = z.object({
  generatedAt: z.string(),
  timeZone: z.string(),
  halfLifeDays: z.number(),
  windowDays: z.number(),
  rideCount: z.number(),
  rides: z.array(RideRowSchema),
});

// ---------------------------------------------------------------------------
// Zwift response shaping (defensive: field names drift)
// ---------------------------------------------------------------------------

/** First defined numeric value among `keys`, rounded to a whole number. */
function pickNumber(
  record: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

/** First defined string value among `keys`. */
function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

/** Normalise one raw Zwift activity into {@link ActivitySchema}. */
export function normalizeActivity(
  raw: Record<string, unknown>,
  tz: string,
  halfLifeDays: number,
  nowMs: number,
): Activity | null {
  const id = pickString(raw, "id_str", "id", "activityId", "stravaId") ||
    String(pickNumber(raw, "id", "activityId") ?? "");
  const startMs = parseTimeMs(
    raw.startDate ?? raw.startTime ?? raw.date ?? raw.startTimestamp ??
      raw.completedAt,
  );
  if (!id || startMs === null) return null;

  const local: LocalParts = localParts(startMs, tz);
  const distanceMeters = pickNumber(raw, "distanceInMeters", "distance") ?? 0;
  // Zwift's activity `duration` is whole MINUTES; other sources give seconds.
  // `movingTimeInMs` is milliseconds. Normalise everything to seconds.
  const explicitSeconds = pickNumber(raw, "durationInSeconds", "elapsedTime");
  const durationMinutes = pickNumber(raw, "duration");
  const durationSeconds = explicitSeconds ??
    (durationMinutes !== null ? durationMinutes * 60 : 0);
  const movingMs = pickNumber(
    raw,
    "movingTimeInMs",
    "movingTimeInMilliseconds",
  );
  const movingSeconds = movingMs !== null
    ? Math.round(movingMs / 1000)
    : pickNumber(raw, "movingTimeInSeconds", "movingTime", "activeTime") ??
      durationSeconds;
  const avgSpeedKph =
    pickNumber(raw, "avgSpeedInKph", "averageSpeed", "avgSpeed") ??
      (durationSeconds > 0
        ? Math.round((distanceMeters / 1000 / (durationSeconds / 3600)) * 10) /
          10
        : null);

  return {
    id,
    name: pickString(raw, "name", "title") || "Ride",
    startTime: new Date(startMs).toISOString(),
    startMs,
    localHour: local.hour,
    localMinute: local.minute,
    localDate: local.date,
    isoDayOfWeek: local.isoDayOfWeek,
    sport: pickString(raw, "sport", "activityType").toUpperCase() || "CYCLING",
    distanceMeters,
    elevationMeters: pickNumber(raw, "totalElevation", "elevationInMeters") ??
      0,
    durationSeconds,
    movingSeconds,
    avgPower: pickNumber(raw, "avgWatts", "avgPower", "averagePower", "power"),
    avgHeartRate: pickNumber(
      raw,
      "avgHeartRate",
      "averageHeartRate",
      "heartRateAvg",
    ),
    avgCadence: pickNumber(raw, "avgCadence", "averageCadence"),
    avgSpeedKph,
    calories: pickNumber(raw, "calories"),
    worldId: pickNumber(raw, "worldId"),
    routeId: pickNumber(raw, "routeId"),
    eventId: pickNumber(raw, "eventId"),
    decayWeight: decayWeight(nowMs - startMs, halfLifeDays),
  };
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

/** Minimal authenticated JSON client for the endpoints this model uses. */
async function apiGet(
  path: string,
  accessToken: string,
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Several Zwift endpoints content-negotiate and return protobuf without
      // an explicit JSON Accept header.
      Accept: "application/json",
      "User-Agent": "swamp-zwift/1.0",
    },
  });
  if (!res.ok) {
    // 403/401 from the API gateway almost always means the access token was
    // minted for the wrong Keycloak client (accepted at sign-in, but without
    // the role these endpoints require). Point at the fix rather than leaving
    // a bare status.
    if (res.status === 403 || res.status === 401) {
      throw new Error(
        `GET ${path} failed (HTTP ${res.status}) — the access token was ` +
          `rejected by Zwift's API. This usually means a stale refresh token ` +
          `from an older client is being reused. Delete the cached session ` +
          `and re-authenticate with your password: ` +
          `swamp data delete zwift-rider session-auth --yes`,
      );
    }
    throw new Error(`GET ${path} failed (HTTP ${res.status})`);
  }
  return await res.json();
}

/**
 * Extract the athlete id Zwift's API path expects.
 *
 * `/api/profiles/me` returns both a numeric `id` and a UUID `publicId`. The
 * activities endpoint is addressed by the **numeric** id — passing the UUID
 * yields HTTP 404 — so the numeric value wins. It is returned as a string
 * because it can exceed Number.MAX_SAFE_INTEGER.
 */
function profileIdOf(profile: Record<string, unknown>): string {
  const asString = pickString(profile, "id_str", "playerId");
  if (asString) return asString;
  const asNumber = pickNumber(profile, "id", "playerId");
  return asNumber === null ? "" : String(asNumber);
}

/** Pull an array of activities out of either response shape Zwift returns. */
function activitiesOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const list = (payload as Record<string, unknown>).activities ??
      (payload as Record<string, unknown>).results;
    if (Array.isArray(list)) return list as Record<string, unknown>[];
  }
  return [];
}

/**
 * Largest page Zwift's activities endpoint accepts. A larger `limit` is
 * rejected with `{"message":"limit.too.large"}` (HTTP 400), so the history
 * must be paged rather than requested in one call.
 */
export const ACTIVITIES_PAGE_LIMIT = 50;

/**
 * Fetch up to `maxActivities` activities, paging at {@link ACTIVITIES_PAGE_LIMIT}.
 *
 * Stops early when a short page arrives (the history is exhausted) and caps the
 * total at `maxActivities` so a very long history cannot balloon the run.
 */
async function fetchActivities(
  riderId: string,
  maxActivities: number,
  accessToken: string,
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const pageSize = Math.min(ACTIVITIES_PAGE_LIMIT, Math.max(1, maxActivities));
  for (let start = 0; out.length < maxActivities; start += pageSize) {
    const page = activitiesOf(
      await apiGet(
        `/api/profiles/${encodeURIComponent(riderId)}/activities` +
          `?start=${start}&limit=${pageSize}`,
        accessToken,
        apiBase,
        fetchImpl,
      ),
    );
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out.slice(0, maxActivities);
}

/**
 * Pick the best 20-minute power out of a `power-curve/best` payload and
 * convert it to an FTP estimate. Returns `null` when the curve has no
 * 20-minute point (a new or power-less account).
 */
export function ftpFromPowerCurve(
  payload: Record<string, unknown>,
): number | null {
  const points = payload.pointsWatts;
  const entries = Array.isArray(points)
    ? points.map((
      p,
    ) => [String((p as Record<string, unknown>).duration ?? ""), p])
    : Object.entries((points ?? {}) as Record<string, unknown>);

  for (const [key, point] of entries) {
    const seconds = Number(key.replace(/\D/g, ""));
    if (seconds < 1100 || seconds > 1300) continue;
    const value = typeof point === "number"
      ? point
      : pickNumber(point as Record<string, unknown>, "value", "watts", "power");
    if (value !== null && value > 0) return Math.round(value * 0.95);
  }
  return null;
}

/** Zwift-style power-to-weight category bands (men's race categories). */
export function categoryBand(wPerKg: number | null): string {
  if (wPerKg === null || wPerKg <= 0) return "unknown";
  if (wPerKg >= 4.0) return "A";
  if (wPerKg >= 3.2) return "B";
  if (wPerKg >= 2.5) return "C";
  if (wPerKg >= 1.6) return "D";
  return "E";
}

/** Map a w/kg value onto a 0-100 ability score for ranking events. */
export function abilityScoreFromWPerKg(wPerKg: number | null): number {
  if (wPerKg === null || wPerKg <= 0) return 50;
  // 1.5 w/kg -> ~0, 5.0 w/kg -> 100, linear in between.
  return clamp(((wPerKg - 1.5) / 3.5) * 100, 0, 100);
}

// ---------------------------------------------------------------------------
// Method context typing
// ---------------------------------------------------------------------------

type Logger = {
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
};

type RiderContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
};

/** Read a secret from the configured vault, returning "" when absent. */
async function readVaultSecret(
  ctx: RiderContext,
  key: string,
): Promise<string> {
  if (!ctx.vaultService) return "";
  try {
    return await ctx.vaultService.get(
      ctx.globalArgs.vaultName,
      key,
      "model:zwift-rider-auth",
    );
  } catch {
    return "";
  }
}

/**
 * Resolve credentials in priority order: the (already vault-resolved) global
 * arguments, then the persisted session refresh token, then the vault keys.
 */
async function resolveAuth(
  ctx: RiderContext,
): Promise<{ tokens: ZwiftTokens; via: string }> {
  const g = ctx.globalArgs;
  const session = await ctx.readResource("session-auth");
  const storedRefresh = typeof session?.refreshToken === "string"
    ? session.refreshToken
    : "";
  const explicitRefresh = g.refreshToken?.trim() || "";
  const refreshToken = explicitRefresh || storedRefresh ||
    await readVaultSecret(ctx, g.refreshTokenKey);
  const username = g.username?.trim() ||
    await readVaultSecret(ctx, g.usernameKey);
  const password = g.password?.trim() ||
    await readVaultSecret(ctx, g.passwordKey);

  if (!refreshToken && !(username && password)) {
    throw new Error(
      "Zwift credentials missing. Store them in the vault, e.g. " +
        `swamp vault put ${g.vaultName} ${g.usernameKey} and ` +
        `swamp vault put ${g.vaultName} ${g.passwordKey} — or supply a ` +
        `${g.refreshTokenKey}. Then run 'swamp model ` +
        "@svendowideit/zwift-rider method run setup <name>' to verify.",
    );
  }

  // Try the stored/explicit refresh token first, but fall back to the password
  // grant when it is rejected. A token minted for a different client (or an
  // expired/rotated-away one) fails at the token endpoint with `invalid_grant`;
  // silently re-authenticating keeps a scheduled run working without a human
  // clearing the cached session.
  let tokens: ZwiftTokens;
  let via: string;
  if (refreshToken) {
    try {
      tokens = await getAccessToken({
        refreshToken,
        authBase: g.authBase,
      });
      via = "refresh token";
    } catch (err) {
      if (!(username && password)) throw err;
      ctx.logger.warning(
        "Stored refresh token was rejected ({err}); falling back to password grant",
        { err: (err as Error).message },
      );
      tokens = await getAccessToken({
        username,
        password,
        authBase: g.authBase,
      });
      via = "password grant (refresh token rejected)";
    }
  } else {
    tokens = await getAccessToken({
      username,
      password,
      authBase: g.authBase,
    });
    via = "password grant";
  }

  return { tokens, via };
}

/** Build the decayed hour/weekday/duration histograms and typicals. */
export function buildAbilityProfile(
  activities: Activity[],
  opts: {
    timeZone: string;
    halfLifeDays: number;
    windowDays: number;
    nowMs: number;
    ftpWatts: number | null;
    ftpSource: string;
    weightKg: number | null;
    racingScore: number | null;
  },
): AbilityProfile {
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  const durations = new Array<number>(DURATION_BUCKETS).fill(0);
  const durationMinutes: number[] = [];
  const distanceKm: number[] = [];
  const powers: number[] = [];
  const speeds: number[] = [];
  let weightSum = 0;

  for (const a of activities) {
    const w = a.decayWeight;
    hours[a.localHour] += w;
    weekdays[clamp(a.isoDayOfWeek - 1, 0, 6)] += w;
    const minutes = (a.movingSeconds || a.durationSeconds) / 60;
    durations[durationBucketIndex(minutes)] += w;
    weightSum += w;
    if (minutes > 0) durationMinutes.push(minutes);
    if (a.distanceMeters > 0) distanceKm.push(a.distanceMeters / 1000);
    if (a.avgPower !== null && a.avgPower > 0) powers.push(a.avgPower);
    if (a.avgSpeedKph !== null && a.avgSpeedKph > 0) speeds.push(a.avgSpeedKph);
  }

  const wPerKg = opts.ftpWatts !== null && opts.weightKg !== null &&
      opts.weightKg > 0
    ? Math.round((opts.ftpWatts / opts.weightKg) * 100) / 100
    : null;

  const typicalDuration = mean(durationMinutes);
  const normalisedHours = normalizeHistogram(hours);
  const preferredHours = normalisedHours
    .map((p, hour) => ({ hour, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 3)
    .filter((h) => h.p > 0)
    .map((h) => h.hour)
    .sort((a, b) => a - b);

  return {
    generatedAt: new Date(opts.nowMs).toISOString(),
    timeZone: opts.timeZone || "system",
    halfLifeDays: opts.halfLifeDays,
    rideCount: activities.length,
    windowDays: opts.windowDays,
    ftpWatts: opts.ftpWatts,
    ftpSource: opts.ftpSource,
    weightKg: opts.weightKg,
    wPerKg,
    racingScore: opts.racingScore,
    abilityScore: Math.round(abilityScoreFromWPerKg(wPerKg) * 10) / 10,
    categoryBand: categoryBand(wPerKg),
    typicalDurationMinutes: typicalDuration === null
      ? null
      : Math.round(typicalDuration),
    typicalDistanceKm: distanceKm.length === 0
      ? null
      : Math.round((mean(distanceKm) ?? 0) * 10) / 10,
    typicalAvgPower: powers.length === 0 ? null : Math.round(mean(powers) ?? 0),
    typicalAvgSpeedKph: speeds.length === 0
      ? null
      : Math.round((mean(speeds) ?? 0) * 10) / 10,
    hourHistogram: normalisedHours,
    weekdayHistogram: normalizeHistogram(weekdays),
    durationHistogram: normalizeHistogram(durations),
    durationBucketMinutes: DURATION_BUCKET_MINUTES,
    durationBucketLabels: Array.from(
      { length: DURATION_BUCKETS },
      (_, i) => durationBucketLabel(i),
    ),
    preferredHours,
    // Confidence grows with volume, saturating at 20 decayed rides.
    confidence: Math.round(clamp(weightSum / 20, 0, 1) * 100) / 100,
  };
}

/** The `@svendowideit/zwift-rider` model definition. */
export const model = {
  type: "@svendowideit/zwift-rider",
  version: "2026.09.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    activity: {
      description:
        "One completed ride, keyed by Zwift activity id (factory output)",
      schema: ActivitySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    history: {
      description:
        "All recent rides in one resource, so a workflow can pass the whole " +
        "array to the recommender with a single CEL expression",
      schema: HistorySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    profile: {
      description: "The athlete's public Zwift profile (normalised units)",
      schema: ProfileSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    ability: {
      description:
        "Derived, recency-decayed ability + habit profile for the recommender",
      schema: AbilitySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    session: {
      description:
        "Cached auth session; the rotated refresh token is stored in the vault",
      schema: SessionSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    sync: {
      description: "Summary of the most recent history sync",
      schema: SyncSummarySchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    setup: {
      description: "Configuration-readiness report from the setup method",
      schema: SetupSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    "setup": {
      description:
        "Report credential/config readiness and the exact commands to fix gaps. " +
        "Read-only: never prints or mutates a secret.",
      arguments: SetupArgsSchema,
      execute: async (
        _args: z.infer<typeof SetupArgsSchema>,
        ctx: RiderContext,
      ) => {
        const g = ctx.globalArgs;
        const vaultKeys = [
          g.usernameKey,
          g.passwordKey,
          g.refreshTokenKey,
        ];
        const presence: string[] = [];
        for (const key of vaultKeys) {
          const value = await readVaultSecret(ctx, key);
          presence.push(`  ${key}: ${value ? "set" : "unset"}`);
        }
        const session = await ctx.readResource("session-auth");
        const lines = [
          "Zwift rider configuration",
          `  vault:            ${g.vaultName}`,
          `  api base:         ${g.apiBase}`,
          `  timezone:         ${g.timezone || "(host local)"}`,
          `  history window:   ${g.historyDays} days`,
          `  decay half-life:  ${g.halfLifeDays} days`,
          `  sport filter:     ${g.sport || "(all sports)"}`,
          "",
          "Vault keys:",
          ...presence,
          "",
          `Persisted refresh token: ${session?.hasRefreshToken ? "yes" : "no"}`,
          "",
          "To fix a gap:",
          `  swamp vault put ${g.vaultName} ${g.usernameKey}`,
          `  swamp vault put ${g.vaultName} ${g.passwordKey}`,
          `  swamp model @svendowideit/zwift-rider method run sync <name>`,
        ];
        const handle = await ctx.writeResource("setup", "report", {
          report: lines.join("\n"),
        });
        ctx.logger.info(lines.join("\n"));
        return { dataHandles: [handle] };
      },
    },
    "sync": {
      description:
        "Fetch the rider profile + recent activities, persist each ride, and " +
        "derive the decayed ability/habit profile. Rotates and persists the " +
        "refresh token.",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: RiderContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();
        const windowDays = args.historyDays ?? g.historyDays;
        const maxActivities = args.maxActivities ?? g.maxActivities;
        const fetchImpl = fetch;

        const { tokens, via } = await resolveAuth(ctx);

        const sessionHandle = await ctx.writeResource(
          "session",
          "session-auth",
          {
            signedInAt: new Date(nowMs).toISOString(),
            via,
            expiresAt: Number.isFinite(tokens.expiresAt)
              ? new Date(tokens.expiresAt).toISOString()
              : null,
            hasRefreshToken: tokens.refreshToken !== null,
            refreshToken: tokens.refreshToken,
          },
        );

        const rawProfile = await apiGet(
          "/api/profiles/me",
          tokens.accessToken,
          g.apiBase,
          fetchImpl,
        ) as Record<string, unknown>;
        const riderId = profileIdOf(rawProfile);
        if (!riderId) {
          throw new Error("Zwift profile response contained no athlete id");
        }

        const rawWeight = pickNumber(rawProfile, "weight");
        // Zwift stores weight in grams (85300 = 85.3 kg). A plausible kilogram
        // value is well under 1000, so anything larger is grams.
        const weightKg = rawWeight !== null && rawWeight > 1000
          ? Math.round(rawWeight / 100) / 10
          : rawWeight;
        const profileFtp = pickNumber(rawProfile, "ftp", "ftpWatts");
        // `achievementLevel` is the level multiplied by 100 (e.g. 5432 => 54).
        const rawLevel = pickNumber(rawProfile, "achievementLevel");
        const profile = {
          id: riderId,
          firstName: pickString(rawProfile, "firstName"),
          lastName: pickString(rawProfile, "lastName"),
          ftpWatts: profileFtp,
          weightKg,
          wPerKg: profileFtp !== null && weightKg !== null && weightKg > 0
            ? Math.round((profileFtp / weightKg) * 100) / 100
            : null,
          level: rawLevel === null ? null : Math.floor(rawLevel / 100),
          totalDistanceKm: (() => {
            // `totalDistance` is metres.
            const m = pickNumber(rawProfile, "totalDistance");
            return m === null ? null : Math.round(m / 100) / 10;
          })(),
          totalClimbedM: pickNumber(rawProfile, "totalDistanceClimbed"),
          totalTimeMinutes: pickNumber(rawProfile, "totalTimeInMinutes"),
          totalXp: pickNumber(rawProfile, "totalExperiencePoints"),
          fetchedAt: new Date(nowMs).toISOString(),
        };
        const profileHandle = await ctx.writeResource(
          "profile",
          "profile-current",
          profile,
        );

        const rawActivities = await fetchActivities(
          riderId,
          maxActivities,
          tokens.accessToken,
          g.apiBase,
          fetchImpl,
        );

        const cutoff = nowMs - windowDays * 86_400_000;
        const activities: Activity[] = [];
        for (const raw of rawActivities) {
          const a = normalizeActivity(raw, g.timezone, g.halfLifeDays, nowMs);
          if (!a) continue;
          if (a.startMs < cutoff) continue;
          if (g.sport && a.sport !== g.sport) continue;
          activities.push(a);
        }

        const handles = [];
        for (const a of activities) {
          handles.push(
            await ctx.writeResource("activity", `activity-${a.id}`, a),
          );
        }
        ctx.logger.info(
          "Synced {n} rides for rider {id} over {days} days",
          { n: activities.length, id: riderId, days: windowDays },
        );

        const history = {
          generatedAt: new Date(nowMs).toISOString(),
          timeZone: g.timezone || "system",
          halfLifeDays: g.halfLifeDays,
          windowDays,
          rideCount: activities.length,
          rides: activities.map((a) => ({
            id: a.id,
            startMs: a.startMs,
            localHour: a.localHour,
            localMinute: a.localMinute,
            localDate: a.localDate,
            isoDayOfWeek: a.isoDayOfWeek,
            durationMinutes: Math.round(
              (a.movingSeconds || a.durationSeconds) / 60,
            ),
            distanceKm: Math.round((a.distanceMeters / 1000) * 10) / 10,
            sport: a.sport,
            eventId: a.eventId,
            routeId: a.routeId,
            worldId: a.worldId,
            decayWeight: Math.round(a.decayWeight * 1000) / 1000,
          })),
        };
        const historyHandle = await ctx.writeResource(
          "history",
          "history-current",
          history,
        );

        let ftpWatts = profileFtp;
        let ftpSource = profileFtp !== null ? "profile" : "none";
        let racingScore: number | null = null;

        if (args.includeAbility) {
          try {
            const curve = await apiGet(
              "/api/power-curve/best/all-time",
              tokens.accessToken,
              g.apiBase,
              fetchImpl,
            ) as Record<string, unknown>;
            const fromCurve = ftpFromPowerCurve(curve);
            if (fromCurve !== null) {
              ftpWatts = fromCurve;
              ftpSource = "power-curve (20min x 0.95)";
            }
          } catch (err) {
            ctx.logger.warning("Power curve unavailable: {err}", {
              err: (err as Error).message,
            });
          }
          try {
            const score = await apiGet(
              "/api/scoring/current",
              tokens.accessToken,
              g.apiBase,
              fetchImpl,
            ) as Record<string, unknown>;
            const scores = score.scores as Record<string, unknown> | undefined;
            const pub = scores?.ZWIFT_PUBLIC_SCORE as
              | Record<string, unknown>
              | undefined;
            racingScore = pub ? pickNumber(pub, "value") : null;
          } catch (err) {
            ctx.logger.debug("Racing score unavailable: {err}", {
              err: (err as Error).message,
            });
          }
        }

        const ability = buildAbilityProfile(activities, {
          timeZone: g.timezone,
          halfLifeDays: g.halfLifeDays,
          windowDays,
          nowMs,
          ftpWatts,
          ftpSource,
          weightKg,
          racingScore,
        });
        const abilityHandle = await ctx.writeResource(
          "ability",
          "ability-current",
          ability,
        );

        const summaryHandle = await ctx.writeResource("sync", "summary", {
          riderId,
          activities: activities.length,
          windowDays,
          timeZone: ability.timeZone,
          abilityScore: ability.abilityScore,
          categoryBand: ability.categoryBand,
          preferredHours: ability.preferredHours,
          syncedAt: new Date(nowMs).toISOString(),
        });

        return {
          dataHandles: [
            sessionHandle,
            profileHandle,
            abilityHandle,
            summaryHandle,
            historyHandle,
            ...handles,
          ],
        };
      },
    },
  },
};
