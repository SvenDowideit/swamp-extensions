/**
 * `@svendowideit/sudo` — run one privileged operation on the host, without
 * assuming `sudo` is installed.
 *
 * The model resolves the first elevation route the host has already granted
 * (sudo, doas, polkit/run0, systemd-run, pkexec, ssh, a held capability, or a
 * container runtime you are a member of), then runs the caller's request
 * through it. Callers name an **operation** with typed arguments by default;
 * arbitrary commands are available only through the approval-gated
 * `request`/`runApproved` methods.
 *
 * Methods:
 *   - `probe`       — enumerate the strategy ladder and report the first proven
 *                     route. Never runs the target command, but *may* start a
 *                     transient privileged container/pod to prove a container
 *                     route; always succeeds, so its findings are always
 *                     reachable.
 *   - `run`         — execute a named operation through the resolved route.
 *   - `request`     — register an arbitrary argv and mint a request id (gated).
 *   - `runApproved` — execute an arbitrary argv that matches a registered
 *                     request, after operator approval (gated, single use).
 *
 * No mechanism in this model brute-forces a credential, prompts for a password,
 * or exploits a vulnerability. A route is usable only when the host has already
 * granted it; otherwise the operation fails with a report of what was tried.
 * Container routes are refused when the daemon is remote (`DOCKER_HOST` /
 * `CONTAINER_HOST` points at another host), so a local operation never runs on
 * a different machine.
 *
 * @module
 */
import { z } from "npm:zod@4";

import {
  DEFAULT_STRATEGY_ORDER,
  type ExecResult,
  getStrategy,
  parseGroupList,
  safeEnv,
  STRATEGIES,
  type Strategy,
  type StrategyConfig,
} from "./sudo_strategies.ts";
import {
  type BuildResult,
  DEFAULT_ALLOWED_OPERATIONS,
  getOperation,
  listOperationIds,
} from "./sudo_operations.ts";

// ---------------------------------------------------------------------------
// Global & method argument schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  strategyOrder: z.array(z.string()).default(DEFAULT_STRATEGY_ORDER).describe(
    "Elevation routes to try, in order. Defaults to a side-effect-ordered ladder.",
  ),
  allowedOperations: z.array(z.string()).default([]).describe(
    "Operations `run` may execute. An empty array falls back to the narrow " +
      "default set (installPackage, removePackage, manageService); " +
      "filesystem/account-mutating or kernel-knob operations (mount, chown, " +
      "ensureDirectory, addUserToGroup, createUser, installFile, removePath, " +
      "copyDirectory, runScript, sysctl) must be added explicitly.",
  ),
  allowArbitrary: z.boolean().default(false).describe(
    "Enable the approval-gated arbitrary-command methods `request`/`runApproved`.",
  ),
  sshHost: z.string().default("").describe(
    "Host for the ssh-root route; empty disables it.",
  ),
  sshKnownHosts: z.string().default("").describe(
    "Pinned known_hosts file for the ssh-root route (StrictHostKeyChecking=yes).",
  ),
  containerImage: z.string().default(
    "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
  ).describe(
    "Digest-pinned image for the scratch-container and k8s-node routes. Pin by digest for reproducibility.",
  ),
  containerNetwork: z.string().default("none").describe(
    "Network mode for the scratch-container routes (e.g. none, host, bridge). Defaults to none; set host only when an operation needs the network.",
  ),
  k8sNode: z.string().default("").describe(
    "Cluster node for the k8s-node route; empty disables it.",
  ),
  ssmInstanceId: z.string().default("").describe(
    "Target instance for the AWS SSM route; empty disables it.",
  ),
  timeoutSeconds: z.number().int().positive().default(120).describe(
    "Per-execution timeout.",
  ),
  probeTimeoutSeconds: z.number().int().positive().default(8).describe(
    "Per-route proof timeout. A route that needs a prompt is treated as unavailable.",
  ),
  allowAudit: z.boolean().default(false).describe(
    "Emit read-only residual-risk findings (container group, sudoers, writable root paths, polkit/LXD).",
  ),
  approvalVault: z.string().default("sudo-approval").describe(
    "Vault that holds the single-use, run-scoped approval secret for the gated command path.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProbeArgsSchema = z.object({
  strategy: z.string().default("auto").describe(
    "Pin one route, or 'auto' for the configured ladder.",
  ),
  allowAudit: z.boolean().optional().describe(
    "Override the global allowAudit for this call.",
  ),
});

const RunArgsSchema = z.object({
  operation: z.string().describe("Operation id (see the catalogue)."),
  args: z.record(z.string(), z.unknown()).default({}).describe(
    "Typed arguments for the operation.",
  ),
  strategy: z.string().default("auto").describe("Pin one route, or 'auto'."),
  timeoutSeconds: z.number().int().positive().optional().describe(
    "Override the global execution timeout.",
  ),
});

const RequestArgsSchema = z.object({
  command: z.array(z.string()).min(1).describe(
    "The argv to run as root. An array, never a shell string.",
  ),
  reason: z.string().min(1).describe(
    "Why this command is needed, shown at the approval gate.",
  ),
  requestId: z.string().optional().describe(
    "Caller-supplied request id (e.g. the workflow run id). Generated when absent.",
  ),
});

const RunApprovedArgsSchema = z.object({
  command: z.array(z.string()).min(1).describe(
    "The argv to run. Must equal the argv registered by the matching request.",
  ),
  requestId: z.string().min(1).describe(
    "Request id returned by `request`; binds this execution to a registered argv.",
  ),
  approvalToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Operator-supplied single-use secret. Must equal the run-scoped secret minted into the approval vault under this request id.",
  ),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

const LadderEntrySchema = z.object({
  id: z.string(),
  class: z.string(),
  tool: z.string(),
  installed: z.boolean().nullable(),
  proved: z.boolean(),
  reason: z.string(),
});

const WinnerSchema = z.object({
  id: z.string(),
  class: z.string(),
  ranAsUid: z.number().int(),
  riskNote: z.string(),
});

const FindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  detail: z.string(),
  remediation: z.string(),
});

const ProbeOutputSchema = z.object({
  winner: WinnerSchema.nullable(),
  ladder: z.array(LadderEntrySchema),
  findings: z.array(FindingSchema),
  audited: z.boolean(),
  capability: z.string(),
  probedAt: z.string(),
});

const ResultOutputSchema = z.object({
  strategyUsed: z.string(),
  operation: z.string().nullable(),
  command: z.array(z.string()),
  mechanism: z.string(),
  exitCode: z.number().int(),
  mechanismExitCode: z.number().int(),
  elevationFailed: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  ranAsUid: z.number().int().nullable(),
  durationMs: z.number().int(),
  approvedBy: z.string().nullable(),
  requestId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
});

const RequestOutputSchema = z.object({
  requestId: z.string(),
  command: z.array(z.string()),
  reason: z.string(),
  requestedBy: z.string(),
  requestedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Command execution (bounded output)
// ---------------------------------------------------------------------------

/** Maximum bytes captured per stream, so a runaway command cannot exhaust memory. */
const MAX_STREAM_BYTES = 64 * 1024;

export interface Exec {
  /** Captured standard output (bounded). */
  stdout: string;
  /** Captured standard error (bounded). */
  stderr: string;
  /** Process exit code; 124 on timeout, 127 when the binary is missing. */
  code: number;
  /** Termination signal when the process was killed, else null. */
  signal: string | null;
  /** True when the binary could not be spawned. */
  notFound: boolean;
  /** True when the per-execution timeout killed the process. */
  timedOut: boolean;
  /** True when output was truncated at the cap. */
  truncated: boolean;
}

const decoder = new TextDecoder();

/** Exit code the shell uses for a process killed by SIGTERM (128 + 15). */
export const KILLED_BY_SIGTERM_CODE = 143;

/**
 * Whether a completed process was killed by the per-execution timeout. The
 * spawned child is killed with SIGTERM when `timeoutMs` elapses, so the reliable
 * signal is the termination signal (or the shell's 128+15 code) — not a thrown
 * `TimeoutError`, which `spawn()` never raises.
 */
export function isTimedOut(
  signal: Deno.Signal | null,
  code: number,
): boolean {
  return signal === "SIGTERM" || code === KILLED_BY_SIGTERM_CODE;
}

/** Read a byte stream, stopping at `limit` bytes and cancelling the rest. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > limit) {
        chunks.push(value.subarray(0, limit - total));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // stream error/timeout — return what we have
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return { text: decoder.decode(merged), truncated };
}

/**
 * Run a command with a hard timeout and bounded output. A missing binary is
 * reported as `code:127` with `notFound:true` rather than thrown, so detection
 * can distinguish "not installed" from "installed but not usable".
 */
export async function runCmd(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<Exec> {
  let child: Deno.ChildProcess | null = null;
  let timedOut = false;
  // Escalate to SIGKILL if the process ignores the AbortSignal's SIGTERM, so a
  // hung command cannot hold the pipes open past the timeout.
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      child?.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs + 500);
  try {
    const proc = new Deno.Command(binary, {
      args,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    child = proc.spawn();
    const [stdout, stderr] = await Promise.all([
      readCapped(child.stdout, MAX_STREAM_BYTES),
      readCapped(child.stderr, MAX_STREAM_BYTES),
    ]);
    const status = await child.status;
    const killed = isTimedOut(status.signal, status.code);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      code: status.code,
      signal: status.signal,
      notFound: false,
      timedOut: killed || timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Deno.errors.NotFound) {
      return {
        stdout: "",
        stderr: msg,
        code: 127,
        signal: null,
        notFound: true,
        timedOut: false,
        truncated: false,
      };
    }
    const timeoutErr = err instanceof DOMException &&
      err.name === "TimeoutError";
    return {
      stdout: "",
      stderr: (timeoutErr || timedOut) ? `timed out after ${timeoutMs}ms` : msg,
      code: (timeoutErr || timedOut) ? 124 : 127,
      signal: null,
      notFound: false,
      timedOut: timeoutErr || timedOut,
      truncated: false,
    };
  } finally {
    clearTimeout(killer);
  }
}

function toExecResult(e: Exec): ExecResult {
  return { stdout: e.stdout, stderr: e.stderr, code: e.code };
}

// ---------------------------------------------------------------------------
// Strategy resolution
// ---------------------------------------------------------------------------

interface ResolvedStrategy {
  strategy: Strategy | null;
  ladder: z.infer<typeof LadderEntrySchema>[];
  winner: z.infer<typeof WinnerSchema> | null;
}

function configFrom(g: GlobalArgs): StrategyConfig {
  const endpoint = safeEnv("DOCKER_HOST") || safeEnv("CONTAINER_HOST");
  return {
    sshHost: g.sshHost,
    sshKnownHosts: g.sshKnownHosts,
    containerImage: g.containerImage,
    containerNetwork: g.containerNetwork,
    k8sNode: g.k8sNode,
    ssmInstanceId: g.ssmInstanceId,
    containerEndpoint: endpoint,
    k8sRunName: `swamp-sudo-${crypto.randomUUID().slice(0, 8)}`,
  };
}

/** Resolve the ordered list of strategy ids: pinned wins, else global order. */
export function resolveOrder(order: string[], pinned: string): string[] {
  if (pinned && pinned !== "auto") return [pinned];
  return order;
}

/**
 * Whether a route acts on the local host, so a local-only operation (one that
 * mutates the filesystem or account state) may use it. Container routes mount
 * the host root at `/host` and run the operation with `chroot /host`, so they
 * are local; `remote` (ssh), `orchestrator` (k8s node) and `oob` routes are not.
 */
export function isLocalRoute(id: string): boolean {
  const cls = STRATEGIES[id]?.class;
  return cls === "local" || cls === "capability" || cls === "container";
}

/**
 * Proof timeout: side-effecting proofs (a container/pod start) pull an image or
 * schedule a pod, so they get a generous timeout instead of the prompt-oriented
 * default, which would misreport a slow pull as a password prompt.
 */
export function proofTimeoutMs(
  sideEffects: string,
  probeTimeoutSeconds: number,
): number {
  if (sideEffects === "none") return probeTimeoutSeconds * 1000;
  return Math.max(probeTimeoutSeconds, 120) * 1000;
}

/**
 * Walk the ladder and prove each route, stopping at the **first** that yields
 * host root. Never executes the caller's command — only each route's no-op
 * proof. Side-effecting routes (a scratch container/pod) are not probed after a
 * winner is found, so a later side-effecting proof does not run needlessly. The
 * probe itself may still create a container.
 *
 * `exec` is injectable so route resolution can be tested without touching the
 * host; callers pass the real runner.
 */
async function resolveStrategy(
  g: GlobalArgs,
  pinned: string,
  localOnly: boolean,
  logger?: Logger,
  exec: (
    binary: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<Exec> = runCmd,
): Promise<ResolvedStrategy> {
  const cfg = configFrom(g);
  let order = resolveOrder(g.strategyOrder, pinned);
  if (localOnly) order = order.filter(isLocalRoute);

  const ladder: z.infer<typeof LadderEntrySchema>[] = [];
  let winner: z.infer<typeof WinnerSchema> | null = null;

  for (const id of order) {
    const strategy = getStrategy(id);
    if (!strategy) {
      ladder.push({
        id,
        class: "unknown",
        tool: "",
        installed: null,
        proved: false,
        reason: "unknown strategy id",
      });
      continue;
    }

    const precondition = strategy.precondition(cfg);
    if (precondition) {
      ladder.push({
        id,
        class: strategy.class,
        tool: strategy.tool,
        installed: null,
        proved: false,
        reason: precondition,
      });
      continue;
    }

    // Rootless container daemons cannot yield host root; reject before probing.
    if (strategy.rootless) {
      const rlArgv = strategy.rootless.argv(cfg);
      const rl = await exec(rlArgv[0], rlArgv.slice(1), 5000);
      if (
        !rl.notFound && strategy.rootless.isRootless(`${rl.stdout}${rl.stderr}`)
      ) {
        ladder.push({
          id,
          class: strategy.class,
          tool: strategy.tool,
          installed: true,
          proved: false,
          reason: "rootless daemon cannot yield host root",
        });
        continue;
      }
    }

    const probeArgv = strategy.probeArgv(cfg);
    if (probeArgv.length === 0) {
      ladder.push({
        id,
        class: strategy.class,
        tool: strategy.tool,
        installed: null,
        proved: false,
        reason: "no probe defined",
      });
      continue;
    }

    const result = await exec(
      probeArgv[0],
      probeArgv.slice(1),
      proofTimeoutMs(strategy.sideEffects, g.probeTimeoutSeconds),
    );
    const installed = !result.notFound;
    const proved = installed && strategy.probeOk(toExecResult(result));

    ladder.push({
      id,
      class: strategy.class,
      tool: strategy.tool,
      installed,
      proved,
      reason: proved
        ? "proved uid 0"
        : !installed
        ? "not installed"
        : result.timedOut
        ? "proof timed out — unavailable"
        : result.stderr.trim() || `exit ${result.code}`,
    });

    if (proved) {
      winner = {
        id,
        class: strategy.class,
        ranAsUid: 0,
        riskNote: strategy.riskNote,
      };
      logger?.debug?.("Elevation route proved: {id}", { id });
      break; // first proven route wins; do not probe side-effecting routes after
    }
  }

  return { strategy: winner ? STRATEGIES[winner.id] : null, ladder, winner };
}

// ---------------------------------------------------------------------------
// Residual-risk findings (read-only, never executed as root)
// ---------------------------------------------------------------------------

async function collectFindings(
  _g: GlobalArgs,
): Promise<z.infer<typeof FindingSchema>[]> {
  const findings: z.infer<typeof FindingSchema>[] = [];

  // Container group membership / socket access.
  try {
    const idn = await runCmd("id", ["-nG"], 3000);
    const groups = parseGroupList(idn.stdout);
    const socketGroups: Record<string, string> = {
      docker: "/var/run/docker.sock",
      podman: "/run/podman/podman.sock",
      containerd: "/run/containerd/containerd.sock",
    };
    for (const [group, sock] of Object.entries(socketGroups)) {
      if (!groups.includes(group)) continue;
      let sockPresent = false;
      try {
        await Deno.stat(sock);
        sockPresent = true;
      } catch { /* socket absent */ }
      findings.push({
        id: "risk-container-group",
        severity: "high",
        detail: `user is in the '${group}' group${
          sockPresent ? ` and ${sock} is present` : ""
        }; container-runtime group access is root-equivalent by design`,
        remediation:
          "Remove the user from the container group; use rootless containers or a socket proxy that scopes access.",
      });
    }
  } catch { /* id unavailable */ }

  // Over-permissive sudoers / could-not-read distinction.
  try {
    const sudoList = await runCmd("sudo", ["-n", "-l"], 4000);
    if (sudoList.code === 0) {
      const nopass = sudoList.stdout.split("\n").filter((l) =>
        /NOPASSWD/i.test(l)
      );
      if (nopass.length > 0) {
        findings.push({
          id: "risk-sudoers",
          severity: "high",
          detail: `sudo -n -l shows NOPASSWD entries: ${
            nopass.join(" | ").trim()
          }`,
          remediation:
            "Scope NOPASSWD rules to exact commands; avoid wildcards, SETENV, and env_keep.",
        });
      }
    } else {
      findings.push({
        id: "risk-sudoers",
        severity: "low",
        detail:
          `could not read sudo policy (sudo -n -l exited ${sudoList.code}): ${
            sudoList.stderr.trim() || "authentication required"
          }`,
        remediation:
          "This is informational only: the policy was not readable, so it was not evaluated.",
      });
    }
  } catch { /* sudo absent */ }

  // Writable root-owned paths.
  const riskyPaths = [
    "/etc/passwd",
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/crontab",
    "/etc/systemd/system",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  for (const path of riskyPaths) {
    try {
      const st = await Deno.stat(path);
      const mode = st.mode ?? 0;
      if ((mode & 0o002) === 0o002) {
        findings.push({
          id: "risk-writable-paths",
          severity: "high",
          detail: `${path} is world-writable (mode ${
            (mode & 0o7777).toString(8)
          })`,
          remediation:
            "Remove the world-writable bit and audit why it was set.",
        });
      }
    } catch { /* path absent */ }
  }

  // Polkit rules / LXD group.
  try {
    let ruleCount = 0;
    try {
      for await (const entry of Deno.readDir("/etc/polkit-1/rules.d")) {
        if (entry.isFile) ruleCount++;
      }
    } catch { /* directory absent */ }
    const idn = await runCmd("id", ["-nG"], 3000);
    const groups = parseGroupList(idn.stdout);
    const lxdGroups = ["lxd", "lxc"].filter((gr) => groups.includes(gr));
    if (ruleCount > 0 || lxdGroups.length > 0) {
      findings.push({
        id: "risk-polkit-lxd",
        severity: "medium",
        detail: [
          ruleCount > 0
            ? `${ruleCount} custom polkit rule file(s) in /etc/polkit-1/rules.d`
            : "",
          lxdGroups.length > 0 ? `user is in ${lxdGroups.join(", ")}` : "",
        ].filter(Boolean).join("; "),
        remediation:
          "Review custom polkit rules for broad grants; treat LXD/LXC group membership as root-equivalent.",
      });
    }
  } catch { /* best effort */ }

  return findings;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface RunOutcome {
  data: z.infer<typeof ResultOutputSchema>;
}

/** The process runner used by route resolution and execution; injectable for tests. */
type ExecFn = (
  binary: string,
  args: string[],
  timeoutMs: number,
) => Promise<Exec>;

/**
 * Execute a route's argv and record the outcome. Only the route id and target
 * program are written to `mechanism` — never the full argv, which may carry a
 * secret.
 */
async function addRoute(
  g: GlobalArgs,
  resolved: ResolvedStrategy,
  argv: string[],
  operation: string | null,
  timeoutMs: number,
  approvedBy: string | null,
  requestId: string | null,
  run: ExecFn = runCmd,
): Promise<RunOutcome> {
  const strategy = resolved.strategy;
  if (!strategy) {
    throw new Error("no elevation strategy resolved");
  }
  const full = strategy.build(argv, configFrom(g));
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const exec = await run(full[0], full.slice(1), timeoutMs);
  const durationMs = Math.round(performance.now() - start);
  const finishedAt = new Date().toISOString();
  const elevationFailed = strategy.elevationFailed(exec.code, exec.stderr);

  return {
    data: {
      strategyUsed: strategy.id,
      operation,
      command: argv,
      mechanism: `${strategy.id} → ${argv[0] ?? ""}`.trim(),
      exitCode: elevationFailed ? -1 : exec.code,
      mechanismExitCode: exec.code,
      elevationFailed,
      stdout: exec.stdout,
      stderr: exec.stderr,
      truncated: exec.truncated,
      ranAsUid: resolved.winner ? 0 : null,
      durationMs,
      approvedBy,
      requestId,
      startedAt,
      finishedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface Logger {
  info: (msg: string, props?: Record<string, unknown>) => void;
  debug?: (msg: string, props?: Record<string, unknown>) => void;
}

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  deleteResource: (instanceName: string) => Promise<void>;
  /**
   * Test seam: overrides the process runner. Swamp never sets this field, and
   * it cannot be reached through method arguments, so production always uses
   * the real `runCmd`.
   */
  _exec?: ExecFn;
  /** Vault service for the run-scoped approval secret (swamp populates this). */
  vaultService?: {
    get: (vaultName: string, key: string) => Promise<string>;
    delete: (vaultName: string, key: string) => Promise<void>;
  };
  definition: {
    id: string;
    name: string;
    version: string;
    tags: Record<string, string>;
  };
};

/** A short, human-readable ladder for a no-route error. */
function ladderReport(ladder: z.infer<typeof LadderEntrySchema>[]): string {
  return ladder.map((e) => `  - ${e.id}: ${e.reason}`).join("\n");
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Model definition for `@svendowideit/sudo`.
 *
 * Exposes `probe`, `run`, `request`, and `runApproved`, writing the `probe`,
 * `result`, and `request` resources.
 */
export const model = {
  type: "@svendowideit/sudo",
  version: "2026.10.04.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.04.2",
      description:
        "Four new opt-in operations (argv builders only, no resource shape " +
        "change): installFile (install -D -m), daemonReload (systemctl " +
        "daemon-reload), removePath (rm -rf, refuses /), runScript (sh " +
        "<script>), copyDirectory (cp -a). All localOnly; all must be added " +
        "to allowedOperations.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    probe: {
      description:
        "Last probe result: ladder, winner, and residual-risk findings",
      schema: ProbeOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    result: {
      description: "Last privileged execution result",
      schema: ResultOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    request: {
      description: "A registered arbitrary-command request awaiting approval",
      schema: RequestOutputSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
  },
  methods: {
    probe: {
      description:
        "Enumerate the elevation ladder and report the first route that proves host root; optionally emit read-only residual-risk findings. Never runs the target command, but may start a transient privileged container/pod to prove a container route.",
      arguments: ProbeArgsSchema,
      execute: async (
        args: z.infer<typeof ProbeArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const resolved = await resolveStrategy(
          g,
          args.strategy,
          false,
          context.logger,
          context._exec,
        );
        const audited = args.allowAudit ?? g.allowAudit;
        const findings = audited ? await collectFindings(g) : [];

        for (const entry of resolved.ladder) {
          context.logger?.info(
            "route {id}: {reason}",
            { id: entry.id, reason: entry.reason },
          );
        }

        const capability = resolved.winner
          ? `root-via-${resolved.winner.id}`
          : "no-granted-route";
        context.logger?.info(
          "Capability: {capability}",
          { capability },
        );

        const handle = await context.writeResource("probe", "probe", {
          winner: resolved.winner,
          ladder: resolved.ladder,
          findings,
          audited,
          capability,
          probedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    run: {
      description:
        "Execute a named operation through the resolved elevation route. Records exit code, output, and the route used; a non-zero program exit is recorded, not thrown.",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;

        // An empty allowlist (the schema default) means "the narrow default
        // set", so a bare model instance behaves as documented; a caller
        // passing [] explicitly gets exactly that fallback too.
        const allowed = g.allowedOperations.length > 0
          ? g.allowedOperations
          : DEFAULT_ALLOWED_OPERATIONS;
        if (!allowed.includes(args.operation)) {
          throw new Error(
            `Operation '${args.operation}' is not allowed. allowedOperations: ${
              allowed.join(", ")
            }`,
          );
        }
        const op = getOperation(args.operation);
        if (!op) {
          throw new Error(
            `Unknown operation '${args.operation}'. Known: ${
              listOperationIds().join(", ")
            }`,
          );
        }

        // Validate the operation's typed args before resolving a route.
        const built: BuildResult = op.build(args.args);

        const timeoutMs = (args.timeoutSeconds ?? g.timeoutSeconds) * 1000;
        const resolved = await resolveStrategy(
          g,
          args.strategy,
          op.localOnly,
          context.logger,
          context._exec,
        );
        if (!resolved.winner) {
          throw new Error(
            `No granted elevation route is available for '${args.operation}'. Tried:\n${
              ladderReport(resolved.ladder)
            }\n` +
              `Configure a route (sudo/doas/polkit, a container runtime, sshHost, k8sNode, …) or run the 'probe' method to see the ladder.`,
          );
        }

        const { data } = await addRoute(
          g,
          resolved,
          built.argv,
          args.operation,
          timeoutMs,
          null,
          null,
          context._exec,
        );
        context.logger?.info(
          "Ran '{operation}' via {strategyUsed}: exit {exitCode}",
          {
            operation: args.operation,
            strategyUsed: data.strategyUsed,
            exitCode: data.exitCode,
          },
        );
        const handle = await context.writeResource("result", "result", data);
        return { dataHandles: [handle] };
      },
    },

    request: {
      description:
        "Register an arbitrary argv and mint a request id. Requires allowArbitrary=true. The caller must present the request id, a matching argv, and an operator approval token to runApproved.",
      arguments: RequestArgsSchema,
      execute: async (
        args: z.infer<typeof RequestArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        if (!g.allowArbitrary) {
          throw new Error(
            "Arbitrary commands are disabled. Create the model with allowArbitrary=true to enable request/runApproved.",
          );
        }
        const requestId = args.requestId && args.requestId.trim()
          ? args.requestId.trim()
          : crypto.randomUUID();
        context.logger?.info(
          "Approval requested for {argc} argument(s): {reason}",
          { argc: args.command.length, reason: args.reason },
        );
        // A single stable data name ("pending") per model instance; concurrent
        // gated callers must use distinct instanceKey values. runApproved
        // binds on the request id and the exact argv, so a clobbered record
        // fails closed rather than running the wrong command.
        const handle = await context.writeResource("request", "pending", {
          requestId,
          command: args.command,
          reason: args.reason,
          requestedBy: safeEnv("USER") || "unknown",
          requestedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    runApproved: {
      description:
        "Execute an arbitrary argv after operator approval. Requires allowArbitrary=true, a requestId registered by `request` whose stored argv equals the supplied argv, and an approval token matching SWAMP_SUDO_APPROVAL_TOKEN. The registered request is consumed on success (single use).",
      arguments: RunApprovedArgsSchema,
      execute: async (
        args: z.infer<typeof RunApprovedArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        if (!g.allowArbitrary) {
          throw new Error(
            "Arbitrary commands are disabled (allowArbitrary=false).",
          );
        }

        // Bind to the registered request: the request id and the exact argv
        // must equal what `request` stored. The caller cannot invent an argv
        // that was not registered.
        const record = await context.readResource("pending").catch(() => null);
        if (!record || typeof record.command === "undefined") {
          throw new Error(
            "No registered request found. Call 'request' first.",
          );
        }
        if (record.requestId !== args.requestId) {
          throw new Error(
            "The supplied requestId does not match the registered request; refusing runApproved.",
          );
        }
        const stored = JSON.stringify(record.command);
        if (stored !== JSON.stringify(args.command)) {
          throw new Error(
            "The supplied command does not match the registered request; refusing runApproved.",
          );
        }

        // Single-use, run-scoped approval secret. The operator mints a fresh
        // secret into the approval vault at the manual_approval gate, keyed by
        // the request id (the workflow run id), so the token is bound to this
        // specific run and can be used exactly once. A missing or mismatched
        // secret fails closed. No static, reusable token exists.
        const minted = context.vaultService
          ? await context.vaultService.get(g.approvalVault, args.requestId)
            .catch(() => "")
          : "";
        if (!minted) {
          throw new Error(
            `No approval secret is minted for request '${args.requestId}'. Put a single-use secret into the '${g.approvalVault}' vault under key '${args.requestId}' at the approval gate, then resume.`,
          );
        }
        if (args.approvalToken !== minted) {
          throw new Error(
            "Approval token does not match; refusing runApproved.",
          );
        }

        const timeoutMs = g.timeoutSeconds * 1000;
        const resolved = await resolveStrategy(
          g,
          "auto",
          false,
          context.logger,
          context._exec,
        );
        if (!resolved.winner) {
          throw new Error(
            `No granted elevation route is available. Tried:\n${
              ladderReport(resolved.ladder)
            }`,
          );
        }
        const { data } = await addRoute(
          g,
          resolved,
          args.command,
          null,
          timeoutMs,
          "operator",
          args.requestId,
          context._exec,
        );
        context.logger?.info(
          "Approved command ran via {strategyUsed}: exit {exitCode}",
          { strategyUsed: data.strategyUsed, exitCode: data.exitCode },
        );
        // Consume both the request record and the single-use approval secret:
        // a single human approval authorises exactly one execution. Deletion
        // failures are NOT swallowed — a request/secret left behind would make
        // the approved command replayable, so we fail loudly instead.
        await context.deleteResource("pending");
        if (context.vaultService) {
          await context.vaultService.delete(g.approvalVault, args.requestId);
        }
        const handle = await context.writeResource("result", "result", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
