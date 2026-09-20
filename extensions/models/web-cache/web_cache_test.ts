import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1";

import { fnv1a, model, normalizeUrl, webCacheKey } from "./web_cache.ts";

Deno.test("fnv1a is deterministic", () => {
  assertEquals(fnv1a("hello"), fnv1a("hello"));
  assertEquals(fnv1a("hello"), "4f9f2cab");
});

Deno.test("webCacheKey is stable and URL-only", () => {
  const a = webCacheKey("https://en.wikipedia.org/wiki/Alfred_Bester");
  const b = webCacheKey("https://en.wikipedia.org/wiki/Alfred_Bester");
  assertEquals(a, b);
});

Deno.test("webCacheKey differs across URLs", () => {
  assertNotEquals(
    webCacheKey("https://en.wikipedia.org/wiki/Alfred_Bester"),
    webCacheKey("https://en.wikipedia.org/wiki/Isaac_Asimov"),
  );
});

Deno.test("webCacheKey strips the scheme from the slug", () => {
  const key = webCacheKey("https://example.com/foo/bar");
  assertEquals(key.includes("http"), false);
});

Deno.test("normalizeUrl sorts query params", () => {
  const a = normalizeUrl("https://e.com/x?a=1&b=2");
  const b = normalizeUrl("https://e.com/x?b=2&a=1");
  assertEquals(a, b);
  assertEquals(webCacheKey("https://e.com/x?a=1&b=2"), webCacheKey("https://e.com/x?b=2&a=1"));
});

Deno.test("normalizeUrl lowercases host and strips fragment", () => {
  const a = normalizeUrl("https://EN.wikipedia.ORG/wiki/Foo#section");
  assertEquals(a, "https://en.wikipedia.org/wiki/Foo");
});

Deno.test("normalizeUrl drops default ports", () => {
  const a = normalizeUrl("https://example.com:443/x");
  const b = normalizeUrl("https://example.com/x");
  assertEquals(a, b);
});

Deno.test("webCacheKey is insensitive to + vs %20 in query", () => {
  const a = webCacheKey("https://e.com/s?search=Alfred+Bester&limit=5");
  const b = webCacheKey("https://e.com/s?limit=5&search=Alfred%20Bester");
  assertEquals(a, b);
});

// ---------------------------------------------------------------------------
// Method integration (fake fetch + temp cache dir)
// ---------------------------------------------------------------------------

interface CapturedResource {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A response or a function that produces one (which may throw to simulate a network error). */
type FetchStep = FakeResponse | (() => FakeResponse);

function makeContext(globals: Record<string, unknown>) {
  const written: CapturedResource[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      warning: () => {},
      error: () => {},
    },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

async function newCacheDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "web-cache-test-" });
}

/**
 * Install a fake `globalThis.fetch` that replays `steps` in order (the last
 * step repeats once exhausted) and records each requested URL. Restores the
 * original fetch afterwards.
 */
async function withFetch<T>(
  steps: FetchStep[],
  fn: (calls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (input: string | URL | Request) => {
    calls.push(String(input));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const r = typeof step === "function" ? step() : step;
    const body = r.status === 204 || r.status === 205 || r.status === 304
      ? null
      : (r.body ?? "");
    return Promise.resolve(
      new Response(body, { status: r.status, headers: r.headers }),
    );
  };
  try {
    return await fn(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  }
}

/** Default globals: no pacing/retry delay so tests run fast, isolated cache dir. */
function fastGlobals(cacheDir: string, extra: Record<string, unknown> = {}) {
  return {
    cacheDir,
    requestDelayMs: 0,
    retryDelayMs: 0,
    maxRetries: 1,
    defaultMaxAgeMs: 0,
    ...extra,
  };
}

Deno.test("get caches the first response and serves later calls from cache", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{ status: 200, body: "hello", headers: { etag: "abc" } }], async (calls) => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      const second = await model.methods.get.execute(
        { url: "https://e.com/a", forceRefresh: false },
        context,
      );
      assertEquals(second.dataHandles.length, 1);
      assertEquals(calls.length, 1); // second call was a cache hit
    });
    assertEquals(written.length, 2);
    assertEquals(written[0].data.body, "hello");
    assertEquals(written[0].data.fromCache, false);
    assertEquals(written[0].data.status, 200);
    const headers = written[0].data.headers as Record<string, string>;
    assertEquals(headers.etag, "abc");
    assertEquals(written[1].data.body, "hello");
    assertEquals(written[1].data.fromCache, true);
    assertEquals(written[1].data.refreshed, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get with forceRefresh re-fetches and marks refreshed", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([
      { status: 200, body: "one" },
      { status: 200, body: "two" },
    ], async (calls) => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: true }, context);
      assertEquals(calls.length, 2);
    });
    assertEquals(written[1].data.body, "two");
    assertEquals(written[1].data.fromCache, false);
    assertEquals(written[1].data.refreshed, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get returns null body and records status on a non-ok response", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{ status: 404, body: "not found" }], async () => {
      await model.methods.get.execute({ url: "https://e.com/missing", forceRefresh: false }, context);
    });
    assertEquals(written[0].data.body, null);
    assertEquals(written[0].data.status, null);
    assertEquals(written[0].data.fromCache, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get marks a stale entry as refreshed", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(
      fastGlobals(dir, { defaultMaxAgeMs: 1 }),
    );
    await withFetch([
      { status: 200, body: "old" },
      { status: 200, body: "new" },
    ], async (calls) => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      await new Promise((r) => setTimeout(r, 5));
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      assertEquals(calls.length, 2);
    });
    assertEquals(written[1].data.body, "new");
    assertEquals(written[1].data.fromCache, false);
    assertEquals(written[1].data.refreshed, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-json parses a JSON body", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{ status: 200, body: '{"a":1,"b":[2,3]}' }], async () => {
      await model.methods["get-json"].execute(
        { url: "https://e.com/j", forceRefresh: false },
        context,
      );
    });
    assertEquals(written[0].specName, "json");
    assertEquals(written[0].data.json, { a: 1, b: [2, 3] });
    assertEquals(written[0].data.fromCache, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-json yields null for an invalid JSON body", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{ status: 200, body: "<html>not json</html>" }], async () => {
      await model.methods["get-json"].execute(
        { url: "https://e.com/html", forceRefresh: false },
        context,
      );
    });
    assertEquals(written[0].data.json, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get retries a 429 and succeeds on a later attempt", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(
      fastGlobals(dir, { maxRetries: 2, retryDelayMs: 0 }),
    );
    await withFetch([
      { status: 429, body: "slow down", headers: { "retry-after": "0" } },
      { status: 200, body: "eventually" },
    ], async (calls) => {
      await model.methods.get.execute({ url: "https://e.com/r", forceRefresh: false }, context);
      assertEquals(calls.length, 2);
    });
    assertEquals(written[0].data.body, "eventually");
    assertEquals(written[0].data.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get gives up and throws after exhausting 429 retries", async () => {
  const dir = await newCacheDir();
  try {
    const { context } = makeContext(fastGlobals(dir, { maxRetries: 0 }));
    await withFetch([{ status: 429, body: "nope" }], async (calls) => {
      await assertRejects(
        () =>
          model.methods.get.execute(
            { url: "https://e.com/rl", forceRefresh: false },
            context,
          ),
        Error,
        "Rate limited",
      );
      assertEquals(calls.length, 1);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get falls back to the cached copy when the origin errors", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([
      { status: 200, body: "cached-body" },
      () => {
        throw new TypeError("network down");
      },
    ], async () => {
      await model.methods.get.execute({ url: "https://e.com/f", forceRefresh: false }, context);
      await model.methods.get.execute({ url: "https://e.com/f", forceRefresh: true }, context);
    });
    assertEquals(written[1].data.body, "cached-body");
    assertEquals(written[1].data.fromCache, true);
    assertEquals(written[1].data.refreshed, false);
    assertEquals(written[1].data.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get returns null on an origin error with no cached copy", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([() => {
      throw new TypeError("network down");
    }], async () => {
      await model.methods.get.execute({ url: "https://e.com/x", forceRefresh: false }, context);
    });
    assertEquals(written[0].data.body, null);
    assertEquals(written[0].data.fromCache, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get paces origin requests using the persisted last-request time", async () => {
  const dir = await newCacheDir();
  try {
    const delay = 60;
    const { context } = makeContext(fastGlobals(dir, { requestDelayMs: delay }));
    // Simulate a request that just happened in a previous run.
    await Deno.writeTextFile(`${dir}/.last-request`, String(Date.now()));
    const started = Date.now();
    await withFetch([{ status: 200, body: "ok" }], async () => {
      await model.methods.get.execute({ url: "https://e.com/paced", forceRefresh: false }, context);
    });
    const elapsed = Date.now() - started;
    assertEquals(elapsed >= delay - 15, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-many fetches each URL and writes one handle per key", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([
      { status: 200, body: "a" },
      { status: 200, body: "b" },
    ], async (calls) => {
      await model.methods["get-many"].execute({
        urls: ["https://e.com/1", "https://e.com/2"],
        forceRefresh: false,
      }, context);
      assertEquals(calls.length, 2);
    });
    const fetches = written.filter((w) => w.specName === "fetch");
    assertEquals(fetches.length, 2);
    assertEquals(fetches[0].data.body, "a");
    assertEquals(fetches[1].data.body, "b");
    const batch = written.find((w) => w.specName === "batch");
    assertEquals(batch?.name, "get-many");
    assertEquals(batch?.data.fetched, 2);
    assertEquals(batch?.data.truncated, false);
    assertEquals(batch?.data.remaining, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-many skips blank URLs and dedupes identical cache keys", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{ status: 200, body: "once" }], async (calls) => {
      await model.methods["get-many"].execute({
        urls: [
          "",
          "  ",
          "https://e.com/dup?a=1&b=2",
          "https://e.com/dup?b=2&a=1",
        ],
        forceRefresh: false,
      }, context);
      assertEquals(calls.length, 1);
    });
    const fetches = written.filter((w) => w.specName === "fetch");
    assertEquals(fetches.length, 1);
    const batch = written.find((w) => w.specName === "batch");
    assertEquals(batch?.data.fetched, 1);
    assertEquals(batch?.data.skipped, 3); // two blank + one duplicate
    assertEquals(batch?.data.truncated, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-many caps origin fetches and leaves the remainder", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{ status: 200, body: "x" }], async (calls) => {
      const res = await model.methods["get-many"].execute({
        urls: ["https://e.com/1", "https://e.com/2", "https://e.com/3"],
        forceRefresh: false,
        maxFetches: 1,
      }, context);
      // one fetch + the batch summary
      assertEquals(res.dataHandles.length, 2);
      assertEquals(calls.length, 1);
    });
    const fetches = written.filter((w) => w.specName === "fetch");
    assertEquals(fetches.length, 1);
    const batch = written.find((w) => w.specName === "batch");
    assertEquals(batch?.data.fetched, 1);
    assertEquals(batch?.data.truncated, true);
    assertEquals(batch?.data.remaining, 2);
    assertEquals(batch?.data.maxFetches, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invalidate removes a single entry by url but keeps others", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([
      { status: 200, body: "a" },
      { status: 200, body: "b" },
    ], async () => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      await model.methods.get.execute({ url: "https://e.com/b", forceRefresh: false }, context);
    });
    await model.methods.invalidate.execute(
      { url: "https://e.com/a" } as { url: string },
      context,
    );
    assertEquals(written.at(-1)!.data.removed, 1);
    assertEquals(written.at(-1)!.data.keys, [webCacheKey("https://e.com/a")]);

    // The removed URL is now fetched again; the other stays cached.
    await withFetch([{ status: 200, body: "a2" }], async (calls) => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      await model.methods.get.execute({ url: "https://e.com/b", forceRefresh: false }, context);
      assertEquals(calls.length, 1);
      assertEquals(calls[0], "https://e.com/a");
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invalidate with no key or url clears the whole cache", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([
      { status: 200, body: "a" },
      { status: 200, body: "b" },
    ], async () => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      await model.methods.get.execute({ url: "https://e.com/b", forceRefresh: false }, context);
    });
    await model.methods.invalidate.execute({}, context);
    assertEquals(written.at(-1)!.data.removed, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invalidate by key drops a single entry", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{ status: 200, body: "a" }], async () => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
    });
    const key = webCacheKey("https://e.com/a");
    await model.methods.invalidate.execute({ key }, context);
    assertEquals(written.at(-1)!.data.keys, [key]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cache-info inspects a single entry", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([{
      status: 200,
      body: "hello",
      headers: { "cache-control": "max-age=60", etag: "xyz" },
    }], async () => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
    });
    const key = webCacheKey("https://e.com/a");
    await model.methods["cache-info"].execute({ key }, context);
    const info = written.at(-1)!;
    assertEquals(info.name, `info-${key}`);
    const entry = info.data.entry as Record<string, unknown>;
    assertEquals(entry.url, "https://e.com/a");
    assertEquals(entry.size, 5);
    assertEquals(info.data.freshnessMs, "infinite");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cache-info summarizes all entries with sizes and ages", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withFetch([
      { status: 200, body: "aa" },
      { status: 200, body: "bbbb" },
    ], async () => {
      await model.methods.get.execute({ url: "https://e.com/a", forceRefresh: false }, context);
      await model.methods.get.execute({ url: "https://e.com/b", forceRefresh: false }, context);
    });
    await model.methods["cache-info"].execute({}, context);
    const summary = written.at(-1)!;
    assertEquals(summary.name, "summary");
    assertEquals(summary.data.count, 2);
    assertEquals(summary.data.totalBytes, 6);
    const entries = summary.data.entries as Record<string, unknown>[];
    assertEquals(entries.length, 2);
    assertEquals(
      entries.map((e) => e.url).sort(),
      ["https://e.com/a", "https://e.com/b"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cache-info reports null entry for an unknown key", async () => {
  const dir = await newCacheDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await model.methods["cache-info"].execute({ key: "does-not-exist" }, context);
    assertEquals(written[0].data.entry, null);
    assertEquals(written[0].data.freshnessMs, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

