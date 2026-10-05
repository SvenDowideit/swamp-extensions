/**
 * `@svendowideit/swamp-serve` — run a swamp repository as a long-lived,
 * always-on `swamp serve` service, with DNS, TLS, a reverse proxy and OTLP
 * telemetry wired in.
 *
 * This model is the generic half of the story: it knows *how* to install the
 * swamp binary, render and manage a systemd *user* unit, write a
 * `.swamp/serve.yaml`, and connect the server to a discovered observability
 * contract. It does **not** know your domains. It discovers them from the
 * Caddy model you already configured: the base domain that Caddy owns becomes
 * the suffix for `swamp.<baseDomain>` and `dashboard.<baseDomain>`, and the
 * IP of the Caddy model's own A record becomes the address those names point
 * at. Change the Caddy model and this follows.
 *
 * Every mutating operation is delegated to a tested building block rather than
 * reimplemented: binary updates to `swamp update`, the unit to
 * `@svendowideit/systemd-service`, the routes/DNS/TLS to `@svendowideit/caddy`.
 * The one thing this model owns is the *composition* of a serve command that
 * enables the dashboard, hot-reload and auto-resume, and the OTLP environment
 * that sends swamp's own logs, metrics and traces to the gateway described by
 * `@svendowideit/otel-settings`.
 *
 * Methods:
 *   - `resolve`         read the Caddy model and derive hostnames/IP (no writes)
 *   - `installBinary`   install swamp if absent, else leave it
 *   - `updateBinary`    run `swamp update` and restart the service
 *   - `configure`       write .swamp/serve.yaml and validate it
 *   - `ensureService`   render the unit and start the systemd user service
 *   - `ensureTelemetry` write the OTLP env from the settings contract
 *   - `ensureDns`       reconcile the A records for the two hostnames
 *   - `ensureProxy`     reverse-proxy the two hostnames to the server
 *   - `status`          systemd, HTTP, version and telemetry summary
 *   - `guidance`        every option, its default, and how to change it
 *   - `remove`          stop/remove the unit and its routes (keeps the binary)
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  repoDir: z.string().default(".").describe(
    "Repository the server runs (systemd WorkingDirectory and --repo-dir)",
  ),
  swampBinPath: z.string().default("~/.local/bin/swamp").describe(
    "Path to the swamp binary the service executes",
  ),
  installVersion: z.string().default("").describe(
    "Version to install when swamp is absent (empty = latest release)",
  ),
  serviceName: z.string().default("swamp-serve").describe(
    "systemd user service name (the caddy autoProxySwampServe prefix)",
  ),
  host: z.string().default("127.0.0.1").describe(
    "Bind address for swamp serve (Caddy terminates TLS in front of it)",
  ),
  port: z.number().int().positive().max(65535).default(9090).describe(
    "Port swamp serve listens on",
  ),
  configPath: z.string().default(".swamp/serve.yaml").describe(
    "Path to the serve config file the unit is started with",
  ),
  dashboard: z.boolean().default(true).describe("Enable --dashboard"),
  hotReload: z.boolean().default(true).describe("Enable --hot-reload"),
  autoResume: z.boolean().default(true).describe("Enable --auto-resume"),
  authMode: z.enum(["none", "token", "oauth"]).default("none").describe(
    "Authentication mode. 'none' is loopback-only; off-loopback binding " +
      "requires TLS and token/oauth (enforced by swamp serve at startup).",
  ),
  admins: z.string().default("").describe("Comma-separated admin principals"),
  allowedUsers: z.string().default("").describe(
    "Comma-separated swamp-club usernames or user:<sub> subjects",
  ),
  allowedCollectives: z.string().default("").describe(
    "Comma-separated collective slugs for OAuth admission",
  ),
  oauthProvider: z.string().default("").describe(
    "OAuth authorization server URL",
  ),
  trustProxy: z.boolean().default(true).describe(
    "Trust X-Forwarded-For (set when behind Caddy)",
  ),
  trustedHosts: z.array(z.string()).default([]).describe(
    "Host-header allowlist for off-loopback binding",
  ),
  autoTrustedHosts: z.boolean().default(true).describe(
    "Add the derived serve/dashboard hostnames to --trusted-hosts so a proxied " +
      "dashboard's WebSocket origin is accepted (additive; explicit trustedHosts " +
      "are always kept). Set false to trust only the explicit list.",
  ),
  schedule: z.boolean().default(true).describe(
    "Whether the server runs scheduled workflows (false passes --no-schedule)",
  ),
  swampHome: z.string().default("~/.swamp").describe(
    "SWAMP_HOME pinned into the unit (prevents 'Unknown model type' crash-loops)",
  ),
  swampConfigDir: z.string().default("~/.config/swamp").describe(
    "SWAMP_CONFIG_DIR pinned into the unit",
  ),
  caddyModelName: z.string().default("").describe(
    "Name of the @svendowideit/caddy model whose base domain and A record are " +
      "read (required for resolve/dns/proxy)",
  ),
  swampHostname: z.string().default("").describe(
    "Override the serve hostname (empty derives swamp.<caddy base domain>)",
  ),
  dashboardHostname: z.string().default("").describe(
    "Override the dashboard hostname (empty derives dashboard.<caddy base domain>)",
  ),
  otelSettingsModel: z.string().default("").describe(
    "Name of the @svendowideit/otel-settings model the telemetry reads (empty " +
      "disables telemetry wiring)",
  ),
  otelServiceName: z.string().default("swamp-serve").describe(
    "OTEL_SERVICE_NAME reported to the gateway",
  ),
  telemetryVault: z.string().default("").describe(
    "Vault holding the gateway OTLP bearer token (empty = unauthenticated)",
  ),
  authRef: z.string().default("OTEL_EXPORTER_OTLP_TOKEN").describe(
    "Name of the vault key that holds the gateway bearer token (a reference, " +
      "not the secret itself)",
  ),
  command: z.string().default("").describe(
    "Full override for the systemd ExecStart line (empty = rendered from the " +
      "arguments above)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A global-arguments value as the render helpers consume it. */
export type ServeGlobals = GlobalArgs;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const ResolveArgsSchema = z.object({});
const InstallArgsSchema = z.object({
  version: z.string().optional().describe(
    "Override installVersion for this run",
  ),
  force: z.boolean().default(false).describe("Reinstall even when present"),
});
const ConfigureArgsSchema = z.object({});
const EnsureServiceArgsSchema = z.object({
  restart: z.boolean().default(true).describe("Restart when the unit changed"),
});
const EnsureTelemetryArgsSchema = z.object({
  endpoint: z.string().default("").describe(
    "Override the OTLP endpoint (empty reads the settings contract)",
  ),
});
const RemoveArgsSchema = z.object({
  removeRoutes: z.boolean().default(true).describe(
    "Also remove the Caddy routes for the two hostnames",
  ),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const TopologyOutputSchema = z.object({
  caddyModel: z.string(),
  baseDomain: z.string(),
  hostFqdn: z.string(),
  swampHostname: z.string(),
  dashboardHostname: z.string(),
  hostIp: z.string(),
  zone: z.string(),
  tlsEmail: z.string(),
  resolvedAt: z.string(),
});

const BinaryOutputSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  version: z.string(),
  updated: z.boolean(),
  checkedAt: z.string(),
});

const ServeConfigOutputSchema = z.object({
  path: z.string(),
  written: z.boolean(),
  port: z.number(),
  host: z.string(),
  dashboard: z.boolean(),
  hotReload: z.boolean(),
  autoResume: z.boolean(),
  authMode: z.string(),
  checkedAt: z.string(),
});

const UnitOutputSchema = z.object({
  serviceName: z.string(),
  execStart: z.string(),
  environment: z.array(z.string()),
  workingDirectory: z.string(),
  written: z.boolean(),
});

const ServiceOutputSchema = z.object({
  serviceName: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  checkedAt: z.string(),
});

const TelemetryOutputSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  serviceName: z.string(),
  headers: z.string(),
  resourceAttributes: z.string(),
  stacks: z.string(),
  signals: z.array(z.string()),
  appliedAt: z.string(),
});

const ProxyOutputSchema = z.object({
  hostname: z.string(),
  upstream: z.string(),
  changed: z.boolean(),
  ensuredAt: z.string(),
});

const DnsOutputSchema = z.object({
  records: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      value: z.array(z.string()),
      zone: z.string(),
    }),
  ),
  applied: z.boolean(),
  appliedAt: z.string(),
});

const StatusOutputSchema = z.object({
  serviceActive: z.boolean(),
  serviceEnabled: z.boolean(),
  swampVersion: z.string(),
  swampHostHttp: z.number().int(),
  dashboardHostHttp: z.number().int(),
  telemetryEndpoint: z.string(),
  telemetryStacks: z.string(),
  checkedAt: z.string(),
});

const GuidanceOutputSchema = z.object({
  options: z.array(
    z.object({
      key: z.string(),
      current: z.string(),
      defaultValue: z.string(),
      description: z.string(),
      persist: z.string(),
    }),
  ),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** The host facts derived from a Caddy model, without touching the network. */
export interface CaddyFacts {
  /** The caddy model name that was read. */
  modelName: string;
  /** The base domain Caddy owns (e.g. `fi.gy`). */
  baseDomain: string;
  /** The host's own address on that zone (e.g. `x1yoga.fi.gy`). */
  hostFqdn: string;
  /** TLS/ACME email, when configured. */
  tlsEmail: string;
  /** The IP the host's A record points at, if present. */
  hostIp: string;
  /** The zone the record belongs to (record's zone, else the base domain). */
  zone: string;
}

/** The serve command and environment the unit runs. */
export interface RenderedUnit {
  /** The full `ExecStart` line. */
  execStart: string;
  /** The `Environment=` lines in order. */
  environment: string[];
  /** The systemd `WorkingDirectory=`. */
  workingDirectory: string;
}

/** The OTLP environment derived from an otel-settings contract. */
export interface TelemetryEnv {
  /** Base OTLP/HTTP endpoint (swamp appends /v1/{logs,metrics,traces}). */
  endpoint: string;
  /** `Authorization: Bearer …`, or empty when unauthenticated. */
  headers: string;
  /** `service.name` reported to the store. */
  serviceName: string;
  /** `deployment.environment`/`site`/`owner` resource attributes. */
  resourceAttributes: string;
  /** The signals this environment carries (logs, metrics, traces). */
  signals: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The release installer swamp publishes; the only supported bootstrap path. */
export const INSTALL_SH_URL = "https://swamp.club/install.sh";

/** The profile/stacks signal swamp's bundled OTel SDK does not export. */
export const STACKS_SUPPORTED = false;

/** The swamp environment variable names this model writes. */
export const TELEMETRY_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_BSP_USE",
  "OTEL_BLRP_USE",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/**
 * Resolve a repo directory to an absolute path. systemd rejects a relative
 * `WorkingDirectory=` (it is a fatal unit error, not a warning), so `.` and
 * any other relative path are resolved against the process CWD. `~` is expanded.
 */
export function absoluteRepoDir(repoDir: string, cwd?: string): string {
  const expanded = expandHome(repoDir || ".");
  if (expanded.startsWith("/")) return expanded;
  const base = cwd ?? Deno.cwd();
  const parts = `${base}/${expanded}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return `/${stack.join("/")}`;
}

/**
 * A collision-free definition name for the inner `@svendowideit/systemd-service`
 * model that manages our unit. It must differ from the calling model's own name:
 * a direct-type `runModel` with the caller's name would resolve to the caller
 * (a cycle), and the earlier CLI-shell-out implementation deadlocked on the
 * caller's data lock. `context.definition.name` is used to guarantee they differ.
 */
export function systemdDefinitionName(
  serviceName: string,
  callerName = "",
): string {
  const base = `${serviceName}-unit`;
  return base === callerName ? `${base}-svc` : base;
}

/**
 * Derive the two hostnames from an anchor (the host's own FQDN, or the Caddy
 * base domain when the host has no deeper record), or use explicit overrides.
 * A hostname is never double-suffixed: `swamp.fi.gy` + anchor `fi.gy` stays
 * `swamp.fi.gy`, and `swamp.x1yoga.fi.gy` + anchor `x1yoga.fi.gy` is left as-is.
 */
export function deriveHostnames(
  anchor: string,
  swampOverride = "",
  dashboardOverride = "",
): { swampHostname: string; dashboardHostname: string } {
  const base = anchor.trim().replace(/^\.+/, "");
  if (!base) {
    return {
      swampHostname: swampOverride,
      dashboardHostname: dashboardOverride,
    };
  }
  const withBase = (label: string, override: string): string => {
    if (override) return override;
    if (label === base || label.endsWith(`.${base}`)) return label;
    return `${label}.${base}`;
  };
  return {
    swampHostname: withBase("swamp", swampOverride),
    dashboardHostname: withBase("dashboard", dashboardOverride),
  };
}

/** The zone a record with `name` belongs to, given a fallback. */
export function deriveZone(name: string, zone: string): string {
  if (zone) return zone;
  const parts = name.split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : name;
}

/**
 * Read the Caddy facts from a `swamp model get <caddy> --json` payload.
 *
 * The host's own address is the deepest (most labels) A/AAAA record under the
 * base domain — for a Caddy model whose base domain is `fi.gy` and which
 * declares `x1yoga.fi.gy`, that is `x1yoga.fi.gy`, the machine's own name. The
 * `hostname` argument (the machine's `uname -n`, e.g. `x1yoga`) selects the
 * record by name when several candidates exist; otherwise the deepest wins. The
 * IP is that record's value, so it is the address the user already chose.
 */
export function parseCaddyFacts(
  modelName: string,
  raw: {
    globalArguments?: Record<string, unknown>;
  },
  hostname = "",
): CaddyFacts {
  const g = (raw.globalArguments ?? {}) as Record<string, unknown>;
  const baseDomain = typeof g.baseDomain === "string" ? g.baseDomain : "";
  const tlsEmail = typeof g.letsEncryptEmail === "string"
    ? g.letsEncryptEmail
    : "";
  const records = Array.isArray(g.dnsRecords)
    ? (g.dnsRecords as Array<Record<string, unknown>>)
    : [];

  const base = baseDomain.toLowerCase().replace(/^\.+/, "");
  const shortHost = hostname.split(".")[0].toLowerCase();

  // Collect every A/AAAA record under the base domain.
  const candidates: Array<{
    name: string;
    ip: string;
    zone: string;
  }> = [];
  for (const r of records) {
    if (typeof r.name !== "string" || typeof r.type !== "string") continue;
    const name = r.name.toLowerCase();
    const isA = r.type.toUpperCase() === "A" || r.type.toUpperCase() === "AAAA";
    if (!isA) continue;
    if (base && name !== base && !name.endsWith(`.${base}`)) continue;
    const value = Array.isArray(r.value) ? r.value : [];
    const ip = value.find((v): v is string => typeof v === "string" && !!v);
    if (!ip) continue;
    candidates.push({
      name,
      ip,
      zone: typeof r.zone === "string" ? r.zone : "",
    });
  }

  // Prefer the record whose leftmost label is this machine's hostname; else the
  // deepest (most labels) — the host's own record, not the zone apex.
  const named = candidates.find(
    (c) => shortHost && c.name.split(".")[0] === shortHost,
  );
  const deepest = candidates.slice().sort(
    (a, b) => b.name.split(".").length - a.name.split(".").length,
  )[0];
  const chosen = named ?? deepest;

  const hostFqdn = chosen?.name ?? baseDomain;
  return {
    modelName,
    baseDomain,
    hostFqdn,
    tlsEmail,
    hostIp: chosen?.ip ?? "",
    zone: deriveZone(hostFqdn, chosen?.zone ?? ""),
  };
}

/** The systemd unit name swamp-serve uses for a repo (caddy's prefix). */
export function unitNameFor(
  g: { serviceName: string; repoDir: string },
): string {
  return g.serviceName || "swamp-serve";
}

/**
 * Render the serve `ExecStart` line from the global arguments. Every option is
 * explicit so it is reproducible and auditable; an empty `command` global
 * wins verbatim.
 */
export function renderExecStart(
  g: ServeGlobals,
  trustedHosts: string[] = g.trustedHosts,
): string {
  if (g.command) return g.command;
  const args = [
    expandHome(g.swampBinPath),
    "serve",
    "--repo-dir",
    absoluteRepoDir(g.repoDir),
    "--config",
    configPathFor(g),
    "--host",
    g.host,
    "--port",
    String(g.port),
  ];
  if (g.dashboard) args.push("--dashboard");
  if (g.hotReload) args.push("--hot-reload");
  if (g.autoResume) args.push("--auto-resume");
  if (g.trustProxy) args.push("--trust-proxy");
  if (!g.schedule) args.push("--no-schedule");
  if (g.authMode && g.authMode !== "none") args.push("--auth-mode", g.authMode);
  if (g.admins) args.push("--admins", g.admins);
  if (g.allowedUsers) args.push("--allowed-users", g.allowedUsers);
  if (g.allowedCollectives) {
    args.push("--allowed-collectives", g.allowedCollectives);
  }
  if (g.oauthProvider) args.push("--oauth-provider", g.oauthProvider);
  if (trustedHosts.length > 0) {
    args.push("--trusted-hosts", trustedHosts.join(","));
  }
  return args.map(shellQuote).join(" ");
}

/** Quote a value for a systemd `ExecStart` line when it contains spaces. */
export function shellQuote(value: string): string {
  if (value === "") return '""';
  if (!/\s/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Render the full `Environment=` list for the unit: swamp's data/config dirs
 * (which must be pinned or a scheduled extension type is "unknown"), then the
 * discovered OTLP settings. A unit with no telemetry still pins SWAMP_HOME.
 */
export function renderUnitEnvironment(
  g: ServeGlobals,
  telemetry?: TelemetryEnv | null,
): string[] {
  const env = [
    `SWAMP_HOME=${expandHome(g.swampHome)}`,
    `SWAMP_CONFIG_DIR=${expandHome(g.swampConfigDir)}`,
  ];
  if (telemetry && telemetry.endpoint) {
    env.push(`OTEL_EXPORTER_OTLP_ENDPOINT=${telemetry.endpoint}`);
    env.push("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf");
    if (telemetry.headers) {
      env.push(`OTEL_EXPORTER_OTLP_HEADERS=${telemetry.headers}`);
    }
    env.push(`OTEL_SERVICE_NAME=${telemetry.serviceName}`);
    if (telemetry.resourceAttributes) {
      env.push(`OTEL_RESOURCE_ATTRIBUTES=${telemetry.resourceAttributes}`);
    }
    // Long-running serve should batch rather than flush per record.
    env.push("OTEL_BSP_USE=1");
    env.push("OTEL_BLRP_USE=1");
  }
  return env;
}

/** Render the complete unit description passed to systemd-service. */
export function renderUnit(
  g: ServeGlobals,
  telemetry?: TelemetryEnv | null,
  trustedHosts: string[] = g.trustedHosts,
): RenderedUnit {
  return {
    execStart: renderExecStart(g, trustedHosts),
    environment: renderUnitEnvironment(g, telemetry),
    workingDirectory: absoluteRepoDir(g.repoDir),
  };
}

/** The serve.yaml body persisted for the configured options. */
export function renderServeConfig(
  g: ServeGlobals,
  trustedHosts: string[] = g.trustedHosts,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    port: g.port,
    host: g.host,
    dashboard: g.dashboard,
    "hot-reload": g.hotReload,
    "auto-resume": g.autoResume,
    "trust-proxy": g.trustProxy,
    schedule: g.schedule,
    auth: {
      mode: g.authMode,
      ...(g.admins ? { admins: splitList(g.admins) } : {}),
      ...(g.allowedUsers ? { "allowed-users": splitList(g.allowedUsers) } : {}),
      ...(g.allowedCollectives
        ? { "allowed-collectives": splitList(g.allowedCollectives) }
        : {}),
      ...(g.oauthProvider ? { "oauth-provider": g.oauthProvider } : {}),
    },
  };
  if (trustedHosts.length > 0) config["trusted-hosts"] = trustedHosts;
  return config;
}

/** Split a comma-separated argument into trimmed, non-empty values. */
export function splitList(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Serialise the serve config as YAML. swamp's config is a shallow map of
 * scalars, one nested `auth` object and scalar arrays; this covers exactly that
 * shape and quotes only where required.
 */
export function renderServeConfigYaml(
  g: ServeGlobals,
  trustedHosts: string[] = g.trustedHosts,
): string {
  return toYaml(renderServeConfig(g, trustedHosts), 0) + "\n";
}

/** Minimal YAML serialiser for the serve config's shape. */
export function toYaml(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((v) => `${pad}- ${scalarToYaml(v)}`)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const inner = toYaml(v, indent + 2);
          return `${pad}${k}:\n${inner}`;
        }
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []`;
          const inner = (v as unknown[])
            .map((x) => `${pad}  - ${scalarToYaml(x)}`)
            .join("\n");
          return `${pad}${k}:\n${inner}`;
        }
        return `${pad}${k}: ${scalarToYaml(v)}`;
      })
      .join("\n");
  }
  return `${pad}${scalarToYaml(value)}`;
}

/** YAML scalar formatting with quoting only when needed. */
export function scalarToYaml(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (value === null || value === undefined) return "null";
  const s = String(value);
  if (s === "" || /[:#\-?,[\]{}&*!|>'"%@`\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// OTLP contract helpers
// ---------------------------------------------------------------------------

/**
 * Build the OTLP environment from a resolved otel-settings `settings`
 * resource plus an optional bearer token. The endpoint is the default
 * endpoint's `otlp_http_url`; swamp appends `/v1/{logs,metrics,traces}`.
 */
export function buildTelemetryEnv(
  settings: {
    endpoints?: Array<{ mesh?: string; otlp_http_url?: string }>;
    defaultMesh?: string;
    deploymentEnvironment?: string;
    site?: string;
    owner?: string;
    authMethod?: string;
  },
  opts: { endpoint?: string; serviceName: string; token?: string },
): TelemetryEnv {
  let endpoint = opts.endpoint ?? "";
  if (!endpoint) {
    const endpoints = settings.endpoints ?? [];
    const preferred = settings.defaultMesh
      ? endpoints.find((e) => e.mesh === settings.defaultMesh)
      : undefined;
    endpoint = preferred?.otlp_http_url ?? endpoints[0]?.otlp_http_url ?? "";
  }
  const resourceAttributes = [
    // service.name belongs here as well as in OTEL_SERVICE_NAME: Deno's native
    // (Rust) telemetry reads OTEL_RESOURCE_ATTRIBUTES but ignores
    // OTEL_SERVICE_NAME, so without it native records land as
    // "unknown_service:deno". swamp's Node SDK path honours both.
    opts.serviceName ? `service.name=${opts.serviceName}` : "",
    settings.deploymentEnvironment
      ? `deployment.environment=${settings.deploymentEnvironment}`
      : "",
    settings.site ? `site=${settings.site}` : "",
    settings.owner ? `owner=${settings.owner}` : "",
  ].filter(Boolean).join(",");

  const headers = opts.token ? `Authorization=Bearer ${opts.token}` : "";

  return {
    endpoint,
    headers,
    serviceName: opts.serviceName,
    resourceAttributes,
    signals: ["logs", "metrics", "traces"],
  };
}

/**
 * The exact telemetry env keys and the value swamp should end up with, used
 * by `guidance` and `status`. Kept as a pure function so the docs and the code
 * cannot drift.
 */
export function telemetryEnvDescription(): Array<{
  key: string;
  purpose: string;
}> {
  return [
    {
      key: "OTEL_EXPORTER_OTLP_ENDPOINT",
      purpose: "Base OTLP/HTTP URL; swamp appends /v1/{logs,metrics,traces}",
    },
    {
      key: "OTEL_EXPORTER_OTLP_PROTOCOL",
      purpose: "Wire protocol (http/protobuf)",
    },
    {
      key: "OTEL_EXPORTER_OTLP_HEADERS",
      purpose: "Authorization=Bearer <gateway token>",
    },
    {
      key: "OTEL_SERVICE_NAME",
      purpose:
        "service.name for swamp's Node SDK; Deno's native telemetry ignores it",
    },
    {
      key: "OTEL_RESOURCE_ATTRIBUTES",
      purpose: "service.name (so Deno's native telemetry is named too), " +
        "deployment.environment, site, owner",
    },
    { key: "OTEL_BSP_USE", purpose: "Batch span export (long-running serve)" },
    { key: "OTEL_BLRP_USE", purpose: "Batch log export (long-running serve)" },
  ];
}

// ---------------------------------------------------------------------------
// Option catalogue (documentation, rendered by `guidance`)
// ---------------------------------------------------------------------------

/** One configurable option with its current value, default and update line. */
export interface OptionDoc {
  /** The global argument name. */
  key: string;
  /** Its current value on this model. */
  current: string;
  /** Its schema default. */
  defaultValue: string;
  /** What it controls. */
  description: string;
  /** The command that persists a change (with `{value}` to fill in). */
  persist: string;
}

/** Every global argument, its default, and the command that changes it. */
export function describeOptions(g: ServeGlobals): OptionDoc[] {
  const persist = (key: string, value: string): string =>
    `swamp model edit <model> --global-arg ${key}=${value}`;
  const rows: Array<[string, string, string, string]> = [
    [
      "repoDir",
      g.repoDir,
      ".",
      "Repository the server runs (WorkingDirectory and --repo-dir)",
    ],
    [
      "swampBinPath",
      g.swampBinPath,
      "~/.local/bin/swamp",
      "swamp binary the unit executes",
    ],
    [
      "installVersion",
      g.installVersion,
      "(latest)",
      "Version installed when swamp is absent",
    ],
    ["serviceName", g.serviceName, "swamp-serve", "systemd user service name"],
    ["host", g.host, "127.0.0.1", "Bind address (loopback behind Caddy)"],
    ["port", String(g.port), "9090", "Port swamp serve listens on"],
    ["configPath", g.configPath, ".swamp/serve.yaml", "Serve config file"],
    [
      "dashboard",
      String(g.dashboard),
      "true",
      "Enable the web dashboard at /dashboard",
    ],
    [
      "hotReload",
      String(g.hotReload),
      "true",
      "Enable SIGHUP hot-reload of extension bundles",
    ],
    [
      "autoResume",
      String(g.autoResume),
      "true",
      "Resume suspended runs once approvals are decided",
    ],
    ["schedule", String(g.schedule), "true", "Run scheduled workflows"],
    [
      "authMode",
      g.authMode,
      "none",
      "none | token | oauth (none is loopback-only)",
    ],
    ["admins", g.admins, "(unset)", "Comma-separated admin principals"],
    ["allowedUsers", g.allowedUsers, "(unset)", "Allowed swamp-club users"],
    [
      "allowedCollectives",
      g.allowedCollectives,
      "(unset)",
      "Allowed collectives (OAuth)",
    ],
    [
      "oauthProvider",
      g.oauthProvider,
      "https://swamp-club.com",
      "OAuth authorization server",
    ],
    [
      "trustProxy",
      String(g.trustProxy),
      "true",
      "Trust X-Forwarded-For behind a proxy",
    ],
    [
      "trustedHosts",
      g.trustedHosts.join(","),
      "(unset)",
      "Host-header allowlist",
    ],
    [
      "autoTrustedHosts",
      String(g.autoTrustedHosts),
      "true",
      "Add the derived serve/dashboard hostnames to --trusted-hosts",
    ],
    ["swampHome", g.swampHome, "~/.swamp", "SWAMP_HOME pinned into the unit"],
    [
      "swampConfigDir",
      g.swampConfigDir,
      "~/.config/swamp",
      "SWAMP_CONFIG_DIR pinned into the unit",
    ],
    [
      "caddyModelName",
      g.caddyModelName,
      "(required)",
      "Caddy model the base domain/IP are read from",
    ],
    [
      "swampHostname",
      g.swampHostname,
      "swamp.<baseDomain>",
      "Serve hostname (derived from Caddy)",
    ],
    [
      "dashboardHostname",
      g.dashboardHostname,
      "dashboard.<baseDomain>",
      "Dashboard hostname (derived from Caddy)",
    ],
    [
      "otelSettingsModel",
      g.otelSettingsModel,
      "(unset)",
      "otel-settings model the telemetry is read from",
    ],
    ["otelServiceName", g.otelServiceName, "swamp-serve", "OTEL_SERVICE_NAME"],
    [
      "telemetryVault",
      g.telemetryVault,
      "(unset)",
      "Vault holding the gateway bearer token",
    ],
    [
      "authRef",
      g.authRef,
      "OTEL_EXPORTER_OTLP_TOKEN",
      "Vault key for the gateway token",
    ],
  ];
  return rows.map(([key, current, defaultValue, description]) => ({
    key,
    current,
    defaultValue,
    description,
    persist: persist(key, key === "trustedHosts" ? "a,b" : "{value}"),
  }));
}

// ---------------------------------------------------------------------------
// Context shapes (structural, so tests can supply fakes)
// ---------------------------------------------------------------------------

/** The subset of the method context this model uses (structural, for tests). */
export type ResourceContext = {
  globalArgs: ServeGlobals;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (specName: string, name?: string) => Promise<unknown>;
  queryData?: (predicate: string, select?: string) => Promise<unknown[]>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<Array<Record<string, unknown>>>;
  runModel?: (options: RunModelOptions) => Promise<RunModelResult>;
  definition?: {
    id: string;
    name: string;
    version: string;
    tags: Record<string, string>;
  };
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
};

/** Options for `context.runModel` (the sanctioned cross-model call). */
export type RunModelOptions = {
  definition?: string;
  modelType?: string;
  name?: string;
  method: string;
  arguments?: Record<string, unknown>;
};

/** Result of `context.runModel`; failures are values, not exceptions. */
export type RunModelResult =
  | { ok: true; resources: Array<{ name: string }> }
  | { ok: false; error: { message: string; stack?: string } };

/** A command runner, injectable so tests never shell out. */
export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Default command runner for the operations that genuinely need a process
 * (running the swamp binary itself for `--version`/`update`, and `systemctl`).
 * Cross-model calls never use this — they go through `context.runModel`.
 */
export const runCommand: CommandRunner = async (
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> => {
  try {
    const proc = new Deno.Command(cmd, {
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
};

/** Run the swamp CLI binary via the default runner. */
export function runSwamp(
  args: string[],
  run: CommandRunner = runCommand,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return run("swamp", args);
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/**
 * Read another model's latest resource by name through `readModelData` (the
 * sanctioned in-process API — never a CLI subprocess, which would reload the
 * extensions and re-lock the datastore). Falls back to `queryData`.
 */
export async function readModelResource(
  context: ResourceContext,
  modelName: string,
  specName: string,
): Promise<Record<string, unknown> | null> {
  if (context.readModelData) {
    try {
      const records = await context.readModelData(modelName, specName);
      const attrs = records?.[0]?.attributes;
      if (attrs && typeof attrs === "object") {
        return attrs as Record<string, unknown>;
      }
      if (records && records.length > 0) {
        return records[0] as Record<string, unknown>;
      }
    } catch {
      // fall through to queryData
    }
  }
  return await latestData(context, "", specName, modelName);
}

/** Query another model's latest data through the queryData hook. */
export async function latestData(
  context: ResourceContext,
  modelType: string,
  specName: string,
  modelName?: string,
): Promise<Record<string, unknown> | null> {
  if (!context.queryData) return null;
  const predicate = [
    modelType ? `modelType == "${modelType}"` : "",
    `specName == "${specName}"`,
    modelName ? `modelName == "${modelName}"` : "",
  ].filter(Boolean).join(" && ");
  let records: unknown[] = [];
  try {
    records = await context.queryData(predicate);
  } catch {
    return null;
  }
  if (!records || records.length === 0) return null;
  const recordsByTime = records.map((r) => r as Record<string, unknown>);
  recordsByTime.sort((a, b) => {
    const at = String(a.checkedAt ?? a.renderedAt ?? a.publishedAt ?? "");
    const bt = String(b.checkedAt ?? b.renderedAt ?? b.publishedAt ?? "");
    return bt.localeCompare(at);
  });
  const top = recordsByTime[0];
  const attrs = top.attributes;
  if (attrs && typeof attrs === "object") {
    return attrs as Record<string, unknown>;
  }
  const content = top.content;
  if (typeof content === "string") {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (content && typeof content === "object") {
    return content as Record<string, unknown>;
  }
  return null;
}

/**
 * Read the Caddy facts for `g.caddyModelName` from that model's `desired`
 * resource via the in-process context APIs (never a CLI subprocess). The caddy
 * model writes `desired` on every mutating method, so it is the authoritative
 * source for its base domain and DNS records.
 */
export async function resolveCaddyFromContext(
  context: ResourceContext,
  g: ServeGlobals,
  hostname = "",
): Promise<CaddyFacts> {
  if (!g.caddyModelName) {
    throw new Error(
      "caddyModelName is required — set it to the @svendowideit/caddy model " +
        "whose base domain this server should use (see `swamp model list`).",
    );
  }
  const desired = await readModelResource(context, g.caddyModelName, "desired");
  if (!desired) {
    throw new Error(
      `could not read the 'desired' resource of caddy model ` +
        `'${g.caddyModelName}'. Ensure it exists and has been configured (run ` +
        `its configureTls/addProxyService/applyDnsRecords at least once), or ` +
        `check the name with 'swamp model list'.`,
    );
  }
  // The caddy `desired` resource carries baseDomain + dnsRecords at the top
  // level; wrap it in the globalArguments shape parseCaddyFacts understands.
  const facts = parseCaddyFacts(
    g.caddyModelName,
    { globalArguments: desired },
    hostname || machineHostname(),
  );
  if (!facts.baseDomain) {
    throw new Error(
      `caddy model '${g.caddyModelName}' has no baseDomain; set one (e.g. ` +
        `\`swamp model edit ${g.caddyModelName} --global-arg ` +
        "baseDomain=example.com`).",
    );
  }
  return facts;
}

/** This machine's hostname (`Deno.hostname()`, minus any domain part). */
export function machineHostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return Deno.env.get("HOSTNAME") ?? "";
  }
}

/** The hostnames this server will be reached on, derived then overridden. */
export function hostnamesFor(
  g: ServeGlobals,
  facts: CaddyFacts,
): { swampHostname: string; dashboardHostname: string } {
  return deriveHostnames(
    facts.hostFqdn || facts.baseDomain,
    g.swampHostname,
    g.dashboardHostname,
  );
}

/**
 * The `--trusted-hosts` list to render. swamp validates the WebSocket `Origin`
 * against `--trusted-hosts` when the serve API sits behind a proxy (browsers
 * always send an Origin, swamp's own server-to-server clients do not), so the
 * derived serve/dashboard hostnames must be trusted or the dashboard's sockets
 * are rejected with "untrusted origin". `autoTrustedHosts` folds them in;
 * explicit `trustedHosts` entries are always kept.
 */
export function effectiveTrustedHosts(
  hostnames: string[],
  g: Pick<ServeGlobals, "trustedHosts" | "autoTrustedHosts">,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (h: string) => {
    const t = h.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  // Explicit entries win the order, then the derived hostnames.
  for (const h of g.trustedHosts) add(h);
  if (g.autoTrustedHosts) { for (const h of hostnames) add(h); }
  return out;
}

/**
 * Resolve the effective trusted-host list from the Caddy facts, tolerating an
 * absent model (a host with no Caddy still gets a running service, just
 * without auto-trusted hostnames).
 */
export async function resolveTrustedHosts(
  context: ResourceContext,
  g: ServeGlobals,
): Promise<string[]> {
  let hostnames: string[] = [];
  if (g.caddyModelName) {
    try {
      const facts = await resolveCaddyFromContext(context, g);
      const h = hostnamesFor(g, facts);
      hostnames = [h.swampHostname, h.dashboardHostname];
    } catch {
      // No Caddy: fall back to explicit entries only.
    }
  }
  return effectiveTrustedHosts(hostnames, g);
}

/** Expand the serve config path relative to the repo directory. */
export function configPathFor(g: ServeGlobals): string {
  return expandHome(
    g.configPath.startsWith("/")
      ? g.configPath
      : `${absoluteRepoDir(g.repoDir)}/${g.configPath}`,
  );
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/swamp-serve`. */
export const model = {
  type: "@svendowideit/swamp-serve",
  version: "2026.10.05.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-config": {
      description: "Validate the service name, port, and repo directory",
      labels: ["policy"],
      appliesTo: [
        "configure",
        "ensureService",
        "ensureTelemetry",
        "ensureDns",
        "ensureProxy",
        "status",
        "remove",
      ],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const g = context.globalArgs;
        const errors: string[] = [];
        if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(g.serviceName)) {
          errors.push(
            `serviceName '${g.serviceName}' is not a valid systemd unit name`,
          );
        }
        if (!Number.isInteger(g.port) || g.port < 1 || g.port > 65535) {
          errors.push(`port ${g.port} is out of range`);
        }
        if (g.repoDir.includes("\n")) {
          errors.push("repoDir must not contain newlines");
        }
        if (g.command.includes("\n")) {
          errors.push("command must not contain newlines");
        }
        if (Deno.build.os !== "linux") {
          errors.push(
            "swamp-serve manages systemd user services and is supported on " +
              "Linux only",
          );
        }
        for (const h of g.trustedHosts) {
          if (!/^[A-Za-z0-9.-]+$/.test(h)) {
            errors.push(`trustedHosts entry '${h}' is not a valid hostname`);
          }
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.04.1",
      description:
        "Initial release: resolve hostnames from a Caddy model, install/update " +
        "the swamp binary, write .swamp/serve.yaml, run swamp serve as a " +
        "systemd user service with the dashboard, hot-reload and auto-resume " +
        "enabled, and send logs, metrics and traces to the discovered OTel " +
        "gateway. DNS, TLS and reverse-proxying are delegated to " +
        "@svendowideit/caddy. Stacks/profiles are not exported by swamp's OTel " +
        "SDK and are documented as a gap.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.05.1",
      description:
        "Default port changed from 3080 to 9090 — swamp serve's documented " +
        "default. ensureProxy now routes swamp.<host> to the serve API root and " +
        "dashboard.<host> to /dashboard via @svendowideit/caddy's new rootPath " +
        "rewrite (same port, one host per path). Cross-model calls use " +
        "context.runModel (never a CLI subprocess). Re-running configure/" +
        "ensureService/ensureProxy converges an existing unit onto 9090. " +
        "service.name is now also written into OTEL_RESOURCE_ATTRIBUTES so " +
        "telemetry from Deno's native (Rust) SDK is named, not " +
        "unknown_service:deno. New autoTrustedHosts global (default true) adds " +
        "the derived serve/dashboard hostnames to --trusted-hosts and the serve " +
        "config so a proxied dashboard's WebSocket origin is accepted.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    topology: {
      description:
        "Base domain, hostnames and IP discovered from the Caddy model",
      schema: TopologyOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    binary: {
      description: "swamp binary install/update status",
      schema: BinaryOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    serveConfig: {
      description: "The .swamp/serve.yaml written for this server",
      schema: ServeConfigOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    unit: {
      description: "The rendered systemd unit command and environment",
      schema: UnitOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    service: {
      description: "systemd user service status",
      schema: ServiceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    telemetry: {
      description: "OTLP environment applied to the service",
      schema: TelemetryOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    proxy: {
      description: "A reverse-proxy route ensured for one hostname",
      schema: ProxyOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    dns: {
      description: "The A records reconciled for this server",
      schema: DnsOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "Runtime status of the swamp-serve service",
      schema: StatusOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    guidance: {
      description: "Every option with its current value and update command",
      schema: GuidanceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    resolve: {
      description:
        "Read the Caddy model and derive swamp.<baseDomain> / dashboard.<baseDomain> and the host IP; writes nothing but the topology resource",
      arguments: ResolveArgsSchema,
      execute: async (
        _args: z.infer<typeof ResolveArgsSchema>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const facts = await resolveCaddyFromContext(context, g);
        const hosts = hostnamesFor(g, facts);
        context.logger?.info(
          "Resolved {swamp} and {dashboard} from caddy '{caddy}' (host {host}, ip {ip})",
          {
            swamp: hosts.swampHostname,
            dashboard: hosts.dashboardHostname,
            caddy: facts.modelName,
            host: facts.hostFqdn || facts.baseDomain,
            ip: facts.hostIp || "(none)",
          },
        );
        const handle = await context.writeResource("topology", "topology", {
          caddyModel: facts.modelName,
          baseDomain: facts.baseDomain,
          hostFqdn: facts.hostFqdn,
          swampHostname: hosts.swampHostname,
          dashboardHostname: hosts.dashboardHostname,
          hostIp: facts.hostIp,
          zone: facts.zone,
          tlsEmail: facts.tlsEmail,
          resolvedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    installBinary: {
      description:
        "Install the swamp binary when absent (pinned installVersion), otherwise report the current version; never overwrites an existing binary",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const binPath = expandHome(g.swampBinPath);
        const version = args.version ?? g.installVersion;

        let present = false;
        try {
          await Deno.stat(binPath);
          present = true;
        } catch {
          present = false;
        }

        const current = await runSwamp(["--version"]).then((r) =>
          r.code === 0 ? r.stdout.trim() : ""
        ).catch(() => "");

        let installed = current;
        if (!present || args.force) {
          const installArgs = version
            ? ["-s", "--", "-V", version]
            : ["-s", "--"];
          const out = await runCommand("sh", [
            "-c",
            `curl -fsSL ${INSTALL_SH_URL} | sh ${installArgs.join(" ")}`,
          ]);
          if (out.code !== 0) {
            throw new Error(
              `installing swamp failed (exit ${out.code}): ${
                (out.stderr || out.stdout).trim()
              }`,
            );
          }
          installed = (await runSwamp(["--version"])).stdout.trim();
        }

        context.logger?.info(
          present && !args.force
            ? "swamp binary already present at {path} ({version})"
            : "Installed swamp {version} at {path}",
          { path: binPath, version: installed || "(unknown)" },
        );
        const handle = await context.writeResource("binary", "binary", {
          path: binPath,
          present: true,
          version: installed,
          updated: !present || args.force,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    updateBinary: {
      description:
        "Update the swamp binary with `swamp update` and restart the service so it execs the new build",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const check = await runSwamp(["update", "--check", "--json"]);
        const before = extractVersion(check.stdout);
        const out = await runSwamp(["update", "--json"]);
        if (out.code !== 0) {
          throw new Error(
            `swamp update failed (exit ${out.code}): ${
              (out.stderr || out.stdout).trim()
            }`,
          );
        }
        const after = (await runSwamp(["--version"])).stdout.trim();

        // Restart so the running service picks up the replaced binary.
        let restarted = true;
        try {
          await callSystemd(context, "restartService", unitNameFor(g), {
            serviceName: unitNameFor(g),
          });
        } catch (err) {
          restarted = false;
          context.logger?.warn?.(
            "service restart after update failed: {error}",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }

        context.logger?.info(
          "swamp update {from} -> {to} (service restarted: {restarted})",
          {
            from: before || "(unknown)",
            to: after || "(unknown)",
            restarted,
          },
        );
        const handle = await context.writeResource("binary", "binary", {
          path: expandHome(g.swampBinPath),
          present: true,
          version: after,
          updated: before !== after,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description:
        "Write .swamp/serve.yaml for the configured options and validate it with `swamp serve check-config`",
      arguments: ConfigureArgsSchema,
      execute: async (
        _args: z.infer<typeof ConfigureArgsSchema>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const path = configPathFor(g);
        const trustedHosts = await resolveTrustedHosts(context, g);
        const yaml = renderServeConfigYaml(g, trustedHosts);
        const slash = path.lastIndexOf("/");
        if (slash > 0) {
          await Deno.mkdir(path.slice(0, slash), { recursive: true });
        }
        await Deno.writeTextFile(path, yaml);

        const check = await runSwamp([
          "serve",
          "check-config",
          "--config",
          g.configPath,
          "--auth-mode",
          g.authMode,
          ...(g.admins ? ["--admins", g.admins] : []),
        ]);
        if (check.code !== 0) {
          context.logger?.warn?.(
            "serve check-config reported a problem (exit {code}): {message}",
            {
              code: check.code,
              message: (check.stderr || check.stdout).trim(),
            },
          );
        }

        context.logger?.info("Wrote serve config to {path}", { path });
        const handle = await context.writeResource(
          "serveConfig",
          "serveConfig",
          {
            path,
            written: true,
            port: g.port,
            host: g.host,
            dashboard: g.dashboard,
            hotReload: g.hotReload,
            autoResume: g.autoResume,
            authMode: g.authMode,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    ensureService: {
      description:
        "Render the systemd unit (command + OTLP environment) and create/start it via @svendowideit/systemd-service",
      arguments: EnsureServiceArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureServiceArgsSchema>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }, { name: string }] }> => {
        const g = context.globalArgs;
        const telemetry = await resolveTelemetry(context, g);
        const trustedHosts = await resolveTrustedHosts(context, g);
        const unit = renderUnit(g, telemetry, trustedHosts);
        const name = unitNameFor(g);

        await callSystemd(context, "createService", name, {
          serviceName: name,
          command: unit.execStart,
          description: `swamp serve (${g.repoDir})`,
          workingDirectory: unit.workingDirectory,
          environment: unit.environment,
          restart: "always",
          restartSec: "5",
          after: ["network-online.target"],
          wants: ["network-online.target"],
        });

        const method = args.restart ? "restartService" : "startService";
        await callSystemd(context, method, name, { serviceName: name });

        context.logger?.info(
          "swamp-serve service {name} is {state} (port {port})",
          { name, state: args.restart ? "restarted" : "started", port: g.port },
        );
        // Write the unit resource only after the service is up, so a failed
        // create/start leaves no "written" unit behind.
        const unitHandle = await context.writeResource("unit", "unit", {
          serviceName: name,
          execStart: unit.execStart,
          environment: unit.environment,
          workingDirectory: unit.workingDirectory,
          written: true,
        });
        const serviceHandle = await context.writeResource(
          "service",
          "service",
          {
            serviceName: name,
            active: true,
            enabled: true,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [unitHandle, serviceHandle] };
      },
    },

    ensureTelemetry: {
      description:
        "Read the otel-settings contract, render the OTLP environment onto the service, and restart it",
      arguments: EnsureTelemetryArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureTelemetryArgsSchema>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        if (!g.otelSettingsModel) {
          throw new Error(
            "otelSettingsModel is required for ensureTelemetry — name the " +
              "@svendowideit/otel-settings model whose contract describes the gateway.",
          );
        }
        const settings = await latestData(
          context,
          "@svendowideit/otel-settings",
          "settings",
          g.otelSettingsModel,
        );
        if (!settings) {
          throw new Error(
            `no rendered settings found for '${g.otelSettingsModel}' — run ` +
              `\`swamp model method run ${g.otelSettingsModel} render\` first.`,
          );
        }
        const token = await readTelemetryToken(context, g);
        const telemetry = buildTelemetryEnv(
          settings as Parameters<typeof buildTelemetryEnv>[0],
          { endpoint: args.endpoint, serviceName: g.otelServiceName, token },
        );

        // Recreate the unit with the new environment, then restart.
        const name = unitNameFor(g);
        const trustedHosts = await resolveTrustedHosts(context, g);
        const unit = renderUnit(g, telemetry, trustedHosts);
        await callSystemd(context, "createService", name, {
          serviceName: name,
          command: unit.execStart,
          description: `swamp serve (${g.repoDir})`,
          workingDirectory: unit.workingDirectory,
          environment: unit.environment,
          restart: "always",
          restartSec: "5",
          force: true,
        });
        await callSystemd(context, "restartService", name, {
          serviceName: name,
        });

        context.logger?.info(
          "Telemetry applied: {signals}; stacks unsupported (see README)",
          { signals: telemetry.signals.join(",") },
        );
        const handle = await context.writeResource("telemetry", "telemetry", {
          enabled: !!telemetry.endpoint,
          endpoint: telemetry.endpoint,
          serviceName: telemetry.serviceName,
          headers: telemetry.headers ? "Authorization=Bearer ***" : "",
          resourceAttributes: telemetry.resourceAttributes,
          stacks: STACKS_SUPPORTED
            ? "exported"
            : "unsupported (documented gap — swamp's OTel SDK exports logs/metrics/traces only)",
          signals: telemetry.signals,
          appliedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    ensureDns: {
      description:
        "Reconcile the A records for swamp.<base> and dashboard.<base> via the configured Caddy model",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const facts = await resolveCaddyFromContext(context, g);
        const hosts = hostnamesFor(g, facts);
        if (!facts.hostIp) {
          throw new Error(
            `caddy model '${facts.modelName}' has no A/AAAA record for ` +
              `'${facts.baseDomain}'; add one so the new hostnames have an IP ` +
              "(see the caddy README's static-records section).",
          );
        }
        const records = [
          {
            name: hosts.swampHostname,
            type: "A",
            value: [facts.hostIp],
            zone: facts.zone,
          },
          {
            name: hosts.dashboardHostname,
            type: "A",
            value: [facts.hostIp],
            zone: facts.zone,
          },
        ];
        // A Caddy model reconciles the records in ITS OWN dnsRecords global;
        // a method must not edit another definition's persisted globals, and a
        // per-run override does not reach Caddy via runModel. So this method
        // verifies coverage and reports the exact records the Caddy model must
        // own — the site workflow declares them (see @figy/swamp-serve-bootstrap).
        const desired = await readModelResource(
          context,
          facts.modelName,
          "desired",
        );
        const existing = Array.isArray(desired?.dnsRecords)
          ? (desired!.dnsRecords as Array<Record<string, unknown>>)
          : [];
        const owned = new Set(
          existing.map((r) => String(r.name).toLowerCase()),
        );
        const missing = records.filter(
          (r) => !owned.has(r.name.toLowerCase()),
        );
        const applied = missing.length === 0;
        if (applied) {
          context.logger?.info(
            "Both hostnames are already in caddy '{caddy}' dnsRecords ({swamp}, {dashboard})",
            {
              caddy: facts.modelName,
              swamp: hosts.swampHostname,
              dashboard: hosts.dashboardHostname,
            },
          );
        } else {
          context.logger?.warn?.(
            "caddy '{caddy}' does not own {count} record(s); add them to its " +
              "dnsRecords global (e.g. `swamp model edit {caddy} --global-arg " +
              "'dnsRecords=[...]'`) and re-run. Records needed: {records}",
            {
              caddy: facts.modelName,
              count: missing.length,
              records: missing.map((r) => `${r.name} A ${r.value[0]}`).join(
                ", ",
              ),
            },
          );
        }
        const handle = await context.writeResource("dns", "dns", {
          records,
          applied,
          appliedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    ensureProxy: {
      description:
        "Reverse-proxy swamp.<base> and dashboard.<base> to the server via @svendowideit/caddy",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const facts = await resolveCaddyFromContext(context, g);
        const hosts = hostnamesFor(g, facts);
        const upstream = `${g.host}:${g.port}`;

        const results: Array<Record<string, unknown>> = [];
        // swamp.<host> proxies the serve API root; dashboard.<host> serves
        // swamp's /dashboard at the host root (rootPath rewrites only "/").
        const routes = [
          { hostname: hosts.swampHostname, rootPath: "" },
          { hostname: hosts.dashboardHostname, rootPath: "/dashboard" },
        ];
        for (const r of routes) {
          await callCaddy(context, facts.modelName, "ensureDnsProxy", {
            hostname: r.hostname,
            upstream,
            rootPath: r.rootPath,
          });
          results.push({ ...r, upstream, changed: true });
        }
        context.logger?.info(
          "Proxied {swamp} and {dashboard} to {upstream}",
          {
            swamp: hosts.swampHostname,
            dashboard: hosts.dashboardHostname,
            upstream,
          },
        );
        const handle = await context.writeResource("proxy", "proxy", {
          hostname: hosts.swampHostname,
          upstream,
          changed: true,
          ensuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report systemd state, the HTTP status of both hostnames, the swamp version and the telemetry summary",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const name = unitNameFor(g);
        const svc = await runCommand("systemctl", [
          "--user",
          "is-active",
          `${name}.service`,
        ]);
        const active = svc.stdout.trim() === "active";
        const enabledOut = await runCommand("systemctl", [
          "--user",
          "is-enabled",
          `${name}.service`,
        ]);
        const enabled = enabledOut.stdout.trim() === "enabled";
        const version = (await runSwamp(["--version"])).stdout.trim();

        let facts: CaddyFacts | null = null;
        try {
          facts = await resolveCaddyFromContext(context, g);
        } catch {
          facts = null;
        }
        const swampHost = facts
          ? hostnamesFor(g, facts).swampHostname
          : g.swampHostname;
        const dashHost = facts
          ? hostnamesFor(g, facts).dashboardHostname
          : g.dashboardHostname;
        const swampHttp = await httpStatus(
          `https://${swampHost}/`,
        );
        const dashHttp = await httpStatus(`https://${dashHost}/dashboard`);

        const telemetry = await latestData(
          context,
          "@svendowideit/swamp-serve",
          "telemetry",
        );

        context.logger?.info(
          "swamp-serve {name}: active={active} enabled={enabled} {swamp}={s} {dash}={d}",
          {
            name,
            active,
            enabled,
            swamp: swampHost,
            s: swampHttp,
            dash: dashHost,
            d: dashHttp,
          },
        );
        const handle = await context.writeResource("status", "status", {
          serviceActive: active,
          serviceEnabled: enabled,
          swampVersion: version,
          swampHostHttp: swampHttp,
          dashboardHostHttp: dashHttp,
          telemetryEndpoint: String(telemetry?.endpoint ?? ""),
          telemetryStacks: String(telemetry?.stacks ?? ""),
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    guidance: {
      description:
        "Print every option with its current value, default and the exact command to persist a change",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const options = describeOptions(g);
        const lines = [
          "swamp-serve options (current → default, and how to change):",
          "",
          ...options.map((o) =>
            `  ${o.key.padEnd(22)} ${
              String(o.current || "(unset)").padEnd(28)
            }` +
            `default: ${o.defaultValue.padEnd(24)} ${o.description}`
          ),
          "",
          "Telemetry environment written to the unit:",
          ...telemetryEnvDescription().map((e) =>
            `  ${e.key.padEnd(34)} ${e.purpose}`
          ),
          "",
          "Stacks/profile signal: " +
          (STACKS_SUPPORTED
            ? "exported"
            : "not exported by swamp's OTel SDK — documented gap"),
        ];
        context.logger?.info(lines.join("\n"));
        const handle = await context.writeResource("guidance", "guidance", {
          options,
          generatedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    remove: {
      description:
        "Stop and remove the swamp-serve unit and (optionally) its Caddy routes; the swamp binary is left in place",
      arguments: RemoveArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveArgsSchema>,
        context: ResourceContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const name = unitNameFor(g);
        if (args.removeRoutes) {
          try {
            const facts = await resolveCaddyFromContext(context, g);
            const hosts = hostnamesFor(g, facts);
            for (
              const hostname of [hosts.swampHostname, hosts.dashboardHostname]
            ) {
              try {
                await callCaddy(
                  context,
                  facts.modelName,
                  "removeProxyService",
                  {
                    serviceName: hostname,
                  },
                );
              } catch (err) {
                context.logger?.warn?.(
                  "removeProxyService {host} failed: {error}",
                  {
                    host: hostname,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              }
            }
          } catch (err) {
            context.logger?.warn?.(
              "could not remove Caddy routes: {error}",
              { error: err instanceof Error ? err.message : String(err) },
            );
          }
        }
        await callSystemd(context, "removeService", name, {
          serviceName: name,
        });
        context.logger?.info(
          "Removed swamp-serve service {name}; the swamp binary was left in place",
          { name },
        );
        const handle = await context.writeResource("service", "service", {
          serviceName: name,
          active: false,
          enabled: false,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Cross-model call helpers
// ---------------------------------------------------------------------------

/**
 * Invoke a method on the `@svendowideit/systemd-service` type through
 * `context.runModel` — the sanctioned in-process cross-model call. A CLI
 * subprocess reloads the extensions and re-locks the datastore, which deadlocks
 * when the caller (this model) already holds its own data lock. Falls back to
 * throwing a clear error if `runModel` is unavailable (e.g. remote execution).
 *
 * The inner definition name is `systemdDefinitionName(...)`, deliberately
 * distinct from this model's own name so direct-type execution cannot resolve
 * back to the caller.
 */
async function callSystemd(
  context: ResourceContext,
  method: string,
  serviceName: string,
  inputs: Record<string, unknown>,
): Promise<void> {
  const name = systemdDefinitionName(
    serviceName,
    context.definition?.name ?? "",
  );
  if (!context.runModel) {
    throw new Error(
      "cross-model calls require context.runModel, which is unavailable here " +
        "(remote execution). Run ensureService on the orchestrator.",
    );
  }
  const result = await context.runModel({
    modelType: "@svendowideit/systemd-service",
    name,
    method,
    arguments: inputs,
  });
  if (!result.ok) {
    throw new Error(
      `${method} (systemd-service) failed: ${result.error.message}`,
    );
  }
}

/**
 * Invoke a method on the configured Caddy definition through `context.runModel`.
 * Caddy is a user-authored definition (name-based), not direct-type, so the
 * call targets the definition by name.
 */
async function callCaddy(
  context: ResourceContext,
  caddyModel: string,
  method: string,
  inputs: Record<string, unknown>,
): Promise<void> {
  if (!context.runModel) {
    throw new Error(
      "cross-model calls require context.runModel, which is unavailable here " +
        "(remote execution). Run ensureDns/ensureProxy on the orchestrator.",
    );
  }
  const result = await context.runModel({
    definition: caddyModel,
    method,
    arguments: inputs,
  });
  if (!result.ok) {
    throw new Error(
      `${method} (caddy ${caddyModel}) failed: ${result.error.message}`,
    );
  }
}

/** Read the gateway bearer token from the vault, when one is configured. */
async function readTelemetryToken(
  context: ResourceContext,
  g: GlobalArgs,
): Promise<string> {
  if (!g.telemetryVault || !context.vaultService) return "";
  try {
    return await context.vaultService.get(
      g.telemetryVault,
      g.authRef,
      "swamp-serve.ensureTelemetry",
    );
  } catch {
    return "";
  }
}

/** Resolve the OTLP environment from the settings contract, or null. */
async function resolveTelemetry(
  context: ResourceContext,
  g: GlobalArgs,
): Promise<TelemetryEnv | null> {
  if (!g.otelSettingsModel) return null;
  const settings = await latestData(
    context,
    "@svendowideit/otel-settings",
    "settings",
    g.otelSettingsModel,
  );
  if (!settings) return null;
  const token = await readTelemetryToken(context, g);
  return buildTelemetryEnv(
    settings as Parameters<typeof buildTelemetryEnv>[0],
    { serviceName: g.otelServiceName, token },
  );
}

/** Extract the version tuple from `swamp update --check --json` output. */
export function extractVersion(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return String(parsed.currentVersion ?? parsed.version ?? "");
  } catch {
    return "";
  }
}

/** HEAD/GET a URL and return the HTTP status, or 0 on failure. */
async function httpStatus(url: string): Promise<number> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  } catch {
    return 0;
  }
}
