/**
 * Report extension for @svendowideit/meta-factory — renders the documentation
 * score as a readable markdown/JSON breakdown.
 *
 * @module
 */

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

/** One row of the score card's check table. */
export type Check = {
  id: string;
  label: string;
  earned: number;
  max: number;
  status: string;
  note?: string;
};
/** Shape of the `score` resource this report renders. */
export type ScoreData = {
  name: string;
  manifest: string;
  score: number;
  grade: string;
  earned: number;
  earnedMax: number;
  wellDocumented: boolean;
  checks: Check[];
  coverage: { type: string | null; name: string; documented: boolean }[];
  examples: {
    source: string;
    command: string;
    functional: boolean;
    explained: boolean;
  }[];
  nextActions: string[];
  manifestLint: { severity: string; rule: string; message: string }[];
  readmeLint: { severity: string; rule: string; message: string }[];
};
/** Shape of the `rollup` summary resource this report renders. */
export type SummaryData = {
  root: string;
  threshold: number;
  count: number;
  averageScore: number;
  passCount: number;
  failCount: number;
  belowThreshold: {
    name: string;
    manifest: string;
    score: number;
    topIssues: string[];
  }[];
  scores: { name: string; manifest: string; score: number; grade: string }[];
};

/** Report definition rendering the meta-factory documentation score. */
export const report = {
  name: "@svendowideit/meta-factory-report",
  description: "Render the extension documentation score and its breakdown",
  scope: "method",
  labels: ["meta-factory", "docs", "quality"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.executionStatus === "failed") {
      return {
        markdown: `# Meta-factory failed\n\n${context.errorMessage ?? ""}\n`,
        json: { error: true, message: context.errorMessage },
      };
    }

    const summaryHandle = context.dataHandles.find(
      (h) => h.specName === "summary",
    );
    if (summaryHandle) {
      const summary = await readJson<SummaryData>(context, summaryHandle);
      if (summary) {
        return {
          markdown: renderSummary(summary),
          json: summary as unknown as Record<string, unknown>,
        };
      }
    }

    const scoreHandles = context.dataHandles.filter(
      (h) => h.specName === "score",
    );
    if (scoreHandles.length === 0) {
      return { markdown: "", json: {} };
    }

    const scores: ScoreData[] = [];
    for (const handle of scoreHandles) {
      const data = await readJson<ScoreData>(context, handle);
      if (data) scores.push(data);
    }
    if (scores.length === 1) {
      return {
        markdown: renderScore(scores[0]),
        json: scores[0] as unknown as Record<string, unknown>,
      };
    }
    return {
      markdown: scores.map(renderScore).join("\n\n---\n\n"),
      json: { scores },
    };
  },
};

async function readJson<T>(
  context: MethodReportContext,
  handle: DataHandle,
): Promise<T | null> {
  const raw = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    handle.name,
    handle.version,
  );
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    return null;
  }
}

/** Render one extension's detailed score card. */
export function renderScore(s: ScoreData): string {
  const lines: string[] = [];
  lines.push(`# ${s.name} — ${s.score}/100 (${s.grade})`);
  lines.push("");
  lines.push(
    `**${s.earned}/${s.earnedMax} points** · ${
      s.wellDocumented ? "✅ well documented" : "❌ below threshold"
    } · \`${s.manifest}\``,
  );
  lines.push("");
  lines.push("| Check | Score | Status |");
  lines.push("| ----- | ----- | ------ |");
  for (const c of s.checks) {
    const mark = c.status === "pass"
      ? "✅"
      : c.status === "partial"
      ? "◐"
      : "❌";
    lines.push(`| ${c.label} | ${c.earned}/${c.max} | ${mark} ${c.status} |`);
  }

  const missingMethods = (s.coverage ?? []).filter((c) => !c.documented);
  if (missingMethods.length > 0) {
    lines.push("");
    lines.push("## Undocumented methods");
    lines.push("");
    for (const c of missingMethods.slice(0, 20)) {
      lines.push(`- \`${c.type}.${c.name}\``);
    }
    if (missingMethods.length > 20) {
      lines.push(`- … and ${missingMethods.length - 20} more`);
    }
  }

  const examples = s.examples ?? [];
  if (examples.length > 0) {
    lines.push("");
    lines.push("## Examples found");
    lines.push("");
    for (const e of examples) {
      const functional = e.functional ? "✅" : "⚠️ placeholder";
      const explain = e.explained
        ? "explained"
        : /^swamp extension (pull|install)\b/i.test(e.command)
        ? "self-evident"
        : "unexplained";
      lines.push(`- ${functional} · ${explain} [${e.source}] \`${e.command}\``);
    }
  }

  const issues = [
    ...(s.manifestLint ?? []).map((i) => `manifest/${i.rule}: ${i.message}`),
    ...(s.readmeLint ?? []).map((i) => `readme/${i.rule}: ${i.message}`),
  ];
  if (issues.length > 0) {
    lines.push("");
    lines.push("## Structure issues");
    lines.push("");
    for (const issue of issues) lines.push(`- ${issue}`);
  }

  if (s.nextActions.length > 0) {
    lines.push("");
    lines.push("## Next actions");
    lines.push("");
    for (const a of s.nextActions) lines.push(`- ${a}`);
  }
  return lines.join("\n");
}

/** Render the multi-extension rollup. */
export function renderSummary(s: SummaryData): string {
  const lines: string[] = [];
  lines.push("# Extension documentation score");
  lines.push("");
  lines.push(
    `**${s.count}** extensions · average **${s.averageScore}/100** · ` +
      `**${s.passCount}** at or above threshold ${s.threshold} · ` +
      `**${s.failCount}** below`,
  );
  lines.push("");
  lines.push("| Extension | Score | Grade | Manifest |");
  lines.push("| --------- | ----- | ----- | -------- |");
  const sorted = [...s.scores].sort((a, b) => a.score - b.score);
  for (const row of sorted) {
    lines.push(
      `| ${row.name} | ${row.score}/100 | ${row.grade} | \`${row.manifest}\` |`,
    );
  }
  if (s.belowThreshold.length > 0) {
    lines.push("");
    lines.push(`## Below threshold (${s.failCount})`);
    lines.push("");
    for (const b of s.belowThreshold) {
      lines.push(`### ${b.name} — ${b.score}/100`);
      lines.push("");
      for (const issue of b.topIssues) lines.push(`- ${issue}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
