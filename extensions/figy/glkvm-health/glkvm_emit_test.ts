/**
 * Unit tests for the pure helpers of `@figy/glkvm-health`.
 *
 * Nothing here touches a device or the network: `pickEndpoint` is fed crafted
 * contracts, `normalizeHealth` is fed crafted health records, and the OTLP
 * builders are asserted structurally.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildOtlpLogs,
  buildOtlpMetrics,
  type ContractEndpoint,
  normalizeHealth,
  pickEndpoint,
  telemetryResource,
} from "./glkvm_emit.ts";

const sampleHealth = {
  host: "10.10.6.150",
  verdict: "warn",
  reachable: true,
  kvmdVersion: "1.2.3",
  checkedAt: "2026-10-17T00:00:00.000Z",
  findings: [
    {
      code: "firmware_update_available",
      severity: "warn",
      message: "update me",
    },
  ],
  updateAvailable: true,
  hidOnline: true,
  videoOnline: false,
  msd: { connected: true },
  twoFactorEnabled: false,
};

Deno.test("pickEndpoint prefers an explicit override", () => {
  const chosen = pickEndpoint([{
    mesh: "tailscale",
    otlp_http: "1.2.3.4:4318",
  }], {
    override: "http://127.0.0.1:4318/",
  });
  assertEquals(chosen, { base: "http://127.0.0.1:4318", mesh: "override" });
});

Deno.test("pickEndpoint follows the named mesh, then defaultMesh", () => {
  const endpoints: ContractEndpoint[] = [
    { mesh: "wireguard", otlp_http: "10.0.0.1:4318" },
    { mesh: "tailscale", otlp_http_url: "https://otlp.fi.gy" },
  ];
  assertEquals(
    pickEndpoint(endpoints, { mesh: "tailscale" }),
    { base: "https://otlp.fi.gy", mesh: "tailscale" },
  );
  assertEquals(
    pickEndpoint(endpoints, { defaultMesh: "wireguard" }),
    { base: "http://10.0.0.1:4318", mesh: "wireguard" },
  );
});

Deno.test("pickEndpoint with no endpoints yields an empty base", () => {
  assertEquals(pickEndpoint([]), { base: "", mesh: "" });
});

Deno.test("telemetryResource carries identity and drops empty attributes", () => {
  const res = telemetryResource("10.10.6.150", {
    site: "home",
    owner: "sven",
    empty: "",
  });
  const map = Object.fromEntries(
    res.map((a) => [a.key, a.value.stringValue]),
  );
  assertEquals(map["service.name"], "glkvm");
  assertEquals(map["device.type"], "glinet-kvm");
  assertEquals(map["device.host"], "10.10.6.150");
  assertEquals(map["site"], "home");
  assertEquals(map["owner"], "sven");
  assertEquals(map["empty"], undefined);
});

Deno.test("buildOtlpLogs maps the verdict to severity and body", () => {
  const payload = buildOtlpLogs(
    "10.10.6.150",
    normalizeHealth(sampleHealth, "10.10.6.150"),
    {},
    "2026-10-17T00:00:00.000Z",
  );
  const logs = (payload as {
    resourceLogs: Array<
      { scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }> }
    >;
  }).resourceLogs;
  const record = logs[0].scopeLogs[0].logRecords[0];
  assertEquals(record.severityText, "WARN");
  assertEquals(record.severityNumber, 13);
  assertEquals(
    (record.body as { stringValue: string }).stringValue,
    "GLKVM health warn: update me",
  );
});

Deno.test("buildOtlpMetrics includes the core gauges and conditional ones", () => {
  const payload = buildOtlpMetrics(
    "10.10.6.150",
    normalizeHealth(sampleHealth, "10.10.6.150"),
    {},
    "2026-10-17T00:00:00.000Z",
  );
  const metrics = (payload as {
    resourceMetrics: Array<
      { scopeMetrics: Array<{ metrics: Array<{ name: string }> }> }
    >;
  }).resourceMetrics[0].scopeMetrics[0].metrics;
  const names = metrics.map((m) => m.name);
  for (
    const expected of [
      "glkvm.up",
      "glkvm.health",
      "glkvm.virtual_media_mounted",
      "glkvm.update_available",
      "glkvm.hid_online",
      "glkvm.hdmi_signal",
      "glkvm.two_factor_enabled",
    ]
  ) {
    assertEquals(names.includes(expected), true, `missing ${expected}`);
  }
});

Deno.test("normalizeHealth coerces a raw record and defaults the host", () => {
  const health = normalizeHealth(
    {
      verdict: "fail",
      findings: [{
        severity: "fail",
        code: "unreachable",
        message: "no route",
      }],
    },
    "10.10.6.150",
  );
  assertEquals(health.host, "10.10.6.150");
  assertEquals(health.verdict, "fail");
  assertEquals(health.reachable, true);
  assertEquals(health.findings[0].code, "unreachable");
  assertEquals(health.findings[0].severity, "fail");
  assertEquals(health.msdConnected, false);
  assertEquals(health.updateAvailable, null);
});
