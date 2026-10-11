/**
 * Report-reality lint for swamp extensions — **say what is true, not what was
 * intended.**
 *
 * The contract: information an extension gives the user must be **actual,
 * verified state**, not unactioned desired state. Concretely:
 *
 * 1. **Test, don't presume.** A method that reports an outcome (serving,
 *    configured, active, reachable) must verify that outcome before claiming it.
 * 2. **Fail fast, then stop.** A failure that prevents continuation must be
 *    stated clearly and halt the run — never swallowed, retried unchanged, or
 *    continued past. In a setup/upgrade workflow, a step a later step depends on
 *    must not be `allowFailure: true` when the dependent step runs regardless of
 *    the prerequisite's success (`condition: completed` / `always`).
 * 3. **Report the wait.** A long-lived change (DNS propagation, certificate
 *    issuance) must say how long until it is ready, rather than presenting the
 *    desired end state as already true.
 *
 * Two rules are **errors** (`failure-swallowed`, `prerequisite-allow-failure`);
 * two are **warnings** (`claim-without-verification`, `eta-missing`).
 *
 * A legitimate exemption is a `// meta-factory-ignore report-reality: <reason>`
 * comment (source) or a `# meta-factory-ignore report-reality: <reason>` comment
 * (workflow YAML) anywhere in the file; naming a rule after the keyword exempts
 * only that rule.
 *
 * The lint is pure with respect to its input strings, so it is cheap to unit
 * test.
 *
 * @module
 */

import { parse as parseYaml } from "jsr:@std/yaml@1";
import { stripComments } from "./version-source-lint.ts";

/** The anti-patterns this rule reports. */
export type ReportRealityRule =
  | "failure-swallowed"
  | "prerequisite-allow-failure"
  | "claim-without-verification"
  | "eta-missing";

/** A single report-reality problem in a source or workflow file. */
export interface ReportRealityIssue {
  /** `error` costs points in the scored check; `warning` is advisory. */
  severity: "error" | "warning";
  /** Which anti-pattern. */
  rule: ReportRealityRule;
  /** Human-readable description, including the fix. */
  message: string;
  /** 1-based line number, when known. */
  line: number;
  /** Path of the offending file, when known. */
  path?: string;
}

/** One file to lint: a model source or a workflow definition. */
export interface ReportRealityFile {
  /** Path (repo- or extension-relative) used in messages. */
  path: string;
  /** Raw TypeScript (`.ts`) or workflow YAML. */
  source: string;
}

/** `meta-factory-ignore report-reality[: rule]: <reason>` — exempt the file. */
const IGNORE_RE =
  /meta-factory-ignore\s+report-reality(?:\s+([a-z][a-z-]*))?\s*:/i;

/** A success/state claim shown to the user. */
const CLAIM_RE =
  /(serving on|successfully|success|configured|is active|reachable|installed|applied|created|complete|ready|is running|listening on)/i;

/** Evidence the code verified actual state rather than presuming it. */
const VERIFY_RE =
  /\b(probe|verify|assert|readResource|readModelData|checkHealth|isReachable|reachable\s*\(|status\s*\(|\bfetch\s*\(|await\s+[A-Za-z_$][\w$]*\s*\()/i;

/** A long-lived change whose readiness lags the action. */
const LONGOP_RE =
  /(\bdns\b|\bttl\b|propagat|certificate|acme|letsencrypt|cert issuance)/i;

/** A stated duration/ETA for a long-lived change. */
const DURATION_RE =
  /(\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)|\bttl\s*[:=]?\s*\d+|\b(?:in|within|after)\s+\d+)/i;

/** A `setup` / `upgrade` method key inside a `methods:` block. */
const SETUP_UPGRADE_METHOD_RE =
  /\bmethods\s*:\s*\{[\s\S]{0,20000}?^\s*["']?(setup|upgrade)["']?\s*:\s*\{/m;

/** A `catch` keyword. */
const CATCH_RE = /\bcatch\b/g;

/** Evidence a catch does not continue past the failure. */
const HANDLED_RE =
  /\b(throw|fail\s*\(|\.fail\b|blocked|not\s+ok|success\s*:\s*false|ok\s*:\s*false|failed\s*:\s*true|rethrow)/i;

/** A logger/console call, i.e. the catch is being reported but swallowed. */
const LOG_RE = /\b(logger|console)\s*\./;

/** The 1-based line number of a character index. */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Index of the `{` that opens a catch's block, or -1. */
function catchBlockStart(source: string, from: number): number {
  const open = source.indexOf("{", from);
  return open;
}

/** Index of the `}` that closes the block opened at `open`, or -1. */
function blockEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parse a workflow's jobs/steps, tolerating arbitrary extra keys. */
function workflowSteps(source: string): Array<{
  name: string;
  allowFailure: boolean;
  dependsOn: Array<{ step: string; condition: string }>;
}> {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const jobs = (doc as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return [];
  const out: ReturnType<typeof workflowSteps> = [];
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const steps = (job as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as {
        name?: unknown;
        allowFailure?: unknown;
        dependsOn?: unknown;
      };
      const name = typeof s.name === "string" ? s.name : "";
      const allowFailure = s.allowFailure === true;
      const dependsOn: Array<{ step: string; condition: string }> = [];
      if (Array.isArray(s.dependsOn)) {
        for (const dep of s.dependsOn) {
          if (!dep || typeof dep !== "object") continue;
          const d = dep as { step?: unknown; condition?: unknown };
          const cond = d.condition && typeof d.condition === "object"
            ? String((d.condition as { type?: unknown }).type ?? "")
            : "";
          if (typeof d.step === "string") {
            dependsOn.push({ step: d.step, condition: cond });
          }
        }
      }
      out.push({ name, allowFailure, dependsOn });
    }
  }
  return out;
}

/** Whether a workflow is a setup/upgrade workflow by name. */
function isSetupOrUpgradeWorkflow(source: string, path: string): boolean {
  const hay = `${path}\n${source.slice(0, 4000)}`;
  return /setup|upgrade/i.test(hay);
}

/** Lint one model source (`.ts`) for report-reality anti-patterns. */
function lintModelSource(
  source: string,
  path: string | undefined,
  ignored: Set<string>,
  ignoreAll: boolean,
): ReportRealityIssue[] {
  const issues: ReportRealityIssue[] = [];
  const push = (
    rule: ReportRealityRule,
    severity: "error" | "warning",
    message: string,
    line: number,
  ) => {
    if (ignoreAll || ignored.has(rule)) return;
    issues.push({ severity, rule, message, line, path });
  };

  const code = stripComments(source);
  const isSetupUpgrade = SETUP_UPGRADE_METHOD_RE.test(code);

  // Fail fast: a catch that logs but does not fail/rethrow continues past a
  // failure that may gate everything after it.
  if (isSetupUpgrade) {
    CATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CATCH_RE.exec(code)) !== null) {
      const open = catchBlockStart(code, m.index);
      if (open < 0) continue;
      const end = blockEnd(code, open);
      if (end < 0) continue;
      const body = code.slice(open, end);
      if (LOG_RE.test(body) && !HANDLED_RE.test(body)) {
        push(
          "failure-swallowed",
          "error",
          "a `catch` reports the failure but does not fail or rethrow, so the " +
            "run continues past it — a failure that prevents continuation must " +
            "be raised (or a blocked status returned) so the workflow stops and " +
            "tells the user (or add `// meta-factory-ignore report-reality: " +
            "<reason>`)",
          lineOf(code, m.index),
        );
      }
    }
  }

  // Test, don't presume: a success/state claim with no verification call.
  if (CLAIM_RE.test(code) && !VERIFY_RE.test(code)) {
    push(
      "claim-without-verification",
      "warning",
      "the source reports a success/state claim (serving, configured, active, " +
        "reachable…) but never verifies the actual state — probe or read the " +
        "real state before reporting it, rather than reporting intended state",
      1,
    );
  }

  // Report the wait: a long-lived change with no stated time-to-ready.
  if (LONGOP_RE.test(code) && !DURATION_RE.test(code)) {
    push(
      "eta-missing",
      "warning",
      "the source acts on a long-lived change (DNS/TTL/certificate) but never " +
        "says how long until it is ready — report the expected wait instead of " +
        "presenting the desired end state as already true",
      1,
    );
  }

  return issues;
}

/**
 * Lint one workflow definition for report-reality anti-patterns.
 *
 * The key rule: in a setup/upgrade workflow, a step that a later step depends on
 * must not be `allowFailure: true` when the dependent runs regardless of the
 * prerequisite's outcome (`condition: completed` / `always`). That is the caddy
 * case — `setCapabilities` failed, the run continued, and later steps reported
 * success and impossible URLs.
 */
function lintWorkflowSource(
  source: string,
  path: string | undefined,
  ignored: Set<string>,
  ignoreAll: boolean,
): ReportRealityIssue[] {
  const issues: ReportRealityIssue[] = [];
  if (!isSetupOrUpgradeWorkflow(source, path ?? "")) return issues;
  const push = (
    rule: ReportRealityRule,
    severity: "error" | "warning",
    message: string,
    line: number,
  ) => {
    if (ignoreAll || ignored.has(rule)) return;
    issues.push({ severity, rule, message, line, path });
  };

  const steps = workflowSteps(source);
  const dependents = new Map<
    string,
    Array<{ name: string; condition: string }>
  >();
  for (const s of steps) {
    for (const d of s.dependsOn) {
      const list = dependents.get(d.step) ?? [];
      list.push({ name: s.name, condition: d.condition });
      dependents.set(d.step, list);
    }
  }

  for (const s of steps) {
    if (!s.allowFailure) continue;
    const runs = (dependents.get(s.name) ?? []).filter((d) =>
      d.condition === "completed" || d.condition === "always"
    );
    if (runs.length === 0) continue;
    push(
      "prerequisite-allow-failure",
      "error",
      `step \`${s.name}\` is \`allowFailure: true\` but later step(s) ` +
        `\`${runs.map((d) => d.name).join(", ")}\` depend on it with ` +
        `\`condition: completed/always\`, so the run continues past its failure ` +
        `and can report success that is not real — make the failure stop the ` +
        `run (\`allowFailure: false\`) and gate the dependents on success`,
      1,
    );
  }

  return issues;
}

/**
 * Lint one file for report-reality anti-patterns.
 *
 * Workflow files are detected by `.yaml`/`.yml`; everything else is treated as
 * TypeScript.
 */
export function lintReportReality(
  source: string,
  path?: string,
  kind?: "ts" | "yaml",
): ReportRealityIssue[] {
  const ignored = new Set<string>();
  let ignoreAll = false;
  for (const line of source.split("\n")) {
    const m = IGNORE_RE.exec(line);
    if (!m) continue;
    if (m[1]) ignored.add(m[1].toLowerCase());
    else ignoreAll = true;
  }

  const isYaml = kind === "yaml" ||
    (kind === undefined && /\.ya?ml$/i.test(path ?? ""));
  return isYaml
    ? lintWorkflowSource(source, path, ignored, ignoreAll)
    : lintModelSource(source, path, ignored, ignoreAll);
}

/** Lint every file; the issues carry each file's path. */
export function lintReportRealities(
  files: ReportRealityFile[],
): ReportRealityIssue[] {
  const out: ReportRealityIssue[] = [];
  for (const file of files) {
    out.push(...lintReportReality(file.source, file.path));
  }
  return out;
}
