/**
 * Execute-level tests for the `@svendowideit/ollama` model.
 *
 * Drives the real method executes through `createModelTestContext` with the
 * command layer mocked by `withMockedCommand`. Covers `plan` (platform/asset/
 * scope resolution), `install` (tar.zst extraction + idempotency, against a
 * real archive fixture), `uninstall`, `createService` (full unit),
 * `configureService` (drop-in) and `restartService`. Service unit directories
 * are redirected to a temp dir via the `unitDir` global so nothing touches
 * `/etc`.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";

import {
  fetchServerVersion,
  model,
  parseClientVersions,
  resetPrivilegeCache,
  resolveOllamaHost,
} from "./ollama.ts";
import { OLLAMA_ASSET_PATTERN } from "./ollama_shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseGlobals(overrides: Record<string, unknown> = {}) {
  return {
    os: "Linux",
    arch: "x86_64",
    accel: "base",
    installDir: "",
    downloadDir: "~/.cache/ollama",
    serviceName: "ollama",
    serviceScope: "user",
    serviceUser: "ollama",
    serviceGroup: "ollama",
    host: "",
    environment: [],
    extraEnvironment: "",
    extraArgs: "",
    restart: "always",
    restartSec: "3",
    sudo: "sudo",
    sudoNonInteractive: true,
    unitDir: "/tmp/ollama-test-units",
    ...overrides,
  };
}

// deno-lint-ignore no-explicit-any
async function runMethod(name: string, opts: any = {}) {
  // The privilege probe is memoized per process; clear it so a test that
  // simulates a different host (root vs no-sudo) is not served a stale result.
  resetPrivilegeCache();
  const ctx = createModelTestContext({
    globalArgs: baseGlobals(opts.globalArgs ?? {}),
    methodName: name,
    storedResources: opts.storedResources ?? {},
  });
  // Real swamp parses method arguments through the zod schema (applying
  // defaults); the test harness passes them straight through, so do it here.
  // deno-lint-ignore no-explicit-any
  const schema = (model.methods as any)[name].arguments;
  const parsed = schema.parse(opts.args ?? {});
  // The command layer is always mocked so the tests are deterministic: the
  // default handler reports root (uid 0) and success, so privileged paths run
  // without touching the host. Tests that assert the no-escalation path pass
  // their own `handler`.
  // deno-lint-ignore no-explicit-any
  let result: any;
  if (opts.raw) {
    // Run against the real command layer. Needed for the tar.zst install tests:
    // extraction streams through `zstd` via Deno.Command.spawn(), which the
    // command mock cannot intercept (and temp-dir installs need no escalation).
    // deno-lint-ignore no-explicit-any
    const methodsAny = model.methods as any;
    result = await methodsAny[name].execute(parsed, ctx.context);
  } else {
    const handler = opts.handler ?? rootHandler();
    await withMockedCommand(handler, async () => {
      // deno-lint-ignore no-explicit-any
      const methodsAny = model.methods as any;
      result = await methodsAny[name].execute(parsed, ctx.context);
    });
  }
  // Mechanical schema-write conformance: every resource a method writes must
  // validate against the schema declared for that spec in the model.
  for (const w of ctx.getWrittenResources()) {
    // deno-lint-ignore no-explicit-any
    const def = (model.resources as any)[w.specName];
    assertEquals(
      def !== undefined,
      true,
      `no resource schema for ${w.specName}`,
    );
    const parsedData = def.schema.safeParse(w.data);
    assertEquals(
      parsedData.success,
      true,
      `resource '${w.specName}' did not match its schema: ${
        !parsedData.success
          ? JSON.stringify(
            // deno-lint-ignore no-explicit-any
            parsedData.error.issues.map((i: any) =>
              `${i.path.join(".")}: ${i.message}`
            ),
          )
          : ""
      }`,
    );
  }
  return { result, ctx };
}

/**
 * A command handler simulating a host where swamp runs as root (or has
 * passwordless sudo): `id -u` reports 0, every command succeeds, and uname
 * reports Linux/x86_64.
 */
function rootHandler() {
  return (command: string, args: string[]) => {
    if (command === "uname" && args[0] === "-s") {
      return { stdout: "Linux\n", code: 0 };
    }
    if (command === "uname" && args[0] === "-m") {
      return { stdout: "x86_64\n", code: 0 };
    }
    if (command === "zstd" && args[0] === "--version") {
      return { stdout: "zstd 1.5.5\n", code: 0 };
    }
    if (command === "id" && args[0] === "-u") {
      return { stdout: "0\n", code: 0 };
    }
    if (command === "systemctl") return { stdout: "", code: 0 };
    if (command === "id") return { stdout: "0\n", code: 0 };
    return { stdout: "", code: 0 };
  };
}

/**
 * A command handler simulating a host where swamp runs as an ordinary user
 * (uid 1000) with no passwordless sudo. `sudo -n true` fails, so methods that
 * need root must hand back manual instructions instead of escalating.
 */
function noSudoHandler() {
  return (command: string, args: string[]) => {
    if (command === "uname" && args[0] === "-s") {
      return { stdout: "Linux\n", code: 0 };
    }
    if (command === "uname" && args[0] === "-m") {
      return { stdout: "x86_64\n", code: 0 };
    }
    if (command === "id" && args[0] === "-u") {
      return { stdout: "1000\n", code: 0 };
    }
    if (command === "id") return { stdout: "1000\n", code: 0 };
    if (command === "which" && args[0] === "sudo") {
      return { stdout: "/usr/bin/sudo\n", code: 0 };
    }
    // `sudo -n true` and any escalated command fail as they would with no tty.
    if (command === "sudo") {
      return { stdout: "", stderr: "sudo: a password is required\n", code: 1 };
    }
    if (command === "systemctl") return { stdout: "", code: 0 };
    return { stdout: "", code: 0 };
  };
}

/** Build a real tar.zst fixture shaped like Ollama's Linux release. */
async function buildOllamaTarZst(): Promise<{ path: string; dir: string }> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  await Deno.mkdir(`${dir}/lib/ollama`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/bin/ollama`,
    "#!/bin/sh\necho 'ollama version is 0.35.0'\n",
  );
  await Deno.chmod(`${dir}/bin/ollama`, 0o755);
  await Deno.writeTextFile(`${dir}/lib/ollama/libggml.so`, "LIBRARY");
  const out = `${dir}/ollama-linux-amd64.tar.zst`;
  const cmd = new Deno.Command("tar", {
    args: ["--zstd", "-cf", out, "-C", dir, "bin", "lib"],
    stdout: "null",
    stderr: "null",
  });
  assertEquals((await cmd.output()).code, 0);
  return { path: out, dir };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

Deno.test("resolveOllamaHost reads the env override or returns null", () => {
  assertEquals(
    resolveOllamaHost({ get: () => "http://x:11434" }),
    "http://x:11434",
  );
  assertEquals(resolveOllamaHost({ get: () => "  " }), null);
  assertEquals(resolveOllamaHost({ get: () => undefined }), null);
});

Deno.test("fetchServerVersion rewrites bind addresses to loopback", async () => {
  // No server on these ports; the point is the URL construction, so assert
  // the failure mentions the probed host, not a crash.
  const result = await fetchServerVersion("0.0.0.0:59999");
  assertEquals(result.version, null);
});

Deno.test("parseClientVersions reads the ollama version line", () => {
  assertEquals(parseClientVersions("ollama version is 0.35.1"), "0.35.1");
  assertEquals(parseClientVersions("ollama version 0.33.3"), "0.33.3");
  assertEquals(parseClientVersions("no version here"), null);
});

Deno.test("plan resolves Linux/amd64 base to the Ollama asset", async () => {
  const { ctx } = await runMethod("plan", {
    globalArgs: { serviceScope: "system" },
  });
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "platform");
  const d = written[0].data as Record<string, unknown>;
  assertEquals(d.os, "Linux");
  assertEquals(d.arch, "x86_64");
  assertEquals(d.accel, "base");
  assertEquals(d.stem, "ollama-linux-amd64");
  assertEquals(d.assetName, "ollama-linux-amd64.tar.zst");
  assertEquals(d.assetPattern, OLLAMA_ASSET_PATTERN);
  assertEquals(d.format, "tar.zst");
  assertEquals(d.installDir, "/usr/local/bin");
  assertEquals(d.libDir, "/usr/local/lib/ollama");
  assertEquals(d.serviceScope, "system");
  assertEquals(d.supported, true);
});

Deno.test("plan maps macOS to ollama-darwin.tgz and no service command", async () => {
  const { ctx } = await runMethod("plan", {
    globalArgs: { os: "Darwin", arch: "arm64" },
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.stem, "ollama-darwin");
  assertEquals(d.assetName, "ollama-darwin.tgz");
  assertEquals(d.format, "tgz");
  assertEquals(d.serviceStatusCommand, null);
});

Deno.test("plan maps a rocm accelerator to the rocm asset", async () => {
  const { ctx } = await runMethod("plan", {
    globalArgs: { accel: "rocm" },
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.stem, "ollama-linux-amd64-rocm");
  assertEquals(d.assetName, "ollama-linux-amd64-rocm.tar.zst");
});

Deno.test("plan detects an existing system unit when scope is auto", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${unitDir}/ollama.service`,
      "[Unit]\nDescription=x\n",
    );
    const { ctx } = await runMethod("plan", {
      globalArgs: { serviceScope: "auto", unitDir },
    });
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.serviceScope, "system");
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

Deno.test("stage extracts a verified tar.zst archive to a staging dir", async () => {
  const fixture = await buildOllamaTarZst();
  let stagedDir: string | null = null;
  try {
    const { ctx } = await runMethod("stage", {
      raw: true,
      args: {
        version: "0.35.0",
        archivePath: fixture.path,
        archiveName: "ollama-linux-amd64.tar.zst",
        checksum: "",
      },
    });
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.staged, true);
    assertEquals(d.version, "0.35.0");
    assertEquals(d.binaryPath !== null, true);
    assertEquals((d.binaryPath as string).includes("/bin/ollama"), true);
    assertEquals((d.libDir as string).endsWith("lib/ollama"), true);
    assertEquals((d.fileCount as number) >= 2, true);
    // The staging dir must actually exist with the binary in it.
    const stat = await Deno.stat(`${d.stagingDir}/bin/ollama`);
    assertEquals(stat.isFile, true);
    stagedDir = d.stagingDir as string;
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
    if (stagedDir) {
      await Deno.remove(stagedDir, { recursive: true });
    }
  }
});

Deno.test("stage refuses an archive with a bad checksum", async () => {
  const fixture = await buildOllamaTarZst();
  try {
    await assertRejects(() =>
      runMethod("stage", {
        raw: true,
        args: {
          version: "0.35.0",
          archivePath: fixture.path,
          archiveName: "ollama-linux-amd64.tar.zst",
          checksum:
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
      })
    );
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("stage requires an archivePath", async () => {
  await assertRejects(() => runMethod("stage", { args: {} }));
});

Deno.test("prepareService stages a unit when none exists", async () => {
  const fixture = await buildOllamaTarZst();
  try {
    // Stage first (real commands, so extraction happens), then prepare.
    const staged = await runMethod("stage", {
      raw: true,
      args: {
        version: "0.35.0",
        archivePath: fixture.path,
        archiveName: "ollama-linux-amd64.tar.zst",
        checksum: "",
      },
    });
    const stagingDir = (staged.ctx.getWrittenResources()[0].data as Record<
      string,
      unknown
    >).stagingDir as string;

    const prepared = await runMethod("prepareService", {
      globalArgs: { serviceScope: "system", unitDir: "/tmp/ollama-test-units" },
      storedResources: {
        stage: {
          staged: true,
          skipped: false,
          stagingDir,
        },
      },
      handler: (command: string, args: string[]) => {
        if (command === "systemctl" && args.includes("cat")) {
          return { stdout: "", stderr: "no such file\n", code: 1 };
        }
        return { stdout: "", code: 0 };
      },
    });
    const d = prepared.ctx.getWrittenResources()[0].data as Record<
      string,
      unknown
    >;
    assertEquals(d.unitCreated, true);
    assertEquals(d.usedDropIn, false);
    const unitStaged = d.unitStagedPath as string;
    const content = await Deno.readTextFile(unitStaged);
    assertEquals(content.includes("ExecStart="), true);
    assertEquals(content.includes("User=ollama"), true);
    const dropIn = await Deno.readTextFile(d.dropInStagedPath as string);
    assertEquals(dropIn.includes("[Service]"), true);
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("plan with manageService=false reports binary only", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${unitDir}/ollama.service`,
      "[Unit]\nDescription=x\n",
    );
    const { ctx } = await runMethod("plan", {
      globalArgs: { serviceScope: "system", unitDir, manageService: "false" },
    });
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.manageService, false);
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

Deno.test("plan with manageService auto detects an existing unit", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${unitDir}/ollama.service`,
      "[Unit]\nDescription=x\n",
    );
    const { ctx } = await runMethod("plan", {
      globalArgs: { serviceScope: "system", unitDir, manageService: "auto" },
    });
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.manageService, true);
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

Deno.test("plan with manageService auto and no unit reports binary only", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    const { ctx } = await runMethod("plan", {
      globalArgs: { serviceScope: "system", unitDir, manageService: "auto" },
      handler: (command: string, args: string[]) => {
        if (command === "uname" && args[0] === "-s") {
          return { stdout: "Linux\n", code: 0 };
        }
        if (command === "uname" && args[0] === "-m") {
          return { stdout: "x86_64\n", code: 0 };
        }
        if (command === "id") return { stdout: "0\n", code: 0 };
        if (command === "systemctl" && args.includes("cat")) {
          return { stdout: "", stderr: "no such file\n", code: 1 };
        }
        return { stdout: "", code: 0 };
      },
    });
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.manageService, false);
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------

Deno.test("assess reports an update when latest is newer", async () => {
  const { ctx } = await runMethod("assess", {
    storedResources: { installed: { present: true, version: "0.33.3" } },
    args: { latestVersion: "0.35.0" },
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.installedVersion, "0.33.3");
  assertEquals(d.latestVersion, "0.35.0");
  assertEquals(d.updateAvailable, true);
  assertEquals(d.upToDate, false);
});

Deno.test("assess reports up to date when versions match", async () => {
  const { ctx } = await runMethod("assess", {
    storedResources: { installed: { present: true, version: "v0.35.0" } },
    args: { latestVersion: "0.35.0" },
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.updateAvailable, false);
  assertEquals(d.upToDate, true);
});

Deno.test("assess treats a missing install as an update", async () => {
  const { ctx } = await runMethod("assess", {
    storedResources: { installed: { present: false, version: null } },
    args: { latestVersion: "0.35.0" },
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.installedVersion, null);
  assertEquals(d.updateAvailable, true);
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

Deno.test("install extracts a verified tar.zst into the install dir", async () => {
  const fixture = await buildOllamaTarZst();
  const installDir = await Deno.makeTempDir();
  try {
    const { ctx } = await runMethod("install", {
      raw: true,
      globalArgs: { installDir, serviceScope: "user", unitDir: installDir },
      args: {
        archivePath: fixture.path,
        archiveName: "ollama-linux-amd64.tar.zst",
        version: "0.35.0",
        checksum: "",
        verifyArchive: false,
      },
    });
    const install = ctx.getWrittenResources().find(
      (r) => r.specName === "install",
    )!;
    const d = install.data as Record<string, unknown>;
    assertEquals(d.installed, true);
    assertEquals(d.skipped, false);
    assertEquals(d.version, "0.35.0");
    assertEquals(d.accel, "base");
    assertEquals(d.path, `${installDir}/ollama`);
    const content = await Deno.readTextFile(`${installDir}/ollama`);
    assertStringIncludes(content, "ollama version is 0.35.0");
    // The runtime lib is installed alongside the binary.
    assertStringIncludes(
      await Deno.readTextFile(`${installDir}/../lib/ollama/libggml.so`),
      "LIBRARY",
    );
  } finally {
    await Deno.remove(installDir, { recursive: true });
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("install verifies the archive checksum and refuses a mismatch", async () => {
  const fixture = await buildOllamaTarZst();
  const installDir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        runMethod("install", {
          raw: true,
          globalArgs: {
            installDir,
            serviceScope: "user",
            unitDir: installDir,
          },
          args: {
            archivePath: fixture.path,
            archiveName: "ollama-linux-amd64.tar.zst",
            version: "0.35.0",
            checksum: "0".repeat(64),
            verifyArchive: true,
          },
        }),
      Error,
      "Checksum mismatch",
    );
  } finally {
    await Deno.remove(installDir, { recursive: true });
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("install accepts a matching archive checksum", async () => {
  const fixture = await buildOllamaTarZst();
  const installDir = await Deno.makeTempDir();
  try {
    const bytes = await Deno.readFile(fixture.path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const { ctx } = await runMethod("install", {
      raw: true,
      globalArgs: { installDir, serviceScope: "user", unitDir: installDir },
      args: {
        archivePath: fixture.path,
        archiveName: "ollama-linux-amd64.tar.zst",
        version: "0.35.0",
        checksum: hex,
        verifyArchive: true,
      },
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "install",
    )!.data as Record<string, unknown>;
    assertEquals(d.installed, true);
    assertEquals(d.checksumVerified, true);
  } finally {
    await Deno.remove(installDir, { recursive: true });
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("install skips when the target version is already installed", async () => {
  const fixture = await buildOllamaTarZst();
  const installDir = await Deno.makeTempDir();
  try {
    // Pre-place a matching binary so the model sees 0.35.0 already present.
    await Deno.writeTextFile(
      `${installDir}/ollama`,
      "#!/bin/sh\necho 'ollama version is 0.35.0'\n",
    );
    await Deno.chmod(`${installDir}/ollama`, 0o755);
    const { ctx } = await runMethod("install", {
      raw: true,
      globalArgs: { installDir, serviceScope: "user", unitDir: installDir },
      args: {
        archivePath: fixture.path,
        archiveName: "ollama-linux-amd64.tar.zst",
        version: "0.35.0",
        verifyArchive: false,
      },
    });
    const install = ctx.getWrittenResources().find(
      (r) => r.specName === "install",
    )!;
    const d = install.data as Record<string, unknown>;
    assertEquals(d.skipped, true);
    assertEquals(d.installed, false);
  } finally {
    await Deno.remove(installDir, { recursive: true });
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("install extracts a macOS tgz (binary at the archive root)", async () => {
  const dir = await Deno.makeTempDir();
  const installDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/ollama`,
      "#!/bin/sh\necho 'ollama version is 0.35.0'\n",
    );
    await Deno.chmod(`${dir}/ollama`, 0o755);
    const archivePath = `${dir}/ollama-darwin.tgz`;
    assertEquals(
      (await new Deno.Command("tar", {
        args: ["-czf", archivePath, "-C", dir, "ollama"],
        stdout: "null",
        stderr: "null",
      }).output()).code,
      0,
    );
    const { ctx } = await runMethod("install", {
      raw: true,
      globalArgs: { installDir, serviceScope: "user", unitDir: installDir },
      args: {
        archivePath,
        archiveName: "ollama-darwin.tgz",
        version: "0.35.0",
        verifyArchive: false,
      },
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "install",
    )!.data as Record<string, unknown>;
    assertEquals(d.installed, true);
    assertEquals(d.os, "Darwin");
    assertStringIncludes(
      await Deno.readTextFile(`${installDir}/ollama`),
      "0.35.0",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(installDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// createService / configureService / restartService
// ---------------------------------------------------------------------------

Deno.test("createService writes a full unit when none exists", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    const { ctx } = await runMethod("createService", {
      globalArgs: {
        serviceScope: "user",
        unitDir,
        extraArgs: "--flash-attention",
      },
      args: {
        binaryPath: "/tmp/bin/ollama",
      },
    });
    const created = ctx.getWrittenResources().find(
      (r) => r.specName === "serviceCreate",
    )!;
    const d = created.data as Record<string, unknown>;
    assertEquals(d.written, true);
    assertEquals(d.existed, false);
    const unit = await Deno.readTextFile(`${unitDir}/ollama.service`);
    assertStringIncludes(
      unit,
      "ExecStart=/tmp/bin/ollama serve --flash-attention",
    );
    assertStringIncludes(unit, "WantedBy=default.target");
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

Deno.test("createService leaves an existing unit untouched without force", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${unitDir}/ollama.service`,
      "# upstream unit\n",
    );
    const { ctx } = await runMethod("createService", {
      globalArgs: { serviceScope: "user", unitDir },
      args: { binaryPath: "/tmp/bin/ollama" },
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "serviceCreate",
    )!.data as Record<string, unknown>;
    assertEquals(d.existed, true);
    assertEquals(d.written, false);
    assertEquals(
      await Deno.readTextFile(`${unitDir}/ollama.service`),
      "# upstream unit\n",
    );
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

Deno.test("configureService writes a drop-in over an existing unit", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${unitDir}/ollama.service`, "# upstream\n");
    const { ctx } = await runMethod("configureService", {
      globalArgs: { serviceScope: "user", unitDir },
      args: {
        host: "0.0.0.0:11434",
        environment: ["OLLAMA_MODELS=/mnt/models"],
      },
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "config",
    )!.data as Record<string, unknown>;
    assertEquals(d.usedDropIn, true);
    assertEquals(d.unitCreated, false);
    const dropIn = await Deno.readTextFile(
      `${unitDir}/ollama.service.d/10-swamp.conf`,
    );
    assertStringIncludes(dropIn, "Environment=OLLAMA_HOST=0.0.0.0:11434");
    assertStringIncludes(dropIn, "Environment=OLLAMA_MODELS=/mnt/models");
    // The upstream unit is untouched.
    assertEquals(
      await Deno.readTextFile(`${unitDir}/ollama.service`),
      "# upstream\n",
    );
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

Deno.test("configureService creates a full unit when none exists", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    const { ctx } = await runMethod("configureService", {
      globalArgs: { serviceScope: "user", unitDir },
      args: { host: "127.0.0.1:11434" },
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "config",
    )!.data as Record<string, unknown>;
    assertEquals(d.usedDropIn, false);
    assertEquals(d.unitCreated, true);
    const unit = await Deno.readTextFile(`${unitDir}/ollama.service`);
    assertStringIncludes(unit, "Environment=OLLAMA_HOST=127.0.0.1:11434");
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

Deno.test("restartService enables, restarts and verifies active", async () => {
  const calls: string[] = [];
  const unitDir = await Deno.makeTempDir();
  try {
    const handler = (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (command === "uname" && args[0] === "-s") {
        return { stdout: "Linux\n", code: 0 };
      }
      if (command === "uname" && args[0] === "-m") {
        return { stdout: "x86_64\n", code: 0 };
      }
      if (command === "id" && args[0] === "-u") {
        return { stdout: "0\n", code: 0 };
      }
      if (command === "systemctl") return { stdout: "active\n", code: 0 };
      return { stdout: "", code: 0 };
    };
    const { ctx } = await runMethod("restartService", {
      globalArgs: { serviceScope: "user", unitDir },
      args: { enable: true },
      // deno-lint-ignore no-explicit-any
      handler: handler as any,
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "service",
    )!.data as Record<string, unknown>;
    assertEquals(d.active, true);
    assertEquals(
      calls.some((c) => c.includes("systemctl --user enable ollama")),
      true,
    );
    assertEquals(
      calls.some((c) => c.includes("systemctl --user restart ollama")),
      true,
    );
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

Deno.test("uninstall removes the binary and reports it gone", async () => {
  const installDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${installDir}/ollama`,
      "#!/bin/sh\necho 'ollama version is 0.35.0'\n",
    );
    await Deno.chmod(`${installDir}/ollama`, 0o755);
    const { ctx } = await runMethod("uninstall", {
      raw: true,
      globalArgs: { serviceScope: "user", unitDir: installDir },
      args: { path: `${installDir}/ollama` },
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "uninstall",
    )!.data as Record<string, unknown>;
    assertEquals(d.removed, true);
    assertEquals(d.version, "0.35.0");
    assertEquals(
      await Deno.stat(`${installDir}/ollama`).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(installDir, { recursive: true });
  }
});

Deno.test("uninstall is a no-op when no binary is present", async () => {
  const installDir = await Deno.makeTempDir();
  try {
    const { ctx } = await runMethod("uninstall", {
      raw: true,
      globalArgs: { serviceScope: "user", unitDir: installDir },
      args: { path: `${installDir}/ollama` },
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "uninstall",
    )!.data as Record<string, unknown>;
    assertEquals(d.removed, false);
    assertEquals(d.skipped, true);
  } finally {
    await Deno.remove(installDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Privilege detection and manual instructions
// ---------------------------------------------------------------------------

Deno.test("privilege reports root when the process is root", async () => {
  const { ctx } = await runMethod("privilege", {
    globalArgs: { serviceScope: "system" },
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.isRoot, true);
  assertEquals(d.mode, "root");
});

Deno.test("privilege reports passwordless sudo", async () => {
  const handler = (command: string, args: string[]) => {
    if (command === "id" && args[0] === "-u") {
      return { stdout: "1000\n", code: 0 };
    }
    if (command === "which" && args[0] === "sudo") {
      return { stdout: "/usr/bin/sudo\n", code: 0 };
    }
    if (command === "sudo" && args[0] === "-n") {
      return { stdout: "", code: 0 };
    }
    return { stdout: "", code: 0 };
  };
  const { ctx } = await runMethod("privilege", {
    // deno-lint-ignore no-explicit-any
    handler: handler as any,
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.mode, "sudo");
  assertEquals(d.passwordless, true);
});

Deno.test("privilege reports sudo-prompt when a password is required", async () => {
  const { ctx } = await runMethod("privilege", {
    // deno-lint-ignore no-explicit-any
    handler: noSudoHandler() as any,
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.mode, "sudo-prompt");
  assertEquals(d.passwordless, false);
});

Deno.test("plan warns and emits manual commands when root is unreachable", async () => {
  const { ctx } = await runMethod("plan", {
    globalArgs: { serviceScope: "system", installDir: "/usr/local/bin" },
    // deno-lint-ignore no-explicit-any
    handler: noSudoHandler() as any,
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.canEscalate, false);
  assertEquals(d.requiresRoot, true);
  assertEquals(d.privilegeMode, "sudo-prompt");
  const manual = d.manualCommands as string[];
  assertEquals(manual.length > 0, true);
  assertStringIncludes(manual.join("\n"), "serviceScope=user");
});

Deno.test("install prints manual commands instead of failing without root", async () => {
  const fixture = await buildOllamaTarZst();
  // A root-owned directory: /usr/local/bin is not writable in the test env.
  try {
    const { ctx } = await runMethod("install", {
      globalArgs: { serviceScope: "system", installDir: "/usr/local/bin" },
      args: {
        archivePath: fixture.path,
        archiveName: "ollama-linux-amd64.tar.zst",
        version: "0.35.0",
        verifyArchive: false,
      },
      // deno-lint-ignore no-explicit-any
      handler: noSudoHandler() as any,
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "install",
    )!.data as Record<string, unknown>;
    assertEquals(d.skipped, true);
    assertEquals(d.installed, false);
    assertEquals(d.requiresRoot, true);
    const manual = d.manualCommands as string[];
    assertEquals(manual.length > 0, true);
    const joined = manual.join("\n");
    assertStringIncludes(joined, "sudo");
    assertStringIncludes(joined, "useradd");
    assertStringIncludes(joined, "systemctl daemon-reload");
    assertStringIncludes(joined, "OLLAMA_UNIT");
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test("createService prints manual commands for a system unit without root", async () => {
  const unitDir = await Deno.makeTempDir();
  try {
    const { ctx } = await runMethod("createService", {
      globalArgs: { serviceScope: "system", unitDir },
      args: { binaryPath: "/usr/local/bin/ollama" },
      // deno-lint-ignore no-explicit-any
      handler: noSudoHandler() as any,
    });
    const d = ctx.getWrittenResources().find(
      (r) => r.specName === "serviceCreate",
    )!.data as Record<string, unknown>;
    assertEquals(d.requiresRoot, true);
    assertEquals(d.written, false);
    const joined = (d.manualCommands as string[]).join("\n");
    assertStringIncludes(joined, "sudo tee");
    assertStringIncludes(joined, "systemctl daemon-reload");
    // The unit file was NOT written.
    assertEquals(
      await Deno.stat(`${unitDir}/ollama.service`).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(unitDir, { recursive: true });
  }
});
