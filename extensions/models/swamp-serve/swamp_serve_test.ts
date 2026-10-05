import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  absoluteRepoDir,
  buildTelemetryEnv,
  deriveHostnames,
  deriveZone,
  describeOptions,
  effectiveTrustedHosts,
  expandHome,
  extractVersion,
  hostnamesFor,
  model,
  parseCaddyFacts,
  renderExecStart,
  renderServeConfig,
  renderServeConfigYaml,
  renderUnit,
  renderUnitEnvironment,
  resolveCaddyFromContext,
  scalarToYaml,
  shellQuote,
  splitList,
  STACKS_SUPPORTED,
  systemdDefinitionName,
  telemetryEnvDescription,
} from "./swamp_serve.ts";

const G = {
  repoDir: ".",
  swampBinPath: "~/.local/bin/swamp",
  installVersion: "",
  serviceName: "swamp-serve",
  host: "127.0.0.1",
  port: 9090,
  configPath: ".swamp/serve.yaml",
  dashboard: true,
  hotReload: true,
  autoResume: true,
  authMode: "none" as const,
  admins: "",
  allowedUsers: "",
  allowedCollectives: "",
  oauthProvider: "",
  trustProxy: true,
  trustedHosts: [] as string[],
  autoTrustedHosts: true,
  schedule: true,
  swampHome: "~/.swamp",
  swampConfigDir: "~/.config/swamp",
  caddyModelName: "my-caddy",
  swampHostname: "",
  dashboardHostname: "",
  otelSettingsModel: "",
  otelServiceName: "swamp-serve",
  telemetryVault: "",
  authRef: "OTEL_EXPORTER_OTLP_TOKEN",
  command: "",
};

Deno.test("expandHome resolves ~ against HOME", () => {
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});

Deno.test("deriveHostnames suffixes the base domain and avoids doubles", () => {
  assertEquals(deriveHostnames("x1yoga.fi.gy"), {
    swampHostname: "swamp.x1yoga.fi.gy",
    dashboardHostname: "dashboard.x1yoga.fi.gy",
  });
  assertEquals(deriveHostnames("otel.fi.gy"), {
    swampHostname: "swamp.otel.fi.gy",
    dashboardHostname: "dashboard.otel.fi.gy",
  });
  // Already-qualified labels are not double-suffixed.
  assertEquals(
    deriveHostnames("fi.gy", "swamp.fi.gy").swampHostname,
    "swamp.fi.gy",
  );
  // Explicit overrides always win.
  assertEquals(
    deriveHostnames("x.fi.gy", "", "dash.example.org").dashboardHostname,
    "dash.example.org",
  );
  // No base domain means no derivation.
  assertEquals(deriveHostnames(""), {
    swampHostname: "",
    dashboardHostname: "",
  });
});

Deno.test("deriveZone falls back to the last two labels", () => {
  assertEquals(deriveZone("x1yoga.fi.gy", "fi.gy"), "fi.gy");
  assertEquals(deriveZone("x1yoga.fi.gy", ""), "fi.gy");
  assertEquals(deriveZone("swamp.x1yoga.fi.gy", ""), "fi.gy");
  assertEquals(deriveZone("localhost", ""), "localhost");
});

Deno.test("parseCaddyFacts reads the host's own A record, not the zone apex", () => {
  const facts = parseCaddyFacts("my-caddy", {
    globalArguments: {
      baseDomain: "fi.gy",
      letsEncryptEmail: "me@example.org",
      dnsRecords: [
        { name: "fi.gy", type: "A", value: ["1.2.3.4"], zone: "fi.gy" },
        {
          name: "x1yoga.fi.gy",
          type: "A",
          value: ["10.10.13.208"],
          zone: "fi.gy",
        },
      ],
    },
  }, "x1yoga");
  assertEquals(facts.baseDomain, "fi.gy");
  assertEquals(facts.hostFqdn, "x1yoga.fi.gy");
  assertEquals(facts.tlsEmail, "me@example.org");
  assertEquals(facts.hostIp, "10.10.13.208");
  assertEquals(facts.zone, "fi.gy");
});

Deno.test("parseCaddyFacts picks the deepest record when the hostname is unknown", () => {
  const facts = parseCaddyFacts("my-caddy", {
    globalArguments: {
      baseDomain: "fi.gy",
      dnsRecords: [
        { name: "fi.gy", type: "A", value: ["1.2.3.4"], zone: "fi.gy" },
        { name: "x1yoga.fi.gy", type: "A", value: ["10.0.0.9"], zone: "fi.gy" },
      ],
    },
  }, "");
  assertEquals(facts.hostFqdn, "x1yoga.fi.gy");
  assertEquals(facts.hostIp, "10.0.0.9");
});

Deno.test("parseCaddyFacts ignores records for other names and non-A types", () => {
  const facts = parseCaddyFacts("c", {
    globalArguments: {
      baseDomain: "x1yoga.fi.gy",
      dnsRecords: [
        { name: "other.example.com", type: "A", value: ["1.2.3.4"], zone: "" },
        { name: "x1yoga.fi.gy", type: "CNAME", value: ["elsewhere"], zone: "" },
      ],
    },
  });
  assertEquals(facts.hostIp, "");
  assertEquals(facts.zone, "fi.gy");
});

Deno.test("parseCaddyFacts tolerates a bare model with no records", () => {
  const facts = parseCaddyFacts("c", {
    globalArguments: { baseDomain: "fi.gy" },
  });
  assertEquals(facts.baseDomain, "fi.gy");
  assertEquals(facts.hostFqdn, "fi.gy");
  assertEquals(facts.hostIp, "");
  assertEquals(facts.tlsEmail, "");
});

Deno.test("absoluteRepoDir makes a relative repo dir absolute", () => {
  assertEquals(absoluteRepoDir(".", "/home/u/repo"), "/home/u/repo");
  assertEquals(absoluteRepoDir(".", "/home/u/repo/"), "/home/u/repo");
  assertEquals(absoluteRepoDir("sub", "/home/u/repo"), "/home/u/repo/sub");
  assertEquals(absoluteRepoDir("../x", "/home/u/repo"), "/home/u/x");
  assertEquals(absoluteRepoDir("/abs/path", "/cwd"), "/abs/path");
  assertEquals(absoluteRepoDir("", "/cwd"), "/cwd");
});

Deno.test("renderExecStart enables dashboard, hot-reload and auto-resume by default", () => {
  const line = renderExecStart(G as never);
  assertEquals(line.includes(`serve --repo-dir ${absoluteRepoDir(".")}`), true);
  assertEquals(line.includes("--dashboard"), true);
  assertEquals(line.includes("--hot-reload"), true);
  assertEquals(line.includes("--auto-resume"), true);
  assertEquals(line.includes("--trust-proxy"), true);
  assertEquals(
    line.includes("--auth-mode"),
    false,
    "auth-mode none is implicit",
  );
  assertEquals(line.includes("--no-schedule"), false);
});

Deno.test("renderExecStart honours toggles and never-schedule", () => {
  const line = renderExecStart({
    ...G,
    dashboard: false,
    hotReload: false,
    autoResume: false,
    schedule: false,
    authMode: "token",
    admins: "user:abc",
    trustedHosts: ["a.example", "b.example"],
  } as never);
  assertEquals(line.includes("--dashboard"), false);
  assertEquals(line.includes("--hot-reload"), false);
  assertEquals(line.includes("--auto-resume"), false);
  assertEquals(line.includes("--no-schedule"), true);
  assertEquals(line.includes("--auth-mode token"), true);
  assertEquals(line.includes("--admins user:abc"), true);
  assertEquals(line.includes("--trusted-hosts a.example,b.example"), true);
});

Deno.test("effectiveTrustedHosts folds in derived hostnames after explicit ones", () => {
  const list = effectiveTrustedHosts(
    ["swamp.x1yoga.fi.gy", "dashboard.x1yoga.fi.gy"],
    { trustedHosts: ["host.docker.internal"], autoTrustedHosts: true },
  );
  assertEquals(list, [
    "host.docker.internal",
    "swamp.x1yoga.fi.gy",
    "dashboard.x1yoga.fi.gy",
  ]);
});

Deno.test("effectiveTrustedHosts dedupes and drops empties", () => {
  const list = effectiveTrustedHosts(
    ["swamp.example", "", "dashboard.example", "swamp.example"],
    { trustedHosts: ["swamp.example"], autoTrustedHosts: true },
  );
  assertEquals(list, ["swamp.example", "dashboard.example"]);
});

Deno.test("effectiveTrustedHosts omits derived hosts when auto is off", () => {
  const list = effectiveTrustedHosts(
    ["swamp.x1yoga.fi.gy", "dashboard.x1yoga.fi.gy"],
    { trustedHosts: ["explicit.example"], autoTrustedHosts: false },
  );
  assertEquals(list, ["explicit.example"]);
});

Deno.test("renderExecStart and serve config use the passed trusted hosts", () => {
  const hosts = ["swamp.x1yoga.fi.gy", "dashboard.x1yoga.fi.gy"];
  const line = renderExecStart(G as never, hosts);
  assertEquals(
    line.includes("--trusted-hosts swamp.x1yoga.fi.gy,dashboard.x1yoga.fi.gy"),
    true,
  );
  const cfg = renderServeConfig(G as never, hosts);
  assertEquals(cfg["trusted-hosts"], hosts);
  // With no hosts passed, the explicit global (empty here) is used.
  assertEquals(renderServeConfig(G as never)["trusted-hosts"], undefined);
});

Deno.test("renderExecStart returns an explicit command verbatim", () => {
  assertEquals(
    renderExecStart({ ...G, command: "/bin/false" } as never),
    "/bin/false",
  );
});

Deno.test("shellQuote quotes only when needed", () => {
  assertEquals(shellQuote("plain"), "plain");
  assertEquals(shellQuote(""), '""');
  assertEquals(shellQuote("a b"), '"a b"');
});

Deno.test("renderServeConfig mirrors the serve.yaml schema", () => {
  const cfg = renderServeConfig(G as never);
  assertEquals(cfg.port, 9090);
  assertEquals(cfg.dashboard, true);
  assertEquals(cfg["hot-reload"], true);
  assertEquals(cfg["auto-resume"], true);
  assertEquals((cfg.auth as Record<string, unknown>).mode, "none");
  assertEquals("trusted-hosts" in cfg, false);
});

Deno.test("renderServeConfigYaml round-trips the shape", () => {
  const yaml = renderServeConfigYaml(G as never);
  assertEquals(yaml.includes("port: 9090"), true);
  assertEquals(yaml.includes("dashboard: true"), true);
  assertEquals(yaml.includes("hot-reload: true"), true);
  assertEquals(yaml.includes("auth:\n  mode: none"), true);
  assertEquals(yaml.endsWith("\n"), true);
});

Deno.test("renderServeConfigYaml renders list options", () => {
  const yaml = renderServeConfigYaml(
    { ...G, trustedHosts: ["a.example"] } as never,
  );
  assertEquals(yaml.includes("trusted-hosts:"), true);
  assertEquals(yaml.includes("- a.example"), true);
});

Deno.test("scalarToYaml quotes empty and special strings", () => {
  assertEquals(scalarToYaml("plain"), "plain");
  assertEquals(scalarToYaml(""), '""');
  assertEquals(scalarToYaml("a: b"), '"a: b"');
  assertEquals(scalarToYaml(true), "true");
  assertEquals(scalarToYaml(9090), "9090");
});

Deno.test("splitList trims and drops empties", () => {
  assertEquals(splitList("a, b ,,c"), ["a", "b", "c"]);
  assertEquals(splitList(""), []);
});

Deno.test("renderUnitEnvironment always pins SWAMP_HOME and config dir", () => {
  const env = renderUnitEnvironment(G as never, null);
  assertEquals(env.some((e) => e.startsWith("SWAMP_HOME=")), true);
  assertEquals(env.some((e) => e.startsWith("SWAMP_CONFIG_DIR=")), true);
  assertEquals(env.some((e) => e.startsWith("OTEL_")), false);
});

Deno.test("renderUnitEnvironment adds OTLP settings and batching when present", () => {
  const env = renderUnitEnvironment(G as never, {
    endpoint: "http://otlp.fi.gy:4318",
    headers: "Authorization=Bearer x",
    serviceName: "swamp-serve",
    resourceAttributes: "deployment.environment=dev",
    signals: ["logs", "metrics", "traces"],
  });
  assertEquals(
    env.includes("OTEL_EXPORTER_OTLP_ENDPOINT=http://otlp.fi.gy:4318"),
    true,
  );
  assertEquals(env.includes("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf"), true);
  assertEquals(env.includes("OTEL_SERVICE_NAME=swamp-serve"), true);
  assertEquals(env.includes("OTEL_BSP_USE=1"), true);
  assertEquals(env.includes("OTEL_BLRP_USE=1"), true);
});

Deno.test("renderUnit combines command, environment and working directory", () => {
  const unit = renderUnit(G as never, null);
  assertEquals(unit.workingDirectory, absoluteRepoDir("."));
  assertEquals(unit.execStart.includes("--dashboard"), true);
  assertEquals(unit.environment.length, 2);
});

Deno.test("buildTelemetryEnv prefers the default mesh endpoint", () => {
  const t = buildTelemetryEnv(
    {
      endpoints: [
        { mesh: "wireguard", otlp_http_url: "http://wg:4318" },
        { mesh: "tailscale", otlp_http_url: "https://otlp.fi.gy:4318" },
      ],
      defaultMesh: "tailscale",
      deploymentEnvironment: "dev",
      site: "home",
      owner: "sven",
      authMethod: "bearer",
    },
    { serviceName: "swamp-serve", token: "secret" },
  );
  assertEquals(t.endpoint, "https://otlp.fi.gy:4318");
  assertEquals(t.headers, "Authorization=Bearer secret");
  assertEquals(
    t.resourceAttributes,
    "service.name=swamp-serve,deployment.environment=dev,site=home,owner=sven",
  );
  assertEquals(t.signals, ["logs", "metrics", "traces"]);
});

Deno.test("buildTelemetryEnv falls back to the first endpoint and no token", () => {
  const t = buildTelemetryEnv(
    { endpoints: [{ otlp_http_url: "http://only:4318" }] },
    { serviceName: "s" },
  );
  assertEquals(t.endpoint, "http://only:4318");
  assertEquals(t.headers, "");
  assertEquals(t.resourceAttributes, "service.name=s");
});

Deno.test("buildTelemetryEnv honours an explicit endpoint override", () => {
  const t = buildTelemetryEnv(
    { endpoints: [{ otlp_http_url: "http://x:4318" }] },
    { serviceName: "s", endpoint: "http://override:4318" },
  );
  assertEquals(t.endpoint, "http://override:4318");
});

Deno.test("telemetryEnvDescription documents each key", () => {
  const keys = telemetryEnvDescription().map((e) => e.key);
  assertEquals(keys.includes("OTEL_EXPORTER_OTLP_ENDPOINT"), true);
  assertEquals(keys.includes("OTEL_EXPORTER_OTLP_HEADERS"), true);
  assertEquals(keys.includes("OTEL_SERVICE_NAME"), true);
});

Deno.test("stacks are documented as unsupported", () => {
  assertEquals(STACKS_SUPPORTED, false);
});

Deno.test("describeOptions covers the full argument surface", () => {
  const keys = describeOptions(G as never).map((o) => o.key);
  for (
    const expected of [
      "port",
      "host",
      "dashboard",
      "hotReload",
      "autoResume",
      "authMode",
      "trustedHosts",
      "caddyModelName",
      "otelSettingsModel",
      "swampHome",
      "swampConfigDir",
    ]
  ) {
    assertEquals(keys.includes(expected), true, `missing ${expected}`);
  }
  assertEquals(
    describeOptions(G as never).every((o) =>
      o.persist.includes("--global-arg")
    ),
    true,
  );
});

Deno.test("extractVersion reads the version from update --check JSON", () => {
  assertEquals(
    extractVersion('{"currentVersion":"20260101.1","status":"up_to_date"}'),
    "20260101.1",
  );
  assertEquals(extractVersion("not json"), "");
  assertEquals(extractVersion('{"version":"v2"}'), "v2");
});

Deno.test("systemdDefinitionName never equals the caller's own name", () => {
  assertEquals(
    systemdDefinitionName("swamp-serve", "swamp-serve"),
    "swamp-serve-unit",
  );
  assertEquals(
    systemdDefinitionName("swamp-serve", "other"),
    "swamp-serve-unit",
  );
  // If the service name already collides with our "-unit" convention, suffix it.
  assertEquals(systemdDefinitionName("foo", "foo-unit"), "foo-unit-svc");
});

Deno.test("resolveCaddyFromContext requires a model name", async () => {
  const ctx = { readModelData: () => Promise.resolve([]) };
  await assertRejects(
    () =>
      resolveCaddyFromContext(
        { ...ctx, globalArgs: { ...G, caddyModelName: "" } } as never,
        { ...G, caddyModelName: "" } as never,
      ),
    Error,
    "caddyModelName is required",
  );
});

Deno.test("resolveCaddyFromContext reads the caddy 'desired' resource", async () => {
  const ctx = {
    readModelData: (name: string, spec: string) => {
      assertEquals(name, "my-caddy");
      assertEquals(spec, "desired");
      return Promise.resolve([
        {
          attributes: {
            baseDomain: "fi.gy",
            dnsRecords: [
              {
                name: "x1yoga.fi.gy",
                type: "A",
                value: ["10.0.0.5"],
                zone: "fi.gy",
              },
            ],
          },
        },
      ]);
    },
  };
  const facts = await resolveCaddyFromContext(
    { ...ctx, globalArgs: G } as never,
    G as never,
    "x1yoga",
  );
  assertEquals(facts.baseDomain, "fi.gy");
  assertEquals(facts.hostFqdn, "x1yoga.fi.gy");
  assertEquals(facts.hostIp, "10.0.0.5");
});

Deno.test("resolveCaddyFromContext rejects when 'desired' is missing", async () => {
  const ctx = { readModelData: () => Promise.resolve([]) };
  await assertRejects(
    () =>
      resolveCaddyFromContext(
        { ...ctx, globalArgs: G } as never,
        G as never,
      ),
    Error,
    "could not read the 'desired' resource",
  );
});

Deno.test("hostnamesFor derives from the host FQDN in the resolved facts", () => {
  const hosts = hostnamesFor(G as never, {
    modelName: "my-caddy",
    baseDomain: "fi.gy",
    hostFqdn: "x1yoga.fi.gy",
    tlsEmail: "",
    hostIp: "10.0.0.5",
    zone: "fi.gy",
  });
  assertEquals(hosts.swampHostname, "swamp.x1yoga.fi.gy");
  assertEquals(hosts.dashboardHostname, "dashboard.x1yoga.fi.gy");
});

Deno.test("the model exposes a resource for every method", () => {
  const specs = Object.keys(model.resources);
  for (
    const s of [
      "topology",
      "binary",
      "serveConfig",
      "unit",
      "service",
      "telemetry",
      "proxy",
      "dns",
      "status",
      "guidance",
    ]
  ) {
    assertEquals(specs.includes(s), true, `missing resource ${s}`);
  }
  const methods = Object.keys(model.methods);
  for (
    const m of [
      "resolve",
      "installBinary",
      "updateBinary",
      "configure",
      "ensureService",
      "ensureTelemetry",
      "ensureDns",
      "ensureProxy",
      "status",
      "guidance",
      "remove",
    ]
  ) {
    assertEquals(methods.includes(m), true, `missing method ${m}`);
  }
});
