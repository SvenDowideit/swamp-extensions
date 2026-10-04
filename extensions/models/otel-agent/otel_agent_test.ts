import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  expandHome,
  fetchInstallManifest,
  hostDest,
  inferTier,
  isSafeServiceName,
  mapWithConcurrency,
  model,
  normaliseBaseUrl,
  parseHostFacts,
  parseInstallManifest,
  releaseArch,
  releaseOs,
  renderAgentUnit,
  renderInstallScript,
  renderProbeScript,
  shellQuote,
} from "./otel_agent.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("normaliseBaseUrl drops trailing slashes", () => {
  assertEquals(normaliseBaseUrl("https://h/"), "https://h");
  assertEquals(normaliseBaseUrl("https://h///"), "https://h");
});

Deno.test("expandHome expands a leading tilde", () => {
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});

Deno.test("releaseArch maps uname tokens", () => {
  assertEquals(releaseArch("x86_64"), "amd64");
  assertEquals(releaseArch("aarch64"), "arm64");
  assertEquals(releaseArch("armv7l"), "armv7");
  assertEquals(releaseArch("i686"), "386");
  assertEquals(releaseArch(""), "amd64");
});

Deno.test("inferTier picks T2 for small memory, else the default", () => {
  assertEquals(
    inferTier({
      arch: "arm64",
      os: "linux",
      osId: "debian",
      memTotalMiB: 2048,
      systemd: true,
      version: "",
    }, "T1"),
    "T2",
  );
  assertEquals(
    inferTier({
      arch: "amd64",
      os: "linux",
      osId: "debian",
      memTotalMiB: 16384,
      systemd: true,
      version: "",
    }, "T1"),
    "T1",
  );
  assertEquals(
    inferTier({
      arch: "amd64",
      os: "linux",
      osId: "debian",
      systemd: true,
      version: "",
    }, "T1"),
    "T1",
  );
});

Deno.test("releaseOs maps distro ids to the release OS token", () => {
  assertEquals(releaseOs("ubuntu"), "linux");
  assertEquals(releaseOs("debian"), "linux");
  assertEquals(releaseOs("raspbian"), "linux");
  assertEquals(releaseOs("darwin"), "darwin");
  assertEquals(releaseOs(""), "linux");
});

Deno.test("parseHostFacts reads the probe output", () => {
  const out = [
    "arch=x86_64",
    "systemd=1",
    "os=debian",
    "mem_total_mib=4096",
    "agent_version=0.162.0",
  ].join("\n");
  const f = parseHostFacts(out);
  assertEquals(f.arch, "amd64");
  assertEquals(f.os, "linux");
  assertEquals(f.osId, "debian");
  assertEquals(f.memTotalMiB, 4096);
  assertEquals(f.systemd, true);
  assertEquals(f.version, "0.162.0");
});

Deno.test("parseHostFacts defaults os and tolerates missing fields", () => {
  const f = parseHostFacts("arch=aarch64\nsystemd=0\nmem_total_mib=");
  assertEquals(f.os, "linux");
  assertEquals(f.osId, "linux");
  assertEquals(f.systemd, false);
  assertEquals(f.memTotalMiB, undefined);
  assertEquals(f.version, "");
});

Deno.test("parseInstallManifest reads the contract manifest", () => {
  const m = parseInstallManifest(JSON.stringify({
    os: "linux",
    arch: "amd64",
    agentVersion: "0.162.0",
    assetName: "otelcol-contrib_0.162.0_linux_amd64.tar.gz",
    tarballUrl: "https://settings.otel.fi.gy/install/x.tar.gz",
    checksumUrl: "https://settings.otel.fi.gy/install/x.tar.gz.sha256",
  }));
  assertEquals(m.os, "linux");
  assertEquals(m.version, "0.162.0");
  assertStringIncludes(m.tarballUrl, "/install/");
});

Deno.test("shellQuote single-quotes and escapes embedded quotes", () => {
  assertEquals(shellQuote("simple"), "'simple'");
  assertEquals(shellQuote("a'b"), "'a'\\''b'");
});

Deno.test("isSafeServiceName accepts units and rejects injection", () => {
  assert(isSafeServiceName("otel-agent"));
  assert(isSafeServiceName("otel@agent"));
  assert(!isSafeServiceName("bad name"));
  assert(!isSafeServiceName("x; rm -rf /"));
});

Deno.test("renderProbeScript emits the keys parseHostFacts reads", () => {
  const script = renderProbeScript(
    "/home/u/.local/share/otel-agent/otelcol-contrib",
  );
  for (
    const key of [
      "arch=",
      "systemd=",
      "os=",
      "mem_total_mib=",
      "agent_version=",
    ]
  ) {
    assertStringIncludes(script, key);
  }
});

Deno.test("renderAgentUnit writes an EnvironmentFile-aware unit", () => {
  const unit = renderAgentUnit({
    binaryPath: "/x/otelcol-contrib",
    configPath: "/x/config.yaml",
    envPath: "/x/agent.env",
    serviceName: "otel-agent",
    agentVersion: "0.162.0",
  });
  assertStringIncludes(
    unit,
    "ExecStart=/x/otelcol-contrib --config /x/config.yaml",
  );
  assertStringIncludes(unit, "EnvironmentFile=-/x/agent.env");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("renderInstallScript is idempotent, checksum-verifies, and never leaks via args", () => {
  const script = renderInstallScript({
    installDir: "/home/u/.local/share/otel-agent",
    binaryPath: "/home/u/.local/share/otel-agent/otelcol-contrib",
    configPath: "/home/u/.local/share/otel-agent/config.yaml",
    envPath: "/home/u/.local/share/otel-agent/agent.env",
    serviceName: "otel-agent",
    manifest: {
      os: "linux",
      arch: "amd64",
      version: "0.162.0",
      assetName: "otelcol-contrib_0.162.0_linux_amd64.tar.gz",
      tarballUrl: "https://settings.otel.fi.gy/install/x.tar.gz",
      checksumUrl: "https://settings.otel.fi.gy/install/x.tar.gz.sha256",
    },
    config: "receivers:\n  otlp: {}",
    token: "SECRET_TOKEN",
    force: false,
  });
  assertStringIncludes(script, "sha256sum -c -");
  assertStringIncludes(script, "systemctl --user restart otel-agent.service");
  assertStringIncludes(script, "OTEL_EXPORTER_OTLP_TOKEN=SECRET_TOKEN");
  assertStringIncludes(script, "chmod 600");
  assertStringIncludes(script, "SWAMP_CFG_EOF");
  // The config is delivered via heredoc, so config content cannot break args.
  assertStringIncludes(script, "receivers:");
});

Deno.test("hostDest combines user and address", () => {
  assertEquals(
    hostDest({ address: "10.0.0.1", user: "sven" }, "root"),
    "sven@10.0.0.1",
  );
  assertEquals(
    hostDest({ address: "10.0.0.1", user: "" }, "root"),
    "root@10.0.0.1",
  );
  assertEquals(hostDest({ address: "h", user: "" }, ""), "h");
});

Deno.test("mapWithConcurrency preserves order and bounds parallelism", async () => {
  const items = [1, 2, 3, 4, 5, 6];
  let inFlight = 0;
  let maxInFlight = 0;
  const out = await mapWithConcurrency(items, 2, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 10;
  });
  assertEquals(out, [10, 20, 30, 40, 50, 60]);
  assert(maxInFlight <= 2, `expected <=2 in flight, saw ${maxInFlight}`);
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

Deno.test("model exposes the expected methods", () => {
  assertEquals(model.type, "@svendowideit/otel-agent");
  assertEquals(
    Object.keys(model.methods).sort(),
    ["configure", "install", "remove", "status"],
  );
});

Deno.test("model global args default sensibly", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.settingsUrl, "https://settings.otel.fi.gy");
  assertEquals(parsed.serviceName, "otel-agent");
  assertEquals(parsed.defaultTier, "T1");
  assertEquals(parsed.concurrency, 8);
});

Deno.test("the sane-config check rejects a bad service name and non-http settingsUrl", () => {
  const check = model.checks["sane-config"].execute;
  assert(
    !check({
      globalArgs: model.globalArguments.parse({ serviceName: "bad name" }),
    }).pass,
  );
  assert(
    !check({
      globalArgs: model.globalArguments.parse({
        settingsUrl: "settings.otel.fi.gy",
      }),
    }).pass,
  );
  assert(
    !check({
      globalArgs: model.globalArguments.parse({ installDir: "/has space/x" }),
    }).pass,
  );
  assertEquals(
    check({ globalArgs: model.globalArguments.parse({}) }).pass,
    true,
  );
});

Deno.test("fetchInstallManifest builds the contract URL", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = ((url: string) => {
    requested = url;
    return Promise.resolve(
      new Response(JSON.stringify({
        os: "linux",
        arch: "arm64",
        agentVersion: "0.162.0",
        assetName: "a",
        tarballUrl: "t",
        checksumUrl: "c",
      })),
    );
  }) as typeof fetch;
  try {
    const m = await fetchInstallManifest(
      "https://settings.otel.fi.gy/",
      "linux",
      "arm64",
    );
    assertEquals(
      requested,
      "https://settings.otel.fi.gy/install/linux-arm64.json",
    );
    assertEquals(m.arch, "arm64");
  } finally {
    globalThis.fetch = original;
  }
});
