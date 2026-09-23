/**
 * Meta-factory — the documentation quality gate for swamp extensions.
 *
 * The guiding principle enforced here: **the published manifest plus README
 * must be enough for a user or agent to easily learn how to do everything the
 * published extension does.** This model turns that principle into a
 * deterministic, repeatable score.
 *
 * Methods:
 *   - `check`         — score one extension manifest (0–100) and write the
 *                       full breakdown as a `score` resource.
 *   - `checkAll`      — discover every `manifest.yaml` under a root and score
 *                       each; writes one `score` resource per extension plus a
 *                       `summary` rollup.
 *   - `scaffold`      — write a contract-conformant README skeleton beside a
 *                       manifest (never overwrites unless `force`).
 *   - `lintDefinitions` — check every model/workflow/vault config was created
 *                       by its swamp creation command (generated, unique `id`)
 *                       rather than hand-written or copied; writes a
 *                       `definitions` resource.
 *   - `installSkill`  — install/refresh the bundled `extension-docs` skill into
 *                       the project (`<repo>/.agents/skills`) and/or the user's
 *                       global skill directory.
 *
 * The deterministic checks live in `quality-rubric.ts` (scoring),
 * `readme-lint.ts` and `manifest-lint.ts` (structure), and `introspect.ts`
 * (discovery). This file only orchestrates I/O, subprocesses, and data writes.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, extname, join, resolve } from "jsr:@std/path@1";
import {
  type Manifest,
  parseManifest,
  renderReadmeTemplate,
  scoreExtension,
  type ScoreResult,
} from "./quality-rubric.ts";
import { lintManifest } from "./manifest-lint.ts";
import { lintReadme } from "./readme-lint.ts";
import {
  type AuditEntry,
  type AuditEvidence,
  type CreationCommand,
  lintDefinitions,
  parseCreationCommands,
} from "./definitions-lint.ts";

export type { AuditEvidence, CreationCommand };

import { type DefinitionIssueSummary } from "./quality-rubric.ts";
import {
  discoverManifests,
  extractMethodKeysFromSource,
  extractTypeFromSource,
  type ManifestEntry,
  manifestsFromGitList,
  sanitizeInstanceName,
} from "./introspect.ts";

export type { ManifestEntry };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  root: z.string().default(".").describe(
    "Directory scanned by `checkAll` for manifest.yaml files (relative to the repo root)",
  ),
  threshold: z.number().int().min(0).max(100).default(75).describe(
    "Minimum score to consider an extension 'well documented'",
  ),
  offline: z.boolean().default(false).describe(
    "Skip the network dependency-trust audit (dependency check gets 50% credit)",
  ),
  skillName: z.string().default("extension-docs").describe(
    "Name of the bundled skill directory installed by `installSkill`",
  ),
  definitionsRoot: z.string().default(".").describe(
    "Repository directory scanned by the creation-command check for hand-written or copied definition configs",
  ),
  auditHours: z.number().int().min(0).default(168).describe(
    "Hours of `swamp audit` history to cross-reference; 0 disables the audit confirmation",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CheckArgsSchema = z.object({
  manifest: z.string().describe("Path to the extension manifest.yaml to score"),
  offline: z.boolean().optional().describe("Override the global offline flag"),
});

const CheckAllArgsSchema = z.object({
  manifest: z.string().optional().describe(
    "Score only this manifest instead of scanning the whole root",
  ),
  offline: z.boolean().optional().describe("Override the global offline flag"),
  writeSummary: z.boolean().default(true).describe(
    "Also write the `summary` rollup resource",
  ),
  gitOnly: z.boolean().default(false).describe(
    "Score only git-tracked extension manifests, excluding pulled/generated copies",
  ),
});

const ScaffoldArgsSchema = z.object({
  manifest: z.string().describe(
    "Path to the manifest to scaffold a README for",
  ),
  force: z.boolean().default(false).describe(
    "Overwrite an existing README.md instead of refusing",
  ),
});

const InstallSkillArgsSchema = z.object({
  target: z.enum(["project", "global", "both"]).default("both").describe(
    "Where to install the skill directory",
  ),
  force: z.boolean().default(true).describe(
    "Overwrite an existing installed skill",
  ),
});

const LintDefinitionsArgsSchema = z.object({
  scanRoot: z.string().optional().describe(
    "Override the directory scanned for definition configs (default: the global `definitionsRoot`)",
  ),
  auditHours: z.number().int().min(0).optional().describe(
    "Override the hours of `swamp audit` history to cross-reference (default: the global `auditHours`; 0 disables)",
  ),
});

// ---------------------------------------------------------------------------
// Result schemas
// ---------------------------------------------------------------------------

const CheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  earned: z.number(),
  max: z.number(),
  status: z.enum(["pass", "partial", "fail"]),
  note: z.string().optional(),
});

const CoverageSchema = z.object({
  type: z.string().nullable(),
  name: z.string(),
  documented: z.boolean(),
});

const ExampleSchema = z.object({
  source: z.enum(["manifest", "readme"]),
  command: z.string(),
  functional: z.boolean(),
  explained: z.boolean(),
});

/** Resource schema for one extension's documentation score card. */
const ScoreSchema = z.object({
  name: z.string(),
  manifest: z.string(),
  score: z.number(),
  grade: z.string(),
  earned: z.number(),
  earnedMax: z.number(),
  wellDocumented: z.boolean(),
  checks: z.array(CheckSchema),
  coverage: z.array(CoverageSchema),
  examples: z.array(ExampleSchema),
  missing: z.array(z.string()),
  nextActions: z.array(z.string()),
  manifestLint: z.array(z.object({
    severity: z.enum(["error", "warning"]),
    rule: z.string(),
    message: z.string(),
  })),
  readmeLint: z.array(z.object({
    severity: z.enum(["error", "warning"]),
    rule: z.string(),
    message: z.string(),
  })),
  definitionIssues: z.array(z.object({
    severity: z.enum(["error", "warning"]),
    rule: z.string(),
    message: z.string(),
    path: z.string().optional(),
  })).default([]),
  checkedAt: z.string(),
});

/** Resource schema for the checkAll rollup summary. */
const SummarySchema = z.object({
  root: z.string(),
  threshold: z.number(),
  count: z.number(),
  averageScore: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  belowThreshold: z.array(z.object({
    name: z.string(),
    manifest: z.string(),
    score: z.number(),
    topIssues: z.array(z.string()),
  })),
  scores: z.array(z.object({
    name: z.string(),
    manifest: z.string(),
    score: z.number(),
    grade: z.string(),
  })),
  checkedAt: z.string(),
});

/** Resource schema for the standalone definition-config lint. */
const DefinitionsSchema = z.object({
  root: z.string(),
  scanned: z.number(),
  errorCount: z.number(),
  warningCount: z.number(),
  auditAvailable: z.boolean().default(false),
  auditHours: z.number().default(0),
  confirmedCount: z.number().default(0),
  definitions: z.array(z.object({
    path: z.string(),
    kind: z.string(),
    name: z.string().optional(),
    id: z.string().optional(),
    expectedCommand: z.string().optional(),
    ok: z.boolean(),
    createConfirmed: z.boolean().optional(),
  })),
  issues: z.array(z.object({
    path: z.string(),
    severity: z.enum(["error", "warning"]),
    rule: z.string(),
    message: z.string(),
  })),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

/** Default wall-clock budget for any spawned subprocess. */
export const CMD_TIMEOUT_MS = 120_000;

/** Strip ANSI SGR sequences so subprocess output is safe to pattern-match. */
export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Captured result of a spawned subprocess. */
export interface CmdResult {
  /** Decoded standard output. */
  stdout: string;
  /** Decoded standard error (or the failure/timeout description). */
  stderr: string;
  /** Process exit code; `124` on timeout, `127` when the binary could not run. */
  code: number;
}

/**
 * Run a subprocess to completion, bounded by a timeout.
 *
 * `AbortSignal.timeout` ensures a hung `swamp` or `deno` invocation cannot hold
 * the model lock forever. A timeout is reported as exit code `124`; a spawn
 * failure (binary missing) as `127`.
 */
export async function run(
  bin: string,
  args: string[],
  cwd?: string,
  timeoutMs: number = CMD_TIMEOUT_MS,
): Promise<CmdResult> {
  try {
    const proc = new Deno.Command(bin, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out = await proc.output();
    // `deno`/`swamp` colorize their output when attached to a pipe; strip the
    // ANSI escapes so downstream parsers see plain text.
    return {
      stdout: stripAnsi(new TextDecoder().decode(out.stdout)),
      stderr: stripAnsi(new TextDecoder().decode(out.stderr)),
      code: out.code,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        stdout: "",
        stderr: `timed out after ${timeoutMs}ms`,
        code: 124,
      };
    }
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/** A subprocess runner, injectable so tests can stub external commands. */
export type RunFn = (
  bin: string,
  args: string[],
  cwd?: string,
) => Promise<CmdResult>;

/**
 * Resolve the bundled deno binary path via `swamp doctor extensions --json`.
 *
 * Falls back to the documented install location when the probe fails.
 */
export async function resolveDenoPath(runFn: RunFn = run): Promise<string> {
  const res = await runFn("swamp", ["doctor", "extensions", "--json"]);
  if (res.code === 0) {
    try {
      const parsed = JSON.parse(res.stdout) as { denoPath?: string };
      if (parsed.denoPath) return parsed.denoPath;
    } catch {
      // fall through
    }
  }
  const home = Deno.env.get("HOME") ?? "";
  return join(home, ".swamp", "deno", "deno");
}

/**
 * Gather definition-creation evidence from the `swamp audit` timeline.
 *
 * `swamp audit --hours <n> --json` returns the commands that ran in the window,
 * each tagged with a `source` and a `summary`. The factory only consumes that
 * public output — it never inspects where or how the timeline is stored, so the
 * storage format can change freely.
 *
 * Failure is non-fatal: a missing timeline (no audit hook, empty log, or a
 * non-zero exit) yields `available: false`, and no `create-unconfirmed` warning
 * is raised, because the absence of a log is not evidence that a command did
 * not run. `noise` is disabled (`--all`) so every create command is visible.
 */
export async function runAuditTimeline(
  runFn: RunFn,
  hours: number,
  cwd?: string,
): Promise<AuditEvidence> {
  const res = await runFn(
    "swamp",
    ["audit", "--hours", String(hours), "--all", "--json"],
    cwd,
  );
  if (res.code === 124) {
    return {
      available: false,
      hours,
      commands: [],
      detail: "`swamp audit` timed out",
    };
  }
  if (!res.stdout.trim()) {
    return {
      available: false,
      hours,
      commands: [],
      detail: "no `swamp audit` timeline available",
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as {
      entries?: AuditEntry[];
      message?: string;
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    if (entries.length === 0) {
      return {
        available: false,
        hours,
        commands: [],
        detail: parsed.message ?? "audit timeline is empty",
      };
    }
    // The judgeable window is the overlap of "the last `hours`" with "what the
    // timeline actually covers". The audit returns only its retained entries, so
    // asking for more hours than are retained must not widen the window past the
    // oldest entry — a definition created before the timeline starts is
    // unverifiable, not suspicious, and widening would produce false positives.
    const requestedStart = Date.now() - hours * 3600_000;
    const entryTimes = entries
      .map((e) => Date.parse(e.timestamp ?? ""))
      .filter((t) => Number.isFinite(t));
    const earliestEntry = entryTimes.length > 0
      ? Math.min(...entryTimes)
      : requestedStart;
    return {
      available: true,
      hours,
      windowStartMs: Math.max(requestedStart, earliestEntry),
      commands: parseCreationCommands(entries),
      detail: `${entries.length} audit entries`,
    };
  } catch {
    return {
      available: false,
      hours,
      commands: [],
      detail: "unparseable `swamp audit` output",
    };
  }
}

/**
 * List the git-tracked extension manifests under `root`.
 *
 * Uses `git ls-files`, so only files committed to the repository are returned
 * — an extension that was pulled or generated into the working tree (for
 * example under `.swamp/`) is deliberately excluded. Returns `null` when the
 * directory is not a git repository or `git` is unavailable, so callers can
 * fall back to a filesystem walk rather than reporting zero extensions.
 *
 * @param root Absolute directory to list, relative to the git top level.
 */
export async function discoverGitManifests(
  runFn: RunFn,
  root: string,
): Promise<ManifestEntry[] | null> {
  const res = await runFn(
    "git",
    ["ls-files", "--", "*manifest.yaml"],
    root,
  );
  if (res.code !== 0) return null;
  const listed = res.stdout.split("\n").filter((l) => l.trim().length > 0);
  return manifestsFromGitList(root, listed);
}

/**
 * Discover extension manifests for `checkAll`.
 *
 * With `gitOnly`, only git-tracked manifests are scored (pulled/generated
 * copies are excluded); when git is unavailable the filesystem walk is used so
 * the run still produces a result rather than silently scoring nothing.
 */
async function discoverEntries(
  gitOnly: boolean,
  runFn: RunFn,
  root: string,
): Promise<ManifestEntry[]> {
  if (gitOnly) {
    const tracked = await discoverGitManifests(runFn, root);
    if (tracked !== null) return tracked;
  }
  return await discoverManifests(root);
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

/** Subprocess dependencies resolved once per `check`/`checkAll` run. */
interface ScoreDeps {
  denoPath: string;
  offline: boolean;
  /** Root scanned once for definition-config issues (creation-command rule). */
  definitionsRoot: string;
  /** Hours of `swamp audit` history to cross-reference (0 disables the audit). */
  auditHours: number;
  /** Cached repo definition scan, shared across every manifest scored. */
  definitionsCache?: DefinitionScanCache;
  /** Injectable subprocess runner (defaults to the real {@link run}). */
  run?: RunFn;
}

/** Lazily-computed repo-wide definition scan, shared across a `checkAll`. */
interface DefinitionScanCache {
  promise: Promise<Awaited<ReturnType<typeof lintDefinitions>>>;
}

/**
 * Build (once) or reuse the repo-wide definition scan for a set of deps.
 *
 * The scan is identical for every manifest an extension `checkAll` scores, so
 * caching it on `deps` avoids rescanning the whole repo N times. The `swamp
 * audit` timeline is fetched once here and shared with the scan.
 */
function definitionsScan(deps: ScoreDeps): DefinitionScanCache {
  if (!deps.definitionsCache) {
    deps.definitionsCache = {
      promise: (async () => {
        const audit = deps.auditHours > 0
          ? await runAuditTimeline(
            deps.run ?? run,
            deps.auditHours,
            deps.definitionsRoot,
          )
          : { available: false, hours: 0, commands: [] };
        return await lintDefinitions(deps.definitionsRoot, { audit });
      })(),
    };
  }
  return deps.definitionsCache;
}

/**
 * Definition-config issues for the files owned by one extension.
 *
 * Only issues whose path sits under the manifest's directory are attributed to
 * the extension, so scoring one extension never reports another's problems.
 */
async function definitionIssuesFor(
  deps: ScoreDeps,
  manifestDir: string,
): Promise<DefinitionIssueSummary[]> {
  const scan = await definitionsScan(deps).promise;
  const prefix = relativeTo(deps.definitionsRoot, resolve(manifestDir));
  const under = prefix.length > 0 ? `${prefix}/` : "";
  return scan.issues
    .filter((i) => i.path === prefix || i.path.startsWith(under))
    .map(({ severity, rule, message, path }) => ({
      severity,
      rule,
      message,
      path,
    }));
}

/** Resolve a manifest path to an absolute path. */
function absManifest(path: string, cwd: string): string {
  return resolve(cwd, path);
}

/**
 * Canonical resource instance name for a manifest.
 *
 * Every method keys `score` resources the same way — the manifest path relative
 * to the repo root — so `check` and `checkAll` address the same extension rather
 * than leaving two divergent records.
 */
function scoreInstanceName(repoDir: string, manifestPath: string): string {
  return sanitizeInstanceName(
    relativeTo(repoDir, resolve(manifestPath)),
  );
}

/**
 * Read declared model files, extracting each model `type` and its method names.
 *
 * Returns the union of declared artifact-type strings plus per-type methods,
 * used by the README coverage check.
 */
async function collectArtifacts(
  manifest: Manifest,
  manifestDir: string,
): Promise<{ types: string[]; methodsByType: Record<string, string[]> }> {
  const types: string[] = [];
  const methodsByType: Record<string, string[]> = {};
  const sourceFiles = [
    ...(manifest.models ?? []),
    ...(manifest.vaults ?? []),
    ...(manifest.reports ?? []),
  ];
  for (const file of sourceFiles) {
    if (extname(file) !== ".ts") continue;
    let source = "";
    try {
      source = await Deno.readTextFile(join(manifestDir, file));
    } catch {
      continue;
    }
    const type = extractTypeFromSource(source);
    if (!type) continue;
    if (!types.includes(type)) types.push(type);
    const methods = extractMethodKeysFromSource(source);
    methodsByType[type] = methods.length > 0
      ? methods
      : methodsByType[type] ?? [];
  }
  return { types, methodsByType };
}

/** Run `deno doc` for the declared source entrypoints. */
async function runDenoDoc(
  deps: ScoreDeps,
  manifest: Manifest,
  manifestDir: string,
): Promise<{ docJson: unknown; lintStdout: string }> {
  const runCmd = deps.run ?? run;
  const entrypoints: string[] = [];
  for (
    const file of [
      ...(manifest.models ?? []),
      ...(manifest.vaults ?? []),
      ...(manifest.reports ?? []),
      ...(manifest.datastores ?? []),
    ]
  ) {
    if (extname(file) === ".ts") entrypoints.push(join(manifestDir, file));
  }
  if (entrypoints.length === 0) return { docJson: undefined, lintStdout: "" };

  const json = await runCmd(deps.denoPath, ["doc", "--json", ...entrypoints]);
  let docJson: unknown;
  if (json.code === 0 && json.stdout.trim()) {
    try {
      docJson = JSON.parse(json.stdout);
    } catch {
      docJson = undefined;
    }
  }
  const lint = await runCmd(deps.denoPath, ["doc", "--lint", ...entrypoints]);
  // `deno doc --lint` writes diagnostics to stderr and signals failure through
  // its exit code; stdout is empty. Report the diagnostics only when the command
  // actually failed, so a clean run (which still prints "Checked N files" to
  // stderr) is not mistaken for a violation.
  const diagnostics = lint.code === 0
    ? ""
    : [lint.stderr, lint.stdout].filter((s) => s.trim().length > 0).join("\n");
  return { docJson, lintStdout: diagnostics };
}

/** Outcome of the optional `swamp extension quality` dependency-trust audit. */
interface AuditResult {
  /** True when a report was obtained (even if it reported a failure). */
  audited: boolean;
  /** True only when the audit ran and reported no blocking issues. */
  passed: boolean;
  /** Human-readable explanation of the outcome. */
  detail: string;
}

/**
 * Optionally run `swamp extension quality` for the dependency-trust signal.
 *
 * A report that runs and reports blocking issues is `audited: true, passed:
 * false` (a real fail). A report that could not be obtained at all — offline,
 * spawn failure, timeout, empty/unparseable stdout, or a response missing the
 * `dependencyTrust` field — is `audited: false`, which the scorer treats as a
 * skipped audit (partial credit) rather than a pass.
 */
async function runQualityAudit(
  deps: ScoreDeps,
  manifestPath: string,
): Promise<AuditResult> {
  if (deps.offline) {
    return { audited: false, passed: false, detail: "offline mode" };
  }
  const runCmd = deps.run ?? run;
  const res = await runCmd("swamp", [
    "extension",
    "quality",
    manifestPath,
    "--json",
  ], dirname(manifestPath));
  if (res.code === 124) {
    return {
      audited: false,
      passed: false,
      detail: "`swamp extension quality` timed out",
    };
  }
  // A non-zero exit WITH stdout still carries a report: parse it and let the
  // dependencyTrust verdict decide pass/fail. A non-zero exit with no output is
  // an unavailable audit, not a failure.
  if (res.code !== 0 && !res.stdout.trim()) {
    return {
      audited: false,
      passed: false,
      detail: "`swamp extension quality` did not return a report",
    };
  }
  if (!res.stdout.trim()) {
    return {
      audited: false,
      passed: false,
      detail: "`swamp extension quality` returned empty output",
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as {
      dependencyTrust?: { passed?: boolean; errors?: unknown[] };
      factors?: Array<{ id: string; status: string }>;
    };
    const dt = parsed.dependencyTrust;
    if (!dt) {
      return {
        audited: false,
        passed: false,
        detail: "no dependencyTrust field in the quality report",
      };
    }
    const errors = Array.isArray(dt.errors) ? dt.errors.length : 0;
    return {
      audited: true,
      passed: dt.passed === true,
      detail: dt.passed
        ? "dependency audit passed"
        : `dependency audit failed (${errors} blocking issue(s))`,
    };
  } catch {
    return {
      audited: false,
      passed: false,
      detail: "unparseable quality output",
    };
  }
}

/** Score a single manifest, performing all discovery and subprocess work. */
async function scoreManifest(
  manifestPath: string,
  deps: ScoreDeps,
): Promise<ScoreResult & { lint: { manifest: unknown; readme: unknown } }> {
  const path = manifestPath;
  const manifestDir = dirname(path);
  const text = await Deno.readTextFile(path);
  const manifest = parseManifest(text);

  let readme = "";
  let hasReadme = true;
  try {
    readme = await Deno.readTextFile(join(manifestDir, "README.md"));
  } catch {
    hasReadme = false;
  }

  const { types, methodsByType } = await collectArtifacts(
    manifest,
    manifestDir,
  );
  const { docJson, lintStdout } = await runDenoDoc(deps, manifest, manifestDir);
  const audit = await runQualityAudit(deps, path);
  const definitionIssues = await definitionIssuesFor(deps, manifestDir);

  const result = scoreExtension({
    manifest,
    manifestPath: path,
    manifestSource: text,
    readme,
    types,
    methodsByType,
    docJson,
    lintStdout,
    definitionIssues,
    depsAudited: audit.audited,
    depsPassed: audit.passed,
    depsDetail: audit.detail,
  });

  const manifestLint = lintManifest(manifest, {
    hasReadme,
    source: text,
    fileExists: (rel) => {
      // Declared artifacts resolve relative to the manifest directory.
      // Skills are directories resolved under `.agents/skills/<name>`
      // (manifest-relative for `paths.base: manifest`, which is the layout this
      // extension uses).
      const candidates = [
        join(manifestDir, rel),
        join(manifestDir, ".agents", "skills", rel),
      ];
      return candidates.some((p) => {
        try {
          Deno.statSync(p);
          return true;
        } catch {
          return false;
        }
      });
    },
  });
  const readmeLint = lintReadme(readme, manifest);

  return {
    ...result,
    lint: {
      manifest: manifestLint.issues,
      readme: readmeLint.issues,
    },
  };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

type ExecContext = {
  globalArgs: GlobalArgs;
  repoDir: string;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Model definition for the extension documentation meta-factory. */
export const model = {
  type: "@svendowideit/meta-factory",
  version: "2026.09.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    score: {
      description: "Documentation score for a single extension manifest",
      schema: ScoreSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Rollup across every extension scored by checkAll",
      schema: SummarySchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    definitions: {
      description:
        "Creation-command lint for model/workflow/vault definition configs",
      schema: DefinitionsSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Score one extension manifest (0–100) and write the breakdown",
      arguments: CheckArgsSchema,
      execute: async (
        args: z.infer<typeof CheckArgsSchema> & { _run?: RunFn },
        context: ExecContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps: ScoreDeps = {
          denoPath: await resolveDenoPath(args._run),
          offline: args.offline ?? context.globalArgs.offline,
          definitionsRoot: resolve(
            context.repoDir,
            context.globalArgs.definitionsRoot ?? ".",
          ),
          auditHours: context.globalArgs.auditHours ?? 0,
          run: args._run,
        };
        const path = absManifest(args.manifest, context.repoDir);
        context.logger?.info("Scoring {path}", { path });
        const result = await scoreManifest(path, deps);
        const wellDocumented = result.score >= context.globalArgs.threshold;

        const handle = await context.writeResource(
          "score",
          scoreInstanceName(context.repoDir, path),
          {
            ...result,
            wellDocumented,
            manifestLint: result.lint.manifest,
            readmeLint: result.lint.readme,
            checkedAt: new Date().toISOString(),
          },
        );
        context.logger?.info("Score {score}/100 ({grade}) for {name}", {
          score: result.score,
          grade: result.grade,
          name: result.name,
        });
        return { dataHandles: [handle] };
      },
    },

    checkAll: {
      description:
        "Discover and score every extension manifest under the root; write a summary rollup",
      arguments: CheckAllArgsSchema,
      execute: async (
        args: z.infer<typeof CheckAllArgsSchema> & { _run?: RunFn },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps: ScoreDeps = {
          denoPath: await resolveDenoPath(args._run),
          offline: args.offline ?? context.globalArgs.offline,
          definitionsRoot: resolve(
            context.repoDir,
            context.globalArgs.definitionsRoot ?? ".",
          ),
          auditHours: context.globalArgs.auditHours ?? 0,
          run: args._run,
        };
        const root = resolve(context.repoDir, context.globalArgs.root);
        const entries: ManifestEntry[] = args.manifest
          ? [{
            path: absManifest(args.manifest, context.repoDir),
            dir: dirname(absManifest(args.manifest, context.repoDir)),
            relative: args.manifest,
          }]
          : await discoverEntries(
            args.gitOnly,
            args._run ?? run,
            root,
          );

        if (entries.length === 0) {
          throw new Error(
            args.gitOnly
              ? `No git-tracked manifest.yaml found under ${root}`
              : `No manifest.yaml found under ${root}`,
          );
        }

        const handles: Array<{ name: string }> = [];
        const scores: Array<{
          name: string;
          manifest: string;
          score: number;
          grade: string;
          topIssues: string[];
        }> = [];

        for (const entry of entries) {
          const result = await scoreManifest(entry.path, deps);
          const wellDocumented = result.score >= context.globalArgs.threshold;
          const handle = await context.writeResource(
            "score",
            scoreInstanceName(context.repoDir, entry.path),
            {
              ...result,
              wellDocumented,
              manifestLint: result.lint.manifest,
              readmeLint: result.lint.readme,
              checkedAt: new Date().toISOString(),
            },
          );
          handles.push(handle);
          scores.push({
            name: result.name,
            manifest: result.manifest,
            score: result.score,
            grade: result.grade,
            topIssues: result.nextActions.slice(0, 3),
          });
          context.logger?.info("{name}: {score}/100 ({grade})", {
            name: result.name,
            score: result.score,
            grade: result.grade,
          });
        }

        if (args.writeSummary) {
          const average = Math.round(
            scores.reduce((s, x) => s + x.score, 0) / scores.length,
          );
          const below = scores.filter(
            (s) => s.score < context.globalArgs.threshold,
          );
          const summaryHandle = await context.writeResource(
            "summary",
            "rollup",
            {
              root,
              threshold: context.globalArgs.threshold,
              count: scores.length,
              averageScore: average,
              passCount: scores.length - below.length,
              failCount: below.length,
              belowThreshold: below.map((s) => ({
                name: s.name,
                manifest: s.manifest,
                score: s.score,
                topIssues: s.topIssues,
              })),
              scores: scores.map((s) => ({
                name: s.name,
                manifest: s.manifest,
                score: s.score,
                grade: s.grade,
              })),
              checkedAt: new Date().toISOString(),
            },
          );
          handles.push(summaryHandle);
          context.logger?.info(
            "Scored {count} extension(s): average {avg}/100, {fail} below threshold {t}",
            {
              count: scores.length,
              avg: average,
              fail: below.length,
              t: context.globalArgs.threshold,
            },
          );
        }

        return { dataHandles: handles };
      },
    },

    scaffold: {
      description:
        "Write a contract-conformant README skeleton next to a manifest",
      arguments: ScaffoldArgsSchema,
      execute: async (
        args: z.infer<typeof ScaffoldArgsSchema>,
        context: ExecContext,
      ): Promise<{ dataHandles: [] }> => {
        const path = absManifest(args.manifest, context.repoDir);
        const manifest = parseManifest(await Deno.readTextFile(path));
        const target = join(dirname(path), "README.md");
        const exists = await Deno.stat(target).then(() => true).catch(() =>
          false
        );
        if (exists && !args.force) {
          throw new Error(
            `${target} already exists — pass force=true to overwrite`,
          );
        }
        await Deno.writeTextFile(target, renderReadmeTemplate(manifest));
        context.logger?.info("Wrote README scaffold to {target}", { target });
        // Scaffolding writes no `score` resource: the README is unwritten, so
        // any score would be a misleading placeholder. Run `check` once the
        // README has real content.
        return { dataHandles: [] };
      },
    },

    lintDefinitions: {
      description:
        "Check model/workflow/vault definition configs were created by swamp creation commands, not hand-written or copied",
      arguments: LintDefinitionsArgsSchema,
      execute: async (
        args: z.infer<typeof LintDefinitionsArgsSchema> & { _run?: RunFn },
        context: ExecContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const root = resolve(
          context.repoDir,
          args.scanRoot ?? context.globalArgs.definitionsRoot ?? ".",
        );
        const audit = await runAuditTimeline(
          args._run ?? run,
          args.auditHours ?? context.globalArgs.auditHours ?? 0,
          root,
        );
        const scan = await lintDefinitions(root, { audit });
        const errorCount =
          scan.issues.filter((i) => i.severity === "error").length;
        const warningCount =
          scan.issues.filter((i) => i.severity === "warning").length;
        const handle = await context.writeResource("definitions", "repo", {
          root,
          scanned: scan.scanned,
          errorCount,
          warningCount,
          auditAvailable: audit.available,
          auditHours: audit.hours,
          confirmedCount: scan.definitions.filter((d) =>
            d.createConfirmed === true
          )
            .length,
          definitions: scan.definitions.map((d) => ({
            path: d.path,
            kind: d.kind,
            name: d.name,
            id: d.id,
            expectedCommand: d.expectedCommand,
            ok: d.ok,
            createConfirmed: d.createConfirmed,
          })),
          issues: scan.issues,
          checkedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Scanned {scanned} definition config(s): {errors} error(s), {warnings} warning(s), {confirmed} confirmed by audit",
          {
            scanned: scan.scanned,
            errors: errorCount,
            warnings: warningCount,
            confirmed:
              scan.definitions.filter((d) => d.createConfirmed === true).length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    installSkill: {
      description:
        "Install or refresh the bundled skill into project and/or global skill directories",
      arguments: InstallSkillArgsSchema,
      execute: async (
        args: z.infer<typeof InstallSkillArgsSchema>,
        context: ExecContext,
      ): Promise<{ dataHandles: [] }> => {
        const skillName = context.globalArgs.skillName;
        const home = Deno.env.get("HOME") ?? "";
        const targets: string[] = [];
        if (args.target === "project" || args.target === "both") {
          targets.push(join(context.repoDir, ".agents", "skills", skillName));
        }
        if (args.target === "global" || args.target === "both") {
          targets.push(join(home, ".agents", "skills", skillName));
        }

        // Bundled skill files are readable via the extension's own directory.
        const sourceDir = await resolveBundledSkillDir(
          context.repoDir,
          skillName,
        );
        for (const target of targets) {
          await copyDir(sourceDir, target, args.force);
          context.logger?.info("Installed skill to {target}", { target });
        }
        // Installing a skill is not a documentation score — no `summary` is
        // written, so it cannot be confused with a real checkAll rollup.
        return { dataHandles: [] };
      },
    },
  },
  reports: ["@svendowideit/meta-factory-report"],
};

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function relativeTo(root: string, path: string): string {
  const r = resolve(root);
  const p = resolve(path);
  return p.startsWith(r) ? p.slice(r.length + 1) : p;
}

/** Recursively copy a directory, creating parents as needed. */
async function copyDir(
  src: string,
  dest: string,
  force: boolean,
): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory) {
      await copyDir(s, d, force);
    } else if (entry.isFile) {
      if (!force) {
        const exists = await Deno.stat(d).then(() => true).catch(() => false);
        if (exists) continue;
      }
      await Deno.copyFile(s, d);
    }
  }
}

/**
 * Locate the bundled skill directory.
 *
 * Skills live under `<extension dir>/.agents/skills/<name>/`. For a pulled
 * extension swamp installs them automatically, so this method only needs the
 * source layout; the search walks the repo's `extensions/` tree for a matching
 * manifest and checks the manifest-relative skill path.
 */
async function resolveBundledSkillDir(
  repoDir: string,
  skillName: string,
): Promise<string> {
  const extensionsRoot = join(repoDir, "extensions");
  for (const entry of await discoverManifests(extensionsRoot)) {
    const candidate = join(entry.dir, ".agents", "skills", skillName);
    const ok = await Deno.stat(join(candidate, "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    if (ok) return candidate;
  }
  throw new Error(
    `Bundled skill "${skillName}" not found under ${extensionsRoot}. ` +
      `Expected <extension dir>/.agents/skills/${skillName}/SKILL.md.`,
  );
}
