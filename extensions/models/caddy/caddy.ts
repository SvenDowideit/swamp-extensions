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
    "Caddy module packages to include in the downloaded binary, e.g. github.com/caddy-dns/cloudflare (optionally github.com/foo/bar@v1.2.3)",
  ),
  adminApiToken: z.string().optional().meta({ sensitive: true }).describe(
    "Optional admin API token (sent as a Bearer header when set)",
  ),
  vaultName: z.string().optional().describe(
    "Vault name used by storeConfig to write secrets (e.g. caddy-secrets)",
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
    "Environment variable holding the DNS provider credential (default CADDY_DNS_API_TOKEN)",
  ),
  subjects: z.array(z.string()).optional().describe(
    "Subjects for the TLS policy (e.g. *.example.com, example.com)",
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
}): string {
  const { binPath, configPath } = opts;
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
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full

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
}): string {
  const { baseDomain, letsEncryptEmail, adminApiAddr } = opts;
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

/** Build a Caddy reverse-proxy route for a hostname + upstream. */
export function buildRoute(
  hostname: string,
  upstream: { dial: string; https: boolean },
): CaddyRoute {
  const handle: Record<string, unknown> = {
    handler: "reverse_proxy",
    upstreams: [{ dial: upstream.dial }],
  };
  if (upstream.https) {
    handle.transport = { protocol: "http", tls: {} };
  }
  return {
    match: [{ host: [hostname] }],
    handle: [handle],
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

/** Remove a route for a hostname, throwing if it is not found. */
export function removeRouteFromConfig(
  config: CaddyConfig,
  hostname: string,
): CaddyConfig {
  const existing = findRouteByHost(config, hostname);
  if (!existing) {
    throw new Error(`No route found for domain '${hostname}'`);
  }
  const next = structuredClone(config);
  const routes = getRoutes(next);
  routes.splice(existing.index, 1);
  setRoutes(next, routes);
  return next;
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
  subjects?: string[];
}): CaddyConfig {
  const issuer: Record<string, unknown> = { module: "acme" };
  if (opts.email) issuer.email = opts.email;
  if (opts.dnsProvider) {
    issuer.challenges = {
      dns: {
        provider: {
          name: opts.dnsProvider,
          api_token: `{env.${opts.dnsEnvVar ?? "CADDY_DNS_API_TOKEN"}}`,
        },
      },
    };
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
  await Deno.writeFile(binPath, bytes, { mode: 0o755 });
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

// ---------------------------------------------------------------------------
// systemd + admin API helpers
// ---------------------------------------------------------------------------

async function systemctl(
  args: string[],
): Promise<CmdResult> {
  return await runCmd("systemctl", ["--user", ...args]);
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
};

/** Model definition for the Caddy reverse-proxy and service manager. */
export const model = {
  type: "@svendowideit/caddy",
  version: "2026.09.20.3",
  globalArguments: GlobalArgsSchema,
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
  ],
  resources: {
    install: {
      description: "Caddy binary install status",
      schema: InstallOutputSchema,
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
        const plugins = args.plugins ?? g.plugins;
        const arch = caddyArch();

        const exists = await Deno.stat(binPath).then(() => true).catch(() =>
          false
        );
        if (exists && !args.force) {
          context.logger?.info(
            "Caddy binary already exists at {binPath}; use force=true to reinstall",
            { binPath },
          );
        } else {
          context.logger?.info(
            "Downloading Caddy binary ({arch}, packages: {plugins}) to {binPath}",
            {
              arch,
              plugins: plugins.length > 0 ? plugins.join(", ") : "(none)",
              binPath,
            },
          );
          await downloadCaddy(binPath, arch, plugins);
        }

        const verified = await verifyCaddy(binPath);
        context.logger?.info(
          "Caddy {version} installed at {binPath} ({arch})",
          { version: verified.version, binPath, arch },
        );

        const handle = await context.writeResource("install", "current", {
          binPath,
          version: verified.version,
          arch,
          plugins,
          installedAt: new Date().toISOString(),
        });
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

        const unit = renderServiceUnit({ binPath, configPath });
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
        const route = buildRoute(hostname, upstream);

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const next = addRouteToConfig(config, route); // throws on domain conflict
        await writeConfig(g.adminApiAddr, next, g.adminApiToken);

        const services = listProxyServices(next, baseDomain);
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

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const next = removeRouteFromConfig(config, hostname); // throws if not found
        await writeConfig(g.adminApiAddr, next, g.adminApiToken);

        const services = listProxyServices(next, baseDomain);
        context.logger?.info(
          "Removed proxy service {serviceName} ({hostname})",
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
        const email = args.email ?? g.letsEncryptEmail;
        if (!email) {
          throw new Error(
            "email is required — set letsEncryptEmail or pass it to configureTls",
          );
        }
        validateEmail(email);

        const tlsConfig = renderTlsAutomation({
          email,
          dnsProvider: args.dnsProvider,
          dnsEnvVar: args.dnsEnvVar,
          subjects: args.subjects,
        });

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const next = mergeTlsConfig(config, tlsConfig);
        await writeConfig(g.adminApiAddr, next, g.adminApiToken);

        context.logger?.info(
          "Configured TLS: email={email} dnsProvider={dnsProvider}",
          { email, dnsProvider: args.dnsProvider ?? "(none)" },
        );

        const handle = await context.writeResource("tlsConfig", "current", {
          email,
          dnsProvider: args.dnsProvider ?? "",
          subjects: args.subjects ?? [],
          configuredAt: new Date().toISOString(),
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

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const { toEnsure, toRemove } = reconcileProxyServices(
          desired,
          config,
          baseDomain,
        );

        let next = config;
        let changed = false;
        const added: string[] = [];
        const updated: string[] = [];
        for (const item of toEnsure) {
          const existed = findRouteByHost(next, item.hostname) !== null;
          const result = ensureRoute(
            next,
            item.hostname,
            parseUpstream(item.upstream),
          );
          if (result.changed) {
            next = result.config;
            changed = true;
            (existed ? updated : added).push(item.hostname);
          }
        }
        for (const hostname of toRemove) {
          next = removeRouteFromConfig(next, hostname);
          changed = true;
        }
        if (changed) {
          await writeConfig(g.adminApiAddr, next, g.adminApiToken);
        }

        context.logger?.info(
          "Auto-proxy reconciled: {added} added, {updated} updated, {removed} removed",
          {
            added: added.length,
            updated: updated.length,
            removed: toRemove.length,
          },
        );

        const handle = await context.writeResource("autoProxy", "current", {
          detected: serviceNames,
          added,
          updated,
          removed: toRemove,
          reconciledAt: new Date().toISOString(),
        });
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
            renderUpgradeConfirmation({ plugins: args.plugins ?? g.plugins }),
          );
        }

        const binPath = expandHome(g.caddyBinPath);
        const plugins = args.plugins ?? g.plugins;
        const arch = caddyArch();

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

        const restart = await systemctl(["restart", g.serviceName]);
        if (restart.code !== 0) {
          throw new Error(
            `systemctl --user restart ${g.serviceName} failed (${restart.code}): ${
              restart.stderr || restart.stdout
            }`,
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

        const config = await readConfig(
          g.adminApiAddr,
          g.adminApiToken,
          g.listenAddrs,
          g.autoHttps,
        );
        const { config: next, changed } = ensureRoute(
          config,
          args.hostname,
          upstream,
        );
        if (changed) {
          await writeConfig(g.adminApiAddr, next, g.adminApiToken);
        }

        context.logger?.info(
          "ensureDnsProxy {hostname} -> {upstream} ({action})",
          {
            hostname: args.hostname,
            upstream: upstream.dial,
            action: changed ? "updated" : "unchanged",
          },
        );

        const handle = await context.writeResource("ensureProxy", "current", {
          hostname: args.hostname,
          upstream: upstream.dial,
          changed,
          ensuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
