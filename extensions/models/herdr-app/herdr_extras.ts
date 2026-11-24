/**
 * `@svendowideit/herdr-app` extras: the swamp bar inside Herdr and the config
 * the two mods read.
 *
 * Two small Herdr mods are installed into Herdr's own home:
 *
 * - `mods/obsidian-idea` — an input that captures a thought onto the swamp
 *   `obsidian-factory` board by running that model's `capture` method. The
 *   board model stays the only writer; this extension never touches the vault.
 * - `mods/browser-launch` — a button that opens the configured argv (browsh by
 *   default) in a new Herdr tab on the focused space's machine.
 *
 * They are placed in a layout by `@svendowideit/swamp-ide`, which only carries a
 * block for a mod that exists. This module writes the files, the two configs
 * (`swamp.json`, `browser.json`) and merges one `programs.json` entry and two
 * `keys.json` bindings, never replacing anything a person wrote unless forced.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, join } from "node:path";
import type { HostDeps } from "./herdr_app.ts";

/** The mod that captures an idea onto the board. */
export const IDEA_MOD = "obsidian-idea";
/** The mod with the browser button. */
export const BROWSER_MOD = "browser-launch";
/** The browser argv used when none is configured. */
export const BROWSH_ARGV = ["docker", "run", "--rm", "-it", "browsh/browsh"];
/** The files every installed mod folder carries. */
const MOD_FILES = ["main.js", "mod.json", "icon.svg"];
/** The key that opens the idea dialog, and the one that opens a browser tab. */
export const IDEA_KEY = "ctrl-shift-i";
export const BROWSER_KEY = "ctrl-alt-b";

/** Arguments for `installExtras`. */
export const ExtrasArgsSchema = z.object({
  ideaBox: z.boolean().default(true).describe(
    "Install the idea box mod and the swamp.json it reads (repo, board model, swamp binary).",
  ),
  browserButton: z.boolean().default(true).describe(
    "Install the browser button mod and the browser.json argv it reads.",
  ),
  programsEntry: z.boolean().default(true).describe(
    "Add the `browsh` entry to programs.json, so the tab + menu lists the browser too.",
  ),
  keys: z.boolean().default(true).describe(
    "Merge the ctrl-shift-i and ctrl-alt-b bindings into keys.json when those keys are free.",
  ),
  swampRepo: z.string().default("").describe(
    "Absolute path to the swamp repository that holds the obsidian-board model. Required with ideaBox.",
  ),
  boardModel: z.string().default("obsidian-board").describe(
    "The behavior instance whose `capture` method the idea box calls.",
  ),
  swampBinary: z.string().default("").describe(
    "The swamp binary the idea box runs. Empty finds `swamp` on PATH and records its absolute path.",
  ),
  browserArgv: z.array(z.string()).default(BROWSH_ARGV).describe(
    "Program and arguments the browser button opens in a new tab. Default: docker run --rm -it browsh/browsh.",
  ),
  herdrBin: z.string().default("herdr-app").describe(
    "Herdr app binary used to check each installed mod before reporting success.",
  ),
  herdrHome: z.string().default("").describe(
    "Override Herdr's own home. Empty uses $HERDR_APP_HOME, then $XDG_CONFIG_HOME/herdr-app, then ~/.config/herdr-app.",
  ),
  force: z.boolean().default(false).describe(
    "Replace a mod file or config that differs, and a taken programs.json entry or key binding.",
  ),
}).strict();

/** Arguments for `installExtras`. */
export type ExtrasArgsType = z.infer<typeof ExtrasArgsSchema>;

/** What `installExtras` did, including Herdr's own check of each mod. */
export const ExtrasSchema = z.object({
  herdrHome: z.string(),
  mods: z.array(z.object({
    name: z.string(),
    dir: z.string(),
    action: z.string(),
    written: z.array(z.string()).default([]),
    skipped: z.array(z.string()).default([]),
  })).default([]),
  configs: z.array(z.object({
    path: z.string(),
    action: z.string(),
  })).default([]),
  programs: z.object({
    path: z.string(),
    entry: z.string(),
    action: z.string(),
  }),
  keys: z.array(z.object({
    key: z.string(),
    action: z.string(),
  })).default([]),
  checks: z.array(z.object({
    name: z.string(),
    dir: z.string(),
    code: z.number(),
    output: z.string().default(""),
  })).default([]),
  warnings: z.array(z.string()).default([]),
  updatedAt: z.string(),
});

/** The result of `installExtras`. */
export type ExtrasResult = z.infer<typeof ExtrasSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse a JSON object file body; an empty or absent file is `{}`. */
export function parseJsonObject(
  text: string,
  path: string,
): Record<string, unknown> {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${
        errorMessage(error)
      }); fix or move it, then re-run`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must hold a JSON object`);
  }
  return value as Record<string, unknown>;
}

function objectAt(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} in this JSON file must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Add or refresh one `programs.json` entry. Every other key is kept as it was
 * (the file is re-serialised, so formatting is normalised). A different entry
 * under the same name is left alone unless `force`.
 */
export function mergeProgramsEntry(
  text: string,
  opts: {
    name: string;
    entry: Record<string, unknown>;
    force: boolean;
    path?: string;
  },
): { text: string; action: "installed" | "updated" | "unchanged" | "kept" } {
  const root = parseJsonObject(text, opts.path ?? "programs.json");
  const programs = objectAt(root, "programs");
  const existing = programs[opts.name];
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(opts.entry)) {
      return { text, action: "unchanged" };
    }
    if (!opts.force) return { text, action: "kept" };
  }
  const action = existing === undefined ? "installed" : "updated";
  programs[opts.name] = opts.entry;
  root.programs = programs;
  return { text: `${JSON.stringify(root, null, 2)}\n`, action };
}

/**
 * Merge key bindings into `keys.json`'s `global` section. A key that is already
 * bound is never replaced unless `force`, and an identical binding is unchanged.
 */
export function mergeKeyBindings(
  text: string,
  opts: {
    bindings: Array<{ key: string; action: unknown }>;
    force: boolean;
    path?: string;
  },
): { text: string; actions: Array<{ key: string; action: string }> } {
  const root = parseJsonObject(text, opts.path ?? "keys.json");
  const global = objectAt(root, "global");
  const actions: Array<{ key: string; action: string }> = [];
  let changed = false;
  for (const binding of opts.bindings) {
    const existing = global[binding.key];
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(binding.action)) {
        actions.push({ key: binding.key, action: "unchanged" });
        continue;
      }
      if (!opts.force) {
        actions.push({ key: binding.key, action: "kept" });
        continue;
      }
      global[binding.key] = binding.action;
      changed = true;
      actions.push({ key: binding.key, action: "replaced" });
      continue;
    }
    global[binding.key] = binding.action;
    changed = true;
    actions.push({ key: binding.key, action: "installed" });
  }
  root.global = global;
  return {
    text: changed ? `${JSON.stringify(root, null, 2)}\n` : text,
    actions,
  };
}

/**
 * The first executable named `name` on `pathEnv`, or "". A PATH scan, no shell:
 * Windows tries `.exe`, `.cmd`, `.bat` and the bare name in each folder.
 */
export function findExecutable(
  name: string,
  pathEnv: string,
  isFile: (path: string) => boolean,
  windows = false,
): string {
  if (!name) return "";
  if (name.includes("/") || name.includes("\\")) {
    return isFile(name) ? name : "";
  }
  const exts = windows ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(windows ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return "";
}

/** The mods to install, in bar order. */
export function extrasModsFor(
  ideaBox: boolean,
  browserButton: boolean,
): Array<{ name: string }> {
  const jobs: Array<{ name: string }> = [];
  if (ideaBox) jobs.push({ name: IDEA_MOD });
  if (browserButton) jobs.push({ name: BROWSER_MOD });
  return jobs;
}

async function readTextOr(path: string, fallback: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return fallback;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Write a file through a temporary neighbour, so a reader never sees half. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.new-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}

/**
 * Write a file only when its bytes differ. A different existing file is kept
 * (reported as `kept`) unless `force`, which saves it as `.bak-herdr-app` first.
 *
 * The hashes recorded in `swamp-extras.json` are what make an upgrade possible:
 * a file still matching the hash we wrote last time is ours and is replaced
 * (`updated`); a file that no longer matches was edited by a person and is kept.
 */
export async function writeIfChanged(
  path: string,
  text: string,
  force: boolean,
): Promise<"installed" | "updated" | "unchanged" | "kept"> {
  const existing = await readTextOr(path, "");
  if (existing === text) {
    if (installState) installState.files[path] = await sha256Hex(text);
    return "unchanged";
  }
  const recorded = installState?.files[path] ?? "";
  const ours = existing !== "" && recorded !== "" &&
    recorded === await sha256Hex(existing);
  if (existing !== "" && !ours && !force) return "kept";
  if (existing !== "") {
    await Deno.writeTextFile(`${path}.bak-herdr-app`, existing);
  }
  await writeAtomic(path, text);
  if (installState) installState.files[path] = await sha256Hex(text);
  return existing === "" ? "installed" : "updated";
}

/** The hashes of what this extension last wrote, so an upgrade replaces its own files. */
interface ExtrasState {
  files: Record<string, string>;
}

const STATE_FILE = "swamp-extras.json";

/** The install in progress (null outside `installHerdrExtras`). */
let installState: ExtrasState | null = null;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function readState(home: string): Promise<ExtrasState> {
  const text = await readTextOr(join(home, STATE_FILE), "");
  if (text.trim() === "") return { files: {} };
  try {
    const value = JSON.parse(text) as { files?: Record<string, string> };
    return { files: value.files ?? {} };
  } catch {
    return { files: {} };
  }
}

async function writeState(
  home: string,
  state: ExtrasState | null,
): Promise<void> {
  if (!state) return;
  await writeAtomic(
    join(home, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** The swamp binary to record: the given path, or `swamp` found on PATH. */
function resolveSwampBinary(given: string): string {
  const trimmed = given.trim();
  if (trimmed) return trimmed;
  const isFile = (path: string) => {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  };
  let envPath = "";
  try {
    envPath = Deno.env.get("PATH") ?? "";
  } catch {
    envPath = "";
  }
  return findExecutable(
    "swamp",
    envPath,
    isFile,
    Deno.build.os === "windows",
  );
}

export interface ExtrasInstallOptions {
  /** Herdr's own home (already resolved by the caller). */
  appHome: string;
  ideaBox: boolean;
  browserButton: boolean;
  programsEntry: boolean;
  keys: boolean;
  swampRepo: string;
  boardModel: string;
  swampBinary: string;
  browserArgv: string[];
  herdrBin: string;
  force: boolean;
  /** Resolves a bundled extension file (swamp's `extensionFile`). */
  files: (relative: string) => string;
}

/**
 * Install the swamp bar mods and the config they read. Idempotent: a second run
 * with the same inputs writes nothing. Nothing is overwritten that differs,
 * unless `force`, and then the old file is kept as `.bak-herdr-app`.
 */
export async function installHerdrExtras(
  deps: HostDeps,
  opts: ExtrasInstallOptions,
): Promise<ExtrasResult> {
  const warnings: string[] = [];
  const mods: ExtrasResult["mods"] = [];
  const configs: Array<{ path: string; action: string }> = [];
  const browserArgv = opts.browserArgv.length > 0
    ? opts.browserArgv.map(String)
    : [...BROWSH_ARGV];
  installState = await readState(opts.appHome);

  for (const job of extrasModsFor(opts.ideaBox, opts.browserButton)) {
    const dir = join(opts.appHome, "mods", job.name);
    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of MOD_FILES) {
      const bundled = await readTextOr(
        opts.files(`extras/${job.name}/${file}`),
        "",
      );
      if (bundled === "") {
        throw new Error(
          `the bundled extras/${job.name}/${file} is missing; the extension is incomplete`,
        );
      }
      const action = await writeIfChanged(
        join(dir, file),
        bundled,
        opts.force,
      );
      if (action === "installed" || action === "updated") written.push(file);
      if (action === "kept") skipped.push(file);
    }
    if (skipped.length > 0) {
      warnings.push(
        `${
          join(dir, skipped[0])
        } differs from the bundled file; left alone (force=true to replace)`,
      );
    }
    mods.push({
      name: job.name,
      dir,
      action: skipped.length > 0
        ? "kept"
        : written.length > 0
        ? "installed"
        : "unchanged",
      written,
      skipped,
    });
  }

  if (opts.ideaBox) {
    const repo = opts.swampRepo.trim();
    if (!repo) {
      throw new Error(
        "swampRepo is required to install the idea box: pass the swamp repository that holds the obsidian-board model",
      );
    }
    if (!(await pathExists(join(repo, ".swamp.yaml")))) {
      throw new Error(
        `${repo} is not a swamp repository (no .swamp.yaml); pass the repository that holds obsidian-board`,
      );
    }
    const swampBinary = resolveSwampBinary(opts.swampBinary);
    if (!swampBinary) {
      throw new Error(
        "cannot find the swamp binary: pass swampBinary=<absolute path to swamp>",
      );
    }
    const path = join(opts.appHome, "swamp.json");
    const body = `${
      JSON.stringify(
        {
          repo,
          boardModel: opts.boardModel || "obsidian-board",
          swampBinary,
          source: "herdr",
        },
        null,
        2,
      )
    }\n`;
    configs.push({
      path,
      action: await writeIfChanged(path, body, opts.force),
    });
  }

  if (opts.browserButton) {
    const path = join(opts.appHome, "browser.json");
    const body = `${JSON.stringify({ argv: browserArgv }, null, 2)}\n`;
    configs.push({
      path,
      action: await writeIfChanged(path, body, opts.force),
    });
  }

  const programsPath = join(opts.appHome, "programs.json");
  let programs: ExtrasResult["programs"] = {
    path: programsPath,
    entry: "browsh",
    action: "skipped",
  };
  if (opts.browserButton && opts.programsEntry) {
    const text = await readTextOr(programsPath, "");
    const merged = mergeProgramsEntry(text, {
      name: "browsh",
      entry: {
        name: "Browser (browsh)",
        icon: `mods/${BROWSER_MOD}/icon.svg`,
        tint: true,
        tile: "#ff7139",
        match: ["browsh"],
        run: browserArgv,
      },
      force: opts.force,
      path: programsPath,
    });
    if (merged.text !== text) {
      if (text !== "") {
        await Deno.writeTextFile(`${programsPath}.bak-herdr-app`, text);
      }
      await writeAtomic(programsPath, merged.text);
    }
    programs = { path: programsPath, entry: "browsh", action: merged.action };
    if (merged.action === "kept") {
      warnings.push(
        `${programsPath} already has a different "browsh" entry; left alone (force=true to replace)`,
      );
    }
  }

  const keysPath = join(opts.appHome, "keys.json");
  let keyActions: Array<{ key: string; action: string }> = [];
  if (opts.keys) {
    const bindings: Array<{ key: string; action: unknown }> = [];
    if (opts.ideaBox) {
      bindings.push({
        key: IDEA_KEY,
        action: { command: "mod.open", args: { name: IDEA_MOD } },
      });
    }
    if (opts.browserButton) {
      bindings.push({
        key: BROWSER_KEY,
        action: {
          command: "tab.new",
          args: { name: "Browser (browsh)", argv: browserArgv },
        },
      });
    }
    if (bindings.length > 0) {
      const text = await readTextOr(keysPath, "");
      const merged = mergeKeyBindings(text, {
        bindings,
        force: opts.force,
        path: keysPath,
      });
      if (merged.text !== text) {
        if (text !== "") {
          await Deno.writeTextFile(`${keysPath}.bak-herdr-app`, text);
        }
        await writeAtomic(keysPath, merged.text);
      }
      keyActions = merged.actions;
      for (const entry of keyActions) {
        if (entry.action === "kept") {
          warnings.push(
            `${keysPath} already binds ${entry.key}; left alone (force=true to replace)`,
          );
        }
      }
    }
  }

  const checks: ExtrasResult["checks"] = [];
  if (mods.length > 0) {
    const available = (await deps.run(opts.herdrBin, ["--version"])).code === 0;
    if (available) {
      for (const mod of mods) {
        const result = await deps.run(opts.herdrBin, ["check", mod.dir]);
        checks.push({
          name: mod.name,
          dir: mod.dir,
          code: result.code,
          output: `${result.stdout}${result.stderr}`.trim(),
        });
      }
    } else {
      warnings.push(
        `start Herdr, then run \`${opts.herdrBin} check ${mods[0].dir}\``,
      );
    }
  }

  await writeState(opts.appHome, installState);
  installState = null;

  return {
    herdrHome: opts.appHome,
    mods,
    configs,
    programs,
    keys: keyActions,
    checks,
    warnings,
    updatedAt: deps.now().toISOString(),
  };
}
