/**
 * @svendowideit/vim — live, semantic control of a Vim server.
 *
 * Vim is already a programmable editor when it is started with
 * `--servername`: `--remote-expr` can read lines, replace a buffer, move the
 * cursor, draw text properties and read quickfix. This model wraps that
 * surface so an agent can edit the buffer a human is watching, instead of
 * spawning `sed`/`cat` and hoping the file did not move.
 *
 * Methods:
 *   servers, open, status, read, edit, write, cursor, annotate,
 *   command, expr, keys, diagnostics, undo, close, otel-status.
 *
 * Every method emits one OTLP span (when OTEL is configured) with
 * `swamp.route=vim`; see `vim_otel.ts`.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  emitSpan,
  errorMessage,
  type OtelConfig,
  OtelConfigSchema,
  otelStatus,
  withOtelSpan,
} from "./vim_otel.ts";

/** The model type. */
export const EXT_TYPE = "@svendowideit/vim-controller";
/** The extension version; keep in step with manifest.yaml. */
export const EXT_VERSION = "2026.11.23.2";

// ---------------------------------------------------------------------------
// Global and method arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  vimBin: z.string().default("vim").describe("Vim binary to run."),
  herdrBin: z.string().default("herdr-core").describe(
    "herdr-core binary used by `open` to host Vim in a persistent terminal.",
  ),
  serverPrefix: z.string().default("swamp-vim").describe(
    "Prefix for a server name derived from the working directory.",
  ),
  defaultServer: z.string().default("").describe(
    "Vim server to use when a method does not name one.",
  ),
  defaultCwd: z.string().default("").describe(
    "Working directory for `open` when the method does not give one.",
  ),
  maxOutputBytes: z.number().int().positive().default(200_000).describe(
    "Maximum bytes of buffer/command output retained in data.",
  ),
  ...OtelConfigSchema.shape,
});

/** Global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ServerArgsSchema = z.object({
  server: z.string().default("").describe(
    "Vim server name (`vim --servername`); empty uses defaultServer.",
  ),
});

const OpenArgsSchema = z.object({
  server: z.string().default("").describe(
    "Server name to create or reuse; empty derives one from the cwd.",
  ),
  file: z.string().default("").describe("File to open in the new server."),
  cwd: z.string().default("").describe("Working directory for the server."),
  reuse: z.boolean().default(true).describe(
    "Return an already-running server instead of failing.",
  ),
  waitMs: z.number().int().positive().default(5000).describe(
    "How long to wait for the server to appear.",
  ),
});

const ReadArgsSchema = ServerArgsSchema.extend({
  mode: z.enum(["all", "visible", "selection"]).default("all").describe(
    "Read the whole buffer, the visible window, or the visual selection.",
  ),
  start: z.number().int().min(1).optional().describe(
    "Optional absolute first line to slice.",
  ),
  end: z.number().int().min(1).optional().describe(
    "Optional absolute last line to slice.",
  ),
});

const EditOperationSchema = z.object({
  old: z.string().optional().describe(
    "Exact text found exactly once in the buffer.",
  ),
  new: z.string().optional().describe("Replacement text for `old`."),
  startLine: z.number().int().min(1).optional().describe(
    "First line of a 1-indexed range to replace.",
  ),
  endLine: z.number().int().min(1).optional().describe(
    "Last line of the range; defaults to startLine.",
  ),
  lines: z.array(z.string()).optional().describe(
    "Replacement lines for a range edit.",
  ),
  setLines: z.array(z.string()).optional().describe(
    "Replace the whole buffer with these lines.",
  ),
});

const EditArgsSchema = ServerArgsSchema.extend({
  edits: z.array(EditOperationSchema).min(1).describe(
    "Applied in order; the whole call is rejected if any edit is ambiguous.",
  ),
  save: z.boolean().default(false).describe(
    "Write the buffer after a successful edit.",
  ),
});

const WriteArgsSchema = ServerArgsSchema.extend({
  force: z.boolean().default(false).describe(
    "Use `write!`; only when intentionally overwriting.",
  ),
});

const CursorArgsSchema = ServerArgsSchema.extend({
  line: z.number().int().min(1).describe("1-indexed line."),
  col: z.number().int().min(1).default(1).describe("1-indexed column."),
});

const SelectArgsSchema = ServerArgsSchema.extend({
  line1: z.number().int().min(1).describe("Selection start line."),
  col1: z.number().int().min(1).default(1).describe("Selection start column."),
  line2: z.number().int().min(1).describe("Selection end line."),
  col2: z.number().int().min(1).default(1).describe("Selection end column."),
});

const AnnotateArgsSchema = ServerArgsSchema.extend({
  line: z.number().int().min(0).default(0).describe(
    "Line for the virtual text; 0 clears annotations.",
  ),
  col: z.number().int().min(1).default(1).describe(
    "Column for the virtual text.",
  ),
  text: z.string().default("").describe(
    "Virtual text shown after the line, e.g. `▶ agent`.",
  ),
  clear: z.boolean().default(false).describe("Clear all Swamp annotations."),
});

const CommandArgsSchema = ServerArgsSchema.extend({
  command: z.string().min(1).describe("Ex command to execute."),
  allowShell: z.boolean().default(false).describe(
    "Allow `!` shell escapes, `terminal`, `job_start` and similar.",
  ),
});

const ExprArgsSchema = ServerArgsSchema.extend({
  expr: z.string().min(1).describe("Vimscript expression to evaluate."),
  allowUnsafe: z.boolean().default(false).describe(
    "Allow expressions that mutate files or start processes.",
  ),
});

const KeysArgsSchema = ServerArgsSchema.extend({
  keys: z.string().min(1).describe(
    "Literal key sequence sent with `--remote-send`.",
  ),
});

const UndoArgsSchema = ServerArgsSchema.extend({
  seq: z.number().int().min(0).default(0).describe(
    "Undo sequence to return to; 0 performs one undo.",
  ),
});

const CloseArgsSchema = ServerArgsSchema.extend({
  force: z.boolean().default(true).describe(
    "Send `:qa!`; false sends `:qa` and may be refused by a modified buffer.",
  ),
});

const DiffArgsSchema = ServerArgsSchema.extend({});

const OtelStatusArgsSchema = z.object({
  test: z.boolean().default(false).describe(
    "Also post a test span and report the HTTP result.",
  ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const ServerResourceSchema = z.object({
  server: z.string(),
  terminal: z.string().default(""),
  file: z.string().default(""),
  cwd: z.string().default(""),
  reused: z.boolean().default(false),
  openedAt: z.string(),
});

const ServersResourceSchema = z.object({
  count: z.number(),
  servers: z.array(z.string()),
  capturedAt: z.string(),
});

const ServerStatusSchema = z.object({
  server: z.string(),
  file: z.string().default(""),
  modified: z.boolean().default(false),
  lines: z.number().default(0),
  cursor: z.array(z.number()).default([]),
  mode: z.string().default(""),
  filetype: z.string().default(""),
  capturedAt: z.string(),
});

const BufferSchema = z.object({
  server: z.string(),
  file: z.string().default(""),
  modified: z.boolean().default(false),
  start: z.number().default(1),
  end: z.number().default(0),
  hasSelection: z.boolean().default(false),
  lines: z.array(z.string()),
  cursor: z.array(z.number()).default([]),
  mode: z.string().default(""),
  filetype: z.string().default(""),
  capturedAt: z.string(),
});

const EditResultSchema = z.object({
  server: z.string(),
  file: z.string().default(""),
  changed: z.boolean(),
  saved: z.boolean(),
  undoSeq: z.number().default(0),
  beforeHash: z.string(),
  afterHash: z.string(),
  beforeLineCount: z.number(),
  afterLineCount: z.number(),
  diff: z.string(),
  capturedAt: z.string(),
});

const AnnotationSchema = z.object({
  server: z.string(),
  line: z.number(),
  col: z.number(),
  text: z.string(),
  cleared: z.boolean(),
  capturedAt: z.string(),
});

const DiagnosticsSchema = z.object({
  server: z.string(),
  quickfix: z.array(z.record(z.string(), z.unknown())).default([]),
  location: z.array(z.record(z.string(), z.unknown())).default([]),
  capturedAt: z.string(),
});

const CommandResultSchema = z.object({
  server: z.string(),
  command: z.string(),
  output: z.string(),
  capturedAt: z.string(),
});

const ExprResultSchema = z.object({
  server: z.string(),
  expr: z.string(),
  value: z.string(),
  capturedAt: z.string(),
});

const KeysResultSchema = z.object({
  server: z.string(),
  keys: z.string(),
  pressedAt: z.string(),
});

const WriteResultSchema = z.object({
  server: z.string(),
  force: z.boolean(),
  output: z.string(),
  capturedAt: z.string(),
});

const CloseResultSchema = z.object({
  server: z.string(),
  force: z.boolean(),
  closed: z.boolean(),
  capturedAt: z.string(),
});

const DiffResultSchema = z.object({
  server: z.string(),
  file: z.string(),
  changed: z.boolean(),
  bufferHash: z.string(),
  fileHash: z.string(),
  diff: z.string(),
  capturedAt: z.string(),
});

const OtelStatusResourceSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  mesh: z.string(),
  source: z.string(),
  tokenPresent: z.boolean(),
  reason: z.string(),
  serviceName: z.string(),
  model: z.string(),
  test: z.record(z.string(), z.unknown()).nullable().default(null),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Process and Vim helpers
// ---------------------------------------------------------------------------

/** The part of swamp's method context this extension uses. */
export interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readModelData?: (
    model: string,
    spec: string,
  ) => Promise<Array<Record<string, unknown>>>;
  vaultService?: {
    get(vault: string, key: string, reason: string): Promise<string>;
  };
  logger?: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warn: (message: string, props?: Record<string, unknown>) => void;
    debug?: (message: string, props?: Record<string, unknown>) => void;
  };
  definition?: { name?: string };
  /** Resolve a file bundled in this extension (swamp_vim.vim). */
  extensionFile?: (relative: string) => string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a process, optionally feeding stdin. */
async function runProcess(
  bin: string,
  args: string[],
  stdin?: string,
): Promise<CommandResult> {
  const command = new Deno.Command(bin, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** Run a herdr-core command that must return JSON. */
async function hcJson<T = Record<string, unknown>>(
  bin: string,
  args: string[],
): Promise<T> {
  const separator = args.indexOf("--");
  const withJson = separator === -1
    ? [...args, "--json"]
    : [...args.slice(0, separator), "--json", ...args.slice(separator)];
  const result = await runProcess(bin, withJson);
  if (result.code !== 0) {
    throw new Error(
      `herdr-core ${args.join(" ")} failed (${result.code}): ` +
        (result.stderr.trim() || result.stdout.trim() || "no output"),
    );
  }
  const text = result.stdout.trim();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `herdr-core ${args.join(" ")} did not return JSON: ${text.slice(0, 500)}`,
    );
  }
}

/** List the Vim servers on this host. */
export async function listServers(vimBin: string): Promise<string[]> {
  const result = await runProcess(vimBin, ["--serverlist"]);
  if (result.code !== 0) {
    throw new Error(
      `vim --serverlist failed (${result.code}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(
    Boolean,
  );
}

/** Run one `--remote-expr` and return its stdout. */
async function remoteExpr(
  vimBin: string,
  server: string,
  expr: string,
): Promise<string> {
  const result = await runProcess(vimBin, [
    "--servername",
    server,
    "--remote-expr",
    expr,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `Vim server '${server}' rejected ${
        expr.slice(0, 120)
      } (${result.code}): ` +
        (result.stderr.trim() || result.stdout.trim() || "no output"),
    );
  }
  return result.stdout.trim();
}

/** Send a literal key sequence. */
async function remoteSend(
  vimBin: string,
  server: string,
  keys: string,
): Promise<CommandResult> {
  return await runProcess(vimBin, [
    "--servername",
    server,
    "--remote-send",
    keys,
  ]);
}

/** Source the bundled Vim runtime into a server when it is not there yet. */
async function ensureRuntime(
  ctx: MethodContext,
  server: string,
): Promise<void> {
  const has = await remoteExpr(
    ctx.globalArgs.vimBin,
    server,
    'exists("*SwampVimRuntime") ? SwampVimRuntime() : 0',
  );
  if (Number(has) >= 4) return;
  if (!ctx.extensionFile) {
    throw new Error(
      "cannot source swamp_vim.vim: this swamp build does not expose " +
        "extension files; start Vim with the runtime sourced or upgrade swamp",
    );
  }
  const path = ctx.extensionFile("swamp_vim.vim");
  await remoteExpr(
    ctx.globalArgs.vimBin,
    server,
    'execute("source " . fnameescape(' + JSON.stringify(path) + "))",
  );
}

/** Run a Vim expression and parse its JSON result. */
async function vimJson<T = Record<string, unknown>>(
  ctx: MethodContext,
  server: string,
  expr: string,
): Promise<T> {
  const text = await remoteExpr(ctx.globalArgs.vimBin, server, expr);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Vim returned non-JSON from ${expr.slice(0, 120)}: ${text}`,
    );
  }
}

/** The server named by the method or the model default. */
function serverOf(g: GlobalArgs, args: { server?: string }): string {
  const server = (args.server ?? "").trim() || g.defaultServer.trim();
  if (!server) {
    throw new Error(
      "no Vim server: pass server=<name> or set defaultServer; start Vim " +
        "with `vim --servername <name>`",
    );
  }
  return server;
}

/** A safe herdr-core terminal name. */
function hcName(server: string): string {
  const name = server.toLowerCase().replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (name || "vim").slice(0, 32);
}

/** Derive a Vim server name from a cwd. */
export function deriveServerName(prefix: string, cwd: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? "vim";
  const name = `${prefix}-${base}`.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
  return (name || prefix).slice(0, 60);
}

/** Truncate retained output. */
function cap(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return text.slice(0, maxBytes) + `\n… truncated at ${maxBytes} bytes`;
}

/** SHA-256 hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** FNV-1a, used only for compact resource names. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A safe resource name. */
function safeName(value: string): string {
  return (value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "item").slice(0, 64);
}

/** ISO timestamp. */
function now(): string {
  return new Date().toISOString();
}

/** Map a `SwampVimStatus()` result to a resource. */
function statusResource(
  server: string,
  raw: Record<string, unknown>,
): z.infer<typeof ServerStatusSchema> {
  return {
    server,
    file: String(raw.file ?? ""),
    modified: raw.modified === true || raw.modified === 1,
    lines: Number(raw.lines ?? 0),
    cursor: Array.isArray(raw.cursor) ? raw.cursor.map((v) => Number(v)) : [],
    mode: String(raw.mode ?? ""),
    filetype: String(raw.filetype ?? ""),
    capturedAt: now(),
  };
}

/** Build the OTEL config from this model's global arguments. */
function otelConfig(g: GlobalArgs): OtelConfig {
  return {
    otelEnabled: g.otelEnabled,
    otelModel: g.otelModel,
    otelVaultName: g.otelVaultName,
    otelTokenRef: g.otelTokenRef,
    otelEndpoint: g.otelEndpoint,
    otelMesh: g.otelMesh,
    otelServiceName: g.otelServiceName,
    otelTimeoutMs: g.otelTimeoutMs,
    otelDebug: g.otelDebug,
    eventLogEnabled: g.eventLogEnabled,
    eventLog: g.eventLog,
  };
}

/** The OTEL span input for a method. */
function spanInput(
  method: string,
  args: Record<string, unknown>,
  extra: { target?: string; attributes?: Record<string, unknown> } = {},
): {
  name: string;
  target?: string;
  attributes?: Record<string, unknown>;
  extensionVersion: string;
  route: string;
} {
  return {
    name: `vim.${method}`,
    target: extra.target,
    attributes: {
      ...(args ?? {}),
      ...(extra.attributes ?? {}),
    },
    extensionVersion: EXT_VERSION,
    route: "vim",
  };
}

// ---------------------------------------------------------------------------
// Editing and diffing
// ---------------------------------------------------------------------------

/** One parsed edit operation. */
export interface EditOperation {
  old?: string;
  new?: string;
  startLine?: number;
  endLine?: number;
  lines?: string[];
  setLines?: string[];
}

/** Apply edit operations to buffer lines, rejecting ambiguity. */
export function applyEdits(
  lines: string[],
  edits: EditOperation[],
): string[] {
  let current = [...lines];
  for (const edit of edits) {
    if (edit.setLines) {
      current = edit.setLines.length > 0 ? [...edit.setLines] : [""];
      continue;
    }
    if (typeof edit.startLine === "number") {
      const start = edit.startLine;
      const end = edit.endLine ?? start;
      if (start < 1 || end < start) {
        throw new Error(`invalid line range ${start}..${end}`);
      }
      if (start > current.length) {
        throw new Error(
          `line range ${start}..${end} starts past the buffer (${current.length} lines)`,
        );
      }
      if (end > current.length) {
        throw new Error(
          `line range ${start}..${end} ends past the buffer (${current.length} lines)`,
        );
      }
      current.splice(start - 1, end - start + 1, ...(edit.lines ?? []));
      continue;
    }
    if (typeof edit.old === "string" && typeof edit.new === "string") {
      if (edit.old.length === 0) {
        throw new Error("an exact-text edit cannot use an empty old string");
      }
      const text = current.join("\n");
      const count = text.split(edit.old).length - 1;
      if (count === 0) {
        throw new Error(`old text not found: ${JSON.stringify(edit.old)}`);
      }
      if (count > 1) {
        throw new Error(
          `old text occurs ${count} times; make it unique or use a line range: ` +
            JSON.stringify(edit.old),
        );
      }
      current = text.replace(edit.old, edit.new).split("\n");
      continue;
    }
    throw new Error(
      "each edit needs setLines, startLine, or old+new",
    );
  }
  return current;
}

/** A minimal LCS-based unified diff, capped for very large buffers. */
export function unifiedDiff(
  before: string[],
  after: string[],
  file: string,
): string {
  const maxLines = 4000;
  if (before.length > maxLines || after.length > maxLines) {
    return `--- a/${file}\n+++ b/${file}\n` +
      `(diff omitted: ${before.length} → ${after.length} lines exceeds ${maxLines})`;
  }
  const rows = before.length + 1;
  const cols = after.length + 1;
  const lcs: number[][] = Array.from(
    { length: rows },
    () => new Array<number>(cols).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = {
    kind: " " | "-" | "+";
    text: string;
    oldLine: number;
    newLine: number;
  };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", text: before[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "-", text: before[i], oldLine: i + 1, newLine: j + 1 });
      i++;
    } else {
      ops.push({ kind: "+", text: after[j], oldLine: i + 1, newLine: j + 1 });
      j++;
    }
  }
  while (i < before.length) {
    ops.push({ kind: "-", text: before[i], oldLine: i + 1, newLine: j + 1 });
    i++;
  }
  while (j < after.length) {
    ops.push({ kind: "+", text: after[j], oldLine: i + 1, newLine: j + 1 });
    j++;
  }

  const context = 3;
  const changed = ops
    .map((op, index) => op.kind === " " ? -1 : index)
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = end;
    } else {
      ranges.push([start, end]);
    }
  }
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const oldStart = slice.find((op) => op.kind !== "+")?.oldLine ?? 1;
    const newStart = slice.find((op) => op.kind !== "-")?.newLine ?? 1;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

async function servers(
  _args: z.infer<typeof ServerArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const list = await listServers(ctx.globalArgs.vimBin);
  const data: z.infer<typeof ServersResourceSchema> = {
    count: list.length,
    servers: list,
    capturedAt: now(),
  };
  return { dataHandles: [await save(ctx, "servers", "current", data)] };
}

async function open(
  args: z.infer<typeof OpenArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const cwd = args.cwd || g.defaultCwd || ".";
  const server = args.server || deriveServerName(g.serverPrefix, cwd);
  const existing = await listServers(g.vimBin);
  const running = existing.find((name) =>
    name.toLowerCase() === server.toLowerCase()
  );
  if (running) {
    if (!args.reuse) {
      throw new Error(`Vim server '${server}' is already running`);
    }
    const data: z.infer<typeof ServerResourceSchema> = {
      server,
      terminal: "",
      file: args.file,
      cwd,
      reused: true,
      openedAt: now(),
    };
    return { dataHandles: [await save(ctx, "server", server, data)] };
  }

  const hcArgs = [
    "run",
    "--bg",
    "--no-notify",
    "--name",
    hcName(server),
    "--cwd",
    cwd,
    "--",
    g.vimBin,
    "--servername",
    server,
    "-n",
    ...(args.file ? [args.file] : []),
  ];
  let terminal = "";
  try {
    const raw = await hcJson(g.herdrBin, hcArgs);
    terminal = String(raw.address ?? "");
  } catch (error) {
    throw new Error(
      `open needs a working herdr-core (hc) to host Vim: ${
        errorMessage(error)
      }. Start Vim yourself with ` +
        `\`vim --servername ${server}\` and pass server=${server}.`,
    );
  }

  const deadline = Date.now() + args.waitMs;
  let found = false;
  while (Date.now() < deadline) {
    found = (await listServers(g.vimBin)).some((name) =>
      name.toLowerCase() === server.toLowerCase()
    );
    if (found) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!found) {
    throw new Error(
      `Vim server '${server}' did not appear within ${args.waitMs}ms ` +
        `(terminal ${terminal || "unknown"})`,
    );
  }
  const data: z.infer<typeof ServerResourceSchema> = {
    server,
    terminal,
    file: args.file,
    cwd,
    reused: false,
    openedAt: now(),
  };
  return { dataHandles: [await save(ctx, "server", server, data)] };
}

async function status(
  args: z.infer<typeof ServerArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const server = serverOf(ctx.globalArgs, args);
  await ensureRuntime(ctx, server);
  const raw = await vimJson(ctx, server, "SwampVimStatus()");
  const data = statusResource(server, raw);
  return { dataHandles: [await save(ctx, "server-status", server, data)] };
}

async function read(
  args: z.infer<typeof ReadArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const server = serverOf(ctx.globalArgs, args);
  await ensureRuntime(ctx, server);
  const mode = args.mode === "selection"
    ? "selection"
    : args.mode === "visible"
    ? "visible"
    : "all";
  const raw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    `SwampVimRead("${mode}")`,
  );
  let start = Number(raw.start ?? 1);
  const rawEnd = Number(raw.end ?? 0);
  let lines = Array.isArray(raw.lines) ? raw.lines.map((v) => String(v)) : [];
  if (typeof args.start === "number" || typeof args.end === "number") {
    const from = Math.max(start, args.start ?? start);
    const to = Math.min(rawEnd, args.end ?? rawEnd);
    const offset = from - start;
    lines = to >= from ? lines.slice(offset, offset + (to - from + 1)) : [];
    start = from;
  }
  const data: z.infer<typeof BufferSchema> = {
    server,
    file: String(raw.file ?? ""),
    modified: raw.modified === true || raw.modified === 1,
    start,
    end: typeof args.start === "number" || typeof args.end === "number"
      ? start + lines.length - 1
      : rawEnd,
    hasSelection: raw.has_selection === true || raw.has_selection === 1,
    lines,
    cursor: Array.isArray(raw.cursor) ? raw.cursor.map((v) => Number(v)) : [],
    mode: String(raw.mode ?? ""),
    filetype: String(raw.filetype ?? ""),
    capturedAt: now(),
  };
  return {
    dataHandles: [
      await save(
        ctx,
        "buffer",
        `${server}-${fnv1a(data.file || "buffer")}`,
        data,
      ),
    ],
  };
}

async function edit(
  args: z.infer<typeof EditArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const beforeRaw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    'SwampVimRead("all")',
  );
  const beforeLines = Array.isArray(beforeRaw.lines)
    ? beforeRaw.lines.map((v) => String(v))
    : [];
  const afterLines = applyEdits(beforeLines, args.edits);
  const changed = beforeLines.join("\n") !== afterLines.join("\n");
  let undoSeq = 0;
  if (changed) {
    const applied = await vimJson<Record<string, unknown>>(
      ctx,
      server,
      "SwampVimSetLines(" + JSON.stringify(afterLines) + ")",
    );
    undoSeq = Number(applied.undo_seq ?? 0);
    if (Number(applied.changed ?? 0) !== 1) {
      throw new Error("Vim reported no change for a non-identical buffer");
    }
  }
  if (args.save && changed) {
    await remoteExpr(g.vimBin, server, 'execute("write")');
  }
  const file = String(beforeRaw.file ?? "");
  const data: z.infer<typeof EditResultSchema> = {
    server,
    file,
    changed,
    saved: args.save && changed,
    undoSeq,
    beforeHash: await sha256Hex(beforeLines.join("\n")),
    afterHash: await sha256Hex(afterLines.join("\n")),
    beforeLineCount: beforeLines.length,
    afterLineCount: afterLines.length,
    diff: changed ? unifiedDiff(beforeLines, afterLines, file) : "",
    capturedAt: now(),
  };
  return {
    dataHandles: [
      await save(
        ctx,
        "edit-result",
        `${server}-${fnv1a(file || "buffer")}-${Date.now()}`,
        data,
      ),
    ],
  };
}

async function write(
  args: z.infer<typeof WriteArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const output = await remoteExpr(
    g.vimBin,
    server,
    'execute("write' + (args.force ? "!" : "") + '")',
  );
  const data: z.infer<typeof WriteResultSchema> = {
    server,
    force: args.force,
    output: cap(output, g.maxOutputBytes),
    capturedAt: now(),
  };
  return { dataHandles: [await save(ctx, "write-result", server, data)] };
}

async function cursor(
  args: z.infer<typeof CursorArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  await remoteExpr(g.vimBin, server, `cursor(${args.line}, ${args.col})`);
  const raw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    "SwampVimStatus()",
  );
  const data = statusResource(server, raw);
  return { dataHandles: [await save(ctx, "server-status", server, data)] };
}

async function select(
  args: z.infer<typeof SelectArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const raw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    `SwampVimSelect(${args.line1}, ${args.col1}, ${args.line2}, ${args.col2})`,
  );
  const data: z.infer<typeof BufferSchema> = {
    server,
    file: String(raw.file ?? ""),
    modified: raw.modified === true || raw.modified === 1,
    start: Number(raw.start ?? 0),
    end: Number(raw.end ?? 0),
    hasSelection: raw.has_selection === true || raw.has_selection === 1,
    lines: Array.isArray(raw.lines) ? raw.lines.map((v) => String(v)) : [],
    cursor: Array.isArray(raw.cursor) ? raw.cursor.map((v) => Number(v)) : [],
    mode: String(raw.mode ?? ""),
    filetype: String(raw.filetype ?? ""),
    capturedAt: now(),
  };
  return {
    dataHandles: [
      await save(ctx, "buffer", `${server}-selection-${Date.now()}`, data),
    ],
  };
}

async function diff(
  args: z.infer<typeof DiffArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const raw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    'SwampVimRead("all")',
  );
  const file = String(raw.file ?? "");
  const bufferLines = Array.isArray(raw.lines)
    ? raw.lines.map((v) => String(v))
    : [];
  let fileLines: string[] = [];
  try {
    fileLines = (await Deno.readTextFile(file)).split(/\r?\n/);
  } catch {
    fileLines = [];
  }
  const diffText = unifiedDiff(fileLines, bufferLines, file);
  const data: z.infer<typeof DiffResultSchema> = {
    server,
    file,
    changed: diffText.length > 0,
    bufferHash: await sha256Hex(bufferLines.join("\n")),
    fileHash: await sha256Hex(fileLines.join("\n")),
    diff: diffText,
    capturedAt: now(),
  };
  return {
    dataHandles: [
      await save(
        ctx,
        "diff-result",
        `${server}-${fnv1a(file || "buffer")}-${Date.now()}`,
        data,
      ),
    ],
  };
}

async function annotate(
  args: z.infer<typeof AnnotateArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const line = args.clear ? 0 : args.line;
  const raw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    `SwampVimAnnotate(${line}, ${args.col}, ${JSON.stringify(args.text)})`,
  );
  if (Number(raw.ok ?? 0) !== 1) {
    throw new Error(`Vim annotation failed: ${String(raw.error ?? "unknown")}`);
  }
  const data: z.infer<typeof AnnotationSchema> = {
    server,
    line,
    col: args.col,
    text: args.clear ? "" : args.text,
    cleared: args.clear || line === 0,
    capturedAt: now(),
  };
  return {
    dataHandles: [await save(ctx, "annotation", server, data)],
  };
}

async function command(
  args: z.infer<typeof CommandArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  if (!args.allowShell) {
    if (/!/.test(args.command)) {
      throw new Error(
        "Ex command contains '!' (a shell escape); pass allowShell=true if " +
          "that is really intended",
      );
    }
    if (
      /\b(terminal|term|job_start|system|systemlist|writefile)\b/.test(
        args.command,
      )
    ) {
      throw new Error(
        "Ex command starts a shell/process or writes outside Vim; pass " +
          "allowShell=true if that is really intended",
      );
    }
  }
  if (/\b(qa|qall|quit|exit)\b/.test(args.command)) {
    throw new Error("use the close method instead of :qa/:quit");
  }
  const output = await remoteExpr(
    g.vimBin,
    server,
    "execute(" + JSON.stringify(args.command) + ")",
  );
  const data: z.infer<typeof CommandResultSchema> = {
    server,
    command: args.command,
    output: cap(output, g.maxOutputBytes),
    capturedAt: now(),
  };
  return {
    dataHandles: [await save(ctx, "command-result", server, data)],
  };
}

async function expr(
  args: z.infer<typeof ExprArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  if (!args.allowUnsafe) {
    if (
      /\b(writefile|delete|rename|system|systemlist|job_start|term_start|feedkeys|execute|source|setline|append|deletebufline|call)\b/
        .test(args.expr)
    ) {
      throw new Error(
        "expression can mutate the buffer/files or start a process; pass " +
          "allowUnsafe=true if that is really intended",
      );
    }
  }
  const value = await remoteExpr(g.vimBin, server, args.expr);
  const data: z.infer<typeof ExprResultSchema> = {
    server,
    expr: args.expr,
    value: cap(value, g.maxOutputBytes),
    capturedAt: now(),
  };
  return { dataHandles: [await save(ctx, "expr-result", server, data)] };
}

async function keys(
  args: z.infer<typeof KeysArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const result = await remoteSend(g.vimBin, server, args.keys);
  if (result.code !== 0) {
    throw new Error(
      `Vim server '${server}' rejected keys (${result.code}): ${result.stderr}`,
    );
  }
  const data: z.infer<typeof KeysResultSchema> = {
    server,
    keys: args.keys,
    pressedAt: now(),
  };
  return { dataHandles: [await save(ctx, "keys-result", server, data)] };
}

async function diagnostics(
  args: z.infer<typeof ServerArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const raw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    "SwampVimDiagnostics()",
  );
  const data: z.infer<typeof DiagnosticsSchema> = {
    server,
    quickfix: Array.isArray(raw.quickfix)
      ? raw.quickfix as Array<Record<string, unknown>>
      : [],
    location: Array.isArray(raw.location)
      ? raw.location as Array<Record<string, unknown>>
      : [],
    capturedAt: now(),
  };
  return { dataHandles: [await save(ctx, "diagnostics", server, data)] };
}

async function undo(
  args: z.infer<typeof UndoArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  await ensureRuntime(ctx, server);
  const raw = await vimJson<Record<string, unknown>>(
    ctx,
    server,
    `SwampVimUndo(${args.seq})`,
  );
  const data = statusResource(server, raw);
  return { dataHandles: [await save(ctx, "server-status", server, data)] };
}

async function close(
  args: z.infer<typeof CloseArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const server = serverOf(g, args);
  const result = await remoteSend(
    g.vimBin,
    server,
    args.force ? "\x1b:qa!\r" : "\x1b:qa\r",
  );
  const data: z.infer<typeof CloseResultSchema> = {
    server,
    force: args.force,
    closed: result.code === 0,
    capturedAt: now(),
  };
  return { dataHandles: [await save(ctx, "close-result", server, data)] };
}

async function otelStatusMethod(
  args: z.infer<typeof OtelStatusArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const config = otelConfig(g);
  const resolution = await otelStatus(ctx, config);
  let test: Record<string, unknown> | null = null;
  if (args.test && resolution.enabled) {
    const result = await emitSpan(
      ctx,
      config,
      {
        name: "vim.otel-test",
        route: "vim",
        extensionVersion: EXT_VERSION,
        attributes: { "swamp.otel.test": true },
      },
      {
        success: true,
        startTimeMs: Date.now(),
        endTimeMs: Date.now() + 1,
      },
    );
    test = result === null ? { attempted: false } : { ...result };
  }
  const data: z.infer<typeof OtelStatusResourceSchema> = {
    enabled: resolution.enabled,
    endpoint: resolution.endpoint,
    mesh: resolution.mesh,
    source: resolution.source,
    tokenPresent: resolution.tokenPresent,
    reason: resolution.reason,
    serviceName: config.otelServiceName,
    model: config.otelModel,
    test,
    checkedAt: now(),
  };
  return { dataHandles: [await save(ctx, "otel-status", "current", data)] };
}

/** Write a resource and return its handle. */
async function save(
  ctx: MethodContext,
  spec: string,
  name: string,
  data: unknown,
): Promise<{ name: string }> {
  return await ctx.writeResource(spec, safeName(name), data);
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A live Vim server: buffer edits, annotations, diagnostics and commands. */
export const model = {
  type: EXT_TYPE,
  version: EXT_VERSION,
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.23.2",
      description:
        "Adds the edit-session report, visual select and buffer-vs-file diff, and JSONL activity events for the Herdr panel.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  reports: ["@svendowideit/edit-session"],

  resources: {
    server: {
      description: "One Vim server created or adopted by this extension.",
      schema: ServerResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    servers: {
      description: "The Vim servers reachable on this host.",
      schema: ServersResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "server-status": {
      description: "File, modified flag, cursor, mode and line count.",
      schema: ServerStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    buffer: {
      description: "The whole, visible or selected buffer with line numbers.",
      schema: BufferSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "diff-result": {
      description: "The current buffer compared with the saved file.",
      schema: DiffResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "edit-result": {
      description: "One atomic buffer edit, its undo sequence and its diff.",
      schema: EditResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    annotation: {
      description: "The agent's virtual cursor/annotation in the buffer.",
      schema: AnnotationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    diagnostics: {
      description: "Vim's quickfix and location lists.",
      schema: DiagnosticsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "command-result": {
      description: "The output of one Ex command.",
      schema: CommandResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "expr-result": {
      description: "The value of one Vimscript expression.",
      schema: ExprResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "keys-result": {
      description: "One literal key sequence sent to Vim.",
      schema: KeysResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "write-result": {
      description: "The result of writing the buffer.",
      schema: WriteResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "close-result": {
      description: "The result of closing the Vim server.",
      schema: CloseResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "otel-status": {
      description: "Whether and where this model exports OTLP spans.",
      schema: OtelStatusResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    servers: {
      description: "List the Vim servers reachable with --serverlist.",
      arguments: ServerArgsSchema,
      execute: (args: z.infer<typeof ServerArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("servers", args),
          () => servers(args, ctx),
        ),
    },
    open: {
      description:
        "Start Vim with a stable --servername in a herdr-core terminal, or " +
        "adopt an existing server. The window stays open for a human to watch.",
      arguments: OpenArgsSchema,
      execute: (args: z.infer<typeof OpenArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("open", args, {
            target: args.server,
            attributes: { "swamp.file": args.file },
          }),
          () => open(args, ctx),
        ),
    },
    status: {
      description:
        "Report the file, modified flag, line count, cursor, mode and filetype.",
      arguments: ServerArgsSchema,
      execute: (args: z.infer<typeof ServerArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("status", args, { target: args.server }),
          () => status(args, ctx),
        ),
    },
    read: {
      description:
        "Read the whole buffer, the visible window, or the visual selection.",
      arguments: ReadArgsSchema,
      execute: (args: z.infer<typeof ReadArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("read", args, {
            target: args.server,
            attributes: { "swamp.mode": args.mode },
          }),
          () => read(args, ctx),
        ),
    },
    edit: {
      description:
        "Apply exact-text or line-range edits to the buffer in one atomic " +
        "call, returning an undo sequence and a unified diff.",
      arguments: EditArgsSchema,
      execute: (args: z.infer<typeof EditArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("edit", args, {
            target: args.server,
            attributes: { "swamp.edit_count": args.edits.length },
          }),
          () => edit(args, ctx),
        ),
    },
    write: {
      description: "Write the buffer; force is a separate, explicit choice.",
      arguments: WriteArgsSchema,
      execute: (args: z.infer<typeof WriteArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("write", args, { target: args.server }),
          () => write(args, ctx),
        ),
    },
    cursor: {
      description: "Move the cursor to a 1-indexed line and column.",
      arguments: CursorArgsSchema,
      execute: (args: z.infer<typeof CursorArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("cursor", args, { target: args.server }),
          () => cursor(args, ctx),
        ),
    },
    select: {
      description:
        "Select a visual range (1-indexed) and return the selected lines; the " +
        "human's real cursor is not moved outside the selection.",
      arguments: SelectArgsSchema,
      execute: (args: z.infer<typeof SelectArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("select", args, { target: args.server }),
          () => select(args, ctx),
        ),
    },
    diff: {
      description:
        "Compare the current buffer with the file on disk and return a unified diff.",
      arguments: DiffArgsSchema,
      execute: (args: z.infer<typeof DiffArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("diff", args, { target: args.server }),
          () => diff(args, ctx),
        ),
    },
    annotate: {
      description:
        "Draw the agent's virtual cursor/annotation with Vim text properties; " +
        "clear=true removes it. The human keeps the real cursor.",
      arguments: AnnotateArgsSchema,
      execute: (args: z.infer<typeof AnnotateArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("annotate", args, { target: args.server }),
          () => annotate(args, ctx),
        ),
    },
    command: {
      description:
        "Execute one Ex command. Shell escapes and process-starting commands " +
        "require allowShell=true.",
      arguments: CommandArgsSchema,
      execute: (args: z.infer<typeof CommandArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("command", args, { target: args.server }),
          () => command(args, ctx),
        ),
    },
    expr: {
      description:
        "Evaluate a Vimscript expression. Expressions that can mutate files or " +
        "start processes require allowUnsafe=true.",
      arguments: ExprArgsSchema,
      execute: (args: z.infer<typeof ExprArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("expr", args, { target: args.server }),
          () => expr(args, ctx),
        ),
    },
    keys: {
      description:
        "Send a literal key sequence with --remote-send. Prefer the structured " +
        "methods; use this only for a UI action they cannot express.",
      arguments: KeysArgsSchema,
      execute: (args: z.infer<typeof KeysArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("keys", args, { target: args.server }),
          () => keys(args, ctx),
        ),
    },
    diagnostics: {
      description: "Read Vim's quickfix and location lists.",
      arguments: ServerArgsSchema,
      execute: (args: z.infer<typeof ServerArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("diagnostics", args, { target: args.server }),
          () => diagnostics(args, ctx),
        ),
    },
    undo: {
      description: "Undo to a sequence recorded by an edit, or one step.",
      arguments: UndoArgsSchema,
      execute: (args: z.infer<typeof UndoArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("undo", args, { target: args.server }),
          () => undo(args, ctx),
        ),
    },
    close: {
      description:
        "Close the Vim server. force=true sends :qa!; false sends :qa and can " +
        "be refused by a modified buffer.",
      arguments: CloseArgsSchema,
      execute: (args: z.infer<typeof CloseArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("close", args, { target: args.server }),
          () => close(args, ctx),
        ),
    },
    "otel-status": {
      description:
        "Report whether OTLP tracing is configured, where it points, and why " +
        "it is disabled. test=true posts one test span.",
      arguments: OtelStatusArgsSchema,
      execute: (
        args: z.infer<typeof OtelStatusArgsSchema>,
        ctx: MethodContext,
      ) => otelStatusMethod(args, ctx),
    },
  },
};
