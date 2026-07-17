import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@1";

import { auditDisk, humanSize } from "./disk_auditor.ts";

async function makeTree(
  root: string,
  spec: Record<string, string | number>,
): Promise<void> {
  for (const [relPath, value] of Object.entries(spec)) {
    const full = join(root, relPath);
    if (typeof value === "number") {
      await Deno.mkdir(full, { recursive: true });
    } else {
      await Deno.mkdir(dirname(full), { recursive: true });
      await Deno.writeTextFile(full, value);
    }
  }
}

Deno.test("auditDisk reports total bytes across files", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "a.txt": "aaa",
      "b/big.log": "x".repeat(1000),
      "b/empty.txt": "",
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1024 * 1024,
    });
    assertEquals(result.totalBytes, 1000 + 3);
    assertEquals(result.totalFiles, 3);
    assertEquals(result.totalDirs, 1); // b/ (root not counted)
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk classifies video files into video category", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "movies/movie1.mp4": "x".repeat(5000),
      "movies/movie2.mkv": "y".repeat(3000),
      "other.txt": "z",
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    const videoCat = result.categories.find((c) => c.category === "video");
    assertExists(videoCat);
    assertEquals(videoCat.totalBytes, 8000);
    assertEquals(videoCat.fileCount, 2);
    // Should have a video category finding
    const videoFinding = result.findings.find((f) => f.category === "video");
    assertExists(videoFinding);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk combines audiobooks and ebooks into books finding", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "audiobooks/book1.m4b": "x".repeat(5000),
      "audiobooks/book2.m4b": "y".repeat(3000),
      "ebooks/novel.epub": "z".repeat(2000),
      "ebooks/text.pdf": "w".repeat(1000),
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    const audiobookCat = result.categories.find((c) => c.category === "audiobook");
    assertExists(audiobookCat);
    assertEquals(audiobookCat.totalBytes, 8000);

    const ebookCat = result.categories.find((c) => c.category === "ebook");
    assertExists(ebookCat);
    assertEquals(ebookCat.totalBytes, 3000);

    // Combined books finding
    const booksFinding = result.findings.find((f) => f.kind === "books-combined");
    assertExists(booksFinding);
    assertEquals(booksFinding.count, 4);
    assertEquals(booksFinding.totalBytes, 11000);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk detects docker directories by name", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "docker/overlay2/layer1.bin": "x".repeat(5000),
      "docker/containers/abc.log": "y".repeat(1000),
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    // The docker/ dir should be notable with docker dominant category
    const dockerDir = result.notableDirs.find((d) => d.name === "docker");
    assertExists(dockerDir);
    assertEquals(dockerDir.dominantCategory, "docker");
    // Docker finding should exist
    const dockerFinding = result.findings.find((f) => f.kind === "docker");
    assertExists(dockerFinding);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk detects large parquet files specifically", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "data/big.parquet": "x".repeat(10000),
      "data/small.csv": "y".repeat(100),
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    const parquetFinding = result.findings.find((f) => f.kind === "parquet");
    assertExists(parquetFinding);
    assertEquals(parquetFinding.count, 1);
    assertEquals(parquetFinding.totalBytes, 10000);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk detects node_modules directories", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "project/node_modules/pkg/index.js": "x".repeat(5000),
      "project/node_modules/pkg2/lib.js": "y".repeat(3000),
      "project/src/app.ts": "z".repeat(100),
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    const nmFinding = result.findings.find((f) => f.kind === "node_modules");
    assertExists(nmFinding);
    assertEquals(nmFinding.count, 1);
    assertEquals(nmFinding.totalBytes, 8000);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk notableDirs includes dirs at any depth with dominant category", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "a/b/c/deep_videos/x.mp4": "x".repeat(5000),
      "a/b/c/deep_videos/y.mkv": "y".repeat(3000),
      "a/b/other.txt": "z",
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    // deep_videos dir should be notable with video dominant category
    const deepDir = result.notableDirs.find((d) => d.name === "deep_videos");
    assertExists(deepDir);
    assertEquals(deepDir.dominantCategory, "video");
    assertEquals(deepDir.depth, 3);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk excludePatterns skips matching directories", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "keep/a.txt": "hello",
      "node_modules/pkg/index.js": "console.log(1)",
      "node_modules/large.dat": "z".repeat(9000),
    });
    const result = await auditDisk({
      root: tmp,
      excludePatterns: ["node_modules"],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    assertEquals(result.totalBytes, 5); // only keep/a.txt
    assertEquals(result.totalDirs, 1); // keep/
    const foundExcluded = result.notableDirs.find((d) =>
      d.name === "node_modules"
    );
    assertEquals(foundExcluded, undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk errors on missing root are reported not thrown", async () => {
  const result = await auditDisk({
    root: "/definitely/does/not/exist/xyz123",
    excludePatterns: [],
    followSymlinks: false,
    minNotableBytes: 1,
  });
  assertEquals(result.errors.length, 1);
  assertEquals(result.totalBytes, 0);
  assertEquals(result.notableDirs.length, 0);
});

Deno.test("auditDisk on a file path reports single file", async () => {
  const tmp = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmp, "x".repeat(42));
    const result = await auditDisk({
      root: tmp,
      excludePatterns: [],
      followSymlinks: false,
      minNotableBytes: 1,
    });
    assertEquals(result.totalFiles, 1);
    assertEquals(result.totalBytes, 42);
    assertEquals(result.notableDirs.length, 0);
    assertEquals(result.notableFiles.length, 1);
    assertEquals(result.notableFiles[0].bytes, 42);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("humanSize formats bytes with binary suffixes", () => {
  assertEquals(humanSize(0), "0 B");
  assertEquals(humanSize(512), "512 B");
  assertEquals(humanSize(1024), "1.0 KiB");
  assertEquals(humanSize(1536), "1.5 KiB");
  assertEquals(humanSize(1048576), "1.0 MiB");
  assertEquals(humanSize(1073741824), "1.0 GiB");
  assertEquals(humanSize(1099511627776), "1.0 TiB");
  assertEquals(humanSize(1024 * 1024 * 1024 * 42 + 512 * 1024 * 1024), "42.5 GiB");
});

Deno.test("humanSize handles negative as zero", () => {
  assertEquals(humanSize(-1), "0 B");
});