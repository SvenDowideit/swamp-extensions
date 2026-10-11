/**
 * @svendowideit/host-facts
 *
 * The local machine's own identity, as one `host` resource. Reads the FQDN, the
 * short hostname, the stable machine id, the OS, the architecture and the local
 * addresses straight off this host — no network, no SSH, no credentials.
 *
 * This is the local half of "know the hosts": {@link @svendowideit/fleet-inventory}
 * surveys the fleet over the network; this reports the one machine it runs on.
 * Its field vocabulary is deliberately aligned with fleet-inventory's
 * `InventoryHost` (`name`, `machineId`, `hostnames`, `addresses`, `os`, `source`,
 * `tier`, `probed`, `lastSeen`, …) so a consumer can read the same field from
 * either source, and so a `self` view of a fleet member lines up with its
 * inventory record. It adds `fqdn` and `hostname` (fleet-inventory folds these
 * into `name`/`hostnames`) plus `arch`, because a plain FQDN is what most
 * callers actually want.
 *
 * Prefer it over reading `$HOSTNAME`: that is a bash convenience variable, only
 * present when exported, and it names the login host rather than the host the
 * process runs on. This reads the kernel/FQDN truth, so it is correct under
 * `swamp serve`, on a swamp worker, or in a container.
 *
 * Methods:
 *   - `collect`  read this host's facts and write the `host` resource
 *   - `status`   report whether a `host` resource exists (no re-read)
 *
 * @module
 */

import { z } from "npm:zod@4";

/** The model type name. */
export const HOST_FACTS_TYPE = "@svendowideit/host-facts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const safeValue = (label: string): z.ZodString =>
  z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp; used by status to read its record).",
  ),
  fqdnOverride: safeValue("fqdnOverride").default("").describe(
    "Override the detected FQDN (empty detects it with `hostname -f`).",
  ),
  hostnameOverride: safeValue("hostnameOverride").default("").describe(
    "Override the detected short hostname (empty detects it with `hostname -s`).",
  ),
  domain: safeValue("domain").default("").describe(
    "Site domain to append when the host reports only a short name (e.g. " +
      "`fi.gy` turns `x1yoga` into `x1yoga.fi.gy`). Empty uses the detected " +
      "FQDN as-is; a host that already answers with a dotted FQDN is left alone.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const CollectArgsSchema = z.object({});
const StatusArgsSchema = z.object({});

type CollectArgs = z.infer<typeof CollectArgsSchema>;
type StatusArgs = z.infer<typeof StatusArgsSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

/**
 * The local host record. The first block mirrors
 * `@svendowideit/fleet-inventory`'s `InventoryHost` field-for-field so the same
 * reader works on either source; the last block carries the fields that only
 * make sense for the local machine and that fleet-inventory has no equivalent
 * of.
 */
const HostSchema = z.object({
  // --- aligned with fleet-inventory's InventoryHost ---
  /** Primary display name (the FQDN, else the short hostname). */
  name: z.string(),
  /** Primary local address (first known), or "". */
  address: z.string().default(""),
  /** Primary MAC, always "" locally (not collected). */
  mac: z.string().default(""),
  /** Stable machine id (Linux `/etc/machine-id`, macOS IOPlatformUUID), else "". */
  machineId: z.string().default(""),
  /** Every name this host answers to (FQDN, short name, aliases). */
  hostnames: z.array(z.string()).default([]),
  /** Every local address seen, in order. */
  addresses: z.array(z.string()).default([]),
  /** MACs, always [] locally (not collected). */
  macs: z.array(z.string()).default([]),
  /** Always "self" — this record was read from the host itself. */
  source: z.string(),
  /** Device tier from the fleet convention; "" (not classified locally). */
  tier: z.string().default(""),
  /** OS id: Linux `/etc/os-release` ID (e.g. `ubuntu`), or `darwin`. */
  os: z.string().default(""),
  /** Device class; "" (no fingerprinting locally). */
  deviceClass: z.string().default(""),
  /** Vendor; "" (no fingerprinting locally). */
  vendor: z.string().default(""),
  /** Free-form notes; "". */
  notes: z.string().default(""),
  /** Always true — a locally read record is by definition probed. */
  probed: z.boolean().default(true),
  /** Whether the host reports telemetry; false (not known here). */
  reporting: z.boolean().default(false),
  /** Whether the host is silent; false (not known here). */
  silent: z.boolean().default(false),
  /** When these facts were read (ISO 8601). */
  lastSeen: z.string(),
  // --- local-only extras ---
  /** Fully-qualified domain name (the primary field most callers want). */
  fqdn: z.string().default(""),
  /** Short hostname, without a domain. */
  hostname: z.string().default(""),
  /** Machine architecture (e.g. `x86_64`). */
  arch: z.string().default(""),
});

/** The local host record, as written to the `host` resource. */
export type HostFacts = z.infer<typeof HostSchema>;

const StatusOutputSchema = z.object({
  present: z.boolean(),
  source: z.string(),
  fqdn: z.string(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** The raw values read off the host, before overrides and assembly. */
export interface RawFacts {
  /** `hostname -f` output (may be empty when the host has no FQDN). */
  fqdn: string;
  /** The short hostname (`hostname -s`, or `uname -n`). */
  short: string;
  /** Extra hostnames the host answers to (`hostname -A`). */
  aliases: string[];
  /** OS id: `/etc/os-release` `ID`, or the lowercased `uname -s`. */
  os: string;
  /** Architecture (`uname -m`). */
  arch: string;
  /** Stable machine id, or "". */
  machineId: string;
  /** Local addresses, in order. */
  addresses: string[];
}

/** Options for {@link buildHostFacts}: overrides and the read timestamp. */
export interface BuildOptions {
  /** Override the FQDN; empty uses the detected one. */
  fqdnOverride?: string;
  /** Override the short hostname; empty uses the detected one. */
  hostnameOverride?: string;
  /** Site domain to append to a short hostname (e.g. `fi.gy`). */
  domain?: string;
  /** When the facts were read (ISO 8601); defaults to now. */
  now?: string;
}

/** Trim, drop empties, and de-duplicate (case-insensitively), in order. */
export function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Parse the `ID` value out of an `/etc/os-release` body (or ""). */
export function parseOsRelease(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^ID=(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

/** Normalise a machine id: the first non-empty trimmed line, or "". */
export function parseMachineId(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim();
    if (v) return v;
  }
  return "";
}

/**
 * Choose the FQDN. Precedence:
 *   1. an explicit `override`;
 *   2. the detected `hostname -f` when it is a real, dotted FQDN (not a bare
 *      short name and not `localhost`);
 *   3. `<short>.<domain>` when a site domain is known and the short name has no
 *      dot of its own;
 *   4. the short name.
 * A host that already answers with a dotted FQDN is never re-qualified. Never
 * returns "" (unless every input is empty).
 */
export function chooseFqdn(
  detected: string,
  short: string,
  override = "",
  domain = "",
): string {
  const o = override.trim();
  if (o) return o;
  const d = detected.trim();
  if (d && d.includes(".") && d.toLowerCase() !== "localhost") return d;
  const s = short.trim();
  const dom = domain.trim().replace(/^\.+/, "");
  if (dom && s && !s.includes(".")) return `${s}.${dom}`;
  return s || d;
}

/**
 * Assemble the host record from the raw facts and options. Pure, so the field
 * mapping (including the fleet-inventory alignment) is unit-testable without
 * touching the host.
 */
export function buildHostFacts(
  raw: RawFacts,
  opts: BuildOptions = {},
): HostFacts {
  const short = (opts.hostnameOverride ?? "").trim() || raw.short.trim();
  const fqdn = chooseFqdn(
    raw.fqdn,
    short,
    opts.fqdnOverride ?? "",
    opts.domain ?? "",
  );
  const hostnames = uniqueNonEmpty([fqdn, short, ...raw.aliases]);
  const addresses = uniqueNonEmpty(raw.addresses);
  return {
    name: fqdn || short,
    address: addresses[0] ?? "",
    mac: "",
    machineId: raw.machineId.trim(),
    hostnames,
    addresses,
    macs: [],
    source: "self",
    tier: "",
    os: raw.os.trim().toLowerCase(),
    deviceClass: "",
    vendor: "",
    notes: "",
    probed: true,
    reporting: false,
    silent: false,
    lastSeen: opts.now ?? new Date().toISOString(),
    fqdn,
    hostname: short,
    arch: raw.arch.trim(),
  };
}

// ---------------------------------------------------------------------------
// Platform reads
// ---------------------------------------------------------------------------

/** The injectable side effects of reading the host, so tests can fake them. */
export interface CollectDeps {
  /** Run a command, returning trimmed stdout ("" on any failure). */
  run: (bin: string, args: string[]) => Promise<string>;
  /** Read a text file, returning "" when absent or unreadable. */
  readFile: (path: string) => Promise<string>;
  /** The platform token from `uname -s` (e.g. `Linux`, `Darwin`). */
  uname: string;
}

/** The real dependencies: `Deno.Command` and `Deno.readTextFile`. */
export function defaultDeps(uname = ""): CollectDeps {
  return {
    run: async (bin, args) => {
      try {
        const out = await new Deno.Command(bin, {
          args,
          stdin: "null",
          stdout: "piped",
          stderr: "null",
        }).output();
        return out.code === 0
          ? new TextDecoder().decode(out.stdout).trim()
          : "";
      } catch {
        return "";
      }
    },
    readFile: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch {
        return "";
      }
    },
    uname,
  };
}

/** Read the stable machine id for the current platform, or "". */
async function readMachineId(deps: CollectDeps): Promise<string> {
  if (deps.uname.toLowerCase().startsWith("darwin")) {
    const out = await deps.run("ioreg", [
      "-rd1",
      "-c",
      "IOPlatformExpertDevice",
    ]);
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return m ? m[1] : "";
  }
  const primary = parseMachineId(await deps.readFile("/etc/machine-id"));
  if (primary) return primary;
  return parseMachineId(await deps.readFile("/var/lib/dbus/machine-id"));
}

/** Read the OS id: `/etc/os-release` `ID`, else the lowercased `uname -s`. */
async function readOs(deps: CollectDeps): Promise<string> {
  const id = parseOsRelease(await deps.readFile("/etc/os-release"));
  if (id) return id;
  return deps.uname.trim().toLowerCase();
}

/** Read every raw fact off the host. */
export async function detectRaw(deps: CollectDeps): Promise<RawFacts> {
  const uname = deps.uname || await deps.run("uname", ["-s"]);
  const platform: CollectDeps = { ...deps, uname };

  const fqdn = await platform.run("hostname", ["-f"]);
  const short = (await platform.run("hostname", ["-s"])) ||
    (await platform.run("hostname", [])) ||
    (await platform.run("uname", ["-n"]));
  const aliases = (await platform.run("hostname", ["-A"]))
    .split(/\s+/)
    .filter((s) => s.length > 0);
  const addresses = (await platform.run("hostname", ["-I"]))
    .split(/\s+/)
    .filter((s) => s.length > 0);

  return {
    fqdn,
    short,
    aliases,
    os: await readOs(platform),
    arch: await platform.run("uname", ["-m"]),
    machineId: await readMachineId(platform),
    addresses,
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
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<
    Array<{ content?: unknown; attributes?: unknown; version?: number }>
  >;
}

/** A model that reports the local machine's own identity. */
export const model = {
  type: HOST_FACTS_TYPE,
  version: "2026.10.11.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.11.1",
      description:
        "Initial release: read this host's own facts (FQDN, short hostname, " +
        "machine id, OS, architecture, local addresses) with no network or SSH, " +
        "and write them as one `host` resource whose fields are aligned with " +
        "@svendowideit/fleet-inventory's InventoryHost (name, machineId, " +
        "hostnames, addresses, os, source, tier, probed, lastSeen) plus fqdn / " +
        "hostname / arch. `collect` reads and records; `status` reports whether " +
        "a record exists.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    facts: {
      description:
        "This host's identity: FQDN, hostname, machine id, OS, arch, addresses.",
      schema: HostSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    status: {
      description: "Whether a host record exists, without re-reading.",
      schema: StatusOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    collect: {
      description:
        "Read this host's own facts (FQDN, hostname, machine id, OS, arch, " +
        "addresses) and write them as the `host` resource. No network, no SSH.",
      arguments: CollectArgsSchema,
      execute: async (
        _args: CollectArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const raw = await detectRaw(defaultDeps());
        const facts = buildHostFacts(raw, {
          fqdnOverride: g.fqdnOverride,
          hostnameOverride: g.hostnameOverride,
          domain: g.domain,
        });
        const handle = await ctx.writeResource("facts", "host", facts);
        ctx.logger?.info(
          "host {fqdn} (machine {machineId}, {os}/{arch}, {count} address(es))",
          {
            fqdn: facts.fqdn || facts.hostname,
            machineId: facts.machineId || "unknown",
            os: facts.os || "unknown",
            arch: facts.arch || "unknown",
            count: facts.addresses.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report whether a `host` record already exists, without re-reading the " +
        "host. Useful as a gate before `collect`.",
      arguments: StatusArgsSchema,
      execute: async (
        _args: StatusArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        let present = false;
        let source = "";
        let fqdn = "";
        if (ctx.readModelData) {
          try {
            const rows = await ctx.readModelData(
              ctx.globalArgs.name || "",
              "host",
            );
            const latest = rows?.reduce(
              (a, b) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a),
            );
            const value = (latest?.attributes ?? latest?.content) as
              | Record<string, unknown>
              | undefined;
            if (value) {
              present = true;
              source = String(value["source"] ?? "");
              fqdn = String(value["fqdn"] ?? value["name"] ?? "");
            }
          } catch {
            // no record readable — stays absent.
          }
        }
        const record = {
          present,
          source,
          fqdn,
          checkedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("status", "status", record);
        ctx.logger?.info(
          "host-facts: {state}",
          { state: present ? `present (${fqdn})` : "not collected yet" },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
