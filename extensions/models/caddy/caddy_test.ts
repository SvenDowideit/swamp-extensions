import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  addRouteToConfig,
  adminApiUrlString,
  automaticHttpsConfig,
  baseConfig,
  buildCurlArgs,
  buildFileServerRoute,
  buildHealthRoutes,
  buildReconciledConfig,
  buildRoute,
  buildStatusPageRoute,
  caddyArch,
  caddyDownloadUrl,
  caddyTargetKey,
  computeHealth,
  configuredListens,
  DEFAULT_CADDY_PLUGINS,
  defaultStatusHostnames,
  deriveHostname,
  detectSwampServeServices,
  diffRoutes,
  dnsProviderPlugin,
  ensureFileServerRoute,
  ensureRoute,
  ensureServerDefaults,
  ensureStatusPageRoute,
  expandHome,
  findRouteByHost,
  hasNetBindService,
  isGeneratedRoute,
  isHealthRoute,
  isStatusPageRoute,
  isSwampRoute,
  listProxyServices,
  liveTlsInfo,
  mergeDesired,
  mergeTlsConfig,
  missingPlugins,
  model,
  parseAdminAddr,
  parseCaddyVersion,
  parseGetcap,
  parseModules,
  parseUpstream,
  PRIVILEGED_PORT_CAPABILITIES,
  reconcileProxyServices,
  removeRouteFromConfig,
  removeStatusPageRoute,
  renderAdminConfig,
  renderDomainConflictError,
  renderMinimalConfig,
  renderNextCommands,
  renderPrivilegedPortGuidance,
  renderServiceUnit,
  renderSetcapCommand,
  renderSettingsGuidance,
  renderStatusPage,
  renderTlsAutomation,
  renderUpgradeConfirmation,
  requiredCaddyModules,
  routeFileServerRoot,
  routeHostnames,
  routeId,
  routeUpstream,
  statusPageHostnames,
  statusPageLinks,
  thirdPartyPlugins,
  validateBaseDomain,
  validateEmail,
  withDefaultPlugins,
  writeDnsRecords,
} from "./caddy.ts";

// Minimal global args for exercising the pre-flight checks.
function checkArgs(overrides: Record<string, unknown> = {}) {
  return {
    caddyBinPath: "~/.local/bin/caddy",
    adminApiAddr: "localhost:2019",
    configPath: "~/.config/caddy/Caddyfile",
    autoHttps: "on",
    listenAddrs: [":443", ":80"],
    serviceName: "caddy",
    plugins: [],
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("valid-config check passes a well-formed config", () => {
  const result = model.checks["valid-config"].execute({
    globalArgs: checkArgs({
      baseDomain: "example.com",
      letsEncryptEmail: "admin@example.com",
    }),
    methodName: "installCaddy",
  });
  assertEquals(result.pass, true);
});

Deno.test("valid-config check rejects a malformed base domain and email", () => {
  const result = model.checks["valid-config"].execute({
    globalArgs: checkArgs({
      baseDomain: "https://example.com/path",
      letsEncryptEmail: "not-an-email",
    }),
    methodName: "installCaddy",
  });
  assertEquals(result.pass, false);
  assertEquals(result.errors?.length, 2);
});

Deno.test("valid-config check rejects empty listen addresses", () => {
  const result = model.checks["valid-config"].execute({
    globalArgs: checkArgs({ listenAddrs: [] }),
    methodName: "startService",
  });
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors?.[0] ?? "", "listenAddrs");
});

Deno.test("platform-supported check passes on this Linux host", async () => {
  const result = await model.checks["platform-supported"].execute({
    globalArgs: checkArgs(),
    methodName: "installCaddy",
  });
  assertEquals(result.pass, true);
});

Deno.test("pre-flight checks declare labels and appliesTo", () => {
  for (const [name, check] of Object.entries(model.checks)) {
    assertEquals(Array.isArray(check.labels), true, `${name} needs labels`);
    assertEquals(
      Array.isArray(check.appliesTo) && check.appliesTo.length > 0,
      true,
      `${name} needs appliesTo`,
    );
  }
});

Deno.test("expandHome expands a leading ~ to the home directory", () => {
  assertEquals(expandHome("~", "/home/alice"), "/home/alice");
  assertEquals(
    expandHome("~/.local/bin/caddy", "/home/alice"),
    "/home/alice/.local/bin/caddy",
  );
  assertEquals(
    expandHome("/usr/local/bin/caddy", "/home/alice"),
    "/usr/local/bin/caddy",
  );
});

Deno.test("caddyArch maps Deno arch to Caddy download labels", () => {
  assertEquals(caddyArch("x86_64"), "amd64");
  assertEquals(caddyArch("aarch64"), "arm64");
});

Deno.test("caddyArch rejects unsupported architectures", () => {
  let threw = false;
  try {
    caddyArch("riscv64");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseCaddyVersion extracts the leading version token", () => {
  assertEquals(parseCaddyVersion("v2.8.4 h1:abc123"), "v2.8.4");
  assertEquals(parseCaddyVersion("v2.8.4"), "v2.8.4");
});

Deno.test("caddyDownloadUrl targets the download API with os/arch", () => {
  assertEquals(
    caddyDownloadUrl("amd64"),
    "https://caddyserver.com/api/download?os=linux&arch=amd64",
  );
});

Deno.test("caddyDownloadUrl adds a p param per module package", () => {
  const url = new URL(
    caddyDownloadUrl("amd64", [
      "github.com/caddy-dns/cloudflare",
      "github.com/caddy-dns/route53@v1.2.3",
    ]),
  );
  assertEquals(url.searchParams.getAll("p"), [
    "github.com/caddy-dns/cloudflare",
    "github.com/caddy-dns/route53@v1.2.3",
  ]);
  assertEquals(url.searchParams.get("os"), "linux");
  assertEquals(url.searchParams.get("arch"), "amd64");
});

Deno.test("parseCaddyVersion throws on empty output", () => {
  let threw = false;
  try {
    parseCaddyVersion("   ");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("renderServiceUnit includes binary, config, and --resume, but no --admin flag", () => {
  const unit = renderServiceUnit({
    binPath: "/home/alice/.local/bin/caddy",
    configPath: "/home/alice/.config/caddy/Caddyfile",
  });
  assertStringIncludes(unit, "ExecStart=/home/alice/.local/bin/caddy run");
  assertStringIncludes(unit, "--config /home/alice/.config/caddy/Caddyfile");
  assertStringIncludes(unit, "--adapter caddyfile");
  assertStringIncludes(unit, "WantedBy=default.target");
  // --resume reloads the config autosaved from admin-API changes, so routes
  // survive a service restart.
  assertStringIncludes(unit, "run --resume");
  // Caddy v2.11+ rejects `caddy run --admin`; the admin endpoint belongs in
  // the Caddyfile global options instead.
  const hasAdminFlag = unit
    .split("\n")
    .some((line) => /(^|\s)--admin(\s|$)/.test(line));
  assertEquals(hasAdminFlag, false);
  // Reloading via the Caddyfile would discard admin-API routes, so the unit
  // must not carry an ExecReload pointing at it.
  const hasExecReload = unit
    .split("\n")
    .some((line) => line.startsWith("ExecReload="));
  assertEquals(hasExecReload, false);
  // LimitNPROC must NOT be set: for a systemd *user* service it is per-UID
  // across all the user's processes, so a low value makes Go fail to spawn a
  // thread (EAGAIN) and Caddy exits status=2.
  const hasLimitNPROC = unit
    .split("\n")
    .some((line) => line.startsWith("LimitNPROC="));
  assertEquals(hasLimitNPROC, false);
  // No EnvironmentFile unless one is configured.
  assertEquals(unit.includes("EnvironmentFile="), false);
});

Deno.test("renderServiceUnit adds a tolerant EnvironmentFile when configured", () => {
  const unit = renderServiceUnit({
    binPath: "/home/alice/.local/bin/caddy",
    configPath: "/home/alice/.config/caddy/Caddyfile",
    environmentFile: "/home/alice/.config/caddy/dns.env",
  });
  assertStringIncludes(
    unit,
    "EnvironmentFile=-/home/alice/.config/caddy/dns.env",
  );
});

Deno.test("renderMinimalConfig is a valid empty Caddyfile with defaults", () => {
  const cfg = renderMinimalConfig();
  assertStringIncludes(cfg, "Managed by @svendowideit/caddy");
  assertStringIncludes(cfg, "{");
});

Deno.test("renderMinimalConfig writes admin addr and auto_https when non-default", () => {
  const cfg = renderMinimalConfig({
    adminApiAddr: "unix//run/user/1000/caddy.sock",
    autoHttps: "off",
  });
  assertStringIncludes(cfg, "admin unix//run/user/1000/caddy.sock");
  assertStringIncludes(cfg, "auto_https off");
});

Deno.test("renderMinimalConfig omits default admin addr and auto_https on", () => {
  const cfg = renderMinimalConfig({
    adminApiAddr: "localhost:2019",
    autoHttps: "on",
  });
  const hasAdmin = cfg.split("\n").some((line) =>
    line.trim().startsWith("admin ")
  );
  const hasAutoHttps = cfg
    .split("\n")
    .some((line) => line.trim().startsWith("auto_https "));
  assertEquals(hasAdmin, false);
  assertEquals(hasAutoHttps, false);
});

Deno.test("baseConfig uses the provided listen addresses", () => {
  const config = baseConfig([":8888", ":8443"]);
  const apps = config.apps as Record<string, unknown>;
  const http = apps.http as Record<string, unknown>;
  const servers = http.servers as Record<string, unknown>;
  const srv0 = servers.srv0 as Record<string, unknown>;
  assertEquals(srv0.listen, [":8888", ":8443"]);
});

Deno.test("automaticHttpsConfig maps modes to JSON fields", () => {
  assertEquals(automaticHttpsConfig("on"), null);
  assertEquals(automaticHttpsConfig("off"), { disable: true });
  assertEquals(automaticHttpsConfig("disable_redirects"), {
    disable_redirects: true,
  });
  assertEquals(automaticHttpsConfig("disable_certs"), {
    disable_certificates: true,
  });
  assertEquals(automaticHttpsConfig("ignore_loaded_certs"), {
    ignore_loaded_certificates: true,
  });
});

Deno.test("baseConfig disables automatic HTTPS when requested", () => {
  const config = baseConfig([":8888"], "off");
  const apps = config.apps as Record<string, unknown>;
  const http = apps.http as Record<string, unknown>;
  const servers = http.servers as Record<string, unknown>;
  const srv0 = servers.srv0 as Record<string, unknown>;
  assertEquals(srv0.automatic_https, { disable: true });
});

Deno.test("ensureServerDefaults seeds a missing server with listen + auto_https", () => {
  const seeded = ensureServerDefaults({ apps: {} }, [":8888", ":8443"], "off");
  const apps = seeded.apps as Record<string, unknown>;
  const http = apps.http as Record<string, unknown>;
  const servers = http.servers as Record<string, unknown>;
  const srv0 = servers.srv0 as Record<string, unknown>;
  assertEquals(srv0.listen, [":8888", ":8443"]);
  assertEquals(srv0.automatic_https, { disable: true });
});

Deno.test("ensureServerDefaults leaves an existing server untouched", () => {
  const existing = baseConfig([":443"], "on");
  const withRoute = addRouteToConfig(
    existing,
    buildRoute("foo.example.com", { dial: "127.0.0.1:8080", https: false }),
  );
  const seeded = ensureServerDefaults(withRoute, [":8888"], "off");
  const apps = seeded.apps as Record<string, unknown>;
  const http = apps.http as Record<string, unknown>;
  const servers = http.servers as Record<string, unknown>;
  const srv0 = servers.srv0 as Record<string, unknown>;
  assertEquals(srv0.listen, [":443"]);
});

Deno.test("renderSettingsGuidance lists base domain, email, and token", () => {
  const guidance = renderSettingsGuidance({
    baseDomain: "example.com",
    letsEncryptEmail: "admin@example.com",
    adminApiAddr: "localhost:2019",
  });
  assertStringIncludes(guidance, "base domain");
  assertStringIncludes(guidance, "example.com");
  assertStringIncludes(guidance, "admin@example.com");
  assertStringIncludes(guidance, "admin API token");
  assertStringIncludes(guidance, "localhost:2019");
});

Deno.test("renderSettingsGuidance marks unset values", () => {
  const guidance = renderSettingsGuidance({
    baseDomain: "",
    letsEncryptEmail: "",
    adminApiAddr: "localhost:2019",
  });
  assertStringIncludes(guidance, "<not set>");
});

// ---------------------------------------------------------------------------
// Iteration 1: proxy config helpers
// ---------------------------------------------------------------------------

Deno.test("deriveHostname sanitizes and joins service name + base domain", () => {
  assertEquals(
    deriveHostname("my-service", "example.com"),
    "my-service.example.com",
  );
  assertEquals(
    deriveHostname("My Service!", "example.com"),
    "my-service.example.com",
  );
  assertEquals(deriveHostname("foo_bar", "example.com"), "foo-bar.example.com");
});

Deno.test("deriveHostname rejects empty service name and missing base domain", () => {
  let threw = false;
  try {
    deriveHostname("!!!", "example.com");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  threw = false;
  try {
    deriveHostname("foo", "");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseUpstream parses host:port and scheme://host:port", () => {
  assertEquals(parseUpstream("127.0.0.1:8080"), {
    dial: "127.0.0.1:8080",
    https: false,
  });
  assertEquals(parseUpstream("localhost:3000"), {
    dial: "localhost:3000",
    https: false,
  });
  assertEquals(
    parseUpstream("https://127.0.0.1:8443"),
    { dial: "127.0.0.1:8443", https: true },
  );
});

Deno.test("parseUpstream rejects invalid upstreams", () => {
  let threw = false;
  try {
    parseUpstream("not a valid upstream");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildRoute produces a reverse_proxy route with host match", () => {
  const route = buildRoute("foo.example.com", {
    dial: "127.0.0.1:8080",
    https: false,
  });
  assertEquals(route.match, [{ host: ["foo.example.com"] }]);
  const handle = route.handle as Array<Record<string, unknown>>;
  assertEquals(handle[0].handler, "reverse_proxy");
  assertEquals(handle[0].upstreams, [{ dial: "127.0.0.1:8080" }]);
  assertEquals(route.terminal, true);
});

Deno.test("buildRoute adds TLS transport for https upstreams", () => {
  const route = buildRoute("foo.example.com", {
    dial: "127.0.0.1:8443",
    https: true,
  });
  const handle = route.handle as Array<Record<string, unknown>>;
  assertEquals(handle[0].transport, { protocol: "http", tls: {} });
});

Deno.test("addRouteToConfig adds a route and detects conflicts", () => {
  const config = baseConfig();
  const route = buildRoute("foo.example.com", {
    dial: "127.0.0.1:8080",
    https: false,
  });
  const next = addRouteToConfig(config, route);
  assertEquals(findRouteByHost(next, "foo.example.com")?.index, 0);

  // Adding the same hostname again must throw a descriptive conflict error.
  let threw = false;
  try {
    addRouteToConfig(
      next,
      buildRoute("foo.example.com", { dial: "127.0.0.1:9999", https: false }),
    );
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "already in use");
    assertStringIncludes(String(err), "removeProxyService");
  }
  assertEquals(threw, true);
});

Deno.test("removeRouteFromConfig removes a route and is idempotent", () => {
  const config = baseConfig();
  const next = addRouteToConfig(
    config,
    buildRoute("foo.example.com", { dial: "127.0.0.1:8080", https: false }),
  );
  const removed = removeRouteFromConfig(next, "foo.example.com");
  assertEquals(removed.changed, true);
  assertEquals(findRouteByHost(removed.config, "foo.example.com"), null);

  // Removing an already-absent route is a no-op, not an error.
  const again = removeRouteFromConfig(removed.config, "foo.example.com");
  assertEquals(again.changed, false);
  assertEquals(again.config, removed.config);
});

Deno.test("renderDomainConflictError includes guidance", () => {
  const msg = renderDomainConflictError("foo.example.com", {
    handler: "reverse_proxy",
  });
  assertStringIncludes(msg, "foo.example.com");
  assertStringIncludes(msg, "already in use");
  assertStringIncludes(msg, "removeProxyService");
});

Deno.test("listProxyServices extracts services from config", () => {
  const config = baseConfig();
  const next = addRouteToConfig(
    config,
    buildRoute("foo.example.com", { dial: "127.0.0.1:8080", https: false }),
  );
  const services = listProxyServices(next, "example.com");
  assertEquals(services.length, 1);
  assertEquals(services[0].serviceName, "foo");
  assertEquals(services[0].hostname, "foo.example.com");
  assertEquals(services[0].upstream, "127.0.0.1:8080");
});

// ---------------------------------------------------------------------------
// Iteration 2: admin API address + vault config helpers
// ---------------------------------------------------------------------------

Deno.test("parseAdminAddr distinguishes http from unix socket", () => {
  assertEquals(parseAdminAddr("localhost:2019"), { kind: "http" });
  assertEquals(parseAdminAddr("unix//run/user/1000/caddy.sock"), {
    kind: "unix",
    socketPath: "/run/user/1000/caddy.sock",
  });
});

Deno.test("renderAdminConfig returns the listen address", () => {
  assertEquals(renderAdminConfig("localhost:2019"), {
    listen: "localhost:2019",
  });
  assertEquals(renderAdminConfig("unix//run/user/1000/caddy.sock"), {
    listen: "unix//run/user/1000/caddy.sock",
  });
});

Deno.test("validateBaseDomain accepts bare domains and rejects junk", () => {
  validateBaseDomain("example.com"); // no throw
  validateBaseDomain("sub.example.co.uk"); // no throw

  for (const bad of ["", "https://example.com", "example.com/path", "no dot"]) {
    let threw = false;
    try {
      validateBaseDomain(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected '${bad}' to be rejected`);
  }
});

Deno.test("validateEmail accepts valid emails and rejects junk", () => {
  validateEmail("admin@example.com"); // no throw

  for (const bad of ["", "not-an-email", "a@b", "a b@c.com"]) {
    let threw = false;
    try {
      validateEmail(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected '${bad}' to be rejected`);
  }
});

Deno.test("buildCurlArgs builds a unix-socket request with status capture", () => {
  const args = buildCurlArgs(
    "/run/user/1000/caddy.sock",
    "GET",
    "/config/",
  );
  assertEquals(args[0], "--unix-socket");
  assertEquals(args[1], "/run/user/1000/caddy.sock");
  assertStringIncludes(args.join(" "), "-w");
  assertStringIncludes(args.join(" "), "%{http_code}");
  assertStringIncludes(args.join(" "), "http://localhost/config/");
});

Deno.test("buildCurlArgs includes body and bearer token when provided", () => {
  const args = buildCurlArgs(
    "/run/user/1000/caddy.sock",
    "POST",
    "/config/",
    { apps: {} },
    "secret-token",
  );
  const joined = args.join(" ");
  assertStringIncludes(joined, "--data-binary");
  assertStringIncludes(joined, "Authorization: Bearer secret-token");
});

// ---------------------------------------------------------------------------
// Iteration 3: TLS + auto-proxy helpers
// ---------------------------------------------------------------------------

Deno.test("dnsProviderPlugin maps known providers and rejects unknown", () => {
  assertEquals(
    dnsProviderPlugin("cloudflare"),
    "github.com/caddy-dns/cloudflare",
  );
  assertEquals(dnsProviderPlugin("Route53"), "github.com/caddy-dns/route53");

  let threw = false;
  try {
    dnsProviderPlugin("not-a-provider");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("renderTlsAutomation includes email and DNS challenge", () => {
  const tls = renderTlsAutomation({
    email: "admin@example.com",
    dnsProvider: "cloudflare",
    dnsEnvVar: "CF_TOKEN",
    subjects: ["*.example.com", "example.com"],
  });
  const policies = (tls.apps as Record<string, unknown>).tls as Record<
    string,
    unknown
  >;
  const automation = policies.automation as Record<string, unknown>;
  const policyList = automation.policies as Array<Record<string, unknown>>;
  const issuer = (policyList[0].issuers as Array<Record<string, unknown>>)[0];
  assertEquals(issuer.module, "acme");
  assertEquals(issuer.email, "admin@example.com");
  assertEquals(policyList[0].subjects, ["*.example.com", "example.com"]);
  const challenges = issuer.challenges as Record<string, unknown>;
  const dns = challenges.dns as Record<string, unknown>;
  const provider = dns.provider as Record<string, unknown>;
  assertEquals(provider.name, "cloudflare");
  assertEquals(provider.api_token, "{env.CF_TOKEN}");
});

Deno.test("renderTlsAutomation omits DNS challenge when no provider", () => {
  const tls = renderTlsAutomation({ email: "admin@example.com" });
  const policies = (tls.apps as Record<string, unknown>).tls as Record<
    string,
    unknown
  >;
  const automation = policies.automation as Record<string, unknown>;
  const policyList = automation.policies as Array<Record<string, unknown>>;
  const issuer = (policyList[0].issuers as Array<Record<string, unknown>>)[0];
  assertEquals(issuer.challenges, undefined);
});

Deno.test("buildReconciledConfig writes the tls app for a desired TLS config", () => {
  // Regression: mergeTlsConfig returns a clone, so its result must be kept or
  // the tls app (DNS provider + subjects) is silently dropped from the config.
  const config = buildReconciledConfig(baseConfig(), {
    routes: [],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: {
      email: "a@b.com",
      dnsProvider: "gandi",
      dnsEnvVar: "",
      providerConfig: { bearer_token: "GANDI_TOKEN" },
      subjects: ["x1yoga.fi.gy"],
    },
    statusPage: null,
    statusPageModel: "",
    healthRoutes: false,
  });
  const tls = (config.apps as Record<string, unknown>).tls as Record<
    string,
    unknown
  >;
  assert(tls, "apps.tls must be present");
  const automation = tls.automation as Record<string, unknown>;
  const policy = (automation.policies as Array<Record<string, unknown>>)[0];
  assertEquals(policy.subjects, ["x1yoga.fi.gy"]);
  const issuer = (policy.issuers as Array<Record<string, unknown>>)[0];
  const dns = (issuer.challenges as Record<string, unknown>).dns as Record<
    string,
    unknown
  >;
  assertEquals((dns.provider as Record<string, unknown>).name, "gandi");
});

Deno.test("dnsProviderPlugin maps gandi and dreamhost", () => {
  assertEquals(dnsProviderPlugin("gandi"), "github.com/caddy-dns/gandi");
  assertEquals(
    dnsProviderPlugin("DreamHost"),
    "github.com/caddy-dns/dreamhost",
  );
});

Deno.test("renderTlsAutomation uses providerConfig field -> env mappings", () => {
  const tls = renderTlsAutomation({
    email: "admin@example.com",
    dnsProvider: "gandi",
    providerConfig: { bearer_token: "GANDI_TOKEN" },
  });
  const policyList =
    ((tls.apps as Record<string, unknown>).tls as Record<string, unknown>)
      .automation as Record<string, unknown>;
  const issuer = ((policyList.policies as Array<Record<string, unknown>>)[0]
    .issuers as Array<Record<string, unknown>>)[0];
  const provider =
    ((issuer.challenges as Record<string, unknown>).dns as Record<
      string,
      unknown
    >).provider as Record<string, unknown>;
  assertEquals(provider.name, "gandi");
  assertEquals(provider.bearer_token, "{env.GANDI_TOKEN}");
  assertEquals(provider.api_token, undefined);
});

Deno.test("renderTlsAutomation supports multi-field providers (namecheap)", () => {
  const tls = renderTlsAutomation({
    email: "admin@example.com",
    dnsProvider: "namecheap",
    providerConfig: { api_key: "NC_KEY", user: "NC_USER" },
  });
  const policyList =
    ((tls.apps as Record<string, unknown>).tls as Record<string, unknown>)
      .automation as Record<string, unknown>;
  const issuer = ((policyList.policies as Array<Record<string, unknown>>)[0]
    .issuers as Array<Record<string, unknown>>)[0];
  const provider =
    ((issuer.challenges as Record<string, unknown>).dns as Record<
      string,
      unknown
    >).provider as Record<string, unknown>;
  assertEquals(provider.api_key, "{env.NC_KEY}");
  assertEquals(provider.user, "{env.NC_USER}");
});

Deno.test("renderTlsAutomation defaults to api_token when no providerConfig", () => {
  const tls = renderTlsAutomation({
    email: "admin@example.com",
    dnsProvider: "dreamhost",
  });
  const policyList =
    ((tls.apps as Record<string, unknown>).tls as Record<string, unknown>)
      .automation as Record<string, unknown>;
  const issuer = ((policyList.policies as Array<Record<string, unknown>>)[0]
    .issuers as Array<Record<string, unknown>>)[0];
  const provider =
    ((issuer.challenges as Record<string, unknown>).dns as Record<
      string,
      unknown
    >).provider as Record<string, unknown>;
  assertEquals(provider.api_token, "{env.CADDY_DNS_API_TOKEN}");
});

Deno.test("ensureFileServerRoute adds, is idempotent, and updates root", () => {
  const config = baseConfig();
  const added = ensureFileServerRoute(
    config,
    "settings.otel.fi.gy",
    "/srv/otel/current",
  );
  assertEquals(added.changed, true);
  const route = findRouteByHost(added.config, "settings.otel.fi.gy");
  assertEquals(routeFileServerRoot(route!.route), "/srv/otel/current");

  const again = ensureFileServerRoute(
    added.config,
    "settings.otel.fi.gy",
    "/srv/otel/current",
  );
  assertEquals(again.changed, false);

  const moved = ensureFileServerRoute(
    added.config,
    "settings.otel.fi.gy",
    "/srv/otel/v2",
  );
  assertEquals(moved.changed, true);
  assertEquals(
    routeFileServerRoot(
      findRouteByHost(moved.config, "settings.otel.fi.gy")!.route,
    ),
    "/srv/otel/v2",
  );
});

Deno.test("buildFileServerRoute renders a terminal file_server handler", () => {
  const route = buildFileServerRoute("settings.otel.fi.gy", "/srv/otel", true);
  assertEquals(route.terminal, true);
  const handle = route.handle as Array<Record<string, unknown>>;
  assertEquals(handle[0].handler, "file_server");
  assertEquals(handle[0].root, "/srv/otel");
  // browse is an object in Caddy's config, not a bool.
  assertEquals(handle[0].browse, {});

  const noBrowse = buildFileServerRoute("settings.otel.fi.gy", "/srv/otel");
  const nb = noBrowse.handle as Array<Record<string, unknown>>;
  assertEquals(nb[0].browse, undefined);
});

Deno.test("parseGetcap extracts capabilities from getcap output", () => {
  assertEquals(
    parseGetcap("/home/u/.local/bin/caddy cap_net_bind_service=ep"),
    ["cap_net_bind_service=ep"],
  );
  assertEquals(parseGetcap(""), []);
  assertEquals(parseGetcap("/path/to/bin"), []);
});

Deno.test("hasNetBindService detects the capability in any form", () => {
  assertEquals(hasNetBindService(["cap_net_bind_service=ep"]), true);
  assertEquals(hasNetBindService(["cap_net_bind_service+eip"]), true);
  assertEquals(hasNetBindService(["cap_sys_admin=ep"]), false);
  assertEquals(hasNetBindService([]), false);
});

Deno.test("renderSetcapCommand produces the copy-paste sudo command", () => {
  const cmd = renderSetcapCommand("/home/u/.local/bin/caddy");
  assertEquals(
    cmd,
    "sudo setcap 'cap_net_bind_service=+ep' /home/u/.local/bin/caddy",
  );
  assertEquals(PRIVILEGED_PORT_CAPABILITIES, ["cap_net_bind_service=+ep"]);
});

Deno.test("renderPrivilegedPortGuidance explains why and when", () => {
  const text = renderPrivilegedPortGuidance("/home/u/.local/bin/caddy");
  assertStringIncludes(text, "cap_net_bind_service=+ep");
  assertStringIncludes(text, "after every");
  assertStringIncludes(text, "autoHttps=off");
});

Deno.test("setCapabilities method records the command when it cannot apply", async () => {
  let captured: Record<string, unknown> = {};
  const ctx = {
    globalArgs: {
      caddyBinPath: "/nonexistent/caddy",
      adminApiAddr: "localhost:2019",
      configPath: "~/.config/caddy/Caddyfile",
      autoHttps: "on",
      listenAddrs: [":443", ":80"],
      serviceName: "caddy",
      plugins: [],
    },
    logger: { info: () => {} },
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data;
      return Promise.resolve({ name: "capabilities" });
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  await model.methods.setCapabilities.execute({ quiet: true }, ctx);
  assertEquals(typeof captured.command, "string");
  assertStringIncludes(captured.command as string, "sudo setcap");
  assertEquals(captured.applied, false);
});

Deno.test("defaultStatusHostnames is the default for configured names, minus routed", () => {
  const hosts = defaultStatusHostnames({
    tlsSubjects: ["x1yoga.fi.gy", "*.fi.gy"],
    explicit: [],
    routedHostnames: ["app.fi.gy"],
  });
  // Loopback always present; TLS subjects become defaults; a routed host is not.
  assert(hosts.includes("localhost"));
  assert(hosts.includes("127.0.0.1"));
  assert(hosts.includes("x1yoga.fi.gy"));
  assert(hosts.includes("*.fi.gy"));
  assertEquals(hosts.includes("app.fi.gy"), false);
});

Deno.test("defaultStatusHostnames excludes routed hosts even if a TLS subject", () => {
  const hosts = defaultStatusHostnames({
    tlsSubjects: ["app.fi.gy"],
    routedHostnames: ["app.fi.gy"],
  });
  assertEquals(hosts.includes("app.fi.gy"), false);
  assert(hosts.includes("localhost"));
});

Deno.test("statusPageHostnames covers localhost and loopback", () => {
  const hosts = statusPageHostnames();
  assertStringIncludes(hosts.join(","), "localhost");
  assertStringIncludes(hosts.join(","), "127.0.0.1");
});

Deno.test("buildStatusPageRoute is a terminal static_response on localhost", () => {
  const route = buildStatusPageRoute("<html>hi</html>");
  assertEquals(route.terminal, true);
  const match = route.match as Array<Record<string, unknown>>;
  assertEquals((match[0].host as string[]).includes("localhost"), true);
  const handle = route.handle as Array<Record<string, unknown>>;
  assertEquals(handle[0].handler, "static_response");
  assertEquals(handle[0].body, "<html>hi</html>");
  assertEquals(isStatusPageRoute(route), true);
});

Deno.test("ensureStatusPageRoute is idempotent and replaces on change", () => {
  const config = baseConfig();
  const first = ensureStatusPageRoute(config, "<html>v1</html>");
  assertEquals(first.changed, true);
  assertEquals(isStatusPageRoute(getRoutesHelper(first.config)[0]), true);

  const again = ensureStatusPageRoute(first.config, "<html>v1</html>");
  assertEquals(again.changed, false);

  const changed = ensureStatusPageRoute(first.config, "<html>v2</html>");
  assertEquals(changed.changed, true);
  const handle = getRoutesHelper(changed.config)[0].handle as Array<
    Record<string, unknown>
  >;
  assertEquals(handle[0].body, "<html>v2</html>");
});

Deno.test("removeStatusPageRoute removes it and is idempotent", () => {
  const config = ensureStatusPageRoute(baseConfig(), "<html>x</html>").config;
  const removed = removeStatusPageRoute(config);
  assertEquals(removed.changed, true);
  assertEquals(getRoutesHelper(removed.config).length, 0);
  const again = removeStatusPageRoute(removed.config);
  assertEquals(again.changed, false);
});

Deno.test("renderStatusPage includes install facts and links", () => {
  const html = renderStatusPage({
    title: "Caddy",
    version: "v2.11.4",
    adminUrl: "http://localhost:2019/config/",
    baseDomain: "otel.fi.gy",
    email: "admin@example.com",
    capabilities: ["cap_net_bind_service=ep"],
    links: [
      { label: "Admin API", url: "http://localhost:2019/config/" },
      {
        label: "app.otel.fi.gy",
        url: "https://app.otel.fi.gy",
        description: "→ 127.0.0.1:8080",
      },
    ],
  });
  assertStringIncludes(html, "v2.11.4");
  assertStringIncludes(html, "otel.fi.gy");
  assertStringIncludes(html, "admin@example.com");
  assertStringIncludes(html, "CAP_NET_BIND_SERVICE set");
  assertStringIncludes(html, "https://app.otel.fi.gy");
  assertStringIncludes(html, "localhost");
});

Deno.test("renderStatusPage warns when the capability is missing", () => {
  const html = renderStatusPage({
    title: "Caddy",
    version: "v2",
    adminUrl: "",
    baseDomain: "",
    email: "",
    capabilities: [],
    links: [],
  });
  assertStringIncludes(html, "capability not set");
  assertStringIncludes(html, "not set");
});

Deno.test("statusPageLinks derives from routes, excludes status hostnames", () => {
  const links = statusPageLinks({
    routes: [
      {
        hostname: "app.example.com",
        kind: "proxy",
        upstream: "127.0.0.1:8080",
      },
      // The status page's own hostnames must NOT appear as services.
      { hostname: "localhost", kind: "proxy", upstream: "127.0.0.1:1" },
    ],
    statusHostnames: ["localhost", "127.0.0.1", "[::1]"],
    extra: [{ label: "Docs", url: "https://example.com/docs" }],
  });
  const urls = links.map((l) => l.url);
  assertStringIncludes(urls.join(","), "https://app.example.com");
  assertStringIncludes(urls.join(","), "https://example.com/docs");
  assert(!urls.some((u) => u === "https://localhost"), "localhost excluded");
  assertEquals(links.length, 2);
});

Deno.test("adminApiUrlString yields a URL for http and none for unix", () => {
  assertEquals(
    adminApiUrlString("localhost:2019"),
    "http://localhost:2019/config/",
  );
  assertEquals(adminApiUrlString("unix//run/user/1000/caddy.sock"), "");
});

Deno.test("parseModules parses caddy list-modules --json", () => {
  const json = JSON.stringify([
    {
      module_name: "http.handlers.reverse_proxy",
      module_type: "standard",
      version: "v2.11.4",
      package_url: "github.com/caddyserver/caddy/v2",
    },
    {
      module_name: "dns.providers.gandi",
      module_type: "non-standard",
      version: "v1.0.0",
      package_url: "github.com/caddy-dns/gandi",
    },
  ]);
  const modules = parseModules(json);
  assertEquals(modules.length, 2);
  assertEquals(modules[1].name, "dns.providers.gandi");
  assertEquals(modules[1].type, "non-standard");
  assertEquals(modules[1].packagePath, "github.com/caddy-dns/gandi");
  // Invalid JSON / non-array yields [] rather than throwing.
  assertEquals(parseModules("not json"), []);
  assertEquals(parseModules("{}"), []);
});

Deno.test("thirdPartyPlugins groups non-standard modules by package", () => {
  const modules = parseModules(JSON.stringify([
    {
      module_name: "dns.providers.gandi",
      module_type: "non-standard",
      version: "v1.0.0",
      package_url: "github.com/caddy-dns/gandi",
    },
    {
      module_name: "dns.providers.gandi.sub",
      module_type: "non-standard",
      version: "v1.0.0",
      package_url: "github.com/caddy-dns/gandi",
    },
    {
      module_name: "http.handlers.file_server",
      module_type: "standard",
      version: "v2.11.4",
      package_url: "github.com/caddyserver/caddy/v2",
    },
  ]));
  const plugins = thirdPartyPlugins(modules);
  assertEquals(plugins.length, 1);
  assertEquals(plugins[0].packagePath, "github.com/caddy-dns/gandi");
  assertEquals(plugins[0].modules.sort(), [
    "dns.providers.gandi",
    "dns.providers.gandi.sub",
  ]);
  assertEquals(thirdPartyPlugins([]), []);
});

Deno.test("configuredListens extracts and dedupes server listen addresses", () => {
  const config = baseConfig([":443", ":80"]);
  assertEquals(configuredListens(config), [":443", ":80"]);
  assertEquals(configuredListens({}), []);
  // Multiple servers merge and dedupe.
  const multi = {
    apps: {
      http: {
        servers: {
          a: { listen: [":443", ":80"] },
          b: { listen: [":80", ":8080"] },
        },
      },
    },
  };
  assertEquals(configuredListens(multi), [":443", ":80", ":8080"]);
});

Deno.test("renderStatusPage shows what Caddy is listening on", () => {
  const html = renderStatusPage({
    title: "Caddy",
    version: "v2.11.4",
    adminUrl: "http://localhost:2019/config/",
    baseDomain: "otel.fi.gy",
    email: "admin@example.com",
    capabilities: ["cap_net_bind_service=ep"],
    links: [],
    modules: [],
    listens: [":443", ":80"],
  });
  assertStringIncludes(html, "Listening on");
  assertStringIncludes(html, "<code>:443</code>");
  assertStringIncludes(html, "<code>:80</code>");

  const none = renderStatusPage({
    title: "Caddy",
    version: "v2",
    adminUrl: "",
    baseDomain: "",
    email: "",
    capabilities: [],
    links: [],
    modules: [],
    listens: [],
  });
  assertStringIncludes(none, "Nothing — no server addresses are configured");
});

Deno.test("renderStatusPage always shows a Routes & services section", () => {
  const empty = renderStatusPage({
    title: "Caddy",
    version: "v2",
    adminUrl: "",
    baseDomain: "",
    email: "",
    capabilities: [],
    links: [],
    modules: [],
    listens: [],
  });
  // The section is present even with no routes, with guidance.
  assertStringIncludes(empty, "Routes &amp; services");
  assertStringIncludes(empty, "No routes are managed by swamp models yet");

  const withLinks = renderStatusPage({
    title: "Caddy",
    version: "v2",
    adminUrl: "",
    baseDomain: "",
    email: "",
    capabilities: [],
    links: [{ label: "app.example.com", url: "https://app.example.com" }],
    modules: [],
    listens: [":443"],
  });
  assertStringIncludes(withLinks, "https://app.example.com");
  assert(!withLinks.includes("No routes are managed"));
});

Deno.test("renderStatusPage lists compiled-in plugins or says stock", () => {
  const withPlugins = renderStatusPage({
    title: "Caddy",
    version: "v2.11.4",
    adminUrl: "http://localhost:2019/config/",
    baseDomain: "",
    email: "",
    capabilities: [],
    links: [],
    modules: parseModules(JSON.stringify([
      {
        module_name: "dns.providers.gandi",
        module_type: "non-standard",
        version: "v1.0.0",
        package_url: "github.com/caddy-dns/gandi",
      },
    ])),
  });
  assertStringIncludes(withPlugins, "Compiled-in plugins");
  assertStringIncludes(withPlugins, "github.com/caddy-dns/gandi");
  assertStringIncludes(withPlugins, "dns.providers.gandi");

  const stock = renderStatusPage({
    title: "Caddy",
    version: "v2.11.4",
    adminUrl: "",
    baseDomain: "",
    email: "",
    capabilities: [],
    links: [],
    modules: parseModules(JSON.stringify([
      {
        module_name: "http.handlers.file_server",
        module_type: "standard",
        version: "v2.11.4",
        package_url: "github.com/caddyserver/caddy/v2",
      },
    ])),
  });
  assertStringIncludes(stock, "stock Caddy binary");
});

// Helper: read the routes array out of a config for assertions.
function getRoutesHelper(
  config: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const apps = config.apps as Record<string, unknown>;
  const http = apps.http as Record<string, unknown>;
  const servers = http.servers as Record<string, unknown>;
  const srv0 = servers.srv0 as Record<string, unknown>;
  return (srv0.routes as Array<Record<string, unknown>>) ?? [];
}

Deno.test("mergeTlsConfig replaces the tls app in a config", () => {
  const config = baseConfig();
  const tls = renderTlsAutomation({ email: "admin@example.com" });
  const merged = mergeTlsConfig(config, tls);
  const apps = merged.apps as Record<string, unknown>;
  assertEquals(apps.tls, (tls.apps as Record<string, unknown>).tls);
  // http app is preserved
  assertEquals(apps.http, (config.apps as Record<string, unknown>).http);
});

Deno.test("detectSwampServeServices filters and strips the prefix", () => {
  const units = [
    "swamp-serve-news.service",
    "swamp-serve-blog.service",
    "caddy.service",
    "other.service",
  ];
  assertEquals(detectSwampServeServices(units, "swamp-serve-"), [
    "news",
    "blog",
  ]);
});

Deno.test("reconcileProxyServices computes ensure/remove diff", () => {
  const config = baseConfig();
  const existing = addRouteToConfig(
    config,
    buildRoute("old.example.com", { dial: "127.0.0.1:3080", https: false }),
  );
  const desired = [
    {
      serviceName: "news",
      hostname: "news.example.com",
      upstream: "127.0.0.1:3080",
    },
  ];
  const { toEnsure, toRemove } = reconcileProxyServices(
    desired,
    existing,
    "example.com",
  );
  assertEquals(toEnsure, [
    { hostname: "news.example.com", upstream: "127.0.0.1:3080" },
  ]);
  assertEquals(toRemove, ["old.example.com"]);
});

// ---------------------------------------------------------------------------
// Iteration 4: upgrade + health helpers
// ---------------------------------------------------------------------------

Deno.test("renderUpgradeConfirmation includes packages and confirm hint", () => {
  const msg = renderUpgradeConfirmation({
    plugins: ["github.com/caddy-dns/cloudflare"],
  });
  assertStringIncludes(msg, "confirm=upgrade");
  assertStringIncludes(msg, "github.com/caddy-dns/cloudflare");
  assertStringIncludes(msg, "preserved");
});

Deno.test("computeHealth reports healthy only when both checks pass", () => {
  assertEquals(computeHealth(true, true), { healthy: true, status: "healthy" });
  assertEquals(computeHealth(false, false), { healthy: false, status: "down" });
  assertEquals(computeHealth(false, true), {
    healthy: false,
    status: "service-not-active",
  });
  assertEquals(computeHealth(true, false), {
    healthy: false,
    status: "admin-api-unreachable",
  });
});

// ---------------------------------------------------------------------------
// Desired-state proxy helpers
// ---------------------------------------------------------------------------

Deno.test("routeUpstream extracts the dial address from a route", () => {
  const route = buildRoute("foo.example.com", {
    dial: "127.0.0.1:8080",
    https: false,
  });
  assertEquals(routeUpstream(route), "127.0.0.1:8080");
  assertEquals(routeUpstream({}), "");
});

/** Build a minimal DesiredState for merge tests. */
function desired(
  modelName: string,
  over: Partial<Record<string, unknown>> = {},
): Parameters<typeof mergeDesired>[0][number] {
  return {
    modelName,
    target: "host-a",
    serviceName: "caddy",
    baseDomain: "example.com",
    autoHttps: "on",
    listenAddrs: [":443", ":80"],
    routes: [],
    tls: null,
    statusPage: null,
    updatedAt: "now",
    ...over,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("caddyTargetKey merges same host+service and separates others", () => {
  assertEquals(
    caddyTargetKey("host-a", "caddy"),
    caddyTargetKey("host-a", "caddy"),
  );
  assert(
    caddyTargetKey("host-a", "caddy") !== caddyTargetKey("host-b", "caddy"),
  );
  assert(
    caddyTargetKey("host-a", "caddy") !== caddyTargetKey("host-a", "caddy-2"),
  );
});

Deno.test("mergeDesired unions routes from several models", () => {
  const { merged, errors } = mergeDesired([
    desired("a", {
      routes: [{
        hostname: "a.example.com",
        kind: "proxy",
        upstream: "127.0.0.1:8080",
        root: "",
        browse: false,
      }],
    }),
    desired("b", {
      routes: [{
        hostname: "b.example.com",
        kind: "proxy",
        upstream: "127.0.0.1:9090",
        root: "",
        browse: false,
      }],
    }),
  ]);
  assertEquals(errors, []);
  assertEquals(merged.routes.map((r) => r.hostname), [
    "a.example.com",
    "b.example.com",
  ]);
  assertEquals(merged.models.sort(), ["a", "b"]);
});

Deno.test("mergeDesired errors on a real route conflict", () => {
  const { errors } = mergeDesired([
    desired("a", {
      routes: [{
        hostname: "x.example.com",
        kind: "proxy",
        upstream: "127.0.0.1:1",
        root: "",
        browse: false,
      }],
    }),
    desired("b", {
      routes: [{
        hostname: "x.example.com",
        kind: "proxy",
        upstream: "127.0.0.1:2",
        root: "",
        browse: false,
      }],
    }),
  ]);
  assert(
    errors.some((e) =>
      e.includes("route conflict") && e.includes("x.example.com")
    ),
  );
});

Deno.test("mergeDesired errors on differing TLS email or provider", () => {
  const { errors } = mergeDesired([
    desired("a", {
      tls: {
        email: "a@x.com",
        dnsProvider: "gandi",
        dnsEnvVar: "",
        providerConfig: {},
        subjects: ["*.example.com"],
      },
    }),
    desired("b", {
      tls: {
        email: "b@x.com",
        dnsProvider: "gandi",
        dnsEnvVar: "",
        providerConfig: {},
        subjects: ["example.com"],
      },
    }),
  ]);
  assert(errors.some((e) => e.includes("TLS email conflict")));
});

Deno.test("mergeDesired unions TLS subjects and picks one status page", () => {
  const { merged, errors } = mergeDesired([
    desired("a", {
      tls: {
        email: "x@e.com",
        dnsProvider: "gandi",
        dnsEnvVar: "G",
        providerConfig: {},
        subjects: ["*.example.com"],
      },
    }),
    desired("b", {
      tls: {
        email: "x@e.com",
        dnsProvider: "gandi",
        dnsEnvVar: "G",
        providerConfig: {},
        subjects: ["example.com"],
      },
    }),
    desired("a", {
      statusPage: {
        enabled: true,
        title: "A",
        html: "<h1>A</h1>",
        hostnames: ["localhost"],
        links: [],
      },
    }),
    desired("b", {
      statusPage: {
        enabled: true,
        title: "B",
        html: "<h1>B</h1>",
        hostnames: ["localhost"],
        links: [],
      },
    }),
  ]);
  assertEquals(errors, []);
  assertEquals(merged.tls!.subjects, ["*.example.com", "example.com"]);
  assertEquals(merged.statusPage!.title, "A");
});

Deno.test("buildReconciledConfig tags swamp routes and preserves foreign ones", () => {
  // A hand-added (untagged) route must survive reconcile.
  const current = addRouteToConfig(
    baseConfig(),
    buildRoute("manual.example.com", { dial: "127.0.0.1:1", https: false }),
  );
  const config = buildReconciledConfig(current, {
    routes: [{
      hostname: "app.example.com",
      kind: "proxy",
      upstream: "127.0.0.1:8080",
      root: "",
      browse: false,
      model: "a",
    }],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: null,
    statusPage: null,
    statusPageModel: "",
  });
  const hosts = getRoutesHelper(config).flatMap((r) =>
    (r.match as Array<{ host: string[] }>).flatMap((m) => m.host)
  );
  assert(hosts.includes("manual.example.com"));
  assert(hosts.includes("app.example.com"));
  const swampRoute = getRoutesHelper(config).find((r) => isSwampRoute(r))!;
  assertEquals(swampRoute["@id"], routeId("a", "app.example.com"));
});

Deno.test("buildReconciledConfig replaces prior swamp routes, keeps foreign", () => {
  // First reconcile wrote a swamp route; second reconcile must not duplicate it.
  const first = buildReconciledConfig(baseConfig(), {
    routes: [{
      hostname: "app.example.com",
      kind: "proxy",
      upstream: "127.0.0.1:8080",
      root: "",
      browse: false,
      model: "a",
    }],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: null,
    statusPage: null,
    statusPageModel: "",
  });
  const withManual = addRouteToConfig(
    first,
    buildRoute("manual.example.com", { dial: "127.0.0.1:1", https: false }),
  );
  const second = buildReconciledConfig(withManual, {
    routes: [{
      hostname: "new.example.com",
      kind: "proxy",
      upstream: "127.0.0.1:9090",
      root: "",
      browse: false,
      model: "b",
    }],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: null,
    statusPage: null,
    statusPageModel: "",
    healthRoutes: false,
  });
  const ids = getRoutesHelper(second).map((r) => r["@id"]).filter(Boolean);
  assertEquals(ids, [routeId("b", "new.example.com")]);
  const hosts = getRoutesHelper(second).flatMap((r) =>
    (r.match as Array<{ host: string[] }>).flatMap((m) => m.host)
  );
  assert(hosts.includes("manual.example.com"));
});

Deno.test("diffRoutes reports drift between desired and actual", () => {
  // Build an actual config with one swamp route + one foreign route.
  let actual = buildReconciledConfig(baseConfig(), {
    routes: [{
      hostname: "a.example.com",
      kind: "proxy",
      upstream: "127.0.0.1:8080",
      root: "",
      browse: false,
      model: "m",
    }],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: null,
    statusPage: null,
    statusPageModel: "",
  });
  actual = addRouteToConfig(
    actual,
    buildRoute("manual.example.com", { dial: "127.0.0.1:1", https: false }),
  );

  // Desired has a different route (b), missing the actual a.
  const diff = diffRoutes(
    [{
      hostname: "b.example.com",
      kind: "proxy",
      upstream: "127.0.0.1:9090",
      root: "",
      model: "m",
    }],
    actual,
  );
  assertEquals(diff.onlyDesired, ["b.example.com"]);
  assertEquals(diff.onlyActual, ["a.example.com"]);
  assertEquals(diff.foreignRoutes, ["manual.example.com"]);
  assertEquals(diff.inSync, false);
});

Deno.test("diffRoutes reports in-sync when desired matches actual", () => {
  const actual = buildReconciledConfig(baseConfig(), {
    routes: [{
      hostname: "a.example.com",
      kind: "proxy",
      upstream: "127.0.0.1:8080",
      root: "",
      browse: false,
      model: "m",
    }],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: null,
    statusPage: null,
    statusPageModel: "",
  });
  const diff = diffRoutes(
    [{
      hostname: "a.example.com",
      kind: "proxy",
      upstream: "127.0.0.1:8080",
      root: "",
      model: "m",
    }],
    actual,
  );
  assertEquals(diff.onlyDesired, []);
  assertEquals(diff.onlyActual, []);
  assertEquals(diff.inSync, true);
});

Deno.test("liveTlsInfo reads subjects and DNS challenge from a caddy config", () => {
  const empty = liveTlsInfo(baseConfig());
  assertEquals(empty.subjects, []);
  assertEquals(empty.hasDnsChallenge, false);
  assertEquals(empty.dnsProvider, "");

  const withTls = liveTlsInfo(
    mergeTlsConfig(
      baseConfig(),
      renderTlsAutomation({
        email: "a@b.com",
        dnsProvider: "gandi",
        providerConfig: { bearer_token: "GANDI_BEARER_TOKEN" },
        subjects: ["*.example.com", "example.com"],
      }),
    ),
  );
  assertEquals(withTls.subjects, ["*.example.com", "example.com"]);
  assertEquals(withTls.hasDnsChallenge, true);
  assertEquals(withTls.dnsProvider, "gandi");
});

Deno.test("renderNextCommands tells the user the unmerged/merged/actual steps", () => {
  const cmds = renderNextCommands({
    runModel: "scratch",
    models: ["otel-caddy", "caddy-web"],
    adminApiAddr: "localhost:2019",
    listenAddrs: [":443", ":80"],
  });
  assertStringIncludes(cmds, "swamp data get otel-caddy desired");
  assertStringIncludes(cmds, "swamp data get caddy-web desired");
  assertStringIncludes(cmds, "swamp data get scratch plan");
  assertStringIncludes(cmds, "curl -s localhost:2019/config/");
  assertStringIncludes(cmds, "diff -u");
});

Deno.test("routeHostnames extracts match hosts", () => {
  assertEquals(
    routeHostnames(
      buildRoute("x.example.com", { dial: "127.0.0.1:1", https: false }),
    ),
    ["x.example.com"],
  );
});

Deno.test("ensureRoute adds a missing route", () => {
  const config = baseConfig();
  const { config: next, changed } = ensureRoute(
    config,
    "foo.example.com",
    { dial: "127.0.0.1:8080", https: false },
  );
  assertEquals(changed, true);
  assertEquals(findRouteByHost(next, "foo.example.com")?.index, 0);
});

Deno.test("ensureRoute is a no-op when the upstream already matches", () => {
  const config = baseConfig();
  const added = addRouteToConfig(
    config,
    buildRoute("foo.example.com", { dial: "127.0.0.1:8080", https: false }),
  );
  const { config: next, changed } = ensureRoute(
    added,
    "foo.example.com",
    { dial: "127.0.0.1:8080", https: false },
  );
  assertEquals(changed, false);
  assertEquals(next, added);
});

Deno.test("ensureRoute updates the route when the upstream changed", () => {
  const config = baseConfig();
  const added = addRouteToConfig(
    config,
    buildRoute("foo.example.com", { dial: "127.0.0.1:8080", https: false }),
  );
  const { config: next, changed } = ensureRoute(
    added,
    "foo.example.com",
    { dial: "127.0.0.1:9999", https: false },
  );
  assertEquals(changed, true);
  const route = findRouteByHost(next, "foo.example.com")?.route;
  assertEquals(routeUpstream(route ?? {}), "127.0.0.1:9999");
});

// ---------------------------------------------------------------------------
// Method-level tests (execute functions, with mocked fetch/command)
// ---------------------------------------------------------------------------

import {
  createModelTestContext,
  withMockedCommand,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";

// deno-lint-ignore no-explicit-any
async function runMethod(name: string, opts: any = {}) {
  const ctx = createModelTestContext({
    globalArgs: checkArgs(opts.globalArgs ?? {}),
    methodName: name,
    storedResources: opts.storedResources ?? {},
  });
  // deno-lint-ignore no-explicit-any
  const result = await (model.methods as any)[name].execute(
    opts.args ?? {},
    // deno-lint-ignore no-explicit-any
    ctx.context as any,
  );
  return { result, ctx };
}

Deno.test("settingsGuidance writes the guidance resource", async () => {
  const { ctx } = await runMethod("settingsGuidance", {
    globalArgs: {
      baseDomain: "example.com",
      letsEncryptEmail: "admin@example.com",
    },
  });
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "guidance");
  assertEquals(written[0].data.baseDomain, "example.com");
  assertStringIncludes(String(written[0].data.guidance), "example.com");
});

Deno.test("syncConfig snapshots global args into the config resource", async () => {
  const { ctx } = await runMethod("syncConfig", {
    globalArgs: {
      baseDomain: "example.com",
      letsEncryptEmail: "admin@example.com",
      vaultName: "caddy-secrets",
    },
  });
  const written = ctx.getWrittenResources();
  assertEquals(written[0].specName, "config");
  assertEquals(written[0].data.baseDomain, "example.com");
  assertEquals(written[0].data.vaultName, "caddy-secrets");
});

Deno.test("getConfig throws when no config has been stored", async () => {
  let threw = false;
  try {
    await runMethod("getConfig");
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "No stored config");
  }
  assertEquals(threw, true);
});

Deno.test("getConfig reads back the stored config", async () => {
  const { ctx } = await runMethod("getConfig", {
    storedResources: {
      config: {
        baseDomain: "example.com",
        letsEncryptEmail: "admin@example.com",
        adminApiAddr: "localhost:2019",
        adminApiTokenSet: true,
        vaultName: "caddy-secrets",
      },
    },
  });
  const written = ctx.getWrittenResources();
  assertEquals(written[0].specName, "config");
  assertEquals(written[0].data.baseDomain, "example.com");
  assertEquals(written[0].data.adminApiTokenSet, true);
});

Deno.test("storeConfig throws when no vault name is configured", async () => {
  let threw = false;
  try {
    await runMethod("storeConfig", {
      args: { baseDomain: "example.com" },
    });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "vaultName is required");
  }
  assertEquals(threw, true);
});

Deno.test("storeConfig rejects a too-short admin API token", async () => {
  let threw = false;
  try {
    await runMethod("storeConfig", {
      globalArgs: { vaultName: "caddy-secrets" },
      args: { adminApiToken: "short" },
    });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "at least 8 characters");
  }
  assertEquals(threw, true);
});

Deno.test("storeConfig rejects an empty request", async () => {
  let threw = false;
  try {
    await runMethod("storeConfig", {
      globalArgs: { vaultName: "caddy-secrets" },
    });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "Nothing to store");
  }
  assertEquals(threw, true);
});

Deno.test("ensureDnsProxy adds a route via the admin API", async () => {
  const { result } = await withMockedFetch((req) => {
    if (req.method === "GET") {
      return new Response("not found", { status: 404 });
    }
    return new Response("{}", { status: 200 });
  }, () =>
    runMethod("ensureDnsProxy", {
      args: { hostname: "foo.example.com", upstream: "127.0.0.1:8080" },
    }));
  const written = result.ctx.getWrittenResources();
  const ensure = written.find((w) => w.specName === "ensureProxy")!;
  assertEquals(ensure.data.changed, true);
  assertEquals(ensure.data.upstream, "127.0.0.1:8080");
  // It also records desired state and applies the merged config.
  assert(written.some((w) => w.specName === "desired"));
  assert(written.some((w) => w.specName === "reconcile"));
});

Deno.test("removeProxyService is a no-op when the route is already gone", async () => {
  const { result } = await withMockedCommand([
    { stdout: "inactive", stderr: "", code: 3 },
  ], () =>
    withMockedFetch((req) => {
      if (req.method === "GET") {
        // Empty base config — the route to remove does not exist.
        return Response.json({ apps: { http: { servers: { srv0: {} } } } });
      }
      return new Response("{}", { status: 200 });
    }, () =>
      runMethod("removeProxyService", {
        globalArgs: { baseDomain: "example.com" },
        args: { serviceName: "my-app" },
      })));
  const written = result.result.ctx.getWrittenResources();
  const services = written.find((w) => w.specName === "proxyServices")!;
  // No route was present, so nothing was removed.
  // deno-lint-ignore no-explicit-any
  assertEquals((services.data.services as any[]).length, 0);
});

// ---------------------------------------------------------------------------
// Default plugins
// ---------------------------------------------------------------------------

Deno.test("withDefaultPlugins always adds caddy-host-dns and teapot", () => {
  const merged = withDefaultPlugins(["github.com/caddy-dns/gandi"]);
  assert(merged.includes("github.com/SvenDowideit/caddy-host-dns"));
  assert(merged.includes("github.com/hairyhenderson/caddy-teapot-module"));
  assert(merged.includes("github.com/caddy-dns/gandi"));
  assertEquals(DEFAULT_CADDY_PLUGINS.length, 2);
});

Deno.test("withDefaultPlugins lets a pinned user entry win over the default", () => {
  const merged = withDefaultPlugins([
    "github.com/hairyhenderson/caddy-teapot-module@v0.0.2",
  ]);
  const hits = merged.filter((p) =>
    p.startsWith("github.com/hairyhenderson/caddy-teapot-module")
  );
  assertEquals(hits, ["github.com/hairyhenderson/caddy-teapot-module@v0.0.2"]);
});

Deno.test("withDefaultPlugins does not duplicate a user-provided default", () => {
  const merged = withDefaultPlugins(["github.com/SvenDowideit/caddy-host-dns"]);
  assertEquals(
    merged.filter((p) => p === "github.com/SvenDowideit/caddy-host-dns").length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Health contract: / -> status page, /teapot -> 418, other -> 404
// ---------------------------------------------------------------------------

Deno.test("buildStatusPageRoute matches only the root path", () => {
  const route = buildStatusPageRoute("<html></html>", ["localhost"]);
  assertEquals((route.match as Array<{ path: string[] }>)[0].path, ["/"]);
});

Deno.test("buildHealthRoutes yields teapot then notfound", () => {
  const routes = buildHealthRoutes(["localhost", "app.example.com"], "m");
  assertEquals(routes.length, 2);
  const [teapot, notfound] = routes;
  assertEquals(
    (teapot.match as Array<{ path: string[] }>)[0].path,
    ["/teapot"],
  );
  assertEquals(
    (teapot.handle as Array<{ handler: string }>)[0].handler,
    "teapot",
  );
  // The fallback matches the host with no path constraint and returns 404.
  assertEquals(
    (notfound.handle as Array<{ status_code: number }>)[0].status_code,
    404,
  );
  assertEquals(
    (notfound.match as Array<Record<string, unknown>>)[0].path,
    undefined,
  );
  assert(isHealthRoute(teapot));
  assert(isHealthRoute(notfound));
  assert(isGeneratedRoute(teapot));
});

Deno.test("buildHealthRoutes is empty when there are no hostnames", () => {
  assertEquals(buildHealthRoutes([], "m"), []);
});

Deno.test("buildReconciledConfig orders status page before health routes", () => {
  const config = buildReconciledConfig(baseConfig(), {
    routes: [],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: null,
    statusPage: {
      enabled: true,
      title: "Caddy",
      hostnames: [],
      extraLinks: [],
      version: "",
      adminUrl: "",
      baseDomain: "",
      email: "",
      capabilities: [],
      plugins: [],
      links: [],
    },
    statusPageModel: "m",
    healthRoutes: true,
  });
  const handlers = getRoutesHelper(config).map(
    (r) => (r.handle as Array<{ handler: string }>)[0].handler,
  );
  // static_response (status page) must come before teapot and the 404 fallback.
  const status = handlers.indexOf("static_response");
  const teapot = handlers.indexOf("teapot");
  const notfound = handlers.lastIndexOf("static_response");
  assert(status >= 0 && teapot > status && notfound > teapot);
});

Deno.test("isGeneratedRoute excludes status and health routes from the diff", () => {
  const route = buildStatusPageRoute("<html></html>", ["localhost"]);
  route["@id"] = routeId("m", "status");
  assert(isGeneratedRoute(route));
  for (const r of buildHealthRoutes(["localhost"], "m")) {
    assert(isGeneratedRoute(r));
  }
  assert(
    !isGeneratedRoute(buildRoute("h", { dial: "127.0.0.1:1", https: false })),
  );
});

// ---------------------------------------------------------------------------
// Static DNS records (dns_records)
// ---------------------------------------------------------------------------

const exampleTls = {
  email: "a@b.com",
  dnsProvider: "gandi",
  dnsEnvVar: "",
  providerConfig: { bearer_token: "GANDI_TOKEN" },
  subjects: [],
};

Deno.test("writeDnsRecords emits the dns_records app with a provider block", () => {
  const config = baseConfig();
  writeDnsRecords(
    config,
    exampleTls,
    [{
      name: "otel.fi.gy",
      type: "A",
      value: ["10.10.0.5"],
      zone: "fi.gy",
      ttl: "5m",
    }],
    [{ name: "old.fi.gy", type: "A", value: [], zone: "" }],
  );
  // deno-lint-ignore no-explicit-any
  const dr = (config.apps as any).dns_records;
  assertEquals(dr.providers.length, 1);
  assertEquals(dr.providers[0].dns_provider, {
    name: "gandi",
    bearer_token: "{env.GANDI_TOKEN}",
  });
  assertEquals(dr.providers[0].records, [{
    name: "otel.fi.gy",
    type: "A",
    value: ["10.10.0.5"],
    zone: "fi.gy",
    ttl: "5m",
  }]);
  assertEquals(dr.providers[0].remove, [{ name: "old.fi.gy", type: "A" }]);
});

Deno.test("writeDnsRecords emits a default TTL when given one", () => {
  const config = baseConfig();
  writeDnsRecords(
    config,
    exampleTls,
    [{
      name: "a.fi.gy",
      type: "A",
      value: ["10.0.0.1"],
      zone: "fi.gy",
      ttl: "",
    }],
    [],
    "5m",
  );
  // deno-lint-ignore no-explicit-any
  const dr = (config.apps as any).dns_records;
  assertEquals(dr.ttl, "5m");
  // A per-record ttl still takes precedence (the module applies record ttl first).
  assertEquals(dr.providers[0].records[0].ttl, undefined);
});

Deno.test("buildReconciledConfig defaults dnsRecords TTL to 5m", () => {
  const config = buildReconciledConfig(baseConfig(), {
    routes: [],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: exampleTls,
    statusPage: null,
    statusPageModel: "",
    dnsRecords: [{
      name: "otel.fi.gy",
      type: "A",
      value: ["10.10.0.5"],
      zone: "fi.gy",
      ttl: "",
    }],
    dnsRemovals: [],
    dnsTtl: "5m",
    healthRoutes: false,
  });
  // deno-lint-ignore no-explicit-any
  assertEquals((config.apps as any).dns_records.ttl, "5m");
});

Deno.test("writeDnsRecords requires a DNS provider", () => {
  let threw = false;
  try {
    writeDnsRecords(baseConfig(), null, [{
      name: "a.fi.gy",
      type: "A",
      value: ["10.0.0.1"],
      zone: "",
      ttl: "",
    }], []);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("buildReconciledConfig writes dns_records only when records exist", () => {
  const withRecords = buildReconciledConfig(baseConfig(), {
    routes: [],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: exampleTls,
    statusPage: null,
    statusPageModel: "",
    dnsRecords: [{
      name: "otel.fi.gy",
      type: "A",
      value: ["10.10.0.5"],
      zone: "",
      ttl: "",
    }],
    dnsRemovals: [],
    healthRoutes: false,
  });
  // deno-lint-ignore no-explicit-any
  assert((withRecords.apps as any).dns_records);

  // A config that previously had dns_records but no longer declares any is
  // cleaned up, so Caddy does not keep reconciling stale records.
  const cleaned = buildReconciledConfig(withRecords, {
    routes: [],
    listenAddrs: [":443", ":80"],
    autoHttps: "on",
    tls: exampleTls,
    statusPage: null,
    statusPageModel: "",
    dnsRecords: [],
    dnsRemovals: [],
    healthRoutes: false,
  });
  // deno-lint-ignore no-explicit-any
  assertEquals((cleaned.apps as any).dns_records, undefined);
});

Deno.test("mergeDesired unions DNS records and errors on value conflicts", () => {
  const base = {
    target: "h",
    serviceName: "caddy",
    adminApiAddr: "localhost:2019",
    baseDomain: "",
    autoHttps: "on",
    listenAddrs: [":443"],
    plugins: [],
    environmentFile: "",
    caddyBinPath: "~/.local/bin/caddy",
    routes: [],
    tls: null,
    statusPage: null,
    dnsRecords: [],
    dnsRemovals: [],
    dnsTtl: "5m",
    healthRoutes: true,
    updatedAt: "",
  };
  const rec = (value: string) => ({
    name: "otel.fi.gy",
    type: "A" as const,
    value: [value],
    zone: "",
    ttl: "",
  });
  // Identical records from two models dedupe.
  const same = mergeDesired([
    { ...base, modelName: "a", dnsRecords: [rec("10.0.0.1")] },
    { ...base, modelName: "b", dnsRecords: [rec("10.0.0.1")] },
  ]);
  assertEquals(same.errors, []);
  assertEquals(same.merged.dnsRecords.length, 1);

  // Different values for the same (name, type) is a conflict naming both models.
  const diff = mergeDesired([
    { ...base, modelName: "a", dnsRecords: [rec("10.0.0.1")] },
    { ...base, modelName: "b", dnsRecords: [rec("10.0.0.2")] },
  ]);
  assertEquals(diff.errors.length, 1);
  assertStringIncludes(diff.errors[0], "a");
  assertStringIncludes(diff.errors[0], "b");
});

Deno.test("mergeDesired errors when a record is both declared and removed", () => {
  const base = {
    target: "h",
    serviceName: "caddy",
    adminApiAddr: "localhost:2019",
    baseDomain: "",
    autoHttps: "on",
    listenAddrs: [":443"],
    plugins: [],
    environmentFile: "",
    caddyBinPath: "~/.local/bin/caddy",
    routes: [],
    tls: null,
    statusPage: null,
    dnsRecords: [{
      name: "otel.fi.gy",
      type: "A" as const,
      value: ["10.0.0.1"],
      zone: "",
      ttl: "",
    }],
    dnsRemovals: [],
    dnsTtl: "5m",
    healthRoutes: true,
    updatedAt: "",
  };
  const { errors } = mergeDesired([
    { ...base, modelName: "a" },
    {
      ...base,
      modelName: "b",
      dnsRecords: [],
      dnsRemovals: [{
        name: "otel.fi.gy",
        type: "A" as const,
        value: [],
        zone: "",
      }],
    },
  ]);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "otel.fi.gy");
});

// ---------------------------------------------------------------------------
// Stale-binary detection (installCaddy must rebuild when modules are missing)
// ---------------------------------------------------------------------------

Deno.test("missingPlugins reports wanted packages not compiled in", () => {
  const compiled = [
    "github.com/caddyserver/caddy/v2",
    "github.com/caddy-dns/gandi",
  ];
  assertEquals(missingPlugins(["github.com/caddy-dns/gandi"], compiled), []);
  // The two built-in defaults are absent from this binary.
  assertEquals(
    missingPlugins([
      "github.com/SvenDowideit/caddy-host-dns",
      "github.com/hairyhenderson/caddy-teapot-module",
      "github.com/caddy-dns/gandi",
    ], compiled),
    [
      "github.com/SvenDowideit/caddy-host-dns",
      "github.com/hairyhenderson/caddy-teapot-module",
    ],
  );
});

Deno.test("missingPlugins matches a pinned entry on its bare package path", () => {
  const compiled = ["github.com/caddy-dns/gandi"];
  assertEquals(
    missingPlugins(["github.com/caddy-dns/gandi@v0.2.4"], compiled),
    [],
  );
});

Deno.test("missingPlugins treats a subpackage as present", () => {
  // caddy-host-dns registers from its dnsrec subpackage; a prefix match counts.
  assertEquals(
    missingPlugins(
      ["github.com/SvenDowideit/caddy-host-dns"],
      ["github.com/SvenDowideit/caddy-host-dns/dnsrec"],
    ),
    [],
  );
});

Deno.test("requiredCaddyModules lists handler modules used by a config", () => {
  const config: Record<string, unknown> = {
    apps: {
      http: {
        servers: {
          srv0: {
            routes: [
              {
                match: [{ host: ["localhost"], path: ["/teapot"] }],
                handle: [{ handler: "teapot" }],
              },
              {
                match: [{ host: ["localhost"] }],
                handle: [{ handler: "static_response", status_code: 404 }],
              },
            ],
          },
        },
      },
    },
  };
  assertEquals(requiredCaddyModules(config), [
    "http.handlers.static_response",
    "http.handlers.teapot",
  ]);
});

Deno.test("requiredCaddyModules includes the dns_records app", () => {
  const config = baseConfig();
  (config.apps as Record<string, unknown>).dns_records = { providers: [] };
  assert(
    requiredCaddyModules(config).includes("dns_records"),
  );
});
