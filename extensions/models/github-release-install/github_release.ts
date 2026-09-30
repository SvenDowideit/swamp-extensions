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

/**
 * The hash algorithms recognised in a checksums file (or a GitHub per-asset
 * `digest`), keyed by digest length in hex characters. `sha512` (128) covers
 * projects such as caddy that publish SHA-512 only; `sha256` (64) is the
 * GoReleaser default.
 */
export const CHECKSUM_ALGORITHMS: Record<number, string> = {
  40: "sha1",
  64: "sha256",
  96: "sha384",
  128: "sha512",
};

/**
 * Operating-system tokens grouped into families of equivalent names, so a host
 * probe (`Linux`, from `uname`) matches a publisher that names its assets
 * differently (`linux`, as caddy does). A token absent from every family is
 * only matched by an equal token.
 */
export const OS_FAMILIES: Record<string, readonly string[]> = {
  linux: ["linux", "linux-gnu", "linux-musl"],
  darwin: ["darwin", "macos", "macosx", "osx", "apple"],
  windows: ["windows", "win", "win32", "win64", "mingw", "msys", "cygwin"],
  freebsd: ["freebsd"],
  openbsd: ["openbsd"],
  netbsd: ["netbsd"],
  dragonfly: ["dragonfly"],
};

/**
 * Architecture tokens grouped into families of equivalent names, so a host
 * probe (`x86_64`, from `uname -m`) matches a publisher that names its assets
 * `amd64` (caddy, gh) or `x64`.
 */
export const ARCH_FAMILIES: Record<string, readonly string[]> = {
  x86_64: ["x86_64", "x86-64", "amd64", "x64"],
  arm64: ["arm64", "aarch64", "armv8"],
  armv7: ["armv7", "armv7l", "armhf", "arm"],
  armv6: ["armv6", "armv6l"],
  i386: ["i386", "i686", "386", "x86", "ia32"],
  riscv64: ["riscv64"],
  ppc64le: ["ppc64le", "ppc64"],
  s390x: ["s390x"],
  mips: ["mips", "mipsle"],
  mips64: ["mips64", "mips64le"],
};

/** The family a token belongs to, or the lowercased token when ungrouped. */
function familyOf(
  families: Record<string, readonly string[]>,
  token: string,
): string {
  const t = token.trim().toLowerCase();
  for (const [family, members] of Object.entries(families)) {
    if (members.includes(t)) return family;
  }
  return t;
}

/** Whether two OS tokens name the same OS family (case-insensitively). */
export function sameOs(a: string, b: string): boolean {
  if (!a || !b) return false;
  return familyOf(OS_FAMILIES, a) === familyOf(OS_FAMILIES, b);
}

/** Whether two architecture tokens name the same architecture family. */
export function sameArch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return familyOf(ARCH_FAMILIES, a) === familyOf(ARCH_FAMILIES, b);
}

// ---------------------------------------------------------------------------
// Zod schemas shared by the model
// ---------------------------------------------------------------------------

const ReleaseAssetSchema = z.object({
  name: z.string(),
  url: z.string(),
  size: z.number().optional(),
  version: z.string().optional(),
  digest: z.string().optional(),
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
    /**
     * Every archive that matched this platform, in preference order. More than
     * one means the release ships variants (e.g. a main build plus a web or
     * ghostty build); `archiveName` is the chosen "main" one.
     */
    candidates: z.array(z.string()).optional(),
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
  /**
   * Per-asset digest from the GitHub API, e.g. `sha256:abc…`. Some releases
   * publish no `checksums.txt` (opencode) but the API still carries this.
   */
  digest?: string;
}

/**
 * The digest portion of a GitHub API per-asset `digest` field (`sha256:abc…`),
 * lowercased hex, or `null` when absent or in an unrecognised form. Only the
 * algorithms this extension verifies are accepted.
 */
export function digestFromAsset(asset: ReleaseAsset): string | null {
  const raw = (asset.digest ?? "").trim().toLowerCase();
  const match = raw.match(/^([a-z0-9]+):([0-9a-f]+)$/);
  if (!match) return null;
  if (!CHECKSUM_ALGORITHMS[match[2].length]) return null;
  return match[2];
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
  /**
   * Every archive that matched the platform, in preference order. More than one
   * means the release ships variants; `archiveName` is the chosen main one.
   */
  candidates?: string[];
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
 *
 * `version` is **optional**: some publishers (opencode) do not put the version
 * in the asset name (the release tag carries it), so a pattern may omit the
 * group. `os` and `arch` remain required.
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
  for (const group of ["os", "arch"]) {
    if (!re.source.includes(`?<${group}>`)) {
      throw new Error(
        `assetPattern must define a named group (?<${group}>…); got ${pattern}`,
      );
    }
  }
  return re;
}

/**
 * A pattern for releases whose assets carry **no version** — the OS/arch after
 * the stem and before the extension, e.g. `opencode-linux-x64.tar.gz` or
 * `tool-darwin-arm64.zip`. `stem` is non-greedy so the last `-<os>-<arch>`
 * wins; the version is taken from the release tag instead.
 */
export const NO_VERSION_ASSET_PATTERN =
  "^(?<stem>[^/]+?)[-_](?<os>[A-Za-z0-9]+)[-_](?<arch>[A-Za-z0-9_]+?)(?:\\.(?<ext>tar\\.gz|tgz|zip|gz|exe|bin))?$";

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

/** Options for {@link selectAssets}. */
export interface SelectOptions {
  /** Exact asset file name — wins outright over every other filter. */
  assetName?: string;
  /** Asset-name pattern to parse with. */
  pattern?: string;
  /** Required OS token (any family equivalent matches). */
  os?: string;
  /** Required architecture token (any family equivalent matches). */
  arch?: string;
  /** Required asset stem / product name (exact, never family-matched). */
  stem?: string;
  /** Required archive format; `auto` matches any. */
  format?: ArchiveType;
  /**
   * Repository `owner/name` — used to prefer the base archive when several
   * stems match (its last segment, e.g. `tuios`, beats `tuios-ghostty`).
   */
  repo?: string;
}

/** The result of selecting an archive: the winner and every valid candidate. */
export interface AssetSelection {
  /** The chosen archive, or `null` when nothing matched. */
  selected: ReleaseAsset | null;
  /**
   * Every asset that matched the platform filters, in preference order. When
   * `selected` is `null` this is empty; when it has more than one entry the
   * platform has multiple valid archives (e.g. a main build plus variants).
   */
  candidates: ReleaseAsset[];
}

/**
 * Find every archive matching the platform filters, ordered by preference.
 *
 * An exact `assetName` wins outright and is the only candidate. Otherwise each
 * parsed asset is filtered by `os`, `arch` and `stem` (ignored when empty) and
 * by `format` (when concrete). OS/arch match by **family**, so a host probe of
 * `Linux`/`x86_64` matches a publisher that names assets `linux`/`amd64`
 * (caddy); an exact-token match is preferred over a family match. The `stem`
 * filter is always exact, so `tuios` never matches `tuios-ghostty`.
 *
 * Candidates are then ordered so the "main" build wins: a stem equal to the
 * repository name is preferred, then the shortest stem, then the stem that is a
 * prefix of the others (a base name such as `tuios` beats `tuios-web`), then
 * alphabetically — deterministic regardless of the API's asset order.
 */
export function selectAssets(
  assets: ReleaseAsset[],
  opts: SelectOptions,
): AssetSelection {
  const wanted = (opts.assetName ?? "").trim();
  if (wanted) {
    const match = assets.find((a) => a.name === wanted);
    return { selected: match ?? null, candidates: match ? [match] : [] };
  }

  const pattern = opts.pattern ?? DEFAULT_ASSET_PATTERN;
  const os = (opts.os ?? "").trim();
  const arch = (opts.arch ?? "").trim();
  const stem = (opts.stem ?? "").trim();
  const format = opts.format ?? "auto";
  const repoName = (opts.repo ?? "").trim().split("/").pop()?.toLowerCase() ??
    "";

  const scored: { asset: ReleaseAsset; parsed: ParsedAsset; exact: number }[] =
    [];
  for (const asset of assets) {
    const parsed = parseAssetName(asset.name, pattern);
    if (!parsed) continue;
    if (os && !sameOs(parsed.os, os)) continue;
    if (arch && !sameArch(parsed.arch, arch)) continue;
    if (stem && parsed.stem !== stem) continue;
    if (format !== "auto" && detectArchiveType(asset.name, "auto") !== format) {
      continue;
    }
    const exact = (os && parsed.os === os ? 1 : 0) +
      (arch && parsed.arch === arch ? 1 : 0);
    scored.push({ asset, parsed, exact });
  }

  scored.sort((a, b) => {
    // Exact-token matches before family-only matches.
    if (a.exact !== b.exact) return b.exact - a.exact;
    // The repository's own name is the main build.
    const aRepo = repoName && a.parsed.stem.toLowerCase() === repoName ? 1 : 0;
    const bRepo = repoName && b.parsed.stem.toLowerCase() === repoName ? 1 : 0;
    if (aRepo !== bRepo) return bRepo - aRepo;
    // A shorter stem is more likely the base build (`tuios` < `tuios-web`).
    if (a.parsed.stem.length !== b.parsed.stem.length) {
      return a.parsed.stem.length - b.parsed.stem.length;
    }
    return a.parsed.stem.localeCompare(b.parsed.stem);
  });

  const candidates = scored.map((s) => s.asset);
  return { selected: candidates[0] ?? null, candidates };
}

/** Pick the single best archive for a platform, or `null` when none match. */
export function selectAsset(
  assets: ReleaseAsset[],
  opts: SelectOptions,
): ReleaseAsset | null {
  return selectAssets(assets, opts).selected;
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
      digest: typeof record.digest === "string" ? record.digest : undefined,
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
  // An exact-name match first (the GoReleaser default `checksums.txt`).
  const direct = assets.find((a) => a.name === name);
  if (direct) return direct.url;
  // Then any checksums file, so a version-prefixed name (caddy's
  // `caddy_2.11.4_checksums.txt`) is found without a per-version global. A
  // `.sig`/`.pem`/`.sbom` sidecar of the checksums file is skipped.
  const base = name.replace(/\.[^.]+$/, "").toLowerCase();
  const suffixed = assets.find((a) => {
    const lower = a.name.toLowerCase();
    return lower.endsWith(`${base}.txt`) ||
      (lower.includes(base) && lower.endsWith(".txt") &&
        !/\.(sig|pem|sbom|asc)$/.test(lower));
  });
  if (suffixed) return suffixed.url;
  // Finally derive it from a sibling asset's directory.
  const sibling = assets[0];
  if (!sibling) return null;
  const dir = sibling.url.replace(/\/[^/]+$/, "");
  return dir ? `${dir}/${name}` : null;
}

/** A checksums file parsed into per-asset digests plus their algorithm. */
export interface ParsedChecksums {
  /** `name → hex digest` for every parseable line. */
  sums: Record<string, string>;
  /**
   * The algorithm of the digests found (e.g. `sha256`, `sha512`), or `null`
   * when the file held no parseable line.
   */
  algorithm: string | null;
}

/**
 * Parse a `checksums.txt` body into a digest map, detecting the hash algorithm
 * from the digest lengths. Lines it cannot parse (comments, blanks, `.sig` /
 * `.pem` sidecars that carry no digest) are skipped, so an extra line never
 * fails a verify. Both `sha256sum` (`<hash>  <name>`) and `<hash> *<name>`
 * forms are accepted, and digest lengths of 40/64/96/128 hex are recognised as
 * SHA-1/256/384/512.
 */
export function parseChecksumsDetailed(text: string): ParsedChecksums {
  const sums: Record<string, string> = {};
  const lengths = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{40,128})\s+\*?(.+)$/);
    if (!match) continue;
    const digest = match[1].toLowerCase();
    if (!CHECKSUM_ALGORITHMS[digest.length]) continue;
    sums[match[2]] = digest;
    lengths.add(digest.length);
  }
  // Report the strongest algorithm present (a file mixing lengths is unusual).
  const strongest = [...lengths].sort((a, b) => b - a)[0];
  return {
    sums,
    algorithm: strongest ? CHECKSUM_ALGORITHMS[strongest] : null,
  };
}

/**
 * Parse a `checksums.txt` body into a `name → digest` map (any recognised
 * algorithm). Prefer {@link parseChecksumsDetailed} when the algorithm matters.
 */
export function parseChecksums(text: string): Record<string, string> {
  return parseChecksumsDetailed(text).sums;
}

/** The WebCrypto algorithm name for a digest's hex length, or `null`. */
export function webCryptoAlgorithm(hexLength: number): string | null {
  switch (CHECKSUM_ALGORITHMS[hexLength]) {
    case "sha1":
      return "SHA-1";
    case "sha256":
      return "SHA-256";
    case "sha384":
      return "SHA-384";
    case "sha512":
      return "SHA-512";
    default:
      return null;
  }
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

/** A command runner returning decoded stdout/stderr and the exit code. */
export type CommandRunner = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Run a command, capturing stdout/stderr; a missing binary is code 127. */
export async function runCmd(
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

/** Where a resolved token came from — reported to the user, never the value. */
export type TokenSource =
  | "githubToken"
  | "GITHUB_TOKEN"
  | "GH_TOKEN"
  | "gh-cli"
  | "anonymous";

/** A resolved credential: the token (or none) and its source. */
export interface ResolvedToken {
  /** The bearer token, or `undefined` for anonymous access. */
  token?: string;
  /** Which source supplied the token. */
  source: TokenSource;
}

/**
 * Resolve a GitHub token from the local `gh` CLI (`gh auth token`). Returns
 * `undefined` when `gh` is absent or not authenticated. Memoized per process so
 * repeated method calls do not respawn `gh`; pass `fresh` to bypass the cache.
 *
 * Reads the local keyring only — no network request, so it costs nothing
 * against the API rate limit.
 */
let ghTokenCache: string | undefined;
let ghTokenLoaded = false;
export async function ghAuthToken(
  runner: CommandRunner = runCmd,
  fresh = false,
): Promise<string | undefined> {
  if (!fresh && ghTokenLoaded) return ghTokenCache;
  const result = await runner("gh", ["auth", "token"]);
  const token = result.code === 0 ? result.stdout.trim() : "";
  ghTokenCache = token || undefined;
  ghTokenLoaded = true;
  return ghTokenCache;
}

/** Clear the memoized `gh auth token` result (used by tests). */
export function resetGhTokenCache(): void {
  ghTokenCache = undefined;
  ghTokenLoaded = false;
}

/**
 * Resolve the GitHub token for a run, in precedence order:
 *
 *   1. the explicit `githubToken` global (or `--input`);
 *   2. the `GITHUB_TOKEN` environment variable;
 *   3. the `GH_TOKEN` environment variable;
 *   4. the local `gh` CLI (`gh auth token`), when installed and logged in.
 *
 * Returning the source lets the caller tell the user where the token came from
 * (or that the request will be anonymous) without ever printing the value.
 * `env` and `runner` are injectable for testing.
 */
export async function resolveToken(
  explicit?: string,
  opts: { env?: (key: string) => string | undefined; runner?: CommandRunner } =
    {},
): Promise<ResolvedToken> {
  const env = opts.env ?? ((k: string) => Deno.env.get(k));
  const explicitValue = (explicit ?? "").trim();
  if (explicitValue) return { token: explicitValue, source: "githubToken" };
  const githubToken = (env("GITHUB_TOKEN") ?? "").trim();
  if (githubToken) return { token: githubToken, source: "GITHUB_TOKEN" };
  const ghToken = (env("GH_TOKEN") ?? "").trim();
  if (ghToken) return { token: ghToken, source: "GH_TOKEN" };
  const fromCli = await ghAuthToken(opts.runner);
  if (fromCli) return { token: fromCli, source: "gh-cli" };
  return { source: "anonymous" };
}

/** The exact shell commands that authenticate future runs. */
export function authSetupHint(): string {
  return "Authenticate the GitHub CLI with `gh auth login` — its token is " +
    "then used automatically — or set one explicitly with " +
    "`export GITHUB_TOKEN=$(gh auth token)`.";
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
    const rateLimited = response.status === 429 ||
      (response.status === 403 && /rate limit|secondary rate/i.test(body));
    const unauthenticated = !opts.token;
    const hint = rateLimited && unauthenticated
      ? ` — GitHub's unauthenticated API limit is 60 requests/hour. ${authSetupHint()}`
      : response.status === 401
      ? ` — the token was rejected. ${authSetupHint()}`
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
  /** The parsed `name → digest` map (empty when unavailable or unlisted). */
  sums: Record<string, string>;
  /** The digest algorithm found (e.g. `sha256`, `sha512`), or `null`. */
  algorithm: string | null;
}

/**
 * Download a release's checksums file and return the `name → digest` map,
 * reporting whether the file itself was reachable and which algorithm it used.
 * A network or HTTP failure returns `available: false`, letting the caller
 * distinguish "the checksums file could not be fetched" from "the checksums
 * file lists no entry for this archive" — the two need different messages.
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
    if (!response.ok) return { available: false, sums: {}, algorithm: null };
    const parsed = parseChecksumsDetailed(await response.text());
    return {
      available: true,
      sums: parsed.sums,
      algorithm: parsed.algorithm,
    };
  } catch {
    return { available: false, sums: {}, algorithm: null };
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
  return await digestHex(bytes, "SHA-256");
}

/** Compute a digest of a byte array with the named WebCrypto algorithm. */
export async function digestHex(
  bytes: Uint8Array,
  algorithm: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    algorithm,
    new Uint8Array(bytes),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A verified digest: its value and the algorithm that produced it. */
export interface DigestResult {
  /** The computed digest, lowercase hex. */
  hex: string;
  /** The algorithm used, e.g. `sha256` or `sha512`. */
  algorithm: string;
  /** Whether the digest matched the expected value (true when none expected). */
  verified: boolean;
}

/**
 * Compute the digest of `bytes` using the algorithm implied by the expected
 * digest's length (SHA-256 by default), and compare it. Returns the computed
 * digest and whether it matched. An empty `expected` is treated as "nothing to
 * verify" and reports `verified: true`, so a missing checksums entry degrades
 * to "unverified" rather than failing.
 */
export async function verifyChecksum(
  bytes: Uint8Array,
  expected: string,
): Promise<DigestResult> {
  const want = expected.trim().toLowerCase();
  const algorithm = (want ? CHECKSUM_ALGORITHMS[want.length] : null) ??
    "sha256";
  const webAlgo = webCryptoAlgorithm(want.length) ?? "SHA-256";
  const hex = await digestHex(bytes, webAlgo);
  return { hex, algorithm, verified: !want || hex === want };
}

/**
 * Compare downloaded bytes against the expected digest, choosing the algorithm
 * from the digest's length. Returns `true` when `expected` is empty.
 */
export async function verifySha256(
  bytes: Uint8Array,
  expected: string,
): Promise<boolean> {
  return (await verifyChecksum(bytes, expected)).verified;
}

/** A downloaded archive held in memory, with its verification result. */
export interface DownloadedArchive {
  /** The raw archive bytes. */
  bytes: Uint8Array;
  /** The digest computed over the downloaded bytes, lowercase hex. */
  sha256: string;
  /** The digest algorithm used, e.g. `sha256` or `sha512`. */
  algorithm: string;
  /** Whether the bytes matched the expected checksum. */
  checksumVerified: boolean;
}

/**
 * Download an asset, compute its digest (choosing the algorithm from the
 * expected checksum's length), and verify it. Throws when the download fails or
 * the checksum does not match — an unverified download is never returned.
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
  const { hex, algorithm, verified } = await verifyChecksum(bytes, expected);
  if (!verified) {
    throw new Error(
      `Checksum mismatch: the download does not match the expected ` +
        `${algorithm} digest (expected ${expected}, got ${hex}).`,
    );
  }
  return {
    bytes,
    sha256: hex,
    algorithm,
    checksumVerified: expected.trim() !== "",
  };
}
