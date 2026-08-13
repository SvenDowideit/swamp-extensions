/**
 * Unit tests for the PostgreSQL datastore provider.
 *
 * Covers export conformance, config schema validation, path resolution,
 * provider shape, and edge cases. No real database connection is made.
 */
import { assertEquals, assertExists, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { assertDatastoreExportConformance } from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { datastore } from "./mod.ts";

// ===========================================================================
// 1. Export Conformance
// ===========================================================================

Deno.test("datastore export conforms", () => {
  assertDatastoreExportConformance(datastore, {
    validConfigs: [
      { connectionString: "postgres://localhost:5432/test", schema: "swamp" },
    ],
    invalidConfigs: [
      {},
      { connectionString: "" },
    ],
  });
});

// ===========================================================================
// 2. Config Schema Validation
// ===========================================================================

Deno.test("ConfigSchema: connectionString is required", () => {
  // Missing connectionString should fail validation
  assertThrows(() => datastore.configSchema.parse({}));
});

Deno.test("ConfigSchema: connectionString must be non-empty", () => {
  // Empty connectionString should fail min(1) check
  assertThrows(() => datastore.configSchema.parse({ connectionString: "" }));
});

Deno.test("ConfigSchema: schema defaults to 'swamp'", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
  });
  assertEquals(result.schema, "swamp");
});

Deno.test("ConfigSchema: schema accepts valid identifiers", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    schema: "my_schema",
  });
  assertEquals(result.schema, "my_schema");
});

Deno.test("ConfigSchema: schema rejects names starting with digit", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      schema: "1invalid",
    })
  );
});

Deno.test("ConfigSchema: schema rejects names with special characters", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      schema: "my-schema",
    })
  );
});

Deno.test("ConfigSchema: ssl defaults to 'require'", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
  });
  assertEquals(result.ssl, "require");
});

Deno.test("ConfigSchema: ssl accepts 'disable'", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "disable",
  });
  assertEquals(result.ssl, "disable");
});

Deno.test("ConfigSchema: ssl accepts 'require'", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "require",
  });
  assertEquals(result.ssl, "require");
});

Deno.test("ConfigSchema: ssl accepts 'verify-ca'", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "verify-ca",
  });
  assertEquals(result.ssl, "verify-ca");
});

Deno.test("ConfigSchema: ssl rejects invalid enum values", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      ssl: "verify-full",
    })
  );
});

Deno.test("ConfigSchema: sslCaPath is optional", () => {
  // sslCaPath is optional — omitting it should succeed
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "verify-ca",
  });
  assertEquals(result.sslCaPath, undefined);
});

Deno.test("ConfigSchema: sslCaPath accepts a string value", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "verify-ca",
    sslCaPath: "/path/to/ca.pem",
  });
  assertEquals(result.sslCaPath, "/path/to/ca.pem");
});

Deno.test("ConfigSchema: pool defaults are correct", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
  });
  assertEquals(result.pool.maxConnections, 10);
  assertEquals(result.pool.idleTimeoutMs, 30000);
  assertEquals(result.pool.connectTimeoutMs, 5000);
});

Deno.test("ConfigSchema: pool maxConnections accepts minimum (1)", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    pool: { maxConnections: 1 },
  });
  assertEquals(result.pool.maxConnections, 1);
});

Deno.test("ConfigSchema: pool maxConnections accepts maximum (100)", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    pool: { maxConnections: 100 },
  });
  assertEquals(result.pool.maxConnections, 100);
});

Deno.test("ConfigSchema: pool maxConnections rejects 0 (below min)", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      pool: { maxConnections: 0 },
    })
  );
});

Deno.test("ConfigSchema: pool maxConnections rejects 101 (above max)", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      pool: { maxConnections: 101 },
    })
  );
});

Deno.test("ConfigSchema: pool maxConnections rejects non-integer values", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      pool: { maxConnections: 5.5 },
    })
  );
});

Deno.test("ConfigSchema: pool idleTimeoutMs accepts 0", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    pool: { idleTimeoutMs: 0 },
  });
  assertEquals(result.pool.idleTimeoutMs, 0);
});

Deno.test("ConfigSchema: pool idleTimeoutMs rejects negative values", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      pool: { idleTimeoutMs: -1 },
    })
  );
});

Deno.test("ConfigSchema: pool connectTimeoutMs minimum is 1000", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    pool: { connectTimeoutMs: 1000 },
  });
  assertEquals(result.pool.connectTimeoutMs, 1000);
});

Deno.test("ConfigSchema: pool connectTimeoutMs rejects values below 1000", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      pool: { connectTimeoutMs: 999 },
    })
  );
});

Deno.test("ConfigSchema: pool connectTimeoutMs rejects 0", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      pool: { connectTimeoutMs: 0 },
    })
  );
});

Deno.test("ConfigSchema: pool connectTimeoutMs rejects negative values", () => {
  assertThrows(() =>
    datastore.configSchema.parse({
      connectionString: "postgres://localhost:5432/test",
      pool: { connectTimeoutMs: -5000 },
    })
  );
});

Deno.test("ConfigSchema: pool partial overrides preserve other defaults", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    pool: { maxConnections: 25 },
  });
  assertEquals(result.pool.maxConnections, 25);
  assertEquals(result.pool.idleTimeoutMs, 30000);
  assertEquals(result.pool.connectTimeoutMs, 5000);
});

Deno.test("ConfigSchema: full config with all fields parses correctly", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://user:pass@host:5432/mydb",
    schema: "custom_schema",
    ssl: "verify-ca",
    sslCaPath: "/etc/ssl/ca.pem",
    pool: {
      maxConnections: 50,
      idleTimeoutMs: 60000,
      connectTimeoutMs: 10000,
    },
  });
  assertEquals(result.connectionString, "postgres://user:pass@host:5432/mydb");
  assertEquals(result.schema, "custom_schema");
  assertEquals(result.ssl, "verify-ca");
  assertEquals(result.sslCaPath, "/etc/ssl/ca.pem");
  assertEquals(result.pool.maxConnections, 50);
  assertEquals(result.pool.idleTimeoutMs, 60000);
  assertEquals(result.pool.connectTimeoutMs, 10000);
});

// ===========================================================================
// 3. resolveDatastorePath
// ===========================================================================

Deno.test("resolveDatastorePath: valid connection string with port", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://host:5432/db",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://host:5432/db/swamp");
});

Deno.test("resolveDatastorePath: valid connection string without port defaults to 5432", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://host/db",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://host:5432/db/swamp");
});

Deno.test("resolveDatastorePath: uses custom schema in path", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://host:5432/db",
    schema: "custom",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://host:5432/db/custom");
});

Deno.test("resolveDatastorePath: connection string with credentials", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://user:pass@db.example.com:5432/mydb",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://db.example.com:5432/mydb/swamp");
});

Deno.test("resolveDatastorePath: connection string with query params strips them", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://host:5432/db?sslmode=require",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://host:5432/db/swamp");
});

Deno.test("resolveDatastorePath: connection string without db name uses 'postgres'", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://host:5432",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://host:5432/postgres/swamp");
});

Deno.test("resolveDatastorePath: connection string with trailing slash", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://host:5432/db/",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://host:5432/db/swamp");
});

Deno.test("resolveDatastorePath: invalid connection string falls back to schema-only path", () => {
  // An unparseable connection string triggers the catch block
  const provider = datastore.createProvider({
    connectionString: "not-a-valid-url!!!",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://swamp");
});

Deno.test("resolveDatastorePath: invalid connection string with custom schema in fallback", () => {
  const provider = datastore.createProvider({
    connectionString: "not-a-valid-url!!!",
    schema: "myapp",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://myapp");
});

// ===========================================================================
// 4. resolveCachePath
// ===========================================================================

Deno.test("resolveCachePath: returns undefined", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  const path = provider.resolveCachePath("/some/repo");
  assertEquals(path, undefined);
});

Deno.test("resolveCachePath: always returns undefined regardless of input", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  assertEquals(provider.resolveCachePath(""), undefined);
  assertEquals(provider.resolveCachePath("/any/path"), undefined);
});

// ===========================================================================
// 5. createProvider returns correct shape
// ===========================================================================

Deno.test("createProvider: returns an object with all expected methods", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });

  assertExists(provider.createLock);
  assertExists(provider.createVerifier);
  assertExists(provider.resolveDatastorePath);
  assertExists(provider.resolveCachePath);
  assertExists(provider.registerNamespace);
  assertExists(provider.listNamespaces);

  assertEquals(typeof provider.createLock, "function");
  assertEquals(typeof provider.createVerifier, "function");
  assertEquals(typeof provider.resolveDatastorePath, "function");
  assertEquals(typeof provider.resolveCachePath, "function");
  assertEquals(typeof provider.registerNamespace, "function");
  assertEquals(typeof provider.listNamespaces, "function");
});

Deno.test("createProvider: createLock returns an object with all expected methods", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  const lock = provider.createLock("pg://host:5432/db/swamp");

  assertExists(lock.acquire);
  assertExists(lock.release);
  assertExists(lock.withLock);
  assertExists(lock.inspect);
  assertExists(lock.forceRelease);

  assertEquals(typeof lock.acquire, "function");
  assertEquals(typeof lock.release, "function");
  assertEquals(typeof lock.withLock, "function");
  assertEquals(typeof lock.inspect, "function");
  assertEquals(typeof lock.forceRelease, "function");
});

Deno.test("createProvider: createLock with custom options", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  const lock = provider.createLock("pg://host:5432/db/swamp", {
    lockKey: "custom-key",
    ttlMs: 60000,
    retryIntervalMs: 500,
    maxWaitMs: 30000,
  });

  assertExists(lock.acquire);
  assertExists(lock.release);
  assertExists(lock.withLock);
  assertExists(lock.inspect);
  assertExists(lock.forceRelease);
});

Deno.test("createProvider: createVerifier returns an object with verify method", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  const verifier = provider.createVerifier();

  assertExists(verifier.verify);
  assertEquals(typeof verifier.verify, "function");
});

Deno.test("createProvider: registerNamespace is a function", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  assertEquals(typeof provider.registerNamespace, "function");
});

Deno.test("createProvider: listNamespaces is a function", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  assertEquals(typeof provider.listNamespaces, "function");
});

// ===========================================================================
// 6. Edge Cases
// ===========================================================================

Deno.test("edge case: connection string with special characters in password", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://user:p%40ss%3Aw0rd@host:5432/db",
  });
  assertEquals(result.connectionString, "postgres://user:p%40ss%3Aw0rd@host:5432/db");
});

Deno.test("edge case: connection string with IPv6 address", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://[::1]:5432/db",
  });
  assertEquals(result.connectionString, "postgres://[::1]:5432/db");
});

Deno.test("edge case: resolveDatastorePath with IPv6 connection string", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://[::1]:5432/db",
  });
  const path = provider.resolveDatastorePath("/some/repo");
  assertEquals(path, "pg://[::1]:5432/db/swamp");
});

Deno.test("edge case: very long schema name at regex boundary", () => {
  // 63 characters — valid PostgreSQL identifier length
  const longSchema = "a" + "b".repeat(62);
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    schema: longSchema,
  });
  assertEquals(result.schema, longSchema);
});

Deno.test("edge case: ssl=verify-ca without sslCaPath is accepted by schema", () => {
  // sslCaPath is optional — the schema does not enforce cross-field
  // validation requiring sslCaPath when ssl=verify-ca. The buildSslConfig
  // function will produce { ca: undefined } in that case.
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "verify-ca",
  });
  assertEquals(result.ssl, "verify-ca");
  assertEquals(result.sslCaPath, undefined);
});

Deno.test("edge case: ssl=verify-ca with sslCaPath is accepted", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "verify-ca",
    sslCaPath: "/path/to/ca-bundle.pem",
  });
  assertEquals(result.ssl, "verify-ca");
  assertEquals(result.sslCaPath, "/path/to/ca-bundle.pem");
});

Deno.test("edge case: ssl=disable with sslCaPath is accepted", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    ssl: "disable",
    sslCaPath: "/path/to/ca-bundle.pem",
  });
  assertEquals(result.ssl, "disable");
  assertEquals(result.sslCaPath, "/path/to/ca-bundle.pem");
});

Deno.test("edge case: pool with all values at their minimums", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    pool: {
      maxConnections: 1,
      idleTimeoutMs: 0,
      connectTimeoutMs: 1000,
    },
  });
  assertEquals(result.pool.maxConnections, 1);
  assertEquals(result.pool.idleTimeoutMs, 0);
  assertEquals(result.pool.connectTimeoutMs, 1000);
});

Deno.test("edge case: pool with all values at their maximums", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    pool: {
      maxConnections: 100,
      idleTimeoutMs: Number.MAX_SAFE_INTEGER,
      connectTimeoutMs: Number.MAX_SAFE_INTEGER,
    },
  });
  assertEquals(result.pool.maxConnections, 100);
});

Deno.test("edge case: extra unknown properties are stripped by zod", () => {
  const result = datastore.configSchema.parse({
    connectionString: "postgres://localhost:5432/test",
    unknownField: "should be stripped",
  });
  assertEquals((result as Record<string, unknown>).unknownField, undefined);
});

Deno.test("edge case: resolveDatastorePath with connection string containing path segments", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://host:5432/db",
  });
  const path = provider.resolveDatastorePath("/some/repo/dir");
  assertEquals(path, "pg://host:5432/db/swamp");
});

Deno.test("edge case: createProvider with minimal valid config", () => {
  const provider = datastore.createProvider({
    connectionString: "postgres://localhost:5432/test",
  });
  assertExists(provider);
  assertExists(provider.createLock);
  assertExists(provider.createVerifier);
});

Deno.test("edge case: createProvider throws on invalid config", () => {
  assertThrows(() => datastore.createProvider({}));
  assertThrows(() => datastore.createProvider({ connectionString: "" }));
});

Deno.test("edge case: datastore export has correct metadata", () => {
  assertEquals(datastore.type, "@svendowideit/postgres-datastore");
  assertEquals(datastore.name, "PostgreSQL Datastore");
  assertEquals(typeof datastore.description, "string");
  assertEquals(datastore.description.length > 0, true);
  assertExists(datastore.configSchema);
  assertExists(datastore.createProvider);
  assertEquals(typeof datastore.createProvider, "function");
});
