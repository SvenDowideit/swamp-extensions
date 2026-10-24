import type { InventoryOutput } from "./ssh_key_inventory.ts";

type DataHandle = {
  name: string;
  specName: string;
  kind: string;
  version?: number;
};
type Ctx = {
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

export const report = {
  name: "@svendowideit/ssh-key-summary",
  description: "Format SSH key inventory results as a human-friendly summary",
  scope: "method",
  labels: ["ssh", "keys", "security"],
  execute: async (
    context: Ctx,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      context.executionStatus === "failed" || context.methodName !== "inventory"
    ) return { markdown: "", json: {} };
    const handle = context.dataHandles.find((h) => h.specName === "inventory");
    if (!handle) return { markdown: "No inventory data produced.", json: {} };
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) return { markdown: "Inventory data not found.", json: {} };
    let r: InventoryOutput;
    try {
      r = JSON.parse(new TextDecoder().decode(raw)) as InventoryOutput;
    } catch {
      return { markdown: "Inventory data could not be parsed.", json: {} };
    }
    const lines: string[] = [];
    lines.push("# SSH Key Inventory");
    lines.push("");
    lines.push(
      `Hosts: ${r.totalHosts} (${r.reachableHosts} reachable). Private key files: ${r.privateKeys}. Unique keys: ${r.uniqueKeys}.`,
    );
    lines.push("");
    lines.push("## Unique keys");
    lines.push(
      "| Fingerprint | Algo | Encrypted | Age (y) | Occurrences | Severity |",
    );
    lines.push("|---|---|---|---|---|---|");
    for (const k of r.keys) {
      const age = k.oldestMtime
        ? ((Date.now() - k.oldestMtime * 1000) / (365.25 * 24 * 60 * 60 * 1000))
          .toFixed(1)
        : "";
      lines.push(
        `| ${k.fingerprint} | ${k.algorithm} ${
          k.bits ?? ""
        } | ${k.encryptedCount}/${k.occurrences} | ${age} | ${k.occurrences} | ${k.severity} |`,
      );
    }
    lines.push("");
    lines.push("## Hosts");
    for (const h of r.hosts) {
      lines.push(
        `- ${h.target}: ${
          h.ok ? h.privateKeys.length + " private keys" : h.error
        }`,
      );
    }
    lines.push("");
    lines.push("Run report to write the HTML report.");
    return {
      markdown: lines.join("\n"),
      json: {
        totalHosts: r.totalHosts,
        reachableHosts: r.reachableHosts,
        privateKeys: r.privateKeys,
        uniqueKeys: r.uniqueKeys,
      },
    };
  },
};
