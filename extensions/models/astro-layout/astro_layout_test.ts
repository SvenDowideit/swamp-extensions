import { assertEquals } from "jsr:@std/assert@1";

import {
  detectDynamicComponents,
  generateIslandPlaceholder,
  parseFrontmatter,
  sanitizeSlug,
} from "./astro_layout.ts";

Deno.test("parseFrontmatter parses YAML frontmatter correctly", () => {
  const content = `---
title: Test Page
date: 2026-07-28
slug: test-page
tags:
  - tag1
  - tag2
---
This is the body content.`;
  const result = parseFrontmatter(content);

  assertEquals(result.frontmatter?.title, "Test Page");
  assertEquals(result.frontmatter?.date, "2026-07-28");
  assertEquals(result.frontmatter?.slug, "test-page");
  assertArrayIncludes(result.frontmatter?.tags ?? [], ["tag1", "tag2"]);
  assertEquals(result.body.includes("body content"), true);
});

Deno.test("parseFrontmatter handles missing frontmatter", () => {
  const content = "# Hello World\n\nThis is markdown without frontmatter.";
  const result = parseFrontmatter(content, "Default Title");

  assertEquals(result.frontmatter?.title, "Default Title");
  assertEquals(result.body.includes("# Hello World"), true);
});

Deno.test("detectDynamicComponents extracts component markers", () => {
  const content = "content with $MyComponent$ and $AnotherComponent$";
  const result = detectDynamicComponents(content);

  assertEquals(result["MyComponent"], true);
  assertEquals(result["AnotherComponent"], true);
});

Deno.test("parseFrontmatter handles empty frontmatter", () => {
  const content = `---
title: ""
date: ""
---`;
  const result = parseFrontmatter(content, "Fallback");

  assertEquals(typeof result.frontmatter?.title === "string", true);
});

Deno.test("sanitizeSlug removes special characters and normalizes", () => {
  assertEquals(sanitizeSlug("Hello World!"), "hello-world");
  const clean = sanitizeSlug("Test-Path_File*?");
  assertEquals(clean.includes("/"), false);
  assertEquals(clean.includes("*"), false);
  assertEquals(sanitizeSlug("already-slugified-123"), "already-slugified-123");
});

Deno.test("detectDynamicComponents handles multiple instances of same component", () => {
  const content = "Some text $Button$ more text $Button$ even more $Modal$";
  const result = detectDynamicComponents(content);

  assertEquals(result["Button"], true);
  assertEquals(result["Modal"], true);
  assertEquals(Object.keys(result).length, 2);
});

Deno.test("detectDynamicComponents handles empty content", () => {
  const result = detectDynamicComponents("");
  assertEquals(Object.keys(result).length, 0);
});

Deno.test("parseFrontmatter preserves body with code blocks", () => {
  const content = `---
title: Code Example
---

\`\`\`typescript
const x = 42;
\`\`\``;

  const result = parseFrontmatter(content);

  assertEquals(result.body.includes('```typescript'), true);
  assertEquals(result.body.includes("const x = 42"), true);
});

Deno.test("parseFrontmatter handles nested markdown structures", () => {
  const content = `---
title: Nested Test
tags: [one, two]
date: "2026-07-28T10:00:00Z"
draft: true
---

# Second Level Heading

## Third Level

Some **bold** and *italic* text.

> A blockquote

- item 1
- item 2`;
  const result = parseFrontmatter(content);

  assertEquals(result.frontmatter?.title, "Nested Test");
  assertArrayIncludes(result.frontmatter?.tags ?? [], ["one", "two"]);
  assertEquals(result.body.includes("blockquote"), true);
});

Deno.test("generateIslandPlaceholder creates correct placeholder comment", () => {
  const result = generateIslandPlaceholder("MyComponent", "client");
  assertEquals(
    result,
    "<!-- TODO: Replace with MyComponent Island (client) -->",
  );
});

function assertArrayIncludes(arr: string[], items: string[]) {
  for (const item of items) {
    if (!arr.includes(item)) {
      throw new Error(`Expected array to include ${item}`);
    }
  }
}