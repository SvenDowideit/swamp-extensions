/**
 * Configurable OTLP/HTTP tracing for the swamp agent-IDE extensions.
 *
 * Everything here is deliberately dependency-free: a method calls
 * {@link withOtelSpan}, which resolves the fleet contract from
 * `@svendowideit/otel-settings`, falls back to the standard OTEL environment
 * variables, and posts one OTLP/HTTP span. A missing or broken contract never
 * fails the method; it only means the span is not exported.
 *
 * Selection order for the endpoint:
 *   1. `otelEndpoint` (explicit override)
 *   2. the newest `resolved` (or legacy `settings`) resource on `otelModel`
 *   3. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`
 *
 * Selection order for the bearer token:
 *   1. `otelVaultName` + `otelTokenRef`
 *   2. the same key in the process environment
 *   3. `authorization` from `OTEL_EXPORTER_OTLP_*_HEADERS`
 *
 * The span names and attributes are stable so a dashboard can answer both
 * "what went through this system" and "what did not":
 *
 *   - `swamp.route`       herdr-core | vim | bypass | other
 *   - `swamp.outcome`     success | error
 *   - `swamp.success`     boolean
 *   - `swamp.method`      the swamp method
 *   - `swamp.target`      the terminal/server/path the method acted on
 *   - `swamp.machine`     the herdr-core machine, when known
 *
 * A caller that sets the W3C `TRACEPARENT` environment variable (the pi addin
 * does this for `swamp_ide`) gets the extension span as a child of the agent
 * tool-call span, so routed and bypassed calls can be compared in one trace.
 *
 * @module
 */

import { dirname } from "node:path";
import { z } from "npm:zod@4";

/** Global arguments shared by the herdr-core and Vim extensions. */
export const OtelConfigSchema = z.object({
  otelEnabled: z.boolean().default(true).describe(
    "Export OTLP/HTTP spans for every method call. A missing or broken " +
      "observability setup is reported, never fatal.",
  ),
  otelModel: z.string().default("otel").describe(
    "Name of the @svendowideit/otel-settings model supplying the contract.",
  ),
  otelVaultName: z.string().default("").describe(
    "Vault holding the OTLP gateway bearer token. Empty means: use the " +
      "environment, then the standard OTEL headers.",
  ),
  otelTokenRef: z.string().default("OTEL_EXPORTER_OTLP_TOKEN").describe(
    "Vault/environment key for the OTLP gateway bearer token.",
  ),
  otelEndpoint: z.string().default("").describe(
    "Explicit OTLP/HTTP traces endpoint override. Empty uses the contract, " +
      "then the standard OTEL environment.",
  ),
  otelMesh: z.string().default("").describe(
    "Prefer the otel-settings endpoint for this mesh. Empty uses the " +
      "contract's defaultMesh.",
  ),
  otelServiceName: z.string().default("swamp-herdr-core").describe(
    "service.name for exported spans.",
  ),
  otelTimeoutMs: z.number().int().positive().default(2500).describe(
    "Maximum time to spend posting one span.",
  ),
  otelDebug: z.boolean().default(false).describe(
    "Log the resolved endpoint and export failures at info level.",
  ),
  eventLogEnabled: z.boolean().default(true).describe(
    "Append one JSONL event per method to eventLog for the Herdr activity panel.",
  ),
  eventLog: z.string().default("~/.local/state/swamp-agent-ide/events.jsonl")
    .describe("JSONL event file shared with the pi addin and Herdr panel."),
});

/** Global OTEL arguments. */
export type OtelConfig = z.infer<typeof OtelConfigSchema>;

/** The small part of swamp's method context this module needs. */
export interface OtelContext {
  /** The newest resources for a model, as swamp exposes them to methods. */
  readModelData?: (
    model: string,
    spec: string,
  ) => Promise<Array<Record<string, unknown>>>;
  /** Read a secret by vault name + key. */
  vaultService?: {
    get(vault: string, key: string, reason: string): Promise<string>;
  };
  /** Swamp's method logger. */
  logger?: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warn: (message: string, props?: Record<string, unknown>) => void;
    debug?: (message: string, props?: Record<string, unknown>) => void;
  };
  /** The model definition, used for service.instance.id. */
  definition?: { name?: string };
}

/** What the caller wants the span to say. */
export interface OtelSpanInput {
  /** Span name, e.g. `herdr-core.file-edit` or `vim.edit`. */
  name: string;
  /** The terminal/server/path the method acted on, if any. */
  target?: string;
  /** The herdr-core machine name, if any. */
  machine?: string;
  /** Extra span attributes; values are stringified. */
  attributes?: Record<string, unknown>;
  /** The extension version, used for service.version. */
  extensionVersion: string;
  /** The route that produced the span. */
  route?: string;
}

/** A resolved endpoint, token and resource attribute set. */
export interface OtelResolution {
  /** Whether an endpoint was found. */
  enabled: boolean;
  /** Normalized traces URL. */
  endpoint: string;
  /** Mesh the endpoint belongs to, or `env`/`override`. */
  mesh: string;
  /** Bearer token, or "". */
  token: string;
  /** Whether a token was found. */
  tokenPresent: boolean;
  /** Resource attributes from the contract and environment. */
  attributes: Record<string, unknown>;
  /** Why tracing is enabled or disabled, for `otel-status`. */
  reason: string;
  /** Where the endpoint came from. */
  source: "settings" | "env" | "override" | "none";
}

/** The result of one OTLP export attempt. */
export interface OtelEmitResult {
  /** Whether the POST returned a 2xx. */
  ok: boolean;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  /** The traces endpoint used. */
  endpoint: string;
  /** Trace id written to the span. */
  traceId: string;
  /** Span id written to the span. */
  spanId: string;
  /** The error message when the export failed. */
  error?: string;
}

/** The parsed W3C traceparent header. */
export interface Traceparent {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

/** The record payload as an object, unwrapping a swamp data record. */
function recordData(record: unknown): Record<string, unknown> {
  if (typeof record !== "object" || record === null) return {};
  const obj = record as Record<string, unknown>;
  const inner = obj.attributes ?? obj.content;
  if (typeof inner === "object" && inner !== null) {
    return inner as Record<string, unknown>;
  }
  return obj;
}

/** Every version of `specName` on `modelName`, newest first. */
async function versionsOf(
  ctx: OtelContext,
  modelName: string,
  specName: string,
): Promise<Array<Record<string, unknown>>> {
  if (!ctx.readModelData || !modelName) return [];
  try {
    const rows = await ctx.readModelData(modelName, specName);
    return (rows ?? [])
      .slice()
      .sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))
      .map((r) => recordData(r));
  } catch {
    return [];
  }
}

/** The newest settings record: `resolved` first, then legacy `settings`. */
async function readSettings(
  ctx: OtelContext,
  modelName: string,
): Promise<Record<string, unknown>> {
  const resolved = await versionsOf(ctx, modelName, "resolved");
  if (resolved.length > 0) return resolved[0];
  const legacy = await versionsOf(ctx, modelName, "settings");
  return legacy[0] ?? {};
}

/** Read an environment variable without requiring --allow-env in tests. */
function envGet(key: string): string {
  try {
    return Deno.env.get(key) ?? "";
  } catch {
    return "";
  }
}

/** A string field, or "". */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse `OTEL_RESOURCE_ATTRIBUTES` (`key=value,key=value`). */
export function parseResourceAttributes(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const val = pair.slice(index + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

/** Parse a W3C traceparent, or null when it is invalid/unsampled. */
export function parseTraceparent(value: string): Traceparent | null {
  const match = value.trim().match(
    /^[0-9a-fA-F]{2}-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$/,
  );
  if (!match) return null;
  const traceId = match[1].toLowerCase();
  const spanId = match[2].toLowerCase();
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;
  const flags = Number.parseInt(match[3], 16);
  return { traceId, spanId, sampled: (flags & 1) === 1 };
}

/** Normalize an OTLP/HTTP base or traces URL. */
export function normalizeTracesUrl(value: string): string {
  let endpoint = value.trim();
  if (!endpoint) return "";
  if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
  endpoint = endpoint.replace(/\/+$/, "");
  if (/\/v1\/traces$/i.test(endpoint)) return endpoint;
  if (/\/v1\/(logs|metrics)$/i.test(endpoint)) {
    return endpoint.replace(/\/v1\/(logs|metrics)$/i, "/v1/traces");
  }
  return `${endpoint}/v1/traces`;
}

/** The bearer token from the standard OTEL headers variable. */
function tokenFromHeaders(): string {
  for (
    const key of [
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]
  ) {
    const raw = envGet(key);
    for (const pair of raw.split(",")) {
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      if (pair.slice(0, index).trim().toLowerCase() !== "authorization") {
        continue;
      }
      const auth = pair.slice(index + 1).trim();
      return auth.replace(/^Bearer\s+/i, "");
    }
  }
  return "";
}

/** Pick one endpoint from the contract. */
function pickEndpoint(
  endpoints: Array<Record<string, unknown>>,
  mesh: string,
  defaultMesh: string,
): Record<string, unknown> | null {
  const usable = endpoints.filter((e) =>
    str(e.otlp_http_url) || str(e.otlp_http)
  );
  if (usable.length === 0) return null;
  return usable.find((e) => mesh && str(e.mesh) === mesh) ??
    usable.find((e) => defaultMesh && str(e.mesh) === defaultMesh) ??
    usable[0];
}

/** Resolve the contract, environment and explicit override into one config. */
export async function resolveOtel(
  ctx: OtelContext,
  config: OtelConfig,
): Promise<OtelResolution> {
  if (!config.otelEnabled) {
    return {
      enabled: false,
      endpoint: "",
      mesh: "",
      token: "",
      tokenPresent: false,
      attributes: {},
      reason: "otelEnabled=false",
      source: "none",
    };
  }

  const settings = await readSettings(ctx, config.otelModel);
  const hasSettings = Object.keys(settings).length > 0;
  const settingsAttributes = typeof settings.attributes === "object" &&
      settings.attributes !== null
    ? settings.attributes as Record<string, unknown>
    : {};
  const deploymentEnvironment = str(settings.deploymentEnvironment);
  const authMethod = str(settings.authMethod) || "bearer";

  let endpoint = "";
  let mesh = "";
  let source: OtelResolution["source"] = "none";
  let reason = "";

  if (config.otelEndpoint.trim()) {
    endpoint = config.otelEndpoint;
    mesh = config.otelMesh || "override";
    source = "override";
    reason = "explicit otelEndpoint";
  } else if (hasSettings) {
    const endpoints = Array.isArray(settings.endpoints)
      ? settings.endpoints.filter((e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null
      )
      : [];
    const chosen = pickEndpoint(
      endpoints,
      config.otelMesh,
      str(settings.defaultMesh),
    );
    if (chosen) {
      endpoint = str(chosen.otlp_http_url) ||
        (str(chosen.otlp_http) ? `http://${str(chosen.otlp_http)}` : "");
      mesh = str(chosen.mesh);
      source = "settings";
      reason = `otel-settings model '${config.otelModel}'`;
    } else {
      reason = `otel-settings model '${config.otelModel}' has no HTTP endpoint`;
    }
  } else {
    reason = `otel-settings model '${config.otelModel}' has no resolved data`;
  }

  if (!endpoint && !config.otelEndpoint.trim()) {
    const envEndpoint = envGet("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ||
      envGet("OTEL_EXPORTER_OTLP_ENDPOINT");
    if (envEndpoint.trim()) {
      endpoint = envEndpoint;
      mesh = config.otelMesh || "env";
      source = "env";
      reason = "OTEL_EXPORTER_OTLP_ENDPOINT";
    }
  }

  if (!endpoint) {
    return {
      enabled: false,
      endpoint: "",
      mesh,
      token: "",
      tokenPresent: false,
      attributes: { ...settingsAttributes },
      reason: reason || "no OTLP endpoint configured",
      source: "none",
    };
  }

  let token = "";
  if (authMethod === "bearer" || source === "env") {
    if (config.otelVaultName && ctx.vaultService) {
      try {
        token = await ctx.vaultService.get(
          config.otelVaultName,
          config.otelTokenRef,
          `extension:${config.otelServiceName}`,
        );
      } catch {
        token = "";
      }
    }
    if (!token) token = envGet(config.otelTokenRef);
    if (!token) token = tokenFromHeaders();
  }

  const envAttributes = parseResourceAttributes(
    envGet("OTEL_RESOURCE_ATTRIBUTES"),
  );
  const attributes: Record<string, unknown> = {
    ...settingsAttributes,
    ...envAttributes,
  };
  if (deploymentEnvironment) {
    attributes["deployment.environment"] = deploymentEnvironment;
  }

  return {
    enabled: true,
    endpoint: normalizeTracesUrl(endpoint),
    mesh,
    token,
    tokenPresent: token.length > 0,
    attributes,
    reason,
    source,
  };
}

/** Random lowercase hex of `bytes` bytes. */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One OTLP attribute value. */
function otlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((v) => otlpValue(v)),
      },
    };
  }
  if (typeof value === "object" && value !== null) {
    return { stringValue: truncate(JSON.stringify(value), 2000) };
  }
  return { stringValue: truncate(String(value ?? ""), 2000) };
}

/** A list of OTLP key/value attributes. */
function otlpAttributes(
  values: Record<string, unknown>,
): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(values)
    .filter(([key, value]) => key.length > 0 && value !== undefined)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

/** Truncate a string for attribute payloads. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(${value.length - max} more chars)`;
}

/** Error message without a stack. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The local activity event shared with the pi addin and the Herdr panel. */
export interface AgentEvent {
  ts: string;
  source: string;
  route: string;
  kind: string;
  name: string;
  target: string;
  machine: string;
  outcome: "success" | "error";
  durationMs: number;
  model: string;
  detail: string;
  error: string;
}

/** Build one JSONL event line. Pure so it can be tested without a file. */
export function buildEventLine(
  input: OtelSpanInput,
  result: {
    success: boolean;
    startTimeMs: number;
    endTimeMs: number;
    error?: string;
  },
  instance: string,
): string {
  const event: AgentEvent = {
    ts: new Date(result.endTimeMs).toISOString(),
    source: input.route ?? "other",
    route: input.route ?? "other",
    kind: "method",
    name: input.name,
    target: input.target ?? "",
    machine: input.machine ?? "",
    outcome: result.success ? "success" : "error",
    durationMs: Math.max(0, result.endTimeMs - result.startTimeMs),
    model: instance,
    detail: truncate(JSON.stringify(input.attributes ?? {}), 500),
    error: result.error ?? "",
  };
  return JSON.stringify(event) + "\n";
}

/** Expand a leading `~`, without requiring HOME in tests. */
function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  let home = "~";
  try {
    home = Deno.env.get("HOME") ?? "~";
  } catch {
    // ignore
  }
  return path === "~" ? home : `${home}${path.slice(1)}`;
}

/** Append one method event; rotate to the last 1000 lines past ~2 MB. */
export async function appendEvent(
  config: OtelConfig,
  input: OtelSpanInput,
  result: {
    success: boolean;
    startTimeMs: number;
    endTimeMs: number;
    error?: string;
  },
  instance: string,
): Promise<void> {
  if (!config.eventLogEnabled) return;
  const path = expandHome(config.eventLog);
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, buildEventLine(input, result, instance), {
      append: true,
      create: true,
    });
    const stat = await Deno.stat(path);
    if (stat.size > 2_000_000) {
      const text = await Deno.readTextFile(path);
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-1000);
      await Deno.writeTextFile(path, lines.join("\n") + "\n");
    }
  } catch {
    // The activity panel is best-effort; never fail a method for it.
  }
}

/** Build the OTLP/HTTP traces payload for one span. */
export function buildSpanPayload(
  config: OtelConfig,
  resolution: OtelResolution,
  input: OtelSpanInput,
  result: {
    success: boolean;
    startTimeMs: number;
    endTimeMs: number;
    error?: string;
  },
  ids: { traceId: string; spanId: string; parentSpanId?: string },
  instance: string,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    "swamp.extension": config.otelServiceName,
    "swamp.route": input.route ?? "other",
    "swamp.method": input.name,
    "swamp.target": input.target ?? "",
    "swamp.machine": input.machine ?? "",
    "swamp.model": instance,
    "swamp.outcome": result.success ? "success" : "error",
    "swamp.success": result.success,
    "swamp.duration_ms": result.endTimeMs - result.startTimeMs,
    ...(result.error ? { "swamp.error": result.error } : {}),
    ...(input.attributes ?? {}),
  };
  const resourceAttributes: Record<string, unknown> = {
    "service.name": config.otelServiceName,
    "service.version": input.extensionVersion,
    "service.instance.id": instance,
    ...resolution.attributes,
  };

  return {
    resourceSpans: [{
      resource: { attributes: otlpAttributes(resourceAttributes) },
      scopeSpans: [{
        scope: {
          name: config.otelServiceName,
          version: input.extensionVersion,
        },
        spans: [{
          traceId: ids.traceId,
          spanId: ids.spanId,
          ...(ids.parentSpanId ? { parentSpanId: ids.parentSpanId } : {}),
          name: input.name,
          kind: 1,
          startTimeUnixNano: `${
            BigInt(Math.trunc(result.startTimeMs)) * 1_000_000n
          }`,
          endTimeUnixNano: `${
            BigInt(Math.trunc(result.endTimeMs)) * 1_000_000n
          }`,
          attributes: otlpAttributes(attributes),
          status: {
            code: result.success ? 1 : 2,
            ...(result.error ? { message: result.error } : {}),
          },
        }],
      }],
    }],
  };
}

/** Post one OTLP span, swallowing export failures. */
export async function emitSpan(
  ctx: OtelContext,
  config: OtelConfig,
  input: OtelSpanInput,
  result: {
    success: boolean;
    startTimeMs: number;
    endTimeMs: number;
    error?: string;
  },
): Promise<OtelEmitResult | null> {
  const resolution = await resolveOtel(ctx, config);
  if (!resolution.enabled || !resolution.endpoint) {
    if (config.otelDebug && resolution.reason) {
      ctx.logger?.info("OTEL span skipped: {reason}", {
        reason: resolution.reason,
      });
    }
    return null;
  }

  const traceparent = parseTraceparent(envGet("TRACEPARENT"));
  const traceId = traceparent?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const instance = ctx.definition?.name ?? "default";
  const payload = buildSpanPayload(
    config,
    resolution,
    input,
    result,
    {
      traceId,
      spanId,
      parentSpanId: traceparent?.spanId,
    },
    instance,
  );

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (resolution.token) {
    headers.authorization = `Bearer ${resolution.token}`;
  }

  try {
    const response = await fetch(resolution.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.otelTimeoutMs),
    });
    if (!response.ok) {
      const error = `OTLP export returned ${response.status}`;
      if (config.otelDebug) {
        ctx.logger?.warn("OTEL export failed: {error}", { error });
      }
      return {
        ok: false,
        status: response.status,
        endpoint: resolution.endpoint,
        traceId,
        spanId,
        error,
      };
    }
    return {
      ok: true,
      status: response.status,
      endpoint: resolution.endpoint,
      traceId,
      spanId,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (config.otelDebug) {
      ctx.logger?.warn("OTEL export failed: {error}", { error: message });
    }
    return {
      ok: false,
      status: null,
      endpoint: resolution.endpoint,
      traceId,
      spanId,
      error: message,
    };
  }
}

/** Run `fn`, emit exactly one span, and rethrow any method error. */
export async function withOtelSpan<T>(
  ctx: OtelContext,
  config: OtelConfig,
  input: OtelSpanInput,
  fn: () => Promise<T>,
): Promise<T> {
  const startTimeMs = Date.now();
  try {
    const result = await fn();
    const endTimeMs = Date.now();
    await appendEvent(
      config,
      input,
      { success: true, startTimeMs, endTimeMs },
      ctx.definition?.name ?? "default",
    );
    await emitSpan(ctx, config, input, {
      success: true,
      startTimeMs,
      endTimeMs,
    });
    return result;
  } catch (error) {
    const endTimeMs = Date.now();
    const message = truncate(errorMessage(error), 500);
    await appendEvent(
      config,
      input,
      { success: false, startTimeMs, endTimeMs, error: message },
      ctx.definition?.name ?? "default",
    );
    await emitSpan(ctx, config, input, {
      success: false,
      startTimeMs,
      endTimeMs,
      error: message,
    });
    throw error;
  }
}

/** Resolve the current OTEL state for the `otel-status` method. */
export async function otelStatus(
  ctx: OtelContext,
  config: OtelConfig,
): Promise<OtelResolution> {
  return await resolveOtel(ctx, config);
}
