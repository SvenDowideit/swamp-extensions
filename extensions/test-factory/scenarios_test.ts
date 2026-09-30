import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  distroByName,
  DISTROS,
  normalizeScenario,
  parseScenarioFile,
  resolveScenarios,
  scenarioSlug,
  splitList,
} from "./scenarios.ts";

Deno.test("splitList trims, splits on comma and whitespace", () => {
  assertEquals(splitList("ubuntu, fedora"), ["ubuntu", "fedora"]);
  assertEquals(splitList("ubuntu fedora,rocky"), ["ubuntu", "fedora", "rocky"]);
  assertEquals(splitList(""), []);
  assertEquals(splitList(undefined), []);
});

Deno.test("distroByName finds catalog entries", () => {
  assertEquals(distroByName("alpine")?.family, "apk");
  assertEquals(distroByName("rocky")?.systemd, true);
  assertEquals(distroByName("nope"), undefined);
});

Deno.test("default selection is the runnable standalone matrix", () => {
  const scenarios = resolveScenarios();
  assertEquals(scenarios.length > 0, true);
  for (const s of scenarios) {
    assertEquals(s.topology, "standalone");
    assertEquals(s.expected, "pass");
    assertEquals(distroByName(s.distro)?.runnable, true);
  }
  // Alpine (musl, un-runnable) must not be in the default set.
  assertEquals(scenarios.some((s) => s.distro === "alpine"), false);
});

Deno.test("named scenarios resolve exactly", () => {
  const scenarios = resolveScenarios({ scenario: "ubuntu-systemd-fleet-2" });
  assertEquals(scenarios.length, 1);
  assertEquals(scenarios[0].distro, "ubuntu");
  assertEquals(scenarios[0].systemd, true);
  assertEquals(scenarios[0].topology, "fleet");
  assertEquals(scenarios[0].workers, 2);
});

Deno.test("unknown scenario names raise a helpful error", () => {
  assertThrows(
    () => resolveScenarios({ scenario: "does-not-exist" }),
    Error,
    "Unknown scenario(s)",
  );
});

Deno.test("distro filter narrows the catalog", () => {
  const scenarios = resolveScenarios({
    distro: "ubuntu",
    topology: "standalone",
  });
  assertEquals(scenarios.every((s) => s.distro === "ubuntu"), true);
  assertEquals(scenarios.length >= 1, true);
});

Deno.test("systemd filter selects only systemd hosts", () => {
  const scenarios = resolveScenarios({ systemd: true, topology: "standalone" });
  assertEquals(scenarios.every((s) => s.systemd), true);
  assertEquals(scenarios.length >= 1, true);
});

Deno.test("workers override only applies to fleet scenarios", () => {
  const scenarios = resolveScenarios({
    scenario: "ubuntu-fleet-2,debian-standalone",
    workers: 3,
  });
  const fleet = scenarios.find((s) => s.topology === "fleet")!;
  const single = scenarios.find((s) => s.topology === "standalone")!;
  assertEquals(fleet.workers, 3);
  assertEquals(single.workers, 0);
});

Deno.test("systemd on a non-systemd distro is refused", () => {
  assertThrows(
    () =>
      resolveScenarios({
        distro: "alpine",
        systemd: true,
        topology: "standalone",
      }),
    Error,
    "Cannot request systemd",
  );
});

Deno.test("parseScenarioFile reads a YAML list", () => {
  const scenarios = parseScenarioFile(`
- distro: ubuntu
  topology: fleet
  workers: 4
  systemd: true
- distro: alpine
  expected: fail
`);
  assertEquals(scenarios.length, 2);
  assertEquals(scenarios[0].distro, "ubuntu");
  assertEquals(scenarios[0].topology, "fleet");
  assertEquals(scenarios[0].workers, 4);
  assertEquals(scenarios[0].systemd, true);
  assertEquals(scenarios[1].expected, "fail");
});

Deno.test("parseScenarioFile reads a JSON array", () => {
  const scenarios = parseScenarioFile(
    JSON.stringify([{ distro: "fedora", topology: "serve" }]),
  );
  assertEquals(scenarios.length, 1);
  assertEquals(scenarios[0].distro, "fedora");
  assertEquals(scenarios[0].topology, "serve");
});

Deno.test("normalizeScenario derives a name", () => {
  const s = normalizeScenario({ distro: "rocky", systemd: true });
  assertEquals(s.name, "rocky-systemd-standalone");
});

Deno.test("scenarioSlug is swamp-safe", () => {
  assertEquals(
    scenarioSlug(normalizeScenario({ name: "Ubuntu Systemd/Fleet" })),
    "ubuntu-systemd-fleet",
  );
});

Deno.test("catalog distros all have a family and package manager", () => {
  for (const d of DISTROS) {
    assertEquals(typeof d.family, "string");
    assertEquals(typeof d.packageManager, "string");
    assertEquals(d.image.length > 0, true);
  }
});
