/**
 * Tests for @svendowideit/gtd — renderer and routing helpers.
 *
 * Run: ~/.swamp/deno/deno test extensions/gtd/gtd_test.ts
 *
 * @module
 */

import { assert } from "jsr:@std/assert@1";
import { renderBoard, renderColumn } from "./gtd.ts";

const emptyData = {
  inbox: [],
  nextActions: [],
  projects: [],
  waitingFor: [],
  somedayMaybe: [],
  calendar: [],
  reference: [],
  contexts: [],
  completed: [],
  reviews: [],
};

Deno.test("renderBoard produces a full page with htmx", () => {
  const html = renderBoard(emptyData, "2026-09-10T00:00:00Z");
  assert(html.includes("<!DOCTYPE html>"));
  assert(html.includes("htmx.org"));
  assert(html.includes('id="col-inbox"'));
  assert(html.includes('id="col-next-actions"'));
  assert(html.includes('id="now-panel"'));
  assert(html.includes("hx-post"));
  assert(html.includes('id="board-container"'));
  assert(html.includes('hx-target="#board-container"'));
});

Deno.test("renderColumn renders inbox cards with clarify forms", () => {
  const d = {
    ...emptyData,
    inbox: [{
      id: "in-1",
      raw: "Buy milk",
      source: "manual",
      capturedAt: "2026-09-10T00:00:00Z",
      status: "unprocessed" as const,
    }],
  };
  const html = renderColumn("inbox", d);
  assert(html.includes("Buy milk"));
  assert(html.includes('hx-post="/api/clarify"'));
  assert(html.includes('name="itemId"'));
  // Icon-button clarifier: one button per classification, icon + tooltip.
  assert(html.includes('title="Next action">✅</button>'));
  assert(html.includes('title="Project">🗂</button>'));
  assert(html.includes('title="Trash">🗑</button>'));
  assert(!html.includes("<select"));
});

Deno.test("renderColumn renders next-actions with complete/defer/revert", () => {
  const d = {
    ...emptyData,
    nextActions: [{
      id: "na-1",
      title: "Call the dentist",
      context: "@phone",
      priority: "high" as const,
      energy: "low" as const,
      due: null,
      projectId: null,
      status: "open" as const,
      notes: "",
      createdAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-10T00:00:00Z",
    }],
  };
  const html = renderColumn("next-actions", d);
  assert(html.includes("Call the dentist"));
  assert(html.includes('hx-post="/api/complete"'));
  assert(html.includes('hx-post="/api/defer"'));
  assert(html.includes('hx-post="/api/revert"'));
});

Deno.test("renderColumn escapes HTML in titles", () => {
  const d = {
    ...emptyData,
    nextActions: [{
      id: "na-2",
      title: "<script>alert(1)</script>",
      context: "@anywhere",
      priority: "medium" as const,
      energy: "medium" as const,
      due: null,
      projectId: null,
      status: "open" as const,
      notes: "",
      createdAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-10T00:00:00Z",
    }],
  };
  const html = renderColumn("next-actions", d);
  assert(!html.includes("<script>alert(1)</script>"));
  assert(html.includes("&lt;script&gt;"));
});
