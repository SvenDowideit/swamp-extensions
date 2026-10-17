/**
 * @svendowideit/nanokvm-health-report — a fleet health report over a workflow
 * run of `@svendowideit/nanokvm` models.
 *
 * Workflow-scoped: after a run finishes it walks every step's data, collects
 * each `health` record (and any `emit` record), and renders one Markdown page
 * plus structured JSON. It is deterministic and reads only swamp data — no
 * network, no device access — so it is safe to run on every schedule.
 *
 * @module
 */

/** Metadata for one data record written during the run. */
interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  version?: number;
}

/** One step of the workflow run, as the report context presents it. */
interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: DataHandle[];
  modelId: string;
  globalArgs: Record<string, unknown>;
}

/** The workflow-scope report context passed by swamp. */
interface WorkflowReportContext {
  scope: "workflow";
  repoDir: string;
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
}

/** A normalized view of one device's health record. */
interface DeviceHealth {
  device: string;
  host: string;
  verdict: string;
  reachable: boolean;
  authenticated: boolean;
  appVersion: string;
  hardware: string;
  firmwareOutdated: boolean;
  mountedImage: string;
  hidMode: string;
  responseMs: number;
  findings: Array<{ code: string; severity: string; message: string }>;
  checkedAt: string;
}

/** Read every record with `specName` across the run's steps. */
async function collect(
  context: WorkflowReportContext,
  specName: string,
): Promise<Array<{ device: string; data: Record<string, unknown> }>> {
  const out: Array<{ device: string; data: Record<string, unknown> }> = [];
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
        const data = JSON.parse(new TextDecoder().decode(raw)) as Record<
          string,
          unknown
        >;
        out.push({ device: step.modelName, data });
      } catch {
        // A record that is not JSON cannot be a health record; skip it.
      }
    }
  }
  return out;
}

function toDeviceHealth(
  device: string,
  data: Record<string, unknown>,
): DeviceHealth {
  const findings = Array.isArray(data.findings) ? data.findings : [];
  return {
    device,
    host: typeof data.host === "string" ? data.host : "",
    verdict: typeof data.verdict === "string" ? data.verdict : "unknown",
    reachable: data.reachable === true,
    authenticated: data.authenticated === true,
    appVersion: typeof data.appVersion === "string" ? data.appVersion : "",
    hardware: typeof data.hardware === "string" ? data.hardware : "",
    firmwareOutdated: data.firmwareOutdated === true,
    mountedImage: typeof data.mountedImage === "string"
      ? data.mountedImage
      : "",
    hidMode: typeof data.hidMode === "string" ? data.hidMode : "",
    responseMs: typeof data.responseMs === "number" ? data.responseMs : 0,
    findings: findings.flatMap((f) => {
      if (typeof f !== "object" || f === null) return [];
      const o = f as Record<string, unknown>;
      return [{
        code: typeof o.code === "string" ? o.code : "",
        severity: typeof o.severity === "string" ? o.severity : "info",
        message: typeof o.message === "string" ? o.message : "",
      }];
    }),
    checkedAt: typeof data.checkedAt === "string" ? data.checkedAt : "",
  };
}

function verdictBadge(verdict: string): string {
  if (verdict === "pass") return "✅ pass";
  if (verdict === "warn") return "⚠️ warn";
  if (verdict === "fail") return "❌ fail";
  return "❔ unknown";
}

/** Model definition for the NanoKVM fleet health report. */
export const report = {
  name: "@svendowideit/nanokvm-health-report",
  description:
    "Fleet health report over a workflow run of @svendowideit/nanokvm devices: " +
    "per-device verdicts and findings, plus an OTLP emit summary",
  scope: "workflow" as const,
  labels: ["nanokvm", "health", "kvm", "summary"],
  execute: async (
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const devices = (await collect(context, "health")).map((r) =>
      toDeviceHealth(r.device, r.data)
    );
    const emits = await collect(context, "emit");

    if (devices.length === 0) {
      return {
        markdown:
          `# NanoKVM health\n\nNo device health was recorded by this run ` +
          `(workflow \`${context.workflowName}\`, status ` +
          `${context.workflowStatus}).\n`,
        json: {
          workflow: context.workflowName,
          status: context.workflowStatus,
          devices: [],
          devicesTotal: 0,
        },
      };
    }

    const byVerdict = { pass: 0, warn: 0, fail: 0, unknown: 0 } as Record<
      string,
      number
    >;
    for (const d of devices) {
      byVerdict[d.verdict] = (byVerdict[d.verdict] ?? 0) + 1;
    }
    const worst = byVerdict.fail > 0
      ? "fail"
      : byVerdict.warn > 0
      ? "warn"
      : "pass";

    const lines: string[] = [];
    lines.push("# NanoKVM health");
    lines.push("");
    lines.push(
      `Workflow \`${context.workflowName}\` — overall **${
        verdictBadge(worst)
      }** across ${devices.length} device${devices.length === 1 ? "" : "s"}.`,
    );
    lines.push("");
    lines.push(
      "| Device | Address | Verdict | App | Response | Mounted media |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const d of devices) {
      lines.push(
        `| ${d.device} | ${d.host || "—"} | ${verdictBadge(d.verdict)} | ${
          d.appVersion || "—"
        } | ${d.responseMs}ms | ${d.mountedImage || "—"} |`,
      );
    }
    lines.push("");
    const flagged = devices.filter((d) =>
      d.findings.some((f) => f.severity !== "info")
    );
    if (flagged.length === 0) {
      lines.push("No warnings or errors.");
    } else {
      lines.push("## Findings");
      lines.push("");
      for (const d of flagged) {
        lines.push(`### ${d.device} (${d.host || "unknown host"})`);
        lines.push("");
        for (const f of d.findings) {
          if (f.severity === "info") continue;
          const mark = f.severity === "error" ? "❌" : "⚠️";
          lines.push(`- ${mark} \`${f.code}\` — ${f.message}`);
        }
        lines.push("");
      }
    }
    if (emits.length > 0) {
      lines.push("## OTLP");
      lines.push("");
      for (const e of emits) {
        const skipped = e.data.skipped === true;
        const pushed = e.data.pushed === true;
        lines.push(
          `- ${e.device}: ${
            skipped
              ? `skipped (${e.data.reason ?? "not configured"})`
              : pushed
              ? `pushed to ${e.data.endpoint}`
              : `incomplete (logs=${e.data.logsStatus ?? "?"} metrics=${
                e.data.metricsStatus ?? "?"
              })`
          }`,
        );
      }
      lines.push("");
    }

    return {
      markdown: lines.join("\n"),
      json: {
        workflow: context.workflowName,
        status: context.workflowStatus,
        overall: worst,
        counts: byVerdict,
        devicesTotal: devices.length,
        devices,
        emits: emits.map((e) => ({ device: e.device, ...e.data })),
      },
    };
  },
};
