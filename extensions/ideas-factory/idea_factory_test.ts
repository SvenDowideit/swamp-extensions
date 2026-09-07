import { assertEquals, assertObjectMatch } from "jsr:@std/assert@1";
import {
  classifyByKeywords,
  inferTodoList,
  renderKanban,
  resolveBoardPath,
  toTitle,
} from "./idea_factory.ts";

Deno.test("toTitle trims and truncates", () => {
  assertEquals(toTitle("  build the thing  "), "build the thing");
  assertEquals(toTitle("a".repeat(100)).length, 60);
});

Deno.test("classifier routes a software idea to new-idea", () => {
  const c = classifyByKeywords("build a caching layer for the API");
  assertEquals(c.kind, "new-idea");
});

Deno.test("classifier routes a shopping todo", () => {
  const c = classifyByKeywords("buy milk and eggs");
  assertEquals(c.kind, "todo");
  assertEquals(inferTodoList("buy milk and eggs"), "shopping");
});

Deno.test("classifier routes an appointment todo", () => {
  const c = classifyByKeywords("call the dentist to book an appointment");
  assertEquals(c.kind, "todo");
});

Deno.test("classifier keeps a research note as a note", () => {
  const c = classifyByKeywords("note: interesting article on event sourcing");
  assertEquals(c.kind, "note");
});

Deno.test("classifier detects a minor rethink", () => {
  const c = classifyByKeywords("what if we swapped postgres for sqlite");
  assertEquals(c.kind, "minor-rethink");
});

Deno.test("classifier detects a refinement", () => {
  const c = classifyByKeywords("add search to the dashboard");
  assertEquals(c.kind, "refinement");
});

Deno.test("inferTodoList maps a coding chore to the ideas list", () => {
  assertEquals(inferTodoList("write tests for the caching layer"), "ideas");
});

Deno.test("inferTodoList maps a household chore to household", () => {
  assertEquals(inferTodoList("remember to clean the garage"), "household");
});

Deno.test("resolveBoardPath falls back to default when path is empty/blank", () => {
  const r = resolveBoardPath("", "/opt/ideas/boards");
  assertEquals(r.outputDir, "/opt/ideas/boards");
  assertEquals(r.outPath, "/opt/ideas/boards/kanban.html");

  const blank = resolveBoardPath("   ", "/opt/ideas/boards");
  assertEquals(blank.outPath, "/opt/ideas/boards/kanban.html");
});

Deno.test("resolveBoardPath uses a provided path as-is", () => {
  const r = resolveBoardPath(
    "/srv/idea-factory/kanban.html",
    "/opt/ideas/boards",
  );
  assertEquals(r.outPath, "/srv/idea-factory/kanban.html");
  assertEquals(r.outputDir, "/srv/idea-factory");
});

Deno.test("renderKanban produces a page with the three columns", () => {
  const html = renderKanban(
    {
      thoughts: [{
        id: "t1",
        raw: "build a tool",
        source: "text",
        capturedAt: new Date().toISOString(),
        status: "classified",
      }],
      classifications: [{
        thoughtId: "t1",
        kind: "new-idea",
        confidence: 0.8,
        reasoning: "k",
        classifiedAt: new Date().toISOString(),
        routed: false,
      }],
      ideas: [{
        id: "i1",
        title: "a tool",
        body: "build a tool",
        status: "captured",
        sourceThoughtIds: ["t1"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      todos: [],
      actions: [],
      questions: [],
      plans: [],
    },
    new Date().toISOString(),
  );
  assertObjectMatch({ ok: html.includes("Thoughts") }, { ok: true });
  assertObjectMatch({ ok: html.includes("Ideas") }, { ok: true });
  assertObjectMatch({ ok: html.includes("Todos") }, { ok: true });
  assertObjectMatch({ ok: html.includes("a tool") }, { ok: true });
});

Deno.test("Phase 0: every captured thought stays in the Thoughts column", () => {
  // The classify step runs but routing does not, so no idea is created and the
  // thought remains a thought.
  const html = renderKanban(
    {
      thoughts: [{
        id: "t1",
        raw: "build a tool",
        source: "text",
        capturedAt: new Date().toISOString(),
        status: "classified",
      }],
      classifications: [{
        thoughtId: "t1",
        kind: "new-idea",
        confidence: 0.9,
        reasoning: "k",
        classifiedAt: new Date().toISOString(),
        routed: false,
      }],
      ideas: [],
      todos: [],
      actions: [],
      questions: [],
      plans: [],
    },
    new Date().toISOString(),
  );
  // The thought stays a Thoughts card and no idea card is produced in Phase 0.
  assertEquals(html.includes("thoughts-card"), true);
  assertEquals(html.includes("idea-card"), false);
  assertEquals(html.includes("new-idea ·"), true);
});

Deno.test("a captured thought with no classification shows as unclassified", () => {
  const html = renderKanban(
    {
      thoughts: [{
        id: "t1",
        raw: "a raw unclassified thought",
        source: "text",
        capturedAt: new Date().toISOString(),
        status: "unclassified",
      }],
      classifications: [],
      ideas: [],
      todos: [],
      actions: [],
      questions: [],
      plans: [],
    },
    new Date().toISOString(),
  );
  assertEquals(html.includes("thoughts-card"), true);
  assertEquals(html.includes("unclassified"), true);
});

Deno.test("an idea card shows its action (what the LLM did) and a revert control", () => {
  const now = new Date().toISOString();
  const html = renderKanban(
    {
      thoughts: [],
      classifications: [],
      ideas: [{
        id: "i1",
        title: "caddy extension",
        body: "a caddy extension",
        status: "captured",
        sourceThoughtIds: ["t1", "t2"],
        createdAt: now,
        updatedAt: now,
      }],
      todos: [],
      actions: [{
        id: "a1",
        step: "cluster",
        actor: "llm",
        inputIds: ["t1", "t2"],
        outputId: "i1",
        reasoning: "both are about caddy",
        userPrompt: null,
        llmResponse: "{}",
        before: null,
        status: "applied",
        appliedAt: now,
        revertedAt: null,
      }],
      questions: [],
      plans: [],
    },
    now,
  );
  assertEquals(html.includes("cluster"), true);
  assertEquals(html.includes("both are about caddy"), true);
  assertEquals(html.includes("/api/revert"), true);
});

Deno.test("a pending LLM question is shown with an answer form", () => {
  const now = new Date().toISOString();
  const html = renderKanban(
    {
      thoughts: [],
      classifications: [],
      ideas: [],
      todos: [],
      actions: [],
      questions: [{
        id: "q1",
        actionId: null,
        text: "do you mean the caddy proxy or the systemd service?",
        about: "cluster",
        askedAt: now,
        answer: null,
        answeredAt: null,
      }],
      plans: [],
    },
    now,
  );
  assertEquals(html.includes("do you mean the caddy proxy"), true);
  assertEquals(html.includes("/api/answer"), true);
});

Deno.test("an abandoned idea is not shown in the Ideas column", () => {
  const now = new Date().toISOString();
  const html = renderKanban(
    {
      thoughts: [],
      classifications: [],
      ideas: [{
        id: "i1",
        title: "abandoned idea",
        body: "x",
        status: "abandoned",
        sourceThoughtIds: [],
        createdAt: now,
        updatedAt: now,
      }],
      todos: [],
      actions: [],
      questions: [],
      plans: [],
    },
    now,
  );
  assertEquals(html.includes("abandoned idea"), false);
});

Deno.test("a plan card shows tasks, acceptance criteria, constraints, and unknowns", () => {
  const now = new Date().toISOString();
  const html = renderKanban(
    {
      thoughts: [],
      classifications: [],
      ideas: [{
        id: "i1",
        title: "caddy extension",
        body: "a caddy extension",
        status: "captured",
        sourceThoughtIds: [],
        createdAt: now,
        updatedAt: now,
      }],
      todos: [],
      actions: [],
      questions: [],
      plans: [{
        id: "p1",
        ideaId: "i1",
        tasks: [{
          id: "t1",
          title: "detect the systemd service",
          description: "check for a caddy systemd service",
          acceptanceCriteria: ["returns true when the service exists"],
          testStrategy: "unit",
          dependencies: [],
          effort: "small",
          status: "ready",
        }],
        constraints: ["requires systemd"],
        assumptions: ["caddy is installed"],
        unknowns: ["which domains to proxy"],
        status: "draft",
        createdAt: now,
        updatedAt: now,
      }],
    },
    now,
  );
  assertEquals(html.includes("detect the systemd service"), true);
  assertEquals(html.includes("returns true when the service exists"), true);
  assertEquals(html.includes("requires systemd"), true);
  assertEquals(html.includes("which domains to proxy"), true);
  assertEquals(html.includes("/api/plan"), true);
});
