import {
  ARCHIVE_OUTCOMES,
  archiveRequestBody,
  archiveRequestProblem,
  CAPTURE_PLACEHOLDER,
  captureRequestBody,
  captureTextProblem,
  isArchivablePath,
  isArchivedPath,
  isCardPath,
  movesForStatus,
  readableCard,
  sanitizeMarkdown,
  section,
  shouldInterceptCardOpen,
  statusFromFrontmatter,
  stripFrontmatter,
  stripManagedMarkers,
} from "./model.ts";
import mainSource from "./main.ts" with { type: "text" };
import { assert, assertEquals } from "jsr:@std/assert@1.0.0";

const raw = `---
id: fac-1
title: Test
---
# Test card

<!-- swamp:summary:begin -->
## At a glance

**Needs your input**

- A question

**Next:** Do the thing
<!-- swamp:summary:end -->

The intro paragraph.

## Brief

The brief text.

## Questions

A question.

## Feedback

## Ideas

- an idea

<!-- swamp:plan:begin -->
## Plan

**Status:** final

### Tasks

- [ ] A task

### Tests

- [ ] A test
<!-- swamp:plan:end -->

<!-- swamp:definition:begin -->
## Definition

Pinned.
<!-- swamp:definition:end -->

<!-- swamp:activity:begin -->
## Activity

Secret activity.
<!-- swamp:activity:end -->
`;

Deno.test("readableCard keeps the dialog prose and drops the machine parts", () => {
  const card = readableCard(raw);
  assertEquals(card.title, "Test card");
  assertEquals(card.brief, "The brief text.");
  assert(card.summary.includes("**Needs your input**"), "summary");
  assert(card.summary.includes("A question"), "question");
  assert(card.plan.includes("A task"), "task");
  assert(card.plan.includes("A test"), "test");
  assert(!card.summary.includes("swamp:"), "no summary markers");
  assert(!card.plan.includes("swamp:"), "no plan markers");
  assert(!card.summary.includes("Secret activity"), "no activity");
  assert(!card.plan.includes("Pinned."), "no definition");
  assert(!card.brief.includes("id: fac-1"), "no frontmatter");
});

Deno.test("section includes subsections", () => {
  const text = "## Plan\n\n### Tasks\n\n- a\n\n### Tests\n\n- b\n\n## Next\n";
  const plan = section(text, "Plan");
  assert(plan.includes("### Tasks"), "tasks heading");
  assert(plan.includes("### Tests"), "tests heading");
  assert(!plan.includes("## Next"), "stops at the next heading");
});

Deno.test("sanitizeMarkdown removes active content", () => {
  const dirty =
    '<script>alert(1)</script><iframe src="x"></iframe><div onclick="x()" onmouseover="y()">hi</div>[x](javascript:alert(1))';
  const clean = sanitizeMarkdown(dirty);
  assert(!clean.toLowerCase().includes("<script"), "script");
  assert(!clean.toLowerCase().includes("<iframe"), "iframe");
  assert(!clean.toLowerCase().includes("onclick"), "onclick");
  assert(!clean.toLowerCase().includes("onmouseover"), "onmouseover");
  assert(!clean.toLowerCase().includes("javascript:"), "javascript url");
});

Deno.test("movesForStatus lists the documented normal moves", () => {
  assertEquals(movesForStatus("Work Planned"), [
    "Please Plan",
    "Please Implement",
  ]);
  assertEquals(movesForStatus("Please Implement"), ["Please Test"]);
  assertEquals(movesForStatus("Please Release"), ["User Acceptance", "Done"]);
  assertEquals(movesForStatus("Done"), []);
  assertEquals(
    statusFromFrontmatter({ status: "Please Implement" }),
    "Please Implement",
  );
  assertEquals(statusFromFrontmatter({}), "");
  assertEquals(statusFromFrontmatter(null), "");
});

Deno.test("shouldInterceptCardOpen only intercepts normal card opens", () => {
  assert(
    shouldInterceptCardOpen("Factory/Cards/FAC-1 test.md", false),
    "normal open",
  );
  assert(
    !shouldInterceptCardOpen("Factory/Cards/FAC-1 test.md", true),
    "new leaf",
  );
  assert(!shouldInterceptCardOpen("Factory/Board.md", false), "not a card");
});

Deno.test("card paths and markers", () => {
  assert(isCardPath("Factory/Cards/FAC-1 test.md"), "card");
  assert(isCardPath("Factory/Cards/FAC-1%20test.md"), "encoded card");
  assert(!isCardPath("Factory/Board.md"), "not a card");
  assert(!isCardPath("Other/Cards/x.md"), "other folder");
  assertEquals(stripFrontmatter("---\na: 1\n---\nbody"), "body");
  assert(
    !stripManagedMarkers(
      "<!-- swamp:plan:begin -->\nx\n<!-- swamp:plan:end -->",
    ).includes("swamp:"),
    "markers",
  );
});

Deno.test("a capture box refuses empty or whitespace-only text", () => {
  assert(captureTextProblem("") !== "", "empty text refused");
  assert(captureTextProblem("   \n\t") !== "", "whitespace refused");
  assertEquals(
    captureTextProblem("the cache should be write-through"),
    "",
    "a thought is enough",
  );
  assert(CAPTURE_PLACEHOLDER.length > 0, "the box has a placeholder");
});

Deno.test("a capture request keeps the text and trims the edges", () => {
  assertEquals(
    captureRequestBody("  the cache should be write-through  "),
    { text: "the cache should be write-through" },
    "text kept as typed, edges trimmed",
  );
  assertEquals(
    captureRequestBody("keep  the double space"),
    { text: "keep  the double space" },
    "inner spacing is not rewritten",
  );
});

Deno.test("the kanban board page gets a capture box that calls the tracker", () => {
  const source = mainSource;
  assert(source.includes("factory-capture"), "a capture box is added");
  assert(
    source.includes("bases-kanban-card"),
    "the box is attached to the kanban board",
  );
  const start = source.indexOf("private async captureIdea(");
  assert(start > 0, "the plugin has a captureIdea method");
  const rest = source.slice(start + 1);
  const end = rest.indexOf("\n  private ");
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert(body.includes('"obsidian-board"'), "calls the board behavior");
  assert(body.includes('"capture"'), "calls the capture method");
  assert(!body.includes("vault."), "never writes the note itself");
  assert(
    /id: "capture-idea"/.test(source),
    "the command palette has the fallback",
  );
});

Deno.test("archive requests need a real outcome and a reason", () => {
  assertEquals([...ARCHIVE_OUTCOMES], ["done", "deleted", "duplicate"], "enum");
  assertEquals(archiveRequestProblem("done", "Shipped"), "", "ready");
  assert(
    archiveRequestProblem("cancelled", "Shipped").includes("outcome"),
    "unknown outcome refused",
  );
  assert(
    archiveRequestProblem("done", "   ").includes("why"),
    "empty reason refused",
  );
  const body = archiveRequestBody(
    " FAC-13 ",
    "duplicate",
    " Same as FAC-2 ",
    " ",
  );
  assertEquals(body.id, "FAC-13", "id trimmed");
  assertEquals(body.outcome, "duplicate", "outcome");
  assertEquals(body.reason, "Same as FAC-2", "reason trimmed");
  assertEquals(body.detail, "", "empty detail");
});

Deno.test("only cards on the active board can be archived", () => {
  assert(isArchivablePath("Factory/Cards/FAC-13 archive.md"), "board card");
  assert(!isArchivablePath("Factory/Archive/FAC-13 archive.md"), "archived");
  assert(!isArchivablePath("Factory/Board.md"), "board page");
  assert(isArchivablePath("Board/Cards/x.md", "Board"), "configured folder");
  assert(isArchivedPath("Factory/Archive/FAC-13 archive.md"), "archived card");
  assert(!isArchivedPath("Factory/Cards/FAC-13 archive.md"), "board card");
  assert(!isArchivedPath("Factory/Archive.base"), "archive base");
});
