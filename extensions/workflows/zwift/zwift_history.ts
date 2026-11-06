/**
 * Pure history/load helpers for the Zwift coach backfill.
 *
 * Everything here is side-effect free and network free: it normalises Garmin
 * activities, merges them with Zwift rides, computes TSS/CTL/ATL/TSB, yearly
 * totals, and the history-derived availability profile. Unit tests cover it
 * without an account.
 *
 * @module
 */

import { clamp, localParts, mean, parseTimeMs } from "./zwift_util.ts";

/** Source of one merged ride. */
export type RideSource = "zwift" | "garmin";

/** How a ride's TSS was derived. */
export type TssSource =
  | "np"
  | "garmin_calibrated"
  | "avg_power"
  | "missing";

/** One ride, normalised across Zwift and Garmin. */
export interface HistoryRide {
  id: string;
  source: RideSource;
  name: string;
  sport: string;
  startMs: number;
  localDate: string;
  localHour: number;
  isoDayOfWeek: number;
  durationSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  elevationMeters: number;
  avgPower: number | null;
  npWatts: number | null;
  ftpWatts: number | null;
  tss: number | null;
  tssSource: TssSource;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  maxCadence?: number | null;
  cadenceAt5s?: number | null;
  cadenceAt60s?: number | null;
  maxPower: number | null;
  eventId: number | null;
  routeId: number | null;
  worldId: number | null;
  /** Garmin's own training-load value; never used raw as TSS. */
  garminTrainingLoad: number | null;
  detailFetchedAt: string | null;
  fitFetchedAt: string | null;
}

/** Daily load row. */
export interface LoadDay {
  date: string;
  minutes: number;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
  rides: number;
}

/** One year of merged history. */
export interface HistoryYear {
  year: number;
  rides: number;
  hours: number;
  km: number;
  elevationM: number;
  tss: number;
  peakCtl: number;
  maxFtp: number | null;
  avgFtp: number | null;
  sources: { zwift: number; garmin: number };
}

/** Availability statistics for one source. */
export interface AvailabilityStats {
  from: string;
  to: string;
  rides: number;
  daysPerWeek: { median: number; p80: number };
  hoursPerWeek: { median: number; p80: number };
  preferredDays: number[];
  preferredHours: number[];
  sessionMinutes: { p50: number; p90: number };
  recent8w: { daysPerWeek: number; hoursPerWeek: number };
  monthlyHours: { month: string; hours: number }[];
  gapDays: number;
  lowHistory: boolean;
}

/** Source counts and date ranges. */
export interface HistorySources {
  zwift: {
    from: string | null;
    to: string | null;
    rides: number;
    truncated: boolean;
  };
  garmin: {
    from: string | null;
    to: string | null;
    rides: number;
    truncated: boolean;
  };
  merged: {
    from: string | null;
    to: string | null;
    rides: number;
    duplicates: number;
  };
}

/** TSS from normalised power and the FTP at the ride. */
export function tssFromNp(
  npWatts: number | null,
  ftpWatts: number | null,
  durationSeconds: number,
): number | null {
  if (
    npWatts === null || ftpWatts === null || npWatts <= 0 ||
    ftpWatts <= 0 || durationSeconds <= 0
  ) {
    return null;
  }
  const intensity = npWatts / ftpWatts;
  return Math.round(
    (durationSeconds * npWatts * intensity) / (ftpWatts * 3600) * 100 * 10,
  ) / 10;
}

/** TSS from average power (an estimate; deliberately labelled). */
export function tssFromAvgPower(
  avgPower: number | null,
  ftpWatts: number | null,
  durationSeconds: number,
  surgeFactor = 1,
): number | null {
  if (
    avgPower === null || ftpWatts === null || avgPower <= 0 || ftpWatts <= 0
  ) {
    return null;
  }
  const np = avgPower * surgeFactor;
  return tssFromNp(np, ftpWatts, durationSeconds);
}

/** Sorted percentile (`p` in 0..1); `null` for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Median (`p=0.5`). */
export function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

/** Round to one decimal place. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Epoch-ms from a `YYYY-MM-DD` date at UTC midnight. */
export function dateMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** `YYYY-MM-DD` from epoch-ms (UTC). */
export function dateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add days to a `YYYY-MM-DD` string. */
export function addDays(date: string, days: number): string {
  return dateString(dateMs(date) + days * 86_400_000);
}

/** Days between two `YYYY-MM-DD` strings. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateMs(b) - dateMs(a)) / 86_400_000);
}

/** Normalise one Garmin `activity-list` row into a {@link HistoryRide}. */
export function normalizeGarminRide(
  raw: Record<string, unknown>,
  timeZone: string,
): HistoryRide | null {
  const id = String(raw.id ?? raw.activityId ?? "").trim();
  if (!id) return null;
  const startMs = parseTimeMs(
    raw.startMs ?? raw.startTimeGmt ?? raw.startTimeLocal ?? raw.startTime,
  );
  if (startMs === null) return null;
  const local = localParts(startMs, timeZone);
  const parent = String(raw.parentTypeKey ?? "").toLowerCase();
  const type = String(raw.typeKey ?? raw.activityType ?? "").toLowerCase();
  const sport = parent.includes("cycl") || type.includes("cycl") ||
      type.includes("bik")
    ? "CYCLING"
    : parent.includes("run") || type.includes("run")
    ? "RUNNING"
    : (parent || type || "unknown").toUpperCase();
  const durationSeconds = Number(raw.durationSeconds ?? raw.duration ?? 0) || 0;
  const movingSeconds = Number(raw.movingSeconds ?? durationSeconds) ||
    durationSeconds;
  return {
    id: `garmin-${id}`,
    source: "garmin",
    name: String(raw.name ?? "Garmin activity"),
    sport,
    startMs,
    localDate: local.date,
    localHour: local.hour,
    isoDayOfWeek: local.isoDayOfWeek,
    durationSeconds,
    movingSeconds,
    distanceMeters: Number(raw.distanceMeters ?? 0) || 0,
    elevationMeters: Number(raw.elevationGainMeters ?? 0) || 0,
    avgPower: numberOrNull(raw.avgPower),
    npWatts: numberOrNull(raw.normalizedPower),
    ftpWatts: null,
    tss: null,
    tssSource: "missing",
    avgHr: numberOrNull(raw.avgHr),
    maxHr: numberOrNull(raw.maxHr),
    avgCadence: numberOrNull(raw.avgCadence),
    maxPower: numberOrNull(raw.maxPower),
    eventId: null,
    routeId: null,
    worldId: null,
    garminTrainingLoad: numberOrNull(raw.trainingLoad),
    detailFetchedAt: null,
    fitFetchedAt: null,
  };
}

/** First finite number among the values, else null. */
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** True when two rides look like the same session. */
export function sameRide(a: HistoryRide, b: HistoryRide): boolean {
  return a.sport === b.sport &&
    Math.abs(a.startMs - b.startMs) <= 3 * 60_000 &&
    Math.abs(a.durationSeconds - b.durationSeconds) <= 120;
}

/**
 * Merge Zwift and Garmin rides, removing duplicates.
 *
 * When both sources recorded the same session, keep the Zwift metadata
 * (virtual world/route/event) and take the best available load fields from
 * either source.
 */
export function mergeRides(
  zwift: HistoryRide[],
  garmin: HistoryRide[],
): { rides: HistoryRide[]; duplicates: number } {
  const merged: HistoryRide[] = [];
  let duplicates = 0;
  for (const ride of [...zwift, ...garmin]) {
    const existing = merged.find((r) => sameRide(r, ride));
    if (!existing) {
      merged.push({ ...ride });
      continue;
    }
    duplicates++;
    const preferred = existing.source === "zwift" ? existing : ride;
    const other = preferred === existing ? ride : existing;
    existing.id = preferred.id;
    existing.source = preferred.source;
    existing.name = preferred.name || other.name;
    existing.eventId = preferred.eventId ?? other.eventId;
    existing.routeId = preferred.routeId ?? other.routeId;
    existing.worldId = preferred.worldId ?? other.worldId;
    existing.avgPower = preferred.avgPower ?? other.avgPower;
    existing.npWatts = preferred.npWatts ?? other.npWatts;
    existing.avgHr = preferred.avgHr ?? other.avgHr;
    existing.maxHr = preferred.maxHr ?? other.maxHr;
    existing.avgCadence = preferred.avgCadence ?? other.avgCadence;
    existing.maxPower = preferred.maxPower ?? other.maxPower;
    existing.garminTrainingLoad = preferred.garminTrainingLoad ??
      other.garminTrainingLoad;
    existing.ftpWatts = preferred.ftpWatts ?? other.ftpWatts;
    existing.detailFetchedAt = preferred.detailFetchedAt ??
      other.detailFetchedAt;
    existing.fitFetchedAt = preferred.fitFetchedAt ?? other.fitFetchedAt;
  }
  merged.sort((a, b) => a.startMs - b.startMs);
  return { rides: merged, duplicates };
}

/** One FTP observation at a point in time. */
export interface FtpObservation {
  startMs: number;
  ftpWatts: number;
}

/** Most recent FTP at or before `startMs`; falls back to the earliest known. */
export function ftpAt(
  startMs: number,
  history: FtpObservation[],
  fallback: number | null,
): number | null {
  if (history.length === 0) return fallback;
  const sorted = [...history].sort((a, b) => a.startMs - b.startMs);
  let best: number | null = null;
  for (const obs of sorted) {
    if (obs.startMs <= startMs && obs.ftpWatts > 0) best = obs.ftpWatts;
  }
  return best ?? (sorted[0]?.ftpWatts ?? fallback);
}

/**
 * Compute TSS for every ride and label its source.
 *
 * Garmin's raw `trainingLoad` is never mixed with TSS: if a calibration ratio
 * is available it is applied and labelled; otherwise the ride falls back to
 * average power or `missing`.
 */
export function applyLoad(
  rides: HistoryRide[],
  opts: {
    ftpFallback: number | null;
    ftpHistory?: FtpObservation[];
    garminCalibration?: number | null;
    surgeFactor?: number;
  },
): HistoryRide[] {
  const out: HistoryRide[] = [];
  const calibration = opts.garminCalibration ?? null;
  for (const ride of rides) {
    const ftp = ride.ftpWatts ??
      ftpAt(ride.startMs, opts.ftpHistory ?? [], opts.ftpFallback);
    const duration = ride.movingSeconds || ride.durationSeconds;
    let tss: number | null = null;
    let source: TssSource = "missing";
    if (ride.npWatts !== null) {
      tss = tssFromNp(ride.npWatts, ftp, duration);
      if (tss !== null) source = "np";
    }
    if (tss === null && ride.garminTrainingLoad !== null && calibration) {
      tss = round1(ride.garminTrainingLoad * calibration);
      source = "garmin_calibrated";
    }
    if (tss === null && ride.avgPower !== null) {
      tss = tssFromAvgPower(
        ride.avgPower,
        ftp,
        duration,
        opts.surgeFactor ?? 1,
      );
      if (tss !== null) source = "avg_power";
    }
    out.push({ ...ride, ftpWatts: ftp, tss, tssSource: source });
  }
  return out;
}

/**
 * Median TSS/Garmin-training-load ratio on rides that have both.
 * Returns null when there are fewer than three overlapping rides.
 */
export function calibrateGarminLoad(
  rides: HistoryRide[],
  ftpFallback: number | null,
): number | null {
  const ratios: number[] = [];
  for (const ride of rides) {
    if (
      ride.source !== "garmin" || ride.npWatts === null ||
      ride.garminTrainingLoad === null || ride.garminTrainingLoad <= 0
    ) continue;
    const ftp = ride.ftpWatts ?? ftpFallback;
    const tss = tssFromNp(
      ride.npWatts,
      ftp,
      ride.movingSeconds || ride.durationSeconds,
    );
    if (tss !== null) ratios.push(tss / ride.garminTrainingLoad);
  }
  if (ratios.length < 3) return null;
  return median(ratios);
}

/** Build the daily TSS/CTL/ATL/TSB series, including rest days. */
export function buildDailyLoad(
  rides: HistoryRide[],
  opts: {
    today: string;
    dataQuality: {
      npRides: number;
      hrRides: number;
      estimatedRides: number;
      missingRides: number;
    };
    sources: HistorySources;
  },
): { from: string; to: string; days: LoadDay[] } {
  const withLoad = rides.filter((r) => r.tss !== null && r.tss > 0);
  const first = withLoad.length > 0
    ? withLoad.reduce(
      (min, r) => r.localDate < min ? r.localDate : min,
      withLoad[0].localDate,
    )
    : opts.today;
  const byDate = new Map<
    string,
    { minutes: number; tss: number; rides: number }
  >();
  for (const ride of withLoad) {
    const row = byDate.get(ride.localDate) ?? { minutes: 0, tss: 0, rides: 0 };
    row.minutes += (ride.movingSeconds || ride.durationSeconds) / 60;
    row.tss += ride.tss ?? 0;
    row.rides += 1;
    byDate.set(ride.localDate, row);
  }
  const days: LoadDay[] = [];
  let ctl = 0;
  let atl = 0;
  const kCtl = 1 - Math.exp(-1 / 42);
  const kAtl = 1 - Math.exp(-1 / 7);
  let date = first;
  while (date <= opts.today) {
    const row = byDate.get(date);
    const tss = row?.tss ?? 0;
    ctl += (tss - ctl) * kCtl;
    atl += (tss - atl) * kAtl;
    days.push({
      date,
      minutes: Math.round(row?.minutes ?? 0),
      tss: round1(tss),
      ctl: round1(ctl),
      atl: round1(atl),
      tsb: round1(ctl - atl),
      rides: row?.rides ?? 0,
    });
    date = addDays(date, 1);
  }
  return { from: first, to: opts.today, days };
}

/** Build one row per calendar year from the daily load and rides. */
export function buildHistoryYears(
  loadDays: LoadDay[],
  rides: HistoryRide[],
): HistoryYear[] {
  const years = new Map<number, HistoryYear>();
  const touch = (year: number): HistoryYear => {
    const existing = years.get(year);
    if (existing) return existing;
    const row: HistoryYear = {
      year,
      rides: 0,
      hours: 0,
      km: 0,
      elevationM: 0,
      tss: 0,
      peakCtl: 0,
      maxFtp: null,
      avgFtp: null,
      sources: { zwift: 0, garmin: 0 },
    };
    years.set(year, row);
    return row;
  };
  for (const ride of rides) {
    const row = touch(Number(ride.localDate.slice(0, 4)));
    row.rides++;
    row.hours += (ride.movingSeconds || ride.durationSeconds) / 3600;
    row.km += ride.distanceMeters / 1000;
    row.elevationM += ride.elevationMeters;
    row.tss += ride.tss ?? 0;
    row.sources[ride.source]++;
    if (ride.ftpWatts !== null) {
      row.maxFtp = row.maxFtp === null
        ? ride.ftpWatts
        : Math.max(row.maxFtp, ride.ftpWatts);
      const n = row.rides;
      row.avgFtp = row.avgFtp === null
        ? ride.ftpWatts
        : Math.round(((row.avgFtp * (n - 1)) + ride.ftpWatts) / n);
    }
  }
  for (const day of loadDays) {
    const row = touch(Number(day.date.slice(0, 4)));
    row.peakCtl = Math.max(row.peakCtl, day.ctl);
  }
  return [...years.values()]
    .map((y) => ({
      ...y,
      hours: round1(y.hours),
      km: round1(y.km),
      elevationM: Math.round(y.elevationM),
      tss: round1(y.tss),
      peakCtl: round1(y.peakCtl),
    }))
    .sort((a, b) => a.year - b.year);
}

/**
 * Infer availability from rides over the last 12 months plus the last 8 weeks.
 */
export function buildAvailability(
  rides: HistoryRide[],
  opts: { today: string; source: "zwift" | "merged" },
): AvailabilityStats {
  const sorted = [...rides].sort((a, b) => a.startMs - b.startMs);
  if (sorted.length === 0) {
    return {
      from: opts.today,
      to: opts.today,
      rides: 0,
      daysPerWeek: { median: 0, p80: 0 },
      hoursPerWeek: { median: 0, p80: 0 },
      preferredDays: [],
      preferredHours: [],
      sessionMinutes: { p50: 0, p90: 0 },
      recent8w: { daysPerWeek: 0, hoursPerWeek: 0 },
      monthlyHours: [],
      gapDays: 0,
      lowHistory: true,
    };
  }
  const from = sorted[0].localDate;
  const to = sorted[sorted.length - 1].localDate;
  const cutoff = addDays(opts.today, -365);
  const window = sorted.filter((r) => r.localDate >= cutoff);
  const byWeek = new Map<string, { days: Set<string>; hours: number }>();
  const dayHist = new Array<number>(7).fill(0);
  const hourHist = new Array<number>(24).fill(0);
  const sessionMinutes: number[] = [];
  const monthly = new Map<string, number>();
  for (const ride of window) {
    const monday = mondayOf(ride.localDate);
    const row = byWeek.get(monday) ?? { days: new Set<string>(), hours: 0 };
    row.days.add(ride.localDate);
    row.hours += (ride.movingSeconds || ride.durationSeconds) / 3600;
    byWeek.set(monday, row);
    dayHist[ride.isoDayOfWeek - 1]++;
    hourHist[ride.localHour]++;
    sessionMinutes.push(
      Math.round((ride.movingSeconds || ride.durationSeconds) / 60),
    );
    monthly.set(
      ride.localDate.slice(0, 7),
      (monthly.get(ride.localDate.slice(0, 7)) ?? 0) +
        (ride.movingSeconds || ride.durationSeconds) / 3600,
    );
  }
  const weeklyDays = [...byWeek.values()].map((w) => w.days.size);
  const weeklyHours = [...byWeek.values()].map((w) => w.hours);
  const recentCutoff = addDays(opts.today, -56);
  const recent = window.filter((r) => r.localDate >= recentCutoff);
  const recentWeeks = new Map<string, { days: Set<string>; hours: number }>();
  for (const ride of recent) {
    const monday = mondayOf(ride.localDate);
    const row = recentWeeks.get(monday) ??
      { days: new Set<string>(), hours: 0 };
    row.days.add(ride.localDate);
    row.hours += (ride.movingSeconds || ride.durationSeconds) / 3600;
    recentWeeks.set(monday, row);
  }
  const daysPerWeek = {
    median: round1(median(weeklyDays) ?? 0),
    p80: round1(percentile(weeklyDays, 0.8) ?? 0),
  };
  const hoursPerWeek = {
    median: round1(median(weeklyHours) ?? 0),
    p80: round1(percentile(weeklyHours, 0.8) ?? 0),
  };
  const preferredDays = dayHist
    .map((count, i) => ({ day: i + 1, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((x) => x.day);
  const preferredHours = hourHist
    .map((count, i) => ({ hour: i, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((x) => x.hour);
  const recentDays = [...recentWeeks.values()].map((w) => w.days.size);
  const recentHours = [...recentWeeks.values()].map((w) => w.hours);
  return {
    from,
    to,
    rides: sorted.length,
    daysPerWeek,
    hoursPerWeek,
    preferredDays,
    preferredHours,
    sessionMinutes: {
      p50: Math.round(median(sessionMinutes) ?? 0),
      p90: Math.round(percentile(sessionMinutes, 0.9) ?? 0),
    },
    recent8w: {
      daysPerWeek: round1(mean(recentDays) ?? 0),
      hoursPerWeek: round1(mean(recentHours) ?? 0),
    },
    monthlyHours: [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, hours]) => ({ month, hours: round1(hours) })),
    gapDays: Math.max(0, daysBetween(to, opts.today)),
    lowHistory: daysBetween(from, to) < 56,
  };
}

/** Monday (`YYYY-MM-DD`) of the ISO week containing `date`. */
export function mondayOf(date: string): string {
  const ms = dateMs(date);
  const dow = new Date(ms).getUTCDay(); // 0=Sun
  const delta = dow === 0 ? -6 : 1 - dow;
  return dateString(ms + delta * 86_400_000);
}
