import { assertEquals } from "jsr:@std/assert@1";

import { esc, freshState, sanitizeResolutionMap } from "./ebooks.ts";

Deno.test("esc escapes HTML special characters", () => {
  assertEquals(esc("a&b"), "a&amp;b");
  assertEquals(esc("a<b>c"), "a&lt;b&gt;c");
  assertEquals(esc('say "hi"'), "say &quot;hi&quot;");
});

Deno.test("esc leaves plain text unchanged", () => {
  assertEquals(esc("The Demolished Man"), "The Demolished Man");
});

Deno.test("freshState initializes an empty scan state", () => {
  const s = freshState("/home/me/books");
  assertEquals(s.root, "/home/me/books");
  assertEquals(s.completed, false);
  assertEquals(s.queue, ["/home/me/books"]);
  assertEquals(s.seenDirs, []);
  assertEquals(s.ebooks, []);
  assertEquals(s.scannedDirs, 0);
});

Deno.test("sanitizeResolutionMap drops non-resolution entries", () => {
  const map = {
    "Alfred Bester": { name: "Alfred Bester", kind: "author" },
    outputPath: "/tmp/x.html",
    count: 3,
    generatedAt: "2026-09-20T00:00:00Z",
  };
  const out = sanitizeResolutionMap(map);
  assertEquals(Object.keys(out), ["Alfred Bester"]);
});

Deno.test("sanitizeResolutionMap handles null and empty", () => {
  assertEquals(sanitizeResolutionMap(null), {} as Record<string, unknown>);
  assertEquals(sanitizeResolutionMap({}), {} as Record<string, unknown>);
});

Deno.test("sanitizeResolutionMap keeps resolution-like entries", () => {
  const map = {
    a: { name: "A", kind: "author", url: null },
    b: { name: "B", kind: "book" },
    c: { title: "not a resolution" },
  };
  const out = sanitizeResolutionMap(map);
  assertEquals(Object.keys(out).sort(), ["a", "b"]);
});
