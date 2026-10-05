/**
 * Caddy reverse-proxy and service management (MVP).
 *
 * A swamp model type (`@svendowideit/caddy`) that manages Caddy on a Linux
 * host with systemd. It is a swamp extension that drives Caddy via its admin
 * API and systemd — *not* a Go Caddy plugin.
 *
 * MVP methods:
 *   - `installCaddy`    — download the current Caddy binary (with any requested
 *                         module packages compiled in via the caddyserver.com
 *                         download API), place it at `caddyBinPath`, and verify
 *                         it runs.
 *   - `createService`   — write a systemd *user* service unit for Caddy.
 *   - `startService`    — start + enable the service and verify the admin API.
 *   - `settingsGuidance`— print the minimal settings needed for a useful
 *                         Let's Encrypt TLS-configured Caddy (base domain,
 *                         ACME email, admin API token).
 *
 * Iteration 1 methods:
 *   - `addProxyService`    — derive a hostname from a service name + base
 *                            domain and add a reverse-proxy route via the
 *                            admin API (live, no restart).
 *   - `removeProxyService` — stop the backend systemd service and remove the
 *                            Caddy route for the derived domain.
 *   - `startBackendService` / `stopBackendService` / `restartBackendService`
 *                          — manage backend systemd user services by name.
 *
 * Iteration 2 methods:
 *   - `storeConfig` — validate and write base domain, ACME email, and admin
 *                     API token to the swamp Vault (helper for setup).
 *   - `syncConfig`  — snapshot the effective config into a swamp resource.
 *   - `getConfig`   — read the stored config back from the swamp resource.
 *   - Admin API protection: the admin endpoint can be bound to a permissioned
 *     Unix socket (`adminApiAddr: unix//path`); the client talks over it.
 *
 * Iteration 3 methods:
 *   - `configureTls`       — configure the TLS app (ACME email + optional DNS
 *                            provider for wildcard/DNS-challenge issuance).
 *   - `autoProxySwampServe`— detect running `swamp serve` systemd services and
 *                            reconcile their reverse-proxy routes.
 *
 * Iteration 4 methods:
 *   - `upgradeCaddy`  — replace the Caddy binary (current release, with module
 *                       packages) with explicit confirmation, then restart the
 *                       service.
 *   - `checkHealth`   — report Caddy service + admin API health.
 *   - `stopService` / `restartService` — stop/restart the Caddy service.
 *
 * Desired-state proxy:
 *   - `ensureDnsProxy` — idempotently ensure a full hostname proxies to a
 *                        backend host:port (add if missing, update if the
 *                        upstream changed, no-op if already correct).
 *
 * Linux-only: it shells out to `systemctl --user` and manages a systemd user
 * service. Pure helpers (unit rendering, path expansion, version parsing,
 * guidance rendering) are exported for unit testing.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Always-on Caddy modules + shared input schemas
// ---------------------------------------------------------------------------

/**
 * Caddy modules compiled into every binary this extension installs:
 *
 *  - `github.com/SvenDowideit/caddy-host-dns` — the `dns_records` app: static,
 *    provider-agnostic A/AAAA/CNAME records via any `dns.providers.*` module.
 *  - `github.com/hairyhenderson/caddy-teapot-module` — the `teapot` handler,
 *    used by the default health route (`/teapot` -> 418).
 *
 * They are merged into the configured plugin list at install/upgrade. A user
 * entry that pins a version (e.g. `...@v1.2.3`) wins over the bare default.
 */
export const DEFAULT_CADDY_PLUGINS: readonly string[] = [
  "github.com/SvenDowideit/caddy-host-dns",
  "github.com/hairyhenderson/caddy-teapot-module",
];

/** The static-DNS app module path (for plugin reporting/diagnostics). */
export const CADDY_HOST_DNS_PLUGIN = "github.com/SvenDowideit/caddy-host-dns";
/** The teapot handler module path (for plugin reporting/diagnostics). */
export const CADDY_TEAPOT_PLUGIN =
  "github.com/hairyhenderson/caddy-teapot-module";

/**
 * Merge the always-on modules into a plugin list, de-duplicated by module path.
 * A later (explicit) entry wins, so `foo@v1` overrides a bare `foo` default.
 */
export function withDefaultPlugins(plugins: string[]): string[] {
  const byPath = new Map<string, string>();
  for (const p of [...DEFAULT_CADDY_PLUGINS, ...plugins]) {
    byPath.set(p.split("@")[0], p);
  }
  return [...byPath.values()];
}

/**
 * A single static DNS record the model wants Caddy to own. `dns_records`
 * replaces the whole `(name, type)` RRset with exactly these values on every
 * reconcile. Values are literal; host-address auto-detection is not yet built.
 */
const DnsRecordSchema = z.object({
  name: z.string().describe("FQDN, e.g. otel.fi.gy"),
  type: z.enum(["A", "AAAA", "CNAME"]),
  value: z.array(z.string()).min(1).describe(
    "For A/AAAA: one or more IPs. For CNAME: exactly one hostname.",
  ),
  zone: z.string().default("").describe(
    "Zone the record belongs to (e.g. fi.gy). Empty derives it from the name via the provider's libdns.ZoneLister.",
  ),
  ttl: z.string().default("").describe(
    "Optional per-record TTL (e.g. 5m); overrides the global TTL.",
  ),
});

/**
 * An explicit DNS removal, applied on every reconcile. Unlike dropping a
 * `dnsRecords` entry (which leaves the record in place), this deletes it.
 * `value` empty removes the whole `(name, type)` RRset.
 */
const DnsRemovalSchema = z.object({
  name: z.string(),
  type: z.enum(["A", "AAAA", "CNAME"]),
  value: z.array(z.string()).default([]),
  zone: z.string().default(""),
});

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  caddyBinPath: z.string().default("~/.local/bin/caddy").describe(
    "Path where the Caddy binary is installed",
  ),
  adminApiAddr: z.string().default("localhost:2019").describe(
    "Caddy admin API listen address (written to the Caddyfile global options)",
  ),
  configPath: z.string().default("~/.config/caddy/Caddyfile").describe(
    "Path to the Caddy config file the service runs",
  ),
  autoHttps: z.enum([
    "on",
    "off",
    "disable_redirects",
    "disable_certs",
    "ignore_loaded_certs",
  ]).default("on").describe(
    "Caddy automatic HTTPS mode: 'on' (default), 'off' for plain HTTP, or a disable_* variant",
  ),
  listenAddrs: z.array(z.string()).default([":443", ":80"]).describe(
    "HTTP server listen addresses for routes added via the admin API (e.g. [':8888', ':8443'])",
  ),
  serviceName: z.string().default("caddy").describe(
    "systemd user service name",
  ),
  baseDomain: z.string().optional().describe(
    "Base domain used to derive hostnames (e.g. example.com)",
  ),
  letsEncryptEmail: z.string().optional().describe(
    "Email used for Let's Encrypt / ACME certificate issuance",
  ),
  plugins: z.array(z.string()).default([]).describe(
    "Extra Caddy module packages to include in the downloaded binary, e.g. github.com/caddy-dns/cloudflare (optionally github.com/foo/bar@v1.2.3). The always-on modules (caddy-host-dns and caddy-teapot-module) are added automatically.",
  ),
  dnsRecords: z.array(DnsRecordSchema).default([]).describe(
    "Static A/AAAA/CNAME records this model wants Caddy to own (via the caddy-host-dns dns_records app). Needs a DNS provider configured in tls (dnsProvider) so Caddy can write them.",
  ),
  dnsRemovals: z.array(DnsRemovalSchema).default([]).describe(
    "DNS records to delete on every reconcile (dns_records 'remove'). Dropping a dnsRecords entry does not delete it; use this.",
  ),
  dnsTtl: z.string().default("5m").describe(
    "Default TTL for dnsRecords, e.g. 5m or 300s. Short by default so records added/changed here propagate quickly; a record's own ttl field overrides it.",
  ),
  healthRoutes: z.boolean().default(true).describe(
    "On status/default hostnames, add a health contract: '/' -> 200 (status page), '/teapot' -> 418, and any other path -> 404. Hostnames with their own route are unaffected.",
  ),
  adminApiToken: z.string().optional().meta({ sensitive: true }).describe(
    "Optional admin API token (sent as a Bearer header when set)",
  ),
  vaultName: z.string().optional().describe(
    "Vault name used by storeConfig to write secrets (e.g. caddy-secrets)",
  ),
  environmentFile: z.string().optional().describe(
    "Path to a systemd EnvironmentFile the service reads for secrets such as DNS provider tokens (e.g. ~/.config/caddy/dns.env, chmod 600). Rendered as EnvironmentFile=-<path> in the unit; the leading '-' means a missing file does not stop the service.",
  ),
  target: z.string().default("").describe(
    "Host this model's Caddy runs on (e.g. a worker hostname, or an SSH host). Empty defaults to this machine's hostname. Together with serviceName it identifies the running Caddy; models sharing (target, serviceName) are merged into one config by reconcile, so use distinct serviceName values for a second Caddy on the same host.",
  ),
  reconcile: z.boolean().default(true).describe(
    "When true, every mutating method rebuilds the running config from the union of all models sharing this target (so several models cooperate instead of fighting). Set false to write only this model's config.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstallArgsSchema = z.object({
  plugins: z.array(z.string()).optional().describe(
    "Override the module packages to include (defaults to global plugins)",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even if the binary already exists",
  ),
  setCapabilities: z.boolean().default(true).describe(
    "After install, try to grant the binary CAP_NET_BIND_SERVICE so the unprivileged systemd user service can bind 80/443. Without sudo this records the exact `sudo setcap` command to run by hand.",
  ),
  configureStatusPage: z.boolean().default(true).describe(
    "After install, install a default status page answering on localhost, summarising the install and linking to the admin API. Requires the admin API to be reachable (a running service); skips with a log otherwise.",
  ),
});

const SetCapabilitiesArgsSchema = z.object({
  capabilities: z.array(z.string()).optional().describe(
    "Linux capabilities to grant (default ['cap_net_bind_service=+ep'])",
  ),
  binPath: z.string().optional().describe(
    "Override the Caddy binary path (defaults to global caddyBinPath)",
  ),
  quiet: z.boolean().default(false).describe(
    "Suppress the log message describing the command",
  ),
});

const ServiceArgsSchema = z.object({
  serviceName: z.string().optional().describe(
    "Override the systemd service name (defaults to global serviceName)",
  ),
});

const GuidanceArgsSchema = z.object({});

const AddProxyArgsSchema = z.object({
  serviceName: z.string().min(1).describe(
    "Service name; hostname is derived as <service-name>.<base-domain>",
  ),
  upstream: z.string().min(1).describe(
    "Backend host:port to proxy to (e.g. 127.0.0.1:8080 or https://127.0.0.1:8443)",
  ),
  baseDomain: z.string().optional().describe(
    "Override the base domain (defaults to global baseDomain)",
  ),
});

const RemoveProxyArgsSchema = z.object({
  serviceName: z.string().min(1).describe(
    "Service name whose route and systemd service to remove",
  ),
  baseDomain: z.string().optional().describe(
    "Override the base domain (defaults to global baseDomain)",
  ),
});

const BackendServiceArgsSchema = z.object({
  serviceName: z.string().min(1).describe(
    "systemd user service name to act on",
  ),
});

const StoreConfigArgsSchema = z.object({
  baseDomain: z.string().optional().describe(
    "Base domain to store in the Vault (e.g. example.com)",
  ),
  letsEncryptEmail: z.string().optional().describe(
    "Let's Encrypt / ACME email to store in the Vault",
  ),
  adminApiToken: z.string().optional().meta({ sensitive: true }).describe(
    "Admin API token to store in the Vault",
  ),
  vaultName: z.string().optional().describe(
    "Override the Vault name (defaults to global vaultName)",
  ),
});

const SyncConfigArgsSchema = z.object({});

const ConfigureTlsArgsSchema = z.object({
  email: z.string().optional().describe(
    "ACME email (defaults to global letsEncryptEmail)",
  ),
  dnsProvider: z.string().optional().describe(
    "DNS provider name for DNS-challenge issuance (e.g. cloudflare)",
  ),
  dnsEnvVar: z.string().optional().describe(
    "Environment variable holding a single-field DNS provider credential (default CADDY_DNS_API_TOKEN). Ignored when providerConfig is set.",
  ),
  providerConfig: z.record(z.string(), z.string()).optional().describe(
    'Provider credential field -> environment variable, for multi-field providers. e.g. \'{"bearer_token":"GANDI_TOKEN"}\' for Gandi, \'{"api_key":"NC_KEY","user":"NC_USER"}\' for Namecheap',
  ),
  subjects: z.array(z.string()).optional().describe(
    "Subjects for the TLS policy (e.g. *.example.com, example.com)",
  ),
  issuer: z.string().optional().describe(
    'Issuer module: "acme" (default, Let\'s Encrypt) or "internal" (Caddy\'s local CA, for non-public names where ACME cannot issue).',
  ),
});

const ServeSettingsArgsSchema = z.object({
  hostname: z.string().min(1).describe(
    "Full hostname to serve the settings documents on (e.g. settings.otel.fi.gy)",
  ),
  root: z.string().min(1).describe(
    "Directory holding the rendered settings documents (e.g. ~/.local/share/otel-settings/current)",
  ),
  browse: z.boolean().default(false).describe(
    "Enable directory browsing (off by default; individual documents remain fetchable)",
  ),
});

const AutoProxyArgsSchema = z.object({
  baseDomain: z.string().optional().describe(
    "Override the base domain (defaults to global baseDomain)",
  ),
  prefix: z.string().default("swamp-serve-").describe(
    "systemd unit name prefix for swamp serve instances",
  ),
  port: z.number().int().positive().default(3080).describe(
    "Port swamp serve instances listen on",
  ),
});

const UpgradeArgsSchema = z.object({
  plugins: z.array(z.string()).optional().describe(
    "Module packages to include (defaults to global plugins)",
  ),
  confirm: z.string().optional().describe(
    "Set to 'upgrade' to confirm replacing the binary and restarting the service",
  ),
});

const EnsureDnsProxyArgsSchema = z.object({
  hostname: z.string().min(1).describe(
    "Full hostname to proxy (e.g. foo.example.com)",
  ),
  upstream: z.string().min(1).describe(
    "Backend host:port to proxy to (e.g. 127.0.0.1:8080 or https://192.0.2.10:8443)",
  ),
  rootPath: z.string().default("").describe(
    "Serve an app that lives under this sub-path (e.g. '/dashboard') at the " +
      "hostname root: only the exact path '/' is rewritten to it; every other " +
      "path passes through unchanged. Empty proxies the root as-is.",
  ),
});

const ConfigureStatusPageArgsSchema = z.object({
  title: z.string().default("Caddy").describe(
    "Heading shown on the status page",
  ),
  extraLinks: z.array(
    z.object({
      label: z.string(),
      url: z.string(),
    }),
  ).default([]).describe(
    "Additional links to show on the status page",
  ),
  disabled: z.boolean().default(false).describe(
    "Set true to remove the status page route instead of adding it",
  ),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

const InstallOutputSchema = z.object({
  binPath: z.string(),
  version: z.string(),
  arch: z.string(),
  plugins: z.array(z.string()),
  installedAt: z.string(),
  capabilities: z.array(z.string()),
  canBindPrivilegedPorts: z.boolean(),
  needsSudoForPorts: z.string(),
  /** Whether this run downloaded a (re)built binary. */
  rebuilt: z.boolean().default(false),
  /** Wanted modules that were missing before a rebuild (empty if all present). */
  missingPluginsBeforeBuild: z.array(z.string()).default([]),
  /** Whether a running service was restarted to pick up the rebuilt binary. */
  restarted: z.boolean().default(false),
});

const DnsConfigOutputSchema = z.object({
  /** The static DNS records the model wants Caddy to own. */
  records: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      value: z.array(z.string()),
      zone: z.string().default(""),
      ttl: z.string().default(""),
    }),
  ),
  /** Explicit removals applied on every reconcile. */
  removals: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      value: z.array(z.string()),
      zone: z.string().default(""),
    }),
  ),
  /** DNS provider the records were written through. */
  provider: z.string(),
  /** Whether the applied config differed from the live config. */
  changed: z.boolean(),
  appliedAt: z.string(),
});

const ServiceOutputSchema = z.object({
  serviceName: z.string(),
  unitPath: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  adminApiReachable: z.boolean(),
  checkedAt: z.string(),
});

const GuidanceOutputSchema = z.object({
  guidance: z.string(),
  baseDomain: z.string(),
  letsEncryptEmail: z.string(),
  adminApiAddr: z.string(),
});

const ProxyServiceSchema = z.object({
  serviceName: z.string(),
  hostname: z.string(),
  upstream: z.string(),
});

const ProxyServicesOutputSchema = z.object({
  services: z.array(ProxyServiceSchema),
  updatedAt: z.string(),
});

const ConfigOutputSchema = z.object({
  baseDomain: z.string(),
  letsEncryptEmail: z.string(),
  adminApiAddr: z.string(),
  adminApiTokenSet: z.boolean(),
  vaultName: z.string(),
  syncedAt: z.string(),
});

const TlsConfigOutputSchema = z.object({
  email: z.string(),
  dnsProvider: z.string(),
  subjects: z.array(z.string()),
  credentialFields: z.array(z.string()),
  configuredAt: z.string(),
});

const AutoProxyOutputSchema = z.object({
  detected: z.array(z.string()),
  added: z.array(z.string()),
  updated: z.array(z.string()),
  removed: z.array(z.string()),
  reconciledAt: z.string(),
});

const UpgradeOutputSchema = z.object({
  binPath: z.string(),
  version: z.string(),
  plugins: z.array(z.string()),
  restarted: z.boolean(),
  upgradedAt: z.string(),
  capabilities: z.array(z.string()),
});

const SetCapabilitiesOutputSchema = z.object({
  binPath: z.string(),
  capabilities: z.array(z.string()),
  changed: z.boolean(),
  applied: z.boolean(),
  requiresSudo: z.boolean(),
  command: z.string(),
  message: z.string(),
  checkedAt: z.string(),
});

const HealthOutputSchema = z.object({
  serviceName: z.string(),
  active: z.boolean(),
  adminApiReachable: z.boolean(),
  healthy: z.boolean(),
  status: z.string(),
  checkedAt: z.string(),
});

const EnsureProxyOutputSchema = z.object({
  hostname: z.string(),
  upstream: z.string(),
  changed: z.boolean(),
  ensuredAt: z.string(),
});

const ServeSettingsOutputSchema = z.object({
  hostname: z.string(),
  root: z.string(),
  browse: z.boolean(),
  changed: z.boolean(),
  servedAt: z.string(),
});

const StatusPageOutputSchema = z.object({
  modelName: z.string(),
  hostnames: z.array(z.string()),
  title: z.string(),
  adminUrl: z.string(),
  listens: z.array(z.string()),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  plugins: z.array(
    z.object({
      packagePath: z.string(),
      version: z.string(),
      modules: z.array(z.string()),
    }),
  ),
  changed: z.boolean(),
  removed: z.boolean(),
  configuredAt: z.string(),
});

// Desired-state: what ONE model wants from its Caddy. reconcile() unions these
// across every model sharing the same target and writes the result, so several
// models cooperate on one Caddy instead of overwriting each other.
const DesiredRouteSchema = z.object({
  hostname: z.string(),
  kind: z.enum(["proxy", "file_server"]).default("proxy"),
  upstream: z.string().default(""),
  root: z.string().default(""),
  browse: z.boolean().default(false),
  rootPath: z.string().default("").describe(
    "Serve an app that lives under this sub-path (e.g. '/dashboard') at the " +
      "hostname root: the exact path '/' is rewritten to it before proxying, " +
      "while every other path (assets, API) passes through unchanged. Empty " +
      "proxies the host root as-is.",
  ),
});

const DesiredTlsSchema = z.object({
  email: z.string().default(""),
  dnsProvider: z.string().default(""),
  dnsEnvVar: z.string().default(""),
  providerConfig: z.record(z.string(), z.string()).default({}),
  subjects: z.array(z.string()).default([]),
  // Issuer module: "acme" (default) or "internal" (Caddy's local CA, for
  // non-public names / tests where ACME cannot issue).
  issuer: z.string().default(""),
});

const DesiredStatusPageSchema = z.object({
  enabled: z.boolean().default(false),
  title: z.string().default("Caddy"),
  hostnames: z.array(z.string()).default([]),
  extraLinks: z.array(z.object({ label: z.string(), url: z.string() }))
    .default([]),
  // Snapshot inputs (install facts) so reconcile can RE-RENDER the page against
  // the current routes/listens instead of repeating a stale HTML snapshot.
  version: z.string().default(""),
  adminUrl: z.string().default(""),
  baseDomain: z.string().default(""),
  email: z.string().default(""),
  capabilities: z.array(z.string()).default([]),
  plugins: z.array(
    z.object({
      packagePath: z.string(),
      version: z.string(),
      modules: z.array(z.string()),
    }),
  ).default([]),
  // Derived at reconcile time from the merged routes (not stored by hand).
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
});

const DesiredStateSchema = z.object({
  modelName: z.string(),
  target: z.string(),
  serviceName: z.string(),
  adminApiAddr: z.string().default("localhost:2019"),
  baseDomain: z.string().default(""),
  autoHttps: z.string().default("on"),
  listenAddrs: z.array(z.string()).default([]),
  /** Caddy modules this model asks to be compiled in (e.g. the gandi driver). */
  plugins: z.array(z.string()).default([]),
  /** systemd EnvironmentFile holding DNS-provider credentials. */
  environmentFile: z.string().default(""),
  /** Path to the Caddy binary (to inspect compiled plugins). */
  caddyBinPath: z.string().default("~/.local/bin/caddy"),
  routes: z.array(DesiredRouteSchema).default([]),
  tls: DesiredTlsSchema.nullable().default(null),
  statusPage: DesiredStatusPageSchema.nullable().default(null),
  dnsRecords: z.array(DnsRecordSchema).default([]),
  dnsRemovals: z.array(DnsRemovalSchema).default([]),
  dnsTtl: z.string().default("5m"),
  healthRoutes: z.boolean().default(true),
  updatedAt: z.string(),
});

const ReconcileOutputSchema = z.object({
  target: z.string(),
  models: z.array(z.string()),
  routeCount: z.number(),
  fileServerCount: z.number(),
  statusPageModel: z.string(),
  tlsModels: z.array(z.string()),
  changed: z.boolean(),
  reconciledAt: z.string(),
});

const UnmergedModelSchema = z.object({
  model: z.string(),
  routes: z.array(
    z.object({
      hostname: z.string(),
      kind: z.string(),
      upstream: z.string(),
      root: z.string(),
    }),
  ),
  tlsSubjects: z.array(z.string()),
  statusPage: z.boolean(),
});

const AuditCaddySchema = z.object({
  target: z.string(),
  adminApiAddr: z.string(),
  serviceName: z.string(),
  models: z.array(z.string()),
  /** TLS/DNS layer: what models want vs what the binary/live config has. */
  tls: z.object({
    desired: z.array(
      z.object({
        model: z.string(),
        email: z.string(),
        dnsProvider: z.string(),
        subjects: z.array(z.string()),
        providerConfigFields: z.array(z.string()),
      }),
    ),
    desiredSubjects: z.array(z.string()),
    liveSubjects: z.array(z.string()),
    liveHasDnsChallenge: z.boolean(),
    liveDnsProvider: z.string(),
    /** Domains with a certificate on disk (proves issuance, not just config). */
    issuedDomains: z.array(z.string()),
    /** Subjects desired but with no certificate on disk yet. */
    subjectsWithoutCert: z.array(z.string()),
    /** Hostnames the status page answers on (defaults for configured names). */
    statusPageHostnames: z.array(z.string()),
    pluginsWanted: z.array(z.string()),
    pluginsCompiled: z.array(z.string()),
    pluginsMissing: z.array(z.string()),
    environmentFile: z.string(),
    environmentFileExists: z.boolean(),
    environmentFileKeys: z.array(z.string()),
    inSync: z.boolean(),
  }),
  /** Each model's OWN desired state, before merging. */
  unmerged: z.array(UnmergedModelSchema),
  /** Static DNS records (caddy-host-dns): desired only, no live diff. */
  dns: z.object({
    /** Whether any model declares DNS records/removals. */
    enabled: z.boolean(),
    /** Records each model wants, before merging. */
    desired: z.array(
      z.object({
        model: z.string(),
        name: z.string(),
        type: z.string(),
        value: z.array(z.string()),
        zone: z.string(),
        ttl: z.string(),
      }),
    ),
    /** Explicit removals each model wants. */
    removals: z.array(
      z.object({
        model: z.string(),
        name: z.string(),
        type: z.string(),
        value: z.array(z.string()),
        zone: z.string(),
      }),
    ),
    /** The merged record set Caddy is told to own. */
    mergedRecords: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        value: z.array(z.string()),
        zone: z.string(),
        ttl: z.string(),
      }),
    ),
    /** The merged removals. */
    mergedRemovals: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        value: z.array(z.string()),
        zone: z.string(),
      }),
    ),
    /** DNS provider the records are written through (from tls). */
    provider: z.string(),
    /** Whether the caddy-host-dns module is compiled into the binary. */
    moduleCompiled: z.boolean(),
  }),
  /** The scratch/model name `plan`/`audit` was run on (for the next commands). */
  runModel: z.string(),
  /** Ready-to-paste commands to inspect unmerged, merged, and actual. */
  nextCommands: z.string(),
  conflicts: z.array(z.string()),
  desiredRoutes: z.array(
    z.object({
      hostname: z.string(),
      kind: z.string(),
      upstream: z.string(),
      root: z.string(),
      model: z.string(),
    }),
  ),
  actualSwampRoutes: z.array(
    z.object({ id: z.string(), hostnames: z.array(z.string()) }),
  ),
  foreignRoutes: z.array(z.string()),
  onlyDesired: z.array(z.string()),
  onlyActual: z.array(z.string()),
  inSync: z.boolean(),
  reachable: z.boolean(),
  error: z.string(),
  desiredConfig: z.record(z.string(), z.unknown()),
  actualConfig: z.record(z.string(), z.unknown()),
});

const AuditOutputSchema = z.object({
  cadies: z.array(AuditCaddySchema),
  modelCount: z.number(),
  inSync: z.boolean(),
  auditedAt: z.string(),
});

const PlanOutputSchema = AuditCaddySchema.extend({
  plannedAt: z.string(),
});

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

/** Map Deno's build arch to Caddy's download arch label. */
export function caddyArch(arch?: string): string {
  const a = arch ?? Deno.build.arch;
  switch (a) {
    case "x86_64":
      return "amd64";
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported architecture for Caddy: ${a}`);
  }
}

/** Parse the version string from `caddy version` output (e.g. "v2.8.4 h1:..."). */
export function parseCaddyVersion(stdout: string): string {
  const first = stdout.trim().split(/\s+/)[0] ?? "";
  if (!first) throw new Error("caddy version returned no version string");
  return first;
}

/** The capabilities Caddy needs to bind privileged ports as a user service. */
export const PRIVILEGED_PORT_CAPABILITIES = ["cap_net_bind_service=+ep"];

/**
 * Parse the capabilities from `getcap <path>` output (e.g.
 * `/home/u/.local/bin/caddy cap_net_bind_service=ep`). Returns `[]` when the
 * file has no capabilities.
 */
export function parseGetcap(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  // Drop the leading path, keep the rest (space-separated capability entries).
  const firstSpace = trimmed.indexOf(" ");
  const caps = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  return caps ? caps.split(/\s+/) : [];
}

/** Whether a capability list includes CAP_NET_BIND_SERVICE (any form). */
export function hasNetBindService(caps: string[]): boolean {
  return caps.some((c) => c.toLowerCase().includes("cap_net_bind_service"));
}

/** Render the `sudo setcap` command a user runs to grant one capability. */
export function renderSetcapCommand(
  binPath: string,
  capabilities: string[] = PRIVILEGED_PORT_CAPABILITIES,
): string {
  return `sudo setcap '${capabilities.join(" ")}' ${binPath}`;
}

/**
 * Human guidance for enabling privileged ports, including the exact `setcap`
 * command — so an operator can copy-paste it when sudo is not available to the
 * swarm model.
 */
export function renderPrivilegedPortGuidance(
  binPath: string,
  capabilities: string[] = PRIVILEGED_PORT_CAPABILITIES,
): string {
  return [
    "To let the unprivileged systemd *user* service bind ports 80/443,",
    "grant the Caddy binary the CAP_NET_BIND_SERVICE capability:",
    "",
    `    ${renderSetcapCommand(binPath, capabilities)}`,
    "",
    "This is a one-time, per-binary operation. Re-run it after every",
    "upgradeCaddy/installCaddy with force, because replacing the binary drops",
    "the capability. (Alternative: run Caddy as a root system service, or keep",
    "it unprivileged on high ports with autoHttps=off.)",
  ].join("\n");
}

/**
 * Render the systemd *user* service unit file content for Caddy.
 *
 * The admin endpoint is configured via the Caddyfile's `admin` global option,
 * not a `--admin` CLI flag (Caddy v2.11+ rejects `caddy run --admin`).
 *
 * `--resume` is passed so that config applied via the admin API (routes added
 * by addProxyService/ensureDnsProxy etc.) survives a service restart: Caddy
 * autosaves the running JSON config to its config dir, but only reloads it
 * with `--resume`. On a fresh install there is no autosave file yet, so Caddy
 * falls back to `--config` (the generated Caddyfile) — see the run docs.
 */
export function renderServiceUnit(opts: {
  binPath: string;
  configPath: string;
  environmentFile?: string;
}): string {
  const { binPath, configPath } = opts;
  // We deliberately set neither LimitNPROC nor the mount-namespace options
  // (ProtectSystem/PrivateTmp) — each breaks a user service in a different way:
  //
  //  * LimitNPROC is per-UID for a systemd *user* service, so it counts every
  //    process/thread the logged-in user already runs. A low value (e.g. 512)
  //    makes Caddy's Go runtime fail to spawn a thread with EAGAIN ("failed to
  //    create new OS thread … may need to increase ulimit -u"), exiting
  //    status=2. The user manager's TasksMax already bounds the slice.
  //
  //  * ProtectSystem=full / PrivateTmp=true need a mount namespace, which an
  //    unprivileged user service can only create inside a *child user
  //    namespace*. A process in a child userns cannot bind host privileged
  //    ports even with CAP_NET_BIND_SERVICE set on the binary: the kernel's
  //    ns_capable() check tests the network namespace's owning (parent) userns,
  //    so binding 80/443 fails with EACCES. Since binding 80/443 is the whole
  //    point of the capability, we keep the service out of a userns.
  //
  // If you do not need privileged ports, hardening can be added back.
  return `# Managed by @svendowideit/caddy — do not edit by hand.
[Unit]
Description=Caddy web server
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${binPath} run --resume --config ${configPath} --adapter caddyfile
Restart=on-failure
RestartSec=5
TimeoutStopSec=5
LimitNOFILE=1048576${
    opts.environmentFile ? `\nEnvironmentFile=-${opts.environmentFile}` : ""
  }

[Install]
WantedBy=default.target
`;
}

/**
 * Render the base Caddyfile with global options (sites are added later via the
 * admin API). The admin endpoint lives here rather than in a `--admin` flag,
 * because Caddy v2.11+ removed the flag.
 */
export function renderMinimalConfig(
  opts?: { adminApiAddr?: string; autoHttps?: string },
): string {
  const adminApiAddr = opts?.adminApiAddr ?? "localhost:2019";
  const autoHttps = opts?.autoHttps ?? "on";
  const lines = [
    "# Managed by @svendowideit/caddy — sites are added via the admin API.",
    "{",
  ];
  if (adminApiAddr !== "localhost:2019") {
    lines.push(`\tadmin ${adminApiAddr}`);
  }
  if (autoHttps !== "on") {
    lines.push(`\tauto_https ${autoHttps}`);
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/** Render the minimal-settings guidance text for a useful Let's Encrypt setup. */
export function renderSettingsGuidance(opts: {
  baseDomain: string;
  letsEncryptEmail: string;
  adminApiAddr: string;
  binPath?: string;
}): string {
  const { baseDomain, letsEncryptEmail, adminApiAddr } = opts;
  const binPath = opts.binPath ?? "~/.local/bin/caddy";
  return [
    "Caddy is installed and running. To make it a useful Let's Encrypt",
    "TLS-configured reverse proxy, provide these minimal settings:",
    "",
    "  1. base domain      — e.g. example.com",
    "     (hostnames are derived as <service-name>.<base-domain>)",
    `     current: ${baseDomain || "<not set>"}`,
    "",
    "  2. Let's Encrypt email — used for ACME account + expiry notices",
    `     current: ${letsEncryptEmail || "<not set>"}`,
    "",
    "  3. admin API token  — protect the admin API (recommended by Caddy)",
    `     admin API listens on: ${adminApiAddr}`,
    "     store the token in the swamp Vault (e.g. caddy/admin-token)",
    "",
    "  4. privileged ports — to serve 80/443 from the unprivileged user",
    "     service, grant the binary CAP_NET_BIND_SERVICE once:",
    "",
    `         ${renderSetcapCommand(binPath)}`,
    "",
    "     (run this yourself if the model lacked sudo; re-run after upgrades)",
    "",
    "Provide these via the model's global arguments or the swamp Vault.",
    "See the README for the exact keys and helper methods.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Proxy config pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** A Caddy reverse-proxy route (loosely typed to match Caddy's JSON config). */
export type CaddyRoute = Record<string, unknown>;

/** A Caddy JSON config document (loosely typed). */
export type CaddyConfig = Record<string, unknown>;

/** Derive a hostname from a service name and base domain. */
export function deriveHostname(
  serviceName: string,
  baseDomain: string,
): string {
  const sanitized = serviceName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(
      `Invalid service name '${serviceName}': no valid hostname characters`,
    );
  }
  if (!baseDomain) {
    throw new Error("baseDomain is required to derive a hostname");
  }
  return `${sanitized}.${baseDomain}`;
}

/** Parse and validate an upstream `host:port` (or `scheme://host:port`). */
export function parseUpstream(
  upstream: string,
): { dial: string; https: boolean } {
  const withScheme = upstream.includes("://") ? upstream : `http://${upstream}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(
      `Invalid upstream '${upstream}': expected host:port or scheme://host:port`,
    );
  }
  if (!url.hostname) {
    throw new Error(`Invalid upstream '${upstream}': missing host`);
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { dial: `${url.hostname}:${port}`, https: url.protocol === "https:" };
}

/** Build a Caddy `file_server` route for a hostname + document root. */
export function buildFileServerRoute(
  hostname: string,
  root: string,
  browse = false,
): CaddyRoute {
  // Caddy's file_server `browse` is an object (an empty object enables it);
  // omit the field entirely for the default (browsing disabled).
  const handle: Record<string, unknown> = { handler: "file_server", root };
  if (browse) handle.browse = {};
  return {
    match: [{ host: [hostname] }],
    handle: [handle],
    terminal: true,
  };
}

/** Read the file_server root from a route (empty string when not a file server). */
export function routeFileServerRoot(route: CaddyRoute): string {
  const handle = route.handle;
  if (Array.isArray(handle) && handle.length > 0) {
    const first = handle[0] as Record<string, unknown>;
    if (first.handler === "file_server" && typeof first.root === "string") {
      return first.root;
    }
  }
  return "";
}

/**
 * The always-present status-page hostnames: loopback, so `https://localhost`
 * works even before any hostname is configured.
 */
export function statusPageHostnames(): string[] {
  return ["localhost", "127.0.0.1", "[::1]"];
}

/**
 * Every hostname the default status page should answer on: the loopback base
 * plus every hostname the models name (TLS subjects and explicit status
 * hostnames), minus any hostname that already has its own route. So the status
 * page is the DEFAULT for each configured hostname, and a specific route
 * overrides it. Wildcards (e.g. `*.example.com`) are kept as-is.
 */
export function defaultStatusHostnames(opts: {
  tlsSubjects?: string[];
  explicit?: string[];
  routedHostnames?: string[];
}): string[] {
  const out = new Set(statusPageHostnames());
  for (const s of opts.tlsSubjects ?? []) if (s) out.add(s);
  for (const s of opts.explicit ?? []) if (s) out.add(s);
  // A hostname that already has a real route is served by that route, so it is
  // not a status-page default.
  for (const h of opts.routedHostnames ?? []) out.delete(h);
  return [...out].sort();
}

/**
 * A JSON `static_response` route matching the given hostnames, returning the
 * given HTML body. Defaults to the loopback status hostnames.
 */
export function buildStatusPageRoute(
  html: string,
  hostnames: string[] = statusPageHostnames(),
): CaddyRoute {
  return {
    // Path is constrained to "/" so the status page answers the root only; the
    // health contract (teapot/404) then owns every other path on these hosts.
    match: [{ host: hostnames, path: ["/"] }],
    handle: [
      {
        handler: "static_response",
        // Caddy's static_response headers are map[string][]string; a bare
        // string fails to decode ("cannot unmarshal string into ... []string").
        headers: { "Content-Type": ["text/html; charset=utf-8"] },
        body: html,
      },
    ],
    terminal: true,
  };
}

/**
 * Whether a route is the generated status page. Identified by its `swamp:` @id
 * ending in `:status`, or (for routes written by older versions before tagging)
 * a `static_response` on a loopback hostname.
 */
export function isStatusPageRoute(route: CaddyRoute): boolean {
  const id = route["@id"];
  if (
    typeof id === "string" && id.startsWith("swamp:") && id.endsWith(":status")
  ) {
    return true;
  }
  const match = route.match;
  if (!Array.isArray(match) || match.length === 0) return false;
  const hosts = (match[0] as Record<string, unknown>).host;
  if (!Array.isArray(hosts) || hosts.length === 0) return false;
  const hasLocalhost = hosts.some((h) =>
    typeof h === "string" &&
    (h === "localhost" || h === "127.0.0.1" || h === "[::1]")
  );
  if (!hasLocalhost) return false;
  const handle = route.handle;
  return Array.isArray(handle) &&
    handle.length > 0 &&
    (handle[0] as Record<string, unknown>).handler === "static_response";
}

/**
 * Whether a route is one of the generated health routes (`/teapot` -> 418,
 * fallback -> 404). Tagged `swamp:<model>:health:<kind>`.
 */
export function isHealthRoute(route: CaddyRoute): boolean {
  const id = route["@id"];
  return typeof id === "string" && id.startsWith("swamp:") &&
    id.includes(":health:");
}

/**
 * Whether a route is generated (status page or health), i.e. managed infra
 * rather than a user-declared route. Excluded from the desire-vs-actual diff.
 */
export function isGeneratedRoute(route: CaddyRoute): boolean {
  return isStatusPageRoute(route) || isHealthRoute(route);
}

/**
 * The health contract for the default/status hostnames: `/teapot` -> 418
 * (via the compiled-in teapot handler) and every other non-root path -> 404.
 * Caddy otherwise returns 200 for unrouted requests, so the 404 is explicit.
 */
export function buildHealthRoutes(
  hostnames: string[],
  modelName: string,
): CaddyRoute[] {
  if (hostnames.length === 0) return [];
  const id = (kind: string) =>
    `swamp:${modelName.replace(/[^a-zA-Z0-9_-]/g, "-")}:health:${kind}`;
  return [
    {
      "@id": id("teapot"),
      match: [{ host: hostnames, path: ["/teapot"] }],
      handle: [{ handler: "teapot" }],
      terminal: true,
    },
    {
      "@id": id("notfound"),
      match: [{ host: hostnames }],
      handle: [{
        handler: "static_response",
        status_code: 404,
        body: "404 Not Found",
      }],
      terminal: true,
    },
  ];
}

/** A discovered service link for the status page. */
export interface StatusLink {
  /** Link label. */
  label: string;
  /** Absolute URL. */
  url: string;
  /** Optional one-line description. */
  description?: string;
}

/** A module compiled into the Caddy binary (from `caddy list-modules --json`). */
export interface CaddyModule {
  /** Module name (e.g. `dns.providers.gandi`). */
  name: string;
  /** Standard (ships with Caddy) or non-standard (a compiled-in plugin). */
  type: string;
  /** Module version (usually the Caddy version for standard modules). */
  version: string;
  /** Go import path. */
  packagePath: string;
}

/**
 * Parse `caddy list-modules --json` output. Returns one entry per module. The
 * `type` distinguishes `standard` (ships with Caddy) from `non-standard`
 * (a third-party plugin compiled into this binary).
 */
export function parseModules(json: string): CaddyModule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const modules: CaddyModule[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.module_name !== "string") continue;
    modules.push({
      name: e.module_name,
      type: typeof e.module_type === "string" ? e.module_type : "",
      version: typeof e.version === "string" ? e.version : "",
      packagePath: typeof e.package_url === "string" ? e.package_url : "",
    });
  }
  return modules;
}

/**
 * The third-party plugins in a module list: non-standard modules grouped by Go
 * package, so several modules from one plugin collapse to a single entry with
 * its module names and version.
 */
export function thirdPartyPlugins(
  modules: CaddyModule[],
): Array<{ packagePath: string; version: string; modules: string[] }> {
  const byPackage = new Map<
    string,
    { packagePath: string; version: string; modules: string[] }
  >();
  for (const m of modules) {
    if (m.type !== "non-standard") continue;
    const key = m.packagePath || m.name;
    const entry = byPackage.get(key) ??
      { packagePath: m.packagePath, version: m.version, modules: [] };
    entry.modules.push(m.name);
    if (!entry.version && m.version) entry.version = m.version;
    byPackage.set(key, entry);
  }
  return [...byPackage.values()].sort((a, b) =>
    a.packagePath.localeCompare(b.packagePath)
  );
}

/** Render the default status page HTML for a Caddy install. */
export function renderStatusPage(opts: {
  title: string;
  version: string;
  adminUrl: string;
  baseDomain: string;
  email: string;
  capabilities: string[];
  links: StatusLink[];
  modules?: CaddyModule[];
  /** Precomputed third-party plugins (used instead of `modules` when given). */
  plugins?: Array<{ packagePath: string; version: string; modules: string[] }>;
  /** Hostnames/IPs Caddy is configured to listen on (e.g. [":443", ":80"]). */
  listens?: string[];
  /** The swamp model instance that owns this service. */
  modelName?: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const canBind = hasNetBindService(opts.capabilities);
  const links = opts.links.filter((l) => l.url);
  const listens = opts.listens ?? [];
  const listenRows = listens.map((l) => `      <li><code>${esc(l)}</code></li>`)
    .join("\n");
  const listensSection = listens.length > 0
    ? `<h2>Listening on</h2>
  <ul>
${listenRows}
  </ul>`
    : `<h2>Listening on</h2>
  <p class="muted">Nothing — no server addresses are configured in the running
  config.</p>`;
  const linkRows = links.map((l) =>
    `      <li><a href="${esc(l.url)}">${esc(l.label)}</a>${
      l.description ? ` — <span class="muted">${esc(l.description)}</span>` : ""
    }</li>`
  ).join("\n");
  const routesSection = links.length > 0
    ? `<ul>\n${linkRows}\n  </ul>`
    : `<p class="muted">No routes are managed by swamp models yet. Add one with
  <code>swamp model method run @svendowideit/caddy ensureDnsProxy NAME
  --input hostname=app.example.com --input upstream=127.0.0.1:8080</code>.</p>`;
  const plugins = opts.plugins ?? thirdPartyPlugins(opts.modules ?? []);
  const pluginRows = plugins.map((p) =>
    `      <li><code>${esc(p.packagePath)}</code>${
      p.version ? ` <span class="muted">${esc(p.version)}</span>` : ""
    }<br><span class="muted">${p.modules.map(esc).join(", ")}</span></li>`
  ).join("\n");
  const pluginsSection = plugins.length > 0
    ? `<h2>Compiled-in plugins</h2>
  <ul>
${pluginRows}
  </ul>`
    : `<h2>Compiled-in plugins</h2>
  <p class="muted">None — this is the stock Caddy binary. Add DNS providers and
  other modules with the <code>plugins</code> global arg, then reinstall.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
           max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { margin-bottom: .25rem; }
    .muted { color: #6b7280; }
    table { border-collapse: collapse; margin: 1rem 0; }
    td { padding: .15rem 1rem .15rem 0; vertical-align: top; }
    code { background: rgba(127,127,127,.15); padding: .1rem .35rem; border-radius: .25rem; }
    ul { padding-left: 1.1rem; }
    .ok { color: #059669; } .warn { color: #b45309; }
  </style>
</head>
<body>
  <h1>${esc(opts.title)}</h1>
  <p class="muted">This is the default Caddy status page. No site is configured
  for this address yet — routes are added with
  <code>swamp model method run … ensureDnsProxy</code>.</p>
  ${
    opts.modelName
      ? `<p class="muted">Managed by swamp model <code>${
        esc(opts.modelName)
      }</code>.</p>`
      : ""
  }

  <h2>Installed</h2>
  <table>
    <tr><td>Caddy version</td><td><code>${esc(opts.version)}</code></td></tr>
    <tr><td>Base domain</td><td>${
    opts.baseDomain
      ? `<code>${esc(opts.baseDomain)}</code>`
      : '<span class="muted">not set</span>'
  }</td></tr>
    <tr><td>ACME email</td><td>${
    opts.email
      ? `<code>${esc(opts.email)}</code>`
      : '<span class="muted">not set</span>'
  }</td></tr>
    <tr><td>Privileged ports</td><td>${
    canBind
      ? '<span class="ok">CAP_NET_BIND_SERVICE set (80/443 available)</span>'
      : '<span class="warn">capability not set — run setCapabilities for 80/443</span>'
  }</td></tr>
  </table>

  ${listensSection}

  <h2>Admin</h2>
  <ul>
    <li><a href="${esc(opts.adminUrl)}">Caddy admin API</a> —
      <span class="muted">live JSON config (<code>${
    esc(opts.adminUrl)
  }</code>)</span></li>
    <li><a href="https://caddyserver.com/docs/">Caddy documentation</a></li>
  </ul>

  <h2>Routes &amp; services</h2>
  ${routesSection}

  ${pluginsSection}

  <p class="muted">Generated by <code>@svendowideit/caddy</code>.</p>
</body>
</html>
`;
}

/**
 * The server listen addresses from a Caddy config, deduplicated and sorted, so
 * the status page can show what addresses Caddy is actually bound to.
 */
export function configuredListens(config: CaddyConfig): string[] {
  const seen = new Set<string>();
  const http = (config.apps as Record<string, unknown> | undefined)?.http as
    | Record<string, unknown>
    | undefined;
  const servers = http?.servers as Record<string, unknown> | undefined;
  if (!servers) return [];
  for (const srv of Object.values(servers)) {
    const listen = (srv as Record<string, unknown>)?.listen;
    if (Array.isArray(listen)) {
      for (const addr of listen) {
        if (typeof addr === "string") seen.add(addr);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Build the status-page "Routes & services" links from the *merged desired*
 * routes (the source of truth), plus any caller-supplied links. Deriving from
 * routes rather than re-parsing the config avoids listing the status page's own
 * localhost hostnames and keeps out-of-domain names intact.
 *
 * `statusHostnames` are excluded because they are the page's own match, not a
 * managed service.
 */
export function statusPageLinks(opts: {
  routes: Array<
    { hostname: string; kind: string; upstream?: string; root?: string }
  >;
  statusHostnames: string[];
  extra: Array<{ label: string; url: string }>;
}): StatusLink[] {
  const own = new Set(opts.statusHostnames);
  const links: StatusLink[] = [];
  for (const r of opts.routes) {
    if (!r.hostname || own.has(r.hostname)) continue;
    links.push({
      label: r.hostname,
      url: `https://${r.hostname}`,
      description: r.kind === "file_server"
        ? (r.root ? `files: ${r.root}` : "static files")
        : (r.upstream ? `→ ${r.upstream}` : undefined),
    });
  }
  for (const e of opts.extra) {
    links.push({ label: e.label, url: e.url });
  }
  return links;
}

/** A browsable URL for the admin API (http:// only; unix sockets yield ""). */
export function adminApiUrlString(adminApiAddr: string): string {
  const parsed = parseAdminAddr(adminApiAddr);
  if (parsed.kind === "unix") return "";
  const addr = adminApiAddr || "localhost:2019";
  return `http://${addr}/config/`;
}

// ---------------------------------------------------------------------------
// Desired-state merge (exported for unit testing)
// ---------------------------------------------------------------------------

/** One model's desired route. */
export interface DesiredRoute {
  /** Full hostname to match. */
  hostname: string;
  /** `proxy` (reverse_proxy) or `file_server`. */
  kind: "proxy" | "file_server";
  /** Upstream host:port for a proxy route. */
  upstream: string;
  /** Document root for a file_server route. */
  root: string;
  /** Enable directory browsing for a file_server route. */
  browse: boolean;
  /**
   * Serve a sub-path app (e.g. `/dashboard`) at the hostname root: the exact
   * path `/` is rewritten to this before the handler runs; all other paths pass
   * through. Empty proxies the host root as-is.
   */
  rootPath?: string;
}

/** One model's desired TLS automation. */
export interface DesiredTls {
  /** ACME email. */
  email: string;
  /** DNS provider name (empty = HTTP-01). */
  dnsProvider: string;
  /** Single-field credential env var. */
  dnsEnvVar: string;
  /** Multi-field credential map (field -> env var). */
  providerConfig: Record<string, string>;
  /** TLS subjects. */
  subjects: string[];
  /** Issuer module: "acme" (default) or "internal" (Caddy's local CA). */
  issuer?: string;
}

/** One model's desired status page. */
export interface DesiredStatusPage {
  /** Whether this model wants a status page. */
  enabled: boolean;
  /** Page heading. */
  title: string;
  /** Hostnames the page answers on. */
  hostnames: string[];
  /** Caller-supplied extra links. */
  extraLinks: Array<{ label: string; url: string }>;
  /** Snapshot install facts (version, admin URL, email, capabilities). */
  version: string;
  /** Admin API URL shown on the page. */
  adminUrl: string;
  /** Base domain shown on the page. */
  baseDomain: string;
  /** ACME email shown on the page. */
  email: string;
  /** Binary capabilities (for the privileged-ports line). */
  capabilities: string[];
  /** Third-party plugins compiled into the binary. */
  plugins: Array<{ packagePath: string; version: string; modules: string[] }>;
  /** Links shown on the page (derived from merged routes at reconcile time). */
  links: Array<{ label: string; url: string }>;
}

/** One model's desired static DNS record (dns_records). */
export interface DnsRecord {
  /** FQDN. */
  name: string;
  /** A, AAAA, or CNAME. */
  type: "A" | "AAAA" | "CNAME";
  /** Values: IPs for A/AAAA, one hostname for CNAME. */
  value: string[];
  /** Zone (empty = derive from name via the provider's ZoneLister). */
  zone: string;
  /** Per-record TTL (empty = global/provider default). */
  ttl: string;
}

/** One model's explicit DNS removal. */
export interface DnsRemoval {
  /** FQDN. */
  name: string;
  /** A, AAAA, or CNAME. */
  type: "A" | "AAAA" | "CNAME";
  /** Specific values to remove; empty = whole (name,type) RRset. */
  value: string[];
  /** Zone (empty = derive from name). */
  zone: string;
}

/** What one model wants from its Caddy. */
export interface DesiredState {
  /** The model instance name. */
  modelName: string;
  /** Host/service identity of the Caddy. */
  target: string;
  /** systemd unit name. */
  serviceName: string;
  /** Admin API address of this Caddy (to read its live config). */
  adminApiAddr: string;
  /** Base domain. */
  baseDomain: string;
  /** auto_https mode. */
  autoHttps: string;
  /** Server listen addresses. */
  listenAddrs: string[];
  /** Caddy modules this model asks to be compiled in. */
  plugins: string[];
  /** systemd EnvironmentFile holding DNS-provider credentials. */
  environmentFile: string;
  /** Path to the Caddy binary (to inspect compiled plugins). */
  caddyBinPath: string;
  /** Desired routes. */
  routes: DesiredRoute[];
  /** Desired TLS automation, or null. */
  tls: DesiredTls | null;
  /** Desired status page, or null. */
  statusPage: DesiredStatusPage | null;
  /** Desired static DNS records (dns_records). */
  dnsRecords: DnsRecord[];
  /** Explicit DNS removals. */
  dnsRemovals: DnsRemoval[];
  /** Default TTL for dnsRecords (a short value propagates changes quickly). */
  dnsTtl: string;
  /** Whether to install the / -> 200, /teapot -> 418, other -> 404 health contract. */
  healthRoutes: boolean;
  /** Last update timestamp. */
  updatedAt: string;
}

/** The merge key for a Caddy: which host + which service name. */
export function caddyTargetKey(target: string, serviceName: string): string {
  return `${target || "local"}\u0000${serviceName || "caddy"}`;
}

/** The Caddy `@id` we tag a route with, so reconcile only touches our own. */
export function routeId(modelName: string, hostname: string): string {
  const safe = modelName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `swamp:${safe}:${hostname}`;
}

/**
 * Merge several models' desired state for one target into a single config.
 *
 * Routes union by hostname (a duplicate hostname is a real conflict). listenAddrs
 * and TLS subjects union; a genuine contradiction (two different emails, two
 * different DNS providers, incompatible listen addrs) is an error naming the
 * models rather than a silent last-writer-wins. Only one status page is allowed;
 * more than one model requesting one is a conflict.
 */
export function mergeDesired(states: DesiredState[]): {
  merged: {
    routes: DesiredRoute[];
    listenAddrs: string[];
    autoHttps: string;
    tls: DesiredTls | null;
    statusPage: DesiredStatusPage | null;
    models: string[];
    tlsModels: string[];
    statusPageModel: string;
    dnsRecords: DnsRecord[];
    dnsRemovals: DnsRemoval[];
    dnsTtl: string;
    healthRoutes: boolean;
  };
  errors: string[];
} {
  const errors: string[] = [];
  const routeByHost = new Map<string, { route: DesiredRoute; model: string }>();
  const listenSet = new Set<string>();
  const models: string[] = [];

  for (const s of states) {
    models.push(s.modelName);
    for (const addr of s.listenAddrs) listenSet.add(addr);
    for (const r of s.routes) {
      const existing = routeByHost.get(r.hostname);
      if (existing && existing.model !== s.modelName) {
        // Same hostname from two models is only OK if they're identical.
        if (JSON.stringify(existing.route) !== JSON.stringify(r)) {
          errors.push(
            `route conflict for '${r.hostname}': desired by '${existing.model}' and '${s.modelName}'`,
          );
        }
        continue;
      }
      routeByHost.set(r.hostname, { route: r, model: s.modelName });
    }
  }

  // Singleton settings: union where sensible, error on contradiction.
  const autoHttpsValues = new Set(states.map((s) => s.autoHttps));
  if (autoHttpsValues.size > 1) {
    errors.push(
      `autoHttps conflict across models ${models.join(", ")}: ${
        [...autoHttpsValues].join(" vs ")
      }`,
    );
  }

  // TLS: union subjects/maps; a differing email or provider is a conflict.
  const tlsStates = states.filter((s) => s.tls);
  let tls: DesiredTls | null = null;
  const tlsModels: string[] = [];
  if (tlsStates.length > 0) {
    const emails = new Set(tlsStates.map((s) => s.tls!.email));
    const providers = new Set(tlsStates.map((s) => s.tls!.dnsProvider));
    if (emails.size > 1) {
      errors.push(
        `TLS email conflict across models ${
          tlsStates.map((s) => s.modelName).join(", ")
        }: ${[...emails].join(" vs ")}`,
      );
    }
    if (providers.size > 1) {
      errors.push(
        `TLS DNS provider conflict across models ${
          tlsStates.map((s) => s.modelName).join(", ")
        }: ${[...providers].join(" vs ")}`,
      );
    }
    const subjects = new Set<string>();
    const providerConfig: Record<string, string> = {};
    let dnsEnvVar = "";
    let issuer = "";
    for (const s of tlsStates) {
      tlsModels.push(s.modelName);
      for (const sub of s.tls!.subjects) subjects.add(sub);
      Object.assign(providerConfig, s.tls!.providerConfig);
      dnsEnvVar = dnsEnvVar || s.tls!.dnsEnvVar;
      issuer = issuer || (s.tls!.issuer ?? "");
    }
    tls = {
      email: [...emails][0] ?? "",
      dnsProvider: [...providers][0] ?? "",
      dnsEnvVar,
      providerConfig,
      subjects: [...subjects].sort(),
      issuer,
    };
  }

  // The status page is a singleton on localhost. Several models may request one
  // (installCaddy/startService do so automatically), so this is not a conflict:
  // pick deterministically by model name so the result is stable. An explicit
  // configureStatusPage on one model is how you change its title.
  const statusStates = states
    .filter((s) => s.statusPage?.enabled)
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
  const statusPage = statusStates.length > 0
    ? statusStates[0].statusPage
    : null;

  // DNS records union on (name, type). A same-key record with different values
  // from two models is a conflict; identical ones dedupe. A (name, type) that is
  // both declared and removed is a conflict.
  const dnsByKey = new Map<string, { rec: DnsRecord; model: string }>();
  for (const s of states) {
    for (const rec of s.dnsRecords ?? []) {
      const key = `${rec.type}\u0000${rec.name}`;
      const existing = dnsByKey.get(key);
      if (existing && JSON.stringify(existing.rec) !== JSON.stringify(rec)) {
        errors.push(
          `DNS record conflict for '${rec.name} ${rec.type}': desired by '${existing.model}' and '${s.modelName}'`,
        );
        continue;
      }
      dnsByKey.set(key, { rec, model: s.modelName });
    }
  }
  const dnsByKey2 = new Map<string, { rem: DnsRemoval; model: string }>();
  for (const s of states) {
    for (const rem of s.dnsRemovals ?? []) {
      const key = `${rem.type}\u0000${rem.name}`;
      if (dnsByKey.has(key)) {
        errors.push(
          `DNS conflict for '${rem.name} ${rem.type}': declared by '${
            dnsByKey.get(key)!.model
          }' and removed by '${s.modelName}'`,
        );
      }
      dnsByKey2.set(key, { rem, model: s.modelName });
    }
  }
  const dnsRecords = [...dnsByKey.values()].map((v) => v.rec)
    .sort((a, b) =>
      a.name.localeCompare(b.name) || a.type.localeCompare(b.type)
    );
  const dnsRemovals = [...dnsByKey2.values()].map((v) => v.rem)
    .sort((a, b) =>
      a.name.localeCompare(b.name) || a.type.localeCompare(b.type)
    );
  // Health routes are on by default; any model can turn them off for the host.
  const healthRoutes = states.some((s) => s.healthRoutes);
  // Default DNS TTL: first model that sets one wins (all default to 5m anyway).
  const dnsTtl = states.find((s) => s.dnsTtl)?.dnsTtl ?? "5m";

  const routes = [...routeByHost.values()]
    .map((v) => ({ ...v.route, model: v.model }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  const listenAddrs = [...listenSet].sort();

  return {
    merged: {
      routes,
      listenAddrs,
      autoHttps: states[0]?.autoHttps ?? "on",
      tls,
      statusPage,
      models,
      tlsModels,
      statusPageModel: statusStates[0]?.modelName ?? "",
      dnsRecords,
      dnsRemovals,
      dnsTtl,
      healthRoutes,
    },
    errors,
  };
}

/**
 * Build a Caddy config from merged desired state, preserving only the
 * `swamp:`-tagged routes we own (so hand-added routes survive reconcile).
 * Proxy and file_server routes are tagged with a stable `@id`; the status page
 * is a static_response on its hostnames.
 */
export function buildReconciledConfig(
  current: CaddyConfig,
  merged: {
    routes: Array<DesiredRoute & { model?: string }>;
    listenAddrs: string[];
    autoHttps: string;
    tls: DesiredTls | null;
    statusPage: DesiredStatusPage | null;
    statusPageModel: string;
    dnsRecords?: DnsRecord[];
    dnsRemovals?: DnsRemoval[];
    dnsTtl?: string;
    healthRoutes?: boolean;
  },
): CaddyConfig {
  const base = baseConfig(
    merged.listenAddrs.length > 0 ? merged.listenAddrs : [":443", ":80"],
    merged.autoHttps,
  );
  // Keep routes we do not own. `isStatusPageRoute` also recognises a status
  // route written by an earlier version that predates `@id` tagging, so an
  // upgrade does not leave a duplicate localhost route behind.
  const kept = getRoutes(current).filter(
    (r) => !isSwampRoute(r) && !isGeneratedRoute(r),
  );
  const built: CaddyRoute[] = [...kept];
  for (const r of merged.routes) {
    const id = routeId(
      r.model ?? merged.statusPageModel ?? "caddy",
      r.hostname,
    );
    if (r.kind === "file_server") {
      const handle: Record<string, unknown> = {
        handler: "file_server",
        root: r.root,
      };
      if (r.browse) handle.browse = {};
      built.push({
        "@id": id,
        match: [{ host: [r.hostname] }],
        handle: [handle],
        terminal: true,
      });
    } else {
      const upstream = parseUpstream(r.upstream);
      built.push({
        "@id": id,
        match: [{ host: [r.hostname] }],
        handle: buildProxyHandle(upstream, r.rootPath ?? ""),
        terminal: true,
      });
    }
  }
  const routedHostnames = merged.routes.map((r) => r.hostname);
  const wantStatus = !!merged.statusPage?.enabled;
  const wantHealth = merged.healthRoutes ?? true;
  // The status page / health contract apply to the DEFAULT host set: loopback
  // plus every hostname the models name (TLS subjects + explicit status
  // hostnames) minus those with a real route of their own.
  const statusHostnames = defaultStatusHostnames({
    tlsSubjects: merged.tls?.subjects ?? [],
    explicit: merged.statusPage?.hostnames ?? [],
    routedHostnames,
  });
  if (wantStatus) {
    // Re-render against the *merged* routes/listens so the page never shows a
    // stale list after another model adds/removes a route.
    const sp = merged.statusPage!;
    const links = statusPageLinks({
      routes: merged.routes,
      statusHostnames,
      extra: sp.extraLinks,
    });
    const html = renderStatusPage({
      title: sp.title,
      version: sp.version,
      adminUrl: sp.adminUrl,
      baseDomain: sp.baseDomain,
      email: sp.email,
      capabilities: sp.capabilities,
      links,
      modules: [],
      listens: merged.listenAddrs,
      modelName: merged.statusPageModel,
      plugins: sp.plugins,
    });
    // Pushed before the health routes so the `/` match wins over the 404.
    const route = buildStatusPageRoute(html, statusHostnames);
    route["@id"] = routeId(merged.statusPageModel, "status");
    built.push(route);
  }
  if (wantHealth) {
    built.push(
      ...buildHealthRoutes(statusHostnames, merged.statusPageModel || "caddy"),
    );
  }
  let next = base;
  setRoutes(next, built);
  if (merged.tls) {
    const tlsConfig = renderTlsAutomation({
      email: merged.tls.email,
      dnsProvider: merged.tls.dnsProvider || undefined,
      dnsEnvVar: merged.tls.dnsEnvVar || undefined,
      providerConfig: Object.keys(merged.tls.providerConfig).length > 0
        ? merged.tls.providerConfig
        : undefined,
      subjects: merged.tls.subjects,
      issuer: merged.tls.issuer,
    });
    // mergeTlsConfig returns a clone, so keep its result or the tls app is lost.
    next = mergeTlsConfig(next, tlsConfig);
  }
  // Static DNS records (caddy-host-dns). Written only when there is something
  // to manage; otherwise a stale app is removed so it cannot keep reconciling.
  const dnsRecords = merged.dnsRecords ?? [];
  const dnsRemovals = merged.dnsRemovals ?? [];
  if (dnsRecords.length > 0 || dnsRemovals.length > 0) {
    writeDnsRecords(next, merged.tls, dnsRecords, dnsRemovals, merged.dnsTtl);
  } else {
    const apps = (next.apps ??= {}) as Record<string, unknown>;
    delete apps.dns_records;
  }
  return next;
}

/** Whether a route is one swamp tagged (so reconcile only owns its own). */
export function isSwampRoute(route: CaddyRoute): boolean {
  const id = route["@id"];
  return typeof id === "string" && id.startsWith("swamp:");
}

/** The hostnames a route matches on. */
export function routeHostnames(route: CaddyRoute): string[] {
  const match = route.match;
  if (!Array.isArray(match)) return [];
  const hosts: string[] = [];
  for (const m of match) {
    const h = (m as Record<string, unknown>).host;
    if (Array.isArray(h)) {
      for (const x of h) if (typeof x === "string") hosts.push(x);
    }
  }
  return hosts;
}

/**
 * Compare the merged desired routes against what is actually in the running
 * Caddy, so "should be" can be diffed against "is". Returns the two sides,
 * the split of swamp vs foreign routes, and the drift on each side.
 */
export function diffRoutes(
  desired: Array<
    {
      hostname: string;
      kind: string;
      upstream: string;
      root: string;
      model: string;
    }
  >,
  actual: CaddyConfig,
): {
  desiredRoutes: typeof desired;
  actualSwampRoutes: Array<{ id: string; hostnames: string[] }>;
  foreignRoutes: string[];
  onlyDesired: string[];
  onlyActual: string[];
  inSync: boolean;
} {
  const actualSwampRoutes: Array<{ id: string; hostnames: string[] }> = [];
  const foreignRoutes: string[] = [];
  const actualHosts = new Set<string>();
  for (const r of getRoutes(actual)) {
    const hosts = routeHostnames(r);
    if (isSwampRoute(r) && !isGeneratedRoute(r)) {
      actualSwampRoutes.push({
        id: String(r["@id"]),
        hostnames: hosts,
      });
      for (const h of hosts) actualHosts.add(h);
    } else if (!isGeneratedRoute(r)) {
      foreignRoutes.push(...hosts);
    }
  }
  const desiredHosts = new Set(desired.map((d) => d.hostname));
  const onlyDesired = [...desiredHosts].filter((h) => !actualHosts.has(h))
    .sort();
  const onlyActual = [...actualHosts].filter((h) => !desiredHosts.has(h))
    .sort();
  return {
    desiredRoutes: desired,
    actualSwampRoutes,
    foreignRoutes: foreignRoutes.sort(),
    onlyDesired,
    onlyActual,
    inSync: onlyDesired.length === 0 && onlyActual.length === 0,
  };
}

/**
 * Build the Caddy `handle` array for a reverse-proxy route. When `rootPath` is
 * set (e.g. `/dashboard`), a subroute rewrites only the exact path `/` to it so
 * a sub-path app is served at the hostname root while its absolute asset/API
 * paths pass through unchanged (rewriting unconditionally would turn asset
 * requests into the app's HTML).
 */
export function buildProxyHandle(
  upstream: { dial: string; https: boolean },
  rootPath = "",
): Record<string, unknown>[] {
  const proxyHandler: Record<string, unknown> = {
    handler: "reverse_proxy",
    upstreams: [{ dial: upstream.dial }],
  };
  if (upstream.https) proxyHandler.transport = { protocol: "http", tls: {} };
  if (!rootPath) return [proxyHandler];
  return [{
    handler: "subroute",
    routes: [
      {
        match: [{ path: ["/"] }],
        handle: [{ handler: "rewrite", uri: rootPath }],
      },
      { handle: [proxyHandler] },
    ],
  }];
}

/** Build a Caddy reverse-proxy route for a hostname + upstream. */
export function buildRoute(
  hostname: string,
  upstream: { dial: string; https: boolean },
  rootPath = "",
): CaddyRoute {
  return {
    match: [{ host: [hostname] }],
    handle: buildProxyHandle(upstream, rootPath),
    terminal: true,
  };
}

/**
 * Map an automatic-HTTPS mode to the JSON server's `automatic_https` object.
 * Caddy's Caddyfile `auto_https` global option adapts to this per-server field;
 * we set it directly because routes are applied via the admin API as JSON.
 * Returns null for the default (`on`) so the field is omitted.
 */
export function automaticHttpsConfig(
  mode: string,
): Record<string, unknown> | null {
  switch (mode) {
    case "off":
      return { disable: true };
    case "disable_redirects":
      return { disable_redirects: true };
    case "disable_certs":
      return { disable_certificates: true };
    case "ignore_loaded_certs":
      return { ignore_loaded_certificates: true };
    default:
      return null;
  }
}

/** The base Caddy JSON config with an empty route table. */
export function baseConfig(
  listenAddrs: string[] = [":443", ":80"],
  autoHttps = "on",
): CaddyConfig {
  const srv0: Record<string, unknown> = {
    listen: listenAddrs,
    routes: [],
  };
  const automaticHttps = automaticHttpsConfig(autoHttps);
  if (automaticHttps) srv0.automatic_https = automaticHttps;
  return {
    apps: {
      http: {
        servers: { srv0 },
      },
    },
  };
}

/**
 * Ensure the managed HTTP server (`apps.http.servers.srv0`) exists with the
 * configured listen addresses and automatic-HTTPS setting. An existing server
 * is left untouched, so a running config is never clobbered.
 */
export function ensureServerDefaults(
  config: CaddyConfig,
  listenAddrs: string[] = [":443", ":80"],
  autoHttps = "on",
): CaddyConfig {
  const next = structuredClone(config);
  const apps = (next.apps ??= {}) as Record<string, unknown>;
  const http = (apps.http ??= {}) as Record<string, unknown>;
  const servers = (http.servers ??= {}) as Record<string, unknown>;
  if (!servers.srv0) {
    const srv0: Record<string, unknown> = {
      listen: listenAddrs,
      routes: [],
    };
    const automaticHttps = automaticHttpsConfig(autoHttps);
    if (automaticHttps) srv0.automatic_https = automaticHttps;
    servers.srv0 = srv0;
  }
  return next;
}

/** Read the routes array from a config (empty if absent). */
function getRoutes(config: CaddyConfig): CaddyRoute[] {
  const servers = (config.apps as Record<string, unknown> | undefined)?.http as
    | Record<string, unknown>
    | undefined;
  const srv0 = (servers?.servers as Record<string, unknown> | undefined)
    ?.srv0 as
      | Record<string, unknown>
      | undefined;
  const routes = srv0?.routes;
  return Array.isArray(routes) ? (routes as CaddyRoute[]) : [];
}

/** Write the routes array back into a config, ensuring the structure exists. */
function setRoutes(config: CaddyConfig, routes: CaddyRoute[]): void {
  const apps = (config.apps ??= {}) as Record<string, unknown>;
  const http = (apps.http ??= {}) as Record<string, unknown>;
  const servers = (http.servers ??= {}) as Record<string, unknown>;
  const srv0 = (servers.srv0 ??= { listen: [":443", ":80"] }) as Record<
    string,
    unknown
  >;
  srv0.routes = routes;
}

/** Find a route matching a hostname, returning it and its index. */
export function findRouteByHost(
  config: CaddyConfig,
  hostname: string,
): { route: CaddyRoute; index: number } | null {
  const routes = getRoutes(config);
  for (let i = 0; i < routes.length; i++) {
    const match = routes[i].match;
    if (Array.isArray(match)) {
      for (const m of match) {
        const hosts = (m as Record<string, unknown>).host;
        if (Array.isArray(hosts) && hosts.includes(hostname)) {
          return { route: routes[i], index: i };
        }
      }
    }
  }
  return null;
}

/** Render a descriptive domain-conflict error with resolution guidance. */
export function renderDomainConflictError(
  hostname: string,
  existingRoute: CaddyRoute,
): string {
  return [
    `Domain '${hostname}' is already in use.`,
    `Existing route: ${JSON.stringify(existingRoute)}`,
    "",
    "To resolve:",
    `  1. Remove the conflicting service first (removeProxyService for the`,
    `     service that owns '${hostname}').`,
    "  2. Or choose a different service name / base domain.",
  ].join("\n");
}

/** Extract the first hostname a route matches on (or null). */
function routeHostname(route: CaddyRoute): string | null {
  const match = route.match;
  if (!Array.isArray(match)) return null;
  for (const m of match) {
    const hosts = (m as Record<string, unknown>).host;
    if (Array.isArray(hosts) && typeof hosts[0] === "string") {
      return hosts[0] as string;
    }
  }
  return null;
}

/** Add a route to a config, throwing a descriptive error on host conflict. */
export function addRouteToConfig(
  config: CaddyConfig,
  route: CaddyRoute,
): CaddyConfig {
  const hostname = routeHostname(route);
  if (!hostname) {
    throw new Error("Route has no host match; cannot add it");
  }
  const existing = findRouteByHost(config, hostname);
  if (existing) {
    throw new Error(renderDomainConflictError(hostname, existing.route));
  }
  const next = structuredClone(config);
  const routes = getRoutes(next);
  routes.push(route);
  setRoutes(next, routes);
  return next;
}

/**
 * Remove a route for a hostname.
 *
 * Idempotent: when no route exists the config is returned unchanged with
 * `changed: false`, so a delete of an already-gone route succeeds rather than
 * throwing.
 */
export function removeRouteFromConfig(
  config: CaddyConfig,
  hostname: string,
): { config: CaddyConfig; changed: boolean } {
  const existing = findRouteByHost(config, hostname);
  if (!existing) {
    return { config, changed: false };
  }
  const next = structuredClone(config);
  const routes = getRoutes(next);
  routes.splice(existing.index, 1);
  setRoutes(next, routes);
  return { config: next, changed: true };
}

/** Extract the list of proxy services (name/hostname/upstream) from a config. */
export function listProxyServices(
  config: CaddyConfig,
  baseDomain: string,
): Array<{ serviceName: string; hostname: string; upstream: string }> {
  const services: Array<
    { serviceName: string; hostname: string; upstream: string }
  > = [];
  for (const route of getRoutes(config)) {
    const match = route.match;
    if (!Array.isArray(match)) continue;
    for (const m of match) {
      const hosts = (m as Record<string, unknown>).host;
      if (!Array.isArray(hosts)) continue;
      for (const host of hosts) {
        if (typeof host !== "string") continue;
        const suffix = `.${baseDomain}`;
        const serviceName = host.endsWith(suffix)
          ? host.slice(0, -suffix.length)
          : host;
        const handle = route.handle;
        const upstream = Array.isArray(handle) && handle.length > 0
          ? ((handle[0] as Record<string, unknown>).upstreams as
            | Array<Record<string, unknown>>
            | undefined)?.[0]?.dial as string | undefined
          : undefined;
        services.push({
          serviceName,
          hostname: host,
          upstream: upstream ?? "",
        });
      }
    }
  }
  return services;
}

// ---------------------------------------------------------------------------
// Admin API address + vault config pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Parse an admin API address into an HTTP or Unix-socket endpoint. */
export function parseAdminAddr(
  addr: string,
): { kind: "http" | "unix"; socketPath?: string } {
  if (addr.startsWith("unix/")) {
    return { kind: "unix", socketPath: addr.slice("unix/".length) };
  }
  return { kind: "http" };
}

/** Render the Caddy `admin` config object for a given listen address. */
export function renderAdminConfig(adminApiAddr: string): { listen: string } {
  return { listen: adminApiAddr };
}

/** Validate a base domain (bare hostname, no scheme/path). Throws if invalid. */
export function validateBaseDomain(domain: string): void {
  if (!domain) throw new Error("base domain is required");
  if (domain.includes("://") || domain.includes("/") || /\s/.test(domain)) {
    throw new Error(
      `Invalid base domain '${domain}': expected a bare domain like example.com`,
    );
  }
  if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes(".")) {
    throw new Error(
      `Invalid base domain '${domain}': expected a bare domain like example.com`,
    );
  }
}

/** Validate an email address. Throws if invalid. */
export function validateEmail(email: string): void {
  if (!email) throw new Error("email is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`Invalid email '${email}'`);
  }
}

/** Build curl arguments for a request over a Unix socket. */
export function buildCurlArgs(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): string[] {
  const args = [
    "--unix-socket",
    socketPath,
    "-sS",
    "-w",
    "\n%{http_code}",
    "-X",
    method,
    `http://localhost${path}`,
  ];
  if (body !== undefined) {
    args.push(
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      JSON.stringify(body),
    );
  }
  if (token) {
    args.push("-H", `Authorization: Bearer ${token}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// TLS + auto-proxy pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Map a DNS provider name to its Caddy plugin module path. */
const DNS_PROVIDER_PLUGINS: Record<string, string> = {
  cloudflare: "github.com/caddy-dns/cloudflare",
  route53: "github.com/caddy-dns/route53",
  digitalocean: "github.com/caddy-dns/digitalocean",
  duckdns: "github.com/caddy-dns/duckdns",
  porkbun: "github.com/caddy-dns/porkbun",
  namecheap: "github.com/caddy-dns/namecheap",
  gandi: "github.com/caddy-dns/gandi",
  dreamhost: "github.com/caddy-dns/dreamhost",
};

/**
 * Map a DNS provider name to its Caddy plugin module path.
 *
 * Throws for an unsupported provider, listing the supported names.
 */
export function dnsProviderPlugin(provider: string): string {
  const plugin = DNS_PROVIDER_PLUGINS[provider.toLowerCase()];
  if (!plugin) {
    throw new Error(
      `Unsupported DNS provider '${provider}'; supported: ${
        Object.keys(DNS_PROVIDER_PLUGINS).join(", ")
      }`,
    );
  }
  return plugin;
}

/** Render the Caddy TLS automation config (ACME email + optional DNS challenge). */
export function renderTlsAutomation(opts: {
  email?: string;
  dnsProvider?: string;
  dnsEnvVar?: string;
  providerConfig?: Record<string, string>;
  subjects?: string[];
  issuer?: string;
}): CaddyConfig {
  // `internal` selects Caddy's local CA (self-signed, useful for non-public
  // names and tests where Let's Encrypt cannot issue). The ACME issuer is the
  // default; its email/challenge fields are ignored for the internal issuer.
  const issuerModule = opts.issuer === "internal" ? "internal" : "acme";
  const issuer: Record<string, unknown> = { module: issuerModule };
  if (issuerModule === "acme" && opts.email) issuer.email = opts.email;
  if (issuerModule === "acme" && opts.dnsProvider) {
    // Each provider has its own credential field names: Cloudflare/Route53/
    // DigitalOcean/DuckDNS/Porkbun take a single `api_token`, but Gandi uses
    // `bearer_token`, Namecheap needs `api_key`+`user`, DreamHost `api_key`,
    // and so on. `providerConfig` maps each field to the env var holding its
    // value; when absent we fall back to the historical single `api_token`.
    const credentials: Record<string, string> = opts.providerConfig ??
      { api_token: opts.dnsEnvVar ?? "CADDY_DNS_API_TOKEN" };
    const provider: Record<string, string> = { name: opts.dnsProvider };
    for (const [field, envVar] of Object.entries(credentials)) {
      provider[field] = `{env.${envVar}}`;
    }
    issuer.challenges = { dns: { provider } };
  }
  const policy: Record<string, unknown> = { issuers: [issuer] };
  if (opts.subjects && opts.subjects.length > 0) {
    policy.subjects = opts.subjects;
  }
  return {
    apps: {
      tls: {
        automation: {
          policies: [policy],
        },
      },
    },
  };
}

/**
 * Write the `dns_records` app (github.com/SvenDowideit/caddy-host-dns) into a
 * config from the merged desired DNS state. The DNS provider block reuses the
 * TLS provider config, so the A/AAAA/CNAME writer and the ACME DNS-01 solver
 * share one credential source (the service EnvironmentFile).
 */
export function writeDnsRecords(
  config: CaddyConfig,
  tls: DesiredTls | null,
  records: DnsRecord[],
  removals: DnsRemoval[],
  ttl = "",
): void {
  const apps = (config.apps ??= {}) as Record<string, unknown>;
  if (!tls || !tls.dnsProvider) {
    throw new Error(
      "dnsRecords require a DNS provider: set the tls dnsProvider so Caddy can write the records",
    );
  }
  const credentials: Record<string, string> = Object.keys(tls.providerConfig)
      .length > 0
    ? tls.providerConfig
    : { api_token: tls.dnsEnvVar || "CADDY_DNS_API_TOKEN" };
  const provider: Record<string, string> = { name: tls.dnsProvider };
  for (const [field, envVar] of Object.entries(credentials)) {
    provider[field] = `{env.${envVar}}`;
  }
  const recDto = records.map((r) => {
    const dto: Record<string, unknown> = {
      name: r.name,
      type: r.type,
      value: r.value,
    };
    if (r.zone) dto.zone = r.zone;
    if (r.ttl) dto.ttl = r.ttl;
    return dto;
  });
  const remDto = removals.map((r) => {
    const dto: Record<string, unknown> = { name: r.name, type: r.type };
    if (r.value.length) dto.value = r.value;
    if (r.zone) dto.zone = r.zone;
    return dto;
  });
  apps.dns_records = {
    providers: [{
      dns_provider: provider,
      records: recDto,
      ...(remDto.length ? { remove: remDto } : {}),
    }],
    ...(ttl ? { ttl } : {}),
  };
}

/** Merge a TLS config into a Caddy config (replaces the `tls` app). */
export function mergeTlsConfig(
  config: CaddyConfig,
  tlsConfig: CaddyConfig,
): CaddyConfig {
  const next = structuredClone(config);
  const tls = (tlsConfig.apps as Record<string, unknown>).tls;
  const apps = (next.apps ??= {}) as Record<string, unknown>;
  apps.tls = tls;
  return next;
}

/** Detect swamp-serve service names from a list of systemd unit names. */
export function detectSwampServeServices(
  unitNames: string[],
  prefix: string,
): string[] {
  return unitNames
    .filter((name) => name.startsWith(prefix) && name.endsWith(".service"))
    .map((name) => name.slice(prefix.length, -".service".length))
    .filter((name) => name.length > 0);
}

/** Compute the ensure/remove diff between desired services and the current config. */
export function reconcileProxyServices(
  desired: Array<{ serviceName: string; hostname: string; upstream: string }>,
  currentConfig: CaddyConfig,
  baseDomain: string,
): {
  toEnsure: Array<{ hostname: string; upstream: string }>;
  toRemove: string[];
} {
  const current = listProxyServices(currentConfig, baseDomain);
  const desiredHostnames = new Set(desired.map((s) => s.hostname));

  const toEnsure = desired.map((s) => ({
    hostname: s.hostname,
    upstream: s.upstream,
  }));

  const toRemove = current
    .filter((s) => !desiredHostnames.has(s.hostname))
    .map((s) => s.hostname);

  return { toEnsure, toRemove };
}

// ---------------------------------------------------------------------------
// Upgrade + health pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Render the confirmation prompt shown when an upgrade lacks confirm=upgrade. */
export function renderUpgradeConfirmation(opts: {
  plugins: string[];
}): string {
  return [
    "Upgrading/replacing the Caddy binary is a destructive operation that",
    "restarts the Caddy service. To proceed, re-run with confirm=upgrade.",
    "",
    "  target version: current caddyserver.com release",
    `  packages: ${
      opts.plugins.length > 0 ? opts.plugins.join(", ") : "(none)"
    }`,
    "",
    "Existing configuration is preserved (the config file and admin API",
    "config are not modified).",
  ].join("\n");
}

/** Combine service + admin API liveness into a health verdict. */
export function computeHealth(
  active: boolean,
  adminApiReachable: boolean,
): { healthy: boolean; status: string } {
  if (active && adminApiReachable) {
    return { healthy: true, status: "healthy" };
  }
  if (!active && !adminApiReachable) {
    return { healthy: false, status: "down" };
  }
  if (!active) {
    return { healthy: false, status: "service-not-active" };
  }
  return { healthy: false, status: "admin-api-unreachable" };
}

// ---------------------------------------------------------------------------
// Desired-state proxy helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Extract the first upstream dial address from a route (or ""). */
export function routeUpstream(route: CaddyRoute): string {
  const handle = route.handle;
  if (Array.isArray(handle) && handle.length > 0) {
    const upstreams = (handle[0] as Record<string, unknown>).upstreams;
    if (Array.isArray(upstreams) && upstreams.length > 0) {
      const dial = (upstreams[0] as Record<string, unknown>).dial;
      if (typeof dial === "string") return dial;
    }
  }
  return "";
}

/** Idempotently ensure a hostname proxies to an upstream (add/update/no-op). */
export function ensureRoute(
  config: CaddyConfig,
  hostname: string,
  upstream: { dial: string; https: boolean },
): { config: CaddyConfig; changed: boolean } {
  const existing = findRouteByHost(config, hostname);
  const route = buildRoute(hostname, upstream);
  if (!existing) {
    return { config: addRouteToConfig(config, route), changed: true };
  }
  if (routeUpstream(existing.route) === upstream.dial) {
    return { config, changed: false };
  }
  const next = structuredClone(config);
  const routes = getRoutes(next);
  routes[existing.index] = route;
  setRoutes(next, routes);
  return { config: next, changed: true };
}

/** Idempotently ensure a hostname serves static files from a root directory. */
export function ensureFileServerRoute(
  config: CaddyConfig,
  hostname: string,
  root: string,
  browse = false,
): { config: CaddyConfig; changed: boolean } {
  const existing = findRouteByHost(config, hostname);
  const route = buildFileServerRoute(hostname, root, browse);
  if (!existing) {
    return { config: addRouteToConfig(config, route), changed: true };
  }
  const current = existing.route.handle as Array<Record<string, unknown>>;
  const isFileServer = Array.isArray(current) &&
    current[0]?.handler === "file_server";
  const currentBrowse = isFileServer && current[0]?.browse !== undefined;
  if (
    isFileServer && routeFileServerRoot(existing.route) === root &&
    currentBrowse === browse
  ) {
    return { config, changed: false };
  }
  const next = structuredClone(config);
  const routes = getRoutes(next);
  routes[existing.index] = route;
  setRoutes(next, routes);
  return { config: next, changed: true };
}

/**
 * Ensure the default status page route is present (idempotent). The route is a
 * single `static_response` matching the status hostnames, so it returns the same
 * page on http://localhost and https://localhost. Replaces an existing status
 * route when the HTML changed.
 */
export function ensureStatusPageRoute(
  config: CaddyConfig,
  html: string,
): { config: CaddyConfig; changed: boolean } {
  const routes = getRoutes(config);
  const idx = routes.findIndex(isStatusPageRoute);
  const route = buildStatusPageRoute(html);
  const next = structuredClone(config);
  const nextRoutes = getRoutes(next);
  if (idx === -1) {
    nextRoutes.push(route);
    setRoutes(next, nextRoutes);
    return { config: next, changed: true };
  }
  if (JSON.stringify(nextRoutes[idx]) === JSON.stringify(route)) {
    return { config, changed: false };
  }
  nextRoutes[idx] = route;
  setRoutes(next, nextRoutes);
  return { config: next, changed: true };
}

/** Remove the default status page route (idempotent). */
export function removeStatusPageRoute(
  config: CaddyConfig,
): { config: CaddyConfig; changed: boolean } {
  const routes = getRoutes(config);
  const idx = routes.findIndex(isStatusPageRoute);
  if (idx === -1) return { config, changed: false };
  const next = structuredClone(config);
  const nextRoutes = getRoutes(next);
  nextRoutes.splice(idx, 1);
  setRoutes(next, nextRoutes);
  return { config: next, changed: true };
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

type CmdResult = { stdout: string; stderr: string; code: number };

async function runCmd(
  binary: string,
  args: string[],
): Promise<CmdResult> {
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

/**
 * Build the caddyserver.com download URL for the current Caddy release.
 *
 * The API always serves the current version; module packages are requested
 * with repeatable `p` parameters (each may be `path` or `path@version`), which
 * is the same mechanism the official download page uses.
 */
export function caddyDownloadUrl(
  arch: string,
  plugins: string[] = [],
): string {
  const params = new URLSearchParams({ os: "linux", arch });
  for (const plugin of plugins) params.append("p", plugin);
  return `https://caddyserver.com/api/download?${params.toString()}`;
}

/**
 * Download the Caddy binary (current release, with any requested module
 * packages compiled in) and make it executable.
 */
async function downloadCaddy(
  binPath: string,
  arch: string,
  plugins: string[] = [],
): Promise<void> {
  const url = caddyDownloadUrl(arch, plugins);
  const resp = await fetch(url);
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `Failed to download Caddy (${resp.status}): ${url}${
        detail ? ` — ${detail}` : ""
      }`,
    );
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  await Deno.mkdir(dirnameOf(binPath), { recursive: true });

  // Write to a temp file and rename into place, so an interrupted download
  // never leaves a truncated binary at the live path. Rename is atomic on the
  // same filesystem.
  const tmpPath = `${binPath}.download-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmpPath, bytes, { mode: 0o755 });
    await Deno.rename(tmpPath, binPath);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    throw err;
  }
}

/** Verify the installed binary: `caddy version` and `caddy list-modules`. */
async function verifyCaddy(binPath: string): Promise<{
  version: string;
  modules: string;
}> {
  const version = await runCmd(binPath, ["version"]);
  if (version.code !== 0) {
    throw new Error(
      `caddy version failed (${version.code}): ${
        version.stderr || version.stdout
      }`,
    );
  }
  const modules = await runCmd(binPath, ["list-modules"]);
  if (modules.code !== 0) {
    throw new Error(
      `caddy list-modules failed (${modules.code}): ${
        modules.stderr || modules.stdout
      }`,
    );
  }
  return {
    version: parseCaddyVersion(version.stdout),
    modules: modules.stdout,
  };
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

/**
 * Which of the wanted plugin packages are NOT compiled into the binary.
 *
 * A wanted entry may be bare (`github.com/foo/bar`) or version-pinned
 * (`github.com/foo/bar@v1.2.3`); matching is on the bare path. Used both to
 * decide whether `installCaddy` must (re)build the binary and to report drift
 * in `audit`.
 */
export function missingPlugins(
  wanted: string[],
  compiled: string[],
): string[] {
  return wanted.filter((want) => {
    const bare = want.split("@")[0];
    return !compiled.some((c) => c === bare || c.startsWith(bare));
  });
}

/**
 * The third-party Go package paths compiled into a binary, from
 * `caddy list-modules --packages` (one `<module> <package>` per line). Standard
 * Caddy modules are excluded so the result can be compared with the requested
 * plugin list.
 */
async function compiledPluginPaths(binPath: string): Promise<string[]> {
  const lm = await runCmd(binPath, ["list-modules", "--packages"]);
  if (lm.code !== 0) return [];
  const out = new Set<string>();
  for (const line of lm.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const pkg = parts[1];
    if (
      pkg && pkg.startsWith("github.com") &&
      pkg !== "github.com/caddyserver/caddy/v2"
    ) {
      out.add(pkg);
    }
  }
  return [...out];
}

/** Whether a path exists as a regular file. */
async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

/** Read the current capabilities on a binary via `getcap` (empty if none). */
async function readCapabilities(binPath: string): Promise<string[]> {
  const result = await runCmd("getcap", [binPath]);
  if (result.code !== 0) return [];
  return parseGetcap(result.stdout);
}

/**
 * Try to grant capabilities with `sudo -n setcap` (non-interactive).
 *
 * Returns whether it was applied, whether it needed sudo, and the command the
 * operator can run by hand. Never throws: a missing/failed setcap is reported,
 * not fatal, so the install flow can still finish and print guidance.
 */
async function applyCapabilities(
  binPath: string,
  capabilities: string[],
): Promise<{ applied: boolean; requiresSudo: boolean; message: string }> {
  const command = renderSetcapCommand(binPath, capabilities);
  const direct = await runCmd("setcap", [capabilities.join(" "), binPath]);
  if (direct.code === 0) {
    return {
      applied: true,
      requiresSudo: false,
      message: `Applied via: ${command}`,
    };
  }
  // Try non-interactive sudo (works only if the user has passwordless sudo).
  const sudo = await runCmd("sudo", [
    "-n",
    "setcap",
    capabilities.join(" "),
    binPath,
  ]);
  if (sudo.code === 0) {
    return {
      applied: true,
      requiresSudo: true,
      message: `Applied via: ${command}`,
    };
  }
  return {
    applied: false,
    requiresSudo: true,
    message: renderPrivilegedPortGuidance(binPath, capabilities),
  };
}

// ---------------------------------------------------------------------------
// systemd + admin API helpers
// ---------------------------------------------------------------------------

async function systemctl(
  args: string[],
): Promise<CmdResult> {
  return await runCmd("systemctl", ["--user", ...args]);
}

/**
 * The `handler` names used by routes in a config (empty for non-map entries).
 */
function configHandlerNames(config: CaddyConfig): string[] {
  const names: string[] = [];
  for (const r of getRoutes(config)) {
    const handle = r.handle;
    if (!Array.isArray(handle)) continue;
    for (const h of handle) {
      if (
        h && typeof h === "object" &&
        typeof (h as { handler?: unknown }).handler === "string"
      ) {
        names.push((h as { handler: string }).handler);
      }
    }
  }
  return names;
}

/**
 * The Caddy modules a config actually uses, as `namespace.name` ids. Covers the
 * handler modules this extension emits (teapot, file_server, reverse_proxy,
 * static_response) and the apps it may write (dns_records). Standard Caddy
 * modules are always present; only the third-party ones (teapot, plus the
 * `dns_records` app) gate a rebuild.
 */
export function requiredCaddyModules(config: CaddyConfig): string[] {
  const mods = new Set<string>();
  for (const h of configHandlerNames(config)) mods.add(`http.handlers.${h}`);
  const apps = (config.apps ?? {}) as Record<string, unknown>;
  if (apps.dns_records) mods.add("dns_records");
  return [...mods].sort();
}

/**
 * Throw (before a config is applied) when it uses third-party modules the
 * binary cannot load, naming the fix. This turns Caddy's opaque
 * "unknown module: http.handlers.teapot" 500 into an actionable error.
 */
async function assertModulesCompiled(
  config: CaddyConfig,
  binPath: string,
  fixMethods: string[],
): Promise<void> {
  const required = requiredCaddyModules(config).filter((m) =>
    m === "http.handlers.teapot" || m === "dns_records"
  );
  if (required.length === 0) return;
  if (!(await fileExists(binPath))) return; // nothing to check against yet
  const lm = await runCmd(binPath, ["list-modules"]);
  if (lm.code !== 0) return;
  const present = new Set(
    lm.stdout.split("\n").map((l) => l.trim()).filter((l) =>
      l && !l.startsWith("#")
    ),
  );
  const missing = required.filter((m) => !present.has(m));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to apply the config: the Caddy binary at ${binPath} does not include ` +
        `${missing.join(", ")}. Rebuild it with one of: ` +
        fixMethods.map((m) => `\`swamp model method run <model> ${m}\``).join(
          " / ",
        ) +
        ` (built-in modules are added automatically).`,
    );
  }
}

/** Whether a systemd user service is currently active (best-effort). */
async function isServiceActive(serviceName: string): Promise<boolean> {
  try {
    const r = await systemctl(["is-active", serviceName]);
    return r.stdout.trim() === "active";
  } catch {
    return false;
  }
}

/** Poll until a systemd user service is active, or the timeout elapses. */
async function waitForService(
  serviceName: string,
  seconds: number,
): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await isServiceActive(serviceName)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return isServiceActive(serviceName);
}

/** List active systemd user service unit names. */
async function listSystemdUnits(): Promise<string[]> {
  const result = await systemctl([
    "list-units",
    "--type=service",
    "--no-legend",
    "--plain",
    "--no-pager",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `systemctl --user list-units failed (${result.code}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && name.length > 0);
}

async function writeUnitFile(
  unitPath: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(dirnameOf(unitPath), { recursive: true });
  await Deno.writeTextFile(unitPath, content);
}

async function checkAdminApi(adminApiAddr: string): Promise<boolean> {
  try {
    const resp = await adminApiRequest(adminApiAddr, "GET", "/config/");
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  }
}

/** A normalized admin API response (status + body text). */
type AdminResponse = { status: number; body: string };

/** Issue a request against the Caddy admin API (JSON), over HTTP or a Unix socket. */
async function adminApiRequest(
  adminApiAddr: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<AdminResponse> {
  const addr = parseAdminAddr(adminApiAddr);
  if (addr.kind === "unix") {
    return await adminApiRequestUnix(
      addr.socketPath ?? "",
      method,
      path,
      body,
      token,
    );
  }
  const url = `http://${adminApiAddr}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.text() };
}

/** Issue a request against the admin API over a Unix socket via curl. */
async function adminApiRequestUnix(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<AdminResponse> {
  const args = buildCurlArgs(socketPath, method, path, body, token);
  const result = await runCmd("curl", args);
  if (result.code !== 0) {
    throw new Error(
      `curl failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const lines = result.stdout.split("\n");
  const statusLine = lines[lines.length - 1].trim();
  const status = Number.parseInt(statusLine, 10);
  const bodyText = lines.slice(0, -1).join("\n");
  return { status: Number.isNaN(status) ? 200 : status, body: bodyText };
}

/** Read the current Caddy JSON config (base config when none is set). */
async function readConfig(
  adminApiAddr: string,
  token?: string,
  listenAddrs?: string[],
  autoHttps?: string,
): Promise<CaddyConfig> {
  const resp = await adminApiRequest(
    adminApiAddr,
    "GET",
    "/config/",
    undefined,
    token,
  );
  if (resp.status === 404) return baseConfig(listenAddrs, autoHttps);
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(
      `Failed to read Caddy config (${resp.status}): ${resp.body}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(resp.body);
  } catch (err) {
    // A non-empty but unparseable body means we cannot trust the running
    // config; falling back to a fresh base config would silently POST it back
    // and clobber the live config. Fail loudly instead.
    throw new Error(
      `Caddy admin API returned an unparseable config: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      `Caddy admin API returned an unexpected config shape (expected a JSON object)`,
    );
  }
  return ensureServerDefaults(body as CaddyConfig, listenAddrs, autoHttps);
}

/** Replace the Caddy JSON config via the admin API. */
async function writeConfig(
  adminApiAddr: string,
  config: CaddyConfig,
  token?: string,
): Promise<void> {
  const resp = await adminApiRequest(
    adminApiAddr,
    "POST",
    "/config/",
    config,
    token,
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(
      `Failed to apply Caddy config (${resp.status}): ${resp.body}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Desired-state reconciliation (multi-model → one Caddy)
// ---------------------------------------------------------------------------

/** The host a model's Caddy lives on: explicit `target`, or this hostname. */
function resolveTarget(target: string): string {
  if (target) return target;
  try {
    return Deno.hostname();
  } catch {
    return "local";
  }
}

/** Build a fresh desired-state object from global args + this model's name. */
function emptyDesired(
  modelName: string,
  g: GlobalArgs,
): DesiredState {
  return {
    modelName,
    target: resolveTarget(g.target),
    serviceName: g.serviceName,
    adminApiAddr: g.adminApiAddr,
    baseDomain: g.baseDomain ?? "",
    autoHttps: g.autoHttps,
    listenAddrs: g.listenAddrs,
    plugins: g.plugins,
    environmentFile: g.environmentFile ?? "",
    caddyBinPath: g.caddyBinPath,
    routes: [],
    tls: null,
    statusPage: null,
    dnsRecords: g.dnsRecords,
    dnsRemovals: g.dnsRemovals,
    dnsTtl: g.dnsTtl,
    healthRoutes: g.healthRoutes,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Read this model's previously stored desired state and refresh the
 * model-level fields (target/serviceName/listenAddrs/autoHttps) from the
 * current global args, keeping the accumulated routes/tls/statusPage.
 */
async function loadOwnDesired(
  context: MethodContext,
  g: GlobalArgs,
): Promise<DesiredState> {
  const modelName = context.definition?.name ?? "";
  const base = emptyDesired(modelName, g);
  let stored: Partial<DesiredState> | null = null;
  try {
    stored = await context.readResource("desired") as
      | Partial<DesiredState>
      | null;
  } catch {
    stored = null;
  }
  if (!stored) return base;
  return {
    ...base,
    routes: Array.isArray(stored.routes) ? stored.routes : [],
    tls: stored.tls ?? null,
    statusPage: stored.statusPage ?? null,
    // dnsRecords/dnsRemovals follow the global args (like listenAddrs), NOT the
    // stored copy: the stored value is only ever written from the globals, so
    // preferring it would make a later `swamp model edit` of the global a no-op.
    dnsRecords: base.dnsRecords,
    dnsRemovals: base.dnsRemovals,
  };
}

/** Extract a desired state from a cross-model data record (shape-tolerant). */
function desiredFromRecord(rec: Record<string, unknown>): DesiredState | null {
  let obj: unknown = rec.attributes;
  if (!obj && typeof rec.content === "string") {
    try {
      obj = JSON.parse(rec.content);
    } catch {
      return null;
    }
  }
  if (!obj) obj = rec.content;
  if (!obj || typeof obj !== "object") return null;
  const d = obj as Record<string, unknown>;
  if (typeof d.target !== "string" || typeof d.serviceName !== "string") {
    return null;
  }
  return d as unknown as DesiredState;
}

/** Collect this model's + every peer's desired state for the same target. */
async function gatherDesiredForTarget(
  context: MethodContext,
  own: DesiredState,
  includePeers = true,
): Promise<DesiredState[]> {
  const key = caddyTargetKey(own.target, own.serviceName);
  const states: DesiredState[] = [own];
  if (!includePeers || !context.queryData) return states;
  let records: unknown[] = [];
  try {
    records = await context.queryData(
      'modelType == "@svendowideit/caddy" && specName == "desired"',
    );
  } catch {
    return states;
  }
  for (const r of records) {
    const rec = r as Record<string, unknown>;
    const name = typeof rec.modelName === "string"
      ? rec.modelName
      : (rec.tags as Record<string, string> | undefined)?.modelName;
    if (!name || name === own.modelName) continue;
    const d = desiredFromRecord(rec);
    if (d && caddyTargetKey(d.target, d.serviceName) === key) states.push(d);
  }
  return states;
}

/** Every caddy model's desired state, across all targets (for `audit`). */
async function gatherAllDesired(
  context: MethodContext,
): Promise<DesiredState[]> {
  if (!context.queryData) return [];
  let records: unknown[] = [];
  try {
    records = await context.queryData(
      'modelType == "@svendowideit/caddy" && specName == "desired"',
    );
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: DesiredState[] = [];
  for (const r of records) {
    const d = desiredFromRecord(r as Record<string, unknown>);
    if (!d) continue;
    const key = `${d.modelName}\u0000${d.target}\u0000${d.serviceName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * The commands a user should run next to inspect each layer: the unmerged
 * per-model desired state, the merged result, and the desired-vs-actual diff.
 * Rendered into the plan/audit output so the user is never left to guess.
 */
export function renderNextCommands(opts: {
  runModel: string;
  models: string[];
  adminApiAddr: string;
  listenAddrs: string[];
}): string {
  const admin = opts.adminApiAddr || "localhost:2019";
  const lines: string[] = [];
  lines.push("# 1. What EACH swamp model wants (unmerged):");
  for (const m of opts.models) {
    lines.push(
      `swamp data get ${m} desired --json | jq '.content | {routes, tls, statusPage}'`,
    );
  }
  lines.push("");
  lines.push("# 2. What they look like MERGED (this plan's desiredConfig):");
  lines.push(
    `swamp data get ${opts.runModel} plan --json | jq '.content.desiredConfig'`,
  );
  lines.push("");
  lines.push("# 3. Compare desired (merged) vs ACTUAL Caddy config:");
  lines.push(
    `swamp data get ${opts.runModel} plan --json | jq '.content.desiredConfig' > /tmp/desired.json`,
  );
  lines.push(`curl -s ${admin}/config/ > /tmp/actual.json`);
  lines.push("diff -u /tmp/desired.json /tmp/actual.json");
  return lines.join("\n");
}

/** Caddy's data directory (where certificates are stored). */
export function caddyDataDir(home?: string): string {
  const xdg = Deno.env.get("XDG_DATA_HOME");
  const h = home ?? Deno.env.get("HOME") ?? "";
  return xdg ? `${xdg}/caddy` : `${h}/.local/share/caddy`;
}

/** List the domains that have a certificate on disk (issuer dirs skipped). */
export function listIssuedDomains(dataDir: string): string[] {
  const out = new Set<string>();
  const certRoot = `${dataDir}/certificates`;
  let issuers: Deno.DirEntry[];
  try {
    issuers = [...Deno.readDirSync(certRoot)];
  } catch {
    return [];
  }
  for (const issuer of issuers) {
    if (!issuer.isDirectory) continue;
    // The `local` issuer holds Caddy's internal/self-signed certs (localhost,
    // 127.0.0.1); real ACME issuers are like `acme-v02.api.letsencrypt.org-
    // directory`. We report all, but the caller can tell them apart.
    try {
      for (const dom of Deno.readDirSync(`${certRoot}/${issuer.name}`)) {
        if (dom.isDirectory) out.add(dom.name);
      }
    } catch {
      // ignore unreadable issuer dirs
    }
  }
  return [...out].sort();
}

/** The `tls` block of a live Caddy config (empty object when absent). */
export function liveTlsInfo(config: CaddyConfig): {
  subjects: string[];
  hasDnsChallenge: boolean;
  dnsProvider: string;
} {
  const apps = config.apps as Record<string, unknown> | undefined;
  const tls = apps?.tls as Record<string, unknown> | undefined;
  const automation = tls?.automation as Record<string, unknown> | undefined;
  const policies = automation?.policies;
  const subjects: string[] = [];
  let hasDnsChallenge = false;
  let dnsProvider = "";
  if (Array.isArray(policies)) {
    for (const p of policies) {
      const pol = p as Record<string, unknown>;
      if (Array.isArray(pol.subjects)) {
        for (const s of pol.subjects) {
          if (typeof s === "string") subjects.push(s);
        }
      }
      const issuers = pol.issuers;
      if (Array.isArray(issuers)) {
        for (const iss of issuers) {
          const ch = (iss as Record<string, unknown>).challenges as
            | Record<string, unknown>
            | undefined;
          const dns = ch?.dns as Record<string, unknown> | undefined;
          const provider = dns?.provider as Record<string, unknown> | undefined;
          if (provider) {
            hasDnsChallenge = true;
            if (typeof provider.name === "string") dnsProvider = provider.name;
          }
        }
      }
    }
  }
  return { subjects, hasDnsChallenge, dnsProvider };
}

/**
 * Compute the desired-vs-actual picture for one Caddy, merging `states` (or
 * gathering peers of `own` when not supplied). Read-only: does not change
 * anything, only reads the live config for comparison.
 */
async function computeCaddyPlan(
  context: MethodContext,
  own: DesiredState,
  adminToken: string | undefined,
  states?: DesiredState[],
): Promise<{
  target: string;
  adminApiAddr: string;
  serviceName: string;
  models: string[];
  conflicts: string[];
  desiredRoutes: Array<{
    hostname: string;
    kind: string;
    upstream: string;
    root: string;
    model: string;
  }>;
  unmerged: Array<{
    model: string;
    routes: Array<{
      hostname: string;
      kind: string;
      upstream: string;
      root: string;
    }>;
    tlsSubjects: string[];
    statusPage: boolean;
  }>;
  runModel: string;
  nextCommands: string;
  tls: {
    desired: Array<{
      model: string;
      email: string;
      dnsProvider: string;
      subjects: string[];
      providerConfigFields: string[];
    }>;
    desiredSubjects: string[];
    liveSubjects: string[];
    liveHasDnsChallenge: boolean;
    liveDnsProvider: string;
    issuedDomains: string[];
    subjectsWithoutCert: string[];
    statusPageHostnames: string[];
    pluginsWanted: string[];
    pluginsCompiled: string[];
    pluginsMissing: string[];
    environmentFile: string;
    environmentFileExists: boolean;
    environmentFileKeys: string[];
    inSync: boolean;
  };
  dns: {
    enabled: boolean;
    desired: Array<{
      model: string;
      name: string;
      type: string;
      value: string[];
      zone: string;
      ttl: string;
    }>;
    removals: Array<{
      model: string;
      name: string;
      type: string;
      value: string[];
      zone: string;
    }>;
    mergedRecords: DnsRecord[];
    mergedRemovals: DnsRemoval[];
    provider: string;
    moduleCompiled: boolean;
  };
  actualSwampRoutes: Array<{ id: string; hostnames: string[] }>;
  foreignRoutes: string[];
  onlyDesired: string[];
  onlyActual: string[];
  inSync: boolean;
  reachable: boolean;
  error: string;
  desiredConfig: CaddyConfig;
  actualConfig: CaddyConfig;
}> {
  const group = states ?? await gatherDesiredForTarget(context, own, true);
  const { merged, errors } = mergeDesired(group);
  const desiredRoutes = merged.routes.map((r) => ({
    hostname: r.hostname,
    kind: r.kind,
    upstream: r.upstream,
    root: r.root,
    model: (r as { model?: string }).model ?? "",
  }));

  let actual: CaddyConfig = {};
  let reachable = true;
  let error = "";
  try {
    actual = await readConfig(
      own.adminApiAddr || "localhost:2019",
      adminToken,
      own.listenAddrs,
      own.autoHttps,
    );
  } catch (err) {
    reachable = false;
    error = err instanceof Error ? err.message : String(err);
    actual = {};
  }

  const desiredConfig = buildReconciledConfig(actual, merged);
  const diff = reachable ? diffRoutes(desiredRoutes, actual) : {
    actualSwampRoutes: [],
    foreignRoutes: [],
    onlyDesired: desiredRoutes.map((r) => r.hostname),
    onlyActual: [],
    inSync: false,
  };

  // Each model's own desired state, before merging (ordered, deduped by name).
  // A model that wants nothing (e.g. a scratch instance an audit ran on) is
  // omitted so it does not read as an empty participant.
  const seenModels = new Set<string>();
  const unmerged = [];
  for (const s of group) {
    if (seenModels.has(s.modelName)) continue;
    seenModels.add(s.modelName);
    const wantsSomething = s.routes.length > 0 ||
      (s.tls?.subjects.length ?? 0) > 0 ||
      (s.statusPage?.enabled ?? false) ||
      (s.dnsRecords?.length ?? 0) > 0 || (s.dnsRemovals?.length ?? 0) > 0;
    if (!wantsSomething) continue;
    unmerged.push({
      model: s.modelName,
      routes: s.routes.map((r) => ({
        hostname: r.hostname,
        kind: r.kind,
        upstream: r.upstream,
        root: r.root,
      })),
      tlsSubjects: s.tls?.subjects ?? [],
      statusPage: s.statusPage?.enabled ?? false,
    });
  }

  const runModel = context.definition?.name ?? own.modelName;
  // Only models that actually contribute appear in the models list / commands.
  const contributingModels = unmerged.map((u) => u.model);
  const models = contributingModels.length > 0
    ? contributingModels
    : merged.models;
  const nextCommands = renderNextCommands({
    runModel,
    models,
    adminApiAddr: own.adminApiAddr || "localhost:2019",
    listenAddrs: merged.listenAddrs,
  });

  // --- TLS / DNS / plugin layer: what models want vs what is actually there. ---
  const tlsDesired = group
    .filter((s) => s.tls)
    .map((s) => ({
      model: s.modelName,
      email: s.tls!.email,
      dnsProvider: s.tls!.dnsProvider,
      subjects: s.tls!.subjects,
      providerConfigFields: Object.keys(s.tls!.providerConfig),
    }));
  const live = liveTlsInfo(actual);
  // Which of the wanted plugins are compiled into the binary. The built-in
  // modules are always wanted (installCaddy/upgradeCaddy add them), so include
  // them here too — otherwise audit cannot report a binary that predates them.
  const binPath = expandHome(own.caddyBinPath || "~/.local/bin/caddy");
  const pluginsWanted: string[] = [];
  for (const s of group) for (const p of s.plugins ?? []) pluginsWanted.push(p);
  for (const p of DEFAULT_CADDY_PLUGINS) pluginsWanted.push(p);
  const pluginsCompiled: string[] = [];
  if (await fileExists(binPath)) {
    const lm = await runCmd(binPath, ["list-modules", "--packages"]);
    if (lm.code === 0) {
      for (const line of lm.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1].startsWith("github.com")) {
          pluginsCompiled.push(parts[1]);
        }
      }
    }
  }
  // A wanted plugin is present if any compiled module's package matches it
  // (allow a bare prefix, e.g. github.com/caddy-dns/gandi).
  const pluginsMissing = missingPlugins(pluginsWanted, pluginsCompiled);
  // Environment file may be set on any model in the group; take the first
  // non-empty (and note conflicts implicitly via the env keys shown).
  const environmentFile = own.environmentFile ||
    group.map((s) => s.environmentFile).find((f) => f) || "";
  const envPath = environmentFile ? expandHome(environmentFile) : "";
  const environmentFileExists = envPath ? await fileExists(envPath) : false;
  const environmentFileKeys: string[] = [];
  if (environmentFileExists) {
    try {
      const body = await Deno.readTextFile(envPath);
      for (const line of body.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0 && !line.trimStart().startsWith("#")) {
          environmentFileKeys.push(line.slice(0, eq).trim());
        }
      }
    } catch {
      // unreadable env file: leave keys empty
    }
  }
  const desiredSubjects = merged.tls?.subjects ?? [];
  // Issued certificates prove the DNS-01 challenge actually worked; config
  // alone does not. Read from Caddy's data dir; a wildcard subject is stored
  // under its literal form (e.g. `*.example.com`), so compare literally.
  const issuedDomains = listIssuedDomains(caddyDataDir());
  const hasCertFor = (subject: string): boolean =>
    issuedDomains.includes(subject);
  const subjectsWithoutCert = desiredSubjects.filter((s) => !hasCertFor(s));
  // The hostnames the status page answers on for this Caddy (defaults).
  const statusPageHostnamesForCaddy = merged.statusPage?.enabled
    ? defaultStatusHostnames({
      tlsSubjects: desiredSubjects,
      explicit: merged.statusPage.hostnames,
      routedHostnames: merged.routes.map((r) => r.hostname),
    })
    : [];
  const tlsInSync = desiredSubjects.length > 0
    ? desiredSubjects.every((s) => live.subjects.includes(s)) &&
      (!merged.tls?.dnsProvider || live.hasDnsChallenge) &&
      pluginsMissing.length === 0 &&
      subjectsWithoutCert.length === 0
    : live.subjects.length === 0 && live.hasDnsChallenge === false;

  // --- Static DNS records (caddy-host-dns): desired only, no live diff. ---
  const dnsDesired: Array<{
    model: string;
    name: string;
    type: string;
    value: string[];
    zone: string;
    ttl: string;
  }> = [];
  const dnsRemovalsDesired: Array<{
    model: string;
    name: string;
    type: string;
    value: string[];
    zone: string;
  }> = [];
  for (const s of group) {
    for (const r of s.dnsRecords ?? []) {
      dnsDesired.push({ model: s.modelName, ...r });
    }
    for (const r of s.dnsRemovals ?? []) {
      dnsRemovalsDesired.push({ model: s.modelName, ...r });
    }
  }
  const dnsEnabled = dnsDesired.length > 0 || dnsRemovalsDesired.length > 0;
  const dnsModuleCompiled = pluginsCompiled.some((c) =>
    c === CADDY_HOST_DNS_PLUGIN || c.startsWith(CADDY_HOST_DNS_PLUGIN)
  );

  return {
    target: caddyTargetKey(own.target, own.serviceName),
    adminApiAddr: own.adminApiAddr || "localhost:2019",
    serviceName: own.serviceName,
    models,
    unmerged,
    runModel,
    nextCommands,
    tls: {
      desired: tlsDesired,
      desiredSubjects,
      liveSubjects: live.subjects,
      liveHasDnsChallenge: live.hasDnsChallenge,
      liveDnsProvider: live.dnsProvider,
      issuedDomains,
      subjectsWithoutCert,
      statusPageHostnames: statusPageHostnamesForCaddy,
      pluginsWanted: [...new Set(pluginsWanted)],
      pluginsCompiled: [...new Set(pluginsCompiled)],
      pluginsMissing,
      environmentFile,
      environmentFileExists,
      environmentFileKeys,
      inSync: tlsInSync,
    },
    conflicts: errors,
    dns: {
      enabled: dnsEnabled,
      desired: dnsDesired,
      removals: dnsRemovalsDesired,
      mergedRecords: merged.dnsRecords,
      mergedRemovals: merged.dnsRemovals,
      provider: merged.tls?.dnsProvider ?? "",
      moduleCompiled: dnsModuleCompiled,
    },
    desiredRoutes,
    actualSwampRoutes: diff.actualSwampRoutes,
    foreignRoutes: diff.foreignRoutes,
    onlyDesired: diff.onlyDesired,
    onlyActual: diff.onlyActual,
    inSync: reachable && diff.inSync && errors.length === 0 &&
      pluginsMissing.length === 0,
    reachable,
    error,
    desiredConfig,
    actualConfig: actual,
  };
}

/**
 * Merge every model's desired state for this target and apply the result to the
 * running Caddy. Throws on a real conflict (so it is surfaced, not silently
 * resolved) and returns the merged summary.
 */
async function applyReconcile(
  context: MethodContext,
  g: GlobalArgs,
  own: DesiredState,
): Promise<{
  models: string[];
  routeCount: number;
  fileServerCount: number;
  statusPageModel: string;
  tlsModels: string[];
  changed: boolean;
  desiredHandle: { name: string };
}> {
  const states = await gatherDesiredForTarget(context, own, g.reconcile);
  const { merged, errors } = mergeDesired(states);
  if (errors.length > 0) {
    throw new Error(
      `Caddy reconcile conflict for target '${own.target}:${own.serviceName}': ${
        errors.join("; ")
      }`,
    );
  }
  // Persist this model's desired state only after the merge validated, so a
  // conflicting edit is rejected before it can be committed and read back by
  // peers.
  const desiredHandle = await context.writeResource(
    "desired",
    "desired",
    own as unknown as Record<string, unknown>,
  );
  const current = await readConfig(
    g.adminApiAddr,
    g.adminApiToken,
    g.listenAddrs,
    g.autoHttps,
  );
  const next = buildReconciledConfig(current, merged);
  // A config that uses a module the binary lacks fails to load with a cryptic
  // Caddy 500 ("unknown module"). Catch it first and say how to fix it.
  await assertModulesCompiled(next, expandHome(g.caddyBinPath), [
    "installCaddy",
    "upgradeCaddy",
  ]);
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (changed) {
    await writeConfig(g.adminApiAddr, next, g.adminApiToken);
  }
  return {
    models: merged.models,
    routeCount: merged.routes.filter((r) => r.kind === "proxy").length,
    fileServerCount: merged.routes.filter((r) => r.kind === "file_server")
      .length,
    statusPageModel: merged.statusPageModel,
    tlsModels: merged.tlsModels,
    changed,
    desiredHandle,
  };
}

/**
 * Persist this model's desired state and apply the config for its target
 * (merging peers when `reconcile` is on). Returns the desired handle and the
 * reconcile summary.
 */
async function saveAndReconcile(
  context: MethodContext,
  g: GlobalArgs,
  own: DesiredState,
): Promise<{
  dataHandles: [{ name: string }];
  summary: Awaited<ReturnType<typeof applyReconcile>>;
}> {
  own.updatedAt = new Date().toISOString();
  // applyReconcile validates the merge first, then persists desired state only
  // if it is accepted, so a conflict cannot be half-committed.
  const summary = await applyReconcile(context, g, own);
  const desiredHandle = summary.desiredHandle;
  const reconcileHandle = await context.writeResource(
    "reconcile",
    "reconcile",
    {
      target: caddyTargetKey(own.target, own.serviceName),
      models: summary.models,
      routeCount: summary.routeCount,
      fileServerCount: summary.fileServerCount,
      statusPageModel: summary.statusPageModel,
      tlsModels: summary.tlsModels,
      changed: summary.changed,
      reconciledAt: new Date().toISOString(),
    },
  );
  void reconcileHandle;
  return { dataHandles: [desiredHandle], summary };
}

/** Upsert a route in a desired-state list, keyed by hostname. */
function upsertRoute(state: DesiredState, route: DesiredRoute): void {
  state.routes = [
    ...state.routes.filter((r) => r.hostname !== route.hostname),
    route,
  ];
}

/** Remove a route from a desired-state list by hostname. */
function dropRoute(state: DesiredState, hostname: string): void {
  state.routes = state.routes.filter((r) => r.hostname !== hostname);
}

/** Write a secret to the swamp Vault via `swamp vault put` (value on stdin). */
async function vaultPut(
  vaultName: string,
  key: string,
  value: string,
): Promise<void> {
  const proc = new Deno.Command("swamp", {
    args: ["vault", "put", vaultName, key, "--json"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = proc.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(value));
  await writer.close();
  const out = await child.output();
  if (out.code !== 0) {
    throw new Error(
      `swamp vault put ${vaultName} ${key} failed (${out.code}): ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
}

/** Run a start/stop/restart action on a backend systemd user service. */
async function backendServiceAction(
  action: "start" | "stop" | "restart",
  serviceName: string,
): Promise<void> {
  const result = await systemctl([action, serviceName]);
  if (result.code !== 0) {
    throw new Error(
      `systemctl --user ${action} ${serviceName} failed (${result.code}): ${
        result.stderr || result.stdout
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
    warning?: (msg: string, props?: Record<string, unknown>) => void;
    error?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<Array<Record<string, unknown> | unknown>>;
};

/** Context available to pre-flight checks (no data writers). */
type CheckContext = {
  globalArgs: GlobalArgs;
  methodName: string;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/** Model definition for the Caddy reverse-proxy and service manager. */
export const model = {
  type: "@svendowideit/caddy",
  version: "2026.10.05.2",
  reports: ["@svendowideit/caddy-status"],
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-config": {
      description:
        "Validate base domain, ACME email, and listen addresses before mutating Caddy",
      labels: ["policy"],
      appliesTo: [
        "installCaddy",
        "setCapabilities",
        "configureStatusPage",
        "createService",
        "startService",
        "stopService",
        "restartService",
        "checkHealth",
        "storeConfig",
        "configureTls",
        "addProxyService",
        "removeProxyService",
        "ensureDnsProxy",
        "autoProxySwampServe",
        "serveSettings",
        "upgradeCaddy",
      ],
      execute: (
        context: CheckContext,
      ): { pass: boolean; errors?: string[] } => {
        const g = context.globalArgs;
        const errors: string[] = [];
        if (g.baseDomain) {
          try {
            validateBaseDomain(g.baseDomain);
          } catch (err) {
            errors.push((err as Error).message);
          }
        }
        if (g.letsEncryptEmail) {
          try {
            validateEmail(g.letsEncryptEmail);
          } catch (err) {
            errors.push((err as Error).message);
          }
        }
        if (!g.listenAddrs || g.listenAddrs.length === 0) {
          errors.push("listenAddrs must not be empty");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
    "platform-supported": {
      description:
        "Ensure the host is Linux with systemd available (skip with --skip-check-label live)",
      labels: ["live"],
      appliesTo: [
        "installCaddy",
        "createService",
        "startService",
        "upgradeCaddy",
      ],
      execute: async (
        _context: CheckContext,
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const errors: string[] = [];
        if (Deno.build.os !== "linux") {
          errors.push(
            `This extension manages a systemd user service and only supports Linux (host is ${Deno.build.os})`,
          );
        } else {
          const result = await runCmd("systemctl", [
            "--user",
            "is-system-running",
          ]);
          // `systemctl --user` exits non-zero for degraded/running states too;
          // treat a command-not-found (127) as the only hard failure.
          if (result.code === 127) {
            errors.push(
              "systemctl --user is not available on this host (systemd user services required)",
            );
          }
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.09.20.1",
      description:
        "installCaddy/upgradeCaddy now download the current release from the caddyserver.com API with optional module packages (plugins); the caddyVersion global arg was removed. Adds autoHttps and listenAddrs globals. Drops the obsolete caddyVersion field (GlobalArgsSchema is strict).",
      upgradeAttributes: (old: Record<string, unknown>) => {
        const { caddyVersion: _removed, ...rest } = old;
        return rest;
      },
    },
    {
      toVersion: "2026.09.20.2",
      description:
        "createService now runs Caddy with --resume (and no ExecReload), so admin-API routes survive a service restart. Global args unchanged; re-run createService to regenerate the unit.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.20.3",
      description:
        "Documentation only: expanded README and manifest description, with examples for the caddy-teapot-module and multi-package plugin config. Schema unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.21.1",
      description:
        "Robustness: downloads write to a temp file and rename atomically (no truncated binary on failure); removeProxyService is now idempotent (removing an absent route is a no-op). Adds valid-config and platform-supported pre-flight checks. Schema unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.1",
      description:
        "Adds gandi and dreamhost to the DNS-provider map; configureTls accepts a providerConfig map (credential field -> env var) for multi-field providers (Gandi bearer_token, Namecheap api_key+user, DreamHost api_key) while keeping the single api_token default; adds a serveSettings method that serves a static settings directory over HTTP(S) via Caddy file_server. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.2",
      description:
        "Adds a setCapabilities method and grants CAP_NET_BIND_SERVICE during installCaddy (setCapabilities arg, default true), so the unprivileged systemd user service can bind ports 80/443. When sudo is unavailable it records the exact `sudo setcap` command; upgradeCaddy now reapplies the capability since replacing the binary drops it. install/upgrade resources gain capabilities fields. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.3",
      description:
        "Fix the generated systemd user unit so Caddy can actually bind 80/443: drop LimitNPROC (per-UID for a user service, so a low value made Go fail to create a thread with EAGAIN and exit status=2) and drop ProtectSystem/PrivateTmp (they force a child user namespace, in which CAP_NET_BIND_SERVICE cannot bind host privileged ports). Re-run createService to regenerate the unit. Schema unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.4",
      description:
        "Adds a configureStatusPage method and installs a default status page (installCaddy arg configureStatusPage, default true; also ensured by startService once the admin API is up). The page answers on http://localhost and https://localhost, summarises the install (version, base domain, ACME email, privileged-port capability) and links to the admin API and configured routes. Adds the statusPage resource. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.5",
      description:
        "The status page now lists the third-party plugins compiled into the binary (parsed from `caddy list-modules --json`), grouped by Go package with version and module names, or states that the binary is stock. Adds a `plugins` field to the statusPage resource. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.6",
      description:
        "Status page regains a 'Listening on' section showing the configured server listen addresses (e.g. :443, :80) alongside routes and plugins; the statusPage resource gains a `listens` field. Adds an `environmentFile` global arg so createService renders EnvironmentFile=-<path>: DNS-provider tokens (e.g. GANDI_BEARER_TOKEN) then reach Caddy without hand-editing the unit, which the next createService would discard. Re-run createService to apply. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.7",
      description:
        "The status page now names the swamp model that manages the service (from context.definition.name), and the statusPage resource gains a `modelName` field, so a host with several Caddy models is unambiguous. Documentation only otherwise: the manifest and README explain how to find the model(s), modify an existing model with `swamp model edit` (create fails on an existing name by design), and how multiple models are handled. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.8",
      description:
        "Multi-model reconciliation: models that manage the same Caddy (same host + serviceName) no longer overwrite each other. Each mutating method records what the model wants in a `desired` resource, then reconcile merges every peer model's desired state for the target into one valid config and applies it. Routes are tagged with a Caddy @id (swamp:<model>:<host>) so only swamp-managed routes are replaced and hand-added routes survive; listenAddrs/TLS subjects union, and a real conflict (two different upstreams for one host, differing TLS email/provider) is reported naming the models instead of silently resolving. Adds `target` (defaults to the local hostname) and `reconcile` (default true) global args, plus `desired` and `reconcile` resources. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.9",
      description:
        "Adds a `plan` method and `plan` resource: it merges the desired state, computes the config that WOULD be applied, reads the LIVE Caddy config, and reports desired/actual routes, only-desired vs only-actual drift, foreign (hand-added) routes, and stores both configs so they can be diffed. Also fixes the status page to re-render against the merged routes on every reconcile (it was a stale snapshot) and to stop listing its own localhost hostnames as services. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.10",
      description:
        "Adds an `audit` method and `audit` resource: one command finds every caddy model across the repo (no names needed — `swamp model method run @svendowideit/caddy audit <anyname>` auto-creates a scratch instance), groups them by the Caddy each manages, and reports per Caddy the merged desired routes (with the owning model), desired-vs-actual drift, and reachability. Adds a @svendowideit/caddy-status method report that prints the result as a table. The status page again always shows a 'Routes & services' section listing the URLs the Caddy serves (with guidance when empty), which an earlier version dropped. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.11",
      description:
        "plan/audit now include an `unmerged` view (each model's own desired state before merging) and a `nextCommands` field: the exact commands to inspect the unmerged per-model state, the merged desiredConfig, and the desired-vs-actual diff. The caddy-status report prints both the Unmerged table and a 'Next commands' section, so a user never has to look elsewhere. Models that want nothing (e.g. the scratch instance an audit runs on) are filtered from the models/unmerged lists. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.12",
      description:
        "plan/audit now report the TLS/DNS layer, so a libdns DNS-01 setup (e.g. the Gandi driver + bearer token) is visible instead of hidden: per-model desired provider/email/subjects and credential fields, the live TLS subjects and whether a DNS challenge is configured, which wanted plugins are compiled into the binary (and which are missing), and whether the environmentFile exists with which keys. desired state stores plugins/environmentFile/caddyBinPath so this is available. The caddy-status report prints a 'TLS / DNS' section and says to run configureTls when the driver/env are set up but no TLS is desired yet. Schema is additive — existing models upgrade with no changes; re-run any method on an older model to refresh its stored desired state.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.13",
      description:
        "The default status page is now the fallback for EVERY hostname the models name (TLS subjects + explicit status hostnames), not just localhost — minus any hostname that has its own route. It is pushed last so explicit routes win. This also makes Caddy request a certificate for those hostnames (Caddy only issues for names in a route match), fixing 'configured hostname gets no cert / is a blank 404'. audit/plan TLS section now reports certificates actually ISSUED (read from Caddy's data dir) and the subjects still without a cert, so config-presence is no longer mistaken for a working DNS-01 challenge, and lists the status page's extra hostnames. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.1",
      description:
        "Two always-on Caddy modules are now compiled into every binary: github.com/SvenDowideit/caddy-host-dns (static, provider-agnostic A/AAAA/CNAME records via any dns.providers.* module) and github.com/hairyhenderson/caddy-teapot-module. Adds a default health contract on the status/default hostnames — '/' -> 200 (status page, now path-constrained to '/'), '/teapot' -> 418, any other path -> 404 (Caddy otherwise answers 200 for unrouted paths) — tunable with the healthRoutes global arg. Adds dnsRecords/dnsRemovals globals that write the dns_records app, reusing the TLS provider credential so DNS-01 and record-writing share one env file; audit/plan report a desired DNS section. Re-run installCaddy/upgradeCaddy once so the binary includes the new modules. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.2",
      description:
        "installCaddy now detects a STALE binary: it reads the modules compiled into the existing binary and rebuilds when any wanted (or built-in) module is missing, instead of treating any existing file as up to date. This fixes the case where a new extension version adds built-in plugins (caddy-host-dns, caddy-teapot-module) but the old binary still lacks them, so the config that needs them failed to load with 'unknown module: http.handlers.teapot'. It also restarts a running service after a rebuild (a replaced binary under a running process keeps the old modules), and the install resource gains rebuilt / missingPluginsBeforeBuild / restarted fields. Reconcile now fails with an actionable message (naming installCaddy/upgradeCaddy) when a config needs a third-party module the binary lacks, instead of surfacing Caddy's opaque 500. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.3",
      description:
        "Fixes two restart-ordering bugs in the new stale-binary handling. installCaddy now applies CAP_NET_BIND_SERVICE BEFORE restarting: replacing the binary drops the capability, so restarting first left the restarted process unable to bind 80/443. It also waits for the service after a rebuild and fails with a journalctl hint if it did not come back (Caddy runs --resume, so a stale autosave.json can crash-loop it), instead of reporting success while the service is down; upgradeCaddy gets the same post-restart check. audit now counts the always-wanted built-in modules, so a binary missing (or predating) them reports inSync=false and lists them in pluginsMissing. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.4",
      description:
        "Fixes two bugs that stopped dnsRecords from ever being applied. (1) buildReconciledConfig dropped the TLS app: mergeTlsConfig returns a clone and its result was discarded, so apps.tls (DNS provider + subjects) was never written. (2) loadOwnDesired preferred the STORED dnsRecords over the global args, so editing the global on an existing model was a silent no-op; like listenAddrs, dnsRecords/dnsRemovals now come from the globals. Adds an applyDnsRecords method (and dnsConfig resource): the one command to reconcile desired static DNS records into Caddy, with clear errors when no records or no dnsProvider are set. README/manifest document that zone is required for providers without libdns.ZoneLister (Gandi). Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.5",
      description:
        "Static DNS records now default to a 5-minute TTL (new dnsTtl global; a record's own ttl overrides it), so a new or changed record propagates to public resolvers within minutes instead of the zone default. README adds a 'Diagnosing a record (propagation vs. serving)' section: query the zone's own nameservers for ground truth, public resolvers for propagation, and curl --resolve to talk straight to the host while DNS is still propagating. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.6",
      description:
        "Ships a black-box acceptance test (`test-factory.yaml` + `test/bind/`) that runs @svendowideit/test-factory's new container test system: an authoritative BIND container accepting RFC2136 dynamic updates over TSIG, the swamp container on two networks, and tests that install/run Caddy as a systemd user service, prove `dig` resolves the A records Caddy wrote, and prove `curl` answers 200/418/404 from the right endpoints. No model schema or argument changes — the test assets are additive `additionalFiles`.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.05.1",
      description:
        "ensureDnsProxy gains a `rootPath` argument (and DesiredRoute a matching optional field) so a hostname root can serve an app that lives under a sub-path: a subroute rewrites only the exact path '/' to rootPath (e.g. '/dashboard') while every other path — the app's absolute asset and API paths — passes through unchanged. `buildRoute`/new `buildProxyHandle` take rootPath; schema is additive, existing models and routes are unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.05.2",
      description:
        "configureTls accepts `issuer=internal` to use Caddy's local CA (self-signed TLS) instead of ACME, for non-public names such as *.example.com or test hostnames where Let's Encrypt cannot issue. `renderTlsAutomation` takes an `issuer` field; DesiredTls carries it so it merges across models. With the internal issuer an ACME email is not required and any provider/challenge fields are ignored. Schema is additive — existing models upgrade with no changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    install: {
      description: "Caddy binary install status",
      schema: InstallOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    dnsConfig: {
      description: "Applied static DNS records (dns_records) for this model",
      schema: DnsConfigOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    service: {
      description: "Caddy systemd user service status",
      schema: ServiceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    guidance: {
      description: "Minimal Let's Encrypt settings guidance",
      schema: GuidanceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    proxyServices: {
      description: "Current reverse-proxy services managed by Caddy",
      schema: ProxyServicesOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    config: {
      description: "Effective Caddy configuration snapshot",
      schema: ConfigOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    tlsConfig: {
      description: "Caddy TLS automation configuration",
      schema: TlsConfigOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    autoProxy: {
      description: "swamp serve auto-proxy reconciliation result",
      schema: AutoProxyOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    upgrade: {
      description: "Caddy binary upgrade result",
      schema: UpgradeOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    health: {
      description: "Caddy service + admin API health check",
      schema: HealthOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    ensureProxy: {
      description: "Desired-state proxy ensure result",
      schema: EnsureProxyOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    serveSettings: {
      description: "Settings file_server route status",
      schema: ServeSettingsOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    capabilities: {
      description: "Linux capabilities on the Caddy binary",
      schema: SetCapabilitiesOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    statusPage: {
      description: "Default status page configuration",
      schema: StatusPageOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    desired: {
      description: "What this model wants from its Caddy (merged across peers)",
      schema: DesiredStateSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    reconcile: {
      description: "Result of merging and applying peer models' desired state",
      schema: ReconcileOutputSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    plan: {
      description:
        "Desired (merged) vs actual (live) config, with drift and the full configs to diff",
      schema: PlanOutputSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    audit: {
      description:
        "Every caddy model grouped by the Caddy it manages, each with desired-vs-actual drift",
      schema: AuditOutputSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    installCaddy: {
      description:
        "Download the current Caddy binary (with any requested module packages) and verify it runs",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const binPath = expandHome(g.caddyBinPath);
        const plugins = withDefaultPlugins(args.plugins ?? g.plugins);
        const arch = caddyArch();

        const exists = await Deno.stat(binPath).then(() => true).catch(() =>
          false
        );
        // A file existing is not enough: the wanted modules must actually be
        // compiled in. A new extension version adds built-in plugins (e.g.
        // caddy-host-dns, caddy-teapot-module); without this check the binary
        // is treated as up to date and the config that needs them fails to
        // load ("unknown module"). Rebuild when anything wanted is missing.
        let rebuilt = false;
        let missing: string[] = [];
        if (exists && !args.force) {
          const compiled = await compiledPluginPaths(binPath);
          missing = missingPlugins(plugins, compiled);
        }
        const needsBuild = !exists || args.force || missing.length > 0;
        if (needsBuild) {
          const reason = !exists
            ? "not installed"
            : args.force
            ? "force=true"
            : `missing compiled modules: ${missing.join(", ")}`;
          context.logger?.info(
            "Downloading Caddy binary ({arch}, packages: {plugins}) to {binPath} ({reason})",
            {
              arch,
              plugins: plugins.length > 0 ? plugins.join(", ") : "(none)",
              binPath,
              reason,
            },
          );
          await downloadCaddy(binPath, arch, plugins);
          rebuilt = true;
        } else {
          context.logger?.info(
            "Caddy binary at {binPath} already has all wanted modules; use force=true to reinstall",
            { binPath },
          );
        }

        const verified = await verifyCaddy(binPath);
        context.logger?.info(
          "Caddy {version} installed at {binPath} ({arch})",
          { version: verified.version, binPath, arch },
        );

        // Grant CAP_NET_BIND_SERVICE BEFORE any restart: replacing the binary
        // drops the capability, and a restart only picks up a binary whose
        // capability is already set. Without sudo this records the command for
        // the operator to run by hand; it is never fatal.
        let capabilities: string[] = [];
        let canBindPrivilegedPorts = false;
        let needsSudoForPorts = "";
        if (args.setCapabilities) {
          const result = await applyCapabilities(
            binPath,
            PRIVILEGED_PORT_CAPABILITIES,
          );
          capabilities = await readCapabilities(binPath);
          canBindPrivilegedPorts = hasNetBindService(capabilities);
          if (canBindPrivilegedPorts) {
            context.logger?.info(
              "Granted CAP_NET_BIND_SERVICE to {binPath}; Caddy can bind 80/443 as a user service",
              { binPath },
            );
          } else {
            needsSudoForPorts = result.message;
            context.logger?.info(needsSudoForPorts);
          }
        }

        // Replacing the binary under a running service leaves the OLD binary in
        // the process, so the new modules would still be absent from the live
        // config. Restart the service (if active) so it picks up the rebuild
        // (now with its capability already set above).
        let restarted = false;
        if (rebuilt) {
          const running = await isServiceActive(g.serviceName);
          if (running) {
            if (!canBindPrivilegedPorts && args.setCapabilities) {
              context.logger?.info(
                "Rebuilt binary has no CAP_NET_BIND_SERVICE (sudo unavailable); the service may fail to bind 80/443 until you run the setcap command above",
              );
            }
            await systemctl(["restart", g.serviceName]);
            context.logger?.info(
              "Restarted {serviceName} to run the rebuilt binary",
              { serviceName: g.serviceName },
            );
            // Wait for it to settle, then verify it actually came back up. Caddy
            // runs with --resume, so a bad autosave.json can crash-loop it on
            // restart; without this check the method would report success while
            // the service is down.
            await waitForService(g.serviceName, 15);
            const active = await isServiceActive(g.serviceName);
            const adminUp = await checkAdminApi(g.adminApiAddr);
            restarted = active;
            if (!active) {
              const capHint = args.setCapabilities && !canBindPrivilegedPorts
                ? " The rebuilt binary also lacks CAP_NET_BIND_SERVICE (run the setcap command above), which would stop it binding 80/443."
                : "";
              throw new Error(
                `Caddy service ${g.serviceName} did not restart cleanly after rebuilding the binary. ` +
                  `Check: journalctl --user -u ${g.serviceName} -n 50. ` +
                  `A common cause is a stale ~/.config/caddy/autosave.json that resumes a config using modules the binary no longer has; ` +
                  `swamp does not delete it — move it aside and restart if that is the case.${capHint}`,
              );
            }
            if (!adminUp) {
              context.logger?.info(
                "Restarted {serviceName}, but the admin API at {adminApiAddr} is not reachable yet",
                { serviceName: g.serviceName, adminApiAddr: g.adminApiAddr },
              );
            }
          }
        }

        const handle = await context.writeResource("install", "current", {
          binPath,
          version: verified.version,
          arch,
          plugins,
          installedAt: new Date().toISOString(),
          capabilities,
          canBindPrivilegedPorts,
          needsSudoForPorts,
          rebuilt,
          missingPluginsBeforeBuild: missing,
          restarted,
        });

        // Install the default localhost status page when the admin API is up.
        // It needs a running service, so on a bare install we skip with a log
        // rather than fail; startService calls this too once it is running.
        if (args.configureStatusPage) {
          try {
            await applyStatusPage(
              { title: "Caddy", extraLinks: [], disabled: false },
              context,
              { version: verified.version, capabilities },
            );
          } catch (err) {
            context.logger?.info(
              "Skipped status page (admin API not reachable yet): {error}",
              { error: err instanceof Error ? err.message : String(err) },
            );
          }
        }
        return { dataHandles: [handle] };
      },
    },

    setCapabilities: {
      description:
        "Grant CAP_NET_BIND_SERVICE to the Caddy binary (via sudo) so the unprivileged user service can bind 80/443, or record the exact command to run by hand",
      arguments: SetCapabilitiesArgsSchema,
      execute: async (
        args: z.infer<typeof SetCapabilitiesArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const binPath = expandHome(args.binPath ?? g.caddyBinPath);
        const capabilities = args.capabilities ?? PRIVILEGED_PORT_CAPABILITIES;

        const before = await readCapabilities(binPath);
        const already = capabilities.every((c) => before.includes(c));
        const result = already
          ? {
            applied: true,
            requiresSudo: false,
            message: "Already granted",
          }
          : await applyCapabilities(binPath, capabilities);
        const after = await readCapabilities(binPath);
        const applied = capabilities.every((c) => after.includes(c));
        const command = renderSetcapCommand(binPath, capabilities);

        if (!args.quiet) {
          if (applied) {
            context.logger?.info(
              "Caddy binary {binPath} can bind privileged ports ({caps})",
              { binPath, caps: after.join(" ") || "(none)" },
            );
          } else {
            context.logger?.info(
              result.message ||
                renderPrivilegedPortGuidance(binPath, capabilities),
            );
          }
        }

        const handle = await context.writeResource(
          "capabilities",
          "current",
          {
            binPath,
            capabilities: after,
            changed: !already,
            applied,
            requiresSudo: result.requiresSudo,
            command,
            message: applied
              ? `Granted ${capabilities.join(" ")}`
              : `Run by hand: ${command}`,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    createService: {
      description: "Create the systemd user service unit for Caddy",
      arguments: ServiceArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const serviceName = args.serviceName ?? g.serviceName;
        const binPath = expandHome(g.caddyBinPath);
        const configPath = expandHome(g.configPath);
        const unitPath = expandHome(
          `~/.config/systemd/user/${serviceName}.service`,
        );

        const unit = renderServiceUnit({
          binPath,
          configPath,
          environmentFile: g.environmentFile
            ? expandHome(g.environmentFile)
            : undefined,
        });
        await writeUnitFile(unitPath, unit);

        // Write a minimal config so the service can actually start.
        const configDir = dirnameOf(configPath);
        await Deno.mkdir(configDir, { recursive: true });
        await Deno.writeTextFile(
          configPath,
          renderMinimalConfig({
            adminApiAddr: g.adminApiAddr,
            autoHttps: g.autoHttps,
          }),
        );

        const reload = await systemctl(["daemon-reload"]);
        if (reload.code !== 0) {
          throw new Error(
            `systemctl --user daemon-reload failed (${reload.code}): ${
              reload.stderr || reload.stdout
            }`,
          );
        }

        context.logger?.info(
          "Created systemd user service {serviceName} at {unitPath}",
          { serviceName, unitPath },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath,
          active: false,
          enabled: false,
          adminApiReachable: false,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startService: {
      description:
        "Start and enable the Caddy systemd user service and verify the admin API",
      arguments: ServiceArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const serviceName = args.serviceName ?? g.serviceName;

        const enable = await systemctl(["enable", "--now", serviceName]);
        if (enable.code !== 0) {
          throw new Error(
            `systemctl --user enable --now ${serviceName} failed (${enable.code}): ${
              enable.stderr || enable.stdout
            }`,
          );
        }

        const active = await systemctl(["is-active", serviceName]);
        const enabled = await systemctl(["is-enabled", serviceName]);
        const adminApiReachable = await checkAdminApi(g.adminApiAddr);

        if (active.code !== 0) {
          throw new Error(
            `Caddy service ${serviceName} is not active: ${
              active.stderr || active.stdout
            }`,
          );
        }

        context.logger?.info(
          "Caddy service {serviceName} is active; admin API reachable: {reachable}",
          { serviceName, reachable: adminApiReachable },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath: expandHome(
            `~/.config/systemd/user/${serviceName}.service`,
          ),
          active: active.code === 0,
          enabled: enabled.code === 0,
          adminApiReachable,
          checkedAt: new Date().toISOString(),
        });

        // Ensure the default status page exists now the admin API is up (it may
        // not have been reachable during installCaddy).
        if (adminApiReachable) {
          try {
            await applyStatusPage(
              { title: "Caddy", extraLinks: [], disabled: false },
              context,
            );
          } catch (err) {
            context.logger?.info("Skipped status page: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { dataHandles: [handle] };
      },
    },

    settingsGuidance: {
      description:
        "Print the minimal settings needed for a useful Let's Encrypt TLS-configured Caddy",
      arguments: GuidanceArgsSchema,
      execute: async (
        _args: z.infer<typeof GuidanceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const baseDomain = g.baseDomain ?? "";
        const letsEncryptEmail = g.letsEncryptEmail ?? "";
        const guidance = renderSettingsGuidance({
          baseDomain,
          letsEncryptEmail,
          adminApiAddr: g.adminApiAddr,
          binPath: expandHome(g.caddyBinPath),
        });

        context.logger?.info(guidance);

        const handle = await context.writeResource("guidance", "current", {
          guidance,
          baseDomain,
          letsEncryptEmail,
          adminApiAddr: g.adminApiAddr,
        });
        return { dataHandles: [handle] };
      },
    },

    addProxyService: {
      description:
        "Add a reverse-proxy route for a service via the Caddy admin API (live, no restart)",
      arguments: AddProxyArgsSchema,
      execute: async (
        args: z.infer<typeof AddProxyArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const baseDomain = args.baseDomain ?? g.baseDomain;
        if (!baseDomain) {
          throw new Error(
            "baseDomain is required — set it as a global argument or pass it to addProxyService",
          );
        }
        const hostname = deriveHostname(args.serviceName, baseDomain);
        const upstream = parseUpstream(args.upstream);

        const own = await loadOwnDesired(context, g);
        upsertRoute(own, {
          hostname,
          kind: "proxy",
          upstream: upstream.dial,
          root: "",
          browse: false,
        });
        await saveAndReconcile(context, g, own);

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const services = listProxyServices(config, baseDomain);
        context.logger?.info(
          "Added proxy service {serviceName} -> {hostname} -> {upstream}",
          { serviceName: args.serviceName, hostname, upstream: upstream.dial },
        );

        const handle = await context.writeResource("proxyServices", "current", {
          services,
          updatedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    removeProxyService: {
      description:
        "Stop the backend systemd service and remove its Caddy route via the admin API",
      arguments: RemoveProxyArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveProxyArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const baseDomain = args.baseDomain ?? g.baseDomain;
        if (!baseDomain) {
          throw new Error(
            "baseDomain is required — set it as a global argument or pass it to removeProxyService",
          );
        }
        const hostname = deriveHostname(args.serviceName, baseDomain);

        // Stop the associated backend systemd service (best-effort: a backend
        // may not have a unit, or may already be stopped).
        const stop = await systemctl(["stop", args.serviceName]);
        if (stop.code !== 0) {
          context.logger?.info(
            "systemd service {serviceName} not running (or not found): {detail}",
            {
              serviceName: args.serviceName,
              detail: stop.stderr || stop.stdout,
            },
          );
        }

        const own = await loadOwnDesired(context, g);
        const had = own.routes.some((r) => r.hostname === hostname);
        dropRoute(own, hostname);
        await saveAndReconcile(context, g, own);

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const services = listProxyServices(config, baseDomain);
        context.logger?.info(
          had
            ? "Removed proxy service {serviceName} ({hostname})"
            : "Proxy service {serviceName} ({hostname}) already absent — nothing to remove",
          { serviceName: args.serviceName, hostname },
        );

        const handle = await context.writeResource("proxyServices", "current", {
          services,
          updatedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startBackendService: {
      description: "Start a backend systemd user service by name",
      arguments: BackendServiceArgsSchema,
      execute: async (
        args: z.infer<typeof BackendServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        await backendServiceAction("start", args.serviceName);
        context.logger?.info("Started backend service {serviceName}", {
          serviceName: args.serviceName,
        });
        return { dataHandles: [] };
      },
    },

    stopBackendService: {
      description: "Stop a backend systemd user service by name",
      arguments: BackendServiceArgsSchema,
      execute: async (
        args: z.infer<typeof BackendServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        await backendServiceAction("stop", args.serviceName);
        context.logger?.info("Stopped backend service {serviceName}", {
          serviceName: args.serviceName,
        });
        return { dataHandles: [] };
      },
    },

    restartBackendService: {
      description: "Restart a backend systemd user service by name",
      arguments: BackendServiceArgsSchema,
      execute: async (
        args: z.infer<typeof BackendServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        await backendServiceAction("restart", args.serviceName);
        context.logger?.info("Restarted backend service {serviceName}", {
          serviceName: args.serviceName,
        });
        return { dataHandles: [] };
      },
    },

    storeConfig: {
      description:
        "Validate and write base domain, ACME email, and admin API token to the Vault",
      arguments: StoreConfigArgsSchema,
      execute: async (
        args: z.infer<typeof StoreConfigArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const vaultName = args.vaultName ?? g.vaultName;
        if (!vaultName) {
          throw new Error(
            "vaultName is required — set it as a global argument or pass it to storeConfig",
          );
        }

        const stored: string[] = [];
        if (args.baseDomain !== undefined) {
          validateBaseDomain(args.baseDomain);
          await vaultPut(vaultName, "caddy-base-domain", args.baseDomain);
          stored.push("baseDomain");
        }
        if (args.letsEncryptEmail !== undefined) {
          validateEmail(args.letsEncryptEmail);
          await vaultPut(
            vaultName,
            "caddy-letsencrypt-email",
            args.letsEncryptEmail,
          );
          stored.push("letsEncryptEmail");
        }
        if (args.adminApiToken !== undefined) {
          if (args.adminApiToken.length < 8) {
            throw new Error("admin API token must be at least 8 characters");
          }
          await vaultPut(vaultName, "caddy-admin-token", args.adminApiToken);
          stored.push("adminApiToken");
        }
        if (stored.length === 0) {
          throw new Error(
            "Nothing to store — pass baseDomain, letsEncryptEmail, and/or adminApiToken",
          );
        }

        context.logger?.info(
          "Stored {keys} in Vault {vaultName}",
          { keys: stored.join(", "), vaultName },
        );

        const handle = await context.writeResource("config", "current", {
          baseDomain: args.baseDomain ?? g.baseDomain ?? "",
          letsEncryptEmail: args.letsEncryptEmail ?? g.letsEncryptEmail ?? "",
          adminApiAddr: g.adminApiAddr,
          adminApiTokenSet: args.adminApiToken !== undefined ||
            g.adminApiToken !== undefined,
          vaultName,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    syncConfig: {
      description: "Snapshot the effective config into a swamp resource",
      arguments: SyncConfigArgsSchema,
      execute: async (
        _args: z.infer<typeof SyncConfigArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const handle = await context.writeResource("config", "current", {
          baseDomain: g.baseDomain ?? "",
          letsEncryptEmail: g.letsEncryptEmail ?? "",
          adminApiAddr: g.adminApiAddr,
          adminApiTokenSet: g.adminApiToken !== undefined,
          vaultName: g.vaultName ?? "",
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    getConfig: {
      description: "Read the stored config back from the swamp resource",
      arguments: SyncConfigArgsSchema,
      execute: async (
        _args: z.infer<typeof SyncConfigArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const stored = await context.readResource("config");
        if (!stored) {
          throw new Error(
            "No stored config — run syncConfig (or storeConfig) first",
          );
        }
        const handle = await context.writeResource("config", "current", {
          baseDomain: (stored.baseDomain as string) ?? "",
          letsEncryptEmail: (stored.letsEncryptEmail as string) ?? "",
          adminApiAddr: (stored.adminApiAddr as string) ?? "",
          adminApiTokenSet: (stored.adminApiTokenSet as boolean) ?? false,
          vaultName: (stored.vaultName as string) ?? "",
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configureTls: {
      description:
        "Configure the Caddy TLS app (ACME email + optional DNS provider for DNS-challenge issuance)",
      arguments: ConfigureTlsArgsSchema,
      execute: async (
        args: z.infer<typeof ConfigureTlsArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const issuer = args.issuer === "internal" ? "internal" : "";
        const email = args.email ?? g.letsEncryptEmail ?? "";
        // The internal (local CA) issuer needs no ACME account, so an email is
        // only required for the default ACME issuer.
        if (!email && issuer !== "internal") {
          throw new Error(
            "email is required — set letsEncryptEmail or pass it to configureTls (or pass issuer=internal to use Caddy's local CA)",
          );
        }
        if (email) validateEmail(email);

        const own = await loadOwnDesired(context, g);
        own.tls = {
          email,
          dnsProvider: args.dnsProvider ?? "",
          dnsEnvVar: args.dnsEnvVar ?? "",
          providerConfig: args.providerConfig ?? {},
          subjects: args.subjects ?? [],
          issuer,
        };
        await saveAndReconcile(context, g, own);

        const credentialFields = args.providerConfig
          ? Object.keys(args.providerConfig)
          : args.dnsProvider
          ? ["api_token"]
          : [];

        context.logger?.info(
          "Configured TLS: email={email} dnsProvider={dnsProvider}",
          { email, dnsProvider: args.dnsProvider ?? "(none)" },
        );

        const handle = await context.writeResource("tlsConfig", "current", {
          email,
          dnsProvider: args.dnsProvider ?? "",
          subjects: args.subjects ?? [],
          credentialFields,
          configuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    applyDnsRecords: {
      description:
        "Reconcile the desired static DNS records (dnsRecords/dnsRemovals globals) into Caddy, then report what was written",
      arguments: SyncConfigArgsSchema,
      execute: async (
        _args: z.infer<typeof SyncConfigArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const own = await loadOwnDesired(context, g);
        if (
          (own.dnsRecords?.length ?? 0) === 0 &&
          (own.dnsRemovals?.length ?? 0) === 0
        ) {
          throw new Error(
            "No dnsRecords/dnsRemovals are set on this model — add a dnsRecords global arg (name, type, value, and zone when the provider has no ZoneLister), then re-run",
          );
        }
        if (!own.tls?.dnsProvider) {
          throw new Error(
            "dnsRecords need a DNS provider — run configureTls (dnsProvider + providerConfig) first so records are written through it",
          );
        }
        const { summary } = await saveAndReconcile(context, g, own);
        context.logger?.info(
          "Applied {count} DNS record(s) via {provider} (changed={changed})",
          {
            count: own.dnsRecords?.length ?? 0,
            provider: own.tls.dnsProvider,
            changed: summary.changed,
          },
        );
        const handle = await context.writeResource("dnsConfig", "current", {
          records: own.dnsRecords ?? [],
          removals: own.dnsRemovals ?? [],
          provider: own.tls.dnsProvider,
          changed: summary.changed,
          appliedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    autoProxySwampServe: {
      description:
        "Detect running swamp serve systemd services and reconcile their proxy routes",
      arguments: AutoProxyArgsSchema,
      execute: async (
        args: z.infer<typeof AutoProxyArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const baseDomain = args.baseDomain ?? g.baseDomain;
        if (!baseDomain) {
          throw new Error(
            "baseDomain is required — set it as a global argument or pass it to autoProxySwampServe",
          );
        }

        const units = await listSystemdUnits();
        const serviceNames = detectSwampServeServices(units, args.prefix);
        const desired = serviceNames.map((name) => ({
          serviceName: name,
          hostname: deriveHostname(name, baseDomain),
          upstream: `127.0.0.1:${args.port}`,
        }));

        // Fold the detected swamp-serve routes into this model's desired state,
        // and drop any it previously detected but that are now gone. Other
        // models' routes are untouched because reconcile only merges desired
        // state (and only replaces swamp-tagged routes).
        const own = await loadOwnDesired(context, g);
        let previousNames: string[] = [];
        try {
          const prev = await context.readResource("autoProxy") as
            | { detected?: string[] }
            | null;
          previousNames = prev?.detected ?? [];
        } catch {
          previousNames = [];
        }
        const nowHosts = new Set(desired.map((d) => d.hostname));
        for (const name of previousNames) {
          const host = deriveHostname(name, baseDomain);
          if (!nowHosts.has(host)) dropRoute(own, host);
        }
        for (const d of desired) {
          upsertRoute(own, {
            hostname: d.hostname,
            kind: "proxy",
            upstream: d.upstream,
            root: "",
            browse: false,
          });
        }
        await saveAndReconcile(context, g, own);

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const removed = previousNames.map((n) => deriveHostname(n, baseDomain))
          .filter((h) => !nowHosts.has(h));
        context.logger?.info(
          "Auto-proxy reconciled: {count} swamp serve route(s), {removed} removed",
          { count: desired.length, removed: removed.length },
        );

        const handle = await context.writeResource("autoProxy", "current", {
          detected: serviceNames,
          added: desired.map((d) => d.hostname),
          updated: [],
          removed,
          reconciledAt: new Date().toISOString(),
        });
        void config;
        return { dataHandles: [handle] };
      },
    },

    upgradeCaddy: {
      description:
        "Replace the Caddy binary (current release, with module packages) with confirmation, then restart the service",
      arguments: UpgradeArgsSchema,
      execute: async (
        args: z.infer<typeof UpgradeArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        if (args.confirm !== "upgrade") {
          throw new Error(
            renderUpgradeConfirmation({
              plugins: withDefaultPlugins(args.plugins ?? g.plugins),
            }),
          );
        }

        const binPath = expandHome(g.caddyBinPath);
        const plugins = withDefaultPlugins(args.plugins ?? g.plugins);
        const arch = caddyArch();

        // Replacing the binary drops any file capabilities, so remember whether
        // CAP_NET_BIND_SERVICE was set and reapply it after the download.
        const priorCaps = await readCapabilities(binPath);
        const hadNetBind = hasNetBindService(priorCaps);

        context.logger?.info(
          "Downloading Caddy binary ({arch}, packages: {plugins}) to {binPath}",
          {
            arch,
            plugins: plugins.length > 0 ? plugins.join(", ") : "(none)",
            binPath,
          },
        );
        await downloadCaddy(binPath, arch, plugins);

        const verified = await verifyCaddy(binPath);

        if (hadNetBind) {
          const caps = await applyCapabilities(
            binPath,
            PRIVILEGED_PORT_CAPABILITIES,
          );
          if (!caps.applied) {
            context.logger?.info(caps.message);
          }
        }

        const restart = await systemctl(["restart", g.serviceName]);
        if (restart.code !== 0) {
          throw new Error(
            `systemctl --user restart ${g.serviceName} failed (${restart.code}): ${
              restart.stderr || restart.stdout
            }`,
          );
        }
        // Verify it came back: Caddy resumes autosave.json, so a stale config
        // using an absent module can crash-loop it on restart.
        await waitForService(g.serviceName, 15);
        if (!(await isServiceActive(g.serviceName))) {
          throw new Error(
            `Caddy service ${g.serviceName} did not restart cleanly after upgrade. ` +
              `Check: journalctl --user -u ${g.serviceName} -n 50. ` +
              `A stale ~/.config/caddy/autosave.json resuming a config with modules the binary lacks is a common cause.`,
          );
        }

        context.logger?.info(
          "Upgraded Caddy to {version} and restarted {serviceName}",
          { version: verified.version, serviceName: g.serviceName },
        );

        const handle = await context.writeResource("upgrade", "current", {
          binPath,
          version: verified.version,
          plugins,
          restarted: true,
          upgradedAt: new Date().toISOString(),
          capabilities: await readCapabilities(binPath),
        });
        return { dataHandles: [handle] };
      },
    },

    checkHealth: {
      description: "Report Caddy service + admin API health",
      arguments: ServiceArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const serviceName = args.serviceName ?? g.serviceName;

        const active = await systemctl(["is-active", serviceName]);
        const adminApiReachable = await checkAdminApi(g.adminApiAddr);
        const health = computeHealth(active.code === 0, adminApiReachable);

        if (health.healthy) {
          context.logger?.info("Caddy is healthy ({status})", {
            status: health.status,
          });
        } else {
          context.logger?.warning?.(
            "Caddy is unhealthy ({status}): active={active} adminApiReachable={reachable}",
            {
              status: health.status,
              active: active.code === 0,
              reachable: adminApiReachable,
            },
          );
        }

        const handle = await context.writeResource("health", "current", {
          serviceName,
          active: active.code === 0,
          adminApiReachable,
          healthy: health.healthy,
          status: health.status,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stopService: {
      description: "Stop the Caddy systemd user service",
      arguments: ServiceArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const serviceName = args.serviceName ?? g.serviceName;
        const result = await systemctl(["stop", serviceName]);
        if (result.code !== 0) {
          throw new Error(
            `systemctl --user stop ${serviceName} failed (${result.code}): ${
              result.stderr || result.stdout
            }`,
          );
        }
        context.logger?.info("Stopped Caddy service {serviceName}", {
          serviceName,
        });
        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath: expandHome(
            `~/.config/systemd/user/${serviceName}.service`,
          ),
          active: false,
          enabled: false,
          adminApiReachable: false,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    restartService: {
      description: "Restart the Caddy systemd user service",
      arguments: ServiceArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const serviceName = args.serviceName ?? g.serviceName;
        const result = await systemctl(["restart", serviceName]);
        if (result.code !== 0) {
          throw new Error(
            `systemctl --user restart ${serviceName} failed (${result.code}): ${
              result.stderr || result.stdout
            }`,
          );
        }
        context.logger?.info("Restarted Caddy service {serviceName}", {
          serviceName,
        });
        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath: expandHome(
            `~/.config/systemd/user/${serviceName}.service`,
          ),
          active: true,
          enabled: true,
          adminApiReachable: await checkAdminApi(g.adminApiAddr),
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    ensureDnsProxy: {
      description:
        "Idempotently ensure a full hostname proxies to a backend host:port",
      arguments: EnsureDnsProxyArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureDnsProxyArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const upstream = parseUpstream(args.upstream);

        const own = await loadOwnDesired(context, g);
        upsertRoute(own, {
          hostname: args.hostname,
          kind: "proxy",
          upstream: upstream.dial,
          root: "",
          browse: false,
          rootPath: args.rootPath,
        });
        const { summary } = await saveAndReconcile(context, g, own);

        context.logger?.info(
          "ensureDnsProxy {hostname} -> {upstream}{rootPath} ({action})",
          {
            hostname: args.hostname,
            upstream: upstream.dial,
            rootPath: args.rootPath ? ` (root -> ${args.rootPath})` : "",
            action: summary.changed ? "updated" : "unchanged",
          },
        );

        const handle = await context.writeResource("ensureProxy", "current", {
          hostname: args.hostname,
          upstream: upstream.dial,
          changed: summary.changed,
          ensuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    serveSettings: {
      description:
        "Idempotently serve a static settings document directory over HTTP(S) at a hostname via Caddy file_server",
      arguments: ServeSettingsArgsSchema,
      execute: async (
        args: z.infer<typeof ServeSettingsArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const root = expandHome(args.root);
        if (!root.startsWith("/")) {
          throw new Error(
            `root must be an absolute path (or start with ~): got '${args.root}'`,
          );
        }

        const own = await loadOwnDesired(context, g);
        upsertRoute(own, {
          hostname: args.hostname,
          kind: "file_server",
          upstream: "",
          root,
          browse: args.browse,
        });
        const { summary } = await saveAndReconcile(context, g, own);

        context.logger?.info(
          "serveSettings {hostname} -> {root} ({action})",
          {
            hostname: args.hostname,
            root,
            action: summary.changed ? "updated" : "unchanged",
          },
        );

        const handle = await context.writeResource("serveSettings", "current", {
          hostname: args.hostname,
          root,
          browse: args.browse,
          changed: summary.changed,
          servedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configureStatusPage: {
      description:
        "Install (or remove) a default status page answering on localhost, summarising the install and linking to the admin API and configured routes",
      arguments: ConfigureStatusPageArgsSchema,
      execute: (
        args: z.infer<typeof ConfigureStatusPageArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> =>
        applyStatusPage(args, context),
    },

    plan: {
      description:
        "Show ALL models for this Caddy merged, beside the live config, with drift and both configs to diff",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const own = await loadOwnDesired(context, g);
        const caddy = await computeCaddyPlan(context, own, g.adminApiToken);
        context.logger?.info(
          "Plan for {target}: models [{models}], {desired} desired swamp route(s), in sync: {sync}",
          {
            target: caddy.target,
            models: caddy.models.join(", "),
            desired: caddy.desiredRoutes.length,
            sync: caddy.inSync,
          },
        );
        const handle = await context.writeResource("plan", "plan", {
          ...caddy,
          plannedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    audit: {
      description:
        "One command: find every caddy model, group them by the Caddy they manage, and report each Caddy's merged desired-vs-actual config and drift",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        // Every caddy model in the repo, gathered directly (not just this
        // target), so the caller does not need to know any model names.
        const all = await gatherAllDesired(context);
        const own = await loadOwnDesired(context, g);
        if (all.length === 0) all.push(own);

        // Group models by the Caddy they manage.
        const groups = new Map<string, DesiredState[]>();
        for (const s of all) {
          const key = caddyTargetKey(s.target, s.serviceName);
          const list = groups.get(key) ?? [];
          list.push(s);
          groups.set(key, list);
        }

        const cadies = [];
        for (const [, states] of groups) {
          const representative = states[0];
          const caddy = await computeCaddyPlan(
            context,
            representative,
            g.adminApiToken,
            states,
          );
          cadies.push(caddy);
        }

        const inSync = cadies.every((c) => c.inSync) && cadies.length > 0;
        context.logger?.info(
          "Audit: {cadies} Caddy instance(s), {models} model(s) total, all in sync: {sync}",
          { cadies: cadies.length, models: all.length, sync: inSync },
        );
        const handle = await context.writeResource("audit", "audit", {
          cadies,
          modelCount: all.length,
          inSync,
          auditedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Shared status-page installer used by both the `configureStatusPage` method and
 * `installCaddy` (which installs the page by default). Writes the `statusPage`
 * resource and returns its handle.
 */
async function applyStatusPage(
  args: {
    title: string;
    extraLinks: Array<{ label: string; url: string }>;
    disabled: boolean;
  },
  context: MethodContext,
  facts?: { version: string; capabilities: string[] },
): Promise<{ dataHandles: [{ name: string }] }> {
  const g = context.globalArgs;
  const config = await readConfig(
    g.adminApiAddr,
    g.adminApiToken,
    g.listenAddrs,
    g.autoHttps,
  );

  if (args.disabled) {
    const own = await loadOwnDesired(context, g);
    own.statusPage = null;
    const { summary } = await saveAndReconcile(context, g, own);
    context.logger?.info(
      "Status page removed (reconciled)",
      { changed: summary.changed },
    );
    const handle = await context.writeResource("statusPage", "current", {
      modelName: context.definition?.name ?? "",
      hostnames: statusPageHostnames(),
      title: args.title,
      adminUrl: "",
      listens: [],
      links: [],
      plugins: [],
      changed: summary.changed,
      removed: true,
      configuredAt: new Date().toISOString(),
    });
    return { dataHandles: [handle] };
  }

  // Gather install facts (best-effort) to describe what's been installed.
  // Prefer facts passed in from installCaddy; otherwise read the install
  // resource, and for the binary version/capabilities fall back to the live
  // binary so the page never shows a stale capability warning.
  let version = facts?.version ?? "";
  let capabilities = facts?.capabilities ?? [];
  if (!facts) {
    const install = await context.readResource("install").catch(() => null);
    if (install && typeof install.version === "string") {
      version = install.version;
    }
    if (install && Array.isArray(install.capabilities)) {
      capabilities = install.capabilities as string[];
    }
  }
  const binPath = expandHome(g.caddyBinPath);
  const binExists = await fileExists(binPath);
  if (!version && binExists) {
    const v = await runCmd(binPath, ["version"]);
    if (v.code === 0) version = parseCaddyVersion(v.stdout);
  }
  if (!hasNetBindService(capabilities) && binExists) {
    capabilities = await readCapabilities(binPath);
  }
  // Which modules (plugins) are compiled into this binary.
  let modules: CaddyModule[] = [];
  if (binExists) {
    const lm = await runCmd(binPath, ["list-modules", "--json"]);
    if (lm.code === 0) modules = parseModules(lm.stdout);
  }
  const plugins = thirdPartyPlugins(modules);
  const listens = configuredListens(config);
  const adminUrl = adminApiUrlString(g.adminApiAddr);

  // Store the page's INPUTS on desired state; reconcile re-renders the HTML
  // against the merged routes each run, so the page is never a stale snapshot.
  const own = await loadOwnDesired(context, g);
  own.statusPage = {
    enabled: true,
    title: args.title,
    hostnames: statusPageHostnames(),
    extraLinks: args.extraLinks,
    version,
    adminUrl,
    baseDomain: g.baseDomain ?? "",
    email: g.letsEncryptEmail ?? "",
    capabilities,
    plugins,
    links: [],
  };
  const { summary } = await saveAndReconcile(context, g, own);

  // The links actually rendered are derived from the merged (desired) routes.
  const links = statusPageLinks({
    routes: own.routes,
    statusHostnames: statusPageHostnames(),
    extra: args.extraLinks,
  });

  context.logger?.info(
    "Status page {action} on {hosts} ({links} links)",
    {
      action: summary.changed ? "installed" : "unchanged",
      hosts: statusPageHostnames().join(", "),
      links: links.length,
    },
  );

  const handle = await context.writeResource("statusPage", "current", {
    modelName: context.definition?.name ?? "",
    hostnames: statusPageHostnames(),
    title: args.title,
    adminUrl,
    listens,
    links,
    plugins,
    changed: summary.changed,
    removed: false,
    configuredAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}
