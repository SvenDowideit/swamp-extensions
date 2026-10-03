import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  buildTopology,
  model,
  OTEL_ENDPOINTS,
  OTEL_HOSTS,
  OTEL_RECORDS,
  OTEL_ZONE,
} from "./homelab_otel.ts";

Deno.test("the zone is the dedicated otel sub-zone", () => {
  assertEquals(OTEL_ZONE, "otel.fi.gy");
});

Deno.test("buildTopology derives hostnames from the zone", () => {
  const t = buildTopology("uat");
  assertEquals(t.zone, "otel.fi.gy");
  assertEquals(t.settingsHostname, "settings.otel.fi.gy");
  assertEquals(t.storeHostname, "obs.otel.fi.gy");
  assertEquals(t.certificate, "*.otel.fi.gy");
  assertEquals(t.deploymentEnvironment, "uat");
});

Deno.test("store hostname is obs.otel.fi.gy, not obs.fi.gy", () => {
  assert(buildTopology("dev").storeHostname.startsWith("obs.otel."));
});

Deno.test("records cover the expected names", () => {
  const names = OTEL_RECORDS.map((r) => r.name);
  for (
    const expected of [
      "otel.fi.gy",
      "otlp.fi.gy",
      "obs.otel.fi.gy",
      "settings.otel.fi.gy",
      "*.otel.fi.gy",
    ]
  ) {
    assert(names.includes(expected), `missing ${expected}`);
  }
});

Deno.test("endpoints cover tailscale and wireguard", () => {
  const meshes = OTEL_ENDPOINTS.map((e) => e.mesh);
  assertEquals(meshes, ["tailscale", "wireguard"]);
});

Deno.test("hosts include the UAT and prod core nodes", () => {
  const roles = OTEL_HOSTS.map((h) => h.role).join(" ");
  assert(roles.includes("UAT"));
  assert(roles.includes("prod"));
});

Deno.test("describe writes the topology resource", async () => {
  let captured: Record<string, unknown> = {};
  const ctx = {
    globalArgs: { deploymentEnvironment: "dev" as const },
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data;
      return Promise.resolve({ name: "topology" });
    },
  };
  await model.methods.describe.execute({}, ctx);
  assertEquals(captured.zone, "otel.fi.gy");
  assertEquals(captured.settingsHostname, "settings.otel.fi.gy");
  assert(Array.isArray(captured.records));
});
