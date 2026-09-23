/**
 * Unit tests for the disk-auditor summary report.
 *
 * The report is exercised through its real `execute` entry point with a fake
 * context, so the handle lookup, data decoding, and markdown rendering are all
 * covered — not just the formatter.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./disk_audit_report.ts";
import type { AuditOutput } from "./disk_auditor.ts";

const OUTPUT: AuditOutput = {
  rootPath: "/home/sven",
  scannedAt: "2026-09-24T00:00:00.000Z",
  totalBytes: 2_147_483_648,
  totalFiles: 1234,
  totalDirs: 56,
  durationMs: 4200,
  categories: [
    {
      category: "video",
      label: "video",
      totalBytes: 1_073_741_824,
      fileCount: 10,
      fraction: 0.5,
    },
    {
      category: "other",
      label: "other",
      totalBytes: 1_073_741_824,
      fileCount: 1224,
      fraction: 0.5,
    },
  ],
  notableDirs: [
    {
      path: "/home/sven/media",
      name: "media",
      bytes: 1_073_741_824,
      fileCount: 10,
      dominantCategory: "video",
      depth: 1,
    },
  ],
  notableFiles: [
    {
      path: "/home/sven/media/movie.mkv",
      name: "movie.mkv",
      bytes: 1_073_741_824,
      category: "video",
    },
  ],
  findings: [
    {
      kind: "category",
      title: "Video: 10 files, 1.0 GiB (50%)",
      category: "video",
      totalBytes: 1_073_741_824,
      count: 10,
      samplePaths: ["/home/sven/media/movie.mkv"],
      notable: true,
    },
  ],
  errors: [],
};

/** Encode a value the way the data repository returns stored resource bytes. */
function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Build a fake report context, overriding only what a test needs. */
function context(over: Record<string, unknown> = {}) {
  const content = over.content as Uint8Array | null | undefined;
  return {
    scope: "method" as const,
    modelType: "@svendowideit/disk-auditor",
    modelId: "m1",
    methodName: "audit",
    executionStatus: "succeeded" as const,
    dataHandles: [{ name: "current", specName: "audit", kind: "resource" }],
    dataRepository: {
      getContent: () =>
        Promise.resolve(content === undefined ? encoded(OUTPUT) : content),
    },
    logger: { info: () => {} },
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
async function run(ctx: any) {
  return await report.execute(ctx);
}

Deno.test("report renders a summary table from audit data", async () => {
  const { markdown, json } = await run(context());
  assertStringIncludes(markdown, "# Disk Audit: /home/sven");
  assertStringIncludes(markdown, "2.0 GiB** across 1,234 files in 56 dirs");
  assertStringIncludes(markdown, "## Findings");
  assertStringIncludes(markdown, "Video: 10 files, 1.0 GiB (50%)");
  assertStringIncludes(markdown, "## By category");
  assertStringIncludes(markdown, "## Largest directories");
  assertStringIncludes(markdown, "## Largest files");
  assertEquals(json.totalBytes, 2_147_483_648);
  assertEquals(json.findings, 1);
});

Deno.test("report is silent when the method failed", async () => {
  const { markdown, json } = await run(
    context({ executionStatus: "failed", errorMessage: "boom" }),
  );
  assertEquals(markdown, "");
  assertEquals(json, {});
});

Deno.test("report is silent for a non-audit method", async () => {
  const { markdown } = await run(context({ methodName: "somethingElse" }));
  assertEquals(markdown, "");
});

Deno.test("report handles a missing audit handle", async () => {
  const { markdown } = await run(context({ dataHandles: [] }));
  assertEquals(markdown, "No audit data produced.");
});

Deno.test("report handles missing stored content", async () => {
  const { markdown } = await run(context({ content: null }));
  assertEquals(markdown, "Audit data not found.");
});

Deno.test("report degrades gracefully on corrupt stored content", async () => {
  const corrupt = new TextEncoder().encode("{not valid json");
  const { markdown, json } = await run(context({ content: corrupt }));
  assertEquals(markdown, "Audit data could not be parsed.");
  assertEquals(json, {});
});

Deno.test("report renders errors and truncates long lists", async () => {
  const many = {
    ...OUTPUT,
    notableDirs: Array.from({ length: 20 }, (_, i) => ({
      path: `/home/sven/d${i}`,
      name: `d${i}`,
      bytes: 1024,
      fileCount: 1,
      dominantCategory: null,
      depth: 1,
    })),
    notableFiles: Array.from({ length: 20 }, (_, i) => ({
      path: `/home/sven/f${i}`,
      name: `f${i}`,
      bytes: 1024,
      category: "other",
    })),
    errors: [
      { path: "/root/secret", message: "Permission denied" },
      { path: "/home/sven/broken", message: "No such file" },
    ],
  };
  const { markdown } = await run(context({ content: encoded(many) }));
  assertStringIncludes(markdown, "and 5 more");
  assertStringIncludes(markdown, "## Errors (2)");
  assertStringIncludes(markdown, "Permission denied");
});
