/**
 * @svendowideit/host-metrics — network IO and an OTLP push for a host fleet,
 * reusing `@aaronge/host-health` for disk, load, memory and thermal.
 *
 * `@aaronge/host-health` reads the local machine's disk (`df`), load, memory
 * and thermal telemetry — but it reads no network counters and has no way to
 * *report* a host to telemetry. This model adds exactly those two missing
 * pieces, plus a way to enumerate the fleet, as three methods:
 *
 *   - `listWorkers` reads the swarm worker pool this orchestrator knows about
 *     and writes the `workers` resource — ordinary data a workflow can fan a
 *     step out over (`data.latest(...).attributes.workers`), because
 *     control-plane `swamp/worker` records are invisible to workflow
 *     `data.query`. Run it locally on the orchestrator.
 *   - `readNetwork` reads `/proc/net/dev` and writes one `network` resource
 *     with per-interface receive/transmit byte counters and the deltas since
 *     the previous `readNetwork` on the same model instance.
 *   - `emit` reads the `@aaronge/host-health` instance's latest `filesystems`,
 *     `load`, `memory` and `thermal`, plus this instance's `network`, resolves
 *     the OTLP endpoint and bearer token from the `@svendowideit/otel-settings`
 *     contract (or an explicit override), and POSTs one OTLP log record plus
 *     gauges to the collector. It also computes the change in `/` free space
 *     since the previous emit. When no collector is configured it is a no-op
 *     that records the reason, so it is always safe to leave enabled.
 *
 * This is a **standalone** type rather than an augmentation of host-health: on
 * a remote execution worker, dispatch resolves a type's methods from its own
 * bundle, and an augmentation of a pulled type is not applied there. Giving
 * each host its own instances (`host-health-<host>` for the reads, and
 * `host-metrics-<host>` for network/emit) keeps per-host data isolated.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** This extension's name (the manifest `name:`). */
export const EXT_TYPE = "@svendowideit/host-metrics";

/** This extension's own version (must match manifest.yaml `version:`). */
export const EXT_VERSION = "2026.10.17.1";

/** The community type whose disk/load/memory/thermal reads this model consumes. */
export const HEALTH_TYPE = "@aaronge/host-health";

/** Default per-host host-health model instance prefix (`<prefix><host>`). */
export const HEALTH_INSTANCE_PREFIX = "host-health-";

/** `service.name` reported to the OTel collector for a host. */
export const OTEL_SERVICE_NAME = "host-metrics";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** One network interface's byte counters and their delta since last read. */
const NetworkInterfaceSchema = z.object({
  name: z.string().describe("Interface name, e.g. eth0, wlan0, tailscale0."),
  rxBytes: z.number().describe(
    "Cumulative bytes received on this interface, from /proc/net/dev.",
  ),
  txBytes: z.number().describe(
    "Cumulative bytes transmitted on this interface, from /proc/net/dev.",
  ),
  rxBytesDelta: z.number().describe(
    "Bytes received since the previous readNetwork on this instance; 0 when " +
      "there is no previous reading.",
  ),
  txBytesDelta: z.number().describe(
    "Bytes transmitted since the previous readNetwork on this instance; 0 " +
      "when there is no previous reading.",
  ),
});

/** The `network` resource: /proc/net/dev counters and their deltas. */
const NetworkSchema = z.object({
  host: z.string().describe("Short hostname this reading was taken on."),
  interfaces: z.array(NetworkInterfaceSchema).describe(
    "One entry per interface in /proc/net/dev, including loopback.",
  ),
  totalRxBytes: z.number().describe(
    "Cumulative bytes received across all non-loopback interfaces.",
  ),
  totalTxBytes: z.number().describe(
    "Cumulative bytes transmitted across all non-loopback interfaces.",
  ),
  totalRxBytesDelta: z.number().describe(
    "Bytes received across all non-loopback interfaces since the previous " +
      "readNetwork; 0 when there is no previous reading.",
  ),
  totalTxBytesDelta: z.number().describe(
    "Bytes transmitted across all non-loopback interfaces since the previous " +
      "readNetwork; 0 when there is no previous reading.",
  ),
  capturedAt: z.string().describe("ISO-8601 timestamp of this reading."),
});

/** One worker in the pool, reduced for scheduling and attribution. */
const WorkerSchema = z.object({
  name: z.string().describe("Pool-addressable worker name (the token name)."),
  host: z.string().describe(
    "The worker's `host` label — the value used to name its per-host model " +
      "instance and to attribute its OTLP sample.",
  ),
  status: z.string().describe(
    "Worker status: idle, busy, disconnected, unverified or draining.",
  ),
  platform: z.string().describe("Worker OS, e.g. linux."),
  arch: z.string().describe("Worker architecture, e.g. x86_64, aarch64."),
  labels: z.record(z.string(), z.string()).describe(
    "Every scheduling label on the worker.",
  ),
});

/** The `workers` resource: the current worker pool, as ordinary data. */
const WorkersSchema = z.object({
  workers: z.array(WorkerSchema).describe(
    "Every worker in the pool that is not disconnected.",
  ),
  capturedAt: z.string().describe("ISO-8601 timestamp of this snapshot."),
});

/** Arguments for the added `listWorkers` method. */
const ListWorkersArgsSchema = z.object({});

/** Arguments for the added `readNetwork` method. */
const ReadNetworkArgsSchema = z.object({});

/** Arguments for the added `emit` method. */
const EmitArgsSchema = z.object({
  host: z.string().default("").describe(
    "Host name to attribute the OTLP sample to. Empty detects the local " +
      "hostname. Pass the worker's host label when the step may run on a " +
      "different worker than the one that wrote the data.",
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
  healthModel: z.string().default("").describe(
    "Name of the per-host @aaronge/host-health model instance whose " +
      "filesystems/load/memory/thermal data this emit reports. Empty derives " +
      "it from the global `healthInstancePrefix` and the host name.",
  ),
});

/** Global arguments for a `@svendowideit/host-metrics` model instance. */
const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  healthInstancePrefix: z.string().default(HEALTH_INSTANCE_PREFIX).describe(
    "Prefix used to derive the per-host @aaronge/host-health instance name " +
      "(`<prefix><host>`) when emit's `healthModel` is empty.",
  ),
  otelModel: z.string().default("otel").describe(
    "Default @svendowideit/otel-settings model for `emit`.",
  ),
  otelVaultName: z.string().default("").describe(
    "Default vault holding the OTLP gateway bearer token for `emit`.",
  ),
  otelTokenRef: z.string().default("OTEL_EXPORTER_OTLP_TOKEN").describe(
    "Default vault/environment key for the OTLP gateway bearer token.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

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
  diskAvailBytes: z.union([z.number(), z.null()]),
  diskAvailChangeBytes: z.union([z.number(), z.null()]),
  capturedAt: z.string(),
  emittedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One interface parsed from `/proc/net/dev`. */
export interface NetInterface {
  /** Interface name. */
  name: string;
  /** Cumulative received bytes. */
  rxBytes: number;
  /** Cumulative transmitted bytes. */
  txBytes: number;
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

/** The reduced view of a host-health filesystems resource. */
export interface FilesystemsView {
  /** Total bytes of the `/` mount, or null. */
  rootTotalBytes: number | null;
  /** Used bytes of the `/` mount, or null. */
  rootUsedBytes: number | null;
  /** Available bytes of the `/` mount, or null. */
  rootAvailBytes: number | null;
  /** Used percent of the `/` mount, or null. */
  rootUsedPercent: number | null;
  /** Worst used percent across non-virtual mounts, or null. */
  worstUsedPercent: number | null;
  /** When the snapshot was captured (ISO-8601), or "". */
  capturedAt: string;
}

/** The reduced view of a host-health load resource. */
export interface LoadView {
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cores: number | null;
  load5PerCore: number | null;
}

/** The reduced view of a host-health memory resource. */
export interface MemoryView {
  totalBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
}

/** The reduced view of a host-health thermal resource. */
export interface ThermalView {
  maxCelsius: number | null;
}

/** The reduced view of this extension's network resource. */
export interface NetworkView {
  totalRxBytes: number | null;
  totalTxBytes: number | null;
  totalRxBytesDelta: number | null;
  totalTxBytesDelta: number | null;
  interfaces: Array<{
    name: string;
    rxBytes: number;
    txBytes: number;
    rxBytesDelta: number;
    txBytesDelta: number;
  }>;
}

/** Everything emit needs, reduced from the per-host model instance. */
export interface HostSample {
  filesystems: FilesystemsView;
  load: LoadView;
  memory: MemoryView;
  thermal: ThermalView;
  network: NetworkView;
}

/** Structural view of the method context fields this extension uses. */
interface MethodContext {
  globalArgs: Record<string, unknown>;
  definition?: { id: string; name: string; version: string };
  logger?: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warn: (message: string, props?: Record<string, unknown>) => void;
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
  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<Array<{ attributes?: unknown; content?: unknown }>>;
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
 * Parse `/proc/net/dev`. The first two lines are headers; each remaining line
 * is `iface: rxBytes rxPackets … txBytes txPackets …` (16 counters). Returns
 * one entry per interface, in file order, skipping malformed lines.
 */
export function parseNetDev(text: string): NetInterface[] {
  const out: NetInterface[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    const fields = m[2].trim().split(/\s+/).filter((s) => s.length > 0);
    if (fields.length < 9) continue;
    const rxBytes = Number(fields[0]);
    const txBytes = Number(fields[8]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    out.push({ name, rxBytes, txBytes });
  }
  return out;
}

/** Loopback interfaces are excluded from the totals but kept per-interface. */
export function isLoopback(name: string): boolean {
  return name === "lo" || name.startsWith("lo:");
}

/** Sum the counters of every non-loopback interface. */
export function sumNonLoopback(
  interfaces: NetInterface[],
  pick: (i: NetInterface) => number,
): number {
  return interfaces
    .filter((i) => !isLoopback(i.name))
    .reduce((acc, i) => acc + pick(i), 0);
}

/**
 * Build the `network` resource from a current and previous reading. Deltas are
 * 0 when there is no previous reading, or when a counter went backwards
 * (a reset — the delta is treated as unavailable rather than negative).
 */
export function buildNetwork(
  host: string,
  current: NetInterface[],
  previous: NetInterface[],
  capturedAt: string,
): z.infer<typeof NetworkSchema> {
  const prev = new Map(previous.map((i) => [i.name, i]));
  const interfaces = current.map((i) => {
    const p = prev.get(i.name);
    return {
      name: i.name,
      rxBytes: i.rxBytes,
      txBytes: i.txBytes,
      rxBytesDelta: p && i.rxBytes >= p.rxBytes ? i.rxBytes - p.rxBytes : 0,
      txBytesDelta: p && i.txBytes >= p.txBytes ? i.txBytes - p.txBytes : 0,
    };
  });
  const curTotalRx = sumNonLoopback(current, (i) => i.rxBytes);
  const curTotalTx = sumNonLoopback(current, (i) => i.txBytes);
  const prevTotalRx = sumNonLoopback(previous, (i) => i.rxBytes);
  const prevTotalTx = sumNonLoopback(previous, (i) => i.txBytes);
  const hadPrev = previous.length > 0;
  return {
    host,
    interfaces,
    totalRxBytes: curTotalRx,
    totalTxBytes: curTotalTx,
    totalRxBytesDelta: hadPrev && curTotalRx >= prevTotalRx
      ? curTotalRx - prevTotalRx
      : 0,
    totalTxBytesDelta: hadPrev && curTotalTx >= prevTotalTx
      ? curTotalTx - prevTotalTx
      : 0,
    capturedAt,
  };
}

/** Extract the `/` mount's byte figures from a filesystems record. */
export function reduceFilesystems(
  raw: Record<string, unknown>,
): FilesystemsView {
  const mounts = Array.isArray(raw.mounts) ? raw.mounts : [];
  const root = mounts.find((m) =>
    typeof m === "object" && m !== null &&
    (m as Record<string, unknown>).mountpoint === "/"
  ) as Record<string, unknown> | undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    rootTotalBytes: root ? num(root.totalBytes) : null,
    rootUsedBytes: root ? num(root.usedBytes) : null,
    rootAvailBytes: root ? num(root.availBytes) : null,
    rootUsedPercent: num(raw.rootUsedPercent),
    worstUsedPercent: num(raw.worstUsedPercent),
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : "",
  };
}

/** Choose the OTLP/HTTP endpoint from a settings contract. */
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

/** Build an OTLP/HTTP `resourceMetrics` payload for one host sample. */
export function buildOtlpMetrics(
  host: string,
  sample: HostSample,
  attributes: Record<string, unknown> = {},
  at: string = new Date().toISOString(),
  diskAvailChangeBytes: number | null = null,
): Record<string, unknown> {
  const ts = `${BigInt(Date.parse(at)) * 1_000_000n}`;
  const gauge = (
    name: string,
    value: number,
    unit = "1",
    extraAttrs: Array<{ key: string; value: { stringValue: string } }> = [],
  ) => ({
    name,
    unit,
    gauge: {
      dataPoints: [{
        timeUnixNano: ts,
        asDouble: value,
        ...(extraAttrs.length > 0 ? { attributes: extraAttrs } : {}),
      }],
    },
  });

  const metrics: Array<Record<string, unknown>> = [];
  const fs = sample.filesystems;
  if (fs.rootTotalBytes !== null) {
    metrics.push(gauge("host.filesystem.total_bytes", fs.rootTotalBytes, "By"));
  }
  if (fs.rootUsedBytes !== null) {
    metrics.push(gauge("host.filesystem.used_bytes", fs.rootUsedBytes, "By"));
  }
  if (fs.rootAvailBytes !== null) {
    metrics.push(gauge("host.filesystem.avail_bytes", fs.rootAvailBytes, "By"));
  }
  if (diskAvailChangeBytes !== null) {
    metrics.push(
      gauge("host.filesystem.avail_change_bytes", diskAvailChangeBytes, "By"),
    );
  }
  if (fs.rootUsedPercent !== null) {
    metrics.push(
      gauge("host.filesystem.used_percent", fs.rootUsedPercent, "%"),
    );
  }
  if (fs.worstUsedPercent !== null) {
    metrics.push(
      gauge("host.filesystem.worst_used_percent", fs.worstUsedPercent, "%"),
    );
  }

  const load = sample.load;
  for (
    const [name, value] of [
      ["host.load.1m", load.load1],
      ["host.load.5m", load.load5],
      ["host.load.15m", load.load15],
      ["host.load.5m_per_core", load.load5PerCore],
    ] as const
  ) {
    if (value !== null) metrics.push(gauge(name, value));
  }

  const mem = sample.memory;
  if (mem.totalBytes !== null) {
    metrics.push(gauge("host.memory.total_bytes", mem.totalBytes, "By"));
  }
  if (mem.availableBytes !== null) {
    metrics.push(
      gauge("host.memory.available_bytes", mem.availableBytes, "By"),
    );
  }
  if (mem.usedPercent !== null) {
    metrics.push(gauge("host.memory.used_percent", mem.usedPercent, "%"));
  }

  if (sample.thermal.maxCelsius !== null) {
    metrics.push(
      gauge("host.thermal.max_celsius", sample.thermal.maxCelsius, "Cel"),
    );
  }

  const net = sample.network;
  if (net.totalRxBytes !== null) {
    metrics.push(
      gauge("host.network.rx_bytes_total", net.totalRxBytes, "By"),
    );
  }
  if (net.totalTxBytes !== null) {
    metrics.push(
      gauge("host.network.tx_bytes_total", net.totalTxBytes, "By"),
    );
  }
  if (net.totalRxBytesDelta !== null) {
    metrics.push(
      gauge("host.network.rx_bytes_interval", net.totalRxBytesDelta, "By"),
    );
  }
  if (net.totalTxBytesDelta !== null) {
    metrics.push(
      gauge("host.network.tx_bytes_interval", net.totalTxBytesDelta, "By"),
    );
  }
  for (const iface of net.interfaces) {
    const ifAttr = [attr("network.interface", iface.name)];
    metrics.push(
      gauge("host.network.rx_bytes", iface.rxBytes, "By", ifAttr),
      gauge("host.network.tx_bytes", iface.txBytes, "By", ifAttr),
      gauge("host.network.rx_bytes_interval", iface.rxBytesDelta, "By", ifAttr),
      gauge("host.network.tx_bytes_interval", iface.txBytesDelta, "By", ifAttr),
    );
  }

  return {
    resourceMetrics: [{
      resource: { attributes: telemetryResource(host, attributes) },
      scopeMetrics: [{
        scope: { name: EXT_TYPE, version: EXT_VERSION },
        metrics,
      }],
    }],
  };
}

/** Build an OTLP/HTTP `resourceLogs` payload summarising one host sample. */
export function buildOtlpLogs(
  host: string,
  sample: HostSample,
  attributes: Record<string, unknown> = {},
  at: string = new Date().toISOString(),
  change: number | null = null,
): Record<string, unknown> {
  const fs = sample.filesystems;
  const parts = [
    fs.rootAvailBytes !== null
      ? `/: ${fs.rootAvailBytes} bytes free` +
        (change !== null ? ` (Δ${change >= 0 ? "+" : ""}${change})` : "")
      : "/: unknown",
    sample.load.load5 !== null ? `load5 ${sample.load.load5}` : "",
    sample.memory.usedPercent !== null
      ? `mem ${sample.memory.usedPercent}%`
      : "",
    sample.network.totalRxBytesDelta !== null
      ? `net Δrx ${sample.network.totalRxBytesDelta} Δtx ${
        sample.network.totalTxBytesDelta ?? 0
      }`
      : "",
  ].filter((s) => s.length > 0);
  return {
    resourceLogs: [{
      resource: { attributes: telemetryResource(host, attributes) },
      scopeLogs: [{
        scope: { name: EXT_TYPE, version: EXT_VERSION },
        logRecords: [{
          timeUnixNano: `${BigInt(Date.parse(at)) * 1_000_000n}`,
          severityText: "INFO",
          severityNumber: 9,
          body: { stringValue: `host-metrics ${host}: ${parts.join(", ")}` },
          attributes: [
            attr("host.name", host),
            ...(fs.rootAvailBytes !== null
              ? [attr("filesystem.avail_bytes", String(fs.rootAvailBytes))]
              : []),
            ...(change !== null
              ? [attr("filesystem.avail_change_bytes", String(change))]
              : []),
          ],
        }],
      }],
    }],
  };
}

/** The OTLP resource attribute list: service identity + contract attributes. */
export function telemetryResource(
  host: string,
  attributes: Record<string, unknown> = {},
): Array<{ key: string; value: { stringValue: string } }> {
  const out = [
    attr("service.name", OTEL_SERVICE_NAME),
    attr("service.version", EXT_VERSION),
    attr("host.name", host),
  ];
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null || v === "") continue;
    out.push(attr(k, String(v)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

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

/** Every version of `specName` on `modelName`, newest first. */
async function versionsOf(
  ctx: MethodContext,
  modelName: string,
  specName: string,
): Promise<Array<Record<string, unknown>>> {
  if (!ctx.readModelData || !modelName) return [];
  try {
    const rows = await ctx.readModelData(modelName, specName);
    return (rows ?? [])
      .slice()
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
      .map((r) => recordData(r));
  } catch {
    return [];
  }
}

/** The newest record under `specName`, or {}. */
async function latestRecord(
  ctx: MethodContext,
  modelName: string,
  specName: string,
): Promise<Record<string, unknown>> {
  const rows = await versionsOf(ctx, modelName, specName);
  return rows[0] ?? {};
}

/** The host's short name, read locally; "" when undetectable. */
async function detectHost(): Promise<string> {
  for (const args of [["-s"], []]) {
    try {
      // swamp-quality-ignore deno-command
      const out = await new Deno.Command("hostname", {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output();
      if (out.success) {
        const v = new TextDecoder().decode(out.stdout).trim();
        if (v) return v;
      }
    } catch {
      // try the next form
    }
  }
  try {
    return Deno.env.get("HOSTNAME") ?? "";
  } catch {
    return "";
  }
}

/**
 * Read this host's /proc/net/dev and reduce it to interface counters.
 *
 * Reads through `cat` rather than `Deno.readTextFile`: swamp's method sandbox
 * denies direct `/proc` reads (`NotCapable`), the same limitation
 * `@aaronge/host-health` works around with a `cat` subprocess.
 */
export async function readNetInterfaces(): Promise<NetInterface[]> {
  try {
    // swamp-quality-ignore deno-command
    const out = await new Deno.Command("cat", {
      args: ["/proc/net/dev"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return [];
    return parseNetDev(new TextDecoder().decode(out.stdout));
  } catch {
    return [];
  }
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
      defaultMesh = typeof settings.defaultMesh === "string"
        ? settings.defaultMesh
        : "";
      authMethod = typeof settings.authMethod === "string"
        ? settings.authMethod
        : "bearer";
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
    preferUrl: true,
  });
  if (!chosen.base && !reason) reason = "the contract declares no endpoints";

  let token = "";
  if (authMethod === "bearer") {
    if (args.otelVaultName && ctx.vaultService) {
      token = await ctx.vaultService
        .get(args.otelVaultName, args.otelTokenRef, `extension:${EXT_TYPE}`)
        .catch(() => "");
    }
    if (!token) {
      try {
        token = Deno.env.get(args.otelTokenRef) ?? "";
      } catch {
        token = "";
      }
    }
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

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Reduce a host's latest resources to a HostSample.
 *
 * Disk/load/memory/thermal come from `healthModel` (a `@aaronge/host-health`
 * instance); the network counters come from this model's own `instance`.
 */
export async function collectSample(
  ctx: MethodContext,
  instance: string,
  healthModel: string,
): Promise<HostSample> {
  const [fsRows, loadRaw, memRaw, thermalRaw, netRows] = await Promise.all([
    versionsOf(ctx, healthModel, "filesystems"),
    latestRecord(ctx, healthModel, "load"),
    latestRecord(ctx, healthModel, "memory"),
    latestRecord(ctx, healthModel, "thermal"),
    versionsOf(ctx, instance, "network"),
  ]);
  const fs = reduceFilesystems(fsRows[0] ?? {});
  const net = netRows[0] ?? {};
  const netInterfaces = Array.isArray(net.interfaces) ? net.interfaces : [];
  return {
    filesystems: fs,
    load: {
      load1: numOrNull(loadRaw.load1),
      load5: numOrNull(loadRaw.load5),
      load15: numOrNull(loadRaw.load15),
      cores: numOrNull(loadRaw.cores),
      load5PerCore: numOrNull(loadRaw.load5PerCore),
    },
    memory: {
      totalBytes: numOrNull(memRaw.totalBytes),
      availableBytes: numOrNull(memRaw.availableBytes),
      usedPercent: numOrNull(memRaw.usedPercent),
    },
    thermal: { maxCelsius: numOrNull(thermalRaw.maxCelsius) },
    network: {
      totalRxBytes: numOrNull(net.totalRxBytes),
      totalTxBytes: numOrNull(net.totalTxBytes),
      totalRxBytesDelta: numOrNull(net.totalRxBytesDelta),
      totalTxBytesDelta: numOrNull(net.totalTxBytesDelta),
      interfaces: netInterfaces.map((i) => {
        const o = i as Record<string, unknown>;
        return {
          name: typeof o.name === "string" ? o.name : "",
          rxBytes: numOrNull(o.rxBytes) ?? 0,
          txBytes: numOrNull(o.txBytes) ?? 0,
          rxBytesDelta: numOrNull(o.rxBytesDelta) ?? 0,
          txBytesDelta: numOrNull(o.txBytesDelta) ?? 0,
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// The added resources and methods
// ---------------------------------------------------------------------------

const resources = {
  workers: {
    description:
      "The current swamp worker pool as ordinary data, so a workflow can " +
      "fan a step out over every connected worker with `data.latest`.",
    schema: WorkersSchema,
    lifetime: "30d" as const,
    garbageCollection: 2880,
  },
  network: {
    description:
      "Per-interface /proc/net/dev byte counters and their deltas since the " +
      "previous readNetwork on this instance.",
    schema: NetworkSchema,
    lifetime: "30d" as const,
    garbageCollection: 2880,
  },
  emit: {
    description: "One OTLP push of this host's sample, or why it was skipped.",
    schema: EmitSchema,
    lifetime: "30d" as const,
    garbageCollection: 2880,
  },
};

const methods = {
  listWorkers: {
    description:
      "Read the swarm worker pool this orchestrator knows about and write " +
      "the `workers` resource: one entry per non-disconnected worker with " +
      "its host label, status, platform and arch. Gives a workflow an " +
      "ordinary-data handle on the pool, because control-plane " +
      "`swamp/worker` records are not visible to workflow `data.query`. " +
      "Run this locally on the orchestrator.",
    arguments: ListWorkersArgsSchema,
    execute: async (
      _args: z.infer<typeof ListWorkersArgsSchema>,
      context: MethodContext,
    ) => {
      const capturedAt = new Date().toISOString();
      let workers: z.infer<typeof WorkerSchema>[] = [];
      if (context.queryData) {
        try {
          const records = await context.queryData(
            'modelType == "swamp/worker"',
          );
          workers = (records ?? []).map((rec) => {
            const a = recordData(rec);
            const labels = (typeof a.labels === "object" && a.labels !== null)
              ? a.labels as Record<string, string>
              : {};
            return {
              name: String(a.name ?? ""),
              host: String(labels.host ?? a.name ?? ""),
              status: String(a.status ?? ""),
              platform: String(a.platform ?? ""),
              arch: String(a.arch ?? ""),
              labels,
            };
          }).filter((w) => w.host !== "" && w.status !== "disconnected");
        } catch (e) {
          context.logger?.warn(
            "Could not query the worker pool: {error}",
            { error: e instanceof Error ? e.message : String(e) },
          );
        }
      }
      const handle = await context.writeResource("workers", "workers", {
        workers,
        capturedAt,
      });
      context.logger?.info(
        "Listed {count} connected worker(s)",
        { count: workers.length },
      );
      return { dataHandles: [handle] };
    },
  },
  readNetwork: {
    description:
      "Read /proc/net/dev and write the `network` resource: per-interface " +
      "receive/transmit byte counters plus the deltas since the previous " +
      "readNetwork on this instance.",
    arguments: ReadNetworkArgsSchema,
    execute: async (
      _args: z.infer<typeof ReadNetworkArgsSchema>,
      context: MethodContext,
    ) => {
      const instance = context.definition?.name ?? "";
      const host = await detectHost();
      const capturedAt = new Date().toISOString();
      const current = await readNetInterfaces();
      const previousRaw = await latestRecord(context, instance, "network");
      const previous = Array.isArray(previousRaw.interfaces)
        ? previousRaw.interfaces.map((i) => {
          const o = i as Record<string, unknown>;
          return {
            name: typeof o.name === "string" ? o.name : "",
            rxBytes: numOrNull(o.rxBytes) ?? 0,
            txBytes: numOrNull(o.txBytes) ?? 0,
          };
        })
        : [];
      const record = buildNetwork(host, current, previous, capturedAt);
      const handle = await context.writeResource(
        "network",
        "network",
        record,
      );
      context.logger?.info(
        "Read {count} interface(s); Δrx {rx} Δtx {tx} bytes",
        {
          count: record.interfaces.length,
          rx: record.totalRxBytesDelta,
          tx: record.totalTxBytesDelta,
        },
      );
      return { dataHandles: [handle] };
    },
  },
  emit: {
    description:
      "Push this host's latest filesystems/load/memory/thermal/network " +
      "sample to the swamp-managed OpenTelemetry system (one OTLP log " +
      "record plus gauges), including the change in `/` free space since " +
      "the previous snapshot. A no-op that records why, when no " +
      "otel-settings contract or endpoint is configured.",
    arguments: EmitArgsSchema,
    execute: async (
      args: z.infer<typeof EmitArgsSchema>,
      context: MethodContext,
    ) => {
      const instance = context.definition?.name ?? "";
      const host = args.host.trim() || await detectHost();
      const prefix =
        (context.globalArgs as Partial<GlobalArgs>).healthInstancePrefix ??
          HEALTH_INSTANCE_PREFIX;
      const healthModel = args.healthModel.trim() || `${prefix}${host}`;
      const sample = await collectSample(context, instance, healthModel);
      const otel = await resolveOtel(context, args);
      const at = new Date().toISOString();

      // The previous cycle's emit record holds the last / free-space figure;
      // readFilesystems has already overwritten its own resource, so the
      // delta is measured against emit's own history (one emit per cycle).
      const prevEmit = await latestRecord(context, instance, "emit");
      const prevAvail = numOrNull(prevEmit.diskAvailBytes);
      const change = sample.filesystems.rootAvailBytes !== null &&
          prevAvail !== null
        ? sample.filesystems.rootAvailBytes - prevAvail
        : null;

      if (!otel.configured) {
        const handle = await context.writeResource("emit", "emit", {
          host,
          skipped: true,
          reason: otel.reason || "no OTLP endpoint configured",
          endpoint: "",
          mesh: "",
          logsStatus: null,
          metricsStatus: null,
          pushed: false,
          diskAvailBytes: sample.filesystems.rootAvailBytes,
          diskAvailChangeBytes: change,
          capturedAt: sample.filesystems.capturedAt,
          emittedAt: at,
        });
        context.logger?.info(
          "OTLP emit skipped for {host}: {reason}",
          { host, reason: otel.reason || "no otel-settings contract" },
        );
        return { dataHandles: [handle] };
      }

      const timeoutMs = 10000;
      const logsStatus = await pushOtlp(
        `${otel.base}/v1/logs`,
        buildOtlpLogs(host, sample, otel.attributes, at, change),
        otel.token,
        timeoutMs,
      );
      const metricsStatus = await pushOtlp(
        `${otel.base}/v1/metrics`,
        buildOtlpMetrics(host, sample, otel.attributes, at, change),
        otel.token,
        timeoutMs,
      );
      const pushed = (logsStatus ?? 0) >= 200 && (logsStatus ?? 0) < 300 &&
        (metricsStatus ?? 0) >= 200 && (metricsStatus ?? 0) < 300;
      const handle = await context.writeResource("emit", "emit", {
        host,
        skipped: false,
        reason: "",
        endpoint: otel.base,
        mesh: otel.mesh,
        logsStatus,
        metricsStatus,
        pushed,
        diskAvailBytes: sample.filesystems.rootAvailBytes,
        diskAvailChangeBytes: change,
        capturedAt: sample.filesystems.capturedAt,
        emittedAt: at,
      });
      context.logger?.info(
        pushed
          ? "Emitted {host} sample to {endpoint}"
          : "OTLP push to {endpoint} incomplete: logs={logs} metrics={metrics}",
        { host, endpoint: otel.base, logs: logsStatus, metrics: metricsStatus },
      );
      return { dataHandles: [handle] };
    },
  },
};

/**
 * `@svendowideit/host-metrics` — a host-metrics model that consumes
 * `@aaronge/host-health`'s disk/load/memory/thermal reads and adds network IO
 * and an OTLP push.
 *
 * A standalone type (not an augmentation of host-health) so its methods load
 * on remote execution workers: worker dispatch resolves a type's methods from
 * its own bundle, and an augmentation of a pulled type is not applied there.
 * It reads the per-host host-health instance by name instead.
 */
export const model = {
  type: "@svendowideit/host-metrics",
  version: "2026.10.17.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: EXT_VERSION,
      description:
        "Initial release: `listWorkers` materialises the worker pool as " +
        "ordinary data; `readNetwork` reads /proc/net/dev with deltas; `emit` " +
        "pushes the per-host sample (disk/load/memory/thermal from " +
        "@aaronge/host-health, network from this model) to the OTLP gateway " +
        "via the @svendowideit/otel-settings contract, including the change " +
        "in / free space since the previous emit.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources,
  methods,
};
