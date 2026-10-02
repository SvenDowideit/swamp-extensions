import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  renderCoverage,
  renderResult,
  renderSummary,
  renderTests,
} from "./test_factory_report.ts";

Deno.test("renderResult shows the scenario, distro, topology and phases", () => {
  const md = renderResult({
    scenario: "ubuntu-systemd-fleet-2",
    extension: "@acme/thing",
    extensionVersion: "2026.01.01.1",
    intent: "Prove @acme/thing@2026.01.01.1 installs and behaves.",
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
  assertStringIncludes(md, "Extension **@acme/thing@2026.01.01.1**");
  assertStringIncludes(md, "_Prove @acme/thing@2026.01.01.1 installs");
  assertStringIncludes(md, "topology **fleet** (2 workers)");
  assertStringIncludes(md, "| smoke | PASS | doctor: pass |");
  assertStringIncludes(md, "workers 2/2");
});

Deno.test("renderResult explains what each phase proves and how", () => {
  const md = renderResult({
    scenario: "debian-standalone",
    extension: "@acme/thing",
    extensionVersion: "1",
    intent: "Prove @acme/thing installs.",
    distro: "debian",
    systemd: false,
    topology: "standalone",
    workers: 0,
    expected: "pass",
    status: "pass",
    ok: true,
    phases: [{ phase: "smoke", ok: true, detail: "doctor: pass" }],
    claims: [
      {
        phase: "smoke",
        claim: "swamp installs and doctor reports pass",
        commands: [
          "curl -fsSL -o /usr/local/bin/swamp https://example.test/swamp",
          "swamp doctor extensions --json",
        ],
      },
    ],
    definitions: [],
    workflows: [],
    errors: [],
    logs: "",
  });
  assertStringIncludes(md, "### What this run proves");
  assertStringIncludes(
    md,
    "- **smoke** — swamp installs and doctor reports pass",
  );
  assertStringIncludes(md, "### How it was proved");
  assertStringIncludes(md, "swamp doctor extensions --json");
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

Deno.test("renderResult renders documented tests with prose and logs", () => {
  const md = renderResult({
    scenario: "debian-standalone",
    distro: "debian",
    systemd: false,
    topology: "standalone",
    workers: 0,
    expected: "pass",
    status: "fail",
    ok: false,
    phases: [{ phase: "tests", ok: false, detail: 't1: step "run" failed' }],
    definitions: [],
    workflows: [],
    fixtures: [],
    tests: [{
      name: "check-prints-latest",
      confirms: "the check method prints the latest release tag",
      cannot: "must not exit non-zero",
      ok: false,
      steps: [{
        name: "run",
        run: "swamp model @acme/thing method run check c",
        ok: false,
        exitCode: 1,
        matched: ["expected exitCode 0, got 1"],
        stdout: "boom",
        stderr: "panic",
      }],
    }],
    errors: ['tests: check-prints-latest: step "run" failed'],
    logs: "",
  });
  assertStringIncludes(md, "### Documented tests — 0/1 passed");
  assertStringIncludes(md, "#### check-prints-latest — FAIL");
  assertStringIncludes(md, "**confirms**: the check method prints");
  assertStringIncludes(md, "**cannot**: must not exit non-zero");
  assertStringIncludes(md, "expected exitCode 0, got 1");
  assertStringIncludes(md, "panic");
});

Deno.test("renderTests counts passes per test", () => {
  const lines = renderTests({
    tests: [
      { name: "a", confirms: "x", cannot: "y", ok: true, steps: [] },
      { name: "b", confirms: "x", cannot: "y", ok: false, steps: [] },
    ],
  }).join("\n");
  assertStringIncludes(lines, "### Documented tests — 1/2 passed");
});

Deno.test("renderTests is empty when there are no tests", () => {
  assertEquals(renderTests({ tests: [] }), []);
});

Deno.test("renderCoverage reports documented and shipped-surface coverage", () => {
  const lines = renderCoverage({
    coverage: {
      testCount: 3,
      testCommands: [
        "swamp model method run e2e installCaddy",
        "swamp model method run e2e plan",
      ],
      documentedCommands: [
        "swamp model method run my-thing installCaddy",
        "swamp model method run my-thing plan",
        "swamp workflow run caddy-setup",
      ],
      documentedCovered: [
        "swamp model method run my-thing installCaddy",
        "swamp model method run my-thing plan",
      ],
      uncoveredCommands: ["swamp workflow run caddy-setup"],
      surface: {
        types: 1,
        methods: ["@a/b.plan", "@a/b.sync"],
        methodsCovered: ["@a/b.plan"],
        workflows: ["caddy-setup"],
        workflowsCovered: [],
      },
    },
  }).join("\n");
  assertStringIncludes(lines, "### Test coverage");
  assertStringIncludes(lines, "Documented tests**: 3");
  assertStringIncludes(
    lines,
    "Distinct `swamp …` commands the tests run**: 2",
  );
  // The source of each ratio is named explicitly.
  assertStringIncludes(
    lines,
    "Commands shown in the manifest `description:`**: 3 distinct — 2 run by a test (67%)",
  );
  assertStringIncludes(
    lines,
    "Methods declared by the model type(s)**: 2 — 1 run by a test (50%)",
  );
  assertStringIncludes(lines, "Workflows declared**: 1 — 0 run by a test (0%)");
  // The full command lists are rendered.
  assertStringIncludes(lines, "- `swamp model method run e2e plan`");
  assertStringIncludes(lines, "- `swamp workflow run caddy-setup`");
  assertStringIncludes(lines, "- `@a/b.sync`");
});

Deno.test("renderCoverage is empty without coverage data", () => {
  assertEquals(renderCoverage({}), []);
});

Deno.test("renderResult renders coverage when present", () => {
  const md = renderResult({
    scenario: "debian-standalone",
    distro: "debian",
    systemd: false,
    topology: "standalone",
    workers: 0,
    expected: "pass",
    status: "pass",
    ok: true,
    phases: [],
    definitions: [],
    workflows: [],
    errors: [],
    logs: "",
    coverage: {
      testCount: 1,
      testCommands: ["swamp model method run e2e installCaddy"],
      documentedCommands: [
        "swamp model method run my-thing installCaddy",
        "swamp model method run my-thing plan",
      ],
      documentedCovered: ["swamp model method run my-thing installCaddy"],
      uncoveredCommands: ["swamp model method run my-thing plan"],
      surface: {
        types: 1,
        methods: ["@a/b.installCaddy", "@a/b.plan"],
        methodsCovered: ["@a/b.installCaddy"],
        workflows: [],
        workflowsCovered: [],
      },
    },
  });
  assertStringIncludes(md, "### Test coverage");
  assertStringIncludes(
    md,
    "Commands shown in the manifest `description:`**: 2 distinct — 1 run by a test (50%)",
  );
});

Deno.test("renderSummary shows test counts", () => {
  const md = renderSummary({
    extension: "@acme/thing",
    count: 1,
    passCount: 1,
    failCount: 0,
    errorCount: 0,
    testCount: 4,
    testsPassed: 3,
    claims: [],
    results: [],
  });
  assertStringIncludes(md, "Documented tests: **3/4** passed");
});

Deno.test("renderSummary shows the version and claims", () => {
  const md = renderSummary({
    extension: "@acme/thing",
    version: "2026.01.01.1",
    count: 1,
    passCount: 1,
    failCount: 0,
    errorCount: 0,
    claims: [{
      phase: "load",
      claim: "every declared model type registers",
      commands: ["swamp model type search --json"],
    }],
    results: [{
      scenario: "debian-standalone",
      distro: "debian",
      topology: "standalone",
      expected: "pass",
      ok: true,
      status: "pass",
    }],
  });
  assertStringIncludes(md, "# Test factory — @acme/thing@2026.01.01.1");
  assertStringIncludes(md, "### What this run proves");
  assertStringIncludes(md, "- **load** — every declared model type registers");
  assertStringIncludes(md, "swamp model type search --json");
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
  assertStringIncludes(md, "| Scenario | Distro | Topology |");
  assertStringIncludes(
    md,
    "| debian-standalone | debian | standalone | pass | PASS (pass) |",
  );
  assertStringIncludes(
    md,
    "| alpine-standalone | alpine | standalone | fail | FAIL (fail) |",
  );
});
