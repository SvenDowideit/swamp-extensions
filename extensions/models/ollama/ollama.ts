/**
 * Ollama install and service management for a machine with systemd.
 *
 * `@svendowideit/ollama` closes the whole loop around an Ollama install on the
 * machine it runs on: it knows which version is installed, resolves the newest
 * release (delegated to `@svendowideit/github-release-install`), installs or
 * upgrades the right build for this OS/architecture/accelerator
 * (Linux/NVIDIA, Linux/AMD ROCm, Jetson, macOS and Windows), and keeps the
 * `ollama serve` daemon running under systemd — creating the unit when none
 * exists, or restarting the existing one. It also exposes the Ollama service
 * settings (host, environment, extra serve arguments, run-as user/group,
 * restart policy) as configuration, writing a systemd *drop-in* override so an
 * existing upstream unit is customised, never clobbered.
 *
 * Methods:
 *   - `plan`             — resolve this machine's OS/arch/accelerator, the
 *                          release asset stem to fetch, and the service scope;
 *                          the bundled workflow feeds these to the fetch steps.
 *   - `sync`             — locate `ollama`, run `ollama --version`, and record
 *                          the installed version, build and path.
 *   - `install`          — extract the checksum-verified archive the release
 *                          workflow produced, install the binary and its
 *                          `lib/ollama` runtime, idempotently.
 *   - `uninstall`        — remove the binary and lib (and optionally the
 *                          service); idempotent.
 *   - `createService`    — write a full systemd unit when none exists; leave
 *                          an existing one untouched unless `force`.
 *   - `configureService` — write (or update) a systemd drop-in override with
 *                          the configured Environment/ExecStart settings, and
 *                          daemon-reload.
 *   - `restartService`   — restart (starting if stopped), verify active.
 *   - `status`           — report active/enabled state and the unit path.
 *   - `removeService`    — stop, disable, delete the unit and drop-in.
 *   - `print`            — log the stored installed/service summary.
 *
 * Linux installs shell out to `systemctl` and `sudo` (system scope) or the
 * user manager (user scope); `zstd` is required to extract Linux releases.
 * macOS/Windows installs the binary/lib only (no service management) and are
 * documented in the README.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  ACCEL_VARIANTS,
  type ArchiveMember,
  assertAbsoluteDir,
  assertNoNewlines,
  assetExtension,
  assetFileName,
  assetStem,
  buildEnvironment,
  canEscalate,
  compareVersions,
  type ConcreteAccel,
  detectAccel,
  detectArchiveFormat,
  detectPrivilege,
  digestHex,
  dirIsWritable,
  dirnameOf,
  escalationPrefix,
  expandHome,
  extractArchive,
  isDarwinOs,
  isWindowsOs,
  type ManualCommand,
  manualInstructions,
  manualRemoveCommands,
  manualServiceCommands,
  manualSystemInstallCommands,
  normalizeVersion,
  OLLAMA_ASSET_PATTERN,
  type OllamaArchiveFormat,
  parseEnvironmentBlock,
  parseVersionOutput,
  type PrivilegeStatus,
  renderServiceUnit,
  resolveOsArch,
  runCapture,
  runCaptureEnv,
  type ServiceUnitOptions,
  versionsEqual,
} from "./ollama_shared.ts";
import { UntarStream } from "jsr:@std/tar@0.1.10/untar-stream";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ServiceScopeSchema = z.enum(["auto", "system", "user"]).describe(
  "systemd scope: 'system' (needs root/sudo), 'user' (no root), or 'auto' to " +
    "use the existing service when one is found, else 'system'.",
);

const ScopeOverrideSchema = z.enum(["auto", "system", "user"]).optional();

/**
 * Tri-state service management: `auto` (default) maintains the service only
 * when a unit already exists (a server) and otherwise upgrades the binary only
 * (a client); `true` always creates/updates the service; `false` never touches
 * units.
 */
const ManageServiceSchema = z.enum(["auto", "true", "false"]).default("auto")
  .describe(
    "auto (default): maintain the systemd service when a unit already exists, " +
      "else upgrade the binary only (a client machine). true: always " +
      "create/update the service. false: never touch units.",
  );

const GlobalArgsSchema = z.object({
  os: z.string().default("").describe(
    "Override the detected OS token (Linux, Darwin, Windows). Empty probes the host.",
  ),
  arch: z.string().default("").describe(
    "Override the detected architecture token (x86_64, arm64). Empty probes the host.",
  ),
  accel: z.enum(ACCEL_VARIANTS).default("auto").describe(
    "Build variant: auto detects it (Jetson/ROCm/base); base bundles CUDA on " +
      "Linux/amd64; rocm adds AMD GPU support; mlx is the MLX build; " +
      "jetpack5/jetpack6 are the NVIDIA Jetson (arm64) builds.",
  ),
  installDir: z.string().default("").describe(
    "Directory to install the ollama binary into. Empty picks /usr/local/bin " +
      "for system scope or ~/.local/bin for user scope.",
  ),
  downloadDir: z.string().default("~/.cache/ollama").describe(
    "Directory the verified release archive is staged in before install extracts it.",
  ),
  serviceName: z.string().default("ollama").describe(
    "systemd service name (without the .service suffix).",
  ),
  serviceScope: ServiceScopeSchema.default("auto"),
  unitDir: z.string().default("").describe(
    "Override the directory unit files are written to. Empty uses " +
      "/etc/systemd/system (system scope) or ~/.config/systemd/user (user scope).",
  ),
  serviceUser: z.string().default("ollama").describe(
    "Run-as user for a system service (created if missing).",
  ),
  serviceGroup: z.string().default("ollama").describe(
    "Run-as group for a system service (created if missing).",
  ),
  host: z.string().default("").describe(
    "Value for OLLAMA_HOST (e.g. 127.0.0.1:11434 or 0.0.0.0:11434). Empty " +
      "leaves the service default untouched.",
  ),
  environment: z.array(z.string()).default([]).describe(
    "Extra Environment= lines as KEY=VALUE (e.g. OLLAMA_MODELS=/mnt/models).",
  ),
  manageService: ManageServiceSchema,
  extraEnvironment: z.string().default("").describe(
    "Convenience alternative to `environment`: a newline- or comma-separated " +
      "block of KEY=VALUE lines, so a user can paste several settings.",
  ),
  extraArgs: z.string().default("").describe(
    "Extra arguments appended to `ollama serve` in ExecStart (e.g. " +
      "--flash-attention).",
  ),
  restart: z.string().default("always").describe("Restart= policy."),
  restartSec: z.string().default("3").describe("RestartSec= delay."),
  sudo: z.string().default("sudo").describe(
    "Command used to escalate for system scope when not already root.",
  ),
  sudoNonInteractive: z.boolean().default(true).describe(
    "Pass -n to sudo so it fails instead of prompting (a swamp run has no " +
      "tty). Set false to let an interactive terminal prompt for a password.",
  ),
  sudoInstanceKey: z.string().default("default").describe(
    "Instance key of the privileged @svendowideit/sudo model the workflow " +
      "elevates through (model name sudo-<instanceKey>).",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AssessArgsSchema = z.object({
  latestVersion: z.string().min(1).describe(
    "The latest release version resolved by the release step (e.g. 0.35.0).",
  ),
});

const PlanArgsSchema = z.object({
  os: z.string().optional(),
  arch: z.string().optional(),
  accel: z.enum(ACCEL_VARIANTS).optional(),
  serviceScope: ScopeOverrideSchema,
});

const SyncArgsSchema = z.object({
  path: z.string().optional().describe(
    "Override the binary path for this call.",
  ),
  repo: z.string().default("ollama/ollama").describe(
    "GitHub repository publishing the Ollama releases. Used to resolve the " +
      "latest release version for the update check.",
  ),
  githubToken: z.string().default("").meta({ sensitive: true }).describe(
    "GitHub token to raise the releases API rate limit. Empty falls back to " +
      "GITHUB_TOKEN / GH_TOKEN, then the authenticated `gh` CLI.",
  ),
  checkLatest: z.boolean().default(true).describe(
    "Also fetch the latest release version from GitHub and report whether an " +
      "update is available. Set false for an offline / air-gapped sync.",
  ),
});

const InstallArgsSchema = z.object({
  version: z.string().default("").describe(
    "Release version being installed (e.g. 0.35.0). Empty reads it from archiveName.",
  ),
  archivePath: z.string().default("").describe(
    "Path to the checksum-verified archive produced by " +
      "@svendowideit/github-release-install's download step. Required.",
  ),
  archiveName: z.string().default("").describe(
    "Archive file name, e.g. ollama-linux-amd64.tar.zst. Used to derive the " +
      "release version and, on Windows, the binary member name.",
  ),
  checksum: z.string().default("").describe(
    "Expected digest of the archive, recorded by the release workflow.",
  ),
  verifyArchive: z.boolean().default(true).describe(
    "Re-verify the archive's digest before extracting. Uses the sha256sum CLI " +
      "when available (streaming, no large memory use).",
  ),
  installDir: z.string().default("").describe(
    "Override the install directory for this call.",
  ),
  serviceScope: ScopeOverrideSchema,
  force: z.boolean().default(false).describe(
    "Reinstall even when the target version is already installed.",
  ),
});

type InstallArgs = z.infer<typeof InstallArgsSchema>;

const StageArgsSchema = z.object({
  version: z.string().default("").describe(
    "Release version being staged (e.g. 0.35.0). Empty reads it from archiveName.",
  ),
  archivePath: z.string().default("").describe(
    "Path to the checksum-verified archive produced by " +
      "@svendowideit/github-release-install's download step. Required.",
  ),
  archiveName: z.string().default("").describe(
    "Archive file name, e.g. ollama-linux-amd64.tar.zst. Used to derive the " +
      "release version and the staged layout.",
  ),
  checksum: z.string().default("").describe(
    "Expected digest of the archive, recorded by the release workflow.",
  ),
  verifyArchive: z.boolean().default(true).describe(
    "Re-verify the archive's digest before extracting (streamed via sha256sum).",
  ),
}).passthrough();

type StageArgs = z.infer<typeof StageArgsSchema>;

const StageResultSchema = z.object({
  staged: z.boolean(),
  skipped: z.boolean(),
  version: z.string().nullable(),
  archiveName: z.string().nullable(),
  archivePath: z.string().nullable(),
  checksumVerified: z.boolean().nullable(),
  stagingDir: z.string().nullable(),
  binaryPath: z.string().nullable(),
  libDir: z.string().nullable(),
  os: z.string().nullable(),
  arch: z.string().nullable(),
  accel: z.string().nullable(),
  bytes: z.number().nullable(),
  fileCount: z.number(),
  stagedAt: z.string(),
  message: z.string(),
});

const UninstallArgsSchema = z.object({
  path: z.string().default("").describe(
    "Exact binary path to remove. Empty auto-detects.",
  ),
  installDir: z.string().default("").describe(
    "Directory to remove the binary from. Empty derives it from the resolved path.",
  ),
  serviceName: z.string().default("").describe(
    "Override the service name to stop.",
  ),
  serviceScope: ScopeOverrideSchema,
  purge: z.boolean().default(false).describe(
    "Also remove the systemd unit and drop-in (via removeService).",
  ),
});

type UninstallArgs = z.infer<typeof UninstallArgsSchema>;

const CreateServiceArgsSchema = z.object({
  serviceName: z.string().default("").describe("Override the service name."),
  serviceScope: ScopeOverrideSchema,
  binaryPath: z.string().default("").describe(
    "Override the ollama binary path used in ExecStart. Empty resolves it.",
  ),
  execArgs: z.string().default("").describe(
    "Override the serve arguments in ExecStart. Empty uses `serve` plus extraArgs.",
  ),
  serviceUser: z.string().optional(),
  serviceGroup: z.string().optional(),
  force: z.boolean().default(false).describe(
    "Overwrite an existing unit file (default: leave it untouched).",
  ),
});

type CreateServiceArgs = z.infer<typeof CreateServiceArgsSchema>;

const ConfigureServiceArgsSchema = z.object({
  serviceName: z.string().default("").describe("Override the service name."),
  serviceScope: ScopeOverrideSchema,
  host: z.string().optional().describe("Override OLLAMA_HOST for this call."),
  environment: z.array(z.string()).optional().describe(
    "Replace the environment list for this call.",
  ),
  extraEnvironment: z.string().optional().describe(
    "Append to the environment from a KEY=VALUE block for this call.",
  ),
  extraArgs: z.string().optional().describe("Override extra serve arguments."),
  serviceUser: z.string().optional(),
  serviceGroup: z.string().optional(),
  restart: z.string().optional(),
  restartSec: z.string().optional(),
  createIfMissing: z.boolean().default(true).describe(
    "Create a full unit when none exists before writing the drop-in.",
  ),
  restartService: z.boolean().default(false).describe(
    "Restart the service after applying the configuration.",
  ),
});

type ConfigureServiceArgs = z.infer<typeof ConfigureServiceArgsSchema>;

const ServiceNameArgsSchema = z.object({
  serviceName: z.string().default("").describe("Override the service name."),
  serviceScope: ScopeOverrideSchema,
});

type ServiceNameArgs = z.infer<typeof ServiceNameArgsSchema>;

const RestartServiceArgsSchema = ServiceNameArgsSchema.extend({
  enable: z.boolean().default(false).describe(
    "Also `systemctl enable` the unit so it starts at boot (use on install).",
  ),
});

type RestartServiceArgs = z.infer<typeof RestartServiceArgsSchema>;

const PrintArgsSchema = ServiceNameArgsSchema;

type PrintArgs = z.infer<typeof PrintArgsSchema>;

const FetchScriptArgsSchema = z.object({
  url: z.string().default("https://ollama.com/install.sh").describe(
    "Download URL for the official installer script.",
  ),
  downloadDir: z.string().default("").describe(
    "Override the download directory for this call. Empty uses the global.",
  ),
}).passthrough();

type FetchScriptArgs = z.infer<typeof FetchScriptArgsSchema>;

const FetchScriptResultSchema = z.object({
  fetched: z.boolean(),
  scriptPath: z.string().nullable(),
  url: z.string(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  fetchedAt: z.string(),
  message: z.string(),
});

const PrepareServiceArgsSchema = z.object({
  serviceName: z.string().default("").describe("Override the service name."),
  serviceScope: ScopeOverrideSchema,
  binaryPath: z.string().default("").describe(
    "Override the ollama binary path used in ExecStart. Empty resolves it.",
  ),
  host: z.string().optional().describe("Override OLLAMA_HOST for this call."),
  environment: z.array(z.string()).optional().describe(
    "Replace the environment list for this call.",
  ),
  extraArgs: z.string().optional().describe("Override extra serve arguments."),
  restart: z.string().optional(),
  restartSec: z.string().optional(),
  createIfMissing: z.boolean().default(true).describe(
    "Also render a full unit (not just a drop-in) when none exists.",
  ),
}).passthrough();

type PrepareServiceArgs = z.infer<typeof PrepareServiceArgsSchema>;

const PrepareServiceResultSchema = z.object({
  serviceName: z.string(),
  scope: z.string(),
  unitPath: z.string(),
  dropInPath: z.string().nullable(),
  unitStagedPath: z.string().nullable(),
  dropInStagedPath: z.string().nullable(),
  unitCreated: z.boolean(),
  usedDropIn: z.boolean(),
  environment: z.array(z.string()),
  execStart: z.string(),
  preparedAt: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const PlanResultSchema = z.object({
  os: z.string(),
  arch: z.string(),
  accel: z.string(),
  stem: z.string(),
  assetName: z.string(),
  assetPattern: z.string(),
  format: z.string(),
  installDir: z.string(),
  libDir: z.string(),
  serviceName: z.string(),
  serviceScope: z.string(),
  manageService: z.boolean(),
  supported: z.boolean(),
  serviceStatusCommand: z.string().nullable(),
  requiresRoot: z.boolean(),
  canEscalate: z.boolean(),
  privilegeMode: z.string(),
  privilegeMessage: z.string(),
  manualCommands: z.array(z.string()),
  plannedAt: z.string(),
  message: z.string(),
});

const PrivilegeResultSchema = z.object({
  uid: z.number(),
  isRoot: z.boolean(),
  sudoAvailable: z.boolean(),
  passwordless: z.boolean(),
  sudoCommand: z.string(),
  nonInteractive: z.boolean(),
  mode: z.string(),
  message: z.string(),
  checkedAt: z.string(),
});

const AssessmentResultSchema = z.object({
  installedVersion: z.string().nullable(),
  latestVersion: z.string(),
  updateAvailable: z.boolean(),
  upToDate: z.boolean(),
  message: z.string(),
  assessedAt: z.string(),
});

const InstalledResultSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  version: z.string().nullable(),
  os: z.string().nullable(),
  arch: z.string().nullable(),
  rawVersionOutput: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
  serverHost: z.string().nullable(),
  serverVersion: z.string().nullable(),
  serverError: z.string().nullable(),
  checkedAt: z.string(),
});

const InstallResultSchema = z.object({
  installed: z.boolean(),
  skipped: z.boolean(),
  version: z.string().nullable(),
  previousVersion: z.string().nullable(),
  path: z.string().nullable(),
  installDir: z.string().nullable(),
  libDir: z.string().nullable(),
  archiveName: z.string().nullable(),
  archivePath: z.string().nullable(),
  checksumVerified: z.boolean().nullable(),
  accel: z.string().nullable(),
  os: z.string().nullable(),
  arch: z.string().nullable(),
  bytes: z.number().nullable(),
  fileCount: z.number(),
  installedAt: z.string(),
  message: z.string(),
  versionCommand: z.string().nullable(),
  serviceStatusCommand: z.string().nullable(),
  requiresRoot: z.boolean(),
  manualCommands: z.array(z.string()),
  manualInstructions: z.string(),
});

const UninstallResultSchema = z.object({
  removed: z.boolean(),
  skipped: z.boolean(),
  path: z.string().nullable(),
  libDir: z.string().nullable(),
  version: z.string().nullable(),
  purgedService: z.boolean(),
  removedAt: z.string(),
  message: z.string(),
  serviceStatusCommand: z.string().nullable(),
  manualCommands: z.array(z.string()),
});

const ServiceResultSchema = z.object({
  serviceName: z.string(),
  scope: z.string(),
  unitPath: z.string(),
  dropInPath: z.string().nullable(),
  active: z.boolean(),
  enabled: z.boolean(),
  checkedAt: z.string(),
});

const CreateServiceResultSchema = z.object({
  serviceName: z.string(),
  scope: z.string(),
  unitPath: z.string(),
  written: z.boolean(),
  existed: z.boolean(),
  checkedAt: z.string(),
  message: z.string(),
  requiresRoot: z.boolean(),
  manualCommands: z.array(z.string()),
  manualInstructions: z.string(),
});

const ConfigResultSchema = z.object({
  applied: z.boolean(),
  serviceName: z.string(),
  scope: z.string(),
  unitPath: z.string(),
  dropInPath: z.string().nullable(),
  usedDropIn: z.boolean(),
  unitCreated: z.boolean(),
  unitChanged: z.boolean(),
  environment: z.array(z.string()),
  execStart: z.string(),
  restartRequested: z.boolean(),
  restarted: z.boolean(),
  message: z.string(),
  setAt: z.string(),
  requiresRoot: z.boolean(),
  manualCommands: z.array(z.string()),
  manualInstructions: z.string(),
});

const PrintResultSchema = z.object({
  printed: z.boolean(),
  path: z.string().nullable(),
  present: z.boolean(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
  serverHost: z.string().nullable(),
  serverVersion: z.string().nullable(),
  serviceName: z.string(),
  scope: z.string().nullable(),
  serviceStatusCommand: z.string().nullable(),
  lines: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Method context & types
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

type CommandResult = { stdout: string; stderr: string; code: number };
type Runner = (bin: string, args: string[]) => Promise<CommandResult>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** The auto-detection candidates for the `ollama` binary, in priority order. */
function searchPaths(home?: string): string[] {
  const h = home ?? Deno.env.get("HOME") ?? "";
  return [
    "ollama",
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
    `${h}/.local/bin/ollama`,
    `${h}/bin/ollama`,
  ];
}

/**
 * Locate a runnable `ollama` binary. An explicit `path` is authoritative: only
 * that exact path is checked, so `path`/`installDir` do what they say. With no
 * explicit path, {@link searchPaths} is probed in order.
 */
async function findBinary(
  explicit: string,
  home?: string,
): Promise<string | null> {
  const wanted = explicit.trim();
  if (wanted) {
    const candidate = wantsBinaryPath(wanted)
      ? expandHome(wanted, home)
      : `${expandHome(wanted, home)}/${binaryName()}`;
    return await existingFile(candidate);
  }
  for (const candidate of searchPaths(home)) {
    if (!candidate.includes("/")) {
      const onPath = await which(candidate);
      if (onPath) return onPath;
      continue;
    }
    const found = await existingFile(candidate);
    if (found) return found;
  }
  return null;
}

function binaryName(): string {
  return Deno.build.os === "windows" ? "ollama.exe" : "ollama";
}

/** Whether a path names the executable itself rather than a directory. */
function wantsBinaryPath(p: string): boolean {
  return /(^|\/)ollama(\.exe)?$/.test(p);
}

async function which(binary: string): Promise<string | null> {
  const result = await runCapture("which", [binary]);
  if (result.code !== 0) return null;
  const path = result.stdout.trim();
  return path || null;
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

/** Where the `ollama` client points: host:port/URL, or null when default. */
export function resolveOllamaHost(
  env: { get(key: string): string | undefined } = Deno.env,
): string | null {
  try {
    const host = (env.get("OLLAMA_HOST") ?? "").trim();
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Query a running Ollama server's `/api/version`. Accepts a bare
 * `host:port`, a `http(s):// URL`, or `0.0.0.0`-style bind addresses
 * (rewritten to `127.0.0.1`). Returns the version string, or `null` when the
 * endpoint is unreachable/not a server.
 */
export async function fetchServerVersion(
  host: string,
): Promise<{ version: string | null; error?: string }> {
  if (!host) return { version: null };
  let base = host.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) base = `http://${base}`;
  // A bind address is not a client destination: probe the loopback instead.
  if (/^http:\/\/0\.0\.0\.0/.test(base)) {
    base = base.replace("0.0.0.0", "127.0.0.1");
  }
  if (/^http:\/\/\+/.test(base)) base = base.replace("+", "127.0.0.1");
  try {
    const response = await fetch(`${base}/api/version`, {
      headers: { "User-Agent": "swamp-ollama-extension" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return {
        version: null,
        error:
          `server probe returned ${response.status} ${response.statusText}`,
      };
    }
    const payload = await response.json() as { version?: string };
    const version = (payload.version ?? "").trim();
    return version
      ? { version }
      : { version: null, error: "no version in response" };
  } catch (error) {
    return {
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Probe the local binary's version WITHOUT a server: `ollama --version` also
 * reports a remote server's version from `OLLAMA_HOST` when set. With the
 * default runner the env var is scrubbed from the child process; a custom
 * (test) runner is passed through unchanged because mocks have no concept of
 * environment.
 */
async function runLocalVersion(
  path: string,
  runner: Runner = runCapture,
): Promise<{ output: string; code: number }> {
  if (runner === runCapture) {
    // Deno.Command *merges* the given env over the parent's, so deleting the
    // key would leak the parent's OLLAMA_HOST into the child; overriding it
    // with an empty value (which ollama treats as "unset") actually scrubs.
    const env = Deno.env.toObject();
    env.OLLAMA_HOST = "";
    const result = await runCaptureEnv(path, ["--version"], env);
    return {
      output: (result.stdout + result.stderr).trim(),
      code: result.code,
    };
  }
  const result = await runner(path, ["--version"]);
  return { output: result.stdout, code: result.code };
}

/** The parsed client version from combined version output (first match). */
export function parseClientVersions(output: string): string | null {
  const m = output.match(/ollama version(?:\s+is)?\s+v?(\d[\w.+-]*)/i);
  return m ? normalizeVersion(m[1]) : null;
}

/**
 * Throw a clear error when a systemd-only method is called on a non-Linux
 * host. The bundled workflow never calls these on macOS/Windows (its service
 * steps are guarded on the platform), so this only protects direct callers.
 */
function assertSystemdPlatform(): void {
  if (Deno.build.os !== "linux") {
    throw new Error(
      `systemd service management is Linux-only; this host reports '${Deno.build.os}'. ` +
        `Install the Ollama binary here and manage the service with the platform's own mechanism.`,
    );
  }
}

/** The `systemctl` status command for a service, with or without `--user`. */
function serviceStatusCommandFor(
  name: string,
  scope: "system" | "user",
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return scope === "user"
    ? `systemctl --user status ${trimmed}.service`
    : `systemctl status ${trimmed}.service`;
}

/**
 * The systemd unit directory for a scope: `/etc/systemd/system`, or the user
 * unit dir under `$XDG_CONFIG_HOME`/`~/.config`.
 */
function unitDirFor(
  scope: "system" | "user",
  g: { home?: string; xdgConfigHome?: string; unitDir?: string } = {},
): string {
  const explicit = (g.unitDir ?? "").trim();
  if (explicit) return expandHome(explicit, g.home);
  if (scope === "user") {
    const xdg = (g.xdgConfigHome ?? Deno.env.get("XDG_CONFIG_HOME") ?? "")
      .trim();
    const base = xdg || `${g.home ?? Deno.env.get("HOME") ?? ""}/.config`;
    return `${base.replace(/\/+$/, "")}/systemd/user`;
  }
  return "/etc/systemd/system";
}

/** Parse an Ollama asset stem into OS, arch and accelerator variant. */
function parseStem(
  stem: string,
): { os: string; arch: string; accel: ConcreteAccel } | null {
  const m = stem.match(
    /^ollama-(linux|windows|darwin)(?:-(amd64|arm64))?(?:-([a-z0-9]+))?$/,
  );
  if (!m) return null;
  const os = m[1] === "windows"
    ? "Windows"
    : m[1] === "darwin"
    ? "Darwin"
    : "Linux";
  const arch = m[2] === "arm64" ? "arm64" : m[2] === "amd64" ? "x86_64" : "";
  const suffix = m[3] ?? "";
  const accel: ConcreteAccel = suffix === ""
    ? "base"
    : (suffix as ConcreteAccel);
  return { os, arch, accel };
}

/** Parse an Ollama archive file name into its stem, OS, arch and variant. */
function parseArchiveName(
  name: string,
): { stem: string; os: string; arch: string; accel: ConcreteAccel } | null {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const stripped = base.replace(/\.(tar\.zst|tar\.gz|tgz|zip)$/i, "");
  const parsed = parseStem(stripped);
  return parsed ? { stem: stripped, ...parsed } : null;
}

/** The default install directory for a scope (system vs user). */
function defaultInstallDir(
  scope: "system" | "user",
  home?: string,
): string {
  if (scope === "system") return "/usr/local/bin";
  const h = home ?? Deno.env.get("HOME") ?? "";
  return `${h}/.local/bin`;
}

/** The `lib/ollama` directory that pairs with an install directory. */
function libDirFor(installDir: string): string {
  const trimmed = installDir.replace(/\/+$/, "");
  return `${dirnameOf(trimmed)}/lib/ollama`;
}

/**
 * Resolve the tri-state `manageService` setting: an explicit `true`/`false`
 * wins; `auto` maintains the service only when a unit already exists (system
 * or user scope), so a client machine without a unit is upgraded binary-only.
 */
async function resolveManageService(
  mode: "auto" | "true" | "false",
  serviceName: string,
  g: GlobalArgs,
  runner: Runner,
): Promise<boolean> {
  if (mode === "true") return true;
  if (mode === "false") return false;
  // auto: an existing unit anywhere means "maintain it".
  const unitOpts = { unitDir: g.unitDir };
  if (unitFileExists("system", serviceName, unitOpts)) return true;
  if (unitFileExists("user", serviceName, unitOpts)) return true;
  const sys = await runner("systemctl", ["cat", serviceName]);
  if (sys.code === 0) return true;
  const user = await runner("systemctl", ["--user", "cat", serviceName]);
  if (user.code === 0) return true;
  return false;
}

/**
 * Reject an archive member path that would escape the destination (path
 * traversal) — a malicious or malformed archive must never write outside the
 * extraction directory.
 */
function isSafeMemberPath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((s) => s === "..");
}

/**
 * Resolve the concrete accelerator: an explicit variant is used as-is, and
 * `auto` probes the host via {@link detectAccel}.
 */
async function resolveAccel(
  variant: string,
  os: string,
  arch: string,
): Promise<ConcreteAccel> {
  const v = variant.trim();
  if (v && v !== "auto") return v as ConcreteAccel;
  return await detectAccel(os, arch);
}

/** Resolve the serve arguments: `serve` plus any extra arguments. */
function execArgsFor(extraArgs: string): string {
  const extra = extraArgs.trim();
  return extra ? `serve ${extra}` : "serve";
}

/**
 * The environment lines for the service: the `OLLAMA_HOST` default (when set)
 * merged with the configured `environment` and `extraEnvironment` block.
 */
function serviceEnvironment(
  host: string,
  environment: string[],
  extraEnvironment: string,
): string[] {
  const defaults: Record<string, string> = {};
  if (host.trim()) defaults["OLLAMA_HOST"] = host.trim();
  const entries = [...environment, ...parseEnvironmentBlock(extraEnvironment)];
  return buildEnvironment(defaults, entries);
}

/** The unit-file content for a freshly created service. */
function fullUnitContent(
  serviceName: string,
  scope: "system" | "user",
  binaryPath: string,
  execArgs: string,
  user: string,
  group: string,
  environment: string[],
  restart: string,
  restartSec: string,
): string {
  const opts: ServiceUnitOptions = {
    serviceName,
    scope,
    binaryPath,
    execArgs,
    user,
    group,
    environment,
    restart,
    restartSec,
    after: ["network-online.target"],
    wants: ["network-online.target"],
  };
  return renderServiceUnit(opts);
}

/**
 * The drop-in override content: only the settings the operator configured, so
 * an existing upstream unit keeps everything else. Environment lines and an
 * optional ExecStart override.
 */
function dropInContent(
  binaryPath: string,
  execArgs: string,
  environment: string[],
): string {
  const lines: string[] = [
    `# Managed by @svendowideit/ollama — these settings override the unit's.`,
    `[Service]`,
  ];
  for (const env of environment) {
    assertNoNewlines("environment", env);
    lines.push(`Environment=${env}`);
  }
  if (execArgs.trim()) {
    assertNoNewlines("execArgs", execArgs);
    lines.push(`ExecStart=${binaryPath} ${execArgs.trim()}`);
  }
  lines.push(``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Privilege escalation + commands
// ---------------------------------------------------------------------------

/**
 * Resolve the privilege situation for this run, from the configured sudo.
 * Memoized per process (keyed by the settings) so the `sudo -n true` probe runs
 * at most once even though many helpers need it; a method executes in a fresh
 * process, so the cache never goes stale across runs.
 */
const privilegeCache = new Map<string, Promise<PrivilegeStatus>>();

/** Clear the memoized privilege probe (used by tests that vary the host). */
export function resetPrivilegeCache(): void {
  privilegeCache.clear();
}

function privilegeFor(g: GlobalArgs): Promise<PrivilegeStatus> {
  const key = `${g.sudo}\0${g.sudoNonInteractive}`;
  let cached = privilegeCache.get(key);
  if (!cached) {
    cached = detectPrivilege({
      sudoCommand: g.sudo,
      nonInteractive: g.sudoNonInteractive,
    });
    privilegeCache.set(key, cached);
  }
  return cached;
}

/**
 * Build the argv prefix that escalates, or `[]` when the action runs
 * unprivileged OR when escalation is unavailable. Callers that must not
 * silently degrade check {@link canEscalate} and print manual instructions.
 */
function sudoPrefix(priv: PrivilegeStatus, needsRoot: boolean): string[] {
  return escalationPrefix(priv, needsRoot);
}

/**
 * Throw a detailed, copy-pasteable error when a privileged step cannot run
 * because this user has no usable escalation. The message names the exact
 * commands, so the operator can complete the step by hand.
 */
function requireEscalation(
  priv: PrivilegeStatus,
  needsRoot: boolean,
  intro: string,
  commands: ManualCommand[],
  outro?: string,
): void {
  if (!needsRoot || canEscalate(priv, needsRoot)) return;
  const lines = manualInstructions(
    `${priv.message} ${intro}`,
    commands,
    outro,
  );
  throw new Error(lines.join("\n"));
}

/**
 * `systemctl` verbs that only read state and never need privilege. Escalating
 * them through `sudo -n` would make a status check fail on a host without
 * passwordless sudo, reporting a running service as inactive.
 */
const READ_ONLY_SYSTEMCTL = new Set([
  "is-active",
  "is-enabled",
  "is-failed",
  "status",
  "cat",
  "show",
  "list-units",
  "list-unit-files",
]);

/**
 * Run `systemctl` for a scope, escalating for system scope when configured.
 * Read-only verbs are never escalated.
 */
async function systemctl(
  priv: PrivilegeStatus,
  scope: "system" | "user",
  args: string[],
  runner: Runner,
): Promise<CommandResult> {
  const base = scope === "user" ? ["--user", ...args] : args;
  const readOnly = READ_ONLY_SYSTEMCTL.has(args[0] ?? "");
  const prefix = sudoPrefix(priv, scope === "system" && !readOnly);
  if (prefix.length) {
    return await runner(prefix[0], [...prefix.slice(1), "systemctl", ...base]);
  }
  return await runner("systemctl", base);
}

/**
 * Write a file that may live in a root-owned directory. When `needsRoot` and
 * not already root, the content is written to a temp file and installed with
 * `sudo install`. Returns whether the content changed.
 */
async function writeFileMaybeRoot(
  priv: PrivilegeStatus,
  path: string,
  content: string,
  mode: number,
  needsRoot: boolean,
  runner: Runner,
  manualPath: ManualCommand[] = [],
): Promise<{ changed: boolean }> {
  let existing = "";
  try {
    existing = await Deno.readTextFile(path);
  } catch {
    // not present or not readable
  }
  if (existing === content) return { changed: false };

  if (needsRoot && !canEscalate(priv, true)) {
    requireEscalation(
      priv,
      true,
      `Cannot write ${path} without root. Run these commands yourself:`,
      manualPath.length ? manualPath : [{
        command:
          `sudo tee ${path} >/dev/null <<'OLLAMA_UNIT'\n${content}OLLAMA_UNIT`,
        reason: `write ${path}`,
      }],
    );
    return { changed: false };
  }

  const prefix = sudoPrefix(priv, needsRoot);
  if (prefix.length === 0) {
    await Deno.mkdir(dirnameOf(path), { recursive: true });
    const tmp = `${path}.new-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(tmp, content);
      await Deno.chmod(tmp, mode);
      await Deno.rename(tmp, path);
    } finally {
      try {
        await Deno.remove(tmp);
      } catch {
        // renamed (normal path) or never created
      }
    }
    return { changed: true };
  }

  const tmpDir = await Deno.makeTempDir({ prefix: "ollama-unit-" });
  const tmp = `${tmpDir}/${path.replace(/\//g, "_")}`;
  try {
    await Deno.writeTextFile(tmp, content);
    const result = await runner(prefix[0], [
      ...prefix.slice(1),
      "install",
      "-D",
      "-m",
      mode.toString(8),
      tmp,
      path,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `Failed to write ${path} (system scope needs root): ${
          result.stderr || result.stdout
        }. Configure passwordless sudo, or set serviceScope=user.`,
      );
    }
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // best effort
    }
  }
  return { changed: true };
}

/** Remove a file, escalating for a root-owned path. */
async function removeFileMaybeRoot(
  priv: PrivilegeStatus,
  path: string,
  needsRoot: boolean,
  runner: Runner,
): Promise<void> {
  const prefix = sudoPrefix(priv, needsRoot);
  if (prefix.length === 0) {
    try {
      await Deno.remove(path);
    } catch {
      // already gone
    }
    return;
  }
  await runner(prefix[0], [...prefix.slice(1), "rm", "-f", path]);
}

// ---------------------------------------------------------------------------
// Service detection
// ---------------------------------------------------------------------------

/** Whether a systemd unit file exists on disk for a scope. */
function unitFileExists(
  scope: "system" | "user",
  serviceName: string,
  opts: { home?: string; unitDir?: string } = {},
): boolean {
  const dir = unitDirFor(scope, opts);
  try {
    return Deno.statSync(`${dir}/${serviceName}.service`).isFile;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective service scope. An explicit `system`/`user` wins. On
 * `auto`, an existing unit on disk wins, then systemd is queried; when neither
 * exists the default is `system`.
 */
async function resolveScope(
  requested: "auto" | "system" | "user" | undefined,
  serviceName: string,
  g: GlobalArgs,
  runner: Runner,
  home?: string,
): Promise<"system" | "user"> {
  if (requested === "system" || requested === "user") return requested;
  const unitOpts = { home, unitDir: g.unitDir };
  if (unitFileExists("system", serviceName, unitOpts)) return "system";
  if (unitFileExists("user", serviceName, unitOpts)) return "user";
  // `cat` is read-only, so no privilege status is needed; run it directly.
  const sys = await runner("systemctl", ["cat", serviceName]);
  if (sys.code === 0) return "system";
  const user = await runner("systemctl", ["--user", "cat", serviceName]);
  if (user.code === 0) return "user";
  return "system";
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Stream a tar payload into `destDir`, writing each member. Rejects
 * path-traversal members. Directory entries create their directory; file
 * entries get their recorded mode (executables keep the +x bit).
 */
async function extractTarStream(
  stream: ReadableStream<Uint8Array>,
  destDir: string,
): Promise<{ fileCount: number }> {
  let fileCount = 0;
  for await (const entry of stream.pipeThrough(new UntarStream())) {
    const path = entry.path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(
      /\/+$/,
      "",
    );
    if (!path) continue;
    if (!isSafeMemberPath(path)) {
      throw new Error(
        `Refusing archive member '${entry.path}': path traversal outside the extraction directory`,
      );
    }
    const isDir = entry.path.endsWith("/") || !entry.readable;
    if (isDir) {
      await Deno.mkdir(`${destDir}/${path}`, { recursive: true });
      continue;
    }
    const body = entry.readable;
    if (!body) continue;
    const header = entry.header as { mode?: number } | undefined;
    const mode = typeof header?.mode === "number" ? header.mode : 0o644;
    await Deno.mkdir(dirnameOf(`${destDir}/${path}`), { recursive: true });
    const file = await Deno.open(`${destDir}/${path}`, {
      create: true,
      write: true,
      truncate: true,
      mode,
    });
    await body.pipeTo(file.writable);
    fileCount++;
  }
  return { fileCount };
}

/**
 * Extract an Ollama archive to `destDir`. `tar.zst` streams through the `zstd`
 * CLI (a dependency only for Linux releases); `tgz`/`tar.gz` stream through
 * Deno's gzip; `zip` uses the bundled `fflate` in memory (Windows). Returns the
 * number of files written.
 */
async function extractToDir(
  archivePath: string,
  format: OllamaArchiveFormat,
  destDir: string,
  runner: Runner,
): Promise<{ fileCount: number }> {
  await Deno.mkdir(destDir, { recursive: true });
  if (format === "tar.zst") {
    const probe = await runner("zstd", ["--version"]);
    if (probe.code !== 0) {
      throw new Error(
        "Extracting a Linux Ollama release needs the `zstd` tool, which is " +
          "not installed. Install it (Debian/Ubuntu: apt-get install zstd; " +
          "Fedora: dnf install zstd; Arch: pacman -S zstd) and re-run.",
      );
    }
    const child = new Deno.Command("zstd", {
      args: ["-dc", archivePath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const stderrDrain = new Response(child.stderr).text();
    try {
      const result = await extractTarStream(child.stdout, destDir);
      const status = await child.status;
      const err = await stderrDrain;
      if (!status.success) {
        throw new Error(
          `zstd failed to decompress ${archivePath}: ${err.slice(0, 300)}`,
        );
      }
      return result;
    } catch (error) {
      try {
        child.kill();
      } catch {
        // already exited
      }
      await stderrDrain.catch(() => "");
      throw error;
    }
  }
  if (format === "tgz" || format === "tar.gz") {
    const file = await Deno.open(archivePath, { read: true });
    const stream = file.readable.pipeThrough(new DecompressionStream("gzip"));
    return await extractTarStream(stream, destDir);
  }
  // zip
  const bytes = await Deno.readFile(archivePath);
  const members: ArchiveMember[] = await extractArchive(bytes, "zip");
  let fileCount = 0;
  for (const member of members) {
    const path = member.path;
    if (!path || !isSafeMemberPath(path)) {
      if (path && !isSafeMemberPath(path)) {
        throw new Error(
          `Refusing archive member '${path}': path traversal outside the extraction directory`,
        );
      }
      continue;
    }
    if (member.directory) {
      await Deno.mkdir(`${destDir}/${path}`, { recursive: true });
      continue;
    }
    await Deno.mkdir(dirnameOf(`${destDir}/${path}`), { recursive: true });
    await Deno.writeFile(`${destDir}/${path}`, member.bytes);
    fileCount++;
  }
  return { fileCount };
}

// ---------------------------------------------------------------------------
// Install helpers
// ---------------------------------------------------------------------------

/** A digest result with a concrete algorithm name. */
interface DigestResultLite {
  hex: string;
  algorithm: string;
  verified: boolean;
}

/** Choose the algorithm name from an expected digest's hex length. */
function algorithmFor(expected: string): string {
  const len = expected.trim().length;
  return len === 40
    ? "sha1"
    : len === 96
    ? "sha384"
    : len === 128
    ? "sha512"
    : "sha256";
}

/**
 * Digest a file, preferring a streaming CLI (`sha256sum`/`shasum`) so a
 * multi-gigabyte archive is not read into memory, and falling back to WebCrypto
 * when no CLI is available.
 */
async function digestFile(
  path: string,
  expected: string,
  runner: Runner,
): Promise<DigestResultLite> {
  const want = expected.trim().toLowerCase();
  const algo = algorithmFor(expected);
  const num = algo.replace("sha", "");
  const clis: [string, string[]][] = [
    [`sha${num}sum`, [path]],
    ["shasum", ["-a", num, path]],
  ];
  for (const [bin, args] of clis) {
    const result = await runner(bin, args);
    if (result.code === 0) {
      const hex = result.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (/^[0-9a-f]+$/.test(hex)) {
        return { hex, algorithm: algo, verified: !want || hex === want };
      }
    }
  }
  const bytes = await Deno.readFile(path);
  const webAlgo = algo === "sha1"
    ? "SHA-1"
    : algo === "sha384"
    ? "SHA-384"
    : algo === "sha512"
    ? "SHA-512"
    : "SHA-256";
  const hex = await digestHex(bytes, webAlgo);
  return { hex, algorithm: algo, verified: !want || hex === want };
}

/**
 * Install the extracted staging tree into the target `installDir`: the binary
 * and, when present, the `lib/ollama` runtime alongside it. Privileged
 * directories are written with `sudo`.
 */
async function installTree(
  priv: PrivilegeStatus,
  stagingDir: string,
  installDir: string,
  os: string,
  runner: Runner,
  manualPath: ManualCommand[] = [],
): Promise<{ path: string; libDir: string | null; fileCount: number }> {
  const exe = isWindowsOs(os) ? "ollama.exe" : "ollama";
  const binSrc = (await existingFile(`${stagingDir}/bin/${exe}`)) ??
    `${stagingDir}/${exe}`;
  const srcStat = await Deno.stat(binSrc).catch(() => null);
  if (!srcStat?.isFile) {
    throw new Error(
      `Extracted archive has no ${exe} binary (looked in ${stagingDir}/bin and ${stagingDir}).`,
    );
  }

  const needsRoot = !dirIsWritable(installDir) &&
    !dirIsWritable(dirnameOf(installDir));
  const prefix = sudoPrefix(priv, needsRoot);
  const libSrcStat = await Deno.stat(`${stagingDir}/lib/ollama`).catch(() =>
    null
  );
  const libDir = libSrcStat?.isDirectory ? libDirFor(installDir) : null;

  if (needsRoot && !canEscalate(priv, true)) {
    requireEscalation(
      priv,
      true,
      `Cannot install into ${installDir} without root. Run these commands yourself:`,
      manualPath,
    );
  }

  if (prefix.length === 0) {
    await Deno.mkdir(installDir, { recursive: true });
    await installFile(binSrc, `${installDir}/${exe}`, 0o755);
    let count = 1;
    if (libDir) count += await copyDir(`${stagingDir}/lib/ollama`, libDir);
    return { path: `${installDir}/${exe}`, libDir, fileCount: count };
  }

  const sudo = prefix[0];
  const sudoArgs = prefix.slice(1);
  const mkdir = await runner(sudo, [...sudoArgs, "mkdir", "-p", installDir]);
  if (mkdir.code !== 0) {
    throw new Error(
      `Failed to create ${installDir} (system install needs root): ${
        mkdir.stderr || mkdir.stdout
      }`,
    );
  }
  const installed = await runner(sudo, [
    ...sudoArgs,
    "install",
    "-m",
    "755",
    "-o",
    "root",
    "-g",
    "root",
    binSrc,
    `${installDir}/${exe}`,
  ]);
  if (installed.code !== 0) {
    throw new Error(
      `Failed to install ${exe} into ${installDir}: ${
        installed.stderr || installed.stdout
      }`,
    );
  }
  let count = 1;
  if (libDir) {
    await runner(sudo, [...sudoArgs, "rm", "-rf", libDir]);
    const libMk = await runner(sudo, [...sudoArgs, "mkdir", "-p", libDir]);
    if (libMk.code !== 0) {
      throw new Error(
        `Failed to create ${libDir}: ${libMk.stderr || libMk.stdout}`,
      );
    }
    const copied = await runner(sudo, [
      ...sudoArgs,
      "cp",
      "-a",
      `${stagingDir}/lib/ollama/.`,
      `${libDir}/`,
    ]);
    if (copied.code !== 0) {
      throw new Error(
        `Failed to copy the ollama runtime into ${libDir}: ${
          copied.stderr || copied.stdout
        }`,
      );
    }
    count += await countDir(`${stagingDir}/lib/ollama`);
  }
  return { path: `${installDir}/${exe}`, libDir, fileCount: count };
}

async function installFile(
  src: string,
  dest: string,
  mode: number,
): Promise<void> {
  const tmp = `${dest}.new-${crypto.randomUUID()}`;
  try {
    await Deno.copyFile(src, tmp);
    await Deno.chmod(tmp, mode);
    await Deno.rename(tmp, dest);
  } finally {
    try {
      await Deno.remove(tmp);
    } catch {
      // renamed (normal path) or never created
    }
  }
}

async function copyDir(src: string, dest: string): Promise<number> {
  let count = 0;
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const from = `${src}/${entry.name}`;
    const to = `${dest}/${entry.name}`;
    if (entry.isDirectory) {
      count += await copyDir(from, to);
    } else if (entry.isFile) {
      const stat = await Deno.stat(from);
      await Deno.copyFile(from, to);
      await Deno.chmod(to, (stat.mode ?? 0o644) & 0o777);
      count++;
    }
  }
  return count;
}

async function countDir(src: string): Promise<number> {
  let count = 0;
  try {
    for await (const entry of Deno.readDir(src)) {
      const full = `${src}/${entry.name}`;
      if (entry.isDirectory) count += await countDir(full);
      else if (entry.isFile) count++;
    }
  } catch {
    // best effort
  }
  return count;
}

// ---------------------------------------------------------------------------
// Shared method internals
// ---------------------------------------------------------------------------

/**
 * Resolve the latest Ollama release version from the GitHub releases API.
 * Anonymous requests work (60/hour/IP); a token raises the limit. Returns
 * `null` when the check cannot run (offline, rate-limited) so `sync` still
 * records the installed state.
 */
async function fetchLatestVersion(
  repo: string,
  githubToken: string,
): Promise<{ version: string | null; error?: string }> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "swamp-ollama-extension",
  };
  const token = githubToken.trim() ||
    Deno.env.get("GITHUB_TOKEN")?.trim() ||
    Deno.env.get("GH_TOKEN")?.trim() ||
    "";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers },
    );
    if (!response.ok) {
      return {
        version: null,
        error: `GitHub API returned ${response.status} ${response.statusText}`,
      };
    }
    const payload = await response.json() as { tag_name?: string };
    const tag = (payload.tag_name ?? "").trim();
    return tag ? { version: normalizeVersion(tag) } : {
      version: null,
      error: "the release payload carried no tag_name",
    };
  } catch (error) {
    return {
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Locate the binary, read its version, and write the `installed` resource. */
async function performSync(
  context: MethodContext,
  explicitPath: string,
  opts: { repo?: string; githubToken?: string; checkLatest?: boolean } = {},
): Promise<{ name: string }> {
  const path = await findBinary(explicitPath);
  let present = false;
  let version: string | null = null;
  let rawVersionOutput: string | null = null;
  let serverVersion: string | null = null;
  let serverHost: string | null = null;
  let serverError: string | null = null;
  if (path) {
    // `ollama --version` reports the OLLAMA_HOST *server's* version when the
    // env var is exported — scrub it so this is the local binary's version.
    const result = await runLocalVersion(path, runCapture);
    rawVersionOutput = result.output;
    const parsed = parseVersionOutput(result.output);
    if (parsed) {
      present = true;
      version = parsed;
    } else if (result.code === 0) {
      present = true;
      context.logger.warn?.(
        "Could not parse `ollama --version` output: {output}",
        { output: result.output.slice(0, 200) },
      );
    }
  }

  // The server the CLI would talk to (if OLLAMA_HOST is exported elsewhere),
  // probed separately so a client/server split is visible.
  serverHost = resolveOllamaHost();
  if (serverHost) {
    const probed = await fetchServerVersion(serverHost);
    serverVersion = probed.version;
    serverError = probed.error ?? null;
  }

  // Update check: compare the installed version with the latest release.
  // A failed check degrades to null (the sync still records what is
  // installed); the workflow's dedicated resolve step owns the download-time
  // check, so this is informational.
  let latestVersion: string | null = null;
  let updateAvailable: boolean | null = null;
  if (opts.checkLatest !== false) {
    const latest = await fetchLatestVersion(
      opts.repo ?? "ollama/ollama",
      opts.githubToken ?? "",
    );
    latestVersion = latest.version;
    if (latestVersion && present && version) {
      updateAvailable = compareVersions(latestVersion, version) > 0;
    } else if (latestVersion && !present) {
      updateAvailable = true;
    }
    if (latest.error) {
      context.logger.warn?.(
        "Update check skipped: {reason}",
        { reason: latest.error },
      );
    }
  }

  context.logger.info(
    present ? "Client binary: {version} at {path}" : "Ollama not installed",
    { version: version ?? "unknown", path: path ?? "(not found)" },
  );
  if (serverHost) {
    if (serverVersion) {
      context.logger.info(
        serverVersion !== version
          ? "Server at {host} is {server} (client binary is local {version})"
          : "Server at {host} matches the local binary: {server}",
        {
          host: serverHost,
          server: serverVersion,
          version: version ?? "unknown",
        },
      );
    } else {
      context.logger.warn?.(
        "Server probe at {host} failed: {reason}",
        { host: serverHost, reason: serverError ?? "unreachable" },
      );
    }
  }
  if (latestVersion) {
    context.logger.info(
      updateAvailable
        ? "Update available: installed {version} → latest release {latest}"
        : "Latest release {latest}; this machine is up to date.",
      { version: version ?? "(none)", latest: latestVersion },
    );
  }
  return await context.writeResource("installed", "installed", {
    path: path ?? "",
    present,
    version,
    os: null,
    arch: null,
    rawVersionOutput,
    latestVersion,
    updateAvailable,
    serverHost,
    serverVersion,
    serverError,
    checkedAt: new Date().toISOString(),
  });
}

/** Ensure the run-as user and group exist for a system service. */
async function ensureUserGroup(
  priv: PrivilegeStatus,
  user: string,
  group: string,
  runner: Runner,
  logger: Logger,
): Promise<void> {
  if (!user.trim()) return;
  const hasUser = await runner("id", ["-u", user]);
  if (hasUser.code !== 0 && !canEscalate(priv, true)) {
    requireEscalation(
      priv,
      true,
      `The run-as user '${user}' does not exist and cannot be created without root. Run:`,
      [{
        command:
          `sudo useradd -r -s /bin/false -U -m -d /usr/share/${user} ${user}`,
        reason: `create the unprivileged '${user}' user`,
      }],
    );
    return;
  }
  const prefix = sudoPrefix(priv, true);
  const sudo = prefix[0] ?? "sudo";
  const sudoArgs = prefix.slice(1);
  if (hasUser.code !== 0) {
    const add = await runner(sudo, [
      ...sudoArgs,
      "useradd",
      "-r",
      "-s",
      "/bin/false",
      "-U",
      "-m",
      "-d",
      `/usr/share/${user}`,
      user,
    ]);
    if (add.code !== 0) {
      throw new Error(
        `Failed to create the '${user}' user: ${add.stderr || add.stdout}`,
      );
    }
    logger.info("Created system user {user}", { user });
  }
  if (group.trim() && group !== user) {
    const hasGroup = await runner("getent", ["group", group]);
    if (hasGroup.code !== 0) {
      if (!canEscalate(priv, true)) {
        requireEscalation(
          priv,
          true,
          `The group '${group}' does not exist and cannot be created without root. Run:`,
          [{
            command: `sudo groupadd -r ${group}`,
            reason: `create the '${group}' group`,
          }],
        );
        return;
      }
      await runner(sudo, [...sudoArgs, "groupadd", "-r", group]);
    }
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Installs and manages Ollama and its systemd service on this machine. */
export const model = {
  type: "@svendowideit/ollama",
  version: "2026.10.04.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.04.3",
      description:
        "manageService becomes tri-state (auto/true/false, default auto: " +
        "existing unit → maintain it, else binary-only). New `stage` method " +
        "extracts the verified archive to an unprivileged staging dir; the " +
        "bundled workflow places it via @svendowideit/sudo. New " +
        "--input installScript=true branch runs the official install.sh " +
        "through the sudo elevation ladder.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    platform: {
      description:
        "The resolved platform, build stem, install paths and service scope",
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
    assessment: {
      description:
        "Whether an update is available (installed vs latest release version)",
      schema: AssessmentResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    installed: {
      description: "The installed Ollama version and resolved path",
      schema: InstalledResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    install: {
      description: "The result of the last install (or skipped install)",
      schema: InstallResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    stage: {
      description:
        "The verified, extracted release tree awaiting privileged placement",
      schema: StageResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    servicePrepare: {
      description:
        "The staged systemd unit/drop-in files awaiting privileged placement",
      schema: PrepareServiceResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    installerScript: {
      description:
        "The downloaded official install.sh awaiting runScript execution",
      schema: FetchScriptResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    uninstall: {
      description: "The result of the last uninstall",
      schema: UninstallResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    service: {
      description: "systemd service status",
      schema: ServiceResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    serviceCreate: {
      description: "The result of the last createService call",
      schema: CreateServiceResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    config: {
      description: "The result of the last configureService call",
      schema: ConfigResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "The printed installed summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-install-dir": {
      description:
        "Validate configured paths are absolute or ~-prefixed before mutating the filesystem",
      labels: ["policy"],
      appliesTo: ["install", "uninstall"],
      execute: (context: {
        globalArgs: GlobalArgs;
      }): { pass: boolean; errors?: string[] } => {
        const errors: string[] = [];
        for (
          const [field, value] of [
            ["installDir", context.globalArgs.installDir],
            ["downloadDir", context.globalArgs.downloadDir],
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
    plan: {
      description:
        "Resolve this machine's OS/architecture/accelerator, the release asset " +
        "stem to fetch, the install/lib paths and the systemd service scope. " +
        "The bundled ollama-install workflow feeds the stem to " +
        "@svendowideit/github-release-install.",
      arguments: PlanArgsSchema,
      execute: async (
        args: z.infer<typeof PlanArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        const { os, arch } = await resolveOsArch(
          args.os ?? g.os,
          args.arch ?? g.arch,
          runner,
        );
        const accel = await resolveAccel(args.accel ?? g.accel, os, arch);
        const stem = assetStem(os, arch, accel);
        const assetName = assetFileName(os, arch, accel);
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          g.serviceName,
          g,
          runner,
        );
        const installDir = g.installDir.trim()
          ? expandHome(g.installDir.trim())
          : defaultInstallDir(scope);
        const format = assetExtension(os);
        const supported = os !== "UNKNOWN" && arch !== "unknown";
        const statusCommand = isDarwinOs(os) || isWindowsOs(os)
          ? null
          : serviceStatusCommandFor(g.serviceName, scope);
        // Tri-state manageService: auto resolves to "maintain the service"
        // only when a unit already exists; a client machine (no unit) gets a
        // binary-only upgrade.
        const manageService = await resolveManageService(
          g.manageService,
          g.serviceName,
          g,
          runner,
        );
        // Privilege: system scope + a root-owned install dir means the install
        // steps need root. Probe now so we can tell the user up front whether
        // swamp can do it or whether they will need the printed commands.
        const priv = await privilegeFor(g);
        const needsRoot = scope === "system" &&
          (statusCommand !== null) &&
          (!dirIsWritable(installDir) ||
            !dirIsWritable(dirnameOf(installDir)));
        const escalate = canEscalate(priv, needsRoot);
        const manualCommands: string[] = [];
        if (needsRoot && !escalate) {
          context.logger.warn?.(
            "System install requires root and this run cannot escalate: {message}",
            { message: priv.message },
          );
          manualCommands.push(
            ...manualInstructions(
              `${priv.message} This run cannot install a system service or write ${installDir}.`,
              [
                {
                  command:
                    `echo "\${USER} ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/swamp-ollama && sudo chmod 0440 /etc/sudoers.d/swamp-ollama`,
                  reason:
                    "grant passwordless sudo (then re-run this workflow; adjust to least privilege)",
                },
                {
                  command:
                    "swamp workflow run @svendowideit/ollama-install --input serviceScope=user",
                  reason:
                    "or skip root entirely: a ~/.local install and a user-scope service",
                },
                {
                  command:
                    "swamp model @svendowideit/ollama method run install ollama --input serviceScope=system",
                  reason:
                    "or run the install step once where a real terminal can answer the sudo password prompt (sudoNonInteractive=false)",
                },
              ],
            ),
          );
        }

        const message = supported
          ? `Plan: ${os}/${arch} accel=${accel} → ${assetName} (${format}); ` +
            `install to ${installDir}; service ${g.serviceName} (${scope})` +
            (manageService ? `; manage service` : `; binary only`) +
            (needsRoot && !escalate
              ? `; WARNING: needs root, cannot escalate — see manualCommands`
              : "")
          : `Unsupported platform ${os}/${arch} — no Ollama build is known.`;
        if (!supported) context.logger.warn?.(message);
        else context.logger.info(message);

        const handle = await context.writeResource("platform", "platform", {
          os,
          arch,
          accel,
          stem,
          assetName,
          assetPattern: OLLAMA_ASSET_PATTERN,
          format,
          installDir,
          libDir: libDirFor(installDir),
          serviceName: g.serviceName,
          serviceScope: scope,
          manageService,
          supported,
          serviceStatusCommand: statusCommand,
          requiresRoot: needsRoot,
          canEscalate: escalate,
          privilegeMode: priv.mode,
          privilegeMessage: priv.message,
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
        "sudo-with-prompt / none) and, when it cannot, the exact commands to run " +
        "the privileged steps by hand.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const priv = await privilegeFor(g);
        context.logger.info(priv.message);
        if (priv.mode === "none" || priv.mode === "sudo-prompt") {
          for (
            const line of manualInstructions(
              "To let swamp perform privileged steps automatically, do one of:",
              [
                {
                  command:
                    `echo "${"$"}USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/swamp-ollama && sudo chmod 0440 /etc/sudoers.d/swamp-ollama`,
                  reason:
                    "grant passwordless sudo to this user (adjust to least privilege as needed)",
                },
                {
                  command:
                    "swamp workflow run @svendowideit/ollama-install --input serviceScope=user",
                  reason:
                    "or avoid root entirely with a user-scope service and ~/.local install",
                },
              ],
            )
          ) context.logger.info(line);
        }
        const handle = await context.writeResource("privilege", "privilege", {
          ...priv,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description:
        "Locate the ollama binary, run `ollama --version`, resolve the latest " +
        "release version from GitHub (rate-limit friendly; fails soft), and " +
        "record installed + latest + whether an update is available.",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const explicit = (args.path ?? "").trim() ||
          context.globalArgs.installDir;
        const handle = await performSync(context, explicit, {
          repo: args.repo,
          githubToken: args.githubToken,
          checkLatest: args.checkLatest,
        });
        return { dataHandles: [handle] };
      },
    },

    assess: {
      description:
        "Compare the installed version (from the `installed` resource) with the " +
        "latest release version from the release step, and record whether an " +
        "update is available. The bundled workflow skips the download when it is " +
        "not.",
      arguments: AssessArgsSchema,
      execute: async (
        args: z.infer<typeof AssessArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const stored = await context.readResource("installed") as {
          version?: string | null;
          present?: boolean;
        } | null;
        const installed = stored?.present
          ? normalizeVersion(stored.version ?? "")
          : "";
        const latest = normalizeVersion(args.latestVersion);
        const updateAvailable = installed === "" ||
          compareVersions(latest, installed) > 0;
        const message = installed === ""
          ? `No installed Ollama found; installing ${latest}.`
          : updateAvailable
          ? `Update available: installed ${installed} → ${latest}.`
          : `Ollama ${installed} is up to date (latest ${latest}).`;
        context.logger.info(message);
        const handle = await context.writeResource("assessment", "assessment", {
          installedVersion: installed || null,
          latestVersion: latest,
          updateAvailable,
          upToDate: !updateAvailable,
          message,
          assessedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stage: {
      description:
        "Verify the checksummed archive and extract it into an unprivileged " +
        "staging directory, so the workflow's privileged @svendowideit/sudo " +
        "steps can place the binary, runtime and unit files. Pure staging: " +
        "nothing is written outside stagingDir.",
      arguments: StageArgsSchema,
      execute: async (
        args: StageArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const runner: Runner = runCapture;
        const archivePath = args.archivePath.trim()
          ? expandHome(args.archivePath.trim())
          : "";
        if (!archivePath) {
          throw new Error(
            "stage requires a checksum-verified archive: pass archivePath " +
              "(the file @svendowideit/github-release-install's download step " +
              "wrote). Run the bundled ollama-install workflow, which " +
              "resolves, downloads and verifies the archive first.",
          );
        }
        const archiveLabel = args.archiveName.trim() ||
          archivePath.replace(/\\/g, "/").split("/").pop() || archivePath;
        const parsed = parseArchiveName(archiveLabel);
        const archiveOs = parsed?.os ?? "Linux";
        const version = normalizeVersion(args.version);
        const format = detectArchiveFormat(archiveLabel);
        if (!format) {
          throw new Error(
            `Unrecognised Ollama archive format for '${archiveLabel}'.`,
          );
        }

        // Verify the archive (the release workflow already verified it; this
        // is defence in depth, streamed so a multi-GB archive is not read
        // whole).
        let checksumVerified: boolean | null = null;
        if (args.verifyArchive && args.checksum.trim()) {
          const digest = await digestFile(
            archivePath,
            args.checksum.trim(),
            runner,
          );
          checksumVerified = digest.verified;
          if (!digest.verified) {
            throw new Error(
              `Checksum mismatch for ${archiveLabel}: expected ` +
                `${args.checksum.trim()} but got ${digest.hex} — refusing to stage.`,
            );
          }
        }

        const stagingDir = await Deno.makeTempDir({
          prefix: "ollama-stage-",
        });
        let fileCount = 0;
        let archiveBytes = 0;
        let binaryPath: string | null = null;
        let libDir: string | null = null;
        try {
          archiveBytes = (await Deno.stat(archivePath)).size;
          context.logger.info(
            "Extracting {archive} ({format}) to staging…",
            { archive: archiveLabel, format },
          );
          const extracted = await extractToDir(
            archivePath,
            format,
            stagingDir,
            runner,
          );
          fileCount = extracted.fileCount;
          const exe = isWindowsOs(archiveOs) ? "ollama.exe" : "ollama";
          const binSrc = (await existingFile(`${stagingDir}/bin/${exe}`)) ??
            `${stagingDir}/${exe}`;
          const binStat = await Deno.stat(binSrc).catch(() => null);
          if (!binStat?.isFile) {
            throw new Error(
              `Extracted archive has no ${exe} binary (looked in ${stagingDir}/bin and ${stagingDir}).`,
            );
          }
          binaryPath = binSrc;
          const libSrcStat = await Deno.stat(`${stagingDir}/lib/ollama`).catch(
            () => null,
          );
          if (libSrcStat?.isDirectory) libDir = `${stagingDir}/lib/ollama`;
        } catch (error) {
          try {
            await Deno.remove(stagingDir, { recursive: true });
          } catch {
            // best effort
          }
          throw error;
        }

        context.logger.info(
          "Staged Ollama {version} at {dir} ({files} files)…",
          {
            version: version || archiveLabel,
            dir: stagingDir,
            files: fileCount,
          },
        );
        const message =
          `Staged Ollama ${version || archiveLabel} in ${stagingDir} ` +
          `(${fileCount} files); binary at ${binaryPath}`;
        const handle = await context.writeResource("stage", "stage", {
          staged: true,
          skipped: false,
          version: version || null,
          archiveName: args.archiveName || null,
          archivePath,
          checksumVerified,
          stagingDir,
          binaryPath,
          libDir,
          os: parsed?.os ?? null,
          arch: parsed?.arch || null,
          accel: parsed?.accel ?? null,
          bytes: archiveBytes || null,
          fileCount,
          stagedAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    fetchScript: {
      description:
        "Download Ollama's official install.sh into the download directory " +
        "and record its SHA-256, so the workflow's privileged steps can " +
        "execute it through the sudo ladder (runScript). No privilege and no " +
        "execution happen here — verify the URL before running.",
      arguments: FetchScriptArgsSchema,
      execute: async (
        args: FetchScriptArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const url = args.url.trim();
        if (!/^https:\/\//.test(url)) {
          throw new Error(
            `installScriptUrl must be an https:// URL, got '${url}'`,
          );
        }
        const downloadDir = expandHome(
          (args.downloadDir.trim() || g.downloadDir).trim(),
        );
        await Deno.mkdir(downloadDir, { recursive: true });
        const scriptPath = `${downloadDir}/install.sh`;

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(
            `Downloading the official installer failed: ${response.status} ${response.statusText} (${url})`,
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const sha256 = await digestHex(bytes, "SHA-256");
        await Deno.writeFile(scriptPath, bytes);

        const message =
          `Downloaded the official install.sh (${bytes.length} bytes, ` +
          `sha256 ${sha256}) to ${scriptPath}. Verify the digest against the ` +
          `one published for the release before running it as root.`;
        context.logger.info(message);
        const handle = await context.writeResource(
          "installerScript",
          "script",
          {
            fetched: true,
            scriptPath,
            url,
            bytes: bytes.length,
            sha256,
            fetchedAt: new Date().toISOString(),
            message,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    prepareService: {
      description:
        "Render the systemd unit (when none exists) and/or the drop-in " +
        "override with the configured service settings, and write them into " +
        "the staging directory for the workflow to place with " +
        "@svendowideit/sudo's installFile. No privileged work happens here.",
      arguments: PrepareServiceArgsSchema,
      execute: async (
        args: PrepareServiceArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        assertSystemdPlatform();
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        assertNoNewlines("serviceName", serviceName);
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const unitDir = unitDirFor(scope, { unitDir: g.unitDir });
        const unitPath = `${unitDir}/${serviceName}.service`;
        const dropInDir = `${unitDir}/${serviceName}.service.d`;
        const dropInPath = `${dropInDir}/10-swamp.conf`;
        const unitExists = unitFileExists(scope, serviceName, {
          unitDir: g.unitDir,
        });

        const host = (args.host ?? g.host).trim();
        const environment = args.environment ?? g.environment;
        const extraEnvironment = g.extraEnvironment;
        const extraArgs = (args.extraArgs ?? g.extraArgs).trim();
        const user = g.serviceUser;
        const group = g.serviceGroup;
        const restartPolicy = args.restart ?? g.restart;
        const restartSec = args.restartSec ?? g.restartSec;
        const env = serviceEnvironment(host, environment, extraEnvironment);
        const execArgs = execArgsFor(extraArgs);

        // The staged release tree from `stage`; the unit lives next to it so
        // one placement branch covers both.
        const staged = await context.readResource("stage") as {
          stagingDir?: string;
        } | null;
        const stagingDir = staged?.stagingDir ?? "";
        if (!stagingDir) {
          throw new Error(
            "prepareService requires a staged release tree: run the stage " +
              "method (via the ollama-install workflow) first.",
          );
        }

        const binaryPath = args.binaryPath.trim()
          ? expandHome(args.binaryPath.trim())
          : (await findBinary(g.installDir) ??
            (scope === "system"
              ? "/usr/local/bin/ollama"
              : defaultInstallDir(scope)));

        const usedDropIn = unitExists;
        const unitStagedPath = usedDropIn && !args.createIfMissing
          ? null
          : `${stagingDir}/unit/${serviceName}.service`;
        const dropInStagedPath =
          `${stagingDir}/unit/${serviceName}.service.d/10-swamp.conf`;

        if (unitStagedPath) {
          const unitContent = fullUnitContent(
            serviceName,
            scope,
            binaryPath,
            execArgs,
            user,
            group,
            env,
            restartPolicy,
            restartSec,
          );
          await Deno.mkdir(dirnameOf(unitStagedPath), { recursive: true });
          await Deno.writeTextFile(unitStagedPath, unitContent);
        }
        const dropIn = dropInContent(
          binaryPath,
          extraArgs ? execArgs : "",
          env,
        );
        await Deno.mkdir(dirnameOf(dropInStagedPath), { recursive: true });
        await Deno.writeTextFile(dropInStagedPath, dropIn);

        context.logger.info(
          "Staged systemd files for {name} ({scope}) in {dir}",
          { name: serviceName, scope, dir: `${stagingDir}/unit` },
        );
        const message =
          `Staged ${
            unitStagedPath ? "unit + " : ""
          }drop-in for ${serviceName} ` +
          `(${scope}) in ${stagingDir}/unit`;
        const handle = await context.writeResource(
          "servicePrepare",
          "prepared",
          {
            serviceName,
            scope,
            unitPath,
            dropInPath,
            unitStagedPath,
            dropInStagedPath,
            unitCreated: !unitExists,
            usedDropIn,
            environment: env,
            execStart: `${binaryPath} ${execArgs}`.trim(),
            preparedAt: new Date().toISOString(),
            message,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Extract the checksum-verified archive the release workflow produced " +
        "and install the ollama binary and its lib/ollama runtime. Idempotent: " +
        "skips when the target version is already installed unless force.",
      arguments: InstallArgsSchema,
      execute: async (
        args: InstallArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        assertAbsoluteDir(args.installDir, "installDir");
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          g.serviceName,
          g,
          runner,
        );
        const priv = await privilegeFor(g);

        const archivePath = args.archivePath.trim()
          ? expandHome(args.archivePath.trim())
          : "";
        if (!archivePath) {
          throw new Error(
            "install requires a checksum-verified archive: pass archivePath " +
              "(the file @svendowideit/github-release-install's download step " +
              "wrote). Run the bundled ollama-install workflow, which " +
              "resolves, downloads and verifies the archive first.",
          );
        }
        const archiveLabel = args.archiveName.trim() ||
          archivePath.replace(/\\/g, "/").split("/").pop() || archivePath;
        const parsed = parseArchiveName(archiveLabel);
        const archiveOs = parsed?.os ?? "Linux";
        const version = normalizeVersion(args.version);
        const format = detectArchiveFormat(archiveLabel);
        if (!format) {
          throw new Error(
            `Unrecognised Ollama archive format for '${archiveLabel}'.`,
          );
        }

        const explicitDir = args.installDir.trim() || g.installDir.trim();
        const installDir = explicitDir
          ? expandHome(explicitDir)
          : defaultInstallDir(scope);
        const exe = isWindowsOs(archiveOs) ? "ollama.exe" : "ollama";
        const targetBinary = `${installDir}/${exe}`;

        // Idempotency: skip when the target version is already installed.
        const existing = await findBinary(
          explicitDir ? targetBinary : g.installDir,
        );
        let previousVersion: string | null = null;
        if (existing) {
          previousVersion = parseVersionOutput(
            (await runLocalVersion(existing, runner)).output,
          );
        }
        if (
          previousVersion && version &&
          versionsEqual(previousVersion, version) &&
          !args.force
        ) {
          const message =
            `Ollama ${previousVersion} is already installed at ${existing}; ` +
            `pass force=true to reinstall.`;
          context.logger.info(message);
          const handle = await context.writeResource("install", "install", {
            installed: false,
            skipped: true,
            version: previousVersion,
            previousVersion,
            path: existing,
            installDir,
            libDir: libDirFor(installDir),
            archiveName: args.archiveName || null,
            archivePath,
            checksumVerified: null,
            accel: parsed?.accel ?? null,
            os: parsed?.os ?? null,
            arch: parsed?.arch || null,
            bytes: null,
            fileCount: 0,
            installedAt: new Date().toISOString(),
            message,
            versionCommand: `${existing} --version`,
            serviceStatusCommand: serviceStatusCommandFor(g.serviceName, scope),
            requiresRoot: false,
            manualCommands: [],
            manualInstructions: "",
          });
          await performSync(context, existing ?? "");
          return { dataHandles: [handle] };
        }

        // Detect up front whether the install into this dir needs root and
        // whether we can escalate. If not, print the exact commands and stop
        // before downloading/extracting anything.
        const needsRoot = !dirIsWritable(installDir) &&
          !dirIsWritable(dirnameOf(installDir));
        if (needsRoot && !canEscalate(priv, true)) {
          const manualCommands = manualSystemInstallCommands({
            archivePath,
            format,
            installDir,
            libDir: libDirFor(installDir),
            serviceName: g.serviceName,
            serviceUser: g.serviceUser,
            serviceGroup: g.serviceGroup,
            unitPath: `${
              unitDirFor(scope, { unitDir: g.unitDir })
            }/${g.serviceName}.service`,
            unitContent: fullUnitContent(
              g.serviceName,
              scope,
              `${installDir}/${exe}`,
              execArgsFor(g.extraArgs),
              g.serviceUser,
              g.serviceGroup,
              serviceEnvironment("", [], ""),
              g.restart,
              g.restartSec,
            ),
          });
          const lines = manualInstructions(
            `${priv.message} This run cannot install into ${installDir} without root. ` +
              `Download the verified archive first, then run these commands yourself:`,
            manualCommands,
            `Or re-run with --input serviceScope=user to install into ~/.local/bin with no root.`,
          );
          for (const line of lines) context.logger.warn?.(line);
          const message = lines.join("\n");
          const handle = await context.writeResource("install", "install", {
            installed: false,
            skipped: true,
            version: version || null,
            previousVersion,
            path: null,
            installDir,
            libDir: libDirFor(installDir),
            archiveName: args.archiveName || null,
            archivePath,
            checksumVerified: null,
            accel: parsed?.accel ?? null,
            os: parsed?.os ?? null,
            arch: parsed?.arch || null,
            bytes: null,
            fileCount: 0,
            installedAt: new Date().toISOString(),
            message,
            versionCommand: null,
            serviceStatusCommand: serviceStatusCommandFor(g.serviceName, scope),
            requiresRoot: true,
            manualCommands: manualCommands.map((c) => c.command),
            manualInstructions: message,
          });
          return { dataHandles: [handle] };
        }

        // Verify the archive (the release workflow already verified it; this is
        // defence in depth, streamed so a multi-GB archive is not read whole).
        let checksumVerified: boolean | null = null;
        if (args.verifyArchive && args.checksum.trim()) {
          const digest = await digestFile(
            archivePath,
            args.checksum.trim(),
            runner,
          );
          checksumVerified = digest.verified;
          if (!digest.verified) {
            throw new Error(
              `Checksum mismatch for ${archiveLabel}: expected ` +
                `${args.checksum.trim()} but got ${digest.hex} — refusing to install.`,
            );
          }
        }

        const stagingDir = await Deno.makeTempDir({
          prefix: "ollama-extract-",
        });
        let installResult: {
          path: string;
          libDir: string | null;
          fileCount: number;
        };
        let archiveBytes = 0;
        try {
          archiveBytes = (await Deno.stat(archivePath)).size;
          context.logger.info(
            "Extracting {archive} ({format}) to staging…",
            { archive: archiveLabel, format },
          );
          await extractToDir(archivePath, format, stagingDir, runner);
          context.logger.info("Installing to {dir}…", { dir: installDir });
          installResult = await installTree(
            priv,
            stagingDir,
            installDir,
            archiveOs,
            runner,
          );
        } finally {
          try {
            await Deno.remove(stagingDir, { recursive: true });
          } catch {
            // best effort
          }
        }

        context.logger.info("Installed Ollama {version} to {path}{prev}", {
          version: version || archiveLabel,
          path: installResult.path,
          prev: previousVersion ? ` (was ${previousVersion})` : "",
        });
        const statusCommand = serviceStatusCommandFor(g.serviceName, scope);
        const message =
          `Installed Ollama ${
            version || archiveLabel
          } to ${installResult.path}` +
          (previousVersion ? ` (was ${previousVersion})` : "") +
          (statusCommand ? `; check the service with: ${statusCommand}` : "");
        const handle = await context.writeResource("install", "install", {
          installed: true,
          skipped: false,
          version: version || null,
          previousVersion,
          path: installResult.path,
          installDir,
          libDir: installResult.libDir,
          archiveName: args.archiveName || null,
          archivePath,
          checksumVerified,
          accel: parsed?.accel ?? null,
          os: parsed?.os ?? null,
          arch: parsed?.arch || null,
          bytes: archiveBytes || null,
          fileCount: installResult.fileCount,
          installedAt: new Date().toISOString(),
          message,
          versionCommand: `${installResult.path} --version`,
          serviceStatusCommand: statusCommand,
          requiresRoot: needsRoot,
          manualCommands: [],
          manualInstructions: "",
        });
        await performSync(context, installResult.path);
        return { dataHandles: [handle] };
      },
    },

    uninstall: {
      description:
        "Remove the ollama binary and its lib/ollama runtime. Idempotent. " +
        "With purge=true, also remove the systemd service.",
      arguments: UninstallArgsSchema,
      execute: async (
        args: UninstallArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const priv = await privilegeFor(g);

        const explicitPath = args.path.trim();
        const explicitDir = args.installDir.trim() || g.installDir.trim();
        const target = explicitPath
          ? expandHome(explicitPath)
          : explicitDir
          ? `${expandHome(explicitDir)}/ollama`
          : await findBinary("");

        let removed = false;
        let version: string | null = null;
        let libDir: string | null = null;
        let purgedService = false;
        let message: string;
        let manualCommands: string[] = [];

        if (!target) {
          message = "No ollama binary found — nothing to remove.";
          context.logger.info(message);
        } else {
          const present = await existingFile(target);
          if (!present) {
            message = `No ollama binary at ${target} — nothing to remove.`;
            context.logger.info(message);
          } else {
            version = parseVersionOutput(
              (await runLocalVersion(target, runner)).output,
            );
            libDir = libDirFor(dirnameOf(target));
            const needsRoot = !dirIsWritable(dirnameOf(target));
            if (needsRoot && !canEscalate(priv, true)) {
              const lines = manualInstructions(
                `${priv.message} This run cannot remove ${target} or its runtime without root. Run:`,
                manualRemoveCommands({
                  serviceName,
                  unitPath: `${
                    unitDirFor(scope, { unitDir: g.unitDir })
                  }/${serviceName}.service`,
                  dropInPath: `${
                    unitDirFor(scope, { unitDir: g.unitDir })
                  }/${serviceName}.service.d/10-swamp.conf`,
                  installDir: dirnameOf(target),
                  libDir: libDir,
                  purgeService: args.purge,
                  purgeBinary: true,
                }),
                `Or re-run with --input serviceScope=user for a ~/.local install.`,
              );
              for (const line of lines) context.logger.warn?.(line);
              manualCommands = lines;
              message = lines.join("\n");
              const handle = await context.writeResource(
                "uninstall",
                "uninstall",
                {
                  removed: false,
                  skipped: true,
                  path: target,
                  libDir,
                  version,
                  purgedService: false,
                  removedAt: new Date().toISOString(),
                  message,
                  serviceStatusCommand: serviceStatusCommandFor(
                    serviceName,
                    scope,
                  ),
                  manualCommands,
                },
              );
              return { dataHandles: [handle] };
            }
            await removeFileMaybeRoot(priv, target, needsRoot, runner);
            const libStat = await Deno.stat(libDir).catch(() => null);
            if (libStat?.isDirectory) {
              const prefix = sudoPrefix(
                priv,
                !dirIsWritable(dirnameOf(libDir)),
              );
              if (prefix.length) {
                await runner(prefix[0], [
                  ...prefix.slice(1),
                  "rm",
                  "-rf",
                  libDir,
                ]);
              } else {
                try {
                  await Deno.remove(libDir, { recursive: true });
                } catch {
                  // best effort
                }
              }
            }
            removed = true;
            message = `Removed Ollama${
              version ? ` ${version}` : ""
            } from ${target}`;
            context.logger.info(message);
          }
        }

        if (args.purge) {
          const unitDir = unitDirFor(scope, { unitDir: g.unitDir });
          const needsRoot = scope === "system";
          if (needsRoot && !canEscalate(priv, true)) {
            const lines = manualInstructions(
              `${priv.message} This run cannot remove the system service without root. Run:`,
              manualRemoveCommands({
                serviceName,
                unitPath: `${unitDir}/${serviceName}.service`,
                dropInPath: `${unitDir}/${serviceName}.service.d/10-swamp.conf`,
                purgeService: true,
                purgeBinary: false,
              }),
            );
            for (const line of lines) context.logger.warn?.(line);
            manualCommands = [...manualCommands, ...lines];
          } else {
            await systemctl(priv, scope, ["stop", serviceName], runner);
            await systemctl(priv, scope, ["disable", serviceName], runner);
            await removeFileMaybeRoot(
              priv,
              `${unitDir}/${serviceName}.service`,
              needsRoot,
              runner,
            );
            await removeFileMaybeRoot(
              priv,
              `${unitDir}/${serviceName}.service.d/10-swamp.conf`,
              needsRoot,
              runner,
            );
            await systemctl(priv, scope, ["daemon-reload"], runner);
            purgedService = true;
            context.logger.info("Removed systemd service {name}", {
              name: serviceName,
            });
          }
        }

        const handle = await context.writeResource("uninstall", "uninstall", {
          removed,
          skipped: !removed,
          path: target,
          libDir,
          version,
          purgedService,
          removedAt: new Date().toISOString(),
          message,
          serviceStatusCommand: serviceStatusCommandFor(serviceName, scope),
          manualCommands,
        });
        await performSync(context, target ?? "");
        return { dataHandles: [handle] };
      },
    },

    createService: {
      description:
        "Write a systemd unit for `ollama serve` when none exists, creating " +
        "the run-as user/group for system scope. Leaves an existing unit " +
        "untouched unless force=true. Idempotent.",
      arguments: CreateServiceArgsSchema,
      execute: async (
        args: CreateServiceArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        assertSystemdPlatform();
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        assertNoNewlines("serviceName", serviceName);
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const priv = await privilegeFor(g);
        const unitDir = unitDirFor(scope, { unitDir: g.unitDir });
        const unitPath = `${unitDir}/${serviceName}.service`;
        const existed = unitFileExists(scope, serviceName, {
          unitDir: g.unitDir,
        });

        const binaryPath = args.binaryPath.trim()
          ? expandHome(args.binaryPath.trim())
          : (await findBinary(g.installDir) ??
            (scope === "system"
              ? "/usr/local/bin/ollama"
              : defaultInstallDir(scope)));
        const execArgs = args.execArgs.trim() || execArgsFor(g.extraArgs);
        const user = args.serviceUser ?? g.serviceUser;
        const group = args.serviceGroup ?? g.serviceGroup;

        let written = false;
        let manualCommands: string[] = [];
        let manualInstructionsText = "";
        const unitContent = fullUnitContent(
          serviceName,
          scope,
          binaryPath,
          execArgs,
          user,
          group,
          serviceEnvironment("", [], ""),
          g.restart,
          g.restartSec,
        );
        if (existed && !args.force) {
          context.logger.info(
            "Existing systemd unit {path} left in place (pass force=true to overwrite)",
            { path: unitPath },
          );
        } else if (scope === "system" && !canEscalate(priv, true)) {
          const lines = manualInstructions(
            `${priv.message} This run cannot write the system unit ${unitPath} without root. Run:`,
            manualServiceCommands({
              serviceName,
              unitPath,
              unitContent,
              serviceUser: user,
              restart: false,
            }),
            `Or re-run with --input serviceScope=user for a user-scope service with no root.`,
          );
          for (const line of lines) context.logger.warn?.(line);
          manualCommands = lines;
          manualInstructionsText = lines.join("\n");
        } else {
          if (scope === "system") {
            await ensureUserGroup(priv, user, group, runner, context.logger);
          }
          const { changed } = await writeFileMaybeRoot(
            priv,
            unitPath,
            unitContent,
            0o644,
            scope === "system",
            runner,
          );
          written = changed;
          if (written) await systemctl(priv, scope, ["daemon-reload"], runner);
          context.logger.info(
            written
              ? "Wrote systemd unit {path}"
              : "Systemd unit {path} already up to date",
            { path: unitPath },
          );
        }

        const message = manualInstructionsText ||
          (existed && !args.force
            ? `Existing systemd unit left in place at ${unitPath}`
            : `Systemd unit ${
              written ? "written" : "up to date"
            } at ${unitPath}`);
        const handle = await context.writeResource(
          "serviceCreate",
          "created",
          {
            serviceName,
            scope,
            unitPath,
            written,
            existed,
            checkedAt: new Date().toISOString(),
            message,
            requiresRoot: manualInstructionsText !== "",
            manualCommands,
            manualInstructions: manualInstructionsText,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    configureService: {
      description:
        "Apply Ollama service settings as a systemd drop-in override (so an " +
        "existing unit is customised, not clobbered): OLLAMA_HOST, extra " +
        "Environment= lines, and optional serve arguments. Creates the unit " +
        "when none exists. daemon-reload, and optionally restart.",
      arguments: ConfigureServiceArgsSchema,
      execute: async (
        args: ConfigureServiceArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        assertSystemdPlatform();
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        assertNoNewlines("serviceName", serviceName);
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const priv = await privilegeFor(g);
        const unitDir = unitDirFor(scope, { unitDir: g.unitDir });
        const unitPath = `${unitDir}/${serviceName}.service`;
        const dropInDir = `${unitDir}/${serviceName}.service.d`;
        const dropInPath = `${dropInDir}/10-swamp.conf`;
        const needsRoot = scope === "system";

        const host = (args.host ?? g.host).trim();
        const environment = args.environment ?? g.environment;
        const extraEnvironment = args.extraEnvironment ?? g.extraEnvironment;
        const extraArgs = (args.extraArgs ?? g.extraArgs).trim();
        const user = args.serviceUser ?? g.serviceUser;
        const group = args.serviceGroup ?? g.serviceGroup;
        const restartPolicy = args.restart ?? g.restart;
        const restartSec = args.restartSec ?? g.restartSec;
        const env = serviceEnvironment(host, environment, extraEnvironment);
        const execArgs = execArgsFor(extraArgs);

        const binaryPath = (await findBinary(g.installDir)) ??
          (scope === "system"
            ? "/usr/local/bin/ollama"
            : defaultInstallDir(scope));

        const unitExists = unitFileExists(scope, serviceName, {
          unitDir: g.unitDir,
        });

        let unitCreated = false;
        let unitChanged = false;
        let usedDropIn = false;
        let target: string;
        let content: string;

        if (unitExists) {
          usedDropIn = true;
          target = dropInPath;
          content = dropInContent(binaryPath, extraArgs ? execArgs : "", env);
        } else if (args.createIfMissing) {
          unitCreated = true;
          target = unitPath;
          content = fullUnitContent(
            serviceName,
            scope,
            binaryPath,
            execArgs,
            user,
            group,
            env,
            restartPolicy,
            restartSec,
          );
        } else {
          throw new Error(
            `No systemd unit for ${serviceName} and createIfMissing=false.`,
          );
        }

        // If this is a root-owned system unit and we cannot escalate, hand the
        // user the exact commands instead of failing at the write.
        if (needsRoot && !canEscalate(priv, true)) {
          const lines = manualInstructions(
            `${priv.message} This run cannot write ${target} without root. Run:`,
            manualServiceCommands({
              serviceName,
              unitPath,
              unitContent: content,
              dropInPath: usedDropIn ? dropInPath : undefined,
              dropInContent: usedDropIn ? content : undefined,
              serviceUser: unitCreated ? user : undefined,
              restart: args.restartService,
            }),
            `Then re-run this workflow, or use --input serviceScope=user.`,
          );
          for (const line of lines) context.logger.warn?.(line);
          const message = lines.join("\n");
          const handle = await context.writeResource("config", "config", {
            applied: false,
            serviceName,
            scope,
            unitPath,
            dropInPath: usedDropIn ? dropInPath : null,
            usedDropIn,
            unitCreated,
            unitChanged: false,
            environment: env,
            execStart: `${binaryPath} ${execArgs}`.trim(),
            restartRequested: args.restartService,
            restarted: false,
            message,
            setAt: new Date().toISOString(),
            requiresRoot: true,
            manualCommands: lines,
            manualInstructions: message,
          });
          return { dataHandles: [handle] };
        }

        let applied = true;
        let manualCommands: string[] = [];
        let manualInstructionsText = "";
        if (unitCreated && scope === "system") {
          await ensureUserGroup(priv, user, group, runner, context.logger);
        }
        const { changed } = await writeFileMaybeRoot(
          priv,
          target,
          content,
          0o644,
          needsRoot,
          runner,
        );
        if (unitCreated) unitChanged = changed;
        if (changed) await systemctl(priv, scope, ["daemon-reload"], runner);

        let restarted = false;
        if (args.restartService) {
          const result = await systemctl(
            priv,
            scope,
            ["restart", serviceName],
            runner,
          );
          restarted = result.code === 0;
          if (!restarted && needsRoot && !canEscalate(priv, true)) {
            applied = false;
            const lines = manualInstructions(
              `${priv.message} The configuration was written but the service could not be restarted without root. Run:`,
              manualServiceCommands({
                serviceName,
                unitPath,
                unitContent: content,
                dropInPath: usedDropIn ? dropInPath : undefined,
                dropInContent: usedDropIn ? content : undefined,
                restart: true,
              }),
            );
            for (const line of lines) context.logger.warn?.(line);
            manualCommands = lines;
            manualInstructionsText = lines.join("\n");
          }
        }

        const message = manualInstructionsText ||
          (`Applied Ollama service configuration to ${target} ` +
            `(${usedDropIn ? "drop-in override" : "unit"})` +
            (changed ? "" : " — no change") +
            (args.restartService
              ? restarted ? "; restarted" : "; restart failed"
              : "") +
            (env.length ? `; environment: ${env.join(", ")}` : ""));
        context.logger.info(message);

        const handle = await context.writeResource("config", "config", {
          applied,
          serviceName,
          scope,
          unitPath,
          dropInPath: usedDropIn ? dropInPath : null,
          usedDropIn,
          unitCreated,
          unitChanged,
          environment: env,
          execStart: `${binaryPath} ${execArgs}`.trim(),
          restartRequested: args.restartService,
          restarted,
          message,
          setAt: new Date().toISOString(),
          requiresRoot: manualInstructionsText !== "",
          manualCommands,
          manualInstructions: manualInstructionsText,
        });
        return { dataHandles: [handle] };
      },
    },

    restartService: {
      description:
        "Restart (or start) the Ollama systemd service and verify it is active. " +
        "With enable=true, also enable it so it starts at boot.",
      arguments: RestartServiceArgsSchema,
      execute: async (
        args: RestartServiceArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        assertSystemdPlatform();
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const priv = await privilegeFor(g);
        const dir = unitDirFor(scope, { unitDir: g.unitDir });
        if (scope === "system" && !canEscalate(priv, true)) {
          const lines = manualInstructions(
            `${priv.message} This run cannot restart the system service without root. Run:`,
            [{
              command: `sudo systemctl restart ${serviceName}.service` +
                (args.enable
                  ? ` && sudo systemctl enable ${serviceName}.service`
                  : ""),
              reason: args.enable
                ? "restart and enable the service"
                : "restart the service",
            }],
            `Or use --input serviceScope=user.`,
          );
          for (const line of lines) context.logger.warn?.(line);
          const handle = await context.writeResource("service", "current", {
            serviceName,
            scope,
            unitPath: `${dir}/${serviceName}.service`,
            dropInPath: `${dir}/${serviceName}.service.d/10-swamp.conf`,
            active: false,
            enabled: false,
            checkedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
        if (args.enable) {
          const enable = await systemctl(
            priv,
            scope,
            ["enable", serviceName],
            runner,
          );
          if (enable.code !== 0) {
            throw new Error(
              `Failed to enable ${serviceName} (${scope}): ${
                enable.stderr || enable.stdout
              }`,
            );
          }
        }
        const restart = await systemctl(
          priv,
          scope,
          ["restart", serviceName],
          runner,
        );
        if (restart.code !== 0) {
          throw new Error(
            `Failed to restart ${serviceName} (${scope}): ${
              restart.stderr || restart.stdout
            }`,
          );
        }
        const active = await systemctl(
          priv,
          scope,
          ["is-active", serviceName],
          runner,
        );
        const enabled = await systemctl(
          priv,
          scope,
          ["is-enabled", serviceName],
          runner,
        );
        if (active.code !== 0) {
          throw new Error(
            `Service ${serviceName} is not active after restart: ${
              active.stderr || active.stdout
            }`,
          );
        }
        context.logger.info(
          "Restarted {name} ({scope}); active: {active}, enabled: {enabled}",
          {
            name: serviceName,
            scope,
            active: true,
            enabled: enabled.code === 0,
          },
        );
        const handle = await context.writeResource("service", "current", {
          serviceName,
          scope,
          unitPath: `${dir}/${serviceName}.service`,
          dropInPath: `${dir}/${serviceName}.service.d/10-swamp.conf`,
          active: active.code === 0,
          enabled: enabled.code === 0,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report the Ollama service scope, unit path, and active/enabled state.",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: ServiceNameArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const priv = await privilegeFor(g);
        const active = await systemctl(
          priv,
          scope,
          ["is-active", serviceName],
          runner,
        );
        const enabled = await systemctl(
          priv,
          scope,
          ["is-enabled", serviceName],
          runner,
        );
        const dir = unitDirFor(scope, { unitDir: g.unitDir });
        const unitPath = `${dir}/${serviceName}.service`;
        context.logger.info(
          "Service {name} ({scope}) active: {active}, enabled: {enabled} at {path}",
          {
            name: serviceName,
            scope,
            active: active.code === 0,
            enabled: enabled.code === 0,
            path: unitPath,
          },
        );
        const handle = await context.writeResource("service", "current", {
          serviceName,
          scope,
          unitPath,
          dropInPath: `${dir}/${serviceName}.service.d/10-swamp.conf`,
          active: active.code === 0,
          enabled: enabled.code === 0,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    removeService: {
      description:
        "Stop, disable, delete the unit and drop-in, and daemon-reload for the " +
        "Ollama service.",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: ServiceNameArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        assertSystemdPlatform();
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        assertNoNewlines("serviceName", serviceName);
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const priv = await privilegeFor(g);
        const unitDir = unitDirFor(scope, { unitDir: g.unitDir });
        const needsRoot = scope === "system";
        if (needsRoot && !canEscalate(priv, true)) {
          const lines = manualInstructions(
            `${priv.message} This run cannot remove the system service without root. Run:`,
            manualRemoveCommands({
              serviceName,
              unitPath: `${unitDir}/${serviceName}.service`,
              dropInPath: `${unitDir}/${serviceName}.service.d/10-swamp.conf`,
              purgeService: true,
              purgeBinary: false,
            }),
          );
          for (const line of lines) context.logger.warn?.(line);
          throw new Error(lines.join("\n"));
        }
        await systemctl(priv, scope, ["stop", serviceName], runner);
        await systemctl(priv, scope, ["disable", serviceName], runner);
        await removeFileMaybeRoot(
          priv,
          `${unitDir}/${serviceName}.service`,
          needsRoot,
          runner,
        );
        await removeFileMaybeRoot(
          priv,
          `${unitDir}/${serviceName}.service.d/10-swamp.conf`,
          needsRoot,
          runner,
        );
        await systemctl(priv, scope, ["daemon-reload"], runner);
        context.logger.info("Removed service {name} ({scope})", {
          name: serviceName,
          scope,
        });
        return { dataHandles: [] };
      },
    },

    print: {
      description:
        "Log the stored installed Ollama state: path, version, and the " +
        "systemctl status command. Run `sync` first.",
      arguments: PrintArgsSchema,
      execute: async (
        args: PrintArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const runner: Runner = runCapture;
        const serviceName = (args.serviceName.trim() || g.serviceName).trim();
        const scope = await resolveScope(
          args.serviceScope ?? g.serviceScope,
          serviceName,
          g,
          runner,
        );
        const stored = await context.readResource("installed") as {
          path?: string;
          present?: boolean;
          version?: string | null;
          latestVersion?: string | null;
          updateAvailable?: boolean | null;
          serverHost?: string | null;
          serverVersion?: string | null;
        } | null;

        const lines: string[] = [];
        if (!stored) {
          lines.push(
            "No installed-version snapshot found — run the sync method first.",
          );
        } else if (!stored.present) {
          lines.push(
            `Ollama is not installed${
              stored.path ? ` (checked ${stored.path})` : ""
            }.`,
          );
        } else {
          lines.push(`Client binary: ${stored.version ?? "unknown"}`);
          if (stored.path) {
            lines.push(`Binary:       ${stored.path}`);
            lines.push(`Check it:     ${stored.path} --version`);
          }
          if (stored.serverHost) {
            if (stored.serverVersion) {
              lines.push(
                `Server:       ${stored.serverVersion} at ${stored.serverHost}${
                  stored.serverVersion !== stored.version
                    ? ` (local binary: ${stored.version ?? "unknown"})`
                    : " (matches)"
                }`,
              );
            } else {
              lines.push(
                `Server:       unreachable at ${stored.serverHost}`,
              );
            }
          }
          if (stored.latestVersion) {
            lines.push(
              `Latest:       ${stored.latestVersion}${
                (stored.updateAvailable ?? false)
                  ? " (update available)"
                  : " (up to date)"
              }`,
            );
          }
        }
        const statusCommand = Deno.build.os === "linux"
          ? serviceStatusCommandFor(serviceName, scope)
          : null;
        if (statusCommand) {
          lines.push(`Service:      ${serviceName}.service (${scope})`);
          lines.push(`Check it:     ${statusCommand}`);
        }
        for (const line of lines) context.logger.info(line);

        // If an earlier step could not do a privileged action, repeat the exact
        // commands to run by hand so they end up in the run log (and the summary
        // resource), not buried in a skipped step's resource.
        const pending: string[] = [];
        for (
          const spec of ["install", "created", "config", "uninstall"] as const
        ) {
          // `created` is createService's instance name; the others share their
          // spec name. Each method writes only when it ran, so a missing record
          // simply means that step did not run.
          const rec = await context.readResource(spec) as {
            requiresRoot?: boolean;
            manualInstructions?: string;
          } | null;
          if (rec?.requiresRoot && rec.manualInstructions) {
            pending.push(rec.manualInstructions);
          }
        }
        if (pending.length) {
          context.logger.warn?.("Some steps need to be completed manually:");
          for (const block of pending) {
            for (const line of block.split("\n")) context.logger.warn?.(line);
          }
        }

        const handle = await context.writeResource("summary", "summary", {
          printed: Boolean(stored),
          path: stored?.path ?? null,
          present: stored?.present ?? false,
          version: stored?.version ?? null,
          latestVersion: stored?.latestVersion ?? null,
          updateAvailable: stored?.updateAvailable ?? null,
          serverHost: stored?.serverHost ?? null,
          serverVersion: stored?.serverVersion ?? null,
          serviceName,
          scope,
          serviceStatusCommand: statusCommand,
          lines,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
