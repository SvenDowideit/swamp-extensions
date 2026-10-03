import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  baseUrl,
  contentHashHex,
  contentTypeFor,
  deriveVersion,
  expandHome,
  model,
  sha256HexAsync,
  validateConfig,
} from "./settings_server.ts";

Deno.test("expandHome resolves ~ against HOME", () => {
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});

Deno.test("baseUrl derives https unless overridden", () => {
  assertEquals(baseUrl("settings.otel.fi.gy"), "https://settings.otel.fi.gy");
  assertEquals(baseUrl("x", "http://localhost:8080"), "http://localhost:8080");
});

Deno.test("contentTypeFor maps known document extensions", () => {
  assertEquals(contentTypeFor("otel.json"), "application/json");
  assertEquals(
    contentTypeFor("agent-config/T1.yaml"),
    "application/yaml; charset=utf-8",
  );
  assertEquals(contentTypeFor("otel.md"), "text/markdown; charset=utf-8");
  assertEquals(contentTypeFor("otel.env"), "text/plain; charset=utf-8");
  assertEquals(contentTypeFor("file.bin"), "application/octet-stream");
});

Deno.test("deriveVersion prefers version.json, else a content hash", () => {
  const withJson = deriveVersion('{"version":"abc123"}', []);
  assertEquals(withJson, "abc123");
  const computed = deriveVersion(null, [
    { path: "otel.json", bytes: 10 },
    { path: "otel.env", bytes: 5 },
  ]);
  assertEquals(computed, contentHashHex("otel.env:5\notel.json:10"));
  // Invalid JSON falls back rather than throwing.
  assert(deriveVersion("not json", [{ path: "a", bytes: 1 }]).length > 0);
});

Deno.test("validateConfig flags missing and conflicting fields", () => {
  assertEquals(
    validateConfig({
      sourceDir: "/a",
      webroot: "/b",
      hostname: "settings.example.com",
    }),
    [],
  );
  const bad = validateConfig({
    sourceDir: "",
    webroot: "",
    hostname: "http://x/y",
  });
  assert(bad.length >= 3);
  const same = validateConfig({
    sourceDir: "/a",
    webroot: "/a",
    hostname: "h.example.com",
  });
  assert(same.some((e) => e.includes("must differ")));
});

Deno.test("valid-config check fails for a bad config", () => {
  const result = model.checks["valid-config"].execute({
    globalArgs: {
      sourceDir: "/a",
      webroot: "/a",
      hostname: "bad/name",
      indexDocument: "otel.json",
      publishBaseUrl: "",
    },
  });
  assertEquals(result.pass, false);
});

Deno.test("publish stages documents, writes v/<version>, and flips current", async () => {
  const src = await Deno.makeTempDir();
  const web = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${src}/agent-config`, { recursive: true });
    await Deno.writeTextFile(
      `${src}/otel.json`,
      '{"schema":"otel.settings/v1"}\n',
    );
    await Deno.writeTextFile(`${src}/agent-config/T1.yaml`, "tier: T1\n");
    await Deno.writeTextFile(
      `${src}/version.json`,
      JSON.stringify({ version: "vtest", documents: ["otel.json"] }),
    );

    let captured: Record<string, unknown> = {};
    const ctx = {
      globalArgs: {
        sourceDir: src,
        webroot: web,
        hostname: "settings.otel.fi.gy",
        indexDocument: "otel.json",
        publishBaseUrl: "",
      },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        captured = data;
        return Promise.resolve({ name: "publish" });
      },
    };
    await model.methods.publish.execute({}, ctx);
    assertEquals(captured.version, "vtest");
    const docs = captured.documents as Array<{ path: string }>;
    assert(docs.some((d) => d.path === "otel.json"));
    assert(docs.some((d) => d.path === "agent-config/T1.yaml"));

    const currentJson = await Deno.readTextFile(`${web}/current/otel.json`);
    assert(currentJson.includes("otel.settings/v1"));
    const nested = await Deno.readTextFile(
      `${web}/current/agent-config/T1.yaml`,
    );
    assertEquals(nested, "tier: T1\n");
    const versioned = await Deno.readTextFile(`${web}/v/vtest/otel.json`);
    assert(versioned.includes("otel.settings/v1"));

    // Re-publish is idempotent (flips the pointer without error).
    await model.methods.publish.execute({}, ctx);
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(web, { recursive: true });
  }
});

Deno.test("serve reports the caddy wiring for the current webroot", async () => {
  let captured: Record<string, unknown> = {};
  const ctx = {
    globalArgs: {
      sourceDir: "/src",
      webroot: "/var/settings",
      hostname: "settings.otel.fi.gy",
      indexDocument: "otel.json",
      publishBaseUrl: "",
    },
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data;
      return Promise.resolve({ name: "serve" });
    },
  };
  await model.methods.serve.execute({}, ctx);
  assertEquals(captured.hostname, "settings.otel.fi.gy");
  assertEquals(captured.currentDir, "/var/settings/current");
  assert(String(captured.method).includes("serveSettings"));
});

Deno.test("verify reports failure for an unreachable URL", async () => {
  let captured: Record<string, unknown> = {};
  const ctx = {
    globalArgs: {
      sourceDir: "/src",
      webroot: "/var/settings",
      hostname: "127.0.0.1:1",
      indexDocument: "otel.json",
      publishBaseUrl: "http://127.0.0.1:1",
    },
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data;
      return Promise.resolve({ name: "verify" });
    },
  };
  await model.methods.verify.execute({ timeoutMs: 500 }, ctx);
  assertEquals(captured.ok, false);
});

Deno.test("sha256HexAsync is deterministic and 64 hex chars", async () => {
  const a = await sha256HexAsync("hello");
  assertEquals(a.length, 64);
  assertEquals(a, await sha256HexAsync("hello"));
  assert(a !== await sha256HexAsync("world"));
});
