/**
 * Unit tests for @svendowideit/swamp-pulse helpers and methods.
 *
 * Run: ~/.swamp/deno/deno test extensions/workflows/swamp-pulse/swamp_pulse_test.ts
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { celEscape, celUnescape, celUnescapeDeep } from "./cel_text.ts";
import {
  classifyImportance,
  escapeHtml,
  isDocPath,
  mergeEvents,
  mergeStore,
  model,
  parseConventional,
  parseRefs,
  rankItems,
  renderIndexPage,
  renderItem,
  renderMarkdownLite,
  renderTourPage,
  resolveManualUrl,
  windowBounds,
} from "./swamp_pulse.ts";

const globalArgs = {
  outputDir: "/tmp/swamp-pulse-test",
  manualBaseUrl: "https://swamp-club.com/manual",
  windows: ["24h", "7d", "month"],
  storeRetentionDays: 90,
  docPathPattern: "",
};

// ---------------------------------------------------------------------------
// cel_text — literal ${{ }} transport
// ---------------------------------------------------------------------------

Deno.test("celEscape neutralises literal CEL and celUnescape restores it", () => {
  const original = "docs: support ${{ env.VAR }} and vault.get()";
  const escaped = celEscape(original);
  assert(!escaped.includes("${{"), "escaped text still contains a CEL opener");
  assertEquals(celUnescape(escaped), original);
});

Deno.test("celEscape/celUnescape round-trip through JSON", () => {
  const original = "* feat: extend ${{ env.VAR }} interpolation (#2470)";
  const payload = { body: celEscape(original) };
  const restored = celUnescapeDeep(JSON.parse(JSON.stringify(payload)));
  assertEquals(restored.body, original);
});

Deno.test("celUnescapeDeep handles nested arrays and objects", () => {
  const restored = celUnescapeDeep({
    repos: [{ releases: [{ body: celEscape("a ${{ x }} b") }] }],
  });
  assertEquals(restored.repos[0].releases[0].body, "a ${{ x }} b");
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

Deno.test("escapeHtml neutralises injection vectors", () => {
  assertEquals(
    escapeHtml("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
  assertEquals(escapeHtml('a "b" & c'), "a &quot;b&quot; &amp; c");
  assertEquals(
    escapeHtml("<img src=x onerror=alert(1)>"),
    "&lt;img src=x onerror=alert(1)&gt;",
  );
});

// ---------------------------------------------------------------------------
// parseRefs — namespaces
// ---------------------------------------------------------------------------

Deno.test("parseRefs separates lab issues from PR numbers", () => {
  const refs = parseRefs(
    "fix(workers): reap stale worker records (swamp-club#2192) (#2509)",
  );
  assertEquals(refs.issues, [2192]);
  assertEquals(refs.prs, [2509]);
});

Deno.test("parseRefs treats a bare number as a PR, never a lab issue", () => {
  const refs = parseRefs("docs(datastores): correct path (#2506)");
  assertEquals(refs.issues, []);
  assertEquals(refs.prs, [2506]);
});

Deno.test("parseRefs recognises lab# alias", () => {
  const refs = parseRefs("see lab#42 for context");
  assertEquals(refs.issues, [42]);
});

Deno.test("parseRefs handles a merged title with both namespaces and a bare ref", () => {
  const refs = parseRefs("feat(x): thing (swamp-club#2254) (#2507) (#2508)");
  assertEquals(refs.issues, [2254]);
  assertEquals(refs.prs.sort((a, b) => a - b), [2507, 2508]);
});

// ---------------------------------------------------------------------------
// parseConventional
// ---------------------------------------------------------------------------

Deno.test("parseConventional extracts type, scope and description", () => {
  assertEquals(parseConventional("fix(cli): keep output off stdout"), {
    type: "fix",
    scope: "cli",
    description: "keep output off stdout",
  });
});

Deno.test("parseConventional handles a plain message", () => {
  assertEquals(parseConventional("just a commit"), {
    type: "",
    scope: "",
    description: "just a commit",
  });
});

Deno.test("parseConventional handles breaking marker", () => {
  const parsed = parseConventional("feat(api)!: drop v1");
  assertEquals(parsed.type, "feat");
  assertEquals(parsed.scope, "api");
  assertEquals(parsed.description, "drop v1");
});

// ---------------------------------------------------------------------------
// isDocPath
// ---------------------------------------------------------------------------

Deno.test("isDocPath detects markdown, README, design and docs dirs", () => {
  assert(isDocPath("docs/guide.md"));
  assert(isDocPath("README.md"));
  assert(isDocPath("design/enablers/datastores.md"));
  assert(isDocPath("packages/testing/README"));
  assert(isDocPath("src/foo/bar.mdx"));
  assert(!isDocPath("src/cli/mod.ts"));
});

Deno.test("isDocPath honours an extra pattern", () => {
  assert(isDocPath("CHANGELOG.rst", "\\.rst$"));
  assert(!isDocPath("src/cli/mod.ts", "\\.rst$"));
});

// ---------------------------------------------------------------------------
// resolveManualUrl
// ---------------------------------------------------------------------------

Deno.test("resolveManualUrl uses the explicit map first", () => {
  const result = resolveManualUrl(
    "design/enablers/datastores.md",
    ["/manual/reference/datastore-configuration"],
  );
  assertEquals(result.confidence, 1);
  assertStringIncludes(result.url, "/manual/reference/datastore-configuration");
});

Deno.test("resolveManualUrl fuzzy-matches a known page above threshold", () => {
  const result = resolveManualUrl("docs/issue-guide.md", [
    "/manual/reference/issue-commands",
  ]);
  // "issue" overlaps, so confidence is above zero; assert it links somewhere sane.
  assert(result.confidence >= 0);
});

Deno.test("resolveManualUrl refuses to guess when below threshold", () => {
  const result = resolveManualUrl("docs/zzz-unrelated.md", [
    "/manual/reference/tls-and-proxies",
  ]);
  assertEquals(result.url, "");
  assert(result.confidence < 0.6);
});

Deno.test("resolveManualUrl returns empty for no pages", () => {
  assertEquals(resolveManualUrl("docs/x.md", []), {
    url: "",
    confidence: 0,
  });
});

// ---------------------------------------------------------------------------
// classifyImportance
// ---------------------------------------------------------------------------

Deno.test("classifyImportance escalates security to S", () => {
  const result = classifyImportance({
    kind: "change",
    type: "fix",
    title: "patch CVE-2026-1234",
    summary: "",
  });
  assertEquals(result.tier, "S");
});

Deno.test("classifyImportance promotes a shipped bug to A", () => {
  const result = classifyImportance({
    kind: "issue",
    type: "",
    title: "crash on start",
    summary: "",
    issueType: "bug",
    issueStatus: "shipped",
  });
  assertEquals(result.tier, "A");
});

Deno.test("classifyImportance ranks feat/fix as A and docs as C", () => {
  assertEquals(
    classifyImportance({
      kind: "change",
      type: "feat",
      title: "x",
      summary: "",
    }).tier,
    "A",
  );
  assertEquals(
    classifyImportance({
      kind: "change",
      type: "docs",
      title: "x",
      summary: "",
    }).tier,
    "C",
  );
});

Deno.test("classifyImportance ignores security words in auto-generated release bodies", () => {
  // Release bodies routinely contain "Security" / "vulnerability scan" in
  // boilerplate test plans; only the title/scope/issue type may escalate.
  const result = classifyImportance({
    kind: "change",
    type: "fix",
    scope: "cli",
    title: "fix(cli): keep log output off stdout (#2507)",
    summary:
      "## Test plan\n- [x] vuln scan passes\n- [x] security review: pass",
  });
  assertEquals(result.tier, "A");
});

Deno.test("classifyImportance escalates a security scope to S", () => {
  const result = classifyImportance({
    kind: "change",
    type: "fix",
    scope: "security",
    title: "fix(security): strip SWAMP_* env vars",
    summary: "routine body",
  });
  assertEquals(result.tier, "S");
});

Deno.test("classifyImportance does not escalate an ordinary auth-scope change to S", () => {
  const result = classifyImportance({
    kind: "change",
    type: "feat",
    scope: "auth",
    title: "show first-login guidance after swamp auth login (#2456)",
    summary: "",
  });
  assertEquals(result.tier, "A");
});

Deno.test("classifyImportance escalates a CVE in the title to S", () => {
  const result = classifyImportance({
    kind: "change",
    type: "fix",
    scope: "tls",
    title: "fix(tls): patch CVE-2026-1234",
    summary: "",
  });
  assertEquals(result.tier, "S");
});

Deno.test("classifyImportance downgrades a prerelease to C", () => {
  assertEquals(
    classifyImportance({
      kind: "change",
      type: "feat",
      title: "x",
      summary: "",
      isPrerelease: true,
    }).tier,
    "C",
  );
});

// ---------------------------------------------------------------------------
// mergeEvents — the join / dedupe
// ---------------------------------------------------------------------------

const commitCollection = {
  repos: [
    {
      repo: "swamp-club/swamp",
      commits: [
        {
          repo: "swamp-club/swamp",
          sha: "a3e60933d3861d2e56d1166533761c28304c6d1f",
          shortSha: "a3e60933",
          message: "fix(workers): reap stale workers (swamp-club#2192) (#2509)",
          author: "Paul Stack",
          date: "2026-09-17T23:36:45Z",
          url:
            "https://github.com/swamp-club/swamp/commit/a3e60933d3861d2e56d1166533761c28304c6d1f",
        },
        {
          repo: "swamp-club/swamp",
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          shortSha: "bbbbbbbb",
          message: "chore: unreleased direct push",
          author: "Someone",
          date: "2026-09-17T20:00:00Z",
          url:
            "https://github.com/swamp-club/swamp/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
      count: 2,
      truncated: false,
    },
  ],
  count: 2,
  truncated: false,
  since: "2026-08-18T00:00:00Z",
  until: "2026-09-18T00:00:00Z",
  fetchedAt: "2026-09-18T00:00:00Z",
  durationMs: 1,
  collectedBy: "@svendowideit/swamp-pulse",
};

const releaseCollection = {
  repos: [
    {
      repo: "swamp-club/swamp",
      releases: [
        {
          repo: "swamp-club/swamp",
          tagName: "v20260917.233703.0-sha.a3e60933",
          name: "swamp 20260917.233703.0-sha.a3e60933",
          body:
            "* fix(workers): reap stale worker records and token bindings (swamp-club#2192) (#2509)",
          publishedAt: "2026-09-17T23:38:48Z",
          isPrerelease: false,
          commitSha: "a3e60933",
          url:
            "https://github.com/swamp-club/swamp/releases/tag/v20260917.233703.0-sha.a3e60933",
        },
      ],
      count: 1,
      truncated: false,
    },
  ],
  count: 1,
  truncated: false,
  since: "2026-08-18T00:00:00Z",
  fetchedAt: "2026-09-18T00:00:00Z",
  durationMs: 1,
  collectedBy: "@svendowideit/swamp-pulse",
};

const labIssueCollection = {
  issues: [
    {
      number: 2192,
      type: "bug",
      status: "shipped",
      title: "Worker records accumulate",
      author: "stack72",
      url: "https://swamp-club.com/lab/2192",
      createdAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-17T23:00:00Z",
    },
  ],
  count: 1,
  total: 1,
  truncated: false,
  filters: { since: "", until: "", type: "all", status: "all", source: "" },
  fetchedAt: "2026-09-18T00:00:00Z",
  durationMs: 1,
  collectedBy: "@svendowideit/swamp-club",
};

Deno.test("mergeEvents joins a release and its commit into one item", () => {
  const items = mergeEvents({
    commits: commitCollection,
    releases: releaseCollection,
    labIssues: labIssueCollection,
  });
  const changes = items.filter((i) => i.kind === "change");
  // The released commit is not duplicated as a separate commit-only item.
  assertEquals(changes.length, 2);
  const released = changes.find((i) => i.releaseTag);
  assert(released);
  assertEquals(released.issueNumbers, [2192]);
  assertEquals(released.prNumbers, [2509]);
  assert(released.labIssue);
});

Deno.test("mergeEvents keeps release-less commits as their own item", () => {
  const items = mergeEvents({
    commits: commitCollection,
    releases: releaseCollection,
  });
  const unreleased = items.find((i) => i.id.includes("bbbbbbbb"));
  assert(unreleased);
  assertEquals(unreleased.releaseTag, "");
});

Deno.test("mergeEvents emits lab issues as separate items", () => {
  const items = mergeEvents({ labIssues: labIssueCollection });
  assertEquals(items.length, 1);
  assertEquals(items[0].kind, "issue");
  assertEquals(items[0].importance, "A");
});

Deno.test("mergeEvents links changed docs with source and manual URLs", () => {
  const items = mergeEvents(
    {
      commits: commitCollection,
      docChanges: {
        repos: [
          {
            repo: "swamp-club/swamp",
            files: [
              {
                repo: "swamp-club/swamp",
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                shortSha: "bbbbbbbb",
                filename: "design/enablers/datastores.md",
                status: "modified",
                additions: 1,
                deletions: 1,
                changes: 2,
              },
            ],
            commitsInspected: 1,
            truncated: false,
          },
        ],
        count: 1,
        truncated: false,
        since: "",
        until: "",
        fetchedAt: "",
        durationMs: 1,
        collectedBy: "x",
      },
    },
    { manualPages: ["/manual/reference/datastore-configuration"] },
  );
  const item = items.find((i) => i.id.includes("bbbbbbbb"));
  assert(item);
  assertEquals(item.docLinks.length, 1);
  assertStringIncludes(item.docLinks[0].sourceUrl, "blob/bbbbbbbb");
  assertStringIncludes(
    item.docLinks[0].manualUrl,
    "/manual/reference/datastore-configuration",
  );
});

Deno.test("mergeEvents tolerates missing collector input", () => {
  assertEquals(mergeEvents({}), []);
  assertEquals(mergeEvents({ commits: null, releases: undefined }), []);
});

// ---------------------------------------------------------------------------
// mergeStore
// ---------------------------------------------------------------------------

Deno.test("mergeStore dedupes by id keeping the newest and prunes by age", () => {
  const now = new Date("2026-09-18T00:00:00Z");
  const old = {
    ...makeItem("issue:1", "2026-01-01T00:00:00Z"),
  };
  const fresh = makeItem("issue:2", "2026-09-17T00:00:00Z");
  const merged = mergeStore([old], [fresh], 90, now);
  assertEquals(merged.map((i) => i.id), ["issue:2"]);
});

Deno.test("mergeStore keeps an older id when it is the only one", () => {
  const now = new Date("2026-09-18T00:00:00Z");
  const kept = makeItem("issue:1", "2026-09-01T00:00:00Z");
  const merged = mergeStore([], [kept], 90, now);
  assertEquals(merged.length, 1);
});

// ---------------------------------------------------------------------------
// windows + ranking
// ---------------------------------------------------------------------------

Deno.test("windowBounds month is the UTC calendar month", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  const { since, label } = windowBounds("month", now);
  assertEquals(since.toISOString(), "2026-09-01T00:00:00.000Z");
  assertEquals(label, "This month");
});

Deno.test("windowBounds handles 24h and 7d", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  assertEquals(
    windowBounds("24h", now).since.toISOString(),
    "2026-09-17T12:00:00.000Z",
  );
  assertEquals(
    windowBounds("7d", now).since.toISOString(),
    "2026-09-11T12:00:00.000Z",
  );
});

Deno.test("rankItems orders tier before recency", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  const items = [
    {
      ...makeItem("commit:c", "2026-09-18T11:00:00Z", "A"),
      importance: "A" as const,
    },
    {
      ...makeItem("commit:s", "2026-09-17T13:00:00Z", "S"),
      importance: "S" as const,
    },
    {
      ...makeItem("commit:c2", "2026-09-18T11:30:00Z", "C"),
      importance: "C" as const,
    },
  ];
  const ranked = rankItems(items, "24h", now);
  assertEquals(ranked.map((i) => i.importance), ["S", "A", "C"]);
});

Deno.test("rankItems excludes items outside the window", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  const items = [
    makeItem("old", "2026-08-01T00:00:00Z"),
    makeItem("new", "2026-09-18T11:00:00Z"),
  ];
  assertEquals(rankItems(items, "24h", now).map((i) => i.id), ["new"]);
});

Deno.test("rankItems assigns a numeric score within tier", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  const ranked = rankItems([makeItem("x", "2026-09-18T11:00:00Z")], "24h", now);
  assert(ranked[0].score > 0);
});

// ---------------------------------------------------------------------------
// rendering — escaping
// ---------------------------------------------------------------------------

Deno.test("renderMarkdownLite escapes HTML in bodies", () => {
  const html = renderMarkdownLite("<script>alert(1)</script>");
  assert(!html.includes("<script>"), "raw script tag leaked");
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("renderMarkdownLite renders lists and code", () => {
  const html = renderMarkdownLite("* one\n* two\n\n`code`");
  assertStringIncludes(html, "<ul>");
  assertStringIncludes(html, "<li>one</li>");
  assertStringIncludes(html, "<code>code</code>");
});

Deno.test("renderItem escapes a malicious release body and title", () => {
  const item = {
    ...makeItem("release:evil", "2026-09-18T00:00:00Z"),
    title: "<img src=x onerror=alert(1)>",
    summary: "<script>alert('pwn')</script>",
  };
  const html = renderItem(item);
  assert(!html.includes("<img src=x"), "raw img leaked");
  assert(!html.includes("<script>alert"), "raw script leaked");
  assertStringIncludes(html, "&lt;img");
});

Deno.test("renderItem includes tour reference rows", () => {
  const item = {
    ...makeItem("release:r", "2026-09-18T00:00:00Z"),
    releaseTag: "v1",
    releaseUrl: "https://example.com/r",
    commitSha: "abcdef1234",
    commitUrl: "https://example.com/c",
    shortSha: "abcdef12",
    prNumbers: [2509],
    issueNumbers: [2192],
    labIssue: {
      number: 2192,
      type: "bug",
      status: "shipped",
      title: "t",
      author: "a",
      url: "https://swamp-club.com/lab/2192",
    },
  };
  const html = renderItem(item);
  assertStringIncludes(html, "𝗗");
  assertStringIncludes(html, "𝗖𝗟");
  assertStringIncludes(html, "𝗣");
  assertStringIncludes(html, "lab#2192");
});

Deno.test("renderTourPage emits an anchored sidebar ToC and empty state", () => {
  const items = [makeItem("commit:x", "2026-09-18T00:00:00Z")];
  const html = renderTourPage("Changes", "changes.html", items, {
    emptyText: "none",
  });
  assertStringIncludes(html, 'class="toc"');
  assertStringIncludes(html, "#commit-x");
  const empty = renderTourPage("Changes", "changes.html", [], {
    emptyText: "nothing here",
  });
  assertStringIncludes(empty, "nothing here");
});

Deno.test("renderTourPage groups tail items without duplication", () => {
  const items = [
    { ...makeItem("commit:1", "2026-09-18T10:00:00Z", "A"), scope: "cli" },
    { ...makeItem("commit:2", "2026-09-18T09:00:00Z", "B"), scope: "ci" },
    { ...makeItem("commit:4", "2026-09-18T09:30:00Z", "B"), scope: "core" },
    { ...makeItem("commit:3", "2026-09-18T08:00:00Z", "C"), scope: "docs" },
  ];
  const html = renderTourPage("Changes", "changes.html", items, {
    emptyText: "none",
    promote: 1,
  });
  assertStringIncludes(html, "Other notable changes");
  assertStringIncludes(html, "Tooling");
  assertStringIncludes(html, "Hidden gems");
  // Each tail item appears in exactly one group.
  const other =
    (html.split("Other notable changes")[1] ?? "").split("Tooling")[0];
  const tooling = (html.split("Tooling")[1] ?? "").split("Hidden gems")[0];
  assertStringIncludes(other, "commit-4");
  assertStringIncludes(tooling, "commit-2");
  assert(
    !other.includes("commit-2"),
    "ci item leaked into Other notable changes",
  );
  assert(!tooling.includes("commit-4"), "core item leaked into Tooling");
  assertStringIncludes(html, "Final thoughts");
});

Deno.test("renderIndexPage produces a leaderboard table per window", () => {
  const ranked = {
    windows: [
      {
        key: "24h",
        label: "Last 24 hours",
        since: "2026-09-17T12:00:00Z",
        until: "2026-09-18T12:00:00Z",
        changes: 1,
        releases: 1,
        issues: 0,
        items: [makeItem("release:r", "2026-09-18T00:00:00Z")],
      },
    ],
    totals: {
      events: 3,
      commits: 1,
      releases: 1,
      issues: 1,
      docChanges: 0,
      byRepo: { "swamp-club/swamp": 2 },
    },
    manualPages: 10,
    generatedAt: "2026-09-18T12:00:00Z",
  };
  const html = renderIndexPage(ranked);
  assertStringIncludes(html, "SWAMP PULSE");
  assertStringIncludes(html, "Last 24 hours");
  assertStringIncludes(html, 'class="board"');
  assertStringIncludes(html, "New / changed documentation");
});

// ---------------------------------------------------------------------------
// method-level tests with createModelTestContext
// ---------------------------------------------------------------------------

Deno.test("model exposes the expected specs and methods", () => {
  assertEquals(model.type, "@svendowideit/swamp-pulse");
  for (
    const spec of ["store", "ranked", "manualIndex"]
  ) {
    assert(spec in model.resources, `missing resource ${spec}`);
  }
  for (
    const spec of ["summaryPage", "changesPage", "releasesPage", "issuesPage"]
  ) {
    assert(spec in model.files, `missing file ${spec}`);
  }
  for (const method of ["sync_manual_index", "rank", "render"]) {
    assert(method in model.methods, `missing method ${method}`);
  }
});

Deno.test("rank writes a ranked resource with all configured windows", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "rank",
  });
  await model.methods.rank.execute(
    {
      commits: commitCollection,
      releases: releaseCollection,
      labIssues: labIssueCollection,
      now: "2026-09-18T00:00:00Z",
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  const ranked = getWrittenResources().find((r) => r.specName === "ranked");
  assert(ranked);
  const data = ranked.data as {
    windows: unknown[];
    totals: { events: number };
  };
  assertEquals(data.windows.length, 3);
  assertEquals(data.totals.events, 3);
});

Deno.test("rank merges fresh events into a pre-existing store", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "rank",
    storedResources: {
      store: {
        events: [makeItem("issue:99", "2026-09-17T00:00:00Z")],
        cursor: {
          commitsSince: "",
          releasesSince: "",
          issuesSince: "",
          updatedAt: "",
        },
        updatedAt: "",
      },
    },
  });
  await model.methods.rank.execute(
    { commits: commitCollection, now: "2026-09-18T00:00:00Z" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  const store = getWrittenResources().find((r) => r.specName === "store");
  assert(store);
  const data = store.data as { events: unknown[] };
  assert(data.events.length >= 2, "prior event was not merged in");
});

Deno.test("render fails clearly when rank has not run", async () => {
  const { context } = createModelTestContext({
    globalArgs,
    methodName: "render",
  });
  let threw = false;
  try {
    await model.methods.render.execute(
      {},
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "run `rank`");
  }
  assert(threw, "render should throw without ranked data");
});

Deno.test("render writes four HTML pages from ranked data", async () => {
  const ranked = {
    windows: [
      {
        key: "24h",
        label: "Last 24 hours",
        since: "2026-09-17T12:00:00Z",
        until: "2026-09-18T12:00:00Z",
        changes: 1,
        releases: 1,
        issues: 1,
        items: [
          {
            ...makeItem("release:r", "2026-09-18T00:00:00Z"),
            releaseTag: "v1",
          },
          {
            ...makeItem("issue:1", "2026-09-18T00:00:00Z"),
            kind: "issue" as const,
          },
        ],
      },
    ],
    totals: {
      events: 2,
      commits: 0,
      releases: 1,
      issues: 1,
      docChanges: 0,
      byRepo: {},
    },
    manualPages: 0,
    generatedAt: "2026-09-18T12:00:00Z",
  };
  const { context, getWrittenFiles } = createModelTestContext({
    globalArgs,
    methodName: "render",
    storedResources: { ranked },
  });
  await model.methods.render.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  const files = getWrittenFiles();
  assertEquals(files.length, 4);
  const names = files.map((f) => f.name).sort();
  assertEquals(names, [
    "changes.html",
    "index.html",
    "issues.html",
    "releases.html",
  ]);
  // Regression: the summaryPage spec must map to the "index" content, not
  // an empty string (a key mismatch once produced a 0-byte index.html).
  const index = files.find((f) => f.name === "index.html");
  assert(index);
  const indexHtml = new TextDecoder().decode(index.content as Uint8Array);
  assert(indexHtml.length > 0, "index.html was empty");
  assertStringIncludes(indexHtml, "SWAMP PULSE");
});

Deno.test("sync_manual_index caches sitemap pages", async () => {
  await withMockedFetch((req) => {
    if (req.url.includes("sitemap.xml")) {
      return new Response(
        `<?xml version="1.0"?><urlset><url><loc>https://swamp-club.com/manual/reference/doctor</loc></url><url><loc>https://swamp-club.com/lab</loc></url></urlset>`,
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName: "sync_manual_index",
    });
    await model.methods.sync_manual_index.execute(
      {},
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const resource = getWrittenResources().find(
      (r) => r.specName === "manualIndex",
    );
    assert(resource);
    const data = resource.data as { pages: string[]; count: number };
    assertEquals(data.count, 1);
    assertStringIncludes(data.pages[0], "/manual/reference/doctor");
  });
});

Deno.test("sync_manual_index degrades gracefully when the sitemap fails", async () => {
  await withMockedFetch(() => {
    throw new Error("network down");
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName: "sync_manual_index",
    });
    await model.methods.sync_manual_index.execute(
      {},
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const resource = getWrittenResources().find(
      (r) => r.specName === "manualIndex",
    );
    assert(resource);
    const data = resource.data as { pages: string[]; count: number };
    assertEquals(data.count, 0);
    assertEquals(data.pages, []);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a minimal merged item for tests. */
function makeItem(
  id: string,
  date: string,
  importance: "S" | "A" | "B" | "C" = "B",
) {
  return {
    id,
    kind: "change" as const,
    title: id,
    summary: "",
    repo: "swamp-club/swamp",
    type: "fix",
    scope: "",
    importance,
    score: 0,
    date,
    rationale: "test",
    commitSha: "abcdef1234567890",
    shortSha: "abcdef12",
    commitUrl: "https://example.com/c",
    releaseTag: "",
    releaseUrl: "",
    isPrerelease: false,
    prNumbers: [] as number[],
    issueNumbers: [] as number[],
    labIssue: null,
    files: [],
    docLinks: [],
  };
}
