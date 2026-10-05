import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  countAcceptanceTests,
  discover,
  extractReviewWarnings,
  mapLimit,
  metaFromAttributes,
  parseRegistryInfo,
  resolveDenoPath,
  type RunFn,
} from "./release_train.ts";

/** A stub runner keyed on the first two argv words. */
function stubRun(
  responses: Record<string, { code?: number; stdout?: string }>,
): RunFn {
  return (bin, args) => {
    const key = `${bin} ${args.slice(0, 2).join(" ")}`;
    const r = responses[key];
    return Promise.resolve({
      code: r?.code ?? 128,
      stdout: r?.stdout ?? "",
      stderr: "",
      timedOut: false,
    });
  };
}

Deno.test("countAcceptanceTests counts tests: name entries only", () => {
  const yaml =
    `networks: {}\n\ntests:\n  - name: one\n    steps: []\n  - name: two\n    steps: []\n\nharness: {}\n`;
  assertEquals(countAcceptanceTests(yaml), 2);
  assertEquals(countAcceptanceTests("tests: []\n"), 0);
  assertEquals(countAcceptanceTests("models: [a]\n"), 0);
});

Deno.test("discover uses git ls-files and excludes .swamp", async () => {
  const runFn = stubRun({
    "git ls-files": {
      code: 0,
      stdout: [
        "extensions/models/caddy/manifest.yaml",
        "extensions/models/caddy/caddy.ts",
        ".swamp/pulled-extensions/@a/b/manifest.yaml",
        "extensions/workflows/news/manifest.yaml",
      ].join("\n"),
    },
  });
  const found = await discover("extensions", "/repo", runFn);
  assertEquals(found.map((d) => d.rel), [
    "extensions/models/caddy/manifest.yaml",
    "extensions/workflows/news/manifest.yaml",
  ]);
  assertEquals(found[0].dir, "extensions/models/caddy");
});

Deno.test("extractReviewWarnings parses push dry-run JSON", () => {
  const out = JSON.stringify({
    reviewRuleWarnings: [{
      ruleId: "adversarial-review-report",
      file: "/tmp/swamp-extension-review/_a_b-cafe.json",
      message: "No adversarial review recorded",
    }],
  });
  const r = extractReviewWarnings(out);
  assertEquals(r.state, "missing");
  assertStringIncludes(r.path, "_a_b-cafe.json");
  assertEquals(extractReviewWarnings("not json").state, "unknown");
});

Deno.test("metaFromAttributes reads score, coverage and staleness", () => {
  const meta = metaFromAttributes({
    manifest: "extensions/models/caddy/manifest.yaml",
    score: 92,
    grade: "A",
    version: "2026.10.05.2",
    codeMetrics: {
      coverage: 0.74,
      functionCoverage: 0.8,
      coverageAvailable: true,
    },
    testCoverage: {
      testCount: 3,
      documentedCommands: ["a", "b", "c", "d"],
      documentedCovered: ["a", "b"],
      surface: {
        methods: ["x", "y"],
        methodsCovered: ["x"],
        workflows: ["w"],
        workflowsCovered: [],
      },
    },
  }, "2026.10.05.2");
  assertEquals(meta.docsScore, 92);
  assertEquals(meta.coverage, 0.74);
  assertEquals(meta.acceptanceCount, 3);
  assertEquals(meta.coveredCommands, 2);
  assertEquals(meta.documentedCommands, 4);
  assertEquals(meta.methodsCovered, 1);
  assertEquals(meta.methods, 2);
  assertEquals(meta.workflowsCovered, 0);
  assertEquals(meta.workflows, 1);
  assertEquals(meta.dataStale, false);

  const stale = metaFromAttributes({ score: 90, version: "old" }, "new");
  assertEquals(stale.dataStale, true);
});

Deno.test("mapLimit preserves order and caps concurrency", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assertEquals(out, [2, 4, 6, 8, 10]);
  assert(peak <= 2, `peak concurrency ${peak} exceeded 2`);
});

Deno.test("resolveDenoPath reads doctor output then falls back", async () => {
  const withPath = stubRun({
    "swamp doctor extensions": {
      code: 0,
      stdout: JSON.stringify({ denoPath: "/opt/deno" }),
    },
  });
  const a = await resolveDenoPath(withPath);
  assertEquals(a, "/opt/deno");

  const empty = stubRun({ "swamp doctor extensions": { code: 1, stdout: "" } });
  const b = await resolveDenoPath(empty);
  assertStringIncludes(b, ".swamp/deno/deno");
});

Deno.test("parseRegistryInfo reads the three channels", () => {
  const r = parseRegistryInfo(JSON.stringify({
    latestVersion: "2026.09.23.2",
    latestRc: null,
    latestBeta: "2026.09.22.1",
  }));
  assertEquals(r.known, true);
  assertEquals(r.published.stable, "2026.09.23.2");
  assertEquals(r.published.beta, "2026.09.22.1");
  assertEquals(r.published.rc, "");
});

Deno.test("parseRegistryInfo treats 'not found' as a known empty answer", () => {
  const r = parseRegistryInfo(
    JSON.stringify({ error: "Extension @a/b not found in the registry." }),
  );
  assertEquals(r.known, true);
  assertEquals(r.published, { stable: "", rc: "", beta: "" });
});

Deno.test("parseRegistryInfo treats other errors and bad JSON as unknown", () => {
  assertEquals(
    parseRegistryInfo(JSON.stringify({ error: "rate limited" })).known,
    false,
  );
  assertEquals(parseRegistryInfo("not json").known, false);
});
