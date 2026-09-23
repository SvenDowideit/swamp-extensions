/**
 * Scoreboard report for @svendowideit/meta-factory — a compact text table of
 * every extension scored by a workflow run, with the reasons each one is not a
 * perfect 100.
 *
 * This is a workflow-scope report: it runs after the workflow completes and
 * reads the `score` resources the `checkAll` step produced from the workflow's
 * `stepExecutions`, so the table is emitted as part of the run.
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

/** One row of a score card's check table, as stored in a `score` resource. */
export type ScoreboardCheck = {
  id: string;
  label: string;
  earned: number;
  max: number;
  status: string;
  note?: string;
};

/** The subset of a `score` resource the scoreboard reads. */
export type ScoreboardScore = {
  name: string;
  manifest: string;
  score: number;
  grade: string;
  earned: number;
  earnedMax: number;
  checks: ScoreboardCheck[];
  nextActions?: string[];
  manifestLint?: { severity: string; rule: string; message: string }[];
  readmeLint?: { severity: string; rule: string; message: string }[];
  definitionIssues?: {
    severity: string;
    rule: string;
    message: string;
    path?: string;
  }[];
};

/** A rendered scoreboard row. */
export type ScoreboardRow = {
  name: string;
  manifest: string;
  score: number;
  grade: string;
  reasons: string[];
};

/**
 * Build the compact reason list for an extension that scored below 100.
 *
 * Prefers the score card's `nextActions` — the scorer's own deduplicated list
 * of the failing checks and what to do about each. It falls back to deriving
 * reasons from the non-passing checks for older score data that predates the
 * field.
 */
export function reasonsFor(s: ScoreboardScore): string[] {
  if (s.nextActions && s.nextActions.length > 0) return s.nextActions;
  const reasons: string[] = [];
  for (const c of s.checks ?? []) {
    if (c.status === "pass") continue;
    reasons.push(`${c.id}: ${c.note ?? `${c.earned}/${c.max}`}`);
  }
  return reasons;
}

/** Sort scores by ascending score, then name, for a stable leaderboard. */
export function sortScores(scores: ScoreboardScore[]): ScoreboardScore[] {
  return [...scores].sort(
    (a, b) => a.score - b.score || a.name.localeCompare(b.name),
  );
}

/** Build the scoreboard rows from every scored extension. */
export function buildScoreboard(scores: ScoreboardScore[]): ScoreboardRow[] {
  return sortScores(scores).map((s) => ({
    name: s.name,
    manifest: s.manifest,
    score: s.score,
    grade: s.grade,
    reasons: s.score >= 100 ? [] : reasonsFor(s),
  }));
}

/** Escape a value for a GitHub-flavoured markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/**
 * Render the scoreboard as a markdown text table.
 *
 * A `Score` / `Grade` / `Reason` table lists every extension, lowest score
 * first; the reason column is `—` for a perfect 100. A final section repeats the
 * full reason list for the imperfect extensions, since a table cell cannot hold
 * a long explanation legibly.
 */
export function renderScoreboard(rows: ScoreboardRow[]): string {
  const lines: string[] = [];
  const perfect = rows.filter((r) => r.reasons.length === 0).length;
  const average = rows.length > 0
    ? Math.round(rows.reduce((sum, r) => sum + r.score, 0) / rows.length)
    : 0;

  lines.push("# Extension scoreboard");
  lines.push("");
  lines.push(
    `**${rows.length}** extension(s) · average **${average}/100** · ` +
      `**${perfect}** perfect · **${rows.length - perfect}** with reasons`,
  );
  lines.push("");
  lines.push("| Extension | Score | Grade | Reason not 100 |");
  lines.push("| --------- | ----- | ----- | -------------- |");
  for (const r of rows) {
    const reason = r.reasons.length === 0
      ? "—"
      : `${r.reasons.length} issue(s)`;
    lines.push(
      `| ${cell(r.name)} | ${r.score}/100 | ${r.grade} | ${cell(reason)} |`,
    );
  }

  const imperfect = rows.filter((r) => r.reasons.length > 0);
  if (imperfect.length > 0) {
    lines.push("");
    lines.push("## Reasons");
    lines.push("");
    for (const r of imperfect) {
      lines.push(`### ${r.name} — ${r.score}/100 (${r.grade})`);
      lines.push("");
      for (const reason of r.reasons) lines.push(`- ${reason}`);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Read and parse every `score` resource from a workflow's step executions. */
async function collectScores(
  context: WorkflowReportContext,
): Promise<ScoreboardScore[]> {
  const scores: ScoreboardScore[] = [];
  for (const step of context.stepExecutions) {
    for (const handle of step.dataHandles) {
      if (handle.specName !== "score") continue;
      const raw = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        handle.name,
        handle.version,
      );
      if (!raw) continue;
      try {
        scores.push(
          JSON.parse(new TextDecoder().decode(raw)) as ScoreboardScore,
        );
      } catch {
        // Skip an unreadable score rather than failing the whole report.
      }
    }
  }
  return scores;
}

/** Report definition rendering the multi-extension scoreboard table. */
export const report = {
  name: "@svendowideit/meta-factory-scoreboard",
  description:
    "Compact text table of every scored extension with the reasons each is not 100/100",
  scope: "workflow",
  labels: ["meta-factory", "docs", "quality", "scoreboard"],
  execute: async (
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.workflowStatus === "failed") {
      return {
        markdown:
          `# Scoreboard unavailable\n\nThe workflow run did not succeed.\n`,
        json: { error: true, status: context.workflowStatus },
      };
    }

    const rows = buildScoreboard(await collectScores(context));
    return {
      markdown: rows.length === 0
        ? "# Extension scoreboard\n\nNo extension scored in this run.\n"
        : renderScoreboard(rows),
      json: { count: rows.length, rows },
    };
  },
};
