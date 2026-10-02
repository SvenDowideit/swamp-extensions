/**
 * Test-coverage metrics for a candidate extension's documented surface.
 *
 * A `test-factory.yaml` is only as good as what it exercises. This module
 * answers two questions, purely (no filesystem, no subprocess):
 *
 *   1. How many distinct `swamp …` commands does the manifest `description:`
 *      show to the user, and how many of those does the acceptance test suite
 *      actually run? (the "documented" axis)
 *   2. Of every method the extension ships across its declared model types, and
 *      every workflow it declares, how many does the suite exercise? (the
 *      "surface" axis)
 *
 * A documented command and a test command are matched by a *normalized key*
 * rather than by literal text, because a test must bind the documented command
 * to its own instance (`swamp model method run e2e-caddy installCaddy`) whereas
 * the manifest shows a friendlier one (`… my-caddy installCaddy`). The key keeps
 * the meaningful part — the method name — and drops the instance name.
 *
 * @module
 */
import type { TestSpec } from "./tests.ts";

/** A declared model type and the method names its source exports. */
export interface TypeMethods {
  /** Model type, e.g. `@acme/thing`. */
  type: string;
  /** Method keys found in the model's `methods:` block. */
  methods: string[];
  /**
   * Whether the source could be read. `false` means "unknown", so a reader can
   * tell a model with no methods from one whose source was unavailable.
   */
  known: boolean;
}

/** A `swamp …` command found in a manifest description or a test step. */
export interface CommandRef {
  /** The command line that was parsed. */
  command: string;
  /** Top-level swamp group: `model`, `workflow`, `data`, `extension`, … */
  group: string;
  /** Second-level verb: `create`, `run`, `get`, `method`, `edit`, … */
  verb: string;
  /** Model type for a `model` group command, when present. */
  type?: string;
  /** Method name for `swamp model … method run <method>`. */
  method?: string;
  /** Model instance for `model method run` / `model get` / `model edit`. */
  instance?: string;
  /** Workflow name for `workflow run|validate|create <name>`. */
  workflow?: string;
}

/**
 * Coverage of the shipped method/workflow surface by the test suite.
 *
 * Both the full set and the exercised subset are stored as the literal
 * `type.method` / workflow names, so a reader sees exactly what is covered and
 * what is not — the counts are just each list's length.
 */
export interface SurfaceCoverage {
  /** Number of declared model types scanned. */
  types: number;
  /** Every declared method, as `type.method`. */
  methods: string[];
  /** Declared methods at least one test step runs, as `type.method`. */
  methodsCovered: string[];
  /** Every declared workflow name. */
  workflows: string[];
  /** Declared workflow names at least one test step runs. */
  workflowsCovered: string[];
}

/**
 * The full coverage report for one candidate extension.
 *
 * Every field is a literal list (or a count of one); nothing is a normalized
 * key, so the stored resource is self-describing. `documentedCommands` is the
 * set of commands the manifest `description:` shows the user;
 * `documentedCovered`/`uncoveredCommands` partition it by whether the tests
 * exercise it.
 */
export interface CoverageReport {
  /** Number of documented acceptance tests in `test-factory.yaml`. */
  testCount: number;
  /** Distinct swamp commands the test steps invoke, as written. */
  testCommands: string[];
  /** Distinct swamp commands the manifest `description:` shows, as written. */
  documentedCommands: string[];
  /** Documented commands a test step also runs, as written. */
  documentedCovered: string[];
  /** Documented commands no test step runs, as written. */
  uncoveredCommands: string[];
  /** Shipped-surface axis. */
  surface: SurfaceCoverage;
}

/** A line that begins a swamp invocation (with an optional `$`/`#` prompt). */
const SWAMP_INVOCATION = /^\s*(?:\$#?\s*)?swamp\s+/;

/**
 * Recognized swamp groups and their verbs.
 *
 * The description block is wrapped prose, so a line can begin with the literal
 * word "swamp" mid-sentence ("swamp model becomes a table", "swamp container to
 * several networks"). Requiring a known group *and* verb is what separates a
 * real invocation from such a line. A `null` value means the group takes no
 * sub-verb (`swamp audit`, `swamp serve`, `swamp init`, `swamp doctor X`).
 */
const KNOWN: Record<string, Set<string> | null> = {
  model: new Set([
    "cancel",
    "create",
    "delete",
    "edit",
    "evaluate",
    "get",
    "list",
    "method",
    "output",
    "search",
    "type",
    "validate",
  ]),
  workflow: new Set([
    "cancel",
    "create",
    "delete",
    "describe",
    "edit",
    "get",
    "history",
    "list",
    "resume",
    "run",
    "search",
    "validate",
  ]),
  data: new Set(["delete", "export", "get", "list", "query", "versions"]),
  extension: new Set([
    "fmt",
    "info",
    "install",
    "list",
    "pull",
    "push",
    "quality",
    "remove",
    "search",
    "source",
    "trust",
    "update",
    "version",
  ]),
  vault: new Set([
    "create",
    "delete",
    "edit",
    "get",
    "list",
    "list-keys",
    "put",
    "read-secret",
    "rename",
    "status",
  ]),
  report: new Set(["delete", "get", "list", "run"]),
  auth: new Set(["login", "logout", "status", "token"]),
  datastore: new Set(["migrate", "setup", "status", "test"]),
  serve: null,
  init: null,
  audit: null,
  doctor: null,
};

/** The verb from a token, treating a flag as "no verb". */
function verbToken(token: string | undefined): string {
  return token && !token.startsWith("-") ? token : "";
}

/**
 * Split a shell-ish line into tokens, honouring single/double quotes.
 *
 * Deliberately small: a command's exact quoting does not matter for matching —
 * only the positional tokens (`model`, `method`, `run`, the method name) do — so
 * quotes are simply stripped from each token.
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** True when a token is a flag (`--input`, `--type=…`) or a bare `-`. */
function isFlag(token: string): boolean {
  return token.startsWith("-");
}

/** The first non-flag token at or after `from`. */
function firstPositional(tokens: string[], from: number): string | undefined {
  for (let i = from; i < tokens.length; i++) {
    if (!isFlag(tokens[i])) return tokens[i];
  }
  return undefined;
}

/** Normalize a name for matching: lower-case, strip quotes and a trailing `,`. */
export function normalizeName(value: string): string {
  return value.replace(/^["']|["',]$/g, "").toLowerCase();
}

/**
 * Parse the first `swamp …` invocation in a line into a {@link CommandRef}.
 *
 * Returns `null` when the line does not begin a swamp invocation. Only the first
 * line of a multi-line command is parsed: line continuations carry flags, not a
 * new command.
 */
export function parseSwampCommand(line: string): CommandRef | null {
  const trimmed = line.replace(/^\s*\$#?\s*/, "");
  if (!SWAMP_INVOCATION.test(line)) return null;
  const tokens = tokenize(trimmed);
  if (tokens[0] !== "swamp") return null;
  const group = tokens[1] ?? "";
  if (!group || !(group in KNOWN)) return null;
  const knownVerbs = KNOWN[group];
  // `swamp model <@type> method run …` puts a type before the verb; treat the
  // token after it as the verb for validation.
  const rawVerb = verbToken(tokens[2]);
  const verb = rawVerb.startsWith("@") && verbToken(tokens[3])
    ? verbToken(tokens[3])
    : rawVerb;
  if (knownVerbs && !knownVerbs.has(verb)) return null;

  const ref: CommandRef = {
    command: trimmed.replace(/\\\s*$/, "").trimEnd(),
    group,
    verb: "",
  };

  if (group === "model") {
    let verb = tokens[2] ?? "";
    // `swamp model <type> method run …` — a type before the `method` keyword.
    if (verb.startsWith("@") && tokens[3] === "method") {
      ref.type = verb;
      verb = tokens[3] ?? "";
    }
    ref.verb = verb;
    if (verb === "method") {
      // Two accepted forms, which swap the first two positionals:
      //   swamp model <instance> method run <method> [--input …]
      //   swamp model <@type> method run <method> <instance>
      const runIdx = tokens.indexOf("run", 2);
      if (runIdx >= 0) {
        if (ref.type) {
          ref.method = tokens[runIdx + 1];
          ref.instance = firstPositional(tokens, runIdx + 2);
        } else {
          ref.instance = tokens[runIdx + 1];
          ref.method = firstPositional(tokens, runIdx + 2);
        }
      }
    } else if (verb === "create") {
      const first = firstPositional(tokens, 3);
      const typeFlagIdx = tokens.findIndex((t) => t.startsWith("--type"));
      if (first && first.startsWith("@")) {
        ref.type = first;
        ref.instance = firstPositional(tokens, 4);
      } else if (typeFlagIdx >= 0) {
        ref.instance = first;
        const value = tokens[typeFlagIdx].includes("=")
          ? tokens[typeFlagIdx].split("=").slice(1).join("=")
          : tokens[typeFlagIdx + 1];
        if (value) ref.type = value;
      } else {
        ref.instance = first;
      }
    } else if (verb === "get" || verb === "edit" || verb === "delete") {
      const first = firstPositional(tokens, 3);
      if (first && first.startsWith("@")) ref.type = first;
      else ref.instance = first;
    }
    return ref;
  }

  if (group === "workflow") {
    ref.verb = tokens[2] ?? "";
    if (
      ["run", "validate", "create", "describe", "resume"].includes(ref.verb)
    ) {
      const name = firstPositional(tokens, 3);
      if (name) ref.workflow = name;
    }
    return ref;
  }

  ref.verb = tokens[2] ?? "";
  return ref;
}

/** Extract every distinct `swamp …` invocation from a block of text. */
export function extractCommands(text: string): CommandRef[] {
  const out: CommandRef[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const ref = parseSwampCommand(line);
    if (!ref) continue;
    const key = documentationKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * The normalized matching key for a command.
 *
 * Commands that differ only by instance name collapse to the same key, so a
 * documented `… run my-caddy installCaddy` is matched by a test running
 * `… run e2e-caddy installCaddy`. The method name (and workflow name) is the
 * discriminator; everything else is structural.
 */
export function documentationKey(ref: CommandRef): string {
  if (ref.group === "model" && ref.verb === "method" && ref.method) {
    return `model.method.${normalizeName(ref.method)}`;
  }
  if (ref.group === "model") return `model.${normalizeName(ref.verb)}`;
  if (ref.group === "workflow") {
    return ref.workflow
      ? `workflow.${normalizeName(ref.verb)}.${normalizeName(ref.workflow)}`
      : `workflow.${normalizeName(ref.verb)}`;
  }
  return `${ref.group}.${normalizeName(ref.verb)}`;
}

/**
 * Every distinct `swamp …` command the tests' steps invoke, as written.
 *
 * Deduplicated by {@link documentationKey} so the same method bound to two
 * instances counts once; the first literal line seen wins.
 */
export function testCommands(tests: TestSpec[]): CommandRef[] {
  const seen = new Map<string, CommandRef>();
  for (const t of tests) {
    for (const step of t.steps) {
      for (const ref of extractCommands(step.run)) {
        const key = documentationKey(ref);
        if (!seen.has(key)) seen.set(key, ref);
      }
    }
  }
  return [...seen.values()];
}

/** Every distinct documented command's normalized key, sorted. */
export function testCommandKeys(tests: TestSpec[]): string[] {
  return testCommands(tests).map(documentationKey).sort();
}

/** Compute the coverage of a documented command set by the tests. */
export function computeCoverage(opts: {
  /** Raw manifest `description:` text. */
  description: string;
  /** Parsed acceptance tests. */
  tests: TestSpec[];
  /** Declared model types and their methods. */
  typeMethods: TypeMethods[];
  /** Declared workflow names. */
  workflows: string[];
}): CoverageReport {
  const documented = extractCommands(opts.description);
  const tested = testCommands(opts.tests);
  const testedKeys = new Set(tested.map(documentationKey));

  const documentedCovered: string[] = [];
  const uncoveredCommands: string[] = [];
  for (const ref of documented) {
    const line = ref.command.trim();
    if (testedKeys.has(documentationKey(ref))) documentedCovered.push(line);
    else uncoveredCommands.push(line);
  }

  // A model method is covered when any test runs that method name, regardless of
  // the type the manifest shows and the instance the test binds.
  const coveredMethodNames = new Set(
    tested
      .filter((r) => r.group === "model" && r.method)
      .map((r) => normalizeName(r.method!)),
  );
  const coveredWorkflows = new Set(
    tested
      .filter((r) => r.group === "workflow" && r.verb === "run" && r.workflow)
      .map((r) => normalizeName(r.workflow!)),
  );

  const methods: string[] = [];
  const methodsCovered: string[] = [];
  for (const tm of opts.typeMethods) {
    for (const name of tm.methods) {
      const label = `${tm.type}.${name}`;
      methods.push(label);
      if (coveredMethodNames.has(normalizeName(name))) {
        methodsCovered.push(label);
      }
    }
  }
  const workflows = [...opts.workflows].sort();
  const workflowsCovered = workflows.filter((w) =>
    coveredWorkflows.has(normalizeName(w))
  );

  const byName = (a: string, b: string) => a.localeCompare(b);
  return {
    testCount: opts.tests.length,
    testCommands: tested.map((r) => r.command.trim()).sort(byName),
    documentedCommands: documented.map((r) => r.command.trim()).sort(byName),
    documentedCovered: documentedCovered.sort(byName),
    uncoveredCommands: uncoveredCommands.sort(byName),
    surface: {
      types: opts.typeMethods.length,
      methods: methods.sort(byName),
      methodsCovered: methodsCovered.sort(byName),
      workflows,
      workflowsCovered,
    },
  };
}
