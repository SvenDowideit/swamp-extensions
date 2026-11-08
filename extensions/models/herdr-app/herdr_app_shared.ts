/**
 * Pure helpers for `@svendowideit/herdr-app`: release-manifest parsing, platform
 * selection, install layout, version comparison, the POSIX installer script
 * used over ssh, and the small PowerShell snippets Windows needs.
 *
 * Everything here is free of IO so it can be unit tested without a network, a
 * macOS app bundle, or a Windows registry. The model in `herdr_app.ts` supplies
 * the IO.
 *
 * @module
 */

/** The model type name. */
export const HERDR_APP_TYPE = "@svendowideit/herdr-app";

/** The vendor's release host. */
export const DEFAULT_RELEASES_URL = "https://releases.herdr.dev";

/** The `releases.herdr.dev` team identifier, used to verify the macOS core. */
export const HERDR_TEAM_ID = "2W9652Q7QR";

/** A platform the herdr app is published for. */
export type Target =
  | "linux-x86_64"
  | "linux-aarch64"
  | "macos-aarch64"
  | "windows-x86_64";

/** The host OS families the install knows how to place files on. */
export type HostOs = "linux" | "macos" | "windows";

/** Every supported target, in documentation order. */
export const TARGETS: Target[] = [
  "linux-x86_64",
  "linux-aarch64",
  "macos-aarch64",
  "windows-x86_64",
];

/** One downloadable archive in a release manifest. */
export interface ReleaseAsset {
  /** Absolute download URL. */
  url: string;
  /** Lowercase hex SHA-256 of the archive bytes. */
  sha256: string;
}

/** The subset of `<releases>/app/latest.json` this extension uses. */
export interface ReleaseManifest {
  /** Release version, e.g. `0.1.14`. */
  version: string;
  /** Oldest herdr-core this app works with, or "". */
  coreMin: string;
  /** Release notes line, or "". */
  notes: string;
  /** One asset per supported target. */
  targets: Record<string, ReleaseAsset>;
}

/** A resolved host platform. */
export interface Platform {
  /** Host family. */
  os: HostOs;
  /** Normalised architecture (`x86_64` or `aarch64`). */
  arch: string;
  /** Release target id, e.g. `linux-x86_64`. */
  target: Target;
}

/** Options for {@link targetFor}. */
export interface TargetOptions {
  /** True when an x86_64 process is really running on Apple silicon. */
  rosetta?: boolean;
}

/**
 * Normalise an architecture name (`amd64`/`x86_64`, `arm64`/`aarch64`).
 * Returns "" for anything the vendor does not publish.
 */
export function normalizeArch(arch: string): "x86_64" | "aarch64" | "" {
  const a = arch.trim().toLowerCase();
  if (a === "x86_64" || a === "amd64" || a === "x64") return "x86_64";
  if (a === "aarch64" || a === "arm64") return "aarch64";
  return "";
}

/** Map a `uname -s` string (or a Deno OS name) to a host family, or "". */
export function osFamily(name: string): HostOs | "" {
  const s = name.trim().toLowerCase();
  if (s === "linux") return "linux";
  if (s === "darwin" || s === "macos") return "macos";
  if (
    s === "windows" || s.startsWith("mingw") || s.startsWith("msys") ||
    s.startsWith("cygwin")
  ) return "windows";
  return "";
}

/**
 * Pick the release target for a host.
 *
 * Intel Macs are refused by name: the vendor publishes no `macos-x86_64` app
 * build, and silently installing the arm64 build would fail at launch.
 *
 * @param os Host family.
 * @param arch Reported architecture.
 * @param opts Rosetta detection (macOS only).
 */
export function targetFor(
  os: HostOs,
  arch: string,
  opts: TargetOptions = {},
): Platform {
  const normalised = normalizeArch(arch);
  if (!normalised) {
    throw new Error(
      `herdr-app has no build for ${arch || "this architecture"}; it ships ` +
        `for ${TARGETS.join(", ")}`,
    );
  }
  if (os === "windows" && normalised === "aarch64") {
    throw new Error(
      "herdr-app has no Windows arm64 build yet; it ships windows-x86_64",
    );
  }
  if (os === "macos") {
    const arm = normalised === "aarch64" || opts.rosetta === true;
    if (!arm) {
      throw new Error(
        "herdr-app has no Intel Mac build; only macos-aarch64 is published " +
          "(build from source: https://github.com/herdrdev/herdr-app)",
      );
    }
    return { os, arch: "aarch64", target: "macos-aarch64" };
  }
  const target = `${os}-${normalised}` as Target;
  if (!TARGETS.includes(target)) {
    throw new Error(`herdr-app has no build for ${target}`);
  }
  return { os, arch: normalised, target };
}

/** Strip a leading `v` and surrounding whitespace from a version string. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, "");
}

/**
 * Compare two dotted versions. Returns <0, 0 or >0 like a sort comparator.
 * Non-numeric suffixes (`0.1.14-rc1`) compare below the bare version.
 */
export function compareVersions(left: string, right: string): number {
  const split = (v: string): { parts: number[]; suffix: string } => {
    const clean = normalizeVersion(v);
    const [core, ...rest] = clean.split("-");
    const parts = core.split(".").map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    return { parts, suffix: rest.join("-") };
  };
  const a = split(left);
  const b = split(right);
  const len = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i++) {
    const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (a.suffix === b.suffix) return 0;
  if (!a.suffix) return 1;
  if (!b.suffix) return -1;
  return a.suffix < b.suffix ? -1 : 1;
}

/** True when two versions name the same release. */
export function versionsEqual(left: string, right: string): boolean {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) return false;
  return compareVersions(a, b) === 0;
}

/**
 * The manifest URL for one product. A pinned version uses the per-release
 * `manifest.json` (the vendor keeps one for every release); `latest.json`
 * tracks the newest.
 */
export function manifestUrl(
  base: string,
  kind: "app" | "core",
  version = "",
): string {
  const root = base.trim().replace(/\/+$/, "");
  const v = normalizeVersion(version);
  return v
    ? `${root}/${kind}/${v}/manifest.json`
    : `${root}/${kind}/latest.json`;
}

/**
 * Validate a release manifest. The vendor's manifests are flat JSON; this
 * checks the fields the installer relies on and normalises the checksums.
 */
export function parseManifest(body: unknown, source: string): ReleaseManifest {
  if (!body || typeof body !== "object") {
    throw new Error(`${source} is not a release manifest`);
  }
  const raw = body as Record<string, unknown>;
  const version = typeof raw.version === "string"
    ? normalizeVersion(raw.version)
    : "";
  if (!version) {
    throw new Error(`${source} has no version`);
  }
  const targetsRaw = raw.targets;
  if (!targetsRaw || typeof targetsRaw !== "object") {
    throw new Error(`${source} lists no targets`);
  }
  const targets: Record<string, ReleaseAsset> = {};
  for (const [name, value] of Object.entries(targetsRaw)) {
    const entry = value as Record<string, unknown> | null;
    const url = typeof entry?.url === "string" ? entry.url : "";
    const sha256 = typeof entry?.sha256 === "string"
      ? entry.sha256.toLowerCase()
      : "";
    if (!url || !/^[0-9a-f]{64}$/.test(sha256)) continue;
    targets[name] = { url, sha256 };
  }
  return {
    version,
    coreMin: typeof raw.core_min === "string"
      ? normalizeVersion(raw.core_min)
      : "",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    targets,
  };
}

/**
 * Select this host's asset from a manifest, with a message that lists what the
 * release does publish when the target is missing.
 */
export function pickAsset(
  manifest: ReleaseManifest,
  target: string,
  label: string,
): ReleaseAsset {
  const asset = manifest.targets[target];
  if (!asset) {
    const available = Object.keys(manifest.targets).sort().join(", ") ||
      "nothing";
    throw new Error(
      `${label} ${manifest.version} has no build for ${target} ` +
        `(published: ${available})`,
    );
  }
  return asset;
}

/**
 * Mark a plain release-server URL with what the download is for, so the
 * vendor's counter can tell an install from a reinstall or an update. URLs
 * with a query or fragment (a mirror's signed URL) are returned untouched.
 */
export function withSource(url: string, base: string, src: string): string {
  if (/[?#]/.test(url)) return url;
  const root = base.trim().replace(/\/+$/, "");
  return url.startsWith(`${root}/`) ? `${url}?src=${src}` : url;
}

/** Directories and environment values the layout is derived from. */
export interface LayoutInputs {
  /** `$HOME` (or `%USERPROFILE%`). */
  home: string;
  /** `%LOCALAPPDATA%`, or "". */
  localAppData?: string;
  /** `$XDG_DATA_HOME`, or "". */
  xdgData?: string;
  /** `$XDG_CACHE_HOME`, or "". */
  xdgCache?: string;
}

/** Where every installed piece of Herdr lives on a host. */
export interface Layout {
  /** Host family the layout is for. */
  os: HostOs;
  /** The app: a directory on Linux, the .app bundle on macOS, a directory on Windows. */
  appDir: string;
  /** The app's executable. */
  appBinary: string;
  /** Directory holding the `herdr-app` command (and `hc` on Unix). */
  binDir: string;
  /** Symlink that puts `herdr-app` on PATH (Unix only; "" on Windows). */
  linkPath: string;
  /** Linux desktop entry, or "". */
  desktopFile: string;
  /** Linux launcher icon, or "". */
  iconFile: string;
  /** Where herdr-core lives. */
  coreDir: string;
  /** The herdr-core executable. */
  corePath: string;
  /** The `hc` alias beside herdr-core. */
  hcPath: string;
  /** Where archives are staged when no `downloadDir` is given. */
  cacheDir: string;
}

/** Overrides for {@link layoutFor}; empty strings mean "platform default". */
export interface LayoutOverrides {
  /** Replace the app location. */
  appDir?: string;
  /** Replace the bin/link location (Unix) or the core location's parent. */
  binDir?: string;
}

/**
 * Derive the install layout for a host. Paths follow the vendor's installers:
 * Linux `$XDG_DATA_HOME/herdr-app` + `~/.local/bin`; macOS
 * `~/Applications/Herdr.app` + `~/.local/bin`; Windows
 * `%LOCALAPPDATA%\Programs\herdr-app` (on PATH) and
 * `%LOCALAPPDATA%\Programs\herdr-core`.
 */
export function layoutFor(
  os: HostOs,
  inputs: LayoutInputs,
  overrides: LayoutOverrides = {},
): Layout {
  const home = inputs.home.replace(/\/+$/, "") || inputs.home;
  const xdgData = inputs.xdgData?.trim()
    ? inputs.xdgData.trim().replace(/\/+$/, "")
    : `${home}/.local/share`;
  const xdgCache = inputs.xdgCache?.trim()
    ? inputs.xdgCache.trim().replace(/\/+$/, "")
    : os === "macos"
    ? `${home}/Library/Caches`
    : os === "windows"
    ? `${inputs.localAppData || `${home}/AppData/Local`}/Cache`
    : `${home}/.cache`;
  const cacheDir = `${xdgCache}/herdr-app`;
  const appOverride = (overrides.appDir ?? "").trim();
  const binOverride = (overrides.binDir ?? "").trim();

  if (os === "windows") {
    const localAppData = inputs.localAppData?.trim()
      ? inputs.localAppData.trim().replace(/[\\/]+$/, "")
      : `${home}\\AppData\\Local`;
    const appDir = appOverride || `${localAppData}\\Programs\\herdr-app`;
    const programs = `${localAppData}\\Programs`;
    const coreDir = `${programs}\\herdr-core`;
    return {
      os,
      appDir,
      appBinary: `${appDir}\\herdr-app.exe`,
      binDir: binOverride || appDir,
      linkPath: "",
      desktopFile: "",
      iconFile: "",
      coreDir,
      corePath: `${coreDir}\\herdr-core.exe`,
      hcPath: `${coreDir}\\hc.exe`,
      cacheDir,
    };
  }

  const binDir = binOverride || `${home}/.local/bin`;
  if (os === "macos") {
    const appDir = appOverride || `${home}/Applications/Herdr.app`;
    return {
      os,
      appDir,
      appBinary: `${appDir}/Contents/MacOS/Herdr`,
      binDir,
      linkPath: `${binDir}/herdr-app`,
      desktopFile: "",
      iconFile: "",
      coreDir: binDir,
      corePath: `${binDir}/herdr-core`,
      hcPath: `${binDir}/hc`,
      cacheDir,
    };
  }
  const appDir = appOverride || `${xdgData}/herdr-app`;
  // A launcher entry belongs to the machine's data dir. When the caller moves
  // the app elsewhere, leave the machine's launcher alone rather than pointing
  // it at a directory that is not the one it describes.
  const launcher = appOverride === "";
  return {
    os,
    appDir,
    appBinary: `${appDir}/herdr-app`,
    binDir,
    linkPath: `${binDir}/herdr-app`,
    desktopFile: launcher ? `${xdgData}/applications/herdr-app.desktop` : "",
    iconFile: launcher
      ? `${xdgData}/icons/hicolor/scalable/apps/herdr-app.svg`
      : "",
    coreDir: binDir,
    corePath: `${binDir}/herdr-core`,
    hcPath: `${binDir}/hc`,
    cacheDir,
  };
}

/**
 * Parse `herdr-app --version` into a version. The same binary is `herdr-app`
 * on Linux and Windows and `Herdr` inside the macOS bundle, so both names are
 * accepted.
 */
export function parseAppVersion(output: string): string {
  const m = output.match(/^\s*(?:herdr-app|Herdr)\s+v?(\S+)/m);
  return m ? normalizeVersion(m[1]) : "";
}

/** Parse `herdr-core --version` / `hc --version` into a version. */
export function parseCoreVersion(output: string): string {
  const m = output.match(/^\s*(?:hc|herdr-core)\s+v?(\S+)/m);
  return m ? normalizeVersion(m[1]) : "";
}

/** What the install will do, given what is on the machine. */
export type InstallAction =
  | "installed"
  | "updated"
  | "downgraded"
  | "reinstalled"
  | "unchanged";

/**
 * Decide what installing `target` over `installed` means. An unreadable
 * installed version (files present, probe failed) counts as a reinstall so a
 * damaged copy is repaired.
 */
export function installAction(
  installed: string,
  target: string,
  force = false,
  present = false,
): InstallAction {
  const have = normalizeVersion(installed);
  if (!have) return present ? "reinstalled" : "installed";
  const order = compareVersions(have, target);
  if (order === 0) return force ? "reinstalled" : "unchanged";
  return order < 0 ? "updated" : "downgraded";
}

/** The Linux desktop entry the vendor's installer writes. */
export function desktopEntry(execPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Herdr",
    "Comment=Terminals and coding agents that keep running",
    `Exec=${execPath}`,
    "Icon=herdr-app",
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=herdr-app",
    "",
  ].join("\n");
}

/**
 * Quote a string for a single-quoted PowerShell literal. `'` is doubled; every
 * other character is literal in PowerShell single quotes.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** PowerShell that adds one directory to the current user's PATH, once. */
export function windowsPathScript(dir: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$dir = ${psQuote(dir)}`,
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)',
    '$raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '$listed = $raw -split ";" | Where-Object { $_.Trim().TrimEnd("\\") -ieq $dir.TrimEnd("\\") }',
    "if (-not $listed) {",
    '  if ($key.GetValueNames() -contains "Path") { $kind = $key.GetValueKind("Path") } else { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }',
    '  if ($raw) { $key.SetValue("Path", $raw.TrimEnd(";") + ";" + $dir, $kind) } else { $key.SetValue("Path", $dir, $kind) }',
    '  [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", "1", "User")',
    '  [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", $null, "User")',
    '  Write-Output "added $dir to the user PATH"',
    "}",
    "$key.Close()",
  ].join("\n");
}

/** PowerShell that removes one directory from the current user's PATH. */
export function windowsPathRemoveScript(dir: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$dir = ${psQuote(dir)}`,
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)',
    '$raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '$keep = @($raw -split ";" | Where-Object { $_.Trim() -and ($_.Trim().TrimEnd("\\") -ine $dir.TrimEnd("\\")) })',
    'if ($key.GetValueNames() -contains "Path") {',
    '  $kind = $key.GetValueKind("Path")',
    '  $key.SetValue("Path", ($keep -join ";"), $kind)',
    '  [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", "1", "User")',
    '  [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", $null, "User")',
    "}",
    "$key.Close()",
  ].join("\n");
}

/**
 * PowerShell that (re)creates the Start menu shortcut for the app, so Herdr
 * appears in the Start menu exactly like the vendor's installer leaves it.
 */
export function windowsShortcutScript(
  exePath: string,
  workingDirectory: string,
): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Herdr.lnk"',
    "$link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)",
    `$link.TargetPath = ${psQuote(exePath)}`,
    `$link.WorkingDirectory = ${psQuote(workingDirectory)}`,
    '$link.Description = "Terminals and coding agents that keep running"',
    "$link.Save()",
  ].join("\n");
}

/** PowerShell that removes the Start menu shortcut, if there is one. */
export function windowsShortcutRemoveScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Herdr.lnk"',
    "Remove-Item -Force $menu -ErrorAction SilentlyContinue",
  ].join("\n");
}

/** Encode a script for `powershell.exe -EncodedCommand` (UTF-16LE base64). */
export function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** One host platform's pinned archives, for the SSH installer. */
export interface InstallPin {
  /** Release target id, e.g. `linux-x86_64`. */
  target: string;
  /** Verified app archive URL (already carries the vendor's `?src=` marker). */
  appUrl: string;
  /** Lowercase hex SHA-256 of the app archive. */
  appSha256: string;
  /** Verified core archive URL, or "" when this target has no core build. */
  coreUrl: string;
  /** Lowercase hex SHA-256 of the core archive, or "". */
  coreSha256: string;
}

/** The release pins a rendered installer carries. */
export interface RenderedInstall {
  /** App version every host installs. */
  appVersion: string;
  /** Core version every host installs, or "". */
  coreVersion: string;
  /** One pin set per supported host platform. */
  pins: InstallPin[];
  /** Reinstall even when the version matches. */
  force: boolean;
  /** `auto` installs only a missing core, `always` updates it too. */
  coreMode: "auto" | "always" | "never";
  /** Verify the macOS core app's release signature (vendor URLs only). */
  verifyCoreSignature: boolean;
}

/** The targets the POSIX SSH installer can serve. */
export const POSIX_TARGETS = [
  "linux-x86_64",
  "linux-aarch64",
  "macos-aarch64",
] as const;

/** One `case` branch, so a mixed fleet gets the right build per host. */
function pinCase(pin: InstallPin): string {
  const q = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return [
    `  ${pin.target})`,
    `    APP_URL=${q(pin.appUrl)}`,
    `    APP_SHA=${q(pin.appSha256)}`,
    `    CORE_URL=${q(pin.coreUrl)}`,
    `    CORE_SHA=${q(pin.coreSha256)}`,
    "    ;;",
  ].join("\n");
}

/**
 * Render the POSIX shell installer used to install on hosts that have no swamp
 * (the ssh path). The release is resolved once, on the orchestrator, and pinned
 * here by version, URL and SHA-256 for every Linux/macOS target — so one script
 * serves a mixed fleet, and each host downloads and verifies the bytes for its
 * own platform without parsing a manifest.
 *
 * The script refuses a host whose platform is not pinned, installs the app and,
 * when a core URL is pinned, herdr-core, then prints what is now present. It is
 * idempotent: a host already on `appVersion` reports `unchanged`.
 */
export function renderInstallScript(release: RenderedInstall): string {
  const q = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const branches = release.pins.map(pinCase).join("\n");
  const pinned = release.pins.map((pin) => pin.target).join(", ");
  return `#!/bin/sh
# Herdr app + herdr-core installer, generated by @svendowideit/herdr-app.
# Release pins are resolved and checksum-verified by swamp before this runs.
set -eu

APP_VERSION=${q(release.appVersion)}
CORE_VERSION=${q(release.coreVersion)}
CORE_MODE=${q(release.coreMode)}
FORCE=${q(release.force ? "1" : "0")}
VERIFY_CORE_SIGNATURE=${q(release.verifyCoreSignature ? "1" : "0")}

say() { printf '%s\\n' "$*"; }
fail() { say "herdr-app: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1"; }

need curl
need tar

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "the ssh installer supports Linux and macOS; on Windows run the extension locally, via swamp serve, or on a swamp worker" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
if [ "$os" = macos ] && [ "$arch" = x86_64 ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=aarch64
  fi
fi
target="$os-$arch"

case "$target" in
${branches}
  *) fail "this installer has no pinned build for $target (it pins ${pinned})" ;;
esac

bin="$HOME/.local/bin"
data_root="\${XDG_DATA_HOME:-$HOME/.local/share}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The app is herdr-app everywhere but Herdr inside the macOS bundle, and the
# core is hc or herdr-core; all four print "<name> <version>" on line one.
# Reading the second field keeps this POSIX (BSD sed has no alternation).
version_of() {
  [ -x "$1" ] || return 0
  vline=$("$1" --version 2>/dev/null | sed -n '1p')
  set -- $vline
  [ $# -ge 2 ] || return 0
  case "$1" in
    herdr-app | Herdr | hc | herdr-core) printf '%s\\n' "\${2#v}" ;;
  esac
}

tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT INT TERM

download() { # url dest sha
  curl -fsSL "$1" -o "$2" || fail "download failed: $1"
  got=$(sha256 "$2")
  [ "$got" = "$3" ] || fail "download is damaged (checksum mismatch): $1"
}

if [ "$os" = linux ]; then
  app_dir="$data_root/herdr-app"
  app_bin="$app_dir/herdr-app"
else
  app_dir="$HOME/Applications/Herdr.app"
  app_bin="$app_dir/Contents/MacOS/Herdr"
fi

previous=$(version_of "$app_bin")
app_present=0
if [ -e "$app_bin" ]; then app_present=1; fi
have="$previous"
if [ "$have" = "$APP_VERSION" ] && [ "$FORCE" != 1 ] && [ "$app_present" = 1 ]; then
  app_action=unchanged
  say "herdr-app $have is already installed at $app_dir"
else
  download "$APP_URL" "$tmp/app.tar.gz" "$APP_SHA"
  mkdir -p "$tmp/unpack" "$bin"
  tar -xzf "$tmp/app.tar.gz" -C "$tmp/unpack" ||
    fail "cannot unpack the app download"
  if [ "$os" = linux ]; then
    [ -d "$tmp/unpack/herdr-app" ] || fail "the app download holds no herdr-app directory"
    mkdir -p "$data_root"
    rm -rf "$app_dir.new"
    mv "$tmp/unpack/herdr-app" "$app_dir.new"
    rm -rf "$app_dir"
    mv "$app_dir.new" "$app_dir"
    chmod 755 "$app_dir/herdr-app"
    ln -sfn "$app_dir/herdr-app" "$bin/herdr-app"
    mkdir -p "$data_root/applications" "$data_root/icons/hicolor/scalable/apps"
    if [ -f "$app_dir/herdr-app.svg" ]; then
      cp "$app_dir/herdr-app.svg" "$data_root/icons/hicolor/scalable/apps/herdr-app.svg"
    fi
    cat > "$data_root/applications/herdr-app.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Herdr
Comment=Terminals and coding agents that keep running
Exec=$bin/herdr-app
Icon=herdr-app
Terminal=false
Categories=Development;
StartupWMClass=herdr-app
DESKTOP
    command -v update-desktop-database >/dev/null 2>&1 &&
      update-desktop-database "$data_root/applications" 2>/dev/null || true
  else
    [ -d "$tmp/unpack/Herdr.app" ] || fail "the app download holds no Herdr.app"
    mkdir -p "$HOME/Applications"
    signed=false
    if signature=$(/usr/bin/codesign -dvv "$tmp/unpack/Herdr.app" 2>&1); then
      case "$signature" in
        *"Authority=Developer ID Application:"*) signed=true ;;
        *"Signature=adhoc"*) : ;;
        *) fail "cannot determine the app's signature" ;;
      esac
    else
      case "$signature" in
        *": code object is not signed at all") : ;;
        *) fail "cannot determine the app's signature" ;;
      esac
    fi
    if [ "$signed" = true ]; then
      /usr/bin/codesign --verify --deep --strict "$tmp/unpack/Herdr.app" ||
        fail "the app's release signature is invalid"
    else
      /usr/libexec/PlistBuddy -c "Add :LSEnvironment:PATH string $bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$tmp/unpack/Herdr.app/Contents/Info.plist"
      /usr/bin/codesign --force --sign - "$tmp/unpack/Herdr.app" >/dev/null 2>&1
    fi
    rm -rf "$app_dir"
    mv "$tmp/unpack/Herdr.app" "$app_dir"
    ln -sfn "$app_dir/Contents/MacOS/Herdr" "$bin/herdr-app"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app_dir" 2>/dev/null || true
  fi
  have=$(version_of "$app_bin")
  [ -n "$have" ] || fail "the app was placed at $app_dir but does not run; re-run to try again"
  if [ "$app_present" = 1 ]; then app_action=updated; else app_action=installed; fi
  if [ "$previous" = "$APP_VERSION" ]; then app_action=reinstalled; fi
  say "herdr-app $have \${app_action} at $app_dir"
fi

core_bin="$bin/herdr-core"
core_have=$(version_of "$core_bin")
core_action=unchanged
if [ -z "$core_have" ]; then core_action=absent; fi
core_wanted=0
case "$CORE_MODE" in
  never) core_action=skipped ;;
  auto)
    if [ -z "$core_have" ] && [ ! -e "$core_bin" ] &&
      ! command -v herdr-core >/dev/null 2>&1; then
      core_wanted=1
    fi
    ;;
  always) core_wanted=1 ;;
esac

if [ "$core_wanted" = 1 ]; then
  [ -n "$CORE_URL" ] || fail "no herdr-core build is pinned for $target"
  download "$CORE_URL" "$tmp/core.tar.gz" "$CORE_SHA"
  mkdir -p "$tmp/core" "$bin"
  tar -xzf "$tmp/core.tar.gz" -C "$tmp/core" ||
    fail "cannot unpack the herdr-core download"
  new_core="$tmp/core/herdr-core"
  [ -f "$new_core" ] || fail "the herdr-core download holds no herdr-core"
  chmod 755 "$new_core"
  "$new_core" --version >/dev/null 2>&1 ||
    fail "the downloaded herdr-core does not run on this machine"
  bundled="$tmp/core/Herdr Core.app/Contents/MacOS/herdr-core"
  if [ "$os" = macos ] && [ -x "$bundled" ]; then
    if [ "$VERIFY_CORE_SIGNATURE" = 1 ]; then
      /usr/bin/codesign --verify --strict -R "=identifier \\"dev.herdr.core\\" and anchor apple generic and certificate leaf[subject.OU] = \\"2W9652Q7QR\\"" "$tmp/core/Herdr Core.app" ||
        fail "the herdr-core download is not a signed Herdr release"
    fi
    "$bundled" --hc-install-bundle "$bundled" "$core_bin" ||
      fail "installing Herdr Core.app failed"
    if [ -n "$core_have" ]; then
      "$core_bin" server restart >/dev/null ||
        say "herdr-core: could not restart the running core; it picks the update up on next start"
      core_action=updated
    else
      core_action=installed
    fi
  elif [ -x "$core_bin" ]; then
    "$core_bin" update --from "$new_core" >/dev/null ||
      fail "updating $core_bin failed"
    core_action=updated
  else
    cp "$new_core" "$core_bin.new"
    chmod 755 "$core_bin.new"
    mv -f "$core_bin.new" "$core_bin"
    core_action=installed
  fi
  if ! command -v hc >/dev/null 2>&1 && [ ! -e "$bin/hc" ]; then
    ln -s herdr-core "$bin/hc"
  fi
  core_have=$(version_of "$core_bin")
fi

say "herdr-app-version: $have"
say "herdr-app-action: $app_action"
say "herdr-core-version: \${core_have:-none}"
say "herdr-core-action: $core_action"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) say "Add $bin to your PATH to use herdr-app and hc from a terminal." ;;
esac
`;
}
