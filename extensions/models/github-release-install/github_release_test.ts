/**
 * Unit tests for the shared `@svendowideit/github-release-install` helpers —
 * asset-name parsing, archive-format detection, asset selection, checksum and
 * version parsing, URL derivation, platform mapping and checksum hashing.
 *
 * @module
 */
import { assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import {
  apiUrlForVersion,
  compareVersions,
  compileAssetPattern,
  DEFAULT_ASSET_PATTERN,
  detectArchiveType,
  expandHome,
  mapAssets,
  mapUnameArch,
  mapUnameOs,
  normalizeVersion,
  parseAssetName,
  parseChecksums,
  releasesApiUrl,
  resolveApiUrl,
  selectAsset,
  sha256Hex,
  verifySha256,
  versionsEqual,
} from "./github_release.ts";

Deno.test("normalizeVersion strips a leading v and whitespace", () => {
  assertEquals(normalizeVersion("v0.8.0"), "0.8.0");
  assertEquals(normalizeVersion("0.8.0"), "0.8.0");
  assertEquals(normalizeVersion(" v0.8.0 "), "0.8.0");
});

Deno.test("parseAssetName parses the default GoReleaser shape", () => {
  assertEquals(
    parseAssetName("tuios_0.8.0_Linux_x86_64.tar.gz"),
    {
      stem: "tuios",
      version: "0.8.0",
      os: "Linux",
      arch: "x86_64",
      ext: "tar.gz",
    },
  );
  assertEquals(
    parseAssetName("tuios-ghostty_0.8.0_Linux_arm64.tar.gz"),
    {
      stem: "tuios-ghostty",
      version: "0.8.0",
      os: "Linux",
      arch: "arm64",
      ext: "tar.gz",
    },
  );
  // A bare binary (no extension) is still an archive candidate.
  assertEquals(
    parseAssetName("deno_2.7.5_Darwin_arm64"),
    { stem: "deno", version: "2.7.5", os: "Darwin", arch: "arm64", ext: "" },
  );
});

Deno.test("parseAssetName rejects non-archive assets", () => {
  assertEquals(parseAssetName("checksums.txt"), null);
  assertEquals(parseAssetName("tuios_0.8.0_Linux_x86_64.zip.sig"), null);
});

Deno.test("compileAssetPattern requires version/os/arch groups", () => {
  assertThrows(() => compileAssetPattern("^foo$"), Error, "named group");
  assertThrows(() => compileAssetPattern("("), Error, "valid regular");
});

Deno.test("detectArchiveType derives from the name or honours an override", () => {
  assertEquals(detectArchiveType("x.tar.gz"), "tar.gz");
  assertEquals(detectArchiveType("x.tgz"), "tar.gz");
  assertEquals(detectArchiveType("x.gz"), "tar.gz");
  assertEquals(detectArchiveType("x.zip"), "zip");
  assertEquals(detectArchiveType("tuios_0.8.0_Linux_x86_64"), "raw");
  assertEquals(detectArchiveType("x.zip", "raw"), "raw");
});

Deno.test("selectAsset filters by os, arch and stem", () => {
  const assets = mapAssets([
    { name: "tuios_0.8.0_Linux_x86_64.tar.gz", browser_download_url: "u1" },
    { name: "tuios_0.8.0_Linux_arm64.tar.gz", browser_download_url: "u2" },
    {
      name: "tuios-ghostty_0.8.0_Linux_arm64.tar.gz",
      browser_download_url: "u3",
    },
    { name: "checksums.txt", browser_download_url: "u4" },
  ]);
  assertEquals(
    selectAsset(assets, { os: "Linux", arch: "x86_64", stem: "tuios" })?.name,
    "tuios_0.8.0_Linux_x86_64.tar.gz",
  );
  assertEquals(
    selectAsset(assets, { os: "Linux", arch: "arm64", stem: "tuios-ghostty" })
      ?.name,
    "tuios-ghostty_0.8.0_Linux_arm64.tar.gz",
  );
  assertEquals(selectAsset(assets, { os: "Darwin", arch: "arm64" }), null);
  // An exact asset name wins outright.
  assertEquals(
    selectAsset(assets, { assetName: "checksums.txt" })?.name,
    "checksums.txt",
  );
});

Deno.test("mapAssets keeps non-archive assets but parses archive versions", () => {
  const assets = mapAssets([
    {
      name: "tuios_0.8.0_Linux_x86_64.tar.gz",
      browser_download_url: "u",
      size: 10,
    },
    { name: "checksums.txt", browser_download_url: "s" },
  ]);
  assertEquals(assets.length, 2);
  assertEquals(assets[0].version, "0.8.0");
  assertEquals(assets[1].version, undefined);
  assertEquals(assets[0].size, 10);
});

Deno.test("selectAsset accepts a custom pattern", () => {
  const pattern =
    "^(?<stem>.+)-(?<version>\\d+\\.\\d+\\.\\d+)-(?<os>linux|darwin)-(?<arch>amd64|arm64)(?<ext>)?$";
  const assets = mapAssets(
    [{ name: "tool-1.2.3-linux-amd64", browser_download_url: "u" }],
    pattern,
  );
  assertEquals(assets[0].version, "1.2.3");
  assertEquals(
    selectAsset(assets, { pattern, os: "linux", arch: "amd64" })?.name,
    "tool-1.2.3-linux-amd64",
  );
  assertEquals(
    parseAssetName("tool-1.2.3-linux-amd64", pattern)?.arch,
    "amd64",
  );
});

Deno.test("parseChecksums parses sha256sum lines", () => {
  const text = [
    "2c36131563249e9b4df217551f83781d630abba53dc4b570496e1eab7be4ce8c  tuios-ghostty_0.8.0_Linux_arm64.tar.gz",
    "",
    "18cb546f90f4efed0508c696ede0ee2ed6626a6000ddf2e2ae85d6f99600377e *tuios-ghostty_0.8.0_Linux_x86_64.tar.gz",
  ].join("\n");
  const sums = parseChecksums(text);
  assertEquals(Object.keys(sums).length, 2);
  assertEquals(
    sums["tuios-ghostty_0.8.0_Linux_x86_64.tar.gz"],
    "18cb546f90f4efed0508c696ede0ee2ed6626a6000ddf2e2ae85d6f99600377e",
  );
});

Deno.test("resolveApiUrl derives from repo unless apiUrl is set", () => {
  assertEquals(
    resolveApiUrl("acme/tool", ""),
    "https://api.github.com/repos/acme/tool/releases/latest",
  );
  assertEquals(
    releasesApiUrl("acme/tool"),
    "https://api.github.com/repos/acme/tool/releases/latest",
  );
  assertEquals(
    resolveApiUrl("acme/tool", "https://ghe.test/api/v3/releases/latest"),
    "https://ghe.test/api/v3/releases/latest",
  );
  assertThrows(() => resolveApiUrl("", ""), Error, "repo is empty");
});

Deno.test("apiUrlForVersion rewrites latest into the tag URL", () => {
  assertEquals(
    apiUrlForVersion(
      "https://api.github.com/repos/acme/tool/releases/latest",
      "v0.8.0",
    ),
    "https://api.github.com/repos/acme/tool/releases/tags/v0.8.0",
  );
});

Deno.test("mapUnameOs and mapUnameArch map host output", () => {
  assertEquals(mapUnameOs("Linux"), "Linux");
  assertEquals(mapUnameOs("Darwin"), "Darwin");
  assertEquals(mapUnameOs("MINGW64_NT-10.0"), "Windows");
  assertEquals(mapUnameOs("Haiku"), "UNKNOWN");
  assertEquals(mapUnameArch("x86_64"), "x86_64");
  assertEquals(mapUnameArch("aarch64"), "arm64");
  assertEquals(mapUnameArch("riscv64"), "unknown");
});

Deno.test("expandHome expands a leading ~ only", () => {
  assertEquals(expandHome("~", "/home/me"), "/home/me");
  assertEquals(expandHome("~/.cache/x", "/home/me"), "/home/me/.cache/x");
  assertEquals(expandHome("/usr/bin", "/home/me"), "/usr/bin");
});

Deno.test("compareVersions orders numerically, not lexically", () => {
  assertEquals(compareVersions("0.10.0", "0.9.0"), 1);
  assertEquals(compareVersions("0.9.0", "0.10.0"), -1);
  assertEquals(compareVersions("v0.8.0", "0.8.0"), 0);
  assertEquals(versionsEqual("v0.8.0", "0.8.0"), true);
  assertFalse(compareVersions("0.8.1", "0.8.0") < 0);
});

Deno.test("sha256Hex and verifySha256", async () => {
  const bytes = new TextEncoder().encode("hello");
  const sum = await sha256Hex(bytes);
  assertEquals(
    sum,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assertEquals(await verifySha256(bytes, sum), true);
  // An empty expectation degrades to "unverified", i.e. true.
  assertEquals(await verifySha256(bytes, ""), true);
  assertEquals(await verifySha256(bytes, "0".repeat(64)), false);
});

Deno.test("DEFAULT_ASSET_PATTERN has the required named groups", () => {
  const re = compileAssetPattern(DEFAULT_ASSET_PATTERN);
  assertEquals(re.source.includes("?<version>"), true);
  assertEquals(re.source.includes("?<os>"), true);
  assertEquals(re.source.includes("?<arch>"), true);
});
