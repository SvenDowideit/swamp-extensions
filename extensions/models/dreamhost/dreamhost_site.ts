/**
 * DreamHost website publishing over SSH/rsync.
 *
 * DreamHost removed the account API, so there is no supported way to create or
 * configure a site programmatically. What shared hosting does offer is SSH and
 * SFTP: a shell user's home directory contains one directory per hosted domain
 * (for example `~/example.com`), and whatever sits in that directory is served.
 *
 * This swamp model type (`@svendowideit/dreamhost/site`) publishes a local
 * directory into that web root with `rsync` over SSH, which gives incremental
 * transfer and optional deletion of stale files for free. Change detection is
 * rsync's own: only differing files move, and `--itemize-changes` is parsed
 * into an added/modified/deleted summary.
 *
 * Methods:
 *   - `deploy`      — sync a local directory to the remote web root (supports
 *                     `delete`, `dryRun`, `excludes`, and extra rsync args).
 *   - `check`       — verify SSH connectivity and report the remote home
 *                     directory and whether the target web root exists.
 *   - `inspect`     — list the remote web root and report a file count and
 *                     total size, as a drift snapshot.
 *
 * Credentials are supplied through the vault: `identityContent` (a private
 * key) is written to a mode-0600 temp file for the duration of a run and
 * deleted afterwards; `password` is passed to `sshpass` via the environment.
 * Prefer a key.
 *
 * Pure helpers (argument building, shell quoting, itemized-change parsing, and
 * remote-path resolution) are exported for unit testing.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  host: z.string().describe(
    "SSH host — the domain (example.com), a DreamHost server hostname, or " +
      "an SSH config alias",
  ),
  user: z.string().describe("DreamHost shell username"),
  remotePath: z.string().optional().describe(
    "Remote web root, e.g. ~/example.com/ (required unless set per deploy)",
  ),
  port: z.number().int().min(1).max(65535).default(22).describe(
    "SSH port",
  ),
  identityFile: z.string().optional().describe(
    "Path to an SSH private key; defaults to ssh's own key selection",
  ),
  identityContent: z.string().optional().meta({ sensitive: true }).describe(
    "Inline SSH private key (use a vault expression); written to a temp " +
      "file for the run",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "SSH password (use a vault expression); requires sshpass. Prefer a key.",
  ),
  sshOptions: z.array(z.string()).default([]).describe(
    "Extra ssh options, e.g. ['StrictHostKeyChecking=accept-new']",
  ),
  excludes: z.array(z.string()).default([]).describe(
    "Default rsync exclude patterns for deploy",
  ),
  rsyncArgs: z.array(z.string()).default([]).describe(
    "Extra rsync arguments applied to every deploy",
  ),
  remoteCommand: z.string().default("rsync").describe(
    "Remote rsync binary (DreamHost servers have rsync preinstalled)",
  ),
}).strict();

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const DeployArgsSchema = z.object({
  localPath: z.string().describe("Local directory to publish"),
  remotePath: z.string().optional().describe(
    "Override the remote web root for this deploy",
  ),
  delete: z.boolean().default(false).describe(
    "Delete remote files absent locally (rsync --delete)",
  ),
  dryRun: z.boolean().default(false).describe(
    "Show what would change without transferring anything (rsync -n)",
  ),
  excludes: z.array(z.string()).optional().describe(
    "Override the default exclude patterns for this deploy",
  ),
  rsyncArgs: z.array(z.string()).optional().describe(
    "Extra rsync arguments for this deploy",
  ),
});

const CheckArgsSchema = z.object({
  remotePath: z.string().optional().describe(
    "Remote path to test for existence",
  ),
});

const InspectArgsSchema = z.object({
  remotePath: z.string().optional().describe("Remote path to inspect"),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

export const DeploySchema = z.object({
  host: z.string(),
  user: z.string(),
  localPath: z.string(),
  remotePath: z.string(),
  delete: z.boolean(),
  dryRun: z.boolean(),
  changed: z.boolean(),
  added: z.number(),
  modified: z.number(),
  deleted: z.number(),
  unchanged: z.number(),
  bytesTransferred: z.number(),
  files: z.array(z.object({
    action: z.string(),
    path: z.string(),
  })),
  exitCode: z.number(),
  command: z.string(),
  stderr: z.string(),
  deployedAt: z.string(),
});

export const CheckSchema = z.object({
  host: z.string(),
  user: z.string(),
  connected: z.boolean(),
  remotePath: z.string(),
  remoteExists: z.boolean(),
  remoteHome: z.string(),
  exitCode: z.number(),
  stderr: z.string(),
  checkedAt: z.string(),
});

export const InspectSchema = z.object({
  host: z.string(),
  user: z.string(),
  remotePath: z.string(),
  exists: z.boolean(),
  fileCount: z.number(),
  directoryCount: z.number(),
  totalBytes: z.number(),
  entries: z.array(z.object({
    mode: z.string(),
    size: z.number(),
    name: z.string(),
  })),
  exitCode: z.number(),
  stderr: z.string(),
  inspectedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The outcome classification of one rsync itemized-change line. */
export type RsyncAction = "added" | "modified" | "deleted" | "unchanged";

/** One parsed `--itemize-changes` entry. */
export interface RsyncItem {
  /** What rsync did (or would do) to the path. */
  action: RsyncAction;
  /** Path relative to the transferred tree. */
  path: string;
}

/** A summary of an rsync itemized-change stream. */
export interface RsyncSummary {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

/** An injected command runner returning stdout/stderr/exit code. */
export type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Options for building the ssh transport arguments shared by all commands. */
export interface SshOptions {
  host: string;
  user: string;
  port: number;
  identityFile?: string;
  sshOptions: string[];
}

/** Options for building an rsync deployment invocation. */
export interface RsyncDeployOptions extends SshOptions {
  localPath: string;
  remotePath: string;
  delete: boolean;
  dryRun: boolean;
  excludes: string[];
  rsyncArgs: string[];
  remoteCommand: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Paths that do not start with `~` are returned untouched *before* the home
 * directory is read, so absolute and relative paths never require env access.
 */
export function expandHome(path: string, home?: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  return `${h}${path.slice(1)}`;
}

/**
 * Quote a string for safe inclusion in a POSIX shell command.
 *
 * Wraps in single quotes and escapes embedded single quotes, so a remote path
 * or argument cannot break out of the command.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Normalize a remote path for use in an rsync target.
 *
 * A trailing slash is significant to rsync (copy contents vs. the directory
 * itself), so it is preserved. A bare `~` and `~/...` are passed through for
 * the remote shell to expand; the path is never expanded locally.
 */
export function normalizeRemotePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("remotePath must not be empty");
  if (trimmed.includes("\0")) throw new Error("remotePath contains a NUL byte");
  return trimmed;
}

/** Resolve the effective remote path from a method argument or global default. */
export function resolveRemotePath(
  arg: string | undefined,
  globalDefault: string | undefined,
): string {
  const chosen = arg ?? globalDefault;
  if (!chosen) {
    throw new Error(
      "No remote path — set the `remotePath` global argument or pass " +
        "`remotePath` to the method",
    );
  }
  return normalizeRemotePath(chosen);
}

/** Build the `ssh -e` transport string used by rsync. */
export function buildSshTransport(opts: SshOptions): string {
  const parts = ["ssh", "-p", String(opts.port)];
  if (opts.identityFile) {
    parts.push("-i", expandHome(opts.identityFile));
  }
  for (const opt of opts.sshOptions) {
    if (opt) parts.push("-o", opt);
  }
  return parts.map((p) => (p.includes(" ") ? shellQuote(p) : p)).join(" ");
}

/**
 * Build the full rsync argument vector for a deployment.
 *
 * Archive mode plus `--itemize-changes` is always on, so every run reports a
 * per-file delta. `--delete` is opt-in because deletion on a web root is
 * destructive.
 */
export function buildRsyncArgs(opts: RsyncDeployOptions): string[] {
  const args = [
    "-a",
    "--itemize-changes",
    "--stats",
    "--no-motd",
    "-e",
    buildSshTransport(opts),
  ];
  if (opts.dryRun) args.push("-n");
  if (opts.delete) args.push("--delete");
  if (opts.remoteCommand && opts.remoteCommand !== "rsync") {
    args.push("--rsync-path", opts.remoteCommand);
  }
  for (const pattern of opts.excludes) {
    if (pattern) args.push(`--exclude=${pattern}`);
  }
  for (const extra of opts.rsyncArgs) {
    if (extra) args.push(extra);
  }

  const local = expandHome(opts.localPath).replace(/\/+$/, "") + "/";
  const remote = `${opts.user}@${opts.host}:${
    normalizeRemotePath(
      opts.remotePath,
    )
  }`;
  args.push(local, remote);
  return args;
}

/**
 * Parse an rsync `--itemize-changes` stream into classified entries.
 *
 * The itemize format is `YXcstpoguax`: `Y` is the update type (`>`, `<`, `c`,
 * `h`, `.`, `*`), `X` is the file type (`f`, `d`, `L`, `D`, `S`). A path is
 * "added" when every change flag is `+` (or the line is `*deleting` for
 * deletions); "modified" when any other change flag is set; "unchanged" when
 * all flags are `.`.
 *
 * Directory entries (type `d`) are skipped: web-root publishing is about file
 * additions, modifications, and deletions, and rsync emits directory-touch
 * lines on almost every run (`.d..t...... ./`) that would otherwise inflate
 * the change count. Deletion lines do not carry a type, so they are classified
 * directly from the `*deleting` prefix.
 */
export function parseItemizedChanges(output: string): RsyncItem[] {
  const items: RsyncItem[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) continue;
    if (line.startsWith("*deleting")) {
      const path = line.slice("*deleting".length).trim();
      if (path) items.push({ action: "deleted", path });
      continue;
    }
    // Non-itemized lines (summaries, banners, errors) start with whitespace.
    if (/^\s/.test(line)) continue;
    if (line.length < 12) continue;
    const update = line.slice(0, 11);
    if (!/^[<>ch.*][fdLDS]/.test(update)) continue;
    // Skip directory entries; only files count toward the change summary.
    if (update[1] === "d") continue;
    const path = line.slice(11).trim();
    if (!path) continue;
    const flags = update.slice(2);
    let action: RsyncAction;
    if (/^[+]+$/.test(flags)) action = "added";
    else if (/^[.]+$/.test(flags)) action = "unchanged";
    else action = "modified";
    items.push({ action, path });
  }
  return items;
}

/** Count parsed rsync items by action. */
export function summarizeChanges(items: RsyncItem[]): RsyncSummary {
  const summary: RsyncSummary = {
    added: 0,
    modified: 0,
    deleted: 0,
    unchanged: 0,
  };
  for (const item of items) summary[item.action] += 1;
  return summary;
}

/** Extract the total transferred bytes from rsync's `--stats`-less summary. */
export function parseTransferredBytes(output: string): number {
  const match = output.match(
    /sent\s+([\d,]+)\s+bytes\s+received\s+([\d,]+)\s+bytes/i,
  );
  if (!match) return 0;
  const sent = Number(match[1].replace(/,/g, ""));
  const received = Number(match[2].replace(/,/g, ""));
  return (Number.isFinite(sent) ? sent : 0) +
    (Number.isFinite(received) ? received : 0);
}

/** Parse `ls -lan` output into entries for the remote web root. */
export function parseLsOutput(
  output: string,
): {
  entries: Array<{ mode: string; size: number; name: string }>;
  totalBytes: number;
} {
  const entries: Array<{ mode: string; size: number; name: string }> = [];
  let totalBytes = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line || line.startsWith("total ")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const mode = parts[0];
    const size = Number(parts[4]);
    const name = parts.slice(8).join(" ");
    if (
      name === "." || name === ".." || name.endsWith("/.") ||
      name.endsWith("/..")
    ) {
      continue;
    }
    const sizeValue = Number.isFinite(size) ? size : 0;
    entries.push({ mode, size: sizeValue, name });
    if (mode.startsWith("-")) totalBytes += sizeValue;
  }
  return { entries, totalBytes };
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/** Run a command, capturing stdout/stderr (exit 127 on spawn failure). */
export async function runCmd(
  bin: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    // swamp-quality-ignore deno-command
    const proc = new Deno.Command(bin, {
      args,
      stdout: "piped",
      stderr: "piped",
      env: opts?.env,
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

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
    warning?: (msg: string, props?: Record<string, unknown>) => void;
    error?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: WriteResource;
};

type CheckContext = {
  globalArgs: GlobalArgs;
  methodName: string;
};

/** Build the ssh transport options from global arguments. */
export function transport(g: GlobalArgs, identityFile?: string): SshOptions {
  // Automated runs (including inventory-all) must never hang on an interactive
  // password prompt; non-password auth keeps BatchMode enabled. Explicit
  // password authentication still supplies its own password via sshpass.
  const sshOptions = g.password
    ? g.sshOptions
    : ["BatchMode=yes", ...g.sshOptions];
  return {
    host: g.host,
    user: g.user,
    port: g.port,
    identityFile: identityFile ?? g.identityFile,
    sshOptions,
  };
}

/** Materialize an inline private key to a mode-0600 temp file. */
export async function withIdentity<T>(
  content: string | undefined,
  fn: (path: string | undefined) => Promise<T>,
): Promise<T> {
  if (!content) return await fn(undefined);
  const dir = await Deno.makeTempDir({ prefix: "swamp-dh-" });
  const path = `${dir}/id`;
  try {
    await Deno.writeTextFile(path, content, { mode: 0o600 });
    return await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * Environment overlay for password auth via sshpass.
 *
 * Deno merges this overlay with the parent environment, so only the one
 * variable needs to be set; the child still inherits PATH and the rest.
 */
export function sshEnv(
  password: string | undefined,
): Record<string, string> | undefined {
  if (!password) return undefined;
  return { SSHPASS: password };
}

/** Build the ssh argument vector for a remote command. */
export function buildSshArgs(
  opts: SshOptions,
  remoteCommand: string,
): string[] {
  const args = ["-p", String(opts.port)];
  if (opts.identityFile) args.push("-i", expandHome(opts.identityFile));
  for (const opt of opts.sshOptions) {
    if (opt) args.push("-o", opt);
  }
  args.push(`${opts.user}@${opts.host}`, remoteCommand);
  return args;
}

// ---------------------------------------------------------------------------
// Injectable method cores
//
// The method bodies delegate to these functions so integration tests can run
// them against a fake {@link CommandRunner} without a real host. They resolve
// credentials, build the command, interpret the result, and write the resource.
// ---------------------------------------------------------------------------

type Logger = MethodContext["logger"];

/** The deploy resource payload (mirrors {@link DeploySchema}). */
export interface DeployOutcome extends Record<string, unknown> {
  host: string;
  user: string;
  localPath: string;
  remotePath: string;
  delete: boolean;
  dryRun: boolean;
  changed: boolean;
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  bytesTransferred: number;
  files: Array<{ action: string; path: string }>;
  exitCode: number;
  command: string;
  stderr: string;
  deployedAt: string;
}

/** Run a deployment and return its resource payload. */
export async function executeDeploy(
  g: GlobalArgs,
  args: z.infer<typeof DeployArgsSchema>,
  runner: CommandRunner,
  logger?: Logger,
): Promise<DeployOutcome> {
  const remotePath = resolveRemotePath(args.remotePath, g.remotePath);
  const excludes = args.excludes ?? g.excludes;
  const rsyncArgs = args.rsyncArgs ?? g.rsyncArgs;

  logger?.info("deploy {local} -> {user}@{host}:{remote}{delete}", {
    local: args.localPath,
    user: g.user,
    host: g.host,
    remote: remotePath,
    delete: args.delete ? " (delete)" : "",
  });

  const bin = g.password ? "sshpass" : "rsync";
  return await withIdentity(g.identityContent, async (keyPath) => {
    const opts: RsyncDeployOptions = {
      ...transport(g, keyPath),
      localPath: args.localPath,
      remotePath,
      delete: args.delete,
      dryRun: args.dryRun,
      excludes,
      rsyncArgs,
      remoteCommand: g.remoteCommand,
    };
    const vector = buildRsyncArgs(opts);
    const finalArgs = g.password ? ["-e", "rsync", ...vector] : vector;
    const result = await runner(bin, finalArgs, { env: sshEnv(g.password) });

    if (result.code !== 0) {
      throw new Error(
        `rsync to ${g.user}@${g.host}:${remotePath} failed ` +
          `(${result.code}): ${result.stderr.trim()}`,
      );
    }

    const items = parseItemizedChanges(result.stdout);
    const summary = summarizeChanges(items);
    const changed = summary.added + summary.modified + summary.deleted > 0;

    logger?.info(
      "deploy {result}: +{added} ~{modified} -{deleted} ={unchanged}",
      {
        result: args.dryRun ? "would change" : "complete",
        added: summary.added,
        modified: summary.modified,
        deleted: summary.deleted,
        unchanged: summary.unchanged,
      },
    );

    return {
      host: g.host,
      user: g.user,
      localPath: args.localPath,
      remotePath,
      delete: args.delete,
      dryRun: args.dryRun,
      changed,
      added: summary.added,
      modified: summary.modified,
      deleted: summary.deleted,
      unchanged: summary.unchanged,
      bytesTransferred: parseTransferredBytes(result.stdout),
      files: items.map((i) => ({ action: i.action, path: i.path })),
      exitCode: result.code,
      command: [bin, ...finalArgs].map(shellQuote).join(" "),
      stderr: result.stderr.trim(),
      deployedAt: new Date().toISOString(),
    };
  });
}

/** Run a connectivity check and return its resource payload. */
export async function executeCheck(
  g: GlobalArgs,
  args: z.infer<typeof CheckArgsSchema>,
  runner: CommandRunner,
  logger?: Logger,
): Promise<Record<string, unknown>> {
  const remotePath = args.remotePath ?? g.remotePath ?? "";
  const quoted = remotePath ? shellQuote(remotePath) : "''";
  const script = `printf 'HOME=%s\\n' "$HOME"; ` +
    `if [ -d ${quoted} ]; then echo REMOTE_EXISTS; ` +
    `else echo REMOTE_MISSING; fi`;
  const bin = g.password ? "sshpass" : "ssh";
  return await withIdentity(g.identityContent, async (keyPath) => {
    const sshArgs = buildSshArgs(transport(g, keyPath), script);
    const finalArgs = g.password ? ["-e", "ssh", ...sshArgs] : sshArgs;
    const result = await runner(bin, finalArgs, { env: sshEnv(g.password) });
    const connected = result.code === 0;
    const remoteHome = result.stdout.match(/^HOME=(.*)$/m)?.[1] ?? "";
    const remoteExists = result.stdout.includes("REMOTE_EXISTS");

    logger?.info("check {user}@{host}: {state}", {
      user: g.user,
      host: g.host,
      state: connected
        ? (remoteExists ? "connected, path exists" : "connected, path missing")
        : `failed (${result.code})`,
    });

    return {
      host: g.host,
      user: g.user,
      connected,
      remotePath,
      remoteExists,
      remoteHome,
      exitCode: result.code,
      stderr: result.stderr.trim(),
      checkedAt: new Date().toISOString(),
    };
  });
}

/** Run a remote web-root listing and return its resource payload. */
export async function executeInspect(
  g: GlobalArgs,
  args: z.infer<typeof InspectArgsSchema>,
  runner: CommandRunner,
  logger?: Logger,
): Promise<Record<string, unknown>> {
  const remotePath = resolveRemotePath(args.remotePath, g.remotePath);
  const script = `if [ -d ${shellQuote(remotePath)} ]; then ls -lan ${
    shellQuote(remotePath)
  }; else echo NOT_A_DIRECTORY 1>&2; exit 2; fi`;
  const bin = g.password ? "sshpass" : "ssh";
  return await withIdentity(g.identityContent, async (keyPath) => {
    const sshArgs = buildSshArgs(transport(g, keyPath), script);
    const finalArgs = g.password ? ["-e", "ssh", ...sshArgs] : sshArgs;
    const result = await runner(bin, finalArgs, { env: sshEnv(g.password) });
    const exists = result.code === 0;
    const { entries, totalBytes } = exists
      ? parseLsOutput(result.stdout)
      : { entries: [], totalBytes: 0 };
    const fileCount = entries.filter((e) => !e.mode.startsWith("d")).length;
    const directoryCount = entries.filter((e) => e.mode.startsWith("d"))
      .length;

    logger?.info("{remote}: {files} file(s), {dirs} dir(s), {bytes} bytes", {
      remote: remotePath,
      files: fileCount,
      dirs: directoryCount,
      bytes: totalBytes,
    });

    return {
      host: g.host,
      user: g.user,
      remotePath,
      exists,
      fileCount,
      directoryCount,
      totalBytes,
      entries,
      exitCode: result.code,
      stderr: result.stderr.trim(),
      inspectedAt: new Date().toISOString(),
    };
  });
}

/** Swamp model definition for DreamHost site publishing over SSH/rsync. */
export const model = {
  type: "@svendowideit/dreamhost/site",
  version: "2026.10.23.5",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-target": {
      description:
        "Validate the SSH host, user, port, and configured remote path",
      labels: ["policy"],
      appliesTo: ["deploy", "check", "inspect"],
      execute: (
        context: CheckContext,
      ): { pass: boolean; errors?: string[] } => {
        const errors: string[] = [];
        const g = context.globalArgs;
        if (!g.host.trim()) errors.push("host must not be empty");
        if (!g.user.trim()) errors.push("user must not be empty");
        if (g.port < 1 || g.port > 65535) {
          errors.push("port must be between 1 and 65535");
        }
        if (g.remotePath !== undefined) {
          try {
            normalizeRemotePath(g.remotePath);
          } catch (err) {
            errors.push((err as Error).message);
          }
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  resources: {
    deploy: {
      description: "Result of an rsync deployment to the web root",
      schema: DeploySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    check: {
      description: "SSH connectivity and remote path status",
      schema: CheckSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    inspect: {
      description: "Remote web root listing and size snapshot",
      schema: InspectSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    deploy: {
      description:
        "Publish a local directory to the DreamHost web root with rsync over SSH",
      arguments: DeployArgsSchema,
      execute: async (
        args: z.infer<typeof DeployArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeDeploy(
          context.globalArgs,
          args,
          runCmd,
          context.logger,
        );
        const handle = await context.writeResource("deploy", "deploy", outcome);
        return { dataHandles: [handle] };
      },
    },

    check: {
      description:
        "Verify SSH connectivity and report whether the remote web root exists",
      arguments: CheckArgsSchema,
      execute: async (
        args: z.infer<typeof CheckArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeCheck(
          context.globalArgs,
          args,
          runCmd,
          context.logger,
        );
        const handle = await context.writeResource("check", "check", outcome);
        return { dataHandles: [handle] };
      },
    },

    inspect: {
      description: "List the remote web root and report a size snapshot",
      arguments: InspectArgsSchema,
      execute: async (
        args: z.infer<typeof InspectArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeInspect(
          context.globalArgs,
          args,
          runCmd,
          context.logger,
        );
        const handle = await context.writeResource(
          "inspect",
          "inspect",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.23.5",
      description:
        "Adds exported SSH helpers used by the inventory model, plus inventory-capable DNS/version alignment. Existing web publishing schema unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
