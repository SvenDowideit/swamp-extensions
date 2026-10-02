/**
 * Generic systemd *user* service management.
 *
 * A swamp model type (`@svendowideit/systemd-service`) that idempotently
 * creates, starts, stops, and removes a systemd *user* service unit for any
 * service name and command line. It is a thin, generic wrapper around
 * `systemctl --user` and unit-file rendering — the caller supplies the service
 * name and the exact command line to run.
 *
 * Methods:
 *   - `createService` — write (or update) the unit file and `daemon-reload`.
 *                       Idempotent: if the unit already matches, it is left
 *                       untouched.
 *   - `startService`   — `loginctl enable-linger`, `systemctl --user enable
 *                       --now`, and verify it is active. Enabling lingering
 *                       makes the user's systemd manager (and its enabled user
 *                       services) start at boot, not just at login.
 *   - `stopService`    — `systemctl --user stop`.
 *   - `stopService`    — `systemctl --user stop`.
 *   - `restartService` — `systemctl --user restart` and verify it is active.
 *   - `removeService`  — stop, disable, delete the unit file, and `daemon-reload`.
 *   - `status`         — report active/enabled state.
 *   - `audit`          — every model of this type, its live systemd unit state,
 *                        declared and listening TCP ports, drift, and orphan
 *                        managed units, from one call.
 *
 * Because it is a normal model type, any other extension can call these methods
 * (e.g. via `swamp model @svendowideit/systemd-service method run createService
 * <name> --input ...`) to idempotently stand up a persistent service. This is
 * the intended way to run long-lived Deno web services and APIs (such as
 * `@svendowideit/news`'s feedback-server) under systemd.
 *
 * Linux-only: it shells out to `systemctl --user`. Pure helpers (unit
 * rendering, path expansion) are exported for unit testing.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  denoPath: z.string().default("~/.swamp/deno/deno").describe(
    "Path to the Deno binary used to run Deno services (defaults to swamp's bundled Deno)",
  ),
  unitDir: z.string().default("~/.config/systemd/user").describe(
    "Directory where systemd user unit files are written",
  ),
  cgroupRoot: z.string().default("/sys/fs/cgroup").describe(
    "Mount point of the cgroup v2 hierarchy, used by `audit` to map a unit to its processes",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CreateServiceArgsSchema = z.object({
  serviceName: z.string().min(1).describe(
    "systemd user service name (without the .service suffix)",
  ),
  command: z.string().min(1).describe(
    "Full command line the service runs (e.g. ~/.swamp/deno/deno run --allow-net scripts/feedback-server.ts)",
  ),
  description: z.string().optional().describe(
    "Human-readable description for the [Unit] section",
  ),
  workingDirectory: z.string().optional().describe(
    "Working directory for the service (WorkingDirectory=)",
  ),
  environment: z.array(z.string()).default([]).describe(
    "Environment variables as KEY=VALUE strings (Environment=)",
  ),
  restart: z.string().default("on-failure").describe(
    "Restart= policy (e.g. on-failure, always, no)",
  ),
  restartSec: z.string().default("5").describe(
    "RestartSec= delay between restarts",
  ),
  after: z.array(z.string()).default(["network-online.target"]).describe(
    "After= dependencies",
  ),
  wants: z.array(z.string()).default(["network-online.target"]).describe(
    "Wants= dependencies",
  ),
  force: z.boolean().default(false).describe(
    "Rewrite the unit file even if it already matches",
  ),
});

const ServiceNameArgsSchema = z.object({
  serviceName: z.string().min(1).describe(
    "systemd user service name (without the .service suffix)",
  ),
});

const StartArgsSchema = ServiceNameArgsSchema.extend({
  linger: z.boolean().default(true).describe(
    "Enable user lingering so this user's systemd manager (and its enabled user services) start at boot, not just at login. Set false to leave the current login-only behavior",
  ),
});

const StatusArgsSchema = z.object({});

const AuditArgsSchema = z.object({
  serviceName: z.string().default("all").describe(
    "Which service(s) to audit: 'all' (default) reports every model of this type; any other value audits only the model whose name or managed unit matches that service name, and errors if none is found",
  ),
});

// ---------------------------------------------------------------------------
// Audit schemas
// ---------------------------------------------------------------------------

/** A listening TCP socket, with its owning process when `ss` could see one. */
const PortListenerSchema = z.object({
  protocol: z.string(),
  localAddress: z.string(),
  port: z.number().int(),
  process: z.string(),
  pid: z.number().int(),
});

const AuditedServiceSchema = z.object({
  modelName: z.string(),
  serviceName: z.string(),
  unitPath: z.string(),
  exists: z.boolean(),
  state: z.string(),
  loadState: z.string(),
  activeState: z.string(),
  subState: z.string(),
  unitFileState: z.string(),
  mainPid: z.number().int(),
  declaredPorts: z.array(z.number().int()),
  listeningPorts: z.array(PortListenerSchema),
  reportedActive: z.boolean().nullable(),
  reportedEnabled: z.boolean().nullable(),
  reportedAt: z.string(),
  drift: z.boolean(),
});

const AuditOutputSchema = z.object({
  scope: z.string(),
  services: z.array(AuditedServiceSchema),
  modelCount: z.number().int(),
  runningCount: z.number().int(),
  failedCount: z.number().int(),
  absentCount: z.number().int(),
  orphanUnits: z.array(z.string()),
  auditedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

const ServiceOutputSchema = z.object({
  serviceName: z.string(),
  unitPath: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  checkedAt: z.string(),
});

const CreateOutputSchema = z.object({
  serviceName: z.string(),
  unitPath: z.string(),
  written: z.boolean(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/**
 * Assert a service name is safe to use as a unit file name.
 *
 * The name becomes part of a path (`${unitDir}/${name}.service`), so a `/`, a
 * `..`, or a null byte would let a caller write or delete a unit file anywhere
 * on disk. systemd's own unit-name rules also forbid these, so this only
 * rejects what systemd would reject anyway.
 */
export function assertValidServiceName(serviceName: string): void {
  if (
    serviceName.length === 0 ||
    serviceName.includes("/") ||
    serviceName.includes("\\") ||
    serviceName.includes("..") ||
    serviceName.includes("\0") ||
    serviceName.startsWith(".") ||
    /\s/.test(serviceName)
  ) {
    throw new Error(
      `Invalid service name '${serviceName}': systemd unit names must not be empty or contain '/', '\\', '..', whitespace, or null bytes`,
    );
  }
}

/**
 * Reject a value that would inject extra unit directives.
 *
 * The unit file is line-oriented: a newline or carriage return inside
 * `command`, `description`, `workingDirectory`, or an `environment` entry would
 * start a new directive, so a caller could add `User=root`, `ExecStartPre=…`,
 * or any other directive. Reject rather than silently strip so the caller knows
 * their input was not used as intended.
 */
export function assertNoNewlines(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Invalid ${field}: must not contain newlines (a newline would inject extra systemd unit directives)`,
    );
  }
}

/** Render a systemd *user* service unit file for an arbitrary command line. */
export function renderServiceUnit(opts: {
  serviceName: string;
  command: string;
  description?: string;
  workingDirectory?: string;
  environment: string[];
  restart: string;
  restartSec: string;
  after: string[];
  wants: string[];
}): string {
  const {
    serviceName,
    command,
    description,
    workingDirectory,
    environment,
    restart,
    restartSec,
    after,
    wants,
  } = opts;
  assertValidServiceName(serviceName);
  assertNoNewlines("command", command);
  if (description !== undefined) assertNoNewlines("description", description);
  if (workingDirectory !== undefined) {
    assertNoNewlines("workingDirectory", workingDirectory);
  }
  for (const env of environment) assertNoNewlines("environment", env);
  for (const a of after) assertNoNewlines("after", a);
  for (const w of wants) assertNoNewlines("wants", w);
  const lines: string[] = [
    `# Managed by @svendowideit/systemd-service — do not edit by hand.`,
    `[Unit]`,
    `Description=${description ?? serviceName}`,
  ];
  for (const a of after) lines.push(`After=${a}`);
  for (const w of wants) lines.push(`Wants=${w}`);
  lines.push(``, `[Service]`, `Type=simple`, `ExecStart=${command}`);
  if (workingDirectory) lines.push(`WorkingDirectory=${workingDirectory}`);
  for (const env of environment) lines.push(`Environment=${env}`);
  lines.push(
    `Restart=${restart}`,
    `RestartSec=${restartSec}`,
    `TimeoutStopSec=5`,
    `PrivateTmp=true`,
    `ProtectSystem=full`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

type CmdResult = { stdout: string; stderr: string; code: number };

async function runCmd(
  binary: string,
  args: string[],
): Promise<CmdResult> {
  try {
    const proc = new Deno.Command(binary, {
      args,
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

async function systemctl(
  args: string[],
): Promise<CmdResult> {
  return await runCmd("systemctl", ["--user", ...args]);
}

/**
 * Whether a `systemctl --user stop` failure just means the unit was not loaded.
 *
 * Stopping an already-stopped or never-created unit exits 5 with "Unit … not
 * loaded". Callers treat that as success so `stopService` is idempotent; a
 * genuine failure (permission, bus error) is distinguished and still throws.
 */
export function isAlreadyStopped(result: {
  stdout: string;
  stderr: string;
  code: number;
}): boolean {
  if (result.code === 0) return true;
  return result.code === 5 &&
    /not loaded|not found/i.test(`${result.stderr}${result.stdout}`);
}

/** One listening TCP socket parsed from `ss -Hltnp`. */
export interface PortListener {
  protocol: string;
  localAddress: string;
  port: number;
  process: string;
  pid: number;
}

/**
 * Best-effort TCP ports a rendered unit declares it will listen on.
 *
 * The unit DSL has no "ports" concept, so we scan the rendered ExecStart and
 * Environment= lines for `--port 8765`, `--port=8765`, `-p 8765`,
 * `PORT=8765`, and `host:port` (e.g. `--host 127.0.0.1 --port 8765`). It is
 * deliberately a hint — the authoritative list of ports actually in use comes
 * from the live process (see {@link parseSsListeners}).
 */
export function parseDeclaredPorts(unitContents: string[]): number[] {
  const ports = new Set<number>();
  const add = (value: number) => {
    if (Number.isInteger(value) && value > 0 && value <= 65535) {
      ports.add(value);
    }
  };
  for (const raw of unitContents) {
    const line = raw.trim();
    // Env-style: PORT=8765 (also e.g. GTD_PORT=8878, PULSE_PORT=8899, and
    // inside an `Environment=GTD_PORT=8878` unit line).
    const env = line.match(/\b\w*PORT\s*=\s*(\d{1,5})\b/i);
    if (env) add(Number(env[1]));

    // Flag-style: --port 8765 / --port=8765 / -p 8765 / -p=8765.
    for (const m of line.matchAll(/--?p(?:ort)?[=\s]+(\d{1,5})\b/gi)) {
      add(Number(m[1]));
    }

    // host:port (only where the port is a standalone token).
    const hostPort = line.match(
      /(?:^|\s|[="'])(?:\[[0-9a-fA-F:]+\]|[0-9a-zA-Z._-]+):(\d{2,5})(?:\b|\/)/,
    );
    if (hostPort) add(Number(hostPort[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Parse `ss -Hltnp` (or `ss -Hltn`) output into listening TCP sockets.
 *
 * `ss` without `-p` (or without privileges) simply reports no process, so the
 * process/pid fields are empty/0 rather than the row being dropped. IPv6
 * addresses are bracketed and may carry a `%iface` suffix (e.g. `[::1]%lo`);
 * both are handled.
 */
export function parseSsListeners(output: string): PortListener[] {
  const listeners: PortListener[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || !line.startsWith("LISTEN")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 5) continue;
    const local = fields[3];
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    const port = Number(local.slice(colon + 1));
    if (!Number.isInteger(port) || port <= 0) continue;

    let address = local.slice(0, colon);
    const scope = address.lastIndexOf("%");
    if (scope > address.indexOf("]")) address = address.slice(0, scope);

    const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    listeners.push({
      protocol: "tcp",
      localAddress: address,
      port,
      process: proc ? proc[1] : "",
      pid: proc ? Number(proc[2]) : 0,
    });
  }
  return listeners;
}

/** A compact, human-readable state derived from `systemctl show` properties. */
export function stateFor(show: Record<string, string>): string {
  const load = show.LoadState ?? "";
  const active = show.ActiveState ?? "unknown";
  const sub = show.SubState ?? "";
  if (load === "not-found" || active === "inactive") return "not-found";
  if (active === "failed") return "failed";
  if (active === "active") return "running";
  if (active === "activating") {
    return sub === "auto-restart" ? "restarting" : "starting";
  }
  if (active === "deactivating") return "stopping";
  return active || "unknown";
}

/** One row of the audit table rendered into the log. */
export interface AuditTableRow {
  modelName: string;
  serviceName: string;
  state: string;
  unitFileState: string;
  declaredPorts: number[];
  listeningPorts: number[];
  drift: boolean;
}

/** Pad-or-truncate a cell to a fixed width for the aligned log table. */
function cell(value: string, width: number): string {
  if (value.length === width) return value;
  if (value.length > width) return value.slice(0, width - 1) + "…";
  return value + " ".repeat(width - value.length);
}

/**
 * Render the audit rows as an aligned, loggable table. Ports list their
 * declared count first and their live-listening count in brackets, and a `!`
 * marks a row whose last reported state is stale (drift).
 */
export function renderAuditTable(rows: AuditTableRow[]): string {
  const header = [
    "MODEL",
    "SERVICE",
    "STATE",
    "ENABLED",
    "DECLARED",
    "LISTENING",
    "DRIFT",
  ];
  const widths = [22, 22, 11, 9, 8, 9, 5];
  const line = (values: string[]) =>
    values.map((v, i) => cell(v, widths[i])).join("  ");

  const body = rows.map((r) =>
    line([
      r.modelName,
      r.serviceName,
      r.state,
      r.unitFileState || "-",
      String(r.declaredPorts.length),
      r.listeningPorts.length > 0 ? `[${r.listeningPorts.join(",")}]` : "-",
      r.drift ? "!" : "",
    ])
  );

  return [line(header), ...body].join("\n");
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

async function writeUnitFile(
  unitPath: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(dirnameOf(unitPath), { recursive: true });
  await Deno.writeTextFile(unitPath, content);
}

async function daemonReload(): Promise<void> {
  const reload = await systemctl(["daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(
      `systemctl --user daemon-reload failed (${reload.code}): ${
        reload.stderr || reload.stdout
      }`,
    );
  }
}

/** The `systemctl --user show` properties `audit` reads, as a flat map. */
const SHOW_PROPS = [
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "MainPID",
  "ControlGroup",
] as const;

/**
 * Read one unit's state via `systemctl --user show`. Never throws: a missing
 * unit or an unavailable systemd bus yields a map that reports it as absent.
 */
async function showUnit(
  serviceName: string,
): Promise<Record<string, string>> {
  const result = await systemctl([
    "show",
    serviceName,
    ...SHOW_PROPS.map((p) => `-p${p}`),
  ]);
  const map: Record<string, string> = {};
  if (result.code !== 0) return map;
  for (const line of result.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

/** Read a unit file's lines, or null when it does not exist. */
async function readUnitLines(unitPath: string): Promise<string[] | null> {
  try {
    return (await Deno.readTextFile(unitPath)).split("\n");
  } catch {
    return null;
  }
}

/** Snapshot of currently listening TCP sockets, best-effort via `ss`. */
async function listeningPorts(): Promise<PortListener[]> {
  const result = await runCmd("ss", ["-Hltnp"]);
  if (result.code !== 0) {
    // `ss -p` can require privileges in some environments; retry without it.
    const plain = await runCmd("ss", ["-Hltn"]);
    return plain.code === 0 ? parseSsListeners(plain.stdout) : [];
  }
  return parseSsListeners(result.stdout);
}

/**
 * Parse the decimal PIDs out of a cgroup v2 `cgroup.procs` file (one pid per
 * line). Non-numeric lines are ignored so a missing/unreadable file is empty.
 */
export function parseCgroupPids(contents: string): number[] {
  const pids: number[] = [];
  for (const line of contents.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Every pid in a unit's cgroup (systemd places the service's MainPID and all
 * its children there). Best-effort: returns [] when cgroup v2 is unavailable
 * or the unit is not running, so `audit` still reports the declared ports.
 */
async function cgroupPids(
  cgroupRoot: string,
  serviceName: string,
): Promise<number[]> {
  const result = await systemctl(["show", serviceName, "-pControlGroup"]);
  if (result.code !== 0) return [];
  const path = result.stdout.split("\n")
    .find((l) => l.startsWith("ControlGroup="))
    ?.slice("ControlGroup=".length)
    .trim();
  if (!path) return [];
  try {
    const contents = await Deno.readTextFile(
      `${cgroupRoot}${path}/cgroup.procs`,
    );
    return parseCgroupPids(contents);
  } catch {
    return [];
  }
}

/** The configured cgroup v2 mount point, with any trailing slashes removed. */
export function resolveCgroupRoot(configured: string): string {
  return (configured || "/sys/fs/cgroup").replace(/\/+$/, "");
}

/** The raw type string of a definition-repository entry. */
function rawTypeOf(type: unknown): string {
  if (typeof type === "string") return type;
  if (type && typeof type === "object") {
    const t = type as { raw?: unknown; normalized?: unknown };
    if (typeof t.raw === "string") return t.raw;
    if (typeof t.normalized === "string") return t.normalized;
  }
  return "";
}

/** Pull a boolean `active`/`enabled` from a stored resource, else null. */
function reportedFlag(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  definition: {
    id: string;
    name: string;
    version: string;
    tags: Record<string, string>;
  };
  /**
   * Query data artifacts across every model with a CEL predicate. Provided by
   * swamp's execution context; absent in some test fixtures, so callers guard.
   */
  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<Array<Record<string, unknown> | unknown>>;
  /**
   * Repository for definitions. Lets `audit` enumerate every model of this
   * type even before it has produced any data. Present in production but not
   * in every test fixture, so `audit` treats it as best-effort.
   */
  definitionRepository?: {
    findAllGlobal: () => Promise<
      Array<{
        definition: { id: string; name: string };
        type: { raw?: string; normalized?: string } | string;
      }>
    >;
  };
};

/**
 * Model definition for generic systemd *user* service management.
 *
 * Exposes `createService`, `startService`, `stopService`, `restartService`,
 * `removeService`, and `status`, writing the `create` and `service` resources.
 */
export const model = {
  type: "@svendowideit/systemd-service",
  version: "2026.10.02.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.11.1",
      description:
        "startService now enables user lingering (loginctl enable-linger) by default so user services start at boot; new startService.linger arg. Global args unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.24.1",
      description:
        "Security and docs: service names are validated against systemd unit-name rules, and unit-directive injection through command/description/workingDirectory/environment/after/wants is rejected. No schema changes; global and method arguments are unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.30.1",
      description:
        "Add restartService: restart a user service and verify it is active, so a caller can make a running service pick up a replaced executable or an updated unit. No schema changes; global and existing method arguments are unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.1",
      description:
        "Add the `audit` method: one call reports models of this type with their live systemd unit state, declared and listening TCP ports, last reported state, drift, and orphan managed units, and logs an aligned table. `audit` takes an optional `serviceName` (default 'all': every model; otherwise a single matching model, erroring when absent). Adds the optional `cgroupRoot` global argument (default /sys/fs/cgroup), an `audit` resource, and the `@svendowideit/systemd-service-audit` workflow. Existing global and method arguments unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    service: {
      description: "systemd user service status",
      schema: ServiceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    create: {
      description: "Last createService result",
      schema: CreateOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    audit: {
      description:
        "Every model of this type, its systemd unit, state, and ports",
      schema: AuditOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    createService: {
      description:
        "Idempotently write (or update) a systemd user service unit and daemon-reload",
      arguments: CreateServiceArgsSchema,
      execute: async (
        args: z.infer<typeof CreateServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const unitPath = `${unitDir}/${args.serviceName}.service`;

        // systemd does not expand `~` in ExecStart, so expand it here.
        const command = expandHome(args.command);

        const unit = renderServiceUnit({
          serviceName: args.serviceName,
          command,
          description: args.description,
          workingDirectory: args.workingDirectory,
          environment: args.environment,
          restart: args.restart,
          restartSec: args.restartSec,
          after: args.after,
          wants: args.wants,
        });

        let written = false;
        let existing = "";
        try {
          existing = await Deno.readTextFile(unitPath);
        } catch {
          // unit does not exist yet
        }
        if (args.force || existing !== unit) {
          await writeUnitFile(unitPath, unit);
          written = true;
          context.logger?.info(
            "Wrote systemd user unit {serviceName} at {unitPath}",
            { serviceName: args.serviceName, unitPath },
          );
        } else {
          context.logger?.info(
            "Systemd user unit {serviceName} already up to date at {unitPath}",
            { serviceName: args.serviceName, unitPath },
          );
        }

        await daemonReload();

        const handle = await context.writeResource("create", "current", {
          serviceName: args.serviceName,
          unitPath,
          written,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startService: {
      description:
        "Start and enable a systemd user service, enable user lingering so it runs at boot, and verify it is active",
      arguments: StartArgsSchema,
      execute: async (
        args: z.infer<typeof StartArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);

        if (args.linger) {
          // No username arg => operate on the current user.
          const linger = await runCmd("loginctl", ["enable-linger"]);
          if (linger.code !== 0) {
            throw new Error(
              `loginctl enable-linger failed (${linger.code}): ${
                linger.stderr || linger.stdout
              } — user lingering is required for user services to start at boot`,
            );
          }
          context.logger?.info(
            "Enabled user lingering so {serviceName} starts at boot, not just at login",
            { serviceName: args.serviceName },
          );
        }

        const enable = await systemctl(["enable", "--now", args.serviceName]);
        if (enable.code !== 0) {
          throw new Error(
            `systemctl --user enable --now ${args.serviceName} failed (${enable.code}): ${
              enable.stderr || enable.stdout
            }`,
          );
        }

        const active = await systemctl(["is-active", args.serviceName]);
        const enabled = await systemctl(["is-enabled", args.serviceName]);
        if (active.code !== 0) {
          throw new Error(
            `Service ${args.serviceName} is not active: ${
              active.stderr || active.stdout
            }`,
          );
        }

        context.logger?.info(
          "Service {serviceName} is active; enabled: {enabled}",
          { serviceName: args.serviceName, enabled: enabled.code === 0 },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName: args.serviceName,
          unitPath: `${unitDir}/${args.serviceName}.service`,
          active: active.code === 0,
          enabled: enabled.code === 0,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stopService: {
      description: "Stop a systemd user service",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceNameArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        const stop = await systemctl(["stop", args.serviceName]);
        if (stop.code !== 0) {
          // Stopping an already-stopped or never-created unit exits 5 with
          // "Unit … not loaded". Treat that as success so `stopService` is
          // idempotent (a re-run must not fail); any other error still throws.
          if (!isAlreadyStopped(stop)) {
            throw new Error(
              `systemctl --user stop ${args.serviceName} failed (${stop.code}): ${
                stop.stderr || stop.stdout
              }`,
            );
          }
        }
        context.logger?.info("Stopped service {serviceName}", {
          serviceName: args.serviceName,
        });
        return { dataHandles: [] };
      },
    },

    restartService: {
      description:
        "Restart a systemd user service so it picks up a replaced executable or an updated unit, and verify it is active",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceNameArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);

        // `restart` starts the unit if it is not running and restarts it if it
        // is, so this is safe after an executable upgrade (which does not
        // restart an already-active unit on its own).
        const restart = await systemctl(["restart", args.serviceName]);
        if (restart.code !== 0) {
          throw new Error(
            `systemctl --user restart ${args.serviceName} failed (${restart.code}): ${
              restart.stderr || restart.stdout
            }`,
          );
        }

        const active = await systemctl(["is-active", args.serviceName]);
        const enabled = await systemctl(["is-enabled", args.serviceName]);
        if (active.code !== 0) {
          throw new Error(
            `Service ${args.serviceName} is not active after restart: ${
              active.stderr || active.stdout
            }`,
          );
        }

        context.logger?.info(
          "Restarted service {serviceName}; active: {active}, enabled: {enabled}",
          {
            serviceName: args.serviceName,
            active: active.code === 0,
            enabled: enabled.code === 0,
          },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName: args.serviceName,
          unitPath: `${unitDir}/${args.serviceName}.service`,
          active: active.code === 0,
          enabled: enabled.code === 0,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    removeService: {
      description:
        "Stop, disable, delete the unit file, and daemon-reload for a systemd user service",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceNameArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        assertValidServiceName(args.serviceName);
        const unitPath = `${unitDir}/${args.serviceName}.service`;

        // Best-effort stop/disable: the service may not exist or be running.
        await systemctl(["stop", args.serviceName]);
        await systemctl(["disable", args.serviceName]);

        try {
          await Deno.remove(unitPath);
          context.logger?.info("Removed unit file {unitPath}", { unitPath });
        } catch {
          // unit file already gone
        }

        await daemonReload();
        context.logger?.info("Removed service {serviceName}", {
          serviceName: args.serviceName,
        });
        return { dataHandles: [] };
      },
    },

    status: {
      description: "Report active/enabled state of a systemd user service",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const serviceName = context.definition.name;

        const active = await systemctl(["is-active", serviceName]);
        const enabled = await systemctl(["is-enabled", serviceName]);

        context.logger?.info(
          "Service {serviceName} active: {active}, enabled: {enabled}",
          {
            serviceName,
            active: active.code === 0,
            enabled: enabled.code === 0,
          },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath: `${unitDir}/${serviceName}.service`,
          active: active.code === 0,
          enabled: enabled.code === 0,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    audit: {
      description:
        "List every systemd-service model alongside its live systemd unit state and listening ports, from one call",
      arguments: AuditArgsSchema,
      execute: async (
        args: z.infer<typeof AuditArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const scope = (args.serviceName ?? "all").trim() || "all";

        // Every definition of this type, so a model with no service data yet
        // is still reported. Best-effort: test fixtures may omit the repo.
        const names = new Set<string>();
        try {
          const all = await context.definitionRepository?.findAllGlobal() ??
            [];
          for (const entry of all) {
            if (rawTypeOf(entry.type) === "@svendowideit/systemd-service") {
              names.add(entry.definition.name);
            }
          }
        } catch {
          // fall through to data-derived names
        }

        // Names that have produced data, with the service name and the last
        // reported active/enabled state.
        const reported = new Map<
          string,
          {
            serviceName: string;
            active: boolean | null;
            enabled: boolean | null;
            checkedAt: string;
          }
        >();
        let records: Array<Record<string, unknown>> = [];
        try {
          records = (await context.queryData?.(
            'modelType == "@svendowideit/systemd-service" && dataType == "resource" && (specName == "service" || specName == "create")',
          ) ?? []) as Array<Record<string, unknown>>;
        } catch {
          // queryData may be unavailable in tests; degrade to repo names only.
        }
        for (const rec of records) {
          const modelName = typeof rec.modelName === "string"
            ? rec.modelName
            : "";
          if (!modelName) continue;
          names.add(modelName);
          const attrs =
            (rec.attributes as Record<string, unknown> | undefined) ?? {};
          const content =
            (rec.content as Record<string, unknown> | undefined) ??
              attrs;
          const serviceName = (typeof content.serviceName === "string"
            ? content.serviceName
            : undefined) ??
            (typeof attrs.serviceName === "string"
              ? attrs.serviceName
              : modelName);
          const prev = reported.get(modelName);
          const isServiceSpec = rec.specName === "service";
          reported.set(modelName, {
            serviceName,
            active: isServiceSpec
              ? reportedFlag(content, "active")
              : prev?.active ?? null,
            enabled: isServiceSpec
              ? reportedFlag(content, "enabled")
              : prev?.enabled ?? null,
            checkedAt: (typeof content.checkedAt === "string"
              ? content.checkedAt
              : prev?.checkedAt) ?? "",
          });
        }

        // Some test fixtures expose neither a definition repository nor
        // queryData; fall back to the model instance's own stored resource so
        // the method still reports something.
        if (names.size === 0 && records.length === 0) {
          const own = await context.readResource("current").catch(() => null);
          if (own && typeof own.serviceName === "string") {
            names.add(context.definition.name);
            reported.set(context.definition.name, {
              serviceName: own.serviceName,
              active: reportedFlag(own, "active"),
              enabled: reportedFlag(own, "enabled"),
              checkedAt: typeof own.checkedAt === "string" ? own.checkedAt : "",
            });
          }
        }

        // Scope: the default "all" reports every model of this type; anything
        // else narrows to the matching model, or errors so a typo is not
        // silently reported as "nothing to see".
        const allMode = scope === "all";
        if (!allMode) {
          const matches = [...names].filter((n) =>
            n === scope || reported.get(n)?.serviceName === scope
          );
          if (matches.length === 0) {
            throw new Error(
              `No systemd-service model found matching '${scope}'. Pass 'all' ` +
                `to audit every model of this type, or one of the known model ` +
                `names: ${[...names].sort().join(", ") || "(none)"}`,
            );
          }
          names.clear();
          for (const n of matches) names.add(n);
        }

        const ports = await listeningPorts();

        const services = [];
        let runningCount = 0;
        let failedCount = 0;
        let absentCount = 0;
        const expectedUnits = new Set<string>();

        for (const modelName of [...names].sort()) {
          const info = reported.get(modelName);
          const serviceName = info?.serviceName ?? modelName;
          const unitPath = `${unitDir}/${serviceName}.service`;
          expectedUnits.add(`${serviceName}.service`);

          const show = await showUnit(serviceName);
          const state = stateFor(show);
          const exists = state !== "not-found";
          const mainPid = Number(show.MainPID ?? "0") || 0;

          if (
            state === "running" || state === "starting" ||
            state === "restarting"
          ) {
            runningCount++;
          } else if (state === "failed") {
            failedCount++;
          } else if (state === "not-found") {
            absentCount++;
          }

          // Declared ports come from the unit file; live ports from the
          // process tree (the unit's cgroup → its MainPID and children).
          const unitLines = await readUnitLines(unitPath);
          const declaredPorts = unitLines ? parseDeclaredPorts(unitLines) : [];
          const pids = new Set<number>();
          if (mainPid > 0) pids.add(mainPid);
          for (
            const pid of await cgroupPids(
              resolveCgroupRoot(g.cgroupRoot),
              serviceName,
            )
          ) {
            pids.add(pid);
          }
          const listeningPortsForUnit = ports.filter((p) =>
            p.pid > 0 && pids.has(p.pid)
          );

          // Drift = the last state a model reported disagrees with what
          // systemd says now (including a unit that has since disappeared).
          const drift = info != null &&
            ((info.active !== null && info.active !== (state === "running")) ||
              (info.enabled !== null &&
                info.enabled !== (show.UnitFileState === "enabled")));

          services.push({
            modelName,
            serviceName,
            unitPath,
            exists,
            state,
            loadState: show.LoadState ?? "not-found",
            activeState: show.ActiveState ?? "inactive",
            subState: show.SubState ?? "dead",
            unitFileState: show.UnitFileState ?? "",
            mainPid,
            declaredPorts,
            listeningPorts: listeningPortsForUnit,
            reportedActive: info?.active ?? null,
            reportedEnabled: info?.enabled ?? null,
            reportedAt: info?.checkedAt ?? "",
            drift,
          });
        }

        // Unit files managed by a swamp systemd-service model but with no
        // matching model — the ghost a `removeService` should have cleaned up.
        // Only meaningful for the whole-repo "all" audit: a scoped audit would
        // otherwise report every other model's unit as an orphan.
        const orphanUnits: string[] = [];
        if (allMode) {
          try {
            for await (const entry of Deno.readDir(unitDir)) {
              if (!entry.isFile || !entry.name.endsWith(".service")) continue;
              const path = `${unitDir}/${entry.name}`;
              const lines = await readUnitLines(path);
              if (
                !lines?.some((l) => l.includes("@svendowideit/systemd-service"))
              ) {
                continue;
              }
              if (!expectedUnits.has(entry.name)) orphanUnits.push(entry.name);
            }
          } catch {
            // unitDir does not exist yet — nothing to reconcile.
          }
        }
        orphanUnits.sort();

        // Log an aligned table so the whole picture is visible in terminal
        // output, not just by reading the resource afterwards.
        const table = renderAuditTable(services.map((s) => ({
          modelName: s.modelName,
          serviceName: s.serviceName,
          state: s.state,
          unitFileState: s.unitFileState,
          declaredPorts: s.declaredPorts,
          listeningPorts: s.listeningPorts.map((p) => p.port),
          drift: s.drift,
        })));
        context.logger?.info("Systemd service audit:\n{table}", { table });

        context.logger?.info(
          "Audit: {scope} → {models} model(s), {running} running, {failed} failed, {absent} absent, {orphans} orphan unit(s)",
          {
            scope: allMode ? "all" : scope,
            models: names.size,
            running: runningCount,
            failed: failedCount,
            absent: absentCount,
            orphans: orphanUnits.length,
          },
        );

        const handle = await context.writeResource("audit", "audit", {
          scope: allMode ? "all" : scope,
          services,
          modelCount: names.size,
          runningCount,
          failedCount,
          absentCount,
          orphanUnits,
          auditedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
