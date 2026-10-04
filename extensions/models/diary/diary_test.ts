/**
 * Unit tests for the diary extension's pure helpers and its three execute
 * functions. The helpers are tested directly; the execute functions get a
 * hand-built method context so no swamp runtime or real vault is needed.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  BEGIN_MARKER,
  calendarDate,
  type CollectedDay,
  type CollectedRide,
  END_MARKER,
  extension,
  filterActivities,
  formatCount,
  formatDistance,
  formatDuration,
  indexSchedule,
  mergeManagedSection,
  renderManagedSection,
  renderPage,
  resolveDate,
  selectSuggestions,
  summariseRides,
  zwiftEventUrl,
} from "./diary.ts";

const ride = (
  overrides: Partial<CollectedRide> = {},
): CollectedRide => ({
  name: "Zwift - Make It Sting",
  type: "virtual_ride",
  startTimeLocal: "2026-10-04 16:28:44",
  durationSeconds: 938,
  distanceMeters: 7508.91,
  elevationGainMeters: 70,
  avgPower: 175,
  avgHr: 135,
  calories: 157,
  ...overrides,
});

const day = (overrides: Partial<CollectedDay> = {}): CollectedDay => ({
  date: "2026-10-04",
  generatedAt: "2026-10-04T00:00:00.000Z",
  timezone: "Australia/Brisbane",
  rides: [ride()],
  totals: summariseRides([ride()]),
  wellness: {
    steps: 5112,
    stepGoal: 5960,
    sleepSeconds: 29787,
    sleepScore: 82,
    restingHeartRate: 48,
    avgStress: 23,
    bodyBatteryHighest: 97,
    bodyBatteryLowest: 39,
  },
  suggested: [],
  truncated: false,
  missing: [],
  ...overrides,
});

Deno.test("calendarDate resolves the local day in a timezone", () => {
  // 20:00 UTC on the 4th is 06:00 on the 5th in Brisbane (+10).
  assertEquals(
    calendarDate("Australia/Brisbane", new Date("2026-10-04T20:00:00Z")),
    "2026-10-05",
  );
  assertEquals(
    calendarDate("Australia/Brisbane", new Date("2026-10-03T20:00:00Z")),
    "2026-10-04",
  );
  assertEquals(
    calendarDate("UTC", new Date("2026-10-04T20:00:00Z")),
    "2026-10-04",
  );
});

Deno.test("resolveDate treats blank as today and passes explicit dates through", () => {
  const now = new Date("2026-10-04T20:00:00Z"); // 2026-10-05 in Brisbane
  assertEquals(resolveDate(undefined, "Australia/Brisbane", now), "2026-10-05");
  assertEquals(resolveDate("", "Australia/Brisbane", now), "2026-10-05");
  assertEquals(resolveDate("   ", "Australia/Brisbane", now), "2026-10-05");
  assertEquals(
    resolveDate("2026-09-30", "Australia/Brisbane", now),
    "2026-09-30",
  );
  assertEquals(resolveDate(" 2026-09-30 ", "UTC", now), "2026-09-30");
});

Deno.test("filterActivities keeps only the requested day", () => {
  const rides = [
    ride({ name: "a", startTimeLocal: "2026-10-04 06:00:00" }),
    ride({ name: "b", startTimeLocal: "2026-10-03 21:00:00" }),
    ride({ name: "c", startTimeLocal: "2026-10-05 00:00:00" }),
  ];
  const kept = filterActivities(rides, "2026-10-04");
  assertEquals(kept.map((r) => r.name), ["a"]);
});

Deno.test("summariseRides totals duration, distance, climb and calories", () => {
  const totals = summariseRides([
    ride({ durationSeconds: 100, distanceMeters: 1000, calories: 10 }),
    ride({ durationSeconds: 200, distanceMeters: 3000, calories: 40 }),
  ]);
  assertEquals(totals, {
    rideCount: 2,
    durationSeconds: 300,
    distanceMeters: 4000,
    elevationGainMeters: 140,
    calories: 50,
  });
});

Deno.test("formatDuration and formatDistance render human units", () => {
  assertEquals(formatDuration(938), "15m");
  assertEquals(formatDuration(3660), "1h 1m");
  assertEquals(formatDistance(7508.91), "7.5 km");
  assertEquals(formatCount(5112), "5,112");
});

Deno.test("zwiftEventUrl builds a stable event link", () => {
  assertEquals(
    zwiftEventUrl("5694893"),
    "https://www.zwift.com/events/view/5694893",
  );
});

Deno.test("indexSchedule maps events and their subgroups by id", () => {
  const index = indexSchedule([{
    id: "5694893",
    name: "Loop de Loop",
    subgroups: [{ id: "7329951", label: "D", name: "Loop de Loop (D)" }],
  }]);
  assertEquals(index.get("5694893")?.name, "Loop de Loop");
  assertEquals(
    index.get("5694893")?.subgroups.get("7329951")?.name,
    "Loop de Loop (D)",
  );
});

Deno.test("selectSuggestions filters by date, caps at topN and links events", () => {
  const recommendations = [
    {
      rank: 1,
      eventId: "111",
      subgroupId: "1",
      eventName: "Race A",
      eventType: "RACE",
      subgroupLabel: "C",
      localDate: "2026-10-04",
      localHour: 6,
      localMinute: 5,
      score: 66.4,
      distanceMeters: 48000,
      durationSeconds: 3600,
      reason: "ability 97%",
    },
    {
      rank: 2,
      eventId: "222",
      subgroupId: "2",
      eventName: "Group B",
      eventType: "GROUP_RIDE",
      subgroupLabel: "",
      localDate: "2026-10-04",
      localHour: 12,
      localMinute: 30,
      score: 55,
      distanceMeters: 0,
      durationSeconds: 0,
      reason: "habit match",
    },
    {
      rank: 3,
      eventId: "333",
      subgroupId: "3",
      eventName: "Other day",
      eventType: "RACE",
      localDate: "2026-10-05",
      reason: "nope",
    },
  ];
  const schedule = indexSchedule([
    {
      id: "222",
      name: "Group B",
      subgroups: [{ id: "2", name: "Group B (B)" }],
    },
  ]);

  const two = selectSuggestions(recommendations, "2026-10-04", 2, schedule);
  assertEquals(two.length, 2);
  assertEquals(two[0].localTime, "06:05");
  assertEquals(two[0].url, "https://www.zwift.com/events/view/111");
  // Falls back to the schedule's subgroup name when the pick has none.
  assertEquals(two[1].subgroupLabel, "Group B (B)");
  assertEquals(two[1].url, "https://www.zwift.com/events/view/222");

  const capped = selectSuggestions(recommendations, "2026-10-04", 1, schedule);
  assertEquals(capped.length, 1);
});

Deno.test("renderManagedSection wraps content in markers with all sections", () => {
  const md = renderManagedSection(day({
    suggested: [{
      rank: 1,
      eventName: "Race A",
      seriesName: "",
      eventType: "RACE",
      subgroupLabel: "C",
      localTime: "06:05",
      distanceMeters: 48000,
      durationSeconds: 3600,
      score: 66.4,
      reason: "ability 97%",
      url: "https://www.zwift.com/events/view/111",
    }],
  }));
  assertStringIncludes(md, BEGIN_MARKER);
  assertStringIncludes(md, END_MARKER);
  assertStringIncludes(md, "## Health");
  assertStringIncludes(md, "**Sleep:** 8h 16m (score 82)");
  assertStringIncludes(md, "**Steps:** 5,112 of 5,960");
  assertStringIncludes(md, "## Activities");
  assertStringIncludes(md, "## Suggested rides today");
  assertStringIncludes(md, "ability 97%");
  assertStringIncludes(md, "[Zwift](https://www.zwift.com/events/view/111)");
});

Deno.test("renderManagedSection shows sleep without a score when absent", () => {
  const md = renderManagedSection(day({
    wellness: {
      steps: 100,
      stepGoal: null,
      sleepSeconds: 3600,
      sleepScore: null,
      restingHeartRate: null,
      avgStress: null,
      bodyBatteryHighest: null,
      bodyBatteryLowest: null,
    },
  }));
  assertStringIncludes(md, "**Sleep:** 1h 0m");
  assertEquals(md.includes("(score"), false);
  assertStringIncludes(md, "**Steps:** 100");
});

Deno.test("renderManagedSection handles a rest day with no picks", () => {
  const md = renderManagedSection(
    day({ rides: [], suggested: [], wellness: null }),
  );
  assertStringIncludes(md, "No Garmin wellness data for this day");
  assertStringIncludes(md, "Rest day");
  assertStringIncludes(md, "No matching Zwift events");
});

Deno.test("renderPage includes the heading and a to-do section", () => {
  const md = renderPage(day());
  assertStringIncludes(md, "# 2026-10-04");
  assertStringIncludes(md, BEGIN_MARKER);
  assertStringIncludes(md, "## To do");
});

Deno.test("mergeManagedSection replaces only the marked region", () => {
  const existing = [
    "# 2026-10-04",
    "",
    "My own note about the day.",
    "",
    BEGIN_MARKER,
    "stale machine content",
    END_MARKER,
    "",
    "## To do",
    "- [x] booked the mechanic",
  ].join("\n");
  const merged = mergeManagedSection(
    existing,
    `${BEGIN_MARKER}\nfresh\n${END_MARKER}`,
  );
  assertStringIncludes(merged, "My own note about the day.");
  assertStringIncludes(merged, "- [x] booked the mechanic");
  assertStringIncludes(merged, "fresh");
  assertEquals(merged.includes("stale machine content"), false);
});

Deno.test("mergeManagedSection inserts after the heading when no markers exist", () => {
  const merged = mergeManagedSection(
    "# 2026-10-04\n\nMy prose\n",
    `${BEGIN_MARKER}\nblock\n${END_MARKER}`,
  );
  assertStringIncludes(merged, "# 2026-10-04");
  assertStringIncludes(merged, "My prose");
  assertStringIncludes(merged, "block");
  // Managed block sits between the heading and the prose.
  assertEquals(merged.indexOf("block") < merged.indexOf("My prose"), true);
});

Deno.test("mergeManagedSection creates a fresh note for empty input", () => {
  const merged = mergeManagedSection(
    "",
    `${BEGIN_MARKER}\nblock\n${END_MARKER}`,
  );
  assertStringIncludes(merged, "block");
  assertStringIncludes(merged, "## To do");
});

// ---------------------------------------------------------------------------
// execute functions against a hand-built context
// ---------------------------------------------------------------------------

type MethodHandler = {
  execute: (
    args: Record<string, unknown>,
    context: unknown,
  ) => Promise<{ dataHandles: Array<{ name: string }> }>;
};

const methods = extension.methods as unknown as Array<
  Record<string, MethodHandler>
>;
const collect = methods[0].collect;
const render = methods[1].render;
const publish = methods[2].publish;

interface Written {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

function fakeContext(opts: {
  modelData?: Record<string, Array<Record<string, unknown>>>;
  stored?: Record<string, Record<string, unknown>>;
  runModel?: (
    o: {
      definition: string;
      method: string;
      arguments?: Record<string, unknown>;
    },
  ) => Promise<
    | { ok: true; resources: Array<{ name: string }> }
    | { ok: false; error: { message: string } }
  >;
} = {}) {
  const written: Written[] = [];
  const context = {
    globalArgs: {},
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    readResource: (name: string) =>
      Promise.resolve(opts.stored?.[name] ?? null),
    readModelData: (name: string, spec?: string) => {
      const key = `${name}/${spec}`;
      const attributes = opts.modelData?.[key];
      if (attributes === undefined) return Promise.resolve([]);
      return Promise.resolve(
        attributes.map((a, i) => ({ name: `${name}-${i}`, attributes: a })),
      );
    },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
    runModel: opts.runModel,
  };
  return { context, written };
}

Deno.test("collect reads the synced models and writes a filtered day", async () => {
  const { context, written } = fakeContext({
    modelData: {
      "garmin-activities/list": [{
        activities: [
          {
            id: "1",
            name: "Morning ride",
            typeKey: "virtual_ride",
            startTimeLocal: "2026-10-04 06:00:00",
            durationSeconds: 3600,
            distanceMeters: 40000,
            elevationGainMeters: 200,
            avgPower: 180,
            avgHr: 140,
            calories: 500,
          },
          {
            id: "2",
            name: "Yesterday",
            typeKey: "virtual_ride",
            startTimeLocal: "2026-10-03 06:00:00",
            durationSeconds: 100,
          },
        ],
      }],
      "garmin-health/daily": [{
        date: "2026-10-04",
        steps: 8000,
        stepGoal: 6000,
        sleepSeconds: 28800,
        sleepScore: 75,
        restingHeartRate: 48,
        avgStress: 20,
        bodyBatteryHighest: 90,
        bodyBatteryLowest: 40,
      }],
      "zwift-recommender/recommendations": [{
        recommendations: [{
          rank: 1,
          eventId: "111",
          subgroupId: "1",
          eventName: "Race A",
          eventType: "RACE",
          subgroupLabel: "C",
          localDate: "2026-10-04",
          localHour: 6,
          localMinute: 5,
          score: 66,
          reason: "ability 97%",
        }],
      }],
      "zwift-events/schedule": [{
        events: [{
          id: "111",
          name: "Race A",
          subgroups: [{ id: "1", name: "Race A (C)" }],
        }],
      }],
    },
  });

  await collect.execute(
    { timezone: "Australia/Brisbane", date: "2026-10-04", topN: 5 },
    context,
  );

  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "collect");
  assertEquals(written[0].name, "daily-2026-10-04");
  const rides = written[0].data.rides as Array<Record<string, unknown>>;
  assertEquals(rides.length, 1);
  assertEquals(rides[0].name, "Morning ride");
  const suggested = written[0].data.suggested as Array<Record<string, unknown>>;
  assertEquals(suggested.length, 1);
  assertEquals(suggested[0].url, "https://www.zwift.com/events/view/111");
  assertEquals(written[0].data.truncated, false);
  assertEquals(written[0].data.missing, []);
});

Deno.test("collect records missing sources instead of failing", async () => {
  const { context, written } = fakeContext();
  await collect.execute(
    { timezone: "UTC", date: "2026-10-04", topN: 5 },
    context,
  );
  const missing = written[0].data.missing as string[];
  assertEquals(missing.includes("garmin-activities/list"), true);
  assertEquals(missing.includes("zwift-recommender/recommendations"), true);
  assertEquals(written[0].data.rides, []);
});

Deno.test("collect flags truncated when more picks exist than topN", async () => {
  const pick = (rank: number) => ({
    rank,
    eventId: String(rank),
    subgroupId: "1",
    eventName: `Race ${rank}`,
    eventType: "RACE",
    localDate: "2026-10-04",
    localHour: 6,
    localMinute: 0,
    score: 50,
    reason: "fit",
  });
  const { context, written } = fakeContext({
    modelData: {
      "garmin-activities/list": [{ activities: [] }],
      "garmin-health/daily": [],
      "zwift-events/schedule": [{ events: [] }],
      "zwift-recommender/recommendations": [{
        recommendations: [pick(1), pick(2), pick(3)],
      }],
    },
  });
  await collect.execute(
    { timezone: "UTC", date: "2026-10-04", topN: 2 },
    context,
  );
  assertEquals((written[0].data.suggested as unknown[]).length, 2);
  assertEquals(written[0].data.truncated, true);
});

Deno.test("render writes a page resource from the collect resource", async () => {
  const { context, written } = fakeContext({
    stored: { "daily-2026-10-04": day() as unknown as Record<string, unknown> },
  });
  await render.execute(
    { timezone: "UTC", date: "2026-10-04" },
    context,
  );
  assertEquals(written[0].specName, "page");
  assertStringIncludes(written[0].data.markdown as string, "# 2026-10-04");
});

Deno.test("render fails clearly when collect has not run", async () => {
  const { context } = fakeContext();
  let threw = false;
  try {
    await render.execute({ timezone: "UTC", date: "2026-10-04" }, context);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("publish merges into the existing note and writes via the vault", async () => {
  const calls: Array<{ method: string; arguments?: Record<string, unknown> }> =
    [];
  const { context, written } = fakeContext({
    stored: {
      "daily-2026-10-04": day({
        suggested: [{
          rank: 1,
          eventName: "Race A",
          seriesName: "",
          eventType: "RACE",
          subgroupLabel: "C",
          localTime: "06:05",
          distanceMeters: 0,
          durationSeconds: 0,
          score: 66,
          reason: "ability 97%",
          url: "https://www.zwift.com/events/view/111",
        }],
      }) as unknown as Record<string, unknown>,
      "note-handle": {
        content:
          `# 2026-10-04\n\nMy prose\n\n${BEGIN_MARKER}\nstale\n${END_MARKER}\n`,
      },
    },
    runModel: (o) => {
      calls.push({ method: o.method, arguments: o.arguments });
      if (o.method === "read") {
        return Promise.resolve({
          ok: true,
          resources: [{ name: "note-handle" }],
        });
      }
      return Promise.resolve({ ok: true, resources: [{ name: "result" }] });
    },
  });

  await publish.execute(
    {
      timezone: "UTC",
      date: "2026-10-04",
      vaultModel: "obsidian-vault",
      folder: "daily",
    },
    context,
  );

  assertEquals(calls.map((c) => c.method), ["read", "create"]);
  const createArgs = calls[1].arguments!;
  assertEquals(createArgs.name, "daily/2026-10-04.md");
  assertEquals(createArgs.overwrite, true);
  const content = createArgs.content as string;
  assertStringIncludes(content, "My prose");
  assertEquals(content.includes("stale"), false);
  assertStringIncludes(content, "Race A");

  assertEquals(written[0].specName, "publish");
  assertEquals(written[0].data.file, "daily/2026-10-04.md");
  assertEquals(written[0].data.action, "merged");
  assertEquals(written[0].data.merged, true);
});

Deno.test("publish creates a fresh note when none exists", async () => {
  const calls: Array<{ method: string; arguments?: Record<string, unknown> }> =
    [];
  const { context, written } = fakeContext({
    stored: { "daily-2026-10-04": day() as unknown as Record<string, unknown> },
    runModel: (o) => {
      calls.push({ method: o.method, arguments: o.arguments });
      if (o.method === "read") {
        return Promise.resolve({ ok: false, error: { message: "missing" } });
      }
      return Promise.resolve({ ok: true, resources: [{ name: "result" }] });
    },
  });

  await publish.execute(
    {
      timezone: "UTC",
      date: "2026-10-04",
      vaultModel: "obsidian-vault",
      folder: "daily",
    },
    context,
  );

  assertEquals(written[0].data.action, "created");
  assertEquals(written[0].data.merged, false);
  assertStringIncludes(calls[1].arguments!.content as string, "## Activities");
});
