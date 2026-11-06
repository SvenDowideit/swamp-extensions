import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  addDays,
  applyLoad,
  buildAvailability,
  buildDailyLoad,
  buildHistoryYears,
  dateMs,
  type HistoryRide,
  mergeRides,
  normalizeGarminRide,
  percentile,
  tssFromNp,
} from "./zwift_history.ts";

function ride(
  partial: Partial<HistoryRide> & { id: string; startMs: number },
): HistoryRide {
  const local = new Date(partial.startMs).toISOString().slice(0, 10);
  return {
    source: "zwift",
    name: "Ride",
    sport: "CYCLING",
    localDate: local,
    localHour: 7,
    isoDayOfWeek: 1,
    durationSeconds: 3600,
    movingSeconds: 3600,
    distanceMeters: 30_000,
    elevationMeters: 100,
    avgPower: 200,
    npWatts: 250,
    ftpWatts: 250,
    tss: 100,
    tssSource: "np",
    avgHr: 140,
    maxHr: 170,
    avgCadence: 90,
    maxPower: 600,
    eventId: null,
    routeId: null,
    worldId: null,
    garminTrainingLoad: null,
    detailFetchedAt: null,
    fitFetchedAt: null,
    ...partial,
  };
}

Deno.test("tssFromNp: one hour at FTP is 100", () => {
  assertEquals(tssFromNp(250, 250, 3600), 100);
  assertEquals(tssFromNp(175, 250, 3600), 49);
  assertEquals(tssFromNp(null, 250, 3600), null);
});

Deno.test("percentile interpolates", () => {
  assertEquals(percentile([1, 2, 3, 4], 0.5), 2.5);
  assertEquals(percentile([], 0.5), null);
});

Deno.test("normalizeGarminRide handles cycling and power", () => {
  const g = normalizeGarminRide({
    id: "1",
    name: "Outdoor ride",
    parentTypeKey: "cycling",
    startTimeGmt: "2026-01-01T06:00:00.000Z",
    durationSeconds: 3600,
    movingSeconds: 3500,
    distanceMeters: 30_000,
    elevationGainMeters: 200,
    avgPower: 190,
    normalizedPower: 240,
    avgHr: 135,
    trainingLoad: 80,
  }, "UTC");
  assertEquals(g?.source, "garmin");
  assertEquals(g?.sport, "CYCLING");
  assertEquals(g?.npWatts, 240);
  assertEquals(g?.garminTrainingLoad, 80);
});

Deno.test("mergeRides dedupes the same ride and keeps Zwift metadata", () => {
  const start = dateMs("2026-01-01") + 7 * 3_600_000;
  const z = ride({ id: "zwift-1", startMs: start, eventId: 42 });
  const g = ride({
    id: "garmin-1",
    source: "garmin",
    startMs: start + 60_000,
    eventId: null,
    npWatts: null,
    garminTrainingLoad: 70,
  });
  const merged = mergeRides([z], [g]);
  assertEquals(merged.duplicates, 1);
  assertEquals(merged.rides.length, 1);
  assertEquals(merged.rides[0].source, "zwift");
  assertEquals(merged.rides[0].eventId, 42);
  assertEquals(merged.rides[0].garminTrainingLoad, 70);
});

Deno.test("applyLoad labels NP, avg power and missing", () => {
  const start = dateMs("2026-01-01") + 7 * 3_600_000;
  const rides = [
    ride({ id: "a", startMs: start }),
    ride({
      id: "b",
      startMs: start + 86_400_000,
      npWatts: null,
      avgPower: 180,
    }),
    ride({
      id: "c",
      startMs: start + 2 * 86_400_000,
      npWatts: null,
      avgPower: null,
      ftpWatts: null,
    }),
  ];
  const loaded = applyLoad(rides, { ftpFallback: 250 });
  assertEquals(loaded[0].tssSource, "np");
  assertEquals(loaded[1].tssSource, "avg_power");
  assertEquals(loaded[2].tssSource, "missing");
});

Deno.test("buildDailyLoad includes rest days and an EWMA CTL", () => {
  const start = dateMs("2026-01-01") + 7 * 3_600_000;
  const rides = [ride({ id: "a", startMs: start })];
  const daily = buildDailyLoad(rides, {
    today: "2026-01-03",
    dataQuality: { npRides: 1, hrRides: 1, estimatedRides: 0, missingRides: 0 },
    sources: {
      zwift: {
        from: "2026-01-01",
        to: "2026-01-01",
        rides: 1,
        truncated: false,
      },
      garmin: { from: null, to: null, rides: 0, truncated: false },
      merged: { from: "2026-01-01", to: "2026-01-01", rides: 1, duplicates: 0 },
    },
  });
  assertEquals(daily.days.length, 3);
  assertEquals(daily.days[0].tss, 100);
  assertEquals(daily.days[1].tss, 0);
  assertAlmostEquals(daily.days[0].ctl, 2.4, 0.2);
});

Deno.test("buildAvailability infers days/hours and preferred days", () => {
  const rides: HistoryRide[] = [];
  let ms = dateMs("2026-01-05") + 7 * 3_600_000; // Monday
  for (let week = 0; week < 8; week++) {
    for (const offset of [0, 2, 4, 6]) {
      rides.push(
        ride({ id: `r-${week}-${offset}`, startMs: ms + offset * 86_400_000 }),
      );
    }
    ms += 7 * 86_400_000;
  }
  const a = buildAvailability(rides, { today: "2026-03-01", source: "merged" });
  assertEquals(a.rides, 32);
  assertEquals(a.daysPerWeek.p80, 4);
  assertEquals(a.preferredDays.length > 0, true);
  assertEquals(a.sessionMinutes.p50, 60);
});

Deno.test("buildHistoryYears sums and finds peak CTL", () => {
  const start = dateMs("2026-01-01") + 7 * 3_600_000;
  const rides = [ride({ id: "a", startMs: start })];
  const daily = buildDailyLoad(rides, {
    today: "2026-01-01",
    dataQuality: { npRides: 1, hrRides: 1, estimatedRides: 0, missingRides: 0 },
    sources: {
      zwift: {
        from: "2026-01-01",
        to: "2026-01-01",
        rides: 1,
        truncated: false,
      },
      garmin: { from: null, to: null, rides: 0, truncated: false },
      merged: { from: "2026-01-01", to: "2026-01-01", rides: 1, duplicates: 0 },
    },
  });
  const years = buildHistoryYears(daily.days, rides);
  assertEquals(years.length, 1);
  assertEquals(years[0].rides, 1);
  assertEquals(years[0].maxFtp, 250);
});

Deno.test("addDays crosses month boundaries", () => {
  assertEquals(addDays("2026-01-31", 1), "2026-02-01");
});
