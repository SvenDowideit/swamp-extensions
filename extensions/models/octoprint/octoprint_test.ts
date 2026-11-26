/**
 * Tests for `@svendowideit/octoprint`: the pure parsers (where OctoPrint's
 * payload shapes are absorbed) and the five phase-1 methods run against a
 * stubbed fetch, so no test needs a printer, a network or an API key.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";
import {
  createFetcher,
  findFirmware,
  getJson,
  looksLikeJpeg,
  model,
  normaliseBaseUrl,
  type OctoprintStatus,
  parseCurrentProfile,
  parseJob,
  parsePlugins,
  parseSoftwareUpdateCheck,
  parsePrinter,
  parseSystemInfo,
  parseVersion,
  stateFromFlags,
  resolveCredentials,
} from "./octoprint.ts";

const GLOBALS = {
  name: "octoprint",
  baseUrl: "",
  vaultName: "octoprint-secrets",
  urlRef: "url",
  apiKeyRef: "apiKey",
  requestTimeoutMs: 1000,
  maxBodyBytes: 262144,
  userAgent: "swamp-octoprint-test/1.0",
};

/** A fake vault: `get` answers `<vault>/<key>`. */
function fakeVault(values: Record<string, string>) {
  return {
    get: (vault: string, key: string) => Promise.resolve(values[`${vault}/${key}`]),
  };
}

const VAULT = fakeVault({
  "octoprint-secrets/url": "http://10.10.3.253",
  "octoprint-secrets/apiKey": "test-key",
});

/** Attach a fake vault to a test context, as swamp does for a real run. */
function withVault(ctx: { context: unknown }, vault = VAULT): void {
  (ctx.context as { vaultService?: unknown }).vaultService = vault;
}

/** Route paths to stub responses; restore fetch afterwards. */
function stubFetch(
  routes: Record<
    string,
    (url: string, init: RequestInit) => Response | Promise<Response>
  >,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname + (new URL(url).search || "");
    const handler = routes[path] ?? routes[new URL(url).pathname];
    if (!handler) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

Deno.test("normaliseBaseUrl adds a scheme and drops trailing slashes", () => {
  assertEquals(normaliseBaseUrl("http://10.10.3.253/"), "http://10.10.3.253");
  assertEquals(normaliseBaseUrl(" 10.10.3.253 "), "http://10.10.3.253");
  assertEquals(normaliseBaseUrl("https://octopi.local"), "https://octopi.local");
  // Only http(s) is a real OctoPrint endpoint; anything else is rejected here
  // so the caller gets the "no base URL" message instead of a fetch failure.
  assertEquals(normaliseBaseUrl("file:///etc/passwd"), "");
  assertEquals(normaliseBaseUrl("ftp://octopi.local"), "");
  assertEquals(normaliseBaseUrl(""), "");
});

Deno.test("parseVersion reads the nested octoprint version and the api version", () => {
  const v = parseVersion({ api: "0.1", server: "1.3.6", octoprint: { version: "1.9.3" } });
  assertEquals(v.octoprintVersion, "1.9.3");
  assertEquals(v.apiVersion, "0.1");
  assertEquals(parseVersion(null).octoprintVersion, "");
});

Deno.test("parseSystemInfo reads hostname/os and tolerates a bare payload", () => {
  const sys = parseSystemInfo({ system: { hostname: "octopi", os: "Linux", python: "3.9.2" } });
  assertEquals(sys.hostname, "octopi");
  assertEquals(sys.os, "Linux");
  assertEquals(sys.python, "3.9.2");
  assertEquals(parseSystemInfo({}).hostname, "");
});

Deno.test("stateFromFlags maps OctoPrint's flags onto one word", () => {
  assertEquals(stateFromFlags({ operational: true, ready: true }), "operational");
  assertEquals(stateFromFlags({ operational: true, printing: true }), "printing");
  assertEquals(stateFromFlags({ operational: true, paused: true }), "paused");
  assertEquals(stateFromFlags({ error: true }), "error");
  assertEquals(stateFromFlags({ closedOrError: true }), "error");
  assertEquals(stateFromFlags({ offline: true }), "offline");
  assertEquals(stateFromFlags({}), "unknown");
  assertEquals(stateFromFlags(null), "unknown");
});

Deno.test("parsePrinter reads state text and both temperatures", () => {
  const p = parsePrinter({
    printer: {
      temperature: { tool0: { actual: 21.5, target: 0 }, bed: { actual: 20.1, target: 60 } },
      sd: { ready: false },
      state: { text: "Operational", flags: { operational: true, ready: true } },
    },
  });
  assertEquals(p.state, "operational");
  assertEquals(p.stateText, "Operational");
  assertEquals(p.temperatures.tool0, { actual: 21.5, target: 0 });
  assertEquals(p.temperatures.bed, { actual: 20.1, target: 60 });
  // A payload with no temperatures yields nulls, never undefined.
  assertEquals(parsePrinter({}).temperatures.tool0, { actual: null, target: null });
});

Deno.test("parseJob reads the file name and rounds the completion", () => {
  const j = parseJob({
    job: { file: { name: "benchy.gcode", path: "benchy.gcode", size: 10, origin: "local" } },
    progress: { completion: 42.34, printTime: 120, printTimeLeft: 200 },
    state: "Printing",
  });
  assertEquals(j.file, "benchy.gcode");
  assertEquals(j.progressPct, 42.3);
  assertEquals(j.timeLeftSec, 200);
  assertEquals(j.timeElapsedSec, 120);
  assertEquals(parseJob({}).progressPct, null);
});

Deno.test("parseCurrentProfile prefers the profile flagged current", () => {
  const p = parseCurrentProfile({
    profiles: {
      _default: { id: "_default", name: "Default", model: "Prusa i3 MK2S", current: false, default: true },
      mk2s: { id: "mk2s", name: "MK2S", model: "Prusa i3 MK2S", current: true },
    },
  });
  assertEquals(p.id, "mk2s");
  assertEquals(p.model, "Prusa i3 MK2S");
  assertEquals(parseCurrentProfile({}).model, "");
});

Deno.test("parsePlugins flattens /api/settings' plugin map, sorted by id", () => {
  const plugins = parsePlugins({
    plugins: {
      softwareupdate: { id: "softwareupdate", name: "Software Update", version: "2.0.0", enabled: true },
      announcements: { name: "Announcement Plugin", version: "1.2.0", enabled: false },
    },
  });
  assertEquals(plugins.map((p) => p.id), ["announcements", "softwareupdate"]);
  assertEquals(plugins[0].enabled, false);
  assertEquals(plugins[1].version, "2.0.0");
  assertEquals(parsePlugins({}).length, 0);
});

Deno.test("parseSoftwareUpdateCheck reads core and plugin updates, skipping up-to-date ones", () => {
  const updates = parseSoftwareUpdateCheck({
    information: {
      octoprint: { current: "1.9.3", release: { version: "1.10.2" } },
      plugins: {
        octolapse: { current: "0.4.5", release: { version: "0.4.6" } },
        octoapp: { current: "3.2.3", release: { version: "3.2.3" } },
        stale: { current: "1.0.0" },
      },
    },
  });
  assertEquals(updates, [
    { id: "octolapse", installed: "0.4.5", available: "0.4.6" },
    { id: "octoprint", installed: "1.9.3", available: "1.10.2" },
  ]);
  assertEquals(parseSoftwareUpdateCheck({ information: {} }), []);
  assertEquals(parseSoftwareUpdateCheck(null), []);
});

Deno.test("findFirmware searches top-level and one level down, reporting its source", () => {
  // Top-level key.
  const direct = findFirmware([
    { source: "/api/settings", value: { firmware: "3.1.0-1.0.6" } },
  ]);
  assertEquals(direct.detected, true);
  assertEquals(direct.value, "3.1.0-1.0.6");
  assertEquals(direct.source, "/api/settings.firmware");

  // Nested under `printer`.
  const nested = findFirmware([
    { source: "/api/printer", value: { printer: { firmware: { name: "Prusa-Firmware", version: "3.1.0" } } } },
  ]);
  assertEquals(nested.detected, true);
  assertEquals(nested.value, "Prusa-Firmware 3.1.0");

  // Nothing found: reports every source it looked at.
  const none = findFirmware([
    { source: "/api/printer", value: {} },
    { source: "/api/settings", value: { plugins: {} } },
  ]);
  assertEquals(none.detected, false);
  assertEquals(none.sourcesTried, ["/api/printer", "/api/settings"]);
});

Deno.test("parseVersion also reads the {api, server, text} payload older OctoPrint returns", () => {
  assertEquals(
    parseVersion({ api: "0.1", server: "1.9.3", text: "OctoPrint 1.9.3" })
      .octoprintVersion,
    "1.9.3",
  );
  assertEquals(
    parseVersion({ api: "0.1", text: "OctoPrint 1.9.3 (maintenance)" })
      .octoprintVersion,
    "1.9.3",
  );
});

Deno.test("looksLikeJpeg checks the SOI marker", () => {
  assertEquals(looksLikeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), true);
  assertEquals(looksLikeJpeg(Uint8Array.from([0x89, 0x50, 0x4e])), false);
  assertEquals(looksLikeJpeg(Uint8Array.from([])), false);
});

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

Deno.test("createFetcher sends X-Api-Key and records failures instead of throwing", async () => {
  let seen: Record<string, string> = {};
  const restore = stubFetch({
    "/api/version": (_url, init) => {
      seen = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>),
      );
      return json({ octoprint: { version: "1.9.3" }, api: "0.1" });
    },
  });
  try {
    const fetcher = createFetcher({
      ...GLOBALS,
      baseUrl: "http://10.10.3.253",
      apiKey: "test-key",
    });
    const ok = await getJson(fetcher, "/api/version");
    assertEquals(ok.ok, true);
    assertEquals((ok.json as Record<string, unknown>)["api"], "0.1");
    assertEquals(seen["X-Api-Key"], "test-key");

    const missing = await getJson(fetcher, "/api/nope");
    assertEquals(missing.ok, false);
    assertEquals(missing.status, 404);
  } finally {
    restore();
  }
});

Deno.test("createFetcher reports an unreachable host as an error, not a throw", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
  try {
    const fetcher = createFetcher({
      ...GLOBALS,
      baseUrl: "http://10.10.3.253",
      apiKey: "test-key",
    });
    const res = await fetcher("/api/version");
    assertEquals(res.ok, false);
    assertEquals(res.status, 0);
    assertEquals(res.error, "connection refused");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Methods (against a stubbed fetch)
// ---------------------------------------------------------------------------

const MK2S_ROUTES: Parameters<typeof stubFetch>[0] = {
  "/api/version": () => json({ api: "0.1", server: "1.9.3", octoprint: { version: "1.9.3" } }),
  "/api/printer": () =>
    json({
      printer: {
        temperature: { tool0: { actual: 23.1, target: 0 }, bed: { actual: 22.4, target: 0 } },
        sd: { ready: false },
        state: { text: "Operational", flags: { operational: true, ready: true } },
      },
    }),
  "/api/job": () =>
    json({ job: { file: { name: "benchy.gcode" } }, progress: { completion: 0, printTime: null, printTimeLeft: null } }),
  "/api/printerprofiles": () =>
    json({
      profiles: {
        _default: { id: "_default", name: "Default", model: "Prusa i3 MK2S", current: true },
      },
    }),
  "/api/system/info": () => json({ system: { hostname: "octopi", os: "Linux", python: "3.9.2" } }),
  "/api/settings": () =>
    json({ plugins: { softwareupdate: { name: "Software Update", version: "2.0.0", enabled: true } } }),
  "/api/plugin/softwareupdate/check": () =>
    json({
      information: {
        octoprint: { current: "1.9.3", release: { version: "1.10.2" } },
        plugins: {
          octolapse: { current: "0.4.5", release: { version: "0.4.6" } },
        },
      },
    }),
  "/webcam/": (_url) =>
    new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    }),
};

Deno.test("status reports state, temperatures, profile and job in one call", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "status" });
  withVault(ctx);
  const restore = stubFetch(MK2S_ROUTES);
  try {
    await (model.methods.status.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].name, "status");
  const d = written[0].data as OctoprintStatus;
  assertEquals(d.reachable, true);
  assertEquals(d.octoprintVersion, "1.9.3");
  assertEquals(d.state, "operational");
  assertEquals(d.temperatures.tool0.actual, 23.1);
  assertEquals(d.profile.model, "Prusa i3 MK2S");
  assertEquals(d.hostname, "octopi");
  assertEquals(d.errors, []);
});

Deno.test("status reports a disconnected printer as offline, not as an error", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "status" });
  withVault(ctx);
  const restore = stubFetch({
    ...MK2S_ROUTES,
    "/api/printer": () => new Response("Printer is not operational", { status: 409 }),
  });
  try {
    await (model.methods.status.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as OctoprintStatus;
  assertEquals(d.reachable, true);
  assertEquals(d.state, "offline");
  assertEquals(d.errors, []);
});

Deno.test("version reports core and API versions plus the host", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "version" });
  withVault(ctx);
  const restore = stubFetch(MK2S_ROUTES);
  try {
    await (model.methods.version.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.octoprintVersion, "1.9.3");
  assertEquals(d.apiVersion, "0.1");
  assertEquals(d.hostname, "octopi");
  assertEquals(d.reachable, true);
});

Deno.test("plugins lists installed plugins and Plugin Manager's pending updates", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "plugins" });
  withVault(ctx);
  const restore = stubFetch(MK2S_ROUTES);
  try {
    await (model.methods.plugins.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.count, 1);
  assertEquals(d.softwareUpdatePresent, true);
  assertEquals(d.updatesAvailable, [
    { id: "octolapse", installed: "0.4.5", available: "0.4.6" },
    { id: "octoprint", installed: "1.9.3", available: "1.10.2" },
  ]);
});

Deno.test("plugins tolerates a missing Software Update plugin", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "plugins" });
  withVault(ctx);
  const routes = { ...MK2S_ROUTES };
  delete (routes as Record<string, unknown>)["/api/plugin/softwareupdate/check"];
  const restore = stubFetch(routes);
  try {
    await (model.methods.plugins.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.softwareUpdatePresent, false);
  assertEquals(d.updatesAvailable, []);
  assertEquals(d.errors, []);
});

Deno.test("plugins falls back to the blueprint check path and records which answered", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "plugins" });
  withVault(ctx);
  const routes: Parameters<typeof stubFetch>[0] = { ...MK2S_ROUTES };
  delete routes["/api/plugin/softwareupdate/check"];
  routes["/plugin/softwareupdate/check"] = () =>
    json({
      information: {
        octoprint: { current: "1.9.3", release: { version: "1.10.2" } },
        plugins: {},
      },
    });
  const restore = stubFetch(routes);
  try {
    await (model.methods.plugins.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.softwareUpdateEndpoint, "/plugin/softwareupdate/check");
  assertEquals(d.updatesAvailable, [
    { id: "octoprint", installed: "1.9.3", available: "1.10.2" },
  ]);
});

Deno.test("firmware says so honestly when OctoPrint does not expose the string", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "firmware" });
  withVault(ctx);
  const restore = stubFetch(MK2S_ROUTES);
  try {
    await (model.methods.firmware.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.detected, false);
  assertEquals(d.printerModel, "Prusa i3 MK2S");
  assertEquals(d.sourcesTried, [
    "/api/printer",
    "/api/settings",
    "/api/printerprofiles",
    "/api/plugin/softwareupdate/check",
  ]);
});

Deno.test("webcam reports a JPEG snapshot as ok", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "webcam" });
  withVault(ctx);
  const restore = stubFetch(MK2S_ROUTES);
  try {
    await (model.methods.webcam.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.ok, true);
  assertEquals(d.status, 200);
  assertEquals(d.contentType, "image/jpeg");
  assertEquals(d.bytes, 6);
  assertEquals(d.looksLikeJpeg, true);
});

Deno.test("webcam flags an HTML answer as failing even though the status is 200", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "webcam" });
  withVault(ctx);
  const restore = stubFetch({
    "/webcam/": () =>
      new Response("<html>webcam daemon down</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  try {
    await (model.methods.webcam.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.ok, false);
  assertEquals(d.looksLikeJpeg, false);
  assertEquals((d.errors as string[]).length, 1);
});

Deno.test("resolveCredentials prefers an explicit baseUrl and reads the key from the vault", async () => {
  const fromVault = await resolveCredentials(GLOBALS, VAULT);
  assertEquals(fromVault.url, "http://10.10.3.253");
  assertEquals(fromVault.apiKey, "test-key");
  assertEquals(fromVault.errors, []);

  const explicit = await resolveCredentials(
    { ...GLOBALS, baseUrl: "http://octopi.local" },
    VAULT,
  );
  assertEquals(explicit.url, "http://octopi.local");

  // No vault at all: the URL is missing (a hard error) and the missing key is
  // reported rather than silently sending unauthenticated requests.
  await assertRejects(
    () => resolveCredentials(GLOBALS, undefined),
    Error,
    "no base URL",
  );
  // A non-http(s) base is refused as firmly as an empty one (and does not
  // silently fall back to a vault URL when one is present, because the caller
  // asked for this base).
  await assertRejects(
    () =>
      resolveCredentials(
        { ...GLOBALS, baseUrl: "file:///etc/passwd" },
        fakeVault({}),
      ),
    Error,
    "no base URL",
  );

  const noKey = await resolveCredentials(
    { ...GLOBALS, baseUrl: "http://octopi.local" },
    undefined,
  );
  assertEquals(noKey.apiKey, "");
  assertEquals(noKey.errors.length, 1);
  assertEquals(noKey.errors[0].includes("no API key"), true);

  // A vault that throws is recorded, not fatal.
  const broken = await resolveCredentials(
    { ...GLOBALS, baseUrl: "http://octopi.local" },
    { get: () => Promise.reject(new Error("vault locked")) },
  );
  assertEquals(broken.errors[0].includes("vault locked"), true);
});
