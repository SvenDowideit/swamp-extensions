/**
 * Synology NAS disk usage by category.
 *
 * Connects to a Synology DSM host over SSH, discovers its volumes and top-level
 * shares, then walks the filesystem and classifies every file into
 * Synology-aware buckets: Docker/Container Manager images, Synology app data,
 * Google Drive and Google Photos backups, ordinary backups, recycle bins, user
 * homes, media, and content-type fallbacks.
 *
 * The walk is streamed from `find` over SSH (NUL-delimited), so memory stays
 * bounded even on a multi-million-file NAS. When `find -printf` is unavailable
 * the model falls back to a fast `du` share-level scan.
 *
 * Pure helpers (classification, parsing, aggregation) are exported for tests;
 * only the model methods and the SSH helpers do IO.
 *
 * @module
 */
import { z } from "npm:zod@4";

import { humanSize } from "./synology_disk_usage_shared.ts";

export { humanSize };

// ---------------------------------------------------------------------------
// Category rules
// ---------------------------------------------------------------------------

/** One path-based category rule, tested against the full remote path. */
export interface CategoryRule {
  /** Stable category id (e.g. `google-drive`, `docker`). */
  id: string;
  /** Human-readable label shown in the report. */
  label: string;
  /** Case-insensitive regular expressions; the first match wins. */
  patterns: string[];
}

/** Compiled form of a category rule (regexes constructed once per run). */
export interface CompiledRule {
  /** Stable category id. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Compiled case-insensitive patterns. */
  regexes: RegExp[];
}

const CategoryRuleSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/).describe(
    "Stable category id, lowercase letters/digits/hyphens",
  ),
  label: z.string().min(1).describe("Human-readable category label"),
  patterns: z.array(z.string().min(1)).min(1).describe(
    "Case-insensitive regular expressions against the full path; first match wins",
  ),
});

/**
 * Built-in Synology categories, ordered most-specific first.
 *
 * Rules are matched before the file-extension fallback, so a path under
 * `homes/` is "User files" even when it contains photos, while a file in an
 * unclassified share falls through to its content type.
 */
export const DEFAULT_CATEGORY_RULES: CategoryRule[] = [
  {
    id: "google-photos",
    label: "Google Photos backups",
    patterns: [
      "(^|/)google[ _-]?photos(/|$)",
      "(^|/)photos\\.google(/|$)",
    ],
  },
  {
    id: "google-drive",
    label: "Google Drive backups",
    patterns: [
      "(^|/)google[ _-]?drive(/|$)",
      "(^|/)(googledrive|gdrive)(/|$)",
    ],
  },
  {
    id: "docker",
    label: "Docker images & containers",
    patterns: [
      "(^|/)@docker(/|$)",
      "(^|/)docker(/|$)",
      "(^|/)docker/(overlay2|aufs|containers|volumes|image|buildkit|snapshots)/",
    ],
  },
  {
    id: "recycle-bin",
    label: "Recycle bins (#recycle)",
    patterns: ["(^|/)#recycle(/|$)"],
  },
  {
    id: "virtual-machines",
    label: "Virtual machines",
    patterns: [
      "(^|/)@vmm(/|$)",
      "(^|/)(virtual[ _-]?machine[ _-]?manager|vmm)(/|$)",
    ],
  },
  {
    id: "backups",
    label: "Backups",
    patterns: [
      "(^|/)(backups?|bak)(/|$)",
      "(^|/)(hyper[ _-]?backup|active[ _-]?backup|time[ _-]?machine|timemachine)(/|$)",
      "(^|/)[^/]*(backup|snapshot)[^/]*/",
    ],
  },
  {
    id: "synology-app-data",
    label: "Synology app data",
    patterns: [
      "(^|/)@(appstore|appdata|apphome|database|synologydrive|cloudsync|mail|spool|tmp|eadir|s2s|img_bkp_cache|iscsi|synologyapplicationstore|userdata|webapi|surveillance)(/|$)",
      "(^|/)volume[0-9]+/@[^/]+(/|$)",
      "(^|/)(surveillance|surveillance[ _-]?station|synology[ _-]?drive|cloud[ _-]?sync|mailplus)(/|$)",
    ],
  },
  {
    id: "media",
    label: "Media",
    patterns: [
      "(^|/)(media|movies?|video|videos|tv|tvshows?|music|audio|photos?|pictures?)(/|$)",
    ],
  },
  {
    id: "user-files",
    label: "User files",
    patterns: ["(^|/)(homes?|users?)(/|$)"],
  },
];

/** Labels for the content-type categories used when no path rule matches. */
export const CONTENT_CATEGORY_LABELS: Record<string, string> = {
  video: "Videos",
  audio: "Audio",
  image: "Images",
  document: "Documents",
  archive: "Archives",
  code: "Source code",
  database: "Databases",
  "vm-image": "VM/disk images",
  other: "Other",
};

/** File extension → content category. */
const EXT_CATEGORY: Record<string, string> = {
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
  mp3: "audio",
  ogg: "audio",
  flac: "audio",
  aac: "audio",
  opus: "audio",
  m4a: "audio",
  wav: "audio",
  aiff: "audio",
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
  raw: "image",
  cr2: "image",
  nef: "image",
  orf: "image",
  arw: "image",
  dng: "image",
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  txt: "document",
  md: "document",
  odt: "document",
  rtf: "document",
  csv: "document",
  epub: "document",
  mobi: "document",
  azw: "document",
  azw3: "document",
  zip: "archive",
  tar: "archive",
  "tar.gz": "archive",
  "tar.bz2": "archive",
  "tar.xz": "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
  zst: "archive",
  lz4: "archive",
  cab: "archive",
  deb: "archive",
  rpm: "archive",
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
  db: "database",
  sqlite: "database",
  sqlitedb: "database",
  mdb: "database",
  accdb: "database",
  dbf: "database",
  qcow2: "vm-image",
  vmdk: "vm-image",
  vdi: "vm-image",
  vhd: "vm-image",
  vhdx: "vm-image",
  img: "vm-image",
  iso: "vm-image",
  wim: "vm-image",
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  host: z.string().default("").describe(
    "SSH target for the NAS, e.g. admin@diskstation or just diskstation",
  ),
  sshUser: z.string().default("").describe(
    "SSH user when host has no user@ prefix",
  ),
  identityFile: z.string().default("").describe(
    "SSH private key path (optional; key/agent auth only)",
  ),
  sshPort: z.number().int().min(1).max(65535).optional().describe(
    "SSH port (optional)",
  ),
  volumes: z.array(z.string()).default([]).describe(
    "Volume paths to scan; empty auto-detects /volume[0-9]*",
  ),
  categories: z.array(CategoryRuleSchema).default([]).describe(
    "Custom path category rules; empty uses the Synology defaults",
  ),
  excludePatterns: z.array(z.string()).default([]).describe(
    "Case-insensitive regexes for paths to skip (e.g. '/@eaDir/')",
  ),
  minNotableBytes: z.number().int().positive().default(1024 * 1024 * 1024)
    .describe("Minimum size for an item to be called notable (default 1 GiB)"),
  maxFiles: z.number().int().min(0).default(0).describe(
    "Stop after this many files; 0 scans everything",
  ),
  timeoutMs: z.number().int().min(0).default(0).describe(
    "SSH command timeout in milliseconds; 0 means no timeout",
  ),
  useSudo: z.boolean().default(false).describe(
    "Run remote scan commands through sudo -n (needed for root-only @docker/@appstore on many NAS setups)",
  ),
  oneFilesystem: z.boolean().default(false).describe(
    "Stay on the volume's root filesystem; false (default) crosses Synology shared-folder subvolumes and mounts",
  ),
  treeDepth: z.number().int().min(1).max(8).default(3).describe(
    "Directory depth for the fast du-based tree scan (default 3)",
  ),
}).strict();

/** Resolved global arguments for the model. */
export interface GlobalArgs {
  /** SSH target, e.g. `admin@diskstation`. */
  host: string;
  /** SSH user when `host` has no `user@` prefix. */
  sshUser: string;
  /** SSH identity file (optional). */
  identityFile: string;
  /** SSH port (optional). */
  sshPort?: number;
  /** Volume paths, empty for auto-detection. */
  volumes: string[];
  /** Active path category rules. */
  categories: CategoryRule[];
  /** Paths to exclude. */
  excludePatterns: string[];
  /** Notable-size threshold. */
  minNotableBytes: number;
  /** File cap, 0 for unlimited. */
  maxFiles: number;
  /** Command timeout, 0 for none. */
  timeoutMs: number;
  /** Whether to run remote scan commands through `sudo -n`. */
  useSudo: boolean;
  /** Whether to stay on the volume's root filesystem. */
  oneFilesystem: boolean;
  /** Directory depth for the fast tree scan. */
  treeDepth: number;
}

const SetupArgsSchema = z.object({
  host: z.string().default("").describe("Override the SSH target"),
  sshUser: z.string().default("").describe("Override the SSH user"),
  identityFile: z.string().default("").describe("Override the SSH key path"),
  sshPort: z.number().int().min(1).max(65535).optional().describe(
    "Override the SSH port",
  ),
  volumes: z.array(z.string()).default([]).describe(
    "Override the volume paths; empty keeps the existing/auto-detected set",
  ),
});

type SetupArgs = z.infer<typeof SetupArgsSchema>;

const DiscoverArgsSchema = z.object({
  host: z.string().default("").describe("Override the SSH target for this run"),
  sshUser: z.string().default("").describe("Override the SSH user"),
  volumes: z.array(z.string()).default([]).describe(
    "Override the volume paths for this run",
  ),
});

type DiscoverArgs = z.infer<typeof DiscoverArgsSchema>;

const AuditArgsSchema = z.object({
  host: z.string().default("").describe("Override the SSH target for this run"),
  sshUser: z.string().default("").describe("Override the SSH user"),
  volumes: z.array(z.string()).default([]).describe(
    "Override the volume paths for this run",
  ),
  mode: z.enum(["tree", "files", "shares"]).default("tree").describe(
    "tree uses du -d<treeDepth> for a fast lay-of-the-land; files streams every file for exact content categories; shares uses du per share",
  ),
  treeDepth: z.number().int().min(1).max(8).optional().describe(
    "Override the du tree depth for this call (default 3)",
  ),
  useSudo: z.boolean().optional().describe(
    "Run remote find/du through sudo -n for this call (NOPASSWD required)",
  ),
  oneFilesystem: z.boolean().optional().describe(
    "Limit the walk to the volume's root filesystem; false crosses shared-folder subvolumes",
  ),
  categories: z.array(CategoryRuleSchema).optional().describe(
    "Override the path category rules for this call",
  ),
  excludePatterns: z.array(z.string()).optional().describe(
    "Override the path exclusion regexes for this call",
  ),
  minNotableBytes: z.number().int().positive().optional().describe(
    "Override the notable-size threshold for this call",
  ),
  maxFiles: z.number().int().min(0).optional().describe(
    "Override the file cap for this call; 0 means unlimited",
  ),
  timeoutMs: z.number().int().min(0).optional().describe(
    "Override the command timeout for this call; 0 means none",
  ),
});

type AuditArgs = z.infer<typeof AuditArgsSchema>;

const DiscoveryShareSchema = z.object({
  path: z.string(),
  name: z.string(),
});

const VolumeSchema = z.object({
  path: z.string(),
  filesystem: z.string(),
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  availableBytes: z.number().nonnegative(),
  usedFraction: z.number().nonnegative(),
  shares: z.array(DiscoveryShareSchema),
});

const DiscoveryOutputSchema = z.object({
  host: z.string(),
  systemModel: z.string(),
  dsmVersion: z.string(),
  scannedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  volumes: z.array(VolumeSchema),
});

const ShareSchema = z.object({
  volume: z.string(),
  path: z.string(),
  name: z.string(),
  category: z.string(),
  bytes: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
});

const NotableFileSchema = z.object({
  path: z.string(),
  bytes: z.number().nonnegative(),
  category: z.string(),
});

const NotableDirSchema = z.object({
  path: z.string(),
  bytes: z.number().nonnegative(),
  category: z.string(),
});

const CategoryRollupSchema = z.object({
  category: z.string(),
  label: z.string(),
  totalBytes: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  fraction: z.number().nonnegative(),
  samplePaths: z.array(z.string()),
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

const AuditOutputSchema = z.object({
  host: z.string(),
  scannedAt: z.iso.datetime(),
  mode: z.enum(["tree", "files", "shares"]),
  useSudo: z.boolean(),
  oneFilesystem: z.boolean(),
  totalBytes: z.number().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  totalDirs: z.number().int().nonnegative(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  unaccountedBytes: z.number().nonnegative(),
  coverageFraction: z.number().nonnegative(),
  volumes: z.array(VolumeSchema),
  categories: z.array(CategoryRollupSchema),
  shares: z.array(ShareSchema),
  unscannedShares: z.array(DiscoveryShareSchema),
  notableDirs: z.array(NotableDirSchema),
  notableFiles: z.array(NotableFileSchema),
  findings: z.array(FindingSchema),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
});

const ConfigSchema = z.object({
  host: z.string(),
  sshUser: z.string(),
  identityFile: z.string(),
  sshPort: z.number().int().min(1).max(65535).nullable(),
  volumes: z.array(z.string()),
  reachable: z.boolean(),
  verifiedAt: z.string(),
  error: z.string(),
  systemModel: z.string(),
  dsmVersion: z.string(),
});

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A top-level share discovered on a volume. */
export interface DiscoveryShare {
  /** Absolute path, e.g. `/volume1/homes`. */
  path: string;
  /** Last path component, e.g. `homes`. */
  name: string;
}

/** A Synology volume and its capacity. */
export interface VolumeInfo {
  /** Volume path, e.g. `/volume1`. */
  path: string;
  /** Backing filesystem from `df`, e.g. `/dev/mapper/vg1-volume_1`. */
  filesystem: string;
  /** Total capacity in bytes. */
  totalBytes: number;
  /** Used bytes. */
  usedBytes: number;
  /** Available bytes. */
  availableBytes: number;
  /** `usedBytes / totalBytes`, or 0 when capacity is unknown. */
  usedFraction: number;
  /** Top-level entries on the volume. */
  shares: DiscoveryShare[];
}

/** Result of the `discover` method. */
export interface DiscoveryOutput {
  /** SSH target used for the scan. */
  host: string;
  /** Synology model name, e.g. `DS920+`, when readable. */
  systemModel: string;
  /** DSM version string, e.g. `7.2.2-72806`. */
  dsmVersion: string;
  /** ISO-8601 timestamp. */
  scannedAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Volumes and their capacities. */
  volumes: VolumeInfo[];
}

/** A classified top-level share and its size. */
export interface ShareInfo {
  /** Volume the share lives on. */
  volume: string;
  /** Absolute share path. */
  path: string;
  /** Last path component. */
  name: string;
  /** Category id from the rules/defaults. */
  category: string;
  /** Bytes in the share. */
  bytes: number;
  /** Files counted in the share (0 in `shares` mode). */
  fileCount: number;
}

/** A large file worth calling out. */
export interface NotableFile {
  /** Absolute remote path. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** Category id. */
  category: string;
}

/** A large directory worth calling out (tree mode). */
export interface NotableDir {
  /** Absolute remote path. */
  path: string;
  /** Cumulative bytes under this directory. */
  bytes: number;
  /** Category id. */
  category: string;
}

/** Per-category rollup. */
export interface CategoryRollup {
  /** Category id. */
  category: string;
  /** Human-readable label. */
  label: string;
  /** Total bytes in this category. */
  totalBytes: number;
  /** Number of files (0 in `shares` mode). */
  fileCount: number;
  /** Fraction of the scanned total (0..1). */
  fraction: number;
  /** A few sample paths for context. */
  samplePaths: string[];
}

/** A semantic finding. */
export interface Finding {
  /** Finding kind (category, capacity, largest-share, largest-file, combined). */
  kind: string;
  /** Human-readable title. */
  title: string;
  /** Category id, when applicable. */
  category: string | null;
  /** Total bytes for this finding. */
  totalBytes: number;
  /** Number of items (files, shares, or 1 for a volume). */
  count: number;
  /** A few sample paths. */
  samplePaths: string[];
  /** Whether the finding deserves emphasis. */
  notable: boolean;
}

/** A per-path error recorded during the scan. */
export interface AuditError {
  /** Remote path. */
  path: string;
  /** Error message. */
  message: string;
}

/** Result of the `audit` method. */
export interface AuditOutput {
  /** SSH target used for the scan. */
  host: string;
  /** ISO-8601 timestamp. */
  scannedAt: string;
  /** Scan mode actually used. */
  mode: "tree" | "files" | "shares";
  /** Whether the scan ran through `sudo -n`. */
  useSudo: boolean;
  /** Whether the scan stayed on the volume's root filesystem. */
  oneFilesystem: boolean;
  /** Total bytes measured. */
  totalBytes: number;
  /** Total files measured (0 in `tree`/`shares` mode). */
  totalFiles: number;
  /** Directories measured (tree mode; 0 otherwise). */
  totalDirs: number;
  /** True when `maxFiles` stopped the walk early. */
  truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Total bytes used on the scanned volumes, from `df`. */
  usedBytes: number;
  /** `usedBytes - totalBytes` (floored at 0): space not explained by readable files. */
  unaccountedBytes: number;
  /** `totalBytes / usedBytes`, or 0 when capacity is unknown. */
  coverageFraction: number;
  /** Volume capacities from `df`. */
  volumes: VolumeInfo[];
  /** Per-category rollups, sorted by size. */
  categories: CategoryRollup[];
  /** Top-level shares with measured files, sorted by size. */
  shares: ShareInfo[];
  /** Discovered shares that produced no readable files. */
  unscannedShares: DiscoveryShare[];
  /** Largest directories (tree mode). */
  notableDirs: NotableDir[];
  /** Largest files (files mode). */
  notableFiles: NotableFile[];
  /** Grouped insights. */
  findings: Finding[];
  /** Per-path/parse errors (never aborts the whole audit). */
  errors: AuditError[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Return the lowercase extension of a path, handling compound `.tar.gz`. */
export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".tar.bz2")) return "tar.bz2";
  if (lower.endsWith(".tar.xz")) return "tar.xz";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

/** Classify a file by extension alone (the fallback after path rules). */
export function classifyByExtension(path: string): string {
  return EXT_CATEGORY[fileExtension(path)] ?? "other";
}

/** Compile category rules once so the regexes are not rebuilt per file. */
export function compileRules(rules: CategoryRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    id: rule.id,
    label: rule.label,
    regexes: rule.patterns.map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Invalid regex for category "${rule.id}": ${pattern} (${detail})`,
        );
      }
    }),
  }));
}

/** Classify a path with already-compiled rules, falling back to extension. */
export function classifyCompiled(path: string, rules: CompiledRule[]): string {
  for (const rule of rules) {
    for (const regex of rule.regexes) {
      if (regex.test(path)) return rule.id;
    }
  }
  return classifyByExtension(path);
}

/** Classify a path with raw rules (compiles them; convenient for tests). */
export function classifyPath(path: string, rules: CategoryRule[]): string {
  return classifyCompiled(path, compileRules(rules));
}

/** Label map for the active rules plus the content fallbacks. */
export function categoryLabels(
  rules: CategoryRule[],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const rule of rules) labels.set(rule.id, rule.label);
  for (const [id, label] of Object.entries(CONTENT_CATEGORY_LABELS)) {
    if (!labels.has(id)) labels.set(id, label);
  }
  return labels;
}

/** POSIX-shell single-quote a value. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Expand a leading `~` to the current HOME. */
export function expandHome(
  path: string,
  home = Deno.env.get("HOME") ?? "~",
): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** Extract the share a remote path belongs to. */
export function deriveShare(
  path: string,
  volumes: string[],
): { volume: string; path: string; name: string } {
  let best = "";
  for (const volume of volumes) {
    const prefix = volume.endsWith("/") ? volume : `${volume}/`;
    if (
      (path === volume || path.startsWith(prefix)) &&
      volume.length > best.length
    ) {
      best = volume;
    }
  }
  if (best) {
    const rest = path.slice(best.length).replace(/^\/+/, "");
    if (!rest) {
      const name = best.split("/").filter(Boolean).pop() ?? best;
      return { volume: best, path: best, name };
    }
    const name = rest.split("/")[0];
    return { volume: best, path: `${best}/${name}`, name };
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return {
      volume: "",
      path: `/${parts[0]}/${parts[1]}`,
      name: parts[1],
    };
  }
  return { volume: "", path, name: parts[parts.length - 1] ?? path };
}

// ---------------------------------------------------------------------------
// Remote command construction
// ---------------------------------------------------------------------------

/** Build the ssh argv for a resolved config and remote command. */
export function buildSshArgs(
  config: ResolvedConnection,
  command: string,
): string[] {
  const args: string[] = [];
  if (config.sshPort > 0) args.push("-p", String(config.sshPort));
  if (config.identityFile) {
    args.push("-i", expandHome(config.identityFile));
  }
  args.push(
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "LogLevel=ERROR",
  );
  const dest = config.host.includes("@")
    ? config.host
    : config.sshUser
    ? `${config.sshUser}@${config.host}`
    : config.host;
  args.push(dest, command);
  return args;
}

/** Prefix a simple remote scan command with `sudo -n` when enabled. */
export function withSudo(command: string, useSudo: boolean): string {
  if (!useSudo) return command;
  if (command.startsWith("LC_ALL=C ")) {
    return `LC_ALL=C sudo -n ${command.slice("LC_ALL=C ".length)}`;
  }
  return `sudo -n ${command}`;
}

/** Build the volume/share/capacity discovery script. */
export function buildDiscoverCommand(volumes: string[]): string {
  const volumeExpr = volumes.length > 0
    ? volumes.map(shellQuote).join(" ")
    : "/volume[0-9]*";
  return [
    "set -u",
    "LC_ALL=C",
    `printf 'MODEL\\t%s\\n' "$(sed -n 's/^upnpmodelname="\\(.*\\)"/\\1/p' /etc/synoinfo.conf 2>/dev/null | head -n 1)"`,
    `printf 'DSM\\t%s\\n' "$(grep -E '^(productversion|buildnumber)=' /etc.defaults/VERSION 2>/dev/null | tr '\\n' ' ')"`,
    `for v in ${volumeExpr}; do`,
    '  [ -d "$v" ] || continue',
    `  printf 'VOLUME\\t%s\\n' "$v"`,
    `  df -kP "$v" 2>/dev/null | awk 'NR==2 {printf "CAPACITY\\t%s\\t%s\\t%s\\t%s\\n", $1, $2, $3, $4}'`,
    `  find "$v" -mindepth 1 -maxdepth 1 -print 2>/dev/null | while IFS= read -r p; do printf 'SHARE\\t%s\\n' "$p"; done`,
    "done",
  ].join("\n");
}

/** Probe whether the remote `find` supports `-printf`. */
export function buildScanModeProbeCommand(): string {
  return "if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then printf 'printf\\n'; else printf 'du\\n'; fi";
}

/** Build the NUL-delimited full-file walk command. */
export function buildFindCommand(
  volumes: string[],
  oneFilesystem = false,
): string {
  const paths = volumes.map(shellQuote).join(" ");
  const options = oneFilesystem ? "-xdev -type f" : "-type f";
  return `LC_ALL=C find ${paths} ${options} -printf '%s\\t%p\\0'`;
}

/** Build the fast, top-level-share `du` command (sizes in KiB). */
export function buildDuCommand(volumes: string[]): string {
  const args = volumes.map((volume) =>
    `${shellQuote(volume)}/* ${shellQuote(volume)}/.[!.]*`
  ).join(" ");
  return `LC_ALL=C du -sk ${args}`;
}

/** Build a `du -sk` command over explicit share paths (no shell globs). */
export function buildDuPathsCommand(paths: string[]): string {
  return `LC_ALL=C du -sk ${paths.map(shellQuote).join(" ")}`;
}

/** Build the fast directory tree command (`du -d<depth>`, KiB output). */
export function buildTreeCommand(
  volumes: string[],
  depth: number,
  oneFilesystem = false,
): string {
  const paths = volumes.map(shellQuote).join(" ");
  const cross = oneFilesystem ? "-x " : "";
  return `LC_ALL=C du -k ${cross}-d ${depth} ${paths}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse one `du -sk` line (`<KiB>\t<path>`) into bytes and path. */
export function parseDuLine(
  line: string,
): { bytes: number; path: string } | null {
  if (!line.trim()) return null;
  const tab = line.indexOf("\t");
  if (tab > 0) {
    const kib = Number(line.slice(0, tab).trim());
    if (Number.isFinite(kib)) {
      return { bytes: kib * 1024, path: line.slice(tab + 1) };
    }
  }
  const match = /^(\d+)\s+(.*)$/.exec(line);
  if (!match) return null;
  return { bytes: Number(match[1]) * 1024, path: match[2] };
}

/** Parse one NUL-delimited `find -printf '%s\t%p'` record. */
export function parseFileRecord(
  record: string,
): { bytes: number; path: string } | null {
  const tab = record.indexOf("\t");
  if (tab <= 0) return null;
  const bytes = Number(record.slice(0, tab));
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return { bytes, path: record.slice(tab + 1) };
}

/** Turn the raw `DSM` line into `7.2.2-72806`. */
export function parseDsmVersion(raw: string): string {
  const product = /productversion="([^"]+)"/.exec(raw)?.[1] ?? "";
  const build = /buildnumber="([^"]+)"/.exec(raw)?.[1] ?? "";
  if (product && build) return `${product}-${build}`;
  return product || raw.trim();
}

/**
 * Summarize remote stderr without dumping thousands of permission errors.
 *
 * Returns a short, actionable message: a count plus the first permission-denied
 * path when present, otherwise the first few lines.
 */
export function summarizeStderr(stderr: string, maxLines = 3): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const permission = lines.filter((line) => /permission denied/i.test(line));
  if (permission.length > 0) {
    return `${permission.length} permission-denied path(s); first: ${
      permission[0].slice(0, 240)
    }`;
  }
  return lines.slice(0, maxLines).join("; ").slice(0, 500);
}

/** Parse the tab-separated output of the discovery script. */
export function parseDiscoveryOutput(text: string): DiscoveryOutput {
  const volumes: VolumeInfo[] = [];
  let current: VolumeInfo | null = null;
  let systemModel = "";
  let dsmRaw = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    const parts = line.split("\t");
    const kind = parts[0];
    if (kind === "MODEL") {
      systemModel = parts.slice(1).join("\t").trim();
    } else if (kind === "DSM") {
      dsmRaw = parts.slice(1).join("\t");
    } else if (kind === "VOLUME") {
      const path = parts.slice(1).join("\t");
      current = {
        path,
        filesystem: "",
        totalBytes: 0,
        usedBytes: 0,
        availableBytes: 0,
        usedFraction: 0,
        shares: [],
      };
      volumes.push(current);
    } else if (kind === "CAPACITY" && current) {
      current.filesystem = parts[1] ?? "";
      const totalKib = Number(parts[2] ?? 0);
      const usedKib = Number(parts[3] ?? 0);
      const availableKib = Number(parts[4] ?? 0);
      current.totalBytes = Number.isFinite(totalKib) ? totalKib * 1024 : 0;
      current.usedBytes = Number.isFinite(usedKib) ? usedKib * 1024 : 0;
      current.availableBytes = Number.isFinite(availableKib)
        ? availableKib * 1024
        : 0;
      current.usedFraction = current.totalBytes > 0
        ? current.usedBytes / current.totalBytes
        : 0;
    } else if (kind === "SHARE" && current) {
      const path = parts.slice(1).join("\t");
      const name = path.split("/").filter(Boolean).pop() ?? path;
      current.shares.push({ path, name });
    }
  }
  return {
    host: "",
    systemModel,
    dsmVersion: parseDsmVersion(dsmRaw),
    scannedAt: new Date().toISOString(),
    durationMs: 0,
    volumes,
  };
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/** Connection settings resolved from global args, saved config, and overrides. */
export interface ResolvedConnection {
  /** SSH target, e.g. `admin@nas.local`. */
  host: string;
  /** SSH user when `host` has no `user@` prefix. */
  sshUser: string;
  /** SSH identity file (optional). */
  identityFile: string;
  /** SSH port, 0 for the default. */
  sshPort: number;
}

/** Full configuration for a scan. */
export interface ResolvedConfig extends ResolvedConnection {
  /** Volume paths, empty for auto-detection. */
  volumes: string[];
  /** Active path category rules. */
  categories: CategoryRule[];
  /** Paths to exclude. */
  excludePatterns: string[];
  /** Notable-size threshold. */
  minNotableBytes: number;
  /** File cap, 0 for unlimited. */
  maxFiles: number;
  /** Command timeout, 0 for none. */
  timeoutMs: number;
  /** Whether to run remote scan commands through `sudo -n`. */
  useSudo: boolean;
  /** Whether to stay on the volume's root filesystem. */
  oneFilesystem: boolean;
  /** Directory depth for the fast tree scan. */
  treeDepth: number;
}

/** Merge global args, persisted setup config, and per-run overrides. */
export function resolveConfig(
  globalArgs: GlobalArgs,
  stored: Partial<ResolvedConfig> | null,
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  const categories = overrides.categories?.length
    ? overrides.categories
    : globalArgs.categories.length > 0
    ? globalArgs.categories
    : DEFAULT_CATEGORY_RULES;
  const storedVolumes = Array.isArray(stored?.volumes) ? stored.volumes : [];
  return {
    host: overrides.host || globalArgs.host || stored?.host || "",
    sshUser: overrides.sshUser || globalArgs.sshUser || stored?.sshUser || "",
    identityFile: overrides.identityFile || globalArgs.identityFile ||
      stored?.identityFile || "",
    sshPort: overrides.sshPort ?? globalArgs.sshPort ?? stored?.sshPort ?? 0,
    volumes: overrides.volumes?.length
      ? overrides.volumes
      : globalArgs.volumes.length
      ? globalArgs.volumes
      : storedVolumes,
    categories,
    excludePatterns: overrides.excludePatterns ?? globalArgs.excludePatterns,
    minNotableBytes: overrides.minNotableBytes ?? globalArgs.minNotableBytes,
    maxFiles: overrides.maxFiles ?? globalArgs.maxFiles,
    timeoutMs: overrides.timeoutMs ?? globalArgs.timeoutMs,
    useSudo: overrides.useSudo ?? globalArgs.useSudo,
    oneFilesystem: overrides.oneFilesystem ?? globalArgs.oneFilesystem,
    treeDepth: overrides.treeDepth ?? globalArgs.treeDepth,
  };
}

/** Validate that a usable SSH target is configured. */
function requireHost(config: ResolvedConfig): void {
  if (!config.host.trim()) {
    throw new Error(
      "No SSH host configured. Run setup first, for example:\n" +
        "  swamp model method run @svendowideit/synology-disk-usage setup nas " +
        "--input host=admin@diskstation\n" +
        "or create the model with --global-arg host=admin@diskstation",
    );
  }
}

// ---------------------------------------------------------------------------
// SSH IO
// ---------------------------------------------------------------------------

/** Options for streaming a remote record stream. */
interface StreamOptions {
  /** Record delimiter (`\0` for find, `\n` for du). */
  delimiter: string;
  /** Called for each non-empty record. */
  onRecord: (record: string) => void;
  /** Stop after this many records; 0 means unlimited. */
  maxFiles: number;
  /** Command timeout in milliseconds; 0 means none. */
  timeoutMs: number;
}

/** Result of a streamed SSH command. */
interface StreamResult {
  /** Exit code (or -1 when killed). */
  code: number;
  /** Captured stderr. */
  stderr: string;
  /** True when `maxFiles` stopped the stream. */
  truncated: boolean;
  /** True when the timeout fired. */
  timedOut: boolean;
  /** Number of records consumed. */
  count: number;
}

/**
 * Spawn the single ssh subprocess used by both IO helpers.
 *
 * This is the extension's only subprocess seam. Arguments are built by
 * `buildSshArgs` from the strict schema; volume paths are shell-quoted and only
 * read-only find/du/df commands are run.
 */
function spawnSsh(
  config: ResolvedConnection,
  command: string,
): Deno.ChildProcess {
  return new Deno.Command("ssh", { // swamp-quality-ignore deno-command: SSH is the transport for this extension; arguments are built from the strict schema and shell-quoted, BatchMode disables prompts, and only read-only find/du/df commands run.
    args: buildSshArgs(config, command),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

/** Run a remote command, capturing stdout and stderr. */
async function runSsh(
  config: ResolvedConnection,
  command: string,
  timeoutMs: number,
): Promise<
  { code: number; stdout: string; stderr: string; timedOut: boolean }
> {
  let child: Deno.ChildProcess;
  try {
    child = spawnSsh(config, command);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to start ssh (is an OpenSSH client installed?): ${detail}`,
    );
  }

  const stderrPromise = new Response(child.stderr).text();
  const stdoutPromise = new Response(child.stdout).text();
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }, timeoutMs)
    : undefined;

  try {
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      stdoutPromise,
      stderrPromise,
    ]);
    return { code: status.code, stdout, stderr, timedOut };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the exact remediation text for a non-interactive sudo failure.
 *
 * The caller supplies the remote user and the resolved `find`/`du` binary
 * paths, so the sudoers line is copy-pasteable rather than generic.
 */
export function formatSudoRemediation(
  host: string,
  user: string,
  findPath: string,
  duPath: string,
): string {
  const line = `${user} ALL=(ALL) NOPASSWD: ${findPath}, ${duPath}`;
  const file = "/etc/sudoers.d/swamp-synology-disk-usage";
  const add = `echo ${shellQuote(line)} | sudo tee ${file}`;
  const chmod = `sudo chmod 0440 ${file}`;
  const verify =
    `sudo -n ${findPath} /dev/null -print >/dev/null && sudo -n ${duPath} -sk /dev/null >/dev/null && echo sudo-ok`;
  const install = `${add} && ${chmod} && ${verify}`;
  return [
    `sudo needs a password on ${host}, so the non-interactive scan cannot read root-only shares.`,
    "",
    "Add this exact line to the NAS sudoers:",
    `  ${line}`,
    "",
    "Synology has no visudo, so install and verify it with these commands on the NAS (or via ssh -t so sudo can prompt):",
    `  ${add}`,
    `  ${chmod}`,
    `  ${verify}`,
    "",
    "Or run that in one step from this machine:",
    `  ssh -t ${host} ${shellQuote(install)}`,
    "",
    `If verification fails, remove ${file} (as root or via DSM), then use a root SSH target or grant the SSH user read access to the shares.`,
  ].join("\n");
}

/** Discover the exact remote user/find/du paths and build the sudo fix. */
async function buildSudoRemediation(config: ResolvedConfig): Promise<string> {
  let user = config.host.includes("@")
    ? config.host.split("@")[0]
    : config.sshUser;
  let findPath = "/usr/bin/find";
  let duPath = "/usr/bin/du";
  try {
    const diagnostic = await runSsh(
      config,
      "id -un; command -v find 2>/dev/null || echo /usr/bin/find; command -v du 2>/dev/null || echo /usr/bin/du",
      config.timeoutMs,
    );
    if (diagnostic.code === 0) {
      const lines = diagnostic.stdout.split("\n");
      if (lines[0]?.trim()) user = lines[0].trim();
      if (lines[1]?.trim()) findPath = lines[1].trim();
      if (lines[2]?.trim()) duPath = lines[2].trim();
    }
  } catch {
    // A diagnostic failure should not hide the sudo remediation.
  }
  return formatSudoRemediation(
    config.host,
    user || "your-ssh-user",
    findPath,
    duPath,
  );
}

/** Stream a remote command's stdout, splitting it into records. */
async function streamSsh(
  config: ResolvedConnection,
  command: string,
  options: StreamOptions,
): Promise<StreamResult> {
  let child: Deno.ChildProcess;
  try {
    child = spawnSsh(config, command);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to start ssh (is an OpenSSH client installed?): ${detail}`,
    );
  }

  const stderrPromise = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  let truncated = false;
  let timedOut = false;
  const timer = options.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }, options.timeoutMs)
    : undefined;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf(options.delimiter);
      while (index >= 0) {
        const record = buffer.slice(0, index);
        buffer = buffer.slice(index + options.delimiter.length);
        if (record.length > 0) {
          options.onRecord(record);
          count++;
          if (options.maxFiles > 0 && count >= options.maxFiles) {
            truncated = true;
            try {
              child.kill("SIGTERM");
            } catch {
              // already exited
            }
            break;
          }
        }
        index = buffer.indexOf(options.delimiter);
      }
      if (truncated) break;
    }
    if (!truncated) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        options.onRecord(buffer);
        count++;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }

  const [status, stderr] = await Promise.all([child.status, stderrPromise]);
  if (timer !== undefined) clearTimeout(timer);
  return { code: status.code, stderr, truncated, timedOut, count };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Run the discovery script and parse its output. */
async function runDiscovery(
  config: ResolvedConfig,
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void },
): Promise<DiscoveryOutput> {
  requireHost(config);
  const started = Date.now();
  const result = await runSsh(
    config,
    buildDiscoverCommand(config.volumes),
    config.timeoutMs,
  );
  if (result.timedOut) {
    throw new Error(
      `SSH discovery timed out after ${config.timeoutMs}ms connecting to ${config.host}`,
    );
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `ssh exited ${result.code}`;
    throw new Error(
      `SSH discovery failed for ${config.host}: ${detail}. ` +
        "Check that key/agent auth works, e.g. ssh -o BatchMode=yes " +
        `${config.host} true`,
    );
  }
  const discovery = parseDiscoveryOutput(result.stdout);
  discovery.host = config.host;
  discovery.durationMs = Date.now() - started;
  if (discovery.volumes.length === 0) {
    throw new Error(
      `No Synology volumes found on ${config.host}. ` +
        "Pass --input 'volumes:json=[\"/volume1\"]' if they live elsewhere.",
    );
  }
  logger?.info(
    "Discovered {volumes} volume(s), {shares} top-level share(s) on {host}",
    {
      volumes: discovery.volumes.length,
      shares: discovery.volumes.reduce((n, v) => n + v.shares.length, 0),
      host: config.host,
    },
  );
  return discovery;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Create empty aggregation state for one scan. */
function newAggregation() {
  return {
    bytes: 0,
    files: 0,
    dirs: 0,
    categories: new Map<
      string,
      { bytes: number; files: number; samples: string[] }
    >(),
    shares: new Map<string, ShareInfo>(),
    notable: [] as NotableFile[],
    notableDirs: [] as NotableDir[],
    errors: [] as AuditError[],
  };
}

type Aggregation = ReturnType<typeof newAggregation>;

/** Add one measured file to the aggregation. */
function addFile(
  state: Aggregation,
  file: { bytes: number; path: string },
  context: {
    compiledRules: CompiledRule[];
    volumes: string[];
    minNotableBytes: number;
  },
): void {
  const category = classifyCompiled(file.path, context.compiledRules);
  state.bytes += file.bytes;
  state.files += 1;

  const cat = state.categories.get(category) ??
    { bytes: 0, files: 0, samples: [] };
  cat.bytes += file.bytes;
  cat.files += 1;
  if (cat.samples.length < 3) cat.samples.push(file.path);
  state.categories.set(category, cat);

  const share = deriveShare(file.path, context.volumes);
  const existing = state.shares.get(share.path) ?? {
    volume: share.volume,
    path: share.path,
    name: share.name,
    category: classifyCompiled(`${share.path}/`, context.compiledRules),
    bytes: 0,
    fileCount: 0,
  };
  existing.bytes += file.bytes;
  existing.fileCount += 1;
  state.shares.set(share.path, existing);

  if (file.bytes >= context.minNotableBytes) {
    state.notable.push({
      path: file.path,
      bytes: file.bytes,
      category,
    });
    state.notable.sort((a, b) => b.bytes - a.bytes);
    if (state.notable.length > 20) state.notable.length = 20;
  }
}

/** One directory in the `du` tree: cumulative and direct (own) bytes. */
export interface DirNode {
  /** Absolute remote path. */
  path: string;
  /** Cumulative bytes under this directory. */
  bytes: number;
  /** Bytes directly in this directory (cumulative minus children). */
  ownBytes: number;
}

/**
 * Turn `du -k -d<N>` records into nodes with disjoint `ownBytes`.
 *
 * `du` reports cumulative sizes, so summing every line would double-count
 * children. Subtracting each child's cumulative size from its parent leaves the
 * bytes directly in each directory; the sum of `ownBytes` is the true total.
 */
export function buildDirNodes(
  records: { bytes: number; path: string }[],
): DirNode[] {
  const nodes = new Map<string, DirNode>();
  for (const record of records) {
    if (!nodes.has(record.path)) {
      nodes.set(record.path, {
        path: record.path,
        bytes: record.bytes,
        ownBytes: record.bytes,
      });
    }
  }
  for (const node of nodes.values()) {
    const trimmed = node.path.replace(/\/+$/, "");
    const slash = trimmed.lastIndexOf("/");
    if (slash <= 0) continue;
    const parent = nodes.get(trimmed.slice(0, slash));
    if (parent) parent.ownBytes -= node.bytes;
  }
  for (const node of nodes.values()) {
    if (node.ownBytes < 0) node.ownBytes = 0;
  }
  return [...nodes.values()];
}

/** Add one directory's own bytes to the aggregation (tree mode). */
function addDir(
  state: Aggregation,
  node: DirNode,
  context: {
    compiledRules: CompiledRule[];
    volumes: string[];
    minNotableBytes: number;
  },
): void {
  const category = classifyCompiled(`${node.path}/`, context.compiledRules);
  state.bytes += node.ownBytes;
  state.dirs += 1;

  if (node.ownBytes > 0) {
    const cat = state.categories.get(category) ??
      { bytes: 0, files: 0, samples: [] };
    cat.bytes += node.ownBytes;
    if (cat.samples.length < 3) cat.samples.push(node.path);
    state.categories.set(category, cat);

    const share = deriveShare(node.path, context.volumes);
    const existing = state.shares.get(share.path) ?? {
      volume: share.volume,
      path: share.path,
      name: share.name,
      category: classifyCompiled(`${share.path}/`, context.compiledRules),
      bytes: 0,
      fileCount: 0,
    };
    existing.bytes += node.ownBytes;
    state.shares.set(share.path, existing);
  }

  if (
    node.bytes >= context.minNotableBytes &&
    !context.volumes.includes(node.path)
  ) {
    state.notableDirs.push({
      path: node.path,
      bytes: node.bytes,
      category,
    });
    state.notableDirs.sort((a, b) => b.bytes - a.bytes);
    if (state.notableDirs.length > 20) state.notableDirs.length = 20;
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Build per-category, capacity, and largest-item findings. */
export function buildFindings(
  categories: CategoryRollup[],
  volumes: VolumeInfo[],
  shares: ShareInfo[],
  notableDirs: NotableDir[],
  notableFiles: NotableFile[],
  totalBytes: number,
  minNotableBytes: number,
  options: { useSudo: boolean; oneFilesystem: boolean } = {
    useSudo: false,
    oneFilesystem: false,
  },
): Finding[] {
  const findings: Finding[] = [];
  const fraction = (bytes: number) => totalBytes > 0 ? bytes / totalBytes : 0;

  for (const category of categories) {
    const pct = category.fraction;
    if (category.totalBytes < minNotableBytes && pct < 0.02) continue;
    findings.push({
      kind: "category",
      title: `${category.label}: ${humanSize(category.totalBytes)} (${
        (pct * 100).toFixed(0)
      }%)`,
      category: category.category,
      totalBytes: category.totalBytes,
      count: category.fileCount,
      samplePaths: category.samplePaths,
      notable: pct >= 0.05,
    });
  }

  const googleDrive = categories.find((c) => c.category === "google-drive");
  const googlePhotos = categories.find((c) => c.category === "google-photos");
  if (googleDrive || googlePhotos) {
    const total = (googleDrive?.totalBytes ?? 0) +
      (googlePhotos?.totalBytes ?? 0);
    const samples = [
      ...(googleDrive?.samplePaths ?? []),
      ...(googlePhotos?.samplePaths ?? []),
    ].slice(0, 3);
    findings.push({
      kind: "google-backups",
      title: `Google Drive + Photos backups: ${humanSize(total)}`,
      category: null,
      totalBytes: total,
      count: (googleDrive?.fileCount ?? 0) + (googlePhotos?.fileCount ?? 0),
      samplePaths: samples,
      notable: fraction(total) >= 0.05,
    });
  }

  for (const volume of volumes) {
    if (volume.totalBytes <= 0 || volume.usedFraction < 0.8) continue;
    findings.push({
      kind: "volume-capacity",
      title: `${volume.path} is ${
        (volume.usedFraction * 100).toFixed(0)
      }% full — ${humanSize(volume.usedBytes)} used, ${
        humanSize(volume.availableBytes)
      } free`,
      category: null,
      totalBytes: volume.usedBytes,
      count: 1,
      samplePaths: [volume.path],
      notable: volume.usedFraction >= 0.9,
    });
  }

  const usedBytes = volumes.reduce((sum, volume) => sum + volume.usedBytes, 0);
  const unaccounted = Math.max(0, usedBytes - totalBytes);
  const coverage = usedBytes > 0 ? totalBytes / usedBytes : 0;
  const unaccountedThreshold = Math.min(
    minNotableBytes,
    1024 * 1024 * 1024,
  );
  if (
    usedBytes > 0 && coverage < 0.95 && unaccounted >= unaccountedThreshold
  ) {
    const hint = options.oneFilesystem
      ? "re-run with oneFilesystem=false to include shared-folder subvolumes"
      : options.useSudo
      ? "the remainder may be Btrfs snapshots, iSCSI LUNs, or system data"
      : "re-run with useSudo=true or as root if shares are permission-protected";
    findings.push({
      kind: "scan-coverage",
      title: `Only ${humanSize(totalBytes)} of ${
        humanSize(usedBytes)
      } used is readable (${(coverage * 100).toFixed(1)}%); ${
        humanSize(unaccounted)
      } unaccounted — ${hint}`,
      category: null,
      totalBytes: unaccounted,
      count: volumes.filter((volume) => volume.usedBytes > 0).length,
      samplePaths: volumes.map((volume) => volume.path),
      notable: true,
    });
  }

  const largestShare = [...shares].sort((a, b) => b.bytes - a.bytes)[0];
  if (largestShare && largestShare.bytes >= minNotableBytes) {
    findings.push({
      kind: "largest-share",
      title: `Largest share: ${largestShare.path} — ${
        humanSize(largestShare.bytes)
      }`,
      category: largestShare.category,
      totalBytes: largestShare.bytes,
      count: 1,
      samplePaths: [largestShare.path],
      notable: false,
    });
  }

  const largestDir = notableDirs[0];
  if (largestDir && largestDir.bytes >= minNotableBytes) {
    findings.push({
      kind: "largest-dir",
      title: `Largest directory: ${largestDir.path} — ${
        humanSize(largestDir.bytes)
      }`,
      category: largestDir.category,
      totalBytes: largestDir.bytes,
      count: 1,
      samplePaths: [largestDir.path],
      notable: false,
    });
  }

  const largestFile = notableFiles[0];
  if (largestFile && largestFile.bytes >= minNotableBytes) {
    findings.push({
      kind: "largest-file",
      title: `Largest file: ${largestFile.path} — ${
        humanSize(largestFile.bytes)
      }`,
      category: largestFile.category,
      totalBytes: largestFile.bytes,
      count: 1,
      samplePaths: [largestFile.path],
      notable: false,
    });
  }

  return findings.sort((a, b) => {
    if (a.notable !== b.notable) return a.notable ? -1 : 1;
    return b.totalBytes - a.totalBytes;
  });
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Caller-provided context surface used by the model methods. */
interface ModelContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
  };
  readResource?: (name: string) => Promise<unknown>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Read the persisted setup config, if any. */
async function readStoredConfig(
  context: ModelContext,
): Promise<Partial<ResolvedConfig> | null> {
  if (!context.readResource) return null;
  try {
    const raw = await context.readResource("config");
    return (raw ?? null) as Partial<ResolvedConfig> | null;
  } catch {
    return null;
  }
}

/** The swamp model definition for `@svendowideit/synology-disk-usage`. */
export const model = {
  type: "@svendowideit/synology-disk-usage",
  version: "2026.10.25.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.25.1",
      description:
        "Initial release: SSH into a Synology NAS, auto-discover volumes and shares, classify disk usage into Synology-aware categories (Docker, app data, Google Drive/Photos, backups, recycle bins, users, media), and report the breakdown.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    config: {
      description: "Persisted SSH connection and volume configuration",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    discovery: {
      description: "Volumes, capacities, and top-level shares on the NAS",
      schema: DiscoveryOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    audit: {
      description: "Categorized disk usage for the NAS",
      schema: AuditOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    setup: {
      description:
        "Persist SSH settings, verify the connection, and discover volumes",
      arguments: SetupArgsSchema,
      execute: async (
        args: SetupArgs,
        context: ModelContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const stored = await readStoredConfig(context);
        const config = resolveConfig(context.globalArgs, stored, {
          host: args.host,
          sshUser: args.sshUser,
          identityFile: args.identityFile,
          sshPort: args.sshPort,
          volumes: args.volumes,
        });

        context.logger?.info(
          config.host
            ? "Verifying SSH setup for {host}"
            : "Setup started without an SSH host — supply host to enable the NAS methods",
          { host: config.host || "(none)" },
        );

        let reachable = false;
        let error = "";
        let discovery: DiscoveryOutput | null = null;
        if (config.host) {
          try {
            discovery = await runDiscovery(config, context.logger);
            reachable = true;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
        }

        const handle = await context.writeResource("config", "config", {
          host: config.host,
          sshUser: config.sshUser,
          identityFile: config.identityFile,
          sshPort: config.sshPort > 0 ? config.sshPort : null,
          volumes: config.volumes.length > 0
            ? config.volumes
            : discovery?.volumes.map((v) => v.path) ?? [],
          reachable,
          verifiedAt: new Date().toISOString(),
          error,
          systemModel: discovery?.systemModel ?? "",
          dsmVersion: discovery?.dsmVersion ?? "",
        });

        if (!config.host) {
          context.logger?.info(
            "No SSH host configured yet. Run setup with --input host=admin@diskstation (key/agent auth).",
          );
          return { dataHandles: [handle] };
        }
        if (!reachable) {
          throw new Error(`SSH setup check failed: ${error}`);
        }
        context.logger?.info(
          "SSH connection verified to {host} ({model}, DSM {dsm}); volumes: {volumes}",
          {
            host: config.host,
            model: discovery?.systemModel || "unknown model",
            dsm: discovery?.dsmVersion || "unknown",
            volumes: discovery?.volumes.map((v) => v.path).join(", ") ?? "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    discover: {
      description:
        "List volumes, capacities, and top-level shares without a full scan",
      arguments: DiscoverArgsSchema,
      execute: async (
        args: DiscoverArgs,
        context: ModelContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const stored = await readStoredConfig(context);
        const config = resolveConfig(context.globalArgs, stored, {
          host: args.host,
          sshUser: args.sshUser,
          volumes: args.volumes,
        });
        context.logger?.info("Discovering volumes and shares on {host}", {
          host: config.host || "(none)",
        });
        const discovery = await runDiscovery(config, context.logger);
        const handle = await context.writeResource(
          "discovery",
          "discovery",
          discovery as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    audit: {
      description:
        "Walk the NAS and report disk usage by Synology-aware category",
      arguments: AuditArgsSchema,
      execute: async (
        args: AuditArgs,
        context: ModelContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const started = Date.now();
        const stored = await readStoredConfig(context);
        const config = resolveConfig(context.globalArgs, stored, {
          host: args.host,
          sshUser: args.sshUser,
          volumes: args.volumes,
          useSudo: args.useSudo,
          oneFilesystem: args.oneFilesystem,
          treeDepth: args.treeDepth,
          categories: args.categories,
          excludePatterns: args.excludePatterns,
          minNotableBytes: args.minNotableBytes,
          maxFiles: args.maxFiles,
          timeoutMs: args.timeoutMs,
        });
        requireHost(config);
        context.logger?.info(
          "Starting NAS disk inventory on {host} — this can take a long time on a large volume (the default tree mode runs one du per volume)",
          { host: config.host },
        );

        const discovery = await runDiscovery(config, context.logger);
        const volumes = config.volumes.length > 0
          ? config.volumes
          : discovery.volumes.map((v) => v.path);
        if (volumes.length === 0) {
          throw new Error("No volumes to scan.");
        }

        const compiledRules = compileRules(config.categories);
        const labels = categoryLabels(config.categories);
        const exclude = config.excludePatterns.map((pattern) => {
          try {
            return new RegExp(pattern, "i");
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
              `Invalid exclude pattern "${pattern}": ${detail}`,
            );
          }
        });
        const isExcluded = (path: string) =>
          exclude.some((regex) => regex.test(path));

        let mode: "tree" | "files" | "shares" = args.mode;
        if (mode === "files") {
          const probe = await runSsh(
            config,
            buildScanModeProbeCommand(),
            config.timeoutMs,
          );
          if (probe.code !== 0) {
            throw new Error(
              `Could not probe the remote find on ${config.host}: ${
                probe.stderr.trim() || `ssh exited ${probe.code}`
              }`,
            );
          }
          if (!probe.stdout.includes("printf")) {
            context.logger?.info(
              "Remote find lacks -printf; falling back to fast du share-level mode. Pass --input mode=shares to skip this probe next time.",
            );
            mode = "shares";
          }
        }

        const aggregation = newAggregation();
        const treeRecords: { bytes: number; path: string }[] = [];

        let streamed: StreamResult;
        if (mode === "tree") {
          context.logger?.info(
            "Scanning {volumes} volume(s) on {host} with du -d{depth} — directory tree, not every file ({scope})",
            {
              volumes: volumes.length,
              host: config.host,
              depth: config.treeDepth,
              scope: config.oneFilesystem
                ? "root filesystem only"
                : "including shared-folder subvolumes",
            },
          );
          streamed = await streamSsh(
            config,
            withSudo(
              buildTreeCommand(
                volumes,
                config.treeDepth,
                config.oneFilesystem,
              ),
              config.useSudo,
            ),
            {
              delimiter: "\n",
              maxFiles: 0,
              timeoutMs: config.timeoutMs,
              onRecord: (record) => {
                const parsed = parseDuLine(record);
                if (!parsed) {
                  aggregation.errors.push({
                    path: "",
                    message: `Unparseable du record: ${record.slice(0, 200)}`,
                  });
                  return;
                }
                if (isExcluded(parsed.path)) return;
                treeRecords.push(parsed);
              },
            },
          );
          if (treeRecords.length > 0) {
            const nodes = buildDirNodes(treeRecords);
            for (const node of nodes) {
              addDir(aggregation, node, {
                compiledRules,
                volumes,
                minNotableBytes: config.minNotableBytes,
              });
            }
          }
        } else if (mode === "files") {
          context.logger?.info(
            "Scanning {volumes} volume(s) on {host} — streaming every file over SSH ({scope})",
            {
              volumes: volumes.length,
              host: config.host,
              scope: config.oneFilesystem
                ? "root filesystem only"
                : "including shared-folder subvolumes",
            },
          );
          streamed = await streamSsh(
            config,
            withSudo(
              buildFindCommand(volumes, config.oneFilesystem),
              config.useSudo,
            ),
            {
              delimiter: "\0",
              maxFiles: config.maxFiles,
              timeoutMs: config.timeoutMs,
              onRecord: (record) => {
                const parsed = parseFileRecord(record);
                if (!parsed) {
                  aggregation.errors.push({
                    path: "",
                    message: `Unparseable find record: ${record.slice(0, 200)}`,
                  });
                  return;
                }
                if (isExcluded(parsed.path)) return;
                addFile(aggregation, parsed, {
                  compiledRules,
                  volumes,
                  minNotableBytes: config.minNotableBytes,
                });
              },
            },
          );
        } else {
          context.logger?.info(
            "Scanning top-level shares with du on {volumes} volume(s) on {host}",
            { volumes: volumes.length, host: config.host },
          );
          const sharePaths = discovery.volumes.flatMap((volume) =>
            volume.shares.map((share) => share.path)
          );
          const duCommand = sharePaths.length > 0
            ? buildDuPathsCommand(sharePaths)
            : buildDuCommand(volumes);
          streamed = await streamSsh(
            config,
            withSudo(duCommand, config.useSudo),
            {
              delimiter: "\n",
              maxFiles: 0,
              timeoutMs: config.timeoutMs,
              onRecord: (record) => {
                const parsed = parseDuLine(record);
                if (!parsed) {
                  aggregation.errors.push({
                    path: "",
                    message: `Unparseable du record: ${record.slice(0, 200)}`,
                  });
                  return;
                }
                if (isExcluded(parsed.path)) return;
                const derived = deriveShare(parsed.path, volumes);
                const category = classifyCompiled(
                  `${derived.path}/`,
                  compiledRules,
                );
                aggregation.bytes += parsed.bytes;
                const cat = aggregation.categories.get(category) ??
                  { bytes: 0, files: 0, samples: [] };
                cat.bytes += parsed.bytes;
                if (cat.samples.length < 3) cat.samples.push(parsed.path);
                aggregation.categories.set(category, cat);
                aggregation.shares.set(derived.path, {
                  ...derived,
                  category,
                  bytes: parsed.bytes,
                  fileCount: 0,
                });
              },
            },
          );
        }

        if (streamed.timedOut) {
          throw new Error(
            `Scan timed out after ${config.timeoutMs}ms. Raise timeoutMs or use --input mode=shares.`,
          );
        }
        if (streamed.code !== 0 && !streamed.truncated) {
          if (
            config.useSudo &&
            /sudo:.*(password is required|terminal is required|no tty present|must have a tty|askpass)/i
              .test(streamed.stderr)
          ) {
            throw new Error(await buildSudoRemediation(config));
          }
          const detail = summarizeStderr(streamed.stderr) ||
            `ssh exited ${streamed.code}`;
          if (aggregation.files === 0 && aggregation.shares.size === 0) {
            throw new Error(
              `Scan failed on ${config.host}: ${detail}. ` +
                "Check that key/agent auth works and that the volumes are readable.",
            );
          }
          aggregation.errors.push({
            path: "",
            message: `Scan incomplete: ${detail}`,
          });
        }

        const totalBytes = aggregation.bytes;
        const categories: CategoryRollup[] = [
          ...aggregation.categories.entries(),
        ]
          .map(([id, value]) => ({
            category: id,
            label: labels.get(id) ?? id,
            totalBytes: value.bytes,
            fileCount: value.files,
            fraction: totalBytes > 0 ? value.bytes / totalBytes : 0,
            samplePaths: value.samples,
          }))
          .sort((a, b) => b.totalBytes - a.totalBytes);

        const shares = [...aggregation.shares.values()]
          .sort((a, b) => b.bytes - a.bytes);
        const usedBytes = discovery.volumes.reduce(
          (sum, volume) => sum + volume.usedBytes,
          0,
        );
        const unaccountedBytes = Math.max(0, usedBytes - totalBytes);
        const coverageFraction = usedBytes > 0 ? totalBytes / usedBytes : 0;
        const scannedSharePaths = new Set(shares.map((share) => share.path));
        const unscannedShares = discovery.volumes
          .flatMap((volume) => volume.shares)
          .filter((share) => !scannedSharePaths.has(share.path));
        const findings = buildFindings(
          categories,
          discovery.volumes,
          shares,
          aggregation.notableDirs,
          aggregation.notable,
          totalBytes,
          config.minNotableBytes,
          {
            useSudo: config.useSudo,
            oneFilesystem: config.oneFilesystem,
          },
        );

        const output: AuditOutput = {
          host: config.host,
          scannedAt: new Date().toISOString(),
          mode,
          useSudo: config.useSudo,
          oneFilesystem: config.oneFilesystem,
          totalBytes,
          totalFiles: aggregation.files,
          totalDirs: aggregation.dirs,
          truncated: streamed.truncated,
          durationMs: Date.now() - started,
          usedBytes,
          unaccountedBytes,
          coverageFraction,
          volumes: discovery.volumes,
          categories,
          shares,
          unscannedShares,
          notableDirs: aggregation.notableDirs,
          notableFiles: aggregation.notable,
          findings,
          errors: aggregation.errors,
        };

        context.logger?.info(
          "Audit complete: {total} across {count} in {seconds}s — {categories} categories, {findings} findings ({mode} mode)",
          {
            total: humanSize(totalBytes),
            count: mode === "tree"
              ? `${aggregation.dirs} directories`
              : `${aggregation.files} files`,
            seconds: (output.durationMs / 1000).toFixed(1),
            categories: categories.length,
            findings: findings.length,
            mode,
          },
        );
        if (streamed.truncated) {
          context.logger?.info(
            "Stopped after maxFiles={max}; the totals are partial.",
            { max: config.maxFiles },
          );
        }
        if (usedBytes > 0 && coverageFraction < 0.95) {
          const hint = config.oneFilesystem
            ? "Re-run with oneFilesystem=false to include shared-folder subvolumes."
            : config.useSudo
            ? "The remainder may be Btrfs snapshots, iSCSI LUNs, or system data."
            : "Re-run with useSudo=true or as root if shares are permission-protected.";
          context.logger?.info(
            "Only {scanned} of {used} used is readable ({percent}%); {unaccounted} is unaccounted. {hint}",
            {
              scanned: humanSize(totalBytes),
              used: humanSize(usedBytes),
              percent: (coverageFraction * 100).toFixed(1),
              unaccounted: humanSize(unaccountedBytes),
              hint,
            },
          );
        }

        const handle = await context.writeResource(
          "audit",
          "audit",
          output as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
  reports: ["@svendowideit/synology-disk-report"],
};
