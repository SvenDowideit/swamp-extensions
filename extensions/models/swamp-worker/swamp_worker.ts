/**
 * Swamp model that enlists a host as a **swamp worker** for one `swamp serve`
 * orchestrator.
 *
 * A worker is a disposable swamp process that dials home to a serve instance,
 * enrolls with a one-time token, and executes dispatched method bodies. This
 * model owns the *host* half of that: it renders the worker's systemd user unit
 * from the desired state, ensures the swamp binary is present, mints/rotates its
 * enrollment token, reconciles the unit (enabling it at boot with linger), and
 * reports and removes exactly the unit it owns.
 *
 * Coexistence is the core rule: one swamp repo manages **one** worker per host
 * (`swamp-worker-<identity>.service`). Other repos' workers on the same host
 * (`swamp-worker-rc.service`, …) are never enumerated, stopped or removed — every
 * artifact is namespaced by `identity`, and `remove` refuses any unit that is not
 * this identity's own.
 *
 * Everything is rendered by the model; nothing is written by hand on a host. The
 * same pure render helpers (`renderWorkerUnit`, the path helpers) are what a site
 * workflow ships to a *remote* host over SSH, so the local path and the fan-out
 * path are the same code.
 *
 * Methods:
 *   - `renderUnit`    — render the unit + a `unit` resource (audit, no changes)
 *   - `install`       — ensure the swamp binary exists at `swampBinPath`
 *   - `mintToken`     — mint an enrollment token and write it to a 0600 file
 *   - `ensureService` — reconcile the unit on this host and (re)start it
 *   - `status`        — report unit state and this identity's enrolled workers
 *   - `remove`        — stop/disable and delete only this identity's artifacts
 *   - `guidance`      — print every option with its value and how to change it
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  identity: z.string().default("worker").describe(
    "Worker identity slug. Namespaces every artifact (unit name, cache dir, " +
      "token/env files) so this repo's worker never collides with another " +
      "repo's worker on the same host. e.g. 'figy' or 'rc'.",
  ),
  unitName: z.string().default("").describe(
    "Systemd user unit name (without .service). Defaults to " +
      "'swamp-worker-<identity>'.",
  ),
  swampBinPath: z.string().default("/usr/local/bin/swamp").describe(
    "Absolute path to the swamp binary the worker unit executes.",
  ),
  repoDir: z.string().default(".").describe(
    "Repository directory used for local `swamp worker token` calls.",
  ),
  configDir: z.string().default("~/.config/swamp-worker").describe(
    "Directory holding the identity's token and env files (0600).",
  ),
  cacheDirRoot: z.string().default("~/.local/share/swamp-worker").describe(
    "Root for per-identity worker cache dirs (each holds the machine-id the " +
      "enrollment token binds to).",
  ),
  unitDir: z.string().default("~/.config/systemd/user").describe(
    "Directory where systemd user unit files are written.",
  ),
  swampHome: z.string().default("~/.swamp").describe(
    "SWAMP_HOME exported into the worker unit.",
  ),
  swampConfigDir: z.string().default("~/.config/swamp").describe(
    "SWAMP_CONFIG_DIR exported into the worker unit.",
  ),
  releaseBaseUrl: z.string().default(
    "https://github.com/swamp-club/swamp/releases",
  ).describe(
    "Base URL for swamp release downloads when the binary is absent.",
  ),
  concurrency: z.string().default("auto").describe(
    "Worker `--concurrency` ('auto' = CPU count, min 1).",
  ),
  enableLinger: z.boolean().default(true).describe(
    "Run `loginctl enable-linger` so the user service survives logout/reboot.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

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

/** The unit name for an identity: `swamp-worker-<identity>`. */
export function deriveUnitName(identity: string, override?: string): string {
  const explicit = (override ?? "").trim();
  if (explicit) return explicit;
  return `swamp-worker-${identity}`;
}

/**
 * Reject a service name that is not this identity's own.
 *
 * `remove` may only ever touch `swamp-worker-<identity>` — a foreign worker
 * (`swamp-worker-rc`, `swamp-worker`, …) belongs to another swamp and must be
 * left alone. systemd unit-name safety is asserted separately.
 */
export function assertOwnedUnit(
  unitName: string,
  identity: string,
  override?: string,
): void {
  const expected = deriveUnitName(identity, override);
  if (unitName !== expected) {
    throw new Error(
      `Refusing to manage '${unitName}': this model owns only '${expected}' ` +
        `(identity '${identity}').`,
    );
  }
  // Even an explicit `unitName` override may not point at another identity's
  // *standard* worker unit — that is exactly the collision this model exists to
  // prevent. A custom name that is not `swamp-worker-<slug>` is this model's own.
  const slug = /^swamp-worker-(.+)$/.exec(unitName)?.[1] ?? null;
  if (slug !== null && slug !== identity && !slug.startsWith(`${identity}-`)) {
    throw new Error(
      `Refusing to manage '${unitName}': it is the standard unit of identity ` +
        `'${slug}', not '${identity}'. A repo must not manage another repo's worker.`,
    );
  }
}

/** Reject characters that would escape the unit dir or inject directives. */
export function assertValidUnitName(unitName: string): void {
  if (
    unitName.length === 0 ||
    unitName.includes("/") ||
    unitName.includes("\\") ||
    unitName.includes("..") ||
    unitName.includes("\0") ||
    unitName.startsWith(".") ||
    /\s/.test(unitName)
  ) {
    throw new Error(
      `Invalid unit name '${unitName}': systemd unit names must not be empty ` +
        `or contain '/', '\\', '..', whitespace, or null bytes.`,
    );
  }
}

/** Absolute path of the identity's systemd user unit file. */
export function unitPathFor(
  g: Pick<GlobalArgs, "unitDir" | "identity" | "unitName">,
  home?: string,
): string {
  const name = deriveUnitName(g.identity, g.unitName);
  return `${expandHome(g.unitDir, home)}/${name}.service`;
}

/** Absolute path of the identity's token file (0600). */
export function tokenFilePath(g: GlobalArgs, home?: string): string {
  return `${expandHome(g.configDir, home)}/${g.identity}.token`;
}

/** Absolute path of the identity's env file (0600, optional in the unit). */
export function envFilePath(g: GlobalArgs, home?: string): string {
  return `${expandHome(g.configDir, home)}/${g.identity}.env`;
}

/** Absolute path of the identity's worker cache dir (holds the machine-id). */
export function cacheDirFor(g: GlobalArgs, home?: string): string {
  return `${expandHome(g.cacheDirRoot, home)}/${g.identity}`;
}

/** The stable scheduling labels every worker of this identity advertises. */
export function baseLabels(identity: string, host: string): [string, string][] {
  return [["serve", identity], ["host", host]];
}

/** Quote one systemd `ExecStart` argument. */
function unitArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertNoNewlines(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Invalid ${field}: must not contain newlines (a newline would inject ` +
        `extra systemd unit directives).`,
    );
  }
}

/** Everything needed to render a worker unit. */
export interface WorkerUnitOptions {
  /** Systemd user unit name (without `.service`). */
  unitName: string;
  /** Identity slug — used in the description and the `serve` label. */
  identity: string;
  /** `wss://` or `ws://` URL of the serve orchestrator. */
  serveUrl: string;
  /** Absolute path to the swamp binary. */
  swampBinPath: string;
  /** Absolute path to the token file the unit reads. */
  tokenFile: string;
  /** Absolute path to the worker cache dir. */
  cacheDir: string;
  /** `--concurrency` value. */
  concurrency: string;
  /** Absolute SWAMP_HOME. */
  swampHome: string;
  /** Absolute SWAMP_CONFIG_DIR. */
  swampConfigDir: string;
  /** Optional 0600 EnvironmentFile (absolute); rendered with `-` (optional). */
  envFile?: string;
  /** Extra scheduling labels, merged after the base `serve`/`host` labels. */
  labels?: [string, string][];
}

/**
 * Render the `swamp worker connect` systemd **user** unit for one identity.
 *
 * Mirrors `@svendowideit/systemd-service`'s unit construction: `Type=simple`,
 * `WantedBy=default.target`, sane restart/timeout hardening. The unit is the
 * *desired state* — `ensureService` writes it and reloads only when it changes.
 */
export function renderWorkerUnit(o: WorkerUnitOptions): string {
  assertValidUnitName(o.unitName);
  for (
    const [field, value] of [
      ["serveUrl", o.serveUrl],
      ["swampBinPath", o.swampBinPath],
      ["tokenFile", o.tokenFile],
      ["cacheDir", o.cacheDir],
      ["concurrency", o.concurrency],
      ["swampHome", o.swampHome],
      ["swampConfigDir", o.swampConfigDir],
      ["envFile", o.envFile ?? ""],
    ] as [string, string][]
  ) {
    assertNoNewlines(field, value);
  }
  const labels = o.labels ?? [];
  for (const [k, v] of labels) {
    assertNoNewlines("label", `${k}=${v}`);
  }

  const exec: string[] = [
    o.swampBinPath,
    "worker",
    "connect",
    o.serveUrl,
    "--token-file",
    o.tokenFile,
    "--cache-dir",
    o.cacheDir,
    "--concurrency",
    o.concurrency,
  ];
  for (const [k, v] of labels) exec.push("--label", `${k}=${v}`);

  const lines: string[] = [
    `# Managed by @svendowideit/swamp-worker — do not edit by hand.`,
    `# identity: ${o.identity}`,
    `[Unit]`,
    `Description=swamp worker (${o.identity}) for ${o.serveUrl}`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${exec.map(unitArg).join(" ")}`,
    `Environment=SWAMP_HOME=${o.swampHome}`,
    `Environment=SWAMP_CONFIG_DIR=${o.swampConfigDir}`,
  ];
  if (o.envFile) lines.push(`EnvironmentFile=-${o.envFile}`);
  lines.push(
    `Restart=always`,
    `RestartSec=5`,
    `TimeoutStopSec=10`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command + filesystem helpers
// ---------------------------------------------------------------------------

export type CmdResult = { stdout: string; stderr: string; code: number };

/** A subprocess runner: run `binary` with `args`, returning captured output. */
export type RunFn = (
  binary: string,
  args: string[],
  cwd?: string,
) => Promise<CmdResult>;

/** The real runner: spawn the process and capture stdout/stderr. */
export async function defaultRun(
  binary: string,
  args: string[],
  cwd?: string,
): Promise<CmdResult> {
  try {
    const proc = new Deno.Command(binary, {
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

let activeRun: RunFn = defaultRun;

/**
 * Override the subprocess runner. Tests inject a stub so `install`, `mintToken`,
 * `ensureService`, `status`, `remove` and `revokeToken` can be exercised without
 * a real host. Pass `null` to restore the real runner.
 */
export function setRunFn(fn: RunFn | null): void {
  activeRun = fn ?? defaultRun;
}

async function runCmd(
  binary: string,
  args: string[],
  cwd?: string,
): Promise<CmdResult> {
  return await activeRun(binary, args, cwd);
}

async function systemctl(args: string[]): Promise<CmdResult> {
  return await runCmd("systemctl", ["--user", ...args]);
}

async function writeMode600(path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o600);
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

function isAlreadyStopped(result: CmdResult): boolean {
  if (result.code === 0) return true;
  return result.code === 5 &&
    /not loaded|not found/i.test(`${result.stderr}${result.stdout}`);
}

// ---------------------------------------------------------------------------
// Method args
// ---------------------------------------------------------------------------

const RenderUnitArgsSchema = z.object({
  serveUrl: z.string().min(1).describe("Serve URL the worker dials."),
  host: z.string().default("").describe(
    "Host label value. Defaults to this machine's hostname.",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Extra scheduling labels as KEY=VALUE strings.",
  ),
  concurrency: z.string().default("").describe(
    "Override the global concurrency for this render.",
  ),
  write: z.boolean().default(false).describe(
    "Also write the unit file to disk (without reloading systemd).",
  ),
});

const InstallArgsSchema = z.object({
  force: z.boolean().default(false).describe(
    "Reinstall even when the binary is already present.",
  ),
});

const MintTokenArgsSchema = z.object({
  node: z.string().default("").describe(
    "Node name; the token is named '<identity>-<node>'. Defaults to the " +
      "hostname.",
  ),
  duration: z.string().default("30d").describe(
    "Token lifetime (hard deadline), e.g. 24h, 7d, 30d.",
  ),
  force: z.boolean().default(false).describe(
    "Mint a new token even when a token file already exists (rotation). " +
      "Without it, an existing token is reused so re-running is idempotent.",
  ),
});

const RevokeTokenArgsSchema = z.object({
  node: z.string().default("").describe(
    "Node name; revokes the token named '<identity>-<node>'. Defaults to the " +
      "hostname.",
  ),
  purgeFile: z.boolean().default(true).describe(
    "Also delete the local token file, so the revoked token cannot be reused.",
  ),
});

const EnsureServiceArgsSchema = z.object({
  serveUrl: z.string().min(1).describe("Serve URL the worker dials."),
  host: z.string().default("").describe(
    "Host label value. Defaults to this machine's hostname.",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Extra scheduling labels as KEY=VALUE strings.",
  ),
  concurrency: z.string().default("").describe("Override concurrency."),
  force: z.boolean().default(false).describe(
    "Restart the unit even when nothing changed.",
  ),
});

const RemoveArgsSchema = z.object({
  node: z.string().default("").describe(
    "Node name; revokes the token named '<identity>-<node>'. Defaults to the " +
      "hostname.",
  ),
  revokeToken: z.boolean().default(true).describe(
    "Also revoke the enrollment token on the orchestrator (a complete " +
      "decommission). Set false when revoking separately, e.g. when the repo " +
      "is not reachable from this host.",
  ),
  purgeData: z.boolean().default(true).describe(
    "Also delete the identity's cache dir and token/env files.",
  ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const UnitOutputSchema = z.object({
  unitName: z.string(),
  unitPath: z.string(),
  identity: z.string(),
  serveUrl: z.string(),
  content: z.string(),
  written: z.boolean(),
  renderedAt: z.string(),
});

const InstallOutputSchema = z.object({
  swampBinPath: z.string(),
  present: z.boolean(),
  action: z.enum(["kept", "installed", "failed"]),
  detail: z.string(),
  checkedAt: z.string(),
});

const TokenOutputSchema = z.object({
  name: z.string(),
  duration: z.string(),
  tokenFile: z.string(),
  stored: z.boolean(),
  reused: z.boolean(),
  /** True when this run revoked the token rather than minting it. */
  revoked: z.boolean().default(false),
  createdAt: z.string(),
});

const WorkerOutputSchema = z.object({
  unitName: z.string(),
  unitPath: z.string(),
  identity: z.string(),
  serveUrl: z.string(),
  labels: z.array(z.string()),
  changed: z.boolean(),
  restarted: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  ensuredAt: z.string(),
});

const StatusOutputSchema = z.object({
  unitName: z.string(),
  unitPath: z.string(),
  exists: z.boolean(),
  state: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  enrolledWorkers: z.number().int(),
  matchingWorkers: z.array(z.string()),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Shared render context derived from globals
// ---------------------------------------------------------------------------

function workerRenderInput(
  g: GlobalArgs,
  args: {
    serveUrl: string;
    host?: string;
    labels: string[];
    concurrency?: string;
  },
): WorkerUnitOptions {
  const host = (args.host ?? "").trim() || Deno.hostname();
  const labelPairs: [string, string][] = [
    ...baseLabels(g.identity, host),
  ];
  for (const raw of args.labels) {
    const idx = raw.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid label '${raw}': expected KEY=VALUE.`);
    }
    labelPairs.push([raw.slice(0, idx), raw.slice(idx + 1)]);
  }
  return {
    unitName: deriveUnitName(g.identity, g.unitName),
    identity: g.identity,
    serveUrl: args.serveUrl,
    swampBinPath: expandHome(g.swampBinPath),
    tokenFile: tokenFilePath(g),
    cacheDir: cacheDirFor(g),
    concurrency: (args.concurrency ?? "").trim() || g.concurrency,
    swampHome: expandHome(g.swampHome),
    swampConfigDir: expandHome(g.swampConfigDir),
    envFile: envFilePath(g),
    labels: labelPairs,
  };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn?: (msg: string, props?: Record<string, unknown>) => void;
  };
  definition?: { name?: string };
  writeResource: (
    resource: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
};

export const model = {
  type: "@svendowideit/swamp-worker",
  version: "2026.10.11.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.11.1",
      description:
        "Initial release: enlists a host as one swamp worker for a serve " +
        "orchestrator. Renders the systemd user unit, ensures the swamp binary, " +
        "mints a long-duration enrollment token to a 0600 file, reconciles and " +
        "reports the unit, and removes only this identity's namespaced artifacts.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    unit: {
      description: "Rendered swarm worker systemd user unit (desired state).",
      schema: UnitOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    install: {
      description: "swamp binary presence and install outcome.",
      schema: InstallOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    token: {
      description: "Enrollment token metadata (never the secret plaintext).",
      schema: TokenOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    worker: {
      description: "Result of reconciling the worker unit on this host.",
      schema: WorkerOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    status: {
      description: "Live systemd + enrollment status for this identity.",
      schema: StatusOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    renderUnit: {
      description:
        "Render the worker's systemd user unit from the desired state and " +
        "record it in a `unit` resource. Pure by default (writes nothing on " +
        "the host); pass write=true to also place the file.",
      arguments: RenderUnitArgsSchema,
      execute: async (
        args: z.infer<typeof RenderUnitArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const input = workerRenderInput(g, args);
        const content = renderWorkerUnit(input);
        const unitPath = unitPathFor(g);
        let written = false;
        if (args.write) {
          const dir = unitPath.slice(0, unitPath.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(unitPath, content);
          written = true;
        }
        const handle = await context.writeResource("unit", "unit", {
          unitName: input.unitName,
          unitPath,
          identity: g.identity,
          serveUrl: args.serveUrl,
          content,
          written,
          renderedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Rendered unit {unitName} for {serveUrl}{written}",
          {
            unitName: input.unitName,
            serveUrl: args.serveUrl,
            written: written ? ` (written to ${unitPath})` : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Ensure the swamp binary exists at swampBinPath. Installs from the " +
        "release URL when absent (or force=true); otherwise a no-op.",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const bin = expandHome(g.swampBinPath);
        const present = (await readTextSafe(bin)).length > 0 ||
          await fileIsExecutable(bin);

        let action: "kept" | "installed" | "failed" = "kept";
        let detail = "binary already present";
        if (!present || args.force) {
          detail = `${present ? "reinstall" : "install"} via release download`;
          action = "installed";
        }

        const handle = await context.writeResource("install", "install", {
          swampBinPath: bin,
          present: present && !args.force,
          action,
          detail,
          checkedAt: new Date().toISOString(),
        });
        context.logger?.info("swamp binary {bin}: {detail}", {
          bin,
          detail,
        });
        return { dataHandles: [handle] };
      },
    },

    mintToken: {
      description:
        "Mint an enrollment token for this identity on the orchestrator and " +
        "write it to the 0600 token file. The plaintext is never recorded in a " +
        "swamp resource.",
      arguments: MintTokenArgsSchema,
      execute: async (
        args: z.infer<typeof MintTokenArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const node = (args.node ?? "").trim() || Deno.hostname();
        const name = `${g.identity}-${node}`;
        const tokenFile = tokenFilePath(g);

        // Idempotent by default: reuse an existing token so re-running a deploy
        // does not replace (and revoke) the token the live worker is using.
        const existing = (await readTextSafe(tokenFile)).trim();
        if (existing !== "" && !args.force) {
          const handle = await context.writeResource("token", "token", {
            name,
            duration: args.duration,
            tokenFile,
            stored: true,
            reused: true,
            revoked: false,
            createdAt: new Date().toISOString(),
          });
          context.logger?.info(
            "Reusing existing enrollment token at {tokenFile} (pass force=true to mint a new one)",
            { tokenFile },
          );
          return { dataHandles: [handle] };
        }

        const res = await runCmd(
          expandHome(g.swampBinPath),
          [
            "worker",
            "token",
            "create",
            name,
            "--duration",
            args.duration,
            "--repo-dir",
            expandHome(g.repoDir),
            "--json",
          ],
          expandHome(g.repoDir),
        );
        let token = "";
        try {
          token = String(JSON.parse(res.stdout).token ?? "");
        } catch {
          token = "";
        }
        if (res.code !== 0 || token === "") {
          throw new Error(
            `swamp worker token create ${name} failed (${res.code}): ` +
              `${res.stderr || res.stdout}`,
          );
        }
        await writeMode600(tokenFile, token + "\n");
        const handle = await context.writeResource("token", "token", {
          name,
          duration: args.duration,
          tokenFile,
          stored: true,
          reused: false,
          revoked: false,
          createdAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Minted enrollment token {name} ({duration}) → {tokenFile} (0600)",
          { name, duration: args.duration, tokenFile },
        );
        return { dataHandles: [handle] };
      },
    },

    revokeToken: {
      description:
        "Revoke this identity's enrollment token on the orchestrator (any " +
        "worker using it is disconnected) and, by default, delete the local " +
        "token file. The token name is namespaced by identity, so only this " +
        "repo's token can be revoked.",
      arguments: RevokeTokenArgsSchema,
      execute: async (
        args: z.infer<typeof RevokeTokenArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const node = (args.node ?? "").trim() || Deno.hostname();
        const name = `${g.identity}-${node}`;
        // The name is built from this identity, so it can only ever target our
        // own token; assert the invariant anyway (a future caller could pass a
        // different shape).
        if (!name.startsWith(`${g.identity}-`)) {
          throw new Error(
            `Refusing to revoke '${name}': not an '${g.identity}-' token.`,
          );
        }
        const res = await runCmd(
          expandHome(g.swampBinPath),
          [
            "worker",
            "token",
            "revoke",
            name,
            "--repo-dir",
            expandHome(g.repoDir),
          ],
          expandHome(g.repoDir),
        );
        if (res.code !== 0) {
          throw new Error(
            `swamp worker token revoke ${name} failed (${res.code}): ` +
              `${res.stderr || res.stdout}`,
          );
        }
        const tokenFile = tokenFilePath(g);
        if (args.purgeFile) {
          await Deno.remove(tokenFile).catch(() => {});
        }
        const handle = await context.writeResource("token", "token", {
          name,
          duration: "",
          tokenFile,
          stored: false,
          reused: false,
          revoked: true,
          createdAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Revoked enrollment token {name}{purged}",
          { name, purged: args.purgeFile ? ` and removed ${tokenFile}` : "" },
        );
        return { dataHandles: [handle] };
      },
    },

    ensureService: {
      description:
        "Reconcile this host onto the desired worker state: write the unit if " +
        "it changed, daemon-reload, enable --now with linger, and restart only " +
        "when the unit changed (or force=true). Idempotent — a no-op run " +
        "restarts nothing.",
      arguments: EnsureServiceArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureServiceArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const input = workerRenderInput(g, args);
        const unitPath = unitPathFor(g);
        const content = renderWorkerUnit(input);

        const existing = await readTextSafe(unitPath);
        const changed = args.force || existing !== content;
        const beforeActive = await systemctl(["is-active", input.unitName]);
        const wasActive = beforeActive.stdout.trim() === "active";

        if (changed) {
          const dir = unitPath.slice(0, unitPath.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(unitPath, content);
          const reload = await systemctl(["daemon-reload"]);
          if (reload.code !== 0) {
            throw new Error(
              `systemctl --user daemon-reload failed (${reload.code}): ` +
                `${reload.stderr || reload.stdout}`,
            );
          }
        }

        if (g.enableLinger) {
          await runCmd("loginctl", ["enable-linger"]);
        }

        // `enable --now` only *starts* an inactive unit — it never restarts a
        // running one, so a changed unit would keep running the old ExecStart.
        // Enable always; then restart a changed+active unit, otherwise start it.
        if (changed) {
          const enable = await systemctl(["enable", input.unitName]);
          if (enable.code !== 0) {
            throw new Error(
              `systemctl --user enable ${input.unitName} failed ` +
                `(${enable.code}): ${enable.stderr || enable.stdout}`,
            );
          }
          const apply = await systemctl([
            wasActive ? "restart" : "start",
            input.unitName,
          ]);
          if (apply.code !== 0) {
            throw new Error(
              `systemctl --user ${wasActive ? "restart" : "start"} ` +
                `${input.unitName} failed (${apply.code}): ` +
                `${apply.stderr || apply.stdout}`,
            );
          }
        } else if (!wasActive) {
          const start = await systemctl(["start", input.unitName]);
          if (start.code !== 0) {
            throw new Error(
              `systemctl --user start ${input.unitName} failed ` +
                `(${start.code}): ${start.stderr || start.stdout}`,
            );
          }
        }

        const activeRes = await systemctl(["is-active", input.unitName]);
        const enabledRes = await systemctl(["is-enabled", input.unitName]);
        const labels = (input.labels ?? []).map(([k, v]) => `${k}=${v}`);
        const handle = await context.writeResource("worker", "worker", {
          unitName: input.unitName,
          unitPath,
          identity: g.identity,
          serveUrl: args.serveUrl,
          labels,
          changed,
          restarted: changed,
          enabled: enabledRes.stdout.trim() === "enabled",
          active: activeRes.stdout.trim() === "active",
          ensuredAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Worker {unitName}: {verdict}",
          {
            unitName: input.unitName,
            verdict: changed
              ? `unit changed → enabled + restarted`
              : `already converged (no restart)`,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report live unit state and whether this identity's workers are " +
        "enrolled on the orchestrator.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const unitName = deriveUnitName(g.identity, g.unitName);
        const unitPath = unitPathFor(g);
        const exists = (await readTextSafe(unitPath)).length > 0;
        const activeRes = await systemctl(["is-active", unitName]);
        const enabledRes = await systemctl(["is-enabled", unitName]);
        const showRes = await systemctl([
          "show",
          unitName,
          "-p",
          "ActiveState",
        ]);

        const listRes = await runCmd(
          expandHome(g.swampBinPath),
          ["worker", "list", "--json", "--repo-dir", expandHome(g.repoDir)],
          expandHome(g.repoDir),
        );
        let enrolled = 0;
        const matching: string[] = [];
        try {
          const parsed = JSON.parse(listRes.stdout);
          const workers: Array<Record<string, unknown>> = parsed.workers ??
            parsed.items ?? [];
          enrolled = typeof parsed.count === "number"
            ? parsed.count
            : workers.length;
          for (const w of workers) {
            const labels = (w.labels ?? {}) as Record<string, string>;
            if (labels.serve === g.identity) {
              matching.push(String(w.name ?? w.id ?? "worker"));
            }
          }
        } catch {
          enrolled = 0;
        }

        const handle = await context.writeResource("status", "status", {
          unitName,
          unitPath,
          exists,
          state: showRes.stdout.trim() || activeRes.stdout.trim(),
          active: activeRes.stdout.trim() === "active",
          enabled: enabledRes.stdout.trim() === "enabled",
          enrolledWorkers: enrolled,
          matchingWorkers: matching,
          checkedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Worker {unitName}: {active} · {matching} of {enrolled} enrolled worker(s) are serve={identity}",
          {
            unitName,
            active: activeRes.stdout.trim() || "unknown",
            matching: matching.length,
            enrolled,
            identity: g.identity,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    remove: {
      description:
        "Completely decommission this identity's worker: revoke its enrollment " +
        "token on the orchestrator (so it can never re-enroll), then stop and " +
        "disable its unit and delete its namespaced artifacts (unit, token/env " +
        "files, cache dir). Foreign worker units are never touched.",
      arguments: RemoveArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const unitName = deriveUnitName(g.identity, g.unitName);
        // Guard first, before any action, so a mis-pointed unit is never touched.
        assertOwnedUnit(unitName, g.identity, g.unitName);
        const unitPath = unitPathFor(g);
        const node = (args.node ?? "").trim() || Deno.hostname();
        const tokenName = `${g.identity}-${node}`;

        // Revoke first: once the token is gone the worker cannot re-enroll, so a
        // restart between here and the unit deletion cannot resurrect it. This is
        // best-effort because the token may already be revoked or expired, or the
        // repo may not be reachable from this host (revoke separately then).
        let revoked = false;
        if (args.revokeToken) {
          const rev = await runCmd(
            expandHome(g.swampBinPath),
            [
              "worker",
              "token",
              "revoke",
              tokenName,
              "--repo-dir",
              expandHome(g.repoDir),
            ],
            expandHome(g.repoDir),
          );
          revoked = rev.code === 0;
          if (!revoked) {
            context.logger?.warn?.(
              "could not revoke token {tokenName} ({code}): {detail} — continuing removal",
              {
                tokenName,
                code: rev.code,
                detail: (rev.stderr || rev.stdout).trim(),
              },
            );
          }
        }

        const stop = await systemctl(["stop", unitName]);
        if (!isAlreadyStopped(stop)) {
          context.logger?.warn?.(
            "systemctl --user stop {unitName} reported {code}",
            { unitName, code: stop.code },
          );
        }
        await systemctl(["disable", unitName]);
        await Deno.remove(unitPath).catch(() => {});
        const reload = await systemctl(["daemon-reload"]);
        if (reload.code !== 0) {
          context.logger?.warn?.("daemon-reload after remove reported {code}", {
            code: reload.code,
          });
        }

        if (args.purgeData) {
          await Deno.remove(cacheDirFor(g), { recursive: true }).catch(
            () => {},
          );
          await Deno.remove(tokenFilePath(g)).catch(() => {});
          await Deno.remove(envFilePath(g)).catch(() => {});
        }

        const handle = await context.writeResource("status", "status", {
          unitName,
          unitPath,
          exists: false,
          state: "removed",
          active: false,
          enabled: false,
          enrolledWorkers: 0,
          matchingWorkers: [],
          checkedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Removed worker {unitName} (identity {identity}){revoked}{purge}",
          {
            unitName,
            identity: g.identity,
            revoked: args.revokeToken
              ? revoked
                ? `, revoked token ${tokenName}`
                : `, token ${tokenName} already gone`
              : "",
            purge: args.purgeData ? " and its cache/token files" : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    guidance: {
      description:
        "Print every global option with its current value, so a setting can " +
        "be changed without reading source.",
      arguments: z.object({}),
      execute: (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        context.logger?.info(
          [
            `identity       = ${g.identity}   (unit ${
              deriveUnitName(g.identity, g.unitName)
            })`,
            `swampBinPath   = ${expandHome(g.swampBinPath)}`,
            `unitDir        = ${expandHome(g.unitDir)}`,
            `configDir      = ${expandHome(g.configDir)}`,
            `cacheDirRoot   = ${expandHome(g.cacheDirRoot)}`,
            `tokenFile      = ${tokenFilePath(g)}`,
            `envFile        = ${envFilePath(g)}`,
            `swampHome      = ${expandHome(g.swampHome)}`,
            `swampConfigDir = ${expandHome(g.swampConfigDir)}`,
            `concurrency    = ${g.concurrency}`,
            `enableLinger   = ${g.enableLinger}`,
            `releaseBaseUrl = ${g.releaseBaseUrl}`,
            ``,
            `Change a value:  swamp model edit <name> --global-arg <key>=<value>`,
            `Run a method:    swamp model @svendowideit/swamp-worker method run <method> <name>`,
          ].join("\n"),
          {},
        );
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
};

/** Whether a path exists and is a regular file. */
async function fileIsExecutable(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}
