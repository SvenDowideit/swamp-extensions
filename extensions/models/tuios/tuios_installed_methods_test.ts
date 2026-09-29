/**
 * Execute-level tests for the `tuios-installed` model methods.
 *
 * These drive the real `execute` functions through `createModelTestContext`,
 * stubbing the network with `withMockedFetch` and the external `uname`/`which`
 * and `tuios --version` subprocesses with `withMockedCommand`. They cover the
 * `sync` write shape, the `install` happy path, the idempotent skip, the
 * consume-the-check-result path, and the fatal failures (missing checksum,
 * checksum mismatch, missing archive).
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
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@0.1.10/tar-stream";
import { model } from "./tuios_installed.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GLOBALS = {
  path: "",
  flavor: "std",
  repo: "Gaurav-Gosain/tuios",
  apiUrl: "https://api.github.com/repos/Gaurav-Gosain/tuios/releases/latest",
  userAgent: "swamp-tuios-test/1.0",
  githubToken: "",
  os: "Linux",
  arch: "x86_64",
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

/** The release JSON `check` would have produced, as a fetch response. */
function releaseJson(opts: {
  version: string;
  archive: string;
  url: string;
}): Response {
  return Response.json({
    tag_name: `v${opts.version}`,
    name: `v${opts.version}`,
    published_at: "2026-09-27T19:17:22Z",
    prerelease: false,
    html_url: "https://github.com/Gaurav-Gosain/tuios/releases/tag/v0.8.0",
    assets: [
      {
        name: opts.archive,
        browser_download_url: opts.url,
        size: 100,
      },
      {
        name: "checksums.txt",
        browser_download_url: "https://example.test/checksums.txt",
        size: 42,
      },
    ],
  });
}

/**
 * Invoke `model.methods.install.execute` with a partial args object. The
 * execute signature types every defaulted field as required, so tests build a
 * fully-populated object from the caller's overrides and cast the context.
 */
function runInstall(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    version: "",
    installDir: "",
    archiveName: "",
    downloadUrl: "",
    releaseVersion: "",
    checksum: "",
    force: false,
    os: undefined,
    arch: undefined,
    flavor: undefined,
    ...args,
  };
  return (model.methods.install.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

/** Invoke `model.methods.sync.execute` with the path defaulted. */
function runSync(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = { path: "", checkLatest: true, ...args };
  return (model.methods.sync.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

/** Build a gzipped tar as a `Blob` suitable for a `Response` body. */
async function makeArchiveBlob(
  member = "tuios",
  body = "binary",
): Promise<Blob> {
  const bytes = await makeArchive(member, body);
  return new Blob([new Uint8Array(bytes)]);
}

/** A command stub answering `uname` and `tuios --version`. */
function commandHandler(versionOutput = VERSION_OUTPUT) {
  return (command: string, args: string[]) => {
    if (command === "uname" && args[0] === "-s") {
      return { stdout: "Linux", code: 0 };
    }
    if (command === "uname" && args[0] === "-m") {
      return { stdout: "x86_64", code: 0 };
    }
    if (command === "which") return { stdout: "", code: 1 };
    return { stdout: versionOutput, code: 0 };
  };
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
    await withMockedFetch(() => {
      throw new Error("sync with checkLatest=false must not fetch");
    }, async () => {
      await runSync(ctx, { checkLatest: false });
    });
  });
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "installed");
  assertEquals(written[0].name, "installed");
  assertEquals(written[0].data.present, false);
  assertEquals(written[0].data.version, null);
  assertEquals(written[0].data.latestVersion, null);
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
      await withMockedFetch(() => {
        throw new Error("checkLatest=false must not fetch");
      }, async () => {
        await runSync(ctx, { checkLatest: false });
      });
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
// install — happy path
// ---------------------------------------------------------------------------

Deno.test("install downloads, verifies and installs the archive", async () => {
  const archive = await makeArchive();
  const archiveBlob = makeArchiveBlob();
  const sum = await sha256Hex(archive);
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS, path: `${tmpDir}/tuios` },
      methodName: "install",
    });

    await withMockedCommand(commandHandler(), async () => {
      await withMockedFetch(async (req) => {
        const url = req.url;
        if (url.includes("api.github.com")) {
          return releaseJson({
            version: "0.8.0",
            archive: "tuios_0.8.0_Linux_x86_64.tar.gz",
            url: "https://example.test/tuios.tar.gz",
          });
        }
        if (url.endsWith("checksums.txt")) {
          return new Response(
            `${sum}  tuios_0.8.0_Linux_x86_64.tar.gz\n`,
          );
        }
        if (url.endsWith("tuios.tar.gz")) {
          return new Response(await archiveBlob);
        }
        return new Response("not found", { status: 404 });
      }, async () => {
        await runInstall(ctx, { installDir: tmpDir });
      });
    });

    const written = ctx.getWrittenResources();
    const install = written.find((r) => r.specName === "install");
    assertEquals(install?.data.installed, true);
    assertEquals(install?.data.skipped, false);
    assertEquals(install?.data.version, "0.8.0");
    assertEquals(install?.data.checksumVerified, true);
    assertEquals(install?.data.path, `${tmpDir}/tuios`);

    const stat = await Deno.stat(`${tmpDir}/tuios`);
    assertEquals(stat.isFile, true);
    assertEquals(stat.mode! & 0o777, 0o755);

    // The post-install re-sync also wrote the installed resource.
    const installed = written.find((r) => r.specName === "installed");
    assertEquals(installed?.data.present, true);
    assertEquals(installed?.data.version, "0.8.0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// install — consumes the check result (no API re-fetch)
// ---------------------------------------------------------------------------

Deno.test("install consumes check's version/url/checksum without re-fetching", async () => {
  const archive = await makeArchive();
  const archiveBlob = makeArchiveBlob();
  const sum = await sha256Hex(archive);
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });

    let apiCalls = 0;
    await withMockedCommand(commandHandler(), async () => {
      await withMockedFetch(async (req) => {
        if (req.url.includes("api.github.com")) {
          apiCalls++;
          return new Response("must not fetch", { status: 500 });
        }
        if (req.url.endsWith("tuios.tar.gz")) {
          return new Response(await archiveBlob);
        }
        return new Response("not found", { status: 404 });
      }, async () => {
        await runInstall(ctx, {
          installDir: tmpDir,
          archiveName: "tuios_0.8.0_Linux_x86_64.tar.gz",
          downloadUrl: "https://example.test/tuios.tar.gz",
          releaseVersion: "0.8.0",
          checksum: sum,
        });
      });
    });

    assertEquals(
      apiCalls,
      0,
      "install must not call the releases API when check supplied the release",
    );
    const install = ctx.getWrittenResources().find((r) =>
      r.specName === "install"
    );
    assertEquals(install?.data.installed, true);
    assertEquals(install?.data.checksumVerified, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// install — idempotent skip
// ---------------------------------------------------------------------------

Deno.test("install skips when the target version is already present", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // An existing binary reporting 0.8.0.
    await Deno.writeTextFile(`${tmpDir}/tuios`, "existing");
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });

    let downloads = 0;
    await withMockedCommand(commandHandler(), async () => {
      await withMockedFetch(() => {
        downloads++;
        return new Response("should not download", { status: 500 });
      }, async () => {
        await runInstall(ctx, {
          installDir: tmpDir,
          archiveName: "tuios_0.8.0_Linux_x86_64.tar.gz",
          downloadUrl: "https://example.test/tuios.tar.gz",
          releaseVersion: "0.8.0",
          checksum: "abc",
        });
      });
    });

    assertEquals(downloads, 0);
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

Deno.test("install fails when no checksum is available", async () => {
  const archiveBlob = makeArchiveBlob();
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });

    await withMockedCommand(commandHandler(), async () => {
      await withMockedFetch(async (req) => {
        if (req.url.includes("api.github.com")) {
          // A release with no checksums.txt asset at all.
          return Response.json({
            tag_name: "v0.8.0",
            assets: [
              {
                name: "tuios_0.8.0_Linux_x86_64.tar.gz",
                browser_download_url: "https://example.test/tuios.tar.gz",
              },
            ],
          });
        }
        if (req.url.endsWith("tuios.tar.gz")) {
          return new Response(await archiveBlob);
        }
        return new Response("nope", { status: 404 });
      }, async () => {
        await assertRejects(
          () => runInstall(ctx, { installDir: tmpDir }),
          Error,
          "No SHA-256 available",
        );
      });
    });

    // Nothing was written to an install resource on a fatal failure.
    assertEquals(
      ctx.getWrittenResources().some((r) => r.specName === "install"),
      false,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install fails on a checksum mismatch", async () => {
  const archiveBlob = makeArchiveBlob();
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });

    await withMockedCommand(commandHandler(), async () => {
      await withMockedFetch(async (req) => {
        if (req.url.includes("api.github.com")) {
          return releaseJson({
            version: "0.8.0",
            archive: "tuios_0.8.0_Linux_x86_64.tar.gz",
            url: "https://example.test/tuios.tar.gz",
          });
        }
        if (req.url.endsWith("checksums.txt")) {
          return new Response(
            `${"0".repeat(64)}  tuios_0.8.0_Linux_x86_64.tar.gz\n`,
          );
        }
        if (req.url.endsWith("tuios.tar.gz")) {
          return new Response(await archiveBlob);
        }
        return new Response("nope", { status: 404 });
      }, async () => {
        await assertRejects(
          () =>
            runInstall(ctx, {
              installDir: tmpDir,
              // Supply the wrong checksum directly to skip the fetch.
              archiveName: "tuios_0.8.0_Linux_x86_64.tar.gz",
              downloadUrl: "https://example.test/tuios.tar.gz",
              releaseVersion: "0.8.0",
              checksum: "0".repeat(64),
            }),
          Error,
          "Checksum mismatch",
        );
      });
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("install fails when the archive lacks a tuios member", async () => {
  const archive = await makeArchive("README.md", "not the binary");
  const archiveBlob = makeArchiveBlob("README.md", "not the binary");
  const sum = await sha256Hex(archive);
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: { ...GLOBALS },
      methodName: "install",
    });

    await withMockedCommand(commandHandler(), async () => {
      await withMockedFetch(async (req) => {
        if (req.url.endsWith("tuios.tar.gz")) {
          return new Response(await archiveBlob);
        }
        return new Response("nope", { status: 404 });
      }, async () => {
        await assertRejects(
          () =>
            runInstall(ctx, {
              installDir: tmpDir,
              archiveName: "tuios_0.8.0_Linux_x86_64.tar.gz",
              downloadUrl: "https://example.test/tuios.tar.gz",
              releaseVersion: "0.8.0",
              checksum: sum,
            }),
          Error,
          "does not contain a 'tuios' binary",
        );
      });
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("print fails soft when no installed snapshot exists", async () => {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBALS },
    methodName: "print",
  });
  await model.methods.print.execute({}, ctx.context as never);
  const summary = ctx.getWrittenResources()[0];
  assertEquals(summary.specName, "summary");
  assertEquals(summary.data.printed, false);
  assertStringIncludes(
    (summary.data.lines as string[])[0],
    "run the sync method",
  );
});
