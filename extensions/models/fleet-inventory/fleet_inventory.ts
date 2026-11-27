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
  sshUser: z.string().optional().describe(
    "SSH user for THIS host; overrides the model global, and is itself overridden by a run-level sshUser. Omit to inherit",
  ),
  sshPort: z.number().int().min(0).max(65535).optional().describe(
    "SSH port for THIS host; omit to inherit the model global, which falls back to ssh's own default of 22",
  ),
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

/**
 * One feed entry as a merge input. Every identity field the feed declares is
 * carried: dropping `machineId`, `hostnames` or `addresses` here made a feed
 * unable to correct a record discovery had already stored, so an operator could
 * not say "this entry is that machine" (nor record the hostname the box reports,
 * nor the login it accepts).
 */
export function feedHost(f: z.infer<typeof HostSchema>): HostInput {
  return {
    name: f.name,
    address: f.address,
    mac: f.mac,
    machineId: f.machineId ?? "",
    hostnames: f.hostnames ?? [],
    addresses: f.addresses ?? [],
    source: f.source || "feed",
    tier: f.tier,
    os: f.os,
    sshUser: f.sshUser ?? "",
    sshPort: f.sshPort ?? 0,
    notes: f.notes,
  };
}

const ProbeArgsSchema = z.object({
  hosts: z.array(z.string()).default([]).describe(
    "Host names/IPs to probe over SSH; empty probes every inventoried host that has not already been probed",
  ),
  sshUser: z.string().default("").describe(
    "SSH user for EVERY host in this run: overrides each host's own sshUser and the model global. Empty keeps the host's, then the global's",
  ),
  sshPort: z.number().int().min(0).max(65535).optional().describe(
    "SSH port for EVERY host in this run: overrides each host's own sshPort and the model global. Omit to keep the host's, then the global's, then 22",
  ),
  timeoutMs: z.number().int().positive().default(10000).describe(
    "SSH connect timeout in milliseconds",
  ),
  refresh: z.boolean().default(false).describe(
    "Re-probe hosts that already probed successfully (only meaningful without an explicit hosts list)",
  ),
  fallbackUsers: z.array(z.string()).default([]).describe(
    "Extra SSH users to try, in order, when the resolved user is refused (empty uses the model global `fallbackUsers`). The user that works is recorded on the host",
  ),
});

const CorrelateArgsSchema = z.object({
  reportingHosts: z.array(z.string()).default([]).describe(
    "Host names currently reporting telemetry (from the backend query); any inventoried host absent from this list is marked silent",
  ),
});

const NetworkArgsSchema = z.object({
  domains: z.array(z.string()).default([]).describe(
    'Domains to look a host up in, e.g. ["home.org.au"]. For each host the ' +
      "model resolves <host>.<domain> and records whether it reaches an address " +
      "the host reports. Add every domain you use; nothing is hardcoded.",
  ),
  discoverDomains: z.boolean().default(true).describe(
    "Also treat every installed @svendowideit/caddy model's baseDomain as a " +
      "swamp-managed domain (fi.gy, and any future zone swamp serves), so the " +
      "index distinguishes swamp DNS from domains swamp does not own.",
  ),
  resolveDns: z.boolean().default(true).describe(
    "Resolve each host's names on the controller (getent) and flag names that " +
      "do not reach any address the host reports. Costs one lookup per name.",
  ),
  dnsTimeoutMs: z.number().int().positive().default(3000).describe(
    "Per-name DNS timeout.",
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
    "Default SSH user for hosts that record no sshUser of their own (e.g. root or admin). Leave it empty to require every host to carry its own",
  ),
  sshPort: z.number().int().min(0).max(65535).optional().describe(
    "Default SSH port for hosts that record no sshPort of their own; omit to leave the choice to ssh (port 22)",
  ),
  defaultTier: z.string().default("T1").describe(
    "Tier assigned when probing cannot infer one",
  ),
  outputDir: z.string().default("~/.local/share/fleet-inventory").describe(
    "Directory where the inventory JSON is written",
  ),
  fallbackUsers: z.array(z.string()).default(["pi"]).describe(
    "SSH users tried in order when the resolved user is refused — the appliance logins a fleet actually has (a Raspberry Pi that only accepts `pi`, an image whose only account is `admin`). The user that answers is recorded on the host, so later runs try it first",
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
const InterfaceSchema = z.object({
  /** Interface name as the host reports it (eno4, wlp0s20f3, tailscale0, br-…). */
  name: z.string(),
  /** MAC address, or "" for interfaces without one (tailscale, tun). */
  mac: z.string().default(""),
  /** Whether the kernel exposes /sys/class/net/<if>/device (a real NIC). */
  physical: z.boolean().default(false),
  /** ethernet | wifi | vpn | bridge | virtual | loopback | unknown. */
  kind: z.string().default("unknown"),
  /** IPv4 configuration method the host reports (manual/auto/disabled/unknown). */
  method: z.string().default(""),
  /** Every address on this interface, CIDR form. */
  addresses: z.array(z.string()).default([]),
});

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
  /** Interfaces this host reported, physical and software-defined. */
  interfaces: z.array(InterfaceSchema).default([]),
  /** Address -> static | dhcp | unknown, as the host configures it. */
  addressKinds: z.record(z.string(), z.string()).default({}),
  /** DNS search domains the host got from DHCP / its resolver (e.g. home.org.au). */
  searchDomains: z.array(z.string()).default([]),
  /** Which candidate (address or name) actually answered the probe, if probed. */
  reachedVia: z.string().default(""),
  /** Stored addresses the host itself did not report (stale inventory data). */
  addressDrift: z.array(z.string()).default([]),
  source: z.string(),
  tier: z.string(),
  os: z.string(),
  /** SSH user to use for this host; empty falls back to the model global. */
  sshUser: z.string().default(""),
  /** SSH port to use for this host; 0 falls back to the global, then 22. */
  sshPort: z.number().int().min(0).max(65535).default(0),
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
  sshUser: true,
  sshPort: true,
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
  macs: true,
  interfaces: true,
  addressKinds: true,
  searchDomains: true,
  reachedVia: true,
  source: true,
  tier: true,
  os: true,
  sshUser: true,
  sshPort: true,
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

const NetworkMacSchema = z.object({
  mac: z.string(),
  hosts: z.array(z.string()).default([]),
  interfaces: z.array(z.string()).default([]),
  firstSeen: z.string().default(""),
  lastSeen: z.string().default(""),
  /** True when this MAC has been seen on more than one host (USB NIC, dock). */
  moved: z.boolean().default(false),
});

const NetworkAddressSchema = z.object({
  address: z.string(),
  host: z.string(),
  interface: z.string().default(""),
  /** static | dhcp | dhcp-pinned | dhcp-dynamic | unknown */
  kind: z.string().default("unknown"),
  firstSeen: z.string().default(""),
  lastSeen: z.string().default(""),
});

const NetworkDnsNameSchema = z.object({
  /** The domain, or "" for the host's bare name. */
  domain: z.string().default(""),
  name: z.string(),
  swampManaged: z.boolean().default(false),
  addresses: z.array(z.string()).default([]),
  /** Whether any resolved address is one the host itself reports. */
  matchesHost: z.boolean().default(false),
});

const NetworkHostSchema = z.object({
  host: z.string(),
  addresses: z.array(z.string()).default([]),
  addressDrift: z.array(z.string()).default([]),
  physicalNics: z.number().default(0),
  softwareInterfaces: z.number().default(0),
  dnsNames: z.array(z.string()).default([]),
  dnsAddresses: z.array(z.string()).default([]),
  dnsMismatch: z.boolean().default(false),
  /** One entry per domain (and the bare name) this host was looked up in. */
  dns: z.array(NetworkDnsNameSchema).default([]),
});

const NetworkOutputSchema = z.object({
  hosts: z.array(NetworkHostSchema),
  domains: z.array(z.object({
    domain: z.string(),
    swampManaged: z.boolean().default(false),
    /** swamp | dhcp | configured */
    source: z.string().default(""),
  })).default([]),
  macs: z.array(NetworkMacSchema),
  addresses: z.array(NetworkAddressSchema),
  dnsMismatches: z.array(z.object({
    host: z.string(),
    name: z.string(),
    resolved: z.array(z.string()).default([]),
    reported: z.array(z.string()).default([]),
  })).default([]),
  byKind: z.record(z.string(), z.number()).default({}),
  summary: z.object({
    hosts: z.number(),
    physicalNics: z.number(),
    softwareInterfaces: z.number(),
    macs: z.number(),
    movedMacs: z.number(),
    dnsMismatches: z.number(),
    hostsWithDrift: z.number(),
    hostsWithNoDns: z.number().default(0),
    staleNames: z.number().default(0),
  }),
  generatedAt: z.string(),
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
  /** Network index summary (from the `network` method, when it has run). */
  physicalNics: z.number().default(0),
  macs: z.number().default(0),
  movedMacs: z.number().default(0),
  dnsMismatches: z.number().default(0),
  hostsWithDrift: z.number().default(0),
  byAddressKind: z.record(z.string(), z.number()).default({}),
  /** Domains the inventory looked hosts up in. */
  domains: z.array(z.object({
    domain: z.string(),
    swampManaged: z.boolean().default(false),
    source: z.string().default(""),
  })).default([]),
  hostsWithNoDns: z.number().default(0),
  staleNames: z.number().default(0),
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
  /** Interfaces this host reported, physical and software-defined. */
  interfaces: Array<z.infer<typeof InterfaceSchema>>;
  /** Address -> static | dhcp | unknown, as the host configures it. */
  addressKinds: Record<string, string>;
  /** DNS search domains the host got from DHCP / its resolver. */
  searchDomains: string[];
  /** Which candidate (address or name) answered the probe, when probed. */
  reachedVia: string;
  /** Stored addresses the host itself did not report (stale inventory data). */
  addressDrift: string[];
  /** Where the host was seen (nmap/mdns/manual/scan). */
  source: string;
  /** Device tier (T0–T4). */
  tier: string;
  /** Operating system / family. */
  os: string;
  /** SSH user recorded for this host (empty = fall back to the model global). */
  sshUser?: string;
  /** SSH port recorded for this host (0 = fall back to the global, then 22). */
  sshPort?: number;
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
  /** SSH user recorded FOR THIS HOST (empty = fall back to the model global). */
  sshUser?: string;
  /** SSH port recorded FOR THIS HOST (0 = fall back to the global, then 22). */
  sshPort?: number;
  /** Device class from fingerprinting (e.g. unifi, esphome, nanokvm) or "". */
  deviceClass?: string;
  /** Vendor from fingerprinting (e.g. Ubiquiti, Espressif) or "". */
  vendor?: string;
  /** Free-form notes. */
  notes: string;
  /** Whether SSH probing already succeeded for this host (preserved on merge). */
  probed?: boolean;
  /** Interfaces reported by an SSH probe (physical and software-defined). */
  interfaces?: Array<z.infer<typeof InterfaceSchema>>;
  /** DNS search domains reported by the host. */
  searchDomains?: string[];
  /** Which candidate (address or name) actually answered the probe. */
  reachedVia?: string;
  /** Address -> static | dhcp | unknown. */
  addressKinds?: Record<string, string>;
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
/** Union interfaces by name, keeping the richest observation of each. */
export function mergeInterfaces(
  all: Array<z.infer<typeof InterfaceSchema>>,
): Array<z.infer<typeof InterfaceSchema>> {
  const byName = new Map<string, z.infer<typeof InterfaceSchema>>();
  for (const i of all) {
    const prev = byName.get(i.name);
    if (!prev) {
      byName.set(i.name, { ...i, addresses: [...new Set(i.addresses)] });
      continue;
    }
    byName.set(i.name, {
      name: i.name,
      mac: i.mac || prev.mac,
      physical: prev.physical || i.physical,
      // the later observation is the current truth; only fall back when it is
      // less informative than what we already had
      kind: i.kind !== "unknown" ? i.kind : prev.kind,
      method: i.method && i.method !== "unknown" ? i.method : prev.method,
      addresses: [...new Set([...prev.addresses, ...i.addresses])],
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Address -> kind map derived from the host's own interface configuration. */
export function addressKindsOf(
  interfaces: Array<z.infer<typeof InterfaceSchema>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of interfaces) {
    const kind = addressKindFor(i.method);
    for (const a of i.addresses) {
      const addr = a.split("/")[0];
      // loopback and IPv6 link-local never identify a host across the fleet
      if (
        addr.startsWith("127.") || addr === "::1" || addr.startsWith("fe80:")
      ) {
        continue;
      }
      out[addr] = kind;
    }
  }
  return out;
}

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
      macs: uniq([
        ...macs,
        ...hs.flatMap((h) => h.interfaces ?? []).map((i) => i.mac),
      ]),
      interfaces: mergeInterfaces(hs.flatMap((h) => h.interfaces ?? [])),
      addressKinds: Object.assign(
        {},
        ...hs.map((h) => h.addressKinds ?? {}),
        addressKindsOf(hs.flatMap((h) => h.interfaces ?? [])),
      ),
      addressDrift: [],
      searchDomains: uniq(hs.flatMap((h) => h.searchDomains ?? [])),
      reachedVia: pick(hs.map((h) => h.reachedVia ?? "")),
      source: sources.join("+"),
      tier: pick(hs.map((h) => h.tier)),
      os: pick(hs.map((h) => h.os)),
      // A per-host identity survives every merge: the first non-empty user
      // wins, and the first non-zero port, so a scan record can never wipe
      // the user a human set on the named record it merged with.
      sshUser: pick(hs.map((h) => h.sshUser ?? "")),
      sshPort: hs.map((h) => h.sshPort ?? 0).find((p) => p > 0) ?? 0,
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
  fqdn: string;
  machineId: string;
  os: string;
  docker: boolean;
  isContainer: boolean;
  memTotalMiB?: number;
  immutable: boolean;
  defaultRoute: string;
  searchDomains: string[];
  interfaces: Array<z.infer<typeof InterfaceSchema>>;
} {
  // Repeated keys are lists (`iface=`/`addrline=`), so the map keeps every value
  // and the scalar accessors take the first.
  const map = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }
  const one = (k: string): string => map.get(k)?.[0] ?? "";

  // iface=<name>|<mac>|<physical 0/1>|<kind>|<method>|<lease 0/1>
  // addrline=<name>|<cidr>|<dynamic 0/1>
  const dynamicByNameHint = new Map<string, boolean>();
  const searchDomains = new Set<string>();
  const byName = new Map<string, z.infer<typeof InterfaceSchema>>();
  const defaultRoute = one("default_route");
  const defaultRouteProto = one("default_route_proto").toLowerCase();
  for (const line of map.get("iface") ?? []) {
    const [name, mac, physical, kind, method, lease, dom] = line.split("|");
    if (!name) continue;
    if (lease === "1") dynamicByNameHint.set(name, true);
    if (dom) {
      for (const d of dom.split(/[\s,]+/)) {
        if (d.includes(".")) searchDomains.add(d.trim().toLowerCase());
      }
    }
    byName.set(name, {
      name,
      mac: mac && mac !== "-" ? mac.toLowerCase() : "",
      physical: physical === "1",
      kind: kind || "unknown",
      method: method || "",
      addresses: [],
    });
  }
  const dynamicByName = new Map<string, boolean>(dynamicByNameHint);
  for (const line of map.get("addrline") ?? []) {
    const [name, cidr, dynamic] = line.split("|");
    if (!name || !cidr) continue;
    const iface = byName.get(name) ??
      {
        name,
        mac: "",
        physical: false,
        kind: "unknown",
        method: "",
        addresses: [],
      };
    iface.addresses.push(cidr);
    byName.set(name, iface);
    if (dynamic === "1") dynamicByName.set(name, true);
    else if (!dynamicByName.has(name)) dynamicByName.set(name, false);
  }
  // The kernel marks a DHCP-assigned address `dynamic`; that is a better signal
  // than an optional nmcli. Only fill `method` when nmcli said nothing useful.
  for (const name of byName.keys()) {
    if (!dynamicByName.has(name)) dynamicByName.set(name, false);
  }
  if (defaultRoute && defaultRouteProto === "dhcp") {
    dynamicByName.set(defaultRoute, true);
  }
  for (const [name, dyn] of dynamicByName) {
    const iface = byName.get(name);
    if (!iface) continue;
    if (iface.method === "" || iface.method === "unknown") {
      iface.method = dyn ? "auto" : iface.addresses.length > 0 ? "manual" : "";
    }
  }

  for (const d of one("search_domain").split(/[\s,]+/)) {
    if (d.includes(".")) searchDomains.add(d.trim().toLowerCase());
  }

  const mem = one("mem_total_mib");
  return {
    hostname: one("hostname"),
    fqdn: one("fqdn"),
    machineId: one("machine_id"),
    os: one("os"),
    docker: one("docker") === "1" || one("docker") === "true",
    isContainer: one("container") === "1" || one("container") === "true",
    memTotalMiB: mem ? Number.parseInt(mem, 10) : undefined,
    immutable: one("immutable") === "1" || one("immutable") === "true",
    defaultRoute: one("default_route"),
    searchDomains: [...searchDomains],
    interfaces: [...byName.values()],
  };
}

/** Classify an interface from the facts a host reports (used when a host omits `kind`). */
export function interfaceKind(
  name: string,
  physical: boolean,
  wireless: boolean,
): string {
  if (name === "lo") return "loopback";
  if (/^(tailscale|wg|netbird|zt|tun|tap)/.test(name)) return "vpn";
  if (/^(docker|br-|veth|virbr|podman|cni|cali|flannel)/.test(name)) {
    return "bridge";
  }
  if (wireless) return "wifi";
  if (physical) return "ethernet";
  return "virtual";
}

/** Address kind from the host's IPv4 configuration method. */
export function addressKindFor(method: string): string {
  const m = method.trim().toLowerCase();
  if (m === "" || m === "unknown") return "unknown";
  if (m.startsWith("manual") || m === "static") return "static";
  if (m.startsWith("auto") || m.startsWith("dhcp")) return "dhcp";
  if (m.startsWith("disabled") || m === "link-local" || m === "shared") {
    return "unknown";
  }
  return "unknown";
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
    // The host is the source of truth for its own addresses. Anything the
    // inventory still believes that the host did not report is drift — which is
    // how a stale record (a fixed IP that moved, a NIC that went away) is found.
    const reported = new Set(
      (h.interfaces ?? []).flatMap((i) =>
        i.addresses.map((a) => a.split("/")[0])
      ),
    );
    const addressDrift = reported.size === 0
      ? []
      : [...new Set((h.addresses ?? []).filter((a) => a && !reported.has(a)))];
    return {
      ...h,
      addresses: [
        ...new Set([
          ...(h.addresses ?? []),
          ...[...reported],
        ]),
      ].filter(Boolean),
      addressKinds: {
        ...addressKindsOf(h.interfaces ?? []),
        ...(h.addressKinds ?? {}),
      },
      addressDrift,
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
    // The DNS search domain is usually DHCP-supplied: it names the zone the
    // router registers hosts in (home.org.au), which is exactly the domain a
    // fleet wants to look hosts up in. Read it from the resolver, not config.
    "echo \"search_domain=$(sed -n 's/^search[[:space:]]*//p' /etc/resolv.conf 2>/dev/null | head -1)\"",
    // Network truth: every interface with its MAC, whether the kernel knows a
    // real device behind it, its kind, and how IPv4 is configured; plus every
    // address, so the inventory can tell static from DHCP and detect a MAC that
    // moves between hosts (USB NIC, docking station).
    'echo "fqdn=$(hostname -f 2>/dev/null || uname -n)"',
    "def=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"dev\"){print $(i+1); exit}}')",
    'echo "default_route=$def"',
    "defproto=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"proto\"){print $(i+1); exit}}')",
    'echo "default_route_proto=$defproto"',
    "if command -v ip >/dev/null 2>&1; then",
    '  ip -o addr show 2>/dev/null | awk \'{for(i=1;i<=NF;i++) if($i=="inet"||$i=="inet6") printf "addrline=%s|%s\\n", $2, $(i+1)}\'',
    "  ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1 | while read -r ifc; do",
    '    [ -n "$ifc" ] || continue',
    '    mac=$(ip -o link show dev "$ifc" 2>/dev/null | awk \'{for(i=1;i<=NF;i++) if($i=="link/ether"||$i=="link/loopback"){print $(i+1);exit}}\')',
    '    phys=0; [ -e "/sys/class/net/$ifc/device" ] && phys=1',
    '    wireless=0; [ -d "/sys/class/net/$ifc/wireless" ] && wireless=1',
    "    kind=unknown",
    '    case "$ifc" in',
    "      lo) kind=loopback ;;",
    "      tailscale*|wg*|netbird*|zt*|tun*|tap*) kind=vpn ;;",
    "      docker*|br-*|veth*|virbr*|podman*|cni*|cali*|flannel*) kind=bridge ;;",
    '      *) if [ "$wireless" = 1 ]; then kind=wifi; elif [ "$phys" = 1 ]; then kind=ethernet; else kind=virtual; fi ;;',
    "    esac",
    "    method=unknown",
    "    if command -v nmcli >/dev/null 2>&1; then",
    '      m=$(nmcli -t -f IP4.METHOD device show "$ifc" 2>/dev/null | head -1 | cut -d: -f2)',
    '      [ -n "$m" ] && method="$m"',
    "    fi",
    "    lease=0",
    "    if [ -d /run/systemd/netif/leases ]; then",
    '      idx=$(cat "/sys/class/net/$ifc/ifindex" 2>/dev/null)',
    '      [ -n "$idx" ] && [ -e "/run/systemd/netif/leases/$idx" ] && lease=1',
    "    fi",
    '    dom=""',
    "    if command -v nmcli >/dev/null 2>&1; then",
    '      dom=$(nmcli -t -f IP4.DOMAIN device show "$ifc" 2>/dev/null | head -1 | cut -d: -f2)',
    "    fi",
    '    if [ -z "$dom" ] && command -v resolvectl >/dev/null 2>&1; then',
    '      dom=$(resolvectl domain "$ifc" 2>/dev/null | tr " " "\\n" | grep -m1 "\\." )',
    "    fi",
    '    echo "iface=$ifc|$mac|$phys|$kind|$method|$lease|$dom"',
    "  done",
    "fi",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Address / MAC / DNS index
// ---------------------------------------------------------------------------

export interface NetworkMac {
  mac: string;
  hosts: string[];
  interfaces: string[];
  firstSeen: string;
  lastSeen: string;
  moved: boolean;
}

export interface NetworkAddress {
  address: string;
  host: string;
  interface: string;
  kind: string;
  firstSeen: string;
  lastSeen: string;
}

export interface NetworkDnsEntry {
  domain: string;
  name: string;
  swampManaged: boolean;
  addresses: string[];
  matchesHost: boolean;
}

export interface NetworkHostEntry {
  host: string;
  addresses: string[];
  addressDrift: string[];
  physicalNics: number;
  softwareInterfaces: number;
  dnsNames: string[];
  dnsAddresses: string[];
  dnsMismatch: boolean;
  dns: NetworkDnsEntry[];
}

/** The subset of the `network` resource the report reads. */
interface NetworkIndexData {
  summary: {
    physicalNics: number;
    macs: number;
    movedMacs: number;
    dnsMismatches: number;
    hostsWithDrift: number;
    hostsWithNoDns?: number;
    staleNames?: number;
  };
  byKind: Record<string, number>;
  domains?: Array<{ domain: string; swampManaged: boolean; source: string }>;
}

export interface DnsMismatch {
  host: string;
  name: string;
  resolved: string[];
  reported: string[];
}

/**
 * Build the address/MAC/DNS index from the inventory plus the previous index.
 *
 * Address kinds are three-state and evidence-based:
 *   - `static`        the host configures the address manually;
 *   - `dhcp-pinned`   DHCP, and this host had the same address last sweep (a
 *                     reservation or a long lease);
 *   - `dhcp-dynamic`  DHCP, and the host's address changed since the last sweep;
 *   - `dhcp`          DHCP, first time seen (not enough history to say yet).
 *
 * A MAC seen on more than one host (`moved`) is the docking-station / USB-NIC
 * signal: the interface travels, the machine does not.
 */
export function buildNetwork(
  hosts: InventoryHost[],
  previous: { macs?: NetworkMac[]; addresses?: NetworkAddress[] } | null,
  opts: {
    timestamp: string;
    dns?: Record<string, string[]>;
    domains?: Array<{ domain: string; swampManaged: boolean; source: string }>;
  },
): {
  hosts: NetworkHostEntry[];
  domains: Array<{ domain: string; swampManaged: boolean; source: string }>;
  macs: NetworkMac[];
  addresses: NetworkAddress[];
  dnsMismatches: DnsMismatch[];
  byKind: Record<string, number>;
  summary: {
    hosts: number;
    physicalNics: number;
    softwareInterfaces: number;
    macs: number;
    movedMacs: number;
    dnsMismatches: number;
    hostsWithDrift: number;
    hostsWithNoDns: number;
    staleNames: number;
  };
} {
  const ts = opts.timestamp;
  const prevMacs = new Map((previous?.macs ?? []).map((m) => [m.mac, m]));
  const prevAddr = new Map(
    (previous?.addresses ?? []).map((a) => [`${a.host}\u0000${a.address}`, a]),
  );
  const prevHostAddrs = new Map<string, Set<string>>();
  for (const a of previous?.addresses ?? []) {
    const set = prevHostAddrs.get(a.host) ?? new Set<string>();
    set.add(a.address);
    prevHostAddrs.set(a.host, set);
  }

  const domains = opts.domains ?? [];
  const macs = new Map<string, NetworkMac>();
  const addresses = new Map<string, NetworkAddress>();
  const hostEntries: NetworkHostEntry[] = [];
  const dnsMismatches: DnsMismatch[] = [];

  for (const h of hosts) {
    const host = h.name || h.address;
    const ifaces = h.interfaces ?? [];
    const reported = new Set(
      ifaces.flatMap((i) => i.addresses.map((a) => a.split("/")[0])),
    );
    const names = [
      ...new Set([
        h.name,
        ...(h.hostnames ?? []),
      ]),
    ].filter((n) => n && !isIpAddress(n));
    const resolved: string[] = [];
    for (const n of names) {
      // A host's own name resolving to loopback (a hosts-file entry) says
      // nothing about the network; only routable answers can disagree.
      const found = (opts.dns?.[n] ?? []).filter((a) =>
        !a.startsWith("127.") && a !== "::1"
      );
      if (found.length === 0) continue;
      resolved.push(...found);
      if (reported.size > 0 && !found.some((a) => reported.has(a))) {
        dnsMismatches.push({
          host,
          name: n,
          resolved: [...new Set(found)],
          reported: [...reported],
        });
      }
    }

    for (const iface of ifaces) {
      // loopback is not a NIC and its all-zero MAC is on every host
      if (iface.kind === "loopback") continue;
      if (iface.mac && iface.mac !== "00:00:00:00:00:00") {
        const prev = macs.get(iface.mac) ?? prevMacs.get(iface.mac);
        const hostsSeen = [...new Set([...(prev?.hosts ?? []), host])];
        macs.set(iface.mac, {
          mac: iface.mac,
          hosts: hostsSeen,
          interfaces: [...new Set([...(prev?.interfaces ?? []), iface.name])],
          firstSeen: prev?.firstSeen || ts,
          lastSeen: ts,
          moved: hostsSeen.length > 1,
        });
      }
      for (const cidr of iface.addresses) {
        const addr = cidr.split("/")[0];
        // loopback and IPv6 link-local never identify a host across the fleet
        if (
          addr.startsWith("127.") || addr === "::1" || addr.startsWith("fe80:")
        ) {
          continue;
        }
        const base = addressKindFor(iface.method);
        let kind = base;
        // Pinned vs dynamic is a lease question, so it only makes sense for IPv4:
        // an IPv6 privacy address rotates by design and would otherwise read as a
        // "dynamic lease" on every sweep.
        if (base === "dhcp" && !addr.includes(":")) {
          const sameBefore = prevAddr.has(`${host}\u0000${addr}`);
          const hadOther = [...(prevHostAddrs.get(host) ?? [])].some((a) =>
            a !== addr
          );
          kind = sameBefore
            ? "dhcp-pinned"
            : hadOther
            ? "dhcp-dynamic"
            : "dhcp";
        }
        if (base === "unknown" && reported.has(addr)) kind = "unknown";
        const prevEntry = prevAddr.get(`${host}\u0000${addr}`);
        addresses.set(`${host}\u0000${addr}`, {
          address: addr,
          host,
          interface: iface.name,
          kind,
          firstSeen: prevEntry?.firstSeen || ts,
          lastSeen: ts,
        });
      }
    }

    hostEntries.push({
      host,
      addresses: [...reported].sort(),
      addressDrift: h.addressDrift ?? [],
      physicalNics: ifaces.filter((i) =>
        i.physical && i.kind !== "vpn" && i.name !== "lo"
      )
        .length,
      softwareInterfaces: ifaces.filter((i) =>
        ["bridge", "vpn", "virtual"].includes(i.kind) ||
        (!i.physical && i.kind !== "loopback")
      ).length,
      dnsNames: names,
      dnsAddresses: [...new Set(resolved)].sort(),
      dnsMismatch: dnsMismatches.some((m) => m.host === host),
      dns: dnsEntriesFor(h, domains, opts.dns ?? {}, reported),
    });
  }

  // MACs that were not seen this sweep keep their lastSeen, so a dock that is
  // currently unplugged is still remembered — but the all-zero loopback MAC and
  // loopback-only entries are never identity, and older indexes may still carry
  // them, so they are dropped rather than inherited.
  const IGNORED_MAC = "00:00:00:00:00:00";
  for (const [mac, prev] of prevMacs) {
    if (mac === IGNORED_MAC) continue;
    if (
      prev.interfaces.length > 0 && prev.interfaces.every((i) => i === "lo")
    ) {
      continue;
    }
    if (!macs.has(mac)) macs.set(mac, prev);
  }
  for (const [key, prev] of prevAddr) {
    const addr = prev.address;
    if (addr.startsWith("127.") || addr === "::1" || addr.startsWith("fe80:")) {
      continue;
    }
    if (!addresses.has(key)) addresses.set(key, prev);
  }

  const byKind: Record<string, number> = {};
  for (const a of addresses.values()) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  }
  const macList = [...macs.values()]
    .filter((m) => m.mac !== IGNORED_MAC)
    .sort((a, b) => a.mac.localeCompare(b.mac));
  return {
    hosts: hostEntries.sort((a, b) => a.host.localeCompare(b.host)),
    macs: macList,
    addresses: [...addresses.values()].sort((a, b) =>
      `${a.host}${a.address}`.localeCompare(`${b.host}${b.address}`)
    ),
    dnsMismatches,
    byKind,
    summary: {
      hosts: hostEntries.length,
      physicalNics: hostEntries.reduce((n, h) => n + h.physicalNics, 0),
      softwareInterfaces: hostEntries.reduce(
        (n, h) => n + h.softwareInterfaces,
        0,
      ),
      macs: macList.length,
      movedMacs: macList.filter((m) => m.moved).length,
      dnsMismatches: dnsMismatches.length,
      hostsWithDrift: hostEntries.filter((h) => h.addressDrift.length > 0)
        .length,
      hostsWithNoDns:
        hostEntries.filter((h) => h.dns.every((d) => d.addresses.length === 0))
          .length,
      staleNames: hostEntries.reduce(
        (n, h) =>
          n +
          h.dns.filter((d) => d.addresses.length > 0 && !d.matchesHost).length,
        0,
      ),
    },
    domains,
  };
}

/**
 * The names a host answers on, per domain.
 *
 * A host is looked up as `<host>.<domain>` for every configured domain (skipped
 * when the name already ends with that domain) plus its bare name. Each answer
 * is kept with whether it reaches an address the host itself reports, so a name
 * that points somewhere else — or a domain that has no record for the host —
 * is data, not a silent absence.
 */
export function dnsEntriesFor(
  h: InventoryHost,
  domains: Array<{ domain: string; swampManaged: boolean; source: string }>,
  dns: Record<string, string[]>,
  reported: Set<string>,
): NetworkDnsEntry[] {
  const entries: NetworkDnsEntry[] = [];
  // "does DNS agree with this host?" is judged against everything the inventory
  // knows about it — this run's interfaces plus addresses seen earlier — so an
  // unprobed host is unverified, not stale.
  const known = new Set([...reported, ...(h.addresses ?? [])]);
  const bare = [
    ...new Set([
      h.name,
      ...(h.hostnames ?? []),
    ]),
  ].filter((n) => n && !isIpAddress(n));
  const seen = new Set<string>();
  const add = (domain: string, name: string, swampManaged: boolean) => {
    const key = `${domain}\u0000${name}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    const addresses = (dns[name] ?? []).filter((a) =>
      !a.startsWith("127.") && a !== "::1"
    );
    entries.push({
      domain,
      name,
      swampManaged,
      addresses: [...new Set(addresses)].sort(),
      matchesHost: addresses.some((a) => known.has(a)),
    });
  };
  for (const name of bare) add("", name, false);
  // Only a SHORT name is qualified with a domain: appending ".fi.gy" to an
  // already-qualified "host.home.org.au" produces a name nobody has.
  const shortNames = bare.filter((n) => !n.includes("."));
  for (const d of domains) {
    for (const name of shortNames) {
      add(d.domain, `${name}.${d.domain}`, d.swampManaged);
    }
  }
  return entries;
}

/**
 * The domains to look hosts up in.
 *
 * Configured domains come from the call. With `discover`, every installed
 * @svendowideit/caddy model's `baseDomain` is added as a SWAMP-MANAGED domain —
 * that is the zone swamp itself serves DNS and TLS for (fi.gy today, another
 * zone tomorrow), as opposed to a domain swamp has no say in (home.org.au).
 * Discovery is best-effort: no swamp CLI (a worker, a bare host) just means only
 * the configured domains are used.
 */
async function collectDomains(
  configured: string[],
  discover: boolean,
  hostDomains: string[],
  _dnsTimeoutMs: number,
): Promise<Array<{ domain: string; swampManaged: boolean; source: string }>> {
  const out = new Map<
    string,
    { domain: string; swampManaged: boolean; source: string }
  >();
  for (const d of configured) {
    const domain = d.trim().replace(/^\./, "").toLowerCase();
    if (domain) {
      out.set(domain, { domain, swampManaged: false, source: "configured" });
    }
  }
  // Domains the hosts themselves report (the DHCP/ resolver search domain) need
  // no configuration: home.org.au arrives with the lease.
  for (const d of hostDomains) {
    const domain = d.trim().replace(/^\./, "").toLowerCase();
    if (!domain || domain === "local" || !domain.includes(".")) continue;
    const prev = out.get(domain);
    if (!prev) out.set(domain, { domain, swampManaged: false, source: "dhcp" });
  }
  if (!discover) return collapseDomains([...out.values()]);

  // `swamp` is usually NOT on PATH inside a method process (it is when you run
  // the command yourself), so ask the running binary where it is.
  let swampBin = "swamp";
  try {
    const exe = Deno.execPath();
    if (exe && !/\/(deno|swamp-worker)$/.test(exe)) swampBin = exe;
  } catch {
    // keep the PATH lookup
  }
  // `swamp behavior list --json` is a megabyte of JSON and takes seconds in-process;
  // do not tie its budget to the DNS timeout.
  const CLI_TIMEOUT_MS = 20_000;
  const run = async (args: string[]): Promise<string> => {
    try {
      // through the swamp CLI (no in-process API for model globals); argv is
      // literals only.
      // swamp-quality-ignore deno-command: reads the caddy models' baseDomain
      const child = new Deno.Command(swampBin, {
        args,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, CLI_TIMEOUT_MS);
      const res = await child.output();
      clearTimeout(timer);
      if (res.code !== 0) {
        console.warn(
          `fleet-inventory: ${args.join(" ")} exited ${res.code}: ${
            new TextDecoder().decode(res.stderr).slice(0, 200)
          }`,
        );
        return "";
      }
      return new TextDecoder().decode(res.stdout);
    } catch (err) {
      console.warn(
        `fleet-inventory: could not run ${args.join(" ")} (${swampBin}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "";
    }
  };

  const listRaw = await run(["behavior", "list", "--json"]);
  if (!listRaw) {
    console.warn(
      "fleet-inventory: domain discovery skipped (no swamp CLI output)",
    );
    return collapseDomains([...out.values()]);
  }
  let names: string[] = [];
  try {
    const parsed = JSON.parse(listRaw);
    const list = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
    names = list
      .filter((m: { type?: string }) => m.type === "@svendowideit/caddy")
      .map((m: { name?: string }) => String(m.name ?? ""))
      .filter((n: string) => n !== "");
  } catch {
    return collapseDomains([...out.values()]);
  }
  console.warn(
    `fleet-inventory: domain discovery found ${names.length} caddy model(s)`,
  );
  for (const name of names) {
    const raw = await run(["behavior", "get", name, "--json"]);
    if (!raw) continue;
    try {
      const model = JSON.parse(raw);
      const domain = String(model?.globalArguments?.baseDomain ?? "").trim()
        .replace(/^\./, "").toLowerCase();
      if (!domain) continue;
      out.set(domain, { domain, swampManaged: true, source: "swamp" });
    } catch {
      // unreadable model: ignore
    }
  }
  return collapseDomains([...out.values()]);
}

/**
 * Drop a domain that is a subdomain of another one in the set.
 *
 * Caddy models use `fi.gy` and also `eieio.fi.gy` / `otel.fi.gy` as their base
 * domains; looking hosts up as `<host>.eieio.fi.gy` would be noise, so only the
 * widest zone is kept.
 */
export function collapseDomains(
  domains: Array<{ domain: string; swampManaged: boolean; source: string }>,
): Array<{ domain: string; swampManaged: boolean; source: string }> {
  const rank = (d: { swampManaged: boolean; source: string }): number =>
    d.swampManaged || d.source === "swamp" ? 3 : d.source === "dhcp" ? 2 : 1;
  const sorted = [...domains].sort((a, b) => a.domain.length - b.domain.length);
  const kept: Array<{ domain: string; swampManaged: boolean; source: string }> =
    [];
  for (const d of sorted) {
    const parent = kept.find((k) =>
      d.domain === k.domain || d.domain.endsWith(`.${k.domain}`)
    );
    if (parent) {
      // the widest zone wins, and it inherits the strongest provenance seen
      if (rank(d) > rank(parent)) {
        parent.swampManaged = d.swampManaged || parent.swampManaged;
        parent.source = d.source;
      }
      continue;
    }
    kept.push({ ...d, source: d.source ?? "" });
  }
  return kept;
}

/** Resolve names on the controller (best-effort; empty on failure). */
async function resolveNames(
  names: string[],
  timeoutMs: number,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const todo = [...new Set(names.filter((n) => n && !isIpAddress(n)))];
  await mapWithConcurrency(todo, 8, async (name) => {
    try {
      // resolver; the argv is a hostname the model already validated as a name.
      // swamp-quality-ignore deno-command: DNS resolution through the host's own
      const child = new Deno.Command("getent", {
        args: ["ahostsv4", name],
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, timeoutMs);
      const res = await child.output();
      clearTimeout(timer);
      if (res.code !== 0) {
        out[name] = [];
        return;
      }
      const text = new TextDecoder().decode(res.stdout);
      out[name] = [
        ...new Set(
          text.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(
            isIpAddress,
          ),
        ),
      ];
    } catch {
      out[name] = [];
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/fleet-inventory`. */
export const model = {
  type: "@svendowideit/fleet-inventory",
  version: "2026.11.27.2",
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
        "Fixes a set of bugs found while running a real /20 sweep. (1) Resources were all written under the instance name 'current', so every read-back returned nothing and specs overwrote each other; each spec now writes under its own instance name (discovery/probe/inventory/report), which fixes accumulation and the downstream reads. (2) discover now ACCUMULATES over the previous discovery (it replaced it each run), so" +
        "repeated/chunked scans build one inventory. (3) expandCidr no longer caps at 1024 — maxHosts (default 0) scans the whole CIDR, the CIDR is normalised to its network address, and the result reports truncated. (4) The scan no longer leaks file descriptors (timed-out connects are aborted via AbortSignal). (5) probe with no hosts probes every inventoried host and runs with bounded parallelism. (6) correlate preserves the" +
        "probed flag and probe facts. (7) inferTier honours defaultTier. (8) report reads the inventory RESOURCE, falling back to disk. Default scan ports are now [22,80,443]. Schema is additive (discover gains truncated/maxHosts).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.2",
      description:
        "Host identity is now machine-based, fixing scan/probe double-counting and multi-homed hosts. Each host record gains machineId (Linux /etc/machine-id, Windows MachineGuid, macOS IOPlatformUUID — strongest key), plus alias sets hostnames[], addresses[], macs[]. mergeHosts uses union-find with precedence machine-id > hostname > address/MAC: machine-id matches always merge; same hostname merges unless two different" +
        "machine ids; address/MAC merge only when at least one record is anonymous, so a scan's IP-only hit joins the host that probed it, while two named hosts sharing a transient IP (DHCP) or MAC (roaming dock) are NOT glued together. One record accumulates all of a machine's addresses, so wifi+wired are one host. probe records machineId first-class. Verified live: a /20 scan + probe now correlates to 47 machines (was 55/53" +
        "double-counted). Schema is additive (new fields default).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.3",
      description:
        "probe now ACCUMULATES across runs (it replaced the probed set each time, so re-probing a subset reset the resource). The `probe` resource gains `attempted` (machines targeted this run) and `known` (cumulative probed machines); `probed` is this run's successful-machine count. Counts are now per distinct MACHINE, not per target address, so a multi-homed host that answered twice counts once (previously 15 address" +
        "successes read as 15 when only 7 machines were probed). README/manifest now explain that omitting `hosts` probes every inventoried host and how to read the cumulative set. Schema is additive.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.4",
      description:
        "probe (no hosts) now SKIPS hosts that already probed successfully, so a repeated run does not re-SSH known-good machines; new `refresh=true` input forces a full re-probe. Hosts that previously FAILED are still retried (they may have come online). Each host keeps its own `lastSeen` (most-recent contact) instead of the whole set sharing the run timestamp. The run log now spells out attempted/probed/skipped/known and" +
        "explains why a run may probe 0 successfully. The `probe` resource gains `skipped`. Schema is additive.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.5",
      description:
        "The probe script is now portable across Linux and macOS (was Linux-only). macOS hosts have no /etc/machine-id, so the probe reads their IOPlatformUUID via `ioreg` (fast; `system_profiler` fallback) and total memory via `hw.memsize`; Linux keeps /etc/machine-id / /etc/os-release / /proc/meminfo. `hostname` uses `uname -n`. `os` is the Linux os-release ID (e.g. debian) or `darwin` on macOS. Verified against a real" +
        "macOS host: it now reports a stable machine id and merges by identity instead of only by name. No schema or argument changes.",
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
        "Each step now records only the fields it actually fills: `discover` writes observed hosts (name/address/mac(s)/hostnames/addresses/source/tier/os/lastSeen) and `probe` writes probed hosts (name/address/machineId/hostnames/addresses/source/tier/os/probed/lastSeen) — so a raw snapshot no longer shows consistently-empty deviceClass/vendor/reporting/silent fields that only `inventory` fills. Adds a workflow-scope report" +
        "`@svendowideit/fleet-inventory-report`, printed at the end of a sweep: a summary (hosts, tiers, OS, device classes) plus explained commands to view the data. The `report` resource gains `byClass` and `nextCommands`. Schema change to discovery/probe host shapes (breaking for a consumer reading those exact keys, but the extension is unpublished).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.03.3",
      description:
        "The end-of-sweep summary now fits one screen (~16 lines, was ~52): breakdowns are compact one-liners and the view commands are a terse, commented block inside a fenced code block, so renderers keep them verbatim instead of reflowing the comments into a blank-line-separated mess. Also drops the now-redundant 'report search' line. Content only; no schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.21.1",
      description:
        "Network awareness. probe now records every interface with its MAC, " +
        "whether the kernel exposes a real device behind it (/sys/class/net/<if>/device), " +
        "its kind (ethernet/wifi/vpn/bridge/virtual/loopback), the IPv4 configuration " +
        "method (nmcli, when present) and every address; plus the FQDN and the default-route " +
        "interface. Host records gain interfaces[], addressKinds{} and addressDrift[]; " +
        "correlate fills drift (a stored address the host itself does not report — the stale " +
        "record that makes a host look silent) and derives address kinds. New method `network` " +
        "builds a cross-sweep index: addresses classified static / dhcp-pinned / dhcp-dynamic, " +
        "MACs that appear on more than one host (a USB NIC or docking station that moves), " +
        "physical NIC counts vs software-defined interfaces, and DNS names that resolve away " +
        "from the addresses the host reports. report gains those counts. Schema is additive.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.27.1",
      description:
        "Per-host SSH identity. A host record can now carry its own sshUser and " +
        "sshPort, accepted by `discover` feeds and preserved across merges; " +
        "`probe` resolves the run input first, then the host, then the global " +
        "sshUser/sshPort, then ssh's own default, and passes -p. An empty global " +
        "sshUser stays legal and means every host must carry its own. Schema is " +
        "additive.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.27.2",
      description:
        "Two fixes found while a Raspberry Pi sat in the inventory but never on " +
        "the status page. `discover` now carries the identity fields a feed " +
        "declares (machineId, hostnames, addresses) into the merge, so a feed can " +
        "correct a record discovery already stored: previously those fields were " +
        "dropped, and a feed entry could never join the record the probe created " +
        "under the box's own hostname. `probe` now tries fallback logins in order " +
        "when the resolved user is refused (global `fallbackUsers`, default `pi`), " +
        "and records the user that answered on the host so later runs try it " +
        "first - a fleet has appliance images whose only account is `pi`. Additive: " +
        "existing hosts keep their recorded user, and a run-level sshUser is still " +
        "never recorded as a host's own.",
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
    network: {
      description:
        "Address/MAC/DNS index: static vs DHCP (pinned/dynamic), MACs that move between hosts, physical vs software interfaces, DNS mismatches, address drift",
      schema: NetworkOutputSchema,
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
        const feed: HostInput[] = args.feeds.map(feedHost);

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
        const timestamp = new Date().toISOString();
        // With no explicit hosts, probe everything already inventoried (from the
        // latest discovery, else the last inventory) that has NOT already been
        // probed successfully — re-probing known-good hosts every run is wasted
        // work. `refresh=true` forces a full re-probe.
        let targets = args.hosts;
        let skipped = 0;
        // Every candidate for a host: the addresses the inventory knows, then the
        // names. A name that resolves somewhere else (a stale tailnet record) must
        // not make a reachable host look down — try them all and record which won.
        const candidatesFor = (
          h: Partial<InventoryHost>,
          fallback: string,
        ): string[] => {
          const addrs = [h.address ?? "", ...(h.addresses ?? [])].filter((a) =>
            a && isIpAddress(a)
          );
          const names = [h.name ?? "", ...(h.hostnames ?? [])].filter((n) =>
            n && !isIpAddress(n)
          );
          return [...new Set([...addrs, ...names, fallback])].filter(Boolean);
        };
        const knownHosts = new Map<string, Partial<InventoryHost>>();
        for (
          const h of [
            ...(await readPrevious(context, "discovery")),
            ...(await readPrevious(context, "inventory")),
          ]
        ) {
          for (
            const k of [
              h.name,
              h.address,
              ...(h.addresses ?? []),
              ...(h.hostnames ?? []),
            ]
          ) {
            if (k) knownHosts.set(k.toLowerCase(), h);
          }
        }
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
            // Probe a KNOWN ADDRESS before a name: DNS for a short name is
            // often stale (xeon resolved to a dead A record while its real
            // address answered), and a silently failing name is exactly the
            // "host went quiet" false positive this model exists to avoid.
            const addr = (h.address || (h.addresses ?? [])[0] || "").trim();
            const t = (isIpAddress(addr) ? addr : "") || h.name || addr;
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
            const known = knownHosts.get(target.toLowerCase()) ?? {};
            const candidates = candidatesFor(known, target);
            // Precedence is deliberate: a value set for this RUN wins (an
            // operator asking for `root` means it), then the host's own record,
            // then the model global, then ssh's own default.
            const ssh = resolveSsh(known, args, g);
            const users = sshUserCandidates(known, args, g);
            const probe = await sshProbe(
              candidates,
              users,
              ssh.port,
              args.timeoutMs,
            );
            const facts = probe?.facts ?? null;
            // Record the probed hostname and address together, and the machine
            // id as first-class identity (not buried in notes) so it can merge
            // the scan's IP-only record with this named host.
            const hostname = facts?.hostname || "";
            const isIp = isIpAddress(target);
            return {
              name: hostname || target,
              address: isIp ? target : "",
              mac: facts?.interfaces?.find((i) => i.mac)?.mac ?? "",
              machineId: facts?.machineId ?? "",
              hostnames: [hostname, facts?.fqdn ?? ""].filter(
                (v, i, a) => v !== "" && a.indexOf(v) === i,
              ),
              addresses: isIp ? [target] : [],
              macs: (facts?.interfaces ?? []).map((i) => i.mac).filter((m) =>
                m !== ""
              ),
              interfaces: facts?.interfaces ?? [],
              addressKinds: addressKindsOf(facts?.interfaces ?? []),
              searchDomains: facts?.searchDomains ?? [],
              reachedVia: probe?.via ?? "",
              addressDrift: [],
              source: "probe",
              tier: facts ? inferTier(facts, g.defaultTier) : g.defaultTier,
              os: facts?.os ?? "",
              // Record the host's OWN identity, never the run-level override, so
              // a one-off `sshUser=root` sweep cannot be laundered into the
              // inventory as that host's permanent user. A fallback user that
              // answered IS the host's own login, so it is recorded when neither
              // the run nor the host already named one.
              sshUser: known.sshUser ||
                (args.sshUser.trim() === "" && facts
                  ? (probe?.user ?? "")
                  : ""),
              sshPort: known.sshPort ?? 0,
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

        // byClass is part of the inventory schema; populate it here too so a
        // correlate after an earlier enrich does not drop the classes on read.
        const byClass: Record<string, number> = {};
        for (const h of withReporting) {
          if (h.deviceClass) {
            byClass[h.deviceClass] = (byClass[h.deviceClass] ?? 0) + 1;
          }
        }
        const payload = {
          hosts: withReporting,
          total: withReporting.length,
          reporting: withReporting.filter((h) => h.reporting).length,
          silent,
          byTier: tally(withReporting, "tier"),
          byOs: tally(withReporting, "os"),
          byClass,
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

    network: {
      description:
        "Build the address/MAC/DNS index: static vs DHCP, MACs that move between hosts, physical vs software interfaces, DNS mismatches, address drift",
      arguments: NetworkArgsSchema,
      execute: async (
        args: z.infer<typeof NetworkArgsSchema>,
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
        // Prefer the inventory resource; fall back to the on-disk copy.
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
          hosts = (await readInventory(context.globalArgs.outputDir))?.hosts ??
            [];
        }
        // The previous index is the history this method needs: it is what turns
        // "dhcp" into "pinned" (same address again) or "dynamic" (it moved), and
        // what remembers a MAC that is currently unplugged.
        let previous:
          | { macs?: NetworkMac[]; addresses?: NetworkAddress[] }
          | null = null;
        try {
          previous = await context.readResource?.("network") as
            | { macs?: NetworkMac[]; addresses?: NetworkAddress[] }
            | null;
        } catch {
          // first run
        }

        const hostDomains = [
          ...new Set(
            hosts.flatMap((h) => h.searchDomains ?? []),
          ),
        ];
        const domains = await collectDomains(
          args.domains,
          args.discoverDomains,
          hostDomains,
          args.dnsTimeoutMs,
        );
        // Every host is looked up bare and in each domain, so the index can say
        // which names reach it and which domains have no record for it at all.
        const bare = [
          ...new Set(
            hosts.flatMap((h) => [h.name, ...(h.hostnames ?? [])])
              .filter((n) => n && !isIpAddress(n)),
          ),
        ];
        const candidates = [
          ...new Set(
            bare.flatMap((n) => [
              n,
              ...domains
                .filter((d) => !n.endsWith(`.${d.domain}`))
                .map((d) => `${n}.${d.domain}`),
            ]),
          ),
        ];
        const dns = args.resolveDns
          ? await resolveNames(candidates, args.dnsTimeoutMs)
          : {};
        const index = buildNetwork(hosts, previous, {
          timestamp,
          dns,
          domains,
        });

        context.logger?.info(
          "Network index: {hosts} host(s), {macs} MAC(s) ({moved} seen on more than one host), " +
            "{nics} physical NIC(s), {soft} software interface(s), address kinds {kinds}, " +
            "{dns} DNS mismatch(es), {stale} stale name(s), {nodns} host(s) with no DNS, " +
            "{drift} host(s) with address drift, domains {domains}",
          {
            hosts: index.summary.hosts,
            macs: index.summary.macs,
            moved: index.summary.movedMacs,
            nics: index.summary.physicalNics,
            soft: index.summary.softwareInterfaces,
            kinds: JSON.stringify(index.byKind),
            dns: index.summary.dnsMismatches,
            stale: index.summary.staleNames,
            nodns: index.summary.hostsWithNoDns,
            drift: index.summary.hostsWithDrift,
            domains:
              domains.map((d) =>
                `${d.domain}${d.swampManaged ? " (swamp)" : ""}`
              )
                .join(", ") || "none",
          },
        );
        const handle = await context.writeResource("network", "network", {
          ...index,
          generatedAt: timestamp,
        });
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
        // Network facts, when the `network` method has run.
        let net: NetworkIndexData | null = null;
        try {
          net = await context.readResource?.("network") as
            | NetworkIndexData
            | null;
        } catch {
          // not built yet
        }
        const handle = await context.writeResource("report", "report", {
          total,
          reporting,
          silent: hosts.filter((h) => h.silent).map((h) => h.name),
          coveragePercent: coveragePercent(total, reporting),
          byTier: tally(hosts, "tier"),
          byOs: tally(hosts, "os"),
          byClass,
          physicalNics: net?.summary?.physicalNics ?? 0,
          macs: net?.summary?.macs ?? 0,
          movedMacs: net?.summary?.movedMacs ?? 0,
          dnsMismatches: net?.summary?.dnsMismatches ?? 0,
          hostsWithDrift: net?.summary?.hostsWithDrift ?? 0,
          byAddressKind: net?.byKind ?? {},
          domains: net?.domains ?? [],
          hostsWithNoDns: net?.summary?.hostsWithNoDns ?? 0,
          staleNames: net?.summary?.staleNames ?? 0,
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
    // machineId is identity, not a probe fact: dropping it here broke the join
    // between a discovered/feed record and the record the probe stored under the
    // box's own hostname, so the two never became one host.
    machineId: h.machineId,
    hostnames: h.hostnames,
    addresses: h.addresses,
    source: h.source,
    tier: h.tier,
    os: h.os,
    // A feed is how an operator records the login an appliance actually accepts.
    sshUser: h.sshUser,
    sshPort: h.sshPort,
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
    interfaces: h.interfaces,
    addressKinds: h.addressKinds,
    searchDomains: h.searchDomains,
    reachedVia: h.reachedVia,
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
    interfaces: h.interfaces ?? [],
    addressKinds: h.addressKinds ?? {},
    searchDomains: h.searchDomains ?? [],
    reachedVia: h.reachedVia ?? "",
    source: h.source || source,
    tier: h.tier ?? "",
    os: h.os ?? "",
    sshUser: h.sshUser ?? "",
    sshPort: h.sshPort ?? 0,
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

/**
 * The SSH identity to use for one host.
 *
 * Precedence is the whole point, and it is the same in every extension that
 * SSHes to an inventoried host:
 *
 *   1. the value set for THIS RUN  (`sshUser`/`sshPort` method input)
 *   2. the value recorded on the HOST
 *   3. the MODEL GLOBAL
 *   4. empty/0 - and then ssh decides (current user, port 22)
 *
 * A run-level value wins so an operator can sweep a fleet as another user; the
 * host value wins over the global so one appliance image (an OctoPi whose only
 * login is `pi`) does not need its own model instance. Empty at every level is
 * legal: with a global `sshUser: ""` an operator is choosing to require every
 * host to carry its own, and a host that does not is simply not reachable by
 * probe - which the inventory reports honestly instead of guessing a user.
 */
export function resolveSsh(
  host: { sshUser?: string; sshPort?: number } | undefined,
  args: { sshUser?: string; sshPort?: number } | undefined,
  global: { sshUser?: string; sshPort?: number } | undefined,
): { user: string; port: number } {
  const user = (args?.sshUser ?? "").trim() || (host?.sshUser ?? "").trim() ||
    (global?.sshUser ?? "").trim();
  const port = (args?.sshPort ?? 0) || (host?.sshPort ?? 0) ||
    (global?.sshPort ?? 0);
  return { user, port };
}

/** Logins tried after the fleet's own user, when no list is configured. */
export const DEFAULT_FALLBACK_USERS = ["pi"];

/**
 * The SSH users to try for one host, in order: the resolved user (run → host →
 * global), then the fallback logins. A fleet has appliance images that accept
 * exactly one account (`pi` on a Pi, `admin` on a router), and requiring the
 * operator to record it per host before the first probe means the first probe
 * never happens. The user that answers is recorded on the host afterwards, so
 * the fallback costs one refused connection once, not every run.
 */
export function sshUserCandidates(
  host: { sshUser?: string } | undefined,
  args: { sshUser?: string; fallbackUsers?: string[] },
  global: { sshUser?: string; fallbackUsers?: string[] },
): string[] {
  const primary = resolveSsh(host, args, global).user;
  const configured = (args.fallbackUsers && args.fallbackUsers.length > 0)
    ? args.fallbackUsers
    : (global.fallbackUsers ?? []);
  // The built-in default is the appliance login a bare fleet almost always has.
  const extra = configured.length > 0 ? configured : DEFAULT_FALLBACK_USERS;
  return [primary, ...extra]
    .map((u) => (u ?? "").trim())
    .filter((u, i, a) => u !== "" && a.indexOf(u) === i);
}

/** SSH into a host and run the probe script, returning facts or null. */
async function sshProbe(
  candidates: string[],
  users: string[],
  port: number,
  timeoutMs: number,
): Promise<
  | { facts: ReturnType<typeof parseProbeFacts>; via: string; user: string }
  | null
> {
  for (const user of users) {
    for (const target of candidates) {
      const facts = await sshProbeOne(target, user, port, timeoutMs);
      if (facts) return { facts, via: target, user };
    }
  }
  return null;
}

async function sshProbeOne(
  target: string,
  user: string,
  port: number,
  timeoutMs: number,
): Promise<ReturnType<typeof parseProbeFacts> | null> {
  const dest = user ? `${user}@${target}` : target;
  try {
    // fleet prober); fixed options plus a validated user@host, no shell.
    // swamp-quality-ignore deno-command: SSH is this model's transport (it is the
    const proc = new Deno.Command("ssh", {
      args: [
        ...(port > 0 ? ["-p", String(port)] : []),
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
