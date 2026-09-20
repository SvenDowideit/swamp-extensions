import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";

import { fnv1a, normalizeUrl, webCacheKey } from "./web_cache.ts";

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

