/**
 * Diary — assemble a per-day Obsidian note from swimming swamp data, then
 * publish it into a vault through a `@magistr/obsidian/vault` model.
 *
 * The model is an extension of `@magistr/obsidian/vault`: it adds three methods
 * and three resource specs, and composes the vault model's `read`/`create`
 * methods (via `context.runModel`) so the vault stays the single writer of
 * note files. Nothing here talks to Garmin, Zwift, or the network directly —
 * `collect` reads data other models have already synced, using CEL-equivalent
 * `readModelData` lookups, so a diary run never re-fetches or rate-limits an
 * origin.
 *
 * Methods:
 *   - `collect`  gather a date's activities, wellness, weigh-in, Zwift picks and
 *                extension releases into one JSON resource (`collect` / `daily-<date>`)
 *   - `render`   turn that resource into the markdown page (`page` /
 *                `daily-<date>`) without writing to the vault
 *   - `publish`  render, merge into any existing note between managed markers,
 *                and write it to the vault
 *
 * @module
 */

// meta-factory-ignore config-lifecycle: the diary owns no configuration — every
// option is a per-call method argument, and the only persisted config
// (`vaultRoot`) belongs to the `@magistr/obsidian/vault` model this extension
// attaches to. The `options:` the linter matches is a `runModel` parameter in a
// type annotation, not a config resource, so no `setup` method applies.
import { z } from "npm:zod@4";

/** Default timezone used to decide what "today" means. */
export const DEFAULT_TIMEZONE = "Australia/Brisbane";

/** Marker that opens the machine-managed region of a diary note. */
export const BEGIN_MARKER = "<!-- swamp:diary:begin -->";

/** Marker that closes the machine-managed region of a diary note. */
export const END_MARKER = "<!-- swamp:diary:end -->";

/** Base URL for a Zwift event page. */
export const ZWIFT_EVENT_BASE = "https://www.zwift.com/events/view";

/**
 * Method argument shared by every method: the IANA timezone that defines which
 * calendar day "today" is.
 */
const TimezoneArg = z.string().default(DEFAULT_TIMEZONE).describe(
  "IANA timezone used to resolve today's date (e.g. Australia/Brisbane)",
);

/** Arguments for `collect`. */
const CollectArgsSchema = z.object({
  timezone: TimezoneArg,
  date: z.string().optional().describe(
    "Calendar day to collect, YYYY-MM-DD (default: today in `timezone`)",
  ),
  days: z.number().int().positive().max(7).default(1).describe(
    "Number of days to collect ending on `date`/today, most recent first " +
      "(default 1). Set 2 to also refresh yesterday, so a weigh-in recorded " +
      "late in the day updates the previous page on the next run.",
  ),
  activitiesModel: z.string().default("garmin-activities").describe(
    "Model instance holding the Garmin activity list",
  ),
  healthModel: z.string().default("garmin-health").describe(
    "Model instance holding Garmin daily wellness",
  ),
  bodyModel: z.string().default("garmin-body").describe(
    "Optional @svendowideit/garmin-body instance whose stored weigh-ins " +
      "provide the day's weight and body composition. Absent data simply " +
      "omits the weight line.",
  ),
  recommenderModel: z.string().default("zwift-recommender").describe(
    "Model instance holding ranked Zwift recommendations",
  ),
  eventsModel: z.string().default("zwift-events").describe(
    "Model instance holding the Zwift event schedule (used for links)",
  ),
  bomModel: z.string().default("bom").describe(
    "Optional @svendowideit/bom-weather instance whose stored forecast is " +
      "read for the page header. Absent data simply omits the forecast line.",
  ),
  releasesModel: z.string().default("extension-releases").describe(
    "Optional @svendowideit/extension-releases instance whose additive `log` " +
      "is read for the day's published/released extensions. Absent data simply " +
      "omits the Extensions published section.",
  ),
  topN: z.number().int().positive().default(5).describe(
    "Maximum number of suggested rides to include",
  ),
});
type CollectArgs = z.infer<typeof CollectArgsSchema>;

/** Arguments for `render`. */
const RenderArgsSchema = z.object({
  timezone: TimezoneArg,
  date: z.string().optional().describe(
    "Calendar day to render, YYYY-MM-DD (default: today in `timezone`)",
  ),
  collectName: z.string().optional().describe(
    "Name of the collect resource to render (default: daily-<date>)",
  ),
});
type RenderArgs = z.infer<typeof RenderArgsSchema>;

/** Arguments for `publish`. */
const PublishArgsSchema = z.object({
  timezone: TimezoneArg,
  date: z.string().optional().describe(
    "Calendar day to publish, YYYY-MM-DD (default: today in `timezone`)",
  ),
  days: z.number().int().positive().max(7).default(1).describe(
    "Number of days to publish ending on `date`/today, most recent first " +
      "(default 1). Set 2 to also refresh yesterday's page, matching a " +
      "multi-day collect.",
  ),
  batch: z.array(z.record(z.string(), z.unknown())).optional().describe(
    "The collected day payloads for the window, as produced by this run's " +
      "`collect` (the workflow passes `steps.collect.outputs.days`). When " +
      "given, publish renders these directly instead of reading each day's " +
      "collect resource — a same-run `readResource` resolves against a " +
      "run-start snapshot and would otherwise publish the previous run's " +
      "collect.",
  ),
  collectName: z.string().optional().describe(
    "Name of the collect resource to publish when `batch` is not given " +
      "(default: daily-<date>)",
  ),
  vaultModel: z.string().default("obsidian-vault").describe(
    "Model instance name of the @magistr/obsidian/vault to write into",
  ),
  folder: z.string().default("daily").describe(
    "Vault folder for the diary note",
  ),
  noteName: z.string().optional().describe(
    "File name for the note (default: <date>.md)",
  ),
  allowDotObsidian: z.boolean().optional().describe(
    "Allow writing inside .obsidian (passed through to the vault model)",
  ),
});
type PublishArgs = z.infer<typeof PublishArgsSchema>;

/**
 * Arguments for `build` — collect and publish in one call. The two parts must
 * run in the same method execution because a workflow run reads a run-start
 * data snapshot, so a separate later `publish` step would render the previous
 * run's collect.
 */
const BuildArgsSchema = CollectArgsSchema.extend({
  vaultModel: z.string().default("obsidian-vault").describe(
    "Model instance name of the @magistr/obsidian/vault to write into",
  ),
  folder: z.string().default("daily").describe(
    "Vault folder for the diary note",
  ),
  noteName: z.string().optional().describe(
    "File name for the note (default: <date>.md)",
  ),
  allowDotObsidian: z.boolean().optional().describe(
    "Allow writing inside .obsidian (passed through to the vault model)",
  ),
});
type BuildArgs = z.infer<typeof BuildArgsSchema>;

/** A single ride as collected for the diary page. */
export interface CollectedRide {
  /** Activity name as Garmin reports it. */
  name: string;
  /** Garmin activity type key (e.g. `virtual_ride`, `indoor_cycling`). */
  type: string;
  /** Garmin-local start time, `YYYY-MM-DD HH:MM:SS`. */
  startTimeLocal: string;
  /** Moving/recorded duration in seconds. */
  durationSeconds: number;
  /** Distance in metres. */
  distanceMeters: number;
  /** Elevation gain in metres. */
  elevationGainMeters: number;
  /** Average power in watts, or null when unavailable. */
  avgPower: number | null;
  /** Average heart rate in bpm, or null when unavailable. */
  avgHr: number | null;
  /** Active calories, or null when unavailable. */
  calories: number | null;
}

/** Daily wellness roll-up, or null fields when the day has no data. */
export interface CollectedWellness {
  /** Steps recorded that day. */
  steps: number | null;
  /** The day's step goal. */
  stepGoal: number | null;
  /** Total sleep in seconds. */
  sleepSeconds: number | null;
  /** Garmin sleep score (0–100), or null when the device reports none. */
  sleepScore: number | null;
  /** Resting heart rate in bpm. */
  restingHeartRate: number | null;
  /** Average stress score. */
  avgStress: number | null;
  /** Highest body-battery reading. */
  bodyBatteryHighest: number | null;
  /** Lowest body-battery reading. */
  bodyBatteryLowest: number | null;
}

/**
 * The day's BOM weather forecast, when a @svendowideit/bom-weather instance
 * holds one. Only the fields the diary header needs are kept.
 */
export interface CollectedWeather {
  /** Suburb/town the forecast is for, as BOM resolves it. */
  placeName: string;
  /** State/territory code, when known. */
  placeState: string | null;
  /** Local calendar date the forecast is for, `YYYY-MM-DD`. */
  date: string;
  /** Weekday name (e.g. `Sunday`). */
  weekday: string;
  /** Forecast maximum temperature in °C, or null. */
  tempMax: number | null;
  /** Forecast minimum temperature in °C, or null. */
  tempMin: number | null;
  /** Chance of rain as a percentage, or null. */
  rainChance: number | null;
  /** Short précis text (e.g. `Mostly clear.`). */
  shortText: string | null;
}

/**
 * The day's Garmin weigh-in, when a `@svendowideit/garmin-body` instance holds
 * one. Body-composition fields are null when the scale does not measure them.
 */
export interface CollectedWeight {
  /** `YYYY-MM-DD` of the sample. */
  date: string;
  /** Weight in grams (exact), or null when not reported. */
  weightGrams: number | null;
  /** Weight in the model's display unit, rounded to 2 dp. */
  weight: number | null;
  /** Display unit the `weight` field is expressed in (`kg` or `lb`). */
  unit: string;
  /** Body mass index. */
  bmi: number | null;
  /** Body fat percentage. */
  bodyFatPercent: number | null;
  /** Body water percentage. */
  bodyWaterPercent: number | null;
  /** Skeletal muscle mass in grams. */
  muscleMassGrams: number | null;
  /** Bone mass in grams. */
  boneMassGrams: number | null;
  /** Visceral fat rating. */
  visceralFatRating: number | null;
  /** Metabolic age in years. */
  metabolicAge: number | null;
  /** True when at least one body-composition field was measured. */
  hasBodyComposition: boolean;
}

/** A suggested ride, with a link where one could be built. */
export interface CollectedSuggestion {
  /** Rank from the recommender, 1-based. */
  rank: number;
  /** Event name. */
  eventName: string;
  /** Series the event belongs to, if any. */
  seriesName: string;
  /** Event type (e.g. `RACE`, `GROUP_RIDE`). */
  eventType: string;
  /** Subgroup label, e.g. the pace category `C`. */
  subgroupLabel: string;
  /** Local start time, `HH:MM`. */
  localTime: string;
  /** Route/event distance in metres (0 when unknown). */
  distanceMeters: number;
  /** Event duration in seconds (0 when unknown). */
  durationSeconds: number;
  /** Recommender score. */
  score: number;
  /** Human-readable explanation of the pick. */
  reason: string;
  /** Zwift event page URL, or empty when no link could be built. */
  url: string;
}

/**
 * One extension release or promotion logged by
 * `@svendowideit/extension-releases` on the day's page.
 */
export interface CollectedRelease {
  /** Fully-qualified extension name (`@scope/name`). */
  extension: string;
  /** Namespace (collective) that owns the extension. */
  namespace: string;
  /** Released version. */
  version: string;
  /** Channel the version was released/promoted to (`stable` | `rc` | `beta`). */
  channel: string;
  /** `publish` for a first sighting, `promote` for a channel move. */
  event: string;
  /** Lower channel a promotion came from, or `""`. */
  fromChannel: string;
  /** Registry publish timestamp, or the poll timestamp when absent. */
  publishedAt: string;
  /** Poll timestamp when the release was first observed. */
  observedAt: string;
  /** Publishing username, or `""`. */
  author: string;
  /** Registry page for the extension. */
  url: string;
}

/** The full per-day payload written by `collect`. */
export interface CollectedDay {
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  /** When the payload was assembled (ISO 8601). */
  generatedAt: string;
  /** Timezone used to bucket the day. */
  timezone: string;
  /** Activities that started on the day. */
  rides: CollectedRide[];
  /** Headline sums across those rides. */
  totals: {
    /** Number of rides. */
    rideCount: number;
    /** Total duration in seconds. */
    durationSeconds: number;
    /** Total distance in metres. */
    distanceMeters: number;
    /** Total elevation gain in metres. */
    elevationGainMeters: number;
    /** Total active calories. */
    calories: number;
  };
  /** Daily wellness, or null when no health data was found. */
  wellness: CollectedWellness | null;
  /** The day's weigh-in, or null when no body data was found. */
  weight: CollectedWeight | null;
  /** The day's BOM forecast, or null when no BOM data was found. */
  weather: CollectedWeather | null;
  /** Ranked Zwift picks for the day. */
  suggested: CollectedSuggestion[];
  /** Extension releases and promotions logged against the day. */
  releases: CollectedRelease[];
  /** True when more picks existed for the day than `topN` kept. */
  truncated: boolean;
  /** Source models that had no data, as `model/spec`. */
  missing: string[];
}

/** Structural view of the method context fields this extension uses. */
interface DiaryContext {
  globalArgs: Record<string, unknown>;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
    debug?: (message: string, props?: Record<string, unknown>) => void;
    warn?: (message: string, props?: Record<string, unknown>) => void;
  };
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<
    Array<{ name: string; attributes: Record<string, unknown> }>
  >;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  runModel?: (
    options: {
      definition: string;
      method: string;
      arguments?: Record<string, unknown>;
    },
  ) => Promise<
    | { ok: true; resources: Array<{ name: string }> }
    | { ok: false; error: { message: string } }
  >;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Resolve `now` to a YYYY-MM-DD calendar date in an IANA timezone. */
export function calendarDate(
  timezone: string,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Resolve the day a method should act on: the explicit `date` when one is
 * given, otherwise today in `timezone`. A blank or whitespace-only `date`
 * counts as unset, so a workflow passing its empty default still means today.
 */
export function resolveDate(
  date: string | undefined,
  timezone: string,
  now: Date = new Date(),
): string {
  const trimmed = (date ?? "").trim();
  return trimmed.length > 0 ? trimmed : calendarDate(timezone, now);
}

/** Shift a `YYYY-MM-DD` calendar date by whole days (negative = earlier). */
export function shiftDate(date: string, delta: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + Math.trunc(delta) * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The inclusive list of days a method acts on: `days` days ending on `date`
 * (or today in `timezone`), most recent first. `days=2` yields `[D, D-1]`, so a
 * weigh-in that arrives after the day was first written still updates the
 * previous page on the next pass. Clamped to 1..7.
 */
export function resolveDates(
  date: string | undefined,
  timezone: string,
  days: number,
  now: Date = new Date(),
): string[] {
  const end = resolveDate(date, timezone, now);
  const span = Math.min(7, Math.max(1, Math.floor(Number(days) || 1)));
  return Array.from({ length: span }, (_, i) => shiftDate(end, -i));
}

/** Keep activities whose Garmin-local start falls on `date`. */
export function filterActivities(
  activities: CollectedRide[],
  date: string,
): CollectedRide[] {
  return activities.filter((a) => (a.startTimeLocal ?? "").startsWith(date));
}

/** Sum the headline totals for a set of rides. */
export function summariseRides(rides: CollectedRide[]): CollectedDay["totals"] {
  const totals = {
    rideCount: rides.length,
    durationSeconds: 0,
    distanceMeters: 0,
    elevationGainMeters: 0,
    calories: 0,
  };
  for (const r of rides) {
    totals.durationSeconds += r.durationSeconds || 0;
    totals.distanceMeters += r.distanceMeters || 0;
    totals.elevationGainMeters += r.elevationGainMeters || 0;
    totals.calories += r.calories || 0;
  }
  return totals;
}

/** Format seconds as `Hh Mm` (or `Mm` under an hour). */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Format metres as `N.N km`. */
export function formatDistance(meters: number): string {
  return `${((meters || 0) / 1000).toFixed(1)} km`;
}

/** Format an integer count with thousands separators (e.g. `5,112`). */
export function formatCount(value: number): string {
  return Math.round(value || 0).toLocaleString("en-US");
}

/** Build a Zwift event page URL from an event id. */
export function zwiftEventUrl(eventId: string): string {
  return `${ZWIFT_EVENT_BASE}/${eventId}`;
}

/**
 * Index the Zwift schedule by event id so recommendations can be linked.
 * The schedule resource lists events, each carrying its subgroups.
 */
export function indexSchedule(
  events: Array<Record<string, unknown>>,
): Map<string, { name: string; subgroups: Map<string, { name: string }> }> {
  const index = new Map<
    string,
    { name: string; subgroups: Map<string, { name: string }> }
  >();
  for (const ev of events) {
    const id = String(ev.id ?? "");
    if (!id) continue;
    const subgroups = new Map<string, { name: string }>();
    const rawSubs = Array.isArray(ev.subgroups)
      ? ev.subgroups as Array<Record<string, unknown>>
      : [];
    for (const sub of rawSubs) {
      subgroups.set(String(sub.id ?? ""), {
        name: String(sub.name ?? sub.label ?? ""),
      });
    }
    index.set(id, { name: String(ev.name ?? ""), subgroups });
  }
  return index;
}

/**
 * Keep the recommendations for `date` and attach their event URLs. `rank` is
 * preserved from the recommender; entries already carry a human `reason`.
 */
export function selectSuggestions(
  recommendations: Array<Record<string, unknown>>,
  date: string,
  topN: number,
  schedule: Map<
    string,
    { name: string; subgroups: Map<string, { name: string }> }
  >,
): CollectedSuggestion[] {
  const onDate = recommendations.filter((r) => r.localDate === date);
  return onDate.slice(0, topN).map((r) => {
    const eventId = String(r.eventId ?? "");
    const event = schedule.get(eventId);
    const subgroupId = String(r.subgroupId ?? "");
    const subgroup = event?.subgroups.get(subgroupId);
    const hour = String(r.localHour ?? "0").padStart(2, "0");
    const minute = String(r.localMinute ?? "0").padStart(2, "0");
    return {
      rank: Number(r.rank ?? 0),
      eventName: String(r.eventName || event?.name || ""),
      seriesName: String(r.seriesName ?? ""),
      eventType: String(r.eventType ?? ""),
      subgroupLabel: String(r.subgroupLabel || subgroup?.name || ""),
      localTime: `${hour}:${minute}`,
      distanceMeters: Number(r.distanceMeters ?? 0),
      durationSeconds: Number(r.durationSeconds ?? 0),
      score: Number(r.score ?? 0),
      reason: String(r.reason ?? ""),
      url: eventId ? zwiftEventUrl(eventId) : "",
    };
  });
}

/**
 * Reduce a raw @svendowideit/bom-weather forecast resource to the day's
 * weather, keeping only the fields the diary header renders. Returns null when
 * the resource carries no day matching `date` (e.g. a stale forecast or a
 * different location's data).
 */
export function selectWeather(
  raw: Record<string, unknown> | null,
  date: string,
): CollectedWeather | null {
  if (!raw) return null;
  const days = Array.isArray(raw.days)
    ? raw.days as Array<Record<string, unknown>>
    : [];
  const day = days.find((d) => String(d.date ?? "") === date) ??
    (raw.today as Record<string, unknown> | undefined) ?? null;
  if (!day || String(day.date ?? "") !== date) return null;
  const place = (raw.place as Record<string, unknown> | undefined) ?? {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  return {
    placeName: String(place.name ?? ""),
    placeState: str(place.state),
    date: String(day.date ?? date),
    weekday: String(day.weekday ?? ""),
    tempMax: num(day.tempMax),
    tempMin: num(day.tempMin),
    rainChance: num(day.rainChance),
    shortText: str(day.shortText),
  };
}

/**
 * Reduce a raw @svendowideit/garmin-body `body-range` resource to the day's
 * weigh-in, keeping only the fields the diary renders. Returns null when the
 * resource carries no weigh-in for `date` (e.g. a day with no measurement).
 */
export function selectWeight(
  raw: Record<string, unknown> | null,
  date: string,
): CollectedWeight | null {
  if (!raw) return null;
  const weighIns = Array.isArray(raw.weighIns)
    ? raw.weighIns as Array<Record<string, unknown>>
    : [];
  const weighIn = weighIns.find((w) => String(w.date ?? "") === date);
  if (!weighIn) return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    date: String(weighIn.date ?? date),
    weightGrams: num(weighIn.weightGrams),
    weight: num(weighIn.weight),
    unit: String(raw.unit ?? "kg"),
    bmi: num(weighIn.bmi),
    bodyFatPercent: num(weighIn.bodyFatPercent),
    bodyWaterPercent: num(weighIn.bodyWaterPercent),
    muscleMassGrams: num(weighIn.muscleMassGrams),
    boneMassGrams: num(weighIn.boneMassGrams),
    visceralFatRating: num(weighIn.visceralFatRating),
    metabolicAge: num(weighIn.metabolicAge),
    hasBodyComposition: weighIn.hasBodyComposition === true,
  };
}

/** Round to one decimal place, dropping a trailing `.0`. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * One `## Weight` line for the day, or null when no weight was recorded. Reads
 * naturally with or without body composition, e.g.
 * `- **Weight:** 81.2 kg · body fat 21%` or `- **Weight:** 81.2 kg`.
 */
export function formatWeightLine(
  weight: CollectedWeight | null,
): string | null {
  if (!weight || weight.weight === null) return null;
  const unit = weight.unit || "kg";
  const head = `- **Weight:** ${weight.weight} ${unit}`;
  const perUnit = unit === "lb" ? 453.59237 : 1000;
  const extras = [
    weight.bodyFatPercent !== null
      ? `body fat ${weight.bodyFatPercent}%`
      : null,
    weight.muscleMassGrams !== null
      ? `muscle ${
        Math.round((weight.muscleMassGrams / perUnit) * 10) / 10
      } ${unit}`
      : null,
    weight.bmi !== null ? `BMI ${round1(weight.bmi)}` : null,
    weight.metabolicAge !== null
      ? `metabolic age ${weight.metabolicAge}`
      : null,
  ].filter(Boolean);
  return extras.length ? `${head} · ${extras.join(" · ")}` : head;
}

/**
 * One header line describing the day's forecast, or null when the day has no
 * temperature or précis to show. Leads with the resolved place, e.g.
 * `Stafford Heights: min 16°C max 27°C; Mostly clear.; 5% chance`.
 */
export function formatForecastLine(
  weather: CollectedWeather | null,
): string | null {
  if (!weather) return null;
  const temps = [
    weather.tempMin !== null ? `min ${weather.tempMin}°C` : null,
    weather.tempMax !== null ? `max ${weather.tempMax}°C` : null,
  ].filter(Boolean).join(" ") || null;
  const summary = weather.shortText ?? null;
  const parts = [temps, summary].filter(Boolean);
  if (parts.length === 0) return null;
  const rain = weather.rainChance !== null
    ? `; ${weather.rainChance}% chance`
    : "";
  return `${weather.placeName}: ${parts.join("; ")}${rain}`;
}

/**
 * The timestamp a release entry should be attributed to (and displayed with).
 *
 * A `publish` happened when the registry first accepted the version, so its
 * `publishedAt` is authoritative. A `promote` cannot be dated from the registry
 * (a promoted version keeps its original publish time), so the poll time it was
 * first observed on the higher channel — accurate to within one poll interval —
 * is used instead. Falls back to the other timestamp when one is missing.
 */
export function releaseEventAt(r: CollectedRelease): string {
  if (r.event === "promote") return r.observedAt || r.publishedAt;
  return r.publishedAt || r.observedAt;
}

/**
 * Select the release entries that happened on `date` in `timezone`. Each entry
 * is dated by {@link releaseEventAt} — the version's publish time for a
 * release, the observation time for a promotion — so a release is only ever
 * shown on the day it actually happened, never on the day a later poll noticed
 * it (or on the day a first-run backfill captured it).
 */
export function selectReleases(
  raw: Array<Record<string, unknown>>,
  date: string,
  timezone: string,
): CollectedRelease[] {
  const out: CollectedRelease[] = [];
  for (const r of raw) {
    const observedAt = String(r.observedAt ?? "");
    const entry: CollectedRelease = {
      extension: String(r.extension ?? ""),
      namespace: String(r.namespace ?? ""),
      version: String(r.version ?? ""),
      channel: String(r.channel ?? ""),
      event: String(r.event ?? "publish"),
      fromChannel: String(r.fromChannel ?? ""),
      publishedAt: String(r.publishedAt ?? observedAt),
      observedAt,
      author: String(r.author ?? ""),
      url: String(r.url ?? ""),
    };
    const eventAt = releaseEventAt(entry);
    if (!eventAt) continue;
    const at = new Date(eventAt);
    if (!Number.isFinite(at.getTime())) continue;
    if (calendarDate(timezone, at) !== date) continue;
    out.push(entry);
  }
  return out;
}

/** Format an ISO timestamp as `HH:MM` in an IANA timezone, or `""`. */
export function clockTime(iso: string, timezone: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour");
  const minute = get("minute");
  return hour && minute ? `${hour}:${minute}` : "";
}

/** One extension and its release entries for the day. */
export interface ReleaseGroup {
  /** Extension name. */
  extension: string;
  /** Registry page URL, or `""`. */
  url: string;
  /** The day's entries, oldest first. */
  entries: CollectedRelease[];
}

/** Group a day's releases by extension, each group's entries oldest first. */
export function groupReleases(releases: CollectedRelease[]): ReleaseGroup[] {
  const map = new Map<string, ReleaseGroup>();
  for (const r of releases) {
    const group = map.get(r.extension) ??
      { extension: r.extension, url: r.url, entries: [] };
    group.entries.push(r);
    if (!group.url && r.url) group.url = r.url;
    map.set(r.extension, group);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.entries.sort((a, b) =>
      (releaseEventAt(a) || "").localeCompare(releaseEventAt(b) || "") ||
      a.version.localeCompare(b.version) ||
      a.channel.localeCompare(b.channel)
    );
  }
  groups.sort((a, b) => a.extension.localeCompare(b.extension));
  return groups;
}

/**
 * One `- **<version>** → <channel>` sub-list line for a release, noting a
 * promotion's source channel and the local time it actually happened (see
 * {@link releaseEventAt}).
 */
export function formatReleaseEntry(
  r: CollectedRelease,
  timezone: string,
): string {
  const suffix = r.event === "promote"
    ? (r.fromChannel ? ` (promoted from ${r.fromChannel})` : " (promoted)")
    : "";
  const time = clockTime(releaseEventAt(r), timezone);
  return `**${r.version}** → ${r.channel}${suffix}${time ? ` · ${time}` : ""}`;
}

/** Render the markdown body (between the managed markers) for a day. */
export function renderManagedSection(day: CollectedDay): string {
  const lines: string[] = [];
  lines.push(BEGIN_MARKER, "");

  const forecast = formatForecastLine(day.weather);
  if (forecast) lines.push(forecast, "");

  lines.push("## Health");
  const w = day.wellness;
  const weightLine = formatWeightLine(day.weight);
  if (!w && !weightLine) {
    lines.push("- No Garmin wellness data for this day");
  } else {
    if (w?.sleepSeconds != null) {
      const score = w.sleepScore != null ? ` (score ${w.sleepScore})` : "";
      lines.push(`- **Sleep:** ${formatDuration(w.sleepSeconds)}${score}`);
    }
    if (w?.steps != null) {
      const goal = w.stepGoal != null ? ` of ${formatCount(w.stepGoal)}` : "";
      lines.push(`- **Steps:** ${formatCount(w.steps)}${goal}`);
    }
    const extras = [
      w?.restingHeartRate != null ? `resting HR ${w.restingHeartRate}` : null,
      w?.avgStress != null ? `stress ${w.avgStress}` : null,
      w?.bodyBatteryHighest != null
        ? `body battery ${w.bodyBatteryLowest ?? "?"}–${w.bodyBatteryHighest}`
        : null,
    ].filter(Boolean);
    if (extras.length) lines.push(`- ${extras.join(" · ")}`);
    if (weightLine) lines.push(weightLine);
  }
  lines.push("");

  lines.push("## Activities");
  if (day.rides.length === 0) {
    lines.push("- Rest day — no recorded activity");
  } else {
    for (const r of day.rides) {
      const details = [
        formatDuration(r.durationSeconds),
        formatDistance(r.distanceMeters),
        r.avgPower != null ? `${Math.round(r.avgPower)} W avg` : null,
        r.avgHr != null ? `${Math.round(r.avgHr)} bpm` : null,
      ].filter(Boolean).join(" · ");
      lines.push(`- ${r.name} (${r.type}) — ${details}`);
    }
    const t = day.totals;
    lines.push(
      `- **Totals:** ${t.rideCount} ride(s) · ${
        formatDuration(t.durationSeconds)
      } · ` +
        `${formatDistance(t.distanceMeters)} · ${t.calories} kcal`,
    );
  }
  lines.push("");

  lines.push("## Suggested rides today");
  if (day.suggested.length === 0) {
    lines.push("- No matching Zwift events");
  } else {
    for (const s of day.suggested) {
      const label = s.subgroupLabel ? ` [${s.subgroupLabel}]` : "";
      const meta = [
        s.localTime,
        s.distanceMeters > 0 ? formatDistance(s.distanceMeters) : null,
        s.durationSeconds > 0 ? formatDuration(s.durationSeconds) : null,
      ].filter(Boolean).join(" · ");
      const link = s.url ? ` → [Zwift](${s.url})` : "";
      lines.push(
        `- [ ] ${label} ${s.eventName} — ${meta} — ${s.reason}${link}`,
      );
    }
  }
  lines.push("");

  lines.push("## Extensions published");
  if (day.releases.length === 0) {
    lines.push("- No extension releases logged for this day");
  } else {
    for (const group of groupReleases(day.releases)) {
      const link = group.url
        ? `[${group.extension}](${group.url})`
        : group.extension;
      lines.push(`- ${link}`);
      for (const r of group.entries) {
        lines.push(`  - ${formatReleaseEntry(r, day.timezone)}`);
      }
    }
  }
  lines.push("");

  lines.push(END_MARKER);
  return lines.join("\n");
}

/** Render the complete standalone page for a day. */
export function renderPage(day: CollectedDay): string {
  return `# ${day.date}\n\n${renderManagedSection(day)}\n\n## To do\n- [ ] \n`;
}

/**
 * Merge a freshly rendered managed section into an existing note. Everything
 * outside the markers — frontmatter, headings, the user's own sections and
 * ticked boxes — is preserved. When the existing note has no markers, the
 * managed section is inserted after the first heading line.
 */
export function mergeManagedSection(
  existing: string,
  managed: string,
): string {
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + END_MARKER.length);
    return `${before}${managed}${after}`;
  }

  const normalizedManaged = managed.trimEnd();
  if (existing.trim().length === 0) {
    return `${normalizedManaged}\n\n## To do\n- [ ] \n`;
  }

  const lines = existing.split("\n");
  const headingIndex = lines.findIndex((l) => l.startsWith("#"));
  if (headingIndex === -1) {
    return `${normalizedManaged}\n\n${existing}`;
  }
  const head = lines.slice(0, headingIndex + 1).join("\n");
  const rest = lines.slice(headingIndex + 1).join("\n").replace(/^\n+/, "");
  return `${head}\n\n${normalizedManaged}\n\n${rest}`;
}

/** Reduce a raw Garmin activity record to the fields the page needs. */
function toRide(raw: Record<string, unknown>): CollectedRide {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    name: String(raw.name ?? "Activity"),
    type: String(raw.typeKey ?? raw.parentTypeKey ?? "activity"),
    startTimeLocal: String(raw.startTimeLocal ?? ""),
    durationSeconds: num(raw.durationSeconds) ?? 0,
    distanceMeters: num(raw.distanceMeters) ?? 0,
    elevationGainMeters: num(raw.elevationGainMeters) ?? 0,
    avgPower: num(raw.avgPower),
    avgHr: num(raw.avgHr),
    calories: num(raw.calories),
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Resource specs added to the vault model. */
const resources = {
  collect: {
    description: "A day's collected diary payload (rides, wellness, picks)",
    schema: z.object({
      date: z.string(),
      generatedAt: z.string(),
      timezone: z.string(),
      rides: z.array(z.record(z.string(), z.unknown())),
      totals: z.record(z.string(), z.number()),
      wellness: z.record(z.string(), z.unknown()).nullable(),
      weight: z.record(z.string(), z.unknown()).nullable().optional(),
      weather: z.record(z.string(), z.unknown()).nullable().optional(),
      suggested: z.array(z.record(z.string(), z.unknown())),
      releases: z.array(z.record(z.string(), z.unknown())),
      truncated: z.boolean(),
      missing: z.array(z.string()),
    }),
    lifetime: "infinite" as const,
    garbageCollection: 30,
  },
  batch: {
    description:
      "The whole collected window in one resource. The bundled workflow passes " +
      "its `days` to `publish`, so a run publishes the collects it just wrote " +
      "rather than a stale same-run read of each day's `collect`.",
    schema: z.object({
      generatedAt: z.string(),
      timezone: z.string(),
      dates: z.array(z.string()),
      days: z.array(z.record(z.string(), z.unknown())),
    }),
    lifetime: "infinite" as const,
    garbageCollection: 5,
  },
  page: {
    description: "A rendered diary note (markdown body, not yet written)",
    schema: z.object({
      date: z.string(),
      markdown: z.string(),
      timestamp: z.string(),
    }),
    lifetime: "infinite" as const,
    garbageCollection: 30,
  },
  publish: {
    description: "Result of publishing a diary note into the vault",
    schema: z.object({
      date: z.string(),
      file: z.string(),
      action: z.string(),
      merged: z.boolean(),
      timestamp: z.string(),
    }),
    lifetime: "infinite" as const,
    garbageCollection: 30,
  },
};

/**
 * Build one payload per day in the window and persist it (a `daily-<date>`
 * resource each, plus one `daily-batch`). Returns the payloads so `build` can
 * publish them without re-reading — a same-run `readResource` resolves against
 * a run-start snapshot and would otherwise be stale.
 */
async function collectWindow(
  args: CollectArgs,
  context: DiaryContext,
): Promise<{
  payloads: CollectedDay[];
  dataHandles: Array<{ name: string }>;
}> {
  const dates = resolveDates(args.date, args.timezone, args.days);
  const missing: string[] = [];

  const read = async (
    model: string,
    spec: string,
  ): Promise<Array<Record<string, unknown>>> => {
    if (!context.readModelData) return [];
    const records = await context.readModelData(model, spec);
    if (records.length === 0) missing.push(`${model}/${spec}`);
    return records.map((r) => r.attributes);
  };

  // Read every source once, then build one payload per day in the window.
  const activityLists = await read(args.activitiesModel, "list");
  const allRides: CollectedRide[] = [];
  for (const list of activityLists) {
    const acts = Array.isArray(list.activities)
      ? list.activities as Array<Record<string, unknown>>
      : [];
    for (const a of acts) allRides.push(toRide(a));
  }

  const dailyHealth = await read(args.healthModel, "daily");
  const bomRecords = await read(args.bomModel, "forecast");
  const bodyRecords = await read(args.bodyModel, "range");
  const recRecords = await read(args.recommenderModel, "recommendations");
  const recommendations = recRecords[0]?.recommendations as
    | Array<Record<string, unknown>>
    | undefined;
  const scheduleRecords = await read(args.eventsModel, "schedule");
  const scheduleEvents = (scheduleRecords[0]?.events ?? []) as Array<
    Record<string, unknown>
  >;
  const schedule = indexSchedule(scheduleEvents);
  const releaseRecords = await read(args.releasesModel, "log");
  const releaseEntries = Array.isArray(releaseRecords[0]?.entries)
    ? releaseRecords[0].entries as Array<Record<string, unknown>>
    : [];

  const handles: Array<{ name: string }> = [];
  const payloads: CollectedDay[] = [];
  for (const date of dates) {
    const rides = filterActivities(allRides, date);
    const dayHealth = dailyHealth.find((h) => h.date === date) ?? null;
    const wellness: CollectedWellness | null = dayHealth
      ? {
        steps: numOrNull(dayHealth.steps),
        stepGoal: numOrNull(dayHealth.stepGoal),
        sleepSeconds: numOrNull(dayHealth.sleepSeconds),
        sleepScore: numOrNull(dayHealth.sleepScore),
        restingHeartRate: numOrNull(dayHealth.restingHeartRate),
        avgStress: numOrNull(dayHealth.avgStress),
        bodyBatteryHighest: numOrNull(dayHealth.bodyBatteryHighest),
        bodyBatteryLowest: numOrNull(dayHealth.bodyBatteryLowest),
      }
      : null;

    const weather = selectWeather(bomRecords[0] ?? null, date);
    const weight = selectWeight(bodyRecords[0] ?? null, date);
    const suggested = selectSuggestions(
      recommendations ?? [],
      date,
      args.topN,
      schedule,
    );
    const picksForDate = (recommendations ?? []).filter((r) =>
      r.localDate === date
    ).length;
    const releases = selectReleases(releaseEntries, date, args.timezone);

    const payload: CollectedDay = {
      date,
      generatedAt: new Date().toISOString(),
      timezone: args.timezone,
      rides,
      totals: summariseRides(rides),
      wellness,
      weight,
      weather,
      suggested,
      releases,
      truncated: picksForDate > suggested.length,
      missing,
    };

    context.logger.info(
      "Collected {date}: {rides} ride(s), {suggested} suggestion(s), " +
        "forecast {forecast}, weight {weight}",
      {
        date,
        rides: rides.length,
        suggested: suggested.length,
        forecast: weather ? "yes" : "no",
        weight: weight ? `${weight.weight} ${weight.unit}` : "no",
      },
    );

    handles.push(
      await context.writeResource(
        "collect",
        `daily-${date}`,
        payload as unknown as Record<string, unknown>,
      ),
    );
    payloads.push(payload);
  }

  // One resource carrying every day's payload. A later step in the same
  // workflow run reads this via `steps.collect.outputs` (a run-time value),
  // because a step's own `readResource` resolves against a run-start snapshot
  // and would otherwise republish the previous run's collects.
  handles.push(
    await context.writeResource("batch", "daily-batch", {
      generatedAt: new Date().toISOString(),
      timezone: args.timezone,
      dates,
      days: payloads,
    } as unknown as Record<string, unknown>),
  );

  return { payloads, dataHandles: handles };
}

/** Collect a day's data from the synced fitness models. */
async function executeCollect(
  args: CollectArgs,
  context: DiaryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  args = CollectArgsSchema.parse(args);
  const { dataHandles } = await collectWindow(args, context);
  return { dataHandles };
}

/** Render the markdown page from a collect resource. */
async function executeRender(
  args: RenderArgs,
  context: DiaryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  args = RenderArgsSchema.parse(args);
  const date = resolveDate(args.date, args.timezone);
  const name = args.collectName ?? `daily-${date}`;
  const day = await readCollect(context, name);
  const markdown = renderPage(day);
  context.logger.info("Rendered {date} ({bytes} bytes)", {
    date,
    bytes: new TextEncoder().encode(markdown).byteLength,
  });
  const handle = await context.writeResource("page", `page-${date}`, {
    date,
    markdown,
    timestamp: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

/** Render, merge into any existing note, and write through the vault model. */
async function executePublish(
  args: PublishArgs,
  context: DiaryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  args = PublishArgsSchema.parse(args);
  if (!context.runModel) {
    throw new Error(
      "context.runModel is unavailable; publish needs it to call the vault model",
    );
  }
  const payloads = (args.batch ?? []) as unknown as CollectedDay[];
  return { dataHandles: await publishWindow(payloads, args, context) };
}

/**
 * Render, merge and write one note per day. A day is rendered from its payload
 * in `payloads` when present (this run's collects); otherwise the stored
 * `collect` resource is read — which is what a standalone/manual publish needs.
 */
async function publishWindow(
  payloads: CollectedDay[],
  args: PublishArgs,
  context: DiaryContext,
): Promise<Array<{ name: string }>> {
  if (!context.runModel) {
    throw new Error(
      "context.runModel is unavailable; publish needs it to call the vault model",
    );
  }
  const dates = resolveDates(args.date, args.timezone, args.days);
  const folder = args.folder.replace(/\/+$/, "");
  const handles: Array<{ name: string }> = [];

  const batched = new Map<string, CollectedDay>();
  for (const day of payloads) {
    if (day?.date) batched.set(String(day.date), day);
  }

  for (const date of dates) {
    const name = args.collectName ?? `daily-${date}`;
    const day = batched.get(date) ?? await readCollect(context, name);
    const managed = renderManagedSection(day);
    const file = `${folder}/${args.noteName ?? `${date}.md`}`;
    const timestamp = new Date().toISOString();

    const existing = await readNoteContent(
      context,
      args.vaultModel,
      file,
      args.allowDotObsidian,
    );

    const merged = mergeManagedSection(existing, managed);
    const write = await context.runModel({
      definition: args.vaultModel,
      method: "create",
      arguments: {
        name: file,
        content: merged,
        overwrite: true,
        allowDotObsidian: args.allowDotObsidian,
      },
    });
    if (!write.ok) {
      throw new Error(`vault write failed: ${write.error.message}`);
    }

    context.logger.info("Published {file}", { file });
    handles.push(
      await context.writeResource("publish", `publish-${date}`, {
        date,
        file,
        action: existing.length ? "merged" : "created",
        merged: existing.includes(BEGIN_MARKER),
        timestamp,
      }),
    );
  }

  return handles;
}

/**
 * Collect every day in the window and publish each note in one execution, so a
 * workflow run never reads its own just-written collect (a same-run
 * `readResource` resolves against a run-start snapshot).
 */
async function executeBuild(
  args: BuildArgs,
  context: DiaryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  args = BuildArgsSchema.parse(args);
  if (!context.runModel) {
    throw new Error(
      "context.runModel is unavailable; build needs it to call the vault model",
    );
  }
  const { payloads, dataHandles } = await collectWindow(args, context);
  const published = await publishWindow(payloads, args, context);
  return { dataHandles: [...dataHandles, ...published] };
}

/** Read the collect resource for a day; fails clearly when it is absent. */
async function readCollect(
  context: DiaryContext,
  name: string,
): Promise<CollectedDay> {
  const raw = context.readResource ? await context.readResource(name) : null;
  if (!raw) {
    throw new Error(
      `No collect resource named '${name}'. Run the collect method first.`,
    );
  }
  return raw as unknown as CollectedDay;
}

/**
 * Whether a failed vault `read` means the note simply does not exist yet. The
 * vault `read` reports `ok:false` both when the note is absent and when it is
 * genuinely unreadable (permissions, path errors), so the two must be told
 * apart: a read failure treated as "absent" would make `publish` overwrite an
 * existing note with `daily-merge`, destroying the user's prose.
 */
function noteAbsentFromReadError(message: string): boolean {
  return /not ?found|no such file|does not exist|os error 2|enoent|\bmissing\b/i
    .test(message);
}

/** Read a note's markdown via the vault model's `read` method. */
async function readNoteContent(
  context: DiaryContext,
  vaultModel: string,
  file: string,
  allowDotObsidian?: boolean,
): Promise<string> {
  if (!context.runModel) return "";
  const result = await context.runModel({
    definition: vaultModel,
    method: "read",
    arguments: { file, allowDotObsidian },
  });
  if (!result.ok) {
    // A missing note is the normal first-publish case and yields no content.
    // Any other read failure must abort rather than fall through as empty:
    // `publish` writes with overwrite=true, so overwriting from a failed read
    // would replace an existing note and lose the prose outside the markers.
    if (noteAbsentFromReadError(result.error.message)) return "";
    throw new Error(
      `vault read failed for '${file}': ${result.error.message}`,
    );
  }
  const noteName = (result.resources[0] as { name?: string })?.name;
  if (!noteName || !context.readResource) return "";
  const note = await context.readResource(noteName);
  const content = note?.content;
  return typeof content === "string" ? content : "";
}

/** Coerce an unknown value to a finite number, or null. */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Diary extension: four methods and four resources added to the Obsidian vault
 * model.
 */
export const extension = {
  type: "@magistr/obsidian/vault",
  resources,
  methods: [
    {
      collect: {
        description:
          "Read a day's Garmin activities/wellness/weigh-in and Zwift picks " +
          "from other models and write one collect resource. Never touches the " +
          "network.",
        arguments: CollectArgsSchema,
        execute: executeCollect,
      },
    },
    {
      render: {
        description:
          "Render the markdown diary page for a day from its collect resource.",
        arguments: RenderArgsSchema,
        execute: executeRender,
      },
    },
    {
      publish: {
        description:
          "Render a day's diary, merge it into any existing note between the " +
          "managed markers, and write it into the vault via the vault model.",
        arguments: PublishArgsSchema,
        execute: executePublish,
      },
    },
    {
      build: {
        description:
          "Collect and publish in one call. The bundled workflow uses this so " +
          "a run renders the collects it just wrote; a separate publish step " +
          "would read a run-start snapshot and lag a run behind.",
        arguments: BuildArgsSchema,
        execute: executeBuild,
      },
    },
  ],
};
