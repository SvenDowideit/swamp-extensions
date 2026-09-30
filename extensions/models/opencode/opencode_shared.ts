/**
 * Shared helpers for the `@svendowideit/opencode` extension.
 *
 * Fetching and verifying the opencode release archive is the job of
 * `@svendowideit/github-release-install`; this module holds only the
 * opencode-specific pieces:
 *
 *   - locating and running the `opencode` binary (`opencode --version`);
 *   - extracting the single `opencode` member from the release archive;
 *   - install-directory and `PATH` helpers;
 *   - the package-manager ownership probe;
 *   - reading and writing opencode's `themes/<name>.json` and `tui.json`.
 *
 * Everything here is pure or a single filesystem/process call, so it can be
 * unit tested in isolation.
 *
 * @module
 */

import { UntarStream } from "jsr:@std/tar@0.1.10/untar-stream";

/** The theme shipped with this extension, and set as the default. */
export const DEFAULT_THEME = "borland_modern_blue";

/** The systemd-free install location the upstream installer uses. */
export const UPSTREAM_INSTALL_DIR = "~/.opencode/bin";

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Strip a leading `v` and surrounding whitespace, so `v1.2.3` == `1.2.3`. */
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

/**
 * Parse `opencode --version` output. The command prints the bare version
 * (`1.18.33`) on the first line; a leading `v` is tolerated. Returns `null`
 * when no version is found.
 */
export function parseVersionOutput(output: string): string | null {
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return match ? match[1] : null;
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

/** Probe whether a directory is writable by creating and removing a temp file. */
export function dirIsWritable(
  dir: string,
  probeName = `.opencode-write-test-${crypto.randomUUID()}`,
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
 * Choose the directory to install the `opencode` binary into: the first
 * writable of `~/.opencode/bin` (the upstream installer's location),
 * `/usr/local/bin`, `~/.local/bin`.
 */
export function selectInstallDir(
  home?: string,
  isWritable: (dir: string) => boolean = dirIsWritable,
): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  const candidates = [
    `${h}/.opencode/bin`,
    "/usr/local/bin",
    `${h}/.local/bin`,
  ];
  for (const dir of candidates) {
    if (isWritable(dir)) return dir;
  }
  return `${h}/.opencode/bin`;
}

/** Whether a directory is on the `PATH` environment variable. */
export function isOnPath(dir: string, pathVar?: string): boolean {
  const path = pathVar ?? Deno.env.get("PATH") ?? "";
  const normalized = dir.replace(/\/+$/, "");
  return path.split(":").some((entry) =>
    entry.replace(/\/+$/, "") === normalized
  );
}

/**
 * Assert a target path is absolute or `~`-prefixed (expanded by the caller).
 * A relative path would resolve against the working directory, so it is
 * rejected. An empty string is allowed (the caller auto-selects).
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

/** A command runner returning decoded stdout/stderr and the exit code. */
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
 * read-only `dpkg -S` and `rpm -qf` queries, then checks whether a Homebrew
 * formula with the binary's name is installed. Best-effort: any failure
 * answers `null`.
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
 * Compute the SHA-256 of a byte array as lowercase hex.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare downloaded bytes against the expected SHA-256. Returns `true` when
 * `expected` is empty (nothing to verify).
 */
export async function verifySha256(
  bytes: Uint8Array,
  expected: string,
): Promise<boolean> {
  if (!expected) return true;
  return (await sha256Hex(bytes)) === expected.toLowerCase();
}

/**
 * Extract a single named member from a gzipped tar archive, in memory.
 * opencode archives contain one `opencode` binary; `memberName` defaults to
 * `opencode` and is compared against the entry's basename. Returns the
 * member's bytes, or `null` when the archive does not contain it.
 */
export async function extractFromTarGz(
  bytes: Uint8Array,
  memberName = "opencode",
): Promise<Uint8Array | null> {
  const copy = new Uint8Array(bytes);
  const decompressed = new Blob([copy]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  let found: Uint8Array | null = null;
  for await (const entry of decompressed.pipeThrough(new UntarStream())) {
    if (!entry.readable) continue;
    const data = new Uint8Array(
      await new Response(entry.readable).arrayBuffer(),
    );
    const base = entry.path.replace(/\\/g, "/").split("/").filter(Boolean)
      .pop();
    if (base === memberName && !found) found = data;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Theme files
// ---------------------------------------------------------------------------

/** The themes directory for a config dir. */
export function themesDir(configDir: string): string {
  return `${configDir.replace(/\/+$/, "")}/themes`;
}

/** The path of a theme's JSON file within a config dir. */
export function themeFilePath(configDir: string, themeName: string): string {
  return `${themesDir(configDir)}/${themeName}.json`;
}

/** The path of opencode's `tui.json` within a config dir. */
export function tuiConfigPath(configDir: string): string {
  return `${configDir.replace(/\/+$/, "")}/tui.json`;
}

/**
 * Validate that a theme body is an opencode theme object: a JSON object with
 * both a `theme` map and a `defs` map. Throws with a clear message otherwise,
 * so a malformed bundled or user theme is caught before it is written.
 */
export function validateTheme(
  name: string,
  theme: Record<string, unknown>,
): void {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) {
    throw new Error(`theme '${name}' is not a JSON object`);
  }
  const hasTheme = theme.theme && typeof theme.theme === "object";
  const hasDefs = theme.defs && typeof theme.defs === "object";
  if (!hasTheme || !hasDefs) {
    throw new Error(
      `theme '${name}' must define both a 'theme' and a 'defs' object`,
    );
  }
}

/**
 * Merge a `theme` selection into an existing `tui.json` body, preserving every
 * other key (keybinds, etc.). Returns the pretty-printed JSON to write. An
 * `existing` body that is absent or unparseable is treated as `{}` so a broken
 * file is repaired rather than preserved.
 */
export function mergeTuiTheme(
  existing: string | null,
  themeName: string,
): string {
  let parsed: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    try {
      const value = JSON.parse(existing);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // A malformed tui.json is replaced rather than preserved.
    }
  }
  parsed["$schema"] = parsed["$schema"] ??
    "https://opencode.ai/tui.json";
  parsed.theme = themeName;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Read the currently selected theme from a `tui.json` body, or `null`. */
export function readTuiTheme(existing: string | null): string | null {
  if (!existing || !existing.trim()) return null;
  try {
    const value = JSON.parse(existing);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const theme = (value as Record<string, unknown>).theme;
      return typeof theme === "string" ? theme : null;
    }
  } catch {
    // ignore malformed
  }
  return null;
}
