import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  addRouteToConfig,
  baseConfig,
  buildRoute,
  caddyArch,
  deriveHostname,
  expandHome,
  findRouteByHost,
  listProxyServices,
  parseCaddyVersion,
  parseUpstream,
  removeRouteFromConfig,
  renderDomainConflictError,
  renderMinimalConfig,
  renderServiceUnit,
  renderSettingsGuidance,
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
