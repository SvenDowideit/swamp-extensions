/**
 * @svendowideit/fleet-census
 *
 * What is on this host that the OS package manager does not own — and who
 * owns it?
 *
 * One `inventory` run renders a read-only POSIX scanner, runs it on this host,
 * parses the result and writes three resources: `host` (identity, interfaces,
 * addresses, counts), `software` (one item per unmanaged piece of software with
 * its provenance, manager, version evidence and swamp-owner candidate) and
 * `summary` (counts plus the commands to drill in).
 *
 * Design rules this file implements (see docs/fleet-census-plan.md):
 *
 *   - `managed` means **OS package manager or swamp extension only**. A
 *     third-party manager (mise, npm, cargo, go, pip, pipx, brew, nix) is
 *     recorded as `manager` and never confers `managed`.
 *   - No discovered binary is ever executed (`execProbe` is false by design).
 *     Version evidence comes from package DBs, Go build info, dist-info
 *     metadata, OCI labels/refs, release filenames and the Nix store path.
 *   - Provenance is evidence + confidence, never a silent verdict: a path is
 *     not "OS" because it lives in /usr/local/bin, and it is not
 *     "hand-installed" because it lacks build info.
 *   - The scanner takes its directory set from PATH **plus** the known user
 *     dirs: over a non-interactive `ssh` command PATH is the login-shell default
 *     and misses ~/.local/bin entirely (P0 finding 1).
 *   - Counters live outside the scan loop: a piped `while` runs in a subshell and
 *     silently loses them (P0 finding 13).
 *
 * Methods:
 *   - `inventory`  scan this host and write `host`, `software`, `summary`
 *
 * @module
 */

import { z } from "npm:zod@4";

import {
  type FleetData,
  type FreshnessData,
  renderHosts,
  renderIndex,
  renderJson,
  renderSoftware,
} from "./census_report.ts";
import {
  catalogEntryFor,
  managedByUnit,
  OWNER_CATALOG,
} from "./owners_catalog.ts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  name: z.string().refine(
    // deno-lint-ignore no-control-regex
    (v) => !/[\x00\r\n]/.test(v),
    { message: "name must not contain newlines or NUL bytes" },
  ).default("").describe(
    "Model instance name (supplied by swamp; used in log lines).",
  ),
  scanTimeoutSec: z.number().int().positive().max(1800).default(180).describe(
    "Wall-clock budget for the whole scan. The scanner stops early and reports " +
      "`truncated` rather than hanging.",
  ),
  hashMaxBytes: z.number().int().positive().default(33_554_432).describe(
    'Hash files up to this size (SHA-256). Larger files record `sha256: ""`.',
  ),
  maxItems: z.number().int().positive().max(5000).default(400).describe(
    "Maximum unowned PATH executables to itemise (the rest are counted only).",
  ),
  extraDirs: z.array(z.string()).default([]).describe(
    "Additional directories to scan beyond PATH and the known user dirs.",
  ),
  knownDirs: z.boolean().default(true).describe(
    "Include the known user dirs (~/.local/bin, ~/go/bin, ~/.cargo/bin, nvm, " +
      "mise, …). Keep true: PATH over non-interactive ssh misses them.",
  ),
  collectAddresses: z.boolean().default(true).describe(
    "Record this host's own interface addresses and MACs (`ip -o addr` / " +
      "`ip -o link`), so a stale fleet-inventory address can be detected.",
  ),
  execProbe: z.boolean().default(false).describe(
    "Run the catalogue's own fixed version probes (e.g. `swamp --version`) for " +
      "binaries that carry no version. Never runs a probe derived from " +
      "discovered data; off by default.",
  ),
  outputDir: z.string().default("~/.local/share/fleet-census/site").describe(
    "Directory the HTML reports and census.json are written to (the directory " +
      "Caddy serves).",
  ),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InventoryArgsSchema = z.object({});

const CensusArgsSchema = z.object({
  hosts: z.array(z.string()).default([]).describe(
    "Hosts to census (names or addresses). Empty reads the fleet-inventory " +
      "model's host list (its probe/inventory data) and uses every host it knows.",
  ),
  fleetModel: z.string().default("fleet").describe(
    "The @svendowideit/fleet-inventory model whose host list supplies the targets " +
      "when `hosts` is empty.",
  ),
  sshUser: z.string().default("").describe(
    "SSH user for the scan. Empty uses the current user.",
  ),
  timeoutSec: z.number().int().positive().max(1800).default(180).describe(
    "Per-host budget for the SSH scan.",
  ),
  parallel: z.number().int().positive().max(32).default(6).describe(
    "How many hosts to scan at once.",
  ),
  maxItems: z.number().int().positive().max(5000).default(400).describe(
    "Per-host cap on itemised unowned executables.",
  ),
  hashMaxBytes: z.number().int().positive().default(33_554_432).describe(
    "Per-host cap on the size of files hashed.",
  ),
});

const ReportArgsSchema = z.object({
  outputDir: z.string().default("").describe(
    "Override the output directory (empty uses the global outputDir).",
  ),
});

const PublishArgsSchema = z.object({
  hostname: z.string().default("").describe(
    "Hostname to serve the reports on. Empty derives census.<host>.<zone>.",
  ),
  baseDomain: z.string().default("").describe(
    "The Caddy zone whose DNS + TLS Caddy already owns. Empty reads it from the " +
      "installed @svendowideit/caddy models.",
  ),
  routeIp: z.string().default("").describe(
    "Address the DNS A record should point at (the orchestrator's LAN IP). " +
      "Empty leaves the record to a peer Caddy model that already declares it.",
  ),
  model: z.string().default("census-caddy").describe(
    "The @svendowideit/caddy model to create/reuse for this site.",
  ),
  rootDir: z.string().default("").describe(
    "Directory to serve (empty uses the global outputDir).",
  ),
});

const AssessArgsSchema = z.object({
  releaseMetaModel: z.string().default("release-meta").describe(
    "The @svendowideit/github-release-install model instance whose `releases` " +
      "data supplies upstream versions and publication dates.",
  ),
  idleWarnDays: z.number().int().positive().default(365).describe(
    "Flag upstream idle time above this as a warning (upstream-idle-1y).",
  ),
  idleBadDays: z.number().int().positive().default(730).describe(
    "Flag upstream idle time above this as abandoned (upstream-idle-2y).",
  ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const InterfaceSchema = z.object({
  name: z.string(),
  mac: z.string(),
  kind: z.string(),
  addresses: z.array(z.string()),
});

const SoftwareItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  identity: z.object({
    kind: z.enum(["github", "go", "npm", "pypi", "oci", "name"]),
    name: z.string(),
  }),
  version: z.string(),
  versionSource: z.enum([
    "build-info",
    "dist-info",
    "package-db",
    "filename",
    "nix-store",
    "cli",
    "unknown",
  ]),
  manager: z.string(),
  provenance: z.enum([
    "os",
    "language",
    "third-party",
    "container",
    "hand-installed",
    "source-build",
    "swamp",
    "unknown",
  ]),
  installPath: z.string(),
  realPath: z.string(),
  sizeBytes: z.number(),
  mtime: z.string(),
  sha256: z.string(),
  owner: z.object({
    class: z.enum(["managed", "manageable", "unknown"]),
    extension: z.string().default(""),
    command: z.string().default(""),
    confidence: z.number(),
  }),
  evidence: z.array(z.object({ signal: z.string(), detail: z.string() })),
  flags: z.array(z.string()),
  bundledWith: z.string().default(""),
});

export type SoftwareItem = z.infer<typeof SoftwareItemSchema>;

const HostSchema = z.object({
  hostname: z.string(),
  fqdn: z.string(),
  machineId: z.string(),
  os: z.string(),
  arch: z.string(),
  scannedAt: z.string(),
  durationMs: z.number(),
  pathDirs: z.array(z.object({ dir: z.string(), source: z.string() })),
  interfaces: z.array(InterfaceSchema),
  addresses: z.array(z.string()),
  counts: z.object({
    osManagedExecutables: z.number(),
    unownedExecutables: z.number(),
    items: z.number(),
    byManager: z.record(z.string(), z.number()),
    byProvenance: z.record(z.string(), z.number()),
    byOwner: z.record(z.string(), z.number()),
  }),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
});

const SummarySchema = z.object({
  hostname: z.string(),
  items: z.number(),
  unowned: z.number(),
  osManaged: z.number(),
  byManager: z.record(z.string(), z.number()),
  byOwner: z.record(z.string(), z.number()),
  duplicates: z.array(
    z.object({ identity: z.string(), paths: z.array(z.string()) }),
  ),
  unknownVersion: z.array(z.string()),
  nextCommands: z.string(),
  scannedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Swamp ownership catalogue
//
// `managed` is only ever claimed with host evidence (a provenance marker or a
// model-recorded artefact path); P1 ships no marker yet, so this catalogue can
// only produce `manageable` — "an extension exists that would own this".
// ---------------------------------------------------------------------------

/** Kept for callers that imported the old shape; the catalogue now lives in owners_catalog.ts. */
export const SWAMP_CATALOG = OWNER_CATALOG;

// ---------------------------------------------------------------------------
// Pure parsing helpers (exported for tests)
// ---------------------------------------------------------------------------

/** One raw record from the scanner's TSV stream. */
export interface ScanRecord {
  kind: string;
  fields: string[];
}

/** Split the scanner's TSV output into typed records. */
export function parseScan(tsv: string): ScanRecord[] {
  const out: ScanRecord[] = [];
  for (const line of tsv.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const kind = parts[0].trim();
    if (kind === "") continue;
    out.push({ kind, fields: parts.slice(1) });
  }
  return out;
}

/** Expand the systemd specifiers we can resolve without a unit context. */
export function expandSpecifiers(
  raw: string,
  opts: { home: string; user: string; uid: string },
): string {
  return raw
    .replaceAll("%h", opts.home)
    .replaceAll("%u", opts.user)
    .replaceAll("%U", opts.uid)
    .replaceAll("%t", "/run");
}

/**
 * Parse an `ExecStart=` line into the executable that will run.
 *
 * Handles the prefixes systemd allows (`-` ignore-failure, `@` argv[0] replaced,
 * `!` no shell, `+` full privileges) and the `sh -c '…'` wrapper, which hides
 * the real command inside a string. A wrapper is reported as `wrapped: true` and
 * the raw text is kept, so the caller can decide not to trust the first token.
 */
export function parseExecStart(
  raw: string,
  opts: { home: string; user: string; uid: string },
): { command: string; args: string[]; wrapped: boolean } {
  let s = expandSpecifiers(raw.trim(), opts);
  for (const prefix of ["-", "@", "!", "+"]) {
    if (s.startsWith(prefix)) s = s.slice(1).trimStart();
  }
  const tokens = s.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return { command: "", args: [], wrapped: false };
  const first = tokens[0].replace(/^\//, "/");
  const base = first.split("/").pop() ?? first;
  if (
    (base === "sh" || base === "bash" || base === "dash") &&
    tokens.slice(1).some((t) => t === "-c")
  ) {
    return { command: first, args: tokens.slice(1), wrapped: true };
  }
  return { command: first, args: tokens.slice(1), wrapped: false };
}

/** Classify a network interface from its name and MAC. */
export function interfaceKind(name: string, mac: string): string {
  if (name === "lo") return "loopback";
  if (/^(tailscale|wg|netbird|zt|tun|tap|wg\d)/.test(name)) return "vpn";
  if (/^(docker|br-|veth|virbr|podman|cni|flannel|cali)/.test(name)) {
    return "software-bridge";
  }
  if (/^(wl|wifi)/.test(name)) return "wifi";
  if (/^(eth|en|eno|ens|enp|em\d)/.test(name)) return "ethernet";
  return mac === "" ? "unknown" : "ethernet";
}

/**
 * A Nix store path carries the package name and version:
 * `/nix/store/<32-char-hash>-<name>-<version>/bin/<bin>`.
 */
export function parseNixStorePath(
  path: string,
): { name: string; version: string } | null {
  const m = path.match(
    /^\/nix\/store\/[a-z0-9]{32}-([^/]+?)(?:-(\d[^/]*))?\/bin\//,
  );
  if (!m) return null;
  return { name: m[1], version: m[2] ?? "" };
}

/** Split a `name-vX.Y.Z` / `name-X.Y.Z` binary name into name + version. */
export function splitNameVersion(
  name: string,
): { name: string; version: string } {
  const m = name.match(/^(.*?)-v?(\d+\.\d+[0-9A-Za-z.+-]*)$/);
  if (m) return { name: m[1], version: m[2] };
  return { name, version: "" };
}

/** Map the scanner's `where` column plus the name to an install manager. */
export function managerOf(rec: {
  where: string;
  name: string;
  gomod: string;
  path: string;
}): string {
  const nix = parseNixStorePath(rec.path);
  if (nix || rec.path.startsWith("/nix/store/")) return "nix";
  switch (rec.where) {
    case "home-local-bin":
      return "none";
    case "usr-local-bin":
      return "none";
    case "cargo":
      return /^(rustc|rustfmt|rustdoc|rust-gdb|rust-lldb|clippy-driver|rls|cargo-clippy|cargo-fmt|cargo-miri|rustup)$/
          .test(rec.name)
        ? "rustup"
        : "cargo";
    case "go-bin":
      return "go";
    case "deno":
      return "deno";
    case "bun":
      return "bun";
    case "volta":
      return "volta";
    case "nvm":
      return "nvm";
    case "snap":
      return "snap";
    case "opt":
      return "vendor";
    default:
      return rec.gomod !== "" ? "go" : "none";
  }
}

/** Resolve an identity from the strongest available key. */
export function identityOf(rec: {
  name: string;
  gomod: string;
  path: string;
}): { kind: SoftwareItem["identity"]["kind"]; name: string } {
  const nix = parseNixStorePath(rec.path);
  if (nix) return { kind: "name", name: nix.name };
  if (rec.gomod !== "" && rec.gomod !== "-") {
    const parts = rec.gomod.split("/");
    // ONLY github.com modules are a GitHub repository. helm.sh/helm/v3 is a Go
    // module, not github.com/helm/v3 — guessing the host here produced 404s for
    // every non-GitHub module.
    if (parts[0] === "github.com" && parts.length >= 3) {
      return { kind: "github", name: parts.slice(1, 3).join("/") };
    }
    return { kind: "go", name: rec.gomod };
  }
  return { kind: "name", name: splitNameVersion(rec.name).name };
}

/**
 * Version evidence, best first: build info (unless it is `(devel)`, which means
 * "built without a stamped version"), the Nix store path, then the filename.
 */
export function versionOf(rec: {
  name: string;
  gomod: string;
  gover: string;
  path: string;
}): {
  version: string;
  source: SoftwareItem["versionSource"];
  evidence: string;
} {
  const gover = (rec.gover ?? "").trim();
  if (gover !== "" && gover !== "-" && !gover.startsWith("(")) {
    return {
      version: gover.replace(/^v/, ""),
      source: "build-info",
      evidence: `go build info: ${rec.gomod || "?"} ${gover}`,
    };
  }
  const nix = parseNixStorePath(rec.path);
  if (nix && nix.version !== "") {
    return {
      version: nix.version.replace(/^v/, ""),
      source: "nix-store",
      evidence: `nix store path: ${nix.name}-${nix.version}`,
    };
  }
  const split = splitNameVersion(rec.name);
  if (split.version !== "") {
    return {
      version: split.version.replace(/^v/, ""),
      source: "filename",
      evidence: `version in executable name: ${rec.name}`,
    };
  }
  return { version: "", source: "unknown", evidence: "no version evidence" };
}

/** Owner candidate from the catalogue. Never claims `managed`. */
export function ownerOf(
  name: string,
  identityName: string,
): {
  class: "manageable" | "unknown";
  extension: string;
  command: string;
  confidence: number;
} {
  for (const entry of SWAMP_CATALOG) {
    if (entry.match.test(name) || entry.match.test(identityName)) {
      return {
        class: "manageable",
        extension: entry.extension,
        command: entry.command,
        confidence: 0.6,
      };
    }
  }
  return { class: "unknown", extension: "", command: "", confidence: 0 };
}

/**
 * Collapse toolchain-bundled binaries (nvm's per-version node/npm, rustup's
 * shims) so they do not inflate the item count or look like duplicates.
 * Returns items with `bundledWith` set for everything but the toolchain's
 * primary binary.
 */
export function collapseToolchains(items: SoftwareItem[]): SoftwareItem[] {
  // nvm: every binary under ~/.nvm/versions/node/<ver>/bin belongs to <ver>.
  // The PATH entry is what matters: `npm`/`npx`/`corepack` are symlinks into
  // lib/node_modules, so their realPath no longer contains the toolchain dir.
  const nvmVersion = (i: SoftwareItem): string | null => {
    const re = /\/\.nvm\/versions\/node\/([^/]+)\/bin\//;
    const m = i.installPath.match(re) ?? i.realPath.match(re);
    return m ? m[1] : null;
  };
  const nvmPrimary = new Map<string, string>(); // version -> item id of `node`
  for (const item of items) {
    if (item.manager !== "nvm") continue;
    const v = nvmVersion(item);
    if (!v) continue;
    if (item.name === "node") nvmPrimary.set(v, item.id);
  }
  const rustupPrimary = items.find((i) =>
    i.manager === "rustup" && i.name === "cargo"
  );

  return items.map((item) => {
    if (item.manager === "nvm") {
      const v = nvmVersion(item);
      if (!v) return item;
      const primary = nvmPrimary.get(v) ?? "";
      if (primary === item.id || primary === "") return item;
      return { ...item, bundledWith: `node ${v}` };
    }
    if (item.manager === "rustup") {
      if (!rustupPrimary || rustupPrimary.id === item.id) return item;
      const tc = item.realPath.match(/\/\.rustup\/toolchains\/([^/]+)\/bin\//);
      return {
        ...item,
        bundledWith: `cargo${tc ? ` (${tc[1]})` : " (rustup)"}`,
      };
    }
    return item;
  });
}

/**
 * Group items that are the same bytes under different paths.
 *
 * Toolchain-bundled copies (nvm's per-version `npm`, rustup's shims) are
 * excluded: they are the same bytes by construction and saying so every sweep is
 * noise, not a finding. What remains — two `swamp` copies, `hc` next to
 * `herdr-core` — is the real "installed twice" signal.
 */
export function findDuplicates(
  items: SoftwareItem[],
): Array<{ identity: string; paths: string[] }> {
  const byHash = new Map<string, SoftwareItem[]>();
  for (const item of items) {
    if (item.sha256 === "") continue;
    const bucket = byHash.get(item.sha256) ?? [];
    bucket.push(item);
    byHash.set(item.sha256, bucket);
  }
  const out: Array<{ identity: string; paths: string[] }> = [];
  for (const bucket of byHash.values()) {
    const relevant = bucket.filter((i) => i.bundledWith === "");
    const paths = [...new Set(relevant.map((i) => i.installPath))].sort();
    if (paths.length < 2) continue;
    // the product name is the useful label here (a duplicate of the same tool),
    // not the identity the row resolved to
    out.push({ identity: relevant[0].name, paths });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Render the read-only POSIX scanner.
 *
 * `String.raw` keeps every backslash (`\t`, `\1` in sed) exactly as written;
 * shell parameter expansion with a default is spelled `@@{VAR:-x}` and the
 * placeholder is substituted afterwards, so the TypeScript template never
 * interpolates by accident.
 */
export function renderScanScript(g: {
  maxItems: number;
  hashMaxBytes: number;
  knownDirs: boolean;
  extraDirs: string[];
  collectAddresses: boolean;
}): string {
  const extra = g.extraDirs.map((d) => `"${d.replace(/"/g, "")}"`).join(" ");
  const script = String.raw`#!/bin/sh
# fleet-census scanner — READ ONLY. Never writes to this host, never executes a
# discovered binary. Renders line-oriented TSV: <kind> TAB <fields...>
set -u

MAXITEMS=${g.maxItems}
HASHMAX=${g.hashMaxBytes}
HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)
FQDN=$(hostname -f 2>/dev/null || echo "$HOST")
ARCH=$(uname -m 2>/dev/null || echo unknown)
OS=$( (. /etc/os-release 2>/dev/null && printf '%s' "@@{PRETTY_NAME:-unknown}") || echo unknown)
MID=$(cat /etc/machine-id 2>/dev/null || echo "")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
HAS_DPKG=0; command -v dpkg >/dev/null 2>&1 && HAS_DPKG=1
HAS_GO=0;   command -v go   >/dev/null 2>&1 && HAS_GO=1
HAS_NPM=0;  command -v npm  >/dev/null 2>&1 && HAS_NPM=1
HAS_CARGO=0; command -v cargo >/dev/null 2>&1 && HAS_CARGO=1
HAS_SNAP=0; command -v snap >/dev/null 2>&1 && HAS_SNAP=1
HAS_FLATPAK=0; command -v flatpak >/dev/null 2>&1 && HAS_FLATPAK=1
HAS_BREW=0; command -v brew >/dev/null 2>&1 && HAS_BREW=1
HAS_DOCKER=0; command -v docker >/dev/null 2>&1 && HAS_DOCKER=1

printf 'meta\thost\t%s\n' "$HOST"
printf 'meta\tfqdn\t%s\n' "$FQDN"
printf 'meta\tarch\t%s\n' "$ARCH"
printf 'meta\tos\t%s\n' "$OS"
printf 'meta\tmachineId\t%s\n' "$MID"
printf 'meta\tscannedAt\t%s\n' "$NOW"
printf 'meta\ttool\tdpkg=%s go=%s npm=%s cargo=%s snap=%s flatpak=%s brew=%s docker=%s\n' \
  "$HAS_DPKG" "$HAS_GO" "$HAS_NPM" "$HAS_CARGO" "$HAS_SNAP" "$HAS_FLATPAK" "$HAS_BREW" "$HAS_DOCKER"

# ---- interfaces and addresses (the host's own truth, for address-drift checks)
if [ "${g.collectAddresses}" = "true" ]; then
  if command -v ip >/dev/null 2>&1; then
    ip -o link show 2>/dev/null | while read -r line; do
      iface=$(printf '%s' "$line" | awk -F': ' '{print $2}' | cut -d@ -f1)
      mac=$(printf '%s' "$line" | awk '{for(i=1;i<=NF;i++) if($i=="link/ether"||$i=="link/loopback"){print $(i+1);exit}}')
      printf 'iface\t%s\t%s\n' "$iface" "@@{mac:--}"
    done
    ip -o addr show 2>/dev/null | awk '{fam=$3; cidr=$4; sc="";
      for(i=1;i<=NF;i++) if($i=="scope") sc=$(i+1);
      if(fam=="inet"||fam=="inet6") printf "addr\t%s\t%s\t%s\n", $2, cidr, sc}'
  fi
fi

# ---- PATH: superset of candidate dirs, de-duplicated by realpath
DIRS=""
add_dir() { [ -n "$1" ] && [ -d "$1" ] && DIRS="$DIRS
$1|$2"; }
OLDIFS=$IFS
IFS=:
for d in $PATH; do IFS=$OLDIFS; add_dir "$d" path; IFS=:; done
IFS=$OLDIFS
if [ "${g.knownDirs}" = "true" ]; then
  for d in "$HOME/.local/bin" "$HOME/bin" "$HOME/.cargo/bin" "$HOME/go/bin" \
           "$HOME/.deno/bin" "$HOME/.bun/bin" "$HOME/.volta/bin" \
           "$HOME/.opencode/bin" "$HOME/.pi/agent/bin" "$HOME/.asdf/shims" \
           "$HOME/.local/share/pnpm"; do
    add_dir "$d" known
  done
  for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/mise/installs/*/*/bin \
           "$HOME"/.rustup/toolchains/*/bin; do
    add_dir "$d" known
  done
fi
for d in ${extra}; do add_dir "$d" extra; done

SEEN=""
SCANNED=0
UNOWNED=0
SYSFILES=0
TRUNC=0
while IFS='|' read -r d dsrc; do
  [ -n "$d" ] || continue
  [ -d "$d" ] || continue
  rd=$(readlink -f "$d" 2>/dev/null || printf '%s' "$d")
  case "|$SEEN|" in *"|$rd|"*) continue ;; esac
  SEEN="$SEEN|$rd"

  case "$rd" in
    /usr/bin|/bin|/usr/sbin|/sbin|/usr/games)
      n=0
      for f in "$rd"/*; do [ -f "$f" ] && [ -x "$f" ] && n=$((n + 1)); done
      proof=""
      k=0
      for f in "$rd"/*; do
        [ -f "$f" ] && [ -x "$f" ] || continue
        k=$((k + 1)); [ "$k" -gt 3 ] && break
        p=""
        [ "$HAS_DPKG" = 1 ] && p=$(timeout 3 dpkg -S "$(readlink -f "$f" 2>/dev/null || printf '%s' "$f")" 2>/dev/null | head -1 | cut -d: -f1)
        proof="$proof@@{p:--},"
      done
      printf 'sysdir\t%s\t%s\t%s\n' "$rd" "$n" "$proof"
      continue
      ;;
  esac

  printf 'pathdir\t%s\t%s\n' "$rd" "$dsrc"
  for f in "$rd"/*; do
    [ -f "$f" ] || continue
    [ -x "$f" ] || continue
    SCANNED=$((SCANNED + 1))
    base=$(basename "$f")
    real=$(readlink -f "$f" 2>/dev/null || printf '%s' "$f")
    own=""
    [ "$HAS_DPKG" = 1 ] && own=$(timeout 3 dpkg -S "$real" 2>/dev/null | head -1 | cut -d: -f1)
    [ -n "$own" ] && continue
    UNOWNED=$((UNOWNED + 1))
    if [ "$UNOWNED" -gt "$MAXITEMS" ]; then TRUNC=1; break; fi
    size=$(stat -c %s "$real" 2>/dev/null || stat -f %z "$real" 2>/dev/null || echo 0)
    mtime=$(stat -c %Y "$real" 2>/dev/null || echo 0)
    case "$size" in ''|*[!0-9]*) size=0 ;; esac
    sha=""
    [ "$size" -le "$HASHMAX" ] && sha=$(timeout 20 sha256sum "$real" 2>/dev/null | cut -d' ' -f1)
    magic=$(head -c 4 "$real" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')
    elf=0; [ "$magic" = "7f454c46" ] && elf=1
    gomod=""; gover=""
    if [ "$HAS_GO" = 1 ] && [ "$elf" = 1 ]; then
      gv=$(timeout 5 go version -m "$real" 2>/dev/null | awk '$1=="mod"{print $2"\t"$3; exit}')
      gomod=$(printf '%s' "$gv" | cut -f1)
      gover=$(printf '%s' "$gv" | cut -f2)
    fi
    hint="-"
    if [ "$elf" = 1 ]; then
      h=$( { head -c 1048576 "$real"; tail -c 1048576 "$real"; } 2>/dev/null \
        | strings -n 8 2>/dev/null \
        | grep -m1 -E 'get\.[a-z0-9._-]+\.sh|install\.sh|https?://[^ ]*(install|releases)' | cut -c1-100)
      [ -n "$h" ] && hint="$h"
    fi
    case "$f" in
      "$HOME"/.local/bin/*)   where=home-local-bin ;;
      /usr/local/bin/*)       where=usr-local-bin ;;
      /opt/*)                 where=opt ;;
      "$HOME"/.cargo/bin/*|"$HOME"/.rustup/toolchains/*/bin/*) where=cargo ;;
      "$HOME"/go/bin/*)       where=go-bin ;;
      "$HOME"/.deno/bin/*)    where=deno ;;
      "$HOME"/.bun/bin/*)     where=bun ;;
      "$HOME"/.volta/bin/*)   where=volta ;;
      "$HOME"/.nvm/*)         where=nvm ;;
      /snap/bin/*)            where=snap ;;
      /nix/store/*)           where=nix ;;
      *)                      where=path ;;
    esac
    printf 'bin\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$base" "$f" "$real" "$size" "$mtime" "$sha" "$elf" "$where" "$gomod" "$gover" "$hint"
  done
done <<EOF
$DIRS
EOF
printf 'meta\tsysFiles\t%s\n' "$SYSFILES"
printf 'meta\ttruncated\t%s\n' "$TRUNC"
printf 'meta\tscanned\t%s\n' "$SCANNED"
printf 'meta\tunowned\t%s\n' "$UNOWNED"

# ---- OS package managers and language ecosystems
if [ "$HAS_DPKG" = 1 ]; then
  printf 'pkgcount\tdpkg\t%s\n' "$(timeout 30 dpkg-query -W -f='@@{Package}\n' 2>/dev/null | wc -l | tr -d ' ')"
fi
[ "$HAS_SNAP" = 1 ] && timeout 10 snap list 2>/dev/null | tail -n +2 | awk 'NF>=2{printf "pkg\tsnap\t%s\t%s\n", $1, $2}'
[ "$HAS_FLATPAK" = 1 ] && timeout 10 flatpak list --app --columns=application,version 2>/dev/null \
  | awk -F'\t' 'NF>=1{printf "pkg\tflatpak\t%s\t%s\n", $1, ($2==""?"":$2)}'
[ "$HAS_BREW" = 1 ] && timeout 15 brew list --versions 2>/dev/null | awk 'NF>=2{printf "pkg\tbrew\t%s\t%s\n", $1, $2}'
[ "$HAS_CARGO" = 1 ] && timeout 15 cargo install --list 2>/dev/null \
  | awk '/^[a-zA-Z0-9_-]+ v[0-9]/{printf "pkg\tcargo\t%s\t%s\n", $1, $2}'

if [ "$HAS_NPM" = 1 ]; then
  groot=$(timeout 5 npm root -g 2>/dev/null)
  if [ -n "$groot" ] && [ -d "$groot" ]; then
    for d in "$groot"/* "$groot"/@*/*; do
      [ -f "$d/package.json" ] || continue
      ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$d/package.json" 2>/dev/null | head -1)
      printf 'npmglobal\t%s\t%s\n' "$(basename "$d")" "$ver"
    done
  fi
  npxdir="$HOME/.npm/_npx"
  if [ -d "$npxdir" ]; then
    for t in "$npxdir"/*/package.json; do
      [ -f "$t" ] || continue
      deps=$(sed -n 's/.*"dependencies" *: *{\([^}]*\)}.*/\1/p' "$t" 2>/dev/null | tr ',' ' ' | tr -d '"' | tr -s ' ')
      printf 'npxtree\t%s\t%s\n' "$(basename "$(dirname "$t")")" "@@{deps:--}"
      for b in "$(dirname "$t")"/node_modules/.bin/*; do
        [ -e "$b" ] && printf 'npxbin\t%s\t%s\n' "$(basename "$b")" "$b"
      done
    done
  fi
fi

# pip --user: which distributions provide a console script, plus their edges
for si in "$HOME"/.local/lib/python3.*/site-packages; do
  [ -d "$si" ] || continue
  for di in "$si"/*.dist-info; do
    [ -d "$di" ] || continue
    nm=$(basename "$di" .dist-info)
    ver=$(printf '%s' "$nm" | sed -n 's/^\(.*\)-\([0-9][^-]*\)$/\2/p')
    base=$(printf '%s' "$nm" | sed -n 's/^\(.*\)-[0-9][^-]*$/\1/p')
    [ -n "$base" ] || base="$nm"
    hb=0; grep -qs 'console_scripts' "$di/entry_points.txt" 2>/dev/null && hb=1
    printf 'pipuser\t%s\t%s\t%s\t%s\n' "$base" "@@{ver:--}" "$hb" "$di"
    if [ "$hb" = 1 ] && [ -f "$di/METADATA" ]; then
      grep -m 40 '^Requires-Dist:' "$di/METADATA" 2>/dev/null \
        | sed 's/^Requires-Dist: *//' | cut -d' ' -f1 | cut -d';' -f1 \
        | while read -r dep; do printf 'pipreq\t%s\t%s\n' "$base" "$dep"; done
    fi
  done
done

# venvs: explicit roots only (never walk the whole home)
for cfg in "$HOME"/.local/share/virtualenvs/*/pyvenv.cfg \
           "@@{HOME}"/venvs/*/pyvenv.cfg "@@{HOME}"/.venvs/*/pyvenv.cfg \
           "@@{HOME}"/src/*/venv/pyvenv.cfg "@@{HOME}"/src/*/.venv/pyvenv.cfg \
           "@@{HOME}"/.swamp/*/pyvenv.cfg; do
  [ -f "$cfg" ] || continue
  vdir=$(dirname "$cfg")
  pv=$(sed -n 's/^version *= *//p' "$cfg" 2>/dev/null | head -1)
  nd=0; for di in "$vdir"/lib/python*/site-packages/*.dist-info; do [ -d "$di" ] && nd=$((nd + 1)); done
  nb=0; for b in "$vdir"/bin/*; do [ -f "$b" ] && [ -x "$b" ] && nb=$((nb + 1)); done
  printf 'venv\t%s\t%s\t%s\t%s\n' "$vdir" "@@{pv:--}" "$nd" "$nb"
  for di in "$vdir"/lib/python*/site-packages/*.dist-info; do
    [ -d "$di" ] || continue
    grep -qs 'console_scripts' "$di/entry_points.txt" 2>/dev/null || continue
    nm=$(basename "$di" .dist-info)
    ver=$(printf '%s' "$nm" | sed -n 's/^\(.*\)-\([0-9][^-]*\)$/\2/p')
    base=$(printf '%s' "$nm" | sed -n 's/^\(.*\)-[0-9][^-]*$/\1/p'); [ -n "$base" ] || base="$nm"
    printf 'venvdist\t%s\t%s\t%s\n' "$vdir" "$base" "@@{ver:--}"
  done
done

# ---- containers
if [ "$HAS_DOCKER" = 1 ] && timeout 5 docker info >/dev/null 2>&1; then
  timeout 10 docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null \
    | awk -F'\t' 'NF>=2{printf "container\t%s\t%s\t%s\n", $1, $2, $3}'
  timeout 10 docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}' 2>/dev/null \
    | awk -F'\t' 'NF>=2{printf "image\t%s\t%s\t%s\n", $1, $2, $3}'
fi

# ---- systemd units (both scopes) and their state
for u in "$HOME"/.config/systemd/user/*.service /etc/systemd/system/*.service; do
  [ -f "$u" ] || continue
  scope=system; case "$u" in "$HOME"/*) scope=user ;; esac
  ex=$(sed -n 's/^ExecStart=//p' "$u" 2>/dev/null | head -1)
  printf 'unit\t%s\t%s\t%s\t%s\n' "$scope" "$(basename "$u" .service)" "@@{ex:--}" "$u"
done
command -v systemctl >/dev/null 2>&1 && {
  systemctl --user list-units --type=service --all --no-legend --plain 2>/dev/null \
    | awk '{printf "unitstate\tuser\t%s\t%s\n", $1, $3}' | sed 's/\.service//'
  systemctl list-units --type=service --all --no-legend --plain 2>/dev/null \
    | awk '{printf "unitstate\tsystem\t%s\t%s\n", $1, $3}' | sed 's/\.service//'
}

for d in /opt/*; do [ -d "$d" ] && printf 'optdir\t%s\n' "$(basename "$d")"; done
printf 'meta\tdone\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
`;
  return script.split("@@").join("$");
}

// ---------------------------------------------------------------------------
// Scan execution
// ---------------------------------------------------------------------------

export interface ScanRunner {
  run: (
    script: string,
    timeoutMs: number,
  ) => Promise<
    { code: number; stdout: string; stderr: string; timedOut: boolean }
  >;
}

/** Run the scanner locally through `sh -s` with the script on stdin. */
export function localRunner(): ScanRunner {
  return {
    run: async (script, timeoutMs) => {
      // locally with the script on stdin; no argv interpolation.
      // swamp-quality-ignore deno-command: runs the rendered POSIX scanner
      const cmd = new Deno.Command("sh", {
        args: ["-s"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = cmd.spawn();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, timeoutMs);
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(script));
      await writer.close();
      const out = await child.output();
      clearTimeout(timer);
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
        timedOut,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Building the resources
// ---------------------------------------------------------------------------

function num(v: string | undefined): number {
  const n = Number(v ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/** Build the item list from parsed scan records. */
export function buildItems(
  records: ScanRecord[],
  opts: { home?: string; user?: string; uid?: string } = {},
): SoftwareItem[] {
  const items: SoftwareItem[] = [];

  const units = new Map<string, { active: string; scope: string }>();
  for (const r of records) {
    if (r.kind === "unitstate" && r.fields.length >= 3) {
      units.set(`${r.fields[0]}\u0000${r.fields[1]}`, {
        active: r.fields[2],
        scope: r.fields[0],
      });
    }
  }

  // PATH executables and nix-store binaries
  for (const r of records) {
    if (r.kind !== "bin" || r.fields.length < 11) continue;
    const [name, path, real, size, mtime, sha, , where, gomod, gover] =
      r.fields;
    let id = identityOf({ name, gomod, path: real });
    // A name-only binary has no identity of its own; if the catalogue knows the
    // upstream repository, use it — that is what gives `swamp` a link and a
    // freshness lookup instead of a dead end.
    if (id.kind === "name") {
      const entry = catalogEntryFor(name, id.name);
      if (entry?.upstreamRepo) {
        id = { kind: "github", name: entry.upstreamRepo };
      }
    }
    const ver = versionOf({ name, gomod, gover, path: real });
    const manager = managerOf({ where, name, gomod, path: real });
    const owner = ownerOf(name, id.name);
    const evidence = [{ signal: "path", detail: `not owned by dpkg: ${real}` }];
    evidence.push({ signal: "version", detail: ver.evidence });
    if (gomod !== "" && gomod !== "-") {
      evidence.push({ signal: "build-info", detail: `go module ${gomod}` });
    }
    if (where === "usr-local-bin") {
      evidence.push({
        signal: "provenance-note",
        detail: "/usr/local/bin is not evidence of OS management",
      });
    }
    items.push({
      id: `${path}`,
      name: splitNameVersion(name).name,
      identity: id,
      version: ver.version,
      versionSource: ver.source,
      manager,
      provenance: manager === "none" ? "hand-installed" : "language",
      installPath: path,
      realPath: real,
      sizeBytes: num(size),
      mtime: num(mtime) > 0 ? new Date(num(mtime) * 1000).toISOString() : "",
      sha256: sha ?? "",
      owner,
      evidence,
      flags: [],
      bundledWith: "",
    });
  }

  // pip --user distributions that provide a console script
  for (const r of records) {
    if (r.kind !== "pipuser" || r.fields.length < 4) continue;
    const [name, version, hasBin, di] = r.fields;
    if (hasBin !== "1") continue;
    const id = { kind: "pypi" as const, name };
    items.push({
      id: `pip:${name}`,
      name,
      identity: id,
      version: version === "-" ? "" : version,
      versionSource: version === "-" ? "unknown" : "dist-info",
      manager: "pip",
      provenance: "language",
      installPath: di,
      realPath: di,
      sizeBytes: 0,
      mtime: "",
      sha256: "",
      owner: ownerOf(name, name),
      evidence: [{
        signal: "dist-info",
        detail: `${di} provides a console script`,
      }],
      flags: [],
      bundledWith: "",
    });
  }

  // venv distributions that provide a console script
  for (const r of records) {
    if (r.kind !== "venvdist" || r.fields.length < 3) continue;
    const [vdir, name, version] = r.fields;
    items.push({
      id: `venv:${vdir}:${name}`,
      name,
      identity: { kind: "pypi", name },
      version: version === "-" ? "" : version,
      versionSource: version === "-" ? "unknown" : "dist-info",
      manager: "pip-venv",
      provenance: "language",
      installPath: `${vdir}/bin/${name}`,
      realPath: vdir,
      sizeBytes: 0,
      mtime: "",
      sha256: "",
      owner: ownerOf(name, name),
      evidence: [{ signal: "venv", detail: `${vdir} console script` }],
      flags: [],
      bundledWith: "",
    });
  }

  // npm global packages
  for (const r of records) {
    if (r.kind !== "npmglobal" || r.fields.length < 2) continue;
    const [name, version] = r.fields;
    items.push({
      id: `npm:${name}`,
      name,
      identity: { kind: "npm", name },
      version: version ?? "",
      versionSource: version ? "dist-info" : "unknown",
      manager: "npm",
      provenance: "language",
      installPath: `npm global: ${name}`,
      realPath: "",
      sizeBytes: 0,
      mtime: "",
      sha256: "",
      owner: ownerOf(name, name),
      evidence: [{ signal: "npm-global", detail: `npm root -g: ${name}` }],
      flags: [],
      bundledWith: "",
    });
  }

  // snap / flatpak / brew / cargo packages
  for (const r of records) {
    if (r.kind !== "pkg" || r.fields.length < 3) continue;
    const [manager, name, version] = r.fields;
    if (manager === "cargo") continue; // already covered by ~/.cargo/bin items
    // snap and flatpak are system package managers, so they are `managed` (the
    // agreed definition: OS/system package manager OR swamp). brew and the
    // user-level managers are not.
    const systemPkg = manager === "snap" || manager === "flatpak";
    items.push({
      id: `${manager}:${name}`,
      name,
      identity: { kind: "name", name },
      version: version ?? "",
      versionSource: "package-db",
      manager,
      provenance: systemPkg ? "os" : "third-party",
      installPath: `${manager}: ${name}`,
      realPath: "",
      sizeBytes: 0,
      mtime: "",
      sha256: "",
      owner: systemPkg
        ? {
          class: "managed",
          extension: "",
          command: "",
          confidence: 0.8,
        }
        : { class: "unknown", extension: "", command: "", confidence: 0 },
      evidence: [{
        signal: manager,
        detail: `${manager} package ${name}${
          systemPkg ? " (system package manager)" : " (user-level manager)"
        }`,
      }],
      flags: [],
      bundledWith: "",
    });
  }

  // container images (one item per image reference)
  for (const r of records) {
    if (r.kind !== "image" || r.fields.length < 3) continue;
    const [ref, id, created] = r.fields;
    if (ref.endsWith(":<none>")) continue;
    const [repo, tag] = ref.split(":");
    items.push({
      id: `oci:${ref}`,
      name: repo.split("/").pop() ?? repo,
      identity: { kind: "oci", name: repo },
      version: tag === "latest" ? "" : tag,
      versionSource: tag && tag !== "latest" ? "filename" : "unknown",
      manager: "oci",
      provenance: "container",
      installPath: ref,
      realPath: "",
      sizeBytes: 0,
      mtime: created ?? "",
      sha256: id ?? "",
      owner: { class: "unknown", extension: "", command: "", confidence: 0 },
      evidence: [{ signal: "docker-image", detail: `${ref} (${id})` }],
      flags: tag === "latest" ? ["floating-tag"] : [],
      bundledWith: "",
    });
  }

  // Which systemd units run each item, and in which scope. Kept separately from
  // the evidence strings so the ownership decision below is a typed lookup.
  const unitsByItem = new Map<string, string[]>();

  // attach unit state as usage evidence and flag running-but-unowned binaries
  for (const item of items) {
    for (const r of records) {
      if (r.kind !== "unit" || r.fields.length < 4) continue;
      const [scope, unitName, execStart] = r.fields;
      if (execStart === "-" || execStart === "") continue;
      const parsed = parseExecStart(execStart, {
        home: opts.home ?? "",
        user: opts.user ?? "",
        uid: opts.uid ?? "",
      });
      if (parsed.command !== item.installPath) continue;
      const state = units.get(`${scope}\u0000${unitName}`);
      item.evidence.push({
        signal: "systemd-unit",
        detail: `${scope} unit ${unitName} runs this binary${
          state ? ` (${state.active})` : ""
        }${parsed.wrapped ? " [wrapped in a shell]" : ""}`,
      });
      const seenUnits = unitsByItem.get(item.id) ?? [];
      seenUnits.push(unitName);
      unitsByItem.set(item.id, seenUnits);
    }
  }

  // Ownership, with host evidence: an item is `managed` only when a unit that the
  // owning extension installs is running this exact binary on this host. A
  // catalogue hit without that evidence stays `manageable` — "an extension could
  // own this", which is exactly the migration candidate.
  for (const item of items) {
    if (item.owner.class !== "manageable") continue;
    const entry = catalogEntryFor(item.name, item.identity.name);
    const unit = managedByUnit(entry, unitsByItem.get(item.id) ?? []);
    if (!entry || unit === "") continue;
    item.owner = {
      class: "managed",
      extension: entry.extension,
      command: entry.command,
      confidence: 0.7,
    };
    item.evidence.push({
      signal: "managed-by",
      detail:
        `unit '${unit}' is installed by ${entry.extension} and runs this binary on this host`,
    });
    item.flags = item.flags.filter((f) => f !== "no-manager");
  }

  // flags
  for (const item of items) {
    if (item.version === "") item.flags.push("unknown-version");
    if (item.mtime !== "") {
      const ageDays = (Date.now() - Date.parse(item.mtime)) / 86_400_000;
      if (ageDays > 730) item.flags.push("stale-mtime");
    }
    // "no-manager" means nothing manages it at all: no package manager AND no
    // swamp owner. A swamp-managed binary with manager=none is not unmanaged.
    if (
      item.manager === "none" && item.provenance === "hand-installed" &&
      item.owner.class === "unknown"
    ) {
      item.flags.push("no-manager");
    }
    if (item.owner.class === "unknown") item.flags.push("no-owner");
  }

  return collapseToolchains(items);
}

/** Build the host resource from parsed scan records. */
export function buildHost(
  records: ScanRecord[],
  opts: { durationMs: number; truncated: boolean; warnings: string[] },
): z.infer<typeof HostSchema> {
  const meta = new Map<string, string>();
  for (const r of records) {
    if (r.kind === "meta" && r.fields.length >= 2) {
      meta.set(r.fields[0], r.fields[1]);
    }
  }
  const pathDirs: Array<{ dir: string; source: string }> = [];
  for (const r of records) {
    if (r.kind === "pathdir" && r.fields.length >= 2) {
      pathDirs.push({ dir: r.fields[0], source: r.fields[1] });
    }
  }
  let sysFiles = 0;
  for (const r of records) {
    if (r.kind === "sysdir" && r.fields.length >= 2) {
      sysFiles += num(r.fields[1]);
    }
  }
  const ifaces = new Map<string, { mac: string; addresses: string[] }>();
  for (const r of records) {
    if (r.kind === "iface" && r.fields.length >= 2) {
      const [name, mac] = r.fields;
      const entry = ifaces.get(name) ?? { mac: "", addresses: [] };
      entry.mac = mac === "-" ? "" : mac;
      ifaces.set(name, entry);
    }
  }
  for (const r of records) {
    if (r.kind === "addr" && r.fields.length >= 3) {
      const [name, cidr] = r.fields;
      const entry = ifaces.get(name) ?? { mac: "", addresses: [] };
      entry.addresses.push(cidr);
      ifaces.set(name, entry);
    }
  }
  const interfaces = [...ifaces.entries()].map(([name, v]) => ({
    name,
    mac: v.mac,
    kind: interfaceKind(name, v.mac),
    addresses: v.addresses,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const addresses = interfaces.flatMap((i) => i.addresses)
    .map((c) => c.split("/")[0])
    // keep only routable addresses: loopback and IPv6 link-local never identify
    // a host across the fleet and would drown the inventory comparison.
    .filter((a) =>
      !a.startsWith("127.") && a !== "::1" &&
      !a.toLowerCase().startsWith("fe80:") &&
      !a.startsWith("169.254.")
    )
    .filter((a, i, arr) => arr.indexOf(a) === i)
    .sort();

  return {
    hostname: meta.get("host") ?? "",
    fqdn: meta.get("fqdn") ?? "",
    machineId: meta.get("machineId") ?? "",
    os: meta.get("os") ?? "",
    arch: meta.get("arch") ?? "",
    scannedAt: meta.get("scannedAt") ?? new Date().toISOString(),
    durationMs: opts.durationMs,
    pathDirs,
    interfaces,
    addresses,
    counts: {
      osManagedExecutables: sysFiles,
      unownedExecutables: num(meta.get("unowned")),
      items: 0,
      byManager: {},
      byProvenance: {},
      byOwner: {},
    },
    warnings: opts.warnings,
    truncated: opts.truncated,
  };
}

/** Fill the count maps once the items are known. */
export function countItems(
  host: z.infer<typeof HostSchema>,
  items: SoftwareItem[],
): z.infer<typeof HostSchema> {
  const byManager: Record<string, number> = {};
  const byProvenance: Record<string, number> = {};
  const byOwner: Record<string, number> = {};
  for (const item of items) {
    byManager[item.manager] = (byManager[item.manager] ?? 0) + 1;
    byProvenance[item.provenance] = (byProvenance[item.provenance] ?? 0) + 1;
    byOwner[item.owner.class] = (byOwner[item.owner.class] ?? 0) + 1;
  }
  return {
    ...host,
    counts: {
      ...host.counts,
      items: items.length,
      byManager,
      byProvenance,
      byOwner,
    },
  };
}

/** Build the summary resource. */
export function buildSummary(
  host: z.infer<typeof HostSchema>,
  items: SoftwareItem[],
): z.infer<typeof SummarySchema> {
  const duplicates = findDuplicates(items);
  const unknownVersion = items.filter((i) => i.version === "").map((i) =>
    i.name
  );
  const lines = [
    `fleet-census on ${
      host.hostname || host.fqdn
    }: ${items.length} item(s) not owned by the OS package manager.`,
    `  unowned PATH executables: ${host.counts.unownedExecutables}, OS-managed executables: ${host.counts.osManagedExecutables}`,
    `  by manager: ${JSON.stringify(host.counts.byManager)}`,
    `  by owner:   ${JSON.stringify(host.counts.byOwner)}`,
    duplicates.length > 0
      ? `  duplicates (same bytes, several paths): ${
        duplicates.map((d) => d.identity).join(", ")
      }`
      : "  duplicates: none",
    unknownVersion.length > 0
      ? `  unknown version: ${unknownVersion.slice(0, 12).join(", ")}${
        unknownVersion.length > 12 ? " …" : ""
      }`
      : "  unknown version: none",
  ];
  return {
    hostname: host.hostname,
    items: items.length,
    unowned: host.counts.unownedExecutables,
    osManaged: host.counts.osManagedExecutables,
    byManager: host.counts.byManager,
    byOwner: host.counts.byOwner,
    duplicates,
    unknownVersion,
    nextCommands: lines.join("\n"),
    scannedAt: host.scannedAt,
  };
}

// ---------------------------------------------------------------------------
// Fleet fan-out: per-host results, and the software index across hosts
// ---------------------------------------------------------------------------

const CensusHostResultSchema = z.object({
  host: z.string(),
  ok: z.boolean(),
  reachedVia: z.string().default(""),
  error: z.string().default(""),
  scannedAt: z.string().default(""),
  durationMs: z.number().default(0),
  items: z.number().default(0),
  unowned: z.number().default(0),
  osManaged: z.number().default(0),
  os: z.string().default(""),
  arch: z.string().default(""),
  addresses: z.array(z.string()).default([]),
  searchDomains: z.array(z.string()).default([]),
  byManager: z.record(z.string(), z.number()).default({}),
  byOwner: z.record(z.string(), z.number()).default({}),
});

const SoftwareIndexRowSchema = z.object({
  /** Best identity seen for this product (github/go/npm/pypi/oci/name). */
  identity: z.string(),
  /** Every distinct identity that resolved to this product. */
  identities: z.array(z.string()).default([]),
  name: z.string(),
  /** One entry per host that HAS it. */
  hosts: z.array(z.object({
    host: z.string(),
    version: z.string().default(""),
    manager: z.string().default(""),
    owner: z.string().default(""),
    flags: z.array(z.string()).default([]),
    /** How many separate installs of it this host has (e.g. two swamp copies). */
    installs: z.number().default(1),
  })).default([]),
  /** Distinct non-empty versions, sorted — more than one means skew. */
  versions: z.array(z.string()).default([]),
  skewed: z.boolean().default(false),
  managedOn: z.array(z.string()).default([]),
  manageableOn: z.array(z.string()).default([]),
  /** The swamp extension that owns (or could own) it, and how to convert. */
  extension: z.string().default(""),
  command: z.string().default(""),
  /** Hosts that were scanned successfully and do NOT have it. */
  missingOn: z.array(z.string()).default([]),
});

const FreshnessRowSchema = z.object({
  name: z.string(),
  repo: z.string().default(""),
  /** Installed versions seen on the fleet, per host. */
  installed: z.array(z.object({
    host: z.string(),
    version: z.string().default(""),
    channel: z.string().default("unknown"),
  })).default([]),
  latest: z.object({
    version: z.string(),
    publishedAt: z.string(),
    tag: z.string().default(""),
  }).nullable().default(null),
  lts: z.object({
    version: z.string(),
    publishedAt: z.string(),
    tag: z.string().default(""),
  }).nullable().default(null),
  dev: z.object({
    version: z.string(),
    publishedAt: z.string(),
    tag: z.string().default(""),
  }).nullable().default(null),
  archived: z.boolean().default(false),
  /** Days since the newest upstream release (or last push when none). */
  upstreamIdleDays: z.number().nullable().default(null),
  /** Oldest installed version's age, in days, when it matches a known tag. */
  oldestInstalledDays: z.number().nullable().default(null),
  behindMajor: z.number().default(0),
  flags: z.array(z.string()).default([]),
  error: z.string().default(""),
});

const FreshnessSchema = z.object({
  rows: z.array(FreshnessRowSchema).default([]),
  summary: z.object({
    products: z.number().default(0),
    withUpstream: z.number().default(0),
    abandoned: z.number().default(0),
    idle1y: z.number().default(0),
    idle2y: z.number().default(0),
    behindMajor: z.number().default(0),
    devInstalls: z.number().default(0),
    unknownVersion: z.number().default(0),
  }),
  generatedAt: z.string(),
});

const FleetCensusSchema = z.object({
  hosts: z.array(CensusHostResultSchema).default([]),
  software: z.array(SoftwareIndexRowSchema).default([]),
  summary: z.object({
    hosts: z.number(),
    ok: z.number(),
    failed: z.number(),
    items: z.number(),
    unowned: z.number(),
    skewed: z.number(),
    manageable: z.number(),
    unknown: z.number(),
    byOwner: z.record(z.string(), z.number()).default({}),
    byManager: z.record(z.string(), z.number()).default({}),
  }),
  scannedAt: z.string(),
});

/**
 * Cross-host software index: one row per identity, with the version each host
 * has, the hosts that do NOT have it, and whether the fleet disagrees on the
 * version. This is the data the software-indexed report renders; it is computed
 * here so the report never has to join per-host resources itself.
 */
export function buildSoftwareIndex(
  perHost: Array<{ host: string; ok: boolean; items: SoftwareItem[] }>,
): Array<z.infer<typeof SoftwareIndexRowSchema>> {
  const okHosts = perHost.filter((h) => h.ok).map((h) => h.host);
  // The row key is the PRODUCT NAME, not the identity: the same tool reports
  // `github:Gaurav-Gosain/tuios` where Go build info is present and plain
  // `name:tuios` where it is not, and a report that splits those into two rows is
  // wrong. The strongest identity seen is kept for display.
  const rank = (kind: string): number =>
    ({ github: 5, go: 4, npm: 3, pypi: 3, oci: 2, name: 1 } as Record<
      string,
      number
    >)[
      kind
    ] ?? 0;
  const rows = new Map<string, z.infer<typeof SoftwareIndexRowSchema>>();
  for (const h of perHost) {
    if (!h.ok) continue;
    for (const item of h.items) {
      const key = item.name.toLowerCase();
      const identity = `${item.identity.kind}:${item.identity.name}`;
      const row = rows.get(key) ?? {
        identity,
        identities: [],
        name: item.name,
        hosts: [],
        versions: [],
        skewed: false,
        managedOn: [],
        manageableOn: [],
        extension: "",
        command: "",
        missingOn: [],
      };
      if (rank(item.identity.kind) > rank(row.identity.split(":")[0])) {
        row.identity = identity;
      }
      if (!row.identities.includes(identity)) row.identities.push(identity);
      const existing = row.hosts.find((e) => e.host === h.host);
      if (existing) {
        // the same host has it twice (two install paths): count the install,
        // keep the more informative version
        existing.installs += 1;
        if (!existing.version && item.version) existing.version = item.version;
        if (existing.owner !== "managed" && item.owner.class === "managed") {
          existing.owner = "managed";
        }
      } else {
        row.hosts.push({
          host: h.host,
          version: item.version,
          manager: item.manager,
          owner: item.owner.class,
          flags: item.flags,
          installs: 1,
        });
      }
      if (item.owner.extension && row.extension === "") {
        row.extension = item.owner.extension;
      }
      if (item.owner.command && row.command === "") {
        row.command = item.owner.command;
      }
      if (item.owner.class === "managed") row.managedOn.push(h.host);
      if (item.owner.class === "manageable") row.manageableOn.push(h.host);
      rows.set(key, row);
    }
  }
  const out = [...rows.values()];
  for (const row of out) {
    row.hosts.sort((a, b) => a.host.localeCompare(b.host));
    row.managedOn = [...new Set(row.managedOn)].sort();
    row.manageableOn = [...new Set(row.manageableOn)].sort();
    row.versions = [...new Set(row.hosts.map((e) => e.version).filter(Boolean))]
      .sort();
    row.skewed = row.versions.length > 1;
    const have = new Set(row.hosts.map((e) => e.host));
    row.missingOn = okHosts.filter((h) => !have.has(h));
  }
  return out.sort((a, b) => a.identity.localeCompare(b.identity));
}

/** Aggregate the fleet resource from per-host results. */
export function buildFleet(
  hosts: Array<z.infer<typeof CensusHostResultSchema>>,
  software: Array<z.infer<typeof SoftwareIndexRowSchema>>,
  timestamp: string,
): z.infer<typeof FleetCensusSchema> {
  const byOwner: Record<string, number> = {};
  const byManager: Record<string, number> = {};
  for (const h of hosts) {
    for (const [k, v] of Object.entries(h.byOwner)) {
      byOwner[k] = (byOwner[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(h.byManager)) {
      byManager[k] = (byManager[k] ?? 0) + v;
    }
  }
  return {
    hosts,
    software,
    summary: {
      hosts: hosts.length,
      ok: hosts.filter((h) => h.ok).length,
      failed: hosts.filter((h) => !h.ok).length,
      items: hosts.reduce((n, h) => n + h.items, 0),
      unowned: hosts.reduce((n, h) => n + h.unowned, 0),
      skewed: software.filter((s) => s.skewed).length,
      manageable: software.reduce((n, s) => n + s.manageableOn.length, 0),
      unknown: byOwner.unknown ?? 0,
      byOwner,
      byManager,
    },
    scannedAt: timestamp,
  };
}

// ---------------------------------------------------------------------------
// Freshness and abandonment
// ---------------------------------------------------------------------------

/** `1.2.3`, `v1.2.3`, `1.2` -> numeric parts; null when unparseable. */
export function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const v = version.trim().replace(/^v(?=\d)/, "").split(/[-+]/)[0];
  const parts = v.split(".");
  if (parts.length === 0 || !/^\d+$/.test(parts[0])) return null;
  return {
    major: Number(parts[0]),
    minor: parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0,
    patch: parts[2] && /^\d+$/.test(parts[2]) ? Number(parts[2]) : 0,
  };
}

/** -1 when a < b, 0 equal, 1 when a > b; unparseable sorts as -1. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

/** Days between an ISO timestamp and now (negative -> 0), or null. */
export function ageDays(iso: string, now = Date.now()): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * Which channel an installed version belongs to: `dev` (equals the newest
 * prerelease), `lts`, `latest`, `behind` (older than latest), or `unknown`.
 */
export function classifyChannel(
  installed: string,
  channels: {
    latest?: { version: string } | null;
    lts?: { version: string } | null;
    dev?: { version: string } | null;
  },
): string {
  if (installed === "") return "unknown";
  if (channels.dev && compareSemver(installed, channels.dev.version) === 0) {
    return "dev";
  }
  if (channels.lts && compareSemver(installed, channels.lts.version) === 0) {
    return "lts";
  }
  if (
    channels.latest && compareSemver(installed, channels.latest.version) === 0
  ) {
    return "latest";
  }
  if (
    channels.latest && compareSemver(installed, channels.latest.version) < 0
  ) {
    return "behind";
  }
  return "unknown";
}

export interface ReleaseMetaRepo {
  repo: string;
  ok: boolean;
  error?: string;
  archived?: boolean;
  pushedAt?: string;
  /** publishedAt is carried through tags so installed ages can be resolved. */
  latest?: { version: string; publishedAt: string; tag?: string } | null;
  lts?: { version: string; publishedAt: string; tag?: string } | null;
  dev?: { version: string; publishedAt: string; tag?: string } | null;
  tags?: Array<{ version: string; publishedAt: string; prerelease: boolean }>;
}

/**
 * Join the software index with release metadata into freshness rows.
 *
 * Everything here is derived from the two data sets plus the clock: no network,
 * so a re-run with cached metadata is cheap and deterministic.
 */
export function buildFreshness(
  software: Array<z.infer<typeof SoftwareIndexRowSchema>>,
  releases: ReleaseMetaRepo[],
  opts: {
    now?: number;
    idleWarnDays?: number;
    idleBadDays?: number;
    generatedAt: string;
  },
): z.infer<typeof FreshnessSchema> {
  const now = opts.now ?? Date.now();
  const idleWarn = opts.idleWarnDays ?? 365;
  const idleBad = opts.idleBadDays ?? 730;
  const byRepo = new Map(releases.map((r) => [r.repo.toLowerCase(), r]));

  const rows: Array<z.infer<typeof FreshnessRowSchema>> = [];
  for (const product of software) {
    const repo = product.identity.startsWith("github:")
      ? product.identity.substring("github:".length)
      : "";
    if (repo === "") continue;
    const meta = byRepo.get(repo.toLowerCase());
    const installed = product.hosts.map((h) => ({
      host: h.host,
      version: h.version,
      channel: classifyChannel(h.version, meta ?? {}),
    }));
    const tagDates = new Map(
      (meta?.tags ?? []).map((t) => [t.version, t.publishedAt]),
    );
    const installedAges = installed
      .map((i) =>
        i.version === "" ? null : ageDays(tagDates.get(i.version) ?? "", now)
      )
      .filter((d): d is number => d !== null);
    const upstreamIdleDays = meta
      ? ageDays(
        meta.latest?.publishedAt || meta.pushedAt || "",
        now,
      )
      : null;
    const latestSemver = meta?.latest ? parseSemver(meta.latest.version) : null;
    const behindMajor = Math.max(
      0,
      ...installed.map((i) => {
        const p = parseSemver(i.version);
        return p && latestSemver
          ? Math.max(0, latestSemver.major - p.major)
          : 0;
      }),
    );

    const flags: string[] = [];
    if (meta && !meta.ok) flags.push("upstream-lookup-failed");
    if (meta?.archived) flags.push("archived");
    if (upstreamIdleDays !== null && upstreamIdleDays > idleBad) {
      flags.push("upstream-idle-2y");
    } else if (upstreamIdleDays !== null && upstreamIdleDays > idleWarn) {
      flags.push("upstream-idle-1y");
    }
    if (behindMajor > 0) flags.push("behind-major");
    if (installed.some((i) => i.channel === "dev")) flags.push("dev-install");
    if (installed.every((i) => i.version === "")) flags.push("unknown-version");
    if (installed.some((i) => i.channel === "behind")) flags.push("behind");

    rows.push({
      name: product.name,
      repo,
      installed,
      latest: meta?.latest
        ? { ...meta.latest, tag: meta.latest.tag ?? "" }
        : null,
      lts: meta?.lts ? { ...meta.lts, tag: meta.lts.tag ?? "" } : null,
      dev: meta?.dev ? { ...meta.dev, tag: meta.dev.tag ?? "" } : null,
      archived: meta?.archived ?? false,
      upstreamIdleDays,
      oldestInstalledDays: installedAges.length > 0
        ? Math.max(...installedAges)
        : null,
      behindMajor,
      flags,
      error: meta?.error ?? "",
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows,
    summary: {
      products: rows.length,
      withUpstream: rows.filter((r) => r.latest !== null).length,
      abandoned:
        rows.filter((r) => r.archived || r.flags.includes("upstream-idle-2y"))
          .length,
      idle1y: rows.filter((r) => r.flags.includes("upstream-idle-1y")).length,
      idle2y: rows.filter((r) => r.flags.includes("upstream-idle-2y")).length,
      behindMajor: rows.filter((r) => r.flags.includes("behind-major")).length,
      devInstalls: rows.filter((r) => r.flags.includes("dev-install")).length,
      unknownVersion: rows.filter((r) => r.flags.includes("unknown-version"))
        .length,
    },
    generatedAt: opts.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Fleet fan-out plumbing
// ---------------------------------------------------------------------------

/** `~/…` -> an absolute path. */
export function expandHome(path: string): string {
  if (path === "~") return Deno.env.get("HOME") ?? path;
  if (path.startsWith("~/")) {
    return `${Deno.env.get("HOME") ?? ""}${path.slice(1)}`;
  }
  return path;
}

/**
 * Where this site's reports should be served, derived from what is already here:
 * the zone the installed caddy models own (`baseDomain`) and this machine's own
 * hostname. Nothing is invented: with no caddy model there is no zone, and the
 * caller must not publish rather than guess a placeholder domain.
 */
export async function deriveSite(
  run: (argv: string[]) => Promise<{ code: number; stdout: string }>,
  localHostname: string,
): Promise<{ hostname: string; baseDomain: string } | null> {
  const listRaw = await run(["behavior", "list", "--json"]);
  if (!listRaw.stdout) return null;
  let names: string[] = [];
  try {
    const parsed = JSON.parse(listRaw.stdout);
    const list = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
    names = list
      .filter((m: { type?: string }) => m.type === "@svendowideit/caddy")
      .map((m: { name?: string }) => String(m.name ?? ""))
      .filter((n: string) => n !== "");
  } catch {
    return null;
  }
  for (const name of names) {
    const raw = await run(["behavior", "get", name, "--json"]);
    if (!raw.stdout) continue;
    try {
      const model = JSON.parse(raw.stdout);
      const baseDomain = String(model?.globalArguments?.baseDomain ?? "").trim()
        .replace(/^\./, "");
      if (!baseDomain) continue;
      const host = localHostname.trim().split(".")[0].toLowerCase();
      return {
        baseDomain,
        hostname: host ? `census.${host}.${baseDomain}` : "",
      };
    } catch {
      // unreadable model: try the next one
    }
  }
  return null;
}

/** The swamp binary to shell out to: the running executable, else PATH. */
function swampBinary(): string {
  try {
    const exe = Deno.execPath();
    if (exe && !/\/(deno|swamp-worker)$/.test(exe)) return exe;
  } catch {
    // fall through
  }
  return "swamp";
}

/** Whether the scanner reported that it hit the item cap. */
export function scanTruncated(records: ScanRecord[]): boolean {
  const done = records.some((r) => r.kind === "meta" && r.fields[0] === "done");
  const truncated = records.some((r) =>
    r.kind === "meta" && r.fields[0] === "truncated" && r.fields[1] === "1"
  );
  // a scan that never reached `meta done` was cut short (timeout/kill)
  return truncated || !done;
}

/** Run the scanner on a host over SSH, script on stdin (one round-trip). */
export async function runRemoteScan(
  script: string,
  dest: string,
  timeoutMs: number,
): Promise<
  { code: number; stdout: string; stderr: string; timedOut: boolean }
> {
  // options plus a validated user@host, script on stdin.
  // swamp-quality-ignore deno-command: the remote scanner transport; fixed
  const child = new Deno.Command("ssh", {
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `ConnectTimeout=${
        Math.max(3, Math.min(10, Math.ceil(timeoutMs / 1000)))
      }`,
      dest,
      "sh -s",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, timeoutMs);
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const out = await child.output();
  clearTimeout(timer);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  return {
    code: out.code,
    stdout: dec(out.stdout),
    stderr: dec(out.stderr),
    timedOut,
  };
}

/**
 * The scan targets: every host the fleet model knows (addresses first, then
 * names, because a name that resolves elsewhere must not make a reachable host
 * look down), or the explicit list.
 */
export async function resolveTargets(
  args: { hosts: string[]; fleetModel: string },
  ctx: {
    readModelData?: (
      modelName: string,
      specName?: string,
    ) => Promise<Array<{ content?: unknown; version?: number }>>;
  },
): Promise<Array<{ label: string; candidates: string[] }>> {
  const latest = async (
    spec: string,
  ): Promise<Array<Record<string, unknown>>> => {
    if (!ctx.readModelData) return [];
    try {
      const rows = await ctx.readModelData(args.fleetModel, spec);
      const top = (rows ?? []).reduce<{ version?: number; content?: unknown }>(
        (a, b) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a),
        {},
      );
      const hosts = (top.content as { hosts?: unknown } | undefined)?.hosts;
      return Array.isArray(hosts)
        ? (hosts as Array<Record<string, unknown>>)
        : [];
    } catch {
      return [];
    }
  };

  const fleetHosts = [
    ...(await latest("inventory")),
    ...(await latest("probe")),
  ];
  const candidatesFor = (
    h: Record<string, unknown>,
    fallback = "",
  ): string[] => {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const arr = (
      v: unknown,
    ) => (Array.isArray(v)
      ? v.filter((x) => typeof x === "string") as string[]
      : []);
    const addrs = [str(h.address), ...arr(h.addresses)].filter((a) =>
      /^[0-9.]+$/.test(a) || a.includes(":")
    );
    const names = [str(h.name), ...arr(h.hostnames)].filter((n) =>
      n !== "" && !/^[0-9.]+$/.test(n)
    );
    return [...new Set([...addrs, ...names, fallback])].filter(Boolean);
  };

  if (args.hosts.length > 0) {
    return args.hosts.map((h) => {
      const key = h.toLowerCase();
      const known = fleetHosts.find((f) =>
        [
          f.name,
          f.address,
          ...(Array.isArray(f.addresses) ? f.addresses : []),
          ...(Array.isArray(f.hostnames) ? f.hostnames : []),
        ]
          .some((v) => typeof v === "string" && v.toLowerCase() === key)
      );
      return known
        ? {
          label: String(known.name || h),
          candidates: candidatesFor(known, h),
        }
        : { label: h, candidates: [h] };
    });
  }

  // Fleet list: one target per MACHINE. Prefer hosts the inventory actually
  // probed (a machine id means we reached it at least once); a raw scan hit is
  // an address, not a machine, and scanning a hundred of them on a schedule is
  // noise. Fall back to every known host when nothing has been probed yet.
  const probed = fleetHosts.filter((h) =>
    h.probed === true || (typeof h.machineId === "string" && h.machineId !== "")
  );
  const selected = probed.length > 0 ? probed : fleetHosts;
  const seen = new Set<string>();
  const out: Array<{ label: string; candidates: string[] }> = [];
  for (const h of selected) {
    const label = String(h.name || h.address || "");
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, candidates: candidatesFor(h) });
  }
  return out.filter((t) => t.candidates.length > 0);
}

/**
 * Fill in versions for binaries that carry none, using ONLY the catalogue's own
 * fixed `versionProbe` (never a probe derived from discovered data), and only
 * when the model opts in with `execProbe=true`.
 */
export async function applyVersionProbes(
  items: SoftwareItem[],
  run: (
    path: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string }>,
): Promise<SoftwareItem[]> {
  for (const item of items) {
    if (item.version !== "") continue;
    if (!item.installPath.startsWith("/")) continue;
    const entry = catalogEntryFor(item.name, item.identity.name);
    const probe = entry?.versionProbe;
    if (!probe) continue;
    try {
      const res = await run(item.installPath, probe.args);
      if (res.code !== 0) continue;
      const m = res.stdout.match(new RegExp(probe.pattern));
      if (!m) continue;
      item.version = m[1].replace(/^v/, "");
      item.versionSource = "cli";
      item.flags = item.flags.filter((f) => f !== "unknown-version");
      item.evidence.push({
        signal: "version-probe",
        detail: `${item.installPath} ${probe.args.join(" ")} -> ${
          m[1].trim()
        } (catalogue-owned probe)`,
      });
    } catch {
      // a probe that fails leaves the version unknown, which is honest
    }
  }
  return items;
}

/** Run a local binary with a fixed argv, bounded and with no shell. */
function localExec(): (
  path: string,
  args: string[],
) => Promise<{ code: number; stdout: string }> {
  return async (path, args) => {
    // (`swamp --version`, `caddy version`), only when execProbe is enabled.
    // swamp-quality-ignore deno-command: the catalogue's own fixed version probe
    const child = new Deno.Command(path, {
      args,
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 4000);
    const out = await child.output();
    clearTimeout(timer);
    return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
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
}

/** A model that censuses the software this host's OS package manager does not own. */
export const model = {
  type: "@svendowideit/fleet-census",
  version: "2026.11.21.3",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.11.21.1",
      description:
        "Initial release: scan this host read-only for software the OS package " +
        "manager does not own (PATH superset, package DB, Go build info, pip/" +
        "npx/npm, containers, systemd units, nix store), classify its provenance " +
        "and manager, record interface addresses and MACs for inventory drift, " +
        "and write `host`, `software` and `summary`. Never executes a discovered " +
        "binary.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.21.2",
      description:
        "The sweep workflow runs itself every six hours (0 */6 * * *) and, with " +
        "no `hosts` input, scans the machines the fleet-inventory model has " +
        "actually probed rather than every raw scan hit. Also from the review: " +
        "the scanner reports hitting maxItems (`meta truncated`) instead of " +
        "breaking silently, the host record carries that warning, per-host data " +
        "names are de-duplicated when two machines share a hostname, and the kill " +
        "timer starts before the script is written to stdin. Additive.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.21.3",
      description:
        "No shipped trigger, and no configured site. A published extension must " +
        "not start a fleet scan on someone else's swamp, so the trigger is gone: " +
        "scheduling is one entry in the site's .swamp/serve.yaml `triggers:` " +
        "block. And the site needs no inputs — `publish` derives the zone from the " +
        "installed @svendowideit/caddy models and the hostname as " +
        "census.<this host>.<zone>, and refuses to publish at all rather than fall " +
        "back to a placeholder domain. reportHostname/reportBaseDomain defaults " +
        "are empty (derive), not example.com.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    host: {
      description:
        "This host's census summary: identity, interfaces/addresses, path dirs, counts.",
      schema: HostSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    software: {
      description:
        "Every item not owned by the OS package manager, with provenance, manager, version evidence and swamp-owner candidate.",
      schema: z.object({ items: z.array(SoftwareItemSchema) }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    summary: {
      description:
        "Counts, duplicates and unknown-version list, plus drill-in commands.",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    site: {
      description: "The rendered report site: directory, files and counts",
      schema: z.object({
        dir: z.string(),
        files: z.array(z.string()).default([]),
        hosts: z.number().default(0),
        products: z.number().default(0),
        generatedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    publish: {
      description: "The Caddy model + route that serves the report site",
      schema: z.object({
        model: z.string().default(""),
        hostname: z.string().default(""),
        root: z.string().default(""),
        ok: z.boolean().default(false),
        output: z.string().default(""),
        publishedAt: z.string().default(""),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    freshness: {
      description:
        "Upstream freshness per product: latest/LTS/dev channels from @svendowideit/github-release-install, installed age, how far behind, and abandonment flags",
      schema: FreshnessSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    fleet: {
      description:
        "One sweep across the fleet: per-host results (unreachable hosts included) and the software index across hosts (versions per host, missing hosts, version skew)",
      schema: FleetCensusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    census: {
      description:
        "Scan every host in the fleet over SSH (one round-trip each, bounded " +
        "parallelism, unreachable hosts recorded not fatal) and write per-host " +
        "`host`/`software` plus the cross-host `fleet` software index. With no " +
        "`hosts` argument it uses the @svendowideit/fleet-inventory model's host " +
        "list. No discovered binary is executed on any host.",
      arguments: CensusArgsSchema,
      execute: async (
        args: z.infer<typeof CensusArgsSchema>,
        ctx: MethodContext & {
          readModelData?: (
            modelName: string,
            specName?: string,
          ) => Promise<Array<{ content?: unknown; version?: number }>>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = ctx.globalArgs;
        const script = renderScanScript({
          maxItems: args.maxItems,
          hashMaxBytes: args.hashMaxBytes,
          knownDirs: g.knownDirs,
          extraDirs: g.extraDirs,
          collectAddresses: g.collectAddresses,
        });

        const targets = await resolveTargets(args, ctx);
        if (targets.length === 0) {
          throw new Error(
            "fleet-census: no hosts to scan. Pass hosts, or run " +
              "@svendowideit/fleet-inventory so the fleet model has a host list.",
          );
        }

        const results: Array<{
          meta: z.infer<typeof CensusHostResultSchema>;
          items: SoftwareItem[];
          host: z.infer<typeof HostSchema> | null;
        }> = [];
        const stamp = new Date().toISOString();
        let next = 0;
        const worker = async () => {
          while (true) {
            const i = next++;
            if (i >= targets.length) return;
            const target = targets[i];
            const started = Date.now();
            let ok = false;
            let via = "";
            let error = "";
            let records: ScanRecord[] = [];
            for (const candidate of target.candidates) {
              const dest = args.sshUser
                ? `${args.sshUser}@${candidate}`
                : candidate;
              const run = await runRemoteScan(
                script,
                dest,
                args.timeoutSec * 1000,
              );
              if (run.code === 0 && run.stdout.trim() !== "") {
                records = parseScan(run.stdout);
                ok = true;
                via = candidate;
                break;
              }
              error = run.timedOut
                ? `timed out after ${args.timeoutSec}s`
                : `exit ${run.code}: ${run.stderr.trim().slice(0, 200)}`;
            }
            if (!ok) {
              results[i] = {
                meta: {
                  host: target.label,
                  ok: false,
                  reachedVia: "",
                  error,
                  scannedAt: "",
                  durationMs: Date.now() - started,
                  items: 0,
                  unowned: 0,
                  osManaged: 0,
                  os: "",
                  arch: "",
                  addresses: [],
                  searchDomains: [],
                  byManager: {},
                  byOwner: {},
                },
                items: [],
                host: null,
              };
              continue;
            }
            const truncated = scanTruncated(records);
            const hostWarnings: string[] = [];
            if (truncated) {
              hostWarnings.push(
                `item list truncated at maxItems=${args.maxItems}`,
              );
            }
            let items = buildItems(records, {
              home: Deno.env.get("HOME") ?? "",
              user: Deno.env.get("USER") ?? "",
              uid: Deno.env.get("UID") ?? "",
            });
            if (g.execProbe) {
              items = await applyVersionProbes(items, localExec());
            }
            const host = countItems(
              buildHost(records, {
                durationMs: Date.now() - started,
                truncated: !/^meta\tdone\t/m.test(
                  records.map((r) => `${r.kind}\t${r.fields.join("\t")}`).join(
                    "\n",
                  ),
                ),
                warnings: [],
              }),
              items,
            );
            results[i] = {
              meta: {
                host: host.hostname || target.label,
                ok: true,
                reachedVia: via,
                error: "",
                scannedAt: host.scannedAt,
                durationMs: host.durationMs,
                items: items.length,
                unowned: host.counts.unownedExecutables,
                osManaged: host.counts.osManagedExecutables,
                os: host.os,
                arch: host.arch,
                addresses: host.addresses,
                searchDomains: [],
                byManager: host.counts.byManager,
                byOwner: host.counts.byOwner,
              },
              items,
              host,
            };
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.max(1, Math.min(args.parallel, targets.length)) },
            worker,
          ),
        );

        // Write after the fan-out: one writer, no lock contention, and each host
        // gets its own data names so per-host data is queryable by host.
        const handles: Array<{ name: string }> = [];
        for (const r of results) {
          if (!r.host || !r.meta.ok) continue;
          handles.push(
            await ctx.writeResource(
              "host",
              r.meta.host,
              r.host as unknown as Record<string, unknown>,
            ),
          );
          handles.push(
            await ctx.writeResource("software", `${r.meta.host}.software`, {
              items: r.items,
            }),
          );
        }
        const software = buildSoftwareIndex(
          results.map((r) => ({
            host: r.meta.host,
            ok: r.meta.ok,
            items: r.items,
          })),
        );
        const fleet = buildFleet(results.map((r) => r.meta), software, stamp);
        handles.push(
          await ctx.writeResource(
            "fleet",
            "fleet",
            fleet as unknown as Record<string, unknown>,
          ),
        );
        ctx.logger?.info(
          "fleet-census: {ok}/{hosts} host(s) scanned ({failed} unreachable), " +
            "{items} item(s), {index} identit(ies) — {skewed} with version skew, " +
            "{manageable} manageable occurrence(s); by owner {byOwner}",
          {
            ok: fleet.summary.ok,
            hosts: fleet.summary.hosts,
            failed: fleet.summary.failed,
            items: fleet.summary.items,
            index: software.length,
            skewed: fleet.summary.skewed,
            manageable: fleet.summary.manageable,
            byOwner: JSON.stringify(fleet.summary.byOwner),
          },
        );
        return { dataHandles: handles };
      },
    },

    report: {
      description:
        "Render the three HTML reports (index, by-software version matrix, " +
        "by-host attention ranking) and census.json into the output directory, " +
        "and write a `site` resource.",
      arguments: ReportArgsSchema,
      execute: async (
        args: z.infer<typeof ReportArgsSchema>,
        ctx: MethodContext & {
          readResource?: (name: string) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = ctx.globalArgs;
        const dir = expandHome(args.outputDir || g.outputDir);
        const fleet = await ctx.readResource?.("fleet") as
          | (FleetData & { scannedAt?: string })
          | null;
        if (!fleet || !Array.isArray(fleet.software)) {
          throw new Error(
            "fleet-census report: no `fleet` data yet — run `census` first.",
          );
        }
        let freshness: FreshnessData | null = null;
        try {
          freshness = await ctx.readResource?.("freshness") as
            | FreshnessData
            | null;
        } catch {
          freshness = null;
        }
        const generatedAt = new Date().toISOString();
        const files: Array<[string, string]> = [
          ["index.html", renderIndex(fleet, freshness, generatedAt)],
          ["software.html", renderSoftware(fleet, freshness, generatedAt)],
          ["host.html", renderHosts(fleet, freshness, generatedAt)],
          ["census.json", renderJson(fleet, freshness, generatedAt)],
        ];
        await Deno.mkdir(dir, { recursive: true });
        for (const [name, body] of files) {
          await Deno.writeTextFile(`${dir}/${name}`, body);
        }
        const handle = await ctx.writeResource("site", "site", {
          dir,
          files: files.map(([n]) => n),
          hosts: fleet.hosts.length,
          products: fleet.software.length,
          generatedAt,
        });
        ctx.logger?.info(
          "reports written to {dir}: {files} ({hosts} host(s), {products} product(s))",
          {
            dir,
            files: files.map(([n]) => n).join(", "),
            hosts: fleet.hosts.length,
            products: fleet.software.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    publish: {
      description:
        "Serve the report directory through the @svendowideit/caddy model: " +
        "create/reuse a caddy model for the zone and ensure a file_server route " +
        "at the hostname (DNS record and TLS are derived by caddy).",
      arguments: PublishArgsSchema,
      execute: async (
        args: z.infer<typeof PublishArgsSchema>,
        ctx: MethodContext & {
          readResource?: (name: string) => Promise<unknown>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = ctx.globalArgs;
        const root = expandHome(args.rootDir || g.outputDir);
        const swampBin = swampBinary();
        const run = async (argv: string[]) => {
          // through the swamp CLI (the extension-composition path documented in
          // network-status); argv is literals plus validated hostname/root.
          // swamp-quality-ignore deno-command: creates/updates the caddy model
          const child = new Deno.Command(swampBin, {
            args: argv,
            stdout: "piped",
            stderr: "piped",
          }).spawn();
          const out = await child.output();
          const dec = (b: Uint8Array) => new TextDecoder().decode(b);
          return {
            code: out.code,
            stdout: dec(out.stdout),
            stderr: dec(out.stderr),
          };
        };

        // Everything site-specific is derived when it was not given: the zone
        // comes from the caddy models that already own one, and the hostname is
        // census.<this host>.<zone>. A placeholder domain is never published — if
        // nothing can be derived, this stops and says so.
        let baseDomain = args.baseDomain.trim();
        let hostname = args.hostname.trim();
        if (baseDomain === "" || hostname === "") {
          let hostnameForDerivation = "";
          try {
            hostnameForDerivation = Deno.hostname();
          } catch {
            hostnameForDerivation = Deno.env.get("HOSTNAME") ?? "";
          }
          const site = await deriveSite(run, hostnameForDerivation);
          if (site) {
            baseDomain = baseDomain || site.baseDomain;
            hostname = hostname || site.hostname;
          }
        }
        if (hostname === "" || baseDomain === "") {
          const reason =
            `no caddy model with a baseDomain is installed, and no hostname/zone ` +
            `was given: refusing to publish to a placeholder`;
          ctx.logger?.warn?.("not publishing: {reason}", { reason });
          const handle = await ctx.writeResource("publish", "publish", {
            model: args.model,
            hostname: "",
            root,
            ok: false,
            output: reason,
            publishedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Create the caddy model only if it is not already there: it carries the
        // zone and the record address, and merges with the peer models that
        // already manage this Caddy (status-caddy, my-caddy, …).
        const existing = await run(["behavior", "get", args.model, "--json"]);
        const created: string[] = [];
        if (existing.code !== 0) {
          const create = await run([
            "model",
            "create",
            "@svendowideit/caddy",
            args.model,
            "--global-arg",
            `baseDomain=${baseDomain}`,
            "--global-arg",
            "serviceName=caddy",
            "--global-arg",
            `routeIp=${args.routeIp}`,
            "--global-arg",
            "autoRouteDns=true",
            "--global-arg",
            "autoRouteTls=true",
          ]);
          created.push(
            create.code === 0
              ? `created ${args.model}`
              : `could not create ${args.model}: ${
                (create.stderr || create.stdout).trim().slice(0, 300)
              }`,
          );
        }
        const route = await run([
          "behavior",
          "run",
          args.model,
          "addRoute",
          "--input",
          `hostname=${hostname}`,
          "--input",
          "kind=file_server",
          "--input",
          `root=${root}`,
        ]);
        const ok = route.code === 0;
        const output = [
          ...created,
          ok ? "route ensured" : (route.stderr ||
            route.stdout).trim().slice(0, 500),
        ].join("; ");
        const handle = await ctx.writeResource("publish", "publish", {
          model: args.model,
          hostname,
          root,
          ok,
          output,
          publishedAt: new Date().toISOString(),
        });
        if (ok) {
          ctx.logger?.info(
            "serving {root} at https://{hostname} through {model} ({output})",
            {
              root,
              hostname,
              model: args.model,
              output: output || "ok",
            },
          );
        } else {
          ctx.logger?.warn?.(
            "could not publish https://{hostname}: {output}",
            { hostname, output },
          );
        }
        return { dataHandles: [handle] };
      },
    },

    assess: {
      description:
        "Join the fleet software index with @svendowideit/github-release-install " +
        "release metadata into freshness rows: the latest/LTS/dev channels, how " +
        "old the installed versions are, how far behind, and abandonment flags " +
        "(archived, upstream idle > 1y / > 2y, behind a major).",
      arguments: AssessArgsSchema,
      execute: async (
        args: z.infer<typeof AssessArgsSchema>,
        ctx: MethodContext & {
          readResource?: (name: string) => Promise<unknown>;
          readModelData?: (
            modelName: string,
            specName?: string,
          ) => Promise<Array<{ content?: unknown; version?: number }>>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const generatedAt = new Date().toISOString();
        let software: Array<z.infer<typeof SoftwareIndexRowSchema>> = [];
        try {
          const fleet = await ctx.readResource?.("fleet") as
            | { software?: Array<z.infer<typeof SoftwareIndexRowSchema>> }
            | null;
          software = fleet?.software ?? [];
        } catch {
          software = [];
        }
        if (software.length === 0) {
          throw new Error(
            "fleet-census assess: no `fleet` data yet — run `census` first.",
          );
        }

        let releases: ReleaseMetaRepo[] = [];
        try {
          const rows = await ctx.readModelData?.(
            args.releaseMetaModel,
            "releases",
          ) ?? [];
          const latest = rows.reduce<{ version?: number; content?: unknown }>(
            (a, b) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a),
            {},
          );
          const list = (latest.content as { repos?: unknown } | undefined)
            ?.repos;
          if (Array.isArray(list)) releases = list as ReleaseMetaRepo[];
        } catch {
          releases = [];
        }
        if (releases.length === 0) {
          ctx.logger?.warn(
            "fleet-census assess: no release metadata from '{model}' — rows will " +
              "have no upstream channel or idle time (run the metadata step)",
            { model: args.releaseMetaModel },
          );
        }

        const freshness = buildFreshness(software, releases, {
          idleWarnDays: args.idleWarnDays,
          idleBadDays: args.idleBadDays,
          generatedAt,
        });
        const handle = await ctx.writeResource(
          "freshness",
          "freshness",
          freshness as unknown as Record<string, unknown>,
        );
        ctx.logger?.info(
          "freshness: {products} product(s), {upstream} with upstream data — " +
            "{abandoned} abandoned (archived or idle >2y), {idle1y} idle >1y, " +
            "{behindMajor} behind a major, {dev} on a dev channel, {unknown} unknown version",
          {
            products: freshness.summary.products,
            upstream: freshness.summary.withUpstream,
            abandoned: freshness.summary.abandoned,
            idle1y: freshness.summary.idle1y,
            behindMajor: freshness.summary.behindMajor,
            dev: freshness.summary.devInstalls,
            unknown: freshness.summary.unknownVersion,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    inventory: {
      description:
        "Scan this host (read-only) for software the OS package manager does " +
        "not own, classify it, and write `host`, `software` and `summary`. No " +
        "discovered binary is executed.",
      arguments: InventoryArgsSchema,
      execute: async (
        _args: unknown,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = ctx.globalArgs;
        const script = renderScanScript({
          maxItems: g.maxItems,
          hashMaxBytes: g.hashMaxBytes,
          knownDirs: g.knownDirs,
          extraDirs: g.extraDirs,
          collectAddresses: g.collectAddresses,
        });
        const started = Date.now();
        const result = await localRunner().run(
          script,
          g.scanTimeoutSec * 1000,
        );
        const durationMs = Date.now() - started;
        const warnings: string[] = [];
        if (result.timedOut) {
          warnings.push(
            `scan hit the ${g.scanTimeoutSec}s budget and was killed; results are partial`,
          );
        }
        if (result.code !== 0) {
          warnings.push(
            `scanner exited ${result.code}: ${result.stderr.slice(0, 400)}`,
          );
        }
        if (result.stdout.trim() === "") {
          throw new Error(
            `fleet-census scanner produced no output (exit ${result.code}): ${
              result.stderr.slice(0, 800)
            }`,
          );
        }
        const records = parseScan(result.stdout);
        const truncated = scanTruncated(records);
        if (truncated) {
          warnings.push(
            `item list truncated at maxItems=${g.maxItems} (raise maxItems for a full census)`,
          );
        }
        let items = buildItems(records, {
          home: Deno.env.get("HOME") ?? "",
          user: Deno.env.get("USER") ?? "",
          uid: Deno.env.get("UID") ?? "",
        });
        if (g.execProbe) items = await applyVersionProbes(items, localExec());
        const host = countItems(
          buildHost(records, { durationMs, truncated, warnings }),
          items,
        );
        const summary = buildSummary(host, items);

        const hostHandle = await ctx.writeResource("host", "host", host);
        const softwareHandle = await ctx.writeResource("software", "software", {
          items,
        });
        const summaryHandle = await ctx.writeResource(
          "summary",
          "summary",
          summary,
        );
        ctx.logger?.info(
          "fleet-census on {host}: {items} item(s), {unowned} unowned " +
            "executable(s), {managed} managed / {manageable} manageable / {unknown} unknown",
          {
            host: host.hostname || host.fqdn,
            items: items.length,
            unowned: host.counts.unownedExecutables,
            managed: host.counts.byOwner.managed ?? 0,
            manageable: host.counts.byOwner.manageable ?? 0,
            unknown: host.counts.byOwner.unknown ?? 0,
          },
        );
        return { dataHandles: [hostHandle, softwareHandle, summaryHandle] };
      },
    },
  },
};
