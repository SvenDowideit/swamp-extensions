/**
 * Disk usage auditor — recursively measures which directories and files are
 * consuming disk space on a local filesystem path.
 *
 * Cross-platform: uses only Deno runtime APIs (`Deno.stat`, `Deno.readDir`),
 * so the same extension runs on Linux, macOS, and Windows without shelling
 * out to OS-specific tools (`du`, `find`, PowerShell).
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  path: z.string().min(1).describe("Filesystem path to audit"),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AuditArgsSchema = z.object({
  depth: z.number().int().min(0).max(20).default(3).describe(
    "Maximum directory depth to recurse (0 = only the root entry)",
  ),
  topDirs: z.number().int().min(1).max(500).default(20).describe(
    "How many largest immediate subdirectories of the root to report",
  ),
  topFiles: z.number().int().min(1).max(500).default(20).describe(
    "How many largest individual files found during the walk to report",
  ),
  topExtensions: z.number().int().min(1).max(100).default(15).describe(
    "How many file extensions (by total bytes) to report",
  ),
  excludePatterns: z.array(z.string()).default([]).describe(
    'Glob-style patterns of directory names to skip (e.g. ["node_modules", ".git"])',
  ),
  followSymlinks: z.boolean().default(false).describe(
    "Whether to follow symbolic links when summing sizes (default false)",
  ),
});

type AuditArgs = z.infer<typeof AuditArgsSchema>;

/** A single directory entry in a disk audit result. */
export interface DirEntry {
  /** Absolute filesystem path of the directory. */
  path: string;
  /** Directory name (last path component). */
  name: string;
  /** Total bytes consumed by this directory and everything beneath it. */
  bytes: number;
  /** Number of files within this directory subtree. */
  fileCount: number;
  /** Number of subdirectories within this directory subtree. */
  dirCount: number;
}

/** A single file entry in a disk audit result. */
export interface FileEntry {
  /** Absolute filesystem path of the file. */
  path: string;
  /** File name (last path component). */
  name: string;
  /** Size of the file in bytes. */
  bytes: number;
  /** Lowercased file extension without the dot, or empty string if none. */
  extension: string;
}

/** A per-extension byte aggregate in a disk audit result. */
export interface ExtensionEntry {
  /** Lowercased extension string, or `"(none)"` for extensionless files. */
  extension: string;
  /** Total bytes across all files with this extension. */
  totalBytes: number;
  /** Number of files with this extension. */
  fileCount: number;
}

/** A per-path error recorded during the walk. */
export interface AuditError {
  /** Filesystem path where the error occurred. */
  path: string;
  /** Human-readable error message. */
  message: string;
}

/** Structured result of a disk usage audit. */
export interface AuditOutput {
  /** The root path that was audited. */
  rootPath: string;
  /** ISO-8601 timestamp marking when the audit began. */
  scannedAt: string;
  /** Total bytes consumed by all files under the root. */
  totalBytes: number;
  /** Total number of files found under the root. */
  totalFiles: number;
  /** Total number of subdirectories found under the root. */
  totalDirs: number;
  /** Maximum recursion depth requested for the walk. */
  maxDepth: number;
  /** Wall-clock duration of the audit in milliseconds. */
  durationMs: number;
  /** Largest immediate subdirectories of the root, sorted by bytes desc. */
  topDirs: DirEntry[];
  /** Largest individual files found during the walk, sorted by bytes desc. */
  largestFiles: FileEntry[];
  /** Per-extension byte aggregates, sorted by totalBytes desc. */
  extensions: ExtensionEntry[];
  /** Per-path errors encountered during the walk (never aborts the audit). */
  errors: AuditError[];
}

const DirEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  bytes: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  dirCount: z.number().int().nonnegative(),
});

const FileEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  bytes: z.number().nonnegative(),
  extension: z.string(),
});

const ExtensionEntrySchema = z.object({
  extension: z.string(),
  totalBytes: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
});

/** Zod schema describing the structured result of a disk usage audit. */
const AuditOutputSchema = z.object({
  rootPath: z.string(),
  scannedAt: z.iso.datetime(),
  totalBytes: z.number().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  totalDirs: z.number().int().nonnegative(),
  maxDepth: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  topDirs: z.array(DirEntrySchema),
  largestFiles: z.array(FileEntrySchema),
  extensions: z.array(ExtensionEntrySchema),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })),
});

/** Model definition for auditing local disk usage. */
export const model = {
  type: "@svendowideit/disk-auditor",
  version: "2026.07.17.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    audit: {
      description: "Disk usage audit for a path",
      schema: AuditOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    audit: {
      description: "Recursively measure disk usage under the configured path",
      arguments: AuditArgsSchema,
      execute: async (
        args: AuditArgs,
        context: {
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
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const root = context.globalArgs.path;
        const started = Date.now();
        const logger = context.logger;
        logger?.info("Auditing disk usage under {root}", { root });

        const result = await auditDisk({
          root,
          depth: args.depth,
          excludePatterns: args.excludePatterns,
          followSymlinks: args.followSymlinks,
          topDirs: args.topDirs,
          topFiles: args.topFiles,
          topExtensions: args.topExtensions,
          logger,
          heartbeatMs: 2000,
        });

        const durationMs = Date.now() - started;
        const durationS = (durationMs / 1000).toFixed(1);
        logger?.info(
          "Audit complete: {files} files, {dirs} dirs, {total} in {sec}s",
          {
            files: result.totalFiles,
            dirs: result.totalDirs,
            total: humanSize(result.totalBytes),
            sec: durationS,
          },
        );

        const handle = await context.writeResource("audit", "current", {
          rootPath: result.rootPath,
          scannedAt: result.scannedAt,
          totalBytes: result.totalBytes,
          totalFiles: result.totalFiles,
          totalDirs: result.totalDirs,
          maxDepth: result.maxDepth,
          durationMs,
          topDirs: result.topDirs,
          largestFiles: result.largestFiles,
          extensions: result.extensions,
          errors: result.errors,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};

type WalkResult = {
  bytes: number;
  fileCount: number;
  dirCount: number;
  files: { path: string; name: string; bytes: number; extension: string }[];
  dirs: {
    path: string;
    name: string;
    bytes: number;
    fileCount: number;
    dirCount: number;
  }[];
  errors: { path: string; message: string }[];
};

const excluded = (name: string, patterns: string[]): boolean =>
  patterns.some((p) => matchGlob(name, p));

function matchGlob(name: string, pattern: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(name);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(
    /\*/g,
    ".*",
  ).replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Format a byte count as a human-readable binary size (e.g. 1.4 GiB, 512 KiB). */
export function humanSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / Math.pow(1024, i);
  const formatted = i === 0 ? value.toString() : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}

/** Running progress state threaded through the walk for heartbeat logging. */
type ProgressState = {
  currentPath: string;
  filesScanned: number;
  dirsScanned: number;
  bytesFound: number;
  errorsCount: number;
  notableFiles: { path: string; name: string; bytes: number }[];
  notableDirs: { path: string; name: string; bytes: number }[];
  lastLogMs: number;
  startedMs: number;
  heartbeatMs: number;
};

/** Create a fresh progress state for a walk. */
function newProgressState(
  startedMs: number,
  heartbeatMs = 2000,
): ProgressState {
  return {
    currentPath: "",
    filesScanned: 0,
    dirsScanned: 0,
    bytesFound: 0,
    errorsCount: 0,
    notableFiles: [],
    notableDirs: [],
    lastLogMs: 0,
    startedMs,
    heartbeatMs,
  };
}

/** Note a large file if it qualifies for the running top-5 notable files. */
function noteFile(
  state: ProgressState,
  file: { path: string; name: string; bytes: number },
  minNotableBytes: number,
): void {
  if (file.bytes < minNotableBytes) return;
  state.notableFiles.push(file);
  state.notableFiles.sort((a, b) => b.bytes - a.bytes);
  if (state.notableFiles.length > 5) state.notableFiles.length = 5;
}

/** Note a completed large directory if it qualifies for the running top-5. */
function noteDir(
  state: ProgressState,
  dir: { path: string; name: string; bytes: number },
  minNotableBytes: number,
): void {
  if (dir.bytes < minNotableBytes) return;
  state.notableDirs.push(dir);
  state.notableDirs.sort((a, b) => b.bytes - a.bytes);
  if (state.notableDirs.length > 5) state.notableDirs.length = 5;
}

/** Emit a heartbeat log line if enough time has elapsed since the last one. */
function maybeLogProgress(state: ProgressState, logger?: ProgressLogger): void {
  if (!logger?.info) return;
  const now = Date.now();
  if (now - state.lastLogMs < state.heartbeatMs) return;
  state.lastLogMs = now;
  const elapsed = ((now - state.startedMs) / 1000).toFixed(1);
  const parts = [
    `${elapsed}s`,
    `${humanSize(state.bytesFound)} found`,
    `${state.filesScanned} files`,
    `${state.dirsScanned} dirs`,
  ];
  if (state.errorsCount > 0) parts.push(`${state.errorsCount} errors`);
  let line = `Scanning… ${parts.join(" · ")} — in ${state.currentPath}`;
  const notable = [...state.notableDirs, ...state.notableFiles]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);
  if (notable.length > 0) {
    const notableStr = notable.map((n) => `${n.name} (${humanSize(n.bytes)})`)
      .join(", ");
    line += ` — largest so far: ${notableStr}`;
  }
  logger.info(line);
}

/**
 * Recursively audit disk usage under `root`, returning the largest
 * subdirectories, largest files, and per-extension byte totals. Errors
 * encountered during the walk are collected rather than thrown.
 *
 * @param opts Configuration for the audit (root path, depth, exclusions, limits).
 * @returns The structured audit output.
 */
/** Optional progress logger — the execute function passes the engine's logger. */
export type ProgressLogger = {
  info?: (msg: string, props?: Record<string, unknown>) => void;
  debug?: (msg: string, props?: Record<string, unknown>) => void;
};

/**
 * Recursively audit disk usage under `root`, returning the largest
 * subdirectories, largest files, and per-extension byte totals. Errors
 * encountered during the walk are collected rather than thrown.
 *
 * @param opts Configuration for the audit (root path, depth, exclusions, limits).
 * @returns The structured audit output.
 */
export async function auditDisk(opts: {
  root: string;
  depth: number;
  excludePatterns: string[];
  followSymlinks: boolean;
  topDirs: number;
  topFiles: number;
  topExtensions: number;
  logger?: ProgressLogger;
  heartbeatMs?: number;
}): Promise<AuditOutput> {
  const {
    root,
    depth,
    excludePatterns,
    followSymlinks,
    topDirs,
    topFiles,
    topExtensions,
    logger,
    heartbeatMs,
  } = opts;
  const errors: { path: string; message: string }[] = [];
  const startedMs = Date.now();
  const state = newProgressState(startedMs, heartbeatMs);

  let rootStat: Awaited<ReturnType<typeof Deno.stat>>;
  try {
    rootStat = await Deno.stat(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rootPath: root,
      scannedAt: new Date().toISOString(),
      totalBytes: 0,
      totalFiles: 0,
      totalDirs: 0,
      maxDepth: depth,
      durationMs: 0,
      topDirs: [],
      largestFiles: [],
      extensions: [],
      errors: [{ path: root, message: msg }],
    };
  }

  if (!rootStat.isDirectory) {
    return {
      rootPath: root,
      scannedAt: new Date().toISOString(),
      totalBytes: rootStat.size ?? 0,
      totalFiles: rootStat.isFile ? 1 : 0,
      totalDirs: 0,
      maxDepth: depth,
      durationMs: 0,
      topDirs: [],
      largestFiles: [{
        path: root,
        name: root.split(/[/\\]/).pop() ?? root,
        bytes: rootStat.size ?? 0,
        extension: fileExtension(root),
      }],
      extensions: [{
        extension: fileExtension(root),
        totalBytes: rootStat.size ?? 0,
        fileCount: 1,
      }],
      errors,
    };
  }

  const walkResult = await walk({
    dir: root,
    depth,
    excludePatterns,
    followSymlinks,
    errors,
    logger,
    state,
    minNotableBytes: 1024 * 1024,
  });

  const topDirsList = walkResult.dirs
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topDirs);

  const largestFiles = walkResult.files
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topFiles);

  const extMap = new Map<string, { totalBytes: number; fileCount: number }>();
  for (const f of walkResult.files) {
    const key = f.extension || "(none)";
    const entry = extMap.get(key) ?? { totalBytes: 0, fileCount: 0 };
    entry.totalBytes += f.bytes;
    entry.fileCount += 1;
    extMap.set(key, entry);
  }
  const extensions = [...extMap.entries()]
    .map(([extension, v]) => ({
      extension,
      totalBytes: v.totalBytes,
      fileCount: v.fileCount,
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, topExtensions);

  return {
    rootPath: root,
    scannedAt: new Date().toISOString(),
    totalBytes: walkResult.bytes,
    totalFiles: walkResult.fileCount,
    totalDirs: walkResult.dirCount,
    maxDepth: depth,
    durationMs: 0,
    topDirs: topDirsList,
    largestFiles,
    extensions,
    errors,
  };
}

async function walk(opts: {
  dir: string;
  depth: number;
  excludePatterns: string[];
  followSymlinks: boolean;
  errors: { path: string; message: string }[];
  logger?: ProgressLogger;
  state: ProgressState;
  minNotableBytes: number;
}): Promise<WalkResult> {
  const result: WalkResult = {
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    files: [],
    dirs: [],
    errors: opts.errors,
  };
  const { state, logger, minNotableBytes } = opts;
  state.currentPath = opts.dir;

  let entries: Deno.DirEntry[];
  try {
    entries = Array.from(Deno.readDirSync(opts.dir));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.errors.push({ path: opts.dir, message: msg });
    state.errorsCount++;
    return result;
  }

  for (const entry of entries) {
    const fullPath = `${opts.dir}${
      opts.dir.endsWith("/") ? "" : "/"
    }${entry.name}`;

    if (entry.isDirectory) {
      if (excluded(entry.name, opts.excludePatterns)) continue;

      const childResult = await walk({
        dir: fullPath,
        depth: opts.depth - 1,
        excludePatterns: opts.excludePatterns,
        followSymlinks: opts.followSymlinks,
        errors: opts.errors,
        logger,
        state,
        minNotableBytes,
      });

      if (opts.depth > 0) {
        result.dirs.push({
          path: fullPath,
          name: entry.name,
          bytes: childResult.bytes,
          fileCount: childResult.fileCount,
          dirCount: childResult.dirCount,
        });
      }
      result.bytes += childResult.bytes;
      result.fileCount += childResult.fileCount;
      result.dirCount += 1 + childResult.dirCount;
      state.dirsScanned += 1;
      state.bytesFound += childResult.bytes;
      state.filesScanned += childResult.fileCount;
      noteDir(state, {
        path: fullPath,
        name: entry.name,
        bytes: childResult.bytes,
      }, minNotableBytes);
      maybeLogProgress(state, logger);
      continue;
    }

    if (entry.isSymlink && !opts.followSymlinks) {
      continue;
    }

    let size = 0;
    try {
      const stat = opts.followSymlinks
        ? await Deno.stat(fullPath)
        : await Deno.lstat(fullPath);
      if (stat.isDirectory) {
        const childResult = await walk({
          dir: fullPath,
          depth: opts.depth - 1,
          excludePatterns: opts.excludePatterns,
          followSymlinks: opts.followSymlinks,
          errors: opts.errors,
          logger,
          state,
          minNotableBytes,
        });
        if (opts.depth > 0) {
          result.dirs.push({
            path: fullPath,
            name: entry.name,
            bytes: childResult.bytes,
            fileCount: childResult.fileCount,
            dirCount: childResult.dirCount,
          });
        }
        result.bytes += childResult.bytes;
        result.fileCount += childResult.fileCount;
        result.dirCount += 1 + childResult.dirCount;
        state.dirsScanned += 1;
        state.bytesFound += childResult.bytes;
        state.filesScanned += childResult.fileCount;
        noteDir(state, {
          path: fullPath,
          name: entry.name,
          bytes: childResult.bytes,
        }, minNotableBytes);
        maybeLogProgress(state, logger);
        continue;
      }
      size = stat.size ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.errors.push({ path: fullPath, message: msg });
      state.errorsCount++;
      continue;
    }

    result.bytes += size;
    result.fileCount += 1;
    state.bytesFound += size;
    state.filesScanned += 1;
    result.files.push({
      path: fullPath,
      name: entry.name,
      bytes: size,
      extension: fileExtension(entry.name),
    });
    noteFile(
      state,
      { path: fullPath, name: entry.name, bytes: size },
      minNotableBytes,
    );
    maybeLogProgress(state, logger);
  }

  return result;
}
