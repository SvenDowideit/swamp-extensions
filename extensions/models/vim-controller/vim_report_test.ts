/**
 * Tests for the Vim edit-session report.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { formatEditSession, report } from "./vim_report.ts";

Deno.test("edit-session report renders the diff and undo sequence", () => {
  const by = new Map<string, Array<Record<string, unknown>>>([
    ["edit-result", [{
      file: "/tmp/f.ts",
      changed: true,
      saved: false,
      undoSeq: 3,
      beforeLineCount: 2,
      afterLineCount: 2,
      beforeHash: "aaa",
      afterHash: "bbb",
      diff: "--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same",
    }]],
    ["diagnostics", [{
      quickfix: [{ lnum: 3, type: "E", text: "bad" }],
      location: [],
    }]],
  ]);
  const out = formatEditSession("edit", by);
  for (
    const expected of [
      "# Edit session — edit",
      "/tmp/f.ts",
      "undo seq",
      "3",
      "```diff",
      "-old",
      "+new",
      "## Diagnostics",
      "bad",
    ]
  ) {
    assertStringIncludes(out.markdown, expected);
  }
  assertEquals(out.json.method, "edit");
});

Deno.test("edit-session report renders a buffer-vs-file diff", () => {
  const by = new Map<string, Array<Record<string, unknown>>>([
    ["diff-result", [{
      server: "vim",
      file: "/tmp/f.ts",
      changed: true,
      bufferHash: "bbb",
      fileHash: "aaa",
      diff: "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new",
    }]],
  ]);
  const out = formatEditSession("diff", by);
  assertStringIncludes(out.markdown, "## Diff — /tmp/f.ts");
  assertStringIncludes(out.markdown, "```diff");
  assertStringIncludes(out.markdown, "+new");
});

Deno.test("edit-session report renders failures", () => {
  const out = formatEditSession("edit", new Map(), "old text not found");
  assertStringIncludes(out.markdown, "**Failed:** old text not found");
});

Deno.test("edit-session report says when there is no data", () => {
  const out = formatEditSession("servers", new Map());
  assertStringIncludes(out.markdown, "No summary data");
});

Deno.test("edit-session report metadata", () => {
  assertEquals(report.name, "@svendowideit/edit-session");
  assertEquals(report.scope, "method");
});
