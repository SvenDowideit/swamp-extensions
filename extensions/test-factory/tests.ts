/**
 * Declarative acceptance tests for the test factory.
 *
 * An extension-under-test may ship a `test-factory.yaml` (listed in its
 * manifest's `additionalFiles:`) describing the user-facing outcomes it
 * promises. Each test pairs human prose — what it `confirms`, and what it
 * `cannot` do — with the deterministic, runnable steps that prove it. This
 * module is pure: it parses the file into typed {@link TestSpec}s, generates the
 * in-container `sh` for a test, and merges the harness's raw results back with
 * the prose for the report. The container plumbing lives in the model.
 *
 * There is no runtime model call: the prose and the steps are authored
 * together, and {@link lintTests} enforces that every `confirms` claim has a
 * positive assertion and every `cannot` claim a negative one, so a test cannot
 * pass while proving nothing.
 *
 * @module
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";

/**
 * A per-step expectation.
 *
 * Every field is optional; a step with no expectation implicitly requires
 * `exitCode: 0`. When several are given they must all hold for the step to
 * pass.
 */
export interface Expectation {
  /** Accepted exit code(s). Default `0`. */
  exitCode?: number | number[];
  /** Substrings that must appear on stdout (literal match). */
  stdoutContains?: string[];
  /** Substrings that must NOT appear on stdout. */
  stdoutNotContains?: string[];
  /** Substrings that must appear on stderr. */
  stderrContains?: string[];
  /** Substrings that must NOT appear on stderr. */
  stderrNotContains?: string[];
  /** POSIX ERE patterns that must match somewhere on stdout. */
  stdoutMatches?: string[];
  /** POSIX ERE patterns that must NOT match on stdout. */
  stdoutNotMatches?: string[];
  /** Substrings that must appear on stdout or stderr combined. */
  outputContains?: string[];
  /** Substrings that must NOT appear on stdout or stderr combined. */
  outputNotContains?: string[];
  /** POSIX ERE patterns that must match somewhere on stdout or stderr. */
  outputMatches?: string[];
  /** Paths (relative to the repo) that must exist after the step. */
  fileExists?: string[];
}

/** One runnable step within a test. */
export interface TestStep {
  /** Step name, shown in the report. */
  name: string;
  /** Shell command(s) to run. Multiline is allowed. */
  run: string;
  /** Working directory (relative to the repo) — default the repo root. */
  workingDir?: string;
  /** Kill the step after this many seconds. */
  timeoutSeconds: number;
  /** Keep running later steps even if this one fails. */
  continueOnFailure: boolean;
  /** What the step must (and must not) produce. */
  expect: Expectation;
}

/** A whole acceptance test: prose plus the steps that prove it. */
export interface TestSpec {
  /** Unique test name. */
  name: string;
  /** The user-facing outcome this test confirms (prose). */
  confirms: string;
  /** Failure modes this test rules out (prose). */
  cannot: string;
  /** Optional pointer to where the outcome is documented. */
  documents?: string;
  /** Variables exported into every step of this test. */
  variables: Record<string, string>;
  /** Ordered steps. */
  steps: TestStep[];
}

/** One step's outcome as recorded by the harness. */
export interface StepResult {
  /** Step name, matching the authored step. */
  name: string;
  /** The command that ran. */
  run: string;
  /** Whether every assertion on the step held. */
  ok: boolean;
  /** Process exit code (`-1` when the step was skipped). */
  exitCode: number;
  /** Human-readable notes about each assertion checked. */
  matched: string[];
  /** Captured stdout (tail-capped). */
  stdout: string;
  /** Captured stderr (tail-capped). */
  stderr: string;
}

/** One test's outcome as recorded by the harness (no prose). */
export interface HarnessTest {
  /** Test name, matching the authored test. */
  name: string;
  /** Whether every step passed. */
  ok: boolean;
  /** Per-step outcomes. */
  steps: StepResult[];
}

/** A test's outcome merged with its prose, ready for the report. */
export interface TestResult {
  /** Test name. */
  name: string;
  /** The user-facing outcome this test confirms (prose). */
  confirms: string;
  /** Failure modes this test rules out (prose). */
  cannot: string;
  /** Whether every step passed. */
  ok: boolean;
  /** Per-step outcomes. */
  steps: StepResult[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Coerce a scalar or list of scalars into a list of strings. */
function strArray(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return undefined;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Normalize a raw `expect:` block. */
function normalizeExpect(raw: unknown): Expectation {
  const e = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const out: Expectation = {};
  if (typeof e.exitCode === "number") out.exitCode = e.exitCode;
  else if (Array.isArray(e.exitCode)) out.exitCode = e.exitCode.map(Number);
  const set = (key: keyof Expectation) => {
    const list = strArray(e[key]);
    if (list && list.length > 0) (out as Record<string, unknown>)[key] = list;
  };
  set("stdoutContains");
  set("stdoutNotContains");
  set("stderrContains");
  set("stderrNotContains");
  set("stdoutMatches");
  set("stdoutNotMatches");
  set("outputContains");
  set("outputNotContains");
  set("outputMatches");
  set("fileExists");
  return out;
}

/** Normalize one raw test. Throws when the structure is unusable. */
function normalizeTest(raw: unknown, index: number): TestSpec {
  const t = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const name = str(t.name, `test-${index + 1}`);
  const confirms = str(t.confirms).trim();
  const cannot = str(t.cannot).trim();
  const stepsRaw = Array.isArray(t.steps) ? t.steps : [];
  const steps = stepsRaw.map((s, j) => normalizeStep(s, j));
  const variables: Record<string, string> = {};
  if (t.variables && typeof t.variables === "object") {
    for (
      const [k, v] of Object.entries(t.variables as Record<string, unknown>)
    ) {
      variables[k] = String(v);
    }
  }
  return {
    name,
    confirms,
    cannot,
    documents: optionalStr(t.documents),
    variables,
    steps,
  };
}

/** Normalize one raw step. */
function normalizeStep(raw: unknown, index: number): TestStep {
  const s = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  return {
    name: str(s.name, `step-${index + 1}`),
    run: str(s.run),
    workingDir: optionalStr(s.workingDir),
    timeoutSeconds: num(s.timeoutSeconds, 120),
    continueOnFailure: s.continueOnFailure === true,
    expect: normalizeExpect(s.expect),
  };
}

/** Parse a `test-factory.yaml` document into typed tests. */
export function parseTests(text: string): TestSpec[] {
  const doc = parseYaml(text) as unknown;
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(
      "test-factory.yaml: expected a mapping with a `tests:` key",
    );
  }
  const raw = (doc as Record<string, unknown>).tests;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("test-factory.yaml: `tests` must be an array");
  }
  return raw.map((t, i) => normalizeTest(t, i));
}

// ---------------------------------------------------------------------------
// Lint — prose must agree with assertions
// ---------------------------------------------------------------------------

/** The exit codes a step accepts (default just `0`). */
export function acceptedExitCodes(expect: Expectation): number[] {
  if (typeof expect.exitCode === "number") return [expect.exitCode];
  if (Array.isArray(expect.exitCode) && expect.exitCode.length > 0) {
    return expect.exitCode;
  }
  return [0];
}

/** True when a step asserts at least one positive outcome. */
export function hasPositiveAssertion(step: TestStep): boolean {
  const e = step.expect;
  return acceptedExitCodes(e).includes(0) ||
    (e.stdoutContains?.length ?? 0) > 0 ||
    (e.stderrContains?.length ?? 0) > 0 ||
    (e.stdoutMatches?.length ?? 0) > 0 ||
    (e.outputContains?.length ?? 0) > 0 ||
    (e.outputMatches?.length ?? 0) > 0 ||
    (e.fileExists?.length ?? 0) > 0;
}

/** True when a step asserts at least one negative (must-not) outcome. */
export function hasNegativeAssertion(step: TestStep): boolean {
  const e = step.expect;
  return acceptedExitCodes(e).some((c) => c !== 0) ||
    (e.stdoutNotContains?.length ?? 0) > 0 ||
    (e.stderrNotContains?.length ?? 0) > 0 ||
    (e.stdoutNotMatches?.length ?? 0) > 0 ||
    (e.outputNotContains?.length ?? 0) > 0;
}

/**
 * Check that prose and assertions agree, and that every step is usable.
 *
 * Returns a list of human-readable issues — empty means the file is sound. A
 * `confirms` claim with no positive assertion, or a `cannot` claim with no
 * negative assertion, means the test could pass without proving what it says.
 */
export function lintTests(specs: TestSpec[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const t of specs) {
    if (seen.has(t.name)) issues.push(`test "${t.name}": duplicate name`);
    seen.add(t.name);
    if (!t.confirms) {
      issues.push(`test "${t.name}": missing \`confirms\` prose`);
    }
    if (!t.cannot) issues.push(`test "${t.name}": missing \`cannot\` prose`);
    if (t.steps.length === 0) {
      issues.push(`test "${t.name}": no steps`);
      continue;
    }
    const positive = t.steps.some(hasPositiveAssertion);
    const negative = t.steps.some(hasNegativeAssertion);
    if (t.confirms && !positive) {
      issues.push(
        `test "${t.name}": \`confirms\` is claimed but no step asserts a ` +
          `positive outcome (exitCode 0, *Contains, *Matches or fileExists)`,
      );
    }
    if (t.cannot && !negative) {
      issues.push(
        `test "${t.name}": \`cannot\` is claimed but no step asserts a ` +
          `negative outcome (*NotContains, *NotMatches or a non-zero exitCode)`,
      );
    }
    for (const [i, s] of t.steps.entries()) {
      const label = `test "${t.name}" step ${i + 1} ("${s.name}")`;
      if (!s.run.trim()) issues.push(`${label}: missing \`run\``);
      if (s.timeoutSeconds <= 0) {
        issues.push(`${label}: \`timeoutSeconds\` must be positive`);
      }
      if (
        !s.expect.exitCode && !hasPositiveAssertion(s) &&
        !hasNegativeAssertion(s)
      ) {
        issues.push(`${label}: no \`expect\` — add an assertion`);
      }
      for (const re of s.expect.stdoutMatches ?? []) {
        issues.push(...checkRegex(label, re));
      }
      for (const re of s.expect.stdoutNotMatches ?? []) {
        issues.push(...checkRegex(label, re));
      }
    }
  }
  return issues;
}

/** Try to compile a regex as a JS RegExp purely for early syntax feedback. */
function checkRegex(label: string, pattern: string): string[] {
  try {
    new RegExp(pattern);
    return [];
  } catch {
    return [`${label}: invalid regex "${pattern}"`];
  }
}

// ---------------------------------------------------------------------------
// In-container script generation
// ---------------------------------------------------------------------------

/** Heredoc delimiter used to stage a step's `run` script verbatim. */
const RUN_HEREDOC = "TF_RUN_SCRIPT_EOF";

/**
 * Quote a value for a POSIX shell single-quoted word.
 *
 * Duplicated from `harness.ts` (rather than imported) so this module stays a
 * leaf that `harness.ts` can import without a cycle.
 */
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Alias used throughout the script generator. */
const q = quote;

/**
 * Emit the shell lines that run one test's steps.
 *
 * Steps are unrolled: each is guarded by `TF_STOP` so that a failed step with
 * `continueOnFailure: false` records the remaining steps as skipped rather than
 * running them. Assertions update `MATCHED` and `STEP_OK`.
 *
 * Accumulated JSON is piped with `printf '%s'`, never `echo`: the container
 * `/bin/sh` is dash, whose builtin `echo` interprets backslash escapes and
 * corrupts the `\n` in `jq`'s output (so captured stdout/stderr with newlines
 * would break the next `jq` parse). `printf '%s'` emits the string verbatim.
 */
function buildTestBlock(test: TestSpec, testIndex: number): string[] {
  const lines: string[] = [];
  const p = (...l: string[]) => lines.push(...l);
  const tag = `${testIndex + 1}`;
  const dir = `/tf/steps/t${tag}`;

  p(`STEPDIR=${q(dir)}`);

  p(
    `# test: ${test.name}`,
    "STEPS='[]'",
    "TEST_OK=true",
    "TF_STOP=0",
  );
  for (const [k, v] of Object.entries(test.variables)) {
    p(`export ${k}=${q(v)}`);
  }
  test.steps.forEach((step, stepIndex) => {
    const sTag = `${tag}_${stepIndex + 1}`;
    const file = `/tf/steps/${sTag}`;
    // `workingDir` is relative to the repo unless absolute.
    const wd = step.workingDir
      ? (step.workingDir.startsWith("/")
        ? step.workingDir
        : `/work/repo/${step.workingDir}`)
      : "/work/repo";
    p(
      `# step: ${step.name}`,
      'if [ "$TF_STOP" = "0" ]; then',
      "STEP_OK=true",
      "MATCHED='[]'",
      `cat > ${file}.sh <<'${RUN_HEREDOC}'`,
      step.run,
      RUN_HEREDOC,
      `if [ "$HAVE_TIMEOUT" = "1" ]; then`,
      `  ( cd ${q(wd)} && timeout ${
        Math.max(
          1,
          Math.floor(step.timeoutSeconds),
        )
      } sh ${file}.sh ) > ${file}.out 2> ${file}.err`,
      "else",
      `  ( cd ${q(wd)} && sh ${file}.sh ) > ${file}.out 2> ${file}.err`,
      "fi",
      "CODE=$?",
    );
    // exitCode
    const codes = acceptedExitCodes(step.expect);
    const caseMatch = codes.join("|");
    p(
      `case "$CODE" in`,
      `  ${caseMatch}) MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
        q(
          `exitCode ${caseMatch} ok`,
        )
      } '. + [$m]') ;;`,
      `  *) STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
        q(
          `expected exitCode ${caseMatch}, got `,
        )
      }"$CODE" '. + [$m]') ;;`,
      "esac",
    );
    // stdout/stderr assertions
    for (const needle of step.expect.stdoutContains ?? []) {
      p(
        `if grep -qF -- ${
          q(needle)
        } ${file}.out; then MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout contains ${needle}`,
          )
        } '. + [$m]'); else STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout missing ${needle}`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const needle of step.expect.stdoutNotContains ?? []) {
      p(
        `if grep -qF -- ${
          q(needle)
        } ${file}.out; then STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout unexpectedly contains ${needle}`,
          )
        } '. + [$m]'); else MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout omits ${needle}`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const needle of step.expect.stderrContains ?? []) {
      p(
        `if grep -qF -- ${
          q(needle)
        } ${file}.err; then MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stderr contains ${needle}`,
          )
        } '. + [$m]'); else STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stderr missing ${needle}`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const needle of step.expect.stderrNotContains ?? []) {
      p(
        `if grep -qF -- ${
          q(needle)
        } ${file}.err; then STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stderr unexpectedly contains ${needle}`,
          )
        } '. + [$m]'); else MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stderr omits ${needle}`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const pattern of step.expect.stdoutMatches ?? []) {
      p(
        `if grep -qE -- ${
          q(pattern)
        } ${file}.out; then MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout matches /${pattern}/`,
          )
        } '. + [$m]'); else STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout does not match /${pattern}/`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const pattern of step.expect.stdoutNotMatches ?? []) {
      p(
        `if grep -qE -- ${
          q(pattern)
        } ${file}.out; then STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout unexpectedly matches /${pattern}/`,
          )
        } '. + [$m]'); else MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `stdout does not match /${pattern}/`,
          )
        } '. + [$m]'); fi`,
      );
    }
    // Combined-stream assertions — useful when a tool decides which of stdout
    // and stderr to log to (swamp logs to stderr, data to stdout).
    for (const needle of step.expect.outputContains ?? []) {
      p(
        `if grep -qF -- ${
          q(needle)
        } ${file}.out ${file}.err; then MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `output contains ${needle}`,
          )
        } '. + [$m]'); else STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `output missing ${needle}`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const needle of step.expect.outputNotContains ?? []) {
      p(
        `if grep -qF -- ${
          q(needle)
        } ${file}.out ${file}.err; then STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `output unexpectedly contains ${needle}`,
          )
        } '. + [$m]'); else MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `output omits ${needle}`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const pattern of step.expect.outputMatches ?? []) {
      p(
        `if grep -qE -- ${
          q(pattern)
        } ${file}.out ${file}.err; then MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `output matches /${pattern}/`,
          )
        } '. + [$m]'); else STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `output does not match /${pattern}/`,
          )
        } '. + [$m]'); fi`,
      );
    }
    for (const path of step.expect.fileExists ?? []) {
      p(
        `if [ -e ${
          q(`/work/repo/${path}`)
        } ]; then MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `file exists ${path}`,
          )
        } '. + [$m]'); else STEP_OK=false; MATCHED=$(printf '%s' "$MATCHED" | jq -c --arg m ${
          q(
            `file missing ${path}`,
          )
        } '. + [$m]'); fi`,
      );
    }
    // record the step
    p(
      `STEPS=$(printf '%s' "$STEPS" | jq -c --arg n ${q(step.name)} --arg r ${
        q(step.run)
      } ` +
        `--argjson c "$CODE" --argjson ok "$STEP_OK" --argjson mt "$MATCHED" ` +
        `--rawfile o ${file}.out --rawfile e ${file}.err ` +
        `'. + [{name:$n,run:$r,ok:$ok,exitCode:$c,matched:$mt,stdout:($o|.[0:4000]),stderr:($e|.[0:4000])}]')`,
      `if [ "$STEP_OK" = "false" ]; then TEST_OK=false; fi`,
    );
    if (!step.continueOnFailure) {
      p(`if [ "$STEP_OK" = "false" ]; then TF_STOP=1; fi`);
    }
    p(
      "else",
      `STEPS=$(printf '%s' "$STEPS" | jq -c --arg n ${q(step.name)} --arg r ${
        q(
          step.run,
        )
      } '. + [{name:$n,run:$r,ok:false,exitCode:-1,matched:["skipped: an earlier step failed"],stdout:"",stderr:""}]')`,
      "fi",
    );
  });
  p(
    `append tests "$(jq -cn --arg n ${
      q(test.name)
    } --argjson ok "$TEST_OK" --argjson steps "$STEPS" '{name:$n,ok:$ok,steps:$steps}')"`,
    "",
  );
  return lines;
}

/** Build the full `tests` phase script lines for every test. */
export function buildTestsPhaseScript(tests: TestSpec[]): string[] {
  const lines: string[] = [
    "# --- tests (declarative acceptance) -------------------------------------",
    "mkdir -p /tf/steps",
    "command -v timeout >/dev/null 2>&1 && HAVE_TIMEOUT=1 || HAVE_TIMEOUT=0",
    "",
  ];
  tests.forEach((t, i) => lines.push(...buildTestBlock(t, i)));
  return lines;
}

// ---------------------------------------------------------------------------
// Merging harness results with prose
// ---------------------------------------------------------------------------

/** Merge the harness's per-test outcomes with the authored prose. */
export function mergeTests(
  specs: TestSpec[],
  harness: HarnessTest[],
): TestResult[] {
  const byName = new Map(harness.map((t) => [t.name, t]));
  return specs.map((s) => {
    const got = byName.get(s.name);
    return {
      name: s.name,
      confirms: s.confirms,
      cannot: s.cannot,
      ok: got?.ok ?? false,
      steps: got?.steps ?? [],
    };
  });
}
