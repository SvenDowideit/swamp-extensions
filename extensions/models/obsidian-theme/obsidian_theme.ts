/**
 * `@svendowideit/obsidian-theme` — install, list and select Obsidian themes.
 *
 * Obsidian discovers a theme from a folder under `.obsidian/themes/<name>/`
 * containing `theme.css` (and usually `manifest.json`), and activates it via
 * the `cssTheme` key in `.obsidian/appearance.json`. This model makes that a
 * safe, repeatable operation for the themes this extension ships:
 *
 *   - `setup`    read-only discovery of the vault, installed themes and active theme
 *   - `install`  write one or every bundled theme into the vault
 *   - `list`     report every installed theme and which one is active
 *   - `select`   set `cssTheme` in appearance.json, preserving every other key
 *   - `installBundledThemes` install every bundled theme and select the default
 *                              only when the vault has no theme yet
 *
 * It writes only the theme folders and appearance.json — never notes. With no
 * vault path it reads Obsidian's per-platform registry and uses the open (or
 * only) vault, and it builds paths with `@std/path` so Windows drive-letter and
 * UNC vaults work as well as macOS and Linux. Backups, manifest validation and
 * JSON merging live here.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, join, relative } from "jsr:@std/path@1.1.6";
import { join as posixJoin } from "jsr:@std/path@1.1.6/posix";
import { join as winJoin } from "jsr:@std/path@1.1.6/windows";

// ---------------------------------------------------------------------------
// Bundled theme catalogue
// ---------------------------------------------------------------------------

/** A theme this extension ships. `dir` is relative to the extension's themes/. */
export type BundledTheme = {
  id: string;
  name: string;
  dir: string;
};

/**
 * The bundled themes, in installation order. `name` must match the `name` in
 * `themes/<dir>/manifest.json`; a test asserts that so a renamed manifest cannot
 * silently install under a different folder than the one `select` expects.
 */
export const BUNDLED_THEMES: readonly BundledTheme[] = [
  {
    id: "borland-modern-blue",
    name: "Borland Modern Blue",
    dir: "borland-modern-blue",
  },
  {
    id: "swamp-club",
    name: "Swamp Club",
    dir: "swamp-club",
  },
];

/** Resolve a bundled theme by id or display name, case-insensitively. */
export function resolveBundledTheme(query: string): BundledTheme | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return BUNDLED_THEMES.find((theme) =>
    theme.id === q || theme.name.toLowerCase() === q
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  vaultPath: z.string().default("").describe(
    "Obsidian vault folder — the directory that contains the config dotfolder. " +
      "Empty auto-detects the open (or only) vault from Obsidian's registry. " +
      "Absolute, ~-prefixed, or a Windows drive/UNC path.",
  ),
  vaultName: z.string().default("").describe(
    "Registered vault folder name to look up in Obsidian's registry when " +
      "vaultPath is empty (empty selects the open vault, or the only one).",
  ),
  configDir: z.string().default(".obsidian").describe(
    "Vault config dotfolder, relative to vaultPath (default .obsidian).",
  ),
  defaultTheme: z.string().default("borland-modern-blue").describe(
    "Bundled theme (id or display name) selected when the vault has no " +
      "cssTheme yet (default borland-modern-blue).",
  ),
});

/** The model's global arguments (mirrors GlobalArgsSchema). */
export type GlobalArgs = {
  vaultPath: string;
  vaultName: string;
  configDir: string;
  defaultTheme: string;
};

/** Per-call vault overrides, so `--input vaultPath=…` works on a method run. */
const VaultArgsSchema = {
  vaultPath: z.string().default("").describe(
    "Vault path override for this call (empty uses the model global).",
  ),
  vaultName: z.string().default("").describe(
    "Registered vault name override for this call (empty uses the model global).",
  ),
  configDir: z.string().default("").describe(
    "Config dotfolder override for this call (empty uses the model global).",
  ),
};

const InstallArgsSchema = z.object({
  ...VaultArgsSchema,
  theme: z.string().default("").describe(
    "Bundled theme id or display name to install. Empty installs every bundled theme.",
  ),
  force: z.boolean().default(false).describe(
    "Rewrite even when the installed theme files are already identical.",
  ),
});

const InstallBundledArgsSchema = z.object({
  ...VaultArgsSchema,
  selectDefault: z.boolean().default(true).describe(
    "Select defaultTheme only when the vault has no cssTheme yet. An existing " +
      "selection is never overwritten.",
  ),
  defaultTheme: z.string().default("").describe(
    "Override defaultTheme for this call (empty uses the model global).",
  ),
  force: z.boolean().default(false).describe(
    "Rewrite even when the installed theme files are already identical.",
  ),
});

const SelectArgsSchema = z.object({
  ...VaultArgsSchema,
  theme: z.string().min(1).describe(
    "Installed theme to select — its display name or a bundled theme id.",
  ),
});

const ListArgsSchema = z.object({ ...VaultArgsSchema });
const SetupArgsSchema = z.object({ ...VaultArgsSchema });

const BundledThemeStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  installed: z.boolean(),
  active: z.boolean(),
});

const InstalledThemeSchema = z.object({
  name: z.string(),
  id: z.string(),
  version: z.string(),
  author: z.string(),
  description: z.string(),
  bundled: z.boolean(),
  active: z.boolean(),
  path: z.string(),
});

const VaultSourceSchema = z.enum([
  "explicit",
  "registry-name",
  "registry-default",
  "none",
]);

const VaultEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  open: z.boolean(),
  ts: z.number(),
});

const ConfigSchema = z.object({
  vaultPath: z.string(),
  vaultPathSource: VaultSourceSchema,
  vaultName: z.string(),
  registryPath: z.string(),
  availableVaults: z.array(VaultEntrySchema),
  configDir: z.string(),
  themesDir: z.string(),
  appearancePath: z.string(),
  vaultPresent: z.boolean(),
  themesPresent: z.boolean(),
  appearancePresent: z.boolean(),
  activeTheme: z.string(),
  bundled: z.array(BundledThemeStateSchema),
  installed: z.array(InstalledThemeSchema),
  error: z.string().optional(),
  checkedAt: z.iso.datetime(),
});

const ThemesSchema = z.object({
  vaultPath: z.string(),
  vaultPathSource: VaultSourceSchema,
  themesDir: z.string(),
  appearancePath: z.string(),
  activeTheme: z.string(),
  bundled: z.array(BundledThemeStateSchema),
  installed: z.array(InstalledThemeSchema),
  checkedAt: z.iso.datetime(),
});

const InstallSchema = z.object({
  vaultPath: z.string(),
  vaultPathSource: VaultSourceSchema,
  themesDir: z.string(),
  results: z.array(z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    status: z.enum(["installed", "updated", "unchanged"]),
    files: z.array(z.string()),
  })),
  installed: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  selected: z.boolean(),
  previousTheme: z.string(),
  defaultTheme: z.string(),
  checkedAt: z.iso.datetime(),
});

const SelectionSchema = z.object({
  vaultPath: z.string(),
  vaultPathSource: VaultSourceSchema,
  theme: z.string(),
  previousTheme: z.string(),
  changed: z.boolean(),
  appearancePath: z.string(),
  checkedAt: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The logging surface a swamp method receives. */
export type Logger = {
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn?: (message: string, properties?: Record<string, unknown>) => void;
};

/** The handle returned by `context.writeResource`. */
export type DataHandle = { name: string };

/**
 * The slice of the swamp method context this model uses. The full context has
 * more, but the model only needs the globals, logger, bundled-asset resolver and
 * resource writer; tests construct the same shape without a swamp runtime.
 */
export type ThemeContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  extensionFile?: (relPath: string) => string;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
};

/** The narrow vault port the core logic needs. The model builds it on top of
 * Deno's filesystem with `@std/path`; tests use an in-memory implementation. */
export type VaultPort = {
  read: (file: string) => Promise<string | null>;
  write: (file: string, content: string) => Promise<void>;
  list: (folder: string) => Promise<string[]>;
  exists: (file: string) => Promise<boolean>;
};

/** The subset of an Obsidian theme manifest the extension reports. */
export type ThemeManifest = {
  name: string;
  version: string;
  author: string;
  description: string;
};

/** The outcome of installing one bundled theme. */
export type InstallResult = {
  id: string;
  name: string;
  path: string;
  status: "installed" | "updated" | "unchanged";
  files: string[];
};

/** A theme folder present in the vault, with its manifest metadata. */
export type InstalledTheme = {
  name: string;
  id: string;
  version: string;
  author: string;
  description: string;
  bundled: boolean;
  active: boolean;
  path: string;
};

/** How the vault was located. */
export type VaultSource =
  | "explicit"
  | "registry-name"
  | "registry-default"
  | "none";

/** One entry from Obsidian's `obsidian.json` vault registry. */
export type VaultEntry = {
  id: string;
  name: string;
  path: string;
  open: boolean;
  ts: number;
};

/** The resolved vault path plus how it was chosen. */
export type VaultTarget = {
  vaultPath: string;
  vaultPathSource: VaultSource;
  registryPath: string;
  availableVaults: VaultEntry[];
};

/** The read-only result written by the `setup` method. */
export type SetupReport = {
  vaultPath: string;
  vaultPathSource: VaultSource;
  vaultName: string;
  registryPath: string;
  availableVaults: VaultEntry[];
  configDir: string;
  themesDir: string;
  appearancePath: string;
  vaultPresent: boolean;
  themesPresent: boolean;
  appearancePresent: boolean;
  activeTheme: string;
  bundled: Array<
    { id: string; name: string; installed: boolean; active: boolean }
  >;
  installed: InstalledTheme[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Expand a leading ~ using USERPROFILE on Windows, HOME elsewhere. */
export function expandHome(path: string): string {
  const home = Deno.build.os === "windows"
    ? (Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? "~")
    : (Deno.env.get("HOME") ?? "~");
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return `${home}${path.slice(1)}`;
  }
  return path;
}

/** Join vault-relative segments without doubling separators. */
export function joinRel(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

/**
 * Validate the config dotfolder. It must be relative to the vault: an absolute
 * path would escape the vault boundary this extension enforces.
 */
export function normalizeConfigDir(input: string): string {
  const raw = input.trim() || ".obsidian";
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(
      `configDir must be relative to vaultPath (for example .obsidian), not '${raw}'.`,
    );
  }
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return ".obsidian";
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`configDir must not contain '..' (got '${raw}').`);
  }
  return normalized;
}

/** The vault-relative themes directory. */
export function themesRelFor(g: GlobalArgs): string {
  return joinRel(normalizeConfigDir(g.configDir), "themes");
}

/** The vault-relative appearance.json path. */
export function appearanceRelFor(g: GlobalArgs): string {
  return joinRel(normalizeConfigDir(g.configDir), "appearance.json");
}

/** The platform families whose Obsidian paths this extension knows. */
export type HostPlatform = "linux" | "darwin" | "windows";

/** The platform family this process is running on. */
export function currentPlatform(): HostPlatform {
  if (Deno.build.os === "windows") return "windows";
  if (Deno.build.os === "darwin") return "darwin";
  return "linux";
}

/**
 * Obsidian's own vault registry, per platform:
 *   Windows  %APPDATA%\obsidian\obsidian.json
 *   macOS    ~/Library/Application Support/obsidian/obsidian.json
 *   Linux    $XDG_CONFIG_HOME/obsidian/obsidian.json or ~/.config/...
 *
 * The environment and home are injectable so the Windows/macOS paths can be
 * tested on Linux.
 */
export function obsidianRegistryPath(
  options: {
    platform?: HostPlatform;
    env?: Record<string, string | undefined>;
    home?: string;
  } = {},
): string {
  const platform = options.platform ?? currentPlatform();
  const env = options.env ?? Deno.env.toObject();
  const home = options.home ??
    (platform === "windows"
      ? (env.USERPROFILE ?? env.HOME ?? "")
      : (env.HOME ?? env.USERPROFILE ?? ""));
  if (platform === "windows") {
    const appData = env.APPDATA ??
      (home ? `${home}\\AppData\\Roaming` : "");
    return appData ? `${appData}\\obsidian\\obsidian.json` : "obsidian.json";
  }
  if (platform === "darwin") {
    return `${home}/Library/Application Support/obsidian/obsidian.json`;
  }
  const xdg = env.XDG_CONFIG_HOME;
  return xdg
    ? `${xdg}/obsidian/obsidian.json`
    : `${home}/.config/obsidian/obsidian.json`;
}

/** The last path component, accepting both `/` and `\` separators. */
export function vaultNameFromPath(path: string): string {
  const parts = path.split(/[/\\]+/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/** Parse Obsidian's `obsidian.json` registry into vault entries. */
export function parseVaultRegistry(text: string): VaultEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      "Obsidian's vault registry is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.vaults)) return [];
  const entries: VaultEntry[] = [];
  for (const [id, value] of Object.entries(parsed.vaults)) {
    if (!isRecord(value) || typeof value.path !== "string") continue;
    entries.push({
      id,
      name: vaultNameFromPath(value.path),
      path: value.path,
      open: value.open === true,
      ts: typeof value.ts === "number" ? value.ts : 0,
    });
  }
  return entries;
}

/**
 * Pick the vault to use from the registry. An explicit name wins; otherwise
 * the open vault wins, then the only registered vault. More than one candidate
 * without an open flag is an error that lists them, never a silent guess.
 */
export function chooseVault(
  vaults: VaultEntry[],
  name = "",
): { entry: VaultEntry; source: "registry-name" | "registry-default" } {
  const wanted = name.trim();
  if (wanted) {
    const matches = vaults.filter((vault) =>
      vault.name.toLowerCase() === wanted.toLowerCase()
    );
    if (matches.length === 0) {
      throw new Error(
        `No vault named "${wanted}" in Obsidian's registry. Known vaults: ` +
          `${vaults.map((vault) => vault.name).join(", ") || "(none)"}. ` +
          `Pass vaultPath explicitly if the vault has moved.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Vault name "${wanted}" is ambiguous: ` +
          `${matches.map((vault) => vault.path).join(", ")}. ` +
          `Pass vaultPath explicitly.`,
      );
    }
    return { entry: matches[0], source: "registry-name" };
  }

  const open = vaults.filter((vault) => vault.open);
  if (open.length > 0) {
    open.sort((a, b) => b.ts - a.ts);
    return { entry: open[0], source: "registry-default" };
  }
  if (vaults.length === 1) {
    return { entry: vaults[0], source: "registry-default" };
  }
  if (vaults.length === 0) {
    throw new Error(
      "Obsidian's vault registry has no vaults. Pass vaultPath explicitly.",
    );
  }
  throw new Error(
    `Obsidian's registry has ${vaults.length} vaults and none is marked open. ` +
      `Pass vaultName or vaultPath. Known vaults: ` +
      vaults.map((vault) => `${vault.name} (${vault.path})`).join(", ") + ".",
  );
}

/**
 * Resolve an explicit vaultPath, or the open/single vault from Obsidian's
 * registry. This is how the extension gets a usable path with no configuration
 * on a normal desktop install.
 */
export async function resolveVaultTarget(
  g: GlobalArgs,
  io: {
    registryPath?: string;
    readTextFile?: (path: string) => Promise<string>;
  } = {},
): Promise<VaultTarget> {
  const explicit = g.vaultPath.trim();
  const registryPath = io.registryPath ?? obsidianRegistryPath();
  if (explicit) {
    return {
      vaultPath: expandHome(explicit),
      vaultPathSource: "explicit",
      registryPath,
      availableVaults: [],
    };
  }

  let text: string;
  try {
    text = await (io.readTextFile ?? Deno.readTextFile)(registryPath);
  } catch (error) {
    throw new Error(
      `No vaultPath was given and Obsidian's vault registry could not be read at ` +
        `${registryPath}. Set vaultPath, or open the vault in Obsidian once. ` +
        (error instanceof Error ? `(${error.message})` : ""),
    );
  }
  const vaults = parseVaultRegistry(text);
  const { entry, source } = chooseVault(vaults, g.vaultName);
  return {
    vaultPath: entry.path,
    vaultPathSource: source,
    registryPath,
    availableVaults: vaults,
  };
}

/**
 * Turn a vault-relative path into an absolute path for the given platform.
 * Windows drive letters and UNC roots stay absolute; `..` or an absolute
 * relative path is rejected.
 */
export function vaultAbsolutePath(
  root: string,
  rel: string,
  platform: HostPlatform = currentPlatform(),
): string {
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error(`Vault-relative path must not be absolute: ${rel}`);
  }
  const segments = rel.split(/[/\\]+/).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(`Path escapes vault root: ${rel}`);
    }
  }
  return platform === "windows"
    ? winJoin(root, ...segments)
    : posixJoin(root, ...segments);
}

/** Parse a theme manifest; `source` is only used in error messages. */
export function parseThemeManifest(
  text: string,
  source: string,
): ThemeManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (
    !isRecord(value) || typeof value.name !== "string" || !value.name.trim()
  ) {
    throw new Error(
      `${source} must be a JSON object with a non-empty "name" string.`,
    );
  }
  return {
    name: value.name.trim(),
    version: typeof value.version === "string" ? value.version : "",
    author: typeof value.author === "string" ? value.author : "",
    description: typeof value.description === "string" ? value.description : "",
  };
}

/** Parse appearance.json, treating a missing or empty file as an empty object. */
export function parseAppearance(
  text: string | null,
): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      "appearance.json is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!isRecord(value)) {
    throw new Error("appearance.json must contain a JSON object.");
  }
  return value;
}

/**
 * Return the appearance.json text with `cssTheme` set, preserving every other
 * key. The previous theme is reported so callers can say what changed.
 */
export function setSelectedTheme(
  text: string | null,
  themeName: string,
): { text: string; previous: string; changed: boolean } {
  const data = parseAppearance(text);
  const previous = typeof data.cssTheme === "string" ? data.cssTheme : "";
  if (previous === themeName) {
    return { text: text ?? "{}\n", previous, changed: false };
  }
  data.cssTheme = themeName;
  return {
    text: `${JSON.stringify(data, null, 2)}\n`,
    previous,
    changed: true,
  };
}

/**
 * Derive theme folder names from vault-relative file paths. A theme folder is
 * considered present when it contributes a theme.css or manifest.json.
 */
export function deriveInstalledThemeNames(
  files: string[],
  themesRel: string,
): string[] {
  const prefix = `${joinRel(themesRel)}/`;
  const names = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const name = rest.slice(0, slash);
    const leaf = rest.slice(slash + 1);
    if (leaf === "theme.css" || leaf === "manifest.json") names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Read a bundled theme CSS + manifest through ctx.extensionFile(). */
export async function readBundledTheme(
  entry: BundledTheme,
  extensionFile: (relPath: string) => string,
): Promise<{
  css: string;
  manifestText: string;
  manifest: ThemeManifest;
  cssPath: string;
  manifestPath: string;
}> {
  // swamp's additionalFiles rejects .css, so the bundled asset is .css.txt and
  // is written into the vault under the real theme.css name.
  const cssPath = extensionFile(`themes/${entry.dir}/theme.css.txt`);
  const manifestPath = extensionFile(`themes/${entry.dir}/manifest.json`);
  let css: string;
  let manifestText: string;
  try {
    [css, manifestText] = await Promise.all([
      Deno.readTextFile(cssPath),
      Deno.readTextFile(manifestPath),
    ]);
  } catch (error) {
    throw new Error(
      `Bundled theme '${entry.id}' is incomplete: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!css.trim()) {
    throw new Error(`Bundled theme '${entry.id}' has an empty theme.css.txt.`);
  }
  const manifest = parseThemeManifest(manifestText, manifestPath);
  return { css, manifestText, manifest, cssPath, manifestPath };
}

// ---------------------------------------------------------------------------
// Core operations on a VaultPort
// ---------------------------------------------------------------------------

/** Back up a file once, before the first overwrite. */
async function backupOnce(
  port: VaultPort,
  path: string,
  content: string,
): Promise<void> {
  const backup = `${path}.bak-obsidian-theme`;
  if ((await port.read(backup)) === null) {
    await port.write(backup, content);
  }
}

/** Install one bundled theme, skipping identical files unless force is set. */
export async function installBundledTheme(
  entry: BundledTheme,
  port: VaultPort,
  g: GlobalArgs,
  extensionFile: (relPath: string) => string,
  force = false,
): Promise<InstallResult> {
  const bundled = await readBundledTheme(entry, extensionFile);
  if (bundled.manifest.name !== entry.name) {
    throw new Error(
      `Bundled theme '${entry.id}' manifest name '${bundled.manifest.name}' ` +
        `does not match catalogue name '${entry.name}'.`,
    );
  }

  const themesRel = themesRelFor(g);
  const path = joinRel(themesRel, entry.name);
  const cssRel = joinRel(path, "theme.css");
  const manifestRel = joinRel(path, "manifest.json");
  const [existingCss, existingManifest] = await Promise.all([
    port.read(cssRel),
    port.read(manifestRel),
  ]);

  const identical = existingCss === bundled.css &&
    existingManifest === bundled.manifestText;
  if (identical && !force) {
    return {
      id: entry.id,
      name: entry.name,
      path,
      status: "unchanged",
      files: [cssRel, manifestRel],
    };
  }

  if (existingCss !== null && existingCss !== bundled.css) {
    await backupOnce(port, cssRel, existingCss);
  }
  if (existingManifest !== null && existingManifest !== bundled.manifestText) {
    await backupOnce(port, manifestRel, existingManifest);
  }

  await port.write(cssRel, bundled.css);
  await port.write(manifestRel, bundled.manifestText);

  return {
    id: entry.id,
    name: entry.name,
    path,
    status: existingCss === null && existingManifest === null
      ? "installed"
      : "updated",
    files: [cssRel, manifestRel],
  };
}

/** Install every catalogue entry (or the requested subset) in order. */
export async function installThemes(
  entries: BundledTheme[],
  port: VaultPort,
  g: GlobalArgs,
  extensionFile: (relPath: string) => string,
  force = false,
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  for (const entry of entries) {
    results.push(
      await installBundledTheme(entry, port, g, extensionFile, force),
    );
  }
  return results;
}

/** Read the active cssTheme (empty string when none is set). */
export async function readActiveTheme(
  port: VaultPort,
  g: GlobalArgs,
): Promise<string> {
  const text = await port.read(appearanceRelFor(g));
  const data = parseAppearance(text);
  return typeof data.cssTheme === "string" ? data.cssTheme : "";
}

/** List installed theme folders, with manifest metadata and active state. */
export async function listInstalledThemes(
  port: VaultPort,
  g: GlobalArgs,
  activeTheme = "",
): Promise<InstalledTheme[]> {
  const themesRel = themesRelFor(g);
  const files = await port.list(themesRel);
  const names = deriveInstalledThemeNames(files, themesRel);
  const installed: InstalledTheme[] = [];

  for (const name of names) {
    const cssRel = joinRel(themesRel, name, "theme.css");
    if (!files.includes(cssRel)) continue;
    const manifestRel = joinRel(themesRel, name, "manifest.json");
    let manifest: ThemeManifest | null = null;
    try {
      const text = await port.read(manifestRel);
      if (text !== null) manifest = parseThemeManifest(text, manifestRel);
    } catch {
      // A broken manifest must not hide an otherwise installed theme.
    }
    const bundled = BUNDLED_THEMES.find((theme) =>
      theme.name.toLowerCase() === name.toLowerCase()
    );
    installed.push({
      name,
      id: bundled?.id ?? name,
      version: manifest?.version ?? "",
      author: manifest?.author ?? "",
      description: manifest?.description ?? "",
      bundled: bundled !== undefined,
      active: name === activeTheme,
      path: joinRel(themesRel, name),
    });
  }
  return installed;
}

/**
 * Select an installed theme by display name or bundled id. The theme must
 * already be installed; install and select stay separate so a typo cannot
 * silently create a theme folder.
 */
export async function selectInstalledTheme(
  port: VaultPort,
  g: GlobalArgs,
  query: string,
): Promise<{ theme: string; previous: string; changed: boolean }> {
  const wanted = query.trim();
  if (!wanted) throw new Error("select requires a theme name.");
  const installed = await listInstalledThemes(port, g);
  const match = installed.find((theme) =>
    theme.name.toLowerCase() === wanted.toLowerCase() ||
    theme.id.toLowerCase() === wanted.toLowerCase()
  );
  if (!match) {
    const names = installed.map((theme) => theme.name).join(", ") ||
      "(none)";
    throw new Error(
      `Theme '${wanted}' is not installed in ${themesRelFor(g)}. ` +
        `Installed: ${names}. Install it first with the install method.`,
    );
  }

  const appearanceRel = appearanceRelFor(g);
  const current = await port.read(appearanceRel);
  const selected = setSelectedTheme(current, match.name);
  if (selected.changed) {
    if (current !== null) await backupOnce(port, appearanceRel, current);
    await port.write(appearanceRel, selected.text);
  }
  return {
    theme: match.name,
    previous: selected.previous,
    changed: selected.changed,
  };
}

/** Read-only discovery for the setup method. */
export async function setupVault(
  port: VaultPort | null,
  g: GlobalArgs,
  target: VaultTarget | null = null,
  detectionError = "",
): Promise<SetupReport> {
  const configDir = normalizeConfigDir(g.configDir);
  const themesDir = joinRel(configDir, "themes");
  const appearancePath = joinRel(configDir, "appearance.json");
  const registryPath = target?.registryPath ?? obsidianRegistryPath();
  const availableVaults = target?.availableVaults ?? [];
  let error = detectionError;
  let vaultPresent = false;
  let themesPresent = false;
  let appearancePresent = false;
  let activeTheme = "";
  let installed: InstalledTheme[] = [];

  if (port && target) {
    try {
      vaultPresent = await port.exists(configDir);
      if (vaultPresent) {
        themesPresent = await port.exists(themesDir);
        appearancePresent = await port.exists(appearancePath);
        activeTheme = appearancePresent ? await readActiveTheme(port, g) : "";
        installed = await listInstalledThemes(port, g, activeTheme);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  const bundled = BUNDLED_THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    installed: installed.some((entry) => entry.id === theme.id),
    active: installed.some((entry) => entry.id === theme.id && entry.active),
  }));

  return {
    vaultPath: target?.vaultPath ?? "",
    vaultPathSource: target?.vaultPathSource ?? "none",
    vaultName: g.vaultName,
    registryPath,
    availableVaults,
    configDir,
    themesDir,
    appearancePath,
    vaultPresent,
    themesPresent,
    appearancePresent,
    activeTheme,
    bundled,
    installed,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Filesystem adapter
// ---------------------------------------------------------------------------

/**
 * A VaultPort over Deno's filesystem with `@std/path`.
 *
 * The extension writes only theme files and appearance.json. The generic
 * `@magistr/obsidian/vault` model cannot represent a Windows drive-letter vault
 * root: its path confinement prefixes `/` before `C:`, producing
 * `\C:\Users\...`, and its registry lookup splits only on `/`. This port uses
 * the platform path module, handles both separators, and rejects traversal, so
 * the same code runs on Windows, macOS and Linux.
 */
export function createDirectVaultPort(vaultPath: string): VaultPort {
  const root = vaultPath;
  const absolute = (file: string) => vaultAbsolutePath(root, file);

  const walk = async (dir: string, out: string[]): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(full, out);
      } else if (entry.isFile) {
        out.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  };

  return {
    read: async (file) => {
      try {
        return await Deno.readTextFile(absolute(file));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      }
    },
    write: async (file, content) => {
      const target = absolute(file);
      await Deno.mkdir(dirname(target), { recursive: true });
      const temp = `${target}.tmp-${crypto.randomUUID()}`;
      await Deno.writeTextFile(temp, content);
      await Deno.rename(temp, target);
    },
    list: async (folder) => {
      const dir = absolute(folder);
      const files: string[] = [];
      try {
        await walk(dir, files);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
      }
      return files.sort((a, b) => a.localeCompare(b));
    },
    exists: async (file) => {
      try {
        await Deno.stat(absolute(file));
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Method helpers
// ---------------------------------------------------------------------------

/** Merge per-call vault overrides over the model's global arguments. */
export function effectiveGlobals(
  g: GlobalArgs,
  args: { vaultPath?: string; vaultName?: string; configDir?: string },
): GlobalArgs {
  return {
    ...g,
    vaultPath: (args.vaultPath ?? "").trim() || g.vaultPath,
    vaultName: (args.vaultName ?? "").trim() || g.vaultName,
    configDir: (args.configDir ?? "").trim() || g.configDir,
  };
}

function requireExtensionFile(
  context: ThemeContext,
): (relPath: string) => string {
  if (!context.extensionFile) {
    throw new Error(
      "context.extensionFile is unavailable; the bundled themes cannot be read.",
    );
  }
  return context.extensionFile;
}

async function requireVault(
  port: VaultPort,
  g: GlobalArgs,
  vaultPath = "",
): Promise<string> {
  const configDir = normalizeConfigDir(g.configDir);
  const where = (vaultPath || g.vaultPath).trim() || "(the detected vault)";
  let present = false;
  try {
    present = await port.exists(configDir);
  } catch (error) {
    throw new Error(
      `Cannot access vault '${where}': ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!present) {
    throw new Error(
      `Not an Obsidian vault: ${where} has no ${configDir} folder. ` +
        `Open it in Obsidian once, or pass a different vaultPath/configDir.`,
    );
  }
  return configDir;
}

function summarise(results: InstallResult[]): string {
  const counts = { installed: 0, updated: 0, unchanged: 0 };
  for (const result of results) counts[result.status]++;
  return `${counts.installed} installed, ${counts.updated} updated, ` +
    `${counts.unchanged} unchanged`;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/obsidian-theme`. */
export const model = {
  type: "@svendowideit/obsidian-theme",
  version: "2026.11.11.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-config": {
      description: "Validate the config dotfolder and default theme",
      labels: ["policy"],
      appliesTo: [
        "setup",
        "install",
        "installBundledThemes",
        "list",
        "select",
      ],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const g = context.globalArgs;
        const errors: string[] = [];
        try {
          normalizeConfigDir(g.configDir);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        if (!resolveBundledTheme(g.defaultTheme)) {
          errors.push(
            `defaultTheme '${g.defaultTheme}' is not a bundled theme ` +
              `(${BUNDLED_THEMES.map((theme) => theme.id).join(", ")})`,
          );
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.11.11.1",
      description:
        "Initial release: install, list and select Obsidian CSS themes, with " +
        "Borland Modern Blue and Swamp Club bundled. Detects the open or only " +
        "vault from Obsidian's per-platform registry, uses @std/path so Windows " +
        "drive-letter and UNC vault roots work, backs up any file it overwrites, " +
        "and preserves every other appearance.json key when it sets cssTheme.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    config: {
      description: "Read-only vault and theme discovery from setup",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    themes: {
      description: "Installed themes, bundled availability and active theme",
      schema: ThemesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    install: {
      description: "Result of installing one or every bundled theme",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    selection: {
      description: "Result of selecting a theme in appearance.json",
      schema: SelectionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // meta-factory-ignore config-lifecycle: setup is read-only discovery from
    // Obsidian's registry and the model's globals; it never prompts for
    // configuration, so there is no previous answer to read back or reuse.
    setup: {
      description:
        "Read-only discovery: is this an Obsidian vault, which themes are " +
        "installed, which bundled themes are available, and which theme is " +
        "active. Never edits the vault.",
      arguments: SetupArgsSchema,
      execute: async (
        args: z.infer<typeof SetupArgsSchema>,
        context: ThemeContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = effectiveGlobals(context.globalArgs, args);
        let target: VaultTarget | null = null;
        let port: VaultPort | null = null;
        let detectionError = "";
        try {
          target = await resolveVaultTarget(g);
          port = createDirectVaultPort(target.vaultPath);
        } catch (error) {
          detectionError = error instanceof Error
            ? error.message
            : String(error);
        }
        const report = await setupVault(port, g, target, detectionError);
        const handle = await context.writeResource("config", "config", {
          ...report,
          checkedAt: new Date().toISOString(),
        });
        context.logger.info(
          "Obsidian theme setup: vault={vault} ({source}) active={active} installed={installed}",
          {
            vault: report.vaultPath || "(not detected)",
            source: report.vaultPathSource,
            active: report.activeTheme || "(none)",
            installed: report.installed.length,
          },
        );
        if (report.error) {
          context.logger.warn?.("Vault discovery reported: {error}", {
            error: report.error,
          });
        }
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Install one bundled theme (by id or display name) or every bundled " +
        "theme when theme is empty. Writes <vaultPath>/<configDir>/themes/" +
        "<name>/theme.css and manifest.json; identical files are left alone, " +
        "and a differing file is backed up once to *.bak-obsidian-theme before " +
        "it is replaced. Does not change the selected theme.",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: ThemeContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = effectiveGlobals(context.globalArgs, args);
        const target = await resolveVaultTarget(g);
        const port = createDirectVaultPort(target.vaultPath);
        await requireVault(port, g, target.vaultPath);

        const entries = args.theme.trim()
          ? [resolveBundledTheme(args.theme)]
          : [...BUNDLED_THEMES];
        if (entries.some((entry) => entry === null)) {
          throw new Error(
            `Unknown bundled theme '${args.theme}'. Bundled: ` +
              BUNDLED_THEMES.map((theme) => theme.id).join(", ") + ".",
          );
        }
        const results = await installThemes(
          entries as BundledTheme[],
          port,
          g,
          requireExtensionFile(context),
          args.force,
        );
        const handle = await context.writeResource("install", "install", {
          vaultPath: target.vaultPath,
          vaultPathSource: target.vaultPathSource,
          themesDir: themesRelFor(g),
          results,
          installed: results.filter((r) => r.status === "installed").length,
          updated: results.filter((r) => r.status === "updated").length,
          unchanged: results.filter((r) => r.status === "unchanged").length,
          selected: false,
          previousTheme: "",
          defaultTheme: "",
          checkedAt: new Date().toISOString(),
        });
        context.logger.info("Installed bundled Obsidian themes: {summary}", {
          summary: summarise(results),
        });
        return { dataHandles: [handle] };
      },
    },

    installBundledThemes: {
      description:
        "Install every bundled theme and, only when the vault has no cssTheme " +
        "yet, select defaultTheme. An existing selection is never overwritten. " +
        "Idempotent; this is the step the bundled install/upgrade workflows run.",
      arguments: InstallBundledArgsSchema,
      execute: async (
        args: z.infer<typeof InstallBundledArgsSchema>,
        context: ThemeContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = effectiveGlobals(context.globalArgs, args);
        const target = await resolveVaultTarget(g);
        const port = createDirectVaultPort(target.vaultPath);
        await requireVault(port, g, target.vaultPath);

        const results = await installThemes(
          [...BUNDLED_THEMES],
          port,
          g,
          requireExtensionFile(context),
          args.force,
        );

        const previousTheme = await readActiveTheme(port, g);
        let selected = false;
        let selectedTheme = "";
        const requestedDefault = (args.defaultTheme.trim() ||
          g.defaultTheme).trim();
        if (args.selectDefault && previousTheme === "") {
          const entry = resolveBundledTheme(requestedDefault);
          if (!entry) {
            throw new Error(
              `defaultTheme '${requestedDefault}' is not a bundled theme ` +
                `(${BUNDLED_THEMES.map((theme) => theme.id).join(", ")}).`,
            );
          }
          const selection = await selectInstalledTheme(port, g, entry.name);
          selected = selection.changed;
          selectedTheme = selection.theme;
        }

        const handle = await context.writeResource("install", "install", {
          vaultPath: target.vaultPath,
          vaultPathSource: target.vaultPathSource,
          themesDir: themesRelFor(g),
          results,
          installed: results.filter((r) => r.status === "installed").length,
          updated: results.filter((r) => r.status === "updated").length,
          unchanged: results.filter((r) => r.status === "unchanged").length,
          selected,
          previousTheme,
          defaultTheme: requestedDefault,
          checkedAt: new Date().toISOString(),
        });
        context.logger.info(
          "Bundled Obsidian themes: {summary}; active={active}",
          {
            summary: summarise(results),
            active: selectedTheme || previousTheme || "(none)",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    list: {
      description:
        "List every theme installed under <vaultPath>/<configDir>/themes, its " +
        "manifest metadata, whether it is one of the bundled themes, and which " +
        "theme is active in appearance.json. Read-only.",
      arguments: ListArgsSchema,
      execute: async (
        args: z.infer<typeof ListArgsSchema>,
        context: ThemeContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = effectiveGlobals(context.globalArgs, args);
        const target = await resolveVaultTarget(g);
        const port = createDirectVaultPort(target.vaultPath);
        await requireVault(port, g, target.vaultPath);

        const activeTheme = await readActiveTheme(port, g);
        const installed = await listInstalledThemes(port, g, activeTheme);
        const bundled = BUNDLED_THEMES.map((theme) => ({
          id: theme.id,
          name: theme.name,
          installed: installed.some((entry) => entry.id === theme.id),
          active: installed.some((entry) =>
            entry.id === theme.id && entry.active
          ),
        }));
        const handle = await context.writeResource("themes", "themes", {
          vaultPath: target.vaultPath,
          vaultPathSource: target.vaultPathSource,
          themesDir: themesRelFor(g),
          appearancePath: appearanceRelFor(g),
          activeTheme,
          bundled,
          installed,
          checkedAt: new Date().toISOString(),
        });
        context.logger.info(
          "Obsidian themes: {count} installed; active={active}",
          { count: installed.length, active: activeTheme || "(none)" },
        );
        return { dataHandles: [handle] };
      },
    },

    select: {
      description:
        "Set cssTheme in <vaultPath>/<configDir>/appearance.json to an installed " +
        "theme, preserving every other key. Accepts the theme's display name or " +
        "a bundled theme id. Backs up appearance.json once before changing it. " +
        "Does not install a missing theme.",
      arguments: SelectArgsSchema,
      execute: async (
        args: z.infer<typeof SelectArgsSchema>,
        context: ThemeContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = effectiveGlobals(context.globalArgs, args);
        const target = await resolveVaultTarget(g);
        const port = createDirectVaultPort(target.vaultPath);
        await requireVault(port, g, target.vaultPath);

        const selection = await selectInstalledTheme(port, g, args.theme);
        const handle = await context.writeResource("selection", "select", {
          vaultPath: target.vaultPath,
          vaultPathSource: target.vaultPathSource,
          theme: selection.theme,
          previousTheme: selection.previous,
          changed: selection.changed,
          appearancePath: appearanceRelFor(g),
          checkedAt: new Date().toISOString(),
        });
        const message = selection.changed
          ? `Selected Obsidian theme '${selection.theme}' in ` +
            `${appearanceRelFor(g)}` +
            (selection.previous ? ` (was '${selection.previous}')` : "")
          : `Obsidian theme '${selection.theme}' is already selected`;
        context.logger.info(message);
        return { dataHandles: [handle] };
      },
    },
  },
};
