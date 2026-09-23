/**
 * BOM Weather — a client for the Bureau of Meteorology's public location
 * weather service, covering the 9-day daily forecast, the 72-hour hourly
 * forecast, current station observations and active warnings.
 *
 * The model resolves a location from any one of five selectors — `name`,
 * `postcode`, `state`, `geohash` or `id` — then reads that location's data.
 * Responses carry their own cadence metadata, so a workflow can poll on the
 * cadence the Bureau itself publishes rather than a guessed interval:
 *
 *   daily  `issue_time` / `next_issue_time`   new forecast roughly every 6h
 *   hourly `issue_time`                       new forecast roughly every 3h
 *   obs    `observation_time`                 new observation roughly every 10m
 *
 * Methods:
 *   - `resolve`      resolve a selector to a location (no data fetch)
 *   - `sync`         fetch the 9-day daily forecast, recording issue times
 *   - `sync-hourly`  fetch the 72-hour hourly forecast
 *   - `observe`      fetch the latest station observations
 *   - `warnings`     fetch active warnings (location-scoped or national)
 *   - `print`        log today's and tomorrow's forecast plus the issue metadata
 *
 * @module
 */
import { z } from "npm:zod@4";

const DEFAULT_API_URL = "https://api.weather.bom.gov.au/v1";
const DEFAULT_USER_AGENT = "swamp-bom-weather/1.0";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  apiUrl: z.string()
    .default(DEFAULT_API_URL)
    .describe("BOM weather API base URL (versioned root)."),
  userAgent: z.string()
    .default(DEFAULT_USER_AGENT)
    .describe("User-Agent header sent with every request."),
  name: z.string()
    .default("")
    .describe("Default suburb/town name to search for (e.g. 'Penrith')."),
  postcode: z.string()
    .default("")
    .describe("Default Australian postcode to search for (e.g. '2750')."),
  state: z.string()
    .default("")
    .describe(
      "Default state/territory code (NSW, VIC, QLD, SA, WA, TAS, NT, ACT) " +
        "used to narrow a name/postcode search and to disambiguate places " +
        "that share a name.",
    ),
  geohash: z.string()
    .default("")
    .describe(
      "Default six-character BOM geohash (e.g. 'r650hv8'). " +
        "Highest precedence selector.",
    ),
  id: z.string()
    .default("")
    .describe(
      "Default BOM location id (e.g. 'Penrith-r650hv8'). The trailing " +
        "geohash is extracted automatically.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Shared selector arguments
// ---------------------------------------------------------------------------

/**
 * The five mutually-compatible ways to identify a location. Precedence is
 * `geohash` → `id` → `postcode` → `name`; `state` narrows a search when a
 * place name is ambiguous.
 *
 * Every field is an optional per-call override: leave it unset to use the
 * value configured as a model global argument.
 */
const SelectorArgsSchema = z.object({
  name: z.string()
    .optional()
    .describe(
      "Suburb/town name to search for (e.g. 'Penrith'). Overrides the model " +
        "global argument.",
    ),
  postcode: z.string()
    .optional()
    .describe(
      "Australian postcode to search for (e.g. '2750'). Overrides the model " +
        "global argument.",
    ),
  state: z.string()
    .optional()
    .describe(
      "State/territory code (NSW, VIC, QLD, SA, WA, TAS, NT, ACT) used to " +
        "narrow a name/postcode search and to disambiguate places that share " +
        "a name. Overrides the model global argument.",
    ),
  geohash: z.string()
    .optional()
    .describe(
      "Six-character BOM geohash (e.g. 'r650hv8'). Highest precedence. " +
        "Overrides the model global argument.",
    ),
  id: z.string()
    .optional()
    .describe(
      "BOM location id (e.g. 'Penrith-r650hv8'). The trailing geohash is " +
        "extracted automatically. Overrides the model global argument.",
    ),
});

/** A set of location selectors. Unset fields inherit the model globals. */
export interface SelectorArgs {
  /** Suburb/town name to search for. */
  name?: string;
  /** Australian postcode to search for. */
  postcode?: string;
  /** State/territory code used to narrow or disambiguate a search. */
  state?: string;
  /** Six-character BOM geohash. Highest precedence selector. */
  geohash?: string;
  /** BOM location id; the trailing geohash is extracted from it. */
  id?: string;
}

const SyncArgsSchema = SelectorArgsSchema.extend({
  force: z.boolean()
    .default(false)
    .describe(
      "Write a new forecast snapshot even when issue_time is unchanged.",
    ),
});

type SyncArgs = z.infer<typeof SyncArgsSchema>;

const ResolveArgsSchema = SelectorArgsSchema;
type ResolveArgs = z.infer<typeof ResolveArgsSchema>;

const PrintArgsSchema = z.object({
  dataName: z.string()
    .default("forecast")
    .describe(
      "Resource instance holding the forecast to print (sync writes " +
        "`forecast`).",
    ),
  hourlyHours: z.number().int().min(0).max(72)
    .default(12)
    .describe(
      "How many hourly entries to log when an `hourly` snapshot exists " +
        "(0 = all 72).",
    ),
  warningsDetail: z.boolean()
    .default(false)
    .describe(
      "Include each warning's full HTML message text in the log when a " +
        "`warnings` snapshot exists.",
    ),
});

type PrintArgs = z.infer<typeof PrintArgsSchema>;

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

const PlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().nullable(),
  postcode: z.string().nullable(),
  geohash: z.string(),
  timezone: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

/** A resolved BOM location with its geohash and timezone. */
export interface Place {
  /** BOM location id (e.g. `Penrith-r650hv8`). */
  id: string;
  /** Human-readable place name. */
  name: string;
  /** State/territory code, if known. */
  state: string | null;
  /** Postcode, if a search supplied it. */
  postcode: string | null;
  /** Six-character BOM geohash. */
  geohash: string;
  /** IANA timezone used to derive local dates. */
  timezone: string | null;
  /** Latitude, if known. */
  latitude: number | null;
  /** Longitude, if known. */
  longitude: number | null;
}

const LocationResultSchema = z.object({
  query: z.string(),
  place: PlaceSchema,
  candidates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      state: z.string().nullable(),
      postcode: z.string().nullable(),
      geohash: z.string(),
    }),
  ),
  sourceUrl: z.string(),
});

const DaySchema = z.object({
  date: z.string().describe("Local calendar date, YYYY-MM-DD."),
  weekday: z.string(),
  tempMin: z.number().nullable(),
  tempMax: z.number().nullable(),
  rainChance: z.number().nullable(),
  rainMin: z.number().nullable(),
  rainMax: z.number().nullable(),
  shortText: z.string().nullable(),
  icon: z.string().nullable(),
  uvCategory: z.string().nullable(),
  uvMaxIndex: z.number().nullable(),
  fireDanger: z.string().nullable(),
  sunrise: z.string().nullable(),
  sunset: z.string().nullable(),
});

/** A single day of the forecast, flattened to stable field names. */
export interface ForecastDay {
  /** Local calendar date (YYYY-MM-DD). */
  date: string;
  /** Local weekday name. */
  weekday: string;
  /** Forecast minimum temperature in °C, or null. */
  tempMin: number | null;
  /** Forecast maximum temperature in °C, or null. */
  tempMax: number | null;
  /** Chance of rain as a percentage, or null. */
  rainChance: number | null;
  /** Lower bound of the expected rainfall range in mm, or null. */
  rainMin: number | null;
  /** Upper bound of the expected rainfall range in mm, or null. */
  rainMax: number | null;
  /** Short précis text (e.g. "Shower or two."). */
  shortText: string | null;
  /** Icon descriptor key (e.g. "shower"). */
  icon: string | null;
  /** UV category (e.g. "high"), or null. */
  uvCategory: string | null;
  /** Peak UV index, or null. */
  uvMaxIndex: number | null;
  /** Fire danger rating text, or null. */
  fireDanger: string | null;
  /** Local sunrise time (ISO), or null. */
  sunrise: string | null;
  /** Local sunset time (ISO), or null. */
  sunset: string | null;
}

const ForecastResultSchema = z.object({
  place: PlaceSchema,
  issueTime: z.string(),
  nextIssueTime: z.string(),
  forecastRegion: z.string(),
  forecastType: z.string(),
  fetchedAt: z.string(),
  sourceUrl: z.string(),
  unchanged: z.boolean(),
  days: z.array(DaySchema),
  today: DaySchema.nullable(),
  tomorrow: DaySchema.nullable(),
});

/** A full 9-day forecast plus its issue metadata and today/tomorrow slots. */
export interface Forecast {
  /** The location this forecast is for. */
  place: Place;
  /** When the Bureau issued this forecast (ISO). */
  issueTime: string;
  /** When the next routine revision is due (ISO). */
  nextIssueTime: string;
  /** Bureau forecast region label (e.g. `Penrith`). */
  forecastRegion: string;
  /** Forecast type (e.g. `precis`). */
  forecastType: string;
  /** When this snapshot was fetched (ISO). */
  fetchedAt: string;
  /** Source URL of the forecast response. */
  sourceUrl: string;
  /** True when this snapshot's issueTime matches the previous one. */
  unchanged: boolean;
  /** All returned days, oldest first. */
  days: ForecastDay[];
  /** The forecast day covering today, or null. */
  today: ForecastDay | null;
  /** The forecast day covering tomorrow, or null. */
  tomorrow: ForecastDay | null;
}

// --- Hourly forecast ---------------------------------------------------------

const HourlyEntrySchema = z.object({
  time: z.string(),
  localTime: z.string(),
  date: z.string(),
  temp: z.number().nullable(),
  tempFeelsLike: z.number().nullable(),
  dewPoint: z.number().nullable(),
  relativeHumidity: z.number().nullable(),
  windSpeedKmh: z.number().nullable(),
  windSpeedKnots: z.number().nullable(),
  windDirection: z.string().nullable(),
  gustSpeedKmh: z.number().nullable(),
  uvIndex: z.number().nullable(),
  rainChance: z.number().nullable(),
  rainMin: z.number().nullable(),
  rainMax: z.number().nullable(),
  isNight: z.boolean().nullable(),
  icon: z.string().nullable(),
});

/** One hour of the 72-hour forecast, flattened to stable field names. */
export interface HourlyEntry {
  /** Forecast instant (ISO, UTC). */
  time: string;
  /** Local clock time (HH:MM) in the location's timezone. */
  localTime: string;
  /** Local calendar date (YYYY-MM-DD). */
  date: string;
  /** Air temperature in °C. */
  temp: number | null;
  /** Apparent (feels-like) temperature in °C. */
  tempFeelsLike: number | null;
  /** Dew point in °C. */
  dewPoint: number | null;
  /** Relative humidity as a percentage. */
  relativeHumidity: number | null;
  /** Wind speed in km/h. */
  windSpeedKmh: number | null;
  /** Wind speed in knots. */
  windSpeedKnots: number | null;
  /** Wind direction (16-point compass, e.g. "SSW"). */
  windDirection: string | null;
  /** Gust speed in km/h. */
  gustSpeedKmh: number | null;
  /** UV index. */
  uvIndex: number | null;
  /** Chance of rain as a percentage. */
  rainChance: number | null;
  /** Lower bound of the expected rainfall range in mm. */
  rainMin: number | null;
  /** Upper bound of the expected rainfall range in mm. */
  rainMax: number | null;
  /** Whether the hour is at night. */
  isNight: boolean | null;
  /** Icon descriptor key (e.g. "shower"). */
  icon: string | null;
}

const HourlyResultSchema = z.object({
  place: PlaceSchema,
  issueTime: z.string(),
  fetchedAt: z.string(),
  sourceUrl: z.string(),
  entries: z.array(HourlyEntrySchema),
});

/** A 72-hour hourly forecast for a location. */
export interface HourlyForecast {
  /** The location this forecast is for. */
  place: Place;
  /** When the Bureau issued this forecast (ISO). */
  issueTime: string;
  /** When this snapshot was fetched (ISO). */
  fetchedAt: string;
  /** Source URL of the hourly response. */
  sourceUrl: string;
  /** Hourly entries, soonest first. */
  entries: HourlyEntry[];
}

// --- Observations ------------------------------------------------------------

const ObservationResultSchema = z.object({
  place: PlaceSchema,
  observationTime: z.string(),
  issueTime: z.string(),
  fetchedAt: z.string(),
  sourceUrl: z.string(),
  temp: z.number().nullable(),
  tempFeelsLike: z.number().nullable(),
  humidity: z.number().nullable(),
  rainSince9am: z.number().nullable(),
  windSpeedKmh: z.number().nullable(),
  windSpeedKnots: z.number().nullable(),
  windDirection: z.string().nullable(),
  gustSpeedKmh: z.number().nullable(),
  gustSpeedKnots: z.number().nullable(),
  maxGustKmh: z.number().nullable(),
  maxGustTime: z.string().nullable(),
  maxTemp: z.number().nullable(),
  maxTempTime: z.string().nullable(),
  minTemp: z.number().nullable(),
  minTempTime: z.string().nullable(),
  stationId: z.string().nullable(),
  stationName: z.string().nullable(),
  stationDistanceMetres: z.number().nullable(),
});

/** Latest observed conditions for the nearest station. */
export interface Observation {
  /** The requested location. */
  place: Place;
  /** When the observation was recorded (ISO). */
  observationTime: string;
  /** When the observation feed was issued (ISO). */
  issueTime: string;
  /** When this snapshot was fetched (ISO). */
  fetchedAt: string;
  /** Source URL of the observations response. */
  sourceUrl: string;
  /** Air temperature in °C. */
  temp: number | null;
  /** Apparent (feels-like) temperature in °C. */
  tempFeelsLike: number | null;
  /** Relative humidity as a percentage. */
  humidity: number | null;
  /** Rainfall since 9am local, in mm. */
  rainSince9am: number | null;
  /** Wind speed in km/h. */
  windSpeedKmh: number | null;
  /** Wind speed in knots. */
  windSpeedKnots: number | null;
  /** Wind direction (16-point compass). */
  windDirection: string | null;
  /** Gust speed in km/h. */
  gustSpeedKmh: number | null;
  /** Gust speed in knots. */
  gustSpeedKnots: number | null;
  /** Strongest gust today in km/h. */
  maxGustKmh: number | null;
  /** Time of the strongest gust today (ISO). */
  maxGustTime: string | null;
  /** Highest temperature today in °C. */
  maxTemp: number | null;
  /** Time of the highest temperature today (ISO). */
  maxTempTime: string | null;
  /** Lowest temperature today in °C. */
  minTemp: number | null;
  /** Time of the lowest temperature today (ISO). */
  minTempTime: string | null;
  /** Observing station BOM id. */
  stationId: string | null;
  /** Observing station name. */
  stationName: string | null;
  /** Station distance from the requested location, in metres. */
  stationDistanceMetres: number | null;
}

// --- Warnings ----------------------------------------------------------------

const WarningItemSchema = z.object({
  id: z.string(),
  areaId: z.string().nullable(),
  type: z.string(),
  title: z.string(),
  shortTitle: z.string(),
  state: z.string().nullable(),
  states: z.array(z.string()),
  groupType: z.string().nullable(),
  issueTime: z.string(),
  expiryTime: z.string().nullable(),
  phase: z.string().nullable(),
  message: z.string().nullable(),
});

/** One active warning (list-level fields, plus `message` when detailed). */
export interface WeatherWarning {
  /** Warning id (composite `{area}_{product}` for location-scoped warnings). */
  id: string;
  /** Marine/area id, when the warning is area-scoped. */
  areaId: string | null;
  /** Warning type (e.g. `frost_warning`, `hazardous_surf_warning`). */
  type: string;
  /** Title, often naming the affected districts. */
  title: string;
  /** Short title (e.g. "Frost Warning"). */
  shortTitle: string;
  /** Primary state/territory code. */
  state: string | null;
  /** All affected state/territory codes. */
  states: string[];
  /** Group type (`minor` | `major`). */
  groupType: string | null;
  /** When the warning was issued (ISO). */
  issueTime: string;
  /** When the warning expires (ISO), or null. */
  expiryTime: string | null;
  /** Lifecycle phase (`new` | `update` | `renewal`). */
  phase: string | null;
  /** Full HTML message body, present only when `detail` is requested. */
  message: string | null;
}

const WarningsResultSchema = z.object({
  scope: z.string(),
  stateFilter: z.string().nullable(),
  fetchedAt: z.string(),
  sourceUrl: z.string(),
  count: z.number(),
  warnings: z.array(WarningItemSchema),
});

/** A snapshot of active warnings (location-scoped or national). */
export interface WarningsResult {
  /** `location` or `national`. */
  scope: string;
  /** State code the listing was filtered to, or null. */
  stateFilter: string | null;
  /** When this snapshot was fetched (ISO). */
  fetchedAt: string;
  /** Source URL of the warnings response. */
  sourceUrl: string;
  /** Number of warnings after filtering. */
  count: number;
  /** The warnings themselves. */
  warnings: WeatherWarning[];
}

const PrintResultSchema = z.object({
  printed: z.boolean(),
  issueTime: z.string().nullable(),
  nextIssueTime: z.string().nullable(),
  location: z.string().nullable(),
  today: DaySchema.nullable(),
  tomorrow: DaySchema.nullable(),
  lines: z.array(z.string()),
  observed: ObservationResultSchema.nullable(),
  hourly: HourlyResultSchema.nullable(),
  warnings: WarningsResultSchema.nullable(),
});

// --- Method argument schemas for the new sources -----------------------------

const SyncHourlyArgsSchema = SelectorArgsSchema;
type SyncHourlyArgs = z.infer<typeof SyncHourlyArgsSchema>;

const ObserveArgsSchema = SelectorArgsSchema;
type ObserveArgs = z.infer<typeof ObserveArgsSchema>;

const WarningsArgsSchema = SelectorArgsSchema.extend({
  scope: z.enum(["location", "national"]).default("location").describe(
    "`location` returns warnings affecting the resolved place; `national` " +
      "returns every active warning.",
  ),
  state: z.string().default("").describe(
    "Optional state filter applied client-side to a national listing " +
      "(e.g. 'NSW').",
  ),
  detail: z.boolean().default(false).describe(
    "Fetch each warning's full HTML message text.",
  ),
});

type WarningsArgs = z.infer<typeof WarningsArgsSchema>;

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
    debug?: (message: string, properties?: Record<string, unknown>) => void;
    warn?: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Extract the trailing BOM geohash (6–8 chars) from a location id. */
export function geohashFromId(id: string): string | null {
  const match = id.match(/-([a-z0-9]{6,8})$/);
  return match ? match[1] : null;
}

/** URL for a location text search. */
export function searchUrl(apiUrl: string, query: string): string {
  const params = new URLSearchParams({ search: query });
  return `${apiUrl}/locations?${params}`;
}

/** URL for a location's detail (timezone, lat/lon). */
export function locationUrl(apiUrl: string, geohash: string): string {
  return `${apiUrl}/locations/${geohash}`;
}

/** URL for a location's 9-day daily forecast. */
export function dailyUrl(apiUrl: string, geohash: string): string {
  return `${apiUrl}/locations/${geohash}/forecasts/daily`;
}

/** URL for a location's 72-hour hourly forecast. */
export function hourlyUrl(apiUrl: string, geohash: string): string {
  return `${apiUrl}/locations/${geohash}/forecasts/hourly`;
}

/** URL for a location's latest observations (nearest station). */
export function observationsUrl(apiUrl: string, geohash: string): string {
  return `${apiUrl}/locations/${geohash}/observations`;
}

/** URL for warnings scoped to a location. */
export function locationWarningsUrl(apiUrl: string, geohash: string): string {
  return `${apiUrl}/locations/${geohash}/warnings`;
}

/** URL for all active warnings nationally. */
export function nationalWarningsUrl(apiUrl: string): string {
  return `${apiUrl}/warnings`;
}

/** URL for one warning's detail (includes the full HTML message text). */
export function warningDetailUrl(apiUrl: string, id: string): string {
  return `${apiUrl}/warnings/${id}`;
}

/**
 * The 6-character geohash the hourly and observations endpoints require. The
 * daily endpoint returns a 7-character geohash, so truncating is necessary
 * before calling those endpoints (which 400 on a 7-character value).
 */
export function geohash6(geohash: string): string {
  return geohash.trim().toLowerCase().slice(0, 6);
}

/**
 * Choose the best candidate from a location search. When `state` is given it is
 * matched case-insensitively first; otherwise the upstream result ordering is
 * trusted (BOM ranks an exact place-name match first).
 */
export function pickCandidate(
  candidates: {
    id: string;
    name: string;
    state: string | null;
    postcode: string | null;
    geohash: string;
  }[],
  state: string,
): (typeof candidates)[number] | null {
  if (candidates.length === 0) return null;
  if (state) {
    const wanted = state.trim().toUpperCase();
    const match = candidates.find((c) =>
      (c.state ?? "").toUpperCase() === wanted
    );
    if (match) return match;
  }
  return candidates[0];
}

/** The local calendar date (YYYY-MM-DD) of an instant, in an IANA timezone. */
export function localDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** The local weekday name of an instant, in an IANA timezone. */
export function localWeekday(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone,
      weekday: "long",
    }).format(date);
  } catch {
    return "";
  }
}

/** The local clock time (HH:MM) of an instant, in an IANA timezone. */
export function localTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return iso;
  }
}

/**
 * The shape of a BOM daily-forecast response, to the depth this model reads.
 * Documented so `parseDaily` can be tested against fixtures without a fetch.
 */
export interface RawDaily {
  /** Response metadata, including the issue cadence. */
  metadata?: {
    issue_time?: string;
    next_issue_time?: string;
    forecast_region?: string;
    forecast_type?: string;
  };
  /** Per-day entries, oldest first. */
  data?: Record<string, unknown>[];
}

/** Map one upstream daily entry into a flat, stable forecast day. */
export function parseDay(
  raw: Record<string, unknown>,
  timeZone: string,
): ForecastDay {
  const rain = (raw.rain ?? {}) as {
    amount?: { min?: number | null; max?: number | null };
    chance?: number | null;
  };
  const uv = (raw.uv ?? {}) as {
    category?: string | null;
    max_index?: number | null;
  };
  const astro = (raw.astronomical ?? {}) as {
    sunrise_time?: string | null;
    sunset_time?: string | null;
  };
  const rawDate = typeof raw.date === "string" ? raw.date : "";
  const date = new Date(rawDate);
  const valid = !Number.isNaN(date.getTime());

  return {
    date: valid ? localDate(date, timeZone) : rawDate,
    weekday: valid ? localWeekday(date, timeZone) : "",
    tempMin: (raw.temp_min ?? null) as number | null,
    tempMax: (raw.temp_max ?? null) as number | null,
    rainChance: rain.chance ?? null,
    rainMin: rain.amount?.min ?? null,
    rainMax: rain.amount?.max ?? null,
    shortText: (raw.short_text ?? null) as string | null,
    icon: (raw.icon_descriptor ?? null) as string | null,
    uvCategory: uv.category ?? null,
    uvMaxIndex: uv.max_index ?? null,
    fireDanger: (raw.fire_danger ?? null) as string | null,
    sunrise: astro.sunrise_time ?? null,
    sunset: astro.sunset_time ?? null,
  };
}

/** Parse a daily forecast response into a normalised forecast. */
export function parseDaily(
  payload: RawDaily,
  place: Place,
  fetchedAt: string,
  sourceUrl: string,
): Forecast {
  const timeZone = place.timezone ?? "Australia/Sydney";
  const tz = timeZone;
  const days = (payload.data ?? []).map((d) => parseDay(d, tz));

  const now = new Date(fetchedAt);
  const todayDate = localDate(now, tz);
  const tomorrowDate = localDate(new Date(now.getTime() + 86_400_000), tz);

  const withMax = days.filter((d) => d.tempMax !== null || d.tempMin !== null);
  const today = days.find((d) => d.date === todayDate) ?? withMax[0] ?? null;
  const tomorrow = days.find((d) => d.date === tomorrowDate) ?? null;

  return {
    place,
    issueTime: payload.metadata?.issue_time ?? "",
    nextIssueTime: payload.metadata?.next_issue_time ?? "",
    forecastRegion: payload.metadata?.forecast_region ?? place.name,
    forecastType: payload.metadata?.forecast_type ?? "precis",
    fetchedAt,
    sourceUrl,
    unchanged: false,
    days,
    today,
    tomorrow,
  };
}

/** Map one upstream hourly entry into a flat, stable entry. */
export function parseHour(
  raw: Record<string, unknown>,
  timeZone: string,
): HourlyEntry {
  const rain = (raw.rain ?? {}) as {
    amount?: { min?: number | null; max?: number | null };
    chance?: number | null;
  };
  const wind = (raw.wind ?? {}) as {
    speed_knot?: number | null;
    speed_kilometre?: number | null;
    direction?: string | null;
    gust_speed_kilometre?: number | null;
  };
  const iso = typeof raw.time === "string" ? raw.time : "";
  const date = new Date(iso);
  const valid = !Number.isNaN(date.getTime());

  return {
    time: iso,
    localTime: valid ? localTime(iso, timeZone) : "",
    date: valid ? localDate(date, timeZone) : "",
    temp: (raw.temp ?? null) as number | null,
    tempFeelsLike: (raw.temp_feels_like ?? null) as number | null,
    dewPoint: (raw.dew_point ?? null) as number | null,
    relativeHumidity: (raw.relative_humidity ?? null) as number | null,
    windSpeedKmh: wind.speed_kilometre ?? null,
    windSpeedKnots: wind.speed_knot ?? null,
    windDirection: wind.direction ?? null,
    gustSpeedKmh: wind.gust_speed_kilometre ?? null,
    uvIndex: (raw.uv ?? null) as number | null,
    rainChance: rain.chance ?? null,
    rainMin: rain.amount?.min ?? null,
    rainMax: rain.amount?.max ?? null,
    isNight: (raw.is_night ?? null) as boolean | null,
    icon: (raw.icon_descriptor ?? null) as string | null,
  };
}

/** Parse a 72-hour hourly-forecast response. */
export function parseHourly(
  payload: {
    metadata?: { issue_time?: string };
    data?: Record<string, unknown>[];
  },
  place: Place,
  fetchedAt: string,
  sourceUrl: string,
): HourlyForecast {
  const tz = place.timezone ?? "Australia/Sydney";
  return {
    place,
    issueTime: payload.metadata?.issue_time ?? "",
    fetchedAt,
    sourceUrl,
    entries: (payload.data ?? []).map((e) => parseHour(e, tz)),
  };
}

/** Map an observations response (a single object) into a flat observation. */
export function parseObservations(
  payload: {
    metadata?: { issue_time?: string; observation_time?: string };
    data?: Record<string, unknown>;
  },
  place: Place,
  fetchedAt: string,
  sourceUrl: string,
): Observation {
  const d = payload.data ?? {};
  const wind = (d.wind ?? {}) as {
    speed_kilometre?: number | null;
    speed_knot?: number | null;
    direction?: string | null;
  };
  const gust = (d.gust ?? {}) as {
    speed_kilometre?: number | null;
    speed_knot?: number | null;
  };
  const maxGust = (d.max_gust ?? {}) as {
    speed_kilometre?: number | null;
    time?: string | null;
  };
  const maxTemp = (d.max_temp ?? {}) as {
    value?: number | null;
    time?: string | null;
  };
  const minTemp = (d.min_temp ?? {}) as {
    value?: number | null;
    time?: string | null;
  };
  const station = (d.station ?? {}) as {
    bom_id?: string | null;
    name?: string | null;
    distance?: number | null;
  };

  return {
    place,
    observationTime: payload.metadata?.observation_time ?? "",
    issueTime: payload.metadata?.issue_time ?? "",
    fetchedAt,
    sourceUrl,
    temp: (d.temp ?? null) as number | null,
    tempFeelsLike: (d.temp_feels_like ?? null) as number | null,
    humidity: (d.humidity ?? null) as number | null,
    rainSince9am: (d.rain_since_9am ?? null) as number | null,
    windSpeedKmh: wind.speed_kilometre ?? null,
    windSpeedKnots: wind.speed_knot ?? null,
    windDirection: wind.direction ?? null,
    gustSpeedKmh: gust.speed_kilometre ?? null,
    gustSpeedKnots: gust.speed_knot ?? null,
    maxGustKmh: maxGust.speed_kilometre ?? null,
    maxGustTime: maxGust.time ?? null,
    maxTemp: maxTemp.value ?? null,
    maxTempTime: maxTemp.time ?? null,
    minTemp: minTemp.value ?? null,
    minTempTime: minTemp.time ?? null,
    stationId: station.bom_id ?? null,
    stationName: station.name ?? null,
    stationDistanceMetres: station.distance ?? null,
  };
}

/** Map one warning entry into a flat warning. */
export function parseWarning(raw: Record<string, unknown>): WeatherWarning {
  return {
    id: String(raw.id ?? ""),
    areaId: (raw.area_id ?? null) as string | null,
    type: String(raw.type ?? ""),
    title: String(raw.title ?? ""),
    shortTitle: String(raw.short_title ?? ""),
    state: (raw.state ?? null) as string | null,
    states: (raw.states ?? []) as string[],
    groupType: (raw.warning_group_type ?? null) as string | null,
    issueTime: String(raw.issue_time ?? ""),
    expiryTime: (raw.expiry_time ?? null) as string | null,
    phase: (raw.phase ?? null) as string | null,
    message: (raw.message ?? null) as string | null,
  };
}

/** Filter a warning list by state (client-side — the API ignores query filters). */
export function filterWarningsByState(
  warnings: WeatherWarning[],
  state: string,
): WeatherWarning[] {
  const wanted = state.trim().toUpperCase();
  if (!wanted) return warnings;
  return warnings.filter((w) =>
    w.state?.toUpperCase() === wanted ||
    w.states.some((s) => s.toUpperCase() === wanted)
  );
}

/** One human-readable line for a forecast day. */
export function formatDay(day: ForecastDay): string {
  const temps = day.tempMin !== null && day.tempMax !== null
    ? `${day.tempMin}–${day.tempMax}°C`
    : day.tempMax !== null
    ? `max ${day.tempMax}°C`
    : day.tempMin !== null
    ? `min ${day.tempMin}°C`
    : "no temperature data";
  const rain = day.rainChance !== null
    ? `${day.rainChance}% chance${
      day.rainMin !== null && day.rainMax !== null
        ? `, ${day.rainMin}–${day.rainMax} mm`
        : ""
    }`
    : "no rain data";
  return `${day.weekday} ${day.date}: ${temps}; ${
    day.shortText ?? "n/a"
  }; ${rain}`;
}

/** Render the print summary (today, tomorrow, issue metadata) as lines. */
export function formatSummary(forecast: Forecast): string[] {
  const lines: string[] = [];
  lines.push(
    `Location: ${forecast.place.name}${
      forecast.place.state ? `, ${forecast.place.state}` : ""
    } (${forecast.place.geohash})`,
  );
  lines.push(`Issue time:      ${forecast.issueTime}`);
  lines.push(`Next issue time: ${forecast.nextIssueTime}`);
  lines.push("");
  lines.push(
    forecast.today
      ? `Today:    ${formatDay(forecast.today)}`
      : "Today:    no forecast data",
  );
  lines.push(
    forecast.tomorrow
      ? `Tomorrow: ${formatDay(forecast.tomorrow)}`
      : "Tomorrow: no forecast data",
  );
  return lines;
}

/** Render a single line describing the latest observation. */
export function formatObservation(obs: Observation): string[] {
  const wind = obs.windSpeedKmh !== null
    ? `${obs.windSpeedKmh} km/h${
      obs.windDirection ? ` ${obs.windDirection}` : ""
    }`
    : "n/a";
  const gust = obs.gustSpeedKmh !== null ? `${obs.gustSpeedKmh} km/h` : "n/a";
  const station = obs.stationName
    ? `${obs.stationName}${
      obs.stationDistanceMetres !== null
        ? ` (${obs.stationDistanceMetres} m away)`
        : ""
    }`
    : "unknown station";
  const lines: string[] = [];
  lines.push("Observed:");
  lines.push(
    `  ${obs.temp ?? "n/a"}°C (feels like ${obs.tempFeelsLike ?? "n/a"}°C), ` +
      `humidity ${obs.humidity ?? "n/a"}%, ` +
      `rain since 9am ${obs.rainSince9am ?? "n/a"} mm`,
  );
  lines.push(`  Wind ${wind}, gust ${gust}`);
  lines.push(
    `  Today max ${obs.maxTemp ?? "n/a"}°C, min ${
      obs.minTemp ?? "n/a"
    }°C — ${station}`,
  );
  lines.push(`  Observation time: ${obs.observationTime}`);
  return lines;
}

/**
 * Render the next `hours` hourly entries as one line each. Pass `0` to render
 * every returned hour (up to 72).
 */
export function formatHourly(hourly: HourlyForecast, hours = 12): string[] {
  const all = hourly.entries;
  const shown = hours > 0 ? all.slice(0, hours) : all;
  const lines: string[] = [];
  lines.push(
    `Hourly (next ${shown.length} of ${all.length}h, issued ${
      hourly.issueTime || "n/a"
    }):`,
  );
  for (const h of shown) {
    const temp = h.temp !== null ? `${h.temp}°C` : "?";
    const feels = h.tempFeelsLike !== null
      ? ` (feels ${h.tempFeelsLike}°C)`
      : "";
    const wind = h.windSpeedKmh !== null
      ? `wind ${h.windSpeedKmh}km/h${
        h.windDirection ? ` ${h.windDirection}` : ""
      }`
      : "wind n/a";
    const gust = h.gustSpeedKmh !== null ? ` gust ${h.gustSpeedKmh}` : "";
    const rain = h.rainChance !== null ? `rain ${h.rainChance}%` : "rain n/a";
    const icon = h.icon ? `${h.icon}; ` : "";
    lines.push(
      `  ${h.localTime} ${h.date}: ${temp}${feels}; ${icon}${wind}${gust}; ${rain}`,
    );
  }
  return lines;
}

/** Collapse a warning's HTML message body into a single plain-text line. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Render the warning list as one line per warning. */
export function formatWarnings(
  warnings: WeatherWarning[],
  scope: string,
  stateFilter: string | null,
): string[] {
  const where = scope === "national"
    ? `national${stateFilter ? ` (${stateFilter})` : ""}`
    : "this location";
  if (warnings.length === 0) {
    return [`Warnings (${where}): none`];
  }
  const lines: string[] = [`Warnings (${where}): ${warnings.length}`];
  for (const w of warnings) {
    const detail = w.state ? ` [${w.state}]` : "";
    const phase = w.phase ? ` (${w.phase})` : "";
    lines.push(
      `  ${w.shortTitle}${detail}${phase} — expires ${w.expiryTime ?? "n/a"}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Fetching + resolution
// ---------------------------------------------------------------------------

async function getJson(
  ctx: MethodContext,
  url: string,
): Promise<Record<string, unknown>> {
  ctx.logger.debug?.("GET {url}", { url });
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": ctx.globalArgs.userAgent,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `BOM request failed: ${response.status} ${response.statusText} (${url})` +
        (body ? ` — ${body.slice(0, 200)}` : ""),
    );
  }
  return await response.json() as Record<string, unknown>;
}

function describeSelector(args: SelectorArgs): string {
  if (args.geohash) return `geohash=${args.geohash}`;
  if (args.id) return `id=${args.id}`;
  if (args.postcode) return `postcode=${args.postcode}`;
  if (args.name) return `name=${args.name}`;
  return "";
}

/**
 * Merge a method's selector arguments with the model's global-argument
 * defaults. A non-empty argument wins; otherwise the global value is used.
 */
export function mergeSelectors(
  globals: SelectorArgs,
  args: SelectorArgs,
): SelectorArgs {
  const pick = (a?: string, g?: string): string | undefined => {
    const av = a?.trim();
    if (av) return av;
    const gv = g?.trim();
    return gv ? gv : undefined;
  };
  const merged: SelectorArgs = {};
  for (const key of ["name", "postcode", "state", "geohash", "id"] as const) {
    const value = pick(args[key], globals[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Resolve any selector to a full `Place`. `geohash` and `id` skip the search
 * call; `postcode`/`name` (optionally narrowed by `state`) hit the search
 * endpoint and take the best candidate. Method arguments override the model's
 * global-argument defaults.
 */
async function resolvePlace(
  ctx: MethodContext,
  rawArgs: SelectorArgs,
): Promise<{
  place: Place;
  candidates: {
    id: string;
    name: string;
    state: string | null;
    postcode: string | null;
    geohash: string;
  }[];
  sourceUrl: string;
  selector: SelectorArgs;
}> {
  const args = mergeSelectors(ctx.globalArgs, rawArgs);
  const apiUrl = ctx.globalArgs.apiUrl.replace(/\/+$/, "");
  let geohash = (args.geohash ?? "").trim().toLowerCase();
  let searched: Record<string, unknown>[] = [];
  let sourceUrl = "";
  let preferredName = "";

  if (!geohash && args.id) {
    const derived = geohashFromId(args.id);
    if (!derived) {
      throw new Error(
        `Could not extract a geohash from id '${args.id}'. Expected a trailing ` +
          `geohash, e.g. 'Penrith-r650hv8'.`,
      );
    }
    geohash = derived;
    const stem = args.id.replace(/-[a-z0-9]{6,8}$/, "");
    if (stem) preferredName = stem;
  }

  if (!geohash) {
    const query = (args.postcode || args.name || "").trim();
    if (!query) {
      throw new Error(
        "No location selector supplied. Set one of name, postcode, state, " +
          "geohash or id as a model global argument, or pass it as a method " +
          "input / workflow input.",
      );
    }
    sourceUrl = searchUrl(apiUrl, query);
    const body = await getJson(ctx, sourceUrl);
    searched = (body.data ?? []) as Record<string, unknown>[];
    const candidates = searched.map((c) => ({
      id: String(c.id),
      name: String(c.name),
      state: (c.state ?? null) as string | null,
      postcode: (c.postcode ?? null) as string | null,
      geohash: String(c.geohash),
    }));
    const chosen = pickCandidate(candidates, args.state ?? "");
    if (!chosen) {
      throw new Error(
        `No BOM location matched '${query}'${
          args.state ? ` in ${args.state}` : ""
        }.`,
      );
    }
    geohash = chosen.geohash;
    // The candidate name is the place the user asked for (e.g. "Penrith");
    // the detail endpoint below reports the geohash cell's canonical label,
    // which can differ ("Castlereagh"). Prefer the searched name.
    preferredName = chosen.name;
  }

  const detailUrl = locationUrl(apiUrl, geohash);
  const detail = (await getJson(ctx, detailUrl)).data as Record<
    string,
    unknown
  >;
  const place: Place = {
    id: String(detail.id ?? geohash),
    name: preferredName || String(detail.name ?? "Unknown"),
    state: (detail.state ?? null) as string | null,
    postcode: (searched.find((s) => s.geohash === geohash)?.postcode ??
      null) as string | null,
    geohash: String(detail.geohash ?? geohash),
    timezone: (detail.timezone ?? null) as string | null,
    latitude: (detail.latitude ?? null) as number | null,
    longitude: (detail.longitude ?? null) as number | null,
  };

  return {
    place,
    candidates: searched.map((c) => ({
      id: String(c.id),
      name: String(c.name),
      state: (c.state ?? null) as string | null,
      postcode: (c.postcode ?? null) as string | null,
      geohash: String(c.geohash),
    })),
    sourceUrl: detailUrl,
    selector: args,
  };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Client for BOM's public 9-day location forecast service. */
export const model = {
  type: "@svendowideit/bom-weather",
  version: "2026.09.23.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.23.1",
      description:
        "Add hourly forecast, station observations and warnings methods " +
        "(new resources: hourly, observation, warnings). No global-argument " +
        "or existing-resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.23.2",
      description:
        "print now logs a consolidated view of forecast, observation, hourly " +
        "and warnings; adds print inputs hourlyHours and warningsDetail, and " +
        "summary fields observed/hourly/warnings. No global-argument or other " +
        "resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    location: {
      description: "A resolved BOM location (place metadata)",
      schema: LocationResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    forecast: {
      description: "The 9-day daily forecast plus issue metadata",
      schema: ForecastResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    summary: {
      description: "The printed today/tomorrow summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    hourly: {
      description: "The 72-hour hourly forecast plus issue metadata",
      schema: HourlyResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    observation: {
      description: "The latest observed conditions at the nearest station",
      schema: ObservationResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    warnings: {
      description: "Active warnings (location-scoped or national)",
      schema: WarningsResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    resolve: {
      description:
        "Resolve a location selector (name, postcode, state, geohash or id) " +
        "into a BOM place with its geohash and timezone. Makes no forecast " +
        "request — use this to inspect how an ambiguous name resolves.",
      arguments: ResolveArgsSchema,
      execute: async (args: ResolveArgs, context: MethodContext) => {
        const { place, candidates, sourceUrl, selector } = await resolvePlace(
          context,
          args,
        );
        const handle = await context.writeResource("location", "location", {
          query: describeSelector(selector),
          place,
          candidates,
          sourceUrl,
        });
        context.logger.info("Resolved {query} → {name} ({geohash})", {
          query: describeSelector(selector) || "default",
          name: place.name,
          geohash: place.geohash,
        });
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Resolve a selector and fetch the location's 9-day daily forecast. " +
        "Records issue_time and next_issue_time from the upstream response so " +
        "callers can poll on the Bureau's own cadence. Unchanged issue_time " +
        "still writes a snapshot unless `force` is set (the snapshot is " +
        "deduplicated by the resource instance name).",
      arguments: SyncArgsSchema,
      execute: async (args: SyncArgs, context: MethodContext) => {
        const { place } = await resolvePlace(context, args);
        const apiUrl = context.globalArgs.apiUrl.replace(/\/+$/, "");
        const url = dailyUrl(apiUrl, place.geohash);
        const payload = await getJson(context, url) as RawDaily;
        const fetchedAt = new Date().toISOString();
        const forecast = parseDaily(payload, place, fetchedAt, url);

        const previous = await context.readResource("forecast") as {
          issueTime?: string;
        } | null;
        const unchanged = !args.force && previous !== null &&
          previous.issueTime === forecast.issueTime &&
          forecast.issueTime !== "";
        forecast.unchanged = unchanged;

        const handle = await context.writeResource("forecast", "forecast", {
          ...forecast,
        });
        context.logger.info(
          "Synced {name} ({geohash}): {days} days, issue {issue}{unchanged}",
          {
            name: place.name,
            geohash: place.geohash,
            days: forecast.days.length,
            issue: forecast.issueTime,
            unchanged: unchanged ? " (unchanged)" : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    print: {
      description:
        "Log a consolidated view of everything the other methods stored: " +
        "today/tomorrow plus issue_time/next_issue_time from `forecast`, the " +
        "latest reading from `observation`, the next hours from `hourly`, and " +
        "the active `warnings`. Every source except `forecast` is optional — " +
        "run the matching method earlier in the workflow to include it.",
      arguments: PrintArgsSchema,
      execute: async (args: PrintArgs, context: MethodContext) => {
        const stored = await context.readResource(args.dataName) as
          | Forecast
          | null;

        if (!stored || stored.issueTime === undefined) {
          const empty = {
            printed: false,
            issueTime: null,
            nextIssueTime: null,
            location: null,
            today: null,
            tomorrow: null,
            lines: ["No forecast snapshot found — run the sync method first."],
            observed: null,
            hourly: null,
            warnings: null,
          };
          const handle = await context.writeResource(
            "summary",
            "summary",
            empty,
          );
          context.logger.warn?.(
            "print: no forecast snapshot found at '{name}'",
            { name: args.dataName },
          );
          return { dataHandles: [handle] };
        }

        const forecast = stored as unknown as Forecast;
        const lines = formatSummary(forecast);

        const observed = await context.readResource("observation") as
          | Observation
          | null;
        const hourly = await context.readResource("hourly") as
          | HourlyForecast
          | null;
        const warnings = await context.readResource("warnings") as
          | WarningsResult
          | null;

        // The forecast block always prints; a blank line separates each block
        // that has a snapshot to show.
        if (observed) {
          lines.push("");
          lines.push(...formatObservation(observed));
        }
        if (hourly && hourly.entries) {
          lines.push("");
          lines.push(...formatHourly(hourly, args.hourlyHours));
        }
        if (warnings && warnings.warnings) {
          lines.push("");
          lines.push(
            ...formatWarnings(
              warnings.warnings,
              warnings.scope ?? "location",
              warnings.stateFilter ?? null,
            ),
          );
          if (args.warningsDetail) {
            for (const w of warnings.warnings) {
              if (!w.message) continue;
              lines.push(`  ${w.shortTitle}: ${stripHtml(w.message)}`);
            }
          }
        }

        for (const line of lines) context.logger.info(line);

        const result = {
          printed: true,
          issueTime: forecast.issueTime ?? null,
          nextIssueTime: forecast.nextIssueTime ?? null,
          location: forecast.place?.name ?? null,
          today: forecast.today ?? null,
          tomorrow: forecast.tomorrow ?? null,
          lines,
          observed: observed ?? null,
          hourly: hourly ?? null,
          warnings: warnings ?? null,
        };
        const handle = await context.writeResource(
          "summary",
          "summary",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    "sync-hourly": {
      description:
        "Resolve a selector and fetch the location's 72-hour hourly forecast " +
        "— temperature, feels-like, dew point, humidity, wind, gusts, UV and " +
        "rain chance per hour. Uses the 6-character geohash the hourly " +
        "endpoint requires.",
      arguments: SyncHourlyArgsSchema,
      execute: async (args: SyncHourlyArgs, context: MethodContext) => {
        const { place } = await resolvePlace(context, args);
        const apiUrl = context.globalArgs.apiUrl.replace(/\/+$/, "");
        const url = hourlyUrl(apiUrl, geohash6(place.geohash));
        const payload = await getJson(context, url) as {
          metadata?: { issue_time?: string };
          data?: Record<string, unknown>[];
        };
        const fetchedAt = new Date().toISOString();
        const hourly = parseHourly(payload, place, fetchedAt, url);
        const handle = await context.writeResource("hourly", "hourly", {
          ...hourly,
        });
        context.logger.info(
          "Synced hourly {name} ({geohash}): {n} hours, issue {issue}",
          {
            name: place.name,
            geohash: place.geohash,
            n: hourly.entries.length,
            issue: hourly.issueTime,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    observe: {
      description:
        "Resolve a selector and fetch the latest observed conditions from the " +
        "nearest BOM station — temperature, feels-like, humidity, wind, gust, " +
        "rain since 9am, and today's max/min. Uses the 6-character geohash the " +
        "observations endpoint requires.",
      arguments: ObserveArgsSchema,
      execute: async (args: ObserveArgs, context: MethodContext) => {
        const { place } = await resolvePlace(context, args);
        const apiUrl = context.globalArgs.apiUrl.replace(/\/+$/, "");
        const url = observationsUrl(apiUrl, geohash6(place.geohash));
        const payload = await getJson(context, url) as {
          metadata?: { issue_time?: string; observation_time?: string };
          data?: Record<string, unknown>;
        };
        const fetchedAt = new Date().toISOString();
        const observation = parseObservations(payload, place, fetchedAt, url);
        const handle = await context.writeResource(
          "observation",
          "observation",
          { ...observation },
        );
        context.logger.info(
          "Observed {name} ({geohash}): {temp}°C at {station}, {obsTime}",
          {
            name: place.name,
            geohash: place.geohash,
            temp: observation.temp ?? "n/a",
            station: observation.stationName ?? "unknown station",
            obsTime: observation.observationTime,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    warnings: {
      description:
        "Fetch active warnings — either scoped to the resolved location " +
        "(`scope=location`, the default) or nationally (`scope=national`). " +
        "State filtering is applied client-side because the API ignores query " +
        "filters. With `detail=true`, each warning's full HTML message text is " +
        "fetched too.",
      arguments: WarningsArgsSchema,
      execute: async (args: WarningsArgs, context: MethodContext) => {
        const apiUrl = context.globalArgs.apiUrl.replace(/\/+$/, "");
        const national = args.scope === "national";
        const geohash = national
          ? ""
          : geohash6((await resolvePlace(context, args)).place.geohash);
        const url = national
          ? nationalWarningsUrl(apiUrl)
          : locationWarningsUrl(apiUrl, geohash);
        const body = await getJson(context, url);
        let warnings = ((body.data ?? []) as Record<string, unknown>[])
          .map(parseWarning);

        if (national && args.state.trim()) {
          const before = warnings.length;
          warnings = filterWarningsByState(warnings, args.state);
          context.logger.debug?.(
            "Filtered national warnings by state {state}: {before} → {after}",
            { state: args.state, before, after: warnings.length },
          );
        }

        if (args.detail) {
          warnings = await Promise.all(
            warnings.map(async (w) => {
              try {
                const detailBody = await getJson(
                  context,
                  warningDetailUrl(apiUrl, w.id),
                );
                const detail = (detailBody.data ?? {}) as Record<
                  string,
                  unknown
                >;
                return {
                  ...w,
                  message: (detail.message ?? null) as string | null,
                };
              } catch (error) {
                context.logger.warn?.(
                  "Could not fetch warning detail for {id}: {error}",
                  { id: w.id, error: String(error) },
                );
                return w;
              }
            }),
          );
        }

        const fetchedAt = new Date().toISOString();
        const result = {
          scope: args.scope,
          stateFilter: national && args.state.trim()
            ? args.state.trim().toUpperCase()
            : null,
          fetchedAt,
          sourceUrl: url,
          count: warnings.length,
          warnings,
        };
        const handle = await context.writeResource("warnings", "warnings", {
          ...result,
        });
        context.logger.info(
          "Fetched {n} {scope} warning(s){state}{detail}",
          {
            n: warnings.length,
            scope: args.scope,
            state: result.stateFilter ? ` for ${result.stateFilter}` : "",
            detail: args.detail ? " (with detail)" : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
