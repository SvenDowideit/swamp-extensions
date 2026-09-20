import { assertEquals } from "jsr:@std/assert@1";

import { esc, freshState } from "./ebooks.ts";

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
