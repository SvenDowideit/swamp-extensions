/**
 * @svendowideit/obsidian-app
 *
 * Install, update and configure the Obsidian desktop app **and its official
 * CLI** on Linux — rootlessly, from Obsidian's own release assets.
 *
 * The extension deliberately keeps to what is particular to Obsidian: the app's
 * tar.gz installer layout, the `obsidian-cli` binary that ships inside it
 * (installer 1.12.7+), the app's `cli` setting, and how `obsidian` resolves on
 * `PATH`. Release resolution and the verified download are delegated to
 * `@svendowideit/github-release-install`, whose `check` records the release and
 * whose `download` verifies the archive before it lands on disk; the bundled
 * workflows wire the two together.
 *
 * Methods:
 *   - `setup`        detect the host state and persist the resolved config
 *   - `plan`         pick this platform's installer archive from the release
 *   - `install`      unpack the verified installer and record the version
 *   - `registerCli`  register `obsidian` on PATH and turn the app's cli on
 *   - `print`        summarise the verified end state
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  type AssetInfo,
  buildSummary,
  type CliInfo,
  type Config,
  detectStatus,
  expandHome,
  installArchive,
  type InstallInfo,
  normaliseConfig,
  type PeerRelease,
  planAsset,
  planSandbox,
  realDeps,
  registerCli,
  type SandboxInfo,
  type StatusInfo,
  type SummaryInfo,
  verifySandbox,
} from "./obsidian_app_shared.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const stringArg = z.string().default("");

/** Global arguments — the persisted, per-instance configuration. */
const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  installMode: stringArg.describe(
    "Install mode: tar (the official tar.gz installer, rootless). Only tar is implemented.",
  ),
  installDir: stringArg.describe(
    "Directory the installer is unpacked into (default ~/.local/share/obsidian).",
  ),
  cliDir: stringArg.describe(
    "Directory the Obsidian CLI is registered in (default ~/.local/bin).",
  ),
  appConfigDir: stringArg.describe(
    "The Obsidian desktop app's config directory (default $XDG_CONFIG_HOME/obsidian).",
  ),
  downloadDir: stringArg.describe(
    "Directory the verified installer archive is staged in (default ~/.cache/obsidian-app).",
  ),
  desktopEntry: z.boolean().default(true).describe(
    "Write a user-local obsidian.desktop launcher pointing at installDir.",
  ),
  enableCli: z.boolean().default(true).describe(
    "Turn the app's cli setting on so the registered CLI is allowed to run.",
  ),
  sandbox: stringArg.describe(
    "How to make Chromium's sandbox work: auto (fix chrome-sandbox's owner " +
      "and mode through @svendowideit/sudo), setuid (same, explicit), " +
      "apparmor (stage a profile that allows the namespace sandbox), " +
      "no-sandbox (run with --no-sandbox, opt-in) or report (change nothing).",
  ),
  repo: stringArg.describe(
    "GitHub repository publishing the installers (default obsidianmd/obsidian-releases).",
  ),
});

/** Resolved {@link GlobalArgsSchema} type. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The persisted configuration resource. */
const ConfigSchema = z.object({
  installMode: z.string(),
  installDir: z.string(),
  cliDir: z.string(),
  appConfigDir: z.string(),
  downloadDir: z.string(),
  desktopEntry: z.boolean(),
  enableCli: z.boolean(),
  sandbox: z.string(),
  repo: z.string(),
});

/** Host + install state snapshot written by `setup`. */
const StatusSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  installMode: z.string(),
  installDir: z.string(),
  cliDir: z.string(),
  appConfigDir: z.string(),
  installed: z.boolean(),
  installedVersion: z.string(),
  binaryPath: z.string(),
  cliSourcePath: z.string(),
  cliSourcePresent: z.boolean(),
  appPackageVersion: z.string(),
  systemPackageVersion: z.string(),
  vaults: z.array(z.string()),
  appRunning: z.boolean(),
  cliPath: z.string(),
  cliRegistered: z.boolean(),
  cliExecutable: z.boolean(),
  cliDirOnPath: z.boolean(),
  cliFirstOnPathDir: z.string(),
  cliReachable: z.boolean(),
  cliFlag: z.boolean().nullable(),
  desktopEntryPresent: z.boolean(),
  sandboxHelperPresent: z.boolean(),
  sandboxHelperMode: z.number(),
  sandboxHelperOwnerUid: z.number(),
  sandboxHelperSetuidRoot: z.boolean(),
  sandboxUsernsRestricted: z.boolean(),
  checkedAt: z.string(),
  notes: z.array(z.string()),
});

/** The sandbox plan and check written by `sandbox` and `verifySandbox`. */
const SandboxSchema = z.object({
  desired: z.string(),
  route: z.string(),
  state: z.string(),
  launches: z.boolean(),
  cause: z.string(),
  probeOutput: z.string(),
  helperPath: z.string(),
  helperMode: z.number(),
  helperOwnerUid: z.number(),
  helperSetuidRoot: z.boolean(),
  usernsRestricted: z.boolean(),
  sudoRequired: z.boolean(),
  sudoOperation: z.string(),
  sudoSrc: z.string(),
  sudoDest: z.string(),
  sudoMode: z.string(),
  stagePath: z.string(),
  wrapperPath: z.string(),
  profilePath: z.string(),
  fallbackCommand: z.string(),
  verified: z.boolean(),
  notes: z.array(z.string()),
  checkedAt: z.string(),
});

/** The installer archive chosen by `plan`. */
const AssetSchema = z.object({
  version: z.string(),
  archiveName: z.string(),
  downloadUrl: z.string(),
  checksum: z.string(),
  checksumAlgorithm: z.string(),
  size: z.number(),
  mode: z.string(),
  arch: z.string(),
  releaseTag: z.string(),
  releaseModel: z.string(),
  selectedAt: z.string(),
});

/** The installer result written by `install`. */
const InstallSchema = z.object({
  mode: z.string(),
  version: z.string(),
  installedVersion: z.string(),
  binaryPath: z.string(),
  cliSourcePath: z.string(),
  archivePath: z.string(),
  archiveName: z.string(),
  checksum: z.string(),
  checksumVerified: z.boolean(),
  skipped: z.boolean(),
  verified: z.boolean(),
  desktopEntry: z.boolean(),
  sandboxHelperKept: z.boolean(),
  appWasRunning: z.boolean(),
  message: z.string(),
  installedAt: z.string(),
});

/** The CLI registration result written by `registerCli`. */
const CliSchema = z.object({
  path: z.string(),
  sourcePath: z.string(),
  registered: z.boolean(),
  changed: z.boolean(),
  upToDate: z.boolean(),
  onPath: z.boolean(),
  firstOnPathDir: z.string(),
  reachable: z.boolean(),
  flag: z.boolean().nullable(),
  flagChanged: z.boolean(),
  backupPath: z.string(),
  appRunning: z.boolean(),
  verified: z.boolean(),
  reportedVersion: z.string(),
  installerVersion: z.string(),
  note: z.string(),
  checkedAt: z.string(),
});

/** Final summary written by `print`. */
const SummarySchema = z.object({
  ok: z.boolean(),
  lines: z.array(z.string()),
  installedVersion: z.string(),
  binaryPath: z.string(),
  cliPath: z.string(),
  appPackageVersion: z.string(),
  cliVerified: z.boolean(),
  appRunning: z.boolean(),
  sandboxOk: z.boolean(),
  sandboxCause: z.string(),
  notes: z.array(z.string()),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const SetupArgsSchema = z.object({
  installMode: z.string().default("").describe(
    "Install mode to persist (tar). Empty keeps the persisted/global value.",
  ),
  installDir: stringArg.describe(
    "Install directory to persist. Empty keeps the persisted/global value.",
  ),
  cliDir: stringArg.describe(
    "CLI directory to persist. Empty keeps the persisted/global value.",
  ),
  appConfigDir: stringArg.describe(
    "App config directory to persist. Empty keeps the persisted/global value.",
  ),
  downloadDir: stringArg.describe(
    "Download staging directory to persist. Empty keeps the persisted/global value.",
  ),
  repo: stringArg.describe(
    "Installer repository to persist. Empty keeps the persisted/global value.",
  ),
  desktopEntry: z.boolean().optional().describe(
    "Whether to write a desktop entry. Omit to keep the persisted value.",
  ),
  enableCli: z.boolean().optional().describe(
    "Whether to turn the app's cli setting on. Omit to keep the persisted value.",
  ),
  sandbox: z.string().default("").describe(
    "Sandbox route to persist: auto, setuid, apparmor, no-sandbox or report. " +
      "Empty keeps the persisted/global value.",
  ),
});

const PlanArgsSchema = z.object({
  releaseModel: z.string().default("github-release").describe(
    "Model instance holding the resolved release (the workflow's release step).",
  ),
  arch: z.string().default("").describe(
    "Override the host architecture (x64 or arm64). Empty probes the host.",
  ),
});

const InstallArgsSchema = z.object({
  archivePath: z.string().default("").describe(
    "Absolute path of the verified installer archive, as recorded by github-release-install's download.",
  ),
  archiveName: z.string().default("").describe(
    "The archive's file name (from the release asset).",
  ),
  version: z.string().default("").describe(
    "The release version the archive came from.",
  ),
  checksum: z.string().default("").describe(
    "Expected SHA-256 of the archive. Empty records the install as unverified.",
  ),
  force: z.boolean().default(false).describe(
    "Unpack even when the same version is already installed.",
  ),
});

const RegisterArgsSchema = z.object({
  sourcePath: z.string().default("").describe(
    "Explicit obsidian-cli binary to register. Empty uses the installed app's own.",
  ),
  force: z.boolean().default(false).describe(
    "Re-copy and re-verify even when the registered CLI is up to date.",
  ),
});

/** Resolved argument types. */
type SetupArgs = z.infer<typeof SetupArgsSchema>;
/** Resolved argument type for `plan`. */
type PlanArgs = z.infer<typeof PlanArgsSchema>;
/** Resolved argument type for `install`. */
type InstallArgs = z.infer<typeof InstallArgsSchema>;
/** Resolved argument type for `registerCli`. */
type RegisterArgs = z.infer<typeof RegisterArgsSchema>;

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
function overlay<T>(...sources: Array<Partial<T>>): Partial<T> {
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

/** Read the latest resource a peer model instance wrote. */
async function peerAttributes(
  ctx: MethodContext,
  modelName: string,
  specName: string,
): Promise<Record<string, unknown>> {
  if (!ctx.readModelData || !modelName) return {};
  try {
    const rows = await ctx.readModelData(modelName, specName);
    if (!rows || rows.length === 0) return {};
    const latest = rows.reduce((a, b) =>
      (b.version ?? 0) >= (a.version ?? 0) ? b : a
    );
    const value = (latest.attributes ?? latest.content) as
      | Record<string, unknown>
      | undefined;
    return value ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolve config from three sources, lowest to highest precedence: the `config`
 * resource persisted by a previous run, the model's global arguments, and the
 * method inputs. Reading the persisted resource back is what lets one run
 * discover the host, persist what it found, and every later run reuse it
 * instead of asking again.
 */
async function resolveConfig(
  ctx: MethodContext,
  inputs: Partial<Config> = {},
): Promise<Config> {
  const deps = realDeps();
  const prior = await latestAttributes(ctx, "config") as Partial<Config>;
  const merged = overlay<Config>(
    prior,
    ctx.globalArgs as unknown as Partial<Config>,
    inputs,
  );
  return normaliseConfig(merged, {
    home: deps.home(),
    xdgConfigHome: deps.env("XDG_CONFIG_HOME") ?? "",
    platform: deps.platform(),
  });
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A model that installs, updates and configures Obsidian and its CLI. */
export const model = {
  type: "@svendowideit/obsidian-app",
  version: "2026.11.09.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.11.09.1",
      description:
        "Initial release: detect the host's Obsidian install, app package, CLI " +
        "state and Chromium sandbox; pick this platform's official installer " +
        "archive from the resolved release; unpack and verify it rootlessly; " +
        "register the obsidian CLI on PATH and turn the app's cli setting on; " +
        "then prove the app actually starts, fixing the setuid sandbox helper " +
        "through @svendowideit/sudo when Chromium refuses to run without one. " +
        "One lifecycle workflow does both jobs: obsidian-app-upgrade installs " +
        "when the target is absent and upgrades when it is present, so there is " +
        "no separate install workflow to drift from it.",
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
        "Detected host state: install, app package, system package, CLI, vaults.",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    asset: {
      description: "The installer archive chosen for this host.",
      schema: AssetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    install: {
      description: "What the installer unpacked, and where.",
      schema: InstallSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    cli: {
      description: "The registered Obsidian CLI and the app's cli setting.",
      schema: CliSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    sandbox: {
      description:
        "Whether Chromium's sandbox lets the app start, and what was done " +
        "about it.",
      schema: SandboxSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    summary: {
      description: "The verified end-state summary.",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    setup: {
      description:
        "Detect the host's Obsidian state (this extension's install, the app " +
        "package it auto-updated to, any system package, the CLI binary, how " +
        "`obsidian` resolves on PATH, the app's cli setting, registered " +
        "vaults) and persist the resolved configuration so later runs reuse it " +
        "rather than asking again. Changes nothing on the host.",
      arguments: SetupArgsSchema,
      execute: async (
        args: SetupArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps = realDeps();
        const cfg = await resolveConfig(ctx, args as Partial<Config>);
        const status = await detectStatus(deps, cfg);
        const configHandle = await ctx.writeResource(
          "config",
          "config",
          cfg as unknown as Record<string, unknown>,
        );
        const statusHandle = await ctx.writeResource(
          "status",
          "status",
          status as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "obsidian-app setup: installed={installed} version={version} " +
            "cli={cli} flag={flag} running={running}",
          {
            installed: status.installed,
            version: status.installedVersion || "(none)",
            cli: status.cliRegistered ? status.cliPath : "(none)",
            flag: status.cliFlag === null ? "(unset)" : status.cliFlag,
            running: status.appRunning,
          },
        );
        for (const note of status.notes) ctx.logger?.info(note);
        return { dataHandles: [configHandle, statusHandle] };
      },
    },

    plan: {
      description:
        "Read the release recorded by @svendowideit/github-release-install's " +
        "`check` and choose the installer archive this host needs " +
        "(obsidian-<version>.tar.gz, or -arm64 on arm64), recording its " +
        "download URL and the asset digest GitHub publishes for it.",
      arguments: PlanArgsSchema,
      execute: async (
        args: PlanArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps = realDeps();
        const cfg = await resolveConfig(ctx);
        const release = await peerAttributes(
          ctx,
          args.releaseModel,
          "release",
        ) as PeerRelease;
        const sourceUrl = String(release.sourceUrl ?? "");
        if (sourceUrl && !sourceUrl.includes(`/repos/${cfg.repo}/`)) {
          throw new Error(
            `The '${args.releaseModel}' release came from ${sourceUrl}, not ` +
              `from ${cfg.repo}. Re-run the release step with ` +
              `--input repo=${cfg.repo}.`,
          );
        }
        const asset: AssetInfo = planAsset(release, cfg, {
          arch: args.arch.trim() || deps.arch(),
          platform: deps.platform(),
          releaseModel: args.releaseModel,
          now: deps.now(),
        });
        const handle = await ctx.writeResource(
          "asset",
          "asset",
          asset as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "obsidian-app plan: {version} {archive} ({arch}, {mode})",
          {
            version: asset.version,
            archive: asset.archiveName,
            arch: asset.arch,
            mode: asset.mode,
          },
        );
        if (!asset.checksum) {
          ctx.logger?.warn?.(
            "GitHub publishes no digest for {archive}; the archive will be " +
              "recorded unverified (Obsidian ships no checksums file).",
            { archive: asset.archiveName },
          );
        }
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Unpack the verified installer archive into installDir (idempotent: " +
        "skips when that version is already installed unless force is set), " +
        "verify the binary, obsidian-cli and app package are all present, " +
        "record the version, and write a user-local desktop entry.",
      arguments: InstallArgsSchema,
      execute: async (
        args: InstallArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps = realDeps();
        const cfg = await resolveConfig(ctx);
        // Persist the config this run used, so a later run (an upgrade, or a
        // CLI re-registration) reuses the same paths instead of falling back to
        // the defaults.
        const configHandle = await ctx.writeResource(
          "config",
          "config",
          cfg as unknown as Record<string, unknown>,
        );
        const install: InstallInfo = await installArchive(deps, cfg, {
          archivePath: args.archivePath.trim()
            ? expandHome(args.archivePath.trim(), deps.home())
            : "",
          archiveName: args.archiveName,
          version: args.version,
          checksum: args.checksum,
          force: args.force,
        });
        const handle = await ctx.writeResource(
          "install",
          "install",
          install as unknown as Record<string, unknown>,
        );
        ctx.logger?.info("obsidian-app install: {message}", {
          message: install.message,
        });
        return { dataHandles: [configHandle, handle] };
      },
    },

    registerCli: {
      description:
        "Copy the app's obsidian-cli to cliDir/obsidian exactly as Obsidian's " +
        "own Linux registration does, turn the app's cli setting on (with a " +
        "backup; skipped while the app is running), report how `obsidian` " +
        "resolves on PATH, and verify by running `obsidian version` when the " +
        "app is up.",
      arguments: RegisterArgsSchema,
      execute: async (
        args: RegisterArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps = realDeps();
        const cfg = await resolveConfig(ctx);
        const configHandle = await ctx.writeResource(
          "config",
          "config",
          cfg as unknown as Record<string, unknown>,
        );
        const cli: CliInfo = await registerCli(deps, cfg, {
          sourcePath: args.sourcePath.trim()
            ? expandHome(args.sourcePath.trim(), deps.home())
            : "",
          force: args.force,
        });
        const handle = await ctx.writeResource(
          "cli",
          "cli",
          cli as unknown as Record<string, unknown>,
        );
        ctx.logger?.info("obsidian-app cli: {note}", { note: cli.note });
        return { dataHandles: [configHandle, handle] };
      },
    },

    sandbox: {
      description:
        "Start the installed app once to find out whether Chromium's sandbox " +
        "lets it run, then make the fix it can make without privileges: stage " +
        "chrome-sandbox for the privileged step that installs it root-owned " +
        "mode 4755, stage an AppArmor profile that allows the namespace " +
        "sandbox, or (only when asked) write a --no-sandbox wrapper. Records " +
        "the exact host command when no elevation route exists.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps = realDeps();
        const cfg = await resolveConfig(ctx);
        const configHandle = await ctx.writeResource(
          "config",
          "config",
          cfg as unknown as Record<string, unknown>,
        );
        const sandbox: SandboxInfo = await planSandbox(deps, cfg);
        const handle = await ctx.writeResource(
          "sandbox",
          "sandbox",
          sandbox as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "obsidian-app sandbox: state={state} route={route} launches={launches} " +
            "privileged={privileged}",
          {
            state: sandbox.state,
            route: sandbox.route,
            launches: sandbox.launches,
            privileged: sandbox.sudoRequired,
          },
        );
        for (const note of sandbox.notes) ctx.logger?.info(note);
        return { dataHandles: [configHandle, handle] };
      },
    },

    verifySandbox: {
      description:
        "Start the installed app again and check the sandbox after whatever " +
        "the workflow did to it: a launch that stays up passes, and so does a " +
        "correct helper when this session cannot show a window (no DISPLAY " +
        "over ssh — it says so). Removes the staged setuid helper, and fails " +
        "the run, with the exact host command, when the sandbox is still " +
        "broken.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const deps = realDeps();
        const cfg = await resolveConfig(ctx);
        const sandbox: SandboxInfo = await verifySandbox(deps, cfg);
        const handle = await ctx.writeResource(
          "sandbox",
          "sandbox",
          sandbox as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "obsidian-app sandbox check: verified={verified} launches={launches} " +
            "state={state} cause={cause} helper={helper}",
          {
            verified: sandbox.verified,
            launches: sandbox.launches,
            state: sandbox.state,
            cause: sandbox.cause,
            helper: sandbox.helperSetuidRoot ? "setuid root" : "not setuid",
          },
        );
        for (const note of sandbox.notes) ctx.logger?.info(note);
        if (!sandbox.verified) {
          // Never fail with an empty message: an unexplained refusal still has
          // to name the app and the command that checks it by hand.
          const reason = sandbox.notes.join(" ").trim() ||
            `Obsidian at ${
              sandbox.helperPath.replace(
                /\/[^/]+$/,
                "",
              )
            } did not start`;
          throw new Error(reason);
        }
        return { dataHandles: [handle] };
      },
    },

    print: {
      description:
        "Re-read the host and summarise the verified end state — installer " +
        "version and path, the app package Obsidian updated itself to, the " +
        "registered CLI, how `obsidian` resolves, whether the CLI answered, " +
        "whether the sandbox lets the app start, and anything that still " +
        "needs a person.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const deps = realDeps();
        const cfg = await resolveConfig(ctx);
        const status: StatusInfo = await detectStatus(deps, cfg);
        const install = await latestAttributes(ctx, "install") as Partial<
          InstallInfo
        >;
        const cli = await latestAttributes(ctx, "cli") as Partial<CliInfo>;
        const sandbox = await latestAttributes(ctx, "sandbox") as Partial<
          SandboxInfo
        >;
        const summary: SummaryInfo = buildSummary(
          status,
          install,
          cli,
          deps.now(),
          sandbox,
        );
        const handle = await ctx.writeResource(
          "summary",
          "summary",
          summary as unknown as Record<string, unknown>,
        );
        for (const line of summary.lines) ctx.logger?.info(line);
        for (const note of summary.notes) ctx.logger?.info(note);
        return { dataHandles: [handle] };
      },
    },
  },
};
