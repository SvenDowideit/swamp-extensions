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
  applyLoad,
  buildAvailability,
  buildDailyLoad,
  buildHistoryYears,
  calibrateGarminLoad,
  type HistoryRide,
  type HistorySources,
  mergeRides,
  normalizeGarminRide,
} from "./zwift_history.ts";
import { parseFitSession } from "./zwift_fit.ts";
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

/**
 * Vault this model reads credentials from and — critically — the vault swamp
 * writes the sensitive `session` refresh token into.
 *
 * A sensitive resource field is stored in the vault named by the field/spec
 * `vaultName`, else the repository's `defaultVault`, else the first configured
 * user vault *alphabetically*. That last fallback is not stable: creating a
 * vault whose name sorts earlier (e.g. `garmin-secrets` before
 * `zwift-secrets`) silently redirects the token, and the next run fails with
 * "not found in vault". Pinning the vault here makes storage independent of
 * which other vaults exist.
 */
export const DEFAULT_VAULT = "zwift-secrets";

/**
 * The name of a vault or a vault key — an identifier, never a secret value.
 *
 * Grouping these in one named schema documents that distinction: a vault key
 * *name* is safe to store, display, and default, which is why it carries no
 * `sensitive` metadata. Only the values fetched from those keys are secret
 * (see `password`/`refreshToken` below, and the vault references the workflow
 * injects).
 */
const vaultIdentifier = z.string();

const GlobalArgsSchema = z.object({
  vaultName: vaultIdentifier.default(DEFAULT_VAULT).describe(
    "Vault the model reads credentials from (and where it persists the " +
      "rotated refresh token)",
  ),
  usernameKey: vaultIdentifier.default("ZWIFT_USERNAME").describe(
    "Vault key holding the Zwift account email/username",
  ),
  passwordKey: vaultIdentifier.default("ZWIFT_PASSWORD").describe(
    "Vault key holding the Zwift account password",
  ),
  refreshTokenKey: vaultIdentifier.default("ZWIFT_REFRESH_TOKEN").describe(
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
  /** True when the activity cap clipped the history (more rides exist). */
  truncated: z.boolean(),
  rides: z.array(RideRowSchema),
});

const HistoryRideSchema = z.object({
  id: z.string(),
  source: z.enum(["zwift", "garmin"]),
  name: z.string(),
  sport: z.string(),
  startMs: z.number(),
  localDate: z.string(),
  localHour: z.number(),
  isoDayOfWeek: z.number(),
  durationSeconds: z.number(),
  movingSeconds: z.number(),
  distanceMeters: z.number(),
  elevationMeters: z.number(),
  avgPower: z.number().nullable(),
  npWatts: z.number().nullable(),
  ftpWatts: z.number().nullable(),
  tss: z.number().nullable(),
  tssSource: z.enum(["np", "garmin_calibrated", "avg_power", "missing"]),
  avgHr: z.number().nullable(),
  maxHr: z.number().nullable(),
  avgCadence: z.number().nullable(),
  maxPower: z.number().nullable(),
  eventId: z.number().nullable(),
  routeId: z.number().nullable(),
  worldId: z.number().nullable(),
  garminTrainingLoad: z.number().nullable(),
  detailFetchedAt: z.string().nullable(),
  fitFetchedAt: z.string().nullable(),
});

const SourceRangeSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  rides: z.number(),
  truncated: z.boolean(),
});

const HistorySourcesSchema = z.object({
  zwift: SourceRangeSchema,
  garmin: SourceRangeSchema,
  merged: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    rides: z.number(),
    duplicates: z.number(),
  }),
});

const DataQualitySchema = z.object({
  npRides: z.number(),
  hrRides: z.number(),
  estimatedRides: z.number(),
  missingRides: z.number(),
  fitParsed: z.number().default(0),
  fitFetchedNoNp: z.number().default(0),
  fitFailed: z.number().default(0),
  reusedRides: z.number().default(0),
});

const TrainingHistorySchema = z.object({
  generatedAt: z.string(),
  timeZone: z.string(),
  truncated: z.boolean(),
  rides: z.array(HistoryRideSchema),
  sources: HistorySourcesSchema,
  dataQuality: DataQualitySchema,
});

const LoadDaySchema = z.object({
  date: z.string(),
  minutes: z.number(),
  tss: z.number(),
  ctl: z.number(),
  atl: z.number(),
  tsb: z.number(),
  rides: z.number(),
});

const LoadDailySchema = z.object({
  generatedAt: z.string(),
  timeZone: z.string(),
  from: z.string(),
  to: z.string(),
  days: z.array(LoadDaySchema),
  dataQuality: DataQualitySchema,
  sources: HistorySourcesSchema,
});

const HistoryYearSchema = z.object({
  year: z.number(),
  rides: z.number(),
  hours: z.number(),
  km: z.number(),
  elevationM: z.number(),
  tss: z.number(),
  peakCtl: z.number(),
  maxFtp: z.number().nullable(),
  avgFtp: z.number().nullable(),
  sources: z.object({ zwift: z.number(), garmin: z.number() }),
});

const HistoryYearsSchema = z.object({
  generatedAt: z.string(),
  years: z.array(HistoryYearSchema),
  totals: z.object({
    rides: z.number(),
    hours: z.number(),
    km: z.number(),
    elevationM: z.number(),
    tss: z.number(),
  }),
  sources: HistorySourcesSchema,
  truncated: z.boolean(),
});

const AvailabilityStatsSchema = z.object({
  from: z.string(),
  to: z.string(),
  rides: z.number(),
  daysPerWeek: z.object({ median: z.number(), p80: z.number() }),
  hoursPerWeek: z.object({ median: z.number(), p80: z.number() }),
  preferredDays: z.array(z.number()),
  preferredHours: z.array(z.number()),
  sessionMinutes: z.object({ p50: z.number(), p90: z.number() }),
  recent8w: z.object({ daysPerWeek: z.number(), hoursPerWeek: z.number() }),
  monthlyHours: z.array(z.object({ month: z.string(), hours: z.number() })),
  gapDays: z.number(),
  lowHistory: z.boolean(),
});

const AvailabilitySchema = z.object({
  generatedAt: z.string(),
  source: z.enum(["zwift", "merged"]),
  window: z.object({ from: z.string(), to: z.string() }),
  zwift: AvailabilityStatsSchema,
  merged: AvailabilityStatsSchema,
  gapDays: z.number(),
  sources: HistorySourcesSchema,
  lowHistory: z.boolean(),
});

const BackfillArgsSchema = z.object({
  backfillDays: z.number().int().positive().default(3650),
  backfillMaxActivities: z.number().int().positive().max(2000).default(2000),
  includeDetail: z.boolean().default(true),
  includeFit: z.boolean().default(true),
  includeGarmin: z.boolean().default(true),
  garminActivities: z.array(z.record(z.string(), z.unknown())).default([]),
  garminTruncated: z.boolean().default(false),
  detailDelayMs: z.number().int().min(0).max(5000).default(100),
  fitDelayMs: z.number().int().min(0).max(5000).default(50),
  fitConcurrency: z.number().int().min(1).max(8).default(4),
  ftpFallback: z.number().positive().optional(),
  refreshDays: z.number().int().min(0).max(365).default(7),
  force: z.boolean().default(false),
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
// Backfill helpers
// ---------------------------------------------------------------------------

/** Convert a normalised Zwift activity into the merged history shape. */
function toHistoryRide(a: Activity): HistoryRide {
  return {
    id: a.id,
    source: "zwift",
    name: a.name,
    sport: a.sport,
    startMs: a.startMs,
    localDate: a.localDate,
    localHour: a.localHour,
    isoDayOfWeek: a.isoDayOfWeek,
    durationSeconds: a.durationSeconds,
    movingSeconds: a.movingSeconds,
    distanceMeters: a.distanceMeters,
    elevationMeters: a.elevationMeters,
    avgPower: a.avgPower,
    npWatts: null,
    ftpWatts: null,
    tss: null,
    tssSource: "missing",
    avgHr: a.avgHeartRate,
    maxHr: null,
    avgCadence: a.avgCadence,
    maxPower: null,
    eventId: a.eventId,
    routeId: a.routeId,
    worldId: a.worldId,
    garminTrainingLoad: null,
    detailFetchedAt: null,
    fitFetchedAt: null,
  };
}

/** Sleep without pulling in a dependency. */
function delay(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

/**
 * Fetch one Zwift FIT file from S3 and read the session normalised power.
 * Returns null when the file is missing, not a FIT, or has no session.
 */
async function fetchFitNp(
  bucket: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<{ np: number | null; fetched: boolean }> {
  try {
    const res = await fetchImpl(
      `https://${bucket}.s3.amazonaws.com/${key}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) return { np: null, fetched: false };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const session = await parseFitSession(bytes);
    return { np: session?.normalizedPower ?? null, fetched: true };
  } catch {
    return { np: null, fetched: false };
  }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

/** Wall-clock budget for a single Zwift HTTP request. */
export const REQUEST_TIMEOUT_MS = 30_000;

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
    // A wedged connection must not hang an unattended scheduled run forever.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    // Include a short body excerpt: Zwift's error JSON carries the reason
    // (e.g. `{"message":"limit.too.large"}`) that a bare status hides.
    const body = await res.text().catch(() => "");
    const detail = body.trim().slice(0, 200);
    throw new Error(
      `GET ${path} failed (HTTP ${res.status})` +
        (detail ? ` — ${detail}` : ""),
    );
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
 * `truncated` reports whether the cap was hit, so a consumer can tell a complete
 * history from a clipped one.
 */
async function fetchActivities(
  riderId: string,
  maxActivities: number,
  accessToken: string,
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<{ activities: Record<string, unknown>[]; truncated: boolean }> {
  const out: Record<string, unknown>[] = [];
  const pageSize = Math.min(ACTIVITIES_PAGE_LIMIT, Math.max(1, maxActivities));
  let truncated = false;
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
    // A full page at the cap boundary means more history exists.
    if (out.length >= maxActivities) truncated = true;
  }
  return { activities: out.slice(0, maxActivities), truncated };
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
  version: "2026.11.06.1",
  upgrades: [
    {
      toVersion: "2026.10.01.1",
      description:
        "The `session` resource is pinned to the `zwift-secrets` vault " +
        "(vaultName: DEFAULT_VAULT), so the sensitive refresh token is always " +
        "stored there instead of the first user vault alphabetically — creating " +
        "another vault can no longer redirect it. Global arguments unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.06.1",
      description:
        "Adds the read-only backfill method and training-history, load-daily, " +
        "history-years and availability-current resources for the coach. " +
        "Existing resources and global arguments are unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
      vaultName: DEFAULT_VAULT,
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
    trainingHistory: {
      description:
        "Merged Zwift+Garmin rides with TSS and the FTP used at each ride",
      schema: TrainingHistorySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    loadDaily: {
      description: "Daily TSS, CTL, ATL and TSB, including rest days",
      schema: LoadDailySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    historyYears: {
      description: "One row per calendar year from the merged history",
      schema: HistoryYearsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    availability: {
      description:
        "History-derived available days/hours, preferred times and recent trend",
      schema: AvailabilitySchema,
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

        const { activities: rawActivities, truncated: activitiesTruncated } =
          await fetchActivities(
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
          truncated: activitiesTruncated,
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
    "backfill": {
      description:
        "Fetch as much Zwift history as the API returns, enrich each ride " +
        "with profileFtp/HR/max power, optionally parse FIT for NP, merge " +
        "Garmin activities, and write load-daily, history-years and " +
        "availability-current. Read-only against Zwift.",
      arguments: BackfillArgsSchema,
      execute: async (
        args: z.infer<typeof BackfillArgsSchema>,
        ctx: RiderContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();
        const historyDays = args.backfillDays;
        const maxActivities = args.backfillMaxActivities;
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
        const profileFtp = pickNumber(rawProfile, "ftp", "ftpWatts");
        const ftpFallback = args.ftpFallback ?? profileFtp;

        const { activities: rawActivities, truncated } = await fetchActivities(
          riderId,
          maxActivities,
          tokens.accessToken,
          g.apiBase,
          fetchImpl,
        );
        const cutoff = nowMs - historyDays * 86_400_000;
        const existing = await ctx.readResource("training-history");
        const existingRides = Array.isArray(existing?.rides)
          ? existing?.rides as unknown as HistoryRide[]
          : [];
        const existingById = new Map(
          existingRides
            .filter((r) => r.source === "zwift")
            .map((r) => [r.id, r]),
        );
        const recentCutoff = nowMs - args.refreshDays * 86_400_000;
        const rawById = new Map<string, Record<string, unknown>>();
        const seenIds = new Set<string>();
        const zwiftRides: HistoryRide[] = [];
        let reused = 0;
        let detailFetched = 0;
        let fitParsed = 0;
        let fitNoNp = 0;
        let fitFailed = 0;
        const fitJobs: { ride: HistoryRide; bucket: string; key: string }[] =
          [];

        for (const raw of rawActivities) {
          const a = normalizeActivity(raw, g.timezone, g.halfLifeDays, nowMs);
          if (!a) continue;
          if (a.startMs < cutoff) continue;
          if (g.sport && a.sport !== g.sport) continue;
          seenIds.add(a.id);
          rawById.set(a.id, raw);
          const fresh = toHistoryRide(a);
          const previous = existingById.get(a.id);
          let ride = fresh;
          if (previous && !args.force) {
            ride = {
              ...fresh,
              avgHr: fresh.avgHr ?? previous.avgHr,
              maxHr: previous.maxHr,
              avgCadence: fresh.avgCadence ?? previous.avgCadence,
              maxPower: previous.maxPower,
              npWatts: previous.npWatts,
              ftpWatts: previous.ftpWatts,
              tss: previous.tss,
              tssSource: previous.tssSource,
              detailFetchedAt: previous.detailFetchedAt,
              fitFetchedAt: previous.fitFetchedAt,
              garminTrainingLoad: previous.garminTrainingLoad,
            };
            reused++;
          }
          const isRecent = ride.startMs >= recentCutoff;
          const needsDetail = args.includeDetail && (
            args.force || !previous || !previous.detailFetchedAt ||
            (isRecent && args.refreshDays > 0)
          );
          // FIT files are immutable once uploaded; only fetch when we have
          // never fetched this activity's file. Detail is what gets refreshed
          // for recent rides.
          const needsFit = args.includeFit && ride.npWatts === null && (
            args.force || !previous || !previous.fitFetchedAt
          );

          if (needsDetail) {
            try {
              const detail = await apiGet(
                `/api/activities/${encodeURIComponent(ride.id)}`,
                tokens.accessToken,
                g.apiBase,
                fetchImpl,
              ) as Record<string, unknown>;
              ride.ftpWatts = pickNumber(detail, "profileFtp");
              ride.avgHr = pickNumber(detail, "avgHeartRate") ?? ride.avgHr;
              ride.maxHr = pickNumber(detail, "maxHeartRate");
              ride.avgCadence =
                pickNumber(detail, "avgCadenceInRotationsPerMinute") ??
                  ride.avgCadence;
              ride.maxPower = pickNumber(detail, "maxWatts");
              ride.detailFetchedAt = new Date().toISOString();
              detailFetched++;
            } catch (err) {
              ctx.logger.warning(
                "Activity detail unavailable for {id}: {err}",
                { id: ride.id, err: (err as Error).message },
              );
            }
            if (args.detailDelayMs > 0) await delay(args.detailDelayMs);
          }

          if (needsFit) {
            const rawActivity = rawById.get(ride.id);
            const bucket = rawActivity?.fitFileBucket;
            const key = rawActivity?.fitFileKey;
            if (typeof bucket === "string" && typeof key === "string") {
              fitJobs.push({ ride, bucket, key });
            }
          }

          zwiftRides.push(ride);
          if (zwiftRides.length % 25 === 0) {
            ctx.logger.info(
              "Backfilled {i}/{n} Zwift rides (reused {reused}, detail {detail}, fit {fit})",
              {
                i: zwiftRides.length,
                n: rawActivities.length,
                reused,
                detail: detailFetched,
                fit: fitParsed,
              },
            );
          }
        }

        for (let i = 0; i < fitJobs.length; i += args.fitConcurrency) {
          const chunk = fitJobs.slice(i, i + args.fitConcurrency);
          await Promise.all(chunk.map(async (job) => {
            const fit = await fetchFitNp(job.bucket, job.key, fetchImpl);
            if (fit.fetched) {
              job.ride.fitFetchedAt = new Date().toISOString();
              if (fit.np !== null) {
                job.ride.npWatts = fit.np;
                fitParsed++;
              } else {
                fitNoNp++;
              }
            } else {
              fitFailed++;
            }
          }));
          if (args.fitDelayMs > 0) await delay(args.fitDelayMs);
          if (fitJobs.length > 8) {
            ctx.logger.info(
              "FIT {done}/{total} (NP {np}, no NP {noNp}, failed {failed})",
              {
                done: Math.min(i + args.fitConcurrency, fitJobs.length),
                total: fitJobs.length,
                np: fitParsed,
                noNp: fitNoNp,
                failed: fitFailed,
              },
            );
          }
        }

        // Preserve older rides already in training-history unless this is an
        // explicit repair. A narrower window or the API cap must never shrink
        // the cached history by accident.
        if (!args.force) {
          for (const previous of existingById.values()) {
            if (!seenIds.has(previous.id)) zwiftRides.push(previous);
          }
          zwiftRides.sort((a, b) => a.startMs - b.startMs);
        }

        const existingGarmin = existingRides.filter((r) =>
          r.source === "garmin"
        );
        const garminInput = (args.includeGarmin ? args.garminActivities : [])
          .map((raw) => normalizeGarminRide(raw, g.timezone))
          .filter((r): r is HistoryRide => r !== null && r.sport === "CYCLING");
        const garminRides = args.includeGarmin
          ? (garminInput.length > 0 ? garminInput : existingGarmin)
          : [];
        const merged = mergeRides(zwiftRides, garminRides);
        const calibration = calibrateGarminLoad(merged.rides, ftpFallback);
        const loaded = applyLoad(merged.rides, {
          ftpFallback,
          ftpHistory: zwiftRides
            .filter((r) => r.ftpWatts !== null)
            .map((r) => ({
              startMs: r.startMs,
              ftpWatts: r.ftpWatts as number,
            })),
          garminCalibration: calibration,
        });

        const rangeOf = (rides: HistoryRide[]) => {
          const dates = rides.map((r) => r.localDate).sort();
          return {
            from: dates[0] ?? null,
            to: dates[dates.length - 1] ?? null,
            rides: rides.length,
          };
        };
        const zwiftRange = rangeOf(zwiftRides);
        const garminRange = rangeOf(garminRides);
        const mergedRange = rangeOf(loaded);
        const sources: HistorySources = {
          zwift: { ...zwiftRange, truncated },
          garmin: { ...garminRange, truncated: args.garminTruncated },
          merged: { ...mergedRange, duplicates: merged.duplicates },
        };

        const dataQuality = {
          npRides: loaded.filter((r) => r.tssSource === "np").length,
          hrRides: loaded.filter((r) => r.tssSource === "garmin_calibrated")
            .length,
          estimatedRides: loaded.filter((r) => r.tssSource === "avg_power")
            .length,
          missingRides: loaded.filter((r) => r.tssSource === "missing")
            .length,
          fitParsed,
          fitFetchedNoNp: fitNoNp,
          fitFailed,
          reusedRides: reused,
        };
        const today = localParts(Date.now(), g.timezone).date;
        const daily = buildDailyLoad(loaded, { today, dataQuality, sources });
        const years = buildHistoryYears(daily.days, loaded);
        const zwiftAvailability = buildAvailability(zwiftRides, {
          today,
          source: "zwift",
        });
        const mergedAvailability = buildAvailability(loaded, {
          today,
          source: "merged",
        });
        const availability = {
          generatedAt: new Date(nowMs).toISOString(),
          source: "merged" as const,
          window: {
            from: mergedAvailability.from,
            to: mergedAvailability.to,
          },
          zwift: zwiftAvailability,
          merged: mergedAvailability,
          gapDays: mergedAvailability.gapDays,
          sources,
          lowHistory: mergedAvailability.lowHistory,
        };
        const generatedAt = new Date(nowMs).toISOString();
        const trainingHandle = await ctx.writeResource(
          "trainingHistory",
          "training-history",
          {
            generatedAt,
            timeZone: g.timezone || "system",
            truncated: truncated || args.garminTruncated,
            rides: loaded,
            sources,
            dataQuality,
          },
        );
        const loadHandle = await ctx.writeResource("loadDaily", "load-daily", {
          generatedAt,
          timeZone: g.timezone || "system",
          from: daily.from,
          to: daily.to,
          days: daily.days,
          dataQuality,
          sources,
        });
        const yearsHandle = await ctx.writeResource(
          "historyYears",
          "history-years",
          {
            generatedAt,
            years,
            totals: {
              rides: years.reduce((n, y) => n + y.rides, 0),
              hours: Math.round(years.reduce((n, y) => n + y.hours, 0) * 10) /
                10,
              km: Math.round(years.reduce((n, y) => n + y.km, 0) * 10) / 10,
              elevationM: years.reduce((n, y) => n + y.elevationM, 0),
              tss: Math.round(years.reduce((n, y) => n + y.tss, 0) * 10) / 10,
            },
            sources,
            truncated: truncated || args.garminTruncated,
          },
        );
        const availabilityHandle = await ctx.writeResource(
          "availability",
          "availability-current",
          availability,
        );
        ctx.logger.info(
          "History refreshed: {zwift} Zwift rides ({reused} reused, " +
            "{detail} detail, {fit} FIT NP), {garmin} Garmin, " +
            "{np} NP / {est} estimated / {missing} missing",
          {
            zwift: zwiftRides.length,
            reused,
            detail: detailFetched,
            fit: fitParsed,
            garmin: garminRides.length,
            np: dataQuality.npRides,
            est: dataQuality.estimatedRides,
            missing: dataQuality.missingRides,
          },
        );
        return {
          dataHandles: [
            sessionHandle,
            trainingHandle,
            loadHandle,
            yearsHandle,
            availabilityHandle,
          ],
        };
      },
    },
  },
};
