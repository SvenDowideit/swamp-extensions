/**
 * Unit tests for the pure helpers in {@link ./bom_weather.ts} — selector
 * resolution, id/geohash extraction, response parsing and formatting. These
 * tests make no network requests.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./bom_weather.ts";
import {
  filterWarningsByState,
  formatDay,
  formatHourly,
  formatObservation,
  formatSummary,
  formatWarnings,
  geohash6,
  geohashFromId,
  localDate,
  localTime,
  localWeekday,
  mergeSelectors,
  parseDaily,
  parseDay,
  parseHour,
  parseHourly,
  parseObservations,
  parseWarning,
  pickCandidate,
  stripHtml,
  type Place,
} from "./bom_weather.ts";

const PENRITH: Place = {
  id: "Penrith-r650hv8",
  name: "Penrith",
  state: "NSW",
  postcode: "2750",
  geohash: "r650hv8",
  timezone: "Australia/Sydney",
  latitude: -33.71910095214844,
  longitude: 150.6781768798828,
};

Deno.test("geohashFromId extracts the trailing 6-char geohash", () => {
  assertEquals(geohashFromId("Penrith-r650hv8"), "r650hv8");
  assertEquals(geohashFromId("Melbourne-r1r0fup"), "r1r0fup");
});

Deno.test("geohashFromId returns null when there is no geohash suffix", () => {
  assertEquals(geohashFromId("Penrith"), null);
  assertEquals(geohashFromId("Penrith-abc"), null);
});

Deno.test("pickCandidate prefers the state match when a state is given", () => {
  const candidates = [
    { id: "Richmond-rhmf163", name: "Richmond", state: "QLD", postcode: "4822", geohash: "rhmf163" },
    { id: "Richmond-r650ygp", name: "Richmond", state: "NSW", postcode: "2753", geohash: "r650ygp" },
  ];
  assertEquals(pickCandidate(candidates, "NSW")?.geohash, "r650ygp");
  assertEquals(pickCandidate(candidates, "nsw")?.geohash, "r650ygp");
});

Deno.test("pickCandidate falls back to the first result without a state match", () => {
  const candidates = [
    { id: "Richmond-rhmf163", name: "Richmond", state: "QLD", postcode: "4822", geohash: "rhmf163" },
    { id: "Richmond-r650ygp", name: "Richmond", state: "NSW", postcode: "2753", geohash: "r650ygp" },
  ];
  assertEquals(pickCandidate(candidates, "VIC")?.geohash, "rhmf163");
  assertEquals(pickCandidate(candidates, ""), candidates[0]);
  assertEquals(pickCandidate([], "NSW"), null);
});

Deno.test("mergeSelectors lets method args override model globals", () => {
  const globals = { name: "Penrith", state: "NSW" };
  // No args → globals win.
  assertEquals(mergeSelectors(globals, {}), { name: "Penrith", state: "NSW" });
  // A non-empty arg overrides the matching global.
  assertEquals(mergeSelectors(globals, { name: "Bathurst" }), {
    name: "Bathurst",
    state: "NSW",
  });
  // An empty arg leaves the global in place.
  assertEquals(mergeSelectors(globals, { name: "" }), {
    name: "Penrith",
    state: "NSW",
  });
  // A geohash arg is independent of the name global.
  assertEquals(mergeSelectors(globals, { geohash: "r1r0fup" }), {
    name: "Penrith",
    state: "NSW",
    geohash: "r1r0fup",
  });
});

Deno.test("localDate/localWeekday/localTime use the location timezone", () => {
  // 2026-09-22T14:00:00Z is midnight on the 23rd in Sydney.
  const instant = new Date("2026-09-22T14:00:00Z");
  assertEquals(localDate(instant, "Australia/Sydney"), "2026-09-23");
  assertEquals(localDate(instant, "Australia/Perth"), "2026-09-22");
  assertEquals(localWeekday(instant, "Australia/Sydney"), "Wednesday");
  assertEquals(localTime("2026-09-22T11:50:33Z", "Australia/Sydney"), "21:50");
});

Deno.test("parseDay flattens the upstream daily shape", () => {
  const day = parseDay({
    date: "2026-09-22T14:00:00Z",
    temp_min: 13,
    temp_max: 24,
    rain: {
      amount: { min: 1, max: 3 },
      chance: 60,
    },
    uv: { category: "high", max_index: 6 },
    astronomical: {
      sunrise_time: "2026-09-22T19:46:04Z",
      sunset_time: "2026-09-23T07:54:03Z",
    },
    short_text: "Shower or two.",
    icon_descriptor: "shower",
    fire_danger: "Moderate",
  }, "Australia/Sydney");

  assertEquals(day.date, "2026-09-23");
  assertEquals(day.weekday, "Wednesday");
  assertEquals(day.tempMin, 13);
  assertEquals(day.tempMax, 24);
  assertEquals(day.rainChance, 60);
  assertEquals(day.rainMin, 1);
  assertEquals(day.rainMax, 3);
  assertEquals(day.uvCategory, "high");
  assertEquals(day.shortText, "Shower or two.");
});

Deno.test("parseDaily derives today/tomorrow and carries issue metadata", () => {
  const payload = {
    metadata: {
      issue_time: "2026-09-22T11:50:33Z",
      next_issue_time: "2026-09-22T18:15:00Z",
      forecast_region: "Penrith",
      forecast_type: "precis",
    },
    data: [
      { date: "2026-09-21T14:00:00Z", temp_min: 13, temp_max: 24, short_text: "Shower or two." },
      { date: "2026-09-22T14:00:00Z", temp_min: 15, temp_max: 28, short_text: "Partly cloudy." },
      { date: "2026-09-23T14:00:00Z", temp_min: 17, temp_max: 30, short_text: "Sunny." },
    ],
  };

  const forecast = parseDaily(
    payload,
    PENRITH,
    "2026-09-22T12:00:00Z",
    "https://example/api",
  );

  assertEquals(forecast.issueTime, "2026-09-22T11:50:33Z");
  assertEquals(forecast.nextIssueTime, "2026-09-22T18:15:00Z");
  assertEquals(forecast.days.length, 3);
  // 12:00Z on the 22nd is the 22nd at 22:00 in Sydney.
  assertEquals(forecast.today?.date, "2026-09-22");
  assertEquals(forecast.tomorrow?.date, "2026-09-23");
  assertEquals(forecast.today?.tempMax, 24);
});

Deno.test("formatDay and formatSummary render the today/tomorrow view", () => {
  const forecast = parseDaily({
    metadata: {
      issue_time: "2026-09-22T11:50:33Z",
      next_issue_time: "2026-09-22T18:15:00Z",
    },
    data: [
      { date: "2026-09-21T14:00:00Z", temp_min: 13, temp_max: 24, short_text: "Shower or two.", rain: { chance: 60, amount: { min: 1, max: 3 } } },
      { date: "2026-09-22T14:00:00Z", temp_min: 15, temp_max: 28, short_text: "Partly cloudy.", rain: { chance: 30, amount: { min: null, max: null } } },
    ],
  }, PENRITH, "2026-09-22T12:00:00Z", "https://example/api");

  assertEquals(
    formatDay(forecast.today!),
    "Tuesday 2026-09-22: 13–24°C; Shower or two.; 60% chance, 1–3 mm",
  );

  const lines = formatSummary(forecast);
  assertEquals(lines[0], "Location: Penrith, NSW (r650hv8)");
  assertEquals(lines[1], "Issue time:      2026-09-22T11:50:33Z");
  assertEquals(lines[2], "Next issue time: 2026-09-22T18:15:00Z");
  assertEquals(lines[4].startsWith("Today:    Tuesday 2026-09-22"), true);
  assertEquals(lines[5].startsWith("Tomorrow: Wednesday 2026-09-23"), true);
});

// ---------------------------------------------------------------------------
// Method execute paths (fake fetch, no network)
// ---------------------------------------------------------------------------

interface Captured {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

/** A fake fetch response or a thunk producing one (may throw for network errors). */
type FetchStep = { status: number; body?: string } | (() => {
  status: number;
  body?: string;
});

/**
 * Build a minimal method context: parsed globals, a silent logger, a
 * `writeResource` that records calls, and `readResource` seeded from `previous`.
 */
function makeContext(
  globals: Record<string, unknown>,
  previous: Record<string, unknown> | null = null,
) {
  const written: Captured[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
    readResource: () => Promise.resolve(previous),
  };
  return { context, written };
}

/** Install a fake globalThis.fetch replaying `steps` in order; restores after. */
async function withFetch<T>(
  steps: FetchStep[],
  fn: (calls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (input: string | URL | Request) => {
    calls.push(String(input));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const r = typeof step === "function" ? step() : step;
    return Promise.resolve(new Response(r.body ?? "", { status: r.status }));
  };
  try {
    return await fn(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  }
}

const SEARCH_BODY = JSON.stringify({
  data: [
    {
      id: "Richmond-rhmf163",
      name: "Richmond",
      state: "QLD",
      postcode: "4822",
      geohash: "rhmf163",
    },
    {
      id: "Richmond-r650ygp",
      name: "Richmond",
      state: "NSW",
      postcode: "2753",
      geohash: "r650ygp",
    },
  ],
});

const DETAIL_BODY = JSON.stringify({
  data: {
    id: "Richmond-r650ygp",
    name: "Richmond",
    state: "NSW",
    geohash: "r650ygp",
    timezone: "Australia/Sydney",
    latitude: -33.6,
    longitude: 150.75,
  },
});

const DAILY_BODY = JSON.stringify({
  metadata: {
    issue_time: "2026-09-22T11:50:33Z",
    next_issue_time: "2026-09-22T18:15:00Z",
    forecast_region: "Richmond",
    forecast_type: "precis",
  },
  data: [
    { date: "2026-09-21T14:00:00Z", temp_min: 13, temp_max: 24, short_text: "Showers." },
    { date: "2026-09-22T14:00:00Z", temp_min: 15, temp_max: 28, short_text: "Sunny." },
  ],
});

Deno.test("resolve: name+state picks the state-matching candidate", async () => {
  const { context, written } = makeContext({ name: "Richmond", state: "NSW" });
  await withFetch(
    [{ status: 200, body: SEARCH_BODY }, { status: 200, body: DETAIL_BODY }],
    async (calls) => {
      await model.methods.resolve.execute(
        { name: "Richmond", state: "NSW" },
        context,
      );
      assertEquals(calls.length, 2);
      assertEquals(calls[0].includes("locations?search=Richmond"), true);
      assertEquals(calls[1].endsWith("/locations/r650ygp"), true);
    },
  );
  assertEquals(written[0].specName, "location");
  assertEquals(written[0].name, "location");
  assertEquals((written[0].data.place as Place).geohash, "r650ygp");
});

Deno.test("resolve: geohash skips the search call", async () => {
  const { context } = makeContext({});
  await withFetch([{ status: 200, body: DETAIL_BODY }], async (calls) => {
    await model.methods.resolve.execute({ geohash: "r650ygp" }, context);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].endsWith("/locations/r650ygp"), true);
  });
});

Deno.test("resolve: id derives the geohash and skips the search call", async () => {
  const { context, written } = makeContext({});
  await withFetch([{ status: 200, body: DETAIL_BODY }], async (calls) => {
    await model.methods.resolve.execute({ id: "Richmond-r650ygp" }, context);
    assertEquals(calls.length, 1);
    // Detail name differs from the id stem; the stem name is preferred.
    assertEquals((written[0].data.place as Place).name, "Richmond");
  });
});

Deno.test("resolve: no selector throws an actionable message", async () => {
  const { context } = makeContext({});
  await withFetch([{ status: 200, body: SEARCH_BODY }], async () => {
    await assertRejects(
      () => model.methods.resolve.execute({}, context),
      Error,
      "No location selector supplied",
    );
  });
});

Deno.test("resolve: a 500 response throws with the status and URL", async () => {
  const { context } = makeContext({});
  await withFetch([{ status: 500, body: "boom" }], async () => {
    await assertRejects(
      () => model.methods.resolve.execute({ name: "Richmond" }, context),
      Error,
      "BOM request failed: 500",
    );
  });
});

Deno.test("sync: writes a forecast and marks unchanged when issue matches", async () => {
  const { context, written } = makeContext(
    { name: "Richmond", state: "NSW" },
    { issueTime: "2026-09-22T11:50:33Z" },
  );
  await withFetch(
    [
      { status: 200, body: SEARCH_BODY },
      { status: 200, body: DETAIL_BODY },
      { status: 200, body: DAILY_BODY },
    ],
    async () => {
      await model.methods.sync.execute({ force: false }, context);
    },
  );
  assertEquals(written[0].specName, "forecast");
  assertEquals(written[0].name, "forecast");
  assertEquals(written[0].data.unchanged, true);
  assertEquals(written[0].data.issueTime, "2026-09-22T11:50:33Z");
  assertEquals((written[0].data.days as unknown[]).length, 2);
});

Deno.test("sync: force re-marks a matching issue as changed", async () => {
  const { context, written } = makeContext(
    { name: "Richmond", state: "NSW" },
    { issueTime: "2026-09-22T11:50:33Z" },
  );
  await withFetch(
    [
      { status: 200, body: SEARCH_BODY },
      { status: 200, body: DETAIL_BODY },
      { status: 200, body: DAILY_BODY },
    ],
    async () => {
      await model.methods.sync.execute({ force: true }, context);
    },
  );
  assertEquals(written[0].data.unchanged, false);
});

Deno.test("print: renders today/tomorrow and issue times from a snapshot", async () => {
  const { context, written } = makeContext({}, {
    place: PENRITH,
    issueTime: "2026-09-22T11:50:33Z",
    nextIssueTime: "2026-09-22T18:15:00Z",
    days: [{ date: "2026-09-22", weekday: "Tuesday", tempMax: 24 }],
    today: { date: "2026-09-22", weekday: "Tuesday", tempMax: 24 },
    tomorrow: { date: "2026-09-23", weekday: "Wednesday", tempMax: 28 },
  });
  await model.methods.print.execute(
    { dataName: "forecast", hourlyHours: 12, warningsDetail: false },
    context,
  );
  assertEquals(written[0].specName, "summary");
  assertEquals(written[0].data.printed, true);
  assertEquals(written[0].data.issueTime, "2026-09-22T11:50:33Z");
  assertEquals(written[0].data.nextIssueTime, "2026-09-22T18:15:00Z");
  const lines = written[0].data.lines as string[];
  assertEquals(lines[0], "Location: Penrith, NSW (r650hv8)");
});

Deno.test("print: reports a missing snapshot instead of throwing", async () => {
  const { context, written } = makeContext({}, null);
  await model.methods.print.execute(
    { dataName: "forecast", hourlyHours: 12, warningsDetail: false },
    context,
  );
  assertEquals(written[0].data.printed, false);
  assertEquals(written[0].data.issueTime, null);
});

// ---------------------------------------------------------------------------
// Hourly / observations / warnings parsers
// ---------------------------------------------------------------------------

Deno.test("geohash6 truncates to the 6 characters hourly/observations need", () => {
  assertEquals(geohash6("r650hv8"), "r650hv");
  assertEquals(geohash6(" R650HV8 "), "r650hv");
  assertEquals(geohash6("r650hv"), "r650hv");
});

Deno.test("parseHour flattens the hourly shape and localises the time", () => {
  const hour = parseHour({
    time: "2026-09-23T02:00:00Z",
    temp: 21,
    temp_feels_like: 21,
    dew_point: 13,
    relative_humidity: 60,
    wind: {
      speed_knot: 4,
      speed_kilometre: 7,
      direction: "SE",
      gust_speed_kilometre: 17,
    },
    uv: 6,
    rain: { chance: 20, amount: { min: 0, max: null } },
    is_night: false,
    icon_descriptor: "shower",
  }, "Australia/Sydney");

  assertEquals(hour.localTime, "12:00");
  assertEquals(hour.date, "2026-09-23");
  assertEquals(hour.temp, 21);
  assertEquals(hour.windSpeedKmh, 7);
  assertEquals(hour.windDirection, "SE");
  assertEquals(hour.gustSpeedKmh, 17);
  assertEquals(hour.rainChance, 20);
  assertEquals(hour.rainMax, null);
  assertEquals(hour.uvIndex, 6);
});

Deno.test("parseHourly carries issue metadata and maps all entries", () => {
  const hourly = parseHourly({
    metadata: { issue_time: "2026-09-23T01:56:27Z" },
    data: [
      { time: "2026-09-23T02:00:00Z", temp: 21 },
      { time: "2026-09-23T03:00:00Z", temp: 22 },
    ],
  }, PENRITH, "2026-09-23T02:00:00Z", "https://example/hourly");

  assertEquals(hourly.issueTime, "2026-09-23T01:56:27Z");
  assertEquals(hourly.entries.length, 2);
  assertEquals(hourly.entries[1].temp, 22);
});

Deno.test("parseObservations flattens the single observation object", () => {
  const obs = parseObservations({
    metadata: {
      issue_time: "2026-09-23T02:41:03Z",
      observation_time: "2026-09-23T02:40:00Z",
    },
    data: {
      temp: 21.4,
      temp_feels_like: 21.5,
      humidity: 62,
      rain_since_9am: 0,
      wind: { speed_kilometre: 6, speed_knot: 3, direction: "ENE" },
      gust: { speed_kilometre: 9, speed_knot: 5 },
      max_gust: { speed_kilometre: 17, speed_knot: 9, time: "2026-09-22T17:15:00Z" },
      max_temp: { time: "2026-09-23T02:38:00Z", value: 21.6 },
      min_temp: { time: "2026-09-22T10:45:00Z", value: 13.3 },
      station: { bom_id: "067113", name: "Penrith", distance: 435 },
    },
  }, PENRITH, "2026-09-23T02:41:10Z", "https://example/observations");

  assertEquals(obs.observationTime, "2026-09-23T02:40:00Z");
  assertEquals(obs.temp, 21.4);
  assertEquals(obs.humidity, 62);
  assertEquals(obs.windDirection, "ENE");
  assertEquals(obs.maxGustKmh, 17);
  assertEquals(obs.maxTemp, 21.6);
  assertEquals(obs.minTemp, 13.3);
  assertEquals(obs.stationName, "Penrith");
  assertEquals(obs.stationDistanceMetres, 435);
});

Deno.test("parseObservations tolerates a sparse data object", () => {
  const obs = parseObservations({ data: {} }, PENRITH, "t", "u");
  assertEquals(obs.temp, null);
  assertEquals(obs.stationName, null);
  assertEquals(obs.windDirection, null);
});

Deno.test("parseWarning flattens list and detail fields", () => {
  const list = parseWarning({
    id: "IDT21900",
    type: "frost_warning",
    title: "Midlands",
    short_title: "Frost Warning",
    state: "TAS",
    states: ["TAS"],
    warning_group_type: "minor",
    issue_time: "2026-09-22T12:54:06Z",
    expiry_time: "2026-09-23T05:00:00Z",
    phase: "update",
  });
  assertEquals(list.id, "IDT21900");
  assertEquals(list.groupType, "minor");
  assertEquals(list.phase, "update");
  assertEquals(list.message, null);

  const detail = parseWarning({
    id: "NSW_MW006_IDN28522",
    area_id: "NSW_MW006",
    states: ["NSW"],
    message: "<div>…</div>",
    warning_group_type: "minor",
  });
  assertEquals(detail.areaId, "NSW_MW006");
  assertEquals(detail.message, "<div>…</div>");
  assertEquals(detail.states, ["NSW"]);
});

Deno.test("filterWarningsByState matches state and states client-side", () => {
  const warnings = [
    parseWarning({ id: "a", state: "TAS", states: ["TAS"] }),
    parseWarning({ id: "b", state: "NSW", states: ["NSW"] }),
    parseWarning({ id: "c", state: "WA", states: ["WA", "NT"] }),
  ];
  assertEquals(filterWarningsByState(warnings, "").length, 3);
  assertEquals(filterWarningsByState(warnings, "NSW").map((w) => w.id), ["b"]);
  assertEquals(filterWarningsByState(warnings, "nsw").map((w) => w.id), ["b"]);
  assertEquals(filterWarningsByState(warnings, "NT").map((w) => w.id), ["c"]);
});

Deno.test("sync-hourly uses the 6-character geohash endpoint", async () => {
  const { context, written } = makeContext({ name: "Richmond", state: "NSW" });
  await withFetch(
    [
      { status: 200, body: SEARCH_BODY },
      { status: 200, body: DETAIL_BODY },
      {
        status: 200,
        body: JSON.stringify({
          metadata: { issue_time: "2026-09-23T01:56:27Z" },
          data: [{ time: "2026-09-23T02:00:00Z", temp: 21 }],
        }),
      },
    ],
    async (calls) => {
      await model.methods["sync-hourly"].execute({}, context);
      assertEquals(calls[2].endsWith("/locations/r650yg/forecasts/hourly"), true);
    },
  );
  assertEquals(written[0].specName, "hourly");
  assertEquals((written[0].data.entries as unknown[]).length, 1);
});

Deno.test("observe uses the 6-character geohash endpoint", async () => {
  const { context, written } = makeContext({ name: "Richmond", state: "NSW" });
  await withFetch(
    [
      { status: 200, body: SEARCH_BODY },
      { status: 200, body: DETAIL_BODY },
      {
        status: 200,
        body: JSON.stringify({
          metadata: { observation_time: "2026-09-23T02:40:00Z" },
          data: { temp: 21.4 },
        }),
      },
    ],
    async (calls) => {
      await model.methods.observe.execute({}, context);
      assertEquals(calls[2].endsWith("/locations/r650yg/observations"), true);
    },
  );
  assertEquals(written[0].specName, "observation");
  assertEquals(written[0].data.temp, 21.4);
});

Deno.test("warnings: national scope filters by state and can fetch detail", async () => {
  const { context, written } = makeContext({});
  const nationalBody = JSON.stringify({
    data: [
      { id: "IDT1", state: "TAS", states: ["TAS"], type: "frost_warning" },
      { id: "IDN1", state: "NSW", states: ["NSW"], type: "surf_warning" },
    ],
  });
  await withFetch(
    [
      { status: 200, body: nationalBody },
      { status: 200, body: JSON.stringify({ data: { message: "<p>frost</p>" } }) },
    ],
    async (calls) => {
      await model.methods.warnings.execute(
        { scope: "national", state: "TAS", detail: true },
        context,
      );
      // One national list call, then one detail call for the surviving warning.
      assertEquals(calls.length, 2);
      assertEquals(calls[1].endsWith("/warnings/IDT1"), true);
    },
  );
  assertEquals(written[0].data.count, 1);
  assertEquals(written[0].data.stateFilter, "TAS");
  const ws = written[0].data.warnings as { message: string | null }[];
  assertEquals(ws[0].message, "<p>frost</p>");
});

Deno.test("warnings: location scope resolves the place first", async () => {
  const { context, written } = makeContext({ name: "Port Macquarie", state: "NSW" });
  await withFetch(
    [
      { status: 200, body: SEARCH_BODY },
      { status: 200, body: DETAIL_BODY },
      {
        status: 200,
        body: JSON.stringify({
          data: [{ id: "NSW_MW006_IDN28522", area_id: "NSW_MW006" }],
        }),
      },
    ],
    async (calls) => {
      await model.methods.warnings.execute(
        { scope: "location", state: "", detail: false },
        context,
      );
      assertEquals(calls[2].endsWith("/locations/r650yg/warnings"), true);
    },
  );
  assertEquals(written[0].data.scope, "location");
  assertEquals(written[0].data.count, 1);
});

// ---------------------------------------------------------------------------
// Print formatting for observations / hourly / warnings
// ---------------------------------------------------------------------------

const SAMPLE_OBS = parseObservations({
  metadata: { observation_time: "2026-09-23T02:40:00Z" },
  data: {
    temp: 21.4,
    temp_feels_like: 21.5,
    humidity: 62,
    rain_since_9am: 0,
    wind: { speed_kilometre: 6, direction: "ENE" },
    gust: { speed_kilometre: 9 },
    max_temp: { value: 21.6, time: "2026-09-23T02:38:00Z" },
    min_temp: { value: 13.3, time: "2026-09-22T10:45:00Z" },
    station: { name: "Penrith", distance: 435 },
  },
}, PENRITH, "2026-09-23T02:41:10Z", "https://example/observations");

const SAMPLE_HOURLY = parseHourly({
  metadata: { issue_time: "2026-09-23T01:56:27Z" },
  data: [
    { time: "2026-09-23T02:00:00Z", temp: 21, temp_feels_like: 21, wind: { speed_kilometre: 7, direction: "SE", gust_speed_kilometre: 17 }, rain: { chance: 20 }, icon_descriptor: "shower" },
    { time: "2026-09-23T03:00:00Z", temp: 22, temp_feels_like: 22, wind: { speed_kilometre: 9, direction: "ESE", gust_speed_kilometre: 20 }, rain: { chance: 30 }, icon_descriptor: "shower" },
  ],
}, PENRITH, "2026-09-23T02:41:10Z", "https://example/hourly");

Deno.test("formatObservation renders temp, humidity, wind and station", () => {
  const lines = formatObservation(SAMPLE_OBS);
  assertEquals(lines[0], "Observed:");
  assertEquals(
    lines[1],
    "  21.4°C (feels like 21.5°C), humidity 62%, rain since 9am 0 mm",
  );
  assertEquals(lines[2], "  Wind 6 km/h ENE, gust 9 km/h");
  assertEquals(lines[3], "  Today max 21.6°C, min 13.3°C — Penrith (435 m away)");
});

Deno.test("formatHourly caps the rendered hours and labels each row", () => {
  const lines = formatHourly(SAMPLE_HOURLY, 1);
  assertEquals(
    lines[0],
    "Hourly (next 1 of 2h, issued 2026-09-23T01:56:27Z):",
  );
  assertEquals(
    lines[1],
    "  12:00 2026-09-23: 21°C (feels 21°C); shower; wind 7km/h SE gust 17; rain 20%",
  );
  assertEquals(lines.length, 2);

  // hours=0 renders every entry.
  assertEquals(formatHourly(SAMPLE_HOURLY, 0).length, 3);
});

Deno.test("formatWarnings handles none, and lists each warning", () => {
  assertEquals(formatWarnings([], "location", null), [
    "Warnings (this location): none",
  ]);
  const w = parseWarning({
    id: "NSW_MW006_IDN28522",
    type: "hazardous_surf_warning",
    short_title: "Hazardous Surf Warning",
    state: "NSW",
    states: ["NSW"],
    phase: "new",
    expiry_time: "2026-09-23T14:00:00Z",
  });
  const lines = formatWarnings([w], "national", "NSW");
  assertEquals(lines[0], "Warnings (national (NSW)): 1");
  assertEquals(
    lines[1],
    "  Hazardous Surf Warning [NSW] (new) — expires 2026-09-23T14:00:00Z",
  );
});

Deno.test("stripHtml collapses a warning message to plain text", () => {
  assertEquals(
    stripHtml("<div class=\"product\">\n<p>Frosts down to&nbsp;-1&nbsp;degrees.</p>\n</div>"),
    "Frosts down to -1 degrees.",
  );
});

Deno.test("print includes observation, hourly and warnings when present", async () => {
  const { context, written } = makeContext({}, {
    place: PENRITH,
    issueTime: "2026-09-23T01:56:33Z",
    nextIssueTime: "2026-09-23T06:00:00Z",
    today: { date: "2026-09-23", weekday: "Wednesday", tempMax: 23 },
    tomorrow: { date: "2026-09-24", weekday: "Thursday", tempMax: 27 },
  });
  // Seed the optional sources via a per-instance readResource.
  const seeded: Record<string, Record<string, unknown>> = {
    forecast: {
      place: PENRITH,
      issueTime: "2026-09-23T01:56:33Z",
      nextIssueTime: "2026-09-23T06:00:00Z",
      today: { date: "2026-09-23", weekday: "Wednesday", tempMax: 23 },
      tomorrow: { date: "2026-09-24", weekday: "Thursday", tempMax: 27 },
    },
    observation: SAMPLE_OBS as unknown as Record<string, unknown>,
    hourly: SAMPLE_HOURLY as unknown as Record<string, unknown>,
    warnings: {
      scope: "location",
      stateFilter: null,
      fetchedAt: "t",
      sourceUrl: "u",
      count: 1,
      warnings: [parseWarning({
        id: "IDN1",
        short_title: "Hazardous Surf Warning",
        state: "NSW",
        states: ["NSW"],
        phase: "new",
      })],
    },
  };
  const ctx = {
    ...context,
    readResource: (name: string) =>
      Promise.resolve(seeded[name] ?? null) as Promise<
        Record<string, unknown> | null
      >,
  };
  await model.methods.print.execute(
    { dataName: "forecast", hourlyHours: 1, warningsDetail: false },
    ctx,
  );
  const lines = written[0].data.lines as string[];
  assertEquals(lines.some((l) => l.startsWith("Observed:")), true);
  assertEquals(lines.some((l) => l.startsWith("Hourly (next 1 of 2h")), true);
  assertEquals(lines.some((l) => l.startsWith("Warnings (this location): 1")), true);
  assertEquals(written[0].data.observed !== null, true);
  assertEquals(written[0].data.hourly !== null, true);
  assertEquals(written[0].data.warnings !== null, true);
});
