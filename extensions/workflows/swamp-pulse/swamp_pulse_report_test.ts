/**
 * Unit tests for the @svendowideit/swamp-pulse-summary report.
 *
 * Run: ~/.swamp/deno/deno test extensions/workflows/swamp-pulse/swamp_pulse_report_test.ts
 *
 * @module
 */

import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { report } from "./swamp_pulse_report.ts";

const ranked = {
  windows: [
    {
      key: "24h",
      label: "Last 24 hours",
      since: "2026-09-17T12:00:00Z",
      until: "2026-09-18T12:00:00Z",
      changes: 1,
      releases: 1,
      issues: 1,
      items: [
        {
          id: "release:r",
          title: "reap stale workers",
          importance: "A",
          kind: "change",
          repo: "swamp-club/swamp",
          date: "2026-09-18T00:00:00Z",
          rationale: "`fix` change",
          docLinks: [
            {
              filename: "design/enablers/datastores.md",
              sourceUrl:
                "https://example.com/blob/abc/design/enablers/datastores.md",
              manualUrl:
                "https://swamp-club.com/manual/reference/datastore-configuration",
            },
          ],
        },
      ],
    },
  ],
  totals: {
    events: 3,
    commits: 1,
    releases: 1,
    issues: 1,
    docChanges: 1,
  },
  manualPages: 158,
  generatedAt: "2026-09-18T12:00:00Z",
};

const MODEL_TYPE = "test/model";
const MODEL_ID = "test-model-id";

/** Build a report context holding one stored artifact. */
function contextWith(
  name: string,
  specName: string,
  document: unknown,
  overrides: {
    methodName?: string;
    executionStatus?: "succeeded" | "failed";
    errorMessage?: string;
    kind?: string;
  } = {},
) {
  const handles = name
    ? [{
      name,
      specName,
      kind: overrides.kind ?? "resource",
      dataId: "d1",
      version: 1,
      size: 1,
      tags: {},
      metadata: {},
    }]
    : [];
  return createReportTestContext({
    modelType: MODEL_TYPE,
    modelId: MODEL_ID,
    methodName: overrides.methodName ?? "rank",
    executionStatus: overrides.executionStatus ?? "succeeded",
    ...(overrides.errorMessage !== undefined
      ? { errorMessage: overrides.errorMessage }
      : {}),
    dataHandles: handles,
    dataArtifacts: name
      ? [{
        modelType: MODEL_TYPE,
        modelId: MODEL_ID,
        data: { name, version: 1 },
        content: new TextEncoder().encode(JSON.stringify(document)),
      }]
      : [],
    // deno-lint-ignore no-explicit-any
  } as any);
}

Deno.test("report declares the expected name and scope", () => {
  assert(report.name === "@svendowideit/swamp-pulse-summary");
  assert(report.scope === "method");
});

Deno.test("report summarises a successful rank run", async () => {
  const ctx = contextWith("ranked", "ranked", ranked);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(ctx.context as any);
  assertStringIncludes(result.markdown, "merged events");
  assertStringIncludes(result.markdown, "Last 24 hours");
  assertStringIncludes(result.markdown, "New / changed documentation");
  assertStringIncludes(result.markdown, "datastores.md");
  const json = result.json as { windows: unknown[]; docChanges: string[] };
  assert(json.windows.length === 1);
  assert(json.docChanges.includes("design/enablers/datastores.md"));
});

Deno.test("report reports a failed method without throwing", async () => {
  const ctx = contextWith("", "", null, {
    executionStatus: "failed",
    errorMessage: "boom",
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(ctx.context as any);
  assertStringIncludes(result.markdown, "failed");
  assertStringIncludes(result.markdown, "boom");
  assert((result.json as { failed: boolean }).failed === true);
});

Deno.test("report handles missing ranked data gracefully", async () => {
  const ctx = contextWith("", "", null);
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(ctx.context as any);
  assertStringIncludes(result.markdown, "No ranked data");
});

Deno.test("report summarises a render run via file handles", async () => {
  const ctx = contextWith("index.html", "summaryPage", null, {
    methodName: "render",
    kind: "file",
  });
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(ctx.context as any);
  assertStringIncludes(result.markdown, "Rendered 1 page(s)");
  assertStringIncludes(result.markdown, "index.html");
});
