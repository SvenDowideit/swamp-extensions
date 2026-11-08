import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { renderTickSummary } from "./obsidian_factory_tick_report.ts";

const cards = [
  {
    id: "fac-12",
    title: "Inventory ESPHome devices",
    column: "Please Plan",
    action: "work",
    stage: "plan",
    cycle: 1,
    path: "Factory/Cards/fac-12.md",
  },
  {
    id: "fac-5",
    title: "Tick webhook",
    column: "User Acceptance",
    action: "wait",
    stage: "acceptance",
    cycle: 5,
    path: "Factory/Cards/fac-5.md",
  },
];

const queue = {
  cards,
  counts: { claim: 0, work: 1, reconcile: 0, done: 0, wait: 1 },
  timestamp: "2026-11-08T00:00:00Z",
};

const run = {
  binary: "pi",
  agent: "pi",
  model: "",
  startedAt: "2026-11-08T00:00:00Z",
  finishedAt: "2026-11-08T00:01:00Z",
  durationMs: 60000,
  exitCode: 0,
  success: true,
  stdout: "Factory tick result\n- fac-12: planned",
  stderr: "",
};

Deno.test("tick summary writes the board and the agent output", () => {
  const text = renderTickSummary(null, queue, null, run);
  assertStringIncludes(text, "2 cards · 1 work");
  assertStringIncludes(text, "fac-12");
  assertStringIncludes(text, "Please Plan");
  assertStringIncludes(text, "pi");
  assertStringIncludes(text, "Factory tick result");
});

Deno.test("tick summary explains a missing agent run", () => {
  const text = renderTickSummary(null, queue, null, null);
  assertStringIncludes(text, "produced no run resource");
  assertStringIncludes(text, "workflow-summary");
});

Deno.test("tick summary shows a failed agent", () => {
  const text = renderTickSummary(null, queue, null, {
    ...run,
    exitCode: 1,
    success: false,
    stderr: "agent went off-task",
  });
  assertStringIncludes(text, "FAILED");
  assertStringIncludes(text, "agent went off-task");
});

Deno.test("tick summary clips very long output", () => {
  const text = renderTickSummary(null, queue, null, {
    ...run,
    stdout: "x".repeat(7000) + "THE-END",
  });
  assertEquals(text.includes("chars omitted"), true);
  assertStringIncludes(text, "THE-END");
});
