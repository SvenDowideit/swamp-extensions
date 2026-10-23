import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  buildApiUrl,
  type DesiredRecord,
  type DnsRecord,
  DreamHostApi,
  DreamHostApiError,
  errorMessage,
  isRateLimited,
  normalizeName,
  normalizeRecordType,
  parseRecords,
  planDnsSync,
  RECORD_TYPES,
  recordKey,
  resolveRecordName,
} from "./dreamhost_dns.ts";

import { model } from "./dreamhost_dns.ts";

const encoder = new TextEncoder();
void encoder;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("normalizeName lower-cases and trims", () => {
  assertEquals(normalizeName("  WWW.Example.COM "), "www.example.com");
});

Deno.test("resolveRecordName resolves apex, short labels, and FQDNs", () => {
  assertEquals(resolveRecordName("@", "example.com"), "example.com");
  assertEquals(resolveRecordName("example.com", "example.com"), "example.com");
  assertEquals(resolveRecordName("www", "example.com"), "www.example.com");
  assertEquals(
    resolveRecordName("www.example.com", "example.com"),
    "www.example.com",
  );
  assertEquals(resolveRecordName("Example.COM", "example.com"), "example.com");
  assertEquals(
    resolveRecordName("host.other.com", "example.com"),
    "host.other.com",
  );
  assertEquals(
    resolveRecordName("_dmarc", "example.com"),
    "_dmarc.example.com",
  );
});

Deno.test("normalizeRecordType upper-cases and validates", () => {
  assertEquals(normalizeRecordType("cname"), "CNAME");
  assertEquals(normalizeRecordType(" TXT "), "TXT");
  for (const t of RECORD_TYPES) {
    assertEquals(normalizeRecordType(t.toLowerCase()), t);
  }
  assertThrows(
    () => normalizeRecordType("WKS"),
    Error,
    "Unsupported DNS record type",
  );
});

Deno.test("buildApiUrl sets key, cmd, format, params, and unique_id", () => {
  const url = new URL(
    buildApiUrl(
      "https://api.dreamhost.com/",
      "KEY123",
      "dns-add_record",
      { record: "www.example.com", type: "A", value: "1.2.3.4", empty: "" },
      "uid-1",
    ),
  );
  assertEquals(url.origin + url.pathname, "https://api.dreamhost.com/");
  assertEquals(url.searchParams.get("key"), "KEY123");
  assertEquals(url.searchParams.get("cmd"), "dns-add_record");
  assertEquals(url.searchParams.get("format"), "json");
  assertEquals(url.searchParams.get("record"), "www.example.com");
  assertEquals(url.searchParams.get("type"), "A");
  assertEquals(url.searchParams.get("value"), "1.2.3.4");
  assertEquals(url.searchParams.get("unique_id"), "uid-1");
  // Empty values are omitted.
  assertEquals(url.searchParams.has("empty"), false);
});

Deno.test("errorMessage extracts DreamHost error text", () => {
  assertEquals(
    errorMessage({ result: "error", data: "slow_down_bucko" }),
    "slow_down_bucko",
  );
  assertEquals(errorMessage({ reason: "bad key" }), "bad key");
  assertEquals(errorMessage({}), "{}");
});

Deno.test("parseRecords normalizes types, zones, and editable flags", () => {
  const records = parseRecords([
    {
      record: "WWW.Example.com",
      type: "a",
      value: "1.2.3.4",
      comment: "hi",
      zone: "Example.com",
      editable: "1",
    },
    { record: "mail.example.com", type: "MX", editable: "0" },
    { record: 42 },
    "not-an-object",
  ]);
  assertEquals(records.length, 2);
  assertEquals(records[0], {
    record: "www.example.com",
    type: "A",
    value: "1.2.3.4",
    comment: "hi",
    zone: "example.com",
    editable: true,
  });
  assertEquals(records[1].editable, false);
  assertEquals(records[1].type, "MX");
  assertEquals(records[1].value, "");
});

Deno.test("parseRecords tolerates a non-array payload", () => {
  assertEquals(parseRecords("nope"), []);
  assertEquals(parseRecords(null), []);
});

Deno.test("recordKey is insensitive to name case, value whitespace, type case", () => {
  assertEquals(
    recordKey({ record: "WWW.example.com", type: "a", value: "1.2.3.4 " }),
    recordKey({ record: "www.example.com", type: "A", value: "1.2.3.4" }),
  );
});

// ---------------------------------------------------------------------------
// Sync planning
// ---------------------------------------------------------------------------

const live: DnsRecord[] = [
  {
    record: "example.com",
    type: "A",
    value: "1.2.3.4",
    comment: "",
    zone: "example.com",
    editable: true,
  },
  {
    record: "www.example.com",
    type: "A",
    value: "1.2.3.4",
    comment: "",
    zone: "example.com",
    editable: true,
  },
  {
    record: "example.com",
    type: "MX",
    value: "10 mail.example.com",
    comment: "",
    zone: "example.com",
    editable: false,
  },
  {
    record: "other.com",
    type: "A",
    value: "9.9.9.9",
    comment: "",
    zone: "other.com",
    editable: true,
  },
];

const desired: DesiredRecord[] = [
  { record: "example.com", type: "A", value: "1.2.3.4", comment: "" },
  {
    record: "new.example.com",
    type: "CNAME",
    value: "www.example.com",
    comment: "",
  },
];

Deno.test("planDnsSync adds missing records and reports unchanged", () => {
  const plan = planDnsSync(desired, live, "example.com", false);
  assertEquals(plan.toAdd.map((r) => r.record), ["new.example.com"]);
  assertEquals(plan.unchanged.map((r) => r.record), ["example.com"]);
  assertEquals(plan.toRemove, []);
});

Deno.test("planDnsSync scopes to the requested zone", () => {
  const plan = planDnsSync(desired, live, "other.com", false);
  assertEquals(plan.toAdd.length, 2);
  assertEquals(plan.unchanged.length, 0);
});

Deno.test("planDnsSync prune removes only editable records", () => {
  const plan = planDnsSync(desired, live, "example.com", true);
  // www.example.com is editable and undesired -> removal.
  assertEquals(plan.toRemove.map((r) => r.record), ["www.example.com"]);
  // The DreamHost-managed MX record is protected.
  assertEquals(plan.protectedSkipped.map((r) => r.type), ["MX"]);
});

Deno.test("planDnsSync without prune never removes", () => {
  const plan = planDnsSync(desired, live, "example.com", false);
  assertEquals(plan.toRemove, []);
  assertEquals(plan.protectedSkipped, []);
});

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

function makeClient(handler: (url: string) => [number, string]) {
  const calls: string[] = [];
  const api = new DreamHostApi({
    base: "https://api.dreamhost.com",
    key: "K",
    fetchImpl: (url) => {
      calls.push(url);
      const [status, body] = handler(url);
      return Promise.resolve({ status, body });
    },
  });
  return { api, calls };
}

Deno.test("DreamHostApi.call returns data on a success envelope", async () => {
  const { api, calls } = makeClient(() => [
    200,
    JSON.stringify({
      result: "success",
      data: [{ record: "a.example.com", zone: "example.com" }],
    }),
  ]);
  const records = await api.listRecords();
  assertEquals(records.length, 1);
  assertEquals(records[0].record, "a.example.com");
  assertStringIncludes(calls[0], "cmd=dns-list_records");
});

Deno.test("DreamHostApi.call throws DreamHostApiError on an error envelope", async () => {
  const { api } = makeClient(() => [
    200,
    JSON.stringify({
      result: "error",
      data: "this_key_cannot_access_this_cmd",
    }),
  ]);
  const err = await assertRejects(() => api.listRecords(), DreamHostApiError);
  assertStringIncludes(
    (err as Error).message,
    "this_key_cannot_access_this_cmd",
  );
  assertEquals(isRateLimited(err), false);
});

Deno.test("isRateLimited recognizes DreamHost slow_down_bucko", async () => {
  const { api } = makeClient(() => [
    200,
    JSON.stringify({ result: "error", data: "slow_down_bucko" }),
  ]);
  const err = await assertRejects(() => api.listRecords(), DreamHostApiError);
  assertEquals(isRateLimited(err), true);
});

Deno.test("DreamHostApi.call reports unparseable responses", async () => {
  const { api } = makeClient(() => [502, "<html>bad gateway</html>"]);
  const err = await assertRejects(() => api.listRecords(), DreamHostApiError);
  assertStringIncludes((err as Error).message, "unparseable response");
});

Deno.test("DreamHostApi.addRecord sends a unique_id", async () => {
  const { api, calls } = makeClient(() => [
    200,
    JSON.stringify({ result: "success", data: "record added" }),
  ]);
  const message = await api.addRecord("www.example.com", "A", "1.2.3.4", "web");
  assertEquals(message, "record added");
  assertStringIncludes(calls[0], "cmd=dns-add_record");
  assertStringIncludes(calls[0], "unique_id=");
  assertStringIncludes(calls[0], "comment=web");
});

Deno.test("DreamHostApi.removeRecord sends record, type, and value", async () => {
  const { api, calls } = makeClient(() => [
    200,
    JSON.stringify({ result: "success", data: "record removed" }),
  ]);
  await api.removeRecord("www.example.com", "A", "1.2.3.4");
  assertStringIncludes(calls[0], "cmd=dns-remove_record");
  assertStringIncludes(calls[0], "type=A");
});

Deno.test("DreamHostApi.listCommands normalizes stringified args", async () => {
  const { api } = makeClient(() => [
    200,
    JSON.stringify({
      result: "success",
      data: [
        { cmd: "dns-list_records", args: "see_docs", optargs: "see_docs" },
        { cmd: "api-list_accessible_cmds", args: [], optargs: [] },
      ],
    }),
  ]);
  const commands = await api.listCommands();
  assertEquals(commands.length, 2);
  assertEquals(commands[0].args, "see_docs");
  assertEquals(commands[1].args, "[]");
});

// ---------------------------------------------------------------------------
// Model wiring
// ---------------------------------------------------------------------------

function makeContext(globals: Record<string, unknown>) {
  const written: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [];
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    logger: {
      info: () => {},
      debug: () => {},
      warning: () => {},
      error: () => {},
    },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

async function withFakeFetch<T>(
  handler: (url: string) => [number, string],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (input: string | URL | Request) => {
    const [status, body] = handler(String(input));
    return Promise.resolve(new Response(body, { status }));
  };
  try {
    return await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  }
}

const baseGlobals = { authToken: "test-key" };

Deno.test("listRecords writes records filtered by zone", async () => {
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(
    () => [
      200,
      JSON.stringify({
        result: "success",
        data: [
          {
            record: "a.example.com",
            type: "A",
            value: "1.1.1.1",
            zone: "example.com",
            editable: "1",
          },
          {
            record: "b.other.com",
            type: "A",
            value: "2.2.2.2",
            zone: "other.com",
            editable: "0",
          },
        ],
      }),
    ],
    () => model.methods.listRecords.execute({ zone: "example.com" }, context),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "records");
  assertEquals(written[0].data.zone, "example.com");
  assertEquals(written[0].data.count, 1);
  assertEquals(written[0].data.editableCount, 1);
});

Deno.test("listZones groups records by zone", async () => {
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(
    () => [
      200,
      JSON.stringify({
        result: "success",
        data: [
          {
            record: "a.example.com",
            type: "A",
            value: "1.1.1.1",
            zone: "example.com",
            editable: "1",
          },
          {
            record: "example.com",
            type: "MX",
            value: "10 mx",
            zone: "example.com",
            editable: "0",
          },
          {
            record: "b.other.com",
            type: "A",
            value: "2.2.2.2",
            zone: "other.com",
            editable: "0",
          },
        ],
      }),
    ],
    () => model.methods.listZones.execute({}, context),
  );
  const zones = written[0].data.zones as Array<
    { zone: string; recordCount: number; editableCount: number }
  >;
  assertEquals(written[0].data.count, 2);
  assertEquals(zones[0], {
    zone: "example.com",
    recordCount: 2,
    editableCount: 1,
  });
  assertEquals(zones[1], {
    zone: "other.com",
    recordCount: 1,
    editableCount: 0,
  });
});

Deno.test("addRecord resolves a short name against the zone", async () => {
  const { context, written } = makeContext(baseGlobals);
  let requested = "";
  await withFakeFetch(
    (url) => {
      requested = url;
      return [200, JSON.stringify({ result: "success", data: "added" })];
    },
    () =>
      model.methods.addRecord.execute(
        { record: "www", type: "a", value: "1.2.3.4", zone: "example.com" },
        context,
      ),
  );
  assertEquals(written[0].data.record, "www.example.com");
  assertEquals(written[0].data.type, "A");
  assertStringIncludes(decodeURIComponent(requested), "record=www.example.com");
});

Deno.test("addRecord rejects a short name with no zone", async () => {
  const { context } = makeContext(baseGlobals);
  await assertRejects(
    () =>
      model.methods.addRecord.execute({
        record: "www",
        type: "A",
        value: "1.2.3.4",
      }, context),
    Error,
    "supply the `zone` argument",
  );
});

Deno.test("syncRecords adds missing records and writes a summary", async () => {
  const { context, written } = makeContext(baseGlobals);
  const responses = [
    // initial listRecords
    JSON.stringify({
      result: "success",
      data: [
        {
          record: "example.com",
          type: "A",
          value: "1.2.3.4",
          zone: "example.com",
          editable: "1",
        },
        {
          record: "old.example.com",
          type: "A",
          value: "5.5.5.5",
          zone: "example.com",
          editable: "1",
        },
      ],
    }),
    // add
    JSON.stringify({ result: "success", data: "added" }),
    // remove
    JSON.stringify({ result: "success", data: "removed" }),
    // final listRecords
    JSON.stringify({
      result: "success",
      data: [
        {
          record: "example.com",
          type: "A",
          value: "1.2.3.4",
          zone: "example.com",
          editable: "1",
        },
        {
          record: "new.example.com",
          type: "CNAME",
          value: "www.example.com",
          zone: "example.com",
          editable: "1",
        },
      ],
    }),
  ];
  let i = 0;
  await withFakeFetch(
    () => [200, responses[i++]],
    () =>
      model.methods.syncRecords.execute(
        model.methods.syncRecords.arguments.parse({
          zone: "example.com",
          records: [
            { record: "@", type: "A", value: "1.2.3.4" },
            { record: "new", type: "CNAME", value: "www.example.com" },
          ],
          prune: true,
        }),
        context,
      ),
  );
  assertEquals(written[0].data.added, 1);
  assertEquals(written[0].data.removed, 1);
  assertEquals(written[0].data.unchanged, 1);
  assertEquals(written[0].data.changed, true);
  assertEquals(written[0].data.recordCount, 2);
});

Deno.test("syncRecords dryRun computes the plan without mutating", async () => {
  const { context, written } = makeContext(baseGlobals);
  let calls = 0;
  await withFakeFetch(
    () => {
      calls++;
      return [
        200,
        JSON.stringify({
          result: "success",
          data: [
            {
              record: "example.com",
              type: "A",
              value: "1.2.3.4",
              zone: "example.com",
              editable: "1",
            },
          ],
        }),
      ];
    },
    () =>
      model.methods.syncRecords.execute(
        model.methods.syncRecords.arguments.parse({
          zone: "example.com",
          records: [{ record: "new", type: "A", value: "9.9.9.9" }],
          dryRun: true,
        }),
        context,
      ),
  );
  // Only the single initial list call — no add.
  assertEquals(calls, 1);
  assertEquals(written[0].data.dryRun, true);
  assertEquals(written[0].data.added, 1);
});

Deno.test("model exposes the expected resource specs and methods", () => {
  assertEquals(model.type, "@svendowideit/dreamhost/dns");
  assertEquals(Object.keys(model.resources).sort(), [
    "change",
    "commands",
    "records",
    "sync",
    "zones",
  ]);
  assertEquals(Object.keys(model.methods).sort(), [
    "addRecord",
    "listCommands",
    "listRecords",
    "listZones",
    "removeRecord",
    "syncRecords",
  ]);
});

Deno.test("valid-api-key check fails when authToken is absent", () => {
  const result = model.checks["valid-api-key"].execute({
    globalArgs: model.globalArguments.parse({}),
    methodName: "listRecords",
  } as never);
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors?.join(" ") ?? "", "authToken");
});

Deno.test("global args reject unknown keys", () => {
  assertThrows(
    () => model.globalArguments.parse({ ...baseGlobals, bogus: true }),
    Error,
  );
});

// Mechanical check: every writeResource payload must conform to its resource
// schema (schema-write conformance). This guards against a field being added to
// a write without the schema, or vice versa.
Deno.test("every written payload conforms to its resource schema", async () => {
  const { context, written } = makeContext(baseGlobals);
  const listBody = JSON.stringify({
    result: "success",
    data: [
      {
        record: "example.com",
        type: "A",
        value: "1.2.3.4",
        zone: "example.com",
        editable: "1",
      },
    ],
  });
  await withFakeFetch(() => [200, listBody], async () => {
    await model.methods.listRecords.execute({}, context);
    await model.methods.listZones.execute({}, context);
    await model.methods.listCommands.execute({}, context);
    await model.methods.addRecord.execute(
      { record: "www", type: "A", value: "1.2.3.4", zone: "example.com" },
      context,
    );
    await model.methods.removeRecord.execute(
      { record: "www", type: "A", value: "1.2.3.4", zone: "example.com" },
      context,
    );
    await model.methods.syncRecords.execute(
      model.methods.syncRecords.arguments.parse({
        zone: "example.com",
        records: [{ record: "@", type: "A", value: "1.2.3.4" }],
      }),
      context,
    );
  });

  const specNames = Object.keys(model.resources);
  const seen = new Set(written.map((w) => w.specName));
  assertEquals(
    [...seen].sort(),
    [...specNames].sort(),
    "every resource spec should be exercised by at least one method",
  );
  for (const w of written) {
    const spec = model.resources[w.specName as keyof typeof model.resources];
    // Exact key-set equality: an extra written field would be silently
    // stripped by zod, so compare the shape explicitly.
    assertEquals(
      Object.keys(w.data).sort(),
      Object.keys(spec.schema.shape).sort(),
      `${w.specName} payload fields must match the schema exactly`,
    );
    const parsed = spec.schema.strict().safeParse(w.data);
    assertEquals(
      parsed.success,
      true,
      `${w.specName} payload failed schema: ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`,
    );
  }
});
