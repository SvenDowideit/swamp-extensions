import { assertEquals } from "jsr:@std/assert@1";

import { report } from "./synology_disk_usage_report.ts";
import type { AuditOutput } from "./synology_disk_usage.ts";

const sample: AuditOutput = {
  host: "admin@diskstation",
  scannedAt: "2026-10-25T00:00:00.000Z",
  mode: "files",
  useSudo: true,
  oneFilesystem: false,
  totalBytes: 1000,
  totalFiles: 10,
  totalDirs: 0,
  truncated: false,
  durationMs: 2000,
  usedBytes: 2000,
  unaccountedBytes: 1000,
  coverageFraction: 0.5,
  volumes: [{
    path: "/volume1",
    filesystem: "/dev/mapper/vg1",
    totalBytes: 4000,
    usedBytes: 2000,
    availableBytes: 2000,
    usedFraction: 0.5,
    shares: [],
  }],
  categories: [{
    category: "docker",
    label: "Docker images & containers",
    totalBytes: 600,
    fileCount: 6,
    fraction: 0.6,
    samplePaths: ["/volume1/@docker/overlay2/x"],
  }, {
    category: "user-files",
    label: "User files",
    totalBytes: 400,
    fileCount: 4,
    fraction: 0.4,
    samplePaths: ["/volume1/homes/alice"],
  }],
  shares: [{
    volume: "/volume1",
    path: "/volume1/@docker",
    name: "@docker",
    category: "docker",
    bytes: 600,
    fileCount: 6,
  }],
  unscannedShares: [{
    path: "/volume1/homes",
    name: "homes",
  }],
  notableDirs: [{
    path: "/volume1/@docker",
    bytes: 500,
    category: "docker",
  }],
  notableFiles: [{
    path: "/volume1/@docker/overlay2/big",
    bytes: 500,
    category: "docker",
  }],
  findings: [{
    kind: "category",
    title: "Docker images & containers: 600 B (60%)",
    category: "docker",
    totalBytes: 600,
    count: 6,
    samplePaths: ["/volume1/@docker/overlay2/x"],
    notable: true,
  }],
  errors: [],
};

function mockContext(payload: AuditOutput) {
  return {
    scope: "method" as const,
    modelType: "@svendowideit/synology-disk-usage",
    modelId: "test",
    methodName: "audit",
    executionStatus: "succeeded" as const,
    dataHandles: [{ name: "audit", specName: "audit", kind: "resource" }],
    dataRepository: {
      getContent: () =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify(payload))),
    },
    logger: { info: () => {} },
  };
}

Deno.test("report exposes the expected name", () => {
  assertEquals(report.name, "@svendowideit/synology-disk-report");
});

Deno.test("report includes capacity, categories, shares, and findings", async () => {
  const result = await report.execute(mockContext(sample));
  const markdown = result.markdown;
  assertEquals(
    markdown.includes("# Synology Disk Usage: admin@diskstation"),
    true,
  );
  assertEquals(markdown.includes("## Capacity"), true);
  assertEquals(markdown.includes("## By category"), true);
  assertEquals(markdown.includes("## Largest shares"), true);
  assertEquals(markdown.includes("## Findings"), true);
  assertEquals(markdown.includes("## Largest directories"), true);
  assertEquals(markdown.includes("## Largest files"), true);
  assertEquals(markdown.includes("Docker images & containers"), true);
  assertEquals(markdown.includes("600 B"), true);
  assertEquals(markdown.includes("Scan incomplete"), true);
  assertEquals(markdown.includes("Btrfs snapshots"), true);
  assertEquals(markdown.includes("Re-run with `useSudo=true`"), false);
  assertEquals(markdown.includes("## Shares with no readable files"), true);
  assertEquals(markdown.includes("/volume1/homes"), true);
});

Deno.test("report notes a truncated scan", async () => {
  const result = await report.execute(
    mockContext({ ...sample, truncated: true }),
  );
  assertEquals(result.markdown.includes("stopped early"), true);
});
