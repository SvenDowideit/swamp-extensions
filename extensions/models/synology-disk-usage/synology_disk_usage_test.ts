import { assertEquals, assertExists } from "jsr:@std/assert@1";

import {
  buildDirNodes,
  buildDuCommand,
  buildDuPathsCommand,
  buildFindCommand,
  buildFindings,
  buildTreeCommand,
  categoryLabels,
  type CategoryRollup,
  classifyPath,
  DEFAULT_CATEGORY_RULES,
  deriveShare,
  fileExtension,
  formatSudoRemediation,
  humanSize,
  model,
  parseDiscoveryOutput,
  parseDsmVersion,
  parseDuLine,
  parseFileRecord,
  resolveConfig,
  type ShareInfo,
  shellQuote,
  summarizeStderr,
  type VolumeInfo,
  withSudo,
} from "./synology_disk_usage.ts";

Deno.test("model exposes the expected type and methods", () => {
  assertEquals(model.type, "@svendowideit/synology-disk-usage");
  assertEquals(Object.keys(model.methods).sort(), [
    "audit",
    "discover",
    "setup",
  ]);
  assertEquals(model.reports, ["@svendowideit/synology-disk-report"]);
});

Deno.test("default rules classify Synology paths", () => {
  const cases: Array<[string, string]> = [
    ["/volume1/@docker/overlay2/abc", "docker"],
    ["/volume1/docker/volumes/pg/_data", "docker"],
    ["/volume1/docker/compose.yml", "docker"],
    ["/volume1/@MailPlus-Server/foo.eml", "synology-app-data"],
    ["/volume1/@rspamd.core", "synology-app-data"],
    ["/volume1/MailPlus/mailbox", "synology-app-data"],
    ["/volume1/surveillance/recording", "synology-app-data"],
    ["/volume1/homes/alice/Google Drive/foo.pdf", "google-drive"],
    ["/volume1/homes/alice/GoogleDrive/foo.pdf", "google-drive"],
    ["/volume1/homes/alice/Google Photos/2024/a.jpg", "google-photos"],
    ["/volume1/Backups/nightly.tar", "backups"],
    ["/volume1/MyBackups/nightly.tar", "backups"],
    ["/volume1/homes/alice/notes.txt", "user-files"],
    ["/volume1/homes/alice/Photos/2024/a.jpg", "media"],
    ["/volume1/homes/alice/Music/a.mp3", "media"],
    ["/volume1/#recycle/foo.bin", "recycle-bin"],
    ["/volume1/@vmm/vm1/disk.img", "virtual-machines"],
    ["/volume1/@appstore/foo", "synology-app-data"],
    ["/volume1/@eaDir/foo.jpg", "synology-app-data"],
    ["/volume1/Media/Movies/a.mkv", "media"],
    ["/volume1/random/photo.jpg", "image"],
    ["/volume1/random/data.db", "database"],
    ["/volume1/random/archive.tar.gz", "archive"],
    ["/volume1/random/file.bin", "other"],
    ["/volume1/Documents/backup.tar", "archive"],
  ];
  for (const [path, expected] of cases) {
    assertEquals(classifyPath(path, DEFAULT_CATEGORY_RULES), expected, path);
  }
});

Deno.test("custom rules replace the defaults and are matched first", () => {
  const rules = [
    {
      id: "family-videos",
      label: "Family videos",
      patterns: ["(^|/)FamilyVideos(/|$)"],
    },
  ];
  assertEquals(
    classifyPath("/volume1/FamilyVideos/2024.mp4", rules),
    "family-videos",
  );
  assertEquals(
    classifyPath("/volume1/homes/alice/notes.txt", rules),
    "document",
  );
});

Deno.test("invalid custom regex reports the category", () => {
  let message = "";
  try {
    classifyPath("/volume1/x", [
      { id: "bad", label: "Bad", patterns: ["("] },
    ]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertEquals(message.includes('category "bad"'), true);
});

Deno.test("category labels include rules and content fallbacks", () => {
  const labels = categoryLabels([
    { id: "custom", label: "Custom", patterns: ["x"] },
  ]);
  assertEquals(labels.get("custom"), "Custom");
  assertEquals(labels.get("video"), "Videos");
  assertEquals(labels.get("other"), "Other");
});

Deno.test("fileExtension handles compound archives", () => {
  assertEquals(fileExtension("/a/b/archive.tar.gz"), "tar.gz");
  assertEquals(fileExtension("/a/b/photo.HEIC"), "heic");
  assertEquals(fileExtension("/a/b/noext"), "");
});

Deno.test("humanSize formats binary units", () => {
  assertEquals(humanSize(0), "0 B");
  assertEquals(humanSize(1024), "1.0 KiB");
  assertEquals(humanSize(1024 * 1024 * 1024), "1.0 GiB");
});

Deno.test("shellQuote escapes single quotes", () => {
  assertEquals(shellQuote("/volume1"), "'/volume1'");
  assertEquals(shellQuote("/a b"), "'/a b'");
  assertEquals(shellQuote("/it's"), "'/it'\\''s'");
});

Deno.test("deriveShare finds the top-level share", () => {
  assertEquals(
    deriveShare("/volume1/homes/alice/x", ["/volume1", "/volume2"]),
    {
      volume: "/volume1",
      path: "/volume1/homes",
      name: "homes",
    },
  );
  assertEquals(deriveShare("/volume2/Backups/a", ["/volume1", "/volume2"]), {
    volume: "/volume2",
    path: "/volume2/Backups",
    name: "Backups",
  });
  assertEquals(deriveShare("/volume1", ["/volume1"]), {
    volume: "/volume1",
    path: "/volume1",
    name: "volume1",
  });
  assertEquals(deriveShare("/other/a/b", ["/volume1"]), {
    volume: "",
    path: "/other/a",
    name: "a",
  });
});

Deno.test("parseDiscoveryOutput parses volumes, capacity, and shares", () => {
  const text = [
    "MODEL\tDS920+",
    'DSM\tproductversion="7.2.2" buildnumber="72806"',
    "VOLUME\t/volume1",
    "CAPACITY\t/dev/mapper/vg1-volume_1\t1000\t800\t200",
    "SHARE\t/volume1/homes",
    "SHARE\t/volume1/@docker",
    "VOLUME\t/volume2",
    "CAPACITY\t/dev/mapper/vg2-volume_2\t2000\t500\t1500",
    "SHARE\t/volume2/Backups",
  ].join("\n");
  const result = parseDiscoveryOutput(text);
  assertEquals(result.systemModel, "DS920+");
  assertEquals(result.dsmVersion, "7.2.2-72806");
  assertEquals(result.volumes.length, 2);
  assertEquals(result.volumes[0].path, "/volume1");
  assertEquals(result.volumes[0].totalBytes, 1000 * 1024);
  assertEquals(result.volumes[0].usedBytes, 800 * 1024);
  assertEquals(result.volumes[0].availableBytes, 200 * 1024);
  assertEquals(result.volumes[0].usedFraction, 0.8);
  assertEquals(result.volumes[0].shares.map((s) => s.name), [
    "homes",
    "@docker",
  ]);
  assertEquals(result.volumes[1].shares[0].name, "Backups");
});

Deno.test("parseDsmVersion extracts product and build", () => {
  assertEquals(
    parseDsmVersion('productversion="7.2.2" buildnumber="72806"'),
    "7.2.2-72806",
  );
  assertEquals(parseDsmVersion(""), "");
});

Deno.test("summarizeStderr counts permission-denied paths", () => {
  const message = summarizeStderr(
    "find: '/volume1/homes': Permission denied\nfind: '/volume1/photo': Permission denied\n",
  );
  assertEquals(message.includes("2 permission-denied path(s)"), true);
  assertEquals(message.includes("/volume1/homes"), true);
  assertEquals(summarizeStderr(""), "");
});

Deno.test("parseDuLine handles tab and space separators", () => {
  assertEquals(parseDuLine("1024\t/volume1/homes"), {
    bytes: 1024 * 1024,
    path: "/volume1/homes",
  });
  assertEquals(parseDuLine("2048 /volume1/@docker"), {
    bytes: 2048 * 1024,
    path: "/volume1/@docker",
  });
  assertEquals(parseDuLine(""), null);
});

Deno.test("parseFileRecord parses size and path", () => {
  assertEquals(parseFileRecord("123\t/volume1/a.txt"), {
    bytes: 123,
    path: "/volume1/a.txt",
  });
  assertEquals(parseFileRecord("not-a-record"), null);
  assertEquals(parseFileRecord("\t/volume1/a.txt"), null);
});

Deno.test("resolveConfig merges overrides, globals, and saved config", () => {
  const global = {
    host: "global-host",
    sshUser: "global-user",
    identityFile: "",
    sshPort: undefined,
    volumes: ["/volume1"],
    categories: [],
    excludePatterns: ["/@eaDir/"],
    minNotableBytes: 1024,
    maxFiles: 10,
    timeoutMs: 0,
    useSudo: true,
    oneFilesystem: false,
    treeDepth: 3,
  };
  const stored = {
    host: "stored-host",
    sshUser: "stored-user",
    identityFile: "~/.ssh/nas",
    sshPort: 2222,
    volumes: ["/volume9"],
  };
  const resolved = resolveConfig(global, stored, {
    host: "override-host",
    volumes: ["/volume2"],
    useSudo: false,
    categories: [{ id: "custom", label: "Custom", patterns: ["x"] }],
    excludePatterns: [],
    minNotableBytes: 4096,
    maxFiles: 5,
    timeoutMs: 1000,
    oneFilesystem: true,
    treeDepth: 4,
  });
  assertEquals(resolved.host, "override-host");
  assertEquals(resolved.sshUser, "global-user");
  assertEquals(resolved.identityFile, "~/.ssh/nas");
  assertEquals(resolved.sshPort, 2222);
  assertEquals(resolved.volumes, ["/volume2"]);
  assertEquals(resolved.categories.length, 1);
  assertEquals(resolved.categories[0].id, "custom");
  assertEquals(resolved.excludePatterns, []);
  assertEquals(resolved.minNotableBytes, 4096);
  assertEquals(resolved.maxFiles, 5);
  assertEquals(resolved.timeoutMs, 1000);
  assertEquals(resolved.useSudo, false);
  assertEquals(resolved.oneFilesystem, true);
  assertEquals(resolved.treeDepth, 4);
});

Deno.test("resolveConfig falls back to the default category rules", () => {
  const global = {
    host: "global-host",
    sshUser: "",
    identityFile: "",
    sshPort: undefined,
    volumes: [],
    categories: [],
    excludePatterns: [],
    minNotableBytes: 1024,
    maxFiles: 0,
    timeoutMs: 0,
    useSudo: false,
    oneFilesystem: false,
    treeDepth: 3,
  };
  const resolved = resolveConfig(global, null);
  assertEquals(resolved.categories.length, DEFAULT_CATEGORY_RULES.length);
});

Deno.test("withSudo prefixes find/du directly without a shell", () => {
  assertEquals(
    withSudo("LC_ALL=C du -sk /volume1", false),
    "LC_ALL=C du -sk /volume1",
  );
  assertEquals(
    withSudo("LC_ALL=C du -sk /volume1", true),
    "LC_ALL=C sudo -n du -sk /volume1",
  );
  assertEquals(
    withSudo("LC_ALL=C find /volume1 -type f", true),
    "LC_ALL=C sudo -n find /volume1 -type f",
  );
});

Deno.test("buildDuPathsCommand uses explicit quoted share paths", () => {
  assertEquals(
    buildDuPathsCommand(["/volume1/Backups", "/volume1/My Files"]),
    "LC_ALL=C du -sk '/volume1/Backups' '/volume1/My Files'",
  );
});

Deno.test("formatSudoRemediation prints an exact copy-pasteable fix", () => {
  const message = formatSudoRemediation(
    "sven@private",
    "sven",
    "/usr/bin/find",
    "/usr/bin/du",
  );
  assertEquals(
    message.includes(
      "sven ALL=(ALL) NOPASSWD: /usr/bin/find, /usr/bin/du",
    ),
    true,
  );
  assertEquals(
    message.includes(
      "echo 'sven ALL=(ALL) NOPASSWD: /usr/bin/find, /usr/bin/du' | sudo tee /etc/sudoers.d/swamp-synology-disk-usage",
    ),
    true,
  );
  assertEquals(message.includes("ssh -t sven@private"), true);
  assertEquals(
    message.includes("sudo -n /usr/bin/find /dev/null -print"),
    true,
  );
  assertEquals(message.includes("sudo -n /usr/bin/du -sk /dev/null"), true);
  assertEquals(message.includes("sudo-ok"), true);
  assertEquals(message.includes("sudo visudo"), false);
});

Deno.test("buildFindCommand and buildDuCommand quote volumes", () => {
  const find = buildFindCommand(["/volume1", "/volume 2"]);
  assertEquals(find.includes("find '/volume1' '/volume 2'"), true);
  assertEquals(find.includes("-printf '%s\\t%p\\0'"), true);
  assertEquals(find.includes("-xdev"), false);
  const oneFilesystem = buildFindCommand(["/volume1"], true);
  assertEquals(oneFilesystem.includes("-xdev -type f"), true);
  const du = buildDuCommand(["/volume1"]);
  assertEquals(du.includes("du -sk '/volume1'/* '/volume1'/.[!.]*"), true);
});

Deno.test("buildTreeCommand builds a du -d tree scan", () => {
  assertEquals(
    buildTreeCommand(["/volume1"], 3),
    "LC_ALL=C du -k -d 3 '/volume1'",
  );
  assertEquals(
    buildTreeCommand(["/volume1", "/volume2"], 2, true),
    "LC_ALL=C du -k -x -d 2 '/volume1' '/volume2'",
  );
});

Deno.test("buildDirNodes subtracts child cumulative sizes", () => {
  const nodes = buildDirNodes([
    { path: "/volume1", bytes: 1000 },
    { path: "/volume1/homes", bytes: 600 },
    { path: "/volume1/homes/alice", bytes: 400 },
    { path: "/volume1/photo", bytes: 300 },
  ]);
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  assertEquals(byPath.get("/volume1")?.ownBytes, 100);
  assertEquals(byPath.get("/volume1/homes")?.ownBytes, 200);
  assertEquals(byPath.get("/volume1/homes/alice")?.ownBytes, 400);
  assertEquals(byPath.get("/volume1/photo")?.ownBytes, 300);
});

Deno.test("buildFindings calls out categories, capacity, and largest items", () => {
  const categories: CategoryRollup[] = [
    {
      category: "backups",
      label: "Backups",
      totalBytes: 400,
      fileCount: 4,
      fraction: 0.4,
      samplePaths: ["/volume1/Backups"],
    },
    {
      category: "google-drive",
      label: "Google Drive backups",
      totalBytes: 100,
      fileCount: 1,
      fraction: 0.1,
      samplePaths: ["/volume1/homes/a/Google Drive"],
    },
    {
      category: "google-photos",
      label: "Google Photos backups",
      totalBytes: 50,
      fileCount: 1,
      fraction: 0.05,
      samplePaths: ["/volume1/homes/a/Google Photos"],
    },
  ];
  const volumes: VolumeInfo[] = [{
    path: "/volume1",
    filesystem: "/dev/mapper/vg1",
    totalBytes: 1000,
    usedBytes: 900,
    availableBytes: 100,
    usedFraction: 0.9,
    shares: [],
  }];
  const shares: ShareInfo[] = [{
    volume: "/volume1",
    path: "/volume1/Backups",
    name: "Backups",
    category: "backups",
    bytes: 400,
    fileCount: 4,
  }];
  const findings = buildFindings(
    categories,
    volumes,
    shares,
    [{
      path: "/volume1/Backups",
      bytes: 400,
      category: "backups",
    }],
    [{
      path: "/volume1/Backups/big.tar",
      bytes: 400,
      category: "backups",
    }],
    1000,
    10,
  );
  const kinds = findings.map((f) => f.kind);
  assertEquals(kinds.includes("category"), true);
  assertEquals(kinds.includes("google-backups"), true);
  assertEquals(kinds.includes("volume-capacity"), true);
  assertEquals(kinds.includes("largest-share"), true);
  assertEquals(kinds.includes("largest-dir"), true);
  assertEquals(kinds.includes("largest-file"), true);
  const capacity = findings.find((f) => f.kind === "volume-capacity");
  assertExists(capacity);
  assertEquals(capacity.notable, true);
});

Deno.test("buildFindings flags unreadable scan coverage", () => {
  const volume: VolumeInfo = {
    path: "/volume1",
    filesystem: "/dev/mapper/vg1",
    totalBytes: 5000,
    usedBytes: 2000,
    availableBytes: 3000,
    usedFraction: 0.4,
    shares: [],
  };
  const findings = buildFindings([], [volume], [], [], [], 1000, 1, {
    useSudo: true,
    oneFilesystem: false,
  });
  const coverage = findings.find((f) => f.kind === "scan-coverage");
  assertExists(coverage);
  assertEquals(coverage.notable, true);
  assertEquals(coverage.totalBytes, 1000);
  assertEquals(coverage.title.includes("Btrfs snapshots"), true);
  assertEquals(coverage.title.includes("useSudo=true"), false);

  const oneFs = buildFindings([], [volume], [], [], [], 1000, 1, {
    useSudo: true,
    oneFilesystem: true,
  });
  const oneFsCoverage = oneFs.find((f) => f.kind === "scan-coverage");
  assertExists(oneFsCoverage);
  assertEquals(oneFsCoverage.title.includes("oneFilesystem=false"), true);
});
