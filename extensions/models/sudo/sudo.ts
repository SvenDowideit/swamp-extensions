/**
 * `@svendowideit/sudo` — run one privileged operation on the host, without
 * assuming `sudo` is installed.
 *
 * The model resolves the first elevation route the host has already granted
 * (sudo, doas, polkit/run0, systemd-run, pkexec, ssh, a held capability, a
 * container runtime you are a member of, or a Kubernetes node), then runs the
 * caller's request through it. Callers name an **operation** with typed
 * arguments by default; arbitrary commands are available only through the
 * approval-gated `request`/`runApproved` methods.
 *
 * Methods:
 *   - `probe`       — enumerate the strategy ladder and report the first proven
 *                     route. Never runs the target command; always succeeds, so
 *                     its findings are always reachable.
 *   - `run`         — execute a named operation through the resolved route.
 *   - `request`     — mint an approval nonce for an arbitrary argv (gated).
 *   - `runApproved` — execute an arbitrary argv after operator approval (gated).
 *
 * No mechanism in this model brute-forces a credential, prompts for a password,
 * or exploits a vulnerability. A route is usable only when the host has already
 * granted it; otherwise the operation fails with a report of what was tried.
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
  allowedOperations: z.array(z.string()).default(listOperationIds()).describe(
    "Operations `run` may execute. Defaults to the full shipped catalogue.",
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
  containerImage: z.string().default("alpine:3.20").describe(
    "Image for the scratch-container and k8s-node routes. Pin by digest for reproducibility.",
  ),
  containerName: z.string().default("").describe(
    "Existing host-root-equivalent container for the docker-exec route; empty disables it.",
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
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProbeArgsSchema = z.object({
  strategy: z.string().default("auto").describe(
    "Pin one route, or 'auto' for the configured ladder.",
  ),
  allowAudit: z.boolean().optional().describe(
    "Override the global allowAudit for this call.",
  ),
  force: z.boolean().default(false).describe(
    "Re-probe even if a recent probe exists.",
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
  allowAudit: z.boolean().optional().describe(
    "Override the global allowAudit for this call.",
  ),
});

const RequestArgsSchema = z.object({
  command: z.array(z.string()).min(1).describe(
    "The argv to run as root. An array, never a shell string.",
  ),
  reason: z.string().min(1).describe(
    "Why this command is needed, shown at the approval gate.",
  ),
});

const RunApprovedArgsSchema = z.object({
  command: z.array(z.string()).min(1),
  reason: z.string().min(1),
  nonce: z.string().min(1).describe("Nonce returned by `request`."),
  approvalToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Operator approval token; must match SWAMP_SUDO_APPROVAL_TOKEN.",
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
  ranAsUid: z.number().int().nullable(),
  durationMs: z.number().int(),
  approvedBy: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
});

const RequestOutputSchema = z.object({
  nonce: z.string(),
  command: z.array(z.string()),
  reason: z.string(),
  requestedBy: z.string(),
  requestedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

interface Exec {
  stdout: string;
  stderr: string;
  code: number;
  notFound: boolean;
  timedOut: boolean;
}

const decoder = new TextDecoder();

/**
 * Run a command with a hard timeout. A missing binary is reported as `code:127`
 * with `notFound:true` rather than thrown, so detection can distinguish
 * "not installed" from "installed but not usable".
 */
async function runCmd(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<Exec> {
  try {
    const proc = new Deno.Command(binary, {
      args,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out = await proc.output();
    return {
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
      code: out.code,
      notFound: false,
      timedOut: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Deno.errors.NotFound) {
      return {
        stdout: "",
        stderr: msg,
        code: 127,
        notFound: true,
        timedOut: false,
      };
    }
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return {
      stdout: "",
      stderr: timedOut ? `timed out after ${timeoutMs}ms` : msg,
      code: timedOut ? 124 : 127,
      notFound: false,
      timedOut,
    };
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
  return {
    sshHost: g.sshHost,
    sshKnownHosts: g.sshKnownHosts,
    containerImage: g.containerImage,
    containerName: g.containerName,
    k8sNode: g.k8sNode,
    ssmInstanceId: g.ssmInstanceId,
  };
}

/** Resolve the ordered list of strategy ids: pinned wins, else global order. */
export function resolveOrder(order: string[], pinned: string): string[] {
  if (pinned && pinned !== "auto") return [pinned];
  return order;
}

/** Whether a route is safe to use for an operation that writes a local file. */
export function isLocalRoute(id: string): boolean {
  const cls = STRATEGIES[id]?.class;
  return cls === "local" || cls === "capability";
}

/**
 * Walk the ladder and prove each route, returning the first that yields host
 * root. Never executes the caller's command — only each route's no-op proof.
 */
async function resolveStrategy(
  g: GlobalArgs,
  pinned: string,
  localOnly: boolean,
  logger?: Logger,
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

    const result = await runCmd(
      probeArgv[0],
      probeArgv.slice(1),
      g.probeTimeoutSeconds * 1000,
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
        ? "probe timed out (prompt?) — unavailable"
        : result.stderr.trim() || `exit ${result.code}`,
    });

    if (proved && !winner) {
      winner = {
        id,
        class: strategy.class,
        ranAsUid: 0,
        riskNote: strategy.riskNote,
      };
      logger?.debug?.("Elevation route proved: {id}", { id });
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
// Nonce hashing for the gated path
// ---------------------------------------------------------------------------

/** A stable nonce over an arbitrary command and its stated reason. */
export async function approvalNonce(
  command: string[],
  reason: string,
): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify({ command, reason }));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface RunOutcome {
  data: z.infer<typeof ResultOutputSchema>;
}

async function execute(
  g: GlobalArgs,
  resolved: ResolvedStrategy,
  argv: string[],
  operation: string | null,
  timeoutMs: number,
  approvedBy: string | null,
): Promise<RunOutcome> {
  const strategy = resolved.strategy;
  if (!strategy) {
    throw new Error("no elevation strategy resolved");
  }
  const full = strategy.build(argv, configFrom(g));
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const exec = await runCmd(full[0], full.slice(1), timeoutMs);
  const durationMs = Math.round(performance.now() - start);
  const finishedAt = new Date().toISOString();
  const elevationFailed = strategy.elevationFailed(exec.code, exec.stderr);

  return {
    data: {
      strategyUsed: strategy.id,
      operation,
      command: argv,
      mechanism: `${strategy.id}(${full.join(" ")})`,
      exitCode: elevationFailed ? -1 : exec.code,
      mechanismExitCode: exec.code,
      elevationFailed,
      stdout: exec.stdout,
      stderr: exec.stderr,
      ranAsUid: resolved.winner ? 0 : null,
      durationMs,
      approvedBy,
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
  definition: {
    id: string;
    name: string;
    version: string;
    tags: Record<string, string>;
  };
};

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
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [],
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
      description: "Pending approval request for an arbitrary command",
      schema: RequestOutputSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
  },
  methods: {
    probe: {
      description:
        "Enumerate the elevation ladder and report the first route that proves host root; optionally emit read-only residual-risk findings. Never runs the target command.",
      arguments: ProbeArgsSchema,
      execute: async (
        args: z.infer<typeof ProbeArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const localOnly = false;
        const resolved = await resolveStrategy(
          g,
          args.strategy,
          localOnly,
          context.logger,
        );
        const audit = args.allowAudit ?? g.allowAudit;
        const findings = audit ? await collectFindings(g) : [];

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

        if (!g.allowedOperations.includes(args.operation)) {
          throw new Error(
            `Operation '${args.operation}' is not allowed. allowedOperations: ${
              g.allowedOperations.join(", ")
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
        );
        if (!resolved.winner) {
          const tried = resolved.ladder
            .map((e) => `  - ${e.id}: ${e.reason}`)
            .join("\n");
          throw new Error(
            `No granted elevation route is available for '${args.operation}'. Tried:\n${tried}\n` +
              `Configure a route (sudo/doas/polkit, a container runtime, sshHost, k8sNode, …) or run 'probe' to see the ladder.`,
          );
        }

        // For a writeFile operation, stage the content locally then install it
        // through the resolved (local-only) route.
        let argv: string[];
        let cleanup: string | null = null;
        if (built.kind === "writeFile") {
          const tmp = await Deno.makeTempFile({
            prefix: "swamp-sudo-",
            suffix: ".content",
          });
          cleanup = tmp;
          await Deno.writeTextFile(tmp, built.content);
          const mode = `0${built.mode.toString(8)}`;
          argv = ["install", "-m", mode, tmp, built.path];
        } else {
          argv = built.argv;
        }

        try {
          const { data } = await execute(
            g,
            resolved,
            argv,
            args.operation,
            timeoutMs,
            null,
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
        } finally {
          if (cleanup) {
            await Deno.remove(cleanup).catch(() => {});
          }
        }
      },
    },

    request: {
      description:
        "Mint an approval nonce for an arbitrary argv. Requires allowArbitrary=true. The caller must present the nonce, an operator approval token, and the same argv to runApproved.",
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
        const nonce = await approvalNonce(args.command, args.reason);
        context.logger?.info(
          "Approval requested for {argc} argument(s): {reason}",
          { argc: args.command.length, reason: args.reason },
        );
        const handle = await context.writeResource("request", "request", {
          nonce,
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
        "Execute an arbitrary argv after operator approval. Requires allowArbitrary=true, an approval token matching SWAMP_SUDO_APPROVAL_TOKEN, and a nonce that matches the argv+reason.",
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
        const expectedToken = safeEnv("SWAMP_SUDO_APPROVAL_TOKEN");
        if (!expectedToken) {
          throw new Error(
            "SWAMP_SUDO_APPROVAL_TOKEN is not set; refusing runApproved. Set it in the operator environment served to the approval gate.",
          );
        }
        if (args.approvalToken !== expectedToken) {
          throw new Error(
            "Approval token does not match; refusing runApproved.",
          );
        }
        const expectedNonce = await approvalNonce(args.command, args.reason);
        if (args.nonce !== expectedNonce) {
          throw new Error(
            "Approval nonce does not match the supplied command and reason; refusing runApproved.",
          );
        }

        const timeoutMs = g.timeoutSeconds * 1000;
        const resolved = await resolveStrategy(
          g,
          "auto",
          false,
          context.logger,
        );
        if (!resolved.winner) {
          const tried = resolved.ladder.map((e) => `  - ${e.id}: ${e.reason}`)
            .join("\n");
          throw new Error(
            `No granted elevation route is available. Tried:\n${tried}`,
          );
        }
        const { data } = await execute(
          g,
          resolved,
          args.command,
          null,
          timeoutMs,
          "operator",
        );
        context.logger?.info(
          "Approved command ran via {strategyUsed}: exit {exitCode}",
          { strategyUsed: data.strategyUsed, exitCode: data.exitCode },
        );
        const handle = await context.writeResource("result", "result", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
