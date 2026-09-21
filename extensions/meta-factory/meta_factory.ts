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
import { lintManifest, renderManifestLint } from "./manifest-lint.ts";
import { lintReadme, renderReadmeLint } from "./readme-lint.ts";
import {
  discoverManifests,
  extractMethodKeysFromSource,
  extractTypeFromSource,
  type ManifestEntry,
  sanitizeInstanceName,
} from "./introspect.ts";

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

/** Union of every resource spec this model can write. */
export type MetaFactoryData = z.infer<typeof ScoreSchema>;

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<CmdResult> {
  try {
    const proc = new Deno.Command(bin, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/**
 * Resolve the bundled deno binary path via `swamp doctor extensions --json`.
 *
 * Falls back to the documented install location when the probe fails.
 */
export async function resolveDenoPath(): Promise<string> {
  const res = await run("swamp", ["doctor", "extensions", "--json"]);
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

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

/** Subprocess dependencies resolved once per `check`/`checkAll` run. */
interface ScoreDeps {
  denoPath: string;
  offline: boolean;
}

/** Resolve a manifest path to an absolute path. */
function absManifest(path: string, cwd: string): string {
  return resolve(cwd, path);
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

  const json = await run(deps.denoPath, ["doc", "--json", ...entrypoints]);
  let docJson: unknown;
  if (json.code === 0 && json.stdout.trim()) {
    try {
      docJson = JSON.parse(json.stdout);
    } catch {
      docJson = undefined;
    }
  }
  const lint = await run(deps.denoPath, ["doc", "--lint", ...entrypoints]);
  return { docJson, lintStdout: lint.stdout };
}

/** Optionally run `swamp extension quality` for the dependency-trust signal. */
async function runQualityAudit(
  deps: ScoreDeps,
  manifestPath: string,
): Promise<{ audited: boolean; passed: boolean; detail: string }> {
  if (deps.offline) {
    return { audited: false, passed: false, detail: "offline mode" };
  }
  const res = await run("swamp", [
    "extension",
    "quality",
    manifestPath,
    "--json",
  ], dirname(manifestPath));
  if (res.code !== 0 || !res.stdout.trim()) {
    return {
      audited: false,
      passed: false,
      detail: "`swamp extension quality` did not return a report",
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
        detail: "no dependencyTrust field",
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
export async function scoreManifest(
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

  const result = scoreExtension({
    manifest,
    manifestPath: path,
    manifestSource: text,
    readme,
    types,
    methodsByType,
    docJson,
    lintStdout,
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
  version: "2026.09.21.1",
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
  },
  methods: {
    check: {
      description:
        "Score one extension manifest (0–100) and write the breakdown",
      arguments: CheckArgsSchema,
      execute: async (
        args: z.infer<typeof CheckArgsSchema>,
        context: ExecContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps: ScoreDeps = {
          denoPath: await resolveDenoPath(),
          offline: args.offline ?? context.globalArgs.offline,
        };
        const path = absManifest(args.manifest, context.repoDir);
        context.logger?.info("Scoring {path}", { path });
        const result = await scoreManifest(path, deps);
        const wellDocumented = result.score >= context.globalArgs.threshold;

        const handle = await context.writeResource(
          "score",
          sanitizeInstanceName(result.manifest),
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
        args: z.infer<typeof CheckAllArgsSchema>,
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps: ScoreDeps = {
          denoPath: await resolveDenoPath(),
          offline: args.offline ?? context.globalArgs.offline,
        };
        const root = resolve(context.repoDir, context.globalArgs.root);
        const entries: ManifestEntry[] = args.manifest
          ? [{
            path: absManifest(args.manifest, context.repoDir),
            dir: dirname(absManifest(args.manifest, context.repoDir)),
            relative: args.manifest,
          }]
          : await discoverManifests(root);

        if (entries.length === 0) {
          throw new Error(`No manifest.yaml found under ${root}`);
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
            sanitizeInstanceName(entry.relative),
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
      ): Promise<{ dataHandles: [{ name: string }] }> => {
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

        const handle = await context.writeResource(
          "score",
          sanitizeInstanceName(relativeTo(context.repoDir, target)),
          {
            name: manifest.name ?? "(unnamed)",
            manifest: target,
            score: 0,
            grade: "F",
            earned: 0,
            earnedMax: 1,
            wellDocumented: false,
            checks: [],
            coverage: [],
            examples: [],
            missing: [],
            nextActions: [
              "Fill in the README sections with real content, then run `check`.",
            ],
            manifestLint: [],
            readmeLint: [],
            checkedAt: new Date().toISOString(),
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
      ): Promise<{ dataHandles: [{ name: string }] }> => {
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
        const written: string[] = [];
        for (const target of targets) {
          await copyDir(sourceDir, target, args.force);
          written.push(target);
          context.logger?.info("Installed skill to {target}", { target });
        }

        const handle = await context.writeResource("summary", "skill-install", {
          root: context.repoDir,
          threshold: context.globalArgs.threshold,
          count: written.length,
          averageScore: 0,
          passCount: written.length,
          failCount: 0,
          belowThreshold: [],
          scores: written.map((w) => ({
            name: skillName,
            manifest: w,
            score: 0,
            grade: "A",
          })),
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
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

/** Re-export lint renderers so reports/tests can use them. */
export { renderManifestLint, renderReadmeLint };
