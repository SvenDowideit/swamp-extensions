/**
 * Unit tests for the pure helpers and host builders of
 * {@link @svendowideit/obsidian-headless}.
 *
 * Every test drives the shared module through a fake {@link Deps}, so the
 * suite touches no network, no host and no real npm — it asserts the parsing,
 * path building, config editing and install orchestration in isolation.
 *
 * @module
 */

import {
  buildSummary,
  buildSyncCommand,
  compareVersions,
  type Config,
  type Deps,
  desktopConfigDir,
  detectStatus,
  disableInAppSyncForVault,
  disableSyncCorePlugin,
  ensurePackage,
  expandHome,
  findLocalVaultAt,
  findRemoteVaults,
  headlessConfigDir,
  isDesktopRegistered,
  isLoggedIn,
  majorOf,
  managedNode,
  nodeDistToken,
  nodeTarballName,
  normaliseConfig,
  parseCorePlugins,
  parseDesktopVaults,
  parseLocalVaults,
  parseRemoteVaults,
  parseShasums,
  pickNodeVersion,
  type RunResult,
  shellQuote,
  stripTrailingSlash,
} from "./obsidian_headless_shared.ts";

// ---------------------------------------------------------------------------
// A fake, in-memory Deps
// ---------------------------------------------------------------------------

interface FakeOptions {
  files?: Record<string, string>;
  binaryFiles?: Record<string, Uint8Array>;
  dirs?: Record<string, string[]>;
  fetches?: Record<string, Uint8Array | string>;
  run?: (bin: string, args: string[]) => RunResult | undefined;
  env?: Record<string, string>;
  platform?: "linux" | "darwin" | "other";
  arch?: "x64" | "arm64" | "other";
  home?: string;
  pids?: Record<string, number[]>;
  hostname?: string;
}

interface Fake extends Deps {
  writes: Array<{ path: string; data: string }>;
  renames: Array<{ from: string; to: string }>;
}

function fakeDeps(opts: FakeOptions = {}): Fake {
  const files = new Map(Object.entries(opts.files ?? {}));
  const binary = new Map(Object.entries(opts.binaryFiles ?? {}));
  const dirs = opts.dirs ?? {};
  const fetches = opts.fetches ?? {};
  const writes: Array<{ path: string; data: string }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  const run = opts.run ?? (() => undefined);

  const deps: Fake = {
    writes,
    renames,
    run: (bin, args) => {
      const result = run(bin, args);
      return Promise.resolve(result ?? { code: 0, stdout: "", stderr: "" });
    },
    readText: (path) => Promise.resolve(files.get(path) ?? ""),
    writeText: (path, data) => {
      files.set(path, data);
      writes.push({ path, data });
      return Promise.resolve(true);
    },
    writeBinary: (path, data) => {
      binary.set(path, data);
      return Promise.resolve();
    },
    exists: (path) =>
      Promise.resolve(files.has(path) || binary.has(path) || path in dirs),
    mkdirp: () => Promise.resolve(),
    remove: (path) => {
      files.delete(path);
      binary.delete(path);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const value = files.get(from);
      if (value !== undefined) files.set(to, value);
      renames.push({ from, to });
      return Promise.resolve();
    },
    readDir: (path) => Promise.resolve(dirs[path] ?? []),
    fetchBytes: (url) => {
      const value = fetches[url];
      if (value === undefined) {
        return Promise.reject(new Error(`no fake fetch for ${url}`));
      }
      return Promise.resolve(
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
    },
    env: (key) => opts.env?.[key],
    home: () => opts.home ?? "/home/tester",
    platform: () => opts.platform ?? "linux",
    arch: () => opts.arch ?? "x64",
    now: () => "2026-10-12T00:00:00.000Z",
    hostname: () => Promise.resolve(opts.hostname ?? "host"),
    pids: (name) => Promise.resolve(opts.pids?.[name] ?? []),
    sha256Hex: () => Promise.resolve("0".repeat(64)),
  };
  return deps;
}

const cfg = (over: Partial<Config> = {}): Config =>
  normaliseConfig(over, "/home/tester", "host");

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome expands a leading tilde only", () => {
  if (expandHome("~", "/h") !== "/h") throw new Error("bare tilde");
  if (expandHome("~/a/b", "/h") !== "/h/a/b") throw new Error("tilde path");
  if (expandHome("/a", "/h") !== "/a") throw new Error("absolute");
  if (expandHome("", "/h") !== "") throw new Error("empty");
});

Deno.test("headlessConfigDir follows XDG on linux and dotdir on darwin", () => {
  const env = (k: string) => (k === "XDG_CONFIG_HOME" ? "/xdg" : undefined);
  if (headlessConfigDir(env, "/h", "linux") !== "/xdg/obsidian-headless") {
    throw new Error("xdg");
  }
  if (
    headlessConfigDir(() => undefined, "/h", "linux") !==
      "/h/.config/obsidian-headless"
  ) {
    throw new Error("default");
  }
  if (
    headlessConfigDir(() => undefined, "/h", "darwin") !==
      "/h/.obsidian-headless"
  ) {
    throw new Error("darwin");
  }
});

Deno.test("desktopConfigDir finds the app config per platform", () => {
  if (
    desktopConfigDir(() => undefined, "/h", "linux") !== "/h/.config/obsidian"
  ) {
    throw new Error("linux");
  }
  if (
    desktopConfigDir(() => undefined, "/h", "darwin") !==
      "/h/Library/Application Support/obsidian"
  ) {
    throw new Error("darwin");
  }
});

Deno.test("normaliseConfig applies defaults and expands paths", () => {
  const c = normaliseConfig({ vaultPath: "~/vault" }, "/home/tester", "abc");
  if (c.vaultPath !== "/home/tester/vault") throw new Error("vaultPath");
  if (c.configDir !== ".obsidian") throw new Error("configDir");
  if (c.nodeVersion !== "22") throw new Error("nodeVersion");
  if (c.serviceName !== "obsidian-headless") throw new Error("serviceName");
  if (c.deviceName !== "abc-headless") throw new Error("deviceName");
  if (c.syncMode !== "bidirectional") throw new Error("syncMode");
});

// ---------------------------------------------------------------------------
// core-plugins.json
// ---------------------------------------------------------------------------

Deno.test("parseCorePlugins reads object and legacy array forms", () => {
  const obj = parseCorePlugins('{"sync":true,"graph":false}');
  if (obj.kind !== "object" || !obj.syncEnabled) throw new Error("object");
  const arr = parseCorePlugins('["sync","graph"]');
  if (arr.kind !== "array" || !arr.syncEnabled) throw new Error("array");
  const off = parseCorePlugins('{"sync":false}');
  if (off.syncEnabled) throw new Error("off");
  const none = parseCorePlugins("");
  if (none.kind !== "none" || none.syncEnabled) throw new Error("none");
});

Deno.test("disableSyncCorePlugin turns sync off and reports change", () => {
  const a = disableSyncCorePlugin('{"sync":true,"graph":true}');
  if (!a.changed || !a.wasEnabled) throw new Error("changed");
  const parsed = JSON.parse(a.text);
  if (parsed.sync !== false || parsed.graph !== true) {
    throw new Error("preserve");
  }
  const b = disableSyncCorePlugin('["sync","graph"]');
  if (JSON.parse(b.text).includes("sync")) throw new Error("array remove");
  const c = disableSyncCorePlugin('{"sync":false}');
  if (c.changed || c.wasEnabled) throw new Error("idempotent");
  const d = disableSyncCorePlugin("not json");
  if (d.changed) throw new Error("invalid untouched");
});

// ---------------------------------------------------------------------------
// Desktop registry
// ---------------------------------------------------------------------------

const DESKTOP_JSON = JSON.stringify({
  vaults: {
    abc: { path: "/home/tester/vault", open: true },
    def: { path: "/home/tester/other/" },
  },
});

Deno.test("parseDesktopVaults + isDesktopRegistered match by path", () => {
  const vaults = parseDesktopVaults(DESKTOP_JSON);
  if (vaults.length !== 2) throw new Error("count");
  if (!isDesktopRegistered(vaults, "/home/tester/vault")) {
    throw new Error("hit");
  }
  // Trailing slash on either side is ignored.
  if (!isDesktopRegistered(vaults, "/home/tester/other")) {
    throw new Error("trail");
  }
  if (isDesktopRegistered(vaults, "/nope")) throw new Error("miss");
  if (stripTrailingSlash("/a/b/") !== "/a/b") throw new Error("strip");
  if (stripTrailingSlash("/") !== "/") throw new Error("root");
});

// ---------------------------------------------------------------------------
// Remote + local vault listing
// ---------------------------------------------------------------------------

Deno.test("parseRemoteVaults handles owned and shared vaults", () => {
  const text = JSON.stringify({
    vaults: [{ id: "v1", name: "Notes", region: "eu" }],
    shared: [{ id: "v2", name: "Team", region: "us" }],
  });
  const vaults = parseRemoteVaults(text);
  if (vaults.length !== 2) throw new Error("count");
  if (vaults[1].shared !== true) throw new Error("shared flag");
  if (findRemoteVaults(vaults, "Notes")[0].id !== "v1") {
    throw new Error("by name");
  }
  if (findRemoteVaults(vaults, "v2")[0].name !== "Team") {
    throw new Error("by id");
  }
  if (findRemoteVaults(vaults, "missing").length !== 0) throw new Error("miss");
});

Deno.test("parseLocalVaults + findLocalVaultAt match by path", () => {
  const text = JSON.stringify({
    vaults: [{ id: "v1", path: "/home/tester/vault", host: "https://sync" }],
  });
  const vaults = parseLocalVaults(text);
  if (findLocalVaultAt(vaults, "/home/tester/vault")?.id !== "v1") {
    throw new Error("hit");
  }
  if (findLocalVaultAt(vaults, "/other") !== undefined) throw new Error("miss");
});

// ---------------------------------------------------------------------------
// Node distribution
// ---------------------------------------------------------------------------

Deno.test("nodeDistToken maps platform/arch or returns null", () => {
  if (nodeDistToken("linux", "x64") !== "linux-x64") throw new Error("lx");
  if (nodeDistToken("linux", "arm64") !== "linux-arm64") throw new Error("la");
  if (nodeDistToken("darwin", "arm64") !== "darwin-arm64") {
    throw new Error("da");
  }
  if (nodeDistToken("other", "x64") !== null) throw new Error("other");
});

Deno.test("nodeTarballName + pickNodeVersion + parseShasums", () => {
  if (
    nodeTarballName("22.11.0", "linux-x64") !== "node-v22.11.0-linux-x64.tar.xz"
  ) {
    throw new Error("tarball");
  }
  const index = JSON.stringify([
    { version: "v23.1.0", lts: false },
    { version: "v22.12.0", lts: "Jod" },
    { version: "v22.11.0", lts: "Jod" },
  ]);
  if (pickNodeVersion(index, "22") !== "22.12.0") throw new Error("pick major");
  if (pickNodeVersion(index, "v22.11.0") !== "22.11.0") {
    throw new Error("pick exact");
  }
  if (pickNodeVersion(index, "99") !== null) throw new Error("no match");
  const sums = `${"a".repeat(64)}  node-v22.12.0-linux-x64.tar.xz\n` +
    `${"b".repeat(64)}  other.tar.xz`;
  if (parseShasums(sums, "node-v22.12.0-linux-x64.tar.xz") !== "a".repeat(64)) {
    throw new Error("shasum");
  }
  if (parseShasums(sums, "missing") !== null) throw new Error("shasum miss");
});

Deno.test("majorOf + compareVersions + default-ish helpers", () => {
  if (majorOf("v22.11.0") !== 22) throw new Error("majorOf v");
  if (majorOf("garbage") !== null) throw new Error("majorOf bad");
  if (compareVersions("22.2.0", "22.10.0") >= 0) throw new Error("compare");
  if (!isLoggedIn("", "tok")) throw new Error("env token");
  if (!isLoggedIn("tok", "")) throw new Error("file token");
  if (isLoggedIn("  ", " ")) throw new Error("empty");
});

Deno.test("buildSyncCommand quotes paths and adds --continuous", () => {
  const cmd = buildSyncCommand("/n", "/c.js", "/home/me/My Vault");
  if (!cmd.includes('"') || !cmd.endsWith("--continuous")) {
    throw new Error("cmd");
  }
  if (shellQuote("plain-1.2") !== "plain-1.2") throw new Error("plain quote");
});

// ---------------------------------------------------------------------------
// managedNode / ensurePackage / detectStatus / disableInAppSync builders
// ---------------------------------------------------------------------------

Deno.test("managedNode resolves the newest installed runtime", async () => {
  const deps = fakeDeps({
    dirs: {
      "/node": ["node-v22.11.0-linux-x64", "node-v22.12.0-linux-x64"],
    },
    files: {
      "/node/node-v22.12.0-linux-x64/bin/node": "x",
      "/node/node-v22.12.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js": "x",
    },
    run: (bin, args) =>
      bin.endsWith("/bin/node") && args[0] === "--version"
        ? { code: 0, stdout: "v22.12.0", stderr: "" }
        : undefined,
  });
  const info = await managedNode(deps, cfg({ nodeDir: "/node" }));
  if (!info || info.version !== "v22.12.0") throw new Error("version");
  if (!info.npmCliPath.endsWith("npm-cli.js")) throw new Error("npm");
});

Deno.test("ensurePackage installs via node's bundled npm then reads version", async () => {
  const prefix = "/pkg";
  const pkgDir = `${prefix}/lib/node_modules/obsidian-headless`;
  const deps = fakeDeps({
    fetches: {
      "https://registry.npmjs.org/obsidian-headless/latest": JSON.stringify({
        version: "0.0.14",
      }),
    },
    run: (_bin, args) => {
      if (args.includes("install")) {
        // Emulate npm writing the installed package.json.
        return { code: 0, stdout: "added 1 package", stderr: "" };
      }
      return undefined;
    },
  });
  // Seed the file only after npm "runs": wrap writeText via run is awkward, so
  // write it up front and assert the skip path instead.
  await deps.writeText(
    `${pkgDir}/package.json`,
    JSON.stringify({ version: "0.0.14" }),
  );
  await deps.writeText(`${pkgDir}/cli.js`, "// cli");
  const node = {
    major: 22,
    version: "v22.12.0",
    binaryPath: "/node/bin/node",
    npmCliPath: "/node/lib/node_modules/npm/bin/npm-cli.js",
    source: "managed" as const,
    skipped: false,
    installDir: "/node",
    requiredMajor: 22,
  };
  const pkg = await ensurePackage(deps, cfg({ packagePrefix: prefix }), node);
  if (!pkg.skipped || pkg.version !== "0.0.14") throw new Error("skip");
  // Force reinstall: npm runs, files already present.
  const forced = await ensurePackage(
    deps,
    cfg({ packagePrefix: prefix }),
    node,
    true,
  );
  if (forced.skipped || forced.version !== "0.0.14") throw new Error("force");
  if (!forced.obPath.endsWith("/bin/ob")) throw new Error("obPath");
});

Deno.test("detectStatus reports desktop registration and in-app sync", async () => {
  const deps = fakeDeps({
    env: {},
    home: "/home/tester",
    platform: "linux",
    pids: { obsidian: [123] },
    files: {
      "/home/tester/.config/obsidian/obsidian.json": DESKTOP_JSON,
      "/home/tester/vault/.obsidian/core-plugins.json": '{"sync":true}',
    },
  });
  const status = await detectStatus(
    deps,
    cfg({ vaultPath: "/home/tester/vault", vaultName: "Notes" }),
  );
  if (!status.desktopRegistered) throw new Error("desktop");
  if (!status.inAppSyncEnabled) throw new Error("enabled");
  if (!status.inAppSyncConfigured) throw new Error("configured");
  if (!status.obsidianAppRunning) throw new Error("running");
  if (status.nodeFound) throw new Error("no node expected");
});

Deno.test("detectStatus: in-app sync configured requires BOTH signals", async () => {
  const deps = fakeDeps({
    files: {
      // sync enabled but the vault is NOT registered with the desktop app.
      "/home/tester/vault/.obsidian/core-plugins.json": '{"sync":true}',
    },
  });
  const status = await detectStatus(
    deps,
    cfg({ vaultPath: "/home/tester/vault" }),
  );
  if (status.inAppSyncEnabled !== true) throw new Error("enabled");
  if (status.inAppSyncConfigured !== false) throw new Error("not configured");
});

Deno.test("disableInAppSyncForVault backs up and rewrites the config", async () => {
  const corePath = "/home/tester/vault/.obsidian/core-plugins.json";
  const deps = fakeDeps({
    files: {
      [corePath]: '{"sync":true,"graph":true}',
      "/home/tester/.config/obsidian/obsidian.json": DESKTOP_JSON,
    },
    pids: { obsidian: [] },
  });
  const info = await disableInAppSyncForVault(
    deps,
    cfg({ vaultPath: "/home/tester/vault" }),
  );
  if (!info.changed || !info.disabled) throw new Error("changed");
  if (!info.backupPath) throw new Error("backup");
  const final = await deps.readText(corePath);
  if (!final.includes('"sync": false')) throw new Error("rewrite");
  if (deps.renames.length === 0) throw new Error("atomic rename");
});

Deno.test("disableInAppSyncForVault is a no-op when sync is already off", async () => {
  const corePath = "/home/tester/vault/.obsidian/core-plugins.json";
  const deps = fakeDeps({
    files: { [corePath]: '{"sync":false}' },
  });
  const info = await disableInAppSyncForVault(
    deps,
    cfg({ vaultPath: "/home/tester/vault" }),
  );
  if (info.changed) throw new Error("should not change");
  if (!info.disabled) throw new Error("disabled stays true");
  if (info.backupPath) throw new Error("no backup");
});

Deno.test("buildSummary reports ok only when the end state holds", () => {
  const ok = buildSummary(
    { serviceName: "obsidian-headless", nodePath: "/n", serviceHint: "hint" },
    { configured: true, vaultPath: "/v", vaultName: "Notes" },
    { version: "0.0.14" },
    { disabled: true },
    "2026-10-12T00:00:00.000Z",
  );
  if (!ok.ok) throw new Error("ok expected");
  if (!ok.lines.some((l) => l.includes("obsidian-headless 0.0.14"))) {
    throw new Error("package line");
  }
  const bad = buildSummary({}, {}, {}, {}, "now");
  if (bad.ok) throw new Error("not ok expected");
});
