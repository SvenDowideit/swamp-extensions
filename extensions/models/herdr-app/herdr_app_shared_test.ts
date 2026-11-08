/**
 * Tests for the pure helpers behind `@svendowideit/herdr-app`: platform
 * selection, manifest parsing, layout, version comparison, the Windows
 * snippets, and the pinned POSIX installer.
 *
 * The installer is not just string-matched: it is rendered, executed with a
 * fake `curl` and a temporary `$HOME` on Linux/macOS, and asserted to install,
 * report `unchanged` on a second run, and refuse a host of the wrong platform.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  compareVersions,
  DEFAULT_RELEASES_URL,
  desktopEntry,
  encodePowerShell,
  installAction,
  layoutFor,
  manifestUrl,
  normalizeArch,
  normalizeVersion,
  osFamily,
  parseAppVersion,
  parseCoreVersion,
  parseManifest,
  pickAsset,
  psQuote,
  renderInstallScript,
  targetFor,
  versionsEqual,
  windowsPathRemoveScript,
  windowsPathScript,
  windowsShortcutRemoveScript,
  windowsShortcutScript,
  withSource,
} from "./herdr_app_shared.ts";

const HOME = { home: "/home/me" };

// ---------------------------------------------------------------------------
// Platform selection
// ---------------------------------------------------------------------------

Deno.test("normalizeArch understands the vendor's arch spellings", () => {
  assertEquals(normalizeArch("x86_64"), "x86_64");
  assertEquals(normalizeArch("AMD64"), "x86_64");
  assertEquals(normalizeArch("arm64"), "aarch64");
  assertEquals(normalizeArch("aarch64"), "aarch64");
  assertEquals(normalizeArch("riscv64"), "");
});

Deno.test("osFamily maps uname and Deno OS names", () => {
  assertEquals(osFamily("Linux"), "linux");
  assertEquals(osFamily("Darwin"), "macos");
  assertEquals(osFamily("windows"), "windows");
  assertEquals(osFamily("MINGW64_NT-10.0"), "windows");
  assertEquals(osFamily("FreeBSD"), "");
});

Deno.test("targetFor picks the published build for each host", () => {
  assertEquals(targetFor("linux", "x86_64").target, "linux-x86_64");
  assertEquals(targetFor("linux", "arm64").target, "linux-aarch64");
  assertEquals(targetFor("macos", "arm64").target, "macos-aarch64");
  assertEquals(targetFor("windows", "x86_64").target, "windows-x86_64");
});

Deno.test("targetFor treats Rosetta as Apple silicon", () => {
  assertEquals(
    targetFor("macos", "x86_64", { rosetta: true }).target,
    "macos-aarch64",
  );
});

Deno.test("targetFor refuses builds the vendor does not publish", () => {
  assertThrows(
    () => targetFor("macos", "x86_64"),
    Error,
    "no Intel Mac build",
  );
  assertThrows(
    () => targetFor("windows", "aarch64"),
    Error,
    "no Windows arm64 build",
  );
  assertThrows(() => targetFor("linux", "riscv64"), Error, "no build for");
});

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const APP_MANIFEST = {
  version: "0.1.14",
  core_min: "0.1.11",
  notes: "Herdr 0.1.14",
  targets: {
    "linux-x86_64": {
      url:
        "https://releases.herdr.dev/app/0.1.14/herdr-app-linux-x86_64.tar.gz",
      sha256: "A".repeat(64),
    },
    "linux-aarch64": {
      url:
        "https://releases.herdr.dev/app/0.1.14/herdr-app-linux-aarch64.tar.gz",
      sha256: "b".repeat(64),
    },
  },
};

Deno.test("parseManifest normalises versions and checksums", () => {
  const parsed = parseManifest(APP_MANIFEST, "app/latest.json");
  assertEquals(parsed.version, "0.1.14");
  assertEquals(parsed.coreMin, "0.1.11");
  assertEquals(parsed.notes, "Herdr 0.1.14");
  assertEquals(parsed.targets["linux-x86_64"].sha256, "a".repeat(64));
});

Deno.test("parseManifest drops assets without a usable checksum", () => {
  const parsed = parseManifest({
    version: "v0.2.0",
    targets: {
      good: { url: "https://x/y.tgz", sha256: "c".repeat(64) },
      noHash: { url: "https://x/z.tgz" },
      short: { url: "https://x/z.tgz", sha256: "abc" },
    },
  }, "m.json");
  assertEquals(parsed.version, "0.2.0");
  assertEquals(Object.keys(parsed.targets), ["good"]);
});

Deno.test("parseManifest rejects a body that is not a manifest", () => {
  assertThrows(() => parseManifest(null, "m.json"), Error, "not a release");
  assertThrows(
    () => parseManifest({ targets: {} }, "m.json"),
    Error,
    "no version",
  );
  assertThrows(
    () => parseManifest({ version: "1.0.0" }, "m.json"),
    Error,
    "no targets",
  );
});

Deno.test("manifestUrl tracks latest, or a pinned release's manifest", () => {
  assertEquals(
    manifestUrl(DEFAULT_RELEASES_URL + "/", "app"),
    "https://releases.herdr.dev/app/latest.json",
  );
  assertEquals(
    manifestUrl(DEFAULT_RELEASES_URL, "app", "v0.1.14"),
    "https://releases.herdr.dev/app/0.1.14/manifest.json",
  );
  assertEquals(
    manifestUrl(DEFAULT_RELEASES_URL, "core", "0.1.19"),
    "https://releases.herdr.dev/core/0.1.19/manifest.json",
  );
});

Deno.test("pickAsset names what the release does publish", () => {
  const manifest = parseManifest(APP_MANIFEST, "app/latest.json");
  assertEquals(
    pickAsset(manifest, "linux-x86_64", "Herdr app").sha256,
    "a".repeat(64),
  );
  assertThrows(
    () => pickAsset(manifest, "windows-x86_64", "Herdr app"),
    Error,
    "has no build for windows-x86_64 (published: linux-aarch64, linux-x86_64)",
  );
});

Deno.test("withSource marks only plain vendor URLs", () => {
  assertEquals(
    withSource(
      "https://releases.herdr.dev/app/a.tgz",
      DEFAULT_RELEASES_URL,
      "reinstall",
    ),
    "https://releases.herdr.dev/app/a.tgz?src=reinstall",
  );
  assertEquals(
    withSource("https://mirror.example/a.tgz", DEFAULT_RELEASES_URL, "install"),
    "https://mirror.example/a.tgz",
  );
  assertEquals(
    withSource(
      "https://releases.herdr.dev/a.tgz?sig=1",
      DEFAULT_RELEASES_URL,
      "install",
    ),
    "https://releases.herdr.dev/a.tgz?sig=1",
  );
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

Deno.test("versions compare numerically, with suffixes below the release", () => {
  assertEquals(compareVersions("0.1.9", "0.1.14") < 0, true);
  assertEquals(compareVersions("v0.1.14", "0.1.14"), 0);
  assertEquals(compareVersions("1.0.0", "0.9.9") > 0, true);
  assertEquals(compareVersions("0.1.14-rc1", "0.1.14") < 0, true);
  assertEquals(normalizeVersion(" V0.1.14 "), "0.1.14");
  assertEquals(versionsEqual("0.1.14", "v0.1.14"), true);
  assertEquals(versionsEqual("", "0.1.14"), false);
});

Deno.test("installAction names what installing over what is there means", () => {
  assertEquals(installAction("", "0.1.14"), "installed");
  assertEquals(installAction("0.1.13", "0.1.14"), "updated");
  assertEquals(installAction("0.2.0", "0.1.14"), "downgraded");
  assertEquals(installAction("0.1.14", "0.1.14"), "unchanged");
  assertEquals(installAction("0.1.14", "0.1.14", true), "reinstalled");
  // Files present but the probe failed: repair them.
  assertEquals(installAction("", "0.1.14", false, true), "reinstalled");
});

Deno.test("version probes read the vendor's own output", () => {
  assertEquals(parseAppVersion("herdr-app 0.1.14\n"), "0.1.14");
  assertEquals(parseAppVersion("noise\nherdr-app v0.2.0\n"), "0.2.0");
  assertEquals(parseAppVersion(""), "");
  // Inside the macOS bundle the same binary is called Herdr.
  assertEquals(parseAppVersion("Herdr 0.1.14\n"), "0.1.14");
  assertEquals(parseCoreVersion("hc 0.1.19\n"), "0.1.19");
  assertEquals(parseCoreVersion("herdr-core v0.1.18\n"), "0.1.18");
  assertEquals(parseCoreVersion("hc 0.1.19\nsecond line"), "0.1.19");
  assertEquals(parseCoreVersion("usage: herdr-core [flags]"), "");
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

Deno.test("layoutFor follows the vendor's Linux layout", () => {
  const layout = layoutFor("linux", HOME);
  assertEquals(layout.appDir, "/home/me/.local/share/herdr-app");
  assertEquals(layout.appBinary, "/home/me/.local/share/herdr-app/herdr-app");
  assertEquals(layout.binDir, "/home/me/.local/bin");
  assertEquals(layout.linkPath, "/home/me/.local/bin/herdr-app");
  assertEquals(
    layout.desktopFile,
    "/home/me/.local/share/applications/herdr-app.desktop",
  );
  assertEquals(layout.corePath, "/home/me/.local/bin/herdr-core");
  assertEquals(layout.hcPath, "/home/me/.local/bin/hc");
  assertEquals(layout.cacheDir, "/home/me/.cache/herdr-app");
});

Deno.test("layoutFor honours XDG directories", () => {
  const layout = layoutFor("linux", {
    home: "/home/me",
    xdgData: "/data/",
    xdgCache: "/cache",
  });
  assertEquals(layout.appDir, "/data/herdr-app");
  assertEquals(layout.desktopFile, "/data/applications/herdr-app.desktop");
  assertEquals(layout.cacheDir, "/cache/herdr-app");
});

Deno.test("layoutFor follows the vendor's macOS layout", () => {
  const layout = layoutFor("macos", HOME);
  assertEquals(layout.appDir, "/home/me/Applications/Herdr.app");
  assertEquals(
    layout.appBinary,
    "/home/me/Applications/Herdr.app/Contents/MacOS/Herdr",
  );
  assertEquals(layout.linkPath, "/home/me/.local/bin/herdr-app");
  assertEquals(layout.desktopFile, "");
  assertEquals(layout.cacheDir, "/home/me/Library/Caches/herdr-app");
});

Deno.test("layoutFor follows the vendor's Windows layout", () => {
  const layout = layoutFor("windows", {
    home: "C:\\Users\\me",
    localAppData: "C:\\Users\\me\\AppData\\Local",
  });
  assertEquals(
    layout.appDir,
    "C:\\Users\\me\\AppData\\Local\\Programs\\herdr-app",
  );
  assertEquals(
    layout.appBinary,
    "C:\\Users\\me\\AppData\\Local\\Programs\\herdr-app\\herdr-app.exe",
  );
  assertEquals(
    layout.corePath,
    "C:\\Users\\me\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe",
  );
  assertEquals(layout.linkPath, "");
});

Deno.test("a moved appDir does not claim the machine's launcher entry", () => {
  const layout = layoutFor("linux", HOME, { appDir: "/opt/herdr" });
  assertEquals(layout.appDir, "/opt/herdr");
  assertEquals(layout.desktopFile, "");
  assertEquals(layout.iconFile, "");
});

Deno.test("desktopEntry points at the real command path", () => {
  const entry = desktopEntry("/home/me/.local/bin/herdr-app");
  assertStringIncludes(entry, "Name=Herdr");
  assertStringIncludes(entry, "Exec=/home/me/.local/bin/herdr-app");
  assertStringIncludes(entry, "Icon=herdr-app");
  assertStringIncludes(entry, "StartupWMClass=herdr-app");
});

// ---------------------------------------------------------------------------
// Windows snippets
// ---------------------------------------------------------------------------

Deno.test("psQuote escapes single quotes, which is all PowerShell needs", () => {
  assertEquals(
    psQuote("C:\\Program Files\\it's"),
    "'C:\\Program Files\\it''s'",
  );
});

Deno.test("the PATH scripts add and remove exactly one directory", () => {
  const add = windowsPathScript(
    "C:\\Users\\me\\AppData\\Local\\Programs\\herdr-app",
  );
  assertStringIncludes(add, 'OpenSubKey("Environment", $true)');
  assertStringIncludes(add, "DoNotExpandEnvironmentNames");
  assertStringIncludes(add, "-ieq $dir.TrimEnd");
  const remove = windowsPathRemoveScript("C:\\Programs\\herdr-core");
  assertStringIncludes(remove, "Where-Object");
  assertStringIncludes(remove, 'SetValue("Path"');
});

Deno.test("the shortcut scripts target the Start menu", () => {
  const create = windowsShortcutScript(
    "C:\\app\\herdr-app.exe",
    "C:\\Users\\me",
  );
  assertStringIncludes(create, 'GetFolderPath("Programs")');
  assertStringIncludes(create, "Herdr.lnk");
  assertStringIncludes(create, "CreateShortcut");
  assertStringIncludes(create, "$link.TargetPath = 'C:\\app\\herdr-app.exe'");
  const remove = windowsShortcutRemoveScript();
  assertStringIncludes(remove, "Remove-Item -Force $menu");
});

Deno.test("encodePowerShell emits UTF-16LE base64 for -EncodedCommand", () => {
  // "Hi" is 0x48 0x69 in UTF-16LE; base64 of those four bytes.
  assertEquals(encodePowerShell("Hi"), btoa("H\u0000i\u0000"));
  // A path with a backslash and a quote survives the round trip.
  const script = windowsShortcutScript("C:\\a b\\it's.exe", "C:\\Users\\me");
  const decoded = atob(encodePowerShell(script));
  let text = "";
  for (let i = 0; i < decoded.length; i += 2) {
    text += String.fromCharCode(
      decoded.charCodeAt(i) | (decoded.charCodeAt(i + 1) << 8),
    );
  }
  assertEquals(text, script);
});

// ---------------------------------------------------------------------------
// The pinned POSIX installer
// ---------------------------------------------------------------------------

const LINUX_PIN = {
  target: "linux-x86_64",
  appUrl:
    "https://releases.herdr.dev/app/0.1.14/herdr-app-linux-x86_64.tar.gz?src=install",
  appSha256: "a".repeat(64),
  coreUrl: "",
  coreSha256: "",
};

const PINS = {
  appVersion: "0.1.14",
  coreVersion: "",
  pins: [LINUX_PIN],
  force: false,
  coreMode: "never" as const,
  verifyCoreSignature: false,
};

Deno.test("renderInstallScript pins the release and quotes values", () => {
  const script = renderInstallScript(PINS);
  assertStringIncludes(script, "APP_VERSION='0.1.14'");
  assertStringIncludes(script, "APP_SHA='aaaaaaaa");
  assertStringIncludes(script, "linux-x86_64)");
  assertStringIncludes(script, "FORCE='0'");
  assertStringIncludes(script, "CORE_MODE='never'");
  // The checksum is compared, never skipped.
  assertStringIncludes(script, '[ "$got" = "$3" ]');
  assertStringIncludes(script, "checksum mismatch");
});

Deno.test("renderInstallScript escapes a single quote in a URL", () => {
  const script = renderInstallScript({
    ...PINS,
    pins: [{ ...LINUX_PIN, appUrl: "https://x/it's.tgz" }],
  });
  assertStringIncludes(script, `APP_URL='https://x/it'\\''s.tgz'`);
});

Deno.test("renderInstallScript carries one pin per platform", () => {
  const script = renderInstallScript({
    ...PINS,
    appVersion: "0.1.14",
    coreVersion: "0.1.19",
    coreMode: "auto",
    pins: [
      LINUX_PIN,
      {
        target: "macos-aarch64",
        appUrl: "https://releases.herdr.dev/app/0.1.14/macos.tgz",
        appSha256: "c".repeat(64),
        coreUrl: "https://releases.herdr.dev/core/0.1.19/macos.tgz",
        coreSha256: "d".repeat(64),
      },
    ],
    verifyCoreSignature: true,
  });
  assertStringIncludes(script, "  linux-x86_64)");
  assertStringIncludes(script, "  macos-aarch64)");
  assertStringIncludes(script, "it pins linux-x86_64, macos-aarch64");
  assertStringIncludes(
    script,
    "CORE_URL='https://releases.herdr.dev/core/0.1.19/macos.tgz'",
  );
});

Deno.test("renderInstallScript marks force and the core signature check", () => {
  const script = renderInstallScript({
    ...PINS,
    force: true,
    coreMode: "always",
    coreVersion: "0.1.19",
    pins: [{
      ...LINUX_PIN,
      coreUrl: "https://releases.herdr.dev/core/0.1.19/core.tar.gz",
      coreSha256: "d".repeat(64),
    }],
    verifyCoreSignature: true,
  });
  assertStringIncludes(script, "FORCE='1'");
  assertStringIncludes(script, "CORE_MODE='always'");
  assertStringIncludes(script, "VERIFY_CORE_SIGNATURE='1'");
});

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");

/** Build a tiny app archive whose `herdr-app` reports `version`. */
async function fakeArchive(
  version: string,
  dir: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const root = await Deno.makeTempDir({ dir });
  await Deno.mkdir(`${root}/herdr-app`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/herdr-app/herdr-app`,
    `#!/bin/sh\necho "herdr-app ${version}"\n`,
  );
  await Deno.chmod(`${root}/herdr-app/herdr-app`, 0o755);
  await Deno.writeTextFile(`${root}/herdr-app/herdr-app.svg`, "<svg/>\n");
  // The installer is shell; proving it works means running tar and sh.
  // swamp-quality-ignore deno-command
  const tar = await new Deno.Command("tar", {
    args: ["-czf", `${root}.tar.gz`, "-C", root, "herdr-app"],
  }).output();
  if (tar.code !== 0) throw new Error("tar failed");
  const bytes = await Deno.readFile(`${root}.tar.gz`);
  return { bytes, sha256: await sha256Hex(bytes) };
}

/** A temp HOME, a fake `curl` that serves `archive`, and the script's runner. */
async function harness(
  dir: string,
  opts: {
    version: string;
    archive: Uint8Array;
    sha256: string;
    target?: string;
  },
): Promise<{
  home: string;
  run: () => Promise<{ code: number; stdout: string; stderr: string }>;
}> {
  await Deno.writeFile(`${dir}/app.tar.gz`, opts.archive);
  const fakeBin = `${dir}/bin`;
  await Deno.mkdir(fakeBin, { recursive: true });
  // A stand-in for curl: the URL is ignored, the staged file is copied.
  await Deno.writeTextFile(
    `${fakeBin}/curl`,
    `#!/bin/sh\nout=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\ncp "${dir}/app.tar.gz" "$out"\n`,
  );
  await Deno.chmod(`${fakeBin}/curl`, 0o755);
  const home = `${dir}/home`;
  await Deno.mkdir(home, { recursive: true });
  const scriptPath = `${dir}/install.sh`;
  await Deno.writeTextFile(
    scriptPath,
    renderInstallScript({
      ...PINS,
      appVersion: opts.version,
      pins: [{
        ...LINUX_PIN,
        target: opts.target ?? LINUX_PIN.target,
        appSha256: opts.sha256,
      }],
    }),
  );
  return {
    home,
    run: async () => {
      // swamp-quality-ignore deno-command
      const out = await new Deno.Command("sh", {
        args: [scriptPath],
        env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` },
        clearEnv: true,
      }).output();
      const decoder = new TextDecoder();
      return {
        code: out.code,
        stdout: decoder.decode(out.stdout),
        stderr: decoder.decode(out.stderr),
      };
    },
  };
}

if (Deno.build.os === "linux" || Deno.build.os === "darwin") {
  Deno.test("the rendered installer installs, then reports unchanged", async () => {
    const dir = await Deno.makeTempDir({ prefix: "herdr-script-" });
    try {
      const archive = await fakeArchive("0.1.14", dir);
      const { home, run } = await harness(dir, {
        version: "0.1.14",
        archive: archive.bytes,
        sha256: archive.sha256,
      });

      const first = await run();
      assertEquals(first.code, 0, first.stderr);
      assertStringIncludes(first.stdout, "herdr-app 0.1.14 installed");
      assertStringIncludes(first.stdout, "herdr-app-action: installed");
      const appDir = `${home}/.local/share/herdr-app`;
      assertEquals(
        (await Deno.readTextFile(`${appDir}/herdr-app`)).includes("0.1.14"),
        true,
      );
      const link = await Deno.readLink(`${home}/.local/bin/herdr-app`);
      assertEquals(link, `${appDir}/herdr-app`);
      assertStringIncludes(
        await Deno.readTextFile(
          `${home}/.local/share/applications/herdr-app.desktop`,
        ),
        `Exec=${home}/.local/bin/herdr-app`,
      );

      const second = await run();
      assertEquals(second.code, 0, second.stderr);
      assertStringIncludes(second.stdout, "already installed");
      assertStringIncludes(second.stdout, "herdr-app-action: unchanged");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  Deno.test("the rendered installer refuses a wrong-platform host", async () => {
    const dir = await Deno.makeTempDir({ prefix: "herdr-script-" });
    try {
      const archive = await fakeArchive("0.1.14", dir);
      const { run } = await harness(dir, {
        version: "0.1.14",
        archive: archive.bytes,
        sha256: archive.sha256,
        target: "macos-aarch64",
      });
      const out = await run();
      assertEquals(out.code, 1);
      assertStringIncludes(
        out.stderr,
        "this installer has no pinned build for linux-x86_64 (it pins macos-aarch64)",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  Deno.test("a damaged download fails the script and installs nothing", async () => {
    const dir = await Deno.makeTempDir({ prefix: "herdr-script-" });
    try {
      const archive = await fakeArchive("0.1.14", dir);
      const { home, run } = await harness(dir, {
        version: "0.1.14",
        archive: archive.bytes,
        sha256: "b".repeat(64),
      });
      const out = await run();
      assertEquals(out.code, 1);
      assertStringIncludes(out.stderr, "checksum mismatch");
      await assertRejects(
        () => Deno.lstat(`${home}/.local/share/herdr-app`),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
