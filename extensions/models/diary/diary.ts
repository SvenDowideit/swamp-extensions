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
 *   - `collect`  gather a date's activities, wellness and Zwift picks into one
 *                JSON resource (`collect` / `daily-<date>`)
 *   - `render`   turn that resource into the markdown page (`page` /
 *                `daily-<date>`) without writing to the vault
 *   - `publish`  render, merge into any existing note between managed markers,
 *                and write it to the vault
 *
 * @module
 */
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
  activitiesModel: z.string().default("garmin-activities").describe(
    "Model instance holding the Garmin activity list",
  ),
  healthModel: z.string().default("garmin-health").describe(
    "Model instance holding Garmin daily wellness",
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
  collectName: z.string().optional().describe(
    "Name of the collect resource to publish (default: daily-<date>)",
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
  /** The day's BOM forecast, or null when no BOM data was found. */
  weather: CollectedWeather | null;
  /** Ranked Zwift picks for the day. */
  suggested: CollectedSuggestion[];
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

/** Render the markdown body (between the managed markers) for a day. */
export function renderManagedSection(day: CollectedDay): string {
  const lines: string[] = [];
  lines.push(BEGIN_MARKER, "");

  const forecast = formatForecastLine(day.weather);
  if (forecast) lines.push(forecast, "");

  lines.push("## Health");
  const w = day.wellness;
  if (!w) {
    lines.push("- No Garmin wellness data for this day");
  } else {
    if (w.sleepSeconds != null) {
      const score = w.sleepScore != null ? ` (score ${w.sleepScore})` : "";
      lines.push(`- **Sleep:** ${formatDuration(w.sleepSeconds)}${score}`);
    }
    if (w.steps != null) {
      const goal = w.stepGoal != null ? ` of ${formatCount(w.stepGoal)}` : "";
      lines.push(`- **Steps:** ${formatCount(w.steps)}${goal}`);
    }
    const extras = [
      w.restingHeartRate != null ? `resting HR ${w.restingHeartRate}` : null,
      w.avgStress != null ? `stress ${w.avgStress}` : null,
      w.bodyBatteryHighest != null
        ? `body battery ${w.bodyBatteryLowest ?? "?"}–${w.bodyBatteryHighest}`
        : null,
    ].filter(Boolean);
    if (extras.length) lines.push(`- ${extras.join(" · ")}`);
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
      weather: z.record(z.string(), z.unknown()).nullable().optional(),
      suggested: z.array(z.record(z.string(), z.unknown())),
      truncated: z.boolean(),
      missing: z.array(z.string()),
    }),
    lifetime: "infinite" as const,
    garbageCollection: 30,
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

/** Collect a day's data from the synced fitness models. */
async function executeCollect(
  args: CollectArgs,
  context: DiaryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  args = CollectArgsSchema.parse(args);
  const date = resolveDate(args.date, args.timezone);
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

  const activityLists = await read(args.activitiesModel, "list");
  const allRides: CollectedRide[] = [];
  for (const list of activityLists) {
    const acts = Array.isArray(list.activities)
      ? list.activities as Array<Record<string, unknown>>
      : [];
    for (const a of acts) allRides.push(toRide(a));
  }
  const rides = filterActivities(allRides, date);

  const dailyHealth = await read(args.healthModel, "daily");
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

  const bomRecords = await read(args.bomModel, "forecast");
  const weather = selectWeather(bomRecords[0] ?? null, date);

  const recRecords = await read(args.recommenderModel, "recommendations");
  const recommendations = recRecords[0]?.recommendations as
    | Array<Record<string, unknown>>
    | undefined;
  const scheduleRecords = await read(args.eventsModel, "schedule");
  const scheduleEvents = (scheduleRecords[0]?.events ?? []) as Array<
    Record<string, unknown>
  >;
  const schedule = indexSchedule(scheduleEvents);
  const suggested = selectSuggestions(
    recommendations ?? [],
    date,
    args.topN,
    schedule,
  );
  const picksForDate =
    (recommendations ?? []).filter((r) => r.localDate === date).length;

  const payload: CollectedDay = {
    date,
    generatedAt: new Date().toISOString(),
    timezone: args.timezone,
    rides,
    totals: summariseRides(rides),
    wellness,
    weather,
    suggested,
    truncated: picksForDate > suggested.length,
    missing,
  };

  context.logger.info(
    "Collected {date}: {rides} ride(s), {suggested} suggestion(s), " +
      "forecast {forecast}",
    {
      date,
      rides: rides.length,
      suggested: suggested.length,
      forecast: weather ? "yes" : "no",
    },
  );

  const handle = await context.writeResource(
    "collect",
    `daily-${date}`,
    payload as unknown as Record<string, unknown>,
  );
  return { dataHandles: [handle] };
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
  const date = resolveDate(args.date, args.timezone);
  const name = args.collectName ?? `daily-${date}`;
  const day = await readCollect(context, name);
  const managed = renderManagedSection(day);
  const file = `${args.folder.replace(/\/+$/, "")}/${
    args.noteName ?? `${date}.md`
  }`;
  const timestamp = new Date().toISOString();

  if (!context.runModel) {
    throw new Error(
      "context.runModel is unavailable; publish needs it to call the vault model",
    );
  }

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
  const handle = await context.writeResource("publish", `publish-${date}`, {
    date,
    file,
    action: existing.length ? "merged" : "created",
    merged: existing.includes(BEGIN_MARKER),
    timestamp,
  });
  return { dataHandles: [handle] };
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
  if (!result.ok) return "";
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
 * Diary extension: three methods and three resources added to the Obsidian
 * vault model.
 */
export const extension = {
  type: "@magistr/obsidian/vault",
  resources,
  methods: [
    {
      collect: {
        description:
          "Read a day's Garmin activities/wellness and Zwift picks from other " +
          "models and write one collect resource. Never touches the network.",
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
  ],
};
