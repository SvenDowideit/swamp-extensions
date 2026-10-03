/**
 * @svendowideit/fleet-inventory
 *
 * Keep a live inventory of the hosts on a network: discover them, probe their
 * facts over SSH, correlate them against telemetry, and report drift.
 *
 * It is the "state awareness" backbone: which machines exist, what tier/OS each
 * runs, whether the agent is installed, and — crucially — which inventoried
 * hosts have gone **silent** (no telemetry). Discovery can come from an nmap or
 * mDNS feed (passed in), an optional TCP-connect scan, or manual entries.
 *
 * Pure helpers (CIDR expansion, discovery merge, fact parsing, drift) are
 * exported for unit testing; the methods that scan or SSH do IO.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const HostSchema = z.object({
  name: z.string().describe("Host name (e.g. core.otel.fi.gy)"),
  address: z.string().default("").describe("An IP address for the host"),
  mac: z.string().default("").describe(
    "A MAC address (weak alias, not identity)",
  ),
  machineId: z.string().default("").describe(
    "Stable hardware/OS id (Linux /etc/machine-id, Windows MachineGuid, macOS IOPlatformUUID); strongest identity key when known",
  ),
  hostnames: z.array(z.string()).default([]).describe(
    "Additional hostnames for this host (aliases)",
  ),
  addresses: z.array(z.string()).default([]).describe(
    "Additional IP addresses (e.g. wifi + wired)",
  ),
  source: z.string().default("").describe(
    "Where the host was seen (nmap/mdns/manual)",
  ),
  tier: z.string().default("").describe("Device tier (T0–T4)"),
  os: z.string().default("").describe("Operating system / family"),
  notes: z.string().default("").describe("Free-form notes"),
});

const DiscoverArgsSchema = z.object({
  cidr: z.string().default("").describe(
    "Optional CIDR to TCP-scan (e.g. 192.168.1.0/24); empty skips scanning",
  ),
  ports: z.array(z.number().int().min(1).max(65535)).default([
    22,
    80,
    443,
  ]).describe(
    "TCP ports to probe during the scan (a host is live if any is open)",
  ),
  feeds: z.array(HostSchema).default([]).describe(
    "Hosts discovered by other models (nmap/mdns) to merge into the inventory",
  ),
  timeoutMs: z.number().int().positive().default(1000).describe(
    "Per-connection timeout for the TCP scan",
  ),
  maxHosts: z.number().int().min(0).default(0).describe(
    "Cap on addresses scanned per call; 0 scans the whole CIDR. A /20 is 4094 hosts, which is fine in one call.",
  ),
});

const ProbeArgsSchema = z.object({
  hosts: z.array(z.string()).default([]).describe(
    "Host names/IPs to probe over SSH; empty probes every inventoried host that has not already been probed",
  ),
  sshUser: z.string().default("").describe(
    "SSH user (defaults to the global sshUser)",
  ),
  timeoutMs: z.number().int().positive().default(10000).describe(
    "SSH connect timeout in milliseconds",
  ),
  refresh: z.boolean().default(false).describe(
    "Re-probe hosts that already probed successfully (only meaningful without an explicit hosts list)",
  ),
});

const CorrelateArgsSchema = z.object({
  reportingHosts: z.array(z.string()).default([]).describe(
    "Host names currently reporting telemetry (from the backend query); any inventoried host absent from this list is marked silent",
  ),
});

const ReportArgsSchema = z.object({});

const EnrichArgsSchema = z.object({
  fingerprints: z.array(
    z.object({
      host: z.string().describe("Host name or address the fingerprint is for"),
      deviceClass: z.string().default(""),
      vendor: z.string().default(""),
    }),
  ).min(1).describe(
    "Fingerprint results to apply, e.g. from @svendowideit/device-fingerprint or @svendowideit/mdns",
  ),
});

const GlobalArgsSchema = z.object({
  sshUser: z.string().default("").describe(
    "Default SSH user for probe (e.g. root or admin)",
  ),
  defaultTier: z.string().default("T1").describe(
    "Tier assigned when probing cannot infer one",
  ),
  outputDir: z.string().default("~/.local/share/fleet-inventory").describe(
    "Directory where the inventory JSON is written",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

/**
 * The merged, fully-classified host record — what the `inventory` step owns.
 * Every other step records a SUBSET of this (see `ObservedHostSchema` and
 * `ProbedHostSchema` below) so a raw snapshot never carries fields it cannot
 * fill (which is why `probe` used to show empty deviceClass/vendor/reporting).
 */
const InventoryHostSchema = z.object({
  /** Primary display name (a hostname when known, else an address). */
  name: z.string(),
  /** Primary address (first known). */
  address: z.string(),
  /** Primary MAC (first known). */
  mac: z.string(),
  /** Stable machine id when known (Linux/Windows/macOS), else "". */
  machineId: z.string().default(""),
  /** All hostnames this host is known by. */
  hostnames: z.array(z.string()).default([]),
  /** All addresses this host has been seen at (e.g. wifi + wired). */
  addresses: z.array(z.string()).default([]),
  /** All MACs seen for this host (weak aliases). */
  macs: z.array(z.string()).default([]),
  source: z.string(),
  tier: z.string(),
  os: z.string(),
  /** Device class from fingerprinting (e.g. unifi, esphome, nanokvm) or "". */
  deviceClass: z.string().default(""),
  /** Vendor from fingerprinting (e.g. Ubiquiti, Espressif) or "". */
  vendor: z.string().default(""),
  notes: z.string(),
  probed: z.boolean(),
  reporting: z.boolean(),
  silent: z.boolean(),
  lastSeen: z.string(),
});

/**
 * What the `discover` step records: a host as SEEN on the network (from a scan
 * or a feed). It does not include SSH facts (machineId/tier/os/probed) or
 * fingerprinting classes — those come later, so they are not in this schema.
 */
const ObservedHostSchema = InventoryHostSchema.pick({
  name: true,
  address: true,
  mac: true,
  macs: true,
  hostnames: true,
  addresses: true,
  source: true,
  tier: true,
  os: true,
  lastSeen: true,
});

/**
 * What the `probe` step records: a host plus the facts SSH returned. No MACs
 * (SSH does not collect them) and no fingerprinting/reporting fields.
 */
const ProbedHostSchema = InventoryHostSchema.pick({
  name: true,
  address: true,
  machineId: true,
  hostnames: true,
  addresses: true,
  source: true,
  tier: true,
  os: true,
  probed: true,
  lastSeen: true,
});

const DiscoverOutputSchema = z.object({
  scanned: z.number(),
  /** Whether the CIDR was larger than maxHosts and only part was scanned. */
  truncated: z.boolean().default(false),
  discovered: z.array(ObservedHostSchema),
  discoveredAt: z.string(),
});

const ProbeOutputSchema = z.object({
  /** Hosts whose SSH probe succeeded on THIS run. */
  probed: z.number(),
  /** Hosts in this run's target set. */
  attempted: z.number().default(0),
  /** Already-probed hosts skipped this run (only without an explicit hosts list). */
  skipped: z.number().default(0),
  /** Cumulative hosts ever probed, across runs (the accumulated set). */
  known: z.number().default(0),
  hosts: z.array(ProbedHostSchema),
  probedAt: z.string(),
});

const InventoryOutputSchema = z.object({
  hosts: z.array(InventoryHostSchema),
  total: z.number(),
  reporting: z.number(),
  silent: z.array(z.string()),
  byTier: z.record(z.string(), z.number()),
  byOs: z.record(z.string(), z.number()),
  /** Counts by device class (from fingerprinting), when present. */
  byClass: z.record(z.string(), z.number()).default({}),
  correlatedAt: z.string(),
});

const ReportOutputSchema = z.object({
  total: z.number(),
  reporting: z.number(),
  silent: z.array(z.string()),
  coveragePercent: z.number(),
  byTier: z.record(z.string(), z.number()),
  byOs: z.record(z.string(), z.number()),
  /** Counts by device class, when the inventory has been enriched. */
  byClass: z.record(z.string(), z.number()).default({}),
  /** Explained commands to view the gathered data (also printed by the report). */
  nextCommands: z.string().default(""),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A host record in the fleet inventory. */
export interface InventoryHost {
  /** Primary display name (a hostname when known, else an address). */
  name: string;
  /** Primary address (first known). */
  address: string;
  /** Primary MAC (first known). */
  mac: string;
  /** Stable machine id when known (Linux/Windows/macOS), else "". */
  machineId: string;
  /** All hostnames this host is known by. */
  hostnames: string[];
  /** All addresses this host has been seen at (e.g. wifi + wired). */
  addresses: string[];
  /** All MACs seen for this host (weak aliases). */
  macs: string[];
  /** Where the host was seen (nmap/mdns/manual/scan). */
  source: string;
  /** Device tier (T0–T4). */
  tier: string;
  /** Operating system / family. */
  os: string;
  /** Device class from fingerprinting (e.g. unifi, esphome, nanokvm) or "". */
  deviceClass: string;
  /** Vendor from fingerprinting (e.g. Ubiquiti, Espressif) or "". */
  vendor: string;
  /** Free-form notes. */
  notes: string;
  /** Whether SSH probing succeeded. */
  probed: boolean;
  /** Whether the host is reporting telemetry. */
  reporting: boolean;
  /** Whether the host is inventoried but not reporting. */
  silent: boolean;
  /** Last-seen timestamp. */
  lastSeen: string;
}

/** A discovered host as supplied by a feed or scan. */
export interface HostInput {
  /** Host name (a hostname, or an address for an anonymous scan hit). */
  name: string;
  /** IP address. */
  address: string;
  /** MAC address. */
  mac: string;
  /** Stable machine id when known (strongest identity key). */
  machineId?: string;
  /** Additional hostnames (aliases). */
  hostnames?: string[];
  /** Additional addresses (aliases). */
  addresses?: string[];
  /** Where the host was seen. */
  source: string;
  /** Device tier. */
  tier: string;
  /** Operating system / family. */
  os: string;
  /** Device class from fingerprinting (e.g. unifi, esphome, nanokvm) or "". */
  deviceClass?: string;
  /** Vendor from fingerprinting (e.g. Ubiquiti, Espressif) or "". */
  vendor?: string;
  /** Free-form notes. */
  notes: string;
  /** Whether SSH probing already succeeded for this host (preserved on merge). */
  probed?: boolean;
  /** When this host was last seen/answered (preserved per host on merge). */
  lastSeen?: string;
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

/** Parse a CIDR (`192.168.1.0/24`) into the NETWORK address bytes and prefix. */
export function parseCidr(cidr: string): { base: number; bits: number } {
  const [ip, prefixStr] = cidr.split("/");
  const bits = Number.parseInt(prefixStr ?? "", 10);
  if (!ip || Number.isNaN(bits) || bits < 0 || bits > 32) {
    throw new Error(`Invalid CIDR '${cidr}': expected a.b.c.d/nn`);
  }
  const octets = ip.split(".");
  if (octets.length !== 4) {
    throw new Error(`Invalid CIDR '${cidr}': not an IPv4 address`);
  }
  let addr = 0;
  for (const octet of octets) {
    const n = Number.parseInt(octet, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) {
      throw new Error(`Invalid CIDR '${cidr}': bad octet '${octet}'`);
    }
    addr = (addr << 8) | n;
  }
  // Normalise to the network address: a host address (10.10.15.255/20) and its
  // network (10.10.16.0/20) must scan the same range.
  const hostBits = 32 - bits;
  const mask = hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0;
  return { base: (addr & mask) >>> 0, bits };
}

/** Number to dotted-quad IPv4 string. */
export function numberToIp(n: number): string {
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ].join(".");
}

/**
 * Expand a CIDR to usable host addresses, excluding the network and broadcast
 * addresses for prefixes shorter than /31. `maxHosts` caps the result; 0 (or
 * negative) means no cap (whole range), which is how a /20 or larger is fully
 * scanned. `count` is the true usable size even when capped.
 */
export function expandCidr(
  cidr: string,
  maxHosts = 0,
): { addresses: string[]; count: number; truncated: boolean } {
  const { base, bits } = parseCidr(cidr);
  const size = 2 ** (32 - bits);
  let first: number, last: number;
  if (size <= 2) {
    // /31 and /32 have no reserved network/broadcast pair worth excluding.
    first = base;
    last = base + size - 1;
  } else {
    first = base + 1;
    last = base + size - 2;
  }
  const count = last - first + 1;
  const cap = maxHosts > 0 ? maxHosts : count;
  const addresses: string[] = [];
  for (let i = 0; i < count && addresses.length < cap; i++) {
    addresses.push(numberToIp(first + i));
  }
  return { addresses, count, truncated: addresses.length < count };
}

/** Whether a string looks like an IPv4 address (an address, not a name). */
export function isIpAddress(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

/** Every hostname a discovery input is known by (empty if it is address-only). */
function hostnamesOf(h: HostInput): string[] {
  const out = new Set<string>();
  for (const n of h.hostnames ?? []) if (n) out.add(n);
  if (h.name && !isIpAddress(h.name)) out.add(h.name);
  return [...out];
}

/** Every address a discovery input is known by (IPs only). */
function addressesOf(h: HostInput): string[] {
  const out = new Set<string>();
  for (const a of h.addresses ?? []) if (a && isIpAddress(a)) out.add(a);
  if (h.address && isIpAddress(h.address)) out.add(h.address);
  if (h.name && isIpAddress(h.name)) out.add(h.name);
  return [...out];
}

/** A record is "strong" when it carries a real identity (machine id or name). */
function isStrong(h: HostInput): boolean {
  return !!h.machineId || hostnamesOf(h).length > 0;
}

/**
 * Merge host feeds into one record per machine.
 *
 * Identity precedence: **machine id > hostname > address/MAC**. Records sharing a
 * machine id always merge; records sharing a hostname merge unless they carry
 * two *different* machine ids (duplicate name); and the weak keys (address, MAC)
 * merge only when at least one side is anonymous (no machine id and no name) —
 * so a scan hit (IP only) joins the host that probed that address, but two named
 * hosts that transiently share a MAC (a roaming dock) or an IP (a reused DHCP
 * lease) are NOT glued together.
 */
export function mergeHosts(
  hosts: HostInput[],
  timestamp: string,
): InventoryHost[] {
  const n = hosts.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const buckets = new Map<string, number[]>();
  const add = (key: string, i: number): void => {
    if (!key) return;
    const list = buckets.get(key) ?? [];
    list.push(i);
    buckets.set(key, list);
  };
  for (let i = 0; i < n; i++) {
    const h = hosts[i];
    if (h.machineId) add(`m\u0000${h.machineId}`, i);
    for (const name of hostnamesOf(h)) add(`n\u0000${name.toLowerCase()}`, i);
    for (const addr of addressesOf(h)) add(`a\u0000${addr}`, i);
    if (h.mac) add(`c\u0000${h.mac.toLowerCase()}`, i);
  }

  const canMerge = (kind: string, a: HostInput, b: HostInput): boolean => {
    if (kind === "m") return true;
    if (kind === "n") {
      // Same name, but two different machine ids => two machines (don't merge).
      return !(a.machineId && b.machineId && a.machineId !== b.machineId);
    }
    // Weak keys (address/MAC): only when at least one side is anonymous.
    return !(isStrong(a) && isStrong(b));
  };

  for (const [key, idxs] of buckets) {
    const kind = key[0];
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        if (canMerge(kind, hosts[idxs[x]], hosts[idxs[y]])) {
          union(idxs[x], idxs[y]);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }

  const pick = (vals: string[]): string => vals.find((v) => v) ?? "";
  const uniq = (
    vals: string[],
  ): string[] => [...new Set(vals.filter((v) => v))];
  const merged: InventoryHost[] = [];
  for (const idxs of groups.values()) {
    const hs = idxs.map((i) => hosts[i]);
    const names = uniq(hs.flatMap(hostnamesOf));
    const addresses = uniq(hs.flatMap(addressesOf));
    const macs = uniq(hs.map((h) => h.mac));
    const machineId = pick(hs.map((h) => h.machineId ?? ""));
    const sources = uniq(hs.map((h) => h.source));
    merged.push({
      name: names[0] ?? addresses[0] ?? "",
      address: addresses[0] ?? "",
      mac: macs[0] ?? "",
      machineId,
      hostnames: names,
      addresses,
      macs,
      source: sources.join("+"),
      tier: pick(hs.map((h) => h.tier)),
      os: pick(hs.map((h) => h.os)),
      deviceClass: pick(hs.map((h) => h.deviceClass ?? "")),
      vendor: pick(hs.map((h) => h.vendor ?? "")),
      notes: uniq(hs.map((h) => h.notes)).join("; "),
      probed: hs.some((h) => h.probed),
      reporting: false,
      silent: false,
      // The MOST RECENT contact wins, so each host keeps its own last-seen time
      // instead of the whole set being stamped with the current run.
      lastSeen: hs.map((h) => h.lastSeen ?? "").filter(Boolean).sort().at(-1) ??
        timestamp,
    });
  }
  return merged;
}

/**
 * Infer a device tier from SSH probe facts. Falls back to `defaultTier` when
 * nothing distinguishes the host.
 */
export function inferTier(
  facts: {
    docker?: boolean;
    isContainer?: boolean;
    memTotalMiB?: number;
    immutable?: boolean;
  },
  defaultTier = "T1",
): string {
  if (facts.isContainer) return "T0";
  if (facts.immutable) return "T4";
  if (facts.memTotalMiB !== undefined) {
    if (facts.memTotalMiB <= 4096) return "T2";
    return "T1";
  }
  return defaultTier;
}

/**
 * Parse the output of the SSH probe command (key=value lines) into facts.
 * Keys: hostname, machine_id, os, docker, container, mem_total_mib, immutable.
 */
export function parseProbeFacts(output: string): {
  hostname: string;
  machineId: string;
  os: string;
  docker: boolean;
  isContainer: boolean;
  memTotalMiB?: number;
  immutable: boolean;
} {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const mem = map.get("mem_total_mib");
  return {
    hostname: map.get("hostname") ?? "",
    machineId: map.get("machine_id") ?? "",
    os: map.get("os") ?? "",
    docker: map.get("docker") === "1" || map.get("docker") === "true",
    isContainer: map.get("container") === "1" ||
      map.get("container") === "true",
    memTotalMiB: mem ? Number.parseInt(mem, 10) : undefined,
    immutable: map.get("immutable") === "1" ||
      map.get("immutable") === "true",
  };
}

/**
 * Correlate hosts against the set of reporting hosts, marking silent ones.
 * A host is silent when it is inventoried but not in `reportingHosts`.
 */
export function correlate(
  hosts: InventoryHost[],
  reportingHosts: string[],
  timestamp: string,
): InventoryHost[] {
  const reporting = new Set(reportingHosts.map((h) => h.toLowerCase()));
  return hosts.map((h) => {
    const isReporting = reporting.has(h.name.toLowerCase()) ||
      reporting.has(h.address.toLowerCase());
    return {
      ...h,
      reporting: isReporting,
      silent: !isReporting,
      lastSeen: timestamp,
    };
  });
}

/**
 * Apply fingerprint results to hosts: each host is matched by any of its names
 * or addresses (case-insensitive) and gains the device class/vendor supplied.
 */
export function applyFingerprints(
  hosts: InventoryHost[],
  fingerprints: Array<{ host: string; deviceClass: string; vendor: string }>,
): InventoryHost[] {
  const byKey = new Map<string, { deviceClass: string; vendor: string }>();
  for (const fp of fingerprints) {
    const key = (fp.host || "").toLowerCase();
    if (key) byKey.set(key, { deviceClass: fp.deviceClass, vendor: fp.vendor });
  }
  return hosts.map((h) => {
    const keys = [
      h.name,
      h.address,
      ...(h.hostnames ?? []),
      ...(h.addresses ?? []),
    ];
    for (const k of keys) {
      const hit = byKey.get((k || "").toLowerCase());
      if (hit) {
        return {
          ...h,
          deviceClass: hit.deviceClass || h.deviceClass,
          vendor: hit.vendor || h.vendor,
        };
      }
    }
    return h;
  });
}

/** Tally hosts by a field (tier/os). */
export function tally(
  hosts: InventoryHost[],
  field: "tier" | "os",
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hosts) {
    const key = h[field] || "(unknown)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Coverage percentage (reporting / total, rounded to 2 dp). */
export function coveragePercent(total: number, reporting: number): number {
  if (total === 0) return 0;
  return Math.round((reporting / total) * 10000) / 100;
}

/**
 * The SSH probe script (one key=value line per fact).
 *
 * Portable across Linux and macOS (both POSIX shells): macOS has no
 * `/etc/machine-id`, so its identity is the IOPlatformUUID read via `ioreg`
 * (fast; `system_profiler` fallback), and memory comes from `hw.memsize`.
 * `os` is the Linux `/etc/os-release` ID, or `darwin` on macOS.
 */
export function renderProbeCommand(): string {
  return [
    'echo "hostname=$(uname -n 2>/dev/null || hostname)"',
    'case "$(uname -s 2>/dev/null)" in',
    "Darwin)",
    "  mid=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'\"' '/IOPlatformUUID/{print $4}')",
    "  [ -z \"$mid\" ] && mid=$(system_profiler SPHardwareDataType 2>/dev/null | awk '/UUID/{print $NF}')",
    '  echo "machine_id=$mid"',
    '  echo "os=darwin"',
    "  echo \"mem_total_mib=$(sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1048576)}')\"",
    "  ;;",
    "*)",
    '  echo "machine_id=$(cat /etc/machine-id 2>/dev/null)"',
    "  id=$( (. /etc/os-release 2>/dev/null && printf '%s' \"$ID\") )",
    '  echo "os=$id"',
    "  echo \"mem_total_mib=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null)\"",
    '  echo "immutable=$([ -e /run/ostree-booted ] && echo 1 || echo 0)"',
    "  ;;",
    "esac",
    'echo "docker=$(command -v docker >/dev/null 2>&1 && echo 1 || echo 0)"',
    'echo "container=$([ -f /.dockerenv ] && echo 1 || echo 0)"',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/fleet-inventory`. */
export const model = {
  type: "@svendowideit/fleet-inventory",
  version: "2026.10.03.3",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-config": {
      description: "Validate the inventory output directory and default tier",
      labels: ["policy"],
      appliesTo: ["discover", "probe", "correlate", "report"],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const errors: string[] = [];
        if (!context.globalArgs.outputDir) {
          errors.push("outputDir is required");
        }
        if (!context.globalArgs.defaultTier) {
          errors.push("defaultTier is required");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.01.1",
      description:
        "Initial release: merge nmap/mDNS/manual host feeds with an optional TCP-connect CIDR scan, probe hosts over SSH, correlate against reporting telemetry to find silent hosts, and report coverage by tier/OS.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.1",
      description:
        "Fixes a set of bugs found while running a real /20 sweep. (1) Resources were all written under the instance name 'current', so every read-back returned nothing and specs overwrote each other; each spec now writes under its own instance name (discovery/probe/inventory/report), which fixes accumulation and the downstream reads. (2) discover now ACCUMULATES over the previous discovery (it replaced it each run), so repeated/chunked scans build one inventory. (3) expandCidr no longer caps at 1024 — maxHosts (default 0) scans the whole CIDR, the CIDR is normalised to its network address, and the result reports truncated. (4) The scan no longer leaks file descriptors (timed-out connects are aborted via AbortSignal). (5) probe with no hosts probes every inventoried host and runs with bounded parallelism. (6) correlate preserves the probed flag and probe facts. (7) inferTier honours defaultTier. (8) report reads the inventory RESOURCE, falling back to disk. Default scan ports are now [22,80,443]. Schema is additive (discover gains truncated/maxHosts).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.2",
      description:
        "Host identity is now machine-based, fixing scan/probe double-counting and multi-homed hosts. Each host record gains machineId (Linux /etc/machine-id, Windows MachineGuid, macOS IOPlatformUUID — strongest key), plus alias sets hostnames[], addresses[], macs[]. mergeHosts uses union-find with precedence machine-id > hostname > address/MAC: machine-id matches always merge; same hostname merges unless two different machine ids; address/MAC merge only when at least one record is anonymous, so a scan's IP-only hit joins the host that probed it, while two named hosts sharing a transient IP (DHCP) or MAC (roaming dock) are NOT glued together. One record accumulates all of a machine's addresses, so wifi+wired are one host. probe records machineId first-class. Verified live: a /20 scan + probe now correlates to 47 machines (was 55/53 double-counted). Schema is additive (new fields default).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.3",
      description:
        "probe now ACCUMULATES across runs (it replaced the probed set each time, so re-probing a subset reset the resource). The `probe` resource gains `attempted` (machines targeted this run) and `known` (cumulative probed machines); `probed` is this run's successful-machine count. Counts are now per distinct MACHINE, not per target address, so a multi-homed host that answered twice counts once (previously 15 address successes read as 15 when only 7 machines were probed). README/manifest now explain that omitting `hosts` probes every inventoried host and how to read the cumulative set. Schema is additive.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.4",
      description:
        "probe (no hosts) now SKIPS hosts that already probed successfully, so a repeated run does not re-SSH known-good machines; new `refresh=true` input forces a full re-probe. Hosts that previously FAILED are still retried (they may have come online). Each host keeps its own `lastSeen` (most-recent contact) instead of the whole set sharing the run timestamp. The run log now spells out attempted/probed/skipped/known and explains why a run may probe 0 successfully. The `probe` resource gains `skipped`. Schema is additive.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.5",
      description:
        "The probe script is now portable across Linux and macOS (was Linux-only). macOS hosts have no /etc/machine-id, so the probe reads their IOPlatformUUID via `ioreg` (fast; `system_profiler` fallback) and total memory via `hw.memsize`; Linux keeps /etc/machine-id / /etc/os-release / /proc/meminfo. `hostname` uses `uname -n`. `os` is the Linux os-release ID (e.g. debian) or `darwin` on macOS. Verified against a real macOS host: it now reports a stable machine id and merges by identity instead of only by name. No schema or argument changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.6",
      description:
        "Clarifies correlate with no reportingHosts: it still builds the inventory (the discovery+probe merge) but now logs plainly that all hosts are listed silent only because no reporting set was supplied, instead of a bare '0 reporting, N silent' that reads like real drift. README adds a note that the reporting-host feed is a telemetry-backend query deferred to Phase 1 (it needs a running store); no behaviour or schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.7",
      description:
        "Manifest RUN examples for correlate and report now say plainly that a meaningful silent/coverage result needs the reporting-host set, which is a telemetry-backend query DEFERRED to Phase 1 (no store running yet): correlate still builds the inventory, and report's tier/OS tallies work now, but coverage stays 0% and all hosts read silent without the feed. Documentation only — no behaviour or schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.03.1",
      description:
        "Adds an `enrich` method that merges device-fingerprint results into the inventory: each host gains `deviceClass` and `vendor`, matched by any of its names/addresses, from @svendowideit/device-fingerprint (HTTP/TLS, MAC/OUI) or @svendowideit/mdns. The inventory resource and inventory.json gain a `byClass` tally. Host records gain deviceClass/vendor fields (defaulted). Verified live: 21 of 47 hosts classified (openwrt, unifi, nanokvm, shelly, web-server) from a real /20 sweep.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.03.2",
      description:
        "Each step now records only the fields it actually fills: `discover` writes observed hosts (name/address/mac(s)/hostnames/addresses/source/tier/os/lastSeen) and `probe` writes probed hosts (name/address/machineId/hostnames/addresses/source/tier/os/probed/lastSeen) — so a raw snapshot no longer shows consistently-empty deviceClass/vendor/reporting/silent fields that only `inventory` fills. Adds a workflow-scope report `@svendowideit/fleet-inventory-report`, printed at the end of a sweep: a summary (hosts, tiers, OS, device classes) plus explained commands to view the data. The `report` resource gains `byClass` and `nextCommands`. Schema change to discovery/probe host shapes (breaking for a consumer reading those exact keys, but the extension is unpublished).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.03.3",
      description:
        "The end-of-sweep summary now fits one screen (~16 lines, was ~52): breakdowns are compact one-liners and the view commands are a terse, commented block inside a fenced code block, so renderers keep them verbatim instead of reflowing the comments into a blank-line-separated mess. Also drops the now-redundant 'report search' line. Content only; no schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    discovery: {
      description: "Discovered hosts",
      schema: DiscoverOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    probe: {
      description: "SSH-probed host facts",
      schema: ProbeOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    inventory: {
      description: "Correlated fleet inventory",
      schema: InventoryOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    report: {
      description: "Fleet coverage report",
      schema: ReportOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Merge host feeds (nmap/mdns/manual) with an optional TCP-connect CIDR scan",
      arguments: DiscoverArgsSchema,
      execute: async (
        args: z.infer<typeof DiscoverArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource?: (name: string) => Promise<unknown>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const timestamp = new Date().toISOString();
        const feed: HostInput[] = args.feeds.map((f) => ({
          name: f.name,
          address: f.address,
          mac: f.mac,
          source: f.source || "feed",
          tier: f.tier,
          os: f.os,
          notes: f.notes,
        }));

        let scanned = 0;
        let truncated = false;
        if (args.cidr) {
          const expanded = expandCidr(args.cidr, args.maxHosts);
          const ips = expanded.addresses;
          scanned = ips.length;
          truncated = expanded.truncated;
          if (truncated) {
            context.logger?.info(
              "CIDR has {count} usable hosts; scanning the first {scanned} (raise maxHosts or scan in chunks — results accumulate)",
              { count: expanded.count, scanned },
            );
          }
          const live = await scanHosts(ips, args.ports, args.timeoutMs);
          for (const address of live) {
            feed.push({
              name: address,
              address,
              mac: "",
              machineId: "",
              hostnames: [],
              addresses: [address],
              source: "scan",
              tier: "",
              os: "",
              notes: "",
            });
          }
        }

        // Accumulate: merge this call's feed/scan over what was already
        // discovered, so repeated scans of different chunks build one inventory
        // instead of each replacing the last.
        const previous = await readPrevious(context, "discovery");
        const combined = [
          ...previous.map((h) => toInput(h, "discover")),
          ...feed,
        ];
        const hosts = mergeHosts(combined, timestamp);
        context.logger?.info(
          "Discovered {count} host(s) ({scanned} scanned, {previous} previously known)",
          { count: hosts.length, scanned, previous: previous.length },
        );
        const handle = await context.writeResource("discovery", "discovery", {
          scanned,
          truncated,
          discovered: hosts.map(projectObserved),
          discoveredAt: timestamp,
        });
        return { dataHandles: [handle] };
      },
    },

    probe: {
      description:
        "SSH into hosts and collect facts (hostname, OS, docker, memory)",
      arguments: ProbeArgsSchema,
      execute: async (
        args: z.infer<typeof ProbeArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource?: (name: string) => Promise<unknown>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const user = args.sshUser || g.sshUser;
        const timestamp = new Date().toISOString();
        // With no explicit hosts, probe everything already inventoried (from the
        // latest discovery, else the last inventory) that has NOT already been
        // probed successfully — re-probing known-good hosts every run is wasted
        // work. `refresh=true` forces a full re-probe.
        let targets = args.hosts;
        let skipped = 0;
        if (targets.length === 0) {
          const discovered = await readPrevious(context, "discovery");
          const inventory = await readPrevious(context, "inventory");
          const probedOk = new Set<string>();
          if (!args.refresh) {
            for (const h of await readPrevious(context, "probe")) {
              if (!h.probed) continue;
              for (const key of [h.name, h.address, ...(h.addresses ?? [])]) {
                if (key) probedOk.add(key.toLowerCase());
              }
            }
          }
          const seen = new Set<string>();
          targets = [];
          for (const h of [...discovered, ...inventory]) {
            const t = h.name || h.address || "";
            if (!t || seen.has(t)) continue;
            seen.add(t);
            if (!args.refresh && probedOk.has(t.toLowerCase())) {
              skipped++;
              continue;
            }
            targets.push(t);
          }
        }

        // Probe in bounded parallel batches: sequential SSH to hundreds of hosts
        // is far too slow, and an unbounded fan-out would exhaust file handles.
        const results: InventoryHost[] = await mapWithConcurrency(
          targets,
          16,
          async (target) => {
            const facts = await sshProbe(target, user, args.timeoutMs);
            // Record the probed hostname and address together, and the machine
            // id as first-class identity (not buried in notes) so it can merge
            // the scan's IP-only record with this named host.
            const hostname = facts?.hostname || "";
            const isIp = isIpAddress(target);
            return {
              name: hostname || target,
              address: isIp ? target : "",
              mac: "",
              machineId: facts?.machineId ?? "",
              hostnames: hostname ? [hostname] : [],
              addresses: isIp ? [target] : [],
              macs: [],
              source: "probe",
              tier: facts ? inferTier(facts, g.defaultTier) : g.defaultTier,
              os: facts?.os ?? "",
              deviceClass: "",
              vendor: "",
              notes: "",
              probed: facts !== null,
              reporting: false,
              silent: false,
              lastSeen: timestamp,
            };
          },
        );

        // Accumulate: merge this run's probe results over everything probed
        // before, so the resource is the cumulative set (a re-probe updates a
        // host's facts rather than resetting to just this run).
        const previousProbe = await readPrevious(context, "probe");
        const combinedProbe = mergeHosts(
          [
            ...previousProbe.map((h) => toInput(h, "probe")),
            ...results,
          ],
          timestamp,
        );
        // Count DISTINCT MACHINES, not target addresses: a multi-homed host
        // answered at several addresses but is one machine, so the raw success
        // count would overstate. Merge just this run's results for that number.
        const runMerged = mergeHosts(results, timestamp);
        const attempted = runMerged.length;
        const probedThisRun = runMerged.filter((h) => h.probed).length;
        const known = combinedProbe.filter((h) => h.probed).length;
        const skippedNote = skipped > 0
          ? `, ${skipped} already-probed skipped`
          : "";
        context.logger?.info(
          "Probed {probed}/{attempted} machine(s); {known} known probed{skippedNote}. " +
            "{attemptedNote}",
          {
            probed: probedThisRun,
            attempted,
            known,
            skippedNote,
            attemptedNote: probedThisRun === 0 && attempted > 0
              ? "None answered this run (unreachable hosts are retried next time; only successful hosts are skipped)."
              : "Run-level counts differ from 'known' (cumulative) on purpose.",
          },
        );
        const handle = await context.writeResource("probe", "probe", {
          probed: probedThisRun,
          attempted,
          skipped,
          known,
          hosts: combinedProbe.map(projectProbed),
          probedAt: timestamp,
        });
        return { dataHandles: [handle] };
      },
    },

    correlate: {
      description:
        "Merge discovery + probe into the inventory and mark silent (non-reporting) hosts",
      arguments: CorrelateArgsSchema,
      execute: async (
        args: z.infer<typeof CorrelateArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource?: (name: string) => Promise<unknown>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const timestamp = new Date().toISOString();
        const discovered = await readPrevious(context, "discovery");
        const probed = await readPrevious(context, "probe");

        // Probe facts take precedence (they carry OS/tier), then discovery.
        const merged = mergeHosts(
          [
            ...discovered.map((h) => toInput(h, "discover")),
            ...probed.map((h) => toInput(h, "probe")),
          ],
          timestamp,
        );
        const withReporting = correlate(merged, args.reportingHosts, timestamp);
        const silent = withReporting.filter((h) => h.silent).map((h) => h.name);

        const payload = {
          hosts: withReporting,
          total: withReporting.length,
          reporting: withReporting.filter((h) => h.reporting).length,
          silent,
          byTier: tally(withReporting, "tier"),
          byOs: tally(withReporting, "os"),
          correlatedAt: timestamp,
        };
        await writeInventory(context.globalArgs.outputDir, payload);
        // With no reportingHosts the silent list is meaningless: every host is
        // "silent" simply because nothing was declared as reporting. Say so,
        // so the inventory (the merge) is still useful but the silent count is
        // not misread as real drift.
        if (args.reportingHosts.length === 0) {
          context.logger?.info(
            "Built inventory of {total} host(s); no reportingHosts given, so all {silent} are listed silent by default — supply the reporting set (e.g. from a backend query) to detect genuinely silent hosts.",
            { total: payload.total, silent: silent.length },
          );
        } else {
          context.logger?.info(
            "Correlated {total} host(s): {reporting} reporting, {silent} silent",
            {
              total: payload.total,
              reporting: payload.reporting,
              silent: silent.length,
            },
          );
        }
        const handle = await context.writeResource(
          "inventory",
          "inventory",
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    report: {
      description:
        "Summarise the fleet inventory: coverage, tiers, and silent hosts",
      arguments: ReportArgsSchema,
      execute: async (
        _args: z.infer<typeof ReportArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          readResource?: (name: string) => Promise<unknown>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const timestamp = new Date().toISOString();
        // Prefer the inventory RESOURCE (the source of truth); fall back to the
        // on-disk convenience copy only if the resource is unavailable.
        let hosts: InventoryHost[] = [];
        try {
          const stored = await context.readResource?.("inventory") as
            | { hosts?: InventoryHost[] }
            | null;
          if (stored?.hosts) hosts = stored.hosts;
        } catch {
          // fall through to disk
        }
        if (hosts.length === 0) {
          const inventory = await readInventory(context.globalArgs.outputDir);
          hosts = inventory?.hosts ?? [];
        }
        const total = hosts.length;
        const reporting = hosts.filter((h) => h.reporting).length;
        const byClass: Record<string, number> = {};
        for (const h of hosts) {
          if (h.deviceClass) {
            byClass[h.deviceClass] = (byClass[h.deviceClass] ?? 0) + 1;
          }
        }
        const handle = await context.writeResource("report", "report", {
          total,
          reporting,
          silent: hosts.filter((h) => h.silent).map((h) => h.name),
          coveragePercent: coveragePercent(total, reporting),
          byTier: tally(hosts, "tier"),
          byOs: tally(hosts, "os"),
          byClass,
          nextCommands: renderNextCommands(),
          generatedAt: timestamp,
        });
        return { dataHandles: [handle] };
      },
    },

    enrich: {
      description:
        "Apply device-fingerprint results (device class + vendor per host) to the inventory",
      arguments: EnrichArgsSchema,
      execute: async (
        args: z.infer<typeof EnrichArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource?: (name: string) => Promise<unknown>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const timestamp = new Date().toISOString();
        const discovered = await readPrevious(context, "discovery");
        const probed = await readPrevious(context, "probe");
        const merged = mergeHosts(
          [
            ...discovered.map((h) => toInput(h, "discover")),
            ...probed.map((h) => toInput(h, "probe")),
          ],
          timestamp,
        );
        // Preserve the reporting/silent plane from the current inventory, so
        // enriching does not silently reset a prior correlate. Matched by name
        // or address.
        const prior = await readInventory(context.globalArgs.outputDir);
        const reporting = new Set<string>();
        if (prior?.hosts) {
          for (const h of prior.hosts) {
            if (!h.reporting) continue;
            for (
              const k of [
                h.name,
                h.address,
                ...(h.hostnames ?? []),
                ...(h.addresses ?? []),
              ]
            ) {
              if (k) reporting.add(k.toLowerCase());
            }
          }
        }
        const withReporting = merged.map((h) => {
          const isReporting = [
            h.name,
            h.address,
            ...(h.hostnames ?? []),
            ...(h.addresses ?? []),
          ]
            .some((k) => k && reporting.has(k.toLowerCase()));
          return { ...h, reporting: isReporting, silent: !isReporting };
        });
        // Apply the fingerprint map: match a fingerprint host to an inventory
        // host by any of its names or addresses.
        const applied = applyFingerprints(withReporting, args.fingerprints);
        const byClass: Record<string, number> = {};
        for (const h of applied) {
          if (h.deviceClass) {
            byClass[h.deviceClass] = (byClass[h.deviceClass] ?? 0) + 1;
          }
        }
        const withClass = applied.filter((h) => h.deviceClass).length;
        context.logger?.info(
          "Enriched {withClass}/{total} host(s) with a device class",
          { withClass, total: applied.length },
        );
        const handle = await context.writeResource("inventory", "inventory", {
          hosts: applied,
          total: applied.length,
          reporting: applied.filter((h) => h.reporting).length,
          silent: applied.filter((h) => h.silent).map((h) => h.name),
          byTier: tally(applied, "tier"),
          byOs: tally(applied, "os"),
          byClass,
          correlatedAt: timestamp,
        });
        await writeInventory(context.globalArgs.outputDir, {
          hosts: applied,
          total: applied.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Project a merged host to the fields the `discover` step records (observed
 * only — no SSH facts, no classes).
 */
function projectObserved(h: InventoryHost): Record<string, unknown> {
  return {
    name: h.name,
    address: h.address,
    mac: h.mac,
    macs: h.macs,
    hostnames: h.hostnames,
    addresses: h.addresses,
    source: h.source,
    tier: h.tier,
    os: h.os,
    lastSeen: h.lastSeen,
  };
}

/** Project a merged host to the fields the `probe` step records. */
function projectProbed(h: InventoryHost): Record<string, unknown> {
  return {
    name: h.name,
    address: h.address,
    machineId: h.machineId,
    hostnames: h.hostnames,
    addresses: h.addresses,
    source: h.source,
    tier: h.tier,
    os: h.os,
    probed: h.probed,
    lastSeen: h.lastSeen,
  };
}

/**
 * The explained commands to view the data a sweep gathered, so the user only
 * dives deeper when something looks wrong. Kept terse (one line each) and
 * returned WITHOUT a code fence so the caller can place it inside one —
 * the report puts it in a fenced block so renderers keep it verbatim.
 */
export function renderNextCommands(): string {
  return [
    "# inventory totals + tier/OS/device-class breakdowns",
    "swamp data get fleet inventory --json | jq -c '.content | {total,reporting,byTier,byOs,byClass}'",
    "# every host: names, addresses, machine id, tier, OS, device class",
    "swamp data get fleet inventory --json | jq -c '.content.hosts[] | {name,addresses,machineId,tier,os,deviceClass}'",
    "# machines we SSH-probed (known = cumulative; attempted/skipped = this run)",
    "swamp data get fleet probe --json | jq -c '.content | {probed,attempted,skipped,known}'",
    "# the raw liveness scan (use when an expected host is missing)",
    "swamp data get fleet discovery --json | jq -c '.content | {scanned,n:(.discovered|length)}'",
    "# HTTP/TLS fingerprints for identified hosts",
    "swamp data get fleet-fingerprint current --json | jq -c '.content.hosts[] | select(.deviceClass!=\"\") | {host,deviceClass,vendor}'",
    "# re-print this summary",
    "swamp report get @svendowideit/fleet-inventory-report --workflow @svendowideit/fleet-inventory-sweep --markdown",
  ].join("\n");
}

/** Convert a stored host record back to a merge input. */
function toInput(
  h: Partial<InventoryHost>,
  source: string,
): HostInput {
  return {
    name: h.name ?? "",
    address: h.address ?? "",
    mac: h.mac ?? "",
    machineId: h.machineId ?? "",
    hostnames: h.hostnames ?? [],
    addresses: h.addresses ?? [],
    source: h.source || source,
    tier: h.tier ?? "",
    os: h.os ?? "",
    deviceClass: h.deviceClass ?? "",
    vendor: h.vendor ?? "",
    notes: h.notes ?? "",
    probed: h.probed ?? false,
    lastSeen: h.lastSeen ?? "",
  };
}

/** Read the latest version of a named resource from context, if available. */
async function readPrevious(
  context: { readResource?: (name: string) => Promise<unknown> },
  specName: string,
): Promise<Array<Partial<InventoryHost>>> {
  if (!context.readResource) return [];
  try {
    const data = await context.readResource(specName) as
      | { discovered?: unknown; hosts?: unknown }
      | null;
    if (!data) return [];
    const list = specName === "discovery" ? data.discovered : data.hosts;
    return Array.isArray(list) ? (list as Array<Partial<InventoryHost>>) : [];
  } catch {
    return [];
  }
}

/** Write the inventory JSON to disk (best-effort; ignores fs errors). */
async function writeInventory(
  outputDir: string,
  payload: unknown,
): Promise<void> {
  try {
    const dir = expandHome(outputDir);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/inventory.json`,
      JSON.stringify(payload, null, 2) + "\n",
    );
  } catch {
    // The resource is the source of truth; the on-disk copy is a convenience.
  }
}

/** Read the inventory JSON from disk, if it exists. */
async function readInventory(
  outputDir: string,
): Promise<{ hosts?: InventoryHost[] } | null> {
  try {
    const dir = expandHome(outputDir);
    return JSON.parse(await Deno.readTextFile(`${dir}/inventory.json`));
  } catch {
    return null;
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving the
 * input order in the result. Used to probe many hosts without a serial crawl or
 * an unbounded fan-out.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * TCP-connect scan: return the addresses with at least one open port.
 *
 * Each connect carries an AbortSignal so a timed-out attempt is aborted and its
 * socket closed; without that, hosts that hang (firewalled) leak a file
 * descriptor each and a large sweep runs the process out of FDs.
 */
function scanHosts(
  ips: string[],
  ports: number[],
  timeoutMs: number,
  concurrency = 64,
): Promise<string[]> {
  return mapWithConcurrency(ips, concurrency, async (ip) => {
    for (const port of ports) {
      try {
        const conn = await Deno.connect({
          hostname: ip,
          port,
          signal: AbortSignal.timeout(timeoutMs),
        });
        try {
          conn.close();
        } catch {
          // ignore
        }
        return ip; // live: any listed port accepted a connection
      } catch {
        // refused/timed-out/aborted: try the next port
      }
    }
    return null;
  }).then((results) => results.filter((ip): ip is string => ip !== null));
}

/** SSH into a host and run the probe script, returning facts or null. */
async function sshProbe(
  target: string,
  user: string,
  timeoutMs: number,
): Promise<ReturnType<typeof parseProbeFacts> | null> {
  const dest = user ? `${user}@${target}` : target;
  try {
    const proc = new Deno.Command("ssh", {
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
        dest,
        renderProbeCommand(),
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    if (out.code !== 0) return null;
    return parseProbeFacts(new TextDecoder().decode(out.stdout));
  } catch {
    return null;
  }
}
