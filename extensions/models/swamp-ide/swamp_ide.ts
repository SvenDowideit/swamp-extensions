/**
 * `@svendowideit/swamp-ide` — the single front door for the agent IDE setup.
 *
 * It owns the Herdr activity panel files and exposes `setHerdr`/`status`; the
 * companion workflows call it together with the optional pi-plugin and
 * OpenObserve extensions. Nothing here shells out to swamp: the Herdr app is
 * driven through its documented `do layout.switch` command.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, join } from "node:path";

const GlobalArgsSchema = z.object({
  herdrBin: z.string().default("herdr-app").describe(
    "Herdr desktop app binary; used for the live layout switch.",
  ),
  herdrHome: z.string().default("").describe(
    "Herdr home; empty uses HERDR_APP_HOME or ~/.config/herdr-app.",
  ),
  layout: z.string().default("swamp-ide").describe(
    "Layout installed by this extension.",
  ),
  baseLayout: z.string().default("swamp").describe(
    "Layout to return to when the IDE layout is disabled.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SetHerdrArgsSchema = z.object({
  enabled: z.boolean().describe(
    "Install and select the activity layout, or remove it and return to the base layout.",
  ),
  placement: z.enum(["tabbar", "statusbar"]).default("tabbar").describe(
    "Where the swamp bar goes: a row beside the tab strip (`tabbar`), or two blocks in the status row (`statusbar`).",
  ),
});

const StatusArgsSchema = z.object({});

const EnsureVimArgsSchema = z.object({});

const VimOutputSchema = z.object({
  action: z.enum(["created", "exists", "failed"]),
  instance: z.string(),
  type: z.string(),
  message: z.string(),
  output: z.string().default(""),
  updatedAt: z.string(),
});

const ModCheckSchema = z.object({
  name: z.string(),
  dir: z.string(),
  code: z.number(),
  output: z.string().default(""),
});

const HerdrOutputSchema = z.object({
  action: z.enum(["enabled", "disabled", "unchanged"]),
  herdrHome: z.string(),
  modDir: z.string(),
  ideModDir: z.string().default(""),
  layoutPath: z.string(),
  modInstalled: z.boolean(),
  ideModInstalled: z.boolean().default(false),
  layoutInstalled: z.boolean(),
  activeLayout: z.string().default(""),
  herdrAvailable: z.boolean(),
  checks: z.array(ModCheckSchema).default([]),
  barBlocks: z.array(z.string()).default([]),
  barPlacement: z.string().default(""),
  message: z.string().default(""),
  updatedAt: z.string(),
});

type ModCheck = z.infer<typeof ModCheckSchema>;

interface MethodContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  extensionFile?: (relative: string) => string;
}

const VIM_TYPE = "@svendowideit/vim-controller";
const VIM_INSTANCE = "vim-controller";

function home(): string {
  try {
    return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "~";
  } catch {
    return "~";
  }
}

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  return path === "~" ? home() : `${home()}${path.slice(1)}`;
}

/** Resolve the Herdr home. */
export function herdrHomeOf(g: GlobalArgs): string {
  if (g.herdrHome) return expandHome(g.herdrHome);
  try {
    const env = Deno.env.get("HERDR_APP_HOME");
    if (env) return expandHome(env);
  } catch {
    // ignore
  }
  return join(home(), ".config", "herdr-app");
}

/** Pure path helper for the Herdr files. */
export function herdrPaths(
  herdrHome: string,
  layout: string,
): {
  modDir: string;
  ideModDir: string;
  approvalModDir: string;
  layoutPath: string;
} {
  const mods = join(herdrHome, "mods");
  return {
    modDir: join(mods, "swamp-activity"),
    ideModDir: join(mods, "swamp-ide"),
    approvalModDir: join(mods, "swamp-ide-approval"),
    layoutPath: join(herdrHome, "layouts", `${layout}.json`),
  };
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  bin: string,
  args: string[],
): Promise<CommandResult> {
  try {
    // swamp-quality-ignore deno-command
    const out = await new Deno.Command(bin, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The active layout, or "" when Herdr is not reachable. */
async function activeLayout(g: GlobalArgs): Promise<string> {
  const result = await run(g.herdrBin, ["status"]);
  if (result.code !== 0) return "";
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return String(parsed.layout ?? "");
  } catch {
    return "";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parse each installed mod with Herdr's own loader. */
async function checkMods(
  g: GlobalArgs,
  paths: ReturnType<typeof herdrPaths>,
): Promise<ModCheck[]> {
  const entries: Array<[string, string]> = [
    ["activity", paths.modDir],
    ["panel", paths.ideModDir],
    ["approval", paths.approvalModDir],
  ];
  const modsDir = dirname(paths.modDir);
  for (const name of ["obsidian-idea", "browser-launch"]) {
    const dir = join(modsDir, name);
    if (await exists(dir)) entries.push([name, dir]);
  }
  const checks: ModCheck[] = [];
  for (const [name, dir] of entries) {
    const result = await run(g.herdrBin, ["check", dir]);
    checks.push({
      name,
      dir,
      code: result.code,
      output: `${result.stdout}${result.stderr}`.trim(),
    });
  }
  return checks;
}

async function writeBundled(
  ctx: MethodContext,
  relative: string,
  destination: string,
): Promise<void> {
  if (!ctx.extensionFile) {
    throw new Error(
      "this swamp build does not expose extension files; cannot install the activity panel",
    );
  }
  const text = await Deno.readTextFile(ctx.extensionFile(relative));
  await Deno.mkdir(dirname(destination), { recursive: true });
  await Deno.writeTextFile(destination, text);
}

/** Read one of this extension's bundled files as text. */
async function bundledText(
  ctx: MethodContext,
  relative: string,
): Promise<string> {
  if (!ctx.extensionFile) {
    throw new Error(
      "this swamp build does not expose extension files; cannot install the layout",
    );
  }
  return await Deno.readTextFile(ctx.extensionFile(relative));
}

interface LayoutNode {
  id?: string;
  type?: string;
  size?: { px?: number; weight?: number };
  window_drag?: boolean;
  gap?: number;
  content?: Record<string, unknown>;
  children?: LayoutNode[];
  [key: string]: unknown;
}

/** One block the swamp bar can carry. */
export interface BarBlock {
  id: string;
  mod: string;
  px: number;
}

/** The block ids this extension owns inside a layout. */
const BAR_IDS = new Set(["obsidian-idea", "browser-launch"]);

/**
 * The bar blocks to place, decided by which mods are installed. The mods are
 * installed by @svendowideit/herdr-app, so this layout only carries the ones
 * that are actually there.
 */
export function barBlocksFor(has: {
  idea: boolean;
  browser: boolean;
}): BarBlock[] {
  const blocks: BarBlock[] = [];
  if (has.idea) {
    blocks.push({ id: "obsidian-idea", mod: "obsidian-idea", px: 320 });
  }
  if (has.browser) {
    blocks.push({ id: "browser-launch", mod: "browser-launch", px: 118 });
  }
  return blocks;
}

function findNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function barNode(block: BarBlock): LayoutNode {
  const content: Record<string, unknown> = { mod: block.mod };
  if (block.mod === "obsidian-idea") content.props = { compact: true };
  return { id: block.id, type: "block", content, size: { px: block.px } };
}

function tabsBlock(size: LayoutNode["size"]): LayoutNode {
  return { id: "tabs", type: "block", content: { mod: "tabs" }, size };
}

/**
 * Put the swamp bar into a layout tree: a `row` beside the tab strip
 * (`tabbar`), or two blocks in the status row (`statusbar`). Pure and
 * idempotent: only the nodes it owns are added, replaced or removed, so a
 * re-run converges and a layout without the bar is left byte-identical.
 */
export function applySwampBar(
  layout: unknown,
  opts: { placement: "tabbar" | "statusbar"; blocks: BarBlock[] },
): unknown {
  const tree = structuredClone(layout) as LayoutNode;
  const work = findNode(tree, "work");
  if (!work?.children) return layout;
  const blocks = opts.blocks;
  const ours = (node: LayoutNode) => BAR_IDS.has(String(node.id ?? ""));

  if (opts.placement === "tabbar") {
    const barIndex = work.children.findIndex((child) => child.id === "bar");
    if (blocks.length === 0) {
      if (barIndex < 0) return tree;
      const bar = work.children[barIndex];
      const tabs = bar.children?.find((child) => child.id === "tabs");
      work.children[barIndex] = tabs
        ? { ...tabs, size: { px: bar.size?.px ?? 42 }, window_drag: true }
        : { ...tabsBlock({ px: bar.size?.px ?? 42 }), window_drag: true };
      return tree;
    }
    let bar = barIndex >= 0 ? work.children[barIndex] : undefined;
    if (!bar) {
      const tabsIndex = work.children.findIndex((child) => child.id === "tabs");
      if (tabsIndex < 0) return layout;
      const tabs = work.children[tabsIndex];
      const row: LayoutNode = {
        id: "bar",
        type: "row",
        size: { px: tabs.size?.px ?? 42 },
        window_drag: true,
        gap: 6,
        children: [{ ...tabs, id: "tabs", size: { weight: 1 } }],
      };
      delete row.children![0].window_drag;
      work.children[tabsIndex] = row;
      bar = row;
    }
    const tabs = bar.children?.find((child) => child.id === "tabs") ??
      tabsBlock({ weight: 1 });
    bar.children = [tabs, ...blocks.map(barNode)];
    return tree;
  }

  const row = work.children.find((child) => child.id === "status-row");
  if (!row) return layout;
  const kept = (row.children ?? []).filter((child) => !ours(child));
  row.children = [...kept, ...blocks.map(barNode)];
  if (blocks.length > 0) row.size = { px: 32 };
  else if (row.size?.px === 32) row.size = { px: 28 };
  return tree;
}

/** Install or remove the Herdr activity panel and layout. */
async function setHerdr(
  args: z.infer<typeof SetHerdrArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const dir = herdrHomeOf(g);
  const paths = herdrPaths(dir, g.layout);
  const current = await activeLayout(g);
  const herdrAvailable = current !== "" ||
    (await run(g.herdrBin, ["--version"])).code === 0;
  const action: "enabled" | "disabled" | "unchanged" = args.enabled
    ? "enabled"
    : "disabled";
  let message = "";
  let checks: ModCheck[] = [];
  let barBlocks: BarBlock[] = [];

  if (args.enabled) {
    await Deno.mkdir(paths.modDir, { recursive: true });
    await writeBundled(ctx, "herdr/main.js", join(paths.modDir, "main.js"));
    await writeBundled(ctx, "herdr/mod.json", join(paths.modDir, "mod.json"));
    await Deno.mkdir(paths.ideModDir, { recursive: true });
    await writeBundled(
      ctx,
      "herdr/swamp-ide/main.js",
      join(paths.ideModDir, "main.js"),
    );
    await writeBundled(
      ctx,
      "herdr/swamp-ide/mod.json",
      join(paths.ideModDir, "mod.json"),
    );
    await Deno.mkdir(paths.approvalModDir, { recursive: true });
    await writeBundled(
      ctx,
      "herdr/swamp-ide-approval/main.js",
      join(paths.approvalModDir, "main.js"),
    );
    await writeBundled(
      ctx,
      "herdr/swamp-ide-approval/mod.json",
      join(paths.approvalModDir, "mod.json"),
    );
    barBlocks = barBlocksFor({
      idea: await exists(join(dir, "mods", "obsidian-idea")),
      browser: await exists(join(dir, "mods", "browser-launch")),
    });
    const layout = JSON.parse(await bundledText(ctx, "herdr/layout.json"));
    const withBar = applySwampBar(layout, {
      placement: args.placement,
      blocks: barBlocks,
    });
    await Deno.mkdir(dirname(paths.layoutPath), { recursive: true });
    await Deno.writeTextFile(
      paths.layoutPath,
      `${JSON.stringify(withBar, null, 2)}\n`,
    );
    if (herdrAvailable) {
      checks = await checkMods(g, paths);
      const failed = checks.filter((check) => check.code !== 0);
      if (failed.length > 0) {
        throw new Error(
          "Herdr mod check failed; files were installed but the layout was not switched:\n" +
            failed.map((check) =>
              `${check.name} (${check.dir}): ${
                check.output || `exit ${check.code}`
              }`
            ).join("\n"),
        );
      }
      const switched = await run(g.herdrBin, [
        "do",
        "layout.switch",
        JSON.stringify({ name: g.layout }),
      ]);
      if (switched.code !== 0) {
        message = `files installed, but layout switch failed: ${
          switched.stderr.trim() || switched.stdout.trim()
        }`;
      }
    } else {
      message = "files installed; start Herdr and select the swamp-ide layout";
    }
    if (barBlocks.length < 2) {
      message = [
        message,
        "install or update @svendowideit/herdr-app to show the full swamp bar",
      ].filter(Boolean).join("; ");
    }
  } else {
    if (current === g.layout && herdrAvailable) {
      await run(g.herdrBin, [
        "do",
        "layout.switch",
        JSON.stringify({ name: g.baseLayout }),
      ]);
    }
    await Deno.remove(paths.layoutPath).catch(() => {});
    await Deno.remove(paths.modDir, { recursive: true }).catch(() => {});
    await Deno.remove(paths.ideModDir, { recursive: true }).catch(() => {});
    await Deno.remove(paths.approvalModDir, { recursive: true }).catch(
      () => {},
    );
    message = "activity panels and layout removed";
  }

  const data: z.infer<typeof HerdrOutputSchema> = {
    action,
    herdrHome: dir,
    modDir: paths.modDir,
    ideModDir: paths.ideModDir,
    layoutPath: paths.layoutPath,
    modInstalled: await exists(paths.modDir),
    ideModInstalled: await exists(paths.ideModDir),
    layoutInstalled: await exists(paths.layoutPath),
    activeLayout: await activeLayout(g),
    herdrAvailable,
    checks,
    barBlocks: barBlocks.map((block) => block.id),
    barPlacement: barBlocks.length > 0 ? args.placement : "",
    message,
    updatedAt: new Date().toISOString(),
  };
  return { dataHandles: [await ctx.writeResource("herdr", "swamp-ide", data)] };
}

/** Report the Herdr panel state. */
async function status(
  _args: z.infer<typeof StatusArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const dir = herdrHomeOf(g);
  const paths = herdrPaths(dir, g.layout);
  const current = await activeLayout(g);
  const data: z.infer<typeof HerdrOutputSchema> = {
    action: "unchanged",
    herdrHome: dir,
    modDir: paths.modDir,
    ideModDir: paths.ideModDir,
    layoutPath: paths.layoutPath,
    modInstalled: await exists(paths.modDir),
    ideModInstalled: await exists(paths.ideModDir),
    layoutInstalled: await exists(paths.layoutPath),
    activeLayout: current,
    herdrAvailable: current !== "" ||
      (await run(g.herdrBin, ["--version"])).code === 0,
    checks: [],
    barBlocks: [],
    barPlacement: "",
    message: current === g.layout ? "swamp-ide layout is active" : "",
    updatedAt: new Date().toISOString(),
  };
  return { dataHandles: [await ctx.writeResource("herdr", "swamp-ide", data)] };
}

/** Ensure the addin's default vim-controller instance exists. */
async function ensureVim(
  _args: z.infer<typeof EnsureVimArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const get = await run("swamp", ["model", "get", VIM_INSTANCE, "--json"]);
  let action: "created" | "exists" | "failed" = "exists";
  let message = `using existing ${VIM_INSTANCE}`;
  let output = get.stdout.trim();

  if (get.code !== 0) {
    const created = await run("swamp", [
      "model",
      "create",
      VIM_TYPE,
      VIM_INSTANCE,
    ]);
    output = `${created.stdout}${created.stderr}`.trim();
    if (created.code === 0) {
      action = "created";
      message = `created ${VIM_INSTANCE} (${VIM_TYPE})`;
    } else if (/already exists|already created/i.test(output)) {
      action = "exists";
      message = `${VIM_INSTANCE} already exists`;
    } else {
      action = "failed";
      message = `could not create ${VIM_INSTANCE}`;
      throw new Error(`${message}: ${output}`);
    }
  }

  const data: z.infer<typeof VimOutputSchema> = {
    action,
    instance: VIM_INSTANCE,
    type: VIM_TYPE,
    message,
    output: output.slice(0, 4000),
    updatedAt: new Date().toISOString(),
  };
  ctx.logger?.info?.(message);
  return {
    dataHandles: [await ctx.writeResource("vim", "vim-controller", data)],
  };
}

/** The swamp-ide setup model. */
export const model = {
  type: "@svendowideit/swamp-ide",
  version: "2026.11.27.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.23.2",
      description:
        "Adds the collapsible Swamp IDE right-hand panel with Activity, shell-out Histogram and component-health indicator widgets.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.24.4",
      description:
        "setHerdr now runs herdr-app check against the installed activity, panel and approval mods before switching layout and fails without switching when any check fails; the per-mod results are returned in the herdr data.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.24.5",
      description:
        "The installed layout carries the swamp bar: a row beside the tab strip (placement=tabbar, the default) or two blocks in the status row (placement=statusbar), holding the obsidian-idea input and the browser-launch button. A block is only placed when its mod exists in Herdr's mods folder, so the layout names the extension to install instead of leaving an empty block; mods supplied by that extension are checked before the layout switches.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.25.1",
      description:
        "The approval dialog offers Grant directory for protected single-file requests as well as ordinary files; the policy authorizes a dir: lease for protected descendants and the approval lock, window claim and waiting queue are bounded and observable.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.26.1",
      description:
        "Activity is one line per call: time, the route it took (ws for the swamp serve socket, cli for a spawned swamp process, plus herdr-core, vim, guard and bypass), what was called, outcome and duration, expanding to the full record on click. Chips filter ws, cli, vim+herdr and errors, and the header counts ws against cli with the reasons a call had to shell out.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.27.1",
      description:
        "Adds ensureVim: the enable workflow checks for the addin's default vim-controller model instance and creates it when missing, so enabling Swamp IDE also makes every Vim write path resolvable.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    herdr: {
      description: "The Herdr activity panel and layout state",
      schema: HerdrOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    vim: {
      description:
        "The vim-controller model instance ensured by the front door",
      schema: VimOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    ensureVim: {
      description:
        "Ensure the addin's default vim-controller model instance exists, creating it if needed.",
      arguments: EnsureVimArgsSchema,
      execute: (
        args: z.infer<typeof EnsureVimArgsSchema>,
        ctx: MethodContext,
      ) => ensureVim(args, ctx),
    },
    setHerdr: {
      description:
        "Install and select the Herdr activity panel/layout, or remove it and return to the base layout.",
      arguments: SetHerdrArgsSchema,
      execute: (
        args: z.infer<typeof SetHerdrArgsSchema>,
        ctx: MethodContext,
      ) => setHerdr(args, ctx),
    },
    status: {
      description: "Report the Herdr activity panel and active layout.",
      arguments: StatusArgsSchema,
      execute: (
        args: z.infer<typeof StatusArgsSchema>,
        ctx: MethodContext,
      ) => status(args, ctx),
    },
  },
};
