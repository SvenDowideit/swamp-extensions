/**
 * Report extension for @svendowideit/gtd — formats method output as short
 * human summaries printed after method runs.
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

/** Report definition for the GTD summary. */
export const report = {
  name: "@svendowideit/gtd-summary",
  description: "Summarise a GTD method run",
  scope: "method",
  labels: ["gtd", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    await Promise.resolve();
    if (context.executionStatus === "failed") {
      return {
        markdown: `GTD method failed: ${
          context.errorMessage ?? "unknown error"
        }`,
        json: {},
      };
    }

    switch (context.methodName) {
      case "capture":
        return {
          markdown: "Captured into the inbox.",
          json: {},
        };
      case "clarify":
        return {
          markdown: "Clarified inbox items and routed them to GTD lists.",
          json: {},
        };
      case "complete":
        return {
          markdown: "Item completed and logged.",
          json: {},
        };
      case "delegate":
        return {
          markdown: "Item delegated to waiting-for.",
          json: {},
        };
      case "defer":
        return {
          markdown: "Item deferred (calendar or someday-maybe).",
          json: {},
        };
      case "revert":
        return {
          markdown: "Item reverted to the inbox.",
          json: {},
        };
      case "organize":
        return {
          markdown: "Item moved between lists.",
          json: {},
        };
      case "engage":
        return {
          markdown: "Engage: suggested next actions for right now.",
          json: {},
        };
      case "weeklyReview":
        return {
          markdown: "Weekly review logged.",
          json: {},
        };
      case "dailyReview":
        return {
          markdown: "Daily review logged.",
          json: {},
        };
      case "renderBoard":
        return {
          markdown: "GTD board rendered.",
          json: {},
        };
      case "ensureServer":
        return {
          markdown: "GTD web UI server ensured as a systemd user service.",
          json: {},
        };
      default:
        return { markdown: "", json: {} };
    }
  },
};
