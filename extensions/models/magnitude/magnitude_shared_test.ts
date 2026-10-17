/**
 * Pure tests for the `@svendowideit/magnitude` shared helpers: distro and
 * architecture detection, asset-name parsing, version handling, privilege
 * escalation and the root-side script/settings rendering.
 *
 * @module
 */
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  archSupported,
  assertAbsoluteDir,
  canEscalate,
  compareVersions,
  detectDistroFamily,
  detectPrivilege,
  dirIsWritable,
  dirnameOf,
  escalationPrefix,
  expandHome,
  MAGNITUDE_PACKAGE_PATTERN,
  normalizeArch,
  packageFormatFor,
  packageInstallArgv,
  packageManagerFor,
  packageRevision,
  packageVersionFromName,
  parseOsRelease,
  parseVersionOutput,
  releaseTagFor,
  releaseVersion,
  renderInstallScript,
  renderServerConfig,
  renderServerRemoveScript,
  renderServerSetupScript,
  runCapture,
  shellQuote,
} from "./magnitude_shared.ts";

// ---------------------------------------------------------------------------
// Distro / arch
// ---------------------------------------------------------------------------

Deno.test("parseOsRelease reads the quoted and bare key forms", () => {
  const rel = parseOsRelease([
    'PRETTY_NAME="Ubuntu 26.04.1 LTS"',
    "ID=ubuntu",
    "ID_LIKE=debian",
    "VERSION_ID='26.04'",
    "# a comment",
    "MALFORMED",
  ].join("\n"));
  assertEquals(rel.prettyName, "Ubuntu 26.04.1 LTS");
  assertEquals(rel.id, "ubuntu");
  assertEquals(rel.idLike, "debian");
  assertEquals(rel.versionId, "26.04");
});

Deno.test("detectDistroFamily maps ids and id_like onto a package family", () => {
  assertEquals(
    detectDistroFamily({
      id: "ubuntu",
      idLike: "debian",
      versionId: "",
      prettyName: "",
    }),
    "debian",
  );
  assertEquals(
    detectDistroFamily({
      id: "linuxmint",
      idLike: "",
      versionId: "",
      prettyName: "",
    }),
    "debian",
  );
  assertEquals(
    detectDistroFamily({
      id: "fedora",
      idLike: "",
      versionId: "",
      prettyName: "",
    }),
    "rhel",
  );
  assertEquals(
    detectDistroFamily({
      id: "rocky",
      idLike: "rhel centos fedora",
      versionId: "",
      prettyName: "",
    }),
    "rhel",
  );
  assertEquals(
    detectDistroFamily({
      id: "manjaro",
      idLike: "arch",
      versionId: "",
      prettyName: "",
    }),
    "arch",
  );
  // A derivative resolves through ID_LIKE when ID is unknown.
  assertEquals(
    detectDistroFamily({
      id: "endeavouros",
      idLike: "arch",
      versionId: "",
      prettyName: "",
    }),
    "arch",
  );
  assertEquals(
    detectDistroFamily({
      id: "gentoo",
      idLike: "",
      versionId: "",
      prettyName: "",
    }),
    "unknown",
  );
  // A raw os-release string is parsed on the way in.
  assertEquals(detectDistroFamily("ID=debian\n"), "debian");
});

Deno.test("packageManagerFor and packageFormatFor map the family", () => {
  assertEquals(packageManagerFor("debian"), "apt");
  assertEquals(packageManagerFor("rhel"), "dnf");
  assertEquals(packageManagerFor("arch"), "pacman");
  assertEquals(packageFormatFor("debian"), "deb");
  assertEquals(packageFormatFor("rhel"), "rpm");
  assertEquals(packageFormatFor("arch"), "pkg.tar.zst");
});

Deno.test("normalizeArch and archSupported gate the published builds", () => {
  assertEquals(normalizeArch("x86_64"), "x64");
  assertEquals(normalizeArch("amd64"), "x64");
  assertEquals(normalizeArch("aarch64"), "arm64");
  assertEquals(normalizeArch("arm64"), "arm64");
  assertEquals(normalizeArch("riscv64"), "unknown");
  assertEquals(archSupported("debian", "x64"), true);
  assertEquals(archSupported("debian", "arm64"), true);
  assertEquals(archSupported("arch", "x64"), true);
  assertEquals(archSupported("arch", "arm64"), false);
  assertEquals(archSupported("debian", "unknown"), false);
});

// ---------------------------------------------------------------------------
// Asset names and versions
// ---------------------------------------------------------------------------

Deno.test("the package pattern parses every Linux asset and ignores the rest", () => {
  const re = new RegExp(MAGNITUDE_PACKAGE_PATTERN);
  assertEquals(
    re.exec("magnitude-desktop_0.2.9-59_amd64.deb")?.groups,
    {
      stem: "magnitude-desktop",
      version: "0.2.9-59",
      arch: "amd64",
      os: "deb",
    },
  );
  assertEquals(
    re.exec("magnitude-desktop-0.2.9-59.x86_64.rpm")?.groups?.os,
    "rpm",
  );
  assertEquals(
    re.exec("magnitude-desktop-0.2.9-59.aarch64.rpm")?.groups?.arch,
    "aarch64",
  );
  assertEquals(
    re.exec("magnitude-desktop-0.2.9-59-x86_64.pkg.tar.zst")?.groups?.os,
    "pkg.tar.zst",
  );
  // macOS/Windows desktop assets and the release manifest must not match.
  assertEquals(re.test("magnitude-desktop-darwin-arm64.dmg"), false);
  assertEquals(re.test("magnitude-desktop-windows-x64-0.2.9.exe"), false);
  assertEquals(re.test("magnitude-release.json"), false);
});

Deno.test("packageVersionFromName / releaseVersion / packageRevision split the build number", () => {
  const name = "magnitude-desktop_0.2.9-59_amd64.deb";
  assertEquals(packageVersionFromName(name), "0.2.9-59");
  assertEquals(releaseVersion("0.2.9-59"), "0.2.9");
  assertEquals(releaseVersion("0.2.9"), "0.2.9");
  assertEquals(packageRevision("0.2.9-59"), "59");
  assertEquals(packageRevision("0.2.9"), null);
  assertEquals(packageVersionFromName("not-a-package.deb"), null);
});

Deno.test("releaseTagFor builds the Magnitude tag form", () => {
  assertEquals(releaseTagFor("0.2.9"), "@magnitudedev/cli@0.2.9");
  assertEquals(releaseTagFor("v0.2.9"), "@magnitudedev/cli@0.2.9");
});

Deno.test("compareVersions and parseVersionOutput", () => {
  assertEquals(compareVersions("0.2.9", "0.2.9"), 0);
  assertEquals(compareVersions("0.2.10", "0.2.9"), 1);
  assertEquals(compareVersions("v0.1.0", "0.2.0"), -1);
  assertEquals(compareVersions("0.2.9-60", "0.2.9-59"), 1);
  assertEquals(parseVersionOutput("0.2.9\n"), "0.2.9");
  assertEquals(parseVersionOutput("magnitude 0.2.9\n"), "0.2.9");
  assertEquals(parseVersionOutput(""), null);
  assertEquals(parseVersionOutput("no version"), null);
});

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome / dirnameOf / assertAbsoluteDir", () => {
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
  assertEquals(dirnameOf("/a/b/c"), "/a/b");
  assertEquals(dirnameOf("/a"), "/");
  assertEquals(dirnameOf("rel"), ".");
  assertAbsoluteDir("/var/lib/magnitude", "configDir");
  assertAbsoluteDir("~/x", "configDir");
  assertThrows(() => assertAbsoluteDir("relative/path", "configDir"));
});

Deno.test("dirIsWritable probes by writing and removing a temp file", () => {
  const dir = Deno.makeTempDirSync();
  assertEquals(dirIsWritable(dir), true);
  assertEquals(dirIsWritable(`${dir}/does-not-exist`), false);
  Deno.removeSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Privilege
// ---------------------------------------------------------------------------

function makeRunner(
  handlers: Record<
    string,
    (args: string[]) => { stdout?: string; stderr?: string; code: number }
  >,
) {
  return (bin: string, args: string[]) => {
    const handler = handlers[bin];
    if (!handler) return Promise.resolve({ stdout: "", stderr: "", code: 127 });
    const out = handler(args);
    return Promise.resolve({
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
      code: out.code,
    });
  };
}

Deno.test("detectPrivilege reports root, passwordless and prompt", async () => {
  const root = await detectPrivilege({
    runner: makeRunner({ "id": () => ({ stdout: "0\n", code: 0 }) }),
  });
  assertEquals(root.mode, "root");
  assertEquals(root.isRoot, true);

  const pw = await detectPrivilege({
    runner: makeRunner({
      "id": () => ({ stdout: "1000\n", code: 0 }),
      "which": () => ({ stdout: "/usr/bin/sudo\n", code: 0 }),
      "sudo": () => ({ stdout: "", code: 0 }),
    }),
  });
  assertEquals(pw.mode, "sudo");
  assertEquals(pw.passwordless, true);

  const prompt = await detectPrivilege({
    runner: makeRunner({
      "id": () => ({ stdout: "1000\n", code: 0 }),
      "which": () => ({ stdout: "/usr/bin/sudo\n", code: 0 }),
      "sudo": () => ({ stderr: "a password is required\n", code: 1 }),
    }),
  });
  assertEquals(prompt.mode, "sudo-prompt");

  const none = await detectPrivilege({
    runner: makeRunner({
      "id": () => ({ stdout: "1000\n", code: 0 }),
      "which": () => ({ stdout: "", code: 1 }),
    }),
  });
  assertEquals(none.mode, "none");
});

Deno.test("escalationPrefix and canEscalate gate the privileged run", () => {
  const root = {
    uid: 0,
    isRoot: true,
    sudoAvailable: true,
    passwordless: true,
    sudoCommand: "sudo",
    nonInteractive: true,
    mode: "root" as const,
    message: "",
  };
  const pw = {
    uid: 1000,
    isRoot: false,
    sudoAvailable: true,
    passwordless: true,
    sudoCommand: "sudo",
    nonInteractive: true,
    mode: "sudo" as const,
    message: "",
  };
  const none = {
    uid: 1000,
    isRoot: false,
    sudoAvailable: false,
    passwordless: false,
    sudoCommand: "sudo",
    nonInteractive: true,
    mode: "none" as const,
    message: "",
  };
  assertEquals(escalationPrefix(root, true), []);
  assertEquals(escalationPrefix(pw, true), ["sudo", "-n"]);
  assertEquals(escalationPrefix(none, true), []);
  assertEquals(escalationPrefix(pw, false), []);
  assertEquals(canEscalate(root, true), true);
  assertEquals(canEscalate(pw, true), true);
  assertEquals(canEscalate(none, true), false);
  assertEquals(canEscalate(none, false), true);
});

// ---------------------------------------------------------------------------
// Scripts and settings
// ---------------------------------------------------------------------------

Deno.test("shellQuote never lets a single quote escape", () => {
  assertEquals(shellQuote("plain"), "'plain'");
  assertEquals(shellQuote("it's"), `'it'\\''s'`);
});

Deno.test("packageInstallArgv selects the family's package manager", () => {
  assertEquals(packageInstallArgv("apt", "/tmp/x.deb"), [
    "apt-get",
    "install",
    "-y",
    "/tmp/x.deb",
  ]);
  assertEquals(packageInstallArgv("dnf", "/tmp/x.rpm"), [
    "dnf",
    "install",
    "-y",
    "/tmp/x.rpm",
  ]);
  assertEquals(packageInstallArgv("pacman", "/tmp/x.pkg.tar.zst"), [
    "pacman",
    "-U",
    "--noconfirm",
    "/tmp/x.pkg.tar.zst",
  ]);
});

Deno.test("renderInstallScript is a self-contained root install script", () => {
  const script = renderInstallScript({
    manager: "apt",
    packagePath:
      "/home/u/.cache/magnitude/magnitude-desktop_0.2.9-59_amd64.deb",
  });
  assertStringIncludes(script, "#!/bin/sh");
  assertStringIncludes(script, "set -eu");
  assertStringIncludes(
    script,
    "'apt-get' 'install' '-y' '/home/u/.cache/magnitude/magnitude-desktop_0.2.9-59_amd64.deb'",
  );
});

Deno.test("renderServerSetupScript registers the server non-interactively", () => {
  const script = renderServerSetupScript({
    serviceName: "magnitude",
    serviceUser: "magnitude",
    configDir: "/var/lib/magnitude",
  });
  assertStringIncludes(script, "groupadd --system magnitude");
  assertStringIncludes(script, "useradd --system --gid magnitude");
  assertStringIncludes(script, "--home-dir /var/lib/magnitude");
  assertStringIncludes(
    script,
    "install -d -m 0750 -o magnitude -g magnitude /var/lib/magnitude",
  );
  assertStringIncludes(script, "/etc/magnitude/server");
  assertStringIncludes(script, "systemctl enable --now magnitude.service");
  // Never calls the interactive CLI.
  assertEquals(script.includes("server setup"), false);

  // With a staged settings document it installs it owned by the service
  // account and restarts only when it changed.
  const withConfig = renderServerSetupScript({
    serviceName: "magnitude",
    serviceUser: "magnitude",
    configDir: "/var/lib/magnitude",
    configStagedPath: "/staging/config.json",
  });
  assertStringIncludes(
    withConfig,
    "install -D -m 0600 -o magnitude -g magnitude '/staging/config.json' /var/lib/magnitude/config.json",
  );
  assertStringIncludes(
    withConfig,
    "cmp -s '/staging/config.json' /var/lib/magnitude/config.json",
  );
  assertStringIncludes(withConfig, "systemctl restart magnitude.service");
});

Deno.test("renderServerRemoveScript stops and removes the service", () => {
  const script = renderServerRemoveScript({
    serviceName: "magnitude",
    configDir: "/var/lib/magnitude",
  });
  assertStringIncludes(script, "systemctl disable --now magnitude.service");
  assertStringIncludes(script, "rm -f /etc/magnitude/server");
});

Deno.test("renderServerConfig emits only the keys that were set", () => {
  assertEquals(
    renderServerConfig({
      networkEnabled: true,
      apiKey: "k",
      bind: "100.64.1.5",
    }),
    `{
  "network": {
    "enabled": true,
    "apiKey": "k",
    "bind": "100.64.1.5"
  }
}
`,
  );
  assertEquals(renderServerConfig({}), "{}\n");
});

// A missing binary is reported as code 127 rather than hanging or throwing.
Deno.test("runCapture reports a missing binary as code 127", async () => {
  const result = await runCapture("definitely-not-a-real-binary-xyz", []);
  assertEquals(result.code, 127);
});
