// swamp-quality-ignore testing-completeness: the shared helpers and builders
// are exercised by the sibling obsidian_app_test.ts, which drives this module
// through a fake Deps (success, skip and failure paths).
/**
 * Pure helpers, host side effects and resource builders for
 * {@link @svendowideit/obsidian-app}.
 *
 * The model file keeps only schemas and thin `execute` wrappers; everything
 * that reads the host, unpacks the installer, registers the Obsidian CLI or
 * edits the app's config lives here behind {@link Deps}. That split keeps every
 * non-trivial branch unit-testable with a fake {@link Deps}, and keeps the
 * model's methods small.
 *
 * Scope: Linux only, and deliberately rootless. The installer is the official
 * `obsidian-<version>.tar.gz` release asset unpacked under
 * {@link Config.installDir}; the CLI is the `obsidian-cli` binary that ships
 * inside it, registered the way Obsidian's own Linux registration does it —
 * copied to `~/.local/bin/obsidian`.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The repository publishing Obsidian's desktop installers. */
export const OBSIDIAN_REPO: string = "obsidianmd/obsidian-releases";

/** The first installer that ships the `obsidian-cli` binary. */
export const MIN_CLI_INSTALLER: string = "1.12.7";

/** The command name the Obsidian CLI registers on Linux. */
export const CLI_NAME: string = "obsidian";

/** The marker file recording what this extension installed, inside installDir. */
export const MARKER_NAME: string = ".swamp-obsidian-app.json";

/** Install modes this extension can perform (rootless tar.gz unpack). */
export const INSTALL_MODES: readonly string[] = ["tar"];

/**
 * How this extension may get Chromium's sandbox working.
 *
 * `auto` resolves to `setuid`; nothing here ever disables sandboxing on its own.
 */
export const SANDBOX_ROUTES: readonly string[] = [
  "auto",
  "setuid",
  "apparmor",
  "no-sandbox",
  "report",
];

/** The setuid helper Chromium ships inside the installer. */
export const SANDBOX_HELPER_NAME: string = "chrome-sandbox";

/** The user-owned copy the privileged step installs the helper from. */
export const SANDBOX_STAGE_NAME: string = ".chrome-sandbox.stage";

/** Where an AppArmor profile for the app would be loaded from. */
export const APPARMOR_PROFILE_PATH: string = "/etc/apparmor.d/obsidian";

/**
 * How long a launch probe may run before it counts as started.
 *
 * Chromium's sandbox verdict is immediate (it aborts before any window), so a
 * probe that is still up after this is being killed mid-start and counts as a
 * successful launch — short enough not to hold a window open in a desktop
 * session, long enough not to mistake a slow start for the sandbox.
 */
export const SANDBOX_PROBE_TIMEOUT_MS: number = 12000;

/** Sysctl Ubuntu 23.10+ uses to deny unprivileged user namespaces. */
export const APPARMOR_USERNS_SYSCTL: string =
  "kernel.apparmor_restrict_unprivileged_userns";

/** Sysctl Debian uses to deny unprivileged user namespaces. */
export const USERNS_CLONE_SYSCTL: string = "kernel.unprivileged_userns_clone";

// ---------------------------------------------------------------------------
// Side-effect surface
// ---------------------------------------------------------------------------

/** The result of running a subprocess. */
export interface RunResult {
  /** Exit code, or 127 when the binary could not be started. */
  code: number;
  /** Decoded stdout, trimmed. */
  stdout: string;
  /** Decoded stderr, trimmed. */
  stderr: string;
}

/** Options for {@link Deps.run}. */
export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Kill the command after this many milliseconds (reported as code 124). */
  timeoutMs?: number;
}

/** The injectable side effects of the extension, so tests can fake the host. */
export interface Deps {
  /** Run a command, capturing output; never throws for a non-zero exit. */
  run: (bin: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
  /** Read a UTF-8 text file, returning "" when it is absent or unreadable. */
  readText: (path: string) => Promise<string>;
  /** Write a UTF-8 text file; true on success. */
  writeText: (path: string, data: string) => Promise<boolean>;
  /** Whether a path exists. */
  exists: (path: string) => Promise<boolean>;
  /** Create a directory and its parents. */
  mkdirp: (path: string) => Promise<void>;
  /** List directory entry names, or [] when unreadable. */
  readDir: (path: string) => Promise<string[]>;
  /** Copy a file byte for byte. */
  copy: (from: string, to: string) => Promise<void>;
  /** Set a file's permission bits. */
  chmod: (path: string, mode: number) => Promise<void>;
  /** Remove a file (never a directory tree); throws when it cannot. */
  remove: (path: string) => Promise<void>;
  /** A file's permission bits, or null when it is absent. */
  fileMode: (path: string) => Promise<number | null>;
  /** The uid owning a path, or null when it is absent. */
  fileUid: (path: string) => Promise<number | null>;
  /** Hex SHA-256 of a file's bytes. */
  sha256File: (path: string) => Promise<string>;
  /** Hex SHA-256 of the given bytes. */
  sha256Hex: (bytes: Uint8Array) => Promise<string>;
  /** Read an environment variable for the extension's own decisions. */
  env: (key: string) => string | undefined;
  /** The current user's home directory. */
  home: () => string;
  /** The host platform. */
  platform: () => "linux" | "darwin" | "other";
  /** The host CPU architecture. */
  arch: () => "x64" | "arm64" | "other";
  /** Current time as an ISO 8601 string. */
  now: () => string;
  /** PIDs whose executable name matches `name` (best-effort; [] if unknown). */
  pids: (name: string) => Promise<number[]>;
}

/** The real {@link Deps}, backed by Deno and the host. */
export function realDeps(): Deps {
  const deps: Deps = {
    run: async (bin, args, opts = {}) => {
      try {
        const timeoutMs = opts.timeoutMs ?? 0;
        // swamp-quality-ignore deno-command: tar, dpkg-query, the app's own launch probe and the installed CLI are subprocesses; every argument is built here, none taken from untrusted input.
        const out = await new Deno.Command(bin, {
          args,
          cwd: opts.cwd,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
        }).output();
        const dec = new TextDecoder();
        return {
          code: out.code,
          stdout: dec.decode(out.stdout).trim(),
          stderr: dec.decode(out.stderr).trim(),
        };
      } catch (error) {
        // AbortSignal.timeout() rejects with a TimeoutError DOMException, an
        // explicit abort with an AbortError; either way the command did not
        // finish, and the probe reads code 124 as "did not exit".
        if (
          error instanceof DOMException &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          return {
            code: 124,
            stdout: "",
            stderr: `timed out after ${opts.timeoutMs ?? 0}ms`,
          };
        }
        return { code: 127, stdout: "", stderr: `${error}` };
      }
    },
    readText: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch {
        return "";
      }
    },
    writeText: async (path, data) => {
      try {
        await Deno.writeTextFile(path, data);
        return true;
      } catch {
        return false;
      }
    },
    exists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    mkdirp: async (path) => {
      await Deno.mkdir(path, { recursive: true });
    },
    readDir: async (path) => {
      try {
        const names: string[] = [];
        for await (const entry of Deno.readDir(path)) names.push(entry.name);
        return names;
      } catch {
        return [];
      }
    },
    copy: async (from, to) => {
      await Deno.copyFile(from, to);
    },
    chmod: async (path, mode) => {
      await Deno.chmod(path, mode);
    },
    remove: async (path) => {
      await Deno.remove(path);
    },
    fileMode: async (path) => {
      try {
        return (await Deno.stat(path)).mode ?? null;
      } catch {
        return null;
      }
    },
    fileUid: async (path) => {
      try {
        return (await Deno.stat(path)).uid ?? null;
      } catch {
        return null;
      }
    },
    sha256File: async (path) => {
      const bytes = await Deno.readFile(path);
      return await deps.sha256Hex(bytes);
    },
    sha256Hex: async (bytes) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        bytes as unknown as BufferSource,
      );
      return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },
    env: (key) => Deno.env.get(key),
    home: () => Deno.env.get("HOME") ?? "",
    platform: () => {
      const os = Deno.build.os;
      return os === "linux" ? "linux" : os === "darwin" ? "darwin" : "other";
    },
    arch: () => {
      const a = Deno.build.arch;
      return a === "x86_64" ? "x64" : a === "aarch64" ? "arm64" : "other";
    },
    now: () => new Date().toISOString(),
    pids: async (name) => {
      // pgrep -x matches the exact process name; absence is [] not an error.
      const out = await deps.run("pgrep", ["-x", name]);
      if (out.code !== 0 || !out.stdout) return [];
      return out.stdout.split(/\s+/).map((s) => Number(s)).filter((n) =>
        Number.isFinite(n)
      );
    },
  };
  return deps;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The resolved configuration a method works from. */
export interface Config {
  /** Install mode; only `tar` is implemented (rootless official tar.gz). */
  installMode: string;
  /** Directory the installer is unpacked into. */
  installDir: string;
  /** Directory the Obsidian CLI (`obsidian`) is registered in. */
  cliDir: string;
  /** The Obsidian desktop app's config directory (holds `obsidian.json`). */
  appConfigDir: string;
  /** Directory the verified release archive is staged in. */
  downloadDir: string;
  /** Whether to write a user-local `obsidian.desktop` launcher. */
  desktopEntry: boolean;
  /** Whether to turn the app's `cli` setting on so the CLI is allowed to run. */
  enableCli: boolean;
  /** How to make Chromium's sandbox work (see {@link SANDBOX_ROUTES}). */
  sandbox: string;
  /** The GitHub repository publishing the installers. */
  repo: string;
}

/** Host locations {@link normaliseConfig} needs to resolve defaults. */
export interface HostPaths {
  /** The current user's home directory. */
  home: string;
  /** `$XDG_CONFIG_HOME`, or "". */
  xdgConfigHome?: string;
  /** The host platform (`linux`, `darwin`, `other`). */
  platform: string;
}

/** Build a {@link Config}, expanding `~` and applying defaults. */
export function normaliseConfig(
  input: Partial<Config>,
  host: HostPaths,
): Config {
  const home = host.home;
  const configBase = (host.xdgConfigHome ?? "").trim() || `${home}/.config`;
  return {
    installMode: (input.installMode ?? "").trim() || "tar",
    installDir: expandHome(
      (input.installDir ?? "").trim() || "~/.local/share/obsidian",
      home,
    ),
    cliDir: expandHome((input.cliDir ?? "").trim() || "~/.local/bin", home),
    appConfigDir: expandHome(
      (input.appConfigDir ?? "").trim() || `${configBase}/obsidian`,
      home,
    ),
    downloadDir: expandHome(
      (input.downloadDir ?? "").trim() || "~/.cache/obsidian-app",
      home,
    ),
    desktopEntry: input.desktopEntry ?? true,
    enableCli: input.enableCli ?? true,
    sandbox: sandboxRoute(input.sandbox ?? ""),
    repo: (input.repo ?? "").trim() || OBSIDIAN_REPO,
  };
}

/** Expand a leading `~` to `home`; absolute paths pass through. */
export function expandHome(path: string, home: string): string {
  if (!path) return "";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** Join path segments, collapsing duplicate separators. */
export function joinPath(...parts: string[]): string {
  const cleaned = parts
    .filter((p) => p !== "")
    .map((p, i) => {
      const trimmed = i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+/, "");
      return i === parts.length - 1 ? trimmed.replace(/\/+$/, "") : trimmed;
    });
  return cleaned.join("/").replace(/\/{2,}/g, "/");
}

// ---------------------------------------------------------------------------
// Versions and digests
// ---------------------------------------------------------------------------

/** Strip a leading `v` and surrounding whitespace, so `v1.15.0` == `1.15.0`. */
export function normaliseVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Compare two version strings by numeric dotted segments (ignoring a `v`). */
export function compareVersions(a: string, b: string): number {
  const pa = normaliseVersion(a).split(".");
  const pb = normaliseVersion(b).split(".");
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
 * Turn a GitHub API asset `digest` (`sha256:<hex>`) into a bare hex SHA-256.
 *
 * Returns "" for a missing digest or a non-SHA-256 algorithm, so a caller
 * records the archive as unverified rather than verifying against the wrong
 * hash.
 */
export function sha256FromDigest(digest: unknown): string {
  const text = typeof digest === "string" ? digest.trim().toLowerCase() : "";
  const prefix = "sha256:";
  if (!text.startsWith(prefix)) return "";
  const hex = text.slice(prefix.length).trim();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : "";
}

/** Parse JSON, returning null instead of throwing. */
export function parseJsonSafe(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The desktop app's own config
// ---------------------------------------------------------------------------

/** What this extension reads from the app's `obsidian.json`. */
export interface AppConfigState {
  /** Absolute vault paths the app knows about, sorted. */
  vaults: string[];
  /** The `cli` flag: true/false when set, null when the key is absent. */
  cli: boolean | null;
}

/** Parse the Obsidian desktop app's `obsidian.json` body. */
export function parseAppConfig(text: string): AppConfigState {
  const value = parseJsonSafe(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { vaults: [], cli: null };
  }
  const record = value as Record<string, unknown>;
  const vaults: string[] = [];
  const rawVaults = record["vaults"];
  if (rawVaults && typeof rawVaults === "object") {
    for (const entry of Object.values(rawVaults as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const path = String((entry as Record<string, unknown>)["path"] ?? "");
      if (path) vaults.push(path);
    }
  }
  vaults.sort((a, b) => a.localeCompare(b));
  const cli = typeof record["cli"] === "boolean" ? record["cli"] : null;
  return { vaults, cli };
}

/** The result of turning the app's `cli` setting on in an `obsidian.json` body. */
export interface AppConfigEdit {
  /** The rewritten body (unchanged when nothing had to change). */
  text: string;
  /** Whether the body differs from the input. */
  changed: boolean;
}

/**
 * Turn the app's `cli` setting on in an `obsidian.json` body.
 *
 * Every other key is preserved. A body that already has `cli: true` is returned
 * unchanged, and an unparseable body is also returned unchanged — the caller
 * must back up rather than clobber something it cannot read.
 */
export function withCliEnabled(text: string): AppConfigEdit {
  const value = parseJsonSafe(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { text, changed: false };
  }
  const record = value as Record<string, unknown>;
  if (record["cli"] === true) return { text, changed: false };
  record["cli"] = true;
  return { text: `${JSON.stringify(record, null, 2)}\n`, changed: true };
}

/**
 * Extract the app versions the desktop app keeps in its config directory —
 * files named `obsidian-<version>.asar` (the app package it auto-updated itself
 * to), oldest first.
 */
export function parseAppPackageVersions(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const m = /^obsidian-(\d+(?:\.\d+)*)\.asar$/.exec(name);
    if (m) out.push(m[1]);
  }
  return out.sort(compareVersions);
}

/** The newest app package version the desktop app has installed, or "". */
export function latestAppPackageVersion(names: string[]): string {
  const versions = parseAppPackageVersions(names);
  return versions.length ? versions[versions.length - 1] : "";
}

/** The versions reported by the CLI's `version` command. */
export interface CliVersionOutput {
  /** The app version, or "". */
  appVersion: string;
  /** The installer version, or "". */
  installerVersion: string;
}

/**
 * Read the versions out of the CLI's `version` output, e.g.
 * `1.15.0 (installer 1.15.0)`.
 */
export function parseCliVersionOutput(output: string): CliVersionOutput {
  const firstLine = output.trim().split("\n")[0].trim();
  const installer = /installer\s+v?(\d+(?:\.\d+)*)/i.exec(firstLine);
  const app = /^v?(\d+(?:\.\d+)*)/.exec(firstLine);
  return {
    appVersion: app ? app[1] : "",
    installerVersion: installer ? installer[1] : "",
  };
}

// ---------------------------------------------------------------------------
// Asset selection
// ---------------------------------------------------------------------------

/** One archive asset from a GitHub release, as github-release-install records it. */
export interface ReleaseAsset {
  /** The asset's file name. */
  name: string;
  /** Browser download URL. */
  url: string;
  /** Size in bytes, when the API reported it. */
  size?: number;
  /** The API's per-asset digest (`sha256:…`), when published. */
  digest?: string;
}

/** The archive this extension needs for an install. */
export interface AssetInfo {
  /** Release version (no leading `v`). */
  version: string;
  /** The archive's file name. */
  archiveName: string;
  /** Browser download URL for the archive. */
  downloadUrl: string;
  /** SHA-256 of the archive from the release's asset digest, or "". */
  checksum: string;
  /** Hash algorithm of {@link checksum}, or "". */
  checksumAlgorithm: string;
  /** Archive size in bytes, or 0 when unknown. */
  size: number;
  /** Install mode the archive serves. */
  mode: string;
  /** CPU architecture the archive serves (`x64` or `arm64`). */
  arch: string;
  /** The release's tag (e.g. `v1.15.0`). */
  releaseTag: string;
  /** The peer model instance the release was read from. */
  releaseModel: string;
  /** When the asset was selected. */
  selectedAt: string;
}

/** The asset-name pattern for a mode and architecture, or null if unsupported. */
export function assetPatternFor(mode: string, arch: string): RegExp | null {
  if (mode !== "tar") return null;
  return arch === "arm64"
    ? /^obsidian-[\d.]+-arm64\.tar\.gz$/
    : /^obsidian-[\d.]+\.tar\.gz$/;
}

/** A human description of the archive a mode/arch combination needs. */
export function expectedAssetFor(mode: string, arch: string): string {
  if (mode !== "tar") return "";
  return arch === "arm64"
    ? "obsidian-<version>-arm64.tar.gz"
    : "obsidian-<version>.tar.gz";
}

/**
 * Pick the installer archive for a mode and architecture from a release's
 * assets. Returns null when the release ships nothing matching.
 */
export function selectObsidianAsset(
  assets: ReleaseAsset[],
  mode: string,
  arch: string,
): ReleaseAsset | null {
  const pattern = assetPatternFor(mode, arch);
  if (!pattern) return null;
  const matches = assets.filter((a) => pattern.test(a.name));
  if (matches.length === 0) return null;
  // Newest version wins if a release ever carries more than one.
  return matches.sort((a, b) =>
    compareVersions(versionFromAssetName(b.name), versionFromAssetName(a.name))
  )[0];
}

/** Extract the version from an Obsidian archive file name, or "". */
export function versionFromAssetName(name: string): string {
  const m = /(?:obsidian|Obsidian)[-_](\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1] : "";
}

/** A release as recorded by `@svendowideit/github-release-install`'s `check`. */
export interface PeerRelease {
  /** Release version, no leading `v`. */
  version?: string;
  /** Release tag. */
  tag?: string;
  /** Release assets. */
  assets?: ReleaseAsset[];
  /** API URL the release was fetched from. */
  sourceUrl?: string;
}

/** The host facts {@link planAsset} needs. */
export interface PlanHost {
  /** Host CPU architecture (`x64` or `arm64`). */
  arch: string;
  /** Host platform. */
  platform: string;
  /** The peer model instance the release was read from. */
  releaseModel: string;
  /** Current timestamp. */
  now: string;
}

/**
 * Choose the installer archive for this host from a peer release, or throw with
 * a message naming what the release actually ships.
 */
export function planAsset(
  release: PeerRelease,
  cfg: Config,
  host: PlanHost,
): AssetInfo {
  if (host.platform !== "linux") {
    throw new Error(
      `obsidian-app installs the Linux desktop build; this host reports ` +
        `platform '${host.platform}'. Use Obsidian's own installer there.`,
    );
  }
  if (!INSTALL_MODES.includes(cfg.installMode)) {
    throw new Error(
      `installMode '${cfg.installMode}' is not supported — this extension ` +
        `unpacks the official tar.gz installer rootlessly (installMode=tar).`,
    );
  }
  if (host.arch !== "x64" && host.arch !== "arm64") {
    throw new Error(
      `Unsupported CPU architecture '${host.arch}'; Obsidian publishes ` +
        `x86_64 and arm64 builds.`,
    );
  }
  const version = normaliseVersion(String(release.version ?? ""));
  if (!version) {
    throw new Error(
      "The peer release has no version — run the release step first: " +
        "`swamp workflow run @svendowideit/obsidian-app-upgrade`.",
    );
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = selectObsidianAsset(assets, cfg.installMode, host.arch);
  if (!asset) {
    const wanted = expectedAssetFor(cfg.installMode, host.arch);
    const available = assets.map((a) => a.name).sort().join(", ") || "(none)";
    throw new Error(
      `Release ${version} ships no ${wanted} archive. Assets: ${available}.`,
    );
  }
  const checksum = sha256FromDigest(asset.digest);
  return {
    version: versionFromAssetName(asset.name) || version,
    archiveName: asset.name,
    downloadUrl: asset.url,
    checksum,
    checksumAlgorithm: checksum ? "sha256" : "",
    size: asset.size ?? 0,
    mode: cfg.installMode,
    arch: host.arch,
    releaseTag: String(release.tag ?? ""),
    releaseModel: host.releaseModel,
    selectedAt: host.now,
  };
}

// ---------------------------------------------------------------------------
// PATH + desktop entry helpers
// ---------------------------------------------------------------------------

/** Split a `PATH` value into its directories, dropping empties. */
export function pathDirs(pathEnv: string): string[] {
  return pathEnv.split(":").map((p) => p.trim()).filter((p) => p !== "");
}

/** Drop a single trailing slash, unless the whole string is `/`. */
export function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Whether `dir` is one of the `PATH` entries. */
export function isDirOnPath(dir: string, pathEnv: string): boolean {
  const target = stripTrailingSlash(dir);
  return pathDirs(pathEnv).some((p) => stripTrailingSlash(p) === target);
}

/**
 * The directory on `PATH` that resolves `name` in a real shell — the first
 * entry holding a file of that name. `hasFile` is the (async) existence probe,
 * so the resolution order is testable without touching the filesystem.
 */
export async function firstDirWithName(
  name: string,
  pathEnv: string,
  hasFile: (path: string) => Promise<boolean>,
): Promise<string> {
  for (const dir of pathDirs(pathEnv)) {
    if (await hasFile(joinPath(dir, name))) return dir;
  }
  return "";
}

/** The body of the user-local desktop entry for an install directory. */
export function desktopEntryBody(
  installDir: string,
  execPath?: string,
): string {
  return [
    "[Desktop Entry]",
    "Name=Obsidian",
    `Exec=${execPath ?? joinPath(installDir, "obsidian")} %U`,
    "Terminal=false",
    "Type=Application",
    "Icon=obsidian",
    "StartupWMClass=obsidian",
    "Comment=Obsidian",
    "MimeType=x-scheme-handler/obsidian;",
    "Categories=Office;",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Host state
// ---------------------------------------------------------------------------

/** Host + install state snapshot written by `setup`. */
export interface StatusInfo {
  /** Host platform. */
  platform: string;
  /** Host CPU architecture. */
  arch: string;
  /** Configured install mode. */
  installMode: string;
  /** Configured install directory. */
  installDir: string;
  /** Configured CLI directory. */
  cliDir: string;
  /** The app config directory that holds `obsidian.json`. */
  appConfigDir: string;
  /** Whether this extension's install is present (its binary exists). */
  installed: boolean;
  /** Installer version recorded by the last install, or "". */
  installedVersion: string;
  /** Absolute path of the installed app binary. */
  binaryPath: string;
  /** Absolute path of the `obsidian-cli` binary inside the install. */
  cliSourcePath: string;
  /** Whether the install ships `obsidian-cli` (needs installer 1.12.7+). */
  cliSourcePresent: boolean;
  /** App package version the desktop app auto-updated itself to, or "". */
  appPackageVersion: string;
  /** Version of a system (deb/rpm) Obsidian package, or "". */
  systemPackageVersion: string;
  /** Vault paths registered with the desktop app. */
  vaults: string[];
  /** Whether the desktop app is running right now. */
  appRunning: boolean;
  /** Registered CLI path. */
  cliPath: string;
  /** Whether the registered CLI file exists. */
  cliRegistered: boolean;
  /** Whether the registered CLI file is executable. */
  cliExecutable: boolean;
  /** Whether the CLI directory is on `PATH`. */
  cliDirOnPath: boolean;
  /** The directory that actually resolves `obsidian` first, or "". */
  cliFirstOnPathDir: string;
  /** Whether that first match is the registered CLI file. */
  cliReachable: boolean;
  /** The app's `cli` setting: true/false, or null when unset/unknown. */
  cliFlag: boolean | null;
  /** Whether a user-local desktop entry exists. */
  desktopEntryPresent: boolean;
  /** Whether the shipped `chrome-sandbox` setuid helper is there. */
  sandboxHelperPresent: boolean;
  /** The helper's permission bits, or -1 when it is absent. */
  sandboxHelperMode: number;
  /** The uid owning the helper, or -1 when it is absent. */
  sandboxHelperOwnerUid: number;
  /** Whether the helper is root-owned mode 4755, which is what Chromium needs. */
  sandboxHelperSetuidRoot: boolean;
  /** Whether this host refuses unprivileged user namespaces. */
  sandboxUsernsRestricted: boolean;
  /** When this snapshot was taken. */
  checkedAt: string;
  /** Human notes about anything that needs attention. */
  notes: string[];
}

/** Read the marker this extension writes into the install directory. */
export async function readMarker(
  deps: Deps,
  installDir: string,
): Promise<Record<string, unknown>> {
  const parsed = parseJsonSafe(
    await deps.readText(joinPath(installDir, MARKER_NAME)),
  );
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

/** The user-local desktop entry path for this host. */
export function desktopEntryPath(deps: Deps): string {
  const dataHome = (deps.env("XDG_DATA_HOME") ?? "").trim() ||
    `${deps.home()}/.local/share`;
  return joinPath(dataHome, "applications", "obsidian.desktop");
}

// ---------------------------------------------------------------------------
// Chromium sandbox
// ---------------------------------------------------------------------------
//
// Electron cannot start without a working sandbox: it either builds one from
// unprivileged user namespaces, or it uses the setuid helper
// (`chrome-sandbox`, which must be root-owned and mode 4755) — and it aborts
// with a FATAL rather than run unsandboxed. Ubuntu 23.10+ denies user
// namespaces to unconfined binaries (kernel.apparmor_restrict_unprivileged_userns),
// so a tarball unpacked by a normal user — which is how this extension
// installs — has a helper that is present but useless. The .deb gets this from
// its postinst; a rootless unpack has to do it explicitly.

/** Normalise a configured sandbox route, defaulting to `auto`. */
export function sandboxRoute(value: string): string {
  const route = (value ?? "").trim().toLowerCase();
  return SANDBOX_ROUTES.includes(route) ? route : "auto";
}

/**
 * The route a configured value actually takes: `auto` means "fix the setuid
 * helper", which is the only route that can be automated through one
 * privileged step and works on every distro.
 */
export function resolvedSandboxRoute(desired: string): string {
  const route = sandboxRoute(desired);
  return route === "auto" ? "setuid" : route;
}

/** Absolute path of the shipped setuid sandbox helper. */
export function sandboxHelperPath(cfg: Config): string {
  return joinPath(cfg.installDir, SANDBOX_HELPER_NAME);
}

/** The user-owned copy of the helper the privileged step installs from. */
export function sandboxStagePath(cfg: Config): string {
  return joinPath(cfg.installDir, SANDBOX_STAGE_NAME);
}

/** The wrapper a `no-sandbox` route runs instead of the app binary. */
export function noSandboxWrapperPath(cfg: Config): string {
  return joinPath(cfg.installDir, "obsidian-no-sandbox");
}

/** The staged AppArmor profile the `apparmor` route asks a person to load. */
export function apparmorProfileStagingPath(cfg: Config): string {
  return joinPath(cfg.installDir, "obsidian.apparmor");
}

/**
 * Quote a path for a POSIX shell, so a directory name can never become shell
 * syntax in the wrapper this extension writes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The body of the wrapper that starts the app with its sandbox disabled. */
export function noSandboxWrapperBody(binaryPath: string): string {
  return [
    "#!/bin/sh",
    "# Written by @svendowideit/obsidian-app (sandbox=no-sandbox): the Chromium",
    "# sandbox is unusable on this host, so Obsidian runs with renderer",
    "# sandboxing disabled. Delete this file and re-run the install workflow",
    "# with sandbox=setuid to restore it.",
    `exec ${shellQuote(binaryPath)} --no-sandbox "$@"`,
    "",
  ].join("\n");
}

/**
 * An AppArmor profile that lets the app build the *namespace* sandbox, which
 * is what Ubuntu denies unconfined binaries. It keeps the setuid helper out of
 * the picture entirely, so no binary on disk has to be root-owned.
 */
export function apparmorProfileBody(binaryPath: string): string {
  return [
    "# Allows Obsidian's unprivileged user-namespace sandbox, which Ubuntu",
    "# 24.04+ denies to unconfined binaries. Written by",
    "# @svendowideit/obsidian-app; load it with `apparmor_parser -r`.",
    "include <tunables/global>",
    "",
    `profile obsidian ${binaryPath} flags=(unconfined) {`,
    "  userns,",
    "}",
    "",
  ].join("\n");
}

/** What a launch probe learned. */
export interface SandboxProbe {
  /** Whether the app started. */
  launches: boolean;
  /**
   * Why it cannot start: `ok`, `setuid`, `missing`, `sandbox` (it only fails
   * with the sandbox on), `unconfirmed` (it fails for a reason that is not the
   * sandbox — over ssh there is no display) or `not-installed`.
   */
  cause: string;
  /** The probe's exit code (124 when it timed out). */
  exitCode: number;
  /** The probe's combined output, truncated. */
  output: string;
}

/** The first non-empty line of probe output, for a one-line note. */
export function firstOutputLine(output: string): string {
  const line = output.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line ?? "";
}

/**
 * Turn a probe result into a verdict.
 *
 * Chromium names its two failure modes precisely, so they are matched exactly
 * rather than guessed at from the exit code. A probe that times out has got
 * past the sandbox check and stayed up (a GUI answered `--version` by opening a
 * window), which counts as starting; a sandbox refusal aborts immediately.
 *
 * Anything else is `unconfirmed`, not a failure: the app may not start for a
 * reason that has nothing to do with the sandbox (no display in an ssh session),
 * which {@link probeSandbox} then separates with a control run.
 */
export function interpretSandboxProbe(res: RunResult): SandboxProbe {
  const combined = [res.stdout, res.stderr].filter((s) => s !== "").join("\n");
  const output = combined.length > 600
    ? `${combined.slice(0, 600)}…`
    : combined;
  if (/SUID sandbox helper binary was found/i.test(combined)) {
    return { launches: false, cause: "setuid", exitCode: res.code, output };
  }
  if (/No usable sandbox/i.test(combined)) {
    return { launches: false, cause: "missing", exitCode: res.code, output };
  }
  if (res.code === 124) {
    return { launches: true, cause: "ok", exitCode: res.code, output };
  }
  if (res.code === 0) {
    return { launches: true, cause: "ok", exitCode: res.code, output };
  }
  return { launches: false, cause: "unconfirmed", exitCode: res.code, output };
}

/**
 * Start the app once with `--version` and see whether Chromium lets it run.
 *
 * `--version` prints the CLI usage and exits, so this is a sub-second check on
 * a healthy install; it is still a *launch*, which is why it lives here and not
 * in the read-only `setup`.
 *
 * When that launch fails for a reason that is not one of Chromium's two sandbox
 * refusals, the same launch is repeated with `--no-sandbox`:
 *
 *   - it works with the sandbox off  → the sandbox is what stops it (`sandbox`),
 *     whatever this Chromium release calls the error;
 *   - it fails exactly the same way → the failure is the environment, not the
 *     sandbox (`unconfirmed`) — a swamp workflow over ssh has no `DISPLAY`.
 */
export async function probeSandbox(
  deps: Deps,
  cfg: Config,
): Promise<SandboxProbe> {
  const binaryPath = joinPath(cfg.installDir, "obsidian");
  if (!(await deps.exists(binaryPath))) {
    return {
      launches: false,
      cause: "not-installed",
      exitCode: 127,
      output: "",
    };
  }
  const primary = await probeBinary(deps, binaryPath);
  if (primary.launches || primary.cause !== "unconfirmed") return primary;
  const control = await probeBinary(deps, binaryPath, ["--no-sandbox"]);
  if (control.launches) {
    return { ...primary, cause: "sandbox" };
  }
  return {
    launches: false,
    cause: "unconfirmed",
    exitCode: primary.exitCode,
    output: [
      `sandboxed: ${primary.output}`,
      `with --no-sandbox: ${control.output}`,
    ].join("\n"),
  };
}

/** Probe one executable (the app binary, or a wrapper around it). */
export async function probeBinary(
  deps: Deps,
  path: string,
  extraArgs: string[] = [],
): Promise<SandboxProbe> {
  if (!(await deps.exists(path))) {
    return {
      launches: false,
      cause: "not-installed",
      exitCode: 127,
      output: "",
    };
  }
  const res = await deps.run(path, [...extraArgs, "--version"], {
    timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
  });
  return interpretSandboxProbe(res);
}

/** The setuid helper's permissions and ownership. */
export interface SandboxHelperState {
  /** Absolute path of the helper. */
  path: string;
  /** Whether the file is there at all. */
  present: boolean;
  /** The file's permission bits, or -1 when absent. */
  mode: number;
  /** The uid owning the file, or -1 when absent. */
  ownerUid: number;
  /** Whether it is root-owned with the setuid bit, which is what Chromium needs. */
  setuidRoot: boolean;
}

/** Read the setuid helper's mode and owner. */
export async function sandboxHelperState(
  deps: Deps,
  cfg: Config,
): Promise<SandboxHelperState> {
  const path = sandboxHelperPath(cfg);
  const mode = await deps.fileMode(path);
  const uid = await deps.fileUid(path);
  return {
    path,
    present: mode !== null,
    mode: mode ?? -1,
    ownerUid: uid ?? -1,
    setuidRoot: mode !== null && uid === 0 && (mode & 0o4000) !== 0,
  };
}

/**
 * Whether this host refuses unprivileged user namespaces — the condition that
 * makes a rootless `chrome-sandbox` useless.
 *
 * The kernel knobs are read through `sysctl`, not `readText`: swamp runs a
 * method's own file reads inside its sandbox, where `/proc` reads come back
 * empty, which would report a restricted host as unrestricted. When neither
 * knob answers (an older or non-Linux kernel), the kernel itself is asked by
 * building one namespace.
 */
export async function userNamespacesRestricted(
  deps: Deps,
): Promise<boolean> {
  const apparmor = await deps.run("sysctl", ["-n", APPARMOR_USERNS_SYSCTL]);
  if (apparmor.code === 0 && apparmor.stdout.trim() === "1") return true;
  const clone = await deps.run("sysctl", ["-n", USERNS_CLONE_SYSCTL]);
  if (clone.code === 0 && clone.stdout.trim() === "0") return true;
  if (apparmor.code === 0 || clone.code === 0) return false;
  const unshare = await deps.run("unshare", [
    "-U",
    "--map-root-user",
    "true",
  ]);
  return unshare.code !== 0;
}

/**
 * Whether the sandbox itself is broken.
 *
 * A probe verdict of `setuid`, `missing` or `sandbox` proves it. So does a
 * launch that failed for an unrelated reason on a host whose helper is not
 * root-owned while user namespaces are denied — the configuration nothing can
 * work from. An `unconfirmed` probe on a correctly configured host is *not* a
 * sandbox failure: the app did not start for some other reason, and saying so
 * is the honest report.
 */
export function sandboxBroken(
  probe: SandboxProbe,
  usernsRestricted: boolean,
  helper: SandboxHelperState,
): boolean {
  if (
    probe.cause === "setuid" || probe.cause === "missing" ||
    probe.cause === "sandbox"
  ) {
    return true;
  }
  return probe.cause === "unconfirmed" && usernsRestricted &&
    !helper.setuidRoot;
}

/** A one-sentence cause for a probe verdict. */
export function sandboxCauseText(
  cause: string,
  host: { installDir: string },
): string {
  switch (cause) {
    case "setuid":
      return `Chromium refuses to run without a sandbox because ` +
        `${joinPath(host.installDir, SANDBOX_HELPER_NAME)} is not root-owned ` +
        `with mode 4755, and this host denies unprivileged user namespaces`;
    case "missing":
      return `Chromium found no usable sandbox helper and this host denies ` +
        `unprivileged user namespaces`;
    case "sandbox":
      return `Obsidian starts with \`--no-sandbox\` but not with the sandbox ` +
        `on, so Chromium's sandbox is refusing to run on this host`;
    case "not-installed":
      return `there is no Obsidian install at ${host.installDir}`;
    default:
      return `Obsidian did not stay up when it was started, for a reason that ` +
        `is not the sandbox`;
  }
}

/**
 * The extra thing to say when Chromium's own wording names a cause the fix
 * command cannot cure.
 *
 * A setuid helper on a `nosuid` mount is root-owned and mode 4755 and still
 * cannot elevate; Chromium says "The setuid sandbox is not running as root."
 * The fix is not another `install -D`: it is another directory (or the
 * AppArmor/namespace route).
 */
export function sandboxMountHint(
  probeOutput: string,
  cfg: { installDir: string },
): string {
  if (!/setuid sandbox is not running as root/i.test(probeOutput)) return "";
  return ` ${cfg.installDir} is on a filesystem that refuses setuid, so the ` +
    `helper cannot elevate even when it is root-owned mode 4755 — check with ` +
    `\`findmnt -no TARGET,OPTIONS --target ${cfg.installDir}\`. Install under ` +
    `a filesystem without \`nosuid\` (the default ~/.local/share is fine), or ` +
    `pass \`--input sandbox=apparmor\` to use the namespace sandbox instead.`;
}

/** The exact host command that fixes a broken sandbox, for a person to run. */
export function sandboxFallbackCommand(
  route: string,
  cfg: Config,
  helper: SandboxHelperState,
): string {
  switch (route) {
    case "apparmor":
      return `sudo install -D -m 644 ${apparmorProfileStagingPath(cfg)} ` +
        `${APPARMOR_PROFILE_PATH} && sudo apparmor_parser -r ` +
        `${APPARMOR_PROFILE_PATH}`;
    case "no-sandbox":
      return `swamp workflow run @svendowideit/obsidian-app-upgrade ` +
        `--input sandbox=no-sandbox`;
    default:
      return `sudo install -D -m 4755 ${sandboxStagePath(cfg)} ` +
        `${helper.path}`;
  }
}

/** The sandbox plan, and the result of checking it. */
export interface SandboxInfo {
  /** The configured route (`auto`, `setuid`, `apparmor`, `no-sandbox`, `report`). */
  desired: string;
  /** The route this run acted on, after resolving `auto`; `none` when idle. */
  route: string;
  /** `ok` | `needs-elevation` | `manual` | `unsandboxed` | `not-installed`. */
  state: string;
  /** Whether the app started when it was probed. */
  launches: boolean;
  /** Why it cannot start: `ok`, `setuid`, `missing`, `unknown`, `not-installed`. */
  cause: string;
  /** The probe's output, truncated. */
  probeOutput: string;
  /** Absolute path of the shipped setuid helper. */
  helperPath: string;
  /** The helper's permission bits, or -1 when it is absent. */
  helperMode: number;
  /** The uid owning the helper, or -1 when it is absent. */
  helperOwnerUid: number;
  /** Whether the helper is already root-owned mode 4755. */
  helperSetuidRoot: boolean;
  /** Whether this host denies unprivileged user namespaces. */
  usernsRestricted: boolean;
  /** Whether a privileged step must run to make the app launchable. */
  sudoRequired: boolean;
  /** The @svendowideit/sudo operation the privileged step runs, or "". */
  sudoOperation: string;
  /** The staged file that operation installs from, or "". */
  sudoSrc: string;
  /** The file that operation writes, or "". */
  sudoDest: string;
  /** The mode that operation sets, or "". */
  sudoMode: string;
  /** The staged copy of the helper left for the privileged step, or "". */
  stagePath: string;
  /** The no-sandbox wrapper, or "". */
  wrapperPath: string;
  /** The AppArmor profile staged for a person to load, or "". */
  profilePath: string;
  /** The host command that fixes this when no elevation route is granted. */
  fallbackCommand: string;
  /**
   * Whether the sandbox was verified good — by a launch that stayed up, or by
   * the helper's ownership and mode when this session cannot show a window.
   */
  verified: boolean;
  /** Anything a person still needs to know. */
  notes: string[];
  /** When this ran. */
  checkedAt: string;
}

/** The empty {@link SandboxInfo} every path starts from. */
function blankSandbox(
  desired: string,
  probe: SandboxProbe,
  helper: SandboxHelperState,
  userns: boolean,
  now: string,
): SandboxInfo {
  return {
    desired,
    route: "none",
    state: "ok",
    launches: probe.launches,
    cause: probe.cause,
    probeOutput: probe.output,
    helperPath: helper.path,
    helperMode: helper.mode,
    helperOwnerUid: helper.ownerUid,
    helperSetuidRoot: helper.setuidRoot,
    usernsRestricted: userns,
    sudoRequired: false,
    sudoOperation: "",
    sudoSrc: "",
    sudoDest: "",
    sudoMode: "",
    stagePath: "",
    wrapperPath: "",
    profilePath: "",
    fallbackCommand: "",
    verified: probe.launches,
    notes: [],
    checkedAt: now,
  };
}

/** Write the no-sandbox wrapper and point the desktop entry at it. */
async function applyNoSandbox(
  deps: Deps,
  cfg: Config,
): Promise<string> {
  const wrapper = noSandboxWrapperPath(cfg);
  await deps.mkdirp(cfg.installDir);
  const written = await deps.writeText(
    wrapper,
    noSandboxWrapperBody(joinPath(cfg.installDir, "obsidian")),
  );
  // A silent write failure here would leave the user with a launcher pointing
  // at a file that does not exist, so fail with the path and the fix.
  if (!written) {
    throw new Error(
      `Could not write the no-sandbox wrapper at ${wrapper}, so Obsidian ` +
        `would still not start. Fix the directory's permissions and re-run ` +
        `\`swamp workflow run @svendowideit/obsidian-app-upgrade\`.`,
    );
  }
  await deps.chmod(wrapper, 0o755);
  if (cfg.desktopEntry) {
    await writeDesktopEntry(deps, cfg, wrapper);
  }
  return wrapper;
}

/** Remove a stale no-sandbox wrapper and point the desktop entry back. */
async function clearNoSandbox(
  deps: Deps,
  cfg: Config,
): Promise<{ removed: boolean; error: string }> {
  const wrapper = noSandboxWrapperPath(cfg);
  if (!(await deps.exists(wrapper))) return { removed: false, error: "" };
  try {
    await deps.remove(wrapper);
  } catch (error) {
    return { removed: false, error: `${error}` };
  }
  if (cfg.desktopEntry) await writeDesktopEntry(deps, cfg);
  return { removed: true, error: "" };
}

/**
 * Work out how to make the app start, doing the part that needs no privileges:
 * staging the helper for the privileged step, writing an opt-in no-sandbox
 * wrapper, or staging the AppArmor profile for a person to load.
 */
export async function planSandbox(
  deps: Deps,
  cfg: Config,
): Promise<SandboxInfo> {
  const desired = sandboxRoute(cfg.sandbox);
  const probe = await probeSandbox(deps, cfg);
  const helper = await sandboxHelperState(deps, cfg);
  const userns = await userNamespacesRestricted(deps);
  const info = blankSandbox(desired, probe, helper, userns, deps.now());

  if (probe.cause === "not-installed") {
    info.state = "not-installed";
    info.fallbackCommand =
      `swamp workflow run @svendowideit/obsidian-app-upgrade`;
    info.notes.push(
      `Nothing to check: there is no Obsidian install at ${cfg.installDir}. ` +
        `Run \`swamp workflow run @svendowideit/obsidian-app-upgrade\`.`,
    );
    return info;
  }

  if (desired === "no-sandbox") {
    info.route = "no-sandbox";
    info.state = "unsandboxed";
    info.wrapperPath = await applyNoSandbox(deps, cfg);
    info.verified = (await probeBinary(deps, info.wrapperPath)).launches;
    info.notes.push(
      `Obsidian now starts through ${info.wrapperPath} with ` +
        "`--no-sandbox`: renderer sandboxing is OFF. " +
        (probe.launches
          ? "The plain binary started too, so this was not needed — re-run " +
            "the workflow with sandbox=report to go back to a sandboxed launch."
          : "Switch back with `--input sandbox=setuid` once the helper can be " +
            "installed as root."),
    );
    return info;
  }

  if (!sandboxBroken(probe, userns, helper)) {
    // Working. Drop anything a previous `no-sandbox` run left behind.
    const cleared = await clearNoSandbox(deps, cfg);
    if (cleared.removed) {
      info.notes.push(
        `Removed the stale no-sandbox wrapper: Obsidian starts normally ` +
          "again, so the sandbox is back.",
      );
    } else if (cleared.error) {
      info.notes.push(
        `Could not remove the stale no-sandbox wrapper ` +
          `${noSandboxWrapperPath(cfg)} (${cleared.error}); the app starts ` +
          "either way, but delete that file to stop running unsandboxed.",
      );
    }
    info.verified = true;
    if (!probe.launches) {
      info.notes.push(
        `The sandbox is configured correctly (${
          helper.setuidRoot
            ? "chrome-sandbox is root-owned mode 4755"
            : "this host allows the namespace sandbox"
        }), but Obsidian did not stay up here: ` +
          `${firstOutputLine(probe.output) || "no output"}. That is not a ` +
          `sandbox failure — an ssh or headless session has no display, which ` +
          `is why the workflow probes with \`--version\`. Start Obsidian in ` +
          `your desktop session to see it run.`,
      );
    }
    return info;
  }

  const route = resolvedSandboxRoute(desired);
  info.route = route;
  info.state = "needs-elevation";
  info.fallbackCommand = sandboxFallbackCommand(route, cfg, helper);
  const why = sandboxCauseText(probe.cause, cfg);

  if (route === "report") {
    info.state = "manual";
    info.notes.push(
      `${why}. Nothing was changed (sandbox=report). Fix it with: ` +
        `\`${info.fallbackCommand}\`.`,
    );
    return info;
  }

  if (route === "apparmor") {
    // AppArmor cannot express a path with whitespace or non-ASCII characters,
    // so refuse that rather than write a profile the parser rejects.
    if (!/^[\x21-\x7e]+$/.test(joinPath(cfg.installDir, "obsidian"))) {
      info.state = "manual";
      info.fallbackCommand = sandboxFallbackCommand("setuid", cfg, helper);
      info.notes.push(
        `${cfg.installDir} contains whitespace or non-ASCII characters, which ` +
          "an AppArmor profile path cannot express; use the setuid route " +
          `instead: \`${info.fallbackCommand}\`.`,
      );
      return info;
    }
    const profilePath = apparmorProfileStagingPath(cfg);
    info.state = "manual";
    info.profilePath = profilePath;
    info.fallbackCommand = sandboxFallbackCommand(route, cfg, helper);
    const written = await deps.writeText(
      profilePath,
      apparmorProfileBody(joinPath(cfg.installDir, "obsidian")),
    );
    if (!written) {
      info.notes.push(
        `Could not write the AppArmor profile to ${profilePath}, so nothing ` +
          `was staged; ${why}.`,
      );
      return info;
    }
    info.notes.push(
      `${why}. The AppArmor profile is staged at ${profilePath}; load it ` +
        `once with \`${info.fallbackCommand}\` to let Obsidian use the ` +
        `namespace sandbox (no setuid binary, and upgrades never touch it).`,
    );
    return info;
  }

  // setuid: stage a copy the privileged step installs from, because
  // `install -m 4755` cannot read and write the same path.
  if (!helper.present) {
    info.state = "manual";
    info.notes.push(
      `The install at ${cfg.installDir} ships no ${SANDBOX_HELPER_NAME}, so ` +
        `there is nothing to make setuid; ${why}. Re-run ` +
        "`swamp workflow run @svendowideit/obsidian-app-upgrade` to unpack a " +
        "complete installer.",
    );
    return info;
  }
  const stage = sandboxStagePath(cfg);
  try {
    await deps.copy(helper.path, stage);
    await deps.chmod(stage, 0o755);
  } catch (error) {
    info.state = "manual";
    info.notes.push(
      `Could not stage ${helper.path} at ${stage} (${error}), so the ` +
        `privileged step cannot run; ${why}.`,
    );
    return info;
  }
  info.stagePath = stage;
  info.sudoRequired = true;
  info.sudoOperation = "installFile";
  info.sudoSrc = stage;
  info.sudoDest = helper.path;
  info.sudoMode = "4755";
  info.notes.push(
    `${why}. ${SANDBOX_HELPER_NAME} is staged at ${stage}; the workflow's ` +
      "next step installs it as root:root mode 4755 through " +
      "@svendowideit/sudo, then verifies the app starts. If this host grants " +
      `no elevation route at all, run \`${info.fallbackCommand}\` yourself.` +
      sandboxMountHint(probe.output, cfg),
  );
  return info;
}

/**
 * Re-probe the app after any change, clean up the staged helper, and report
 * what the app actually does now. Never changes anything privileged.
 */
export async function verifySandbox(
  deps: Deps,
  cfg: Config,
): Promise<SandboxInfo> {
  const desired = sandboxRoute(cfg.sandbox);
  const probe = await probeSandbox(deps, cfg);
  const helper = await sandboxHelperState(deps, cfg);
  const userns = await userNamespacesRestricted(deps);
  const info = blankSandbox(desired, probe, helper, userns, deps.now());
  const route = resolvedSandboxRoute(desired);
  const stage = sandboxStagePath(cfg);

  // The privileged step has copied the helper into place; do not leave the
  // staged copy sitting next to it.
  if (await deps.exists(stage)) {
    try {
      await deps.remove(stage);
    } catch {
      info.notes.push(
        `Could not remove the staged helper at ${stage}; delete it by hand.`,
      );
    }
  }

  if (probe.cause === "not-installed") {
    info.state = "not-installed";
    info.notes.push(`No Obsidian install at ${cfg.installDir}.`);
    return info;
  }

  if (probe.launches) {
    info.route = desired === "no-sandbox" ? "no-sandbox" : "none";
    info.state = desired === "no-sandbox" ? "unsandboxed" : "ok";
    info.verified = true;
    info.notes.push(
      desired === "no-sandbox"
        ? `Obsidian starts through ${noSandboxWrapperPath(cfg)} with ` +
          "`--no-sandbox` (renderer sandboxing off)."
        : helper.setuidRoot
        ? `Obsidian starts; ${helper.path} is root-owned mode 4755.`
        : `Obsidian starts; ${helper.path} is not setuid (this host allows ` +
          "the namespace sandbox).",
    );
    return info;
  }

  if (!sandboxBroken(probe, userns, helper)) {
    // The sandbox is right; the app did not stay up for some other reason (an
    // ssh or headless session has no display). Verify what can be verified and
    // say exactly that instead of blaming the sandbox.
    info.route = desired === "no-sandbox" ? "no-sandbox" : "none";
    info.state = desired === "no-sandbox" ? "unsandboxed" : "ok";
    info.verified = true;
    info.notes.push(
      `The sandbox is configured correctly (` +
        (helper.setuidRoot
          ? `${helper.path} is root-owned mode 4755`
          : "this host allows the namespace sandbox") +
        `), but Obsidian did not stay up here: ` +
        `${firstOutputLine(probe.output) || "no output"}. That is not a ` +
        "sandbox failure; a workflow run over ssh has no display. Start " +
        "Obsidian in your desktop session to see it run.",
    );
    return info;
  }

  info.route = route;
  info.state = route === "setuid" ? "needs-elevation" : "manual";
  info.fallbackCommand = sandboxFallbackCommand(route, cfg, helper);
  info.notes.push(
    `${sandboxCauseText(probe.cause, cfg)}. Fix it with: ` +
      `\`${info.fallbackCommand}\`.` + sandboxMountHint(probe.output, cfg),
  );
  if (probe.output) {
    info.notes.push(`The app said: ${firstOutputLine(probe.output)}`);
  }
  return info;
}

/** Detect the host's Obsidian state — reads only, never changes anything. */
export async function detectStatus(
  deps: Deps,
  cfg: Config,
): Promise<StatusInfo> {
  const pathEnv = deps.env("PATH") ?? "";
  const marker = await readMarker(deps, cfg.installDir);
  const binaryPath = joinPath(cfg.installDir, "obsidian");
  const cliSourcePath = joinPath(cfg.installDir, "obsidian-cli");
  const cliPath = joinPath(cfg.cliDir, CLI_NAME);
  const cliMode = await deps.fileMode(cliPath);
  const appConfig = parseAppConfig(
    await deps.readText(joinPath(cfg.appConfigDir, "obsidian.json")),
  );
  const appPackageVersion = latestAppPackageVersion(
    await deps.readDir(cfg.appConfigDir),
  );
  const running = (await deps.pids(CLI_NAME)).length > 0;
  const dpkg = await deps.run("dpkg-query", [
    "-W",
    "-f=${Version}",
    "obsidian",
  ]);
  const firstOnPathDir = await firstDirWithName(
    CLI_NAME,
    pathEnv,
    deps.exists,
  );
  const firstOnPathPath = firstOnPathDir
    ? joinPath(firstOnPathDir, CLI_NAME)
    : "";
  const helper = await sandboxHelperState(deps, cfg);

  const status: StatusInfo = {
    platform: deps.platform(),
    arch: deps.arch(),
    installMode: cfg.installMode,
    installDir: cfg.installDir,
    cliDir: cfg.cliDir,
    appConfigDir: cfg.appConfigDir,
    installed: await deps.exists(binaryPath),
    installedVersion: String(marker["version"] ?? ""),
    binaryPath,
    cliSourcePath,
    cliSourcePresent: await deps.exists(cliSourcePath),
    appPackageVersion,
    systemPackageVersion: dpkg.code === 0 ? dpkg.stdout.trim() : "",
    vaults: appConfig.vaults,
    appRunning: running,
    cliPath,
    cliRegistered: cliMode !== null,
    cliExecutable: cliMode !== null && (cliMode & 0o111) !== 0,
    cliDirOnPath: isDirOnPath(cfg.cliDir, pathEnv),
    cliFirstOnPathDir: firstOnPathDir,
    cliReachable: firstOnPathPath === cliPath,
    cliFlag: appConfig.cli,
    desktopEntryPresent: await deps.exists(desktopEntryPath(deps)),
    sandboxHelperPresent: helper.present,
    sandboxHelperMode: helper.mode,
    sandboxHelperOwnerUid: helper.ownerUid,
    sandboxHelperSetuidRoot: helper.setuidRoot,
    sandboxUsernsRestricted: await userNamespacesRestricted(deps),
    checkedAt: deps.now(),
    notes: [],
  };
  status.notes = statusNotes(status, cfg);
  return status;
}

/**
 * The attention-worthy facts about a {@link StatusInfo}, as copy-paste-ready
 * sentences. Each names the real path or command; none asks the user to fill in
 * a value the extension already knows.
 */
export function statusNotes(status: StatusInfo, cfg: Config): string[] {
  const notes: string[] = [];
  if (!status.installed) {
    notes.push(
      `No Obsidian install found at ${cfg.installDir} — run ` +
        `\`swamp workflow run @svendowideit/obsidian-app-upgrade\` to install it.`,
    );
  } else if (!status.cliSourcePresent) {
    notes.push(
      `The installer at ${cfg.installDir} predates the Obsidian CLI ` +
        `(needs ${MIN_CLI_INSTALLER}+); re-run ` +
        `\`swamp workflow run @svendowideit/obsidian-app-upgrade\` to replace it.`,
    );
  }
  if (status.systemPackageVersion) {
    notes.push(
      `A system package also installs Obsidian ` +
        `${status.systemPackageVersion} at /opt/Obsidian; retire it with ` +
        `\`sudo apt remove obsidian\` so the desktop launcher and PATH stop ` +
        `pointing at the old installer.`,
    );
  }
  if (status.cliRegistered && !status.cliReachable) {
    notes.push(
      status.cliFirstOnPathDir
        ? `\`obsidian\` resolves to ` +
          `${
            joinPath(status.cliFirstOnPathDir, CLI_NAME)
          } first, not the CLI ` +
          `at ${status.cliPath}; put ${status.cliDir} earlier in PATH.`
        : `${status.cliDir} is not on PATH; add it so \`obsidian\` resolves ` +
          `to ${status.cliPath}.`,
    );
  }
  if (status.cliFlag === false) {
    notes.push(
      `The app's cli setting is off in ` +
        `${
          joinPath(status.appConfigDir, "obsidian.json")
        }; run registerCli to ` +
        `turn it on.`,
    );
  }
  // The setuid helper is the only sandbox route a tarball install can use on a
  // host that denies user namespaces, so report it before someone tries to
  // launch the app and hits Chromium's FATAL.
  if (
    status.installed && status.sandboxUsernsRestricted &&
    !status.sandboxHelperSetuidRoot
  ) {
    notes.push(
      status.sandboxHelperPresent
        ? `${sandboxHelperPath(cfg)} is owned by uid ` +
          `${status.sandboxHelperOwnerUid} with mode ` +
          `0${(status.sandboxHelperMode & 0o7777).toString(8)}, but Chromium ` +
          `needs it ` +
          `root-owned mode 4755 and this host denies unprivileged user ` +
          `namespaces, so Obsidian cannot start yet. Run ` +
          `\`swamp workflow run @svendowideit/obsidian-app-upgrade\` to fix ` +
          `it (or pass \`sandbox=apparmor\` to stage an AppArmor profile ` +
          `instead).`
        : `The install at ${cfg.installDir} ships no ` +
          `${SANDBOX_HELPER_NAME}, and this host denies unprivileged user ` +
          `namespaces, so Obsidian cannot start; re-run ` +
          `\`swamp workflow run @svendowideit/obsidian-app-upgrade\`.`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** The installer result written by `install`. */
export interface InstallInfo {
  /** Install mode used. */
  mode: string;
  /** Wanted version. */
  version: string;
  /** Version recorded after the install. */
  installedVersion: string;
  /** Absolute path of the installed app binary. */
  binaryPath: string;
  /** Absolute path of the shipped `obsidian-cli`. */
  cliSourcePath: string;
  /** The archive that was unpacked, or "" when skipped. */
  archivePath: string;
  /** The archive's file name. */
  archiveName: string;
  /** SHA-256 the archive was verified against, or "". */
  checksum: string;
  /** Whether the bytes matched {@link checksum}. */
  checksumVerified: boolean;
  /** Whether the install was skipped because the version was present. */
  skipped: boolean;
  /** Whether the installed layout was verified after unpacking. */
  verified: boolean;
  /** Whether a user-local desktop entry was written. */
  desktopEntry: boolean;
  /**
   * Whether an existing `chrome-sandbox` was left alone rather than overwritten
   * with the archive's user-owned copy (see {@link installArchive}).
   */
  sandboxHelperKept: boolean;
  /** Whether the app was running while the install replaced its files. */
  appWasRunning: boolean;
  /** What happened, in one sentence. */
  message: string;
  /** When the install ran. */
  installedAt: string;
}

/** Everything `install` needs to unpack and verify one archive. */
export interface InstallRequest {
  /** Absolute path to the verified archive. */
  archivePath: string;
  /** The archive's file name. */
  archiveName: string;
  /** Wanted version. */
  version: string;
  /** Expected SHA-256, or "" when the release publishes none. */
  checksum: string;
  /** Reinstall even when the version is already present. */
  force: boolean;
}

/** Unpack the official installer, verify its layout, and record the version. */
export async function installArchive(
  deps: Deps,
  cfg: Config,
  req: InstallRequest,
): Promise<InstallInfo> {
  if (deps.platform() !== "linux") {
    throw new Error(
      `installMode=tar installs the Linux build; this host reports ` +
        `'${deps.platform()}'.`,
    );
  }
  if (!INSTALL_MODES.includes(cfg.installMode)) {
    throw new Error(
      `installMode '${cfg.installMode}' is not supported — this extension ` +
        `unpacks the official tar.gz installer rootlessly (installMode=tar).`,
    );
  }
  const archivePath = req.archivePath.trim();
  if (!archivePath) {
    throw new Error(
      "install needs the verified archive path — run " +
        "`swamp workflow run @svendowideit/obsidian-app-upgrade`, which " +
        "fetches and verifies the release first.",
    );
  }
  if (!(await deps.exists(archivePath))) {
    throw new Error(`Archive not found: ${archivePath}`);
  }
  const version = normaliseVersion(req.version || req.archiveName);
  if (!version) {
    throw new Error(
      "install needs the release version — pass the resolved release's " +
        "version, or run `swamp workflow run @svendowideit/obsidian-app-upgrade`.",
    );
  }

  const binaryPath = joinPath(cfg.installDir, "obsidian");
  const cliSourcePath = joinPath(cfg.installDir, "obsidian-cli");
  const markerPath = joinPath(cfg.installDir, MARKER_NAME);
  const prior = await readMarker(deps, cfg.installDir);
  const priorVersion = String(prior["version"] ?? "");
  const appWasRunning = (await deps.pids(CLI_NAME)).length > 0;

  const expected = req.checksum.trim().toLowerCase();
  let checksumVerified = false;
  if (expected) {
    const actual = (await deps.sha256File(archivePath)).toLowerCase();
    if (actual !== expected) {
      throw new Error(
        `Archive checksum mismatch for ${archivePath}: expected ${expected}, ` +
          `got ${actual}. Refusing to install an unverified archive.`,
      );
    }
    checksumVerified = true;
  }

  const upToDate = priorVersion !== "" &&
    versionsEqual(priorVersion, version) &&
    (await deps.exists(binaryPath));
  // A `chrome-sandbox` that is already in place — root-owned mode 4755 after a
  // privileged fix, or a plain copy before one — is left alone: extracting the
  // archive's user-owned copy over a root-owned setuid file fails outright, and
  // re-extracting it would force another privileged step on every upgrade.
  // Chromium's helper is version-independent.
  const helperPresent = await deps.exists(
    joinPath(cfg.installDir, SANDBOX_HELPER_NAME),
  );
  if (upToDate && !req.force) {
    return {
      mode: cfg.installMode,
      version,
      installedVersion: priorVersion,
      binaryPath,
      cliSourcePath,
      archivePath: "",
      archiveName: "",
      checksum: expected,
      checksumVerified,
      skipped: true,
      verified: await verifyLayout(deps, cfg),
      desktopEntry: cfg.desktopEntry
        ? await writeDesktopEntry(deps, cfg)
        : false,
      sandboxHelperKept: helperPresent,
      appWasRunning,
      message:
        `Obsidian ${priorVersion} is already installed at ${cfg.installDir}; ` +
        `nothing unpacked.`,
      installedAt: deps.now(),
    };
  }

  await deps.mkdirp(cfg.installDir);
  const unpack = await deps.run("tar", [
    "-xzf",
    archivePath,
    "-C",
    cfg.installDir,
    "--strip-components=1",
    ...(helperPresent ? [`--exclude=*/${SANDBOX_HELPER_NAME}`] : []),
  ]);
  if (unpack.code !== 0) {
    throw new Error(
      `Unpacking ${archivePath} into ${cfg.installDir} failed (exit ` +
        `${unpack.code}): ${unpack.stderr || unpack.stdout}`,
    );
  }
  const verified = await verifyLayout(deps, cfg);
  if (!verified) {
    const missing: string[] = [];
    if (!(await deps.exists(binaryPath))) missing.push("obsidian");
    if (!(await deps.exists(cliSourcePath))) missing.push("obsidian-cli");
    if (!(await deps.exists(joinPath(cfg.installDir, "resources/app.asar")))) {
      missing.push("resources/app.asar");
    }
    throw new Error(
      `The archive unpacked but the install is incomplete at ` +
        `${cfg.installDir} (missing: ${missing.join(", ")}). The archive may ` +
        `be corrupt — re-run ` +
        `\`swamp workflow run @svendowideit/obsidian-app-upgrade\`.`,
    );
  }
  // The tar preserves modes, but a hand-copied archive may not.
  await deps.chmod(binaryPath, 0o755);
  await deps.chmod(cliSourcePath, 0o755);
  const desktopEntry = cfg.desktopEntry
    ? await writeDesktopEntry(deps, cfg)
    : false;
  const markerWritten = await deps.writeText(
    markerPath,
    `${
      JSON.stringify(
        {
          version,
          archiveName: req.archiveName,
          checksum: expected,
          mode: cfg.installMode,
          installedAt: deps.now(),
        },
        null,
        2,
      )
    }\n`,
  );
  if (!markerWritten) {
    throw new Error(
      `Unpacked Obsidian ${version} into ${cfg.installDir} but could not ` +
        `record the version at ${markerPath}; a later run will unpack again. ` +
        `Fix the directory's permissions and re-run ` +
        `\`swamp workflow run @svendowideit/obsidian-app-upgrade\`.`,
    );
  }
  return {
    mode: cfg.installMode,
    version,
    installedVersion: version,
    binaryPath,
    cliSourcePath,
    archivePath,
    archiveName: req.archiveName,
    checksum: expected,
    checksumVerified,
    skipped: false,
    verified,
    desktopEntry,
    sandboxHelperKept: helperPresent,
    appWasRunning,
    message: appWasRunning
      ? `Installed Obsidian ${version} at ${cfg.installDir}; the app is ` +
        `running, so quit and reopen it to load the new installer.`
      : `Installed Obsidian ${version} at ${cfg.installDir}.` +
        (helperPresent
          ? ` Kept the existing ${SANDBOX_HELPER_NAME} (Chromium's helper is ` +
            `version-independent).`
          : ""),
    installedAt: deps.now(),
  };
}

/** Whether the installed layout has the binary, CLI and app package it needs. */
export async function verifyLayout(
  deps: Deps,
  cfg: Config,
): Promise<boolean> {
  const binary = await deps.exists(joinPath(cfg.installDir, "obsidian"));
  const cli = await deps.exists(joinPath(cfg.installDir, "obsidian-cli"));
  const asar = await deps.exists(
    joinPath(cfg.installDir, "resources/app.asar"),
  );
  return binary && cli && asar;
}

/** Write the user-local desktop entry, returning whether it now exists. */
export async function writeDesktopEntry(
  deps: Deps,
  cfg: Config,
  execPath?: string,
): Promise<boolean> {
  const path = desktopEntryPath(deps);
  const dir = path.replace(/\/[^/]+$/, "");
  await deps.mkdirp(dir);
  const body = desktopEntryBody(cfg.installDir, execPath);
  if ((await deps.readText(path)) !== body) {
    await deps.writeText(path, body);
  }
  return await deps.exists(path);
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

/** The CLI registration result written by `registerCli`. */
export interface CliInfo {
  /** Registered CLI path. */
  path: string;
  /** The `obsidian-cli` binary it was copied from. */
  sourcePath: string;
  /** Whether the CLI file exists after the run. */
  registered: boolean;
  /** Whether the file was (re)written by this run. */
  changed: boolean;
  /** Whether the copy's bytes already matched the shipped binary. */
  upToDate: boolean;
  /** Whether the CLI directory is on `PATH`. */
  onPath: boolean;
  /** The directory that resolves `obsidian` first, or "". */
  firstOnPathDir: string;
  /** Whether `obsidian` resolves to this registered CLI. */
  reachable: boolean;
  /** The app's `cli` setting after the run: true/false, or null when unset. */
  flag: boolean | null;
  /** Whether this run turned the flag on. */
  flagChanged: boolean;
  /** Backup taken before rewriting `obsidian.json`, or "". */
  backupPath: string;
  /** Whether the app was running (which blocks persisting the setting). */
  appRunning: boolean;
  /** Whether `obsidian version` was actually run and answered. */
  verified: boolean;
  /** The CLI's reported version output, or "". */
  reportedVersion: string;
  /** The installer version the CLI reported, or "". */
  installerVersion: string;
  /** What happened, in one sentence, including anything left to the user. */
  note: string;
  /** When this ran. */
  checkedAt: string;
}

/** Options for {@link registerCli}. */
export interface RegisterOptions {
  /** Explicit `obsidian-cli` binary to copy; empty finds it in the install. */
  sourcePath: string;
  /** Re-copy and re-verify even when already up to date. */
  force: boolean;
}

/**
 * Turn the app's `cli` setting on, backing the file up first.
 *
 * Returns the flag value as verified by re-reading the file, plus the backup
 * path. Nothing is written when the app is running: the app rewrites
 * `obsidian.json` on exit and would drop the change, so the caller reports the
 * wait instead of claiming success.
 */
async function enableCliFlag(
  deps: Deps,
  cfg: Config,
  appRunning: boolean,
): Promise<{
  flag: boolean | null;
  changed: boolean;
  backupPath: string;
  note: string;
}> {
  const path = joinPath(cfg.appConfigDir, "obsidian.json");
  const text = await deps.readText(path);
  const flag = parseAppConfig(text).cli;
  if (flag === true) return { flag, changed: false, backupPath: "", note: "" };
  if (appRunning) {
    return {
      flag,
      changed: false,
      backupPath: "",
      note:
        "Obsidian is running, so the app's cli setting was left alone; quit " +
        "Obsidian and re-run registerCli to persist it.",
    };
  }
  const edit = withCliEnabled(text);
  let backupPath = "";
  if (text.trim() && !edit.changed) {
    // Unparseable body: preserve the original bytes, do not guess.
    return {
      flag,
      changed: false,
      backupPath: "",
      note: `${path} is not valid JSON, so the cli setting was not touched; ` +
        `turn it on in Obsidian under Settings → General.`,
    };
  }
  if (text.trim()) {
    backupPath = `${path}.pre-cli-${deps.now().replace(/[:.]/g, "-")}`;
    if (!(await deps.writeText(backupPath, text))) {
      return {
        flag,
        changed: false,
        backupPath: "",
        note:
          `Could not back up ${path} to ${backupPath}, so the cli setting was ` +
          `left alone; turn it on in Obsidian under Settings → General.`,
      };
    }
  }
  const body = text.trim() ? edit.text : '{\n  "cli": true\n}\n';
  await deps.mkdirp(cfg.appConfigDir);
  const wrote = await deps.writeText(path, body);
  if (!wrote) {
    return {
      flag,
      changed: false,
      backupPath,
      note:
        `Could not write ${path}; turn the cli setting on in Obsidian under ` +
        `Settings → General.`,
    };
  }
  // Report the flag as it is on disk now, not as intended.
  const after = parseAppConfig(await deps.readText(path)).cli;
  return { flag: after, changed: after === true, backupPath, note: "" };
}

/** Register the Obsidian CLI on this host, the way Obsidian's own prompt does. */
export async function registerCli(
  deps: Deps,
  cfg: Config,
  opts: RegisterOptions,
): Promise<CliInfo> {
  const pathEnv = deps.env("PATH") ?? "";
  const explicit = opts.sourcePath.trim();
  const candidates = explicit ? [explicit] : [
    joinPath(cfg.installDir, "obsidian-cli"),
    "/opt/Obsidian/obsidian-cli",
  ];
  let sourcePath = "";
  for (const candidate of candidates) {
    if (await deps.exists(candidate)) {
      sourcePath = candidate;
      break;
    }
  }
  if (!sourcePath) {
    throw new Error(
      `No obsidian-cli binary found (looked in ${candidates.join(", ")}). ` +
        `The Obsidian CLI ships with the ${MIN_CLI_INSTALLER}+ installer — run ` +
        `\`swamp workflow run @svendowideit/obsidian-app-upgrade\`.`,
    );
  }

  const destPath = joinPath(cfg.cliDir, CLI_NAME);
  await deps.mkdirp(cfg.cliDir);
  const sourceSum = await deps.sha256File(sourcePath);
  const destSum = (await deps.exists(destPath))
    ? await deps.sha256File(destPath)
    : "";
  const upToDate = destSum !== "" && destSum === sourceSum;
  let changed = false;
  if (!upToDate || opts.force) {
    await deps.copy(sourcePath, destPath);
    changed = true;
  }
  await deps.chmod(destPath, 0o755);
  const registered = await deps.exists(destPath);

  const appRunning = (await deps.pids(CLI_NAME)).length > 0;
  const notes: string[] = [];
  const flagResult = cfg.enableCli
    ? await enableCliFlag(deps, cfg, appRunning)
    : {
      flag: parseAppConfig(
        await deps.readText(joinPath(cfg.appConfigDir, "obsidian.json")),
      ).cli,
      changed: false,
      backupPath: "",
      note: "",
    };
  if (flagResult.note) notes.push(flagResult.note);

  // Resolve `obsidian` the way a shell would, so a stale system package that
  // shadows the CLI is reported rather than silently used.
  const firstOnPathDir = await firstDirWithName(CLI_NAME, pathEnv, deps.exists);
  const reachable = firstOnPathDir !== "" &&
    stripTrailingSlash(firstOnPathDir) === stripTrailingSlash(cfg.cliDir);
  const onPath = isDirOnPath(cfg.cliDir, pathEnv);
  if (!onPath) {
    notes.push(
      `Add ${cfg.cliDir} to PATH (for example ` +
        `\`export PATH="$PATH:${cfg.cliDir}"\` in ~/.bashrc) so \`obsidian\` ` +
        `resolves to the CLI.`,
    );
  } else if (!reachable) {
    notes.push(
      `\`obsidian\` currently resolves to ` +
        `${joinPath(firstOnPathDir, CLI_NAME)}; put ${cfg.cliDir} earlier in ` +
        `PATH so the CLI is the command that runs.`,
    );
  }

  // Only run the CLI when the app is up: with no app running, the first CLI
  // command launches the desktop app, which is not something a setup run
  // should do behind the user's back.
  let verified = false;
  let reportedVersion = "";
  let installerVersion = "";
  if (appRunning) {
    const out = await deps.run(destPath, ["version"]);
    reportedVersion = out.stdout || out.stderr;
    if (out.code === 0 && out.stdout) {
      const parsed = parseCliVersionOutput(out.stdout);
      verified = parsed.appVersion !== "" || parsed.installerVersion !== "";
      installerVersion = parsed.installerVersion;
      if (!verified) {
        notes.push(
          `\`obsidian version\` answered with "${out.stdout}", which does not ` +
            `look like the official CLI (the legacy third-party obsidian-cli ` +
            `prints only its own version).`,
        );
      }
    } else {
      notes.push(
        `\`${destPath} version\` failed (exit ${out.code}): ` +
          `${out.stderr || out.stdout || "no output"}.`,
      );
    }
  } else {
    notes.push(
      "Obsidian is not running, so the CLI was registered but not executed; " +
        "start Obsidian, then run `obsidian version` to confirm it answers.",
    );
  }

  const changedText = changed
    ? `registered ${destPath} from ${sourcePath}`
    : `${destPath} already matched ${sourcePath}`;
  return {
    path: destPath,
    sourcePath,
    registered,
    changed,
    upToDate,
    onPath,
    firstOnPathDir,
    reachable,
    flag: flagResult.flag,
    flagChanged: flagResult.changed,
    backupPath: flagResult.backupPath,
    appRunning,
    verified,
    reportedVersion,
    installerVersion,
    note: notes.length
      ? `${changedText}. ${notes.join(" ")}`
      : `${changedText}.`,
    checkedAt: deps.now(),
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** The final summary written by `print`. */
export interface SummaryInfo {
  /** Whether the install, CLI and launchable sandbox are all in place. */
  ok: boolean;
  /** The lines to log, in order. */
  lines: string[];
  /** Installed installer version, or "". */
  installedVersion: string;
  /** The app binary path, or "". */
  binaryPath: string;
  /** The registered CLI path, or "". */
  cliPath: string;
  /** The app package version on disk, or "". */
  appPackageVersion: string;
  /** Whether the CLI answered when it was checked. */
  cliVerified: boolean;
  /** Whether the app is running. */
  appRunning: boolean;
  /** Whether the sandbox lets the app start (false when it was proved not to). */
  sandboxOk: boolean;
  /** Why the app cannot start, or "" when it can. */
  sandboxCause: string;
  /** Anything that still needs a person. */
  notes: string[];
  /** When the summary was taken. */
  checkedAt: string;
}

/**
 * Build the end-of-run summary from the latest resources and a fresh host
 * snapshot. Everything reported here is read back from the host, not echoed
 * from the inputs.
 */
export function buildSummary(
  status: StatusInfo,
  install: Partial<InstallInfo>,
  cli: Partial<CliInfo>,
  now: string,
  sandbox: Partial<SandboxInfo> = {},
): SummaryInfo {
  const installedVersion = String(
    install.installedVersion || status.installedVersion,
  );
  const binaryPath = String(install.binaryPath || status.binaryPath);
  const cliPath = String(cli.path || status.cliPath);
  const cliVerified = cli.verified === true;
  // `verified: false` is a proved failure, not a guess; no verdict at all (the
  // check never ran) leaves the verdict alone.
  const sandboxOk = sandbox.verified !== false;
  const sandboxLaunched = sandbox.launches === true;
  const sandboxCause = String(sandbox.cause ?? "");
  const ok = status.installed && installedVersion !== "" &&
    status.cliRegistered && status.cliSourcePresent && sandboxOk;
  const lines: string[] = [];
  lines.push(
    ok
      ? `Obsidian ${installedVersion} — installer at ${binaryPath}`
      : `Obsidian is not fully installed (install dir ${status.installDir})`,
  );
  if (status.appPackageVersion) {
    lines.push(
      `App package on disk: ${status.appPackageVersion} (Obsidian auto-updates ` +
        `the app itself; the installer is ${installedVersion})`,
    );
  }
  lines.push(
    status.cliRegistered
      ? `Obsidian CLI: ${cliPath}` +
        (cliVerified ? ` (answers: ${cli.reportedVersion})` : " (not executed)")
      : `Obsidian CLI: not registered at ${cliPath}`,
  );
  lines.push(
    status.cliReachable
      ? `\`obsidian\` resolves to ${cliPath}`
      : `\`obsidian\` does not resolve to ${cliPath} yet`,
  );
  lines.push(
    status.appRunning ? "Obsidian is running." : "Obsidian is not running.",
  );
  const sandboxVerified = "launches" in sandbox;
  const sandboxLabel = String(sandbox.route ?? "") === "no-sandbox"
    ? "DISABLED by request, `--no-sandbox`"
    : status.sandboxHelperSetuidRoot
    ? "setuid helper, chrome-sandbox root:root 4755"
    : "unprivileged user namespaces";
  lines.push(
    !status.installed
      ? "Obsidian cannot start: nothing is installed."
      : !sandboxVerified
      ? `Sandbox not checked yet — run \`swamp model ` +
        `@svendowideit/obsidian-app method run sandbox obsidian-app\` to test ` +
        `that it can start.`
      : !sandboxOk
      ? `Obsidian cannot start: ${sandboxCauseText(sandboxCause, status)}.`
      : sandboxLaunched
      ? `Obsidian starts (sandbox: ${sandboxLabel})`
      : `Sandbox correct (${sandboxLabel}), but the app did not stay up in ` +
        `this session: ${firstOutputLine(String(sandbox.probeOutput ?? ""))}`,
  );
  if (status.vaults.length) {
    lines.push(`Vaults: ${status.vaults.join(", ")}`);
  }
  const notes = [...status.notes];
  const runningInstaller = String(cli.installerVersion ?? "");
  if (
    runningInstaller && installedVersion &&
    !versionsEqual(runningInstaller, installedVersion)
  ) {
    notes.push(
      `The running Obsidian answered as installer ${runningInstaller}; quit ` +
        `and reopen it to load the ${installedVersion} installer that is now ` +
        `on disk.`,
    );
  }
  for (const note of String(cli.note ?? "").split(/(?<=\.)\s+/)) {
    const trimmed = note.trim();
    if (trimmed && !notes.includes(trimmed)) notes.push(trimmed);
  }
  for (const note of (sandbox.notes ?? []) as string[]) {
    const trimmed = note.trim();
    if (trimmed && !notes.includes(trimmed)) notes.push(trimmed);
  }
  return {
    ok,
    lines,
    installedVersion,
    binaryPath,
    cliPath,
    appPackageVersion: status.appPackageVersion,
    cliVerified,
    appRunning: status.appRunning,
    sandboxOk,
    sandboxCause,
    notes,
    checkedAt: now,
  };
}
