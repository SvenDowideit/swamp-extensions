import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  assertModeSupported,
  buildBootstrapSql,
  connectionFor,
  containerNameFor,
  dataMountFor,
  expandHome,
  generatePassword,
  quoteIdent,
  quoteLiteral,
  resolveImage,
  serviceModelName,
} from "./postgres.ts";

Deno.test("resolveImage prefers an explicit image over the version", () => {
  assertEquals(
    resolveImage({ image: "", version: "18-alpine" }),
    "postgres:18-alpine",
  );
  assertEquals(
    resolveImage({ image: "registry.local/pg:16", version: "18-alpine" }),
    "registry.local/pg:16",
  );
});

Deno.test("containerNameFor derives a safe name from the model name", () => {
  assertEquals(containerNameFor("postgres", ""), "postgres");
  assertEquals(containerNameFor("my pg", ""), "my-pg");
  assertEquals(containerNameFor("postgres", "custom"), "custom");
});

Deno.test("serviceModelName appends -svc", () => {
  assertEquals(serviceModelName("postgres", ""), "postgres-svc");
  assertEquals(serviceModelName("postgres", "custom"), "custom-svc");
});

Deno.test("expandHome expands a leading tilde", () => {
  const home = Deno.env.get("HOME") ?? "";
  if (home) assertEquals(expandHome("~/data"), `${home}/data`);
  assertEquals(expandHome("/abs"), "/abs");
});

Deno.test("generatePassword is URL-safe and non-trivial", () => {
  const p = generatePassword();
  assertEquals(/^[A-Za-z0-9_-]+$/.test(p), true);
  assertEquals(p.length >= 16, true);
  assertEquals(generatePassword() === generatePassword(), false);
});

Deno.test("quoteIdent and quoteLiteral escape their delimiters", () => {
  assertEquals(quoteIdent("app"), '"app"');
  assertEquals(quoteIdent('we"ird'), '"we""ird"');
  assertEquals(quoteLiteral("p'w"), "'p''w'");
});

Deno.test("buildBootstrapSql creates the role, sets the password, and is idempotent", () => {
  const sql = buildBootstrapSql("app", "s3cret", "appdb");
  assertStringIncludes(sql, "ON_ERROR_STOP on");
  assertStringIncludes(sql, "NOT EXISTS (SELECT FROM pg_roles");
  assertStringIncludes(sql, 'CREATE ROLE "app" LOGIN');
  assertStringIncludes(sql, `ALTER ROLE "app" WITH LOGIN PASSWORD 's3cret'`);
  assertStringIncludes(sql, "NOT EXISTS (SELECT FROM pg_database");
  assertStringIncludes(sql, "OWNER");
});

Deno.test("buildBootstrapSql never leaves the password in an identifier position", () => {
  const sql = buildBootstrapSql("app", "p'--injection", "appdb");
  assertStringIncludes(sql, "'p''--injection'");
});

Deno.test("connectionFor omits the password and shapes the jdbc URL", () => {
  const c = connectionFor({
    host: "postgres",
    port: 5432,
    database: "dtrack",
    username: "dtrack",
    mode: "container",
    network: "swamp-postgres",
    containerName: "postgres",
    sslmode: "disable",
  });
  assertEquals(
    c.jdbcUrl,
    "jdbc:postgresql://postgres:5432/dtrack?sslmode=disable",
  );
  assertEquals(
    Object.keys(c).some((k) => k.toLowerCase().includes("password")),
    false,
  );
});

Deno.test("dataMountFor uses /var/lib/postgresql for 18+, the data subdir before", () => {
  assertEquals(dataMountFor("postgres:18-alpine"), "/var/lib/postgresql");
  assertEquals(dataMountFor("postgres:18.1"), "/var/lib/postgresql");
  assertEquals(dataMountFor("postgres:17-alpine"), "/var/lib/postgresql/data");
  assertEquals(dataMountFor("postgres:16"), "/var/lib/postgresql/data");
  assertEquals(dataMountFor("postgres:latest"), "/var/lib/postgresql");
});

Deno.test("assertModeSupported rejects native with guidance", () => {
  assertModeSupported("container");
  assertModeSupported("auto");
  const err = assertThrows(() => assertModeSupported("native")) as Error;
  assertStringIncludes(err.message, "linux-package-installer");
});
