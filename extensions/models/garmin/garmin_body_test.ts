/**
 * Tests for `@svendowideit/garmin-body` path building, weight-unit conversion,
 * and weigh-in normalisation. All pure — no network, no credentials.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  dateRange,
  normalizeWeighIn,
  resolveWindow,
  weighInsOf,
  WEIGHT_DAY_PATH,
  WEIGHT_RANGE_PATH,
  weightToGrams,
} from "./garmin_body.ts";

// --- paths ------------------------------------------------------------------

Deno.test("WEIGHT_DAY_PATH and WEIGHT_RANGE_PATH build correctly", () => {
  assertEquals(
    WEIGHT_DAY_PATH("2026-01-02"),
    "/weight-service/weight/dayview/2026-01-02?includeAll=true",
  );
  assertEquals(
    WEIGHT_RANGE_PATH("2026-01-01", "2026-01-31"),
    "/weight-service/weight/range/2026-01-01/2026-01-31?includeAll=true",
  );
});

// --- window resolution ------------------------------------------------------

Deno.test("resolveWindow prefers range, then date, then yesterday", () => {
  assertEquals(
    resolveWindow({ startDate: "2026-01-01", endDate: "2026-01-03" }),
    {
      dates: ["2026-01-01", "2026-01-02", "2026-01-03"],
      mode: "range",
    },
  );
  assertEquals(resolveWindow({ date: "2026-01-05", mode: "daily" }), {
    dates: ["2026-01-05"],
    mode: "daily",
  });
  assertEquals(resolveWindow({}).dates.length, 1);
});

Deno.test("dateRange is inclusive", () => {
  assertEquals(dateRange("2026-01-01", "2026-01-02"), [
    "2026-01-01",
    "2026-01-02",
  ]);
  assertEquals(dateRange("2026-02-01", "2026-01-01"), []);
});

// --- unit conversion --------------------------------------------------------

Deno.test("weightToGrams treats the stored value as grams regardless of unitKey", () => {
  // Garmin stores grams; unitKey is the user's display preference, not the
  // unit of the value.
  assertEquals(weightToGrams(85300, "kg"), 85300);
  assertEquals(weightToGrams(85300, "lb"), 85300);
  assertEquals(weightToGrams(85300, null), 85300);
});

Deno.test("weightToGrams returns null for a null weight", () => {
  assertEquals(weightToGrams(null, "kg"), null);
});

// --- normalisation ----------------------------------------------------------

Deno.test("normalizeWeighIn maps weight-only data in kg", () => {
  const w = normalizeWeighIn({
    timestampGMT: "2026-01-02T06:00:00.0",
    weight: 85300,
    unitKey: "kg",
    bmi: 24.7,
  })!;
  assertEquals(w.date, "2026-01-02");
  assertEquals(w.weightGrams, 85300);
  assertEquals(w.weight, 85.3);
  assertEquals(w.bmi, 24.7);
  assertEquals(w.hasBodyComposition, false);
});

Deno.test("normalizeWeighIn converts to lb when configured", () => {
  const w = normalizeWeighIn(
    { timestampGMT: "2026-01-02T06:00:00.0", weight: 85300, unitKey: "kg" },
    "lb",
  )!;
  assertEquals(w.weightGrams, 85300);
  assert(w.weight !== null && Math.abs(w.weight - 188.05) < 0.1);
});

Deno.test("normalizeWeighIn captures body composition when present", () => {
  const w = normalizeWeighIn({
    timestampGMT: "2026-01-02T06:00:00.0",
    weight: 85300,
    unitKey: "kg",
    percentFat: 18.5,
    percentHydration: 55.2,
    muscleMass: 68000,
    boneMass: 3200,
    visceralFatRating: 8,
    metabolicAge: 42,
    basalMet: 1700,
  })!;
  assertEquals(w.bodyFatPercent, 18.5);
  assertEquals(w.bodyWaterPercent, 55.2);
  assertEquals(w.muscleMassGrams, 68000);
  assertEquals(w.boneMassGrams, 3200);
  assertEquals(w.visceralFatRating, 8);
  assertEquals(w.metabolicAge, 42);
  assertEquals(w.hasBodyComposition, true);
});

Deno.test("normalizeWeighIn falls back to calendarDate without a timestamp", () => {
  const w = normalizeWeighIn({ calendarDate: "2026-01-02", weight: 85000 })!;
  assertEquals(w.date, "2026-01-02");
  assertEquals(w.timestampMs, null);
});

Deno.test("normalizeWeighIn keeps the calendar day verbatim (no TZ shift)", () => {
  // Garmin timestamps carry no offset; a naive `Date.parse` would apply the
  // host timezone and could move the date back a day. The date must come from
  // the string's own date part.
  const w = normalizeWeighIn({
    timestampLocal: "2026-01-02T06:30:00.0",
    timestampGMT: "2026-01-01T20:30:00.0",
    weight: 85000,
  })!;
  assertEquals(w.date, "2026-01-02");
});

Deno.test("normalizeWeighIn returns null for an empty record", () => {
  assertEquals(normalizeWeighIn({}), null);
});

// --- response shaping -------------------------------------------------------

Deno.test("weighInsOf reads the day-view and range shapes", () => {
  assertEquals(
    weighInsOf({ dateWeightList: [{ weight: 85000 }] }).length,
    1,
  );
  assertEquals(weighInsOf([{ weight: 85000 }]).length, 1);
  assertEquals(weighInsOf({}).length, 0);
  assertEquals(weighInsOf(null).length, 0);
});
