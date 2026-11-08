/**
 * Workflow-scope report for @svendowideit/obsidian-factory-tick. It answers
 * "what did the tick actually do?" from the run's own data:
 *
 *   - the board snapshot and queue the agent was given,
 *   - every card's column/action,
 *   - the agent command, duration, exit code and the output it produced.
 *
 * The generic @swamp/workflow-summary only lists step names and statuses, which
 * is not enough to tell whether the factory touched a card or the agent went
 * off-task. This report is the factory's own end-of-tick summary.
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

type Counts = {
  claim: number;
  work: number;
  reconcile: number;
  done: number;
  wait: number;
};

type QueueCard = {
  id: string;
  title: string;
  column: string;
  action: string;
  stage: string;
  cycle: number;
  path: string;
};

type Queue = { cards: QueueCard[]; counts: Counts; timestamp: string };

type Brief = {
  prompt: string;
  systemPrompt: string;
  board: QueueCard[];
  counts: Counts;
  repo: string;
  timestamp: string;
};

type Tick = {
  board: QueueCard[];
  counts: Counts;
  repinned?: string[];
  pinned?: string[];
  errors?: string[];
};

type AgentRun = {
  binary: string;
  agent: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
};

/** Read and parse the latest resource with this spec name in the run. */
async function readSpec<T>(
  context: WorkflowReportContext,
  specName: string,
): Promise<T | null> {
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
      const version = handle.version ?? 0;
      if (!best || version > best.version) best = { version, raw };
    }
  }
  if (!best) return null;
  try {
    return JSON.parse(new TextDecoder().decode(best.raw)) as T;
  } catch {
    return null;
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

function clip(text: string, limit: number): string {
  const value = text.trim();
  if (value.length <= limit) return value;
  return `… (${value.length - limit} chars omitted) …\n` +
    value.slice(value.length - limit);
}

/** Render the tick's board, queue and agent result. */
export function renderTickSummary(
  tick: Tick | null,
  queue: Queue | null,
  brief: Brief | null,
  run: AgentRun | null,
  workflowRunId = "",
): string {
  const lines: string[] = [];
  lines.push("# Obsidian factory tick");
  lines.push("");
  const cards = queue?.cards ?? tick?.board ?? brief?.board ?? [];
  const counts = queue?.counts ?? tick?.counts ?? brief?.counts;
  if (counts) {
    lines.push(
      `${cards.length} cards · ${counts.work} work · ${counts.claim} claim · ` +
        `${counts.wait} wait · ${counts.done} done`,
    );
  } else {
    lines.push("No board snapshot was recorded by this run.");
  }
  lines.push("");

  if (cards.length > 0) {
    lines.push("| Card | Column | Action | Ledger |");
    lines.push("| ---- | ------ | ------ | ------ |");
    for (const card of cards) {
      const ledger = card.stage
        ? `${card.stage}/${card.cycle}`
        : "no work item";
      lines.push(
        `| ${card.id} — ${card.title.replace(/\|/g, "\\|")} | ` +
          `${card.column} | ${card.action} | ${ledger} |`,
      );
    }
    lines.push("");
  }

  if (tick?.repinned?.length || tick?.pinned?.length || tick?.errors?.length) {
    if (tick.repinned?.length) {
      lines.push(`- repinned: ${tick.repinned.join(", ")}`);
    }
    if (tick.pinned?.length) lines.push(`- pinned: ${tick.pinned.join(", ")}`);
    if (tick.errors?.length) {
      lines.push(`- tick errors: ${tick.errors.join("; ")}`);
    }
    lines.push("");
  }

  if (!run) {
    lines.push(
      "The agent step produced no run resource (it may have been skipped or " +
        "failed before the agent started). Read the workflow failures with:",
    );
    lines.push("");
    lines.push("```sh");
    lines.push(
      "swamp report get @swamp/workflow-summary --workflow " +
        "@svendowideit/obsidian-factory-tick --markdown",
    );
    lines.push("```");
    return lines.join("\n").trimEnd() + "\n";
  }

  lines.push(
    `Agent: **${run.binary}** · ${run.model || "default model"} · ` +
      `${seconds(run.durationMs)} · exit **${run.exitCode}** · ` +
      (run.success ? "succeeded" : "FAILED"),
  );
  lines.push("");
  if (run.stdout.trim()) {
    lines.push("## Agent output (tail)");
    lines.push("");
    lines.push("```text");
    lines.push(clip(run.stdout, 6000));
    lines.push("```");
    lines.push("");
  }
  if (run.stderr.trim()) {
    lines.push("## Agent errors");
    lines.push("");
    lines.push("```text");
    lines.push(clip(run.stderr, 3000));
    lines.push("```");
    lines.push("");
  }
  lines.push("Read the full run and the board:");
  lines.push("");
  lines.push("```sh");
  if (workflowRunId) {
    lines.push(`swamp data query 'workflowRunId == "${workflowRunId}"'`);
  } else {
    lines.push(
      'swamp data query \'modelType == "@maphew/agent-task" && name == "run-pi"\'',
    );
  }
  lines.push("swamp behavior run obsidian-board scan --input includeBody=true");
  lines.push("```");
  return lines.join("\n").trimEnd() + "\n";
}

export const report = {
  name: "@svendowideit/obsidian-factory-tick-report",
  description:
    "End-of-tick summary: the board snapshot, every card's column/action, and the agent's duration, exit code and output",
  scope: "workflow",
  labels: ["obsidian", "factory", "tick", "summary"],
  execute: async (
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.workflowStatus === "failed") {
      return {
        markdown: "# Obsidian factory tick — failed\n\n" +
          "The run did not complete. Read the failing step with " +
          "`swamp report get @swamp/workflow-summary --workflow " +
          "@svendowideit/obsidian-factory-tick --markdown`.\n",
        json: { error: true, status: context.workflowStatus },
      };
    }
    const [tick, queue, brief, run] = await Promise.all([
      readSpec<Tick>(context, "tick"),
      readSpec<Queue>(context, "queue"),
      readSpec<Brief>(context, "brief"),
      readSpec<AgentRun>(context, "run"),
    ]);
    return {
      markdown: renderTickSummary(
        tick,
        queue,
        brief,
        run,
        context.workflowRunId,
      ),
      json: {
        tick,
        queue,
        brief,
        agent: run
          ? {
            binary: run.binary,
            model: run.model,
            durationMs: run.durationMs,
            exitCode: run.exitCode,
            success: run.success,
          }
          : null,
      },
    };
  },
};
