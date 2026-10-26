/**
 * @svendowideit/split-dns
 *
 * Split-horizon DNS for Debian, Ubuntu and NixOS hosts: keep using the DNS
 * servers learned from DHCP for everything, but send one zone (or sub-zone) to
 * that zone's own authoritative nameservers — or to an explicit list — so
 * records you manage update as fast as the zone's nameservers publish them.
 *
 * The extension installs a small, dedicated dnsmasq conditional forwarder on
 * the target, pointed at a loopback address. The host's client resolver is
 * pointed at it. dnsmasq's default upstream is the DHCP-learned DNS (read from
 * systemd-resolved's upstream resolv.conf, or captured from resolv.conf /
 * resolvectl / NetworkManager), and `server=/<zone>/<ns>` overrides apply only
 * to the named zone. Debian/Ubuntu use a systemd unit managed here; NixOS uses
 * a generated NixOS module so the configuration survives a rebuild.
 *
 * Every apply is validated before it is activated, then validated again live.
 * If the live check fails, the pre-apply snapshot is restored and the old
 * resolver is verified, and the method throws with the exact failing query,
 * command output and rollback outcome. Re-running an unchanged configuration
 * is a no-op.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** The model type name. */
export const SPLIT_DNS_TYPE = "@svendowideit/split-dns";

/** Marker written into every file this extension owns. */
export const MANAGED_MARKER = "Managed by @svendowideit/split-dns";

/** Name of the systemd unit used on Debian/Ubuntu. */
export const SERVICE_NAME = "split-dns.service";

const DEFAULT_CONFIG_DIR = "/etc/split-dns";
const DEFAULT_LISTEN_ADDRESS = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 53;
const DEFAULT_CONTROL_NAME = "github.com";
const DEFAULT_NIXOS_CONFIG = "/etc/nixos/configuration.nix";
const DEFAULT_NIXOS_MODULE = "/etc/nixos/split-dns.nix";
const DEFAULT_NIXOS_WRAPPER = "/etc/nixos/split-dns-configuration.nix";
const DEFAULT_NIXOS_ROLLBACK =
  "/etc/nixos/split-dns-configuration-rollback.nix";
const NM_CONF_REL = "/etc/NetworkManager/conf.d/90-split-dns.conf";
const RESOLVCONF_HEAD_REL = "/etc/resolvconf/resolv.conf.d/head";
const SECTION_PREFIX = "###SPLITDNS:";
const SECTION_END = "###SPLITDNS:END";
const MISSING = "__MISSING__";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const safeValue = (label: string): z.ZodString =>
  z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );

/** A host target. Strings are also accepted and parsed by {@link normalizeHosts}. */
const HostSpecSchema = z.object({
  name: safeValue("host name").default(""),
  address: safeValue("host address").min(1),
  user: safeValue("host user").default(""),
  port: z.number().int().min(1).max(65535).default(22),
  local: z.boolean().default(false),
}).strict();

/** A host target as an object or a `[user@]host[:port]` string. */
const HostInputSchema = z.union([safeValue("host"), HostSpecSchema]);

/** One managed zone exception. Exported shape used by {@link HostResultSchema}. */
const ZoneRuleSchema = z.object({
  /** Zone (or sub-zone) the override applies to, without a trailing dot. */
  zone: z.string(),
  /** Nameserver addresses the zone is forwarded to. */
  nameservers: z.array(z.string()).default([]),
  /** How the list was obtained: explicit input, authoritative NS, or stored. */
  source: z.enum(["explicit", "authoritative", "stored"]).default("explicit"),
  /** When this rule was last resolved. */
  updatedAt: z.string().default(""),
});

/** A managed zone exception. */
export interface ZoneRule {
  /** Zone (or sub-zone) the override applies to, without a trailing dot. */
  zone: string;
  /** Nameserver addresses the zone is forwarded to. */
  nameservers: string[];
  /** How the list was obtained: explicit input, authoritative NS, or stored. */
  source: "explicit" | "authoritative" | "stored";
  /** When this rule was last resolved (ISO 8601). */
  updatedAt: string;
}

const GlobalArgsSchema = z.object({
  hosts: z.array(HostInputSchema).default([]).describe(
    "Default host targets. Empty means the local host. Accepts " +
      "`[user@]host[:port]`, `local`, or {name,address,user,port,local}.",
  ),
  sshUser: safeValue("sshUser").default("").describe(
    "Default SSH user for bare host entries (default: the current user).",
  ),
  identityFile: safeValue("identityFile").default("").describe(
    "SSH identity file used for remote hosts (default: ssh-agent / ssh config).",
  ),
  connectTimeoutSec: z.number().int().positive().default(10).describe(
    "SSH connect timeout in seconds.",
  ),
  commandTimeoutSec: z.number().int().positive().default(600).describe(
    "Per-command timeout in seconds. `nixos-rebuild` can be slow.",
  ),
  stagingDir: safeValue("stagingDir").default("~/.cache/split-dns").describe(
    "Unprivileged directory where apply/remove scripts are staged before " +
      "@svendowideit/sudo runs them.",
  ),
  parallel: z.number().int().positive().max(32).default(4).describe(
    "Maximum hosts to process at once.",
  ),
  configDir: safeValue("configDir").default(DEFAULT_CONFIG_DIR).describe(
    "Directory holding the managed dnsmasq config, state and backups.",
  ),
  listenAddress: safeValue("listenAddress").default(DEFAULT_LISTEN_ADDRESS)
    .describe(
      "Loopback address dnsmasq listens on. Use another loopback address if " +
        "something already owns 127.0.0.1:53.",
    ),
  listenPort: z.number().int().min(1).max(65535).default(DEFAULT_LISTEN_PORT)
    .describe("Port dnsmasq listens on."),
  manageResolver: z.boolean().default(true).describe(
    "Point the host's client resolver at dnsmasq. Set false to install and " +
      "run the forwarder without changing /etc/resolv.conf (useful for tests).",
  ),
  installPackages: z.boolean().default(true).describe(
    "Install `dnsmasq-base` with apt on Debian/Ubuntu when dnsmasq is missing.",
  ),
  controlName: safeValue("controlName").default(DEFAULT_CONTROL_NAME).describe(
    "A name outside the exception zone used to prove normal DHCP DNS still " +
      "works. Empty skips that check.",
  ),
  testName: safeValue("testName").default("").describe(
    "Optional FQDN inside the zone to query during verification. Empty uses " +
      "the zone's SOA record.",
  ),
  nixosRebuild: z.boolean().default(true).describe(
    "Run `nixos-rebuild switch` on NixOS so the generated module is active. " +
      "When false, apply writes the files but fails instead of claiming success.",
  ),
  nixosRebuildCommand: safeValue("nixosRebuildCommand").default(
    `nixos-rebuild switch -I nixos-config=${DEFAULT_NIXOS_WRAPPER}`,
  ).describe(
    "Command used to activate the generated NixOS module. Override for a " +
      "flakes-based host, e.g. `nixos-rebuild switch --flake /etc/nixos#host`.",
  ),
  dnsmasqBinary: safeValue("dnsmasqBinary").default("").describe(
    "Explicit dnsmasq path. Empty auto-detects it.",
  ),
  backupKeep: z.number().int().nonnegative().default(5).describe(
    "How many pre-apply snapshots to keep for diagnostics.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ApplyArgsSchema = z.object({
  hosts: z.array(HostInputSchema).optional(),
  zone: safeValue("zone").default("").describe(
    "Zone or sub-zone to send to faster-updating nameservers. Empty reconciles " +
      "the zones already stored on each host (used by the upgrade workflow).",
  ),
  nameservers: z.array(safeValue("nameserver")).default([]).describe(
    "Nameserver IPs or hostnames for the zone. Empty discovers the zone's " +
      "authoritative NS records.",
  ),
  replaceZones: z.boolean().default(false).describe(
    "Replace every managed zone with this run's zone instead of merging.",
  ),
  removeZone: z.boolean().default(false).describe(
    "Remove this zone's override instead of adding/updating it.",
  ),
  stagingDir: safeValue("stagingDir").optional(),
  runId: safeValue("runId").optional(),
  manageResolver: z.boolean().optional(),
  installPackages: z.boolean().optional(),
  parallel: z.number().int().positive().optional(),
  sshUser: safeValue("sshUser").optional(),
  identityFile: safeValue("identityFile").optional(),
  testName: safeValue("testName").optional(),
  controlName: safeValue("controlName").optional(),
  dryRun: z.boolean().default(false).describe(
    "Validate and report the plan without changing any host.",
  ),
  configDir: safeValue("configDir").optional(),
  listenAddress: safeValue("listenAddress").optional(),
  listenPort: z.number().int().min(1).max(65535).optional(),
  nixosRebuild: z.boolean().optional(),
});

type ApplyArgs = z.infer<typeof ApplyArgsSchema>;

const HostsArgsSchema = z.object({
  hosts: z.array(HostInputSchema).optional(),
  stagingDir: safeValue("stagingDir").optional(),
  runId: safeValue("runId").optional(),
  manageResolver: z.boolean().optional(),
  parallel: z.number().int().positive().optional(),
  sshUser: safeValue("sshUser").optional(),
  identityFile: safeValue("identityFile").optional(),
  configDir: safeValue("configDir").optional(),
  controlName: safeValue("controlName").optional(),
});

type HostsArgs = z.infer<typeof HostsArgsSchema>;

const VerifyArgsSchema = HostsArgsSchema.extend({
  zone: safeValue("zone").optional(),
  expect: z.enum(["configured", "removed"]).default("configured"),
  listenAddress: safeValue("listenAddress").optional(),
  listenPort: z.number().int().min(1).max(65535).optional(),
  testName: safeValue("testName").optional(),
});

type VerifyArgs = z.infer<typeof VerifyArgsSchema>;

const ValidationSchema = z.object({
  configTest: z.boolean().default(false),
  configMessage: z.string().default(""),
  transientQuery: z.enum(["passed", "failed", "skipped"]).default("skipped"),
  transientMessage: z.string().default(""),
  serviceActive: z.boolean().default(false),
  serviceMessage: z.string().default(""),
  localZone: z.enum(["passed", "failed", "skipped"]).default("skipped"),
  localZoneMessage: z.string().default(""),
  localControl: z.enum(["passed", "failed", "skipped"]).default("skipped"),
  localControlMessage: z.string().default(""),
  systemZone: z.enum(["passed", "failed", "skipped"]).default("skipped"),
  systemZoneMessage: z.string().default(""),
  systemControl: z.enum(["passed", "failed", "skipped"]).default("skipped"),
  systemControlMessage: z.string().default(""),
});

/** Validation checks and their human-readable output. */
export interface Validation {
  /** Whether `dnsmasq --test` accepted the generated config. */
  configTest: boolean;
  /** `dnsmasq --test` output, with the exit marker removed. */
  configMessage: string;
  /** Outcome of a temporary dnsmasq query before activation. */
  transientQuery: "passed" | "failed" | "skipped";
  /** Explanation for the temporary query result. */
  transientMessage: string;
  /** Whether the systemd service (or NixOS unit) is active. */
  serviceActive: boolean;
  /** Service status output when it is not active. */
  serviceMessage: string;
  /** Outcome of querying the zone through the local forwarder. */
  localZone: "passed" | "failed" | "skipped";
  /** Local zone query output. */
  localZoneMessage: string;
  /** Outcome of querying the control name through the local forwarder. */
  localControl: "passed" | "failed" | "skipped";
  /** Local control query output. */
  localControlMessage: string;
  /** Outcome of querying the zone through the host's client resolver. */
  systemZone: "passed" | "failed" | "skipped";
  /** System zone query output. */
  systemZoneMessage: string;
  /** Outcome of querying the control name through the client resolver. */
  systemControl: "passed" | "failed" | "skipped";
  /** System control query output. */
  systemControlMessage: string;
}

/** The per-host result written by every method. */
const HostResultSchema = z.object({
  host: z.string(),
  address: z.string(),
  local: z.boolean(),
  ok: z.boolean(),
  action: z.enum([
    "planned",
    "unchanged",
    "applied",
    "rolled-back",
    "failed",
    "status",
    "removed",
    "staged",
    "verified",
  ]),
  os: z.string().default(""),
  osName: z.string().default(""),
  hostname: z.string().default(""),
  resolverMode: z.string().default(""),
  zone: z.string().default(""),
  zones: z.array(ZoneRuleSchema).default([]),
  nameservers: z.array(z.string()).default([]),
  nameserverSource: z.string().default(""),
  upstream: z.array(z.string()).default([]),
  upstreamSource: z.string().default(""),
  changed: z.boolean().default(false),
  configPath: z.string().default(""),
  serviceName: z.string().default(SERVICE_NAME),
  validation: ValidationSchema.default(() => ValidationSchema.parse({})),
  warnings: z.array(z.string()).default([]),
  error: z.string().default(""),
  checkedAt: z.string(),
});

/** A per-host result. */
type HostResult = z.infer<typeof HostResultSchema>;

const SummarySchema = z.object({
  generatedAt: z.string(),
  action: z.string(),
  hosts: z.number(),
  changed: z.number(),
  ok: z.number(),
  failed: z.number(),
  errors: z.array(z.string()).default([]),
});

/** A run summary. */
type RunSummary = z.infer<typeof SummarySchema>;

const StagedSchema = z.object({
  host: z.string(),
  zone: z.string().default(""),
  zones: z.array(ZoneRuleSchema).default([]),
  changed: z.boolean().default(false),
  stagingDir: z.string().default(""),
  applyScript: z.string().default(""),
  rollbackScript: z.string().default(""),
  removeScript: z.string().default(""),
  verifyScript: z.string().default(""),
  backupDir: z.string().default(""),
  ok: z.boolean().default(true),
  warnings: z.array(z.string()).default([]),
  error: z.string().default(""),
  stagedAt: z.string(),
});

/** The staged scripts a workflow hands to @svendowideit/sudo. */
export interface Staged {
  /** Host the scripts were staged on. */
  host: string;
  /** Zone this run configures ("" when reconciling). */
  zone: string;
  /** All managed zones after the run's merge/remove. */
  zones: ZoneRule[];
  /** Whether applying the staged scripts would change anything. */
  changed: boolean;
  /** Directory holding the scripts. */
  stagingDir: string;
  /** Absolute path to the apply script. */
  applyScript: string;
  /** Absolute path to the rollback script. */
  rollbackScript: string;
  /** Absolute path to the remove script. */
  removeScript: string;
  /** Absolute path to the verification gate script. */
  verifyScript: string;
  /** Pre-apply snapshot directory the rollback script restores. */
  backupDir: string;
  /** False when staging itself failed. */
  ok: boolean;
  /** Non-fatal staging warnings. */
  warnings: string[];
  /** Staging error, if any. */
  error: string;
  /** When the scripts were staged (ISO 8601). */
  stagedAt: string;
}

const StateSchema = z.object({
  version: z.literal(1).default(1),
  managedBy: z.string().default(SPLIT_DNS_TYPE),
  os: z.string().default(""),
  resolverMode: z.string().default(""),
  listenAddress: z.string().default(""),
  listenPort: z.number().default(53),
  upstreamSource: z.string().default(""),
  zones: z.array(ZoneRuleSchema).default([]),
  appliedAt: z.string().default(""),
});

/** The per-host state written by a successful apply. */
export interface ManagedState {
  /** State format version. */
  version: 1;
  /** Owner marker. */
  managedBy: string;
  /** Detected OS id (`debian`, `ubuntu`, `nixos`, …). */
  os: string;
  /** How the client resolver is managed (`networkmanager`, `resolvconf`, `nixos`, `static`). */
  resolverMode: string;
  /** Loopback address dnsmasq listens on. */
  listenAddress: string;
  /** Port dnsmasq listens on. */
  listenPort: number;
  /** Where the default (DHCP) upstreams came from. */
  upstreamSource: string;
  /** Managed zone exceptions. */
  zones: ZoneRule[];
  /** When the state was applied (ISO 8601). */
  appliedAt: string;
}

/** One host target after parsing. */
export interface HostSpec {
  /** Display name (address unless the input supplied one). */
  name: string;
  /** DNS name or IP address of the target. */
  address: string;
  /** SSH user, or "" to use the current/default user. */
  user: string;
  /** SSH port. */
  port: number;
  /** Run the script on the local machine instead of over SSH. */
  local: boolean;
}

/** The DNS resolver abstraction used for NS/IP discovery (injectable in tests). */
export interface DnsResolver {
  /** Resolve `name` for one record type and return the record data. */
  resolve(
    name: string,
    type: "NS" | "A" | "AAAA",
  ): Promise<string[]>;
}

/** Parsed output of one `dig`/`resolvectl`/`getent` check. */
export interface QueryResult {
  /** Whether the query answered, failed, or could not be run. */
  status: "passed" | "failed" | "skipped";
  /** Raw command output justifying the status. */
  output: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Stable order for addresses: IPv4 first, then IPv6, then lexical. */
export function compareNameservers(a: string, b: string): number {
  const a4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a);
  const b4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(b);
  if (a4 !== b4) return a4 ? -1 : 1;
  return a.localeCompare(b);
}

/** Deduplicate strings while preserving their first-seen order. */
export function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** Normalize a zone: trim, lowercase, and drop the trailing root dot. */
export function normalizeZone(input: string): string {
  let zone = input.trim().toLowerCase();
  zone = zone.replace(/\.+$/, "");
  if (!zone) throw new Error("zone is required");
  if (zone.length > 253) throw new Error("zone is longer than 253 characters");
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (!new RegExp(`^${label}(?:\\.${label})*$`).test(zone)) {
    throw new Error(
      `invalid zone ${JSON.stringify(input)}: use dot-separated letters, ` +
        "digits and hyphens (no leading/trailing hyphen)",
    );
  }
  return zone;
}

/** True for addresses that would make dnsmasq forward to itself. */
export function isLoopbackAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  return a === "localhost" || a === "::1" || a === "0.0.0.0" ||
    a.startsWith("127.") || a.startsWith("::ffff:127.");
}

/** True when a string is a literal IPv4 or IPv6 address. */
export function isIpAddress(value: string): boolean {
  const v = value.trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) {
    return v.split(".").every((p) => {
      const n = Number(p);
      return n >= 0 && n <= 255;
    });
  }
  return v.includes(":") && /^[0-9a-f:.]+$/i.test(v);
}

/** Parse a resolv.conf-style file into nameservers, search domains and options. */
export function parseResolvConf(
  text: string,
): { nameservers: string[]; search: string[]; options: string[] } {
  const nameservers: string[] = [];
  const search: string[] = [];
  const options: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toLowerCase();
    const rest = parts.slice(1);
    if (key === "nameserver" && rest[0]) nameservers.push(rest[0]);
    else if ((key === "search" || key === "domain") && rest.length) {
      search.push(...rest);
    } else if (key === "options" && rest.length) options.push(...rest);
  }
  return {
    nameservers: dedupe(nameservers),
    search: dedupe(search),
    options: dedupe(options),
  };
}

/**
 * Extract nameserver addresses from `resolvectl dns` output.
 *
 * Lines look like `Link 3 (wlp0s20f3): 10.10.10.1`; `Global:` may also carry
 * addresses. Only IP-shaped tokens are kept.
 */
export function parseResolvectlDns(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    for (const token of line.slice(idx + 1).trim().split(/\s+/)) {
      if (token && isIpAddress(token)) out.push(token);
    }
  }
  return dedupe(out);
}

/** Extract addresses from `nmcli -t -f IP4.DNS,IP6.DNS device show` output. */
export function parseNmcliDns(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /:(.+)$/.exec(line);
    if (!m) continue;
    for (const token of m[1].trim().split(/[\s,]+/)) {
      if (token && isIpAddress(token)) out.push(token);
    }
  }
  return dedupe(out);
}

/** Choose upstream nameservers that are not the local stub. */
export function usableUpstream(
  nameservers: string[],
  listenAddress: string,
): string[] {
  return dedupe(nameservers).filter((ns) =>
    ns.length > 0 &&
    !isLoopbackAddress(ns) &&
    ns !== listenAddress &&
    ns !== `${listenAddress}:53`
  );
}

/** Parse one host entry (`local`, `user@host:port`, or an object). */
export function parseHostEntry(
  entry: string | HostSpec,
  index: number,
  sshUser: string,
): HostSpec {
  if (typeof entry !== "string") {
    const name = entry.name || entry.address;
    if (!name) throw new Error(`hosts[${index}] has no name or address`);
    return {
      name,
      address: entry.address,
      user: entry.user || sshUser,
      port: entry.port,
      local: entry.local || entry.address === "localhost" ||
        entry.address === "127.0.0.1" || entry.address === "::1",
    };
  }
  const raw = entry.trim();
  if (!raw) throw new Error(`hosts[${index}] is empty`);
  if (raw === "local" || raw === "localhost") {
    return {
      name: raw,
      address: "localhost",
      user: "",
      port: 22,
      local: true,
    };
  }
  let rest = raw;
  let user = "";
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) {
      throw new Error(`hosts[${index}] has an invalid SSH user`);
    }
  }
  let address = rest;
  let port = 22;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) {
    address = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else {
    const first = rest.indexOf(":");
    if (first > 0 && first === rest.lastIndexOf(":")) {
      const maybePort = rest.slice(first + 1);
      if (/^\d+$/.test(maybePort)) {
        address = rest.slice(0, first);
        port = Number(maybePort);
      }
    }
  }
  if (!address || /\s/.test(address)) {
    throw new Error(`hosts[${index}] has an invalid address`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`hosts[${index}] has an invalid port`);
  }
  return {
    name: address,
    address,
    user: user || sshUser,
    port,
    local: false,
  };
}

/** Normalize the configured host list. Empty means the local host. */
export function normalizeHosts(
  entries: Array<string | HostSpec>,
  sshUser: string,
): HostSpec[] {
  const list = entries.length > 0 ? entries : ["local"];
  return list.map((entry, index) => parseHostEntry(entry, index, sshUser));
}

/** Merge this run's zone rules into the rules already on the host. */
export function mergeZoneRules(
  existing: ZoneRule[],
  incoming: ZoneRule[],
  opts: { replace?: boolean; remove?: boolean } = {},
): ZoneRule[] {
  const map = new Map<string, ZoneRule>();
  if (!opts.replace) {
    for (const rule of existing) map.set(rule.zone, rule);
  }
  for (const rule of incoming) {
    if (opts.remove) map.delete(rule.zone);
    else map.set(rule.zone, rule);
  }
  return [...map.values()].sort((a, b) => a.zone.localeCompare(b.zone));
}

/** Render the managed dnsmasq configuration. */
export function renderDnsmasqConfig(opts: {
  zones: ZoneRule[];
  upstream: string[];
  upstreamFile?: string;
  listenAddress: string;
  listenPort: number;
}): string {
  const lines = [
    `# ${MANAGED_MARKER} — do not edit.`,
    "# Re-run the split-dns workflow to change this file.",
    `port=${opts.listenPort}`,
    `listen-address=${opts.listenAddress}`,
    "bind-interfaces",
    "cache-size=1000",
  ];
  if (opts.upstreamFile) {
    lines.push(`resolv-file=${opts.upstreamFile}`);
  } else {
    lines.push("no-resolv");
    for (const ns of opts.upstream) lines.push(`server=${ns}`);
  }
  for (const rule of opts.zones) {
    for (const ns of rule.nameservers) {
      lines.push(`server=/${rule.zone}/${ns}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Render the captured-upstream resolv.conf used when no live file exists. */
export function renderUpstreamResolvConf(nameservers: string[]): string {
  const lines = [`# ${MANAGED_MARKER} — captured DHCP nameservers.`];
  for (const ns of nameservers) lines.push(`nameserver ${ns}`);
  return `${lines.join("\n")}\n`;
}

/** Render the static client resolv.conf. */
export function renderClientResolvConf(
  listenAddress: string,
  search: string[],
  options: string[],
): string {
  const lines = [`# ${MANAGED_MARKER}`, `nameserver ${listenAddress}`];
  if (search.length > 0) lines.push(`search ${search.join(" ")}`);
  if (options.length > 0) lines.push(`options ${options.join(" ")}`);
  return `${lines.join("\n")}\n`;
}

/** Render the systemd unit used on Debian/Ubuntu. */
export function renderSystemdUnit(
  dnsmasqBinary: string,
  configPath: string,
): string {
  return [
    "[Unit]",
    `Description=split-dns conditional DNS forwarder (${MANAGED_MARKER})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${dnsmasqBinary} --keep-in-foreground --conf-file=${configPath}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** Render the NetworkManager drop-in that stops it rewriting resolv.conf. */
export function renderNetworkManagerConf(): string {
  return [
    `# ${MANAGED_MARKER}`,
    "[main]",
    "rc-manager=unmanaged",
    "",
  ].join("\n");
}

/** Render the resolvconf head fragment used by the Debian resolvconf path. */
export function renderResolvconfHead(listenAddress: string): string {
  return [
    `# ${MANAGED_MARKER}`,
    `nameserver ${listenAddress}`,
    "",
  ].join("\n");
}

/** Quote a single string for POSIX sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Base64-encode UTF-8 text without a dependency. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode base64 UTF-8 text. */
export function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** JSON string safe in a Nix expression. */
function nixString(value: string): string {
  return JSON.stringify(value);
}

/** Render the generated NixOS module. */
export function renderNixosModule(opts: {
  listenAddress: string;
  configPath: string;
  search: string[];
  manageResolver: boolean;
}): string {
  const search = opts.search.length > 0
    ? `[ ${opts.search.map(nixString).join(" ")} ]`
    : "[ ]";
  const resolver = opts.manageResolver
    ? `  environment.etc."resolv.conf".source = lib.mkForce splitDnsResolvConf;
  networking.nameservers = lib.mkForce [ ${nixString(opts.listenAddress)} ];
  networking.search = lib.mkForce ${search};

`
    : "";
  return `# ${MANAGED_MARKER} — do not edit.
{ lib, pkgs, ... }:
let
  splitDnsResolvConf = pkgs.writeText "split-dns-resolv.conf" ''
    nameserver ${opts.listenAddress}
    ${opts.search.length > 0 ? `search ${opts.search.join(" ")}` : ""}
  '';
in
{
${resolver}  systemd.services.split-dns = {
    description = "split-dns conditional DNS forwarder";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    serviceConfig = {
      ExecStart = "\${pkgs.dnsmasq}/bin/dnsmasq --keep-in-foreground --conf-file=${opts.configPath}";
      Restart = "on-failure";
      RestartSec = "2s";
    };
  };
}
`;
}

/** Render the NixOS wrapper that imports the host's config plus our module. */
export function renderNixosWrapper(
  originalConfig: string,
  modulePath: string,
): string {
  return `# ${MANAGED_MARKER} — do not edit.
{ ... }:
{
  imports = [ ${originalConfig} ${modulePath} ];
}
`;
}

/** Render a wrapper that reverts to the host's own configuration only. */
export function renderNixosRollbackWrapper(originalConfig: string): string {
  return `# ${MANAGED_MARKER} — rollback wrapper.
{ ... }:
{
  imports = [ ${originalConfig} ];
}
`;
}

/** Parse the managed state JSON; invalid or missing state yields null. */
export function parseState(text: string): ManagedState | null {
  if (!text || text === MISSING) return null;
  try {
    const parsed = StateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A fresh validation record. */
export function emptyValidation(): Validation {
  return ValidationSchema.parse({});
}

// ---------------------------------------------------------------------------
// DNS discovery
// ---------------------------------------------------------------------------

const defaultResolver: DnsResolver = {
  resolve: (name, type) =>
    // deno-lint-ignore no-explicit-any
    (Deno as any).resolveDns(name, type) as Promise<string[]>,
};

/** Resolve one nameserver entry (literal IP or hostname) to IP addresses. */
export async function resolveNameserverAddresses(
  entry: string,
  resolver: DnsResolver,
): Promise<string[]> {
  const value = entry.trim().replace(/\.$/, "");
  if (!value) throw new Error("nameserver entry is empty");
  // deno-lint-ignore no-control-regex
  if (/[\s/\x00-\x1f]/.test(value)) {
    throw new Error(`invalid nameserver ${JSON.stringify(entry)}`);
  }
  if (isIpAddress(value)) return [value];
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      const records = await resolver.resolve(value, type);
      out.push(...records.map((r) => r.trim()).filter((r) => isIpAddress(r)));
    } catch {
      // A missing AAAA is normal; a missing A is only fatal if AAAA is empty.
    }
  }
  if (out.length === 0) {
    throw new Error(
      `could not resolve nameserver ${JSON.stringify(entry)} to an address`,
    );
  }
  return dedupe(out);
}

/**
 * Discover a zone's authoritative nameservers and resolve them to addresses.
 * If the zone has no NS records, the caller must pass `nameservers`.
 */
export async function discoverAuthoritativeNameservers(
  zone: string,
  resolver: DnsResolver = defaultResolver,
): Promise<string[]> {
  let nsNames: string[];
  try {
    nsNames = await resolver.resolve(zone, "NS");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not read NS records for ${zone}: ${message}; pass explicit ` +
        "nameservers with --input 'nameservers:json=[\"1.2.3.4\"]'",
    );
  }
  const hostnames = dedupe(nsNames.map((n) => n.trim().replace(/\.$/, "")));
  if (hostnames.length === 0) {
    throw new Error(
      `zone ${zone} has no authoritative NS records; pass explicit nameservers`,
    );
  }
  const addresses: string[] = [];
  for (const host of hostnames) {
    addresses.push(...await resolveNameserverAddresses(host, resolver));
  }
  const unique = dedupe(addresses).sort(compareNameservers);
  if (unique.length === 0) {
    throw new Error(`no addresses found for the authoritative NS of ${zone}`);
  }
  return unique;
}

/** Normalize and resolve an explicit nameserver list. */
export async function resolveExplicitNameservers(
  entries: string[],
  resolver: DnsResolver = defaultResolver,
): Promise<string[]> {
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.trim()) continue;
    out.push(...await resolveNameserverAddresses(entry, resolver));
  }
  const unique = dedupe(out).sort(compareNameservers);
  if (unique.length === 0) {
    throw new Error("no usable nameservers were provided");
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the current user's home. */
export function expandHome(path: string): string {
  const home = Deno.env.get("HOME") ?? "";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  cmd: string,
  args: string[],
  stdin: string,
  timeoutSec: number,
): Promise<CommandResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    // swamp-quality-ignore deno-command: only ssh/sh are used; args are built from typed host specs and the payload is piped via stdin instead of being interpolated into a shell string.
    const child = new Deno.Command(cmd, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const process = child.spawn();
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
    const status = await process.status;
    const output = await process.output();
    return {
      code: status.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 124, stdout: "", stderr: message };
  } finally {
    clearTimeout(timer);
  }
}

interface RunOptions {
  sshUser: string;
  identityFile: string;
  connectTimeoutSec: number;
  commandTimeoutSec: number;
}

async function runOnHost(
  spec: HostSpec,
  script: string,
  opts: RunOptions,
): Promise<CommandResult> {
  const wrapper = "sh -s";
  if (spec.local) {
    return await runCommand(
      "sh",
      ["-c", wrapper],
      script,
      opts.commandTimeoutSec,
    );
  }
  const user = spec.user || opts.sshUser ||
    Deno.env.get("USER") || Deno.env.get("LOGNAME") || "root";
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${opts.connectTimeoutSec}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (opts.identityFile) args.push("-i", expandHome(opts.identityFile));
  args.push(
    "-p",
    String(spec.port || 22),
    `${user}@${spec.address}`,
    wrapper,
  );
  return await runCommand("ssh", args, script, opts.commandTimeoutSec);
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** The raw facts read from a target host. */
export interface HostFacts {
  /** `/etc/os-release` ID. */
  osId: string;
  /** `/etc/os-release` PRETTY_NAME. */
  osName: string;
  /** The target's short hostname. */
  hostname: string;
  /** Whether this is NixOS (`/etc/NIXOS`). */
  nixos: boolean;
  /** Whether systemd-resolved is active. */
  resolvedActive: boolean;
  /** Whether NetworkManager is active. */
  nmActive: boolean;
  /** Whether the resolvconf command is installed. */
  resolvconfPresent: boolean;
  /** Detected dnsmasq binary path ("" when missing). */
  dnsmasqPath: string;
  /** Whether `dig` is installed. */
  digPresent: boolean;
  /** Whether `resolvectl` is installed. */
  resolvectlPresent: boolean;
  /** Whether `getent` is installed. */
  getentPresent: boolean;
  /** Whether the split-dns unit is active. */
  serviceActive: boolean;
  /** Whether the split-dns unit is enabled at boot. */
  serviceEnabled: boolean;
  /** Current `/etc/resolv.conf` content. */
  resolvConf: string;
  /** Whether `/etc/resolv.conf` is a symlink. */
  resolvIsSymlink: boolean;
  /** Raw symlink target of `/etc/resolv.conf` ("" when not a symlink). */
  resolvTarget: string;
  /** `/run/systemd/resolve/resolv.conf` content (the DHCP upstream view). */
  upstreamResolvConf: string;
  /** `/run/NetworkManager/resolv.conf` content (NM's DHCP upstream view). */
  nmResolvConf: string;
  /** Managed state JSON, if present. */
  stateText: string;
  /** Managed dnsmasq config, if present. */
  configText: string;
  /** Captured upstream resolv.conf, if present. */
  upstreamConfigText: string;
  /** Managed systemd unit, if present. */
  unitText: string;
  /** NetworkManager drop-in, if present. */
  nmConfText: string;
  /** resolvconf head fragment, if present. */
  resolvconfHeadText: string;
  /** Generated NixOS module, if present. */
  nixosModuleText: string;
  /** Generated NixOS wrapper, if present. */
  nixosWrapperText: string;
  /** Raw `resolvectl dns` output. */
  resolvectlDns: string;
  /** Raw `nmcli` DNS output. */
  nmcliDns: string;
  /** Existing pre-apply snapshot directories. */
  backupDirs: string[];
}

function buildInspectScript(paths: {
  configDir: string;
  nixosModule: string;
  nixosWrapper: string;
}): string {
  const configPath = `${paths.configDir}/dnsmasq.conf`;
  const statePath = `${paths.configDir}/state.json`;
  const upstreamPath = `${paths.configDir}/upstream-resolv.conf`;
  return `set -u
sec() { printf '${SECTION_PREFIX}%s\\n' "$1"; }
end() { printf '\\n${SECTION_END}\\n'; }
b64() {
  if [ -f "$1" ]; then
    base64 -w0 "$1" 2>/dev/null || base64 "$1" 2>/dev/null | tr -d '\\n'
  else
    printf '${MISSING}'
  fi
}
sec OS_ID
. /etc/os-release 2>/dev/null || true
printf '%s' "\${ID:-}"
end
sec OS_NAME
. /etc/os-release 2>/dev/null || true
printf '%s' "\${PRETTY_NAME:-}"
end
sec HOSTNAME
hostname 2>/dev/null || true
end
sec NIXOS
if [ -e /etc/NIXOS ]; then printf 'yes'; else printf 'no'; fi
end
sec RESOLVED_ACTIVE
if systemctl is-active systemd-resolved >/dev/null 2>&1; then printf 'yes'; else printf 'no'; fi
end
sec NM_ACTIVE
if systemctl is-active NetworkManager >/dev/null 2>&1; then printf 'yes'; else printf 'no'; fi
end
sec RESOLVCONF_PRESENT
if command -v resolvconf >/dev/null 2>&1; then printf 'yes'; else printf 'no'; fi
end
sec DNSMASQ_BIN
for p in /usr/sbin/dnsmasq /usr/bin/dnsmasq /run/current-system/sw/bin/dnsmasq /nix/var/nix/profiles/default/bin/dnsmasq; do
  if [ -x "$p" ]; then printf '%s' "$p"; break; fi
done
end
sec DIG_PRESENT
if command -v dig >/dev/null 2>&1; then printf 'yes'; else printf 'no'; fi
end
sec RESOLVECTL_PRESENT
if command -v resolvectl >/dev/null 2>&1; then printf 'yes'; else printf 'no'; fi
end
sec GETENT_PRESENT
if command -v getent >/dev/null 2>&1; then printf 'yes'; else printf 'no'; fi
end
sec SERVICE_ACTIVE
systemctl is-active ${SERVICE_NAME} 2>/dev/null || true
end
sec SERVICE_ENABLED
systemctl is-enabled ${SERVICE_NAME} 2>/dev/null || true
end
sec RESOLV_CONF
b64 /etc/resolv.conf
end
sec RESOLV_IS_SYMLINK
if [ -L /etc/resolv.conf ]; then printf 'yes'; else printf 'no'; fi
end
sec RESOLV_TARGET
readlink /etc/resolv.conf 2>/dev/null || true
end
sec UPSTREAM_RESOLV_CONF
b64 /run/systemd/resolve/resolv.conf
end
sec NM_RESOLV_CONF
b64 /run/NetworkManager/resolv.conf
end
sec STATE
b64 ${shellQuote(statePath)}
end
sec CONFIG
b64 ${shellQuote(configPath)}
end
sec UPSTREAM_CONFIG
b64 ${shellQuote(upstreamPath)}
end
sec UNIT
b64 /etc/systemd/system/${SERVICE_NAME}
end
sec NM_CONF
b64 ${shellQuote(NM_CONF_REL)}
end
sec RESOLVCONF_HEAD
b64 ${shellQuote(RESOLVCONF_HEAD_REL)}
end
sec NIXOS_MODULE
b64 ${shellQuote(paths.nixosModule)}
end
sec NIXOS_WRAPPER
b64 ${shellQuote(paths.nixosWrapper)}
end
sec RESOLVECTL_DNS
resolvectl dns 2>/dev/null || true
end
sec NMCLI_DNS
nmcli -t -f IP4.DNS,IP6.DNS device show 2>/dev/null || true
end
sec BACKUP_DIRS
ls -1dt ${shellQuote(paths.configDir)}/backups/*/ 2>/dev/null | head -20 || true
end
`;
}

/** Parse a sectioned host script into a map of section name to text. */
export function parseSections(stdout: string): Map<string, string> {
  const sections = new Map<string, string>();
  const re = new RegExp(
    `${
      SECTION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }([A-Z0-9_]+)\\n([\\s\\S]*?)\\n${SECTION_END}`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(stdout)) !== null) {
    sections.set(match[1], match[2]);
  }
  return sections;
}

function section(sections: Map<string, string>, key: string): string {
  return (sections.get(key) ?? "").trim();
}

function decodeSection(text: string): string {
  if (!text || text === MISSING) return "";
  try {
    return fromBase64(text);
  } catch {
    return "";
  }
}

/** Turn the raw inspect output into typed host facts. */
export function parseHostFacts(stdout: string): HostFacts {
  const sections = parseSections(stdout);
  const bool = (key: string): boolean => section(sections, key) === "yes";
  return {
    osId: section(sections, "OS_ID"),
    osName: section(sections, "OS_NAME"),
    hostname: section(sections, "HOSTNAME"),
    nixos: bool("NIXOS"),
    resolvedActive: bool("RESOLVED_ACTIVE"),
    nmActive: bool("NM_ACTIVE"),
    resolvconfPresent: bool("RESOLVCONF_PRESENT"),
    dnsmasqPath: section(sections, "DNSMASQ_BIN"),
    digPresent: bool("DIG_PRESENT"),
    resolvectlPresent: bool("RESOLVECTL_PRESENT"),
    getentPresent: bool("GETENT_PRESENT"),
    serviceActive: section(sections, "SERVICE_ACTIVE") === "active",
    serviceEnabled: section(sections, "SERVICE_ENABLED") === "enabled",
    resolvConf: decodeSection(section(sections, "RESOLV_CONF")),
    resolvIsSymlink: bool("RESOLV_IS_SYMLINK"),
    resolvTarget: section(sections, "RESOLV_TARGET"),
    upstreamResolvConf: decodeSection(
      section(sections, "UPSTREAM_RESOLV_CONF"),
    ),
    nmResolvConf: decodeSection(section(sections, "NM_RESOLV_CONF")),
    stateText: decodeSection(section(sections, "STATE")),
    configText: decodeSection(section(sections, "CONFIG")),
    upstreamConfigText: decodeSection(section(sections, "UPSTREAM_CONFIG")),
    unitText: decodeSection(section(sections, "UNIT")),
    nmConfText: decodeSection(section(sections, "NM_CONF")),
    resolvconfHeadText: decodeSection(section(sections, "RESOLVCONF_HEAD")),
    nixosModuleText: decodeSection(section(sections, "NIXOS_MODULE")),
    nixosWrapperText: decodeSection(section(sections, "NIXOS_WRAPPER")),
    resolvectlDns: sections.get("RESOLVECTL_DNS") ?? "",
    nmcliDns: sections.get("NMCLI_DNS") ?? "",
    backupDirs: section(sections, "BACKUP_DIRS").split("\n").filter(Boolean),
  };
}

function resolveMode(facts: HostFacts): string {
  if (facts.nixos) return "nixos";
  if (facts.nmActive) return "networkmanager";
  if (facts.resolvconfPresent) return "resolvconf";
  return "static";
}

/** Choose the source of the default (DHCP) nameservers. */
export function chooseUpstream(
  facts: HostFacts,
  listenAddress: string,
): { upstreamFile: string; nameservers: string[]; source: string } {
  const fromUpstream = usableUpstream(
    parseResolvConf(facts.upstreamResolvConf).nameservers,
    listenAddress,
  );
  if (fromUpstream.length > 0) {
    return {
      upstreamFile: "/run/systemd/resolve/resolv.conf",
      nameservers: fromUpstream,
      source: "/run/systemd/resolve/resolv.conf",
    };
  }
  const fromNm = usableUpstream(
    parseResolvConf(facts.nmResolvConf).nameservers,
    listenAddress,
  );
  if (fromNm.length > 0) {
    return {
      upstreamFile: "/run/NetworkManager/resolv.conf",
      nameservers: fromNm,
      source: "/run/NetworkManager/resolv.conf",
    };
  }
  const fromResolv = usableUpstream(
    parseResolvConf(facts.resolvConf).nameservers,
    listenAddress,
  );
  if (fromResolv.length > 0) {
    return {
      upstreamFile: "",
      nameservers: fromResolv,
      source: "/etc/resolv.conf",
    };
  }
  const fromResolvectl = usableUpstream(
    parseResolvectlDns(facts.resolvectlDns),
    listenAddress,
  );
  if (fromResolvectl.length > 0) {
    return {
      upstreamFile: "",
      nameservers: fromResolvectl,
      source: "resolvectl",
    };
  }
  const fromNmcli = usableUpstream(
    parseNmcliDns(facts.nmcliDns),
    listenAddress,
  );
  if (fromNmcli.length > 0) {
    return {
      upstreamFile: "",
      nameservers: fromNmcli,
      source: "nmcli",
    };
  }
  const fromManaged = usableUpstream(
    parseResolvConf(facts.upstreamConfigText).nameservers,
    listenAddress,
  );
  if (fromManaged.length > 0) {
    return {
      upstreamFile: "",
      nameservers: fromManaged,
      source: "managed upstream snapshot",
    };
  }
  return { upstreamFile: "", nameservers: [], source: "none" };
}

// ---------------------------------------------------------------------------
// Validation scripts
// ---------------------------------------------------------------------------

function buildTransientValidationScript(opts: {
  config: string;
  zone: string;
  controlName: string;
  testName: string;
  dnsmasqPath: string;
  port: number;
}): string {
  const configB64 = toBase64(opts.config);
  const zone = shellQuote(opts.zone);
  const control = shellQuote(opts.controlName);
  const testName = shellQuote(opts.testName);
  return `set -u
TMPD=$(mktemp -d /tmp/split-dns-test.XXXXXX 2>/dev/null || mktemp -d)
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$TMPD"
}
trap cleanup EXIT
printf '%s' ${
    shellQuote(configB64)
  } | base64 -d > "$TMPD/dnsmasq.conf" 2>/dev/null
sed -i 's/^port=.*/port=${opts.port}/' "$TMPD/dnsmasq.conf" 2>/dev/null
sed -i 's/^listen-address=.*/listen-address=127.0.0.1/' "$TMPD/dnsmasq.conf" 2>/dev/null
sec() { printf '${SECTION_PREFIX}%s\\n' "$1"; }
end() { printf '\\n${SECTION_END}\\n'; }
DNSMASQ=${shellQuote(opts.dnsmasqPath)}
sec CONFIG_TEST
if [ -n "$DNSMASQ" ] && [ -x "$DNSMASQ" ]; then
  "$DNSMASQ" --test --conf-file="$TMPD/dnsmasq.conf" 2>&1
  printf '\\nEXIT:%s\\n' "$?"
else
  printf 'dnsmasq is not installed\\nEXIT:127\\n'
fi
end
if [ -n "$DNSMASQ" ] && [ -x "$DNSMASQ" ] && command -v dig >/dev/null 2>&1; then
  "$DNSMASQ" --no-daemon --conf-file="$TMPD/dnsmasq.conf" >"$TMPD/run.out" 2>"$TMPD/run.err" &
  PID=$!
  sleep 0.7
  sec TRANSIENT_ZONE
  dig +time=3 +tries=2 @127.0.0.1 -p ${opts.port} SOA ${zone} +short 2>&1 || true
  end
  sec TRANSIENT_CONTROL
  dig +time=3 +tries=2 @127.0.0.1 -p ${opts.port} A ${control} +short 2>&1 || true
  end
  if [ -n ${testName} ]; then
    sec TRANSIENT_TEST
    dig +time=3 +tries=2 @127.0.0.1 -p ${opts.port} A ${testName} +short 2>&1 || true
    end
  fi
  sec TRANSIENT_ERROR
  cat "$TMPD/run.err" 2>/dev/null || true
  end
fi
`;
}

function buildVerifyScript(opts: {
  listenAddress: string;
  listenPort: number;
  zone: string;
  controlName: string;
  testName: string;
  dnsmasqPath: string;
  configPath: string;
  manageResolver: boolean;
  resolverMode: string;
}): string {
  const zone = shellQuote(opts.zone);
  const control = shellQuote(opts.controlName);
  const testName = shellQuote(opts.testName);
  const configPath = shellQuote(opts.configPath);
  const dnsmasq = shellQuote(opts.dnsmasqPath);
  const systemCheck = opts.manageResolver
    ? `
sec SYSTEM_ZONE
if command -v dig >/dev/null 2>&1 && [ -n ${zone} ]; then
  dig +time=3 +tries=2 SOA ${zone} +short 2>&1 || true
fi
end
sec SYSTEM_CONTROL
if command -v dig >/dev/null 2>&1 && [ -n ${control} ]; then
  dig +time=3 +tries=2 A ${control} +short 2>&1 || true
fi
end
sec SYSTEM_TEST
if command -v dig >/dev/null 2>&1 && [ -n ${testName} ]; then
  dig +time=3 +tries=2 A ${testName} +short 2>&1 || true
fi
end
sec RESOLVECTL_ZONE
if command -v resolvectl >/dev/null 2>&1 && [ -n ${zone} ]; then
  resolvectl query --type=SOA ${zone} 2>&1 || true
fi
end
sec RESOLVECTL_CONTROL
if command -v resolvectl >/dev/null 2>&1 && [ -n ${control} ]; then
  resolvectl query ${control} 2>&1 || true
fi
end
sec GETENT_TEST
if command -v getent >/dev/null 2>&1 && [ -n ${testName} ]; then
  getent hosts ${testName} 2>&1 || true
fi
end`
    : "";
  return `set -u
sec() { printf '${SECTION_PREFIX}%s\\n' "$1"; }
end() { printf '\\n${SECTION_END}\\n'; }
DNSMASQ=${dnsmasq}
if [ -z "$DNSMASQ" ] || [ ! -x "$DNSMASQ" ]; then
  DNSMASQ=$(command -v dnsmasq 2>/dev/null || true)
fi
CONFIG=${configPath}
sec SERVICE_ACTIVE
systemctl is-active ${SERVICE_NAME} 2>/dev/null || true
end
sec CONFIG_TEST
if [ -n "$DNSMASQ" ] && [ -x "$DNSMASQ" ] && [ -f "$CONFIG" ]; then
  "$DNSMASQ" --test --conf-file="$CONFIG" 2>&1
  printf '\\nEXIT:%s\\n' "$?"
else
  printf 'dnsmasq or config missing\\nEXIT:127\\n'
fi
end
sec LOCAL_ZONE
if command -v dig >/dev/null 2>&1 && [ -n ${zone} ]; then
  dig +time=3 +tries=2 @${
    shellQuote(opts.listenAddress)
  } -p ${opts.listenPort} SOA ${zone} +short 2>&1 || true
fi
end
sec LOCAL_CONTROL
if command -v dig >/dev/null 2>&1 && [ -n ${control} ]; then
  dig +time=3 +tries=2 @${
    shellQuote(opts.listenAddress)
  } -p ${opts.listenPort} A ${control} +short 2>&1 || true
fi
end
sec LOCAL_TEST
if command -v dig >/dev/null 2>&1 && [ -n ${testName} ]; then
  dig +time=3 +tries=2 @${
    shellQuote(opts.listenAddress)
  } -p ${opts.listenPort} A ${testName} +short 2>&1 || true
fi
end
sec RESOLV_CONF
cat /etc/resolv.conf 2>/dev/null || true
end
sec RESOLVCONF_HEAD
cat ${shellQuote(RESOLVCONF_HEAD_REL)} 2>/dev/null || true
end
sec NM_CONF
cat ${shellQuote(NM_CONF_REL)} 2>/dev/null || true
end
sec SERVICE_STATUS
systemctl status --no-pager ${SERVICE_NAME} 2>&1 || true
end
${systemCheck}
`;
}

function queryFrom(output: string, present: boolean): QueryResult {
  const text = output.trim();
  if (!present) return { status: "skipped", output: text };
  if (!text) return { status: "failed", output: "empty answer" };
  if (/not found|no such|NXDOMAIN|SERVFAIL|REFUSED|timed out/i.test(text)) {
    return { status: "failed", output: text };
  }
  if (text.startsWith(";;")) return { status: "failed", output: text };
  return { status: "passed", output: text };
}

/** The parsed live-verification result. */
export interface VerifyResult {
  /** Whether the unit is active. */
  serviceActive: boolean;
  /** Whether `dnsmasq --test` accepted the installed config. */
  configTest: boolean;
  /** Config-test output. */
  configMessage: string;
  /** Zone query through the local forwarder. */
  localZone: QueryResult;
  /** Control-name query through the local forwarder. */
  localControl: QueryResult;
  /** Optional test-name query through the local forwarder. */
  localTest: QueryResult;
  /** Zone query through the client resolver. */
  systemZone: QueryResult;
  /** Control-name query through the client resolver. */
  systemControl: QueryResult;
  /** Optional test-name query through the client resolver. */
  systemTest: QueryResult;
  /** `/etc/resolv.conf` as read during verification. */
  resolvConf: string;
  /** resolvconf head fragment as read during verification. */
  resolvconfHead: string;
  /** NetworkManager drop-in as read during verification. */
  nmConf: string;
  /** `systemctl status` output. */
  serviceStatus: string;
  /** Raw `resolvectl` zone query output. */
  resolvectlZone: string;
  /** Raw `resolvectl` control query output. */
  resolvectlControl: string;
  /** Raw `getent hosts` output. */
  getent: string;
}

/** Parse the verification script's output. */
export function parseVerifyOutput(
  stdout: string,
  opts: {
    digPresent: boolean;
    resolvectlPresent: boolean;
    manageResolver: boolean;
    zone: string;
    controlName: string;
    testName: string;
  },
): VerifyResult {
  const s = parseSections(stdout);
  const configRaw = section(s, "CONFIG_TEST");
  const configTest = /EXIT:0\b/.test(configRaw);
  const configMessage = configRaw.replace(/\n?EXIT:\d+\s*$/, "").trim();
  const dig = opts.digPresent;
  const resolved = opts.resolvectlPresent;
  const localZone = queryFrom(section(s, "LOCAL_ZONE"), dig && !!opts.zone);
  const localControl = queryFrom(
    section(s, "LOCAL_CONTROL"),
    dig && !!opts.controlName,
  );
  const localTest = queryFrom(section(s, "LOCAL_TEST"), dig && !!opts.testName);
  let systemZone = queryFrom(
    section(s, "SYSTEM_ZONE"),
    dig && opts.manageResolver && !!opts.zone,
  );
  let systemControl = queryFrom(
    section(s, "SYSTEM_CONTROL"),
    dig && opts.manageResolver && !!opts.controlName,
  );
  let systemTest = queryFrom(
    section(s, "SYSTEM_TEST"),
    dig && opts.manageResolver && !!opts.testName,
  );
  const resolvectlZone = s.get("RESOLVECTL_ZONE") ?? "";
  const resolvectlControl = s.get("RESOLVECTL_CONTROL") ?? "";
  const getent = s.get("GETENT_TEST") ?? "";
  if (
    systemZone.status === "skipped" && resolved && opts.manageResolver &&
    !!opts.zone
  ) {
    systemZone = queryFrom(resolvectlZone, true);
  }
  if (
    systemControl.status === "skipped" && resolved && opts.manageResolver &&
    !!opts.controlName
  ) {
    systemControl = queryFrom(resolvectlControl, true);
  }
  if (
    systemTest.status === "skipped" && opts.manageResolver && !!opts.testName
  ) {
    systemTest = queryFrom(getent, true);
  }
  return {
    serviceActive: section(s, "SERVICE_ACTIVE") === "active",
    configTest,
    configMessage,
    localZone,
    localControl,
    localTest,
    systemZone,
    systemControl,
    systemTest,
    resolvConf: s.get("RESOLV_CONF") ?? "",
    resolvconfHead: s.get("RESOLVCONF_HEAD") ?? "",
    nmConf: s.get("NM_CONF") ?? "",
    serviceStatus: s.get("SERVICE_STATUS") ?? "",
    resolvectlZone,
    resolvectlControl,
    getent,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface HostPlan {
  spec: HostSpec;
  ok: boolean;
  facts: HostFacts;
  resolverMode: string;
  state: ManagedState | null;
  zones: ZoneRule[];
  currentZone: string;
  currentNameservers: string[];
  currentNameserverSource: string;
  upstreamFile: string;
  upstream: string[];
  upstreamSource: string;
  nameservers: string[];
  nameserverSource: string;
  configPath: string;
  desiredConfig: string;
  desiredUnit: string;
  desiredNmConf: string;
  desiredResolvconfHead: string;
  desiredClientResolvConf: string;
  desiredUpstreamResolvConf: string;
  desiredState: string;
  desiredNixosModule: string;
  desiredNixosWrapper: string;
  changed: boolean;
  validation: Validation;
  warnings: string[];
  error: string;
  checkedAt: string;
}

function makeResult(
  spec: HostSpec,
  action: HostResult["action"],
  checkedAt: string,
): HostResult {
  return {
    host: spec.name,
    address: spec.address,
    local: spec.local,
    ok: true,
    action,
    os: "",
    osName: "",
    hostname: "",
    resolverMode: "",
    zone: "",
    zones: [],
    nameservers: [],
    nameserverSource: "",
    upstream: [],
    upstreamSource: "",
    changed: false,
    configPath: "",
    serviceName: SERVICE_NAME,
    validation: emptyValidation(),
    warnings: [],
    error: "",
    checkedAt,
  };
}

function planToResult(
  action: HostResult["action"],
  plan: HostPlan,
  checkedAt: string,
): HostResult {
  return {
    host: plan.spec.name,
    address: plan.spec.address,
    local: plan.spec.local,
    ok: plan.ok,
    action,
    os: plan.facts.osId,
    osName: plan.facts.osName,
    hostname: plan.facts.hostname,
    resolverMode: plan.resolverMode,
    zone: plan.currentZone,
    zones: plan.zones,
    nameservers: plan.currentNameservers,
    nameserverSource: plan.currentNameserverSource,
    upstream: plan.upstream,
    upstreamSource: plan.upstreamSource,
    changed: plan.changed,
    configPath: plan.configPath,
    serviceName: SERVICE_NAME,
    validation: plan.validation,
    warnings: plan.warnings,
    error: plan.error,
    checkedAt,
  };
}

interface RunOptionsResolved {
  hosts: HostSpec[];
  sshUser: string;
  identityFile: string;
  connectTimeoutSec: number;
  commandTimeoutSec: number;
  parallel: number;
  configDir: string;
  listenAddress: string;
  listenPort: number;
  manageResolver: boolean;
  installPackages: boolean;
  controlName: string;
  testName: string;
  nixosRebuild: boolean;
  nixosRebuildCommand: string;
  dnsmasqBinary: string;
  backupKeep: number;
  stagingDir: string;
  runId: string;
}

type AnyArgs = Partial<ApplyArgs & HostsArgs>;

/** The client resolver has no port syntax, so a managed resolver needs port 53. */
function managedResolverPortError(opts: RunOptionsResolved): string | null {
  if (opts.manageResolver && opts.listenPort !== 53) {
    return "listenPort must be 53 when manageResolver is true: " +
      "/etc/resolv.conf cannot carry a port. Set manageResolver=false to " +
      "run the forwarder on a high port, or choose another loopback address.";
  }
  return null;
}

function resolveOptions(g: GlobalArgs, args: AnyArgs): RunOptionsResolved {
  return {
    hosts: normalizeHosts(args.hosts ?? g.hosts, args.sshUser ?? g.sshUser),
    sshUser: args.sshUser ?? g.sshUser,
    identityFile: args.identityFile ?? g.identityFile,
    connectTimeoutSec: g.connectTimeoutSec,
    commandTimeoutSec: g.commandTimeoutSec,
    parallel: args.parallel ?? g.parallel,
    configDir: args.configDir ?? g.configDir,
    listenAddress: args.listenAddress ?? g.listenAddress,
    listenPort: args.listenPort ?? g.listenPort,
    manageResolver: args.manageResolver ?? g.manageResolver,
    installPackages: args.installPackages ?? g.installPackages,
    controlName: args.controlName ?? g.controlName,
    testName: args.testName ?? g.testName,
    nixosRebuild: args.nixosRebuild ?? g.nixosRebuild,
    nixosRebuildCommand: g.nixosRebuildCommand,
    dnsmasqBinary: g.dnsmasqBinary,
    backupKeep: g.backupKeep,
    stagingDir: args.stagingDir ?? g.stagingDir,
    runId: args.runId ?? "",
  };
}

function inspectScript(opts: RunOptionsResolved): string {
  return buildInspectScript({
    configDir: opts.configDir,
    nixosModule: DEFAULT_NIXOS_MODULE,
    nixosWrapper: DEFAULT_NIXOS_WRAPPER,
  });
}

async function inspectHost(
  spec: HostSpec,
  opts: RunOptionsResolved,
): Promise<HostFacts> {
  const result = await runOnHost(spec, inspectScript(opts), opts);
  if (result.code !== 0) {
    throw new Error(
      `inspection failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim() || "no output"
      }`,
    );
  }
  return parseHostFacts(result.stdout);
}

// ---------------------------------------------------------------------------
// Apply / restore scripts
// ---------------------------------------------------------------------------

function snapshotFunctionsScript(opts: {
  configPath: string;
  statePath: string;
  upstreamPath: string;
  unitPath: string;
  nixosModule: string;
  nixosWrapper: string;
}): string {
  return `save_one() {
  key="$1"; path="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then
    cp -a "$path" "$SNAP/$key" 2>/dev/null || true
    : > "$SNAP/$key.present"
  else
    : > "$SNAP/$key.absent"
  fi
}
snapshot_into() {
  SNAP="$1"
  install -d -m 700 "$SNAP" || return 1
  if [ -L /etc/resolv.conf ]; then
    readlink /etc/resolv.conf > "$SNAP/resolv.conf.link" 2>/dev/null || true
  elif [ -e /etc/resolv.conf ]; then
    cp -a /etc/resolv.conf "$SNAP/resolv.conf.file" 2>/dev/null || true
  fi
  save_one nm ${shellQuote(NM_CONF_REL)}
  save_one resolvhead ${shellQuote(RESOLVCONF_HEAD_REL)}
  save_one unit ${shellQuote(opts.unitPath)}
  save_one conf ${shellQuote(opts.configPath)}
  save_one state ${shellQuote(opts.statePath)}
  save_one upstream ${shellQuote(opts.upstreamPath)}
  save_one nixmodule ${shellQuote(opts.nixosModule)}
  save_one nixwrapper ${shellQuote(opts.nixosWrapper)}
  : > "$SNAP/.ready"
}`;
}

function restoreSnapshotScript(opts: {
  snapshotDir: string;
  configDir: string;
  configPath: string;
  statePath: string;
  upstreamPath: string;
  unitPath: string;
  nixosModule: string;
  nixosWrapper: string;
  hadService: boolean;
  serviceWasActive: boolean;
}): string {
  return `set -eu
SNAP=${shellQuote(opts.snapshotDir)}
if [ ! -f "$SNAP/.ready" ]; then
  printf 'no snapshot at %s; nothing to restore\\n' "$SNAP"
else
if [ -f "$SNAP/resolv.conf.link" ]; then
  rm -f /etc/resolv.conf
  ln -s "$(cat "$SNAP/resolv.conf.link")" /etc/resolv.conf
elif [ -f "$SNAP/resolv.conf.file" ]; then
  rm -f /etc/resolv.conf
  cp -a "$SNAP/resolv.conf.file" /etc/resolv.conf
fi
restore_one() {
  key="$1"; path="$2"
  if [ -e "$SNAP/$key" ]; then
    install -d -m 755 "$(dirname "$path")" 2>/dev/null || true
    cp -a "$SNAP/$key" "$path"
  elif [ -e "$SNAP/$key.absent" ]; then
    rm -f "$path"
  fi
}
restore_one nm ${shellQuote(NM_CONF_REL)}
restore_one resolvhead ${shellQuote(RESOLVCONF_HEAD_REL)}
restore_one unit ${shellQuote(opts.unitPath)}
restore_one conf ${shellQuote(opts.configPath)}
restore_one state ${shellQuote(opts.statePath)}
restore_one upstream ${shellQuote(opts.upstreamPath)}
restore_one nixmodule ${shellQuote(opts.nixosModule)}
restore_one nixwrapper ${shellQuote(opts.nixosWrapper)}
systemctl daemon-reload >/dev/null 2>&1 || true
if [ "${opts.hadService ? "yes" : "no"}" = "yes" ]; then
  if [ "${opts.serviceWasActive ? "yes" : "no"}" = "yes" ]; then
    systemctl restart ${SERVICE_NAME}
  else
    systemctl stop ${SERVICE_NAME} >/dev/null 2>&1 || true
  fi
else
  systemctl stop ${SERVICE_NAME} >/dev/null 2>&1 || true
  systemctl disable ${SERVICE_NAME} >/dev/null 2>&1 || true
  rm -f ${shellQuote(opts.unitPath)}
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
systemctl reload NetworkManager >/dev/null 2>&1 || true
if command -v resolvconf >/dev/null 2>&1; then resolvconf -u >/dev/null 2>&1 || true; fi
printf 'restored\\n'
fi
`;
}

function writeFileSnippet(path: string, content: string, mode: string): string {
  const b64 = toBase64(content);
  return `write_file ${shellQuote(path)} ${mode} ${shellQuote(b64)}`;
}

/** Shell gate the staged apply script runs after activation; exits nonzero on failure. */
function buildVerifyGateScript(
  plan: HostPlan,
  opts: RunOptionsResolved,
): string {
  const configPath = `${opts.configDir}/dnsmasq.conf`;
  const dnsmasq = plan.facts.dnsmasqPath || "";
  return `set -eu
fail() { echo "split-dns verify: $*" >&2; exit 1; }
DNSMASQ=${shellQuote(dnsmasq)}
CONFIG=${shellQuote(configPath)}
LISTEN=${shellQuote(opts.listenAddress)}
PORT=${opts.listenPort}
ZONE=${shellQuote(plan.currentZone)}
CONTROL=${shellQuote(opts.controlName)}
TESTNAME=${shellQuote(opts.testName)}
MANAGE=${opts.manageResolver ? "true" : "false"}
if [ "$MANAGE" = "true" ]; then
  grep -Eq "nameserver[[:space:]]+$LISTEN([[:space:]]|$)" /etc/resolv.conf || fail "/etc/resolv.conf does not point at $LISTEN"
fi
if [ -n "$DNSMASQ" ] && [ -x "$DNSMASQ" ]; then
  "$DNSMASQ" --test --conf-file="$CONFIG" || fail "dnsmasq --test failed for $CONFIG"
else
  echo "split-dns verify: dnsmasq not found; config test skipped" >&2
fi
systemctl is-active --quiet ${SERVICE_NAME} || fail "${SERVICE_NAME} is not active"
if command -v dig >/dev/null 2>&1; then
  if [ -n "$ZONE" ]; then
    out=$(dig +time=3 +tries=2 @$LISTEN -p $PORT SOA "$ZONE" +short 2>&1) || fail "local SOA query failed: $out"
    [ -n "$out" ] || fail "local SOA query returned no answer for $ZONE"
  fi
  if [ -n "$CONTROL" ]; then
    out=$(dig +time=3 +tries=2 @$LISTEN -p $PORT A "$CONTROL" +short 2>&1) || fail "local control query failed: $out"
    [ -n "$out" ] || fail "local control query returned no answer for $CONTROL"
  fi
  if [ -n "$TESTNAME" ]; then
    out=$(dig +time=3 +tries=2 @$LISTEN -p $PORT A "$TESTNAME" +short 2>&1) || fail "local test query failed: $out"
    [ -n "$out" ] || fail "local test query returned no answer for $TESTNAME"
  fi
  if [ "$MANAGE" = "true" ]; then
    if [ -n "$ZONE" ]; then
      out=$(dig +time=3 +tries=2 SOA "$ZONE" +short 2>&1) || fail "system SOA query failed: $out"
      [ -n "$out" ] || fail "system SOA query returned no answer for $ZONE"
    fi
    if [ -n "$CONTROL" ]; then
      out=$(dig +time=3 +tries=2 A "$CONTROL" +short 2>&1) || fail "system control query failed: $out"
      [ -n "$out" ] || fail "system control query returned no answer for $CONTROL"
    fi
  fi
elif command -v resolvectl >/dev/null 2>&1; then
  if [ "$MANAGE" = "true" ]; then
    if [ -n "$ZONE" ]; then
      resolvectl query --type=SOA "$ZONE" >/dev/null 2>&1 || fail "resolvectl SOA query failed for $ZONE"
    fi
    if [ -n "$CONTROL" ]; then
      resolvectl query "$CONTROL" >/dev/null 2>&1 || fail "resolvectl query failed for $CONTROL"
    fi
  fi
elif [ "$MANAGE" = "true" ]; then
  if [ -n "$CONTROL" ] && command -v getent >/dev/null 2>&1; then
    getent hosts "$CONTROL" >/dev/null 2>&1 || fail "getent failed for $CONTROL"
  else
    echo "split-dns verify: no dig/resolvectl/getent; live query checks skipped" >&2
  fi
fi
echo "split-dns verify: ok"
`;
}

/** Shell gate the staged remove script runs after removal; exits nonzero if anything remains. */
function buildVerifyRemovedScript(
  facts: HostFacts,
  opts: RunOptionsResolved,
): string {
  const paths = [
    `${opts.configDir}/dnsmasq.conf`,
    `${opts.configDir}/state.json`,
    ...(facts.nixos ? [DEFAULT_NIXOS_MODULE, DEFAULT_NIXOS_WRAPPER] : []),
  ];
  const checks = paths.map((path) =>
    `if [ -e ${shellQuote(path)} ]; then fail "still present: ${path}"; fi`
  ).join("\n");
  return `set -eu
fail() { echo "split-dns remove verify: $*" >&2; exit 1; }
${checks}
if systemctl is-active --quiet ${SERVICE_NAME}; then fail "${SERVICE_NAME} is still active"; fi
if [ -f /etc/resolv.conf ] && grep -q ${
    shellQuote(MANAGED_MARKER)
  } /etc/resolv.conf; then
  fail "/etc/resolv.conf still points at split-dns"
fi
CONTROL=${shellQuote(opts.controlName)}
if [ -n "$CONTROL" ]; then
  if command -v dig >/dev/null 2>&1; then
    out=$(dig +time=3 +tries=2 A "$CONTROL" +short 2>&1) || fail "control query failed: $out"
    [ -n "$out" ] || fail "control query returned no answer for $CONTROL"
  elif command -v resolvectl >/dev/null 2>&1; then
    resolvectl query "$CONTROL" >/dev/null 2>&1 || fail "resolvectl query failed for $CONTROL"
  elif command -v getent >/dev/null 2>&1; then
    getent hosts "$CONTROL" >/dev/null 2>&1 || fail "getent failed for $CONTROL"
  else
    echo "split-dns remove verify: no client resolver tool; live query skipped" >&2
  fi
fi
echo "split-dns remove verify: ok"
`;
}

function buildApplyScript(
  plan: HostPlan,
  opts: RunOptionsResolved,
  paths: {
    applyScript: string;
    rollbackScript: string;
    verifyScript: string;
  },
): string {
  const configPath = `${opts.configDir}/dnsmasq.conf`;
  const statePath = `${opts.configDir}/state.json`;
  const upstreamPath = `${opts.configDir}/upstream-resolv.conf`;
  const unitPath = `/etc/systemd/system/${SERVICE_NAME}`;
  const stamp = plan.checkedAt.replace(/[:.]/g, "-");
  const backupDir = `${opts.configDir}/backups/${stamp}`;
  const originalDir = `${opts.configDir}/original`;
  const dnsmasq = plan.facts.dnsmasqPath || "/usr/sbin/dnsmasq";
  const lines: string[] = [
    "set -eu",
    `APPLY_SCRIPT=${shellQuote(paths.applyScript)}`,
    `ROLLBACK_SCRIPT=${shellQuote(paths.rollbackScript)}`,
    `VERIFY_SCRIPT=${shellQuote(paths.verifyScript)}`,
    `CONFIG_PATH=${shellQuote(configPath)}`,
    `CHANGED=${plan.changed ? "true" : "false"}`,
    `CONFIG_DIR=${shellQuote(opts.configDir)}`,
    `BACKUP_DIR=${shellQuote(backupDir)}`,
    `ORIGINAL_DIR=${shellQuote(originalDir)}`,
    "on_exit() {",
    "  code=$?",
    "  trap - EXIT",
    '  if [ "$code" -ne 0 ]; then',
    '    echo "###SPLITDNS:APPLY_FAILED:exit=$code" >&2',
    '    if [ -f "$ROLLBACK_SCRIPT" ]; then',
    '      sh "$ROLLBACK_SCRIPT" || echo "###SPLITDNS:ROLLBACK_FAILED" >&2',
    "    fi",
    "  fi",
    '  exit "$code"',
    "}",
    "trap on_exit EXIT",
    'if [ "$CHANGED" = "false" ]; then',
    '  if sh "$VERIFY_SCRIPT" >/dev/null 2>&1; then',
    '    echo "###SPLITDNS:ALREADY_OK"',
    "    exit 0",
    "  fi",
    '  echo "###SPLITDNS:NOW-CHANGED: live verification failed; re-applying" >&2',
    "fi",
    "write_file() {",
    '  path="$1"; mode="$2"; b64="$3"',
    '  dir=$(dirname "$path")',
    '  install -d -m 755 "$dir" || return 1',
    '  tmp=$(mktemp "$dir/.split-dns.XXXXXX") || return 1',
    '  if ! printf "%s" "$b64" | base64 -d > "$tmp" 2>/dev/null; then',
    '    rm -f "$tmp"; echo "could not decode content for $path" >&2; return 1',
    "  fi",
    '  chmod "$mode" "$tmp"',
    '  mv -f "$tmp" "$path"',
    "}",
    `install -d -m 755 ${shellQuote(opts.configDir)}`,
    snapshotFunctionsScript({
      configPath,
      statePath,
      upstreamPath,
      unitPath,
      nixosModule: DEFAULT_NIXOS_MODULE,
      nixosWrapper: DEFAULT_NIXOS_WRAPPER,
    }),
    `if [ ! -f ${shellQuote(`${originalDir}/.ready`)} ]; then`,
    '  snapshot_into "$ORIGINAL_DIR" || exit 1',
    "fi",
    'snapshot_into "$BACKUP_DIR" || exit 1',
  ];

  if (plan.facts.nixos) {
    lines.push(
      writeFileSnippet(configPath, plan.desiredConfig, "0644"),
      writeFileSnippet(statePath, plan.desiredState, "0644"),
    );
    if (plan.desiredUpstreamResolvConf) {
      lines.push(
        writeFileSnippet(upstreamPath, plan.desiredUpstreamResolvConf, "0644"),
      );
    }
    lines.push(
      writeFileSnippet(DEFAULT_NIXOS_MODULE, plan.desiredNixosModule, "0644"),
      writeFileSnippet(DEFAULT_NIXOS_WRAPPER, plan.desiredNixosWrapper, "0644"),
    );
    if (!opts.nixosRebuild) {
      lines.push(
        'echo "nixosRebuild is false: files written but the system was not rebuilt" >&2',
        "exit 30",
      );
    } else {
      lines.push(
        "printf '###SPLITDNS:REBUILD\\n'",
        `${opts.nixosRebuildCommand} 2>&1 || { printf '\\n###SPLITDNS:END\\n'; exit 31; }`,
        "printf '\\n###SPLITDNS:END\\n'",
      );
    }
  } else {
    lines.push(
      writeFileSnippet(configPath, plan.desiredConfig, "0644"),
      writeFileSnippet(statePath, plan.desiredState, "0644"),
    );
    if (plan.desiredUpstreamResolvConf) {
      lines.push(
        writeFileSnippet(upstreamPath, plan.desiredUpstreamResolvConf, "0644"),
      );
    }
    lines.push(
      writeFileSnippet(
        unitPath,
        renderSystemdUnit(dnsmasq, configPath),
        "0644",
      ),
    );
    if (opts.manageResolver && plan.resolverMode === "networkmanager") {
      lines.push(
        writeFileSnippet(
          NM_CONF_REL,
          renderNetworkManagerConf(),
          "0644",
        ),
        "systemctl reload NetworkManager >/dev/null 2>&1 || systemctl restart NetworkManager >/dev/null 2>&1 || true",
      );
    }
    if (opts.manageResolver && plan.resolverMode === "resolvconf") {
      lines.push(
        writeFileSnippet(
          RESOLVCONF_HEAD_REL,
          renderResolvconfHead(opts.listenAddress),
          "0644",
        ),
      );
    }
    lines.push(
      'if [ -z "$(command -v dnsmasq 2>/dev/null || true)" ] && [ -z ' +
        shellQuote(plan.facts.dnsmasqPath) + " ]; then",
      `  if [ ${
        opts.installPackages ? '"yes"' : '"no"'
      } = "yes" ] && command -v apt-get >/dev/null 2>&1; then`,
      "    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true",
      "    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsmasq-base >/dev/null 2>&1 || { echo 'apt-get install dnsmasq-base failed' >&2; exit 20; }",
      "  else",
      "    echo 'dnsmasq is not installed and installPackages is false' >&2; exit 20",
      "  fi",
      "fi",
      `if ! command -v dig >/dev/null 2>&1 && [ ${
        opts.installPackages ? '"yes"' : '"no"'
      } = "yes" ] && command -v apt-get >/dev/null 2>&1; then`,
      "  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bind9-dnsutils >/dev/null 2>&1 || true",
      "fi",
      "BIN=$(command -v dnsmasq 2>/dev/null || true)",
      `if [ -n "$BIN" ] && [ "$BIN" != ${
        shellQuote(plan.facts.dnsmasqPath || "/usr/sbin/dnsmasq")
      } ]; then`,
      `  sed -i "s|^ExecStart=.*|ExecStart=$BIN --keep-in-foreground --conf-file=${configPath}|" ${
        shellQuote(unitPath)
      }`,
      "fi",
      "systemctl daemon-reload",
      `systemctl enable ${SERVICE_NAME}`,
      `systemctl restart ${SERVICE_NAME}`,
      "i=0",
      `while [ "$i" -lt 60 ]; do systemctl is-active --quiet ${SERVICE_NAME} && break; sleep 0.25; i=$((i+1)); done`,
      `systemctl is-active --quiet ${SERVICE_NAME} || { systemctl status --no-pager ${SERVICE_NAME} >&2 || true; exit 21; }`,
    );
    if (opts.manageResolver) {
      if (plan.resolverMode === "resolvconf") {
        lines.push(
          "if command -v resolvconf >/dev/null 2>&1; then resolvconf -u || true; fi",
        );
      } else {
        lines.push(
          writeFileSnippet(
            "/etc/resolv.conf",
            plan.desiredClientResolvConf,
            "0644",
          ),
        );
      }
    }
  }
  lines.push(
    "keep=" + String(opts.backupKeep),
    `if [ "$keep" -gt 0 ] 2>/dev/null; then`,
    `  ls -1dt ${
      shellQuote(`${opts.configDir}/backups`)
    }/*/ 2>/dev/null | tail -n +$((keep + 1)) | xargs -r rm -rf 2>/dev/null || true`,
    "fi",
    "printf '###SPLITDNS:APPLY_OK\\n'",
  );
  return lines.join("\n") + "\n";
}

function buildRollbackScript(
  plan: HostPlan,
  opts: RunOptionsResolved,
): string {
  const stamp = plan.checkedAt.replace(/[:.]/g, "-");
  const backupDir = `${opts.configDir}/backups/${stamp}`;
  const originalDir = `${opts.configDir}/original`;
  const lines: string[] = [
    "set -eu",
    `BACKUP_DIR=${shellQuote(backupDir)}`,
    "printf '###SPLITDNS:ROLLBACK_BEGIN\\n'",
  ];
  // Restore the pre-apply snapshot. If it does not exist, fall back to the
  // original snapshot (the first install) because no change was applied.
  lines.push(
    'if [ -f "$BACKUP_DIR/.ready" ]; then',
    restoreSnapshotScript({
      snapshotDir: backupDir,
      configDir: opts.configDir,
      configPath: `${opts.configDir}/dnsmasq.conf`,
      statePath: `${opts.configDir}/state.json`,
      upstreamPath: `${opts.configDir}/upstream-resolv.conf`,
      unitPath: `/etc/systemd/system/${SERVICE_NAME}`,
      nixosModule: DEFAULT_NIXOS_MODULE,
      nixosWrapper: DEFAULT_NIXOS_WRAPPER,
      hadService: plan.facts.serviceActive || plan.facts.serviceEnabled,
      serviceWasActive: plan.facts.serviceActive,
    })
      .replace(/^set -eu\n/, "")
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
    "else",
    "  printf 'no pre-apply backup at %s\\n' \"$BACKUP_DIR\"",
    "fi",
  );
  if (plan.facts.nixos) {
    lines.push(
      `if [ -f ${shellQuote(`${originalDir}/.ready`)} ]; then`,
      `  if [ -f ${shellQuote(`${originalDir}/nixwrapper`)} ]; then`,
      `    ${opts.nixosRebuildCommand} 2>&1 || true`,
      "  else",
      "    printf '%s' " +
        shellQuote(
          toBase64(renderNixosRollbackWrapper(DEFAULT_NIXOS_CONFIG)),
        ) +
        ` | base64 -d > ${shellQuote(DEFAULT_NIXOS_ROLLBACK)}`,
      `    ${
        opts.nixosRebuildCommand.replace(
          DEFAULT_NIXOS_WRAPPER,
          DEFAULT_NIXOS_ROLLBACK,
        )
      } 2>&1 || true`,
      `    rm -f ${shellQuote(DEFAULT_NIXOS_ROLLBACK)}`,
      "  fi",
      "fi",
    );
  }
  lines.push("printf '###SPLITDNS:ROLLBACK_END\\n'");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Planning implementation
// ---------------------------------------------------------------------------

interface ResolvedZoneInput {
  zone: string;
  nameservers: string[];
  source: "explicit" | "authoritative";
  remove: boolean;
}

/** Resolve the run's zone and nameserver list once, before any host is touched. */
async function resolveZoneInput(
  args: ApplyArgs,
  resolver: DnsResolver,
): Promise<ResolvedZoneInput | null> {
  const raw = (args.zone ?? "").trim();
  if (!raw) {
    if (args.removeZone) throw new Error("removeZone requires a zone");
    return null;
  }
  const zone = normalizeZone(raw);
  if (args.removeZone) {
    return { zone, nameservers: [], source: "explicit", remove: true };
  }
  if (args.nameservers.length > 0) {
    return {
      zone,
      nameservers: await resolveExplicitNameservers(args.nameservers, resolver),
      source: "explicit",
      remove: false,
    };
  }
  return {
    zone,
    nameservers: await discoverAuthoritativeNameservers(zone, resolver),
    source: "authoritative",
    remove: false,
  };
}

function desiredRules(
  state: ManagedState | null,
  zoneInput: ResolvedZoneInput | null,
  opts: ApplyArgs,
  now: string,
): ZoneRule[] {
  if (!zoneInput) return state?.zones ?? [];
  const incoming: ZoneRule[] = [{
    zone: zoneInput.zone,
    nameservers: zoneInput.nameservers,
    source: zoneInput.source,
    updatedAt: now,
  }];
  return mergeZoneRules(state?.zones ?? [], incoming, {
    replace: opts.replaceZones,
    remove: zoneInput.remove,
  });
}

/** A comparison fingerprint that ignores timestamps but catches real drift. */
export function stateFingerprint(text: string): string {
  const state = parseState(text);
  if (!state) return text.trim();
  return JSON.stringify({
    resolverMode: state.resolverMode,
    listenAddress: state.listenAddress,
    listenPort: state.listenPort,
    upstreamSource: state.upstreamSource,
    zones: state.zones.map((rule) => ({
      zone: rule.zone,
      nameservers: rule.nameservers,
      source: rule.source,
    })),
  });
}

function computeChanged(
  facts: HostFacts,
  desired: {
    config: string;
    state: string;
    unit: string;
    nmConf: string;
    resolvconfHead: string;
    clientResolvConf: string;
    upstreamConfig: string;
    nixosModule: string;
    nixosWrapper: string;
  },
  opts: RunOptionsResolved,
  resolverMode: string,
): { changed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (facts.configText !== desired.config) reasons.push("dnsmasq config");
  if (stateFingerprint(facts.stateText) !== stateFingerprint(desired.state)) {
    reasons.push("managed state");
  }
  if (
    desired.upstreamConfig &&
    facts.upstreamConfigText !== desired.upstreamConfig
  ) {
    reasons.push("captured upstream");
  }
  if (facts.nixos) {
    if (facts.nixosModuleText !== desired.nixosModule) {
      reasons.push("NixOS module");
    }
    if (facts.nixosWrapperText !== desired.nixosWrapper) {
      reasons.push("NixOS wrapper");
    }
    if (!facts.serviceActive) reasons.push("split-dns service");
    return { changed: reasons.length > 0, reasons };
  }
  if (facts.unitText !== desired.unit) reasons.push("systemd unit");
  if (!facts.serviceActive) reasons.push("split-dns service");
  if (!facts.serviceEnabled) reasons.push("service enabled at boot");
  if (opts.manageResolver) {
    if (resolverMode === "networkmanager") {
      if (facts.nmConfText !== desired.nmConf) {
        reasons.push("NetworkManager drop-in");
      }
      if (!facts.resolvConf.includes(`nameserver ${opts.listenAddress}`)) {
        reasons.push("/etc/resolv.conf");
      }
    } else if (resolverMode === "resolvconf") {
      if (facts.resolvconfHeadText !== desired.resolvconfHead) {
        reasons.push("resolvconf head");
      }
      if (!facts.resolvConf.includes(`nameserver ${opts.listenAddress}`)) {
        reasons.push("/etc/resolv.conf");
      }
    } else if (facts.resolvConf !== desired.clientResolvConf) {
      reasons.push("/etc/resolv.conf");
    }
  }
  return { changed: reasons.length > 0, reasons };
}

async function runTransientValidation(
  plan: HostPlan,
  opts: RunOptionsResolved,
): Promise<void> {
  const dnsmasq = plan.facts.dnsmasqPath;
  if (!dnsmasq) {
    plan.warnings.push(
      "dnsmasq is not installed yet; apply will install dnsmasq-base",
    );
    plan.validation.transientQuery = "skipped";
    plan.validation.transientMessage = "dnsmasq not installed during plan";
    return;
  }
  const port = 40000 + Math.floor(Math.random() * 10000);
  const script = buildTransientValidationScript({
    config: plan.desiredConfig,
    zone: plan.currentZone,
    controlName: opts.controlName,
    testName: opts.testName,
    dnsmasqPath: dnsmasq,
    port,
  });
  const result = await runOnHost(plan.spec, script, {
    ...opts,
    commandTimeoutSec: 60,
  });
  const s = parseSections(result.stdout);
  const configRaw = section(s, "CONFIG_TEST");
  plan.validation.configTest = /EXIT:0\b/.test(configRaw);
  plan.validation.configMessage = configRaw.replace(/\n?EXIT:\d+\s*$/, "")
    .trim();
  const zoneOut = section(s, "TRANSIENT_ZONE");
  const controlOut = section(s, "TRANSIENT_CONTROL");
  if (plan.validation.configTest) {
    if (!plan.facts.digPresent) {
      plan.validation.transientQuery = "skipped";
      plan.validation.transientMessage =
        "dig is not installed; transient query skipped";
    } else {
      const zoneResult = queryFrom(zoneOut, !!plan.currentZone);
      const controlResult = queryFrom(controlOut, !!opts.controlName);
      if (zoneResult.status === "failed" || controlResult.status === "failed") {
        plan.validation.transientQuery = "failed";
        plan.validation.transientMessage = [
          zoneResult.status === "failed" ? `zone: ${zoneResult.output}` : "",
          controlResult.status === "failed"
            ? `control: ${controlResult.output}`
            : "",
        ].filter(Boolean).join("; ");
      } else if (
        zoneResult.status === "skipped" && controlResult.status === "skipped"
      ) {
        plan.validation.transientQuery = "skipped";
        plan.validation.transientMessage = "no zone or control name to query";
      } else {
        plan.validation.transientQuery = "passed";
        plan.validation.transientMessage =
          "temporary dnsmasq answered the queries";
      }
    }
  } else if (result.code !== 0 && !configRaw) {
    plan.validation.transientQuery = "skipped";
    plan.validation.transientMessage = result.stderr.trim() ||
      `validation script exited ${result.code}`;
  } else {
    plan.validation.transientQuery = "failed";
    plan.validation.transientMessage = plan.validation.configMessage ||
      "dnsmasq --test failed";
  }
  if (!plan.validation.configTest) {
    plan.ok = false;
    plan.error = `dnsmasq rejected the generated configuration: ${
      plan.validation.configMessage || "no output"
    }`;
  }
  if (plan.validation.transientQuery === "failed" && !plan.error) {
    const runErr = section(s, "TRANSIENT_ERROR").trim();
    plan.ok = false;
    plan.error =
      `temporary resolver check failed: ${plan.validation.transientMessage}${
        runErr ? ` (${runErr})` : ""
      }`;
  }
}

function safeSearchDomains(values: string[]): string[] {
  return dedupe(
    values
      .map((v) => v.trim())
      .filter((v) => /^[a-zA-Z0-9._-]+$/.test(v)),
  );
}

async function buildPlan(
  spec: HostSpec,
  opts: RunOptionsResolved,
  args: ApplyArgs,
  zoneInput: ResolvedZoneInput | null,
  now: string,
): Promise<HostPlan> {
  const facts = await inspectHost(spec, opts);
  if (opts.dnsmasqBinary) facts.dnsmasqPath = opts.dnsmasqBinary;
  const resolverMode = resolveMode(facts);
  const state = parseState(facts.stateText);
  const configPath = `${opts.configDir}/dnsmasq.conf`;
  if (!zoneInput && !state) {
    return {
      spec,
      ok: true,
      facts,
      resolverMode,
      state,
      zones: [],
      currentZone: "",
      currentNameservers: [],
      currentNameserverSource: "",
      upstreamFile: "",
      upstream: [],
      upstreamSource: "none",
      nameservers: [],
      nameserverSource: "",
      configPath,
      desiredConfig: "",
      desiredUnit: "",
      desiredNmConf: "",
      desiredResolvconfHead: "",
      desiredClientResolvConf: "",
      desiredUpstreamResolvConf: "",
      desiredState: "",
      desiredNixosModule: "",
      desiredNixosWrapper: "",
      changed: false,
      validation: emptyValidation(),
      warnings: ["no managed zones on this host; run apply with a zone"],
      error: "",
      checkedAt: now,
    };
  }
  const zones = desiredRules(state, zoneInput, args, now);
  const currentRule = zoneInput
    ? zones.find((rule) => rule.zone === zoneInput.zone)
    : zones[0];
  const currentZone = zoneInput?.zone ?? currentRule?.zone ?? "";
  const currentNameservers = currentRule?.nameservers ?? [];
  const currentNameserverSource = currentRule?.source ??
    zoneInput?.source ?? "";
  const upstream = chooseUpstream(facts, opts.listenAddress);
  const desiredConfig = renderDnsmasqConfig({
    zones,
    upstream: upstream.nameservers,
    upstreamFile: upstream.upstreamFile,
    listenAddress: opts.listenAddress,
    listenPort: opts.listenPort,
  });
  const desiredUpstreamResolvConf = upstream.upstreamFile
    ? ""
    : renderUpstreamResolvConf(upstream.nameservers);
  const parsedResolv = parseResolvConf(facts.resolvConf);
  const search = safeSearchDomains(parsedResolv.search);
  const options = parsedResolv.options.filter((o) =>
    /^(edns0|trust-ad|rotate|single-request|single-request-reopen|no-tld-query|ndots:\d+|timeout:\d+|attempts:\d+)$/
      .test(o)
  );
  const desiredClientResolvConf = renderClientResolvConf(
    opts.listenAddress,
    search,
    options,
  );
  const desiredUnit = renderSystemdUnit(
    facts.dnsmasqPath || "/usr/sbin/dnsmasq",
    configPath,
  );
  const desiredState = JSON.stringify(
    {
      version: 1,
      managedBy: SPLIT_DNS_TYPE,
      os: facts.osId,
      resolverMode,
      listenAddress: opts.listenAddress,
      listenPort: opts.listenPort,
      upstreamSource: upstream.source,
      zones,
      appliedAt: now,
    } satisfies ManagedState,
    null,
    2,
  ) + "\n";
  const desired = {
    config: desiredConfig,
    state: desiredState,
    unit: desiredUnit,
    nmConf: renderNetworkManagerConf(),
    resolvconfHead: renderResolvconfHead(opts.listenAddress),
    clientResolvConf: desiredClientResolvConf,
    upstreamConfig: desiredUpstreamResolvConf,
    nixosModule: renderNixosModule({
      listenAddress: opts.listenAddress,
      configPath,
      search,
      manageResolver: opts.manageResolver,
    }),
    nixosWrapper: renderNixosWrapper(
      DEFAULT_NIXOS_CONFIG,
      DEFAULT_NIXOS_MODULE,
    ),
  };
  const diff = computeChanged(facts, desired, opts, resolverMode);
  const plan: HostPlan = {
    spec,
    ok: true,
    facts,
    resolverMode,
    state,
    zones,
    currentZone,
    currentNameservers,
    currentNameserverSource,
    upstreamFile: upstream.upstreamFile,
    upstream: upstream.nameservers,
    upstreamSource: upstream.source,
    nameservers: zoneInput?.nameservers ?? [],
    nameserverSource: zoneInput?.source ?? "",
    configPath,
    desiredConfig,
    desiredUnit,
    desiredNmConf: desired.nmConf,
    desiredResolvconfHead: desired.resolvconfHead,
    desiredClientResolvConf,
    desiredUpstreamResolvConf,
    desiredState,
    desiredNixosModule: desired.nixosModule,
    desiredNixosWrapper: desired.nixosWrapper,
    changed: diff.changed,
    validation: emptyValidation(),
    warnings: [],
    error: "",
    checkedAt: now,
  };
  if (diff.reasons.length > 0 && diff.changed) {
    plan.warnings.push(`pending changes: ${diff.reasons.join(", ")}`);
  }
  if (upstream.nameservers.length === 0 && !upstream.upstreamFile) {
    plan.ok = false;
    plan.error =
      "no DHCP DNS servers could be discovered; pass upstream servers by " +
      "fixing DHCP or setting explicit nameservers first";
  }
  if (plan.zones.length === 0 && !zoneInput?.remove) {
    plan.ok = false;
    plan.error = "no zone rules would remain; pass a zone to configure";
  }
  if (
    !plan.facts.nixos && !plan.facts.dnsmasqPath && !opts.installPackages
  ) {
    plan.ok = false;
    plan.error =
      "dnsmasq is not installed and installPackages is false; install it " +
      "or allow the extension to install dnsmasq-base";
  }
  if (!plan.error) await runTransientValidation(plan, opts);
  return plan;
}

// ---------------------------------------------------------------------------
// Apply / rollback / remove
// ---------------------------------------------------------------------------

function buildRemoveScript(
  facts: HostFacts,
  state: ManagedState | null,
  opts: RunOptionsResolved,
): string {
  const originalDir = `${opts.configDir}/original`;
  const configPath = `${opts.configDir}/dnsmasq.conf`;
  const statePath = `${opts.configDir}/state.json`;
  const upstreamPath = `${opts.configDir}/upstream-resolv.conf`;
  const unitPath = `/etc/systemd/system/${SERVICE_NAME}`;
  const lines: string[] = [
    "set -eu",
    "write_file() {",
    '  path="$1"; mode="$2"; b64="$3"',
    '  dir=$(dirname "$path")',
    '  install -d -m 755 "$dir" || return 1',
    '  tmp=$(mktemp "$dir/.split-dns.XXXXXX") || return 1',
    '  if ! printf "%s" "$b64" | base64 -d > "$tmp" 2>/dev/null; then',
    '    rm -f "$tmp"; echo "could not decode content for $path" >&2; return 1',
    "  fi",
    '  chmod "$mode" "$tmp"',
    '  mv -f "$tmp" "$path"',
    "}",
  ];
  if (facts.nixos) {
    lines.push(
      `if [ -f ${shellQuote(DEFAULT_NIXOS_CONFIG)} ]; then`,
      "  printf '%s' " +
        shellQuote(toBase64(renderNixosRollbackWrapper(DEFAULT_NIXOS_CONFIG))) +
        ` | base64 -d > ${shellQuote(DEFAULT_NIXOS_ROLLBACK)}`,
      `  ${
        opts.nixosRebuildCommand.replace(
          DEFAULT_NIXOS_WRAPPER,
          DEFAULT_NIXOS_ROLLBACK,
        )
      } 2>&1 || true`,
      `  rm -f ${shellQuote(DEFAULT_NIXOS_ROLLBACK)}`,
      "fi",
      `rm -f ${shellQuote(DEFAULT_NIXOS_MODULE)} ${
        shellQuote(DEFAULT_NIXOS_WRAPPER)
      }`,
      `rm -rf ${shellQuote(opts.configDir)}`,
    );
  } else {
    lines.push(
      restoreSnapshotScript({
        snapshotDir: originalDir,
        configDir: opts.configDir,
        configPath,
        statePath,
        upstreamPath,
        unitPath,
        nixosModule: DEFAULT_NIXOS_MODULE,
        nixosWrapper: DEFAULT_NIXOS_WRAPPER,
        hadService: false,
        serviceWasActive: false,
      }).replace(/^set -eu\n/, ""),
    );
    // If there was no original snapshot, remove only files that carry our
    // marker. Never delete a user's resolvconf head or NetworkManager drop-in.
    lines.push(
      `if [ ! -f ${shellQuote(`${originalDir}/.ready`)} ]; then`,
      `  if [ -f ${shellQuote(unitPath)} ] && grep -q ${
        shellQuote(MANAGED_MARKER)
      } ${shellQuote(unitPath)}; then`,
      `    systemctl stop ${SERVICE_NAME} >/dev/null 2>&1 || true`,
      `    systemctl disable ${SERVICE_NAME} >/dev/null 2>&1 || true`,
      `    rm -f ${shellQuote(unitPath)}`,
      `    systemctl daemon-reload >/dev/null 2>&1 || true`,
      "  fi",
      `  rm -f ${shellQuote(configPath)} ${shellQuote(statePath)} ${
        shellQuote(upstreamPath)
      }`,
      `  if [ -f ${shellQuote(NM_CONF_REL)} ] && grep -q ${
        shellQuote(MANAGED_MARKER)
      } ${shellQuote(NM_CONF_REL)}; then`,
      `    rm -f ${shellQuote(NM_CONF_REL)}`,
      "  fi",
      `  if [ -f ${shellQuote(RESOLVCONF_HEAD_REL)} ] && grep -q ${
        shellQuote(MANAGED_MARKER)
      } ${shellQuote(RESOLVCONF_HEAD_REL)}; then`,
      `    rm -f ${shellQuote(RESOLVCONF_HEAD_REL)}`,
      "  fi",
    );
    const upstream = state
      ? (parseResolvConf(facts.upstreamResolvConf).nameservers.length > 0
        ? parseResolvConf(facts.upstreamResolvConf).nameservers
        : parseResolvConf(facts.resolvConf).nameservers)
      : [];
    const fallback = usableUpstream(upstream, opts.listenAddress);
    if (fallback.length > 0) {
      lines.push(
        `  if [ -f /etc/resolv.conf ] && grep -q ${
          shellQuote(MANAGED_MARKER)
        } /etc/resolv.conf; then`,
        `    ${
          writeFileSnippet(
            "/etc/resolv.conf",
            fallback.map((ns) => `nameserver ${ns}`).join("\n") + "\n",
            "0644",
          )
        }`,
        "  fi",
      );
    } else {
      lines.push(
        `  if [ -f /etc/resolv.conf ] && grep -q ${
          shellQuote(MANAGED_MARKER)
        } /etc/resolv.conf; then`,
        "    echo 'WARNING: no DHCP nameservers available; /etc/resolv.conf still points at the removed forwarder' >&2",
        "  fi",
      );
    }
    lines.push("fi");
    lines.push(
      `rm -rf ${shellQuote(opts.configDir)}`,
    );
  }
  lines.push("printf '###SPLITDNS:REMOVE_OK\\n'");
  return lines.join("\n") + "\n";
}

async function verifyHost(
  spec: HostSpec,
  opts: RunOptionsResolved,
  facts: HostFacts,
  zone: string,
): Promise<VerifyResult> {
  const script = buildVerifyScript({
    listenAddress: opts.listenAddress,
    listenPort: opts.listenPort,
    zone,
    controlName: opts.controlName,
    testName: opts.testName,
    dnsmasqPath: facts.dnsmasqPath || "/usr/sbin/dnsmasq",
    configPath: `${opts.configDir}/dnsmasq.conf`,
    manageResolver: opts.manageResolver,
    resolverMode: resolveMode(facts),
  });
  const result = await runOnHost(spec, script, opts);
  const parsed = parseVerifyOutput(result.stdout, {
    digPresent: facts.digPresent,
    resolvectlPresent: facts.resolvectlPresent,
    manageResolver: opts.manageResolver,
    zone,
    controlName: opts.controlName,
    testName: opts.testName,
  });
  if (result.code !== 0 && !parsed.serviceStatus) {
    parsed.serviceStatus = result.stderr.trim() ||
      `verify script exited ${result.code}`;
  }
  return parsed;
}

function verificationWarnings(
  verify: VerifyResult,
  opts: RunOptionsResolved,
): string[] {
  const warnings: string[] = [];
  if (
    opts.manageResolver &&
    verify.systemControl.status === "skipped" &&
    verify.systemZone.status === "skipped" &&
    !verify.getent.trim()
  ) {
    warnings.push(
      "end-to-end resolution could not be verified: install `dig`, enable " +
        "resolvectl, or set testName",
    );
  }
  return warnings;
}

function verifyFailure(verify: VerifyResult): string {
  const problems: string[] = [];
  if (!verify.serviceActive) {
    problems.push(`service not active. ${verify.serviceStatus}`.trim());
  }
  if (!verify.configTest) {
    problems.push(`dnsmasq --test failed: ${verify.configMessage}`);
  }
  if (verify.localZone.status === "failed") {
    problems.push(`local zone query failed: ${verify.localZone.output}`);
  }
  if (verify.localControl.status === "failed") {
    problems.push(`local control query failed: ${verify.localControl.output}`);
  }
  if (verify.localTest.status === "failed") {
    problems.push(`local test query failed: ${verify.localTest.output}`);
  }
  if (verify.systemZone.status === "failed") {
    problems.push(`system zone query failed: ${verify.systemZone.output}`);
  }
  if (verify.systemControl.status === "failed") {
    problems.push(
      `system control query failed: ${verify.systemControl.output}`,
    );
  }
  if (verify.systemTest.status === "failed") {
    problems.push(`system test query failed: ${verify.systemTest.output}`);
  }
  return problems.join("; ");
}

function verifyToValidation(
  verify: VerifyResult,
  base: Validation,
): Validation {
  return {
    ...base,
    configTest: verify.configTest,
    configMessage: verify.configMessage,
    serviceActive: verify.serviceActive,
    serviceMessage: verify.serviceStatus,
    localZone: verify.localZone.status,
    localZoneMessage: verify.localZone.output,
    localControl: verify.localControl.status,
    localControlMessage: verify.localControl.output,
    systemZone: verify.systemZone.status,
    systemZoneMessage: verify.systemZone.output,
    systemControl: verify.systemControl.status,
    systemControlMessage: verify.systemControl.output,
  };
}

// ---------------------------------------------------------------------------
// Script renderers (exported for syntax tests and debugging)
// ---------------------------------------------------------------------------

function syntheticPlan(
  facts: HostFacts,
  opts: RunOptionsResolved,
): HostPlan {
  const now = new Date().toISOString();
  const zone: ZoneRule = {
    zone: "example.com",
    nameservers: ["192.0.2.53"],
    source: "explicit",
    updatedAt: now,
  };
  const chosen = chooseUpstream(facts, opts.listenAddress);
  const upstreamFile = chosen.upstreamFile;
  const upstream = chosen.nameservers.length > 0
    ? chosen.nameservers
    : ["10.0.0.1"];
  const configPath = `${opts.configDir}/dnsmasq.conf`;
  return {
    spec: { name: "test", address: "test", user: "", port: 22, local: true },
    ok: true,
    facts,
    resolverMode: resolveMode(facts),
    state: parseState(facts.stateText),
    zones: [zone],
    currentZone: zone.zone,
    currentNameservers: zone.nameservers,
    currentNameserverSource: zone.source,
    upstreamFile,
    upstream,
    upstreamSource: chosen.source,
    nameservers: zone.nameservers,
    nameserverSource: zone.source,
    configPath,
    desiredConfig: renderDnsmasqConfig({
      zones: [zone],
      upstream,
      upstreamFile: upstreamFile || undefined,
      listenAddress: opts.listenAddress,
      listenPort: opts.listenPort,
    }),
    desiredUnit: renderSystemdUnit(
      facts.dnsmasqPath || "/usr/sbin/dnsmasq",
      configPath,
    ),
    desiredNmConf: renderNetworkManagerConf(),
    desiredResolvconfHead: renderResolvconfHead(opts.listenAddress),
    desiredClientResolvConf: renderClientResolvConf(opts.listenAddress, [], []),
    desiredUpstreamResolvConf: upstreamFile
      ? ""
      : renderUpstreamResolvConf(upstream),
    desiredState: JSON.stringify(
      {
        version: 1,
        managedBy: SPLIT_DNS_TYPE,
        os: facts.osId,
        resolverMode: resolveMode(facts),
        listenAddress: opts.listenAddress,
        listenPort: opts.listenPort,
        upstreamSource: upstreamFile || "/etc/resolv.conf",
        zones: [zone],
        appliedAt: now,
      },
      null,
      2,
    ) + "\n",
    desiredNixosModule: renderNixosModule({
      listenAddress: opts.listenAddress,
      configPath,
      search: [],
      manageResolver: opts.manageResolver,
    }),
    desiredNixosWrapper: renderNixosWrapper(
      DEFAULT_NIXOS_CONFIG,
      DEFAULT_NIXOS_MODULE,
    ),
    changed: true,
    validation: emptyValidation(),
    warnings: [],
    error: "",
    checkedAt: now,
  };
}

/** Overrides used when rendering a script for tests or debugging. */
export interface ScriptOptions {
  /** Directory holding the managed config, state and snapshots. */
  configDir?: string;
  /** Loopback address dnsmasq listens on. */
  listenAddress?: string;
  /** Port dnsmasq listens on. */
  listenPort?: number;
  /** Whether the client resolver is pointed at dnsmasq. */
  manageResolver?: boolean;
  /** Whether apt may install dnsmasq-base. */
  installPackages?: boolean;
  /** Whether NixOS is rebuilt. */
  nixosRebuild?: boolean;
  /** Command used to activate the generated NixOS module. */
  nixosRebuildCommand?: string;
  /** Number of pre-apply snapshots to keep. */
  backupKeep?: number;
}

function scriptOptions(base: ScriptOptions = {}): RunOptionsResolved {
  return {
    hosts: [],
    sshUser: "",
    identityFile: "",
    connectTimeoutSec: 10,
    commandTimeoutSec: 600,
    parallel: 1,
    configDir: base.configDir ?? "/tmp/split-dns-test-config",
    listenAddress: base.listenAddress ?? "127.0.0.1",
    listenPort: base.listenPort ?? 53,
    manageResolver: base.manageResolver ?? true,
    installPackages: base.installPackages ?? true,
    controlName: "example.org",
    testName: "",
    nixosRebuild: base.nixosRebuild ?? true,
    nixosRebuildCommand: base.nixosRebuildCommand ??
      `nixos-rebuild switch -I nixos-config=${DEFAULT_NIXOS_WRAPPER}`,
    dnsmasqBinary: "",
    backupKeep: base.backupKeep ?? 5,
    stagingDir: base.configDir ?? "/tmp/split-dns-test-config",
    runId: "",
  };
}

/** Render the apply script for a synthetic host (syntax tests/debugging). */
export function renderApplyScript(
  facts: HostFacts,
  options: ScriptOptions = {},
): string {
  const opts = scriptOptions(options);
  return buildApplyScript(syntheticPlan(facts, opts), opts, {
    applyScript: `${opts.stagingDir}/apply.sh`,
    rollbackScript: `${opts.stagingDir}/rollback.sh`,
    verifyScript: `${opts.stagingDir}/verify.sh`,
  });
}

/** Render the rollback script for a synthetic host (syntax tests/debugging). */
export function renderRollbackScript(
  facts: HostFacts,
  options: ScriptOptions = {},
): string {
  const opts = scriptOptions(options);
  return buildRollbackScript(syntheticPlan(facts, opts), opts);
}

/** Render the remove script for a synthetic host (syntax tests/debugging). */
export function renderRemoveScript(
  facts: HostFacts,
  options: ScriptOptions = {},
): string {
  const opts = scriptOptions(options);
  return buildRemoveScript(facts, parseState(facts.stateText), opts);
}

// ---------------------------------------------------------------------------
// Model
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
}

interface ModelMethodResult {
  dataHandles: Array<{ name: string }>;
}

function sanitizeName(name: string, index: number): string {
  const clean = name.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `host-${index}-${clean || "host"}`;
}

const LOCAL_SPEC: HostSpec = {
  name: "local",
  address: "localhost",
  user: "",
  port: 22,
  local: true,
};

/** Write a staged script and make it readable/executable by the sudo route. */
async function writeStagedFile(path: string, content: string): Promise<void> {
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o755);
}

/** Remove old run directories under the staging root; never touches config dirs. */
async function pruneStaging(
  root: string,
  keep: number,
  current: string,
): Promise<void> {
  if (keep <= 0) return;
  try {
    const entries: Array<{ path: string; mtime: number }> = [];
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory) continue;
      if (!/^[0-9a-f-]{36}$|^\d{4}-\d{2}-\d{2}T/.test(entry.name)) continue;
      const path = `${root}/${entry.name}`;
      if (path === current) continue;
      try {
        const stat = await Deno.stat(path);
        entries.push({ path, mtime: stat.mtime?.getTime() ?? 0 });
      } catch {
        // raced with another cleanup
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(keep)) {
      await Deno.remove(entry.path, { recursive: true });
    }
  } catch {
    // best-effort cache cleanup; never fail staging over it
  }
}

function stagedPaths(
  opts: RunOptionsResolved,
  now: string,
): {
  runId: string;
  stagingDir: string;
  applyScript: string;
  rollbackScript: string;
  removeScript: string;
  verifyScript: string;
  backupDir: string;
} {
  const runId = (opts.runId || now).replace(/[^a-zA-Z0-9_.-]/g, "-");
  const stagingDir = `${expandHome(opts.stagingDir)}/${runId}`;
  return {
    runId,
    stagingDir,
    applyScript: `${stagingDir}/apply.sh`,
    rollbackScript: `${stagingDir}/rollback.sh`,
    removeScript: `${stagingDir}/remove.sh`,
    verifyScript: `${stagingDir}/verify.sh`,
    backupDir: `${opts.configDir}/backups/${now.replace(/[:.]/g, "-")}`,
  };
}

function writeSummary(
  ctx: MethodContext,
  action: string,
  results: HostResult[],
): Promise<{ name: string }> {
  const errors = results.filter((r) => !r.ok).map((r) =>
    `${r.host}: ${r.error || "failed"}`
  );
  return ctx.writeResource(
    "summary",
    "summary",
    {
      generatedAt: new Date().toISOString(),
      action,
      hosts: results.length,
      changed: results.filter((r) => r.changed).length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      errors,
    } satisfies RunSummary,
  );
}

async function failBeforeHosts(
  ctx: MethodContext,
  action: string,
  err: unknown,
): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  await ctx.writeResource(
    "summary",
    "summary",
    {
      generatedAt: new Date().toISOString(),
      action,
      hosts: 0,
      changed: 0,
      ok: 0,
      failed: 1,
      errors: [message],
    } satisfies RunSummary,
  );
  throw err instanceof Error ? err : new Error(message);
}

async function summarizeAndThrow(
  ctx: MethodContext,
  action: string,
  results: HostResult[],
  handles: Array<{ name: string }>,
): Promise<never> {
  handles.push(await writeSummary(ctx, action, results));
  const failures = results.filter((r) => !r.ok);
  ctx.logger?.warn("split-dns {action} failed: {failed}/{count} host(s)", {
    action,
    failed: failures.length,
    count: results.length,
  });
  const lines = failures.map(formatResultError);
  throw new Error(
    `split-dns ${action} failed on ${failures.length}/${results.length} ` +
      `host(s):\n${lines.map((l) => `  - ${l}`).join("\n")}`,
  );
}

function formatResultError(result: HostResult): string {
  const parts = [`${result.host} (${result.address})`, result.error];
  if (result.validation.configMessage) {
    parts.push(`dnsmasq: ${result.validation.configMessage}`);
  }
  if (result.validation.transientMessage) {
    parts.push(`validation: ${result.validation.transientMessage}`);
  }
  if (result.validation.localZoneMessage) {
    parts.push(`zone query: ${result.validation.localZoneMessage}`);
  }
  if (result.validation.localControlMessage) {
    parts.push(`control query: ${result.validation.localControlMessage}`);
  }
  if (result.validation.systemControlMessage) {
    parts.push(`system query: ${result.validation.systemControlMessage}`);
  }
  return parts.filter(Boolean).join(": ");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function failResult(
  spec: HostSpec,
  action: HostResult["action"],
  err: unknown,
): HostResult {
  const result = makeResult(spec, action, new Date().toISOString());
  result.ok = false;
  result.error = err instanceof Error ? err.message : String(err);
  return result;
}

/** A model that maintains per-zone DNS exceptions on Linux hosts. */
export const model = {
  type: "@svendowideit/split-dns",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.26.1",
      description:
        "Initial release: keep DHCP DNS for general resolution while sending " +
        "selected zones to their authoritative nameservers (or an explicit " +
        "list) via a host-local managed dnsmasq forwarder on Debian, Ubuntu " +
        "and NixOS. The model stages scripts unprivileged, the workflow runs " +
        "them through @svendowideit/sudo's runScript operation, and validation, " +
        "live verification and rollback to the previous working snapshot are " +
        "part of the staged apply script.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    hostResult: {
      description:
        "One host's plan, applied state, verification and rollback outcome.",
      schema: HostResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    summary: {
      description: "Per-run roll-up of host results.",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    staged: {
      description: "Scripts staged for @svendowideit/sudo to run on this host.",
      schema: StagedSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    plan: {
      description:
        "Inspect each host, discover the zone's authoritative nameservers " +
        "when none are given, render the dnsmasq config, validate it, and " +
        "test it on a temporary port. Read-only; changes nothing.",
      arguments: ApplyArgsSchema,
      execute: async (
        args: ApplyArgs,
        ctx: MethodContext,
      ): Promise<ModelMethodResult> => {
        const opts = resolveOptions(ctx.globalArgs, args);
        const portError = managedResolverPortError(opts);
        if (portError) {
          return await failBeforeHosts(ctx, "plan", new Error(portError));
        }
        const now = new Date().toISOString();
        const resolver = defaultResolver;
        const handles: Array<{ name: string }> = [];
        ctx.logger?.info("split-dns plan start: {count} host(s)", {
          count: opts.hosts.length,
        });
        let zoneInput: ResolvedZoneInput | null = null;
        try {
          zoneInput = await resolveZoneInput(args, resolver);
        } catch (err) {
          return await failBeforeHosts(ctx, "plan", err);
        }
        const results = await mapWithConcurrency(
          opts.hosts,
          opts.parallel,
          async (spec, index) => {
            try {
              const plan = await buildPlan(spec, opts, args, zoneInput, now);
              const result = planToResult("planned", plan, now);
              handles.push(
                await ctx.writeResource(
                  "hostResult",
                  sanitizeName(spec.name, index),
                  result,
                ),
              );
              ctx.logger?.info("split-dns plan {host}: {state}", {
                host: spec.name,
                state: plan.ok
                  ? (plan.changed ? "changes pending" : "unchanged")
                  : plan.error,
              });
              return result;
            } catch (err) {
              const result = failResult(spec, "planned", err);
              handles.push(
                await ctx.writeResource(
                  "hostResult",
                  sanitizeName(spec.name, index),
                  result,
                ),
              );
              return result;
            }
          },
        );
        if (results.some((r) => !r.ok)) {
          await summarizeAndThrow(ctx, "plan", results, handles);
        }
        handles.push(await writeSummary(ctx, "plan", results));
        ctx.logger?.info(
          "split-dns plan complete: {ok}/{count} ok, {changed} changed",
          {
            ok: results.filter((r) => r.ok).length,
            count: results.length,
            changed: results.filter((r) => r.changed).length,
          },
        );
        return { dataHandles: handles };
      },
    },

    stage: {
      description:
        "Render the desired config and stage apply, rollback, remove and " +
        "verification scripts in an unprivileged directory. Local host only: " +
        "run this on the target (or dispatch the workflow to its worker). " +
        "Changes nothing outside the staging directory. The workflow then runs " +
        "the apply script through @svendowideit/sudo.",
      arguments: ApplyArgsSchema,
      execute: async (
        args: ApplyArgs,
        ctx: MethodContext,
      ): Promise<ModelMethodResult> => {
        const opts = resolveOptions(ctx.globalArgs, args);
        const portError = managedResolverPortError(opts);
        if (portError) throw new Error(portError);
        const now = new Date().toISOString();
        const resolver = defaultResolver;
        ctx.logger?.info("split-dns stage start on {host}", {
          host: Deno.hostname(),
        });
        let zoneInput: ResolvedZoneInput | null = null;
        try {
          zoneInput = await resolveZoneInput(args, resolver);
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        const plan = await buildPlan(LOCAL_SPEC, opts, args, zoneInput, now);
        const paths = stagedPaths(opts, now);
        await Deno.mkdir(paths.stagingDir, { recursive: true });
        await Deno.chmod(paths.stagingDir, 0o700);
        await writeStagedFile(
          paths.applyScript,
          buildApplyScript(plan, opts, paths),
        );
        await writeStagedFile(
          paths.rollbackScript,
          buildRollbackScript(plan, opts),
        );
        await writeStagedFile(
          paths.removeScript,
          buildRemoveScript(plan.facts, plan.state, opts),
        );
        await writeStagedFile(
          paths.verifyScript,
          buildVerifyGateScript(plan, opts),
        );
        await pruneStaging(
          expandHome(opts.stagingDir),
          opts.backupKeep,
          paths.stagingDir,
        );
        const staged: Staged = {
          host: plan.facts.hostname || Deno.hostname(),
          zone: plan.currentZone,
          zones: plan.zones,
          changed: plan.changed,
          stagingDir: paths.stagingDir,
          applyScript: paths.applyScript,
          rollbackScript: paths.rollbackScript,
          removeScript: paths.removeScript,
          verifyScript: paths.verifyScript,
          backupDir: paths.backupDir,
          ok: plan.ok,
          warnings: plan.warnings,
          error: plan.error,
          stagedAt: now,
        };
        const handle = await ctx.writeResource(
          "staged",
          "staged",
          staged as unknown as Record<string, unknown>,
        );
        if (!plan.ok) {
          throw new Error(`staging failed: ${plan.error}`);
        }
        ctx.logger?.info(
          "split-dns staged {dir} (changed={changed}, zones={zones})",
          {
            dir: paths.stagingDir,
            changed: plan.changed,
            zones: plan.zones.map((z) => z.zone).join(", ") || "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report the managed zones, upstream source, config, service and live " +
        "resolution on each host without changing anything.",
      arguments: HostsArgsSchema,
      execute: async (
        args: HostsArgs,
        ctx: MethodContext,
      ): Promise<ModelMethodResult> => {
        const opts = resolveOptions(ctx.globalArgs, args);
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        ctx.logger?.info("split-dns status start: {count} host(s)", {
          count: opts.hosts.length,
        });
        const results = await mapWithConcurrency(
          opts.hosts,
          opts.parallel,
          async (spec, index) => {
            try {
              const facts = await inspectHost(spec, opts);
              const state = parseState(facts.stateText);
              const result = makeResult(spec, "status", now);
              result.os = facts.osId;
              result.osName = facts.osName;
              result.hostname = facts.hostname;
              result.resolverMode = resolveMode(facts);
              result.zones = state?.zones ?? [];
              result.zone = state?.zones[0]?.zone ?? "";
              result.nameservers = state?.zones[0]?.nameservers ?? [];
              result.nameserverSource = state?.zones[0]?.source ?? "";
              result.upstreamSource = state?.upstreamSource ?? "";
              result.upstream =
                chooseUpstream(facts, opts.listenAddress).nameservers;
              result.configPath = `${opts.configDir}/dnsmasq.conf`;
              result.changed = false;
              if (!state) {
                result.warnings.push("not configured on this host");
                result.ok = true;
              } else {
                const live = await verifyHost(
                  spec,
                  opts,
                  facts,
                  state.zones[0]?.zone ?? "",
                );
                result.validation = verifyToValidation(
                  live,
                  emptyValidation(),
                );
                result.warnings = verificationWarnings(live, opts);
                const failure = verifyFailure(live);
                result.ok = !failure;
                result.error = failure;
              }
              handles.push(
                await ctx.writeResource(
                  "hostResult",
                  sanitizeName(spec.name, index),
                  result,
                ),
              );
              return result;
            } catch (err) {
              const result = failResult(spec, "status", err);
              handles.push(
                await ctx.writeResource(
                  "hostResult",
                  sanitizeName(spec.name, index),
                  result,
                ),
              );
              return result;
            }
          },
        );
        if (results.some((r) => !r.ok)) {
          await summarizeAndThrow(ctx, "status", results, handles);
        }
        handles.push(await writeSummary(ctx, "status", results));
        ctx.logger?.info("split-dns status complete: {ok}/{count} ok", {
          ok: results.filter((r) => r.ok).length,
          count: results.length,
        });
        return { dataHandles: handles };
      },
    },

    stageRemove: {
      description:
        "Render the remove script (and its verification gate) into the " +
        "unprivileged staging directory. Local host only. The workflow then " +
        "runs it through @svendowideit/sudo.",
      arguments: ApplyArgsSchema,
      execute: async (
        args: ApplyArgs,
        ctx: MethodContext,
      ): Promise<ModelMethodResult> => {
        const opts = resolveOptions(ctx.globalArgs, args);
        const now = new Date().toISOString();
        ctx.logger?.info("split-dns stageRemove start on {host}", {
          host: Deno.hostname(),
        });
        const facts = await inspectHost(LOCAL_SPEC, opts);
        const state = parseState(facts.stateText);
        const paths = stagedPaths(opts, now);
        await Deno.mkdir(paths.stagingDir, { recursive: true });
        await Deno.chmod(paths.stagingDir, 0o700);
        await writeStagedFile(
          paths.removeScript,
          buildRemoveScript(facts, state, opts),
        );
        await writeStagedFile(
          paths.verifyScript,
          buildVerifyRemovedScript(facts, opts),
        );
        await pruneStaging(
          expandHome(opts.stagingDir),
          opts.backupKeep,
          paths.stagingDir,
        );
        const configured = !!state || !!facts.configText;
        const staged: Staged = {
          host: facts.hostname || Deno.hostname(),
          zone: state?.zones[0]?.zone ?? "",
          zones: state?.zones ?? [],
          changed: configured,
          stagingDir: paths.stagingDir,
          applyScript: "",
          rollbackScript: "",
          removeScript: paths.removeScript,
          verifyScript: paths.verifyScript,
          backupDir: "",
          ok: true,
          warnings: configured ? [] : ["not configured; remove is a no-op"],
          error: "",
          stagedAt: now,
        };
        const handle = await ctx.writeResource(
          "staged",
          "staged",
          staged as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "split-dns stageRemove staged {dir} (configured={configured})",
          { dir: paths.stagingDir, configured },
        );
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Verify the live result on this host after the sudo step: the " +
        "managed zone is present and resolves, or (expect=removed) the " +
        "forwarder is gone and normal DNS answers. Local host only.",
      arguments: VerifyArgsSchema,
      execute: async (
        args: VerifyArgs,
        ctx: MethodContext,
      ): Promise<ModelMethodResult> => {
        const opts = resolveOptions(ctx.globalArgs, args);
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        ctx.logger?.info("split-dns verify start on {host} ({expect})", {
          host: Deno.hostname(),
          expect: args.expect,
        });
        const facts = await inspectHost(LOCAL_SPEC, opts);
        const state = parseState(facts.stateText);
        const result = makeResult(LOCAL_SPEC, "verified", now);
        result.os = facts.osId;
        result.osName = facts.osName;
        result.hostname = facts.hostname;
        result.resolverMode = resolveMode(facts);
        result.zones = state?.zones ?? [];
        result.zone = args.zone
          ? normalizeZone(args.zone)
          : (state?.zones[0]?.zone ?? "");
        result.nameservers = state?.zones[0]?.nameservers ?? [];
        result.nameserverSource = state?.zones[0]?.source ?? "";
        result.upstreamSource = state?.upstreamSource ?? "";
        result.upstream = chooseUpstream(facts, opts.listenAddress).nameservers;
        result.configPath = `${opts.configDir}/dnsmasq.conf`;

        if (args.expect === "removed") {
          const configured = !!state || !!facts.configText;
          if (configured) {
            result.ok = false;
            result.error =
              "split-dns is still configured on this host; the remove step did not complete";
          } else {
            const live = await verifyHost(
              LOCAL_SPEC,
              { ...opts, manageResolver: true },
              facts,
              "",
            );
            result.validation = verifyToValidation(live, emptyValidation());
            result.warnings = verificationWarnings(live, {
              ...opts,
              manageResolver: true,
            });
            if (
              opts.controlName && live.systemControl.status === "failed"
            ) {
              result.ok = false;
              result.error =
                `normal DNS did not answer after removal: ${live.systemControl.output}`;
            }
          }
        } else {
          if (!state || state.zones.length === 0) {
            result.ok = false;
            result.error = "split-dns is not configured on this host";
          } else if (
            args.zone &&
            !state.zones.some((rule) => rule.zone === result.zone)
          ) {
            result.ok = false;
            result.error = `zone ${result.zone} is not in the configured set`;
          } else {
            const live = await verifyHost(
              LOCAL_SPEC,
              opts,
              facts,
              result.zone,
            );
            const failure = verifyFailure(live);
            result.validation = verifyToValidation(live, emptyValidation());
            result.warnings = verificationWarnings(live, opts);
            if (failure) {
              result.ok = false;
              result.error = failure;
            }
          }
        }

        const handle = await ctx.writeResource(
          "hostResult",
          sanitizeName(LOCAL_SPEC.name, 0),
          result,
        );
        handles.push(handle);
        if (!result.ok) {
          await summarizeAndThrow(ctx, "verify", [result], handles);
        }
        handles.push(await writeSummary(ctx, "verify", [result]));
        ctx.logger?.info("split-dns verify complete: {ok}", {
          ok: result.ok,
        });
        return { dataHandles: handles };
      },
    },
  },
};
