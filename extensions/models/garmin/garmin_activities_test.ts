/**
 * Tests for `@svendowideit/garmin-activities` parsing and path building.
 *
 * All pure: path construction (the date-ranged list and the per-activity fan-out
 * paths), defensive field extraction, normalisation of the common and
 * strength-specific shapes, and list coercion. No network, no credentials.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ACTIVITY_LIST_PATH,
  activityDetailPath,
  activityDetailPaths,
  activityListPath,
  activityType,
  asActivityList,
  isoDate,
  normalizeActivity,
  pickNumber,
  pickString,
} from "./garmin_activities.ts";

// --- path building ----------------------------------------------------------

Deno.test("activityListPath builds a date-ranged paged path", () => {
  const path = activityListPath({
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    limit: 50,
    sortOrder: "desc",
  });
  assert(path.startsWith(`${ACTIVITY_LIST_PATH}?`));
  const q = new URLSearchParams(path.split("?")[1]);
  assertEquals(q.get("startDate"), "2026-01-01");
  assertEquals(q.get("endDate"), "2026-01-31");
  assertEquals(q.get("limit"), "50");
  assertEquals(q.get("sortOrder"), "desc");
  assertEquals(q.get("start"), "0");
});

Deno.test("activityListPath omits filters that were not supplied", () => {
  const q = new URLSearchParams(
    activityListPath({ startDate: "2026-01-01" }).split("?")[1],
  );
  assertEquals(q.get("activityType"), null);
  assertEquals(q.get("endDate"), null);
});

Deno.test("activityDetailPath builds each sub-resource path", () => {
  assertEquals(
    activityDetailPath("123", "detail"),
    "/activity-service/activity/123",
  );
  assertEquals(
    activityDetailPath("123", "splits"),
    "/activity-service/activity/123/splits",
  );
  assertEquals(
    activityDetailPath("123", "hrTimeInZones"),
    "/activity-service/activity/123/hrTimeInZones",
  );
});

Deno.test("activityDetailPaths fans out ids × kinds", () => {
  const paths = activityDetailPaths("123", ["detail", "splits", "weather"]);
  assertEquals(paths.length, 3);
  assert(paths.every((p) => p.startsWith("/activity-service/activity/123")));
});

// --- field extraction -------------------------------------------------------

Deno.test("pickNumber/pickString read alternates and coerce", () => {
  assertEquals(pickNumber({ avgPower: 210 }, "avgPower", "averagePower"), 210);
  assertEquals(
    pickNumber({ averagePower: "205" }, "avgPower", "averagePower"),
    205,
  );
  assertEquals(pickNumber({}, "missing"), null);
  assertEquals(
    pickString({ activityName: "Ride" }, "activityName", "name"),
    "Ride",
  );
  assertEquals(pickString({}, "nope"), "");
});

// --- activity type ----------------------------------------------------------

Deno.test("activityType reads nested and flat shapes", () => {
  assertEquals(
    activityType({
      activityType: { typeKey: "cycling", parentTypeKey: "cycling" },
    }),
    { typeKey: "cycling", parentTypeKey: "cycling" },
  );
  assertEquals(
    activityType({ activityTypeKey: "running" }),
    { typeKey: "running", parentTypeKey: "" },
  );
});

// --- normalisation ----------------------------------------------------------

Deno.test("normalizeActivity maps the common fields", () => {
  const a = normalizeActivity({
    activityId: 987654321,
    activityName: "Morning Ride",
    startTimeLocal: "2026-01-02 06:30:00",
    startTimeGMT: "2026-01-02 06:30:00",
    activityType: { typeKey: "cycling", parentTypeKey: "cycling" },
    distance: 40000,
    duration: 5400,
    movingDuration: 5200,
    elevationGain: 320,
    averageSpeed: 7.4,
    averageHR: 142,
    avgPower: 205,
    normPower: 220,
    calories: 900,
    aerobicTrainingEffect: 3.2,
    trainingEffectLabel: "IMPROVING",
  })!;
  assertEquals(a.id, "987654321");
  assertEquals(a.name, "Morning Ride");
  assertEquals(a.typeKey, "cycling");
  assertEquals(a.distanceMeters, 40000);
  assertEquals(a.durationSeconds, 5400);
  assertEquals(a.movingSeconds, 5200);
  assertEquals(a.elevationGainMeters, 320);
  assertEquals(a.normalizedPower, 220);
  assertEquals(a.trainingEffectLabel, "IMPROVING");
  assert(a.startMs !== null);
});

Deno.test("normalizeActivity captures strength-specific totals", () => {
  const a = normalizeActivity({
    activityId: 5,
    activityType: { typeKey: "strength_training" },
    totalSets: 12,
    totalReps: 96,
    totalVolume: 7200,
  })!;
  assertEquals(a.totalSets, 12);
  assertEquals(a.totalReps, 96);
  assertEquals(a.totalVolume, 7200);
  // Non-strength fields absent -> null, not zero.
  assertEquals(a.distanceMeters, null);
  assertEquals(a.avgPower, null);
});

Deno.test("normalizeActivity returns null without a usable id", () => {
  assertEquals(normalizeActivity({}), null);
  assertEquals(normalizeActivity({ activityId: null }), null);
  // Tolerates a string id and a missing name.
  const a = normalizeActivity({ activityId: "42" })!;
  assertEquals(a.id, "42");
  assertEquals(a.name, "activity-42");
  assertEquals(a.startMs, null);
});

// --- list coercion ----------------------------------------------------------

Deno.test("asActivityList handles array and wrapped shapes", () => {
  assertEquals(asActivityList([{ activityId: 1 }]).length, 1);
  assertEquals(asActivityList({ activities: [{ activityId: 1 }] }).length, 1);
  assertEquals(asActivityList({ results: [{ activityId: 1 }] }).length, 1);
  assertEquals(asActivityList(null).length, 0);
});

Deno.test("isoDate formats UTC YYYY-MM-DD", () => {
  assertEquals(isoDate(new Date("2026-01-02T23:00:00Z")), "2026-01-02");
});
