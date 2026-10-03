/**
 * Workflow-scope report for @svendowideit/fleet-inventory — printed at the end of
 * a `@svendowideit/fleet-inventory-sweep` run. It summarises what the sweep
 * gathered (hosts, tiers, OS, device classes) so the user can sanity-check the
 * result at a glance, and lists the explained commands to view any of it in
 * detail — they only need to dive deeper when something looks wrong.
 *
 * This is a workflow-scope report: it runs after the workflow completes and
 * reads the `inventory` and `report` resources the steps produced from the
 * run's `stepExecutions`.
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

/** The subset of the `report` resource this summary reads. */
export type FleetReport = {
  total: number;
  reporting: number;
  silent: string[];
  coveragePercent: number;
  byTier: Record<string, number>;
  byOs: Record<string, number>;
  byClass?: Record<string, number>;
  nextCommands?: string;
};

/** Read and parse a resource by spec name from a run's step executions. */
async function readSpec<T>(
  context: WorkflowReportContext,
  specName: string,
): Promise<T | null> {
  // Prefer the latest write of this spec (highest version) across steps.
  let best: { version: number; raw: Uint8Array } | null = null;
  for (const step of context.stepExecutions) {
    for (const handle of step.dataHandles) {
      if (handle.specName !== specName) continue;
      const raw = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        handle.name,
        handle.version,
      );
      if (!raw) continue;
      const v = handle.version ?? 0;
      if (!best || v > best.version) best = { version: v, raw };
    }
  }
  if (!best) return null;
  try {
    return JSON.parse(new TextDecoder().decode(best.raw)) as T;
  } catch {
    return null;
  }
}

/** A `k×n` breakdown rendered as one comma-separated line, biggest first. */
function breakdown(counts: Record<string, number> | undefined): string {
  if (!counts || Object.keys(counts).length === 0) return "—";
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(" ");
}

/**
 * Render the end-of-sweep summary as markdown. Kept deliberately short (~16
 * lines) so it fits on one screen: the counts to sanity-check the run, then the
 * view commands in a fenced block (fenced so renderers keep them verbatim).
 */
export function renderSummary(report: FleetReport | null): string {
  const lines: string[] = [];
  lines.push("# Fleet inventory sweep");
  lines.push("");
  if (!report) {
    lines.push(
      "No inventory was produced by this run (steps may have been skipped or " +
        "failed). Re-run with:",
    );
    lines.push("");
    lines.push("```sh");
    lines.push("swamp workflow run @svendowideit/fleet-inventory-sweep");
    lines.push("```");
    return lines.join("\n").trimEnd() + "\n";
  }
  lines.push(
    `${report.total} hosts · ${report.reporting} reporting · ` +
      `${report.silent.length} silent · coverage ${report.coveragePercent}%`,
  );
  lines.push("");
  lines.push(`- tier: ${breakdown(report.byTier)}`);
  lines.push(`- os: ${breakdown(report.byOs)}`);
  lines.push(`- device: ${breakdown(report.byClass)}`);
  lines.push("");
  if (report.total > 0 && report.reporting === 0) {
    lines.push(
      "_Coverage is 0% and all hosts read silent until the Phase 1 reporting " +
        "feed exists; the breakdowns above are real._",
    );
    lines.push("");
  }
  lines.push("View the results:");
  lines.push("");
  lines.push("```sh");
  lines.push(report.nextCommands ?? "swamp data get fleet inventory --json");
  lines.push("```");
  return lines.join("\n").trimEnd() + "\n";
}

/** Report definition: the end-of-sweep summary plus explained view commands. */
export const report = {
  name: "@svendowideit/fleet-inventory-report",
  description:
    "End-of-sweep summary (hosts, tiers, OS, device classes) plus the explained commands to view the gathered data",
  scope: "workflow",
  labels: ["fleet", "inventory", "summary"],
  execute: async (
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.workflowStatus === "failed") {
      return {
        markdown: "# Fleet inventory sweep — summary\n\n" +
          "The workflow run did not succeed; read the failures with " +
          "`swamp report get @swamp/workflow-summary --workflow " +
          "@svendowideit/fleet-inventory-sweep --markdown`.\n",
        json: { error: true, status: context.workflowStatus },
      };
    }
    const reportData = await readSpec<FleetReport>(context, "report");
    if (reportData) {
      return {
        markdown: renderSummary(reportData),
        json: { ...reportData },
      };
    }
    // Fall back to the inventory resource if the report step did not run.
    const inventory = await readSpec<FleetReport>(context, "inventory");
    return {
      markdown: renderSummary(inventory),
      json: inventory ? { ...inventory } : { error: "no inventory" },
    };
  },
};
