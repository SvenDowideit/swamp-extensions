/**
 * Tests for the `@svendowideit/garmin-connect` transport helpers.
 *
 * The network-free parts are tested directly: cache-key normalisation,
 * freshness, session/token extraction, download path building, hashing, and
 * token-store import. The `fetch`/`login` method bodies are exercised through
 * their pure dependencies; live behaviour needs a real account (see README).
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  cacheKey,
  downloadPath,
  expandHome,
  fnv1a,
  isFresh,
  normalizePath,
  sha256Hex,
  tokensFromSession,
} from "./garmin_connect.ts";
import { importTokenStore } from "./garmin_auth.ts";

// --- cache key scheme -------------------------------------------------------

Deno.test("normalizePath sorts query params and drops the fragment", () => {
  assertEquals(
    normalizePath("/a/b?z=2&a=1#frag"),
    "/a/b?a=1&z=2",
  );
  assertEquals(normalizePath("/a/b"), "/a/b");
  // Same request, different param order -> same normalised path.
  assertEquals(
    normalizePath("/x?start=0&limit=20"),
    normalizePath("/x?limit=20&start=0"),
  );
});

Deno.test("cacheKey is stable and filesystem-safe", () => {
  const key = cacheKey("/userprofile-service/socialProfile");
  assert(/^[a-zA-Z0-9-]+$/.test(key));
  assertEquals(key, cacheKey("/userprofile-service/socialProfile"));
  // Param order does not change the key.
  assertEquals(cacheKey("/x?a=1&b=2"), cacheKey("/x?b=2&a=1"));
  // Different paths differ.
  assert(cacheKey("/a") !== cacheKey("/b"));
});

Deno.test("fnv1a is deterministic 8-hex", () => {
  assertEquals(fnv1a("hello"), fnv1a("hello"));
  assertEquals(fnv1a("hello").length, 8);
  assert(fnv1a("hello") !== fnv1a("world"));
});

Deno.test("expandHome expands a leading tilde", () => {
  const home = Deno.env.get("HOME")!;
  assertEquals(expandHome("~/x"), `${home}/x`);
  assertEquals(expandHome("/abs/x"), "/abs/x");
});

// --- freshness --------------------------------------------------------------

Deno.test("isFresh honours maxAgeMs=0 as never-expire", () => {
  const entry = {
    key: "k",
    path: "/p",
    url: "u",
    status: 200,
    ok: true,
    fetchedAt: new Date(0).toISOString(),
    contentType: null,
    size: 0,
  };
  assertEquals(isFresh(entry, 0, Date.now()), true);
  assertEquals(isFresh(entry, 1000, Date.now()), false);
});

// --- download paths ---------------------------------------------------------

Deno.test("downloadPath builds Garmin export URLs per format", () => {
  assertEquals(
    downloadPath("123", "fit"),
    "/download-service/files/activity/123",
  );
  assertEquals(
    downloadPath("123", "tcx"),
    "/download-service/export/tcx/activity/123",
  );
  assertEquals(
    downloadPath("123", "gpx"),
    "/download-service/export/gpx/activity/123",
  );
  assert(
    downloadPath("123", "csv").includes("/export/csv/activity/123"),
  );
  assertThrows(() => downloadPath("123", "nope"), Error);
});

// --- hashing ----------------------------------------------------------------

Deno.test("sha256Hex matches a known digest", async () => {
  // echo -n "abc" | sha256sum
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

// --- session extraction -----------------------------------------------------

Deno.test("tokensFromSession returns null when incomplete", () => {
  assertEquals(tokensFromSession(null), null);
  assertEquals(tokensFromSession({}), null);
  assertEquals(tokensFromSession({ oauth1: {}, oauth2: {} }), null);
});

Deno.test("tokensFromSession returns a usable pair", () => {
  const pair = tokensFromSession({
    oauth1: { oauth_token: "t", oauth_token_secret: "s", domain: "garmin.com" },
    oauth2: { access_token: "a", refresh_token: "r" },
  });
  assert(pair !== null);
  assertEquals(pair!.oauth1.oauth_token, "t");
  assertEquals(pair!.oauth2.access_token, "a");
});

// --- token store import -----------------------------------------------------

Deno.test("importTokenStore parses a garth token store", () => {
  const store = btoa(JSON.stringify([
    {
      oauth_token: "OT",
      oauth_token_secret: "OS",
      domain: "garmin.com",
    },
    {
      scope: "CONNECT_READ",
      token_type: "Bearer",
      access_token: "AT",
      refresh_token: "RT",
      expires_in: 3600,
      refresh_token_expires_in: 7200,
    },
  ]));
  const pair = importTokenStore(store, 1000);
  assertEquals(pair.oauth1.oauth_token, "OT");
  assertEquals(pair.oauth2.access_token, "AT");
  assertEquals(pair.oauth2.expires_at, 4600);
  assertEquals(pair.oauth2.refresh_token_expires_at, 8200);
});

Deno.test("importTokenStore rejects malformed input", () => {
  assertThrows(() => importTokenStore("not-base64-json", 0));
  assertThrows(() => importTokenStore(btoa("{}"), 0));
  assertThrows(() =>
    importTokenStore(btoa(JSON.stringify([{ oauth_token: "x" }])), 0)
  );
});
