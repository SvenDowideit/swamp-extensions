import { assertEquals, assertObjectMatch } from "jsr:@std/assert@1";
import {
  classifyByKeywords,
  inferTodoList,
  renderKanban,
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
        createdAt: new Date().toISOString(),
      }],
      todos: [],
    },
    new Date().toISOString(),
  );
  assertObjectMatch({ ok: html.includes("Thoughts") }, { ok: true });
  assertObjectMatch({ ok: html.includes("Ideas") }, { ok: true });
  assertObjectMatch({ ok: html.includes("Todos") }, { ok: true });
  assertObjectMatch({ ok: html.includes("a tool") }, { ok: true });
});
