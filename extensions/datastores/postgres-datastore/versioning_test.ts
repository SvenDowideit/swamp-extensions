import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { createPeriodsAdapter } from "./versioning.ts";
import type { VersionMetadata } from "./versioning.ts";

// ---------------------------------------------------------------------------
// Mock postgres.Sql
// ---------------------------------------------------------------------------

interface MockSql {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

interface QueuedResponse {
  rows: Record<string, unknown>[];
}

function createMockSql(): {
  sql: MockSql;
  queries: string[];
  params: unknown[][];
  queueResponse: (rows: Record<string, unknown>[]) => void;
} {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const responseQueue: QueuedResponse[] = [];

  const sql: MockSql = {
    async unsafe(query: string, p?: unknown[]): Promise<Record<string, unknown>[]> {
      queries.push(query);
      params.push(p ?? []);
      const queued = responseQueue.shift();
      if (queued) return queued.rows;
      return [];
    },
  };

  return {
    sql,
    queries,
    params,
    queueResponse(rows: Record<string, unknown>[]) {
      responseQueue.push({ rows });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA = "swamp";
const TABLE = "items";

function makeAdapter(mock: ReturnType<typeof createMockSql>) {
  return createPeriodsAdapter(mock.sql as unknown as import("npm:postgres@3").Sql<Record<string, never>>, SCHEMA);
}

function makeVersion(overrides: Partial<VersionMetadata> = {}): VersionMetadata {
  return {
    versionId: "11111111-1111-1111-1111-111111111111",
    timestamp: "2025-01-15T10:30:00.000Z",
    method: "run",
    modelName: "test-model",
    workflowId: "wf-001",
    message: "test version",
    ...overrides,
  };
}

// ===========================================================================
// enableVersioning
// ===========================================================================

Deno.test("enableVersioning — calls periods.add_system_time_period with correct table name", async () => {
  const mock = createMockSql();
  // ensureVersionsTable: CREATE TABLE + CREATE INDEX (2 calls)
  mock.queueResponse([]);
  mock.queueResponse([]);
  // add_system_time_period
  mock.queueResponse([]);
  // add_system_versioning
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  await adapter.enableVersioning(SCHEMA, TABLE);

  const periodCall = mock.queries.find((q) => q.includes("add_system_time_period"));
  assertEquals(typeof periodCall, "string");
  assertEquals(periodCall!.includes(`"${SCHEMA}"."${TABLE}"`), true);
});

Deno.test("enableVersioning — calls periods.add_system_versioning with correct table name", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  await adapter.enableVersioning(SCHEMA, TABLE);

  const versioningCall = mock.queries.find((q) => q.includes("add_system_versioning"));
  assertEquals(typeof versioningCall, "string");
  assertEquals(versioningCall!.includes(`"${SCHEMA}"."${TABLE}"`), true);
});

Deno.test("enableVersioning — creates the _versions table if it doesn't exist", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  await adapter.enableVersioning(SCHEMA, TABLE);

  const createTableCall = mock.queries.find((q) =>
    q.includes("CREATE TABLE IF NOT EXISTS") && q.includes("_versions")
  );
  assertEquals(typeof createTableCall, "string");
  assertEquals(createTableCall!.includes("version_id"), true);
  assertEquals(createTableCall!.includes("table_name"), true);
  assertEquals(createTableCall!.includes("timestamp"), true);
});

Deno.test("enableVersioning — is idempotent (called twice on same table)", async () => {
  const mock = createMockSql();
  // First call: 4 queries
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  // Second call: 4 queries
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  await adapter.enableVersioning(SCHEMA, TABLE);
  await adapter.enableVersioning(SCHEMA, TABLE);

  // Both calls should have executed the same sequence
  const periodCalls = mock.queries.filter((q) => q.includes("add_system_time_period"));
  assertEquals(periodCalls.length, 2);
  const versioningCalls = mock.queries.filter((q) => q.includes("add_system_versioning"));
  assertEquals(versioningCalls.length, 2);
});

// ===========================================================================
// dropVersioning
// ===========================================================================

Deno.test("dropVersioning — calls periods.drop_system_versioning with correct table name", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  await adapter.dropVersioning(SCHEMA, TABLE);

  const dropCall = mock.queries.find((q) => q.includes("drop_system_versioning"));
  assertEquals(typeof dropCall, "string");
  assertEquals(dropCall!.includes(`"${SCHEMA}"."${TABLE}"`), true);
});

// ===========================================================================
// createVersion
// ===========================================================================

Deno.test("createVersion — inserts a row into _versions with correct metadata", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const version = makeVersion();
  await adapter.createVersion(SCHEMA, TABLE, version);

  const insertCall = mock.queries.find((q) => q.includes("INSERT INTO"));
  assertEquals(typeof insertCall, "string");
  assertEquals(insertCall!.includes("_versions"), true);
  assertEquals(insertCall!.includes("version_id"), true);
  assertEquals(insertCall!.includes("table_name"), true);
  assertEquals(insertCall!.includes("timestamp"), true);
  assertEquals(insertCall!.includes("method"), true);
  assertEquals(insertCall!.includes("model_name"), true);
  assertEquals(insertCall!.includes("workflow_id"), true);
  assertEquals(insertCall!.includes("message"), true);

  // Verify params contain the metadata values
  const p = mock.params.find((_, i) => mock.queries[i].includes("INSERT INTO"))!;
  assertEquals(p[0], version.versionId);
  assertEquals(p[1], TABLE);
  assertEquals(p[2], version.timestamp);
  assertEquals(p[3], version.method);
  assertEquals(p[4], version.modelName);
  assertEquals(p[5], version.workflowId);
  assertEquals(p[6], version.message);
});

Deno.test("createVersion — returns the version UUID", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const version = makeVersion();
  const result = await adapter.createVersion(SCHEMA, TABLE, version);

  assertEquals(result, version.versionId);
});

Deno.test("createVersion — with all metadata fields populated", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const version = makeVersion({
    method: "sync",
    modelName: "full-model",
    workflowId: "wf-full-001",
    message: "Full metadata snapshot after nightly sync",
  });
  const result = await adapter.createVersion(SCHEMA, TABLE, version);

  assertEquals(result, version.versionId);
  const p = mock.params.find((_, i) => mock.queries[i].includes("INSERT INTO"))!;
  assertEquals(p[3], "sync");
  assertEquals(p[4], "full-model");
  assertEquals(p[5], "wf-full-001");
  assertEquals(p[6], "Full metadata snapshot after nightly sync");
});

Deno.test("createVersion — with minimal metadata (only required fields)", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const version: VersionMetadata = {
    versionId: "22222222-2222-2222-2222-222222222222",
    timestamp: "2025-06-01T00:00:00.000Z",
  };
  const result = await adapter.createVersion(SCHEMA, TABLE, version);

  assertEquals(result, version.versionId);
  const p = mock.params.find((_, i) => mock.queries[i].includes("INSERT INTO"))!;
  assertEquals(p[3], null);
  assertEquals(p[4], null);
  assertEquals(p[5], null);
  assertEquals(p[6], null);
});

Deno.test("createVersion — timestamp defaults to now() if not provided", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const version: VersionMetadata = {
    versionId: "33333333-3333-3333-3333-333333333333",
    timestamp: "",
  };
  await adapter.createVersion(SCHEMA, TABLE, version);

  const p = mock.params.find((_, i) => mock.queries[i].includes("INSERT INTO"))!;
  // When timestamp is empty string (falsy), it should default to a current ISO timestamp
  assertEquals(typeof p[2], "string");
  assertEquals((p[2] as string).length > 0, true);
  // Should be a valid ISO date
  assertEquals(isNaN(Date.parse(p[2] as string)), false);
});

// ===========================================================================
// getCurrentRows
// ===========================================================================

Deno.test("getCurrentRows — returns all rows from the main table", async () => {
  const mock = createMockSql();
  const rows = [
    { id: 1, name: "alpha", value: 100 },
    { id: 2, name: "beta", value: 200 },
  ];
  mock.queueResponse(rows);

  const adapter = makeAdapter(mock);
  const result = await adapter.getCurrentRows(SCHEMA, TABLE);

  assertEquals(result, rows);
  assertEquals(result.length, 2);
});

Deno.test("getCurrentRows — with column filter (specific columns only)", async () => {
  const mock = createMockSql();
  const rows = [
    { id: 1, name: "alpha" },
    { id: 2, name: "beta" },
  ];
  mock.queueResponse(rows);

  const adapter = makeAdapter(mock);
  const result = await adapter.getCurrentRows(SCHEMA, TABLE, ["id", "name"]);

  assertEquals(result, rows);
  const selectCall = mock.queries.find((q) => q.includes("SELECT"));
  assertEquals(selectCall!.includes('"id", "name"'), true);
  assertEquals(selectCall!.includes("*"), false);
});

Deno.test("getCurrentRows — with empty table returns empty array", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const result = await adapter.getCurrentRows(SCHEMA, TABLE);

  assertEquals(result, []);
  assertEquals(result.length, 0);
});

Deno.test("getCurrentRows — does NOT return history rows", async () => {
  const mock = createMockSql();
  // The query only targets the main table, not _history
  mock.queueResponse([{ id: 1, name: "current" }]);

  const adapter = makeAdapter(mock);
  const result = await adapter.getCurrentRows(SCHEMA, TABLE);

  assertEquals(result.length, 1);
  const selectCall = mock.queries.find((q) => q.includes("SELECT"));
  // Should query the main table, not _history
  assertEquals(selectCall!.includes("_history"), false);
  assertEquals(selectCall!.includes(`"${SCHEMA}"."${TABLE}"`), true);
});

// ===========================================================================
// getRowsAtVersion
// ===========================================================================

Deno.test("getRowsAtVersion — looks up the version timestamp from _versions", async () => {
  const mock = createMockSql();
  // First query: look up version timestamp
  mock.queueResponse([{ timestamp: "2025-01-15T10:30:00.000Z" }]);
  // Second query: __as_of
  mock.queueResponse([{ id: 1, name: "historical" }]);

  const adapter = makeAdapter(mock);
  await adapter.getRowsAtVersion(SCHEMA, TABLE, "11111111-1111-1111-1111-111111111111");

  const lookupCall = mock.queries[0];
  assertEquals(lookupCall.includes("_versions"), true);
  assertEquals(lookupCall.includes("version_id"), true);
  assertEquals(mock.params[0][0], "11111111-1111-1111-1111-111111111111");
});

Deno.test("getRowsAtVersion — calls __as_of(timestamp) with the correct timestamp", async () => {
  const mock = createMockSql();
  const ts = "2025-01-15T10:30:00.000Z";
  mock.queueResponse([{ timestamp: ts }]);
  mock.queueResponse([{ id: 1, name: "historical" }]);

  const adapter = makeAdapter(mock);
  await adapter.getRowsAtVersion(SCHEMA, TABLE, "11111111-1111-1111-1111-111111111111");

  const asOfCall = mock.queries[1];
  assertEquals(asOfCall.includes("__as_of"), true);
  assertEquals(mock.params[1][0], ts);
});

Deno.test("getRowsAtVersion — throws if versionId not found", async () => {
  const mock = createMockSql();
  // Version lookup returns empty
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  await assertRejects(
    () => adapter.getRowsAtVersion(SCHEMA, TABLE, "nonexistent-id"),
    Error,
    "Version not found",
  );
});

Deno.test("getRowsAtVersion — with column filter", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ timestamp: "2025-01-15T10:30:00.000Z" }]);
  mock.queueResponse([{ id: 1, name: "historical" }]);

  const adapter = makeAdapter(mock);
  await adapter.getRowsAtVersion(SCHEMA, TABLE, "11111111-1111-1111-1111-111111111111", ["id", "name"]);

  const asOfCall = mock.queries[1];
  assertEquals(asOfCall.includes('"id", "name"'), true);
  assertEquals(asOfCall.includes("*"), false);
});

Deno.test("getRowsAtVersion — returns the correct historical state", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ timestamp: "2025-01-15T10:30:00.000Z" }]);
  const historicalRows = [
    { id: 1, name: "alpha", value: 100 },
    { id: 2, name: "beta", value: 200 },
  ];
  mock.queueResponse(historicalRows);

  const adapter = makeAdapter(mock);
  const result = await adapter.getRowsAtVersion(SCHEMA, TABLE, "11111111-1111-1111-1111-111111111111");

  assertEquals(result, historicalRows);
  assertEquals(result.length, 2);
});

// ===========================================================================
// listVersions
// ===========================================================================

Deno.test("listVersions — returns versions ordered by timestamp DESC", async () => {
  const mock = createMockSql();
  mock.queueResponse([
    { version_id: "v3", table_name: TABLE, timestamp: new Date("2025-03-01T00:00:00Z"), method: "run", model_name: null, workflow_id: null, message: null },
    { version_id: "v2", table_name: TABLE, timestamp: new Date("2025-02-01T00:00:00Z"), method: "run", model_name: null, workflow_id: null, message: null },
    { version_id: "v1", table_name: TABLE, timestamp: new Date("2025-01-01T00:00:00Z"), method: "run", model_name: null, workflow_id: null, message: null },
  ]);

  const adapter = makeAdapter(mock);
  const result = await adapter.listVersions(SCHEMA, TABLE);

  assertEquals(result.length, 3);
  assertEquals(result[0].versionId, "v3");
  assertEquals(result[1].versionId, "v2");
  assertEquals(result[2].versionId, "v1");

  // Verify ORDER BY timestamp DESC is in the query
  const listCall = mock.queries[0];
  assertEquals(listCall.includes("ORDER BY timestamp DESC"), true);
});

Deno.test("listVersions — with no versions returns empty array", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const result = await adapter.listVersions(SCHEMA, TABLE);

  assertEquals(result, []);
  assertEquals(result.length, 0);
});

Deno.test("listVersions — with multiple versions returns correct order", async () => {
  const mock = createMockSql();
  mock.queueResponse([
    { version_id: "v5", table_name: TABLE, timestamp: new Date("2025-05-01T00:00:00Z"), method: "run", model_name: "m", workflow_id: null, message: null },
    { version_id: "v4", table_name: TABLE, timestamp: new Date("2025-04-01T00:00:00Z"), method: "sync", model_name: "m", workflow_id: "wf", message: "msg" },
    { version_id: "v3", table_name: TABLE, timestamp: new Date("2025-03-01T00:00:00Z"), method: null, model_name: null, workflow_id: null, message: null },
    { version_id: "v2", table_name: TABLE, timestamp: new Date("2025-02-01T00:00:00Z"), method: "run", model_name: null, workflow_id: null, message: null },
    { version_id: "v1", table_name: TABLE, timestamp: new Date("2025-01-01T00:00:00Z"), method: "run", model_name: null, workflow_id: null, message: null },
  ]);

  const adapter = makeAdapter(mock);
  const result = await adapter.listVersions(SCHEMA, TABLE);

  assertEquals(result.length, 5);
  // Newest first
  assertEquals(result[0].versionId, "v5");
  assertEquals(result[4].versionId, "v1");
  // Verify metadata mapping
  assertEquals(result[1].method, "sync");
  assertEquals(result[1].workflowId, "wf");
  assertEquals(result[1].message, "msg");
  assertEquals(result[2].method, undefined);
  assertEquals(result[2].modelName, undefined);
});

Deno.test("listVersions — only returns versions for the specified table", async () => {
  const mock = createMockSql();
  mock.queueResponse([
    { version_id: "v1", table_name: "items", timestamp: new Date("2025-01-01T00:00:00Z"), method: "run", model_name: null, workflow_id: null, message: null },
  ]);

  const adapter = makeAdapter(mock);
  await adapter.listVersions(SCHEMA, "items");

  const listCall = mock.queries[0];
  assertEquals(listCall.includes("WHERE table_name = $1"), true);
  assertEquals(mock.params[0][0], "items");
});

// ===========================================================================
// pruneVersions
// ===========================================================================

Deno.test("pruneVersions — deletes old version metadata rows", async () => {
  const mock = createMockSql();
  // Before count
  mock.queueResponse([{ count: 10 }]);
  // DELETE from _versions
  mock.queueResponse([]);
  // DELETE from _history
  mock.queueResponse([]);
  // After count
  mock.queueResponse([{ count: 3 }]);

  const adapter = makeAdapter(mock);
  const pruned = await adapter.pruneVersions(SCHEMA, TABLE, 3);

  assertEquals(pruned, 7);

  // Verify DELETE from _versions was called
  const deleteVersionsCall = mock.queries.find((q) =>
    q.includes("DELETE FROM") && q.includes("_versions")
  );
  assertEquals(typeof deleteVersionsCall, "string");
  assertEquals(deleteVersionsCall!.includes("NOT IN"), true);
  assertEquals(deleteVersionsCall!.includes("LIMIT $2"), true);
});

Deno.test("pruneVersions — deletes old history rows", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ count: 10 }]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([{ count: 3 }]);

  const adapter = makeAdapter(mock);
  await adapter.pruneVersions(SCHEMA, TABLE, 3);

  const deleteHistoryCall = mock.queries.find((q) =>
    q.includes("DELETE FROM") && q.includes("_history")
  );
  assertEquals(typeof deleteHistoryCall, "string");
  assertEquals(deleteHistoryCall!.includes("row_end"), true);
});

Deno.test("pruneVersions — keeps the most recent keepCount versions", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ count: 5 }]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([{ count: 2 }]);

  const adapter = makeAdapter(mock);
  const pruned = await adapter.pruneVersions(SCHEMA, TABLE, 2);

  assertEquals(pruned, 3);

  // Verify LIMIT is set to keepCount
  const deleteCall = mock.queries.find((q) =>
    q.includes("DELETE FROM") && q.includes("_versions")
  )!;
  const limitParamIdx = mock.queries.indexOf(deleteCall);
  assertEquals(mock.params[limitParamIdx][1], 2);
});

Deno.test("pruneVersions — returns the number of pruned versions", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ count: 20 }]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([{ count: 5 }]);

  const adapter = makeAdapter(mock);
  const pruned = await adapter.pruneVersions(SCHEMA, TABLE, 5);

  assertEquals(pruned, 15);
});

Deno.test("pruneVersions — with keepCount larger than total versions prunes nothing", async () => {
  const mock = createMockSql();
  // 3 total, keep 10
  mock.queueResponse([{ count: 3 }]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([{ count: 3 }]);

  const adapter = makeAdapter(mock);
  const pruned = await adapter.pruneVersions(SCHEMA, TABLE, 10);

  assertEquals(pruned, 0);
});

Deno.test("pruneVersions — with keepCount = 0 prunes everything", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ count: 5 }]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([{ count: 0 }]);

  const adapter = makeAdapter(mock);
  const pruned = await adapter.pruneVersions(SCHEMA, TABLE, 0);

  assertEquals(pruned, 5);
});

// ===========================================================================
// Edge Cases
// ===========================================================================

Deno.test("edge case — special characters in table names are quoted correctly", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const weirdTable = 'my-table';
  await adapter.enableVersioning(SCHEMA, weirdTable);

  const periodCall = mock.queries.find((q) => q.includes("add_system_time_period"))!;
  // Table name should be double-quoted
  assertEquals(periodCall.includes(`"${weirdTable}"`), true);
});

Deno.test("edge case — table names with double quotes are escaped", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const quotedTable = 'my"table';
  await adapter.enableVersioning(SCHEMA, quotedTable);

  const periodCall = mock.queries.find((q) => q.includes("add_system_time_period"))!;
  // Double quotes inside identifier should be escaped to ""
  assertEquals(periodCall.includes(`"my""table"`), true);
});

Deno.test("edge case — schema-qualified table names", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const customSchema = "custom_schema";
  await adapter.enableVersioning(customSchema, TABLE);

  const periodCall = mock.queries.find((q) => q.includes("add_system_time_period"))!;
  assertEquals(periodCall.includes(`"${customSchema}"."${TABLE}"`), true);
});

Deno.test("edge case — concurrent version creation (two versions created in sequence)", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const v1 = makeVersion({ versionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", timestamp: "2025-01-01T00:00:00.000Z" });
  const v2 = makeVersion({ versionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", timestamp: "2025-01-02T00:00:00.000Z" });

  const id1 = await adapter.createVersion(SCHEMA, TABLE, v1);
  const id2 = await adapter.createVersion(SCHEMA, TABLE, v2);

  assertEquals(id1, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assertEquals(id2, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

  // Both INSERTs should have been executed
  const insertCalls = mock.queries.filter((q) => q.includes("INSERT INTO"));
  assertEquals(insertCalls.length, 2);

  // First insert should have v1's timestamp
  assertEquals(mock.params[0][2], "2025-01-01T00:00:00.000Z");
  // Second insert should have v2's timestamp
  assertEquals(mock.params[1][2], "2025-01-02T00:00:00.000Z");
});

Deno.test("edge case — version query after schema migration (new columns appear as NULL in old versions)", async () => {
  const mock = createMockSql();
  // Old version only had id and name columns
  mock.queueResponse([{ timestamp: "2025-01-01T00:00:00.000Z" }]);
  // __as_of returns rows without the new "description" column
  mock.queueResponse([
    { id: 1, name: "alpha" },
    { id: 2, name: "beta" },
  ]);

  const adapter = makeAdapter(mock);
  const result = await adapter.getRowsAtVersion(SCHEMA, TABLE, "old-version-id");

  assertEquals(result.length, 2);
  // New columns that didn't exist at the time of the version would be absent
  assertEquals("description" in result[0], false);
  assertEquals("description" in result[1], false);
});

Deno.test("edge case — getRowsAtVersion handles Date timestamp from _versions", async () => {
  const mock = createMockSql();
  const versionDate = new Date("2025-06-15T12:00:00.000Z");
  mock.queueResponse([{ timestamp: versionDate }]);
  mock.queueResponse([{ id: 1, name: "historical" }]);

  const adapter = makeAdapter(mock);
  await adapter.getRowsAtVersion(SCHEMA, TABLE, "date-version-id");

  // The timestamp should be converted to ISO string
  assertEquals(mock.params[1][0], versionDate.toISOString());
});

Deno.test("edge case — listVersions handles string timestamps (not Date objects)", async () => {
  const mock = createMockSql();
  mock.queueResponse([
    { version_id: "v1", table_name: TABLE, timestamp: "2025-01-01T00:00:00.000Z", method: "run", model_name: null, workflow_id: null, message: null },
  ]);

  const adapter = makeAdapter(mock);
  const result = await adapter.listVersions(SCHEMA, TABLE);

  assertEquals(result.length, 1);
  assertEquals(result[0].timestamp, "2025-01-01T00:00:00.000Z");
});

Deno.test("edge case — getCurrentRows with empty columns array uses *", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ id: 1, name: "alpha", value: 100 }]);

  const adapter = makeAdapter(mock);
  await adapter.getCurrentRows(SCHEMA, TABLE, []);

  const selectCall = mock.queries[0];
  assertEquals(selectCall.includes("*"), true);
});

Deno.test("edge case — getRowsAtVersion with empty columns array uses *", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ timestamp: "2025-01-01T00:00:00.000Z" }]);
  mock.queueResponse([{ id: 1, name: "alpha" }]);

  const adapter = makeAdapter(mock);
  await adapter.getRowsAtVersion(SCHEMA, TABLE, "v1", []);

  const asOfCall = mock.queries[1];
  assertEquals(asOfCall.includes("*"), true);
});

Deno.test("edge case — createVersion generates a UUID when versionId is empty", async () => {
  const mock = createMockSql();
  mock.queueResponse([]);

  const adapter = makeAdapter(mock);
  const version: VersionMetadata = {
    versionId: "",
    timestamp: "2025-01-01T00:00:00.000Z",
  };
  const result = await adapter.createVersion(SCHEMA, TABLE, version);

  // Should have generated a UUID (36 chars, with dashes)
  assertEquals(result.length, 36);
  assertEquals(result.includes("-"), true);
  // Should be different from the empty input
  assertEquals(result !== "", true);
});

Deno.test("edge case — pruneVersions with single version and keepCount=1 prunes nothing", async () => {
  const mock = createMockSql();
  mock.queueResponse([{ count: 1 }]);
  mock.queueResponse([]);
  mock.queueResponse([]);
  mock.queueResponse([{ count: 1 }]);

  const adapter = makeAdapter(mock);
  const pruned = await adapter.pruneVersions(SCHEMA, TABLE, 1);

  assertEquals(pruned, 0);
});
