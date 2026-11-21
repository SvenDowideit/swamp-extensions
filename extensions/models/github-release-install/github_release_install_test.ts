/**
 * Sibling tests for `github_release_install.ts` (the model file itself).
 *
 * `github_release_test.ts` covers the pure helpers in `github_release.ts`, and
 * `github_release_install_methods_test.ts` covers `check`/`download`. This file
 * covers what lives in the model module: the `metadataMany` batch method — its
 * success path, the cache, truncation, a per-repository failure, and a releases
 * endpoint that fails while the repository lookup succeeds.
 *
 * All GitHub traffic is mocked with `withMockedFetch`; no test touches the network.
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { model, tagsFromReleases } from "./github_release_install.ts";

const GLOBALS = {
  // a literal token keeps resolveToken from shelling out to the `gh` CLI
  githubToken: "test-token",
  userAgent: "swamp-github-release-test/1.0",
  repo: "",
  apiUrl: "",
  os: "",
  arch: "",
  stem: "",
  assetPattern: "",
  checksumsName: "",
  format: "auto",
};

const META = {
  archived: false,
  pushed_at: "2026-11-01T00:00:00Z",
};

function releases(tag: string, published: string, prerelease = false) {
  return {
    tag_name: tag,
    published_at: published,
    prerelease,
    assets: [],
  };
}

/** Run metadataMany with the defaults the method schema fills in. */
function runMetadata(
  ctx: { context: unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  const full = {
    repos: [],
    maxRepos: 40,
    perRepo: 30,
    ttlSeconds: 21600,
    detectChannels: true,
    ...args,
  };
  return (model.methods.metadataMany.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>)(full, ctx.context);
}

Deno.test("metadataMany records latest, dev and LTS per repository", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "metadataMany",
  });
  await withMockedFetch((req) => {
    const url = req.url.toString();
    if (url.endsWith("/releases?per_page=30")) {
      return Response.json([
        releases("v4.1.0-rc1", "2026-11-10T00:00:00Z", true),
        releases("v4.0.0", "2026-10-01T00:00:00Z"),
        releases("v3.5.0-lts.2", "2026-09-01T00:00:00Z"),
        releases("v3.4.0-lts", "2026-01-01T00:00:00Z"),
      ]);
    }
    return Response.json(META);
  }, async () => {
    await runMetadata(ctx, { repos: ["acme/tool"] });
  });

  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "releases");
  const d = written[0].data as { repos: Array<Record<string, unknown>> };
  const repo = d.repos[0];
  assertEquals(repo.repo, "acme/tool");
  assertEquals(repo.ok, true);
  assertEquals(repo.archived, false);
  assertEquals((repo.latest as { tag: string }).tag, "v4.0.0");
  assertEquals((repo.dev as { tag: string }).tag, "v4.1.0-rc1");
  // newest tag that names itself LTS, not a guess from the version number
  assertEquals((repo.lts as { tag: string }).tag, "v3.5.0-lts.2");
  assertEquals((repo.tags as unknown[]).length, 4);
});

Deno.test("metadataMany records a repository that does not exist without throwing", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "metadataMany",
  });
  await withMockedFetch(
    () => new Response("not found", { status: 404 }),
    async () => {
      await runMetadata(ctx, { repos: ["acme/missing"] });
    },
  );

  const d = ctx.getWrittenResources()[0].data as {
    repos: Array<Record<string, unknown>>;
    fetched: number;
  };
  assertEquals(d.repos[0].ok, false);
  assertStringIncludes(String(d.repos[0].error), "404");
  assertEquals(d.fetched, 0);
});

Deno.test("metadataMany caps the list and says it truncated", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "metadataMany",
  });
  const seen: string[] = [];
  await withMockedFetch((req) => {
    const url = req.url.toString();
    seen.push(url);
    if (url.endsWith("/releases?per_page=30")) return Response.json([]);
    return Response.json(META);
  }, async () => {
    await runMetadata(ctx, {
      repos: ["acme/a", "acme/b", "acme/c"],
      maxRepos: 2,
    });
  });

  const d = ctx.getWrittenResources()[0].data as {
    repos: unknown[];
    requested: number;
    truncated: boolean;
  };
  assertEquals(d.requested, 3);
  assertEquals(d.repos.length, 2);
  assertEquals(d.truncated, true);
  // only two repositories were actually fetched
  assertEquals(seen.filter((u) => !u.includes("/releases")).length, 2);
});

Deno.test("metadataMany reuses a previous result inside the TTL", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "metadataMany",
    storedResources: {
      releases: {
        repos: [
          {
            repo: "acme/tool",
            ok: true,
            latest: { version: "4.0.0", publishedAt: "", tag: "v4.0.0" },
            tags: [],
            fetchedAt: new Date().toISOString(),
          },
        ],
      },
    },
  });
  let fetched = false;
  await withMockedFetch(() => {
    fetched = true;
    return Response.json(META);
  }, async () => {
    await runMetadata(ctx, { repos: ["acme/tool"], ttlSeconds: 3600 });
  });

  assertEquals(fetched, false, "a fresh cached entry must not be re-fetched");
  const d = ctx.getWrittenResources()[0].data as {
    repos: Array<Record<string, unknown>>;
    cached: number;
    fetched: number;
  };
  assertEquals(d.cached, 1);
  assertEquals(d.fetched, 0);
  assertEquals(d.repos[0].cached, true);
});

Deno.test("metadataMany still reports the repository when the releases call fails", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "metadataMany",
  });
  await withMockedFetch((req) => {
    const url = req.url.toString();
    if (url.endsWith("/releases?per_page=30")) {
      return new Response("boom", { status: 502 });
    }
    return Response.json(META);
  }, async () => {
    await runMetadata(ctx, { repos: ["acme/tool"] });
  });

  const repo = (ctx.getWrittenResources()[0].data as {
    repos: Array<Record<string, unknown>>;
  }).repos[0];
  assertEquals(repo.ok, true);
  assertEquals(repo.latest, null);
  assertEquals((repo.tags as unknown[]).length, 0);
});

Deno.test("tagsFromReleases keeps the tag, version and date, and skips junk", () => {
  const tags = tagsFromReleases([
    { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    { tag_name: "" },
    null,
    { published_at: "nope" },
  ]);
  assertEquals(tags.length, 1);
  assertEquals(tags[0].tag, "v1.2.3");
  assertEquals(tags[0].version, "1.2.3");
  assert(tags[0].publishedAt.startsWith("2026-01-01"));
});
