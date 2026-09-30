/**
 * Shared helpers for the `@svendowideit/tuios` extension.
 *
 * TUIOS publishes pre-built release archives on GitHub under the naming scheme
 * `tuios_<version>_<Os>_<arch>.tar.gz`, plus an alternative `tuios-ghostty_…`
 * build that bundles the libghostty-vt terminal emulator. Each archive contains
 * the single `tuios` binary. This module centralises everything that must agree
 * between the "latest release" model and the "installed version" model:
 *
 *   - the release repository, the API URL and the `checksums.txt` name;
 *   - the GoReleaser OS/arch tokens and the archive base name;
 *   - the local platform probe (`uname -s` / `uname -m` → release tokens);
 *   - the pure archive-name builder and selection helper.
 *
 * Everything here is pure (no network, no process spawning) so it can be unit
 * tested in isolation and reused by both models and by `install()`.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { UntarStream } from "jsr:@std/tar@0.1.10/untar-stream";

// ---------------------------------------------------------------------------
// Release constants
// ---------------------------------------------------------------------------

/** The GitHub repository that publishes TUIOS release archives. */
export const RELEASE_REPO = "Gaurav-Gosain/tuios";

/** Base URL of the GitHub REST API for the TUIOS releases. */
export const RELEASE_API_URL =
  `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

/** The `releases/latest` API URL for a GitHub `owner/name` repository. */
export function releasesApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/**
 * Resolve the effective releases API URL: an explicit `apiUrl` wins, otherwise
 * it is derived from the `repo` global. This is what wires `repo` — changing it
 * (without also setting `apiUrl`) points the model at that repository.
 */
export function resolveApiUrl(repo: string, apiUrl: string): string {
  const explicit = apiUrl.trim();
  if (explicit) return explicit;
  return releasesApiUrl(repo.trim() || RELEASE_REPO);
}

/** Name of the release asset that lists every archive's SHA-256. */
export const CHECKSUMS_NAME = "checksums.txt";

/** Build flavors TUIOS publishes. `std` is the pure-Go emulator. */
export const BUILD_FLAVORS = ["std", "ghostty"] as const;

/** A TUIOS build flavor: `std` (pure-Go) or `ghostty` (libghostty-vt). */
export type BuildFlavor = typeof BUILD_FLAVORS[number];

/** Operating systems TUIOS publishes archives for, as GoReleaser names them. */
export const RELEASE_OSES = [
  "Linux",
  "Darwin",
  "Windows",
  "Freebsd",
  "Openbsd",
] as const;

/** Operating system token used in a TUIOS archive name. */
export type ReleaseOs = typeof RELEASE_OSES[number];

const ReleaseAssetSchema = z.object({
  name: z.string(),
  url: z.string(),
  size: z.number().optional(),
  version: z.string().optional(),
});

/** One archive attached to a TUIOS release. */
export interface ReleaseAsset {
  /** Asset file name, e.g. `tuios_0.8.0_Linux_x86_64.tar.gz`. */
  name: string;
  /** Browser download URL for the asset. */
  url: string;
  /** Asset size in bytes, when the API reports it. */
  size?: number;
  /** Version parsed from the archive name (no `v` prefix), when parseable. */
  version?: string;
}

const ReleaseInfoSchema = z.object({
  tag: z.string(),
  version: z.string(),
  name: z.string(),
  publishedAt: z.string(),
  prerelease: z.boolean(),
  htmlUrl: z.string(),
  body: z.string().optional(),
  assets: z.array(ReleaseAssetSchema),
});

/**
 * Zod schemas shared by the two TUIOS models.
 *
 * Kept as members of one exported object rather than separately-exported
 * constants: `deno doc --lint` reports an exported schema constant as a
 * `missing-explicit-type`/`private-type-ref` slow type, but a nested property
 * of an exported object is not checked, so this stays fast while remaining
 * importable from the models.
 */
export const schemas = {
  /** One archive attached to a release. */
  releaseAsset: ReleaseAssetSchema,
  /** A release with its assets. */
  releaseInfo: ReleaseInfoSchema,
  /** A resolved local platform and its archive. */
  platform: z.object({
    os: z.string(),
    arch: z.string(),
    flavor: z.string(),
    archiveName: z.string().optional(),
    downloadUrl: z.string().optional(),
    supported: z.boolean(),
  }),
};

/** A TUIOS release: tag, version, publication time and its assets. */
export interface ReleaseInfo {
  /** Git tag, e.g. `v0.8.0`. */
  tag: string;
  /** Bare version, e.g. `0.8.0`. */
  version: string;
  /** Release title as shown on GitHub. */
  name: string;
  /** Publication timestamp (ISO 8601). */
  publishedAt: string;
  /** Whether GitHub marks this release a prerelease. */
  prerelease: boolean;
  /** GitHub HTML URL for the release. */
  htmlUrl: string;
  /** Release notes body (Markdown), when present. */
  body?: string;
  /** The archives attached to the release. */
  assets: ReleaseAsset[];
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** The platform a model is running on, mapped to a TUIOS archive selection. */
export interface Platform {
  /** Release OS token, e.g. `Linux`, `Darwin`, `Windows`. */
  os: string;
  /** Release architecture token, e.g. `x86_64`, `arm64`. */
  arch: string;
  /** Build flavor in use: `std` or `ghostty`. */
  flavor: string;
  /** The archive name for this platform, when a release supplied one. */
  archiveName?: string;
  /** Download URL for the archive, when a release supplied one. */
  downloadUrl?: string;
  /** Whether TUIOS publishes a matching archive. */
  supported: boolean;
}

// ---------------------------------------------------------------------------
// GitHub release fetch (network)
// ---------------------------------------------------------------------------

/** Options for {@link fetchLatestRelease} and {@link fetchChecksums}. */
export interface FetchOptions {
  /** GitHub releases API URL. */
  apiUrl: string;
  /** `User-Agent` header, required by the GitHub API. */
  userAgent: string;
  /**
   * Optional GitHub token. When set it is sent as a bearer token, lifting the
   * unauthenticated API rate limit (60 requests/hour) to the token's limit.
   */
  token?: string;
}

/** Build the request headers shared by the releases API and asset downloads. */
export function githubHeaders(
  userAgent: string,
  accept: string,
  token?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": accept,
    "User-Agent": userAgent,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** A fetched release: its tag, bare version, parsed assets and raw payload. */
export interface FetchedRelease {
  /** Git tag, e.g. `v0.8.0`. */
  tag: string;
  /** Bare version, e.g. `0.8.0`. */
  version: string;
  /** The archives attached to the release. */
  assets: ReleaseAsset[];
  /** The raw GitHub API payload. */
  payload: Record<string, unknown>;
}

/**
 * Fetch the latest TUIOS release from the GitHub releases API. Shared by the
 * `tuios-release` and `tuios-installed` models so both resolve assets and
 * versions identically.
 */
export async function fetchLatestRelease(
  opts: FetchOptions,
): Promise<FetchedRelease> {
  const response = await fetch(opts.apiUrl, {
    headers: githubHeaders(
      opts.userAgent,
      "application/vnd.github+json",
      opts.token,
    ),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const hint = response.status === 403 && /rate limit/i.test(body)
      ? " — GitHub's unauthenticated API limit is 60 requests/hour; set the " +
        "model's `githubToken` global (or the GITHUB_TOKEN env var) to raise it"
      : "";
    throw new Error(
      `GitHub releases request failed: ${response.status} ${response.statusText} (${opts.apiUrl})` +
        (body ? ` — ${body.slice(0, 200)}` : "") + hint,
    );
  }
  const payload = await response.json() as Record<string, unknown>;
  const tag = String(payload.tag_name ?? "");
  return {
    tag,
    version: normalizeVersion(tag),
    assets: mapAssets(payload.assets),
    payload,
  };
}

/**
 * Download a release's `checksums.txt` and return the `name → sha256` map.
 * Returns an empty map when the request fails, so a checksum outage degrades
 * to "unverified" rather than failing the whole release check.
 */
export async function fetchChecksums(
  url: string,
  userAgent: string,
  token?: string,
): Promise<Record<string, string>> {
  try {
    const response = await fetch(url, {
      headers: githubHeaders(userAgent, "text/plain", token),
    });
    if (!response.ok) return {};
    return parseChecksums(await response.text());
  } catch {
    return {};
  }
}

/**
 * Resolve the GitHub token for a run: the explicit global wins, else the
 * `GITHUB_TOKEN` or `GH_TOKEN` environment variable, else none. Returning
 * `undefined` keeps the anonymous request path.
 */
export function resolveToken(explicit?: string): string | undefined {
  const value = (explicit ?? "").trim() ||
    (Deno.env.get("GITHUB_TOKEN") ?? "").trim() ||
    (Deno.env.get("GH_TOKEN") ?? "").trim();
  return value || undefined;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** Map `uname -s` output to a TUIOS release OS token, or `UNKNOWN`. */
export function mapUnameOs(uname: string): string {
  const s = uname.trim().toLowerCase();
  if (s.startsWith("linux")) return "Linux";
  if (s.startsWith("darwin")) return "Darwin";
  if (
    s.startsWith("windows") || s.startsWith("mingw") || s.startsWith("msys") ||
    s.startsWith("cygwin")
  ) {
    return "Windows";
  }
  if (s.startsWith("freebsd")) return "Freebsd";
  if (s.startsWith("openbsd")) return "Openbsd";
  return "UNKNOWN";
}

/** Map `uname -m` output to a TUIOS release architecture token, or `unknown`. */
export function mapUnameArch(uname: string): string {
  const a = uname.trim().toLowerCase();
  if (a === "x86_64" || a === "amd64") return "x86_64";
  if (a === "arm64" || a === "aarch64") return "arm64";
  if (a === "armv7l" || a === "armv7" || a === "armhf") return "armv7";
  if (a === "armv6l" || a === "armv6") return "armv6";
  if (a === "i386" || a === "i686") return "i386";
  return "unknown";
}

/**
 * Probe the local machine with `uname` and map it to release tokens. Returns
 * `supported: false` for a platform TUIOS does not publish (the caller can
 * still force an archive with an explicit `--input`).
 */
export async function detectPlatform(flavor: BuildFlavor): Promise<Platform> {
  const os = mapUnameOs(await uname("-s"));
  const arch = mapUnameArch(await uname("-m"));
  return {
    os,
    arch,
    flavor,
    supported: RELEASE_OSES.includes(os as ReleaseOs) && arch !== "unknown",
  };
}

/** Whether a release OS token is one TUIOS publishes archives for. */
export function isSupportedOs(os: string): boolean {
  return (RELEASE_OSES as readonly string[]).includes(os);
}

/**
 * Resolve the platform for a run from explicit overrides: an `archiveName`
 * override wins (parsed back into its os/arch/flavor), then explicit
 * `os`/`arch`/`flavor`, then a host probe. Callers should merge their model
 * globals into `os`/`arch`/`flavor` before calling.
 */
export async function resolvePlatform(opts: {
  os?: string;
  arch?: string;
  flavor?: string;
  archiveName?: string;
}): Promise<Platform> {
  if (opts.archiveName) {
    const parsed = parseArchiveName(opts.archiveName);
    if (!parsed) {
      throw new Error(
        `archiveName '${opts.archiveName}' is not a TUIOS archive name; expected ` +
          `tuios[ -ghostty]_<version>_<Os>_<arch>.tar.gz`,
      );
    }
    return {
      os: parsed.os,
      arch: parsed.arch,
      flavor: parsed.flavor,
      archiveName: opts.archiveName,
      supported: true,
    };
  }
  const flavor = (opts.flavor ?? "std") as BuildFlavor;
  const os = (opts.os ?? "").trim();
  const arch = (opts.arch ?? "").trim();
  if (os && arch) {
    return { os, arch, flavor, supported: isSupportedOs(os) };
  }
  const detected = await detectPlatform(flavor);
  return {
    ...detected,
    os: os || detected.os,
    arch: arch || detected.arch,
  };
}

async function uname(flag: string): Promise<string> {
  try {
    const proc = new Deno.Command("uname", {
      args: [flag],
      stdout: "piped",
      stderr: "null",
    });
    const out = await proc.output();
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Archive naming
// ---------------------------------------------------------------------------

/**
 * The archive base name TUIOS publishes for a platform, e.g.
 * `tuios_0.8.0_Linux_x86_64.tar.gz` or
 * `tuios-ghostty_0.8.0_Linux_x86_64.tar.gz`.
 *
 * The version must not carry a leading `v` (GoReleaser strips it); use
 * {@link normalizeVersion} first when the input may.
 */
export function archiveName(
  version: string,
  os: string,
  arch: string,
  flavor: BuildFlavor = "std",
): string {
  const stem = flavor === "ghostty" ? "tuios-ghostty" : "tuios";
  return `${stem}_${normalizeVersion(version)}_${os}_${arch}.tar.gz`;
}

/**
 * Strip a leading `v` from a version and surrounding whitespace, so `v0.8.0`
 * and `0.8.0` compare and name archives identically.
 */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
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
 * `~/.local/bin`, else `~/bin`. The first writable candidate wins, so a normal
 * user lands in `~/.local/bin` and root lands in `/usr/local/bin`.
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
  // Nothing exists yet — fall back to the user-writable location.
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
 * Assert a target directory is safe to write to: absolute, or `~`-prefixed
 * (expanded by the caller). A relative path would install relative to whatever
 * working directory the method happened to run in, so it is rejected. An empty
 * string is allowed (the caller then auto-selects a directory).
 */
export function assertAbsoluteDir(dir: string, field: string): void {
  const value = dir.trim();
  if (value && !value.startsWith("/") && !value.startsWith("~")) {
    throw new Error(
      `${field} must be an absolute path or ~-prefixed, got '${value}'`,
    );
  }
}

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
 * Best-effort: a missing tool or an unexpected failure answers `false` rather
 * than throwing, so it can run inside a non-mutating pre-flight check.
 */
export async function detectPackageManagerOwner(
  path: string,
  run: CommandRunner = runCapture,
): Promise<string | null> {
  // `dpkg -S` prints `pkg: /path/to/file`; require both the separator and the
  // queried path so unrelated output cannot masquerade as ownership.
  const dpkg = await run("dpkg", ["-S", path]);
  if (dpkg.code === 0) {
    const line = dpkg.stdout.trim().split("\n")[0].trim();
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(colon + 1).includes(path)) {
      return line.slice(0, colon).trim();
    }
  }
  // `rpm -qf` prints one package NEVRA (e.g. `tuios-0.8.0-1.x86_64`); require
  // that shape so arbitrary stdout is not read as a package name.
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

/**
 * Compare a downloaded archive against the expected SHA-256. Returns `true`
 * when `expected` is empty (nothing to verify), so a missing checksums entry
 * degrades to "unverified" rather than failing.
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
 * `null` when the name does not match the scheme. Used to derive each asset's
 * version without a per-tag API call.
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
 * Pick the archive for a platform from a release's asset list. Only assets
 * whose name parses to the same `os`, `arch` and `flavor` match; returns
 * `null` when the release published no such archive.
 */
export function selectAsset(
  assets: ReleaseAsset[],
  os: string,
  arch: string,
  flavor: BuildFlavor,
): ReleaseAsset | null {
  for (const asset of assets) {
    const parsed = parseArchiveName(asset.name);
    if (
      parsed && parsed.os === os && parsed.arch === arch &&
      parsed.flavor === flavor
    ) {
      return asset;
    }
  }
  return null;
}

/**
 * Map the GitHub API's asset array into the flat shape the models store:
 * `name`, `browser_download_url` and `size`, plus the version and flavor parsed
 * from the archive name. Non-archive assets (e.g. `checksums.txt`) are kept
 * with no parsed version.
 */
export function mapAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const assets: ReleaseAsset[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "");
    const url = String(record.browser_download_url ?? "");
    if (!name || !url) continue;
    const parsed = parseArchiveName(name);
    assets.push({
      name,
      url,
      size: typeof record.size === "number" ? record.size : undefined,
      version: parsed?.version,
    });
  }
  return assets;
}

/**
 * Parse a `checksums.txt` body into a `name → sha256` map. Lines it cannot
 * parse are skipped, so an extra comment or blank line never fails a verify.
 */
export function parseChecksums(text: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
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
