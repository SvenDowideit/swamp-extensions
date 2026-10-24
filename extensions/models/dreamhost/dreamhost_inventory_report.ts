/**
 * Workflow-scope report for @svendowideit/dreamhost-inventory-all — prints a
 * per-user table of files, total bytes, and inaccessible directories from the
 * home manifests the workflow collects.
 *
 * @module
 */

type DataHandle = {
  name: string;
  specName: string;
  kind: string;
  version?: number;
};

type StepExecution = {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: DataHandle[];
  methodArgs: Record<string, unknown>;
  modelId: string;
  globalArgs: Record<string, unknown>;
};

type WorkflowReportContext = {
  scope: "workflow";
  repoDir: string;
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: StepExecution[];
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

type HomeManifestSummary = {
  user?: string;
  entryCount?: number;
  directoryCount?: number;
  fileCount?: number;
  symlinkCount?: number;
  totalBytes?: number;
  permissionDeniedCount?: number;
  truncated?: boolean;
};

async function readHomeManifests(
  context: WorkflowReportContext,
): Promise<Array<{ user: string; manifest: HomeManifestSummary }>> {
  const rows: Array<{ user: string; manifest: HomeManifestSummary }> = [];
  const seen = new Set<string>();
  for (const step of context.stepExecutions) {
    if (step.status !== "succeeded") continue;
    const isInventoryStep = step.methodName === "homeManifest" ||
      step.stepName.includes("home-manifest");
    if (!isInventoryStep) continue;
    for (const handle of step.dataHandles) {
      if (handle.specName !== "homeManifest") continue;
      const raw = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        handle.name,
        handle.version,
      );
      if (!raw) continue;
      try {
        const manifest = JSON.parse(
          new TextDecoder().decode(raw),
        ) as HomeManifestSummary;
        const username = String(
          manifest.user ??
            step.methodArgs?.user ??
            step.globalArgs?.user ??
            step.stepName.slice(
              Math.max(
                0,
                step.stepName.lastIndexOf("home-manifest-") +
                  "home-manifest-".length,
              ),
            ),
        );
        if (!username || seen.has(`${username}:${handle.version ?? 0}`)) {
          continue;
        }
        seen.add(`${username}:${handle.version ?? 0}`);
        rows.push({ user: username, manifest });
      } catch {
        // Ignore unparseable resources.
      }
    }
  }
  return rows;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Workflow-scope report for the DreamHost multi-account inventory. */
export const report = {
  name: "@svendowideit/dreamhost-inventory-report",
  description:
    "Per-user summary of the DreamHost multi-account inventory: files, total bytes, and inaccessible directories",
  scope: "workflow",
  labels: ["dreamhost", "inventory", "summary"],
  execute: async (
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.workflowStatus === "failed") {
      return {
        markdown:
          "# DreamHost account inventory\n\nThe workflow run did not succeed; " +
          "read the failures with `swamp report get @swamp/workflow-summary " +
          "--workflow @svendowideit/dreamhost-inventory-all --markdown`.\n",
        json: { error: true, status: context.workflowStatus },
      };
    }
    const rows = await readHomeManifests(context);
    if (rows.length === 0) {
      return {
        markdown:
          "# DreamHost account inventory\n\nNo home manifests were produced by this run.\n",
        json: { users: [] },
      };
    }
    const markdown: string[] = [];
    markdown.push("# DreamHost account inventory");
    markdown.push("");
    markdown.push(
      "| User | Files | Disk size | Inaccessible directories |",
    );
    markdown.push("| --- | ---: | ---: | ---: |");
    for (const row of rows) {
      markdown.push(
        `| ${row.user} | ${row.manifest.fileCount ?? 0} | ` +
          `${row.manifest.totalBytes ?? 0} (${
            formatBytes(row.manifest.totalBytes ?? 0)
          }) | ` +
          `${row.manifest.permissionDeniedCount ?? 0} |`,
      );
    }
    markdown.push("");
    markdown.push(
      "Sizes are total bytes reported by the home manifest; inaccessible " +
        "directories are counted from permission-denied errors while scanning.",
    );

    const users = rows.map((row) => ({
      user: row.user,
      files: row.manifest.fileCount ?? 0,
      directories: row.manifest.directoryCount ?? 0,
      entries: row.manifest.entryCount ?? 0,
      symlinks: row.manifest.symlinkCount ?? 0,
      bytes: row.manifest.totalBytes ?? 0,
      inaccessibleDirectories: row.manifest.permissionDeniedCount ?? 0,
      truncated: row.manifest.truncated ?? false,
    }));
    let htmlPath = "";
    try {
      const out = [
        "<!doctype html>",
        "<html><head><meta charset='utf-8'><title>DreamHost account inventory</title>",
        "<style>body{font-family:sans-serif;margin:2rem;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ccc;padding:.5rem;text-align:right;}th:first-child,td:first-child{text-align:left;}</style>",
        "</head><body>",
        "<h1>DreamHost account inventory</h1>",
        "<table>",
        "<tr><th>User</th><th>Files</th><th>Entries</th><th>Directories</th><th>Symlinks</th><th>Total bytes</th><th>Inaccessible directories</th><th>Truncated</th></tr>",
      ];
      for (const user of users) {
        const readable = formatBytes(user.bytes);
        out.push(
          `<tr><td>${user.user}</td><td>${user.files.toLocaleString()}</td><td>${user.entries.toLocaleString()}</td><td>${user.directories.toLocaleString()}</td><td>${user.symlinks.toLocaleString()}</td><td>${user.bytes.toLocaleString()}</td><td>${readable}</td><td>${user.inaccessibleDirectories}</td><td>${
            user.truncated ? "yes" : "no"
          }</td></tr>`,
        );
      }
      out.push("</table></body></html>");
      htmlPath = `${context.repoDir}/dreamhost-account-inventory.html`;
      await Deno.mkdir(context.repoDir, { recursive: true });
      await Deno.writeTextFile(htmlPath, out.join("\\n"));
    } catch (err) {
      htmlPath = `could not write HTML file: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    markdown.unshift(
      htmlPath.startsWith("could not")
        ? `HTML report: ${htmlPath}\\n`
        : `HTML report written to: ${htmlPath}\\n`,
    );
    markdown.unshift("");

    return {
      markdown: markdown.join("\\n").trimEnd() + "\\n",
      json: { htmlPath, users },
    };
  },
};
