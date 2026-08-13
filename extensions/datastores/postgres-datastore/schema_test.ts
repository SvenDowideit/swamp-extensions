/**
 * Unit tests for the Schema Manager.
 *
 * Covers zodToSqlType, zodToSqlConstraints, diffSchemas, createTable,
 * migrateSchema, importTable, and edge cases.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import type { VersioningAdapter } from "./versioning.ts";
import {
  zodToSqlType,
  zodToSqlConstraints,
  diffSchemas,
  createTable,
  migrateSchema,
  importTable,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockSqlCall {
  query: string;
  params?: unknown[];
}

/**
 * Creates a mock postgres.Sql that records all unsafe() calls and returns
 * configurable results in FIFO order. Each queued result is consumed by the
 * next unsafe() call. When the queue is exhausted, returns [].
 */
function createMockSql() {
  const calls: MockSqlCall[] = [];
  const results: unknown[] = [];
  let resultIdx = 0;

  return {
    calls,
    unsafe(query: string, params?: unknown[]): Promise<unknown> {
      calls.push({ query, params });
      const result = resultIdx < results.length ? results[resultIdx] : [];
      if (resultIdx < results.length) resultIdx++;
      return Promise.resolve(result);
    },
    /** Queue a result to be returned by the next unsafe() call. */
    queueResult(result: unknown) {
      results.push(result);
    },
  };
}

/** Creates a mock VersioningAdapter that records enableVersioning calls. */
function createMockVersioningAdapter() {
  const calls: { method: string; schema: string; tableName: string }[] = [];
  return {
    calls,
    async enableVersioning(schema: string, tableName: string) {
      calls.push({ method: "enableVersioning", schema, tableName });
    },
    async dropVersioning(schema: string, tableName: string) {
      calls.push({ method: "dropVersioning", schema, tableName });
    },
  };
}

// ===========================================================================
// 1. zodToSqlType
// ===========================================================================

Deno.test("zodToSqlType: z.string() → TEXT", () => {
  assertEquals(zodToSqlType(z.string()), "TEXT");
});

Deno.test("zodToSqlType: z.string().uuid() → UUID", () => {
  assertEquals(zodToSqlType(z.string().uuid()), "UUID");
});

Deno.test("zodToSqlType: z.string().email() → VARCHAR(254)", () => {
  assertEquals(zodToSqlType(z.string().email()), "VARCHAR(254)");
});

Deno.test("zodToSqlType: z.string().url() → VARCHAR(2048)", () => {
  assertEquals(zodToSqlType(z.string().url()), "VARCHAR(2048)");
});

Deno.test("zodToSqlType: z.string().min(5).max(100) → VARCHAR(100)", () => {
  assertEquals(zodToSqlType(z.string().min(5).max(100)), "VARCHAR(100)");
});

Deno.test("zodToSqlType: z.number() → DOUBLE PRECISION", () => {
  assertEquals(zodToSqlType(z.number()), "DOUBLE PRECISION");
});

Deno.test("zodToSqlType: z.number().int() → BIGINT", () => {
  assertEquals(zodToSqlType(z.number().int()), "BIGINT");
});

Deno.test("zodToSqlType: z.boolean() → BOOLEAN", () => {
  assertEquals(zodToSqlType(z.boolean()), "BOOLEAN");
});

Deno.test("zodToSqlType: z.enum() → VARCHAR(max enum value length)", () => {
  assertEquals(zodToSqlType(z.enum(["a", "bb", "ccc"])), "VARCHAR(3)");
});

Deno.test("zodToSqlType: z.iso.datetime() → TIMESTAMPTZ", () => {
  assertEquals(zodToSqlType(z.iso.datetime()), "TIMESTAMPTZ");
});

Deno.test("zodToSqlType: z.date() → DATE", () => {
  assertEquals(zodToSqlType(z.date()), "DATE");
});

Deno.test("zodToSqlType: z.array(z.string()) → JSONB", () => {
  assertEquals(zodToSqlType(z.array(z.string())), "JSONB");
});

Deno.test("zodToSqlType: z.object() → JSONB", () => {
  assertEquals(zodToSqlType(z.object({ x: z.string() })), "JSONB");
});

Deno.test("zodToSqlType: z.record() → JSONB", () => {
  assertEquals(zodToSqlType(z.record(z.string(), z.unknown())), "JSONB");
});

Deno.test("zodToSqlType: z.union() → JSONB", () => {
  assertEquals(zodToSqlType(z.union([z.string(), z.number()])), "JSONB");
});

Deno.test("zodToSqlType: z.literal(string) → VARCHAR(length)", () => {
  assertEquals(zodToSqlType(z.literal("hello")), "VARCHAR(5)");
});

Deno.test("zodToSqlType: z.bigint() → NUMERIC", () => {
  assertEquals(zodToSqlType(z.bigint()), "NUMERIC");
});

Deno.test("zodToSqlType: z.string().optional() → TEXT (optionality doesn't change type)", () => {
  assertEquals(zodToSqlType(z.string().optional()), "TEXT");
});

Deno.test("zodToSqlType: z.string().nullable() → TEXT", () => {
  assertEquals(zodToSqlType(z.string().nullable()), "TEXT");
});

Deno.test("zodToSqlType: z.string().default(\"foo\") → TEXT", () => {
  assertEquals(zodToSqlType(z.string().default("foo")), "TEXT");
});

// ===========================================================================
// 2. zodToSqlConstraints
// ===========================================================================

Deno.test("zodToSqlConstraints: z.string().min(5) → char_length >= 5", () => {
  const result = zodToSqlConstraints(z.string().min(5), "col");
  assertEquals(result, ['char_length("col") >= 5']);
});

Deno.test("zodToSqlConstraints: z.string().max(100) → char_length <= 100", () => {
  const result = zodToSqlConstraints(z.string().max(100), "col");
  assertEquals(result, ['char_length("col") <= 100']);
});

Deno.test("zodToSqlConstraints: z.string().min(5).max(100) → both constraints", () => {
  const result = zodToSqlConstraints(z.string().min(5).max(100), "col");
  assertEquals(result.length, 2);
  assertEquals(result[0], 'char_length("col") >= 5');
  assertEquals(result[1], 'char_length("col") <= 100');
});

Deno.test("zodToSqlConstraints: z.string().email() → email regex CHECK", () => {
  const result = zodToSqlConstraints(z.string().email(), "col");
  assertEquals(result.length, 1);
  assertEquals(result[0].startsWith('"col" ~'), true);
  assertEquals(result[0].includes("@"), true);
});

Deno.test("zodToSqlConstraints: z.string().url() → url regex CHECK", () => {
  const result = zodToSqlConstraints(z.string().url(), "col");
  assertEquals(result.length, 1);
  assertEquals(result[0].startsWith('"col" ~'), true);
  assertEquals(result[0].includes("https?://"), true);
});

Deno.test("zodToSqlConstraints: z.string().regex() → regex CHECK", () => {
  const result = zodToSqlConstraints(z.string().regex(/^[a-z]+$/), "col");
  assertEquals(result.length, 1);
  assertEquals(result[0], '"col" ~ \'^[a-z]+$\'');
});

Deno.test("zodToSqlConstraints: z.number().int().min(0) → >= 0", () => {
  const result = zodToSqlConstraints(z.number().int().min(0), "col");
  assertEquals(result, ['"col" >= 0']);
});

Deno.test("zodToSqlConstraints: z.number().max(100) → <= 100", () => {
  const result = zodToSqlConstraints(z.number().max(100), "col");
  assertEquals(result, ['"col" <= 100']);
});

Deno.test("zodToSqlConstraints: z.enum() → IN check", () => {
  const result = zodToSqlConstraints(z.enum(["a", "b", "c"]), "col");
  assertEquals(result, ['"col" IN (\'a\', \'b\', \'c\')']);
});

Deno.test("zodToSqlConstraints: z.literal(string) → equality check", () => {
  const result = zodToSqlConstraints(z.literal("hello"), "col");
  assertEquals(result, ["\"col\" = 'hello'"]);
});

Deno.test("zodToSqlConstraints: z.literal(number) → equality check", () => {
  const result = zodToSqlConstraints(z.literal(42), "col");
  assertEquals(result, ['"col" = 42']);
});

Deno.test("zodToSqlConstraints: z.literal(boolean) → equality check", () => {
  const result = zodToSqlConstraints(z.literal(true), "col");
  assertEquals(result, ['"col" = true']);
});

Deno.test("zodToSqlConstraints: z.literal(null) → IS NULL check", () => {
  const result = zodToSqlConstraints(z.literal(null), "col");
  assertEquals(result, ['"col" IS NULL']);
});

Deno.test("zodToSqlConstraints: z.string() with no constraints → empty array", () => {
  const result = zodToSqlConstraints(z.string(), "col");
  assertEquals(result, []);
});

// ===========================================================================
// 3. diffSchemas
// ===========================================================================

Deno.test("diffSchemas: add column", () => {
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.string(), b: z.number() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 1);
  assertEquals(changes[0].type, "add_column");
  assertEquals(changes[0].columnName, "b");
  assertEquals(changes[0].newType, "DOUBLE PRECISION");
  assertEquals(changes[0].isOptional, false);
});

Deno.test("diffSchemas: add optional column", () => {
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.string(), b: z.number().optional() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 1);
  assertEquals(changes[0].type, "add_column");
  assertEquals(changes[0].columnName, "b");
  assertEquals(changes[0].isOptional, true);
});

Deno.test("diffSchemas: drop column", () => {
  const oldSchema = z.object({ a: z.string(), b: z.number() });
  const newSchema = z.object({ a: z.string() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 1);
  assertEquals(changes[0].type, "drop_column");
  assertEquals(changes[0].columnName, "b");
});

Deno.test("diffSchemas: change type", () => {
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.number() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 1);
  assertEquals(changes[0].type, "change_type");
  assertEquals(changes[0].columnName, "a");
  assertEquals(changes[0].oldType, "TEXT");
  assertEquals(changes[0].newType, "DOUBLE PRECISION");
});

Deno.test("diffSchemas: add constraint (email also changes type)", () => {
  // z.string() → z.string().email() changes type TEXT→VARCHAR(254) AND adds
  // the email regex constraint, so diffSchemas reports both changes.
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.string().email() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 2);
  assertEquals(changes[0].type, "change_type");
  assertEquals(changes[0].columnName, "a");
  assertEquals(changes[0].oldType, "TEXT");
  assertEquals(changes[0].newType, "VARCHAR(254)");
  assertEquals(changes[1].type, "add_constraint");
  assertEquals(changes[1].columnName, "a");
  assertEquals(typeof changes[1].constraint, "string");
});

Deno.test("diffSchemas: drop constraint (email also changes type back)", () => {
  // z.string().email() → z.string() changes type VARCHAR(254)→TEXT AND drops
  // the email regex constraint.
  const oldSchema = z.object({ a: z.string().email() });
  const newSchema = z.object({ a: z.string() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 2);
  assertEquals(changes[0].type, "change_type");
  assertEquals(changes[0].columnName, "a");
  assertEquals(changes[0].oldType, "VARCHAR(254)");
  assertEquals(changes[0].newType, "TEXT");
  assertEquals(changes[1].type, "drop_constraint");
  assertEquals(changes[1].columnName, "a");
});

Deno.test("diffSchemas: change optionality — added .optional()", () => {
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.string().optional() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 1);
  assertEquals(changes[0].type, "change_optionality");
  assertEquals(changes[0].columnName, "a");
  assertEquals(changes[0].wasOptional, false);
  assertEquals(changes[0].isOptional, true);
});

Deno.test("diffSchemas: change optionality — removed .optional()", () => {
  const oldSchema = z.object({ a: z.string().optional() });
  const newSchema = z.object({ a: z.string() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 1);
  assertEquals(changes[0].type, "change_optionality");
  assertEquals(changes[0].columnName, "a");
  assertEquals(changes[0].wasOptional, true);
  assertEquals(changes[0].isOptional, false);
});

Deno.test("diffSchemas: multiple changes — correct ordering", () => {
  // nullable adds first, then required adds, type changes, constraints,
  // optionality changes, drops last
  const oldSchema = z.object({
    a: z.string(),
    b: z.string().optional(),
    c: z.string().email(),
    d: z.string(),
  });
  const newSchema = z.object({
    b: z.string(),
    c: z.string(),
    e: z.string().optional(),
    f: z.string(),
  });

  const changes = diffSchemas(oldSchema, newSchema);

  // Expected order:
  // 1. add_column e (nullable)
  // 2. add_column f (required)
  // 3. change_type c (VARCHAR(254) → TEXT)
  // 4. drop_constraint c (email constraint removed)
  // 5. change_optionality b (was optional, now required)
  // 6. drop_column a
  // 7. drop_column d
  assertEquals(changes.length, 7);

  assertEquals(changes[0].type, "add_column");
  assertEquals(changes[0].columnName, "e");
  assertEquals(changes[0].isOptional, true);

  assertEquals(changes[1].type, "add_column");
  assertEquals(changes[1].columnName, "f");
  assertEquals(changes[1].isOptional, false);

  assertEquals(changes[2].type, "change_type");
  assertEquals(changes[2].columnName, "c");

  assertEquals(changes[3].type, "drop_constraint");
  assertEquals(changes[3].columnName, "c");

  assertEquals(changes[4].type, "change_optionality");
  assertEquals(changes[4].columnName, "b");

  assertEquals(changes[5].type, "drop_column");
  assertEquals(changes[6].type, "drop_column");
  // drops can be in any order
  const dropNames = [changes[5].columnName, changes[6].columnName].sort();
  assertEquals(dropNames, ["a", "d"]);
});

Deno.test("diffSchemas: no changes — same schema → empty array", () => {
  const schema = z.object({ a: z.string(), b: z.number() });
  const changes = diffSchemas(schema, schema);
  assertEquals(changes, []);
});

Deno.test("diffSchemas: rename field → drop + add (no rename detection)", () => {
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ b: z.string() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 2);
  // add_column b comes first (nullable adds before drops)
  assertEquals(changes[0].type, "add_column");
  assertEquals(changes[0].columnName, "b");
  assertEquals(changes[1].type, "drop_column");
  assertEquals(changes[1].columnName, "a");
});

// ===========================================================================
// 4. createTable
// ===========================================================================

Deno.test("createTable: generates correct CREATE TABLE SQL", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({
    name: z.string(),
    age: z.number().int().min(0),
  });

  const fqName = await createTable(
    mockSql as any,
    "public",
    "users",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(fqName, '"public"."users"');

  // Verify CREATE TABLE SQL
  const createCall = mockSql.calls[0];
  assertEquals(createCall.query.includes("CREATE TABLE"), true);
  assertEquals(createCall.query.includes('"public"."users"'), true);
  assertEquals(createCall.query.includes("id UUID DEFAULT gen_random_uuid() PRIMARY KEY"), true);
  assertEquals(createCall.query.includes('"name" TEXT NOT NULL'), true);
  assertEquals(createCall.query.includes('"age" BIGINT NOT NULL'), true);
  assertEquals(createCall.query.includes('CONSTRAINT "ck_users_age_0" CHECK ("age" >= 0)'), true);

  // No indexes for name (doesn't end in _id/_key) or age (number, not enum/datetime)
  // Only the CREATE TABLE call
  assertEquals(mockSql.calls.length, 1);

  // Verify enableVersioning was called
  assertEquals(mockVA.calls.length, 1);
  assertEquals(mockVA.calls[0].schema, "public");
  assertEquals(mockVA.calls[0].tableName, "users");
});

Deno.test("createTable: PK detection — id: z.string().uuid()", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({
    id: z.string().uuid(),
    name: z.string(),
  });

  await createTable(
    mockSql as any,
    "public",
    "users",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  // Should have explicit PK, not auto-generated
  assertEquals(createCall.query.includes('"id" UUID PRIMARY KEY'), true);
  assertEquals(createCall.query.includes("gen_random_uuid()"), false);
  // No constraint for the id field
  assertEquals(createCall.query.includes("ck_users_id"), false);
});

Deno.test("createTable: auto-generated PK when no id field", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({ name: z.string() });

  await createTable(
    mockSql as any,
    "public",
    "items",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  assertEquals(createCall.query.includes("id UUID DEFAULT gen_random_uuid() PRIMARY KEY"), true);
});

Deno.test("createTable: NOT NULL for required fields", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({ name: z.string() });

  await createTable(
    mockSql as any,
    "public",
    "t",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  assertEquals(createCall.query.includes('"name" TEXT NOT NULL'), true);
});

Deno.test("createTable: nullable for optional fields", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({ name: z.string().optional() });

  await createTable(
    mockSql as any,
    "public",
    "t",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  // Optional field should NOT have NOT NULL
  assertEquals(createCall.query.includes('"name" TEXT NOT NULL'), false);
  assertEquals(createCall.query.includes('"name" TEXT'), true);
});

Deno.test("createTable: DEFAULT values", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({
    status: z.string().default("active"),
    count: z.number().default(0),
    flag: z.boolean().default(false),
  });

  await createTable(
    mockSql as any,
    "public",
    "t",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  assertEquals(createCall.query.includes("DEFAULT 'active'"), true);
  assertEquals(createCall.query.includes("DEFAULT 0"), true);
  assertEquals(createCall.query.includes("DEFAULT false"), true);
  // Fields with defaults should NOT have NOT NULL
  assertEquals(createCall.query.includes("NOT NULL"), false);
});

Deno.test("createTable: CHECK constraints are included", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({
    email: z.string().email(),
    score: z.number().min(0).max(100),
  });

  await createTable(
    mockSql as any,
    "public",
    "scores",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  assertEquals(createCall.query.includes("CHECK"), true);
  assertEquals(createCall.query.includes("ck_scores_email"), true);
  assertEquals(createCall.query.includes("ck_scores_score"), true);
});

Deno.test("createTable: auto-indexes on _id, _key, datetime, enum fields", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({
    user_id: z.string(),
    api_key: z.string(),
    status: z.enum(["active", "inactive"]),
    created_at: z.iso.datetime(),
    email: z.string().email(),
  });

  await createTable(
    mockSql as any,
    "public",
    "items",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  // CREATE TABLE + 5 indexes
  assertEquals(mockSql.calls.length, 6);

  const indexQueries = mockSql.calls.slice(1).map((c) => c.query);
  assertEquals(indexQueries.some((q) => q.includes("idx_items_user_id")), true);
  assertEquals(indexQueries.some((q) => q.includes("idx_items_api_key")), true);
  assertEquals(indexQueries.some((q) => q.includes("idx_items_status")), true);
  assertEquals(indexQueries.some((q) => q.includes("idx_items_created_at")), true);
  assertEquals(indexQueries.some((q) => q.includes("idx_items_email")), true);
});

Deno.test("createTable: calls enableVersioning on the adapter", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({ name: z.string() });

  await createTable(
    mockSql as any,
    "myschema",
    "mytable",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(mockVA.calls.length, 1);
  assertEquals(mockVA.calls[0].schema, "myschema");
  assertEquals(mockVA.calls[0].tableName, "mytable");
});

// ===========================================================================
// 5. migrateSchema
// ===========================================================================

Deno.test("migrateSchema: add nullable column", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.string(), b: z.string().optional() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  // dropVersioning, ADD COLUMN (main), ADD COLUMN (history), enableVersioning
  assertEquals(mockSql.calls.length, 2);
  assertEquals(mockSql.calls[0].query.includes("ALTER TABLE"), true);
  assertEquals(mockSql.calls[0].query.includes("ADD COLUMN"), true);
  assertEquals(mockSql.calls[0].query.includes('"b"'), true);
  assertEquals(mockSql.calls[1].query.includes("_history"), true);
  assertEquals(mockSql.calls[1].query.includes("ADD COLUMN"), true);
  assertEquals(mockVA.calls.length, 2);
  assertEquals(mockVA.calls[0].method, "dropVersioning");
  assertEquals(mockVA.calls[1].method, "enableVersioning");
});

Deno.test("migrateSchema: add required column with default — ADD → backfill → SET NOT NULL", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  // Queue a result for the UPDATE backfill
  mockSql.queueResult({ count: 0 });

  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({
    a: z.string(),
    email: z.string().email().default("default@example.com"),
  });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  // ADD COLUMN (main), ADD COLUMN (history), UPDATE backfill, SET NOT NULL
  assertEquals(mockSql.calls.length, 4);
  assertEquals(mockSql.calls[0].query.includes("ADD COLUMN"), true);
  assertEquals(mockSql.calls[1].query.includes("_history"), true);
  assertEquals(mockSql.calls[1].query.includes("ADD COLUMN"), true);
  assertEquals(mockSql.calls[2].query.includes("UPDATE"), true);
  assertEquals(mockSql.calls[2].query.includes("default@example.com"), true);
  assertEquals(mockSql.calls[3].query.includes("SET NOT NULL"), true);
});

Deno.test("migrateSchema: drop column", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const oldSchema = z.object({ a: z.string(), b: z.string() });
  const newSchema = z.object({ a: z.string() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  assertEquals(mockSql.calls.length, 2);
  assertEquals(mockSql.calls[0].query.includes("DROP COLUMN"), true);
  assertEquals(mockSql.calls[0].query.includes('"b"'), true);
  assertEquals(mockSql.calls[1].query.includes("_history"), true);
  assertEquals(mockSql.calls[1].query.includes("DROP COLUMN"), true);
});

Deno.test("migrateSchema: change type with USING clause", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.number() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  assertEquals(mockSql.calls.length, 2);
  const q = mockSql.calls[0].query;
  assertEquals(q.includes("ALTER COLUMN"), true);
  assertEquals(q.includes("TYPE"), true);
  assertEquals(q.includes("USING"), true);
  assertEquals(q.includes("DOUBLE PRECISION"), true);
  assertEquals(mockSql.calls[1].query.includes("_history"), true);
  assertEquals(mockSql.calls[1].query.includes("ALTER COLUMN"), true);
});

Deno.test("migrateSchema: add constraint (email also changes type)", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.string().email() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  // change_type (main), change_type (history), add_constraint = 3 calls
  assertEquals(mockSql.calls.length, 3);
  assertEquals(mockSql.calls[0].query.includes("ALTER COLUMN"), true);
  assertEquals(mockSql.calls[0].query.includes("TYPE"), true);
  assertEquals(mockSql.calls[1].query.includes("_history"), true);
  assertEquals(mockSql.calls[1].query.includes("ALTER COLUMN"), true);
  assertEquals(mockSql.calls[2].query.includes("ADD CONSTRAINT"), true);
  assertEquals(mockSql.calls[2].query.includes("CHECK"), true);
});

Deno.test("migrateSchema: drop constraint (email also changes type back)", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const oldSchema = z.object({ a: z.string().email() });
  const newSchema = z.object({ a: z.string() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  // change_type (main), change_type (history), drop_constraint = 3 calls
  assertEquals(mockSql.calls.length, 3);
  assertEquals(mockSql.calls[0].query.includes("ALTER COLUMN"), true);
  assertEquals(mockSql.calls[0].query.includes("TYPE"), true);
  assertEquals(mockSql.calls[1].query.includes("_history"), true);
  assertEquals(mockSql.calls[1].query.includes("ALTER COLUMN"), true);
  assertEquals(mockSql.calls[2].query.includes("DROP CONSTRAINT"), true);
});

Deno.test("migrateSchema: change optionality — SET NOT NULL", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const oldSchema = z.object({ a: z.string().optional() });
  const newSchema = z.object({ a: z.string() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  assertEquals(mockSql.calls.length, 1);
  assertEquals(mockSql.calls[0].query.includes("SET NOT NULL"), true);
});

Deno.test("migrateSchema: change optionality — DROP NOT NULL", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({ a: z.string().optional() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  assertEquals(mockSql.calls.length, 1);
  assertEquals(mockSql.calls[0].query.includes("DROP NOT NULL"), true);
});

Deno.test("migrateSchema: batch backfill — multiple batches", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  // Queue results: ADD COLUMN main, ADD COLUMN history, UPDATE batch 1, UPDATE batch 2
  mockSql.queueResult([]); // ADD COLUMN main returns []
  mockSql.queueResult([]); // ADD COLUMN history returns []
  mockSql.queueResult({ count: 2 }); // UPDATE batch 1: full batch
  mockSql.queueResult({ count: 1 }); // UPDATE batch 2: partial → loop exits

  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({
    a: z.string(),
    status: z.string().default("pending"),
  });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
    { batchSize: 2 },
  );

  // ADD COLUMN (main), ADD COLUMN (history), UPDATE (batch 1), UPDATE (batch 2), SET NOT NULL
  assertEquals(mockSql.calls.length, 5);
  assertEquals(rows, 3); // 2 + 1
});

Deno.test("migrateSchema: returns correct row count", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  // Queue results: ADD COLUMN main, ADD COLUMN history, UPDATE backfill
  mockSql.queueResult([]); // ADD COLUMN main returns []
  mockSql.queueResult([]); // ADD COLUMN history returns []
  mockSql.queueResult({ count: 5 }); // UPDATE returns 5 rows

  const oldSchema = z.object({ a: z.string() });
  const newSchema = z.object({
    a: z.string(),
    label: z.string().default("unknown"),
  });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    oldSchema,
    newSchema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 5);
});

Deno.test("migrateSchema: no changes — returns 0 without touching versioning", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({ a: z.string() });

  const rows = await migrateSchema(
    mockSql as any,
    "public",
    "test",
    schema,
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  assertEquals(rows, 0);
  assertEquals(mockSql.calls.length, 0);
  assertEquals(mockVA.calls.length, 0);
});

// ===========================================================================
// 6. importTable
// ===========================================================================

Deno.test("importTable: schema discovery from information_schema", async () => {
  const mockSql = createMockSql();
  // Queue results:
  // 1. ensureImportsTable CREATE TABLE IF NOT EXISTS (dummy)
  mockSql.queueResult([]);
  // 2. information_schema.columns query
  mockSql.queueResult([
    { column_name: "id", data_type: "uuid", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "name", data_type: "text", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "count", data_type: "integer", character_maximum_length: null, is_nullable: "YES" },
  ]);
  // 3. INSERT INTO _imports
  mockSql.queueResult([]);

  const result = await importTable(mockSql as any, {
    sourceSchema: "public",
    sourceTable: "existing_table",
    swampSchema: "swamp",
    modelType: "MyModel",
    mode: "readonly",
    discoverSchema: true,
  });

  assertEquals(result.modelType, "MyModel");
  assertEquals(result.mode, "readonly");
  assertEquals(result.discoveredSchema !== undefined, true);

  // Verify information_schema query was called with correct params
  const infoCall = mockSql.calls[1];
  assertEquals(infoCall.query.includes("information_schema.columns"), true);
  assertEquals(infoCall.params, ["public", "existing_table"]);

  // Verify _imports INSERT
  const insertCall = mockSql.calls[2];
  assertEquals(insertCall.query.includes("_imports"), true);
  assertEquals(insertCall.query.includes("ON CONFLICT"), true);
});

Deno.test("importTable: pgTypeToZod mappings for common types", async () => {
  const mockSql = createMockSql();
  mockSql.queueResult([]); // ensureImportsTable
  mockSql.queueResult([
    { column_name: "col_uuid", data_type: "uuid", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_bool", data_type: "boolean", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_int", data_type: "integer", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_bigint", data_type: "bigint", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_float", data_type: "double precision", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_numeric", data_type: "numeric", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_timestamptz", data_type: "timestamp with time zone", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_date", data_type: "date", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_jsonb", data_type: "jsonb", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_text", data_type: "text", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "col_varchar", data_type: "character varying", character_maximum_length: 100, is_nullable: "NO" },
    { column_name: "col_nullable", data_type: "text", character_maximum_length: null, is_nullable: "YES" },
  ]);
  mockSql.queueResult([]); // INSERT INTO _imports

  const result = await importTable(mockSql as any, {
    sourceSchema: "public",
    sourceTable: "typed_table",
    swampSchema: "swamp",
    modelType: "TypedModel",
    mode: "readonly",
    discoverSchema: true,
  });

  const shape = (result.discoveredSchema! as any).shape;
  // Verify type mappings via zodToSqlType on the discovered schema
  assertEquals(zodToSqlType(shape.col_uuid), "UUID");
  assertEquals(zodToSqlType(shape.col_bool), "BOOLEAN");
  assertEquals(zodToSqlType(shape.col_int), "BIGINT");
  assertEquals(zodToSqlType(shape.col_bigint), "BIGINT");
  assertEquals(zodToSqlType(shape.col_float), "DOUBLE PRECISION");
  assertEquals(zodToSqlType(shape.col_numeric), "NUMERIC");
  assertEquals(zodToSqlType(shape.col_timestamptz), "TIMESTAMPTZ");
  assertEquals(zodToSqlType(shape.col_date), "TEXT");
  assertEquals(zodToSqlType(shape.col_jsonb), "JSONB");
  assertEquals(zodToSqlType(shape.col_text), "TEXT");
  assertEquals(zodToSqlType(shape.col_varchar), "VARCHAR(100)");
  // Nullable column should be optional
  assertEquals(zodToSqlType(shape.col_nullable), "TEXT");
});

Deno.test("importTable: explicit schema validation warns on mismatches", async () => {
  const mockSql = createMockSql();
  mockSql.queueResult([]); // ensureImportsTable
  mockSql.queueResult([
    { column_name: "id", data_type: "uuid", character_maximum_length: null, is_nullable: "NO" },
    { column_name: "name", data_type: "text", character_maximum_length: null, is_nullable: "NO" },
  ]);
  mockSql.queueResult([]); // INSERT INTO _imports

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);

  try {
    const explicitSchema = z.object({
      id: z.string().uuid(),
      name: z.string(),
      extra_field: z.string(), // not in the actual table
    });

    await importTable(mockSql as any, {
      sourceSchema: "public",
      sourceTable: "partial_table",
      swampSchema: "swamp",
      modelType: "PartialModel",
      mode: "readwrite",
      explicitSchema,
    });

    assertEquals(warnings.length >= 1, true);
    assertEquals(warnings.some((w) => w.includes("extra_field")), true);
  } finally {
    console.warn = origWarn;
  }
});

Deno.test("importTable: registers in _imports table", async () => {
  const mockSql = createMockSql();
  mockSql.queueResult([]); // ensureImportsTable
  mockSql.queueResult([
    { column_name: "id", data_type: "uuid", character_maximum_length: null, is_nullable: "NO" },
  ]);
  mockSql.queueResult([]); // INSERT INTO _imports

  await importTable(mockSql as any, {
    sourceSchema: "public",
    sourceTable: "reg_table",
    swampSchema: "swamp",
    modelType: "RegModel",
    mode: "readwrite",
    discoverSchema: true,
  });

  // Check that _imports INSERT was called
  const insertCall = mockSql.calls.find((c) => c.query.includes("_imports") && c.query.includes("INSERT"));
  assertEquals(insertCall !== undefined, true);
  assertEquals(insertCall!.params![0], "RegModel");
  assertEquals(insertCall!.params![1], "public");
  assertEquals(insertCall!.params![2], "reg_table");
  assertEquals(insertCall!.params![3], "readwrite");
});

Deno.test("importTable: throws on non-existent table", async () => {
  const mockSql = createMockSql();
  mockSql.queueResult([]); // ensureImportsTable
  // information_schema query returns empty array
  mockSql.queueResult([]);

  let threw = false;
  try {
    await importTable(mockSql as any, {
      sourceSchema: "public",
      sourceTable: "nonexistent",
      swampSchema: "swamp",
      modelType: "GhostModel",
      mode: "readonly",
    });
  } catch (e: unknown) {
    threw = true;
    assertEquals((e as Error).message.includes("not found"), true);
  }
  assertEquals(threw, true);
});

Deno.test("importTable: readonly vs readwrite mode", async () => {
  const mockSql = createMockSql();
  mockSql.queueResult([]); // ensureImportsTable
  mockSql.queueResult([
    { column_name: "id", data_type: "uuid", character_maximum_length: null, is_nullable: "NO" },
  ]);
  mockSql.queueResult([]); // INSERT INTO _imports

  const result = await importTable(mockSql as any, {
    sourceSchema: "public",
    sourceTable: "mode_table",
    swampSchema: "swamp",
    modelType: "ModeModel",
    mode: "readwrite",
  });

  assertEquals(result.mode, "readwrite");
});

// ===========================================================================
// 7. Edge Cases
// ===========================================================================

Deno.test("edge case: special characters in column names", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  // Column name with a space — should be double-quoted
  const schema = z.object({ "weird column": z.string() } as any);

  await createTable(
    mockSql as any,
    "public",
    "edge",
    schema as any,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  assertEquals(createCall.query.includes('"weird column"'), true);
});

Deno.test("edge case: column name with embedded double-quote", () => {
  // escIdent should double embedded quotes in constraint expressions
  const result = zodToSqlConstraints(z.string().min(1), 'weird"name');
  assertEquals(result[0].includes('"weird""name"'), true);
});

Deno.test("edge case: empty schema — no fields", async () => {
  const mockSql = createMockSql();
  const mockVA = createMockVersioningAdapter();
  const schema = z.object({});

  await createTable(
    mockSql as any,
    "public",
    "empty",
    schema,
    mockVA as unknown as VersioningAdapter,
  );

  const createCall = mockSql.calls[0];
  // Should have only the auto-generated PK
  assertEquals(createCall.query.includes("id UUID DEFAULT gen_random_uuid() PRIMARY KEY"), true);
  // No other column definitions
  assertEquals(createCall.query.includes("NOT NULL"), false);
});

Deno.test("edge case: very long enum values", () => {
  // "very_long_enum_value_here" is 25 characters
  const result = zodToSqlType(z.enum(["a", "very_long_enum_value_here"]));
  assertEquals(result, "VARCHAR(25)");
});

Deno.test("edge case: deeply nested optional wrappers", () => {
  // z.string().optional().nullable().optional() should unwrap to string → TEXT
  const result = zodToSqlType(z.string().optional().nullable().optional() as any);
  assertEquals(result, "TEXT");
});

Deno.test("edge case: string literal with single quote", () => {
  // escLiteral should escape single quotes
  const result = zodToSqlConstraints(z.literal("it's"), "col");
  assertEquals(result, ["\"col\" = 'it''s'"]);
});

Deno.test("edge case: diffSchemas with no overlapping fields", () => {
  const oldSchema = z.object({ a: z.string(), b: z.string() });
  const newSchema = z.object({ c: z.number(), d: z.boolean() });
  const changes = diffSchemas(oldSchema, newSchema);

  assertEquals(changes.length, 4);
  // adds first, then drops
  assertEquals(changes[0].type, "add_column");
  assertEquals(changes[1].type, "add_column");
  assertEquals(changes[2].type, "drop_column");
  assertEquals(changes[3].type, "drop_column");
});

Deno.test("edge case: z.string().datetime() → TIMESTAMPTZ", () => {
  assertEquals(zodToSqlType(z.string().datetime()), "TIMESTAMPTZ");
});
