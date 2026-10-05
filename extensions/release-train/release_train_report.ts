/**
 * Report renderer for `@svendowideit/release-train`.
 *
 * This is a workflow-scope report: it runs after the `analyze` step and reads
 * the `node`, `graph`, `plan`, and `summary` resources from the run's
 * `stepExecutions`, then renders the dependency diagram (Mermaid), a per-extension
 * hygiene + test matrix, and the ordered publish plan. The pure renderers take
 * plain view-model objects, so they are unit-tested directly.
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

/** The subset of a `node` resource the report reads. */
export interface NodeView {
  /** Fully-qualified extension name. */
  name: string;
  /** Manifest path relative to the repo root. */
  manifestPath: string;
  /** On-disk version. */
  onDiskVersion: string;
  /** Published versions per channel. */
  published: { stable: string; rc: string; beta: string };
  /** Installed version/channel. */
  installed: { version: string; channel: string };
  /** Publish state. */
  publishState: string;
  /** Where the published versions came from. */
  publishedSource: string;
  /** When a cached published answer was observed, or `""`. */
  publishedAsOf: string;
  /** Dependencies that must publish first. */
  blockers: string[];
  /** Advisory target channel. */
  channelAdvice: { channel: string; reason: string; confidence: string };
  /** Hygiene details. */
  hygiene: {
    manifestModelMatch: boolean;
    upgradesEntry: boolean;
    fmtCheck: boolean | null;
    workflowValidate: boolean | null;
    docsScore: number | null;
    docsGrade: string;
    docsThresholdPass: boolean | null;
    reviewState: string;
    issues: string[];
  };
  /** Test details. */
  tests: {
    unitFiles: number;
    unitCoverage: number | null;
    unitFunctionCoverage: number | null;
    unitCoverageAvailable: boolean;
    acceptanceDeclared: boolean;
    acceptanceCount: number | null;
    acceptanceCoveredCommands: number;
    acceptanceDocumentedCommands: number;
    acceptanceMethodsCovered: number;
    acceptanceMethods: number;
    acceptanceWorkflowsCovered: number;
    acceptanceWorkflows: number;
    dataStale: boolean;
  };
}

/** Advisory channel for a graph node. */
export interface AdviceView {
  /** Advised channel, or `""`. */
  channel: string;
  /** Why that channel was advised. */
  reason: string;
  /** Heuristic confidence. */
  confidence: string;
}

/** A graph node. */
export interface GraphNodeView {
  /** Fully-qualified extension name. */
  name: string;
  /** On-disk version. */
  onDiskVersion: string;
  /** Publish state. */
  publishState: string;
  /** Advisory target channel. */
  channelAdvice: AdviceView;
}

/** A dependency edge. */
export interface GraphEdgeView {
  /** Dependent extension. */
  from: string;
  /** Dependency. */
  to: string;
  /** True when the dependency is external. */
  external: boolean;
}

/** An external dependency node. */
export interface ExternalNodeView {
  /** Fully-qualified extension name. */
  name: string;
  /** Latest published stable version, or `""`. */
  publishedStable: string;
  /** Latest published beta version, or `""`. */
  publishedBeta: string;
}

/** The subset of a `graph` resource the report reads. */
export interface GraphView {
  /** Graph nodes. */
  nodes: GraphNodeView[];
  /** Dependency edges. */
  edges: GraphEdgeView[];
  /** Topological publish order. */
  publishOrder: string[];
  /** External dependency nodes. */
  externalNodes: ExternalNodeView[];
  /** Members of a dependency cycle, if any. */
  cycle: string[];
}

/** One publish-plan step. */
export interface PlanStepView {
  /** 1-based position. */
  order: number;
  /** Extension to publish. */
  name: string;
  /** Ready or blocked. */
  state: string;
  /** Dependencies that must publish first. */
  blockers: string[];
  /** Advised channel. */
  targetChannel: string;
  /** Why that channel was advised. */
  channelReason: string;
  /** Exact push command. */
  command: string;
  /** Hygiene failures to fix first. */
  hygieneFailures: string[];
}

/** The subset of a `plan` resource the report reads. */
export interface PlanView {
  /** Ordered plan steps. */
  steps: PlanStepView[];
}

/** One hygiene failure pair. */
export interface FailureView {
  /** Extension the failure belongs to. */
  name: string;
  /** The failure text. */
  issue: string;
}

/** The subset of a `summary` resource the report reads. */
export interface SummaryView {
  /** Extensions analysed. */
  count: number;
  /** Count already published at the on-disk version. */
  upToDateCount: number;
  /** Count that need publishing. */
  needsPublishCount: number;
  /** Count blocked on a dependency. */
  blockedCount: number;
  /** Count whose published state could not be determined (registry unreachable). */
  unknownCount: number;
  /** Count of external dependencies. */
  externalCount: number;
  /** Count whose published versions came from a previous run's cache. */
  cachedCount: number;
  /** Count whose published versions came only from the lockfile. */
  lockfileOnlyCount: number;
  /** Count with at least one hygiene issue. */
  hygieneFailureCount: number;
  /** Every hygiene issue. */
  hygieneFailures: FailureView[];
  /** Extensions with no acceptance tests declared. */
  untestedAcceptance: string[];
  /** Extensions whose meta-factory data predates the on-disk version. */
  staleTestData: string[];
  /** Members of a dependency cycle, if any. */
  cycle: string[];
}

/** Escape a value for a GitHub-flavoured markdown table cell. */
function cell(value: string): string {
  return String(value).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/** Coerce an unknown object to a string. */
function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Coerce an unknown object to a number, or `null`. */
function n(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Coerce an unknown object to a boolean, or `null`. */
function b(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** A `✓`/`✗`/`?` mark for a nullable boolean. */
function mark(v: boolean | null): string {
  return v === true ? "✓" : v === false ? "✗" : "?";
}

/** Format a unit coverage fraction as a percentage, or `n/a`. */
export function formatCoverage(
  coverage: number | null,
  available: boolean,
): string {
  if (!available || coverage === null) return "n/a";
  return `${Math.round(coverage * 100)}%`;
}

/** A stable Mermaid node id for an extension name. */
function nodeId(name: string): string {
  return "n_" + name.replace(/[^A-Za-z0-9]/g, "_");
}

/**
 * The swamp-club colour scheme for one publish state.
 *
 * Colours mirror `@svendowideit/swamp-pulse`'s tier palette (a dark theme with
 * neon accents): a dark tinted fill, a bright stroke, and an explicit bright
 * `color` for the label text so a node is legible on a light *or* dark Mermaid
 * renderer (GitHub honours `prefers-color-scheme`, so an implicit text colour
 * would otherwise become light-on-light).
 */
export interface StateColour {
  /** Mermaid class name. */
  class: string;
  /** Human colour name for the legend. */
  name: string;
  /** Emoji swatch, for the markdown legend (GitHub renders emoji). */
  swatch: string;
  /** Node fill. */
  fill: string;
  /** Node border. */
  stroke: string;
  /** Explicit label text colour. */
  color: string;
}

/** swamp-club colours per publish state (single source of truth). */
export const STATE_COLOURS: Record<string, StateColour> = {
  "up-to-date": {
    class: "upToDate",
    name: "green",
    swatch: "🟩",
    fill: "#12301a",
    stroke: "#39ff14",
    color: "#7dff9b",
  },
  "needs-publish": {
    class: "needsPublish",
    name: "amber",
    swatch: "🟨",
    fill: "#3a2c0d",
    stroke: "#ffb000",
    color: "#ffd98a",
  },
  blocked: {
    class: "blocked",
    name: "red",
    swatch: "🟥",
    fill: "#3a0d0d",
    stroke: "#ff6b6b",
    color: "#ff9b9b",
  },
  unknown: {
    class: "unknown",
    name: "magenta",
    swatch: "🟪",
    fill: "#2a1030",
    stroke: "#ff4dd2",
    color: "#ff9be8",
  },
  external: {
    class: "external",
    name: "grey",
    swatch: "⬜",
    fill: "#182028",
    stroke: "#7fa88a",
    color: "#b8d0be",
  },
};

/** The Mermaid `classDef` lines for every publish state, in palette order. */
export const MERMAID_CLASS_DEFS: string[] = Object.values(STATE_COLOURS).map(
  (c) =>
    `  classDef ${c.class} fill:${c.fill},stroke:${c.stroke},color:${c.color};`,
);

/** Mermaid class for a publish state. */
function classOf(publishState: string): string {
  return STATE_COLOURS[publishState]?.class ?? STATE_COLOURS.external.class;
}

/** The status icon shown in a node label. */
function stateIcon(publishState: string): string {
  return publishState === "blocked"
    ? "⛔"
    : publishState === "needs-publish"
    ? "⚠"
    : publishState === "unknown"
    ? "?"
    : publishState === "up-to-date"
    ? "✓"
    : "·";
}

/**
 * Render the dependency diagram as Mermaid.
 *
 * Pure: takes the graph and the richer node list so each node can carry its
 * docs score, unit coverage, acceptance count, and review state in the label.
 * Status is both colour-coded (a class) and shown as an icon, so the diagram is
 * readable even when rendered without the theme styles.
 */
export function renderMermaid(graph: GraphView, nodes: NodeView[]): string {
  const byName = new Map(nodes.map((nd) => [nd.name, nd]));
  const lines: string[] = ["graph LR"];
  for (const g of graph.nodes) {
    const nd = byName.get(g.name);
    const advice = g.channelAdvice.channel
      ? `→${g.channelAdvice.channel}`
      : "—";
    const docs =
      nd?.hygiene.docsScore !== null && nd?.hygiene.docsScore !== undefined
        ? `docs ${nd.hygiene.docsScore}`
        : "docs n/a";
    const unit = nd
      ? `unit ${
        formatCoverage(nd.tests.unitCoverage, nd.tests.unitCoverageAvailable)
      }`
      : "unit n/a";
    const acc = nd
      ? `acc ${
        nd.tests.acceptanceDeclared || (nd.tests.acceptanceCount ?? 0) > 0
          ? `${
            nd.tests.acceptanceCount ??
              (nd.tests.acceptanceDeclared ? "declared" : 0)
          }`
          : "0"
      }`
      : "acc n/a";
    const review = nd ? nd.hygiene.reviewState : "unknown";
    const label =
      `${g.name}<br/>${g.onDiskVersion || "?"} ${
        stateIcon(g.publishState)
      } ${advice}<br/>` +
      `${docs} · ${unit} · ${acc} · review ${review}`;
    lines.push(
      `  ${nodeId(g.name)}["${label}"]:::${classOf(g.publishState)}`,
    );
  }
  for (const ext of graph.externalNodes) {
    const pub = ext.publishedStable || ext.publishedBeta || "unpublished";
    lines.push(
      `  ${nodeId(ext.name)}["${ext.name}<br/>external ${pub}"]:::external`,
    );
  }
  for (const edge of graph.edges) {
    lines.push(`  ${nodeId(edge.from)} --> ${nodeId(edge.to)}`);
  }
  lines.push(...MERMAID_CLASS_DEFS);
  return lines.join("\n") + "\n";
}

/** Render the per-extension hygiene + test matrix as markdown. */
export function renderMatrix(nodes: NodeView[]): string {
  const lines: string[] = [];
  lines.push("## Hygiene and test matrix");
  lines.push("");
  lines.push(
    "| Extension | Version | Pub stable/rc/beta | Source | State | Manifest=model | Upgrades | fmt | wf | Docs | Review | Unit | Unit cov | Acc tests | Issues |",
  );
  lines.push(
    "| --------- | ------- | ---------- | ------ | ----- | -------------- | -------- | --- | -- | ---- | ------ | ---- | -------- | --------- | ------ |",
  );
  const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  for (const nd of sorted) {
    const pub = `${nd.published.stable || "—"}/${nd.published.rc || "—"}/${
      nd.published.beta || "—"
    }`;
    const docs = nd.hygiene.docsScore !== null
      ? `${nd.hygiene.docsScore}${nd.hygiene.docsGrade}`
      : "n/a";
    const acc = nd.tests.acceptanceDeclared
      ? `${nd.tests.acceptanceCount ?? "?"}`
      : "0";
    const issues = nd.hygiene.issues.length === 0
      ? "—"
      : `${nd.hygiene.issues.length}`;
    lines.push(
      `| ${cell(nd.name)} | ${cell(nd.onDiskVersion)} | ${pub} | ${
        cell(sourceLabel(nd))
      } | ${cell(nd.publishState)} | ` +
        `${mark(nd.hygiene.manifestModelMatch)} | ${
          mark(nd.hygiene.upgradesEntry)
        } | ` +
        `${mark(nd.hygiene.fmtCheck)} | ${
          mark(nd.hygiene.workflowValidate)
        } | ` +
        `${cell(docs)} | ${cell(nd.hygiene.reviewState)} | ` +
        `${nd.tests.unitFiles} | ${
          formatCoverage(nd.tests.unitCoverage, nd.tests.unitCoverageAvailable)
        } | ` +
        `${acc} | ${issues} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * A short label for where an extension's published versions came from, so a
 * cached/offline answer is visibly distinguished from a live registry one.
 */
export function sourceLabel(nd: NodeView): string {
  switch (nd.publishedSource) {
    case "registry":
      return "registry";
    case "cache":
      return nd.publishedAsOf
        ? `cache ${nd.publishedAsOf.slice(0, 10)}`
        : "cache";
    case "lockfile":
      return "lockfile";
    default:
      return "none";
  }
}

/** Render the ordered publish plan as markdown. */
export function renderPlan(plan: PlanView): string {
  const lines: string[] = [];
  lines.push("## Publish plan");
  lines.push("");
  if (plan.steps.length === 0) {
    lines.push("Nothing needs publishing.");
    lines.push("");
    return lines.join("\n") + "\n";
  }
  lines.push(
    "| # | Extension | State | Channel | Command | Blockers | Hygiene |",
  );
  lines.push(
    "| - | --------- | ----- | ------- | ------- | -------- | ------- |",
  );
  for (const step of plan.steps) {
    const blockers = step.blockers.length ? step.blockers.join(", ") : "—";
    const hygiene = step.hygieneFailures.length
      ? step.hygieneFailures.join("; ")
      : "—";
    lines.push(
      `| ${step.order} | ${cell(step.name)} | ${cell(step.state)} | ` +
        `${cell(step.targetChannel)} (${cell(step.channelReason)}) | ` +
        "`" + cell(step.command) + "` | " +
        `${cell(blockers)} | ${cell(hygiene)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Render the status legend as a markdown table. */
export function renderLegend(summary: SummaryView): string {
  const lines: string[] = [];
  lines.push("## Status");
  lines.push("");
  lines.push(
    "_The table below is also the diagram's colour key: each state maps to the " +
      "swamp-club palette (`fill`, `stroke`, label text) used for that node in " +
      "the Mermaid diagram._",
  );
  lines.push("");
  lines.push("| Swatch | State | Colour | Count | Meaning |");
  lines.push("| ------ | ----- | ------ | ----- | ------- |");
  const c = (k: string) => STATE_COLOURS[k];
  lines.push(
    `| ${c("up-to-date").swatch} | ✓ up-to-date | ${
      c("up-to-date").name
    } | ${summary.upToDateCount} | On-disk version already published on a channel. |`,
  );
  lines.push(
    `| ${c("needs-publish").swatch} | ⚠ needs-publish | ${
      c("needs-publish").name
    } | ${summary.needsPublishCount} | On-disk version is ahead of every published channel — publish it. |`,
  );
  lines.push(
    `| ${c("blocked").swatch} | ⛔ blocked | ${
      c("blocked").name
    } | ${summary.blockedCount} | A dependency must publish before this one. |`,
  );
  lines.push(
    `| ${c("unknown").swatch} | ? unknown | ${
      c("unknown").name
    } | ${summary.unknownCount} | The registry was unreachable, so the published state could not be determined. |`,
  );
  lines.push(
    `| ${c("external").swatch} | · external | ${
      c("external").name
    } | ${summary.externalCount} | A dependency outside this repo (published elsewhere). |`,
  );
  lines.push(
    `| — | — with hygiene issues | — | ${summary.hygieneFailureCount} | Has at least one failing release-hygiene check (see below). |`,
  );
  return lines.join("\n") + "\n";
}

/** Render the external dependency table. */
export function renderExternal(graph: GraphView, nodes: NodeView[]): string {
  const lines: string[] = [];
  lines.push("## External dependencies");
  lines.push("");
  if (graph.externalNodes.length === 0) {
    lines.push("None — every dependency is an extension in this repository.");
    lines.push("");
    return lines.join("\n") + "\n";
  }
  // Which local extensions depend on each external node.
  const dependents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge.external) continue;
    const list = dependents.get(edge.to) ?? [];
    list.push(edge.from);
    dependents.set(edge.to, list);
  }
  const localPublish = new Map(nodes.map((nd) => [nd.name, nd.publishState]));
  lines.push(
    "| External extension | Published stable | Published beta | Depended on by |",
  );
  lines.push(
    "| ------------------ | ---------------- | -------------- | -------------- |",
  );
  for (
    const ext of [...graph.externalNodes].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  ) {
    const users = (dependents.get(ext.name) ?? [])
      .map((u) => `${u} (${localPublish.get(u) ?? "?"})`)
      .join(", ");
    lines.push(
      `| ${cell(ext.name)} | ${cell(ext.publishedStable || "—")} | ` +
        `${cell(ext.publishedBeta || "—")} | ${cell(users || "—")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Render the "no acceptance tests declared" table. */
export function renderUntested(
  summary: SummaryView,
  nodes: NodeView[],
): string {
  const lines: string[] = [];
  lines.push("## No acceptance tests declared");
  lines.push("");
  const byName = new Map(nodes.map((nd) => [nd.name, nd]));
  lines.push("| Extension | Manifest | Unit tests | Unit coverage |");
  lines.push("| --------- | -------- | ---------- | ------------- |");
  if (summary.untestedAcceptance.length === 0) {
    lines.push("| — | — | — | Every extension declares acceptance tests. |");
  } else {
    for (
      const name of [...summary.untestedAcceptance].sort((a, b) =>
        a.localeCompare(b)
      )
    ) {
      const nd = byName.get(name);
      lines.push(
        `| ${cell(name)} | \`${cell(nd?.manifestPath ?? "")}\` | ` +
          `${nd?.tests.unitFiles ?? 0} | ` +
          `${
            nd
              ? formatCoverage(
                nd.tests.unitCoverage,
                nd.tests.unitCoverageAvailable,
              )
              : "n/a"
          } |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the full dashboard as one GitHub-renderable markdown document.
 *
 * GitHub (and gist) renders the fenced ```mermaid block as a diagram and every
 * markdown table natively, so this single string is the whole deliverable.
 */
export function renderReport(
  nodes: NodeView[],
  graph: GraphView,
  plan: PlanView,
  summary: SummaryView,
): string {
  const lines: string[] = [];
  const generated = new Date().toISOString().replace("T", " ").replace(
    /\.\d+Z$/,
    " UTC",
  );
  lines.push("# Release train");
  lines.push("");
  lines.push(`_Generated ${generated}_`);
  lines.push("");
  lines.push(
    `**${summary.count}** extension(s) · **${summary.upToDateCount}** up-to-date · ` +
      `**${summary.needsPublishCount}** need publishing · ` +
      `**${summary.blockedCount}** blocked · **${summary.unknownCount}** unknown · ` +
      `**${summary.externalCount}** external · ` +
      `**${summary.hygieneFailureCount}** with hygiene issues`,
  );
  lines.push("");
  lines.push(
    "> Read-only: this report publishes nothing. Channel targets are advisory; " +
      "the final choice is yours.",
  );
  if (summary.cycle.length > 0) {
    lines.push("");
    lines.push(
      `> ⚠ Dependency cycle detected (order broken deterministically): ${
        summary.cycle.join(", ")
      }`,
    );
  }
  if (summary.unknownCount > 0) {
    lines.push("");
    lines.push(
      `> ⚠ **${summary.unknownCount}** extension(s) are **unknown**: they are ` +
        "ahead of the only published versions this run could confirm (a lockfile " +
        "lower bound or a previous run's data), so release-train cannot say " +
        "whether they need publishing. This is missing information, not a " +
        "publish requirement. Re-run online to confirm.",
    );
  }
  if (summary.cachedCount > 0 || summary.lockfileOnlyCount > 0) {
    lines.push("");
    const parts: string[] = [];
    if (summary.cachedCount > 0) {
      parts.push(
        `**${summary.cachedCount}** from a **previous run** (see the ` +
          "`Source` column — may be out of date)",
      );
    }
    if (summary.lockfileOnlyCount > 0) {
      parts.push(
        `**${summary.lockfileOnlyCount}** from the **lockfile only** ` +
          "(a lower bound; the registry was not consulted)",
      );
    }
    lines.push(
      `> ℹ Published versions this run: ${parts.join("; ")}. ` +
        "Re-run online for authoritative versions.",
    );
  }
  lines.push("");
  lines.push(renderLegend(summary));
  lines.push("## Dependency graph");
  lines.push("");
  lines.push(
    "_Edge direction is **dependent → dependency**; nodes are coloured by " +
      "publish state and labelled with docs score, unit coverage, acceptance " +
      "count, and review state._",
  );
  lines.push("");
  lines.push("```mermaid");
  lines.push(renderMermaid(graph, nodes).trimEnd());
  lines.push("```");
  lines.push("");
  lines.push(renderMatrix(nodes));
  lines.push(renderPlan(plan));
  lines.push(renderExternal(graph, nodes));
  lines.push(renderUntested(summary, nodes));

  if (summary.hygieneFailures.length > 0) {
    lines.push("## Hygiene issues");
    lines.push("");
    lines.push("| Extension | Issue |");
    lines.push("| --------- | ----- |");
    for (const { name, issue } of summary.hygieneFailures) {
      lines.push(`| ${cell(name)} | ${cell(issue)} |`);
    }
    lines.push("");
  }
  if (summary.staleTestData.length > 0) {
    lines.push("## Stale meta-factory data (recompute needed)");
    lines.push("");
    lines.push(
      "| Extension | Issue |\n| --------- | ----- |\n" +
        summary.staleTestData.map((name) =>
          `| ${cell(name)} | meta-factory data predates the on-disk version |`
        ).join("\n"),
    );
    lines.push("");
  }

  lines.push("## Regenerate");
  lines.push("");
  lines.push("```sh");
  lines.push("swamp workflow run @svendowideit/release-train");
  lines.push("# then read this document:");
  lines.push(
    "swamp report get @svendowideit/release-train-report \\\n" +
      "  --workflow @svendowideit/release-train --markdown",
  );
  lines.push("```");
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Render the dashboard from raw resource objects.
 *
 * A convenience for the `analyze` method, which has the freshly-written
 * resources in hand and no workflow context: it converts the `node` resources to
 * views and casts the singleton `graph`/`plan`/`summary` objects, then renders
 * the same document the report emits. The output markdown is GitHub/gist
 * renderable (fenced mermaid + tables).
 */
export function renderDashboard(
  nodeRaws: Record<string, unknown>[],
  graphRaw: Record<string, unknown>,
  planRaw: Record<string, unknown>,
  summaryRaw: Record<string, unknown>,
): string {
  const nodes = nodeRaws.map(toNodeView);
  const graph = graphRaw as unknown as GraphView;
  const plan = (planRaw ?? { steps: [] }) as unknown as PlanView;
  const summary = (summaryRaw ?? {
    count: nodes.length,
    upToDateCount: 0,
    needsPublishCount: 0,
    blockedCount: 0,
    unknownCount: 0,
    cachedCount: 0,
    lockfileOnlyCount: 0,
    externalCount: 0,
    hygieneFailureCount: 0,
    hygieneFailures: [],
    untestedAcceptance: [],
    staleTestData: [],
    cycle: [],
  }) as unknown as SummaryView;
  return renderReport(nodes, graph, plan, summary);
}

/** Parse a `node` resource into a typed view. */
export function toNodeView(raw: Record<string, unknown>): NodeView {
  const published = (raw.published ?? {}) as Record<string, unknown>;
  const installed = (raw.installed ?? {}) as Record<string, unknown>;
  const hygiene = (raw.hygiene ?? {}) as Record<string, unknown>;
  const tests = (raw.tests ?? {}) as Record<string, unknown>;
  return {
    name: s(raw.name),
    manifestPath: s(raw.manifestPath),
    onDiskVersion: s(raw.onDiskVersion),
    published: {
      stable: s(published.stable),
      rc: s(published.rc),
      beta: s(published.beta),
    },
    installed: {
      version: s(installed.version),
      channel: s(installed.channel),
    },
    publishState: s(raw.publishState),
    publishedSource: s(raw.publishedSource) || "registry",
    publishedAsOf: s(raw.publishedAsOf),
    blockers: Array.isArray(raw.blockers) ? raw.blockers.map(s) : [],
    channelAdvice: {
      channel: s((raw.channelAdvice as Record<string, unknown>)?.channel),
      reason: s((raw.channelAdvice as Record<string, unknown>)?.reason),
      confidence: s((raw.channelAdvice as Record<string, unknown>)?.confidence),
    },
    hygiene: {
      manifestModelMatch: hygiene.manifestModelMatch !== false,
      upgradesEntry: hygiene.upgradesEntry !== false,
      fmtCheck: b(hygiene.fmtCheck),
      workflowValidate: b(hygiene.workflowValidate),
      docsScore: n(hygiene.docsScore),
      docsGrade: s(hygiene.docsGrade),
      docsThresholdPass: b(hygiene.docsThresholdPass),
      reviewState: s(hygiene.reviewState) || "unknown",
      issues: Array.isArray(hygiene.issues) ? hygiene.issues.map(s) : [],
    },
    tests: {
      unitFiles: n(tests.unitFiles) ?? 0,
      unitCoverage: n(tests.unitCoverage),
      unitFunctionCoverage: n(tests.unitFunctionCoverage),
      unitCoverageAvailable: tests.unitCoverageAvailable === true,
      acceptanceDeclared: tests.acceptanceDeclared === true,
      acceptanceCount: n(tests.acceptanceCount),
      acceptanceCoveredCommands: n(tests.acceptanceCoveredCommands) ?? 0,
      acceptanceDocumentedCommands: n(tests.acceptanceDocumentedCommands) ?? 0,
      acceptanceMethodsCovered: n(tests.acceptanceMethodsCovered) ?? 0,
      acceptanceMethods: n(tests.acceptanceMethods) ?? 0,
      acceptanceWorkflowsCovered: n(tests.acceptanceWorkflowsCovered) ?? 0,
      acceptanceWorkflows: n(tests.acceptanceWorkflows) ?? 0,
      dataStale: tests.dataStale === true,
    },
  };
}

/** Collect every resource of one spec kind from the run's step executions. */
async function collect(
  context: WorkflowReportContext,
  specName: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
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
      try {
        out.push(JSON.parse(new TextDecoder().decode(raw)));
      } catch {
        // Skip an unreadable resource rather than fail the report.
      }
    }
  }
  return out;
}

/** Report definition rendering the release-train dashboard. */
export const report = {
  name: "@svendowideit/release-train-report",
  description:
    "Dependency diagram, hygiene/test matrix, and ordered publish plan across every analysed extension",
  scope: "workflow" as const,
  labels: ["release-train", "release", "dependencies"],
  execute: async (
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.workflowStatus === "failed") {
      return {
        markdown:
          "# Release train unavailable\n\nThe workflow run did not succeed.\n",
        json: { error: true, status: context.workflowStatus },
      };
    }
    const nodes = (await collect(context, "node")).map(toNodeView);
    const graphRaws = await collect(context, "graph");
    const planRaws = await collect(context, "plan");
    const summaryRaws = await collect(context, "summary");

    if (nodes.length === 0 || graphRaws.length === 0) {
      return {
        markdown: "# Release train\n\nNo extension was analysed in this run.\n",
        json: { error: true, message: "no data" },
      };
    }

    const graph = graphRaws[0] as unknown as GraphView;
    const plan = (planRaws[0] ?? { steps: [] }) as unknown as PlanView;
    const summary = (summaryRaws[0] ?? {
      count: nodes.length,
      upToDateCount: 0,
      needsPublishCount: 0,
      blockedCount: 0,
      unknownCount: 0,
      cachedCount: 0,
      lockfileOnlyCount: 0,
      externalCount: 0,
      hygieneFailureCount: 0,
      hygieneFailures: [],
      untestedAcceptance: [],
      staleTestData: [],
      cycle: [],
    }) as unknown as SummaryView;

    const markdown = renderReport(nodes, graph, plan, summary);
    return { markdown, json: { summary, graph, plan, nodes } };
  },
};
