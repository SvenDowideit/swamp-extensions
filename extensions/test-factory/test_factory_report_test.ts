import { assertStringIncludes } from "jsr:@std/assert@1";
import { renderResult, renderSummary } from "./test_factory_report.ts";

Deno.test("renderResult shows the scenario, distro, topology and phases", () => {
  const md = renderResult({
    scenario: "ubuntu-systemd-fleet-2",
    distro: "ubuntu",
    systemd: true,
    topology: "fleet",
    workers: 2,
    expected: "pass",
    status: "pass",
    ok: true,
    phases: [
      { phase: "smoke", ok: true, detail: "doctor: pass" },
      { phase: "load", ok: true, detail: "1 type(s) registered" },
    ],
    definitions: [{ type: "@acme/thing", name: "tf-def-1", ok: true }],
    workflows: [{ name: "acme-flow", ok: true, status: "valid" }],
    topologyResult: {
      serveReady: true,
      workersEnrolled: 2,
      workersRequested: 2,
      dispatchOk: true,
      detail: "",
    },
    errors: [],
    logs: "",
  });
  assertStringIncludes(
    md,
    "## ubuntu-systemd-fleet-2 — PASS",
  );
  assertStringIncludes(md, "topology **fleet** (2 workers)");
  assertStringIncludes(md, "| smoke | PASS | doctor: pass |");
  assertStringIncludes(md, "workers 2/2");
});

Deno.test("renderResult lists errors", () => {
  const md = renderResult({
    scenario: "alpine-standalone",
    distro: "alpine",
    systemd: false,
    topology: "standalone",
    workers: 0,
    expected: "fail",
    status: "pass",
    ok: true,
    phases: [{ phase: "smoke", ok: true, detail: "install: __res_init" }],
    definitions: [],
    workflows: [],
    fixtures: [],
    errors: [],
    logs: "",
  });
  assertStringIncludes(md, "## alpine-standalone — PASS");
  assertStringIncludes(md, "__res_init");
});

Deno.test("renderResult renders fixtures", () => {
  const md = renderResult({
    scenario: "s",
    distro: "debian",
    systemd: false,
    topology: "standalone",
    workers: 0,
    expected: "pass",
    status: "fail",
    ok: false,
    phases: [],
    definitions: [],
    workflows: [],
    fixtures: [{
      type: "@a/b",
      method: "check",
      instance: "i",
      code: 1,
      ok: false,
      matched: false,
      output: "boom",
    }],
    errors: ["fixtures: @a/b/check: exit 1"],
    logs: "",
  });
  assertStringIncludes(md, "| @a/b/check | FAIL | 1 |");
  assertStringIncludes(md, "- fixtures: @a/b/check: exit 1");
});

Deno.test("renderSummary totals and tabulates", () => {
  const md = renderSummary({
    extension: "@acme/thing",
    count: 2,
    passCount: 1,
    failCount: 1,
    errorCount: 0,
    results: [
      {
        scenario: "debian-standalone",
        distro: "debian",
        topology: "standalone",
        expected: "pass",
        ok: true,
        status: "pass",
      },
      {
        scenario: "alpine-standalone",
        distro: "alpine",
        topology: "standalone",
        expected: "fail",
        ok: false,
        status: "fail",
      },
    ],
  });
  assertStringIncludes(md, "# Test factory — @acme/thing");
  assertStringIncludes(md, "2 scenario(s): **1 passed**, 1 failed");
  assertStringIncludes(
    md,
    "| debian-standalone | debian | standalone | pass | PASS (pass) |",
  );
  assertStringIncludes(
    md,
    "| alpine-standalone | alpine | standalone | fail | FAIL (fail) |",
  );
});
