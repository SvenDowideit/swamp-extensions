import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  expandHome,
  fnv1a,
  normalizeUrl,
  readCachedBody,
  webCacheKey,
} from "./wikipedia_http.ts";
import { webCacheKey as webCacheKeyFromWebCache } from "../web-cache/web_cache.ts";

Deno.test("expandHome honours SWAMP_HOME for ~/.swamp paths", () => {
  const previousSwamp = Deno.env.get("SWAMP_HOME");
  const previousHome = Deno.env.get("HOME");
  try {
    Deno.env.set("SWAMP_HOME", "/tmp/swamp-home");
    Deno.env.set("HOME", "/tmp/user-home");
    assertEquals(expandHome("~/.swamp/web-cache"), "/tmp/swamp-home/web-cache");
    assertEquals(expandHome("~/elsewhere"), "/tmp/user-home/elsewhere");
  } finally {
    if (previousSwamp === undefined) Deno.env.delete("SWAMP_HOME");
    else Deno.env.set("SWAMP_HOME", previousSwamp);
    if (previousHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previousHome);
  }
});

Deno.test("cache key helpers match web-cache and are order-insensitive", () => {
  assertEquals(fnv1a("hello"), "4f9f2cab");
  assertEquals(
    normalizeUrl("https://EN.wikipedia.ORG/x?b=2&a=1#frag"),
    "https://en.wikipedia.org/x?a=1&b=2",
  );
  assertEquals(
    webCacheKey("https://e.com/x?a=1&b=2"),
    webCacheKey("https://e.com/x?b=2&a=1"),
  );
  assertEquals(
    webCacheKey("https://en.wikipedia.org/wiki/Alfred_Bester"),
    webCacheKeyFromWebCache("https://en.wikipedia.org/wiki/Alfred_Bester"),
  );
  assertStringIncludes(webCacheKey("https://e.com/x"), "e-com-x-");
});

Deno.test("readCachedBody reads a web-cache body and returns null on a miss", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-http-test-" });
  try {
    const url = "https://e.com/x";
    const key = webCacheKey(url);
    await Deno.mkdir(`${dir}/${key}`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${key}/body`, '{"ok":true}');
    assertEquals(await readCachedBody(dir, url), '{"ok":true}');
    assertEquals(await readCachedBody(dir, "https://e.com/missing"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
