/**
 * Tests for the Herdr extras installer: the JSON and keys merges, the PATH
 * lookup, and a whole install against a temporary Herdr home.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { join } from "node:path";
import {
  BROWSH_ARGV,
  extrasModsFor,
  findExecutable,
  installHerdrExtras,
  mergeKeyBindings,
  mergeProgramsEntry,
  parseJsonObject,
  writeIfChanged,
} from "./herdr_extras.ts";
import type { HostDeps as Deps } from "./herdr_app.ts";

const ENTRY = { name: "Browser (browsh)", run: ["docker", "x"] };

function mergePrograms(text: string, force = false) {
  return mergeProgramsEntry(text, {
    name: "browsh",
    entry: ENTRY,
    force,
    path: "programs.json",
  });
}

Deno.test("mergeProgramsEntry adds the entry and keeps everything else", () => {
  const before = JSON.stringify({
    programs: { zed: { name: "Zed" } },
    shells: ["xonsh"],
  });
  const { text, action } = mergePrograms("");
  assertEquals(action, "installed");
  assertEquals(JSON.parse(text), { programs: { browsh: ENTRY } });

  const merged = mergePrograms(before);
  assertEquals(merged.action, "installed");
  const root = JSON.parse(merged.text);
  assertEquals(root.programs.zed, { name: "Zed" });
  assertEquals(root.programs.browsh, ENTRY);
  assertEquals(root.shells, ["xonsh"]);
});

Deno.test("mergeProgramsEntry leaves an identical entry unchanged", () => {
  const once = mergePrograms("").text;
  const again = mergePrograms(once);
  assertEquals(again.action, "unchanged");
  assertEquals(again.text, once);
});

Deno.test("mergeProgramsEntry keeps a different entry unless forced", () => {
  const before = JSON.stringify({
    programs: { browsh: { name: "Mine", run: ["firefox"] } },
  });
  const kept = mergePrograms(before);
  assertEquals(kept.action, "kept");
  assertEquals(kept.text, before);

  const forced = mergePrograms(before, true);
  assertEquals(forced.action, "updated");
  assertEquals(JSON.parse(forced.text).programs.browsh, ENTRY);
});

Deno.test("parseJsonObject accepts empty and rejects what is not an object", () => {
  assertEquals(parseJsonObject("  ", "x.json"), {});
  assert("a" in parseJsonObject('{"a":1}', "x.json"));
  try {
    parseJsonObject("[]", "x.json");
    throw new Error("expected a throw");
  } catch (error) {
    assertStringIncludes(String(error), "must hold a JSON object");
  }
  try {
    parseJsonObject("{", "x.json");
    throw new Error("expected a throw");
  } catch (error) {
    assertStringIncludes(String(error), "is not valid JSON");
  }
});

const OPEN_BINDING = { command: "mod.open", args: { name: "obsidian-idea" } };

Deno.test("mergeKeyBindings fills a free key and keeps other sections", () => {
  const before = JSON.stringify({
    global: { "ctrl-shift-t": "tab.new" },
    terminal: { "ctrl-shift-c": "terminal.copy" },
  });
  const merged = mergeKeyBindings(before, {
    bindings: [{ key: "ctrl-shift-i", action: OPEN_BINDING }],
    force: false,
    path: "keys.json",
  });
  assertEquals(merged.actions, [
    { key: "ctrl-shift-i", action: "installed" },
  ]);
  const root = JSON.parse(merged.text);
  assertEquals(root.global["ctrl-shift-i"], OPEN_BINDING);
  assertEquals(root.global["ctrl-shift-t"], "tab.new");
  assertEquals(root.terminal["ctrl-shift-c"], "terminal.copy");
});

Deno.test("mergeKeyBindings never replaces a taken key without force", () => {
  const before = JSON.stringify({ global: { "ctrl-shift-i": "tab.new" } });
  const kept = mergeKeyBindings(before, {
    bindings: [{ key: "ctrl-shift-i", action: OPEN_BINDING }],
    force: false,
    path: "keys.json",
  });
  assertEquals(kept.actions, [{ key: "ctrl-shift-i", action: "kept" }]);
  assertEquals(kept.text, before);

  const forced = mergeKeyBindings(before, {
    bindings: [{ key: "ctrl-shift-i", action: OPEN_BINDING }],
    force: true,
    path: "keys.json",
  });
  assertEquals(forced.actions, [{ key: "ctrl-shift-i", action: "replaced" }]);
  assertEquals(JSON.parse(forced.text).global["ctrl-shift-i"], OPEN_BINDING);
});

Deno.test("mergeKeyBindings reports an identical binding as unchanged", () => {
  const once = mergeKeyBindings("", {
    bindings: [{ key: "ctrl-shift-i", action: OPEN_BINDING }],
    force: false,
    path: "keys.json",
  });
  const again = mergeKeyBindings(once.text, {
    bindings: [{ key: "ctrl-shift-i", action: OPEN_BINDING }],
    force: false,
    path: "keys.json",
  });
  assertEquals(again.actions, [
    { key: "ctrl-shift-i", action: "unchanged" },
  ]);
  assertEquals(again.text, once.text);
});

Deno.test("findExecutable scans PATH without a shell", () => {
  const have = new Set(["/one/swamp", "/two/swamp", "C:/bin/swamp.exe"]);
  const isFile = (path: string) => have.has(path);
  assertEquals(findExecutable("swamp", "/one:/two", isFile), "/one/swamp");
  assertEquals(findExecutable("swamp", "/none:/two", isFile), "/two/swamp");
  assertEquals(findExecutable("swamp", "/none", isFile), "");
  assertEquals(
    findExecutable("swamp", "C:/bin", isFile, true),
    "C:/bin/swamp.exe",
  );
  assertEquals(findExecutable("/one/swamp", "", isFile), "/one/swamp");
  assertEquals(findExecutable("/one/nope", "", isFile), "");
});

Deno.test("extrasModsFor follows the two switches", () => {
  assertEquals(extrasModsFor(true, true).map((m) => m.name), [
    "obsidian-idea",
    "browser-launch",
  ]);
  assertEquals(extrasModsFor(true, false).map((m) => m.name), [
    "obsidian-idea",
  ]);
  assertEquals(extrasModsFor(false, false), []);
});

// ---------------------------------------------------------------------------
// A whole install against a temporary home
// ---------------------------------------------------------------------------

function fakeDeps(dir: string): Deps {
  return {
    fetch: (() => {
      throw new Error("no fetch expected");
    }) as unknown as typeof fetch,
    run: (command, args) => {
      // Herdr is not running in the test: --version fails, so checks are skipped.
      void command;
      void args;
      return Promise.resolve({ code: 127, stdout: "", stderr: "" });
    },
    os: "linux",
    arch: "x86_64",
    rosetta: false,
    env: {
      home: dir,
      localAppData: "",
      xdgData: "",
      xdgCache: "",
      xdgConfig: "",
      herdrAppHome: "",
      userProfile: "",
      systemRoot: "",
    },
    log: () => {},
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  };
}

async function fixtureFiles(
  dir: string,
): Promise<(relative: string) => string> {
  const root = join(dir, "bundled");
  for (const mod of ["obsidian-idea", "browser-launch"]) {
    for (const file of ["main.js", "mod.json", "icon.svg"]) {
      const path = join(root, "extras", mod, file);
      await Deno.mkdir(join(root, "extras", mod), { recursive: true });
      await Deno.writeTextFile(path, `${mod}/${file}\n`);
    }
  }
  return (relative) => join(root, relative);
}

async function withHome(
  body: (dir: string, files: (relative: string) => string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const home = join(dir, "herdr");
    const repo = join(dir, "repo");
    await Deno.mkdir(home, { recursive: true });
    await Deno.mkdir(repo, { recursive: true });
    await Deno.writeTextFile(join(repo, ".swamp.yaml"), "name: t\n");
    await body(home, await fixtureFiles(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function opts(
  home: string,
  files: (relative: string) => string,
  over: Partial<Parameters<typeof installHerdrExtras>[1]> = {},
) {
  return {
    appHome: home,
    ideaBox: true,
    browserButton: true,
    programsEntry: true,
    keys: true,
    swampRepo: join(home, "..", "repo"),
    boardModel: "obsidian-board",
    swampBinary: "/usr/local/bin/swamp",
    browserArgv: BROWSH_ARGV,
    herdrBin: "herdr-app",
    force: false,
    files,
    ...over,
  };
}

Deno.test("installHerdrExtras writes the mods, configs, entry and keys", async () => {
  await withHome(async (home, files) => {
    const result = await installHerdrExtras(fakeDeps(home), opts(home, files));

    for (const mod of ["obsidian-idea", "browser-launch"]) {
      const dir = join(home, "mods", mod);
      assertEquals(
        await Deno.readTextFile(join(dir, "main.js")),
        `${mod}/main.js\n`,
      );
      assertEquals(
        await Deno.readTextFile(join(dir, "icon.svg")),
        `${mod}/icon.svg\n`,
      );
    }
    assertEquals(result.mods.map((m) => m.action), ["installed", "installed"]);

    const swamp = JSON.parse(await Deno.readTextFile(join(home, "swamp.json")));
    assertEquals(swamp.boardModel, "obsidian-board");
    assertEquals(swamp.swampBinary, "/usr/local/bin/swamp");
    assertEquals(swamp.source, "herdr");

    const browser = JSON.parse(
      await Deno.readTextFile(join(home, "browser.json")),
    );
    assertEquals(browser.argv, BROWSH_ARGV);

    const programs = JSON.parse(
      await Deno.readTextFile(join(home, "programs.json")),
    );
    assertEquals(programs.programs.browsh.run, BROWSH_ARGV);
    assertEquals(result.programs.action, "installed");

    const keys = JSON.parse(await Deno.readTextFile(join(home, "keys.json")));
    assertEquals(keys.global["ctrl-shift-i"].command, "mod.open");
    assertEquals(keys.global["ctrl-alt-b"].command, "tab.new");
    assertEquals(result.keys.map((k) => k.key), ["ctrl-shift-i", "ctrl-alt-b"]);

    // Herdr is not running in the test, so the install says how to check instead.
    assertEquals(result.checks, []);
    assertStringIncludes(result.warnings.join(" "), "start Herdr");
  });
});

Deno.test("installHerdrExtras is idempotent", async () => {
  await withHome(async (home, files) => {
    const deps = fakeDeps(home);
    await installHerdrExtras(deps, opts(home, files));
    const before = await Deno.readTextFile(join(home, "keys.json"));
    const again = await installHerdrExtras(deps, opts(home, files));
    assertEquals(again.mods.map((m) => m.action), ["unchanged", "unchanged"]);
    assertEquals(again.programs.action, "unchanged");
    assertEquals(again.keys.map((k) => k.action), ["unchanged", "unchanged"]);
    assertEquals(await Deno.readTextFile(join(home, "keys.json")), before);
  });
});

Deno.test("installHerdrExtras keeps an edited mod and an edited config", async () => {
  await withHome(async (home, files) => {
    const deps = fakeDeps(home);
    await installHerdrExtras(deps, opts(home, files));
    await Deno.writeTextFile(
      join(home, "mods", "obsidian-idea", "main.js"),
      "// mine\n",
    );
    await Deno.writeTextFile(join(home, "browser.json"), '{"argv":["mine"]}\n');

    const kept = await installHerdrExtras(deps, opts(home, files));
    assertEquals(kept.mods[0].action, "kept");
    assertEquals(kept.mods[0].skipped, ["main.js"]);
    assertEquals(
      await Deno.readTextFile(join(home, "mods", "obsidian-idea", "main.js")),
      "// mine\n",
    );
    assertEquals(
      await Deno.readTextFile(join(home, "browser.json")),
      '{"argv":["mine"]}\n',
    );
    assertStringIncludes(
      kept.warnings.join(" "),
      "left alone (force=true to replace)",
    );

    const forced = await installHerdrExtras(
      deps,
      opts(home, files, { force: true }),
    );
    assertEquals(forced.mods[0].action, "installed");
    assertEquals(
      await Deno.readTextFile(
        join(home, "mods", "obsidian-idea", "main.js.bak-herdr-app"),
      ),
      "// mine\n",
    );
  });
});

Deno.test("installHerdrExtras replaces its own files when the bundle changes", async () => {
  await withHome(async (home, files) => {
    const deps = fakeDeps(home);
    await installHerdrExtras(deps, opts(home, files));
    // A new release ships different mod source. The file on disk matches the
    // hash we recorded, so it is ours and must be replaced, not reported kept.
    await Deno.writeTextFile(
      files("extras/obsidian-idea/main.js"),
      "// newer\n",
    );
    const again = await installHerdrExtras(deps, opts(home, files));
    assertEquals(again.mods[0].action, "installed");
    assertEquals(
      await Deno.readTextFile(join(home, "mods", "obsidian-idea", "main.js")),
      "// newer\n",
    );
    // and the record moved with it, so the next run is silent again
    const third = await installHerdrExtras(deps, opts(home, files));
    assertEquals(third.mods[0].action, "unchanged");
  });
});

Deno.test("installHerdrExtras refuses a missing repo and a bad one", async () => {
  await withHome(async (home, files) => {
    const deps = fakeDeps(home);
    await assertRejects(
      () => installHerdrExtras(deps, opts(home, files, { swampRepo: "" })),
      Error,
      "swampRepo is required",
    );
    await assertRejects(
      () =>
        installHerdrExtras(
          deps,
          opts(home, files, { swampRepo: join(home, "nope") }),
        ),
      Error,
      "is not a swamp repository",
    );
  });
});

Deno.test("installHerdrExtras can install only the browser button", async () => {
  await withHome(async (home, files) => {
    const result = await installHerdrExtras(
      fakeDeps(home),
      opts(home, files, { ideaBox: false, swampRepo: "" }),
    );
    assertEquals(result.mods.map((m) => m.name), ["browser-launch"]);
    assertEquals(result.keys.map((k) => k.key), ["ctrl-alt-b"]);
    let swamp = "";
    try {
      swamp = await Deno.readTextFile(join(home, "swamp.json"));
    } catch {
      swamp = "";
    }
    assertEquals(swamp, "");
  });
});

Deno.test("writeIfChanged reports kept, then forced with a backup", async () => {
  await withHome(async (home) => {
    const path = join(home, "x.json");
    assertEquals(await writeIfChanged(path, "one\n", false), "installed");
    assertEquals(await writeIfChanged(path, "one\n", false), "unchanged");
    assertEquals(await writeIfChanged(path, "two\n", false), "kept");
    assertEquals(await writeIfChanged(path, "two\n", true), "updated");
    assertEquals(await Deno.readTextFile(`${path}.bak-herdr-app`), "one\n");
  });
});
