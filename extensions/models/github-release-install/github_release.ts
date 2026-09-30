/**
 * Shared helpers for the `@svendowideit/github-release-install` extension.
 *
 * This module is the reusable core that turns a GitHub repository's releases
 * into a single verified archive on disk. It answers, for any repository that
 * follows the common GoReleaser naming scheme:
 *
 *   1. **What is the latest release?** — read it from the GitHub releases API.
 *   2. **What should this machine download?** — probe the local OS and
 *      architecture (`uname -s` / `uname -m`), match them against each asset's
 *      parsed name, and select the right archive.
 *   3. **Is the download intact?** — download the release's `checksums.txt`,
 *      look up the archive's SHA-256, and verify the downloaded bytes against
 *      it before writing them anywhere.
 *
 * Everything here is either pure or a single-purpose network call, so it can be
 * unit tested in isolation and reused by the model and its workflow. The same
 * pattern `@swamp/deno-runner` uses for Deno is generalised here: any
 * repository, any release, any archive format.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Release constants
// ---------------------------------------------------------------------------

/**
 * Default pattern an archive asset's **file name** must match.
 *
 * Named groups:
 *   - `stem`    — the product name, including any flavor suffix
 *                 (`tuios` or `tuios-ghostty`, `deno`).
 *   - `version` — the release version, with an optional leading `v`.
 *   - `os`      — the release OS token (`Linux`, `Darwin`, …).
 *   - `arch`    — the release architecture token (`x86_64`, `arm64`, …).
 *   - `ext`     — the archive extension, when present (a bare binary has none).
 *
 * The shape matches `tuios_0.8.0_Linux_x86_64.tar.gz`,
 * `tuios-ghostty_0.8.0_Linux_x86_64.tar.gz` and a raw
 * `tuios_0.8.0_Linux_x86_64`; a different publisher overrides this global.
 */
export const DEFAULT_ASSET_PATTERN =
  "^(?<stem>[^/]+?)_(?<version>v?\\d[0-9A-Za-z.+-]*)_(?<os>[A-Za-z0-9]+)_(?<arch>[A-Za-z0-9_]+)(?:\\.(?<ext>tar\\.gz|tgz|zip|gz|exe|bin))?$";

/** The default name of the release asset that lists every archive's SHA-256. */
export const CHECKSUMS_NAME = "checksums.txt";

/** Archive formats this extension can recognise. `raw` is a bare executable. */
export const ARCHIVE_TYPES = ["auto", "tar.gz", "zip", "raw"] as const;

/** A recognised archive format, or `auto` to derive it from the file name. */
export type ArchiveType = typeof ARCHIVE_TYPES[number];

// ---------------------------------------------------------------------------
// Zod schemas shared by the model
// ---------------------------------------------------------------------------

const ReleaseAssetSchema = z.object({
  name: z.string(),
  url: z.string(),
  size: z.number().optional(),
  version: z.string().optional(),
});

/**
 * The raw GitHub release payload. Kept intact (rather than projected away) so
 * callers can render release notes and read fields this module does not model.
 * Loose by design: it follows whatever the API returns.
 */
const ReleasePayloadSchema = z.record(z.string(), z.unknown());

/**
 * Zod schemas shared by the model and its tests. Kept as members of one
 * exported object (rather than separately-exported constants) so `deno doc
 * --lint` does not report a `private-type-ref` slow type on each schema.
 */
export const schemas = {
  /** One asset attached to a release. */
  releaseAsset: ReleaseAssetSchema,
  /** A release with its assets. */
  releaseInfo: z.object({
    tag: z.string(),
    version: z.string(),
    name: z.string(),
    publishedAt: z.string(),
    prerelease: z.boolean(),
    htmlUrl: z.string(),
    body: z.string().optional(),
    assets: z.array(ReleaseAssetSchema),
    /** The raw GitHub API payload, preserved for rendering and extra fields. */
    payload: ReleasePayloadSchema,
  }),
  /** The platform this run resolved, and the archive selected for it. */
  platform: z.object({
    os: z.string(),
    arch: z.string(),
    stem: z.string(),
    archiveName: z.string().optional(),
    downloadUrl: z.string().optional(),
    format: z.string(),
    supported: z.boolean(),
  }),
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One asset attached to a release. */
export interface ReleaseAsset {
  /** Asset file name, e.g. `tuios_0.8.0_Linux_x86_64.tar.gz`. */
  name: string;
  /** Download URL for the asset. */
  url: string;
  /** Asset size in bytes, when the API reports it. */
  size?: number;
  /** Version parsed from the archive name (no `v` prefix), when parseable. */
  version?: string;
}

/** A release with its assets, as the model stores it. */
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
  /** The assets attached to the release, including checksums.txt. */
  assets: ReleaseAsset[];
  /** The raw GitHub API payload, preserved for rendering and extra fields. */
  payload: Record<string, unknown>;
}

/** A resolved platform and the asset selected for it. */
export interface Platform {
  /** Release OS token, e.g. `Linux`, `Darwin`. */
  os: string;
  /** Release architecture token, e.g. `x86_64`, `arm64`. */
  arch: string;
  /** Required asset stem / product name, e.g. `tuios`. Empty matches any. */
  stem: string;
  /** The selected archive name, when the release supplied one. */
  archiveName?: string;
  /** Download URL for the selected archive. */
  downloadUrl?: string;
  /** Detected archive format (`tar.gz`, `zip` or `raw`). */
  format: string;
  /** Whether a matching archive was found. */
  supported: boolean;
}

/** The parts parsed from an asset file name by {@link parseAssetName}. */
export interface ParsedAsset {
  /** Product name, including any flavor suffix, when the pattern captures it. */
  stem: string;
  /** Bare version (no `v`). */
  version: string;
  /** Release OS token. */
  os: string;
  /** Release architecture token. */
  arch: string;
  /** Archive extension without the leading dot, when captured. */
  ext: string;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** The `releases/latest` API URL for a GitHub `owner/name` repository. */
export function releasesApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** The `releases/tags/<tag>` API URL for a GitHub `owner/name` repository. */
export function releaseByTagApiUrl(repo: string, version: string): string {
  return `https://api.github.com/repos/${repo}/releases/tags/v${
    normalizeVersion(version)
  }`;
}

/**
 * Resolve the releases API URL: an explicit `apiUrl` wins, otherwise it is
 * derived from `repo`. This wires the `repo` global so changing it (without
 * also setting `apiUrl`) points the model at that repository.
 */
export function resolveApiUrl(repo: string, apiUrl: string): string {
  const explicit = apiUrl.trim();
  if (explicit) return explicit;
  const slug = repo.trim();
  if (!slug) {
    throw new Error(
      "repo is empty: set the `repo` global (owner/name) or an explicit `apiUrl`.",
    );
  }
  return releasesApiUrl(slug);
}

/**
 * Rewrite a releases API URL into the URL for a specific tag. A URL ending in
 * `/latest` is rewritten in place; any other URL (a custom GitHub Enterprise
 * base, say) gets the `/tags/v<version>` suffix appended, so a pinned version
 * is honoured even when `apiUrl` was supplied explicitly.
 */
export function apiUrlForVersion(apiUrl: string, version: string): string {
  const tag = `v${normalizeVersion(version)}`;
  if (/\/latest\/?$/.test(apiUrl)) {
    return apiUrl.replace(/\/latest\/?$/, `/tags/${tag}`);
  }
  return `${apiUrl.replace(/\/+$/, "")}/tags/${tag}`;
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
// Asset names
// ---------------------------------------------------------------------------

/**
 * Compile an asset-name pattern, asserting it has the named groups the model
 * needs. Fails loudly on an invalid regex or a missing group rather than
 * silently selecting nothing.
 */
export function compileAssetPattern(pattern: string): RegExp {
  let re: RegExp;
  try {
    re = new RegExp(pattern.trim() || DEFAULT_ASSET_PATTERN);
  } catch (err) {
    throw new Error(
      `assetPattern is not a valid regular expression: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  for (const group of ["version", "os", "arch"]) {
    if (!re.source.includes(`?<${group}>`)) {
      throw new Error(
        `assetPattern must define a named group (?<${group}>…); got ${pattern}`,
      );
    }
  }
  return re;
}

/**
 * Parse an asset file name with a pattern, or `null` when it does not match.
 * `checksums.txt` and other non-archive assets deliberately do not match the
 * default pattern.
 */
export function parseAssetName(
  name: string,
  pattern: string = DEFAULT_ASSET_PATTERN,
): ParsedAsset | null {
  const match = compileAssetPattern(pattern).exec(name);
  if (!match) return null;
  const groups = match.groups ?? {};
  return {
    stem: groups.stem ?? "",
    version: normalizeVersion(groups.version ?? ""),
    os: groups.os ?? "",
    arch: groups.arch ?? "",
    ext: groups.ext ?? "",
  };
}

/**
 * Detect the archive format of an asset from its file name, falling back to
 * `raw` for a bare binary and honouring an explicit `requested` type.
 */
export function detectArchiveType(
  name: string,
  requested: ArchiveType = "auto",
): ArchiveType {
  if (requested !== "auto") return requested;
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".gz")) return "tar.gz";
  return "raw";
}

/**
 * Pick the archive for a platform from a release's asset list.
 *
 * An exact `assetName` wins outright. Otherwise every asset whose name parses
 * is filtered by `os`, `arch` and `stem` (each ignored when empty), and the
 * first survivor is returned. Returns `null` when nothing matches.
 */
export function selectAsset(
  assets: ReleaseAsset[],
  opts: {
    assetName?: string;
    pattern?: string;
    os?: string;
    arch?: string;
    stem?: string;
    format?: ArchiveType;
  },
): ReleaseAsset | null {
  const wanted = (opts.assetName ?? "").trim();
  if (wanted) {
    return assets.find((a) => a.name === wanted) ?? null;
  }
  const pattern = opts.pattern ?? DEFAULT_ASSET_PATTERN;
  const os = (opts.os ?? "").trim();
  const arch = (opts.arch ?? "").trim();
  const stem = (opts.stem ?? "").trim();
  const format = opts.format ?? "auto";
  for (const asset of assets) {
    const parsed = parseAssetName(asset.name, pattern);
    if (!parsed) continue;
    if (os && parsed.os !== os) continue;
    if (arch && parsed.arch !== arch) continue;
    if (stem && parsed.stem !== stem) continue;
    if (format !== "auto" && detectArchiveType(asset.name, "auto") !== format) {
      continue;
    }
    return asset;
  }
  return null;
}

/**
 * Parse a raw GitHub release payload into the flat release shape the model
 * stores — the tag, version, title, publication time, prerelease flag, HTML
 * URL, notes body and the parsed assets. `checksums.txt` and other non-archive
 * assets are kept; only archive assets carry a parsed `version`.
 */
export function parseReleasePayload(
  payload: Record<string, unknown>,
  pattern: string = DEFAULT_ASSET_PATTERN,
): ReleaseInfo {
  if (
    payload === null || typeof payload !== "object" || Array.isArray(payload)
  ) {
    throw new Error(
      "GitHub releases response is not a release object — check the apiUrl " +
        "(a releases *list* endpoint returns an array of releases).",
    );
  }
  const tag = String(payload.tag_name ?? "");
  if (!tag) {
    throw new Error(
      "GitHub releases response has no tag_name — check the apiUrl points " +
        "at a single release (…/releases/latest or …/releases/tags/<tag>).",
    );
  }
  return {
    tag,
    version: normalizeVersion(tag),
    name: String(payload.name ?? tag),
    publishedAt: String(payload.published_at ?? ""),
    prerelease: Boolean(payload.prerelease),
    htmlUrl: String(payload.html_url ?? ""),
    body: typeof payload.body === "string" ? payload.body : undefined,
    assets: mapAssets(payload.assets, pattern),
    payload,
  };
}

/** Options for {@link renderReleaseMarkdown}. */
export interface RenderOptions {
  /** Include the release notes body. */
  includeBody?: boolean;
  /** Include the asset table. */
  includeAssets?: boolean;
  /** Truncate the body to this many characters; 0 (default) keeps it whole. */
  maxBodyChars?: number;
}

/**
 * Render a stored release — including the preserved raw payload — into a
 * Markdown document a human can read: the title, version, publication time,
 * prerelease flag, HTML URL, release notes and an asset table. The payload is
 * the source of truth for the notes and URL, so a release whose summary fields
 * were dropped is still rendered faithfully from the raw data.
 */
export function renderReleaseMarkdown(
  release: {
    tag?: string | null;
    version?: string | null;
    name?: string | null;
    publishedAt?: string | null;
    prerelease?: boolean | null;
    htmlUrl?: string | null;
    body?: string | null;
    assets?: ReleaseAsset[];
    payload?: Record<string, unknown> | null;
  },
  opts: RenderOptions = {},
): string {
  const payload = release.payload ?? {};
  const tag = release.tag ?? String(payload.tag_name ?? "");
  const name = release.name ?? String(payload.name ?? tag) ?? "";
  const version = release.version ?? normalizeVersion(tag);
  const publishedAt = release.publishedAt ??
    String(payload.published_at ?? "");
  const htmlUrl = release.htmlUrl ?? String(payload.html_url ?? "");
  const prerelease = release.prerelease ?? Boolean(payload.prerelease);
  const body = release.body ??
    (typeof payload.body === "string" ? payload.body : "");
  const assets = release.assets ?? [];

  const heading = name || version || tag || "release";
  const lines: string[] = [`# ${heading}`];

  const facts: string[] = [];
  if (version) facts.push(`Version: ${version}`);
  if (tag) facts.push(`Tag: ${tag}`);
  if (publishedAt) facts.push(`Published: ${publishedAt}`);
  if (prerelease) facts.push("Prerelease: yes");
  if (htmlUrl) facts.push(`Release page: ${htmlUrl}`);
  if (facts.length) {
    lines.push("", ...facts.map((f) => `- ${f}`));
  }

  if (opts.includeBody !== false && body.trim()) {
    let text = body.trim();
    const max = opts.maxBodyChars ?? 0;
    if (max > 0 && text.length > max) {
      text = `${text.slice(0, max)}\n\n… (${
        text.length - max
      } more characters)`;
    }
    lines.push("", "## Release notes", "", text);
  }

  if (opts.includeAssets !== false && assets.length) {
    lines.push(
      "",
      "## Assets",
      "",
      "| Asset | Size (bytes) |",
      "| --- | --- |",
    );
    for (const asset of assets) {
      lines.push(
        `| ${asset.name} | ${asset.size !== undefined ? asset.size : ""} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Map the GitHub API's asset array into the flat shape the model stores:
 * `name`, `browser_download_url` and `size`, plus the version parsed from the
 * archive name. Non-archive assets (e.g. `checksums.txt`) are kept with no
 * parsed version.
 */
export function mapAssets(
  raw: unknown,
  pattern: string = DEFAULT_ASSET_PATTERN,
): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const assets: ReleaseAsset[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "");
    const url = String(record.browser_download_url ?? "");
    if (!name || !url) continue;
    const parsed = parseAssetName(name, pattern);
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
 * The URL for a release's checksums file: an explicit `checksumsUrl` global
 * wins, then the `checksums.txt` asset when present, then a sibling-derived URL
 * (the same directory as any other asset). Returns `null` when nothing is
 * available.
 */
export function checksumsUrlFor(
  assets: ReleaseAsset[],
  name: string = CHECKSUMS_NAME,
  explicit = "",
): string | null {
  const override = explicit.trim();
  if (override) return override;
  const direct = assets.find((a) => a.name === name);
  if (direct) return direct.url;
  const sibling = assets[0];
  if (!sibling) return null;
  const base = sibling.url.replace(/\/[^/]+$/, "");
  return base ? `${base}/${name}` : null;
}

/**
 * Parse a `checksums.txt` body into a `name → sha256` map. Lines it cannot
 * parse are skipped, so an extra comment or blank line never fails a verify.
 * Both `sha256sum` (`<hash>  <name>`) and `<hash> *<name>` forms are accepted.
 */
export function parseChecksums(text: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
}

// ---------------------------------------------------------------------------
// GitHub release fetch (network)
// ---------------------------------------------------------------------------

/** Options for the release and checksum fetches. */
export interface FetchOptions {
  /** Releases API URL. */
  apiUrl: string;
  /** `User-Agent` header, required by the GitHub API. */
  userAgent: string;
  /** Optional GitHub token, sent as a bearer token when set. */
  token?: string;
}

/**
 * A fetched release: the flat parsed fields the model stores, plus the raw
 * payload for callers that need a field this shape does not carry.
 */
export interface FetchedRelease extends ReleaseInfo {
  /** The raw GitHub API payload. */
  payload: Record<string, unknown>;
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

/**
 * Resolve the GitHub token for a run: the explicit global wins, else the
 * `GITHUB_TOKEN` or `GH_TOKEN` environment variable, else none.
 */
export function resolveToken(explicit?: string): string | undefined {
  const value = (explicit ?? "").trim() ||
    (Deno.env.get("GITHUB_TOKEN") ?? "").trim() ||
    (Deno.env.get("GH_TOKEN") ?? "").trim();
  return value || undefined;
}

/**
 * Fetch a release from the GitHub releases API. Shared by `check` and
 * `download` so both resolve assets and versions identically.
 */
export async function fetchRelease(
  opts: FetchOptions,
  assetPattern: string = DEFAULT_ASSET_PATTERN,
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
        "`githubToken` global (or the GITHUB_TOKEN env var) to raise it"
      : "";
    throw new Error(
      `GitHub releases request failed: ${response.status} ${response.statusText} (${opts.apiUrl})` +
        (body ? ` — ${body.slice(0, 200)}` : "") + hint,
    );
  }
  const payload = await response.json() as Record<string, unknown>;
  return { ...parseReleasePayload(payload, assetPattern), payload };
}

/** The result of fetching a release's checksums file. */
export interface ChecksumsResult {
  /** Whether the checksums file was fetched successfully. */
  available: boolean;
  /** The parsed `name → sha256` map (empty when unavailable or unlisted). */
  sums: Record<string, string>;
}

/**
 * Download a release's checksums file and return the `name → sha256` map,
 * reporting whether the file itself was reachable. A network or HTTP failure
 * returns `available: false`, letting the caller distinguish "the checksums
 * file could not be fetched" from "the checksums file lists no entry for this
 * archive" — the two need different messages. On success `available` is true
 * and `sums` holds whatever the file listed.
 */
export async function fetchChecksums(
  url: string,
  userAgent: string,
  token?: string,
): Promise<ChecksumsResult> {
  try {
    const response = await fetch(url, {
      headers: githubHeaders(userAgent, "text/plain", token),
    });
    if (!response.ok) return { available: false, sums: {} };
    return { available: true, sums: parseChecksums(await response.text()) };
  } catch {
    return { available: false, sums: {} };
  }
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/**
 * Map `uname -s` output to a release OS token. The GoReleaser default is
 * capitalised (`Linux`, `Darwin`, …); publishers that differ override the OS
 * token explicitly with the `os` global.
 */
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

/** Map `uname -m` output to a release architecture token, or `unknown`. */
export function mapUnameArch(uname: string): string {
  const a = uname.trim().toLowerCase();
  if (a === "x86_64" || a === "amd64") return "x86_64";
  if (a === "arm64" || a === "aarch64") return "arm64";
  if (a === "armv7l" || a === "armv7" || a === "armhf") return "armv7";
  if (a === "armv6l" || a === "armv6") return "armv6";
  if (a === "i386" || a === "i686") return "i386";
  return "unknown";
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

/**
 * Resolve the platform OS/arch for a run from explicit overrides, falling back
 * to a host probe for whichever value is empty.
 */
export async function resolveOsArch(
  os: string,
  arch: string,
): Promise<{ os: string; arch: string }> {
  const o = os.trim();
  const a = arch.trim();
  return {
    os: o || mapUnameOs(await uname("-s")),
    arch: a || mapUnameArch(await uname("-m")),
  };
}

// ---------------------------------------------------------------------------
// Download + checksum
// ---------------------------------------------------------------------------

/** SHA-256 of a byte array as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare downloaded bytes against the expected SHA-256. Returns `true` when
 * `expected` is empty (nothing to verify), so a missing checksums entry
 * degrades to "unverified" rather than failing.
 */
export async function verifySha256(
  bytes: Uint8Array,
  expected: string,
): Promise<boolean> {
  if (!expected) return true;
  return (await sha256Hex(bytes)) === expected.toLowerCase();
}

/** A downloaded archive held in memory, with its verification result. */
export interface DownloadedArchive {
  /** The raw archive bytes. */
  bytes: Uint8Array;
  /** The SHA-256 computed over the downloaded bytes. */
  sha256: string;
  /** Whether the bytes matched the expected checksum. */
  checksumVerified: boolean;
}

/**
 * Download an asset, compute its SHA-256, and verify it against `expected`.
 * Throws when the download fails or the checksum does not match — an
 * unverified download is never returned.
 */
export async function downloadAndVerify(
  url: string,
  userAgent: string,
  expected: string,
  token?: string,
): Promise<DownloadedArchive> {
  const response = await fetch(url, {
    headers: githubHeaders(userAgent, "application/octet-stream", token),
  });
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText} (${url})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  if (expected && sha256 !== expected.toLowerCase()) {
    throw new Error(
      `Checksum mismatch: the download does not match the expected SHA-256 ` +
        `(expected ${expected}, got ${sha256}).`,
    );
  }
  return { bytes, sha256, checksumVerified: expected !== "" };
}
