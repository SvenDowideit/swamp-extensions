/**
 * Swamp model that generates Software Bills of Materials with Anchore Syft.
 *
 * One method, `generate`, scans a target — the whole host filesystem, a
 * container image, a single binary, or a source directory — and writes a
 * Dependency-Track-ready SBOM. Syft covers all four target kinds: `dir:` for a
 * host or a source tree, `file:` for a binary, and `image:`/`registry:` for a
 * container image. The SBOM is recorded both as a swamp file resource and,
 * optionally, at a path you choose, so the next step can curl it to
 * Dependency-Track.
 *
 * The Syft binary is fetched and checksum-verified through
 * `@svendowideit/github-release-install` and cached under the model's state
 * directory, so a host that has never seen Syft needs no manual install. A
 * pre-installed binary can be supplied instead with `syftPath`.
 *
 * Methods:
 *   - `generate`  scan a target and produce an SBOM (`sbom` file + `scan`)
 *   - `install`   resolve, download and cache the Syft binary (`tool`)
 *   - `status`    report the resolved config and any installed Syft versions
 *
 * @module
 */

// meta-factory-ignore config-lifecycle: this extension has no user-config
// lifecycle to persist. Every setting is a global argument supplied at model
// creation; the `tool` and `status` resources report the resolved binary and
// config for inspection only, so there is no partial state to save or read
// back and no `setup` method is warranted.

import { z } from "npm:zod@4";

/** SBOM formats syft can emit that Dependency-Track accepts (plus syft-json). */
export const OUTPUT_FORMATS: string[] = [
  "cyclonedx-json",
  "cyclonedx-xml",
  "spdx-json",
  "spdx-tag-value",
  "syft-json",
];

/** The syft source schemes a target type may select. */
export const TARGET_TYPES: string[] = [
  "",
  "dir",
  "file",
  "image",
  "registry",
  "docker",
  "podman",
  "oci-archive",
  "oci-dir",
  "singularity",
  "purl",
  "sbom",
];

/** The MIME type recorded for each SBOM format. */
export const CONTENT_TYPES: Record<string, string> = {
  "cyclonedx-json": "application/vnd.cyclonedx+json",
  "cyclonedx-xml": "application/vnd.cyclonedx+xml",
  "spdx-json": "application/spdx+json",
  "spdx-tag-value": "text/spdx",
  "syft-json": "application/json",
};

// ---------------------------------------------------------------------------
// Plain record shapes (exported so helper signatures stay free of zod types)
// ---------------------------------------------------------------------------

/** A resolved Syft binary. */
export interface ToolInfo {
  /** Absolute path to the syft binary. */
  path: string;
  /** The binary's reported version, or "" when it could not be read. */
  version: string;
  /** Where the binary came from: an explicit `syftPath` or our cache. */
  source: "path" | "installed";
  /** The verified release archive the binary was extracted from, if any. */
  archivePath: string | null;
  /** Whether the downloader reused a previously verified archive. */
  cached: boolean;
  /** `os/arch` the archive was built for. */
  platform: string | null;
}

/** A summary read out of a generated SBOM document. */
export interface BomSummary {
  /** Number of components/packages/artifacts, or null when unknown. */
  packageCount: number | null;
  /** The BOM format (e.g. `CycloneDX`, `SPDX`, `syft`). */
  bomFormat: string | null;
  /** The format's spec version (e.g. `1.5`, `SPDX-2.3`). */
  specVersion: string | null;
  /** The source name the SBOM describes. */
  sourceName: string | null;
  /** The source version the SBOM describes. */
  sourceVersion: string | null;
}

/** Everything needed to build the syft `scan` command line. */
export interface SyftInvocation {
  /** The resolved syft source (e.g. `dir:/`), with scheme. */
  target: string;
  /** Output format, one of `OUTPUT_FORMATS`. */
  format: string;
  /** Path the SBOM is written to. */
  outputFile: string;
  /** Catalogers to enable (syft `--catalogers`). */
  catalogers: string[];
  /** Paths/globs to exclude (syft `--exclude`). */
  exclude: string[];
  /** Image layer scope: `squashed` or `all-layers` (empty omits the flag). */
  scope: string;
  /** Image platform, e.g. `linux/amd64` (empty omits the flag). */
  platform: string;
  /** Override the SBOM source name (empty omits the flag). */
  sourceName: string;
  /** Override the SBOM source version (empty omits the flag). */
  sourceVersion: string;
}

/** The outcome of running a subprocess. */
export interface ProcessResult {
  /** The process exit code. */
  code: number;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Everything the process wrote to stderr. */
  stderr: string;
}

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

function safeValue(label: string): z.ZodString {
  return z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );
}

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp; used to name the tool cache).",
  ),
  syftPath: safeValue("syftPath").default("").describe(
    "Path to a pre-installed syft binary. Empty auto-installs and caches one.",
  ),
  syftVersion: safeValue("syftVersion").default("").describe(
    "Syft release to install. Empty installs the latest.",
  ),
  repo: safeValue("repo").default("anchore/syft").describe(
    "GitHub repository publishing the syft releases.",
  ),
  stateDir: safeValue("stateDir").default("~/.swamp/generate-sbom-syft")
    .describe(
      "Directory for the cached syft binary and downloaded archives.",
    ),
  githubToken: z.string().meta({ sensitive: true }).default("").describe(
    "GitHub token used when resolving/downloading the syft release (raises the " +
      "API rate limit). Empty falls back to GITHUB_TOKEN / GH_TOKEN / gh CLI.",
  ),
  outputFormat: z.enum(OUTPUT_FORMATS as [string, ...string[]]).default(
    "cyclonedx-json",
  ).describe("Default SBOM format (Dependency-Track accepts CycloneDX/SPDX)."),
  catalogers: z.array(safeValue("cataloger")).default([]).describe(
    "Default syft catalogers to enable (e.g. os, python, node). Empty = all.",
  ),
  exclude: z.array(safeValue("exclude")).default([]).describe(
    "Default exclusions, in syft glob syntax (each must start with ./, */ or " +
      "**/, e.g. **/proc/**).",
  ),
  scope: z.enum(["", "squashed", "all-layers"]).default("").describe(
    "Default image layer scope. Empty uses syft's default (squashed).",
  ),
  sourceName: safeValue("sourceName").default("").describe(
    "Default SBOM source name (identifies the project in Dependency-Track).",
  ),
  sourceVersion: safeValue("sourceVersion").default("").describe(
    "Default SBOM source version.",
  ),
  timeoutMs: z.number().int().positive().default(900000).describe(
    "Maximum time for a scan (a full host scan can take minutes).",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const GenerateArgsSchema = z.object({
  target: z.string().min(1).describe(
    "What to scan: a filesystem path (`/`, a source tree), a binary path, or a " +
      "container image reference. A scheme prefix (`dir:`, `file:`, `image:`, " +
      "`registry:`, …) is honored as-is.",
  ),
  targetType: z.enum(TARGET_TYPES as [string, ...string[]]).default("")
    .describe(
      "Syft source scheme to prepend when the target has none. Empty lets syft " +
        "auto-detect.",
    ),
  format: z.enum(OUTPUT_FORMATS as [string, ...string[]]).optional().describe(
    "Override the global outputFormat for this scan.",
  ),
  catalogers: z.array(z.string()).optional().describe(
    "Override the global catalogers for this scan.",
  ),
  exclude: z.array(z.string()).optional().describe(
    "Override the global exclusions for this scan (syft glob syntax, e.g. " +
      "**/proc/**).",
  ),
  scope: z.enum(["", "squashed", "all-layers"]).optional().describe(
    "Override the global image scope for this scan.",
  ),
  platform: z.string().default("").describe(
    "Image platform for container scans, e.g. linux/amd64.",
  ),
  sourceName: z.string().optional().describe(
    "Override the global SBOM source name.",
  ),
  sourceVersion: z.string().optional().describe(
    "Override the global SBOM source version.",
  ),
  label: z.string().default("").describe(
    "Name for the SBOM file (empty = a generated name).",
  ),
  outputFile: z.string().default("").describe(
    "Also write the SBOM to this path (absolute or ~-prefixed).",
  ),
  timeoutMs: z.number().int().positive().optional().describe(
    "Override the global scan timeout for this run.",
  ),
});

type GenerateArgs = z.infer<typeof GenerateArgsSchema>;

const InstallArgsSchema = z.object({
  force: z.boolean().default(false).describe(
    "Re-download the syft archive even when a verified copy is already cached.",
  ),
});

type InstallArgs = z.infer<typeof InstallArgsSchema>;

const StatusArgsSchema = z.object({});
type StatusArgs = z.infer<typeof StatusArgsSchema>;

// ---------------------------------------------------------------------------
// Record schemas (module-private; the plain interfaces above mirror them)
// ---------------------------------------------------------------------------

const ToolSchema = z.object({
  path: z.string(),
  version: z.string(),
  source: z.enum(["path", "installed"]),
  archivePath: z.string().nullable(),
  cached: z.boolean(),
  platform: z.string().nullable(),
  installedAt: z.string(),
});

const ScanSchema = z.object({
  target: z.string(),
  targetType: z.string(),
  format: z.string(),
  sbomFormat: z.string().nullable(),
  specVersion: z.string().nullable(),
  packageCount: z.number().int().nullable(),
  sourceName: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  toolVersion: z.string(),
  toolPath: z.string(),
  outputFile: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int(),
  command: z.array(z.string()),
  stderr: z.string(),
  generatedAt: z.string(),
});

const StatusSchema = z.object({
  ready: z.boolean(),
  stateDir: z.string(),
  repo: z.string(),
  syftVersion: z.string(),
  outputFormat: z.string(),
  syftPath: z.string(),
  toolPath: z.string().nullable(),
  installedVersions: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(raw: string): string {
  if (raw === "~") return Deno.env.get("HOME") ?? "~";
  if (raw.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home) return `${home}${raw.slice(1)}`;
  }
  return raw;
}

/** Deterministic 32-bit FNV-1a hash of a string, as 8 hex digits. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The GoReleaser-style OS token for this host (`linux`/`darwin`/`windows`). */
export function hostOs(): string {
  switch (Deno.build.os) {
    case "darwin":
      return "darwin";
    case "windows":
      return "windows";
    default:
      return "linux";
  }
}

/** The GoReleaser-style architecture token for this host (`amd64`/`arm64`). */
export function hostArch(): string {
  switch (Deno.build.arch) {
    case "x86_64":
      return "amd64";
    case "aarch64":
      return "arm64";
    default:
      return Deno.build.arch;
  }
}

/**
 * Resolve a syft source string from a target type and target. A target that
 * already carries a scheme (and is not a bare Windows drive path) is used
 * as-is; otherwise the type is prepended, or the target left for syft to
 * auto-detect when the type is empty.
 */
export function resolveTarget(targetType: string, target: string): string {
  const t = target.trim();
  const scheme = t.match(/^([a-z][a-z0-9-]*):/i);
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(t);
  // Only a *known* syft scheme means the target is already resolved — a bare
  // `alpine:3.19` or `host:5000/img` also contains a colon but is not a scheme.
  if (scheme && !isWindowsDrive && TARGET_TYPES.includes(scheme[1])) return t;
  const type = targetType.trim();
  return type ? `${type}:${t}` : t;
}

/** Build the sbom file-name base from a label or a target/method hash. */
export function sbomInstanceName(
  label: string,
  format: string,
  target: string,
): string {
  const clean = label.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  if (clean) return clean;
  return `sbom-${fnv1a(`${format} ${target}`)}`;
}

/** Build the syft `scan` argv. */
export function buildSyftArgs(inv: SyftInvocation): string[] {
  const args: string[] = [
    "scan",
    inv.target,
    "--output",
    `${inv.format}=${inv.outputFile}`,
    "--quiet",
  ];
  for (const c of inv.catalogers) args.push("--catalogers", c);
  for (const e of inv.exclude) args.push("--exclude", e);
  if (inv.scope) args.push("--scope", inv.scope);
  if (inv.platform) args.push("--platform", inv.platform);
  if (inv.sourceName) args.push("--source-name", inv.sourceName);
  if (inv.sourceVersion) args.push("--source-version", inv.sourceVersion);
  return args;
}

/** Read a string field from an unknown record, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Summarise a generated SBOM document: package count, format and source. */
export function summarizeBom(format: string, doc: unknown): BomSummary {
  const o = (typeof doc === "object" && doc !== null)
    ? doc as Record<string, unknown>
    : {};
  const summary: BomSummary = {
    packageCount: null,
    bomFormat: null,
    specVersion: null,
    sourceName: null,
    sourceVersion: null,
  };
  if (format.startsWith("cyclonedx")) {
    summary.bomFormat = str(o["bomFormat"]) ?? "CycloneDX";
    summary.specVersion = str(o["specVersion"]);
    summary.packageCount = Array.isArray(o["components"])
      ? o["components"].length
      : 0;
    const metadata = o["metadata"];
    if (typeof metadata === "object" && metadata !== null) {
      const component = (metadata as Record<string, unknown>)["component"];
      if (typeof component === "object" && component !== null) {
        summary.sourceName = str(
          (component as Record<string, unknown>)["name"],
        );
        summary.sourceVersion = str(
          (component as Record<string, unknown>)["version"],
        );
      }
    }
  } else if (format.startsWith("spdx")) {
    summary.bomFormat = "SPDX";
    summary.specVersion = str(o["spdxVersion"]);
    summary.packageCount = Array.isArray(o["packages"])
      ? o["packages"].length
      : 0;
    summary.sourceName = str(o["name"]);
  } else if (format.startsWith("syft")) {
    summary.bomFormat = "syft";
    summary.packageCount = Array.isArray(o["artifacts"])
      ? o["artifacts"].length
      : 0;
    const source = o["source"];
    if (typeof source === "object" && source !== null) {
      summary.sourceName = str((source as Record<string, unknown>)["name"]);
      summary.sourceVersion = str(
        (source as Record<string, unknown>)["version"],
      );
    }
  }
  return summary;
}

/** Parse the version out of `syft version -o json` or `syft --version`. */
export function parseSyftVersion(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const v = str((parsed as Record<string, unknown>)["version"]);
    if (v) return v;
  } catch {
    // not JSON — fall through to the regex
  }
  const m = text.match(/(\d+\.\d+\.\d+[^\s]*)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

/** Run a subprocess, capturing stdout/stderr and honouring an AbortSignal. */
export async function runProcess(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ProcessResult> {
  let child: Deno.ChildProcess;
  try {
    // swamp-quality-ignore deno-command: this extension wraps the syft and tar binaries — running them is its purpose. Arguments are built by buildSyftArgs, not taken raw from the caller.
    child = new Deno.Command(bin, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    throw new Error(
      `Failed to start '${bin}': ${
        err instanceof Error ? err.message : String(err)
      }.`,
    );
  }
  const onAbort = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const status = await child.status;
  const [out, err] = await Promise.all([stdout, stderr]);
  if (signal) signal.removeEventListener("abort", onAbort);
  return { code: status.code, stdout: out, stderr: err };
}

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type RunModelResult =
  | { ok: true; resources: Array<{ name: string; specName?: string }> }
  | { ok: false; error: { message: string } };

interface MethodContext {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  signal?: AbortSignal;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: { contentType?: string },
  ) => {
    writeAll: (bytes: Uint8Array) => Promise<{ name: string }>;
  };
  runModel?: (options: {
    modelType?: string;
    definition?: string;
    name?: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<RunModelResult>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<
    Array<{ content?: unknown; attributes?: unknown; version?: number }>
  >;
}

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

/** Probe a syft binary for its version; null when it is missing or broken. */
async function probeSyft(bin: string): Promise<string | null> {
  try {
    const json = await runProcess(bin, ["version", "-o", "json"]);
    if (json.code === 0) {
      const v = parseSyftVersion(json.stdout);
      if (v) return v;
    }
    const plain = await runProcess(bin, ["--version"]);
    if (plain.code === 0) return parseSyftVersion(plain.stdout);
    return null;
  } catch {
    return null;
  }
}

/** Read the latest `archive` attributes a github-release-install model wrote. */
async function installerArchive(
  ctx: MethodContext,
  installerName: string,
): Promise<Record<string, unknown> | undefined> {
  if (!ctx.readModelData) return undefined;
  try {
    const rows = await ctx.readModelData(installerName, "archive");
    if (!rows || rows.length === 0) return undefined;
    const latest = rows.reduce((a, b) =>
      (b.version ?? 0) >= (a.version ?? 0) ? b : a
    );
    const value = latest.attributes ?? latest.content;
    return (value ?? undefined) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure a usable syft binary: use `syftPath` when given, otherwise download
 * and verify the release through `@svendowideit/github-release-install` and
 * cache the extracted binary under the state directory.
 */
async function ensureTool(
  ctx: MethodContext,
  force: boolean,
): Promise<ToolInfo> {
  const g = ctx.globalArgs;
  const explicit = g.syftPath.trim();
  if (explicit) {
    const bin = expandHome(explicit);
    const version = await probeSyft(bin);
    if (!version) {
      throw new Error(
        `syftPath '${bin}' did not respond to 'syft version'. Check the path.`,
      );
    }
    return {
      path: bin,
      version,
      source: "path",
      archivePath: null,
      cached: false,
      platform: null,
    };
  }

  if (!ctx.runModel) {
    throw new Error(
      "context.runModel is unavailable — cannot install syft automatically. " +
        "Set --global-arg syftPath=/path/to/syft instead.",
    );
  }

  const modelName = ctx.definition?.name ?? "syft";
  // A distinct suffix so the internal installer instance cannot collide with a
  // user's model instance named "<something>-syft".
  const installerName = `${modelName}-syft-release`;
  const stateDir = expandHome(g.stateDir);
  const os = hostOs();
  const arch = hostArch();
  const versionToken = g.syftVersion.trim() || "latest";
  const downloadsDir = `${stateDir}/downloads`;
  await Deno.mkdir(downloadsDir, { recursive: true });
  const archivePath =
    `${downloadsDir}/syft-${versionToken}-${os}-${arch}.tar.gz`;

  const download = await ctx.runModel({
    modelType: "@svendowideit/github-release-install",
    name: installerName,
    method: "download",
    arguments: {
      repo: g.repo,
      stem: "syft",
      format: "tar.gz",
      outputPath: archivePath,
      force,
      requireChecksum: true,
      ...(g.syftVersion.trim() ? { version: g.syftVersion.trim() } : {}),
      ...(g.githubToken.trim() ? { githubToken: g.githubToken.trim() } : {}),
    },
  });
  if (!download.ok) {
    throw new Error(
      `Fetching the syft release failed: ${download.error.message}. Set ` +
        "--global-arg githubToken=… if you hit GitHub rate limits, or " +
        "--global-arg syftPath=/path/to/syft to use a pre-installed binary.",
    );
  }

  const archive = await installerArchive(ctx, installerName);
  const version = str(archive?.["version"]) ?? g.syftVersion.trim();
  if (!version) {
    throw new Error(
      "Could not determine the syft version from the release archive record.",
    );
  }
  const sourceArchive = str(archive?.["path"]) ?? archivePath;
  const platform = archive?.["platform"];
  const platformLabel = (typeof platform === "object" && platform !== null)
    ? `${(platform as Record<string, unknown>)["os"]}/${
      (platform as Record<string, unknown>)["arch"]
    }`
    : `${os}/${arch}`;

  const binDir = `${stateDir}/bin/syft/${version}/${os}-${arch}`;
  const binPath = `${binDir}/syft`;
  if (!force) {
    const version0 = await probeSyft(binPath);
    if (version0) {
      return {
        path: binPath,
        version: version0,
        source: "installed",
        archivePath: sourceArchive,
        cached: archive?.["cached"] === true,
        platform: platformLabel,
      };
    }
  }

  await Deno.mkdir(binDir, { recursive: true });
  const extract = await runProcess("tar", [
    "-xzf",
    sourceArchive,
    "-C",
    binDir,
  ]);
  if (extract.code !== 0) {
    throw new Error(
      `Extracting syft from ${sourceArchive} failed (${extract.code}): ${
        extract.stderr.trim() || "no stderr"
      }`,
    );
  }
  await Deno.chmod(binPath, 0o755);
  const installed = await probeSyft(binPath);
  if (!installed) {
    throw new Error(
      `Extracted ${sourceArchive} but ${binPath} did not run as syft.`,
    );
  }
  return {
    path: binPath,
    version: installed,
    source: "installed",
    archivePath: sourceArchive,
    cached: archive?.["cached"] === true,
    platform: platformLabel,
  };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A syft-backed SBOM generator for hosts, images, binaries and source trees. */
export const model = {
  type: "@svendowideit/generate-sbom-syft",
  version: "2026.10.11.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.11.1",
      description:
        "Initial release: generate Dependency-Track-ready SBOMs with Anchore " +
        "Syft for a whole host (dir:/), a container image (image:/registry:), a " +
        "binary (file:) or a source tree. The binary is checksum-verified and " +
        "cached via @svendowideit/github-release-install; `generate` writes the " +
        "SBOM as a file resource plus a `scan` summary, `install` manages the " +
        "binary, `status` reports config and installed versions.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    tool: {
      description: "The resolved syft binary: version, path and provenance.",
      schema: ToolSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    scan: {
      description:
        "Summary of the last SBOM generation: target, format, package count, " +
        "source identity, size, duration and process outcome.",
      schema: ScanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    status: {
      description: "Resolved config and installed syft versions.",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  files: {
    sbom: {
      description: "The generated SBOM document.",
      contentType: "application/json",
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  checks: {
    "valid-config": {
      description:
        "Ensure the state directory, repository, output format and timeout are " +
        "sane before installing or scanning.",
      labels: ["policy"],
      execute: (ctx: { globalArgs: GlobalArgs }) => {
        const errors: string[] = [];
        if (
          !ctx.globalArgs.syftPath.trim() && !ctx.globalArgs.stateDir.trim()
        ) {
          errors.push("stateDir must not be empty when syftPath is unset.");
        }
        if (!ctx.globalArgs.repo.trim()) errors.push("repo must not be empty.");
        if (ctx.globalArgs.timeoutMs <= 0) {
          errors.push("timeoutMs must be positive.");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },

  methods: {
    generate: {
      description:
        "Generate an SBOM with syft for a host filesystem, container image, " +
        "binary or directory, and write it as a `sbom` file resource (and " +
        "optionally an outputFile). Records a `scan` summary. Installs syft " +
        "when it is not already available.",
      arguments: GenerateArgsSchema,
      execute: async (args: GenerateArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const tool = await ensureTool(ctx, false);
        const format = args.format ?? g.outputFormat;
        const catalogers = args.catalogers ?? g.catalogers;
        const exclude = args.exclude ?? g.exclude;
        const scope = args.scope ?? g.scope;
        const sourceName = args.sourceName ?? g.sourceName;
        const sourceVersion = args.sourceVersion ?? g.sourceVersion;
        const target = resolveTarget(args.targetType, args.target);
        const t0 = performance.now();

        const tmpDir = await Deno.makeTempDir({ prefix: "swamp-syft-" });
        const sbomTmp = `${tmpDir}/sbom.out`;
        try {
          const argv = buildSyftArgs({
            target,
            format,
            outputFile: sbomTmp,
            catalogers,
            exclude,
            scope,
            platform: args.platform,
            sourceName,
            sourceVersion,
          });
          const proc = await runProcess(tool.path, argv, ctx.signal);
          const bytes = await readBytesSafe(sbomTmp);
          if (proc.code !== 0 || bytes.byteLength === 0) {
            const detail = proc.stderr.trim() || proc.stdout.trim() ||
              "no output produced";
            throw new Error(
              `syft scan failed (exit ${proc.code}) for ${target}: ${detail}`,
            );
          }

          let doc: unknown = null;
          try {
            doc = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            doc = null;
          }
          const summary = summarizeBom(format, doc);

          if (args.outputFile) {
            const out = expandHome(args.outputFile);
            await ensureParent(out);
            await Deno.writeFile(out, bytes);
          }

          const base = sbomInstanceName(args.label, format, target);
          const writer = ctx.createFileWriter("sbom", base, {
            contentType: CONTENT_TYPES[format] ?? "application/json",
          });
          const wrote = await writer.writeAll(bytes);

          const record: z.infer<typeof ScanSchema> = {
            target,
            targetType: args.targetType,
            format,
            sbomFormat: summary.bomFormat,
            specVersion: summary.specVersion,
            packageCount: summary.packageCount,
            sourceName: summary.sourceName ?? (sourceName || null),
            sourceVersion: summary.sourceVersion ?? (sourceVersion || null),
            toolVersion: tool.version,
            toolPath: tool.path,
            outputFile: args.outputFile ? expandHome(args.outputFile) : null,
            sizeBytes: bytes.byteLength,
            durationMs: Math.round(performance.now() - t0),
            exitCode: proc.code,
            command: [tool.path, ...argv],
            stderr: proc.stderr.trim(),
            generatedAt: new Date().toISOString(),
          };
          const scanHandle = await ctx.writeResource(
            "scan",
            `scan-${base}`,
            record,
          );
          ctx.logger?.info(
            "Generated {format} SBOM for {target}: {count} package(s), " +
              "{bytes}B in {ms}ms",
            {
              format,
              target,
              count: summary.packageCount ?? "unknown",
              bytes: bytes.byteLength,
              ms: record.durationMs,
            },
          );
          return { dataHandles: [wrote, scanHandle] };
        } finally {
          await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
        }
      },
    },

    install: {
      description:
        "Resolve, download (checksum-verified) and cache the syft binary, " +
        "extracting it under the state directory. Idempotent: an already " +
        "installed, working binary is reused unless force is set.",
      arguments: InstallArgsSchema,
      execute: async (args: InstallArgs, ctx: MethodContext) => {
        const tool = await ensureTool(ctx, args.force);
        const handle = await ctx.writeResource("tool", "tool", {
          path: tool.path,
          version: tool.version,
          source: tool.source,
          archivePath: tool.archivePath,
          cached: tool.cached,
          platform: tool.platform,
          installedAt: new Date().toISOString(),
        });
        ctx.logger?.info(
          "syft {version} ready at {path} ({source}{cached})",
          {
            version: tool.version,
            path: tool.path,
            source: tool.source,
            cached: tool.cached ? ", cached archive" : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report the resolved configuration and every syft version installed " +
        "under the state directory, without downloading anything.",
      arguments: StatusArgsSchema,
      execute: async (_args: StatusArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const stateDir = expandHome(g.stateDir);
        const explicit = g.syftPath.trim();
        let toolPath: string | null = null;
        let toolVersion = "";
        if (explicit) {
          toolPath = expandHome(explicit);
          toolVersion = (await probeSyft(toolPath)) ?? "";
        }
        const installedVersions = explicit
          ? []
          : await findInstalledVersions(stateDir);
        const record: z.infer<typeof StatusSchema> = {
          ready: !!(toolVersion || installedVersions.length > 0),
          stateDir,
          repo: g.repo,
          syftVersion: g.syftVersion,
          outputFormat: g.outputFormat,
          syftPath: explicit,
          toolPath,
          installedVersions,
        };
        const handle = await ctx.writeResource("status", "status", record);
        ctx.logger?.info(
          "syft status: {state}{versions}",
          {
            state: record.ready ? "ready" : "not installed",
            versions: installedVersions.length
              ? ` (${installedVersions.join(", ")})`
              : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Read a file's bytes, or an empty array when absent/unreadable. */
async function readBytesSafe(path: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(path);
  } catch {
    return new Uint8Array();
  }
}

/** Ensure the parent directory of a file path exists. */
async function ensureParent(path: string): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx > 0) await Deno.mkdir(path.slice(0, idx), { recursive: true });
}

/** List the syft versions installed under `<stateDir>/bin/syft`. */
async function findInstalledVersions(stateDir: string): Promise<string[]> {
  const root = `${stateDir}/bin/syft`;
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory) continue;
      const sub = `${root}/${entry.name}`;
      let ok = false;
      try {
        for await (const inner of Deno.readDir(sub)) {
          if (inner.isFile && inner.name === "syft") ok = true;
        }
      } catch {
        continue;
      }
      if (ok) out.push(entry.name);
    }
  } catch {
    return [];
  }
  return out.sort();
}
