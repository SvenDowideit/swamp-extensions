/**
 * Report extension for @svendowideit/test-factory — renders a scenario result
 * or the fan-out rollup as readable markdown/JSON.
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

/** Read and parse the JSON payload behind a data handle. */
async function readJson<T>(
  context: MethodReportContext,
  handle: DataHandle,
): Promise<T | null> {
  const bytes = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    handle.name,
    handle.version,
  );
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The pass/fail badge used throughout the report. */
function badge(ok: boolean): string {
  return ok ? "PASS" : "FAIL";
}

/**
 * Render the "what this run proves" block: each phase's claim plus the literal
 * commands that establish it, so a reader can judge both adequacy and whether
 * the test exercised what it says.
 */
function renderClaims(attrs: Record<string, unknown>): string[] {
  const claims = arr(attrs.claims) as Record<string, unknown>[];
  if (claims.length === 0) return [];
  const lines: string[] = ["### What this run proves", ""];
  for (const c of claims) {
    lines.push(`- **${str(c.phase)}** — ${str(c.claim)}`);
  }
  lines.push("");
  lines.push("### How it was proved", "");
  for (const c of claims) {
    lines.push(`**${str(c.phase)}**`, "");
    lines.push("```sh");
    for (const cmd of arr(c.commands)) lines.push(str(cmd));
    lines.push("```", "");
  }
  return lines;
}

/**
 * Render the documented acceptance tests: each test's prose (`confirms` /
 * `cannot`), its verdict, and the full per-step logs. This is the reader's
 * evidence that the tests did what they claim — not just that they passed.
 */
export function renderTests(attrs: Record<string, unknown>): string[] {
  const tests = arr(attrs.tests) as Record<string, unknown>[];
  if (tests.length === 0) return [];
  const passed = tests.filter((t) => t.ok === true).length;
  const lines: string[] = [
    `### Documented tests — ${passed}/${tests.length} passed`,
    "",
    "| Test | Result | Steps |",
    "| ---- | ------ | ----- |",
  ];
  for (const t of tests) {
    const steps = arr(t.steps) as Record<string, unknown>[];
    const okSteps = steps.filter((s) => s.ok === true).length;
    lines.push(
      `| ${str(t.name)} | ${
        badge(t.ok === true)
      } | ${okSteps}/${steps.length} |`,
    );
  }
  lines.push("");
  for (const t of tests) {
    lines.push(
      `#### ${str(t.name)} — ${badge(t.ok === true)}`,
      "",
      `- **confirms**: ${str(t.confirms)}`,
      `- **cannot**: ${str(t.cannot)}`,
      "",
    );
    for (const s of arr(t.steps) as Record<string, unknown>[]) {
      lines.push(
        `<details><summary>${badge(s.ok === true)} · ${str(s.name)} (exit ${
          num(s.exitCode)
        })</summary>`,
        "",
        "```sh",
        str(s.run),
        "```",
        "",
      );
      const matched = arr(s.matched) as unknown[];
      if (matched.length > 0) {
        lines.push("Assertions:");
        for (const m of matched) lines.push(`- ${str(m)}`);
        lines.push("");
      }
      const stdout = str(s.stdout);
      if (stdout) {
        lines.push("stdout:", "", "```", stdout, "```", "");
      }
      const stderr = str(s.stderr);
      if (stderr) {
        lines.push("stderr:", "", "```", stderr, "```", "");
      }
      lines.push("</details>", "");
    }
  }
  return lines;
}

/** Render one `result` resource as a Markdown card. */
export function renderResult(attrs: Record<string, unknown>): string {
  const lines: string[] = [];
  const ok = attrs.ok === true;
  lines.push(`## ${str(attrs.scenario, "scenario")} — ${badge(ok)}`);
  lines.push("");
  const ext = str(attrs.extension);
  if (ext) {
    const version = str(attrs.extensionVersion);
    lines.push(`Extension **${ext}${version ? `@${version}` : ""}**`);
    lines.push("");
  }
  const intent = str(attrs.intent);
  if (intent) {
    lines.push(`_${intent}_`);
    lines.push("");
  }
  lines.push(
    `**${str(attrs.distro)}**${attrs.systemd ? " + systemd" : ""} · ` +
      `topology **${str(attrs.topology)}**` +
      (num(attrs.workers) > 0 ? ` (${attrs.workers} workers)` : "") +
      ` · expected **${str(attrs.expected)}** · status **${
        str(attrs.status)
      }**`,
  );
  lines.push("");
  lines.push(...renderClaims(attrs));

  const topo = attrs.topologyResult as Record<string, unknown> | undefined;
  if (topo) {
    lines.push(
      `Topology: serve ${
        topo.serveReady === true ? "ready" : "not ready"
      }, workers ${num(topo.workersEnrolled)}/${num(topo.workersRequested)}, ` +
        `dispatch ${topo.dispatchOk === true ? "ok" : "failed"}`,
    );
    if (str(topo.detail)) {
      lines.push("", "```", str(topo.detail), "```");
    }
    lines.push("");
  }

  lines.push("| Phase | Result | Detail |");
  lines.push("| ----- | ------ | ------ |");
  for (const p of arr(attrs.phases)) {
    const phase = p as Record<string, unknown>;
    lines.push(
      `| ${str(phase.phase)} | ${badge(phase.ok === true)} | ${
        str(phase.detail)
      } |`,
    );
  }
  lines.push("");

  const defs = arr(attrs.definitions);
  if (defs.length > 0) {
    lines.push("| Definition | Result | Detail |");
    lines.push("| ---------- | ------ | ------ |");
    for (const d of defs) {
      const def = d as Record<string, unknown>;
      lines.push(
        `| ${str(def.type)} | ${badge(def.ok === true)} | ${
          str(def.error) || str(def.name)
        } |`,
      );
    }
    lines.push("");
  }

  const wfs = arr(attrs.workflows);
  if (wfs.length > 0) {
    lines.push("| Workflow | Result | Status |");
    lines.push("| -------- | ------ | ------ |");
    for (const w of wfs) {
      const wf = w as Record<string, unknown>;
      lines.push(
        `| ${str(wf.name)} | ${badge(wf.ok === true)} | ${str(wf.status)} |`,
      );
    }
    lines.push("");
  }

  lines.push(...renderTests(attrs));

  const fixtures = arr(attrs.fixtures);
  if (fixtures.length > 0) {
    lines.push("| Fixture | Result | Exit |");
    lines.push("| ------- | ------ | ---- |");
    for (const f of fixtures) {
      const fx = f as Record<string, unknown>;
      lines.push(
        `| ${str(fx.type)}/${str(fx.method)} | ${badge(fx.ok === true)} | ${
          num(fx.code)
        } |`,
      );
    }
    lines.push("");
  }

  const errors = arr(attrs.errors);
  if (errors.length > 0) {
    lines.push("### Errors", "");
    for (const e of errors) lines.push(`- ${str(e)}`);
    lines.push("");
  }

  const logs = str(attrs.logs);
  if (logs) {
    lines.push(
      attrs.logsTruncated === true ? "### Logs (tail)" : "### Logs",
      "",
      "```",
      logs,
      "```",
      "",
    );
  }
  return lines.join("\n");
}

/** Render a `summary` resource as a Markdown table. */
export function renderSummary(attrs: Record<string, unknown>): string {
  const lines: string[] = [];
  const version = str(attrs.version);
  lines.push(
    `# Test factory — ${str(attrs.extension, "extension")}${
      version ? `@${version}` : ""
    }`,
  );
  lines.push("");
  lines.push(
    `${num(attrs.count)} scenario(s): **${num(attrs.passCount)} passed**, ` +
      `${num(attrs.failCount)} failed, ${num(attrs.errorCount)} errored.`,
  );
  if (num(attrs.testCount) > 0) {
    lines.push(
      `Documented tests: **${num(attrs.testsPassed)}/${
        num(attrs.testCount)
      }** ` +
        `passed (each test runs once per scenario).`,
    );
  }
  lines.push("");
  lines.push(...renderClaims(attrs));
  lines.push("| Scenario | Distro | Topology | Expected | Result |");
  lines.push("| -------- | ------ | -------- | -------- | ------ |");
  for (const r of arr(attrs.results)) {
    const row = r as Record<string, unknown>;
    lines.push(
      `| ${str(row.scenario)} | ${str(row.distro)} | ${str(row.topology)} | ${
        str(row.expected)
      } | ${badge(row.ok === true)} (${str(row.status)}) |`,
    );
  }
  return lines.join("\n");
}

/** Report definition: renders a scenario result or the fan-out rollup. */
export const report = {
  name: "@svendowideit/test-factory-report",
  description:
    "Render test-factory scenario results and the fan-out rollup as Markdown",
  scope: "method",
  labels: ["test-factory", "containers", "testing"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.executionStatus === "failed") {
      return {
        markdown: `# Test factory failed\n\n${context.errorMessage ?? ""}\n`,
        json: { error: true, message: context.errorMessage },
      };
    }

    // Gather the result cards first — they carry the per-test prose and logs.
    const resultHandles = context.dataHandles.filter(
      (h) => h.specName === "result",
    );
    const results: Record<string, unknown>[] = [];
    for (const handle of resultHandles) {
      const data = await readJson<Record<string, unknown>>(context, handle);
      if (data) results.push(data);
    }

    const summaryHandle = context.dataHandles.find(
      (h) => h.specName === "summary",
    );
    const summary = summaryHandle
      ? await readJson<Record<string, unknown>>(context, summaryHandle)
      : null;

    // A summary (a `test`/`testAll` fan-out) is followed by every result card,
    // so the counted roll-up *and* the full per-test logs are both reported.
    if (summary) {
      const detail = results.map(renderResult).join("\n\n---\n\n");
      return {
        markdown: [renderSummary(summary), detail].filter((s) => s.length > 0)
          .join("\n\n---\n\n"),
        json: { summary, results } as unknown as Record<string, unknown>,
      };
    }

    if (results.length === 0) {
      return { markdown: "", json: {} };
    }
    if (results.length === 1) {
      return { markdown: renderResult(results[0]), json: results[0] };
    }
    // Fan-out without a summary: render every result card.
    return {
      markdown: results.map(renderResult).join("\n\n---\n\n"),
      json: { results } as unknown as Record<string, unknown>,
    };
  },
};
