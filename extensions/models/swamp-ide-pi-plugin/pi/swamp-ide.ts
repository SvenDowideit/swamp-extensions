// Managed by @svendowideit/swamp-ide-pi-plugin. Do not edit this installed
// copy by hand; change the bundled source and reinstall with
// `swamp model @svendowideit/swamp-ide-pi-plugin method run install`.
//
// Swamp IDE routing addin for Pi.
//
// Three jobs:
//   1. Make the swamp agent-IDE methods the path of least resistance: expose
//      one `swamp_ide` tool, add prompt rules that prefer it, and (optionally)
//      block the built-in file/shell tools that bypass it.
//   2. Record every finalized tool call as an OTLP span, so a trace shows both
//      what went through herdr-core/vim (`swamp.route=herdr-core|vim`) and
//      what did not (`swamp.route=bypass`).
//   3. Record every bash program the agent shells out to in a histogram, so we
//      can prioritise which missing herdr-core/vim method to build next.
//
// Configuration (environment):
//   SWAMP_IDE_MODE=off|advise|enforce   default enforce
//   SWAMP_IDE_HERDR_MODEL               default herdr-core
//   SWAMP_IDE_VIM_MODEL                 default vim-controller
//   SWAMP_IDE_OTEL_ENABLED=false        turn span export off
//   SWAMP_IDE_OTEL_MODEL                default otel
//   SWAMP_IDE_OTEL_VAULT                optional vault name (not used here)
//   SWAMP_IDE_OTEL_TOKEN_REF            default OTEL_EXPORTER_OTLP_TOKEN
//   SWAMP_IDE_OTEL_ENDPOINT             explicit OTLP/HTTP traces endpoint
//   SWAMP_AGENT_IDE_EVENT_LOG           default ~/.local/state/swamp-agent-ide/events.jsonl
//   SWAMP_AGENT_IDE_SHELLOUT_LOG        default ~/.local/state/swamp-agent-ide/shellouts.jsonl
//   SWAMP_AGENT_IDE_ADDIN_HEARTBEAT     default ~/.local/state/swamp-agent-ide/addin.json
//   SWAMP_IDE_SERVE=off                disable the swamp serve fast path
//   SWAMP_SERVE_URL                    default ws://127.0.0.1:9090
//   SWAMP_BIN                          default swamp
//
// The addin is deliberately dependency-light: node:child_process, node:crypto,
// node:fs/promises, the global WebSocket (Node 22) and typebox (already present
// in Pi). It never throws from a hook; a broken observability setup only means
// a span is not exported, and a missing serve falls back to the CLI.

import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  authorizationFromLease,
  blockedAuthorization,
  classifyCall,
  commandAlternatives,
  formatAuthorization,
  guardPlan,
  isBroadScope,
  isShellWrapper,
  leaseAllows,
  notRequiredAuthorization,
  writeInputProblem,
} from "./swamp-ide-policy.ts";
import { acquireApprovalLock } from "./swamp-ide-lock.ts";

const MODE = (process.env.SWAMP_IDE_MODE ?? "enforce").toLowerCase();
const HERDR_MODEL = process.env.SWAMP_IDE_HERDR_MODEL ?? "herdr-core";
const VIM_MODEL = process.env.SWAMP_IDE_VIM_MODEL ?? "vim-controller";
const SWAMP_BIN = process.env.SWAMP_BIN ?? "swamp";
const OTEL_ENABLED = process.env.SWAMP_IDE_OTEL_ENABLED !== "false";
const OTEL_MODEL = process.env.SWAMP_IDE_OTEL_MODEL ?? "otel";
const OTEL_TOKEN_REF = process.env.SWAMP_IDE_OTEL_TOKEN_REF ??
  "OTEL_EXPORTER_OTLP_TOKEN";
const OTEL_ENDPOINT = process.env.SWAMP_IDE_OTEL_ENDPOINT ?? "";
const SERVICE_NAME = "pi-swamp-ide";
const EVENT_LOG = process.env.SWAMP_AGENT_IDE_EVENT_LOG ??
  join(homedir(), ".local/state/swamp-agent-ide/events.jsonl");
const SHELLOUT_LOG = process.env.SWAMP_AGENT_IDE_SHELLOUT_LOG ??
  join(homedir(), ".local/state/swamp-agent-ide/shellouts.jsonl");
const ADDIN_HEARTBEAT = process.env.SWAMP_AGENT_IDE_ADDIN_HEARTBEAT ??
  join(homedir(), ".local/state/swamp-agent-ide/addin.json");
const LEASE_PATH = process.env.SWAMP_AGENT_IDE_LEASE ??
  join(homedir(), ".local/state/swamp-agent-ide/lease.json");
const PENDING_APPROVAL = process.env.SWAMP_AGENT_IDE_PENDING ??
  join(homedir(), ".local/state/swamp-agent-ide/pending-approval.json");
const APPROVAL_DECISION = process.env.SWAMP_AGENT_IDE_DECISION ??
  join(homedir(), ".local/state/swamp-agent-ide/approval-decision.json");
const APPROVAL_LOCK = process.env.SWAMP_AGENT_IDE_APPROVAL_LOCK ??
  join(homedir(), ".local/state/swamp-agent-ide/approval.lock");
const APPROVAL_QUEUE = process.env.SWAMP_AGENT_IDE_APPROVAL_QUEUE ??
  join(homedir(), ".local/state/swamp-agent-ide/approval-queue.jsonl");
const HERDR_HOME = process.env.HERDR_APP_HOME ??
  join(homedir(), ".config/herdr-app");
const APPROVAL_DURATION_MS = 10 * 60_000;
const ADDIN_LOADED_AT = new Date().toISOString();
const SERVE_ENABLED = process.env.SWAMP_IDE_SERVE !== "off";
const SERVE_URL_RAW = (process.env.SWAMP_IDE_SERVE_URL ??
  process.env.SWAMP_SERVE_URL ?? "").trim();
const SERVE_DEFAULT = "ws://127.0.0.1:9090";
const SERVE_CONNECT_TIMEOUT_MS = 2_000;
const SERVE_RETRY_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER_DIR = join(HERE, "..", "swamp-ide");

const BYPASS_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "find"]);
const BYPASS_BASH =
  /^\s*(rg|grep|find|fd|cat|sed|awk|head|tail|wc|less|more|apply_patch|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test|dotnet\s+test)\b/;

/** A finalized tool call, keyed by toolCallId. */
const calls = new Map();

/** Resolve once per session. `undefined` means "not tried yet". */
let otelCache;

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

/** Only the sessions with an explicit marker get the tool and hooks. */
function markerDirs() {
  const dirs = [
    MARKER_DIR,
    join(homedir(), ".pi", "agent", "swamp-ide"),
  ];
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    dirs.push(join(dir, ".pi", "swamp-ide"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** Pi does not put PI_SESSION_ID in the extension process; fall back to the
 * single enabled marker so the workflow's global marker still matches. */
function currentSessionId() {
  const env = process.env.PI_SESSION_ID ?? "";
  if (env) return env;
  const ids = new Set();
  for (const dir of markerDirs()) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".enabled")) {
          ids.add(name.slice(0, -".enabled".length));
        }
      }
    } catch {
      // no marker directory
    }
  }
  return ids.size === 1 ? [...ids][0] : "";
}

function sessionEnabled() {
  if (process.env.SWAMP_IDE_FORCE === "1") return true;
  const id = currentSessionId();
  if (!id) return false;
  return markerDirs().some((markerDir) =>
    existsSync(join(markerDir, `${id}.enabled`))
  );
}

async function readLease() {
  try {
    return JSON.parse(await readFile(LEASE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function canonicalPath(path, cwd) {
  const raw = String(path ?? "");
  if (!raw) return "";
  const expanded = raw.startsWith("~")
    ? join(homedir(), raw.slice(1))
    : raw;
  const target = isAbsolute(expanded) ? expanded : join(cwd, expanded);
  try {
    return await realpath(target);
  } catch {
    try {
      return join(await realpath(dirname(target)), basename(target));
    } catch {
      return target;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Append a queue event for the visible waiting count; best effort. */
async function appendApprovalQueue(event) {
  await appendJsonl(APPROVAL_QUEUE, event);
}

/** Serialize a manual lease transaction against a pending approval. */
async function acquireLeaseLock() {
  try {
    return await acquireApprovalLock({ path: APPROVAL_LOCK });
  } catch {
    return null;
  }
}

function herdrRunning() {
  return existsSync(join(HERDR_HOME, "herdr-app.sock"));
}

function effectFor(system, model, method, input) {
  if (system === "swamp") {
    if (model === "ide-openobserve" && method === "dashboard") {
      return "Create or update the OpenObserve 'Swamp Agent IDE' dashboard and its six panels.";
    }
    if (model === "ide-pi" && method === "set") {
      return "Install/update the global pi addin, guard, policy and the session marker.";
    }
    if (model === "ide-pi" && method === "install") {
      return "Install the managed pi addin, guard and policy files.";
    }
    if (model === "ide" && method === "setHerdr") {
      return "Install and select the Herdr Swamp IDE mods and layout.";
    }
    return `Run ${model}.${method} with the inputs shown below.`;
  }
  if (system === "herdr-core") {
    if (method === "exec" || method === "run") {
      return "Run the exact command in the cwd shown below.";
    }
    if (method === "file-write" || method === "file-edit" || method === "file-edit-lines") {
      return `Write or edit exactly: ${input?.path ?? "the path shown below"}.`;
    }
    if (method === "send" || method === "keys") {
      return "Send input to a live terminal.";
    }
    return `Run herdr-core ${method}.`;
  }
  if (system === "vim") {
    return `Run Vim ${method} against the buffer shown below.`;
  }
  return "Run the action shown below.";
}

/** Ask the Herdr approval mod. The addin only writes the request; the human UI
 * writes the lease and decision, so the agent cannot self-approve. */
async function requestHerdrApproval(args) {
  const id = `appr-${Date.now().toString(36)}-${randomHex(4)}`;
  const session = currentSessionId();
  const scope = String(args?.decision?.scope ?? "");
  const queueEvent = (event) => ({
    id,
    session,
    scope,
    at: new Date().toISOString(),
    event,
  });
  await appendApprovalQueue(queueEvent("waiting"));
  let lock;
  try {
    lock = await acquireApprovalLock({
      path: APPROVAL_LOCK,
      signal: args?.signal,
    });
  } catch {
    await appendApprovalQueue(queueEvent("done"));
    return "unavailable";
  }
  if (!lock) {
    await appendApprovalQueue(queueEvent("done"));
    return args?.signal?.aborted ? "cancelled" : "unavailable";
  }
  try {
    return await requestHerdrApprovalUnlocked({ ...args, id, lock });
  } finally {
    await appendApprovalQueue(queueEvent("done"));
    await lock.release();
  }
}

async function requestHerdrApprovalUnlocked({
  id,
  decision,
  params,
  ctx,
  system,
  model,
  command,
  signal,
  lock,
}) {
  if (!herdrRunning()) return "unavailable";
  const now = new Date();
  const pending = {
    id,
    session: currentSessionId(),
    createdAt: now.toISOString(),
    reason: String(params.reason ?? decision.reason ?? "mutation requested"),
    goal: String(params.goal ?? `Allow ${model}.${params.method}`),
    scope: String(decision.scope),
    action: String(decision.scope),
    system: String(system),
    model: String(model),
    method: String(params.method),
    input: params.input ?? {},
    path: decision.scope.startsWith("file:")
      ? decision.scope.slice("file:".length)
      : decision.scope.startsWith("protected:")
      ? decision.scope.slice("protected:".length)
      : String(params.input?.path ?? ""),
    effect: effectFor(system, model, params.method, params.input),
    command,
    alternatives: commandAlternatives(params.input?.argv),
    broad: isBroadScope(decision.scope),
    durationMs: APPROVAL_DURATION_MS,
    risk: command ? "runs a command" : "changes state",
  };
  try {
    await mkdir(dirname(PENDING_APPROVAL), { recursive: true });
    await writeFile(PENDING_APPROVAL, JSON.stringify(pending, null, 2), "utf8");
    await unlink(APPROVAL_DECISION).catch(() => {});
  } catch {
    return "unavailable";
  }

  let lastLockWrite = Date.now();
  for (;;) {
    if (Date.now() - lastLockWrite > 5000) {
      const held = await lock.heartbeat();
      lastLockWrite = Date.now();
      if (!held) {
        await unlink(PENDING_APPROVAL).catch(() => {});
        return "unavailable";
      }
    }
    if (signal?.aborted) {
      await unlink(PENDING_APPROVAL).catch(() => {});
      return "cancelled";
    }
    try {
      const text = await readFile(APPROVAL_DECISION, "utf8");
      const replied = JSON.parse(text);
      if (replied?.id === id) {
        await unlink(PENDING_APPROVAL).catch(() => {});
        await unlink(APPROVAL_DECISION).catch(() => {});
        return String(replied.decision ?? "deny");
      }
    } catch {
      // wait for the human
    }
    await sleep(500);
  }
}

/** Write proof that the addin loaded and knows its active tool set. */
async function writeAddinHeartbeat(pi, extra = {}) {
  try {
    await mkdir(dirname(ADDIN_HEARTBEAT), { recursive: true });
    await writeFile(
      ADDIN_HEARTBEAT,
      JSON.stringify({
        component: "addin",
        loadedAt: ADDIN_LOADED_AT,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        session: currentSessionId(),
        mode: MODE,
        activeTools: typeof pi.getAllTools === "function"
          ? pi.getActiveTools?.() ?? []
          : [],
        allTools: typeof pi.getAllTools === "function"
          ? pi.getAllTools().map((tool) => tool.name)
          : [],
        swampIdeRegistered: typeof pi.getAllTools === "function"
          ? pi.getAllTools().some((tool) => tool.name === "swamp_ide")
          : false,
        serveEnabled: SERVE_ENABLED,
        serveConnected: Boolean(
          serveClient && serveClient.ws?.readyState === 1,
        ),
        serveUrl: normalizeServeUrl(SERVE_URL_RAW),
        ...extra,
      }),
      "utf8",
    );
  } catch {
    // The panel will show the missing heartbeat; never break the tool call.
  }
}

function truncate(value, max = 4000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Append one JSONL event, rotating the file when it grows past 2 MB. */
async function appendJsonl(path, event) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n", "utf8");
    const info = await stat(path);
    if (info.size > 900_000) {
      const text = await readFile(path, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-1000);
      await writeFile(path, lines.join("\n") + "\n", "utf8");
    }
  } catch {
    // The event log is best-effort.
  }
}

/** Append one activity event for the Herdr panel; never fail the tool call. */
async function appendActivity(event) {
  await appendJsonl(EVENT_LOG, event);
}

/** Run a process and collect stdout/stderr. */
function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<{
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? null, signal: signal ?? null, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(null, String(error)));
    child.on("close", (code, signal) => finish(code, signal));
    if (options.timeoutMs) {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }, options.timeoutMs);
      child.on("close", () => clearTimeout(timer));
    }
  });
}

let serveClient: any;
let serveConnecting: Promise<any> | undefined;
let serveRetryAt = 0;
let serveLastError = "";

/** Accept the ws:// and http:// spellings swamp serve itself accepts. */
function normalizeServeUrl(value) {
  let url = String(value ?? "").trim() || SERVE_DEFAULT;
  if (/^https:\/\//i.test(url)) url = `wss://${url.slice(8)}`;
  else if (/^http:\/\//i.test(url)) url = `ws://${url.slice(7)}`;
  return url.replace(/\/+$/, "");
}

/**
 * Connect once per session. A failed connect is throttled so a serve that is
 * simply not running does not cost a two-second timeout on every tool call.
 */
function connectServe() {
  if (!SERVE_ENABLED || typeof WebSocket === "undefined") {
    return Promise.resolve(null);
  }
  if (serveClient && serveClient.ws?.readyState === 1) {
    return Promise.resolve(serveClient);
  }
  if (serveConnecting) return serveConnecting;
  if (Date.now() < serveRetryAt) return Promise.resolve(null);

  const url = normalizeServeUrl(SERVE_URL_RAW);
  const state: { url: string; ws: WebSocket | null; pending: Map<string, any> } = {
    url,
    ws: null,
    pending: new Map(),
  };
  serveConnecting = new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      serveConnecting = undefined;
      if (value) {
        serveClient = state;
        serveRetryAt = 0;
        serveLastError = "";
      } else {
        serveRetryAt = Date.now() + SERVE_RETRY_MS;
      }
      resolve(value);
    };

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      serveLastError = String(error);
      finish(null);
      return;
    }
    state.ws = ws;
    timer = setTimeout(() => {
      serveLastError = `connect timeout ${url}`;
      try {
        ws.close();
      } catch {
        // ignore
      }
      finish(null);
    }, SERVE_CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => finish(state));
    ws.addEventListener("error", (event) => {
      serveLastError = (event as any)?.message ?? "websocket error";
    });
    ws.addEventListener("close", () => {
      finish(null);
      if (serveClient === state) serveClient = undefined;
      serveRetryAt = Date.now() + SERVE_RETRY_MS;
      for (const [id, pending] of state.pending) {
        state.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("serve connection closed"));
      }
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(
          typeof event.data === "string" ? event.data : String(event.data),
        );
      } catch {
        return;
      }
      const pending = msg && msg.id ? state.pending.get(msg.id) : null;
      if (!pending) return;
      if (msg.type === "event") {
        try {
          pending.onEvent?.(msg.event);
        } catch {
          // A renderer error must not kill the stream.
        }
        return;
      }
      state.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.type === "error") {
        pending.reject(
          Object.assign(
            new Error(msg.error?.message ?? "serve request failed"),
            { code: msg.error?.code, details: msg.error?.details },
          ),
        );
        return;
      }
      if (msg.type === "done") {
        pending.resolve({ done: true });
        return;
      }
      pending.resolve(msg);
    });
  });
  return serveConnecting;
}

/** Send one request over the cached serve socket, or return null if unavailable. */
async function serveRequest(
  type: string,
  payload: unknown,
  options: {
    timeoutMs?: number;
    onEvent?: (event: any) => void;
  } = {},
): Promise<any> {
  const state = await connectServe();
  if (!state || !state.ws || state.ws.readyState !== 1) return null;

  const id = `pi-${Date.now().toString(36)}-${randomHex(4)}`;
  const timeoutMs = options.timeoutMs ?? 5000;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      try {
        state.ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`serve request timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    state.pending.set(id, {
      resolve,
      reject,
      timer,
      onEvent: options.onEvent,
    });
    try {
      state.ws.send(JSON.stringify({ type, id, payload }));
    } catch (error) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function serveStatus() {
  return {
    enabled: SERVE_ENABLED && typeof WebSocket !== "undefined",
    url: normalizeServeUrl(SERVE_URL_RAW),
    connected: Boolean(serveClient && serveClient.ws?.readyState === 1),
    lastError: serveLastError,
    retryAt: serveRetryAt,
  };
}

/** Run a method through swamp serve, collecting its stream and reports. */
async function runMethodViaServe({ model, method, inputs, info, timeoutMs }) {
  const outputs = [];
  const reports = [];
  let completed;
  let failure;

  const payload: Record<string, unknown> = {
    modelIdOrName: model,
    methodName: method,
  };
  if (inputs && Object.keys(inputs).length > 0) payload.inputs = inputs;
  if (info?.traceId && info?.spanId) {
    payload.traceparent = `00-${info.traceId}-${info.spanId}-01`;
  }

  const reply = await serveRequest("model.method.run", payload, {
    timeoutMs,
    onEvent: (event: any) => {
      if (!event || typeof event !== "object") return;
      switch (event.kind) {
        case "method_output":
          outputs.push({ stream: event.stream, line: event.line });
          break;
        case "report_completed":
          reports.push({
            name: event.reportName,
            markdown: event.markdown,
          });
          break;
        case "report_failed":
          reports.push({
            name: event.reportName,
            error: event.error,
          });
          break;
        case "completed":
          completed = event.run;
          break;
        case "cancelled":
          failure = new Error(
            `run cancelled${event.reason ? `: ${event.reason}` : ""}`,
          );
          break;
        case "error":
          failure = new Error(event.error?.message ?? "method failed");
          break;
      }
    },
  });

  if (reply === null) return null;

  const text = formatServeRun(model, method, outputs, reports, completed);
  if (failure) {
    throw Object.assign(failure, { partialText: text });
  }
  if (!completed) {
    throw Object.assign(
      new Error("serve run ended without a completed event"),
      { partialText: text },
    );
  }
  if (completed.status !== "succeeded") {
    throw Object.assign(new Error(text), { partialText: text });
  }
  return {
    text,
    details: {
      system: undefined,
      method,
      model,
      via: "serve",
      status: completed.status,
      durationMs: completed.duration,
      outputId: completed.outputId,
      dataArtifacts: (completed.dataArtifacts ?? [])
        .map((artifact) => artifact?.name)
        .filter(Boolean),
      exitCode: 0,
    },
  };
}

function formatServeRun(model, method, outputs, reports, completed) {
  const lines = [`$ swamp serve ${model} ${method}`];
  for (const output of outputs) {
    lines.push(
      output.stream === "stderr" ? `[stderr] ${output.line}` : output.line,
    );
  }
  for (const report of reports) {
    lines.push(`── Report: ${report.name} ──`);
    if (report.markdown) lines.push(report.markdown);
    else if (report.error) lines.push(`report failed: ${report.error}`);
  }
  for (const artifact of completed?.dataArtifacts ?? []) {
    const attributes = artifact?.attributes ?? {};
    const text = attributes.text ?? attributes.content ?? attributes.stdout;
    if (typeof text === "string" && text.trim()) {
      lines.push(`── Data: ${artifact.name} ──`);
      lines.push(text);
    }
    if (typeof attributes.stderr === "string" && attributes.stderr.trim()) {
      lines.push(`── stderr: ${artifact.name} ──`);
      lines.push(attributes.stderr);
    }
  }
  if (completed) {
    lines.push(
      `Completed   ${method} on ${model} ${completed.status} in ${completed.duration}ms`,
    );
    const names = (completed.dataArtifacts ?? [])
      .map((artifact) => artifact?.name)
      .filter(Boolean);
    if (names.length > 0) lines.push(`Data produced: ${names.join(", ")}`);
  }
  return lines.join("\n");
}

/** Read a swamp data record, returning its inner content. */
async function swampData(model, spec) {
  if (SERVE_ENABLED) {
    try {
      const reply = await serveRequest(
        "data.get",
        { modelIdOrName: model, dataName: spec },
        { timeoutMs: 5000 },
      );
      if (reply && reply.type === "data.get") {
        const data = reply.payload?.data ?? reply.payload ?? reply;
        return data?.content ?? data?.attributes ?? data;
      }
    } catch {
      // data.get may be HTTP-only or denied over this socket; fall back.
    }
  }

  const result = await runProcess(
    SWAMP_BIN,
    ["data", "get", model, spec, "--json"],
    { cwd: process.cwd(), timeoutMs: 5000 },
  );
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed.content ?? parsed.attributes ?? parsed;
  } catch {
    return null;
  }
}

function normalizeTracesUrl(value) {
  let endpoint = String(value ?? "").trim();
  if (!endpoint) return "";
  if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
  endpoint = endpoint.replace(/\/+$/, "");
  if (/\/v1\/traces$/i.test(endpoint)) return endpoint;
  return `${endpoint}/v1/traces`;
}

function parseResourceAttributes(value) {
  const out = {};
  for (const pair of String(value ?? "").split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return out;
}

/** Resolve the OTLP endpoint from otel-settings, then the environment. */
async function resolveOtel() {
  if (!OTEL_ENABLED) return null;
  if (otelCache !== undefined) return otelCache;

  let endpoint = OTEL_ENDPOINT.trim();
  let attributes = {};
  let token = process.env[OTEL_TOKEN_REF] ?? "";

  if (!endpoint) {
    const settings = await swampData(OTEL_MODEL, "resolved") ??
      await swampData(OTEL_MODEL, "settings");
    if (settings && typeof settings === "object") {
      attributes = {
        ...(settings.attributes && typeof settings.attributes === "object"
          ? settings.attributes
          : {}),
      };
      if (settings.deploymentEnvironment) {
        attributes["deployment.environment"] = settings.deploymentEnvironment;
      }
      const endpoints = Array.isArray(settings.endpoints)
        ? settings.endpoints.filter((e) =>
          e && (e.otlp_http_url || e.otlp_http)
        )
        : [];
      const chosen = endpoints.find((e) =>
        e.mesh && e.mesh === settings.defaultMesh
      ) ?? endpoints[0];
      if (chosen) {
        endpoint = chosen.otlp_http_url ||
          (chosen.otlp_http ? `http://${chosen.otlp_http}` : "");
      }
    }
  }

  if (!endpoint) {
    endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
  }
  attributes = {
    ...attributes,
    ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES ?? ""),
  };
  if (!token) {
    const headers = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
      process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
    for (const pair of headers.split(",")) {
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      if (pair.slice(0, index).trim().toLowerCase() !== "authorization") {
        continue;
      }
      token = pair.slice(index + 1).trim().replace(/^Bearer\s+/i, "");
    }
  }

  otelCache = endpoint
    ? {
      endpoint: normalizeTracesUrl(endpoint),
      token,
      attributes,
    }
    : null;
  return otelCache;
}

function otlpValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: truncate(String(value ?? ""), 2000) };
}

function otlpAttributes(values) {
  return Object.entries(values)
    .filter(([key, value]) => key && value !== undefined)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

/** Post one span for a tool call. */
async function emitToolSpan(info, sessionId, cwd) {
  const otel = await resolveOtel();
  if (!otel) return;
  const route = info.route ?? "other";
  const bypass = route === "bypass";
  const startMs = info.startMs ?? Date.now();
  const endMs = info.endMs ?? Date.now();
  const traceparent = info.traceId
    ? `00-${info.traceId}-${info.spanId}-01`
    : null;
  // The addin's span is the parent of the extension's child span. When the
  // tool call did not create its own ids, generate a standalone trace.
  const traceId = info.traceId ?? randomHex(16);
  const spanId = info.spanId ?? randomHex(8);
  const parent = process.env.TRACEPARENT
    ? String(process.env.TRACEPARENT).split("-")
    : null;

  const attributes = {
    "swamp.agent.tool.name": info.toolName ?? "unknown",
    ...(info.authorization
      ? {
        "swamp.agent.authorization.status": info.authorization.status,
        "swamp.agent.authorization.scope": info.authorization.scope ?? "",
        "swamp.agent.authorization.via": info.authorization.via ?? "",
        "swamp.agent.authorization.feature": info.authorization.feature ?? "",
        "swamp.agent.authorization.approval": info.authorization.approval ?? "",
        "swamp.agent.authorization.reason": info.authorization.reason ?? "",
      }
      : {}),
    "swamp.agent.tool.routed": route === "herdr-core" || route === "vim",
    "swamp.agent.tool.bypass": bypass,
    "swamp.agent.tool.blocked": info.blocked === true,
    "swamp.agent.tool.outcome": info.success ? "success" : "error",
    "swamp.agent.tool.duration_ms": endMs - startMs,
    "swamp.agent.session.id": sessionId ?? "",
    "swamp.agent.cwd": cwd ?? "",
    "swamp.agent.tool.args": truncate(info.args ?? ""),
    "swamp.agent.tool.result": truncate(info.result ?? ""),
    "swamp.route": route,
    "swamp.outcome": info.success ? "success" : "error",
    "swamp.success": info.success === true,
    "swamp.method": info.method ?? `pi.tool.${info.toolName ?? "unknown"}`,
    "swamp.target": info.target ?? "",
    "swamp.agent.span.name": info.spanName ?? info.toolName ?? "unknown",
    ...(info.bypassReason
      ? { "swamp.agent.bypass.reason": info.bypassReason }
      : {}),
    ...(info.shell
      ? {
        "swamp.agent.shell.program": info.shell.programs.join(","),
        "swamp.agent.shell.subcommand": info.shell.subcommands.join(","),
        "swamp.agent.shell.category": info.shell.category,
      }
      : {}),
    ...(info.error ? { "swamp.error": truncate(info.error, 500) } : {}),
  };

  const resourceAttributes = {
    "service.name": SERVICE_NAME,
    "service.version": "1",
    "service.instance.id": sessionId ?? "pi",
    ...otel.attributes,
  };

  const payload = {
    resourceSpans: [{
      resource: { attributes: otlpAttributes(resourceAttributes) },
      scopeSpans: [{
        scope: { name: SERVICE_NAME, version: "1" },
        spans: [{
          traceId,
          spanId,
          ...(parent && parent.length === 4 ? { parentSpanId: parent[2] } : {}),
          name: info.spanName ?? info.toolName ?? "pi.tool",
          kind: 1,
          startTimeUnixNano: `${BigInt(startMs) * 1_000_000n}`,
          endTimeUnixNano: `${BigInt(endMs) * 1_000_000n}`,
          attributes: otlpAttributes(attributes),
          status: {
            code: info.success ? 1 : 2,
            ...(info.error ? { message: truncate(info.error, 500) } : {}),
          },
        }],
      }],
    }],
  };

  try {
    await fetch(otel.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(otel.token ? { authorization: `Bearer ${otel.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    // Never let observability break a tool call.
  }
  void traceparent;
}

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content.map((item) =>
      item && item.type === "text" ? item.text : item?.type ?? ""
    ).join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

const SHELL_BUILTINS = new Set([
  ":",
  ".",
  "[",
  "alias",
  "bg",
  "break",
  "builtin",
  "cd",
  "command",
  "continue",
  "disown",
  "echo",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
]);

const SUBCOMMAND_PROGRAMS = new Set([
  "git",
  "deno",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "swamp",
  "cargo",
  "go",
  "docker",
  "podman",
  "systemctl",
  "kubectl",
  "aws",
  "gcloud",
  "ssh",
  "curl",
  "jq",
  "python",
  "python3",
  "uv",
  "rustup",
  "gh",
]);

/** Split a shell command on ;, &&, ||, | and newlines, respecting quotes. */
function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = "";
  const text = String(command ?? "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        i++;
        if (i < text.length) current += text[i];
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      if (i < text.length) current += text[i];
      continue;
    }
    // Keep redirections such as 2>&1 and &>log in the same segment.
    if (
      ch === "&" &&
      (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")
    ) {
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if ((ch === "&" || ch === "|") && text[i + 1] === ch) i++;
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Split one segment into words, respecting quotes and backslash escapes. */
function splitShellWords(text) {
  const words = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        if (i < text.length) current += text[i];
        continue;
      }
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

function parseDurationMs(value) {
  const match = String(value ?? "").trim().match(/^(\d+)([smhd])$/i);
  if (!match) return 0;
  const unit = match[2].toLowerCase();
  const factor = unit === "s"
    ? 1000
    : unit === "m"
    ? 60_000
    : unit === "h"
    ? 3_600_000
    : 86_400_000;
  return Number(match[1]) * factor;
}

const TEST_ARGV = [
  join(homedir(), ".swamp/deno/deno"),
  "test",
  "--allow-all",
  "extensions/models/swamp-ide-pi-plugin/swamp_ide_policy_test.ts",
  "extensions/models/swamp-ide-pi-plugin/swamp_ide_lock_test.ts",
  "extensions/models/swamp-ide-pi-plugin/swamp_ide_pi_plugin_test.ts",
];

function repoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "extensions", "models"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function actionScopes(actions) {
  const root = repoRoot();
  const addin = join(
    root,
    "extensions/models/swamp-ide-pi-plugin/pi/swamp-ide.ts",
  );
  const policy = join(
    root,
    "extensions/models/swamp-ide-pi-plugin/pi/swamp-ide-policy.ts",
  );
  const pluginDir = join(root, "extensions/models/swamp-ide-pi-plugin");
  const swampIdeDir = join(root, "extensions/models/swamp-ide");
  const allSource = [
    addin,
    policy,
    join(
      root,
      "extensions/models/swamp-ide-pi-plugin/pi/swamp-ide-lock.ts",
    ),
    join(pluginDir, "swamp_ide_policy_test.ts"),
    join(pluginDir, "swamp_ide_lock_test.ts"),
    join(pluginDir, "swamp_ide_pi_plugin_test.ts"),
    join(pluginDir, "manifest.yaml"),
    join(pluginDir, "README.md"),
    join(swampIdeDir, "herdr/main.js"),
    join(swampIdeDir, "herdr/mod.json"),
    join(swampIdeDir, "herdr/swamp-ide/main.js"),
    join(swampIdeDir, "herdr/swamp-ide/mod.json"),
    join(swampIdeDir, "herdr/swamp-ide-approval/main.js"),
    join(swampIdeDir, "herdr/swamp-ide-approval/mod.json"),
    join(swampIdeDir, "herdr/layout.json"),
    join(swampIdeDir, "swamp_ide.ts"),
    join(swampIdeDir, "manifest.yaml"),
    join(swampIdeDir, "README.md"),
    join(swampIdeDir, "enable.yaml"),
    join(swampIdeDir, "disable.yaml"),
  ];
  const out = [];
  for (const action of String(actions ?? "").split(",")) {
    const name = action.trim();
    if (!name) continue;
    if (name === "edit-addin") {
      out.push(`protected:${addin}`, `protected:${policy}`);
    } else if (name === "edit-swamp-ide") {
      for (const path of allSource) out.push(`protected:${path}`);
    } else if (name === "install-addin") {
      out.push("swamp:ide-pi.set");
    } else if (name === "install-herdr-panel") {
      out.push("swamp:ide.setHerdr");
    } else if (name === "update-dashboard") {
      out.push("swamp:ide-openobserve.dashboard");
    } else if (name === "run-tests") {
      const hash = createHash("sha256").update(
        JSON.stringify({ argv: TEST_ARGV, cwd: root }),
      ).digest("hex").slice(0, 16);
      out.push(`exec:${hash}`);
    } else {
      out.push(name);
    }
  }
  return [...new Set(out)];
}

/** The executable one shell segment runs, with wrappers and assignments removed. */
function shelloutFromSegment(segment) {
  const words = splitShellWords(segment);
  while (words.length > 0) {
    const first = words[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      words.shift();
      continue;
    }
    if (first === "env") {
      words.shift();
      continue;
    }
    if (
      ["sudo", "doas", "command", "exec", "nohup", "time", "stdbuf"]
        .includes(first)
    ) {
      words.shift();
      continue;
    }
    if (first === "nice") {
      words.shift();
      while (words[0]?.startsWith("-")) words.shift();
      continue;
    }
    if (first === "timeout") {
      words.shift();
      if (words[0] && /^\d/.test(words[0])) words.shift();
      continue;
    }
    break;
  }
  if (words.length === 0) return null;

  let program = basename(words[0]).replace(/^["']|["']$/g, "");
  if (!program || program.startsWith("-") || program === "(") return null;
  program = program.replace(
    /^(python|node|ruby|perl|php)\d+(?:\.\d+)*$/,
    "$1",
  );

  let subcommand = "";
  if (SUBCOMMAND_PROGRAMS.has(program)) {
    for (let i = 1; i < words.length; i++) {
      if (words[i].startsWith("-")) continue;
      subcommand = words[i];
      break;
    }
  }
  return { program, subcommand, builtin: SHELL_BUILTINS.has(program) };
}

function shelloutsFromArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const parts = argv.map(String);
  const base = basename(parts[0]);
  if (
    ["sh", "bash", "zsh", "dash"].includes(base) &&
    parts[1] === "-c" &&
    parts[2]
  ) {
    return shelloutsFromCommand(parts[2]);
  }
  let subcommand = "";
  if (SUBCOMMAND_PROGRAMS.has(base)) {
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].startsWith("-")) continue;
      subcommand = parts[i];
      break;
    }
  }
  return [{ program: base, subcommand, builtin: false }];
}

/** Every executable a bash command runs, one per shell segment. */
function shelloutsFromCommand(command) {
  return splitShellSegments(command)
    .map(shelloutFromSegment)
    .filter((item) => item !== null);
}

/** Append one line per shelled-out program, for the prioritisation histogram. */
async function appendShellouts(info, shellouts, ctx) {
  const ts = new Date(info.endMs ?? Date.now()).toISOString();
  const category = info.route === "bypass"
    ? "bypass"
    : info.route === "herdr-core"
    ? "routed"
    : "other";
  const durationMs = Math.max(
    0,
    (info.endMs ?? Date.now()) - (info.startMs ?? Date.now()),
  );
  for (const shellout of shellouts) {
    await appendJsonl(SHELLOUT_LOG, {
      ts,
      source: "pi",
      kind: "shellout",
      program: shellout.program,
      subcommand: shellout.subcommand,
      category,
      route: info.route,
      builtin: shellout.builtin,
      success: info.success === true,
      durationMs,
      blocked: info.blocked === true,
      session: ctx?.sessionId ?? "",
      cwd: ctx?.cwd ?? "",
    });
  }
}

/** Read the shell-out log and count programs and program+subcommand. */
async function shelloutHistogram(limit = 5) {
  let text;
  try {
    text = await readFile(SHELLOUT_LOG, "utf8");
  } catch {
    return { total: 0, programs: [], commands: [], categories: {} };
  }
  const programs = new Map();
  const commands = new Map();
  const categories = new Map();
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.kind !== "shellout" || !event.program) continue;
    total++;
    programs.set(event.program, (programs.get(event.program) ?? 0) + 1);
    const key = event.subcommand
      ? `${event.program} ${event.subcommand}`
      : event.program;
    commands.set(key, (commands.get(key) ?? 0) + 1);
    const category = event.category ?? "other";
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const top = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit);
  return {
    total,
    programs: top(programs),
    commands: top(commands),
    categories: Object.fromEntries(categories),
  };
}

function formatHistogram(hist) {
  if (!hist.total) return ["shell-outs: none recorded yet"];
  const categories = Object.entries(hist.categories)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return [
    `shell-outs: ${hist.total}${categories ? ` (${categories})` : ""}`,
    `  by program: ${
      hist.programs.map(([name, count]) => `${name} ×${count}`).join(", ")
    }`,
    `  by command: ${
      hist.commands.map(([name, count]) => `${name} ×${count}`).join(", ")
    }`,
  ];
}

function hintForTool(tool, input) {
  if (tool === "read") {
    return "Use swamp_ide system=herdr-core method=file-read (or system=vim " +
      "method=read when the person is watching Vim) instead of the built-in " +
      'read tool. Pass input={"paths":["' + (input?.path ?? "file") + '"]}.';
  }
  if (tool === "write") {
    return "Use swamp_ide system=herdr-core method=file-write (or system=vim " +
      "method=edit with setLines) instead of the built-in write tool.";
  }
  if (tool === "edit") {
    return "Use swamp_ide system=herdr-core method=file-edit (or system=vim " +
      "method=edit) so the change is exact-once, atomic and produces a diff.";
  }
  if (tool === "grep" || tool === "glob" || tool === "find") {
    return "Use swamp_ide system=herdr-core method=search with a ripgrep " +
      "pattern and optional paths/globs.";
  }
  return "Use the swamp_ide tool for file, search, run and live-editor work.";
}

function hintForBash(command) {
  const cmd = String(command ?? "").trim();
  if (/^(rg|grep|find|fd)\b/.test(cmd)) {
    return "Use swamp_ide system=herdr-core method=search instead of " +
      `\`${cmd.split(/\s+/)[0]}\`; it returns typed path/line/column matches.`;
  }
  if (/^(cat|head|tail|less|more)\b/.test(cmd)) {
    return "Use swamp_ide system=herdr-core method=file-read instead of " +
      `\`${
        cmd.split(/\s+/)[0]
      }\`; the result is swamp data with file identity.`;
  }
  if (/^(sed|awk)\b/.test(cmd) || /apply_patch/.test(cmd)) {
    return "Use swamp_ide system=herdr-core method=file-edit (or system=vim " +
      "method=edit) so the edit is exact-once, atomic and diffable.";
  }
  if (
    /(pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test|dotnet\s+test)/
      .test(cmd)
  ) {
    return "Use swamp_ide system=herdr-core method=run so the test runs in a " +
      "terminal the person can watch and the exit code is recorded.";
  }
  return "Use swamp_ide for this operation; see the available methods in its " +
    "description.";
}

/** The addin. */
export default function swampIde(pi) {
  if (!sessionEnabled()) return;

  void writeAddinHeartbeat(pi);
  const heartbeatTimer = setInterval(() => {
    void writeAddinHeartbeat(pi);
  }, 30_000);
  heartbeatTimer.unref?.();
  void connectServe().then(() => writeAddinHeartbeat(pi));
  void appendActivity({
    ts: ADDIN_LOADED_AT,
    source: "pi",
    kind: "startup",
    name: "swamp_ide addin",
    method: "",
    target: "",
    machine: "",
    route: "other",
    outcome: "success",
    durationMs: 0,
    model: "pi",
    detail: `mode=${MODE}`,
    command: "",
    error: "",
    session: currentSessionId(),
    cwd: process.cwd(),
    blocked: false,
  });

  pi.on("session_start", async () => {
    await writeAddinHeartbeat(pi);
  });

  pi.on("before_agent_start", async (event) => {
    try {
      const options = event.systemPromptOptions;
      if (options) {
        options.promptGuidelines ??= [];
        options.promptGuidelines.push(
          "Only swamp_ide is available in enforce mode. There is no bash, read, write, edit or grep tool. For files, search, commands and terminals use swamp_ide system=herdr-core. For live buffers use system=vim. For any swamp model method use system=swamp with model=<instance>.",
          "Use swamp_ide system=swamp model=ide-openobserve method=dashboard for extension methods such as the OpenObserve dashboard; do not look for a swamp CLI.",
          "If a task truly cannot be expressed through swamp_ide, stop and report the missing method; do not ask for a shell.",
        );
      }

      if (MODE === "enforce") {
        const names = typeof pi.getAllTools === "function"
          ? pi.getAllTools().map((tool) => tool.name)
          : [];
        const plan = guardPlan(names);
        // Never blank the tool set: if swamp_ide did not register, leave the
        // baseline enabled and record that tracking is off.
        if (plan.activeTools.length > 0) {
          try {
            pi.setActiveTools(plan.activeTools);
          } catch {
            // The guard is the second layer and degrades safely too.
          }
        }
        await writeAddinHeartbeat(pi, {
          swampIdeRegistered: plan.hasSwampIde,
          activeTools: pi.getActiveTools?.() ?? [],
          enforced: plan.enforcing,
          reason: plan.reason,
        });
      }
    } catch {
      // Hooks must never break the turn.
    }
  });

  pi.on("tool_execution_start", async (event) => {
    try {
      const toolName = event.toolName ?? event.tool ?? "unknown";
      const args = event.args ?? {};
      const system = toolName === "swamp_ide" ? args.system : undefined;
      calls.set(event.toolCallId, {
        toolName,
        args,
        startMs: Date.now(),
        traceId: randomHex(16),
        spanId: randomHex(8),
        system,
        method: toolName === "swamp_ide" ? args.method : undefined,
        target: toolName === "swamp_ide"
          ? args.server ?? args.target
          : undefined,
      });
    } catch {
      // ignore
    }
  });

  pi.on("tool_call", async (event) => {
    try {
      const info = calls.get(event.toolCallId);
      const toolName = event.toolName ?? event.tool ?? "unknown";
      if (info && toolName === "swamp_ide") {
        info.system = event.input?.system ?? info.system;
        info.method = event.input?.method ?? info.method;
      }
      if (MODE !== "enforce") return;
      if (toolName === "swamp_ide") return;
      if (info) info.blocked = true;
      if (BYPASS_TOOLS.has(toolName)) {
        return {
          block: true,
          reason: hintForTool(toolName, event.input ?? {}),
        };
      }
      if (toolName === "bash") {
        const command = String(event.input?.command ?? "");
        return { block: true, reason: hintForBash(command) };
      }
      return {
        block: true,
        reason:
          "Only swamp_ide is available in enforce mode. Use system=herdr-core for files, search, commands and terminals; system=vim for live buffers; system=swamp model=<instance> for swamp model methods.",
      };
    } catch {
      // ignore
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    try {
      const info = calls.get(event.toolCallId) ?? {
        toolName: event.toolName ?? event.tool ?? "unknown",
        startMs: Date.now(),
        traceId: randomHex(16),
        spanId: randomHex(8),
      };
      calls.delete(event.toolCallId);
      const toolName = info.toolName;
      const routed = toolName === "swamp_ide";
      const bash = toolName === "bash" ? String(info.args?.command ?? "") : "";
      const routedArgv = toolName === "swamp_ide" &&
          (info.method === "exec" || info.method === "run")
        ? shelloutsFromArgv(info.args?.input?.argv)
        : [];
      const shellouts = toolName === "bash"
        ? shelloutsFromCommand(bash)
        : routedArgv;
      const bypass = !routed &&
        (BYPASS_TOOLS.has(toolName) ||
          (toolName === "bash" && BYPASS_BASH.test(bash)));
      info.endMs = Date.now();
      info.success = event.isError !== true;
      info.error = event.isError ? truncate(resultText(event.result), 500) : "";
      info.result = truncate(resultText(event.result), 2000);
      info.route = routed
        ? (info.system === "vim"
          ? "vim"
          : info.system === "swamp"
          ? "swamp"
          : "herdr-core")
        : (bypass ? "bypass" : "other");
      info.shell = shellouts.length > 0
        ? {
          programs: [...new Set(shellouts.map((item) => item.program))],
          subcommands: [
            ...new Set(
              shellouts.map((item) => item.subcommand).filter(Boolean),
            ),
          ],
          category: info.route === "bypass" ? "bypass" : "other",
        }
        : undefined;
      const shellLabel = shellouts.length > 0
        ? shellouts
          .map((item) =>
            item.subcommand
              ? `${item.program}.${item.subcommand}`
              : item.program
          )
          .join("+")
        : "bash";
      info.spanName = routed
        ? `swamp_ide.${
          info.system === "vim"
            ? "vim"
            : info.system === "swamp"
            ? "swamp"
            : "herdr-core"
        }.${info.method ?? "call"}`
        : bypass
        ? (toolName === "bash" ? `bypass.bash.${shellLabel}` : `bypass.${toolName}`)
        : (toolName === "bash" ? `tool.bash.${shellLabel}` : `tool.${toolName}`);
      info.bypassReason = bypass
        ? `used built-in ${toolName} instead of swamp_ide`
        : "";
      if (routed) {
        info.method = info.method ?? "swamp_ide";
      }
      if (shellouts.length > 0) {
        await appendShellouts(info, shellouts, ctx);
      }
      await appendActivity({
        ts: new Date(info.endMs).toISOString(),
        source: "pi",
        kind: "tool",
        name: toolName,
        method: info.method ?? "",
        target: info.target ?? "",
        machine: "",
        route: info.route,
        outcome: info.success ? "success" : "error",
        durationMs: Math.max(0, info.endMs - info.startMs),
        model: "pi",
        detail: truncate(JSON.stringify(info.args ?? {}), 500),
        command: bash,
        error: info.error ?? "",
        session: ctx.sessionId ?? "",
        cwd: ctx.cwd ?? "",
        authStatus: info.authorization?.status ?? "",
        authScope: info.authorization?.scope ?? "",
        authVia: info.authorization?.via ?? "",
        authFeature: info.authorization?.feature ?? "",
        authApproval: info.authorization?.approval ?? "",
        authReason: info.authorization?.reason ?? "",
        blocked: info.blocked === true,
      });
      await emitToolSpan(info, ctx.sessionId, ctx.cwd);
      await writeAddinHeartbeat(pi);
    } catch {
      // ignore
    }
  });

  pi.registerTool({
    name: "swamp_ide",
    label: "Swamp IDE",
    description:
      "Run a @svendowideit/herdr-core, @svendowideit/vim-controller or arbitrary swamp model method " +
      "against a live session. Use herdr-core for terminals, files, search, exec and " +
      "the machine fleet; use vim for the buffer a person is watching; use system=swamp " +
      "with model=<instance> for any swamp model method (for example the OpenObserve dashboard). " +
      "Methods (herdr-core): status, terminals, read, run, send, keys, " +
      "interrupt, kill, rm, put, wait, exec, file-read, file-write, " +
      "file-edit, file-edit-lines, search, machines, machine-add, " +
      "machine-remove, otel-status. " +
      "Methods (vim): servers, open, status, read, edit, write, cursor, " +
      "annotate, select, diff, command, expr, keys, diagnostics, undo, " +
      "close, otel-status.",
    promptSnippet:
      "Run swamp herdr-core/vim/swamp methods; the only tool in enforce mode",
    promptGuidelines: [
      "Use swamp_ide system=herdr-core method=file-read/search/file-edit/run/exec instead of bash, read, write, edit or grep for code work.",
      "Use swamp_ide system=vim method=read/edit/annotate when the person is watching a Vim buffer; read before editing.",
      "Write methods file-write/file-edit/file-edit-lines take input.path (one file); file-read and search take input.paths.",
      "Use swamp_ide system=swamp model=<instance> method=<method> for any swamp model method; do not use a swamp CLI.",
      "When a swamp_ide result starts with an Authorization: line, quote that line verbatim in your response; do not paraphrase or invent an authorization explanation.",
      "Never use sh -c, bash -c, or another shell wrapper for a swamp_ide exec/run. The approval must show the complete exact argv and your explanation; multi-step work must use a committed named script whose full contents were read and shown.",
    ],
    parameters: Type.Object({
      system: Type.Union([
        Type.Literal("herdr-core"),
        Type.Literal("vim"),
        Type.Literal("swamp"),
      ]),
      method: Type.String({ description: "The swamp method to run." }),
      input: Type.Optional(Type.Record(Type.String(), Type.Any())),
      model: Type.Optional(Type.String({
        description:
          "Swamp model instance name; required when system=swamp.",
      })),
      reason: Type.Optional(Type.String({
        description:
          "Why this mutation is needed; shown in the Herdr approval dialog.",
      })),
      goal: Type.Optional(Type.String({
        description:
          "What this mutation will achieve; shown in the Herdr approval dialog.",
      })),
      timeout: Type.Optional(Type.Number({
        description: "Seconds before the swamp run is cancelled.",
      })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const info = calls.get(toolCallId);
      const system = params.system;
      if (system === "swamp" && !params.model) {
        throw new Error("swamp_ide system=swamp requires model=<instance>");
      }
      const model = params.model ||
        (system === "vim" ? VIM_MODEL : system === "swamp" ? "" : HERDR_MODEL);
      const writeProblem = writeInputProblem(system, params.method, params.input);
      if (writeProblem) {
        const blocked = blockedAuthorization(
          `input:${params.method}`,
          null,
          writeProblem,
        );
        if (info) info.authorization = blocked;
        throw new Error(`${formatAuthorization(blocked)}\n${writeProblem}`);
      }
      const timeout = params.timeout ?? 600;
      const timeoutMs = (timeout + 5) * 1000;

      const traceId = info?.traceId ?? randomHex(16);
      const spanId = info?.spanId ?? randomHex(8);
      if (info) {
        info.traceId = traceId;
        info.spanId = spanId;
        info.system = system;
        info.method = params.method;
      }

      const sessionCwd = ctx?.cwd ?? process.cwd();
      const requestedCwd = params.input?.cwd;
      const cwd = requestedCwd
        ? (isAbsolute(String(requestedCwd))
          ? String(requestedCwd)
          : join(sessionCwd, String(requestedCwd)))
        : sessionCwd;
      let canonical = "";
      if (params.input?.path) {
        canonical = await canonicalPath(String(params.input.path), cwd);
      }
      const commandHash = system === "herdr-core" &&
          (params.method === "exec" || params.method === "run")
        ? createHash("sha256").update(
          JSON.stringify({ argv: params.input?.argv ?? [], cwd }),
        ).digest("hex").slice(0, 16)
        : "";
      if (system === "herdr-core" &&
        (params.method === "exec" || params.method === "run") &&
        isShellWrapper(params.input?.argv)
      ) {
        const blocked = blockedAuthorization(
          "exec:shell-wrapper",
          null,
          "a shell wrapper hides the real command from the approval dialog and cannot be approved",
        );
        if (info) info.authorization = blocked;
        throw new Error(
          `${formatAuthorization(blocked)}\n` +
            "Show the complete exact argv instead, or commit a named script whose full contents you have read and show the script path.",
        );
      }
      const decision = classifyCall({
        system,
        method: params.method,
        model,
        input: params.input,
        cwd,
        home: homedir(),
        canonicalPath: canonical,
        commandHash,
      });
      if (decision.mutating) {
        if (!String(params.reason ?? "").trim() || !String(params.goal ?? "").trim()) {
          const blocked = blockedAuthorization(
            decision.scope,
            null,
            "a mutation request is missing a complete reason and goal and cannot be approved",
          );
          if (info) info.authorization = blocked;
          throw new Error(
            `${formatAuthorization(blocked)}\n` +
              "Provide both reason and goal, describing the command and its effect, then retry.",
          );
        }
      }
      if (decision.mutating && isBroadScope(decision.scope)) {
        const blocked = blockedAuthorization(
          decision.scope,
          "too-broad",
          "request is too broad; be more specific to the job you're trying to do",
        );
        if (info) info.authorization = blocked;
        throw new Error(
          `${formatAuthorization(blocked)}\nReject: be more specific to the job you're trying to do.`,
        );
      }
      let authorization = decision.mutating
        ? blockedAuthorization(decision.scope, null, decision.reason)
        : notRequiredAuthorization(decision.reason);
      if (decision.mutating) {
        let lease = await readLease();
        if (leaseAllows(lease, String(decision.scope), String(currentSessionId()))) {
          authorization = authorizationFromLease(
            lease,
            decision.scope,
            "lease",
          );
        } else {
          const command = system === "herdr-core" &&
              (params.method === "exec" || params.method === "run")
            ? { argv: params.input?.argv ?? [], cwd }
            : null;
          const approval = await requestHerdrApproval({
            decision,
            params,
            ctx,
            system,
            model,
            command,
            signal,
          });
          if (approval === "approve") {
            lease = await readLease();
            if (
              !leaseAllows(
                lease,
                String(decision.scope),
                String(currentSessionId()),
              )
            ) {
              authorization = blockedAuthorization(
                decision.scope,
                "approve",
                "you approved, but no matching lease was written",
              );
              throw new Error(
                `${formatAuthorization(authorization)}\nNo action was performed.`,
              );
            }
            authorization = authorizationFromLease(
              lease,
              decision.scope,
              "dialog",
              "approve",
            );
          } else if (approval === "use-tool") {
            const alternative = commandAlternatives(params.input?.argv)[0];
            const replacement = alternative
              ? `swamp_ide system=${alternative.system} method=${alternative.method} instead of ${alternative.program}`
              : "a native swamp_ide tool";
            authorization = blockedAuthorization(
              decision.scope,
              "use-tool",
              `use ${replacement} for this job`,
            );
            throw new Error(
              `${formatAuthorization(authorization)}\n` +
                `Use ${replacement}; the command was not run.`,
            );
          } else if (approval === "too-broad") {
            authorization = blockedAuthorization(
              decision.scope,
              "too-broad",
              "request is too broad; be more specific to the job you're trying to do",
            );
            throw new Error(
              `${formatAuthorization(authorization)}\nReject: be more specific to the job you're trying to do.`,
            );
          } else if (approval === "deny") {
            authorization = blockedAuthorization(
              decision.scope,
              "deny",
              "you denied the Herdr dialog",
            );
            throw new Error(
              `${formatAuthorization(authorization)}\nNo action was performed.`,
            );
          } else if (approval === "fallback") {
            authorization = blockedAuthorization(
              decision.scope,
              "fallback",
              "the Herdr dialog was closed without a decision",
            );
            throw new Error(
              `${formatAuthorization(authorization)}\n` +
                `Approve from pi with the exact command below.\n` +
                `/swamp-ide approve ${decision.scope} 10m\n` +
                `command: ${JSON.stringify(params.input ?? {})}`,
            );
          } else if (approval === "explain") {
            authorization = blockedAuthorization(
              decision.scope,
              "explain",
              "you asked for an explanation instead of approving",
            );
            throw new Error(
              `${formatAuthorization(authorization)}\n` +
                "Re-call with a clearer reason and goal; no action was performed.",
            );
          } else if (approval === "cancelled") {
            authorization = blockedAuthorization(
              decision.scope,
              "cancelled",
              "the approval request was cancelled",
            );
            throw new Error(
              `${formatAuthorization(authorization)}\nNo action was performed.`,
            );
          } else if (approval === "timeout") {
            authorization = blockedAuthorization(
              decision.scope,
              "timeout",
              "the Herdr dialog was not answered before the 120s timeout",
            );
            throw new Error(
              `${formatAuthorization(authorization)}\nNo action was performed.`,
            );
          } else {
            authorization = blockedAuthorization(
              decision.scope,
              "unavailable",
              "Herdr was not running, so no approval dialog could be shown",
            );
            throw new Error(
              `${formatAuthorization(authorization)}\n` +
                `Run /swamp-ide approve ${decision.scope} 10m from pi to authorize it.`,
            );
          }
        }
      }
      if (info) info.authorization = authorization;

      // The serve fast path runs in the server's warm repo, so no per-call
      // swamp process, extension load, or datastore lock handshake. If the
      // socket cannot be established, fall back to the CLI. Once a request
      // has been sent we never retry: the method may have produced data.
      const served = await runMethodViaServe({
        model,
        method: params.method,
        inputs: params.input,
        info: info ?? { traceId, spanId },
        timeoutMs,
      });
      if (served) {
        return {
          content: [{
            type: "text",
            text: `${formatAuthorization(authorization)}\n\n${served.text}`,
          }],
          details: {
            ...served.details,
            system,
            method: params.method,
            model,
            authorization,
          },
        };
      }

      const args = ["behavior", "run", model, params.method];
      args.push("--timeout", String(timeout));
      let inputFile = "";
      try {
        if (params.input && Object.keys(params.input).length > 0) {
          inputFile = join(
            tmpdir(),
            `swamp-ide-${toolCallId.replace(/[^A-Za-z0-9_-]/g, "-")}.json`,
          );
          await writeFile(inputFile, JSON.stringify(params.input), "utf8");
          args.push("--input-file", inputFile);
        }

        const env = {
          ...process.env,
          TRACEPARENT: `00-${traceId}-${spanId}-01`,
        };
        const result = await runProcess(SWAMP_BIN, args, {
          cwd,
          env,
          timeoutMs,
        });
        const text = [
          formatAuthorization(authorization),
          `$ ${SWAMP_BIN} ${args.join(" ")}`,
          result.stdout.trim(),
          result.stderr.trim(),
          `exit ${result.code ?? "?"}`,
        ].filter(Boolean).join("\n\n");
        if (result.code !== 0) {
          throw Object.assign(new Error(text), { partialText: text });
        }
        return {
          content: [{ type: "text", text }],
          details: {
            system,
            method: params.method,
            model,
            via: "cli",
            exitCode: result.code,
            authorization,
          },
        };
      } finally {
        if (inputFile) {
          await unlink(inputFile).catch(() => {});
        }
      }
    },
  });

  pi.registerCommand("swamp-ide", {
    description:
      "Show the swamp IDE routing mode, OTLP, serve and shell-out histogram",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const [verb, ...rest] = raw.split(/\s+/);
      if (verb === "grant") {
        const feature = rest[0] || "";
        const scopes = actionScopes(rest[1] || "");
        const duration = rest[2] || "";
        const untilRevoked = duration === "until-revoked";
        const durationMs = untilRevoked ? 0 : parseDurationMs(duration);
        if (!feature || !scopes.length || (!untilRevoked && !durationMs)) {
          ctx.ui.notify(
            "usage: /swamp-ide grant <feature> <action[,action]> <30s|10m|1h|until-revoked>",
            "error",
          );
          return;
        }
        const leaseLock = await acquireLeaseLock();
        if (!leaseLock) {
          ctx.ui.notify(
            "approval lock is busy; try the grant again",
            "error",
          );
          return;
        }
        try {
          const current = await readLease();
          const features = current?.features && typeof current.features === "object"
            ? { ...current.features }
            : {};
        features[feature] = {
          scopes,
          untilRevoked,
          session: currentSessionId(),
          expiresAt: untilRevoked
            ? "2099-01-01T00:00:00.000Z"
            : new Date(Date.now() + durationMs).toISOString(),
        };
        const allScopes = [
          ...new Set(
            Object.values(features).flatMap((entry) =>
              Array.isArray(entry.scopes) ? entry.scopes : []
            ),
          ),
        ];
        const expiresAt = new Date(
          Math.max(
            ...Object.values(features).map((entry) =>
              Date.parse(String(entry.expiresAt ?? ""))
            ),
          ),
        ).toISOString();
        const scopeExpiry = {};
        for (const entry of Object.values(features)) {
          for (const scope of entry.scopes ?? []) {
            scopeExpiry[scope] = entry.expiresAt;
          }
        }
        await mkdir(dirname(LEASE_PATH), { recursive: true });
        await writeFile(
          LEASE_PATH,
          JSON.stringify({
            session: currentSessionId(),
            features,
            scopes: allScopes,
            scopeExpiry,
            issuedAt: new Date().toISOString(),
            expiresAt,
          }, null, 2),
          "utf8",
        );
        ctx.ui.notify(
          `granted ${feature}: ${scopes.length} scope(s) ${duration}`,
          "info",
        );
        return;
        } finally {
          await leaseLock.release();
        }
      }
      if (verb === "grants") {
        const lease = await readLease();
        const features = lease?.features ?? {};
        const lines = Object.entries(features).map(([name, entry]) =>
          `${name}: ${entry.untilRevoked ? "until-revoked" : entry.expiresAt} — ${entry.scopes?.length ?? 0} scope(s)`
        );
        ctx.ui.notify(lines.length ? lines.join("\n") : "no grants", "info");
        return;
      }
      if (verb === "approve") {
        const scope = rest[0] || "";
        const durationMs = parseDurationMs(rest[1]);
        if (!scope || !durationMs) {
          ctx.ui.notify(
            "usage: /swamp-ide approve <scope> <30s|10m|1h>",
            "error",
          );
          return;
        }
        const leaseLock = await acquireLeaseLock();
        if (!leaseLock) {
          ctx.ui.notify(
            "approval lock is busy; try the approval again",
            "error",
          );
          return;
        }
        try {
          const lease = {
            session: currentSessionId(),
            scopes: [scope],
            scopeExpiry: { [scope]: new Date(Date.now() + durationMs).toISOString() },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + durationMs).toISOString(),
          };
          await mkdir(dirname(LEASE_PATH), { recursive: true });
          await writeFile(LEASE_PATH, JSON.stringify(lease, null, 2), "utf8");
          ctx.ui.notify(`approved ${scope} for ${rest[1]}`, "info");
          return;
        } finally {
          await leaseLock.release();
        }
      }
      if (verb === "revoke") {
        const leaseLock = await acquireLeaseLock();
        if (!leaseLock) {
          ctx.ui.notify(
            "approval lock is busy; try the revoke again",
            "error",
          );
          return;
        }
        try {
          const feature = rest[0] || "";
        if (feature) {
          const lease = await readLease();
          const features = lease?.features && typeof lease.features === "object"
            ? { ...lease.features }
            : {};
          delete features[feature];
          const allScopes = [
            ...new Set(
              Object.values(features).flatMap((entry) =>
                Array.isArray(entry.scopes) ? entry.scopes : []
              ),
            ),
          ];
          if (allScopes.length) {
            const expiresAt = new Date(
              Math.max(
                ...Object.values(features).map((entry) =>
                  Date.parse(String(entry.expiresAt ?? ""))
                ),
              ),
            ).toISOString();
            const scopeExpiry = {};
            for (const entry of Object.values(features)) {
              for (const scope of entry.scopes ?? []) {
                scopeExpiry[scope] = entry.expiresAt;
              }
            }
            await writeFile(
              LEASE_PATH,
              JSON.stringify({
                session: currentSessionId(),
                features,
                scopes: allScopes,
                scopeExpiry,
                issuedAt: new Date().toISOString(),
                expiresAt,
              }, null, 2),
              "utf8",
            );
          } else {
            await unlink(LEASE_PATH).catch(() => {});
          }
          ctx.ui.notify(`revoked ${feature}`, "info");
          return;
        }
        await unlink(LEASE_PATH).catch(() => {});
        ctx.ui.notify("swamp-ide lease revoked", "info");
        return;
        } finally {
          await leaseLock.release();
        }
      }
      if (verb === "lease") {
        const lease = await readLease();
        ctx.ui.notify(
          lease ? JSON.stringify(lease, null, 2) : "no swamp-ide lease",
          "info",
        );
        return;
      }
      const text = raw.toLowerCase();
      const full = text.includes("histogram") || text.includes("shellout");
      const otel = await resolveOtel();
      const serve = serveStatus();
      const hist = await shelloutHistogram(full ? 20 : 5);
      const lines = [
        `mode: ${MODE}`,
        `session: ${currentSessionId() || "unknown"}`,
        `herdr-core model: ${HERDR_MODEL}`,
        `vim model: ${VIM_MODEL}`,
        otel
          ? `otel: ${otel.endpoint} (token ${otel.token ? "set" : "not set"})`
          : "otel: disabled (no otel-settings data and no OTEL endpoint)",
        serve.enabled
          ? `serve: ${serve.url} (${
            serve.connected
              ? "connected"
              : serve.lastError
              ? `unavailable: ${serve.lastError}`
              : "not connected"
          })`
          : "serve: disabled",
        "",
        ...formatHistogram(hist),
        full ? "" : "use /swamp-ide histogram for the top 20",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
