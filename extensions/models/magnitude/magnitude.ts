/**
 * Magnitude install and server management for a Linux machine with systemd.
 *
 * `@svendowideit/magnitude` closes the whole loop around a Magnitude
 * (https://magnitude.dev) install on the machine it runs on: it knows which
 * version is installed, resolves the newest release (delegated to
 * `@svendowideit/github-release-install`), installs or upgrades the right
 * distro package for this distribution/architecture (Debian, RPM and Arch
 * packages), and registers/turns on the Magnitude *server* — the boot service
 * that serves models over the network — through the `@svendowideit/sudo`
 * elevation ladder. Server settings (network access, API key, bind address)
 * are configuration, written to `/var/lib/magnitude/config.json`.
 *
 * Methods:
 *   - `plan`        — resolve this machine's distro family/architecture, the
 *                     package format and manager, the release asset filter and
 *                     the install/service paths; the bundled workflow feeds
 *                     these to the fetch and privileged steps.
 *   - `privilege`   — report how this run can escalate to root.
 *   - `sync`        — locate `magnitude`, run `magnitude --version`, record the
 *                     installed version and path.
 *   - `assess`      — compare the installed version with the resolved release
 *                     and record whether an update is available.
 *   - `stage`       — verify the downloaded package's SHA-256 and render the
 *                     root-side scripts (install, server setup, server remove,
 *                     settings) into an unprivileged staging directory.
 *   - `install`     — install/upgrade the staged package (direct method path;
 *                     the workflow uses the sudo ladder instead).
 *   - `serverSetup` — run `magnitude server setup` as root: create the
 *                     `magnitude` account, enable the unit and network access.
 *   - `configure`   — write `/var/lib/magnitude/config.json` and restart.
 *   - `service`     — report the systemd unit's active/enabled state.
 *   - `uninstall`   — stop/disable the service and (optionally) remove the
 *                     package, keeping or purging its data.
 *   - `print`       — log the stored installed/service summary.
 *
 * Release resolution and the checksum-verified download are delegated to
 * `@svendowideit/github-release-install`; every privileged step is delegated to
 * `@svendowideit/sudo`'s named operations. Linux only: on macOS/Windows
 * Magnitude ships an app, not a distro package, and this extension does not
 * manage it.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  type ArchFamily,
  archSupported,
  assertAbsoluteDir,
  BINARY_PATH,
  canEscalate,
  type CommandRunner,
  compareVersions,
  CONFIG_DIR,
  detectDistroFamily,
  detectPrivilege,
  dirnameOf,
  DISTRO_FAMILIES,
  type DistroFamily,
  escalationPrefix,
  expandHome,
  INSTALL_ROOT,
  MAGNITUDE_PACKAGE_PATTERN,
  type ManualCommand,
  manualInstructions,
  normalizeArch,
  normalizeVersion,
  PACKAGE_NAME,
  packageFormatFor,
  type PackageManager,
  packageManagerFor,
  parseOsRelease,
  parseVersionOutput,
  type PrivilegeStatus,
  releaseVersion,
  renderInstallScript,
  renderServerConfig,
  renderServerRemoveScript,
  renderServerSetupScript,
  runCapture,
  SERVICE_NAME,
  SERVICE_USER,
  shellQuote,
  UNIT_PATH,
} from "./magnitude_shared.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ManageServiceSchema = z.enum(["auto", "true", "false"]).default("auto")
  .describe(
    "auto (default): set up and maintain the Magnitude server service when a " +
      "package is present, else install only. true: always run `magnitude " +
      "server setup`. false: never touch the service.",
  );

const GlobalArgsSchema = z.object({
  distro: z.string().default("").describe(
    "Override the detected distribution family (debian, rhel, arch). Empty " +
      "probes /etc/os-release.",
  ),
  arch: z.string().default("").describe(
    "Override the detected architecture token (x86_64, arm64). Empty probes " +
      "`uname -m`.",
  ),
  repo: z.string().default("magnitudedev/magnitude").describe(
    "GitHub repository publishing the Magnitude releases.",
  ),
  version: z.string().default("").describe(
    "Release to install (e.g. 0.2.9). Empty installs the latest. Pinning is " +
      "best-effort: Magnitude tags releases as `@magnitudedev/cli@<version>`, " +
      "which the release resolver may not resolve by bare version.",
  ),
  assetPattern: z.string().default(MAGNITUDE_PACKAGE_PATTERN).describe(
    "Asset-name pattern passed to @svendowideit/github-release-install.",
  ),
  githubToken: z.string().default("").meta({ sensitive: true }).describe(
    "GitHub token to raise the releases API rate limit. Empty falls back to " +
      "GITHUB_TOKEN / GH_TOKEN, then the authenticated `gh` CLI.",
  ),
  downloadDir: z.string().default("~/.cache/magnitude").describe(
    "Directory the verified release package is downloaded into.",
  ),
  stagingDir: z.string().default("~/.cache/magnitude/staging").describe(
    "Unprivileged directory the root-side scripts are rendered into.",
  ),
  packageName: z.string().default(PACKAGE_NAME).describe(
    "Distro package name (used for removal).",
  ),
  serviceName: z.string().default(SERVICE_NAME).describe(
    "systemd service name (without the .service suffix).",
  ),
  serviceUser: z.string().default(SERVICE_USER).describe(
    "Run-as user for the server service (created by `magnitude server setup`).",
  ),
  configDir: z.string().default(CONFIG_DIR).describe(
    "Directory holding the server's settings, models and logs.",
  ),
  manageService: ManageServiceSchema,
  networkEnabled: z.boolean().default(false).describe(
    "Turn on the server's network (LAN/remote) API in config.json.",
  ),
  networkApiKey: z.string().default("").meta({ sensitive: true }).describe(
    "Bearer key the network API requires. Empty leaves any existing key " +
      "untouched; it is written only to /var/lib/magnitude/config.json.",
  ),
  networkHost: z.string().default("").describe(
    "Interface address the network API binds (network.bind, one IP of this " +
      "machine). Empty binds all interfaces. Magnitude always serves on 10100.",
  ),
  sudoInstanceKey: z.string().default("default").describe(
    "Instance key of the @svendowideit/sudo model the workflow elevates " +
      "through (model name sudo-<instanceKey>).",
  ),
  sudoAllowedOperations: z.array(z.string()).default([
    "installPackage",
    "removePackage",
    "manageService",
    "runScript",
    "installFile",
    "ensureDirectory",
    "daemonReload",
    "removePath",
    "createUser",
  ]).describe(
    "Operation allowlist passed to the sudo model for each privileged step.",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even when the target version is already installed, and re-run " +
      "the setup/configuration steps even when they already match.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PlanArgsSchema = z.object({
  distro: z.string().optional(),
  arch: z.string().optional(),
});

const SyncArgsSchema = z.object({
  path: z.string().optional().describe(
    "Override the binary path for this call.",
  ),
  repo: z.string().default("").describe(
    "GitHub repository to read the latest release version from when " +
      "checkLatest is true. Empty uses the model's `repo`.",
  ),
  githubToken: z.string().default("").meta({ sensitive: true }).describe(
    "GitHub token for the optional latest-release check.",
  ),
  checkLatest: z.boolean().default(true).describe(
    "Also resolve the latest release version (one GitHub API request).",
  ),
});

const AssessArgsSchema = z.object({
  latestVersion: z.string().min(1).describe(
    "The release version resolved by the release step (a tag such as " +
      "`@magnitudedev/cli@0.2.9` or a package version such as `0.2.9-59`).",
  ),
  force: z.boolean().default(false).describe(
    "Report an update as available regardless of the installed version.",
  ),
});

const StageArgsSchema = z.object({
  packagePath: z.string().default("").describe(
    "Path to the downloaded, checksum-verified package (from the release " +
      "workflow's download step). Empty renders only the server scripts (used " +
      "to reconcile the service when the package is already current).",
  ),
  packageName: z.string().default("").describe(
    "Override the package file name for this call.",
  ),
  checksum: z.string().default("").describe(
    "Expected SHA-256; when set the staged package is re-verified.",
  ),
  manager: z.enum(["apt", "dnf", "pacman"]).optional().describe(
    "Override the package manager for this call.",
  ),
});

const InstallArgsSchema = z.object({
  packagePath: z.string().default("").describe(
    "Package to install. Empty reuses the staged package from the `stage` " +
      "resource.",
  ),
  manager: z.enum(["apt", "dnf", "pacman"]).optional(),
  force: z.boolean().default(false),
});

const SetupArgsSchema = z.object({
  binaryPath: z.string().default("").describe(
    "Override the `magnitude` binary path for this call.",
  ),
  force: z.boolean().default(false),
});

const ConfigureArgsSchema = z.object({
  networkEnabled: z.boolean().optional(),
  networkApiKey: z.string().optional().meta({ sensitive: true }),
  networkHost: z.string().optional(),
  restart: z.boolean().default(true).describe(
    "Restart the service after writing the settings.",
  ),
});

const UninstallArgsSchema = z.object({
  removePackage: z.boolean().default(true).describe(
    "Also remove the distro package (not just the service).",
  ),
  purgeData: z.boolean().default(false).describe(
    "Delete /var/lib/magnitude (models and settings) as well.",
  ),
});

const SetupConfigArgsSchema = z.object({
  networkEnabled: z.boolean().optional().describe(
    "Supplied network-API toggle; merged over any detected or previously saved value.",
  ),
  networkApiKey: z.string().optional().meta({ sensitive: true }).describe(
    "Supplied network-API key; the key itself is never persisted to swamp data.",
  ),
  networkHost: z.string().optional(),
  binaryPath: z.string().default("").describe(
    "Override the `magnitude` binary path for this call.",
  ),
});

const SetupResultSchema = z.object({
  detected: z.object({
    configExists: z.boolean(),
    networkEnabled: z.boolean().nullable(),
    networkHost: z.string().nullable(),
    hasApiKey: z.boolean(),
  }),
  effective: z.object({
    networkEnabled: z.boolean(),
    networkApiKeyRef: z.string().nullable(),
    networkHost: z.string(),
  }),
  installed: z.boolean(),
  binaryPath: z.string().nullable(),
  configPath: z.string(),
  capabilities: z.array(z.string()),
  message: z.string(),
  setupAt: z.string(),
});

// Result schemas -----------------------------------------------------------

const PrivilegeResultSchema = z.object({
  mode: z.enum(["root", "sudo", "sudo-prompt", "none"]),
  isRoot: z.boolean(),
  sudoAvailable: z.boolean(),
  passwordless: z.boolean(),
  message: z.string(),
  checkedAt: z.string(),
});

const PlanResultSchema = z.object({
  family: z.string(),
  arch: z.string(),
  osRelease: z.object({
    id: z.string(),
    idLike: z.string(),
    versionId: z.string(),
    prettyName: z.string(),
  }),
  format: z.string().nullable(),
  manager: z.enum(["apt", "dnf", "pacman"]).nullable(),
  assetPattern: z.string(),
  assetStem: z.string(),
  /** Value passed as the release `os` filter (the package-format token). */
  osFilter: z.string().nullable(),
  archFilter: z.string().nullable(),
  packageName: z.string(),
  installRoot: z.string(),
  binaryPath: z.string(),
  configDir: z.string(),
  configPath: z.string(),
  unitPath: z.string(),
  serviceName: z.string(),
  serviceUser: z.string(),
  manageService: z.boolean(),
  supported: z.boolean(),
  requiresRoot: z.boolean(),
  manualCommands: z.array(z.string()),
  plannedAt: z.string(),
  message: z.string(),
});

const InstalledResultSchema = z.object({
  present: z.boolean(),
  version: z.string().nullable(),
  releaseVersion: z.string().nullable(),
  path: z.string().nullable(),
  latestVersion: z.string().nullable(),
  latestTag: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
  rawOutput: z.string().nullable(),
  error: z.string().nullable(),
  syncedAt: z.string(),
  message: z.string(),
});

const AssessmentResultSchema = z.object({
  installedVersion: z.string().nullable(),
  latestVersion: z.string(),
  latestPackageVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  upToDate: z.boolean(),
  message: z.string(),
  assessedAt: z.string(),
});

const StageResultSchema = z.object({
  staged: z.boolean(),
  packagePath: z.string(),
  packageName: z.string(),
  checksum: z.string().nullable(),
  checksumVerified: z.boolean().nullable(),
  sha256: z.string().nullable(),
  manager: z.enum(["apt", "dnf", "pacman"]),
  stagingDir: z.string(),
  installScriptPath: z.string(),
  stagedAt: z.string(),
  message: z.string(),
});

const ScriptsResultSchema = z.object({
  stagingDir: z.string(),
  setupScriptPath: z.string(),
  removeScriptPath: z.string(),
  serverConfigPath: z.string().nullable(),
  renderedAt: z.string(),
  message: z.string(),
});

const InstallResultSchema = z.object({
  installed: z.boolean(),
  packagePath: z.string().nullable(),
  manager: z.enum(["apt", "dnf", "pacman"]).nullable(),
  exitCode: z.number().nullable(),
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  message: z.string(),
  installedAt: z.string(),
});

const ServerResultSchema = z.object({
  ran: z.boolean(),
  binaryPath: z.string().nullable(),
  exitCode: z.number().nullable(),
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  configPath: z.string(),
  unitPath: z.string(),
  networkHint: z.string().nullable(),
  message: z.string(),
  configuredAt: z.string(),
});

const ConfigResultSchema = z.object({
  written: z.boolean(),
  configPath: z.string(),
  document: z.string(),
  restarted: z.boolean(),
  exitCode: z.number().nullable(),
  message: z.string(),
  configuredAt: z.string(),
});

const ServiceResultSchema = z.object({
  unit: z.string(),
  active: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
  state: z.string(),
  enabledState: z.string(),
  statusCommand: z.string(),
  checkedAt: z.string(),
  message: z.string(),
});

const UninstallResultSchema = z.object({
  serviceRemoved: z.boolean(),
  packageRemoved: z.boolean(),
  dataPurged: z.boolean(),
  exitCode: z.number().nullable(),
  message: z.string(),
  uninstalledAt: z.string(),
});

const PrintResultSchema = z.object({
  printed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  serviceActive: z.boolean().nullable(),
  serviceEnabled: z.boolean().nullable(),
  lines: z.array(z.string()),
  printedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Method context and small helpers
// ---------------------------------------------------------------------------

type Logger = {
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn?: (message: string, properties?: Record<string, unknown>) => void;
  debug?: (message: string, properties?: Record<string, unknown>) => void;
};

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
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
};

type Runner = CommandRunner;

/** Read `/etc/os-release`, or an empty string when it is unreadable. */
async function readOsReleaseText(): Promise<string> {
  for (const path of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      return await Deno.readTextFile(path);
    } catch {
      // try the next candidate
    }
  }
  return "";
}

/** Whether a single path exists and is a file. */
async function existingFile(path: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile ? path : null;
  } catch {
    return null;
  }
}

async function which(binary: string): Promise<string | null> {
  const result = await runCapture("which", [binary]);
  return result.code === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : null;
}

/**
 * Locate a runnable `magnitude` binary. An explicit `path` is authoritative;
 * otherwise the known install locations and `$PATH` are probed in order.
 */
async function findBinary(
  explicit: string,
  home?: string,
): Promise<string | null> {
  const wanted = explicit.trim();
  if (wanted) {
    const candidate = expandHome(wanted, home);
    if (/\//.test(candidate)) return await existingFile(candidate);
    return await which(candidate);
  }
  const h = home ?? Deno.env.get("HOME") ?? "";
  const candidates = [
    BINARY_PATH,
    `${INSTALL_ROOT}/resources/magnitude`,
    "/usr/local/bin/magnitude",
    `${h}/.local/bin/magnitude`,
  ];
  for (const candidate of candidates) {
    const found = await existingFile(candidate);
    if (found) return found;
  }
  return await which("magnitude");
}

/** Read and normalise `magnitude --version`. */
async function readLocalVersion(
  path: string,
  runner: Runner,
): Promise<{ version: string | null; raw: string; error: string | null }> {
  const result = await runner(path, ["--version"]);
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    return { version: null, raw, error: raw || `exit ${result.code}` };
  }
  const version = parseVersionOutput(result.stdout) ??
    parseVersionOutput(result.stderr);
  return { version, raw, error: version ? null : "no version in output" };
}

/**
 * Normalise a release identifier to a bare dotted version. Accepts the release
 * tag (`@magnitudedev/cli@0.2.9`), a package version (`0.2.9-59`) or a plain
 * version (`0.2.9`).
 */
export function resolveReleaseVersion(value: string): string {
  let v = value.trim();
  const at = v.lastIndexOf("@");
  if (at >= 0) v = v.slice(at + 1);
  return releaseVersion(normalizeVersion(v));
}

/**
 * Stream a file through SHA-256 and return the lowercase hex digest, so a
 * multi-hundred-megabyte package is never read whole into memory.
 */
export async function sha256File(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(1024 * 1024);
  try {
    for (;;) {
      const n = await file.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
  } finally {
    file.close();
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", all);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Write a file, creating its parent directory; returns the absolute path. */
async function writeFileEnsuringDir(
  path: string,
  content: string,
  mode?: number,
): Promise<string> {
  const dir = dirnameOf(path);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
  if (mode !== undefined) {
    try {
      await Deno.chmod(path, mode);
    } catch {
      // best effort (Windows); scripts are staged on Linux servers
    }
  }
  return path;
}

/** Resolve the family and arch for a run, honouring explicit overrides. */
async function resolveFamilyArch(
  distroOverride: string,
  archOverride: string,
  runner: Runner,
): Promise<
  {
    family: DistroFamily | "unknown";
    arch: ArchFamily;
    osRelease: ReturnType<typeof parseOsRelease>;
  }
> {
  const osReleaseText = await readOsReleaseText();
  const osRelease = parseOsRelease(osReleaseText);
  let family: DistroFamily | "unknown";
  const override = distroOverride.trim().toLowerCase();
  if (override) {
    family = (DISTRO_FAMILIES as readonly string[]).includes(override)
      ? (override as DistroFamily)
      : "unknown";
  } else {
    family = detectDistroFamily(osRelease);
  }
  let arch: ArchFamily;
  const archOverrideTrimmed = archOverride.trim();
  if (archOverrideTrimmed) {
    arch = normalizeArch(archOverrideTrimmed);
  } else {
    const uname = await runner("uname", ["-m"]);
    arch = normalizeArch(uname.code === 0 ? uname.stdout : "");
  }
  return { family, arch, osRelease };
}

/** The manual commands a user can run when swamp cannot escalate. */
function manualInstallCommands(
  family: string,
  packagePath: string,
): ManualCommand[] {
  const manager = family === "debian"
    ? "apt-get install -y"
    : family === "rhel"
    ? "dnf install -y"
    : "pacman -U --noconfirm";
  return [
    {
      command: `sudo ${manager} ${shellQuote(packagePath)}`,
      reason: "install the downloaded Magnitude package by hand",
    },
    {
      command: "sudo /usr/bin/magnitude server setup",
      reason: "register and start the Magnitude server service",
    },
  ];
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Installs and manages Magnitude and its server on this machine. */
export const model = {
  type: "@svendowideit/magnitude",
  version: "2026.10.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    platform: {
      description:
        "The resolved distro family/architecture, package format, manager and paths",
      schema: PlanResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    privilege: {
      description:
        "How this run can escalate to root (root/passwordless-sudo/sudo-prompt/none)",
      schema: PrivilegeResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    installed: {
      description: "The installed Magnitude version and resolved path",
      schema: InstalledResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    assessment: {
      description:
        "Whether an update is available (installed vs resolved release version)",
      schema: AssessmentResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    stage: {
      description:
        "The verified package and its install script awaiting privileged execution",
      schema: StageResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    scripts: {
      description:
        "The rendered root-side server scripts (setup, remove, settings) awaiting privileged execution",
      schema: ScriptsResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    install: {
      description: "The result of the last install (or skipped install)",
      schema: InstallResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    server: {
      description:
        "The result of the last `magnitude server setup` / configure run",
      schema: ServerResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    config: {
      description: "The result of the last configure call (settings written)",
      schema: ConfigResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    settings: {
      description:
        "The detected/merged server settings persisted by `setup` (the API key is never stored)",
      schema: SetupResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    service: {
      description: "systemd service status",
      schema: ServiceResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    uninstall: {
      description: "The result of the last uninstall",
      schema: UninstallResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "The printed installed/server summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-staging-dir": {
      description:
        "Validate configured paths are absolute or ~-prefixed before mutating the filesystem",
      labels: ["policy"],
      appliesTo: ["stage", "install", "configure"],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const errors: string[] = [];
        for (
          const [field, value] of [
            ["downloadDir", context.globalArgs.downloadDir],
            ["stagingDir", context.globalArgs.stagingDir],
            ["configDir", context.globalArgs.configDir],
          ] as [string, string][]
        ) {
          if (value && !value.startsWith("/") && !value.startsWith("~")) {
            errors.push(
              `${field} must be absolute or ~-prefixed, got '${value}'`,
            );
          }
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  methods: {
    setup: {
      description:
        "Detect the server's current settings, merge any supplied network " +
        "settings over them, and persist them (partial values included) to the " +
        "`settings` resource so a later run reuses them instead of asking again. " +
        "Reports what is installed and which capabilities are enabled; it changes " +
        "nothing on the host — the install workflow applies the settings via " +
        "`configure`. The network API key is never written to swamp data.",
      arguments: SetupConfigArgsSchema,
      execute: async (
        args: z.infer<typeof SetupConfigArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const configPath = `${expandHome(g.configDir)}/config.json`;
        const prior = await context.readResource("settings") as {
          effective?: Record<string, unknown>;
        } | null;
        const priorEffective = prior?.effective ?? {};

        let fileNetwork: Record<string, unknown> = {};
        let configExists = false;
        try {
          const parsed = JSON.parse(await Deno.readTextFile(configPath)) as {
            network?: Record<string, unknown>;
          };
          fileNetwork = parsed.network ?? {};
          configExists = true;
        } catch {
          // absent or unreadable by this user; the merge falls back to args/global
        }

        const pickBool = (...values: unknown[]): boolean | undefined => {
          for (const v of values) if (typeof v === "boolean") return v;
          return undefined;
        };
        const pickString = (...values: unknown[]): string => {
          for (const v of values) if (typeof v === "string" && v) return v;
          return "";
        };
        const detected = {
          configExists,
          networkEnabled: pickBool(fileNetwork.enabled) ?? null,
          // `bind` is the current key; tolerate a legacy `host`.
          networkHost: pickString(fileNetwork.bind, fileNetwork.host) || null,
          hasApiKey: Boolean(
            fileNetwork.apiKey || args.networkApiKey || g.networkApiKey,
          ),
        };
        const effective = {
          networkEnabled: pickBool(
            args.networkEnabled,
            fileNetwork.enabled,
            priorEffective.networkEnabled,
            g.networkEnabled,
          ) ?? false,
          // A reference, never the secret: the key stays in config.json only.
          networkApiKeyRef: detected.hasApiKey ? "<set>" : null,
          networkHost: pickString(
            args.networkHost,
            fileNetwork.bind,
            fileNetwork.host,
            priorEffective.networkHost,
            g.networkHost,
          ),
        };

        const binary = await findBinary(args.binaryPath, undefined);
        const capabilities: string[] = [];
        if (binary) capabilities.push("installed");
        if (configExists) capabilities.push("configured");
        if (effective.networkEnabled && detected.hasApiKey) {
          capabilities.push("network-api");
        }
        const message = `Setup:${binary ? " installed" : " not installed"}` +
          `${configExists ? ", configured" : ""}` +
          `${effective.networkEnabled ? ", network API on" : ""}` +
          `${detected.hasApiKey ? " (key set)" : ""}`;
        context.logger.info(message);
        const handle = await context.writeResource("settings", "settings", {
          detected,
          effective,
          installed: Boolean(binary),
          binaryPath: binary,
          configPath,
          capabilities,
          message,
          setupAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    plan: {
      description:
        "Resolve this machine's distribution family, architecture, package " +
        "format and manager, the release asset filter to hand to " +
        "@svendowideit/github-release-install, and every install/service path. " +
        "The bundled magnitude-install workflow feeds these to the later steps.",
      arguments: PlanArgsSchema,
      execute: async (
        args: z.infer<typeof PlanArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        const { family, arch, osRelease } = await resolveFamilyArch(
          args.distro ?? g.distro,
          args.arch ?? g.arch,
          runner,
        );
        const supported = family !== "unknown" &&
          archSupported(family as DistroFamily, arch);
        const format = family === "unknown"
          ? null
          : packageFormatFor(family as DistroFamily);
        const manager = family === "unknown"
          ? null
          : packageManagerFor(family as DistroFamily);
        const configDir = expandHome(g.configDir);
        const configPath = `${configDir}/config.json`;
        const needsRoot = supported;
        const manageService = g.manageService === "true" ||
          (g.manageService === "auto" && supported);

        const manualCommands: string[] = [];
        if (supported) {
          const statusCommand = `systemctl status ${g.serviceName}.service`;
          manualCommands.push(
            ...manualInstructions(
              `If this run cannot elevate, install and set up Magnitude by hand:`,
              manualInstallCommands(
                family,
                `${expandHome(g.downloadDir)}/${g.packageName}`,
              ),
              `Inspect the service at any time with:  ${statusCommand}`,
            ),
          );
        }

        const message = supported
          ? `Plan: ${family}/${arch} → ${g.packageName} (${format}, ${manager}); ` +
            `service ${g.serviceName} (${g.serviceUser}); settings ${configPath}` +
            (manageService ? `; set up server` : `; install only`)
          : `Unsupported platform: distro family '${family}', arch '${arch}'. ` +
            `Magnitude ships Debian, RPM and Arch packages for x86_64 and ` +
            `arm64 (no Arch/arm64 build).`;
        if (!supported) context.logger.warn?.(message);
        else context.logger.info(message);

        const handle = await context.writeResource("platform", "platform", {
          family,
          arch,
          osRelease,
          format,
          manager,
          assetPattern: g.assetPattern,
          assetStem: "magnitude-desktop",
          osFilter: format,
          archFilter: arch === "x64"
            ? "x86_64"
            : arch === "arm64"
            ? "arm64"
            : null,
          packageName: g.packageName,
          installRoot: INSTALL_ROOT,
          binaryPath: BINARY_PATH,
          configDir,
          configPath,
          unitPath: UNIT_PATH,
          serviceName: g.serviceName,
          serviceUser: g.serviceUser,
          manageService,
          supported,
          requiresRoot: needsRoot,
          manualCommands,
          plannedAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    privilege: {
      description:
        "Report how this run can escalate to root (root / passwordless sudo / " +
        "sudo-with-prompt / none) and, when it cannot, the exact commands to " +
        "run the privileged steps by hand.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const status: PrivilegeStatus = await detectPrivilegeWith();
        context.logger.info(status.message);
        if (status.mode === "none" || status.mode === "sudo-prompt") {
          for (
            const line of manualInstructions(
              "To let swamp install Magnitude automatically, do one of:",
              [
                {
                  command:
                    `echo "\${USER} ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/swamp-magnitude && sudo chmod 0440 /etc/sudoers.d/swamp-magnitude`,
                  reason:
                    "grant passwordless sudo (adjust to least privilege as needed)",
                },
                {
                  command: "sudo /usr/bin/magnitude server setup",
                  reason:
                    "or set the server up by hand once the package is installed",
                },
              ],
            )
          ) context.logger.info(line);
        }
        const handle = await context.writeResource("privilege", "privilege", {
          mode: status.mode,
          isRoot: status.isRoot,
          sudoAvailable: status.sudoAvailable,
          passwordless: status.passwordless,
          message: status.message,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description:
        "Locate the magnitude binary, run `magnitude --version`, and record the " +
        "installed version and path. With checkLatest (the default) it also " +
        "resolves the newest release version from GitHub, rate-limit friendly " +
        "and failing soft.",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        const binary = await findBinary(args.path ?? "", undefined);
        let version: string | null = null;
        let raw: string | null = null;
        let error: string | null = null;
        if (binary) {
          const result = await readLocalVersion(binary, runner);
          version = result.version;
          raw = result.raw || null;
          error = result.error;
        } else {
          error = "magnitude binary not found on this machine";
        }

        let latestVersion: string | null = null;
        let latestTag: string | null = null;
        if (args.checkLatest) {
          const repo = (args.repo.trim() || g.repo).trim();
          const latest = await fetchLatestRelease(
            repo,
            args.githubToken || g.githubToken,
          );
          if (latest) {
            latestTag = latest.tag;
            latestVersion = latest.version;
          } else {
            context.logger.warn?.(
              "Could not resolve the latest Magnitude release; skipping the update check",
            );
          }
        }

        const installedRelease = version ? releaseVersion(version) : null;
        const updateAvailable = latestVersion === null
          ? null
          : installedRelease === null ||
            compareVersions(latestVersion, installedRelease) > 0;

        const message = !binary
          ? "No installed Magnitude found."
          : version
          ? `Installed Magnitude ${version} at ${binary}` +
            (updateAvailable === null
              ? "."
              : updateAvailable
              ? `; latest ${latestVersion}.`
              : ` (up to date).`)
          : `Found ${binary} but could not read its version: ${error}`;
        if (!binary) context.logger.warn?.(message);
        else context.logger.info(message);

        const handle = await context.writeResource("installed", "installed", {
          present: Boolean(binary),
          version,
          releaseVersion: installedRelease,
          path: binary,
          latestVersion,
          latestTag,
          updateAvailable,
          rawOutput: raw,
          error,
          syncedAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    assess: {
      description:
        "Compare the installed version (from the `installed` resource) with the " +
        "release resolved by the release step, and record whether an update is " +
        "available. The bundled workflow skips the download when it is not.",
      arguments: AssessArgsSchema,
      execute: async (
        args: z.infer<typeof AssessArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const stored = await context.readResource("installed") as {
          present?: boolean;
          version?: string | null;
        } | null;
        const installed = stored?.present && stored.version
          ? releaseVersion(normalizeVersion(stored.version))
          : "";
        const latestPackage = normalizeVersion(args.latestVersion);
        const latest = resolveReleaseVersion(args.latestVersion);
        const updateAvailable = args.force || installed === "" ||
          compareVersions(latest, installed) > 0;
        const message = installed === ""
          ? `No installed Magnitude found; installing ${latest}.`
          : updateAvailable
          ? `Update available: installed ${installed} → ${latest}.`
          : `Magnitude ${installed} is up to date (latest ${latest}).`;
        context.logger.info(message);
        const handle = await context.writeResource("assessment", "assessment", {
          installedVersion: installed || null,
          latestVersion: latest,
          latestPackageVersion: latestPackage,
          updateAvailable,
          upToDate: !updateAvailable,
          message,
          assessedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    renderScripts: {
      description:
        "Render the root-side server scripts into the unprivileged staging " +
        "directory: the `server-setup.sh` that registers and starts the Magnitude " +
        "server, the `server-remove.sh` that tears it down, and the settings " +
        "document when network settings are set. Runs on every run (install and " +
        "uninstall), so the privileged steps always have a script to run. Pure " +
        "rendering: nothing is written outside stagingDir.",
      arguments: SetupConfigArgsSchema,
      execute: async (
        args: z.infer<typeof SetupConfigArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const networkEnabled = args.networkEnabled ?? g.networkEnabled;
        const apiKey = args.networkApiKey ?? g.networkApiKey;
        const bind = args.networkHost ?? g.networkHost;
        assertAbsoluteDir(g.stagingDir, "stagingDir");
        const stagingDir = expandHome(g.stagingDir);
        const configDir = expandHome(g.configDir);

        let serverConfigPath: string | null = null;
        if (networkEnabled || apiKey || bind) {
          serverConfigPath = await writeFileEnsuringDir(
            `${stagingDir}/config.json`,
            renderServerConfig({
              networkEnabled: networkEnabled || undefined,
              apiKey: apiKey || undefined,
              bind: bind || undefined,
            }),
            0o600,
          );
        }
        const setupScriptPath = await writeFileEnsuringDir(
          `${stagingDir}/server-setup.sh`,
          renderServerSetupScript({
            serviceName: g.serviceName,
            serviceUser: g.serviceUser,
            configDir,
            configStagedPath: serverConfigPath,
          }),
          0o755,
        );
        const removeScriptPath = await writeFileEnsuringDir(
          `${stagingDir}/server-remove.sh`,
          renderServerRemoveScript({
            serviceName: g.serviceName,
            configDir,
          }),
          0o755,
        );

        const message = `Rendered the server scripts in ${stagingDir}` +
          (serverConfigPath ? " (with settings)" : "");
        context.logger.info(message);
        const handle = await context.writeResource("scripts", "scripts", {
          stagingDir,
          setupScriptPath,
          removeScriptPath,
          serverConfigPath,
          renderedAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    stage: {
      description:
        "Verify the downloaded package's SHA-256 (defence in depth — the release " +
        "step already verified it) and render the package-manager install script " +
        "into an unprivileged staging directory. Pure staging: nothing is written " +
        "outside stagingDir.",
      arguments: StageArgsSchema,
      execute: async (
        args: z.infer<typeof StageArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const platform = await context.readResource("platform") as {
          manager?: PackageManager | null;
          configPath?: string;
          binaryPath?: string;
        } | null;
        const manager = args.manager ?? platform?.manager ?? null;
        if (!manager) {
          throw new Error(
            "stage needs a package manager: run `plan` first or pass " +
              "`manager` (apt/dnf/pacman).",
          );
        }
        const packagePath = expandHome(args.packagePath.trim());
        if (!packagePath) {
          throw new Error(
            "stage needs a packagePath (the download step's verified archive).",
          );
        }
        const packageName = args.packageName.trim() ||
          packagePath.replace(/\\/g, "/").split("/").pop() || packagePath;

        let sha256: string | null = null;
        let checksumVerified: boolean | null = null;
        const expected = args.checksum.trim();
        if (expected) {
          sha256 = await sha256File(packagePath);
          checksumVerified = sha256.toLowerCase() === expected.toLowerCase();
          if (!checksumVerified) {
            throw new Error(
              `Staged package checksum mismatch: expected ${expected}, got ${sha256}.`,
            );
          }
        }

        assertAbsoluteDir(g.stagingDir, "stagingDir");
        const stagingDir = expandHome(g.stagingDir);
        const installScriptPath = await writeFileEnsuringDir(
          `${stagingDir}/install-magnitude.sh`,
          renderInstallScript({ manager, packagePath }),
          0o755,
        );

        const message =
          `Staged ${packageName} (${manager}) — install script ${installScriptPath}` +
          (checksumVerified ? " (checksum verified)" : "");
        context.logger.info(message);
        const handle = await context.writeResource("stage", "stage", {
          staged: true,
          packagePath,
          packageName,
          checksum: expected || null,
          checksumVerified,
          sha256,
          manager,
          stagingDir,
          installScriptPath,
          stagedAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Install or upgrade the staged package with the host's package manager, " +
        "escalating with the host's route when possible. The bundled workflow " +
        "runs the staged script through @svendowideit/sudo instead, so this " +
        "direct path is for a machine-local run.",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const staged = await context.readResource("stage") as {
          packagePath?: string;
          manager?: PackageManager;
        } | null;
        const packagePath = expandHome(
          (args.packagePath.trim() || staged?.packagePath || "").trim(),
        );
        if (!packagePath) {
          throw new Error(
            "install needs a package: run `stage` first or pass `packagePath`.",
          );
        }
        const manager = args.manager ?? staged?.manager ?? null;
        if (!manager) {
          throw new Error("install needs a package manager: run `plan` first.");
        }
        const status = await detectPrivilegeWith();
        if (!canEscalate(status, true)) {
          throw new Error(
            `${status.message} Install the package by hand:\n` +
              manualInstallCommandsFor(manager, packagePath),
          );
        }
        const prefix = escalationPrefix(status, true);
        const result = await runWithPrefix(
          prefix,
          packageInstallArgvFor(manager, packagePath),
        );
        const installed = result.code === 0;
        const message = installed
          ? `Installed ${packagePath} with ${manager}.`
          : `Package install failed (exit ${result.code}).`;
        if (installed) context.logger.info(message);
        else context.logger.warn?.(message);
        const handle = await context.writeResource("install", "install", {
          installed,
          packagePath,
          manager,
          exitCode: result.code,
          stdout: result.stdout.trim() || null,
          stderr: result.stderr.trim() || null,
          message,
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    serverSetup: {
      description:
        "Register and start the Magnitude server non-interactively: create the " +
        "magnitude system group/account, prepare the data directory, write the " +
        "/etc/magnitude/server marker and enable the shipped magnitude.service. " +
        "This is the same root-side work `magnitude server setup` does, but run " +
        "as a script so it needs no interactive password prompt, escalated with " +
        "the host's route.",
      arguments: SetupArgsSchema,
      execute: async (
        args: z.infer<typeof SetupArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const binary = await findBinary(args.binaryPath, undefined);
        if (!binary) {
          throw new Error(
            "magnitude binary not found: install the package first (the bundled " +
              "workflow does this), or pass binaryPath.",
          );
        }
        const status = await detectPrivilegeWith();
        const prefix = escalationPrefix(status, true);
        if (!canEscalate(status, true)) {
          throw new Error(
            `${status.message} Set the server up by hand:\n` +
              `  sudo sh ${expandHome(g.stagingDir)}/server-setup.sh`,
          );
        }
        const scriptPath = await writeFileEnsuringDir(
          `${expandHome(g.stagingDir)}/server-setup.sh`,
          renderServerSetupScript({
            serviceName: g.serviceName,
            serviceUser: g.serviceUser,
            configDir: expandHome(g.configDir),
          }),
          0o755,
        );
        const result = await runWithPrefix(prefix, ["sh", scriptPath]);
        const ran = result.code === 0;
        const message = ran
          ? `Magnitude server registered and started (${g.serviceName}.service).`
          : `Server setup failed (exit ${result.code}).`;
        if (ran) context.logger.info(message);
        else context.logger.warn?.(message);
        const handle = await context.writeResource("server", "server", {
          ran,
          binaryPath: binary,
          exitCode: result.code,
          stdout: result.stdout.trim() || null,
          stderr: result.stderr.trim() || null,
          configPath: `${expandHome(g.configDir)}/config.json`,
          unitPath: UNIT_PATH,
          networkHint: null,
          message,
          configuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description:
        "Write /var/lib/magnitude/config.json (network access, API key, bind " +
        "address) as root through the elevation route and restart the service. " +
        "Settings not passed are left untouched.",
      arguments: ConfigureArgsSchema,
      execute: async (
        args: z.infer<typeof ConfigureArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const networkEnabled = args.networkEnabled ?? g.networkEnabled;
        const apiKey = args.networkApiKey ?? g.networkApiKey;
        const bind = args.networkHost ?? g.networkHost;
        const document = renderServerConfig({
          networkEnabled: networkEnabled || undefined,
          apiKey: apiKey || undefined,
          bind: bind || undefined,
        });
        if (document.trim() === "{}") {
          throw new Error(
            "configure needs at least one setting: pass networkEnabled, " +
              "networkApiKey or networkHost.",
          );
        }
        const configDir = expandHome(g.configDir);
        const configPath = `${configDir}/config.json`;
        const stagingDir = expandHome(g.stagingDir);
        const docPath = await writeFileEnsuringDir(
          `${stagingDir}/config.json`,
          document,
          0o600,
        );
        const status = await detectPrivilegeWith();
        if (!canEscalate(status, true)) {
          throw new Error(
            `${status.message} Write the settings by hand:\n` +
              `  sudo install -D -m 0600 -o ${g.serviceUser} -g ${g.serviceUser} ${docPath} ${configPath}\n` +
              `  sudo systemctl restart ${g.serviceName}.service`,
          );
        }
        const prefix = escalationPrefix(status, true);

        // config.json must be owned by the magnitude account (which alone may
        // read it). The setup script installs it owned, creates the account and
        // data dir if missing, enables the unit, and restarts only when the
        // settings actually changed.
        let result: { stdout: string; stderr: string; code: number };
        if (args.restart) {
          const scriptPath = await writeFileEnsuringDir(
            `${stagingDir}/server-setup.sh`,
            renderServerSetupScript({
              serviceName: g.serviceName,
              serviceUser: g.serviceUser,
              configDir,
              configStagedPath: docPath,
            }),
            0o755,
          );
          result = await runWithPrefix(prefix, ["sh", scriptPath]);
        } else {
          const installDir = await runWithPrefix(prefix, [
            "install",
            "-d",
            "-m",
            "0750",
            "-o",
            g.serviceUser,
            "-g",
            g.serviceUser,
            configDir,
          ]);
          result = await runWithPrefix(prefix, [
            "install",
            "-D",
            "-m",
            "0600",
            "-o",
            g.serviceUser,
            "-g",
            g.serviceUser,
            docPath,
            configPath,
          ]);
          if (installDir.code !== 0 && result.code === 0) result = installDir;
        }
        const written = result.code === 0;
        const restarted = written && args.restart;
        const message = written
          ? `Wrote ${configPath}` +
            (restarted ? " and restarted the service." : ".")
          : `Failed to write ${configPath} (exit ${result.code}).`;
        if (written) context.logger.info(message);
        else context.logger.warn?.(message);
        const handle = await context.writeResource("config", "config", {
          written,
          configPath,
          document: redactServerConfig(document),
          restarted,
          exitCode: result.code,
          message,
          configuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    service: {
      description:
        "Report the Magnitude systemd unit's active/enabled state on this host.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unit = `${g.serviceName}.service`;
        const active = await runCapture("systemctl", ["is-active", unit]);
        const enabled = await runCapture("systemctl", ["is-enabled", unit]);
        const activeState = active.stdout.trim() || active.stderr.trim() ||
          "unknown";
        const enabledState = enabled.stdout.trim() || enabled.stderr.trim() ||
          "unknown";
        const isActive = activeState === "active";
        const isEnabled = enabledState === "enabled";
        const message = `Service ${unit}: ${activeState}, ${enabledState}`;
        context.logger.info(message);
        const handle = await context.writeResource("service", "service", {
          unit,
          active: isActive,
          enabled: isEnabled,
          state: activeState,
          enabledState,
          statusCommand: `systemctl status ${unit}`,
          checkedAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    uninstall: {
      description:
        "Stop and disable the Magnitude server service and, by default, remove " +
        "the distro package; only purgeData deletes /var/lib/magnitude (models " +
        "and settings). Idempotent.",
      arguments: UninstallArgsSchema,
      execute: async (
        args: z.infer<typeof UninstallArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const status = await detectPrivilegeWith();
        if (!canEscalate(status, true)) {
          throw new Error(
            `${status.message} Remove Magnitude by hand:\n` +
              `  sudo systemctl disable --now ${g.serviceName}.service\n` +
              (args.removePackage
                ? `  sudo apt-get remove -y ${g.packageName}   # or dnf/pacman\n`
                : ""),
          );
        }
        const prefix = escalationPrefix(status, true);

        // Stop and remove the service non-interactively (the same work
        // `magnitude server remove` does, without its password prompt).
        const removeScriptPath = await writeFileEnsuringDir(
          `${expandHome(g.stagingDir)}/server-remove.sh`,
          renderServerRemoveScript({
            serviceName: g.serviceName,
            configDir: expandHome(g.configDir),
          }),
          0o755,
        );
        const remove = await runWithPrefix(prefix, ["sh", removeScriptPath]);
        const serviceRemoved = remove.code === 0;

        let packageRemoved = false;
        if (args.removePackage) {
          const platform = await context.readResource("platform") as {
            manager?: PackageManager | null;
          } | null;
          const manager = platform?.manager ??
            packageManagerFor(
              (await resolveFamilyArch(g.distro, g.arch, runCapture))
                .family as DistroFamily,
            );
          const action = manager === "apt"
            ? ["apt-get", "remove", "-y", g.packageName]
            : manager === "dnf"
            ? ["dnf", "remove", "-y", g.packageName]
            : ["pacman", "-R", "--noconfirm", g.packageName];
          const result = await runWithPrefix(prefix, action);
          packageRemoved = result.code === 0;
        }

        let dataPurged = false;
        if (args.purgeData) {
          const purge = await runWithPrefix(prefix, [
            "rm",
            "-rf",
            expandHome(g.configDir),
          ]);
          dataPurged = purge.code === 0;
        }

        const message = `Removed service=${serviceRemoved ? "yes" : "no"}` +
          `, package=${packageRemoved ? "yes" : "no"}` +
          `, data=${dataPurged ? "purged" : "kept"}`;
        context.logger.info(message);
        const handle = await context.writeResource("uninstall", "uninstall", {
          serviceRemoved,
          packageRemoved,
          dataPurged,
          exitCode: packageRemoved || serviceRemoved ? 0 : 1,
          message,
          uninstalledAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Log the stored installed/server summary and the exact status command.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const installed = await context.readResource("installed") as {
          version?: string | null;
          releaseVersion?: string | null;
          path?: string | null;
        } | null;
        const service = await context.readResource("service") as {
          state?: string;
          enabledState?: string;
        } | null;
        const lines: string[] = [];
        const version = installed?.version ?? null;
        lines.push(
          version
            ? `Magnitude ${version} installed at ${installed?.path}`
            : "Magnitude: not installed",
        );
        if (service) {
          lines.push(
            `Service: ${service.state ?? "unknown"}, ${
              service.enabledState ?? "unknown"
            }`,
          );
        }
        lines.push(
          `Status: systemctl status ${context.globalArgs.serviceName}.service`,
        );
        for (const line of lines) context.logger.info(line);
        const handle = await context.writeResource("summary", "summary", {
          printed: true,
          version,
          path: installed?.path ?? null,
          serviceActive: service?.state === "active" ? true : null,
          serviceEnabled: service?.enabledState === "enabled" ? true : null,
          lines,
          printedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.18.1",
      description: "Initial release.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};

// ---------------------------------------------------------------------------
// Local helpers that need the MethodContext / GlobalArgs
// ---------------------------------------------------------------------------

/**
 * Replace the network API key in a settings document with a placeholder before
 * it is stored in swamp data, so a secret the user supplied is never persisted
 * there (it lives only in config.json on the host).
 */
export function redactServerConfig(document: string): string {
  try {
    const parsed = JSON.parse(document) as {
      network?: Record<string, unknown>;
    };
    if (parsed.network && typeof parsed.network.apiKey === "string") {
      parsed.network.apiKey = "<redacted>";
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return document;
  }
}

/** Detect the elevation route for this host. */
async function detectPrivilegeWith(): Promise<PrivilegeStatus> {
  return await detectPrivilege({ runner: runCapture });
}

/**
 * Run an argv with the escalation prefix already resolved. When the prefix is
 * empty (root), the argv runs directly.
 */
function runWithPrefix(
  prefix: string[],
  argv: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const full = [...prefix, ...argv];
  return runCapture(full[0], full.slice(1));
}

/** The package-manager argv for a manager, without a privilege prefix. */
function packageInstallArgvFor(
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

/** The manual install line for a manager (for error messages). */
function manualInstallCommandsFor(
  manager: PackageManager,
  packagePath: string,
): string {
  return `  sudo ${packageInstallArgvFor(manager, packagePath).join(" ")}`;
}

/** Resolve the latest Magnitude release from the GitHub API (fails soft). */
async function fetchLatestRelease(
  repo: string,
  token: string,
): Promise<{ tag: string; version: string } | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "swamp-magnitude-extension",
  };
  const auth = token || Deno.env.get("GITHUB_TOKEN") ||
    Deno.env.get("GH_TOKEN") ||
    "";
  if (auth) headers.Authorization = `Bearer ${auth}`;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers },
    );
    if (!response.ok) return null;
    const payload = await response.json() as { tag_name?: string };
    const tag = String(payload.tag_name ?? "");
    if (!tag) return null;
    return { tag, version: resolveReleaseVersion(tag) };
  } catch {
    return null;
  }
}
