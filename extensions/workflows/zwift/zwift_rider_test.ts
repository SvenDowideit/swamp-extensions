import { assertEquals } from "jsr:@std/assert@1";

import {
  abilityScoreFromWPerKg,
  buildAbilityProfile,
  categoryBand,
  ftpFromPowerCurve,
  model,
  normalizeActivity,
} from "./zwift_rider.ts";

const NOW = Date.parse("2026-09-21T07:00:00Z");
const DAY = 86_400_000;
const TZ = "Australia/Brisbane";

Deno.test("normalizeActivity maps a Zwift activity with local-time fields", () => {
  const activity = normalizeActivity(
    {
      id: 12345,
      name: "Morning Race",
      startDate: "2026-09-20T20:00:00.000+0000", // 06:00 Brisbane
      distanceInMeters: 40_000,
      durationInSeconds: 3600,
      totalElevation: 250,
      avgPower: 210,
      avgHeartRate: 150,
      worldId: 1,
      routeId: 99,
      sport: "CYCLING",
    },
    TZ,
    21,
    NOW,
  );

  assertEquals(activity?.id, "12345");
  assertEquals(activity?.localHour, 6);
  assertEquals(activity?.localDate, "2026-09-21");
  assertEquals(activity?.isoDayOfWeek, 1);
  assertEquals(activity?.distanceMeters, 40_000);
  assertEquals(activity?.avgSpeedKph, 40);
  assertEquals(activity?.avgPower, 210);
});

Deno.test("normalizeActivity derives speed when Zwift omits it", () => {
  const activity = normalizeActivity(
    {
      id: 1,
      startDate: "2026-09-20T20:00:00.000+0000",
      distanceInMeters: 16_000,
      durationInSeconds: 3600,
    },
    TZ,
    21,
    NOW,
  );
  assertEquals(activity?.avgSpeedKph, 16);
});

Deno.test("normalizeActivity weight decays with age", () => {
  const today = normalizeActivity(
    {
      id: 1,
      startDate: new Date(NOW).toISOString(),
    },
    TZ,
    21,
    NOW,
  );
  const threeWeeksAgo = normalizeActivity(
    {
      id: 2,
      startDate: new Date(NOW - 21 * DAY).toISOString(),
    },
    TZ,
    21,
    NOW,
  );

  assertEquals(today?.decayWeight, 1);
  assertEquals(threeWeeksAgo?.decayWeight, 0.5);
});

Deno.test("normalizeActivity returns null without an id or start", () => {
  assertEquals(
    normalizeActivity({ startDate: "2026-09-20T20:00:00Z" }, TZ, 21, NOW),
    null,
  );
  assertEquals(
    normalizeActivity({ id: 5, startDate: "junk" }, TZ, 21, NOW),
    null,
  );
});

Deno.test("ftpFromPowerCurve takes the 20-minute point times 0.95", () => {
  assertEquals(
    ftpFromPowerCurve({ pointsWatts: { "1200": { value: 250 } } }),
    238,
  );
  // Duration outside the 20-minute window is ignored.
  assertEquals(
    ftpFromPowerCurve({ pointsWatts: { "300": { value: 400 } } }),
    null,
  );
  assertEquals(ftpFromPowerCurve({}), null);
});

Deno.test("ftpFromPowerCurve accepts Zwift's array-of-points shape", () => {
  assertEquals(
    ftpFromPowerCurve({
      pointsWatts: [
        { duration: "300", value: 500 },
        { duration: "1200", value: 200 },
      ],
    }),
    190,
  );
});

Deno.test("categoryBand follows the w/kg thresholds", () => {
  assertEquals(categoryBand(4.5), "A");
  assertEquals(categoryBand(3.5), "B");
  assertEquals(categoryBand(2.7), "C");
  assertEquals(categoryBand(1.8), "D");
  assertEquals(categoryBand(1.0), "E");
  assertEquals(categoryBand(null), "unknown");
});

Deno.test("abilityScoreFromWPerKg maps the range and defaults to neutral", () => {
  assertEquals(abilityScoreFromWPerKg(1.5), 0);
  assertEquals(abilityScoreFromWPerKg(5.0), 100);
  assertEquals(abilityScoreFromWPerKg(3.25), 50);
  assertEquals(abilityScoreFromWPerKg(null), 50);
});

Deno.test("buildAbilityProfile weights recent rides more heavily", () => {
  // An 08:00Z ride is 18:00 in Brisbane (UTC+10).
  const recent = normalizeActivity(
    {
      id: 1,
      name: "Recent evening ride",
      startDate: "2026-09-21T08:00:00Z",
      durationInSeconds: 3600,
      distanceInMeters: 30_000,
      avgPower: 200,
    },
    TZ,
    21,
    NOW,
  );
  const old = normalizeActivity(
    {
      id: 2,
      name: "Old morning ride",
      startDate: "2026-07-20T20:00:00Z", // 06:00 Brisbane, 63 days before NOW
      durationInSeconds: 1800,
      distanceInMeters: 15_000,
      avgPower: 150,
    },
    TZ,
    21,
    NOW,
  );

  const ability = buildAbilityProfile([recent!, old!], {
    timeZone: TZ,
    halfLifeDays: 21,
    windowDays: 120,
    nowMs: NOW,
    ftpWatts: 260,
    ftpSource: "profile",
    weightKg: 80,
    racingScore: 350,
  });

  assertEquals(ability.rideCount, 2);
  assertEquals(ability.wPerKg, 3.25);
  assertEquals(ability.abilityScore, 50);
  assertEquals(ability.categoryBand, "B");
  assertEquals(ability.racingScore, 350);
  // The hour histogram must sum to 1 (a distribution, not raw counts).
  const hourSum = ability.hourHistogram.reduce((a, b) => a + b, 0);
  assertEquals(Math.round(hourSum * 100) / 100, 1);
  // The recent ride starts at 18:00 Brisbane (08:00Z), so it dominates.
  assertEquals(ability.preferredHours.includes(18), true);
  // Confidence is below 1 with only two rides.
  assertEquals(ability.confidence < 1, true);
});

Deno.test("buildAbilityProfile surfaces unknown ability for a new rider", () => {
  const ability = buildAbilityProfile([], {
    timeZone: TZ,
    halfLifeDays: 21,
    windowDays: 120,
    nowMs: NOW,
    ftpWatts: null,
    ftpSource: "none",
    weightKg: null,
    racingScore: null,
  });
  assertEquals(ability.rideCount, 0);
  assertEquals(ability.wPerKg, null);
  assertEquals(ability.categoryBand, "unknown");
  assertEquals(ability.abilityScore, 50);
  assertEquals(ability.confidence, 0);
  assertEquals(ability.preferredHours, []);
});

Deno.test("model exposes setup and sync plus the resources the workflow wires", () => {
  assertEquals(model.type, "@svendowideit/zwift-rider");
  assertEquals(typeof model.methods.setup.execute, "function");
  assertEquals(typeof model.methods.sync.execute, "function");
  for (const spec of ["activity", "history", "profile", "ability", "session"]) {
    assertEquals(spec in model.resources, true);
  }
});
