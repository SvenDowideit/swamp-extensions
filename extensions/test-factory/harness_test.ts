import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildHarnessScript,
  DONE_PATH,
  evaluateResult,
  type HarnessPlan,
  type HarnessResult,
  parseFixtures,
  parseHarnessResult,
  phaseClaims,
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
  tests: [],
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
  assertEquals(script.includes("declarative acceptance"), false);
});

Deno.test("buildHarnessScript records isolation evidence", () => {
  const script = buildHarnessScript(plan);
  assertStringIncludes(script, "record harnessIsolation");
  assertStringIncludes(script, "record_iso");
  assertStringIncludes(script, "dockerHost");
});

Deno.test("buildHarnessScript defaults to root with no drop", () => {
  const script = buildHarnessScript(plan);
  assertEquals(script.includes("exec su -s /bin/sh"), false);
  assertEquals(script.includes("enable-linger"), false);
  assertEquals(script.includes("chown -R"), false);
});

Deno.test("buildHarnessScript as tester installs as root then drops", () => {
  const script = buildHarnessScript({ ...plan, runAs: "tester" });
  assertStringIncludes(script, "exec su -s /bin/sh tester");
  assertStringIncludes(script, "TF_DROPPED");
  assertStringIncludes(script, "enable-linger tester");
  assertStringIncludes(script, "chown -R tester /tf /work");
  assertStringIncludes(script, "record harnessUser");
});

Deno.test("parseHarnessResult reads the isolation block", () => {
  const parsed = parseHarnessResult(JSON.stringify({
    installOk: true,
    harnessIsolation: {
      whoami: "tester",
      uid: "1000",
      sandboxId: "abc123",
      dockerHost: "tcp://dind:2375",
    },
  }));
  assertEquals(parsed.harnessIsolation?.uid, "1000");
  assertEquals(parsed.harnessIsolation?.dockerHost, "tcp://dind:2375");
});

Deno.test("buildHarnessScript emits the tests phase only when requested", () => {
  const withTests = buildHarnessScript({
    ...plan,
    phases: ["tests"],
    tests: [{
      name: "t1",
      confirms: "it works",
      cannot: "must not error",
      variables: {},
      steps: [{
        name: "s1",
        run: "swamp --version",
        timeoutSeconds: 30,
        continueOnFailure: false,
        expect: { exitCode: 0, stdoutNotContains: ["error"] },
      }],
    }],
  });
  assertStringIncludes(withTests, "# --- tests (declarative acceptance)");
  assertStringIncludes(withTests, "append tests");
  const without = buildHarnessScript({ ...plan, phases: ["smoke"] });
  assertEquals(without.includes("declarative acceptance"), false);
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
    tests: [],
    ...overrides,
  };
}

Deno.test("evaluateResult passes when all documented tests pass", () => {
  const e = evaluateResult(
    result({
      tests: [{
        name: "t1",
        ok: true,
        steps: [{
          name: "s1",
          run: "x",
          ok: true,
          exitCode: 0,
          matched: [],
          stdout: "",
          stderr: "",
        }],
      }],
    }),
    ["tests"],
    "pass",
  );
  assertEquals(e.ok, true);
  assertEquals(e.errors, []);
});

Deno.test("evaluateResult fails when a documented test fails", () => {
  const e = evaluateResult(
    result({
      tests: [{
        name: "t1",
        ok: false,
        steps: [{
          name: "s1",
          run: "x",
          ok: false,
          exitCode: 1,
          matched: [],
          stdout: "",
          stderr: "",
        }],
      }],
    }),
    ["tests"],
    "pass",
  );
  assertEquals(e.ok, false);
  assertEquals(e.errors.some((m) => m.includes('step "s1" failed')), true);
});

Deno.test("evaluateResult reports an empty tests phase honestly", () => {
  const e = evaluateResult(result({ tests: [] }), ["tests"], "pass");
  assertEquals(e.ok, false);
  assertEquals(
    e.phases.find((p) => p.phase === "tests")?.detail,
    "no test-factory.yaml tests supplied",
  );
});

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

Deno.test("phaseClaims describes each requested phase in order", () => {
  const claims = phaseClaims(plan);
  assertEquals(claims.map((c) => c.phase), ["smoke", "load", "definitions"]);
  assertStringIncludes(claims[0].claim, "installs and runs");
  assertStringIncludes(claims[1].claim, "@acme/thing, @acme/other");
  assertStringIncludes(claims[2].claim, "2 declared model type(s)");
  assertStringIncludes(claims[2].claim, "1");
});

Deno.test("recorded definitions commands match the generated script", () => {
  const claims = phaseClaims(plan);
  const script = buildHarnessScript(plan);
  const definitions = claims.find((c) => c.phase === "definitions")!;
  for (const cmd of definitions.commands) {
    // The recorded mechanics are the literal command lines the script runs.
    assertStringIncludes(script, cmd);
  }
});

Deno.test("recorded smoke release URL matches the generated script", () => {
  const claims = phaseClaims(plan);
  const smoke = claims.find((c) => c.phase === "smoke")!;
  const script = buildHarnessScript(plan);
  // The recorded curl names the exact asset URL; the script assigns that same
  // URL to SWAMP_URL before downloading it.
  assertStringIncludes(
    smoke.commands.join("\n"),
    "download/v1.2.3/swamp-linux-$SWAMP_ARCH",
  );
  assertStringIncludes(
    script,
    'SWAMP_URL="https://example.test/releases/download/v1.2.3/swamp-linux-$SWAMP_ARCH"',
  );
});

Deno.test("phaseClaims omits phases that were not requested", () => {
  const claims = phaseClaims({ ...plan, phases: ["smoke"] });
  assertEquals(claims.map((c) => c.phase), ["smoke"]);
});

Deno.test("phaseClaims flags an empty fixtures phase honestly", () => {
  const claims = phaseClaims({ ...plan, phases: ["fixtures"], fixtures: [] });
  assertEquals(claims.length, 1);
  assertStringIncludes(claims[0].claim, "no fixtures were supplied");
  assertEquals(claims[0].commands, ["(no fixtures supplied)"]);
});

Deno.test("phaseClaims records fixture expectations", () => {
  const claims = phaseClaims({
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
  assertStringIncludes(
    claims[0].commands.join("\n"),
    "--input repo=owner/name",
  );
  assertStringIncludes(claims[0].commands.join("\n"), "owner/name");
  assertStringIncludes(claims[0].commands.join("\n"), "'ok'");
});
