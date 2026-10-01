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
import { dirname, join, resolve } from "jsr:@std/path@1";
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
  buildHarnessScript,
  DEFAULT_RELEASE_BASE,
  evaluateResult,
  type FixtureRun,
  type HarnessPlan,
  type HarnessResult,
  parseFixtures,
  parseHarnessResult,
} from "./harness.ts";
import { inspectExtension } from "./introspect.ts";
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

const TopologySchema = z.object({
  serveReady: z.boolean(),
  workersEnrolled: z.number(),
  workersRequested: z.number(),
  dispatchOk: z.boolean(),
  detail: z.string(),
});

/** Resource schema for one scenario's outcome. */
const ResultSchema = z.object({
  scenario: z.string(),
  distro: z.string(),
  distroImage: z.string(),
  systemd: z.boolean(),
  topology: z.string(),
  workers: z.number(),
  expected: z.string(),
  ok: z.boolean(),
  status: z.enum(["pass", "fail", "error"]),
  phasesRequested: z.array(z.string()),
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
  topologyResult: TopologySchema.optional(),
  errors: z.array(z.string()),
  durationMs: z.number(),
  container: z.string(),
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
  count: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  errorCount: z.number(),
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
  modelTypes: string[];
  workflowNames: string[];
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

/** Build the default (unrun) result for a scenario. */
function blankResult(
  scenario: Scenario,
  candidate: Candidate,
  opts: RunOptions,
  deps: Deps,
  containers: string[],
): Result {
  return {
    scenario: scenario.name,
    distro: scenario.distro,
    distroImage: distroByName(scenario.distro)?.image ?? "",
    systemd: scenario.systemd,
    topology: scenario.topology,
    workers: scenario.workers,
    expected: scenario.expected,
    ok: false,
    status: "error",
    phasesRequested: opts.phases,
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
    errors: [],
    durationMs: 0,
    container: containers.join(","),
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

  const result = blankResult(scenario, candidate, opts, deps, containers);
  const finished = (): Result => {
    result.durationMs = Date.now() - started;
    return result;
  };

  if (!distro) {
    result.errors.push(`unknown distro: ${scenario.distro}`);
    return finished();
  }

  const plan: HarnessPlan = {
    swampVersion: scenario.swampVersion ?? deps.swampVersion,
    repoDir: "/work/repo",
    extensionMount: "/opt/ext",
    extensionName: "under-test",
    modelTypes: candidate.modelTypes,
    workflows: candidate.workflowNames,
    phases: opts.phases as HarnessPlan["phases"],
    fixtures: opts.fixtures,
    releaseBaseUrl: deps.releaseBaseUrl,
    expectSystemd: scenario.systemd,
  };

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
    const created = await runDetached(deps.runFn, {
      name: target,
      image: img.image,
      systemd: scenario.systemd,
      network: scenario.topology === "standalone" ? undefined : network,
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
      finalize(result, raw, scenario, opts);
      return finished();
    }

    let harnessResult: HarnessResult | null = null;
    try {
      harnessResult = raw.trim() ? parseHarnessResult(raw) : null;
    } catch {
      harnessResult = null;
    }
    finalize(result, raw, scenario, opts, harnessResult);

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
        containers.map((c) => removeContainer(deps.runFn, c).catch(() => {})),
      );
      if (scenario.topology !== "standalone") {
        await removeNetwork(deps.runFn, network).catch(() => {});
        await removeVolume(deps.runFn, sharedVolume).catch(() => {});
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
  result.errors.push(...evaluation.errors);
  return result;
}

/** A stable placeholder when the installed version could not be read. */
function depsVersionLabel(result: Result): string {
  return result.swampVersion || "unknown";
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
  version: "2026.10.01.1",
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

        const phases = args.phases
          ? splitList(args.phases)
          : splitList(context.globalArgs.defaultPhases);
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
        const phases = args.phases
          ? splitList(args.phases)
          : splitList(context.globalArgs.defaultPhases);
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
          scopeByExtension: true,
        };

        context.logger?.info(
          `Sweeping ${manifests.length} extension(s) across ${scenarios.length} scenario(s)`,
        );

        const handles: Array<{ name: string }> = [];
        for (const manifestPath of manifests) {
          const candidate = await resolveCandidate(
            manifestPath,
            context.repoDir,
          );
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
  // A `testAll` sweep runs several extensions through the same scenarios, so
  // result and summary instance names are namespaced by extension. A single
  // `test` keeps the bare scenario name so its data is easy to find.
  const extSlug = extensionSlug(candidate.name);
  const scoped = Boolean(opts.scopeByExtension);
  const resultName = (s: Scenario) =>
    scoped ? `${extSlug}-${scenarioSlug(s)}` : scenarioSlug(s);

  for (const scenario of scenarios) {
    context.logger?.info(
      `${candidate.name} · scenario ${scenario.name}: starting`,
    );
    const result = await runScenario(scenario, candidate, opts, deps);
    const handle = await context.writeResource(
      "result",
      resultName(scenario),
      result,
    );
    handles.push(handle);
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
  const summaryHandle = await context.writeResource(
    "summary",
    scoped ? extSlug : "rollup",
    {
      manifest: candidate.manifestAbs,
      extension: candidate.name,
      count: summaries.length,
      passCount,
      failCount: summaries.filter((s) => s.status === "fail").length,
      errorCount: summaries.filter((s) => s.status === "error").length,
      results: summaries,
      checkedAt: new Date().toISOString(),
    },
  );
  handles.push(summaryHandle);
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

/** Resolve the candidate manifest and its declared types/workflows. */
async function resolveCandidate(
  manifest: string,
  repoDir: string,
): Promise<Candidate> {
  const manifestAbs = resolve(repoDir, manifest);
  const info = await inspectExtension(manifestAbs);
  return {
    manifestAbs,
    dir: dirname(manifestAbs),
    name: info.manifest.name || dirname(manifest).split("/").pop() || "unknown",
    modelTypes: info.modelTypes,
    workflowNames: info.workflowNames,
  };
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
