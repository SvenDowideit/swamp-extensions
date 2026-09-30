/**
 * Unit tests for the remaining TUIOS-specific shared helpers — version
 * handling, path/install-dir selection, the package-manager probe, archive
 * extraction and `tuios --version` parsing. Fetching, platform selection and
 * checksum lookup moved to @svendowideit/github-release-install and are tested
 * there.
 *
 * @module
 */
import { assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@0.1.10/tar-stream";
import {
  assertAbsoluteDir,
  compareVersions,
  detectPackageManagerOwner,
  expandHome,
  extractFromTarGz,
  isOnPath,
  normalizeVersion,
  parseArchiveName,
  parseVersionOutput,
  selectInstallDir,
  stemForFlavor,
  verifySha256,
  versionsEqual,
} from "./tuios_shared.ts";

Deno.test("normalizeVersion strips a leading v", () => {
  assertEquals(normalizeVersion("v0.8.0"), "0.8.0");
  assertEquals(normalizeVersion("0.8.0"), "0.8.0");
  assertEquals(normalizeVersion(" v0.8.0 "), "0.8.0");
});

Deno.test("stemForFlavor maps the build flavor to the asset stem", () => {
  assertEquals(stemForFlavor("std"), "tuios");
  assertEquals(stemForFlavor("ghostty"), "tuios-ghostty");
});

Deno.test("parseArchiveName parses the TUIOS archive scheme", () => {
  assertEquals(parseArchiveName("tuios_0.8.0_Linux_x86_64.tar.gz"), {
    flavor: "std",
    version: "0.8.0",
    os: "Linux",
    arch: "x86_64",
  });
  assertEquals(parseArchiveName("tuios-ghostty_0.8.0_Darwin_arm64.tar.gz"), {
    flavor: "ghostty",
    version: "0.8.0",
    os: "Darwin",
    arch: "arm64",
  });
  assertEquals(parseArchiveName("checksums.txt"), null);
  assertEquals(parseArchiveName("tuios_0.8.0_Linux_x86_64.zip"), null);
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

Deno.test("expandHome expands a leading ~ only", () => {
  assertEquals(expandHome("~", "/home/me"), "/home/me");
  assertEquals(expandHome("~/.local/bin", "/home/me"), "/home/me/.local/bin");
  assertEquals(expandHome("/usr/bin", "/home/me"), "/usr/bin");
});

Deno.test("selectInstallDir picks the first writable candidate", () => {
  assertEquals(
    selectInstallDir("/home/me", (dir) => dir === "/usr/local/bin"),
    "/usr/local/bin",
  );
  assertEquals(
    selectInstallDir("/home/me", (dir) => dir === "/home/me/.local/bin"),
    "/home/me/.local/bin",
  );
  assertEquals(
    selectInstallDir("/home/me", () => false),
    "/home/me/.local/bin",
  );
});

Deno.test("isOnPath matches a directory on PATH", () => {
  assertEquals(isOnPath("/usr/bin", "/usr/bin:/bin"), true);
  assertEquals(isOnPath("/usr/bin/", "/usr/bin:/bin"), true);
  assertEquals(isOnPath("/nope", "/usr/bin:/bin"), false);
});

Deno.test("assertAbsoluteDir accepts absolute, ~ and empty; rejects relative", () => {
  assertAbsoluteDir("/usr/local/bin", "installDir");
  assertAbsoluteDir("~/.local/bin", "installDir");
  assertAbsoluteDir("", "installDir");
  assertThrows(
    () => assertAbsoluteDir("relative/bin", "installDir"),
    Error,
    "absolute",
  );
});

Deno.test("compareVersions orders numerically, not lexically", () => {
  assertEquals(compareVersions("0.10.0", "0.9.0"), 1);
  assertEquals(compareVersions("0.9.0", "0.10.0"), -1);
  assertEquals(compareVersions("v0.8.0", "0.8.0"), 0);
  assertEquals(compareVersions("1.0", "1.0.0"), 0);
  assertFalse(compareVersions("0.8.1", "0.8.0") < 0);
  assertEquals(versionsEqual("v0.8.0", "0.8.0"), true);
});

Deno.test("verifySha256 matches a digest and degrades on empty", async () => {
  const bytes = new TextEncoder().encode("hello");
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const sum = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(await verifySha256(bytes, sum), true);
  assertEquals(await verifySha256(bytes, ""), true);
  assertEquals(await verifySha256(bytes, "0".repeat(64)), false);
});

Deno.test("detectPackageManagerOwner reads a dpkg -S response", async () => {
  const run = (bin: string, args: string[]) => {
    if (bin === "dpkg" && args[0] === "-S") {
      return Promise.resolve({
        stdout: "tuios: /usr/bin/tuios\n",
        stderr: "",
        code: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "not found", code: 1 });
  };
  assertEquals(await detectPackageManagerOwner("/usr/bin/tuios", run), "tuios");
});

Deno.test("detectPackageManagerOwner accepts an rpm NEVRA", async () => {
  const run = (bin: string, args: string[]) => {
    if (bin === "rpm" && args[0] === "-qf") {
      return Promise.resolve({
        stdout: "tuios-0.8.0-1.x86_64\n",
        stderr: "",
        code: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "not found", code: 1 });
  };
  assertEquals(
    await detectPackageManagerOwner("/usr/bin/tuios", run),
    "tuios-0.8.0-1.x86_64",
  );
});

Deno.test("detectPackageManagerOwner checks brew formulae last", async () => {
  const run = (bin: string, args: string[]) => {
    if (bin === "brew" && args[0] === "list") {
      return Promise.resolve({ stdout: "tuios\n", stderr: "", code: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "not found", code: 1 });
  };
  assertEquals(
    await detectPackageManagerOwner("/opt/homebrew/bin/tuios", run),
    "brew formula 'tuios'",
  );
});

Deno.test("extractFromTarGz returns the named member", async () => {
  const enc = new TextEncoder();
  const body = enc.encode("the binary");
  const entry: TarStreamInput = {
    type: "file",
    path: "./tuios",
    size: body.length,
    readable: new Blob([body]).stream(),
  };
  const tar = new TarStream();
  const writer = tar.writable.getWriter();
  const collected = new Response(tar.readable).arrayBuffer();
  await writer.write(entry);
  await writer.close();
  const tarBytes = new Uint8Array(await collected);
  const gz = new Blob([tarBytes]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const bytes = new Uint8Array(await new Response(gz).arrayBuffer());

  const found = await extractFromTarGz(bytes, "tuios");
  assertEquals(new TextDecoder().decode(found!), "the binary");
  assertEquals(await extractFromTarGz(bytes, "README.md"), null);
});
