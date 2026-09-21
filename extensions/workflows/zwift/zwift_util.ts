/**
 * Pure helpers shared by the `@svendowideit/zwift` models.
 *
 * Everything here is side-effect free and network free, so it is unit-testable
 * without a Zwift account. The three models (`zwift-rider`, `zwift-events`,
 * `zwift-recommender`) all depend on these for date parsing, local-time
 * bucketing, and decay weighting.
 *
 * @module
 */

/** Number of buckets in the hour-of-day histogram (one per hour). */
export const HOURS_PER_DAY = 24;

/** Width of one duration bucket, in minutes. */
export const DURATION_BUCKET_MINUTES = 30;

/** Number of duration buckets (0..4h+, the last bucket is open-ended). */
export const DURATION_BUCKETS = 9;

/** Epoch-ms for a date-like value, or `null` when it cannot be parsed. */
export function parseTimeMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Zwift mixes epoch seconds and epoch milliseconds across endpoints.
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d+$/.test(trimmed)) return parseTimeMs(Number(trimmed));
    // Zwift writes offsets without minutes ("+00"), which Date rejects.
    const repaired = trimmed.replace(/([+-]\d{2})$/, "$1:00");
    const ms = Date.parse(repaired);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Local calendar fields for an instant in a given IANA timezone. */
export interface LocalParts {
  /** Local hour, 0-23. */
  hour: number;
  /** Local minute, 0-59. */
  minute: number;
  /** Local ISO weekday, 1 (Monday) - 7 (Sunday). */
  isoDayOfWeek: number;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** The timezone actually used (`system` when none was supplied). */
  timeZone: string;
}

/**
 * Break an epoch-ms instant into local calendar fields.
 *
 * An empty `timeZone` (or the `"system"` sentinel a model writes when none was
 * configured) means "use the host's local timezone" — which is the behaviour a
 * single-user Zwift history wants. A named IANA zone makes the result
 * reproducible on a server that runs in UTC.
 */
export function localParts(ms: number, timeZone = ""): LocalParts {
  const name = timeZone.trim();
  // `Intl.DateTimeFormat` rejects "system" as an unknown zone, so normalise it
  // (and the empty string) to `undefined` — its "use the host zone" signal.
  const tz = name === "" || name.toLowerCase() === "system" ? undefined : name;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    isoDayOfWeek: Math.max(1, weekdays.indexOf(weekday) + 1),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    timeZone: tz ?? "system",
  };
}

/** Clamp `value` into the inclusive range `[lo, hi]`. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Arithmetic mean of `values`; `null` for an empty list. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Decay weight for an age, as `0.5 ** (ageDays / halfLifeDays)`.
 *
 * A half-life of 21 days means a ride three weeks old counts half as much as
 * one from today. A non-positive half-life disables decay (weight 1).
 */
export function decayWeight(ageMs: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1;
  const ageDays = Math.max(0, ageMs) / 86_400_000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Index of the duration bucket a ride of `minutes` falls into. */
export function durationBucketIndex(minutes: number): number {
  const idx = Math.floor(Math.max(0, minutes) / DURATION_BUCKET_MINUTES);
  return clamp(idx, 0, DURATION_BUCKETS - 1);
}

/** Human label for a duration bucket index, e.g. `120-150m` or `240m+`. */
export function durationBucketLabel(index: number): string {
  const lo = index * DURATION_BUCKET_MINUTES;
  if (index >= DURATION_BUCKETS - 1) return `${lo}m+`;
  return `${lo}-${lo + DURATION_BUCKET_MINUTES}m`;
}

/** Divide every bucket by the total, leaving a probability distribution. */
export function normalizeHistogram(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);
  return counts.map((c) => c / total);
}

/**
 * Distance-weighted Gaussian-smoothed score for `value` against a normalised
 * histogram of `bucketSize`-wide bins, with the given tolerance in bins.
 *
 * Used for both hour-of-day and duration matching: the rider's own decayed
 * habit distribution is the reference, and a nearby bucket scores partially.
 */
export function histogramAffinity(
  histogram: number[],
  value: number,
  bucketSize: number,
  tolerance: number,
): number {
  if (histogram.length === 0) return 0;
  const center = Math.floor(value / bucketSize);
  const sigma = Math.max(1, tolerance);
  let score = 0;
  for (let i = 0; i < histogram.length; i++) {
    const distance = Math.abs(i - center);
    if (distance > sigma * 3) continue;
    score += histogram[i] *
      Math.exp(-(distance * distance) / (2 * sigma * sigma));
  }
  // The maximum achievable score is ~1 (all mass at the centre).
  return clamp(score, 0, 1);
}

/**
 * Estimate a ride/event duration in seconds from distance and a reference
 * speed, falling back to `fallbackSeconds` when either input is unusable.
 */
export function estimateDurationSeconds(
  distanceMeters: number,
  speedKph: number | null,
  fallbackSeconds = 0,
): number {
  if (distanceMeters > 0 && speedKph !== null && speedKph > 1) {
    return Math.round((distanceMeters / 1000 / speedKph) * 3600);
  }
  return fallbackSeconds;
}

/** Format seconds as `Hh Mm` (or `Mm`) for human-readable output. */
export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return "unknown";
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}
