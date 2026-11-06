/**
 * Pure fitness analysis for the coach: current/peak load, availability,
 * weight, readiness, ride flavour and safety flags.
 *
 * @module
 */

import type {
  Fitness,
  LooseRecord,
  PowerCurve,
  PowerCurvePoint,
} from "./zwift_coach_types.ts";
import { clamp, round1 } from "./zwift_coach_util.ts";

export interface AnalyzeInput {
  profile: LooseRecord;
  ability: LooseRecord;
  loadDaily: LooseRecord;
  historyYears: LooseRecord;
  availability: LooseRecord;
  powerCurve?: LooseRecord | null;
  trainingHistory?: LooseRecord | null;
  bodyRange?: LooseRecord | null;
  healthRange?: LooseRecord | null;
  performanceRange?: LooseRecord | null;
  timezone?: string;
  age?: number;
}

type LoadDay = {
  date: string;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
};

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arr(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value as LooseRecord[] : [];
}

function object(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : {};
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function maxOf(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function parsePowerCurve(value: unknown): PowerCurve {
  const root = object(value);
  const best = object(root.best);
  const points: PowerCurvePoint[] = arr(root.points).map((p) => ({
    seconds: num(p.seconds) ?? 0,
    watts: num(p.watts) ?? 0,
    ...(num(p.wPerKg) !== null ? { wPerKg: num(p.wPerKg) ?? undefined } : {}),
  })).filter((p) => p.seconds > 0 && p.watts > 0);
  const source = str(root.source);
  const cadence = object(root.cadence);
  const cadenceSource = str(cadence.source);
  return {
    source: source === "zwift-power-curve" || source === "fit-records"
      ? source
      : "missing",
    fetchedAt: str(root.fetchedAt),
    points,
    best: {
      power5: num(best.power5),
      power15: num(best.power15),
      power60: num(best.power60),
      power300: num(best.power300),
      power1200: num(best.power1200),
    },
    cadence: {
      max: num(cadence.max),
      at5s: num(cadence.at5s),
      at60s: num(cadence.at60s),
      typical: num(cadence.typical),
      source: cadenceSource === "fit-records" || cadenceSource === "detail"
        ? cadenceSource
        : "missing",
    },
  };
}

function daysOf(loadDaily: LooseRecord): LoadDay[] {
  return arr(loadDaily.days).map((d) => ({
    date: str(d.date),
    tss: num(d.tss) ?? 0,
    ctl: num(d.ctl) ?? 0,
    atl: num(d.atl) ?? 0,
    tsb: num(d.tsb) ?? 0,
  })).filter((d) => d.date !== "");
}

function avgLast(days: LoadDay[], n: number): number {
  const slice = days.slice(-n);
  return round1(mean(slice.map((d) => d.tss)) ?? 0);
}

/** Maximum 28-day rolling average CTL, with the date it ended. */
export function sustainedPeak(
  days: LoadDay[],
): { value: number; date: string | null } {
  if (days.length < 28) {
    const max = maxOf(days.map((d) => d.ctl));
    return {
      value: round1(max ?? 0),
      date: days.length ? days[days.length - 1].date : null,
    };
  }
  let best = 0;
  let bestDate: string | null = null;
  for (let i = 27; i < days.length; i++) {
    const window = days.slice(i - 27, i + 1);
    const avg = mean(window.map((d) => d.ctl)) ?? 0;
    if (avg > best) {
      best = avg;
      bestDate = days[i].date;
    }
  }
  return { value: round1(best), date: bestDate };
}

/** Classify one ride as race/banded/group/workout/solo. */
export function rideFlavorOf(ride: LooseRecord): keyof RideFlavorMix {
  const name = str(ride.name).toLowerCase();
  const eventId = num(ride.eventId);
  if (
    /race|crit|time trial|\btt\b|cup|league|championship|series/.test(name) ||
    eventId !== null
  ) {
    return "race";
  }
  if (/band|banded/.test(name)) return "banded";
  if (
    /workout|interval|sweet ?spot|threshold|vo2|ftp test|over.?under/.test(name)
  ) {
    return "workout";
  }
  if (/group|fondo|social|pacer|ride|tour/.test(name)) return "group";
  return "solo";
}

export interface RideFlavorMix {
  race: number;
  banded: number;
  group: number;
  workout: number;
  solo: number;
  confidence: number;
  funPreference: "race" | "banded" | "group" | "workout" | "solo";
}

/** Recency-weighted mix of ride flavours (last 12 months). */
export function classifyRideFlavor(input: LooseRecord[]): RideFlavorMix {
  const rides = input.filter((r) => {
    const date = str(r.localDate);
    return date !== "" && date >= oneYearAgo();
  });
  const counts: RideFlavorMix = {
    race: 0,
    banded: 0,
    group: 0,
    workout: 0,
    solo: 0,
    confidence: 0,
    funPreference: "solo",
  };
  if (rides.length === 0) return counts;
  for (const ride of rides) counts[rideFlavorOf(ride)]++;
  const total = rides.length;
  const ranked = (["race", "banded", "group", "workout", "solo"] as const)
    .map((key) => ({ key, count: counts[key] }))
    .sort((a, b) => b.count - a.count);
  counts.funPreference = ranked[0].key;
  counts.confidence = round1(ranked[0].count / total);
  return counts;
}

function oneYearAgo(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Read a kg value from a Garmin weigh-in row (grams are common). */
function weightKgOf(row: LooseRecord): number | null {
  const kg = num(row.weightKg);
  if (kg !== null && kg > 0) return kg;
  const grams = num(row.weightGrams);
  if (grams !== null && grams > 0) return round1(grams / 1000);
  const raw = num(row.weight);
  if (raw !== null && raw > 0) return raw > 1000 ? round1(raw / 1000) : raw;
  return null;
}

/** Extract current weight and 7/28-day trend from a Garmin body-range shape. */
export function extractWeight(bodyRange?: LooseRecord): Fitness["weight"] {
  const rows = arr(bodyRange?.weighIns).length > 0
    ? arr(bodyRange?.weighIns)
    : arr(bodyRange?.weights);
  const latest = object(bodyRange?.latest);
  const points = rows
    .map((r) => ({
      date: str(r.date ?? r.localDate ?? r.timestamp),
      kg: weightKgOf(r),
      bodyFat: num(r.bodyFatPercent ?? r.bodyFat),
    }))
    .filter((p) => p.date !== "" && p.kg !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const currentKg = weightKgOf(latest) ?? points[points.length - 1]?.kg ?? null;
  const bodyFatPercent = num(latest.bodyFatPercent ?? latest.bodyFat) ??
    points[points.length - 1]?.bodyFat ?? null;
  const targetKg = num(bodyRange?.targetKg);
  const trend = (days: number): number | null => {
    if (currentKg === null || points.length === 0) return null;
    const cutoff = dateDaysAgo(days);
    const past = [...points].reverse().find((p) => p.date <= cutoff) ??
      points[0];
    return past.kg === null ? null : round1(currentKg - past.kg);
  };
  return {
    currentKg,
    trend7dKg: trend(7),
    trend28dKg: trend(28),
    bodyFatPercent,
    targetKg,
  };
}

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Extract readiness and athlete facts from Garmin health/performance data. */
export function extractReadiness(
  healthRange?: LooseRecord,
  performanceRange?: LooseRecord,
): { readiness: Fitness["readiness"]; athlete: Fitness["athlete"] } {
  const summaries = arr(healthRange?.summaries);
  const latest = object(healthRange?.latest) ??
    summaries[summaries.length - 1] ?? {};
  const hrvValues = summaries.map((s) => num(s.hrvLastNightAvg)).filter(
    (n): n is number => n !== null,
  );
  const rhrValues = summaries.map((s) => num(s.restingHeartRate)).filter(
    (n): n is number => n !== null,
  );
  const perf = performanceRange ?? {};
  return {
    readiness: {
      hrv: num(latest.hrvLastNightAvg),
      hrvBaseline: mean(hrvValues.slice(-28)),
      restingHr: num(latest.restingHeartRate),
      restingHrBaseline: mean(rhrValues.slice(-28)),
      sleepScore: num(latest.sleepScore),
      trainingReadiness: num(perf.trainingReadiness),
    },
    athlete: {
      age: null,
      ageSource: "unknown",
      fitnessAge: num(perf.fitnessAge),
      vo2max: num(perf.vo2maxCycling) ?? num(perf.vo2max),
    },
  };
}

/** Fill age from an explicit value or a Garmin date of birth. */
export function resolveAge(
  athlete: Fitness["athlete"],
  explicitAge?: number,
  profile?: LooseRecord,
): Fitness["athlete"] {
  if (explicitAge !== undefined && Number.isFinite(explicitAge)) {
    return { ...athlete, age: Math.round(explicitAge), ageSource: "user" };
  }
  const source = profile ?? {};
  const direct = num(source.age);
  if (direct !== null && direct > 0) {
    return { ...athlete, age: Math.round(direct), ageSource: "garmin" };
  }
  const birth = str(source.birthDate ?? source.dateOfBirth);
  if (birth) {
    const ms = Date.parse(birth);
    if (!Number.isNaN(ms)) {
      const age = Math.floor((Date.now() - ms) / (365.25 * 86_400_000));
      return { ...athlete, age, ageSource: "garmin" };
    }
  }
  return athlete;
}

/**
 * Build the fitness snapshot from the data-owner resources plus optional
 * Garmin wellness/body/performance data.
 */
export function analyzeFitness(input: AnalyzeInput): Fitness {
  const days = daysOf(input.loadDaily);
  const last = days[days.length - 1];
  const ctlValues = days.map((d) => d.ctl);
  const ctlPeak = maxOf(ctlValues);
  const sustained = sustainedPeak(days);
  const years = arr(input.historyYears.years);
  const availabilitySource =
    (str(input.availability.source) === "zwift" ? "zwift" : "merged") as
      | "zwift"
      | "merged";
  const availabilityBlock = object(
    input.availability[availabilitySource] ?? input.availability.merged ??
      input.availability,
  );
  const weight = extractWeight(input.bodyRange ?? undefined);
  const { readiness, athlete: readinessAthlete } = extractReadiness(
    input.healthRange ?? undefined,
    input.performanceRange ?? undefined,
  );
  const athlete = resolveAge(readinessAthlete, input.age, {
    ...input.profile,
    ...(input.performanceRange ?? {}),
  });
  const rideFlavor = classifyRideFlavor(
    arr(input.trainingHistory?.rides),
  );
  const powerCurve = parsePowerCurve(input.powerCurve);

  const profileFtp = num(input.profile.ftpWatts) ??
    num(input.ability.ftpWatts);
  const yearFtp = years
    .map((y) => num(y.maxFtp))
    .filter((n): n is number => n !== null);
  const peakFtp = maxOf(yearFtp) ?? profileFtp;
  const currentWeight = weight.currentKg ?? num(input.profile.weightKg);
  const wPerKg = profileFtp !== null && currentWeight !== null &&
      currentWeight > 0
    ? round1(profileFtp / currentWeight)
    : null;
  const peakWkg = peakFtp !== null && currentWeight !== null &&
      currentWeight > 0
    ? round1(peakFtp / currentWeight)
    : null;
  const currentCtl = last?.ctl ?? 0;
  const last90 = days.slice(-90);
  const max90 = maxOf(last90.map((d) => d.ctl)) ?? currentCtl;
  const overreaching = days.slice(-7).filter((d) => d.tsb < -25).length >= 5;
  const quality = object(input.loadDaily.dataQuality);
  const npRides = num(quality.npRides) ?? 0;
  const est = num(quality.estimatedRides) ?? 0;
  const missing = num(quality.missingRides) ?? 0;
  const totalRides = npRides + est + missing;
  const readinessLow = lowReadiness(readiness);

  return {
    generatedAt: new Date().toISOString(),
    current: {
      ctl: round1(currentCtl),
      atl: round1(last?.atl ?? 0),
      tsb: round1(last?.tsb ?? 0),
      weeklyTss: round1((last?.ctl ?? 0) * 7),
      avg7dTss: avgLast(days, 7),
      avg28dTss: avgLast(days, 28),
      avg90dTss: avgLast(days, 90),
      ftpWatts: profileFtp,
      weightKg: currentWeight,
      wPerKg,
    },
    peaks: {
      ctl: round1(ctlPeak ?? 0),
      ctlDate: ctlPeak === null
        ? null
        : (days.find((d) => d.ctl === ctlPeak)?.date ?? null),
      sustainedCtl: sustained.value,
      sustainedCtlDate: sustained.date,
      ftpWatts: peakFtp,
      ftpDate: null,
      wPerKg: peakWkg,
    },
    years: years.map((y) => ({
      year: num(y.year) ?? 0,
      rides: num(y.rides) ?? 0,
      hours: num(y.hours) ?? 0,
      km: num(y.km) ?? 0,
      tss: num(y.tss) ?? 0,
      peakCtl: num(y.peakCtl) ?? 0,
      maxFtp: num(y.maxFtp),
    })),
    powerCurve,
    availability: {
      source: availabilitySource,
      daysPerWeek: {
        median: num(object(availabilityBlock.daysPerWeek).median) ?? 0,
        p80: num(object(availabilityBlock.daysPerWeek).p80) ?? 0,
      },
      hoursPerWeek: {
        median: num(object(availabilityBlock.hoursPerWeek).median) ?? 0,
        p80: num(object(availabilityBlock.hoursPerWeek).p80) ?? 0,
      },
      preferredDays: (availabilityBlock.preferredDays as number[] | undefined)
        ?.map(Number) ?? [],
      preferredHours:
        (availabilityBlock.preferredHours as number[] | undefined)?.map(
          Number,
        ) ?? [],
      sessionMinutes: {
        p50: num(object(availabilityBlock.sessionMinutes).p50) ?? 60,
        p90: num(object(availabilityBlock.sessionMinutes).p90) ?? 120,
      },
      recent8w: {
        daysPerWeek: num(object(availabilityBlock.recent8w).daysPerWeek) ?? 0,
        hoursPerWeek: num(object(availabilityBlock.recent8w).hoursPerWeek) ?? 0,
      },
      gapDays: num(availabilityBlock.gapDays) ?? 0,
      lowHistory: availabilityBlock.lowHistory === true,
    },
    weight,
    readiness,
    athlete,
    rideFlavor,
    flags: {
      detrained: (num(availabilityBlock.gapDays) ?? 0) > 14 ||
        currentCtl < 0.7 * max90,
      staleFtp: profileFtp === null,
      lowHistory: availabilityBlock.lowHistory === true,
      estimated: totalRides > 0 && est / totalRides > 0.2,
      overreaching,
      garminMissing: !input.bodyRange && !input.healthRange &&
        !input.performanceRange,
      weightLossTooFast: weight.trend7dKg !== null &&
        weight.trend7dKg < -0.7,
      weightStalled: weight.trend28dKg !== null &&
        Math.abs(weight.trend28dKg) < 0.2 && weight.targetKg !== null,
      readinessLow,
    },
    sources: object(input.availability.sources),
  };
}

function lowReadiness(readiness: Fitness["readiness"]): boolean {
  let bad = 0;
  if (
    readiness.hrv !== null && readiness.hrvBaseline !== null &&
    readiness.hrv < readiness.hrvBaseline * 0.9
  ) bad++;
  if (
    readiness.restingHr !== null && readiness.restingHrBaseline !== null &&
    readiness.restingHr > readiness.restingHrBaseline + 5
  ) bad++;
  if (readiness.sleepScore !== null && readiness.sleepScore < 60) bad++;
  return bad >= 2;
}

/** Clamp a value to a useful range (exported for tests). */
export function healthyRamp(value: number): number {
  return clamp(value, 0, 10);
}
