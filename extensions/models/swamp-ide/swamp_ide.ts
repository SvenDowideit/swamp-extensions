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
});

const StatusArgsSchema = z.object({});

const HerdrOutputSchema = z.object({
  action: z.enum(["enabled", "disabled", "unchanged"]),
  herdrHome: z.string(),
  modDir: z.string(),
  layoutPath: z.string(),
  modInstalled: z.boolean(),
  layoutInstalled: z.boolean(),
  activeLayout: z.string().default(""),
  herdrAvailable: z.boolean(),
  message: z.string().default(""),
  updatedAt: z.string(),
});

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
): { modDir: string; layoutPath: string } {
  return {
    modDir: join(herdrHome, "mods", "swamp-activity"),
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

  if (args.enabled) {
    await Deno.mkdir(paths.modDir, { recursive: true });
    await writeBundled(ctx, "herdr/main.js", join(paths.modDir, "main.js"));
    await writeBundled(ctx, "herdr/mod.json", join(paths.modDir, "mod.json"));
    await writeBundled(ctx, "herdr/layout.json", paths.layoutPath);
    if (herdrAvailable) {
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
    message = "activity panel and layout removed";
  }

  const data: z.infer<typeof HerdrOutputSchema> = {
    action,
    herdrHome: dir,
    modDir: paths.modDir,
    layoutPath: paths.layoutPath,
    modInstalled: await exists(paths.modDir),
    layoutInstalled: await exists(paths.layoutPath),
    activeLayout: await activeLayout(g),
    herdrAvailable,
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
    layoutPath: paths.layoutPath,
    modInstalled: await exists(paths.modDir),
    layoutInstalled: await exists(paths.layoutPath),
    activeLayout: current,
    herdrAvailable: current !== "" ||
      (await run(g.herdrBin, ["--version"])).code === 0,
    message: current === g.layout ? "swamp-ide layout is active" : "",
    updatedAt: new Date().toISOString(),
  };
  return { dataHandles: [await ctx.writeResource("herdr", "swamp-ide", data)] };
}

/** The swamp-ide setup model. */
export const model = {
  type: "@svendowideit/swamp-ide",
  version: "2026.11.23.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    herdr: {
      description: "The Herdr activity panel and layout state",
      schema: HerdrOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
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
