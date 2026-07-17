/**
 * Disk usage auditor — recursively measures which directories and files are
 * consuming disk space on a local filesystem path, then classifies findings
 * by content type (video, audio, books, docker images, databases, etc.) so
 * the user can see *what* is taking up space, not just *where*.
 *
 * Cross-platform: uses only Deno runtime APIs (`Deno.stat`, `Deno.readDir`,
 * `Deno.lstat`), so the same extension runs on Linux, macOS, and Windows
 * without shelling out to OS-specific tools (`du`, `find`, PowerShell).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { resolve as resolvePath } from "jsr:@std/path@1";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Filesystem path to audit"),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AuditArgsSchema = z.object({
  excludePatterns: z.array(z.string()).default([".git", ".swamp"]).describe(
    'Glob-style directory names to skip (e.g. ["node_modules", ".git"])',
  ),
  followSymlinks: z.boolean().default(false).describe(
    "Whether to follow symbolic links when summing sizes (default false)",
  ),
  minNotableBytes: z.number().int().positive().default(1024 * 1024).describe(
    "Minimum size for a file or dir to be considered 'notable' (default 1 MiB)",
  ),
});

type AuditArgs = z.infer<typeof AuditArgsSchema>;

// ---------------------------------------------------------------------------
// Content classification
// ---------------------------------------------------------------------------

/** Content category label. */
const CATEGORIES = [
  "video",
  "audio",
  "audiobook",
  "ebook",
  "image",
  "docker",
  "vm",
  "database",
  "parquet",
  "archive",
  "code",
  "logs",
  "node_modules",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];

/** File extension → category map. Order matters: first match wins. */
const EXT_CATEGORY: Record<string, Category> = {
  // video
  mp4: "video",
  mkv: "video",
  avi: "video",
  mov: "video",
  webm: "video",
  flv: "video",
  wmv: "video",
  m4v: "video",
  mpg: "video",
  mpeg: "video",
  "3gp": "video",
  vob: "video",
  ogv: "video",
  // audio (non-audiobook)
  mp3: "audio",
  ogg: "audio",
  flac: "audio",
  aac: "audio",
  opus: "audio",
  mid: "audio",
  midi: "audio",
  mka: "audio",
  aiff: "audio",
  wav: "audio",
  // audiobook — by extension, refined by path later
  m4b: "audiobook",
  m4a: "audiobook",
  aax: "audiobook",
  // ebook
  epub: "ebook",
  mobi: "ebook",
  azw: "ebook",
  azw3: "ebook",
  pdf: "ebook",
  djvu: "ebook",
  fb2: "ebook",
  lit: "ebook",
  rtf: "ebook",
  // image
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  tiff: "image",
  tif: "image",
  heic: "image",
  avif: "image",
  svg: "image",
  ico: "image",
  raw: "image",
  cr2: "image",
  nef: "image",
  orf: "image",
  arw: "image",
  dng: "image",
  // docker
  // (handled by path/manifest detection — see classifyPath)
  // vm / disk images
  qcow2: "vm",
  vmdk: "vm",
  vdi: "vm",
  vhd: "vm",
  vhdx: "vm",
  img: "vm",
  iso: "vm",
  wim: "vm",
  // database
  db: "database",
  sqlite: "database",
  sqlitedb: "database",
  mdb: "database",
  accdb: "database",
  dbf: "database",
  // parquet / columnar
  parquet: "parquet",
  arrow: "parquet",
  orc: "parquet",
  avro: "parquet",
  // archive
  zip: "archive",
  tar: "archive",
  gz: "archive",
  "tar.gz": "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
  zst: "archive",
  lz4: "archive",
  cab: "archive",
  deb: "archive",
  rpm: "archive",
  // code
  js: "code",
  mjs: "code",
  cjs: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  swift: "code",
  scala: "code",
  clj: "code",
  lua: "code",
  pl: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  fish: "code",
  ps1: "code",
  // logs
  log: "logs",
  out: "logs",
  err: "logs",
};

/** Directory-name → category map. */
const DIR_CATEGORY: Record<string, Category> = {
  node_modules: "node_modules",
  ".git": "code",
  ".cache": "other",
  __pycache__: "code",
  ".venv": "code",
  venv: "code",
};

/** Docker-related directory names. */
const DOCKER_DIR_NAMES = new Set([
  "docker",
  "overlay2",
  "aufs",
  "devicemapper",
  "containers",
  "image",
  "volumes",
  "buildkit",
  "snapshots",
  "diff",
]);

/** Audiobook path keywords. */
const AUDIOBOOK_PATH_KEYWORDS = [
  "audiobook",
  "audiobooks",
  "audible",
  "librivox",
];
/** Ebook path keywords. */
const EBOOK_PATH_KEYWORDS = ["ebook", "ebooks", "kindle", "calibre", "library"];

function fileExtension(name: string): string {
  const lower = name.toLowerCase();
  // Handle compound extensions like .tar.gz
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".tar.bz2")) return "tar.bz2";
  if (lower.endsWith(".tar.xz")) return "tar.xz";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

/** Classify a file by extension, refined by path context. */
function classifyFile(ext: string, fullPath: string): Category {
  // Extension-based first
  let cat: Category = EXT_CATEGORY[ext] ?? "other";

  // Path-based refinement: if m4a/m4b/aax is under an audiobook path → audiobook,
  // if under a music path → audio. If mp3 is under audiobook path → audiobook.
  const lowerPath = fullPath.toLowerCase();
  if (cat === "audiobook" || ext === "mp3" || ext === "m4a") {
    if (AUDIOBOOK_PATH_KEYWORDS.some((k) => lowerPath.includes(k))) {
      cat = "audiobook";
    } else if (cat === "audiobook") {
      // m4b/aax without audiobook path context is still likely an audiobook
      cat = "audiobook";
    } else {
      cat = "audio";
    }
  }

  // Pdf under ebook path → ebook; pdf elsewhere → ebook still (default)
  if (ext === "pdf" && EBOOK_PATH_KEYWORDS.some((k) => lowerPath.includes(k))) {
    cat = "ebook";
  }

  // Images under raw/photo path stay image
  return cat;
}

// ---------------------------------------------------------------------------
// Schema & output types
// ---------------------------------------------------------------------------

/** A content category rollup. */
export interface CategoryRollup {
  /** Category label. */
  category: string;
  /** Human-readable label (e.g. "Videos", "Audiobooks"). */
  label: string;
  /** Total bytes across all files in this category. */
  totalBytes: number;
  /** Number of files in this category. */
  fileCount: number;
  /** Fraction of total disk usage (0..1). */
  fraction: number;
}

/** A notable directory found during the walk. */
export interface NotableDir {
  /** Absolute filesystem path. */
  path: string;
  /** Directory name (last component). */
  name: string;
  /** Total bytes under this directory. */
  bytes: number;
  /** File count under this directory. */
  fileCount: number;
  /** Dominant content category (if one category is >50% of bytes). */
  dominantCategory: string | null;
  /** Depth from the audit root (0 = immediate child). */
  depth: number;
}

/** A notable file found during the walk. */
export interface NotableFile {
  /** Absolute filesystem path. */
  path: string;
  /** File name. */
  name: string;
  /** Size in bytes. */
  bytes: number;
  /** Content category. */
  category: string;
}

/** A semantic finding (a group of related items the user should know about). */
export interface Finding {
  /** Finding type — what kind of group this is. */
  kind: string;
  /** Human-readable title (e.g. "3 large Docker images", "Audiobooks: 42 files"). */
  title: string;
  /** Category label if applicable. */
  category: string | null;
  /** Total bytes for this finding. */
  totalBytes: number;
  /** Number of items in this finding. */
  count: number;
  /** Sample paths (up to 5). */
  samplePaths: string[];
  /** Whether this finding is notable enough to highlight. */
  notable: boolean;
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
  /** Wall-clock duration of the audit in milliseconds. */
  durationMs: number;
  /** Per-category byte rollups, sorted by totalBytes desc. */
  categories: CategoryRollup[];
  /** Notable directories (large or category-dominant), sorted by bytes desc. */
  notableDirs: NotableDir[];
  /** Notable individual files (large), sorted by bytes desc. */
  notableFiles: NotableFile[];
  /** Semantic findings — grouped insights the user should know about. */
  findings: Finding[];
  /** Per-path errors encountered during the walk (never aborts the audit). */
  errors: AuditError[];
}

const CategoryRollupSchema = z.object({
  category: z.string(),
  label: z.string(),
  totalBytes: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  fraction: z.number().nonnegative(),
});

const NotableDirSchema = z.object({
  path: z.string(),
  name: z.string(),
  bytes: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  dominantCategory: z.string().nullable(),
  depth: z.number().int().nonnegative(),
});

const NotableFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  bytes: z.number().nonnegative(),
  category: z.string(),
});

const FindingSchema = z.object({
  kind: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  totalBytes: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
  samplePaths: z.array(z.string()),
  notable: z.boolean(),
});

/** Zod schema describing the structured result of a disk usage audit. */
const AuditOutputSchema = z.object({
  rootPath: z.string(),
  scannedAt: z.iso.datetime(),
  totalBytes: z.number().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  totalDirs: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  categories: z.array(CategoryRollupSchema),
  notableDirs: z.array(NotableDirSchema),
  notableFiles: z.array(NotableFileSchema),
  findings: z.array(FindingSchema),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })),
});

// ---------------------------------------------------------------------------
// Human-readable size
// ---------------------------------------------------------------------------

/** Format a byte count as a human-readable binary size (e.g. 1.4 GiB, 512 KiB). */
export function humanSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / Math.pow(1024, i);
  const formatted = i === 0 ? value.toString() : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Progress logging
// ---------------------------------------------------------------------------

/** Optional progress logger — the execute function passes the engine's logger. */
export type ProgressLogger = {
  info?: (msg: string, props?: Record<string, unknown>) => void;
  debug?: (msg: string, props?: Record<string, unknown>) => void;
};

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

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

type WalkResult = {
  bytes: number;
  fileCount: number;
  dirCount: number;
  files: {
    path: string;
    name: string;
    bytes: number;
    ext: string;
    category: Category;
  }[];
  dirs: {
    path: string;
    name: string;
    bytes: number;
    fileCount: number;
    dirCount: number;
    depth: number;
    categoryBreakdown: Map<Category, number>;
    fileCountByCategory: Map<Category, number>;
  }[];
  errors: { path: string; message: string }[];
  categoryBreakdown: Map<Category, number>;
  fileCountByCategory: Map<Category, number>;
};

const MAX_DEPTH = 30;

/** Glob match helper. */
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

const excluded = (name: string, patterns: string[]): boolean =>
  patterns.some((p) => matchGlob(name, p));

/** Recursively walk a directory, classifying every file and directory. */
/** A frame on the iterative walk stack — one per directory being processed. */
type WalkFrame = {
  dir: string;
  depth: number;
  name: string;
  entries: Deno.DirEntry[];
  entryIndex: number;
  bytes: number;
  fileCount: number;
  dirCount: number;
  localCategoryBytes: Map<Category, number>;
  localCategoryCounts: Map<Category, number>;
  childCategoryBytes: Map<Category, number>;
  childCategoryCounts: Map<Category, number>;
  childDirs: WalkResult["dirs"];
  childFiles: WalkResult["files"];
};

/** Iteratively walk a directory tree (stack-based, no recursion) classifying every file. */
async function walk(opts: {
  dir: string;
  excludePatterns: string[];
  followSymlinks: boolean;
  errors: { path: string; message: string }[];
  logger?: ProgressLogger;
  state: ProgressState;
  minNotableBytes: number;
}): Promise<WalkResult> {
  const { state, logger, minNotableBytes } = opts;
  const rootResult: WalkResult = {
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    files: [],
    dirs: [],
    errors: opts.errors,
    categoryBreakdown: new Map(),
    fileCountByCategory: new Map(),
  };

  // Stack of frames; root is pushed first
  const stack: WalkFrame[] = [];
  const rootName = opts.dir.split(/[/\\]/).pop() ?? opts.dir;
  const rootEntries = readDirEntries(opts.dir, opts.errors, state);
  if (rootEntries === null) return rootResult;
  stack.push({
    dir: opts.dir,
    depth: -1,
    name: rootName,
    entries: rootEntries,
    entryIndex: 0,
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    localCategoryBytes: new Map(),
    localCategoryCounts: new Map(),
    childCategoryBytes: new Map(),
    childCategoryCounts: new Map(),
    childDirs: [],
    childFiles: [],
  });

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    state.currentPath = frame.dir;

    // Process entries one at a time; when exhausted, pop and merge into parent
    if (frame.entryIndex >= frame.entries.length) {
      // Frame complete — compute its category breakdown
      const categoryBreakdown = mergeCategoryMaps(frame.localCategoryBytes, [
        frame.childCategoryBytes,
      ]);
      const fileCountByCategory = mergeCategoryMaps(frame.localCategoryCounts, [
        frame.childCategoryCounts,
      ]);
      const frameResult: WalkResult = {
        bytes: frame.bytes,
        fileCount: frame.fileCount,
        dirCount: frame.dirCount,
        files: [...frame.childFiles],
        dirs: [...frame.childDirs],
        errors: opts.errors,
        categoryBreakdown,
        fileCountByCategory,
      };
      stack.pop();

      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        // Add this dir as a child of parent
        const dirDepth = frame.depth;
        parent.childDirs.push({
          path: frame.dir,
          name: frame.name,
          bytes: frameResult.bytes,
          fileCount: frameResult.fileCount,
          dirCount: frameResult.dirCount,
          depth: dirDepth,
          categoryBreakdown: frameResult.categoryBreakdown,
          fileCountByCategory: frameResult.fileCountByCategory,
        });
        parent.bytes += frameResult.bytes;
        parent.fileCount += frameResult.fileCount;
        parent.dirCount += 1 + frameResult.dirCount;
        for (const f of frameResult.files) parent.childFiles.push(f);
        for (const d of frameResult.dirs) parent.childDirs.push(d);
        // Merge category breakdown into parent's child maps
        for (const [k, v] of frameResult.categoryBreakdown.entries()) {
          parent.childCategoryBytes.set(
            k,
            (parent.childCategoryBytes.get(k) ?? 0) + v,
          );
        }
        for (const [k, v] of frameResult.fileCountByCategory.entries()) {
          parent.childCategoryCounts.set(
            k,
            (parent.childCategoryCounts.get(k) ?? 0) + v,
          );
        }
        state.dirsScanned += 1;
        state.bytesFound += frameResult.bytes;
        state.filesScanned += frameResult.fileCount;
        noteDir(state, {
          path: frame.dir,
          name: frame.name,
          bytes: frameResult.bytes,
        }, minNotableBytes);
        maybeLogProgress(state, logger);
      } else {
        // This was the root frame
        rootResult.bytes = frameResult.bytes;
        rootResult.fileCount = frameResult.fileCount;
        rootResult.dirCount = frameResult.dirCount;
        rootResult.files = frameResult.files;
        rootResult.dirs = frameResult.dirs;
        rootResult.categoryBreakdown = frameResult.categoryBreakdown;
        rootResult.fileCountByCategory = frameResult.fileCountByCategory;
      }
      continue;
    }

    const entry = frame.entries[frame.entryIndex];
    frame.entryIndex++;
    const fullPath = `${frame.dir}${
      frame.dir.endsWith("/") ? "" : "/"
    }${entry.name}`;

    if (entry.isDirectory) {
      if (excluded(entry.name, opts.excludePatterns)) continue;
      const childDepth = frame.depth + 1;
      if (childDepth > MAX_DEPTH) continue;
      // Push child frame onto stack — we'll resume this frame after it completes
      const childEntries = readDirEntries(fullPath, opts.errors, state);
      if (childEntries === null) continue;
      stack.push({
        dir: fullPath,
        depth: childDepth,
        name: entry.name,
        entries: childEntries,
        entryIndex: 0,
        bytes: 0,
        fileCount: 0,
        dirCount: 0,
        localCategoryBytes: new Map(),
        localCategoryCounts: new Map(),
        childCategoryBytes: new Map(),
        childCategoryCounts: new Map(),
        childDirs: [],
        childFiles: [],
      });
      continue;
    }

    if (entry.isSymlink && !opts.followSymlinks) {
      continue;
    }

    let size = 0;
    let isDir = false;
    try {
      const stat = opts.followSymlinks
        ? await Deno.stat(fullPath)
        : await Deno.lstat(fullPath);
      if (stat.isDirectory) {
        isDir = true;
      } else {
        size = stat.size ?? 0;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.errors.push({ path: fullPath, message: msg });
      state.errorsCount++;
      continue;
    }

    if (isDir) {
      const childDepth = frame.depth + 1;
      if (childDepth > MAX_DEPTH) continue;
      const childEntries = readDirEntries(fullPath, opts.errors, state);
      if (childEntries === null) continue;
      stack.push({
        dir: fullPath,
        depth: childDepth,
        name: entry.name,
        entries: childEntries,
        entryIndex: 0,
        bytes: 0,
        fileCount: 0,
        dirCount: 0,
        localCategoryBytes: new Map(),
        localCategoryCounts: new Map(),
        childCategoryBytes: new Map(),
        childCategoryCounts: new Map(),
        childDirs: [],
        childFiles: [],
      });
      continue;
    }

    const ext = fileExtension(entry.name);
    const category = classifyFile(ext, fullPath);
    frame.bytes += size;
    frame.fileCount += 1;
    state.bytesFound += size;
    state.filesScanned += 1;
    frame.childFiles.push({
      path: fullPath,
      name: entry.name,
      bytes: size,
      ext,
      category,
    });
    noteFile(
      state,
      { path: fullPath, name: entry.name, bytes: size },
      minNotableBytes,
    );
    frame.localCategoryBytes.set(
      category,
      (frame.localCategoryBytes.get(category) ?? 0) + size,
    );
    frame.localCategoryCounts.set(
      category,
      (frame.localCategoryCounts.get(category) ?? 0) + 1,
    );
    maybeLogProgress(state, logger);
  }

  return rootResult;
}

/** Read directory entries, returning null on error (error is pushed to errors). */
function readDirEntries(
  dir: string,
  errors: { path: string; message: string }[],
  state: ProgressState,
): Deno.DirEntry[] | null {
  try {
    return Array.from(Deno.readDirSync(dir));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ path: dir, message: msg });
    state.errorsCount++;
    return null;
  }
}

/** Merge a local map with child dirs' maps. */
function mergeCategoryMaps(
  local: Map<Category, number>,
  childMaps: Map<Category, number>[],
): Map<Category, number> {
  const merged = new Map<Category, number>(local);
  for (const childMap of childMaps) {
    if (!childMap) continue;
    for (const [k, v] of childMap.entries()) {
      merged.set(k, (merged.get(k) ?? 0) + v);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Human-readable label for a category. */
const CATEGORY_LABELS: Record<Category, string> = {
  video: "Videos",
  audio: "Audio",
  audiobook: "Audiobooks",
  ebook: "Ebooks",
  image: "Images",
  docker: "Docker",
  vm: "VM/disk images",
  database: "Databases",
  parquet: "Parquet/columnar",
  archive: "Archives",
  code: "Source code",
  logs: "Log files",
  node_modules: "node_modules",
  other: "Other",
};

/** Compute per-category rollups from the walk's file list. */
function computeCategories(
  files: { category: Category; bytes: number }[],
  totalBytes: number,
): CategoryRollup[] {
  const bytesByCat = new Map<Category, number>();
  const countByCat = new Map<Category, number>();
  for (const f of files) {
    bytesByCat.set(f.category, (bytesByCat.get(f.category) ?? 0) + f.bytes);
    countByCat.set(f.category, (countByCat.get(f.category) ?? 0) + 1);
  }
  const result: CategoryRollup[] = [];
  for (const cat of CATEGORIES) {
    const total = bytesByCat.get(cat) ?? 0;
    if (total === 0) continue;
    result.push({
      category: cat,
      label: CATEGORY_LABELS[cat],
      totalBytes: total,
      fileCount: countByCat.get(cat) ?? 0,
      fraction: totalBytes > 0 ? total / totalBytes : 0,
    });
  }
  return result.sort((a, b) => b.totalBytes - a.totalBytes);
}

/** Find the dominant category for a directory (>50% of bytes). */
function dominantCategory(breakdown: Map<Category, number>): Category | null {
  let total = 0;
  let best: Category | null = null;
  let bestBytes = 0;
  for (const [cat, bytes] of breakdown.entries()) {
    total += bytes;
    if (bytes > bestBytes) {
      bestBytes = bytes;
      best = cat;
    }
  }
  if (total === 0 || best === null) return null;
  return bestBytes / total > 0.5 ? best : null;
}

/** Select notable directories: large ones, or category-dominant at any depth. */
function selectNotableDirs(
  dirs: WalkResult["dirs"],
  totalBytes: number,
  minNotableBytes: number,
): NotableDir[] {
  const notable: NotableDir[] = [];
  for (const d of dirs) {
    let dom = dominantCategory(d.categoryBreakdown);
    // Fall back to name-based classification for dirs whose content is "other"
    // or undetermined but whose name matches a known category (node_modules, docker)
    if (dom === null || dom === "other") {
      const lower = d.name.toLowerCase();
      if (DIR_CATEGORY[lower]) dom = DIR_CATEGORY[lower];
      else if (DOCKER_DIR_NAMES.has(lower)) dom = "docker";
    }
    const isLarge = d.bytes >= minNotableBytes;
    const isSignificantFraction = totalBytes > 0 && d.bytes / totalBytes > 0.01; // >1% of total
    const hasDominantCategory = dom !== null && dom !== "other";
    if (isLarge || isSignificantFraction || hasDominantCategory) {
      notable.push({
        path: d.path,
        name: d.name,
        bytes: d.bytes,
        fileCount: d.fileCount,
        dominantCategory: dom,
        depth: d.depth,
      });
    }
  }
  // Sort by bytes desc, cap at 50 to keep output manageable
  return notable.sort((a, b) => b.bytes - a.bytes).slice(0, 50);
}

/** Select notable files: large individual files, sorted by bytes. */
function selectNotableFiles(
  files: WalkResult["files"],
  minNotableBytes: number,
): NotableFile[] {
  return files
    .filter((f) => f.bytes >= minNotableBytes)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 50)
    .map((f) => ({
      path: f.path,
      name: f.name,
      bytes: f.bytes,
      category: f.category,
    }));
}

/** Build semantic findings from the walk results. */
function buildFindings(
  categories: CategoryRollup[],
  notableDirs: NotableDir[],
  notableFiles: NotableFile[],
  totalBytes: number,
): Finding[] {
  const findings: Finding[] = [];
  const totalFraction = (b: number) => totalBytes > 0 ? b / totalBytes : 0;

  // 1. Per-category findings — notable if the category is >2% of total
  for (const cat of categories) {
    if (cat.fraction < 0.02) continue;
    const sampleDirs = notableDirs
      .filter((d) => d.dominantCategory === cat.category)
      .slice(0, 3)
      .map((d) => d.path);
    const sampleFiles = notableFiles
      .filter((f) => f.category === cat.category)
      .slice(0, 3)
      .map((f) => f.path);
    findings.push({
      kind: "category",
      title: `${cat.label}: ${cat.fileCount} files, ${
        humanSize(cat.totalBytes)
      } (${(cat.fraction * 100).toFixed(0)}%)`,
      category: cat.category,
      totalBytes: cat.totalBytes,
      count: cat.fileCount,
      samplePaths: [...sampleDirs, ...sampleFiles].slice(0, 5),
      notable: cat.fraction > 0.05,
    });
  }

  // 2. Books combined (audiobooks + ebooks)
  const audiobookCat = categories.find((c) => c.category === "audiobook");
  const ebookCat = categories.find((c) => c.category === "ebook");
  const bookBytes = (audiobookCat?.totalBytes ?? 0) +
    (ebookCat?.totalBytes ?? 0);
  const bookCount = (audiobookCat?.fileCount ?? 0) + (ebookCat?.fileCount ?? 0);
  if (bookBytes > 0 && totalFraction(bookBytes) > 0.005) {
    const samples = [
      ...notableFiles.filter((f) => f.category === "audiobook").map((f) =>
        f.path
      ),
      ...notableFiles.filter((f) => f.category === "ebook").map((f) => f.path),
    ].slice(0, 5);
    findings.push({
      kind: "books-combined",
      title: `Books (audiobooks + ebooks): ${bookCount} files, ${
        humanSize(bookBytes)
      }`,
      category: null,
      totalBytes: bookBytes,
      count: bookCount,
      samplePaths: samples,
      notable: totalFraction(bookBytes) > 0.02,
    });
  }

  // 3. Docker images — group docker-category dirs/files
  const dockerBytes =
    categories.find((c) => c.category === "docker")?.totalBytes ?? 0;
  const dockerDirs = notableDirs.filter((d) => d.dominantCategory === "docker");
  if (dockerBytes > 0 || dockerDirs.length > 0) {
    const dockerCount = dockerDirs.length || 1;
    findings.push({
      kind: "docker",
      title: `Docker: ${dockerCount} image${dockerCount > 1 ? "s" : ""}, ${
        humanSize(dockerBytes)
      }`,
      category: "docker",
      totalBytes: dockerBytes,
      count: dockerCount,
      samplePaths: dockerDirs.slice(0, 5).map((d) => d.path),
      notable: dockerBytes > 0,
    });
  }

  // 4. Large parquet files specifically
  const parquetFiles = notableFiles.filter((f) => f.category === "parquet");
  if (parquetFiles.length > 0) {
    const parquetBytes = parquetFiles.reduce((s, f) => s + f.bytes, 0);
    findings.push({
      kind: "parquet",
      title: `${parquetFiles.length} large Parquet file${
        parquetFiles.length > 1 ? "s" : ""
      }: ${humanSize(parquetBytes)}`,
      category: "parquet",
      totalBytes: parquetBytes,
      count: parquetFiles.length,
      samplePaths: parquetFiles.slice(0, 5).map((f) => f.path),
      notable: parquetFiles.length > 0,
    });
  }

  // 5. VM/disk images
  const vmFiles = notableFiles.filter((f) => f.category === "vm");
  if (vmFiles.length > 0) {
    const vmBytes = vmFiles.reduce((s, f) => s + f.bytes, 0);
    findings.push({
      kind: "vm-images",
      title: `${vmFiles.length} VM/disk image${
        vmFiles.length > 1 ? "s" : ""
      }: ${humanSize(vmBytes)}`,
      category: "vm",
      totalBytes: vmBytes,
      count: vmFiles.length,
      samplePaths: vmFiles.slice(0, 5).map((f) => f.path),
      notable: vmFiles.length > 0,
    });
  }

  // 6. node_modules directories
  const nodeModulesDirs = notableDirs.filter((d) =>
    d.dominantCategory === "node_modules" || d.name === "node_modules"
  );
  if (nodeModulesDirs.length > 0) {
    const nmBytes = nodeModulesDirs.reduce((s, d) => s + d.bytes, 0);
    findings.push({
      kind: "node_modules",
      title: `${nodeModulesDirs.length} node_modules dir${
        nodeModulesDirs.length > 1 ? "s" : ""
      }: ${humanSize(nmBytes)}`,
      category: "node_modules",
      totalBytes: nmBytes,
      count: nodeModulesDirs.length,
      samplePaths: nodeModulesDirs.slice(0, 5).map((d) => d.path),
      notable: nodeModulesDirs.length > 0,
    });
  }

  // Sort findings: notable first, then by totalBytes desc
  return findings.sort((a, b) => {
    if (a.notable !== b.notable) return a.notable ? -1 : 1;
    return b.totalBytes - a.totalBytes;
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/** Model definition for auditing local disk usage. */
export const model = {
  type: "@svendowideit/disk-auditor",
  version: "2026.07.17.3",
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
        if (!context.globalArgs.path || context.globalArgs.path.trim() === "") {
          context.logger?.info(
            "Missing required input: path\n\n" +
              "disk-auditor scans a filesystem path and classifies what's consuming disk space\n" +
              "(video, audio, books, docker, VM images, parquet, databases, archives, code,\n" +
              "node_modules, etc.) with semantic findings — no depth or top-N knobs needed.\n\n" +
              "Usage:\n" +
              "  swamp workflow run disk --input path=/\n" +
              "  swamp workflow run disk --input path=/home\n" +
              "  swamp workflow run disk --input path=/var --skip-reports\n\n" +
              "Inputs:\n" +
              "  path              string    (required)  Filesystem path to audit\n" +
              '  excludePatterns   string[]  default: [".git", ".swamp"]  Dir names to skip\n' +
              "  followSymlinks    boolean   default: false   Follow symbolic links\n" +
              "  minNotableBytes   integer   default: 1048576 (1 MiB)  Min size for notable items\n\n" +
              "Examples:\n" +
              "  swamp workflow run disk --input path=/home --skip-reports\n" +
              '  swamp workflow run disk --input path=/ --input \'excludePatterns:json=[".git","node_modules"]\'\n\n' +
              "Then read the result:\n" +
              "  swamp data get --workflow disk current --json | jq -r '.content' | jq '.findings[] | .title'",
          );
          throw new Error(
            'Missing required input: path — run "swamp workflow run disk --input path=/" (see logged help above)',
          );
        }
        const started = Date.now();
        const logger = context.logger;
        // Expand relative paths and ~ to an absolute, unambiguous path.
        // resolvePath handles "./foo", "../foo", and joins against Deno.cwd().
        // Deno.realPathSync also resolves symlinks so the recorded path is canonical.
        const rawPath = context.globalArgs.path;
        const expanded = rawPath.startsWith("~")
          ? resolvePath(Deno.env.get("HOME") ?? "~", rawPath.slice(1))
          : resolvePath(rawPath);
        const root = Deno.realPathSync(expanded);
        logger?.info("Auditing disk usage under {root}", { root });

        const result = await auditDisk({
          root,
          excludePatterns: args.excludePatterns,
          followSymlinks: args.followSymlinks,
          minNotableBytes: args.minNotableBytes,
          logger,
          heartbeatMs: 2000,
        });

        const durationMs = Date.now() - started;
        const durationS = (durationMs / 1000).toFixed(1);
        logger?.info(
          "Audit complete: {files} files, {dirs} dirs, {total} in {sec}s — {cats} categories, {findings} findings",
          {
            files: result.totalFiles,
            dirs: result.totalDirs,
            total: humanSize(result.totalBytes),
            sec: durationS,
            cats: result.categories.length,
            findings: result.findings.length,
          },
        );

        const handle = await context.writeResource("audit", "current", {
          rootPath: result.rootPath,
          scannedAt: result.scannedAt,
          totalBytes: result.totalBytes,
          totalFiles: result.totalFiles,
          totalDirs: result.totalDirs,
          durationMs,
          categories: result.categories,
          notableDirs: result.notableDirs,
          notableFiles: result.notableFiles,
          findings: result.findings,
          errors: result.errors,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Recursively audit disk usage under `root`, returning categorized findings.
 * Errors encountered during the walk are collected rather than thrown.
 *
 * @param opts Configuration for the audit (root path, exclusions, limits).
 * @returns The structured audit output with categories, findings, and notable items.
 */
export async function auditDisk(opts: {
  root: string;
  excludePatterns: string[];
  followSymlinks: boolean;
  minNotableBytes: number;
  logger?: ProgressLogger;
  heartbeatMs?: number;
}): Promise<AuditOutput> {
  const {
    root,
    excludePatterns,
    followSymlinks,
    minNotableBytes,
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
      durationMs: 0,
      categories: [],
      notableDirs: [],
      notableFiles: [],
      findings: [],
      errors: [{ path: root, message: msg }],
    };
  }

  if (!rootStat.isDirectory) {
    const ext = fileExtension(root);
    const category = classifyFile(ext, root);
    const size = rootStat.size ?? 0;
    return {
      rootPath: root,
      scannedAt: new Date().toISOString(),
      totalBytes: size,
      totalFiles: rootStat.isFile ? 1 : 0,
      totalDirs: 0,
      durationMs: 0,
      categories: [{
        category,
        label: CATEGORY_LABELS[category],
        totalBytes: size,
        fileCount: 1,
        fraction: 1,
      }],
      notableDirs: [],
      notableFiles: [{
        path: root,
        name: root.split(/[/\\]/).pop() ?? root,
        bytes: size,
        category,
      }],
      findings: [{
        kind: "single-file",
        title: `${root}: ${humanSize(size)} (${CATEGORY_LABELS[category]})`,
        category,
        totalBytes: size,
        count: 1,
        samplePaths: [root],
        notable: true,
      }],
      errors,
    };
  }

  const walkResult = await walk({
    dir: root,
    excludePatterns,
    followSymlinks,
    errors,
    logger,
    state,
    minNotableBytes,
  });

  const totalBytes = walkResult.bytes;
  const categories = computeCategories(walkResult.files, totalBytes);
  const notableDirs = selectNotableDirs(
    walkResult.dirs,
    totalBytes,
    minNotableBytes,
  );
  const notableFiles = selectNotableFiles(walkResult.files, minNotableBytes);
  const findings = buildFindings(
    categories,
    notableDirs,
    notableFiles,
    totalBytes,
  );

  return {
    rootPath: root,
    scannedAt: new Date().toISOString(),
    totalBytes,
    totalFiles: walkResult.fileCount,
    totalDirs: walkResult.dirCount,
    durationMs: Date.now() - startedMs,
    categories,
    notableDirs,
    notableFiles,
    findings,
    errors,
  };
}
