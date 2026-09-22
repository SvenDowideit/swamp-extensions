/**
 * Tests for `@svendowideit/garmin-performance` path building, capability gating,
 * metric merging, and latest-value parsing. All pure.
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  dailyMetrics,
  dateRange,
  latestMetrics,
  maxOf,
  mergeMetric,
  metricPath,
  METRICS,
  parseFtp,
  parsePersonalRecords,
  resolveDates,
  selectMetrics,
} from "./garmin_performance.ts";

// --- registry ---------------------------------------------------------------

Deno.test("dailyMetrics and latestMetrics partition the registry", () => {
  const all = Object.keys(METRICS).sort();
  const combined = [...dailyMetrics(), ...latestMetrics()].sort();
  assertEquals(combined, all);
  assert(latestMetrics().includes("ftp"));
  assert(latestMetrics().includes("personalRecords"));
  assert(dailyMetrics().includes("vo2max"));
  assert(dailyMetrics().includes("trainingStatus"));
});

// --- path building ----------------------------------------------------------

Deno.test("metricPath builds daily metric paths", () => {
  assertEquals(
    metricPath("vo2max", "2026-01-02", ""),
    "/metrics-service/metrics/maxmet/daily/2026-01-02/2026-01-02",
  );
  assertEquals(
    metricPath("trainingReadiness", "2026-01-02", ""),
    "/metrics-service/metrics/trainingreadiness/2026-01-02",
  );
});

Deno.test("metricPath encodes the display name where needed", () => {
  const p = metricPath("racePredictions", "2026-01-02", "rider 42");
  assertEquals(
    p,
    "/metrics-service/metrics/racepredictions/latest/rider%2042",
  );
  const pr = metricPath("personalRecords", "2026-01-02", "rider 42");
  assertEquals(pr, "/personalrecord-service/personalrecord/prs/rider%2042");
});

Deno.test("metricPath rejects a display-name metric without a name", () => {
  assertThrows(
    () => metricPath("personalRecords", "2026-01-02", ""),
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

// --- gating -----------------------------------------------------------------

Deno.test("selectMetrics drops gated metrics when gating is on", () => {
  const { selected, skipped } = selectMetrics(
    ["vo2max", "ftp", "trainingStatus"],
    { vo2max: true, ftp: false },
    true,
  );
  assertEquals(selected.sort(), ["vo2max"]);
  assertEquals(skipped.sort(), ["ftp", "trainingStatus"]);
});

Deno.test("selectMetrics keeps everything when gating is off", () => {
  const { selected, skipped } = selectMetrics(["vo2max", "ftp"], {}, false);
  assertEquals(selected.sort(), ["ftp", "vo2max"]);
  assertEquals(skipped, []);
});

// --- dates ------------------------------------------------------------------

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
  assertEquals(dateRange("2026-01-03", "2026-01-01"), []);
});

// --- metric merging ---------------------------------------------------------

/** A fresh, all-null performance row for merge tests. */
function row() {
  return {
    date: "2026-01-02",
    trainingStatus: null as string | null,
    trainingStatusFeedback: null as string | null,
    acuteLoad: null as number | null,
    trainingReadiness: null as number | null,
    trainingReadinessLevel: null as string | null,
    vo2maxRunning: null as number | null,
    vo2maxCycling: null as number | null,
    fitnessAge: null as number | null,
    racePrediction5k: null as number | null,
    racePrediction10k: null as number | null,
    racePredictionHalf: null as number | null,
    racePredictionMarathon: null as number | null,
    enduranceScore: null as number | null,
    hillScore: null as number | null,
  };
}

Deno.test("mergeMetric extracts VO2max per sport from the nested shape", () => {
  const r = row();
  mergeMetric(r, "vo2max", {
    generic: {
      calendarDate: "2026-01-02",
      vo2MaxPreciseValue: 45.3,
      fitnessAge: 42,
    },
    cycling: { vo2MaxPreciseValue: 52.1 },
  });
  assertEquals(r.vo2maxRunning, 45.3);
  assertEquals(r.vo2maxCycling, 52.1);
  assertEquals(r.fitnessAge, 42);
});

Deno.test("mergeMetric falls back to vo2MaxValue when precise is missing", () => {
  const r = row();
  mergeMetric(r, "vo2max", { generic: { vo2MaxValue: 46 } });
  assertEquals(r.vo2maxRunning, 46);
  assertEquals(r.vo2maxCycling, null);
});

Deno.test("mergeMetric keeps only the newest training-readiness snapshot", () => {
  const r = row();
  mergeMetric(r, "trainingReadiness", [
    { timestamp: "2026-01-02T06:00:00", score: 40, level: "LOW" },
    { timestamp: "2026-01-02T18:00:00", score: 75, level: "READY" },
  ]);
  assertEquals(r.trainingReadiness, 75);
  assertEquals(r.trainingReadinessLevel, "READY");
});

Deno.test("mergeMetric reads training status from the device-nested shape", () => {
  const r = row();
  mergeMetric(r, "trainingStatus", {
    mostRecentTrainingStatus: {
      latestTrainingStatusData: {
        "3412882339": {
          trainingStatus: {
            trainingStatusKey: "PRODUCTIVE",
            feedbackLong: "IMPROVING_FITNESS",
            acuteTrainingLoad: 320,
          },
        },
      },
    },
  });
  assertEquals(r.trainingStatus, "PRODUCTIVE");
  assertEquals(r.trainingStatusFeedback, "IMPROVING_FITNESS");
  assertEquals(r.acuteLoad, 320);
});

Deno.test("mergeMetric parses race predictions (seconds or clock string)", () => {
  const r = row();
  mergeMetric(r, "racePredictions", {
    racePredictions: [
      { calendarDate: "2026-01-01", time5K: 1200 },
      {
        calendarDate: "2026-01-02",
        time5K: 1180,
        time10K: 2500,
        timeHalfMarathon: 5500,
        timeMarathon: 11500,
      },
    ],
  });
  assertEquals(r.racePrediction5k, 1180);
  assertEquals(r.racePrediction10k, 2500);
  // A clock-string form is accepted too.
  const r2 = row();
  mergeMetric(r2, "racePredictions", { time5K: "0:19:40" });
  assertEquals(r2.racePrediction5k, 1180);
});

Deno.test("mergeMetric reads endurance and hill scores", () => {
  const r = row();
  mergeMetric(r, "enduranceScore", { overallScore: 6500 });
  mergeMetric(r, "hillScore", { overallScore: 72 });
  assertEquals(r.enduranceScore, 6500);
  assertEquals(r.hillScore, 72);
});

Deno.test("mergeMetric ignores null/empty bodies", () => {
  const r = row();
  mergeMetric(r, "vo2max", null);
  mergeMetric(r, "enduranceScore", {});
  assertEquals(r.vo2maxRunning, null);
  assertEquals(r.enduranceScore, null);
});

// --- latest values ----------------------------------------------------------

Deno.test("parseFtp reads the value from either shape", () => {
  assertEquals(parseFtp({ functionalThresholdPower: 285 }), 285);
  assertEquals(parseFtp([{ ftp: 290 }]), 290);
  assertEquals(parseFtp({}), null);
  assertEquals(parseFtp(null), null);
});

Deno.test("parsePersonalRecords normalises entries", () => {
  const prs = parsePersonalRecords([
    {
      typeId: 3,
      activityType: "running",
      distance: 5000,
      duration: 1180,
      prStartTimeGmt: "2026-01-02T07:00:00.0",
      activityId: 999,
      prTypeLabel: "5K",
    },
  ]);
  assertEquals(prs.length, 1);
  assertEquals(prs[0]!.typeId, 3);
  assertEquals(prs[0]!.activityType, "running");
  assertEquals(prs[0]!.distanceMeters, 5000);
  assertEquals(prs[0]!.durationSeconds, 1180);
  assertEquals(prs[0]!.activityId, "999");
  assertEquals(parsePersonalRecords({}).length, 0);
  assertEquals(parsePersonalRecords(null).length, 0);
});

Deno.test("maxOf ignores nulls and handles all-null", () => {
  assertEquals(maxOf([1, null, 5, 3]), 5);
  assertEquals(maxOf([null, null]), null);
  assertEquals(maxOf([]), null);
});
