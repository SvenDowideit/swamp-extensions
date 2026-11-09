import {
  ARCHIVE_OUTCOMES,
  archiveRequestBody,
  archiveRequestProblem,
  CAPTURE_PLACEHOLDER,
  captureRequestBody,
  captureTextProblem,
  columnFields,
  isArchivablePath,
  isArchivedPath,
  isBoardPath,
  isCardPath,
  isPlaceholderText,
  isSupersededPropertyRow,
  labelledBullets,
  labelledValue,
  movesForStatus,
  planChecklist,
  propertyKeyClass,
  readableCard,
  sanitizeMarkdown,
  section,
  shouldInterceptCardOpen,
  STATUSES,
  statusFromFrontmatter,
  stripFrontmatter,
  stripManagedMarkers,
  summaryPlanStatus,
  supersededCardProperties,
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

Deno.test("isBoardPath finds only the Board page", () => {
  assert(isBoardPath("Factory/Board.md"));
  assert(!isBoardPath("Factory/Board.base"));
  assert(!isBoardPath("Factory/Cards/FAC-1.md"));
});

// ---------------------------------------------------------------------------
// The fields that matter for the card's column
// ---------------------------------------------------------------------------

/** A card with a managed At a glance and Plan, as the board writes them. */
function managedCard(
  options: {
    needsInput?: string[];
    next?: string;
    planStatus?: string;
    known?: string[];
    tasks?: string[];
    tests?: string[];
  } = {},
): string {
  const needs = options.needsInput ?? ["Should the project path stay?"];
  const known = options.known ?? ["The card face is the Bases kanban."];
  const tasks = options.tasks ?? ["- [ ] One task", "- [ ] Two task"];
  const tests = options.tests ?? ["- [ ] A test"];
  return [
    "---",
    "id: fac-21",
    "status: Please Implement",
    "project: /home/sven/src/swamp-project",
    "updated: 2026-11-09T11:00:00.000Z",
    "---",
    "",
    "# Show the fields that matter for the card column",
    "",
    "<!-- swamp:summary:begin -->",
    "## At a glance",
    "",
    `**Stage:** Please Implement · **Plan:** ${
      options.planStatus ?? "final"
    } · **Updated:** 2026-11-09T11:00:00.000Z`,
    "",
    "**Needs your input**",
    "",
    needs.length > 0
      ? needs.map((item) => `- ${item}`).join("\n")
      : "- _Nothing right now — add notes anywhere on this page._",
    "",
    `**Next:** ${options.next ?? "Run the tests"}`,
    "",
    "**Known**",
    "",
    known.length > 0
      ? known.map((item) => `- ${item}`).join("\n")
      : "- _Nothing recorded yet._",
    "",
    "**Unknown**",
    "",
    "- _Nothing outstanding._",
    "<!-- swamp:summary:end -->",
    "",
    "The brief the person wrote.",
    "",
    "<!-- swamp:plan:begin -->",
    "## Plan",
    "",
    `**Status:** ${options.planStatus ?? "final"}`,
    "",
    "**Summary:** The plan's summary.",
    "",
    "### Tasks",
    "",
    tasks.join("\n"),
    "",
    "### Tests",
    "",
    tests.join("\n"),
    "",
    "### Existing functionality changing",
    "",
    "- Nothing",
    "<!-- swamp:plan:end -->",
    "",
    "<!-- swamp:definition:begin -->",
    "## Definition",
    "",
    "Pinned.",
    "<!-- swamp:definition:end -->",
  ].join("\n");
}

function labels(fields: Array<{ label: string }>): string[] {
  return fields.map((field) => field.label);
}

Deno.test("every column shows its own fields", () => {
  const raw = managedCard({
    known: ["Checks: deno test and deno check passed"],
    tasks: ["- [x] One task", "- [ ] Two task"],
  });
  for (const status of STATUSES) {
    const fields = labels(
      columnFields(status, raw, "/home/sven/src/swamp-project"),
    );
    assert(
      fields.includes("Needs your input"),
      `${status} shows the questions`,
    );
    assert(fields.includes("Next"), `${status} shows the next step`);
    const hasPlan = [
      "Please Plan",
      "Work Planned",
      "Please Implement",
      "Please Test",
      "User Acceptance",
      "Please Release",
    ].includes(status);
    assertEquals(fields.includes("Plan"), hasPlan, `${status} plan status`);
    assertEquals(fields.includes("Tasks"), hasPlan, `${status} tasks`);
    assertEquals(fields.includes("Tests"), hasPlan, `${status} tests`);
    const hasChecks = status === "Please Test" || status === "Please Release";
    assertEquals(fields.includes("Checks"), hasChecks, `${status} checks`);
    const hasProject = status !== "Uncharacterised" && status !== "Category" &&
      status !== "Done";
    assertEquals(fields.includes("Project"), hasProject, `${status} project`);
  }
});

Deno.test("Please Test and Please Release show their checks", () => {
  const raw = managedCard({
    known: [
      "The card face is the Bases kanban.",
      "Checks: deno test, deno check and extension fmt passed",
    ],
  });
  const test = columnFields("Please Test", raw);
  const release = columnFields("Please Release", raw);
  for (const fields of [test, release]) {
    const checks = fields.find((field) => field.label === "Checks");
    assert(checks !== undefined, "a Checks field is rendered");
    assert(
      checks.value.includes("deno check"),
      "the check lines are the value",
    );
    assert(
      !checks.value.includes("Bases kanban"),
      "a known line that reports no check is not the checks",
    );
  }
  assert(
    !labels(columnFields("Please Implement", raw)).includes("Checks"),
    "a column whose decision is not a check run gets no Checks field",
  );
  const noChecks = columnFields("Please Release", managedCard());
  assert(
    !labels(noChecks).includes("Checks"),
    "no check line means no invented Checks field",
  );
});

Deno.test("a card with no managed sections shows no fields", () => {
  const raw = [
    "---",
    "id: fac-1",
    "status: Proposed",
    "---",
    "",
    "# A card with no managed sections",
    "",
    "The brief.",
    "",
    "## Questions",
    "",
    "- Is this a question?",
  ].join("\n");
  assertEquals(columnFields("Proposed", raw, ""), [], "no fields, no guesses");
  assertEquals(
    columnFields("Please Implement", raw, ""),
    [],
    "no plan means no plan fields",
  );
  assertEquals(
    columnFields("Please Release", raw, "/a/project"),
    [],
    "no summary means no checks or project line",
  );
});

Deno.test("remaining plan tasks exclude ticked tasks and placeholders", () => {
  const raw = managedCard({
    tasks: ["- [x] Done task", "- [ ] Open task", "- [X] Also done"],
    tests: ["- [ ] _No tests recorded yet._", "- [ ] A real test"],
  });
  const fields = columnFields("Please Implement", raw);
  const tasks = fields.find((field) => field.label === "Tasks");
  assertEquals(tasks?.value, "1 of 3 left", "ticked tasks are not remaining");
  const tests = fields.find((field) => field.label === "Tests");
  assertEquals(tests?.value, "1 of 1 left", "the placeholder is not a test");
  const allDone = managedCard({
    tasks: ["- [x] One task"],
    tests: ["- [x] A test"],
  });
  const done = labels(columnFields("Work Planned", allDone));
  assert(done.includes("Tasks"), "a finished task list is still a field");
  assertEquals(
    columnFields("Work Planned", allDone).find((f) => f.label === "Tasks")
      ?.value,
    "all 1 done",
    "a finished list says so",
  );
  const plan = "### Tasks\n\n- [ ] _No tasks recorded yet._\n";
  assertEquals(planChecklist(plan, "Tasks"), { done: 0, total: 0 }, "no tasks");
});

Deno.test(
  "project shows only where the column decides where work lands and never when empty",
  () => {
    const raw = managedCard();
    const project = "/home/sven/src/swamp-project";
    for (const status of ["Proposed", "Please Plan", "Please Release"]) {
      assert(
        labels(columnFields(status, raw, project)).includes("Project"),
        `${status} shows where the work lands`,
      );
    }
    for (const status of ["Uncharacterised", "Category", "Done"]) {
      assert(
        !labels(columnFields(status, raw, project)).includes("Project"),
        `${status} does not show the project path`,
      );
    }
    assert(
      !labels(columnFields("Proposed", raw, "  ")).includes("Project"),
      "an empty project path renders no project line",
    );
    assertEquals(
      columnFields("Proposed", raw, project).find((f) => f.label === "Project")
        ?.value,
      project,
      "the path is shown as it is",
    );
  },
);

Deno.test(
  "the four superseded rows are matched by Bases key class and never appear as fields",
  () => {
    assertEquals(
      supersededCardProperties().map((property) => property.key),
      ["kind", "project", "source", "updated"],
      "the four rows",
    );
    assertEquals(propertyKeyClass("Kind"), "mod-kind", "the Bases key class");
    for (const property of supersededCardProperties()) {
      assert(
        isSupersededPropertyRow([propertyKeyClass(property.key)], ""),
        `${property.key} matches by its key class`,
      );
      assert(
        isSupersededPropertyRow([], property.label),
        `${property.label} matches by its label fallback`,
      );
    }
    assert(
      isSupersededPropertyRow(["mod-kind"], "Kind"),
      "key class and label agree",
    );
    assert(
      !isSupersededPropertyRow(["mod-title"], "Card"),
      "the title row is not superseded",
    );
    assert(
      !isSupersededPropertyRow([], "Kindred"),
      "a label must match the whole name",
    );
    const raw = managedCard();
    for (const status of STATUSES) {
      const shown = labels(columnFields(status, raw, "/a/project"));
      for (const name of ["Kind", "Source", "Updated"]) {
        assert(!shown.includes(name), `${status} never shows ${name}`);
      }
    }
  },
);

Deno.test("the managed prose helpers read only what the board writes", () => {
  const raw = managedCard({
    needsInput: ["First question", "Second question"],
    next: "Run the tests",
    known: ["Checks: passed", "_Nothing recorded yet._"],
  });
  const body = stripFrontmatter(raw);
  assert(
    body.includes("**Needs your input**"),
    "the fixture carries the managed summary",
  );
  assertEquals(
    labelledBullets(
      "**Needs your input**\n\n- one\n- two\n\n**Known**\n\n- three\n",
      "Needs your input",
    ),
    ["one", "two"],
    "only the labelled list",
  );
  assertEquals(
    labelledValue("**Next:** Do the thing\n", "Next"),
    "Do the thing",
    "the inline value",
  );
  assertEquals(
    summaryPlanStatus(
      "**Stage:** Work Planned · **Plan:** draft · **Updated:** x",
    ),
    "draft",
    "the plan status word",
  );
  assert(isPlaceholderText("_Nothing outstanding._"), "placeholder");
  assert(!isPlaceholderText("A real value"), "not a placeholder");
  assert(isPlaceholderText("   "), "an empty value is not a value");
  const fields = columnFields("Please Implement", raw);
  assertEquals(
    fields.find((field) => field.label === "Needs your input")?.value,
    "First question (+1 more)",
    "the first question and a count",
  );
});

Deno.test("every card gets fields whether or not it has move buttons", () => {
  const source = mainSource;
  const fieldsPass = methodBody(source, "private decorateCardFields(");
  const movesPass = methodBody(source, "private decorateCards(");
  assert(
    fieldsPass.includes("decorateCardFieldsOne"),
    "the fields pass decorates every kanban card",
  );
  assert(
    !fieldsPass.includes("movesForStatus"),
    "the fields pass does not depend on a legal move",
  );
  assert(
    !fieldsPass.includes("factoryMoves"),
    "the fields pass is not behind the moves guard",
  );
  assert(
    movesPass.includes("this.decorateCardFields(byTitle)"),
    "the moves pass runs first and then the fields pass",
  );
  assert(
    movesPass.indexOf("this.decorateCardFields(byTitle)") >
      movesPass.indexOf("factoryMoves"),
    "the fields block is rendered after the moves row",
  );
  const one = methodBody(source, "private async decorateCardFieldsOne(");
  assert(
    one.includes("document.querySelectorAll") === false,
    "one card at a time",
  );
  assert(
    one.includes("hideSupersededRows"),
    "the superseded rows are hidden on every card",
  );
});

Deno.test("a second decoration pass does not stack a second block", () => {
  const one = methodBody(mainSource, "private async decorateCardFieldsOne(");
  assert(
    one.indexOf("fieldPassInFlight.add(file.path)") <
      one.indexOf("await this.app.vault.cachedRead(file)"),
    "the in-flight mark is set before the first await",
  );
  assert(
    one.includes("finally") &&
      one.includes("fieldPassInFlight.delete(file.path)"),
    "the mark is cleared in a finally so a failed read is retried",
  );
  assert(
    one.includes("factoryFieldsKey"),
    "an existing block is re-rendered only when its signature changed",
  );
  assert(
    one.includes("existing?.remove()"),
    "the old block is removed before a new one is added",
  );
});

Deno.test("the field decoration writes nothing to a card", () => {
  const source = mainSource;
  for (
    const signature of [
      "private decorateCardFields(",
      "private async decorateCardFieldsOne(",
      "private hideSupersededRows(",
    ]
  ) {
    const body = methodBody(source, signature);
    for (
      const write of [
        "processFrontMatter",
        "vault.modify",
        "vault.create",
        "vault.process",
      ]
    ) {
      assert(!body.includes(write), `${signature} never calls ${write}`);
    }
  }
});

Deno.test("an unknown column renders no fields", () => {
  const raw = managedCard({ known: ["Checks: passed"] });
  for (const status of ["", "  ", "Shipped", "please implement", "Archive"]) {
    assertEquals(
      columnFields(status, raw, "/a/project"),
      [],
      `${status || "an empty column"} renders nothing`,
    );
  }
});

/** The body of one private method, up to the next method. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert(start >= 0, `${signature} exists`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf("\n  private ");
  return end >= 0 ? rest.slice(0, end) : rest;
}
