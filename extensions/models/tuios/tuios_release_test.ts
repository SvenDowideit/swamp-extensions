/**
 * Unit tests for the `tuios-release` model's pure helpers — platform
 * resolution and the printed release summary. No network is involved.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isSupportedOs, resolvePlatform } from "./tuios_shared.ts";
import {
  checksumsUrlFor,
  formatSummary,
  parseReleasePayload,
  selectPlatformAsset,
} from "./tuios_release.ts";

Deno.test("isSupportedOs accepts the release OS tokens only", () => {
  assertEquals(isSupportedOs("Linux"), true);
  assertEquals(isSupportedOs("Darwin"), true);
  assertEquals(isSupportedOs("Plan9"), false);
  assertEquals(isSupportedOs("linux"), false);
});

Deno.test("resolvePlatform honours explicit os/arch over a host probe", async () => {
  const platform = await resolvePlatform({
    os: "Linux",
    arch: "arm64",
    flavor: "ghostty",
  });
  assertEquals(platform, {
    os: "Linux",
    arch: "arm64",
    flavor: "ghostty",
    supported: true,
  });
});

Deno.test("resolvePlatform marks an unknown OS unsupported", async () => {
  const platform = await resolvePlatform({ os: "Plan9", arch: "mips" });
  assertEquals(platform.supported, false);
});

Deno.test("resolvePlatform derives os/arch/flavor from an archiveName", async () => {
  const platform = await resolvePlatform({
    archiveName: "tuios-ghostty_0.8.0_Darwin_arm64.tar.gz",
  });
  assertEquals(platform, {
    os: "Darwin",
    arch: "arm64",
    flavor: "ghostty",
    archiveName: "tuios-ghostty_0.8.0_Darwin_arm64.tar.gz",
    supported: true,
  });
});

Deno.test("resolvePlatform rejects a malformed archiveName", async () => {
  await assertRejects(
    () => resolvePlatform({ archiveName: "tuios.zip" }),
    Error,
    "not a TUIOS archive name",
  );
});

Deno.test("checksumsUrlFor prefers the checksums asset, else derives one", () => {
  assertEquals(
    checksumsUrlFor([
      { name: "checksums.txt", url: "https://example.test/c.txt" },
      {
        name: "tuios_0.8.0_Linux_x86_64.tar.gz",
        url: "https://example.test/v/tuios_0.8.0_Linux_x86_64.tar.gz",
      },
    ]),
    "https://example.test/c.txt",
  );
  assertEquals(
    checksumsUrlFor([
      {
        name: "tuios_0.8.0_Linux_x86_64.tar.gz",
        url: "https://example.test/v/tuios_0.8.0_Linux_x86_64.tar.gz",
      },
    ]),
    "https://example.test/v/checksums.txt",
  );
  assertEquals(checksumsUrlFor([]), null);
});

Deno.test("parseReleasePayload reads the GitHub release fields", () => {
  const parsed = parseReleasePayload({
    tag_name: "v0.8.0",
    name: "v0.8.0",
    published_at: "2026-09-27T19:17:22Z",
    prerelease: false,
    html_url: "https://github.com/Gaurav-Gosain/tuios/releases/tag/v0.8.0",
    body: "notes",
    assets: [
      {
        name: "tuios_0.8.0_Linux_x86_64.tar.gz",
        browser_download_url: "https://example.test/a.tar.gz",
        size: 10,
      },
    ],
  });
  assertEquals(parsed.tag, "v0.8.0");
  assertEquals(parsed.version, "0.8.0");
  assertEquals(parsed.publishedAt, "2026-09-27T19:17:22Z");
  assertEquals(parsed.assets[0].version, "0.8.0");
  assertEquals(parsed.body, "notes");
});

Deno.test("selectPlatformAsset annotates the platform with the chosen archive", () => {
  const release = parseReleasePayload({
    tag_name: "v0.8.0",
    assets: [
      {
        name: "tuios_0.8.0_Linux_x86_64.tar.gz",
        browser_download_url: "https://example.test/linux.tar.gz",
      },
      {
        name: "tuios-ghostty_0.8.0_Linux_x86_64.tar.gz",
        browser_download_url: "https://example.test/ghostty.tar.gz",
      },
    ],
  });
  const std = selectPlatformAsset(release, {
    os: "Linux",
    arch: "x86_64",
    flavor: "std",
    supported: true,
  });
  assertEquals(std.archiveName, "tuios_0.8.0_Linux_x86_64.tar.gz");
  assertEquals(std.downloadUrl, "https://example.test/linux.tar.gz");
  assertEquals(std.supported, true);

  // A platform with no matching archive keeps the derived name but is
  // marked unsupported.
  const missing = selectPlatformAsset(release, {
    os: "Darwin",
    arch: "arm64",
    flavor: "std",
    supported: true,
  });
  assertEquals(missing.archiveName, undefined);
  assertEquals(missing.supported, false);
});

Deno.test("release formatSummary reports platform and update state", () => {
  const lines = formatSummary(
    {
      version: "0.8.0",
      tag: "v0.8.0",
      publishedAt: "2026-09-27T19:17:22Z",
      platform: {
        os: "Linux",
        arch: "x86_64",
        flavor: "std",
        archiveName: "tuios_0.8.0_Linux_x86_64.tar.gz",
        downloadUrl: "https://example.test/tuios.tar.gz",
        supported: true,
      },
      checksum: "abc",
      updateAvailable: true,
    },
    "0.7.0",
  );
  const joined = lines.join("\n");
  assertEquals(joined.includes("Latest TUIOS: 0.8.0 (v0.8.0)"), true);
  assertEquals(joined.includes("Linux/x86_64 (std)"), true);
  assertEquals(joined.includes("update available"), true);
});

Deno.test("release formatSummary says when nothing is installed", () => {
  const joined = formatSummary({ version: "0.8.0" }, "").join("\n");
  assertEquals(joined.includes("Installed:    not detected"), true);
});
