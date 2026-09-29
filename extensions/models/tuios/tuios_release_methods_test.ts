/**
 * Execute-level tests for the `tuios-release` model methods.
 *
 * Drives the real `check` execute through `createModelTestContext` with the
 * GitHub API mocked by `withMockedFetch`. Covers the write shape, the
 * platform/asset selection and checksum recording, the fatal missing-checksum
 * path, the `requireChecksum=false` override, and the `fetchChecksums=false`
 * path.
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
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { model } from "./tuios_release.ts";

/** Global args with every field populated for the test context. */
const GLOBALS = {
  flavor: "std",
  repo: "Gaurav-Gosain/tuios",
  apiUrl: "https://api.github.com/repos/Gaurav-Gosain/tuios/releases/latest",
  userAgent: "swamp-tuios-test/1.0",
  githubToken: "",
  os: "Linux",
  arch: "x86_64",
};

const ARCHIVE = "tuios_0.8.0_Linux_x86_64.tar.gz";
const SUM = "8246b6dae6fdb89a00d7e171fec1143d72d877ebfe93c4d866199ea8702c6a96";

/** The GitHub release payload with the archive and a checksums asset. */
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

/** Invoke `check` with args defaults filled in. */
function runCheck(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    os: "Linux",
    arch: "x86_64",
    flavor: "std",
    archiveName: undefined,
    fetchChecksums: true,
    requireChecksum: true,
    ...args,
  };
  return (model.methods.check.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

Deno.test("check records the release, platform archive and SHA-256", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedFetch((req) => {
    if (req.url.endsWith("checksums.txt")) {
      return new Response(`${SUM}  ${ARCHIVE}\n`);
    }
    return Response.json(releasePayload());
  }, async () => {
    await runCheck(ctx, {});
  });

  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "release");
  assertEquals(written[0].name, "release");
  const d = written[0].data as Record<string, unknown>;
  assertEquals(d.version, "0.8.0");
  assertEquals(d.tag, "v0.8.0");
  assertEquals(d.checksum, SUM);
  const platform = d.platform as Record<string, unknown>;
  assertEquals(platform.archiveName, ARCHIVE);
  assertEquals(platform.downloadUrl, "https://example.test/tuios.tar.gz");
  assertEquals(platform.supported, true);
});

Deno.test("check fails when the archive's checksum is missing", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedFetch((req) => {
    if (req.url.endsWith("checksums.txt")) {
      // A checksums file that does not list our archive.
      return new Response(`${"0".repeat(64)}  something-else.tar.gz\n`);
    }
    return Response.json(releasePayload());
  }, async () => {
    await assertRejects(
      () => runCheck(ctx, {}),
      Error,
      "No SHA-256",
    );
  });
  // Nothing recorded on a fatal check.
  assertEquals(ctx.getWrittenResources().length, 0);
});

Deno.test("check records unverified when requireChecksum=false", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedFetch((req) => {
    if (req.url.endsWith("checksums.txt")) {
      return new Response(`${"0".repeat(64)}  something-else.tar.gz\n`);
    }
    return Response.json(releasePayload());
  }, async () => {
    await runCheck(ctx, { requireChecksum: false });
  });
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.checksum, null);
});

Deno.test("check skips the checksums request entirely when fetchChecksums=false", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  let checksumCalls = 0;
  await withMockedFetch((req) => {
    if (req.url.endsWith("checksums.txt")) {
      checksumCalls++;
      return new Response(`${SUM}  ${ARCHIVE}\n`);
    }
    return Response.json(releasePayload());
  }, async () => {
    await runCheck(ctx, { fetchChecksums: false });
  });
  assertEquals(checksumCalls, 0);
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.checksum, null);
});

Deno.test("check marks an unsupported platform without failing", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "check",
  });
  await withMockedFetch((req) => {
    if (req.url.endsWith("checksums.txt")) return new Response("");
    return Response.json(releasePayload());
  }, async () => {
    await runCheck(ctx, { os: "Darwin", arch: "arm64" });
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
  await withMockedFetch(() => {
    return new Response(
      JSON.stringify({ message: "API rate limit exceeded" }),
      { status: 403 },
    );
  }, async () => {
    const err = await assertRejects(() => runCheck(ctx, {}), Error);
    assertStringIncludes(err.message, "rate limit");
    assertStringIncludes(err.message, "githubToken");
  });
});
