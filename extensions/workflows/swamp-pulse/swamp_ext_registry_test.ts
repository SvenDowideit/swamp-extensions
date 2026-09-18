/**
 * Unit tests for the extension-registry collector (`swamp_ext_registry.ts`).
 *
 * Run: ~/.swamp/deno/deno test extensions/workflows/swamp-pulse/swamp_ext_registry_test.ts
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { model, normalizeExtension, repoHost } from "./swamp_ext_registry.ts";
import { celUnescape } from "./cel_text.ts";

const globalArgs = {
  host: "swamp-club.com",
  requestTimeoutMs: 20000,
  pageSize: 100,
};

/** Build one raw registry row. */
function rawRow(over: Record<string, unknown> = {}) {
  return {
    name: "@scope/tool",
    namespace: "@scope",
    description: "Does a thing.",
    repository: "https://github.com/scope/tool",
    repositoryVerified: true,
    homepageUrl: null,
    latestVersion: "2026.09.18.1",
    latestRc: null,
    latestBeta: null,
    author: { username: "someone", displayName: "Someone" },
    labels: ["tool"],
    contentTypes: ["models"],
    platforms: [],
    score: { percentage: 100, grade: "A" },
    pullCount: 5,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    ...over,
  };
}

/** A registry search response with paging metadata. */
function searchResponse(rows: unknown[], total = rows.length): Response {
  return new Response(
    JSON.stringify({
      extensions: rows,
      meta: { total, page: 1, perPage: 100 },
    }),
    { status: 200 },
  );
}

Deno.test("repoHost extracts the host and tolerates junk", () => {
  assertEquals(repoHost("https://github.com/a/b"), "github.com");
  assertEquals(repoHost("https://codeberg.org/a/b"), "codeberg.org");
  assertEquals(repoHost(""), "");
  assertEquals(repoHost("not a url"), "");
});

Deno.test("normalizeExtension classifies new vs updated by timestamp", () => {
  const window = {
    sinceMs: Date.parse("2026-09-17T00:00:00Z"),
    untilMs: Date.parse("2026-09-19T00:00:00Z"),
  };
  const now = Date.parse("2026-09-18T00:00:00Z");
  const fresh = normalizeExtension(
    rawRow({
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }),
    window,
    "swamp-club.com",
  );
  assert(fresh.isNew, "same created/updated in window should be new");
  assert(!fresh.isUpdated, "a new extension is not also updated");

  const changed = normalizeExtension(
    rawRow({
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: new Date(now).toISOString(),
    }),
    window,
    "swamp-club.com",
  );
  assert(changed.isUpdated, "old created but recent update should be updated");
  assert(!changed.isNew);

  const untouched = normalizeExtension(
    rawRow({
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    }),
    window,
    "swamp-club.com",
  );
  assert(!untouched.isNew && !untouched.isUpdated);
});

Deno.test("normalizeExtension builds the registry URL and escapes descriptions", () => {
  const ext = normalizeExtension(
    rawRow({
      name: "@scope/tool",
      description: "uses ${{ env.VAR }} in docs",
    }),
    { sinceMs: 0, untilMs: Date.now() },
    "swamp-club.com",
  );
  assertEquals(
    ext.registryUrl,
    "https://swamp-club.com/extensions/@scope/tool",
  );
  // CEL-escaped on the way out (restored by the pulse model on read).
  assertEquals(celUnescape(ext.description), "uses ${{ env.VAR }} in docs");
});

Deno.test("normalizeExtension tolerates missing optional fields", () => {
  const ext = normalizeExtension(
    { name: "@x/y" },
    { sinceMs: 0, untilMs: Date.now() },
    "swamp-club.com",
  );
  assertEquals(ext.repository, "");
  assertEquals(ext.repositoryHost, "");
  assertEquals(ext.labels, []);
  assertEquals(ext.scoreGrade, "");
  assertEquals(ext.pullCount, 0);
  assertEquals(ext.author, "");
});

Deno.test("collect_extensions reports new, updated and most pulled", async () => {
  await withMockedFetch(() =>
    searchResponse([
      rawRow({
        name: "@a/new",
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
        pullCount: 0,
      }),
      rawRow({
        name: "@b/changed",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
        pullCount: 12,
      }),
      rawRow({
        name: "@swamp/popular",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        pullCount: 999,
      }),
    ], 1611), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName: "collect_extensions",
    });
    await model.methods.collect_extensions.execute(
      {
        since: "2026-09-17T00:00:00Z",
        until: "2026-09-19T00:00:00Z",
        maxPages: 5,
        significantLimit: 5,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      count: number;
      newCount: number;
      updatedCount: number;
      totalRegistry: number;
      significant: { name: string }[];
    };
    assertEquals(data.count, 2);
    assertEquals(data.newCount, 1);
    assertEquals(data.updatedCount, 1);
    assertEquals(data.totalRegistry, 1611);
    // Significance is all-time pull count, and includes un-windowed extensions.
    assertEquals(data.significant[0].name, "@swamp/popular");
  });
});

Deno.test("collect_extensions stops paging once past the window", async () => {
  let calls = 0;
  await withMockedFetch((req) => {
    calls++;
    const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
    if (page === 1) {
      return searchResponse([
        rawRow({
          name: "@fresh",
          createdAt: "2026-09-18T00:00:00Z",
          updatedAt: "2026-09-18T00:00:00Z",
        }),
      ], 5000);
    }
    // Page 2 is entirely before the window.
    return searchResponse([
      rawRow({
        name: "@old",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    ], 5000);
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { ...globalArgs, pageSize: 1 },
      methodName: "collect_extensions",
    });
    await model.methods.collect_extensions.execute(
      {
        since: "2026-09-17T00:00:00Z",
        until: "2026-09-19T00:00:00Z",
        maxPages: 10,
        significantLimit: 5,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(
      calls,
      2,
      "should stop after the page that predates the window",
    );
    const data = getWrittenResources()[0].data as { count: number };
    assertEquals(data.count, 1);
  });
});

Deno.test("collect_extensions surfaces registry HTTP errors", async () => {
  await withMockedFetch(
    () => new Response("registry exploded", { status: 500 }),
    async () => {
      const { context } = createModelTestContext({
        globalArgs,
        methodName: "collect_extensions",
      });
      let message = "";
      try {
        await model.methods.collect_extensions.execute(
          {
            since: "2026-09-17T00:00:00Z",
            maxPages: 1,
            significantLimit: 1,
          },
          // deno-lint-ignore no-explicit-any
          context as any,
        );
      } catch (err) {
        message = String(err);
      }
      assertStringIncludes(message, "HTTP 500");
      assertStringIncludes(message, "registry exploded");
    },
  );
});

Deno.test("collect_extensions marks truncation when the page cap is reached", async () => {
  await withMockedFetch(() =>
    searchResponse([
      rawRow({
        name: "@fresh",
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
      }),
    ], 5000), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { ...globalArgs, pageSize: 1 },
      methodName: "collect_extensions",
    });
    await model.methods.collect_extensions.execute(
      {
        since: "2026-09-17T00:00:00Z",
        until: "2026-09-19T00:00:00Z",
        maxPages: 1,
        significantLimit: 5,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as { truncated: boolean };
    assertEquals(data.truncated, true);
  });
});
