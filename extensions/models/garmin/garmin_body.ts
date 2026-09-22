/**
 * `@svendowideit/garmin-body` — weight and body composition from Garmin Connect.
 *
 * Garmin stores weigh-ins in two shapes: a per-day "day view" (every entry for
 * one date, including a `totalAverage`) and a date-range query. Body composition
 * (body fat %, muscle mass, bone mass, body water, visceral fat, BMI, metabolic
 * age) rides along in the same responses when a compatible scale is paired.
 *
 * Like the other domain models, this one fetches nothing itself: `paths` builds
 * the `connectapi` paths for the requested window, a workflow hands them to the
 * transport's `fetch-many`, and `sync` reads the cached bodies, normalises each
 * weigh-in into `weigh-in-<date>`, and rolls the window into `body-range`.
 *
 * Body composition is device-gated — a plain bathroom scale reports weight but
 * not fat %. `sync` therefore records which optional fields were present, so a
 * consumer can tell "not measured" from "zero".
 *
 * @module
 */
import { z } from "npm:zod@4";
import { readCachedByPath } from "./garmin_cache.ts";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Per-day weigh-ins (every entry for a date) with a `totalAverage`. */
export const WEIGHT_DAY_PATH = (date: string): string =>
  `/weight-service/weight/dayview/${date}?includeAll=true`;

/** Range weigh-ins between two dates. */
export const WEIGHT_RANGE_PATH = (start: string, end: string): string =>
  `/weight-service/weight/range/${start}/${end}?includeAll=true`;

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
  unit: z.enum(["kg", "lb"]).default("kg").describe(
    "Display unit for the normalised `weight` field; raw grams are always kept",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const PathsArgsSchema = z.object({
  date: z.string().optional().describe(
    "Single day, YYYY-MM-DD (overrides the range)",
  ),
  startDate: z.string().optional().describe("Range start, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Range end, YYYY-MM-DD"),
  maxDays: z.number().int().positive().max(365).default(31).describe(
    "Safety cap on range days when fanning out per-day paths",
  ),
  mode: z.enum(["range", "daily"]).default("range").describe(
    "`range` = one range request; `daily` = one day-view request per day",
  ),
});

const SyncArgsSchema = z.object({
  date: z.string().optional().describe("Single day to parse, YYYY-MM-DD"),
  startDate: z.string().optional().describe("Range start, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Range end, YYYY-MM-DD"),
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

/**
 * The `YYYY-MM-DD` prefix of a Garmin timestamp string, without timezone
 * conversion. Garmin timestamps carry no offset, so taking the date part
 * verbatim avoids JS's local-time parsing shifting the calendar day.
 */
export function datePartOf(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : "";
}

/**
 * Normalise a Garmin weight value to grams.
 *
 * Garmin's `weight-service` reports `weight` in **grams** regardless of the
 * `unitKey` on the record; `unitKey` is the user's *display* preference, not the
 * unit of the value. The community libraries all divide by 1000 to get kg, which
 * confirms the stored value is grams. So this is the value unchanged — the
 * `unit` global arg governs only the human-facing `weight` field.
 *
 * `unitKey` is accepted (and ignored) so the call site reads honestly and a
 * future API change has an obvious place to land.
 */
export function weightToGrams(
  weight: number | null,
  _unitKey: string | null,
): number | null {
  return weight;
}

/** A normalised weigh-in. All optional metrics are null when not measured. */
export interface NormalizedWeighIn {
  /** `YYYY-MM-DD` from the sample timestamp. */
  date: string;
  /** Epoch ms of the sample, when parseable. */
  timestampMs: number | null;
  /** Weight in grams (exact). */
  weightGrams: number | null;
  /** Weight in the configured display unit, rounded to 2 dp. */
  weight: number | null;
  bmi: number | null;
  bodyFatPercent: number | null;
  bodyWaterPercent: number | null;
  muscleMassGrams: number | null;
  boneMassGrams: number | null;
  visceralFatMassGrams: number | null;
  visceralFatRating: number | null;
  metabolicAge: number | null;
  physiqueRating: number | null;
  basalMetabolism: number | null;
  activeMetabolism: number | null;
  /** Which optional composition fields were actually present. */
  hasBodyComposition: boolean;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

/**
 * Normalise one raw weigh-in record.
 *
 * Garmin's field names vary between the day-view and range responses, so this
 * reads several spellings. Returns null only when the record has neither a
 * timestamp nor a weight — a genuinely empty row.
 */
export function normalizeWeighIn(
  raw: Record<string, unknown>,
  unit: "kg" | "lb" = "kg",
): NormalizedWeighIn | null {
  // Prefer Garmin's explicit calendar date for the day. `timestampLocal` is the
  // wall-clock the user weighed in; `timestampGMT` is the same instant in UTC.
  // Garmin formats both *without* a timezone designator, and JavaScript parses a
  // naive date-time as LOCAL time — so parsing `timestampGMT` would shift the
  // calendar date by the host offset. Taking the string's own date part avoids
  // that entirely and is what Garmin intends by the field.
  const localTs = raw.timestampLocal ?? raw.dateTimestamp;
  const gmtTs = raw.timestampGMT;
  const calendar = String(raw.calendarDate ?? raw.date ?? "").slice(0, 10);
  const date = calendar ||
    datePartOf(localTs) ||
    datePartOf(gmtTs) ||
    "";

  // A true instant, when one is available: parse the local timestamp (JS local
  // parse is correct for a local wall-clock); fall back to none rather than a
  // shifted value.
  const timestampMs = localTs ? Date.parse(String(localTs)) : NaN;

  const rawWeight = pickNumber(raw, "weight", "value");
  if (rawWeight === null && !date) return null;

  const unitKey = typeof raw.unitKey === "string" ? raw.unitKey : "kg";
  const weightGrams = weightToGrams(rawWeight, unitKey);
  const weight = weightGrams === null
    ? null
    : unit === "lb"
    ? Math.round((weightGrams / 453.59237) * 100) / 100
    : Math.round((weightGrams / 1000) * 100) / 100;

  const bodyFatPercent = pickNumber(raw, "percentFat", "bodyFat");
  const bodyWaterPercent = pickNumber(raw, "percentHydration", "bodyWater");
  const muscleMassGrams = pickNumber(raw, "muscleMass", "muscleMassGrams");
  const boneMassGrams = pickNumber(raw, "boneMass", "boneMassGrams");
  const visceralFatMassGrams = pickNumber(raw, "visceralFatMass");
  const visceralFatRating = pickNumber(raw, "visceralFatRating");
  const metabolicAge = pickNumber(raw, "metabolicAge");
  const physiqueRating = pickNumber(raw, "physiqueRating");
  const basalMetabolism = pickNumber(raw, "basalMet");
  const activeMetabolism = pickNumber(raw, "activeMet");

  const hasBodyComposition = [
    bodyFatPercent,
    bodyWaterPercent,
    muscleMassGrams,
    boneMassGrams,
    visceralFatMassGrams,
    visceralFatRating,
    metabolicAge,
  ].some((v) => v !== null);

  return {
    date,
    timestampMs: Number.isNaN(timestampMs) ? null : timestampMs,
    weightGrams,
    weight,
    bmi: pickNumber(raw, "bmi"),
    bodyFatPercent,
    bodyWaterPercent,
    muscleMassGrams,
    boneMassGrams,
    visceralFatMassGrams,
    visceralFatRating,
    metabolicAge,
    physiqueRating,
    basalMetabolism,
    activeMetabolism,
    hasBodyComposition,
  };
}

/**
 * Extract the weigh-in records from either response shape.
 *
 * The day-view uses `dateWeightList`; the range uses `dateWeightList` with a
 * `totalAverage`, or the records may arrive as a bare array.
 */
export function weighInsOf(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["dateWeightList", "weighIns", "results"]) {
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

const WeighInSchema = z.object({
  date: z.string(),
  timestampMs: z.number().nullable(),
  weightGrams: z.number().nullable(),
  weight: z.number().nullable(),
  bmi: z.number().nullable(),
  bodyFatPercent: z.number().nullable(),
  bodyWaterPercent: z.number().nullable(),
  muscleMassGrams: z.number().nullable(),
  boneMassGrams: z.number().nullable(),
  visceralFatMassGrams: z.number().nullable(),
  visceralFatRating: z.number().nullable(),
  metabolicAge: z.number().nullable(),
  physiqueRating: z.number().nullable(),
  basalMetabolism: z.number().nullable(),
  activeMetabolism: z.number().nullable(),
  hasBodyComposition: z.boolean(),
});

const RangeResultSchema = z.object({
  generatedAt: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  unit: z.string(),
  count: z.number(),
  /** True when at least one weigh-in carried body-composition data. */
  hasBodyComposition: z.boolean(),
  weighIns: z.array(WeighInSchema),
});

const PathsResultSchema = z.object({
  paths: z.array(z.string()),
  dates: z.array(z.string()),
  mode: z.string(),
});

const SetupSchema = z.object({ report: z.string() });

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The `@svendowideit/garmin-body` model definition. */
export const model = {
  type: "@svendowideit/garmin-body",
  version: "2026.09.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    weighIn: {
      description: "One normalised weigh-in, keyed by date",
      schema: WeighInSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    range: {
      description:
        "All weigh-ins in the window plus whether body composition was present",
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
        "Report the configured unit and whether any body-composition data has " +
        "been seen. Read-only.",
      arguments: SetupArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const range = await ctx.readResource("body-range");
        const lines = [
          "Garmin body configuration",
          `  cache dir:            ${g.cacheDir}`,
          `  display unit:         ${g.unit}`,
          `  last synced weighing: ${
            Array.isArray(range?.weighIns) && range!.weighIns.length > 0
              ? `${
                (range!.weighIns as Record<string, unknown>[]).length
              } weigh-in(s) to ${range?.endDate}`
              : "(none yet)"
          }`,
          `  body composition seen: ${
            range?.hasBodyComposition === true ? "yes" : "no"
          }`,
          "",
          "Body composition (fat %, muscle, bone, water) requires a compatible " +
          "Garmin scale; a weight-only scale reports weight alone.",
          "",
          "To populate the cache, run:",
          "  swamp workflow run @svendowideit/garmin-body-sync",
        ];
        const report = lines.join("\n");
        const handle = await ctx.writeResource("setup", "report", { report });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    paths: {
      description:
        "Build the connectapi paths for the requested window. `mode=range` " +
        "makes one range request; `mode=daily` makes one day-view request per " +
        "day (useful when each day may hold several weigh-ins). Feed `paths` " +
        "to the transport's fetch-many.",
      arguments: PathsArgsSchema,
      execute: async (
        args: z.infer<typeof PathsArgsSchema>,
        ctx: MethodContext,
      ) => {
        const { dates, mode } = resolveWindow(args);
        if (dates.length === 0) {
          throw new Error("No dates resolved — check date/startDate/endDate");
        }

        let paths: string[];
        if (mode === "daily") {
          if (dates.length > args.maxDays) {
            throw new Error(
              `Daily mode expands to ${dates.length} paths, over maxDays ` +
                `${args.maxDays}. Narrow the window or raise maxDays.`,
            );
          }
          paths = dates.map((d) => WEIGHT_DAY_PATH(d));
        } else {
          paths = [WEIGHT_RANGE_PATH(dates[0]!, dates[dates.length - 1]!)];
        }

        const handle = await ctx.writeResource("paths", "body-paths", {
          paths,
          dates,
          mode,
        });
        ctx.logger.info("Built {n} body path(s) in {mode} mode", {
          n: paths.length,
          mode,
        });
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Parse the cached weigh-in bodies into `weigh-in-<date>` resources and " +
        "a `body-range` roll-up. Reads the shared cache; run the transport's " +
        "fetch first (the garmin-body-sync workflow does both).",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();
        const pathsResource = await ctx.readResource("body-paths");
        const paths = Array.isArray(pathsResource?.paths)
          ? pathsResource!.paths as string[]
          : [];
        const dates = Array.isArray(pathsResource?.dates)
          ? pathsResource!.dates as string[]
          : resolveWindow(args).dates;

        if (paths.length === 0) {
          throw new Error(
            "No body paths recorded. Run the `paths` method first (the " +
              "garmin-body-sync workflow does this).",
          );
        }

        const byDate = new Map<string, NormalizedWeighIn>();
        let hasBodyComposition = false;
        for (const path of paths) {
          const cached = await readCachedByPath(g.cacheDir, path);
          for (const raw of weighInsOf(parseCached(cached.body))) {
            const w = normalizeWeighIn(raw, g.unit);
            if (!w) continue;
            // Keep the latest sample per date, so a re-weigh replaces an earlier one.
            const existing = byDate.get(w.date);
            if (
              !existing ||
              (w.timestampMs ?? 0) >= (existing.timestampMs ?? 0)
            ) {
              byDate.set(w.date, w);
            }
            if (w.hasBodyComposition) hasBodyComposition = true;
          }
        }

        const weighIns = [...byDate.values()].sort((a, b) =>
          a.date < b.date ? -1 : 1
        );
        const handles: ResDataHandle[] = [];
        for (const w of weighIns) {
          handles.push(
            await ctx.writeResource("weighIn", `weigh-in-${w.date}`, w),
          );
        }

        const range = {
          generatedAt: new Date(nowMs).toISOString(),
          startDate: dates[0] ?? "",
          endDate: dates[dates.length - 1] ?? "",
          unit: g.unit,
          count: weighIns.length,
          hasBodyComposition,
          weighIns,
        };
        handles.push(await ctx.writeResource("range", "body-range", range));

        ctx.logger.info(
          "Synced {n} weigh-in(s){composition}",
          {
            n: weighIns.length,
            composition: hasBodyComposition ? " with body composition" : "",
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};

/** Resolve the window and mode from method args. */
export function resolveWindow(args: {
  date?: string;
  startDate?: string;
  endDate?: string;
  mode?: "range" | "daily";
}): { dates: string[]; mode: "range" | "daily" } {
  const mode = args.mode ?? "range";
  if (args.date?.trim()) return { dates: [args.date.trim()], mode };
  if (args.startDate?.trim()) {
    const end = args.endDate?.trim() || args.startDate.trim();
    return { dates: dateRange(args.startDate.trim(), end), mode };
  }
  const yesterday = new Date(Date.now() - 86_400_000);
  return { dates: [yesterday.toISOString().slice(0, 10)], mode };
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
