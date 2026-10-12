/**
 * @svendowideit/obsidian-headless
 *
 * Install and run the official Obsidian Sync headless client (`ob`, the
 * `obsidian-headless` npm package) as a systemd *user* service, and retire the
 * desktop app's in-app sync for the vault it takes over.
 *
 * The extension does four things, each as a separate method: it detects what is
 * on the host (Node, the package, login state, desktop registration, the in-app
 * `sync` core plugin, and the remote vault); it installs a managed Node.js
 * runtime and the npm package when they are missing; it resolves the remote
 * vault by name and configures the local vault for headless sync; and it turns
 * the in-app `sync` core plugin off, with a backup, once the operator approves.
 * The bundled `@svendowideit/obsidian-headless-install` workflow wires those
 * methods to a `manual_approval` gate and to `@svendowideit/systemd-service`,
 * which owns the service that keeps `ob sync --continuous` running.
 *
 * Methods:
 *   - `setup`             detect host state and persist the resolved config
 *   - `installNode`       ensure a Node.js 22+ runtime is available
 *   - `install`           install/upgrade the obsidian-headless npm package
 *   - `configureSync`     resolve the remote vault and configure local sync
 *   - `disableInAppSync`  turn the vault's in-app `sync` core plugin off
 *   - `print`             summarise the end state and how to inspect the service
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  buildSummary,
  type Config,
  configureSync,
  detectStatus,
  disableInAppSyncForVault,
  ensureNode,
  ensurePackage,
  type InAppSyncInfo,
  type NodeInfo,
  normaliseConfig,
  type PackageInfo,
  realDeps,
  type StatusInfo,
  type SummaryInfo,
  type VaultInfo,
} from "./obsidian_headless_shared.ts";

/** The model type name. */
export const OBSIDIAN_HEADLESS_TYPE: string = "@svendowideit/obsidian-headless";

/** The extension version, matching the manifest. */
export const OBSIDIAN_HEADLESS_VERSION: string = "2026.10.12.1";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const stringArg = z.string().default("");

/** Global arguments — the persisted, per-instance configuration. */
const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  vaultName: stringArg.describe(
    "Obsidian Sync remote vault name (or id) to attach to.",
  ),
  vaultPath: stringArg.describe(
    "Absolute path of the local vault directory.",
  ),
  deviceName: stringArg.describe(
    "Device name for the sync version history (default: <hostname>-headless).",
  ),
  configDir: stringArg.describe(
    "Vault config directory name (a dotfolder, default .obsidian).",
  ),
  syncMode: z.string().default("").describe(
    "Sync mode: bidirectional, pull-only, or mirror-remote (default bidirectional).",
  ),
  nodeDir: stringArg.describe(
    "Directory the managed Node.js runtime is installed under.",
  ),
  nodeVersion: stringArg.describe(
    "Node.js version to install when missing (default 22).",
  ),
  nodePath: stringArg.describe(
    "Explicit node binary to use instead of detecting/installing one.",
  ),
  packagePrefix: stringArg.describe(
    "npm global prefix the obsidian-headless package is installed into.",
  ),
  packageVersion: stringArg.describe(
    "obsidian-headless version to install (empty = the latest).",
  ),
  e2ePassword: stringArg.meta({ sensitive: true }).describe(
    "End-to-end encryption password for the remote vault, if it uses E2E.",
  ),
  serviceName: stringArg.describe(
    "systemd user service name (default obsidian-headless).",
  ),
  obsidianConfigDir: stringArg.describe(
    "Override for the Obsidian desktop app config directory.",
  ),
});

/** Resolved {@link GlobalArgsSchema} type. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The persisted configuration resource. */
const ConfigSchema = z.object({
  vaultName: z.string(),
  vaultPath: z.string(),
  deviceName: z.string(),
  configDir: z.string(),
  syncMode: z.string(),
  nodeDir: z.string(),
  nodeVersion: z.string(),
  nodePath: z.string(),
  packagePrefix: z.string(),
  packageVersion: z.string(),
  e2ePassword: z.string().meta({ sensitive: true }),
  serviceName: z.string(),
  obsidianConfigDir: z.string(),
});

/** Host + install state snapshot written by `setup`. */
const StatusSchema = z.object({
  vaultName: z.string(),
  vaultPath: z.string(),
  vaultPathExists: z.boolean(),
  desktopRegistered: z.boolean(),
  desktopVaults: z.array(z.string()),
  inAppSyncEnabled: z.boolean(),
  inAppSyncConfigured: z.boolean(),
  obsidianAppRunning: z.boolean(),
  nodeFound: z.boolean(),
  nodePath: z.string(),
  nodeVersion: z.string(),
  nodeMajor: z.number(),
  nodeOk: z.boolean(),
  packageInstalled: z.boolean(),
  packageVersion: z.string(),
  packageCliPath: z.string(),
  loggedIn: z.boolean(),
  // swamp-quality-ignore credentials-sensitive-field: authTokenPath is a filesystem path, not a secret value.
  authTokenPath: z.string(),
  remoteVaultFound: z.boolean(),
  remoteVaultId: z.string(),
  localConfigured: z.boolean(),
  serviceName: z.string(),
  serviceHint: z.string(),
  checkedAt: z.string(),
});

/** Managed Node.js runtime written by `installNode` / `install`. */
const NodeSchema = z.object({
  major: z.number(),
  version: z.string(),
  binaryPath: z.string(),
  npmCliPath: z.string(),
  source: z.string(),
  skipped: z.boolean(),
  installDir: z.string(),
  requiredMajor: z.number(),
});

/** Installed npm package written by `install`. */
const PackageSchema = z.object({
  version: z.string(),
  prefix: z.string(),
  cliPath: z.string(),
  obPath: z.string(),
  skipped: z.boolean(),
  installed: z.boolean(),
  wantedVersion: z.string(),
});

/** Vault sync configuration written by `configureSync`. */
const VaultSchema = z.object({
  vaultName: z.string(),
  vaultId: z.string(),
  region: z.string(),
  vaultPath: z.string(),
  configured: z.boolean(),
  skipped: z.boolean(),
  syncMode: z.string(),
  deviceName: z.string(),
  localVaults: z.array(
    z.object({ id: z.string(), path: z.string(), host: z.string() }),
  ),
  message: z.string(),
});

/** In-app sync retirement result written by `disableInAppSync`. */
const InAppSyncSchema = z.object({
  vaultPath: z.string(),
  corePluginsPath: z.string(),
  enabledBefore: z.boolean(),
  disabled: z.boolean(),
  changed: z.boolean(),
  backupPath: z.string(),
  desktopRegistered: z.boolean(),
  appRunning: z.boolean(),
  note: z.string(),
});

/** Final summary written by `print`. */
const SummarySchema = z.object({
  ok: z.boolean(),
  lines: z.array(z.string()),
  vaultName: z.string(),
  vaultPath: z.string(),
  packageVersion: z.string(),
  nodePath: z.string(),
  serviceName: z.string(),
  serviceHint: z.string(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const SetupArgsSchema = z.object({
  vaultName: stringArg,
  vaultPath: stringArg,
  deviceName: stringArg,
  configDir: stringArg,
  syncMode: stringArg,
  nodeDir: stringArg,
  nodeVersion: stringArg,
  packagePrefix: stringArg,
  packageVersion: stringArg,
  e2ePassword: stringArg.meta({ sensitive: true }),
  serviceName: stringArg,
  obsidianConfigDir: stringArg,
});

const ForceArgsSchema = z.object({
  force: z.boolean().default(false).describe(
    "Reinstall/rewrite even when the target state already exists.",
  ),
});

const ConfigureSyncArgsSchema = z.object({
  force: z.boolean().default(false).describe(
    "Reinstall/rewrite the local sync config even when it already exists.",
  ),
  e2ePassword: stringArg.meta({ sensitive: true }).describe(
    "End-to-end encryption password for the remote vault, when it uses E2E. " +
      "Supplied so `ob sync-setup` can run non-interactively; never persisted.",
  ),
});

const NoArgsSchema = z.object({});

/** Resolved argument types. */
type SetupArgs = z.infer<typeof SetupArgsSchema>;
/** Resolved argument type for the force-taking methods. */
type ForceArgs = z.infer<typeof ForceArgsSchema>;
/** Resolved argument type for `configureSync`. */
type ConfigureSyncArgs = z.infer<typeof ConfigureSyncArgsSchema>;
/** Resolved argument type for the no-argument methods. */
type NoArgs = z.infer<typeof NoArgsSchema>;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    specName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<
    Array<{ content?: unknown; attributes?: unknown; version?: number }>
  >;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge non-empty values from later sources over earlier ones. */
function overlay<T>(
  ...sources: Array<Partial<T>>
): Partial<T> {
  const out: Partial<T> = {};
  for (const src of sources) {
    for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * Read the latest data written for one resource spec on this model instance.
 *
 * Uses `readResource`, which resolves the instance itself — so it works whether
 * or not swamp populated the model name global argument. Falls back to the
 * `readModelData` snapshot form when the primary API is unavailable.
 */
async function latestAttributes(
  ctx: MethodContext,
  specName: string,
): Promise<Record<string, unknown>> {
  if (ctx.readResource) {
    try {
      const value = await ctx.readResource(specName);
      if (value && typeof value === "object") {
        return value as Record<string, unknown>;
      }
    } catch {
      // No such resource yet — treated as absent.
    }
  }
  if (!ctx.readModelData || !ctx.globalArgs.name) return {};
  try {
    const rows = await ctx.readModelData(ctx.globalArgs.name, specName);
    const latest = rows?.reduce(
      (a, b) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a),
    );
    const value = (latest?.attributes ?? latest?.content) as
      | Record<string, unknown>
      | undefined;
    return value ?? {};
  } catch {
    return {};
  }
}

/** Resolve a {@link Config} from persisted config, globals and inputs. */
async function resolveConfig(
  ctx: MethodContext,
  inputs: Partial<Config>,
  prior: Partial<Config> = {},
): Promise<Config> {
  const deps = realDeps();
  const hostname = await deps.hostname();
  const merged = overlay<Config>(
    prior,
    ctx.globalArgs as unknown as Partial<Config>,
    inputs,
  );
  return normaliseConfig(merged, deps.home(), hostname);
}

/**
 * Resolve config from three sources, lowest to highest precedence: the `config`
 * resource persisted by a previous run, the model's global arguments, and the
 * method inputs. Reading the persisted resource back is what lets the workflow
 * pass identifying values (`vaultName`, `vaultPath`) to `setup` once and have
 * every later method reuse them.
 */
async function resolvePersistedConfig(
  ctx: MethodContext,
  inputs: Partial<Config> = {},
): Promise<Config> {
  const prior = await latestAttributes(ctx, "config") as Partial<Config>;
  return resolveConfig(ctx, inputs, prior);
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A model that installs and configures headless Obsidian Sync. */
export const model = {
  type: OBSIDIAN_HEADLESS_TYPE,
  version: OBSIDIAN_HEADLESS_VERSION,
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: OBSIDIAN_HEADLESS_VERSION,
      description:
        "Initial release: detect in-app sync and host readiness, install a " +
        "managed Node.js 22 runtime and the obsidian-headless npm package, " +
        "configure a remote vault for headless sync, disable the in-app `sync` " +
        "core plugin with a backup, and print the systemd service hint.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    config: {
      description: "Resolved configuration (persisted across runs).",
      schema: ConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    status: {
      description:
        "Detected host state: node, package, auth, vault, in-app sync.",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    node: {
      description: "The resolved managed Node.js runtime.",
      schema: NodeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    package: {
      description: "The installed obsidian-headless npm package.",
      schema: PackageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    vault: {
      description: "The remote vault and local sync configuration.",
      schema: VaultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    inAppSync: {
      description: "The in-app sync retirement result.",
      schema: InAppSyncSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    summary: {
      description: "The final end-state summary.",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    setup: {
      description:
        "Detect host state (desktop registration, in-app sync, Node, package, " +
        "login, remote vault) and persist the resolved configuration so later " +
        "runs reuse it rather than re-asking.",
      arguments: SetupArgsSchema,
      execute: async (
        args: SetupArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps = realDeps();
        const inputs: Partial<Config> = {
          ...args,
          syncMode: (args.syncMode || undefined) as
            | Config["syncMode"]
            | undefined,
        };
        const cfg = await resolvePersistedConfig(ctx, inputs);
        const status = await detectStatus(deps, cfg);
        // Never persist the E2E secret: it is supplied per run (ideally from a
        // swamp vault) and must not land in a data resource.
        const persisted = { ...cfg, e2ePassword: "" };
        const configHandle = await ctx.writeResource(
          "config",
          "config",
          persisted as unknown as Record<string, unknown>,
        );
        const statusHandle = await ctx.writeResource(
          "status",
          "status",
          status as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "obsidian-headless setup: vaultName={name} vaultPath={vault} " +
            "desktop={desktop} inAppSync={inApp} node={node} package={pkg} " +
            "loggedIn={auth}",
          {
            name: cfg.vaultName || "(unset)",
            vault: cfg.vaultPath || "(unset)",
            desktop: status.desktopRegistered,
            inApp: status.inAppSyncConfigured,
            node: status.nodePath || "(none)",
            pkg: status.packageVersion || "(none)",
            auth: status.loggedIn,
          },
        );
        return { dataHandles: [configHandle, statusHandle] };
      },
    },

    installNode: {
      description:
        "Ensure a Node.js 22+ runtime: reuse an override, a managed runtime or " +
        "a PATH node; otherwise download and checksum-verify the official Node.js " +
        "distribution into the managed directory.",
      arguments: ForceArgsSchema,
      execute: async (
        args: ForceArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps = realDeps();
        const cfg = await resolvePersistedConfig(ctx);
        const node: NodeInfo = await ensureNode(deps, cfg, args.force);
        const handle = await ctx.writeResource(
          "node",
          "node",
          node as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "obsidian-headless node: {version} at {path} ({source})",
          {
            version: node.version || "(none)",
            path: node.binaryPath || "(none)",
            source: node.source,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Resolve a Node.js runtime and install/upgrade the obsidian-headless " +
        "npm package into the managed prefix. Idempotent; skips when the wanted " +
        "version is already present unless force is set.",
      arguments: ForceArgsSchema,
      execute: async (
        args: ForceArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps = realDeps();
        const cfg = await resolvePersistedConfig(ctx);
        const node = await ensureNode(deps, cfg, args.force);
        const pkg: PackageInfo = await ensurePackage(
          deps,
          cfg,
          node,
          args.force,
        );
        const nodeHandle = await ctx.writeResource(
          "node",
          "node",
          node as unknown as Record<string, unknown>,
        );
        const pkgHandle = await ctx.writeResource(
          "package",
          "package",
          pkg as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "obsidian-headless package: {version} at {prefix} (skipped={skipped})",
          { version: pkg.version, prefix: pkg.prefix, skipped: pkg.skipped },
        );
        return { dataHandles: [nodeHandle, pkgHandle] };
      },
    },

    configureSync: {
      description:
        "Resolve the remote vault by name on the account and configure the " +
        "local vault for headless sync (ob sync-setup), enforcing syncMode. " +
        "Reuses an existing local configuration; pass e2ePassword to run " +
        "sync-setup non-interactively for an end-to-end encrypted vault.",
      arguments: ConfigureSyncArgsSchema,
      execute: async (
        args: ConfigureSyncArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps = realDeps();
        const cfg = await resolvePersistedConfig(
          ctx,
          args.e2ePassword ? { e2ePassword: args.e2ePassword } : {},
        );
        const node = await ensureNode(deps, cfg, false);
        const vault: VaultInfo = await configureSync(
          deps,
          cfg,
          node,
          args.force,
        );
        const handle = await ctx.writeResource(
          "vault",
          "vault",
          vault as unknown as Record<string, unknown>,
        );
        ctx.logger?.info("obsidian-headless sync: {message}", {
          message: vault.message,
        });
        return { dataHandles: [handle] };
      },
    },

    disableInAppSync: {
      description:
        "Turn the vault's in-app `sync` core plugin off, backing up " +
        "core-plugins.json first. Idempotent. The bundled workflow gates this " +
        "behind a manual approval step.",
      arguments: NoArgsSchema,
      execute: async (
        _args: NoArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps = realDeps();
        const cfg = await resolvePersistedConfig(ctx);
        const info: InAppSyncInfo = await disableInAppSyncForVault(deps, cfg);
        const handle = await ctx.writeResource(
          "inAppSync",
          "inAppSync",
          info as unknown as Record<string, unknown>,
        );
        ctx.logger?.info("obsidian-headless in-app sync: {note}", {
          note: info.note,
        });
        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Summarise the end state — vault, node, package, in-app sync and the " +
        "systemd service — from the latest resources, and print how to inspect " +
        "the service.",
      arguments: NoArgsSchema,
      execute: async (
        _args: NoArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps = realDeps();
        const status = await latestAttributes(ctx, "status") as Partial<
          StatusInfo
        >;
        const vault = await latestAttributes(ctx, "vault") as Partial<
          VaultInfo
        >;
        const pkg = await latestAttributes(ctx, "package") as Partial<
          PackageInfo
        >;
        const inApp = await latestAttributes(ctx, "inAppSync") as Partial<
          InAppSyncInfo
        >;
        const node = await latestAttributes(ctx, "node") as Partial<NodeInfo>;
        // Prefer the freshly installed node over the (possibly pre-install)
        // status snapshot.
        const merged: Partial<StatusInfo> = {
          ...status,
          nodePath: node.binaryPath || status.nodePath,
        };
        const summary: SummaryInfo = buildSummary(
          merged,
          vault,
          pkg,
          inApp,
          deps.now(),
        );
        const handle = await ctx.writeResource(
          "summary",
          "summary",
          summary as unknown as Record<string, unknown>,
        );
        for (const line of summary.lines) ctx.logger?.info(line);
        return { dataHandles: [handle] };
      },
    },
  },
};
