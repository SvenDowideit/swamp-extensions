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
  guardPath: z.string().default(""),
  guardInstalled: z.boolean().default(false),
  addinLoaded: z.boolean().default(false),
  guardLoaded: z.boolean().default(false),
  addinHeartbeatAt: z.string().default(""),
  guardHeartbeatAt: z.string().default(""),
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

/** The guard is always global: it must load even when the project addin does not. */
export function guardPathFor(): string {
  return join(home(), ".pi", "agent", "extensions", "swamp-ide-guard.ts");
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

const ADDIN_HEARTBEAT = join(home(), ".local/state/swamp-agent-ide/addin.json");
const GUARD_HEARTBEAT = join(home(), ".local/state/swamp-agent-ide/guard.json");

async function heartbeatInfo(
  path: string,
): Promise<{ loaded: boolean; at: string }> {
  const text = await readText(path);
  if (!text) return { loaded: false, at: "" };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return { loaded: true, at: String(parsed.updatedAt ?? "") };
  } catch {
    return { loaded: false, at: "" };
  }
}

const SESSION_POINTER = join(
  home(),
  ".local/state/swamp-agent-ide/pi-session.json",
);

/** The newest live pi session, so the enable workflow needs no extra command. */
export async function discoverPiSession(): Promise<string> {
  try {
    const env = Deno.env.get("PI_SESSION_ID") ?? "";
    if (env) return env;
  } catch {
    // ignore
  }
  const pointer = await readText(SESSION_POINTER);
  if (pointer) {
    try {
      const parsed = JSON.parse(pointer) as Record<string, unknown>;
      const at = Date.parse(String(parsed.updatedAt ?? ""));
      const pointed = String(parsed.session ?? "");
      if (isFinite(at) && Date.now() - at < 5 * 60_000 && pointed) {
        return pointed;
      }
    } catch {
      // fall through to session files
    }
  }

  const candidates: Array<{ id: string; at: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return;
    }
    for await (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const match = entry.name.match(
        /_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i,
      );
      if (!match) continue;
      try {
        const info = await Deno.stat(path);
        const at = info.mtime?.getTime() ?? 0;
        if (at > Date.now() - 5 * 60_000) {
          candidates.push({ id: match[1], at });
        }
      } catch {
        // ignore
      }
    }
  };
  await walk(join(home(), ".pi", "agent", "sessions"));
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0]?.id ?? "";
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
    guardPath: string;
    guardInstalled: boolean;
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

  const policyPath = join(dirname(path), "swamp-ide-policy.ts");
  const policySource = await Deno.readTextFile(
    ctx.extensionFile("pi/swamp-ide-policy.ts"),
  );
  const policyCurrent = await readText(policyPath);
  if (policyCurrent !== null && !managed(policyCurrent) && !force) {
    throw new Error(
      `${policyPath} exists and is not managed by ${MANAGED_MARKER}; ` +
        "pass --input force=true to replace it",
    );
  }
  await Deno.writeTextFile(policyPath, policySource);

  const guardPath = guardPathFor();
  const guardSource = await Deno.readTextFile(
    ctx.extensionFile("pi/swamp-ide-guard.ts"),
  );
  const guardCurrent = await readText(guardPath);
  if (guardCurrent !== null && !managed(guardCurrent) && !force) {
    throw new Error(
      `${guardPath} exists and is not managed by ${MANAGED_MARKER}; ` +
        "pass --input force=true to replace it",
    );
  }
  await Deno.mkdir(dirname(guardPath), { recursive: true });
  await Deno.writeTextFile(guardPath, guardSource);

  // A global install replaces the legacy project-local copy so pi cannot load
  // two swamp_ide tools. The project session markers stay: the global addin
  // and the guard both read them.
  if (scope === "global") {
    const projectPath = pathsFor(g, "project").path;
    const projectText = await readText(projectPath);
    if (projectText !== null && managed(projectText)) {
      await Deno.remove(projectPath).catch(() => {});
      await Deno.remove(
        join(dirname(projectPath), "swamp-ide-policy.ts"),
      ).catch(() => {});
    }
  }

  return {
    path,
    markerDir,
    action: current === null ? "installed" : "updated",
    piAvailable: true,
    piVersion: pi.version,
    guardPath,
    guardInstalled: true,
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
    guardPath: string;
    guardInstalled: boolean;
  }
> {
  const g = ctx.globalArgs;
  const pi = await piInfo(g);
  const { path, markerDir } = pathsFor(g, scope);
  const current = await readText(path);
  const guardPath = guardPathFor();
  const guardCurrent = await readText(guardPath);
  if (current === null && guardCurrent === null) {
    return {
      path,
      markerDir,
      action: "unchanged",
      piAvailable: pi.available,
      piVersion: pi.version,
      guardPath,
      guardInstalled: false,
    };
  }
  if (current !== null && !managed(current) && !force) {
    throw new Error(
      `${path} is not managed by ${MANAGED_MARKER}; ` +
        "pass --input force=true to remove it",
    );
  }
  if (guardCurrent !== null && !managed(guardCurrent) && !force) {
    throw new Error(
      `${guardPath} is not managed by ${MANAGED_MARKER}; ` +
        "pass --input force=true to remove it",
    );
  }
  const policyPath = join(dirname(path), "swamp-ide-policy.ts");
  const policyCurrent = await readText(policyPath);
  if (policyCurrent !== null && !managed(policyCurrent) && !force) {
    throw new Error(
      `${policyPath} is not managed by ${MANAGED_MARKER}; ` +
        "pass --input force=true to remove it",
    );
  }
  if (current !== null) await Deno.remove(path);
  if (policyCurrent !== null) await Deno.remove(policyPath);
  if (scope === "global" && guardCurrent !== null) {
    await Deno.remove(guardPath);
  }
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
    guardPath,
    guardInstalled: scope === "global" ? false : guardCurrent !== null,
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

/** Health fields shared by every plugin output. */
async function healthFields(): Promise<{
  guardPath: string;
  guardInstalled: boolean;
  addinLoaded: boolean;
  guardLoaded: boolean;
  addinHeartbeatAt: string;
  guardHeartbeatAt: string;
}> {
  const guardPath = guardPathFor();
  const addin = await heartbeatInfo(ADDIN_HEARTBEAT);
  const guard = await heartbeatInfo(GUARD_HEARTBEAT);
  return {
    guardPath,
    guardInstalled: (await readText(guardPath)) !== null,
    addinLoaded: addin.loaded,
    guardLoaded: guard.loaded,
    addinHeartbeatAt: addin.at,
    guardHeartbeatAt: guard.at,
  };
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
  const addin = await heartbeatInfo(ADDIN_HEARTBEAT);
  const guard = await heartbeatInfo(GUARD_HEARTBEAT);
  const guardPath = guardPathFor();
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
    guardPath,
    guardInstalled: (await readText(guardPath)) !== null,
    addinLoaded: addin.loaded,
    guardLoaded: guard.loaded,
    addinHeartbeatAt: addin.at,
    guardHeartbeatAt: guard.at,
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
      ...await healthFields(),
      message: sessionId ? `disabled ${sessionId}` : "disabled all sessions",
      updatedAt: new Date().toISOString(),
    };
    return {
      dataHandles: [await ctx.writeResource("plugin", "swamp-ide", data)],
    };
  }

  const installed = await install(ctx, scope, g.force);
  const sessionId = args.sessionId || await discoverPiSession();
  if (!sessionId) {
    throw new Error(
      "enabled=true could not discover a live pi session; pass " +
        "--input sessionId=<pi session id>.",
    );
  }
  await Deno.mkdir(markerDir, { recursive: true });
  if (sessionId) {
    await Deno.writeTextFile(
      join(markerDir, `${sessionId}.enabled`),
      "enabled\n",
    );
  }
  const data: z.infer<typeof PluginOutputSchema> = {
    action: "enabled",
    scope,
    path: installed.path,
    markerDir: installed.markerDir,
    managed: true,
    installed: true,
    piAvailable: installed.piAvailable,
    piVersion: installed.piVersion,
    sessionId,
    sessionEnabled: Boolean(sessionId),
    ...await healthFields(),
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
  version: "2026.11.24.5",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.23.2",
      description:
        "Uses swamp serve for method calls, adds system=swamp, the shell-out histogram, per-program span names, a global fail-closed guard, addin/guard heartbeats, and a human-lease capability policy for protected paths and mutating methods.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.24.3",
      description:
        "Every swamp_ide result now starts with a deterministic Authorization line generated from a structured authorization record (read-only, existing lease, approved dialog, blocked/denied/timeout/unavailable); the same fields are recorded in activity events and OTLP spans, and the addin prompt requires the line to be quoted verbatim.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.24.4",
      description:
        "Rejects sh -c/bash -c shell wrappers before approval, requires a non-empty reason and goal for every mutation, removes the approval timeout, and selects the latest matching lease feature so an expired feature cannot shadow a fresh one.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.24.5",
      description:
        "Fixes pi failing to load the extension with 'Extension does not export a valid factory function: swamp-ide-policy.ts': the policy library now exports an inert default factory so pi's auto-discovery accepts the file that the addin and guard import.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
          ...await healthFields(),
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
          ...await healthFields(),
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
