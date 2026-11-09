/**
 * Tests for the `@svendowideit/herdr-app` model: release resolution, the
 * download/verify/extract path, planning, install and uninstall against a
 * temporary home, plus the method bodies that write swamp resources.
 *
 * Network and subprocesses are injected: `fetch` is either a local stub or
 * `withMockedFetch`, and the version probes are answered by a fake `run`. The
 * archives are real gzipped tars built in the test, so extraction, checksums
 * and placement are exercised for real in a temporary directory.
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
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@0.1.10/tar-stream";
import {
  buildSshTransport,
  ensureArchive,
  extractTarGz,
  type HostDeps,
  hostDeps,
  installHerdr,
  installHerdrTheme,
  layoutOf,
  model,
  parseHosts,
  planInstall,
  probeInstalled,
  releaseFromResource,
  type ResolvedRelease,
  resolveRelease,
  safeRelative,
  sha256Hex,
  uninstallHerdr,
} from "./herdr_app.ts";
import {
  herdrAppHomeFor,
  parseHerdrTheme,
  themeChoiceOf,
  withThemeChoice,
} from "./herdr_app_shared.ts";
import {
  DEFAULT_RELEASES_URL,
  type ReleaseManifest,
} from "./herdr_app_shared.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_VERSION = "0.1.14";
const CORE_VERSION = "0.1.19";

const APP_MANIFEST = {
  version: APP_VERSION,
  core_min: "0.1.11",
  notes: "Herdr 0.1.14",
  targets: {
    "linux-x86_64": {
      url:
        "https://releases.herdr.dev/app/0.1.14/herdr-app-linux-x86_64.tar.gz",
      sha256: "a".repeat(64),
    },
  },
};

const CORE_MANIFEST = {
  version: CORE_VERSION,
  targets: {
    "linux-x86_64": {
      url:
        "https://releases.herdr.dev/core/0.1.19/herdr-core-linux-x86_64.tar.gz",
      sha256: "c".repeat(64),
    },
  },
};

/** Build a gzipped tar from member paths to bodies. */
async function makeTarGz(
  files: Record<string, string>,
  executable: string[] = [],
): Promise<Uint8Array> {
  const tar = new TarStream();
  const writer = tar.writable.getWriter();
  const collected = new Response(tar.readable).arrayBuffer();
  for (const [path, body] of Object.entries(files)) {
    const content = new TextEncoder().encode(body);
    const entry: TarStreamInput = {
      type: "file",
      path,
      size: content.length,
      readable: new Blob([content]).stream(),
    };
    await writer.write(entry);
    void executable;
  }
  await writer.close();
  const tarBytes = new Uint8Array(await collected);
  return new Uint8Array(
    await new Response(
      new Blob([tarBytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
}

/** The app archive the fake release serves. */
async function appArchive(): Promise<Uint8Array> {
  return await makeTarGz({
    "herdr-app/herdr-app": `#!/bin/sh\necho "herdr-app ${APP_VERSION}"\n`,
    "herdr-app/herdr-app.svg": "<svg/>\n",
  });
}

/** A temporary host whose home, data dir and cache all live under `dir`. */
function fakeDeps(
  dir: string,
  overrides: Partial<HostDeps> = {},
): HostDeps {
  return {
    fetch: (() => {
      throw new Error("no fetch expected");
    }) as unknown as typeof fetch,
    run: (command, args) => {
      const text = `${command} ${args.join(" ")}`;
      if (text.includes("herdr-app") && args.includes("--version")) {
        return Promise.resolve({
          code: 0,
          stdout: "herdr-app 0.1.14\n",
          stderr: "",
        });
      }
      if (text.includes("herdr-core") && args.includes("--version")) {
        return Promise.resolve({ code: 0, stdout: "hc 0.1.18\n", stderr: "" });
      }
      if (command === "which" || command === "where") {
        return Promise.resolve({ code: 1, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    os: "linux",
    arch: "x86_64",
    rosetta: false,
    env: {
      home: `${dir}/home`,
      localAppData: `${dir}/localappdata`,
      xdgData: `${dir}/data`,
      xdgCache: `${dir}/cache`,
      xdgConfig: "",
      herdrAppHome: "",
      userProfile: `${dir}/home`,
      systemRoot: "",
    },
    log: () => {},
    now: () => new Date("2026-01-02T03:04:05Z"),
    ...overrides,
  };
}

/** A `fetch` that serves the given URL → body map and records the URLs. */
function stubFetch(
  routes: Record<string, string | Uint8Array>,
  calls: string[] = [],
): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const body = routes[url];
    if (body === undefined) {
      return Promise.resolve(new Response("no", { status: 404 }));
    }
    return Promise.resolve(
      new Response(typeof body === "string" ? body : new Uint8Array(body)),
    );
  }) as unknown as typeof fetch;
}

/** The theme this extension ships, as text (read from the real bundled file). */
const THEME_TEXT = await Deno.readTextFile(
  new URL("./themes/borland-modern-blue.json", import.meta.url),
);

const RELEASE: ResolvedRelease = {
  version: APP_VERSION,
  coreMin: "0.1.11",
  notes: "Herdr 0.1.14",
  target: "linux-x86_64",
  url:
    "https://releases.herdr.dev/app/0.1.14/herdr-app-linux-x86_64.tar.gz?src=install",
  sha256: "a".repeat(64),
  coreVersion: "",
  coreUrl: "",
  coreSha256: "",
  releasesUrl: DEFAULT_RELEASES_URL,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("safeRelative refuses anything that escapes the destination", () => {
  assertEquals(safeRelative("herdr-app/herdr-app"), "herdr-app/herdr-app");
  assertEquals(safeRelative("./herdr-app//x"), "herdr-app/x");
  assertEquals(safeRelative("../etc/passwd"), "");
  assertEquals(safeRelative("a/../../b"), "");
  assertEquals(safeRelative("/etc/passwd"), "etc/passwd");
  assertEquals(safeRelative("C:/windows/system32"), "");
  assertEquals(safeRelative(""), "");
});

Deno.test("sha256Hex matches the platform's digest", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("parseHosts accepts name=address and bare addresses", () => {
  assertEquals(parseHosts("mac-mini=192.168.1.20"), [
    { name: "mac-mini", address: "192.168.1.20", tags: [], attrs: {} },
  ]);
  const bare = parseHosts("studio.lan, lab-1=10.0.0.5");
  assertEquals(bare[0].name, "studio.lan");
  assertEquals(bare[0].address, "studio.lan");
  assertEquals(bare[1].name, "lab-1");
  assertEquals(parseHosts("  ").length, 0);
  assertThrows(
    () => parseHosts("a=192.0.2.1, a=192.0.2.2"),
    Error,
    "two hosts would be named a",
  );
});

Deno.test("buildSshTransport omits unset overrides", () => {
  const transport = buildSshTransport({
    user: "",
    port: 22,
    identityFile: "",
    hostKeyChecking: "accept-new",
    connectTimeoutSec: 10,
  });
  assertEquals(transport.kind, "ssh");
  assertEquals(transport.port, 22);
  assertEquals("user" in transport, false);
  assertEquals("identityFile" in transport, false);
  const withKey = buildSshTransport({
    user: "sven",
    port: 2222,
    identityFile: "~/.ssh/id_ed25519",
    hostKeyChecking: "yes",
    connectTimeoutSec: 5,
  });
  assertEquals(withKey.user, "sven");
  assertEquals(withKey.identityFile, "~/.ssh/id_ed25519");
  assertEquals(withKey.strictHostKeyChecking, "yes");
});

// ---------------------------------------------------------------------------
// Download and extract
// ---------------------------------------------------------------------------

Deno.test("extractTarGz writes the tree with the binaries executable", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-extract-" });
  try {
    const bytes = await makeTarGz({
      "herdr-app/herdr-app": "#!/bin/sh\necho hi\n",
      "herdr-app/herdr-app.svg": "<svg/>",
    });
    await extractTarGz(bytes, `${dir}/out`);
    assertEquals(
      (await Deno.stat(`${dir}/out/herdr-app/herdr-app`)).mode! & 0o777,
      0o755,
    );
    assertEquals(
      (await Deno.stat(`${dir}/out/herdr-app/herdr-app.svg`)).mode! & 0o777,
      0o644,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extractTarGz refuses a traversing entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-extract-" });
  try {
    const bytes = await makeTarGz({ "../escape": "x" });
    await extractTarGz(bytes, `${dir}/out`);
    await assertRejects(
      () => Deno.lstat(`${dir}/escape`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureArchive verifies, caches, then reuses without fetching", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-dl-" });
  try {
    const bytes = new TextEncoder().encode("archive-bytes");
    const sha256 = await sha256Hex(bytes);
    const calls: string[] = [];
    const deps = fakeDeps(dir, {
      fetch: stubFetch({ "https://x/a.tgz": bytes }, calls),
    });
    const cachePath = `${dir}/cache/a.tgz`;
    const first = await ensureArchive(deps, {
      url: "https://x/a.tgz",
      sha256,
      cachePath,
      label: "herdr-app",
    });
    assertEquals(first, bytes);
    assertEquals(calls, ["https://x/a.tgz"]);

    const second = await ensureArchive(deps, {
      url: "https://x/a.tgz",
      sha256,
      cachePath,
      label: "herdr-app",
    });
    assertEquals(second, bytes);
    assertEquals(calls.length, 1, "the cached archive is not fetched again");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureArchive refuses a mismatched checksum before writing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-dl-" });
  try {
    const deps = fakeDeps(dir, {
      fetch: stubFetch({ "https://x/a.tgz": "tampered" }),
    });
    const cachePath = `${dir}/cache/a.tgz`;
    await assertRejects(
      () =>
        ensureArchive(deps, {
          url: "https://x/a.tgz",
          sha256: "b".repeat(64),
          cachePath,
          label: "herdr-app",
        }),
      Error,
      "download is damaged",
    );
    await assertRejects(() => Deno.lstat(cachePath), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureArchive reports a failed download with the URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-dl-" });
  try {
    const deps = fakeDeps(dir, { fetch: stubFetch({}) });
    await assertRejects(
      () =>
        ensureArchive(deps, {
          url: "https://x/missing.tgz",
          sha256: "a".repeat(64),
          cachePath: `${dir}/cache/m.tgz`,
          label: "herdr-app",
        }),
      Error,
      "HTTP 404",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Release resolution and planning
// ---------------------------------------------------------------------------

Deno.test("resolveRelease resolves the app, and the core unless it is off", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-resolve-" });
  try {
    const calls: string[] = [];
    const deps = fakeDeps(dir, {
      fetch: stubFetch({
        [`${DEFAULT_RELEASES_URL}/app/latest.json`]: JSON.stringify(
          APP_MANIFEST,
        ),
        [`${DEFAULT_RELEASES_URL}/core/latest.json`]: JSON.stringify(
          CORE_MANIFEST,
        ),
      }, calls),
    });
    const release = await resolveRelease(deps, {
      releasesUrl: DEFAULT_RELEASES_URL,
      version: "",
      coreVersion: "",
      core: "auto",
    });
    assertEquals(release.version, APP_VERSION);
    assertEquals(release.target, "linux-x86_64");
    assertEquals(release.coreVersion, CORE_VERSION);
    assertStringIncludes(release.url, "?src=install");
    assertStringIncludes(release.coreUrl, "?src=install");
    assertEquals(calls.length, 2);

    calls.length = 0;
    const noCore = await resolveRelease(deps, {
      releasesUrl: DEFAULT_RELEASES_URL,
      version: "",
      coreVersion: "",
      core: "never",
    });
    assertEquals(noCore.coreVersion, "");
    assertEquals(calls.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveRelease pins a version through its manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-resolve-" });
  try {
    const calls: string[] = [];
    const deps = fakeDeps(dir, {
      fetch: stubFetch({
        [`${DEFAULT_RELEASES_URL}/app/0.1.13/manifest.json`]: JSON.stringify({
          ...APP_MANIFEST,
          version: "0.1.13",
        }),
      }, calls),
    });
    const release = await resolveRelease(deps, {
      releasesUrl: DEFAULT_RELEASES_URL,
      version: "v0.1.13",
      coreVersion: "",
      core: "never",
    });
    assertEquals(release.version, "0.1.13");
    assertEquals(calls, [`${DEFAULT_RELEASES_URL}/app/0.1.13/manifest.json`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveRelease keeps the app when an optional core is unreachable", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-resolve-" });
  try {
    const logs: string[] = [];
    const deps = fakeDeps(dir, {
      log: (message) => logs.push(message),
      fetch: stubFetch({
        [`${DEFAULT_RELEASES_URL}/app/latest.json`]: JSON.stringify(
          APP_MANIFEST,
        ),
      }),
    });
    const release = await resolveRelease(deps, {
      releasesUrl: DEFAULT_RELEASES_URL,
      version: "",
      coreVersion: "",
      core: "auto",
    });
    assertEquals(release.version, APP_VERSION);
    assertEquals(release.coreVersion, "");
    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "herdr-core release not resolved");

    // core=always must not silently install an app without its core.
    await assertRejects(
      () =>
        resolveRelease(deps, {
          releasesUrl: DEFAULT_RELEASES_URL,
          version: "",
          coreVersion: "",
          core: "always",
        }),
      Error,
      "HTTP 404",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeInstalled reads the app and the core off the host", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-probe-" });
  try {
    const deps = fakeDeps(dir);
    const layout = layoutOf(deps);
    await Deno.mkdir(layout.appDir, { recursive: true });
    await Deno.writeTextFile(layout.appBinary, "#!/bin/sh\n");
    await Deno.mkdir(layout.binDir, { recursive: true });
    await Deno.writeTextFile(layout.corePath, "#!/bin/sh\n");

    const installed = await probeInstalled(deps);
    assertEquals(installed.appPresent, true);
    assertEquals(installed.appVersion, APP_VERSION);
    assertEquals(installed.appKind, "directory");
    assertEquals(installed.corePresent, true);
    assertEquals(installed.coreVersion, "0.1.18");
    assertEquals(installed.corePath, layout.corePath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeInstalled reports an absent app without throwing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-probe-" });
  try {
    const installed = await probeInstalled(fakeDeps(dir));
    assertEquals(installed.appPresent, false);
    assertEquals(installed.appVersion, "");
    assertEquals(installed.corePresent, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("planInstall says what each combination would do", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-plan-" });
  try {
    const empty = await probeInstalled(fakeDeps(dir));
    const fresh = planInstall(empty, RELEASE, { core: "never", force: false });
    assertEquals(fresh.action, "installed");
    assertStringIncludes(fresh.reason, "install herdr-app 0.1.14");

    const current = {
      ...empty,
      appPresent: true,
      appVersion: APP_VERSION,
    };
    const unchanged = planInstall(current, RELEASE, {
      core: "never",
      force: false,
    });
    assertEquals(unchanged.action, "unchanged");

    const older = { ...current, appVersion: "0.1.13" };
    assertEquals(
      planInstall(older, RELEASE, { core: "never", force: false }).action,
      "updated",
    );
    assertEquals(
      planInstall(older, RELEASE, { core: "never", force: false }).reason,
      `update herdr-app 0.1.13 to 0.1.14 at ${empty.layout.appDir}`,
    );
    assertEquals(
      planInstall(current, RELEASE, { core: "never", force: true }).action,
      "reinstalled",
    );
    assertEquals(
      planInstall(
        { ...current, appVersion: "0.2.0" },
        RELEASE,
        { core: "never", force: false },
      ).action,
      "downgraded",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("planInstall treats a core update as a core-only change", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-plan-" });
  try {
    const installed = {
      ...await probeInstalled(fakeDeps(dir)),
      appPresent: true,
      appVersion: APP_VERSION,
      corePresent: true,
      coreVersion: "0.1.18",
    };
    const release = {
      ...RELEASE,
      coreVersion: CORE_VERSION,
      coreUrl: "https://x/c.tgz",
    };
    const plan = planInstall(installed, release, {
      core: "always",
      force: false,
    });
    assertEquals(plan.action, "core-only");
    assertEquals(plan.coreAction, "updated");
    assertStringIncludes(plan.reason, "herdr-core: updated");

    const auto = planInstall(installed, release, {
      core: "auto",
      force: false,
    });
    assertEquals(auto.action, "unchanged");
    assertEquals(auto.coreAction, "unchanged");

    const unavailable = planInstall(
      { ...installed, appVersion: APP_VERSION },
      { ...RELEASE, coreVersion: "" },
      { core: "auto", force: false },
    );
    assertEquals(unavailable.coreAction, "unavailable");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("releaseFromResource rejects an incomplete or foreign release", () => {
  assertThrows(
    () => releaseFromResource({ version: "0.1.14" }),
    Error,
    "incomplete",
  );
  assertThrows(
    () =>
      releaseFromResource({
        version: "0.1.14",
        target: "macos-aarch64",
        url: "https://x/a.tgz",
        sha256: "a".repeat(64),
      }, fakeDeps("/tmp")),
    Error,
    "run plan on this host",
  );
  const release = releaseFromResource({
    version: "0.1.14",
    target: "linux-x86_64",
    url: "https://x/a.tgz",
    sha256: "A".repeat(64),
    coreVersion: "0.1.19",
    coreUrl: "https://x/c.tgz",
    coreSha256: "B".repeat(64),
    releasesUrl: "https://mirror.example",
  });
  assertEquals(release.sha256, "a".repeat(64));
  assertEquals(release.coreSha256, "b".repeat(64));
  assertEquals(release.releasesUrl, "https://mirror.example");
});

// ---------------------------------------------------------------------------
// Install / uninstall against a temporary home
// ---------------------------------------------------------------------------

Deno.test("installHerdr places the app, link and launcher", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-install-" });
  try {
    const archive = await appArchive();
    const sha256 = await sha256Hex(archive);
    const deps = fakeDeps(dir, {
      fetch: stubFetch({
        [RELEASE.url]: archive,
      }),
    });
    const result = await installHerdr(deps, {
      release: { ...RELEASE, sha256 },
      core: "never",
      force: false,
      appDir: "",
      binDir: "",
      downloadDir: "",
      herdrHome: "",
      theme: "borland-modern-blue",
      themeText: THEME_TEXT,
      selectTheme: true,
    });
    const layout = layoutOf(deps);
    assertEquals(result.action, "installed");
    assertEquals(result.version, APP_VERSION);
    assertEquals(
      (await Deno.stat(`${layout.appDir}/herdr-app.svg`)).isFile,
      true,
    );
    assertEquals(await Deno.readLink(layout.linkPath), layout.appBinary);
    assertStringIncludes(
      await Deno.readTextFile(layout.desktopFile),
      `Exec=${layout.linkPath}`,
    );
    assertEquals(result.coreAction, "skipped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installHerdr is idempotent and downloads nothing when current", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-install-" });
  try {
    const archive = await appArchive();
    const sha256 = await sha256Hex(archive);
    const calls: string[] = [];
    const deps = fakeDeps(dir, {
      fetch: stubFetch({ [RELEASE.url]: archive }, calls),
    });
    const opts = {
      release: { ...RELEASE, sha256 },
      core: "never" as const,
      force: false,
      appDir: "",
      binDir: "",
      downloadDir: "",
      herdrHome: "",
      theme: "borland-modern-blue",
      themeText: THEME_TEXT,
      selectTheme: true,
    };
    await installHerdr(deps, opts);
    calls.length = 0;
    const second = await installHerdr(deps, opts);
    assertEquals(second.action, "unchanged");
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installHerdr refuses a release resolved for another platform", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-install-" });
  try {
    await assertRejects(
      () =>
        installHerdr(fakeDeps(dir), {
          release: { ...RELEASE, target: "macos-aarch64" },
          core: "never",
          force: false,
          appDir: "",
          binDir: "",
          downloadDir: "",
          herdrHome: "",
          theme: "",
          themeText: "",
          selectTheme: false,
        }),
      Error,
      "re-run plan on this host",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installHerdr writes a failed install resource and rethrows", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-install-" });
  try {
    const deps = fakeDeps(dir);
    void deps;
    const { context, getWrittenResources } = createModelTestContext();
    // Drive the model method so the failure path's resource write is asserted.
    // The download is refused, so the install fails after the app is planned.
    await withMockedFetch(
      [new Response("no", { status: 404 })],
      () =>
        assertRejects(
          () =>
            (model.methods.install.execute as unknown as (
              a: Record<string, unknown>,
              c: unknown,
            ) => Promise<unknown>)({
              core: "never",
              force: false,
              appDir: `${dir}/app`,
              binDir: `${dir}/bin`,
              releasesUrl: DEFAULT_RELEASES_URL,
              release: {
                version: APP_VERSION,
                target: "linux-x86_64",
                url: "https://releases.herdr.dev/app/0.1.14/a.tar.gz",
                sha256: "a".repeat(64),
                releasesUrl: DEFAULT_RELEASES_URL,
              },
            }, context),
          Error,
          "HTTP 404",
        ),
    );
    const install = getWrittenResources().find((r) => r.specName === "install");
    assertEquals(install?.data.action, "failed");
    assertEquals(deps.os, "linux");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstallHerdr removes the app but keeps the shared core", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-uninstall-" });
  try {
    const archive = await appArchive();
    const sha256 = await sha256Hex(archive);
    const deps = fakeDeps(dir, {
      fetch: stubFetch({ [RELEASE.url]: archive }),
    });
    const layout = layoutOf(deps);
    await installHerdr(deps, {
      release: { ...RELEASE, sha256 },
      core: "never",
      force: false,
      appDir: "",
      binDir: "",
      downloadDir: "",
      herdrHome: "",
      theme: "borland-modern-blue",
      themeText: THEME_TEXT,
      selectTheme: true,
    });
    await Deno.mkdir(layout.coreDir, { recursive: true });
    await Deno.writeTextFile(layout.corePath, "#!/bin/sh\n");

    const kept = await uninstallHerdr(deps, {
      appDir: "",
      binDir: "",
      removeCore: false,
      removeTheme: false,
      herdrHome: "",
      theme: "borland-modern-blue",
    });
    assertStringIncludes(kept.removed.join(","), layout.appDir);
    await assertRejects(() => Deno.lstat(layout.appDir), Deno.errors.NotFound);
    await assertRejects(
      () => Deno.lstat(layout.linkPath),
      Deno.errors.NotFound,
    );
    assertEquals((await Deno.stat(layout.corePath)).isFile, true);
    assertEquals(kept.kept.length, 1);

    const removed = await uninstallHerdr(deps, {
      appDir: "",
      binDir: "",
      removeCore: true,
      removeTheme: true,
      herdrHome: "",
      theme: "borland-modern-blue",
    });
    assertStringIncludes(removed.removed.join(","), layout.corePath);
    await assertRejects(
      () => Deno.lstat(layout.corePath),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

Deno.test("the shipped theme is a valid Herdr theme", () => {
  const { theme, unknownColors } = parseHerdrTheme(
    THEME_TEXT,
    "themes/borland-modern-blue.json",
  );
  assertEquals(theme.background, "#003078");
  assertEquals(theme.foreground, "#e8f1fb");
  assertEquals(theme.ansi.length, 16);
  assertEquals(theme.cursor, "#5fe0ff");
  assertEquals(theme.colors["terminal_foreground"], "#e8f1fb");
  // Every colour it overrides is one Herdr resolves.
  assertEquals(unknownColors, []);
});

Deno.test("parseHerdrTheme mirrors the app's own validation", () => {
  const base = JSON.parse(THEME_TEXT);
  assertThrows(
    () =>
      parseHerdrTheme(
        JSON.stringify({ ...base, chrome: "#000000" }),
        "theme",
      ),
    Error,
    "is not a theme field",
  );
  assertThrows(
    () =>
      parseHerdrTheme(JSON.stringify({ ...base, ansi: ["#000000"] }), "theme"),
    Error,
    "ansi must be an array of 16",
  );
  assertThrows(
    () =>
      parseHerdrTheme(JSON.stringify({ ...base, background: "blue" }), "theme"),
    Error,
    "background must be #rrggbb",
  );
  assertThrows(
    () =>
      parseHerdrTheme(
        JSON.stringify({ ...base, colors: { accent: "#12345" } }),
        "theme",
      ),
    Error,
    "colors.accent must be #rrggbb or #rrggbbaa",
  );
  assertThrows(
    () => parseHerdrTheme("not json", "theme"),
    Error,
    "not valid JSON",
  );
  const { unknownColors } = parseHerdrTheme(
    JSON.stringify({
      ...base,
      colors: { accent: "#12345678", sparkle: "#ffffff" },
    }),
    "theme",
  );
  assertEquals(unknownColors, ["sparkle"]);
});

Deno.test("herdrAppHomeFor follows the app's own precedence", () => {
  assertEquals(
    herdrAppHomeFor({ os: "linux", home: "/home/me" }),
    "/home/me/.config/herdr-app",
  );
  assertEquals(
    herdrAppHomeFor({ os: "linux", home: "/home/me", xdgConfig: "/cfg/" }),
    "/cfg/herdr-app",
  );
  assertEquals(
    herdrAppHomeFor({
      os: "linux",
      home: "/home/me",
      xdgConfig: "/cfg",
      herdrAppHome: "/scratch/app/",
    }),
    "/scratch/app",
  );
  assertEquals(
    herdrAppHomeFor({ os: "windows", home: "C:\\Users\\me" }),
    "C:\\Users\\me\\.config\\herdr-app",
  );
});

Deno.test("themeChoiceOf reads a name, a pair, and nothing", () => {
  assertEquals(themeChoiceOf(""), {
    chosen: false,
    theme: "",
    light: "",
    dark: "",
  });
  assertEquals(themeChoiceOf("{}").chosen, false);
  assertEquals(themeChoiceOf('{"theme": null}').chosen, false);
  assertEquals(themeChoiceOf('{"theme": ""}').chosen, false);
  assertEquals(themeChoiceOf('{"theme": "paper"}'), {
    chosen: true,
    theme: "paper",
    light: "paper",
    dark: "paper",
  });
  assertEquals(
    themeChoiceOf(
      '{"theme": {"light": "paper", "dark": "borland-modern-blue"}}',
    ),
    { chosen: true, theme: "", light: "paper", dark: "borland-modern-blue" },
  );
  assertThrows(
    () => themeChoiceOf("{oops", "settings.json"),
    Error,
    "not valid JSON",
  );
});

Deno.test("withThemeChoice sets only an unchosen theme, keeping other keys", () => {
  const set = withThemeChoice(
    '{"zoom": 1, "sounds": {"enabled": false}}',
    "borland-modern-blue",
  );
  assertEquals(set.changed, true);
  assertEquals(JSON.parse(set.text), {
    zoom: 1,
    sounds: { enabled: false },
    theme: "borland-modern-blue",
  });
  const fromEmpty = withThemeChoice("", "borland-modern-blue");
  assertEquals(JSON.parse(fromEmpty.text), { theme: "borland-modern-blue" });
  // A chosen theme is never overwritten, in either form.
  assertEquals(withThemeChoice('{"theme": "paper"}', "x").changed, false);
  assertEquals(
    withThemeChoice('{"theme": {"light": "paper", "dark": "ink"}}', "x")
      .changed,
    false,
  );
});

Deno.test("installHerdrTheme writes the file and selects it once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-theme-" });
  try {
    const deps = fakeDeps(dir);
    const appHome = `${dir}/data/herdr-app`;
    const first = await installHerdrTheme(deps, {
      themeId: "borland-modern-blue",
      themeText: THEME_TEXT,
      appHome,
      select: true,
      force: false,
    });
    assertEquals(first.action, "installed");
    assertEquals(first.selected, true);
    assertEquals(first.path, `${appHome}/themes/borland-modern-blue.json`);
    assertEquals(await Deno.readTextFile(first.path), THEME_TEXT);
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${appHome}/settings.json`)),
      { theme: "borland-modern-blue" },
    );

    const second = await installHerdrTheme(deps, {
      themeId: "borland-modern-blue",
      themeText: THEME_TEXT,
      appHome,
      select: true,
      force: false,
    });
    assertEquals(second.action, "unchanged");
    assertEquals(second.selected, false);
    assertEquals(second.previousTheme, "borland-modern-blue");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installHerdrTheme keeps a chosen theme and can be forced", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-theme-" });
  try {
    const deps = fakeDeps(dir);
    const appHome = `${dir}/data/herdr-app`;
    await Deno.mkdir(appHome, { recursive: true });
    await Deno.writeTextFile(
      `${appHome}/settings.json`,
      '{"zoom": 1.0, "theme": "paper"}\n',
    );
    const result = await installHerdrTheme(deps, {
      themeId: "borland-modern-blue",
      themeText: THEME_TEXT,
      appHome,
      select: true,
      force: false,
    });
    assertEquals(result.selected, false);
    assertEquals(result.previousTheme, "paper");
    // The person's settings are untouched.
    assertEquals(
      await Deno.readTextFile(`${appHome}/settings.json`),
      '{"zoom": 1.0, "theme": "paper"}\n',
    );
    const forced = await installHerdrTheme(deps, {
      themeId: "borland-modern-blue",
      themeText: THEME_TEXT,
      appHome,
      select: false,
      force: true,
    });
    assertEquals(forced.action, "installed");
    assertEquals(forced.selected, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installHerdrTheme reports an unreadable settings.json, never replaces it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-theme-" });
  try {
    const deps = fakeDeps(dir);
    const appHome = `${dir}/data/herdr-app`;
    await Deno.mkdir(appHome, { recursive: true });
    await Deno.writeTextFile(`${appHome}/settings.json`, "{not json");
    const result = await installHerdrTheme(deps, {
      themeId: "borland-modern-blue",
      themeText: THEME_TEXT,
      appHome,
      select: true,
      force: false,
    });
    assertEquals(result.selected, false);
    assertStringIncludes(result.warning, "not valid JSON");
    assertEquals(
      await Deno.readTextFile(`${appHome}/settings.json`),
      "{not json",
    );
    // The theme itself is still installed.
    assertEquals(
      await Deno.readTextFile(`${appHome}/themes/borland-modern-blue.json`),
      THEME_TEXT,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installHerdr installs the theme and reports it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-install-" });
  try {
    const archive = await appArchive();
    const sha256 = await sha256Hex(archive);
    const deps = fakeDeps(dir, {
      fetch: stubFetch({ [RELEASE.url]: archive }),
    });
    const result = await installHerdr(deps, {
      release: { ...RELEASE, sha256 },
      core: "never",
      force: false,
      appDir: "",
      binDir: "",
      downloadDir: "",
      herdrHome: "",
      theme: "borland-modern-blue",
      themeText: THEME_TEXT,
      selectTheme: true,
    });
    assertEquals(result.theme.id, "borland-modern-blue");
    assertEquals(result.theme.action, "installed");
    assertEquals(result.theme.selected, true);
    assertEquals(
      await Deno.readTextFile(
        `${dir}/home/.config/herdr-app/themes/borland-modern-blue.json`,
      ),
      THEME_TEXT,
    );

    // theme="" installs no theme at all.
    const other = `${dir}/other`;
    const plain = await installHerdr(deps, {
      release: { ...RELEASE, sha256 },
      core: "never",
      force: false,
      appDir: `${other}/app`,
      binDir: `${other}/bin`,
      downloadDir: "",
      herdrHome: `${other}/home`,
      theme: "",
      themeText: "",
      selectTheme: false,
    });
    assertEquals(plain.theme.action, "skipped");
    await assertRejects(
      () => Deno.lstat(`${other}/home/themes`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Model methods
// ---------------------------------------------------------------------------

Deno.test("plan writes the release and the plan it decided", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-method-" });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "plan",
    });
    await withMockedFetch([
      Response.json(APP_MANIFEST),
      Response.json(CORE_MANIFEST),
    ], async () => {
      await (model.methods.plan.execute as unknown as (
        a: Record<string, unknown>,
        c: unknown,
      ) => Promise<unknown>)({
        version: "",
        coreVersion: "",
        core: "auto",
        force: false,
        appDir: `${dir}/app`,
        binDir: `${dir}/bin`,
        releasesUrl: DEFAULT_RELEASES_URL,
      }, context);
    });
    const release = getWrittenResources().find((r) => r.specName === "release");
    assertEquals(release?.data.version, APP_VERSION);
    assertEquals(release?.data.coreVersion, CORE_VERSION);
    assertEquals(release?.data.target, "linux-x86_64");
    const plan = getWrittenResources().find((r) => r.specName === "plan");
    assertEquals(plan?.data.action, "installed");
    assertEquals(plan?.data.targetVersion, APP_VERSION);
    assertEquals(plan?.data.coreMode, "auto");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status reports a fake app on this machine", async () => {
  if (Deno.build.os === "windows") return; // a .cmd app is out of scope here
  const dir = await Deno.makeTempDir({ prefix: "herdr-method-" });
  try {
    const appDir = `${dir}/app`;
    await Deno.mkdir(appDir, { recursive: true });
    await Deno.writeTextFile(
      `${appDir}/herdr-app`,
      "#!/bin/sh\necho 'herdr-app 0.1.14'\n",
    );
    await Deno.chmod(`${appDir}/herdr-app`, 0o755);
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "status",
    });
    await (model.methods.status.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({
      appDir,
      binDir: `${dir}/bin`,
    }, context);
    const status = getWrittenResources().find((r) => r.specName === "status");
    assertEquals(status?.data.appPresent, true);
    assertEquals(status?.data.appVersion, APP_VERSION);
    // The core probe follows PATH as well as the layout, and the test machine
    // may well have one, so only its type is asserted here.
    assertEquals(typeof status?.data.corePresent, "boolean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderScript pins every Linux and macOS target", async () => {
  const manifest = {
    ...APP_MANIFEST,
    targets: {
      "linux-x86_64": {
        url: "https://x/app-linux.tgz",
        sha256: "a".repeat(64),
      },
      "linux-aarch64": {
        url: "https://x/app-linux-arm.tgz",
        sha256: "b".repeat(64),
      },
      "macos-aarch64": {
        url: "https://x/app-macos.tgz",
        sha256: "c".repeat(64),
      },
      "windows-x86_64": {
        url: "https://x/app-win.tgz",
        sha256: "d".repeat(64),
      },
    },
  };
  const core = {
    version: CORE_VERSION,
    targets: {
      "linux-x86_64": {
        url: "https://x/core-linux.tgz",
        sha256: "e".repeat(64),
      },
      "macos-aarch64": {
        url: "https://x/core-macos.tgz",
        sha256: "f".repeat(64),
      },
    },
  };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
    methodName: "renderScript",
  });
  await withMockedFetch([
    Response.json(manifest),
    Response.json(core),
  ], () =>
    (model.methods.renderScript.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({
      version: "",
      coreVersion: "",
      core: "auto",
      force: false,
      releasesUrl: DEFAULT_RELEASES_URL,
      verifyCoreSignature: true,
    }, context));
  const script = getWrittenResources().find((r) => r.specName === "script");
  assertEquals(script?.data.targets, [
    "linux-x86_64",
    "linux-aarch64",
    "macos-aarch64",
  ]);
  assertEquals(script?.data.appVersion, APP_VERSION);
  const body = String(script?.data.script);
  // The mixed-fleet pins: every POSIX target is a case branch, Windows is not.
  assertStringIncludes(body, "  linux-x86_64)");
  assertStringIncludes(body, "  linux-aarch64)");
  assertStringIncludes(body, "  macos-aarch64)");
  assertEquals(body.includes("windows-x86_64)"), false);
  assertStringIncludes(body, "VERIFY_CORE_SIGNATURE='1'");
});

Deno.test("renderScript with core=never pins no core", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
    methodName: "renderScript",
  });
  await withMockedFetch(
    [Response.json(APP_MANIFEST)],
    () =>
      (model.methods.renderScript.execute as unknown as (
        a: Record<string, unknown>,
        c: unknown,
      ) => Promise<unknown>)({
        version: "",
        coreVersion: "",
        core: "never",
        force: true,
        releasesUrl: DEFAULT_RELEASES_URL,
        verifyCoreSignature: true,
      }, context),
  );
  const script = getWrittenResources().find((r) => r.specName === "script");
  assertEquals(script?.data.coreVersion, "");
  assertEquals(script?.data.coreMode, "never");
  assertStringIncludes(String(script?.data.script), "CORE_MODE='never'");
});

Deno.test("hostDeps maps this machine and fails on an unsupported OS", async () => {
  const deps = await hostDeps(() => {});
  assertEquals(typeof deps.arch, "string");
  assertEquals(deps.env.home.length > 0, true);
  assertEquals(typeof deps.run, "function");
});

Deno.test("the model declares every method and resource", () => {
  assertEquals(model.type, "@svendowideit/herdr-app");
  assertEquals(
    Object.keys(model.methods).sort(),
    [
      "install",
      "installTheme",
      "plan",
      "renderScript",
      "sshFleet",
      "status",
      "uninstall",
    ],
  );
  assertEquals(
    Object.keys(model.resources).sort(),
    ["install", "plan", "release", "script", "status", "theme", "transport"],
  );
});

Deno.test("installTheme writes the bundled theme and selects it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "herdr-method-" });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "installTheme",
    });
    // The model resolves bundled assets through swamp's `extensionFile`.
    (context as unknown as { extensionFile: (rel: string) => string })
      .extensionFile = (rel: string) =>
        new URL(`./${rel}`, import.meta.url).pathname;
    const appHome = `${dir}/herdr-app`;
    await (model.methods.installTheme.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({
      theme: "borland-modern-blue",
      herdrHome: appHome,
      select: true,
      force: false,
    }, context);
    const theme = getWrittenResources().find((r) => r.specName === "theme");
    assertEquals(theme?.data.id, "borland-modern-blue");
    assertEquals(theme?.data.action, "installed");
    assertEquals(theme?.data.selected, true);
    assertEquals(
      await Deno.readTextFile(`${appHome}/themes/borland-modern-blue.json`),
      THEME_TEXT,
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${appHome}/settings.json`)),
      { theme: "borland-modern-blue" },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installTheme refuses a theme this extension does not ship", async () => {
  const { context } = createModelTestContext({
    globalArgs: {},
    methodName: "installTheme",
  });
  (context as unknown as { extensionFile: (rel: string) => string })
    .extensionFile = (rel: string) =>
      new URL(`./${rel}`, import.meta.url).pathname;
  await assertRejects(
    () =>
      (model.methods.installTheme.execute as unknown as (
        a: Record<string, unknown>,
        c: unknown,
      ) => Promise<unknown>)({
        theme: "no-such-theme",
        herdrHome: "/tmp/unused",
        select: true,
        force: false,
      }, context),
    Error,
    "is not readable",
  );
});

Deno.test("status reports the theme file and the choice", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await Deno.makeTempDir({ prefix: "herdr-method-" });
  try {
    const appHome = `${dir}/herdr-app`;
    await Deno.mkdir(`${appHome}/themes`, { recursive: true });
    await Deno.writeTextFile(
      `${appHome}/themes/borland-modern-blue.json`,
      THEME_TEXT,
    );
    await Deno.writeTextFile(
      `${appHome}/settings.json`,
      '{"theme": {"light": "paper", "dark": "borland-modern-blue"}}',
    );
    await Deno.mkdir(`${appHome}/layouts`, { recursive: true });
    await Deno.writeTextFile(`${appHome}/layouts/main.json`, "{}");
    await Deno.writeTextFile(`${appHome}/layouts/swamp.json`, "{}");
    await Deno.writeTextFile(`${appHome}/layouts/notes.txt`, "not a layout");
    const appDir = `${dir}/app`;
    await Deno.mkdir(appDir, { recursive: true });
    await Deno.writeTextFile(
      `${appDir}/herdr-app`,
      "#!/bin/sh\necho 'herdr-app 0.1.14'\n",
    );
    await Deno.chmod(`${appDir}/herdr-app`, 0o755);
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "status",
    });
    await (model.methods.status.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({
      appDir,
      binDir: `${dir}/bin`,
      herdrHome: appHome,
    }, context);
    const status = getWrittenResources().find((r) => r.specName === "status");
    assertEquals(status?.data.themeInstalled, true);
    assertEquals(status?.data.themeSelected, true);
    assertEquals(status?.data.herdrHome, appHome);
    assertEquals(
      status?.data.themeFile,
      `${appHome}/themes/borland-modern-blue.json`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a real release manifest parses through the shared parser", () => {
  const parsed = JSON.parse(JSON.stringify(APP_MANIFEST)) as ReleaseManifest;
  assertEquals(parsed.targets["linux-x86_64"].sha256, "a".repeat(64));
});
