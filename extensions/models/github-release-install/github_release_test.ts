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
  parseChecksumsDetailed,
  parseReleasePayload,
  releasesApiUrl,
  renderReleaseMarkdown,
  resolveApiUrl,
  sameArch,
  sameOs,
  selectAsset,
  selectAssets,
  sha256Hex,
  verifyChecksum,
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
  // A custom (non-/latest) base gets the tag suffix appended, so a pinned
  // version is honoured even when apiUrl was supplied explicitly.
  assertEquals(
    apiUrlForVersion(
      "https://ghe.example.com/api/v3/repos/acme/tool/releases",
      "1.2.3",
    ),
    "https://ghe.example.com/api/v3/repos/acme/tool/releases/tags/v1.2.3",
  );
});

Deno.test("selectAsset honours an explicit format", () => {
  const assets = mapAssets([
    { name: "tool_1.0.0_Linux_x86_64.tar.gz", browser_download_url: "gz" },
    { name: "tool_1.0.0_Linux_x86_64.zip", browser_download_url: "zip" },
  ]);
  assertEquals(
    selectAsset(assets, {
      os: "Linux",
      arch: "x86_64",
      stem: "tool",
      format: "zip",
    })?.name,
    "tool_1.0.0_Linux_x86_64.zip",
  );
  assertEquals(
    selectAsset(assets, {
      os: "Linux",
      arch: "x86_64",
      stem: "tool",
      format: "tar.gz",
    })?.name,
    "tool_1.0.0_Linux_x86_64.tar.gz",
  );
  // auto keeps the first match.
  assertEquals(
    selectAsset(assets, { os: "Linux", arch: "x86_64", stem: "tool" })?.name,
    "tool_1.0.0_Linux_x86_64.tar.gz",
  );
});

Deno.test("parseReleasePayload rejects a list response and preserves the payload", () => {
  // The releases *list* endpoint returns an array — a common apiUrl mistake.
  assertThrows(
    () => parseReleasePayload([] as unknown as Record<string, unknown>),
    Error,
    "not a release object",
  );
  assertThrows(
    () => parseReleasePayload({ name: "no tag" }),
    Error,
    "no tag_name",
  );
  const parsed = parseReleasePayload({
    tag_name: "v0.8.0",
    body: "notes",
    assets: [],
    extra_field: "kept",
  });
  assertEquals(parsed.payload.extra_field, "kept");
});

Deno.test("renderReleaseMarkdown renders notes and assets from the payload", () => {
  const md = renderReleaseMarkdown({
    tag: "v0.8.0",
    version: "0.8.0",
    name: "Release 0.8.0",
    publishedAt: "2026-09-27T19:17:22Z",
    prerelease: false,
    htmlUrl: "https://github.com/acme/tool/releases/tag/v0.8.0",
    body: "## What changed\n\nFixed things.",
    assets: [
      { name: "tool_0.8.0_Linux_x86_64.tar.gz", url: "u", size: 10 },
    ],
  });
  assertEquals(md.includes("# Release 0.8.0"), true);
  assertEquals(md.includes("Version: 0.8.0"), true);
  assertEquals(md.includes("## Release notes"), true);
  assertEquals(md.includes("Fixed things."), true);
  assertEquals(md.includes("| tool_0.8.0_Linux_x86_64.tar.gz | 10 |"), true);
});

Deno.test("renderReleaseMarkdown falls back to the raw payload", () => {
  // No summary fields at all — everything must come from the payload.
  const md = renderReleaseMarkdown({
    payload: {
      tag_name: "v1.0.0",
      name: "v1.0.0",
      body: "from payload",
      html_url: "https://github.com/acme/tool/releases/tag/v1.0.0",
      assets: [],
    },
  });
  assertEquals(md.includes("# v1.0.0"), true);
  assertEquals(md.includes("from payload"), true);
});

Deno.test("renderReleaseMarkdown honours include flags and body truncation", () => {
  const md = renderReleaseMarkdown({
    version: "1.0.0",
    body: "0123456789",
    assets: [{ name: "a.tar.gz", url: "u" }],
  }, { includeAssets: false, maxBodyChars: 4 });
  assertEquals(md.includes("## Assets"), false);
  assertEquals(md.includes("0123\n\n… (6 more characters)"), true);
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

Deno.test("sameOs and sameArch match token families", () => {
  // Host probe says Linux/x86_64; caddy names assets linux/amd64.
  assertEquals(sameOs("Linux", "linux"), true);
  assertEquals(sameArch("x86_64", "amd64"), true);
  assertEquals(sameArch("aarch64", "arm64"), true);
  assertEquals(sameOs("Darwin", "macos"), true);
  assertEquals(sameOs("Linux", "Darwin"), false);
  assertEquals(sameArch("x86_64", "arm64"), false);
  // Empty tokens never match.
  assertEquals(sameOs("", "linux"), false);
  assertEquals(sameArch("", "amd64"), false);
});

Deno.test("selectAssets matches a lowercase publisher (caddy)", () => {
  const assets = mapAssets([
    { name: "caddy_2.11.4_linux_amd64.tar.gz", browser_download_url: "u1" },
    { name: "caddy_2.11.4_linux_arm64.tar.gz", browser_download_url: "u2" },
    { name: "caddy_2.11.4_darwin_amd64.tar.gz", browser_download_url: "u3" },
  ]);
  // Host tokens Linux/x86_64 must resolve caddy's linux/amd64 asset.
  const { selected } = selectAssets(assets, {
    os: "Linux",
    arch: "x86_64",
    stem: "caddy",
  });
  assertEquals(selected?.name, "caddy_2.11.4_linux_amd64.tar.gz");
});

Deno.test("selectAssets reports multiple variants and prefers the base build", () => {
  const assets = mapAssets([
    { name: "tuios-web_0.8.1_Linux_x86_64.tar.gz", browser_download_url: "w" },
    {
      name: "tuios-ghostty_0.8.1_Linux_x86_64.tar.gz",
      browser_download_url: "g",
    },
    { name: "tuios_0.8.1_Linux_x86_64.tar.gz", browser_download_url: "m" },
  ]);
  // No stem set: all three match; the base `tuios` wins over web/ghostty.
  const { selected, candidates } = selectAssets(assets, {
    os: "Linux",
    arch: "x86_64",
    repo: "Gaurav-Gosain/tuios",
  });
  assertEquals(selected?.name, "tuios_0.8.1_Linux_x86_64.tar.gz");
  assertEquals(candidates.length, 3);
  assertEquals(candidates[0].name, "tuios_0.8.1_Linux_x86_64.tar.gz");
  // A stem pins one variant.
  assertEquals(
    selectAssets(assets, {
      os: "Linux",
      arch: "x86_64",
      stem: "tuios-ghostty",
    }).selected?.name,
    "tuios-ghostty_0.8.1_Linux_x86_64.tar.gz",
  );
  // A repo whose name is not any stem still picks the shortest base.
  assertEquals(
    selectAssets(assets, { os: "Linux", arch: "x86_64" }).selected?.name,
    "tuios_0.8.1_Linux_x86_64.tar.gz",
  );
});

Deno.test("parseChecksumsDetailed detects SHA-512 and SHA-256", () => {
  const sha512 = parseChecksumsDetailed(
    "8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff977" +
      "7ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9" +
      "  caddy_2.11.4_linux_amd64.tar.gz\n",
  );
  assertEquals(sha512.algorithm, "sha512");
  assertEquals(
    sha512.sums["caddy_2.11.4_linux_amd64.tar.gz"].length,
    128,
  );
  const sha256 = parseChecksumsDetailed(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  a.tar.gz\n",
  );
  assertEquals(sha256.algorithm, "sha256");
  // A file with no digests reports no algorithm.
  assertEquals(parseChecksumsDetailed("just a comment").algorithm, null);
});

Deno.test("verifyChecksum chooses the algorithm from the digest length", async () => {
  const bytes = new TextEncoder().encode("hello");
  const expected =
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const result = await verifyChecksum(bytes, expected);
  assertEquals(result.algorithm, "sha256");
  assertEquals(result.verified, true);
  // A 128-hex digest selects SHA-512.
  const sha512 = await verifyChecksum(bytes, "0".repeat(128));
  assertEquals(sha512.algorithm, "sha512");
  assertEquals(sha512.verified, false);
});

Deno.test("DEFAULT_ASSET_PATTERN has the required named groups", () => {
  const re = compileAssetPattern(DEFAULT_ASSET_PATTERN);
  assertEquals(re.source.includes("?<version>"), true);
  assertEquals(re.source.includes("?<os>"), true);
  assertEquals(re.source.includes("?<arch>"), true);
});
