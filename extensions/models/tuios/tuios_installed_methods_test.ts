/**
 * Execute-level tests for the `tuios-installed` model methods.
 *
 * These drive the real `execute` functions through `createModelTestContext`,
 * stubbing the external `which` / `tuios --version` subprocesses with
 * `withMockedCommand`. install consumes a checksum-verified archive that the
 * release workflow (in @svendowideit/github-release-install) has already
 * produced, so the tests build a gzipped tar on disk and pass its path — there
 * is no network in the install path any more.
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
import { model } from "./tuios_installed.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GLOBALS = {
  path: "",
  flavor: "std",
  serviceName: "tuios",
};

const VERSION_OUTPUT = [
  "tuios version 0.8.0 [pure-Go backend]",
  "Commit: a169a8f4b0513e8e56af4c75a746a582b7f42dfc",
  "Built: 2026-09-27T19:05:54Z",
  "By: goreleaser",
].join("\n");

/** Build a gzipped tar containing a single `tuios` member. */
async function makeArchive(
  member = "tuios",
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

/** SHA-256 of a byte array as lowercase hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Write a checksum-verified archive to disk under `dir` and return its path and
 * checksum, as the release workflow would have produced it.
 */
async function stageArchive(
  dir: string,
  member = "tuios",
  body = "binary",
): Promise<{ path: string; checksum: string; name: string }> {
  const bytes = await makeArchive(member, body);
  const checksum = await sha256Hex(bytes);
  const name = "tuios_0.8.0_Linux_x86_64.tar.gz";
  const path = `${dir}/${name}`;
  await Deno.writeFile(path, bytes);
  return { path, checksum, name };
}

function commandHandler(versionOutput = VERSION_OUTPUT) {
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

function runUninstall(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    path: "",
    installDir: "",
    force: false,
    serviceName: "",
    ...args,
  };
  return (model.methods.uninstall.execute as unknown as (
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

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

Deno.test("sync writes the installed resource for a missing binary", async () => {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBALS, path: "/nonexistent/tuios" },
    methodName: "sync",
  });
  await withMockedCommand(commandHandler(), async () => {
    await runSync(ctx, {});
  });
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "installed");
  assertEquals(written[0].data.present, false);
  assertEquals(written[0].data.version, null);
});

Deno.test("sync parses `tuios --version` when the binary exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/tuios`, "binary");
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, path: `${tmpDir}/tuios` },
      methodName: "sync",
    });
    await withMockedCommand(commandHandler(), async () => {
      await runSync(ctx, {});
    });
    const data = ctx.getWrittenResources()[0].data;
    assertEquals(data.present, true);
    assertEquals(data.version, "0.8.0");
    assertEquals(data.backend, "pure-Go backend");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

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
        checksum,
      });
    });

    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.installed, true);
    assertEquals(install?.data.skipped, false);
    assertEquals(install?.data.checksumVerified, true);
    assertEquals(install?.data.archivePath, path);
    assertEquals(install?.data.path, `${tmpDir}/tuios`);

    const stat = await Deno.stat(`${tmpDir}/tuios`);
    assertEquals(stat.isFile, true);
    assertEquals(stat.mode! & 0o777, 0o755);

    const installed = ctx.getWrittenResources().find((r) =>
      r.specName === "installed"
    );
    assertEquals(installed?.data.present, true);
    assertEquals(installed?.data.version, "0.8.0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install derives the version from the archive name", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { path, checksum, name } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler(), async () => {
      await runInstall(ctx, {
        installDir: tmpDir,
        archivePath: path,
        archiveName: name,
        checksum,
      });
    });
    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.version, "0.8.0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install skips when the target version is already present", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/tuios`, "existing");
    const { path, checksum } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand(commandHandler(), async () => {
      await runInstall(ctx, {
        installDir: tmpDir,
        archivePath: path,
        checksum,
      });
    });
    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.skipped, true);
    assertEquals(install?.data.installed, false);
    assertEquals(install?.data.version, "0.8.0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// install — failure paths
// ---------------------------------------------------------------------------

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
    // The target binary was never written.
    let exists = true;
    try {
      await Deno.stat(`${tmpDir}/tuios`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install fails when the archive lacks a tuios member", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { path, checksum } = await stageArchive(
      tmpDir,
      "README.md",
      "not the binary",
    );
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
            checksum,
          }),
        Error,
        "does not contain a 'tuios' binary",
      );
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install refuses to overwrite a package-manager-owned binary", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/tuios`, "binary");
    const { path, checksum } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    const oldVersion = "tuios version 0.7.0 [pure-Go backend]";
    await withMockedCommand((command, args) => {
      if (command === "dpkg" && args[0] === "-S") {
        return { stdout: `tuios: ${tmpDir}/tuios\n`, code: 0 };
      }
      return commandHandler(oldVersion)(command, args);
    }, async () => {
      await assertRejects(
        () =>
          runInstall(ctx, {
            installDir: tmpDir,
            archivePath: path,
            checksum,
          }),
        Error,
        "owned by",
      );
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install no-ops on an up-to-date package-manager-owned binary", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/tuios`, "binary");
    const { path, checksum } = await stageArchive(tmpDir);
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });
    await withMockedCommand((command, args) => {
      if (command === "dpkg" && args[0] === "-S") {
        return { stdout: `tuios: ${tmpDir}/tuios\n`, code: 0 };
      }
      return commandHandler()(command, args); // reports 0.8.0, the target
    }, async () => {
      await runInstall(ctx, {
        installDir: tmpDir,
        archivePath: path,
        checksum,
      });
    });
    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.skipped, true);
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
// print / uninstall
// ---------------------------------------------------------------------------

Deno.test("print fails soft when no installed snapshot exists", async () => {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBALS },
    methodName: "print",
  });
  await model.methods.print.execute(
    { serviceName: "" },
    ctx.context as never,
  );
  const summary = ctx.getWrittenResources()[0];
  assertEquals(summary.specName, "summary");
  assertEquals(summary.data.printed, false);
  assertStringIncludes(
    (summary.data.lines as string[])[0],
    "run the sync method",
  );
});

Deno.test("uninstall removes the binary and records the result", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/tuios`, "binary");
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "uninstall",
    });
    await withMockedCommand(commandHandler(), async () => {
      await runUninstall(ctx, { installDir: tmpDir });
    });
    const uninstall = ctx.getWrittenResources().find((r) =>
      r.specName === "uninstall"
    );
    assertEquals(uninstall?.data.removed, true);
    assertEquals(uninstall?.data.skipped, false);
    assertEquals(uninstall?.data.path, `${tmpDir}/tuios`);
    await assertRejects(() => Deno.stat(`${tmpDir}/tuios`));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("uninstall is idempotent when the binary is absent", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "uninstall",
    });
    await withMockedCommand(commandHandler(), async () => {
      await runUninstall(ctx, { installDir: tmpDir });
    });
    const uninstall = ctx.getWrittenResources().find((r) =>
      r.specName === "uninstall"
    );
    assertEquals(uninstall?.data.removed, false);
    assertEquals(uninstall?.data.skipped, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("uninstall refuses a package-manager-owned binary without force", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/tuios`, "binary");
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "uninstall",
    });
    await withMockedCommand((command, args) => {
      if (command === "dpkg" && args[0] === "-S") {
        return { stdout: `tuios: ${tmpDir}/tuios\n`, code: 0 };
      }
      return commandHandler()(command, args);
    }, async () => {
      await assertRejects(
        () => runUninstall(ctx, { installDir: tmpDir }),
        Error,
        "owned by",
      );
    });
    assertEquals((await Deno.stat(`${tmpDir}/tuios`)).isFile, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("uninstall rejects a relative installDir", async () => {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBALS },
    methodName: "uninstall",
  });
  await assertRejects(
    () => runUninstall(ctx, { installDir: "relative/bin" }),
    Error,
    "absolute",
  );
});

// ---------------------------------------------------------------------------
// themes
// ---------------------------------------------------------------------------

const EXT_DIR = new URL(".", import.meta.url).pathname;

/** Point the test context's extensionFile at the real extension directory. */
function withExtensionFiles<T extends { context: unknown }>(ctx: T): T {
  (ctx.context as Record<string, unknown>).extensionFile = (rel: string) =>
    `${EXT_DIR}${rel}`;
  return ctx;
}

function runInstallTheme(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    themeId: "",
    themeJson: "",
    sourcePath: "",
    themesDir: "",
    select: false,
    force: false,
    configPath: "",
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
  const full = { themeId: "", configPath: "", ...args };
  return (model.methods.setTheme.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

function runInstallBundledThemes(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    themes: ["swamp_club", "borland_modern_blue"],
    themesDir: "",
    defaultTheme: "swamp_club",
    force: false,
    configPath: "",
    ...args,
  };
  return (model.methods.installBundledThemes.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

Deno.test("installTheme writes a bundled theme without selecting it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "installTheme",
      }),
    );
    await runInstallTheme(ctx, {
      themeId: "borland_modern_blue",
      themesDir: dir,
    });

    const written = await Deno.readTextFile(`${dir}/borland_modern_blue.json`);
    assertEquals(JSON.parse(written).id, "borland_modern_blue");

    const theme = ctx.getWrittenResources().find((r) => r.specName === "theme");
    assertEquals(theme?.data.installed, true);
    assertEquals(theme?.data.selected, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installTheme writes an inline theme and selects it when asked", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "installTheme",
      }),
    );
    const json = JSON.stringify({
      id: "solarized",
      bg: "#002b36",
      fg: "#839496",
    });
    await runInstallTheme(ctx, {
      themeId: "solarized",
      themeJson: json,
      themesDir: dir,
      configPath: `${dir}/config.toml`,
      select: true,
    });

    assertEquals(
      JSON.parse(await Deno.readTextFile(`${dir}/solarized.json`)).fg,
      "#839496",
    );
    const toml = await Deno.readTextFile(`${dir}/config.toml`);
    assertEquals(toml.includes("theme = 'solarized'"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installTheme rejects invalid theme JSON", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "installTheme",
      }),
    );
    await assertRejects(
      () =>
        runInstallTheme(ctx, {
          themeId: "bad",
          themeJson: "not json",
          themesDir: dir,
        }),
      Error,
      "valid TUIOS theme",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installTheme requires content for a non-bundled id", async () => {
  const ctx = withExtensionFiles(
    createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "installTheme",
    }),
  );
  await assertRejects(
    () => runInstallTheme(ctx, { themeId: "nope" }),
    Error,
    "No theme content",
  );
});

Deno.test("setTheme creates config.toml and is idempotent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.toml`;
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "setTheme",
      }),
    );
    await runSetTheme(ctx, { themeId: "swamp_club", configPath });
    assertEquals(
      (await Deno.readTextFile(configPath)).includes("theme = 'swamp_club'"),
      true,
    );

    const second = ctx.getWrittenResources().length;
    await runSetTheme(ctx, { themeId: "swamp_club", configPath });
    const set = ctx.getWrittenResources()[second];
    assertEquals(set.specName, "themeSelection");
    assertEquals(set.data.changed, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installBundledThemes installs both and selects swamp_club by default", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.toml`;
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "installBundledThemes",
      }),
    );
    await runInstallBundledThemes(ctx, { themesDir: dir, configPath });

    for (const id of ["swamp_club", "borland_modern_blue"]) {
      const theme = JSON.parse(await Deno.readTextFile(`${dir}/${id}.json`));
      assertEquals(theme.id, id);
    }
    assertEquals(
      (await Deno.readTextFile(configPath)).includes("theme = 'swamp_club'"),
      true,
    );

    const themes = ctx.getWrittenResources().find((r) =>
      r.specName === "themes"
    );
    assertEquals(themes?.data.selected, true);
    assertEquals((themes?.data.installed as unknown[]).length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installBundledThemes never overwrites a user's chosen theme", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.toml`;
    await Deno.writeTextFile(
      configPath,
      "[appearance]\ntheme = 'borland_modern_blue'\n",
    );
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "installBundledThemes",
      }),
    );
    await runInstallBundledThemes(ctx, { themesDir: dir, configPath });

    const toml = await Deno.readTextFile(configPath);
    assertEquals(toml.includes("theme = 'borland_modern_blue'"), true);
    const themes = ctx.getWrittenResources().find((r) =>
      r.specName === "themes"
    );
    assertEquals(themes?.data.selected, false);
    assertEquals(themes?.data.selectedTheme, "borland_modern_blue");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// renderThemeReport
// ---------------------------------------------------------------------------

function runRenderThemeReport(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    themeId: "",
    themesDir: "",
    configPath: "",
    outputPath: "",
    open: false,
    ...args,
  };
  return (model.methods.renderThemeReport.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

Deno.test("renderThemeReport writes an HTML report for a named theme", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const out = `${dir}/report.html`;
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "renderThemeReport",
      }),
    );
    await runRenderThemeReport(ctx, {
      themeId: "borland_modern_blue",
      themesDir: `${EXT_DIR}themes`,
      configPath: `${dir}/config.toml`,
      outputPath: out,
    });

    const report = ctx.getWrittenResources().find((r) =>
      r.specName === "themeReport"
    );
    assertEquals(report?.data.themeId, "borland_modern_blue");
    assertEquals(report?.data.outputPath, out);
    assertEquals(report?.data.opened, false);
    assertEquals(
      (report?.data.illegible as string[]).includes("purple"),
      true,
    );

    const html = await Deno.readTextFile(out);
    assertStringIncludes(html, "<!DOCTYPE html>");
    assertStringIncludes(html, "errors, deletions, failing checks");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderThemeReport defaults to the configured theme", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.toml`;
    await Deno.writeTextFile(
      configPath,
      "[appearance]\ntheme = 'swamp_club'\n",
    );
    const out = `${dir}/report.html`;
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "renderThemeReport",
      }),
    );
    await runRenderThemeReport(ctx, {
      themesDir: `${EXT_DIR}themes`,
      configPath,
      outputPath: out,
    });
    const report = ctx.getWrittenResources().find((r) =>
      r.specName === "themeReport"
    );
    assertEquals(report?.data.themeId, "swamp_club");
    assertStringIncludes(await Deno.readTextFile(out), "#39ff14");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderThemeReport errors when no theme is selected", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS },
        methodName: "renderThemeReport",
      }),
    );
    await assertRejects(
      () =>
        runRenderThemeReport(ctx, {
          themesDir: `${EXT_DIR}themes`,
          configPath: `${dir}/config.toml`,
        }),
      Error,
      "No theme selected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderThemeReport falls back to the binary for a built-in theme", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const listing = JSON.stringify({
      palette: {
        id: "dracula",
        display_name: "Dracula",
        dark: true,
        bg: "#282a36",
        fg: "#f8f8f2",
        cursor: "#f8f8f2",
        swatches: [{ name: "red", hex: "#ff5555" }],
      },
    });
    const fakeBinary = `${dir}/tuios`;
    await Deno.writeTextFile(fakeBinary, "binary");
    const ctx = withExtensionFiles(
      createModelTestContext({
        globalArgs: { ...GLOBALS, path: fakeBinary },
        methodName: "renderThemeReport",
      }),
    );
    // No theme file in the empty themes dir, so the method shells out; the
    // mocked `tuios` answers with the palette JSON.
    await withMockedCommand((command, args) => {
      if (command === fakeBinary && args[0] === "list-themes") {
        return { stdout: listing, code: 0 };
      }
      return { stdout: "", code: 1 };
    }, async () => {
      await runRenderThemeReport(ctx, {
        themeId: "dracula",
        themesDir: dir,
        configPath: `${dir}/config.toml`,
        outputPath: `${dir}/dracula.html`,
      });
    });
    const report = ctx.getWrittenResources().find((r) =>
      r.specName === "themeReport"
    );
    assertEquals(report?.data.themeId, "dracula");
    assertStringIncludes(
      await Deno.readTextFile(`${dir}/dracula.html`),
      "#ff5555",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
