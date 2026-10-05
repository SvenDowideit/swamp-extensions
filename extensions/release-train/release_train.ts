/**
 * release-train — a read-only dependency and release dashboard for the
 * extensions in this repo.
 *
 * One `analyze` fan-out discovers every git-tracked `manifest.yaml`, reads each
 * extension's declared dependencies, on-disk and published versions, dirty
 * files, hygiene signals, and test coverage (reused from
 * `@svendowideit/meta-factory`), then writes a `node` per extension plus `graph`,
 * `plan`, and `summary` resources and a `release-train.mmd` Mermaid file. It
 * publishes nothing, bumps nothing, and edits no extension.
 *
 * @module
 */
import { dirname, join, relative, resolve } from "jsr:@std/path@1";
import { z } from "npm:zod@4";
import {
  buildGraph,
  buildPlan,
  type ChannelVersions,
  compareCalVer,
  type ExtensionRecord,
  highestKnownVersion,
  type PublishedSource,
} from "./graph.ts";
import {
  type ManifestInfo,
  parseGitLsFiles,
  parseGitStatusPorcelain,
  parseManifest,
  parseModelVersion,
  parseUpgradesToVersion,
  parseUpstreamExtensions,
  parseWorkflowName,
  type ReviewState,
  reviewStateFromWarnings,
  type ReviewWarning,
} from "./introspect.ts";
import {
  type GraphView,
  renderDashboard,
  renderMermaid,
  toNodeView,
} from "./release_train_report.ts";

// Re-exported so the exported `parseRegistryInfo`/`RegistryVersions` signatures
// reference public types (the slow-type check rejects a private reference).
export type { ChannelVersions, PublishedSource } from "./graph.ts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  root: z.string().default("extensions").describe(
    "Directory (relative to the repo root) scanned when git discovery is unavailable.",
  ),
  gitOnly: z.boolean().default(true).describe(
    "Scan only git-tracked manifests (excludes pulled/generated copies under .swamp/).",
  ),
  includeExternal: z.boolean().default(true).describe(
    "Show and query dependencies that are not in this repo as external nodes.",
  ),
  runChecks: z.boolean().default(true).describe(
    "Run the quality/fmt/deno/workflow-validate/push-dry-run hygiene checks in bounded parallel.",
  ),
  concurrency: z.number().int().min(1).max(16).default(4).describe(
    "How many extensions to check in parallel.",
  ),
  checkTimeoutMs: z.number().int().min(5000).max(600000).default(120000)
    .describe(
      "Per-subprocess timeout for hygiene checks; a timeout is recorded as a hygiene issue, never fatal.",
    ),
  offline: z.boolean().default(false).describe(
    "Skip registry lookups and network checks; published versions come from the lockfile only and review state is reported unknown.",
  ),
  threshold: z.number().int().min(0).max(100).default(75).describe(
    "Documentation score below which an extension is advised to stay on beta.",
  ),
  metaModel: z.string().default("meta-factory").describe(
    "Name of the @svendowideit/meta-factory model whose score/summary resources are read for docs score and test coverage.",
  ),
  outputFile: z.string().default("release-train.mmd").describe(
    "Path (relative to the repo root) the Mermaid diagram is written to by `analyze`.",
  ),
  markdownFile: z.string().default("release-train.md").describe(
    "Path (relative to the repo root) the full dashboard is written to as one GitHub/gist-renderable markdown document. Empty disables the write; the same document is always available via `swamp report get @svendowideit/release-train-report --markdown`.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const ChannelVersionsSchema = z.object({
  stable: z.string(),
  rc: z.string(),
  beta: z.string(),
});

const TestsSchema = z.object({
  unitFiles: z.number(),
  unitCoverage: z.number().nullable(),
  unitFunctionCoverage: z.number().nullable(),
  unitCoverageAvailable: z.boolean(),
  acceptanceDeclared: z.boolean(),
  acceptanceCount: z.number().nullable(),
  acceptanceCoveredCommands: z.number(),
  acceptanceDocumentedCommands: z.number(),
  acceptanceMethodsCovered: z.number(),
  acceptanceMethods: z.number(),
  acceptanceWorkflowsCovered: z.number(),
  acceptanceWorkflows: z.number(),
  dataStale: z.boolean(),
});

type Tests = z.infer<typeof TestsSchema>;

const HygieneSchema = z.object({
  manifestModelMatch: z.boolean(),
  upgradesEntry: z.boolean(),
  fmtCheck: z.boolean().nullable(),
  workflowValidate: z.boolean().nullable(),
  docsScore: z.number().nullable(),
  docsGrade: z.string(),
  docsThresholdPass: z.boolean().nullable(),
  reviewState: z.enum(["ok", "stale", "missing", "issues", "unknown"]),
  reviewPath: z.string(),
  issues: z.array(z.string()),
});

type Hygiene = z.infer<typeof HygieneSchema>;

const NodeSchema = z.object({
  name: z.string(),
  dir: z.string(),
  manifestPath: z.string(),
  onDiskVersion: z.string(),
  modelVersion: z.string(),
  upgradesTo: z.string(),
  changed: z.boolean(),
  dirtyFiles: z.array(z.string()),
  published: ChannelVersionsSchema,
  installed: z.object({ version: z.string(), channel: z.string() }),
  needsPublish: z.boolean(),
  publishState: z.enum([
    "up-to-date",
    "needs-publish",
    "blocked",
    "external",
    "unknown",
  ]),
  publishedSource: z.enum(["registry", "cache", "lockfile", "none"]),
  publishedAsOf: z.string(),
  blockers: z.array(z.string()),
  channelAdvice: z.object({
    channel: z.string(),
    reason: z.string(),
    confidence: z.string(),
  }),
  hygiene: HygieneSchema,
  tests: TestsSchema,
  dependencies: z.array(z.string()),
  dependents: z.array(z.string()),
  analyzedAt: z.string(),
});

const GraphSchema = z.object({
  nodes: z.array(z.object({
    name: z.string(),
    onDiskVersion: z.string(),
    publishState: z.string(),
    channelAdvice: z.object({
      channel: z.string(),
      reason: z.string(),
      confidence: z.string(),
    }),
  })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    external: z.boolean(),
  })),
  publishOrder: z.array(z.string()),
  externalNodes: z.array(z.object({
    name: z.string(),
    publishedStable: z.string(),
    publishedBeta: z.string(),
  })),
  cycle: z.array(z.string()),
  generatedAt: z.string(),
});

const PlanSchema = z.object({
  steps: z.array(z.object({
    order: z.number(),
    name: z.string(),
    state: z.enum(["ready", "blocked"]),
    blockers: z.array(z.string()),
    targetChannel: z.string(),
    channelReason: z.string(),
    command: z.string(),
    hygieneFailures: z.array(z.string()),
  })),
  generatedAt: z.string(),
});

const SummarySchema = z.object({
  count: z.number(),
  upToDateCount: z.number(),
  needsPublishCount: z.number(),
  blockedCount: z.number(),
  unknownCount: z.number(),
  externalCount: z.number(),
  /** Extensions whose published versions came from a previous run's cache. */
  cachedCount: z.number(),
  /** Extensions whose published versions came only from the lockfile. */
  lockfileOnlyCount: z.number(),
  hygieneFailureCount: z.number(),
  hygieneFailures: z.array(z.object({ name: z.string(), issue: z.string() })),
  untestedAcceptance: z.array(z.string()),
  staleTestData: z.array(z.string()),
  publishOrder: z.array(z.string()),
  cycle: z.array(z.string()),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

/** Result of a bounded subprocess. */
export interface CmdResult {
  /** Exit code (124 on timeout, 127 on spawn failure). */
  code: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** True when the command exceeded its timeout. */
  timedOut: boolean;
}

/** Run a subprocess. Injectable so tests can stub it. */
export type RunFn = (
  bin: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<CmdResult>;

/**
 * Run a command with a bounded timeout.
 *
 * Exit 124 means timed out and 127 means the binary could not be spawned, so a
 * caller can distinguish "slow" from "absent" without parsing stderr.
 */
export async function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CmdResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const out = await new Deno.Command(bin, {
      args,
      cwd: opts.cwd,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      timedOut: false,
    };
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    return {
      code: timedOut ? 124 : 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the bundled deno binary via `swamp doctor extensions --json`. */
export async function resolveDenoPath(runFn: RunFn): Promise<string> {
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

/** Run `tasks` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Discovery and per-extension gathering
// ---------------------------------------------------------------------------

/** A discovered extension and its parsed manifest. */
export interface Discovered {
  /** Absolute manifest path. */
  abs: string;
  /** Manifest path relative to the repo root. */
  rel: string;
  /** Extension directory relative to the repo root. */
  dir: string;
}

/**
 * Discover extension manifests.
 *
 * `git ls-files` is authoritative when it works; the filesystem walk is the
 * fallback for a non-git checkout. Pulled/generated copies under `.swamp/` and
 * any `node_modules/` path are excluded either way.
 */
export async function discover(
  root: string,
  repoDir: string,
  runFn: RunFn,
): Promise<Discovered[]> {
  const res = await runFn("git", ["ls-files"], {
    cwd: repoDir,
    timeoutMs: 60_000,
  });
  let manifests: string[] = res.code === 0 ? parseGitLsFiles(res.stdout) : [];
  if (manifests.length === 0) {
    const rootAbs = resolve(repoDir, root);
    manifests = walkManifests(rootAbs).map((p) => relative(repoDir, p));
  }
  return manifests.sort().map((rel) => ({
    abs: resolve(repoDir, rel),
    rel,
    dir: dirname(rel),
  }));
}

/** Recursive fallback walk for `manifest.yaml` files. */
function walkManifests(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(current)];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".swamp")) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory) {
        if (entry.name.startsWith(".")) continue;
        stack.push(path);
      } else if (entry.name === "manifest.yaml") {
        out.push(path);
      }
    }
  }
  return out;
}

/** Read another model's latest data. */
type ReadModelData = (
  modelName: string,
  specName?: string,
) => Promise<Array<{ attributes: Record<string, unknown> }>>;

/** Call another model's method. */
type RunModel = (opts: {
  definition?: string;
  modelType?: string;
  name?: string;
  method: string;
  arguments?: Record<string, unknown>;
}) => Promise<
  { ok: true; resources?: unknown[] } | {
    ok: false;
    error: { message: string };
  }
>;

/** The execute context fields release-train uses. */
interface ExecContext {
  globalArgs: GlobalArgs;
  repoDir: string;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  readModelData?: ReadModelData;
  runModel?: RunModel;
}

/**
 * The published versions this extension had in a previous run, if any.
 *
 * `analyze` writes one `node` resource per extension under a deterministic
 * instance name. Reading it back lets an offline run (or one where the registry
 * is unreachable) show the last real answer instead of silence — the caller
 * keeps the `analyzedAt` timestamp so the report can mark it as possibly stale.
 * Only an authoritative prior answer is reused; a prior lockfile-only answer is
 * ignorance and must not be presented as knowledge.
 */
async function priorPublished(
  ctx: ExecContext,
  name: string,
): Promise<{ published: ChannelVersions; asOf: string } | null> {
  if (!ctx.readResource) return null;
  let prior: Record<string, unknown> | null;
  try {
    prior = await ctx.readResource(sanitize(name));
  } catch {
    return null;
  }
  if (!prior || !prior.published || typeof prior.published !== "object") {
    return null;
  }
  // Reuse only if the prior run had authoritative published data
  // (`registry`/`cache`); a prior lockfile-only answer is ignorance.
  const priorSource = str(prior.publishedSource);
  if (priorSource !== "registry" && priorSource !== "cache") return null;
  const p = prior.published as Record<string, unknown>;
  const published: ChannelVersions = {
    stable: str(p.stable),
    rc: str(p.rc),
    beta: str(p.beta),
  };
  // Keep an authoritatively empty answer too: the registry may have said "not
  // found" (a real, reusable fact), and the source check above already
  // guarantees it came from the registry or a prior cache.
  return {
    published,
    asOf: str(prior.analyzedAt) || str(prior.publishedAsOf),
  };
}

/** Docs score and acceptance coverage reused from meta-factory. */
export interface MetaInfo {
  /** Documentation score 0-100, or `null`. */
  docsScore: number | null;
  /** Documentation grade (A-F), or `""`. */
  docsGrade: string;
  /** Whether unit-test line coverage was measurable. */
  coverageAvailable: boolean;
  /** Unit-test line coverage as a 0..1 fraction, or `null`. */
  coverage: number | null;
  /** Fraction of functions with any unit-test coverage, or `null`. */
  functionCoverage: number | null;
  /** Number of acceptance tests the candidate declares, or `null`. */
  acceptanceCount: number | null;
  /** Documented commands the acceptance tests exercise. */
  coveredCommands: number;
  /** Documented commands in the manifest. */
  documentedCommands: number;
  /** Shipped methods the acceptance tests exercise. */
  methodsCovered: number;
  /** Shipped methods total. */
  methods: number;
  /** Shipped workflows the acceptance tests exercise. */
  workflowsCovered: number;
  /** Shipped workflows total. */
  workflows: number;
  /** True when the resource version differs from the on-disk version. */
  dataStale: boolean;
}

const EMPTY_META: MetaInfo = {
  docsScore: null,
  docsGrade: "",
  coverageAvailable: false,
  coverage: null,
  functionCoverage: null,
  acceptanceCount: null,
  coveredCommands: 0,
  documentedCommands: 0,
  methodsCovered: 0,
  methods: 0,
  workflowsCovered: 0,
  workflows: 0,
  dataStale: false,
};

/** Extract docs/coverage fields from a meta-factory score-like object. */
export function metaFromAttributes(
  attrs: Record<string, unknown>,
  onDiskVersion: string,
): MetaInfo {
  if (!attrs || typeof attrs !== "object") return EMPTY_META;
  const version = String(attrs.version ?? "");
  const stale = version !== "" && onDiskVersion !== "" &&
    version !== onDiskVersion;
  const cm = (attrs.codeMetrics ?? {}) as Record<string, unknown>;
  const tc = (attrs.testCoverage ?? {}) as Record<string, unknown>;
  const surface = (tc.surface ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => typeof v === "number" ? v : null;
  const arrLen = (v: unknown): number => Array.isArray(v) ? v.length : 0;
  return {
    docsScore: num(attrs.score),
    docsGrade: String(attrs.grade ?? ""),
    coverageAvailable: cm.coverageAvailable === true,
    coverage: num(cm.coverage),
    functionCoverage: num(cm.functionCoverage),
    acceptanceCount: num(tc.testCount),
    coveredCommands: arrLen(tc.documentedCovered),
    documentedCommands: arrLen(tc.documentedCommands),
    methodsCovered: arrLen(surface.methodsCovered),
    methods: arrLen(surface.methods),
    workflowsCovered: arrLen(surface.workflowsCovered),
    workflows: arrLen(surface.workflows),
    dataStale: stale,
  };
}

/**
 * Count the acceptance tests a candidate declares in its `test-factory.yaml`.
 *
 * A cheap top-level count of `- name:` entries under `tests:`; test-factory
 * remains the authority on whether they pass.
 */
export function countAcceptanceTests(text: string): number {
  const start = text.search(/^tests:\s*$/m);
  if (start < 0) return 0;
  const after = text.slice(start).split("\n").slice(1);
  let count = 0;
  for (const line of after) {
    if (/^\S/.test(line)) break;
    if (/^\s*-\s+name:/.test(line)) count++;
  }
  return count;
}

/** Discover a candidate's `test-factory.yaml` from its `additionalFiles:`. */
function acceptancePath(
  manifestPath: string,
  manifest: ManifestInfo,
): string | null {
  const entry = manifest.additionalFiles.find((f) =>
    f.endsWith("test-factory.yaml")
  );
  return entry ? join(dirname(manifestPath), entry) : null;
}

/**
 * Read meta-factory docs/coverage for one manifest from existing resources.
 *
 * Prefers a per-extension `score` resource (which carries `score`, `grade`,
 * `codeMetrics`, and `testCoverage`). When a `checkAll` run only produced a
 * `summary` rollup, its `scores[]` rows are consulted instead; those rows carry
 * the same `codeMetrics`/`testCoverage` blocks but not the top-level score, so
 * the docs axis stays `null` from a rollup alone.
 */
async function readMeta(
  ctx: ExecContext,
  manifestRel: string,
  onDiskVersion: string,
): Promise<MetaInfo> {
  if (!ctx.readModelData) return EMPTY_META;
  try {
    const records = await ctx.readModelData(ctx.globalArgs.metaModel);
    for (const rec of records) {
      const attrs = rec.attributes ?? {};
      const path = String(attrs.manifest ?? "");
      if (path.endsWith(manifestRel)) {
        return metaFromAttributes(attrs, onDiskVersion);
      }
      // A rollup summary carries per-extension rows in `scores[]`.
      const scores = attrs.scores;
      if (Array.isArray(scores)) {
        for (const row of scores) {
          if (!row || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          if (String(r.manifest ?? "").endsWith(manifestRel)) {
            return metaFromAttributes(r, onDiskVersion);
          }
        }
      }
    }
  } catch {
    // No meta-factory data available — leave the axes unknown.
  }
  return EMPTY_META;
}

/** Published and installed versions for one extension name. */
export interface RegistryVersions {
  /** Latest published version per channel, as far as is known. */
  published: ChannelVersions;
  /** Installed version/channel from the lockfile. */
  installed: { version: string; channel: string };
  /** Where `published` came from, which bounds how far it can be trusted. */
  source: PublishedSource;
  /** ISO timestamp a cached registry answer was observed (source `cache`). */
  asOf?: string;
}

/** Coerce an unknown value to a string. */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse `swamp extension info --json` into per-channel versions.
 *
 * An "Extension not found" response is a real answer (never published): the
 * registry answered, so `known` stays true and every channel is empty.
 */
export function parseRegistryInfo(stdout: string): {
  published: ChannelVersions;
  known: boolean;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { published: { stable: "", rc: "", beta: "" }, known: false };
  }
  if (typeof parsed.error === "string") {
    // "not found in the registry" is authoritative: the extension is
    // unpublished. Any other error (auth, 5xx, network) is not.
    const known = /not found/i.test(parsed.error);
    return { published: { stable: "", rc: "", beta: "" }, known };
  }
  return {
    published: {
      stable: str(parsed.latestVersion),
      rc: str(parsed.latestRc),
      beta: str(parsed.latestBeta),
    },
    known: true,
  };
}

/**
 * The channel a lockfile entry belongs to.
 *
 * The lockfile omits `channel` for extensions pulled from stable (the default),
 * so a missing/empty channel means stable — never drop the version.
 */
function lockChannel(channel: string): "stable" | "rc" | "beta" {
  return channel === "rc" || channel === "beta" ? channel : "stable";
}

/**
 * A cached registry answer from a previous run, keyed by extension name.
 *
 * Supplied by {@link loadPublishedCache}. Used only when this run cannot reach
 * the registry, and always labelled with its observation time.
 */
export type PublishedCache = Record<
  string,
  { published: ChannelVersions; asOf: string }
>;

/** Query the registry (or lockfile when offline) for published versions. */
async function registryVersions(
  name: string,
  ctx: ExecContext,
  runFn: RunFn,
  upstream: Record<string, { version: string; channel: string }>,
  cache: PublishedCache,
): Promise<RegistryVersions> {
  const installed = upstream[name] ?? { version: "", channel: "" };
  const lockChan = lockChannel(installed.channel);
  const fromLock = (): ChannelVersions => ({
    stable: lockChan === "stable" ? installed.version : "",
    rc: lockChan === "rc" ? installed.version : "",
    beta: lockChan === "beta" ? installed.version : "",
  });

  if (ctx.globalArgs.offline) {
    // Offline never queries the registry. Fall back to a previous online run's
    // answer (clearly time-stamped, so stale data reads as stale) before the
    // lockfile lower bound.
    const cached = cache[name];
    if (cached) {
      return {
        published: mergeChannels(cached.published, fromLock()),
        installed,
        source: "cache",
        asOf: cached.asOf,
      };
    }
    const lock = fromLock();
    return {
      published: lock,
      installed,
      source: installed.version ? "lockfile" : "none",
    };
  }

  const info = await runFn("swamp", ["extension", "info", name, "--json"], {
    timeoutMs: ctx.globalArgs.checkTimeoutMs,
  });
  const lock = fromLock();

  // `swamp extension info` writes its result to stdout on success, but writes
  // the `{"error": ...}` JSON to stderr and exits non-zero on failure — so we
  // must inspect both streams. A parsed "not found" is the registry's own
  // (authoritative) answer that the extension is unpublished; anything else —
  // no output, a timeout, a spawn error, an auth/5xx error, bad JSON — means
  // the registry is unreachable, so fall back to a cached answer, then the
  // lockfile lower bound.
  const parsed = parseRegistryInfo(info.stdout);
  const answer = parsed.known ? parsed : parseRegistryInfo(info.stderr);
  if (!answer.known) {
    const cached = cache[name];
    if (cached) {
      return {
        published: mergeChannels(cached.published, lock),
        installed,
        source: "cache",
        asOf: cached.asOf,
      };
    }
    return {
      published: lock,
      installed,
      source: installed.version ? "lockfile" : "none",
    };
  }

  // The registry is authoritative for what it reports; the lockfile fills any
  // channel the registry did not (older published versions remain published).
  return {
    published: mergeChannels(answer.published, lock),
    installed,
    source: "registry",
  };
}

/** Merge two per-channel version sets, preferring `primary` per channel. */
function mergeChannels(
  primary: ChannelVersions,
  fallback: ChannelVersions,
): ChannelVersions {
  return {
    stable: primary.stable || fallback.stable,
    rc: primary.rc || fallback.rc,
    beta: primary.beta || fallback.beta,
  };
}

/** Parse the review warnings out of `push --dry-run --json` output. */
export function extractReviewWarnings(stdout: string): {
  state: "ok" | "stale" | "missing" | "issues" | "unknown";
  path: string;
  note: string;
} {
  try {
    const parsed = JSON.parse(stdout) as {
      reviewRuleWarnings?: ReviewWarning[];
    };
    return reviewStateFromWarnings(parsed.reviewRuleWarnings);
  } catch {
    return { state: "unknown", path: "", note: "" };
  }
}

/** Everything release-train learns about one extension. */
interface Gathered {
  record: ExtensionRecord;
  manifest: ManifestInfo;
  hygiene: Hygiene;
  tests: Tests;
}

/** Name the declared workflows of an extension (for `workflow validate`). */
async function declaredWorkflowNames(
  manifest: ManifestInfo,
  dirAbs: string,
): Promise<string[]> {
  const names: string[] = [];
  for (const file of manifest.workflows) {
    try {
      const src = await Deno.readTextFile(join(dirAbs, file));
      names.push(parseWorkflowName(src) || file.replace(/\.ya?ml$/, ""));
    } catch {
      // unreadable workflow — skip
    }
  }
  return names;
}

/** Count colocated `*_test.ts` files in an extension directory. */
function countUnitTestFiles(dirAbs: string): number {
  try {
    return [...Deno.readDirSync(dirAbs)].filter((e) =>
      e.isFile && e.name.endsWith("_test.ts")
    ).length;
  } catch {
    return 0;
  }
}

/** Gather a single extension's record, hygiene, and test axes. */
async function gatherOne(
  d: Discovered,
  ctx: ExecContext,
  runFn: RunFn,
  upstream: Record<string, { version: string; channel: string }>,
): Promise<Gathered> {
  const g = ctx.globalArgs;
  const manifest = parseManifest(await Deno.readTextFile(d.abs));
  const dirAbs = resolve(ctx.repoDir, d.dir);

  let modelVersion = "";
  let upgradesTo = "";
  for (const file of manifest.models) {
    try {
      const src = await Deno.readTextFile(join(dirAbs, file));
      modelVersion = parseModelVersion(src) || modelVersion;
      upgradesTo = parseUpgradesToVersion(src) || upgradesTo;
    } catch {
      // skip
    }
  }

  const prior = await priorPublished(ctx, manifest.name);
  const cache: PublishedCache = {};
  if (prior) cache[manifest.name] = prior;
  const { published, installed, source, asOf } = await registryVersions(
    manifest.name,
    ctx,
    runFn,
    upstream,
    cache,
  );

  const dirty = await runFn("git", ["status", "--porcelain", "--", d.dir], {
    cwd: ctx.repoDir,
    timeoutMs: 30_000,
  });
  const dirtyFiles = dirty.code === 0
    ? parseGitStatusPorcelain(dirty.stdout)
    : [];

  const meta = await readMeta(ctx, d.rel, manifest.version);
  const issues: string[] = [];

  const manifestModelMatch = modelVersion === "" ||
    modelVersion === manifest.version;
  if (!manifestModelMatch) {
    issues.push(
      `manifest version ${manifest.version} != model version ${modelVersion}`,
    );
  }
  const upgradesEntry = upgradesTo === "" ||
    compareCalVer(upgradesTo, manifest.version) >= 0;
  if (!upgradesEntry) {
    issues.push(`no upgrades entry for ${manifest.version}`);
  }

  // fmt --check
  let fmtCheck: boolean | null = null;
  if (g.runChecks) {
    const fmt = await runFn(
      "swamp",
      ["extension", "fmt", d.rel, "--check"],
      { cwd: ctx.repoDir, timeoutMs: g.checkTimeoutMs },
    );
    fmtCheck = fmt.code === 0;
    if (!fmtCheck) issues.push("swamp extension fmt --check failed");
  }

  // workflow validate
  let workflowValidate: boolean | null = null;
  if (g.runChecks && manifest.workflows.length > 0) {
    const names = await declaredWorkflowNames(manifest, dirAbs);
    for (const wf of names) {
      const v = await runFn("swamp", ["workflow", "validate", wf], {
        cwd: ctx.repoDir,
        timeoutMs: g.checkTimeoutMs,
      });
      const ok = v.code === 0;
      if (workflowValidate === null || !ok) workflowValidate = ok;
      if (!ok) issues.push(`workflow validate failed: ${wf}`);
    }
  }

  // review readiness via push --dry-run
  let reviewState: ReviewState = g.offline ? "unknown" : "unknown";
  let reviewPath = "";
  if (g.runChecks && !g.offline) {
    const dry = await runFn(
      "swamp",
      ["extension", "push", d.rel, "--dry-run", "--json"],
      { cwd: ctx.repoDir, timeoutMs: g.checkTimeoutMs },
    );
    if (dry.code === 0) {
      const review = extractReviewWarnings(dry.stdout);
      reviewState = review.state;
      reviewPath = review.path;
      if (review.state === "missing") {
        issues.push("adversarial review missing/stale");
      } else if (review.state === "issues") {
        issues.push(`adversarial review issue: ${review.note}`);
      }
    } else {
      issues.push("push --dry-run failed");
    }
  }

  const docsThresholdPass = meta.docsScore === null
    ? null
    : meta.docsScore >= g.threshold;
  if (docsThresholdPass === false) {
    issues.push(`docs score ${meta.docsScore} below threshold ${g.threshold}`);
  }

  const testsFile = acceptancePath(d.abs, manifest);
  let acceptanceDeclared = false;
  let acceptanceCount = meta.acceptanceCount;
  if (testsFile) {
    try {
      const declared = countAcceptanceTests(await Deno.readTextFile(testsFile));
      if (declared > 0) {
        acceptanceDeclared = true;
        if (acceptanceCount === null) acceptanceCount = declared;
      }
    } catch {
      // unreadable — leave meta's value
    }
  }

  // Provenance (a cached or lockfile-only published answer) is not a hygiene
  // failure of the extension: it is surfaced through `publishedSource`, the
  // `unknown` publish state, and the report's top-level warning instead. Only a
  // genuine check failure belongs in `issues`.
  const record: ExtensionRecord = {
    name: manifest.name,
    manifestPath: d.rel,
    dir: d.dir,
    onDiskVersion: manifest.version,
    modelVersion,
    upgradesTo,
    dependencies: manifest.dependencies,
    published,
    installed,
    dirtyFiles,
    reviewState,
    docsScore: meta.docsScore,
    hygieneFailures: issues,
    publishedSource: source,
    publishedAsOf: asOf,
  };

  const hygiene: Hygiene = {
    manifestModelMatch,
    upgradesEntry,
    fmtCheck,
    workflowValidate,
    docsScore: meta.docsScore,
    docsGrade: meta.docsGrade,
    docsThresholdPass,
    reviewState,
    reviewPath,
    issues,
  };

  const tests: Tests = {
    unitFiles: countUnitTestFiles(dirAbs),
    unitCoverage: meta.coverage,
    unitFunctionCoverage: meta.functionCoverage,
    unitCoverageAvailable: meta.coverageAvailable,
    acceptanceDeclared,
    acceptanceCount,
    acceptanceCoveredCommands: meta.coveredCommands,
    acceptanceDocumentedCommands: meta.documentedCommands,
    acceptanceMethodsCovered: meta.methodsCovered,
    acceptanceMethods: meta.methods,
    acceptanceWorkflowsCovered: meta.workflowsCovered,
    acceptanceWorkflows: meta.workflows,
    dataStale: meta.dataStale,
  };

  return { record, manifest, hygiene, tests };
}

/** A failed-analysis placeholder that still renders. */
function failedRecord(d: Discovered, err: unknown): Gathered {
  const message = err instanceof Error ? err.message : String(err);
  const record: ExtensionRecord = {
    name: d.rel,
    manifestPath: d.rel,
    dir: d.dir,
    onDiskVersion: "",
    modelVersion: "",
    upgradesTo: "",
    dependencies: [],
    published: { stable: "", rc: "", beta: "" },
    installed: { version: "", channel: "" },
    dirtyFiles: [],
    reviewState: "unknown",
    docsScore: null,
    hygieneFailures: [`analysis failed: ${message}`],
    publishedSource: "none",
  };
  return {
    record,
    manifest: {
      name: d.rel,
      version: "",
      dependencies: [],
      models: [],
      workflows: [],
      reports: [],
      additionalFiles: [],
      description: "",
    },
    hygiene: {
      manifestModelMatch: false,
      upgradesEntry: false,
      fmtCheck: null,
      workflowValidate: null,
      docsScore: null,
      docsGrade: "",
      docsThresholdPass: null,
      reviewState: "unknown",
      reviewPath: "",
      issues: [`analysis failed: ${message}`],
    },
    tests: {
      unitFiles: 0,
      unitCoverage: null,
      unitFunctionCoverage: null,
      unitCoverageAvailable: false,
      acceptanceDeclared: false,
      acceptanceCount: null,
      acceptanceCoveredCommands: 0,
      acceptanceDocumentedCommands: 0,
      acceptanceMethodsCovered: 0,
      acceptanceMethods: 0,
      acceptanceWorkflowsCovered: 0,
      acceptanceWorkflows: 0,
      dataStale: false,
    },
  };
}

/** Load and parse the pulled-extension lockfile, if present. */
async function loadUpstream(
  repoDir: string,
): Promise<Record<string, { version: string; channel: string }>> {
  const candidates = [
    join(repoDir, "extensions", "models", "upstream_extensions.json"),
    join(repoDir, "upstream_extensions.json"),
  ];
  for (const path of candidates) {
    try {
      return parseUpstreamExtensions(await Deno.readTextFile(path));
    } catch {
      // try next
    }
  }
  return {};
}

/** Sanitize an extension name into a data-instance name. */
function sanitize(name: string): string {
  return name.replace(/^@/, "").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

/** Write the Mermaid diagram to `outputFile` under the repo root. */
async function writeMermaid(
  repoDir: string,
  outputFile: string,
  mmd: string,
): Promise<void> {
  await writeText(repoDir, outputFile, mmd);
}

/** Write `content` to `file` (relative to the repo root), creating parents. */
async function writeText(
  repoDir: string,
  file: string,
  content: string,
): Promise<void> {
  const target = resolve(repoDir, file);
  await Deno.mkdir(dirname(target), { recursive: true });
  await Deno.writeTextFile(target, content);
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Model definition for the release-train dashboard. */
export const model = {
  type: "@svendowideit/release-train",
  version: "2026.10.05.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.05.1",
      description:
        "Initial release — dependency and release dashboard across every extension in the repo.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    node: {
      description: "Release and dependency status for one extension",
      schema: NodeSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    graph: {
      description: "Extension dependency graph and topological publish order",
      schema: GraphSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    plan: {
      description: "Ordered publish plan with advisory target channels",
      schema: PlanSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    summary: {
      description: "Rollup across every extension analysed",
      schema: SummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    analyze: {
      description:
        "Discover every extension, build the dependency graph, gather version/hygiene/test status, write the diagram and publish plan",
      arguments: z.object({}),
      execute: async (
        args: { _run?: RunFn },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const started = Date.now();
        const g = context.globalArgs;
        const runFn = args._run ?? run;

        const upstream = await loadUpstream(context.repoDir);
        const discovered = await discover(g.root, context.repoDir, runFn);
        if (discovered.length === 0) {
          throw new Error(
            `No manifest.yaml found (root=${g.root}, gitOnly=${g.gitOnly})`,
          );
        }

        const gathered = await mapLimit(
          discovered,
          g.concurrency,
          async (d) => {
            try {
              return await gatherOne(d, context, runFn, upstream);
            } catch (err) {
              context.logger?.warn("Failed to analyze {path}", {
                path: d.rel,
              });
              return failedRecord(d, err);
            }
          },
        );
        const records = gathered.map((x) => x.record);
        const graph = buildGraph(records);
        const plan = buildPlan(records, graph);

        // Query published versions for external dependency nodes.
        if (g.includeExternal && graph.externalNodes.length > 0) {
          const queried = await mapLimit(
            graph.externalNodes,
            g.concurrency,
            async (ext) => {
              const { published } = await registryVersions(
                ext.name,
                context,
                runFn,
                upstream,
                {},
              ).catch(() => ({
                published: { stable: "", rc: "", beta: "" },
                installed: { version: "", channel: "" },
                source: "none" as const,
              }));
              return {
                name: ext.name,
                publishedStable: published.stable,
                publishedBeta: published.beta,
              };
            },
          );
          graph.externalNodes = queried;
        }

        const localNames = new Set(records.map((r) => r.name));
        const dependents = new Map<string, string[]>();
        for (const r of records) {
          for (const dep of r.dependencies) {
            if (!localNames.has(dep)) continue;
            const list = dependents.get(dep) ?? [];
            list.push(r.name);
            dependents.set(dep, list);
          }
        }
        const stateByName = new Map(
          graph.nodes.map((n) => [n.name, n.publishState]),
        );
        const blockersFor = (r: ExtensionRecord): string[] =>
          r.dependencies.filter((dep) => {
            const s = stateByName.get(dep);
            return s === "needs-publish" || s === "blocked";
          });

        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        const nodeByName = new Map(graph.nodes.map((n) => [n.name, n]));
        const gatheredByName = new Map(gathered.map((x) => [x.record.name, x]));

        const nodeRaws: Array<Record<string, unknown>> = [];
        for (const x of gathered) {
          const r = x.record;
          const node = nodeByName.get(r.name);
          const top = highestKnownVersion(r);
          const data: Record<string, unknown> = {
            name: r.name,
            dir: r.dir,
            manifestPath: r.manifestPath,
            onDiskVersion: r.onDiskVersion,
            modelVersion: r.modelVersion,
            upgradesTo: r.upgradesTo,
            changed: r.dirtyFiles.length > 0 ||
              (r.onDiskVersion !== "" &&
                compareCalVer(r.onDiskVersion, top.version) > 0),
            dirtyFiles: r.dirtyFiles,
            published: r.published,
            installed: r.installed,
            needsPublish: node?.publishState === "needs-publish",
            publishState: node?.publishState ?? "up-to-date",
            publishedSource: r.publishedSource ?? "none",
            publishedAsOf: r.publishedAsOf ?? "",
            blockers: blockersFor(r),
            channelAdvice: node?.channelAdvice ??
              { channel: "", reason: "", confidence: "low" },
            hygiene: x.hygiene,
            tests: x.tests,
            dependencies: r.dependencies,
            dependents: dependents.get(r.name) ?? [],
            analyzedAt: now,
          };
          nodeRaws.push(data);
          handles.push(
            await context.writeResource("node", sanitize(r.name), data),
          );
        }

        const graphRaw: Record<string, unknown> = {
          nodes: graph.nodes.map((n) => ({
            name: n.name,
            onDiskVersion: n.onDiskVersion,
            publishState: n.publishState,
            channelAdvice: n.channelAdvice,
          })),
          edges: graph.edges,
          publishOrder: graph.publishOrder,
          externalNodes: graph.externalNodes,
          cycle: graph.cycle,
          generatedAt: now,
        };
        handles.push(await context.writeResource("graph", "repo", graphRaw));

        const planRaw: Record<string, unknown> = {
          steps: plan,
          generatedAt: now,
        };
        handles.push(await context.writeResource("plan", "plan", planRaw));

        const anyAcceptance = (name: string): boolean => {
          const x = gatheredByName.get(name);
          return (x?.tests.acceptanceCount ?? 0) > 0 ||
            x?.tests.acceptanceDeclared === true;
        };

        const summaryRaw: Record<string, unknown> = {
          count: records.length,
          upToDateCount:
            graph.nodes.filter((n) => n.publishState === "up-to-date").length,
          needsPublishCount:
            graph.nodes.filter((n) => n.publishState === "needs-publish")
              .length,
          blockedCount:
            graph.nodes.filter((n) => n.publishState === "blocked").length,
          unknownCount:
            graph.nodes.filter((n) => n.publishState === "unknown").length,
          externalCount: graph.externalNodes.length,
          cachedCount:
            records.filter((r) => r.publishedSource === "cache").length,
          lockfileOnlyCount:
            records.filter((r) =>
              r.publishedSource === "lockfile" || r.publishedSource === "none"
            ).length,
          hygieneFailureCount:
            records.filter((r) => r.hygieneFailures.length > 0).length,
          hygieneFailures: records.flatMap((r) =>
            r.hygieneFailures.map((issue) => ({ name: r.name, issue }))
          ),
          untestedAcceptance: records
            .filter((r) => !anyAcceptance(r.name))
            .map((r) => r.name),
          staleTestData: gathered
            .filter((x) => x.tests.dataStale)
            .map((x) => x.record.name),
          publishOrder: graph.publishOrder,
          cycle: graph.cycle,
          generatedAt: now,
        };
        handles.push(
          await context.writeResource("summary", "rollup", summaryRaw),
        );

        const nodeViews = nodeRaws.map(toNodeView);
        const mmd = renderMermaid(
          graphRaw as unknown as GraphView,
          nodeViews,
        );
        await writeMermaid(context.repoDir, g.outputFile, mmd);

        if (g.markdownFile) {
          const markdown = renderDashboard(
            nodeRaws,
            graphRaw,
            planRaw,
            summaryRaw,
          );
          await writeText(context.repoDir, g.markdownFile, markdown);
        }

        context.logger?.info(
          "release-train: {count} extensions, {pending} need publishing, {blocked} blocked, {ms}ms",
          {
            count: records.length,
            pending:
              graph.nodes.filter((n) => n.publishState === "needs-publish")
                .length,
            blocked: graph.nodes.filter((n) => n.publishState === "blocked")
              .length,
            ms: Date.now() - started,
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};
