/**
 * TUIOS-specific helpers for the `@svendowideit/tuios` extension.
 *
 * Fetching, platform selection, checksum lookup and archive download are no
 * longer done here — that is the job of `@svendowideit/github-release-install`,
 * which `tuios` consumes through its bundled workflow. This module keeps only
 * what is particular to the `tuios` binary:
 *
 *   - the TUIOS build flavors and archive-name parsing;
 *   - the local install-directory and `PATH` helpers;
 *   - the package-manager ownership probe;
 *   - SHA-256 verification of a supplied archive;
 *   - extracting the single `tuios` member from a gzipped tar;
 *   - parsing `tuios --version` output;
 *   - version normalisation and comparison.
 *
 * Everything here is pure (no network) so it can be unit tested in isolation.
 *
 * @module
 */

import { UntarStream } from "jsr:@std/tar@0.1.10/untar-stream";

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** Theme ids shipped with this extension (files under `themes/`). */
export const BUNDLED_THEMES = ["swamp_club", "borland_modern_blue"] as const;

/** A bundled TUIOS theme id. */
export type BundledTheme = typeof BUNDLED_THEMES[number];

/** The theme selected when the user has not chosen one: Swamp Club. */
export const DEFAULT_THEME: BundledTheme = "swamp_club";

/**
 * The TUIOS configuration root: `$XDG_CONFIG_HOME/tuios`, falling back to
 * `~/.config/tuios`. Matches the directory TUIOS itself reads `config.toml`
 * and `themes/` from on Linux.
 */
export function tuiosConfigDir(
  home?: string,
  xdgConfigHome?: string,
): string {
  const xdg = (xdgConfigHome ?? Deno.env.get("XDG_CONFIG_HOME") ?? "").trim();
  const base = xdg || `${home ?? Deno.env.get("HOME") ?? ""}/.config`;
  return `${base.replace(/\/+$/, "")}/tuios`;
}

/** The directory TUIOS loads `<id>.json` theme files from. */
export function tuiosThemesDir(home?: string, xdg?: string): string {
  return `${tuiosConfigDir(home, xdg)}/themes`;
}

/** The TUIOS `config.toml` path. */
export function tuiosConfigPath(home?: string, xdg?: string): string {
  return `${tuiosConfigDir(home, xdg)}/config.toml`;
}

/** The theme file name TUIOS expects for a theme id: `<id>.json`. */
export function themeFileName(themeId: string): string {
  return `${themeId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
}

/**
 * Parse and validate a TUIOS theme JSON document. A theme must be an object
 * with a non-empty string `id`; every colour key it carries must be a string.
 * Returns the parsed object on success, or `null` when it is not a theme — so
 * a bad file is rejected before it is written into the themes directory.
 */
export function parseTheme(content: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const theme = value as Record<string, unknown>;
  if (typeof theme.id !== "string" || theme.id.trim() === "") return null;
  for (const [key, v] of Object.entries(theme)) {
    if (key === "chrome") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
      for (const cv of Object.values(v as Record<string, unknown>)) {
        if (typeof cv !== "string") return null;
      }
      continue;
    }
    if (typeof v === "boolean") continue;
    if (typeof v !== "string") return null;
  }
  return theme;
}

/**
 * Read the `theme` value from a TUIOS `config.toml`, scanning only the
 * `[appearance]` table. Returns the bare string (quotes stripped) or `""` when
 * the key is absent or empty — meaning the user has not chosen a theme yet.
 */
export function readConfiguredTheme(toml: string): string {
  let inAppearance = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) {
      inAppearance = section[1] === "appearance";
      continue;
    }
    if (!inAppearance) continue;
    const match = line.match(/^theme\s*=\s*(.*)$/);
    if (match) return tomlString(match[1]);
  }
  return "";
}

/** Strip surrounding single or double quotes from a TOML scalar. */
function tomlString(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/s);
  return quoted ? quoted[2] : trimmed;
}

/**
 * Return `toml` with the `[appearance] theme` set to `themeId`. Replaces an
 * existing `theme =` line in `[appearance]` in place, inserts one under an
 * existing `[appearance]` table, or appends a fresh `[appearance]` table when
 * the file has none. Everything else in the file is left byte-for-byte alone.
 */
export function setConfiguredTheme(toml: string, themeId: string): string {
  const lines = toml.split(/\r?\n/);
  const assignment = `theme = '${themeId}'`;
  let inAppearance = false;
  let appearanceIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) {
      inAppearance = section[1] === "appearance";
      if (inAppearance && appearanceIndex < 0) appearanceIndex = i;
      continue;
    }
    if (inAppearance && /^theme\s*=/.test(line)) {
      lines[i] = assignment;
      return lines.join("\n");
    }
  }
  if (appearanceIndex >= 0) {
    lines.splice(appearanceIndex + 1, 0, assignment);
    return lines.join("\n");
  }
  const body = lines.join("\n").replace(/\n*$/, "");
  return `${body}${body ? "\n" : ""}\n[appearance]\n${assignment}\n`;
}

// ---------------------------------------------------------------------------
// Build flavors
// ---------------------------------------------------------------------------

/** Build flavors TUIOS publishes. `std` is the pure-Go emulator. */
export const BUILD_FLAVORS = ["std", "ghostty"] as const;

/** A TUIOS build flavor: `std` (pure-Go) or `ghostty` (libghostty-vt). */
export type BuildFlavor = typeof BUILD_FLAVORS[number];

/** The asset stem TUIOS publishes for a build flavor. */
export function stemForFlavor(flavor: BuildFlavor): string {
  return flavor === "ghostty" ? "tuios-ghostty" : "tuios";
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Strip a leading `v` and surrounding whitespace, so `v0.8.0` == `0.8.0`. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Compare two version strings by numeric dotted segments (ignoring a `v`). */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".");
  const pb = normalizeVersion(b).split(".");
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/**
 * Probe whether a directory is writable by creating and removing a temp file.
 * Used as the default `isWritable` for {@link selectInstallDir}.
 */
export function dirIsWritable(
  dir: string,
  probeName = `.tuios-write-test-${crypto.randomUUID()}`,
): boolean {
  try {
    const stat = Deno.statSync(dir);
    if (!stat.isDirectory) return false;
    const probe = `${dir.replace(/\/+$/, "")}/${probeName}`;
    Deno.writeTextFileSync(probe, "");
    Deno.removeSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Choose the directory to install the binary into, mirroring the upstream
 * install script: `/usr/local/bin` when this user can write there, else
 * `~/.local/bin`, else `~/bin`. The first writable candidate wins.
 */
export function selectInstallDir(
  home?: string,
  isWritable: (dir: string) => boolean = dirIsWritable,
): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  const candidates = ["/usr/local/bin", `${h}/.local/bin`, `${h}/bin`];
  for (const dir of candidates) {
    if (isWritable(dir)) return dir;
  }
  return `${h}/.local/bin`;
}

/**
 * Whether a directory is on the `PATH` environment variable. Used to warn
 * after installing into `~/.local/bin` when the shell will not find it.
 */
export function isOnPath(dir: string, pathVar?: string): boolean {
  const path = pathVar ?? Deno.env.get("PATH") ?? "";
  const normalized = dir.replace(/\/+$/, "");
  return path.split(":").some((entry) =>
    entry.replace(/\/+$/, "") === normalized
  );
}

/**
 * Assert a target path is safe to use: absolute, or `~`-prefixed (expanded by
 * the caller). A relative path would resolve against whatever working
 * directory the method happened to run in, so it is rejected. An empty string
 * is allowed (the caller then auto-selects a path).
 */
export function assertAbsoluteDir(dir: string, field: string): void {
  const value = dir.trim();
  if (value && !value.startsWith("/") && !value.startsWith("~")) {
    throw new Error(
      `${field} must be an absolute path or ~-prefixed, got '${value}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// Package-manager guard
// ---------------------------------------------------------------------------

/**
 * A command runner returning the decoded stdout, stderr and exit code. The
 * default shells out via `Deno.Command`; tests inject a stub.
 */
export type CommandRunner = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Run a command, capturing stdout/stderr; a missing binary is code 127. */
export async function runCapture(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const proc = new Deno.Command(bin, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/**
 * Detect whether a system package manager owns a file at `path`. Runs the
 * read-only ownership queries `dpkg -S` and `rpm -qf`, then checks whether a
 * Homebrew formula with the binary's name (`tuios` or `tuios-bin`) is
 * installed. Returns a human-readable owner description, or `null` when no
 * package manager claims it.
 *
 * Best-effort: a missing tool or an unexpected failure answers `null` rather
 * than throwing, so it can run inside a non-mutating pre-flight check.
 */
export async function detectPackageManagerOwner(
  path: string,
  run: CommandRunner = runCapture,
): Promise<string | null> {
  const dpkg = await run("dpkg", ["-S", path]);
  if (dpkg.code === 0) {
    const line = dpkg.stdout.trim().split("\n")[0].trim();
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(colon + 1).includes(path)) {
      return line.slice(0, colon).trim();
    }
  }
  const rpm = await run("rpm", ["-qf", path]);
  if (rpm.code === 0) {
    const line = rpm.stdout.trim().split("\n")[0].trim();
    if (/^[\w.+-]+-[\d][\w.+-]*$/.test(line)) return line;
  }
  const stem = path.replace(/\\/g, "/").split("/").pop()?.replace(
    /\.exe$/i,
    "",
  );
  if (stem) {
    for (const name of [stem, `${stem}-bin`]) {
      const result = await run("brew", ["list", "--formula", name]);
      if (result.code === 0) return `brew formula '${name}'`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Archive handling
// ---------------------------------------------------------------------------

/**
 * Compare downloaded bytes against the expected SHA-256. Returns `true` when
 * `expected` is empty (nothing to verify), so a missing checksum degrades to
 * "unverified" rather than failing.
 */
export async function verifySha256(
  bytes: Uint8Array,
  expected: string,
): Promise<boolean> {
  if (!expected) return true;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const actual = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return actual === expected.toLowerCase();
}

/**
 * Extract a single named member from a gzipped tar archive, in memory. TUIOS
 * archives contain one `tuios` binary; `memberName` defaults to `tuios` and is
 * compared against the entry's basename, so a leading `./` or a directory
 * prefix in the archive does not matter. Returns the member's bytes, or
 * `null` when the archive does not contain it.
 */
export async function extractFromTarGz(
  bytes: Uint8Array,
  memberName = "tuios",
): Promise<Uint8Array | null> {
  const copy = new Uint8Array(bytes); // detach from any SharedArrayBuffer view
  const decompressed = new Blob([copy]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  let found: Uint8Array | null = null;
  for await (const entry of decompressed.pipeThrough(new UntarStream())) {
    if (!entry.readable) continue;
    // Read every entry to completion so the tar stream advances cleanly; the
    // binaries are tens of MB, so a matching entry is kept and the rest freed.
    const data = new Uint8Array(
      await new Response(entry.readable).arrayBuffer(),
    );
    const base = entry.path.replace(/\\/g, "/").split("/").filter(Boolean)
      .pop();
    if (base === memberName && !found) found = data;
  }
  return found;
}

/**
 * Parse `tuios[ -ghostty]_<version>_<Os>_<arch>.tar.gz` into its parts, or
 * `null` when the name does not match the scheme. Used to derive the version
 * being installed from the archive name the release workflow resolved.
 */
export function parseArchiveName(
  name: string,
): { flavor: BuildFlavor; version: string; os: string; arch: string } | null {
  const match = name.match(
    /^(tuios(?:-ghostty)?)_(.+)_(Linux|Darwin|Windows|Freebsd|Openbsd)_([A-Za-z0-9_]+)\.tar\.gz$/,
  );
  if (!match) return null;
  return {
    flavor: match[1] === "tuios-ghostty" ? "ghostty" : "std",
    version: match[2],
    os: match[3],
    arch: match[4],
  };
}

/**
 * Parse `tuios --version` output into a version and the VT backend name. The
 * first line is `tuios version 0.8.0 [pure-Go backend]`; later lines carry the
 * commit, build date and builder. Returns `null` when the line does not match.
 */
export function parseVersionOutput(
  output: string,
): { version: string; backend: string } | null {
  const match = output.match(
    /tuios\s+version\s+(v?\d[^\s\]]*)(?:\s+\[([^\]]+)\])?/i,
  );
  if (!match) return null;
  return { version: normalizeVersion(match[1]), backend: match[2] ?? "" };
}
