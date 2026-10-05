import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  buildDocuments,
  buildSettings,
  contentHashHex,
  DEFAULT_TIERS,
  defaultEndpoint,
  expandHome,
  installBaseUrl,
  model,
  normaliseEndpoint,
  renderAgentConfig,
  renderIndexHtml,
  renderInstallManifest,
  renderOtelEnv,
  renderOtelJson,
  renderOtelMarkdown,
  renderVersionJson,
  resolveTiers,
  settingsUrl,
  validateSettings,
} from "./otel_settings.ts";

function globals(overrides: Record<string, unknown> = {}) {
  return {
    domain: "otel.fi.gy",
    deploymentEnvironment: "dev",
    site: "home",
    owner: "sven",
    endpoints: [
      {
        otlp_grpc: "otlp.fi.gy:4317",
        otlp_http: "otlp.fi.gy:4318",
        otlp_grpc_url: "",
        otlp_http_url: "",
        mesh: "tailscale",
      },
      {
        otlp_grpc: "otlp.wg.otel.fi.gy:4317",
        otlp_http: "otlp.wg.otel.fi.gy:4318",
        otlp_grpc_url: "",
        otlp_http_url: "",
        mesh: "wireguard",
      },
    ],
    defaultMesh: "tailscale",
    attributes: { "host.name": "node-1" },
    sampling: { head_percent: 100 },
    retention: { logs: 14, metrics: 90, traces: 7 },
    cardinalityBudget: 100000,
    tiers: [],
    installBaseUrl: "",
    outputDir: "~/.local/share/otel-settings",
    authMethod: "bearer",
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("settingsUrl derives settings.<domain> and is idempotent", () => {
  assertEquals(settingsUrl("otel.fi.gy"), "https://settings.otel.fi.gy");
  assertEquals(
    settingsUrl("settings.otel.fi.gy"),
    "https://settings.otel.fi.gy",
  );
});

Deno.test("installBaseUrl defaults under the settings host", () => {
  assertEquals(
    installBaseUrl("otel.fi.gy"),
    "https://settings.otel.fi.gy/install",
  );
  assertEquals(
    installBaseUrl("otel.fi.gy", "https://cdn/rel"),
    "https://cdn/rel",
  );
});

Deno.test("resolveTiers returns the defaults when none supplied", () => {
  assertEquals(resolveTiers([]).length, DEFAULT_TIERS.length);
  const custom = resolveTiers([{
    id: "TX",
    description: "",
    defaults: { agent: "x", receivers: [], push: false },
  }]);
  assertEquals(custom.length, 1);
  assertEquals(custom[0].id, "TX");
});

Deno.test("normaliseEndpoint fills full URLs from host:port", () => {
  const e = normaliseEndpoint({
    otlp_grpc: "otlp.fi.gy:4317",
    otlp_http: "otlp.fi.gy:4318",
    otlp_grpc_url: "",
    otlp_http_url: "",
    mesh: "tailscale",
  });
  assertEquals(e.otlp_grpc_url, "https://otlp.fi.gy:4317");
  assertEquals(e.otlp_http_url, "https://otlp.fi.gy:4318");
  assertEquals(e.name, "tailscale");
});

Deno.test("defaultEndpoint honours defaultMesh, else the first", () => {
  const s = buildSettings(globals());
  assertEquals(defaultEndpoint(s.endpoints, "wireguard")?.mesh, "wireguard");
  assertEquals(defaultEndpoint(s.endpoints, "nope")?.mesh, "tailscale");
  assertEquals(defaultEndpoint([], "x"), null);
});

Deno.test("buildSettings is deterministic for identical contracts", () => {
  const a = buildSettings(globals());
  const b = buildSettings(globals());
  assertEquals(a.contentHash, b.contentHash);
});

Deno.test("renderOtelJson carries endpoints, default, and resource attrs", () => {
  const s = buildSettings(globals());
  const json = JSON.parse(renderOtelJson(s));
  assertEquals(json.schema, "otel.settings/v1");
  assertEquals(json.default.mesh, "tailscale");
  assertEquals(json.resourceAttributes["deployment.environment"], "dev");
  assertEquals(json.resourceAttributes["host.name"], "node-1");
  assertEquals(json.retention.logs, 14);
});

Deno.test("renderOtelEnv emits the OTLP exporter variables", () => {
  const env = renderOtelEnv(buildSettings(globals()));
  assertStringIncludes(
    env,
    "OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.fi.gy:4317",
  );
  assertStringIncludes(env, "OTEL_EXPORTER_OTLP_PROTOCOL=grpc");
  assertStringIncludes(env, "deployment.environment=dev");
});

Deno.test("renderAgentConfig emits a complete, runnable config from the contract", () => {
  const s = buildSettings(globals());
  const t1 = s.tiers.find((t) => t.id === "T1")!;
  const cfg = renderAgentConfig(t1, s);
  // It is a real otelcol config, not a fragment: receivers, exporters, and
  // service.pipelines must all be present for the collector to start.
  assertStringIncludes(cfg, "receivers:");
  assertStringIncludes(cfg, "hostmetrics:");
  assertStringIncludes(cfg, "exporters:");
  assertStringIncludes(cfg, "endpoint: otlp.fi.gy:4317");
  assertStringIncludes(cfg, "service:");
  assertStringIncludes(cfg, "pipelines:");
  // The token is an env reference, never a literal.
  assertStringIncludes(cfg, "${env:OTEL_EXPORTER_OTLP_TOKEN}");
  assertStringIncludes(cfg, "key: deployment.environment");
  assertStringIncludes(cfg, "value: dev");
  // A tier that runs no agent still renders a valid config.
  const t3 = s.tiers.find((t) => t.id === "T3")!;
  assertStringIncludes(renderAgentConfig(t3, s), "service:");
});

Deno.test("renderInstallManifest points at per-os/arch assets", () => {
  const s = buildSettings(globals());
  const json = JSON.parse(renderInstallManifest("linux", "arm64", s));
  assertStringIncludes(json.tarballUrl, "linux_arm64.tar.gz");
  assertStringIncludes(json.settingsUrl, "settings.otel.fi.gy");
  // Served at the settings root under install/, not a /settings/ prefix.
  assertStringIncludes(json.tarballUrl, "https://settings.otel.fi.gy/install/");
  assert(!json.tarballUrl.includes("/settings/install"));
  // The mirror can find the upstream asset from the manifest.
  assertStringIncludes(json.upstreamTarballUrl, "github.com/open-telemetry");
  assertEquals(json.assetName, json.tarballUrl.split("/").pop());
  // Documents are served at the root, not under a /settings/ prefix.
  assertEquals(json.settingsUrl, `https://settings.otel.fi.gy/otel.json`);
  assertEquals(
    json.agentConfigBase,
    `https://settings.otel.fi.gy/agent-config`,
  );
});

Deno.test("buildDocuments produces the full stable URL set", () => {
  const s = buildSettings(globals());
  const docs = buildDocuments(s);
  const paths = docs.map((d) => d.path);
  assert(paths.includes("otel.json"));
  assert(paths.includes("otel.env"));
  assert(paths.includes("otel.md"));
  assert(paths.includes("index.html"));
  assert(paths.includes("agent-config/T1.yaml"));
  assert(paths.includes("install/linux-amd64.json"));
  assert(paths.includes("install/linux-arm64.json"));
  assert(paths.includes("install/linux-armv7.json"));
  for (const d of docs) {
    assertEquals(typeof d.contentType, "string");
    assert(d.content.length > 0, `${d.path} should not be empty`);
  }
});

Deno.test("renderIndexHtml is a landing page linking every document", () => {
  const s = buildSettings(globals());
  const html = renderIndexHtml(s);
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, "Observability settings");
  assertStringIncludes(html, `href="/otel.json"`);
  assertStringIncludes(html, `href="/agent-config/T0.yaml … T4.yaml"`);
  assertStringIncludes(html, s.domain);
  // The bare host serves this via file_server's index, so it must be self-contained.
  assert(!html.includes("404"));
});

Deno.test("renderVersionJson lists the documents", () => {
  const s = buildSettings(globals());
  const docs = buildDocuments(s).map((d) => ({
    path: d.path,
    contentType: d.contentType,
    bytes: d.content.length,
    sha256: "x",
  }));
  const v = JSON.parse(renderVersionJson(s, docs));
  assertEquals(v.version, s.contentHash);
  assert(v.documents.includes("otel.json"));
});

Deno.test("renderOtelMarkdown has endpoint and tier tables", () => {
  const md = renderOtelMarkdown(buildSettings(globals()));
  assertStringIncludes(md, "## Endpoints");
  assertStringIncludes(md, "| tailscale |");
  assertStringIncludes(md, "## Tiers");
});

Deno.test("validateSettings flags bad domains and empty endpoints", () => {
  const bad = validateSettings(globals({ domain: "notadomain" }));
  assert(bad.errors.length > 0);
  const noEndpoints = validateSettings(globals({ endpoints: [] }));
  assertEquals(noEndpoints.errors.length, 0);
  assert(noEndpoints.warnings.length > 0);
});

Deno.test("validateSettings warns on an unmatched defaultMesh", () => {
  const r = validateSettings(globals({ defaultMesh: "nope" }));
  assert(r.warnings.some((w) => w.includes("defaultMesh")));
});

Deno.test("valid-settings check fails for an invalid contract", () => {
  const result = model.checks["valid-settings"].execute({
    globalArgs: globals({ domain: "bad" }),
  });
  assertEquals(result.pass, false);
});

Deno.test("render writes documents and flips the current pointer", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const handles: string[] = [];
    const ctx = {
      globalArgs: globals({ outputDir: tmp }),
      writeResource: (
        spec: string,
        _name: string,
        _data: Record<string, unknown>,
      ) => {
        handles.push(spec);
        return Promise.resolve({ name: spec });
      },
    };
    const res = await model.methods.render.execute({}, ctx);
    assertEquals(res.dataHandles.length, 2);
    assert(handles.includes("settings"));
    assert(handles.includes("render"));
    const stat = await Deno.stat(`${tmp}/current/otel.json`);
    assert(stat.isFile);
    const raw = await Deno.readTextFile(`${tmp}/current/otel.json`);
    assertStringIncludes(raw, "otel.settings/v1");
    const versionJson = JSON.parse(
      await Deno.readTextFile(`${tmp}/current/version.json`),
    );
    assert(versionJson.documents.includes("otel.json"));
    // Re-render is idempotent and does not throw on the existing pointer.
    await model.methods.render.execute({}, ctx);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("status reports rendered=false before a render", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    let captured: Record<string, unknown> = {};
    const ctx = {
      globalArgs: globals({ outputDir: tmp }),
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        captured = data;
        return Promise.resolve({ name: "status" });
      },
    };
    await model.methods.status.execute({}, ctx);
    assertEquals(captured.rendered, false);
    assertEquals(captured.tierCount, DEFAULT_TIERS.length);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("contentHashHex and expandHome behave", () => {
  assertEquals(contentHashHex("a"), contentHashHex("a"));
  assert(contentHashHex("a") !== contentHashHex("b"));
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});
