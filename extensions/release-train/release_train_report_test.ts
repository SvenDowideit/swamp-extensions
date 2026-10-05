import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  formatCoverage,
  type GraphView,
  type NodeView,
  type PlanView,
  renderDashboard,
  renderExternal,
  renderLegend,
  renderMatrix,
  renderMermaid,
  renderPlan,
  renderReport,
  renderUntested,
  type SummaryView,
  toNodeView,
} from "./release_train_report.ts";

function node(partial: Partial<NodeView>): NodeView {
  return {
    name: "@a/lib",
    manifestPath: "extensions/models/lib/manifest.yaml",
    onDiskVersion: "2026.10.05.1",
    published: { stable: "", rc: "", beta: "2026.10.01.1" },
    installed: { version: "", channel: "" },
    publishState: "needs-publish",
    blockers: [],
    channelAdvice: { channel: "beta", reason: "trend", confidence: "medium" },
    hygiene: {
      manifestModelMatch: true,
      upgradesEntry: true,
      fmtCheck: true,
      workflowValidate: null,
      docsScore: 88,
      docsGrade: "B",
      docsThresholdPass: true,
      reviewState: "ok",
      issues: [],
    },
    tests: {
      unitFiles: 2,
      unitCoverage: 0.74,
      unitFunctionCoverage: 0.8,
      unitCoverageAvailable: true,
      acceptanceDeclared: true,
      acceptanceCount: 3,
      acceptanceCoveredCommands: 2,
      acceptanceDocumentedCommands: 4,
      acceptanceMethodsCovered: 1,
      acceptanceMethods: 2,
      acceptanceWorkflowsCovered: 0,
      acceptanceWorkflows: 1,
      dataStale: false,
    },
    ...partial,
  };
}

const GRAPH: GraphView = {
  nodes: [{
    name: "@a/lib",
    onDiskVersion: "2026.10.05.1",
    publishState: "needs-publish",
    channelAdvice: { channel: "beta", reason: "trend", confidence: "medium" },
  }],
  edges: [{ from: "@a/app", to: "@a/lib", external: false }],
  publishOrder: ["@a/lib", "@a/app"],
  externalNodes: [{
    name: "@ext/x",
    publishedStable: "1.0.0",
    publishedBeta: "",
  }],
  cycle: [],
};

Deno.test("formatCoverage shows n/a when unavailable", () => {
  assertEqualsStr(formatCoverage(null, false), "n/a");
  assertEqualsStr(formatCoverage(0.74, true), "74%");
});

function assertEqualsStr(a: string, b: string): void {
  if (a !== b) throw new Error(`${a} !== ${b}`);
}

Deno.test("renderMermaid embeds name, versions, tests and classes", () => {
  const mmd = renderMermaid(GRAPH, [node({})]);
  assertStringIncludes(mmd, "graph LR");
  assertStringIncludes(mmd, "@a/lib");
  assertStringIncludes(mmd, "2026.10.05.1 ⚠ →beta");
  assertStringIncludes(mmd, "docs 88");
  assertStringIncludes(mmd, "unit 74%");
  assertStringIncludes(mmd, "acc 3");
  assertStringIncludes(mmd, "review ok");
  assertStringIncludes(mmd, ":::needsPublish");
  assertStringIncludes(mmd, ":::external");
  assertStringIncludes(mmd, "n__a_app --> n__a_lib");
});

Deno.test("renderMatrix has a row per node with check marks", () => {
  const md = renderMatrix([
    node({ name: "@a/lib" }),
    node({
      name: "@b/bad",
      hygiene: {
        manifestModelMatch: false,
        upgradesEntry: false,
        fmtCheck: false,
        workflowValidate: false,
        docsScore: 40,
        docsGrade: "D",
        docsThresholdPass: false,
        reviewState: "missing",
        issues: ["docs score 40 below threshold 75"],
      },
    }),
  ]);
  assertStringIncludes(md, "| @a/lib |");
  assertStringIncludes(md, "| @b/bad |");
  assertStringIncludes(md, "✗");
  assertStringIncludes(md, "| 88B |");
});

Deno.test("renderPlan lists ordered commands and blockers", () => {
  const plan: PlanView = {
    steps: [
      {
        order: 1,
        name: "@a/lib",
        state: "ready",
        blockers: [],
        targetChannel: "beta",
        channelReason: "trend",
        command:
          "swamp extension push extensions/models/lib/manifest.yaml --channel beta",
        hygieneFailures: [],
      },
      {
        order: 2,
        name: "@a/app",
        state: "blocked",
        blockers: ["@a/lib"],
        targetChannel: "beta",
        channelReason: "trend",
        command:
          "swamp extension push extensions/models/app/manifest.yaml --channel beta",
        hygieneFailures: ["docs score 40 below threshold 75"],
      },
    ],
  };
  const md = renderPlan(plan);
  assertStringIncludes(md, "| 1 | @a/lib | ready");
  assertStringIncludes(md, "| 2 | @a/app | blocked");
  assertStringIncludes(md, "@a/lib");
  assertStringIncludes(md, "swamp extension push");
  assertStringIncludes(md, "docs score 40");
});

Deno.test("renderPlan reports nothing to publish", () => {
  assertStringIncludes(renderPlan({ steps: [] }), "Nothing needs publishing");
});

Deno.test("renderReport assembles graph, matrix, plan and issues", () => {
  const summary: SummaryView = {
    count: 1,
    upToDateCount: 0,
    needsPublishCount: 1,
    blockedCount: 0,
    unknownCount: 0,
    externalCount: 1,
    hygieneFailureCount: 1,
    hygieneFailures: [{
      name: "@b/bad",
      issue: "docs score 40 below threshold 75",
    }],
    untestedAcceptance: ["@b/bad"],
    staleTestData: ["@b/bad"],
    cycle: [],
  };
  const md = renderReport(
    [node({})],
    GRAPH,
    {
      steps: [{
        order: 1,
        name: "@a/lib",
        state: "ready",
        blockers: [],
        targetChannel: "beta",
        channelReason: "trend",
        command:
          "swamp extension push extensions/models/lib/manifest.yaml --channel beta",
        hygieneFailures: [],
      }],
    },
    summary,
  );
  assertStringIncludes(md, "# Release train");
  assertStringIncludes(md, "## Dependency graph");
  assertStringIncludes(md, "```mermaid");
  assertStringIncludes(md, "## Hygiene and test matrix");
  assertStringIncludes(md, "## Publish plan");
  assertStringIncludes(md, "## Hygiene issues");
  assertStringIncludes(md, "## No acceptance tests declared");
  assertStringIncludes(md, "## Stale meta-factory data");
  assertStringIncludes(md, "## Status");
  assertStringIncludes(md, "## External dependencies");
  assertStringIncludes(md, "## Regenerate");
});

Deno.test("renderLegend explains each publish state", () => {
  const md = renderLegend({
    count: 4,
    upToDateCount: 1,
    needsPublishCount: 1,
    blockedCount: 1,
    unknownCount: 0,
    externalCount: 1,
    hygieneFailureCount: 2,
    hygieneFailures: [],
    untestedAcceptance: [],
    staleTestData: [],
    cycle: [],
  });
  assertStringIncludes(md, "| ✓ up-to-date | 1 |");
  assertStringIncludes(md, "| ⚠ needs-publish | 1 |");
  assertStringIncludes(md, "| ⛔ blocked | 1 |");
  assertStringIncludes(md, "| · external | 1 |");
});

Deno.test("renderExternal lists externals and their local dependents", () => {
  const graph: GraphView = {
    ...GRAPH,
    edges: [...GRAPH.edges, { from: "@a/app", to: "@ext/x", external: true }],
  };
  const md = renderExternal(graph, [
    node({ name: "@a/app", publishState: "blocked" }),
  ]);
  assertStringIncludes(md, "| @ext/x |");
  assertStringIncludes(md, "1.0.0");
  assertStringIncludes(md, "@a/app (blocked)");
});

Deno.test("renderExternal says none when there are no externals", () => {
  const md = renderExternal({ ...GRAPH, externalNodes: [] }, [node({})]);
  assertStringIncludes(md, "None — every dependency is an extension");
});

Deno.test("renderUntested includes manifest paths and unit coverage", () => {
  const md = renderUntested({
    count: 1,
    upToDateCount: 0,
    needsPublishCount: 0,
    blockedCount: 0,
    unknownCount: 0,
    externalCount: 0,
    hygieneFailureCount: 0,
    hygieneFailures: [],
    untestedAcceptance: ["@a/lib"],
    staleTestData: [],
    cycle: [],
  }, [node({})]);
  assertStringIncludes(md, "| @a/lib |");
  assertStringIncludes(md, "`extensions/models/lib/manifest.yaml`");
  assertStringIncludes(md, "74%");
});

Deno.test("renderDashboard renders from raw resources", () => {
  const nodeRaw = {
    name: "@a/lib",
    manifestPath: "extensions/models/lib/manifest.yaml",
    onDiskVersion: "2026.10.05.1",
    published: { stable: "", rc: "", beta: "2026.10.01.1" },
    installed: { version: "", channel: "" },
    publishState: "needs-publish",
    blockers: [],
    channelAdvice: { channel: "beta", reason: "trend", confidence: "medium" },
    hygiene: { reviewState: "ok", issues: [] },
    tests: { unitFiles: 2, unitCoverage: 0.74, unitCoverageAvailable: true },
  };
  const md = renderDashboard(
    [nodeRaw],
    GRAPH as unknown as Record<string, unknown>,
    { steps: [] },
    {
      count: 1,
      upToDateCount: 0,
      needsPublishCount: 1,
      blockedCount: 0,
      unknownCount: 0,
      externalCount: 1,
      hygieneFailureCount: 0,
      hygieneFailures: [],
      untestedAcceptance: [],
      staleTestData: [],
      cycle: [],
    },
  );
  assertStringIncludes(md, "# Release train");
  assertStringIncludes(md, "```mermaid");
  assertStringIncludes(md, "| @a/lib |");
});

Deno.test("toNodeView tolerates a sparse node", () => {
  const v = toNodeView({ name: "@x/y" });
  assertEquals(v.name, "@x/y");
  assertEquals(v.hygiene.reviewState, "unknown");
  assertEquals(v.tests.unitFiles, 0);
});
