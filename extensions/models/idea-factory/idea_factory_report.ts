/**
 * Report extension for @svendowideit/idea-factory — formats the classify/route
 * output as a short human summary printed after the method runs.
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

/** Report definition for the idea-factory summary. */
export const report = {
  name: "@svendowideit/idea-factory-summary",
  description: "Summarise the idea-factory classify/route run",
  scope: "method",
  labels: ["idea-factory", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.executionStatus === "failed") {
      return { markdown: "", json: {} };
    }

    if (context.methodName === "classifyThought") {
      const handle = context.dataHandles.find(
        (h) => h.specName === "classification",
      );
      const markdown = handle
        ? await classificationSummary(context, handle)
        : "No classifications produced.";
      return { markdown, json: {} };
    }

    if (context.methodName === "ingestThought") {
      return {
        markdown: "Thought captured into the inbox.",
        json: {},
      };
    }

    return { markdown: "", json: {} };
  },
};

async function classificationSummary(
  context: MethodReportContext,
  handle: DataHandle,
): Promise<string> {
  const raw = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    handle.name,
    handle.version,
  );
  if (!raw) return "Classification data not found.";
  const r = JSON.parse(new TextDecoder().decode(raw)) as {
    classifications: { thoughtId: string; kind: string; confidence: number }[];
    classifiedAt?: string;
  };
  if (!r.classifications || r.classifications.length === 0) {
    return "No classifications produced.";
  }
  const byKind = new Map<string, number>();
  for (const c of r.classifications) {
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  }
  const lines = [
    "# Idea Factory — classification",
    "",
    `**${r.classifications.length}** thought(s) classified`,
    "",
    "| Kind | Count |",
    "| ---- | ----- |",
  ];
  for (const [kind, count] of [...byKind.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${kind} | ${count} |`);
  }
  return lines.join("\n");
}
