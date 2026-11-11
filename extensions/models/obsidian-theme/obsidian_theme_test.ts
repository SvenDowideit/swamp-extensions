import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";

import {
  appearanceRelFor,
  BUNDLED_THEMES,
  chooseVault,
  createDirectVaultPort,
  deriveInstalledThemeNames,
  effectiveGlobals,
  type GlobalArgs,
  installBundledTheme,
  installThemes,
  listInstalledThemes,
  normalizeConfigDir,
  obsidianRegistryPath,
  parseAppearance,
  parseVaultRegistry,
  readActiveTheme,
  readBundledTheme,
  resolveBundledTheme,
  resolveVaultTarget,
  selectInstalledTheme,
  setSelectedTheme,
  setupVault,
  themesRelFor,
  vaultAbsolutePath,
  vaultNameFromPath,
  type VaultPort,
} from "./obsidian_theme.ts";

const G: GlobalArgs = {
  vaultPath: "/vault",
  vaultName: "",
  configDir: ".obsidian",
  defaultTheme: "borland-modern-blue",
};

const TARGET = {
  vaultPath: "/vault",
  vaultPathSource: "explicit" as const,
  registryPath: "/registry/obsidian.json",
  availableVaults: [],
};

/** Resolve bundled assets exactly as swamp's ctx.extensionFile does. */
function extensionFile(rel: string): string {
  return new URL(rel, import.meta.url).pathname;
}

/** In-memory VaultPort with the same vault-relative path semantics. */
class MemoryPort implements VaultPort {
  files = new Map<string, string>();

  read(file: string): Promise<string | null> {
    return Promise.resolve(this.files.get(file) ?? null);
  }

  write(file: string, content: string): Promise<void> {
    this.files.set(file, content);
    return Promise.resolve();
  }

  list(folder: string): Promise<string[]> {
    const prefix = folder ? `${folder.replace(/\/+$/, "")}/` : "";
    return Promise.resolve(
      [...this.files.keys()].filter((file) => file.startsWith(prefix)).sort(),
    );
  }

  exists(file: string): Promise<boolean> {
    return Promise.resolve(
      this.files.has(file) ||
        [...this.files.keys()].some((entry) => entry.startsWith(`${file}/`)),
    );
  }
}

Deno.test("resolveBundledTheme matches ids and display names", () => {
  assertEquals(
    resolveBundledTheme("borland-modern-blue")?.name,
    "Borland Modern Blue",
  );
  assertEquals(
    resolveBundledTheme("Borland Modern Blue")?.id,
    "borland-modern-blue",
  );
  assertEquals(resolveBundledTheme("swamp-club")?.name, "Swamp Club");
  assertEquals(resolveBundledTheme("nope"), null);
});

Deno.test("effectiveGlobals lets per-call vault overrides win", () => {
  assertEquals(effectiveGlobals(G, {}), G);
  assertEquals(effectiveGlobals(G, { vaultPath: "", configDir: "" }), G);
  const overridden = effectiveGlobals(G, {
    vaultPath: "/other",
    vaultName: "Other",
    configDir: "custom",
  });
  assertEquals(overridden.vaultPath, "/other");
  assertEquals(overridden.vaultName, "Other");
  assertEquals(overridden.configDir, "custom");
  assertEquals(overridden.defaultTheme, G.defaultTheme);
});

Deno.test("normalizeConfigDir rejects escapes and absolute paths", () => {
  assertEquals(normalizeConfigDir(""), ".obsidian");
  assertEquals(normalizeConfigDir(".obsidian"), ".obsidian");
  assertEquals(normalizeConfigDir("custom/config"), "custom/config");
  assertThrows(() => normalizeConfigDir("/abs/.obsidian"), Error, "relative");
  assertThrows(() => normalizeConfigDir("../.obsidian"), Error, "..");
});

Deno.test("parseAppearance treats missing/empty as empty and keeps keys", () => {
  assertEquals(parseAppearance(null), {});
  assertEquals(parseAppearance(""), {});
  assertEquals(parseAppearance('{"cssTheme":"A","accentColor":"#fff"}'), {
    cssTheme: "A",
    accentColor: "#fff",
  });
  assertThrows(() => parseAppearance("not json"), Error, "not valid JSON");
  assertThrows(() => parseAppearance("[]"), Error, "object");
});

Deno.test("setSelectedTheme preserves other appearance keys and is idempotent", () => {
  const original = JSON.stringify({
    theme: "obsidian",
    accentColor: "#c3c771",
    enabledCssSnippets: ["obsidian-factory"],
  });
  const first = setSelectedTheme(original, "Borland Modern Blue");
  assertEquals(first.changed, true);
  assertEquals(first.previous, "");
  const parsed = JSON.parse(first.text) as Record<string, unknown>;
  assertEquals(parsed.cssTheme, "Borland Modern Blue");
  assertEquals(parsed.accentColor, "#c3c771");
  assertEquals(parsed.enabledCssSnippets, ["obsidian-factory"]);

  const second = setSelectedTheme(first.text, "Borland Modern Blue");
  assertEquals(second.changed, false);
  assertEquals(second.previous, "Borland Modern Blue");
  assertEquals(second.text, first.text);
});

Deno.test("deriveInstalledThemeNames reads theme folders from file paths", () => {
  const names = deriveInstalledThemeNames(
    [
      ".obsidian/themes/Borland Modern Blue/theme.css",
      ".obsidian/themes/Borland Modern Blue/manifest.json",
      ".obsidian/themes/Swamp Club/theme.css",
      ".obsidian/themes/loose-file.css",
    ],
    ".obsidian/themes",
  );
  assertEquals(names, ["Borland Modern Blue", "Swamp Club"]);
});

Deno.test("every bundled theme has a matching manifest name and files", async () => {
  for (const entry of BUNDLED_THEMES) {
    const bundled = await readBundledTheme(entry, extensionFile);
    assertEquals(bundled.manifest.name, entry.name);
    assertEquals(bundled.css.length > 1000, true);
    assertEquals(bundled.manifestText.includes(entry.name), true);
  }
});

Deno.test("installBundledTheme writes files, skips identical, and backs up changes", async () => {
  const port = new MemoryPort();
  const entry = BUNDLED_THEMES[0];

  const first = await installBundledTheme(entry, port, G, extensionFile);
  assertEquals(first.status, "installed");
  const cssRel = `${themesRelFor(G)}/${entry.name}/theme.css`;
  const manifestRel = `${themesRelFor(G)}/${entry.name}/manifest.json`;
  assertEquals((await port.read(cssRel))?.includes("BORLAND") ?? true, true);
  assertEquals((await port.read(manifestRel))?.includes(entry.name), true);

  const second = await installBundledTheme(entry, port, G, extensionFile);
  assertEquals(second.status, "unchanged");

  await port.write(cssRel, "/* locally edited */\n");
  const third = await installBundledTheme(entry, port, G, extensionFile);
  assertEquals(third.status, "updated");
  assertEquals(
    await port.read(`${cssRel}.bak-obsidian-theme`),
    "/* locally edited */\n",
  );
  assertEquals((await port.read(cssRel))?.includes("BORLAND") ?? false, true);
});

Deno.test("installThemes installs both bundled themes", async () => {
  const port = new MemoryPort();
  const results = await installThemes(
    [...BUNDLED_THEMES],
    port,
    G,
    extensionFile,
  );
  assertEquals(results.map((result) => result.name), [
    "Borland Modern Blue",
    "Swamp Club",
  ]);
  assertEquals(results.every((result) => result.status === "installed"), true);
});

Deno.test("listInstalledThemes reports bundled flags and the active theme", async () => {
  const port = new MemoryPort();
  await installThemes([...BUNDLED_THEMES], port, G, extensionFile);
  await port.write(
    `${themesRelFor(G)}/Custom/theme.css`,
    "/* custom */\n",
  );

  const themes = await listInstalledThemes(port, G, "Borland Modern Blue");
  assertEquals(themes.map((theme) => theme.name), [
    "Borland Modern Blue",
    "Custom",
    "Swamp Club",
  ]);
  assertEquals(
    themes.find((theme) => theme.name === "Borland Modern Blue")?.active,
    true,
  );
  assertEquals(
    themes.find((theme) => theme.name === "Swamp Club")?.bundled,
    true,
  );
  assertEquals(themes.find((theme) => theme.name === "Custom")?.bundled, false);
});

Deno.test("selectInstalledTheme sets cssTheme, preserves keys and backs up once", async () => {
  const port = new MemoryPort();
  await installThemes([...BUNDLED_THEMES], port, G, extensionFile);
  const appearanceRel = appearanceRelFor(G);
  const original = JSON.stringify({
    theme: "obsidian",
    accentColor: "#c3c771",
    enabledCssSnippets: ["obsidian-factory"],
  });
  await port.write(appearanceRel, original);

  const first = await selectInstalledTheme(port, G, "borland-modern-blue");
  assertEquals(first.theme, "Borland Modern Blue");
  assertEquals(first.previous, "");
  assertEquals(first.changed, true);
  const parsed = JSON.parse((await port.read(appearanceRel)) ?? "{}") as Record<
    string,
    unknown
  >;
  assertEquals(parsed.cssTheme, "Borland Modern Blue");
  assertEquals(parsed.accentColor, "#c3c771");
  assertEquals(parsed.enabledCssSnippets, ["obsidian-factory"]);
  assertEquals(
    await port.read(`${appearanceRel}.bak-obsidian-theme`),
    original,
  );

  const second = await selectInstalledTheme(port, G, "Borland Modern Blue");
  assertEquals(second.changed, false);
  assertEquals(
    await port.read(`${appearanceRel}.bak-obsidian-theme`),
    original,
  );
});

Deno.test("selectInstalledTheme refuses a theme that is not installed", async () => {
  const port = new MemoryPort();
  await installThemes([...BUNDLED_THEMES], port, G, extensionFile);
  await assertRejects(
    () => selectInstalledTheme(port, G, "Midnight"),
    Error,
    "not installed",
  );
});

Deno.test("setupVault reports a missing vault without writing", async () => {
  const port = new MemoryPort();
  const report = await setupVault(port, G, TARGET);
  assertEquals(report.vaultPresent, false);
  assertEquals(report.installed, []);
  assertEquals(report.bundled.every((theme) => !theme.installed), true);
  assertEquals(report.vaultPathSource, "explicit");
});

Deno.test("setupVault reports installed themes and the active one", async () => {
  const port = new MemoryPort();
  await installThemes([...BUNDLED_THEMES], port, G, extensionFile);
  await selectInstalledTheme(port, G, "swamp-club");

  const report = await setupVault(port, G, TARGET);
  assertEquals(report.vaultPresent, true);
  assertEquals(report.themesPresent, true);
  assertEquals(report.activeTheme, "Swamp Club");
  assertEquals(report.installed.length, 2);
  assertEquals(report.vaultPath, "/vault");
  assertEquals(
    report.bundled.find((theme) => theme.id === "swamp-club")?.active,
    true,
  );
});

Deno.test("readActiveTheme returns an empty string when no theme is chosen", async () => {
  const port = new MemoryPort();
  assertEquals(await readActiveTheme(port, G), "");
  await port.write(
    appearanceRelFor(G),
    JSON.stringify({ accentColor: "#fff" }),
  );
  assertEquals(await readActiveTheme(port, G), "");
  await port.write(
    appearanceRelFor(G),
    JSON.stringify({ cssTheme: "Swamp Club" }),
  );
  assertEquals(await readActiveTheme(port, G), "Swamp Club");
});

Deno.test("vaultAbsolutePath keeps Windows drive and UNC roots", () => {
  assertEquals(
    vaultAbsolutePath(
      "C:\\Users\\me\\Vault",
      ".obsidian/themes/Borland/theme.css",
      "windows",
    ),
    "C:\\Users\\me\\Vault\\.obsidian\\themes\\Borland\\theme.css",
  );
  assertEquals(
    vaultAbsolutePath(
      "C:/Users/me/Vault",
      ".obsidian/appearance.json",
      "windows",
    ),
    "C:\\Users\\me\\Vault\\.obsidian\\appearance.json",
  );
  assertEquals(
    vaultAbsolutePath(
      "\\\\server\\share\\Vault",
      ".obsidian/appearance.json",
      "windows",
    ),
    "\\\\server\\share\\Vault\\.obsidian\\appearance.json",
  );
  assertEquals(
    vaultAbsolutePath("/home/me/Vault", ".obsidian/appearance.json", "linux"),
    "/home/me/Vault/.obsidian/appearance.json",
  );
  assertThrows(
    () => vaultAbsolutePath("C:\\V", "../escape", "windows"),
    Error,
    "escapes",
  );
  assertThrows(
    () => vaultAbsolutePath("/v", "C:\\absolute", "linux"),
    Error,
    "absolute",
  );
});

Deno.test("obsidianRegistryPath is per-platform", () => {
  assertEquals(
    obsidianRegistryPath({
      platform: "windows",
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      home: "C:\\Users\\me",
    }),
    "C:\\Users\\me\\AppData\\Roaming\\obsidian\\obsidian.json",
  );
  assertEquals(
    obsidianRegistryPath({
      platform: "windows",
      env: { USERPROFILE: "C:\\Users\\me" },
      home: "C:\\Users\\me",
    }),
    "C:\\Users\\me\\AppData\\Roaming\\obsidian\\obsidian.json",
  );
  assertEquals(
    obsidianRegistryPath({ platform: "darwin", env: {}, home: "/Users/me" }),
    "/Users/me/Library/Application Support/obsidian/obsidian.json",
  );
  assertEquals(
    obsidianRegistryPath({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/cfg" },
      home: "/home/me",
    }),
    "/cfg/obsidian/obsidian.json",
  );
  assertEquals(
    obsidianRegistryPath({ platform: "linux", env: {}, home: "/home/me" }),
    "/home/me/.config/obsidian/obsidian.json",
  );
});

const WINDOWS_REGISTRY = JSON.stringify({
  vaults: {
    a: {
      path: "C:\\Users\\me\\Documents\\Main Vault",
      ts: 2,
      open: true,
    },
    b: { path: "D:\\Other\\Notes", ts: 1 },
  },
});

Deno.test("parseVaultRegistry reads Windows backslash paths", () => {
  const vaults = parseVaultRegistry(WINDOWS_REGISTRY);
  assertEquals(vaults.map((vault) => vault.name), ["Main Vault", "Notes"]);
  assertEquals(vaults[0].open, true);
  assertEquals(vaults[0].path, "C:\\Users\\me\\Documents\\Main Vault");
  assertEquals(vaultNameFromPath("C:\\Users\\me\\Vault\\"), "Vault");
  assertEquals(vaultNameFromPath("/home/me/Vault/"), "Vault");
});

Deno.test("chooseVault prefers open, honours a name, and refuses ambiguity", () => {
  const vaults = parseVaultRegistry(WINDOWS_REGISTRY);
  assertEquals(chooseVault(vaults).entry.name, "Main Vault");
  assertEquals(chooseVault(vaults, "Notes").entry.path, "D:\\Other\\Notes");
  assertThrows(() => chooseVault(vaults, "Nope"), Error, "No vault named");
  assertThrows(
    () =>
      chooseVault(
        parseVaultRegistry(JSON.stringify({
          vaults: { a: { path: "C:\\A" }, b: { path: "C:\\B" } },
        })),
      ),
    Error,
    "none is marked open",
  );
});

Deno.test("resolveVaultTarget uses explicit paths and the registry", async () => {
  const explicit = await resolveVaultTarget(
    { ...G, vaultPath: "C:\\Users\\me\\Vault" },
    {
      registryPath: "C:\\r\\obsidian.json",
      readTextFile: () => Promise.reject(new Error("should not read")),
    },
  );
  assertEquals(explicit.vaultPath, "C:\\Users\\me\\Vault");
  assertEquals(explicit.vaultPathSource, "explicit");

  const fromRegistry = await resolveVaultTarget(
    { ...G, vaultPath: "", vaultName: "" },
    {
      registryPath: "C:\\r\\obsidian.json",
      readTextFile: () => Promise.resolve(WINDOWS_REGISTRY),
    },
  );
  assertEquals(
    fromRegistry.vaultPath,
    "C:\\Users\\me\\Documents\\Main Vault",
  );
  assertEquals(fromRegistry.vaultPathSource, "registry-default");
  assertEquals(fromRegistry.availableVaults.length, 2);

  const named = await resolveVaultTarget(
    { ...G, vaultPath: "", vaultName: "Notes" },
    {
      registryPath: "C:\\r\\obsidian.json",
      readTextFile: () => Promise.resolve(WINDOWS_REGISTRY),
    },
  );
  assertEquals(named.vaultPath, "D:\\Other\\Notes");
  assertEquals(named.vaultPathSource, "registry-name");
});

Deno.test("createDirectVaultPort reads, writes, lists and checks paths", async () => {
  const root = await Deno.makeTempDir();
  try {
    const port = createDirectVaultPort(root);
    assertEquals(await port.read(".obsidian/appearance.json"), null);
    assertEquals(await port.exists(".obsidian"), false);
    await port.write(".obsidian/themes/Custom/theme.css", "body{}\n");
    assertEquals(
      await port.read(".obsidian/themes/Custom/theme.css"),
      "body{}\n",
    );
    assertEquals(await port.exists(".obsidian"), true);
    assertEquals(
      await port.list(".obsidian/themes"),
      [".obsidian/themes/Custom/theme.css"],
    );
    await assertRejects(
      () => port.read("../escape"),
      Error,
      "escapes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
