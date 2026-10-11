import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1";

import {
  buildSyftArgs,
  expandHome,
  fnv1a,
  hostArch,
  hostOs,
  model,
  parseSyftVersion,
  resolveTarget,
  sbomInstanceName,
  summarizeBom,
} from "./generate_sbom_syft.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome expands a leading tilde", () => {
  const home = Deno.env.get("HOME") ?? "";
  if (!home) return;
  assertEquals(expandHome("~"), home);
  assertEquals(expandHome("~/x"), `${home}/x`);
  assertEquals(expandHome("/abs"), "/abs");
});

Deno.test("fnv1a is deterministic and 8 hex digits", () => {
  assertEquals(fnv1a("hello"), fnv1a("hello"));
  assertNotEquals(fnv1a("a"), fnv1a("b"));
  assertEquals(fnv1a("x").length, 8);
});

Deno.test("hostOs and hostArch return GoReleaser-style tokens", () => {
  assertEquals(["linux", "darwin", "windows"].includes(hostOs()), true);
  assertEquals(["amd64", "arm64"].includes(hostArch()), true);
});

Deno.test("resolveTarget honors known schemes and prepends unknown types", () => {
  // A known syft scheme is preserved verbatim.
  assertEquals(resolveTarget("", "dir:/srv"), "dir:/srv");
  assertEquals(resolveTarget("", "image:alpine:3.19"), "image:alpine:3.19");
  // A colon that is not a known scheme is NOT mistaken for one.
  assertEquals(
    resolveTarget("registry", "alpine:3.19"),
    "registry:alpine:3.19",
  );
  assertEquals(
    resolveTarget("image", "ghcr.io/acme/app:1.2"),
    "image:ghcr.io/acme/app:1.2",
  );
  // A bare path with a type.
  assertEquals(resolveTarget("dir", "/"), "dir:/");
  // No type and no scheme: left for syft to auto-detect.
  assertEquals(resolveTarget("", "/var/lib"), "/var/lib");
  // A Windows drive path is not treated as a scheme.
  assertEquals(resolveTarget("", "C:\\srv"), "C:\\srv");
});

Deno.test("sbomInstanceName prefers a sanitized label", () => {
  assertEquals(
    sbomInstanceName("my host", "cyclonedx-json", "dir:/"),
    "my-host",
  );
  const generated = sbomInstanceName("", "cyclonedx-json", "dir:/");
  assertEquals(generated.startsWith("sbom-"), true);
});

Deno.test("buildSyftArgs assembles the scan command", () => {
  const argv = buildSyftArgs({
    target: "dir:/",
    format: "cyclonedx-json",
    outputFile: "/tmp/out.json",
    catalogers: ["os", "python"],
    exclude: ["/proc", "/sys"],
    scope: "all-layers",
    platform: "linux/amd64",
    sourceName: "host",
    sourceVersion: "1.0",
  });
  assertEquals(argv[0], "scan");
  assertEquals(argv[1], "dir:/");
  assertEquals(
    argv[argv.indexOf("--output") + 1],
    "cyclonedx-json=/tmp/out.json",
  );
  assertEquals(argv.includes("--quiet"), true);
  assertEquals(argv.filter((a) => a === "--catalogers").length, 2);
  assertEquals(argv.filter((a) => a === "--exclude").length, 2);
  assertEquals(argv[argv.indexOf("--scope") + 1], "all-layers");
  assertEquals(argv[argv.indexOf("--platform") + 1], "linux/amd64");
  assertEquals(argv[argv.indexOf("--source-name") + 1], "host");
  assertEquals(argv[argv.indexOf("--source-version") + 1], "1.0");
});

Deno.test("buildSyftArgs omits optional flags when unset", () => {
  const argv = buildSyftArgs({
    target: "file:/bin/ls",
    format: "syft-json",
    outputFile: "/tmp/o.json",
    catalogers: [],
    exclude: [],
    scope: "",
    platform: "",
    sourceName: "",
    sourceVersion: "",
  });
  assertEquals(argv.includes("--catalogers"), false);
  assertEquals(argv.includes("--exclude"), false);
  assertEquals(argv.includes("--scope"), false);
  assertEquals(argv.includes("--platform"), false);
  assertEquals(argv.includes("--source-name"), false);
});

Deno.test("summarizeBom reads CycloneDX component metadata", () => {
  const summary = summarizeBom("cyclonedx-json", {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    components: [{ name: "a" }, { name: "b" }],
    metadata: { component: { name: "my-host", version: "1.0" } },
  });
  assertEquals(summary.packageCount, 2);
  assertEquals(summary.bomFormat, "CycloneDX");
  assertEquals(summary.specVersion, "1.7");
  assertEquals(summary.sourceName, "my-host");
  assertEquals(summary.sourceVersion, "1.0");
});

Deno.test("summarizeBom reports zero components when absent", () => {
  const summary = summarizeBom("cyclonedx-json", {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
  });
  assertEquals(summary.packageCount, 0);
});

Deno.test("summarizeBom reads SPDX and syft-json shapes", () => {
  const spdx = summarizeBom("spdx-json", {
    spdxVersion: "SPDX-2.3",
    name: "alpine",
    packages: [{}, {}, {}],
  });
  assertEquals(spdx.bomFormat, "SPDX");
  assertEquals(spdx.specVersion, "SPDX-2.3");
  assertEquals(spdx.packageCount, 3);
  assertEquals(spdx.sourceName, "alpine");

  const syft = summarizeBom("syft-json", {
    artifacts: [{}],
    source: { name: "curl", version: "sha256:abc" },
  });
  assertEquals(syft.bomFormat, "syft");
  assertEquals(syft.packageCount, 1);
  assertEquals(syft.sourceName, "curl");
  assertEquals(syft.sourceVersion, "sha256:abc");
});

Deno.test("summarizeBom tolerates non-object input", () => {
  const summary = summarizeBom("cyclonedx-json", null);
  assertEquals(summary.packageCount, 0);
  assertEquals(summary.bomFormat, "CycloneDX");
});

Deno.test("parseSyftVersion reads JSON and plain output", () => {
  assertEquals(parseSyftVersion('{"version":"1.54.1"}'), "1.54.1");
  assertEquals(parseSyftVersion("syft 1.54.1\n"), "1.54.1");
  assertEquals(parseSyftVersion(""), null);
  assertEquals(parseSyftVersion("no version here"), null);
});

// ---------------------------------------------------------------------------
// Integration (fake syft binary; no network)
// ---------------------------------------------------------------------------

interface Captured {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

const FAKE_SYFT = `#!/usr/bin/env bash
if [ "$1" = "version" ]; then
  echo '{"version":"9.9.9"}'
  exit 0
fi
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="\${2#*=}" ;;
  esac
  shift
done
if [ "\${FAKE_SYFT_FAIL:-}" = "1" ]; then
  echo "boom" 1>&2
  exit 3
fi
printf '%s' '{"bomFormat":"CycloneDX","specVersion":"1.7","components":[{"name":"a"},{"name":"b"},{"name":"c"}],"metadata":{"component":{"name":"fake-src","version":"1.0"}}}' > "$out"
`;

async function writeFakeSyft(dir: string): Promise<string> {
  const path = `${dir}/syft`;
  await Deno.writeTextFile(path, FAKE_SYFT);
  await Deno.chmod(path, 0o755);
  return path;
}

function makeContext(globals: Record<string, unknown>) {
  const written: Captured[] = [];
  const files: Record<string, Uint8Array> = {};
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    definition: { id: "test", name: "gen", version: "1" },
    logger: { info: () => {}, warn: () => {} },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
    createFileWriter: (
      _specName: string,
      name: string,
      _overrides?: { contentType?: string },
    ) => ({
      writeAll: (bytes: Uint8Array) => {
        files[name] = bytes;
        return Promise.resolve({ name });
      },
    }),
  };
  return { context, written, files };
}

function genArgs(partial: Record<string, unknown>) {
  return model.methods.generate.arguments.parse(partial);
}

Deno.test("generate runs syft, writes the sbom file and a scan summary", async () => {
  const dir = await Deno.makeTempDir({ prefix: "syft-test-" });
  try {
    const syft = await writeFakeSyft(dir);
    const { context, written, files } = makeContext({
      syftPath: syft,
      stateDir: dir,
    });
    await model.methods.generate.execute(
      genArgs({ target: "/", targetType: "dir", label: "host" }),
      context,
    );
    const scan = written.find((w) => w.specName === "scan")!.data;
    assertEquals(scan.packageCount, 3);
    assertEquals(scan.sbomFormat, "CycloneDX");
    assertEquals(scan.specVersion, "1.7");
    assertEquals(scan.sourceName, "fake-src");
    assertEquals(scan.toolVersion, "9.9.9");
    assertEquals(scan.format, "cyclonedx-json");
    assertEquals(scan.target, "dir:/");
    assertEquals(scan.exitCode, 0);
    const doc = JSON.parse(new TextDecoder().decode(files["host"]));
    assertEquals(doc.bomFormat, "CycloneDX");
    assertEquals(doc.components.length, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate writes the SBOM to outputFile as well", async () => {
  const dir = await Deno.makeTempDir({ prefix: "syft-test-" });
  try {
    const syft = await writeFakeSyft(dir);
    const out = `${dir}/nested/out.json`;
    const { context, written } = makeContext({ syftPath: syft, stateDir: dir });
    await model.methods.generate.execute(
      genArgs({
        target: "alpine:3.19",
        targetType: "registry",
        label: "img",
        outputFile: out,
      }),
      context,
    );
    const scan = written.find((w) => w.specName === "scan")!.data;
    assertEquals(scan.target, "registry:alpine:3.19");
    assertEquals(scan.outputFile, out);
    const bytes = await Deno.readFile(out);
    assertEquals(bytes.byteLength > 0, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate fails when syft exits non-zero", async () => {
  const dir = await Deno.makeTempDir({ prefix: "syft-test-" });
  try {
    const syft = await writeFakeSyft(dir);
    const { context } = makeContext({
      syftPath: syft,
      stateDir: dir,
      // pass the failure through the child environment
    });
    // The fake reads FAKE_SYFT_FAIL from the process env; Deno passes the
    // parent environment through, so set it for this test.
    const prev = Deno.env.get("FAKE_SYFT_FAIL");
    Deno.env.set("FAKE_SYFT_FAIL", "1");
    try {
      await assertRejects(
        () =>
          model.methods.generate.execute(
            genArgs({ target: "/tmp", targetType: "dir" }),
            context,
          ),
        Error,
        "syft scan failed",
      );
    } finally {
      if (prev === undefined) Deno.env.delete("FAKE_SYFT_FAIL");
      else Deno.env.set("FAKE_SYFT_FAIL", prev);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install with a syftPath records the tool without downloading", async () => {
  const dir = await Deno.makeTempDir({ prefix: "syft-test-" });
  try {
    const syft = await writeFakeSyft(dir);
    const { context, written } = makeContext({ syftPath: syft, stateDir: dir });
    await model.methods.install.execute(
      model.methods.install.arguments.parse({ force: false }),
      context,
    );
    const tool = written.find((w) => w.specName === "tool")!.data;
    assertEquals(tool.source, "path");
    assertEquals(tool.version, "9.9.9");
    assertEquals(tool.path, syft);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install rejects a syftPath that is not runnable", async () => {
  const dir = await Deno.makeTempDir({ prefix: "syft-test-" });
  try {
    const { context } = makeContext({ syftPath: `${dir}/nope`, stateDir: dir });
    await assertRejects(
      () =>
        model.methods.install.execute(
          model.methods.install.arguments.parse({ force: false }),
          context,
        ),
      Error,
      "did not respond",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status reports readiness from a syftPath", async () => {
  const dir = await Deno.makeTempDir({ prefix: "syft-test-" });
  try {
    const syft = await writeFakeSyft(dir);
    const { context, written } = makeContext({ syftPath: syft, stateDir: dir });
    await model.methods.status.execute(
      model.methods.status.arguments.parse({}),
      context,
    );
    const status = written.find((w) => w.specName === "status")!.data;
    assertEquals(status.ready, true);
    assertEquals(status.toolPath, syft);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
