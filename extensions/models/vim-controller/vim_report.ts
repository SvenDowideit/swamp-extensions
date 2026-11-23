/**
 * `@svendowideit/vim` method report: the edit-session artefact.
 *
 * For an edit it prints the file, the undo sequence, before/after hashes and the
 * unified diff the method already computed. For reads and diagnostics it prints
 * the buffer/diagnostic summary. It never throws on corrupt data.
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

/** Render the edit-session summary. Pure, so it is unit-tested. */
export function formatEditSession(
  method: string,
  by: Map<string, Json[]>,
  error?: string,
): { markdown: string; json: Record<string, unknown> } {
  const lines: string[] = [`# Edit session — ${method}`, ""];
  if (error) lines.push(`**Failed:** ${error}`, "");

  let rendered = 0;

  const diffs = by.get("diff-result") ?? [];
  if (diffs.length > 0) {
    rendered++;
    for (const row of diffs) {
      lines.push(
        `## Diff — ${row.file || "buffer"}`,
        "",
        table(
          ["server", "changed", "buffer hash", "file hash"],
          [[row.server, row.changed, row.bufferHash, row.fileHash]],
        ),
        "",
      );
      const diff = String(row.diff ?? "").trimEnd();
      if (diff) lines.push("```diff", diff, "```", "");
      else lines.push("_No change._", "");
    }
  }

  const edits = by.get("edit-result") ?? [];
  if (edits.length > 0) {
    rendered++;
    for (const edit of edits) {
      lines.push(
        `## ${edit.file || "buffer"}`,
        "",
        table(
          ["changed", "saved", "undo seq", "before lines", "after lines"],
          [[
            edit.changed,
            edit.saved,
            edit.undoSeq,
            edit.beforeLineCount,
            edit.afterLineCount,
          ]],
        ),
        "",
        `before \`${edit.beforeHash}\``,
        "",
        `after \`${edit.afterHash}\``,
        "",
      );
      const diff = String(edit.diff ?? "").trimEnd();
      if (diff) {
        lines.push("```diff", diff, "```", "");
      } else {
        lines.push("_No change._", "");
      }
    }
  }

  const buffers = by.get("buffer") ?? [];
  if (buffers.length > 0) {
    rendered++;
    for (const buffer of buffers) {
      lines.push(
        `## ${buffer.file || "buffer"}`,
        "",
        table(
          ["modified", "start", "end", "selection", "mode"],
          [[
            buffer.modified,
            buffer.start,
            buffer.end,
            buffer.hasSelection,
            buffer.mode,
          ]],
        ),
        "",
      );
      const rows = Array.isArray(buffer.lines) ? buffer.lines : [];
      if (rows.length > 0) {
        lines.push(
          "```vim",
          ...rows.slice(0, 60).map((line) => String(line)),
          "```",
          "",
        );
      }
    }
  }

  const statuses = by.get("server-status") ?? [];
  if (statuses.length > 0) {
    rendered++;
    lines.push(
      "## Server status",
      "",
      table(
        ["server", "file", "modified", "lines", "cursor", "mode", "filetype"],
        statuses.map((row) => [
          row.server,
          row.file || "—",
          row.modified,
          row.lines,
          Array.isArray(row.cursor) ? row.cursor.join(":") : "—",
          row.mode,
          row.filetype,
        ]),
      ),
      "",
    );
  }

  const diagnostics = by.get("diagnostics")?.[0];
  if (diagnostics) {
    rendered++;
    const quickfix = Array.isArray(diagnostics.quickfix)
      ? diagnostics.quickfix
      : [];
    const location = Array.isArray(diagnostics.location)
      ? diagnostics.location
      : [];
    lines.push(
      "## Diagnostics",
      "",
      `quickfix **${quickfix.length}**, location **${location.length}**`,
      "",
    );
    const rows = [...quickfix, ...location].slice(0, 20);
    if (rows.length > 0) {
      lines.push(
        table(
          ["line", "type", "text"],
          rows.map((row) => {
            const r = row as Json;
            return [r.lnum, r.type ?? "—", r.text ?? "—"];
          }),
        ),
        "",
      );
    }
  }

  const annotations = by.get("annotation") ?? [];
  if (annotations.length > 0) {
    rendered++;
    lines.push(
      "## Annotations",
      "",
      table(
        ["server", "line", "column", "text", "cleared"],
        annotations.map((row) => [
          row.server,
          row.line,
          row.col,
          row.text,
          row.cleared,
        ]),
      ),
      "",
    );
  }

  const servers = by.get("server") ?? [];
  if (servers.length > 0) {
    rendered++;
    lines.push(
      "## Server",
      "",
      table(
        ["server", "terminal", "file", "cwd", "reused"],
        servers.map((row) => [
          row.server,
          row.terminal || "—",
          row.file || "—",
          row.cwd || "—",
          row.reused,
        ]),
      ),
      "",
    );
  }

  for (
    const spec of [
      "write-result",
      "close-result",
      "command-result",
      "expr-result",
      "keys-result",
    ]
  ) {
    const rows = by.get(spec) ?? [];
    if (rows.length === 0) continue;
    rendered++;
    lines.push(
      `## ${spec.replace("-result", "")}`,
      "",
      table(
        ["server", "detail"],
        rows.map((row) => [
          row.server,
          Object.entries(row)
            .filter(([key]) =>
              !["server", "capturedAt", "pressedAt"].includes(key)
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

/** Report definition: the end-of-method edit-session summary. */
export const report = {
  name: "@svendowideit/edit-session",
  description:
    "Render a Vim method's edit, buffer, undo sequence, diff, diagnostics and tracing data as a reviewable summary",
  scope: "method",
  labels: ["vim", "editor", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.executionStatus === "failed") {
      return formatEditSession(
        context.methodName,
        new Map(),
        context.errorMessage ?? "the method failed",
      );
    }
    const by = await readHandles(context);
    return formatEditSession(context.methodName, by);
  },
};
