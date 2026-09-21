import { assertEquals } from "jsr:@std/assert@1";

import {
  collectEvents,
  isRaceType,
  model,
  normalizeEvent,
  normalizeEventType,
} from "./zwift_events.ts";

const NOW = Date.parse("2026-09-21T07:00:00Z");
const DAY = 86_400_000;

Deno.test("normalizeEventType strips the EVENT_TYPE_ prefix", () => {
  assertEquals(normalizeEventType({ type: "EVENT_TYPE_RACE" }), "RACE");
  assertEquals(normalizeEventType({ eventType: "group_ride" }), "GROUP_RIDE");
  assertEquals(normalizeEventType({ type: "GROUP_WORKOUT" }), "GROUP_WORKOUT");
  assertEquals(normalizeEventType({}), "UNKNOWN");
});

Deno.test("isRaceType recognises races and both time-trial spellings", () => {
  assertEquals(isRaceType("RACE"), true);
  assertEquals(isRaceType("TIME_TRIAL"), true);
  assertEquals(isRaceType("TEAM_TIME_TRIAL"), true);
  assertEquals(isRaceType("EFONDO"), true);
  assertEquals(isRaceType("GROUP_RIDE"), false);
  assertEquals(isRaceType("GROUP_WORKOUT"), false);
});

Deno.test("normalizeEvent maps a real Zwift event payload", () => {
  const event = normalizeEvent({
    id: 5705885,
    name: "Ride Together",
    type: "EVENT_TYPE_GROUP_RIDE",
    sport: "CYCLING",
    worldId: 1,
    mapId: 11,
    routeId: 3141079998,
    distanceInMeters: 0,
    durationInSeconds: 5400,
    eventStart: "2026-09-21T07:45:00.000+0000",
    recurring: true,
    privateEvent: false,
    eventSubgroups: [
      {
        id: 7347011,
        subgroupLabel: "E",
        name: "Ride Together (E)",
        paceType: 1,
        fromPaceValue: 1,
        toPaceValue: 5,
        eventSubgroupStart: "2026-09-21T07:45:00.000+0000",
        durationInSeconds: 5400,
        distanceInMeters: 0,
        rulesSet: ["ALLOWS_LATE_JOIN"],
      },
    ],
  }, 32);

  assertEquals(event?.id, "5705885");
  assertEquals(event?.eventType, "GROUP_RIDE");
  assertEquals(event?.isRace, false);
  assertEquals(event?.subgroupCount, 1);
  assertEquals(event?.subgroups[0].label, "E");
  assertEquals(event?.subgroups[0].durationSeconds, 5400);
  assertEquals(event?.subgroups[0].durationEstimated, false);
});

Deno.test("normalizeEvent estimates a duration when Zwift omits one", () => {
  const event = normalizeEvent({
    id: 1,
    name: "Race",
    type: "EVENT_TYPE_RACE",
    eventStart: "2026-09-21T09:00:00.000+0000",
    distanceInMeters: 32_000,
    durationInSeconds: 0,
    eventSubgroups: [
      {
        id: 2,
        subgroupLabel: "A",
        eventSubgroupStart: "2026-09-21T09:00:00.000+0000",
        distanceInMeters: 32_000,
        durationInSeconds: 0,
      },
    ],
  }, 32);
  assertEquals(event?.subgroups[0].durationSeconds, 3600);
  assertEquals(event?.subgroups[0].durationEstimated, true);
});

Deno.test("normalizeEvent returns null without an id or a start time", () => {
  assertEquals(normalizeEvent({ name: "x" }, 32), null);
  assertEquals(normalizeEvent({ id: 5, eventStart: "nonsense" }, 32), null);
});

Deno.test("collectEvents de-duplicates and filters by horizon and type", async () => {
  const upcoming = [
    {
      id: 1,
      name: "Soon race",
      type: "EVENT_TYPE_RACE",
      sport: "CYCLING",
      eventStart: new Date(NOW + DAY).toISOString(),
      eventSeries: { id: 99, name: "Weekly Race" },
      eventSubgroups: [{
        id: 11,
        subgroupLabel: "A",
        eventSubgroupStart: new Date(NOW + DAY).toISOString(),
        durationInSeconds: 3600,
      }],
    },
    {
      id: 2,
      name: "Too far away",
      type: "EVENT_TYPE_RACE",
      sport: "CYCLING",
      eventStart: new Date(NOW + 30 * DAY).toISOString(),
      eventSubgroups: [],
    },
    {
      id: 3,
      name: "A workout we do not want",
      type: "EVENT_TYPE_GROUP_WORKOUT",
      sport: "CYCLING",
      eventStart: new Date(NOW + DAY).toISOString(),
      eventSubgroups: [],
    },
    {
      id: 4,
      name: "Private",
      type: "EVENT_TYPE_RACE",
      sport: "CYCLING",
      privateEvent: true,
      eventStart: new Date(NOW + DAY).toISOString(),
      eventSubgroups: [],
    },
    {
      id: 5,
      name: "A run",
      type: "EVENT_TYPE_RACE",
      sport: "RUNNING",
      eventStart: new Date(NOW + DAY).toISOString(),
      eventSubgroups: [],
    },
  ];

  // The same event id served a second time from its series must not duplicate.
  const seriesPage = {
    events: [
      upcoming[0],
      {
        id: 6,
        name: "Later race in the series",
        type: "EVENT_TYPE_RACE",
        sport: "CYCLING",
        eventStart: new Date(NOW + 5 * DAY).toISOString(),
        eventSubgroups: [{
          id: 61,
          subgroupLabel: "B",
          eventSubgroupStart: new Date(NOW + 5 * DAY).toISOString(),
          durationInSeconds: 1800,
        }],
      },
    ],
  };

  const calls: string[] = [];
  const fetchImpl = ((url: string | URL) => {
    const href = String(url);
    calls.push(href);
    const payload = href.includes("eventseries") ? seriesPage : upcoming;
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
  }) as typeof fetch;

  const events = await collectEvents(
    {
      apiBase: "https://example.test",
      horizonDays: 10,
      maxSeries: 10,
      maxEventsPerSeries: 200,
      userAgent: "test",
      sports: ["CYCLING"],
      eventTypes: [
        "EVENT_TYPE_RACE",
        "EVENT_TYPE_TIME_TRIAL",
        "EVENT_TYPE_GROUP_RIDE",
      ],
      includePrivate: false,
      referenceSpeedKph: 32,
    },
    NOW,
    fetchImpl,
    () => {},
  );

  assertEquals(events.map((e) => e.id), ["1", "6"]);
  // One upcoming fetch plus one series expansion.
  assertEquals(calls.length, 2);
  assertEquals(calls[1].includes("event_starts_after="), true);
  assertEquals(calls[1].includes("event_starts_before="), true);
});

Deno.test("collectEvents tolerates a failing series without losing the feed", async () => {
  const upcoming = [{
    id: 1,
    name: "Race",
    type: "EVENT_TYPE_RACE",
    sport: "CYCLING",
    eventStart: new Date(NOW + DAY).toISOString(),
    eventSeries: { id: 42, name: "Broken" },
    eventSubgroups: [],
  }];
  const fetchImpl = ((url: string | URL) => {
    const href = String(url);
    if (href.includes("eventseries")) {
      return Promise.resolve(new Response("nope", { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(upcoming), { status: 200 }),
    );
  }) as typeof fetch;

  const events = await collectEvents(
    {
      apiBase: "https://example.test",
      horizonDays: 10,
      maxSeries: 10,
      maxEventsPerSeries: 200,
      userAgent: "test",
      sports: ["CYCLING"],
      eventTypes: ["RACE"],
      includePrivate: false,
      referenceSpeedKph: 32,
    },
    NOW,
    fetchImpl,
    () => {},
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].id, "1");
});

Deno.test("model exposes a fetch method and a schedule resource", () => {
  assertEquals(model.type, "@svendowideit/zwift-events");
  assertEquals(typeof model.methods.fetch.execute, "function");
  assertEquals("schedule" in model.resources, true);
});
