/**
 * opencode — install and update the opencode CLI, and manage its themes.
 *
 * Fetching, platform selection, checksum lookup and download are the job of
 * `@svendowideit/github-release-install` (called by the bundled workflow). This
 * model does the opencode-specific part:
 *
 *   - `sync`          — locate the `opencode` binary, run `opencode --version`,
 *                       and record the installed version and path.
 *   - `install`       — extract the `opencode` binary from the verified archive
 *                       the release workflow produced, verify it once more, and
 *                       install it atomically (idempotent, package-manager
 *                       aware).
 *   - `installTheme`  — write a theme JSON into `~/.config/opencode/themes/`.
 *                       Defaults to the bundled `borland_modern_blue`, or takes
 *                       a source path or inline JSON.
 *   - `setTheme`      — select the active theme in `tui.json` (preserving other
 *                       keys); defaults to `borland_modern_blue`.
 *   - `print`         — log the stored installed state and active theme.
 *
 * Installing a theme and selecting it are separate methods, so they can be run
 * independently or together (the `@svendowideit/opencode-theme` workflow does
 * both, gated by inputs).
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  assertAbsoluteDir,
  DEFAULT_THEME,
  detectPackageManagerOwner,
  expandHome,
  extractFromTarGz,
  isOnPath,
  mergeTuiTheme,
  normalizeVersion,
  parseVersionOutput,
  readTuiTheme,
  selectInstallDir,
  themeFilePath,
  themesDir,
  tuiConfigPath,
  validateTheme,
  verifySha256,
  versionsEqual,
} from "./opencode_shared.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  path: z.string().default("").describe(
    "Path to the opencode binary. Empty auto-detects from PATH and the usual install locations.",
  ),
  configDir: z.string().default("~/.config/opencode").describe(
    "opencode config directory holding `themes/` and `tui.json`.",
  ),
  theme: z.string().default(DEFAULT_THEME).describe(
    "Default theme name used by installTheme/setTheme when no theme input is given.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SyncArgsSchema = z.object({
  path: z.string().optional().describe(
    "Override the binary path for this call. Empty uses the model global / auto-detection.",
  ),
});

type SyncArgs = z.infer<typeof SyncArgsSchema>;

const InstallArgsSchema = z.object({
  version: z.string().default("").describe(
    "Release version being installed (e.g. 1.18.33). Empty reads it from archiveName or the release.",
  ),
  archivePath: z.string().default("").describe(
    "Absolute or ~-prefixed path to the checksum-verified archive produced by @svendowideit/github-release-install's download step. Required: install refuses to fetch an unverified archive itself.",
  ),
  archiveName: z.string().default("").describe(
    "Archive file name the release workflow resolved, e.g. opencode-linux-x64.tar.gz.",
  ),
  releaseVersion: z.string().default("").describe(
    "The version the release workflow resolved, e.g. 1.18.33. Used for the idempotency check, since opencode's archive names carry no version.",
  ),
  checksum: z.string().default("").describe(
    "Expected SHA-256 of the archive, recorded by the release workflow. install re-verifies the file against it and refuses a mismatch or an empty checksum.",
  ),
  installDir: z.string().default("").describe(
    "Directory to install the opencode binary into. Empty picks the first writable of ~/.opencode/bin, /usr/local/bin, ~/.local/bin.",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even when the installed version already equals the target version, and override the package-manager guard.",
  ),
});

type InstallArgs = z.infer<typeof InstallArgsSchema>;

const InstallThemeArgsSchema = z.object({
  theme: z.string().default("").describe(
    "Theme name to install (the file is written as <configDir>/themes/<name>.json). Empty uses the model's theme global.",
  ),
  themePath: z.string().default("").describe(
    "Path to a theme JSON file to install. Empty uses the bundled theme named by `theme`.",
  ),
  themeJson: z.string().default("").describe(
    "Inline theme JSON to install. Wins over themePath and the bundled theme.",
  ),
  force: z.boolean().default(false).describe(
    "Overwrite an existing theme file even when its content already matches.",
  ),
});

type InstallThemeArgs = z.infer<typeof InstallThemeArgsSchema>;

const SetThemeArgsSchema = z.object({
  theme: z.string().default("").describe(
    "Theme name to select in tui.json. Empty uses the model's theme global.",
  ),
  createTui: z.boolean().default(true).describe(
    "Create tui.json when it does not exist. When false, a missing file is left alone.",
  ),
});

type SetThemeArgs = z.infer<typeof SetThemeArgsSchema>;

const PrintArgsSchema = z.object({
  theme: z.string().default("").describe(
    "Override the model's theme global for this call when reporting the active theme.",
  ),
});

type PrintArgs = z.infer<typeof PrintArgsSchema>;

const InstalledResultSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  version: z.string().nullable(),
  rawVersionOutput: z.string().nullable(),
  checkedAt: z.string(),
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
});

const ThemeResultSchema = z.object({
  installed: z.boolean(),
  skipped: z.boolean(),
  theme: z.string(),
  path: z.string(),
  source: z.string(),
  bytes: z.number(),
  installedAt: z.string(),
  message: z.string(),
});

const SetThemeResultSchema = z.object({
  changed: z.boolean(),
  theme: z.string(),
  previousTheme: z.string().nullable(),
  tuiPath: z.string(),
  present: z.boolean(),
  setAt: z.string(),
  message: z.string(),
});

const PrintResultSchema = z.object({
  printed: z.boolean(),
  path: z.string().nullable(),
  present: z.boolean(),
  version: z.string().nullable(),
  theme: z.string().nullable(),
  themeInstalled: z.boolean(),
  tuiPath: z.string(),
  lines: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  repoDir?: string;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
    warn?: (message: string, properties?: Record<string, unknown>) => void;
    debug?: (message: string, properties?: Record<string, unknown>) => void;
  };
  extensionFile?: (relPath: string) => string;
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

/** The auto-detection candidates for the `opencode` binary, in priority order. */
export function searchPaths(home?: string): string[] {
  const h = home ?? Deno.env.get("HOME") ?? "";
  return [
    "opencode",
    `${h}/.opencode/bin/opencode`,
    `${h}/.local/bin/opencode`,
    "/usr/local/bin/opencode",
  ];
}

/** Locate a runnable `opencode` binary. An explicit path is authoritative. */
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

/** Run `opencode --version` and return stdout+stderr and the exit code. */
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
  return `The opencode binary at ${path} is owned by ${owner}. Installing ` +
    `over it (or removing it) would fight the package manager. Upgrade with ` +
    `the package manager instead, or pass force=true to override.`;
}

/** Render the human-readable summary lines for `print`. */
export function formatSummary(state: {
  path?: string | null;
  present?: boolean;
  version?: string | null;
  theme?: string | null;
  themeInstalled?: boolean;
  tuiPath?: string;
}): string[] {
  const lines: string[] = [];
  if (!state.present) {
    lines.push(
      `opencode is not installed${
        state.path ? ` (checked ${state.path})` : ""
      }.`,
    );
  } else {
    lines.push(`Installed:    ${state.version ?? "unknown"}`);
    if (state.path) {
      lines.push(`Binary:       ${state.path}`);
      lines.push(`Check it:     ${state.path} --version`);
    }
  }
  if (state.theme) {
    lines.push(
      `Theme:        ${state.theme}${
        state.themeInstalled ? " (installed)" : " (not installed)"
      }`,
    );
  }
  if (state.tuiPath) lines.push(`TUI config:   ${state.tuiPath}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

type CheckContext = {
  globalArgs: GlobalArgs;
  methodName: string;
};

/** Installs and updates opencode, and manages its themes. */
export const model = {
  type: "@svendowideit/opencode",
  version: "2026.09.30.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-install-dir": {
      description:
        "Validate the configured `path` global is absolute or ~-prefixed before mutating the filesystem",
      labels: ["policy"],
      appliesTo: ["install"],
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
      description: "The installed opencode version and its resolved path",
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
    theme: {
      description: "The result of the last theme install",
      schema: ThemeResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    setTheme: {
      description: "The result of the last theme selection",
      schema: SetThemeResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "The printed installed/theme summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description:
        "Locate the opencode binary, run `opencode --version`, and record " +
        "the installed version and path.",
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
        "Extract the `opencode` binary from the checksum-verified archive the " +
        "release workflow produced, verify it once more, and install it into " +
        "the first writable of ~/.opencode/bin, /usr/local/bin or ~/.local/bin. " +
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
              "wrote). Run the bundled opencode-install workflow, which " +
              "resolves, downloads and verifies the archive first.",
          );
        }

        const checksum = args.checksum.trim();
        if (!checksum) {
          throw new Error(
            "No SHA-256 supplied for the archive — refusing to install an " +
              "unverified download. Run the bundled opencode-install workflow, " +
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

        // opencode's asset names carry no version, so the target version comes
        // from an explicit `version`, else the version the release workflow
        // resolved (`releaseVersion`).
        const version = normalizeVersion(args.version) ||
          normalizeVersion(args.releaseVersion);
        const archiveLabel = args.archiveName.trim() ||
          archivePath.replace(/\\/g, "/").split("/").pop() || archivePath;

        if (!(await verifySha256(bytes, checksum))) {
          throw new Error(
            `Checksum mismatch for ${archiveLabel}: the archive does not match ` +
              `the expected SHA-256 — refusing to install.`,
          );
        }

        // Idempotency: skip when the target version is already installed.
        const explicitDir = args.installDir.trim();
        const existingPath = explicitDir
          ? await existingBinary(`${expandHome(explicitDir)}/opencode`)
          : await findBinary(g.path);
        let previousVersion: string | null = null;
        if (existingPath) {
          previousVersion = parseVersionOutput(
            (await runVersion(existingPath)).output,
          );
        }
        const upToDate = version !== "" && previousVersion !== null &&
          versionsEqual(version, previousVersion);
        if (upToDate && !args.force) {
          const message =
            `opencode ${previousVersion} is already installed at ${existingPath}; ` +
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
          });
          await performSync(context, existingPath ?? "");
          return { dataHandles: [handle] };
        }

        // Refuse to overwrite a binary a package manager owns.
        const targetPath = existingPath ??
          `${
            explicitDir ? expandHome(explicitDir) : selectInstallDir()
          }/opencode`;
        if (!args.force) {
          const owner = await detectPackageManagerOwner(targetPath);
          if (owner) throw new Error(packageManagedMessage(targetPath, owner));
        }

        const binary = await extractFromTarGz(bytes, "opencode");
        if (!binary) {
          throw new Error(
            `Archive ${archiveLabel} does not contain an 'opencode' binary.`,
          );
        }
        const installDir = args.installDir.trim()
          ? expandHome(args.installDir.trim())
          : selectInstallDir();
        await Deno.mkdir(installDir, { recursive: true });
        const target = `${installDir.replace(/\/+$/, "")}/opencode`;
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

        context.logger.info("Installed opencode {version} to {target}{prev}", {
          version: version || archiveLabel,
          target,
          prev: previousVersion ? ` (was ${previousVersion})` : "",
        });
        const onPath = isOnPath(installDir);
        if (!onPath) {
          context.logger.warn?.(
            "{installDir} is not on PATH — add it so the binary resolves",
            { installDir },
          );
        }

        const message =
          `Installed opencode ${version || archiveLabel} to ${target}` +
          (previousVersion ? ` (was ${previousVersion})` : "") +
          (onPath ? "" : `; note: ${installDir} is not on PATH`);
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
        });

        await performSync(context, target);

        return { dataHandles: [handle] };
      },
    },

    installTheme: {
      description:
        "Write a theme JSON into <configDir>/themes/<name>.json. Defaults to " +
        "the bundled `borland_modern_blue`; pass themePath or themeJson to " +
        "install another. Idempotent: an existing identical file is left " +
        "alone unless force is set. Installing and selecting are separate — " +
        "run setTheme to activate it.",
      arguments: InstallThemeArgsSchema,
      execute: async (
        args: InstallThemeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const themeName = (args.theme.trim() || g.theme).trim();
        if (!themeName) {
          throw new Error(
            "installTheme requires a theme name (pass theme or set the theme global).",
          );
        }
        assertAbsoluteDir(args.themePath, "themePath");
        const configDir = expandHome(g.configDir);
        const target = themeFilePath(configDir, themeName);

        // Resolve the theme body: inline JSON > explicit path > bundled default.
        let raw: string;
        let source: string;
        if (args.themeJson.trim()) {
          raw = args.themeJson;
          source = "inline";
        } else if (args.themePath.trim()) {
          const path = expandHome(args.themePath.trim());
          try {
            raw = await Deno.readTextFile(path);
          } catch (err) {
            throw new Error(
              `theme file not found at ${path}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          source = path;
        } else {
          if (!context.extensionFile) {
            throw new Error(
              `no bundled theme available for '${themeName}': pass themePath ` +
                `or themeJson (the bundled borland_modern_blue is available ` +
                `only when the extension is loaded).`,
            );
          }
          const bundled = context.extensionFile(`themes/${themeName}.json`);
          try {
            raw = await Deno.readTextFile(bundled);
          } catch (err) {
            throw new Error(
              `no bundled theme named '${themeName}': ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          source = `bundled:${themeName}`;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new Error(
            `theme '${themeName}' is not valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        validateTheme(themeName, parsed);
        const body = `${JSON.stringify(parsed, null, 2)}\n`;

        // Idempotency: an identical existing file is left alone.
        let existing: string | null = null;
        try {
          existing = await Deno.readTextFile(target);
        } catch {
          existing = null;
        }
        const unchanged = existing === body;
        if (unchanged && !args.force) {
          const message = `Theme '${themeName}' already installed at ${target}`;
          context.logger.info(message);
          const handle = await context.writeResource("theme", "theme", {
            installed: false,
            skipped: true,
            theme: themeName,
            path: target,
            source,
            bytes: body.length,
            installedAt: new Date().toISOString(),
            message,
          });
          return { dataHandles: [handle] };
        }

        await Deno.mkdir(themesDir(configDir), { recursive: true });
        const tmp = `${target}.new-${crypto.randomUUID()}`;
        try {
          await Deno.writeTextFile(tmp, body);
          await Deno.rename(tmp, target);
        } finally {
          try {
            await Deno.remove(tmp);
          } catch {
            // already renamed, or never created
          }
        }

        const message = `Installed theme '${themeName}' to ${target}`;
        context.logger.info(message);
        const handle = await context.writeResource("theme", "theme", {
          installed: true,
          skipped: false,
          theme: themeName,
          path: target,
          source,
          bytes: body.length,
          installedAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    setTheme: {
      description:
        "Select the active theme in <configDir>/tui.json, preserving any other " +
        "keys. Defaults to the model's theme global (borland_modern_blue). " +
        "Idempotent: re-selecting the current theme records changed=false.",
      arguments: SetThemeArgsSchema,
      execute: async (
        args: SetThemeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const themeName = (args.theme.trim() || g.theme).trim();
        if (!themeName) {
          throw new Error(
            "setTheme requires a theme name (pass theme or set the theme global).",
          );
        }
        const configDir = expandHome(g.configDir);
        const tuiPath = tuiConfigPath(configDir);
        let existing: string | null = null;
        try {
          existing = await Deno.readTextFile(tuiPath);
        } catch {
          existing = null;
        }
        if (existing === null && !args.createTui) {
          throw new Error(
            `${tuiPath} does not exist and createTui=false`,
          );
        }
        const previousTheme = readTuiTheme(existing);
        const changed = previousTheme !== themeName;
        if (changed) {
          await Deno.mkdir(configDir, { recursive: true });
          const tmp = `${tuiPath}.new-${crypto.randomUUID()}`;
          try {
            await Deno.writeTextFile(tmp, mergeTuiTheme(existing, themeName));
            await Deno.rename(tmp, tuiPath);
          } finally {
            try {
              await Deno.remove(tmp);
            } catch {
              // already renamed, or never created
            }
          }
        }

        const message = changed
          ? previousTheme
            ? `Set opencode theme to '${themeName}' (was '${previousTheme}') in ${tuiPath}`
            : `Set opencode theme to '${themeName}' in ${tuiPath}`
          : `opencode theme is already '${themeName}' in ${tuiPath}`;
        context.logger.info(message);
        const handle = await context.writeResource("setTheme", "setTheme", {
          changed,
          theme: themeName,
          previousTheme,
          tuiPath,
          present: true,
          setAt: new Date().toISOString(),
          message,
        });
        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Log the stored opencode state: the binary path and version, whether " +
        "the theme is installed, and the active theme in tui.json. Run `sync` " +
        "first.",
      arguments: PrintArgsSchema,
      execute: async (
        args: PrintArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const stored = await context.readResource("installed") as {
          path?: string;
          present?: boolean;
          version?: string | null;
        } | null;
        const themeName = (args.theme.trim() || g.theme).trim();
        const configDir = expandHome(g.configDir);
        const tuiPath = tuiConfigPath(configDir);

        let themeInstalled = false;
        if (themeName) {
          try {
            await Deno.stat(themeFilePath(configDir, themeName));
            themeInstalled = true;
          } catch {
            themeInstalled = false;
          }
        }

        const lines = formatSummary({
          path: stored?.path ?? null,
          present: stored?.present ?? false,
          version: stored?.version ?? null,
          theme: themeName || null,
          themeInstalled,
          tuiPath,
        });
        for (const line of lines) context.logger.info(line);

        const handle = await context.writeResource("summary", "summary", {
          printed: true,
          path: stored?.path ?? null,
          present: stored?.present ?? false,
          version: stored?.version ?? null,
          theme: themeName || null,
          themeInstalled,
          tuiPath,
          lines,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Sync implementation
// ---------------------------------------------------------------------------

/**
 * Locate the binary, read its version, and write the `installed` resource.
 * Shared by `sync` and by `install`, which re-syncs after replacing the binary.
 */
async function performSync(
  context: MethodContext,
  explicitPath: string,
): Promise<{ dataHandles: [{ name: string }] }> {
  const path = await findBinary(explicitPath);
  let present = false;
  let version: string | null = null;
  let rawVersionOutput: string | null = null;

  if (path) {
    const { output, code } = await runVersion(path);
    rawVersionOutput = output;
    const parsed = parseVersionOutput(output);
    if (parsed) {
      present = true;
      version = parsed;
    } else if (code === 0) {
      present = true;
      context.logger.warn?.(
        "Could not parse `opencode --version` output: {output}",
        { output: output.slice(0, 200) },
      );
    }
  }

  const handle = await context.writeResource("installed", "installed", {
    path: path ?? "",
    present,
    version,
    rawVersionOutput,
    checkedAt: new Date().toISOString(),
  });

  context.logger.info(
    present
      ? "opencode {version} installed at {path}"
      : "opencode not installed",
    { version: version ?? "unknown", path: path ?? "(not found)" },
  );

  return { dataHandles: [handle] };
}
