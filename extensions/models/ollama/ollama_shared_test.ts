/**
 * Pure tests for the `@svendowideit/ollama` shared helpers: platform/asset
 * mapping, accelerator detection, version parsing, environment/systemd-unit
 * rendering, checksum verification and archive extraction (tar.gz and zip; the
 * tar.zst path is covered by the model method tests).
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

import {
  ACCEL_VARIANTS,
  assetExtension,
  assetFileName,
  assetStem,
  buildEnvironment,
  canEscalate,
  detectAccel,
  detectArchiveFormat,
  detectPrivilege,
  dirIsWritable,
  dirnameOf,
  escalationPrefix,
  expandHome,
  extractArchive,
  findBinaryMember,
  isDarwinOs,
  isLibMember,
  isUnitNotFound,
  isWindowsOs,
  manualInstructions,
  manualRemoveCommands,
  manualServiceCommands,
  manualSystemInstallCommands,
  mapUnameArch,
  mapUnameOs,
  normalizeMemberPath,
  normalizeVersion,
  OLLAMA_ASSET_PATTERN,
  parseEnvironmentBlock,
  parseVersionOutput,
  renderServiceUnit,
  resolveOsArch,
  shellQuote,
  teeHeredoc,
  verifyChecksum,
  versionsEqual,
} from "./ollama_shared.ts";
import { strToU8, zipSync } from "npm:fflate@0.8.3";

// ---------------------------------------------------------------------------
// Asset / platform mapping
// ---------------------------------------------------------------------------

Deno.test("assetStem builds the Ollama asset stem per platform", () => {
  assertEquals(assetStem("Linux", "x86_64", "base"), "ollama-linux-amd64");
  assertEquals(assetStem("Linux", "x86_64", "rocm"), "ollama-linux-amd64-rocm");
  assertEquals(
    assetStem("Linux", "arm64", "jetpack6"),
    "ollama-linux-arm64-jetpack6",
  );
  assertEquals(assetStem("Windows", "x86_64", "base"), "ollama-windows-amd64");
  assertEquals(assetStem("windows", "arm64", "base"), "ollama-windows-arm64");
  assertEquals(assetStem("Darwin", "arm64", "base"), "ollama-darwin");
  assertEquals(assetStem("macos", "x86_64", "base"), "ollama-darwin");
});

Deno.test("assetFileName and assetExtension pick the right archive", () => {
  assertEquals(
    assetFileName("Linux", "x86_64", "base"),
    "ollama-linux-amd64.tar.zst",
  );
  assertEquals(assetFileName("Darwin", "arm64", "base"), "ollama-darwin.tgz");
  assertEquals(
    assetFileName("Windows", "x86_64", "base"),
    "ollama-windows-amd64.zip",
  );
  assertEquals(assetExtension("Linux"), "tar.zst");
  assertEquals(assetExtension("Darwin"), "tgz");
  assertEquals(assetExtension("Windows"), "zip");
});

Deno.test("OLLAMA_ASSET_PATTERN parses every published asset name", () => {
  const re = new RegExp(OLLAMA_ASSET_PATTERN);
  const cases: Record<string, { stem: string; os: string; arch: string }> = {
    "ollama-linux-amd64.tar.zst": {
      stem: "ollama-linux-amd64",
      os: "linux",
      arch: "amd64",
    },
    "ollama-linux-amd64-rocm.tar.zst": {
      stem: "ollama-linux-amd64-rocm",
      os: "linux",
      arch: "amd64",
    },
    "ollama-linux-arm64-jetpack6.tar.zst": {
      stem: "ollama-linux-arm64-jetpack6",
      os: "linux",
      arch: "arm64",
    },
    "ollama-darwin.tgz": { stem: "ollama-darwin", os: "darwin", arch: "" },
    "ollama-windows-amd64.zip": {
      stem: "ollama-windows-amd64",
      os: "windows",
      arch: "amd64",
    },
  };
  for (const [name, expected] of Object.entries(cases)) {
    const m = re.exec(name);
    assertEquals(m?.groups?.stem, expected.stem, name);
    assertEquals(m?.groups?.os, expected.os, name);
    assertEquals(m?.groups?.arch ?? "", expected.arch, name);
  }
  assertEquals(re.exec("sha256sum.txt"), null);
  assertEquals(re.exec("Ollama-darwin.zip"), null);
});

Deno.test("mapUnameOs / mapUnameArch normalise host probes", () => {
  assertEquals(mapUnameOs("Linux"), "Linux");
  assertEquals(mapUnameOs("Darwin"), "Darwin");
  assertEquals(mapUnameOs("MINGW64_NT"), "Windows");
  assertEquals(mapUnameOs("FreeBSD"), "UNKNOWN");
  assertEquals(mapUnameArch("x86_64"), "x86_64");
  assertEquals(mapUnameArch("amd64"), "x86_64");
  assertEquals(mapUnameArch("aarch64"), "arm64");
});

Deno.test("resolveOsArch honours overrides and probes otherwise", async () => {
  const runner = (bin: string, args: string[]) => {
    if (bin === "uname" && args[0] === "-s") {
      return Promise.resolve({ stdout: "Linux\n", stderr: "", code: 0 });
    }
    if (bin === "uname" && args[0] === "-m") {
      return Promise.resolve({ stdout: "x86_64\n", stderr: "", code: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 1 });
  };
  assertEquals(await resolveOsArch("", "", runner), {
    os: "Linux",
    arch: "x86_64",
  });
  assertEquals(await resolveOsArch("Darwin", "arm64", runner), {
    os: "Darwin",
    arch: "arm64",
  });
});

Deno.test("detectAccel selects jetson, rocm and base", async () => {
  const noCmd = () => Promise.resolve(false);
  assertEquals(
    await detectAccel("Linux", "arm64", {
      readFile: (p) =>
        Promise.resolve(p.includes("nv_tegra") ? "R36 (release)" : ""),
      hasCommand: noCmd,
    }),
    "jetpack6",
  );
  assertEquals(
    await detectAccel("Linux", "arm64", {
      readFile: (p) => Promise.resolve(p.includes("nv_tegra") ? "# R35" : ""),
      hasCommand: noCmd,
    }),
    "jetpack5",
  );
  assertEquals(
    await detectAccel("Linux", "x86_64", {
      readFile: () => Promise.resolve(""),
      hasCommand: (n) => Promise.resolve(n === "rocm-smi"),
    }),
    "rocm",
  );
  assertEquals(
    await detectAccel("Linux", "x86_64", {
      readFile: () => Promise.resolve(""),
      hasCommand: noCmd,
    }),
    "base",
  );
  assertEquals(
    await detectAccel("Darwin", "arm64", {
      readFile: () => Promise.resolve(""),
      hasCommand: noCmd,
    }),
    "base",
  );
});

Deno.test("ACCEL_VARIANTS covers auto and the concrete builds", () => {
  for (const v of ["auto", "base", "rocm", "mlx", "jetpack5", "jetpack6"]) {
    assertEquals(ACCEL_VARIANTS.includes(v as never), true);
  }
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

Deno.test("normalizeVersion / versionsEqual ignore a leading v", () => {
  assertEquals(normalizeVersion("v0.35.0"), "0.35.0");
  assertEquals(versionsEqual("v0.35.0", "0.35.0"), true);
  assertEquals(versionsEqual("0.35.0", "0.34.4"), false);
});

Deno.test("parseVersionOutput reads both Ollama version formats", () => {
  assertEquals(parseVersionOutput("ollama version is 0.33.3\n"), "0.33.3");
  assertEquals(parseVersionOutput("ollama version 0.35.0"), "0.35.0");
  assertEquals(parseVersionOutput("warning: could not connect"), null);
});

// ---------------------------------------------------------------------------
// Paths / helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome and dirnameOf behave", () => {
  assertEquals(expandHome("~", "/home/a"), "/home/a");
  assertEquals(expandHome("~/.local/bin", "/home/a"), "/home/a/.local/bin");
  assertEquals(expandHome("/usr/local/bin", "/home/a"), "/usr/local/bin");
  assertEquals(dirnameOf("/usr/local/bin"), "/usr/local");
  assertEquals(dirnameOf("/bin"), "/");
  assertEquals(dirnameOf("relative"), ".");
});

Deno.test("detectArchiveFormat recognises Ollama formats", () => {
  assertEquals(detectArchiveFormat("ollama-linux-amd64.tar.zst"), "tar.zst");
  assertEquals(detectArchiveFormat("ollama-darwin.tgz"), "tgz");
  assertEquals(detectArchiveFormat("x.tar.gz"), "tar.gz");
  assertEquals(detectArchiveFormat("ollama-windows-amd64.zip"), "zip");
  assertEquals(detectArchiveFormat("sha256sum.txt"), null);
});

Deno.test("isWindowsOs / isDarwinOs classify tokens", () => {
  assertEquals(isWindowsOs("Windows"), true);
  assertEquals(isWindowsOs("win64"), true);
  assertEquals(isWindowsOs("Linux"), false);
  assertEquals(isDarwinOs("Darwin"), true);
  assertEquals(isDarwinOs("macos"), true);
  assertEquals(isDarwinOs("Linux"), false);
});

Deno.test("normalizeMemberPath strips leading ./ and trailing /", () => {
  assertEquals(normalizeMemberPath("./bin/ollama"), "bin/ollama");
  assertEquals(normalizeMemberPath("bin/"), "bin");
  assertEquals(normalizeMemberPath("/etc/passwd"), "etc/passwd");
});

Deno.test("dirIsWritable reflects the filesystem", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(dirIsWritable(dir), true);
    assertEquals(dirIsWritable(`${dir}/does-not-exist`), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Environment / systemd unit
// ---------------------------------------------------------------------------

Deno.test("parseEnvironmentBlock splits lines, commas and comments", () => {
  assertEquals(
    parseEnvironmentBlock("A=1\nB=2\n\n# note\nC=3,D=4"),
    ["A=1", "B=2", "C=3", "D=4"],
  );
});

Deno.test("buildEnvironment merges defaults with user entries", () => {
  assertEquals(
    buildEnvironment({ OLLAMA_HOST: "0.0.0.0:11434" }, [
      "OLLAMA_MODELS=/models",
      "PATH=/usr/bin",
    ]),
    ["OLLAMA_HOST=0.0.0.0:11434", "OLLAMA_MODELS=/models", "PATH=/usr/bin"],
  );
  // A user entry overrides the default sharing its key.
  assertEquals(
    buildEnvironment({ OLLAMA_HOST: "127.0.0.1:11434" }, [
      "OLLAMA_HOST=0.0.0.0:11434",
    ]),
    ["OLLAMA_HOST=0.0.0.0:11434"],
  );
});

Deno.test("renderServiceUnit renders a system unit with user and env", () => {
  const unit = renderServiceUnit({
    serviceName: "ollama",
    scope: "system",
    binaryPath: "/usr/local/bin/ollama",
    execArgs: "serve",
    user: "ollama",
    group: "ollama",
    environment: ["OLLAMA_HOST=0.0.0.0:11434"],
    restart: "always",
    restartSec: "3",
    after: ["network-online.target"],
    wants: ["network-online.target"],
  });
  assertStringIncludes(unit, "[Unit]");
  assertStringIncludes(unit, "Description=Ollama Service");
  assertStringIncludes(unit, "ExecStart=/usr/local/bin/ollama serve");
  assertStringIncludes(unit, "User=ollama");
  assertStringIncludes(unit, "Group=ollama");
  assertStringIncludes(unit, "Environment=OLLAMA_HOST=0.0.0.0:11434");
  assertStringIncludes(unit, "Restart=always");
  assertStringIncludes(unit, "WantedBy=multi-user.target");
});

Deno.test("renderServiceUnit renders a user unit without User=", () => {
  const unit = renderServiceUnit({
    serviceName: "ollama",
    scope: "user",
    binaryPath: "/home/a/.local/bin/ollama",
    execArgs: "serve --flash-attention",
    environment: [],
    restart: "always",
    restartSec: "3",
    after: [],
    wants: [],
  });
  assertStringIncludes(
    unit,
    "ExecStart=/home/a/.local/bin/ollama serve --flash-attention",
  );
  assertEquals(unit.includes("User="), false);
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("renderServiceUnit rejects newline injection", () => {
  let threw = false;
  try {
    renderServiceUnit({
      serviceName: "ollama",
      scope: "system",
      binaryPath: "/usr/local/bin/ollama",
      execArgs: "serve\nUser=root",
      environment: [],
      restart: "always",
      restartSec: "3",
      after: [],
      wants: [],
    });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "newlines");
  }
  assertEquals(threw, true);
});

Deno.test("isUnitNotFound detects a not-loaded unit", () => {
  assertEquals(
    isUnitNotFound({
      stdout: "",
      stderr: "Unit x.service not loaded.",
      code: 5,
    }),
    true,
  );
  assertEquals(
    isUnitNotFound({ stdout: "", stderr: "Failed to restart", code: 1 }),
    false,
  );
  assertEquals(isUnitNotFound({ stdout: "", stderr: "", code: 0 }), false);
});

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

Deno.test("verifyChecksum verifies by algorithm length", async () => {
  const bytes = new TextEncoder().encode("hello ollama");
  const sha256 =
    "9d5b8d5f5e2b0e6a0a4f7c1e3b2f4a6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e";
  // Compute the real SHA-256 for the bytes.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assertEquals((await verifyChecksum(bytes, hex)).verified, true);
  assertEquals((await verifyChecksum(bytes, sha256)).verified, false);
  // Empty expected degrades to "unverified" (verified true).
  assertEquals((await verifyChecksum(bytes, "")).verified, true);
});

// ---------------------------------------------------------------------------
// Archive extraction (tar.gz and zip)
// ---------------------------------------------------------------------------

async function buildTarGzFixture(): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.mkdir(`${dir}/lib/ollama`, { recursive: true });
    await Deno.writeTextFile(`${dir}/bin/ollama`, "BINARY");
    await Deno.writeTextFile(`${dir}/lib/ollama/libggml.so`, "LIB");
    const out = `${dir}/a.tgz`;
    const cmd = new Deno.Command("tar", {
      args: ["-czf", out, "-C", dir, "bin", "lib"],
      stdout: "null",
      stderr: "null",
    });
    assertEquals((await cmd.output()).code, 0);
    return await Deno.readFile(out);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("extractArchive reads a tar.gz into members", async () => {
  const bytes = await buildTarGzFixture();
  const members = await extractArchive(bytes, "tgz");
  assertEquals(findBinaryMember(members, "Linux")?.path, "bin/ollama");
  const binary = findBinaryMember(members, "Linux");
  assertEquals(new TextDecoder().decode(binary!.bytes), "BINARY");
  assertEquals(members.some((m) => isLibMember(m)), true);
});

Deno.test("extractArchive reads a zip into members", async () => {
  const zipped = zipSync({
    "ollama.exe": strToU8("WINBINARY"),
    "lib/ollama/x.dll": strToU8("WINLIB"),
  });
  const members = await extractArchive(zipped, "zip");
  assertEquals(findBinaryMember(members, "Windows")?.path, "ollama.exe");
  assertEquals(
    new TextDecoder().decode(findBinaryMember(members, "Windows")!.bytes),
    "WINBINARY",
  );
});

Deno.test("extractArchive rejects a corrupt archive", async () => {
  await assertRejects(() =>
    extractArchive(new Uint8Array([1, 2, 3, 4]), "tgz")
  );
});

// ---------------------------------------------------------------------------
// Privilege detection & manual instructions
// ---------------------------------------------------------------------------

Deno.test("detectPrivilege reports root for uid 0", async () => {
  const status = await detectPrivilege({ uid: 0 });
  assertEquals(status.mode, "root");
  assertEquals(status.isRoot, true);
  assertEquals(canEscalate(status, true), true);
});

Deno.test("detectPrivilege reports passwordless sudo", async () => {
  const runner = (bin: string, args: string[]) => {
    if (bin === "which") {
      return Promise.resolve({
        stdout: "/usr/bin/sudo\n",
        stderr: "",
        code: 0,
      });
    }
    if (bin === "sudo" && args[0] === "-n") {
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 1 });
  };
  const status = await detectPrivilege({ uid: 1000, runner });
  assertEquals(status.mode, "sudo");
  assertEquals(status.passwordless, true);
  assertEquals(escalationPrefix(status, true), ["sudo", "-n"]);
});

Deno.test("detectPrivilege reports a sudo prompt", async () => {
  const runner = (bin: string, _args: string[]) => {
    if (bin === "which") {
      return Promise.resolve({
        stdout: "/usr/bin/sudo\n",
        stderr: "",
        code: 0,
      });
    }
    if (bin === "sudo") {
      return Promise.resolve({
        stdout: "",
        stderr: "a password is required",
        code: 1,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 1 });
  };
  const status = await detectPrivilege({ uid: 1000, runner });
  assertEquals(status.mode, "sudo-prompt");
  assertEquals(canEscalate(status, true), false);
  assertEquals(escalationPrefix(status, true), []);
});

Deno.test("detectPrivilege reports none when sudo is absent", async () => {
  const runner = () => Promise.resolve({ stdout: "", stderr: "", code: 1 });
  const status = await detectPrivilege({ uid: 1000, runner });
  assertEquals(status.mode, "none");
  assertEquals(status.sudoAvailable, false);
});

Deno.test("shellQuote single-quotes and escapes embedded quotes", () => {
  assertEquals(shellQuote("/a/b c"), "'/a/b c'");
  assertEquals(shellQuote("it's"), "'it'\\''s'");
});

Deno.test("teeHeredoc writes content verbatim with a quoted tag", () => {
  const out = teeHeredoc(
    "/etc/systemd/system/x.service",
    "[Unit]\n$a=`id`\n",
    "TAG",
  );
  assertStringIncludes(
    out,
    "sudo tee /etc/systemd/system/x.service >/dev/null <<'TAG'",
  );
  assertStringIncludes(out, "$a=`id`");
  assertEquals(out.trimEnd().endsWith("TAG"), true);
});

Deno.test("manualSystemInstallCommands covers the whole install", () => {
  const cmds = manualSystemInstallCommands({
    archivePath: "/tmp/a.tar.zst",
    format: "tar.zst",
    installDir: "/usr/local/bin",
    libDir: "/usr/local/lib/ollama",
    serviceName: "ollama",
    serviceUser: "ollama",
    serviceGroup: "ollama",
    unitPath: "/etc/systemd/system/ollama.service",
    unitContent: "[Unit]\nDescription=Ollama\n",
  });
  const joined = cmds.map((c) => c.command).join("\n");
  assertStringIncludes(
    joined,
    "sudo mkdir -p /usr/local/bin /usr/local/lib/ollama",
  );
  assertStringIncludes(joined, "sudo tar --zstd");
  assertStringIncludes(joined, "sudo useradd");
  assertStringIncludes(joined, "sudo tee /etc/systemd/system/ollama.service");
  assertStringIncludes(joined, "daemon-reload");
  assertStringIncludes(joined, "systemctl enable --now ollama.service");
});

Deno.test("manualServiceCommands writes a drop-in and reloads", () => {
  const cmds = manualServiceCommands({
    serviceName: "ollama",
    unitPath: "/etc/systemd/system/ollama.service",
    unitContent: "unit",
    dropInPath: "/etc/systemd/system/ollama.service.d/10-swamp.conf",
    dropInContent: "[Service]\nEnvironment=OLLAMA_HOST=0.0.0.0:11434\n",
    restart: true,
  });
  const joined = cmds.map((c) => c.command).join("\n");
  assertStringIncludes(joined, "mkdir -p /etc/systemd/system/ollama.service.d");
  assertStringIncludes(joined, "Environment=OLLAMA_HOST=0.0.0.0:11434");
  assertStringIncludes(joined, "systemctl restart ollama.service");
});

Deno.test("manualRemoveCommands stops, removes and reloads", () => {
  const cmds = manualRemoveCommands({
    serviceName: "ollama",
    unitPath: "/etc/systemd/system/ollama.service",
    dropInPath: "/etc/systemd/system/ollama.service.d/10-swamp.conf",
    installDir: "/usr/local/bin",
    libDir: "/usr/local/lib/ollama",
    purgeService: true,
    purgeBinary: true,
  });
  const joined = cmds.map((c) => c.command).join("\n");
  assertStringIncludes(joined, "systemctl stop ollama.service");
  assertStringIncludes(joined, "rm -f /etc/systemd/system/ollama.service");
  assertStringIncludes(
    joined,
    "rm -rf /usr/local/bin/ollama /usr/local/lib/ollama",
  );
});

Deno.test("manualInstructions renders comments and commands", () => {
  const lines = manualInstructions("Run these:", [
    { command: "sudo foo", reason: "do a thing" },
  ], "then retry");
  const text = lines.join("\n");
  assertStringIncludes(text, "Run these:");
  assertStringIncludes(text, "# do a thing");
  assertStringIncludes(text, "sudo foo");
  assertStringIncludes(text, "then retry");
});
