/**
 * @svendowideit/otel-gateway
 *
 * The central OpenTelemetry Collector gateway: a single OTLP endpoint the whole
 * fleet pushes to, which fans out to one or more backend exporters.
 *
 * The gateway is the seam that makes the backend swappable — agents only ever
 * point at the gateway, so changing the store is a gateway re-render, not a
 * fleet-wide re-instrumentation. It is deliberately backend-agnostic: a
 * *receiver* set (OTLP gRPC/HTTP) and an *exporter* set (one per backend lane,
 * each with an OTLP/HTTP endpoint and an authorization key). Adding a lane is
 * one more exporter, enabling dual-write for a migration.
 *
 * The collector config is rendered from those structured inputs and is a pure
 * function, so it is unit-tested without touching the host. The model downloads
 * the `otelcol-contrib` release (for the receivers/exporters it needs), writes
 * the config, installs a systemd user service, and verifies the collector's own
 * health/metrics endpoint. Backend credentials are read from a swamp vault and
 * written to a `0600` environment file — the same pattern `@svendowideit/caddy`
 * uses, because the collector reads env vars at runtime and cannot call a vault.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const HeaderSchema = z.object({
  name: z.string().min(1).describe(
    "Header name, e.g. Authorization or organization",
  ),
  value: z.string().default("").describe(
    "Literal header value; empty means the value comes from the environment via valueEnv",
  ),
  valueEnv: z.string().default("").describe(
    "Environment variable name holding the header value (written from the vault); wins when set",
  ),
}).strict();

const ExporterSchema = z.object({
  name: z.string().min(1).describe(
    "Exporter name/stream, e.g. openobserve or lgtm (also the OTLP stream-name default)",
  ),
  endpoint: z.string().min(1).describe(
    "OTLP/HTTP base endpoint of the backend, WITHOUT a trailing slash (the collector appends /v1/{logs,metrics,traces})",
  ),
  headers: z.array(HeaderSchema).default([]).describe(
    "Headers sent with every export (auth, organization, stream-name)",
  ),
  basicAuth: z.object({
    emailEnv: z.string().min(1).describe(
      "Vault key holding the login email (e.g. ZO_ROOT_USER_EMAIL)",
    ),
    authEnv: z.string().min(1).describe(
      "Vault key holding the login password (e.g. ZO_ROOT_USER_PASSWORD)",
    ),
  }).optional().describe(
    "Build a Basic Authorization header from two vault keys; a convenience over a pre-encoded valueEnv header",
  ),
  insecure: z.boolean().default(false).describe(
    "Skip TLS verification / use plaintext for the exporter",
  ),
  signals: z.array(z.enum(["logs", "metrics", "traces"])).default([
    "logs",
    "metrics",
    "traces",
  ]).describe("Which signals this exporter carries"),
  enabled: z.boolean().default(true).describe(
    "Disable to keep the exporter configured but not in a pipeline (e.g. dual-write staging)",
  ),
}).strict();

const GlobalArgsSchema = z.object({
  version: z.string().default("").describe(
    "otelcol-contrib version to install (e.g. 0.162.0); empty resolves the latest release",
  ),
  installDir: z.string().default("~/.local/share/otel-gateway").describe(
    "Directory the otelcol-contrib binary and config are installed into",
  ),
  binaryPath: z.string().default("").describe(
    "Exact path to the otelcol-contrib binary; empty derives <installDir>/otelcol-contrib",
  ),
  configPath: z.string().default("").describe(
    "Exact path to the rendered config; empty derives <installDir>/config.yaml",
  ),
  serviceName: z.string().default("otel-gateway").describe(
    "systemd user service name for the gateway",
  ),
  grpcPort: z.number().int().min(1).max(65535).default(4317).describe(
    "OTLP/gRPC receiver port agents push to",
  ),
  httpPort: z.number().int().min(1).max(65535).default(4318).describe(
    "OTLP/HTTP receiver port agents push to",
  ),
  healthPort: z.number().int().min(1).max(65535).default(13133).describe(
    "Collector health_check extension port, used to verify the gateway",
  ),
  metricsPort: z.number().int().min(1).max(65535).default(8888).describe(
    "Collector's own prometheus metrics port",
  ),
  bindAddress: z.string().default("127.0.0.1").describe(
    "Address the receivers bind to (127.0.0.1 is local-only; set a mesh address to accept the fleet)",
  ),
  exporters: z.array(ExporterSchema).default([]).describe(
    "Backend exporters; the gateway fans every enabled exporter into each signal pipeline",
  ),
  vaultName: z.string().default("").describe(
    "Vault holding credential values referenced by exporter header valueEnv names",
  ),
  environmentFile: z.string().default("").describe(
    "Path to the env file written with vault-sourced values (mode 0600); empty derives <installDir>/gateway.env",
  ),
  samplingHeadPercent: z.number().min(0).max(100).default(100).describe(
    "Head sampling percentage applied to traces",
  ),
  memoryLimitMiB: z.number().int().positive().default(512).describe(
    "Soft memory limit for the collector (applied via GOMEMLIMIT)",
  ),
  githubToken: z.string().default("").meta({ sensitive: true }).describe(
    "GitHub token to raise the release API rate limit; empty falls back to GITHUB_TOKEN/GH_TOKEN",
  ),
  healthTimeoutMs: z.number().int().positive().default(30000).describe(
    "How long to wait for the gateway to answer healthy after start",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstallArgsSchema = z.object({});
const ConfigureArgsSchema = z.object({});
const StatusArgsSchema = z.object({});
const VerifyArgsSchema = z.object({
  marker: z.string().default("").describe(
    "Marker recorded in the synthetic record's body (defaults to a timestamped value)",
  ),
  waitMs: z.number().int().min(0).default(0).describe(
    "Milliseconds to wait before checking, for a backend that batches",
  ),
}).describe("No arguments");
const RemoveArgsSchema = z.object({
  removeInstallDir: z.boolean().default(false).describe(
    "Also delete the install directory (binary, config, env file)",
  ),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const ReceiverEndpointsSchema = z.object({
  otlpGrpc: z.string(),
  otlpHttp: z.string(),
  health: z.string(),
  metrics: z.string(),
});

const InstallOutputSchema = z.object({
  version: z.string(),
  binaryPath: z.string(),
  configPath: z.string(),
  environmentFile: z.string(),
  serviceName: z.string(),
  endpoints: ReceiverEndpointsSchema,
  exporters: z.array(z.string()),
  healthy: z.boolean(),
  installedAt: z.string(),
});

const StatusOutputSchema = z.object({
  version: z.string(),
  serviceName: z.string(),
  serviceState: z.string(),
  running: z.boolean(),
  healthy: z.boolean(),
  healthStatusCode: z.number().int(),
  endpoints: ReceiverEndpointsSchema,
  exporters: z.array(
    z.object({
      name: z.string(),
      endpoint: z.string(),
      signals: z.array(z.string()),
      enabled: z.boolean(),
    }),
  ),
  checkedAt: z.string(),
});

const RemoveOutputSchema = z.object({
  serviceName: z.string(),
  removed: z.boolean(),
  installDirRemoved: z.boolean(),
  removedAt: z.string(),
});

const VerifyOutputSchema = z.object({
  marker: z.string(),
  pushed: z.boolean(),
  pushStatusCode: z.number().int(),
  serviceName: z.string(),
  endpoints: ReceiverEndpointsSchema,
  verifiedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers — config rendering
// ---------------------------------------------------------------------------

/** A resolved exporter: header values substituted from the environment. */
export interface ResolvedExporter {
  /** Exporter name (also the stream name and the `otlphttp/<name>` key). */
  name: string;
  /** OTLP/HTTP base endpoint, no trailing slash. */
  endpoint: string;
  /** Headers to send; secrets are `${env:NAME}` references. */
  headers: { name: string; value: string }[];
  /** Whether to skip TLS for this exporter. */
  insecure: boolean;
  /** Signals this exporter carries. */
  signals: string[];
  /** Whether it is in the pipelines. */
  enabled: boolean;
}

const SIGNAL_PLURALS = ["logs", "metrics", "traces"] as const;

/** Render the full otelcol-contrib config from structured inputs. */
export function renderGatewayConfig(args: {
  grpcPort: number;
  httpPort: number;
  healthPort: number;
  metricsPort: number;
  bindAddress: string;
  exporters: ResolvedExporter[];
  samplingHeadPercent: number;
  memoryLimitMiB: number;
}): string {
  const enabled = args.exporters.filter((e) => e.enabled);
  if (enabled.length === 0) {
    throw new Error("at least one enabled exporter is required");
  }
  const lines: string[] = [];
  lines.push("# Rendered by @svendowideit/otel-gateway — do not edit by hand.");
  lines.push("receivers:");
  lines.push("  otlp:");
  lines.push("    protocols:");
  lines.push("      grpc:");
  lines.push(`        endpoint: ${args.bindAddress}:${args.grpcPort}`);
  lines.push("      http:");
  lines.push(`        endpoint: ${args.bindAddress}:${args.httpPort}`);
  lines.push("");
  lines.push("processors:");
  if (args.samplingHeadPercent < 100) {
    lines.push("  probabilistic_sampler:");
    lines.push(`    sampling_percentage: ${args.samplingHeadPercent}`);
  }
  lines.push("  memory_limiter:");
  lines.push(`    limit_mib: ${args.memoryLimitMiB}`);
  lines.push("    check_interval: 5s");
  lines.push("  batch: {}");
  lines.push("");
  lines.push("exporters:");
  for (const ex of enabled) {
    lines.push(`  otlphttp/${ex.name}:`);
    lines.push(`    endpoint: ${ex.endpoint}`);
    if (ex.insecure) {
      lines.push("    tls:");
      lines.push("      insecure: true");
    }
    if (ex.headers.length > 0) {
      lines.push("    headers:");
      for (const h of ex.headers) {
        // ${env:VAR} is substituted by the collector at startup from the env
        // file — so the secret never appears in this rendered config.
        lines.push(`      ${quoteYamlKey(h.name)}: ${h.value}`);
      }
    }
  }
  lines.push("");
  lines.push("extensions:");
  lines.push("  health_check:");
  lines.push(`    endpoint: ${args.bindAddress}:${args.healthPort}`);
  lines.push("");
  lines.push("service:");
  lines.push("  extensions: [health_check]");
  const processors = args.samplingHeadPercent < 100
    ? "[memory_limiter, probabilistic_sampler, batch]"
    : "[memory_limiter, batch]";
  lines.push("  pipelines:");
  for (const signal of SIGNAL_PLURALS) {
    const carrying = enabled.filter((e) => e.signals.includes(signal));
    if (carrying.length === 0) continue;
    lines.push(`    ${signal}:`);
    lines.push("      receivers: [otlp]");
    lines.push(`      processors: ${processors}`);
    lines.push(
      `      exporters: [${
        carrying.map((e) => `otlphttp/${e.name}`).join(", ")
      }]`,
    );
  }
  // The collector's own self-telemetry, exposed as a Prometheus scrape target.
  // Current otelcol uses `readers` here; the old `address` key was removed.
  lines.push("  telemetry:");
  lines.push("    metrics:");
  lines.push("      readers:");
  lines.push("        - pull:");
  lines.push("            exporter:");
  lines.push("              prometheus:");
  lines.push(`                host: ${args.bindAddress}`);
  lines.push(`                port: ${args.metricsPort}`);
  lines.push("");
  return lines.join("\n");
}

/** Quote a YAML key when it contains characters YAML would otherwise parse. */
export function quoteYamlKey(key: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Substitute `${env:NAME}` in an exporter config with the literal form the
 * collector understands, given a map of resolved values.
 *
 * The rendered config keeps `${env:NAME}` (never a secret); this is used to
 * compute which env var names must be present in the environment file.
 */
export function envNamesFor(exporters: ResolvedExporter[]): string[] {
  const names = new Set<string>();
  for (const ex of exporters) {
    for (const h of ex.headers) {
      const match = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/.exec(h.value);
      if (match) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** Whether header values reference `${env:…}` (secrets stay out of the config). */
export function isEnvRef(value: string): boolean {
  return /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

/** A systemd-safe service name check. */
export function isSafeServiceName(name: string): boolean {
  return /^[A-Za-z0-9_.@-]+$/.test(name) && !name.startsWith(".") &&
    name.length <= 255;
}

// ---------------------------------------------------------------------------
// Pure helpers — release asset selection (otelcol-contrib)
// ---------------------------------------------------------------------------

/** Map `uname -m` to the release architecture token used by otelcol assets. */
export function releaseArchToken(unameM: string): string {
  const m = unameM.trim().toLowerCase();
  if (["x86_64", "amd64"].includes(m)) return "amd64";
  if (["aarch64", "arm64"].includes(m)) return "arm64";
  if (["armv7l", "armv7", "armhf"].includes(m)) return "armv7";
  if (["i386", "i686"].includes(m)) return "386";
  if (m === "ppc64le") return "ppc64le";
  if (m === "s390x") return "s390x";
  return m;
}

/** The otelcol-contrib release asset name for a platform. */
export function contribAssetName(version: string, archToken: string): string {
  const v = version.replace(/^v/, "");
  return `otelcol-contrib_${v}_linux_${archToken}.tar.gz`;
}

/** GitHub release download URL for an otelcol-contrib asset. */
export function contribDownloadUrl(version: string, assetName: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/${tag}/${assetName}`;
}

/** Parse a `checksums.txt` body into name→sha256. */
export function parseChecksums(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match) out[match[2]] = match[1].toLowerCase();
  }
  return out;
}

/**
 * The URL of the per-asset `.sha256` file. The otelcol-contrib release does not
 * publish a combined `checksums.txt`; each archive has a sibling `.sha256`
 * asset whose body is the bare hex digest.
 */
export function sha256UrlFor(version: string, assetName: string): string {
  return `${contribDownloadUrl(version, assetName)}.sha256`;
}

/** Parse a bare-sha256 file body (the first 64-hex substring), or "". */
export function parseSha256(body: string): string {
  const match = /[0-9a-fA-F]{64}/.exec(body);
  return match ? match[0].toLowerCase() : "";
}

/** Render a systemd unit for the collector. */
export function renderGatewayUnit(args: {
  version: string;
  binaryPath: string;
  configPath: string;
  environmentFile: string;
}): string {
  return [
    "[Unit]",
    `Description=OpenTelemetry Collector gateway${
      args.version ? ` (${args.version})` : ""
    }`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `EnvironmentFile=-${args.environmentFile}`,
    `ExecStart=${args.binaryPath} --config ${args.configPath}`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=10",
    "KillSignal=SIGTERM",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Pick the otelcol-contrib asset and URL for the host, from a release body list. */
export function selectContribAsset(args: {
  version: string;
  unameM: string;
  assetNames: string[];
}): { assetName: string; downloadUrl: string } {
  const arch = releaseArchToken(args.unameM);
  const wanted = contribAssetName(args.version, arch);
  const found = args.assetNames.includes(wanted);
  if (!found) {
    throw new Error(
      `release ${args.version} does not publish ${wanted} (have: ${
        args.assetNames.filter((n) => n.includes("linux")).join(", ")
      })`,
    );
  }
  return {
    assetName: wanted,
    downloadUrl: contribDownloadUrl(args.version, wanted),
  };
}

// ---------------------------------------------------------------------------
// Effectful helpers
// ---------------------------------------------------------------------------

/** The result of running an external command. */
export interface CmdResult {
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
  /** Process exit code (127 when the binary could not be spawned). */
  code: number;
}

async function runCmd(binary: string, args: string[]): Promise<CmdResult> {
  try {
    const proc = new Deno.Command(binary, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/** Detect `uname -m`, returning an empty string on failure. */
export async function detectArch(): Promise<string> {
  const res = await runCmd("uname", ["-m"]);
  return res.code === 0 ? res.stdout.trim() : "";
}

/** Resolve the latest otelcol-contrib release version from the GitHub API. */
export async function latestReleaseVersion(
  githubToken = "",
): Promise<{ version: string; assetNames: string[] }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "swamp-otel-gateway/1.0",
  };
  const token = githubToken || Deno.env.get("GITHUB_TOKEN") ||
    Deno.env.get("GH_TOKEN") || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    "https://api.github.com/repos/open-telemetry/opentelemetry-collector-releases/releases/latest",
    { headers, signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} resolving the latest release`,
    );
  }
  const body = await res.json() as {
    tag_name: string;
    assets: { name: string }[];
  };
  return {
    version: body.tag_name.replace(/^v/, ""),
    assetNames: (body.assets ?? []).map((a) => a.name),
  };
}

/** Download an asset, verify its SHA-256 against `expected`, write it to `dest`. */
export async function downloadVerified(args: {
  url: string;
  dest: string;
  expectedSha256: string;
}): Promise<{ bytes: number }> {
  const res = await fetch(args.url, {
    headers: { "User-Agent": "swamp-otel-gateway/1.0" },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} for ${args.url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = await sha256Hex(bytes);
  if (args.expectedSha256 && digest !== args.expectedSha256) {
    throw new Error(
      `checksum mismatch for ${args.url}: expected ${args.expectedSha256}, got ${digest}`,
    );
  }
  await Deno.mkdir(args.dest.slice(0, args.dest.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeFile(args.dest, bytes);
  return { bytes: bytes.length };
}

/** SHA-256 of a byte array, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice().buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract a single member from a `.tar.gz` using the `tar` CLI. */
export async function extractTarGz(
  archivePath: string,
  destDir: string,
  member: string,
): Promise<CmdResult> {
  await Deno.mkdir(destDir, { recursive: true });
  return await runCmd("tar", ["-xzf", archivePath, "-C", destDir, member]);
}

/** Poll the collector health endpoint until it is ok or the deadline passes. */
export async function waitForHealth(
  url: string,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<{ healthy: boolean; statusCode: number; attempts: number }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let statusCode = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(5000, intervalMs * 4)),
      });
      statusCode = res.status;
      if (res.ok) return { healthy: true, statusCode, attempts };
    } catch {
      statusCode = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { healthy: false, statusCode, attempts };
}

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
}

/** Expand a leading `~`; the home dir is injectable so the helper is pure. */
export function expandHome(path: string, homeDir?: string): string {
  if (!path.startsWith("~")) return path;
  const home = homeDir ?? Deno.env.get("HOME") ?? "~";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** Resolve the install dir, binary, config, and env-file paths. */
export function resolvePaths(
  g: {
    installDir: string;
    binaryPath: string;
    configPath: string;
    environmentFile: string;
  },
  homeDir?: string,
): {
  installDir: string;
  binaryPath: string;
  configPath: string;
  environmentFile: string;
} {
  const installDir = expandHome(g.installDir, homeDir);
  return {
    installDir,
    binaryPath: g.binaryPath.trim() || `${installDir}/otelcol-contrib`,
    configPath: g.configPath.trim() || `${installDir}/config.yaml`,
    environmentFile: g.environmentFile.trim() || `${installDir}/gateway.env`,
  };
}

/**
 * Resolve exporter headers, pulling credential values from the vault for any
 * header that names a `valueEnv`. Returns the exporters (with `${env:NAME}` refs
 * preserved in the config) and the env map to write to the env file.
 */
async function resolveExporters(
  ctx: MethodContext,
): Promise<{ exporters: ResolvedExporter[]; env: Record<string, string> }> {
  const g = ctx.globalArgs;
  const env: Record<string, string> = {};
  const exporters: ResolvedExporter[] = [];
  for (const ex of g.exporters) {
    const headers: { name: string; value: string }[] = [];
    // Convenience: build a Basic Authorization header from two vault keys.
    if (ex.basicAuth) {
      const email = await readVaultSecret(ctx, ex.basicAuth.emailEnv);
      const password = await readVaultSecret(ctx, ex.basicAuth.authEnv);
      if (!email || !password) {
        throw new Error(
          `exporter '${ex.name}' needs Basic auth, but vault '${g.vaultName}' ` +
            `has no '${ex.basicAuth.emailEnv}' / '${ex.basicAuth.authEnv}'. ` +
            `Store them with \`swamp vault put ${g.vaultName} <key>\`.`,
        );
      }
      const authVar = `${sanitiseEnvName(ex.name)}_AUTH`;
      env[authVar] = `Basic ${base64Encode(`${email}:${password}`)}`;
      headers.push({ name: "Authorization", value: `\${env:${authVar}}` });
    }
    for (const h of ex.headers) {
      if (h.valueEnv) {
        const secret = await readVaultSecret(ctx, h.valueEnv);
        if (!secret) {
          throw new Error(
            `exporter '${ex.name}' header '${h.name}' needs environment variable ` +
              `${h.valueEnv}, but nothing was found in vault '${g.vaultName}'. ` +
              `Store it with \`swamp vault put ${g.vaultName} ${h.valueEnv}\`.`,
          );
        }
        env[h.valueEnv] = secret;
        headers.push({ name: h.name, value: `\${env:${h.valueEnv}}` });
      } else if (h.value) {
        headers.push({ name: h.name, value: h.value });
      }
    }
    exporters.push({
      name: ex.name,
      endpoint: ex.endpoint.replace(/\/+$/, ""),
      headers,
      insecure: ex.insecure,
      signals: ex.signals,
      enabled: ex.enabled,
    });
  }
  return { exporters, env };
}

/** A safe, upper-case env var name derived from an exporter name. */
export function sanitiseEnvName(name: string): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  );
  return `OTEL_${slug || "EXPORTER"}`;
}

/** UTF-8 safe base64 (no Node Buffer). */
export function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readVaultSecret(
  ctx: MethodContext,
  key: string,
): Promise<string> {
  if (!ctx.vaultService || !ctx.globalArgs.vaultName) return "";
  try {
    return await ctx.vaultService.get(
      ctx.globalArgs.vaultName,
      key,
      "model:otel-gateway",
    );
  } catch {
    return "";
  }
}

/** Render a `KEY=value` env file with shell-safe quoting and mode 0600. */
export async function writeEnvFile(
  path: string,
  env: Record<string, string>,
): Promise<void> {
  const lines = Object.keys(env).sort().map((k) =>
    `${k}=${shellQuote(env[k])}`
  );
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, lines.join("\n") + "\n");
  await Deno.chmod(path, 0o600);
}

/** Quote a value for a systemd EnvironmentFile (single-quote, escape embedded). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/otel-gateway`. */
export const model = {
  type: "@svendowideit/otel-gateway",
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "sane-config": {
      description: "Reject an unusable gateway before doing any work",
      labels: ["policy"],
      appliesTo: ["install", "configure", "status", "remove"],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const g = context.globalArgs;
        const errors: string[] = [];
        if (!isSafeServiceName(g.serviceName)) {
          errors.push(
            `serviceName '${g.serviceName}' is not a valid systemd unit name`,
          );
        }
        const enabled = g.exporters.filter((e) => e.enabled);
        if (enabled.length === 0) {
          errors.push("at least one enabled exporter is required");
        }
        const names = new Set<string>();
        for (const ex of enabled) {
          if (names.has(ex.name)) {
            errors.push(`duplicate exporter name '${ex.name}'`);
          }
          names.add(ex.name);
          if (ex.endpoint.endsWith("/")) {
            errors.push(
              `exporter '${ex.name}' endpoint must not end with '/' (the collector appends /v1/...)`,
            );
          }
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.03.1",
      description:
        "Initial release: the central OTel Collector gateway. Renders an otelcol-contrib config from structured OTLP receivers and one-or-more backend exporters (dual-write ready), installs the verified release binary, writes a 0600 env file with vault-sourced header credentials (kept out of the config via ${env:…}), runs a systemd user service, and verifies health. install/configure/status/remove methods.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    install: {
      description: "Last install result",
      schema: InstallOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "Gateway status and receiver endpoints",
      schema: StatusOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    remove: {
      description: "Last remove result",
      schema: RemoveOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    verify: {
      description: "Last synthetic OTLP round-trip result",
      schema: VerifyOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    install: {
      description:
        "Install the collector, render the config, write the env file, and start the service",
      arguments: InstallArgsSchema,
      execute: async (
        _args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const paths = resolvePaths(g);
        const { exporters, env } = await resolveExporters(context);
        const enabled = exporters.filter((e) => e.enabled);

        const config = renderGatewayConfig({
          grpcPort: g.grpcPort,
          httpPort: g.httpPort,
          healthPort: g.healthPort,
          metricsPort: g.metricsPort,
          bindAddress: g.bindAddress,
          exporters,
          samplingHeadPercent: g.samplingHeadPercent,
          memoryLimitMiB: g.memoryLimitMiB,
        });

        await Deno.mkdir(paths.installDir, { recursive: true });
        await Deno.writeTextFile(paths.configPath, config);
        await writeEnvFile(paths.environmentFile, env);

        // Resolve the release and download the binary (idempotent: reuse the
        // already-installed binary when the version matches).
        let version = g.version.trim();
        if (!version || !(await binaryVersion(paths.binaryPath))) {
          const rel = await latestReleaseVersion(g.githubToken);
          version = version || rel.version;
          const assetNames = rel.assetNames.length > 0
            ? rel.assetNames
            : (await releaseAssets(version, g.githubToken));
          const arch = await detectArch();
          const chosen = selectContribAsset({
            version,
            unameM: arch,
            assetNames,
          });
          const expected = await fetchAssetSha256(
            version,
            chosen.assetName,
            g.githubToken,
          );
          if (!expected) {
            throw new Error(
              `no SHA-256 published for ${chosen.assetName} (.sha256 asset missing)`,
            );
          }
          const archivePath = `${paths.installDir}/${chosen.assetName}`;
          await downloadVerified({
            url: chosen.downloadUrl,
            dest: archivePath,
            expectedSha256: expected,
          });
          const extract = await extractTarGz(
            archivePath,
            paths.installDir,
            "otelcol-contrib",
          );
          if (extract.code !== 0) {
            throw new Error(
              `extracting otelcol-contrib failed: ${extract.stderr.trim()}`,
            );
          }
          await Deno.chmod(paths.binaryPath, 0o755);
          try {
            await Deno.remove(archivePath);
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          }
        }

        // Idempotently install/refresh the systemd user service.
        const unit = await ensureService(context, g, paths, version);
        if (!unit.ok) throw new Error(unit.error);

        const healthy = await waitForHealth(
          `http://${loopback(g.bindAddress)}:${g.healthPort}`,
          g.healthTimeoutMs,
        );
        context.logger?.info(
          "Gateway {serviceName} installed ({healthy}); OTLP/gRPC {grpc}, OTLP/HTTP {http}",
          {
            serviceName: g.serviceName,
            healthy: healthy.healthy ? "healthy" : "not yet healthy",
            grpc: `${g.bindAddress}:${g.grpcPort}`,
            http: `${g.bindAddress}:${g.httpPort}`,
          },
        );

        const handle = await context.writeResource("install", "install", {
          version,
          binaryPath: paths.binaryPath,
          configPath: paths.configPath,
          environmentFile: paths.environmentFile,
          serviceName: g.serviceName,
          endpoints: endpointsFor(g),
          exporters: enabled.map((e) => e.name),
          healthy: healthy.healthy,
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description:
        "Re-render the config and env file and restart the service if they changed",
      arguments: ConfigureArgsSchema,
      execute: async (
        _args: z.infer<typeof ConfigureArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        return await (model.methods.install.execute as (
          a: Record<string, never>,
          c: MethodContext,
        ) => Promise<{ dataHandles: [{ name: string }] }>)({}, context);
      },
    },

    status: {
      description: "Report the service state, health, and receiver endpoints",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const paths = resolvePaths(g);
        const state = await serviceState(g.serviceName);
        const version = await binaryVersion(paths.binaryPath);
        let healthy = false;
        let statusCode = 0;
        if (state.running) {
          const health = await waitForHealth(
            `http://${loopback(g.bindAddress)}:${g.healthPort}`,
            5000,
            500,
          );
          healthy = health.healthy;
          statusCode = health.statusCode;
        }
        const { exporters } = await resolveExporters(context);
        context.logger?.info(
          "Gateway {serviceName}: {state}, healthy={healthy}",
          {
            serviceName: g.serviceName,
            state: state.state || "absent",
            healthy,
          },
        );
        const handle = await context.writeResource("status", "status", {
          version,
          serviceName: g.serviceName,
          serviceState: state.state,
          running: state.running,
          healthy,
          healthStatusCode: statusCode,
          endpoints: endpointsFor(g),
          exporters: exporters.map((e) => ({
            name: e.name,
            endpoint: e.endpoint,
            signals: e.signals,
            enabled: e.enabled,
          })),
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Push a synthetic OTLP log through the gateway to prove the receive path works",
      arguments: VerifyArgsSchema,
      execute: async (
        args: z.infer<typeof VerifyArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const marker = args.marker.trim() || `gateway-verify-${Date.now()}`;
        const url = `http://${loopback(g.bindAddress)}:${g.httpPort}/v1/logs`;
        const payload = {
          resourceLogs: [{
            resource: {
              attributes: [{
                key: "service.name",
                value: { stringValue: "swamp-otel-gateway-verify" },
              }],
            },
            scopeLogs: [{
              logRecords: [{
                timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                body: { stringValue: marker },
              }],
            }],
          }],
        };
        let statusCode = 0;
        let error = "";
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(g.healthTimeoutMs),
          });
          statusCode = res.status;
          if (!res.ok) error = (await res.text()).slice(0, 300);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (args.waitMs > 0) {
          await new Promise((r) => setTimeout(r, args.waitMs));
        }
        const pushed = statusCode >= 200 && statusCode < 300;
        context.logger?.info(
          pushed
            ? "Pushed synthetic OTLP record {marker} through the gateway (HTTP {status}); verify it in the backend with @svendowideit/openobserve query"
            : "Gateway verify failed (HTTP {status}): {error}",
          { marker, status: statusCode, error },
        );
        const handle = await context.writeResource("verify", "verify", {
          marker,
          pushed,
          pushStatusCode: statusCode,
          serviceName: g.serviceName,
          endpoints: endpointsFor(g),
          verifiedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    remove: {
      description:
        "Stop and disable the gateway service (optionally delete its files)",
      arguments: RemoveArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const paths = resolvePaths(g);
        const state = await serviceState(g.serviceName);
        const removal = await removeService(g.serviceName);
        let installDirRemoved = false;
        if (args.removeInstallDir) {
          try {
            await Deno.remove(paths.installDir, { recursive: true });
            installDirRemoved = true;
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          }
        }
        context.logger?.info("Gateway {serviceName} removed", {
          serviceName: g.serviceName,
        });
        const handle = await context.writeResource("remove", "remove", {
          serviceName: g.serviceName,
          removed: state.exists && removal.ok,
          installDirRemoved,
          removedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Service/effect helpers used by the methods
// ---------------------------------------------------------------------------

function loopback(bind: string): string {
  return bind === "0.0.0.0" || bind === "::" || bind === ""
    ? "127.0.0.1"
    : bind;
}

function endpointsFor(g: GlobalArgs) {
  const host = loopback(g.bindAddress);
  return {
    otlpGrpc: `${g.bindAddress}:${g.grpcPort}`,
    otlpHttp: `${g.bindAddress}:${g.httpPort}`,
    health: `http://${host}:${g.healthPort}`,
    metrics: `http://${host}:${g.metricsPort}`,
  };
}

/** The installed otelcol-contrib version, or "" when the binary is absent. */
async function binaryVersion(binaryPath: string): Promise<string> {
  try {
    await Deno.stat(binaryPath);
  } catch {
    return "";
  }
  const res = await runCmd(binaryPath, ["--version"]);
  if (res.code !== 0) return "";
  const match = /(\d+\.\d+\.\d+)/.exec(res.stdout);
  return match ? match[1] : "unknown";
}

async function serviceState(
  serviceName: string,
): Promise<{ exists: boolean; running: boolean; state: string }> {
  const res = await runCmd("systemctl", [
    "--user",
    "show",
    `${serviceName}.service`,
    "--property=ActiveState",
    "--value",
  ]);
  const state = res.stdout.trim();
  return {
    exists: res.code === 0 && state !== "",
    running: state === "active",
    state: state || "",
  };
}

async function removeService(
  serviceName: string,
): Promise<{ ok: boolean; error: string }> {
  await runCmd("systemctl", ["--user", "stop", `${serviceName}.service`]);
  await runCmd("systemctl", ["--user", "disable", `${serviceName}.service`]);
  try {
    await Deno.remove(
      `${expandHome("~/.config/systemd/user")}/${serviceName}.service`,
    );
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      return { ok: false, error: String(err) };
    }
  }
  await runCmd("systemctl", ["--user", "daemon-reload"]);
  return { ok: true, error: "" };
}

/** Idempotently write and start the gateway systemd user service. */
async function ensureService(
  context: MethodContext,
  g: GlobalArgs,
  paths: { binaryPath: string; configPath: string; environmentFile: string },
  version: string,
): Promise<{ ok: boolean; error: string }> {
  const unitDir = expandHome("~/.config/systemd/user");
  const unitPath = `${unitDir}/${g.serviceName}.service`;
  const unit = renderGatewayUnit({
    version,
    binaryPath: paths.binaryPath,
    configPath: paths.configPath,
    environmentFile: paths.environmentFile,
  });
  await Deno.mkdir(unitDir, { recursive: true });
  let existing = "";
  try {
    existing = await Deno.readTextFile(unitPath);
  } catch {
    // not yet written
  }
  if (existing !== unit) {
    await Deno.writeTextFile(unitPath, unit);
  }
  await runCmd("systemctl", ["--user", "daemon-reload"]);
  await runCmd("loginctl", ["enable-linger", Deno.env.get("USER") ?? ""]);
  const enable = await runCmd("systemctl", [
    "--user",
    "enable",
    "--now",
    `${g.serviceName}.service`,
  ]);
  if (enable.code !== 0) {
    return {
      ok: false,
      error: `systemctl enable --now failed: ${enable.stderr.trim()}`,
    };
  }
  await runCmd("systemctl", ["--user", "restart", `${g.serviceName}.service`]);
  void context;
  return { ok: true, error: "" };
}

/** Fetch and parse the per-asset `.sha256` sibling file. */
async function fetchAssetSha256(
  version: string,
  assetName: string,
  githubToken: string,
): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "swamp-otel-gateway/1.0",
  };
  const token = githubToken || Deno.env.get("GITHUB_TOKEN") ||
    Deno.env.get("GH_TOKEN") || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(sha256UrlFor(version, assetName), {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return "";
  return parseSha256(await res.text());
}

/** Fetch asset names for a pinned release, when the latest-release lookup was not used. */
async function releaseAssets(
  version: string,
  githubToken: string,
): Promise<string[]> {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "swamp-otel-gateway/1.0",
  };
  const token = githubToken || Deno.env.get("GITHUB_TOKEN") ||
    Deno.env.get("GH_TOKEN") || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/open-telemetry/opentelemetry-collector-releases/releases/tags/${tag}`,
    { headers, signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for tag ${tag}`);
  }
  const body = await res.json() as { assets?: { name: string }[] };
  return (body.assets ?? []).map((a) => a.name);
}
