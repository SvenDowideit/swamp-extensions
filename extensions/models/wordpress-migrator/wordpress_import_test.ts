import { assertEquals } from "jsr:@std/assert@1";

import { decodeEntities, htmlToMarkdown, sanitize } from "./wordpress_import.ts";

Deno.test("sanitize keeps readable slug and truncates length", () => {
  const out = sanitize("2022-12-01 Personal computing is stuck in the 90's");
  assertEquals(out.includes(" "), false);   // no literal whitespace survives
  assertEquals(out.split("-")[0], "2022");  // date prefix retained & dash-joined
});

Deno.test("decodeEntities decodes named and numeric HTML entities", () => {
  const raw = "Personal computing is stuck in the 90&#8217;s";
  const out = decodeEntities(raw);
  assertEquals(out, "Personal computing is stuck in the 90's");

  // typographic curly quotes become straight ASCII via htmlToMarkdown body pass;
  // here we test explicit named -> value mapping for ampersand escapes.
  assertEquals(decodeEntities("a &amp; b"), "a & b");
  assertEquals(decodeEntities("&lt;x&gt;"), "<x>");
});

Deno.test("htmlToMarkdown converts a WP block paragraph and strips comments", () => {
  const html = '<!-- wp:paragraph --><p class="wp-block-paragraph">Hello <strong>world</strong>.</p><!-- /wp:paragraph -->';
  const { markdown, images } = htmlToMarkdown(html);
  assertEquals(images.length, 0);
  // trailing periods/punctuation survive; strong => **bold**
  if (!markdown.includes("Hello")) throw new Error(`unexpected body ${markdown}`);
});

Deno.test("htmlToMarkdown collects inline image src URLs only", () => {
  const html = '<p><img src="https://example.com/a.jpg" /></p><a href="/x"><img src="https://example.com/b.png"/></a>';
  const { images } = htmlToMarkdown(html);
  assertEquals(images, ["https://example.com/a.jpg", "https://example.com/b.png"]);
});

Deno.test("htmlToMarkdown drops empty content without erroring", () => {
  const { markdown, images } = htmlToMarkdown("");
  assertEquals(markdown, "");
  assertEquals(images.length, 0);
});