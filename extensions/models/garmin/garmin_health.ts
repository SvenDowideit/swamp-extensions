/**
 * `@svendowideit/garmin-health` — daily wellness from Garmin Connect.
 *
 * Garmin splits wellness across many single-day endpoints: a daily summary,
 * sleep, stress, heart rate, body battery, respiration, SpO2, HRV, intensity
 * minutes, floors and resting heart rate. Several of those are addressed by the
 * user's **display name** rather than an id, and several more only exist when
 * the account has a device that records them.
 *
 * This model handles both facts without fetching anything itself:
 *
 *   - `paths` builds the `connectapi` paths for the requested dates and metrics,
 *     reading `displayName` from the transport's cached `profile`. Which metrics
 *     are included is governed by **`metrics`** and, when `respectCapabilities`
 *     is on, by the device capability map — so a workflow never requests HRV or
 *     SpO2 from an account with no device that produces them.
 *   - `sync` reads the cached bodies (via `readCachedByPath`), normalises each
 *     into `daily-<date>`, and rolls a multi-day window into `health-range` with
 *     the per-day summary fields extracted for easy querying.
 *
 * As with every domain model here, a workflow runs the transport's `fetch-many`
 * for the paths this model declares, then calls `sync`. Parsing stays pure.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { readCachedByPath } from "./garmin_cache.ts";

/**
 * The `connectapi` path holding the account's social profile.
 *
 * Several wellness endpoints are addressed by the user's display name, which
 * the transport caches here. Reading it from the shared cache (rather than
 * reading another model's resource, which swamp does not allow) keeps the
 * domain model's only cross-cutting read a cached body — the same seam the rest
 * of the model uses.
 */
export const SOCIAL_PROFILE_PATH = "/userprofile-service/socialProfile";

// ---------------------------------------------------------------------------
// Metrics and their endpoints
// ---------------------------------------------------------------------------

/**
 * A wellness metric this model knows how to fetch.
 *
 * `capability` is the key in `@svendowideit/garmin-devices`' capability map
 * (when not set, the metric is not device-gated). `needsDisplayName` marks the
 * endpoints addressed by the user's display name.
 */
export interface MetricSpec {
  /** Build the `connectapi` path for a date. */
  path: (date: string, displayName: string) => string;
  /** Capability-map key that gates this metric, if any. */
  capability?: string;
  /** Whether the path needs the display name. */
  needsDisplayName?: boolean;
}

/** Encode a display name the way Garmin path builders do. */
function dn(displayName: string): string {
  return encodeURIComponent(displayName);
}

/** Every wellness metric this model supports, keyed by a short name. */
export const METRICS: Record<string, MetricSpec> = {
  summary: {
    path: (d, n) =>
      `/usersummary-service/usersummary/daily/${dn(n)}?calendarDate=${d}`,
    needsDisplayName: true,
  },
  sleep: {
    path: (d, n) =>
      `/wellness-service/wellness/dailySleepData/${
        dn(n)
      }?date=${d}&nonSleepBufferMinutes=60`,
    capability: "sleep",
    needsDisplayName: true,
  },
  stress: {
    path: (d) => `/wellness-service/wellness/dailyStress/${d}`,
    capability: "stress",
  },
  heartRate: {
    path: (d, n) =>
      `/wellness-service/wellness/dailyHeartRate/${dn(n)}?date=${d}`,
    needsDisplayName: true,
  },
  restingHeartRate: {
    path: (d, n) =>
      `/userstats-service/wellness/daily/${
        dn(n)
      }?fromDate=${d}&untilDate=${d}&metricId=60`,
    needsDisplayName: true,
  },
  bodyBattery: {
    path: (d) =>
      `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${d}&endDate=${d}`,
    capability: "bodyBattery",
  },
  respiration: {
    path: (d) => `/wellness-service/wellness/daily/respiration/${d}`,
    capability: "respiration",
  },
  spo2: {
    path: (d) => `/wellness-service/wellness/daily/spo2/${d}`,
    capability: "spo2",
  },
  hrv: {
    path: (d) => `/hrv-service/hrv/${d}`,
    capability: "hrv",
  },
  intensityMinutes: {
    path: (d) => `/wellness-service/wellness/daily/im/${d}`,
    capability: "intensityMinutes",
  },
  floors: {
    path: (d) => `/wellness-service/wellness/floorsChartData/daily/${d}`,
  },
  stepsChart: {
    path: (d, n) =>
      `/wellness-service/wellness/dailySummaryChart/${dn(n)}?date=${d}`,
    needsDisplayName: true,
  },
};

/** Metric names, for schema enums and defaults. */
export const METRIC_NAMES = Object.keys(METRICS) as [string, ...string[]];

/** Metrics that make up the useful default set. */
export const DEFAULT_METRICS = [
  "summary",
  "sleep",
  "stress",
  "heartRate",
  "restingHeartRate",
  "bodyBattery",
  "stepsChart",
];

/** Build the path for one metric + date, honouring its display-name need. */
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
 * Select the metrics to fetch, applying the capability map when requested.
 *
 * A metric with no `capability` is always kept. A metric whose capability is
 * `false` (or absent) is dropped when `respectCapabilities` is on; when it is
 * off, every requested metric is kept. The result is returned alongside the
 * names that were skipped, so a caller can log *why* a metric is missing.
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
      `Wellness metrics to fetch by default. Known: ${METRIC_NAMES.join(", ")}`,
    ),
  respectCapabilities: z.boolean().default(true).describe(
    "Drop device-gated metrics the account's devices do not support, using " +
      "@svendowideit/garmin-devices' capability map. Set false to request " +
      "everything and let each endpoint return empty when unsupported.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const PathsArgsSchema = z.object({
  date: z.string().optional().describe(
    "Single day to fetch, YYYY-MM-DD (defaults to yesterday — a full day's data)",
  ),
  startDate: z.string().optional().describe(
    "Range start, YYYY-MM-DD (overrides `date`)",
  ),
  endDate: z.string().optional().describe(
    "Range end, YYYY-MM-DD (defaults to startDate)",
  ),
  metrics: z.array(z.string()).optional().describe(
    "Override the global metrics for this call",
  ),
  capabilities: z.record(z.string(), z.boolean()).optional().describe(
    "The device capability map, wired in by the workflow from " +
      "@svendowideit/garmin-devices. Used to drop unsupported metrics.",
  ),
  displayName: z.string().optional().describe(
    "Account display name, wired in by the workflow from the transport's " +
      "`profile` resource. Falls back to the cached social profile.",
  ),
  maxDays: z.number().int().positive().max(90).default(31).describe(
    "Safety cap on the number of days a range may expand to",
  ),
});

const SyncArgsSchema = z.object({
  date: z.string().optional().describe("Single day to parse, YYYY-MM-DD"),
  startDate: z.string().optional().describe("Range start, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Range end, YYYY-MM-DD"),
  metrics: z.array(z.string()).optional().describe(
    "Metrics to parse (must match the paths that were fetched)",
  ),
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

/** First defined string among keys. */
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

/**
 * The compact per-day summary surfaced in `health-range`.
 *
 * Every field is nullable: a given day legitimately lacks a metric (no sleep
 * recorded, no scale, HRV absent). Null means "not recorded", never zero.
 */
export interface DailyHealthSummary {
  date: string;
  steps: number | null;
  stepGoal: number | null;
  distanceMeters: number | null;
  restingHeartRate: number | null;
  minHeartRate: number | null;
  maxHeartRate: number | null;
  sleepSeconds: number | null;
  sleepScore: number | null;
  avgStress: number | null;
  maxStress: number | null;
  bodyBatteryCharged: number | null;
  bodyBatteryDrained: number | null;
  bodyBatteryHighest: number | null;
  bodyBatteryLowest: number | null;
  intensityMinutes: number | null;
  floorsAscended: number | null;
  totalKilocalories: number | null;
  activeKilocalories: number | null;
  hrvLastNightAvg: number | null;
  hrvStatus: string | null;
  spo2Avg: number | null;
  respirationAvg: number | null;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

/** Empty summary for a date, before any metric is merged in. */
function emptySummary(date: string): DailyHealthSummary {
  return {
    date,
    steps: null,
    stepGoal: null,
    distanceMeters: null,
    restingHeartRate: null,
    minHeartRate: null,
    maxHeartRate: null,
    sleepSeconds: null,
    sleepScore: null,
    avgStress: null,
    maxStress: null,
    bodyBatteryCharged: null,
    bodyBatteryDrained: null,
    bodyBatteryHighest: null,
    bodyBatteryLowest: null,
    intensityMinutes: null,
    floorsAscended: null,
    totalKilocalories: null,
    activeKilocalories: null,
    hrvLastNightAvg: null,
    hrvStatus: null,
    spo2Avg: null,
    respirationAvg: null,
  };
}

/** Safely read a nested object. */
function objectAt(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const v = (value as Record<string, unknown>)[key];
  return v && typeof v === "object" ? v as Record<string, unknown> : null;
}

/**
 * Merge one parsed metric body into a day's summary.
 *
 * Field names are read defensively — Garmin renames things — and a metric that
 * is `null` (the endpoint returned nothing for that day) simply changes nothing.
 */
export function mergeMetric(
  summary: DailyHealthSummary,
  metric: string,
  body: unknown,
): void {
  if (!body || typeof body !== "object") return;
  const b = body as Record<string, unknown>;
  switch (metric) {
    case "summary":
    case "stepsChart": {
      const distance = pickNumber(b, "totalDistanceMeters", "totalDistance");
      if (distance !== null) summary.distanceMeters = distance;
      const steps = pickNumber(b, "totalSteps");
      if (steps !== null) summary.steps = steps;
      summary.stepGoal ??= pickNumber(b, "dailyStepGoal");
      summary.restingHeartRate ??= pickNumber(b, "restingHeartRate");
      summary.minHeartRate ??= pickNumber(b, "minHeartRate");
      summary.maxHeartRate ??= pickNumber(b, "maxHeartRate");
      summary.sleepSeconds ??= pickNumber(b, "sleepingSeconds");
      summary.avgStress ??= pickNumber(b, "averageStressLevel");
      summary.maxStress ??= pickNumber(b, "maxStressLevel");
      summary.bodyBatteryCharged ??= pickNumber(
        b,
        "bodyBatteryChargedValue",
      );
      summary.bodyBatteryDrained ??= pickNumber(
        b,
        "bodyBatteryDrainedValue",
      );
      summary.bodyBatteryHighest ??= pickNumber(
        b,
        "bodyBatteryHighestValue",
      );
      summary.bodyBatteryLowest ??= pickNumber(b, "bodyBatteryLowestValue");
      summary.floorsAscended ??= pickNumber(b, "floorsAscended");
      summary.totalKilocalories ??= pickNumber(b, "totalKilocalories");
      summary.activeKilocalories ??= pickNumber(b, "activeKilocalories");
      const moderate = pickNumber(b, "moderateIntensityMinutes") ?? 0;
      const vigorous = pickNumber(b, "vigorousIntensityMinutes") ?? 0;
      if (moderate + vigorous > 0) {
        summary.intensityMinutes = moderate + vigorous;
      }
      break;
    }
    case "sleep": {
      const dto = objectAt(b, "dailySleepDTO") ?? b;
      const seconds = pickNumber(dto, "sleepTimeSeconds");
      if (seconds !== null) summary.sleepSeconds = seconds;
      const score = objectAt(dto, "sleepScores");
      const overall = score ? objectAt(score, "overall") : null;
      summary.sleepScore ??= overall
        ? pickNumber(overall, "value")
        : pickNumber(dto, "sleepScore", "overallSleepScore");
      break;
    }
    case "stress": {
      const avg = pickNumber(b, "avgStressLevel", "averageStressLevel");
      if (avg !== null) summary.avgStress = avg;
      const max = pickNumber(b, "maxStressLevel");
      if (max !== null) summary.maxStress = max;
      break;
    }
    case "heartRate": {
      summary.restingHeartRate ??= pickNumber(b, "restingHeartRate");
      const min = pickNumber(b, "minHeartRate");
      if (min !== null) summary.minHeartRate = min;
      const max = pickNumber(b, "maxHeartRate");
      if (max !== null) summary.maxHeartRate = max;
      break;
    }
    case "restingHeartRate": {
      // Range response: { allMetrics: { metricsMap: { WELLNESS_RESTING_HEART_RATE: [ { value } ] } } }
      const metricsMap = objectAt(objectAt(b, "allMetrics"), "metricsMap");
      const series = metricsMap?.WELLNESS_RESTING_HEART_RATE;
      if (Array.isArray(series) && series.length > 0) {
        summary.restingHeartRate ??= pickNumber(
          series[0] as Record<string, unknown>,
          "value",
        );
      }
      break;
    }
    case "bodyBattery": {
      const entry = Array.isArray(b) ? b[0] : b;
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        summary.bodyBatteryCharged ??= pickNumber(e, "charged");
        summary.bodyBatteryDrained ??= pickNumber(e, "drained");
      }
      break;
    }
    case "hrv": {
      const hrvSummary = objectAt(b, "hrvSummary");
      if (hrvSummary) {
        summary.hrvLastNightAvg = pickNumber(hrvSummary, "lastNightAvg");
        summary.hrvStatus = pickString(hrvSummary, "status");
      }
      break;
    }
    case "spo2": {
      summary.spo2Avg ??= pickNumber(
        b,
        "averageSpO2",
        "lastSevenDaysAvgSpO2",
        "averageSpo2",
      );
      break;
    }
    case "respiration": {
      summary.respirationAvg ??= pickNumber(
        b,
        "avgWakingRespirationValue",
        "avgSleepRespirationValue",
        "averageRespirationValue",
      );
      break;
    }
    case "intensityMinutes": {
      const moderate = pickNumber(b, "moderateIntensityMinutes") ?? 0;
      const vigorous = pickNumber(b, "vigorousIntensityMinutes") ?? 0;
      if (moderate + vigorous > 0) {
        summary.intensityMinutes = moderate + vigorous;
      }
      break;
    }
    case "floors": {
      summary.floorsAscended ??= pickNumber(
        b,
        "floorsAscended",
        "totalFloors",
      );
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

/**
 * Read the account display name from the transport's cached social profile.
 *
 * Returns "" on a miss so the path builder's own error explains what to run.
 */
async function readDisplayName(cacheDir: string): Promise<string> {
  const { body } = await readCachedByPath(cacheDir, SOCIAL_PROFILE_PATH);
  const parsed = parseCached(body);
  if (!parsed || typeof parsed !== "object") return "";
  const p = parsed as Record<string, unknown>;
  return String(p.displayName ?? p.userName ?? "");
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
  steps: z.number().nullable(),
  stepGoal: z.number().nullable(),
  distanceMeters: z.number().nullable(),
  restingHeartRate: z.number().nullable(),
  minHeartRate: z.number().nullable(),
  maxHeartRate: z.number().nullable(),
  sleepSeconds: z.number().nullable(),
  sleepScore: z.number().nullable(),
  avgStress: z.number().nullable(),
  maxStress: z.number().nullable(),
  bodyBatteryCharged: z.number().nullable(),
  bodyBatteryDrained: z.number().nullable(),
  bodyBatteryHighest: z.number().nullable(),
  bodyBatteryLowest: z.number().nullable(),
  intensityMinutes: z.number().nullable(),
  floorsAscended: z.number().nullable(),
  totalKilocalories: z.number().nullable(),
  activeKilocalories: z.number().nullable(),
  hrvLastNightAvg: z.number().nullable(),
  hrvStatus: z.string().nullable(),
  spo2Avg: z.number().nullable(),
  respirationAvg: z.number().nullable(),
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

const PathsResultSchema = z.object({
  paths: z.array(z.string()),
  dates: z.array(z.string()),
  metrics: z.array(z.string()),
  skipped: z.array(z.string()),
});

const SetupSchema = z.object({ report: z.string() });

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The `@svendowideit/garmin-health` model definition. */
export const model = {
  type: "@svendowideit/garmin-health",
  version: "2026.09.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    daily: {
      description:
        "One day's wellness summary plus the raw per-metric bodies, keyed by date",
      schema: DailySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    range: {
      description:
        "A multi-day window in one resource, with a compact summary per day",
      schema: RangeResultSchema,
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
        "Report the configured metrics, capability gating, and whether the " +
        "account display name is known. Read-only.",
      arguments: SetupArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const displayName = await readDisplayName(g.cacheDir);
        // `setup` runs standalone, so there is no wired-in capability map; show
        // what would be requested with no gating and note how gating is wired.
        const { selected, skipped } = selectMetrics(g.metrics, {}, false);
        const lines = [
          "Garmin health configuration",
          `  cache dir:            ${g.cacheDir}`,
          `  respect capabilities: ${g.respectCapabilities}`,
          `  display name:         ${
            displayName || "(unknown — run the transport 'profile' method)"
          }`,
          `  metrics requested:    ${g.metrics.join(", ")}`,
          `  metrics active (no gating): ${selected.join(", ") || "(none)"}`,
          `  metrics unknown:      ${skipped.join(", ") || "(none)"}`,
          "",
          "Device gating uses @svendowideit/garmin-devices' capability map, wired",
          "in by the garmin-health-sync workflow; run it for the gated set.",
          "",
          "To populate the cache, run:",
          "  swamp workflow run @svendowideit/garmin-health-sync",
        ];
        const report = lines.join("\n");
        const handle = await ctx.writeResource("setup", "report", { report });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    paths: {
      description:
        "Build the connectapi paths for the requested dates and metrics. Reads " +
        "the display name from the transport's cached `profile`, and (when " +
        "respectCapabilities is on) selects metrics using the cached " +
        "capability map. The result includes `skipped`, so the caller can log " +
        "why a metric is absent. Feed `paths` to the transport's fetch-many.",
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

        const paths: string[] = [];
        for (const date of dates) {
          for (const metric of selected) {
            paths.push(metricPath(metric, date, displayName));
          }
        }
        const handle = await ctx.writeResource("paths", "health-paths", {
          paths,
          dates,
          metrics: selected,
          skipped,
        });
        ctx.logger.info(
          "Built {n} health paths across {days} day(s), {m} metrics{skipped}",
          {
            n: paths.length,
            days: dates.length,
            m: selected.length,
            skipped: skipped.length ? ` (skipped: ${skipped.join(", ")})` : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Parse the cached wellness bodies into one `daily-<date>` per day and a " +
        "`health-range` roll-up. Reads the shared cache; run the transport's " +
        "fetch first (the garmin-health-sync workflow does both).",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();
        const pathsResource = await ctx.readResource("health-paths");
        const dates = Array.isArray(pathsResource?.dates)
          ? pathsResource!.dates as string[]
          : resolveDates(args);
        const metrics = Array.isArray(pathsResource?.metrics)
          ? pathsResource!.metrics as string[]
          : (args.metrics ?? g.metrics);
        const skipped = Array.isArray(pathsResource?.skipped)
          ? pathsResource!.skipped as string[]
          : [];

        if (dates.length === 0) {
          throw new Error(
            "No health paths recorded. Run the `paths` method first (the " +
              "garmin-health-sync workflow does this).",
          );
        }

        const displayName = args.displayName?.trim() ||
          await readDisplayName(g.cacheDir);
        const handles: ResDataHandle[] = [];
        const summaries: DailyHealthSummary[] = [];

        for (const date of dates) {
          const summary = emptySummary(date);
          const raw: Record<string, unknown> = {};
          for (const metric of metrics) {
            const path = metricPath(metric, date, displayName);
            const cached = await readCachedByPath(g.cacheDir, path);
            if (cached.body === null) continue;
            const parsed = parseCached(cached.body);
            raw[metric] = parsed;
            mergeMetric(summary, metric, parsed);
          }
          summaries.push(summary);
          handles.push(
            await ctx.writeResource("daily", `daily-${date}`, {
              ...summary,
              metrics: raw,
            }),
          );
        }

        const range = {
          generatedAt: new Date(nowMs).toISOString(),
          startDate: dates[0]!,
          endDate: dates[dates.length - 1]!,
          days: dates.length,
          metricsFetched: metrics,
          metricsSkipped: skipped,
          summaries,
        };
        handles.push(
          await ctx.writeResource("range", "health-range", range),
        );

        ctx.logger.info("Synced {days} day(s) of wellness across {m} metrics", {
          days: dates.length,
          m: metrics.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};

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
  // Default: yesterday — the most recent *complete* day of wellness data.
  const yesterday = new Date(Date.now() - 86_400_000);
  return [yesterday.toISOString().slice(0, 10)];
}
