/**
 * Report extension for `@svendowideit/synology-disk-usage`.
 *
 * Formats the audit output as a human-friendly markdown summary printed
 * immediately after the `audit` method runs: capacity, categories, shares,
 * findings, and the largest files.
 *
 * @module
 */
import { humanSize } from "./synology_disk_usage_shared.ts";

/**
 * The subset of the audit resource the report reads.
 *
 * Declared locally (rather than importing the model) so this report bundle does
 * not pull in the model and its ssh subprocess seam.
 */
interface AuditOutput {
  host: string;
  mode: "tree" | "files" | "shares";
  useSudo: boolean;
  oneFilesystem: boolean;
  totalBytes: number;
  totalFiles: number;
  totalDirs: number;
  truncated: boolean;
  durationMs: number;
  usedBytes: number;
  unaccountedBytes: number;
  coverageFraction: number;
  volumes: {
    path: string;
    usedBytes: number;
    availableBytes: number;
    totalBytes: number;
    usedFraction: number;
  }[];
  categories: {
    category: string;
    label: string;
    totalBytes: number;
    fileCount: number;
    fraction: number;
  }[];
  shares: {
    path: string;
    category: string;
    bytes: number;
    fileCount: number;
  }[];
  unscannedShares: { path: string }[];
  notableDirs: { path: string; bytes: number; category: string }[];
  notableFiles: { path: string; bytes: number; category: string }[];
  findings: {
    title: string;
    totalBytes: number;
    count: number;
    notable: boolean;
  }[];
  errors: { path: string; message: string }[];
}

type DataHandle = {
  name: string;
  specName: string;
  kind: string;
  version?: number;
};

type MethodReportContext = {
  scope: "method";
  modelType: string;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
};

/** Report definition for the Synology disk usage summary. */
export const report = {
  name: "@svendowideit/synology-disk-report",
  description:
    "Format Synology disk usage as a category, capacity, and largest-item summary",
  scope: "method",
  labels: ["synology", "disk", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      context.executionStatus === "failed" || context.methodName !== "audit"
    ) {
      return { markdown: "", json: {} };
    }

    const handle = context.dataHandles.find((h) => h.specName === "audit");
    if (!handle) {
      return { markdown: "No audit data produced.", json: {} };
    }

    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) {
      return { markdown: "Audit data not found.", json: {} };
    }

    let result: AuditOutput;
    try {
      result = JSON.parse(new TextDecoder().decode(raw)) as AuditOutput;
    } catch {
      return { markdown: "Audit data could not be parsed.", json: {} };
    }

    return {
      markdown: formatReport(result),
      json: {
        host: result.host,
        totalBytes: result.totalBytes,
        totalFiles: result.totalFiles,
        categories: result.categories.length,
        findings: result.findings.length,
        truncated: result.truncated,
      },
    };
  },
};

/** Format the audit result as a markdown summary. */
function formatReport(result: AuditOutput): string {
  const lines: string[] = [];
  lines.push(`# Synology Disk Usage: ${result.host}`);
  lines.push("");
  const measured = result.totalFiles > 0
    ? `${result.totalFiles.toLocaleString()} files`
    : result.totalDirs > 0
    ? `${result.totalDirs.toLocaleString()} directories`
    : "share-level totals";
  lines.push(
    `**${humanSize(result.totalBytes)}** across ${measured} — scanned in ${
      (result.durationMs / 1000).toFixed(1)
    }s (${result.mode} mode)`,
  );
  if (result.truncated) {
    lines.push("");
    lines.push(
      "> Scan stopped early by `maxFiles`; the totals below are partial.",
    );
  }
  if (result.usedBytes > 0 && result.coverageFraction < 0.95) {
    const hint = result.oneFilesystem
      ? "Re-run with `oneFilesystem=false` to include shared-folder subvolumes."
      : result.useSudo
      ? "The remaining bytes may be Btrfs snapshots, iSCSI LUNs, or system data; inspect the listed shares as root."
      : "Re-run with `useSudo=true` (NOPASSWD) or as root if shares are permission-protected.";
    lines.push("");
    lines.push(
      `> **Scan incomplete:** only ${
        (result.coverageFraction * 100).toFixed(1)
      }% of used space was readable (${
        humanSize(result.unaccountedBytes)
      } unaccounted). ${hint}`,
    );
  }
  lines.push("");

  lines.push("## Capacity");
  lines.push("");
  lines.push("| Volume | Used | Free | Total | Used % |");
  lines.push("| ------ | ---- | ---- | ----- | ------ |");
  for (const volume of result.volumes) {
    lines.push(
      `| ${volume.path} | ${humanSize(volume.usedBytes)} | ${
        humanSize(volume.availableBytes)
      } | ${humanSize(volume.totalBytes)} | ${
        (volume.usedFraction * 100).toFixed(0)
      }% |`,
    );
  }
  lines.push("");
  if (result.usedBytes > 0) {
    lines.push(
      `**Scanned:** ${humanSize(result.totalBytes)} of ${
        humanSize(result.usedBytes)
      } used (${(result.coverageFraction * 100).toFixed(1)}%). ` +
        `**Unaccounted:** ${
          humanSize(result.unaccountedBytes)
        } — unreadable shares, Btrfs snapshots, or system data.`,
    );
    lines.push("");
  }

  lines.push("## By category");
  lines.push("");
  lines.push("| Category | Size | % of scanned | Files |");
  lines.push("| -------- | ---- | ------------ | ----- |");
  for (const category of result.categories) {
    lines.push(
      `| ${category.label} | ${humanSize(category.totalBytes)} | ${
        (category.fraction * 100).toFixed(1)
      }% | ${
        category.fileCount > 0 ? category.fileCount.toLocaleString() : "—"
      } |`,
    );
  }
  lines.push("");

  lines.push("## Largest shares");
  lines.push("");
  lines.push("| Share | Category | Size | Files |");
  lines.push("| ----- | -------- | ---- | ----- |");
  for (const share of result.shares.slice(0, 20)) {
    const label = result.categories.find((c) => c.category === share.category)
      ?.label ?? share.category;
    lines.push(
      `| ${share.path} | ${label} | ${humanSize(share.bytes)} | ${
        share.fileCount > 0 ? share.fileCount.toLocaleString() : "—"
      } |`,
    );
  }
  if (result.shares.length > 20) {
    lines.push(`| ... and ${result.shares.length - 20} more | | | |`);
  }
  lines.push("");

  if (result.unscannedShares.length > 0) {
    lines.push("## Shares with no readable files");
    lines.push("");
    lines.push(
      "These shares were discovered but produced no measured files. They may be empty, or the SSH user may not be able to read them.",
    );
    lines.push("");
    lines.push("| Share |");
    lines.push("| ----- |");
    for (const share of result.unscannedShares.slice(0, 30)) {
      lines.push(`| ${share.path} |`);
    }
    if (result.unscannedShares.length > 30) {
      lines.push(`| ... and ${result.unscannedShares.length - 30} more |`);
    }
    lines.push("");
  }

  lines.push("## Findings");
  lines.push("");
  lines.push("| Finding | Size | Count | Notable |");
  lines.push("| ------- | ---- | ----- | ------- |");
  for (const finding of result.findings) {
    lines.push(
      `| ${finding.title} | ${
        humanSize(finding.totalBytes)
      } | ${finding.count.toLocaleString()} | ${finding.notable ? "★" : ""} |`,
    );
  }
  lines.push("");

  if (result.notableDirs.length > 0) {
    lines.push("## Largest directories");
    lines.push("");
    lines.push("| Directory | Size | Category |");
    lines.push("| --------- | ---- | -------- |");
    for (const dir of result.notableDirs.slice(0, 15)) {
      const label = result.categories.find((c) => c.category === dir.category)
        ?.label ?? dir.category;
      lines.push(
        `| ${dir.path} | ${humanSize(dir.bytes)} | ${label} |`,
      );
    }
    if (result.notableDirs.length > 15) {
      lines.push(`| ... and ${result.notableDirs.length - 15} more | | |`);
    }
    lines.push("");
  }

  if (result.notableFiles.length > 0) {
    lines.push("## Largest files");
    lines.push("");
    lines.push("| File | Size | Category |");
    lines.push("| ---- | ---- | -------- |");
    for (const file of result.notableFiles.slice(0, 15)) {
      const label = result.categories.find((c) => c.category === file.category)
        ?.label ?? file.category;
      lines.push(
        `| ${file.path} | ${humanSize(file.bytes)} | ${label} |`,
      );
    }
    if (result.notableFiles.length > 15) {
      lines.push(`| ... and ${result.notableFiles.length - 15} more | | |`);
    }
    lines.push("");
  }

  if (result.errors.length > 0) {
    lines.push(`## Errors (${result.errors.length})`);
    lines.push("");
    for (const error of result.errors.slice(0, 5)) {
      lines.push(
        `- ${error.path ? `\`${error.path}\`: ` : ""}${error.message}`,
      );
    }
    if (result.errors.length > 5) {
      lines.push(`- ... and ${result.errors.length - 5} more`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
