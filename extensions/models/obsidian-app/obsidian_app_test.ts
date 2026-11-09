/**
 * Unit tests for {@link @svendowideit/obsidian-app}.
 *
 * Everything here drives the pure helpers and the host operations in
 * `obsidian_app_shared.ts` through an in-memory {@link Deps}, so the tests need
 * no Obsidian install, no network and no root.
 */

import {
  assetPatternFor,
  buildSummary,
  type CliInfo,
  compareVersions,
  type Config,
  desktopEntryBody,
  desktopEntryPath,
  detectStatus,
  expandHome,
  firstDirWithName,
  installArchive,
  interpretSandboxProbe,
  isDirOnPath,
  joinPath,
  latestAppPackageVersion,
  normaliseConfig,
  normaliseVersion,
  noSandboxWrapperBody,
  parseAppConfig,
  parseAppPackageVersions,
  parseCliVersionOutput,
  planAsset,
  planSandbox,
  probeSandbox,
  registerCli,
  resolvedSandboxRoute,
  sandboxMountHint,
  sandboxRoute,
  sha256FromDigest,
  shellQuote,
  type StatusInfo,
  statusNotes,
  userNamespacesRestricted,
  verifySandbox,
  versionsEqual,
  withCliEnabled,
} from "./obsidian_app_shared.ts";
import type { Deps, RunResult } from "./obsidian_app_shared.ts";

// ---------------------------------------------------------------------------
// In-memory host
// ---------------------------------------------------------------------------

interface FakeHostOptions {
  files?: Record<string, string>;
  failWrites?: string[];
  dirs?: Record<string, string[]>;
  modes?: Record<string, number>;
  env?: Record<string, string>;
  runs?: Record<string, RunResult>;
  pids?: Record<string, number[]>;
  uids?: Record<string, number>;
  platform?: "linux" | "darwin" | "other";
  arch?: "x64" | "arm64" | "other";
}

/** Build a {@link Deps} backed by an in-memory filesystem and scripted runs. */
function fakeDeps(opts: FakeHostOptions = {}): {
  deps: Deps;
  files: Map<string, string>;
  copies: string[];
  removed: string[];
} {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const modes = new Map<string, number>(Object.entries(opts.modes ?? {}));
  const uids = new Map<string, number>(Object.entries(opts.uids ?? {}));
  const removed: string[] = [];
  const dirs = new Map<string, string[]>(Object.entries(opts.dirs ?? {}));
  const runs = opts.runs ?? {};
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ...(opts.env ?? {}),
  };
  const copies: string[] = [];
  const failWrites = new Set(opts.failWrites ?? []);
  const deps: Deps = {
    run: (bin, args) => {
      const key = `${bin} ${args.join(" ")}`;
      return Promise.resolve(
        runs[key] ?? { code: 127, stdout: "", stderr: `no fake for ${key}` },
      );
    },
    readText: (path) => Promise.resolve(files.get(path) ?? ""),
    writeText: (path, data) => {
      if (failWrites.has(path)) return Promise.resolve(false);
      files.set(path, data);
      return Promise.resolve(true);
    },
    exists: (path) =>
      Promise.resolve(files.has(path) || modes.has(path) || dirs.has(path)),
    mkdirp: (path) => {
      if (!dirs.has(path)) dirs.set(path, []);
      return Promise.resolve();
    },
    readDir: (path) => Promise.resolve(dirs.get(path) ?? []),
    copy: (from, to) => {
      const body = files.get(from);
      if (body === undefined) return Promise.reject(new Error(`no ${from}`));
      files.set(to, body);
      copies.push(`${from} -> ${to}`);
      return Promise.resolve();
    },
    chmod: (path, mode) => {
      modes.set(path, mode);
      return Promise.resolve();
    },
    remove: (path) => {
      removed.push(path);
      files.delete(path);
      modes.delete(path);
      return Promise.resolve();
    },
    fileMode: (path) => Promise.resolve(modes.get(path) ?? null),
    fileUid: (path) => Promise.resolve(uids.get(path) ?? null),
    sha256File: (path) => Promise.resolve(files.get(path) ?? `missing:${path}`),
    sha256Hex: (bytes) => Promise.resolve(`bytes:${bytes.length}`),
    env: (key) => env[key],
    home: () => "/home/me",
    platform: () => opts.platform ?? "linux",
    arch: () => opts.arch ?? "x64",
    now: () => "2026-11-09T00:00:00.000Z",
    pids: (name) => Promise.resolve(opts.pids?.[name] ?? []),
  };
  return { deps, files, copies, removed };
}

/** A config with every default resolved for `/home/me`. */
function config(overrides: Partial<Config> = {}): Config {
  return {
    ...normaliseConfig({}, { home: "/home/me", platform: "linux" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("normaliseConfig applies defaults and honours XDG_CONFIG_HOME", () => {
  const cfg = normaliseConfig({}, {
    home: "/home/me",
    xdgConfigHome: "/xdg",
    platform: "linux",
  });
  if (cfg.installMode !== "tar") throw new Error("installMode");
  if (cfg.installDir !== "/home/me/.local/share/obsidian") {
    throw new Error(`installDir ${cfg.installDir}`);
  }
  if (cfg.cliDir !== "/home/me/.local/bin") throw new Error("cliDir");
  if (cfg.appConfigDir !== "/xdg/obsidian") throw new Error("appConfigDir");
  if (cfg.downloadDir !== "/home/me/.cache/obsidian-app") {
    throw new Error("downloadDir");
  }
  if (cfg.repo !== "obsidianmd/obsidian-releases") throw new Error("repo");
  if (cfg.desktopEntry !== true || cfg.enableCli !== true) {
    throw new Error("booleans");
  }
});

Deno.test("normaliseConfig expands ~ and keeps explicit paths", () => {
  const cfg = normaliseConfig(
    {
      installDir: "~/opt/obsidian",
      cliDir: "/opt/bin",
      appConfigDir: "~/.config/obsidian",
      repo: "fork/obsidian-releases",
    },
    { home: "/home/me", platform: "linux" },
  );
  if (cfg.installDir !== "/home/me/opt/obsidian") throw new Error("installDir");
  if (cfg.cliDir !== "/opt/bin") throw new Error("cliDir");
  if (cfg.appConfigDir !== "/home/me/.config/obsidian") {
    throw new Error("appConfigDir");
  }
  if (cfg.repo !== "fork/obsidian-releases") throw new Error("repo");
});

Deno.test("expandHome and joinPath handle edges", () => {
  if (expandHome("", "/home/me") !== "") throw new Error("empty");
  if (expandHome("~", "/home/me") !== "/home/me") throw new Error("tilde");
  if (expandHome("/abs", "/home/me") !== "/abs") throw new Error("absolute");
  if (joinPath("/a/", "/b/", "c") !== "/a/b/c") throw new Error("join");
  if (joinPath("/a", "") !== "/a") throw new Error("empty segment");
});

Deno.test("versions compare numerically and ignore a leading v", () => {
  if (normaliseVersion(" v1.15.0 ") !== "1.15.0") throw new Error("normalise");
  if (compareVersions("1.9.0", "1.15.0") !== -1) throw new Error("<");
  if (compareVersions("1.15.0", "1.15.0") !== 0) throw new Error("=");
  if (compareVersions("v2", "1.99.99") !== 1) throw new Error(">");
  if (!versionsEqual("v1.12.7", "1.12.7")) throw new Error("equal");
});

Deno.test("sha256FromDigest accepts only a sha256: hex digest", () => {
  const hex = "a".repeat(64);
  if (sha256FromDigest(`sha256:${hex}`) !== hex) throw new Error("sha256");
  if (sha256FromDigest(`SHA256:${hex.toUpperCase()}`) !== hex) {
    throw new Error("uppercase");
  }
  if (sha256FromDigest(`sha512:${hex}`) !== "") throw new Error("wrong algo");
  if (sha256FromDigest("not-a-digest") !== "") throw new Error("garbage");
  if (sha256FromDigest(undefined) !== "") throw new Error("undefined");
  if (sha256FromDigest(`sha256:abc`) !== "") throw new Error("short");
});

Deno.test("parseAppConfig reads vaults and the cli flag", () => {
  const parsed = parseAppConfig(
    JSON.stringify({
      vaults: {
        b: { path: "/vaults/b", ts: 1, open: true },
        a: { path: "/vaults/a", ts: 2 },
        broken: {},
      },
      cli: true,
    }),
  );
  if (parsed.vaults.join("|") !== "/vaults/a|/vaults/b") {
    throw new Error("vaults");
  }
  if (parsed.cli !== true) throw new Error("cli");
  if (parseAppConfig("").cli !== null) throw new Error("empty");
  if (parseAppConfig("not json").vaults.length !== 0) throw new Error("bad");
});

Deno.test("withCliEnabled turns cli on, preserves keys, and is idempotent", () => {
  const before = JSON.stringify({ vaults: { a: { path: "/a" } } });
  const edit = withCliEnabled(before);
  if (!edit.changed) throw new Error("expected a change");
  const after = JSON.parse(edit.text);
  if (after.cli !== true) throw new Error("cli not set");
  if (after.vaults.a.path !== "/a") throw new Error("vaults lost");
  const again = withCliEnabled(edit.text);
  if (again.changed) throw new Error("not idempotent");
  const garbage = withCliEnabled("{oops");
  if (garbage.changed || garbage.text !== "{oops") throw new Error("clobbered");
});

Deno.test("app package versions parse and sort numerically", () => {
  const versions = parseAppPackageVersions([
    "obsidian-1.9.14.asar",
    "obsidian-1.15.0.asar",
    "obsidian.json",
    "obsidian-1.10.3.asar",
  ]);
  if (versions.join("|") !== "1.9.14|1.10.3|1.15.0") {
    throw new Error(versions.join("|"));
  }
  if (latestAppPackageVersion(["obsidian-1.9.0.asar"]) !== "1.9.0") {
    throw new Error("latest");
  }
  if (latestAppPackageVersion(["obsidian.json"]) !== "") {
    throw new Error("none");
  }
});

Deno.test("parseCliVersionOutput reads app and installer versions", () => {
  const parsed = parseCliVersionOutput("1.15.0 (installer 1.15.0)\n");
  if (parsed.appVersion !== "1.15.0") throw new Error("app");
  if (parsed.installerVersion !== "1.15.0") throw new Error("installer");
  const legacy = parseCliVersionOutput("obsidian-cli v1.3.0");
  if (legacy.appVersion !== "" || legacy.installerVersion !== "") {
    throw new Error("legacy should not parse as versions");
  }
  if (parseCliVersionOutput("").appVersion !== "") throw new Error("empty");
});

Deno.test("assetPatternFor and selection pick the platform archive", () => {
  if (assetPatternFor("tar", "x64")?.test("obsidian-1.15.0.tar.gz") !== true) {
    throw new Error("x64 tar");
  }
  if (assetPatternFor("tar", "x64")?.test("obsidian-1.15.0-arm64.tar.gz")) {
    throw new Error("x64 must not match arm64");
  }
  if (
    assetPatternFor("tar", "arm64")?.test("obsidian-1.15.0-arm64.tar.gz") !==
      true
  ) {
    throw new Error("arm64 tar");
  }
  if (assetPatternFor("deb", "x64") !== null) {
    throw new Error("deb unsupported");
  }
});

Deno.test("planAsset picks the right archive and records its digest", () => {
  const hex = "b".repeat(64);
  const release = {
    version: "1.15.0",
    tag: "v1.15.0",
    assets: [
      { name: "Obsidian-1.15.0.dmg", url: "https://x/dmg" },
      { name: "obsidian_1.15.0_amd64.deb", url: "https://x/deb" },
      {
        name: "obsidian-1.15.0.tar.gz",
        url: "https://x/tar",
        size: 130671000,
        digest: `sha256:${hex}`,
      },
      {
        name: "obsidian-1.15.0-arm64.tar.gz",
        url: "https://x/arm",
      },
    ],
  };
  const x64 = planAsset(release, config(), {
    arch: "x64",
    platform: "linux",
    releaseModel: "github-release",
    now: "now",
  });
  if (x64.archiveName !== "obsidian-1.15.0.tar.gz") {
    throw new Error(x64.archiveName);
  }
  if (x64.downloadUrl !== "https://x/tar") throw new Error("url");
  if (x64.checksum !== hex) throw new Error("checksum");
  if (x64.checksumAlgorithm !== "sha256") throw new Error("algorithm");
  if (x64.size !== 130671000) throw new Error("size");
  if (x64.version !== "1.15.0") throw new Error("version");
  if (x64.releaseTag !== "v1.15.0") throw new Error("tag");

  const arm = planAsset(release, config(), {
    arch: "arm64",
    platform: "linux",
    releaseModel: "github-release",
    now: "now",
  });
  if (arm.archiveName !== "obsidian-1.15.0-arm64.tar.gz") {
    throw new Error(arm.archiveName);
  }
  if (arm.checksum !== "") throw new Error("arm checksum should be empty");
});

Deno.test("planAsset rejects non-Linux hosts, unknown modes and missing assets", () => {
  const release = { version: "1.15.0", assets: [], sourceUrl: "" };
  const host = { arch: "x64", platform: "darwin", releaseModel: "r", now: "n" };
  let threw = 0;
  const expectThrow = (fn: () => unknown, needle: string) => {
    try {
      fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(needle)) {
        throw new Error(`expected "${needle}" in "${message}"`);
      }
      threw++;
      return;
    }
    throw new Error(`expected a throw mentioning "${needle}"`);
  };
  expectThrow(() => planAsset(release, config(), host), "Linux");
  expectThrow(
    () =>
      planAsset(release, config({ installMode: "deb" }), {
        ...host,
        platform: "linux",
      }),
    "not supported",
  );
  expectThrow(
    () =>
      planAsset({ version: "", assets: [] }, config(), {
        ...host,
        platform: "linux",
      }),
    "no version",
  );
  expectThrow(
    () => planAsset(release, config(), { ...host, platform: "linux" }),
    "ships no",
  );
  expectThrow(
    () =>
      planAsset(release, config(), {
        ...host,
        platform: "linux",
        arch: "riscv",
      }),
    "Unsupported CPU architecture",
  );
  if (threw !== 5) throw new Error(`threw ${threw}`);
});

Deno.test("PATH helpers report the resolving directory", async () => {
  if (isDirOnPath("/usr/bin", "/usr/local/bin:/usr/bin:/bin") !== true) {
    throw new Error("on path");
  }
  if (isDirOnPath("/usr/bin/", "/usr/bin") !== true) throw new Error("slash");
  if (isDirOnPath("/opt/bin", "/usr/bin") !== false) {
    throw new Error("off path");
  }
  const dir = await firstDirWithName(
    "obsidian",
    "/usr/bin:/home/me/.local/bin",
    (path) => Promise.resolve(path === "/home/me/.local/bin/obsidian"),
  );
  if (dir !== "/home/me/.local/bin") throw new Error(dir);
  const missing = await firstDirWithName(
    "obsidian",
    "/usr/bin",
    () => Promise.resolve(false),
  );
  if (missing !== "") throw new Error("missing should be empty");
});

Deno.test("desktop entry points at the install directory", () => {
  const body = desktopEntryBody("/home/me/.local/share/obsidian");
  if (!body.includes("Exec=/home/me/.local/share/obsidian/obsidian %U")) {
    throw new Error(body);
  }
  if (!body.includes("StartupWMClass=obsidian")) throw new Error("wmclass");
  if (!body.endsWith("\n")) throw new Error("newline");
  const { deps } = fakeDeps();
  if (
    desktopEntryPath(deps) !==
      "/home/me/.local/share/applications/obsidian.desktop"
  ) {
    throw new Error(desktopEntryPath(deps));
  }
});

// ---------------------------------------------------------------------------
// detectStatus
// ---------------------------------------------------------------------------

Deno.test("detectStatus reports a pre-CLI install and a shadowing system package", async () => {
  const cfg = config();
  const { deps } = fakeDeps({
    files: {
      "/home/me/.local/share/obsidian/obsidian": "bin",
      "/home/me/.local/share/obsidian/resources/app.asar": "asar",
      "/home/me/.config/obsidian/obsidian.json": JSON.stringify({
        vaults: { v: { path: "/home/me/vault" } },
        cli: true,
      }),
    },
    modes: { "/home/me/.local/share/obsidian/obsidian": 0o755 },
    dirs: {
      "/home/me/.config/obsidian": [
        "obsidian.json",
        "obsidian-1.15.0.asar",
      ],
    },
    env: { PATH: "/usr/bin:/home/me/.local/bin" },
    runs: {
      "dpkg-query -W -f=${Version} obsidian": {
        code: 0,
        stdout: "1.10.3\n",
        stderr: "",
      },
    },
  });
  const status = await detectStatus(deps, cfg);
  if (!status.installed) throw new Error("installed");
  if (status.installedVersion !== "") throw new Error("no marker version");
  if (status.cliSourcePresent) throw new Error("cli source should be absent");
  if (status.cliRegistered) throw new Error("no CLI file in this fixture");
  if (status.cliReachable) throw new Error("cli must not be reachable yet");
  if (status.appPackageVersion !== "1.15.0") throw new Error("package version");
  if (status.systemPackageVersion !== "1.10.3") throw new Error("dpkg");
  if (status.vaults.join("|") !== "/home/me/vault") throw new Error("vaults");
  const joined = status.notes.join(" ");
  if (!joined.includes("predates the Obsidian CLI")) throw new Error(joined);
  if (!joined.includes("sudo apt remove obsidian")) throw new Error(joined);
});

Deno.test("detectStatus reports an absent install with the command to fix it", async () => {
  const cfg = config();
  const { deps } = fakeDeps();
  const status = await detectStatus(deps, cfg);
  if (status.installed) throw new Error("installed");
  if (status.cliFlag !== null) throw new Error("flag");
  const joined = status.notes.join(" ");
  if (
    !joined.includes("swamp workflow run @svendowideit/obsidian-app-upgrade")
  ) {
    throw new Error(joined);
  }
  if (joined.includes("<")) throw new Error("placeholder in notes");
});

Deno.test("statusNotes flags an off cli setting and an off-PATH cli dir", () => {
  const cfg = config({ cliDir: "/opt/cli" });
  const base: StatusInfo = {
    platform: "linux",
    arch: "x64",
    installMode: "tar",
    installDir: cfg.installDir,
    cliDir: cfg.cliDir,
    appConfigDir: cfg.appConfigDir,
    installed: true,
    installedVersion: "1.15.0",
    binaryPath: `${cfg.installDir}/obsidian`,
    cliSourcePath: `${cfg.installDir}/obsidian-cli`,
    cliSourcePresent: true,
    appPackageVersion: "1.15.0",
    systemPackageVersion: "",
    vaults: [],
    appRunning: false,
    cliPath: "/opt/cli/obsidian",
    cliRegistered: true,
    cliExecutable: true,
    cliDirOnPath: false,
    cliFirstOnPathDir: "",
    cliReachable: false,
    cliFlag: false,
    desktopEntryPresent: true,
    sandboxHelperPresent: true,
    sandboxHelperMode: 0o100755,
    sandboxHelperOwnerUid: 1000,
    sandboxHelperSetuidRoot: false,
    sandboxUsernsRestricted: false,
    checkedAt: "now",
    notes: [],
  };
  const notes = statusNotes(base, cfg).join(" ");
  if (!notes.includes("cli setting is off")) throw new Error(notes);
  if (!notes.includes("/opt/cli is not on PATH")) throw new Error(notes);
});

// ---------------------------------------------------------------------------
// installArchive
// ---------------------------------------------------------------------------

Deno.test("installArchive unpacks, verifies, chmods and records the version", async () => {
  const cfg = config();
  const checksum = "c".repeat(64);
  const archive = "/home/me/.cache/obsidian-app/obsidian-1.15.0.tar.gz";
  const { deps, files } = fakeDeps({
    files: {
      [archive]: checksum,
      [`${cfg.installDir}/obsidian`]: "bin",
      [`${cfg.installDir}/obsidian-cli`]: "cli",
      [`${cfg.installDir}/resources/app.asar`]: "asar",
    },
    runs: {
      [`tar -xzf ${archive} -C ${cfg.installDir} --strip-components=1`]: {
        code: 0,
        stdout: "",
        stderr: "",
      },
    },
  });
  const info = await installArchive(deps, cfg, {
    archivePath: archive,
    archiveName: "obsidian-1.15.0.tar.gz",
    version: "1.15.0",
    checksum,
    force: false,
  });
  if (info.skipped) throw new Error("should not skip");
  if (!info.verified) throw new Error("verified");
  if (!info.checksumVerified) throw new Error("checksum");
  if (info.installedVersion !== "1.15.0") throw new Error("version");
  if (!info.desktopEntry) throw new Error("desktop entry");
  const marker = JSON.parse(
    files.get(`${cfg.installDir}/.swamp-obsidian-app.json`)!,
  );
  if (marker.version !== "1.15.0") throw new Error("marker");
  const entry = files.get(
    "/home/me/.local/share/applications/obsidian.desktop",
  );
  if (!entry || !entry.includes(`${cfg.installDir}/obsidian %U`)) {
    throw new Error("desktop entry body");
  }
});

Deno.test("installArchive is idempotent for an installed version", async () => {
  const cfg = config();
  const { deps } = fakeDeps({
    files: {
      "/home/me/.cache/obsidian-app/obsidian-1.15.0.tar.gz": "archive",
      [`${cfg.installDir}/obsidian`]: "bin",
      [`${cfg.installDir}/obsidian-cli`]: "cli",
      [`${cfg.installDir}/resources/app.asar`]: "asar",
      [`${cfg.installDir}/.swamp-obsidian-app.json`]: JSON.stringify({
        version: "1.15.0",
      }),
    },
  });
  const info = await installArchive(deps, cfg, {
    archivePath: "/home/me/.cache/obsidian-app/obsidian-1.15.0.tar.gz",
    archiveName: "obsidian-1.15.0.tar.gz",
    version: "1.15.0",
    checksum: "",
    force: false,
  });
  if (!info.skipped) throw new Error("should skip");
  if (!info.verified) throw new Error("verified");
  if (!info.message.includes("already installed")) {
    throw new Error(info.message);
  }
});

Deno.test("installArchive refuses a checksum mismatch", async () => {
  const cfg = config();
  const archive = "/tmp/obsidian-1.15.0.tar.gz";
  const { deps } = fakeDeps({ files: { [archive]: "actual-bytes" } });
  let message = "";
  try {
    await installArchive(deps, cfg, {
      archivePath: archive,
      archiveName: "obsidian-1.15.0.tar.gz",
      version: "1.15.0",
      checksum: "d".repeat(64),
      force: true,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("checksum mismatch")) throw new Error(message);
});

Deno.test("installArchive stops when the unpack fails or the layout is incomplete", async () => {
  const cfg = config();
  const archive = "/tmp/obsidian-1.15.0.tar.gz";
  const failing = fakeDeps({
    files: { [archive]: "archive" },
    runs: {
      [`tar -xzf ${archive} -C ${cfg.installDir} --strip-components=1`]: {
        code: 2,
        stdout: "",
        stderr: "gzip: stdin: not in gzip format",
      },
    },
  });
  let message = "";
  try {
    await installArchive(failing.deps, cfg, {
      archivePath: archive,
      archiveName: "obsidian-1.15.0.tar.gz",
      version: "1.15.0",
      checksum: "",
      force: true,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("not in gzip format")) throw new Error(message);

  // A tar that unpacks nothing at all must not be reported as installed.
  const empty = fakeDeps({
    files: { [archive]: "archive" },
    runs: {
      [`tar -xzf ${archive} -C ${cfg.installDir} --strip-components=1`]: {
        code: 0,
        stdout: "",
        stderr: "",
      },
    },
  });
  let layoutMessage = "";
  try {
    await installArchive(empty.deps, cfg, {
      archivePath: archive,
      archiveName: "obsidian-1.15.0.tar.gz",
      version: "1.15.0",
      checksum: "",
      force: true,
    });
  } catch (error) {
    layoutMessage = error instanceof Error ? error.message : String(error);
  }
  if (!layoutMessage.includes("install is incomplete")) {
    throw new Error(layoutMessage);
  }
  if (!layoutMessage.includes("obsidian-cli")) throw new Error(layoutMessage);
});

Deno.test("installArchive fails loudly when it cannot record the version", async () => {
  const cfg = config();
  const archive = "/tmp/obsidian-1.15.0.tar.gz";
  const marker = `${cfg.installDir}/.swamp-obsidian-app.json`;
  const { deps } = fakeDeps({
    files: {
      [archive]: "archive",
      [`${cfg.installDir}/obsidian`]: "bin",
      [`${cfg.installDir}/obsidian-cli`]: "cli",
      [`${cfg.installDir}/resources/app.asar`]: "asar",
    },
    failWrites: [marker],
    runs: {
      [`tar -xzf ${archive} -C ${cfg.installDir} --strip-components=1`]: {
        code: 0,
        stdout: "",
        stderr: "",
      },
    },
  });
  let message = "";
  try {
    await installArchive(deps, cfg, {
      archivePath: archive,
      archiveName: "obsidian-1.15.0.tar.gz",
      version: "1.15.0",
      checksum: "",
      force: true,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("could not record the version")) {
    throw new Error(message);
  }
});

Deno.test("registerCli leaves obsidian.json alone when it cannot back it up", async () => {
  const cfg = config();
  const configPath = `${cfg.appConfigDir}/obsidian.json`;
  const { deps, files } = fakeDeps({
    files: {
      [`${cfg.installDir}/obsidian-cli`]: "cli-binary",
      [configPath]: JSON.stringify({ vaults: {}, cli: false }),
    },
    failWrites: [`${configPath}.pre-cli-2026-11-09T00-00-00-000Z`],
    env: { PATH: "/home/me/.local/bin" },
  });
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (info.flagChanged) throw new Error("must not change without a backup");
  if (!info.note.includes("Could not back up")) throw new Error(info.note);
  if (files.get(configPath) !== JSON.stringify({ vaults: {}, cli: false })) {
    throw new Error("config was clobbered");
  }
});

Deno.test("installArchive rejects an unsupported mode, platform and empty archive path", async () => {
  const cfg = config();
  const host = fakeDeps({
    runs: {
      "tar -xzf /tmp/a.tar.gz -C /home/me/.local/share/obsidian --strip-components=1":
        { code: 0, stdout: "", stderr: "" },
    },
  });
  const cases: Array<[() => Promise<unknown>, string]> = [
    [
      () =>
        installArchive(host.deps, config({ installMode: "deb" }), {
          archivePath: "/tmp/a.tar.gz",
          archiveName: "a.tar.gz",
          version: "1.15.0",
          checksum: "",
          force: true,
        }),
      "not supported",
    ],
    [
      () =>
        installArchive(host.deps, cfg, {
          archivePath: "",
          archiveName: "",
          version: "1.15.0",
          checksum: "",
          force: true,
        }),
      "verified archive path",
    ],
    [
      () =>
        installArchive(host.deps, cfg, {
          archivePath: "/tmp/missing.tar.gz",
          archiveName: "missing.tar.gz",
          version: "1.15.0",
          checksum: "",
          force: true,
        }),
      "Archive not found",
    ],
  ];
  for (const [fn, needle] of cases) {
    let message = "";
    try {
      await fn();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes(needle)) throw new Error(`${needle}: ${message}`);
  }
});

// ---------------------------------------------------------------------------
// registerCli
// ---------------------------------------------------------------------------

Deno.test("registerCli copies the CLI and enables the flag", async () => {
  const cfg = config();
  const source = `${cfg.installDir}/obsidian-cli`;
  const { deps, files, copies } = fakeDeps({
    files: {
      [source]: "cli-binary",
      [`${cfg.appConfigDir}/obsidian.json`]: JSON.stringify({
        vaults: { v: { path: "/home/me/vault" } },
      }),
    },
    modes: { [`${cfg.cliDir}/obsidian`]: 0o644 },
    env: { PATH: "/home/me/.local/bin:/usr/bin" },
  });
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (!info.registered) throw new Error("registered");
  if (!info.reachable) throw new Error("reachable");
  if (!info.onPath) throw new Error("onPath");
  if (info.verified) {
    throw new Error("must not run the CLI when the app is down");
  }
  if (!info.note.includes("Obsidian is not running")) {
    throw new Error(info.note);
  }
  if (info.flag !== true || !info.flagChanged) throw new Error("flag");
  if (!info.backupPath.includes("obsidian.json.pre-cli-")) {
    throw new Error(info.backupPath);
  }
  if (!files.get(info.backupPath)?.includes("/home/me/vault")) {
    throw new Error("backup body");
  }
  if ((await deps.fileMode(`${cfg.cliDir}/obsidian`)) !== 0o755) {
    throw new Error("mode");
  }
  if (copies.length !== 1) throw new Error(`copies ${copies.length}`);
});

Deno.test("registerCli verifies the CLI with `obsidian version` when the app runs", async () => {
  const cfg = config();
  const { deps } = fakeDeps({
    files: {
      [`${cfg.installDir}/obsidian-cli`]: "cli-binary",
      [`${cfg.appConfigDir}/obsidian.json`]: '{"cli":true}',
    },
    pids: { obsidian: [4321] },
    env: { PATH: "/home/me/.local/bin:/usr/bin" },
    runs: {
      [`${cfg.cliDir}/obsidian version`]: {
        code: 0,
        stdout: "1.15.0 (installer 1.15.0)",
        stderr: "",
      },
    },
  });
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (!info.verified) throw new Error("verified");
  if (info.installerVersion !== "1.15.0") {
    throw new Error(info.installerVersion);
  }
  if (info.reportedVersion !== "1.15.0 (installer 1.15.0)") {
    throw new Error(info.reportedVersion);
  }
  if (info.flag !== true || info.flagChanged) throw new Error("flag");
  if (!info.reachable) throw new Error("reachable");
});

Deno.test("registerCli reports a CLI that answers but is not the official one", async () => {
  const cfg = config();
  const { deps } = fakeDeps({
    files: {
      [`${cfg.installDir}/obsidian-cli`]: "cli-binary",
      [`${cfg.appConfigDir}/obsidian.json`]: '{"cli":true}',
    },
    pids: { obsidian: [1] },
    env: { PATH: "/home/me/.local/bin" },
    runs: {
      [`${cfg.cliDir}/obsidian version`]: {
        code: 0,
        stdout: "obsidian-cli v1.3.0",
        stderr: "",
      },
    },
  });
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (info.verified) throw new Error("must not verify a legacy CLI");
  if (!info.note.includes("does not look like the official CLI")) {
    throw new Error(info.note);
  }
});

Deno.test("registerCli reports a failing CLI invocation", async () => {
  const cfg = config();
  const { deps } = fakeDeps({
    files: {
      [`${cfg.installDir}/obsidian-cli`]: "cli-binary",
      [`${cfg.appConfigDir}/obsidian.json`]: '{"cli":true}',
    },
    pids: { obsidian: [1] },
    env: { PATH: "/home/me/.local/bin" },
    runs: {
      [`${cfg.cliDir}/obsidian version`]: {
        code: 1,
        stdout: "",
        stderr: "Error: the app is not listening",
      },
    },
  });
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (info.verified) throw new Error("must not verify a failure");
  if (!info.note.includes("the app is not listening")) {
    throw new Error(info.note);
  }
});

Deno.test("registerCli refuses to invent a cli setting while the app runs", async () => {
  const cfg = config();
  const { deps } = fakeDeps({
    files: {
      [`${cfg.installDir}/obsidian-cli`]: "cli-binary",
      [`${cfg.appConfigDir}/obsidian.json`]: '{"vaults":{}}',
    },
    pids: { obsidian: [1] },
    env: { PATH: "/usr/bin" },
  });
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (info.flagChanged) throw new Error("must not change while running");
  if (!info.note.includes("left alone")) throw new Error(info.note);
  if (!info.note.includes("Add /home/me/.local/bin to PATH")) {
    throw new Error(info.note);
  }
  if (info.verified) throw new Error("should not run while verifying");
});

Deno.test("registerCli reports a shadowing binary instead of claiming success", async () => {
  const cfg = config();
  const { deps, files } = fakeDeps({
    files: {
      [`${cfg.installDir}/obsidian-cli`]: "cli-binary",
      "/usr/bin/obsidian": "gui-binary",
    },
    env: { PATH: "/usr/bin:/home/me/.local/bin" },
  });
  files.set(`${cfg.cliDir}/obsidian`, "cli-binary");
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (info.reachable) throw new Error("must not claim reachability");
  if (info.firstOnPathDir !== "/usr/bin") throw new Error(info.firstOnPathDir);
  if (!info.note.includes("/usr/bin/obsidian")) throw new Error(info.note);
  if (info.verified) throw new Error("not verified without the app");
});

Deno.test("registerCli errors clearly when the installer ships no CLI", async () => {
  const cfg = config();
  const { deps } = fakeDeps();
  let message = "";
  try {
    await registerCli(deps, cfg, { sourcePath: "", force: false });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("No obsidian-cli binary found")) {
    throw new Error(message);
  }
  if (!message.includes("obsidian-app-upgrade")) throw new Error(message);
});

Deno.test("registerCli falls back to a system package's obsidian-cli", async () => {
  const cfg = config();
  const { deps } = fakeDeps({
    files: { "/opt/Obsidian/obsidian-cli": "cli-binary" },
    env: { PATH: "/usr/bin" },
  });
  const info = await registerCli(deps, cfg, { sourcePath: "", force: false });
  if (info.sourcePath !== "/opt/Obsidian/obsidian-cli") {
    throw new Error(info.sourcePath);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

Deno.test("buildSummary reports the verified state and pending notes", () => {
  const cfg = config();
  const status: StatusInfo = {
    platform: "linux",
    arch: "x64",
    installMode: "tar",
    installDir: cfg.installDir,
    cliDir: cfg.cliDir,
    appConfigDir: cfg.appConfigDir,
    installed: true,
    installedVersion: "1.15.0",
    binaryPath: `${cfg.installDir}/obsidian`,
    cliSourcePath: `${cfg.installDir}/obsidian-cli`,
    cliSourcePresent: true,
    appPackageVersion: "1.15.0",
    systemPackageVersion: "",
    vaults: ["/home/me/vault"],
    appRunning: false,
    cliPath: `${cfg.cliDir}/obsidian`,
    cliRegistered: true,
    cliExecutable: true,
    cliDirOnPath: true,
    cliFirstOnPathDir: cfg.cliDir,
    cliReachable: true,
    cliFlag: true,
    desktopEntryPresent: true,
    sandboxHelperPresent: true,
    sandboxHelperMode: 0o100755,
    sandboxHelperOwnerUid: 1000,
    sandboxHelperSetuidRoot: false,
    sandboxUsernsRestricted: false,
    checkedAt: "now",
    notes: [],
  };
  const cli: Partial<CliInfo> = {
    path: `${cfg.cliDir}/obsidian`,
    verified: true,
    reportedVersion: "1.15.0 (installer 1.15.0)",
    note: "registered the CLI. Start Obsidian to confirm it answers.",
  };
  const summary = buildSummary(
    status,
    { installedVersion: "1.15.0" },
    cli,
    "now",
  );
  if (!summary.ok) throw new Error("ok");
  if (!summary.lines[0].includes("Obsidian 1.15.0")) {
    throw new Error(summary.lines[0]);
  }
  if (!summary.lines.some((l) => l.includes("answers: 1.15.0"))) {
    throw new Error(summary.lines.join(" / "));
  }
  if (!summary.notes.some((n) => n.includes("Start Obsidian"))) {
    throw new Error(summary.notes.join(" / "));
  }

  const stale = buildSummary(
    status,
    { installedVersion: "1.15.0" },
    { ...cli, installerVersion: "1.10.3" },
    "now",
  );
  if (!stale.notes.some((n) => n.includes("quit and reopen"))) {
    throw new Error(stale.notes.join(" / "));
  }
  if (!stale.notes.some((n) => n.includes("installer 1.10.3"))) {
    throw new Error(stale.notes.join(" / "));
  }

  const broken = buildSummary(
    { ...status, cliRegistered: false, installed: false },
    {},
    {},
    "now",
  );
  if (broken.ok) throw new Error("should not be ok");
  if (!broken.lines[0].includes("not fully installed")) {
    throw new Error(broken.lines[0]);
  }
});

// ---------------------------------------------------------------------------
// Chromium sandbox
// ---------------------------------------------------------------------------

/** The FATAL Chromium prints when chrome-sandbox is present but not setuid. */
const SUID_FATAL =
  "[3809016:1109/160356.147114:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] " +
  "The SUID sandbox helper binary was found, but is not configured correctly. " +
  "Rather than run without sandboxing I'm aborting now. You need to make sure " +
  "that /home/me/.local/share/obsidian/chrome-sandbox is owned by root and has " +
  "mode 4755.";

/** A fake host that has Obsidian installed, with its sandbox broken or not. */
function sandboxHost(opts: {
  launches: boolean;
  /** Script a headless session instead of a clean start or a refusal. */
  headless?: boolean;
  usernsRestricted?: boolean;
  helperSetuidRoot?: boolean;
  wrapperLaunches?: boolean;
  extraFiles?: Record<string, string>;
}) {
  const cfg = config();
  const binary = `${cfg.installDir}/obsidian`;
  const helper = `${cfg.installDir}/chrome-sandbox`;
  const wrapper = `${cfg.installDir}/obsidian-no-sandbox`;
  const apparmorKnob = "sysctl -n kernel.apparmor_restrict_unprivileged_userns";
  const host = fakeDeps({
    files: {
      [binary]: "bin",
      [helper]: "helper",
      ...(opts.extraFiles ?? {}),
    },
    modes: {
      [binary]: 0o100755,
      [helper]: opts.helperSetuidRoot ? 0o104755 : 0o100755,
    },
    uids: { [helper]: opts.helperSetuidRoot ? 0 : 1000 },
    runs: {
      [`${binary} --version`]: opts.headless
        ? {
          code: 1,
          stdout:
            "2026-11-09 06:33:55 Loaded main app package /home/me/.local/share/obsidian/resources/obsidian.asar",
          stderr: "",
        }
        : opts.launches
        ? {
          code: 0,
          stdout: "Obsidian CLI\n\nUsage: obsidian <command>",
          stderr: "",
        }
        : { code: 133, stdout: "", stderr: SUID_FATAL },
      // The control run: with the sandbox off, a headless session fails the
      // same way, which is how the probe knows the sandbox is not to blame.
      [`${binary} --no-sandbox --version`]: opts.headless
        ? {
          code: 1,
          stdout:
            "2026-11-09 06:33:55 Loaded main app package /home/me/.local/share/obsidian/resources/obsidian.asar",
          stderr: "",
        }
        : { code: 0, stdout: "Obsidian CLI", stderr: "" },
      [`${wrapper} --version`]: opts.wrapperLaunches === false
        ? { code: 133, stdout: "", stderr: SUID_FATAL }
        : { code: 0, stdout: "Obsidian CLI", stderr: "" },
      [apparmorKnob]: opts.usernsRestricted === false
        ? { code: 0, stdout: "0", stderr: "" }
        : { code: 0, stdout: "1", stderr: "" },
    },
  });
  return { cfg, binary, helper, wrapper, ...host };
}

Deno.test("interpretSandboxProbe reads Chromium's two refusals and a clean start", () => {
  const setuid = interpretSandboxProbe({
    code: 133,
    stdout: "",
    stderr: SUID_FATAL,
  });
  if (setuid.launches || setuid.cause !== "setuid") throw new Error("setuid");
  if (!setuid.output.includes("SUID sandbox")) throw new Error(setuid.output);

  const missing = interpretSandboxProbe({
    code: 133,
    stdout: "",
    stderr: "FATAL: No usable sandbox! Update your kernel...",
  });
  if (missing.launches || missing.cause !== "missing") {
    throw new Error("missing");
  }

  const ok = interpretSandboxProbe({
    code: 0,
    stdout: "Obsidian CLI",
    stderr: "",
  });
  if (!ok.launches || ok.cause !== "ok") throw new Error("ok");

  // A probe that stays up (a GUI answered by opening a window) got past the
  // sandbox check, so a timeout is a launch, not a failure.
  const hung = interpretSandboxProbe({
    code: 124,
    stdout: "",
    stderr: "timed out after 20000ms",
  });
  if (!hung.launches) throw new Error("timeout should count as starting");

  // Anything else is inconclusive, not a sandbox verdict: the app may have
  // failed for a reason that has nothing to do with the sandbox.
  const other = interpretSandboxProbe({
    code: 1,
    stdout:
      "2026-11-09 06:33:55 Loaded main app package /x/resources/obsidian.asar",
    stderr: "",
  });
  if (other.launches || other.cause !== "unconfirmed") {
    throw new Error("unconfirmed");
  }
});

Deno.test("sandboxRoute normalises and defaults to auto", () => {
  if (sandboxRoute("") !== "auto") throw new Error("empty");
  if (sandboxRoute(" SETUID ") !== "setuid") throw new Error("trim/lower");
  if (sandboxRoute("nonsense") !== "auto") throw new Error("invalid");
  if (resolvedSandboxRoute("auto") !== "setuid") throw new Error("auto");
  if (resolvedSandboxRoute("report") !== "report") throw new Error("report");
  if (config().sandbox !== "auto") throw new Error("config default");
  if (
    normaliseConfig({ sandbox: "apparmor" }, {
      home: "/home/me",
      platform: "linux",
    }).sandbox !== "apparmor"
  ) {
    throw new Error("config explicit");
  }
});

Deno.test("planSandbox stages chrome-sandbox for the privileged step", async () => {
  const { cfg, helper, deps, files, copies } = sandboxHost({ launches: false });
  const info = await planSandbox(deps, cfg);

  if (info.launches) throw new Error("should not launch");
  if (info.cause !== "setuid") throw new Error(info.cause);
  if (info.state !== "needs-elevation") throw new Error(info.state);
  if (info.route !== "setuid") throw new Error(info.route);
  if (!info.sudoRequired) throw new Error("sudoRequired");
  if (info.sudoOperation !== "installFile") throw new Error(info.sudoOperation);
  if (info.sudoMode !== "4755") throw new Error(info.sudoMode);
  if (info.sudoDest !== helper) throw new Error(info.sudoDest);
  if (info.sudoSrc !== `${cfg.installDir}/.chrome-sandbox.stage`) {
    throw new Error(info.sudoSrc);
  }
  if (!copies.some((c) => c === `${helper} -> ${info.sudoSrc}`)) {
    throw new Error(copies.join(" / "));
  }
  if (!files.has(info.sudoSrc)) throw new Error("stage missing");
  if (
    info.fallbackCommand !==
      `sudo install -D -m 4755 ${info.stagePath} ${helper}`
  ) {
    throw new Error(info.fallbackCommand);
  }
  if (!info.notes.join(" ").includes("@svendowideit/sudo")) {
    throw new Error(info.notes.join(" / "));
  }
  if (info.verified) throw new Error("must not claim verification");
});

Deno.test("planSandbox does nothing when the app already starts", async () => {
  const { cfg, deps, files, wrapper } = sandboxHost({
    launches: true,
    helperSetuidRoot: true,
  });
  const info = await planSandbox(deps, cfg);
  if (!info.launches || info.state !== "ok") throw new Error(info.state);
  if (info.sudoRequired) throw new Error("no privileged step needed");
  if (info.route !== "none") throw new Error(info.route);
  if (!info.verified) throw new Error("verified");
  if (files.has(wrapper)) throw new Error("should not write a wrapper");
  // Nothing to report and nothing to fix: the check is silent when it passes.
  if (info.notes.length) throw new Error(info.notes.join(" / "));
});

Deno.test("planSandbox removes a stale no-sandbox wrapper once the sandbox works", async () => {
  const { cfg, deps, files, wrapper, removed } = sandboxHost({
    launches: true,
    helperSetuidRoot: true,
    extraFiles: {
      [`${config().installDir}/obsidian-no-sandbox`]:
        "#!/bin/sh\nexec ... --no-sandbox\n",
    },
  });
  const info = await planSandbox(deps, cfg);
  if (!removed.includes(wrapper)) throw new Error("wrapper not removed");
  if (files.has(wrapper)) throw new Error("wrapper still there");
  if (!info.notes.join(" ").includes("Removed the stale no-sandbox wrapper")) {
    throw new Error(info.notes.join(" / "));
  }
  const entry = files.get(
    "/home/me/.local/share/applications/obsidian.desktop",
  );
  if (!entry || !entry.includes(`${cfg.installDir}/obsidian %U`)) {
    throw new Error(entry ?? "no desktop entry");
  }
});

Deno.test("planSandbox honours sandbox=no-sandbox and says so loudly", async () => {
  const { cfg, deps, files, wrapper } = sandboxHost({
    launches: false,
    wrapperLaunches: true,
  });
  const info = await planSandbox(deps, { ...cfg, sandbox: "no-sandbox" });
  if (info.state !== "unsandboxed") throw new Error(info.state);
  if (info.route !== "no-sandbox") throw new Error(info.route);
  if (info.wrapperPath !== wrapper) throw new Error(info.wrapperPath);
  if (info.sudoRequired) throw new Error("no privileged step for no-sandbox");
  if (!info.verified) throw new Error("wrapper probe should pass");
  const body = files.get(wrapper)!;
  if (!body.includes("--no-sandbox")) throw new Error(body);
  if (!body.includes(`${cfg.installDir}/obsidian`)) throw new Error(body);
  const entry = files.get(
    "/home/me/.local/share/applications/obsidian.desktop",
  );
  if (!entry || !entry.includes(`Exec=${wrapper} %U`)) {
    throw new Error(entry ?? "no desktop entry");
  }
  const notes = info.notes.join(" ");
  if (!notes.includes("renderer sandboxing is OFF")) throw new Error(notes);
});

Deno.test("planSandbox stages an AppArmor profile for the apparmor route", async () => {
  const { cfg, deps, files } = sandboxHost({ launches: false });
  const info = await planSandbox(deps, { ...cfg, sandbox: "apparmor" });
  if (info.state !== "manual") throw new Error(info.state);
  if (info.route !== "apparmor") throw new Error(info.route);
  if (info.sudoRequired) throw new Error("nothing automatable to run");
  if (info.profilePath !== `${cfg.installDir}/obsidian.apparmor`) {
    throw new Error(info.profilePath);
  }
  const profile = files.get(info.profilePath)!;
  if (!profile.includes("userns,")) throw new Error(profile);
  if (!profile.includes(`profile obsidian ${cfg.installDir}/obsidian`)) {
    throw new Error(profile);
  }
  if (!info.fallbackCommand.includes("apparmor_parser -r")) {
    throw new Error(info.fallbackCommand);
  }
  if (
    info.fallbackCommand.includes(
      "/home/me/.local/share/obsidian/chrome-sandbox",
    )
  ) {
    throw new Error("apparmor route must not mention the setuid helper");
  }
});

Deno.test("planSandbox changes nothing on sandbox=report", async () => {
  const { cfg, deps, files, copies, removed } = sandboxHost({
    launches: false,
  });
  const info = await planSandbox(deps, { ...cfg, sandbox: "report" });
  if (info.state !== "manual") throw new Error(info.state);
  if (info.sudoRequired) throw new Error("report must not elevate");
  if (copies.length) throw new Error("should not stage");
  if (removed.length) throw new Error("should not remove");
  if (
    info.sudoSrc !== "" || info.wrapperPath !== "" || info.profilePath !== ""
  ) {
    throw new Error("report must not stage anything");
  }
  if (!files.has(`${cfg.installDir}/chrome-sandbox`)) throw new Error("helper");
  if (!info.notes.join(" ").includes("Nothing was changed")) {
    throw new Error(info.notes.join(" / "));
  }
});

Deno.test("planSandbox reports a missing install instead of guessing", async () => {
  const cfg = config();
  const { deps } = fakeDeps();
  const info = await planSandbox(deps, cfg);
  if (info.state !== "not-installed") throw new Error(info.state);
  if (info.launches) throw new Error("launches");
  if (info.sudoRequired) throw new Error("sudoRequired");
  if (!info.notes.join(" ").includes("obsidian-app-upgrade")) {
    throw new Error(info.notes.join(" / "));
  }
});

Deno.test("verifySandbox proves a fixed sandbox and clears the staged helper", async () => {
  const { cfg, deps, files, helper } = sandboxHost({
    launches: true,
    helperSetuidRoot: true,
    extraFiles: {
      "/home/me/.local/share/obsidian/.chrome-sandbox.stage": "helper",
    },
  });
  const info = await verifySandbox(deps, cfg);
  if (!info.launches || !info.verified) throw new Error("should verify");
  if (info.state !== "ok") throw new Error(info.state);
  if (files.has(`${cfg.installDir}/.chrome-sandbox.stage`)) {
    throw new Error("staged helper left behind");
  }
  if (!info.notes.join(" ").includes(helper)) {
    throw new Error(info.notes.join(" / "));
  }
});

Deno.test("verifySandbox fails with the exact command when it is still broken", async () => {
  const { cfg, deps, helper } = sandboxHost({ launches: false });
  const info = await verifySandbox(deps, cfg);
  if (info.launches) throw new Error("should not launch");
  if (info.state !== "needs-elevation") throw new Error(info.state);
  if (info.cause !== "setuid") throw new Error(info.cause);
  if (
    info.fallbackCommand !==
      `sudo install -D -m 4755 ${cfg.installDir}/.chrome-sandbox.stage ${helper}`
  ) {
    throw new Error(info.fallbackCommand);
  }
  if (!info.notes.join(" ").includes(helper)) {
    throw new Error(info.notes.join(" / "));
  }
});

Deno.test("detectStatus warns when the setuid helper cannot work here", async () => {
  const cfg = config();
  const host = sandboxHost({ launches: false, usernsRestricted: true });
  const status = await detectStatus(host.deps, cfg);
  if (!status.sandboxHelperPresent) throw new Error("helperPresent");
  if (status.sandboxHelperSetuidRoot) throw new Error("setuidRoot");
  if (!status.sandboxUsernsRestricted) throw new Error("userns");
  if (!status.notes.join(" ").includes("cannot start yet")) {
    throw new Error(status.notes.join(" / "));
  }

  const fine = await detectStatus(
    sandboxHost({ launches: true, helperSetuidRoot: true }).deps,
    cfg,
  );
  if (fine.notes.join(" ").includes("cannot start yet")) {
    throw new Error(fine.notes.join(" / "));
  }
});

Deno.test("installArchive keeps an existing chrome-sandbox rather than resetting it", async () => {
  const cfg = config();
  const archive = "/home/me/.cache/obsidian-app/obsidian-1.16.0.tar.gz";
  const tarKey =
    `tar -xzf ${archive} -C ${cfg.installDir} --strip-components=1 --exclude=*/chrome-sandbox`;
  const host = fakeDeps({
    files: {
      [archive]: "archive",
      [`${cfg.installDir}/chrome-sandbox`]: "helper",
      [`${cfg.installDir}/obsidian`]: "bin",
      [`${cfg.installDir}/obsidian-cli`]: "cli",
      [`${cfg.installDir}/resources/app.asar`]: "asar",
      [`${cfg.installDir}/.swamp-obsidian-app.json`]: JSON.stringify({
        version: "1.15.0",
      }),
    },
    runs: {
      [tarKey]: { code: 0, stdout: "", stderr: "" },
    },
  });
  const info = await installArchive(host.deps, cfg, {
    archivePath: archive,
    archiveName: "obsidian-1.16.0.tar.gz",
    version: "1.16.0",
    checksum: "",
    force: false,
  });
  if (!info.sandboxHelperKept) throw new Error("should keep the helper");
  if (!info.message.includes("Kept the existing chrome-sandbox")) {
    throw new Error(info.message);
  }
});

Deno.test("buildSummary reports a failed sandbox and withholds ok", () => {
  const cfg = config();
  const status: StatusInfo = {
    platform: "linux",
    arch: "x64",
    installMode: "tar",
    installDir: cfg.installDir,
    cliDir: cfg.cliDir,
    appConfigDir: cfg.appConfigDir,
    installed: true,
    installedVersion: "1.15.0",
    binaryPath: `${cfg.installDir}/obsidian`,
    cliSourcePath: `${cfg.installDir}/obsidian-cli`,
    cliSourcePresent: true,
    appPackageVersion: "1.15.0",
    systemPackageVersion: "",
    vaults: [],
    appRunning: false,
    cliPath: `${cfg.cliDir}/obsidian`,
    cliRegistered: true,
    cliExecutable: true,
    cliDirOnPath: true,
    cliFirstOnPathDir: cfg.cliDir,
    cliReachable: true,
    cliFlag: true,
    desktopEntryPresent: true,
    sandboxHelperPresent: true,
    sandboxHelperMode: 0o100755,
    sandboxHelperOwnerUid: 1000,
    sandboxHelperSetuidRoot: false,
    sandboxUsernsRestricted: true,
    checkedAt: "now",
    notes: [],
  };
  const summary = buildSummary(status, {}, {}, "now", {
    launches: false,
    verified: false,
    cause: "setuid",
    route: "setuid",
    notes: ["The app said: SUID sandbox helper binary was found"],
  });
  if (summary.ok) throw new Error("ok must be false when it cannot start");
  if (summary.sandboxOk) throw new Error("sandboxOk");
  if (!summary.lines.some((l) => l.includes("cannot start"))) {
    throw new Error(summary.lines.join(" / "));
  }
  if (!summary.notes.some((n) => n.includes("SUID sandbox"))) {
    throw new Error(summary.notes.join(" / "));
  }

  const unchecked = buildSummary(status, {}, {}, "now");
  if (!unchecked.lines.some((l) => l.includes("Sandbox not checked yet"))) {
    throw new Error(unchecked.lines.join(" / "));
  }
  if (!unchecked.ok) throw new Error("no verdict must not fail the summary");

  const good = buildSummary(status, {}, {}, "now", {
    launches: true,
    verified: true,
    cause: "ok",
    route: "none",
  });
  if (!good.lines.some((l) => l.includes("Obsidian starts"))) {
    throw new Error(good.lines.join(" / "));
  }

  // A correct sandbox in a session with no display: verified, but no launch.
  const headless = buildSummary(status, {}, {}, "now", {
    launches: false,
    verified: true,
    cause: "unconfirmed",
    route: "none",
    probeOutput:
      "sandboxed: 2026-11-09 Loaded main app package /x/obsidian.asar",
  });
  if (!headless.ok) throw new Error("headless must not fail the summary");
  if (!headless.lines.some((l) => l.includes("Sandbox correct"))) {
    throw new Error(headless.lines.join(" / "));
  }
});

Deno.test("noSandboxWrapperBody quotes the path a shell cannot misread", () => {
  if (shellQuote("/home/me/app") !== "'/home/me/app'") {
    throw new Error(shellQuote("/home/me/app"));
  }
  // A quote in the directory name must not end the quoting.
  if (shellQuote("/home/me/it's here") !== `'/home/me/it'\\''s here'`) {
    throw new Error(shellQuote("/home/me/it's here"));
  }
  const body = noSandboxWrapperBody("/home/me/$(rm -rf ~)/obsidian");
  if (body.includes('exec "/home/me/$(rm -rf ~)/obsidian"')) {
    throw new Error("path is still in double quotes");
  }
  if (!body.includes("exec '/home/me/$(rm -rf ~)/obsidian' --no-sandbox")) {
    throw new Error(body);
  }
});

Deno.test("planSandbox refuses an AppArmor path it cannot express", async () => {
  const installDir = "/home/me/My Apps/obsidian";
  const { deps, files } = fakeDeps({
    files: { [`${installDir}/obsidian`]: "bin" },
    runs: {
      [`${installDir}/obsidian --version`]: {
        code: 133,
        stdout: "",
        stderr: SUID_FATAL,
      },
    },
  });
  const spaced = { ...config(), installDir, sandbox: "apparmor" };
  const info = await planSandbox(deps, spaced);
  if (info.state !== "manual") throw new Error(info.state);
  if (info.profilePath !== "") throw new Error("should not stage a profile");
  if (files.has(`${installDir}/obsidian.apparmor`)) {
    throw new Error("profile written");
  }
  const notes = info.notes.join(" ");
  if (!notes.includes("whitespace or non-ASCII")) throw new Error(notes);
  if (!notes.includes("sudo install -D -m 4755")) throw new Error(notes);
});

Deno.test("planSandbox fails loudly when it cannot write the no-sandbox wrapper", async () => {
  const cfg = { ...config(), sandbox: "no-sandbox" };
  const wrapper = `${cfg.installDir}/obsidian-no-sandbox`;
  const { deps } = fakeDeps({
    files: { [`${cfg.installDir}/obsidian`]: "bin" },
    runs: {
      [`${cfg.installDir}/obsidian --version`]: {
        code: 133,
        stdout: "",
        stderr: SUID_FATAL,
      },
    },
    failWrites: [wrapper],
  });
  let message = "";
  try {
    await planSandbox(deps, cfg);
  } catch (error) {
    message = `${error}`;
  }
  if (!message.includes(wrapper)) throw new Error(message);
  if (!message.includes("obsidian-app-upgrade")) throw new Error(message);
});

Deno.test("userNamespacesRestricted reads sysctl, not /proc", async () => {
  const restricted = fakeDeps({
    runs: {
      "sysctl -n kernel.apparmor_restrict_unprivileged_userns": {
        code: 0,
        stdout: "1",
        stderr: "",
      },
    },
  });
  if (!(await userNamespacesRestricted(restricted.deps))) {
    throw new Error("apparmor knob");
  }

  const debian = fakeDeps({
    runs: {
      "sysctl -n kernel.apparmor_restrict_unprivileged_userns": {
        code: 1,
        stdout: "",
        stderr: "unknown key",
      },
      "sysctl -n kernel.unprivileged_userns_clone": {
        code: 0,
        stdout: "0",
        stderr: "",
      },
    },
  });
  if (!(await userNamespacesRestricted(debian.deps))) {
    throw new Error("clone knob");
  }

  const open = fakeDeps({
    runs: {
      "sysctl -n kernel.apparmor_restrict_unprivileged_userns": {
        code: 0,
        stdout: "0",
        stderr: "",
      },
    },
  });
  if (await userNamespacesRestricted(open.deps)) {
    throw new Error("not restricted");
  }

  // No knob at all: ask the kernel to build one namespace instead.
  const noKnobs = fakeDeps({
    runs: {
      "unshare -U --map-root-user true": {
        code: 1,
        stdout: "",
        stderr: "Operation not permitted",
      },
    },
  });
  if (!(await userNamespacesRestricted(noKnobs.deps))) {
    throw new Error("unshare fallback");
  }
});

/** The line p1gen4 prints when the app starts with no display. */
const NO_DISPLAY_LINE =
  "2026-11-09 06:33:55 Loaded main app package /home/me/.local/share/obsidian/resources/obsidian.asar";

Deno.test("probeSandbox separates a sandbox refusal from a headless session", async () => {
  const cfg = config();
  const binary = `${cfg.installDir}/obsidian`;

  // Same non-sandbox failure with and without the sandbox: the environment is
  // the problem (no DISPLAY over ssh), so the sandbox is not blamed.
  const headless = fakeDeps({
    files: { [binary]: "bin" },
    runs: {
      [`${binary} --version`]: { code: 1, stdout: NO_DISPLAY_LINE, stderr: "" },
      [`${binary} --no-sandbox --version`]: {
        code: 1,
        stdout: NO_DISPLAY_LINE,
        stderr: "",
      },
    },
  });
  const unconfirmed = await probeSandbox(headless.deps, cfg);
  if (unconfirmed.launches || unconfirmed.cause !== "unconfirmed") {
    throw new Error(unconfirmed.cause);
  }
  if (!unconfirmed.output.includes("with --no-sandbox")) {
    throw new Error(unconfirmed.output);
  }

  // Works only with the sandbox off: the sandbox is what stops it, even though
  // this Chromium release words the refusal differently.
  const refuser = fakeDeps({
    files: { [binary]: "bin" },
    runs: {
      [`${binary} --version`]: { code: 1, stdout: NO_DISPLAY_LINE, stderr: "" },
      [`${binary} --no-sandbox --version`]: {
        code: 0,
        stdout: "Obsidian CLI",
        stderr: "",
      },
    },
  });
  const sandboxed = await probeSandbox(refuser.deps, cfg);
  if (sandboxed.launches || sandboxed.cause !== "sandbox") {
    throw new Error(sandboxed.cause);
  }

  // A proven refusal never needs the control run.
  const explicit = fakeDeps({
    files: { [binary]: "bin" },
    runs: {
      [`${binary} --version`]: { code: 133, stdout: "", stderr: SUID_FATAL },
    },
  });
  const proven = await probeSandbox(explicit.deps, cfg);
  if (proven.cause !== "setuid") throw new Error(proven.cause);
});

Deno.test("planSandbox accepts a correct sandbox it could not launch in", async () => {
  const { cfg, deps } = sandboxHost({
    launches: false,
    headless: true,
    helperSetuidRoot: true,
  });
  // `--no-sandbox` fails the same way here, so this is a headless session.
  const info = await planSandbox(deps, cfg);
  if (info.state !== "ok") throw new Error(info.state);
  if (!info.verified) throw new Error("should verify the configuration");
  if (info.sudoRequired) throw new Error("must not elevate");
  if (info.launches) throw new Error("launches");
  const notes = info.notes.join(" ");
  if (!notes.includes("not a sandbox failure")) throw new Error(notes);
  if (!notes.includes("Loaded main app package")) throw new Error(notes);
});

Deno.test("planSandbox still fixes a headless host whose helper is wrong", async () => {
  const { cfg, deps } = sandboxHost({
    launches: false,
    headless: true,
    usernsRestricted: true,
  });
  // The probe could not tell, but the helper is not setuid and user namespaces
  // are denied, so the configuration cannot work either way.
  const info = await planSandbox(deps, cfg);
  if (info.state !== "needs-elevation") throw new Error(info.state);
  if (!info.sudoRequired) throw new Error("sudoRequired");
  if (info.verified) throw new Error("must not verify");
});

Deno.test("verifySandbox passes a correct helper in a headless session", async () => {
  const { cfg, deps, helper } = sandboxHost({
    launches: false,
    headless: true,
    helperSetuidRoot: true,
  });
  const info = await verifySandbox(deps, cfg);
  if (!info.verified) throw new Error("should verify the sandbox");
  if (info.launches) throw new Error("launches");
  if (info.state !== "ok") throw new Error(info.state);
  const notes = info.notes.join(" ");
  if (!notes.includes("did not stay up here")) throw new Error(notes);
  if (!notes.includes(helper)) throw new Error(notes);
});

Deno.test("sandboxMountHint explains a nosuid install directory", () => {
  const { cfg } = sandboxHost({ launches: false });
  const nosuid = "The setuid sandbox is not running as root. Common causes:\n" +
    " 1. You are running as root. Go away.\n";
  const hint = sandboxMountHint(nosuid, cfg);
  if (!hint.includes("findmnt -no TARGET,OPTIONS")) throw new Error(hint);
  if (!hint.includes(cfg.installDir)) throw new Error(hint);
  if (!hint.includes("sandbox=apparmor")) throw new Error(hint);
  if (sandboxMountHint(SUID_FATAL, cfg) !== "") {
    throw new Error("must stay quiet for the setuid-ownership case");
  }
});

Deno.test("verifySandbox reports the nosuid cause, not just the command", async () => {
  const cfg = config();
  const binary = `${cfg.installDir}/obsidian`;
  const helper = `${cfg.installDir}/chrome-sandbox`;
  const nosuid = "The setuid sandbox is not running as root. Common causes:\n";
  const { deps } = fakeDeps({
    files: { [binary]: "bin", [helper]: "helper" },
    modes: { [binary]: 0o100755, [helper]: 0o104755 },
    uids: { [helper]: 0 },
    runs: {
      [`${binary} --version`]: { code: 133, stdout: "", stderr: nosuid },
      [`${binary} --no-sandbox --version`]: {
        code: 0,
        stdout: "Obsidian CLI",
        stderr: "",
      },
      "sysctl -n kernel.apparmor_restrict_unprivileged_userns": {
        code: 0,
        stdout: "1",
        stderr: "",
      },
    },
  });
  const info = await verifySandbox(deps, cfg);
  if (info.verified) throw new Error("must not pass");
  const notes = info.notes.join(" ");
  if (!notes.includes("refuses setuid")) throw new Error(notes);
  if (!notes.includes("findmnt")) throw new Error(notes);
});
