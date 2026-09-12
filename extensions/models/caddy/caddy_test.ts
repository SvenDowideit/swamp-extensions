import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  addRouteToConfig,
  baseConfig,
  buildCurlArgs,
  buildRoute,
  caddyArch,
  deriveHostname,
  detectSwampServeServices,
  dnsProviderPlugin,
  expandHome,
  findRouteByHost,
  listProxyServices,
  mergeTlsConfig,
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
  validateBaseDomain,
  validateEmail,
} from "./caddy.ts";

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

Deno.test("parseCaddyVersion throws on empty output", () => {
  let threw = false;
  try {
    parseCaddyVersion("   ");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("renderServiceUnit includes binary, config, and admin API", () => {
  const unit = renderServiceUnit({
    binPath: "/home/alice/.local/bin/caddy",
    configPath: "/home/alice/.config/caddy/Caddyfile",
    adminApiAddr: "localhost:2019",
  });
  assertStringIncludes(unit, "ExecStart=/home/alice/.local/bin/caddy run");
  assertStringIncludes(unit, "--config /home/alice/.config/caddy/Caddyfile");
  assertStringIncludes(unit, "--admin localhost:2019");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("renderMinimalConfig is a valid empty Caddyfile", () => {
  const cfg = renderMinimalConfig();
  assertStringIncludes(cfg, "Managed by @svendowideit/caddy");
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

Deno.test("removeRouteFromConfig removes a route and errors when absent", () => {
  const config = baseConfig();
  const next = addRouteToConfig(
    config,
    buildRoute("foo.example.com", { dial: "127.0.0.1:8080", https: false }),
  );
  const removed = removeRouteFromConfig(next, "foo.example.com");
  assertEquals(findRouteByHost(removed, "foo.example.com"), null);

  let threw = false;
  try {
    removeRouteFromConfig(removed, "foo.example.com");
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "No route found");
  }
  assertEquals(threw, true);
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

Deno.test("reconcileProxyServices computes add/remove diff", () => {
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
  const { toAdd, toRemove } = reconcileProxyServices(
    desired,
    existing,
    "example.com",
  );
  assertEquals(toAdd.length, 1);
  assertEquals(toRemove, ["old.example.com"]);
});
