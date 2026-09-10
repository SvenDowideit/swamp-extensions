/**
 * Generic systemd *user* service management.
 *
 * A swamp model type (`@svendowideit/systemd-service`) that idempotently
 * creates, starts, stops, and removes a systemd *user* service unit for any
 * service name and command line. It is a thin, generic wrapper around
 * `systemctl --user` and unit-file rendering — the caller supplies the service
 * name and the exact command line to run.
 *
 * Methods:
 *   - `createService` — write (or update) the unit file and `daemon-reload`.
 *                       Idempotent: if the unit already matches, it is left
 *                       untouched.
 *   - `startService`   — `systemctl --user enable --now` and verify it is active.
 *   - `stopService`    — `systemctl --user stop`.
 *   - `removeService`  — stop, disable, delete the unit file, and `daemon-reload`.
 *   - `status`         — report active/enabled state.
 *
 * Because it is a normal model type, any other extension can call these methods
 * (e.g. via `swamp model @svendowideit/systemd-service method run createService
 * <name> --input ...`) to idempotently stand up a persistent service. This is
 * the intended way to run long-lived Deno web services and APIs (such as
 * `@svendowideit/news`'s feedback-server) under systemd.
 *
 * Linux-only: it shells out to `systemctl --user`. Pure helpers (unit
 * rendering, path expansion) are exported for unit testing.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  denoPath: z.string().default("~/.swamp/deno/deno").describe(
    "Path to the Deno binary used to run Deno services (defaults to swamp's bundled Deno)",
  ),
  unitDir: z.string().default("~/.config/systemd/user").describe(
    "Directory where systemd user unit files are written",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CreateServiceArgsSchema = z.object({
  serviceName: z.string().min(1).describe(
    "systemd user service name (without the .service suffix)",
  ),
  command: z.string().min(1).describe(
    "Full command line the service runs (e.g. ~/.swamp/deno/deno run --allow-net scripts/feedback-server.ts)",
  ),
  description: z.string().optional().describe(
    "Human-readable description for the [Unit] section",
  ),
  workingDirectory: z.string().optional().describe(
    "Working directory for the service (WorkingDirectory=)",
  ),
  environment: z.array(z.string()).default([]).describe(
    "Environment variables as KEY=VALUE strings (Environment=)",
  ),
  restart: z.string().default("on-failure").describe(
    "Restart= policy (e.g. on-failure, always, no)",
  ),
  restartSec: z.string().default("5").describe(
    "RestartSec= delay between restarts",
  ),
  after: z.array(z.string()).default(["network-online.target"]).describe(
    "After= dependencies",
  ),
  wants: z.array(z.string()).default(["network-online.target"]).describe(
    "Wants= dependencies",
  ),
  force: z.boolean().default(false).describe(
    "Rewrite the unit file even if it already matches",
  ),
});

const ServiceNameArgsSchema = z.object({
  serviceName: z.string().min(1).describe(
    "systemd user service name (without the .service suffix)",
  ),
});

const StatusArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

const ServiceOutputSchema = z.object({
  serviceName: z.string(),
  unitPath: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  checkedAt: z.string(),
});

const CreateOutputSchema = z.object({
  serviceName: z.string(),
  unitPath: z.string(),
  written: z.boolean(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** Render a systemd *user* service unit file for an arbitrary command line. */
export function renderServiceUnit(opts: {
  serviceName: string;
  command: string;
  description?: string;
  workingDirectory?: string;
  environment: string[];
  restart: string;
  restartSec: string;
  after: string[];
  wants: string[];
}): string {
  const {
    serviceName,
    command,
    description,
    workingDirectory,
    environment,
    restart,
    restartSec,
    after,
    wants,
  } = opts;
  const lines: string[] = [
    `# Managed by @svendowideit/systemd-service — do not edit by hand.`,
    `[Unit]`,
    `Description=${description ?? serviceName}`,
  ];
  for (const a of after) lines.push(`After=${a}`);
  for (const w of wants) lines.push(`Wants=${w}`);
  lines.push(``, `[Service]`, `Type=simple`, `ExecStart=${command}`);
  if (workingDirectory) lines.push(`WorkingDirectory=${workingDirectory}`);
  for (const env of environment) lines.push(`Environment=${env}`);
  lines.push(
    `Restart=${restart}`,
    `RestartSec=${restartSec}`,
    `TimeoutStopSec=5`,
    `PrivateTmp=true`,
    `ProtectSystem=full`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

type CmdResult = { stdout: string; stderr: string; code: number };

async function runCmd(
  binary: string,
  args: string[],
): Promise<CmdResult> {
  try {
    const proc = new Deno.Command(binary, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

async function systemctl(
  args: string[],
): Promise<CmdResult> {
  return await runCmd("systemctl", ["--user", ...args]);
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

async function writeUnitFile(
  unitPath: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(dirnameOf(unitPath), { recursive: true });
  await Deno.writeTextFile(unitPath, content);
}

async function daemonReload(): Promise<void> {
  const reload = await systemctl(["daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(
      `systemctl --user daemon-reload failed (${reload.code}): ${
        reload.stderr || reload.stdout
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  definition: {
    id: string;
    name: string;
    version: string;
    tags: Record<string, string>;
  };
};

export const model = {
  type: "@svendowideit/systemd-service",
  version: "2026.09.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    service: {
      description: "systemd user service status",
      schema: ServiceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    create: {
      description: "Last createService result",
      schema: CreateOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    createService: {
      description:
        "Idempotently write (or update) a systemd user service unit and daemon-reload",
      arguments: CreateServiceArgsSchema,
      execute: async (
        args: z.infer<typeof CreateServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const unitPath = `${unitDir}/${args.serviceName}.service`;

        // systemd does not expand `~` in ExecStart, so expand it here.
        const command = expandHome(args.command);

        const unit = renderServiceUnit({
          serviceName: args.serviceName,
          command,
          description: args.description,
          workingDirectory: args.workingDirectory,
          environment: args.environment,
          restart: args.restart,
          restartSec: args.restartSec,
          after: args.after,
          wants: args.wants,
        });

        let written = false;
        let existing = "";
        try {
          existing = await Deno.readTextFile(unitPath);
        } catch {
          // unit does not exist yet
        }
        if (args.force || existing !== unit) {
          await writeUnitFile(unitPath, unit);
          written = true;
          context.logger?.info(
            "Wrote systemd user unit {serviceName} at {unitPath}",
            { serviceName: args.serviceName, unitPath },
          );
        } else {
          context.logger?.info(
            "Systemd user unit {serviceName} already up to date at {unitPath}",
            { serviceName: args.serviceName, unitPath },
          );
        }

        await daemonReload();

        const handle = await context.writeResource("create", "current", {
          serviceName: args.serviceName,
          unitPath,
          written,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startService: {
      description:
        "Start and enable a systemd user service and verify it is active",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceNameArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);

        const enable = await systemctl(["enable", "--now", args.serviceName]);
        if (enable.code !== 0) {
          throw new Error(
            `systemctl --user enable --now ${args.serviceName} failed (${enable.code}): ${
              enable.stderr || enable.stdout
            }`,
          );
        }

        const active = await systemctl(["is-active", args.serviceName]);
        const enabled = await systemctl(["is-enabled", args.serviceName]);
        if (active.code !== 0) {
          throw new Error(
            `Service ${args.serviceName} is not active: ${
              active.stderr || active.stdout
            }`,
          );
        }

        context.logger?.info(
          "Service {serviceName} is active; enabled: {enabled}",
          { serviceName: args.serviceName, enabled: enabled.code === 0 },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName: args.serviceName,
          unitPath: `${unitDir}/${args.serviceName}.service`,
          active: active.code === 0,
          enabled: enabled.code === 0,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stopService: {
      description: "Stop a systemd user service",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceNameArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        const stop = await systemctl(["stop", args.serviceName]);
        if (stop.code !== 0) {
          throw new Error(
            `systemctl --user stop ${args.serviceName} failed (${stop.code}): ${
              stop.stderr || stop.stdout
            }`,
          );
        }
        context.logger?.info("Stopped service {serviceName}", {
          serviceName: args.serviceName,
        });
        return { dataHandles: [] };
      },
    },

    removeService: {
      description:
        "Stop, disable, delete the unit file, and daemon-reload for a systemd user service",
      arguments: ServiceNameArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceNameArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const unitPath = `${unitDir}/${args.serviceName}.service`;

        // Best-effort stop/disable: the service may not exist or be running.
        await systemctl(["stop", args.serviceName]);
        await systemctl(["disable", args.serviceName]);

        try {
          await Deno.remove(unitPath);
          context.logger?.info("Removed unit file {unitPath}", { unitPath });
        } catch {
          // unit file already gone
        }

        await daemonReload();
        context.logger?.info("Removed service {serviceName}", {
          serviceName: args.serviceName,
        });
        return { dataHandles: [] };
      },
    },

    status: {
      description: "Report active/enabled state of a systemd user service",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const serviceName = context.definition.name;

        const active = await systemctl(["is-active", serviceName]);
        const enabled = await systemctl(["is-enabled", serviceName]);

        context.logger?.info(
          "Service {serviceName} active: {active}, enabled: {enabled}",
          {
            serviceName,
            active: active.code === 0,
            enabled: enabled.code === 0,
          },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath: `${unitDir}/${serviceName}.service`,
          active: active.code === 0,
          enabled: enabled.code === 0,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
