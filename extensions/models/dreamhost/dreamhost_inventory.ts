import { z } from "npm:zod@4";

import {
  buildSshArgs,
  buildSshTransport,
  expandHome,
  type GlobalArgs,
  GlobalArgsSchema,
  normalizeRemotePath,
  parseItemizedChanges,
  parseTransferredBytes,
  runCmd,
  shellQuote,
  sshEnv,
  summarizeChanges,
  transport,
  withIdentity,
} from "./dreamhost_site.ts";

const RootArgSchema = z.string().min(1).optional().describe(
  "Remote root to inventory (default: remote home, `~`)",
);

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type Logger = {
  info?: (msg: string, props?: Record<string, unknown>) => void;
  debug?: (msg: string, props?: Record<string, unknown>) => void;
  warning?: (msg: string, props?: Record<string, unknown>) => void;
  error?: (msg: string, props?: Record<string, unknown>) => void;
};

type MethodContextLike = {
  globalArgs: GlobalArgs;
  logger?: Logger;
  writeResource: WriteResource;
  readResource?: (
    specName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
};

type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const AccountInfoSchema = z.object({
  host: z.string(),
  user: z.string(),
  home: z.string(),
  uid: z.string(),
  gid: z.string(),
  hostname: z.string(),
  uname: z.string(),
  shell: z.string(),
  checkedAt: z.string(),
});

export const HomeEntrySchema = z.object({
  type: z.string(),
  size: z.number(),
  mtimeEpoch: z.number(),
  mode: z.string(),
  uid: z.string(),
  gid: z.string(),
  symlinkTarget: z.string(),
  path: z.string(),
});

export const HomeManifestSchema = z.object({
  root: z.string(),
  host: z.string(),
  user: z.string(),
  entryCount: z.number(),
  directoryCount: z.number(),
  fileCount: z.number(),
  symlinkCount: z.number(),
  totalBytes: z.number(),
  truncated: z.boolean(),
  entries: z.array(HomeEntrySchema),
  exitCode: z.number(),
  stderr: z.string(),
  inventoriedAt: z.string(),
});

export const ConfigEntrySchema = z.object({
  path: z.string(),
  size: z.number(),
  mtimeEpoch: z.number(),
});

export const DatabaseRefSchema = z.object({
  file: z.string(),
  line: z.number(),
  redactedMatch: z.string(),
});

export const MailEntrySchema = z.object({
  path: z.string(),
  kind: z.string(),
  sizeKb: z.number(),
  fileCount: z.number(),
});

export const SpecialEntrySchema = z.object({
  type: z.string(),
  path: z.string(),
  target: z.string(),
  mode: z.string(),
});

const AccountInfoArgsSchema = z.object({
  host: z.string().optional(),
  user: z.string().optional(),
});
const HomeManifestArgsSchema = z.object({
  root: RootArgSchema,
  host: z.string().optional(),
  user: z.string().optional(),
  maxEntries: z.number().int().min(1).max(10000000).default(100000).describe(
    "Maximum paths to include in one resource",
  ),
});
const FindConfigsArgsSchema = z.object({
  root: RootArgSchema,
  host: z.string().optional(),
  user: z.string().optional(),
});
const DatabaseRefsArgsSchema = z.object({
  root: RootArgSchema,
  host: z.string().optional(),
  user: z.string().optional(),
});
const MailInventoryArgsSchema = z.object({
  root: RootArgSchema,
  host: z.string().optional(),
  user: z.string().optional(),
});
const SpecialFilesArgsSchema = z.object({
  root: RootArgSchema,
  host: z.string().optional(),
  user: z.string().optional(),
});
const RepositoryRootsArgsSchema = z.object({
  root: RootArgSchema,
  host: z.string().optional(),
  user: z.string().optional(),
});
const CronHintsArgsSchema = z.object({
  host: z.string().optional(),
  user: z.string().optional(),
});

const BackupArgsSchema = z.object({
  host: z.string().optional(),
  user: z.string().optional(),
  localPath: z.string().optional().describe(
    "Local directory that receives the remote account " +
      "(default: ./dreamhost-backup-<user>)",
  ),
  remotePath: z.string().optional().describe(
    "Remote root to back up (default: home, ~)",
  ),
  delete: z.boolean().default(false).describe(
    "Delete local files absent from the remote account",
  ),
  dryRun: z.boolean().default(false).describe(
    "Show what would change without transferring anything",
  ),
  checksum: z.boolean().default(false).describe(
    "Use checksums, not size/time, to decide what to transfer",
  ),
  approveDiskUsage: z.boolean().default(false).describe(
    "Approve the backup when free disk space would drop below 10 percent",
  ),
  excludes: z.array(z.string()).optional().describe(
    "Extra rsync exclude patterns for this backup",
  ),
  rsyncArgs: z.array(z.string()).optional().describe(
    "Extra rsync arguments for this backup",
  ),
});

const VerifyArgsSchema = z.object({
  localPath: z.string().describe("Local backup directory to verify"),
  // host/user/global arguments may be present; they are inherited for context.
  host: z.string().optional(),
  user: z.string().optional(),
});

function remoteRootExpression(root: string | undefined): string {
  if (!root || root === "~") return "$HOME";
  if (root === "$HOME") return "$HOME";
  return shellQuote(root);
}

function targetGlobalArgs(
  g: GlobalArgs,
  args: { host?: string; user?: string } | undefined,
): GlobalArgs {
  return {
    ...g,
    host: args?.host ?? g.host,
    user: args?.user ?? g.user,
  };
}

async function runRemote(
  g: GlobalArgs,
  remoteCommand: string,
  runner: CommandRunner,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await withIdentity(g.identityContent, async (keyPath) => {
    const bin = g.password ? "sshpass" : "ssh";
    const sshArgs = buildSshArgs(transport(g, keyPath), remoteCommand);
    const finalArgs = g.password ? ["-e", "ssh", ...sshArgs] : sshArgs;
    return await runner(bin, finalArgs, { env: sshEnv(g.password) });
  });
}

export function parseFindManifest(
  stdout: string,
): Array<z.infer<typeof HomeEntrySchema>> {
  const out: Array<z.infer<typeof HomeEntrySchema>> = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const parts = record.split("\t");
    if (parts.length < 8) continue;
    const [type, size, mtime, mode, uid, gid, target, ...pathParts] = parts;
    const path = pathParts.join("\t");
    if (!path) continue;
    const sizeNum = Number(size);
    const mtimeNum = Number(mtime);
    out.push({
      type: type || "?",
      size: Number.isFinite(sizeNum) ? sizeNum : 0,
      mtimeEpoch: Number.isFinite(mtimeNum) ? mtimeNum : 0,
      mode: mode || "",
      uid: uid || "",
      gid: gid || "",
      symlinkTarget: target || "",
      path,
    });
  }
  return out;
}

export function redactDatabaseLine(line: string): string {
  return line.replace(
    /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(['"]?)([^'"\s]+)(['"]?)/gi,
    "$1$2[REDACTED]$4",
  );
}

export function parseGrepLines(
  stdout: string,
): Array<z.infer<typeof DatabaseRefSchema>> {
  const out: Array<z.infer<typeof DatabaseRefSchema>> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const match = line.match(/^(.*):(\d+):(.*)$/);
    if (!match) continue;
    out.push({
      file: match[1],
      line: Number(match[2]),
      redactedMatch: redactDatabaseLine(match[3]),
    });
  }
  return out;
}

export function parseMailLines(
  stdout: string,
): Array<z.infer<typeof MailEntrySchema>> {
  const out: Array<z.infer<typeof MailEntrySchema>> = [];
  for (const raw of stdout.split("\0")) {
    if (!raw.trim()) continue;
    const parts = raw.split("\t");
    if (parts.length < 3) continue;
    const [path, kind, sizeKb, fileCount] = parts;
    const sizeNum = Number(sizeKb);
    const countNum = Number(fileCount);
    out.push({
      path,
      kind: kind || "maildir",
      sizeKb: Number.isFinite(sizeNum) ? sizeNum : 0,
      fileCount: Number.isFinite(countNum) ? countNum : 0,
    });
  }
  return out;
}

export function parseSpecialLines(
  stdout: string,
): Array<z.infer<typeof SpecialEntrySchema>> {
  const out: Array<z.infer<typeof SpecialEntrySchema>> = [];
  for (const record of stdout.split("\0")) {
    if (!record.trim()) continue;
    const parts = record.split("\t");
    if (parts.length < 4) continue;
    const [type, target, mode, ...pathParts] = parts;
    const path = pathParts.join("\t");
    if (!path) continue;
    out.push({
      type: type || "?",
      path,
      target: target || "",
      mode: mode || "",
    });
  }
  return out;
}

export async function executeAccountInfo(
  g: GlobalArgs,
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const script = `printf 'HOME=%s\\n' "$HOME"; ` +
    `printf 'USER=%s\\n' "$(id -un)"; ` +
    `printf 'UIDGID=%s:%s\\n' "$(id -u)" "$(id -g)"; ` +
    `printf 'HOSTNAME=%s\\n' "$(hostname 2>/dev/null || true)"; ` +
    `printf 'UNAME=%s\\n' "$(uname -a 2>/dev/null || true)"; ` +
    `printf 'SHELL=%s\\n' "$SHELL"`;
  const result = await runRemote(g, script, runner);
  const stdout = result.stdout;
  const get = (key: string) =>
    stdout.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
  return {
    host: g.host,
    user: g.user,
    home: get("HOME"),
    uid: get("UIDGID").split(":")[0] ?? "",
    gid: get("UIDGID").split(":")[1] ?? "",
    hostname: get("HOSTNAME"),
    uname: get("UNAME"),
    shell: get("SHELL"),
    exitCode: result.code,
    stderr: result.stderr.trim(),
    checkedAt: new Date().toISOString(),
  };
}

export async function executeHomeManifest(
  g: GlobalArgs,
  args: { root?: string; maxEntries: number },
  runner: CommandRunner,
  logger?: Logger,
): Promise<Record<string, unknown>> {
  const root = remoteRootExpression(args.root);
  const script = `root=${root}; ` +
    `if [ ! -d "$root" ]; then echo "NOT_A_DIRECTORY" >&2; exit 2; fi; ` +
    `find "$root" -xdev -printf '%y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%l\\t%p\\0'`;
  const result = await runRemote(g, script, runner);
  const all = result.code === 0 ? parseFindManifest(result.stdout) : [];
  const capped = all.slice(0, args.maxEntries);
  const fileCount = capped.filter((e) => e.type === "f").length;
  const directoryCount = capped.filter((e) => e.type === "d").length;
  const symlinkCount = capped.filter((e) => e.type === "l").length;
  const totalBytes = capped.reduce((sum, e) => sum + e.size, 0);
  logger?.info?.("inventory {host}:{root}: {entries} entries", {
    host: g.host,
    root: args.root ?? "~",
    entries: capped.length,
  });
  return {
    root: args.root ?? "~",
    host: g.host,
    user: g.user,
    entryCount: capped.length,
    directoryCount,
    fileCount,
    symlinkCount,
    totalBytes,
    truncated: all.length > capped.length,
    entries: capped,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    inventoriedAt: new Date().toISOString(),
  };
}

export async function executeFindConfigs(
  g: GlobalArgs,
  args: { root?: string },
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const root = remoteRootExpression(args.root);
  const script = `root=${root}; ` +
    `if [ ! -d "$root" ]; then echo "NOT_A_DIRECTORY" >&2; exit 2; fi; ` +
    `find "$root" -xdev -type f \\( ` +
    `-name '.env' -o -name '.env.*' -o -name 'wp-config.php' -o ` +
    `-name 'settings.php' -o -name 'config.php' -o -name 'configuration.php' ` +
    `\\) -printf '%s\\t%T@\\t%p\\0'`;
  const result = await runRemote(g, script, runner);
  const configs: Array<z.infer<typeof ConfigEntrySchema>> = [];
  for (const record of result.stdout.split("\0")) {
    if (!record.trim()) continue;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    const [size, mtime, ...pathParts] = parts;
    const path = pathParts.join("\t");
    const sizeNum = Number(size);
    const mtimeNum = Number(mtime);
    configs.push({
      path,
      size: Number.isFinite(sizeNum) ? sizeNum : 0,
      mtimeEpoch: Number.isFinite(mtimeNum) ? mtimeNum : 0,
    });
  }
  return {
    root: args.root ?? "~",
    host: g.host,
    user: g.user,
    count: configs.length,
    configs,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    discoveredAt: new Date().toISOString(),
  };
}

export async function executeDatabaseRefs(
  g: GlobalArgs,
  args: { root?: string },
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const root = remoteRootExpression(args.root);
  const script = `root=${root}; ` +
    `if [ ! -d "$root" ]; then echo "NOT_A_DIRECTORY" >&2; exit 2; fi; ` +
    `find "$root" -xdev -type f \\( ` +
    `-name '.env' -o -name '.env.*' -o -name 'wp-config.php' -o ` +
    `-name 'settings.php' -o -name 'config.php' -o -name 'configuration.php' ` +
    `\\) -exec grep -nHE ` +
    `'DB_(HOST|NAME|USER|PASSWORD|CHARSET)|DATABASE_URL|MYSQL_HOST|MYSQL_DATABASE|MYSQL_USER' ` +
    `{} + 2>/dev/null || true`;
  const result = await runRemote(g, script, runner);
  const refs = parseGrepLines(result.stdout);
  return {
    root: args.root ?? "~",
    host: g.host,
    user: g.user,
    count: refs.length,
    refs,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    discoveredAt: new Date().toISOString(),
  };
}

export async function executeMailInventory(
  g: GlobalArgs,
  args: { root?: string },
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const root = remoteRootExpression(args.root);
  const script = `root=${root}; ` +
    `if [ ! -d "$root" ]; then echo "NOT_A_DIRECTORY" >&2; exit 2; fi; ` +
    `find "$root" -xdev -type d \\( ` +
    `-iname 'mail' -o -iname 'maildir' -o -iname 'mails' ` +
    `\\) -print0 | while IFS= read -r -d '' d; do ` +
    `kb=$(du -sk -- "$d" 2>/dev/null | cut -f1); ` +
    `count=$(find "$d" -type f 2>/dev/null | wc -l); ` +
    `printf '%s\\t%s\\t%s\\t%s\\0' "$d" "maildir" "\${kb:-0}" "$count"; ` +
    `done`;
  const result = await runRemote(g, script, runner);
  const mailboxes = parseMailLines(result.stdout);
  return {
    root: args.root ?? "~",
    host: g.host,
    user: g.user,
    count: mailboxes.length,
    mailboxes,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    discoveredAt: new Date().toISOString(),
  };
}

export async function executeSpecialFiles(
  g: GlobalArgs,
  args: { root?: string },
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const root = remoteRootExpression(args.root);
  const script = `root=${root}; ` +
    `if [ ! -d "$root" ]; then echo "NOT_A_DIRECTORY" >&2; exit 2; fi; ` +
    `find "$root" -xdev \\( -type l -o -type s -o -type p -o -type b -o -type c \\) ` +
    `-printf '%y\\t%l\\t%m\\t%p\\0'`;
  const result = await runRemote(g, script, runner);
  const entries = parseSpecialLines(result.stdout);
  return {
    root: args.root ?? "~",
    host: g.host,
    user: g.user,
    count: entries.length,
    entries,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    discoveredAt: new Date().toISOString(),
  };
}

export async function executeRepositoryRoots(
  g: GlobalArgs,
  args: { root?: string },
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const root = remoteRootExpression(args.root);
  const script = `root=${root}; ` +
    `if [ ! -d "$root" ]; then echo "NOT_A_DIRECTORY" >&2; exit 2; fi; ` +
    `find "$root" -xdev -type d \\( -name '.svn' -o -name '.git' \\) -printf '%p\\0'`;
  const result = await runRemote(g, script, runner);
  const paths = result.stdout
    .split("\0")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    root: args.root ?? "~",
    host: g.host,
    user: g.user,
    count: paths.length,
    paths,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    discoveredAt: new Date().toISOString(),
  };
}

export async function executeCronHints(
  g: GlobalArgs,
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const script = `crontab -l 2>&1 || true`;
  const result = await runRemote(g, script, runner);
  return {
    host: g.host,
    user: g.user,
    output: result.stdout,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    discoveredAt: new Date().toISOString(),
  };
}

export interface BackupOutcome extends Record<string, unknown> {
  host: string;
  user: string;
  localPath: string;
  remotePath: string;
  deleted: boolean;
  dryRun: boolean;
  checksum: boolean;
  changed: boolean;
  added: number;
  modified: number;
  deletedCount: number;
  unchanged: number;
  bytesTransferred: number;
  files: Array<{ action: string; path: string }>;
  exitCode: number;
  command: string;
  stderr: string;
  backedUpAt: string;
}

export interface VerifyOutcome extends Record<string, unknown> {
  host: string;
  user: string;
  localPath: string;
  remoteBase: string;
  checked: number;
  verified: number;
  missingCount: number;
  mismatchedCount: number;
  success: boolean;
  sampleMissing: string[];
  sampleMismatched: Array<{ path: string; reason: string }>;
  verifiedAt: string;
}

function relativeManifestPath(base: string, entryPath: string): string {
  if (entryPath === base) return "";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (entryPath.startsWith(prefix)) {
    return entryPath.slice(prefix.length);
  }
  return entryPath.startsWith("/") ? entryPath.replace(/^\/+/, "") : entryPath;
}

export async function executeBackup(
  g: GlobalArgs,
  args: {
    localPath?: string;
    remotePath?: string;
    excludes?: string[];
    rsyncArgs?: string[];
    delete?: boolean;
    dryRun?: boolean;
    checksum?: boolean;
    approveDiskUsage?: boolean;
  },
  runner: CommandRunner,
  logger?: Logger,
  requiredBytes = 0,
): Promise<BackupOutcome> {
  const remotePath = args.remotePath ?? "~";
  const normalizedRemote = normalizeRemotePath(remotePath);
  const remoteSource = normalizedRemote.endsWith("/")
    ? normalizedRemote
    : `${normalizedRemote}/`;
  const localPath = args.localPath ?? `./dreamhost-backup-${g.user}`;
  const resolvedLocal = expandHome(localPath);
  const excludes = args.excludes ?? g.excludes;
  const extraRsyncArgs = args.rsyncArgs ?? g.rsyncArgs;
  const useDelete = args.delete ?? false;
  const useChecksum = args.checksum ?? false;
  const useDryRun = args.dryRun ?? false;

  // Ensure the destination parent exists; rsync creates the leaf directory.
  const parent = resolvedLocal.replace(/\/[^/]*$/, "") || "/";
  if (parent && parent !== resolvedLocal) {
    try {
      await Deno.mkdir(parent, { recursive: true });
    } catch {
      // Directory may already exist or parent may be empty; rsync will report if not.
    }
  }

  if (requiredBytes > 0) {
    const dfResult = await runner("df", ["-B1", parent]);
    const lines = dfResult.stdout.trim().split(/\\r?\\n/).filter(Boolean);
    const dataLine = lines.length > 1 ? lines[lines.length - 1] : "";
    const cols = dataLine.trim().split(/\\s+/);
    const totalBytes = Number(cols[1] ?? "0");
    const availableBytes = Number(cols[3] ?? "0");
    if (
      Number.isFinite(totalBytes) && totalBytes > 0 &&
      Number.isFinite(availableBytes)
    ) {
      const freeAfter = availableBytes - requiredBytes;
      const lowSpace = freeAfter < totalBytes * 0.1 ||
        availableBytes < requiredBytes;
      if (lowSpace && !(args.approveDiskUsage ?? false)) {
        throw new Error(
          `Backup would require about ${requiredBytes} bytes, but only ` +
            `${availableBytes} bytes are free on ${parent}. Run inventory ` +
            `first or rerun with --input approveDiskUsage=true if this is expected.`,
        );
      }
    }
  }

  logger?.info?.("backup {local} <- {user}@{host}:{remote}", {
    local: resolvedLocal,
    user: g.user,
    host: g.host,
    remote: remoteSource,
  });

  const bin = g.password ? "sshpass" : "rsync";
  return await withIdentity(g.identityContent, async (keyPath) => {
    const opts = transport(g, keyPath);
    const sshTransport = buildSshTransport(opts);
    const vector: string[] = [
      "-a",
      "--partial",
      "--itemize-changes",
      "--stats",
      "--no-motd",
      "-e",
      sshTransport,
    ];
    if (useDryRun) vector.push("-n");
    if (useChecksum) vector.push("--checksum");
    if (useDelete) vector.push("--delete");
    for (const pattern of excludes) {
      if (pattern) vector.push(`--exclude=${pattern}`);
    }
    for (const extra of extraRsyncArgs) {
      if (extra) vector.push(extra);
    }
    const source = `${g.user}@${g.host}:${remoteSource}`;
    vector.push(source, resolvedLocal);

    const finalArgs = g.password ? ["-e", "rsync", ...vector] : vector;
    const result = await runner(bin, finalArgs, { env: sshEnv(g.password) });

    if (result.code !== 0) {
      throw new Error(
        `rsync from ${g.user}@${g.host}:${remoteSource} to ${resolvedLocal} ` +
          `failed (${result.code}): ${result.stderr.trim()}`,
      );
    }

    const items = parseItemizedChanges(result.stdout);
    const summary = summarizeChanges(items);
    const changed = summary.added + summary.modified + summary.deleted > 0;

    return {
      host: g.host,
      user: g.user,
      localPath: resolvedLocal,
      remotePath: remoteSource,
      deleted: useDelete,
      dryRun: useDryRun,
      checksum: useChecksum,
      changed,
      added: summary.added,
      modified: summary.modified,
      deletedCount: summary.deleted,
      unchanged: summary.unchanged,
      bytesTransferred: parseTransferredBytes(result.stdout),
      files: items.map((i: { action: string; path: string }) => ({
        action: i.action,
        path: i.path,
      })),
      exitCode: result.code,
      command: [bin, ...finalArgs].map(shellQuote).join(" "),
      stderr: result.stderr.trim(),
      backedUpAt: new Date().toISOString(),
    };
  });
}

export async function executeVerifyBackup(
  g: GlobalArgs,
  args: { localPath: string; context?: MethodContextLike },
  context: MethodContextLike,
  logger?: Logger,
): Promise<VerifyOutcome> {
  const resolvedLocal = expandHome(args.localPath);
  const manifest =
    (context.readResource
      ? await context.readResource("homeManifest")
      : null) as
        | { entries?: Array<Record<string, unknown>>; root?: string }
        | null;
  const entries = Array.isArray(manifest?.entries)
    ? (manifest!.entries as Array<Record<string, unknown>>)
    : [];
  const base = entries.length ? String(entries[0].path ?? "") : "";

  let checked = 0;
  let verified = 0;
  let missingCount = 0;
  let mismatchedCount = 0;
  const sampleMissing: string[] = [];
  const sampleMismatched: Array<{ path: string; reason: string }> = [];

  for (const entry of entries) {
    const entryPath = String(entry.path ?? "");
    if (!entryPath) continue;
    const relative = relativeManifestPath(base, entryPath);
    const localPath = relative ? `${resolvedLocal}/${relative}` : resolvedLocal;
    const type = String(entry.type ?? "");
    checked += 1;
    try {
      const stat = await Deno.lstat(localPath);
      const isDir = stat.isDirectory;
      const isFile = stat.isFile;
      const isSymlink = stat.isSymlink;
      let ok = true;
      let reason = "";

      if (type === "d" && !isDir) {
        ok = false;
        reason = "expected directory";
      } else if (type === "f" && !isFile) {
        ok = false;
        reason = "expected file";
      } else if (type === "l" && !isSymlink) {
        ok = false;
        reason = "expected symlink";
      }

      if (ok && type === "f") {
        const size = Number(entry.size ?? 0);
        if (Number.isFinite(size) && stat.size !== size) {
          ok = false;
          reason = `size mismatch (${stat.size} != ${size})`;
        }
        if (ok) {
          const manifestMode = parseInt(String(entry.mode ?? ""), 8);
          if (
            !Number.isNaN(manifestMode) &&
            (((stat.mode ?? 0) & 0o7777) !== manifestMode)
          ) {
            ok = false;
            reason = "mode mismatch";
          }
        }
        const mtimeEpoch = Number(entry.mtimeEpoch ?? 0);
        if (ok && Number.isFinite(mtimeEpoch) && mtimeEpoch > 0) {
          const localSeconds = stat.mtime ? stat.mtime.getTime() / 1000 : 0;
          if (Math.abs(localSeconds - mtimeEpoch) > 2) {
            ok = false;
            reason = `mtime mismatch`;
          }
        }
      }

      if (ok && type === "l") {
        const target = String(entry.symlinkTarget ?? "");
        if (target) {
          try {
            const actual = await Deno.readLink(localPath);
            if (actual !== target) {
              ok = false;
              reason = "symlink target mismatch";
            }
          } catch {
            ok = false;
            reason = "cannot read symlink target";
          }
        }
      }

      if (ok) {
        verified += 1;
      } else {
        mismatchedCount += 1;
        if (sampleMismatched.length < 50) {
          sampleMismatched.push({ path: entryPath, reason });
        }
      }
    } catch {
      missingCount += 1;
      if (sampleMissing.length < 50) {
        sampleMissing.push(entryPath);
      }
    }
  }

  const success = entries.length > 0 && missingCount === 0 &&
    mismatchedCount === 0;

  logger?.info?.("verify {local}: {verified}/{checked}", {
    local: resolvedLocal,
    verified,
    checked,
  });

  return {
    host: g.host,
    user: g.user,
    localPath: resolvedLocal,
    remoteBase: base,
    checked,
    verified,
    missingCount,
    mismatchedCount,
    success,
    sampleMissing,
    sampleMismatched,
    verifiedAt: new Date().toISOString(),
  };
}

export const model = {
  type: "@svendowideit/dreamhost/inventory",
  version: "2026.10.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    accountInfo: {
      description: "Remote account and host details",
      schema: AccountInfoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    homeManifest: {
      description: "Deep file and directory manifest for an account home",
      schema: HomeManifestSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    findConfigs: {
      description: "Likely application configuration files",
      schema: z.object({
        root: z.string(),
        host: z.string(),
        user: z.string(),
        count: z.number(),
        configs: z.array(ConfigEntrySchema),
        exitCode: z.number(),
        stderr: z.string(),
        discoveredAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    databaseRefs: {
      description: "Redacted database references found in configuration files",
      schema: z.object({
        root: z.string(),
        host: z.string(),
        user: z.string(),
        count: z.number(),
        refs: z.array(DatabaseRefSchema),
        exitCode: z.number(),
        stderr: z.string(),
        discoveredAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    mailInventory: {
      description: "Mailbox and mail directory inventory",
      schema: z.object({
        root: z.string(),
        host: z.string(),
        user: z.string(),
        count: z.number(),
        mailboxes: z.array(MailEntrySchema),
        exitCode: z.number(),
        stderr: z.string(),
        discoveredAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    specialFiles: {
      description: "Symlinks, sockets, FIFO, and device files",
      schema: z.object({
        root: z.string(),
        host: z.string(),
        user: z.string(),
        count: z.number(),
        entries: z.array(SpecialEntrySchema),
        exitCode: z.number(),
        stderr: z.string(),
        discoveredAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    repositoryRoots: {
      description: "Repository metadata directories",
      schema: z.object({
        root: z.string(),
        host: z.string(),
        user: z.string(),
        count: z.number(),
        paths: z.array(z.string()),
        exitCode: z.number(),
        stderr: z.string(),
        discoveredAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cronHints: {
      description: "Crontab output and hints",
      schema: z.object({
        host: z.string(),
        user: z.string(),
        output: z.string(),
        exitCode: z.number(),
        stderr: z.string(),
        discoveredAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    backup: {
      description: "Result of an rsync backup of a DreamHost account",
      schema: z.object({
        host: z.string(),
        user: z.string(),
        localPath: z.string(),
        remotePath: z.string(),
        deleted: z.boolean(),
        dryRun: z.boolean(),
        checksum: z.boolean(),
        changed: z.boolean(),
        added: z.number(),
        modified: z.number(),
        deletedCount: z.number(),
        unchanged: z.number(),
        bytesTransferred: z.number(),
        files: z.array(z.object({
          action: z.string(),
          path: z.string(),
        })),
        exitCode: z.number(),
        command: z.string(),
        stderr: z.string(),
        backedUpAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    verifyBackup: {
      description:
        "Verification of a local account backup against its manifest",
      schema: z.object({
        host: z.string(),
        user: z.string(),
        localPath: z.string(),
        remoteBase: z.string(),
        checked: z.number(),
        verified: z.number(),
        missingCount: z.number(),
        mismatchedCount: z.number(),
        success: z.boolean(),
        sampleMissing: z.array(z.string()),
        sampleMismatched: z.array(z.object({
          path: z.string(),
          reason: z.string(),
        })),
        verifiedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    accountInfo: {
      description: "Collect basic account, host, and shell details",
      arguments: AccountInfoArgsSchema,
      execute: async (
        args: z.infer<typeof AccountInfoArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeAccountInfo(
          targetGlobalArgs(context.globalArgs, args),
          runCmd,
        );
        const handle = await context.writeResource(
          "accountInfo",
          "accountInfo",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    homeManifest: {
      description: "Build a recursive manifest of a home directory",
      arguments: HomeManifestArgsSchema,
      execute: async (
        args: z.infer<typeof HomeManifestArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeHomeManifest(
          targetGlobalArgs(context.globalArgs, args),
          { root: args.root, maxEntries: args.maxEntries },
          runCmd,
          context.logger,
        );
        const handle = await context.writeResource(
          "homeManifest",
          "homeManifest",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    findConfigs: {
      description: "Find likely application configuration files",
      arguments: FindConfigsArgsSchema,
      execute: async (
        args: z.infer<typeof FindConfigsArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeFindConfigs(
          targetGlobalArgs(context.globalArgs, args),
          { root: args.root },
          runCmd,
        );
        const handle = await context.writeResource(
          "findConfigs",
          "findConfigs",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    databaseRefs: {
      description:
        "Discover redacted database references in configuration files",
      arguments: DatabaseRefsArgsSchema,
      execute: async (
        args: z.infer<typeof DatabaseRefsArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeDatabaseRefs(
          targetGlobalArgs(context.globalArgs, args),
          { root: args.root },
          runCmd,
        );
        const handle = await context.writeResource(
          "databaseRefs",
          "databaseRefs",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    mailInventory: {
      description: "Inventory mail directories",
      arguments: MailInventoryArgsSchema,
      execute: async (
        args: z.infer<typeof MailInventoryArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeMailInventory(
          targetGlobalArgs(context.globalArgs, args),
          { root: args.root },
          runCmd,
        );
        const handle = await context.writeResource(
          "mailInventory",
          "mailInventory",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    specialFiles: {
      description: "Inventory symlinks and special files",
      arguments: SpecialFilesArgsSchema,
      execute: async (
        args: z.infer<typeof SpecialFilesArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeSpecialFiles(
          targetGlobalArgs(context.globalArgs, args),
          { root: args.root },
          runCmd,
        );
        const handle = await context.writeResource(
          "specialFiles",
          "specialFiles",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    repositoryRoots: {
      description: "Find repository metadata directories",
      arguments: RepositoryRootsArgsSchema,
      execute: async (
        args: z.infer<typeof RepositoryRootsArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeRepositoryRoots(
          targetGlobalArgs(context.globalArgs, args),
          { root: args.root },
          runCmd,
        );
        const handle = await context.writeResource(
          "repositoryRoots",
          "repositoryRoots",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    cronHints: {
      description: "Collect crontab output",
      arguments: CronHintsArgsSchema,
      execute: async (
        args: z.infer<typeof CronHintsArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeCronHints(
          targetGlobalArgs(context.globalArgs, args),
          runCmd,
        );
        const handle = await context.writeResource(
          "cronHints",
          "cronHints",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
    backup: {
      description:
        "Back up a DreamHost account's files locally with rsync over SSH",
      arguments: BackupArgsSchema,
      execute: async (
        args: z.infer<typeof BackupArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const requiredBytes = context.readResource
          ? Number(
            (await context.readResource("homeManifest"))?.totalBytes ?? 0,
          )
          : 0;
        const outcome = await executeBackup(
          targetGlobalArgs(context.globalArgs, args),
          args,
          runCmd,
          context.logger,
          Number.isFinite(requiredBytes) ? requiredBytes : 0,
        );
        const handle = await context.writeResource("backup", "backup", outcome);
        return { dataHandles: [handle] };
      },
    },
    verifyBackup: {
      description:
        "Verify that a local backup contains the manifest-recorded files",
      arguments: VerifyArgsSchema,
      execute: async (
        args: z.infer<typeof VerifyArgsSchema>,
        context: MethodContextLike,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const outcome = await executeVerifyBackup(
          targetGlobalArgs(context.globalArgs, args),
          { localPath: args.localPath },
          context,
          context.logger,
        );
        const handle = await context.writeResource(
          "verifyBackup",
          "verifyBackup",
          outcome,
        );
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.23.1",
      description:
        "Relaxes per-method argument validation that rejected global arguments, plus documentation corrections.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};

// Avoid accidental unused ref in strict module resolution contexts
export const _internal_marker = true;
