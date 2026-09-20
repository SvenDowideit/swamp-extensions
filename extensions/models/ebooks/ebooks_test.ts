import { assert, assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";

import {
  esc,
  freshState,
  model,
  nameKey,
  planNames,
} from "./ebooks.ts";
import type { Resolution } from "./book_metadata.ts";

Deno.test("esc escapes HTML special characters", () => {
  assertEquals(esc("a&b"), "a&amp;b");
  assertEquals(esc("a<b>c"), "a&lt;b&gt;c");
  assertEquals(esc('say "hi"'), "say &quot;hi&quot;");
});

Deno.test("esc leaves plain text unchanged", () => {
  assertEquals(esc("The Demolished Man"), "The Demolished Man");
});

Deno.test("freshState initializes an empty scan state", () => {
  const s = freshState("/home/me/books");
  assertEquals(s.root, "/home/me/books");
  assertEquals(s.completed, false);
  assertEquals(s.queue, ["/home/me/books"]);
  assertEquals(s.seenDirs, []);
  assertEquals(s.ebooks, []);
  assertEquals(s.scannedDirs, 0);
});

// ---------------------------------------------------------------------------
// nameKey — must always yield a filesystem-safe, bounded key
// ---------------------------------------------------------------------------

Deno.test("nameKey is stable and case/whitespace insensitive", () => {
  assertEquals(nameKey("William Gibson"), nameKey("william   gibson"));
  assertEquals(nameKey("William Gibson"), nameKey("William Gibson"));
});

Deno.test("nameKey stays under the filesystem name limit for huge titles", () => {
  const huge = "Submission and Formatting Instructions for International " +
    "Conference on Machine Learning (ICML 2026) ".repeat(20) + "\u0000\u0001";
  const key = nameKey(huge);
  assert(key.length <= 64, `key too long: ${key.length}`);
  assert(/^[a-z0-9-]+$/.test(key), `unsafe key: ${key}`);
});

Deno.test("nameKey is safe and distinct for Unicode/garbage names", () => {
  const names = [
    "Грег Иган",
    "\u0000\u0000gY\u0000",
    "Microsoft Word - Document1",
    "A Dance with Dragons",
  ];
  const seen = new Set<string>();
  for (const name of names) {
    const key = nameKey(name);
    assert(/^[a-z0-9-]*$/.test(key), `unsafe key for ${JSON.stringify(name)}`);
    assert(key.length <= 64);
    seen.add(key);
  }
  assertEquals(seen.size, names.length);
  // Distinct non-empty names must not collide on the truncated slug alone.
  assert(nameKey("A Dance with Dragons") !== nameKey("A Dance with Wolves"));
  // Empty / whitespace-only names collapse to one empty key (expected).
  assertEquals(nameKey(""), nameKey("   "));
});

// ---------------------------------------------------------------------------
// planNames — the "what to resolve next" logic
// ---------------------------------------------------------------------------

function item(name: string, expectKind: "author" | "book" = "author") {
  return { name, expectKind, key: nameKey(name) };
}

function resolution(
  from: string,
  resolved: boolean,
  resolvedAt: string,
): Resolution {
  return {
    name: from,
    url: null,
    description: null,
    kind: resolved ? "author" : "not-found",
    resolved,
    from,
    resolvedAt,
    expectKind: "author",
  };
}

Deno.test("planNames returns fresh names up to maxNames", () => {
  const candidates = ["A", "B", "C", "D", "E"].map((n) => item(n));
  const plan = planNames(candidates, new Map(), 3);
  assertEquals(plan.selected.map((i) => i.name), ["A", "B", "C"]);
  assertEquals(plan.fresh, 5);
  assertEquals(plan.backlog, 2);
});

Deno.test("planNames excludes successfully-resolved names", () => {
  const candidates = ["A", "B", "C"].map((n) => item(n));
  const resolutions = new Map([
    ["A", resolution("A", true, "2026-01-01T00:00:00Z")],
    ["C", resolution("C", true, "2026-01-01T00:00:00Z")],
  ]);
  const plan = planNames(candidates, resolutions, 10);
  assertEquals(plan.selected.map((i) => i.name), ["B"]);
  assertEquals(plan.done, 2);
  assertEquals(plan.fresh, 1);
});

Deno.test("planNames keeps the next batch changing as names get resolved", () => {
  const candidates = ["A", "B", "C", "D", "E", "F"].map((n) => item(n));
  const resolutions = new Map<string, Resolution>();

  const first = planNames(candidates, resolutions, 3);
  assertEquals(first.selected.map((i) => i.name), ["A", "B", "C"]);

  // Simulate the workflow resolving the first batch.
  for (const name of ["A", "B", "C"]) {
    resolutions.set(name, resolution(name, true, "2026-01-01T00:00:00Z"));
  }

  const second = planNames(candidates, resolutions, 3);
  assertEquals(second.selected.map((i) => i.name), ["D", "E", "F"]);
  assertEquals(second.done, 3);
  assertEquals(second.backlog, 0);
});

Deno.test("planNames retries failures when there are no fresh names", () => {
  const candidates = ["A", "B", "C"].map((n) => item(n));
  const resolutions = new Map([
    ["A", resolution("A", false, "2026-01-03T00:00:00Z")],
    ["B", resolution("B", false, "2026-01-01T00:00:00Z")],
    ["C", resolution("C", false, "2026-01-02T00:00:00Z")],
  ]);
  const plan = planNames(candidates, resolutions, 2);
  // Least-recently-attempted first: B (Jan 1), C (Jan 2).
  assertEquals(plan.selected.map((i) => i.name), ["B", "C"]);
  assertEquals(plan.failed, 3);
  assertEquals(plan.backlog, 1);
});

Deno.test("planNames gives ~10% of the budget to retries alongside fresh", () => {
  const candidates = [
    ...Array.from({ length: 20 }, (_, i) => item(`F${i}`)),
    ...["X1", "X2"].map((n) => item(n)),
  ];
  const resolutions = new Map([
    ["X1", resolution("X1", false, "2026-01-01T00:00:00Z")],
    ["X2", resolution("X2", false, "2026-01-02T00:00:00Z")],
  ]);
  const plan = planNames(candidates, resolutions, 10);
  assertEquals(plan.selected.length, 10);
  const names = plan.selected.map((i) => i.name);
  // ceil(10*0.9)=9 fresh target, then 1 retry (least-recently-attempted first).
  assertEquals(names.filter((n) => n.startsWith("F")).length, 9);
  assertEquals(names.filter((n) => n.startsWith("X")).length, 1);
  assertEquals(names.at(-1), "X1");
});

Deno.test("planNames with maxNames<=0 selects everything (fresh first)", () => {
  const candidates = ["A", "B", "C"].map((n) => item(n));
  const resolutions = new Map([
    ["A", resolution("A", false, "2026-01-01T00:00:00Z")],
    ["C", resolution("C", true, "2026-01-01T00:00:00Z")],
  ]);
  const plan = planNames(candidates, resolutions, 0);
  assertEquals(plan.selected.map((i) => i.name), ["B", "A"]);
  assertEquals(plan.backlog, 0);
});

// ---------------------------------------------------------------------------
// End-to-end: the real plan-resolution method against a fake data repository,
// then confirm the *next* plan changes once a name has been resolved.
// ---------------------------------------------------------------------------

type StoredRec = { name: string; tags: Record<string, string>; data: unknown };

/**
 * Build a model test context whose dataRepository enumerates the supplied
 * resolution records, so the real `plan-resolution` method can be exercised.
 */
function contextWithResolutions(
  metadata: Record<string, unknown>,
  resolutions: StoredRec[],
) {
  const ctx = createModelTestContext({
    globalArgs: {},
    methodName: "plan-resolution",
    storedResources: { metadata },
  });
  const byName = new Map(
    resolutions.map((r) => [r.name, r] as const),
  );
  // deno-lint-ignore no-explicit-any
  (ctx.context as any).dataRepository = {
    findAllForModel: () =>
      Promise.resolve(
        [...byName.values()].map((r, i) => ({
          name: r.name,
          tags: r.tags,
          createdAt: new Date(2026, 0, i + 1),
          isDeleted: false,
          isRenamed: false,
        })),
      ),
  };
  // readResource must return the record content for resolution-* names.
  const originalRead = ctx.context.readResource;
  ctx.context.readResource = (instanceName: string, version?: number) => {
    const rec = byName.get(instanceName);
    if (rec) return Promise.resolve(rec.data as Record<string, unknown>);
    return originalRead(instanceName, version);
  };
  return ctx;
}

function resolutionRecord(from: string, resolved: boolean): StoredRec {
  const key = `resolution-${nameKey(from)}`;
  return {
    name: key,
    tags: { type: "resource", specName: "resolution" },
    data: resolution(from, resolved, "2026-01-01T00:00:00Z"),
  };
}

Deno.test("plan-resolution: returns the next 3 unresolved authors", async () => {
  const metadata = {
    "/books/1.epub": {
      authors: ["Author One", "Author Two", "Author Three", "Author Four"],
      title: null,
    },
  };
  // Author One already resolved; the other three are fresh.
  const ctx = contextWithResolutions(metadata, [resolutionRecord("Author One", true)]);

  await model.methods["plan-resolution"].execute(
    { maxNames: 3 },
    // deno-lint-ignore no-explicit-any
    ctx.context as any,
  );

  const names = ctx.getWrittenResources().find((r) => r.specName === "names");
  assert(names);
  const items = (names.data as { items: { name: string }[] }).items;
  assertEquals(items.map((i) => i.name).sort(), [
    "Author Four",
    "Author Three",
    "Author Two",
  ]);
});

Deno.test("plan-resolution: the next plan changes after a name is resolved", async () => {
  const metadata = {
    "/books/1.epub": {
      authors: ["Author One", "Author Two", "Author Three", "Author Four"],
      title: null,
    },
  };
  const stored = [resolutionRecord("Author One", true)];

  // First run: three unresolved authors (One is done).
  const first = contextWithResolutions(metadata, stored);
  await model.methods["plan-resolution"].execute(
    { maxNames: 3 },
    // deno-lint-ignore no-explicit-any
    first.context as any,
  );
  const firstItems = (first.getWrittenResources().find((r) =>
    r.specName === "names"
  )!.data as { items: { name: string }[] }).items;
  assertEquals(firstItems.map((i) => i.name).sort(), [
    "Author Four",
    "Author Three",
    "Author Two",
  ]);
  assertEquals(firstItems.length, 3);

  // Simulate the resolution workflow succeeding for all three.
  stored.push(
    resolutionRecord("Author Two", true),
    resolutionRecord("Author Three", true),
    resolutionRecord("Author Four", true),
  );

  // Second run: nothing left to do.
  const second = contextWithResolutions(metadata, stored);
  await model.methods["plan-resolution"].execute(
    { maxNames: 3 },
    // deno-lint-ignore no-explicit-any
    second.context as any,
  );
  const secondItems = (second.getWrittenResources().find((r) =>
    r.specName === "names"
  )!.data as { items: { name: string }[] }).items;
  assertEquals(secondItems, []);
});

Deno.test("plan-resolution: authors are planned before titles", async () => {
  // Many authorless PDFs, each contributing only a title.
  const metadata: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) {
    metadata[`/docs/report-${i}.pdf`] = {
      authors: [],
      title: `Report Title ${i}`,
    };
  }
  metadata["/books/wolfe.epub"] = {
    authors: ["Gene Wolfe"],
    title: "The Book of the New Sun",
  };
  metadata["/books/leiber.epub"] = {
    authors: ["Fritz Leiber"],
    title: "The Swords of Lankhmar",
  };

  const ctx = contextWithResolutions(metadata, []);
  await model.methods["plan-resolution"].execute(
    { maxNames: 3 },
    // deno-lint-ignore no-explicit-any
    ctx.context as any,
  );

  const items = (ctx.getWrittenResources().find((r) =>
    r.specName === "names"
  )!.data as { items: { name: string; expectKind: string }[] }).items;
  // The two unresolved authors must be in the first budget, not starved out by
  // the 50 titles.
  assertEquals(items.map((i) => i.name), [
    "Fritz Leiber",
    "Gene Wolfe",
    "Report Title 0",
  ]);
  assertEquals(items[0]!.expectKind, "author");
});

Deno.test("plan-resolution: prolific authors rank before one-offs", async () => {
  const metadata: Record<string, unknown> = {
    "/books/a1.epub": { authors: ["Jane Oneoff"], title: "A1" },
    "/books/b1.epub": { authors: ["Prolific Author"], title: "B1" },
    "/books/b2.epub": { authors: ["Prolific Author"], title: "B2" },
    "/books/b3.epub": { authors: ["Prolific Author"], title: "B3" },
  };
  const ctx = contextWithResolutions(metadata, []);
  await model.methods["plan-resolution"].execute(
    { maxNames: 5 },
    // deno-lint-ignore no-explicit-any
    ctx.context as any,
  );
  const items = (ctx.getWrittenResources().find((r) =>
    r.specName === "names"
  )!.data as { items: { name: string }[] }).items;
  assertEquals(items[0]!.name, "Prolific Author");
});

Deno.test("plan-resolution: letterless author artefacts are skipped", async () => {
  const metadata: Record<string, unknown> = {
    "/books/x.epub": { authors: ["01"], title: null },
    "/books/y.epub": { authors: ["."], title: null },
    "/books/z.epub": { authors: ["Real Author"], title: null },
  };
  const ctx = contextWithResolutions(metadata, []);
  await model.methods["plan-resolution"].execute(
    { maxNames: 5 },
    // deno-lint-ignore no-explicit-any
    ctx.context as any,
  );
  const items = (ctx.getWrittenResources().find((r) =>
    r.specName === "names"
  )!.data as { items: { name: string }[] }).items;
  assertEquals(items.map((i) => i.name), ["Real Author"]);
});


