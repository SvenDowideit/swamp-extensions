/**
 * Shared helpers for the `@svendowideit/ollama` extension.
 *
 * Fetching, platform selection, checksum lookup and download are delegated to
 * `@svendowideit/github-release-install` (called by the bundled
 * `ollama-install` workflow). This module keeps only what is particular to
 * Ollama:
 *
 *   - the accelerator/build variants Ollama publishes and how each maps to an
 *     asset stem (`ollama-linux-amd64`, `ollama-linux-amd64-rocm`,
 *     `ollama-linux-arm64-jetpack6`, `ollama-windows-amd64`, `ollama-darwin`);
 *   - the asset-name pattern used to parse those stems;
 *   - archive extraction (tar.gz / tgz, tar.zst, zip) into a staging
 *     directory;
 *   - parsing `ollama --version` output;
 *   - rendering a systemd unit for the `ollama serve` daemon, with the
 *     configuration knobs (user, group, environment, extra args) the
 *     extension exposes;
 *   - version normalisation and comparison.
 *
 * Everything here is either pure or a single-purpose filesystem/command call,
 * so it can be unit tested in isolation.
 *
 * @module
 */

import { unzipSync } from "npm:fflate@0.8.3";
import { UntarStream } from "jsr:@std/tar@0.1.10/untar-stream";

// ---------------------------------------------------------------------------
// Accelerator / build variants
// ---------------------------------------------------------------------------

/** The archive extension Ollama publishes for a platform. */
export function assetExtension(os: string): string {
  if (isDarwinOs(os)) return "tgz";
  if (isWindowsOs(os)) return "zip";
  return "tar.zst";
}

/**
 * The exact release asset file name for a platform and accelerator, e.g.
 * `ollama-linux-amd64.tar.zst` or `ollama-darwin.tgz`. Ollama asset names carry
 * no version, so this is deterministic from the platform alone.
 */
export function assetFileName(
  os: string,
  arch: string,
  accel: ConcreteAccel,
): string {
  return `${assetStem(os, arch, accel)}.${assetExtension(os)}`;
}

/**
 * Ollama accelerator/build variants the extension can select.
 *
 * `base` is the default: on Linux it bundles CUDA support for NVIDIA GPUs, so
 * no special variant is needed for NVIDIA. `rocm` adds AMD GPU support on
 * Linux/Windows, `mlx` is the MLX build, and `jetpack5` / `jetpack6` are the
 * NVIDIA Jetson (ARM64) builds.
 */
export const ACCEL_VARIANTS = [
  "auto",
  "base",
  "rocm",
  "mlx",
  "jetpack5",
  "jetpack6",
] as const;

/** An Ollama accelerator/build variant, or `auto` to detect one. */
export type AccelVariant = typeof ACCEL_VARIANTS[number];

/** Concrete variants (everything except `auto`). */
export type ConcreteAccel = Exclude<AccelVariant, "auto">;

/** Whether a variant is one of the concrete build suffixes. */
export function isConcreteAccel(value: string): value is ConcreteAccel {
  return (ACCEL_VARIANTS as readonly string[]).includes(value) &&
    value !== "auto";
}

/**
 * The asset stem Ollama publishes for a platform and accelerator.
 *
 * macOS is published as a single `ollama-darwin` asset (no arch or accel
 * suffix); Linux and Windows carry the architecture (`amd64` / `arm64`) and an
 * optional variant suffix (`rocm`, `mlx`, `jetpack5`, `jetpack6`).
 */
export function assetStem(
  os: string,
  arch: string,
  accel: ConcreteAccel,
): string {
  const o = os.trim().toLowerCase();
  if (o === "darwin" || o === "macos" || o === "macosx" || o === "osx") {
    return "ollama-darwin";
  }
  const family = o === "windows" || o === "win" ? "windows" : "linux";
  const a = arch.trim().toLowerCase();
  const archToken = a === "arm64" || a === "aarch64" ? "arm64" : "amd64";
  const suffix = accel === "base" ? "" : `-${accel}`;
  return `ollama-${family}-${archToken}${suffix}`;
}

/**
 * The asset-name pattern for Ollama releases.
 *
 * Named groups: `stem` (product + platform + optional accel), `os`
 * (`linux`/`darwin`/`windows`), `arch` (`amd64`/`arm64`, absent for darwin) and
 * `ext` (`tar.zst`/`tgz`/`zip`). The version is not in the asset name — it
 * comes from the release tag — so the pattern omits the `version` group.
 *
 * A second alternative matches the macOS asset, which has no architecture
 * segment, by treating `darwin` as the OS and leaving `arch` empty.
 */
export const OLLAMA_ASSET_PATTERN: string =
  "^(?<stem>ollama-(?<os>linux|windows|darwin)(?:-(?<arch>amd64|arm64))?(?:-[a-z0-9]+)?)" +
  "\\.(?<ext>tar\\.zst|tgz|tar\\.gz|zip)$";

/**
 * Detect the accelerator variant for a platform from local probes, when the
 * caller did not name one. Best-effort and overridable:
 *
 *   - a Jetson board (`/etc/nv_tegra_release`) selects `jetpack6` for R36, or
 *     `jetpack5` for R35;
 *   - an AMD GPU on Linux (the `kfd` device or `rocm-smi`/`rocminfo`) selects
 *     `rocm`;
 *   - everything else uses `base` (which already bundles CUDA on Linux/amd64).
 *
 * `readFile` and `hasCommand` are injectable so this is unit testable.
 */
export async function detectAccel(
  os: string,
  arch: string,
  probes: {
    readFile?: (path: string) => Promise<string>;
    hasCommand?: (name: string) => Promise<boolean>;
  } = {},
): Promise<ConcreteAccel> {
  const readFile = probes.readFile ?? (async (p: string) => {
    try {
      return await Deno.readTextFile(p);
    } catch {
      return "";
    }
  });
  const hasCommand = probes.hasCommand ?? defaultHasCommand;

  const o = os.trim().toLowerCase();
  const a = arch.trim().toLowerCase();
  const isLinux = o === "linux";
  const isArm = a === "arm64" || a === "aarch64";

  if (isLinux && isArm) {
    const tegra = await readFile("/etc/nv_tegra_release");
    if (tegra) {
      if (/R36/.test(tegra)) return "jetpack6";
      if (/R35/.test(tegra)) return "jetpack5";
    }
  }

  if (isLinux) {
    const kfd = await readFile("/dev/kfd");
    if (await hasCommand("rocm-smi") || await hasCommand("rocminfo")) {
      return "rocm";
    }
    // A present device node is also a strong AMD signal even when the ROCm CLI
    // tools are not installed; Deno cannot stat a char device as text, so fall
    // back to the command probes only when the file read produced content.
    if (kfd) return "rocm";
  }

  return "base";
}

/** Whether a binary is on `$PATH` (used by {@link detectAccel}). */
async function defaultHasCommand(name: string): Promise<boolean> {
  try {
    const proc = new Deno.Command("which", {
      args: [name],
      stdout: "null",
      stderr: "null",
    });
    return (await proc.output()).code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Strip a leading `v` and surrounding whitespace, so `v0.35.0` == `0.35.0`. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Compare two version strings by numeric dotted segments (ignoring a `v`). */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".");
  const pb = normalizeVersion(b).split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    const va = Number.isNaN(na) ? 0 : na;
    const vb = Number.isNaN(nb) ? 0 : nb;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

/** Whether two versions are equal after normalising a leading `v`. */
export function versionsEqual(a: string, b: string): boolean {
  return compareVersions(a, b) === 0;
}

/**
 * Parse `ollama --version` output. The command prints
 * `ollama version is 0.33.3` (older builds print `ollama version 0.33.3`), so
 * the version is the first dotted number found. Returns `null` when the output
 * carries no version.
 */
export function parseVersionOutput(output: string): string | null {
  const match = output.match(/ollama\s+version(?:\s+is)?\s+v?(\d[\w.+-]*)/i);
  if (!match) return null;
  return normalizeVersion(match[1]);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/**
 * Assert a target path is safe: absolute, or `~`-prefixed (expanded by the
 * caller). A relative path would resolve against whatever working directory
 * the method happened to run in, so it is rejected. An empty string is allowed
 * (the caller then uses a default).
 */
export function assertAbsoluteDir(dir: string, field: string): void {
  const value = dir.trim();
  if (value && !value.startsWith("/") && !value.startsWith("~")) {
    throw new Error(
      `${field} must be an absolute path or ~-prefixed, got '${value}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// Platform probing
// ---------------------------------------------------------------------------

/**
 * Map `uname -s` output to an Ollama release OS token (`Linux`, `Darwin`,
 * `Windows`), or `UNKNOWN`.
 */
export function mapUnameOs(uname: string): string {
  const s = uname.trim().toLowerCase();
  if (s.startsWith("linux")) return "Linux";
  if (s.startsWith("darwin")) return "Darwin";
  if (
    s.startsWith("windows") || s.startsWith("mingw") || s.startsWith("msys") ||
    s.startsWith("cygwin")
  ) {
    return "Windows";
  }
  return "UNKNOWN";
}

/** Map `uname -m` output to an Ollama architecture token (`x86_64`/`arm64`). */
export function mapUnameArch(uname: string): string {
  const a = uname.trim().toLowerCase();
  if (a === "x86_64" || a === "amd64") return "x86_64";
  if (a === "arm64" || a === "aarch64") return "arm64";
  return a === "" ? "unknown" : a;
}

/**
 * Resolve the platform OS/arch for a run from explicit overrides, falling back
 * to a host probe (`uname -s` / `uname -m`) for whichever value is empty.
 */
export async function resolveOsArch(
  os: string,
  arch: string,
  runner: CommandRunner,
): Promise<{ os: string; arch: string }> {
  const o = os.trim();
  const a = arch.trim();
  const probeOs = o ||
    mapUnameOs((await runner("uname", ["-s"])).stdout);
  const probeArch = a ||
    mapUnameArch((await runner("uname", ["-m"])).stdout);
  return { os: probeOs, arch: probeArch };
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/**
 * Digest algorithms recognised by a hex digest's length: 40=SHA-1, 64=SHA-256,
 * 96=SHA-384, 128=SHA-512.
 */
const CHECKSUM_ALGORITHMS: Record<number, string> = {
  40: "sha1",
  64: "sha256",
  96: "sha384",
  128: "sha512",
};

/** The WebCrypto algorithm name for a digest's hex length, or `null`. */
export function webCryptoAlgorithm(hexLength: number): string | null {
  switch (CHECKSUM_ALGORITHMS[hexLength]) {
    case "sha1":
      return "SHA-1";
    case "sha256":
      return "SHA-256";
    case "sha384":
      return "SHA-384";
    case "sha512":
      return "SHA-512";
    default:
      return null;
  }
}

/** Compute a digest of `bytes`, lowercase hex, with the named algorithm. */
export async function digestHex(
  bytes: Uint8Array,
  algorithm: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    algorithm,
    new Uint8Array(bytes),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A verified digest: its value, algorithm and whether it matched. */
export interface DigestResult {
  /** The computed digest, lowercase hex. */
  hex: string;
  /** The algorithm used, e.g. `sha256`. */
  algorithm: string;
  /** Whether the digest matched (true when no expected value was supplied). */
  verified: boolean;
}

/**
 * Verify `bytes` against an expected digest, choosing the algorithm from the
 * expected value's length (SHA-256 by default). An empty `expected` reports
 * `verified: true` — "nothing to verify" — matching the caller's behaviour of
 * degrading to unverified rather than failing.
 */
export async function verifyChecksum(
  bytes: Uint8Array,
  expected: string,
): Promise<DigestResult> {
  const want = expected.trim().toLowerCase();
  const algorithm = (want ? CHECKSUM_ALGORITHMS[want.length] : null) ??
    "sha256";
  const webAlgo = webCryptoAlgorithm(want.length) ?? "SHA-256";
  const hex = await digestHex(bytes, webAlgo);
  return { hex, algorithm, verified: !want || hex === want };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Probe whether a directory exists and is writable by creating and removing a
 * temp file inside it. Used to decide whether an install into the directory
 * needs privilege escalation.
 */
export function dirIsWritable(
  dir: string,
  probeName = `.ollama-write-test-${crypto.randomUUID()}`,
): boolean {
  try {
    const stat = Deno.statSync(dir);
    if (!stat.isDirectory) return false;
    const probe = `${dir.replace(/\/+$/, "")}/${probeName}`;
    Deno.writeTextFileSync(probe, "");
    Deno.removeSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** The directory part of a path (no trailing slash), or `.`. */
export function dirnameOf(path: string): string {
  const idx = path.replace(/\/+$/, "").lastIndexOf("/");
  return idx <= 0 ? (idx === 0 ? "/" : ".") : path.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Privilege escalation
// ---------------------------------------------------------------------------

/** How this process can run privileged commands. */
export type PrivilegeMode =
  | "root" // already uid 0
  | "sudo" // `sudo -n` works without a password
  | "sudo-prompt" // sudo exists but needs an interactive password
  | "none"; // no usable escalation

/** The resolved privilege situation for a run, plus copy-paste guidance. */
export interface PrivilegeStatus {
  /** The process uid (0 means root). */
  uid: number;
  /** Whether this user is root. */
  isRoot: boolean;
  /** Whether `sudo` is on `$PATH`. */
  sudoAvailable: boolean;
  /** Whether `sudo -n true` succeeds (passwordless). */
  passwordless: boolean;
  /** The command used to escalate (`sudo`). */
  sudoCommand: string;
  /** Whether the non-interactive flag is configured. */
  nonInteractive: boolean;
  /** The overall mode. */
  mode: PrivilegeMode;
  /** One-line human explanation. */
  message: string;
}

/**
 * Detect whether a privileged action can run without an interactive prompt.
 *
 * Swamp methods have no tty, so `sudo` only works when passwordless
 * (`sudo -n`). This probes once and returns a structured status so a caller can
 * decide between doing the work and handing the user exact commands to run.
 */
export async function detectPrivilege(
  opts: {
    sudoCommand?: string;
    nonInteractive?: boolean;
    runner?: CommandRunner;
    uid?: number;
  } = {},
): Promise<PrivilegeStatus> {
  const runner = opts.runner ?? runCapture;
  const sudoCommand = (opts.sudoCommand ?? "sudo").trim() || "sudo";
  const nonInteractive = opts.nonInteractive ?? true;
  let uid = opts.uid;
  if (uid === undefined) {
    // Probe via `id -u` rather than Deno.uid(), which needs --allow-sys that a
    // model method may not hold. Absent/failed `id` reports -1 (not root).
    const idResult = await runner("id", ["-u"]);
    uid = idResult.code === 0
      ? Number.parseInt(idResult.stdout.trim(), 10)
      : -1;
    if (Number.isNaN(uid)) uid = -1;
  }
  const isRoot = uid === 0;

  if (isRoot) {
    return {
      uid,
      isRoot,
      sudoAvailable: true,
      passwordless: true,
      sudoCommand,
      nonInteractive,
      mode: "root",
      message: "Running as root; privileged steps can run directly.",
    };
  }

  const which = await runner("which", [sudoCommand]);
  const sudoAvailable = which.code === 0;
  if (!sudoAvailable) {
    return {
      uid,
      isRoot,
      sudoAvailable,
      passwordless: false,
      sudoCommand,
      nonInteractive,
      mode: "none",
      message:
        `'${sudoCommand}' is not installed; privileged steps cannot run. ` +
        `Run them yourself with the commands below, or set serviceScope=user.`,
    };
  }

  const probe = await runner(sudoCommand, ["-n", "true"]);
  const passwordless = probe.code === 0;
  return {
    uid,
    isRoot,
    sudoAvailable,
    passwordless,
    sudoCommand,
    nonInteractive,
    mode: passwordless ? "sudo" : "sudo-prompt",
    message: passwordless
      ? `'${sudoCommand} -n' works without a password; privileged steps can run.`
      : `'${sudoCommand}' exists but needs a password, and a swamp run has no tty. ` +
        `Run the printed commands yourself, configure passwordless sudo, or set serviceScope=user.`,
  };
}

/** The escalation argv prefix, or `[]` when the action runs unprivileged. */
export function escalationPrefix(
  status: PrivilegeStatus,
  needsRoot: boolean,
): string[] {
  if (!needsRoot) return [];
  if (status.isRoot) return [];
  if (status.sudoAvailable && status.passwordless) {
    return status.nonInteractive
      ? [status.sudoCommand, "-n"]
      : [status.sudoCommand];
  }
  // No usable escalation; the caller must print manual instructions instead.
  return [];
}

/** Whether a privileged action can run automatically for this status. */
export function canEscalate(
  status: PrivilegeStatus,
  needsRoot: boolean,
): boolean {
  return escalationPrefix(status, needsRoot).length > 0 || !needsRoot ||
    status.isRoot;
}

/**
 * Quote a string for safe inclusion in a copy-paste shell command. Uses
 * single-quote quoting (the one form that never interpolates), escaping any
 * embedded single quote.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A manual step the user must run because swamp cannot escalate. */
export interface ManualCommand {
  /** What the user should run (a single line, copy-pasteable). */
  command: string;
  /** Short explanation of why. */
  reason: string;
}

/**
 * Render the manual commands a user can copy-paste when swamp cannot perform a
 * privileged step itself. Returns the header line plus one line per command, so
 * a method can both log them and store them on a resource.
 */
export function manualInstructions(
  intro: string,
  commands: ManualCommand[],
  outro?: string,
): string[] {
  // No leading indent: the block is meant to be copied verbatim, and a heredoc
  // body indented by even two spaces would land in the written file. Comments
  // and commands are separated by blank lines for readability.
  const lines = [intro];
  for (const { command, reason } of commands) {
    lines.push("");
    lines.push(`# ${reason}`);
    for (const ln of command.split("\n")) lines.push(ln);
  }
  if (outro) {
    lines.push("");
    lines.push(outro);
  }
  return lines;
}

/**
 * A `tee`-heredoc command that writes `content` to a privileged path, quoted so
 * the whole block is safe to paste into a shell. The quoted heredoc (`<<'TAG'`)
 * means nothing inside is expanded, so the unit's `$`/backticks are literal.
 */
export function teeHeredoc(path: string, content: string, tag: string): string {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `sudo tee ${path} >/dev/null <<'${tag}'\n${body}${tag}`;
}

/** The manual sudo command that extracts a verified archive into a root dir. */
export function manualExtractCommand(
  archivePath: string,
  format: OllamaArchiveFormat,
  destRoot: string,
): string {
  const q = shellQuote(archivePath);
  const dest = shellQuote(destRoot);
  if (format === "zip") {
    return `sudo unzip -o ${q} -d ${dest}`;
  }
  if (format === "tar.zst") {
    // Prefer GNU tar's zstd filter; fall back to piping through zstd.
    return `sudo tar --zstd -xf ${q} -C ${dest} || zstd -dc ${q} | sudo tar -xf - -C ${dest}`;
  }
  return `sudo tar -xzf ${q} -C ${dest}`;
}

/**
 * Build the full set of copy-paste commands to install Ollama at system scope
 * when swamp cannot escalate. Includes the user creation, extraction and the
 * systemd unit/enable steps.
 */
export function manualSystemInstallCommands(opts: {
  archivePath: string;
  format: OllamaArchiveFormat;
  installDir: string;
  libDir: string;
  serviceName: string;
  serviceUser: string;
  serviceGroup: string;
  unitPath: string;
  unitContent: string;
  dropInPath?: string;
  dropInContent?: string;
  restart?: boolean;
}): ManualCommand[] {
  const commands: ManualCommand[] = [];
  const root = dirnameOf(opts.installDir.replace(/\/+$/, "")) || "/usr/local";
  commands.push({
    command: `sudo mkdir -p ${opts.installDir} ${opts.libDir}`,
    reason:
      `create the install directories (${opts.installDir}, ${opts.libDir})`,
  });
  commands.push({
    command: manualExtractCommand(opts.archivePath, opts.format, root),
    reason:
      "extract the verified archive's bin/ and lib/ollama/ into the install root",
  });
  if (opts.serviceUser.trim()) {
    commands.push({
      command:
        `id -u ${opts.serviceUser} >/dev/null 2>&1 || sudo useradd -r -s /bin/false -U -m -d /usr/share/${opts.serviceUser} ${opts.serviceUser}`,
      reason: `create the unprivileged '${opts.serviceUser}' run-as user`,
    });
  }
  commands.push({
    command: teeHeredoc(opts.unitPath, opts.unitContent, "OLLAMA_UNIT"),
    reason: `write the systemd unit at ${opts.unitPath}`,
  });
  if (opts.dropInPath && opts.dropInContent) {
    commands.push({
      command: `sudo mkdir -p ${dirnameOf(opts.dropInPath)}`,
      reason: "create the drop-in directory",
    });
    commands.push({
      command: teeHeredoc(opts.dropInPath, opts.dropInContent, "OLLAMA_DROPIN"),
      reason: `write your service settings at ${opts.dropInPath}`,
    });
  }
  commands.push({
    command:
      `sudo systemctl daemon-reload && sudo systemctl enable --now ${opts.serviceName}.service`,
    reason: "reload systemd and start the service at boot",
  });
  if (opts.restart) {
    commands.push({
      command: `sudo systemctl restart ${opts.serviceName}.service`,
      reason: "restart so the running daemon is the new binary/configuration",
    });
  }
  return commands;
}

/**
 * The copy-paste commands to apply a service unit/drop-in and reload/restart
 * when swamp cannot escalate (used by createService/configureService).
 */
export function manualServiceCommands(opts: {
  serviceName: string;
  unitPath: string;
  unitContent: string;
  dropInPath?: string;
  dropInContent?: string;
  serviceUser?: string;
  restart?: boolean;
}): ManualCommand[] {
  const commands: ManualCommand[] = [];
  if (opts.serviceUser && opts.serviceUser.trim()) {
    commands.push({
      command:
        `id -u ${opts.serviceUser} >/dev/null 2>&1 || sudo useradd -r -s /bin/false -U -m -d /usr/share/${opts.serviceUser} ${opts.serviceUser}`,
      reason:
        `create the unprivileged '${opts.serviceUser}' run-as user (if missing)`,
    });
  }
  if (opts.dropInPath && opts.dropInContent) {
    commands.push({
      command: `sudo mkdir -p ${dirnameOf(opts.dropInPath)}`,
      reason: `create the drop-in directory ${dirnameOf(opts.dropInPath)}`,
    });
    commands.push({
      command: teeHeredoc(opts.dropInPath, opts.dropInContent, "OLLAMA_DROPIN"),
      reason: `write your service settings at ${opts.dropInPath}`,
    });
  } else {
    commands.push({
      command: teeHeredoc(opts.unitPath, opts.unitContent, "OLLAMA_UNIT"),
      reason: `write the systemd unit at ${opts.unitPath}`,
    });
  }
  commands.push({
    command:
      `sudo systemctl daemon-reload && sudo systemctl enable --now ${opts.serviceName}.service`,
    reason:
      "reload systemd so the new settings take effect and the service is enabled",
  });
  if (opts.restart) {
    commands.push({
      command: `sudo systemctl restart ${opts.serviceName}.service`,
      reason: "restart the service to pick up the new configuration",
    });
  }
  return commands;
}

/** The copy-paste commands to remove the service and/or binary as root. */
export function manualRemoveCommands(opts: {
  serviceName: string;
  unitPath: string;
  dropInPath?: string;
  installDir?: string;
  libDir?: string;
  purgeService?: boolean;
  purgeBinary?: boolean;
}): ManualCommand[] {
  const commands: ManualCommand[] = [];
  if (opts.purgeService) {
    commands.push({
      command:
        `sudo systemctl stop ${opts.serviceName}.service; sudo systemctl disable ${opts.serviceName}.service`,
      reason: "stop and disable the service",
    });
    commands.push({
      command: `sudo rm -f ${opts.unitPath}${
        opts.dropInPath ? ` ${opts.dropInPath}` : ""
      }`,
      reason: "remove the unit and drop-in files",
    });
    commands.push({
      command: "sudo systemctl daemon-reload",
      reason: "reload systemd after removing the unit",
    });
  }
  if (opts.purgeBinary) {
    commands.push({
      command: `sudo rm -rf ${opts.installDir ?? "/usr/local/bin"}/ollama ${
        opts.libDir ?? "/usr/local/lib/ollama"
      }`,
      reason: "remove the binary and its runtime",
    });
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Archive handling
// ---------------------------------------------------------------------------

/** The archive formats Ollama publishes. */
export const ARCHIVE_FORMATS = ["tar.zst", "tgz", "tar.gz", "zip"] as const;

/** An Ollama archive format. */
export type OllamaArchiveFormat = typeof ARCHIVE_FORMATS[number];

/** Detect the archive format from a file name, or `null` when unrecognised. */
export function detectArchiveFormat(name: string): OllamaArchiveFormat | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith(".tar.zst")) return "tar.zst";
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".tgz")) return "tgz";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

/** One member extracted from an archive, held in memory. */
export interface ArchiveMember {
  /** Path within the archive, normalised to forward slashes, no leading `./`. */
  path: string;
  /** Whether the member is a directory. */
  directory: boolean;
  /** POSIX permission bits (e.g. `0o755`), when the archive records them. */
  mode: number;
  /** The member's bytes (empty for a directory). */
  bytes: Uint8Array;
}

/** Normalise an archive entry path: forward slashes, no leading `./` or `/`. */
export function normalizeMemberPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

/** Parse an uncompressed tar stream into members, held in memory. */
async function readTarMembers(bytes: Uint8Array): Promise<ArchiveMember[]> {
  const members: ArchiveMember[] = [];
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(
    new UntarStream(),
  );
  for await (const entry of stream) {
    const path = normalizeMemberPath(entry.path);
    const header = entry.header as
      | { typeflag?: string; mode?: number }
      | undefined;
    const typeflag = header?.typeflag ?? "";
    const directory = typeflag === "5" || entry.path.endsWith("/");
    const mode = typeof header?.mode === "number" ? header.mode : 0o644;
    if (entry.readable) {
      const data = new Uint8Array(
        await new Response(entry.readable).arrayBuffer(),
      );
      members.push({ path, directory, mode, bytes: data });
    } else {
      members.push({ path, directory: true, mode, bytes: new Uint8Array() });
    }
  }
  return members;
}

/**
 * Extract every member of an archive into memory. Supports `tgz`/`tar.gz`
 * (Deno's gzip decompression) and `zip` (the bundled `fflate`). Pure and
 * network-free, so it is used by the tests. `tar.zst` is deliberately absent:
 * Deno has no zstd decompressor, and the multi-gigabyte Linux release is
 * streamed through the `zstd` CLI by the model's filesystem extractor rather
 * than held in memory.
 */
export async function extractArchive(
  bytes: Uint8Array,
  format: OllamaArchiveFormat,
): Promise<ArchiveMember[]> {
  if (format === "zip") {
    const entries = unzipSync(new Uint8Array(bytes));
    return Object.entries(entries).map(([name, data]) => ({
      path: normalizeMemberPath(name),
      directory: name.endsWith("/"),
      mode: 0o644,
      bytes: data as Uint8Array,
    }));
  }
  if (format === "tar.zst") {
    throw new Error(
      "tar.zst extraction is not available in memory; the model streams it " +
        "through the zstd CLI instead.",
    );
  }
  // tgz / tar.gz
  const decompressed = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const tarBytes = new Uint8Array(
    await new Response(decompressed).arrayBuffer(),
  );
  return await readTarMembers(tarBytes);
}

/**
 * Locate the `ollama` executable within extracted archive members. Ollama's
 * Linux/Windows archives nest it under `bin/`; the macOS archive has it at the
 * root. Returns the member, or `null` when the archive has no binary.
 */
export function findBinaryMember(
  members: ArchiveMember[],
  os: string,
): ArchiveMember | null {
  const exe = isWindowsOs(os) ? "ollama.exe" : "ollama";
  const candidates = [`bin/${exe}`, exe];
  for (const candidate of candidates) {
    const found = members.find((m) => !m.directory && m.path === candidate);
    if (found) return found;
  }
  // Fall back to any member whose basename is the executable.
  return members.find((m) => !m.directory && m.path.split("/").pop() === exe) ??
    null;
}

/** Whether an archive member is part of Ollama's `lib/ollama` runtime tree. */
export function isLibMember(member: ArchiveMember): boolean {
  return member.path === "lib/ollama" || member.path.startsWith("lib/ollama/");
}

/** Whether an OS token names Windows. */
export function isWindowsOs(os: string): boolean {
  const o = os.trim().toLowerCase();
  return o === "windows" || o === "win" || o === "win32" || o === "win64";
}

/** Whether an OS token names macOS. */
export function isDarwinOs(os: string): boolean {
  const o = os.trim().toLowerCase();
  return o === "darwin" || o === "macos" || o === "macosx" || o === "osx" ||
    o === "apple";
}

// ---------------------------------------------------------------------------
// systemd unit rendering
// ---------------------------------------------------------------------------

/** A command runner returning decoded stdout/stderr and the exit code. */
export type CommandRunner = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Run a command, capturing stdout/stderr; a missing binary is code 127. */
export async function runCapture(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const proc = new Deno.Command(bin, {
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

/**
 * Run a command with an explicit child environment (a copy with, e.g.,
 * OLLAMA_HOST scrubbed so `ollama --version` reports the local binary instead
 * of a remote server). A missing binary is code 127.
 */
export async function runCaptureEnv(
  bin: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const proc = new Deno.Command(bin, {
      args,
      env,
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

/**
 * Reject a value that would inject extra unit directives. The unit file is
 * line-oriented: a newline inside an environment line, description or exec
 * argument would start a new directive, so a caller could add `User=root` or
 * any other directive. Reject rather than silently strip.
 */
export function assertNoNewlines(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Invalid ${field}: must not contain newlines (a newline would inject extra systemd unit directives)`,
    );
  }
}

/** Options for {@link renderServiceUnit}. */
export interface ServiceUnitOptions {
  /** Service (unit) name without the `.service` suffix. */
  serviceName: string;
  /** Whether this is a system unit (`User=`/`Group=`) or a user unit. */
  scope: "system" | "user";
  /** Absolute path to the `ollama` binary. */
  binaryPath: string;
  /** Arguments after the binary (default `serve`). */
  execArgs: string;
  /** Run-as user for a system unit (empty omits `User=`). */
  user?: string;
  /** Run-as group for a system unit (empty omits `Group=`). */
  group?: string;
  /** Environment lines as `KEY=VALUE` (rendered `Environment=` each). */
  environment: string[];
  /** `Restart=` policy. */
  restart: string;
  /** `RestartSec=` delay. */
  restartSec: string;
  /** `After=` dependencies. */
  after: string[];
  /** `Wants=` dependencies. */
  wants: string[];
}

/**
 * Render a systemd unit for `ollama serve`.
 *
 * The unit is deliberately minimal and mirrorable: the daemon binary, the
 * run-as user/group (system scope), the environment the operator configured,
 * a restart policy and the install target. Every string field is checked for
 * newlines first, so no value can smuggle in an extra directive.
 */
export function renderServiceUnit(opts: ServiceUnitOptions): string {
  const {
    serviceName,
    scope,
    binaryPath,
    execArgs,
    user,
    group,
    environment,
    restart,
    restartSec,
    after,
    wants,
  } = opts;
  assertNoNewlines("serviceName", serviceName);
  assertNoNewlines("binaryPath", binaryPath);
  assertNoNewlines("execArgs", execArgs);
  if (user) assertNoNewlines("user", user);
  if (group) assertNoNewlines("group", group);
  for (const env of environment) assertNoNewlines("environment", env);
  for (const a of after) assertNoNewlines("after", a);
  for (const w of wants) assertNoNewlines("wants", w);

  const command = execArgs.trim()
    ? `${binaryPath} ${execArgs.trim()}`
    : binaryPath;
  const lines: string[] = [
    `# Managed by @svendowideit/ollama — do not edit by hand.`,
    `[Unit]`,
    `Description=Ollama Service`,
  ];
  for (const a of after) lines.push(`After=${a}`);
  for (const w of wants) lines.push(`Wants=${w}`);
  lines.push(``, `[Service]`, `Type=simple`, `ExecStart=${command}`);
  if (scope === "system" && user) lines.push(`User=${user}`);
  if (scope === "system" && group) lines.push(`Group=${group}`);
  for (const env of environment) lines.push(`Environment=${env}`);
  lines.push(
    `Restart=${restart}`,
    `RestartSec=${restartSec}`,
    `TimeoutStopSec=5`,
    ``,
    `[Install]`,
    `WantedBy=${scope === "system" ? "multi-user.target" : "default.target"}`,
    ``,
  );
  return lines.join("\n");
}

/**
 * Merge the default environment with the operator's configured settings,
 * de-duplicating by key (later wins). `OLLAMA_HOST` is always set first from
 * the `host` value; explicit `environment` entries override it. Returns
 * `KEY=VALUE` strings in a stable order (defaults first, then user entries).
 */
export function buildEnvironment(
  defaults: Record<string, string>,
  entries: string[],
): string[] {
  const merged = new Map<string, string>();
  for (const [k, v] of Object.entries(defaults)) {
    if (k) merged.set(k, `${k}=${v}`);
  }
  for (const raw of entries) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    const key = eq === -1 ? line : line.slice(0, eq);
    merged.set(key, eq === -1 ? line : line);
  }
  return [...merged.values()];
}

/**
 * Parse a raw, newline- or comma-separated block of `KEY=VALUE` environment
 * lines into an array. Blank lines and `#` comments are ignored. Used for the
 * `extraEnvironment` convenience global, so a user can paste several settings.
 */
export function parseEnvironmentBlock(block: string): string[] {
  const out: string[] = [];
  for (const raw of block.split(/[\n,]/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

/**
 * Whether a `systemctl` failure just means the unit was not loaded / found.
 * Used so `stop`/`restart` are idempotent against a never-created service.
 */
export function isUnitNotFound(result: {
  stdout: string;
  stderr: string;
  code: number;
}): boolean {
  if (result.code === 0) return false;
  return /not loaded|not found|could not be found|no such file/i.test(
    `${result.stderr}${result.stdout}`,
  );
}
