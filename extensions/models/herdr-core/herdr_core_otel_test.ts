/**
 * Tests for the agent-IDE OTLP layer.
 *
 * All pure: endpoint selection, traceparent parsing, and the OTLP payload
 * shape. No collector, network or environment access is required.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildEventLine,
  buildSpanPayload,
  normalizeTracesUrl,
  type OtelConfig,
  OtelConfigSchema,
  type OtelResolution,
  parseResourceAttributes,
  parseTraceparent,
  resolveOtel,
  withOtelSpan,
} from "./herdr_core_otel.ts";

const CONFIG: OtelConfig = OtelConfigSchema.parse({});

const RESOLUTION: OtelResolution = {
  enabled: true,
  endpoint: "https://otlp.example/v1/traces",
  mesh: "tailscale",
  token: "secret",
  tokenPresent: true,
  attributes: { site: "home", "deployment.environment": "dev" },
  reason: "test",
  source: "settings",
};

Deno.test("normalizeTracesUrl accepts base, host:port and traces URLs", () => {
  assertEquals(
    normalizeTracesUrl("https://otlp.example"),
    "https://otlp.example/v1/traces",
  );
  assertEquals(
    normalizeTracesUrl("https://otlp.example/"),
    "https://otlp.example/v1/traces",
  );
  assertEquals(
    normalizeTracesUrl("otlp.example:4318"),
    "http://otlp.example:4318/v1/traces",
  );
  assertEquals(
    normalizeTracesUrl("https://otlp.example/v1/traces"),
    "https://otlp.example/v1/traces",
  );
  assertEquals(
    normalizeTracesUrl("https://otlp.example/v1/logs"),
    "https://otlp.example/v1/traces",
  );
  assertEquals(normalizeTracesUrl("  "), "");
});

Deno.test("parseTraceparent accepts a valid header and rejects zero ids", () => {
  const parsed = parseTraceparent(
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  );
  assertEquals(parsed?.traceId, "0123456789abcdef0123456789abcdef");
  assertEquals(parsed?.spanId, "0123456789abcdef");
  assertEquals(parsed?.sampled, true);
  assertEquals(
    parseTraceparent("00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-01"),
    null,
  );
  assertEquals(parseTraceparent("nonsense"), null);
});

Deno.test("parseResourceAttributes parses comma-separated key=value", () => {
  assertEquals(
    parseResourceAttributes("site=home,owner=sven,empty="),
    { site: "home", owner: "sven", empty: "" },
  );
  assertEquals(parseResourceAttributes("bad,also-bad"), {});
});

Deno.test("resolveOtel uses the newest otel-settings resolved record", async () => {
  const ctx = {
    readModelData: (_model: string, spec: string) => {
      if (spec !== "resolved") return Promise.resolve([]);
      return Promise.resolve([{
        version: 2,
        content: {
          endpoints: [
            { mesh: "wireguard", otlp_http_url: "https://wg.example" },
            { mesh: "tailscale", otlp_http_url: "https://otlp.example" },
          ],
          defaultMesh: "tailscale",
          attributes: { site: "home" },
          deploymentEnvironment: "dev",
          authMethod: "bearer",
        },
      }]);
    },
    vaultService: {
      get: () => Promise.resolve("vault-token"),
    },
  };
  const config = OtelConfigSchema.parse({
    otelVaultName: "otel-vault",
    otelMesh: "tailscale",
  });
  const result = await resolveOtel(ctx, config);
  assertEquals(result.enabled, true);
  assertEquals(result.endpoint, "https://otlp.example/v1/traces");
  assertEquals(result.mesh, "tailscale");
  assertEquals(result.token, "vault-token");
  assertEquals(result.tokenPresent, true);
  assertEquals(result.source, "settings");
  assertEquals(result.attributes.site, "home");
  assertEquals(result.attributes["deployment.environment"], "dev");
});

Deno.test("resolveOtel prefers an explicit endpoint override", async () => {
  const ctx = {
    readModelData: () => Promise.resolve([]),
  };
  const config = OtelConfigSchema.parse({
    otelEndpoint: "http://127.0.0.1:4318",
  });
  const result = await resolveOtel(ctx, config);
  assertEquals(result.enabled, true);
  assertEquals(result.endpoint, "http://127.0.0.1:4318/v1/traces");
  assertEquals(result.source, "override");
});

Deno.test("resolveOtel is a no-op when disabled", async () => {
  const result = await resolveOtel(
    {},
    OtelConfigSchema.parse({
      otelEnabled: false,
    }),
  );
  assertEquals(result.enabled, false);
  assertEquals(result.reason, "otelEnabled=false");
  assertEquals(result.endpoint, "");
});

Deno.test("buildSpanPayload carries route, outcome and parent span", () => {
  const payload = buildSpanPayload(
    CONFIG,
    RESOLUTION,
    {
      name: "herdr-core.file-edit",
      target: "src/x.ts",
      machine: "xeon",
      route: "herdr-core",
      extensionVersion: "2026.11.23.1",
      attributes: { "swamp.target_count": 1 },
    },
    {
      success: false,
      startTimeMs: 1000,
      endTimeMs: 1012,
      error: "old text not found",
    },
    {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      parentSpanId: "fedcba9876543210",
    },
    "herdr-core",
  );
  const spans = (payload.resourceSpans as Array<Record<string, unknown>>)[0]
    .scopeSpans as Array<Record<string, unknown>>;
  const span = (spans[0].spans as Array<Record<string, unknown>>)[0];
  assertEquals(span.traceId, "0123456789abcdef0123456789abcdef");
  assertEquals(span.parentSpanId, "fedcba9876543210");
  assertEquals(span.name, "herdr-core.file-edit");
  assertEquals((span.status as Record<string, unknown>).code, 2);
  const attrs = Object.fromEntries(
    (span.attributes as Array<Record<string, unknown>>).map((a) => [
      a.key,
      (a.value as Record<string, unknown>).stringValue ??
        (a.value as Record<string, unknown>).boolValue ??
        (a.value as Record<string, unknown>).intValue,
    ]),
  );
  assertEquals(attrs["swamp.route"], "herdr-core");
  assertEquals(attrs["swamp.outcome"], "error");
  assertEquals(attrs["swamp.success"], false);
  assertEquals(attrs["swamp.target"], "src/x.ts");
  assertEquals(attrs["swamp.machine"], "xeon");
  assertEquals(attrs["swamp.error"], "old text not found");
  const resource = (payload.resourceSpans as Array<Record<string, unknown>>)[0]
    .resource as Record<string, unknown>;
  const resourceAttrs = Object.fromEntries(
    (resource.attributes as Array<Record<string, unknown>>).map((a) => [
      a.key,
      (a.value as Record<string, unknown>).stringValue,
    ]),
  );
  assertEquals(resourceAttrs["service.name"], "swamp-herdr-core");
  assertEquals(resourceAttrs["service.instance.id"], "herdr-core");
  assertEquals(resourceAttrs.site, "home");
});

Deno.test("withOtelSpan runs the method when OTEL is disabled", async () => {
  let ran = false;
  const value = await withOtelSpan(
    {},
    OtelConfigSchema.parse({ otelEnabled: false }),
    {
      name: "herdr-core.test",
      extensionVersion: "2026.11.23.1",
      route: "herdr-core",
    },
    () => {
      ran = true;
      return Promise.resolve(42);
    },
  );
  assertEquals(ran, true);
  assertEquals(value, 42);
});

Deno.test("withOtelSpan rethrows method errors", async () => {
  let message = "";
  try {
    await withOtelSpan(
      {},
      OtelConfigSchema.parse({ otelEnabled: false }),
      {
        name: "herdr-core.test",
        extensionVersion: "2026.11.23.1",
        route: "herdr-core",
      },
      () => Promise.reject(new Error("boom")),
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message === "boom");
});

Deno.test("buildEventLine records the route and outcome", () => {
  const line = buildEventLine(
    {
      name: "herdr-core.test",
      route: "herdr-core",
      extensionVersion: "2026.11.23.2",
      attributes: { "swamp.test": true },
    },
    { success: true, startTimeMs: 100, endTimeMs: 112 },
    "herdr-core",
  );
  const event = JSON.parse(line.trim());
  assertEquals(event.source, "herdr-core");
  assertEquals(event.route, "herdr-core");
  assertEquals(event.outcome, "success");
  assertEquals(event.durationMs, 12);
  assertEquals(event.model, "herdr-core");
});
