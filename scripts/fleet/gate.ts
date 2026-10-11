/**
 * Fleet gate — the pull-request rule that keeps behaviour and tests together.
 *
 * A PR that changes what a model type *does* — its implementation (`.ts`) or a
 * shipped workflow (an extension `.yaml`, not `manifest.yaml`) — must also
 * change at least one test (`*_test.ts`, a `test-factory.yaml`, or anything
 * under a `test/` directory). Docs, manifests, READMEs and version bumps are
 * free to change alone.
 *
 * The rule is a pure function of the changed-file list, so it is unit-tested;
 * the CLI wrapper (`scripts/fleet/gate`) feeds it `git diff --name-only`.
 *
 * @module
 */

/** Files whose change requires a test change. */
function isBehaviour(f: string): boolean {
  if (!f.startsWith("extensions/")) return false;
  if (f.endsWith(".ts")) return !isTest(f);
  if (/\.ya?ml$/.test(f)) return !/(^|\/)manifest\.yaml$/.test(f);
  return false;
}

/** Files that count as a test change. */
function isTest(f: string): boolean {
  return /_test\.ts$/.test(f) ||
    /(^|\/)test-factory\.ya?ml$/.test(f) ||
    /(^|\/)test\//.test(f);
}

/**
 * The gate's verdict for a list of changed files.
 *
 * @returns human-readable violations; empty means the PR passes.
 */
export function gateViolations(changed: string[]): string[] {
  const files = changed.map((f) => f.replace(/^\.\//, "").trim()).filter(
    Boolean,
  );
  const behaviour = files.filter(isBehaviour);
  if (behaviour.length === 0) return [];
  if (files.some(isTest)) return [];
  return [
    "these change behaviour but no test changed — add or update a *_test.ts, " +
    "a test-factory.yaml, or a test/ fixture (see docs/fleet-conventions.md):",
    ...behaviour.map((f) => `  ${f}`),
  ];
}

if (import.meta.main) {
  const base = Deno.args[0] ?? "origin/main";
  const out = await new Deno.Command("git", {
    args: ["diff", "--name-only", `${base}...HEAD`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    console.error(
      `fleet gate: git diff against ${base} failed:\n${
        new TextDecoder().decode(out.stderr)
      }`,
    );
    Deno.exit(2);
  }
  const changed = new TextDecoder().decode(out.stdout).split("\n").filter(
    Boolean,
  );
  const violations = gateViolations(changed);
  if (violations.length > 0) {
    console.error(`fleet gate: FAILED\n${violations.join("\n")}`);
    Deno.exit(1);
  }
  console.log(
    `fleet gate: PASSED (${changed.length} changed file(s) vs ${base})`,
  );
}
