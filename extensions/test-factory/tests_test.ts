import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  buildTestsPhaseScript,
  type HarnessTest,
  hasNegativeAssertion,
  hasPositiveAssertion,
  lintTests,
  mergeTests,
  parseTests,
  type TestSpec,
} from "./tests.ts";

const YAML = `
tests:
  - name: check-prints-latest
    confirms: >
      the check method prints the latest release tag for a public repo.
    cannot: >
      must not exit non-zero and must not print an error.
    documents: README.md#run
    variables:
      REPO: caddyserver/caddy
    steps:
      - name: create
        run: swamp model create @acme/thing check-me
        expect:
          exitCode: 0
      - name: run
        run:
          swamp model @acme/thing method run check check-me --input repo=$REPO
        expect:
          exitCode: 0
          stdoutContains: [caddy_]
          stdoutNotContains:
            - error
            - not found
          stdoutMatches: "caddy_v\\\\d"
          stderrNotContains: [panic]
        timeoutSeconds: 90
`;

Deno.test("parseTests reads prose, variables and steps", () => {
  const tests = parseTests(YAML);
  assertEquals(tests.length, 1);
  const t = tests[0];
  assertEquals(t.name, "check-prints-latest");
  assertStringIncludes(t.confirms, "latest release tag");
  assertStringIncludes(t.cannot, "must not exit non-zero");
  assertEquals(t.documents, "README.md#run");
  assertEquals(t.variables.REPO, "caddyserver/caddy");
  assertEquals(t.steps.length, 2);
  assertEquals(t.steps[1].expect.stdoutContains, ["caddy_"]);
  assertEquals(t.steps[1].expect.stdoutNotContains, ["error", "not found"]);
  assertEquals(t.steps[1].expect.stderrNotContains, ["panic"]);
  assertEquals(t.steps[1].timeoutSeconds, 90);
});

Deno.test("parseTests tolerates an empty or absent document", () => {
  assertEquals(parseTests(""), []);
  assertEquals(parseTests("---\n"), []);
  assertEquals(parseTests("tests: []"), []);
});

Deno.test("parseTests rejects a non-array tests value", () => {
  assertThrows(() => parseTests("tests: nope"), Error, "must be an array");
});

Deno.test("lintTests passes a sound test", () => {
  assertEquals(lintTests(parseTests(YAML)), []);
});

Deno.test("lintTests flags confirms with no positive assertion", () => {
  const specs: TestSpec[] = [{
    name: "t",
    confirms: "does the thing",
    cannot: "must not error",
    variables: {},
    steps: [{
      name: "s",
      run: "true",
      timeoutSeconds: 10,
      continueOnFailure: false,
      // Non-zero exit code is the only assertion; nothing asserts success.
      expect: { exitCode: 2, stdoutNotContains: ["error"] },
    }],
  }];
  const issues = lintTests(specs);
  assertEquals(
    issues.some((i) => i.includes("no step asserts a positive")),
    true,
  );
});

Deno.test("lintTests flags cannot with no negative assertion", () => {
  const specs: TestSpec[] = [{
    name: "t",
    confirms: "does the thing",
    cannot: "must not error",
    variables: {},
    steps: [{
      name: "s",
      run: "true",
      timeoutSeconds: 10,
      continueOnFailure: false,
      expect: { exitCode: 0 },
    }],
  }];
  const issues = lintTests(specs);
  assertEquals(
    issues.some((i) => i.includes("no step asserts a negative")),
    true,
  );
});

Deno.test("lintTests flags a missing run and duplicate names", () => {
  const specs: TestSpec[] = [
    {
      name: "dup",
      confirms: "a",
      cannot: "b",
      variables: {},
      steps: [{
        name: "x",
        run: "true",
        timeoutSeconds: 10,
        continueOnFailure: false,
        expect: { exitCode: 0, stdoutNotContains: ["x"] },
      }],
    },
    {
      name: "dup",
      confirms: "a",
      cannot: "b",
      variables: {},
      steps: [{
        name: "y",
        run: "",
        timeoutSeconds: 10,
        continueOnFailure: false,
        expect: { exitCode: 0, stdoutNotContains: ["x"] },
      }],
    },
  ];
  const issues = lintTests(specs);
  assertEquals(issues.some((i) => i.includes("duplicate name")), true);
  assertEquals(issues.some((i) => i.includes("missing `run`")), true);
});

Deno.test("positive/negative assertion detection", () => {
  const base = {
    name: "s",
    run: "true",
    timeoutSeconds: 10,
    continueOnFailure: false,
  };
  assertEquals(hasPositiveAssertion({ ...base, expect: {} }), true);
  assertEquals(
    hasPositiveAssertion({ ...base, expect: { exitCode: 2 } }),
    false,
  );
  assertEquals(
    hasPositiveAssertion({ ...base, expect: { stdoutMatches: ["x"] } }),
    true,
  );
  assertEquals(hasNegativeAssertion({ ...base, expect: {} }), false);
  assertEquals(
    hasNegativeAssertion({ ...base, expect: { stdoutNotContains: ["x"] } }),
    true,
  );
  assertEquals(
    hasNegativeAssertion({ ...base, expect: { exitCode: [0, 1] } }),
    true,
  );
});

Deno.test("buildTestsPhaseScript emits the tests phase and per-step assertions", () => {
  const script = buildTestsPhaseScript(parseTests(YAML)).join("\n");
  assertStringIncludes(script, "# --- tests (declarative acceptance)");
  assertStringIncludes(script, "check-prints-latest");
  assertStringIncludes(script, "swamp model create @acme/thing check-me");
  assertStringIncludes(script, "grep -qF -- 'caddy_'");
  assertStringIncludes(script, "grep -qF -- 'error'");
  assertStringIncludes(script, "grep -qE -- 'caddy_v\\d'");
  assertStringIncludes(script, "timeout 90 sh");
  assertStringIncludes(script, "append tests");
});

Deno.test("buildTestsPhaseScript never pipes JSON through echo", () => {
  const script = buildTestsPhaseScript(parseTests(YAML)).join("\n");
  // The container /bin/sh is dash, whose builtin echo interprets `\n` in JSON
  // and corrupts it; the script must use printf instead.
  assertEquals(
    /echo "\$(STEPS|MATCHED)" \| jq/.test(script),
    false,
  );
  assertStringIncludes(script, `printf '%s' "$STEPS" | jq`);
  assertStringIncludes(script, `printf '%s' "$MATCHED" | jq`);
});

Deno.test("buildTestsPhaseScript skips later steps after a failure", () => {
  const script = buildTestsPhaseScript(parseTests(YAML)).join("\n");
  assertStringIncludes(script, 'if [ "$TF_STOP" = "0" ]; then');
  assertStringIncludes(script, "skipped: an earlier step failed");
});

Deno.test("buildTestsPhaseScript records no continue flag on a blocking step", () => {
  const tests = parseTests(YAML);
  const script = buildTestsPhaseScript(tests).join("\n");
  // The step is not continueOnFailure, so a failure sets TF_STOP.
  assertStringIncludes(
    script,
    'if [ "$STEP_OK" = "false" ]; then TF_STOP=1; fi',
  );
});

Deno.test("mergeTests pairs harness outcomes with authored prose", () => {
  const specs = parseTests(YAML);
  const harness: HarnessTest[] = [{
    name: "check-prints-latest",
    ok: false,
    steps: [{
      name: "run",
      run: "x",
      ok: false,
      exitCode: 1,
      matched: ["expected exitCode 0, got 1"],
      stdout: "",
      stderr: "boom",
    }],
  }];
  const merged = mergeTests(specs, harness);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].ok, false);
  assertStringIncludes(merged[0].confirms, "latest release tag");
  assertEquals(merged[0].steps[0].exitCode, 1);
});

Deno.test("mergeTests reports a missing harness result as a failure", () => {
  const specs = parseTests(YAML);
  const merged = mergeTests(specs, []);
  assertEquals(merged[0].ok, false);
  assertEquals(merged[0].steps, []);
});
