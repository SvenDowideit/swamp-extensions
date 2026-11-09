/**
 * `@svendowideit/herdr-app` — install and update the Herdr desktop app and
 * herdr-core on the machine the method runs on.
 *
 * Herdr (https://herdr.dev) is a desktop app for terminals and coding agents
 * that keep running. The vendor ships a one-line installer per platform; this
 * model does the same work as swamp methods so it can be planned, pinned,
 * verified and reported: it resolves the release manifest, selects this host's
 * archive, checks the archive's SHA-256, places the app the way the vendor
 * does (Linux data dir + launcher entry, macOS `Herdr.app`, Windows Programs
 * dir + Start menu shortcut + user PATH), and installs herdr-core only when
 * there is none — exactly the vendor's rule, because the app keeps the core
 * current after that.
 *
 * Because the install runs wherever the method runs, the same model is the
 * local, `swamp serve`, and swamp worker install; a fourth transport (ssh to a
 * host with no swamp) is served by `renderScript`, which pins the resolved
 * release into a POSIX installer the `@svendowideit/herdr-app-ssh` workflow
 * pipes through `@swamp/ssh`.
 *
 * Methods: `plan`, `install`, `status`, `uninstall`, `renderScript`,
 * `sshFleet`.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { UntarStream } from "jsr:@std/tar@0.1.10/untar-stream";
import {
  compareVersions,
  DEFAULT_RELEASES_URL,
  desktopEntry,
  encodePowerShell,
  HERDR_TEAM_ID,
  HERDR_THEME_ID,
  herdrAppHomeFor,
  type HostOs,
  type InstallAction,
  installAction,
  type InstallPin,
  type Layout,
  layoutFor,
  type LayoutOverrides,
  manifestUrl,
  parseAppVersion,
  parseCoreVersion,
  parseHerdrTheme,
  parseManifest,
  pickAsset,
  type Platform,
  POSIX_TARGETS,
  renderInstallScript,
  settingsFilePath,
  type Target,
  targetFor,
  type ThemeChoice,
  themeChoiceOf,
  themeFilePath,
  versionsEqual,
  windowsPathRemoveScript,
  windowsPathScript,
  windowsShortcutRemoveScript,
  windowsShortcutScript,
  withSource,
  withThemeChoice,
} from "./herdr_app_shared.ts";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const CoreModeSchema = z.enum(["auto", "always", "never"]);

/** Arguments shared by `plan` and `install`: where the app lives and what to install. */
const LocationArgsSchema = {
  appDir: z.string().default("").describe(
    "Override the app location. Empty uses the platform default: " +
      "$XDG_DATA_HOME/herdr-app on Linux, ~/Applications/Herdr.app on macOS, " +
      "%LOCALAPPDATA%\\Programs\\herdr-app on Windows.",
  ),
  binDir: z.string().default("").describe(
    "Override the directory that holds `herdr-app` and `hc` on Linux/macOS. " +
      "Empty uses ~/.local/bin. Ignored on Windows, where the app directory " +
      "itself goes on the user PATH.",
  ),
  releasesUrl: z.string().default(DEFAULT_RELEASES_URL).describe(
    "Release host to resolve and download from.",
  ),
  version: z.string().default("").describe(
    "App version to install (e.g. 0.1.14). Empty installs the newest release.",
  ),
  coreVersion: z.string().default("").describe(
    "herdr-core version to install (e.g. 0.1.19). Empty uses the newest core.",
  ),
  core: CoreModeSchema.default("auto").describe(
    "herdr-core handling: `auto` installs one only when none is present " +
      "(the vendor's rule — the app updates it afterwards), `always` also " +
      "updates an existing core, `never` leaves the core alone.",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even when the target version is already installed.",
  ),
};

const PlanArgsSchema = z.object({ ...LocationArgsSchema }).strict();

const InstallArgsSchema = z.object({
  ...LocationArgsSchema,
  theme: z.string().default(HERDR_THEME_ID).describe(
    "Theme to install from this extension's bundled themes. Empty installs no " +
      "theme.",
  ),
  selectTheme: z.boolean().default(true).describe(
    "Select the theme in settings.json, but only when the person has not " +
      "chosen a theme yet. An existing choice is never overwritten.",
  ),
  herdrHome: z.string().default("").describe(
    "Override Herdr's own home (themes/ and settings.json). Empty uses " +
      "$HERDR_APP_HOME, then $XDG_CONFIG_HOME/herdr-app, then ~/.config/herdr-app.",
  ),
  release: z.record(z.string(), z.unknown()).optional().describe(
    "A resolved `release` resource from `plan`. When given, its versions, " +
      "URLs and checksums are used and no manifest is fetched — so a plan made " +
      "once can be installed on many hosts.",
  ),
}).strict();

const StatusArgsSchema = z.object({
  appDir: LocationArgsSchema.appDir,
  binDir: LocationArgsSchema.binDir,
  herdrHome: z.string().default("").describe(
    "Override Herdr's own home when reading the theme back. Empty uses " +
      "$HERDR_APP_HOME, then $XDG_CONFIG_HOME/herdr-app, then ~/.config/herdr-app.",
  ),
}).strict();

const InstallThemeArgsSchema = z.object({
  theme: z.string().default(HERDR_THEME_ID).describe(
    "Theme to install from this extension's bundled themes.",
  ),
  herdrHome: z.string().default("").describe(
    "Override Herdr's own home. Empty uses $HERDR_APP_HOME, then " +
      "$XDG_CONFIG_HOME/herdr-app, then ~/.config/herdr-app.",
  ),
  select: z.boolean().default(true).describe(
    "Select the theme in settings.json when the person has not chosen one. An " +
      "existing choice is never overwritten.",
  ),
  force: z.boolean().default(false).describe(
    "Rewrite the theme file even when its text already matches.",
  ),
}).strict();

const UninstallArgsSchema = z.object({
  appDir: LocationArgsSchema.appDir,
  binDir: LocationArgsSchema.binDir,
  removeCore: z.boolean().default(false).describe(
    "Also remove herdr-core and its `hc` alias. Off by default because the " +
      "core is shared by every Herdr app install on the machine.",
  ),
  removeTheme: z.boolean().default(false).describe(
    "Also remove the theme this extension installed from Herdr's themes " +
      "directory. settings.json is left alone.",
  ),
  herdrHome: z.string().default("").describe(
    "Override Herdr's own home when removing the theme.",
  ),
  force: z.boolean().default(false).describe(
    "Ignore a running app and remove files anyway.",
  ),
}).strict();

const RenderScriptArgsSchema = z.object({
  version: z.string().default("").describe(
    "App version to pin. Empty pins the newest release.",
  ),
  coreVersion: z.string().default("").describe(
    "herdr-core version to pin. Empty pins the newest core.",
  ),
  releasesUrl: z.string().default(DEFAULT_RELEASES_URL).describe(
    "Release host the pins point at.",
  ),
  core: CoreModeSchema.default("auto").describe(
    "herdr-core handling the remote script should apply.",
  ),
  theme: z.string().default(HERDR_THEME_ID).describe(
    "Theme to install on every host from this extension's bundled themes. " +
      "Empty installs no theme.",
  ),
  selectTheme: z.boolean().default(true).describe(
    "Select the theme on a host whose settings.json has no theme yet.",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall on the remote host even when it already matches.",
  ),
  verifyCoreSignature: z.boolean().default(true).describe(
    "Verify the macOS Herdr Core.app release signature before installing it. " +
      "Only valid for the vendor's release host; set false for a mirror.",
  ),
}).strict();

const SshFleetArgsSchema = z.object({
  fleet: z.string().default("herdr-app").describe(
    "Name of the @swamp/ssh fleet (the model instance that runs the script).",
  ),
  hosts: z.string().default("").describe(
    "Comma-separated `name=address` entries, or bare addresses, for the " +
      "fleet. Each becomes one @swamp/ssh host.",
  ),
  user: z.string().default("").describe(
    "SSH user for every host. Empty uses your ssh config and current user.",
  ),
  port: z.number().int().default(22).describe("SSH port for every host."),
  identityFile: z.string().default("").describe(
    "SSH identity file for every host. Empty uses your ssh agent/config.",
  ),
  hostKeyChecking: z.enum(["yes", "accept-new", "no", "off"]).default(
    "accept-new",
  ).describe("OpenSSH StrictHostKeyChecking policy."),
  connectTimeoutSec: z.number().int().default(10).describe(
    "SSH connect timeout in seconds.",
  ),
}).strict();

const PlanArgs = PlanArgsSchema;
const InstallArgs = InstallArgsSchema;
const StatusArgs = StatusArgsSchema;
const UninstallArgs = UninstallArgsSchema;
const InstallThemeArgs = InstallThemeArgsSchema;
const RenderScriptArgs = RenderScriptArgsSchema;
const SshFleetArgs = SshFleetArgsSchema;

type PlanArgsType = z.infer<typeof PlanArgsSchema>;
type InstallArgsType = z.infer<typeof InstallArgsSchema>;
type StatusArgsType = z.infer<typeof StatusArgsSchema>;
type UninstallArgsType = z.infer<typeof UninstallArgsSchema>;
type InstallThemeArgsType = z.infer<typeof InstallThemeArgsSchema>;
type RenderScriptArgsType = z.infer<typeof RenderScriptArgsSchema>;
type SshFleetArgsType = z.infer<typeof SshFleetArgsSchema>;

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const ReleaseSchema = z.object({
  version: z.string(),
  coreMin: z.string().default(""),
  notes: z.string().default(""),
  target: z.string(),
  os: z.string(),
  arch: z.string(),
  url: z.string(),
  sha256: z.string(),
  coreVersion: z.string().default(""),
  coreUrl: z.string().default(""),
  coreSha256: z.string().default(""),
  releasesUrl: z.string(),
  resolvedAt: z.string(),
});

const PlanSchema = z.object({
  action: z.string(),
  reason: z.string(),
  installedVersion: z.string().default(""),
  targetVersion: z.string(),
  coreMode: z.string(),
  coreAction: z.string(),
  coreVersion: z.string().default(""),
  target: z.string(),
  os: z.string(),
  arch: z.string(),
  appPath: z.string(),
  checkedAt: z.string(),
});

const InstallSchema = z.object({
  action: z.string(),
  version: z.string(),
  previousVersion: z.string().default(""),
  appPath: z.string(),
  target: z.string(),
  os: z.string(),
  arch: z.string(),
  coreAction: z.string(),
  coreVersion: z.string().default(""),
  corePath: z.string().default(""),
  force: z.boolean(),
  notes: z.string().default(""),
  theme: z.string().default(""),
  themeAction: z.string().default(""),
  themeSelected: z.boolean().default(false),
  themePath: z.string().default(""),
  installedAt: z.string(),
});

const StatusSchema = z.object({
  target: z.string(),
  os: z.string(),
  arch: z.string(),
  appPresent: z.boolean(),
  appVersion: z.string().default(""),
  appPath: z.string(),
  appKind: z.string().default(""),
  corePresent: z.boolean(),
  coreVersion: z.string().default(""),
  corePath: z.string().default(""),
  herdrHome: z.string().default(""),
  themeFile: z.string().default(""),
  themeInstalled: z.boolean().default(false),
  themeChoice: z.string().default(""),
  themeSelected: z.boolean().default(false),
  layouts: z.array(z.string()).default([]),
  checkedAt: z.string(),
});

const ThemeSchema = z.object({
  id: z.string(),
  path: z.string().default(""),
  action: z.string(),
  selected: z.boolean().default(false),
  previousTheme: z.string().default(""),
  settingsPath: z.string().default(""),
  warning: z.string().default(""),
  checkedAt: z.string(),
});

const TransportSchema = z.object({
  fleet: z.string(),
  hosts: z.array(z.object({
    name: z.string(),
    address: z.string(),
    tags: z.array(z.string()).default([]),
    attrs: z.record(z.string(), z.unknown()).default({}),
  })),
  transport: z.record(z.string(), z.unknown()),
  recordedAt: z.string(),
});

const ScriptSchema = z.object({
  targets: z.array(z.string()),
  appVersion: z.string(),
  theme: z.string().default(""),
  coreVersion: z.string().default(""),
  coreMode: z.string(),
  force: z.boolean(),
  script: z.string(),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// IO seams (injected in tests)
// ---------------------------------------------------------------------------

/** The result of one subprocess. */
export interface CmdResult {
  /** Process exit code. */
  code: number;
  /** Decoded stdout. */
  stdout: string;
  /** Decoded stderr. */
  stderr: string;
}

/** Runs one subprocess without a shell. */
export type RunFn = (
  command: string,
  args: string[],
  options?: { stdin?: string; env?: Record<string, string> },
) => Promise<CmdResult>;

/** Everything the installer reads from and writes to a host. */
export interface HostDeps {
  /** Fetches a URL (injected so tests never touch the network). */
  fetch: typeof fetch;
  /** Runs a subprocess. */
  run: RunFn;
  /** Host family. */
  os: HostOs;
  /** Reported architecture (`x86_64` / `aarch64`). */
  arch: string;
  /** True when an x86_64 process runs under Rosetta on Apple silicon. */
  rosetta: boolean;
  /** Environment values the layout derives from. */
  env: {
    home: string;
    localAppData: string;
    xdgData: string;
    xdgCache: string;
    xdgConfig: string;
    herdrAppHome: string;
    userProfile: string;
    systemRoot: string;
  };
  /** Progress logger. */
  log: (message: string) => void;
  /** Clock (injected so timestamps are deterministic in tests). */
  now: () => Date;
}

// ---------------------------------------------------------------------------
// Pure-ish planning helpers (exported for tests)
// ---------------------------------------------------------------------------

/** What `plan` resolved for this host. */
export interface ResolvedRelease {
  /** App version to install. */
  version: string;
  /** Oldest compatible core, or "". */
  coreMin: string;
  /** Release notes line, or "". */
  notes: string;
  /** Release target id. */
  target: Target;
  /** Verified app archive URL (carries the vendor's `?src=` marker). */
  url: string;
  /** App archive SHA-256. */
  sha256: string;
  /** Core version to install, or "" when none was resolved. */
  coreVersion: string;
  /** Verified core archive URL, or "". */
  coreUrl: string;
  /** Core archive SHA-256, or "". */
  coreSha256: string;
  /** Release host used. */
  releasesUrl: string;
}

/** The installed state of the app and core on a host. */
export interface InstalledState {
  /** The platform the probe ran for. */
  platform: Platform;
  /** Where the app should be. */
  layout: Layout;
  /** True when something is at the app path. */
  appPresent: boolean;
  /** The app's reported version, or "". */
  appVersion: string;
  /** `directory`, `app-bundle`, or "". */
  appKind: string;
  /** True when a herdr-core is present at the expected path or on PATH. */
  corePresent: boolean;
  /** The core's reported version, or "". */
  coreVersion: string;
  /** Where the core was found, or "". */
  corePath: string;
  /** Herdr's own home (themes/, settings.json). */
  appHome: string;
  /** Path of the bundled theme's file in the app home. */
  themeFile: string;
  /** True when that theme file is present. */
  themeInstalled: boolean;
  /** The person's theme choice from settings.json. */
  themeChoice: ThemeChoice;
  /** Layout ids present in `<appHome>/layouts` (e.g. `main`, `swamp`). */
  layouts: string[];
}

/** The plan, as reported by `plan`. */
export interface PlanResult {
  action: string;
  reason: string;
  installed: InstalledState;
  appAction: InstallAction;
  coreAction: string;
  target: Target;
}

/** The outcome of `install`. */
export interface InstallResult {
  action: InstallAction;
  version: string;
  previousVersion: string;
  layout: Layout;
  platform: Platform;
  coreAction: string;
  coreVersion: string;
  notes: string;
  /** What happened to the bundled theme. */
  theme: ThemeInstallResult;
}

/** Build a layout for a host from its deps. */
export function layoutOf(
  deps: HostDeps,
  overrides: LayoutOverrides = {},
): Layout {
  return layoutFor(deps.os, {
    home: deps.env.home,
    localAppData: deps.env.localAppData,
    xdgData: deps.env.xdgData,
    xdgCache: deps.env.xdgCache,
  }, overrides);
}

/**
 * Herdr's own home on this host: `$HERDR_APP_HOME`, else
 * `$XDG_CONFIG_HOME/herdr-app`, else `~/.config/herdr-app` — the order the app
 * resolves it in, so the theme lands where the app looks for it.
 */
export function appHomeOf(deps: HostDeps, override = ""): string {
  return herdrAppHomeFor({
    os: deps.os,
    home: deps.env.home,
    xdgConfig: deps.env.xdgConfig,
    herdrAppHome: override.trim() || deps.env.herdrAppHome,
  });
}

/** Resolve this host's platform from its deps, or throw a supported-target error. */
export function platformOf(deps: HostDeps): Platform {
  return targetFor(deps.os, deps.arch, { rosetta: deps.rosetta });
}

/** Fetch and parse one release manifest. */
export async function fetchManifest(
  deps: HostDeps,
  releasesUrl: string,
  kind: "app" | "core",
  version: string,
): Promise<ReturnType<typeof parseManifest>> {
  const url = manifestUrl(releasesUrl, kind, version);
  const res = await deps.fetch(url, { cache: "no-store" } as RequestInit);
  if (!res.ok) {
    throw new Error(
      `cannot read ${url}: HTTP ${res.status}. Check releasesUrl and the version.`,
    );
  }
  return parseManifest(await res.json(), url);
}

/**
 * Resolve the release to install: the app manifest (pinned or latest), this
 * host's asset, and — unless `core` is `never` — the core manifest. The core
 * is resolved even when it is already installed, so the same pins can be sent
 * to a host that has none (the ssh path).
 */
export async function resolveRelease(
  deps: HostDeps,
  opts: {
    releasesUrl: string;
    version: string;
    coreVersion: string;
    core: "auto" | "always" | "never";
  },
): Promise<ResolvedRelease> {
  const platform = platformOf(deps);
  const app = await fetchManifest(deps, opts.releasesUrl, "app", opts.version);
  const asset = pickAsset(app, platform.target, "Herdr app");
  const reinstall = await appReinstallHint(deps, platform);
  const resolved: ResolvedRelease = {
    version: app.version,
    coreMin: app.coreMin,
    notes: app.notes,
    target: platform.target,
    url: withSource(asset.url, opts.releasesUrl, reinstall),
    sha256: asset.sha256,
    coreVersion: "",
    coreUrl: "",
    coreSha256: "",
    releasesUrl: opts.releasesUrl,
  };
  if (opts.core === "never") return resolved;
  try {
    const core = await fetchManifest(
      deps,
      opts.releasesUrl,
      "core",
      opts.coreVersion,
    );
    const coreAsset = pickAsset(core, platform.target, "herdr-core");
    resolved.coreVersion = core.version;
    resolved.coreUrl = withSource(
      coreAsset.url,
      opts.releasesUrl,
      "install",
    );
    resolved.coreSha256 = coreAsset.sha256;
  } catch (error) {
    if (opts.core === "always") throw error;
    deps.log(
      `herdr-core release not resolved (${errorMessage(error)}); the app ` +
        `install continues and Herdr can install the core when it opens.`,
    );
  }
  return resolved;
}

/** The `?src=` marker: a reinstall when the app is already on the machine. */
async function appReinstallHint(
  deps: HostDeps,
  platform: Platform,
): Promise<string> {
  const layout = layoutOf(deps);
  const present = await pathExists(deps, layout.appBinary, platform.os);
  return present ? "reinstall" : "install";
}

/**
 * Resolve the release pins for every Linux/macOS target, so one SSH installer
 * serves a mixed fleet. The app manifest is read once; the core manifest is
 * read too unless the core is off, and a core target a release does not publish
 * is simply left unpinned (the host then fails with a clear message if it needs
 * one).
 */
export async function resolveFleetPins(
  deps: HostDeps,
  opts: {
    releasesUrl: string;
    version: string;
    coreVersion: string;
    core: "auto" | "always" | "never";
  },
): Promise<{ appVersion: string; coreVersion: string; pins: InstallPin[] }> {
  const app = await fetchManifest(deps, opts.releasesUrl, "app", opts.version);
  let core: ReturnType<typeof parseManifest> | null = null;
  if (opts.core !== "never") {
    try {
      core = await fetchManifest(
        deps,
        opts.releasesUrl,
        "core",
        opts.coreVersion,
      );
    } catch (error) {
      if (opts.core === "always") throw error;
      deps.log(
        `herdr-core release not resolved (${
          errorMessage(error)
        }); the script ` +
          `installs the app and leaves the core to Herdr.`,
      );
    }
  }
  const pins: InstallPin[] = [];
  for (const target of POSIX_TARGETS) {
    const asset = app.targets[target];
    if (!asset) continue;
    const coreAsset = core?.targets[target];
    pins.push({
      target,
      appUrl: withSource(asset.url, opts.releasesUrl, "install"),
      appSha256: asset.sha256,
      coreUrl: coreAsset
        ? withSource(coreAsset.url, opts.releasesUrl, "install")
        : "",
      coreSha256: coreAsset?.sha256 ?? "",
    });
  }
  if (pins.length === 0) {
    throw new Error(
      `Herdr ${app.version} publishes no Linux or macOS build, so there is ` +
        `nothing to pin for the ssh installer`,
    );
  }
  return { appVersion: app.version, coreVersion: core?.version ?? "", pins };
}

/**
 * Probe the installed app and core. The app version comes from running it
 * (`herdr-app --version`); a path that exists but does not answer is reported
 * as present with an empty version, which `install` treats as a repair.
 */
export async function probeInstalled(
  deps: HostDeps,
  overrides: LayoutOverrides = {},
): Promise<InstalledState> {
  const platform = platformOf(deps);
  const layout = layoutOf(deps, overrides);
  const appPresent = await pathExists(deps, layout.appBinary, platform.os);
  const appVersion = appPresent ? await probeAppVersion(deps, layout) : "";
  let corePath = (await pathExists(deps, layout.corePath, platform.os))
    ? layout.corePath
    : "";
  if (!corePath) {
    const found = await deps.run(
      platform.os === "windows" ? "where" : "which",
      [
        "herdr-core",
      ],
    );
    if (found.code === 0) {
      corePath = found.stdout.split(/\r?\n/)[0].trim();
    }
  }
  const coreVersion = corePath ? await probeCoreVersion(deps, corePath) : "";
  const appHome = appHomeOf(deps);
  const themeFile = themeFilePath(appHome, HERDR_THEME_ID, platform.os);
  return {
    platform,
    layout,
    appPresent,
    appVersion,
    appKind: appPresent ? appKind(platform.os) : "",
    corePresent: corePath !== "" || coreVersion !== "",
    coreVersion,
    corePath,
    appHome,
    themeFile,
    themeInstalled: await pathExists(deps, themeFile, platform.os),
    themeChoice: await readThemeChoice(deps, appHome),
    layouts: await listLayouts(deps, appHome),
  };
}

/**
 * The layout ids Herdr will offer: every `<appHome>/layouts/*.json`. Used to see
 * whether a layout someone else installs (such as the swamp layout) is already
 * there before trying to install it again.
 */
async function listLayouts(deps: HostDeps, appHome: string): Promise<string[]> {
  const dir = deps.os === "windows"
    ? `${appHome}\\layouts`
    : `${appHome}/layouts`;
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      names.push(entry.name.slice(0, -".json".length));
    }
  } catch {
    return [];
  }
  return names.sort();
}

/** Read the person's theme choice, treating an unreadable settings.json as none. */
async function readThemeChoice(
  deps: HostDeps,
  appHome: string,
): Promise<ThemeChoice> {
  const path = settingsFilePath(appHome, deps.os);
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return { chosen: false, theme: "", light: "", dark: "" };
  }
  try {
    return themeChoiceOf(text, path);
  } catch {
    deps.log(
      `${path} is not readable JSON; leaving the theme choice alone (the theme ` +
        `file is still installed and can be picked in Settings)`,
    );
    return { chosen: false, theme: "", light: "", dark: "" };
  }
}

/**
 * True when the bundled theme is the one on show: either named directly, or as
 * one half of a light/dark pair.
 */
export function themeOnShow(choice: ThemeChoice, id = HERDR_THEME_ID): boolean {
  return choice.theme === id || choice.light === id || choice.dark === id;
}

/** Read the app's version through its own `--version`. */
async function probeAppVersion(
  deps: HostDeps,
  layout: Layout,
): Promise<string> {
  const result = await deps.run(layout.appBinary, ["--version"]);
  if (result.code !== 0) return "";
  return parseAppVersion(result.stdout);
}

/** Read a herdr-core binary's version. */
async function probeCoreVersion(
  deps: HostDeps,
  corePath: string,
): Promise<string> {
  const result = await deps.run(corePath, ["--version"]);
  if (result.code !== 0) return "";
  return parseCoreVersion(result.stdout);
}

/** Describe the app's install shape for the status record. */
function appKind(os: HostOs): string {
  return os === "macos" ? "app-bundle" : "directory";
}

/** Decide, without touching the host, what installing `release` would do. */
export function planInstall(
  installed: InstalledState,
  release: ResolvedRelease,
  opts: { core: "auto" | "always" | "never"; force: boolean },
): PlanResult {
  const appAction = installAction(
    installed.appVersion,
    release.version,
    opts.force,
    installed.appPresent,
  );
  let coreAction = "skipped";
  if (opts.core !== "never") {
    if (!release.coreVersion) coreAction = "unavailable";
    else if (opts.core === "always") {
      coreAction = versionsEqual(installed.coreVersion, release.coreVersion) &&
          installed.corePresent
        ? (opts.force ? "reinstalled" : "unchanged")
        : (installed.corePresent ? "updated" : "installed");
    } else if (
      installed.corePresent && release.coreMin &&
      installed.coreVersion &&
      compareVersions(installed.coreVersion, release.coreMin) < 0
    ) {
      // The vendor leaves an existing core alone, but this one is older than
      // the app says it needs — say so rather than reporting "unchanged".
      coreAction = "outdated";
    } else {
      coreAction = installed.corePresent ? "unchanged" : "installed";
    }
  }
  // Only a real core change makes an otherwise current app a "core-only" run;
  // a skipped or unavailable core leaves the plan unchanged.
  const coreChanges = coreAction === "installed" || coreAction === "updated" ||
    coreAction === "reinstalled";
  const action = appAction !== "unchanged"
    ? appAction
    : coreChanges
    ? "core-only"
    : "unchanged";
  const reason = describePlan(
    action,
    installed,
    release,
    opts,
    coreAction,
  );
  return {
    action,
    reason,
    installed,
    appAction,
    coreAction,
    target: installed.platform.target,
  };
}

/** Explain the plan in one sentence a person can act on. */
function describePlan(
  action: string,
  installed: InstalledState,
  release: ResolvedRelease,
  opts: { core: "auto" | "always" | "never"; force: boolean },
  coreAction: string,
): string {
  const have = installed.appVersion;
  const want = release.version;
  if (action === "unchanged") {
    if (coreAction === "outdated") {
      return `herdr-app ${have} is current, but herdr-core ` +
        `${installed.coreVersion} is older than the ${release.coreMin} this ` +
        `app needs — re-run with core=always to update it`;
    }
    return `herdr-app ${have} is already installed at ${installed.layout.appDir}`;
  }
  if (action === "core-only") {
    return coreAction === "unavailable"
      ? `herdr-app ${have} is current, but no herdr-core ${release.coreVersion} build is published for ${installed.platform.target}`
      : `herdr-app ${have} is current; herdr-core: ${coreAction}`;
  }
  if (!have && installed.appPresent) {
    return `the app at ${installed.layout.appDir} does not report a version; it will be reinstalled as ${want}`;
  }
  if (!have) return `install herdr-app ${want} into ${installed.layout.appDir}`;
  const order = compareVersions(have, want);
  const verb = order === 0
    ? `reinstall herdr-app ${want}${opts.force ? "" : " (force is off)"}`
    : order < 0
    ? `update herdr-app ${have} to ${want}`
    : `downgrade herdr-app ${have} to ${want}`;
  return `${verb} at ${installed.layout.appDir}`;
}

// ---------------------------------------------------------------------------
// Download / extract
// ---------------------------------------------------------------------------

/** SHA-256 of a byte array as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Read a file's SHA-256 as lowercase hex, or "" when it cannot be read. */
async function fileSha256(path: string): Promise<string> {
  try {
    return await sha256Hex(await Deno.readFile(path));
  } catch {
    return "";
  }
}

/**
 * Return a checksum-verified archive, reusing `cachePath` when its bytes still
 * match. A mismatch downloads again; a checksum that never matches is an
 * error, never a write.
 */
export async function ensureArchive(
  deps: HostDeps,
  opts: {
    url: string;
    sha256: string;
    cachePath: string;
    label: string;
  },
): Promise<Uint8Array> {
  if (await fileSha256(opts.cachePath) === opts.sha256) {
    deps.log(
      `${opts.label}: reusing the verified download at ${opts.cachePath}`,
    );
    return await Deno.readFile(opts.cachePath);
  }
  const res = await deps.fetch(opts.url, { cache: "no-store" } as RequestInit);
  if (!res.ok) {
    throw new Error(
      `cannot download ${opts.url}: HTTP ${res.status}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = await sha256Hex(bytes);
  if (got !== opts.sha256) {
    throw new Error(
      `${opts.label}: the download is damaged — expected sha256 ` +
        `${opts.sha256}, got ${got}. Nothing was written; re-run to try again.`,
    );
  }
  await Deno.mkdir(dirname(opts.cachePath), { recursive: true });
  await Deno.writeFile(opts.cachePath, bytes);
  return bytes;
}

/**
 * Extract a gzipped tar into `dest`. Entries that would escape `dest` are
 * refused. Files are written 0755 when they are one of the executables the
 * vendor ships and 0644 otherwise.
 */
export async function extractTarGz(
  bytes: Uint8Array,
  dest: string,
): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  const copy = new Uint8Array(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  for await (const entry of stream.pipeThrough(new UntarStream())) {
    const relative = safeRelative(entry.path);
    if (!relative) {
      if (entry.readable) await new Response(entry.readable).arrayBuffer();
      continue;
    }
    const target = `${dest}/${relative}`;
    const typeflag = entry.header?.typeflag ?? "";
    if (typeflag === "5" || entry.path.endsWith("/")) {
      await Deno.mkdir(target, { recursive: true });
      continue;
    }
    if (!entry.readable) continue;
    const data = new Uint8Array(
      await new Response(entry.readable).arrayBuffer(),
    );
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeFile(target, data);
    await Deno.chmod(target, isExecutable(relative) ? 0o755 : 0o644);
  }
}

/** Normalise a tar entry path, returning "" for anything that escapes `dest`. */
export function safeRelative(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((p) =>
    p !== "" && p !== "."
  );
  if (parts.length === 0) return "";
  if (parts.some((p) => p === "..")) return "";
  if (/^[A-Za-z]:/.test(parts[0])) return "";
  return parts.join("/");
}

/** True for the binaries that must stay executable after extraction. */
function isExecutable(relative: string): boolean {
  const base = relative.split("/").pop() ?? "";
  return base === "herdr-app" || base === "Herdr" || base === "herdr-core" ||
    base === "herdr-app.exe" || base === "herdr-core.exe";
}

/** The last path segment's parent, using forward slashes. */
function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : ".";
}

/** True when something exists at `path` (Windows paths are checked case-insensitively by the OS). */
async function pathExists(
  _deps: HostDeps,
  path: string,
  _os: HostOs,
): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable message for an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install or update the app (and, per `core`, herdr-core) on this host.
 *
 * Idempotent: when the app already reports the target version the download is
 * skipped, so a repeat run costs one manifest request. Every archive is
 * checksum-verified before anything is placed.
 */
export async function installHerdr(
  deps: HostDeps,
  opts: {
    release: ResolvedRelease;
    core: "auto" | "always" | "never";
    force: boolean;
    appDir: string;
    binDir: string;
    downloadDir: string;
    herdrHome: string;
    theme: string;
    themeText: string;
    selectTheme: boolean;
  },
): Promise<InstallResult> {
  const platform = platformOf(deps);
  if (platform.target !== opts.release.target) {
    throw new Error(
      `this resolved release is for ${opts.release.target} but this host is ` +
        `${platform.target}; re-run plan on this host`,
    );
  }
  const overrides = { appDir: opts.appDir, binDir: opts.binDir };
  const layout = layoutOf(deps, overrides);
  const installed = await probeInstalled(deps, overrides);
  const plan = planInstall(installed, opts.release, {
    core: opts.core,
    force: opts.force,
  });
  deps.log(`plan: ${plan.reason}`);

  if (plan.appAction !== "unchanged") {
    await placeApp(deps, opts.release, layout, opts.downloadDir);
  }

  const core = await placeCore(deps, opts.release, layout, {
    mode: opts.core,
    force: opts.force,
    downloadDir: opts.downloadDir,
    releasesUrl: opts.release.releasesUrl,
    installed,
  });

  const theme = await installHerdrTheme(deps, {
    themeId: opts.theme,
    themeText: opts.themeText,
    appHome: appHomeOf(deps, opts.herdrHome),
    select: opts.selectTheme,
    force: opts.force,
  });

  return {
    action: plan.appAction,
    version: opts.release.version,
    previousVersion: installed.appVersion,
    layout,
    platform,
    coreAction: core.action,
    coreVersion: core.version,
    notes: opts.release.notes,
    theme,
  };
}

/** Download, verify and place the app, returning what it did. */
async function placeApp(
  deps: HostDeps,
  release: ResolvedRelease,
  layout: Layout,
  downloadDir: string,
): Promise<void> {
  const archive = `${
    archiveDir(deps, downloadDir)
  }/herdr-app-${release.version}-${release.target}.tar.gz`;
  const bytes = await ensureArchive(deps, {
    url: release.url,
    sha256: release.sha256,
    cachePath: archive,
    label: "herdr-app",
  });
  await Deno.mkdir(dirname(archive), { recursive: true });

  const staging = `${layout.appDir}.new`;
  await removeTree(staging);
  await extractTarGz(bytes, staging);
  try {
    await placeExtractedApp(deps, release, layout, staging);
  } finally {
    await removeTreeQuiet(staging);
  }

  const version = await probeAppVersion(deps, layout);
  if (!version) {
    throw new Error(
      `the app was placed at ${layout.appDir} but running it with --version ` +
        `printed nothing; check the install resource and re-run`,
    );
  }
  if (!versionsEqual(version, release.version)) {
    throw new Error(
      `the installed app reports ${version}, not the requested ` +
        `${release.version}; nothing else was changed`,
    );
  }
  deps.log(`herdr-app ${version} is installed at ${layout.appDir}`);
}

/** Move the extracted tree into its final place for this platform. */
async function placeExtractedApp(
  deps: HostDeps,
  release: ResolvedRelease,
  layout: Layout,
  staging: string,
): Promise<void> {
  void release;
  if (deps.os === "macos") {
    const bundle = `${staging}/Herdr.app`;
    if (!(await pathExists(deps, bundle, deps.os))) {
      throw new Error(
        "the app archive holds no Herdr.app; nothing was changed",
      );
    }
    await signMacApp(deps, bundle, layout.binDir);
    await removeTree(layout.appDir);
    await Deno.mkdir(dirname(layout.appDir), { recursive: true });
    await Deno.rename(bundle, layout.appDir);
    await linkApp(deps, layout);
    await deps.run(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      [
        "-f",
        layout.appDir,
      ],
    );
  } else if (deps.os === "linux") {
    const tree = `${staging}/herdr-app`;
    if (!(await pathExists(deps, tree, deps.os))) {
      throw new Error(
        "the app archive holds no herdr-app directory; nothing was changed",
      );
    }
    await removeTree(layout.appDir);
    await Deno.mkdir(dirname(layout.appDir), { recursive: true });
    await Deno.rename(tree, layout.appDir);
    await Deno.chmod(layout.appBinary, 0o755);
    await linkApp(deps, layout);
    if (layout.desktopFile) await writeLinuxLauncher(deps, layout);
  } else {
    const tree = `${staging}/herdr-app`;
    if (!(await pathExists(deps, `${tree}/herdr-app.exe`, deps.os))) {
      throw new Error(
        "the app archive holds no herdr-app.exe; nothing was changed",
      );
    }
    await replaceWindowsTree(deps, layout.appDir, tree);
    await runPowerShell(
      deps,
      windowsShortcutScript(layout.appBinary, deps.env.userProfile),
    );
    await runPowerShell(deps, windowsPathScript(layout.binDir));
  }
}

/** Write the `herdr-app` symlink and make sure the bin dir exists. */
async function linkApp(deps: HostDeps, layout: Layout): Promise<void> {
  await Deno.mkdir(layout.binDir, { recursive: true });
  await removeTree(layout.linkPath);
  const target = deps.os === "macos"
    ? `${layout.appDir}/Contents/MacOS/Herdr`
    : layout.appBinary;
  await Deno.symlink(target, layout.linkPath);
}

/** Write the desktop entry and icon the vendor's Linux installer creates. */
async function writeLinuxLauncher(
  deps: HostDeps,
  layout: Layout,
): Promise<void> {
  await Deno.mkdir(dirname(layout.desktopFile), { recursive: true });
  await Deno.writeTextFile(layout.desktopFile, desktopEntry(layout.linkPath));
  const icon = `${layout.appDir}/herdr-app.svg`;
  if (await pathExists(deps, icon, deps.os)) {
    await Deno.mkdir(dirname(layout.iconFile), { recursive: true });
    await Deno.copyFile(icon, layout.iconFile);
  }
  await deps.run("update-desktop-database", [dirname(layout.desktopFile)]);
}

/**
 * Verify a downloaded macOS app bundle the way the vendor's installer does: a
 * Developer ID bundle is verified and left untouched (its signature is what
 * macOS privacy grants follow); an unsigned or ad-hoc build gets the PATH
 * environment the app needs and is re-signed ad-hoc.
 */
async function signMacApp(
  deps: HostDeps,
  bundle: string,
  binDir: string,
): Promise<void> {
  const signature = await deps.run("/usr/bin/codesign", ["-dvv", bundle]);
  const text = `${signature.stdout}\n${signature.stderr}`;
  const developerId = text.includes("Authority=Developer ID Application:");
  if (developerId) {
    const verify = await deps.run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      bundle,
    ]);
    if (verify.code !== 0) {
      throw new Error(
        `the downloaded Herdr.app has an invalid signature: ${
          (verify.stderr || verify.stdout).trim()
        }`,
      );
    }
    return;
  }
  const adhoc = text.includes("Signature=adhoc") ||
    text.includes("code object is not signed at all");
  if (!adhoc) {
    throw new Error(
      `cannot determine the downloaded Herdr.app's signature: ${text.trim()}`,
    );
  }
  const plist = `${bundle}/Contents/Info.plist`;
  const path = `${binDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const add = await deps.run("/usr/libexec/PlistBuddy", [
    "-c",
    `Add :LSEnvironment:PATH string ${path}`,
    plist,
  ]);
  if (add.code !== 0) {
    throw new Error(
      `cannot add the app's PATH environment: ${
        (add.stderr || add.stdout).trim()
      }`,
    );
  }
  await deps.run("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
}

/**
 * Replace a Windows directory whose files may be in use.
 *
 * A running app's folder can be renamed but its files cannot be deleted, which
 * is exactly how the vendor's installer behaves: the old tree is renamed out of
 * the way now and removed on a later run if it could not be deleted (or by the
 * user). Only the final rename into place is fatal.
 */
async function replaceWindowsTree(
  deps: HostDeps,
  appDir: string,
  tree: string,
): Promise<void> {
  const old = `${appDir}.old`;
  await removeTreeQuiet(old);
  if (await pathExists(deps, appDir, deps.os)) {
    try {
      await Deno.rename(appDir, old);
    } catch (error) {
      throw new Error(
        `cannot move the running Herdr out of the way at ${appDir}: ` +
          `${
            errorMessage(error)
          }. Close Herdr and re-run; the downloaded app ` +
          `is unchanged.`,
      );
    }
  }
  await Deno.mkdir(dirname(appDir), { recursive: true });
  await Deno.rename(tree, appDir);
  await removeTreeQuiet(old);
}

/** Remove a tree, ignoring the "file is in use" failure Windows can give. */
async function removeTreeQuiet(path: string): Promise<void> {
  try {
    await removeTree(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    // Windows keeps a running program's files locked; leaving them is safe and
    // the next run clears them.
    if (Deno.build.os === "windows") return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// herdr-core
// ---------------------------------------------------------------------------

/** What happened to herdr-core during an install. */
export interface CoreResult {
  /** installed | updated | unchanged | skipped | unavailable. */
  action: string;
  /** The core's version after the run, or "". */
  version: string;
}

/**
 * Install herdr-core when the selected mode asks for it. `auto` mirrors the
 * vendor: only a machine with no core at all gets one, because the app keeps
 * it current afterwards.
 */
async function placeCore(
  deps: HostDeps,
  release: ResolvedRelease,
  layout: Layout,
  opts: {
    mode: "auto" | "always" | "never";
    force: boolean;
    downloadDir: string;
    releasesUrl: string;
    installed: InstalledState;
  },
): Promise<CoreResult> {
  const have = opts.installed.coreVersion;
  if (opts.mode === "never") return { action: "skipped", version: have };
  if (opts.mode === "auto" && opts.installed.corePresent) {
    return { action: "unchanged", version: have };
  }
  if (!release.coreVersion || !release.coreUrl) {
    throw new Error(
      `no herdr-core build was resolved for ${release.target}; re-run plan, ` +
        `or pass core=never to install the app alone`,
    );
  }
  const extension = deps.os === "windows" ? "zip" : "tar.gz";
  const archive = `${
    archiveDir(deps, opts.downloadDir)
  }/herdr-core-${release.coreVersion}-${release.target}.${extension}`;
  await Deno.mkdir(dirname(archive), { recursive: true });
  const bytes = await ensureArchive(deps, {
    url: release.coreUrl,
    sha256: release.coreSha256,
    cachePath: archive,
    label: "herdr-core",
  });

  const action = deps.os === "windows"
    ? await placeCoreWindows(deps, bytes, layout, release, have)
    : await placeCoreUnix(deps, bytes, layout, release, have, opts);

  const version = await probeCoreVersion(deps, layout.corePath);
  if (!version) {
    throw new Error(
      `herdr-core was placed at ${layout.corePath} but reports no version; ` +
        `re-run, or open Herdr so it installs the core itself`,
    );
  }
  deps.log(`herdr-core ${version} (${action}) at ${layout.corePath}`);
  return { action, version };
}

/** Place herdr-core on Linux and macOS from its tar.gz. */
async function placeCoreUnix(
  deps: HostDeps,
  bytes: Uint8Array,
  layout: Layout,
  release: ResolvedRelease,
  have: string,
  opts: { releasesUrl: string; force: boolean },
): Promise<string> {
  const staging = `${layout.coreDir}/.herdr-core-${release.coreVersion}.new`;
  await removeTree(staging);
  await extractTarGz(bytes, staging);
  const fresh = `${staging}/herdr-core`;
  if (!(await pathExists(deps, fresh, deps.os))) {
    await removeTree(staging);
    throw new Error(
      "the herdr-core archive holds no herdr-core; nothing was changed",
    );
  }
  await Deno.chmod(fresh, 0o755);
  const runs = await deps.run(fresh, ["--version"]);
  if (runs.code !== 0) {
    await removeTree(staging);
    throw new Error(
      "the downloaded herdr-core does not run on this machine; nothing was changed",
    );
  }

  const bundle = `${staging}/Herdr Core.app`;
  const bundled = `${bundle}/Contents/MacOS/herdr-core`;
  let action: string;
  if (deps.os === "macos" && await pathExists(deps, bundled, deps.os)) {
    if (isVendorReleaseHost(opts.releasesUrl)) {
      await verifyMacCore(deps, bundle);
    }
    const install = await deps.run(bundled, [
      "--hc-install-bundle",
      bundled,
      layout.corePath,
    ]);
    if (install.code !== 0) {
      throw new Error(
        `installing Herdr Core.app failed: ${
          (install.stderr || install.stdout).trim()
        }`,
      );
    }
    action = have ? "updated" : "installed";
    if (have) await deps.run(layout.corePath, ["server", "restart"]);
  } else if (await pathExists(deps, layout.corePath, deps.os)) {
    const update = await deps.run(layout.corePath, ["update", "--from", fresh]);
    if (update.code !== 0) {
      throw new Error(
        `updating ${layout.corePath} failed: ${
          (update.stderr || update.stdout).trim()
        }`,
      );
    }
    action = "updated";
  } else {
    await Deno.mkdir(layout.coreDir, { recursive: true });
    const staged = `${layout.corePath}.new`;
    await Deno.copyFile(fresh, staged);
    await Deno.chmod(staged, 0o755);
    await Deno.rename(staged, layout.corePath);
    action = "installed";
  }
  await removeTree(staging);
  await linkHc(deps, layout);
  return action;
}

/** Place herdr-core on Windows from its zip, keeping a running core alive. */
async function placeCoreWindows(
  deps: HostDeps,
  bytes: Uint8Array,
  layout: Layout,
  release: ResolvedRelease,
  have: string,
): Promise<string> {
  void have;
  const zip = `${
    archiveDir(deps, "")
  }/herdr-core-${release.coreVersion}-${release.target}.zip`;
  await Deno.mkdir(dirname(zip), { recursive: true });
  await Deno.writeFile(zip, bytes);
  const staging = `${layout.coreDir}.new`;
  await removeTree(staging);
  await Deno.mkdir(staging, { recursive: true });
  const untar = await deps.run(windowsTar(deps), ["-xf", zip, "-C", staging]);
  if (untar.code !== 0) {
    await removeTree(staging);
    throw new Error(
      `cannot unpack the herdr-core zip: ${
        (untar.stderr || untar.stdout).trim()
      }`,
    );
  }
  const fresh = `${staging}\\herdr-core.exe`;
  if (!(await pathExists(deps, fresh, deps.os))) {
    await removeTree(staging);
    throw new Error(
      "the herdr-core archive holds no herdr-core.exe; nothing was changed",
    );
  }
  const existing = await pathExists(deps, layout.corePath, deps.os);
  if (existing) {
    const update = await deps.run(layout.corePath, ["update", "--from", fresh]);
    if (update.code !== 0) {
      throw new Error(
        `updating ${layout.corePath} failed: ${
          (update.stderr || update.stdout).trim()
        }`,
      );
    }
  } else {
    await Deno.mkdir(layout.coreDir, { recursive: true });
    await Deno.copyFile(fresh, layout.corePath);
    const conpty = `${staging}\\conpty`;
    if (await pathExists(deps, conpty, deps.os)) {
      await copyTree(conpty, `${layout.coreDir}\\conpty`);
    }
  }
  const notices = `${staging}\\THIRD-PARTY-NOTICES`;
  if (await pathExists(deps, notices, deps.os)) {
    await copyTree(notices, `${layout.coreDir}\\THIRD-PARTY-NOTICES`);
  }
  await removeTree(staging);
  if (!(await pathExists(deps, layout.hcPath, deps.os))) {
    await Deno.link(layout.corePath, layout.hcPath).catch(() => {});
  }
  await runPowerShell(deps, windowsPathScript(layout.coreDir));
  return existing ? "updated" : "installed";
}

/** Verify a macOS Herdr Core.app against the vendor's release requirement. */
async function verifyMacCore(deps: HostDeps, bundle: string): Promise<void> {
  const requirement =
    `=identifier "dev.herdr.core" and anchor apple generic and certificate ` +
    `leaf[subject.OU] = "${HERDR_TEAM_ID}"`;
  const verify = await deps.run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "-R",
    requirement,
    bundle,
  ]);
  if (verify.code !== 0) {
    throw new Error(
      `the downloaded Herdr Core.app is not a signed Herdr release: ${
        (verify.stderr || verify.stdout).trim()
      }`,
    );
  }
}

/** True when a releases URL is the vendor's own host. */
export function isVendorReleaseHost(url: string): boolean {
  return /^https?:\/\/releases\.herdr\.dev\/?$/.test(url.trim());
}

/** Symlink `hc` beside herdr-core when no `hc` is already reachable. */
async function linkHc(deps: HostDeps, layout: Layout): Promise<void> {
  if (await pathExists(deps, layout.hcPath, deps.os)) return;
  const found = await deps.run("which", ["hc"]);
  if (found.code === 0) return;
  await Deno.symlink("herdr-core", layout.hcPath);
}

/** The Windows `tar.exe`, which is the only tar that reads a zip correctly. */
function windowsTar(deps: HostDeps): string {
  const root = deps.env.systemRoot || "C:\\Windows";
  return `${root}\\System32\\tar.exe`;
}

/** Run a PowerShell script without shell-quoting hazards (`-EncodedCommand`). */
async function runPowerShell(deps: HostDeps, script: string): Promise<void> {
  const result = await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodePowerShell(script),
  ]);
  if (result.code !== 0) {
    throw new Error(
      `PowerShell failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** What installing the bundled theme did. */
export interface ThemeInstallResult {
  /** Theme id, or "" when themes were skipped. */
  id: string;
  /** The theme file's path, or "". */
  path: string;
  /** installed | unchanged | skipped. */
  action: string;
  /** True when this run set the theme in settings.json. */
  selected: boolean;
  /** The theme that was on show before (a name, a light/dark pair, or ""). */
  previousTheme: string;
  /** settings.json's path. */
  settingsPath: string;
  /** Anything the person should know, or "". */
  warning: string;
}

/**
 * Install the bundled theme into Herdr's `themes/` and, when the person has not
 * chosen a theme yet, select it in `settings.json`.
 *
 * The theme file is rewritten only when its text differs (or `force`), and an
 * existing choice — a name or a light/dark pair — is never overwritten: Herdr's
 * own setting is the person's, so a chosen theme stays chosen. An unreadable
 * `settings.json` is reported, never replaced.
 */
export async function installHerdrTheme(
  deps: HostDeps,
  opts: {
    themeId: string;
    themeText: string;
    appHome: string;
    select: boolean;
    force: boolean;
  },
): Promise<ThemeInstallResult> {
  const settingsPath = settingsFilePath(opts.appHome, deps.os);
  if (!opts.themeId.trim()) {
    return {
      id: "",
      path: "",
      action: "skipped",
      selected: false,
      previousTheme: "",
      settingsPath,
      warning: "",
    };
  }
  const id = opts.themeId.trim();
  const path = themeFilePath(opts.appHome, id, deps.os);
  const { unknownColors } = parseHerdrTheme(opts.themeText, `theme ${id}`);
  const warnings: string[] = [];
  if (unknownColors.length) {
    warnings.push(
      `theme ${id} sets colours Herdr does not resolve (${
        unknownColors.join(", ")
      }); they are ignored`,
    );
  }

  let action = "unchanged";
  const existing = await readTextOr(path, "");
  if (opts.force || existing !== opts.themeText) {
    await writeFileAtomic(path, opts.themeText);
    action = "installed";
  }

  const current = await readThemeChoice(deps, opts.appHome);
  const shown = current.theme || (current.light || current.dark)
    ? current.theme || `${current.light}/${current.dark}`
    : "";
  let selected = false;
  if (opts.select && !current.chosen) {
    const settingsText = await readTextOr(settingsPath, "");
    try {
      const merged = withThemeChoice(settingsText, id);
      if (merged.changed) {
        await writeFileAtomic(settingsPath, merged.text);
        selected = true;
      }
    } catch (error) {
      warnings.push(errorMessage(error));
    }
  }
  const result: ThemeInstallResult = {
    id,
    path,
    action,
    selected,
    previousTheme: shown,
    settingsPath,
    warning: warnings.join("; "),
  };
  deps.log(
    `theme ${id}: ${action} at ${path}; ${
      selected
        ? "selected in settings.json"
        : current.chosen
        ? `kept the chosen theme (${shown || "set"})`
        : "not selected"
    }`,
  );
  if (result.warning) deps.log(`theme ${id}: ${result.warning}`);
  return result;
}

/** Read a text file, or `fallback` when it is absent or unreadable. */
async function readTextOr(path: string, fallback: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return fallback;
  }
}

/** Write a file through a temporary neighbour, so a reader never sees half. */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.new-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, text);
  try {
    await Deno.rename(tmp, path);
  } finally {
    try {
      await Deno.remove(tmp);
    } catch {
      // renamed (the normal path)
    }
  }
}

/** Remove the bundled theme file; a missing one is a no-op. */
async function removeHerdrTheme(
  deps: HostDeps,
  appHome: string,
  themeId: string,
): Promise<boolean> {
  if (!themeId.trim()) return false;
  const path = themeFilePath(appHome, themeId.trim(), deps.os);
  if (!(await pathExists(deps, path, deps.os))) return false;
  await removeTree(path);
  return true;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/** What `uninstall` removed. */
export interface UninstallResult {
  removed: string[];
  kept: string[];
}

/**
 * Remove the app, its link, its Linux launcher entry or Windows shortcut, and
 * — only when asked — herdr-core. Idempotent: a missing path is reported as
 * kept-by-absence, not an error.
 */
export async function uninstallHerdr(
  deps: HostDeps,
  opts: {
    appDir: string;
    binDir: string;
    removeCore: boolean;
    removeTheme: boolean;
    herdrHome: string;
    theme: string;
  },
): Promise<UninstallResult> {
  const platform = platformOf(deps);
  const layout = layoutOf(deps, { appDir: opts.appDir, binDir: opts.binDir });
  const removed: string[] = [];
  const kept: string[] = [];

  if (await pathExists(deps, layout.appDir, platform.os)) {
    await removeTree(layout.appDir);
    removed.push(layout.appDir);
  }
  if (layout.linkPath && await pathExists(deps, layout.linkPath, platform.os)) {
    await removeTree(layout.linkPath);
    removed.push(layout.linkPath);
  }
  for (const path of [layout.desktopFile, layout.iconFile]) {
    if (path && await pathExists(deps, path, platform.os)) {
      await removeTree(path);
      removed.push(path);
    }
  }
  if (platform.os === "windows") {
    await runPowerShell(deps, windowsShortcutRemoveScript());
    await runPowerShell(deps, windowsPathRemoveScript(layout.binDir));
    removed.push("the Herdr Start menu shortcut");
  }

  if (opts.removeCore) {
    if (await pathExists(deps, layout.corePath, platform.os)) {
      await removeTree(layout.corePath);
      removed.push(layout.corePath);
    }
    if (await pathExists(deps, layout.hcPath, platform.os)) {
      await removeTree(layout.hcPath);
      removed.push(layout.hcPath);
    }
    if (
      platform.os === "windows" &&
      await pathExists(deps, layout.coreDir, platform.os)
    ) {
      await removeTree(layout.coreDir);
      removed.push(layout.coreDir);
    }
    if (platform.os === "windows") {
      await runPowerShell(deps, windowsPathRemoveScript(layout.coreDir));
    }
  } else if (
    await pathExists(deps, layout.corePath, platform.os)
  ) {
    kept.push(`${layout.corePath} (pass removeCore=true to remove it too)`);
  }

  if (opts.removeTheme) {
    const appHome = appHomeOf(deps, opts.herdrHome);
    const themePath = themeFilePath(appHome, opts.theme, platform.os);
    if (await removeHerdrTheme(deps, appHome, opts.theme)) {
      removed.push(themePath);
    }
  }

  return { removed, kept };
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

/** Remove a file, symlink or directory tree; a missing path is fine. */
async function removeTree(path: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (info.isDirectory && !info.isSymlink) {
      await Deno.remove(path, { recursive: true });
    } else {
      await Deno.remove(path);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

/** Recursively copy a directory tree. */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}\\${entry.name}`;
    const dst = `${to}\\${entry.name}`;
    if (entry.isDirectory) await copyTree(src, dst);
    else await Deno.copyFile(src, dst);
  }
}

/** The directory archives are staged in. */
function archiveDir(deps: HostDeps, downloadDir: string): string {
  if (downloadDir.trim()) return downloadDir.trim();
  return layoutOf(deps).cacheDir;
}

// ---------------------------------------------------------------------------
// Host deps
// ---------------------------------------------------------------------------

/** Map `Deno.build.os` to a host family, or null when unsupported. */
function hostOsFromDeno(os: string): HostOs | null {
  if (os === "linux") return "linux";
  if (os === "darwin") return "macos";
  if (os === "windows") return "windows";
  return null;
}

/**
 * Build the real host dependencies: Deno's fetch and subprocess runner, the
 * compiled-in platform, and the environment paths. Rosetta is detected on
 * macOS so an x86_64 process on Apple silicon still resolves the arm64 app.
 */
export async function hostDeps(
  log: (message: string) => void,
): Promise<HostDeps> {
  const os = hostOsFromDeno(Deno.build.os);
  if (!os) {
    throw new Error(
      `herdr-app has no build for ${Deno.build.os}; it ships for Linux, macOS ` +
        `and Windows`,
    );
  }
  const run: RunFn = async (command, args, options) => {
    try {
      // A subprocess seam is the whole point of an installer: it runs the
      // vendor's tar/PowerShell/codesign tools. No shell is involved, and
      // every argument is passed as one literal argv element.
      // swamp-quality-ignore deno-command
      const result = await new Deno.Command(command, {
        args,
        stdin: options?.stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
        env: options?.env,
      }).output();
      const decoder = new TextDecoder();
      return {
        code: result.code,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    } catch {
      return { code: 127, stdout: "", stderr: `${command}: not found` };
    }
  };
  let rosetta = false;
  if (os === "macos") {
    const probe = await run("sysctl", ["-n", "sysctl.proc_translated"]);
    rosetta = probe.stdout.trim() === "1";
  }
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  if (!home) {
    throw new Error(
      "cannot find the home directory: set HOME (or USERPROFILE on Windows)",
    );
  }
  return {
    fetch,
    run,
    os,
    arch: Deno.build.arch,
    rosetta,
    env: {
      home,
      localAppData: Deno.env.get("LOCALAPPDATA") ?? "",
      xdgData: Deno.env.get("XDG_DATA_HOME") ?? "",
      xdgCache: Deno.env.get("XDG_CACHE_HOME") ?? "",
      xdgConfig: Deno.env.get("XDG_CONFIG_HOME") ?? "",
      herdrAppHome: Deno.env.get("HERDR_APP_HOME") ?? "",
      userProfile: Deno.env.get("USERPROFILE") ?? home,
      systemRoot: Deno.env.get("SystemRoot") ?? "",
    },
    log,
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface MethodContext {
  /** Resolves an `additionalFiles:` entry to a path (swamp's own resolver). */
  extensionFile?: (relativePath: string) => string;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warn: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/**
 * Read one of this extension's bundled theme documents. Throws when the theme
 * is not bundled, rather than installing nothing quietly.
 */
function bundledThemeText(ctx: MethodContext, id: string): string {
  const relative = `themes/${id}.json`;
  if (!ctx.extensionFile) {
    throw new Error(
      `cannot read the bundled theme ${id}: this swamp build does not expose ` +
        `extension files`,
    );
  }
  const path = ctx.extensionFile(relative);
  try {
    return Deno.readTextFileSync(path);
  } catch (error) {
    throw new Error(
      `the bundled theme ${id} is not readable at ${path} ` +
        `(${errorMessage(error)}); pass theme="" to skip themes`,
    );
  }
}

/** Model definition for `@svendowideit/herdr-app`. */
export const model = {
  type: "@svendowideit/herdr-app",
  version: "2026.11.09.3",
  globalArguments: z.object({}),

  upgrades: [
    {
      toVersion: "2026.11.09.1",
      description:
        "Initial release: plan, install, inspect and remove the Herdr desktop " +
        "app and herdr-core on Linux, macOS and Windows, resolved from " +
        "releases.herdr.dev with SHA-256 verification; plus a pinned POSIX " +
        "installer for hosts without swamp (via @swamp/ssh) and an @swamp/ssh " +
        "fleet builder.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.09.2",
      description:
        "Ships the Borland Modern Blue theme and installs it by default: " +
        "install (and the ssh installer) now write themes/borland-modern-blue.json " +
        "into Herdr's own home and select it in settings.json when no theme is " +
        "chosen yet. New installTheme method, theme resource, and theme fields " +
        'on status/install. No existing argument changed; theme="" opts out.',
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.09.3",
      description:
        "Installs the swamp layout as part of the same run: the install and " +
        "worker workflows now call @jpisgeek/herdr-swamp-layout's install " +
        "method after the app is placed (declared in dependencies:), so the " +
        "upgrade puts the approvals, runs and quick-run panels inside Herdr. " +
        "It is skipped when the layout is already present, since that " +
        "installer refuses to overwrite. status now lists the layouts Herdr " +
        "offers, and swampLayout=false opts out.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    release: {
      description:
        "The release resolved for this host: app and core versions, the " +
        "verified archive URLs and checksums, and the platform target.",
      schema: ReleaseSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    plan: {
      description:
        "What installing the resolved release would do, decided from what is " +
        "actually on the host.",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    install: {
      description:
        "What an install run did: action, previous and new version, paths, and " +
        "what happened to herdr-core.",
      schema: InstallSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    status: {
      description:
        "What is installed on this host right now, read from the binaries " +
        "themselves.",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    transport: {
      description:
        "An @swamp/ssh fleet (hosts + transport) built from the workflow " +
        "inputs, for the ssh transport.",
      schema: TransportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    theme: {
      description:
        "The result of `installTheme`: where the bundled theme was written, " +
        "whether it is on show, and anything the person should know.",
      schema: ThemeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    script: {
      description:
        "The pinned POSIX installer sent to hosts that have no swamp, with " +
        "the release it installs.",
      schema: ScriptSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    plan: {
      description:
        "Resolve the app (and core) release for this host, probe what is " +
        "installed, and record what an install would do. No files are " +
        "written and nothing is downloaded except the two manifests.",
      arguments: PlanArgs,
      execute: async (args: PlanArgsType, ctx: MethodContext) => {
        const deps = await hostDeps((message) => ctx.logger.info(message));
        const release = await resolveRelease(deps, {
          releasesUrl: args.releasesUrl,
          version: args.version,
          coreVersion: args.coreVersion,
          core: args.core,
        });
        const installed = await probeInstalled(deps, {
          appDir: args.appDir,
          binDir: args.binDir,
        });
        const plan = planInstall(installed, release, {
          core: args.core,
          force: args.force,
        });
        const now = deps.now().toISOString();
        const releaseHandle = await ctx.writeResource("release", "release", {
          version: release.version,
          coreMin: release.coreMin,
          notes: release.notes,
          target: release.target,
          os: deps.os,
          arch: deps.arch,
          url: release.url,
          sha256: release.sha256,
          coreVersion: release.coreVersion,
          coreUrl: release.coreUrl,
          coreSha256: release.coreSha256,
          releasesUrl: release.releasesUrl,
          resolvedAt: now,
        });
        const planHandle = await ctx.writeResource("plan", "plan", {
          action: plan.action,
          reason: plan.reason,
          installedVersion: installed.appVersion,
          targetVersion: release.version,
          coreMode: args.core,
          coreAction: plan.coreAction,
          coreVersion: release.coreVersion,
          target: release.target,
          os: deps.os,
          arch: deps.arch,
          appPath: installed.layout.appDir,
          checkedAt: now,
        });
        ctx.logger.info(plan.reason);
        return { dataHandles: [releaseHandle, planHandle] };
      },
    },

    install: {
      description:
        "Download, verify and install the app (and herdr-core per `core`) on " +
        "this host. Accepts a resolved release so one plan can install many " +
        "hosts. Idempotent: a host already on the target version is unchanged.",
      arguments: InstallArgs,
      execute: async (args: InstallArgsType, ctx: MethodContext) => {
        const deps = await hostDeps((message) => ctx.logger.info(message));
        const release = args.release
          ? releaseFromResource(args.release, deps)
          : await resolveRelease(deps, {
            releasesUrl: args.releasesUrl,
            version: args.version,
            coreVersion: args.coreVersion,
            core: args.core,
          });
        const themeText = args.theme ? bundledThemeText(ctx, args.theme) : "";
        let result: InstallResult;
        try {
          result = await installHerdr(deps, {
            release,
            core: args.core,
            force: args.force,
            appDir: args.appDir,
            binDir: args.binDir,
            downloadDir: "",
            herdrHome: args.herdrHome,
            theme: args.theme,
            themeText,
            selectTheme: args.selectTheme,
          });
        } catch (error) {
          await ctx.writeResource("install", "install", {
            action: "failed",
            version: release.version,
            previousVersion: "",
            appPath:
              layoutOf(deps, { appDir: args.appDir, binDir: args.binDir })
                .appDir,
            target: release.target,
            os: deps.os,
            arch: deps.arch,
            coreAction: "unknown",
            coreVersion: "",
            corePath: "",
            force: args.force,
            notes: errorMessage(error),
            theme: args.theme,
            themeAction: "unknown",
            themeSelected: false,
            themePath: "",
            installedAt: deps.now().toISOString(),
          });
          throw error;
        }
        const handle = await ctx.writeResource("install", "install", {
          action: result.action,
          version: result.version,
          previousVersion: result.previousVersion,
          appPath: result.layout.appDir,
          target: result.platform.target,
          os: result.platform.os,
          arch: result.platform.arch,
          coreAction: result.coreAction,
          coreVersion: result.coreVersion,
          corePath: result.layout.corePath,
          force: args.force,
          notes: result.notes,
          theme: result.theme.id,
          themeAction: result.theme.action,
          themeSelected: result.theme.selected,
          themePath: result.theme.path,
          installedAt: deps.now().toISOString(),
        });
        ctx.logger.info(
          "herdr-app {action}: {version} at {path} (herdr-core: {core}; theme: {theme})",
          {
            action: result.action,
            version: result.version,
            path: result.layout.appDir,
            core: result.coreAction === "skipped"
              ? "left alone"
              : `${result.coreVersion || "absent"} (${result.coreAction})`,
            theme: result.theme.id
              ? `${result.theme.id} ${result.theme.action}${
                result.theme.selected ? ", selected" : ""
              }`
              : "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report what is installed on this host right now: the app version " +
        "read from the binary, its path, and whether herdr-core is present " +
        "and which version it reports.",
      arguments: StatusArgs,
      execute: async (args: StatusArgsType, ctx: MethodContext) => {
        const deps = await hostDeps((message) => ctx.logger.info(message));
        const installed = await probeInstalled(deps, {
          appDir: args.appDir,
          binDir: args.binDir,
        });
        const appHome = appHomeOf(deps, args.herdrHome);
        const themeFile = themeFilePath(
          appHome,
          HERDR_THEME_ID,
          installed.platform.os,
        );
        const themeInstalled = await pathExists(
          deps,
          themeFile,
          installed.platform.os,
        );
        const themeChoice = await readThemeChoice(deps, appHome);
        const handle = await ctx.writeResource("status", "status", {
          target: installed.platform.target,
          os: installed.platform.os,
          arch: installed.platform.arch,
          appPresent: installed.appPresent,
          appVersion: installed.appVersion,
          appPath: installed.layout.appDir,
          appKind: installed.appKind,
          corePresent: installed.corePresent,
          coreVersion: installed.coreVersion,
          corePath: installed.corePath,
          herdrHome: appHome,
          themeFile,
          themeInstalled,
          themeChoice: themeChoice.theme ||
            (themeChoice.chosen
              ? `${themeChoice.light}/${themeChoice.dark}`
              : ""),
          themeSelected: themeOnShow(themeChoice),
          layouts: installed.layouts,
          checkedAt: deps.now().toISOString(),
        });
        ctx.logger.info(
          "herdr-app {app}; herdr-core {core}; theme {theme}",
          {
            app: installed.appVersion
              ? `${installed.appVersion} at ${installed.layout.appDir}`
              : "is not installed",
            core: installed.corePresent
              ? `${installed.coreVersion || "present"} at ${installed.corePath}`
              : "is not installed",
            theme: themeInstalled
              ? `${HERDR_THEME_ID} installed${
                themeOnShow(themeChoice) ? ", on show" : ", not selected"
              }`
              : "not installed",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    uninstall: {
      description:
        "Remove the app, its command link, and its Linux launcher entry or " +
        "Windows Start menu shortcut. The shared herdr-core is kept unless " +
        "`removeCore` is set. Idempotent.",
      arguments: UninstallArgs,
      execute: async (args: UninstallArgsType, ctx: MethodContext) => {
        const deps = await hostDeps((message) => ctx.logger.info(message));
        const result = await uninstallHerdr(deps, {
          appDir: args.appDir,
          binDir: args.binDir,
          removeCore: args.removeCore,
          removeTheme: args.removeTheme,
          herdrHome: args.herdrHome,
          theme: HERDR_THEME_ID,
        });
        const handle = await ctx.writeResource("install", "install", {
          action: "uninstalled",
          version: "",
          previousVersion: "",
          appPath: layoutOf(deps, { appDir: args.appDir, binDir: args.binDir })
            .appDir,
          target: platformOf(deps).target,
          os: deps.os,
          arch: deps.arch,
          coreAction: args.removeCore ? "removed" : "kept",
          coreVersion: "",
          corePath: "",
          force: args.force,
          theme: args.removeTheme ? HERDR_THEME_ID : "",
          themeAction: args.removeTheme ? "removed" : "kept",
          themeSelected: false,
          themePath: "",
          notes: [
            result.removed.length
              ? `removed ${result.removed.join(", ")}`
              : "nothing was installed",
            ...result.kept,
          ].join("; "),
          installedAt: deps.now().toISOString(),
        });
        ctx.logger.info(
          result.removed.length
            ? `removed ${result.removed.join(", ")}`
            : "nothing was installed, so nothing was removed",
        );
        return { dataHandles: [handle] };
      },
    },

    installTheme: {
      description:
        "Install the bundled Herdr theme (Borland Modern Blue by default) into " +
        "Herdr's themes directory and, when the person has not chosen a theme " +
        "yet, select it in settings.json. Idempotent, and it never overwrites an " +
        "existing choice.",
      arguments: InstallThemeArgs,
      execute: async (args: InstallThemeArgsType, ctx: MethodContext) => {
        const deps = await hostDeps((message) => ctx.logger.info(message));
        const result = await installHerdrTheme(deps, {
          themeId: args.theme,
          themeText: bundledThemeText(ctx, args.theme),
          appHome: appHomeOf(deps, args.herdrHome),
          select: args.select,
          force: args.force,
        });
        const handle = await ctx.writeResource("theme", "theme", {
          id: result.id,
          path: result.path,
          action: result.action,
          selected: result.selected,
          previousTheme: result.previousTheme,
          settingsPath: result.settingsPath,
          warning: result.warning,
          checkedAt: deps.now().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    renderScript: {
      description:
        "Resolve the release and render the pinned POSIX installer for every " +
        "Linux/macOS target, so one script serves a mixed fleet. It checksums " +
        "what it downloads, refuses a host it has no pin for, and installs or " +
        "updates the app and (per `core`) herdr-core. The ssh workflow pipes " +
        "it to @swamp/ssh's `script` method.",
      arguments: RenderScriptArgs,
      execute: async (args: RenderScriptArgsType, ctx: MethodContext) => {
        const deps = await hostDeps((message) => ctx.logger.info(message));
        const { appVersion, coreVersion, pins } = await resolveFleetPins(deps, {
          releasesUrl: args.releasesUrl,
          version: args.version,
          coreVersion: args.coreVersion,
          core: args.core,
        });
        const themeText = args.theme ? bundledThemeText(ctx, args.theme) : "";
        const script = renderInstallScript({
          appVersion,
          coreVersion: args.core === "never" ? "" : coreVersion,
          pins: args.core === "never"
            ? pins.map((pin) => ({ ...pin, coreUrl: "", coreSha256: "" }))
            : pins,
          force: args.force,
          coreMode: args.core,
          verifyCoreSignature: args.verifyCoreSignature &&
            isVendorReleaseHost(args.releasesUrl),
          theme: args.theme
            ? { id: args.theme, json: themeText, select: args.selectTheme }
            : undefined,
        });
        const handle = await ctx.writeResource("script", "script", {
          targets: pins.map((pin) => pin.target),
          appVersion,
          coreVersion: args.core === "never" ? "" : coreVersion,
          coreMode: args.core,
          force: args.force,
          theme: args.theme,
          script,
          generatedAt: deps.now().toISOString(),
        });
        ctx.logger.info(
          "rendered the herdr-app {version} installer for {targets} with theme {theme} ({lines} lines)",
          {
            version: appVersion,
            targets: pins.map((pin) => pin.target).join(", "),
            theme: args.theme || "none",
            lines: script.split("\n").length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    sshFleet: {
      description:
        "Build the @swamp/ssh fleet (hosts plus transport) for the ssh " +
        "transport from a comma-separated host list. One transport applies to " +
        "every host, so user, port and identity are shared.",
      arguments: SshFleetArgs,
      execute: async (args: SshFleetArgsType, ctx: MethodContext) => {
        const hosts = parseHosts(args.hosts);
        if (hosts.length === 0) {
          throw new Error(
            "no hosts given: pass hosts=name=address (or a bare address) for " +
              "every machine to install on",
          );
        }
        const transport = buildSshTransport(args);
        const handle = await ctx.writeResource("transport", "transport", {
          fleet: args.fleet,
          hosts,
          transport,
          recordedAt: new Date().toISOString(),
        });
        ctx.logger.info(
          "ssh fleet {fleet}: {count} host(s) via ssh on port {port}",
          { fleet: args.fleet, count: hosts.length, port: args.port },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Rebuild a `ResolvedRelease` from a stored `release` resource. */
export function releaseFromResource(
  value: Record<string, unknown>,
  deps?: HostDeps,
): ResolvedRelease {
  const text = (key: string): string =>
    typeof value[key] === "string" ? String(value[key]) : "";
  const version = text("version");
  const target = text("target");
  const url = text("url");
  const sha256 = text("sha256");
  if (!version || !target || !url || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
    throw new Error(
      "the release given to install is incomplete; run `plan` first and pass " +
        "its release resource",
    );
  }
  if (deps && target !== platformOf(deps).target) {
    throw new Error(
      `the release was resolved for ${target} but this host is ` +
        `${platformOf(deps).target}; run plan on this host`,
    );
  }
  return {
    version,
    coreMin: text("coreMin"),
    notes: text("notes"),
    target: target as Target,
    url,
    sha256: sha256.toLowerCase(),
    coreVersion: text("coreVersion"),
    coreUrl: text("coreUrl"),
    coreSha256: text("coreSha256").toLowerCase(),
    releasesUrl: text("releasesUrl") || DEFAULT_RELEASES_URL,
  };
}

/**
 * Parse `name=address,address` into @swamp/ssh hosts. A bare address uses the
 * address as its name, with anything a host name cannot hold replaced by `-`.
 * A repeated name is refused, because one fleet cannot hold two hosts by the
 * same name.
 */
export function parseHosts(input: string): Array<{
  name: string;
  address: string;
  tags: string[];
  attrs: Record<string, unknown>;
}> {
  const hosts = input
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const eq = entry.indexOf("=");
      const name = eq > 0 ? entry.slice(0, eq).trim() : "";
      const address = eq > 0 ? entry.slice(eq + 1).trim() : entry;
      const safe = (name || address).replace(/[^A-Za-z0-9_.-]/g, "-");
      return { name: safe, address, tags: [], attrs: {} };
    });
  const seen = new Set<string>();
  for (const host of hosts) {
    if (seen.has(host.name)) {
      throw new Error(
        `two hosts would be named ${host.name}; give each one a distinct ` +
          `name=address entry`,
      );
    }
    seen.add(host.name);
  }
  return hosts;
}

/** Build the @swamp/ssh transport object from the fleet arguments. */
export function buildSshTransport(args: {
  user: string;
  port: number;
  identityFile: string;
  hostKeyChecking: "yes" | "accept-new" | "no" | "off";
  connectTimeoutSec: number;
}): Record<string, unknown> {
  const transport: Record<string, unknown> = {
    kind: "ssh",
    port: args.port,
    auth: { kind: "key" },
    connectTimeoutSec: args.connectTimeoutSec,
    strictHostKeyChecking: args.hostKeyChecking,
    extraOptions: [],
    controlMaster: { enabled: true, persistSec: 600 },
  };
  if (args.user) transport.user = args.user;
  if (args.identityFile) transport.identityFile = args.identityFile;
  return transport;
}
