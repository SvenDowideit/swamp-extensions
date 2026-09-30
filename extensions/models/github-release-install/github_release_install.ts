/**
 * GitHub release installer — resolve a repository's latest (or pinned) release,
 * select the archive for this machine, verify it against the release's
 * checksums, and produce a verified archive on disk.
 *
 * This is the reusable "fetch a GitHub release" primitive. Any repository that
 * publishes GoReleaser-style release assets — `tuios_0.8.0_Linux_x86_64.tar.gz`
 * and the like — can be resolved, matched to the local OS/architecture, checked
 * against `checksums.txt`, and downloaded with a single model. TUIOS
 * (`@svendowideit/tuios`) is one consumer; `@swamp/deno-runner`'s approach to
 * checksum-verified binary downloads is the same pattern, generalised here to
 * any repo, any release and the tar.gz / zip / raw archive formats.
 *
 * Methods:
 *   - `check`    — read the release (latest, or a pinned `version`), select the
 *                  platform archive, and record its expected SHA-256 from the
 *                  release's checksums. Writes the `release` resource; fetches
 *                  nothing heavy.
 *   - `download` — download and checksum-verify the archive, optionally writing
 *                  it to `outputPath` and returning the path. Writes the
 *                  `archive` resource.
 *   - `print`    — log the stored release and archive. Writes `summary`.
 *
 * Every selector has a per-call override, so one model instance can resolve
 * "what would a Linux arm64 machine download?" without touching the host:
 * `--input os=Linux --input arch=arm64`.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  apiUrlForVersion,
  ARCHIVE_TYPES,
  type ArchiveType,
  CHECKSUMS_NAME,
  checksumsUrlFor,
  compileAssetPattern,
  DEFAULT_ASSET_PATTERN,
  detectArchiveType,
  downloadAndVerify,
  expandHome,
  fetchChecksums,
  fetchRelease,
  normalizeVersion,
  type Platform,
  renderReleaseMarkdown,
  resolveApiUrl,
  resolveOsArch,
  resolveToken,
  schemas,
  selectAssets,
  type SelectOptions,
  verifyChecksum,
} from "./github_release.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  repo: z.string().default("").describe(
    "GitHub repository (owner/name) publishing the releases, e.g. Gaurav-Gosain/tuios. Used to derive apiUrl when that is empty.",
  ),
  apiUrl: z.string().default("").describe(
    "GitHub releases API URL for the latest release. Empty derives it from repo (https://api.github.com/repos/<repo>/releases/latest).",
  ),
  userAgent: z.string().default("swamp-github-release/1.0").describe(
    "User-Agent header sent to the GitHub API and asset downloads.",
  ),
  githubToken: z.string().default("").meta({ sensitive: true }).describe(
    "GitHub token used to raise the API rate limit. Empty falls back to GITHUB_TOKEN or GH_TOKEN.",
  ),
  os: z.string().default("").describe(
    "Override the detected release OS token (e.g. Linux, Darwin). Empty probes the host with uname.",
  ),
  arch: z.string().default("").describe(
    "Override the detected release architecture token (e.g. x86_64, arm64). Empty probes the host with uname.",
  ),
  stem: z.string().default("").describe(
    "Required product name the asset file name must start with (e.g. 'tuios' or 'tuios-ghostty'). Empty matches any stem.",
  ),
  assetPattern: z.string().default(DEFAULT_ASSET_PATTERN).describe(
    "Regular expression an archive asset's file name must match. Must define named groups (?<version>…), (?<os>…) and (?<arch>…); (?<stem>…) and (?<ext>…) are optional.",
  ),
  checksumsName: z.string().default(CHECKSUMS_NAME).describe(
    "Name of the release asset listing every archive's SHA-256.",
  ),
  format: z.enum(ARCHIVE_TYPES).default("auto").describe(
    "Archive format: auto derives it from the file name; tar.gz, zip and raw force it.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CheckArgsSchema = z.object({
  version: z.string().default("").describe(
    "Release version to resolve (e.g. 0.8.0 or v0.8.0). Empty resolves the latest release.",
  ),
  os: z.string().optional().describe(
    "Override the release OS token for this call (e.g. Linux). Empty uses the model global / host probe.",
  ),
  arch: z.string().optional().describe(
    "Override the release architecture token for this call (e.g. arm64). Empty uses the model global / host probe.",
  ),
  stem: z.string().optional().describe(
    "Override the required asset stem for this call.",
  ),
  assetName: z.string().optional().describe(
    "Force an exact archive file name instead of selecting by platform.",
  ),
  pattern: z.string().optional().describe(
    "Override the model's assetPattern for this call.",
  ),
  fetchChecksums: z.boolean().default(true).describe(
    "Download the checksums file and record the selected archive's SHA-256. Set false to skip the extra request.",
  ),
  requireChecksum: z.boolean().default(true).describe(
    "Fail when the selected archive's SHA-256 cannot be resolved. Set false to record the release unverified.",
  ),
});

type CheckArgs = z.infer<typeof CheckArgsSchema>;

const DownloadArgsSchema = z.object({
  version: z.string().default("").describe(
    "Release version to download (e.g. 0.8.0). Empty downloads the latest release.",
  ),
  outputPath: z.string().default("").describe(
    "Exact absolute or ~-prefixed file path to write the verified archive to. Wins over outputDir. Empty (with outputDir empty too) downloads into memory only.",
  ),
  outputDir: z.string().default("").describe(
    "Directory to write the verified archive into, keeping the release's archive file name. Used when outputPath is empty.",
  ),
  assetName: z.string().default("").describe(
    "Force an exact archive file name to download, overriding platform selection. The bundled workflow supplies this from the release resource.",
  ),
  downloadUrl: z.string().default("").describe(
    "Archive URL resolved by `check`. When set with checksum and releaseVersion it avoids re-fetching the release.",
  ),
  releaseVersion: z.string().default("").describe(
    "The version `check` resolved, used to confirm downloadUrl matches the requested version.",
  ),
  checksum: z.string().default("").describe(
    "Expected SHA-256 of the archive, resolved by `check`. When set with the URL and archive name it avoids re-fetching the release. Download fails when the bytes do not match.",
  ),
  checksumsUrl: z.string().default("").describe(
    "Override the checksums file URL. Empty derives it from the release's assets.",
  ),
  os: z.string().optional().describe(
    "Override the release OS token for this call.",
  ),
  arch: z.string().optional().describe(
    "Override the release architecture token for this call.",
  ),
  stem: z.string().optional().describe(
    "Override the required asset stem for this call.",
  ),
  pattern: z.string().optional().describe(
    "Override the model's assetPattern for this call.",
  ),
  format: z.enum(ARCHIVE_TYPES).optional().describe(
    "Override the archive format for this call.",
  ),
  requireChecksum: z.boolean().default(true).describe(
    "Refuse to download when no SHA-256 can be resolved for the selected archive.",
  ),
  force: z.boolean().default(false).describe(
    "Re-download even when outputPath already holds a file with the expected SHA-256.",
  ),
});

type DownloadArgs = z.infer<typeof DownloadArgsSchema>;

const PrintArgsSchema = z.object({
  installedVersion: z.preprocess(
    (v) => v ?? "",
    z.string().default("").describe(
      "The currently installed version, used to report whether an update is available.",
    ),
  ),
});

type PrintArgs = z.infer<typeof PrintArgsSchema>;

const ReleaseResultSchema = schemas.releaseInfo.extend({
  fetchedAt: z.string(),
  sourceUrl: z.string(),
  platform: schemas.platform,
  checksumsUrl: z.string().nullable(),
  checksum: z.string().nullable(),
  checksumAlgorithm: z.string().nullable(),
});

const ArchiveResultSchema = z.object({
  downloaded: z.boolean(),
  cached: z.boolean(),
  version: z.string().nullable(),
  tag: z.string().nullable(),
  archiveName: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  checksum: z.string().nullable(),
  checksumAlgorithm: z.string().nullable(),
  sha256: z.string().nullable(),
  checksumVerified: z.boolean(),
  format: z.string().nullable(),
  path: z.string().nullable(),
  bytes: z.number().nullable(),
  platform: schemas.platform.nullable(),
  sourceUrl: z.string().nullable(),
  downloadedAt: z.string(),
  message: z.string(),
});

const PrintResultSchema = z.object({
  printed: z.boolean(),
  version: z.string().nullable(),
  tag: z.string().nullable(),
  platform: z.string().nullable(),
  archiveName: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  checksum: z.string().nullable(),
  archivePath: z.string().nullable(),
  installedVersion: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
  lines: z.array(z.string()),
});

const RenderArgsSchema = z.object({
  includeBody: z.boolean().default(true).describe(
    "Include the release notes body in the rendered Markdown.",
  ),
  includeAssets: z.boolean().default(true).describe(
    "Include the asset table in the rendered Markdown.",
  ),
  maxBodyChars: z.number().int().min(0).default(0).describe(
    "Truncate the release notes to this many characters. 0 keeps the full body.",
  ),
});

type RenderArgs = z.infer<typeof RenderArgsSchema>;

const RenderResultSchema = z.object({
  rendered: z.boolean(),
  version: z.string().nullable(),
  tag: z.string().nullable(),
  name: z.string().nullable(),
  publishedAt: z.string().nullable(),
  htmlUrl: z.string().nullable(),
  prerelease: z.boolean().nullable(),
  bodyChars: z.number(),
  assetCount: z.number(),
  markdown: z.string(),
  lines: z.array(z.string()),
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
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Resolve the effective platform: os/arch from overrides or the host probe. */
async function platformFor(
  args: { os?: string; arch?: string; stem?: string; pattern?: string },
  g: GlobalArgs,
): Promise<Platform> {
  const { os, arch } = await resolveOsArch(
    args.os ?? g.os,
    args.arch ?? g.arch,
  );
  return {
    os,
    arch,
    stem: (args.stem ?? g.stem).trim(),
    format: g.format,
    supported: os !== "UNKNOWN" && arch !== "unknown",
  };
}

/**
 * Select the archive for a platform from a release's assets and annotate the
 * platform with it. An exact `assetName` overrides platform matching and, when
 * found, forces that platform's format/os/arch to the asset's own parsed parts.
 */
function selectPlatformAsset(
  release: { assets: Parameters<typeof selectAssets>[0] },
  platform: Platform,
  opts: {
    assetName?: string;
    pattern?: string;
    format?: ArchiveType;
    repo?: string;
  },
): Platform {
  const requestedFormat = opts.format ??
    (platform.format as ArchiveType | undefined);
  const selectOpts: SelectOptions = {
    assetName: opts.assetName,
    pattern: opts.pattern,
    os: platform.os,
    arch: platform.arch,
    stem: platform.stem,
    format: requestedFormat,
    repo: opts.repo,
  };
  const { selected, candidates } = selectAssets(release.assets, selectOpts);
  if (!selected) return { ...platform, supported: false, candidates: [] };
  const format = detectArchiveType(
    selected.name,
    opts.format ?? (platform.format as ArchiveType),
  );
  return {
    ...platform,
    archiveName: selected.name,
    downloadUrl: selected.url,
    format,
    // Record every valid variant so a caller knows the release ships more than
    // one archive for this platform (e.g. tuios main + ghostty + web).
    candidates: candidates.map((a) => a.name),
    supported: true,
  };
}

/** Render the human-readable summary lines for `print`. */
export function formatSummary(
  release: {
    version?: string | null;
    tag?: string | null;
    name?: string | null;
    publishedAt?: string | null;
    platform?: Platform | null;
    checksum?: string | null;
    updateAvailable?: boolean | null;
  },
  archive: { path?: string | null } | null,
  installedVersion: string,
): string[] {
  const lines: string[] = [];
  lines.push(
    `Latest release: ${release.version ?? "unknown"}${
      release.tag ? ` (${release.tag})` : ""
    }`,
  );
  if (release.publishedAt) lines.push(`Published:      ${release.publishedAt}`);
  const p = release.platform;
  if (p) {
    lines.push(
      `This platform:  ${p.os}/${p.arch}${p.stem ? ` (${p.stem})` : ""} — ${
        p.supported ? "supported" : "no release archive"
      }`,
    );
    lines.push(`Archive:        ${p.archiveName ?? "none found"}`);
    if (p.downloadUrl) lines.push(`Download:       ${p.downloadUrl}`);
  }
  if (release.checksum) lines.push(`SHA-256:        ${release.checksum}`);
  if (archive?.path) lines.push(`Verified file:  ${archive.path}`);
  if (installedVersion) {
    lines.push(
      `Installed:      ${installedVersion}${
        release.updateAvailable ? " (update available)" : " (up to date)"
      }`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Resolves and downloads GitHub release archives for any repository. */
export const model = {
  type: "@svendowideit/github-release-install",
  version: "2026.09.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    release: {
      description:
        "The resolved release plus the archive selected for this platform",
      schema: ReleaseResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    archive: {
      description: "The verified archive download result",
      schema: ArchiveResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "The printed release/archive summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    document: {
      description:
        "The rendered Markdown release document (notes and asset table)",
      schema: RenderResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    check: {
      description:
        "Fetch a GitHub release (latest, or a pinned version), select the " +
        "archive for the local platform (or an explicit os/arch override) and " +
        "record its SHA-256 from the release's checksums file.",
      arguments: CheckArgsSchema,
      execute: async (
        args: CheckArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const pattern = args.pattern ?? g.assetPattern;
        compileAssetPattern(pattern);

        const apiUrl = args.version.trim()
          ? apiUrlForVersion(resolveApiUrl(g.repo, g.apiUrl), args.version)
          : resolveApiUrl(g.repo, g.apiUrl);
        const token = resolveToken(g.githubToken);

        context.logger.debug?.("GET {url}", { url: apiUrl });
        const release = await fetchRelease({
          apiUrl,
          userAgent: g.userAgent,
          token,
        }, pattern);

        const platform = await platformFor(args, g);
        const releasePlatform = selectPlatformAsset(release, platform, {
          assetName: args.assetName,
          pattern,
          repo: g.repo,
        });

        const checksumsUrl = args.fetchChecksums
          ? checksumsUrlFor(release.assets, g.checksumsName)
          : null;
        let checksum: string | null = null;
        let checksumAlgorithm: string | null = null;
        let checksumsAvailable = false;
        if (checksumsUrl && releasePlatform.archiveName) {
          const result = await fetchChecksums(
            checksumsUrl,
            g.userAgent,
            token,
          );
          checksumsAvailable = result.available;
          checksum = result.sums[releasePlatform.archiveName] ?? null;
          checksumAlgorithm = result.algorithm;
        }
        if (
          releasePlatform.archiveName && !checksum && args.fetchChecksums &&
          args.requireChecksum
        ) {
          throw new Error(
            checksumsUrl && !checksumsAvailable
              ? `Could not fetch the checksums file ${checksumsUrl} for ` +
                `${releasePlatform.archiveName} — refusing to record a release ` +
                `that cannot be verified. Check network access, or pass ` +
                `requireChecksum=false to override.`
              : `No checksum for ${releasePlatform.archiveName} in ` +
                `${
                  checksumsUrl ?? g.checksumsName
                } — the checksums file does ` +
                `not list this archive, so it cannot be verified. Pass ` +
                `requireChecksum=false to override.`,
          );
        }
        if (releasePlatform.archiveName && !checksum) {
          context.logger.warn?.(
            "No checksum for {name} — release recorded unverified",
            { name: releasePlatform.archiveName },
          );
        }
        // More than one archive matched the platform: report the variants so a
        // caller knows the main build was chosen over the others.
        if ((releasePlatform.candidates?.length ?? 0) > 1) {
          context.logger.warn?.(
            "{count} archives match {os}/{arch}; selected {archive}. " +
              "Other variants: {others}. Pass stem or assetName to choose another.",
            {
              count: releasePlatform.candidates!.length,
              os: releasePlatform.os,
              arch: releasePlatform.arch,
              archive: releasePlatform.archiveName,
              others: releasePlatform.candidates!.filter((n) =>
                n !== releasePlatform.archiveName
              ).join(", "),
            },
          );
        }

        const handle = await context.writeResource("release", "release", {
          ...release,
          fetchedAt: new Date().toISOString(),
          sourceUrl: apiUrl,
          platform: releasePlatform,
          checksumsUrl,
          checksum,
          checksumAlgorithm,
        });

        context.logger.info(
          "Release {version} — {os}/{arch}: {archive}",
          {
            version: release.version,
            os: releasePlatform.os,
            arch: releasePlatform.arch,
            archive: releasePlatform.archiveName ?? "no matching archive",
          },
        );

        return { dataHandles: [handle] };
      },
    },

    download: {
      description:
        "Download the release archive for this platform, verify it against the " +
        "release's checksums, and write it to outputPath (when set). Refuses " +
        "to return an archive whose SHA-256 does not match. Idempotent: an " +
        "outputPath already holding the expected bytes is reused.",
      arguments: DownloadArgsSchema,
      execute: async (
        args: DownloadArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const pattern = args.pattern ?? g.assetPattern;
        compileAssetPattern(pattern);
        const format = (args.format ?? g.format) as ArchiveType;
        const token = resolveToken(g.githubToken);

        const wanted = normalizeVersion(args.version);
        const suppliedVersion = normalizeVersion(args.releaseVersion);
        const suppliedUrl = args.downloadUrl.trim();
        const suppliedArchive = args.assetName.trim();
        const suppliedChecksum = args.checksum.trim();
        const reuse = suppliedUrl !== "" && suppliedArchive !== "" &&
          (wanted === "" || wanted === suppliedVersion);

        let archiveName: string;
        let downloadUrl: string;
        let version: string;
        let tag: string | null = null;
        let platform: Platform | null = null;
        let expected: string;
        // Whether the checksums file was reachable (as opposed to reachable but
        // not listing this archive) — drives the failure message.
        let checksumsAvailable = true;

        if (reuse) {
          version = suppliedVersion || wanted;
          archiveName = suppliedArchive;
          downloadUrl = suppliedUrl;
          expected = suppliedChecksum;
          platform = {
            os: (args.os ?? g.os).trim(),
            arch: (args.arch ?? g.arch).trim(),
            stem: (args.stem ?? g.stem).trim(),
            archiveName,
            downloadUrl,
            format: detectArchiveType(archiveName, format),
            supported: true,
          };
          context.logger.info(
            "Using the release resolved by check: {version} {archive}",
            { version, archive: archiveName },
          );
        } else {
          const apiUrl = wanted
            ? apiUrlForVersion(resolveApiUrl(g.repo, g.apiUrl), wanted)
            : resolveApiUrl(g.repo, g.apiUrl);
          const release = await fetchRelease({
            apiUrl,
            userAgent: g.userAgent,
            token,
          }, pattern);
          version = release.version;
          tag = release.tag;
          const resolved = await platformFor(args, g);
          platform = selectPlatformAsset(release, resolved, {
            assetName: suppliedArchive || undefined,
            pattern,
            repo: g.repo,
          });
          if (!platform.archiveName) {
            throw new Error(
              `No release archive found for ${platform.os}/${platform.arch}` +
                (platform.stem ? ` (stem ${platform.stem})` : "") +
                ` in ${version}.`,
            );
          }
          archiveName = platform.archiveName;
          downloadUrl = platform.downloadUrl!;
          const checksumsUrl = checksumsUrlFor(
            release.assets,
            g.checksumsName,
            args.checksumsUrl,
          );
          expected = "";
          checksumsAvailable = Boolean(checksumsUrl);
          if (checksumsUrl) {
            const result = await fetchChecksums(
              checksumsUrl,
              g.userAgent,
              token,
            );
            checksumsAvailable = result.available;
            expected = result.sums[archiveName] ?? "";
          }
        }

        if (!expected) {
          if (args.requireChecksum) {
            throw new Error(
              !checksumsAvailable
                ? `Could not fetch the checksums file for ${archiveName} — ` +
                  `refusing to download an unverified archive. Check network ` +
                  `access, or set requireChecksum=false to override.`
                : `No SHA-256 available for ${archiveName} — refusing to ` +
                  `download an unverified archive. Run \`check\` first, or ` +
                  `pass the archive's checksum via the checksum input, or set ` +
                  `requireChecksum=false to override.`,
            );
          }
          context.logger.warn?.(
            "No checksum for {name} — downloading unverified",
            { name: archiveName },
          );
        }

        const outputPathArg = args.outputPath.trim();
        const outputDir = args.outputDir.trim();
        assertAbsoluteOrTilde(outputPathArg, "outputPath");
        assertAbsoluteOrTilde(outputDir, "outputDir");
        const outputPath = outputPathArg
          ? expandHome(outputPathArg)
          : outputDir
          ? `${expandHome(outputDir).replace(/\/+$/, "")}/${archiveName}`
          : "";
        const { bytes, sha256, algorithm, checksumVerified, cached } =
          await downloadWithCache({
            downloadUrl,
            outputPath,
            expected,
            userAgent: g.userAgent,
            token,
            force: args.force,
            log: context.logger,
          });

        const verifyNote = checksumVerified
          ? " (checksum verified)"
          : " (unverified)";
        const message = cached
          ? `Reused verified archive at ${outputPath}${verifyNote}`
          : outputPath
          ? `Wrote ${bytes.length} bytes to ${outputPath}${verifyNote}`
          : `Downloaded ${bytes.length} bytes into memory${verifyNote}`;

        const handle = await context.writeResource("archive", "archive", {
          downloaded: !cached,
          cached,
          version,
          tag,
          archiveName,
          downloadUrl,
          checksum: expected || null,
          checksumAlgorithm: algorithm,
          sha256,
          checksumVerified,
          format: platform?.format ?? detectArchiveType(archiveName, format),
          path: outputPath || null,
          bytes: bytes.length,
          platform,
          sourceUrl: downloadUrl,
          downloadedAt: new Date().toISOString(),
          message,
        });
        context.logger.info(message);
        return { dataHandles: [handle] };
      },
    },

    render: {
      description:
        "Render the stored release — including the preserved raw GitHub payload " +
        "— into a Markdown document: title, version, publication time, release " +
        "notes and an asset table. Writes the `document` resource and logs the " +
        "Markdown. Run `check` first.",
      arguments: RenderArgsSchema,
      execute: async (
        args: RenderArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const release = await context.readResource("release") as {
          tag?: string;
          version?: string;
          name?: string;
          publishedAt?: string;
          prerelease?: boolean;
          htmlUrl?: string;
          body?: string;
          assets?: { name: string; url: string; size?: number }[];
          payload?: Record<string, unknown>;
        } | null;

        if (!release) {
          const lines = [
            "No release snapshot found — run the check method first.",
          ];
          const handle = await context.writeResource("document", "document", {
            rendered: false,
            version: null,
            tag: null,
            name: null,
            publishedAt: null,
            htmlUrl: null,
            prerelease: null,
            bodyChars: 0,
            assetCount: 0,
            markdown: "",
            lines,
          });
          context.logger.warn?.("render: no release snapshot found");
          return { dataHandles: [handle] };
        }

        const markdown = renderReleaseMarkdown(release, {
          includeBody: args.includeBody,
          includeAssets: args.includeAssets,
          maxBodyChars: args.maxBodyChars,
        });
        const body = release.body ??
          (typeof release.payload?.body === "string"
            ? String(release.payload.body)
            : "");
        context.logger.info(
          "Rendered release {version} — {assets} assets, {chars} body chars",
          {
            version: release.version ?? release.tag ?? "unknown",
            assets: release.assets?.length ?? 0,
            chars: body.length,
          },
        );

        const handle = await context.writeResource("document", "document", {
          rendered: true,
          version: release.version ?? null,
          tag: release.tag ?? null,
          name: release.name ?? null,
          publishedAt: release.publishedAt ?? null,
          htmlUrl: release.htmlUrl ?? null,
          prerelease: release.prerelease ?? null,
          bodyChars: body.length,
          assetCount: release.assets?.length ?? 0,
          markdown,
          lines: markdown.split("\n"),
        });
        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Log the stored release and archive: the version, the platform archive, " +
        "its SHA-256, any verified file path, and whether it is newer than the " +
        "`installedVersion` input. Run `check` (and optionally `download`) first.",
      arguments: PrintArgsSchema,
      execute: async (
        args: PrintArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const release = await context.readResource("release") as {
          version?: string;
          tag?: string;
          name?: string;
          publishedAt?: string;
          platform?: Platform;
          checksum?: string | null;
        } | null;
        const archive = await context.readResource("archive") as {
          path?: string | null;
        } | null;
        const installedVersion = normalizeVersion(args.installedVersion ?? "");
        const updateAvailable = release?.version
          ? compareInstalled(release.version, installedVersion)
          : null;

        if (!release) {
          const lines = [
            "No release snapshot found — run the check method first.",
          ];
          const handle = await context.writeResource("summary", "summary", {
            printed: false,
            version: null,
            tag: null,
            platform: null,
            archiveName: null,
            downloadUrl: null,
            checksum: null,
            archivePath: archive?.path ?? null,
            installedVersion: installedVersion || null,
            updateAvailable: null,
            lines,
          });
          context.logger.warn?.("print: no release snapshot found");
          return { dataHandles: [handle] };
        }

        const lines = formatSummary(
          { ...release, updateAvailable },
          archive,
          installedVersion,
        );
        for (const line of lines) context.logger.info(line);

        const handle = await context.writeResource("summary", "summary", {
          printed: true,
          version: release.version ?? null,
          tag: release.tag ?? null,
          platform: release.platform
            ? `${release.platform.os}/${release.platform.arch}`
            : null,
          archiveName: release.platform?.archiveName ?? null,
          downloadUrl: release.platform?.downloadUrl ?? null,
          checksum: release.checksum ?? null,
          archivePath: archive?.path ?? null,
          installedVersion: installedVersion || null,
          updateAvailable,
          lines,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Reject a relative output path before any network or filesystem work: it would
 * resolve against whatever working directory the method happened to run in. An
 * empty string is allowed (the caller then keeps the bytes in memory).
 */
function assertAbsoluteOrTilde(value: string, field: string): void {
  if (value && !value.startsWith("/") && !value.startsWith("~")) {
    throw new Error(
      `${field} must be an absolute path or ~-prefixed, got '${value}'`,
    );
  }
}

function compareInstalled(latest: string, installed: string): boolean {
  if (!installed) return true;
  const a = normalizeVersion(latest).split(".").map((n) =>
    parseInt(n, 10) || 0
  );
  const b = normalizeVersion(installed).split(".").map((n) =>
    parseInt(n, 10) || 0
  );
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Download an archive into memory, or reuse a file already at `outputPath` when
 * it already matches the expected checksum (unless `force`). When `outputPath`
 * is set the verified bytes are written there atomically.
 */
async function downloadWithCache(opts: {
  downloadUrl: string;
  outputPath: string;
  expected: string;
  userAgent: string;
  token?: string;
  force: boolean;
  log: MethodContext["logger"];
}): Promise<{
  bytes: Uint8Array;
  sha256: string;
  algorithm: string;
  checksumVerified: boolean;
  cached: boolean;
}> {
  const { downloadUrl, outputPath, expected, force } = opts;

  if (outputPath && !force) {
    try {
      const existing = await Deno.readFile(outputPath);
      // Verify with the algorithm the expected digest implies.
      const check = await verifyChecksum(existing, expected);
      if (expected && check.verified) {
        opts.log.info("Reusing verified archive at {path}", {
          path: outputPath,
        });
        return {
          bytes: existing,
          sha256: check.hex,
          algorithm: check.algorithm,
          checksumVerified: true,
          cached: true,
        };
      }
      if (!expected) {
        opts.log.warn?.(
          "Existing file at {path} not reused — no checksum to verify it",
          { path: outputPath },
        );
      }
    } catch {
      // No usable existing file; fall through to download.
    }
  }

  const result = await downloadAndVerify(
    downloadUrl,
    opts.userAgent,
    expected,
    opts.token,
  );

  if (outputPath) {
    const slash = outputPath.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(outputPath.slice(0, slash), { recursive: true });
    }
    const tmp = `${outputPath}.new-${crypto.randomUUID()}`;
    try {
      await Deno.writeFile(tmp, result.bytes);
      await Deno.rename(tmp, outputPath);
    } finally {
      try {
        await Deno.remove(tmp);
      } catch {
        // already renamed, or never created
      }
    }
  }

  return { ...result, cached: false };
}
