/**
 * @svendowideit/otel-settings
 *
 * The single source of truth for a fleet's observability contract. It resolves
 * one typed settings document — endpoint names, OTLP config, resource-attribute
 * conventions, sampling, retention, and per-tier agent defaults — and renders
 * it as:
 *
 *   - a `settings` **resource** every other model references via CEL, and
 *   - the **HTTP document set** (`otel.json`, `otel.env`, per-tier agent
 *     configs, install manifests, feature flags, and human-readable
 *     `.md`/`.html`) written to a directory that `@svendowideit/caddy` serves
 *     with `file_server` (via `@svendowideit/settings-server`).
 *
 * All model and method logic is pure and exported for unit testing; the file
 * system writes are the only side effect and happen in the `render` method.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const TierDefaultsSchema = z.object({
  agent: z.string().describe(
    "Agent/collector variant for the tier (e.g. otelcol-contrib, otelcol-reduced, sdk, none)",
  ),
  memoryLimitMiB: z.number().int().positive().optional().describe(
    "Soft memory limit for the agent in MiB",
  ),
  receivers: z.array(z.string()).default([]).describe(
    "Enabled receivers for the tier (e.g. hostmetrics, filelog, otlp)",
  ),
  push: z.boolean().default(true).describe(
    "Whether the tier pushes telemetry; false means central scrape only",
  ),
});

const TierSchema = z.object({
  id: z.string().describe("Tier id (e.g. T0, T1, T2, T3, T4)"),
  description: z.string().default("").describe("Human description of the tier"),
  defaults: TierDefaultsSchema,
});

const EndpointSchema = z.object({
  otlp_grpc: z.string().describe("OTLP gRPC endpoint host:port"),
  otlp_http: z.string().describe("OTLP HTTP endpoint host:port"),
  otlp_grpc_url: z.string().default("").describe("Full grpc:// URL"),
  otlp_http_url: z.string().default("").describe("Full http(s):// URL"),
  mesh: z.string().default("").describe("Mesh this endpoint is reachable on"),
});

// ---------------------------------------------------------------------------
// Public interfaces (explicit, so exported helpers expose only public types)
// ---------------------------------------------------------------------------

/** The full contract input (mirrors the model's global args). */
export interface SettingsInput {
  /** Observability zone (endpoint names derive under it). */
  domain: string;
  /** deployment.environment resource attribute (dev / uat / prod). */
  deploymentEnvironment: string;
  /** `site` resource attribute. */
  site: string;
  /** `owner` resource attribute. */
  owner: string;
  /** Gateway endpoints (one per mesh). */
  endpoints: Endpoint[];
  /** Mesh advertised as the default OTLP endpoint. */
  defaultMesh: string;
  /** Extra resource attributes merged into every agent config. */
  attributes: Record<string, string>;
  /** Sampling policy. */
  sampling: Record<string, unknown>;
  /** Retention by signal, in days. */
  retention: Record<string, unknown>;
  /** Maximum active metric series for the fleet. */
  cardinalityBudget: number;
  /** Device tiers with agent defaults. */
  tiers: Tier[];
  /** Release-asset base URL (derived when empty). */
  installBaseUrl: string;
  /** Root directory for rendered documents. */
  outputDir: string;
  /** How agents authenticate to the gateway (bearer / mtls / none). */
  authMethod: string;
}

/** Agent defaults for a device tier. */
export interface TierDefaults {
  /** Agent/collector variant for the tier. */
  agent: string;
  /** Soft memory limit for the agent in MiB. */
  memoryLimitMiB?: number;
  /** Enabled receivers for the tier. */
  receivers: string[];
  /** Whether the tier pushes telemetry. */
  push: boolean;
}

/** A device tier and its agent defaults. */
export interface Tier {
  /** Tier id (e.g. T0, T1, T2, T3, T4). */
  id: string;
  /** Human description of the tier. */
  description: string;
  /** Agent defaults for the tier. */
  defaults: TierDefaults;
}

/** A gateway endpoint as supplied in global args. */
export interface Endpoint {
  /** OTLP gRPC endpoint host:port. */
  otlp_grpc: string;
  /** OTLP HTTP endpoint host:port. */
  otlp_http: string;
  /** Full grpc:// URL. */
  otlp_grpc_url: string;
  /** Full http(s):// URL. */
  otlp_http_url: string;
  /** Mesh this endpoint is reachable on. */
  mesh: string;
}

/** A resolved gateway endpoint (full URLs always populated). */
export interface EndpointOutput {
  /** Endpoint name (mesh, or the grpc address). */
  name: string;
  /** Mesh this endpoint is reachable on. */
  mesh: string;
  /** OTLP gRPC endpoint host:port. */
  otlp_grpc: string;
  /** OTLP HTTP endpoint host:port. */
  otlp_http: string;
  /** Full https:// URL for gRPC. */
  otlp_grpc_url: string;
  /** Full https:// URL for HTTP. */
  otlp_http_url: string;
}

/** The resolved observability contract. */
export interface Settings {
  /** Observability zone. */
  domain: string;
  /** deployment.environment attribute. */
  deploymentEnvironment: string;
  /** site attribute. */
  site: string;
  /** owner attribute. */
  owner: string;
  /** Resolved gateway endpoints. */
  endpoints: EndpointOutput[];
  /** Default endpoint mesh. */
  defaultMesh: string;
  /** Extra resource attributes. */
  attributes: Record<string, string>;
  /** Sampling policy. */
  sampling: Record<string, unknown>;
  /** Retention by signal, in days. */
  retention: Record<string, unknown>;
  /** Maximum active metric series. */
  cardinalityBudget: number;
  /** Resolved device tiers. */
  tiers: Tier[];
  /** Release-asset base URL. */
  installBaseUrl: string;
  /** How agents authenticate. */
  authMethod: string;
  /** https settings URL (settings.<domain>). */
  settingsUrl: string;
  /** Stable content hash of the contract. */
  contentHash: string;
  /** Render timestamp. */
  renderedAt: string;
}

/** A rendered document's manifest entry. */
export interface Document {
  /** Document path relative to the settings root. */
  path: string;
  /** HTTP content type. */
  contentType: string;
  /** Byte length. */
  bytes: number;
  /** SHA-256 of the content. */
  sha256: string;
}

const GlobalArgsSchema = z.object({
  domain: z.string().describe(
    "Base observability zone (e.g. otel.fi.gy); endpoint names are derived under it",
  ),
  deploymentEnvironment: z.string().default("dev").describe(
    "deployment.environment resource attribute (dev / uat / prod)",
  ),
  site: z.string().default("").describe("`site` resource attribute"),
  owner: z.string().default("").describe("`owner` resource attribute"),
  endpoints: z.array(EndpointSchema).default([]).describe(
    "Gateway endpoints (one per mesh); the first is the default",
  ),
  defaultMesh: z.string().default("").describe(
    "Mesh to advertise as the default OTLP endpoint",
  ),
  attributes: z.record(z.string(), z.string()).default({}).describe(
    "Extra resource attributes merged into every agent config",
  ),
  sampling: z.record(z.string(), z.unknown()).default({}).describe(
    "Sampling policy (e.g. {head_percent: 100, tail_rules: []})",
  ),
  retention: z.record(z.string(), z.unknown()).default({}).describe(
    "Retention by signal, in days (e.g. {logs: 14, metrics: 90, traces: 7})",
  ),
  cardinalityBudget: z.number().int().positive().default(100000).describe(
    "Maximum active metric series budget for the fleet",
  ),
  tiers: z.array(TierSchema).default([]).describe(
    "Device tiers with their agent defaults; defaults are provided when empty",
  ),
  installBaseUrl: z.string().default("").describe(
    "Base URL for release assets; empty derives https://<domain>/settings/install",
  ),
  outputDir: z.string().default("~/.local/share/otel-settings").describe(
    "Root directory for rendered documents (a `current` pointer is written inside)",
  ),
  authMethod: z.string().default("bearer").describe(
    "How agents authenticate to the gateway (bearer / mtls / none)",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RenderArgsSchema = z.object({
  outputDir: z.string().optional().describe(
    "Override the output directory (defaults to global outputDir)",
  ),
  version: z.string().optional().describe(
    "Explicit content version/hash; computed from the contract when omitted",
  ),
});

const ValidateArgsSchema = z.object({});
const StatusArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const EndpointOutputSchema = z.object({
  name: z.string(),
  mesh: z.string(),
  otlp_grpc: z.string(),
  otlp_http: z.string(),
  otlp_grpc_url: z.string(),
  otlp_http_url: z.string(),
});

const SettingsOutputSchema = z.object({
  domain: z.string(),
  deploymentEnvironment: z.string(),
  site: z.string(),
  owner: z.string(),
  endpoints: z.array(EndpointOutputSchema),
  defaultMesh: z.string(),
  attributes: z.record(z.string(), z.string()),
  sampling: z.record(z.string(), z.unknown()),
  retention: z.record(z.string(), z.unknown()),
  cardinalityBudget: z.number(),
  tiers: z.array(TierSchema),
  installBaseUrl: z.string(),
  authMethod: z.string(),
  settingsUrl: z.string(),
  contentHash: z.string(),
  renderedAt: z.string(),
});

const DocumentSchema = z.object({
  path: z.string(),
  contentType: z.string(),
  bytes: z.number(),
  sha256: z.string(),
});

const RenderOutputSchema = z.object({
  version: z.string(),
  contentHash: z.string(),
  outputDir: z.string(),
  documents: z.array(DocumentSchema),
  renderedAt: z.string(),
});

const ValidateOutputSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  checkedAt: z.string(),
});

const StatusOutputSchema = z.object({
  domain: z.string(),
  endpointCount: z.number(),
  tierCount: z.number(),
  deploymentEnvironment: z.string(),
  settingsUrl: z.string(),
  rendered: z.boolean(),
  outputDir: z.string(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** The five standard device tiers, used when the caller supplies none. */
export const DEFAULT_TIERS: Tier[] = [
  {
    id: "T0",
    description: "Containers and workloads; send via OTLP SDK or sidecar",
    defaults: {
      agent: "sdk",
      receivers: ["otlp"],
      push: true,
    },
  },
  {
    id: "T1",
    description: "x86 servers, VMs and large SBCs",
    defaults: {
      agent: "otelcol-contrib",
      memoryLimitMiB: 512,
      receivers: ["hostmetrics", "filelog", "otlp"],
      push: true,
    },
  },
  {
    id: "T2",
    description: "Small SBCs (1–4 GB ARM); reduced collector",
    defaults: {
      agent: "otelcol-reduced",
      memoryLimitMiB: 128,
      receivers: ["hostmetrics", "otlp"],
      push: true,
    },
  },
  {
    id: "T3",
    description: "Switches, cameras, appliances; central scrape only",
    defaults: {
      agent: "none",
      receivers: [],
      push: false,
    },
  },
  {
    id: "T4",
    description: "Immutable nodes; agent baked into the image",
    defaults: {
      agent: "otelcol-sysext",
      memoryLimitMiB: 256,
      receivers: ["hostmetrics", "otlp"],
      push: true,
    },
  },
];

/** Resolve the tier list, falling back to the standard five when empty. */
export function resolveTiers(
  tiers: Tier[],
): Tier[] {
  return tiers.length > 0 ? tiers : DEFAULT_TIERS;
}

/** Derive the settings URL for a zone (always `settings.<domain>`). */
export function settingsUrl(domain: string): string {
  const host = domain.startsWith("settings.") ? domain : `settings.${domain}`;
  return `https://${host}`;
}

/** Derive the install base URL when one is not supplied. */
export function installBaseUrl(domain: string, override = ""): string {
  return override || `https://settings.${domain}/settings/install`;
}

/** Normalise an endpoint, filling in full URLs from host:port when absent. */
export function normaliseEndpoint(
  e: Endpoint,
): EndpointOutput {
  return {
    name: e.mesh || e.otlp_grpc,
    mesh: e.mesh,
    otlp_grpc: e.otlp_grpc,
    otlp_http: e.otlp_http,
    otlp_grpc_url: e.otlp_grpc_url || `https://${e.otlp_grpc}`,
    otlp_http_url: e.otlp_http_url || `https://${e.otlp_http}`,
  };
}

/**
 * Pick the default endpoint: the one on `defaultMesh`, else the first.
 */
export function defaultEndpoint(
  endpoints: EndpointOutput[],
  defaultMesh: string,
): EndpointOutput | null {
  if (endpoints.length === 0) return null;
  if (defaultMesh) {
    const match = endpoints.find((e) => e.mesh === defaultMesh);
    if (match) return match;
  }
  return endpoints[0];
}

/** Build the resolved settings object from global args. */
export function buildSettings(
  g: SettingsInput,
): Settings {
  const tiers = resolveTiers(g.tiers);
  const endpoints = g.endpoints.map(normaliseEndpoint);
  const base = {
    domain: g.domain,
    deploymentEnvironment: g.deploymentEnvironment,
    site: g.site,
    owner: g.owner,
    endpoints,
    defaultMesh: g.defaultMesh,
    attributes: g.attributes,
    sampling: g.sampling,
    retention: g.retention,
    cardinalityBudget: g.cardinalityBudget,
    tiers,
    installBaseUrl: installBaseUrl(g.domain, g.installBaseUrl),
    authMethod: g.authMethod,
    settingsUrl: settingsUrl(g.domain),
    renderedAt: new Date().toISOString(),
  };
  // contentHash covers the contract, not the render timestamp, so identical
  // settings yield an identical version and cache keys stay stable.
  const contentHash = contentHashHex(JSON.stringify({
    ...base,
    renderedAt: undefined,
  }));
  return { ...base, contentHash };
}

/** Render the machine-readable `otel.json` contract. */
export function renderOtelJson(
  s: Settings,
): string {
  const def = defaultEndpoint(s.endpoints, s.defaultMesh);
  return JSON.stringify(
    {
      schema: "otel.settings/v1",
      version: s.contentHash,
      domain: s.domain,
      deploymentEnvironment: s.deploymentEnvironment,
      site: s.site,
      owner: s.owner,
      authMethod: s.authMethod,
      endpoints: s.endpoints,
      default: def,
      resourceAttributes: {
        "deployment.environment": s.deploymentEnvironment,
        ...(s.site ? { site: s.site } : {}),
        ...(s.owner ? { owner: s.owner } : {}),
        ...s.attributes,
      },
      sampling: s.sampling,
      retention: s.retention,
      cardinalityBudget: s.cardinalityBudget,
      tiers: s.tiers,
      installBaseUrl: s.installBaseUrl,
    },
    null,
    2,
  ) + "\n";
}

/** Render the `OTEL_EXPORTER_OTLP_*` environment block. */
export function renderOtelEnv(
  s: Settings,
): string {
  const def = defaultEndpoint(s.endpoints, s.defaultMesh);
  const lines = [
    `# Generated by @svendowideit/otel-settings v${s.contentHash}`,
    `# deployment.environment=${s.deploymentEnvironment}`,
  ];
  if (def) {
    lines.push(`OTEL_EXPORTER_OTLP_ENDPOINT=${def.otlp_grpc_url}`);
    lines.push(`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${def.otlp_http_url}`);
    lines.push(`OTEL_EXPORTER_OTLP_PROTOCOL=grpc`);
  }
  lines.push(
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=${s.deploymentEnvironment}` +
      (s.site ? `,site=${s.site}` : "") +
      (s.owner ? `,owner=${s.owner}` : ""),
  );
  lines.push(`OTEL_SERVICE_NAMESPACE=${s.domain}`);
  return lines.join("\n") + "\n";
}

/** Render a per-tier agent config fragment (YAML text). */
export function renderAgentConfig(
  tier: Tier,
  s: Settings,
): string {
  const def = defaultEndpoint(s.endpoints, s.defaultMesh);
  const exporterEndpoint = def?.otlp_grpc ?? "";
  const receivers = tier.defaults.receivers.map((r) => `      - ${r}`).join(
    "\n",
  );
  return [
    `# Generated by @svendowideit/otel-settings v${s.contentHash}`,
    `tier: ${tier.id}`,
    `description: ${JSON.stringify(tier.description)}`,
    `agent: ${tier.defaults.agent}`,
    tier.defaults.memoryLimitMiB
      ? `memoryLimitMiB: ${tier.defaults.memoryLimitMiB}`
      : "memoryLimitMiB: null",
    `push: ${tier.defaults.push}`,
    "receivers:",
    receivers || "      []",
    "exporters:",
    "  otlp:",
    `    endpoint: ${exporterEndpoint}`,
    `    auth: ${s.authMethod}`,
    "resourceAttributes:",
    `  deployment.environment: ${s.deploymentEnvironment}`,
    `  site: ${s.site}`,
    `  domain: ${s.domain}`,
  ].join("\n") + "\n";
}

/** Render an install/upgrade manifest for an os/arch pair. */
export function renderInstallManifest(
  os: string,
  arch: string,
  s: Settings,
): string {
  return JSON.stringify(
    {
      schema: "otel.install/v1",
      version: s.contentHash,
      os,
      arch,
      tarballUrl: `${s.installBaseUrl}/otelcol-contrib_${os}_${arch}.tar.gz`,
      checksumUrl: `${s.installBaseUrl}/otelcol-contrib_${os}_${arch}.sha256`,
      settingsUrl: `${s.settingsUrl}/otel.json`,
      agentConfigBase: `${s.settingsUrl}/agent-config`,
    },
    null,
    2,
  ) + "\n";
}

/** Render the human-readable `otel.md` summary. */
export function renderOtelMarkdown(
  s: Settings,
): string {
  const def = defaultEndpoint(s.endpoints, s.defaultMesh);
  const endpointRows = s.endpoints.map((e) =>
    `| ${e.mesh || "(default)"} | ${e.otlp_grpc} | ${e.otlp_http} |`
  ).join("\n");
  const tierRows = s.tiers.map((t) =>
    `| ${t.id} | ${t.defaults.agent} | ${
      t.defaults.push ? "push" : "scrape"
    } | ${t.description} |`
  ).join("\n");
  return [
    `# Observability settings — ${s.domain}`,
    "",
    `Environment: **${s.deploymentEnvironment}** · version \`${s.contentHash}\``,
    "",
    "## Endpoints",
    "",
    "| Mesh | OTLP gRPC | OTLP HTTP |",
    "| --- | --- | --- |",
    endpointRows || "| (no endpoints configured) | | |",
    "",
    `Default: \`${def?.otlp_grpc ?? "(none)"}\``,
    "",
    "## Tiers",
    "",
    "| Tier | Agent | Mode | Description |",
    "| --- | --- | --- | --- |",
    tierRows,
    "",
    "## Retention",
    "",
    "```json",
    JSON.stringify(s.retention, null, 2),
    "```",
    "",
  ].join("\n");
}

/** Render `version.json` with the content hash and available documents. */
export function renderVersionJson(
  s: Settings,
  docs: Document[],
): string {
  return JSON.stringify(
    {
      schema: "otel.settings-version/v1",
      version: s.contentHash,
      renderedAt: s.renderedAt,
      documents: docs.map((d) => d.path),
    },
    null,
    2,
  ) + "\n";
}

/** Escape text for safe inclusion in HTML. */
function escHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Render a human-facing `index.html` for the settings root, so `GET /` on the
 * settings host is a useful page rather than a 404: it says what this server is,
 * what the contract means, and links every document with a one-line purpose.
 */
export function renderIndexHtml(s: Settings): string {
  const def = defaultEndpoint(s.endpoints, s.defaultMesh);
  const endpointRows = s.endpoints.map((e) =>
    `<tr><td>${escHtml(e.mesh || "(default)")}</td>` +
    `<td><code>${escHtml(e.otlp_grpc)}</code></td>` +
    `<td><code>${escHtml(e.otlp_http)}</code></td></tr>`
  ).join("\n      ");
  const tierRows = s.tiers.map((t) =>
    `<tr><td>${escHtml(t.id)}</td><td><code>${
      escHtml(t.defaults.agent)
    }</code></td>` +
    `<td>${t.defaults.push ? "push" : "scrape"}</td>` +
    `<td>${escHtml(t.description)}</td></tr>`
  ).join("\n      ");
  const docList = [
    [
      "otel.json",
      "Machine-readable contract: endpoints, attributes, sampling, retention, tiers.",
    ],
    ["otel.md", "Human-readable summary of the same contract."],
    [
      "otel.env",
      "Environment variables derived from the contract (OTEL_* and endpoints).",
    ],
    ["version.json", "Content hash and the list of documents in this bundle."],
    [
      "agent-config/T0.yaml … T4.yaml",
      "Per-tier OpenTelemetry Collector configs, keyed by device tier.",
    ],
    [
      "install/linux-amd64.json …",
      "Install/upgrade manifest per os/arch (tarball + checksum URLs).",
    ],
  ].map(([p, d]) =>
    `<li><a href="/${escHtml(p)}"><code>/${escHtml(p)}</code></a> — ${
      escHtml(d)
    }</li>`
  ).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Observability settings — ${escHtml(s.domain)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
           max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.55; }
    h1 { margin-bottom: .2rem; }
    .muted { color: #6b7280; }
    table { border-collapse: collapse; margin: 1rem 0; }
    th, td { text-align: left; padding: .2rem 1rem .2rem 0; vertical-align: top; }
    code { background: rgba(127,127,127,.15); padding: .08rem .35rem; border-radius: .25rem; }
    ul { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <h1>Observability settings</h1>
  <p class="muted">The single source of truth for this fleet's telemetry contract.
  Managed by <code>@svendowideit/otel-settings</code> / <code>@svendowideit/settings-server</code>;
  every host and app fetches endpoints and conventions from here rather than hardcoding them.</p>

  <table>
    <tr><td>Domain</td><td><code>${escHtml(s.domain)}</code></td></tr>
    <tr><td>Environment</td><td>${escHtml(s.deploymentEnvironment)}</td></tr>
    <tr><td>Version</td><td><code>${escHtml(s.contentHash)}</code></td></tr>
    <tr><td>Auth</td><td>${escHtml(s.authMethod)}</td></tr>
  </table>

  <h2>Endpoints</h2>
  <table>
    <tr><th>Mesh</th><th>OTLP gRPC</th><th>OTLP HTTP</th></tr>
      ${endpointRows || '<tr><td colspan="3">(none configured)</td></tr>'}
  </table>
  <p class="muted">Default: <code>${
    escHtml(def?.otlp_grpc ?? "(none)")
  }</code></p>

  <h2>Device tiers</h2>
  <table>
    <tr><th>Tier</th><th>Agent</th><th>Mode</th><th>Description</th></tr>
      ${tierRows}
  </table>

  <h2>Documents</h2>
  <ul>
      ${docList}
  </ul>

  <p class="muted">Generated by <code>@svendowideit/otel-settings</code>.</p>
</body>
</html>
`;
}

/** Compute the full document set as `path -> {content, contentType}`. */
export function buildDocuments(
  s: Settings,
  osArchPairs: Array<{ os: string; arch: string }> = [
    { os: "linux", arch: "amd64" },
    { os: "linux", arch: "arm64" },
  ],
): Array<{ path: string; contentType: string; content: string }> {
  const docs: Array<{ path: string; contentType: string; content: string }> = [
    {
      path: "otel.json",
      contentType: "application/json",
      content: renderOtelJson(s),
    },
    {
      path: "otel.env",
      contentType: "text/plain; charset=utf-8",
      content: renderOtelEnv(s),
    },
    {
      path: "otel.md",
      contentType: "text/markdown; charset=utf-8",
      content: renderOtelMarkdown(s),
    },
    {
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      content: renderIndexHtml(s),
    },
  ];
  for (const tier of s.tiers) {
    docs.push({
      path: `agent-config/${tier.id}.yaml`,
      contentType: "application/yaml; charset=utf-8",
      content: renderAgentConfig(tier, s),
    });
  }
  for (const { os, arch } of osArchPairs) {
    docs.push({
      path: `install/${os}-${arch}.json`,
      contentType: "application/json",
      content: renderInstallManifest(os, arch, s),
    });
  }
  return docs;
}

/**
 * Synchronous content hash (FNV-1a, 128-bit) used as the stable version label
 * for a contract. It only needs to change when the contract content changes, so
 * a fast non-cryptographic hash is sufficient and keeps `buildSettings` pure
 * and synchronous.
 */
export function contentHashHex(input: string): string {
  const data = new TextEncoder().encode(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < data.length; i++) {
    h1 ^= data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + data[i]) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

/** Cryptographic SHA-256 (hex) for document integrity manifests. */
export async function sha256HexAsync(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** Validate global args, returning errors and warnings. */
export function validateSettings(g: SettingsInput): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!g.domain || !g.domain.includes(".")) {
    errors.push("domain must be a dotted zone name (e.g. otel.fi.gy)");
  }
  if (g.domain.includes("://") || g.domain.includes("/")) {
    errors.push("domain must be a bare zone, without scheme or path");
  }
  if (g.endpoints.length === 0) {
    warnings.push("no endpoints configured; rendered documents will be empty");
  }
  for (const e of g.endpoints) {
    if (!e.otlp_grpc && !e.otlp_http) {
      errors.push(
        `endpoint '${e.mesh || "(unnamed)"}' has no grpc or http host:port`,
      );
    }
    if (e.otlp_grpc && e.otlp_grpc.includes("://")) {
      warnings.push(
        `endpoint '${e.mesh}' otlp_grpc should be host:port, not a URL`,
      );
    }
  }
  if (g.defaultMesh && !g.endpoints.some((e) => e.mesh === g.defaultMesh)) {
    warnings.push(
      `defaultMesh '${g.defaultMesh}' matches no endpoint; falling back to the first`,
    );
  }
  if (g.cardinalityBudget <= 0) {
    errors.push("cardinalityBudget must be positive");
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/otel-settings`. */
export const model = {
  type: "@svendowideit/otel-settings",
  version: "2026.10.02.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-settings": {
      description: "Validate the observability contract before rendering",
      labels: ["policy"],
      appliesTo: ["render", "validate", "status"],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const { errors } = validateSettings(context.globalArgs);
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.01.1",
      description:
        "Initial release: resolve one observability contract (endpoints, attributes, sampling, retention, tiers) and render the HTTP document set (otel.json, otel.env, per-tier agent configs, install manifests, markdown).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.1",
      description:
        "Adds a generated index.html to the document set, so the settings host answers GET / with a landing page (what this server is, the endpoints/tiers, and a linked list of every document) instead of a 404 — Caddy's file_server serves it as the directory index. Also fixes the install manifests' settingsUrl/agentConfigBase, which pointed at a /settings/ prefix (e.g. https://settings.otel.fi.gy/settings/otel.json) that is not served; documents are served at the root (/otel.json, /agent-config/...). Schema is additive — existing models upgrade with no changes; re-run render to emit index.html.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    settings: {
      description: "Resolved observability contract",
      schema: SettingsOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    render: {
      description: "Rendered HTTP document set",
      schema: RenderOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    validation: {
      description: "Contract validation result",
      schema: ValidateOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "Settings summary",
      schema: StatusOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    render: {
      description:
        "Resolve the contract, write the HTTP document set, and set the current pointer",
      arguments: RenderArgsSchema,
      execute: async (
        args: z.infer<typeof RenderArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }, { name: string }] }> => {
        const g = context.globalArgs;
        const { errors } = validateSettings(g);
        if (errors.length > 0) {
          throw new Error(`invalid settings: ${errors.join("; ")}`);
        }
        const settings = buildSettings(g);
        const version = args.version ?? settings.contentHash;
        const outputDir = expandHome(args.outputDir ?? g.outputDir);
        const currentDir = `${outputDir}/current`;
        const versionDir = `${outputDir}/v/${version}`;

        const docs = buildDocuments(settings);
        const written: Document[] = [];
        for (const doc of docs) {
          const target = `${versionDir}/${doc.path}`;
          const slash = target.lastIndexOf("/");
          await Deno.mkdir(target.slice(0, slash), { recursive: true });
          await Deno.writeTextFile(target, doc.content);
          const sha256 = await sha256HexAsync(doc.content);
          written.push({
            path: doc.path,
            contentType: doc.contentType,
            bytes: new TextEncoder().encode(doc.content).length,
            sha256,
          });
        }
        // version.json lists the documents and is written into the version dir.
        const versionDoc = renderVersionJson(settings, written);
        await Deno.writeTextFile(`${versionDir}/version.json`, versionDoc);

        // Flip the `current` pointer atomically (replace symlink if possible,
        // else copy the tree so a filesystem without symlinks still works).
        await Deno.mkdir(outputDir, { recursive: true });
        try {
          await Deno.remove(currentDir, { recursive: true });
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
        try {
          await Deno.symlink(versionDir, currentDir);
        } catch {
          await copyDir(versionDir, currentDir);
        }

        context.logger?.info(
          "Rendered {count} settings documents to {dir} (version {version})",
          { count: written.length + 1, dir: currentDir, version },
        );

        const settingsHandle = await context.writeResource(
          "settings",
          "resolved",
          settings as unknown as Record<string, unknown>,
        );
        const renderHandle = await context.writeResource("render", "manifest", {
          version,
          contentHash: settings.contentHash,
          outputDir: currentDir,
          documents: written,
          renderedAt: new Date().toISOString(),
        });
        return { dataHandles: [settingsHandle, renderHandle] };
      },
    },

    validate: {
      description:
        "Check the contract for schema and endpoint consistency without rendering",
      arguments: ValidateArgsSchema,
      execute: async (
        _args: z.infer<typeof ValidateArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const { errors, warnings } = validateSettings(context.globalArgs);
        const handle = await context.writeResource("validation", "current", {
          valid: errors.length === 0,
          errors,
          warnings,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Summarise the resolved contract and whether it is rendered",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const outputDir = `${expandHome(g.outputDir)}/current`;
        let rendered = false;
        try {
          await Deno.stat(`${outputDir}/otel.json`);
          rendered = true;
        } catch {
          rendered = false;
        }
        const handle = await context.writeResource("status", "current", {
          domain: g.domain,
          endpointCount: g.endpoints.length,
          tierCount: resolveTiers(g.tiers).length,
          deploymentEnvironment: g.deploymentEnvironment,
          settingsUrl: settingsUrl(g.domain),
          rendered,
          outputDir,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Recursively copy a directory (fallback when symlinks are unavailable). */
async function copyDir(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDir(src, dst);
    } else {
      await Deno.copyFile(src, dst);
    }
  }
}
