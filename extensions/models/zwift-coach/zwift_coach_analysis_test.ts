import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  analyzeFitness,
  classifyRideFlavor,
  extractWeight,
  resolveAge,
  sustainedPeak,
} from "./zwift_coach_analysis.ts";
import {
  abilityFixture,
  availabilityFixture,
  bodyRangeFixture,
  healthRangeFixture,
  historyYearsFixture,
  loadDailyFixture,
  performanceRangeFixture,
  profileFixture,
  trainingHistoryFixture,
} from "./zwift_coach_fixtures.ts";

Deno.test("analyzeFitness builds current, peaks, weight and readiness", () => {
  const f = analyzeFitness({
    profile: profileFixture(),
    ability: abilityFixture(),
    loadDaily: loadDailyFixture(),
    historyYears: historyYearsFixture(),
    availability: availabilityFixture(),
    trainingHistory: trainingHistoryFixture(),
    bodyRange: bodyRangeFixture(),
    healthRange: healthRangeFixture(),
    performanceRange: performanceRangeFixture(),
    age: 48,
  });
  assertAlmostEquals(f.current.ctl, 52, 6);
  assertEquals(f.peaks.ftpWatts, 270);
  assertEquals(f.weight.currentKg, 72.4);
  assertEquals(f.weight.trend28dKg !== null, true);
  assertEquals(f.readiness.hrv, 60);
  assertEquals(f.athlete.age, 48);
  assertEquals(f.athlete.fitnessAge, 42);
  assertEquals(f.rideFlavor.funPreference, "race");
});

Deno.test("classifyRideFlavor recognises race, banded and workout names", () => {
  const mix = classifyRideFlavor([
    { name: "ZRL Race", eventId: 1, localDate: "2026-04-01" },
    { name: "Banded group ride", localDate: "2026-04-01" },
    { name: "Sweet spot workout", localDate: "2026-04-01" },
    { name: "Solo spin", localDate: "2026-04-01" },
  ]);
  assertEquals(mix.race, 1);
  assertEquals(mix.banded, 1);
  assertEquals(mix.workout, 1);
  assertEquals(mix.solo, 1);
});

Deno.test("extractWeight reads grams and computes trends", () => {
  const w = extractWeight({
    latest: { weightGrams: 72400, bodyFatPercent: 18 },
    weighIns: [
      { date: "2026-04-01", weightGrams: 73300 },
      { date: "2026-04-29", weightGrams: 72400 },
    ],
  });
  assertEquals(w.currentKg, 72.4);
  assertEquals(w.bodyFatPercent, 18);
});

Deno.test("resolveAge prefers explicit, then Garmin date of birth", () => {
  const athlete = {
    age: null,
    ageSource: "unknown" as const,
    fitnessAge: null,
    vo2max: null,
  };
  assertEquals(resolveAge(athlete, 48).age, 48);
  assertEquals(resolveAge(athlete, 48).ageSource, "user");
  assertEquals(
    resolveAge(athlete, undefined, { birthDate: "1980-01-01" }).ageSource,
    "garmin",
  );
});

Deno.test("sustainedPeak is the max 28-day average", () => {
  const days = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    tss: 50,
    ctl: i < 28 ? 40 : 60,
    atl: 55,
    tsb: -5,
  }));
  const peak = sustainedPeak(days);
  assertEquals(peak.value > 40, true);
});
