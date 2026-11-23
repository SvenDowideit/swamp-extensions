/**
 * `@svendowideit/swamp-ide-pi-plugin` — install and gate the pi addin.
 *
 * The addin is a file in pi's extension directory. This model owns that file:
 * it bundles the source, writes it only where it manages it, refuses to
 * overwrite an unmanaged file, and enables it per pi session with a marker.
 * `@svendowideit/swamp-ide` calls `set` so one command can enable or disable
 * the whole system.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, join } from "node:path";

/** The marker inside a file this model manages. */
export const MANAGED_MARKER = "Managed by @svendowideit/swamp-ide-pi-plugin";

const GlobalArgsSchema = z.object({
  piBin: z.string().default("pi").describe("pi executable."),
  scope: z.enum(["project", "global"]).default("project").describe(
    "Install into <projectDir>/.pi/extensions or ~/.pi/agent/extensions.",
  ),
  projectDir: z.string().default("").describe(
    "Project root for project scope; empty uses the current directory.",
  ),
  force: z.boolean().default(false).describe(
    "Overwrite/remove a destination that is not marked as managed.",
  ),
}).strict();

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstallArgsSchema = z.object({
  scope: z.enum(["project", "global"]).optional().describe(
    "Override the global scope for this call.",
  ),
  force: z.boolean().optional().describe("Override the global force flag."),
});

const SetArgsSchema = z.object({
  enabled: z.boolean().describe("Enable or disable the addin."),
  sessionId: z.string().default("").describe(
    "pi session id; empty uses PI_SESSION_ID, and empty on disable clears all session markers.",
  ),
  scope: z.enum(["project", "global"]).optional().describe(
    "Override the global scope for this call.",
  ),
});

const StatusArgsSchema = z.object({});

const PluginOutputSchema = z.object({
  action: z.enum([
    "installed",
    "updated",
    "removed",
    "enabled",
    "disabled",
    "unchanged",
  ]),
  scope: z.enum(["project", "global"]),
  path: z.string(),
  markerDir: z.string(),
  managed: z.boolean(),
  installed: z.boolean(),
  piAvailable: z.boolean(),
  piVersion: z.string().default(""),
  sessionId: z.string().default(""),
  sessionEnabled: z.boolean().default(false),
  message: z.string().default(""),
  updatedAt: z.string(),
});

/** The part of swamp's method context this extension uses. */
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

function scopeOf(
  g: GlobalArgs,
  override?: "project" | "global",
): "project" | "global" {
  return override ?? g.scope;
}

function projectDirOf(g: GlobalArgs): string {
  return g.projectDir ? expandHome(g.projectDir) : Deno.cwd();
}

export function pathsFor(
  g: GlobalArgs,
  scope: "project" | "global",
): { path: string; markerDir: string } {
  if (scope === "global") {
    const base = join(home(), ".pi", "agent");
    return {
      path: join(base, "extensions", "swamp-ide.ts"),
      markerDir: join(base, "swamp-ide"),
    };
  }
  const base = projectDirOf(g);
  return {
    path: join(base, ".pi", "extensions", "swamp-ide.ts"),
    markerDir: join(base, ".pi", "swamp-ide"),
  };
}

async function piInfo(
  g: GlobalArgs,
): Promise<{ available: boolean; version: string }> {
  // pi may be absent; a directory with the agent install is still usable.
  const result = await run(g.piBin, ["--version"]);
  if (result.code === 0) {
    return { available: true, version: result.stdout.trim().split("\n")[0] };
  }
  try {
    const stat = await Deno.stat(join(home(), ".pi", "agent"));
    return { available: stat.isDirectory, version: "" };
  } catch {
    return { available: false, version: "" };
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

function managed(text: string | null): boolean {
  return Boolean(text && text.includes(MANAGED_MARKER));
}

async function install(
  ctx: MethodContext,
  scope: "project" | "global",
  force: boolean,
): Promise<
  {
    path: string;
    markerDir: string;
    action: "installed" | "updated";
    piAvailable: boolean;
    piVersion: string;
  }
> {
  const g = ctx.globalArgs;
  const pi = await piInfo(g);
  if (!pi.available) {
    throw new Error(
      "pi is not available; install pi first or use --input scope=global after installing it",
    );
  }
  if (!ctx.extensionFile) {
    throw new Error(
      "this swamp build does not expose extension files; cannot read the bundled pi plugin",
    );
  }
  const source = await Deno.readTextFile(ctx.extensionFile("pi/swamp-ide.ts"));
  const { path, markerDir } = pathsFor(g, scope);
  const current = await readText(path);
  if (current !== null && !managed(current) && !force) {
    throw new Error(
      `${path} exists and is not managed by ${MANAGED_MARKER}; ` +
        "pass --input force=true to replace it",
    );
  }
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, source);
  return {
    path,
    markerDir,
    action: current === null ? "installed" : "updated",
    piAvailable: true,
    piVersion: pi.version,
  };
}

async function uninstall(
  ctx: MethodContext,
  scope: "project" | "global",
  force: boolean,
): Promise<
  {
    path: string;
    markerDir: string;
    action: "removed" | "unchanged";
    piAvailable: boolean;
    piVersion: string;
  }
> {
  const g = ctx.globalArgs;
  const pi = await piInfo(g);
  const { path, markerDir } = pathsFor(g, scope);
  const current = await readText(path);
  if (current === null) {
    return {
      path,
      markerDir,
      action: "unchanged",
      piAvailable: pi.available,
      piVersion: pi.version,
    };
  }
  if (!managed(current) && !force) {
    throw new Error(
      `${path} is not managed by ${MANAGED_MARKER}; ` +
        "pass --input force=true to remove it",
    );
  }
  await Deno.remove(path);
  // Disable every session marker for this scope.
  try {
    for await (const entry of Deno.readDir(markerDir)) {
      if (entry.isFile && entry.name.endsWith(".enabled")) {
        await Deno.remove(join(markerDir, entry.name));
      }
    }
  } catch {
    // no marker directory
  }
  return {
    path,
    markerDir,
    action: "removed",
    piAvailable: pi.available,
    piVersion: pi.version,
  };
}

async function enabledSessions(markerDir: string): Promise<string[]> {
  const sessions: string[] = [];
  try {
    for await (const entry of Deno.readDir(markerDir)) {
      if (entry.isFile && entry.name.endsWith(".enabled")) {
        sessions.push(entry.name.slice(0, -".enabled".length));
      }
    }
  } catch {
    // no marker directory
  }
  return sessions.sort();
}

/** Build a plugin status record. */
async function statusFor(
  ctx: MethodContext,
  scope: "project" | "global",
): Promise<z.infer<typeof PluginOutputSchema>> {
  const g = ctx.globalArgs;
  const pi = await piInfo(g);
  const { path, markerDir } = pathsFor(g, scope);
  const current = await readText(path);
  const sessions = await enabledSessions(markerDir);
  return {
    action: "unchanged",
    scope,
    path,
    markerDir,
    managed: managed(current),
    installed: current !== null,
    piAvailable: pi.available,
    piVersion: pi.version,
    sessionId: sessions[0] ?? "",
    sessionEnabled: sessions.length > 0,
    message: sessions.length
      ? `enabled for ${sessions.join(", ")}`
      : "no session marker",
    updatedAt: new Date().toISOString(),
  };
}

async function set(
  args: z.infer<typeof SetArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const scope = scopeOf(g, args.scope);
  const pi = await piInfo(g);
  if (!pi.available) {
    throw new Error("pi is not available; cannot enable the addin");
  }
  const { path, markerDir } = pathsFor(g, scope);
  const current = await readText(path);
  if (!args.enabled) {
    const sessionId = args.sessionId || "";
    if (sessionId) {
      await Deno.remove(join(markerDir, `${sessionId}.enabled`)).catch(
        () => {},
      );
    } else {
      try {
        for await (const entry of Deno.readDir(markerDir)) {
          if (entry.isFile && entry.name.endsWith(".enabled")) {
            await Deno.remove(join(markerDir, entry.name));
          }
        }
      } catch {
        // no marker directory
      }
    }
    const data: z.infer<typeof PluginOutputSchema> = {
      action: "disabled",
      scope,
      path,
      markerDir,
      managed: managed(current),
      installed: current !== null,
      piAvailable: true,
      piVersion: pi.version,
      sessionId,
      sessionEnabled: false,
      message: sessionId ? `disabled ${sessionId}` : "disabled all sessions",
      updatedAt: new Date().toISOString(),
    };
    return {
      dataHandles: [await ctx.writeResource("plugin", "swamp-ide", data)],
    };
  }

  const installed = current !== null && managed(current)
    ? {
      path,
      markerDir,
      action: "unchanged" as const,
      piAvailable: true,
      piVersion: pi.version,
    }
    : await install(ctx, scope, g.force);
  const sessionId = args.sessionId || (() => {
    try {
      return Deno.env.get("PI_SESSION_ID") ?? "";
    } catch {
      return "";
    }
  })();
  await Deno.mkdir(markerDir, { recursive: true });
  if (sessionId) {
    await Deno.writeTextFile(
      join(markerDir, `${sessionId}.enabled`),
      "enabled\n",
    );
  }
  const data: z.infer<typeof PluginOutputSchema> = {
    action: installed.action === "unchanged" ? "enabled" : installed.action,
    scope,
    path: installed.path,
    markerDir: installed.markerDir,
    managed: true,
    installed: true,
    piAvailable: installed.piAvailable,
    piVersion: installed.piVersion,
    sessionId,
    sessionEnabled: Boolean(sessionId),
    message: sessionId
      ? `enabled for ${sessionId}`
      : "plugin installed; run /reload in the pi session",
    updatedAt: new Date().toISOString(),
  };
  return {
    dataHandles: [await ctx.writeResource("plugin", "swamp-ide", data)],
  };
}

/** The pi plugin installer/gate. */
export const model = {
  type: "@svendowideit/swamp-ide-pi-plugin",
  version: "2026.11.23.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    plugin: {
      description: "The installed pi addin and its session gate",
      schema: PluginOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    install: {
      description:
        "Install the bundled pi addin into the project or global pi extension directory.",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const scope = scopeOf(g, args.scope);
        const result = await install(ctx, scope, args.force ?? g.force);
        const data: z.infer<typeof PluginOutputSchema> = {
          action: result.action,
          scope,
          path: result.path,
          markerDir: result.markerDir,
          managed: true,
          installed: true,
          piAvailable: result.piAvailable,
          piVersion: result.piVersion,
          sessionId: "",
          sessionEnabled: false,
          message: "run /reload in pi to load it",
          updatedAt: new Date().toISOString(),
        };
        return {
          dataHandles: [await ctx.writeResource("plugin", "swamp-ide", data)],
        };
      },
    },
    uninstall: {
      description:
        "Remove the managed pi addin and every session marker for the scope.",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const scope = scopeOf(g, args.scope);
        const result = await uninstall(ctx, scope, args.force ?? g.force);
        const data: z.infer<typeof PluginOutputSchema> = {
          action: result.action === "removed" ? "removed" : "unchanged",
          scope,
          path: result.path,
          markerDir: result.markerDir,
          managed: false,
          installed: false,
          piAvailable: result.piAvailable,
          piVersion: result.piVersion,
          sessionId: "",
          sessionEnabled: false,
          message: "run /reload in pi to unload it",
          updatedAt: new Date().toISOString(),
        };
        return {
          dataHandles: [await ctx.writeResource("plugin", "swamp-ide", data)],
        };
      },
    },
    set: {
      description:
        "Enable or disable the pi addin; enable installs the managed file and writes the session marker, disable removes the marker or all markers.",
      arguments: SetArgsSchema,
      execute: (args: z.infer<typeof SetArgsSchema>, ctx: MethodContext) =>
        set(args, ctx),
    },
    status: {
      description:
        "Report whether pi is available, whether the managed addin is installed, and which sessions are enabled.",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const scope = g.scope;
        const data = await statusFor(ctx, scope);
        return {
          dataHandles: [await ctx.writeResource("plugin", "swamp-ide", data)],
        };
      },
    },
  },
};
