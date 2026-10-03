import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  base64Encode,
  basicAuth,
  buildSearchBody,
  columnsOf,
  expandHome,
  healthUrl,
  looksLikeMutation,
  model,
  normaliseBaseUrl,
  parseSearchResponse,
  parseStreamsResponse,
  resolveWindow,
  searchUrl,
  streamsUrl,
} from "./openobserve.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("normaliseBaseUrl drops trailing slashes", () => {
  assertEquals(normaliseBaseUrl("http://h:5080/"), "http://h:5080");
  assertEquals(normaliseBaseUrl("http://h:5080///"), "http://h:5080");
  assertEquals(normaliseBaseUrl("http://h:5080"), "http://h:5080");
});

Deno.test("expandHome expands a leading tilde with an injectable home", () => {
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});

Deno.test("resolveWindow defaults to the last hour and rejects inverted windows", () => {
  const w = resolveWindow(undefined, 1_000_000_000);
  assertEquals(w.endTime, 1_000_000_000);
  assertEquals(w.startTime, 1_000_000_000 - 3600 * 1_000_000);
  assertThrows(() => resolveWindow(200, 100));
});

Deno.test("looksLikeMutation flags writes and DDL, not selects", () => {
  assert(looksLikeMutation("INSERT INTO t VALUES (1)"));
  assert(looksLikeMutation("  delete from t"));
  assert(looksLikeMutation("DROP TABLE t"));
  assert(!looksLikeMutation('select * from "s"'));
  assert(!looksLikeMutation("SELECT count(*) FROM t"));
  assert(!looksLikeMutation("with x as (select 1) select * from x"));
});

Deno.test("URL builders are org-scoped and type-aware", () => {
  assertEquals(
    searchUrl("http://h:5080/", "default", "logs"),
    "http://h:5080/api/default/_search?type=logs",
  );
  assertEquals(
    streamsUrl("http://h:5080", "default"),
    "http://h:5080/api/default/streams",
  );
  assertEquals(
    streamsUrl("http://h:5080", "default", "traces"),
    "http://h:5080/api/default/streams?type=traces",
  );
  assertEquals(healthUrl("http://h:5080/"), "http://h:5080/healthz");
});

Deno.test("buildSearchBody uses microsecond window fields and size", () => {
  const body = JSON.parse(buildSearchBody({
    sql: "select 1",
    startTime: 100,
    endTime: 200,
    size: 5,
  }));
  assertEquals(body.query.sql, "select 1");
  assertEquals(body.query.start_time, 100);
  assertEquals(body.query.end_time, 200);
  assertEquals(body.size, 5);
});

Deno.test("parseSearchResponse reads total/took/rows and tolerates junk", () => {
  const parsed = parseSearchResponse({
    total: 7,
    took: 12,
    hits: [{ a: 1 }, { b: 2 }],
  });
  assertEquals(parsed.total, 7);
  assertEquals(parsed.took, 12);
  assertEquals(parsed.rows.length, 2);
  const empty = parseSearchResponse(null);
  assertEquals(empty.total, 0);
  assertEquals(empty.rows, []);
});

Deno.test("columnsOf is sorted and deterministic", () => {
  assertEquals(columnsOf({ b: 1, a: 2 }), ["a", "b"]);
  assertEquals(columnsOf({}), []);
});

Deno.test("parseStreamsResponse flattens list entries", () => {
  const streams = parseStreamsResponse({
    list: [
      {
        name: "app",
        stream_type: "logs",
        storage_type: "disk",
        stats: { doc_num: 42, storage_size: 1024 },
        settings: { data_retention: 14 },
      },
    ],
  });
  assertEquals(streams.length, 1);
  assertEquals(streams[0], {
    name: "app",
    streamType: "logs",
    storageType: "disk",
    docNum: 42,
    storageSize: 1024,
    dataRetentionDays: 14,
  });
  assertEquals(parseStreamsResponse({}), []);
});

Deno.test("base64Encode and basicAuth render an OpenObserve header", () => {
  assertEquals(base64Encode("a:b"), btoa("a:b"));
  assertEquals(
    basicAuth("root@example.com", "Complexpass#123"),
    `Basic ${btoa("root@example.com:Complexpass#123")}`,
  );
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

Deno.test("model exposes the expected methods", () => {
  assertEquals(model.type, "@svendowideit/openobserve");
  assertEquals(
    Object.keys(model.methods).sort(),
    ["health", "query", "retention", "streams"],
  );
});

Deno.test("model global args default to localhost and the default org", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.baseUrl, "http://127.0.0.1:5080");
  assertEquals(parsed.organization, "default");
  assertEquals(parsed.defaultSize, 100);
});

Deno.test("model global args are strict", () => {
  assertThrows(() => model.globalArguments.parse({ nope: 1 }));
});

Deno.test("the read-only-sql check rejects a mutation on the query method", () => {
  const check = model.checks["read-only-sql"].execute;
  const bad = check({
    globalArgs: model.globalArguments.parse({}),
    methodArgs: { sql: "delete from t" },
  });
  assert(!bad.pass);
  assertStringIncludes((bad.errors ?? []).join(" "), "read-only");
  const ok = check({
    globalArgs: model.globalArguments.parse({}),
    methodArgs: { sql: "select * from t" },
  });
  assertEquals(ok.pass, true);
});
