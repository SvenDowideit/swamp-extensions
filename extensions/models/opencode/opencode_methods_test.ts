/**
 * Execute-level tests for the `@svendowideit/opencode` model methods.
 *
 * These drive the real `execute` functions through `createModelTestContext`,
 * stubbing the `which` / `opencode --version` subprocesses with
 * `withMockedCommand`. install consumes a checksum-verified archive produced by
 * the release workflow, so the tests build a gzipped tar on disk and pass its
 * path — there is no network in the install path.
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
import { TarStream, type TarStreamInput } from "jsr:@std/tar@0.1.10/tar-stream";
import { model } from "./opencode.ts";

const GLOBALS = {
  path: "",
  configDir: "",
  theme: "borland_modern_blue",
};

/** Build a gzipped tar containing a single `opencode` member. */
async function makeArchive(
  member = "opencode",
  body = "binary",
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const content = enc.encode(body);
  const entry: TarStreamInput = {
    type: "file",
    path: member,
    size: content.length,
    readable: new Blob([content]).stream(),
  };
  const tar = new TarStream();
  const writer = tar.writable.getWriter();
  const collected = new Response(tar.readable).arrayBuffer();
  await writer.write(entry);
  await writer.close();
  const tarBytes = new Uint8Array(await collected);
  const gz = new Blob([tarBytes]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(gz).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function stageArchive(
  dir: string,
  member = "opencode",
  body = "binary",
): Promise<{ path: string; checksum: string; name: string }> {
  const bytes = await makeArchive(member, body);
  const checksum = await sha256Hex(bytes);
  const name = "opencode-linux-x64.tar.gz";
  const path = `${dir}/${name}`;
  await Deno.writeFile(path, bytes);
  return { path, checksum, name };
}

function commandHandler(versionOutput = "1.18.33") {
  return (command: string, _args: string[]) => {
    if (command === "which") return { stdout: "", code: 1 };
    if (command === "dpkg" || command === "rpm" || command === "brew") {
      return { stdout: "", stderr: "not found", code: 1 };
    }
    return { stdout: versionOutput, code: 0 };
  };
}

function runInstall(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    version: "",
    archivePath: "",
    archiveName: "",
    releaseVersion: "",
    checksum: "",
    installDir: "",
    force: false,
    ...args,
  };
  return (model.methods.install.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

function runSync(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = { path: "", ...args };
  return (model.methods.sync.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

function runInstallTheme(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    theme: "",
    themePath: "",
    themeJson: "",
    force: false,
    ...args,
  };
  return (model.methods.installTheme.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

function runSetTheme(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = { theme: "", createTui: true, ...args };
  return (model.methods.setTheme.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

Deno.test("sync records a missing binary", async () => {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBALS, path: "/nonexistent/opencode" },
    methodName: "sync",
  });
  await withMockedCommand(commandHandler(), async () => {
    await runSync(ctx, {});
  });
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].data.present, false);
  assertEquals(written[0].data.version, null);
});

Deno.test("sync parses `opencode --version` when the binary exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/opencode`, "binary");
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, path: `${tmpDir}/opencode` },
      methodName: "sync",
    });
    await withMockedCommand(commandHandler("1.18.33"), async () => {
      await runSync(ctx, {});
    });
    const data = ctx.getWrittenResources()[0].data;
    assertEquals(data.present, true);
    assertEquals(data.version, "1.18.33");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install verifies and installs the staged archive", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { path, checksum } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler(), async () => {
      await runInstall(ctx, {
        installDir: tmpDir,
        archivePath: path,
        archiveName: "opencode-linux-x64.tar.gz",
        checksum,
      });
    });
    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.installed, true);
    assertEquals(install?.data.skipped, false);
    assertEquals(install?.data.checksumVerified, true);
    assertEquals(install?.data.path, `${tmpDir}/opencode`);
    const stat = await Deno.stat(`${tmpDir}/opencode`);
    assertEquals(stat.isFile, true);
    assertEquals(stat.mode! & 0o777, 0o755);

    const installed = ctx.getWrittenResources().find((r) =>
      r.specName === "installed"
    );
    assertEquals(installed?.data.present, true);
    assertEquals(installed?.data.version, "1.18.33");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install skips when the target version is already present", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/opencode`, "existing");
    const { path, checksum } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler("1.18.33"), async () => {
      await runInstall(ctx, {
        installDir: tmpDir,
        archivePath: path,
        checksum,
        version: "1.18.33",
      });
    });
    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.skipped, true);
    assertEquals(install?.data.installed, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install skips via releaseVersion (opencode names carry no version)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/opencode`, "existing");
    const { path, checksum } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler("1.18.33"), async () => {
      // No `version` input; the resolved release version drives idempotency.
      await runInstall(ctx, {
        installDir: tmpDir,
        archivePath: path,
        checksum,
        releaseVersion: "1.18.33",
      });
    });
    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.skipped, true);
    assertEquals(install?.data.version, "1.18.33");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install requires an archivePath", async () => {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBALS },
    methodName: "install",
  });
  await withMockedCommand(commandHandler(), async () => {
    await assertRejects(
      () => runInstall(ctx, { installDir: "/tmp/x", checksum: "abc" }),
      Error,
      "requires a checksum-verified archive",
    );
  });
});

Deno.test("install requires a checksum", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { path } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler(), async () => {
      await assertRejects(
        () => runInstall(ctx, { installDir: tmpDir, archivePath: path }),
        Error,
        "No SHA-256 supplied",
      );
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install fails on a checksum mismatch", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { path } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler(), async () => {
      await assertRejects(
        () =>
          runInstall(ctx, {
            installDir: tmpDir,
            archivePath: path,
            checksum: "0".repeat(64),
          }),
        Error,
        "Checksum mismatch",
      );
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install fails when the archive lacks an opencode member", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { path, checksum } = await stageArchive(tmpDir, "README.md", "nope");
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler(), async () => {
      await assertRejects(
        () =>
          runInstall(ctx, { installDir: tmpDir, archivePath: path, checksum }),
        Error,
        "does not contain an 'opencode' binary",
      );
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install refuses a package-manager-owned binary", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/opencode`, "binary");
    const { path, checksum } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand((command, args) => {
      if (command === "dpkg" && args[0] === "-S") {
        return { stdout: `opencode: ${tmpDir}/opencode\n`, code: 0 };
      }
      return commandHandler("1.17.0")(command, args);
    }, async () => {
      await assertRejects(
        () =>
          runInstall(ctx, { installDir: tmpDir, archivePath: path, checksum }),
        Error,
        "owned by",
      );
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install rejects a relative installDir before touching the disk", async () => {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBALS },
    methodName: "install",
  });
  await withMockedCommand(commandHandler(), async () => {
    await assertRejects(
      () => runInstall(ctx, { installDir: "relative/bin", checksum: "abc" }),
      Error,
      "absolute",
    );
  });
});

// ---------------------------------------------------------------------------
// theme methods
// ---------------------------------------------------------------------------

/** Point a test context's `extensionFile` at this directory. */
function withExtensionFile<T extends { context: unknown }>(ctx: T): T {
  (ctx.context as { extensionFile?: (p: string) => string }).extensionFile = (
    rel,
  ) => new URL(rel, import.meta.url).pathname;
  return ctx;
}

Deno.test("installTheme writes the bundled theme and is idempotent", async () => {
  const configDir = await Deno.makeTempDir();
  try {
    const ctx = withExtensionFile(createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "installTheme",
    }));
    await runInstallTheme(ctx, { theme: "borland_modern_blue" });
    const first = ctx.getWrittenResources().find((r) => r.specName === "theme");
    assertEquals(first?.data.installed, true);
    assertEquals(first?.data.skipped, false);
    const file = `${configDir}/themes/borland_modern_blue.json`;
    const body = await Deno.readTextFile(file);
    assertStringIncludes(body, '"defs"');

    // Second run: identical content, skipped.
    const ctx2 = withExtensionFile(createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "installTheme",
    }));
    await runInstallTheme(ctx2, { theme: "borland_modern_blue" });
    const second = ctx2.getWrittenResources().find((r) =>
      r.specName === "theme"
    );
    assertEquals(second?.data.skipped, true);
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
});

Deno.test("installTheme errors clearly when no bundled theme is resolvable", async () => {
  const configDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "installTheme",
    });
    await assertRejects(
      () => runInstallTheme(ctx, { theme: "borland_modern_blue" }),
      Error,
      "no bundled theme available",
    );
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
});

Deno.test("installTheme accepts inline themeJson", async () => {
  const configDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "installTheme",
    });
    await runInstallTheme(ctx, {
      theme: "my-theme",
      themeJson: JSON.stringify({ theme: { text: "#fff" }, defs: {} }),
    });
    const file = `${configDir}/themes/my-theme.json`;
    const body = JSON.parse(await Deno.readTextFile(file));
    assertEquals(body.theme, { text: "#fff" });
    assertEquals(body.defs, {});
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
});

Deno.test("installTheme rejects invalid theme JSON", async () => {
  const configDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "installTheme",
    });
    await assertRejects(
      () => runInstallTheme(ctx, { theme: "bad", themeJson: "{not json" }),
      Error,
      "not valid JSON",
    );
    await assertRejects(
      () => runInstallTheme(ctx, { theme: "bad", themeJson: "{}" }),
      Error,
      "defs",
    );
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
});

Deno.test("setTheme writes tui.json preserving other keys and is idempotent", async () => {
  const configDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${configDir}/tui.json`,
      JSON.stringify({ keybinds: { x: "y" } }),
    );
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "setTheme",
    });
    await runSetTheme(ctx, { theme: "borland_modern_blue" });
    const result = ctx.getWrittenResources().find((r) =>
      r.specName === "setTheme"
    );
    assertEquals(result?.data.changed, true);
    assertEquals(result?.data.previousTheme, null);
    const body = JSON.parse(
      await Deno.readTextFile(`${configDir}/tui.json`),
    );
    assertEquals(body.theme, "borland_modern_blue");
    assertEquals(body.keybinds, { x: "y" });

    const ctx2 = createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "setTheme",
    });
    await runSetTheme(ctx2, { theme: "borland_modern_blue" });
    const second = ctx2.getWrittenResources().find((r) =>
      r.specName === "setTheme"
    );
    assertEquals(second?.data.changed, false);
    assertEquals(second?.data.previousTheme, "borland_modern_blue");
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
});

Deno.test("print reports the binary and theme state", async () => {
  const configDir = await Deno.makeTempDir();
  try {
    const installed = {
      path: "/home/me/.opencode/bin/opencode",
      present: true,
      version: "1.18.33",
      rawVersionOutput: "1.18.33",
      checkedAt: "2026-09-30T00:00:00Z",
    };
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, configDir },
      methodName: "print",
      storedResources: { installed },
    });
    await (model.methods.print.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({ theme: "borland_modern_blue" }, ctx.context);
    const summary = ctx.getWrittenResources().find((r) =>
      r.specName === "summary"
    );
    assertEquals(summary?.data.present, true);
    assertEquals(summary?.data.version, "1.18.33");
    assertEquals(summary?.data.theme, "borland_modern_blue");
    assertEquals(summary?.data.themeInstalled, false);
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
});
