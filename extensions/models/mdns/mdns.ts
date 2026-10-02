/**
 * @svendowideit/mdns
 *
 * Advertise and discover services on the local network via Avahi/mDNS (Zeroconf).
 * This is the **bootstrap** layer of a fleet: before DNS names resolve on a
 * fresh or unconfigured host, mDNS lets it find the backend/gateway. The core
 * node advertises `_otlp-http._tcp` (and friends); new hosts browse for it, then
 * switch to the real DNS name once one is assigned.
 *
 * It drives the standard Avahi CLI (`avahi-publish-service`, `avahi-browse`) as
 * a systemd user service, so it works on Debian/Ubuntu, RPiOS, etc. without
 * pulling in another daemon.
 *
 * Pure helpers (record parsing, command rendering) are exported for unit
 * testing; the methods that touch the system run Avahi.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const AdvertiseSchema = z.object({
  instance: z.string().describe(
    "DNS-SD instance name to advertise (e.g. otel-gateway). Also names this advertisement's systemd unit, so it must be unique per advertisement.",
  ),
  serviceType: z.string().default("_otlp-http._tcp").describe(
    "mDNS service type (e.g. _otlp-http._tcp, _otel._tcp)",
  ),
  port: z.number().int().min(1).max(65535).describe("Service port"),
  hostName: z.string().default("").describe(
    "Override the advertised hostname (defaults to the system's mDNS hostname)",
  ),
  txt: z.record(z.string(), z.string()).default({}).describe(
    "TXT record key/value pairs",
  ),
});

const RemoveSchema = z.object({
  instance: z.string().default("").describe(
    "Remove only this advertisement's unit; empty removes every advertisement this model created",
  ),
});

const DiscoverSchema = z.object({
  serviceType: z.string().default("_otlp-http._tcp").describe(
    "mDNS service type to browse for",
  ),
  timeoutMs: z.number().int().positive().default(5000).describe(
    "Browse timeout in milliseconds",
  ),
});

const GlobalArgsSchema = z.object({
  serviceName: z.string().default("mdns").describe(
    "systemd user service name used for advertisement",
  ),
  serviceType: z.string().default("_otlp-http._tcp").describe(
    "Default mDNS service type to advertise/browse",
  ),
  hostName: z.string().default("").describe(
    "Default advertised hostname (e.g. otel.local); empty uses the system default",
  ),
  unitDir: z.string().default("~/.config/systemd/user").describe(
    "Directory for the generated systemd user unit",
  ),
  advertiseArgs: z.array(z.string()).default([]).describe(
    "Extra raw arguments appended to avahi-publish-service",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StatusArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const AdvertiseOutputSchema = z.object({
  instance: z.string(),
  serviceType: z.string(),
  port: z.number(),
  hostName: z.string(),
  unitName: z.string(),
  unitPath: z.string(),
  command: z.string(),
  started: z.boolean().default(false),
  detail: z.string().default(""),
  advertisedAt: z.string(),
});

const DiscoveredSchema = z.object({
  serviceName: z.string(),
  serviceType: z.string(),
  hostName: z.string(),
  address: z.string(),
  port: z.number(),
  txt: z.record(z.string(), z.string()),
});

const DiscoverOutputSchema = z.object({
  serviceType: z.string(),
  services: z.array(DiscoveredSchema),
  discoveredAt: z.string(),
});

/** One advertisement's unit and live state, as reported by `status`. */
const AdvertisementStateSchema = z.object({
  instance: z.string(),
  unitName: z.string(),
  unitPath: z.string(),
  installed: z.boolean(),
  active: z.boolean().default(false),
});

const StatusOutputSchema = z.object({
  /** The global unit-name prefix shared by this model's advertisements. */
  serviceNamePrefix: z.string(),
  advertisements: z.array(AdvertisementStateSchema).default([]),
  avahiAvailable: z.boolean(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A discovered mDNS service. */
export interface Discovered {
  /** Service instance name. */
  serviceName: string;
  /** Service type (e.g. `_otlp-http._tcp`). */
  serviceType: string;
  /** Advertised hostname. */
  hostName: string;
  /** Resolved IPv4/IPv6 address. */
  address: string;
  /** Service port. */
  port: number;
  /** TXT record key/value pairs. */
  txt: Record<string, string>;
}

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

/** Render the avahi-publish-service argument vector. */
export function renderAdvertiseArgs(opts: {
  serviceName: string;
  serviceType: string;
  port: number;
  hostName?: string;
  txt?: Record<string, string>;
  extra?: string[];
}): string[] {
  const args: string[] = [];
  if (opts.hostName) args.push("-H", opts.hostName);
  args.push(opts.serviceName, opts.serviceType, String(opts.port));
  for (const [k, v] of Object.entries(opts.txt ?? {})) {
    args.push(`${k}=${v}`);
  }
  if (opts.extra) args.push(...opts.extra);
  return args;
}

/**
 * Parse `avahi-browse -ptr` (or `-t`) plain output into discovered services.
 *
 * The parseable format is one line per record:
 *   =;iface;proto;name;type;domain;host;address;port;"txt"
 * We keep resolved records (`=`), decode `\032`-escaped names, and fold the
 * TXT field into a map.
 */
export function parseAvahiBrowse(output: string): Discovered[] {
  const services: Discovered[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("=")) continue;
    // Format: =;iface;proto;name;type;domain;host;address;port;"txt"
    const fields = splitAvahiLine(line);
    if (fields.length < 10) continue;
    const name = fields[3];
    const type = fields[4];
    const host = fields[6];
    const address = fields[7];
    const port = fields[8];
    const txt = fields[9];
    services.push({
      serviceName: unescapeAvahi(name),
      serviceType: type,
      hostName: host.replace(/\.$/, ""),
      address,
      port: Number.parseInt(port, 10) || 0,
      txt: parseTxt(txt),
    });
  }
  return services;
}

/** Split an avahi-browse line on `;`, respecting the trailing quoted TXT. */
function splitAvahiLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ";" && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Parse an avahi TXT field (`k=v` pairs separated by quotes/spaces). */
export function parseTxt(raw: string): Record<string, string> {
  const txt: Record<string, string> = {};
  const trimmed = raw.trim().replace(/^"|"$/g, "");
  if (!trimmed) return txt;
  for (const pair of trimmed.split(/"\s*"/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      txt[unescapeAvahi(pair.slice(0, eq))] = unescapeAvahi(pair.slice(eq + 1));
    }
  }
  return txt;
}

/** Decode avahi's `\032`-style character escapes. */
export function unescapeAvahi(s: string): string {
  return s.replace(
    /\\(\d{3})/g,
    (_, code) => String.fromCharCode(Number.parseInt(code, 10)),
  );
}

/** Render the systemd user unit that keeps the advertisement alive. */
export function renderAdvertiseUnit(opts: {
  serviceName: string;
  serviceType: string;
  port: number;
  hostName?: string;
  txt?: Record<string, string>;
  extra?: string[];
  avahiBin?: string;
}): string {
  const bin = opts.avahiBin ?? "avahi-publish-service";
  const args = renderAdvertiseArgs(opts);
  return `# Managed by @svendowideit/mdns — do not edit by hand.
[Unit]
Description=mDNS advertisement: ${opts.serviceType}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bin} ${args.map(shellQuote).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Minimal shell quoting for unit ExecStart arguments with spaces. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Render the avahi-browse argument vector for discovery. */
export function renderBrowseArgs(serviceType: string): string[] {
  return ["-ptr", serviceType];
}

/**
 * The systemd unit name for one advertisement: `<prefix>-<instance>`, sanitized
 * to a valid unit name. Each advertisement gets its OWN unit, so one can be added
 * or removed without touching the others.
 */
export function advertisementUnitName(
  prefix: string,
  instance: string,
): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `${sanitize(prefix)}-${sanitize(instance)}`;
}

/**
 * Every advertisement unit this model owns in `unitDir`, matched by the
 * `<prefix>-<instance>.service` filename. The filesystem is the registry: it is
 * what systemd actually loads, so it cannot drift from a swamp resource.
 */
export async function listAdvertiseUnits(
  unitDir: string,
  prefix: string,
): Promise<Array<{ instance: string; unitName: string; unitPath: string }>> {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "-");
  const prefixSan = sanitize(prefix);
  const out: Array<{ instance: string; unitName: string; unitPath: string }> =
    [];
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [];
    for await (const e of Deno.readDir(unitDir)) entries.push(e);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".service")) continue;
    const unitName = e.name.slice(0, -".service".length);
    if (!unitName.startsWith(`${prefixSan}-`)) continue;
    out.push({
      instance: unitName.slice(prefixSan.length + 1),
      unitName,
      unitPath: `${unitDir}/${e.name}`,
    });
  }
  return out.sort((a, b) => a.unitName.localeCompare(b.unitName));
}

/** Validate an advertise request, returning human-readable errors. */
export function validateAdvertise(
  opts: { serviceName: string; serviceType: string; port: number },
): string[] {
  const errors: string[] = [];
  if (!opts.serviceName) errors.push("serviceName is required");
  if (!opts.serviceType) errors.push("serviceType is required");
  if (!opts.serviceType.startsWith("_")) {
    errors.push(
      "serviceType should start with an underscore (e.g. _otlp-http._tcp)",
    );
  }
  if (!opts.port || opts.port < 1 || opts.port > 65535) {
    errors.push("port must be between 1 and 65535");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/mdns`. */
export const model = {
  type: "@svendowideit/mdns",
  version: "2026.10.02.2",
  globalArguments: GlobalArgsSchema,
  checks: {
    "avahi-available": {
      description: "Ensure avahi-publish-service and avahi-browse exist",
      labels: ["live"],
      appliesTo: ["advertise", "discover", "status", "remove"],
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        void context;
        const errors: string[] = [];
        if (!(await hasCommand("avahi-publish-service"))) {
          errors.push(
            "avahi-publish-service not found on PATH (install avahi-utils)",
          );
        }
        if (!(await hasCommand("avahi-browse"))) {
          errors.push("avahi-browse not found on PATH (install avahi-utils)");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.01.1",
      description:
        "Initial release: advertise `_otlp-http._tcp`/`_otel._tcp` services via avahi-publish-service (as a systemd user unit) and discover advertised services via avahi-browse.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.1",
      description:
        "Fixes two bugs that left the advertisement inert. advertise now daemon-reloads systemd and start+enables the unit (it previously only wrote the file, so nothing was ever advertised despite the docs saying it starts it); it records started/detail, and stages-only (reported, never silent) when unitDir is not systemd's own user unit dir. remove now stops + disables the unit before deleting it (a running advertisement no longer lingers). status now also reports whether the unit is active. Schema is additive (advertise gains started/detail, status gains active, all defaulted).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.2",
      description:
        "One systemd user unit PER advertisement, so a model can hold many independent advertisements and remove one without stopping the rest. The advertise argument is renamed serviceName -> instance (it is the DNS-SD instance name, which also names the unit: <globalServiceName>-<instance>.service); the global serviceName is now the unit-name prefix. remove takes an optional instance (omit to remove all this model owns), status lists every advertisement with its active state, and advertise records instance/unitName. BREAKING for the advertise argument name and the advertise/status resource shapes (add instance/unitName, drop the single serviceName/installed).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    advertise: {
      description: "mDNS advertisement configuration",
      schema: AdvertiseOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    discovery: {
      description: "Services discovered over mDNS",
      schema: DiscoverOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "mDNS advertisement status",
      schema: StatusOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    advertise: {
      description:
        "Write and start a systemd user unit advertising one mDNS service (one unit per instance)",
      arguments: AdvertiseSchema,
      execute: async (
        args: z.infer<typeof AdvertiseSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const hostName = args.hostName || g.hostName;
        const errors = validateAdvertise({
          serviceName: args.instance,
          serviceType: args.serviceType,
          port: args.port,
        });
        if (errors.length > 0) {
          throw new Error(`invalid advertise: ${errors.join("; ")}`);
        }
        const unitDir = expandHome(g.unitDir);
        await Deno.mkdir(unitDir, { recursive: true });
        const unitName = advertisementUnitName(g.serviceName, args.instance);
        const unitPath = `${unitDir}/${unitName}.service`;
        const unit = renderAdvertiseUnit({
          serviceName: args.instance,
          serviceType: args.serviceType,
          port: args.port,
          hostName,
          txt: args.txt,
          extra: g.advertiseArgs,
        });
        await Deno.writeTextFile(unitPath, unit);

        // Tell systemd and start it, so the advertisement is actually live.
        const { started, detail } = await startUnit(unitName, unitDir);
        context.logger?.info(
          "Advertised {instance} ({type}) on port {port} via {unit} [{detail}]",
          {
            instance: args.instance,
            type: args.serviceType,
            port: args.port,
            unit: unitPath,
            detail,
          },
        );

        const argsVec = renderAdvertiseArgs({
          serviceName: args.instance,
          serviceType: args.serviceType,
          port: args.port,
          hostName,
          txt: args.txt,
          extra: g.advertiseArgs,
        });
        const command = `avahi-publish-service ${
          argsVec.map(shellQuote).join(" ")
        }`;

        const handle = await context.writeResource("advertise", "current", {
          instance: args.instance,
          serviceType: args.serviceType,
          port: args.port,
          hostName,
          unitName,
          unitPath,
          command,
          started,
          detail,
          advertisedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    discover: {
      description:
        "Browse mDNS for a service type and record what is discoverable",
      arguments: DiscoverSchema,
      execute: async (
        args: z.infer<typeof DiscoverSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const serviceType = args.serviceType || context.globalArgs.serviceType;
        const services = await runBrowse(serviceType, args.timeoutMs);
        context.logger?.info(
          "Discovered {count} {type} service(s)",
          { count: services.length, type: serviceType },
        );
        const handle = await context.writeResource("discovery", "current", {
          serviceType,
          services,
          discoveredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report every advertisement unit this model created, whether each is active, and Avahi availability",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const units = await listAdvertiseUnits(unitDir, g.serviceName);
        const advertisements = [];
        for (const u of units) {
          advertisements.push({
            instance: u.instance,
            unitName: u.unitName,
            unitPath: u.unitPath,
            installed: true,
            active: await isUnitActive(u.unitName),
          });
        }
        const handle = await context.writeResource("status", "current", {
          serviceNamePrefix: g.serviceName,
          advertisements,
          avahiAvailable: await hasCommand("avahi-browse"),
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    remove: {
      description:
        "Stop, disable and delete this model's advertisement unit(s): one by instance, or all",
      arguments: RemoveSchema,
      execute: async (
        args: z.infer<typeof RemoveSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const unitDir = expandHome(g.unitDir);
        const wasDefaultDir = unitDir === expandHome("~/.config/systemd/user");

        // Which units to remove: the named instance's, or all this model owns.
        let targets: Array<{ unitName: string; unitPath: string }>;
        if (args.instance) {
          const unitName = advertisementUnitName(g.serviceName, args.instance);
          targets = [{ unitName, unitPath: `${unitDir}/${unitName}.service` }];
        } else {
          targets = await listAdvertiseUnits(unitDir, g.serviceName);
        }

        const removed: string[] = [];
        for (const t of targets) {
          // Stop + disable BEFORE deleting, so a running advertisement does not
          // linger. Only systemd's own unit dir is loadable; a custom dir was
          // staged-only, so there is nothing to stop.
          if (wasDefaultDir) await stopUnit(t.unitName);
          try {
            await Deno.remove(t.unitPath);
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          }
          removed.push(t.unitName);
        }
        context.logger?.info("Removed {count} advertisement unit(s)", {
          count: removed.length,
        });

        const units = await listAdvertiseUnits(unitDir, g.serviceName);
        const advertisements = [];
        for (const u of units) {
          advertisements.push({
            instance: u.instance,
            unitName: u.unitName,
            unitPath: u.unitPath,
            installed: true,
            active: await isUnitActive(u.unitName),
          });
        }
        const handle = await context.writeResource("status", "current", {
          serviceNamePrefix: g.serviceName,
          advertisements,
          avahiAvailable: await hasCommand("avahi-browse"),
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Whether a command exists on PATH. */
async function hasCommand(cmd: string): Promise<boolean> {
  const path = Deno.env.get("PATH") ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try {
      const stat = await Deno.stat(`${dir}/${cmd}`);
      if (stat.isFile || stat.isSymlink) return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** Run a `systemctl --user` subcommand, returning exit code and output. */
async function systemctlUser(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = new Deno.Command("systemctl", {
      args: ["--user", ...args],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout).trim(),
      stderr: new TextDecoder().decode(out.stderr).trim(),
    };
  } catch (err) {
    return {
      code: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Whether a systemd user unit is currently active. */
async function isUnitActive(serviceName: string): Promise<boolean> {
  const r = await systemctlUser(["is-active", serviceName]);
  return r.stdout === "active";
}

/**
 * Tell systemd about a written unit and start+enable it. Returns whether the
 * unit is active afterwards and a human-readable detail.
 *
 * `systemd` only knows units in its own search path, so a unit written to a
 * non-default `unitDir` cannot be started here; that case is reported as
 * "staged, not started" rather than silently pretending to be live.
 */
async function startUnit(
  serviceName: string,
  unitDir: string,
): Promise<{ started: boolean; detail: string }> {
  const defaultDir = expandHome("~/.config/systemd/user");
  if (unitDir !== defaultDir) {
    return {
      started: false,
      detail:
        `unitDir '${unitDir}' is not systemd's user unit dir; unit written but not started/enabled`,
    };
  }
  await systemctlUser(["daemon-reload"]);
  // enable --now starts a stopped unit, but does NOT restart an already-running
  // one, so a re-run that changed the ExecStart args would keep the old process.
  // Restart when it is already active so the new advertisement takes effect.
  if (await isUnitActive(serviceName)) {
    const restart = await systemctlUser(["restart", serviceName]);
    if (restart.code !== 0) {
      throw new Error(
        `systemctl --user restart ${serviceName} failed (${restart.code}): ${
          restart.stderr || restart.stdout
        }`,
      );
    }
  } else {
    const enable = await systemctlUser(["enable", "--now", serviceName]);
    if (enable.code !== 0) {
      throw new Error(
        `systemctl --user enable --now ${serviceName} failed (${enable.code}): ${
          enable.stderr || enable.stdout
        }`,
      );
    }
  }
  const active = await isUnitActive(serviceName);
  return {
    started: active,
    detail: active ? "active" : "enabled but not active yet",
  };
}

/** Stop and disable a systemd user unit, ignoring "not loaded". Never throws. */
async function stopUnit(serviceName: string): Promise<void> {
  await systemctlUser(["disable", "--now", serviceName]);
  await systemctlUser(["daemon-reload"]);
}

/** Run avahi-browse with a timeout and parse the result. */
async function runBrowse(
  serviceType: string,
  timeoutMs: number,
): Promise<Discovered[]> {
  try {
    const proc = new Deno.Command("avahi-browse", {
      args: renderBrowseArgs(serviceType),
      stdout: "piped",
      stderr: "piped",
    });
    const child = proc.spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }, timeoutMs);
    const out = await child.output();
    clearTimeout(timer);
    return parseAvahiBrowse(new TextDecoder().decode(out.stdout));
  } catch {
    return [];
  }
}
