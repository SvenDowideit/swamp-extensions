import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildHarnessScript,
  DONE_PATH,
  evaluateResult,
  type HarnessPlan,
  type HarnessResult,
  parseFixtures,
  parseHarnessResult,
  phaseLabel,
  shellQuote,
} from "./harness.ts";

Deno.test("DONE_PATH is the harness completion marker", () => {
  assertEquals(DONE_PATH, "/tf/done");
});

const plan: HarnessPlan = {
  swampVersion: "v1.2.3",
  repoDir: "/work/repo",
  extensionMount: "/opt/ext",
  extensionName: "under-test",
  modelTypes: ["@acme/thing", "@acme/other"],
  workflows: ["acme-flow"],
  phases: ["smoke", "load", "definitions"],
  fixtures: [],
  releaseBaseUrl: "https://example.test/releases",
  expectSystemd: false,
};

Deno.test("shellQuote escapes single quotes", () => {
  assertEquals(shellQuote("a'b"), `'a'\\''b'`);
});

Deno.test("buildHarnessScript pins the requested version", () => {
  const script = buildHarnessScript(plan);
  assertStringIncludes(script, "download/v1.2.3/swamp-linux-");
  assertStringIncludes(script, "swamp init --tool none");
  assertStringIncludes(script, "extension source add");
  assertStringIncludes(script, "swamp model create '@acme/thing'");
  assertStringIncludes(script, "swamp model create '@acme/other'");
  assertStringIncludes(script, "swamp workflow validate 'acme-flow'");
  assertStringIncludes(script, "doctor extensions --json");
});

Deno.test("buildHarnessScript uses latest when version is empty", () => {
  const script = buildHarnessScript({ ...plan, swampVersion: "" });
  assertStringIncludes(script, "latest/download/swamp-linux-");
});

Deno.test("buildHarnessScript emits fixtures with inputs and expectations", () => {
  const script = buildHarnessScript({
    ...plan,
    phases: ["fixtures"],
    fixtures: [{
      type: "@acme/thing",
      method: "check",
      instance: "fix-one",
      inputs: { repo: "owner/name" },
      allowFailure: false,
      expectContains: "ok",
    }],
  });
  assertStringIncludes(script, "method run 'check' 'fix-one'");
  assertStringIncludes(script, "--input 'repo=owner/name'");
  assertStringIncludes(script, "grep -qF -- 'ok'");
});

Deno.test("buildHarnessScript omits phases that are not requested", () => {
  const script = buildHarnessScript({ ...plan, phases: ["smoke"] });
  assertEquals(script.includes("swamp model create"), false);
  assertEquals(script.includes("swamp workflow validate"), false);
});

function result(overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    installOk: true,
    swampVersion: "swamp 1.2.3",
    doctorStatus: "pass",
    doctorStates: {},
    sourceAddOk: true,
    registeredTypes: ["@acme/thing"],
    modelTypes: ["@acme/thing"],
    missingTypes: [],
    definitions: [{ type: "@acme/thing", name: "tf-def-1", ok: true }],
    workflows: [{ name: "acme-flow", ok: true, status: "valid" }],
    fixtures: [],
    ...overrides,
  };
}

Deno.test("evaluateResult passes a clean run", () => {
  const e = evaluateResult(result(), ["smoke", "load", "definitions"], "pass");
  assertEquals(e.ok, true);
  assertEquals(e.errors, []);
});

Deno.test("evaluateResult asserts systemd when expected", () => {
  const ok = evaluateResult(
    result({ systemd: "running" }),
    ["smoke"],
    "pass",
    true,
  );
  assertEquals(ok.ok, true);
  const bad = evaluateResult(
    result({ systemd: "not-running" }),
    ["smoke"],
    "pass",
    true,
  );
  assertEquals(bad.ok, false);
  assertEquals(bad.errors.some((m) => m.includes("systemd")), true);
});

Deno.test("evaluateResult fails when a type is missing", () => {
  const e = evaluateResult(
    result({ missingTypes: ["@acme/thing"] }),
    ["smoke", "load"],
    "pass",
  );
  assertEquals(e.ok, false);
  assertEquals(e.errors.some((m) => m.includes("missing")), true);
});

Deno.test("evaluateResult fails when a definition cannot be created", () => {
  const e = evaluateResult(
    result({
      definitions: [{
        type: "@acme/thing",
        name: "x",
        ok: false,
        error: "boom",
      }],
    }),
    ["definitions"],
    "pass",
  );
  assertEquals(e.ok, false);
  assertStringIncludes(e.errors.join(" "), "boom");
});

Deno.test("evaluateResult fails when a workflow is invalid", () => {
  const e = evaluateResult(
    result({
      workflows: [{
        name: "acme-flow",
        ok: false,
        status: "invalid",
        error: "bad dag",
      }],
    }),
    ["definitions"],
    "pass",
  );
  assertEquals(e.ok, false);
});

Deno.test("an expected-fail scenario passes when the install fails", () => {
  const e = evaluateResult(
    {
      ...result(),
      installOk: false,
      installError: "__res_init: symbol not found",
    },
    ["smoke"],
    "fail",
  );
  assertEquals(e.ok, true);
});

Deno.test("an expected-pass scenario fails when the install fails", () => {
  const e = evaluateResult(
    { ...result(), installOk: false, installError: "download failed" },
    ["smoke"],
    "pass",
  );
  assertEquals(e.ok, false);
});

Deno.test("an expected-fail scenario fails when it unexpectedly succeeds", () => {
  const e = evaluateResult(result(), ["smoke", "load"], "fail");
  assertEquals(e.ok, false);
});

Deno.test("parseHarnessResult tolerates missing fields", () => {
  const parsed = parseHarnessResult(JSON.stringify({ installOk: true }));
  assertEquals(parsed.installOk, true);
  assertEquals(parsed.definitions, []);
  assertEquals(parsed.doctorStatus, "unknown");
});

Deno.test("parseFixtures reads a YAML list with input.<key>", () => {
  const fixtures = parseFixtures(`
- type: "@acme/thing"
  method: check
  instance: fix-one
  input.repo: owner/name
  input.os: Linux
  expectContains: ok
- type: "@acme/thing"
  method: list
  allowFailure: true
`);
  assertEquals(fixtures.length, 2);
  assertEquals(fixtures[0].type, "@acme/thing");
  assertEquals(fixtures[0].inputs.repo, "owner/name");
  assertEquals(fixtures[0].inputs.os, "Linux");
  assertEquals(fixtures[0].expectContains, "ok");
  assertEquals(fixtures[1].allowFailure, true);
});

Deno.test("parseFixtures reads a JSON array", () => {
  const fixtures = parseFixtures(JSON.stringify([
    { type: "@a/b", method: "run", instance: "i", inputs: { k: "v" } },
  ]));
  assertEquals(fixtures[0].inputs.k, "v");
});

Deno.test("phaseLabel is human readable", () => {
  assertEquals(phaseLabel("smoke"), "smoke (install + doctor)");
  assertEquals(phaseLabel("fixtures"), "fixtures (run methods)");
});
