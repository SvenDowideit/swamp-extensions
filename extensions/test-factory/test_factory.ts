/**
 * Test-factory — run a swamp extension in containers, on different Linux
 * distributions and swamp deployment topologies, and report where it breaks.
 *
 * The guiding idea: an extension that scores 100 on documentation can still
 * fail to install, register, define, or run on a given host. This model boots
 * the extension inside a container of the requested distro and topology and
 * checks, in order:
 *
 *   - `smoke`       — swamp installs and `swamp doctor extensions` reports pass;
 *   - `load`        — every declared model type registers;
 *   - `definitions` — `swamp model create` succeeds for each type and every
 *                     declared workflow validates;
 *   - `fixtures`    — caller-supplied method runs execute.
 *
 * Topologies: `standalone` (one node), `serve` (a `swamp serve` orchestrator),
 * and `fleet` (a serve orchestrator plus enrolled worker nodes that execute
 * dispatched workflow steps).
 *
 * Methods:
 *   - `listScenarios` — print the scenario catalog and distros;
 *   - `test`          — run one scenario, or fan out across a filtered set;
 *   - `cleanup`       — remove containers/networks left by a crashed run.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, isAbsolute, join, resolve } from "jsr:@std/path@1";
import {
  distroByName,
  DISTROS,
  resolveScenarios,
  type Scenario,
  type ScenarioFilter,
  scenarioSlug,
  splitList,
} from "./scenarios.ts";
import {
  buildImage,
  dockerVersion,
  ensureImage,
  ensureNetwork,
  ensureVolume,
  exec,
  execDetached,
  listContainers,
  logs,
  removeContainer,
  removeNetwork,
  removeVolume,
  run as defaultRun,
  runDetached,
  type RunFn,
  waitHostFile,
} from "./docker.ts";
import {
  isEmptySystem,
  lintTestSystem,
  parseTestSystem,
  systemVariables,
  type TestSystem,
} from "./services.ts";
import {
  buildHarnessScript,
  DEFAULT_RELEASE_BASE,
  evaluateResult,
  type FixtureRun,
  type HarnessPlan,
  type HarnessResult,
  parseFixtures,
  parseHarnessResult,
  phaseClaims,
} from "./harness.ts";
import { inspectExtension } from "./introspect.ts";
import { lintTests, mergeTests, parseTests } from "./tests.ts";
import type { Expectation, TestSpec, TestStep } from "./tests.ts";
import { computeCoverage, type CoverageReport } from "./coverage.ts";

// Re-exported so the public `preflightTests` signature (and the types nested in
// `TestSpec`) can be named without a `private-type-ref` slow-type diagnostic.
export type { Expectation, TestSpec, TestStep };
import {
  buildProbeRunScript,
  buildServeScript,
  buildTokenScript,
  buildWorkerScript,
  REMOTE_MARKER,
  type TopologyResult,
} from "./topology.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Default vault and secret-entry the factory reads the API key from.
 *
 * The entry name is the environment variable the value is exported as, so it is
 * a public constant, not a secret — kept out of the schema literal so the
 * secret-scanning heuristic does not mistake the name for a value.
 */
const DEFAULT_VAULT = "test-factory-vault";
const DEFAULT_VAULT_ENTRY = "SWAMP_API_KEY";

const GlobalArgsSchema = z.object({
  dockerBinary: z.string().default("docker").describe(
    "Container runtime CLI to drive",
  ),
  swampVersion: z.string().default("").describe(
    "Pin the swamp release tag under test (empty = latest)",
  ),
  releaseBaseUrl: z.string().default(DEFAULT_RELEASE_BASE).describe(
    "Base URL for swamp release downloads",
  ),
  defaultPhases: z.string().default("smoke,load,definitions").describe(
    "Phases run when a scenario does not override them",
  ),
  workers: z.number().int().min(1).max(10).default(2).describe(
    "Default worker count for the `fleet` topology",
  ),
  keepOnFailure: z.boolean().default(false).describe(
    "Leave containers running when a scenario fails, for inspection",
  ),
  probe: z.boolean().default(true).describe(
    "In `serve`/`fleet` scenarios, run the dispatch probe workflow",
  ),
  vault: z.string().default(DEFAULT_VAULT).describe(
    "Name of the vault the factory reads `swampApiKey` from",
  ),
  vaultEntry: z.string().default(DEFAULT_VAULT_ENTRY).describe(
    "Vault entry name read from `vault` and exported as SWAMP_API_KEY",
  ),
  swampApiKey: z.string().default("").meta({ sensitive: true }).describe(
    "swamp-club collective API token exported as SWAMP_API_KEY in every " +
      "container (needed for `swamp serve` on gated hosts). Leave empty to " +
      `read it from the \`vault\`/\`vaultEntry\` globals (default ` +
      `${DEFAULT_VAULT} / ${DEFAULT_VAULT_ENTRY}); a literal is rejected ` +
      "because the field is sensitive — pass a vault expression instead.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const TestArgsSchema = z.object({
  manifest: z.string().describe(
    "Path to the candidate extension manifest.yaml, relative to the repo root",
  ),
  scenario: z.string().default("").describe(
    "Named scenario(s) to run, comma separated (empty = use the filters below)",
  ),
  distro: z.string().default("").describe(
    "Distro name(s) to include, comma separated (e.g. ubuntu,fedora)",
  ),
  topology: z.string().default("").describe(
    "Topology(ies) to include: standalone, serve, fleet",
  ),
  systemd: z.string().default("").describe(
    "true/false to require a systemd or non-systemd host (empty = either)",
  ),
  workers: z.number().int().min(1).max(10).optional().describe(
    "Override the worker count for fleet scenarios",
  ),
  phases: z.string().default("").describe(
    "Phase override: smoke, load, definitions, fixtures",
  ),
  fixturesFile: z.string().default("").describe(
    "Path to a fixtures file (JSON or YAML list) for the `fixtures` phase",
  ),
  scenarioFile: z.string().default("").describe(
    "Path to a scenario file (JSON or YAML list) replacing the catalog",
  ),
  expected: z.string().default("").describe(
    "Override every scenario's expected outcome: pass or fail",
  ),
});

type TestArgs = z.infer<typeof TestArgsSchema>;
type TestAllArgs = z.infer<typeof TestAllArgsSchema>;

const ListArgsSchema = z.object({
  distro: z.string().default("").describe(
    "Only show scenarios for these distro(s), comma separated",
  ),
});

const CleanupArgsSchema = z.object({
  prefix: z.string().default("tf-").describe(
    "Container/network name prefix to clean up",
  ),
});

const CoverageArgsSchema = z.object({
  manifest: z.string().describe(
    "Path to the candidate extension manifest.yaml, relative to the repo root",
  ),
});

const TestAllArgsSchema = TestArgsSchema.extend({
  manifest: z.string().default("").describe(
    "Test only this manifest instead of scanning the root",
  ),
  root: z.string().default("extensions").describe(
    "Directory under the repo root to scan for extension manifests",
  ),
  gitOnly: z.boolean().default(true).describe(
    "Test only git-tracked manifests, excluding pulled/generated copies",
  ),
});

// ---------------------------------------------------------------------------
// Result schemas
// ---------------------------------------------------------------------------

const PhaseSchema = z.object({
  phase: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

/**
 * What a phase proves and the literal commands that prove it.
 *
 * Recorded on every result so a reader can judge whether the test was adequate
 * for their needs *and* whether it actually exercised what it claims — the
 * commands come from the same plan that generated the in-container script.
 */
const PhaseClaimSchema = z.object({
  phase: z.string(),
  claim: z.string(),
  commands: z.array(z.string()),
});

const DefinitionResultSchema = z.object({
  type: z.string(),
  name: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

const WorkflowResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  status: z.string(),
  error: z.string().optional(),
});

const FixtureResultSchema = z.object({
  type: z.string(),
  method: z.string(),
  instance: z.string(),
  code: z.number(),
  ok: z.boolean(),
  matched: z.boolean().nullable(),
  output: z.string(),
});

const TestStepResultSchema = z.object({
  name: z.string(),
  run: z.string(),
  ok: z.boolean(),
  exitCode: z.number(),
  matched: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
});

/** A documented acceptance test's outcome, with its authored prose. */
const TestResultSchema = z.object({
  name: z.string(),
  confirms: z.string(),
  cannot: z.string(),
  ok: z.boolean(),
  steps: z.array(TestStepResultSchema),
});

const TopologySchema = z.object({
  serveReady: z.boolean(),
  workersEnrolled: z.number(),
  workersRequested: z.number(),
  dispatchOk: z.boolean(),
  detail: z.string(),
});

/** Coverage of a candidate's documented and shipped surface by its tests. */
const CoverageSchema = z.object({
  /** Number of documented acceptance tests in `test-factory.yaml`. */
  testCount: z.number().default(0),
  /** Distinct `swamp …` commands the test steps invoke, as written. */
  testCommands: z.array(z.string()).default([]),
  /** Distinct `swamp …` commands the manifest description shows, as written. */
  documentedCommands: z.array(z.string()).default([]),
  /** Documented commands a test step also runs, as written. */
  documentedCovered: z.array(z.string()).default([]),
  /** Documented commands no test step runs, as written. */
  uncoveredCommands: z.array(z.string()).default([]),
  /** Shipped-surface axis: methods/workflows exercised vs declared. */
  surface: z.object({
    types: z.number().default(0),
    /** Every declared method, as `type.method`. */
    methods: z.array(z.string()).default([]),
    /** Declared methods at least one test step runs. */
    methodsCovered: z.array(z.string()).default([]),
    /** Every declared workflow name. */
    workflows: z.array(z.string()).default([]),
    /** Declared workflow names at least one test step runs. */
    workflowsCovered: z.array(z.string()).default([]),
  }).default({
    types: 0,
    methods: [],
    methodsCovered: [],
    workflows: [],
    workflowsCovered: [],
  }),
});

/** Resource schema for the standalone coverage report. */
const CoverageResourceSchema = CoverageSchema.extend({
  manifest: z.string(),
  extension: z.string(),
  version: z.string().default(""),
  checkedAt: z.string(),
});

/** Resource schema for one scenario's outcome. */
const ResultSchema = z.object({
  scenario: z.string(),
  /** The candidate extension's manifest name, e.g. `@acme/thing`. */
  extension: z.string(),
  /** The candidate extension's manifest version. */
  extensionVersion: z.string(),
  /** One line describing what this run set out to prove. */
  intent: z.string(),
  distro: z.string(),
  distroImage: z.string(),
  systemd: z.boolean(),
  topology: z.string(),
  workers: z.number(),
  expected: z.string(),
  ok: z.boolean(),
  status: z.enum(["pass", "fail", "error"]),
  phasesRequested: z.array(z.string()),
  /** What each requested phase claims to prove, and the commands that prove it. */
  claims: z.array(PhaseClaimSchema),
  swampVersion: z.string(),
  installOk: z.boolean(),
  installError: z.string().optional(),
  sourceAddOk: z.boolean(),
  doctorStatus: z.string(),
  /** `systemctl is-system-running` output on a systemd scenario. */
  systemdRunning: z.string().optional(),
  modelTypes: z.array(z.string()),
  missingTypes: z.array(z.string()),
  phases: z.array(PhaseSchema),
  definitions: z.array(DefinitionResultSchema),
  workflows: z.array(WorkflowResultSchema),
  fixtures: z.array(FixtureResultSchema),
  /** Documented acceptance tests (from the candidate's test-factory.yaml). */
  tests: z.array(TestResultSchema),
  /** Documented/shipped-surface coverage of those tests. */
  coverage: CoverageSchema.optional(),
  topologyResult: TopologySchema.optional(),
  errors: z.array(z.string()),
  durationMs: z.number(),
  container: z.string(),
  /** Auxiliary service containers started by the declared test system. */
  serviceContainers: z.array(z.string()).default([]),
  dockerImage: z.string(),
  /** Captured container logs (tail-capped). */
  logs: z.string(),
  /** True when `logs` was capped rather than captured in full. */
  logsTruncated: z.boolean(),
  checkedAt: z.string(),
});

/** Resource schema for the fan-out summary. */
const SummarySchema = z.object({
  manifest: z.string(),
  extension: z.string(),
  version: z.string().default(""),
  count: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  errorCount: z.number(),
  /** Documented acceptance tests run across the fan-out. */
  testCount: z.number().default(0),
  testsPassed: z.number().default(0),
  /** Documented/shipped-surface coverage for this candidate's tests. */
  coverage: CoverageSchema.optional(),
  /** What each requested phase proves, and the commands that prove it. */
  claims: z.array(PhaseClaimSchema).default([]),
  results: z.array(z.object({
    scenario: z.string(),
    distro: z.string(),
    topology: z.string(),
    expected: z.string(),
    ok: z.boolean(),
    status: z.string(),
  })),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Script staging
// ---------------------------------------------------------------------------

/** A staged directory of scripts, mountable read-only into containers. */
interface StagedBundle {
  dir: string;
}

/** Write a set of named scripts into a fresh temp dir (all executable). */
async function stageBundle(
  prefix: string,
  files: Record<string, string>,
): Promise<StagedBundle> {
  const dir = await Deno.makeTempDir({ prefix: `tf-${prefix}-` });
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), content, { mode: 0o755 });
  }
  return { dir };
}

/** Truncate captured output to keep resources readable. */
function tail(text: string, max = 4000): string {
  const t = text.trim();
  return t.length <= max ? t : `…\n${t.slice(t.length - max)}`;
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

/** Resolved dependencies for a `test` run. */
interface Deps {
  dockerBinary: string;
  runFn: RunFn;
  releaseBaseUrl: string;
  swampVersion: string;
  /**
   * swamp-club collective API token exported as `SWAMP_API_KEY` in every
   * container. Empty means unset. Never logged.
   */
  swampApiKey: string;
}

/**
 * The environment every test-factory container is started with.
 *
 * `docker exec` inherits the container's environment, so setting the key once
 * at `docker run` covers the harness, serve, token, worker and probe processes
 * alike — every swamp invocation in the scenario.
 */
export function containerEnv(swampApiKey: string): Record<string, string> {
  const env: Record<string, string> = { SWAMP_TELEMETRY_DISABLED: "1" };
  if (swampApiKey) env.SWAMP_API_KEY = swampApiKey;
  return env;
}

/** The candidate extension under test. */
interface Candidate {
  manifestAbs: string;
  dir: string;
  name: string;
  version: string;
  modelTypes: string[];
  workflowNames: string[];
  /** Documented acceptance tests declared in the candidate's test-factory.yaml. */
  tests: TestSpec[];
  /** Container test system (networks/services) declared in the same file. */
  system: TestSystem;
  /** How much of the documented/shipped surface the tests exercise. */
  coverage: CoverageReport;
}

/** Per-scenario options that do not come from the catalog. */
interface RunOptions {
  phases: string[];
  fixtures: FixtureRun[];
  keepOnFailure: boolean;
  probe: boolean;
  /**
   * Base directory for the host-side output dir the container writes into.
   * Injectable so tests can supply a pre-populated harness result.
   */
  outBaseDir?: string;
  /** Namespace result/summary names by extension (set by `testAll`). */
  scopeByExtension?: boolean;
}

type Result = z.infer<typeof ResultSchema>;

/**
 * One line naming what a scenario set out to prove.
 *
 * Surfaces on every result so a reader sees the intent next to the verdict,
 * rather than having to reconstruct it from the scenario name.
 */
function scenarioIntent(
  scenario: Scenario,
  candidate: Candidate,
  phases: string[],
): string {
  const topo = scenario.topology === "standalone"
    ? "a standalone host"
    : scenario.topology === "serve"
    ? "a swamp serve orchestrator"
    : `a swamp serve orchestrator with ${scenario.workers} enrolled worker(s)`;
  const host = `${scenario.distro}${scenario.systemd ? " + systemd" : ""}`;
  return `Prove ${candidate.name}@${
    candidate.version || "?"
  } installs, registers and behaves on ${host} under ${topo}, across phase(s) ${
    phases.join(", ") || "(none)"
  }.`;
}

/** Build the default (unrun) result for a scenario. */
function blankResult(
  scenario: Scenario,
  candidate: Candidate,
  opts: RunOptions,
  deps: Deps,
  containers: string[],
  plan: HarnessPlan,
): Result {
  return {
    scenario: scenario.name,
    extension: candidate.name,
    extensionVersion: candidate.version,
    intent: scenarioIntent(scenario, candidate, opts.phases),
    distro: scenario.distro,
    distroImage: distroByName(scenario.distro)?.image ?? "",
    systemd: scenario.systemd,
    topology: scenario.topology,
    workers: scenario.workers,
    expected: scenario.expected,
    ok: false,
    status: "error",
    phasesRequested: opts.phases,
    claims: phaseClaims(plan),
    swampVersion: deps.swampVersion,
    installOk: false,
    sourceAddOk: false,
    doctorStatus: "unknown",
    modelTypes: candidate.modelTypes,
    missingTypes: [],
    phases: [],
    definitions: [],
    workflows: [],
    fixtures: [],
    tests: mergeTests(candidate.tests, []),
    // Coverage describes what the tests exercise, so it is only meaningful (and
    // only recorded) when the `tests` phase actually runs.
    coverage: opts.phases.includes("tests") ? candidate.coverage : undefined,
    errors: [],
    durationMs: 0,
    container: containers.join(","),
    serviceContainers: [],
    dockerImage: "",
    logs: "",
    logsTruncated: false,
    checkedAt: new Date().toISOString(),
  };
}

/** Capture container logs with a bound, reporting whether they were capped. */
function captureLogs(
  raw: string,
  max = 4000,
): { logs: string; truncated: boolean } {
  const t = raw.trim();
  return { logs: tail(t, max), truncated: t.length > max };
}

/**
 * Run one scenario end to end.
 *
 * Always returns a result object — a container that cannot even be created is
 * reported as an `error` result rather than thrown, so one bad distro does not
 * abort a whole fan-out.
 */
async function runScenario(
  scenario: Scenario,
  candidate: Candidate,
  opts: RunOptions,
  deps: Deps,
  contextLogger?: ExecContext["logger"],
): Promise<Result> {
  const started = Date.now();
  const distro = distroByName(scenario.distro);
  const slug = scenarioSlug(scenario);
  const suffix = crypto.randomUUID().slice(0, 6);
  const network = `tf-net-${suffix}`;
  const sharedVolume = `tf-shared-${suffix}`;
  const orchestrator = `tf-orch-${slug}-${suffix}`;
  const workerNames = Array.from(
    { length: scenario.topology === "fleet" ? scenario.workers : 0 },
    (_, i) => `tf-w${i + 1}-${slug}-${suffix}`,
  );
  const containers = scenario.topology === "standalone"
    ? [`tf-${slug}-${suffix}`]
    : [orchestrator, ...workerNames];

  const plan: HarnessPlan = {
    swampVersion: scenario.swampVersion ?? deps.swampVersion,
    repoDir: "/work/repo",
    extensionMount: "/opt/ext",
    extensionName: "under-test",
    modelTypes: candidate.modelTypes,
    workflows: candidate.workflowNames,
    phases: opts.phases as HarnessPlan["phases"],
    fixtures: opts.fixtures,
    tests: candidate.tests,
    releaseBaseUrl: deps.releaseBaseUrl,
    expectSystemd: scenario.systemd,
    variables: systemVariables(candidate.system),
    dnsTools: candidate.system.harness.dig,
  };

  const result = blankResult(
    scenario,
    candidate,
    opts,
    deps,
    containers,
    plan,
  );
  const finished = (): Result => {
    result.durationMs = Date.now() - started;
    return result;
  };

  if (!distro) {
    result.errors.push(`unknown distro: ${scenario.distro}`);
    return finished();
  }

  const serveCfg = {
    repoDir: "/work/repo",
    port: 9090,
    sharedDir: "/tf-shared",
    workerCount: workerNames.length,
  };

  // Every script the run might need, in one bundle mounted at /tf-scripts.
  const files: Record<string, string> = {
    "harness.sh": buildHarnessScript(plan),
  };
  if (scenario.topology !== "standalone") {
    files["serve.sh"] = buildServeScript(serveCfg);
    files["tokens.sh"] = buildTokenScript(serveCfg);
    files["probe.sh"] = buildProbeRunScript(
      serveCfg,
      scenario.topology === "fleet",
    );
    workerNames.forEach((_, i) => {
      files[`worker-${i + 1}.sh`] = buildWorkerScript({
        url: "ws://127.0.0.1:9090",
        sharedDir: "/tf-shared",
        index: i + 1,
        labels: { pool: "tf" },
        releaseBaseUrl: plan.releaseBaseUrl,
        swampVersion: plan.swampVersion,
      });
    });
  }

  let bundle: StagedBundle | null = null;
  // The harness writes its result into `/tf`, which is a host directory — so
  // the result survives the container exiting, and no `docker exec` (which
  // fails on an exited container) is needed to read it back.
  let outDir = await Deno.makeTempDir({ prefix: "tf-out-" });
  // In tests (and for a re-run of a kept failure) the output dir can be
  // supplied directly.
  if (opts.outBaseDir) outDir = opts.outBaseDir;
  const resultFile = join(outDir, "result.json");
  const doneFile = join(outDir, "done");
  // The harness waits on the container; without a real container the dir must
  // already contain the sentinel, otherwise we would block for the timeout.
  const hostProvisioned = Boolean(opts.outBaseDir);
  const extMount = `${candidate.dir}:/opt/ext:ro`;
  try {
    const img = await ensureImage(deps.runFn, distro, scenario.systemd);
    result.dockerImage = img.image;
    if (!img.ok) {
      result.errors.push(`image build failed: ${tail(img.buildOutput, 1500)}`);
      return finished();
    }
    bundle = await stageBundle("bundle", files);

    // Containers are started long-lived (systemd as PID 1 on a systemd host,
    // otherwise `sleep infinity`) and every role runs via `docker exec`. This
    // keeps systemd genuinely running, and means roles work identically with or
    // without it.
    const mounts = [
      `${bundle.dir}:/tf-scripts:ro`,
      `${outDir}:/tf`,
      ...(scenario.topology === "standalone"
        ? []
        : [`${sharedVolume}:/tf-shared`]),
      extMount,
    ];
    const target = scenario.topology === "standalone"
      ? containers[0]
      : orchestrator;

    if (scenario.topology !== "standalone") {
      await ensureVolume(deps.runFn, sharedVolume);
      await ensureNetwork(deps.runFn, network);
    }
    // The candidate's declared networks must exist before the harness joins
    // them, so create them first (with their subnets, so static IPs are valid).
    for (const net of candidate.system.networks) {
      await ensureNetwork(
        deps.runFn,
        `tf-net-${slugify(net.name)}-${suffix}`,
        net.subnet,
      );
    }
    // Networks the harness joins: the serve/fleet network plus any declared by
    // the candidate's test system (with their static IPs, so a name can resolve
    // to several harness endpoints).
    const harnessNetworks = [
      ...(scenario.topology === "standalone"
        ? []
        : [{ network, aliases: [] as string[] }]),
      ...candidate.system.harness.networks.map((a) => ({
        network: `tf-net-${slugify(a.network)}-${suffix}`,
        ip: a.ipv4Address || undefined,
        aliases: ["harness"],
      })),
    ];
    const created = await runDetached(deps.runFn, {
      name: target,
      image: img.image,
      systemd: scenario.systemd,
      networks: harnessNetworks.length > 0 ? harnessNetworks : undefined,
      mounts,
      env: containerEnv(deps.swampApiKey),
      labels: scenario.topology === "standalone"
        ? { "tf.scenario": slug }
        : { "tf.scenario": slug, "tf.role": "orchestrator" },
    });
    if (!created.ok) {
      result.errors.push(`container start failed: ${created.output}`);
      return finished();
    }
    // Give systemd a moment to bring up multi-user.target before exec-ing.
    if (scenario.systemd) await sleep(3);
    // Bring up the candidate's auxiliary containers (BIND, tools, ...) and wait
    // for their health before the harness runs. Failures are recorded but do
    // not abort: the report shows the service error alongside the tests.
    if (!isEmptySystem(candidate.system)) {
      const prov = await provisionTestSystem(
        deps,
        candidate,
        suffix,
        contextLogger,
      );
      result.serviceContainers = prov.containers;
      if (prov.error) result.errors.push(prov.error);
    }
    await exec(deps.runFn, target, ["mkdir", "-p", "/tf-shared"]);
    await exec(deps.runFn, target, [
      "/bin/sh",
      "/tf-scripts/harness.sh",
    ], { timeoutMs: 300_000 });
    if (!hostProvisioned) await waitHostFile(doneFile, 180_000);
    const raw = await Deno.readTextFile(resultFile).catch(() => "");

    if (scenario.topology === "standalone") {
      const cap = captureLogs(await logs(deps.runFn, target));
      result.logs = cap.logs;
      result.logsTruncated = cap.truncated;
      finalize(result, raw, scenario, opts, candidate.tests);
      return finished();
    }

    let harnessResult: HarnessResult | null = null;
    try {
      harnessResult = raw.trim() ? parseHarnessResult(raw) : null;
    } catch {
      harnessResult = null;
    }
    finalize(result, raw, scenario, opts, candidate.tests, harnessResult);

    const topology = await runTopology(
      scenario,
      deps,
      orchestrator,
      workerNames,
      img.image,
      sharedVolume,
      bundle.dir,
      opts,
    );
    result.topologyResult = topology;
    if (scenario.expected === "pass" && !topology.serveReady) {
      result.errors.push("serve did not become ready");
    }
    if (
      scenario.expected === "pass" && scenario.topology === "fleet" &&
      topology.workersEnrolled < topology.workersRequested
    ) {
      result.errors.push(
        `only ${topology.workersEnrolled}/${topology.workersRequested} worker(s) enrolled`,
      );
    }
    if (scenario.expected === "pass" && opts.probe && !topology.dispatchOk) {
      result.errors.push("probe workflow did not run through serve");
    }
    const cap = captureLogs([
      await logs(deps.runFn, orchestrator),
      ...(await Promise.all(
        workerNames.map((w) => logs(deps.runFn, w).catch(() => "")),
      )),
    ].join("\n---\n"));
    result.logs = cap.logs;
    result.logsTruncated = cap.truncated;
    result.ok = result.ok && result.errors.length === 0 &&
      topology.serveReady;
    result.status = result.ok ? "pass" : "fail";
    return finished();
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return finished();
  } finally {
    const keep = opts.keepOnFailure && result.errors.length > 0;
    if (!keep) {
      await Promise.all(
        [...containers, ...result.serviceContainers].map((c) =>
          removeContainer(deps.runFn, c).catch(() => {})
        ),
      );
      if (scenario.topology !== "standalone") {
        await removeNetwork(deps.runFn, network).catch(() => {});
        await removeVolume(deps.runFn, sharedVolume).catch(() => {});
      }
      for (const net of candidate.system.networks) {
        await removeNetwork(
          deps.runFn,
          `tf-net-${slugify(net.name)}-${suffix}`,
        ).catch(() => {});
      }
    }
    if (bundle) {
      await Deno.remove(bundle.dir, { recursive: true }).catch(() => {});
    }
    // The host output dir holds the result just read; it is not needed again.
    // An injected dir belongs to the caller, so leave it alone.
    if (!hostProvisioned) {
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * Merge a harness result into a (possibly partially populated) result and
 * evaluate the requested phases. `preParsed` lets the topology path reuse a
 * result already read from the orchestrator.
 */
function finalize(
  result: Result,
  raw: string,
  scenario: Scenario,
  opts: RunOptions,
  tests: TestSpec[],
  preParsed?: HarnessResult | null,
): Result {
  let harness: HarnessResult | null = preParsed ?? null;
  if (!harness) {
    if (!raw.trim()) {
      result.errors.push("harness produced no result (container crashed?)");
      return result;
    }
    try {
      harness = parseHarnessResult(raw);
    } catch (err) {
      result.errors.push(
        `unparseable harness result: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return result;
    }
  }

  const evaluation = evaluateResult(
    harness,
    opts.phases as HarnessPlan["phases"],
    scenario.expected,
    scenario.systemd,
  );
  result.ok = evaluation.ok;
  result.status = evaluation.ok ? "pass" : "fail";
  result.swampVersion = harness.swampVersion || scenario.swampVersion ||
    depsVersionLabel(result);
  result.installOk = harness.installOk;
  result.installError = harness.installError;
  result.sourceAddOk = harness.sourceAddOk;
  result.doctorStatus = harness.doctorStatus;
  result.systemdRunning = harness.systemd;
  result.missingTypes = harness.missingTypes;
  result.phases = evaluation.phases;
  result.definitions = harness.definitions;
  result.workflows = harness.workflows;
  result.fixtures = harness.fixtures;
  result.tests = mergeTests(tests, harness.tests);
  result.errors.push(...evaluation.errors);
  return result;
}

/** A stable placeholder when the installed version could not be read. */
function depsVersionLabel(result: Result): string {
  return result.swampVersion || "unknown";
}

/** Sanitize a value into a docker/network-safe slug. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

/** Resolve a manifest-relative host path to an absolute one. */
function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

/** The docker image tag a service's `build:` context produces. */
export function serviceImageTag(name: string): string {
  return `swamp-test-factory/svc-${slugify(name)}:latest`;
}

/** The container name a service runs under. */
export function serviceContainerName(name: string, suffix: string): string {
  return `tf-svc-${slugify(name)}-${suffix}`;
}

/**
 * Provision the container test system a candidate declares: create its
 * networks, build/start its services, and wait for each healthcheck.
 *
 * Best-effort and never throws: a failure is returned as an error string (with
 * whatever containers were started, so the caller can still tear them down and
 * the logs remain for inspection).
 */
async function provisionTestSystem(
  deps: Deps,
  candidate: Candidate,
  suffix: string,
  logger?: ExecContext["logger"],
): Promise<{ containers: string[]; error: string }> {
  const system = candidate.system;
  const containers: string[] = [];
  for (const net of system.networks) {
    await ensureNetwork(
      deps.runFn,
      `tf-net-${slugify(net.name)}-${suffix}`,
      net.subnet,
    );
  }
  for (const svc of system.services) {
    const container = serviceContainerName(svc.name, suffix);
    let image = svc.image;
    if (svc.build) {
      image = serviceImageTag(svc.name);
      const built = await buildImage(deps.runFn, {
        image,
        contextDir: resolveFrom(candidate.dir, svc.build),
        dockerfile: svc.dockerfile
          ? resolveFrom(candidate.dir, join(svc.build, svc.dockerfile))
          : undefined,
      });
      if (!built.ok) {
        return {
          containers,
          error: `service "${svc.name}" image build failed: ${
            tail(built.output, 1500)
          }`,
        };
      }
    }
    const networks = svc.networks.map((a) => ({
      network: `tf-net-${slugify(a.network)}-${suffix}`,
      ip: a.ipv4Address || undefined,
      aliases: [svc.name],
    }));
    const mounts = svc.mounts.map((m) => {
      const [host, ...rest] = m.split(":");
      return [resolveFrom(candidate.dir, host), ...rest].join(":");
    });
    const created = await runDetached(deps.runFn, {
      name: container,
      image,
      networks,
      privileged: svc.privileged,
      mounts,
      env: { ...containerEnv(deps.swampApiKey), ...svc.environment },
      cmd: svc.command.length > 0 ? svc.command : undefined,
      labels: { "tf.scenario": slugify(svc.name), "tf.role": "service" },
    });
    if (!created.ok) {
      return {
        containers,
        error: `service "${svc.name}" failed to start: ${created.output}`,
      };
    }
    containers.push(container);
    logger?.info(`service ${svc.name}: started (${image})`);
    if (svc.healthcheck) {
      const ready = await waitForHealthcheck(
        deps,
        container,
        svc.healthcheck,
      );
      if (!ready) {
        return {
          containers,
          error: `service "${svc.name}" did not become healthy within ${
            svc.healthcheck.retries * svc.healthcheck.intervalSeconds
          }s`,
        };
      }
    } else if (svc.waitForSeconds > 0) {
      await sleep(svc.waitForSeconds * 1000);
    }
  }
  return { containers, error: "" };
}

/** Poll a container healthcheck command until it exits 0, or run out of retries. */
async function waitForHealthcheck(
  deps: Deps,
  container: string,
  hc: { command: string[]; intervalSeconds: number; retries: number },
): Promise<boolean> {
  for (let i = 0; i < hc.retries; i++) {
    const res = await exec(deps.runFn, container, hc.command, {
      timeoutMs: 30_000,
    });
    if (res.code === 0) return true;
    await sleep(Math.max(1, hc.intervalSeconds) * 1000);
  }
  return false;
}

/**
 * Start serve, mint tokens, enroll workers, and (optionally) run the dispatch
 * probe. Returns a {@link TopologyResult}; never throws for an expected
 * failure — the detail string carries the diagnosis.
 */
async function runTopology(
  scenario: Scenario,
  deps: Deps,
  orchestrator: string,
  workerNames: string[],
  image: string,
  sharedVolume: string,
  bundleDir: string,
  opts: RunOptions,
): Promise<TopologyResult> {
  const out: TopologyResult = {
    serveReady: false,
    workersEnrolled: 0,
    workersRequested: workerNames.length,
    dispatchOk: false,
    detail: "",
  };

  await exec(deps.runFn, orchestrator, ["mkdir", "-p", "/tf-shared"]);

  const serve = await exec(deps.runFn, orchestrator, [
    "/bin/sh",
    "/tf-scripts/serve.sh",
  ], { timeoutMs: 120_000 });
  out.serveReady = /SERVE_READY/.test(serve.stdout);
  if (!out.serveReady) {
    out.detail = tail(`${serve.stdout}\n${serve.stderr}`, 1500);
    return out;
  }

  if (workerNames.length > 0) {
    const tokens = await exec(deps.runFn, orchestrator, [
      "/bin/sh",
      "/tf-scripts/tokens.sh",
    ], { timeoutMs: 120_000 });
    const minted = Number(tokens.stdout.trim().split("\n").pop()) || 0;
    if (minted < workerNames.length) {
      out.detail = `minted ${minted}/${workerNames.length} tokens`;
    }
  }

  // Workers share the orchestrator's network namespace, so they reach the
  // loopback-only serve socket without TLS. Each is a long-lived container and
  // its connect loop runs detached, so the container's own lifecycle is
  // independent of the worker process.
  for (let i = 0; i < workerNames.length; i++) {
    const created = await runDetached(deps.runFn, {
      name: workerNames[i],
      image,
      systemd: scenario.systemd,
      networkContainer: orchestrator,
      mounts: [
        // Workers are separate containers; mount the same host bundle dir.
        `${bundleDir}:/tf-scripts:ro`,
        `${sharedVolume}:/tf-shared`,
      ],
      env: containerEnv(deps.swampApiKey),
      labels: { "tf.scenario": scenarioSlug(scenario), "tf.role": "worker" },
    });
    if (!created.ok) {
      out.detail = `worker start failed: ${created.output}`;
      continue;
    }
    if (scenario.systemd) await sleep(3);
    const started = await execDetached(deps.runFn, workerNames[i], [
      "/bin/sh",
      `/tf-scripts/worker-${i + 1}.sh`,
    ]);
    if (!started.ok) out.detail = `worker exec failed: ${started.output}`;
  }

  // Wait for enrollment by polling the orchestrator.
  if (workerNames.length > 0) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const res = await exec(deps.runFn, orchestrator, [
        "/bin/sh",
        "-c",
        "cd /work/repo && swamp worker list --json 2>/dev/null | jq -r '.count // 0'",
      ]);
      const count = Number(res.stdout.trim()) || 0;
      out.workersEnrolled = count;
      if (count >= workerNames.length) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (opts.probe) {
    const res = await exec(deps.runFn, orchestrator, [
      "/bin/sh",
      "/tf-scripts/probe.sh",
    ], { timeoutMs: 180_000 });
    out.dispatchOk = `${res.stdout}\n${res.stderr}`.includes(REMOTE_MARKER);
    if (!out.dispatchOk) {
      out.detail = tail(`${out.detail}\n${res.stdout}\n${res.stderr}`, 2000);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The slice of swamp's vault service the factory uses. */
export type VaultService = {
  get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  getVaultNames(): string[];
};

type ExecContext = {
  globalArgs: GlobalArgs;
  repoDir: string;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  /** Present when a vault is configured; used to read `swampApiKey`. */
  vaultService?: VaultService;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/**
 * Resolve the API key for a run.
 *
 * Precedence: an explicit `swampApiKey` (a vault expression the operator set)
 * wins; otherwise the key is read from the named `vault` at `vaultEntry` — the
 * default being the `test-factory-vault` / `SWAMP_API_KEY` pair. A missing
 * vault or key is not an error: most runs (standalone scenarios) need no key,
 * so the run proceeds with `SWAMP_API_KEY` unset. The value is never logged.
 */
export async function resolveApiKey(
  context: {
    globalArgs: {
      swampApiKey: string;
      vault: string;
      vaultEntry: string;
    };
    vaultService?: VaultService;
    logger?: {
      warning: (msg: string, props?: Record<string, unknown>) => void;
    };
  },
): Promise<string> {
  const explicit = context.globalArgs.swampApiKey?.trim();
  if (explicit) return explicit;

  const vault = context.globalArgs.vault;
  const key = context.globalArgs.vaultEntry;
  const vs = context.vaultService;
  if (!vs || !vault || !key) return "";
  if (!vs.getVaultNames().includes(vault)) return "";
  try {
    return (await vs.get(vault, key)) ?? "";
  } catch (err) {
    context.logger?.warning(
      `Could not read ${key} from vault ${vault}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "";
  }
}

/** Model definition for the containerised extension test factory. */
export const model = {
  type: "@svendowideit/test-factory",
  version: "2026.10.02.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.01.1",
      description:
        "Read the API key from a named vault: add `vault` (default `test-factory-vault`) and `vaultEntry` (default `SWAMP_API_KEY`) global arguments, and resolve `swampApiKey` from that vault at run time when it is empty. Also guard the colocated test fixtures so swamp's extension loader no longer indexes them as real models. Existing instances are seeded with both new globals.",
      upgradeAttributes: (old: Record<string, unknown>) => ({
        ...old,
        vault: old.vault ?? "test-factory-vault",
        vaultEntry: old.vaultEntry ?? "SWAMP_API_KEY",
      }),
    },
    {
      toVersion: "2026.10.01.2",
      description:
        "Record an audit trail on every result and summary: the candidate extension name and version, a one-line `intent`, and a per-phase `claims` array naming what a PASS proves and the literal commands that prove it. The report renders all of it. These are new fields on the written resources; no schema or argument change to existing fields.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.3",
      description:
        "Add the `tests` phase: an extension can ship a `test-factory.yaml` (listed in its manifest `additionalFiles:`) declaring the user-facing outcomes it promises as prose plus runnable steps with executable pass/fail assertions. The phase is auto-enabled when the candidate ships that file; a lint enforces that every `confirms`/`cannot` claim has a matching positive/negative assertion. Results and summaries gain `tests` with per-step logs and `testCount`/`testsPassed`; the report renders the prose and the full logs. New resources fields only — no change to existing arguments.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.1",
      description:
        "A candidate's `test-factory.yaml` may now declare a container test system — `networks:` (with subnets), `harness:` (the swamp container's own network attachments plus `dig: true`), and `services:` (sibling containers to build/start with healthchecks). The factory creates the networks, starts and health-checks the services, joins the swamp container to the declared networks (a static IP per network lets one name resolve to several endpoints), and exports every declared address to the test steps as `TF_<SERVICE>_IP` / `TF_HARNESS_IP_<NETWORK>`. `@svendowideit/caddy` is the worked example (BIND over RFC2136 + dig/curl). A malformed topology fails loudly before any container boots; a file with no such keys behaves exactly as before. `result` gains `serviceContainers`. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.2",
      description:
        "Report test coverage: how many of a candidate manifest's documented `swamp …` commands, and how many of the methods and workflows it ships, the candidate's `test-factory.yaml` actually exercises. `result` and `summary` gain an optional `coverage` block, the report renders it, and a new docker-free `checkCoverage` method writes a standalone `coverage` resource so another extension (the meta-factory) can read it. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    result: {
      description: "Outcome of testing one extension in one scenario",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Rollup of a test fan-out across scenarios",
      schema: SummarySchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    coverage: {
      description:
        "How much of a candidate's documented and shipped surface its test-factory.yaml exercises",
      schema: CoverageResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    listScenarios: {
      description:
        "List the scenario catalog and the distros available to test on",
      arguments: ListArgsSchema,
      execute: (
        args: z.infer<typeof ListArgsSchema>,
        context: ExecContext,
      ): { dataHandles: [] } => {
        const filter = splitList(args.distro);
        const distros = filter.length > 0
          ? DISTROS.filter((d) => filter.includes(d.name))
          : DISTROS;
        const scenarios = resolveScenarios({ distro: args.distro });
        context.logger?.info(
          "{count} distro(s), {scenarios} catalog scenario(s)",
          { count: distros.length, scenarios: scenarios.length },
        );
        for (const d of distros) {
          context.logger?.info(
            `distro ${d.name} (${d.family})${
              d.runnable ? "" : " [swamp cannot run]"
            }: ${d.notes}`,
          );
        }
        for (const s of scenarios) {
          context.logger?.info(
            `scenario ${s.name}: ${s.distro}/${s.topology}${
              s.systemd ? "+systemd" : ""
            }${s.topology === "fleet" ? ` x${s.workers}` : ""}`,
          );
        }
        return { dataHandles: [] };
      },
    },

    test: {
      description:
        "Run one scenario, or fan out across a filtered set, in containers",
      arguments: TestArgsSchema,
      execute: async (
        args: TestArgs & { _run?: RunFn; _outBaseDir?: string },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        if (!args.manifest) {
          throw new Error("`manifest` is required");
        }
        const deps: Deps = {
          dockerBinary: context.globalArgs.dockerBinary,
          runFn: args._run ?? defaultRun,
          releaseBaseUrl: context.globalArgs.releaseBaseUrl,
          swampVersion: context.globalArgs.swampVersion,
          swampApiKey: await resolveApiKey(context),
        };

        const version = await dockerVersion(deps.runFn);
        if (!version.available) {
          throw new Error(
            `container runtime unavailable (${context.globalArgs.dockerBinary}): ${version.detail}`,
          );
        }

        const candidate = await resolveCandidate(
          args.manifest,
          context.repoDir,
        );
        const scenarios = selectScenarios(args);
        if (scenarios.length === 0) {
          throw new Error("no scenarios matched the filter");
        }

        const phases = resolvePhases(
          args.phases,
          context.globalArgs.defaultPhases,
          candidate.tests.length > 0,
        );
        preflightTests(candidate.tests, phases);
        preflightTestSystem(candidate.system);
        const fixtures = args.fixturesFile
          ? parseFixtures(
            await Deno.readTextFile(
              resolve(context.repoDir, args.fixturesFile),
            ),
          )
          : [];

        const opts: RunOptions = {
          phases,
          fixtures,
          keepOnFailure: context.globalArgs.keepOnFailure,
          probe: context.globalArgs.probe,
          outBaseDir: args._outBaseDir,
        };

        context.logger?.info(
          `Testing ${candidate.name} across ${scenarios.length} scenario(s)`,
        );

        const { handles } = await executeScenarios(
          candidate,
          scenarios,
          opts,
          deps,
          context,
        );
        return { dataHandles: handles };
      },
    },

    testAll: {
      description:
        "Fan out across every git-tracked extension under a root, one scenario set each",
      arguments: TestAllArgsSchema,
      execute: async (
        args:
          & TestAllArgs
          & { _run?: RunFn; _outBaseDir?: string },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps: Deps = {
          dockerBinary: context.globalArgs.dockerBinary,
          runFn: args._run ?? defaultRun,
          releaseBaseUrl: context.globalArgs.releaseBaseUrl,
          swampVersion: context.globalArgs.swampVersion,
          swampApiKey: await resolveApiKey(context),
        };
        const version = await dockerVersion(deps.runFn);
        if (!version.available) {
          throw new Error(
            `container runtime unavailable (${context.globalArgs.dockerBinary}): ${version.detail}`,
          );
        }

        const manifests = await resolveManifests(args, context.repoDir, deps);
        if (manifests.length === 0) {
          throw new Error("no extension manifests found to test");
        }
        const scenarios = selectScenarios(args as unknown as TestArgs);
        if (scenarios.length === 0) {
          throw new Error("no scenarios matched the filter");
        }
        const fixtures = args.fixturesFile
          ? parseFixtures(
            await Deno.readTextFile(
              resolve(context.repoDir, args.fixturesFile),
            ),
          )
          : [];

        context.logger?.info(
          `Sweeping ${manifests.length} extension(s) across ${scenarios.length} scenario(s)`,
        );

        const handles: Array<{ name: string }> = [];
        for (const manifestPath of manifests) {
          const candidate = await resolveCandidate(
            manifestPath,
            context.repoDir,
          );
          // Auto-enable `tests` per candidate, since only some may ship a
          // test-factory.yaml. An explicit `phases` override still wins.
          const phases = resolvePhases(
            args.phases,
            context.globalArgs.defaultPhases,
            candidate.tests.length > 0,
          );
          preflightTests(candidate.tests, phases);
          preflightTestSystem(candidate.system);
          const opts: RunOptions = {
            phases,
            fixtures,
            keepOnFailure: context.globalArgs.keepOnFailure,
            probe: context.globalArgs.probe,
            outBaseDir: args._outBaseDir,
            scopeByExtension: true,
          };
          const { handles: h } = await executeScenarios(
            candidate,
            scenarios,
            opts,
            deps,
            context,
          );
          handles.push(...h);
        }
        return { dataHandles: handles };
      },
    },

    checkCoverage: {
      description:
        "Report how much of a candidate's documented commands and shipped methods/workflows its test-factory.yaml exercises, without running any container",
      arguments: CoverageArgsSchema,
      execute: async (
        args: z.infer<typeof CoverageArgsSchema>,
        context: ExecContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const candidate = await resolveCandidate(
          args.manifest,
          context.repoDir,
        );
        const handle = await context.writeResource(
          "coverage",
          extensionSlug(candidate.name),
          coverageResourceBody(candidate),
        );
        const c = candidate.coverage;
        context.logger?.info(
          `${candidate.name}: ${c.testCount} documented test(s) run ` +
            `${c.testCommands.length} distinct swamp command(s); ` +
            `${c.documentedCovered.length} of the ` +
            `${c.documentedCommands.length} commands shown in the manifest ` +
            `description are run by a test; ` +
            `${c.surface.methodsCovered.length} of the ` +
            `${c.surface.methods.length} declared methods and ` +
            `${c.surface.workflowsCovered.length} of the ` +
            `${c.surface.workflows.length} declared workflows are run by a test`,
        );
        return { dataHandles: [handle] };
      },
    },

    cleanup: {
      description:
        "Remove containers and networks left behind by a crashed run",
      arguments: CleanupArgsSchema,
      execute: async (
        args: z.infer<typeof CleanupArgsSchema>,
        context: ExecContext,
      ): Promise<{ dataHandles: [] }> => {
        const runFn = defaultRun;
        const containers = await listContainers(runFn, "tf.scenario");
        for (const id of containers) {
          await removeContainer(runFn, id);
        }
        const networks = await listNetworkNames(runFn, args.prefix);
        for (const n of networks) await removeNetwork(runFn, n);
        context.logger?.info(
          "Removed {containers} container(s) and {nets} network(s)",
          { containers: containers.length, nets: networks.length },
        );
        return { dataHandles: [] };
      },
    },
  },
  reports: ["@svendowideit/test-factory-report"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a scenario set for one candidate and write every result plus a rollup.
 *
 * Shared by `test` and `testAll`, so the fan-out semantics are identical
 * whether one extension or many are under test.
 */
async function executeScenarios(
  candidate: Candidate,
  scenarios: Scenario[],
  opts: RunOptions,
  deps: Deps,
  context: ExecContext,
): Promise<{ handles: Array<{ name: string }> }> {
  const handles: Array<{ name: string }> = [];
  const summaries: z.infer<typeof SummarySchema>["results"] = [];
  // Documented tests run once per scenario; count both the total and passes so
  // the summary can report `tests N/M passed` alongside the scenario counts.
  let testCount = 0;
  let testsPassed = 0;
  // A `testAll` sweep runs several extensions through the same scenarios, so
  // result and summary instance names are namespaced by extension. A single
  // `test` keeps the bare scenario name so its data is easy to find.
  const extSlug = extensionSlug(candidate.name);
  const scoped = Boolean(opts.scopeByExtension);
  const resultName = (s: Scenario) =>
    scoped ? `${extSlug}-${scenarioSlug(s)}` : scenarioSlug(s);

  // Announce what the run is about to prove before it does it, so the console
  // log is self-describing rather than just a stream of pass/fail lines. The
  // same claims are written to every result and the summary.
  const plannedClaims = phaseClaims({
    swampVersion: deps.swampVersion,
    repoDir: "/work/repo",
    extensionMount: "/opt/ext",
    extensionName: "under-test",
    modelTypes: candidate.modelTypes,
    workflows: candidate.workflowNames,
    phases: opts.phases as HarnessPlan["phases"],
    fixtures: opts.fixtures,
    tests: candidate.tests,
    releaseBaseUrl: deps.releaseBaseUrl,
    expectSystemd: false,
    variables: systemVariables(candidate.system),
  });
  context.logger?.info(
    `${candidate.name}@${
      candidate.version || "?"
    }: about to prove ${plannedClaims.length} phase(s) — ${
      plannedClaims
        .map((c) => c.phase)
        .join(", ")
    }`,
  );
  for (const claim of plannedClaims) {
    context.logger?.info(`  ${claim.phase}: ${claim.claim}`);
  }

  for (const scenario of scenarios) {
    context.logger?.info(
      `${candidate.name} · scenario ${scenario.name}: starting — ${
        scenarioIntent(scenario, candidate, opts.phases)
      }`,
    );
    const result = await runScenario(
      scenario,
      candidate,
      opts,
      deps,
      context.logger,
    );
    const handle = await context.writeResource(
      "result",
      resultName(scenario),
      result,
    );
    handles.push(handle);
    testCount += result.tests.length;
    testsPassed += result.tests.filter((t) => t.ok).length;
    summaries.push({
      scenario: result.scenario,
      distro: result.distro,
      topology: result.topology,
      expected: result.expected,
      ok: result.ok,
      status: result.status,
    });
    const phaseSummary = result.phases
      .map((p) => `${p.phase}:${p.ok ? "ok" : "x"}`)
      .join(" ");
    const logLine =
      `${candidate.name} · scenario ${scenario.name}: ${result.status} (${phaseSummary})`;
    if (result.ok) context.logger?.info(logLine);
    else (context.logger?.warning ?? context.logger?.info)?.(logLine);
  }

  const passCount = summaries.filter((s) => s.ok).length;
  // Every scenario in a run shares the same phases, fixtures, types and
  // workflows, so the summary's claims are built once from a representative
  // plan. `swampVersion` is the resolved global (a scenario may pin otherwise,
  // in which case its own result carries the pinned claim).
  const summaryPlan: HarnessPlan = {
    swampVersion: deps.swampVersion,
    repoDir: "/work/repo",
    extensionMount: "/opt/ext",
    extensionName: "under-test",
    modelTypes: candidate.modelTypes,
    workflows: candidate.workflowNames,
    phases: opts.phases as HarnessPlan["phases"],
    fixtures: opts.fixtures,
    tests: candidate.tests,
    releaseBaseUrl: deps.releaseBaseUrl,
    expectSystemd: false,
    variables: systemVariables(candidate.system),
  };
  const summaryHandle = await context.writeResource(
    "summary",
    scoped ? extSlug : "rollup",
    {
      manifest: candidate.manifestAbs,
      extension: candidate.name,
      version: candidate.version,
      count: summaries.length,
      passCount,
      failCount: summaries.filter((s) => s.status === "fail").length,
      errorCount: summaries.filter((s) => s.status === "error").length,
      testCount,
      testsPassed,
      // Coverage is a property of the candidate's test suite, not of any one
      // scenario, so it is reported once on the rollup (and on each result).
      coverage: opts.phases.includes("tests") ? candidate.coverage : undefined,
      claims: phaseClaims(summaryPlan),
      results: summaries,
      checkedAt: new Date().toISOString(),
    },
  );
  handles.push(summaryHandle);

  // Also write the standalone `coverage` resource (when tests ran) so a later
  // reader — the meta-factory, or `swamp data get <model> <ext>` — finds it
  // without re-running anything. It is instance-named by the extension slug,
  // matching `checkCoverage`.
  if (opts.phases.includes("tests") && candidate.tests.length > 0) {
    handles.push(
      await context.writeResource(
        "coverage",
        extensionSlug(candidate.name),
        coverageResourceBody(candidate),
      ),
    );
  }
  context.logger?.info(
    `${candidate.name}: tested ${summaries.length} scenario(s), ${passCount} passed, ${
      summaries.length - passCount
    } failed`,
  );
  return { handles };
}

/** A swamp-safe slug for an extension name (`@svendowideit/x` → `svendowideit-x`). */
function extensionSlug(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Resolve the extension manifests a `testAll` sweep should cover. */
async function resolveManifests(
  args: TestAllArgs,
  repoDir: string,
  deps: Deps,
): Promise<string[]> {
  if (args.manifest) return [args.manifest];
  const root = resolve(repoDir, args.root);
  const res = await deps.runFn(
    "git",
    ["ls-files", "--", `${args.root}/**/manifest.yaml`],
    { timeoutMs: 60_000 },
  );
  const listed = res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (listed.length > 0) {
    return listed.map((p) => resolve(repoDir, p));
  }
  if (args.gitOnly) return [];
  return await findManifests(root);
}

/** Recursively find `manifest.yaml` files, skipping dot and vendor dirs. */
async function findManifests(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile && e.name === "manifest.yaml") {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/** Resolve the candidate manifest, its declared types/workflows, and its tests. */
async function resolveCandidate(
  manifest: string,
  repoDir: string,
): Promise<Candidate> {
  const manifestAbs = resolve(repoDir, manifest);
  const info = await inspectExtension(manifestAbs);
  const testText: string = info.testsPath
    ? await Deno.readTextFile(info.testsPath)
    : "";
  const tests: TestSpec[] = testText ? parseTests(testText) : [];
  const system: TestSystem = testText
    ? parseTestSystem(testText)
    : { networks: [], harness: { networks: [], dig: false }, services: [] };
  const coverage = computeCoverage({
    description: info.manifest.description,
    tests,
    typeMethods: info.typeMethods,
    workflows: info.workflowNames,
  });
  return {
    manifestAbs,
    dir: dirname(manifestAbs),
    name: info.manifest.name || dirname(manifest).split("/").pop() || "unknown",
    version: info.manifest.version,
    modelTypes: info.modelTypes,
    workflowNames: info.workflowNames,
    tests,
    system,
    coverage,
  };
}

/**
 * The `coverage` resource body for a candidate.
 *
 * Shared by `checkCoverage` and the `test`/`testAll` fan-out so every path
 * writes the same shape (and the same instance name — the extension slug), and
 * a later reader finds one consistent record.
 */
function coverageResourceBody(
  candidate: Candidate,
): Record<string, unknown> {
  return {
    manifest: candidate.manifestAbs,
    extension: candidate.name,
    version: candidate.version,
    ...candidate.coverage,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Resolve the phases to run, auto-enabling `tests` when the candidate ships a
 * `test-factory.yaml` and the caller did not pass an explicit `phases` override.
 *
 * An explicit `--input phases=...` always wins, so a caller can deliberately
 * skip the acceptance tests. The auto-added phase is placed after `definitions`
 * and before `fixtures`, matching the canonical phase order.
 */
export function resolvePhases(
  explicit: string,
  defaultPhases: string,
  hasTests: boolean,
): string[] {
  const phases = explicit ? splitList(explicit) : splitList(defaultPhases);
  if (explicit || !hasTests || phases.includes("tests")) return phases;
  const at = phases.indexOf("definitions");
  const insertAt = at >= 0 ? at + 1 : phases.length;
  phases.splice(insertAt, 0, "tests");
  return phases;
}

/**
 * Lint the candidate's acceptance tests and throw on any issue.
 *
 * Runs before any container boots so a malformed or non-proving `test-factory.yaml`
 * fails loudly rather than silently passing. A no-op when there are no tests.
 */
export function preflightTests(tests: TestSpec[], phases: string[]): void {
  if (!phases.includes("tests") || tests.length === 0) return;
  const issues = lintTests(tests);
  if (issues.length > 0) {
    throw new Error(
      `test-factory.yaml failed validation:\n  - ${issues.join("\n  - ")}`,
    );
  }
}

/**
 * Lint a candidate's declared container test system and throw on any issue.
 *
 * Runs before any container boots, so an unreachable network, a missing image,
 * or a duplicate static address is reported immediately. A no-op for the
 * (common) candidate that declares no services.
 */
export function preflightTestSystem(system: TestSystem): void {
  const issues = lintTestSystem(system);
  if (issues.length > 0) {
    throw new Error(
      `test-factory.yaml test system failed validation:\n  - ${
        issues.join("\n  - ")
      }`,
    );
  }
}

/** Turn method args and the catalog into the scenarios to run. */
function selectScenarios(args: TestArgs): Scenario[] {
  const filter: ScenarioFilter = {
    scenario: args.scenario || undefined,
    distro: args.distro || undefined,
    topology: args.topology || undefined,
    systemd: args.systemd === "" ? undefined : args.systemd === "true",
    workers: args.workers,
  };
  const scenarios = resolveScenarios(filter);
  if (args.expected) {
    const expected = args.expected === "fail" ? "fail" : "pass";
    return scenarios.map((s) => ({ ...s, expected }));
  }
  return scenarios;
}

/** List docker networks whose name starts with a prefix. */
async function listNetworkNames(
  runFn: RunFn,
  prefix: string,
): Promise<string[]> {
  const res = await runFn("docker", [
    "network",
    "ls",
    "--format",
    "{{.Name}}",
  ], { timeoutMs: 30_000 });
  if (res.code !== 0) return [];
  const p = prefix || "tf-";
  return res.stdout.split("\n").map((s) => s.trim()).filter((n) =>
    n.startsWith(p)
  );
}
