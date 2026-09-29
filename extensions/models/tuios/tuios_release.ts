/**
 * TUIOS latest release — resolves the newest TUIOS release from GitHub and the
 * exact archive to download for the platform the model is running on.
 *
 * TUIOS (https://tuios.dev) is a terminal window manager with persistent,
 * daemon-backed sessions. Its releases are pre-built archives named
 * `tuios_<version>_<Os>_<arch>.tar.gz` (and a `tuios-ghostty_…` flavor that
 * bundles libghostty-vt). This model answers two questions in one place:
 *
 *   1. **What is the latest release?** — tag, version, publication time, notes
 *      and every attached archive, read from the GitHub releases API.
 *   2. **What should *this* machine download?** — the model probes the local OS
 *      and architecture (`uname -s` / `uname -m`), maps them to the release's
 *      GoReleaser tokens, selects the matching archive, and records its
 *      SHA-256 from the release's `checksums.txt` so an install can be
 *      verified afterwards.
 *
 * Methods:
 *   - `check` — fetch the latest release and the platform's asset, recording
 *               its SHA-256. Writes the `release` resource.
 *   - `print` — log the stored release: version, tag, the local platform, the
 *               archive to download, and whether it is newer than the version
 *               passed in as `installedVersion` (from
 *               `@svendowideit/tuios-installed`, wired by the workflow).
 *
 * Every selector has a per-call override, so one model instance can be asked
 * "what would a Linux arm64 machine download?" without touching the host:
 * `--input os=Linux --input arch=arm64`.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  archiveName,
  type BuildFlavor,
  CHECKSUMS_NAME,
  compareVersions,
  fetchChecksums,
  fetchLatestRelease,
  normalizeVersion,
  type Platform,
  RELEASE_API_URL,
  RELEASE_REPO,
  type ReleaseAsset,
  resolvePlatform,
  resolveToken,
  schemas,
  selectAsset,
} from "./tuios_shared.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FlavorSchema = z.enum(["std", "ghostty"]);

const GlobalArgsSchema = z.object({
  flavor: FlavorSchema.default("std").describe(
    "Build flavor to track: 'std' is the pure-Go emulator, 'ghostty' bundles libghostty-vt.",
  ),
  repo: z.string().default(RELEASE_REPO).describe(
    "GitHub repository (owner/name) publishing TUIOS releases.",
  ),
  apiUrl: z.string().default(RELEASE_API_URL).describe(
    "GitHub releases API URL for the latest release.",
  ),
  userAgent: z.string().default("swamp-tuios/1.0").describe(
    "User-Agent header sent to the GitHub API.",
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
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CheckArgsSchema = z.object({
  os: z.string().optional().describe(
    "Override the release OS token for this call (e.g. Linux). Empty uses the model global / host probe.",
  ),
  arch: z.string().optional().describe(
    "Override the release architecture token for this call (e.g. arm64). Empty uses the model global / host probe.",
  ),
  flavor: FlavorSchema.optional().describe(
    "Override the build flavor for this call ('std' or 'ghostty').",
  ),
  archiveName: z.string().optional().describe(
    "Force an exact archive file name instead of selecting by platform, e.g. tuios_0.8.0_Linux_arm64.tar.gz.",
  ),
  fetchChecksums: z.boolean().default(true).describe(
    "Download checksums.txt and record the selected archive's SHA-256. Set false to skip the extra request.",
  ),
});

type CheckArgs = z.infer<typeof CheckArgsSchema>;

const PrintArgsSchema = z.object({
  installedVersion: z.preprocess(
    // The CEL wiring reads a nullable resource field, so coerce null/undefined
    // to the empty string before validation.
    (v) => v ?? "",
    z.string().describe(
      "The currently installed TUIOS version, used to report whether an update " +
        "is available. The bundled workflow wires this from " +
        "@svendowideit/tuios-installed's `installed` resource via CEL.",
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
});

const PrintResultSchema = z.object({
  printed: z.boolean(),
  version: z.string().nullable(),
  tag: z.string().nullable(),
  platform: z.string().nullable(),
  archiveName: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  installedVersion: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
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

/** URL for the release's `checksums.txt`, from the asset list when present. */
export function checksumsUrlFor(assets: ReleaseAsset[]): string | null {
  const direct = assets.find((a) => a.name === CHECKSUMS_NAME);
  if (direct) return direct.url;
  const sibling = assets[0];
  if (!sibling) return null;
  const base = sibling.url.replace(/\/[^/]+$/, "");
  return base ? `${base}/${CHECKSUMS_NAME}` : null;
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
  installedVersion: string,
): string[] {
  const lines: string[] = [];
  lines.push(
    `Latest TUIOS: ${release.version ?? "unknown"}${
      release.tag ? ` (${release.tag})` : ""
    }`,
  );
  if (release.publishedAt) lines.push(`Published:    ${release.publishedAt}`);
  if (release.name) lines.push(`Release name: ${release.name}`);
  const p = release.platform;
  if (p) {
    lines.push(
      `This platform: ${p.os}/${p.arch} (${p.flavor}) — ${
        p.supported ? "supported" : "no release archive"
      }`,
    );
    lines.push(`Archive:      ${p.archiveName ?? "none found"}`);
    if (p.downloadUrl) lines.push(`Download:     ${p.downloadUrl}`);
  }
  if (release.checksum) lines.push(`SHA-256:      ${release.checksum}`);
  if (installedVersion) {
    lines.push(
      `Installed:    ${installedVersion}${
        release.updateAvailable ? " (update available)" : " (up to date)"
      }`,
    );
  } else {
    lines.push("Installed:    not detected");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Resolves the latest TUIOS release and the archive for the local platform. */
export const model = {
  type: "@svendowideit/tuios-release",
  version: "2026.09.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    release: {
      description:
        "The latest TUIOS release plus the archive for this platform",
      schema: ReleaseResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "The printed release/platform summary",
      schema: PrintResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    check: {
      description:
        "Fetch the latest TUIOS release from GitHub, select the archive for the " +
        "local platform (or an explicit os/arch override) and record its " +
        "SHA-256 from the release's checksums.txt.",
      arguments: CheckArgsSchema,
      execute: async (
        args: CheckArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const platform = await resolvePlatform({
          os: args.os ?? g.os,
          arch: args.arch ?? g.arch,
          flavor: args.flavor ?? g.flavor,
          archiveName: args.archiveName,
        });
        const sourceUrl = g.apiUrl;

        context.logger.debug?.("GET {url}", { url: sourceUrl });
        const token = resolveToken(g.githubToken);
        const { tag, version, assets, payload } = await fetchLatestRelease({
          apiUrl: g.apiUrl,
          userAgent: g.userAgent,
          token,
        });

        const flavor = platform.flavor as BuildFlavor;
        let asset = args.archiveName
          ? assets.find((a) => a.name === args.archiveName) ?? null
          : selectAsset(assets, platform.os, platform.arch, flavor);
        if (!asset && !args.archiveName) {
          // Fall back to the schema-derived name so `archiveName` is still
          // populated (and the failure explicit) on an unexpected asset rename.
          asset = assets.find(
            (a) =>
              a.name ===
                archiveName(version, platform.os, platform.arch, flavor),
          ) ?? null;
        }

        const checksumsUrl = args.fetchChecksums
          ? checksumsUrlFor(assets)
          : null;
        let checksum: string | null = null;
        if (checksumsUrl) {
          const expectedName = asset?.name ??
            archiveName(version, platform.os, platform.arch, flavor);
          const sums = await fetchChecksums(checksumsUrl, g.userAgent, token);
          checksum = sums[expectedName] ?? null;
          if (!checksum) {
            context.logger.warn?.(
              "checksums.txt does not list {name} (or could not be fetched)",
              { name: expectedName },
            );
          }
        }

        const releasePlatform: Platform = {
          ...platform,
          archiveName: asset?.name,
          downloadUrl: asset?.url,
          supported: platform.supported && asset !== null,
        };

        const handle = await context.writeResource("release", "release", {
          tag,
          version,
          name: String(payload.name ?? tag),
          publishedAt: String(payload.published_at ?? ""),
          prerelease: Boolean(payload.prerelease),
          htmlUrl: String(payload.html_url ?? ""),
          body: typeof payload.body === "string" ? payload.body : undefined,
          assets,
          fetchedAt: new Date().toISOString(),
          sourceUrl,
          platform: releasePlatform,
          checksumsUrl,
          checksum,
        });

        context.logger.info(
          "Latest TUIOS {version} — {os}/{arch} ({flavor}): {archive}",
          {
            version,
            os: releasePlatform.os,
            arch: releasePlatform.arch,
            flavor: releasePlatform.flavor,
            archive: releasePlatform.archiveName ?? "no matching archive",
          },
        );

        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Log the stored latest release, the platform archive to download, and " +
        "whether it is newer than the `installedVersion` input. Run `check` first.",
      arguments: PrintArgsSchema,
      execute: async (
        args: PrintArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const stored = await context.readResource("release") as {
          version?: string;
          tag?: string;
          name?: string;
          publishedAt?: string;
          platform?: Platform;
          checksum?: string | null;
        } | null;
        const installedVersion = normalizeVersion(args.installedVersion ?? "");
        const updateAvailable = stored?.version
          ? compareVersions(stored.version, installedVersion) > 0
          : null;

        if (!stored) {
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
            installedVersion: installedVersion || null,
            updateAvailable: null,
            lines,
          });
          context.logger.warn?.("print: no release snapshot found");
          return { dataHandles: [handle] };
        }

        const lines = formatSummary(
          { ...stored, updateAvailable },
          installedVersion,
        );
        for (const line of lines) context.logger.info(line);

        const handle = await context.writeResource("summary", "summary", {
          printed: true,
          version: stored.version ?? null,
          tag: stored.tag ?? null,
          platform: stored.platform
            ? `${stored.platform.os}/${stored.platform.arch}`
            : null,
          archiveName: stored.platform?.archiveName ?? null,
          downloadUrl: stored.platform?.downloadUrl ?? null,
          installedVersion: installedVersion || null,
          updateAvailable,
          lines,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
