/**
 * Unit tests for the pure helpers in obsidian_factory.ts.
 */
import {
  addEnabledPlugin,
  appendActivity,
  appendBullet,
  applyManagedSections,
  cardDisplay,
  cardMatches,
  cardSummary,
  collapseDuplicateHeadings,
  composeNote,
  countBullets,
  hashText,
  incomingRelations,
  insertAfterTitle,
  managedEditProblem,
  movesForStatus,
  nextCommentId,
  nextId,
  parseActivity,
  parseCard,
  queueActionFor,
  removeBullet,
  renderDefinitionSection,
  renderPlanSection,
  renderSummarySection,
  sectionBullets,
  shouldReopenTerminal,
  slugify,
  splitFrontmatter,
  statusId,
  stripActivity,
  stripManaged,
  updatePlanCheckboxes,
  upsertManaged,
  validateRelation,
} from "./obsidian_factory.ts";
import type { Card } from "./obsidian_factory.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  actual   ${a}`);
}

function card(
  id: string,
  kind: "inbox" | "category" | "action",
  body = "",
  relations: Card["frontmatter"]["relations"] = [],
): Card {
  return {
    path: `Factory/Cards/${id}.md`,
    raw: "",
    body,
    frontmatter: {
      id,
      display: id.toUpperCase(),
      title: id,
      kind,
      status: "Proposed",
      relations,
    },
  };
}

Deno.test("splitFrontmatter reads YAML and leaves the body", () => {
  const raw = "---\nid: fac-1\ntitle: One\n---\n\n# One\n\nBody\n";
  const split = splitFrontmatter(raw);
  assertEquals(split.frontmatter.id, "fac-1", "id");
  assertEquals(split.frontmatter.title, "One", "title");
  assert(split.body.startsWith("# One"), "body");
});

Deno.test("splitFrontmatter keeps a note without frontmatter whole", () => {
  const split = splitFrontmatter("# Plain\n");
  assertEquals(split.frontmatter, {}, "no frontmatter");
  assertEquals(split.body, "# Plain\n", "whole body");
});

Deno.test("composeNote round-trips through splitFrontmatter", () => {
  const raw = composeNote({ id: "fac-1", tags: ["a", "b"] }, "# Card");
  const split = splitFrontmatter(raw);
  assertEquals(split.frontmatter.id, "fac-1", "id");
  assertEquals(split.frontmatter.tags, ["a", "b"], "tags");
  assertEquals(split.body.trim(), "# Card", "body");
});

Deno.test("parseCard ignores notes that are not cards", () => {
  assertEquals(parseCard("x.md", "---\ntitle: x\n---\n"), null, "no id");
  assertEquals(
    parseCard("x.md", "---\nid: fac-1\nkind: other\n---\n"),
    null,
    "unknown kind",
  );
  assert(
    parseCard("x.md", "---\nid: fac-1\nkind: action\n---\n") !== null,
    "card",
  );
});

Deno.test("slugify and statusId make stable ids", () => {
  assertEquals(slugify("Please Plan!"), "please-plan", "status id");
  assertEquals(statusId("User Acceptance"), "user-acceptance", "status id");
  assertEquals(slugify("!!!"), "card", "fallback");
});

Deno.test("nextId counts only this prefix", () => {
  assertEquals(nextId("fac", []), "fac-1", "empty");
  assertEquals(nextId("fac", ["fac-1", "fac-9", "cat-3"]), "fac-10", "next");
});

Deno.test("cardDisplay and cardMatches are case-insensitive", () => {
  const one = card("fac-1", "action");
  assertEquals(cardDisplay(one), "FAC-1", "display");
  assert(cardMatches(one, "fac-1"), "id");
  assert(cardMatches(one, "FAC-1"), "display");
  assert(!cardMatches(one, "fac-2"), "other");
});

Deno.test("sectionBullets and appendBullet keep ideas under the heading", () => {
  const body = "# Card\n\n## Ideas\n\n- one\n- two\n\n## Questions\n\n- why?\n";
  assertEquals(sectionBullets(body, "Ideas"), ["one", "two"], "ideas");
  assertEquals(sectionBullets(body, "Questions"), ["why?"], "questions");
  assertEquals(countBullets(body, ["Ideas"]), 2, "count");
  const next = appendBullet(body, "Ideas", "three");
  assertEquals(
    sectionBullets(next, "Ideas"),
    ["one", "two", "three"],
    "appended",
  );
  assertEquals(sectionBullets(next, "Questions"), ["why?"], "other section");
});

Deno.test("appendBullet stays inside Ideas before a managed marker", () => {
  const body = [
    "# Card",
    "",
    "## Ideas",
    "- one",
    "- two",
    "",
    "<!-- swamp:plan:begin -->",
    "## Plan",
    "",
    "**Status:** none",
    "<!-- swamp:plan:end -->",
    "",
  ].join("\n");
  const next = appendBullet(body, "Ideas", "three");
  const ideas = next.slice(
    next.indexOf("## Ideas"),
    next.indexOf("<!-- swamp:plan:begin"),
  );
  assertEquals(ideas.includes("- three"), true, "new bullet under Ideas");
  const plan = next.slice(next.indexOf("<!-- swamp:plan:begin"));
  assertEquals(plan.includes("- three"), false, "not after the plan marker");
});

Deno.test("appendBullet does not skip over prose", () => {
  const body = ["## Ideas", "- one", "", "Some prose.", "", "## Next", ""].join(
    "\n",
  );
  const next = appendBullet(body, "Ideas", "two");
  assertEquals(
    next,
    ["## Ideas", "- one", "- two", "", "Some prose.", "", "## Next", ""].join(
      "\n",
    ),
    "inserted after the last bullet",
  );
});

Deno.test("appendBullet creates a missing heading", () => {
  const next = appendBullet("# Card\n\nBody", "Ideas", "one");
  assertEquals(sectionBullets(next, "Ideas"), ["one"], "created");
});

Deno.test("removeBullet removes the first matching bullet", () => {
  const body = "## Ideas\n\n- alpha idea\n- beta idea\n";
  const result = removeBullet(body, "alpha");
  assertEquals(result.removed, "alpha idea", "removed");
  assertEquals(sectionBullets(result.body, "Ideas"), ["beta idea"], "left");
  assertEquals(removeBullet(body, "missing").removed, null, "missing");
});

Deno.test("removeBullet only removes from the named section", () => {
  const body = "## Ideas\n\n- alpha idea\n\n## Questions\n\n- alpha idea\n";
  const result = removeBullet(body, "alpha", "Questions");
  assertEquals(result.removed, "alpha idea", "removed from questions");
  assertEquals(
    sectionBullets(result.body, "Ideas"),
    ["alpha idea"],
    "ideas kept",
  );
  assertEquals(sectionBullets(result.body, "Questions"), [], "questions empty");
  assertEquals(
    removeBullet(body, "alpha", "Notes").removed,
    null,
    "missing heading",
  );
});

Deno.test("stripActivity preserves prose after the managed block", () => {
  const body = "# Card\n\n## Activity\n\n<!-- swamp:activity:begin -->\n\n" +
    '<!-- swamp:entry {"id":"c-1","kind":"comment","at":"2026-01-01T00:00:00.000Z"} -->\n' +
    "hello\n<!-- swamp:entry:end -->\n\n<!-- swamp:activity:end -->\n\nKeep this.\n";
  const stripped = stripActivity(body);
  assert(stripped.startsWith("# Card"), "kept header");
  assert(stripped.includes("Keep this."), "kept after-prose");
  assert(!stripped.includes("hello"), "removed activity");
});

Deno.test("activity entries append, parse and strip", () => {
  const body = "# Card\n\n## Activity\n";
  const one = appendActivity(body, {
    kind: "comment",
    id: "c-1",
    body: "first",
    at: "2026-01-01T00:00:00.000Z",
  });
  const two = appendActivity(one, {
    kind: "comment",
    id: "c-2",
    body: "second\nwith two lines",
    at: "2026-01-02T00:00:00.000Z",
  });
  const entries = parseActivity(two);
  assertEquals(entries.length, 2, "two entries");
  assertEquals(entries[1].id, "c-2", "id");
  assertEquals(entries[1].body, "second\nwith two lines", "body");
  assertEquals(nextCommentId(entries), "c-3", "next id");
  assertEquals(stripActivity(two).trim(), "# Card", "stripped");
});

Deno.test("activity entries keep lifecycle fields", () => {
  const body = "# Card\n";
  const one = appendActivity(body, {
    kind: "entry",
    id: "e-1",
    body: "📝 Plan: Add a cache",
    at: "2026-01-01T00:00:00.000Z",
    step: "planned",
    targetStatus: "Please Plan",
    summary: "Plan: Add a cache",
    emoji: "📝",
    payload: { summary: "Add a cache" },
    isVerbose: false,
  });
  const entries = parseActivity(one);
  assertEquals(entries[0].kind, "entry", "kind");
  assertEquals(entries[0].step, "planned", "step");
  assertEquals(entries[0].targetStatus, "Please Plan", "target status");
  assertEquals(entries[0].payload, { summary: "Add a cache" }, "payload");
});

Deno.test("shouldReopenTerminal reopens only for new input", () => {
  const inbox = card("inbox", "inbox", "## Thoughts\n\n- new thought\n");
  assert(shouldReopenTerminal(inbox, "Uncharacterised"), "inbox thought");
  const emptyInbox = card("inbox", "inbox", "## Thoughts\n");
  assert(!shouldReopenTerminal(emptyInbox, "Uncharacterised"), "empty inbox");
  const category = card("fac-2", "category", "## Ideas\n\n- a\n- b\n");
  category.frontmatter.lastProposedIdeaCount = 1;
  assert(shouldReopenTerminal(category, "Category"), "new category idea");
  category.frontmatter.lastProposedIdeaCount = 2;
  assert(!shouldReopenTerminal(category, "Category"), "no new idea");
  const action = card("fac-3", "action", "## Brief\n");
  assert(!shouldReopenTerminal(action, "Done"), "done action");
  assert(shouldReopenTerminal(action, "Proposed"), "reopened action");
  assert(
    !shouldReopenTerminal(action, "Please Plan"),
    "move to Proposed first",
  );
});

Deno.test("renderSummarySection puts the person's input first", () => {
  const section = renderSummarySection({
    stage: "Please Plan",
    planStatus: "draft",
    needsInput: ["Which repo owns the change?"],
    known: ["The board is a Bases Kanban"],
    unknown: ["Whether CSS hides live preview"],
    next: "Adversarial review",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert(section.includes("## At a glance"), "heading");
  assert(section.includes("Please Plan"), "stage");
  assert(section.includes("draft"), "plan status");
  assert(section.includes("**Needs your input**"), "input heading");
  assert(section.includes("Which repo owns the change?"), "input question");
  assert(section.includes("The board is a Bases Kanban"), "known");
  assert(section.includes("Whether CSS hides live preview"), "unknown");
  assert(section.includes("Adversarial review"), "next");
  assert(
    section.indexOf("**Needs your input**") < section.indexOf("**Known**"),
    "needs input before known",
  );
  assertEquals(
    section.split("Which repo owns the change?").length,
    2,
    "question is not repeated in Unknown",
  );
});

Deno.test("stripManaged removes every copy of a managed block", () => {
  const block = "<!-- swamp:plan:begin -->\nold\n<!-- swamp:plan:end -->";
  const body = `# Card\n\n${block}\n\nIntro\n\n${block}\n`;
  const stripped = stripManaged(
    body,
    "<!-- swamp:plan:begin -->",
    "<!-- swamp:plan:end -->",
  );
  assertEquals(stripped.includes("swamp:plan:begin"), false, "no blocks left");
  assertEquals(stripped.includes("Intro"), true, "keeps prose");
});

Deno.test("updatePlanCheckboxes ticks matching tasks and tests only", () => {
  const block = [
    "<!-- swamp:plan:begin -->",
    "## Plan",
    "### Tasks",
    "- [ ] Build the plugin",
    "- [ ] Update the docs",
    "### Tests",
    "- [ ] dialog prose",
    "- [ ] installer hash",
    "### Known / Unknown",
    "- [ ] not a task",
    "<!-- swamp:plan:end -->",
  ].join("\n");
  const updated = updatePlanCheckboxes(block, {
    tasks: [{ match: "Build the plugin", done: true }],
    tests: [{ match: "dialog prose", done: true }],
  });
  assert(updated.block.includes("- [x] Build the plugin"), "task ticked");
  assert(
    updated.block.includes("- [ ] Update the docs"),
    "other task untouched",
  );
  assert(updated.block.includes("- [x] dialog prose"), "test ticked");
  assert(
    updated.block.includes("- [ ] installer hash"),
    "other test untouched",
  );
  assert(
    updated.block.includes("- [ ] not a task"),
    "outside sections untouched",
  );
  assertEquals(updated.changed, 2, "two changes");
  const again = updatePlanCheckboxes(updated.block, {
    tasks: [{ match: "Build the plugin", done: true }],
  });
  assertEquals(again.changed, 0, "idempotent");
  const missed = updatePlanCheckboxes(block, {
    tasks: [{ match: "missing", done: true }],
  });
  assertEquals(missed.unmatched, ["missing"], "unmatched reported");
});

Deno.test("addEnabledPlugin adds the id once and keeps valid JSON", () => {
  const first = addEnabledPlugin('["a"]', "obsidian-factory");
  assertEquals(first.changed, true, "first add changes");
  const list = JSON.parse(first.json) as string[];
  assert(
    list.includes("a") && list.includes("obsidian-factory"),
    "contains both",
  );
  const second = addEnabledPlugin(first.json, "obsidian-factory");
  assertEquals(second.changed, false, "second add is a no-op");
  let failed = false;
  try {
    addEnabledPlugin("not json", "obsidian-factory");
  } catch {
    failed = true;
  }
  assert(failed, "invalid JSON is refused");
});

Deno.test("movesForStatus lists the documented normal moves", () => {
  assertEquals(movesForStatus("Proposed"), ["Please Plan"], "proposed");
  assertEquals(movesForStatus("Work Planned"), [
    "Please Plan",
    "Please Implement",
  ], "work planned");
  assertEquals(
    movesForStatus("Please Implement"),
    ["Please Test"],
    "implement",
  );
  assertEquals(
    movesForStatus("User Acceptance"),
    ["Please Plan", "Please Implement", "Please Test", "Please Release"],
    "acceptance",
  );
  assertEquals(
    movesForStatus("Please Release"),
    ["User Acceptance", "Done"],
    "release",
  );
  assertEquals(movesForStatus("Done"), [], "done");
  assertEquals(movesForStatus("Uncharacterised"), [], "inbox");
});

Deno.test("queueActionFor follows the card column, not the work item stage", () => {
  assertEquals(
    queueActionFor("Work Planned", true, false, true),
    "wait",
    "work planned waits",
  );
  assertEquals(
    queueActionFor("Proposed", true, false, true),
    "wait",
    "proposed waits",
  );
  assertEquals(
    queueActionFor("User Acceptance", true, false, true),
    "wait",
    "acceptance waits",
  );
  assertEquals(
    queueActionFor("Please Implement", true, false, true),
    "work",
    "implement works even if the ledger is elsewhere",
  );
  assertEquals(
    queueActionFor("Please Plan", true, false, true),
    "work",
    "plan works even if the ledger is elsewhere",
  );
  assertEquals(
    queueActionFor("Please Test", true, false, true),
    "work",
    "test works",
  );
  assertEquals(
    queueActionFor("Please Release", true, false, true),
    "work",
    "release works",
  );
  assertEquals(
    queueActionFor("Please Implement", false, false, true),
    "claim",
    "no ledger yet",
  );
  assertEquals(
    queueActionFor("Please Implement", true, true, true),
    "claim",
    "terminal ledger reopens",
  );
  assertEquals(queueActionFor("Done", true, true, true), "done", "done");
  assertEquals(
    queueActionFor("Uncharacterised", true, true, false),
    "wait",
    "empty inbox waits",
  );
  assertEquals(
    queueActionFor("Uncharacterised", true, true, true),
    "claim",
    "new thought reopens",
  );
  assertEquals(
    queueActionFor("Category", true, true, false),
    "wait",
    "no new idea waits",
  );
  assertEquals(
    queueActionFor("Category", true, true, true),
    "claim",
    "new idea reopens",
  );
});

Deno.test("managedEditProblem detects a person's edit", async () => {
  const text =
    "<!-- swamp:summary:begin -->\n## At a glance\nold\n<!-- swamp:summary:end -->";
  const hash = await hashText(text);
  assertEquals(await managedEditProblem(text, hash), null, "unchanged");
  assertEquals(await managedEditProblem(text, "wrong"), text, "edited");
  assertEquals(await managedEditProblem(null, undefined), null, "missing");
  assertEquals(
    await managedEditProblem(text, undefined),
    text,
    "first write is reviewed",
  );
});

Deno.test("collapseDuplicateHeadings removes an empty repeated heading", () => {
  const body = ["# Card", "", "## Questions", "", "## Questions", "", "- q"]
    .join("\n");
  const next = collapseDuplicateHeadings(body);
  assertEquals(next.split("## Questions").length, 2, "one Questions heading");
  assertEquals(next.includes("- q"), true, "keeps the content");
});

Deno.test("insertAfterTitle puts a block at the top of the page", () => {
  const body = "# Card\n\nIntro paragraph.\n\n## Brief\n";
  const next = insertAfterTitle(body, "<!-- block -->");
  assert(
    next.indexOf("<!-- block -->") < next.indexOf("Intro paragraph."),
    "top",
  );
  assert(
    next.indexOf("# Card") < next.indexOf("<!-- block -->"),
    "after title",
  );
  assertEquals(next.includes("Intro paragraph."), true, "keeps body");
});

Deno.test("applyManagedSections keeps feedback above the plan and metadata", () => {
  const summary =
    "<!-- swamp:summary:begin -->\n## At a glance\nK\n<!-- swamp:summary:end -->";
  const plan = "<!-- swamp:plan:begin -->\n## Plan\nP\n<!-- swamp:plan:end -->";
  const activity =
    "<!-- swamp:activity:begin -->\nA\n<!-- swamp:activity:end -->";
  const definition =
    "<!-- swamp:definition:begin -->\n## Definition\nD\n<!-- swamp:definition:end -->";
  const edited = applyManagedSections(
    "# New body\n\nIntro.\n\n## Brief\n\n## Questions\n\n## Feedback\n",
    { summary, plan, definition, activity },
  );
  assert(edited.includes("# New body"), "new body");
  assert(edited.includes("## At a glance"), "summary");
  assert(edited.includes("## Plan"), "plan");
  assert(
    edited.includes("## Activity") || edited.includes(activity),
    "activity",
  );
  assert(
    edited.indexOf("## At a glance") < edited.indexOf("Intro."),
    "summary above intro",
  );
  assert(
    edited.indexOf("## Feedback") < edited.indexOf("## Plan"),
    "feedback above plan",
  );
  assert(
    edited.indexOf("## Plan") < edited.indexOf("## Definition"),
    "plan above definition",
  );
  assert(
    edited.indexOf("## Definition") <
      edited.indexOf("<!-- swamp:activity:begin -->"),
    "definition above activity",
  );
});

Deno.test("renderDefinitionSection is readable", () => {
  const section = renderDefinitionSection({
    status: "pinned",
    note: "Pinned to the definition it started with.",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert(section.includes("## Definition"), "heading");
  assert(section.includes("pinned"), "status");
  assert(section.includes("Pinned to the definition it started with."), "note");
});

Deno.test("renderPlanSection has tasks, tests and known/unknown", () => {
  const section = renderPlanSection({
    status: "final",
    summary: "Add a card summary",
    tasks: [{ description: "Render the summary", files: ["a.ts"] }],
    tests: [{ name: "renders known", kind: "completeness", covers: "summary" }],
    existing: ["Card body"],
    added: ["At a glance"],
    removed: ["None"],
    known: ["The tracker owns the body"],
    unknown: ["Whether CSS hides live preview"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert(section.includes("## Plan"), "heading");
  assert(section.includes("- [ ] Render the summary (a.ts)"), "task");
  assert(section.includes("**completeness**: renders known"), "test");
  assert(section.includes("### Existing functionality changing"), "existing");
  assert(section.includes("### Functionality added"), "added");
  assert(section.includes("### Functionality removed"), "removed");
  assert(section.includes("Whether CSS hides live preview"), "unknown");
});

Deno.test("upsertManaged inserts and replaces a managed block", () => {
  const body = "# Card\n\n## Brief\n\n## Questions\n";
  const first = upsertManaged(
    body,
    "<!-- s:begin -->",
    "<!-- s:end -->",
    "<!-- s:begin -->\n## Summary\nold\n<!-- s:end -->",
    ["Brief", "Questions"],
  );
  assert(first.indexOf("## Summary") < first.indexOf("## Brief"), "inserted");
  const second = upsertManaged(
    first,
    "<!-- s:begin -->",
    "<!-- s:end -->",
    "<!-- s:begin -->\n## Summary\nnew\n<!-- s:end -->",
    ["Brief", "Questions"],
  );
  assert(second.includes("new"), "replaced");
  assert(!second.includes("old"), "old removed");
  assertEquals(second.split("## Summary").length, 2, "one summary");
});

Deno.test("applyManagedSections preserves summary, plan and activity", () => {
  const summary =
    "<!-- swamp:summary:begin -->\n## At a glance\nK\n<!-- swamp:summary:end -->";
  const plan = "<!-- swamp:plan:begin -->\n## Plan\nP\n<!-- swamp:plan:end -->";
  const activity =
    "<!-- swamp:activity:begin -->\nA\n<!-- swamp:activity:end -->";
  const definition =
    "<!-- swamp:definition:begin -->\n## Definition\nD\n<!-- swamp:definition:end -->";
  const edited = applyManagedSections("# New body\n\n## Questions\n", {
    summary,
    plan,
    definition,
    activity,
  });
  assert(edited.includes("# New body"), "new body");
  assert(edited.includes("## At a glance"), "summary");
  assert(edited.includes("## Plan"), "plan");
  assert(
    edited.includes("## Activity") || edited.includes(activity),
    "activity",
  );
});

Deno.test("cardSummary counts ideas by kind", () => {
  const summary = cardSummary(
    card("fac-1", "category", "## Ideas\n\n- a\n- b\n\n## Questions\n\n- q\n"),
  );
  assertEquals(summary.ideaCount, 2, "ideas");
  assertEquals(summary.openQuestions, 1, "questions");
  assertEquals(summary.display, "FAC-1", "display");
});

Deno.test("incomingRelations finds relations from other cards", () => {
  const parent = card("fac-1", "action");
  const child = card("fac-2", "action", "", [{
    type: "parent_of",
    issue: "fac-1",
  }]);
  const incoming = incomingRelations([parent, child], "fac-1");
  assertEquals(incoming.length, 1, "one incoming");
  assertEquals(incoming[0].issue, "fac-2", "from child");
});

Deno.test("validateRelation refuses self, duplicate parent and cycles", () => {
  const one = card("fac-1", "action");
  const three = card("fac-3", "action");
  assertEquals(
    validateRelation([one], "fac-1", "related_to", "fac-1"),
    "a ticket cannot be related to itself",
    "self",
  );
  const parented = card("fac-2", "action", "", [
    { type: "parent_of", issue: "fac-1" },
  ]);
  assertEquals(
    validateRelation([one, parented, three], "fac-3", "parent_of", "fac-1"),
    "that ticket already has a parent",
    "one parent",
  );
  // fac-1 parent_of fac-2; adding fac-2 parent_of fac-1 would loop.
  const child = card("fac-2", "action", "", [
    { type: "parent_of", issue: "fac-1" },
  ]);
  const loop = validateRelation([one, child], "fac-1", "parent_of", "fac-2");
  assert(loop !== null, "cycle refused");
  // fac-2 is a duplicate of fac-1, so fac-1 already has duplicates.
  const duplicate = card("fac-2", "action", "", [
    { type: "duplicate_of", issue: "fac-1" },
  ]);
  const clean = card("fac-3", "action");
  assertEquals(
    validateRelation([one, duplicate, clean], "fac-1", "duplicate_of", "fac-3"),
    "a ticket with duplicates cannot become one",
    "duplicate with duplicates",
  );
});
