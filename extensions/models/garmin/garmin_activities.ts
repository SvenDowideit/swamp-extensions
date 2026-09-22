/**
 * `@svendowideit/garmin-activities` — a Garmin account's activity history.
 *
 * This is the first truly high-volume domain model, so it is designed around
 * two facts:
 *
 *   1. **Activity listing is a date-ranged query.** Garmin's list endpoint
 *      returns activities newest-first and pages 20 at a time; it accepts a
 *      `startDate`/`endDate` filter, which is far cheaper than paging a whole
 *      history. `activity-list-path` builds that one request.
 *   2. **Per-activity detail fans out.** Splits, weather, heart-rate zones and
 *      the rest are one request *per activity*. Fetching those with N parallel
 *      `fetch` calls would contend on the transport model's lock (see the
 *      repository's fan-out rule), so `detail-paths` returns the whole list for
 *      the transport's single `fetch-many` call instead.
 *
 * Like every domain model here, it **fetches nothing itself**: a workflow runs
 * the transport's `fetch` / `fetch-many` for the paths this model declares, then
 * `sync` reads those cached responses and parses them. Parsing stays pure.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { readCachedByPath } from "./garmin_cache.ts";

// ---------------------------------------------------------------------------
// Endpoints this model owns
// ---------------------------------------------------------------------------

/** The `connectapi` activity list endpoint (date-filterable, paged). */
export const ACTIVITY_LIST_PATH =
  "/activitylist-service/activities/search/activities";

/** Per-activity sub-resources this model can pull, keyed by a short name. */
export const ACTIVITY_DETAIL_SUFFIXES = {
  detail: "", // the activity summary itself: /activity-service/activity/{id}
  splits: "/splits",
  splitSummaries: "/split_summaries",
  weather: "/weather",
  hrTimeInZones: "/hrTimeInZones",
  powerTimeInZones: "/powerTimeInZones",
  exerciseSets: "/exerciseSets",
  details: "/details",
} as const;

/** Detail kinds a caller may request. */
export type DetailKind = keyof typeof ACTIVITY_DETAIL_SUFFIXES;

/** Default detail kinds that are universally meaningful and cheap. */
export const DEFAULT_DETAIL_KINDS: DetailKind[] = [
  "detail",
  "splits",
  "weather",
];

/** Build the `connectapi` path for one activity's detail. */
export function activityDetailPath(id: string, kind: DetailKind): string {
  const suffix = ACTIVITY_DETAIL_SUFFIXES[kind];
  if (suffix === undefined) throw new Error(`unknown detail kind: ${kind}`);
  return `/activity-service/activity/${encodeURIComponent(id)}${suffix}`;
}

/** Build the date-ranged, paged activity-list path. */
export function activityListPath(opts: {
  startDate: string;
  endDate?: string;
  activityType?: string;
  start?: number;
  limit?: number;
  sortOrder?: "asc" | "desc";
}): string {
  const params = new URLSearchParams({
    start: String(opts.start ?? 0),
    limit: String(opts.limit ?? 100),
  });
  if (opts.startDate) params.set("startDate", opts.startDate);
  if (opts.endDate) params.set("endDate", opts.endDate);
  if (opts.activityType) params.set("activityType", opts.activityType);
  if (opts.sortOrder) params.set("sortOrder", opts.sortOrder);
  return `${ACTIVITY_LIST_PATH}?${params}`;
}

/** Build every detail path for one activity, for one `fetch-many` call. */
export function activityDetailPaths(
  id: string,
  kinds: DetailKind[],
): string[] {
  return kinds.map((kind) => activityDetailPath(id, kind));
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
  detailKinds: z.array(
    z.enum([
      "detail",
      "splits",
      "splitSummaries",
      "weather",
      "hrTimeInZones",
      "powerTimeInZones",
      "exerciseSets",
      "details",
    ]),
  )
    .default(["detail", "splits", "weather"])
    .describe(
      "Which per-activity sub-resources `detail-paths` requests by default",
    ),
  timezone: z.string().default("").describe(
    "IANA timezone used to bucket activity start times (e.g. " +
      "Australia/Brisbane). Empty uses UTC-derived local fields from Garmin.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const ListArgsSchema = z.object({
  days: z.number().int().positive().default(30).describe(
    "How many days back from today to list (ignored when startDate is set)",
  ),
  startDate: z.string().optional().describe(
    "Explicit start date, YYYY-MM-DD (overrides `days`)",
  ),
  endDate: z.string().optional().describe(
    "Explicit end date, YYYY-MM-DD (defaults to today)",
  ),
  activityType: z.string().optional().describe(
    "Filter by Garmin activity type key (e.g. cycling, running, swimming)",
  ),
  limit: z.number().int().positive().max(1000).default(100).describe(
    "Maximum activities to request in one page",
  ),
  sortOrder: z.enum(["asc", "desc"]).default("desc").describe(
    "Newest-first (desc) or oldest-first (asc)",
  ),
});

const DetailPathsArgsSchema = z.object({
  ids: z.array(z.string()).optional().describe(
    "Activity ids whose detail paths to build",
  ),
  kinds: z.array(z.string()).optional().describe(
    "Override the global detailKinds for this call",
  ),
  useLastList: z.boolean().default(true).describe(
    "When `ids` is omitted, read the ids from this model's most recent " +
      "`activity-list` resource. On the first run there is none, so no paths " +
      "are built and the transport fetch is skipped.",
  ),
});

const SyncArgsSchema = z.object({
  ids: z.array(z.string()).optional().describe(
    "Limit parsing to these activity ids. Omit to parse the latest list.",
  ),
  includeDetails: z.boolean().default(true).describe(
    "Also parse any cached per-activity detail responses into `activity-detail`",
  ),
});

const SetupArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Activity shaping
// ---------------------------------------------------------------------------

/** Pick the first defined value among keys (defensive against field drift). */
export function pick(
  record: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    const v = record[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** First defined finite number among keys. */
export function pickNumber(
  record: Record<string, unknown>,
  ...keys: string[]
): number | null {
  const v = pick(record, ...keys);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

/** First defined non-empty string among keys. */
export function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  const v = pick(record, ...keys);
  return typeof v === "string" ? v : v === undefined ? "" : String(v);
}

/** A normalised activity, safe to store as a resource. */
export interface NormalizedActivity {
  id: string;
  name: string;
  typeKey: string;
  parentTypeKey: string;
  startTimeLocal: string;
  startTimeGmt: string;
  /** Epoch ms of the start, or null when unparseable. */
  startMs: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  movingSeconds: number | null;
  elapsedSeconds: number | null;
  elevationGainMeters: number | null;
  elevationLossMeters: number | null;
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  normalizedPower: number | null;
  calories: number | null;
  aerobicTrainingEffect: number | null;
  anaerobicTrainingEffect: number | null;
  trainingLoad: number | null;
  trainingEffectLabel: string;
  /** Total sets/reps/volume, present only for strength activities. */
  totalSets: number | null;
  totalReps: number | null;
  totalVolume: number | null;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

/** Extract the nested `activityType` classification. */
export function activityType(record: Record<string, unknown>): {
  typeKey: string;
  parentTypeKey: string;
} {
  const t = record.activityType as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") {
    return {
      typeKey: pickString(record, "activityTypeKey", "typeKey"),
      parentTypeKey: "",
    };
  }
  return {
    typeKey: pickString(t, "typeKey"),
    parentTypeKey: pickString(t, "parentTypeKey"),
  };
}

/**
 * Normalise one raw Garmin activity.
 *
 * Returns null when the record has no usable id — a malformed row should be
 * skipped, not crash a whole sync. Durations are normalised to seconds; Garmin
 * reports `duration`/`movingDuration` in seconds and distance in metres.
 */
export function normalizeActivity(
  raw: Record<string, unknown>,
): NormalizedActivity | null {
  const rawId = pick(raw, "activityId", "id");
  if (rawId === undefined || rawId === null || rawId === "") return null;
  const id = String(rawId);

  const startTimeLocal = pickString(raw, "startTimeLocal", "startTime");
  const startTimeGmt = pickString(raw, "startTimeGMT", "startTimeGmt");
  const startIso = startTimeGmt || startTimeLocal;
  const startMs = startIso ? Date.parse(startIso) : NaN;
  const { typeKey, parentTypeKey } = activityType(raw);

  return {
    id,
    name: pickString(raw, "activityName", "name") || `activity-${id}`,
    typeKey,
    parentTypeKey,
    startTimeLocal,
    startTimeGmt,
    startMs: Number.isNaN(startMs) ? null : startMs,
    distanceMeters: pickNumber(raw, "distance"),
    durationSeconds: pickNumber(raw, "duration"),
    movingSeconds: pickNumber(raw, "movingDuration"),
    elapsedSeconds: pickNumber(raw, "elapsedDuration"),
    elevationGainMeters: pickNumber(raw, "elevationGain"),
    elevationLossMeters: pickNumber(raw, "elevationLoss"),
    avgSpeedMps: pickNumber(raw, "averageSpeed"),
    maxSpeedMps: pickNumber(raw, "maxSpeed"),
    avgHr: pickNumber(raw, "averageHR", "avgHR"),
    maxHr: pickNumber(raw, "maxHR"),
    avgPower: pickNumber(raw, "avgPower", "averagePower"),
    maxPower: pickNumber(raw, "maxPower"),
    normalizedPower: pickNumber(raw, "normPower", "normalizedPower"),
    calories: pickNumber(raw, "calories"),
    aerobicTrainingEffect: pickNumber(raw, "aerobicTrainingEffect"),
    anaerobicTrainingEffect: pickNumber(raw, "anaerobicTrainingEffect"),
    trainingLoad: pickNumber(raw, "activityTrainingLoad"),
    trainingEffectLabel: pickString(raw, "trainingEffectLabel"),
    totalSets: pickNumber(raw, "totalSets"),
    totalReps: pickNumber(raw, "totalReps"),
    totalVolume: pickNumber(raw, "totalVolume"),
  };
}

/** Coerce a cached list body (array or wrapped) to a list of records. */
export function asActivityList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["activities", "results", "activityList"]) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
  }
  return [];
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

const ActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  typeKey: z.string(),
  parentTypeKey: z.string(),
  startTimeLocal: z.string(),
  startTimeGmt: z.string(),
  startMs: z.number().nullable(),
  distanceMeters: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  movingSeconds: z.number().nullable(),
  elapsedSeconds: z.number().nullable(),
  elevationGainMeters: z.number().nullable(),
  elevationLossMeters: z.number().nullable(),
  avgSpeedMps: z.number().nullable(),
  maxSpeedMps: z.number().nullable(),
  avgHr: z.number().nullable(),
  maxHr: z.number().nullable(),
  avgPower: z.number().nullable(),
  maxPower: z.number().nullable(),
  normalizedPower: z.number().nullable(),
  calories: z.number().nullable(),
  aerobicTrainingEffect: z.number().nullable(),
  anaerobicTrainingEffect: z.number().nullable(),
  trainingLoad: z.number().nullable(),
  trainingEffectLabel: z.string(),
  totalSets: z.number().nullable(),
  totalReps: z.number().nullable(),
  totalVolume: z.number().nullable(),
});

const ActivityListResultSchema = z.object({
  generatedAt: z.string(),
  count: z.number(),
  windowStart: z.string(),
  windowEnd: z.string(),
  activityTypes: z.array(z.string()),
  cached: z.boolean(),
  activities: z.array(ActivitySchema),
});

/** One per-activity detail resource, keyed by id + kind. */
const ActivityDetailResultSchema = z.object({
  id: z.string(),
  kind: z.string(),
  cached: z.boolean(),
  /** The parsed JSON body of the detail response (shape varies by kind). */
  data: z.unknown(),
});

const PathsResultSchema = z.object({
  paths: z.array(z.string()),
  windowStart: z.string(),
  windowEnd: z.string(),
  ids: z.array(z.string()),
});

const SetupSchema = z.object({ report: z.string() });

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The `@svendowideit/garmin-activities` model definition. */
export const model = {
  type: "@svendowideit/garmin-activities",
  version: "2026.09.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    activity: {
      description: "One normalised activity, keyed by Garmin activity id",
      schema: ActivitySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    list: {
      description:
        "All activities in the window in one resource, so a workflow can pass " +
        "the whole array with a single CEL expression",
      schema: ActivityListResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    detail: {
      description:
        "A per-activity detail response (splits, weather, HR zones, …), keyed " +
        "by id and kind",
      schema: ActivityDetailResultSchema,
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
        "Report the configured window, detail kinds, and whether the activity " +
        "list is cached. Read-only.",
      arguments: SetupArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const lines = [
          "Garmin activities configuration",
          `  cache dir:     ${g.cacheDir}`,
          `  detail kinds:  ${g.detailKinds.join(", ")}`,
          `  timezone:      ${g.timezone || "(Garmin local fields)"}`,
          "",
          "To populate the cache, run:",
          "  swamp workflow run @svendowideit/garmin-activities-sync",
        ];
        const report = lines.join("\n");
        const handle = await ctx.writeResource("setup", "report", { report });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    "activity-list-path": {
      description:
        "Build the date-ranged activity list path and write it as `paths`. A " +
        "workflow fetches that path, then calls `sync` to parse it.",
      arguments: ListArgsSchema,
      execute: async (
        args: z.infer<typeof ListArgsSchema>,
        ctx: MethodContext,
      ) => {
        const today = new Date();
        const endDate = args.endDate?.trim() || isoDate(today);
        const startDate = args.startDate?.trim() ||
          isoDate(new Date(today.getTime() - args.days * 86_400_000));
        const path = activityListPath({
          startDate,
          endDate,
          activityType: args.activityType?.trim() || undefined,
          limit: args.limit,
          sortOrder: args.sortOrder,
        });
        const handle = await ctx.writeResource("paths", "activity-paths", {
          paths: [path],
          windowStart: startDate,
          windowEnd: endDate,
          ids: [],
        });
        ctx.logger.info("Activity list window {start} → {end}", {
          start: startDate,
          end: endDate,
        });
        return { dataHandles: [handle] };
      },
    },
    "detail-paths": {
      description:
        "Build per-activity detail paths for the transport's single fetch-many " +
        "call. Use this instead of N parallel fetch calls — one lock, one " +
        "batch. When `ids` is omitted, reads them from the most recent " +
        "`activity-list`, so the workflow needs no fragile CEL; on the first " +
        "run there is none, the result is empty, and the caller should skip.",
      arguments: DetailPathsArgsSchema,
      execute: async (
        args: z.infer<typeof DetailPathsArgsSchema>,
        ctx: MethodContext,
      ) => {
        const kinds =
          (args.kinds ?? ctx.globalArgs.detailKinds) as DetailKind[];
        let ids = args.ids ?? [];
        if (ids.length === 0 && args.useLastList) {
          const list = await ctx.readResource("activity-list");
          const activities = Array.isArray(list?.activities)
            ? list!.activities as Record<string, unknown>[]
            : [];
          ids = activities.map((a) => String(a.id));
        }
        const paths: string[] = [];
        for (const id of ids) {
          for (const kind of kinds) {
            paths.push(activityDetailPath(id, kind));
          }
        }
        const handle = await ctx.writeResource("paths", "detail-paths", {
          paths,
          windowStart: "",
          windowEnd: "",
          ids,
        });
        ctx.logger.info(
          "Built {n} detail paths for {ids} activities × {kinds} kinds",
          { n: paths.length, ids: ids.length, kinds: kinds.length },
        );
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Parse the cached activity list into `activity-list` plus one " +
        "`activity-<id>` per activity, and any cached detail responses into " +
        "`detail-<id>-<kind>`. Reads the shared cache; run the transport's " +
        "fetch first (the garmin-activities-sync workflow does both).",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();

        // Recover the window the workflow fetched with, from the paths resource.
        const pathsResource = await ctx.readResource("activity-paths");
        const windowStart = typeof pathsResource?.windowStart === "string"
          ? pathsResource.windowStart
          : "";
        const windowEnd = typeof pathsResource?.windowEnd === "string"
          ? pathsResource.windowEnd
          : "";
        const listPath = Array.isArray(pathsResource?.paths)
          ? String((pathsResource!.paths as unknown[])[0])
          : "";

        if (!listPath) {
          throw new Error(
            "No activity list path recorded. Run activity-list-path first " +
              "(the garmin-activities-sync workflow does this).",
          );
        }

        const { body } = await readCachedByPath(g.cacheDir, listPath);
        const activities = asActivityList(parseCached(body))
          .map((a) => normalizeActivity(a))
          .filter((a): a is NormalizedActivity => a !== null);

        const wanted = args.ids && args.ids.length > 0
          ? new Set(args.ids)
          : null;
        const selected = wanted
          ? activities.filter((a) => wanted.has(a.id))
          : activities;

        const handles: ResDataHandle[] = [];
        for (const a of selected) {
          handles.push(
            await ctx.writeResource("activity", `activity-${a.id}`, a),
          );
        }

        const listResource = {
          generatedAt: new Date(nowMs).toISOString(),
          count: selected.length,
          windowStart,
          windowEnd,
          activityTypes: [...new Set(selected.map((a) => a.typeKey))].sort(),
          cached: body !== null,
          activities: selected,
        };
        handles.push(
          await ctx.writeResource("list", "activity-list", listResource),
        );

        let details = 0;
        if (args.includeDetails) {
          for (const a of selected) {
            for (const kind of g.detailKinds as DetailKind[]) {
              const path = activityDetailPath(a.id, kind);
              const cached = await readCachedByPath(g.cacheDir, path);
              if (cached.body === null) continue;
              handles.push(
                await ctx.writeResource("detail", `detail-${a.id}-${kind}`, {
                  id: a.id,
                  kind,
                  cached: true,
                  data: parseCached(cached.body),
                }),
              );
              details += 1;
            }
          }
        }

        ctx.logger.info(
          "Synced {n} activities ({types} types){details}",
          {
            n: selected.length,
            types: listResource.activityTypes.length,
            details: details ? `, ${details} detail responses` : "",
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};

/** Format a Date as `YYYY-MM-DD` (UTC). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
