/**
 * @svendowideit/otel-agent
 *
 * Install and configure an OpenTelemetry Collector agent on a fleet of remote
 * hosts over SSH — OTLP-native, and driven entirely by the published settings
 * contract rather than duplicated flags.
 *
 * The point of this extension is the **config-from-network rule**: the agent
 * never hardcodes a collector config. For each host it fetches
 * `settingsUrl/install/<os>-<arch>.json` (to know what to install and from where)
 * and `settingsUrl/agent-config/<tier>.yaml` (to know how to configure it) from
 * `@svendowideit/otel-settings`. Changing the contract reconfigures the fleet
 * with no per-host editing. The gateway bearer token is read from a swamp vault
 * on the control node and written to a host-local env file (mode 0600), never
 * inlined in the rendered config.
 *
 * It is a **single fan-out method** over a host set (repo rule 6), like
 * `@swamp/ssh`: one `install-<host>` resource per host, bounded parallelism, so
 * hundreds of hosts do not contend on a per-model lock. T1 (full otelcol) and T2
 * (reduced, bounded memory) come from the contract's per-tier config; the model
 * itself only decides *which* tier a host is.
 *
 * Pure logic (install-script rendering, probe parsing, tier selection, manifest
 * parsing) is exported and unit-tested; only the methods touch SSH.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The vault key the gateway bearer token is stored under by default. */
const DEFAULT_BEARER_KEY = "OTEL_EXPORTER_OTLP_TOKEN";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const HostSchema = z.object({
  name: z.string().min(1).describe("Host label used in resource names"),
  address: z.string().min(1).describe("SSH destination (IP or DNS name)"),
  user: z.string().default("").describe(
    "SSH user for this host; empty uses the global sshUser",
  ),
  tier: z.string().default("").describe(
    "Device tier (T1/T2); empty infers it from the host",
  ),
  port: z.number().int().min(1).max(65535).default(22).describe("SSH port"),
}).strict();

const GlobalArgsSchema = z.object({
  settingsUrl: z.string().default("https://settings.otel.fi.gy").describe(
    "Base URL of the published settings contract (no trailing slash)",
  ),
  sshUser: z.string().default("").describe(
    "Default SSH user for hosts that do not set one",
  ),
  installDir: z.string().default("~/.local/share/otel-agent").describe(
    "Directory on the remote host for the binary, config, and env file",
  ),
  serviceName: z.string().default("otel-agent").describe(
    "systemd unit name for the agent on the remote host",
  ),
  defaultTier: z.string().default("T1").describe(
    "Tier to use when a host's tier cannot be inferred",
  ),
  vaultName: z.string().default("").describe(
    "Vault holding the gateway bearer token; empty installs unauthenticated",
  ),
  authRef: z.string().default(DEFAULT_BEARER_KEY).describe(
    "Vault key holding the gateway bearer token",
  ),
  concurrency: z.number().int().min(1).max(64).default(8).describe(
    "Maximum hosts operated on in parallel",
  ),
  sshTimeoutMs: z.number().int().positive().default(15000).describe(
    "SSH connect timeout, per host",
  ),
  installTimeoutMs: z.number().int().positive().default(120000).describe(
    "Maximum time a single host's install may take",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstallArgsSchema = z.object({
  hosts: z.array(HostSchema).min(1).describe("Hosts to onboard"),
  force: z.boolean().default(false).describe(
    "Reinstall even when the agent is already present and current",
  ),
});
const StatusArgsSchema = z.object({
  hosts: z.array(HostSchema).min(1).describe("Hosts to report on"),
});
const ConfigureArgsSchema = z.object({
  hosts: z.array(HostSchema).min(1).describe("Hosts to reconfigure"),
});
const RemoveArgsSchema = z.object({
  hosts: z.array(HostSchema).min(1).describe("Hosts to decommission"),
  removeInstallDir: z.boolean().default(false).describe(
    "Also delete the host install directory",
  ),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const HostResultSchema = z.object({
  host: z.string(),
  address: z.string(),
  reachable: z.boolean(),
  tier: z.string(),
  os: z.string(),
  arch: z.string(),
  installed: z.boolean(),
  active: z.boolean(),
  version: z.string(),
  detail: z.string(),
});

const FanOutOutputSchema = z.object({
  requested: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  hosts: z.array(HostResultSchema),
  ranAt: z.string(),
});

/** A parsed install manifest from the settings contract. */
export interface InstallManifest {
  /** Release OS token (linux/darwin/windows). */
  os: string;
  /** Release architecture token (amd64/arm64/…). */
  arch: string;
  /** Pinned agent version. */
  version: string;
  /** Release asset file name. */
  assetName: string;
  /** Served tarball URL. */
  tarballUrl: string;
  /** Served checksum URL. */
  checksumUrl: string;
}

/** Facts returned by the per-host probe script. */
export interface HostFacts {
  /** uname -m mapped to a release arch token (amd64/arm64/…). */
  arch: string;
  /** Release asset OS token (linux/darwin/windows). */
  os: string;
  /** Human os-release ID (debian/ubuntu/…), for display. */
  osId: string;
  /** Total memory in MiB, or undefined. */
  memTotalMiB?: number;
  /** Whether a systemd user manager is available. */
  systemd: boolean;
  /** Existing agent version, or "" when absent. */
  version: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~`; home is injectable so the helper stays pure. */
export function expandHome(path: string, homeDir?: string): string {
  if (!path.startsWith("~")) return path;
  const home = homeDir ?? Deno.env.get("HOME") ?? "~";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** The base URL without a trailing slash. */
export function normaliseBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Map `uname -m` output to a release architecture token. */
export function releaseArch(unameM: string): string {
  const m = unameM.trim().toLowerCase();
  if (["x86_64", "amd64"].includes(m)) return "amd64";
  if (["aarch64", "arm64"].includes(m)) return "arm64";
  if (["armv7l", "armv7", "armhf"].includes(m)) return "armv7";
  if (["i386", "i686"].includes(m)) return "386";
  if (m === "ppc64le") return "ppc64le";
  if (m === "s390x") return "s390x";
  return m || "amd64";
}

/** Infer a tier from host facts (mirrors fleet-inventory's rules). */
export function inferTier(facts: HostFacts, defaultTier: string): string {
  if (facts.memTotalMiB !== undefined && facts.memTotalMiB <= 4096) return "T2";
  return defaultTier || "T1";
}

/** Map an os-release ID (or uname) to the release asset's OS token. */
export function releaseOs(osId: string): string {
  const id = osId.trim().toLowerCase();
  const linuxDistros = new Set([
    "debian",
    "ubuntu",
    "raspbian",
    "linuxmint",
    "pop",
    "kali",
    "armbian",
    "alpine",
    "centos",
    "rhel",
    "fedora",
    "rocky",
    "almalinux",
    "linux",
    "opensuse",
    "opensuse-leap",
    "opensuse-tumbleweed",
    "sles",
    "arch",
    "manjaro",
  ]);
  if (linuxDistros.has(id)) return "linux";
  if (["darwin", "macos", "macosx", "osx"].includes(id)) return "darwin";
  if (["windows", "win"].includes(id)) return "windows";
  return id || "linux";
}

/** Parse the per-host probe script output (key=value lines). */
export function parseHostFacts(output: string): HostFacts {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const mem = map.get("mem_total_mib");
  const archRaw = map.get("arch") ?? "";
  const osRaw = map.get("os") ?? "";
  return {
    arch: releaseArch(archRaw),
    os: releaseOs(osRaw),
    osId: osRaw || "linux",
    memTotalMiB: mem ? Number.parseInt(mem, 10) : undefined,
    systemd: map.get("systemd") === "1",
    version: map.get("agent_version") ?? "",
  };
}

/** Parse an install manifest from the settings contract. */
export function parseInstallManifest(text: string): InstallManifest {
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    os: String(raw.os ?? ""),
    arch: String(raw.arch ?? ""),
    version: String(raw.agentVersion ?? raw.version ?? ""),
    assetName: String(raw.assetName ?? ""),
    tarballUrl: String(raw.tarballUrl ?? ""),
    checksumUrl: String(raw.checksumUrl ?? ""),
  };
}

/** The remote probe script: emits the facts `parseHostFacts` reads. */
export function renderProbeScript(binaryPath: string): string {
  return [
    'echo "arch=$(uname -m)"',
    'echo "systemd=$([ -d /run/systemd/system ] && echo 1 || echo 0)"',
    'if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=${ID:-linux}"; else echo "os=linux"; fi',
    "mem=$(awk '/MemTotal/ {printf \"%d\", $2/1024}' /proc/meminfo 2>/dev/null)",
    'echo "mem_total_mib=${mem:-}"',
    `if [ -x ${shellQuote(binaryPath)} ]; then echo "agent_version=$(${
      shellQuote(binaryPath)
    } --version 2>/dev/null | sed -n \'s/.* \\([0-9][0-9.]*\\)$/\\1/p\')"; fi`,
    "exit 0",
  ].join("\n");
}

/** POSIX single-quote a value. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Render the complete remote install script for one host. It is idempotent: it
 * skips the download when the installed binary already runs `version`, and
 * always writes the config, env file, and unit, then restarts.
 */
export function renderInstallScript(args: {
  installDir: string;
  binaryPath: string;
  configPath: string;
  envPath: string;
  serviceName: string;
  manifest: InstallManifest;
  config: string;
  token: string;
  force: boolean;
}): string {
  const dir = shellQuote(args.installDir);
  const bin = shellQuote(args.binaryPath);
  const cfg = shellQuote(args.configPath);
  const env = shellQuote(args.envPath);
  // The unit path must expand $HOME on the *remote* host, so it is double-quoted
  // (serviceName is validated safe) rather than single-quoted.
  const unit = `"$HOME/.config/systemd/user/${args.serviceName}.service"`;
  const lines: string[] = [];
  lines.push("set -e");
  lines.push(`mkdir -p ${dir}`);
  lines.push(
    `if [ -x ${bin} ] && ${bin} --version 2>/dev/null | grep -q ${
      shellQuote(args.manifest.version)
    } && [ "${args.force}" != "true" ]; then`,
  );
  lines.push(`  echo "agent already present at ${args.manifest.version}"`);
  lines.push("else");
  lines.push(
    `  tmp=$(mktemp -d) && curl -fsSL ${
      shellQuote(args.manifest.checksumUrl)
    } -o "$tmp/asset.sha256"`,
  );
  lines.push(
    `  curl -fsSL ${
      shellQuote(args.manifest.tarballUrl)
    } -o "$tmp/asset.tar.gz"`,
  );
  lines.push(
    `  ( cd "$tmp" && echo "$(cat asset.sha256)  asset.tar.gz" | sha256sum -c - )`,
  );
  lines.push(`  tar -xzf "$tmp/asset.tar.gz" -C "$tmp" otelcol-contrib`);
  lines.push(`  install -m 0755 "$tmp/otelcol-contrib" ${bin}`);
  lines.push(`  rm -rf "$tmp"`);
  lines.push("fi");
  // Config + env are written with a heredoc so no quoting games are needed.
  lines.push(`cat > ${cfg} <<'SWAMP_CFG_EOF'`);
  lines.push(args.config.replace(/\n+$/, ""));
  lines.push("SWAMP_CFG_EOF");
  lines.push(`umask 077 && cat > ${env} <<'SWAMP_ENV_EOF'`);
  lines.push(`OTEL_EXPORTER_OTLP_TOKEN=${args.token}`);
  lines.push("SWAMP_ENV_EOF");
  lines.push(`chmod 600 ${env} 2>/dev/null || true`);
  lines.push(`mkdir -p "$HOME/.config/systemd/user"`);
  lines.push(`cat > ${unit} <<'SWAMP_UNIT_EOF'`);
  lines.push(renderAgentUnit({
    binaryPath: args.binaryPath,
    configPath: args.configPath,
    envPath: args.envPath,
    serviceName: args.serviceName,
    agentVersion: args.manifest.version,
  }));
  lines.push("SWAMP_UNIT_EOF");
  lines.push("systemctl --user daemon-reload");
  lines.push('loginctl enable-linger "$USER" 2>/dev/null || true');
  lines.push(
    `systemctl --user enable ${args.serviceName}.service >/dev/null 2>&1 || true`,
  );
  lines.push(`systemctl --user restart ${args.serviceName}.service`);
  lines.push(
    `systemctl --user is-active ${args.serviceName}.service >/dev/null`,
  );
  lines.push(`echo "agent_installed=1"`);
  lines.push(`echo "agent_active=1"`);
  lines.push("exit 0");
  return lines.join("\n");
}

/** The systemd user unit for the agent. */
export function renderAgentUnit(args: {
  binaryPath: string;
  configPath: string;
  envPath: string;
  serviceName: string;
  agentVersion: string;
}): string {
  return [
    "[Unit]",
    `Description=OpenTelemetry Collector agent (${args.agentVersion})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `EnvironmentFile=-${args.envPath}`,
    `ExecStart=${args.binaryPath} --config ${args.configPath}`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** A systemd-safe service name check. */
export function isSafeServiceName(name: string): boolean {
  return /^[A-Za-z0-9_.@-]+$/.test(name) && !name.startsWith(".") &&
    name.length <= 255;
}

// ---------------------------------------------------------------------------
// Network + SSH helpers
// ---------------------------------------------------------------------------

/** Fetch text from the settings contract. */
export async function fetchText(
  url: string,
  timeoutMs = 15000,
): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "swamp-otel-agent/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.text();
}

/** Fetch and parse a host's install manifest from the settings contract. */
export async function fetchInstallManifest(
  settingsUrl: string,
  os: string,
  arch: string,
): Promise<InstallManifest> {
  const url = `${normaliseBaseUrl(settingsUrl)}/install/${os}-${arch}.json`;
  const text = await fetchText(url);
  return parseInstallManifest(text);
}

/** Fetch a host's agent config for its tier. */
export async function fetchAgentConfig(
  settingsUrl: string,
  tier: string,
): Promise<string> {
  return await fetchText(
    `${normaliseBaseUrl(settingsUrl)}/agent-config/${tier}.yaml`,
  );
}

/** The captured result of a remote SSH command. */
export interface SshResult {
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
  /** Remote exit code (255 when SSH itself failed). */
  code: number;
}

/** Run a command on a remote host over non-interactive SSH. */
export async function sshExec(
  dest: string,
  command: string,
  timeoutMs: number,
  port = 22,
): Promise<SshResult> {
  try {
    const proc = new Deno.Command("ssh", {
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
        "-p",
        String(port),
        dest,
        command,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await Promise.race([
      proc.output(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("ssh timed out")),
          timeoutMs,
        )
      ),
    ]);
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 255,
    };
  }
}

/** Map over items with at most `concurrency` in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

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
  ) => Promise<{ name: string }>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
}

async function readToken(ctx: MethodContext): Promise<string> {
  const g = ctx.globalArgs;
  if (!g.vaultName || !ctx.vaultService) return "";
  try {
    return await ctx.vaultService.get(
      g.vaultName,
      g.authRef,
      "model:otel-agent",
    );
  } catch {
    return "";
  }
}

/** Resolve one host's ssh destination and user. */
export function hostDest(
  host: { address: string; user: string },
  globalUser: string,
): string {
  const user = host.user || globalUser;
  return user ? `${user}@${host.address}` : host.address;
}

/** Onboard one host: probe, fetch contract, install, report. */
async function installHost(
  ctx: MethodContext,
  host: z.infer<typeof HostSchema>,
  token: string,
  force: boolean,
): Promise<z.infer<typeof HostResultSchema>> {
  const g = ctx.globalArgs;
  const dest = hostDest(host, g.sshUser);
  const installDir = expandHome(g.installDir);
  const binaryPath = `${installDir}/otelcol-contrib`;
  const configPath = `${installDir}/config.yaml`;
  const envPath = `${installDir}/agent.env`;

  const base: z.infer<typeof HostResultSchema> = {
    host: host.name,
    address: host.address,
    reachable: false,
    tier: "",
    os: "",
    arch: "",
    installed: false,
    active: false,
    version: "",
    detail: "",
  };

  const probe = await sshExec(
    dest,
    renderProbeScript(binaryPath),
    g.sshTimeoutMs,
    host.port,
  );
  if (probe.code !== 0) {
    return {
      ...base,
      detail: `ssh failed: ${probe.stderr.trim() || `exit ${probe.code}`}`,
    };
  }
  const facts = parseHostFacts(probe.stdout);
  const tier = host.tier || inferTier(facts, g.defaultTier);

  if (!facts.systemd) {
    return {
      ...base,
      reachable: true,
      os: facts.osId,
      arch: facts.arch,
      tier,
      detail: "no systemd user manager on the host",
    };
  }

  const manifest = await fetchInstallManifest(
    g.settingsUrl,
    facts.os,
    facts.arch,
  );
  const config = await fetchAgentConfig(g.settingsUrl, tier);

  const script = renderInstallScript({
    installDir,
    binaryPath,
    configPath,
    envPath,
    serviceName: g.serviceName,
    manifest,
    config,
    token,
    force,
  });
  const run = await sshExec(dest, script, g.installTimeoutMs, host.port);
  const installed = run.stdout.includes("agent_installed=1");
  const active = run.stdout.includes("agent_active=1") &&
    run.code === 0;
  return {
    ...base,
    reachable: true,
    os: facts.osId,
    arch: facts.arch,
    tier,
    installed,
    active,
    version: manifest.version,
    detail: installed
      ? (active ? "running" : "installed but not active")
      : (run.stderr.trim() || `exit ${run.code}`).split("\n").slice(-1)[0],
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/otel-agent`. */
export const model = {
  type: "@svendowideit/otel-agent",
  version: "2026.10.04.2",
  globalArguments: GlobalArgsSchema,
  checks: {
    "sane-config": {
      description: "Reject an unusable agent config before touching any host",
      labels: ["policy"],
      appliesTo: ["install", "configure", "status", "remove"],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const g = context.globalArgs;
        const errors: string[] = [];
        if (!isSafeServiceName(g.serviceName)) {
          errors.push(
            `serviceName '${g.serviceName}' is not a valid systemd unit name`,
          );
        }
        if (!/^https?:\/\//.test(g.settingsUrl)) {
          errors.push("settingsUrl must be an http(s) URL");
        }
        if (g.installDir.includes(" ")) {
          errors.push("installDir must not contain spaces");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.04.1",
      description:
        "Initial release: fan-out OTLP-native agent installer over SSH. `install`/`configure`/`status`/`remove` operate on a host set with bounded concurrency, fetching the install manifest and per-tier agent config from @svendowideit/otel-settings (config-from-network), verifying the mirrored binary's checksum, writing a 0600 env file with a vault-sourced gateway token, and running the collector as a systemd user service. One resource per host.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.04.2",
      description:
        "Renames the token vault globals to the vault naming convention that the credentials check recognises: tokenVault → vaultName and tokenKey → authRef. Existing models created before the rename are migrated automatically (the values are carried over). No other schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => {
        const next = { ...old };
        if ("tokenVault" in next) {
          next.vaultName = next.tokenVault;
          delete next.tokenVault;
        }
        if ("tokenKey" in next) {
          next.authRef = next.tokenKey;
          delete next.tokenKey;
        }
        return next;
      },
    },
  ],
  resources: {
    host: {
      description: "Per-host result of the last fan-out operation",
      schema: HostResultSchema.extend({ operation: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    fanOut: {
      description: "Summary of the last fan-out operation across all hosts",
      schema: FanOutOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    install: {
      description:
        "Install and start the agent on each host, from the published settings contract",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const token = await readToken(context);
        if (context.globalArgs.vaultName && !token) {
          throw new Error(
            `vaultName '${context.globalArgs.vaultName}' has no key ` +
              `'${context.globalArgs.authRef}' — store the gateway token with ` +
              `\`swamp vault put ${context.globalArgs.vaultName} ${context.globalArgs.authRef}\``,
          );
        }
        context.logger?.info("Onboarding {count} host(s)", {
          count: args.hosts.length,
        });
        const results = await mapWithConcurrency(
          args.hosts,
          context.globalArgs.concurrency,
          (h) => installHost(context, h, token, args.force),
        );
        return await writeFanOut(context, args.hosts, results, "install");
      },
    },

    configure: {
      description:
        "Re-fetch the contract and rewrite each host's config, then restart the agent",
      arguments: ConfigureArgsSchema,
      execute: async (
        args: z.infer<typeof ConfigureArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const token = await readToken(context);
        context.logger?.info("Reconfiguring {count} host(s)", {
          count: args.hosts.length,
        });
        const results = await mapWithConcurrency(
          args.hosts,
          context.globalArgs.concurrency,
          (h) => installHost(context, h, token, true),
        );
        return await writeFanOut(context, args.hosts, results, "configure");
      },
    },

    status: {
      description: "Report the agent's install and active state on each host",
      arguments: StatusArgsSchema,
      execute: async (
        args: z.infer<typeof StatusArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const installDir = expandHome(g.installDir);
        const binaryPath = `${installDir}/otelcol-contrib`;
        const results = await mapWithConcurrency(
          args.hosts,
          g.concurrency,
          async (host) => {
            const dest = hostDest(host, g.sshUser);
            const script = [
              renderProbeScript(binaryPath),
              `systemctl --user is-active ${g.serviceName}.service 2>/dev/null || true`,
            ].join("\n");
            const res = await sshExec(dest, script, g.sshTimeoutMs, host.port);
            if (res.code !== 0) {
              return {
                host: host.name,
                address: host.address,
                reachable: false,
                tier: "",
                os: "",
                arch: "",
                installed: false,
                active: false,
                version: "",
                detail: res.stderr.trim() || `exit ${res.code}`,
              };
            }
            const facts = parseHostFacts(res.stdout);
            const active = /(^|\n)active(\n|$)/.test(res.stdout);
            return {
              host: host.name,
              address: host.address,
              reachable: true,
              tier: host.tier || inferTier(facts, g.defaultTier),
              os: facts.osId,
              arch: facts.arch,
              installed: facts.version !== "",
              active,
              version: facts.version,
              detail: active ? "running" : "not active",
            };
          },
        );
        return await writeFanOut(context, args.hosts, results, "status");
      },
    },

    remove: {
      description:
        "Stop and disable the agent on each host (optionally delete its files)",
      arguments: RemoveArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const installDir = expandHome(g.installDir);
        const results = await mapWithConcurrency(
          args.hosts,
          g.concurrency,
          async (host) => {
            const dest = hostDest(host, g.sshUser);
            const lines = [
              `systemctl --user stop ${g.serviceName}.service 2>/dev/null || true`,
              `systemctl --user disable ${g.serviceName}.service 2>/dev/null || true`,
              `rm -f "$HOME/.config/systemd/user/${g.serviceName}.service"`,
              "systemctl --user daemon-reload 2>/dev/null || true",
            ];
            if (args.removeInstallDir) {
              lines.push(`rm -rf ${shellQuote(installDir)}`);
            }
            lines.push('echo "agent_removed=1"');
            lines.push("exit 0");
            const res = await sshExec(
              dest,
              lines.join("\n"),
              g.sshTimeoutMs,
              host.port,
            );
            const removed = res.stdout.includes("agent_removed=1");
            return {
              host: host.name,
              address: host.address,
              reachable: res.code === 0,
              tier: host.tier || "",
              os: "",
              arch: "",
              installed: false,
              active: false,
              version: "",
              detail: removed
                ? "removed"
                : (res.stderr.trim() || `exit ${res.code}`),
            };
          },
        );
        return await writeFanOut(context, args.hosts, results, "remove");
      },
    },
  },
};

/** Write the fan-out result, tagging each host and summarising. */
async function writeFanOut(
  context: MethodContext,
  hosts: z.infer<typeof HostSchema>[],
  results: z.infer<typeof HostResultSchema>[],
  op: string,
): Promise<{ dataHandles: [{ name: string }] }> {
  const succeeded =
    results.filter((r) =>
      op === "status"
        ? r.reachable
        : (r.installed && (op === "remove" || r.active))
    ).length;
  const failed = hosts.length - succeeded;
  // One resource per host, so a caller can read a single host's outcome.
  for (const r of results) {
    await context.writeResource("host", `${op}-${r.host}`, {
      ...r,
      operation: op,
    });
  }
  context.logger?.info(
    "{op}: {succeeded}/{requested} host(s) ok",
    { op, succeeded, requested: hosts.length },
  );
  const handle = await context.writeResource("fanOut", `${op}-summary`, {
    requested: hosts.length,
    succeeded,
    failed,
    hosts: results,
    ranAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}
