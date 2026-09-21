import { assertEquals } from "jsr:@std/assert@1";

import {
  clamp,
  decayWeight,
  durationBucketIndex,
  durationBucketLabel,
  estimateDurationSeconds,
  formatDuration,
  histogramAffinity,
  localParts,
  mean,
  normalizeHistogram,
  parseTimeMs,
} from "./zwift_util.ts";

Deno.test("parseTimeMs accepts Zwift ISO strings with bare offsets", () => {
  assertEquals(
    parseTimeMs("2026-09-21T07:00:00.000+0000"),
    Date.parse("2026-09-21T07:00:00.000Z"),
  );
  assertEquals(
    parseTimeMs("2026-09-21T10:00:00.000+02:00"),
    Date.parse("2026-09-21T08:00:00.000Z"),
  );
});

Deno.test("parseTimeMs distinguishes epoch seconds from milliseconds", () => {
  assertEquals(parseTimeMs(1789976700), 1789976700000);
  assertEquals(parseTimeMs(1789976700000), 1789976700000);
  assertEquals(parseTimeMs("1789976700000"), 1789976700000);
});

Deno.test("parseTimeMs returns null for junk", () => {
  assertEquals(parseTimeMs(""), null);
  assertEquals(parseTimeMs("not a date"), null);
  assertEquals(parseTimeMs(null), null);
  assertEquals(parseTimeMs(undefined), null);
});

Deno.test("localParts reports the hour in the requested timezone", () => {
  // 2026-09-21T07:00Z is 17:00 in Brisbane (UTC+10, no DST).
  const brisbane = localParts(
    Date.parse("2026-09-21T07:00:00Z"),
    "Australia/Brisbane",
  );
  assertEquals(brisbane.hour, 17);
  assertEquals(brisbane.date, "2026-09-21");

  const utc = localParts(Date.parse("2026-09-21T07:00:00Z"), "UTC");
  assertEquals(utc.hour, 7);
  assertEquals(utc.timeZone, "UTC");
});

Deno.test("localParts reports ISO weekday 1=Mon .. 7=Sun", () => {
  // 2026-09-21 is a Monday.
  const monday = localParts(Date.parse("2026-09-21T12:00:00Z"), "UTC");
  assertEquals(monday.isoDayOfWeek, 1);
  const sunday = localParts(Date.parse("2026-09-27T12:00:00Z"), "UTC");
  assertEquals(sunday.isoDayOfWeek, 7);
});

Deno.test("localParts treats the 'system' sentinel as host-local", () => {
  // The rider model persists `timeZone: "system"` when none is configured;
  // `Intl.DateTimeFormat` rejects that string, so the helper must normalise it.
  const parts = localParts(Date.parse("2026-09-21T07:00:00Z"), "system");
  assertEquals(parts.timeZone, "system");
  assertEquals(typeof parts.hour, "number");
  // An empty zone means the same thing and must also not throw.
  const empty = localParts(Date.parse("2026-09-21T07:00:00Z"), "");
  assertEquals(typeof empty.hour, "number");
});

Deno.test("decayWeight halves every half-life and never goes negative", () => {
  const day = 86_400_000;
  assertEquals(decayWeight(0, 21), 1);
  assertEquals(decayWeight(21 * day, 21), 0.5);
  assertEquals(decayWeight(42 * day, 21), 0.25);
  // Future timestamps must not weight above 1.
  assertEquals(decayWeight(-5 * day, 21), 1);
});

Deno.test("decayWeight with a non-positive half-life disables decay", () => {
  assertEquals(decayWeight(365 * 86_400_000, 0), 1);
  assertEquals(decayWeight(365 * 86_400_000, -1), 1);
});

Deno.test("clamp bounds on both sides", () => {
  assertEquals(clamp(5, 0, 10), 5);
  assertEquals(clamp(-5, 0, 10), 0);
  assertEquals(clamp(50, 0, 10), 10);
});

Deno.test("mean handles empty and populated lists", () => {
  assertEquals(mean([]), null);
  assertEquals(mean([10, 20, 30]), 20);
});

Deno.test("duration buckets are 30 minutes wide with an open final bucket", () => {
  assertEquals(durationBucketIndex(0), 0);
  assertEquals(durationBucketIndex(29), 0);
  assertEquals(durationBucketIndex(30), 1);
  assertEquals(durationBucketIndex(120), 4);
  // Anything past 4h saturates in the last bucket.
  assertEquals(durationBucketIndex(400), 8);
  assertEquals(durationBucketLabel(4), "120-150m");
  assertEquals(durationBucketLabel(8), "240m+");
});

Deno.test("normalizeHistogram produces a distribution summing to 1", () => {
  const result = normalizeHistogram([1, 1, 2]);
  assertEquals(result, [0.25, 0.25, 0.5]);
  // An empty histogram stays all-zero rather than dividing by zero.
  assertEquals(normalizeHistogram([0, 0]), [0, 0]);
});

Deno.test("histogramAffinity is maximal at the centre and decays away", () => {
  const hist = new Array<number>(24).fill(0);
  hist[17] = 1;
  assertEquals(Math.round(histogramAffinity(hist, 17, 1, 2) * 100) / 100, 1);
  const twoAway = histogramAffinity(hist, 19, 1, 2);
  assertEquals(twoAway > 0 && twoAway < 1, true);
  assertEquals(histogramAffinity(hist, 3, 1, 2), 0);
});

Deno.test("estimateDurationSeconds uses distance and speed, else fallback", () => {
  // 32 km at 32 km/h is exactly one hour.
  assertEquals(estimateDurationSeconds(32_000, 32), 3600);
  assertEquals(estimateDurationSeconds(0, 32, 1800), 1800);
  assertEquals(estimateDurationSeconds(32_000, null, 1800), 1800);
  assertEquals(estimateDurationSeconds(32_000, 0, 1800), 1800);
});

Deno.test("formatDuration renders minutes and hours", () => {
  assertEquals(formatDuration(0), "unknown");
  assertEquals(formatDuration(1800), "30m");
  assertEquals(formatDuration(3600), "1h");
  assertEquals(formatDuration(5400), "1h30m");
});
