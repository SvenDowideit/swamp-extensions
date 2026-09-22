/**
 * Tests for the shared on-disk response cache.
 *
 * Covers the pure key/normalisation helpers plus the read/write round-trip
 * against a real temp directory, including the failure paths a domain model
 * relies on: a cache miss reports "not synced yet" (null) rather than throwing.
 * No network, no credentials.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertGreater,
  assertRejects,
} from "jsr:@std/assert@1";
import {
  type CacheEntry,
  cacheKey,
  expandHome,
  fnv1a,
  isFresh,
  loadBody,
  loadEntry,
  markRequestAt,
  normalizePath,
  readCachedByPath,
  readLastRequestAt,
  sleep,
  storeEntry,
} from "./garmin_cache.ts";

// --- key derivation ---------------------------------------------------------

Deno.test("normalizePath canonicalises query order and drops fragment", () => {
  assertEquals(normalizePath("/a/b?z=2&a=1#frag"), "/a/b?a=1&z=2");
  assertEquals(normalizePath("/a/b"), "/a/b");
  assertEquals(normalizePath("/x?start=0&limit=20"), "/x?limit=20&start=0");
});

Deno.test("cacheKey is stable, filesystem-safe and path-sensitive", () => {
  const key = cacheKey("/userprofile-service/socialProfile");
  assert(/^[a-zA-Z0-9-]+$/.test(key));
  assertEquals(key, cacheKey("/userprofile-service/socialProfile"));
  // Param order shares a key; a different request does not.
  assertEquals(cacheKey("/x?a=1&b=2"), cacheKey("/x?b=2&a=1"));
  assert(cacheKey("/a") !== cacheKey("/b"));
});

Deno.test("fnv1a is a deterministic 8-hex digest", () => {
  assertEquals(fnv1a("hello"), fnv1a("hello"));
  assertEquals(fnv1a("hello").length, 8);
  assert(fnv1a("hello") !== fnv1a("world"));
});

Deno.test("expandHome expands a leading tilde and leaves abs paths", () => {
  const home = Deno.env.get("HOME");
  if (home) assertEquals(expandHome("~/x"), `${home}/x`);
  assertEquals(expandHome("~"), home ?? "~");
  assertEquals(expandHome("/abs/x"), "/abs/x");
  assertEquals(expandHome("relative/x"), "relative/x");
});

// --- freshness --------------------------------------------------------------

Deno.test("isFresh treats maxAgeMs<=0 as never-expire", () => {
  const entry = freshEntry(new Date(0).toISOString());
  assertEquals(isFresh(entry, 0, Date.now()), true);
  assertEquals(isFresh(entry, -1, Date.now()), true);
  assertEquals(isFresh(entry, 1000, Date.now()), false);
});

Deno.test("isFresh accepts a recent entry within the window", () => {
  const now = Date.now();
  const entry = freshEntry(new Date(now - 500).toISOString());
  assertEquals(isFresh(entry, 1000, now), true);
  // Unparseable timestamps are treated as fresh rather than expiring forever.
  assertEquals(isFresh(freshEntry("not-a-date"), 1, now), true);
});

// --- read/write round-trip --------------------------------------------------

Deno.test("storeEntry then loadEntry/loadBody round-trips", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const entry = freshEntry(new Date().toISOString());
    await storeEntry(dir, entry, "the-body");

    assertEquals(await loadEntry(dir, entry.key), entry);
    assertEquals(await loadBody(dir, entry.key), "the-body");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readCachedByPath finds a stored body by connectapi path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = "/userprofile-service/socialProfile";
    const entry = { ...freshEntry(new Date().toISOString()), path };
    await storeEntry(dir, { ...entry, key: cacheKey(path) }, "{}");

    const hit = await readCachedByPath(dir, path);
    assertEquals(hit.body, "{}");
    assertEquals(hit.entry?.path, path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- failure paths ----------------------------------------------------------

Deno.test("loadEntry/loadBody return null on a cache miss", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await loadEntry(dir, "absent"), null);
    assertEquals(await loadBody(dir, "absent"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readCachedByPath reports a miss as null, not a throw", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const miss = await readCachedByPath(dir, "/never/fetched");
    assertEquals(miss.body, null);
    assertEquals(miss.entry, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadEntry returns null when meta.json is corrupt", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const key = cacheKey("/corrupt");
    await Deno.mkdir(`${dir}/${key}`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${key}/meta.json`, "{not json");
    assertEquals(await loadEntry(dir, key), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("storeEntry rejects when the cache dir is unwritable", async () => {
  const parent = await Deno.makeTempDir();
  try {
    // A file where a directory is expected makes mkdir fail.
    const blocked = `${parent}/blocked`;
    await Deno.writeTextFile(blocked, "x");
    await assertRejects(() =>
      storeEntry(blocked, freshEntry(new Date().toISOString()), "body")
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

// --- pacing -----------------------------------------------------------------

Deno.test("readLastRequestAt defaults to 0 when unset", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readLastRequestAt(dir), 0);
    const before = Date.now();
    await markRequestAt(dir);
    const after = Date.now();
    const recorded = await readLastRequestAt(dir);
    assertGreater(recorded, before - 1);
    assert(recorded <= after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readLastRequestAt ignores a corrupt marker", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/.last-request`, "garbage");
    assertEquals(await readLastRequestAt(dir), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markRequestAt is best-effort when the dir is unwritable", async () => {
  const parent = await Deno.makeTempDir();
  try {
    const blocked = `${parent}/blocked`;
    await Deno.writeTextFile(blocked, "x");
    // Must not throw — pacing state is best-effort.
    await markRequestAt(blocked);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

// --- misc -------------------------------------------------------------------

Deno.test("sleep resolves after the given delay", async () => {
  const start = Date.now();
  await sleep(10);
  assertGreater(Date.now() - start, 0);
});

/** A well-formed cache entry for the freshness/round-trip tests. */
function freshEntry(fetchedAt: string): CacheEntry {
  return {
    key: "test-key",
    path: "/test",
    url: "https://connectapi.garmin.com/test",
    status: 200,
    ok: true,
    fetchedAt,
    contentType: "application/json",
    size: 2,
  };
}
