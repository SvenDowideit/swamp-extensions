/**
 * Boundary negative-control evaluation (plan §16.1, §16.7).
 *
 * A positive acceptance test proves a privileged operation worked *inside* the
 * sandbox. An isolation check proves the same operation did **not** reach the
 * dev host. Only the model runs on the host, so it gathers the host facts (an
 * `absentOnHost` path is present or not; a container publishes ports or not)
 * and this module turns those facts into a verdict — no candidate-authored
 * shell ever runs on the host (plan §16.2/§16.4).
 *
 * Pure and unit-tested: the Docker/`Deno.stat` gathering lives in
 * `test_factory.ts`; this module only decides.
 *
 * @module
 */
import type { IsolationCheck } from "./services.ts";
import type { StepResult } from "./tests.ts";

/** The host-side facts gathered for one isolation check. */
export interface IsolationFacts {
  /** Outcome of the in-sandbox command, or `null` when none was declared. */
  sandbox: { code: number; stdout: string; stderr: string } | null;
  /** For each token-expanded host path: whether it exists on the host. */
  hostPaths: Array<{ path: string; exists: boolean }>;
  /** For each mapped container role: its published port `-p` bindings. */
  publishedPorts: Array<
    { role: string; container: string; bindings: string[] }
  >;
}

/** One check's verdict: the synthesized test steps + whether all held. */
export interface IsolationFinding {
  check: IsolationCheck;
  ok: boolean;
  steps: StepResult[];
  errors: string[];
}

/** Cap a captured stream the same way the harness does. */
function cap(text: string, max = 4000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/**
 * Substitute the per-run token into a command or path. Accepted spellings are
 * `$TF_RUN_ID` and `${TF_RUN_ID}`; every other `$…` is left for the shell.
 */
export function applyRunToken(value: string, runId: string): string {
  return value.replace(/\$\{TF_RUN_ID\}|\$TF_RUN_ID/g, runId);
}

function step(
  name: string,
  run: string,
  ok: boolean,
  exitCode: number,
  matched: string[],
  stdout = "",
  stderr = "",
): StepResult {
  return {
    name,
    run,
    ok,
    exitCode,
    matched,
    stdout: cap(stdout),
    stderr: cap(stderr),
  };
}

/**
 * Decide one isolation check from gathered facts.
 *
 * The check fails if the sandbox command did not succeed (the privileged
 * operation never happened, so the boundary is untested), if a host path the
 * check expects to be absent exists, or if a container the check expects to be
 * unpublished has port bindings. A missing expected fact is a failure, not a
 * warning (plan §16.1, Q6).
 */
export function evaluateIsolation(
  check: IsolationCheck,
  facts: IsolationFacts,
): IsolationFinding {
  const steps: StepResult[] = [];
  const errors: string[] = [];

  if (check.sandbox) {
    const r = facts.sandbox;
    if (r === null) {
      steps.push(
        step(
          "sandbox-command-ran",
          check.sandbox,
          false,
          -1,
          ["sandbox command result missing"],
        ),
      );
    } else {
      const ok = r.code === 0;
      if (!ok) errors.push(`sandbox command exited ${r.code}`);
      steps.push(
        step(
          "sandbox-command-succeeded-in-the-sandbox",
          check.sandbox,
          ok,
          r.code,
          [ok ? "exit 0" : `expected exit 0, got ${r.code}`],
          r.stdout,
          r.stderr,
        ),
      );
    }
  }

  for (const { path, exists } of facts.hostPaths) {
    const ok = !exists;
    if (!ok) errors.push(`host path exists but must not: ${path}`);
    steps.push(
      step(
        `host-absent: ${path}`,
        `test ! -e ${path}`,
        ok,
        exists ? 1 : 0,
        [ok ? "absent on host" : "present on host (boundary breached)"],
      ),
    );
  }

  for (const { role, container, bindings } of facts.publishedPorts) {
    const ok = bindings.length === 0;
    if (!ok) {
      errors.push(
        `container "${container}" (${role}) publishes port(s) on the host: ${
          bindings.join(", ")
        }`,
      );
    }
    steps.push(
      step(
        `host-no-published-ports: ${role}`,
        `docker port ${container}`,
        ok,
        0,
        [
          ok
            ? "no published port bindings"
            : `published: ${bindings.join(", ")}`,
        ],
      ),
    );
  }

  const ok = steps.every((s) => s.ok);
  if (steps.length === 0) {
    errors.push("no probes evaluated");
  }
  return { check, ok: ok && steps.length > 0, steps, errors };
}
