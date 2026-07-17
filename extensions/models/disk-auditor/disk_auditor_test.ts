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
      depth: 3,
      excludePatterns: [],
      followSymlinks: false,
      topDirs: 10,
      topFiles: 10,
      topExtensions: 10,
    });
    assertEquals(result.totalBytes, 1000 + 3);
    assertEquals(result.totalFiles, 3);
    assertEquals(result.totalDirs, 1); // b/ (root not counted)
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk topDirs returns largest subdirectories sorted desc", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "small/a.txt": "s",
      "big/big.bin": "y".repeat(5000),
      "mid/m.txt": "z".repeat(100),
    });
    const result = await auditDisk({
      root: tmp,
      depth: 2,
      excludePatterns: [],
      followSymlinks: false,
      topDirs: 10,
      topFiles: 10,
      topExtensions: 10,
    });
    assertEquals(result.topDirs.length, 3);
    assertEquals(result.topDirs[0].name, "big");
    assertEquals(result.topDirs[1].name, "mid");
    assertEquals(result.topDirs[2].name, "small");
    assertEquals(result.topDirs[0].bytes, 5000);
    assertEquals(result.topDirs[1].bytes, 100);
    assertEquals(result.topDirs[2].bytes, 1);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk largestFiles sorted by size", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "1.dat": "a".repeat(50),
      "2.dat": "b".repeat(300),
      "3.dat": "c".repeat(10),
    });
    const result = await auditDisk({
      root: tmp,
      depth: 1,
      excludePatterns: [],
      followSymlinks: false,
      topDirs: 10,
      topFiles: 2,
      topExtensions: 10,
    });
    assertEquals(result.largestFiles.length, 2);
    assertEquals(result.largestFiles[0].bytes, 300);
    assertEquals(result.largestFiles[1].bytes, 50);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk extensions aggregate bytes and count", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "a.log": "x".repeat(100),
      "b.log": "y".repeat(200),
      "c.bin": "z".repeat(50),
    });
    const result = await auditDisk({
      root: tmp,
      depth: 1,
      excludePatterns: [],
      followSymlinks: false,
      topDirs: 10,
      topFiles: 10,
      topExtensions: 10,
    });
    const logExt = result.extensions.find((e) => e.extension === "log");
    assertExists(logExt);
    assertEquals(logExt.totalBytes, 300);
    assertEquals(logExt.fileCount, 2);

    const binExt = result.extensions.find((e) => e.extension === "bin");
    assertExists(binExt);
    assertEquals(binExt.totalBytes, 50);
    assertEquals(binExt.fileCount, 1);
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
      depth: 5,
      excludePatterns: ["node_modules"],
      followSymlinks: false,
      topDirs: 10,
      topFiles: 10,
      topExtensions: 10,
    });
    assertEquals(result.totalBytes, 5); // only keep/a.txt
    assertEquals(result.totalDirs, 1); // keep/ (root not counted, node_modules excluded)
    const foundExcluded = result.topDirs.find((d) => d.name === "node_modules");
    assertEquals(foundExcluded, undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("auditDisk errors on missing root are reported not thrown", async () => {
  const result = await auditDisk({
    root: "/definitely/does/not/exist/xyz123",
    depth: 3,
    excludePatterns: [],
    followSymlinks: false,
    topDirs: 10,
    topFiles: 10,
    topExtensions: 10,
  });
  assertEquals(result.errors.length, 1);
  assertEquals(result.totalBytes, 0);
  assertEquals(result.topDirs.length, 0);
});

Deno.test("auditDisk on a file path reports single file", async () => {
  const tmp = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmp, "x".repeat(42));
    const result = await auditDisk({
      root: tmp,
      depth: 3,
      excludePatterns: [],
      followSymlinks: false,
      topDirs: 10,
      topFiles: 10,
      topExtensions: 10,
    });
    assertEquals(result.totalFiles, 1);
    assertEquals(result.totalBytes, 42);
    assertEquals(result.topDirs.length, 0);
    assertEquals(result.largestFiles.length, 1);
    assertEquals(result.largestFiles[0].bytes, 42);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("auditDisk depth 0 walks root's immediate children only", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeTree(tmp, {
      "top.txt": "abc",
      "sub/deep.txt": "x".repeat(9999),
    });
    const result = await auditDisk({
      root: tmp,
      depth: 0,
      excludePatterns: [],
      followSymlinks: false,
      topDirs: 10,
      topFiles: 10,
      topExtensions: 10,
    });
    // depth 0 = no subdirs listed in topDirs (walk still recurses but dirs array only
    // populated when depth > 0 at that level)
    assertEquals(result.topDirs.length, 0);
    // totalBytes still counts everything recursively
    assertEquals(result.totalBytes, 9999 + 3);
  } finally {
    await Deno.remove(tmp, { recursive: true });
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
