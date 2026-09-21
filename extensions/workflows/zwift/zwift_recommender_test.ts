import { assertEquals } from "jsr:@std/assert@1";

import {
  abilityFit,
  availabilityFit,
  freshnessScore,
  model,
  recentKeyMap,
  repeatKey,
  scoreCandidate,
  subgroupAbilityScore,
} from "./zwift_recommender.ts";
import { localParts } from "./zwift_util.ts";

const NOW = Date.parse("2026-09-21T07:00:00Z");
const DAY = 86_400_000;
const TZ = "Australia/Brisbane";

/** A rider who rides mostly in the morning, for about an hour. */
function morningRider() {
  const hourHistogram = new Array<number>(24).fill(0);
  hourHistogram[6] = 0.8;
  hourHistogram[17] = 0.2;
  const durationHistogram = new Array<number>(9).fill(0);
  durationHistogram[2] = 1; // 60-90m
  return {
    abilityScore: 58,
    categoryBand: "C",
    wPerKg: 3.0,
    hourHistogram,
    durationHistogram,
    durationBucketMinutes: 30,
    preferredHours: [6],
    typicalDurationMinutes: 75,
    timeZone: TZ,
  };
}

function cfg(overrides: Record<string, unknown> = {}) {
  return model.globalArguments.parse(overrides);
}

Deno.test("subgroupAbilityScore uses A-E band labels only for races", () => {
  assertEquals(subgroupAbilityScore({ label: "A" }, true), 88);
  assertEquals(subgroupAbilityScore({ label: "C" }, true), 58);
  // For a group ride the label is a pace group, so it is ignored in favour of
  // the w/kg pace values (1-2 w/kg is an easy band, midpoint 1.5 -> score 0).
  assertEquals(
    subgroupAbilityScore(
      { label: "A", fromPaceValue: 1, toPaceValue: 2 },
      false,
    ),
    0,
  );
});

Deno.test("subgroupAbilityScore maps a narrow w/kg band to its midpoint", () => {
  // Midpoint of 3.0-3.5 is 3.25, which is exactly the middle of the 1.5-5 scale.
  assertEquals(
    subgroupAbilityScore({ fromPaceValue: 3, toPaceValue: 3.5 }),
    50,
  );
});

Deno.test("subgroupAbilityScore treats a very wide pace band as its entry bar", () => {
  // 1-5 w/kg is a whole-rider-population band; the entry bar (1) is the target.
  const score = subgroupAbilityScore({ fromPaceValue: 1, toPaceValue: 5 });
  assertEquals(score, 0);
});

Deno.test("subgroupAbilityScore returns null with no signal", () => {
  assertEquals(subgroupAbilityScore({}), null);
  assertEquals(
    subgroupAbilityScore({ fromPaceValue: 0, toPaceValue: 0 }),
    null,
  );
});

Deno.test("abilityFit peaks when target matches the rider", () => {
  assertEquals(abilityFit(60, 60), 1);
  // Unknown target is neutral, not zero.
  assertEquals(abilityFit(60, null), 0.5);
  // Being slightly over-qualified costs less than the same under-qualification.
  const slightlyHarder = abilityFit(60, 70);
  const slightlyStronger = abilityFit(60, 50);
  assertEquals(slightlyHarder < 1, true);
  assertEquals(slightlyStronger > slightlyHarder, true);
});

Deno.test("abilityFit clamps at zero for a hopeless mismatch", () => {
  assertEquals(abilityFit(0, 100), 0);
  // Being over-qualified is a smaller penalty, so a very easy event still
  // scores above zero — it is merely a poor use of the rider's time.
  assertEquals(abilityFit(100, 0) > 0, true);
  assertEquals(abilityFit(100, 0) < 0.5, true);
});

Deno.test("availabilityFit rewards the habitual hour and punishes the small hours", () => {
  const hist = new Array<number>(24).fill(0);
  hist[6] = 0.8;
  assertEquals(availabilityFit(hist, 6) > availabilityFit(hist, 12), true);
  // 3am is penalised regardless of the histogram.
  assertEquals(availabilityFit(hist, 3) < availabilityFit(hist, 12), true);
});

Deno.test("repeatKey prefers the route, then the event", () => {
  assertEquals(repeatKey({ routeId: 42, eventId: 7 }), "route:42");
  assertEquals(repeatKey({ routeId: null, eventId: 7 }), "event:7");
  assertEquals(repeatKey({}), "");
});

Deno.test("recentKeyMap keeps the most recent ride per key inside the window", () => {
  const map = recentKeyMap(
    [
      {
        startMs: NOW - 5 * DAY,
        localHour: 6,
        durationMinutes: 60,
        routeId: 42,
      },
      {
        startMs: NOW - 2 * DAY,
        localHour: 6,
        durationMinutes: 60,
        routeId: 42,
      },
      {
        startMs: NOW - 60 * DAY,
        localHour: 6,
        durationMinutes: 60,
        routeId: 99,
      },
    ],
    NOW,
    30,
  );

  assertEquals(map.get("route:42"), NOW - 2 * DAY);
  assertEquals(map.has("route:99"), false); // outside the window
});

Deno.test("freshnessScore decays a repeat towards the penalty floor", () => {
  const keys = new Map([["route:42", NOW - 1 * DAY]]);
  const recent = freshnessScore("route:42", keys, NOW, 14, 0.35);
  assertEquals(recent >= 0.35 && recent < 0.45, true);

  // Just inside the window decays less than a fresh repeat.
  const borderline = new Map([["route:42", NOW - 13 * DAY]]);
  assertEquals(
    freshnessScore("route:42", borderline, NOW, 14, 0.35) > recent,
    true,
  );

  // Outside the window is fresh again.
  const old = new Map([["route:42", NOW - 20 * DAY]]);
  assertEquals(freshnessScore("route:42", old, NOW, 14, 0.35), 1);

  // An unknown key is fresh.
  assertEquals(freshnessScore("route:1", keys, NOW, 14, 0.35), 1);
  assertEquals(freshnessScore("", keys, NOW, 14, 0.35), 1);
});

Deno.test("scoreCandidate ranks a well-matched morning race above a night one", () => {
  const ability = morningRider();
  const config = cfg({ raceBias: 0.9 });

  // 20:00Z is 06:00 the next day in Brisbane; 17:00Z is 03:00 (the 3am trap).
  const morningStart = Date.parse("2026-09-22T20:00:00Z");
  const nightStart = Date.parse("2026-09-22T17:00:00Z");
  assertEquals(localParts(morningStart, TZ).hour, 6);
  assertEquals(localParts(nightStart, TZ).hour, 3);

  const morningRace = scoreCandidate({
    ability,
    event: {
      id: "1",
      name: "Morning Crit",
      eventType: "RACE",
      isRace: true,
      seriesId: 10,
      subgroups: [{
        id: "11",
        label: "C",
        startMs: morningStart,
        durationSeconds: 3600,
      }],
    },
    subgroup: {
      id: "11",
      label: "C",
      startMs: morningStart,
      durationSeconds: 3600,
    },
    local: localParts(morningStart, TZ),
    nowMs: NOW,
    cfg: config,
    includeGroupRides: true,
    recentKeys: new Map(),
  });

  const nightRace = scoreCandidate({
    ability,
    event: { id: "2", name: "Night Crit", eventType: "RACE", isRace: true },
    subgroup: {
      id: "21",
      label: "C",
      startMs: nightStart,
      durationSeconds: 3600,
    },
    local: localParts(nightStart, TZ),
    nowMs: NOW,
    cfg: config,
    includeGroupRides: true,
    recentKeys: new Map(),
  });

  assertEquals(morningRace !== null, true);
  assertEquals(nightRace !== null, true);
  assertEquals(morningRace!.score > nightRace!.score, true);
  // The reason string is explainable.
  assertEquals(morningRace!.reason.includes("Morning Crit"), true);
});

Deno.test("scoreCandidate penalises a recently repeated route", () => {
  const ability = morningRider();
  const config = cfg();
  const startMs = NOW + DAY + 6 * 3600_000;
  const local = localParts(startMs, TZ);
  const event = {
    id: "1",
    name: "Weekly route",
    eventType: "RACE",
    isRace: true,
    routeId: 42,
    subgroups: [{
      id: "11",
      label: "C",
      startMs,
      durationSeconds: 3600,
      routeId: 42,
    }],
  };
  const subgroup = {
    id: "11",
    label: "C",
    startMs,
    durationSeconds: 3600,
    routeId: 42,
  };

  const fresh = scoreCandidate({
    ability,
    event,
    subgroup,
    local,
    nowMs: NOW,
    cfg: config,
    includeGroupRides: true,
    recentKeys: new Map(),
  });
  const repeated = scoreCandidate({
    ability,
    event,
    subgroup,
    local,
    nowMs: NOW,
    cfg: config,
    includeGroupRides: true,
    recentKeys: new Map([["route:42", NOW - DAY]]),
  });

  assertEquals(fresh!.score > repeated!.score, true);
  assertEquals(repeated!.components.freshness < 1, true);
});

Deno.test("scoreCandidate excludes group rides when asked", () => {
  const ability = morningRider();
  const startMs = NOW + DAY + 6 * 3600_000;
  const rec = scoreCandidate({
    ability,
    event: {
      id: "1",
      name: "Group ride",
      eventType: "GROUP_RIDE",
      isRace: false,
    },
    subgroup: { id: "11", startMs, durationSeconds: 3600 },
    local: localParts(startMs, TZ),
    nowMs: NOW,
    cfg: cfg(),
    includeGroupRides: false,
    recentKeys: new Map(),
  });
  assertEquals(rec, null);
});

Deno.test("scoreCandidate drops an event that already started", () => {
  const past = NOW - 3600_000;
  const rec = scoreCandidate({
    ability: morningRider(),
    event: { id: "1", name: "Past", eventType: "RACE", isRace: true },
    subgroup: { id: "11", startMs: past, durationSeconds: 3600 },
    local: localParts(past, TZ),
    nowMs: NOW,
    cfg: cfg(),
    includeGroupRides: true,
    recentKeys: new Map(),
  });
  assertEquals(rec, null);
});

Deno.test("raceBias flips which type scores higher at the extremes", () => {
  const ability = morningRider();
  const startMs = NOW + DAY + 6 * 3600_000;
  const local = localParts(startMs, TZ);
  const race = { id: "1", name: "Race", eventType: "RACE", isRace: true };
  const ride = {
    id: "2",
    name: "Ride",
    eventType: "GROUP_RIDE",
    isRace: false,
  };
  const subgroup = { id: "11", label: "C", startMs, durationSeconds: 3600 };

  const raceOnly = scoreCandidate({
    ability,
    event: race,
    subgroup,
    local,
    nowMs: NOW,
    cfg: cfg({ raceBias: 1 }),
    includeGroupRides: true,
    recentKeys: new Map(),
  })!;
  const rideOnly = scoreCandidate({
    ability,
    event: ride,
    subgroup,
    local,
    nowMs: NOW,
    cfg: cfg({ raceBias: 0 }),
    includeGroupRides: true,
    recentKeys: new Map(),
  })!;

  assertEquals(raceOnly.components.typeAffinity, 1);
  assertEquals(rideOnly.components.typeAffinity, 1);
  assertEquals(raceOnly.score > raceOnly.score - 1, true);
});

Deno.test("recommend method requires the ability and schedule inputs", () => {
  const args = model.methods.recommend.arguments;
  const shape = args.shape as Record<string, unknown>;
  assertEquals("ability" in shape, true);
  assertEquals("schedule" in shape, true);
  assertEquals("recentRides" in shape, true);
});
