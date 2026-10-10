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
  BUNDLED_THEMES,
  DEFAULT_THEME,
  detectPackageManagerOwner,
  expandHome,
  extractFromTarGz,
  isOnPath,
  normalizeVersion,
  parseArchiveName,
  parseTheme,
  parseVersionOutput,
  readConfiguredTheme,
  runCapture,
  selectInstallDir,
  setConfiguredTheme,
  themeFileName,
  tuiosCacheDir,
  tuiosConfigPath,
  tuiosThemesDir,
  verifySha256,
  versionsEqual,
} from "./tuios_shared.ts";
import {
  buildReport,
  normalizeTheme,
  readSelectionColors,
  renderThemeReportHtml,
  themeFromListThemes,
} from "./theme_report.ts";

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

const ThemeIdSchema = z.string().min(1).regex(
  /^[A-Za-z0-9_.-]+$/,
  "theme id may contain only letters, digits, '.', '_' and '-'",
);

const InstallThemeArgsSchema = z.object({
  themeId: ThemeIdSchema.describe(
    "Theme id to install. Bundled themes shipped with this extension are swamp_club and borland_modern_blue; any other id is written from `themeJson` or from `sourcePath`.",
  ),
  themeJson: z.string().default("").describe(
    "Theme JSON document to write as themes/<themeId>.json. Empty loads a bundled theme of the same id, or reads `sourcePath` when given.",
  ),
  sourcePath: z.string().default("").describe(
    "Path to a theme JSON file to install when `themeJson` is empty. Absolute or ~-prefixed.",
  ),
  themesDir: z.string().default("").describe(
    "Override the TUIOS themes directory. Empty uses $XDG_CONFIG_HOME/tuios/themes, falling back to ~/.config/tuios/themes.",
  ),
  select: z.boolean().default(false).describe(
    "Also set `appearance.theme` in config.toml to this theme id.",
  ),
  force: z.boolean().default(false).describe(
    "Write the theme file even when an identical file is already present.",
  ),
  configPath: z.string().default("").describe(
    "Override the TUIOS config.toml path used when `select` is true.",
  ),
});
type InstallThemeArgs = z.infer<typeof InstallThemeArgsSchema>;

const SetThemeArgsSchema = z.object({
  themeId: ThemeIdSchema.describe(
    "Theme id to make active (written to `appearance.theme`).",
  ),
  configPath: z.string().default("").describe(
    "Override the TUIOS config.toml path. Empty uses $XDG_CONFIG_HOME/tuios/config.toml, falling back to ~/.config/tuios/config.toml.",
  ),
});
type SetThemeArgs = z.infer<typeof SetThemeArgsSchema>;

const RenderThemeReportArgsSchema = z.object({
  themeId: z.string().default("").describe(
    "Theme id to report on. Empty reports the currently selected theme (`appearance.theme` in config.toml). A theme installed as a file is read directly; a built-in theme is read from `tuios list-themes <id> --json`.",
  ),
  themesDir: z.string().default("").describe(
    "Override the TUIOS themes directory. Empty uses $XDG_CONFIG_HOME/tuios/themes, falling back to ~/.config/tuios/themes.",
  ),
  configPath: z.string().default("").describe(
    "Override the TUIOS config.toml path used to find the selected theme and the selection colours. Empty uses the standard location.",
  ),
  outputPath: z.string().default("").describe(
    "Where to write the HTML report (absolute or ~-prefixed). Empty writes <cache>/tuios/theme-<id>.html ($XDG_CACHE_HOME, else ~/.cache).",
  ),
  open: z.boolean().default(false).describe(
    "Open the written report in the default browser (best-effort; xdg-open/open).",
  ),
});
type RenderThemeReportArgs = z.infer<typeof RenderThemeReportArgsSchema>;

const InstallBundledThemesArgsSchema = z.object({
  themes: z.array(ThemeIdSchema).default([...BUNDLED_THEMES]).describe(
    "Bundled theme ids to install. Defaults to every theme this extension ships.",
  ),
  themesDir: z.string().default("").describe(
    "Override the TUIOS themes directory. Empty uses $XDG_CONFIG_HOME/tuios/themes, falling back to ~/.config/tuios/themes.",
  ),
  defaultTheme: z.string().default(DEFAULT_THEME).describe(
    "Theme to select by default when the user has not chosen one yet (config.toml `appearance.theme` is absent or empty).",
  ),
  force: z.boolean().default(false).describe(
    "Rewrite theme files even when identical content is already present.",
  ),
  configPath: z.string().default("").describe(
    "Override the TUIOS config.toml path checked before setting the default theme.",
  ),
});
type InstallBundledThemesArgs = z.infer<typeof InstallBundledThemesArgsSchema>;

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

const InstallThemeResultSchema = z.object({
  installed: z.boolean(),
  skipped: z.boolean(),
  themeId: z.string(),
  themeFile: z.string(),
  themesDir: z.string(),
  selected: z.boolean(),
  previousTheme: z.string(),
  message: z.string(),
  installedAt: z.string(),
});

const SetThemeResultSchema = z.object({
  themeId: z.string(),
  configPath: z.string(),
  previousTheme: z.string(),
  changed: z.boolean(),
  present: z.boolean(),
  message: z.string(),
  setAt: z.string(),
});

const InstallThemesResultSchema = z.object({
  installed: z.array(z.string()),
  skipped: z.array(z.string()),
  defaultTheme: z.string(),
  selected: z.boolean(),
  selectedTheme: z.string(),
  previousTheme: z.string(),
  themesDir: z.string(),
  configPath: z.string(),
  message: z.string(),
  installedAt: z.string(),
});

const ThemeReportResultSchema = z.object({
  themeId: z.string(),
  displayName: z.string(),
  dark: z.boolean(),
  source: z.string(),
  outputPath: z.string(),
  bytes: z.number(),
  illegible: z.array(z.string()),
  opened: z.boolean(),
  generatedAt: z.string(),
  message: z.string(),
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
  extensionFile: (relativePath: string) => string;
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
// Theme helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Resolve the theme JSON to install from the explicit `themeJson`, a
 * `sourcePath`, or a bundled theme file, in that order. Returns the parsed
 * theme plus the raw text, or `null` when none was provided. Throws when a
 * non-empty source names no readable, valid theme — a bad theme is never
 * silently written.
 */
export async function resolveThemeContent(
  args: { themeId: string; themeJson: string; sourcePath: string },
  bundledPath: (relativePath: string) => string,
): Promise<
  { content: string; theme: Record<string, unknown>; source: string } | null
> {
  let content: string | null = null;
  let source = "";

  const inline = args.themeJson.trim();
  if (inline) {
    content = inline;
    source = "inline themeJson";
  } else if (args.sourcePath.trim()) {
    const path = expandHome(args.sourcePath.trim());
    try {
      content = await Deno.readTextFile(path);
    } catch (err) {
      throw new Error(
        `Theme source not found at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    source = path;
  } else if ((BUNDLED_THEMES as readonly string[]).includes(args.themeId)) {
    const path = bundledPath(`themes/${themeFileName(args.themeId)}`);
    try {
      content = await Deno.readTextFile(path);
    } catch (err) {
      throw new Error(
        `Bundled theme ${args.themeId} not found at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    source = `bundled ${args.themeId}`;
  } else {
    return null;
  }

  const theme = parseTheme(content);
  if (!theme) {
    throw new Error(
      `Not a valid TUIOS theme (${source}): expected a JSON object with a non-empty string "id" and string colour values.`,
    );
  }
  return { content, theme, source };
}

/** Read the `appearance.theme` currently set in config.toml, or `""`. */
export async function configuredTheme(configPath: string): Promise<string> {
  try {
    return readConfiguredTheme(await Deno.readTextFile(configPath));
  } catch {
    return "";
  }
}

/** Write a TUIOS theme file, skipping when identical (unless `force`). */
export async function writeThemeFile(
  path: string,
  content: string,
  force: boolean,
): Promise<{ changed: boolean }> {
  if (!force) {
    try {
      if ((await Deno.readTextFile(path)) === content) {
        return { changed: false };
      }
    } catch {
      // no existing file — write it
    }
  }
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  const tmp = `${path}.new-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tmp, content);
    await Deno.rename(tmp, path);
  } finally {
    try {
      await Deno.remove(tmp);
    } catch {
      // renamed (the normal path) or never created
    }
  }
  return { changed: true };
}

/**
 * Set `appearance.theme` in config.toml, creating the file (and the
 * `[appearance]` table) when needed. Returns the previous value and whether
 * the file changed. Throws on a config.toml that exists but cannot be read.
 */
export async function setThemeInConfig(
  configPath: string,
  themeId: string,
): Promise<{ previous: string; changed: boolean }> {
  let existing = "";
  let present = true;
  try {
    existing = await Deno.readTextFile(configPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) present = false;
    else {
      throw new Error(
        `Could not read ${configPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const previous = present ? readConfiguredTheme(existing) : "";
  const next = setConfiguredTheme(existing, themeId);
  if (present && next === existing) return { previous, changed: false };
  await Deno.mkdir(configPath.replace(/\/[^/]+$/, ""), { recursive: true });
  const tmp = `${configPath}.new-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tmp, next);
    await Deno.rename(tmp, configPath);
  } finally {
    try {
      await Deno.remove(tmp);
    } catch {
      // renamed (the normal path) or never created
    }
  }
  return { previous, changed: true };
}

/**
 * The default path for the HTML theme report: `<cache>/tuios/theme-<id>.html`
 * under `$XDG_CACHE_HOME` (else `~/.cache`). Keeps a generated report out of
 * the TUIOS config directory and off the repo.
 */
export function defaultReportPath(themeId: string): string {
  const stem = themeFileName(themeId).replace(/\.json$/, "");
  return `${tuiosCacheDir()}/theme-${stem}.html`;
}

/**
 * Open a file in the desktop's default application, best-effort. Spawns the
 * platform opener (`xdg-open`, `open`, or `cmd /c start`) and returns whether
 * one was launched; a failure is reported, never thrown.
 */
export function openInBrowser(path: string): boolean {
  const command: [string, string[]] = Deno.build.os === "darwin"
    ? ["open", [path]]
    : Deno.build.os === "windows"
    ? ["cmd", ["/c", "start", "", path]]
    : ["xdg-open", [path]];
  try {
    const proc = new Deno.Command(command[0], {
      args: command[1],
      stdout: "null",
      stderr: "null",
    }).spawn();
    proc.unref();
    return true;
  } catch {
    return false;
  }
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
  version: "2026.10.10.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.30.2",
      description:
        "install now consumes the checksum-verified archive produced by @svendowideit/github-release-install (via the bundled workflow) instead of resolving and downloading the release itself: it takes archivePath/archiveName/checksum/version and no longer takes downloadUrl/releaseVersion/os/arch. Release resolution, platform selection, checksum lookup and download moved to the new extension. New archivePath field on the install resource; installed/print drop the latest-release fields (the release workflow reports those).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.30.3",
      description:
        "Adds TUIOS theme management: installTheme writes a theme file (inline, from a path, or a bundled swamp_club/borland_modern_blue), setTheme sets appearance.theme in config.toml, and installBundledThemes installs both bundled themes and selects swamp_club only when the user has not chosen one. New theme, themeSelection and themes resources; the bundled tuios-install workflow now installs the themes, and a new reusable tuios-theme workflow wraps installTheme + setTheme.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.10.1",
      description:
        "Adds renderThemeReport: writes a self-contained HTML document that " +
        "documents every colour a TUIOS theme sets and what each is used for — " +
        "the 16 ANSI slots with roles and measured contrast, the derived chrome " +
        "accents (or the theme's chrome values), the dialog ramp with ink tiers, " +
        "and the selection colours. Defaults to the currently selected theme; " +
        "reads a theme file, or the built-in palette from `tuios list-themes " +
        "<id> --json`. New themeReport resource and theme_report module. Also " +
        "lifts three bundled Borland Modern Blue colours so they clear their " +
        "floor on the blue background: red (now #ff5757, from the old " +
        "bright_red), bright_red (now the orange #ff8c00), and blue (now the " +
        "azure #1e90ff, which was identical to the background and made the " +
        "shell prompt invisible).",
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
    theme: {
      description: "The result of the last theme install / selection",
      schema: InstallThemeResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    themeSelection: {
      description: "The result of the last `setTheme` call",
      schema: SetThemeResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    themes: {
      description: "The result of the last `installBundledThemes` call",
      schema: InstallThemesResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    themeReport: {
      description: "The result of the last `renderThemeReport` call",
      schema: ThemeReportResultSchema,
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

    installTheme: {
      description:
        "Write one TUIOS theme as `<themesDir>/<themeId>.json`, from an inline " +
        "`themeJson`, a `sourcePath`, or the bundled themes this extension " +
        "ships (swamp_club, borland_modern_blue). Idempotent: an identical file " +
        "is left alone unless `force` is set. TUIOS re-reads the themes " +
        "directory on every call, so the theme is selectable immediately. With " +
        "`select=true` it also sets `appearance.theme` in config.toml.",
      arguments: InstallThemeArgsSchema,
      execute: async (
        args: InstallThemeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        assertAbsoluteDir(args.sourcePath, "sourcePath");
        assertAbsoluteDir(args.themesDir, "themesDir");
        assertAbsoluteDir(args.configPath, "configPath");

        const themesDir = args.themesDir.trim()
          ? expandHome(args.themesDir.trim())
          : tuiosThemesDir();
        const resolved = await resolveThemeContent(
          args,
          (rel) => context.extensionFile(rel),
        );
        if (!resolved) {
          throw new Error(
            `No theme content for '${args.themeId}': pass themeJson, a ` +
              `sourcePath, or one of the bundled theme ids ` +
              `(${BUNDLED_THEMES.join(", ")}).`,
          );
        }

        const themeFile = `${themesDir}/${themeFileName(args.themeId)}`;
        const { changed } = await writeThemeFile(
          themeFile,
          resolved.content,
          args.force,
        );

        let selected = false;
        let previousTheme = "";
        const configPath = args.configPath.trim()
          ? expandHome(args.configPath.trim())
          : tuiosConfigPath();
        if (args.select) {
          previousTheme = await configuredTheme(configPath);
          await setThemeInConfig(configPath, args.themeId);
          selected = true;
        }

        const message = changed
          ? `Installed TUIOS theme '${args.themeId}' to ${themeFile}` +
            (selected ? `; selected it in ${configPath}` : "")
          : `TUIOS theme '${args.themeId}' already present at ${themeFile}` +
            (selected ? `; selected it in ${configPath}` : "");
        context.logger.info(message);

        const handle = await context.writeResource("theme", "theme", {
          installed: changed,
          skipped: !changed,
          themeId: args.themeId,
          themeFile,
          themesDir,
          selected,
          previousTheme,
          message,
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    setTheme: {
      description:
        "Set `appearance.theme` in the TUIOS config.toml to a theme id, so " +
        "TUIOS uses it (the file is watched; no restart needed). Creates " +
        "config.toml and the `[appearance]` table when they are absent. " +
        "Idempotent: re-selecting the current theme leaves the file untouched.",
      arguments: SetThemeArgsSchema,
      execute: async (
        args: SetThemeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        assertAbsoluteDir(args.configPath, "configPath");
        const configPath = args.configPath.trim()
          ? expandHome(args.configPath.trim())
          : tuiosConfigPath();

        const { previous, changed } = await setThemeInConfig(
          configPath,
          args.themeId,
        );
        const message = changed
          ? `Set TUIOS theme to '${args.themeId}' in ${configPath}` +
            (previous ? ` (was '${previous}')` : "")
          : `TUIOS theme is already '${args.themeId}' in ${configPath}`;
        context.logger.info(message);

        const handle = await context.writeResource(
          "themeSelection",
          "set-theme",
          {
            themeId: args.themeId,
            configPath,
            previousTheme: previous,
            changed,
            present: true,
            message,
            setAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    installBundledThemes: {
      description:
        "Install every theme this extension ships (default swamp_club and " +
        "borland_modern_blue) into the TUIOS themes directory, then — only if " +
        "the user has not chosen a theme yet (`appearance.theme` absent or " +
        "empty) — select `defaultTheme` in config.toml. An existing user " +
        "choice is never overwritten. Idempotent. This is the step the bundled " +
        "install workflow runs.",
      arguments: InstallBundledThemesArgsSchema,
      execute: async (
        args: InstallBundledThemesArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        assertAbsoluteDir(args.themesDir, "themesDir");
        assertAbsoluteDir(args.configPath, "configPath");

        const themesDir = args.themesDir.trim()
          ? expandHome(args.themesDir.trim())
          : tuiosThemesDir();
        const configPath = args.configPath.trim()
          ? expandHome(args.configPath.trim())
          : tuiosConfigPath();

        const installed: string[] = [];
        const skipped: string[] = [];
        for (const id of args.themes) {
          const resolved = await resolveThemeContent(
            { themeId: id, themeJson: "", sourcePath: "" },
            (rel) => context.extensionFile(rel),
          );
          if (!resolved) {
            throw new Error(
              `Theme '${id}' is not bundled with this extension ` +
                `(bundled: ${BUNDLED_THEMES.join(", ")}).`,
            );
          }
          const { changed } = await writeThemeFile(
            `${themesDir}/${themeFileName(id)}`,
            resolved.content,
            args.force,
          );
          (changed ? installed : skipped).push(id);
        }

        const previousTheme = await configuredTheme(configPath);
        let selected = false;
        if (previousTheme === "") {
          await setThemeInConfig(configPath, args.defaultTheme);
          selected = true;
        }

        const message =
          `Themes installed: ${installed.join(", ") || "(none)"}` +
          `; already present: ${skipped.join(", ") || "(none)"}` +
          (selected
            ? `; selected default '${args.defaultTheme}' (no theme was set)`
            : `; kept the user's chosen theme '${previousTheme}'`);
        context.logger.info(message);

        const handle = await context.writeResource("themes", "themes", {
          installed,
          skipped,
          defaultTheme: args.defaultTheme,
          selected,
          selectedTheme: selected ? args.defaultTheme : previousTheme,
          previousTheme,
          themesDir,
          configPath,
          message,
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    renderThemeReport: {
      description:
        "Write a self-contained HTML document that documents every colour a " +
        "TUIOS theme sets and what each one is used for: the 16 ANSI slots " +
        "with their roles and measured contrast, the interface accents TUIOS " +
        "derives from them (or the theme's own `chrome` values), the dialog " +
        "ramp with its ink tiers, and the selection colours. Defaults to the " +
        "currently selected theme (`appearance.theme`). A theme installed as a " +
        "file is read directly; a built-in theme is read from `tuios " +
        "list-themes <id> --json`. Writes to `theme-<id>.html` under the TUIOS " +
        "cache directory unless `outputPath` is given.",
      arguments: RenderThemeReportArgsSchema,
      execute: async (
        args: RenderThemeReportArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        assertAbsoluteDir(args.themesDir, "themesDir");
        assertAbsoluteDir(args.configPath, "configPath");
        assertAbsoluteDir(args.outputPath, "outputPath");

        const themesDir = args.themesDir.trim()
          ? expandHome(args.themesDir.trim())
          : tuiosThemesDir();
        const configPath = args.configPath.trim()
          ? expandHome(args.configPath.trim())
          : tuiosConfigPath();

        let configText = "";
        try {
          configText = await Deno.readTextFile(configPath);
        } catch {
          configText = "";
        }

        const themeId = args.themeId.trim() || readConfiguredTheme(configText);
        if (!themeId) {
          throw new Error(
            "No theme selected: pass themeId, or set `appearance.theme` in " +
              "config.toml (use setTheme or installBundledThemes first).",
          );
        }

        // Prefer the theme file (it may carry a `chrome` object); fall back to
        // the binary, which knows the built-in themes and their resolved palette.
        let raw: Record<string, unknown> | null = null;
        let source = "";
        const themeFile = `${themesDir}/${themeFileName(themeId)}`;
        try {
          raw = parseTheme(await Deno.readTextFile(themeFile));
          if (raw) source = themeFile;
        } catch {
          raw = null;
        }
        if (!raw) {
          const binary = await findBinary(g.path);
          if (binary) {
            const { stdout, code } = await runCapture(binary, [
              "list-themes",
              themeId,
              "--json",
            ]);
            if (code === 0) {
              raw = themeFromListThemes(stdout, themeId);
              if (raw) source = `${binary} list-themes ${themeId} --json`;
            }
          }
        }
        if (!raw) {
          throw new Error(
            `No theme '${themeId}' found: no file at ${themeFile}, and no ` +
              `built-in theme of that id was reported. Install it with ` +
              `installTheme, or report one that exists.`,
          );
        }

        const theme = normalizeTheme(raw);
        const model = buildReport(theme, readSelectionColors(configText));
        const html = renderThemeReportHtml(model);

        const outputPath = args.outputPath.trim()
          ? expandHome(args.outputPath.trim())
          : defaultReportPath(theme.id);
        await Deno.mkdir(outputPath.replace(/\/[^/]+$/, ""), {
          recursive: true,
        });
        await Deno.writeTextFile(outputPath, html);

        const opened = args.open ? openInBrowser(outputPath) : false;
        const message =
          `Wrote a colour report for theme '${theme.id}' to ${outputPath}: ` +
          `${model.palette.length} ANSI slots, ` +
          `${model.illegible.length} below their floor on the background` +
          (args.open ? opened ? "; opened it" : "; could not open it" : "");
        context.logger.info(message);

        const handle = await context.writeResource(
          "themeReport",
          "theme-report",
          {
            themeId: theme.id,
            displayName: theme.displayName,
            dark: theme.dark,
            source,
            outputPath,
            bytes: new TextEncoder().encode(html).length,
            illegible: model.illegible,
            opened,
            generatedAt: new Date().toISOString(),
            message,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
