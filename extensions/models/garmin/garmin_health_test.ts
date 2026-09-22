/**
 * Tests for `@svendowideit/garmin-health` path building, capability gating, and
 * metric merging. All pure — no network, no credentials.
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  dateRange,
  mergeMetric,
  metricPath,
  METRICS,
  resolveDates,
  selectMetrics,
} from "./garmin_health.ts";

// --- path building ----------------------------------------------------------

Deno.test("metricPath builds a non-display-name metric", () => {
  assertEquals(
    metricPath("stress", "2026-01-02", ""),
    "/wellness-service/wellness/dailyStress/2026-01-02",
  );
});

Deno.test("metricPath encodes the display name for scoped endpoints", () => {
  const p = metricPath("sleep", "2026-01-02", "rider 42");
  assert(p.startsWith("/wellness-service/wellness/dailySleepData/rider%2042?"));
  assert(p.includes("date=2026-01-02"));
});

Deno.test("metricPath rejects a display-name metric without a name", () => {
  assertThrows(
    () => metricPath("summary", "2026-01-02", ""),
    Error,
    "display name",
  );
});

Deno.test("metricPath rejects an unknown metric", () => {
  assertThrows(
    () => metricPath("nope", "2026-01-02", "x"),
    Error,
    "unknown metric",
  );
});

Deno.test("every metric exposes a path builder", () => {
  for (const [name, spec] of Object.entries(METRICS)) {
    assert(typeof spec.path === "function", `${name} has a path builder`);
  }
});

// --- date ranges ------------------------------------------------------------

Deno.test("dateRange is inclusive and ordered", () => {
  assertEquals(dateRange("2026-01-01", "2026-01-03"), [
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
  ]);
  assertEquals(dateRange("2026-01-03", "2026-01-01"), []);
});

Deno.test("resolveDates prefers range, then date, then yesterday", () => {
  assertEquals(
    resolveDates({ startDate: "2026-01-01", endDate: "2026-01-02" }),
    [
      "2026-01-01",
      "2026-01-02",
    ],
  );
  assertEquals(resolveDates({ date: "2026-01-05" }), ["2026-01-05"]);
  assertEquals(resolveDates({}).length, 1);
});

// --- capability gating ------------------------------------------------------

Deno.test("selectMetrics drops device-gated metrics when gating is on", () => {
  const caps = { sleep: true, hrv: false } as Record<string, boolean>;
  const { selected, skipped } = selectMetrics(
    ["summary", "sleep", "hrv", "spo2"],
    caps,
    true,
  );
  // summary has no capability -> always kept; sleep true -> kept.
  assert(selected.includes("summary"));
  assert(selected.includes("sleep"));
  // hrv explicitly false, spo2 absent -> both skipped.
  assertEquals(skipped.sort(), ["hrv", "spo2"]);
});

Deno.test("selectMetrics keeps everything when gating is off", () => {
  const { selected, skipped } = selectMetrics(
    ["summary", "hrv", "spo2"],
    {},
    false,
  );
  assertEquals(selected, ["summary", "hrv", "spo2"]);
  assertEquals(skipped, []);
});

Deno.test("selectMetrics reports unknown metrics as skipped", () => {
  const { selected, skipped } = selectMetrics(["summary", "bogus"], {}, false);
  assertEquals(selected, ["summary"]);
  assertEquals(skipped, ["bogus"]);
});

// --- metric merging ---------------------------------------------------------

/** A fresh, all-null summary for merge tests. */
function mergeTarget() {
  return {
    date: "2026-01-02",
    steps: null as number | null,
    stepGoal: null as number | null,
    distanceMeters: null as number | null,
    restingHeartRate: null as number | null,
    minHeartRate: null as number | null,
    maxHeartRate: null as number | null,
    sleepSeconds: null as number | null,
    sleepScore: null as number | null,
    avgStress: null as number | null,
    maxStress: null as number | null,
    bodyBatteryCharged: null as number | null,
    bodyBatteryDrained: null as number | null,
    bodyBatteryHighest: null as number | null,
    bodyBatteryLowest: null as number | null,
    intensityMinutes: null as number | null,
    floorsAscended: null as number | null,
    totalKilocalories: null as number | null,
    activeKilocalories: null as number | null,
    hrvLastNightAvg: null as number | null,
    hrvStatus: null as string | null,
    spo2Avg: null as number | null,
    respirationAvg: null as number | null,
  };
}

Deno.test("mergeMetric maps the daily summary fields", () => {
  const summary = mergeTarget();
  mergeMetric(summary, "summary", {
    totalSteps: 12000,
    dailyStepGoal: 10000,
    totalDistanceMeters: 9500,
    restingHeartRate: 48,
    averageStressLevel: 30,
    maxStressLevel: 80,
    bodyBatteryChargedValue: 60,
    bodyBatteryDrainedValue: 40,
    floorsAscended: 12,
    totalKilocalories: 2400,
    activeKilocalories: 700,
    moderateIntensityMinutes: 20,
    vigorousIntensityMinutes: 10,
  });
  assertEquals(summary.steps, 12000);
  assertEquals(summary.stepGoal, 10000);
  assertEquals(summary.distanceMeters, 9500);
  assertEquals(summary.restingHeartRate, 48);
  assertEquals(summary.avgStress, 30);
  assertEquals(summary.bodyBatteryCharged, 60);
  assertEquals(summary.intensityMinutes, 30);
});

Deno.test("mergeMetric extracts sleep score from the nested shape", () => {
  const summary = mergeTarget();
  mergeMetric(summary, "sleep", {
    dailySleepDTO: {
      sleepTimeSeconds: 27000,
      sleepScores: { overall: { value: 82 } },
    },
  });
  assertEquals(summary.sleepSeconds, 27000);
  assertEquals(summary.sleepScore, 82);
});

Deno.test("mergeMetric extracts HRV last-night average and status", () => {
  const summary = mergeTarget();
  mergeMetric(summary, "hrv", {
    hrvSummary: { lastNightAvg: 45, status: "BALANCED" },
  });
  assertEquals(summary.hrvLastNightAvg, 45);
  assertEquals(summary.hrvStatus, "BALANCED");
});

Deno.test("mergeMetric extracts resting HR from the range shape", () => {
  const summary = mergeTarget();
  mergeMetric(summary, "restingHeartRate", {
    allMetrics: {
      metricsMap: { WELLNESS_RESTING_HEART_RATE: [{ value: 47 }] },
    },
  });
  assertEquals(summary.restingHeartRate, 47);
});

Deno.test("mergeMetric reads body battery from a list response", () => {
  const summary = mergeTarget();
  mergeMetric(summary, "bodyBattery", [{ charged: 55, drained: 42 }]);
  assertEquals(summary.bodyBatteryCharged, 55);
  assertEquals(summary.bodyBatteryDrained, 42);
});

Deno.test("mergeMetric ignores null/empty bodies", () => {
  const summary = mergeTarget();
  mergeMetric(summary, "sleep", null);
  mergeMetric(summary, "spo2", {});
  assertEquals(summary.sleepSeconds, null);
  assertEquals(summary.spo2Avg, null);
});
