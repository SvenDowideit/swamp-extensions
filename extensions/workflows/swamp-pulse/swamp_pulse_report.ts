/**
 * Report extension for @svendowideit/swamp-pulse — summarises a run's ranked
 * output into markdown and JSON.
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

type RankedItem = {
  id: string;
  title: string;
  importance: string;
  kind: string;
  repo: string;
  date: string;
  rationale: string;
  docLinks?: { filename: string; manualUrl?: string }[];
};

type Ranked = {
  windows: {
    key: string;
    label: string;
    changes: number;
    releases: number;
    issues: number;
    items: RankedItem[];
  }[];
  totals: {
    events: number;
    commits: number;
    releases: number;
    issues: number;
    docChanges: number;
  };
  manualPages: number;
  generatedAt: string;
};

/** Report definition for the Swamp Pulse run summary. */
export const report = {
  name: "@svendowideit/swamp-pulse-summary",
  description:
    "Summarise a Swamp Pulse run — counts, top-ranked items and doc links",
  scope: "method",
  labels: ["swamp-pulse", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.executionStatus === "failed") {
      return {
        markdown: `Swamp Pulse ${context.methodName} failed: ${
          context.errorMessage ?? "unknown error"
        }`,
        json: { failed: true, method: context.methodName },
      };
    }

    const md: string[] = [];
    md.push("# Swamp Pulse");
    md.push("");

    if (context.methodName === "render") {
      const pages = context.dataHandles.filter((h) => h.kind === "file");
      md.push(
        `Rendered ${pages.length} page(s): ${
          pages.map((p) => `\`${p.name}\``).join(", ") || "none"
        }.`,
      );
      return { markdown: md.join("\n"), json: { methods: context.methodName } };
    }

    if (context.methodName === "sync_manual_index") {
      const handle = context.dataHandles.find(
        (h) => h.specName === "manualIndex",
      );
      if (!handle) {
        return { markdown: "No manual index written.", json: {} };
      }
      const raw = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        handle.name,
        handle.version,
      );
      const parsed = raw
        ? JSON.parse(new TextDecoder().decode(raw)) as {
          count?: number;
        }
        : {};
      md.push(`Cached ${parsed.count ?? 0} manual pages for doc linking.`);
      return { markdown: md.join("\n"), json: { manualPages: parsed.count } };
    }

    const handle = context.dataHandles.find((h) => h.specName === "ranked");
    if (!handle) {
      return { markdown: "No ranked data produced.", json: {} };
    }

    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) {
      return { markdown: "Ranked data was empty.", json: {} };
    }

    const ranked = JSON.parse(new TextDecoder().decode(raw)) as Ranked;

    md.push(
      `${ranked.totals.events} merged events · ${ranked.totals.releases} releases · ` +
        `${ranked.totals.issues} Lab issues · ${ranked.totals.docChanges} doc changes.`,
    );
    md.push("");

    for (const window of ranked.windows) {
      md.push(`## ${window.label}`);
      md.push("");
      md.push(
        `${window.items.length} items (${window.changes} changes, ${window.releases} releases, ${window.issues} issues)`,
      );
      md.push("");
      const top = window.items.slice(0, 8);
      if (top.length === 0) {
        md.push("_No activity._");
      } else {
        md.push("| # | Tier | Item | Source |");
        md.push("|---|------|------|--------|");
        top.forEach((item, i) => {
          md.push(
            `| ${i + 1} | ${item.importance} | ${
              item.title.replace(/\|/g, "\\|").slice(0, 70)
            } | ${item.repo || "lab"} |`,
          );
        });
      }
      md.push("");
    }

    const docs = ranked.windows.flatMap((w) =>
      w.items.flatMap((i) => (i.docLinks ?? []).map((d) => d))
    );
    const uniqueDocs = new Map(docs.map((d) => [d.filename, d]));
    if (uniqueDocs.size > 0) {
      md.push("## New / changed documentation");
      md.push("");
      for (const d of uniqueDocs.values()) {
        md.push(
          `- \`${d.filename}\`${d.manualUrl ? ` — ${d.manualUrl}` : ""}`,
        );
      }
      md.push("");
    }

    return {
      markdown: md.join("\n"),
      json: {
        generatedAt: ranked.generatedAt,
        totals: ranked.totals,
        manualPages: ranked.manualPages,
        windows: ranked.windows.map((w) => ({
          key: w.key,
          items: w.items.length,
          changes: w.changes,
          releases: w.releases,
          issues: w.issues,
          top: w.items.slice(0, 5).map((i) => ({
            id: i.id,
            title: i.title,
            importance: i.importance,
          })),
        })),
        docChanges: [...uniqueDocs.keys()],
      },
    };
  },
};
