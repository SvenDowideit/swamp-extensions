/**
 * TUIOS installed — tracks which version of TUIOS is currently installed on the
 * machine, and compares it against the latest release.
 *
 * The companion `@svendowideit/tuios-release` model answers "what is the
 * latest release and what should I download?". This model answers "what do I
 * have right now?": it locates the `tuios` binary, runs `tuios --version`, and
 * records the parsed version, the VT backend it was built with, the resolved
 * path and whether the binary is present at all.
 *
 * Methods:
 *   - `sync`  — locate and run `tuios --version`; record the installed version.
 *               When `checkLatest` is set (the default) it also fetches the
 *               latest release for the local platform and records
 *               `latestVersion` and `updateAvailable`, so a workflow can
 *               decide whether to install without a second model.
 *   - `print` — log the stored state: path, version, backend, present flag,
 *               latest version and whether an update is available.
 *
 * The path is resolved in this order: the `path` global argument, then the
 * first of `tuios` on `$PATH`, `~/.local/bin/tuios`, `~/bin/tuios`,
 * `/usr/local/bin/tuios` that exists (the locations the upstream install
 * script targets).
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  archiveName,
  assertAbsoluteDir,
  type BuildFlavor,
  CHECKSUMS_NAME,
  compareVersions,
  detectPackageManagerOwner,
  expandHome,
  extractFromTarGz,
  fetchChecksums,
  fetchLatestRelease,
  isOnPath,
  parseVersionOutput,
  RELEASE_REPO,
  type ReleaseAsset,
  resolveApiUrl,
  resolvePlatform,
  resolveToken,
  runCapture,
  selectAsset,
  selectInstallDir,
  verifySha256,
} from "./tuios_shared.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FlavorSchema = z.enum(["std", "ghostty"]);

const GlobalArgsSchema = z.object({
  path: z.string().default("").describe(
    "Path to the tuios binary. Empty auto-detects from PATH and the usual install locations.",
  ),
  flavor: FlavorSchema.default("std").describe(
    "Build flavor to track: 'std' is the pure-Go emulator, 'ghostty' bundles libghostty-vt.",
  ),
  repo: z.string().default(RELEASE_REPO).describe(
    "GitHub repository (owner/name) publishing TUIOS releases. Used to derive apiUrl when that is empty.",
  ),
  apiUrl: z.string().default("").describe(
    "GitHub releases API URL for the latest release. Empty derives it from repo (https://api.github.com/repos/<repo>/releases/latest).",
  ),
  userAgent: z.string().default("swamp-tuios/1.0").describe(
    "User-Agent header sent to the GitHub API.",
  ),
  githubToken: z.string().default("").meta({ sensitive: true }).describe(
    "GitHub token used to raise the API rate limit. Empty falls back to GITHUB_TOKEN or GH_TOKEN.",
  ),
  os: z.string().default("").describe(
    "Override the detected release OS token (e.g. Linux, Darwin). Empty probes the host.",
  ),
  arch: z.string().default("").describe(
    "Override the detected release architecture token (e.g. x86_64, arm64). Empty probes the host.",
  ),
  serviceName: z.string().default("tuios").describe(
    "systemd user service name (without .service) that runs the TUIOS daemon. Used to print the `systemctl --user status` command.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SyncArgsSchema = z.object({
  path: z.string().optional().describe(
    "Override the binary path for this call. Empty uses the model global / auto-detection.",
  ),
  checkLatest: z.boolean().default(true).describe(
    "Also fetch the latest release and record latestVersion / updateAvailable.",
  ),
});

type SyncArgs = z.infer<typeof SyncArgsSchema>;

const PrintArgsSchema = z.object({
  serviceName: z.string().default("").describe(
    "Override the model's serviceName global for this call when printing the `systemctl --user status` command.",
  ),
});
type PrintArgs = z.infer<typeof PrintArgsSchema>;

const InstallArgsSchema = z.object({
  version: z.string().default("").describe(
    "Release version to install (e.g. 0.8.0 or v0.8.0). Empty installs the latest release.",
  ),
  installDir: z.string().default("").describe(
    "Directory to install the tuios binary into. Empty picks the first writable of /usr/local/bin, ~/.local/bin, ~/bin.",
  ),
  archiveName: z.string().default("").describe(
    "Force an exact archive file name to download, overriding platform selection. The bundled workflow supplies this from tuios-release's `release` resource.",
  ),
  downloadUrl: z.string().default("").describe(
    "Archive download URL recorded by tuios-release's `check`. When set (and it matches the requested version) the release is not re-fetched.",
  ),
  releaseVersion: z.string().default("").describe(
    "The version tuios-release's `check` resolved, used to confirm `downloadUrl` matches the requested `version`.",
  ),
  checksum: z.string().default("").describe(
    "Expected SHA-256 of the archive, recorded by tuios-release's `check`. The install fails if this is empty or does not match the download.",
  ),
  os: z.string().optional().describe(
    "Override the release OS token for this call (e.g. Linux). Empty uses the model global / host probe.",
  ),
  arch: z.string().optional().describe(
    "Override the release architecture token for this call (e.g. arm64). Empty uses the model global / host probe.",
  ),
  flavor: FlavorSchema.optional().describe(
    "Override the build flavor for this call ('std' or 'ghostty').",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even when the installed version already equals the target version.",
  ),
});

type InstallArgs = z.infer<typeof InstallArgsSchema>;

const UninstallArgsSchema = z.object({
  path: z.string().default("").describe(
    "Exact binary path to remove. Empty uses the model `path` global, then the usual install locations.",
  ),
  installDir: z.string().default("").describe(
    "Directory to remove the binary from (its `tuios` is deleted). Empty derives the directory from the resolved binary path.",
  ),
  force: z.boolean().default(false).describe(
    "Remove a binary that a package manager owns, which is otherwise refused.",
  ),
  serviceName: z.string().default("").describe(
    "Override the model's serviceName global: the daemon service stopped after removal, and named in the status command.",
  ),
});

type UninstallArgs = z.infer<typeof UninstallArgsSchema>;

const UninstallResultSchema = z.object({
  removed: z.boolean(),
  skipped: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  packageManagerOwner: z.string().nullable(),
  removedAt: z.string(),
  message: z.string(),
  serviceStatusCommand: z.string().nullable(),
  serviceNote: z.string().nullable(),
});

const InstallResultSchema = z.object({
  installed: z.boolean(),
  skipped: z.boolean(),
  version: z.string().nullable(),
  previousVersion: z.string().nullable(),
  path: z.string().nullable(),
  installDir: z.string().nullable(),
  archiveName: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  checksumVerified: z.boolean().nullable(),
  onPath: z.boolean(),
  bytes: z.number().nullable(),
  installedAt: z.string(),
  message: z.string(),
  versionCommand: z.string().nullable(),
  serviceStatusCommand: z.string().nullable(),
});

const InstalledResultSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  version: z.string().nullable(),
  backend: z.string().nullable(),
  flavor: z.string(),
  rawVersionOutput: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
  archiveName: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  checksum: z.string().nullable(),
  checkedAt: z.string(),
});

const PrintResultSchema = z.object({
  printed: z.boolean(),
  path: z.string().nullable(),
  present: z.boolean(),
  version: z.string().nullable(),
  backend: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
  lines: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
    warn?: (message: string, properties?: Record<string, unknown>) => void;
    debug?: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * The auto-detection candidates for the `tuios` binary, in priority order:
 * `tuios` on `$PATH`, then the usual install locations the upstream script
 * targets. Used only when no explicit path was supplied.
 */
export function searchPaths(home?: string): string[] {
  const h = home ?? Deno.env.get("HOME") ?? "";
  return [
    "tuios",
    `${h}/.local/bin/tuios`,
    `${h}/bin/tuios`,
    "/usr/local/bin/tuios",
  ];
}

/**
 * Locate a runnable `tuios` binary.
 *
 * When `explicit` is non-empty it is **authoritative**: only that exact path
 * (with `~` expanded) is checked and `null` is returned if it is not a file.
 * Falling through to auto-detection here would silently resolve to a *different*
 * binary than the caller asked for — so `path` and `uninstall --input path` do
 * what they say. With no explicit path, {@link searchPaths} is probed in order.
 */
export async function findBinary(
  explicit: string,
  home?: string,
): Promise<string | null> {
  const wanted = explicit.trim();
  if (wanted) return await existingBinary(expandHome(wanted, home));
  for (const candidate of searchPaths(home)) {
    if (!candidate.includes("/")) {
      const onPath = await which(candidate);
      if (onPath) return onPath;
      continue;
    }
    const found = await existingBinary(candidate);
    if (found) return found;
  }
  return null;
}

async function which(binary: string): Promise<string | null> {
  try {
    const proc = new Deno.Command("which", {
      args: [binary],
      stdout: "piped",
      stderr: "null",
    });
    const out = await proc.output();
    if (out.code !== 0) return null;
    const path = new TextDecoder().decode(out.stdout).trim();
    return path || null;
  } catch {
    return null;
  }
}

/** Whether a single path exists and is a file (no `$PATH` fallback). */
export async function existingBinary(path: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile ? path : null;
  } catch {
    return null;
  }
}

/** Run `tuios --version` and return stdout+stderr and the exit code. */
export async function runVersion(
  path: string,
): Promise<{ output: string; code: number }> {
  try {
    const proc = new Deno.Command(path, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    return { output: `${stdout}${stderr}`.trim(), code: out.code };
  } catch (err) {
    return {
      output: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/** The actionable message shown when a package manager owns the binary. */
export function packageManagedMessage(path: string, owner: string): string {
  return `The tuios binary at ${path} is owned by ${owner}. Installing over ` +
    `it (or removing it) would fight the package manager. Upgrade with the ` +
    `package manager instead, or pass force=true to override.`;
}

/** The `systemctl --user status` command for a service name, or `null`. */
export function serviceStatusCommandFor(name: string): string | null {
  const trimmed = name.trim();
  return trimmed ? `systemctl --user status ${trimmed}.service` : null;
}

/**
 * The `systemctl --user status` command for the daemon service named by the
 * model's `serviceName` global, or `null` when the name is empty. Surfaced in
 * install/print output so the operator knows how to inspect the service.
 */
export function serviceStatusCommand(
  context: { globalArgs: { serviceName: string } },
): string | null {
  return serviceStatusCommandFor(context.globalArgs.serviceName);
}

/**
 * Render the human-readable summary lines for `print`. When a `serviceName` is
 * supplied it also emits the exact `systemctl --user status` command, so the
 * operator can inspect the daemon that runs the installed binary.
 */
export function formatSummary(
  state: {
    path?: string | null;
    present?: boolean;
    version?: string | null;
    backend?: string | null;
    latestVersion?: string | null;
    updateAvailable?: boolean | null;
  },
  serviceName = "",
): string[] {
  const lines: string[] = [];
  if (!state.present) {
    lines.push(
      `TUIOS is not installed${state.path ? ` (checked ${state.path})` : ""}.`,
    );
    if (state.latestVersion) {
      lines.push(`Latest release: ${state.latestVersion}`);
    }
    return lines;
  }
  lines.push(`Installed:    ${state.version ?? "unknown"}`);
  if (state.backend) lines.push(`Backend:      ${state.backend}`);
  if (state.path) {
    lines.push(`Binary:       ${state.path}`);
    lines.push(
      `Check it:     ${state.path} --version`,
    );
  }
  if (state.latestVersion) {
    lines.push(
      `Latest:       ${state.latestVersion}${
        state.updateAvailable ? " (update available)" : " (up to date)"
      }`,
    );
  }
  if (serviceName) {
    lines.push(`Service:      ${serviceName}.service (user)`);
    lines.push(
      `Check it:     systemctl --user status ${serviceName}.service`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Sync implementation (shared by the sync and install methods)
// ---------------------------------------------------------------------------

/**
 * Locate the binary, read its version, optionally compare against the latest
 * release, and write the `installed` resource. Shared by the `sync` method and
 * by `install`, which re-syncs after replacing the binary.
 *
 * `knownRelease` lets a caller that has already fetched the release (the
 * `install` method) pass it in, so a single run does not spend two GitHub API
 * requests on the same release.
 */
async function performSync(
  context: MethodContext,
  explicitPath: string,
  checkLatest: boolean,
  knownRelease?: { version: string; assets: ReleaseAsset[] },
): Promise<{ dataHandles: [{ name: string }] }> {
  const g = context.globalArgs;
  const path = await findBinary(explicitPath);

  let present = false;
  let version: string | null = null;
  let backend: string | null = null;
  let rawVersionOutput: string | null = null;

  if (path) {
    const { output, code } = await runVersion(path);
    rawVersionOutput = output;
    const parsed = parseVersionOutput(output);
    if (parsed) {
      present = true;
      version = parsed.version;
      backend = parsed.backend || null;
    } else if (code === 0) {
      // Ran, but the output did not match the expected line — still mark it
      // present, with no parsed version.
      present = true;
      context.logger.warn?.(
        "Could not parse `tuios --version` output: {output}",
        { output: output.slice(0, 200) },
      );
    }
  }

  let latestVersion: string | null = null;
  let updateAvailable: boolean | null = null;
  let archiveNameValue: string | null = null;
  let downloadUrl: string | null = null;
  let checksum: string | null = null;

  if (checkLatest) {
    try {
      const platform = await resolvePlatform({
        os: g.os,
        arch: g.arch,
        flavor: g.flavor,
      });
      const release = knownRelease ?? await fetchLatestRelease({
        apiUrl: resolveApiUrl(g.repo, g.apiUrl),
        userAgent: g.userAgent,
        token: resolveToken(g.githubToken),
      });
      const latest = release.version;
      const assets = release.assets;
      latestVersion = latest;
      const asset = selectAsset(
        assets,
        platform.os,
        platform.arch,
        platform.flavor as BuildFlavor,
      );
      archiveNameValue = asset?.name ??
        archiveName(
          latest,
          platform.os,
          platform.arch,
          platform.flavor as BuildFlavor,
        );
      downloadUrl = asset?.url ?? null;
      if (version) {
        updateAvailable = compareVersions(latest, version) > 0;
      }
      const checksums = assets.find((a) => a.name === CHECKSUMS_NAME);
      if (checksums && archiveNameValue) {
        const sums = await fetchChecksums(
          checksums.url,
          g.userAgent,
          resolveToken(g.githubToken),
        );
        checksum = sums[archiveNameValue] ?? null;
      }
    } catch (err) {
      context.logger.warn?.(
        "Latest-release check failed, recording installed version only: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  const handle = await context.writeResource("installed", "installed", {
    path: path ?? "",
    present,
    version,
    backend,
    flavor: g.flavor,
    rawVersionOutput,
    latestVersion,
    updateAvailable,
    archiveName: archiveNameValue,
    downloadUrl,
    checksum,
    checkedAt: new Date().toISOString(),
  });

  context.logger.info(
    present
      ? "TUIOS {version} installed at {path}{latest}"
      : "TUIOS not installed{latest}",
    {
      version: version ?? "unknown",
      path: path ?? "(not found)",
      latest: latestVersion
        ? ` — latest ${latestVersion}${
          updateAvailable ? " (update available)" : ""
        }`
        : "",
    },
  );

  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The check context passed to a pre-flight check. */
type CheckContext = {
  globalArgs: GlobalArgs;
  methodName: string;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/** Tracks the TUIOS version installed on this machine. */
export const model = {
  type: "@svendowideit/tuios-installed",
  version: "2026.09.30.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.30.1",
      description:
        "Adds the uninstall method (idempotent, package-manager aware) and a serviceName global. install now takes archiveName/downloadUrl/releaseVersion/checksum (consuming tuios-release's check), fails when no checksum is available, refuses a package-managed binary, and records versionCommand/serviceStatusCommand. New uninstall resource; installed/install/summary gain fields. Existing global args are unchanged (new serviceName defaults to 'tuios').",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "valid-install-dir": {
      description:
        "Validate the configured `path` global is absolute or ~-prefixed before mutating the filesystem",
      labels: ["policy"],
      appliesTo: ["install", "uninstall"],
      execute: (
        context: CheckContext,
      ): { pass: boolean; errors?: string[] } => {
        const errors: string[] = [];
        const dir = context.globalArgs.path;
        if (dir && !dir.startsWith("/") && !dir.startsWith("~")) {
          errors.push(
            `path global must be absolute or ~-prefixed, got '${dir}'`,
          );
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  resources: {
    installed: {
      description:
        "The installed TUIOS version and how it compares to the latest release",
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
    uninstall: {
      description: "The result of the last uninstall (or skipped uninstall)",
      schema: UninstallResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "The printed installed/update summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description:
        "Locate the tuios binary, run `tuios --version`, and record the " +
        "installed version, backend and path. With checkLatest (default true) " +
        "also records the latest release version and updateAvailable.",
      arguments: SyncArgsSchema,
      execute: async (
        args: SyncArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const explicit = (args.path ?? "").trim() || context.globalArgs.path;
        return await performSync(context, explicit, args.checkLatest);
      },
    },

    install: {
      description:
        "Download the TUIOS release archive for this platform, verify it " +
        "against the release's checksums.txt, and install the `tuios` binary " +
        "into the first writable of /usr/local/bin, ~/.local/bin or ~/bin. " +
        "Idempotent: skips when the target version is already installed unless " +
        "`force` is set. Re-syncs afterwards and records the new state.",
      arguments: InstallArgsSchema,
      execute: async (
        args: InstallArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        assertAbsoluteDir(args.installDir, "installDir");
        assertAbsoluteDir(g.path, "path");
        const platform = await resolvePlatform({
          os: args.os ?? g.os,
          arch: args.arch ?? g.arch,
          flavor: args.flavor ?? g.flavor,
          archiveName: args.archiveName.trim() || undefined,
        });

        // 1. Resolve the target release. The bundled workflow passes the
        //    version/URL/checksum that tuios-release's `check` already
        //    resolved, so the common path spends no extra GitHub API request.
        //    A direct call with a pinned `version` still fetches it.
        const wanted = args.version.trim().replace(/^v/i, "");
        const suppliedVersion = args.releaseVersion.trim().replace(/^v/i, "");
        const suppliedUrl = args.downloadUrl.trim();
        const suppliedChecksum = args.checksum.trim();
        const suppliedArchive = args.archiveName.trim();
        // Reuse `check`'s fields only when no version was pinned, or the pinned
        // version is the one check resolved. A pinned version that differs is a
        // different release, whose archive name and checksum are not the ones
        // check recorded, so it is fetched instead.
        const reuse = suppliedUrl !== "" && suppliedChecksum !== "" &&
          suppliedArchive !== "" &&
          (wanted === "" || wanted === suppliedVersion);

        let asset: ReleaseAsset | null;
        let latest: string;
        let releaseAssets: ReleaseAsset[];
        let checksum: string;
        const token = resolveToken(g.githubToken);
        if (reuse) {
          latest = suppliedVersion || wanted;
          asset = { name: suppliedArchive, url: suppliedUrl };
          releaseAssets = [asset];
          checksum = suppliedChecksum;
          context.logger.info(
            "Using the release resolved by check: {version} {archive}",
            { version: latest, archive: suppliedArchive },
          );
        } else {
          const latestUrl = resolveApiUrl(g.repo, g.apiUrl);
          const releaseUrl = wanted
            ? latestUrl.replace(/\/latest\/?$/, `/tags/v${wanted}`)
            : latestUrl;
          const fetched = await fetchLatestRelease({
            apiUrl: releaseUrl,
            userAgent: g.userAgent,
            token,
          });
          latest = fetched.version;
          releaseAssets = fetched.assets;
          // A supplied archiveName belongs to `check`'s release; only honor it
          // when no version is pinned (a pinned version has its own assets).
          const explicitArchive = wanted === "" ? suppliedArchive : "";
          asset = explicitArchive
            ? releaseAssets.find((a) => a.name === explicitArchive) ?? null
            : selectAsset(
              releaseAssets,
              platform.os,
              platform.arch,
              platform.flavor as BuildFlavor,
            );
          // Resolve the checksum for the fetched release. A checksum is
          // mandatory — an unverified download is what must not be installed.
          const checksumsUrl = releaseAssets.find((a) =>
            a.name === CHECKSUMS_NAME
          )?.url;
          checksum = "";
          if (checksumsUrl && asset) {
            checksum = (await fetchChecksums(checksumsUrl, g.userAgent, token))[
              asset.name
            ] ?? "";
          }
        }

        const expectedName = asset?.name ||
          archiveName(
            latest,
            platform.os,
            platform.arch,
            platform.flavor as BuildFlavor,
          );
        if (!asset) {
          throw new Error(
            `No TUIOS ${latest} archive found for ${platform.os}/${platform.arch} ` +
              `(${platform.flavor}); expected ${expectedName}`,
          );
        }
        if (!checksum) {
          throw new Error(
            `No SHA-256 available for ${asset.name} — refusing to install an ` +
              `unverified download. Run tuios-release's check first (it fails ` +
              `when checksums.txt does not list the archive), or pass the ` +
              `archive's checksum via the checksum input.`,
          );
        }

        // 3. Idempotency: skip when the target version is already at the
        //    target location. When installDir is explicit, only that exact
        //    path counts — falling back to PATH could otherwise skip an
        //    install the caller asked for because an unrelated binary exists.
        //    This runs before the package-manager guard so an up-to-date
        //    package-managed binary is a no-op rather than an error.
        const explicitDir = args.installDir.trim();
        const existingPath = explicitDir
          ? await existingBinary(`${expandHome(explicitDir)}/tuios`)
          : await findBinary(g.path);
        let previousVersion: string | null = null;
        if (existingPath) {
          const parsed = parseVersionOutput(
            (await runVersion(existingPath)).output,
          );
          previousVersion = parsed?.version ?? null;
        }
        const upToDate = previousVersion !== null &&
          compareVersions(latest, previousVersion) === 0;
        if (upToDate && !args.force) {
          const message =
            `TUIOS ${previousVersion} is already installed at ${existingPath}; ` +
            `pass force=true to reinstall.`;
          context.logger.info(message);
          const handle = await context.writeResource("install", "install", {
            installed: false,
            skipped: true,
            version: previousVersion,
            previousVersion,
            path: existingPath,
            installDir: existingPath
              ? existingPath.replace(/\/[^/]+$/, "")
              : null,
            archiveName: expectedName,
            downloadUrl: asset.url,
            checksumVerified: null,
            onPath: existingPath
              ? isOnPath(existingPath.replace(/\/[^/]+$/, ""))
              : false,
            bytes: null,
            installedAt: new Date().toISOString(),
            message,
            versionCommand: existingPath ? `${existingPath} --version` : null,
            serviceStatusCommand: serviceStatusCommand(context),
          });
          await performSync(context, existingPath ?? "", true, {
            version: latest,
            assets: releaseAssets,
          });
          return { dataHandles: [handle] };
        }

        // 4. Refuse to overwrite a binary a package manager owns. This is the
        //    authoritative guard: the pre-flight check cannot see installDir,
        //    and a package-manager install should be upgraded through it. Only
        //    reached when an install would actually change the binary.
        const targetPath = existingPath ??
          `${explicitDir ? expandHome(explicitDir) : selectInstallDir()}/tuios`;
        if (!args.force) {
          const owner = await detectPackageManagerOwner(targetPath);
          if (owner) throw new Error(packageManagedMessage(targetPath, owner));
        }

        // 5. Download the archive and verify it against the required checksum.
        context.logger.info("Downloading {url}", { url: asset.url });
        const response = await fetch(asset.url, {
          headers: { "User-Agent": g.userAgent },
        });
        if (!response.ok) {
          throw new Error(
            `Download failed: ${response.status} ${response.statusText} (${asset.url})`,
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!(await verifySha256(bytes, checksum))) {
          throw new Error(
            `Checksum mismatch for ${asset.name}: the download does not match ` +
              `checksums.txt — refusing to install.`,
          );
        }

        // 6. Extract the binary and install it atomically.
        const binary = await extractFromTarGz(bytes, "tuios");
        if (!binary) {
          throw new Error(
            `Archive ${asset.name} does not contain a 'tuios' binary.`,
          );
        }
        const installDir = args.installDir.trim()
          ? expandHome(args.installDir.trim())
          : selectInstallDir();
        await Deno.mkdir(installDir, { recursive: true });
        const target = `${installDir.replace(/\/+$/, "")}/tuios`;
        const tmp = `${target}.new-${crypto.randomUUID()}`;
        try {
          await Deno.writeFile(tmp, binary, { mode: 0o755 });
          await Deno.rename(tmp, target);
        } finally {
          // If writeFile or rename failed, the temp file may linger; remove it
          // so a failed install never litters the install directory.
          try {
            await Deno.remove(tmp);
          } catch {
            // already renamed (the normal path) or never created
          }
        }

        context.logger.info(
          "Installed TUIOS {version} to {target}{prev}",
          {
            version: latest,
            target,
            prev: previousVersion ? ` (was ${previousVersion})` : "",
          },
        );
        const onPath = isOnPath(installDir);
        if (!onPath) {
          context.logger.warn?.(
            "{installDir} is not on PATH — add it so `tuios` resolves",
            { installDir },
          );
        }

        const statusCommand = serviceStatusCommand(context);
        const message = `Installed TUIOS ${latest} to ${target}` +
          (previousVersion ? ` (was ${previousVersion})` : "") +
          (onPath ? "" : `; note: ${installDir} is not on PATH`) +
          (statusCommand ? `; check the service with: ${statusCommand}` : "");
        context.logger.info(
          "Binary at {target}; check the daemon with: {statusCommand}",
          { target, statusCommand: statusCommand ?? "(no systemd service)" },
        );
        const handle = await context.writeResource("install", "install", {
          installed: true,
          skipped: false,
          version: latest,
          previousVersion,
          path: target,
          installDir,
          archiveName: asset.name,
          downloadUrl: asset.url,
          checksumVerified: checksum !== null,
          onPath,
          bytes: bytes.length,
          installedAt: new Date().toISOString(),
          message,
          versionCommand: `${target} --version`,
          serviceStatusCommand: statusCommand,
        });

        // 7. Re-sync so the `installed` resource reflects the new binary,
        //    reusing the release already fetched above.
        await performSync(context, target, true, {
          version: latest,
          assets: releaseAssets,
        });

        return { dataHandles: [handle] };
      },
    },

    uninstall: {
      description:
        "Remove the `tuios` binary from this machine. Idempotent: a missing " +
        "binary is a no-op. Refuses to remove a binary a package manager owns " +
        "unless `force` is set. Stops the daemon service (so a removed binary " +
        "cannot leave the unit restart-looping) and re-syncs so the `installed` " +
        "resource shows it is gone. It does not delete the systemd unit — run " +
        "@svendowideit/systemd-service's removeService for that.",
      arguments: UninstallArgsSchema,
      execute: async (
        args: UninstallArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        assertAbsoluteDir(args.installDir, "installDir");
        assertAbsoluteDir(args.path, "path");
        const svcName = (args.serviceName.trim() || g.serviceName).trim();
        const statusCommand = serviceStatusCommandFor(svcName);

        // Resolve the target path: explicit arg, then installDir + /tuios,
        // then the model global, then auto-detection.
        const explicitDir = args.installDir.trim();
        const explicitPath = args.path.trim();
        const target = explicitPath
          ? expandHome(explicitPath)
          : explicitDir
          ? `${expandHome(explicitDir)}/tuios`
          : g.path
          ? expandHome(g.path)
          : await findBinary("");

        let removed = false;
        let version: string | null = null;
        let owner: string | null = null;
        let message: string;
        let serviceNote: string | null = null;

        if (!target) {
          message = "No tuios binary found — nothing to remove.";
          context.logger.info(message);
        } else {
          let present = false;
          try {
            present = (await Deno.stat(target)).isFile;
          } catch {
            present = false;
          }
          if (!present) {
            message = `No tuios binary at ${target} — nothing to remove.`;
            context.logger.info(message);
          } else {
            version = parseVersionOutput((await runVersion(target)).output)
              ?.version ?? null;
            owner = await detectPackageManagerOwner(target);
            if (owner && !args.force) {
              throw new Error(packageManagedMessage(target, owner));
            }
            await Deno.remove(target);
            removed = true;
            message =
              `Removed TUIOS${version ? ` ${version}` : ""} from ${target}` +
              (owner ? ` (was owned by ${owner})` : "");

            // A systemd unit whose ExecStart pointed at the removed binary will
            // flap under Restart=always. Stop it best-effort and tell the
            // operator how to remove it, rather than silently leaving a
            // broken unit behind.
            if (statusCommand) {
              await runCapture("systemctl", ["--user", "stop", svcName]);
              serviceNote =
                `The systemd user service '${svcName}' was stopped; remove it ` +
                `with @svendowideit/systemd-service's removeService, or check ` +
                `it with: ${statusCommand}`;
              context.logger.warn?.(serviceNote);
            }

            context.logger.info("Removed {target}{version}", {
              target,
              version: version ? ` (${version})` : "",
            });
          }
        }

        const handle = await context.writeResource("uninstall", "uninstall", {
          removed,
          skipped: !removed,
          path: target,
          version,
          packageManagerOwner: owner,
          removedAt: new Date().toISOString(),
          message,
          serviceStatusCommand: statusCommand,
          serviceNote,
        });

        // Re-sync so the `installed` resource reflects the removal.
        await performSync(context, target ?? "", false);

        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Log the stored installed TUIOS state: path, version, backend, present " +
        "flag, latest version and whether an update is available. Run `sync` first.",
      arguments: PrintArgsSchema,
      execute: async (
        args: PrintArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const stored = await context.readResource("installed") as {
          path?: string;
          present?: boolean;
          version?: string | null;
          backend?: string | null;
          latestVersion?: string | null;
          updateAvailable?: boolean | null;
        } | null;

        if (!stored) {
          const lines = [
            "No installed-version snapshot found — run the sync method first.",
          ];
          const handle = await context.writeResource("summary", "summary", {
            printed: false,
            path: null,
            present: false,
            version: null,
            backend: null,
            latestVersion: null,
            updateAvailable: null,
            lines,
          });
          context.logger.warn?.("print: no installed snapshot found");
          return { dataHandles: [handle] };
        }

        const serviceName = (args.serviceName.trim() ||
          context.globalArgs.serviceName).trim();
        const lines = formatSummary(stored, serviceName);
        for (const line of lines) context.logger.info(line);

        const handle = await context.writeResource("summary", "summary", {
          printed: true,
          path: stored.path ?? null,
          present: stored.present ?? false,
          version: stored.version ?? null,
          backend: stored.backend ?? null,
          latestVersion: stored.latestVersion ?? null,
          updateAvailable: stored.updateAvailable ?? null,
          lines,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
