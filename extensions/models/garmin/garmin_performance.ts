/**
 * `@svendowideit/garmin-performance` — training and performance metrics.
 *
 * Where the health model covers how you *felt* on a day, this one covers how
 * *fit* you are: VO2max, training status and readiness, race predictions,
 * endurance and hill score, FTP, and personal records. Garmin exposes these in
 * three different shapes, so the model groups its metrics accordingly:
 *
 *   - **daily** metrics are keyed by a calendar date and can be fetched for a
 *     window (training status, training readiness, race predictions, endurance
 *     score, hill score, fitness age).
 *   - **latest** metrics have no date and reflect the current value (cycling
 *     FTP, personal records).
 *   - VO2max is daily but nested, reported separately for running (`generic`)
 *     and cycling.
 *
 * As with every domain model here, `paths` builds the `connectapi` paths, a
 * workflow hands them to the transport's `fetch-many`, and `sync` reads the
 * cached bodies, normalises them into `metrics-<date>` (daily) and a
 * single `records` resource (latest + bests), and rolls the window into
 * `performance-range`.
 *
 * Most of these are **device-gated** — VO2max, training status/readiness and the
 * scores need a watch that computes them — so `paths` consults the device
 * capability map like the health model does.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { readCachedByPath } from "./garmin_cache.ts";

// ---------------------------------------------------------------------------
// Metrics and their endpoints
// ---------------------------------------------------------------------------

/**
 * How a metric is addressed:
 *   - `daily`  — date-keyed, one path per day in the window
 *   - `latest` — no date, one path total
 */
export type MetricKind = "daily" | "latest";

/** A performance metric this model knows how to fetch. */
export interface PerformanceMetricSpec {
  kind: MetricKind;
  /** Build the `connectapi` path. `displayName` is for the few that need it. */
  path: (date: string, displayName: string) => string;
  /** Capability-map key that gates this metric, if any. */
  capability?: string;
  /** Whether the path needs the account display name. */
  needsDisplayName?: boolean;
}

/** Encode a display name for a Garmin path. */
function dn(displayName: string): string {
  return encodeURIComponent(displayName);
}

/** Every performance metric this model supports, keyed by a short name. */
export const METRICS: Record<string, PerformanceMetricSpec> = {
  trainingStatus: {
    kind: "daily",
    path: (d) => `/metrics-service/metrics/trainingstatus/aggregated/${d}`,
    capability: "trainingStatus",
  },
  trainingReadiness: {
    kind: "daily",
    path: (d) => `/metrics-service/metrics/trainingreadiness/${d}`,
    capability: "trainingReadiness",
  },
  vo2max: {
    kind: "daily",
    path: (d) => `/metrics-service/metrics/maxmet/daily/${d}/${d}`,
    capability: "vo2max",
  },
  racePredictions: {
    kind: "daily",
    path: (_d, n) => `/metrics-service/metrics/racepredictions/latest/${dn(n)}`,
    capability: "racePredictions",
    needsDisplayName: true,
  },
  enduranceScore: {
    kind: "daily",
    path: (d) => `/metrics-service/metrics/endurancescore?calendarDate=${d}`,
    capability: "enduranceScore",
  },
  hillScore: {
    kind: "daily",
    path: (d) => `/metrics-service/metrics/hillscore?calendarDate=${d}`,
    capability: "hillScore",
  },
  fitnessAge: {
    kind: "daily",
    path: (d) => `/fitnessage-service/fitnessage/${d}`,
    capability: "fitnessAge",
  },
  ftp: {
    kind: "latest",
    path: () =>
      `/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING`,
    capability: "ftp",
  },
  personalRecords: {
    kind: "latest",
    path: (_d, n) => `/personalrecord-service/personalrecord/prs/${dn(n)}`,
    needsDisplayName: true,
  },
};

/** Metric names, for schema enums and defaults. */
export const METRIC_NAMES = Object.keys(METRICS) as [string, ...string[]];

/** Metrics that make up the useful default set. */
export const DEFAULT_METRICS = [
  "trainingStatus",
  "trainingReadiness",
  "vo2max",
  "racePredictions",
  "ftp",
  "personalRecords",
];

/** The `connectapi` path holding the account's social profile. */
export const SOCIAL_PROFILE_PATH = "/userprofile-service/socialProfile";

/** Build the path for one daily metric + date, honouring display-name needs. */
export function metricPath(
  metric: string,
  date: string,
  displayName: string,
): string {
  const spec = METRICS[metric];
  if (!spec) throw new Error(`unknown metric: ${metric}`);
  if (spec.needsDisplayName && !displayName) {
    throw new Error(
      `metric '${metric}' needs the account display name, which was not found. ` +
        `Run the transport's 'profile' method first.`,
    );
  }
  return spec.path(date, displayName);
}

/** The `latest` (non-date) metrics. */
export function latestMetrics(): string[] {
  return Object.entries(METRICS)
    .filter(([, spec]) => spec.kind === "latest")
    .map(([name]) => name);
}

/** The `daily` (date-keyed) metrics. */
export function dailyMetrics(): string[] {
  return Object.entries(METRICS)
    .filter(([, spec]) => spec.kind === "daily")
    .map(([name]) => name);
}

/** An inclusive list of `YYYY-MM-DD` dates from `start` to `end`. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return out;
  for (let t = s; t <= e; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Select metrics to fetch, applying capability gating when requested.
 *
 * A metric with no `capability` is always kept. With gating on, a metric whose
 * capability is not explicitly `true` is dropped. Returns the selected *and*
 * skipped names so a caller can log why a metric is absent.
 */
export function selectMetrics(
  requested: string[],
  capabilities: Record<string, boolean>,
  respectCapabilities: boolean,
): { selected: string[]; skipped: string[] } {
  const selected: string[] = [];
  const skipped: string[] = [];
  for (const metric of requested) {
    const spec = METRICS[metric];
    if (!spec) {
      skipped.push(metric);
      continue;
    }
    if (
      respectCapabilities && spec.capability &&
      capabilities[spec.capability] !== true
    ) {
      skipped.push(metric);
      continue;
    }
    selected.push(metric);
  }
  return { selected, skipped };
}

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  cacheDir: z.string()
    .default("~/.swamp/garmin-cache")
    .describe(
      "Shared cache directory to read the transport's responses from (must " +
        "match the @svendowideit/garmin-connect model's cacheDir).",
    ),
  metrics: z.array(z.string())
    .default(DEFAULT_METRICS)
    .describe(
      `Performance metrics to fetch by default. Known: ${
        METRIC_NAMES.join(", ")
      }`,
    ),
  respectCapabilities: z.boolean().default(true).describe(
    "Drop device-gated metrics the account's devices do not support, using " +
      "@svendowideit/garmin-devices' capability map.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const PathsArgsSchema = z.object({
  date: z.string().optional().describe(
    "Single day for daily metrics, YYYY-MM-DD (defaults to yesterday)",
  ),
  startDate: z.string().optional().describe("Range start, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Range end, YYYY-MM-DD"),
  metrics: z.array(z.string()).optional().describe(
    "Override the global metrics for this call",
  ),
  capabilities: z.record(z.string(), z.boolean()).optional().describe(
    "Device capability map, wired in by the workflow",
  ),
  displayName: z.string().optional().describe(
    "Account display name, wired in by the workflow; falls back to the cached profile",
  ),
  latestOnly: z.boolean().default(false).describe(
    "Fetch only the latest (non-date) metrics — cheap, useful for a quick refresh",
  ),
  maxDays: z.number().int().positive().max(90).default(31).describe(
    "Safety cap on the number of days a range may expand to",
  ),
});

const SyncArgsSchema = z.object({
  date: z.string().optional().describe("Single day to parse, YYYY-MM-DD"),
  startDate: z.string().optional().describe("Range start, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Range end, YYYY-MM-DD"),
  displayName: z.string().optional().describe(
    "Account display name; falls back to the cached social profile",
  ),
});

const SetupArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** First defined finite number among keys. */
export function pickNumber(
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

/** First defined non-empty string among keys. */
export function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/** Safely read a nested object. */
function objectAt(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const v = (value as Record<string, unknown>)[key];
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

/**
 * A normalised day of performance data.
 *
 * Every field is nullable — Garmin computes each metric only when the device
 * and the day's data allow it, so absence is normal, never zero.
 */
export interface DailyPerformance {
  date: string;
  /** Training status phrase, e.g. "PRODUCTIVE", "MAINTAINING", "DETRAINING". */
  trainingStatus: string | null;
  /** Training status feedback, e.g. "IMPROVING_FITNESS". */
  trainingStatusFeedback: string | null;
  /** Acute training load (ATL) when present. */
  acuteLoad: number | null;
  /** Training readiness score 0-100. */
  trainingReadiness: number | null;
  /** Readiness level phrase, e.g. "READY", "LOW". */
  trainingReadinessLevel: string | null;
  /** VO2max from the running ("generic") estimate. */
  vo2maxRunning: number | null;
  /** VO2max from the cycling estimate. */
  vo2maxCycling: number | null;
  /** Garmin "fitness age" in years. */
  fitnessAge: number | null;
  /** Predicted 5 km time, seconds. */
  racePrediction5k: number | null;
  racePrediction10k: number | null;
  racePredictionHalf: number | null;
  racePredictionMarathon: number | null;
  /** Endurance score 0-10000-ish. */
  enduranceScore: number | null;
  /** Hill score. */
  hillScore: number | null;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

/** A fresh, all-null day. */
function emptyPerformance(date: string): DailyPerformance {
  return {
    date,
    trainingStatus: null,
    trainingStatusFeedback: null,
    acuteLoad: null,
    trainingReadiness: null,
    trainingReadinessLevel: null,
    vo2maxRunning: null,
    vo2maxCycling: null,
    fitnessAge: null,
    racePrediction5k: null,
    racePrediction10k: null,
    racePredictionHalf: null,
    racePredictionMarathon: null,
    enduranceScore: null,
    hillScore: null,
  };
}

/** Read a race-prediction value, which Garmin reports in seconds. */
function racePredictionSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    // Garmin sometimes returns "1:23:45" or a plain seconds string.
    const parts = value.split(":").map((p) => Number(p));
    if (parts.some((p) => Number.isNaN(p))) return null;
    if (parts.length === 3) {
      return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    }
    if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
    return parts[0] ?? null;
  }
  return null;
}

/**
 * Merge one parsed metric body into a day's performance row.
 *
 * Defensive about shape: Garmin nests training status under several keys and
 * reports VO2max separately per sport under `generic`/`cycling`.
 */
export function mergeMetric(
  row: DailyPerformance,
  metric: string,
  body: unknown,
): void {
  if (!body) return;
  const b = Array.isArray(body) ? body[0] : body;
  if (!b || typeof b !== "object") return;
  const rec = b as Record<string, unknown>;

  switch (metric) {
    case "trainingStatus": {
      // { mostRecentTrainingStatus: { latestTrainingStatusData: { <deviceId>: {...} } } }
      const data = objectAt(rec, "mostRecentTrainingStatus");
      const latest = data ? objectAt(data, "latestTrainingStatusData") : null;
      if (latest) {
        for (const value of Object.values(latest)) {
          const entry = value as Record<string, unknown>;
          const status = objectAt(entry, "trainingStatus") ?? entry;
          row.trainingStatus ??= pickString(
            status,
            "trainingStatusKey",
            "statusKey",
            "trainingStatus",
          );
          row.trainingStatusFeedback ??= pickString(
            status,
            "feedbackLong",
            "feedback",
          );
          row.acuteLoad ??= pickNumber(status, "acuteTrainingLoad", "atl");
          if (row.trainingStatus) break;
        }
      }
      // Fall back to a flatter shape for accounts/devices that return one.
      row.trainingStatus ??= pickString(
        objectAt(rec, "trainingStatus") ?? {},
        "trainingStatusKey",
        "statusKey",
      );
      break;
    }
    case "trainingReadiness": {
      // Response is a list of snapshots; the latest has the current score.
      const snapshots = Array.isArray(body) ? body : [b];
      let best: Record<string, unknown> | null = null;
      for (const s of snapshots) {
        const snap = s as Record<string, unknown>;
        if (pickNumber(snap, "score") === null) continue;
        if (
          !best ||
          (pickString(snap, "timestamp") ?? "") >
            (pickString(best, "timestamp") ?? "")
        ) {
          best = snap;
        }
      }
      if (best) {
        row.trainingReadiness = pickNumber(best, "score");
        row.trainingReadinessLevel = pickString(best, "level");
      }
      break;
    }
    case "vo2max": {
      // { generic: {...}, cycling: {...} } — one level down per sport.
      const generic = objectAt(rec, "generic") ?? rec;
      const cycling = objectAt(rec, "cycling");
      row.vo2maxRunning = pickNumber(
        generic,
        "vo2MaxPreciseValue",
        "vo2MaxValue",
      );
      row.fitnessAge ??= pickNumber(generic, "fitnessAge");
      if (cycling) {
        row.vo2maxCycling = pickNumber(
          cycling,
          "vo2MaxPreciseValue",
          "vo2MaxValue",
        );
      }
      break;
    }
    case "fitnessAge": {
      row.fitnessAge ??= pickNumber(rec, "fitnessAge", "chronologicalAge");
      break;
    }
    case "racePredictions": {
      const preds = Array.isArray(rec.racePredictions)
        ? rec.racePredictions as Record<string, unknown>[]
        : Array.isArray(b)
        ? b as Record<string, unknown>[]
        : [rec];
      const latest = preds.length > 0 ? preds[preds.length - 1]! : rec;
      row.racePrediction5k = racePredictionSeconds(
        latest.time5K ?? latest.time5k,
      );
      row.racePrediction10k = racePredictionSeconds(
        latest.time10K ?? latest.time10k,
      );
      row.racePredictionHalf = racePredictionSeconds(
        latest.timeHalfMarathon ?? latest.timeHalf,
      );
      row.racePredictionMarathon = racePredictionSeconds(
        latest.timeMarathon,
      );
      break;
    }
    case "enduranceScore": {
      row.enduranceScore = pickNumber(
        rec,
        "overallScore",
        "enduranceScore",
        "score",
      );
      break;
    }
    case "hillScore": {
      row.hillScore = pickNumber(rec, "overallScore", "hillScore", "score");
      break;
    }
    default:
      break;
  }
}

/** Parse a cached body as JSON, returning null on miss or bad JSON. */
function parseCached(body: string | null): unknown | null {
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Read the account display name from the transport's cached social profile. */
async function readDisplayName(cacheDir: string): Promise<string> {
  const { body } = await readCachedByPath(cacheDir, SOCIAL_PROFILE_PATH);
  const parsed = parseCached(body);
  if (!parsed || typeof parsed !== "object") return "";
  const p = parsed as Record<string, unknown>;
  return String(p.displayName ?? p.userName ?? "");
}

// ---------------------------------------------------------------------------
// Latest-value extraction (FTP, personal records, and bests from the range)
// ---------------------------------------------------------------------------

/** The current FTP, from the biometric endpoint. */
export function parseFtp(body: unknown): number | null {
  if (!body) return null;
  const rec = Array.isArray(body) ? body[0] : body;
  if (!rec || typeof rec !== "object") return null;
  return pickNumber(
    rec as Record<string, unknown>,
    "functionalThresholdPower",
    "ftp",
    "value",
  );
}

/** One personal-record entry, normalised. */
export interface PersonalRecord {
  typeId: number | null;
  activityType: string;
  /** Record distance in metres, when the record is a distance. */
  distanceMeters: number | null;
  /** Record duration in seconds, when applicable. */
  durationSeconds: number | null;
  /** Record value (e.g. max weight) for non-time records. */
  value: number | null;
  /** ISO-8601 instant of the record, when present. */
  recordDate: string | null;
  activityId: string | null;
  /** Human label Garmin supplies, when present. */
  label: string | null;
}

/**
 * Parse personal records.
 *
 * Garmin returns a list, each entry identifying its activity type and either a
 * distance or a duration. The `typeId` maps to a distance for running (see the
 * library docs), so both are surfaced and the caller decides.
 */
export function parsePersonalRecords(body: unknown): PersonalRecord[] {
  if (!Array.isArray(body)) return [];
  const out: PersonalRecord[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const activityType = pickString(rec, "activityType", "activityTypeKey") ??
      "";
    out.push({
      typeId: pickNumber(rec, "typeId"),
      activityType,
      distanceMeters: pickNumber(rec, "distance", "distanceInMeters"),
      durationSeconds: pickNumber(rec, "duration", "time"),
      value: pickNumber(rec, "value", "prValue"),
      recordDate: pickString(rec, "prStartTimeGmt", "recordDate", "date"),
      activityId: rec.activityId != null ? String(rec.activityId) : null,
      label: pickString(rec, "prTypeLabel", "label", "typeLabel"),
    });
  }
  return out;
}

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
};

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const DailySchema = z.object({
  date: z.string(),
  trainingStatus: z.string().nullable(),
  trainingStatusFeedback: z.string().nullable(),
  acuteLoad: z.number().nullable(),
  trainingReadiness: z.number().nullable(),
  trainingReadinessLevel: z.string().nullable(),
  vo2maxRunning: z.number().nullable(),
  vo2maxCycling: z.number().nullable(),
  fitnessAge: z.number().nullable(),
  racePrediction5k: z.number().nullable(),
  racePrediction10k: z.number().nullable(),
  racePredictionHalf: z.number().nullable(),
  racePredictionMarathon: z.number().nullable(),
  enduranceScore: z.number().nullable(),
  hillScore: z.number().nullable(),
  /** The raw per-metric bodies, so nothing is lost in normalisation. */
  metrics: z.record(z.string(), z.unknown()),
});

const RangeResultSchema = z.object({
  generatedAt: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  days: z.number(),
  metricsFetched: z.array(z.string()),
  metricsSkipped: z.array(z.string()),
  summaries: z.array(DailySchema),
});

const RecordsSchema = z.object({
  generatedAt: z.string(),
  ftp: z.number().nullable(),
  personalRecords: z.array(z.object({
    typeId: z.number().nullable(),
    activityType: z.string(),
    distanceMeters: z.number().nullable(),
    durationSeconds: z.number().nullable(),
    value: z.number().nullable(),
    recordDate: z.string().nullable(),
    activityId: z.string().nullable(),
    label: z.string().nullable(),
  })),
  /** Best values seen across the parsed window, when a range was synced. */
  best: z.object({
    vo2maxRunning: z.number().nullable(),
    vo2maxCycling: z.number().nullable(),
    enduranceScore: z.number().nullable(),
    hillScore: z.number().nullable(),
    trainingReadiness: z.number().nullable(),
  }),
});

const PathsResultSchema = z.object({
  paths: z.array(z.string()),
  dates: z.array(z.string()),
  metrics: z.array(z.string()),
  skipped: z.array(z.string()),
  latestMetrics: z.array(z.string()),
});

const SetupSchema = z.object({ report: z.string() });

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The `@svendowideit/garmin-performance` model definition. */
export const model = {
  type: "@svendowideit/garmin-performance",
  version: "2026.09.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    metrics: {
      description:
        "One day's performance metrics plus the raw bodies, keyed by date",
      schema: DailySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    range: {
      description: "A multi-day window in one resource with a row per day",
      schema: RangeResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    records: {
      description:
        "Latest values with no date (FTP, personal records) plus bests seen",
      schema: RecordsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    paths: {
      description: "The connectapi paths the transport should fetch",
      schema: PathsResultSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    setup: {
      description: "Configuration-readiness report",
      schema: SetupSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
  },
  methods: {
    setup: {
      description:
        "Report the configured metrics, capability gating, and display-name " +
        "state. Read-only.",
      arguments: SetupArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const displayName = await readDisplayName(g.cacheDir);
        const { selected, skipped } = selectMetrics(g.metrics, {}, false);
        const daily = selected.filter((m) => METRICS[m]?.kind === "daily");
        const latest = selected.filter((m) => METRICS[m]?.kind === "latest");
        const lines = [
          "Garmin performance configuration",
          `  cache dir:            ${g.cacheDir}`,
          `  respect capabilities: ${g.respectCapabilities}`,
          `  display name:         ${
            displayName || "(unknown — run the transport 'profile' method)"
          }`,
          `  metrics requested:    ${g.metrics.join(", ")}`,
          `  daily metrics:        ${daily.join(", ") || "(none)"}`,
          `  latest metrics:       ${latest.join(", ") || "(none)"}`,
          `  metrics unknown:      ${skipped.join(", ") || "(none)"}`,
          "",
          "Device gating uses @svendowideit/garmin-devices' capability map, wired",
          "in by the garmin-performance-sync workflow.",
          "",
          "To populate the cache, run:",
          "  swamp workflow run @svendowideit/garmin-performance-sync",
        ];
        const report = lines.join("\n");
        const handle = await ctx.writeResource("setup", "report", { report });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    paths: {
      description:
        "Build the connectapi paths for the requested dates and metrics. Daily " +
        "metrics get one path per day; latest metrics get one path total. Reads " +
        "the display name from the cached profile and (when respectCapabilities " +
        "is on) drops unsupported metrics. `skipped` records what gating " +
        "removed. Feed `paths` to the transport's fetch-many.",
      arguments: PathsArgsSchema,
      execute: async (
        args: z.infer<typeof PathsArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const dates = resolveDates(args);
        if (dates.length === 0) {
          throw new Error("No dates resolved — check date/startDate/endDate");
        }
        if (dates.length > args.maxDays) {
          throw new Error(
            `Range expands to ${dates.length} days, over the maxDays cap of ` +
              `${args.maxDays}. Narrow the window or raise maxDays.`,
          );
        }

        const displayName = args.displayName?.trim() ||
          await readDisplayName(g.cacheDir);
        const { selected, skipped } = selectMetrics(
          args.metrics ?? g.metrics,
          args.capabilities ?? {},
          g.respectCapabilities,
        );

        const daily = selected.filter((m) => METRICS[m]!.kind === "daily");
        const latest = selected.filter((m) => METRICS[m]!.kind === "latest");
        // `latestOnly` is expressed by building no daily paths.
        const dailyToFetch = args.latestOnly ? [] : daily;

        const paths: string[] = [];
        for (const metric of dailyToFetch) {
          for (const date of dates) {
            paths.push(metricPath(metric, date, displayName));
          }
        }
        for (const metric of latest) {
          paths.push(metricPath(metric, dates[dates.length - 1]!, displayName));
        }

        const handle = await ctx.writeResource("paths", "performance-paths", {
          paths,
          dates,
          metrics: selected,
          skipped,
          latestMetrics: latest,
        });
        ctx.logger.info(
          "Built {n} performance paths ({daily} daily × {days} day(s), {latest} latest){skipped}",
          {
            n: paths.length,
            daily: dailyToFetch.length,
            days: dates.length,
            latest: latest.length,
            skipped: skipped.length ? ` (skipped: ${skipped.join(", ")})` : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Parse the cached performance bodies into `metrics-<date>` per day, a " +
        "`performance-range` roll-up, and a `records` resource for the latest " +
        "values (FTP, personal records) and bests. Reads the shared cache; run " +
        "the transport's fetch first (the garmin-performance-sync workflow does " +
        "both).",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();
        const pathsResource = await ctx.readResource("performance-paths");
        const dates = Array.isArray(pathsResource?.dates)
          ? pathsResource!.dates as string[]
          : resolveDates(args);
        const metrics = Array.isArray(pathsResource?.metrics)
          ? pathsResource!.metrics as string[]
          : g.metrics;
        const skipped = Array.isArray(pathsResource?.skipped)
          ? pathsResource!.skipped as string[]
          : [];

        if (dates.length === 0) {
          throw new Error(
            "No performance paths recorded. Run the `paths` method first (the " +
              "garmin-performance-sync workflow does this).",
          );
        }

        const displayName = args.displayName?.trim() ||
          await readDisplayName(g.cacheDir);
        const dailyMetrics = metrics.filter((m) =>
          METRICS[m]?.kind === "daily"
        );
        const handles: ResDataHandle[] = [];
        const rows: DailyPerformance[] = [];

        for (const date of dates) {
          const row = emptyPerformance(date);
          const raw: Record<string, unknown> = {};
          for (const metric of dailyMetrics) {
            const path = metricPath(metric, date, displayName);
            const cached = await readCachedByPath(g.cacheDir, path);
            if (cached.body === null) continue;
            const parsed = parseCached(cached.body);
            raw[metric] = parsed;
            mergeMetric(row, metric, parsed);
          }
          rows.push(row);
          handles.push(
            await ctx.writeResource("metrics", `metrics-${date}`, {
              ...row,
              metrics: raw,
            }),
          );
        }

        // Latest metrics are date-less; read them once.
        const recordsRaw: Record<string, unknown> = {};
        for (const metric of metrics) {
          if (METRICS[metric]?.kind !== "latest") continue;
          const path = metricPath(
            metric,
            dates[dates.length - 1]!,
            displayName,
          );
          const cached = await readCachedByPath(g.cacheDir, path);
          if (cached.body === null) continue;
          recordsRaw[metric] = parseCached(cached.body);
        }

        const best = {
          vo2maxRunning: maxOf(rows.map((r) => r.vo2maxRunning)),
          vo2maxCycling: maxOf(rows.map((r) => r.vo2maxCycling)),
          enduranceScore: maxOf(rows.map((r) => r.enduranceScore)),
          hillScore: maxOf(rows.map((r) => r.hillScore)),
          trainingReadiness: maxOf(rows.map((r) => r.trainingReadiness)),
        };
        const records = {
          generatedAt: new Date(nowMs).toISOString(),
          ftp: parseFtp(recordsRaw.ftp),
          personalRecords: parsePersonalRecords(recordsRaw.personalRecords),
          best,
        };
        handles.push(await ctx.writeResource("records", "records", records));

        const range = {
          generatedAt: new Date(nowMs).toISOString(),
          startDate: dates[0]!,
          endDate: dates[dates.length - 1]!,
          days: dates.length,
          metricsFetched: metrics,
          metricsSkipped: skipped,
          summaries: rows,
        };
        handles.push(
          await ctx.writeResource("range", "performance-range", range),
        );

        ctx.logger.info(
          "Synced {days} day(s) of performance; FTP {ftp}, {pr} personal record(s)",
          {
            days: dates.length,
            ftp: records.ftp ?? "n/a",
            pr: records.personalRecords.length,
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};

/** The largest non-null value, or null when the list has none. */
export function maxOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : Math.max(...nums);
}

/** Resolve the date window from method args (single date or range). */
export function resolveDates(args: {
  date?: string;
  startDate?: string;
  endDate?: string;
}): string[] {
  if (args.startDate?.trim()) {
    const end = args.endDate?.trim() || args.startDate.trim();
    return dateRange(args.startDate.trim(), end);
  }
  if (args.date?.trim()) return [args.date.trim()];
  // Default: yesterday — Garmin often has no performance data for today yet.
  const yesterday = new Date(Date.now() - 86_400_000);
  return [yesterday.toISOString().slice(0, 10)];
}
