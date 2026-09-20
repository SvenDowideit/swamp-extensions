import { assert, assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";

import {
  esc,
  freshState,
  model,
  nameKey,
  planNames,
  renderAuthorsHtml,
  renderHtml,
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

Deno.test("planNames flags truncation when the cap leaves a backlog", () => {
  const candidates = ["A", "B", "C", "D", "E"].map((n) => item(n));
  const capped = planNames(candidates, new Map(), 3);
  assertEquals(capped.truncated, true);
  const uncapped = planNames(candidates, new Map(), 10);
  assertEquals(uncapped.truncated, false);
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

// ---------------------------------------------------------------------------
// renderHtml / renderAuthorsHtml — pure rendering
// ---------------------------------------------------------------------------

const sampleState = {
  root: "/books",
  completed: true,
  queue: [],
  seenDirs: [],
  ebooks: [
    { path: "/books/bester.epub", name: "bester.epub", ext: "epub", bytes: 1234 },
    { path: "/books/other.mobi", name: "other.mobi", ext: "mobi", bytes: 42 },
  ],
  scannedDirs: 1,
  startedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** A complete BookMetadata record for render tests. */
function md(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "book:x",
    title: null,
    author: null,
    isbn: null,
    publishedAt: null,
    editionPublishedAt: null,
    publisher: null,
    language: null,
    description: null,
    series: null,
    format: "epub",
    detected: true,
    confidence: 0.5,
    sourcePath: "/books/bester.epub",
    sourceName: "bester.epub",
    bytes: 1,
    modifiedAt: null,
    ...overrides,
  };
}

Deno.test("renderHtml labels detected ebooks and escapes paths", () => {
  const html = renderHtml("Ebooks", sampleState, {
    "/books/bester.epub": md({
      title: "The Demolished Man",
      author: "Alfred Bester",
      editionPublishedAt: "1953",
    }),
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(html.includes("The Demolished Man"), true);
  assertEquals(html.includes("Alfred Bester"), true);
  assertEquals(html.includes("2 ebooks"), true);
});

Deno.test("renderHtml falls back to a placeholder when empty", () => {
  const empty = { ...sampleState, ebooks: [] };
  const html = renderHtml("Ebooks", empty, {});
  assertEquals(html.includes("No ebooks found yet."), true);
});

Deno.test("renderAuthorsHtml groups by author and escapes HTML", () => {
  const html = renderAuthorsHtml(
    "By Author",
    sampleState,
    {
      "/books/bester.epub": md({
        title: "The Demolished Man",
        author: "Alfred Bester",
        authors: ["Alfred Bester"],
      }),
      // deno-lint-ignore no-explicit-any
    } as any,
    {
      "Alfred Bester": {
        name: "Alfred Bester",
        url: "https://en.wikipedia.org/wiki/Alfred_Bester",
        description: "American writer",
        kind: "author",
        resolved: true,
        from: "Alfred Bester",
        resolvedAt: "2026-01-01T00:00:00Z",
        expectKind: "author",
      },
    },
  );
  // Resolved-as-person authors are linked to Wikipedia.
  assertEquals(html.includes('href="https://en.wikipedia.org/wiki/Alfred_Bester"'), true);
  assertEquals(html.includes("1 author"), true);
});

Deno.test("renderAuthorsHtml does not link an author resolved as a non-person", () => {
  const html = renderAuthorsHtml(
    "By Author",
    sampleState,
    {
      "/books/bester.epub": md({ authors: ["A Book"], title: "X" }),
      // deno-lint-ignore no-explicit-any
    } as any,
    {
      "A Book": {
        name: "A Book",
        url: "https://en.wikipedia.org/wiki/A_Book",
        description: null,
        kind: "book",
        resolved: true,
        from: "A Book",
        resolvedAt: "2026-01-01T00:00:00Z",
        expectKind: "author",
      },
    },
  );
  assertEquals(html.includes("wikipedia.org"), false);
});

// ---------------------------------------------------------------------------
// Method execute paths: scan-disk / detect-metadata / pick-candidate / classify
// ---------------------------------------------------------------------------

Deno.test("scan-disk walks the tree and records ebooks", async () => {
  const root = await Deno.makeTempDir({ prefix: "ebooks-scan-" });
  try {
    await Deno.mkdir(`${root}/sub`);
    await Deno.writeTextFile(`${root}/book.epub`, "x");
    await Deno.writeTextFile(`${root}/sub/another.pdf`, "yy");

    const ctx = createModelTestContext({
      globalArgs: { root, extensions: ["epub", "pdf"], excludePatterns: [] },
      methodName: "scan-disk",
    });
    await model.methods["scan-disk"].execute(
      { maxDurationMs: 30_000 },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );

    const state = ctx.getWrittenResources().find((r) =>
      r.specName === "state"
    )!.data as { ebooks: { path: string }[]; completed: boolean };
    assertEquals(state.ebooks.length, 2);
    assertEquals(state.completed, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan-disk resumes from stored state without losing prior ebooks", async () => {
  const root = await Deno.makeTempDir({ prefix: "ebooks-scan-" });
  try {
    await Deno.writeTextFile(`${root}/book.epub`, "x");
    const prior = {
      ...freshState(root),
      completed: false,
      queue: [root],
      seenDirs: [],
      ebooks: [{
        path: "/already/found.epub",
        name: "found.epub",
        ext: "epub",
        bytes: 1,
      }],
    };
    const ctx = createModelTestContext({
      globalArgs: { root, extensions: ["epub"], excludePatterns: [] },
      methodName: "scan-disk",
      storedResources: { state: prior },
    });
    await model.methods["scan-disk"].execute(
      { maxDurationMs: 30_000 },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );
    const state = ctx.getWrittenResources().find((r) =>
      r.specName === "state"
    )!.data as { ebooks: { path: string }[] };
    // The additive policy must keep the previously-found ebook.
    assertEquals(state.ebooks.some((e) => e.path === "/already/found.epub"), true);
    assertEquals(state.ebooks.some((e) => e.path === `${root}/book.epub`), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("detect-metadata detects a single named file", async () => {
  const root = await Deno.makeTempDir({ prefix: "ebooks-meta-" });
  try {
    const file = `${root}/Alfred Bester - The Demolished Man (1953).epub`;
    await Deno.writeTextFile(file, "not a real epub");
    const ctx = createModelTestContext({
      globalArgs: {},
      methodName: "detect-metadata",
    });
    await model.methods["detect-metadata"].execute(
      { file, maxDurationMs: 30_000 },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );
    const md = ctx.getWrittenResources().find((r) =>
      r.specName === "metadata"
    )!.data as Record<string, { title: string | null; author: string | null }>;
    const rec = md[file]!;
    assertEquals(rec.title, "The Demolished Man");
    assertEquals(rec.author, "Alfred Bester");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("detect-metadata skips entries already at the current parser version", async () => {
  const root = await Deno.makeTempDir({ prefix: "ebooks-meta-" });
  try {
    const file = `${root}/book.epub`;
    await Deno.writeTextFile(file, "x");
    const prior = {
      [file]: {
        id: "x",
        title: "Already Done",
        author: null,
        isbn: null,
        publishedAt: null,
        editionPublishedAt: null,
        publisher: null,
        language: null,
        description: null,
        series: null,
        format: "epub",
        detected: true,
        confidence: 0.3,
        parserVersion: 9999,
        sourcePath: file,
        sourceName: "book.epub",
        bytes: 1,
        modifiedAt: null,
      },
    };
    const ctx = createModelTestContext({
      globalArgs: {},
      methodName: "detect-metadata",
      storedResources: {
        state: { ...freshState(root), ebooks: [{ path: file, name: "book.epub", ext: "epub", bytes: 1 }] },
        metadata: prior,
      },
    });
    await model.methods["detect-metadata"].execute(
      { maxDurationMs: 30_000 },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );
    const md = ctx.getWrittenResources().find((r) =>
      r.specName === "metadata"
    )!.data as Record<string, { title: string | null }>;
    assertEquals(md[file]!.title, "Already Done");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("pick-candidate chooses and writes a candidate record", async () => {
  const ctx = createModelTestContext({
    globalArgs: {},
    methodName: "pick-candidate",
  });
  await model.methods["pick-candidate"].execute({
    name: "Alfred Bester",
    expectKind: "author",
    results: [
      { title: "Alfred Bester", description: null, url: "https://x/A" },
    ],
    pages: {
      "Alfred Bester": {
        title: "Alfred Bester",
        url: "https://x/A",
        shortdesc: "American science fiction author",
        wikidataId: "Q286116",
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any,
    // deno-lint-ignore no-explicit-any
    ctx.context as any);
  const cand = ctx.getWrittenResources().find((r) =>
    r.specName === "candidate"
  )!;
  assertEquals(cand.name, `candidate-${nameKey("Alfred Bester")}`);
  assertEquals(cand.data.title, "Alfred Bester");
  assertEquals(cand.data.wikidataId, "Q286116");
});

Deno.test("pick-candidate writes a null candidate when there are no results", async () => {
  const ctx = createModelTestContext({
    globalArgs: {},
    methodName: "pick-candidate",
  });
  await model.methods["pick-candidate"].execute({
    name: "Nobody",
    expectKind: "author",
    results: [],
    pages: {},
    // deno-lint-ignore no-explicit-any
  } as any,
    // deno-lint-ignore no-explicit-any
    ctx.context as any);
  const cand = ctx.getWrittenResources().find((r) =>
    r.specName === "candidate"
  )!;
  assertEquals(cand.data.title, null);
});

Deno.test("classify writes an author resolution from an infobox", async () => {
  const ctx = createModelTestContext({
    globalArgs: {},
    methodName: "classify",
  });
  await model.methods.classify.execute({
    name: "Alfred Bester",
    expectKind: "author",
    title: "Alfred Bester",
    url: "https://en.wikipedia.org/wiki/Alfred_Bester",
    description: "American writer",
    wikidataId: "Q286116",
    infoboxTemplate: "infobox writer",
    instanceOf: ["Q5"],
    // deno-lint-ignore no-explicit-any
  } as any,
    // deno-lint-ignore no-explicit-any
    ctx.context as any);
  const res = ctx.getWrittenResources().find((r) =>
    r.specName === "resolution"
  )!;
  assertEquals(res.name, `resolution-${nameKey("Alfred Bester")}`);
  assertEquals(res.data.kind, "author");
  assertEquals(res.data.resolved, true);
  assertEquals(res.data.from, "Alfred Bester");
});

Deno.test("classify marks an unresolved name as not resolved", async () => {
  const ctx = createModelTestContext({
    globalArgs: {},
    methodName: "classify",
  });
  await model.methods.classify.execute({
    name: "Some Unknown",
    expectKind: "book",
    title: null,
    url: null,
    description: null,
    wikidataId: null,
    infoboxTemplate: null,
    instanceOf: [],
    // deno-lint-ignore no-explicit-any
  } as any,
    // deno-lint-ignore no-explicit-any
    ctx.context as any);
  const res = ctx.getWrittenResources().find((r) =>
    r.specName === "resolution"
  )!;
  assertEquals(res.data.resolved, false);
  assertEquals(res.data.kind, "other");
});

Deno.test("classify honors an explicit key for the instance name", async () => {
  const ctx = createModelTestContext({
    globalArgs: {},
    methodName: "classify",
  });
  await model.methods.classify.execute({
    name: "A Very Long Name",
    expectKind: "author",
    key: "short-key",
    title: "A Very Long Name",
    url: null,
    description: null,
    wikidataId: null,
    infoboxTemplate: null,
    instanceOf: [],
    // deno-lint-ignore no-explicit-any
  } as any,
    // deno-lint-ignore no-explicit-any
    ctx.context as any);
  const res = ctx.getWrittenResources().find((r) =>
    r.specName === "resolution"
  )!;
  assertEquals(res.name, "resolution-short-key");
});

Deno.test("render-html-list writes the page and a page resource", async () => {
  const outputDir = await Deno.makeTempDir({ prefix: "ebooks-out-" });
  try {
    const outputPath = `${outputDir}/nested/ebooks.html`;
    const ctx = createModelTestContext({
      globalArgs: { outputPath },
      methodName: "render-html-list",
      storedResources: { state: sampleState, metadata: {} },
    });
    await model.methods["render-html-list"].execute(
      { title: "Ebooks" },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );
    const page = ctx.getWrittenResources().find((r) =>
      r.specName === "page"
    )!;
    assertEquals(page.data.count, 2);
    const written = await Deno.readTextFile(outputPath);
    assertEquals(written.includes("bester.epub"), true);
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("render-html-list writes an empty page when nothing was found", async () => {
  const outputDir = await Deno.makeTempDir({ prefix: "ebooks-out-" });
  try {
    const outputPath = `${outputDir}/ebooks.html`;
    const ctx = createModelTestContext({
      globalArgs: { outputPath },
      methodName: "render-html-list",
    });
    await model.methods["render-html-list"].execute(
      { title: "Ebooks" },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );
    const page = ctx.getWrittenResources().find((r) =>
      r.specName === "page"
    )!;
    assertEquals(page.data.count, 0);
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("render-html-authors writes the author index page", async () => {
  const outputDir = await Deno.makeTempDir({ prefix: "ebooks-out-" });
  try {
    const outputPath = `${outputDir}/index.html`;
    const ctx = createModelTestContext({
      globalArgs: { authorsOutputPath: outputPath },
      methodName: "render-html-authors",
      storedResources: {
        state: sampleState,
        metadata: {
          "/books/bester.epub": md({
            authors: ["Alfred Bester"],
            title: "The Demolished Man",
          }),
        },
      },
    });
    // render-html-authors loads resolution records from the data repository.
    // deno-lint-ignore no-explicit-any
    (ctx.context as any).dataRepository = {
      findAllForModel: () => Promise.resolve([]),
    };
    await model.methods["render-html-authors"].execute(
      { title: "By Author" },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );
    const page = ctx.getWrittenResources().find((r) =>
      r.specName === "page"
    )!;
    assertEquals(page.name, "authors-page");
    const written = await Deno.readTextFile(outputPath);
    assertEquals(written.includes("Alfred Bester"), true);
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("render-html-list throws a descriptive error on an unwritable path", async () => {
  const ctx = createModelTestContext({
    globalArgs: { outputPath: "/proc/definitely/not/writable.html" },
    methodName: "render-html-list",
    storedResources: { state: sampleState, metadata: {} },
  });
  let threw = false;
  try {
    await model.methods["render-html-list"].execute(
      { title: "E" },
      // deno-lint-ignore no-explicit-any
      ctx.context as any,
    );
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message.startsWith("Failed to write HTML page"), true);
  }
  assertEquals(threw, true);
});


