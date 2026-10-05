import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";

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

Deno.test("describe writes a schema-conformant topology resource", async () => {
  const ctx = createModelTestContext({
    globalArgs: { deploymentEnvironment: "dev" },
    methodName: "describe",
  });
  await model.methods.describe.execute(
    {},
    ctx.context as unknown as Parameters<
      typeof model.methods.describe.execute
    >[1],
  );

  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "topology");
  assertEquals(written[0].name, "current");

  const parsed = model.resources.topology.schema.parse(written[0].data);
  assertEquals(parsed.zone, "otel.fi.gy");
  assertEquals(parsed.settingsHostname, "settings.otel.fi.gy");
  assertEquals(parsed.storeHostname, "obs.otel.fi.gy");
  assertEquals(parsed.deploymentEnvironment, "dev");
  assert(parsed.records.length > 0);
  assert(Array.isArray(parsed.endpoints));
});

Deno.test("describe logs entry and completion", async () => {
  const ctx = createModelTestContext({
    globalArgs: { deploymentEnvironment: "prod" },
    methodName: "describe",
  });
  await model.methods.describe.execute(
    {},
    ctx.context as unknown as Parameters<
      typeof model.methods.describe.execute
    >[1],
  );
  const infos = ctx.getLogsByLevel("info");
  assert(infos.length >= 2, "expected entry and completion info logs");
});

Deno.test("topology schema rejects malformed data (failure path)", () => {
  assertThrows(
    () => {
      model.resources.topology.schema.parse({
        zone: "otel.fi.gy",
        // settingsHostname intentionally missing
        records: "not-an-array",
      });
    },
    Error,
  );
});

Deno.test("the declared version matches the latest upgrade entry", () => {
  assertEquals(model.version, "2026.10.05.1");
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});
