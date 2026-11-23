/**
 * `@svendowideit/herdr-core` method report: turn a method's data handles into a
 * human review artefact printed after the run.
 *
 * This is intentionally a renderer, not a second implementation: it parses the
 * resources the method already wrote and formats the relevant one. It never
 * throws on corrupt data; a broken record is reported as missing.
 *
 * @module
 */

type DataHandle = {
  name: string;
  specName: string;
  kind: string;
  version?: number;
};

export type MethodReportContext = {
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

type Json = Record<string, unknown>;

/** Escape a value for a markdown table cell. */
function cell(value: unknown): string {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** A fenced block, or a placeholder when there is nothing to show. */
function fence(text: unknown, language = ""): string {
  const value = String(text ?? "").trimEnd();
  if (!value) return "_none_";
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

/** The last `n` lines of a string. */
function tail(text: unknown, n: number): string {
  const lines = String(text ?? "").split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n").trimEnd();
}

/** Render a table with a header and rows. */
function table(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

/** Read every data handle, grouping parsed payloads by spec name. */
export async function readHandles(
  context: MethodReportContext,
): Promise<Map<string, Json[]>> {
  const by = new Map<string, Json[]>();
  for (const handle of context.dataHandles) {
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw)) as Json;
    } catch {
      continue;
    }
    const list = by.get(handle.specName) ?? [];
    list.push(parsed);
    by.set(handle.specName, list);
  }
  return by;
}

/** Render the terminal-session summary. Pure, so it is unit-tested. */
export function formatTerminalSession(
  method: string,
  by: Map<string, Json[]>,
  error?: string,
): { markdown: string; json: Record<string, unknown> } {
  const lines: string[] = [`# Terminal session — ${method}`, ""];
  if (error) lines.push(`**Failed:** ${error}`, "");

  let rendered = 0;

  const run = by.get("run-result")?.[0];
  if (run) {
    rendered++;
    lines.push(
      "## Run",
      "",
      table(
        ["terminal", "state", "exit", "reason"],
        [[
          run.address,
          run.state,
          run.exitCode ?? "—",
          run.reason,
        ]],
      ),
      "",
      fence(tail(run.output, 20)),
      "",
    );
  }

  const exec = by.get("exec-result") ?? [];
  if (exec.length > 0) {
    rendered++;
    lines.push(
      "## Commands",
      "",
      table(
        ["machine", "exit", "time", "stdout", "stderr"],
        exec.map((row) => [
          row.machine || "local",
          row.code ?? "—",
          `${row.ms ?? 0} ms`,
          tail(row.stdout, 5) || "—",
          tail(row.stderr, 5) || "—",
        ]),
      ),
      "",
    );
  }

  const files = by.get("file-result") ?? [];
  if (files.length > 0) {
    rendered++;
    lines.push(
      "## Files",
      "",
      table(
        ["operation", "machine", "path", "bytes", "lines"],
        files.map((row) => [
          row.operation,
          row.machine || "local",
          row.path,
          row.bytes ?? "—",
          row.lineCount ?? "—",
        ]),
      ),
      "",
    );
    const withText = files.filter((row) => String(row.text ?? "").trim());
    for (const row of withText.slice(0, 2)) {
      lines.push(`### ${row.path}`, "", fence(tail(row.text, 40)), "");
    }
  }

  const search = by.get("search-result")?.[0];
  if (search) {
    rendered++;
    const matches = Array.isArray(search.matches) ? search.matches : [];
    lines.push(
      "## Search",
      "",
      `\`${search.pattern}\` — ${search.count} match(es)` +
        (search.truncated ? " (truncated)" : ""),
      "",
    );
    if (matches.length > 0) {
      lines.push(
        table(
          ["path", "line", "column", "text"],
          matches.slice(0, 20).map((m) => {
            const row = m as Json;
            return [
              row.path,
              row.line,
              row.column,
              String(row.text ?? "").slice(0, 160),
            ];
          }),
        ),
        "",
      );
    }
  }

  const fleet = by.get("fleet")?.[0];
  if (fleet) {
    rendered++;
    lines.push(
      "## Terminals",
      "",
      `**${fleet.count}** terminal(s)`,
      "",
      table(
        ["agent", "count"],
        Object.entries((fleet.byAgent ?? {}) as Record<string, unknown>).map((
          [agent, count],
        ) => [agent, count]),
      ),
      "",
      table(
        ["machine", "count"],
        Object.entries((fleet.byMachine ?? {}) as Record<string, unknown>).map((
          [machine, count],
        ) => [machine, count]),
      ),
      "",
    );
  }

  const status = by.get("status")?.[0];
  if (status) {
    rendered++;
    lines.push(
      "## Core",
      "",
      table(
        ["version", "live", "finished", "machines"],
        [[
          status.version,
          status.live,
          status.finished,
          Array.isArray(status.machines) ? status.machines.length : 0,
        ]],
      ),
      "",
    );
  }

  const machines = by.get("machines")?.[0];
  if (machines) {
    rendered++;
    const rows = Array.isArray(machines.machines) ? machines.machines : [];
    lines.push(
      "## Fleet",
      "",
      table(
        ["machine", "state", "version", "target"],
        rows.map((m) => {
          const row = m as Json;
          return [row.name, row.state, row.version, row.target];
        }),
      ),
      "",
    );
  }

  const wait = by.get("wait-result")?.[0];
  if (wait) {
    rendered++;
    lines.push(
      "## Wait",
      "",
      table(
        ["target", "ended", "reason", "exit", "status"],
        [[
          wait.target || "children",
          wait.ended,
          wait.reason,
          wait.exitCode ?? "—",
          wait.status ?? "—",
        ]],
      ),
      "",
    );
  }

  for (
    const spec of [
      "send-result",
      "keys-result",
      "interrupt-result",
      "kill-result",
      "remove-result",
      "put-result",
    ]
  ) {
    const rows = by.get(spec) ?? [];
    if (rows.length === 0) continue;
    rendered++;
    lines.push(
      `## ${spec.replace("-result", "")}`,
      "",
      table(
        ["target", "detail"],
        rows.map((row) => [
          row.target ?? row.path ?? "—",
          Object.entries(row)
            .filter(([key]) =>
              ![
                "target",
                "sentAt",
                "pressedAt",
                "killedAt",
                "removedAt",
                "putAt",
              ].includes(key)
            )
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" "),
        ]),
      ),
      "",
    );
  }

  const otel = by.get("otel-status")?.[0];
  if (otel) {
    rendered++;
    lines.push(
      "## Tracing",
      "",
      table(
        ["enabled", "endpoint", "mesh", "token", "reason"],
        [[
          otel.enabled,
          otel.endpoint || "—",
          otel.mesh || "—",
          otel.tokenPresent ? "set" : "not set",
          otel.reason || "—",
        ]],
      ),
      "",
    );
  }

  if (rendered === 0) {
    lines.push("_No summary data was produced for this method._", "");
  }

  const json: Record<string, unknown> = { method, error: error ?? null };
  for (const [spec, rows] of by) json[spec] = rows;
  return { markdown: lines.join("\n").trimEnd() + "\n", json };
}

/** Report definition: the end-of-method terminal session summary. */
export const report = {
  name: "@svendowideit/terminal-session",
  description:
    "Render a herdr-core method's run, commands, files, search, fleet and tracing data as a reviewable summary",
  scope: "method",
  labels: ["herdr-core", "terminal", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.executionStatus === "failed") {
      return formatTerminalSession(
        context.methodName,
        new Map(),
        context.errorMessage ?? "the method failed",
      );
    }
    const by = await readHandles(context);
    return formatTerminalSession(context.methodName, by);
  },
};
