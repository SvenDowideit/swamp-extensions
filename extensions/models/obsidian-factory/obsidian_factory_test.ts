/**
 * Unit tests for the pure helpers in obsidian_factory.ts.
 */
import archiveBase from "./assets/archive.base.yaml" with { type: "text" };
import boardBase from "./assets/board.base.yaml" with { type: "text" };
import {
  addEnabledPlugin,
  appendActivity,
  appendBullet,
  applyManagedSections,
  ARCHIVE_OUTCOMES,
  archiveCard,
  archivedFrontmatter,
  archiveFolder,
  archivePathFor,
  buildTickPrompt,
  cardDisplay,
  cardMatches,
  cardSummary,
  collapseDuplicateHeadings,
  composeNote,
  countBullets,
  createCard,
  DEFAULT_STAGE_COLUMNS,
  DEFAULT_STATUS_FOR_KIND,
  DEFAULT_STATUSES,
  hashText,
  incomingRelations,
  insertAfterTitle,
  managedEditProblem,
  mergePluginSettings,
  migrateCardPaths,
  movesForStatus,
  nextCommentId,
  nextId,
  notesMatch,
  parseActivity,
  parseCard,
  queueActionFor,
  removeBullet,
  renderDefinitionSection,
  renderPlanSection,
  renderSummarySection,
  restoredStatus,
  rewriteActivityDisplay,
  sectionBullets,
  shouldReopenTerminal,
  slugify,
  splitFrontmatter,
  statusId,
  stripActivity,
  stripManaged,
  titleOnlyPath,
  unarchiveCard,
  unarchivedFrontmatter,
  updatePlanCheckboxes,
  upsertManaged,
  validateRelation,
} from "./obsidian_factory.ts";
import type {
  ArchiveOutcome,
  Card,
  FactoryContext,
} from "./obsidian_factory.ts";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.0";

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
  title = `Card ${id}`,
): Card {
  return {
    path: `Factory/Cards/${slugify(title)}.md`,
    raw: "",
    body,
    frontmatter: {
      id,
      title,
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

Deno.test("cardDisplay shows the human title and cardMatches stays stable", () => {
  const one = card("fac-1", "action", "", [], "One card");
  assertEquals(cardDisplay(one), "One card", "display is the title");
  const untitled = card("fac-2", "action", "", [], "  ");
  assertEquals(cardDisplay(untitled), "fac-2", "a titleless card falls back");
  assert(cardMatches(one, "fac-1"), "id");
  assert(cardMatches(one, "one card"), "display");
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

Deno.test("mergePluginSettings sets an empty repoPath and keeps settings", () => {
  const fresh = mergePluginSettings(null, "/repo");
  assertEquals(fresh.changed, true, "fresh changes");
  const freshData = JSON.parse(fresh.json) as Record<string, unknown>;
  assertEquals(freshData.repoPath, "/repo", "repo path");
  assertEquals(freshData.agent, "pi", "agent default");

  const existing = JSON.stringify({
    repoPath: "/keep",
    agent: "kilo",
    swampBinary: "swamp",
    model: "",
    archiveWebhookUrl: "",
    archiveWebhookToken: "",
  });
  const kept = mergePluginSettings(existing, "/repo");
  assertEquals(kept.changed, false, "keeps a set repo path");
  assertEquals(JSON.parse(kept.json).agent, "kilo", "keeps existing agent");

  const empty = JSON.stringify({ repoPath: "", agent: "kilo" });
  const filled = mergePluginSettings(empty, "/repo");
  assertEquals(filled.changed, true, "fills empty repo path");
  assertEquals(JSON.parse(filled.json).repoPath, "/repo", "filled repo path");
  assertEquals(JSON.parse(filled.json).agent, "kilo", "keeps agent");

  let failed = false;
  try {
    mergePluginSettings("not json", "/repo");
  } catch {
    failed = true;
  }
  assert(failed, "invalid JSON is refused");
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
  assertEquals(summary.display, "Card fac-1", "display is the human title");
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

Deno.test("buildTickPrompt makes the agent act only on work cards", () => {
  const cards = [
    {
      id: "fac-12",
      display: "fac-12 Inventory",
      title: "Inventory ESPHome devices",
      kind: "action" as const,
      column: "Please Plan",
      path: "Factory/Cards/fac-12.md",
      project: "",
      key: "fac-12",
      stage: "plan",
      cycle: 1,
      era: "e",
      terminal: false,
      moves: ["Work Planned"],
      action: "work" as const,
    },
    {
      id: "fac-5",
      display: "fac-5 Tick",
      title: "Tick webhook",
      kind: "action" as const,
      column: "User Acceptance",
      path: "Factory/Cards/fac-5.md",
      project: "",
      key: "fac-5",
      stage: "acceptance",
      cycle: 1,
      era: "e",
      terminal: false,
      moves: [],
      action: "wait" as const,
    },
  ];
  const { prompt, systemPrompt } = buildTickPrompt("/repo", cards, {
    claim: 0,
    work: 1,
    reconcile: 0,
    done: 0,
    wait: 1,
  });
  assert(prompt.includes("fac-12"), "work card is named");
  assert(prompt.includes("Cards you must act on now"), "work section");
  assert(prompt.includes("Do NOT read context.md"), "context file refused");
  assert(prompt.includes("Do NOT use /testbed"), "testbed refused");
  assert(
    prompt.includes(".agents/skills/obsidian-factory/SKILL.md"),
    "skill first",
  );
  assert(systemPrompt.includes("only truth"), "system prompt states the truth");
  assert(
    !prompt.includes("fac-5 [User Acceptance] action=wait\n"),
    "wait not in work list",
  );
});

Deno.test("buildTickPrompt explains an all-waiting board", () => {
  const { prompt } = buildTickPrompt("/repo", [{
    id: "fac-1",
    display: "fac-1",
    title: "Waiting",
    kind: "action" as const,
    column: "Proposed",
    path: "Factory/Cards/fac-1.md",
    project: "",
    key: "fac-1",
    stage: "",
    cycle: 0,
    era: "",
    terminal: false,
    moves: [],
    action: "wait" as const,
  }], { claim: 0, work: 0, reconcile: 0, done: 0, wait: 1 });
  assert(prompt.includes("every card is waiting"), "all-waiting note");
});

// ---------------------------------------------------------------------------
// Archive: a fake vault, so the whole lifecycle is exercised, not just helpers
// ---------------------------------------------------------------------------

interface FakeDataRecord {
  name: string;
  version: number;
  attributes: Record<string, unknown>;
}

/** A tiny in-memory @magistr/obsidian/vault, enough for the archive methods. */
class FakeVault {
  notes = new Map<string, string>();
  trashFailures = new Set<string>();
  corruptWrites = false;
  /** When set, `move` fails the way a missing Obsidian CLI does. */
  moveFailure: string | null = null;
  /** When true, `move` reports success but leaves the note where it was. */
  moveSilentlyDoesNothing = false;
  readonly context: FactoryContext;
  private records = new Map<string, FakeDataRecord[]>();
  private counter = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.notes.set(path, content);
    }
    const runModel = (
      options: {
        definition: string;
        method: string;
        arguments?: Record<string, unknown>;
      },
    ): Promise<{
      ok: boolean;
      resources?: Array<{ name?: string }>;
      error?: { message?: string };
    }> => {
      const args = options.arguments ?? {};
      const file = String(args.file ?? args.name ?? "");
      const answer = (value: {
        ok: boolean;
        resources?: Array<{ name?: string }>;
        error?: { message?: string };
      }) => Promise.resolve(value);
      switch (options.method) {
        case "read": {
          const content = this.notes.get(file);
          if (content === undefined) {
            return answer({
              ok: false,
              error: { message: `note not found: ${file}` },
            });
          }
          return answer({
            ok: true,
            resources: [{ name: this.store("note", { content, file }) }],
          });
        }
        case "create": {
          const content = String(args.content ?? "");
          const written = this.corruptWrites
            ? content.slice(0, Math.max(0, content.length - 40))
            : content;
          this.notes.set(file, written);
          return answer({
            ok: true,
            resources: [{
              name: this.store("note", { content: written, file }),
            }],
          });
        }
        case "delete": {
          if (this.trashFailures.has(file)) {
            return answer({
              ok: false,
              error: { message: `cannot trash ${file}` },
            });
          }
          this.notes.delete(file);
          return answer({
            ok: true,
            resources: [{ name: this.store("deleted", { file }) }],
          });
        }
        case "move": {
          const to = String(args.to ?? "");
          if (this.moveFailure !== null) {
            return answer({ ok: false, error: { message: this.moveFailure } });
          }
          const content = this.notes.get(file);
          if (content === undefined) {
            return answer({
              ok: false,
              error: { message: `note not found: ${file}` },
            });
          }
          if (this.moveSilentlyDoesNothing) {
            return answer({
              ok: true,
              resources: [{
                name: this.store("operationResult", { file, to }),
              }],
            });
          }
          const oldName = file.slice(file.lastIndexOf("/") + 1).replace(
            /\.md$/,
            "",
          );
          const newName = to.slice(to.lastIndexOf("/") + 1).replace(
            /\.md$/,
            "",
          );
          this.notes.delete(file);
          this.notes.set(to, content);
          if (oldName !== newName) {
            for (const [path, note] of this.notes) {
              this.notes.set(
                path,
                note
                  .replaceAll(`[[${oldName}]]`, `[[${newName}]]`)
                  .replaceAll(`[[${oldName}|`, `[[${newName}|`),
              );
            }
          }
          return answer({
            ok: true,
            resources: [{
              name: this.store("operationResult", { file, to }),
            }],
          });
        }
        case "list": {
          const folder = String(args.folder ?? "").replace(/\/+$/, "");
          const files = [...this.notes.keys()].filter((path) =>
            path === folder || path.startsWith(`${folder}/`)
          );
          return answer({
            ok: true,
            resources: [{ name: this.store("notes", { files }) }],
          });
        }
        default:
          return answer({
            ok: false,
            error: { message: `unknown method ${options.method}` },
          });
      }
    };
    const globalArgs = {
      vaultModel: "obsidian-vault",
      folder: "Factory",
      prefix: "fac",
      trackerName: "obsidian",
      types: ["inbox", "category", "action"],
      statuses: [...DEFAULT_STATUSES],
      statusForKind: { ...DEFAULT_STATUS_FOR_KIND },
      stageColumns: { ...DEFAULT_STAGE_COLUMNS },
      factory: "obsidian-idea-factory",
      allowDotObsidian: false,
    } as FactoryContext["globalArgs"];
    this.context = {
      globalArgs,
      logger: { info: () => {} },
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        this.store(specName, data);
        return Promise.resolve({ name });
      },
      readModelData: (modelName: string, specName?: string) =>
        Promise.resolve(
          this.records.get(`${modelName}:${specName ?? ""}`) ?? [],
        ),
      runModel,
    };
  }

  private store(specName: string, attributes: Record<string, unknown>): string {
    const name = `${specName}-${++this.counter}`;
    const key = `obsidian-vault:${specName}`;
    const list = this.records.get(key) ?? [];
    list.push({ name, version: 1, attributes });
    this.records.set(key, list);
    return name;
  }
}

const CARD_PATH = "Factory/Cards/FAC-2 board-automation.md";
const ARCHIVE_PATH = "Factory/Archive/FAC-2 board-automation.md";

function sampleCardBody(): string {
  return [
    "# Board automation",
    "",
    "<!-- swamp:summary:begin -->",
    "## At a glance",
    "",
    "**Stage:** Please Test · **Plan:** final",
    "",
    "**Needs your input**",
    "",
    "- Read the plan and move the card on.",
    "<!-- swamp:summary:end -->",
    "",
    "Make the board tick itself.",
    "",
    "## Brief",
    "",
    "Tick the board when a card moves.",
    "",
    "## Feedback",
    "",
    "## Plan",
    "",
    "<!-- swamp:plan:begin -->",
    "### Tasks",
    "",
    "- [x] Write the tick webhook",
    "<!-- swamp:plan:end -->",
    "",
    "## Activity",
    "",
    "<!-- swamp:activity:begin -->",
    '<!-- swamp:entry {"id":"e-1","kind":"entry","at":"2026-11-01T00:00:00.000Z"} -->',
    "🔧 Planned the webhook.",
    "<!-- swamp:entry:end -->",
    "<!-- swamp:activity:end -->",
  ].join("\n");
}

function sampleCardNote(
  status = "Please Test",
  body = sampleCardBody(),
): string {
  return composeNote({
    id: "fac-2",
    title: "Board automation",
    kind: "action",
    type: "action",
    status,
    created: "2026-11-01T00:00:00.000Z",
    updated: "2026-11-01T00:00:00.000Z",
    relations: [],
    description: "Make the board tick itself.",
    cssclasses: ["factory-card"],
  }, body);
}

function headings(body: string, level: number): string[] {
  const pattern = new RegExp(`^#{${level}}\\s+`, "gm");
  return body.match(pattern) ?? [];
}

Deno.test("archive and unarchive round-trip preserves the card", async () => {
  const vault = new FakeVault({ [CARD_PATH]: sampleCardNote() });
  const archived = await archiveCard(vault.context, {
    id: "fac-2",
    outcome: "done",
    reason: "The tick webhook shipped",
    detail: "Released with the plugin",
  });
  assertEquals(archived.changed, true, "archived");
  assertEquals(archived.path, ARCHIVE_PATH, "archive path");
  assertEquals(vault.notes.has(CARD_PATH), false, "original left the board");
  const copy = vault.notes.get(ARCHIVE_PATH) ?? "";
  assert(copy.includes("Tick the board when a card moves."), "brief kept");
  assert(copy.includes("Write the tick webhook"), "plan kept");
  assert(copy.includes("Planned the webhook."), "activity kept");
  assert(copy.includes("Archived as **done**"), "archive entry added");

  const restored = await unarchiveCard(vault.context, { id: "fac-2" });
  assertEquals(restored.changed, true, "restored");
  assertEquals(restored.previousStatus, "Please Test", "column restored");
  assertEquals(vault.notes.has(ARCHIVE_PATH), false, "archive copy moved back");
  const back = vault.notes.get(CARD_PATH) ?? "";
  const split = splitFrontmatter(back);
  assertEquals(split.frontmatter.status, "Please Test", "status back");
  assertEquals(split.frontmatter.archiveStatus, undefined, "outcome cleared");
  assertEquals(split.frontmatter.archivedAt, undefined, "date cleared");
  assert(
    back.includes("Tick the board when a card moves."),
    "brief still here",
  );
  assert(back.includes("Restored to **Please Test**"), "unarchive entry added");
});

Deno.test("an archived card keeps At a glance and one title", async () => {
  const vault = new FakeVault({ [CARD_PATH]: sampleCardNote() });
  await archiveCard(vault.context, {
    id: "fac-2",
    outcome: "done",
    reason: "Finished",
  });
  const copy = vault.notes.get(ARCHIVE_PATH) ?? "";
  assert(copy.includes("## At a glance"), "At a glance kept");
  assert(copy.includes("Needs your input"), "Needs your input kept");
  assertEquals(headings(copy, 1).length, 1, "one human title");
});

Deno.test("a content mismatch removes the copy and keeps the original", async () => {
  const vault = new FakeVault({ [CARD_PATH]: sampleCardNote() });
  vault.corruptWrites = true;
  let message = "";
  try {
    await archiveCard(vault.context, {
      id: "fac-2",
      outcome: "done",
      reason: "Finished",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes("did not read back unchanged"),
    `refused: ${message}`,
  );
  assert(vault.notes.has(CARD_PATH), "original kept");
  assertEquals(vault.notes.has(ARCHIVE_PATH), false, "copy removed");
});

Deno.test("a trash failure leaves both copies and reports it", async () => {
  const vault = new FakeVault({ [CARD_PATH]: sampleCardNote() });
  vault.trashFailures.add(CARD_PATH);
  let message = "";
  try {
    await archiveCard(vault.context, {
      id: "fac-2",
      outcome: "done",
      reason: "Finished",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes(ARCHIVE_PATH), "archive path named");
  assert(message.includes(CARD_PATH), "original path named");
  assert(vault.notes.has(CARD_PATH), "original kept");
  assert(vault.notes.has(ARCHIVE_PATH), "copy kept");
});

Deno.test("the inbox is refused", async () => {
  const inboxPath = "Factory/Cards/INBOX Uncharacterised.md";
  const vault = new FakeVault({
    [inboxPath]: composeNote({
      id: "inbox",
      title: "Uncharacterised",
      kind: "inbox",
      status: "Uncharacterised",
    }, "# Uncharacterised\n\n## Thoughts\n\n- an idea\n"),
  });
  let message = "";
  try {
    await archiveCard(vault.context, {
      id: "inbox",
      outcome: "deleted",
      reason: "Not wanted",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("inbox"), `refused: ${message}`);
  assert(vault.notes.has(inboxPath), "inbox kept");
  assertEquals([...vault.notes.keys()].length, 1, "nothing copied");
});

Deno.test("unarchive restores previousStatus or Proposed", async () => {
  const statuses = [...DEFAULT_STATUSES];
  assertEquals(
    restoredStatus({ previousStatus: "User Acceptance" }, statuses),
    "User Acceptance",
    "previous column",
  );
  assertEquals(
    restoredStatus({ previousStatus: "Retired" }, statuses),
    "Proposed",
    "unknown column",
  );
  assertEquals(restoredStatus({}, statuses), "Proposed", "no previous column");

  const legacy = "Factory/Archive/FAC-9 voice-input.md";
  const vault = new FakeVault({
    [legacy]: composeNote({
      id: "fac-9",
      title: "Voice input",
      kind: "category",
      status: "Category",
      archiveStatus: "deleted",
      archiveReason: "Duplicate of FAC-3",
    }, "# Voice input\n\n## Ideas\n\n- dictate cards\n"),
  });
  const result = await unarchiveCard(vault.context, { id: "fac-9" });
  assertEquals(result.previousStatus, "Proposed", "fallback column");
  const back = splitFrontmatter(
    vault.notes.get(legacy.replace("/Archive/", "/Cards/")) ?? "",
  );
  assertEquals(back.frontmatter.status, "Proposed", "status written");
  assertEquals(back.frontmatter.archiveReason, undefined, "reason cleared");
});

Deno.test("unarchive never overwrites a card already on the board", async () => {
  const vault = new FakeVault({
    [CARD_PATH]: sampleCardNote(),
    [ARCHIVE_PATH]: composeNote({
      id: "fac-2",
      title: "Board automation",
      kind: "action",
      status: "Done",
      archiveStatus: "done",
      archiveReason: "old",
      previousStatus: "Done",
    }, "# Board automation\n"),
  });
  let message = "";
  try {
    await unarchiveCard(vault.context, { id: "fac-2" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("already exists"), `refused: ${message}`);
  assert(vault.notes.has(ARCHIVE_PATH), "archive copy kept");
});

Deno.test("the outcome enum is done, deleted or duplicate plus optional detail", async () => {
  assertEquals([...ARCHIVE_OUTCOMES], ["done", "deleted", "duplicate"], "enum");
  assertEquals(archiveFolder("Factory/"), "Factory/Archive", "archive folder");
  assertEquals(
    archivePathFor("Factory", CARD_PATH),
    ARCHIVE_PATH,
    "archive path keeps the file name",
  );
  assert(notesMatch("a\n", "a\n"), "same note");
  assert(notesMatch("a\n", "a"), "trailing newline ignored");
  assert(!notesMatch("a\n", "b\n"), "different note");
  assert(!notesMatch("a\n", null), "missing note");
  const cleared = unarchivedFrontmatter(
    {
      status: "Done",
      archiveStatus: "done",
      archiveReason: "shipped",
      archivedAt: "2026-11-08T00:00:00.000Z",
      previousStatus: "User Acceptance",
    },
    [...DEFAULT_STATUSES],
    "2026-11-09T00:00:00.000Z",
  );
  assertEquals(cleared.status, "User Acceptance", "cleared status");
  assertEquals(cleared.archiveStatus, undefined, "cleared outcome");
  assertEquals(cleared.archiveReason, undefined, "cleared reason");
  assertEquals(cleared.updated, "2026-11-09T00:00:00.000Z", "updated");
  const withDetail = archivedFrontmatter({ status: "Done" }, {
    outcome: "done",
    reason: "Shipped",
    detail: "In 2026.11",
    archivedAt: "2026-11-08T00:00:00.000Z",
  });
  assertEquals(withDetail.archiveDetail, "In 2026.11", "detail kept");
  assertEquals(withDetail.previousStatus, "Done", "previous column kept");
  const withoutDetail = archivedFrontmatter({ status: "Done" }, {
    outcome: "duplicate",
    reason: "Same as FAC-3",
    archivedAt: "2026-11-08T00:00:00.000Z",
  });
  assert(!("archiveDetail" in withoutDetail), "detail omitted");

  const vault = new FakeVault({ [CARD_PATH]: sampleCardNote() });
  let message = "";
  try {
    await archiveCard(vault.context, {
      id: "fac-2",
      outcome: "cancelled" as unknown as ArchiveOutcome,
      reason: "Not on the list",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("no archive outcome"), `refused: ${message}`);
  assert(vault.notes.has(CARD_PATH), "card kept");
});

Deno.test("Archive.base shows only archived cards grouped by outcome", () => {
  const archive = parseYaml(archiveBase) as {
    filters: { and: unknown[] };
    properties: Record<string, unknown>;
    views: Array<{
      name: string;
      groupBy?: { property: string };
      filters?: { and: string[] };
    }>;
  };
  const filters = JSON.stringify(archive.filters);
  assert(filters.includes("/Archive"), "Archive folder only");
  const main = archive.views[0];
  assertEquals(
    main.groupBy?.property,
    "note.archiveStatus",
    "grouped by outcome",
  );
  for (
    const field of [
      "note.title",
      "note.archiveStatus",
      "note.archiveReason",
      "note.archiveDetail",
      "note.archivedAt",
      "note.previousStatus",
    ]
  ) {
    assert(field in archive.properties, `property ${field}`);
  }
  const perOutcome = archive.views.slice(1).map((view) => view.name);
  assertEquals(perOutcome, ["Done", "Deleted", "Duplicate"], "one view each");
  for (const view of archive.views.slice(1)) {
    const outcome = view.name.toLowerCase();
    assertEquals(
      view.filters?.and,
      [`archiveStatus == "${outcome}"`],
      view.name,
    );
  }

  const board = parseYaml(boardBase) as {
    filters: { and: unknown[] };
  };
  const boardFilters = JSON.stringify(board.filters);
  assert(boardFilters.includes("/Cards"), "board filters Cards");
  assert(!boardFilters.includes("Archive"), "board excludes the archive");
});

// ---------------------------------------------------------------------------
// One human-readable title: title-only filenames, no codename property
// ---------------------------------------------------------------------------

Deno.test("titleOnlyPath slugs the title and suffixes a collision", () => {
  assertEquals(
    titleOnlyPath("Factory/Cards", "Board automation", []),
    "Factory/Cards/board-automation.md",
    "title only",
  );
  assertEquals(
    titleOnlyPath("Factory/Cards", "Board automation", [
      "Factory/Cards/board-automation.md",
    ]),
    "Factory/Cards/board-automation-2.md",
    "collision",
  );
  assertEquals(
    titleOnlyPath("Factory/Cards", "Board automation", [
      "Factory/Cards/board-automation.md",
      "Factory/Cards/board-automation-2.md",
    ]),
    "Factory/Cards/board-automation-3.md",
    "next collision",
  );
  assert(
    !titleOnlyPath("Factory/Cards", "Board automation", []).includes("fac"),
    "no codename in the filename",
  );
});

Deno.test("a new card gets a title-only filename and no display property", async () => {
  const vault = new FakeVault();
  const created = await createCard(
    vault.context,
    "action",
    "Board automation",
    "Tick the board.",
  );
  assertEquals(created.path, "Factory/Cards/board-automation.md", "path");
  assertEquals(created.frontmatter.id, "fac-1", "the id is still assigned");
  assert(!("display" in created.frontmatter), "no display property");
  const note = vault.notes.get("Factory/Cards/board-automation.md") ?? "";
  assert(note.includes("id: fac-1"), "the id stays in the frontmatter");
  assert(!/^display:/m.test(note), "the note carries no display property");
});

Deno.test("two cards with the same title get distinct filenames", async () => {
  const vault = new FakeVault();
  const one = await createCard(
    vault.context,
    "action",
    "Board automation",
    "First.",
  );
  const two = await createCard(
    vault.context,
    "action",
    "Board automation",
    "Second.",
  );
  assertEquals(one.path, "Factory/Cards/board-automation.md", "first");
  assertEquals(two.path, "Factory/Cards/board-automation-2.md", "second");
  assertEquals(one.frontmatter.id, "fac-1", "first id");
  assertEquals(two.frontmatter.id, "fac-2", "second id");
});

Deno.test("the board summary shows the human title, not the codename", () => {
  const summary = cardSummary(
    card("fac-7", "action", "", [], "Open cards as a dialog"),
  );
  assertEquals(summary.display, "Open cards as a dialog", "title");
  assert(!summary.display.startsWith("FAC-"), "no codename on the board");
  const base = parseYaml(boardBase) as {
    properties: Record<string, unknown>;
    views: Array<{ order?: string[] }>;
  };
  assert("file.name" in base.properties, "the card column is the filename");
  for (const view of base.views) {
    assert(
      !(view.order ?? []).some((field) => field === "note.display"),
      `${view} does not order by a codename property`,
    );
  }
});

Deno.test("renaming a card preserves its id and rewrites links to it", async () => {
  const vault = new FakeVault({
    "Factory/Cards/FAC-2 board-automation.md": sampleCardNote(),
    "Factory/Cards/FAC-9 voice-input.md": [
      "---",
      "id: fac-9",
      "display: FAC-9",
      "title: Voice input",
      "kind: category",
      "status: Category",
      "relations: []",
      "---",
      "",
      "# Voice input",
      "",
      "See [[FAC-2 board-automation]] for the board.",
    ].join("\n"),
  });
  const migration = await migrateCardPaths(vault.context);
  assertEquals(
    migration.renamed.map((item) => item.to).sort(),
    [
      "Factory/Cards/board-automation.md",
      "Factory/Cards/voice-input.md",
    ],
    "both cards renamed",
  );
  assertEquals(migration.failures, [], "no failures");
  const moved = vault.notes.get("Factory/Cards/board-automation.md") ?? "";
  assert(moved.includes("id: fac-2"), "the id is preserved");
  assert(!/^display:/m.test(moved), "the display property is gone");
  const linker = vault.notes.get("Factory/Cards/voice-input.md") ?? "";
  assert(
    linker.includes("[[board-automation]]"),
    "the wikilink follows the rename",
  );
  assert(!linker.includes("[[FAC-2 board-automation]]"), "old link gone");
});

Deno.test("an already title-only card is a no-op", async () => {
  const vault = new FakeVault({
    "Factory/Cards/board-automation.md": sampleCardNote(),
  });
  const before = vault.notes.get("Factory/Cards/board-automation.md");
  const migration = await migrateCardPaths(vault.context);
  assertEquals(migration.renamed, [], "nothing renamed");
  assertEquals(migration.displayCleared, [], "nothing cleared");
  assertEquals(migration.failures, [], "no failures");
  assertEquals(
    vault.notes.get("Factory/Cards/board-automation.md"),
    before,
    "the note is untouched",
  );
});

Deno.test("a missing CLI leaves the old filename and reports it", async () => {
  const vault = new FakeVault({
    "Factory/Cards/FAC-2 board-automation.md": sampleCardNote(),
  });
  vault.moveFailure =
    'The CLI backend needs the vault global argument to run "move".';
  const migration = await migrateCardPaths(vault.context);
  assertEquals(migration.renamed, [], "no rename is claimed");
  assertEquals(migration.failures.length, 1, "the failure is reported");
  assert(
    migration.failures[0].reason.includes("vault global argument"),
    "the reason is carried",
  );
  assert(
    vault.notes.has("Factory/Cards/FAC-2 board-automation.md"),
    "the old filename stays",
  );
  assertEquals(vault.notes.size, 1, "no duplicate note is created");
  const note = vault.notes.get("Factory/Cards/FAC-2 board-automation.md") ?? "";
  assert(!/^display:/m.test(note), "the codename property is still removed");
});

Deno.test("every existing card is renamed to a title-only filename", async () => {
  const vault = new FakeVault({
    "Factory/Cards/FAC-2 board-automation.md": sampleCardNote(),
    "Factory/Cards/INBOX Uncharacterised.md": [
      "---",
      "id: inbox",
      "display: INBOX",
      "title: Uncharacterised",
      "kind: inbox",
      "status: Uncharacterised",
      "relations: []",
      "---",
      "",
      "# Uncharacterised",
      "",
      "## Thoughts",
      "",
      "- a thought",
    ].join("\n"),
  });
  const migration = await migrateCardPaths(vault.context);
  assertEquals(
    migration.renamed.map((item) => item.to).sort(),
    [
      "Factory/Cards/board-automation.md",
      "Factory/Cards/uncharacterised.md",
    ],
    "every card, including the inbox",
  );
  const paths = [...vault.notes.keys()].sort();
  assertEquals(
    paths,
    [
      "Factory/Cards/board-automation.md",
      "Factory/Cards/uncharacterised.md",
    ],
    "nothing is left on a codename filename",
  );
});

Deno.test("old activity entries show the human title, not the codename", () => {
  const body = [
    "# Board automation",
    "",
    "<!-- swamp:activity:begin -->",
    '<!-- swamp:entry {"id":"e-1","kind":"entry","at":"2026-11-01T00:00:00.000Z"} -->',
    "💡 Proposed FAC-2: make the board tick.",
    "<!-- swamp:entry:end -->",
    "<!-- swamp:activity:end -->",
  ].join("\n");
  const rewritten = rewriteActivityDisplay(
    body,
    "FAC-2",
    "Board automation",
  );
  assert(
    rewritten.includes("Proposed Board automation: make the board tick."),
    "the entry reads with the title",
  );
  assert(!rewritten.includes("FAC-2"), "no codename in the activity log");
});

Deno.test("the codename property is removed from an existing card", async () => {
  const vault = new FakeVault({
    "Factory/Cards/board-automation.md": sampleCardNote(),
  });
  const before = vault.notes.get("Factory/Cards/board-automation.md") ?? "";
  // Put a legacy display back, as an old card has it.
  vault.notes.set(
    "Factory/Cards/board-automation.md",
    before.replace("id: fac-2\n", "id: fac-2\ndisplay: FAC-2\n"),
  );
  const migration = await migrateCardPaths(vault.context);
  assertEquals(migration.displayCleared, ["fac-2"], "cleared");
  const note = vault.notes.get("Factory/Cards/board-automation.md") ?? "";
  assert(!/^display:/m.test(note), "the property is gone");
  assert(note.includes("id: fac-2"), "the id stays");
});

Deno.test("a rename the vault did not actually do is reported, not claimed", async () => {
  const vault = new FakeVault({
    "Factory/Cards/FAC-2 board-automation.md": sampleCardNote(),
  });
  vault.moveSilentlyDoesNothing = true;
  const migration = await migrateCardPaths(vault.context);
  assertEquals(migration.renamed, [], "no rename is claimed");
  assertEquals(migration.failures.length, 1, "the failure is reported");
  assert(
    migration.failures[0].reason.includes("did not create"),
    "the reason says the destination is missing",
  );
  assert(
    vault.notes.has("Factory/Cards/FAC-2 board-automation.md"),
    "the card keeps its old filename",
  );
});
