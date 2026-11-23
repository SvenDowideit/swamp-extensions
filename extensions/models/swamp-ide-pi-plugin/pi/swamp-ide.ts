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
//   SWAMP_IDE_MODE=off|advise|enforce   default advise
//   SWAMP_IDE_HERDR_MODEL               default herdr-core
//   SWAMP_IDE_VIM_MODEL                 default vim-controller
//   SWAMP_IDE_OTEL_ENABLED=false        turn span export off
//   SWAMP_IDE_OTEL_MODEL                default otel
//   SWAMP_IDE_OTEL_VAULT                optional vault name (not used here)
//   SWAMP_IDE_OTEL_TOKEN_REF            default OTEL_EXPORTER_OTLP_TOKEN
//   SWAMP_IDE_OTEL_ENDPOINT             explicit OTLP/HTTP traces endpoint
//   SWAMP_AGENT_IDE_EVENT_LOG           default ~/.local/state/swamp-agent-ide/events.jsonl
//   SWAMP_AGENT_IDE_SHELLOUT_LOG        default ~/.local/state/swamp-agent-ide/shellouts.jsonl
//   SWAMP_IDE_SERVE=off                disable the swamp serve fast path
//   SWAMP_SERVE_URL                    default ws://127.0.0.1:9090
//   SWAMP_BIN                          default swamp
//
// The addin is deliberately dependency-light: node:child_process, node:crypto,
// node:fs/promises, the global WebSocket (Node 22) and typebox (already present
// in Pi). It never throws from a hook; a broken observability setup only means
// a span is not exported, and a missing serve falls back to the CLI.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const MODE = (process.env.SWAMP_IDE_MODE ?? "advise").toLowerCase();
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
function sessionEnabled() {
  if (process.env.SWAMP_IDE_FORCE === "1") return true;
  const id = process.env.PI_SESSION_ID;
  return Boolean(id && existsSync(join(MARKER_DIR, `${id}.enabled`)));
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
    if (info.size > 2_000_000) {
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

/** Every executable a bash command runs, one per shell segment. */
function shelloutsFromCommand(command) {
  return splitShellSegments(command)
    .map(shelloutFromSegment)
    .filter((item) => item !== null);
}

/** Append one line per shelled-out program, for the prioritisation histogram. */
async function appendShellouts(info, shellouts, ctx) {
  const ts = new Date(info.endMs ?? Date.now()).toISOString();
  const category = info.route === "bypass" ? "bypass" : "other";
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

  pi.on("before_agent_start", async (event) => {
    try {
      const options = event.systemPromptOptions;
      if (!options) return;
      options.promptGuidelines ??= [];
      options.promptGuidelines.push(
        "Use swamp_ide system=herdr-core for file reads, writes, exact edits, ripgrep search, running tests, and terminal/agent inspection instead of bash/read/write/edit/grep.",
        "Use swamp_ide system=vim when the person is watching a Vim buffer: read before editing and annotate the agent's position instead of moving their cursor.",
        "Use bash only for commands swamp_ide does not cover (git, the swamp CLI, one-off probes).",
      );
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
      if (BYPASS_TOOLS.has(toolName)) {
        if (info) info.blocked = true;
        return {
          block: true,
          reason: hintForTool(toolName, event.input ?? {}),
        };
      }
      if (toolName === "bash") {
        const command = String(event.input?.command ?? "");
        if (BYPASS_BASH.test(command)) {
          if (info) info.blocked = true;
          return { block: true, reason: hintForBash(command) };
        }
      }
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
      const shellouts = toolName === "bash" ? shelloutsFromCommand(bash) : [];
      const bypass = !routed &&
        (BYPASS_TOOLS.has(toolName) ||
          (toolName === "bash" && BYPASS_BASH.test(bash)));
      info.endMs = Date.now();
      info.success = event.isError !== true;
      info.error = event.isError ? truncate(resultText(event.result), 500) : "";
      info.result = truncate(resultText(event.result), 2000);
      info.route = routed
        ? (info.system === "vim" ? "vim" : "herdr-core")
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
      info.spanName = routed
        ? `swamp_ide.${info.system === "vim" ? "vim" : "herdr-core"}.${
          info.method ?? "call"
        }`
        : bypass
        ? `bypass.${toolName}`
        : `tool.${toolName}`;
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
        blocked: info.blocked === true,
      });
      await emitToolSpan(info, ctx.sessionId, ctx.cwd);
    } catch {
      // ignore
    }
  });

  pi.registerTool({
    name: "swamp_ide",
    label: "Swamp IDE",
    description:
      "Run a @svendowideit/herdr-core or @svendowideit/vim-controller method against a " +
      "live session. Use herdr-core for terminals, files, search, exec and " +
      "the machine fleet; use vim for the buffer a person is watching. " +
      "Methods (herdr-core): status, terminals, read, run, send, keys, " +
      "interrupt, kill, rm, put, wait, exec, file-read, file-write, " +
      "file-edit, file-edit-lines, search, machines, machine-add, " +
      "machine-remove, otel-status. " +
      "Methods (vim): servers, open, status, read, edit, write, cursor, " +
      "annotate, select, diff, command, expr, keys, diagnostics, undo, " +
      "close, otel-status.",
    promptSnippet:
      "Run swamp herdr-core/vim methods for file, search, run and live editor work",
    promptGuidelines: [
      "Use swamp_ide system=herdr-core method=file-read/search/file-edit/run/exec instead of bash, read, write, edit or grep for code work.",
      "Use swamp_ide system=vim method=read/edit/annotate when the person is watching a Vim buffer; read before editing.",
      "Use bash only for commands swamp_ide does not cover (git, the swamp CLI, one-off probes).",
    ],
    parameters: Type.Object({
      system: Type.Union([Type.Literal("herdr-core"), Type.Literal("vim")]),
      method: Type.String({ description: "The swamp method to run." }),
      input: Type.Optional(Type.Record(Type.String(), Type.Any())),
      model: Type.Optional(Type.String({
        description: "Override the swamp model instance name.",
      })),
      timeout: Type.Optional(Type.Number({
        description: "Seconds before the swamp run is cancelled.",
      })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const info = calls.get(toolCallId);
      const system = params.system;
      const model = params.model ||
        (system === "vim" ? VIM_MODEL : HERDR_MODEL);
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
          content: [{ type: "text", text: served.text }],
          details: {
            ...served.details,
            system,
            method: params.method,
            model,
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
          cwd: ctx.cwd,
          env,
          timeoutMs,
        });
        const text = [
          `$ ${SWAMP_BIN} ${args.join(" ")}`,
          result.stdout.trim(),
          result.stderr.trim(),
          `exit ${result.code ?? "?"}`,
        ].filter(Boolean).join("\n");
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
      const text = String(args ?? "").trim().toLowerCase();
      const full = text.includes("histogram") || text.includes("shellout");
      const otel = await resolveOtel();
      const serve = serveStatus();
      const hist = await shelloutHistogram(full ? 20 : 5);
      const lines = [
        `mode: ${MODE}`,
        `session: ${process.env.PI_SESSION_ID ?? "unknown"}`,
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
