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
/** One function's code metrics, as stored in a `score` resource. */
export type FunctionMetricData = {
  name: string;
  line: number;
  endLine: number;
  complexity: number;
  loc: number;
  coverage: number;
  uncovered: boolean;
  crap: number;
};

/** Per-file code metrics. */
export type FileMetricData = {
  file: string;
  functions: FunctionMetricData[];
  loc: number;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
  coverage: number;
  maxCrap: number;
  averageCrap: number;
};

/** Code metrics block (complexity, coverage, CRAP). */
export type CodeMetricsData = {
  files: number;
  loc: number;
  functions: number;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
  coverage: number;
  functionCoverage: number;
  maxCrap: number;
  averageCrap: number;
  crapScore: number;
  coverageAvailable: boolean;
  byFile: FileMetricData[];
  worstFunctions: FunctionMetricData[];
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
  definitionIssues?: {
    severity: string;
    rule: string;
    message: string;
    path?: string;
  }[];
  codeMetrics?: CodeMetricsData;
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
  scores: {
    name: string;
    manifest: string;
    score: number;
    grade: string;
    codeMetrics?: CodeMetricsData;
  }[];
};

/** Shape of the `definitions` resource this report renders. */
export type DefinitionsData = {
  root: string;
  scanned: number;
  errorCount: number;
  warningCount: number;
  auditAvailable?: boolean;
  auditHours?: number;
  confirmedCount?: number;
  definitions: {
    path: string;
    kind: string;
    name?: string;
    id?: string;
    expectedCommand?: string;
    ok: boolean;
    createConfirmed?: boolean;
  }[];
  issues: { path: string; severity: string; rule: string; message: string }[];
};

/** Report definition rendering the meta-factory documentation score. */
export const report = {
  name: "@svendowideit/meta-factory-report",
  description:
    "Render the extension documentation score, definition-config lint, and their breakdowns",
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

    const definitionsHandle = context.dataHandles.find(
      (h) => h.specName === "definitions",
    );
    if (definitionsHandle) {
      const definitions = await readJson<DefinitionsData>(
        context,
        definitionsHandle,
      );
      if (definitions) {
        return {
          markdown: renderDefinitions(definitions),
          json: definitions as unknown as Record<string, unknown>,
        };
      }
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
    ...(s.definitionIssues ?? []).map((i) =>
      `definition/${i.rule}${i.path ? ` (${i.path})` : ""}: ${i.message}`
    ),
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

  if (s.codeMetrics) {
    lines.push("");
    lines.push(...renderCodeMetrics(s.codeMetrics));
  }
  return lines.join("\n");
}

/**
 * Render the code-metrics block: a summary line, a per-file table, and the
 * worst functions by CRAP score. Reported for information only — none of it
 * feeds the documentation score.
 */
export function renderCodeMetrics(m: CodeMetricsData): string[] {
  const lines: string[] = [];
  lines.push("## Code metrics");
  lines.push("");
  lines.push(
    `**${m.functions}** function(s) across **${m.files}** file(s), **${m.loc}** ` +
      `LOCs · avg complexity **${m.averageComplexity.toFixed(2)}** ` +
      `(max **${m.maxComplexity}**) · coverage **${
        m.coverageAvailable ? `${(m.coverage * 100).toFixed(1)}%` : "n/a"
      }** · **CRAP ${m.crapScore.toFixed(2)}** (avg **${
        m.averageCrap.toFixed(2)
      }**, max **${m.maxCrap.toFixed(1)}**)`,
  );
  if (!m.coverageAvailable) {
    lines.push("");
    lines.push(
      "_No coverage report — the extension has no colocated `*_test.ts` files, " +
        "so the CRAP scores assume 0% coverage._",
    );
  }
  if (m.byFile.length > 0) {
    lines.push("");
    lines.push(
      "| File | Functions | LOC | Avg complexity | Max | Coverage | CRAP |",
    );
    lines.push(
      "| ---- | --------- | --- | -------------- | --- | -------- | ---- |",
    );
    for (const f of m.byFile) {
      lines.push(
        `| \`${f.file}\` | ${f.functions.length} | ${f.loc} | ${
          f.averageComplexity.toFixed(2)
        } | ${f.maxComplexity} | ${
          m.coverageAvailable ? `${(f.coverage * 100).toFixed(0)}%` : "n/a"
        } | ${f.averageCrap.toFixed(2)} |`,
      );
    }
  }
  const worst = (m.worstFunctions ?? []).filter((f) => f.crap > 0).slice(0, 8);
  if (worst.length > 0) {
    lines.push("");
    lines.push("### Highest CRAP");
    lines.push("");
    lines.push("| Function | Line | Complexity | Coverage | CRAP |");
    lines.push("| -------- | ---- | ---------- | -------- | ---- |");
    for (const f of worst) {
      lines.push(
        `| \`${f.name}\` | ${f.line} | ${f.complexity} | ${
          (f.coverage * 100).toFixed(0)
        }% | ${f.crap.toFixed(1)} |`,
      );
    }
  }
  return lines;
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
  lines.push(
    "| Extension | Score | Grade | Functions | Avg complexity | Coverage | CRAP | Manifest |",
  );
  lines.push(
    "| --------- | ----- | ----- | --------- | -------------- | -------- | ---- | -------- |",
  );
  const sorted = [...s.scores].sort((a, b) => a.score - b.score);
  for (const row of sorted) {
    const m = row.codeMetrics;
    const functions = m ? String(m.functions) : "—";
    const avgCx = m ? m.averageComplexity.toFixed(2) : "—";
    const cov = m
      ? (m.coverageAvailable ? `${(m.coverage * 100).toFixed(0)}%` : "n/a")
      : "—";
    const crap = m ? m.crapScore.toFixed(2) : "—";
    lines.push(
      `| ${row.name} | ${row.score}/100 | ${row.grade} | ${functions} | ${avgCx} | ${cov} | ${crap} | \`${row.manifest}\` |`,
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

/** Render the standalone definition-config (creation-command) lint. */
export function renderDefinitions(d: DefinitionsData): string {
  const lines: string[] = [];
  const failed = d.errorCount > 0;
  lines.push(
    `# Definition configs — ${failed ? "❌ FAILED" : "✅ OK"}`,
  );
  lines.push("");
  lines.push(
    `Scanned **${d.scanned}** definition config(s) under \`${d.root}\`: ` +
      `**${d.errorCount}** error(s), **${d.warningCount}** warning(s).`,
  );
  if (d.auditAvailable) {
    lines.push("");
    lines.push(
      `\`swamp audit\` confirmed a creation command for **${
        d.confirmedCount ?? 0
      }**` +
        ` of ${d.scanned} definition(s) modified in the last ${d.auditHours}h` +
        ` window. Unconfirmed definitions were flagged \`create-unconfirmed\`.`,
    );
  } else {
    lines.push("");
    lines.push(
      "_`swamp audit` timeline unavailable — create-command confirmation was skipped._",
    );
  }
  if (d.issues.length > 0) {
    lines.push("");
    lines.push("## Issues");
    lines.push("");
    lines.push("| Definition | Rule | Severity | Detail |");
    lines.push("| ---------- | ---- | -------- | ------ |");
    for (const i of d.issues) {
      lines.push(
        `| \`${i.path}\` | ${i.rule} | ${i.severity} | ${i.message} |`,
      );
    }
  }
  const broken = d.definitions.filter((x) => !x.ok);
  if (broken.length > 0) {
    lines.push("");
    lines.push("## Regenerate with");
    lines.push("");
    for (const b of broken) {
      lines.push(
        `- \`${b.path}\` (${b.kind}): ${
          b.expectedCommand
            ? `\`${b.expectedCommand}\``
            : "a swamp creation command"
        }`,
      );
    }
  }
  return lines.join("\n");
}
