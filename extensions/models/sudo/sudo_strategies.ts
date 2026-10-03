/**
 * Pure strategy catalogue for `@svendowideit/sudo`.
 *
 * Every elevation route is a {@link Strategy}: how to detect it, how to prove it
 * yields host root, and the exact argv to run a caller's command through it.
 * This module does **no I/O** — it only builds argv and interprets results — so
 * it is fully unit-testable and safe to import from the model.
 *
 * The catalogue intentionally has no privileged/exploit split. `sudo` and
 * container-group access are both pre-granted privilege; the honest labels are
 * `riskNote` and `sideEffects`. A separate set of read-only
 * residual-risk findings lives in `sudo.ts`.
 *
 * @module
 */

/** What a strategy needs from the model's global arguments. */
export interface StrategyConfig {
  sshHost: string;
  sshKnownHosts: string;
  containerImage: string;
  containerNetwork: string;
  k8sNode: string;
  ssmInstanceId: string;
  /**
   * Unique suffix for the k8s-node transient pod name, so concurrent runs do
   * not collide on a fixed pod name.
   */
  k8sRunName: string;
  /**
   * Container daemon endpoint from `DOCKER_HOST`/`CONTAINER_HOST`. Empty means
   * the runtime's default local socket. A remote endpoint disables the
   * container routes, which would otherwise act on another host.
   */
  containerEndpoint: string;
}

/** How a strategy reaches root. `remote` routes target another host. */
export type StrategyClass =
  | "local"
  | "capability"
  | "remote"
  | "container"
  | "orchestrator"
  | "oob";

/** Side effects a probe or execution of this strategy can have. */
export type SideEffects =
  | "none"
  | "creates-container"
  | "creates-pod"
  | "remote-api";

/** A result from running a probe or a target command. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** How a route checks that its daemon is not rootless. */
export interface RootlessCheck {
  /** argv that prints the daemon's security options or rootless flag. */
  argv: (g: StrategyConfig) => string[];
  /** Whether the output indicates a rootless daemon (which cannot give host root). */
  isRootless: (output: string) => boolean;
}

/** A single elevation route. */
export interface Strategy {
  id: string;
  class: StrategyClass;
  /** Binary the route needs on PATH (or the program's own name). */
  tool: string;
  riskNote: string;
  sideEffects: SideEffects;
  /**
   * Extra precondition beyond the tool existing. Returns a human reason when
   * the route is unusable, or null when it is configured.
   */
  precondition: (g: StrategyConfig) => string | null;
  /** Optional rootless-daemon check; a rootless result makes the route unavailable. */
  rootless?: RootlessCheck;
  /** argv that proves the route yields host root (expects uid 0). */
  probeArgv: (g: StrategyConfig) => string[];
  /** Whether the probe output proves host root. */
  probeOk: (r: ExecResult) => boolean;
  /** Wrap the caller's argv for execution through this route. */
  build: (argv: string[], g: StrategyConfig) => string[];
  /** True when a non-zero exit is the mechanism's failure, not the target's. */
  elevationFailed: (code: number, stderr: string) => boolean;
}

/** Quote one token for a POSIX shell. */
export function shellQuote(token: string): string {
  if (token === "") return "''";
  if (/^[A-Za-z0-9_/.,:=@%+^-]+$/.test(token)) return token;
  return "'" + token.replace(/'/g, "'\\''") + "'";
}

/** Join argv into a single shell-quoted command line. */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** Read an environment variable without requiring --allow-env in tests/embedders. */
export function safeEnv(key: string): string {
  try {
    return Deno.env.get(key) ?? "";
  } catch {
    return "";
  }
}

const uidIsZero = (r: ExecResult): boolean =>
  r.code === 0 && r.stdout.trim() === "0";

/**
 * Wrap a caller argv so the real program resolves through PATH while the
 * invoked program path stays absolute — required by `run0`, `pkexec`,
 * `systemd-run`, `setpriv`, and `nsenter`, which insist on an absolute program.
 * `sudo`, `doas`, `docker`, and `ssh` resolve the command name themselves, so
 * they do not need the `env` shim.
 */
const ENV = "/usr/bin/env";
const ID = "/usr/bin/id";

function elevationFailedByPattern(
  patterns: RegExp[],
): (code: number, stderr: string) => boolean {
  return (code, stderr) => code !== 0 && patterns.some((p) => p.test(stderr));
}

const AUTH_RE = [
  /authentication is required/i,
  /a password is required/i,
  /no password was provided/i,
  /no askpass program/i,
  /not allowed to execute/i,
  /is not in the sudoers file/i,
];

/** The `--network` mode every container route uses. */
function networkArg(g: StrategyConfig): string {
  const mode = (g.containerNetwork || "none").trim() || "none";
  return `--network=${mode}`;
}

/**
 * A container runtime is only usable when its daemon is local. A remote
 * endpoint (`ssh://`, `tcp://`, or any non-empty `DOCKER_HOST`/`CONTAINER_HOST`)
 * would prove and then execute against *another* host while the caller believes
 * the operation ran locally, so the route is refused. A unix socket path is
 * local.
 */
export function containerEndpointIsLocal(endpoint: string): boolean {
  const value = (endpoint || "").trim();
  if (value === "") return true;
  return value.startsWith("unix://") || value.startsWith("/");
}

/** Precondition shared by every container route. */
function containerPrecondition(g: StrategyConfig): string | null {
  if (!containerEndpointIsLocal(g.containerEndpoint)) {
    return `container daemon is remote (${g.containerEndpoint}); refusing to act on another host — container routes are local-only`;
  }
  return null;
}

/** Common privileged, host-root-mounted `run` argv for a container runtime. */
function containerRunArgv(
  tool: string,
  g: StrategyConfig,
  shellCommand: string,
): string[] {
  return [
    tool,
    "run",
    "--rm",
    "--privileged",
    "--pid=host",
    networkArg(g),
    "-v",
    "/:/host",
    "--entrypoint",
    "/bin/sh",
    g.containerImage,
    "-c",
    shellCommand,
  ];
}

/** `docker info` security options include "rootless" for a rootless daemon. */
export function dockerIsRootless(output: string): boolean {
  return /rootless/i.test(output);
}

/** `podman info` rootless flag: bare `true`, or a JSON `"rootless": true`. */
export function podmanIsRootless(output: string): boolean {
  const trimmed = output.trim();
  if (/^true$/i.test(trimmed)) return true;
  return /"?rootless"?\s*[:=]\s*true/i.test(output);
}

/** The full catalogue, keyed by id. */
export const STRATEGIES: Record<string, Strategy> = {
  "sudo-n": {
    id: "sudo-n",
    class: "local",
    tool: "sudo",
    riskNote:
      "Full root when a NOPASSWD or cached credential exists for this user. The probe runs `sudo -n true`, so a sudoers rule scoped to a specific command (not a broad NOPASSWD grant) is reported unavailable — a conservative fail-closed false negative, never an unsafe elevation. Note: a cached sudo timestamp also proves the probe, so route selection here is time-dependent — it succeeds for ~15 minutes after any interactive sudo, and the probe itself refreshes the cache; drop sudo-n from strategyOrder or pin another strategy for deterministic scheduling.",
    sideEffects: "none",
    precondition: () => null,
    probeArgv: () => ["sudo", "-n", "true"],
    probeOk: (r) => r.code === 0,
    build: (argv) => ["sudo", "-n", "--", ...argv],
    elevationFailed: elevationFailedByPattern(AUTH_RE),
  },
  "doas-n": {
    id: "doas-n",
    class: "local",
    tool: "doas",
    riskNote:
      "Full root when a `permit nopass` rule covers this user. The probe runs a representative `doas -n id -u`; a `nopass` rule scoped to a specific command is reported unavailable — a conservative fail-closed false negative.",
    sideEffects: "none",
    precondition: () => null,
    probeArgv: () => ["doas", "-n", ID, "-u"],
    probeOk: uidIsZero,
    build: (argv) => ["doas", "-n", ...argv],
    elevationFailed: elevationFailedByPattern([
      ...AUTH_RE,
      /permission denied/i,
    ]),
  },
  run0: {
    id: "run0",
    class: "local",
    tool: "run0",
    riskNote: "Full root via polkit and the systemd manager; no setuid binary.",
    sideEffects: "none",
    precondition: () => null,
    probeArgv: () => ["run0", "--no-ask-password", "--pipe", ID, "-u"],
    probeOk: uidIsZero,
    build: (argv) => ["run0", "--no-ask-password", "--pipe", ENV, ...argv],
    elevationFailed: elevationFailedByPattern([
      /requires interactive authentication/i,
      /access denied/i,
      /failed to start transient/i,
    ]),
  },
  "systemd-run": {
    id: "systemd-run",
    class: "local",
    tool: "systemd-run",
    riskNote:
      "Full root via a polkit-authorised transient unit on the system bus.",
    sideEffects: "none",
    precondition: () => null,
    probeArgv: () => [
      "systemd-run",
      "--system",
      "--uid=0",
      "--pipe",
      "--wait",
      ID,
      "-u",
    ],
    probeOk: uidIsZero,
    build: (
      argv,
    ) => [
      "systemd-run",
      "--system",
      "--uid=0",
      "--pipe",
      "--wait",
      ENV,
      ...argv,
    ],
    elevationFailed: elevationFailedByPattern([
      /access denied/i,
      /authentication is required/i,
      /failed to (start|create)/i,
    ]),
  },
  pkexec: {
    id: "pkexec",
    class: "local",
    tool: "pkexec",
    riskNote:
      "Full root via polkit. `--disable-internal-agent` stops pkexec's internal prompt only — an external desktop agent can still prompt, so a prompt or timeout means unavailable.",
    sideEffects: "none",
    precondition: () => null,
    probeArgv: () => ["pkexec", "--disable-internal-agent", ID, "-u"],
    probeOk: uidIsZero,
    build: (argv) => ["pkexec", "--disable-internal-agent", ENV, ...argv],
    elevationFailed: elevationFailedByPattern([
      /not authorized/i,
      /no authentication agent/i,
      /dismissed/i,
    ]),
  },
  nsenter: {
    id: "nsenter",
    class: "capability",
    tool: "nsenter",
    riskNote:
      "Host root by entering PID 1's namespaces (CAP_SYS_ADMIN) and re-entering uid 0 (CAP_SETUID/CAP_SETGID).",
    sideEffects: "none",
    precondition: () => null,
    probeArgv: () => [
      "nsenter",
      "--target",
      "1",
      "--mount",
      "--uts",
      "--ipc",
      "--net",
      "--pid",
      "--",
      "setpriv",
      "--reuid=0",
      "--regid=0",
      "--clear-groups",
      ID,
      "-u",
    ],
    probeOk: uidIsZero,
    build: (
      argv,
    ) => [
      "nsenter",
      "--target",
      "1",
      "--mount",
      "--uts",
      "--ipc",
      "--net",
      "--pid",
      "--",
      "setpriv",
      "--reuid=0",
      "--regid=0",
      "--clear-groups",
      ENV,
      ...argv,
    ],
    elevationFailed: elevationFailedByPattern([
      /operation not permitted|permission denied/i,
    ]),
  },
  setpriv: {
    id: "setpriv",
    class: "capability",
    tool: "setpriv",
    riskNote:
      "Root by re-entering uid 0 when CAP_SETUID/CAP_SETGID are already held.",
    sideEffects: "none",
    precondition: () => null,
    probeArgv:
      () => ["setpriv", "--reuid=0", "--regid=0", "--clear-groups", ID, "-u"],
    probeOk: uidIsZero,
    build: (
      argv,
    ) => ["setpriv", "--reuid=0", "--regid=0", "--clear-groups", ENV, ...argv],
    elevationFailed: elevationFailedByPattern([
      /operation not permitted|permission denied/i,
    ]),
  },
  "ssh-root": {
    id: "ssh-root",
    class: "remote",
    tool: "ssh",
    riskNote:
      "Remote full root over ssh; requires a root key and a pinned host key. Targets another host, so local-only operations refuse it.",
    sideEffects: "none",
    precondition: (g) => (g.sshHost ? null : "sshHost is not configured"),
    probeArgv: (g) => [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      ...(g.sshKnownHosts
        ? ["-o", `UserKnownHostsFile=${g.sshKnownHosts}`]
        : []),
      `root@${g.sshHost}`,
      ID,
      "-u",
    ],
    probeOk: uidIsZero,
    build: (argv, g) => [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      ...(g.sshKnownHosts
        ? ["-o", `UserKnownHostsFile=${g.sshKnownHosts}`]
        : []),
      `root@${g.sshHost}`,
      shellJoin(argv),
    ],
    elevationFailed: elevationFailedByPattern([
      /permission denied/i,
      /host key verification failed/i,
      /batchmode/i,
      /no such file/i,
    ]),
  },
  "docker-run": {
    id: "docker-run",
    class: "container",
    tool: "docker",
    riskNote:
      "Root-equivalent by design for the docker group. Starts a privileged container with the host root mounted at /host and proves host root by reading the host's machine-id. A rootless daemon is rejected at probe.",
    sideEffects: "creates-container",
    precondition: containerPrecondition,
    rootless: {
      argv: () => ["docker", "info", "--format", "{{json .SecurityOptions}}"],
      isRootless: dockerIsRootless,
    },
    probeArgv: (g) =>
      containerRunArgv(
        "docker",
        g,
        "exec chroot /host cat /etc/machine-id",
      ),
    probeOk: (r) => r.code === 0 && r.stdout.trim().length > 0,
    build: (argv, g) =>
      containerRunArgv("docker", g, 'exec chroot /host "$@"').concat([
        "swamp-sudo",
        ...argv,
      ]),
    elevationFailed: elevationFailedByPattern([
      /cannot connect to the docker daemon|permission denied/i,
      /docker:.*(error|invalid|unable)/i,
    ]),
  },
  "podman-run": {
    id: "podman-run",
    class: "container",
    tool: "podman",
    riskNote:
      "Root-equivalent for the podman group when the daemon runs as root. Rootless podman cannot yield host root and is rejected at probe.",
    sideEffects: "creates-container",
    precondition: containerPrecondition,
    rootless: {
      argv: () => ["podman", "info", "--format", "{{.Host.Security.Rootless}}"],
      isRootless: (out) => /true/i.test(out),
    },
    probeArgv: (g) =>
      containerRunArgv(
        "podman",
        g,
        "exec chroot /host cat /etc/machine-id",
      ),
    probeOk: (r) => r.code === 0 && r.stdout.trim().length > 0,
    build: (argv, g) =>
      containerRunArgv("podman", g, 'exec chroot /host "$@"').concat([
        "swamp-sudo",
        ...argv,
      ]),
    elevationFailed: elevationFailedByPattern([
      /cannot connect|permission denied|rootless/i,
    ]),
  },
  "nerdctl-run": {
    id: "nerdctl-run",
    class: "container",
    tool: "nerdctl",
    riskNote:
      "Root-equivalent for the containerd socket group when the daemon runs as root. Rootless containerd cannot yield host root; this route does not yet detect rootless, so host-root is only proven by the probe.",
    sideEffects: "creates-container",
    precondition: containerPrecondition,
    probeArgv: (g) =>
      containerRunArgv(
        "nerdctl",
        g,
        "exec chroot /host cat /etc/machine-id",
      ),
    probeOk: (r) => r.code === 0 && r.stdout.trim().length > 0,
    build: (argv, g) =>
      containerRunArgv("nerdctl", g, 'exec chroot /host "$@"').concat([
        "swamp-sudo",
        ...argv,
      ]),
    elevationFailed: elevationFailedByPattern([
      /cannot connect|permission denied|rootless/i,
    ]),
  },
  "k8s-node": {
    id: "k8s-node",
    class: "orchestrator",
    tool: "kubectl",
    riskNote:
      "Root on a cluster node via a privileged pod. RBAC is the grant. Starts a transient pod removed with --rm.",
    sideEffects: "creates-pod",
    precondition: (g) => (g.k8sNode ? null : "k8sNode is not configured"),
    probeArgv: (g) =>
      k8sRunArgv(g, ["cat", "/etc/machine-id"], `${g.k8sRunName}-probe`),
    probeOk: (r) => r.code === 0 && /[0-9a-f]{8,}/i.test(r.stdout),
    build: (argv, g) => k8sRunArgv(g, argv, `${g.k8sRunName}-run`),
    elevationFailed: elevationFailedByPattern([
      /forbidden|unauthorized|error from server/i,
    ]),
  },
  "ssm-run": {
    id: "ssm-run",
    class: "oob",
    tool: "aws",
    riskNote:
      "Out-of-band: the AWS SSM agent runs as root on the instance. Sending and polling is multi-step, so this route is not implemented by the argv executor and is never selectable.",
    sideEffects: "remote-api",
    precondition: (g) =>
      g.ssmInstanceId
        ? "ssm-run requires the multi-step @swamp/aws/ssm model; not implemented in the argv executor"
        : "ssmInstanceId is not configured",
    probeArgv: () => [],
    probeOk: () => false,
    build: () => {
      throw new Error(
        "ssm-run is not implemented by the argv executor; use @swamp/aws/ssm",
      );
    },
    elevationFailed: () => false,
  },
};

/** The default order: locals, capabilities, remote, containers, k8s. */
export const DEFAULT_STRATEGY_ORDER: string[] = [
  "sudo-n",
  "doas-n",
  "run0",
  "systemd-run",
  "pkexec",
  "nsenter",
  "setpriv",
  "ssh-root",
  "docker-run",
  "podman-run",
  "nerdctl-run",
  "k8s-node",
  "ssm-run",
];

/** Build a `kubectl run` argv that runs `argv` as root on the configured node. */
function k8sRunArgv(g: StrategyConfig, argv: string[], name: string): string[] {
  const overrides = {
    apiVersion: "v1",
    spec: {
      nodeName: g.k8sNode,
      hostPID: true,
      hostNetwork: true,
      restartPolicy: "Never",
      containers: [
        {
          name: "c",
          image: g.containerImage,
          command: ["chroot", "/host", ...argv],
          securityContext: { privileged: true },
          volumeMounts: [{ name: "host", mountPath: "/host" }],
        },
      ],
      volumes: [{ name: "host", hostPath: { path: "/" } }],
    },
  };
  return [
    "kubectl",
    "run",
    name,
    "--rm",
    "-i",
    "--restart=Never",
    "--image",
    g.containerImage,
    "--overrides",
    JSON.stringify(overrides),
  ];
}

/** List every strategy id in the catalogue. */
export function listStrategyIds(): string[] {
  return Object.keys(STRATEGIES);
}

/** Look up a strategy by id, or undefined. */
export function getStrategy(id: string): Strategy | undefined {
  return STRATEGIES[id];
}

/** A parsed `/etc/group`-style membership list from `id -nG`. */
export function parseGroupList(idOutput: string): string[] {
  return idOutput.trim().split(/\s+/).filter((g) => g.length > 0);
}

/** Whether a file mode has the world-writable bit set. */
export function isWorldWritable(mode: number): boolean {
  return (mode & 0o002) === 0o002;
}
