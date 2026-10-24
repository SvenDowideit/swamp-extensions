import { z } from "npm:zod@4";

function safeValue(label: string): z.ZodString {
  return z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );
}

export const MODEL_TYPE = "@svendowideit/pixiecore";
export const MODEL_VERSION = "2026.10.24.2";
export const CONTAINER_SERVICE_TYPE = "@svendowideit/container-service";

export const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  image: safeValue("image").default("pixiecore/pixiecore:master").describe(
    "Container image.",
  ),
  containerName: safeValue("containerName").default("").describe(
    "Container name.",
  ),
  serviceBackend: z.enum(["direct", "systemd"]).default("direct").describe(
    "Backend.",
  ),
  listenAddr: safeValue("listenAddr").default("0.0.0.0").describe(
    "Listen address.",
  ),
  httpPort: z.number().int().positive().default(80).describe("HTTP port."),
  statusPort: z.number().int().nonnegative().default(0).describe(
    "Status port.",
  ),
  dhcpNoBind: z.boolean().default(true).describe("DHCP no-bind."),
  debug: z.boolean().default(false).describe("Debug."),
  restart: safeValue("restart").default("unless-stopped").describe("Restart."),
  binary: safeValue("binary").default("docker").describe("Runtime binary."),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

export const EnsureArgsSchema = z.object({
  image: safeValue("image").optional().describe("Image override."),
});
export type EnsureArgs = z.infer<typeof EnsureArgsSchema>;

export const StatusArgsSchema = z.object({});
export const RemoveArgsSchema = z.object({
  removeVolumes: z.boolean().default(false).describe("Unused."),
});

export function containerNameFor(modelName: string, override: string): string {
  const base = override.trim() ||
    (modelName.trim() || "pixiecore").replace(/[^A-Za-z0-9_.-]/g, "-");
  return base;
}

export function serviceModelName(modelName: string, override: string): string {
  return `${containerNameFor(modelName, override)}-svc`;
}

export function buildPixiecoreCommand(g: GlobalArgs): string[] {
  const argv = ["quick", "xyz"];
  if (g.dhcpNoBind) argv.push("--dhcp-no-bind");
  argv.push("--listen-addr", g.listenAddr);
  argv.push("--port", String(g.httpPort));
  if (g.statusPort > 0) argv.push("--status-port", String(g.statusPort));
  if (g.debug) argv.push("--debug");
  return argv;
}

export function resolveImage(g: GlobalArgs, override?: string): string {
  const o = override?.trim();
  if (o) return o;
  return g.image.trim() || "pixiecore/pixiecore:master";
}

type RunModelResult =
  | { ok: true; resources: Array<{ name: string; specName?: string }> }
  | { ok: false; error: { message: string } };

interface MethodContext {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string>; garbageCollection?: number },
  ) => Promise<{ name: string }>;
  runModel?: (options: {
    modelType?: string;
    definition?: string;
    name?: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<RunModelResult>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<Array<{ content?: unknown; version?: number }>>;
}

async function callService(
  ctx: MethodContext,
  serviceName: string,
  method: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (!ctx.runModel) {
    throw new Error("context.runModel unavailable");
  }
  const result = await ctx.runModel({
    modelType: CONTAINER_SERVICE_TYPE,
    name: serviceName,
    method,
    arguments: args,
  });
  if (!result.ok) {
    throw new Error(
      `container-service ${method} failed: ${result.error.message}`,
    );
  }
  return undefined;
}

const ImageResultSchema = z.object({
  containerName: z.string(),
  image: z.string(),
  command: z.array(z.string()),
  listenAddr: z.string(),
  hostNetwork: z.boolean(),
});
const StatusResultSchema = z.object({
  containerName: z.string(),
  image: z.string().optional(),
  running: z.boolean().optional(),
  state: z.string().optional(),
  listenAddr: z.string().optional(),
});
const RemoveResultSchema = z.object({
  containerName: z.string(),
  removed: z.boolean(),
});

export const model = {
  type: "@svendowideit/pixiecore",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: MODEL_VERSION,
      description: "Initial release.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    ensureResult: {
      description: "ensure result",
      schema: ImageResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    statusResult: {
      description: "status result",
      schema: StatusResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    removeResult: {
      description: "remove result",
      schema: RemoveResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {},
  methods: {
    ensure: {
      description: "Ensure pixiecore container.",
      arguments: EnsureArgsSchema,
      execute: async (args: EnsureArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const modelName = ctx.definition?.name ?? "";
        const containerName = containerNameFor(modelName, g.containerName);
        const serviceName = serviceModelName(modelName, g.containerName);
        const image = resolveImage(g, args.image);
        const command = buildPixiecoreCommand(g);
        await callService(ctx, serviceName, "service", {
          containerName,
          action: "ensure",
          binary: g.binary,
          image,
          command,
          network: "host",
          restart: g.restart,
          serviceBackend: g.serviceBackend,
        });
        const handle = await ctx.writeResource("ensureResult", "ensure", {
          containerName,
          image,
          command,
          listenAddr: g.listenAddr,
          hostNetwork: true,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

type MethodMap = Record<
  string,
  {
    description: string;
    arguments: z.ZodTypeAny;
    execute: (
      args: unknown,
      ctx: MethodContext,
    ) => Promise<{ dataHandles: Array<{ name: string }> }>;
  }
>;
const aliasNames = ["start", "serve", "run"];
for (const alias of aliasNames) {
  (model.methods as MethodMap)[alias] = {
    description: (model.methods as MethodMap).ensure.description,
    arguments: (model.methods as MethodMap).ensure.arguments,
    execute: (model.methods as MethodMap).ensure.execute,
  };
}

(model.methods as MethodMap).status = {
  description: "Status.",
  arguments: StatusArgsSchema,
  execute: async (_args: unknown, ctx: MethodContext) => {
    const g = ctx.globalArgs;
    const modelName = ctx.definition?.name ?? "";
    const containerName = containerNameFor(modelName, g.containerName);
    const serviceName = serviceModelName(modelName, g.containerName);
    const statusData = await callService(ctx, serviceName, "serviceStatus", {
      containerName,
      serviceBackend: g.serviceBackend,
    }) as { running?: boolean; state?: string } | undefined;
    const handle = await ctx.writeResource("statusResult", "status", {
      containerName,
      image: g.image,
      running: statusData?.running ?? false,
      state: statusData?.state ?? "unknown",
      listenAddr: g.listenAddr,
    });
    return { dataHandles: [handle] };
  },
};

(model.methods as MethodMap).remove = {
  description: "Remove.",
  arguments: RemoveArgsSchema,
  execute: async (_args: unknown, ctx: MethodContext) => {
    const g = ctx.globalArgs;
    const modelName = ctx.definition?.name ?? "";
    const containerName = containerNameFor(modelName, g.containerName);
    const serviceName = serviceModelName(modelName, g.containerName);
    await callService(ctx, serviceName, "service", {
      containerName,
      action: "remove",
      serviceBackend: g.serviceBackend,
    });
    const handle = await ctx.writeResource("removeResult", "remove", {
      containerName,
      removed: true,
    });
    return { dataHandles: [handle] };
  },
};

export { z };
