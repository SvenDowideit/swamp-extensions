/**
 * @svendowideit/herdr-core — the swamp face of a persistent herdr-core session.
 *
 * herdr-core (`hc`) owns terminals, their processes, scrollback, files and a
 * fleet of other machines. This model turns that runtime into swamp data and
 * methods so an agent can observe and drive a live session instead of spawning
 * a shell process per action.
 *
 * Methods are intentionally small and fan out internally:
 *   status, terminals, read, run, send, keys, interrupt, kill, rm, put,
 *   wait, exec, file-read, file-write, file-edit, search,
 *   machines, machine-add, machine-remove, otel-status.
 *
 * Every method emits one OTLP span (when OTEL is configured) with
 * `swamp.route=herdr-core`; see `herdr_core_otel.ts`.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  emitSpan,
  type OtelConfig,
  OtelConfigSchema,
  otelStatus,
  withOtelSpan,
} from "./herdr_core_otel.ts";

/** The model type. */
export const EXT_TYPE = "@svendowideit/herdr-core";
/** The extension version; keep in step with manifest.yaml. */
export const EXT_VERSION = "2026.11.28.1";
/** The herdr-core binary used when `herdrBin` is not set. */
export const DEFAULT_BIN = "herdr-core";

// ---------------------------------------------------------------------------
// Global and method arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  herdrBin: z.string().default(DEFAULT_BIN).describe(
    "herdr-core binary (or `hc` alias) to run.",
  ),
  herdrAppBin: z.string().default("herdr-app").describe(
    "herdr-app binary: reads the window's spaces and tabs for pi-sessions.",
  ),
  defaultCwd: z.string().default("").describe(
    "Working directory for commands when the method does not give one.",
  ),
  defaultMachine: z.string().default("").describe(
    "herdr-core machine to target when the method does not give one.",
  ),
  maxOutputBytes: z.number().int().positive().default(200_000).describe(
    "Maximum bytes of terminal/file/exec output retained in data.",
  ),
  ...OtelConfigSchema.shape,
});

/** Global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const TargetArgsSchema = z.object({
  targets: z.array(z.string()).min(1).describe(
    "Terminal addresses (`t7`) or names; `machine/t7` selects a machine.",
  ),
  machine: z.string().default("").describe(
    "Machine prefix for targets that do not already carry one.",
  ),
});

// ---------------------------------------------------------------------------
// Pi sessions: which pi session runs in which terminal, tab and space
// ---------------------------------------------------------------------------

/** The label that marks a terminal as a pi session. */
export const PI_SESSION_LABEL = "pi.session";
/** The label holding the pi session's own state word: running, exited. */
export const PI_STATE_LABEL = "pi.state";
/** The label holding why a session that exited was left. */
export const PI_END_LABEL = "pi.end";

const LabelArgsSchema = z.object({
  target: z.string().describe("Terminal address (`t7`) or name."),
  machine: z.string().default("").describe(
    "Machine prefix for a bare address.",
  ),
  labels: z.record(z.string(), z.string()).describe(
    "Labels to set, key=value. An empty value removes one.",
  ),
});

const PiSessionsArgsSchema = z.object({
  all: z.boolean().default(true).describe(
    "Include finished terminals: they are where a lost session is recorded.",
  ),
  machine: z.string().default("").describe(
    "Only terminals on this machine (default: every machine).",
  ),
  maxAgeDays: z.number().int().positive().default(14).describe(
    "Do not resume a session whose terminal was created longer ago.",
  ),
});

const PiResumeArgsSchema = PiSessionsArgsSchema.extend({
  dryRun: z.boolean().default(false).describe(
    "Report the plan and start nothing.",
  ),
  only: z.string().default("").describe(
    "Limit to one space name, tab name or terminal address.",
  ),
});

const PiSessionResourceSchema = z.object({
  terminal: z.string(),
  machine: z.string().default(""),
  sessionId: z.string().default(""),
  spaceId: z.string().default(""),
  spaceName: z.string().default(""),
  tabId: z.string().default(""),
  tabName: z.string().default(""),
  cwd: z.string().default(""),
  agent: z.string().default(""),
  liveState: z.string().default(""),
  herdrReason: z.string().default(""),
  piState: z.string().default(""),
  createdAt: z.string().default(""),
  decision: z.string().default(""),
  why: z.string().default(""),
});

const PiSessionsResourceSchema = z.object({
  count: z.number(),
  resumeCount: z.number(),
  byDecision: z.record(z.string(), z.number()),
  sessions: z.array(PiSessionResourceSchema),
  capturedAt: z.string(),
});

const PiResumedSchema = z.object({
  terminal: z.string(),
  sessionId: z.string(),
  spaceName: z.string().default(""),
  tabName: z.string().default(""),
  resumedAs: z.string().default(""),
  placedInTab: z.boolean().default(false),
  staleKilled: z.string().default(""),
  error: z.string().default(""),
});

const PiResumeResourceSchema = z.object({
  dryRun: z.boolean(),
  resumed: z.array(PiResumedSchema),
  skipped: z.array(
    z.object({
      terminal: z.string(),
      sessionId: z.string().default(""),
      why: z.string(),
    }),
  ),
  capturedAt: z.string(),
});

/** Reasons a program vanished because the host went away, not the person. */
const HOST_ENDED = new Set([
  "host_shutdown",
  "server_stop",
  "holder_lost",
  "signaled",
  "stopped_by_restart",
]);

/** Reasons the person themselves ended it. */
const PERSON_ENDED = new Set(["exited", "killed"]);

/**
 * Decide whether a terminal's pi session should come back after a restart.
 *
 * The record is the terminal's own labels, so nothing but the terminal can
 * disagree with it: `pi.state=exited` is a session the person quit, and a
 * missing shutdown with a shell sitting in the tab is the reboot case.
 * Pure, so the rule is testable without a running herdr-core.
 */
export function decidePiResume(
  terminal: {
    agent: string;
    liveState: string;
    herdrReason: string;
    labels: Record<string, string>;
    createdAtMs: number;
  },
  nowMs: number,
  maxAgeDays: number,
): { decision: "resume" | "skip"; why: string } {
  const sessionId = terminal.labels[PI_SESSION_LABEL] ?? "";
  if (!sessionId) return { decision: "skip", why: "no pi session recorded" };
  const piState = terminal.labels[PI_STATE_LABEL] ?? "";
  if (piState === "exited") {
    return {
      decision: "skip",
      why: `left deliberately (${terminal.labels[PI_END_LABEL] || "quit"})`,
    };
  }
  if (terminal.createdAtMs > 0) {
    const ageDays = Math.floor((nowMs - terminal.createdAtMs) / 86_400_000);
    if (ageDays > maxAgeDays) {
      return { decision: "skip", why: `stale: ${ageDays} days old` };
    }
  }
  if (PERSON_ENDED.has(terminal.herdrReason)) {
    return { decision: "skip", why: `you ended it (${terminal.herdrReason})` };
  }
  if (HOST_ENDED.has(terminal.herdrReason)) {
    return {
      decision: "resume",
      why: `host ended it (${terminal.herdrReason})`,
    };
  }
  if ((terminal.liveState || "live") !== "live") {
    return {
      decision: "skip",
      why: `finished without a restart (${terminal.herdrReason || "exited"})`,
    };
  }
  if (terminal.agent === "pi") {
    return { decision: "skip", why: "session is still running" };
  }
  // Live terminal carrying a pi record, but a shell inside: the restart put it
  // back as a shell. It is the reboot case, and its tab still points at it.
  return { decision: "resume", why: "program lost when the host restarted" };
}

/** One tab of one space, as herdr-app reports it. */
type HerdrTab = { id: string; name: string; terminals: string[] };
/** One space, as herdr-app reports it. */
type HerdrSpace = { id: string; name: string; tabs: HerdrTab[] };
/** Where the window puts a terminal: its space and tab. */
type HerdrWhere = {
  spaceId: string;
  spaceName: string;
  tabId: string;
  tabName: string;
};

/** Read the window's spaces > tabs > terminals, or [] when no window is open. */
async function herdrAppSpaces(bin: string): Promise<HerdrSpace[]> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runHc(bin, ["ls"]);
  } catch {
    return [];
  }
  if (result.code !== 0) return [];
  let raw: { spaces?: unknown };
  try {
    raw = JSON.parse(result.stdout) as { spaces?: unknown };
  } catch {
    return [];
  }
  const spaces = Array.isArray(raw.spaces)
    ? raw.spaces as Array<Record<string, unknown>>
    : [];
  return spaces.map((space) => {
    const tabs = Array.isArray(space.tabs)
      ? space.tabs as Array<Record<string, unknown>>
      : [];
    return {
      id: String(space.id ?? ""),
      name: String(space.name ?? ""),
      tabs: tabs.map((tab) => ({
        id: String(tab.id ?? ""),
        name: String(tab.name ?? ""),
        terminals: (Array.isArray(tab.terminals)
          ? tab.terminals as Array<Record<string, unknown>>
          : [])
          .map((t) =>
            String(t.terminal ?? "")
          )
          .filter(Boolean),
      })),
    };
  });
}

/** Map every terminal address the window shows to its space and tab. */
function whereByTerminal(spaces: HerdrSpace[]): Map<string, HerdrWhere> {
  const map = new Map<string, HerdrWhere>();
  for (const space of spaces) {
    for (const tab of space.tabs) {
      for (const terminal of tab.terminals) {
        map.set(terminal, {
          spaceId: space.id,
          spaceName: space.name,
          tabId: tab.id,
          tabName: tab.name,
        });
      }
    }
  }
  return map;
}

/**
 * Every terminal as `hc get` describes it.
 *
 * `hc ls` leaves out labels and created_ms, and the record is a label, so the
 * list is only used for addresses and each one is fetched in full.
 */
async function piRows(
  bin: string,
  all: boolean,
): Promise<Array<Record<string, unknown>>> {
  const raw = await hcJson(bin, all ? ["ls", "--all"] : ["ls"]);
  const listed = Array.isArray(raw.terminals)
    ? raw.terminals as Array<Record<string, unknown>>
    : [];
  const rows: Array<Record<string, unknown>> = [];
  for (const item of listed) {
    const address = String(item.address ?? "");
    if (!address) continue;
    rows.push(await hcJson(bin, ["get", address]));
  }
  return rows;
}

/** One `hc ls --all` row, as far as pi sessions care about it. */
function piRow(
  row: Record<string, unknown>,
  machine: string,
  where: Map<string, HerdrWhere>,
): { address: string; record: z.infer<typeof PiSessionResourceSchema> } {
  const address = String(row.address ?? "");
  const labels: Record<string, string> =
    typeof row.labels === "object" && row.labels !== null
      ? row.labels as Record<string, string>
      : {};
  const placed = where.get(address);
  const created = typeof row.created_ms === "number"
    ? new Date(row.created_ms as number).toISOString()
    : "";
  return {
    address,
    record: {
      terminal: address,
      machine: machineOf(address, machine),
      sessionId: String(labels[PI_SESSION_LABEL] ?? ""),
      spaceId: placed?.spaceId ?? "",
      spaceName: placed?.spaceName ?? "",
      tabId: placed?.tabId ?? "",
      tabName: placed?.tabName ?? "",
      cwd: String(row.cwd ?? ""),
      agent: String(row.agent ?? ""),
      liveState: String(row.state ?? ""),
      herdrReason: String(row.reason ?? ""),
      piState: String(labels[PI_STATE_LABEL] ?? ""),
      createdAt: created,
      decision: "",
      why: "",
    },
  };
}

/** Set labels on a terminal and return it as the model sees terminals. */
async function label(
  args: z.infer<typeof LabelArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const address = addressFor(args.target, machine);
  const pairs = Object.entries(args.labels).map(([key, value]) =>
    `${key}=${value}`
  );
  await hcJson(g.herdrBin, ["label", address, ...pairs]);
  const detail = await hcJson(g.herdrBin, ["get", address]);
  const resource = terminalResource(detail, machine);
  return {
    dataHandles: [await save(ctx, "terminal", resource.address, resource)],
  };
}

/** Report every pi session a terminal records, with its resume decision. */
async function piSessions(
  args: z.infer<typeof PiSessionsArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const rows = await piRows(g.herdrBin, args.all);
  const where = whereByTerminal(await herdrAppSpaces(g.herdrAppBin));
  const nowMs = Date.now();
  const handles: Array<{ name: string }> = [];
  const sessions: Array<z.infer<typeof PiSessionResourceSchema>> = [];
  const byDecision: Record<string, number> = {};
  for (const row of rows) {
    const { address, record } = piRow(row, machine, where);
    if (!record.sessionId) continue;
    if (machine && record.machine !== machine) continue;
    const createdAtMs = typeof row.created_ms === "number"
      ? row.created_ms as number
      : 0;
    const verdict = decidePiResume(
      {
        agent: record.agent,
        liveState: record.liveState,
        herdrReason: record.herdrReason,
        labels: {
          [PI_SESSION_LABEL]: record.sessionId,
          [PI_STATE_LABEL]: record.piState,
        },
        createdAtMs,
      },
      nowMs,
      args.maxAgeDays,
    );
    record.decision = verdict.decision;
    record.why = verdict.why;
    byDecision[verdict.decision] = (byDecision[verdict.decision] ?? 0) + 1;
    sessions.push(record);
    handles.push(await save(ctx, "pi-session", address, record));
  }
  const fleet: z.infer<typeof PiSessionsResourceSchema> = {
    count: sessions.length,
    resumeCount: sessions.filter((s) => s.decision === "resume").length,
    byDecision,
    sessions,
    capturedAt: now(),
  };
  handles.push(await save(ctx, "pi-sessions", "current", fleet));
  return { dataHandles: handles };
}

/** Start a lost pi session again in the tab it was lost from. */
async function piResume(
  args: z.infer<typeof PiResumeArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const rows = await piRows(g.herdrBin, args.all);
  const where = whereByTerminal(await herdrAppSpaces(g.herdrAppBin));
  const nowMs = Date.now();
  const resumed: Array<z.infer<typeof PiResumedSchema>> = [];
  const skipped: Array<{ terminal: string; sessionId: string; why: string }> =
    [];
  for (const row of rows) {
    const { address, record } = piRow(row, machine, where);
    if (!record.sessionId) continue;
    if (machine && record.machine !== machine) continue;
    const only = args.only.trim();
    if (
      only &&
      only !== address &&
      only !== record.spaceName &&
      only !== record.tabName
    ) continue;
    const createdAtMs = typeof row.created_ms === "number"
      ? row.created_ms as number
      : 0;
    const verdict = decidePiResume(
      {
        agent: record.agent,
        liveState: record.liveState,
        herdrReason: record.herdrReason,
        labels: {
          [PI_SESSION_LABEL]: record.sessionId,
          [PI_STATE_LABEL]: record.piState,
        },
        createdAtMs,
      },
      nowMs,
      args.maxAgeDays,
    );
    if (verdict.decision !== "resume") {
      skipped.push({
        terminal: address,
        sessionId: record.sessionId,
        why: verdict.why,
      });
      continue;
    }
    if (!record.tabId) {
      // Without a tab id there is nowhere to put it back: starting it anyway
      // would drop the session into whatever space happens to be focused.
      skipped.push({
        terminal: address,
        sessionId: record.sessionId,
        why: "no space/tab recorded (is herdr-app running?)",
      });
      continue;
    }
    const entry: z.infer<typeof PiResumedSchema> = {
      terminal: address,
      sessionId: record.sessionId,
      spaceName: record.spaceName,
      tabName: record.tabName,
      resumedAs: "",
      placedInTab: false,
      staleKilled: "",
      error: "",
    };
    if (args.dryRun) {
      resumed.push(entry);
      continue;
    }
    try {
      const runArgs = ["run", "--bg", "--no-notify"];
      if (record.cwd) runArgs.push("--cwd", record.cwd);
      if (record.spaceId) {
        runArgs.push("--label", `herdr.space=${record.spaceId}`);
      }
      if (record.tabId) runArgs.push("--label", `herdr.tab=${record.tabId}`);
      runArgs.push("--label", `${PI_SESSION_LABEL}=${record.sessionId}`);
      runArgs.push("--label", `${PI_STATE_LABEL}=running`);
      runArgs.push("pi", "--session", record.sessionId);
      const started = await hcJson(g.herdrBin, runArgs);
      entry.resumedAs = String(started.address ?? "");
      // Clear the stale shell only once the new terminal is seen in its tab: a
      // tab whose last terminal goes closes, taking its id with it.
      const after = whereByTerminal(await herdrAppSpaces(g.herdrAppBin));
      const placed = after.get(entry.resumedAs);
      entry.placedInTab = Boolean(
        placed && record.tabId && placed.tabId === record.tabId,
      );
      if (entry.placedInTab && address !== entry.resumedAs) {
        await hcJson(g.herdrBin, ["kill", address]);
        entry.staleKilled = address;
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    resumed.push(entry);
  }
  const plan: z.infer<typeof PiResumeResourceSchema> = {
    dryRun: args.dryRun,
    resumed,
    skipped,
    capturedAt: now(),
  };
  return { dataHandles: [await save(ctx, "pi-resume", "current", plan)] };
}

const StatusArgsSchema = z.object({});

const TerminalsArgsSchema = z.object({
  all: z.boolean().default(false).describe(
    "Include finished terminals as well as live ones.",
  ),
  machine: z.string().default("").describe("Only this machine."),
  agent: z.string().default("").describe("Only terminals running this agent."),
  cwd: z.string().default("").describe(
    "Only terminals in this working directory.",
  ),
  state: z.string().default("").describe("Only this state (live, finished)."),
  label: z.string().default("").describe(
    "Only terminals with this `key=value` label.",
  ),
  detail: z.boolean().default(false).describe(
    "Call `hc get` for each terminal to include argv, pid and labels.",
  ),
});

const ReadArgsSchema = z.object({
  targets: z.array(z.string()).min(1).describe("Terminal addresses or names."),
  machine: z.string().default("").describe(
    "Machine prefix for bare addresses.",
  ),
  lines: z.number().int().min(0).default(0).describe(
    "Lines of history above the screen.",
  ),
});

const RunArgsSchema = z.object({
  argv: z.array(z.string()).min(1).describe(
    "Program and arguments, run as given (no shell).",
  ),
  name: z.string().default("").describe(
    "Unique terminal name (1-32 of a-z 0-9 - _).",
  ),
  cwd: z.string().default("").describe("Working directory."),
  machine: z.string().default("").describe("Run on this herdr-core machine."),
  labels: z.record(z.string(), z.string()).default({}).describe(
    "Labels attached to the terminal.",
  ),
  bg: z.boolean().default(false).describe(
    "Start the program and return at once instead of waiting for it.",
  ),
  keep: z.boolean().default(false).describe(
    "Replace a lost program with a shell instead of closing the terminal.",
  ),
  timeout: z.number().int().positive().default(180).describe(
    "Seconds before a waiting run checks in (leaving it running).",
  ),
});

const SendArgsSchema = TargetArgsSchema.extend({
  text: z.string().describe("Text pasted into the terminal, then Enter."),
  force: z.boolean().default(false).describe(
    "Type even if the program is blocked (it may answer its dialog).",
  ),
  ifStatus: z.enum(["", "idle", "working"]).default("").describe(
    "Only type when the terminal has exactly this status.",
  ),
  wait: z.boolean().default(false).describe(
    "Wait for the turn the send started.",
  ),
  timeout: z.number().int().positive().default(180).describe(
    "Seconds before the wait checks in.",
  ),
});

const KeysArgsSchema = TargetArgsSchema.extend({
  keys: z.array(z.string()).min(1).describe(
    "Key names: enter, esc, tab, up, ctrl+c, alt+x, f5, a, ...",
  ),
});

const WaitArgsSchema = z.object({
  target: z.string().default("").describe(
    "Terminal to wait for; empty waits on children.",
  ),
  machine: z.string().default("").describe(
    "Machine prefix for a bare address.",
  ),
  output: z.string().default("").describe(
    "End when output printed after the wait started contains this text.",
  ),
  children: z.enum(["", "any", "all"]).default("").describe(
    "Wait on children instead: any = next news, all = until none is working.",
  ),
  timeout: z.number().int().positive().default(180).describe(
    "Seconds before the wait checks in.",
  ),
});

const ExecArgsSchema = z.object({
  argv: z.array(z.string()).min(1).describe(
    "Program and arguments, run as given (no shell).",
  ),
  machines: z.array(z.string()).default([]).describe(
    "Run on these herdr-core machines; empty uses `machine` or this host.",
  ),
  machine: z.string().default("").describe("Single machine to run on."),
  cwd: z.string().default("").describe("Working directory."),
  env: z.record(z.string(), z.string()).default({}).describe(
    "Environment variables set on top of the core's environment.",
  ),
  timeout: z.number().int().positive().default(60).describe(
    "Seconds before the program and everything it started are ended.",
  ),
  stdin: z.string().default("").describe("Text fed to the program's stdin."),
});

const FileReadArgsSchema = z.object({
  paths: z.array(z.string()).min(1).describe("Files to read."),
  machine: z.string().default("").describe("Read on this machine."),
  cwd: z.string().default("").describe("Base for relative paths."),
  offset: z.number().int().min(1).default(1).describe("First line, from 1."),
  limit: z.number().int().positive().default(0).describe(
    "At most this many lines; 0 means all.",
  ),
});

const FileWriteArgsSchema = z.object({
  path: z.string().min(1).describe("File to write."),
  content: z.string().describe("New file contents."),
  machine: z.string().default("").describe("Write on this machine."),
  cwd: z.string().default("").describe("Base for a relative path."),
});

const FileEditArgsSchema = z.object({
  path: z.string().min(1).describe("File to edit."),
  edits: z.array(z.object({
    old: z.string().describe("Exact text found exactly once."),
    new: z.string().describe("Replacement text."),
  })).min(1).describe("All edits are made or none."),
  machine: z.string().default("").describe("Edit on this machine."),
  cwd: z.string().default("").describe("Base for a relative path."),
});

const FileEditLinesArgsSchema = z.object({
  path: z.string().min(1).describe("File to edit."),
  edits: z.array(z.object({
    startLine: z.number().int().min(1).describe(
      "First line to replace, 1-indexed.",
    ),
    endLine: z.number().int().min(1).optional().describe(
      "Last line to replace; defaults to startLine.",
    ),
    lines: z.array(z.string()).describe("Replacement lines."),
    expectedLines: z.array(z.string()).optional().describe(
      "The lines the caller saw; refuse if they no longer match.",
    ),
  })).min(1).describe(
    "Line-range edits, applied bottom-up so line numbers stay valid.",
  ),
  machine: z.string().default("").describe("Edit on this machine."),
  cwd: z.string().default("").describe("Base for a relative path."),
  expectedHash: z.string().default("").describe(
    "Optional SHA-256 of the current file; refuse if it changed.",
  ),
});

const SearchArgsSchema = z.object({
  pattern: z.string().min(1).describe("ripgrep pattern."),
  paths: z.array(z.string()).default([]).describe(
    "Files or directories; empty searches the working directory.",
  ),
  globs: z.array(z.string()).default([]).describe("ripgrep -g globs."),
  machine: z.string().default("").describe("Search on this machine."),
  cwd: z.string().default("").describe("Working directory."),
  caseSensitive: z.boolean().default(false).describe("Do not pass -i."),
  fixedStrings: z.boolean().default(false).describe("Pass -F."),
  hidden: z.boolean().default(false).describe("Pass --hidden."),
  noIgnore: z.boolean().default(false).describe("Pass --no-ignore."),
  maxResults: z.number().int().positive().default(200).describe(
    "Stop after this many matches.",
  ),
});

const MachinesArgsSchema = z.object({});

const MachineAddArgsSchema = z.object({
  target: z.string().min(1).describe(
    "How ssh reaches it: a host, user@host:port, or an ~/.ssh/config Host.",
  ),
  name: z.string().default("").describe("Name to use locally."),
  via: z.string().default("").describe(
    "Command that reaches the machine instead of ssh.",
  ),
  install: z.boolean().default(false).describe(
    "Install hc there if it has none or one too old.",
  ),
  temporary: z.boolean().default(false).describe("Mark it short-lived."),
});

const MachineRemoveArgsSchema = z.object({
  machine: z.string().min(1).describe("Machine name to forget."),
});

const OtelStatusArgsSchema = z.object({
  test: z.boolean().default(false).describe(
    "Also post a test span and report the HTTP result.",
  ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const TerminalResourceSchema = z.object({
  address: z.string(),
  name: z.string().default(""),
  agent: z.string().default(""),
  cwd: z.string().default(""),
  state: z.string().default(""),
  status: z.string().nullable().default(null),
  turn: z.number().default(0),
  where: z.string().default(""),
  machine: z.string().default(""),
  parent: z.string().default(""),
  pid: z.number().nullable().default(null),
  createdAt: z.string().default(""),
  labels: z.record(z.string(), z.string()).default({}),
});

const FleetResourceSchema = z.object({
  count: z.number(),
  byAgent: z.record(z.string(), z.number()),
  byMachine: z.record(z.string(), z.number()),
  terminals: z.array(TerminalResourceSchema),
  capturedAt: z.string(),
});

const ReadResultSchema = z.object({
  target: z.string(),
  machine: z.string().default(""),
  text: z.string(),
  complete: z.boolean().default(true),
  how: z.string().default(""),
  bytes: z.number(),
  capturedAt: z.string(),
});

const RunResultSchema = z.object({
  address: z.string(),
  name: z.string().default(""),
  machine: z.string().default(""),
  cwd: z.string().default(""),
  state: z.string().default(""),
  output: z.string().default(""),
  exitCode: z.number().nullable().default(null),
  signal: z.number().nullable().default(null),
  reason: z.string().default(""),
  timeout: z.boolean().default(false),
  startedAt: z.string(),
});

const SendResultSchema = z.object({
  target: z.string(),
  status: z.string().nullable().default(null),
  turn: z.number().default(0),
  started: z.string().nullable().default(null),
  sentAt: z.string(),
});

const KeysResultSchema = z.object({
  target: z.string(),
  status: z.string().nullable().default(null),
  turn: z.number().default(0),
  pressedAt: z.string(),
});

const WaitResultSchema = z.object({
  target: z.string().default(""),
  ended: z.boolean().default(false),
  reason: z.string().default(""),
  exitCode: z.number().nullable().default(null),
  signal: z.number().nullable().default(null),
  status: z.string().nullable().default(null),
  turn: z.number().default(0),
  checkedAt: z.string(),
});

const ExecResultSchema = z.object({
  machine: z.string().default(""),
  code: z.number().nullable().default(null),
  signal: z.number().nullable().default(null),
  stdout: z.string(),
  stderr: z.string(),
  ms: z.number().default(0),
  timedOut: z.boolean().default(false),
  truncated: z.boolean().default(false),
  capturedAt: z.string(),
});

const FileResultSchema = z.object({
  path: z.string(),
  machine: z.string().default(""),
  bytes: z.number().default(0),
  first: z.number().nullable().default(null),
  last: z.number().nullable().default(null),
  lineCount: z.number().nullable().default(null),
  text: z.string().default(""),
  operation: z.enum(["read", "write", "edit", "edit-lines"]),
  capturedAt: z.string(),
});

const SearchMatchSchema = z.object({
  path: z.string(),
  line: z.number(),
  column: z.number(),
  endColumn: z.number().default(0),
  text: z.string(),
  match: z.string().default(""),
});

const SearchResultSchema = z.object({
  pattern: z.string(),
  machine: z.string().default(""),
  count: z.number(),
  truncated: z.boolean().default(false),
  matches: z.array(SearchMatchSchema),
  capturedAt: z.string(),
});

const MachinesResourceSchema = z.object({
  count: z.number(),
  machines: z.array(z.object({
    name: z.string(),
    host: z.string().default(""),
    id: z.string().default(""),
    state: z.string().default(""),
    version: z.string().default(""),
    target: z.string().default(""),
  })),
  capturedAt: z.string(),
});

const StatusResourceSchema = z.object({
  core: z.object({
    id: z.string().default(""),
    name: z.string().default(""),
  }),
  version: z.string().default(""),
  pid: z.number().nullable().default(null),
  uptimeMs: z.number().nullable().default(null),
  live: z.number().default(0),
  finished: z.number().default(0),
  holders: z.array(z.record(z.string(), z.unknown())).default([]),
  machines: z.array(z.record(z.string(), z.unknown())).default([]),
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
// Method context and helpers
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
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Decode UTF-8. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Run herdr-core with an optional stdin. */
async function runHc(
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
    stdout: decode(output.stdout),
    stderr: decode(output.stderr),
  };
}

/** Run a herdr-core command that must return JSON. */
async function hcJson<T = Record<string, unknown>>(
  bin: string,
  args: string[],
  stdin?: string,
): Promise<T> {
  // `--json` must precede a `--` separator; after it, herdr-core treats it as
  // a positional argument (for example an argv item for `exec`).
  const separator = args.indexOf("--");
  const withJson = separator === -1
    ? [...args, "--json"]
    : [...args.slice(0, separator), "--json", ...args.slice(separator)];
  const result = await runHc(bin, withJson, stdin);
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

/** Decode base64 stdout/stderr from `hc exec`. */
export function decodeBase64(value: string): string {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** A safe resource name. */
function safeName(value: string): string {
  const name = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (name || "item").slice(0, 64);
}

/** The machine part of an address, or the fallback. */
function machineOf(address: string, fallback: string): string {
  const index = address.indexOf("/");
  return index > 0 ? address.slice(0, index) : fallback;
}

/** Prefix a bare target with a machine when one is set. */
function addressFor(target: string, machine: string): string {
  if (!machine || target.includes("/")) return target;
  return `${machine}/${target}`;
}

/** Truncate retained output. */
function cap(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return text.slice(0, maxBytes) + `\n… truncated at ${maxBytes} bytes`;
}

/** ISO timestamp. */
function now(): string {
  return new Date().toISOString();
}

/** Split text into lines, preserving whether the file ended with a newline. */
export function splitTextLines(
  text: string,
): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split(/\r?\n/), trailingNewline };
}

/** A line-range edit, 1-indexed, with an optional context check. */
export interface LineEdit {
  startLine: number;
  endLine?: number;
  lines: string[];
  expectedLines?: string[];
}

/** Apply line-range edits bottom-up, refusing out-of-range or stale edits. */
export function applyLineEdits(
  input: string[],
  edits: LineEdit[],
): string[] {
  const lines = [...input];
  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine);
  for (const edit of ordered) {
    const start = edit.startLine;
    const end = edit.endLine ?? start;
    if (start < 1 || end < start - 1) {
      throw new Error(`invalid line range ${start}..${end}`);
    }
    if (start > lines.length + 1) {
      throw new Error(
        `line range starts past the file (${lines.length} lines): ${start}`,
      );
    }
    if (end > lines.length) {
      throw new Error(
        `line range ends past the file (${lines.length} lines): ${end}`,
      );
    }
    if (edit.expectedLines) {
      const current = lines.slice(
        start - 1,
        start - 1 + edit.expectedLines.length,
      );
      if (
        current.length !== edit.expectedLines.length ||
        current.some((line, index) => line !== edit.expectedLines![index])
      ) {
        throw new Error(
          `lines ${start}..${
            start + edit.expectedLines.length - 1
          } no longer ` +
            `match the expected text; re-read the file`,
        );
      }
    }
    const remove = end >= start ? end - start + 1 : 0;
    lines.splice(start - 1, remove, ...edit.lines);
  }
  return lines;
}

/** SHA-256 hex, used for the optional stale-file check. */
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

/** Map a `hc ls`/`hc get` terminal to a resource. */
function terminalResource(
  raw: Record<string, unknown>,
  machine: string,
): z.infer<typeof TerminalResourceSchema> {
  const address = String(raw.address ?? "");
  return {
    address,
    name: String(raw.name ?? ""),
    agent: String(raw.agent ?? ""),
    cwd: String(raw.cwd ?? ""),
    state: String(raw.state ?? ""),
    status: typeof raw.status === "string" ? raw.status : null,
    turn: Number(raw.turn ?? 0),
    where: String(raw.where ?? ""),
    machine: machineOf(address, machine),
    parent: String(raw.parent ?? ""),
    pid: typeof raw.pid === "number" ? raw.pid : null,
    createdAt: typeof raw.created_ms === "number"
      ? new Date(raw.created_ms).toISOString()
      : "",
    labels: typeof raw.labels === "object" && raw.labels !== null
      ? raw.labels as Record<string, string>
      : {},
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

/** Write a resource and return its handle. */
async function save(
  ctx: MethodContext,
  spec: string,
  name: string,
  data: unknown,
): Promise<{ name: string }> {
  return await ctx.writeResource(spec, safeName(name), data);
}

/** The OTEL span input for a method. */
function spanInput(
  method: string,
  args: Record<string, unknown>,
  extra: {
    target?: string;
    machine?: string;
    attributes?: Record<string, unknown>;
  } = {},
): {
  name: string;
  target?: string;
  machine?: string;
  attributes?: Record<string, unknown>;
  extensionVersion: string;
  route: string;
} {
  return {
    name: `herdr-core.${method}`,
    target: extra.target,
    machine: extra.machine,
    attributes: {
      ...(args ?? {}),
      ...(extra.attributes ?? {}),
    },
    extensionVersion: EXT_VERSION,
    route: "herdr-core",
  };
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

async function status(
  _args: z.infer<typeof StatusArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const [core, machines, terminals] = await Promise.all([
    hcJson(g.herdrBin, ["server", "status"]),
    hcJson(g.herdrBin, ["machine", "ls"]),
    hcJson(g.herdrBin, ["ls", "--all"]),
  ]);
  const data: z.infer<typeof StatusResourceSchema> = {
    core: {
      id: String((core.core as Record<string, unknown>)?.id ?? ""),
      name: String((core.core as Record<string, unknown>)?.name ?? ""),
    },
    version: String(core.version ?? ""),
    pid: typeof core.pid === "number" ? core.pid : null,
    uptimeMs: typeof core.uptime_ms === "number" ? core.uptime_ms : null,
    live: Number(core.live ?? 0),
    finished: Number(core.finished ?? 0),
    holders: Array.isArray(core.holders)
      ? core.holders as Array<Record<string, unknown>>
      : [],
    machines: Array.isArray(machines.machines)
      ? machines.machines as Array<Record<string, unknown>>
      : [],
    capturedAt: now(),
  };
  ctx.logger?.info("herdr-core {version}: {live} live, {finished} finished", {
    version: data.version,
    live: data.live,
    finished: data.finished,
  });
  void terminals;
  return { dataHandles: [await save(ctx, "status", "current", data)] };
}

async function terminals(
  args: z.infer<typeof TerminalsArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const raw = await hcJson(g.herdrBin, args.all ? ["ls", "--all"] : ["ls"]);
  const rows = Array.isArray(raw.terminals)
    ? raw.terminals as Array<Record<string, unknown>>
    : [];
  const labelKey = args.label.includes("=")
    ? args.label.slice(0, args.label.indexOf("="))
    : "";
  const labelValue = args.label.includes("=")
    ? args.label.slice(args.label.indexOf("=") + 1)
    : "";
  const filtered = rows.filter((row) => {
    const address = String(row.address ?? "");
    if (args.machine && machineOf(address, "") !== args.machine) return false;
    if (args.agent && String(row.agent ?? "") !== args.agent) return false;
    if (args.cwd && String(row.cwd ?? "") !== args.cwd) return false;
    if (args.state && String(row.state ?? "") !== args.state) return false;
    if (args.label) {
      const labels = row.labels;
      if (typeof labels !== "object" || labels === null) return false;
      if (
        String((labels as Record<string, unknown>)[labelKey] ?? "") !==
          labelValue
      ) {
        return false;
      }
    }
    return true;
  });

  const handles: Array<{ name: string }> = [];
  const byAgent: Record<string, number> = {};
  const byMachine: Record<string, number> = {};
  const resources: Array<z.infer<typeof TerminalResourceSchema>> = [];
  for (const row of filtered) {
    let detail = row;
    if (args.detail) {
      const address = String(row.address ?? "");
      if (address) {
        detail = await hcJson(g.herdrBin, ["get", address]);
      }
    }
    const resource = terminalResource(detail, args.machine);
    resources.push(resource);
    byAgent[resource.agent || "unknown"] =
      (byAgent[resource.agent || "unknown"] ?? 0) + 1;
    byMachine[resource.machine || "local"] =
      (byMachine[resource.machine || "local"] ?? 0) + 1;
    handles.push(await save(ctx, "terminal", resource.address, resource));
  }
  const fleet: z.infer<typeof FleetResourceSchema> = {
    count: resources.length,
    byAgent,
    byMachine,
    terminals: resources,
    capturedAt: now(),
  };
  handles.push(await save(ctx, "fleet", "current", fleet));
  return { dataHandles: handles };
}

async function read(
  args: z.infer<typeof ReadArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const handles: Array<{ name: string }> = [];
  for (const target of args.targets) {
    const address = addressFor(target, args.machine || g.defaultMachine);
    const raw = await hcJson(g.herdrBin, [
      "read",
      "--lines",
      String(args.lines),
      address,
    ]);
    const text = cap(String(raw.text ?? ""), g.maxOutputBytes);
    const data: z.infer<typeof ReadResultSchema> = {
      target: address,
      machine: machineOf(address, args.machine || g.defaultMachine),
      text,
      complete: raw.complete !== false,
      how: String(raw.how ?? ""),
      bytes: new TextEncoder().encode(text).length,
      capturedAt: now(),
    };
    handles.push(await save(ctx, "read-result", address, data));
  }
  return { dataHandles: handles };
}

async function run(
  args: z.infer<typeof RunArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const cwd = args.cwd || g.defaultCwd;
  const machine = args.machine || g.defaultMachine;
  const hcArgs = ["run", "--no-notify"];
  if (args.bg) hcArgs.push("--bg");
  if (args.keep) hcArgs.push("--keep");
  if (args.name) hcArgs.push("--name", args.name);
  if (cwd) hcArgs.push("--cwd", cwd);
  if (machine) hcArgs.push("--on", machine);
  for (const [key, value] of Object.entries(args.labels)) {
    hcArgs.push("--label", `${key}=${value}`);
  }
  hcArgs.push("--timeout", String(args.timeout), "--", ...args.argv);
  const raw = await hcJson(g.herdrBin, hcArgs);
  const address = String(raw.address ?? "");
  const wait = (raw.wait ?? {}) as Record<string, unknown>;
  const data: z.infer<typeof RunResultSchema> = {
    address,
    name: String(raw.name ?? ""),
    machine: machineOf(address, machine),
    cwd: String(raw.cwd ?? cwd),
    state: String(raw.state ?? ""),
    output: cap(String(raw.output ?? ""), g.maxOutputBytes),
    exitCode: typeof wait.exit_code === "number" ? wait.exit_code : null,
    signal: typeof wait.signal === "number" ? wait.signal : null,
    reason: String(wait.reason ?? (args.bg ? "background" : "")),
    timeout: String(wait.reason ?? "") === "timeout",
    startedAt: now(),
  };
  return { dataHandles: [await save(ctx, "run-result", address, data)] };
}

async function send(
  args: z.infer<typeof SendArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const handles: Array<{ name: string }> = [];
  for (const target of args.targets) {
    const address = addressFor(target, args.machine || g.defaultMachine);
    const hcArgs = ["send"];
    if (args.force) hcArgs.push("--force");
    if (args.ifStatus) hcArgs.push("--if", args.ifStatus);
    if (args.wait) hcArgs.push("--wait", "--timeout", String(args.timeout));
    hcArgs.push("--", address, args.text);
    const raw = await hcJson(g.herdrBin, hcArgs);
    const data: z.infer<typeof SendResultSchema> = {
      target: address,
      status: typeof raw.status === "string" ? raw.status : null,
      turn: Number(raw.turn ?? 0),
      started: typeof raw.started === "string" ? raw.started : null,
      sentAt: now(),
    };
    handles.push(await save(ctx, "send-result", address, data));
  }
  return { dataHandles: handles };
}

async function keys(
  args: z.infer<typeof KeysArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const handles: Array<{ name: string }> = [];
  for (const target of args.targets) {
    const address = addressFor(target, args.machine || g.defaultMachine);
    const raw = await hcJson(g.herdrBin, [
      "keys",
      "--",
      address,
      ...args.keys,
    ]);
    const data: z.infer<typeof KeysResultSchema> = {
      target: address,
      status: typeof raw.status === "string" ? raw.status : null,
      turn: Number(raw.turn ?? 0),
      pressedAt: now(),
    };
    handles.push(await save(ctx, "keys-result", address, data));
  }
  return { dataHandles: handles };
}

async function interrupt(
  args: z.infer<typeof TargetArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const handles: Array<{ name: string }> = [];
  for (const target of args.targets) {
    const address = addressFor(target, args.machine || g.defaultMachine);
    const raw = await hcJson(g.herdrBin, ["interrupt", address]);
    handles.push(
      await save(ctx, "interrupt-result", address, {
        target: address,
        ...raw,
        interruptedAt: now(),
      }),
    );
  }
  return { dataHandles: handles };
}

async function kill(
  args: z.infer<typeof TargetArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const handles: Array<{ name: string }> = [];
  for (const target of args.targets) {
    const address = addressFor(target, args.machine || g.defaultMachine);
    const raw = await hcJson(g.herdrBin, ["kill", address]);
    handles.push(
      await save(ctx, "kill-result", address, {
        target: address,
        ...raw,
        killedAt: now(),
      }),
    );
  }
  return { dataHandles: handles };
}

async function remove(
  args: z.infer<typeof TargetArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const handles: Array<{ name: string }> = [];
  for (const target of args.targets) {
    const address = addressFor(target, args.machine || g.defaultMachine);
    const raw = await hcJson(g.herdrBin, ["rm", address]);
    handles.push(
      await save(ctx, "remove-result", address, {
        target: address,
        ...raw,
        removedAt: now(),
      }),
    );
  }
  return { dataHandles: handles };
}

const PutArgsSchema = z.object({
  target: z.string().min(1).describe("Terminal to put the file beside."),
  file: z.string().min(1).describe("Local file to send."),
  machine: z.string().default("").describe(
    "Machine prefix for a bare address.",
  ),
});

async function put(
  args: z.infer<typeof PutArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const address = addressFor(args.target, args.machine || g.defaultMachine);
  const raw = await hcJson(g.herdrBin, ["put", address, args.file]);
  return {
    dataHandles: [
      await save(ctx, "put-result", address, {
        target: address,
        path: String(raw.path ?? ""),
        bytes: Number(raw.bytes ?? 0),
        putAt: now(),
      }),
    ],
  };
}

async function wait(
  args: z.infer<typeof WaitArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const hcArgs = ["wait"];
  if (args.children) hcArgs.push("--children", args.children);
  if (args.output) hcArgs.push("--output", args.output);
  hcArgs.push("--timeout", String(args.timeout));
  const target = args.target
    ? addressFor(args.target, args.machine || g.defaultMachine)
    : "";
  if (target) hcArgs.push(target);
  const raw = await hcJson(g.herdrBin, hcArgs);
  const data: z.infer<typeof WaitResultSchema> = {
    target,
    ended: raw.ended === true,
    reason: String(raw.reason ?? ""),
    exitCode: typeof raw.exit_code === "number" ? raw.exit_code : null,
    signal: typeof raw.signal === "number" ? raw.signal : null,
    status: typeof raw.status === "string" ? raw.status : null,
    turn: Number(raw.turn ?? 0),
    checkedAt: now(),
  };
  return {
    dataHandles: [await save(ctx, "wait-result", target || "children", data)],
  };
}

async function exec(
  args: z.infer<typeof ExecArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machines = args.machines.length > 0
    ? args.machines
    : [args.machine || g.defaultMachine];
  const handles: Array<{ name: string }> = [];
  for (const machine of machines) {
    const hcArgs = ["exec"];
    if (machine) hcArgs.push("--on", machine);
    if (args.cwd || g.defaultCwd) {
      hcArgs.push("--cwd", args.cwd || g.defaultCwd);
    }
    for (const [key, value] of Object.entries(args.env)) {
      hcArgs.push("--env", `${key}=${value}`);
    }
    hcArgs.push("--timeout", String(args.timeout), "--", ...args.argv);
    const raw = await hcJson<Record<string, unknown>>(
      g.herdrBin,
      hcArgs,
      args.stdin || undefined,
    );
    const data: z.infer<typeof ExecResultSchema> = {
      machine,
      code: typeof raw.code === "number" ? raw.code : null,
      signal: typeof raw.signal === "number" ? raw.signal : null,
      stdout: cap(
        decodeBase64(String(raw.stdout ?? "")),
        g.maxOutputBytes,
      ),
      stderr: cap(
        decodeBase64(String(raw.stderr ?? "")),
        g.maxOutputBytes,
      ),
      ms: Number(raw.ms ?? 0),
      timedOut: raw.timed_out === true,
      truncated: raw.truncated === true,
      capturedAt: now(),
    };
    handles.push(
      await save(ctx, "exec-result", machine || "local", data),
    );
  }
  return { dataHandles: handles };
}

async function fileRead(
  args: z.infer<typeof FileReadArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const handles: Array<{ name: string }> = [];
  for (const path of args.paths) {
    const hcArgs = ["file", "read"];
    if (machine) hcArgs.push("--on", machine);
    if (args.cwd || g.defaultCwd) {
      hcArgs.push("--cwd", args.cwd || g.defaultCwd);
    }
    if (args.offset > 1) hcArgs.push("--offset", String(args.offset));
    if (args.limit > 0) hcArgs.push("--limit", String(args.limit));
    hcArgs.push("--", path);
    const raw = await hcJson<Record<string, unknown>>(g.herdrBin, hcArgs);
    const text = cap(String(raw.text ?? ""), g.maxOutputBytes);
    const data: z.infer<typeof FileResultSchema> = {
      path,
      machine,
      bytes: new TextEncoder().encode(text).length,
      first: typeof raw.first === "number" ? raw.first : null,
      last: typeof raw.last === "number" ? raw.last : null,
      lineCount: typeof raw.lines === "number" ? raw.lines : null,
      text,
      operation: "read",
      capturedAt: now(),
    };
    handles.push(await save(ctx, "file-result", `${machine}-${path}`, data));
  }
  return { dataHandles: handles };
}

async function fileWrite(
  args: z.infer<typeof FileWriteArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const hcArgs = ["file", "write"];
  if (machine) hcArgs.push("--on", machine);
  if (args.cwd || g.defaultCwd) hcArgs.push("--cwd", args.cwd || g.defaultCwd);
  hcArgs.push("--", args.path);
  const raw = await hcJson<Record<string, unknown>>(
    g.herdrBin,
    hcArgs,
    args.content,
  );
  const data: z.infer<typeof FileResultSchema> = {
    path: args.path,
    machine,
    bytes: Number(raw.bytes ?? new TextEncoder().encode(args.content).length),
    first: null,
    last: null,
    lineCount: null,
    text: "",
    operation: "write",
    capturedAt: now(),
  };
  return {
    dataHandles: [
      await save(ctx, "file-result", `${machine}-${args.path}`, data),
    ],
  };
}

async function fileEdit(
  args: z.infer<typeof FileEditArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const hcArgs = ["file", "edit"];
  if (machine) hcArgs.push("--on", machine);
  if (args.cwd || g.defaultCwd) hcArgs.push("--cwd", args.cwd || g.defaultCwd);
  for (const edit of args.edits) {
    hcArgs.push("--old", edit.old, "--new", edit.new);
  }
  hcArgs.push("--", args.path);
  const raw = await hcJson<Record<string, unknown>>(g.herdrBin, hcArgs);
  const data: z.infer<typeof FileResultSchema> = {
    path: args.path,
    machine,
    bytes: Number(raw.bytes ?? 0),
    first: null,
    last: null,
    lineCount: null,
    text: "",
    operation: "edit",
    capturedAt: now(),
  };
  return {
    dataHandles: [
      await save(ctx, "file-result", `${machine}-${args.path}`, data),
    ],
  };
}

async function fileEditLines(
  args: z.infer<typeof FileEditLinesArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const readArgs = ["file", "read"];
  if (machine) readArgs.push("--on", machine);
  if (args.cwd || g.defaultCwd) {
    readArgs.push("--cwd", args.cwd || g.defaultCwd);
  }
  readArgs.push("--", args.path);
  const before = await hcJson<Record<string, unknown>>(g.herdrBin, readArgs);
  const text = String(before.text ?? "");
  if (args.expectedHash) {
    const actual = await sha256Hex(text);
    if (actual !== args.expectedHash) {
      throw new Error(
        `${args.path} changed since it was read (expected ${args.expectedHash}, ` +
          `found ${actual}); re-read the file`,
      );
    }
  }
  const split = splitTextLines(text);
  const lines = applyLineEdits(split.lines, args.edits);
  const content = lines.join("\n") + (split.trailingNewline ? "\n" : "");

  const writeArgs = ["file", "write"];
  if (machine) writeArgs.push("--on", machine);
  if (args.cwd || g.defaultCwd) {
    writeArgs.push("--cwd", args.cwd || g.defaultCwd);
  }
  writeArgs.push("--", args.path);
  const wrote = await hcJson<Record<string, unknown>>(
    g.herdrBin,
    writeArgs,
    content,
  );
  const data: z.infer<typeof FileResultSchema> = {
    path: args.path,
    machine,
    bytes: Number(
      wrote.bytes ?? new TextEncoder().encode(content).length,
    ),
    first: null,
    last: null,
    lineCount: lines.length,
    text: "",
    operation: "edit-lines",
    capturedAt: now(),
  };
  return {
    dataHandles: [
      await save(ctx, "file-result", `${machine}-${args.path}`, data),
    ],
  };
}

async function search(
  args: z.infer<typeof SearchArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const machine = args.machine || g.defaultMachine;
  const rgArgs = [
    "--json",
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
  ];
  if (!args.caseSensitive) rgArgs.push("-i");
  if (args.fixedStrings) rgArgs.push("-F");
  if (args.hidden) rgArgs.push("--hidden");
  if (args.noIgnore) rgArgs.push("--no-ignore");
  for (const glob of args.globs) rgArgs.push("-g", glob);
  rgArgs.push("--", args.pattern, ...args.paths);

  const hcArgs = ["exec"];
  if (machine) hcArgs.push("--on", machine);
  if (args.cwd || g.defaultCwd) hcArgs.push("--cwd", args.cwd || g.defaultCwd);
  hcArgs.push("--", "rg", ...rgArgs);
  const raw = await hcJson<Record<string, unknown>>(g.herdrBin, hcArgs);
  const code = typeof raw.code === "number" ? raw.code : null;
  if (code !== null && code > 1) {
    const stderr = decodeBase64(String(raw.stderr ?? ""));
    throw new Error(
      `ripgrep failed (${code}): ${stderr.trim() || "no stderr"}`,
    );
  }
  const stdout = decodeBase64(String(raw.stdout ?? ""));
  const matches: Array<z.infer<typeof SearchMatchSchema>> = [];
  let truncated = raw.truncated === true;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const path = String((data.path as Record<string, unknown>)?.text ?? "");
    const lineNumber = Number(data.line_number ?? 0);
    const text = String((data.lines as Record<string, unknown>)?.text ?? "");
    const submatches = Array.isArray(data.submatches) ? data.submatches : [];
    if (submatches.length === 0) {
      matches.push({
        path,
        line: lineNumber,
        column: 1,
        endColumn: 0,
        text: text.replace(/\r?\n$/, ""),
        match: "",
      });
    } else {
      for (const sub of submatches) {
        const s = sub as Record<string, unknown>;
        matches.push({
          path,
          line: lineNumber,
          column: Number(s.start ?? 0) + 1,
          endColumn: Number(s.end ?? 0) + 1,
          text: text.replace(/\r?\n$/, ""),
          match: String((s.match as Record<string, unknown>)?.text ?? ""),
        });
        if (matches.length >= args.maxResults) {
          truncated = true;
          break;
        }
      }
    }
    if (matches.length >= args.maxResults) {
      truncated = true;
      break;
    }
  }
  const data: z.infer<typeof SearchResultSchema> = {
    pattern: args.pattern,
    machine,
    count: matches.length,
    truncated,
    matches,
    capturedAt: now(),
  };
  return {
    dataHandles: [await save(ctx, "search-result", args.pattern, data)],
  };
}

async function machines(
  _args: z.infer<typeof MachinesArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const raw = await hcJson(g.herdrBin, ["machine", "ls"]);
  const rows = Array.isArray(raw.machines)
    ? raw.machines as Array<Record<string, unknown>>
    : [];
  const data: z.infer<typeof MachinesResourceSchema> = {
    count: rows.length,
    machines: rows.map((row) => ({
      name: String(row.name ?? ""),
      host: String(row.host ?? ""),
      id: String(row.id ?? ""),
      state: String(row.state ?? ""),
      version: String(row.version ?? ""),
      target: String(row.target ?? ""),
    })),
    capturedAt: now(),
  };
  const handles: Array<{ name: string }> = [
    await save(ctx, "machines", "current", data),
  ];
  for (const machine of data.machines) {
    handles.push(await save(ctx, "machine", machine.name, machine));
  }
  return { dataHandles: handles };
}

async function machineAdd(
  args: z.infer<typeof MachineAddArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const hcArgs = ["machine", "add"];
  if (args.name) hcArgs.push("--name", args.name);
  if (args.via) hcArgs.push("--via", args.via);
  if (args.install) hcArgs.push("--install");
  if (args.temporary) hcArgs.push("--temp");
  hcArgs.push(args.target);
  const raw = await hcJson(g.herdrBin, hcArgs);
  const name = String(raw.name ?? args.name ?? args.target);
  const data = {
    name,
    host: String(raw.host ?? ""),
    id: String(raw.id ?? ""),
    state: String(raw.state ?? ""),
    version: String(raw.version ?? ""),
    target: String(raw.target ?? args.target),
    capturedAt: now(),
  };
  return { dataHandles: [await save(ctx, "machine", name, data)] };
}

async function machineRemove(
  args: z.infer<typeof MachineRemoveArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const raw = await hcJson(g.herdrBin, [
    "machine",
    "rm",
    args.machine,
  ]);
  return {
    dataHandles: [
      await save(ctx, "machine", args.machine, {
        name: args.machine,
        removed: true,
        ...raw,
        removedAt: now(),
      }),
    ],
  };
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
        name: "herdr-core.otel-test",
        route: "herdr-core",
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
  return {
    dataHandles: [await save(ctx, "otel-status", "current", data)],
  };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A persistent herdr-core session, exposed as swamp data and methods. */
export const model = {
  type: EXT_TYPE,
  version: EXT_VERSION,
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.23.2",
      description:
        "Adds the terminal-session report, file-edit-lines with expected-line/hash checks, and JSONL activity events for the Herdr panel.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.28.1",
      description:
        "Adds label, pi-sessions and pi-resume, so a restart can put each lost pi session back in the tab it was lost from and leave the ones a person quit alone.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  reports: ["@svendowideit/terminal-session"],

  resources: {
    status: {
      description: "Current herdr-core server identity and roll-up.",
      schema: StatusResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    terminal: {
      description: "One herdr-core terminal and the program it hosts.",
      schema: TerminalResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "pi-session": {
      description:
        "One terminal's recorded pi session, where it sits and whether to resume it.",
      schema: PiSessionResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "pi-sessions": {
      description: "Every recorded pi session and its resume decision.",
      schema: PiSessionsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "pi-resume": {
      description:
        "What a resume did: sessions started, and why others stayed down.",
      schema: PiResumeResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    fleet: {
      description: "All matching terminals plus agent/machine roll-ups.",
      schema: FleetResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "read-result": {
      description: "The screen and history read from one terminal.",
      schema: ReadResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "run-result": {
      description: "One program started in a herdr-core terminal.",
      schema: RunResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "send-result": {
      description: "One text submission to a terminal.",
      schema: SendResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "keys-result": {
      description: "One key press batch sent to a terminal.",
      schema: KeysResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "interrupt-result": {
      description: "The result of pressing a terminal's stop key.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "kill-result": {
      description: "The observed result of ending a terminal's program.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "remove-result": {
      description: "The result of removing a finished terminal.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "put-result": {
      description: "A file placed beside a terminal.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "wait-result": {
      description: "The result of waiting for a terminal or children.",
      schema: WaitResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "exec-result": {
      description: "One command run without a terminal.",
      schema: ExecResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "file-result": {
      description: "One file read, write or edit.",
      schema: FileResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "search-result": {
      description: "ripgrep matches, with path/line/column evidence.",
      schema: SearchResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    machines: {
      description: "The herdr-core fleet and each machine's state.",
      schema: MachinesResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    machine: {
      description: "One herdr-core machine.",
      schema: z.record(z.string(), z.unknown()),
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
    status: {
      description:
        "Report the herdr-core server, its holders, live/finished terminals " +
        "and the machines it can reach.",
      arguments: StatusArgsSchema,
      execute: (args: z.infer<typeof StatusArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("status", args),
          () => status(args, ctx),
        ),
    },
    terminals: {
      description:
        "List terminals with optional filters, writing one `terminal` " +
        "resource each plus a `fleet` roll-up. Fan-out in one call.",
      arguments: TerminalsArgsSchema,
      execute: (
        args: z.infer<typeof TerminalsArgsSchema>,
        ctx: MethodContext,
      ) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("terminals", args, {
            attributes: {
              "swamp.target_count":
                args.machine || args.agent || args.cwd || args.label ? 1 : 0,
            },
          }),
          () => terminals(args, ctx),
        ),
    },
    read: {
      description:
        "Read one or more terminals' screens and history. Fan-out in one call.",
      arguments: ReadArgsSchema,
      execute: (args: z.infer<typeof ReadArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("read", args, {
            target: args.targets.join(","),
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: { "swamp.target_count": args.targets.length },
          }),
          () => read(args, ctx),
        ),
    },
    run: {
      description:
        "Start a program in a herdr-core terminal. Waits for the exit code " +
        "unless bg=true; keep replaces a lost program with a shell.",
      arguments: RunArgsSchema,
      execute: (args: z.infer<typeof RunArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("run", args, {
            target: args.name,
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: { "swamp.argv0": args.argv[0] ?? "" },
          }),
          () => run(args, ctx),
        ),
    },
    send: {
      description:
        "Paste text into one or more terminals and press Enter. herdr-core " +
        "waits for a human's unfinished draft; use force to override a block.",
      arguments: SendArgsSchema,
      execute: (args: z.infer<typeof SendArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("send", args, {
            target: args.targets.join(","),
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: { "swamp.target_count": args.targets.length },
          }),
          () => send(args, ctx),
        ),
    },
    keys: {
      description:
        "Press named keys (enter, esc, ctrl+c, alt+x, f5, a, ...) in one or " +
        "more terminals.",
      arguments: KeysArgsSchema,
      execute: (args: z.infer<typeof KeysArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("keys", args, {
            target: args.targets.join(","),
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => keys(args, ctx),
        ),
    },
    interrupt: {
      description:
        "Press a terminal's stop key (esc or ctrl+c) and report what happened.",
      arguments: TargetArgsSchema,
      execute: (args: z.infer<typeof TargetArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("interrupt", args, {
            target: args.targets.join(","),
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => interrupt(args, ctx),
        ),
    },
    kill: {
      description:
        "End a terminal's program: hangup, then terminate, then kill. Returns " +
        "the observed result.",
      arguments: TargetArgsSchema,
      execute: (args: z.infer<typeof TargetArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("kill", args, {
            target: args.targets.join(","),
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => kill(args, ctx),
        ),
    },
    rm: {
      description: "Remove a finished terminal.",
      arguments: TargetArgsSchema,
      execute: (args: z.infer<typeof TargetArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("rm", args, {
            target: args.targets.join(","),
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => remove(args, ctx),
        ),
    },
    put: {
      description:
        "Send a local file beside a terminal so its program can read or " +
        "paste it; prints where it landed.",
      arguments: PutArgsSchema,
      execute: (args: z.infer<typeof PutArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("put", args, {
            target: args.target,
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => put(args, ctx),
        ),
    },
    wait: {
      description:
        "Wait until a terminal stops working, prints matching output, or the " +
        "children settle. Use it instead of sleep.",
      arguments: WaitArgsSchema,
      execute: (args: z.infer<typeof WaitArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("wait", args, {
            target: args.target,
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => wait(args, ctx),
        ),
    },
    exec: {
      description:
        "Run one program without a terminal and return its exit code and " +
        "exact output; fan out across machines in one call.",
      arguments: ExecArgsSchema,
      execute: (args: z.infer<typeof ExecArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("exec", args, {
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: {
              "swamp.argv0": args.argv[0] ?? "",
              "swamp.machine_count": args.machines.length ||
                (args.machine ? 1 : 1),
            },
          }),
          () => exec(args, ctx),
        ),
    },
    "file-read": {
      description:
        "Read one or more text files, locally or on a herdr-core machine.",
      arguments: FileReadArgsSchema,
      execute: (args: z.infer<typeof FileReadArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("file-read", args, {
            target: args.paths.join(","),
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: { "swamp.target_count": args.paths.length },
          }),
          () => fileRead(args, ctx),
        ),
    },
    "file-write": {
      description:
        "Write a file atomically, locally or on a herdr-core machine.",
      arguments: FileWriteArgsSchema,
      execute: (
        args: z.infer<typeof FileWriteArgsSchema>,
        ctx: MethodContext,
      ) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("file-write", args, {
            target: args.path,
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => fileWrite(args, ctx),
        ),
    },
    "file-edit": {
      description:
        "Replace exact text in a file, all edits or none, locally or on a " +
        "herdr-core machine.",
      arguments: FileEditArgsSchema,
      execute: (args: z.infer<typeof FileEditArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("file-edit", args, {
            target: args.path,
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => fileEdit(args, ctx),
        ),
    },
    "file-edit-lines": {
      description:
        "Replace 1-indexed line ranges in a file, bottom-up, with optional " +
        "expected-line and file-hash checks. Find the lines with search/read first.",
      arguments: FileEditLinesArgsSchema,
      execute: (
        args: z.infer<typeof FileEditLinesArgsSchema>,
        ctx: MethodContext,
      ) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("file-edit-lines", args, {
            target: args.path,
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: { "swamp.edit_count": args.edits.length },
          }),
          () => fileEditLines(args, ctx),
        ),
    },
    search: {
      description:
        "Search files with ripgrep and return path/line/column matches. " +
        "Run locally or on a herdr-core machine.",
      arguments: SearchArgsSchema,
      execute: (args: z.infer<typeof SearchArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("search", args, {
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: { "swamp.pattern": args.pattern },
          }),
          () => search(args, ctx),
        ),
    },
    machines: {
      description: "List the herdr-core fleet and each machine's state.",
      arguments: MachinesArgsSchema,
      execute: (args: z.infer<typeof MachinesArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("machines", args),
          () => machines(args, ctx),
        ),
    },
    "machine-add": {
      description: "Add another machine to the herdr-core fleet.",
      arguments: MachineAddArgsSchema,
      execute: (
        args: z.infer<typeof MachineAddArgsSchema>,
        ctx: MethodContext,
      ) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("machine-add", args, {
            target: args.name || args.target,
            attributes: { "swamp.machine_target": args.target },
          }),
          () => machineAdd(args, ctx),
        ),
    },
    "machine-remove": {
      description: "Forget a machine; its terminals keep running there.",
      arguments: MachineRemoveArgsSchema,
      execute: (
        args: z.infer<typeof MachineRemoveArgsSchema>,
        ctx: MethodContext,
      ) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("machine-remove", args, { target: args.machine }),
          () => machineRemove(args, ctx),
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
    label: {
      description:
        "Set or remove labels on a terminal. pi sessions mark themselves " +
        "with pi.session, so a restart can tell which session sat where.",
      arguments: LabelArgsSchema,
      execute: (args: z.infer<typeof LabelArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("label", args, {
            target: args.target,
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: {
              "swamp.label_count": Object.keys(args.labels).length,
            },
          }),
          () => label(args, ctx),
        ),
    },
    "pi-sessions": {
      description:
        "Report which pi session runs in which terminal, tab and space, and " +
        "whether a restart should bring it back.",
      arguments: PiSessionsArgsSchema,
      execute: (
        args: z.infer<typeof PiSessionsArgsSchema>,
        ctx: MethodContext,
      ) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("pi-sessions", args, {
            machine: args.machine || ctx.globalArgs.defaultMachine,
          }),
          () => piSessions(args, ctx),
        ),
    },
    "pi-resume": {
      description:
        "Start lost pi sessions again in the tab each was lost from, and " +
        "leave the ones a person quit alone. dryRun reports the plan.",
      arguments: PiResumeArgsSchema,
      execute: (args: z.infer<typeof PiResumeArgsSchema>, ctx: MethodContext) =>
        withOtelSpan(
          ctx,
          otelConfig(ctx.globalArgs),
          spanInput("pi-resume", args, {
            machine: args.machine || ctx.globalArgs.defaultMachine,
            attributes: { "swamp.dry_run": args.dryRun },
          }),
          () => piResume(args, ctx),
        ),
    },
  },
};
