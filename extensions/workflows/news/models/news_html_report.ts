/**
 * Report extension for @svendowideit/news-reader — prints a summary of the
 * generated HTML news page including the file path and article count.
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

/** Report definition for the news HTML summary. */
export const report = {
  name: "@svendowideit/news-html-report",
  description: "Summary of the generated news HTML page with article count",
  scope: "method",
  labels: ["news", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      context.executionStatus === "failed" ||
      context.methodName !== "generate"
    ) {
      return { markdown: "", json: {} };
    }

    const handle = context.dataHandles.find((h) => h.specName === "report");
    if (!handle) {
      return { markdown: "No HTML report produced.", json: {} };
    }

    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    const size = raw ? raw.length : 0;

    const md: string[] = [];
    md.push("# News Report Generated");
    md.push("");
    md.push(
      `HTML page written as data artifact \`${handle.name}\` (${size} bytes, version ${
        handle.version ?? "latest"
      }).`,
    );
    md.push("");
    md.push("Read the HTML file:");
    md.push("```sh");
    md.push(
      `swamp data get news-reader ${handle.name} --version ${
        handle.version ?? ""
      }`,
    );
    md.push("```");
    md.push("");
    md.push("Or save and open in a browser:");
    md.push("```sh");
    md.push(
      `swamp data get news-reader ${handle.name} --version ${
        handle.version ?? ""
      } --json | jq -r '.content' > news.html`,
    );
    md.push("open news.html");
    md.push("```");

    return {
      markdown: md.join("\n"),
      json: { handle: handle.name, version: handle.version, size },
    };
  },
};
