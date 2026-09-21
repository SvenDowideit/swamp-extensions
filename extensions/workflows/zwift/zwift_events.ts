/**
 * Zwift events — retrieves races and group events happening in the next N days.
 *
 * Zwift's public event calendar is unauthenticated:
 * `GET /api/public/events/upcoming` returns at most 200 events and cannot be
 * filtered by date server-side (the `event_starts_after` parameter it accepts
 * is silently ignored). A ten-day window is therefore built by fetching the
 * upcoming feed, harvesting the event *series* it references, and fetching each
 * series' own future events — which does honour `event_starts_after` /
 * `event_starts_before`. The union is then filtered locally to the requested
 * horizon.
 *
 * This model is read-only and needs no credentials. It writes a single
 * `schedule` resource containing every event and subgroup in the window, ready
 * for the recommender to score via CEL.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  clamp,
  DURATION_BUCKET_MINUTES,
  estimateDurationSeconds,
  formatDuration,
  parseTimeMs,
} from "./zwift_util.ts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  apiBase: z.string().default("https://us-or-rly101.zwift.com").describe(
    "Zwift REST API base URL",
  ),
  horizonDays: z.number().positive().max(30).default(10).describe(
    "How many days ahead to collect events for",
  ),
  maxSeries: z.number().int().positive().max(60).default(40).describe(
    "Maximum number of event series to expand (each is one extra request)",
  ),
  maxEventsPerSeries: z.number().int().positive().max(200).default(200)
    .describe("Maximum events to request per series"),
  sports: z.array(z.enum(["CYCLING", "RUNNING"])).default(["CYCLING"])
    .describe("Sports to include"),
  eventTypes: z.array(
    z.enum([
      "EVENT_TYPE_RACE",
      "EVENT_TYPE_TIME_TRIAL",
      "EVENT_TYPE_TEAM_TIME_TRIAL",
      "EVENT_TYPE_GROUP_RIDE",
      "EVENT_TYPE_GROUP_WORKOUT",
      "EVENT_TYPE_WORKOUT",
      "EVENT_TYPE_EFONDO",
    ]),
  ).default([
    "EVENT_TYPE_RACE",
    "EVENT_TYPE_TIME_TRIAL",
    "EVENT_TYPE_GROUP_RIDE",
  ]).describe("Event types to include; races and TTs by default"),
  includePrivate: z.boolean().default(false).describe(
    "Include events flagged private/unlisted",
  ),
  referenceSpeedKph: z.number().positive().default(32).describe(
    "Speed used to estimate a duration when Zwift does not publish one",
  ),
  userAgent: z.string().default("swamp-zwift/1.0").describe(
    "User-Agent header sent to the Zwift calendar",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const FetchArgsSchema = z.object({
  horizonDays: z.number().positive().max(30).optional().describe(
    "Override the global horizonDays for this run",
  ),
  eventTypes: z.array(z.string()).optional().describe(
    "Override the global eventTypes for this run",
  ),
  maxSeries: z.number().int().positive().max(60).optional().describe(
    "Override the global maxSeries for this run",
  ),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

/** One race category / pace group inside an event. */
/** One race category / pace group inside an event. */
export interface ZwiftSubgroup {
  /** Zwift subgroup id. */
  id: string;
  /** Category or pace-group label, e.g. `A` or `E`. */
  label: string;
  /** Full subgroup name. */
  name: string;
  /** Zwift pace type (1 = w/kg, 2 = % FTP). */
  paceType: number;
  /** Lower bound of the target pace band. */
  fromPaceValue: number;
  /** Upper bound of the target pace band. */
  toPaceValue: number;
  /** ISO-8601 instant this subgroup starts. */
  startTime: string;
  /** Epoch milliseconds this subgroup starts. */
  startMs: number;
  /** Duration in seconds (estimated when Zwift omits one). */
  durationSeconds: number;
  /** True when `durationSeconds` was estimated from distance. */
  durationEstimated: boolean;
  /** Distance in metres (0 when unknown). */
  distanceMeters: number;
  /** Number of laps, when the event is lap-based. */
  laps: number;
  /** Zwift route id. */
  routeId: number | null;
  /** Zwift map (world) id. */
  mapId: number | null;
  /** Entry cap, when set. */
  fieldLimit: number | null;
  /** Number of riders already entered. */
  entrantCount: number;
  /** Zwift rules applied to this subgroup. */
  rulesSet: string[];
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

const SubgroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  name: z.string(),
  paceType: z.number(),
  fromPaceValue: z.number(),
  toPaceValue: z.number(),
  startTime: z.string(),
  startMs: z.number(),
  durationSeconds: z.number(),
  durationEstimated: z.boolean(),
  distanceMeters: z.number(),
  laps: z.number(),
  routeId: z.number().nullable(),
  mapId: z.number().nullable(),
  fieldLimit: z.number().nullable(),
  entrantCount: z.number(),
  rulesSet: z.array(z.string()),
});

/** One event in the window, with its subgroups. */
export interface ZwiftEvent {
  /** Zwift event id. */
  id: string;
  /** Event title. */
  name: string;
  /** Full event description. */
  description: string;
  /** Raw Zwift type token, e.g. `EVENT_TYPE_RACE`. */
  type: string;
  /** Normalised type token without the `EVENT_TYPE_` prefix. */
  eventType: string;
  /** Sport (`CYCLING` or `RUNNING`). */
  sport: string;
  /** Zwift world id. */
  worldId: number | null;
  /** Zwift map id. */
  mapId: number | null;
  /** Zwift route id. */
  routeId: number | null;
  /** Event distance in metres (0 when unknown). */
  distanceMeters: number;
  /** Event duration in seconds (0 when unknown). */
  durationSeconds: number;
  /** Number of laps, when lap-based. */
  laps: number;
  /** ISO-8601 instant the event starts. */
  startTime: string;
  /** Epoch milliseconds the event starts. */
  startMs: number;
  /** Id of the event series this belongs to, when any. */
  seriesId: number | null;
  /** Name of the event series, when any. */
  seriesName: string;
  /** Whether Zwift marks this event recurring. */
  recurring: boolean;
  /** Whether this is a private event. */
  privateEvent: boolean;
  /** Header image URL. */
  imageUrl: string;
  /** Number of subgroups. */
  subgroupCount: number;
  /** The event's subgroups (categories / pace groups). */
  subgroups: ZwiftSubgroup[];
  /** True for races, time trials and efondos. */
  isRace: boolean;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  eventType: z.string(),
  sport: z.string(),
  worldId: z.number().nullable(),
  mapId: z.number().nullable(),
  routeId: z.number().nullable(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  laps: z.number(),
  startTime: z.string(),
  startMs: z.number(),
  seriesId: z.number().nullable(),
  seriesName: z.string(),
  recurring: z.boolean(),
  privateEvent: z.boolean(),
  imageUrl: z.string(),
  subgroupCount: z.number(),
  subgroups: z.array(SubgroupSchema),
  isRace: z.boolean(),
});

/** The whole upcoming-window snapshot the recommender consumes. */
const ScheduleSchema = z.object({
  fetchedAt: z.string(),
  horizonDays: z.number(),
  windowStart: z.string(),
  windowEnd: z.string(),
  eventCount: z.number(),
  raceCount: z.number(),
  seriesExpanded: z.number(),
  sourceNote: z.string(),
  events: z.array(EventSchema),
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Zwift's event `type` sometimes carries a `EVENT_TYPE_` prefix and sometimes
 * not, and the calendar page reads a separate `eventType` field. Normalise both
 * onto one token so filtering is predictable.
 */
export function normalizeEventType(raw: Record<string, unknown>): string {
  const value = [
    raw.eventType,
    raw.type,
  ].find((v) => typeof v === "string" && v.trim() !== "") as
    | string
    | undefined;
  if (!value) return "UNKNOWN";
  return value.toUpperCase().replace(/^EVENT_TYPE_/, "");
}

/** True when an event type token represents competitive racing. */
export function isRaceType(eventType: string): boolean {
  return eventType === "RACE" || eventType.includes("TIME_TRIAL") ||
    eventType === "EFONDO";
}

function num(record: Record<string, unknown>, key: string): number {
  const v = record[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return 0;
}

function str(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v : "";
}

function bool(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function nestedNum(
  record: Record<string, unknown>,
  key: string,
  child: string,
): number | null {
  const parent = record[key];
  if (!parent || typeof parent !== "object") return null;
  const value = (parent as Record<string, unknown>)[child];
  return typeof value === "number" ? value : null;
}

function nestedStr(
  record: Record<string, unknown>,
  key: string,
  child: string,
): string {
  const parent = record[key];
  if (!parent || typeof parent !== "object") return "";
  const value = (parent as Record<string, unknown>)[child];
  return typeof value === "string" ? value : "";
}

/** Parse a raw Zwift event + subgroup into {@link EventSchema}. */
export function normalizeEvent(
  raw: Record<string, unknown>,
  referenceSpeedKph: number,
): ZwiftEvent | null {
  const id = str(raw, "id") || String(num(raw, "id"));
  const startMs = parseTimeMs(
    raw.eventStart ?? raw.startTime ?? raw.eventSubgroupStart,
  );
  if (!id || startMs === null) return null;

  const rawSubgroups = Array.isArray(raw.eventSubgroups)
    ? raw.eventSubgroups as Record<string, unknown>[]
    : [];

  const eventType = normalizeEventType(raw);
  const eventDistance = num(raw, "distanceInMeters");
  const eventDuration = num(raw, "durationInSeconds");

  const subgroups = rawSubgroups.map((sg) => {
    const sgStartMs = parseTimeMs(sg.eventSubgroupStart) ?? startMs;
    const sgDistance = num(sg, "distanceInMeters") || eventDistance;
    const rawDuration = num(sg, "durationInSeconds") || eventDuration;
    const estimated = rawDuration <= 0 && sgDistance > 0;
    return {
      id: String(sg.id ?? ""),
      label: str(sg, "subgroupLabel") || str(sg, "label"),
      name: str(sg, "name"),
      paceType: num(sg, "paceType"),
      fromPaceValue: num(sg, "fromPaceValue"),
      toPaceValue: num(sg, "toPaceValue"),
      startTime: new Date(sgStartMs).toISOString(),
      startMs: sgStartMs,
      durationSeconds: rawDuration > 0
        ? rawDuration
        : estimateDurationSeconds(sgDistance, referenceSpeedKph),
      durationEstimated: estimated,
      distanceMeters: sgDistance,
      laps: num(sg, "laps"),
      routeId: nestedNum(sg, "routeId", "id") ??
        (sg.routeId ? num(sg, "routeId") : null),
      mapId: sg.mapId ? num(sg, "mapId") : null,
      fieldLimit: sg.fieldLimit ? num(sg, "fieldLimit") : null,
      entrantCount: num(sg, "totalEntrantCount"),
      rulesSet: Array.isArray(sg.rulesSet)
        ? (sg.rulesSet as unknown[]).filter((r): r is string =>
          typeof r === "string"
        )
        : [],
    };
  });

  return {
    id,
    name: str(raw, "name") || "Event",
    description: str(raw, "description"),
    type: str(raw, "type"),
    eventType,
    sport: (str(raw, "sport") || "CYCLING").toUpperCase(),
    worldId: raw.worldId ? num(raw, "worldId") : null,
    mapId: raw.mapId ? num(raw, "mapId") : null,
    routeId: raw.routeId ? num(raw, "routeId") : null,
    distanceMeters: eventDistance,
    durationSeconds: eventDuration,
    laps: num(raw, "laps"),
    startTime: new Date(startMs).toISOString(),
    startMs,
    seriesId: raw.eventSeries ? nestedNum(raw, "eventSeries", "id") : null,
    seriesName: nestedStr(raw, "eventSeries", "name"),
    recurring: bool(raw, "recurring"),
    privateEvent: bool(raw, "privateEvent"),
    imageUrl: nestedStr(raw, "imageUrl", "url") || str(raw, "imageUrl"),
    subgroupCount: subgroups.length,
    subgroups,
    isRace: isRaceType(eventType),
  };
}

// ---------------------------------------------------------------------------
// API access (unauthenticated)
// ---------------------------------------------------------------------------

/** Fetch JSON with the shared user-agent; throws on a non-2xx response. */
async function fetchJson(
  url: string,
  userAgent: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": userAgent },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed (HTTP ${res.status})`);
  }
  return await res.json();
}

function asArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const events = (payload as Record<string, unknown>).events;
    if (Array.isArray(events)) return events as Record<string, unknown>[];
  }
  return [];
}

/**
 * Collect events for the next `horizonDays`.
 *
 * Two passes, because the public feed is capped at 200 and cannot be date
 * filtered: (1) the upcoming feed, which is live but shallow; (2) each series
 * it mentions, which reaches further ahead and *does* honour a date range.
 * Results are de-duplicated by event id.
 */
export async function collectEvents(
  cfg: {
    apiBase: string;
    horizonDays: number;
    maxSeries: number;
    maxEventsPerSeries: number;
    userAgent: string;
    sports: string[];
    eventTypes: string[];
    includePrivate: boolean;
    referenceSpeedKph: number;
  },
  nowMs: number,
  fetchImpl: typeof fetch,
  log: (msg: string, props?: Record<string, unknown>) => void,
): Promise<ZwiftEvent[]> {
  const horizonMs = nowMs + cfg.horizonDays * 86_400_000;
  const seen = new Map<string, ZwiftEvent>();
  const seriesIds = new Map<number, string>();

  const accept = (raw: Record<string, unknown>): boolean => {
    const type = normalizeEventType(raw);
    if (
      !cfg.eventTypes.includes(type) &&
      !cfg.eventTypes.includes(`EVENT_TYPE_${type}`)
    ) {
      return false;
    }
    const sport = (str(raw, "sport") || "CYCLING").toUpperCase();
    if (cfg.sports.length > 0 && !cfg.sports.includes(sport)) return false;
    if (
      !cfg.includePrivate &&
      (bool(raw, "privateEvent") || bool(raw, "unlisted"))
    ) {
      return false;
    }
    return true;
  };

  const consider = (raw: Record<string, unknown>): void => {
    if (!accept(raw)) return;
    const event = normalizeEvent(raw, cfg.referenceSpeedKph);
    if (!event) return;
    if (event.startMs < nowMs - 60_000 || event.startMs > horizonMs) return;
    seen.set(event.id, event);
    const series = raw.eventSeries as Record<string, unknown> | undefined;
    if (series && typeof series.id === "number") {
      seriesIds.set(series.id, str(series, "name"));
    }
  };

  const upcoming = await fetchJson(
    `${cfg.apiBase}/api/public/events/upcoming?limit=200`,
    cfg.userAgent,
    fetchImpl,
  );
  const upcomingList = asArray(upcoming);
  for (const raw of upcomingList) consider(raw);
  log("Upcoming feed contributed {n} matching events", {
    n: seen.size,
  });

  const seriesToExpand = [...seriesIds.entries()].slice(0, cfg.maxSeries);
  for (const [seriesId, seriesName] of seriesToExpand) {
    try {
      const payload = await fetchJson(
        `${cfg.apiBase}/api/public/eventseries/${seriesId}/events` +
          `?limit=${cfg.maxEventsPerSeries}` +
          `&event_starts_after=${nowMs}&event_starts_before=${horizonMs}`,
        cfg.userAgent,
        fetchImpl,
      );
      for (const raw of asArray(payload)) consider(raw);
    } catch (err) {
      log("Series {id} ({name}) unavailable: {err}", {
        id: seriesId,
        name: seriesName,
        err: (err as Error).message,
      });
    }
  }

  return [...seen.values()].sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Method context typing
// ---------------------------------------------------------------------------

type Logger = {
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
};

type EventsContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

const FetchArgsSchemaFinal = FetchArgsSchema;

/** The `@svendowideit/zwift-events` model definition. */
export const model = {
  type: "@svendowideit/zwift-events",
  version: "2026.09.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    schedule: {
      description:
        "Every event + subgroup in the requested horizon, ready for scoring",
      schema: ScheduleSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "fetch": {
      description:
        "Collect races and group events in the next horizonDays, expanding " +
        "the event series referenced by the public feed.",
      arguments: FetchArgsSchemaFinal,
      execute: async (
        args: z.infer<typeof FetchArgsSchemaFinal>,
        ctx: EventsContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();
        const horizonDays = args.horizonDays ?? g.horizonDays;
        const eventTypes = (args.eventTypes && args.eventTypes.length > 0)
          ? args.eventTypes
          : g.eventTypes;
        const maxSeries = args.maxSeries ?? g.maxSeries;

        const events = await collectEvents(
          {
            apiBase: g.apiBase,
            horizonDays,
            maxSeries,
            maxEventsPerSeries: g.maxEventsPerSeries,
            userAgent: g.userAgent,
            sports: g.sports,
            eventTypes,
            includePrivate: g.includePrivate,
            referenceSpeedKph: g.referenceSpeedKph,
          },
          nowMs,
          fetch,
          (msg, props) => ctx.logger.info(msg, props ?? {}),
        );

        const raceCount = events.filter((e) => e.isRace).length;
        const schedule = {
          fetchedAt: new Date(nowMs).toISOString(),
          horizonDays,
          windowStart: new Date(nowMs).toISOString(),
          windowEnd: new Date(nowMs + horizonDays * 86_400_000).toISOString(),
          eventCount: events.length,
          raceCount,
          seriesExpanded: Math.min(g.maxSeries, events.length),
          sourceNote:
            "Public calendar (unauth) + per-series expansion; the public feed " +
            "is capped at 200 and ignores date filters.",
          events,
        };
        const handle = await ctx.writeResource(
          "schedule",
          "upcoming",
          schedule,
        );
        ctx.logger.info(
          "Fetched {n} events ({races} races) over {days} days, " +
            "first starts {first}",
          {
            n: events.length,
            races: raceCount,
            days: horizonDays,
            first: events[0]
              ? `${events[0].name} ${events[0].startTime}`
              : "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

// Re-exported so tests can exercise bucketing without the API.
export { clamp, DURATION_BUCKET_MINUTES, formatDuration };
