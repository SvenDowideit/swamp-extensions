/**
 * Zwift recommender — ranks upcoming events against the rider's own history.
 *
 * It consumes three inputs, all wired by the workflow with CEL expressions so
 * it never reaches into another model's storage directly:
 *  - `ability`  ← `@svendowideit/zwift-rider` `ability/current`
 *  - `recentRides` ← `@svendowideit/zwift-rider` `history/current`
 *  - `schedule` ← `@svendowideit/zwift-events` `schedule/upcoming`
 *
 * The ranking is a transparent weighted score per event subgroup:
 *
 *  - **ability fit** — does the subgroup's pace category / w-kg band suit the
 *    rider, and is the event short/hard enough to be achievable?
 *  - **recency-decayed habit fit** — how closely the start hour and duration
 *    match the *weighted* distribution of when and how long the rider actually
 *    rides. `history` rows already carry a `decayWeight`, so the recommendation
 *    tracks current form, not a years-old average.
 *  - **freshness / repeat penalty** — events (or routes) the rider has recently
 *    done score lower, so the list stays interesting.
 *  - **availability** — a bonus when the start time falls inside the rider's own
 *    active hours, and a blunt night-time penalty so a rider who never rides at
 *    3am is not recommended one.
 *  - **type affinity** — a `raceBias` dial preferring races or group rides.
 *
 * Every component is emitted per recommendation, so a pick can be audited
 * rather than merely trusted.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  clamp,
  DURATION_BUCKET_MINUTES,
  histogramAffinity,
  localParts,
} from "./zwift_util.ts";
import type { LocalParts } from "./zwift_util.ts";

export type { LocalParts };

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  timezone: z.string().default("").describe(
    "IANA timezone used to bucket event start times into local hours. Should " +
      "match the rider model's timezone. Empty uses host local time.",
  ),
  topN: z.number().int().positive().max(100).default(12).describe(
    "How many recommendations to return",
  ),
  horizonDays: z.number().positive().max(30).default(10).describe(
    "Only consider events starting within this many days",
  ),
  raceBias: z.number().min(0).max(1).default(0.6).describe(
    "Preference for racing over group rides: 0.5 is neutral, 1 strongly " +
      "prefers races, 0 strongly prefers group rides.",
  ),
  hourTolerance: z.number().positive().default(2).describe(
    "Tolerance, in hours, when matching an event start to the rider's hour " +
      "histogram",
  ),
  durationTolerance: z.number().positive().default(2).describe(
    "Tolerance, in duration buckets, when matching event length to the " +
      "rider's duration histogram",
  ),
  repeatWindowDays: z.number().positive().default(14).describe(
    "A route or event repeated within this many days incurs the repeat penalty",
  ),
  repeatPenalty: z.number().min(0).max(1).default(0.35).describe(
    "Score multiplier applied to recently repeated routes/events",
  ),
  maxPerSeries: z.number().int().positive().default(2).describe(
    "Diversity cap: at most this many recommendations from the same event " +
      "series or recurring event name. Surplus capacity is filled by score, so " +
      "a busy calendar still returns a full list.",
  ),
  weights: z.object({
    ability: z.number().min(0).default(0.35),
    timing: z.number().min(0).default(0.3),
    duration: z.number().min(0).default(0.2),
    freshness: z.number().min(0).default(0.1),
    availability: z.number().min(0).default(0.05),
  }).default({
    ability: 0.35,
    timing: 0.3,
    duration: 0.2,
    freshness: 0.1,
    availability: 0.05,
  }).describe("Relative weights of each score component"),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const RecentRideSchema = z.object({
  startMs: z.number(),
  localHour: z.number(),
  durationMinutes: z.number(),
  eventId: z.number().nullable().optional(),
  routeId: z.number().nullable().optional(),
  worldId: z.number().nullable().optional(),
  sport: z.string().optional(),
  decayWeight: z.number().optional(),
});

const RecommendArgsSchema = z.object({
  ability: z.record(z.string(), z.unknown()).describe(
    "The rider's ability/habit profile, e.g. " +
      '${{ data.latest("zwift-rider", "current").attributes }}',
  ),
  schedule: z.record(z.string(), z.unknown()).describe(
    "The upcoming event schedule, e.g. " +
      '${{ data.latest("zwift-events", "upcoming").attributes }}',
  ),
  recentRides: z.array(RecentRideSchema).default([]).describe(
    "The rider's recent rides, e.g. " +
      '${{ data.latest("zwift-rider", "history").attributes.rides }}',
  ),
  topN: z.number().int().positive().max(100).optional().describe(
    "Override the global topN for this run",
  ),
  horizonDays: z.number().positive().max(30).optional().describe(
    "Override the global horizonDays for this run",
  ),
  includeGroupRides: z.boolean().default(true).describe(
    "When false, only races and time trials are recommended",
  ),
  explain: z.boolean().default(true).describe(
    "Include a human-readable reason string for each recommendation",
  ),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

/** A single scored, ranked recommendation. */
export interface Recommendation {
  /** 1-based rank within the returned set. */
  rank: number;
  /** Zwift event id. */
  eventId: string;
  /** Zwift subgroup id. */
  subgroupId: string;
  /** Event title. */
  eventName: string;
  /** Event series name, when any. */
  seriesName: string;
  /** Category or pace-group label. */
  subgroupLabel: string;
  /** Normalised event type token. */
  eventType: string;
  /** True for races, time trials and efondos. */
  isRace: boolean;
  /** ISO-8601 instant the subgroup starts. */
  startTime: string;
  /** Epoch milliseconds the subgroup starts. */
  startMs: number;
  /** Local start hour in the configured timezone. */
  localHour: number;
  /** Local start minute. */
  localMinute: number;
  /** Local start date, `YYYY-MM-DD`. */
  localDate: string;
  /** Local ISO weekday, 1 (Monday) - 7 (Sunday). */
  isoDayOfWeek: number;
  /** Minutes from now until the start. */
  minutesUntilStart: number;
  /** Estimated duration in seconds. */
  durationSeconds: number;
  /** True when the duration was estimated rather than published. */
  durationEstimated: boolean;
  /** Distance in metres. */
  distanceMeters: number;
  /** Final weighted score (higher is a better fit). */
  score: number;
  /** The individual score components, each in `[0, 1]`. */
  components: {
    /** Ability fit. */
    ability: number;
    /** Habit-based timing fit. */
    timing: number;
    /** Habit-based duration fit. */
    duration: number;
    /** Route/event freshness (1 = never done recently). */
    freshness: number;
    /** Availability at that local hour. */
    availability: number;
    /** Race-vs-ride preference dial value. */
    typeAffinity: number;
  };
  /** Human-readable explanation of the score. */
  reason: string;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

const RecommendationSchema = z.object({
  rank: z.number(),
  eventId: z.string(),
  subgroupId: z.string(),
  eventName: z.string(),
  seriesName: z.string(),
  subgroupLabel: z.string(),
  eventType: z.string(),
  isRace: z.boolean(),
  startTime: z.string(),
  startMs: z.number(),
  localHour: z.number(),
  localMinute: z.number(),
  localDate: z.string(),
  isoDayOfWeek: z.number(),
  minutesUntilStart: z.number(),
  durationSeconds: z.number(),
  durationEstimated: z.boolean(),
  distanceMeters: z.number(),
  score: z.number(),
  components: z.object({
    ability: z.number(),
    timing: z.number(),
    duration: z.number(),
    freshness: z.number(),
    availability: z.number(),
    typeAffinity: z.number(),
  }),
  reason: z.string(),
});

/** The full ranked set, plus the profile context it was scored against. */
const RecommendationsSchema = z.object({
  generatedAt: z.string(),
  timeZone: z.string(),
  abilityScore: z.number(),
  categoryBand: z.string(),
  wPerKg: z.number().nullable(),
  preferredHours: z.array(z.number()),
  typicalDurationMinutes: z.number().nullable(),
  candidateEvents: z.number(),
  candidatesScored: z.number(),
  recommendations: z.array(RecommendationSchema),
});

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** The rider profile fields the recommender reads (all optional). */
export interface AbilityRecord {
  /** Ability mapped onto 0-100. */
  abilityScore?: number;
  /** Zwift-style category band (A-E). */
  categoryBand?: string;
  /** FTP per kilogram. */
  wPerKg?: number | null;
  /** Decay-weighted typical duration, in minutes. */
  typicalDurationMinutes?: number | null;
  /** Mean average speed, in km/h. */
  typicalAvgSpeedKph?: number | null;
  /** Decay-weighted hour-of-day distribution (24 values). */
  hourHistogram?: number[];
  /** Decay-weighted duration distribution. */
  durationHistogram?: number[];
  /** Width of each duration bucket, in minutes. */
  durationBucketMinutes?: number;
  /** The rider's most common local start hours. */
  preferredHours?: number[];
  /** Timezone the histograms were bucketed in. */
  timeZone?: string;
}

/** One historical ride, as supplied by the rider model's `history` resource. */
export interface RecentRide {
  /** Epoch milliseconds the ride started. */
  startMs: number;
  /** Local hour the ride started. */
  localHour: number;
  /** Ride duration in minutes. */
  durationMinutes: number;
  /** Zwift event id, when the ride was an event. */
  eventId?: number | null;
  /** Zwift route id, used for the repeat penalty. */
  routeId?: number | null;
  /** Zwift world id. */
  worldId?: number | null;
  /** Sport (`CYCLING` or `RUNNING`). */
  sport?: string;
  /** Recency-decayed weight, when the rider model supplied one. */
  decayWeight?: number;
}

/** One event subgroup (category or pace group) from the event schedule. */
export interface ScheduleSubgroup {
  /** Zwift subgroup id. */
  id?: string;
  /** Category or pace-group label, e.g. `A`. */
  label?: string;
  /** Full subgroup name. */
  name?: string;
  /** Zwift pace type (1 = w/kg, 2 = % FTP). */
  paceType?: number;
  /** Lower bound of the target pace band, in w/kg. */
  fromPaceValue?: number;
  /** Upper bound of the target pace band, in w/kg. */
  toPaceValue?: number;
  /** Epoch milliseconds the subgroup starts. */
  startMs?: number;
  /** Duration in seconds (estimated when unknown). */
  durationSeconds?: number;
  /** True when the duration was estimated from distance. */
  durationEstimated?: boolean;
  /** Distance in metres. */
  distanceMeters?: number;
  /** Zwift route id for this subgroup. */
  routeId?: number | null;
}

/** One event from the event schedule. */
export interface ScheduleEvent {
  /** Zwift event id. */
  id?: string;
  /** Event title. */
  name?: string;
  /** Id of the event series, when any. */
  seriesId?: number | null;
  /** Name of the event series, when any. */
  seriesName?: string;
  /** Normalised event type token, e.g. `RACE` or `GROUP_RIDE`. */
  eventType?: string;
  /** True for races, time trials and efondos. */
  isRace?: boolean;
  /** Epoch milliseconds the event starts. */
  startMs?: number;
  /** Event duration in seconds. */
  durationSeconds?: number;
  /** Event distance in metres. */
  distanceMeters?: number;
  /** Zwift route id. */
  routeId?: number | null;
  /** The event's subgroups. */
  subgroups?: ScheduleSubgroup[];
}

/** The tuning values {@link scoreCandidate} reads from the model's globals. */
export interface RecommenderConfig {
  /** Race-vs-ride preference: 0.5 neutral, 1 prefers races, 0 prefers rides. */
  raceBias: number;
  /** Hours of slack when matching an event start to the habit histogram. */
  hourTolerance: number;
  /** Buckets of slack when matching event length to the habit histogram. */
  durationTolerance: number;
  /** Repeat-penalty look-back window, in days. */
  repeatWindowDays: number;
  /** Multiplier applied to recently repeated routes/events. */
  repeatPenalty: number;
  /** Relative weights of the score components. */
  weights: {
    /** Weight of the ability component. */
    ability: number;
    /** Weight of the timing component. */
    timing: number;
    /** Weight of the duration component. */
    duration: number;
    /** Weight of the freshness component. */
    freshness: number;
    /** Weight of the availability component. */
    availability: number;
  };
}

/**
 * Infer the ability band a subgroup targets.
 *
 * For races Zwift assigns A–E category labels (A hardest) — but for group rides
 * the same letters mean *pace group*, so the label is only used for races. For
 * everything else the pace is carried as `fromPaceValue`/`toPaceValue` in w/kg.
 * Both land on the same 0-100 scale so one comparison works for everything.
 */
export function subgroupAbilityScore(
  sg: ScheduleSubgroup,
  isRace = false,
): number | null {
  const label = (sg.label ?? "").trim().toUpperCase();
  const bandScore: Record<string, number> = {
    A: 88,
    B: 74,
    C: 58,
    D: 42,
    E: 26,
  };
  if (isRace && label in bandScore) return bandScore[label];

  const from = typeof sg.fromPaceValue === "number" ? sg.fromPaceValue : 0;
  const to = typeof sg.toPaceValue === "number" ? sg.toPaceValue : 0;
  // A band (e.g. 1-5 w/kg) is too wide to be a target; take its midpoint only
  // when it is narrow, otherwise use the lower bound — the entry bar.
  const wide = to > 0 && from > 0 && to - from > 2;
  const pace = wide
    ? from
    : (to > 0 && from > 0 ? (from + to) / 2 : Math.max(from, to));
  if (pace > 0) {
    // Same 1.5-5.0 w/kg → 0-100 mapping the rider model uses.
    return clamp(((pace - 1.5) / 3.5) * 100, 0, 100);
  }
  return null;
}

/**
 * Score how well a subgroup's target ability matches the rider.
 *
 * Slightly under-qualified is penalised less than wildly over-qualified,
 * because entering a marginally harder race is a normal way to improve.
 */
export function abilityFit(
  riderAbility: number,
  targetAbility: number | null,
): number {
  if (targetAbility === null) return 0.5; // unknown target → neutral
  const delta = targetAbility - riderAbility;
  const overQualified = Math.max(0, -delta); // rider is much stronger
  const underQualified = Math.max(0, delta); // race is much harder
  const score = 1 -
    (underQualified / 45) * 0.6 -
    (overQualified / 45) * 0.4;
  return clamp(score, 0, 1);
}

/** Availability bonus: reward starts inside the rider's active hours. */
export function availabilityFit(histogram: number[], hour: number): number {
  // A blunt night-time penalty independent of habit, so a rider who has never
  // ridden at 3am does not accidentally get 3am recommendations.
  const nightPenalty = hour >= 1 && hour <= 4 ? 0.25 : 1;
  const habit = histogram.length === 24 ? histogram[hour] : 0;
  return clamp(0.5 + habit * 2, 0, 1) * nightPenalty;
}

/** Stable key identifying a "repeatable" ride: route preferred, else event. */
export function repeatKey(ride: {
  routeId?: number | null;
  eventId?: number | null;
}): string {
  if (typeof ride.routeId === "number" && ride.routeId > 0) {
    return `route:${ride.routeId}`;
  }
  if (typeof ride.eventId === "number" && ride.eventId > 0) {
    return `event:${ride.eventId}`;
  }
  return "";
}

/**
 * Freshness in `[0, 1]`: 1 when the rider has not done this route/event
 * recently, `repeatPenalty` when they have. Recency is decayed so a repeat two
 * weeks ago hurts less than one yesterday.
 */
export function freshnessScore(
  key: string,
  recentKeys: Map<string, number>,
  nowMs: number,
  windowDays: number,
  penalty: number,
): number {
  if (!key || !recentKeys.has(key)) return 1;
  const lastMs = recentKeys.get(key) ?? 0;
  const daysAgo = (nowMs - lastMs) / 86_400_000;
  if (daysAgo > windowDays) return 1;
  const recency = clamp(1 - daysAgo / windowDays, 0, 1);
  return clamp(1 - (1 - penalty) * recency, penalty, 1);
}

/** Build a `repeatKey → most recent ride start` map. */
export function recentKeyMap(
  rides: RecentRide[],
  nowMs: number,
  windowDays: number,
): Map<string, number> {
  const cutoff = nowMs - windowDays * 86_400_000;
  const map = new Map<string, number>();
  for (const ride of rides) {
    if (typeof ride.startMs !== "number" || ride.startMs < cutoff) continue;
    const key = repeatKey(ride);
    if (!key) continue;
    const previous = map.get(key);
    if (previous === undefined || ride.startMs > previous) {
      map.set(key, ride.startMs);
    }
  }
  return map;
}

/** Coerce an unknown into an array of numbers, dropping non-numbers. */
function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number");
}

/** Build the weighted components and total score for one subgroup. */
export function scoreCandidate(opts: {
  ability: AbilityRecord;
  event: ScheduleEvent;
  subgroup: ScheduleSubgroup;
  local: LocalParts;
  nowMs: number;
  cfg: RecommenderConfig;
  includeGroupRides: boolean;
  recentKeys: Map<string, number>;
}): Recommendation | null {
  const { ability, event, subgroup, local, nowMs, cfg } = opts;
  const startMs = subgroup.startMs ?? event.startMs ?? 0;
  if (!startMs || startMs < nowMs - 60_000) return null;

  const isRace = event.isRace === true ||
    (event.eventType ?? "").includes("RACE") ||
    (event.eventType ?? "").includes("TIME_TRIAL");
  if (!isRace && !opts.includeGroupRides) return null;

  const riderAbility = typeof ability.abilityScore === "number"
    ? ability.abilityScore
    : 50;
  const hourHist = numberArray(ability.hourHistogram);
  const durationHist = numberArray(ability.durationHistogram);
  const bucketMinutes = typeof ability.durationBucketMinutes === "number"
    ? ability.durationBucketMinutes
    : DURATION_BUCKET_MINUTES;

  const targetAbility = subgroupAbilityScore(subgroup, isRace);
  const abilityComponent = abilityFit(riderAbility, targetAbility);

  const hour = local.hour;
  // One bucket per hour for the timing histogram.
  const timingComponent = histogramAffinity(
    hourHist,
    hour,
    1,
    cfg.hourTolerance,
  );

  const durationMinutes = (subgroup.durationSeconds ?? 0) / 60;
  const durationComponent = durationHist.length > 0 && durationMinutes > 0
    ? histogramAffinity(
      durationHist,
      durationMinutes,
      bucketMinutes,
      cfg.durationTolerance,
    )
    : 0.5;

  const key = repeatKey({
    routeId: (subgroup.routeId ?? event.routeId) as number | null | undefined ??
      null,
    eventId: Number(event.id) || null,
  });
  const freshnessComponent = freshnessScore(
    key,
    opts.recentKeys,
    nowMs,
    cfg.repeatWindowDays,
    cfg.repeatPenalty,
  );

  const availabilityComponent = availabilityFit(hourHist, hour);

  // raceBias is a preference dial, not a filter: at 0.5 races and rides score
  // the same, and the extremes strongly prefer one or the other.
  const typeAffinity = clamp(
    isRace ? 0.5 + cfg.raceBias / 2 : 1 - cfg.raceBias / 2,
    0,
    1,
  );

  const w = cfg.weights;
  const weightSum = w.ability + w.timing + w.duration + w.freshness +
    w.availability;
  const score = weightSum <= 0 ? 0 : (abilityComponent * w.ability +
    timingComponent * w.timing +
    durationComponent * w.duration +
    freshnessComponent * w.freshness +
    availabilityComponent * w.availability) / weightSum;

  const finalScore = Math.round(score * typeAffinity * 1000) / 10;

  const hhmm = `${String(local.hour).padStart(2, "0")}:` +
    `${String(local.minute).padStart(2, "0")}`;
  const reason = [
    `${isRace ? "Race" : "Ride"} ${event.name}` +
    (subgroup.label ? ` (${subgroup.label})` : ""),
    `starts ${local.date} ${hhmm}`,
    `ability ${(abilityComponent * 100).toFixed(0)}%` +
    (targetAbility !== null
      ? ` (target ${targetAbility.toFixed(0)} vs rider ${
        riderAbility.toFixed(0)
      })`
      : " (target unknown)"),
    `timing ${(timingComponent * 100).toFixed(0)}%`,
    `duration ${(durationComponent * 100).toFixed(0)}%`,
    freshnessComponent < 1
      ? `repeated recently (${(freshnessComponent * 100).toFixed(0)}%)`
      : "fresh",
  ].join("; ");

  return {
    rank: 0,
    eventId: event.id ?? "",
    subgroupId: subgroup.id ?? "",
    eventName: event.name ?? "Event",
    seriesName: event.seriesName ?? "",
    subgroupLabel: subgroup.label ?? "",
    eventType: event.eventType ?? "",
    isRace,
    startTime: new Date(startMs).toISOString(),
    startMs,
    localHour: local.hour,
    localMinute: local.minute,
    localDate: local.date,
    isoDayOfWeek: local.isoDayOfWeek,
    minutesUntilStart: Math.round((startMs - nowMs) / 60_000),
    durationSeconds: subgroup.durationSeconds ?? 0,
    durationEstimated: subgroup.durationEstimated === true,
    distanceMeters: subgroup.distanceMeters ?? 0,
    score: finalScore,
    components: {
      ability: Math.round(abilityComponent * 1000) / 1000,
      timing: Math.round(timingComponent * 1000) / 1000,
      duration: Math.round(durationComponent * 1000) / 1000,
      freshness: Math.round(freshnessComponent * 1000) / 1000,
      availability: Math.round(availabilityComponent * 1000) / 1000,
      typeAffinity: Math.round(typeAffinity * 1000) / 1000,
    },
    reason,
  };
}

// ---------------------------------------------------------------------------
// Method context typing
// ---------------------------------------------------------------------------

type Logger = {
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
};

type RecommenderContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** The `@svendowideit/zwift-recommender` model definition. */
export const model = {
  type: "@svendowideit/zwift-recommender",
  version: "2026.09.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    recommendations: {
      description:
        "Ranked events for this rider, with per-component scores and reasons",
      schema: RecommendationsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "recommend": {
      description:
        "Rank the upcoming event schedule against the rider's decayed " +
        "ability and habit profile.",
      arguments: RecommendArgsSchema,
      execute: async (
        args: z.infer<typeof RecommendArgsSchema>,
        ctx: RecommenderContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();
        const ability = args.ability as AbilityRecord;
        const schedule = args.schedule as { events?: ScheduleEvent[] };
        const events = Array.isArray(schedule.events) ? schedule.events : [];
        const recentKeys = recentKeyMap(
          args.recentRides,
          nowMs,
          g.repeatWindowDays,
        );

        if (events.length === 0) {
          throw new Error(
            "The supplied schedule contains no events. Run the events " +
              "workflow first, or widen its horizonDays.",
          );
        }

        const horizonDays = args.horizonDays ?? g.horizonDays;
        const horizonMs = nowMs + horizonDays * 86_400_000;
        const tz = g.timezone || ability.timeZone || "";

        let candidatesScored = 0;
        const scored: Recommendation[] = [];
        for (const event of events) {
          const subgroups = Array.isArray(event.subgroups)
            ? event.subgroups
            : [];
          for (const subgroup of subgroups) {
            const startMs = subgroup.startMs ?? event.startMs ?? 0;
            if (!startMs || startMs < nowMs - 60_000 || startMs > horizonMs) {
              continue;
            }
            const local = localParts(startMs, tz);
            const rec = scoreCandidate({
              ability,
              event,
              subgroup,
              local,
              nowMs,
              cfg: g,
              includeGroupRides: args.includeGroupRides,
              recentKeys,
            });
            if (!rec) continue;
            candidatesScored++;
            scored.push(rec);
          }
        }

        scored.sort((a, b) => b.score - a.score);
        const topN = args.topN ?? g.topN;
        // Diversity: cap how many picks share a series/recurring name, then
        // fill remaining slots by score so a full list is still returned.
        const groupKey = (r: z.infer<typeof RecommendationSchema>): string =>
          r.seriesName.trim() !== ""
            ? `series:${r.seriesName}`
            : `event:${r.eventName}`;
        const perGroup = new Map<string, number>();
        const picked: Recommendation[] = [];
        const deferred: Recommendation[] = [];
        for (const rec of scored) {
          const key = groupKey(rec);
          const count = perGroup.get(key) ?? 0;
          if (count < g.maxPerSeries) {
            perGroup.set(key, count + 1);
            picked.push(rec);
          } else {
            deferred.push(rec);
          }
          if (picked.length >= topN) break;
        }
        for (const rec of deferred) {
          if (picked.length >= topN) break;
          picked.push(rec);
        }
        const recommendations = picked.slice(0, topN).map((r, i) => ({
          ...r,
          rank: i + 1,
          reason: args.explain ? r.reason : "",
        }));

        const output = {
          generatedAt: new Date(nowMs).toISOString(),
          timeZone: tz || "system",
          abilityScore: typeof ability.abilityScore === "number"
            ? ability.abilityScore
            : 0,
          categoryBand: ability.categoryBand ?? "unknown",
          wPerKg: ability.wPerKg ?? null,
          preferredHours: numberArray(ability.preferredHours),
          typicalDurationMinutes: ability.typicalDurationMinutes ?? null,
          candidateEvents: events.length,
          candidatesScored,
          recommendations,
        };
        const handle = await ctx.writeResource(
          "recommendations",
          "current",
          output,
        );
        ctx.logger.info(
          "Scored {scored} subgroups from {events} events; top pick: {top}",
          {
            scored: candidatesScored,
            events: events.length,
            top: recommendations[0]
              ? `${recommendations[0].eventName} (${recommendations[0].score})`
              : "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
