/**
 * Caddy reverse-proxy and service management (MVP).
 *
 * A swamp model type (`@svendowideit/caddy`) that manages Caddy on a Linux
 * host with systemd. It is a swamp extension that drives Caddy via its admin
 * API and systemd — *not* a Go Caddy plugin.
 *
 * MVP methods:
 *   - `installCaddy`    — download (or build with xcaddy) the Caddy binary,
 *                         place it at `caddyBinPath`, and verify it runs.
 *   - `createService`   — write a systemd *user* service unit for Caddy.
 *   - `startService`    — start + enable the service and verify the admin API.
 *   - `settingsGuidance`— print the minimal settings needed for a useful
 *                         Let's Encrypt TLS-configured Caddy (base domain,
 *                         ACME email, admin API token).
 *
 * Linux-only: it shells out to `systemctl --user` and manages a systemd user
 * service. Pure helpers (unit rendering, path expansion, version parsing,
 * guidance rendering) are exported for unit testing.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  caddyBinPath: z.string().default("~/.local/bin/caddy").describe(
    "Path where the Caddy binary is installed",
  ),
  caddyVersion: z.string().optional().describe(
    "Caddy version to install (e.g. v2.8.4); omit for latest",
  ),
  adminApiAddr: z.string().default("localhost:2019").describe(
    "Caddy admin API listen address",
  ),
  configPath: z.string().default("~/.config/caddy/Caddyfile").describe(
    "Path to the Caddy config file the service runs",
  ),
  serviceName: z.string().default("caddy").describe(
    "systemd user service name",
  ),
  baseDomain: z.string().optional().describe(
    "Base domain used to derive hostnames (e.g. example.com)",
  ),
  letsEncryptEmail: z.string().optional().describe(
    "Email used for Let's Encrypt / ACME certificate issuance",
  ),
  plugins: z.array(z.string()).default([]).describe(
    "Caddy plugins to build in via xcaddy (e.g. github.com/caddy-dns/cloudflare)",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstallArgsSchema = z.object({
  version: z.string().optional().describe(
    "Override the Caddy version to install (defaults to global caddyVersion)",
  ),
  plugins: z.array(z.string()).optional().describe(
    "Override the plugins to build in (defaults to global plugins)",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even if the binary already exists",
  ),
});

const ServiceArgsSchema = z.object({
  serviceName: z.string().optional().describe(
    "Override the systemd service name (defaults to global serviceName)",
  ),
});

const GuidanceArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

const InstallOutputSchema = z.object({
  binPath: z.string(),
  version: z.string(),
  arch: z.string(),
  plugins: z.array(z.string()),
  installedAt: z.string(),
});

const ServiceOutputSchema = z.object({
  serviceName: z.string(),
  unitPath: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  adminApiReachable: z.boolean(),
  checkedAt: z.string(),
});

const GuidanceOutputSchema = z.object({
  guidance: z.string(),
  baseDomain: z.string(),
  letsEncryptEmail: z.string(),
  adminApiAddr: z.string(),
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

/** Map Deno's build arch to Caddy's download arch label. */
export function caddyArch(arch?: string): string {
  const a = arch ?? Deno.build.arch;
  switch (a) {
    case "x86_64":
      return "amd64";
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported architecture for Caddy: ${a}`);
  }
}

/** Parse the version string from `caddy version` output (e.g. "v2.8.4 h1:..."). */
export function parseCaddyVersion(stdout: string): string {
  const first = stdout.trim().split(/\s+/)[0] ?? "";
  if (!first) throw new Error("caddy version returned no version string");
  return first;
}

/** Render the systemd *user* service unit file content for Caddy. */
export function renderServiceUnit(opts: {
  binPath: string;
  configPath: string;
  adminApiAddr: string;
}): string {
  const { binPath, configPath, adminApiAddr } = opts;
  return `# Managed by @svendowideit/caddy — do not edit by hand.
[Unit]
Description=Caddy web server
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${binPath} run --config ${configPath} --adapter caddyfile --admin ${adminApiAddr}
ExecReload=${binPath} reload --config ${configPath} --adapter caddyfile --admin ${adminApiAddr}
Restart=on-failure
RestartSec=5
TimeoutStopSec=5
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
`;
}

/** Render a minimal, valid Caddyfile (sites are added later via the admin API). */
export function renderMinimalConfig(): string {
  return `# Managed by @svendowideit/caddy — sites are added via the admin API.
`;
}

/** Render the minimal-settings guidance text for a useful Let's Encrypt setup. */
export function renderSettingsGuidance(opts: {
  baseDomain: string;
  letsEncryptEmail: string;
  adminApiAddr: string;
}): string {
  const { baseDomain, letsEncryptEmail, adminApiAddr } = opts;
  return [
    "Caddy is installed and running. To make it a useful Let's Encrypt",
    "TLS-configured reverse proxy, provide these minimal settings:",
    "",
    "  1. base domain      — e.g. example.com",
    "     (hostnames are derived as <service-name>.<base-domain>)",
    `     current: ${baseDomain || "<not set>"}`,
    "",
    "  2. Let's Encrypt email — used for ACME account + expiry notices",
    `     current: ${letsEncryptEmail || "<not set>"}`,
    "",
    "  3. admin API token  — protect the admin API (recommended by Caddy)",
    `     admin API listens on: ${adminApiAddr}`,
    "     store the token in the swamp Vault (e.g. caddy/admin-token)",
    "",
    "Provide these via the model's global arguments or the swamp Vault.",
    "See the README for the exact keys and helper methods.",
  ].join("\n");
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

/** Download the standard Caddy binary (latest) and make it executable. */
async function downloadCaddy(
  binPath: string,
  arch: string,
): Promise<void> {
  const url = `https://caddyserver.com/api/download?os=linux&arch=${arch}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download Caddy (${resp.status}): ${url}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  await Deno.mkdir(dirnameOf(binPath), { recursive: true });
  await Deno.writeFile(binPath, bytes, { mode: 0o755 });
}

/** Build Caddy with plugins using xcaddy (requires Go + xcaddy on PATH). */
async function buildCaddyWithPlugins(
  binPath: string,
  version: string | undefined,
  plugins: string[],
): Promise<void> {
  const args = ["build"];
  if (version) args.push(version);
  for (const p of plugins) args.push("--with", p);
  args.push("--output", binPath);
  const result = await runCmd("xcaddy", args);
  if (result.code !== 0) {
    throw new Error(
      `xcaddy build failed (${result.code}): ${
        result.stderr || result.stdout
      }` +
        " — xcaddy requires Go and xcaddy installed on PATH",
    );
  }
}

/** Verify the installed binary: `caddy version` and `caddy list-modules`. */
async function verifyCaddy(binPath: string): Promise<{
  version: string;
  modules: string;
}> {
  const version = await runCmd(binPath, ["version"]);
  if (version.code !== 0) {
    throw new Error(
      `caddy version failed (${version.code}): ${
        version.stderr || version.stdout
      }`,
    );
  }
  const modules = await runCmd(binPath, ["list-modules"]);
  if (modules.code !== 0) {
    throw new Error(
      `caddy list-modules failed (${modules.code}): ${
        modules.stderr || modules.stdout
      }`,
    );
  }
  return {
    version: parseCaddyVersion(version.stdout),
    modules: modules.stdout,
  };
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

// ---------------------------------------------------------------------------
// systemd + admin API helpers
// ---------------------------------------------------------------------------

async function systemctl(
  args: string[],
): Promise<CmdResult> {
  return await runCmd("systemctl", ["--user", ...args]);
}

async function writeUnitFile(
  unitPath: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(dirnameOf(unitPath), { recursive: true });
  await Deno.writeTextFile(unitPath, content);
}

async function checkAdminApi(adminApiAddr: string): Promise<boolean> {
  const url = `http://${adminApiAddr}/config/`;
  try {
    const resp = await fetch(url);
    return resp.ok;
  } catch {
    return false;
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
};

export const model = {
  type: "@svendowideit/caddy",
  version: "2026.09.07.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    install: {
      description: "Caddy binary install status",
      schema: InstallOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    service: {
      description: "Caddy systemd user service status",
      schema: ServiceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    guidance: {
      description: "Minimal Let's Encrypt settings guidance",
      schema: GuidanceOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    installCaddy: {
      description:
        "Download (or build with xcaddy) the Caddy binary and verify it runs",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const binPath = expandHome(g.caddyBinPath);
        const version = args.version ?? g.caddyVersion;
        const plugins = args.plugins ?? g.plugins;
        const arch = caddyArch();

        const exists = await Deno.stat(binPath).then(() => true).catch(() =>
          false
        );
        if (exists && !args.force) {
          context.logger?.info(
            "Caddy binary already exists at {binPath}; use force=true to reinstall",
            { binPath },
          );
        } else {
          if (plugins.length > 0) {
            context.logger?.info(
              "Building Caddy with plugins via xcaddy: {plugins}",
              { plugins },
            );
            await buildCaddyWithPlugins(binPath, version, plugins);
          } else {
            context.logger?.info(
              "Downloading Caddy binary ({arch}) to {binPath}",
              { arch, binPath },
            );
            await downloadCaddy(binPath, arch);
          }
        }

        const verified = await verifyCaddy(binPath);
        context.logger?.info(
          "Caddy {version} installed at {binPath} ({arch})",
          { version: verified.version, binPath, arch },
        );

        const handle = await context.writeResource("install", "current", {
          binPath,
          version: verified.version,
          arch,
          plugins,
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    createService: {
      description: "Create the systemd user service unit for Caddy",
      arguments: ServiceArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const serviceName = args.serviceName ?? g.serviceName;
        const binPath = expandHome(g.caddyBinPath);
        const configPath = expandHome(g.configPath);
        const unitPath = expandHome(
          `~/.config/systemd/user/${serviceName}.service`,
        );

        const unit = renderServiceUnit({
          binPath,
          configPath,
          adminApiAddr: g.adminApiAddr,
        });
        await writeUnitFile(unitPath, unit);

        // Write a minimal config so the service can actually start.
        const configDir = dirnameOf(configPath);
        await Deno.mkdir(configDir, { recursive: true });
        await Deno.writeTextFile(configPath, renderMinimalConfig());

        const reload = await systemctl(["daemon-reload"]);
        if (reload.code !== 0) {
          throw new Error(
            `systemctl --user daemon-reload failed (${reload.code}): ${
              reload.stderr || reload.stdout
            }`,
          );
        }

        context.logger?.info(
          "Created systemd user service {serviceName} at {unitPath}",
          { serviceName, unitPath },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath,
          active: false,
          enabled: false,
          adminApiReachable: false,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startService: {
      description:
        "Start and enable the Caddy systemd user service and verify the admin API",
      arguments: ServiceArgsSchema,
      execute: async (
        args: z.infer<typeof ServiceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const serviceName = args.serviceName ?? g.serviceName;

        const enable = await systemctl(["enable", "--now", serviceName]);
        if (enable.code !== 0) {
          throw new Error(
            `systemctl --user enable --now ${serviceName} failed (${enable.code}): ${
              enable.stderr || enable.stdout
            }`,
          );
        }

        const active = await systemctl(["is-active", serviceName]);
        const enabled = await systemctl(["is-enabled", serviceName]);
        const adminApiReachable = await checkAdminApi(g.adminApiAddr);

        if (active.code !== 0) {
          throw new Error(
            `Caddy service ${serviceName} is not active: ${
              active.stderr || active.stdout
            }`,
          );
        }

        context.logger?.info(
          "Caddy service {serviceName} is active; admin API reachable: {reachable}",
          { serviceName, reachable: adminApiReachable },
        );

        const handle = await context.writeResource("service", "current", {
          serviceName,
          unitPath: expandHome(
            `~/.config/systemd/user/${serviceName}.service`,
          ),
          active: active.code === 0,
          enabled: enabled.code === 0,
          adminApiReachable,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    settingsGuidance: {
      description:
        "Print the minimal settings needed for a useful Let's Encrypt TLS-configured Caddy",
      arguments: GuidanceArgsSchema,
      execute: async (
        _args: z.infer<typeof GuidanceArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const baseDomain = g.baseDomain ?? "";
        const letsEncryptEmail = g.letsEncryptEmail ?? "";
        const guidance = renderSettingsGuidance({
          baseDomain,
          letsEncryptEmail,
          adminApiAddr: g.adminApiAddr,
        });

        context.logger?.info(guidance);

        const handle = await context.writeResource("guidance", "current", {
          guidance,
          baseDomain,
          letsEncryptEmail,
          adminApiAddr: g.adminApiAddr,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
