/**
 * Unit tests for the shared TUIOS helpers — archive naming, platform mapping,
 * asset selection, checksum and version parsing, and version comparison.
 *
 * @module
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  archiveName,
  compareVersions,
  githubHeaders,
  mapAssets,
  mapUnameArch,
  mapUnameOs,
  normalizeVersion,
  parseArchiveName,
  parseChecksums,
  parseVersionOutput,
  resolveToken,
  selectAsset,
  versionsEqual,
} from "./tuios_shared.ts";

Deno.test("normalizeVersion strips a leading v", () => {
  assertEquals(normalizeVersion("v0.8.0"), "0.8.0");
  assertEquals(normalizeVersion("0.8.0"), "0.8.0");
  assertEquals(normalizeVersion(" v0.8.0 "), "0.8.0");
});

Deno.test("mapUnameOs maps uname -s output", () => {
  assertEquals(mapUnameOs("Linux"), "Linux");
  assertEquals(mapUnameOs("Darwin"), "Darwin");
  assertEquals(mapUnameOs("MINGW64_NT-10.0"), "Windows");
  assertEquals(mapUnameOs("FreeBSD"), "Freebsd");
  assertEquals(mapUnameOs("OpenBSD"), "Openbsd");
  assertEquals(mapUnameOs("Haiku"), "UNKNOWN");
});

Deno.test("mapUnameArch maps uname -m output", () => {
  assertEquals(mapUnameArch("x86_64"), "x86_64");
  assertEquals(mapUnameArch("amd64"), "x86_64");
  assertEquals(mapUnameArch("aarch64"), "arm64");
  assertEquals(mapUnameArch("arm64"), "arm64");
  assertEquals(mapUnameArch("armv7l"), "armv7");
  assertEquals(mapUnameArch("i686"), "i386");
  assertEquals(mapUnameArch("riscv64"), "unknown");
});

Deno.test("archiveName builds the GoReleaser name for both flavors", () => {
  assertEquals(
    archiveName("v0.8.0", "Linux", "x86_64"),
    "tuios_0.8.0_Linux_x86_64.tar.gz",
  );
  assertEquals(
    archiveName("0.8.0", "Linux", "x86_64", "ghostty"),
    "tuios-ghostty_0.8.0_Linux_x86_64.tar.gz",
  );
});

Deno.test("parseArchiveName round-trips archiveName", () => {
  for (
    const [flavor, version, os, arch] of [
      ["std", "0.8.0", "Linux", "x86_64"],
      ["ghostty", "0.8.0", "Linux", "arm64"],
      ["std", "1.2.3", "Darwin", "arm64"],
    ] as const
  ) {
    const name = archiveName(version, os, arch, flavor);
    assertEquals(parseArchiveName(name), { flavor, version, os, arch });
  }
  assertEquals(parseArchiveName("checksums.txt"), null);
  assertEquals(parseArchiveName("tuios_0.8.0_Linux_x86_64.zip"), null);
});

Deno.test("selectAsset picks the exact os/arch/flavor", () => {
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
    selectAsset(assets, "Linux", "x86_64", "std")?.name,
    "tuios_0.8.0_Linux_x86_64.tar.gz",
  );
  assertEquals(
    selectAsset(assets, "Linux", "arm64", "std")?.name,
    "tuios_0.8.0_Linux_arm64.tar.gz",
  );
  assertEquals(
    selectAsset(assets, "Linux", "arm64", "ghostty")?.name,
    "tuios-ghostty_0.8.0_Linux_arm64.tar.gz",
  );
  assertEquals(selectAsset(assets, "Darwin", "arm64", "std"), null);
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

Deno.test("parseVersionOutput reads the version and backend", () => {
  const out = [
    "tuios version 0.8.0 [pure-Go backend]",
    "Commit: a169a8f4b0513e8e56af4c75a746a582b7f42dfc",
    "Built: 2026-09-27T19:05:54Z",
    "By: goreleaser",
  ].join("\n");
  assertEquals(parseVersionOutput(out), {
    version: "0.8.0",
    backend: "pure-Go backend",
  });
  assertEquals(parseVersionOutput("tuios version v0.7.0"), {
    version: "0.7.0",
    backend: "",
  });
  assertEquals(parseVersionOutput("command not found"), null);
});

Deno.test("githubHeaders sets only the required headers without a token", () => {
  const headers = githubHeaders("swamp-tuios/1.0", "application/json");
  assertEquals(headers["User-Agent"], "swamp-tuios/1.0");
  assertEquals(headers["Accept"], "application/json");
  assertEquals(headers["Authorization"], undefined);
});

Deno.test("githubHeaders adds a bearer Authorization when given a token", () => {
  const headers = githubHeaders("ua", "application/json", "abc123");
  assertEquals(headers["Authorization"], "Bearer abc123");
});

Deno.test("resolveToken prefers the explicit value, then the environment", () => {
  assertEquals(resolveToken("explicit"), "explicit");
  const saved = Deno.env.get("GITHUB_TOKEN");
  try {
    Deno.env.delete("GITHUB_TOKEN");
    Deno.env.set("GH_TOKEN", "from-env");
    assertEquals(resolveToken(""), "from-env");
    Deno.env.delete("GH_TOKEN");
    assertEquals(resolveToken(""), undefined);
  } finally {
    if (saved === undefined) Deno.env.delete("GITHUB_TOKEN");
    else Deno.env.set("GITHUB_TOKEN", saved);
  }
});

Deno.test("compareVersions orders numerically, not lexically", () => {
  assertEquals(compareVersions("0.10.0", "0.9.0"), 1);
  assertEquals(compareVersions("0.9.0", "0.10.0"), -1);
  assertEquals(compareVersions("v0.8.0", "0.8.0"), 0);
  assertEquals(compareVersions("1.0", "1.0.0"), 0);
  assertFalse(compareVersions("0.8.1", "0.8.0") < 0);
  assertEquals(versionsEqual("v0.8.0", "0.8.0"), true);
});
