/**
 * Execute-level tests for the `@svendowideit/github-release-install` model.
 *
 * Drives the real `check` and `download` executes through
 * `createModelTestContext`, with the GitHub API and asset downloads mocked by
 * `withMockedFetch` and the `uname` probe by `withMockedCommand`. Covers the
 * release/platform/checksum write shape, the consume-the-check-result path,
 * writing a verified file, the checksum mismatch and missing-checksum failures,
 * and the pinned-version fetch.
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
import { model } from "./github_release_install.ts";

const GLOBALS = {
  repo: "Gaurav-Gosain/tuios",
  apiUrl: "",
  userAgent: "swamp-github-release-test/1.0",
  githubToken: "",
  os: "Linux",
  arch: "x86_64",
  stem: "tuios",
  assetPattern:
    "^(?<stem>[^/]+?)_(?<version>v?\\d[0-9A-Za-z.+-]*)_(?<os>[A-Za-z0-9]+)_(?<arch>[A-Za-z0-9_]+)(?:\\.(?<ext>tar\\.gz|tgz|zip|gz|exe|bin))?$",
  checksumsName: "checksums.txt",
  format: "auto",
};

const ARCHIVE = "tuios_0.8.0_Linux_x86_64.tar.gz";
const SUM = "8246b6dae6fdb89a00d7e171fec1143d72d877ebfe93c4d866199ea8702c6a96";

function unameHandler() {
  return (command: string, args: string[]) => {
    if (command === "uname" && args[0] === "-s") {
      return { stdout: "Linux", code: 0 };
    }
    if (command === "uname" && args[0] === "-m") {
      return { stdout: "x86_64", code: 0 };
    }
    return { stdout: "", code: 1 };
  };
}

function releasePayload(withChecksums = true) {
  const assets: Record<string, unknown>[] = [
    {
      name: ARCHIVE,
      browser_download_url: "https://example.test/tuios.tar.gz",
      size: 10,
    },
  ];
  if (withChecksums) {
    assets.push({
      name: "checksums.txt",
      browser_download_url: "https://example.test/checksums.txt",
      size: 42,
    });
  }
  return {
    tag_name: "v0.8.0",
    name: "v0.8.0",
    published_at: "2026-09-27T19:17:22Z",
    prerelease: false,
    html_url: "https://github.com/Gaurav-Gosain/tuios/releases/tag/v0.8.0",
    body: "notes",
    assets,
  };
}

function runCheck(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    version: "",
    os: "Linux",
    arch: "x86_64",
    stem: undefined,
    assetName: undefined,
    pattern: undefined,
    fetchChecksums: true,
    requireChecksum: true,
    ...args,
  };
  return (model.methods.check.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

function runDownload(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    version: "",
    outputPath: "",
    outputDir: "",
    assetName: "",
    downloadUrl: "",
    releaseVersion: "",
    checksum: "",
    checksumsUrl: "",
    os: undefined,
    arch: undefined,
    stem: undefined,
    pattern: undefined,
    format: undefined,
    requireChecksum: true,
    force: false,
    ...args,
  };
  return (model.methods.download.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

Deno.test("check records the release, platform archive and SHA-256", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch((req) => {
      if (req.url.endsWith("checksums.txt")) {
        return new Response(`${SUM}  ${ARCHIVE}\n`);
      }
      return Response.json(releasePayload());
    }, async () => {
      await runCheck(ctx, {});
    });
  });

  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "release");
  const d = written[0].data as Record<string, unknown>;
  assertEquals(d.version, "0.8.0");
  assertEquals(d.tag, "v0.8.0");
  assertEquals(d.checksum, SUM);
  const platform = d.platform as Record<string, unknown>;
  assertEquals(platform.archiveName, ARCHIVE);
  assertEquals(platform.downloadUrl, "https://example.test/tuios.tar.gz");
  assertEquals(platform.format, "tar.gz");
  assertEquals(platform.supported, true);
});

Deno.test("check fails when the archive's checksum is missing", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch((req) => {
      if (req.url.endsWith("checksums.txt")) {
        return new Response(`${"0".repeat(64)}  something-else.tar.gz\n`);
      }
      return Response.json(releasePayload());
    }, async () => {
      await assertRejects(
        () => runCheck(ctx, {}),
        Error,
        "does not list this archive",
      );
    });
  });
  assertEquals(ctx.getWrittenResources().length, 0);
});

Deno.test("check marks an unsupported platform without failing", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch((req) => {
      if (req.url.endsWith("checksums.txt")) return new Response("");
      return Response.json(releasePayload());
    }, async () => {
      await runCheck(ctx, { os: "Darwin", arch: "arm64" });
    });
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  const platform = d.platform as Record<string, unknown>;
  assertEquals(platform.supported, false);
  assertEquals(platform.archiveName, undefined);
});

Deno.test("check surfaces a rate-limit error with an actionable hint", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch(() => {
      return new Response(
        JSON.stringify({ message: "API rate limit exceeded" }),
        {
          status: 403,
        },
      );
    }, async () => {
      const err = await assertRejects(() => runCheck(ctx, {}), Error);
      assertStringIncludes(err.message, "rate limit");
      assertStringIncludes(err.message, "githubToken");
    });
  });
});

Deno.test("check resolves a pinned version via the tag URL", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  let sawTagUrl = false;
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch((req) => {
      if (req.url.includes("/releases/tags/v0.7.0")) sawTagUrl = true;
      if (req.url.endsWith("checksums.txt")) {
        return new Response(`${SUM}  ${ARCHIVE}\n`);
      }
      return Response.json(releasePayload());
    }, async () => {
      await runCheck(ctx, { version: "0.7.0" });
    });
  });
  assertEquals(sawTagUrl, true);
});

Deno.test("check verifies a SHA-512 checksums file (caddy-style)", async () => {
  const caddyGlobals = {
    ...GLOBALS,
    repo: "caddyserver/caddy",
    stem: "caddy",
    checksumsName: "checksums.txt",
  };
  const archive = "caddy_2.11.4_linux_amd64.tar.gz";
  const sha512 = "a".repeat(128);
  const ctx = createModelTestContext({
    globalArgs: caddyGlobals,
    methodName: "check",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch((req) => {
      if (req.url.includes("api.github.com")) {
        return Response.json({
          tag_name: "v2.11.4",
          assets: [
            {
              name: archive,
              browser_download_url: "https://example.test/caddy.tar.gz",
            },
            // caddy's checksums file is version-prefixed.
            {
              name: "caddy_2.11.4_checksums.txt",
              browser_download_url: "https://example.test/caddy_sums.txt",
            },
          ],
        });
      }
      if (req.url.endsWith("caddy_sums.txt")) {
        return new Response(`${sha512}  ${archive}\n`);
      }
      return new Response("nope", { status: 404 });
    }, async () => {
      await runCheck(ctx, { os: "linux", arch: "amd64" });
    });
  });
  const release = ctx.getWrittenResources().find((r) =>
    r.specName === "release"
  );
  const platform = release?.data.platform as Record<string, unknown>;
  assertEquals(platform.archiveName, archive);
  assertEquals(release?.data.checksum, sha512);
  assertEquals(release?.data.checksumAlgorithm, "sha512");
});

Deno.test("check records every matching variant and picks the base build", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch((req) => {
      if (req.url.includes("api.github.com")) {
        // tuios ships main + ghostty + web for Linux/x86_64.
        return Response.json({
          tag_name: "v0.8.1",
          assets: [
            {
              name: "tuios-web_0.8.1_Linux_x86_64.tar.gz",
              browser_download_url: "https://example.test/web.tar.gz",
            },
            {
              name: "tuios-ghostty_0.8.1_Linux_x86_64.tar.gz",
              browser_download_url: "https://example.test/ghostty.tar.gz",
            },
            {
              name: "tuios_0.8.1_Linux_x86_64.tar.gz",
              browser_download_url: "https://example.test/main.tar.gz",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://example.test/checksums.txt",
            },
          ],
        });
      }
      if (req.url.endsWith("checksums.txt")) {
        return new Response(
          `${SUM}  tuios_0.8.1_Linux_x86_64.tar.gz\n` +
            `${SUM}  tuios-ghostty_0.8.1_Linux_x86_64.tar.gz\n` +
            `${SUM}  tuios-web_0.8.1_Linux_x86_64.tar.gz\n`,
        );
      }
      return new Response("nope", { status: 404 });
    }, async () => {
      // No stem set, so every tuios* variant for the platform is a candidate.
      await runCheck(ctx, { stem: "" });
    });
  });
  const platform = ctx.getWrittenResources().find((r) =>
    r.specName === "release"
  )?.data.platform as Record<string, unknown>;
  // The base build wins; all three variants are recorded.
  assertEquals(platform.archiveName, "tuios_0.8.1_Linux_x86_64.tar.gz");
  // Preference order: base build, then the shorter stem, then the longer.
  assertEquals(platform.candidates, [
    "tuios_0.8.1_Linux_x86_64.tar.gz",
    "tuios-web_0.8.1_Linux_x86_64.tar.gz",
    "tuios-ghostty_0.8.1_Linux_x86_64.tar.gz",
  ]);
});

Deno.test("check distinguishes a checksum-fetch outage from a missing entry", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch((req) => {
      if (req.url.endsWith("checksums.txt")) {
        // The checksums file itself is unreachable.
        return new Response("nope", { status: 500 });
      }
      return Response.json(releasePayload());
    }, async () => {
      const err = await assertRejects(() => runCheck(ctx, {}), Error);
      assertStringIncludes(err.message, "Could not fetch the checksums file");
      assertStringIncludes(err.message, "requireChecksum=false");
    });
  });
});

Deno.test("render writes a Markdown document from the stored release", async () => {
  // Seed the release resource check would have written (payload included).
  const release = {
    ...releasePayload(),
    version: "0.8.0",
    tag: "v0.8.0",
    fetchedAt: "2026-09-27T19:17:23Z",
    sourceUrl:
      "https://api.github.com/repos/Gaurav-Gosain/tuios/releases/latest",
    platform: {
      os: "Linux",
      arch: "x86_64",
      stem: "tuios",
      archiveName: ARCHIVE,
      downloadUrl: "https://example.test/tuios.tar.gz",
      format: "tar.gz",
      supported: true,
    },
    checksumsUrl: "https://example.test/checksums.txt",
    checksum: SUM,
    payload: releasePayload(),
  };
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "render",
    storedResources: { release },
  });
  await (model.methods.render.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(
    { includeBody: true, includeAssets: true, maxBodyChars: 0 },
    ctx.context,
  );

  const doc = ctx.getWrittenResources().find((r) => r.specName === "document");
  assertEquals(doc?.data.rendered, true);
  assertEquals(doc?.data.version, "0.8.0");
  assertStringIncludes(String(doc?.data.markdown), "## Release notes");
  assertStringIncludes(String(doc?.data.markdown), "notes");
  assertStringIncludes(String(doc?.data.markdown), ARCHIVE);
});

function runPrint(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = { installedVersion: "", ...args };
  return (model.methods.print.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

Deno.test("print reports update availability and the verified archive path", async () => {
  const release = {
    ...releasePayload(),
    version: "0.8.0",
    tag: "v0.8.0",
    platform: {
      os: "Linux",
      arch: "x86_64",
      stem: "tuios",
      archiveName: ARCHIVE,
      downloadUrl: "https://example.test/tuios.tar.gz",
      format: "tar.gz",
      supported: true,
    },
    checksum: SUM,
    payload: releasePayload(),
  };
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "print",
    storedResources: { release, archive: { path: "/tmp/tuios.tar.gz" } },
  });
  await runPrint(ctx, { installedVersion: "0.7.0" });
  const summary = ctx.getWrittenResources().find((r) =>
    r.specName === "summary"
  );
  assertEquals(summary?.data.printed, true);
  assertEquals(summary?.data.version, "0.8.0");
  assertEquals(summary?.data.updateAvailable, true);
  assertEquals(summary?.data.archivePath, "/tmp/tuios.tar.gz");
  assertStringIncludes(
    (summary?.data.lines as string[]).join("\n"),
    "update available",
  );
});

Deno.test("print fails soft when no release snapshot exists", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "print",
  });
  await runPrint(ctx, { installedVersion: "" });
  const summary = ctx.getWrittenResources()[0];
  assertEquals(summary.specName, "summary");
  assertEquals(summary.data.printed, false);
  assertStringIncludes(
    String((summary.data.lines as string[])[0]),
    "run the check method",
  );
});

Deno.test("render fails soft when no release snapshot exists", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "render",
  });
  await (model.methods.render.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(
    { includeBody: true, includeAssets: true, maxBodyChars: 0 },
    ctx.context,
  );
  const doc = ctx.getWrittenResources()[0];
  assertEquals(doc.specName, "document");
  assertEquals(doc.data.rendered, false);
  assertStringIncludes(String((doc.data.lines as string[])[0]), "check method");
});

Deno.test("download downloads, verifies and writes the archive", async () => {
  const bytes = new TextEncoder().encode("archive-bytes");
  const sum = await sha256(bytes);
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: GLOBALS,
      methodName: "download",
    });
    await withMockedCommand(unameHandler(), async () => {
      await withMockedFetch((req) => {
        if (req.url.includes("api.github.com")) {
          return Response.json(releasePayload());
        }
        if (req.url.endsWith("checksums.txt")) {
          return new Response(`${sum}  ${ARCHIVE}\n`);
        }
        if (req.url.endsWith("tuios.tar.gz")) {
          return new Response(bytes);
        }
        return new Response("not found", { status: 404 });
      }, async () => {
        await runDownload(ctx, {
          outputPath: `${tmpDir}/out.tar.gz`,
        });
      });
    });

    const archive = ctx.getWrittenResources().find((r) =>
      r.specName === "archive"
    );
    assertEquals(archive?.data.checksumVerified, true);
    assertEquals(archive?.data.path, `${tmpDir}/out.tar.gz`);
    assertEquals(archive?.data.bytes, bytes.length);
    const written = await Deno.readFile(`${tmpDir}/out.tar.gz`);
    assertEquals(new TextDecoder().decode(written), "archive-bytes");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("download consumes check's url/checksum without re-fetching", async () => {
  const bytes = new TextEncoder().encode("archive-bytes");
  const sum = await sha256(bytes);
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: GLOBALS,
      methodName: "download",
    });
    let apiCalls = 0;
    await withMockedCommand(unameHandler(), async () => {
      await withMockedFetch((req) => {
        if (req.url.includes("api.github.com")) {
          apiCalls++;
          return new Response("must not fetch", { status: 500 });
        }
        if (req.url.endsWith("tuios.tar.gz")) {
          return new Response(bytes);
        }
        return new Response("nope", { status: 404 });
      }, async () => {
        await runDownload(ctx, {
          outputPath: `${tmpDir}/out.tar.gz`,
          assetName: ARCHIVE,
          downloadUrl: "https://example.test/tuios.tar.gz",
          releaseVersion: "0.8.0",
          checksum: sum,
        });
      });
    });
    assertEquals(apiCalls, 0);
    const archive = ctx.getWrittenResources().find((r) =>
      r.specName === "archive"
    );
    assertEquals(archive?.data.checksumVerified, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("download writes into outputDir keeping the archive name", async () => {
  const bytes = new TextEncoder().encode("archive-bytes");
  const sum = await sha256(bytes);
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: GLOBALS,
      methodName: "download",
    });
    await withMockedCommand(unameHandler(), async () => {
      await withMockedFetch((req) => {
        if (req.url.endsWith("tuios.tar.gz")) return new Response(bytes);
        return new Response("nope", { status: 404 });
      }, async () => {
        await runDownload(ctx, {
          outputDir: tmpDir,
          assetName: ARCHIVE,
          downloadUrl: "https://example.test/tuios.tar.gz",
          releaseVersion: "0.8.0",
          checksum: sum,
        });
      });
    });
    const archive = ctx.getWrittenResources().find((r) =>
      r.specName === "archive"
    );
    assertEquals(archive?.data.path, `${tmpDir}/${ARCHIVE}`);
    assertEquals((await Deno.stat(`${tmpDir}/${ARCHIVE}`)).isFile, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("download rejects a relative outputPath", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "download",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch(() => {
      throw new Error("must not fetch");
    }, async () => {
      await assertRejects(
        () =>
          runDownload(ctx, {
            outputPath: "relative/out.tar.gz",
            assetName: ARCHIVE,
            downloadUrl: "https://example.test/tuios.tar.gz",
            releaseVersion: "0.8.0",
            checksum: "abc",
          }),
        Error,
        "absolute",
      );
    });
  });
});

Deno.test("download fails on a checksum mismatch", async () => {
  const bytes = new TextEncoder().encode("tampered");
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = createModelTestContext({
      globalArgs: GLOBALS,
      methodName: "download",
    });
    await withMockedCommand(unameHandler(), async () => {
      await withMockedFetch((req) => {
        if (req.url.endsWith("tuios.tar.gz")) return new Response(bytes);
        return new Response("nope", { status: 404 });
      }, async () => {
        await assertRejects(
          () =>
            runDownload(ctx, {
              outputPath: `${tmpDir}/out.tar.gz`,
              assetName: ARCHIVE,
              downloadUrl: "https://example.test/tuios.tar.gz",
              releaseVersion: "0.8.0",
              checksum: "0".repeat(64),
            }),
          Error,
          "Checksum mismatch",
        );
      });
    });
    // Nothing written on a mismatch.
    let exists = true;
    try {
      await Deno.stat(`${tmpDir}/out.tar.gz`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("download fails when no checksum is available", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "download",
  });
  await withMockedCommand(unameHandler(), async () => {
    await withMockedFetch(() => {
      return Response.json({
        tag_name: "v0.8.0",
        assets: [
          {
            name: ARCHIVE,
            browser_download_url: "https://example.test/tuios.tar.gz",
          },
        ],
      });
    }, async () => {
      await assertRejects(
        () => runDownload(ctx, {}),
        Error,
        "No SHA-256 available",
      );
    });
  });
});

/** SHA-256 of a byte array as lowercase hex. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
