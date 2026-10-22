/**
 * @svendowideit/llama-cpp
 *
 * Run GGUF models whose architecture stock llama.cpp — and therefore Ollama —
 * cannot load, by installing a **customised llama.cpp kernel** (a patched
 * build), serving the model with `llama-server`, and verifying it answers.
 *
 * Where the `@svendowideit/ollama-models` extension covers everything Ollama can
 * do, this covers the models Ollama *can't* yet run. The kernel registry maps a
 * model architecture (e.g. Aleph-Alpha Kolibri-1's `kolibri1` MoE) to a concrete
 * prebuilt patched build for the host's OS/arch/accelerator; `install` extracts
 * it, `renderService` writes the systemd user unit, and `serve` runs it. Download
 * the GGUF with `@svendowideit/huggingface` and the kernel build with
 * `@svendowideit/github-release-install`; the bundled workflow wires all three.
 *
 * Methods:
 *   - `plan`           resolve the platform, kernel and build asset to fetch
 *   - `kernels`        list the built-in custom-kernel registry
 *   - `install`        extract a downloaded kernel build and locate its binaries
 *   - `renderService`  render the `llama-server` systemd user unit
 *   - `serve`/`stop`   start/stop the server
 *   - `status`         report unit state and `/health`
 *   - `run`            one-shot completion via `llama-cli`
 *   - `verify`         run a smoke prompt and assert a non-empty answer
 *   - `print`          log a summary
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  archiveFormat,
  assetSummary,
  cmakeFlagsFor,
  type KernelAsset,
  type KernelDef,
  kernelKeys,
  KERNELS,
  normalizeAccel,
  normalizeArch,
  normalizeOs,
  renderBuildScript,
  renderServiceUnit,
  resolveAsset,
  resolveKernel,
  systemctl,
  unitPath,
} from "./llama_cpp_shared.ts";

/** The model type name. */
export const LLAMA_CPP_TYPE = "@svendowideit/llama-cpp";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  installDir: z.string().default("~/.local/llama-cpp").describe(
    "Directory the kernel build is extracted into (expanded for `~`).",
  ),
  downloadDir: z.string().default("~/.cache/llama-cpp").describe(
    "Directory the kernel build archive is staged in.",
  ),
  host: z.string().default("127.0.0.1").describe("`llama-server` bind host."),
  port: z.number().int().default(8080).describe("`llama-server` bind port."),
  serviceName: z.string().default("llama-cpp").describe(
    "systemd unit name (without `.service`).",
  ),
  serviceScope: z.enum(["user", "system"]).default("user").describe(
    "systemd scope. `user` needs no root; `system` needs root/sudo.",
  ),
  unitDir: z.string().default("").describe(
    "Override the unit directory (advanced/testing).",
  ),
  ctx: z.number().int().default(4096).describe(
    "Default context window (`-c`).",
  ),
  ngl: z.number().int().default(-1).describe(
    "Default GPU layers (`-ngl`); -1 derives (0 on cpu, 999 otherwise).",
  ),
  threads: z.number().int().default(0).describe(
    "CPU threads (`-t`); 0 = server default.",
  ),
  keepAliveSec: z.number().int().default(3600).describe(
    "Keep-alive: seconds of idleness after which the served model sleeps (freeing " +
      "GPU/RAM) and wakes on the next request (`--sleep-idle-seconds`). 0 never " +
      "sleeps. Default 3600 (1 hour).",
  ),
  extraArgs: z.string().default("").describe(
    "Extra raw `llama-server` arguments.",
  ),
  sudo: z.string().default("sudo").describe(
    "Escalation command for system scope.",
  ),
  releaseRepo: z.string().default("").describe(
    "Override the kernel release repository (`owner/name`). Empty uses the kernel's.",
  ),
  releaseTag: z.string().default("").describe(
    "Override the kernel release tag. Empty uses the kernel's pinned tag.",
  ),
  caddyModelName: z.string().default("").describe(
    "Name of the @svendowideit/caddy model that owns this machine. Empty " +
      "auto-discovers the caddy model whose host matches this machine. Only used " +
      "by ensure-caddy-proxy.",
  ),
  caddyRouteHostname: z.string().default("").describe(
    "Override the Caddy route hostname for ensure-caddy-proxy. Empty derives " +
      "`<serviceName>.<host>.<domain>` from the source caddy model.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const PlanArgsSchema = z.object({
  kernel: z.string().default("").describe(
    "Kernel key (e.g. `kolibri1`). Empty plans only the host platform.",
  ),
  os: z.string().default("").describe(
    "Override the detected OS. Empty probes the host.",
  ),
  arch: z.string().default("").describe(
    "Override the detected arch. Empty probes the host.",
  ),
  accel: z.string().default("").describe(
    "Override the accelerator (cuda|rocm|vulkan|metal|cpu). Empty defaults to cpu.",
  ),
  assetName: z.string().default("").describe(
    "Select a specific asset by exact file name (e.g. a CUDA build), overriding " +
      "platform matching. Empty selects by os/arch/accel.",
  ),
  assetUrl: z.string().default("").describe(
    "Download URL to use directly (e.g. a locally built CUDA llama.cpp), " +
      "bypassing the registry. Empty derives it from the release.",
  ),
});
const SetupArgsSchema = z.object({});
const KernelsArgsSchema = z.object({});
const InstallArgsSchema = z.object({
  archivePath: z.string().default("").describe(
    "Path to the downloaded kernel archive.",
  ),
  archiveName: z.string().default("").describe(
    "Archive file name (for format + record).",
  ),
  checksum: z.string().default("").describe(
    "Expected SHA-256 (hex). Empty skips verification.",
  ),
  version: z.string().default("").describe(
    "Release tag/version the archive came from.",
  ),
  installDir: z.string().default("").describe(
    "Override the install dir. Empty uses the global.",
  ),
  force: z.boolean().default(false).describe(
    "Re-extract even when already installed.",
  ),
});
const DownloadArgsSchema = z.object({
  url: z.string().describe("Asset URL to download (from `plan.downloadUrl`)."),
  dir: z.string().default("").describe(
    "Download directory. Empty uses the global `downloadDir`.",
  ),
  force: z.boolean().default(false).describe(
    "Re-download even when the file already exists.",
  ),
});
const BuildArgsSchema = z.object({
  sourceDir: z.string().default("").describe(
    "Clone directory for llama.cpp. Empty uses `<downloadDir>/llama.cpp`.",
  ),
  jobs: z.number().int().default(0).describe("Parallel build jobs; 0 = nproc."),
  force: z.boolean().default(false).describe(
    "Rebuild even if already complete.",
  ),
});
const BuildStatusArgsSchema = z.object({
  wait: z.boolean().default(false).describe(
    "Poll until the source build finishes (or `maxWaitSec` elapses).",
  ),
  maxWaitSec: z.number().int().default(3600).describe(
    "Maximum seconds to wait when `wait` is set.",
  ),
});
const RenderServiceArgsSchema = z.object({
  model: z.string().describe("Absolute path to the GGUF to serve."),
  ctx: z.number().int().default(0).describe(
    "Context window. 0 uses the global.",
  ),
  ngl: z.number().int().default(-2).describe("GPU layers. -2 uses the global."),
  host: z.string().default("").describe("Bind host. Empty uses the global."),
  port: z.number().int().default(0).describe("Bind port. 0 uses the global."),
  threads: z.number().int().default(-1).describe(
    "Threads. -1 uses the global.",
  ),
  keepAliveSec: z.number().int().default(-1).describe(
    "Keep-alive seconds. -1 uses the global.",
  ),
  extraArgs: z.string().default("").describe(
    "Extra args. Empty uses the global.",
  ),
  write: z.boolean().default(false).describe(
    "Also write the unit file (user scope needs no root).",
  ),
});
const ServeArgsSchema = z.object({
  enable: z.boolean().default(true).describe(
    "Also `enable` the unit (start at login/boot).",
  ),
});
const StopArgsSchema = z.object({
  disable: z.boolean().default(false).describe("Also disable the unit."),
});
const StatusArgsSchema = z.object({});
const RunArgsSchema = z.object({
  model: z.string().describe("Absolute path to the GGUF."),
  prompt: z.string().describe("The prompt."),
  numPredict: z.number().int().default(128).describe(
    "Max tokens to generate (`-n`).",
  ),
  ctx: z.number().int().default(0).describe("Context. 0 uses the global."),
  ngl: z.number().int().default(-2).describe("GPU layers. -2 uses the global."),
  threads: z.number().int().default(-1).describe(
    "Threads. -1 uses the global.",
  ),
});
const VerifyArgsSchema = RunArgsSchema.extend({
  expectVram: z.boolean().default(false).describe(
    "Require GPU offload. Defaults false (CPU is a valid result here).",
  ),
});
const PrintArgsSchema = z.object({});
const EnsureCaddyProxyArgsSchema = z.object({
  model: z.string().default("").describe(
    "Source @svendowideit/caddy model. Empty auto-discovers the model that owns " +
      "this machine (or uses global caddyModelName).",
  ),
  hostname: z.string().default("").describe(
    "Override the proxied hostname. Empty derives `<serviceName>.<host>.<domain>`.",
  ),
  serveModel: z.string().default("").describe(
    "Dedicated caddy model that carries the route (unused). Empty runs against " +
      "the source model directly.",
  ),
});

type PlanArgs = z.infer<typeof PlanArgsSchema>;
type SetupArgs = z.infer<typeof SetupArgsSchema>;
type KernelsArgs = z.infer<typeof KernelsArgsSchema>;
type InstallArgs = z.infer<typeof InstallArgsSchema>;
type DownloadArgs = z.infer<typeof DownloadArgsSchema>;
type BuildArgs = z.infer<typeof BuildArgsSchema>;
type BuildStatusArgs = z.infer<typeof BuildStatusArgsSchema>;
type RenderServiceArgs = z.infer<typeof RenderServiceArgsSchema>;
type ServeArgs = z.infer<typeof ServeArgsSchema>;
type StopArgs = z.infer<typeof StopArgsSchema>;
type StatusArgs = z.infer<typeof StatusArgsSchema>;
type RunArgs = z.infer<typeof RunArgsSchema>;
type VerifyArgs = z.infer<typeof VerifyArgsSchema>;
type PrintArgs = z.infer<typeof PrintArgsSchema>;
type EnsureCaddyProxyArgs = z.infer<typeof EnsureCaddyProxyArgsSchema>;

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const PlanSchema = z.object({
  os: z.string(),
  arch: z.string(),
  accel: z.string(),
  requestedAccel: z.string().default(""),
  source: z.string().default("release"),
  sourceRepo: z.string().default(""),
  sourceCommit: z.string().default(""),
  patchUrl: z.string().default(""),
  patchName: z.string().default(""),
  kernel: z.string().default(""),
  title: z.string().default(""),
  releaseRepo: z.string().default(""),
  releaseTag: z.string().default(""),
  assetName: z.string().default(""),
  assetFormat: z.string().default(""),
  downloadUrl: z.string().default(""),
  installDir: z.string().default(""),
  binDir: z.string().default(""),
  serverBin: z.string().default(""),
  serviceName: z.string().default(""),
  serviceScope: z.string().default(""),
  supported: z.boolean().default(false),
  note: z.string().default(""),
  plannedAt: z.string(),
});

const ConfigSchema = z.object({
  installDir: z.string(),
  downloadDir: z.string().default(""),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().default(8080),
  serviceName: z.string().default("llama-cpp"),
  serviceScope: z.string().default("user"),
  ctx: z.number().int().default(4096),
  ngl: z.number().int().default(-1),
  threads: z.number().int().default(0),
  configuredAt: z.string(),
});

const KernelsSchema = z.object({
  count: z.number().int().default(0),
  kernels: z.array(z.object({
    key: z.string(),
    title: z.string().default(""),
    releaseRepo: z.string().default(""),
    releaseTag: z.string().default(""),
    coverage: z.string().default(""),
    ggufHint: z.string().default(""),
    note: z.string().default(""),
  })).default([]),
  listedAt: z.string(),
});

const InstallSchema = z.object({
  installDir: z.string(),
  binDir: z.string().default(""),
  serverBin: z.string().default(""),
  cliBin: z.string().default(""),
  version: z.string().default(""),
  assetName: z.string().default(""),
  extracted: z.array(z.string()).default([]),
  installedAt: z.string(),
});

const BuildSchema = z.object({
  sourceDir: z.string(),
  binDir: z.string().default(""),
  accel: z.string().default(""),
  cmakeFlags: z.array(z.string()).default([]),
  scriptPath: z.string().default(""),
  markerPath: z.string().default(""),
  failPath: z.string().default(""),
  logPath: z.string().default(""),
  unit: z.string().default(""),
  how: z.string().default(""),
  status: z.string().default("running"),
  startedAt: z.string(),
});

const DownloadSchema = z.object({
  url: z.string(),
  path: z.string(),
  assetName: z.string().default(""),
  sizeBytes: z.number().int().default(0),
  downloadedAt: z.string(),
});

const ServiceSchema = z.object({
  serviceName: z.string(),
  serviceScope: z.string(),
  unitPath: z.string(),
  model: z.string().default(""),
  content: z.string().default(""),
  written: z.boolean().default(false),
  renderedAt: z.string(),
});

const ServerSchema = z.object({
  serviceName: z.string(),
  serviceScope: z.string(),
  action: z.string(),
  active: z.boolean().default(false),
  enabled: z.boolean().default(false),
  at: z.string(),
});

const StatusSchema = z.object({
  serviceName: z.string(),
  serviceScope: z.string(),
  unitPath: z.string().default(""),
  active: z.boolean().default(false),
  enabled: z.boolean().default(false),
  health: z.string().default(""),
  checkedAt: z.string(),
});

const RunSchema = z.object({
  model: z.string(),
  prompt: z.string().default(""),
  response: z.string().default(""),
  tokensPerSecond: z.number().default(0),
  elapsedMs: z.number().int().default(0),
  at: z.string(),
});

const VerifySchema = z.object({
  model: z.string(),
  passed: z.boolean(),
  response: z.string().default(""),
  tokensPerSecond: z.number().default(0),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
  })).default([]),
  at: z.string(),
});

const SummarySchema = z.object({ text: z.string(), printedAt: z.string() });
const CaddyProxySchema = z.object({
  hostname: z.string(),
  upstream: z.string(),
  sourceModel: z.string(),
  baseDomain: z.string(),
  changed: z.boolean(),
  ensuredAt: z.string(),
});

// ---------------------------------------------------------------------------
// Command + fs helpers
// ---------------------------------------------------------------------------

/** The outcome of running a command. */
export interface RunResult {
  /** Exit code (`-1` when the binary is missing). */
  code: number;
  /** Decoded stdout. */
  stdout: string;
  /** Decoded stderr. */
  stderr: string;
}

/** Run a command, capturing stdout/stderr (never throwing). */
async function runCommand(bin: string, args: string[]): Promise<RunResult> {
  try {
    // swamp-quality-ignore deno-command: run arbitrary local binaries (uname, cmake, etc.) by design.
    const out = await new Deno.Command(bin, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
    };
  } catch {
    return { code: -1, stdout: "", stderr: `${bin} not found` };
  }
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    return home ? `${home}${path.slice(1)}` : path;
  }
  return path;
}

/** Whether a path exists (any type). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a shell script detached from this process so it outlives the run.
 * Prefers a transient systemd **user** unit; falls back to `setsid`/`nohup`.
 */
async function startDetached(opts: {
  scriptPath: string;
  unit: string;
  logPath: string;
  home: string;
}): Promise<{ how: string; unit: string; pid: number }> {
  const active = await runCommand("systemctl", [
    "--user",
    "is-active",
    opts.unit,
  ]);
  const state = active.stdout.trim();
  if (state === "active" || state === "activating") {
    return { how: "already-running", unit: opts.unit, pid: 0 };
  }
  const sr = await runCommand("systemd-run", [
    "--user",
    "--collect",
    `--unit=${opts.unit}`,
    "--property=Type=oneshot",
    `--setenv=HOME=${opts.home}`,
    "/bin/sh",
    opts.scriptPath,
  ]);
  if (sr.code === 0) return { how: "systemd-run", unit: opts.unit, pid: 0 };
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `setsid /bin/sh ${q(opts.scriptPath)} >${
    q(opts.logPath)
  } 2>&1 </dev/null & echo $!`;
  const r = await runCommand("sh", ["-c", cmd]);
  const pid = Number.parseInt(r.stdout.trim(), 10);
  return {
    how: r.code === 0 ? "setsid" : "failed",
    unit: "",
    pid: Number.isFinite(pid) ? pid : 0,
  };
}

/** Recursively find files named in `names` under `root`, returning path-by-name. */
export async function findBinaries(
  root: string,
  names: string[],
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (names.includes(e.name) && !(e.name in found)) found[e.name] = p;
    }
  };
  await walk(root);
  return found;
}

/** The result of detecting the host platform. */
export interface DetectedPlatform {
  /** OS token. */
  os: string;
  /** Architecture token. */
  arch: string;
}

/** Detect the host OS/arch from `uname` (Darwin/Linux) or env. */
export async function detectPlatform(): Promise<DetectedPlatform> {
  const u = await runCommand("uname", ["-s", "-m"]);
  const [osRaw, archRaw] = u.stdout.trim().split(/\s+/);
  return {
    os: normalizeOs(osRaw || "") ||
      (Deno.build.os === "darwin" ? "darwin" : "linux"),
    arch: normalizeArch(archRaw || "") || normalizeArch(Deno.build.arch),
  };
}

// ---------------------------------------------------------------------------
// Model definition
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
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Read this model's own newest record of one resource (by instance name). */
async function latestRecord(
  ctx: MethodContext,
  instanceName: string,
): Promise<Record<string, unknown> | null> {
  if (!ctx.readResource) return null;
  try {
    return await ctx.readResource(instanceName);
  } catch {
    return null;
  }
}

/** Resolve the effective server parameters from globals + args. */
function serverParams(
  g: GlobalArgs,
  args: {
    ctx?: number;
    ngl?: number;
    host?: string;
    port?: number;
    threads?: number;
    keepAliveSec?: number;
    extraArgs?: string;
  },
  accel = "cpu",
): {
  ctx: number;
  ngl: number;
  host: string;
  port: number;
  threads: number;
  sleepIdleSeconds: number;
  extraArgs: string;
} {
  const ctx = (args.ctx ?? 0) > 0 ? args.ctx! : g.ctx;
  const ngl = (args.ngl ?? -2) === -2
    ? (g.ngl >= 0 ? g.ngl : (accel === "cpu" ? 0 : 999))
    : args.ngl!;
  return {
    ctx,
    ngl,
    host: (args.host ?? "").trim() || g.host,
    port: (args.port ?? 0) > 0 ? args.port! : g.port,
    threads: (args.threads ?? -1) >= 0 ? args.threads! : g.threads,
    sleepIdleSeconds: (args.keepAliveSec ?? -1) >= 0
      ? args.keepAliveSec!
      : g.keepAliveSec,
    extraArgs: (args.extraArgs ?? "").trim() || g.extraArgs,
  };
}

/** Run a `systemctl` subcommand for the resolved scope. */
async function runSystemctl(
  g: GlobalArgs,
  sub: string[],
): Promise<RunResult> {
  const cmd = systemctl(g.serviceScope, sub);
  if (
    g.serviceScope === "system" &&
    (await runCommand("id", ["-u"])).stdout.trim() !== "0"
  ) {
    return await runCommand(g.sudo, [...cmd]);
  }
  return await runCommand(cmd[0], cmd.slice(1));
}

/** The absolute systemd unit directory for the resolved scope (expands `~`). */
function unitDirFor(g: GlobalArgs): string {
  const override = expandHome(g.unitDir).trim();
  if (override) return override;
  return g.serviceScope === "system"
    ? "/etc/systemd/system"
    : `${expandHome("~")}/.config/systemd/user`;
}

/** A model that installs a customised llama.cpp kernel and serves a GGUF with it. */
export const model = {
  type: "@svendowideit/llama-cpp",
  version: "2026.10.22.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.16.6",
      description:
        "Initial release: run GGUF models that need a customised llama.cpp " +
        "kernel. Maps a model architecture (e.g. Kolibri-1's `kolibri1` MoE) to a " +
        "prebuilt patched llama.cpp build for the host platform, extracts it, " +
        "renders and runs a `llama-server` systemd user unit, and verifies the " +
        "model answers. The kernel download is resumable (HTTP Range) and " +
        "skip-if-complete, so a retry never re-downloads. The served model is a " +
        "systemd user service, independent of the worker that set it up, with a " +
        "keep-alive: it listens always and the model sleeps after `keepAliveSec` " +
        "idle (default 3600) and wakes on the next request. `plan` selects the " +
        "build for this host's accelerator and accepts `assetName`/`assetUrl` " +
        "overrides (e.g. a CUDA build); it reports the accelerator of the build " +
        "actually chosen. When no prebuilt asset matches the host (e.g. an " +
        "aarch64+CUDA build that is not published), it falls back to building the " +
        "kernel from source: `build` clones llama.cpp at the kernel's pinned " +
        "commit, applies the patch, cmake-configures for the accelerator and " +
        "builds, as a host-managed background job; `buildStatus` awaits it and " +
        "records the `install` resource. Complements @svendowideit/ollama-models " +
        "for the models Ollama cannot load.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.22.1",
      description:
        "Adds an optional Caddy integration: when @svendowideit/caddy is " +
        "installed, ensure-caddy-proxy discovers the machine's caddy model and " +
        "declares a reverse-proxy route from <serviceName>.<host>.<domain> to the " +
        "model's localhost API port, with clear log notices. Schema is additive " +
        "(caddyModelName, caddyRouteHostname global args).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    config: {
      description: "Persisted server/kernel configuration.",
      schema: ConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    plan: {
      description: "Resolved platform, kernel and build asset.",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    kernels: {
      description: "The built-in custom-kernel registry.",
      schema: KernelsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    download: {
      description: "The downloaded kernel build archive.",
      schema: DownloadSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    build: {
      description: "An in-progress source build of the kernel.",
      schema: BuildSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    install: {
      description: "The extracted kernel build and its binaries.",
      schema: InstallSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    service: {
      description: "The rendered llama-server systemd unit.",
      schema: ServiceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    server: {
      description: "The result of a serve/stop action.",
      schema: ServerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    status: {
      description: "Live unit + health state.",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    run: {
      description: "One-shot llama-cli completion.",
      schema: RunSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    verify: {
      description: "Whether the model answered.",
      schema: VerifySchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    summary: {
      description: "A printed summary.",
      schema: SummarySchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    caddyProxy: {
      description:
        "Status of the Caddy reverse-proxy route declared for this model.",
      schema: CaddyProxySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    setup: {
      description:
        "Resolve and persist this model's configuration (dirs, host/port, " +
        "service, ctx/ngl). Reads any existing `config` back first so later runs " +
        "reuse it. Writes the `config` resource.",
      arguments: SetupArgsSchema,
      execute: async (
        _args: SetupArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const prior = await latestRecord(ctx, "config");
        const handle = await ctx.writeResource("config", "config", {
          installDir: g.installDir || String(prior?.["installDir"] ?? ""),
          downloadDir: g.downloadDir || String(prior?.["downloadDir"] ?? ""),
          host: g.host,
          port: g.port,
          serviceName: g.serviceName,
          serviceScope: g.serviceScope,
          ctx: g.ctx,
          ngl: g.ngl,
          threads: g.threads,
          configuredAt: new Date().toISOString(),
        });
        ctx.logger?.info(
          "llama-cpp setup: installDir={dir} service={name} ({scope})",
          {
            dir: g.installDir,
            name: g.serviceName,
            scope: g.serviceScope,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    plan: {
      description:
        "Resolve the host platform, the kernel for a model architecture, and " +
        "the exact build asset to fetch. Writes the `plan` resource.",
      arguments: PlanArgsSchema,
      execute: async (
        args: PlanArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const detected = await detectPlatform();
        const os = normalizeOs(args.os) || detected.os;
        const arch = normalizeArch(args.arch) || detected.arch;
        const requestedAccel = normalizeAccel(args.accel) || "cpu";
        const installDir = expandHome(g.installDir);
        const key = args.kernel.trim();
        const def = key ? resolveKernel(key) : null;
        const wanted = (args.assetName ?? "").trim();
        const urlOverride = (args.assetUrl ?? "").trim();
        const repo = g.releaseRepo || def?.releaseRepo || "";
        const tag = g.releaseTag || def?.releaseTag || "";
        let asset: KernelAsset | null = null;
        let build = false;
        if (wanted) {
          asset = def?.assets.find((a) => a.name === wanted) ?? {
            os,
            arch,
            accel: requestedAccel,
            name: wanted,
            format: archiveFormat(wanted),
          };
        } else if (urlOverride) {
          const name = urlOverride.split("/").pop() ?? "kernel-build";
          asset = {
            os,
            arch,
            accel: requestedAccel,
            name,
            format: archiveFormat(name),
          };
        } else if (def) {
          const exact = def.assets.find((a) =>
            a.os === os && a.arch === arch && a.accel === requestedAccel
          );
          if (exact) asset = exact;
          else if (def.source) build = true; // no matching prebuilt → build from source
          else asset = resolveAsset(def, { os, arch, accel: requestedAccel });
        }
        const downloadUrl = build ? "" : (urlOverride ||
          (asset && repo && tag
            ? `https://github.com/${repo}/releases/download/${tag}/${asset.name}`
            : ""));
        // Report the accelerator of the build actually chosen — so a CPU fallback
        // configures ngl=0 rather than offloading to a GPU it doesn't support.
        const accel = build ? requestedAccel : (asset?.accel ?? requestedAccel);
        const baseNote = def?.note ??
          (key ? `unknown kernel '${key}'` : "no kernel requested");
        const matchNote = build
          ? `no ${requestedAccel} asset for ${os}/${arch} — will build from source (${def?.source?.repo} @ ${def?.source?.commit})`
          : !asset
          ? "no build matched this platform/accelerator"
          : (asset.accel !== requestedAccel
            ? `requested ${requestedAccel} but using the ${asset.accel} build (no ${requestedAccel} asset for ${os}/${arch})`
            : "");
        const record = {
          os,
          arch,
          accel,
          requestedAccel,
          source: build ? "build" : "release",
          kernel: def?.key ?? key,
          title: def?.title ?? "",
          releaseRepo: repo,
          releaseTag: tag,
          assetName: asset?.name ?? "",
          assetFormat: asset?.format ?? "",
          downloadUrl,
          sourceRepo: def?.source?.repo ?? "",
          sourceCommit: def?.source?.commit ?? "",
          patchUrl: def?.source?.patchUrl ?? "",
          patchName: def?.source?.patchName ?? "",
          installDir,
          binDir: `${installDir}/bin`,
          serverBin: `${installDir}/bin/llama-server`,
          serviceName: g.serviceName,
          serviceScope: g.serviceScope,
          supported: build || asset !== null,
          note: matchNote ? `${baseNote} — ${matchNote}` : baseNote,
          plannedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("plan", "plan", record);
        ctx.logger?.info(
          "llama-cpp plan: {os}/{arch}/{accel} kernel={kernel} asset={asset}",
          {
            os,
            arch,
            accel,
            kernel: record.kernel || "-",
            asset: record.assetName || "-",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    kernels: {
      description: "List the built-in custom-kernel registry.",
      arguments: KernelsArgsSchema,
      execute: async (
        _args: KernelsArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const kernels = kernelKeys().map((k) => {
          const def: KernelDef = KERNELS[k];
          return {
            key: def.key,
            title: def.title,
            releaseRepo: def.releaseRepo,
            releaseTag: def.releaseTag,
            coverage: assetSummary(def),
            ggufHint: def.ggufHint,
            note: def.note,
          };
        });
        const handle = await ctx.writeResource("kernels", "kernels", {
          count: kernels.length,
          kernels,
          listedAt: new Date().toISOString(),
        });
        ctx.logger?.info("llama-cpp kernels: {n} registered", {
          n: kernels.length,
        });
        return { dataHandles: [handle] };
      },
    },

    download: {
      description:
        "Download the kernel build asset at `plan.downloadUrl` into the download " +
        "dir. Resumable (HTTP Range) and skip-if-complete, so a re-run never " +
        "re-downloads. Writes the `download` resource.",
      arguments: DownloadArgsSchema,
      execute: async (
        args: DownloadArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const dir = expandHome(args.dir || g.downloadDir);
        await Deno.mkdir(dir, { recursive: true });
        const assetName = args.url.split("/").pop() ?? "kernel-build";
        const path = `${dir.replace(/\/+$/, "")}/${assetName}`;
        let have = 0;
        try {
          const st = await Deno.stat(path);
          if (st.isFile) have = st.size;
        } catch {
          have = 0;
        }
        // Expected size from the asset's Content-Length (follow redirects).
        let expected = 0;
        try {
          const head = await fetch(args.url, {
            method: "HEAD",
            redirect: "follow",
          });
          expected =
            Number.parseInt(head.headers.get("content-length") ?? "", 10) || 0;
        } catch {
          expected = 0;
        }
        // Complete already — skip, no download, no upstream load.
        if (!args.force && expected > 0 && have >= expected) {
          const handle = await ctx.writeResource("download", "download", {
            url: args.url,
            path,
            assetName,
            sizeBytes: have,
            downloadedAt: new Date().toISOString(),
          });
          ctx.logger?.info("llama-cpp download: reusing complete {path}", {
            path,
          });
          return { dataHandles: [handle] };
        }
        // Resume a partial file with a Range request (unless force).
        const headers: Record<string, string> = {};
        if (!args.force && have > 0) headers["Range"] = `bytes=${have}-`;
        const res = await fetch(args.url, { headers, redirect: "follow" });
        if (res.status !== 200 && res.status !== 206) {
          throw new Error(
            `kernel download failed: HTTP ${res.status} for ${args.url}`,
          );
        }
        if (!res.body) {
          throw new Error(`kernel download failed: no body for ${args.url}`);
        }
        const appending = res.status === 206 && have > 0 && !args.force;
        const file = appending
          ? await Deno.open(path, { create: true, write: true, append: true })
          : await Deno.open(path, {
            create: true,
            write: true,
            truncate: true,
          });
        let written = appending ? have : 0;
        try {
          for await (const chunk of res.body) {
            await file.write(chunk);
            written += chunk.length;
          }
        } finally {
          file.close();
        }
        const handle = await ctx.writeResource("download", "download", {
          url: args.url,
          path,
          assetName,
          sizeBytes: written,
          downloadedAt: new Date().toISOString(),
        });
        ctx.logger?.info("llama-cpp download: {asset} ({bytes} B) -> {path}", {
          asset: assetName,
          bytes: written,
          path,
        });
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Extract a downloaded kernel build archive into the install dir and " +
        "locate its binaries (verifying the archive checksum when given).",
      arguments: InstallArgsSchema,
      execute: async (
        args: InstallArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const installDir = expandHome(args.installDir || g.installDir);
        const archivePath = expandHome(args.archivePath);
        if (!archivePath) {
          throw new Error(
            "install needs an archivePath (from github-release-install download)",
          );
        }
        if (args.checksum) {
          const sum = await runCommand("sha256sum", [archivePath]);
          const actual = sum.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
          if (actual !== args.checksum.trim().toLowerCase()) {
            throw new Error(
              `kernel archive checksum mismatch: expected ${args.checksum}, got ${
                actual || "none"
              }`,
            );
          }
        }
        const format = archiveFormat(args.archiveName || archivePath);
        await Deno.mkdir(installDir, { recursive: true });
        const ex = format === "zip"
          ? await runCommand("unzip", ["-o", archivePath, "-d", installDir])
          : await runCommand("tar", ["-xzf", archivePath, "-C", installDir]);
        if (ex.code !== 0) {
          throw new Error(
            `failed to extract ${archivePath}: ${
              ex.stderr.trim() || `exit ${ex.code}`
            }`,
          );
        }
        const bins = await findBinaries(installDir, [
          "llama-server",
          "llama-cli",
        ]);
        const serverBin = bins["llama-server"] ??
          `${installDir}/bin/llama-server`;
        const handle = await ctx.writeResource("install", "install", {
          installDir,
          binDir: serverBin.slice(0, serverBin.lastIndexOf("/")),
          serverBin,
          cliBin: bins["llama-cli"] ?? "",
          version: args.version,
          assetName: args.archiveName,
          extracted: Object.values(bins),
          installedAt: new Date().toISOString(),
        });
        ctx.logger?.info("llama-cpp install: extracted {asset} into {dir}", {
          asset: args.archiveName || archivePath,
          dir: installDir,
        });
        return { dataHandles: [handle] };
      },
    },

    build: {
      description:
        "Build the kernel from source when no prebuilt asset matches: clone " +
        "llama.cpp at the kernel's pinned commit, apply the kernel patch, cmake " +
        "for the accelerator, build, and install the binaries. Starts a " +
        "host-managed background build that outlives the run; `buildStatus` awaits it.",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const plan = await latestRecord(ctx, "plan");
        const def = plan ? resolveKernel(String(plan["kernel"] ?? "")) : null;
        const src = def?.source;
        if (!src) {
          throw new Error(
            "no source recipe for this kernel — run `plan` for a kernel that has " +
              "one (plan.source must be 'build')",
          );
        }
        const accel = String(plan?.["accel"] ?? "cpu");
        const sourceDir = expandHome(
          args.sourceDir || `${g.downloadDir}/llama.cpp`,
        );
        const binDir = `${expandHome(g.installDir)}/bin`;
        const workDir = `${expandHome(g.downloadDir)}/.builds`;
        await Deno.mkdir(workDir, { recursive: true });
        const key = `${String(plan?.["kernel"] ?? "kernel")}-${accel}`
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()
          .slice(0, 40);
        const markerPath = `${workDir}/${key}.done`;
        const failPath = `${workDir}/${key}.fail`;
        const scriptPath = `${workDir}/${key}.sh`;
        const logPath = `${workDir}/${key}.log`;
        const cmakeFlags = cmakeFlagsFor(accel);
        const script = renderBuildScript({
          sourceDir,
          repo: src.repo,
          commit: src.commit,
          patchUrl: src.patchUrl,
          patchName: src.patchName,
          apply: src.apply,
          cmakeFlags,
          jobs: args.jobs,
          binDir,
          markerPath,
          failPath,
          logPath,
        });
        await Deno.writeTextFile(scriptPath, script, { mode: 0o755 });
        const unit = `hf-build-${key}`.slice(0, 60);
        const started = await startDetached({
          scriptPath,
          unit,
          logPath,
          home: expandHome("~"),
        });
        const handle = await ctx.writeResource("build", "build", {
          sourceDir,
          binDir,
          accel,
          cmakeFlags,
          scriptPath,
          markerPath,
          failPath,
          logPath,
          unit: started.unit,
          how: started.how,
          status: "running",
          startedAt: new Date().toISOString(),
        });
        ctx.logger?.info(
          "llama-cpp build: {kernel} ({accel}) started via {how} → {log}",
          {
            kernel: String(plan?.["kernel"] ?? ""),
            accel,
            how: started.how,
            log: logPath,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    buildStatus: {
      description:
        "Await a source build started by `build`; on completion write the " +
        "`install` resource with the built binaries. Safe to re-run — the build " +
        "continues independently of this run.",
      arguments: BuildStatusArgsSchema,
      execute: async (
        args: BuildStatusArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const b = await latestRecord(ctx, "build");
        if (!b) throw new Error("no source build recorded — run `build` first");
        const marker = String(b["markerPath"] ?? "");
        const fail = String(b["failPath"] ?? "");
        const deadline = Date.now() + Math.max(0, args.maxWaitSec) * 1000;
        while (true) {
          if (await pathExists(fail)) {
            throw new Error(
              `kernel source build failed — see ${String(b["logPath"] ?? "")}`,
            );
          }
          if (await pathExists(marker)) break;
          if (!args.wait) {
            const handle = await ctx.writeResource("build", "build", {
              ...b,
              status: "running",
            });
            return { dataHandles: [handle] };
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `kernel source build still running — see ${
                String(b["logPath"] ?? "")
              }; it continues independently — re-run this step to await it`,
            );
          }
          await new Promise((r) => setTimeout(r, 15000));
        }
        const binDir = String(b["binDir"] ?? "");
        const serverBin = `${binDir}/llama-server`;
        const cliBin = `${binDir}/llama-cli`;
        const install = await ctx.writeResource("install", "install", {
          installDir: binDir.slice(0, binDir.lastIndexOf("/")),
          binDir,
          serverBin,
          cliBin: (await pathExists(cliBin)) ? cliBin : "",
          version: `source:${String(b["accel"] ?? "")}`,
          assetName: "built-from-source",
          extracted: [serverBin],
          installedAt: new Date().toISOString(),
        });
        const bh = await ctx.writeResource("build", "build", {
          ...b,
          status: "complete",
        });
        ctx.logger?.info("llama-cpp buildStatus: built {serverBin}", {
          serverBin,
        });
        return { dataHandles: [install, bh] };
      },
    },

    renderService: {
      description:
        "Render the `llama-server` systemd user unit for a GGUF (from the " +
        "installed kernel build), recording it — and writing it when `write=true`.",
      arguments: RenderServiceArgsSchema,
      execute: async (
        args: RenderServiceArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const install = await latestRecord(ctx, "install");
        const plan = await latestRecord(ctx, "plan");
        const serverBin = String(install?.["serverBin"] ?? "") ||
          `${expandHome(g.installDir)}/bin/llama-server`;
        const accel = String(plan?.["accel"] ?? "cpu");
        const p = serverParams(g, args, accel);
        const content = renderServiceUnit({
          serviceName: g.serviceName,
          serverBin,
          modelPath: expandHome(args.model),
          ...p,
          workDir: expandHome("~"),
        });
        const up = unitPath(g.serviceScope, g.serviceName, unitDirFor(g));
        let written = false;
        if (args.write) {
          const dir = up.slice(0, up.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(up, content);
          written = true;
        }
        const handle = await ctx.writeResource("service", "service", {
          serviceName: g.serviceName,
          serviceScope: g.serviceScope,
          unitPath: up,
          model: expandHome(args.model),
          content,
          written,
          renderedAt: new Date().toISOString(),
        });
        ctx.logger?.info(
          "llama-cpp renderService: {name} ({scope}) ctx={ctx} ngl={ngl}",
          {
            name: g.serviceName,
            scope: g.serviceScope,
            ctx: p.ctx,
            ngl: p.ngl,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    serve: {
      description:
        "Place the rendered unit (user scope writes it directly), daemon-reload, " +
        "then start/restart the service and report whether it is active.",
      arguments: ServeArgsSchema,
      execute: async (
        args: ServeArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const svc = await latestRecord(ctx, "service");
        const content = String(svc?.["content"] ?? "");
        const up = unitPath(g.serviceScope, g.serviceName, unitDirFor(g));
        if (content) {
          if (g.serviceScope === "system") {
            await runCommand(g.sudo, [
              "install",
              "-D",
              "-m",
              "0644",
              "/dev/stdin",
              up,
            ]);
          } else {
            const dir = up.slice(0, up.lastIndexOf("/"));
            await Deno.mkdir(dir, { recursive: true });
            await Deno.writeTextFile(up, content);
          }
        }
        await runSystemctl(g, ["daemon-reload"]);
        if (args.enable) await runSystemctl(g, ["enable", g.serviceName]);
        await runSystemctl(g, ["restart", g.serviceName]);
        const active =
          (await runSystemctl(g, ["is-active", g.serviceName])).stdout
            .trim() === "active";
        const enabled =
          (await runSystemctl(g, ["is-enabled", g.serviceName])).stdout
            .trim() === "enabled";
        const handle = await ctx.writeResource("server", "server", {
          serviceName: g.serviceName,
          serviceScope: g.serviceScope,
          action: "restart",
          active,
          enabled,
          at: new Date().toISOString(),
        });
        if (!active) {
          throw new Error(
            `llama-server unit ${g.serviceName} is not active after restart — check ` +
              `\`${
                systemctl(g.serviceScope, ["status", g.serviceName]).join(" ")
              }\``,
          );
        }
        ctx.logger?.info("llama-cpp serve: {name} active", {
          name: g.serviceName,
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop the server (optionally disabling the unit).",
      arguments: StopArgsSchema,
      execute: async (
        args: StopArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        await runSystemctl(g, ["stop", g.serviceName]);
        if (args.disable) await runSystemctl(g, ["disable", g.serviceName]);
        const active =
          (await runSystemctl(g, ["is-active", g.serviceName])).stdout
            .trim() === "active";
        const handle = await ctx.writeResource("server", "server", {
          serviceName: g.serviceName,
          serviceScope: g.serviceScope,
          action: "stop",
          active,
          enabled: false,
          at: new Date().toISOString(),
        });
        ctx.logger?.info("llama-cpp stop: {name} active={a}", {
          name: g.serviceName,
          a: active,
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Report the unit path, active/enabled state and `/health`.",
      arguments: StatusArgsSchema,
      execute: async (
        _args: StatusArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const active =
          (await runSystemctl(g, ["is-active", g.serviceName])).stdout
            .trim() === "active";
        const enabled =
          (await runSystemctl(g, ["is-enabled", g.serviceName])).stdout
            .trim() === "enabled";
        let health = "unreachable";
        try {
          const res = await fetch(`http://${g.host}:${g.port}/health`);
          health = res.ok ? "ok" : `HTTP ${res.status}`;
        } catch {
          health = "unreachable";
        }
        const handle = await ctx.writeResource("status", "status", {
          serviceName: g.serviceName,
          serviceScope: g.serviceScope,
          unitPath: unitPath(g.serviceScope, g.serviceName, unitDirFor(g)),
          active,
          enabled,
          health,
          checkedAt: new Date().toISOString(),
        });
        ctx.logger?.info(
          "llama-cpp status: active={a} enabled={e} health={h}",
          {
            a: active,
            e: enabled,
            h: health,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    run: {
      description: "Run a one-shot completion with `llama-cli` against a GGUF.",
      arguments: RunArgsSchema,
      execute: async (
        args: RunArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const install = await latestRecord(ctx, "install");
        const plan = await latestRecord(ctx, "plan");
        const cliBin = String(install?.["cliBin"] ?? "") ||
          `${expandHome(g.installDir)}/bin/llama-cli`;
        const accel = String(plan?.["accel"] ?? "cpu");
        const p = serverParams(g, args, accel);
        const argv = [
          "-m",
          expandHome(args.model),
          "-p",
          args.prompt,
          "-n",
          String(args.numPredict),
          "-c",
          String(p.ctx),
          "-ngl",
          String(p.ngl),
        ];
        if (p.threads > 0) argv.push("-t", String(p.threads));
        const started = Date.now();
        const r = await runCommand(cliBin, argv);
        const elapsedMs = Date.now() - started;
        const response = r.stdout.trim();
        if (r.code !== 0 && !response) {
          throw new Error(
            `llama-cli failed (${cliBin}): ${
              r.stderr.trim() || `exit ${r.code}`
            }`,
          );
        }
        const tps = parseTokensPerSecond(r.stderr) ||
          parseTokensPerSecond(r.stdout);
        const handle = await ctx.writeResource("run", "run", {
          model: args.model,
          prompt: args.prompt,
          response,
          tokensPerSecond: tps,
          elapsedMs,
          at: new Date().toISOString(),
        });
        ctx.logger?.info("llama-cpp run: {model} ({ms} ms)", {
          model: args.model,
          ms: elapsedMs,
        });
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Run a smoke prompt with the custom kernel and assert the model " +
        "answered (and, when `expectVram`, that it ran on the GPU).",
      arguments: VerifyArgsSchema,
      execute: async (
        args: VerifyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const install = await latestRecord(ctx, "install");
        const plan = await latestRecord(ctx, "plan");
        const cliBin = String(install?.["cliBin"] ?? "") ||
          `${expandHome(g.installDir)}/bin/llama-cli`;
        const accel = String(plan?.["accel"] ?? "cpu");
        const p = serverParams(g, args, accel);
        const argv = [
          "-m",
          expandHome(args.model),
          "-p",
          args.prompt,
          "-n",
          String(args.numPredict),
          "-c",
          String(p.ctx),
          "-ngl",
          String(p.ngl),
        ];
        const r = await runCommand(cliBin, argv);
        const response = r.stdout.trim();
        const answered = response.length > 0 && r.code === 0;
        const usedGpu = /offloaded\s+\d+\/\d+\s+layers to GPU|CUDA0|Metal/i
          .test(r.stderr);
        const vramOk = !args.expectVram || usedGpu;
        const checks = [
          { name: "llama-cli answered", passed: answered },
          { name: "GPU offload (expectVram)", passed: vramOk },
        ];
        const passed = answered && vramOk;
        const handle = await ctx.writeResource("verify", "verify", {
          model: args.model,
          passed,
          response,
          tokensPerSecond: parseTokensPerSecond(r.stderr),
          checks,
          at: new Date().toISOString(),
        });
        if (!passed) {
          throw new Error(
            `llama-cpp verify failed for ${args.model}: ` +
              checks.map((c) => `${c.name}=${c.passed}`).join(", ") +
              (r.stderr ? ` — ${r.stderr.trim().slice(0, 200)}` : ""),
          );
        }
        ctx.logger?.info("llama-cpp verify: {model} passed", {
          model: args.model,
        });
        return { dataHandles: [handle] };
      },
    },

    print: {
      description: "Log the last plan/install/verify summary.",
      arguments: PrintArgsSchema,
      execute: async (
        _args: PrintArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const plan = await latestRecord(ctx, "plan");
        const install = await latestRecord(ctx, "install");
        const verify = await latestRecord(ctx, "verify");
        const lines: string[] = [];
        if (plan) {
          lines.push(
            `plan: ${plan["os"]}/${plan["arch"]}/${plan["accel"]} kernel=${
              plan["kernel"]
            } asset=${plan["assetName"]}`,
          );
        }
        if (install) {
          lines.push(
            `install: ${install["serverBin"]} (${install["version"]})`,
          );
        }
        if (verify) {
          lines.push(`verify: ${verify["model"]} passed=${verify["passed"]}`);
        }
        const text = lines.join("\n") || "nothing recorded yet";
        const handle = await ctx.writeResource("summary", "summary", {
          text,
          printedAt: new Date().toISOString(),
        });
        ctx.logger?.info("llama-cpp summary:\n{text}", { text });
        return { dataHandles: [handle] };
      },
    },
    "ensure-caddy-proxy": {
      description:
        "When @svendowideit/caddy is installed, ensure a reverse-proxy route " +
        "`<serviceName>.<host>.<domain>` for this model's localhost API port, " +
        "so traffic is fronted automatically. Skips with a log when caddy is " +
        "not installed or no source caddy model can be chosen.",
      arguments: EnsureCaddyProxyArgsSchema,
      execute: async (args: EnsureCaddyProxyArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const log = ctx.logger;
        const runSwamp = async (cliArgs: string[]) => {
          // swamp-quality-ignore deno-command: optional caddy peer discovered at runtime; args are fixed literals or globals of this model, never untrusted input.
          const proc = new Deno.Command("swamp", {
            args: cliArgs,
            stdout: "piped",
            stderr: "piped",
          });
          const out = await proc.output();
          return {
            code: out.code,
            stdout: new TextDecoder().decode(out.stdout),
            stderr: new TextDecoder().decode(out.stderr),
          };
        };

        const probe = await runSwamp([
          "model",
          "type",
          "search",
          "@svendowideit/caddy",
          "--json",
        ]);
        const installed = probe.code === 0 &&
          probe.stdout.includes("@svendowideit/caddy");
        if (!installed) {
          log?.info(
            "@svendowideit/caddy not installed — skipping automatic caddy proxy setup.",
          );
          return { dataHandles: [] };
        }

        const list = await runSwamp(["model", "list", "--json"]);
        if (list.code !== 0) {
          log?.info(
            "Could not list models ({code}) — skipping automatic caddy proxy setup.",
            { code: list.code },
          );
          return { dataHandles: [] };
        }
        let all: Array<{ name: string; type: string }> = [];
        try {
          const parsed = JSON.parse(list.stdout) as {
            results?: Array<{ name: string; type: string }>;
          };
          all = parsed.results ?? [];
        } catch {
          all = [];
        }
        const names = all
          .filter((r) => r.type === "@svendowideit/caddy")
          .map((r) => r.name);
        if (names.length === 0) {
          log?.info(
            "No @svendowideit/caddy model found — skipping automatic caddy proxy setup. Create one first, e.g. `swamp model create @svendowideit/caddy my-caddy --global-arg baseDomain=example.com`.",
          );
          return { dataHandles: [] };
        }

        const host = (() => {
          try {
            return Deno.hostname();
          } catch {
            return "";
          }
        })();
        const facts: Array<{
          modelName: string;
          baseDomain: string;
          hostFqdn: string;
          serviceName: string;
          target: string;
        }> = [];
        for (const name of names) {
          const got = await runSwamp(["model", "get", name, "--json"]);
          if (got.code !== 0) continue;
          try {
            const raw = JSON.parse(got.stdout) as {
              globalArguments?: Record<string, unknown>;
            };
            const gRaw = raw.globalArguments ?? {};
            const baseDomain = typeof gRaw.baseDomain === "string"
              ? gRaw.baseDomain
              : "";
            const serviceName = typeof gRaw.serviceName === "string" &&
                gRaw.serviceName
              ? gRaw.serviceName
              : "caddy";
            const target = typeof gRaw.target === "string" ? gRaw.target : "";
            const records = Array.isArray(gRaw.dnsRecords)
              ? gRaw.dnsRecords as Array<Record<string, unknown>>
              : [];
            const base = baseDomain.toLowerCase().replace(/^\.+/, "");
            const candidates: string[] = [];
            for (const r of records) {
              if (
                typeof r.name !== "string" || typeof r.type !== "string"
              ) continue;
              if (
                r.type.toUpperCase() !== "A" && r.type.toUpperCase() !== "AAAA"
              ) {
                continue;
              }
              const name = (r.name as string).toLowerCase().replace(
                /^\.+/,
                "",
              );
              if (base && name !== base && !name.endsWith(`.${base}`)) {
                continue;
              }
              const value = Array.isArray(r.value) ? r.value : [];
              if (!value.some((v) => typeof v === "string" && !!v)) {
                continue;
              }
              candidates.push(name);
            }
            const shortHost = host.split(".")[0].toLowerCase();
            const named = candidates.find(
              (n) => shortHost && n.split(".")[0] === shortHost,
            );
            const deepest = candidates.slice().sort(
              (a, b) => b.split(".").length - a.split(".").length,
            )[0];
            const hostFqdn = named ?? deepest ?? baseDomain;
            facts.push({
              modelName: name,
              baseDomain,
              hostFqdn,
              serviceName,
              target,
            });
          } catch {
            // ignore
          }
        }

        const explicit = args.model?.trim() || g.caddyModelName?.trim();
        let source: {
          modelName: string;
          baseDomain: string;
          hostFqdn: string;
          serviceName: string;
          target: string;
        } | null = null;
        if (explicit) {
          source = facts.find((f) => f.modelName === explicit) ?? null;
          if (!source) {
            log?.info(
              "caddy model '{model}' not found — skipping automatic caddy proxy setup.",
              { model: explicit },
            );
            return { dataHandles: [] };
          }
        } else {
          const shortHost = host.split(".")[0].toLowerCase();
          const matches = facts.filter(
            (f) => shortHost && f.hostFqdn.split(".")[0] === shortHost,
          );
          if (matches.length === 1) source = matches[0];
          else if (matches.length > 1) {
            log?.info(
              "Could not pick a single caddy model to proxy through ({models}) — skipping automatic caddy proxy setup. Set caddyModelName on this model to choose one.",
              { models: names.join(", ") },
            );
            return { dataHandles: [] };
          } else {
            const withDomain = facts.filter((f) => f.baseDomain);
            if (withDomain.length === 1) source = withDomain[0];
          }
          if (!source) {
            log?.info(
              "Could not pick a single caddy model to proxy through ({models}) — skipping automatic caddy proxy setup. Set caddyModelName on this model to choose one.",
              { models: names.join(", ") },
            );
            return { dataHandles: [] };
          }
        }

        const serviceName = g.serviceName || "llama-cpp";
        const hostname = args.hostname?.trim() ||
          g.caddyRouteHostname?.trim() ||
          (
            source.hostFqdn.startsWith(`${serviceName}.`)
              ? source.hostFqdn
              : `${serviceName}.${source.hostFqdn}`
          );
        if (!hostname || !source.baseDomain) {
          log?.info(
            "caddy model '{model}' has no base domain — skipping automatic caddy proxy setup.",
            { model: source.modelName },
          );
          return { dataHandles: [] };
        }
        const upstream = `127.0.0.1:${g.port}`;
        log?.info(
          "Ensuring caddy proxy {hostname} -> {upstream} via {model}",
          { hostname, upstream, model: source.modelName },
        );

        const result = await runSwamp([
          "model",
          "method",
          "run",
          source.modelName,
          "ensureDnsProxy",
          "--input",
          `hostname=${hostname}`,
          "--input",
          `upstream=${upstream}`,
          "--skip-reports",
        ]);
        if (result.code !== 0) {
          throw new Error(
            `ensureDnsProxy failed (${result.code}): ${
              result.stderr || result.stdout
            }`,
          );
        }
        log?.info(
          "Caddy proxy ensured: {hostname} -> {upstream} (via {model}); run `swamp model method run {model} plan` to verify it is live.",
          { hostname, upstream, model: source.modelName },
        );

        const handle = await ctx.writeResource("caddyProxy", "current", {
          hostname,
          upstream,
          sourceModel: source.modelName,
          baseDomain: source.baseDomain,
          changed: true,
          ensuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Parse a tokens/second figure from llama.cpp's timing output, or 0. */
export function parseTokensPerSecond(text: string): number {
  const m = text.match(/([\d.]+)\s+tokens per second/i) ??
    text.match(/eval time.*?([\d.]+)\s*(?:ms|tokens)/i);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : 0;
}
