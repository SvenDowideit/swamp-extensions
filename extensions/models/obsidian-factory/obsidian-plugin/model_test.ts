import {
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
