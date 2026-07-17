/**
 * Report extension for @svendowideit/disk-auditor — formats the audit output
 * as a human-friendly summary table printed directly after the method runs.
 *
 * @module
 */
import type { AuditOutput } from "./disk_auditor.ts";
import { humanSize } from "./disk_auditor.ts";

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

/** Report definition for the disk audit summary. */
export const report = {
  name: "@svendowideit/disk-summary",
  description: "Format disk audit results as a human-friendly summary table",
  scope: "method",
  labels: ["disk", "summary"],
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

    const r = JSON.parse(new TextDecoder().decode(raw)) as AuditOutput;
    return {
      markdown: formatReport(r),
      json: {
        rootPath: r.rootPath,
        totalBytes: r.totalBytes,
        totalFiles: r.totalFiles,
        findings: r.findings.length,
      },
    };
  },
};

/** Format the full audit report as a human-friendly markdown summary. */
function formatReport(r: AuditOutput): string {
  const lines: string[] = [];
  lines.push(`# Disk Audit: ${r.rootPath}`);
  lines.push("");
  lines.push(
    `**${
      humanSize(r.totalBytes)
    }** across ${r.totalFiles.toLocaleString()} files in ${r.totalDirs.toLocaleString()} dirs — scanned in ${
      (r.durationMs / 1000).toFixed(1)
    }s`,
  );
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  lines.push("| Finding | Size | Count | Notable |");
  lines.push("| ------- | ---- | ----- | ------- |");
  for (const f of r.findings) {
    lines.push(
      `| ${f.title} | ${
        humanSize(f.totalBytes)
      } | ${f.count.toLocaleString()} | ${f.notable ? "★" : ""} |`,
    );
  }
  lines.push("");
  lines.push("## By category");
  lines.push("");
  lines.push("| Category | Size | Files | % of total |");
  lines.push("| -------- | ---- | ----- | ----------- |");
  for (const c of r.categories) {
    lines.push(
      `| ${c.label} | ${
        humanSize(c.totalBytes)
      } | ${c.fileCount.toLocaleString()} | ${
        (c.fraction * 100).toFixed(0)
      }% |`,
    );
  }
  lines.push("");
  lines.push("## Largest directories");
  lines.push("");
  lines.push("| Directory | Size | Files | Type | Depth |");
  lines.push("| --------- | ---- | ----- | ---- | ----- |");
  const topDirs = r.notableDirs.slice(0, 15);
  for (const d of topDirs) {
    const relName = d.path.replace(r.rootPath, "").replace(/^\/+/, "") ||
      d.name;
    lines.push(
      `| ${relName} | ${
        humanSize(d.bytes)
      } | ${d.fileCount.toLocaleString()} | ${
        d.dominantCategory ?? "—"
      } | ${d.depth} |`,
    );
  }
  if (r.notableDirs.length > 15) {
    lines.push(`| ... and ${r.notableDirs.length - 15} more | | | | |`);
  }
  lines.push("");
  lines.push("## Largest files");
  lines.push("");
  lines.push("| File | Size | Type |");
  lines.push("| ---- | ---- | ---- |");
  const topFiles = r.notableFiles.slice(0, 15);
  for (const f of topFiles) {
    const relName = f.path.replace(r.rootPath, "").replace(/^\/+/, "") ||
      f.name;
    lines.push(`| ${relName} | ${humanSize(f.bytes)} | ${f.category} |`);
  }
  if (r.notableFiles.length > 15) {
    lines.push(`| ... and ${r.notableFiles.length - 15} more | | |`);
  }
  if (r.errors.length > 0) {
    lines.push("");
    lines.push(`## Errors (${r.errors.length})`);
    lines.push("");
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`- \`${e.path}\`: ${e.message}`);
    }
    if (r.errors.length > 5) {
      lines.push(`- ... and ${r.errors.length - 5} more`);
    }
  }
  return lines.join("\n");
}
