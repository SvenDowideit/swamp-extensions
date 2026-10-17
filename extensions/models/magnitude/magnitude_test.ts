/**
 * Execute-level tests for the `@svendowideit/magnitude` model.
 *
 * Drives the real method executes through `createModelTestContext` with the
 * command layer mocked by `withMockedCommand`. Covers `plan` (distro/arch/
 * package/manager resolution and the unsupported path), `sync`, `assess`,
 * `stage` (checksum verification + script rendering) and `privilege`. Staging
 * directories are redirected to a temp dir so nothing touches `/var`.
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
  model,
  redactServerConfig,
  resolveReleaseVersion,
  sha256File,
} from "./magnitude.ts";
import { MAGNITUDE_PACKAGE_PATTERN } from "./magnitude_shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseGlobals(overrides: Record<string, unknown> = {}) {
  return {
    distro: "",
    arch: "",
    repo: "magnitudedev/magnitude",
    version: "",
    assetPattern: MAGNITUDE_PACKAGE_PATTERN,
    githubToken: "",
    downloadDir: "~/.cache/magnitude",
    stagingDir: "/tmp/magnitude-test-staging",
    packageName: "magnitude-desktop",
    serviceName: "magnitude",
    serviceUser: "magnitude",
    configDir: "/var/lib/magnitude",
    manageService: "auto",
    networkEnabled: false,
    networkApiKey: "",
    networkHost: "",
    sudoInstanceKey: "default",
    sudoAllowedOperations: [],
    force: false,
    ...overrides,
  };
}

function rootHandler() {
  return (command: string, args: string[]) => {
    if (command === "id" && args[0] === "-u") return { stdout: "0\n", code: 0 };
    if (command === "id") return { stdout: "0\n", code: 0 };
    if (command === "uname" && args[0] === "-m") {
      return { stdout: "x86_64\n", code: 0 };
    }
    if (command === "which") return { stdout: "", code: 1 };
    if (command === "systemctl") return { stdout: "active\n", code: 0 };
    return { stdout: "", code: 0 };
  };
}

function noSudoHandler() {
  return (command: string, args: string[]) => {
    if (command === "id" && args[0] === "-u") {
      return { stdout: "1000\n", code: 0 };
    }
    if (command === "id") return { stdout: "1000\n", code: 0 };
    if (command === "which" && args[0] === "sudo") {
      return { stdout: "/usr/bin/sudo\n", code: 0 };
    }
    if (command === "sudo") {
      return { stdout: "", stderr: "a password is required\n", code: 1 };
    }
    return { stdout: "", code: 0 };
  };
}

// deno-lint-ignore no-explicit-any
async function runMethod(name: string, opts: any = {}) {
  const ctx = createModelTestContext({
    globalArgs: baseGlobals(opts.globalArgs ?? {}),
    methodName: name,
    storedResources: opts.storedResources ?? {},
  });
  // deno-lint-ignore no-explicit-any
  const schema = (model.methods as any)[name].arguments;
  const parsed = schema.parse(opts.args ?? {});
  const handler = opts.handler ?? rootHandler();
  // deno-lint-ignore no-explicit-any
  let result: any;
  await withMockedCommand(handler, async () => {
    // deno-lint-ignore no-explicit-any
    const methodsAny = model.methods as any;
    result = await methodsAny[name].execute(parsed, ctx.context);
  });
  // Every resource a method writes must validate against its declared schema.
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
      `resource '${w.specName}' did not match its schema`,
    );
  }
  return { result, ctx };
}

// ---------------------------------------------------------------------------
// Registration + pure exports
// ---------------------------------------------------------------------------

Deno.test("the model registers the expected type, version and methods", () => {
  assertEquals(model.type, "@svendowideit/magnitude");
  assertEquals(model.version, "2026.10.18.1");
  const methods = Object.keys(model.methods).sort();
  assertEquals(methods, [
    "assess",
    "configure",
    "install",
    "plan",
    "print",
    "privilege",
    "renderScripts",
    "serverSetup",
    "service",
    "setup",
    "stage",
    "sync",
    "uninstall",
  ]);
});

Deno.test("resolveReleaseVersion accepts a tag, a package version or a bare version", () => {
  assertEquals(resolveReleaseVersion("@magnitudedev/cli@0.2.9"), "0.2.9");
  assertEquals(resolveReleaseVersion("0.2.9-59"), "0.2.9");
  assertEquals(resolveReleaseVersion("v0.2.9"), "0.2.9");
  assertEquals(resolveReleaseVersion("0.2.9"), "0.2.9");
});

Deno.test("sha256File hashes a file in streams", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/f`;
  await Deno.writeTextFile(path, "hello\n");
  // echo -n hello | sha256sum
  assertEquals(
    await sha256File(path),
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("redactServerConfig hides the network API key", () => {
  const doc =
    `{\n  "network": {\n    "enabled": true,\n    "apiKey": "mag_secret"\n  }\n}\n`;
  const out = JSON.parse(redactServerConfig(doc));
  assertEquals(out.network.apiKey, "<redacted>");
  assertEquals(out.network.enabled, true);
});

Deno.test("setup persists merged settings and reports capabilities", async () => {
  const { ctx } = await runMethod("setup", {
    args: { networkEnabled: true, networkApiKey: "mag_secret" },
    globalArgs: { distro: "debian", arch: "x86_64" },
    handler: (command: string) => {
      if (command === "id") return { stdout: "0\n", code: 0 };
      if (command === "which") return { stdout: "", code: 1 };
      return { stdout: "", code: 0 };
    },
  });
  const data = ctx.getWrittenResources().find((w) => w.specName === "settings")!
    .data as Record<string, unknown>;
  const effective = data.effective as Record<string, unknown>;
  assertEquals(effective.networkEnabled, true);
  assertEquals(effective.networkApiKeyRef, "<set>");
  assertEquals(data.detected, {
    configExists: false,
    networkEnabled: null,
    networkHost: null,
    hasApiKey: true,
  });
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

Deno.test("plan resolves a Debian/x64 host to the deb package", async () => {
  const { ctx } = await runMethod("plan", {
    globalArgs: { distro: "debian", arch: "x86_64" },
  });
  const written = ctx.getWrittenResources().find((w) =>
    w.specName === "platform"
  );
  const data = written!.data as Record<string, unknown>;
  assertEquals(data.family, "debian");
  assertEquals(data.arch, "x64");
  assertEquals(data.format, "deb");
  assertEquals(data.manager, "apt");
  assertEquals(data.osFilter, "deb");
  assertEquals(data.archFilter, "x86_64");
  assertEquals(data.supported, true);
  assertEquals(data.binaryPath, "/usr/bin/magnitude");
  assertEquals(data.unitPath, "/usr/lib/systemd/system/magnitude.service");
});

Deno.test("plan reports an unsupported distro", async () => {
  const { ctx } = await runMethod("plan", {
    globalArgs: { distro: "gentoo", arch: "x86_64" },
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.family, "unknown");
  assertEquals(data.supported, false);
  assertEquals(data.manager, null);
});

Deno.test("plan refuses the Arch/arm64 combination Magnitude does not ship", async () => {
  const { ctx } = await runMethod("plan", {
    globalArgs: { distro: "arch", arch: "aarch64" },
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.family, "arch");
  assertEquals(data.arch, "arm64");
  assertEquals(data.supported, false);
});

// ---------------------------------------------------------------------------
// sync / assess
// ---------------------------------------------------------------------------

Deno.test("sync reports a missing binary as absent", async () => {
  const { ctx } = await runMethod("sync", {
    args: { path: "/nonexistent/magnitude", checkLatest: false },
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.present, false);
  assertEquals(data.version, null);
});

Deno.test("assess flags an update from the resolved tag", async () => {
  const { ctx } = await runMethod("assess", {
    args: { latestVersion: "@magnitudedev/cli@0.2.9" },
    storedResources: {
      installed: { present: true, version: "0.2.8" },
    },
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.latestVersion, "0.2.9");
  assertEquals(data.updateAvailable, true);
  assertEquals(data.upToDate, false);
});

Deno.test("assess reports up to date when the revision differs but the version matches", async () => {
  const { ctx } = await runMethod("assess", {
    args: { latestVersion: "0.2.9-59" },
    storedResources: {
      installed: { present: true, version: "0.2.9" },
    },
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.latestVersion, "0.2.9");
  assertEquals(data.updateAvailable, false);
  assertEquals(data.upToDate, true);
});

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

Deno.test("stage verifies the checksum and renders the root scripts", async () => {
  const pkgDir = await Deno.makeTempDir();
  const pkgPath = `${pkgDir}/magnitude-desktop_0.2.9-59_amd64.deb`;
  await Deno.writeTextFile(pkgPath, "PRETEND DEB\n");
  const checksum = await sha256File(pkgPath);
  const stagingDir = await Deno.makeTempDir();

  const { ctx } = await runMethod("stage", {
    args: { packagePath: pkgPath, checksum },
    globalArgs: { stagingDir, distro: "debian", arch: "x86_64" },
    storedResources: { platform: { manager: "apt" } },
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.checksumVerified, true);
  assertEquals(data.manager, "apt");
  assertStringIncludes(String(data.installScriptPath), "install-magnitude.sh");
  assertStringIncludes(
    await Deno.readTextFile(String(data.installScriptPath)),
    "apt-get",
  );
  await Deno.remove(pkgDir, { recursive: true });
  await Deno.remove(stagingDir, { recursive: true });
});

Deno.test("renderScripts writes the server scripts and the settings document", async () => {
  const stagingDir = await Deno.makeTempDir();
  const { ctx } = await runMethod("renderScripts", {
    globalArgs: {
      stagingDir,
      networkEnabled: true,
      networkApiKey: "mag_secret",
      networkHost: "0.0.0.0",
    },
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  const setup = await Deno.readTextFile(String(data.setupScriptPath));
  assertStringIncludes(setup, "systemctl enable --now magnitude.service");
  assertStringIncludes(
    setup,
    "install -D -m 0600 -o magnitude -g magnitude",
  );
  assertStringIncludes(
    await Deno.readTextFile(String(data.removeScriptPath)),
    "systemctl disable --now magnitude.service",
  );
  const cfg = JSON.parse(
    await Deno.readTextFile(String(data.serverConfigPath)),
  );
  assertEquals(cfg.network.apiKey, "mag_secret");
  assertEquals(cfg.network.bind, "0.0.0.0");
  await Deno.remove(stagingDir, { recursive: true });
});

Deno.test("stage rejects a checksum mismatch", async () => {
  const pkgDir = await Deno.makeTempDir();
  const pkgPath = `${pkgDir}/magnitude-desktop_0.2.9-59_amd64.deb`;
  await Deno.writeTextFile(pkgPath, "TAMPERED\n");
  await assertRejects(
    () =>
      runMethod("stage", {
        args: { packagePath: pkgPath, checksum: "deadbeef", manager: "apt" },
      }),
    Error,
    "checksum mismatch",
  );
  await Deno.remove(pkgDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// privilege / install
// ---------------------------------------------------------------------------

Deno.test("privilege records the resolved route", async () => {
  const { ctx } = await runMethod("privilege", { handler: noSudoHandler() });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.mode, "sudo-prompt");
  assertEquals(data.isRoot, false);
});

Deno.test("install refuses a non-idempotent no-sudo run with manual commands", async () => {
  await assertRejects(
    () =>
      runMethod("install", {
        args: { packagePath: "/tmp/x.deb" },
        globalArgs: { distro: "debian", arch: "x86_64" },
        storedResources: {
          stage: { packagePath: "/tmp/x.deb", manager: "apt" },
        },
        handler: noSudoHandler(),
      }),
    Error,
    "apt-get install -y /tmp/x.deb",
  );
});
