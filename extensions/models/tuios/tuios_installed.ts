/**
 * TUIOS installed — tracks which version of TUIOS is currently installed on the
 * machine, installs a verified TUIOS archive, and removes the binary.
 *
 * Resolving a release, selecting the platform archive, downloading it and
 * checksum-verifying it is the job of `@svendowideit/github-release-install`
 * (called by the bundled `tuios-install` workflow). This model does the
 * TUIOS-specific part: it locates and runs the `tuios` binary, and it installs
 * a **verified** archive — extracting the single `tuios` member, checking the
 * bytes against the expected SHA-256 once more, refusing to fight a system
 * package manager, and writing the binary atomically.
 *
 * Methods:
 *   - `sync`      — locate and run `tuios --version`; record path, version,
 *                   backend and presence.
 *   - `install`   — extract the `tuios` binary from the verified archive the
 *                   release workflow produced, verify its SHA-256, and install
 *                   it into the first writable of `/usr/local/bin`,
 *                   `~/.local/bin`, `~/bin`. Idempotent, package-manager aware.
 *   - `uninstall` — remove the binary; idempotent and package-manager aware.
 *   - `print`     — log the stored installed state.
 *
 * The path is resolved in this order: the `path` global argument, then the
 * first of `tuios` on `$PATH`, `~/.local/bin/tuios`, `~/bin/tuios`,
 * `/usr/local/bin/tuios` that exists.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  assertAbsoluteDir,
  detectPackageManagerOwner,
  expandHome,
  extractFromTarGz,
  isOnPath,
  normalizeVersion,
  parseArchiveName,
  parseVersionOutput,
  runCapture,
  selectInstallDir,
  verifySha256,
  versionsEqual,
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
    "Build flavor being tracked: 'std' is the pure-Go emulator, 'ghostty' bundles libghostty-vt. Used for reporting only; the archive is chosen by @svendowideit/github-release-install.",
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
    "Release version being installed (e.g. 0.8.0). Empty reads it from archiveName. Used for the idempotency check and reporting.",
  ),
  archivePath: z.string().default("").describe(
    "Absolute or ~-prefixed path to the checksum-verified archive produced by @svendowideit/github-release-install's download step. Required: install refuses to fetch an unverified archive itself.",
  ),
  archiveName: z.string().default("").describe(
    "Archive file name the release workflow resolved, e.g. tuios_0.8.0_Linux_x86_64.tar.gz. Used to derive the target version.",
  ),
  checksum: z.string().default("").describe(
    "Expected SHA-256 of the archive, recorded by the release workflow. install re-verifies the file against it and refuses a mismatch or an empty checksum.",
  ),
  installDir: z.string().default("").describe(
    "Directory to install the tuios binary into. Empty picks the first writable of /usr/local/bin, ~/.local/bin, ~/bin.",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even when the installed version already equals the target version, and override the package-manager guard.",
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
  archivePath: z.string().nullable(),
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
  checkedAt: z.string(),
});

const PrintResultSchema = z.object({
  printed: z.boolean(),
  path: z.string().nullable(),
  present: z.boolean(),
  version: z.string().nullable(),
  backend: z.string().nullable(),
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
 * model's `serviceName` global, or `null` when the name is empty.
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
  },
  serviceName = "",
): string[] {
  const lines: string[] = [];
  if (!state.present) {
    lines.push(
      `TUIOS is not installed${state.path ? ` (checked ${state.path})` : ""}.`,
    );
    return lines;
  }
  lines.push(`Installed:    ${state.version ?? "unknown"}`);
  if (state.backend) lines.push(`Backend:      ${state.backend}`);
  if (state.path) {
    lines.push(`Binary:       ${state.path}`);
    lines.push(`Check it:     ${state.path} --version`);
  }
  if (serviceName) {
    lines.push(`Service:      ${serviceName}.service (user)`);
    lines.push(`Check it:     systemctl --user status ${serviceName}.service`);
  }
  return lines;
}

/**
 * Derive the target version from an explicit `version` input, falling back to
 * the version embedded in the archive name. Returns `""` when neither yields
 * one (the caller then cannot be idempotent and reports it).
 */
export function targetVersion(version: string, archiveName: string): string {
  const explicit = normalizeVersion(version);
  if (explicit) return explicit;
  return parseArchiveName(archiveName)?.version ?? "";
}

// ---------------------------------------------------------------------------
// Sync implementation
// ---------------------------------------------------------------------------

/**
 * Locate the binary, read its version, and write the `installed` resource.
 * Shared by the `sync` method and by `install`/`uninstall`, which re-sync after
 * changing the binary.
 */
async function performSync(
  context: MethodContext,
  explicitPath: string,
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
      present = true;
      context.logger.warn?.(
        "Could not parse `tuios --version` output: {output}",
        { output: output.slice(0, 200) },
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
    checkedAt: new Date().toISOString(),
  });

  context.logger.info(
    present ? "TUIOS {version} installed at {path}" : "TUIOS not installed",
    {
      version: version ?? "unknown",
      path: path ?? "(not found)",
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

/** Tracks and installs the TUIOS binary on this machine. */
export const model = {
  type: "@svendowideit/tuios-installed",
  version: "2026.09.30.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.30.1",
      description:
        "install now consumes the checksum-verified archive produced by @svendowideit/github-release-install (via the bundled workflow) instead of resolving and downloading the release itself: it takes archivePath/archiveName/checksum/version and no longer takes downloadUrl/releaseVersion/os/arch. Release resolution, platform selection, checksum lookup and download moved to the new extension. New archivePath field on the install resource; installed/print drop the latest-release fields (the release workflow reports those).",
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
      description: "The installed TUIOS version, its backend and resolved path",
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
      description: "The printed installed summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description:
        "Locate the tuios binary, run `tuios --version`, and record the " +
        "installed version, backend and path.",
      arguments: SyncArgsSchema,
      execute: async (
        args: SyncArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const explicit = (args.path ?? "").trim() || context.globalArgs.path;
        return await performSync(context, explicit);
      },
    },

    install: {
      description:
        "Extract the `tuios` binary from the checksum-verified archive the " +
        "release workflow produced, verify it once more, and install it into " +
        "the first writable of /usr/local/bin, ~/.local/bin or ~/bin. " +
        "Idempotent: skips when the target version is already installed unless " +
        "`force` is set. Re-syncs afterwards and records the new state.",
      arguments: InstallArgsSchema,
      execute: async (
        args: InstallArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        assertAbsoluteDir(args.installDir, "installDir");
        assertAbsoluteDir(args.archivePath, "archivePath");
        assertAbsoluteDir(g.path, "path");

        const archivePath = args.archivePath.trim()
          ? expandHome(args.archivePath.trim())
          : "";
        if (!archivePath) {
          throw new Error(
            "install requires a checksum-verified archive: pass archivePath " +
              "(the file @svendowideit/github-release-install's download step " +
              "wrote). Run the bundled tuios-install workflow, which resolves, " +
              "downloads and verifies the archive first.",
          );
        }

        const checksum = args.checksum.trim();
        if (!checksum) {
          throw new Error(
            "No SHA-256 supplied for the archive — refusing to install an " +
              "unverified download. Run the bundled tuios-install workflow, " +
              "which resolves the release and records the checksum.",
          );
        }

        let bytes: Uint8Array;
        try {
          bytes = await Deno.readFile(archivePath);
        } catch (err) {
          throw new Error(
            `Verified archive not found at ${archivePath}: ${
              err instanceof Error ? err.message : String(err)
            }. Run the download step (the bundled workflow does this) first.`,
          );
        }

        // The archive file name carries the version; fall back to the staged
        // file's basename when the caller did not pass archiveName.
        const archiveLabel = args.archiveName.trim() ||
          archivePath.replace(/\\/g, "/").split("/").pop() || archivePath;
        const version = targetVersion(args.version, archiveLabel);

        // 1. Verify the archive bytes against the required checksum before
        //    touching the install directory. An unverified archive is never
        //    installed.
        if (!(await verifySha256(bytes, checksum))) {
          throw new Error(
            `Checksum mismatch for ${args.archiveName || archivePath}: the ` +
              `archive does not match the expected SHA-256 — refusing to install.`,
          );
        }

        // 2. Idempotency: skip when the target version is already at the target
        //    location. When installDir is explicit, only that exact path counts.
        //    Runs before the package-manager guard so an up-to-date
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
        const upToDate = version !== "" && previousVersion !== null &&
          versionsEqual(version, previousVersion);
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
            archiveName: args.archiveName || null,
            archivePath,
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
          await performSync(context, existingPath ?? "");
          return { dataHandles: [handle] };
        }

        // 3. Refuse to overwrite a binary a package manager owns.
        const targetPath = existingPath ??
          `${explicitDir ? expandHome(explicitDir) : selectInstallDir()}/tuios`;
        if (!args.force) {
          const owner = await detectPackageManagerOwner(targetPath);
          if (owner) throw new Error(packageManagedMessage(targetPath, owner));
        }

        // 4. Extract the binary and install it atomically.
        const binary = await extractFromTarGz(bytes, "tuios");
        if (!binary) {
          throw new Error(
            `Archive ${args.archiveName || archivePath} does not contain a ` +
              `'tuios' binary.`,
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
          try {
            await Deno.remove(tmp);
          } catch {
            // already renamed (the normal path) or never created
          }
        }

        context.logger.info(
          "Installed TUIOS {version} to {target}{prev}",
          {
            version: version || archiveLabel,
            target,
            prev: previousVersion ? ` (was ${previousVersion})` : "",
          },
        );
        const onPath = isOnPath(installDir);
        if (!onPath) {
          context.logger.warn?.(
            "{installDir} is not on PATH — add it so the binary resolves",
            { installDir },
          );
        }

        const statusCommand = serviceStatusCommand(context);
        const message =
          `Installed TUIOS ${version || archiveLabel} to ${target}` +
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
          version: version || null,
          previousVersion,
          path: target,
          installDir,
          archiveName: args.archiveName || null,
          archivePath,
          checksumVerified: true,
          onPath,
          bytes: bytes.length,
          installedAt: new Date().toISOString(),
          message,
          versionCommand: `${target} --version`,
          serviceStatusCommand: statusCommand,
        });

        await performSync(context, target);

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

        await performSync(context, target ?? "");

        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Log the stored installed TUIOS state: path, version, backend and " +
        "presence, plus the systemctl status command for the daemon service. " +
        "Run `sync` first.",
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
          lines,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
