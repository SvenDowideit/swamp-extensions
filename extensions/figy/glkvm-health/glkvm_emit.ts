/**
 * @figy/glkvm-health — forward a GL.iNet KVM's health to the OTel collector.
 *
 * The `@sntxrr/glinet-kvm` model knows how to *check* a GL.iNet KVM (Comet
 * GL-RM1 / GL-RM1PE) but has no way to *report* it to telemetry. This extension
 * adds one `emit` method and one `emit` resource to that type, mirroring the
 * `emit` that `@svendowideit/nanokvm` ships: it reads the model's latest
 * `health` record, resolves the OTLP endpoint and bearer token from the
 * `@svendowideit/otel-settings` contract (or an explicit override), and POSTs
 * one OTLP log record plus gauges to the collector. When no collector is
 * configured it is a no-op that records the reason, so it is always safe to
 * leave enabled in a schedule.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** This extension's name (the manifest `name:`). */
export const EXT_TYPE = "@figy/glkvm-health";

/** This extension's own version (must match manifest.yaml `version:`). */
export const EXT_VERSION = "2026.10.17.1";

/** The model type this extension augments. */
export const BASE_TYPE = "@sntxrr/glinet-kvm";

/** `service.name` reported to the OTel collector for a GL.iNet KVM. */
export const OTEL_SERVICE_NAME = "glkvm";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Arguments for the added `emit` method. */
const EmitArgsSchema = z.object({
  health: z.unknown().optional().describe(
    "A health record to emit. When omitted, the model's latest `health` " +
      "resource is used.",
  ),
  endpoint: z.string().default("").describe(
    "OTLP/HTTP base URL overriding both the settings contract and any global.",
  ),
  mesh: z.string().default("").describe("Contract mesh to use for this emit."),
  otelModel: z.string().default("otel").describe(
    "Name of the @svendowideit/otel-settings model supplying the contract.",
  ),
  otelVaultName: z.string().default("").describe(
    "Vault holding the OTLP gateway bearer token (empty = none).",
  ),
  otelTokenRef: z.string().default("OTEL_EXPORTER_OTLP_TOKEN").describe(
    "Vault/environment key for the OTLP gateway bearer token.",
  ),
});

/** The `emit` resource: one OTLP push, or why it was skipped. */
const EmitSchema = z.object({
  host: z.string(),
  skipped: z.boolean(),
  reason: z.string(),
  endpoint: z.string(),
  mesh: z.string(),
  logsStatus: z.union([z.number(), z.null()]),
  metricsStatus: z.union([z.number(), z.null()]),
  pushed: z.boolean(),
  verdict: z.string(),
  emittedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single health finding, as produced by `@sntxrr/glinet-kvm`. */
export interface Finding {
  /** Stable machine code, e.g. `firmware_update_available`. */
  code: string;
  /** Severity; `fail` fails the verdict, `warn` flags it, `info` is advisory. */
  severity: "info" | "warn" | "fail";
  /** Human-readable description of the finding. */
  message: string;
}

/** A GL.iNet KVM health sample, reduced to the fields `emit` reports. */
export interface KvmHealth {
  /** The device name or address the check targeted. */
  host: string;
  /** Verdict the check reached: `ok`, `warn` or `fail`. */
  verdict: string;
  /** True when the device answered. */
  reachable: boolean;
  /** Installed kvmd/application version, or empty. */
  kvmdVersion: string;
  /** The findings behind the verdict. */
  findings: Finding[];
  /** When the check ran (ISO-8601). */
  checkedAt: string;
  /** Whether a firmware update is available, when the device said. */
  updateAvailable: boolean | null;
  /** Whether USB HID is enumerated by the target, when known. */
  hidOnline: boolean | null;
  /** Whether an HDMI signal is present, when checked. */
  videoOnline: boolean | null;
  /** Whether virtual media is attached. */
  msdConnected: boolean;
  /** Whether 2FA is enabled on the KVM web UI, when known. */
  twoFactorEnabled: boolean | null;
}

/** The global arguments this extension reads from the `@sntxrr/glinet-kvm` type. */
interface GlobalArgs {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
}

/** A settings-contract OTLP endpoint as declared by `@svendowideit/otel-settings`. */
export interface ContractEndpoint {
  /** Optional endpoint name. */
  name?: string;
  /** Mesh this endpoint serves (e.g. `tailscale`). */
  mesh?: string;
  /** Plaintext OTLP/HTTP `host:port`. */
  otlp_http?: string;
  /** TLS OTLP/HTTP URL. */
  otlp_http_url?: string;
}

/** A resolved OTLP/HTTP endpoint. */
export interface OtelEndpoint {
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:4318`. */
  base: string;
  /** Mesh name the endpoint belongs to. */
  mesh: string;
}

/** Structural view of the method context fields this extension uses. */
interface MethodContext {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  logger?: {
    info: (message: string, props?: Record<string, unknown>) => void;
  };
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<
    Array<{
      name?: string;
      specName?: string;
      version?: number;
      content?: unknown;
      attributes?: unknown;
    }>
  >;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

function attr(key: string, value: string): {
  key: string;
  value: { stringValue: string };
} {
  return { key, value: { stringValue: String(value) } };
}

/**
 * Build the OTLP resource attribute list for a KVM health report.
 *
 * `service.name`, `service.version` and `device.type` are always present; any
 * non-empty contract attributes (site, owner, deployment environment) are
 * appended.
 */
export function telemetryResource(
  host: string,
  attributes: Record<string, unknown> = {},
): Array<{ key: string; value: { stringValue: string } }> {
  const out = [
    attr("service.name", OTEL_SERVICE_NAME),
    attr("service.version", EXT_VERSION),
    attr("device.type", "glinet-kvm"),
    attr("device.host", host),
  ];
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null || v === "") continue;
    out.push(attr(k, String(v)));
  }
  return out;
}

/**
 * Choose the OTLP/HTTP endpoint from a settings contract.
 *
 * An explicit override wins; otherwise the named mesh, then `defaultMesh`, then
 * the first endpoint. Prefers the plaintext `otlp_http` host:port for a local
 * collector and the TLS `otlp_http_url` for anything else.
 */
export function pickEndpoint(
  endpoints: ContractEndpoint[],
  options: {
    override?: string;
    mesh?: string;
    defaultMesh?: string;
    preferUrl?: boolean;
  } = {},
): OtelEndpoint {
  const override = (options.override ?? "").trim().replace(/\/+$/, "");
  if (override) return { base: override, mesh: "override" };

  const list = Array.isArray(endpoints) ? endpoints : [];
  const wanted = options.mesh || options.defaultMesh || "";
  const chosen = (wanted ? list.find((e) => e.mesh === wanted) : undefined) ??
    list[0];
  if (!chosen) return { base: "", mesh: "" };

  const hostPort = (chosen.otlp_http ?? "").trim();
  const url = (chosen.otlp_http_url ?? "").trim().replace(/\/+$/, "");
  const base = options.preferUrl || !hostPort
    ? url
    : `http://${hostPort.replace(/^https?:\/\//, "")}`;
  return { base, mesh: chosen.mesh ?? chosen.name ?? "" };
}

/** Build an OTLP/HTTP `resourceLogs` payload describing one health verdict. */
export function buildOtlpLogs(
  host: string,
  health: KvmHealth,
  attributes: Record<string, unknown> = {},
  at: string = new Date().toISOString(),
): Record<string, unknown> {
  const severity = health.verdict === "fail"
    ? { text: "ERROR", number: 17 }
    : health.verdict === "warn"
    ? { text: "WARN", number: 13 }
    : { text: "INFO", number: 9 };
  const recordAttrs = [
    attr("verdict", health.verdict),
    attr("app.version", health.kvmdVersion),
    attr("device.reachable", String(health.reachable)),
    attr("findings.count", String(health.findings.length)),
  ];
  for (const f of health.findings) {
    recordAttrs.push(attr(`finding.${f.code}`, f.severity));
  }
  return {
    resourceLogs: [{
      resource: { attributes: telemetryResource(host, attributes) },
      scopeLogs: [{
        scope: { name: EXT_TYPE, version: EXT_VERSION },
        logRecords: [{
          timeUnixNano: `${BigInt(Date.parse(at)) * 1_000_000n}`,
          severityText: severity.text,
          severityNumber: severity.number,
          body: {
            stringValue: `GLKVM health ${health.verdict}: ` +
              (health.findings[0]?.message ?? "all checks passed"),
          },
          attributes: recordAttrs,
        }],
      }],
    }],
  };
}

/** Build an OTLP/HTTP `resourceMetrics` payload for one health verdict. */
export function buildOtlpMetrics(
  host: string,
  health: KvmHealth,
  attributes: Record<string, unknown> = {},
  at: string = new Date().toISOString(),
): Record<string, unknown> {
  const ts = `${BigInt(Date.parse(at)) * 1_000_000n}`;
  const gaugeInt = (name: string, value: number, unit = "1") => ({
    name,
    unit,
    gauge: { dataPoints: [{ timeUnixNano: ts, asInt: String(value) }] },
  });
  const gauges: Array<Record<string, unknown>> = [
    gaugeInt("glkvm.up", health.reachable ? 1 : 0),
    gaugeInt("glkvm.health", health.verdict === "ok" ? 1 : 0),
    gaugeInt("glkvm.virtual_media_mounted", health.msdConnected ? 1 : 0),
  ];
  if (health.updateAvailable !== null) {
    gauges.push(
      gaugeInt("glkvm.update_available", health.updateAvailable ? 1 : 0),
    );
  }
  if (health.hidOnline !== null) {
    gauges.push(gaugeInt("glkvm.hid_online", health.hidOnline ? 1 : 0));
  }
  if (health.videoOnline !== null) {
    gauges.push(gaugeInt("glkvm.hdmi_signal", health.videoOnline ? 1 : 0));
  }
  if (health.twoFactorEnabled !== null) {
    gauges.push(
      gaugeInt("glkvm.two_factor_enabled", health.twoFactorEnabled ? 1 : 0),
    );
  }
  return {
    resourceMetrics: [{
      resource: { attributes: telemetryResource(host, attributes) },
      scopeMetrics: [{
        scope: { name: EXT_TYPE, version: EXT_VERSION },
        metrics: gauges,
      }],
    }],
  };
}

/** The record payload as an object, unwrapping a data record when present. */
function recordData(record: unknown): Record<string, unknown> {
  if (typeof record !== "object" || record === null) return {};
  const obj = record as Record<string, unknown>;
  const inner = obj.attributes ?? obj.content;
  if (typeof inner === "object" && inner !== null) {
    return inner as Record<string, unknown>;
  }
  return obj;
}

/** Read the newest record written under `specName` on `modelName`. */
async function latestRecord(
  ctx: MethodContext,
  modelName: string,
  specName: string,
): Promise<Record<string, unknown>> {
  if (!ctx.readModelData) return {};
  try {
    const rows = await ctx.readModelData(modelName, specName);
    if (!rows || rows.length === 0) return {};
    const newest = rows.reduce((
      a,
      b,
    ) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a));
    return recordData(newest);
  } catch {
    return {};
  }
}

/** Coerce an unknown value to a boolean, or null when it is not one. */
function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Coerce an unknown value to a non-empty string, or "". */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reduce a raw health record to the fields `emit` reports. */
export function normalizeHealth(
  raw: Record<string, unknown>,
  fallbackHost: string,
): KvmHealth {
  const findingsRaw = Array.isArray(raw.findings) ? raw.findings : [];
  const findings: Finding[] = findingsRaw.map((f) => {
    const o = (typeof f === "object" && f !== null)
      ? f as Record<string, unknown>
      : {};
    const severity = o.severity === "fail" || o.severity === "warn"
      ? o.severity
      : "info";
    return {
      code: str(o.code),
      severity: severity as Finding["severity"],
      message: str(o.message),
    };
  });
  const msd = (typeof raw.msd === "object" && raw.msd !== null)
    ? raw.msd as Record<string, unknown>
    : {};
  return {
    host: str(raw.host) || fallbackHost,
    verdict: str(raw.verdict) || "unknown",
    reachable: raw.reachable !== false,
    kvmdVersion: str(raw.kvmdVersion),
    findings,
    checkedAt: str(raw.checkedAt),
    updateAvailable: boolOrNull(raw.updateAvailable),
    hidOnline: boolOrNull(raw.hidOnline),
    videoOnline: boolOrNull(raw.videoOnline),
    msdConnected: msd.connected === true,
    twoFactorEnabled: boolOrNull(raw.twoFactorEnabled),
  };
}

/** Resolve the OTLP base URL, resource attributes, and bearer token. */
async function resolveOtel(
  ctx: MethodContext,
  args: z.infer<typeof EmitArgsSchema>,
): Promise<{
  base: string;
  mesh: string;
  attributes: Record<string, unknown>;
  token: string;
  configured: boolean;
  reason: string;
}> {
  let endpoints: ContractEndpoint[] = [];
  let attributes: Record<string, unknown> = {};
  let defaultMesh = "";
  let authMethod = "bearer";
  let reason = "";

  if (args.otelModel) {
    const settings = await latestRecord(ctx, args.otelModel, "settings");
    if (Object.keys(settings).length > 0) {
      const raw = settings.endpoints;
      if (Array.isArray(raw)) {
        endpoints = raw as ContractEndpoint[];
      } else if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) endpoints = parsed as ContractEndpoint[];
        } catch {
          endpoints = [];
        }
      }
      attributes = (typeof settings.attributes === "object" &&
          settings.attributes !== null)
        ? (settings.attributes as Record<string, unknown>)
        : {};
      defaultMesh = str(settings.defaultMesh);
      authMethod = str(settings.authMethod) || "bearer";
    } else {
      reason = `the @svendowideit/otel-settings model '${args.otelModel}' ` +
        `has no settings data`;
    }
  } else {
    reason = "otelModel is empty";
  }

  const chosen = pickEndpoint(endpoints, {
    override: args.endpoint,
    mesh: args.mesh,
    defaultMesh,
  });
  if (!chosen.base && !reason) reason = "the contract declares no endpoints";

  let token = "";
  if (authMethod === "bearer") {
    if (args.otelVaultName && ctx.vaultService) {
      token = await ctx.vaultService
        .get(args.otelVaultName, args.otelTokenRef, `extension:${EXT_TYPE}`)
        .catch(() => "");
    }
    if (!token) token = Deno.env.get(args.otelTokenRef) ?? "";
  }

  return {
    base: chosen.base,
    mesh: chosen.mesh,
    attributes,
    token,
    configured: chosen.base !== "",
    reason,
  };
}

/** POST one OTLP/HTTP signal, returning the HTTP status or null on failure. */
async function pushOtlp(
  url: string,
  payload: Record<string, unknown>,
  token: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The added resource and method
// ---------------------------------------------------------------------------

const resources = {
  emit: {
    description: "One OTLP push of the KVM health, or why it was skipped.",
    schema: EmitSchema,
    lifetime: "30d" as const,
    garbageCollection: 30,
  },
};

const methods = [
  {
    emit: {
      description:
        "Push this KVM's health to the swamp-managed OpenTelemetry system " +
        "(one OTLP log record plus gauges). A no-op that records why, when no " +
        "otel-settings contract or endpoint is configured. Uses the latest " +
        "`health` resource unless a health record is passed in.",
      arguments: EmitArgsSchema,
      execute: async (
        args: z.infer<typeof EmitArgsSchema>,
        context: MethodContext,
      ) => {
        const instance = context.definition?.name ?? "";
        const raw = args.health !== undefined
          ? recordData({ attributes: args.health })
          : (instance ? await latestRecord(context, instance, "health") : {});
        const health = normalizeHealth(raw, context.globalArgs.host);
        const otel = await resolveOtel(context, args);

        if (!otel.configured) {
          const handle = await context.writeResource("emit", "emit", {
            host: health.host,
            skipped: true,
            reason: otel.reason || "no OTLP endpoint configured",
            endpoint: "",
            mesh: "",
            logsStatus: null,
            metricsStatus: null,
            pushed: false,
            verdict: health.verdict,
            emittedAt: new Date().toISOString(),
          });
          context.logger?.info(
            "OTLP emit skipped for {host}: {reason}",
            {
              host: health.host,
              reason: otel.reason || "no otel-settings contract",
            },
          );
          return { dataHandles: [handle] };
        }

        const logsStatus = await pushOtlp(
          `${otel.base}/v1/logs`,
          buildOtlpLogs(health.host, health, otel.attributes),
          otel.token,
          context.globalArgs.timeoutMs,
        );
        const metricsStatus = await pushOtlp(
          `${otel.base}/v1/metrics`,
          buildOtlpMetrics(health.host, health, otel.attributes),
          otel.token,
          context.globalArgs.timeoutMs,
        );
        const pushed = (logsStatus ?? 0) >= 200 && (logsStatus ?? 0) < 300 &&
          (metricsStatus ?? 0) >= 200 && (metricsStatus ?? 0) < 300;
        const handle = await context.writeResource("emit", "emit", {
          host: health.host,
          skipped: false,
          reason: "",
          endpoint: otel.base,
          mesh: otel.mesh,
          logsStatus,
          metricsStatus,
          pushed,
          verdict: health.verdict,
          emittedAt: new Date().toISOString(),
        });
        context.logger?.info(
          pushed
            ? "Emitted {host} health ({verdict}) to {endpoint}"
            : "OTLP push to {endpoint} incomplete: logs={logs} metrics={metrics}",
          {
            host: health.host,
            verdict: health.verdict,
            endpoint: otel.base,
            logs: logsStatus,
            metrics: metricsStatus,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
];

// This extension persists no configuration of its own: @sntxrr/glinet-kvm owns
// its global args, and `emit` resolves the OTLP contract per call, so there is
// nothing to detect, persist, or read back.
// meta-factory-ignore config-lifecycle setup-method-missing: no config to persist
/**
 * The `emit` method and `emit` resource added to `@sntxrr/glinet-kvm`.
 *
 * Extending the community type keeps the check and the report together: the
 * workflow drives one model (`health` then `emit`) rather than copying the OTLP
 * push into the workflow or a shell step.
 */
export const extension = {
  type: BASE_TYPE,
  resources,
  methods,
};
