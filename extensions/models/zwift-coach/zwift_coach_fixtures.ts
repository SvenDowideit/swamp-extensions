/** Shared fixtures for the coach tests (no network). */
import type { Fitness, Goal } from "./zwift_coach_types.ts";

export function loadDailyFixture(days = 120): Record<string, unknown> {
  const rows = [];
  let ctl = 50;
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    rows.push({
      date,
      minutes: i % 7 === 0 ? 0 : 75,
      tss: i % 7 === 0 ? 0 : 60,
      ctl: ctl + (i % 7 === 0 ? -0.2 : 0.1),
      atl: ctl + 4,
      tsb: -4,
      rides: i % 7 === 0 ? 0 : 1,
    });
    ctl += i % 7 === 0 ? -0.2 : 0.1;
  }
  return {
    generatedAt: "2026-04-30T00:00:00.000Z",
    timeZone: "UTC",
    from: rows[0].date,
    to: rows[rows.length - 1].date,
    days: rows,
    dataQuality: {
      npRides: 80,
      hrRides: 10,
      estimatedRides: 10,
      missingRides: 0,
    },
    sources: {},
  };
}

export function historyYearsFixture(): Record<string, unknown> {
  return {
    generatedAt: "2026-04-30T00:00:00.000Z",
    years: [
      {
        year: 2025,
        rides: 180,
        hours: 220,
        km: 6000,
        tss: 12000,
        peakCtl: 70,
        maxFtp: 270,
        avgFtp: 255,
      },
      {
        year: 2026,
        rides: 80,
        hours: 90,
        km: 2400,
        tss: 5000,
        peakCtl: 58,
        maxFtp: 250,
        avgFtp: 248,
      },
    ],
    totals: { rides: 260, hours: 310, km: 8400, elevationM: 10000, tss: 17000 },
    sources: {},
    truncated: false,
  };
}

export function availabilityFixture(): Record<string, unknown> {
  const stats = {
    from: "2025-01-01",
    to: "2026-04-30",
    rides: 260,
    daysPerWeek: { median: 3.5, p80: 4 },
    hoursPerWeek: { median: 6, p80: 7 },
    preferredDays: [2, 4, 6],
    preferredHours: [6, 7],
    sessionMinutes: { p50: 75, p90: 120 },
    recent8w: { daysPerWeek: 3, hoursPerWeek: 5 },
    monthlyHours: [],
    gapDays: 1,
    lowHistory: false,
  };
  return {
    generatedAt: "2026-04-30T00:00:00.000Z",
    source: "merged",
    window: { from: stats.from, to: stats.to },
    zwift: { ...stats, rides: 200 },
    merged: stats,
    gapDays: 1,
    sources: {},
    lowHistory: false,
  };
}

export function trainingHistoryFixture(): Record<string, unknown> {
  const rides = [];
  for (let i = 0; i < 20; i++) {
    rides.push({
      id: `r${i}`,
      source: "zwift",
      name: i % 3 === 0
        ? "ZRL Race"
        : i % 3 === 1
        ? "Banded group ride"
        : "Solo",
      sport: "CYCLING",
      localDate: "2026-04-01",
      eventId: i % 3 === 0 ? 42 : null,
    });
  }
  return { rides };
}

export function bodyRangeFixture(): Record<string, unknown> {
  return {
    latest: { date: "2026-04-29", weightKg: 72.4, bodyFatPercent: 18 },
    weighIns: [
      { date: "2026-04-01", weightKg: 73.2 },
      { date: "2026-04-15", weightKg: 72.8 },
      { date: "2026-04-29", weightKg: 72.4, bodyFatPercent: 18 },
    ],
    targetKg: 65,
  };
}

export function healthRangeFixture(): Record<string, unknown> {
  const summaries = [];
  for (let i = 0; i < 14; i++) {
    summaries.push({
      date: `2026-04-${String(16 + i).padStart(2, "0")}`,
      hrvLastNightAvg: 60,
      restingHeartRate: 48,
      sleepScore: 80,
    });
  }
  return { summaries, latest: summaries[summaries.length - 1] };
}

export function performanceRangeFixture(): Record<string, unknown> {
  return {
    trainingReadiness: 75,
    fitnessAge: 42,
    vo2maxCycling: 51,
  };
}

export function profileFixture(): Record<string, unknown> {
  return { ftpWatts: 250, weightKg: 72.4, age: 48 };
}

export function abilityFixture(): Record<string, unknown> {
  return { ftpWatts: 250, ftpSource: "profile" };
}

export function fitnessFixture(): Fitness {
  return {
    generatedAt: "2026-04-30T00:00:00.000Z",
    current: {
      ctl: 52,
      atl: 56,
      tsb: -4,
      weeklyTss: 364,
      avg7dTss: 52,
      avg28dTss: 51,
      avg90dTss: 50,
      ftpWatts: 250,
      weightKg: 72.4,
      wPerKg: 3.45,
    },
    peaks: {
      ctl: 70,
      ctlDate: "2025-06-01",
      sustainedCtl: 66,
      sustainedCtlDate: "2025-06-20",
      ftpWatts: 270,
      ftpDate: null,
      wPerKg: 3.7,
    },
    years: [
      {
        year: 2025,
        rides: 180,
        hours: 220,
        km: 6000,
        tss: 12000,
        peakCtl: 70,
        maxFtp: 270,
      },
    ],
    powerCurve: {
      source: "zwift-power-curve",
      fetchedAt: "2026-04-30T00:00:00.000Z",
      points: [
        { seconds: 5, watts: 1176, wPerKg: 16.24 },
        { seconds: 15, watts: 938, wPerKg: 12.96 },
        { seconds: 60, watts: 473, wPerKg: 6.53 },
        { seconds: 300, watts: 287, wPerKg: 3.96 },
        { seconds: 1200, watts: 261, wPerKg: 3.61 },
      ],
      best: {
        power5: 1176,
        power15: 938,
        power60: 473,
        power300: 287,
        power1200: 261,
      },
      cadence: {
        max: 118,
        at5s: 108,
        at60s: 94,
        typical: 86,
        source: "fit-records",
      },
    },
    availability: {
      source: "merged",
      daysPerWeek: { median: 3.5, p80: 4 },
      hoursPerWeek: { median: 6, p80: 7 },
      preferredDays: [2, 4, 6],
      preferredHours: [6, 7],
      sessionMinutes: { p50: 75, p90: 120 },
      recent8w: { daysPerWeek: 3, hoursPerWeek: 5 },
      gapDays: 1,
      lowHistory: false,
    },
    weight: {
      currentKg: 72.4,
      trend7dKg: -0.2,
      trend28dKg: -0.8,
      bodyFatPercent: 18,
      targetKg: 65,
    },
    readiness: {
      hrv: 60,
      hrvBaseline: 58,
      restingHr: 48,
      restingHrBaseline: 47,
      sleepScore: 80,
      trainingReadiness: 75,
    },
    athlete: {
      age: 48,
      ageSource: "garmin",
      fitnessAge: 42,
      vo2max: 51,
    },
    rideFlavor: {
      race: 7,
      banded: 7,
      group: 3,
      workout: 2,
      solo: 1,
      confidence: 0.35,
      funPreference: "race",
    },
    flags: {
      detrained: false,
      staleFtp: false,
      lowHistory: false,
      estimated: false,
      overreaching: false,
      garminMissing: false,
      weightLossTooFast: false,
      weightStalled: false,
      readinessLow: false,
    },
    sources: {},
  };
}

export function goalFixture(): Goal {
  return {
    id: "goal-1",
    mode: "improve",
    description: "Improve FTP",
    startDate: "2026-05-04",
    targetDate: "2026-07-26",
    weeks: 12,
    primary: { metric: "ftp", target: 262, unit: "W", comparison: ">=" },
    secondary: [{ metric: "weight", target: 65, unit: "kg", comparison: "<=" }],
    constraints: {
      daysPerWeek: 4,
      hoursPerWeek: 7,
      availableDays: [2, 4, 6],
      maxSessionMinutes: 120,
      style: "pyramidal",
      equipment: ["trainer", "power_meter", "resistance"],
      indoorOnly: false,
      injuries: [],
      overrideAvailability: false,
    },
    targetCtl: 57,
    targetFtp: 262,
    assumptions: [],
    warnings: [],
  };
}
