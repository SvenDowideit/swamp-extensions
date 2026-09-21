import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  addRouteToConfig,
  automaticHttpsConfig,
  baseConfig,
  buildCurlArgs,
  buildRoute,
  caddyArch,
  caddyDownloadUrl,
  computeHealth,
  deriveHostname,
  detectSwampServeServices,
  dnsProviderPlugin,
  ensureRoute,
  ensureServerDefaults,
  expandHome,
  findRouteByHost,
  listProxyServices,
  mergeTlsConfig,
  model,
  parseAdminAddr,
  parseCaddyVersion,
  parseUpstream,
  reconcileProxyServices,
  removeRouteFromConfig,
  renderAdminConfig,
  renderDomainConflictError,
  renderMinimalConfig,
  renderServiceUnit,
  renderSettingsGuidance,
  renderTlsAutomation,
  renderUpgradeConfirmation,
  routeUpstream,
  validateBaseDomain,
  validateEmail,
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
  assertEquals(written[0].specName, "ensureProxy");
  assertEquals(written[0].data.changed, true);
  assertEquals(written[0].data.upstream, "127.0.0.1:8080");
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
  assertEquals(written[0].specName, "proxyServices");
  // No route was present, so nothing was removed and no POST was needed.
  // deno-lint-ignore no-explicit-any
  assertEquals((written[0].data.services as any[]).length, 0);
});
