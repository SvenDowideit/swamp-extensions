import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  contribAssetName,
  contribDownloadUrl,
  envNamesFor,
  expandHome,
  isEnvRef,
  isSafeServiceName,
  model,
  parseChecksums,
  parseSha256,
  quoteYamlKey,
  releaseArchToken,
  renderGatewayConfig,
  renderGatewayUnit,
  resolvePaths,
  sanitiseEnvName,
  selectContribAsset,
  sha256UrlFor,
  shellQuote,
} from "./otel_gateway.ts";

const exporters = [
  {
    name: "openobserve",
    endpoint: "http://127.0.0.1:5080/api/default",
    headers: [
      { name: "Authorization", value: "${env:OO_AUTH}" },
      { name: "organization", value: "default" },
    ],
    insecure: false,
    signals: ["logs", "metrics", "traces"],
    enabled: true,
  },
];

function config(overrides: Record<string, unknown> = {}) {
  return renderGatewayConfig({
    grpcPort: 4317,
    httpPort: 4318,
    healthPort: 13133,
    metricsPort: 8888,
    bindAddress: "127.0.0.1",
    exporters,
    samplingHeadPercent: 100,
    memoryLimitMiB: 512,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Config rendering
// ---------------------------------------------------------------------------

Deno.test("renderGatewayConfig renders receivers, exporters, and pipelines", () => {
  const yaml = config();
  assertStringIncludes(yaml, "grpc:");
  assertStringIncludes(yaml, "endpoint: 127.0.0.1:4317");
  assertStringIncludes(yaml, "endpoint: 127.0.0.1:4318");
  assertStringIncludes(yaml, "otlphttp/openobserve:");
  assertStringIncludes(yaml, "endpoint: http://127.0.0.1:5080/api/default");
  assertStringIncludes(yaml, "Authorization: ${env:OO_AUTH}");
  assertStringIncludes(yaml, "organization: default");
  assertStringIncludes(yaml, "logs:");
  assertStringIncludes(yaml, "metrics:");
  assertStringIncludes(yaml, "traces:");
  assertStringIncludes(yaml, "exporters: [otlphttp/openobserve]");
  assertStringIncludes(yaml, "health_check:");
  assertStringIncludes(yaml, "telemetry:");
  assertStringIncludes(yaml, "readers:");
  assertStringIncludes(yaml, "port: 8888");
});

Deno.test("renderGatewayConfig never inlines a secret (only ${env:...})", () => {
  const yaml = config();
  assert(!yaml.includes("Basic "));
  assertStringIncludes(yaml, "${env:OO_AUTH}");
});

Deno.test("renderGatewayConfig omits the sampler at 100% and includes it below", () => {
  assert(
    !config({ samplingHeadPercent: 100 }).includes("probabilistic_sampler"),
  );
  const sampled = config({ samplingHeadPercent: 25 });
  assertStringIncludes(sampled, "probabilistic_sampler:");
  assertStringIncludes(sampled, "sampling_percentage: 25");
  assertStringIncludes(
    sampled,
    "[memory_limiter, probabilistic_sampler, batch]",
  );
});

Deno.test("renderGatewayConfig fans out multiple enabled exporters (dual-write)", () => {
  const yaml = config({
    exporters: [
      ...exporters,
      {
        name: "lgtm",
        endpoint: "http://127.0.0.1:4417/api",
        headers: [],
        insecure: false,
        signals: ["logs", "metrics", "traces"],
        enabled: true,
      },
    ],
  });
  assertStringIncludes(yaml, "otlphttp/openobserve:");
  assertStringIncludes(yaml, "otlphttp/lgtm:");
  assertStringIncludes(
    yaml,
    "exporters: [otlphttp/openobserve, otlphttp/lgtm]",
  );
});

Deno.test("renderGatewayConfig excludes disabled exporters", () => {
  const yaml = config({
    exporters: [{ ...exporters[0], enabled: false }, {
      ...exporters[0],
      name: "active",
      enabled: true,
    }],
  });
  assert(!yaml.includes("otlphttp/openobserve:"));
  assertStringIncludes(yaml, "otlphttp/active:");
});

Deno.test("renderGatewayConfig only routes signals an exporter carries", () => {
  const yaml = config({
    exporters: [{ ...exporters[0], signals: ["logs"] }],
  });
  // Exactly one pipeline exists (logs) — telemetry has no `receivers` key, so
  // counting receiver lines is an unambiguous pipeline count.
  assertEquals(yaml.match(/receivers: \[otlp\]/g)?.length, 1);
  assertStringIncludes(yaml, "exporters: [otlphttp/openobserve]");
});

Deno.test("renderGatewayConfig rejects an empty enabled set", () => {
  const err = assertThrows(() =>
    config({ exporters: [{ ...exporters[0], enabled: false }] })
  ) as Error;
  assertStringIncludes(err.message, "at least one enabled exporter");
});

Deno.test("renderGatewayConfig marks an insecure exporter", () => {
  const yaml = config({ exporters: [{ ...exporters[0], insecure: true }] });
  assertStringIncludes(yaml, "insecure: true");
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

Deno.test("quoteYamlKey leaves safe keys bare and quotes the rest", () => {
  assertEquals(quoteYamlKey("Authorization"), "Authorization");
  assertEquals(quoteYamlKey("x-api.key_1"), "x-api.key_1");
  assertEquals(quoteYamlKey("a b"), '"a b"');
});

Deno.test("isEnvRef detects ${env:...} references", () => {
  assert(isEnvRef("${env:TOKEN}"));
  assert(!isEnvRef("Basic abc"));
  assert(!isEnvRef(""));
});

Deno.test("envNamesFor lists the env vars referenced by headers", () => {
  assertEquals(
    envNamesFor([
      {
        ...exporters[0],
        headers: [
          { name: "Authorization", value: "${env:OO_AUTH}" },
          { name: "organization", value: "default" },
          { name: "X-Key", value: "${env:OO_KEY}" },
        ],
      },
    ]),
    ["OO_AUTH", "OO_KEY"],
  );
});

Deno.test("isSafeServiceName accepts unit names and rejects injection", () => {
  assert(isSafeServiceName("otel-gateway"));
  assert(isSafeServiceName("otel@gateway"));
  assert(!isSafeServiceName("bad name"));
  assert(!isSafeServiceName("x; rm -rf /"));
  assert(!isSafeServiceName(""));
});

Deno.test("expandHome expands a leading tilde with an injectable home", () => {
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});

Deno.test("resolvePaths derives binary, config, and env file from the install dir", () => {
  const p = resolvePaths(
    {
      installDir: "~/share/gw",
      binaryPath: "",
      configPath: "",
      environmentFile: "",
    } as never,
    "/home/u",
  );
  assertEquals(p.binaryPath, "/home/u/share/gw/otelcol-contrib");
  assertEquals(p.configPath, "/home/u/share/gw/config.yaml");
  assertEquals(p.environmentFile, "/home/u/share/gw/gateway.env");
});

Deno.test("shellQuote single-quotes a value for an EnvironmentFile", () => {
  assertEquals(shellQuote("simple"), "'simple'");
  assertEquals(shellQuote("a'b"), "'a'\\''b'");
  assertEquals(shellQuote("with spaces"), "'with spaces'");
});

// ---------------------------------------------------------------------------
// Release asset selection
// ---------------------------------------------------------------------------

Deno.test("releaseArchToken maps uname tokens to release tokens", () => {
  assertEquals(releaseArchToken("x86_64"), "amd64");
  assertEquals(releaseArchToken("aarch64"), "arm64");
  assertEquals(releaseArchToken("armv7l"), "armv7");
  assertEquals(releaseArchToken("i686"), "386");
});

Deno.test("contribAssetName and download URL match the published scheme", () => {
  const name = contribAssetName("0.162.0", "amd64");
  assertEquals(name, "otelcol-contrib_0.162.0_linux_amd64.tar.gz");
  assertEquals(
    contribDownloadUrl("0.162.0", name),
    "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.162.0/otelcol-contrib_0.162.0_linux_amd64.tar.gz",
  );
  // A leading v is accepted and not doubled.
  assertEquals(
    contribDownloadUrl("v0.162.0", name).includes("/v0.162.0/"),
    true,
  );
});

Deno.test("parseChecksums reads sha256 lines and tolerates the binary marker", () => {
  const body = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  otelcol-contrib_0.162.0_linux_amd64.tar.gz",
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *otelcol-contrib_0.162.0_linux_arm64.tar.gz",
    "# a comment",
    "",
  ].join("\n");
  const map = parseChecksums(body);
  assertEquals(Object.keys(map).length, 2);
  assertEquals(
    map["otelcol-contrib_0.162.0_linux_amd64.tar.gz"],
    "a".repeat(64),
  );
  assertEquals(
    map["otelcol-contrib_0.162.0_linux_arm64.tar.gz"],
    "b".repeat(64),
  );
});

Deno.test("selectContribAsset picks this host's asset and rejects a missing one", () => {
  const names = [
    "otelcol-contrib_0.162.0_linux_amd64.tar.gz",
    "otelcol-contrib_0.162.0_linux_arm64.tar.gz",
  ];
  const picked = selectContribAsset({
    version: "0.162.0",
    unameM: "x86_64",
    assetNames: names,
  });
  assertEquals(picked.assetName, "otelcol-contrib_0.162.0_linux_amd64.tar.gz");
  const err = assertThrows(() =>
    selectContribAsset({
      version: "0.162.0",
      unameM: "s390x",
      assetNames: names,
    })
  ) as Error;
  assertStringIncludes(err.message, "does not publish");
});

Deno.test("parseSha256 reads a bare digest file and rejects junk", () => {
  const digest =
    "fcc063749f730f8c21fe29f2d340ff174f5f1c5885bd3156fb6c985a3036fcc3";
  assertEquals(parseSha256(digest), digest);
  assertEquals(parseSha256(`${digest}\n`), digest);
  assertEquals(parseSha256("not a hash"), "");
});

Deno.test("sha256UrlFor appends .sha256 to the asset URL", () => {
  const name = contribAssetName("0.162.0", "amd64");
  assertEquals(
    sha256UrlFor("0.162.0", name),
    `${contribDownloadUrl("0.162.0", name)}.sha256`,
  );
});

Deno.test("renderGatewayUnit writes an EnvironmentFile-aware unit", () => {
  const unit = renderGatewayUnit({
    version: "0.162.0",
    binaryPath: "/x/otelcol-contrib",
    configPath: "/x/config.yaml",
    environmentFile: "/x/gateway.env",
  });
  assertStringIncludes(
    unit,
    "ExecStart=/x/otelcol-contrib --config /x/config.yaml",
  );
  assertStringIncludes(unit, "EnvironmentFile=-/x/gateway.env");
  assertStringIncludes(unit, "WantedBy=default.target");
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

Deno.test("model exposes the expected methods", () => {
  assertEquals(model.type, "@svendowideit/otel-gateway");
  assertEquals(
    Object.keys(model.methods).sort(),
    ["configure", "install", "remove", "status", "verify"],
  );
});

Deno.test("model global args default to the standard OTLP ports", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.grpcPort, 4317);
  assertEquals(parsed.httpPort, 4318);
  assertEquals(parsed.healthPort, 13133);
  assertEquals(parsed.metricsPort, 8888);
  assertEquals(parsed.serviceName, "otel-gateway");
  assertEquals(parsed.bindAddress, "127.0.0.1");
});

Deno.test("model global args are strict", () => {
  assertThrows(() => model.globalArguments.parse({ nope: 1 }));
});

Deno.test("the sane-config check rejects a bad service name and no exporters", () => {
  const check = model.checks["sane-config"].execute;
  const badName = check({
    globalArgs: model.globalArguments.parse({
      serviceName: "bad name",
      exporters: [],
    }),
  });
  assert(!badName.pass);
  const noExporter = check({ globalArgs: model.globalArguments.parse({}) });
  assert(!noExporter.pass);
  const ok = check({
    globalArgs: model.globalArguments.parse({
      exporters: [{ name: "oo", endpoint: "http://h:1/api" }],
    }),
  });
  assertEquals(ok.pass, true);
});

Deno.test("the sane-config check rejects a trailing slash on an exporter endpoint", () => {
  const check = model.checks["sane-config"].execute;
  const res = check({
    globalArgs: model.globalArguments.parse({
      exporters: [{ name: "oo", endpoint: "http://h:1/api/" }],
    }),
  });
  assert(!res.pass);
  assertStringIncludes((res.errors ?? []).join(" "), "must not end with '/'");
});

Deno.test("sanitiseEnvName produces a safe env var name", () => {
  assertEquals(sanitiseEnvName("openobserve"), "OTEL_OPENOBSERVE");
  assertEquals(sanitiseEnvName("my-backend-1"), "OTEL_MY_BACKEND_1");
  assertEquals(sanitiseEnvName(""), "OTEL_EXPORTER");
});
