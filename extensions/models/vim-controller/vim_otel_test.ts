/**
 * Tests for the Vim extension's OTLP layer.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildEventLine,
  buildSpanPayload,
  type OtelConfig,
  OtelConfigSchema,
  type OtelResolution,
  parseTraceparent,
  resolveOtel,
} from "./vim_otel.ts";

const CONFIG: OtelConfig = OtelConfigSchema.parse({});

const RESOLUTION: OtelResolution = {
  enabled: true,
  endpoint: "https://otlp.example/v1/traces",
  mesh: "tailscale",
  token: "",
  tokenPresent: false,
  attributes: { site: "home" },
  reason: "test",
  source: "settings",
};

Deno.test("Vim OTEL defaults to the swamp-vim service name", () => {
  assertEquals(CONFIG.otelServiceName, "swamp-vim");
  assertEquals(CONFIG.otelModel, "otel");
  assertEquals(CONFIG.otelEnabled, true);
});

Deno.test("Vim resolveOtel reads the otel-settings contract", async () => {
  const ctx = {
    readModelData: (_model: string, spec: string) =>
      Promise.resolve(
        spec === "resolved"
          ? [{
            version: 1,
            content: {
              endpoints: [{
                mesh: "tailscale",
                otlp_http_url: "https://otlp.example",
              }],
              defaultMesh: "tailscale",
              attributes: { site: "home" },
            },
          }]
          : [],
      ),
  };
  const result = await resolveOtel(ctx, CONFIG);
  assertEquals(result.enabled, true);
  assertEquals(result.endpoint, "https://otlp.example/v1/traces");
  assertEquals(result.source, "settings");
});

Deno.test("Vim span payload reports route=vim", () => {
  const payload = buildSpanPayload(
    CONFIG,
    RESOLUTION,
    {
      name: "vim.edit",
      target: "src/x.ts",
      route: "vim",
      extensionVersion: "2026.11.23.1",
    },
    {
      success: true,
      startTimeMs: 1000,
      endTimeMs: 1005,
    },
    {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
    },
    "vim",
  );
  const spans = (payload.resourceSpans as Array<Record<string, unknown>>)[0]
    .scopeSpans as Array<Record<string, unknown>>;
  const span = (spans[0].spans as Array<Record<string, unknown>>)[0];
  const attrs = Object.fromEntries(
    (span.attributes as Array<Record<string, unknown>>).map((a) => [
      a.key,
      (a.value as Record<string, unknown>).stringValue ??
        (a.value as Record<string, unknown>).boolValue,
    ]),
  );
  assertEquals(attrs["swamp.route"], "vim");
  assertEquals(attrs["swamp.outcome"], "success");
  assertEquals(attrs["swamp.method"], "vim.edit");
  assertEquals((span.status as Record<string, unknown>).code, 1);
});

Deno.test("Vim traceparent is accepted for parent/child traces", () => {
  const parsed = parseTraceparent(
    "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
  );
  assertEquals(parsed?.traceId, "0123456789abcdef0123456789abcdef");
  assertEquals(parsed?.spanId, "fedcba9876543210");
});

Deno.test("buildEventLine records the route and outcome", () => {
  const line = buildEventLine(
    {
      name: "vim.test",
      route: "vim",
      extensionVersion: "2026.11.23.2",
      attributes: { "swamp.test": true },
    },
    { success: true, startTimeMs: 100, endTimeMs: 112 },
    "vim",
  );
  const event = JSON.parse(line.trim());
  assertEquals(event.source, "vim");
  assertEquals(event.route, "vim");
  assertEquals(event.outcome, "success");
  assertEquals(event.durationMs, 12);
  assertEquals(event.model, "vim");
});
