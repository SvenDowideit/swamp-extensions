/**
 * Shared helpers for the `@svendowideit/magnitude` extension.
 *
 * Release resolution, asset selection and the checksum-verified download are
 * delegated to `@svendowideit/github-release-install` (called by the bundled
 * `magnitude-install` workflow). Privileged steps are delegated to
 * `@svendowideit/sudo`. This module keeps only what is particular to Magnitude:
 *
 *   - the distro families Magnitude ships a package for (`debian`, `rhel`,
 *     `arch`) and how each maps to a package format, a package manager and an
 *     asset-name token;
 *   - the asset-name pattern used to parse `magnitude-desktop_0.2.9-59_amd64.deb`
 *     and friends;
 *   - the installed layout (`/usr/lib/magnitude-desktop`, `/usr/bin/magnitude`)
 *     and the server artifacts (unit, run-as account, `/var/lib/magnitude`);
 *   - parsing `magnitude --version` output;
 *   - the root-side install script and the `magnitude server setup` script;
 *   - version normalisation and comparison.
 *
 * Everything here is either pure or a single-purpose filesystem/command call,
 * so it can be unit tested in isolation.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/** Runs a command, capturing stdout/stderr; a missing binary reports code 127. */
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
    // This extension's whole job is to drive host tools (uname, systemctl,
    // the distro package manager) and the `magnitude` CLI, which no swamp
    // primitive wraps; every argument is a fixed token or a validated path.
    // swamp-quality-ignore deno-command
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

// ---------------------------------------------------------------------------
// Platform / distro
// ---------------------------------------------------------------------------

/** The distro families Magnitude publishes a desktop package for. */
export const DISTRO_FAMILIES = ["debian", "rhel", "arch"] as const;

/** A distro family Magnitude publishes a package for. */
export type DistroFamily = typeof DISTRO_FAMILIES[number];

/** The package manager used to install that family's package. */
export type PackageManager = "apt" | "dnf" | "pacman";

/** The Magnitude release asset token for a family (also the `os` filter). */
export type PackageFormat = "deb" | "rpm" | "pkg.tar.zst";

/** The parsed fields of `/etc/os-release` this extension cares about. */
export interface OsRelease {
  /** `ID` (e.g. `ubuntu`). */
  id: string;
  /** `ID_LIKE` (e.g. `debian`). */
  idLike: string;
  /** `VERSION_ID` (e.g. `24.04`). */
  versionId: string;
  /** `PRETTY_NAME`. */
  prettyName: string;
}

/**
 * Parse the key fields of `/etc/os-release`. Values may be quoted; unknown keys
 * are ignored. Never throws — a malformed file yields empty fields.
 */
export function parseOsRelease(text: string): OsRelease {
  const out: OsRelease = { id: "", idLike: "", versionId: "", prettyName: "" };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case "ID":
        out.id = value.toLowerCase();
        break;
      case "ID_LIKE":
        out.idLike = value.toLowerCase();
        break;
      case "VERSION_ID":
        out.versionId = value;
        break;
      case "PRETTY_NAME":
        out.prettyName = value;
        break;
    }
  }
  return out;
}

/**
 * Map an `/etc/os-release` to the package family Magnitude publishes for it.
 *
 * `ID` wins; `ID_LIKE` is the fallback (so derivatives such as Linux Mint,
 * Pop!\_OS, Rocky or Manjaro resolve through their upstream). Returns
 * `unknown` when neither names a supported family.
 */
export function detectDistroFamily(
  osRelease: OsRelease | string,
): DistroFamily | "unknown" {
  const rel = typeof osRelease === "string"
    ? parseOsRelease(osRelease)
    : osRelease;
  const tokens = `${rel.id} ${rel.idLike}`.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    switch (token) {
      case "debian":
      case "ubuntu":
      case "linuxmint":
      case "pop":
      case "raspbian":
        return "debian";
      case "rhel":
      case "fedora":
      case "centos":
      case "rocky":
      case "almalinux":
      case "amzn":
      case "ol":
        return "rhel";
      case "arch":
      case "manjaro":
      case "endeavouros":
      case "cachyos":
        return "arch";
    }
  }
  return "unknown";
}

/** The package manager that installs this family's native package. */
export function packageManagerFor(family: DistroFamily): PackageManager {
  switch (family) {
    case "debian":
      return "apt";
    case "rhel":
      return "dnf";
    case "arch":
      return "pacman";
  }
}

/**
 * The release-asset token for the family's package format. Magnitude names its
 * assets by the *distribution* package, not by OS, so the extension uses the
 * format token as the `os` discriminant when asking github-release-install to
 * select the asset.
 */
export function packageFormatFor(family: DistroFamily): PackageFormat {
  switch (family) {
    case "debian":
      return "deb";
    case "rhel":
      return "rpm";
    case "arch":
      return "pkg.tar.zst";
  }
}

/** The `uname -m` architecture families Magnitude publishes for. */
export const ARCH_TOKENS = ["x64", "arm64", "unknown"] as const;

/** The detected architecture family Magnitude cares about. */
export type ArchFamily = typeof ARCH_TOKENS[number];

/** Map `uname -m` (or an override) to a Magnitude architecture family. */
export function normalizeArch(uname: string): ArchFamily {
  const t = uname.trim().toLowerCase();
  if (t === "x86_64" || t === "amd64" || t === "x64") return "x64";
  if (t === "aarch64" || t === "arm64" || t === "armv8") return "arm64";
  return "unknown";
}

/** Whether the family has a package for this architecture. */
export function archSupported(family: DistroFamily, arch: ArchFamily): boolean {
  if (arch === "unknown") return false;
  // Magnitude publishes no pacman build for arm64.
  if (family === "arch" && arch === "arm64") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Asset names
// ---------------------------------------------------------------------------

/** The product stem every Magnitude desktop package shares. */
export const ASSET_STEM = "magnitude-desktop";

/**
 * The asset-name pattern handed to `@svendowideit/github-release-install`.
 *
 * Named groups it relies on: `stem` (the product), `version` (e.g. `0.2.9-59`),
 * `arch` (`amd64`/`arm64`/`x86_64`/`aarch64`) and `os` — the package-format
 * discriminant (`deb`/`rpm`/`pkg.tar.zst`), because Magnitude's asset names
 * carry a distro package rather than an OS token. macOS/Windows desktop
 * assets (`…darwin…dmg`, `…windows…exe`) and the release manifest JSON
 * deliberately do not match.
 */
export const MAGNITUDE_PACKAGE_PATTERN: string =
  "^(?<stem>magnitude-desktop)[-_](?<version>v?[0-9][0-9A-Za-z.+-]*?)[-_.]" +
  "(?<arch>x86_64|aarch64|amd64|arm64)\\.(?<os>deb|rpm|pkg\\.tar\\.zst)$";

/** The version-and-revision portion of a package name, e.g. `0.2.9-59`. */
export function packageVersionFromName(name: string): string | null {
  const match = new RegExp(MAGNITUDE_PACKAGE_PATTERN).exec(name.trim());
  return match?.groups?.version ?? null;
}

/**
 * The bare release version from a package version string: `0.2.9-59` → `0.2.9`.
 * The trailing `-<revision>` is the ACN build number, not part of the release
 * version `magnitude --version` prints.
 */
export function releaseVersion(packageVersion: string): string {
  const trimmed = packageVersion.trim();
  const dash = trimmed.indexOf("-");
  return dash > 0 ? trimmed.slice(0, dash) : trimmed;
}

/** The ACN build revision from a package version string, or `null`. */
export function packageRevision(packageVersion: string): string | null {
  const trimmed = packageVersion.trim();
  const dash = trimmed.indexOf("-");
  return dash > 0 ? trimmed.slice(dash + 1) : null;
}

/** The release tag Magnitude uses: `@magnitudedev/cli@0.2.9`. */
export function releaseTagFor(version: string): string {
  return `@magnitudedev/cli@${normalizeVersion(version)}`;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Strip a leading `v` and surrounding whitespace. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Compare two dotted numeric versions: `<0`, `0` or `>0`. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.+-]/).map((s) =>
    Number.parseInt(s, 10)
  );
  const pb = normalizeVersion(b).split(/[.+-]/).map((s) =>
    Number.parseInt(s, 10)
  );
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.isNaN(pa[i]) ? 0 : pa[i];
    const nb = Number.isNaN(pb[i]) ? 0 : pb[i];
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/** Whether two versions are equal after normalising a leading `v`. */
export function versionsEqual(a: string, b: string): boolean {
  return compareVersions(a, b) === 0;
}

/**
 * Parse a version out of `magnitude --version` output. The CLI prints the bare
 * version (e.g. `0.2.9`); tolerate a `magnitude ` prefix and a leading `v`.
 */
export function parseVersionOutput(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  const match = text.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` against `$HOME` (or the provided home). */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** The parent directory of a path, without a trailing slash. */
export function dirnameOf(path: string): string {
  const idx = path.replace(/\/+$/, "").lastIndexOf("/");
  let parent: string;
  if (idx < 0) parent = ".";
  else if (idx === 0) parent = "/";
  else parent = path.slice(0, idx);
  return parent;
}

/**
 * Whether a directory exists and is writable, probed by creating and removing a
 * temp file inside it (missing is false).
 */
export function dirIsWritable(
  dir: string,
  probeName = `.magnitude-write-test-${crypto.randomUUID()}`,
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

/** Reject a path that is not absolute (`/…`) or `~`-prefixed. */
export function assertAbsoluteDir(dir: string, field: string): void {
  const trimmed = dir.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) {
    throw new Error(
      `${field} must be absolute or ~-prefixed, got '${dir}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// Privilege escalation
// ---------------------------------------------------------------------------

/** How this process can run privileged commands. */
export type PrivilegeMode =
  | "root"
  | "sudo"
  | "sudo-prompt"
  | "none";

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
 * Swamp methods have no tty, so `sudo` only works passwordless (`sudo -n`).
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
        `Install Magnitude by hand with the commands below.`,
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
        `Run the printed commands yourself or configure passwordless sudo.`,
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
    return status.nonInteractive ? [status.sudoCommand, "-n"] : [
      status.sudoCommand,
    ];
  }
  return [];
}

/** Whether a privileged action can run automatically for this status. */
export function canEscalate(
  status: PrivilegeStatus,
  needsRoot: boolean,
): boolean {
  return !needsRoot || status.isRoot ||
    escalationPrefix(status, needsRoot).length > 0;
}

/** Quote a string for a copy-paste shell command (single-quote form). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A manual step the user must run because swamp cannot escalate. */
export interface ManualCommand {
  command: string;
  reason: string;
}

/**
 * Render copy-pasteable manual commands, so a caller can both log them and
 * store them on a resource. No leading indent: the block is meant to be
 * pasted verbatim.
 */
export function manualInstructions(
  intro: string,
  commands: ManualCommand[],
  outro?: string,
): string[] {
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

// ---------------------------------------------------------------------------
// Magnitude layout
// ---------------------------------------------------------------------------

/** The distro package name (all three formats share it). */
export const PACKAGE_NAME = "magnitude-desktop";

/** Root directory the package installs its resources into. */
export const INSTALL_ROOT = "/usr/lib/magnitude-desktop";

/** The CLI entry point the package puts on `$PATH`. */
export const BINARY_PATH = "/usr/bin/magnitude";

/** The systemd unit the package ships (inert until `server setup`). */
export const SERVICE_NAME = "magnitude";

/** The unprivileged system account the server runs as. */
export const SERVICE_USER = "magnitude";

/** The server's settings, models and logs directory. */
export const CONFIG_DIR = "/var/lib/magnitude";

/** The server's settings file. */
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

/** The server's systemd unit path. */
export const UNIT_PATH = `/usr/lib/systemd/system/${SERVICE_NAME}.service`;

/** Candidate paths for a `magnitude` binary, in priority order. */
export function searchPaths(home?: string): string[] {
  const h = home ?? Deno.env.get("HOME") ?? "";
  return [
    "magnitude",
    BINARY_PATH,
    `${INSTALL_ROOT}/resources/magnitude`,
    `${h}/.local/bin/magnitude`,
    "/usr/local/bin/magnitude",
  ];
}

// ---------------------------------------------------------------------------
// Root-side scripts
// ---------------------------------------------------------------------------

/**
 * The distro package-manager argv that installs a local package file. The
 * caller runs it as root (through the elevation ladder).
 */
export function packageInstallArgv(
  manager: PackageManager,
  packagePath: string,
): string[] {
  switch (manager) {
    case "apt":
      return ["apt-get", "install", "-y", packagePath];
    case "dnf":
      return ["dnf", "install", "-y", packagePath];
    case "pacman":
      return ["pacman", "-U", "--noconfirm", packagePath];
  }
}

/** Quote one argv element for a POSIX `sh` script. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A POSIX `sh` script that installs a local Magnitude package through the
 * family's package manager. Written to the staging directory and run as root
 * via `@svendowideit/sudo`'s `runScript` operation.
 *
 * The script is idempotent at the package-manager level: installing an already
 * installed version is a no-op, and upgrading is an in-place replace.
 */
export function renderInstallScript(opts: {
  manager: PackageManager;
  packagePath: string;
}): string {
  const argv = packageInstallArgv(opts.manager, opts.packagePath);
  const line = argv.map(shArg).join(" ");
  return [
    "#!/bin/sh",
    "set -eu",
    "# Installs the downloaded Magnitude package. Run as root.",
    `${line}`,
    "",
  ].join("\n");
}

/**
 * A POSIX `sh` script that registers and starts the Magnitude server
 * **non-interactively**, performing exactly the root-side work `magnitude
 * server setup` does (Magnitude's own command insists on running as you, with
 * an interactive password prompt, which a swamp run has no tty for): it creates
 * the `magnitude` system group and account (home `configDir`, no login shell),
 * prepares the data directory, writes the `/etc/magnitude/server` marker and
 * enables the shipped `magnitude.service`. Written to the staging directory and
 * run as root through the elevation ladder.
 */
export function renderServerSetupScript(opts: {
  serviceName: string;
  serviceUser: string;
  configDir: string;
  /** Rendered settings document to install (owned by the service account). */
  configStagedPath?: string | null;
}): string {
  const user = opts.serviceUser;
  const dir = opts.configDir;
  const unit = opts.serviceName;
  const nologin = "/usr/sbin/nologin";
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "# Register and start the Magnitude server the way Magnitude's own",
    "# installer does, but non-interactively as root. Idempotent.",
    `getent group ${user} >/dev/null 2>&1 || groupadd --system ${user}`,
    `id -u ${user} >/dev/null 2>&1 || useradd --system --gid ${user}` +
    ` --home-dir ${dir} --no-create-home --shell ${nologin}` +
    ` --comment "Magnitude server" ${user}`,
    `install -d -m 0750 -o ${user} -g ${user} ${dir}`,
    `install -d -m 0755 /etc/magnitude`,
    `printf '%s\\n' 'Magnitude runs as the system service on this machine. Remove it with the swamp magnitude extension.' > /etc/magnitude/server`,
  ];
  if (opts.configStagedPath) {
    // Install the settings owned by the service account (which alone may read
    // them) and restart only when they actually changed.
    lines.push(
      "changed=0",
      `if [ -f ${shArg(opts.configStagedPath)} ]; then`,
      `  if ! cmp -s ${shArg(opts.configStagedPath)} ${dir}/config.json; then`,
      `    install -D -m 0600 -o ${user} -g ${user} ${
        shArg(opts.configStagedPath)
      } ${dir}/config.json`,
      "    changed=1",
      "  fi",
      "fi",
    );
  }
  lines.push(
    "systemctl daemon-reload || true",
    `systemctl enable --now ${unit}.service`,
  );
  if (opts.configStagedPath) {
    lines.push(
      `[ "\${changed:-0}" = "1" ] && systemctl restart ${unit}.service || true`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * A POSIX `sh` script that stops and removes the Magnitude service, keeping the
 * models and settings in `/var/lib/magnitude`. Run as root.
 */
export function renderServerRemoveScript(opts: {
  serviceName: string;
  configDir: string;
}): string {
  const unit = opts.serviceName;
  return [
    "#!/bin/sh",
    "set -eu",
    "# Stop and remove the Magnitude boot service; data under configDir is kept.",
    `systemctl disable --now ${unit}.service 2>/dev/null || true`,
    "rm -f /etc/magnitude/server",
    "rmdir /etc/magnitude 2>/dev/null || true",
    "systemctl daemon-reload || true",
    "",
  ].join("\n");
}

/**
 * The server settings document. `network.enabled` turns on the LAN/remote
 * API, `network.bind` is the interface address to listen on (absent means all
 * interfaces) and `network.apiKey` is the bearer the clients present. Only keys
 * the caller set are emitted, so an existing `config.json` can be minimally
 * updated. Magnitude always serves on port 10100; there is no port key.
 */
export function renderServerConfig(opts: {
  networkEnabled?: boolean;
  apiKey?: string;
  bind?: string;
}): string {
  const network: Record<string, unknown> = {};
  if (opts.networkEnabled !== undefined) network.enabled = opts.networkEnabled;
  if (opts.apiKey) network.apiKey = opts.apiKey;
  if (opts.bind) network.bind = opts.bind;
  const doc: Record<string, unknown> = {};
  if (Object.keys(network).length > 0) doc.network = network;
  return `${JSON.stringify(doc, null, 2)}\n`;
}
