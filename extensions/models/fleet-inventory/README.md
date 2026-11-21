# @svendowideit/fleet-inventory

A [swamp](https://swamp-club.com) model extension that maintains a live inventory
of the machines on a network and catches the ones that go **silent**. It is the
"state awareness" backbone of a fleet: which hosts exist, what each runs, and
which inventoried hosts have stopped reporting.

## What it does

- **Discover** — merge host feeds from other models (`@jeremy/nmap`,
  `@svendowideit/mdns`, manual entries) and/or run an optional TCP-connect CIDR
  scan (a host is live if any probed port is open).
- **Probe** — SSH into hosts and collect facts (hostname, machine-id, OS, docker,
  container, memory, immutable flag) and infer a device tier. The probe script is
  portable: Linux reads `/etc/machine-id` / `/etc/os-release` / `/proc/meminfo`,
  macOS reads its `IOPlatformUUID` via `ioreg` (with a `system_profiler` fallback)
  and `hw.memsize`, and both work over a POSIX shell.
- **Correlate** — merge discovery + probe into one inventory and mark hosts that
  are inventoried but not reporting telemetry as **silent**.
- **Report** — coverage percentage, counts by tier and OS, and the silent-host
  list.

Side effects: it opens TCP connections (`discover` with a CIDR) and SSH sessions
(`probe`), writes a JSON inventory under `outputDir`, and writes swamp resources.
It installs no services, cron triggers, or webhooks.

## Install

```sh
swamp extension pull @svendowideit/fleet-inventory
```

No hard dependencies. `probe` uses any OpenSSH client; the feed-based `discover`
path needs nothing external.

## Configuration

Global arguments are set at model creation (or `swamp model edit fleet`). All are
optional.

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `sshUser` | string | `""` | Default SSH user for `probe`. |
| `defaultTier` | string | `T1` | Tier assigned when probing cannot infer one. |
| `outputDir` | string | `~/.local/share/fleet-inventory` | Directory where `inventory.json` is written. |

## Examples

> **Prefer the bundled workflow `@svendowideit/fleet-inventory-sweep`** — it does
> the whole pipeline in one command (see below). The individual methods are
> documented after it for finer control.

The all-in-one sweep (discover → probe → fingerprint → enrich → report):

```sh
# Scan a /20 and classify every host. discovery accumulates, so re-running with
# a different CIDR ADDS to the inventory rather than replacing it; run with no
# cidr to reuse what is already discovered (e.g. to re-fingerprint only).
swamp workflow run @svendowideit/fleet-inventory-sweep --input cidr=198.51.100.0/24

# Reuse existing discovery and just re-probe + re-classify (no CIDR):
swamp workflow run @svendowideit/fleet-inventory-sweep

# Skip classification if you only want discovery + SSH facts:
swamp workflow run @svendowideit/fleet-inventory-sweep --input fingerprint=false
```

**The sweep ends with a summary.** A workflow-scope report,
`@svendowideit/fleet-inventory-report`, prints after the run: the host count and
tier / OS / device-class breakdown, plus the **explained commands** to view any
of the gathered data (so you only dive deeper when something looks wrong):

```sh
# Re-print the summary for the most recent sweep.
swamp report get @svendowideit/fleet-inventory-report --workflow @svendowideit/fleet-inventory-sweep --markdown
```

Scan a subnet and merge feeds from discovery models:

```sh
# A host is live if any listed port accepts a connection. Accumulates across
# runs, so scanning a large range in chunks builds one inventory.
swamp model method run fleet discover \
  --input cidr=192.0.2.0/24 \
  --input 'ports:json=[22,80,443]'
```

Probe hosts over SSH for facts. Pass `hosts` to probe a specific list, or
**omit it to probe every inventoried host** (the whole discovered set):

```sh
# Probe named hosts only. Use this to (re)probe a few machines without waiting
# for a full sweep, or to probe hosts a feed supplied.
swamp model method run fleet probe \
  --input 'hosts:json=["core.example.com","pi-01.example.com"]' \
  --input sshUser=admin
```

```sh
# No hosts -> probe every inventoried host that has NOT already been probed
# successfully. This is the usual second step after `discover`; you don't repeat
# the discovered list. Runs 16 at a time. Add --input refresh=true to re-probe all.
swamp model method run fleet probe
```

Probe results **accumulate**: each run merges into the previous probed set, so
re-probing a subset updates those hosts and leaves the rest. With no `hosts`,
hosts that already probed successfully are **skipped** (pass `--input
refresh=true` to force a full re-probe); hosts that failed are retried, since
they may have come online. The `probe` resource reports this run's `attempted`
and `probed`, the `skipped` count, and `known` (cumulative probed machines).

Correlate against the hosts your backend says are reporting:

```sh
# Merge discovery+probe into the inventory, and mark hosts absent from
# reportingHosts as silent. Supply reportingHosts or every host reads "silent".
swamp model method run fleet correlate \
  --input 'reportingHosts:json=["core.example.com","pi-01.example.com"]'
```

> **`correlate` needs a reporting list.** With no `reportingHosts` it still
> builds the inventory (the discovery+probe merge) but marks **every** host
> silent, because it has been told none are reporting — so the silent count is
> meaningless. The reporting list is a query against your telemetry backend
> (which hosts have a fresh `host.name`/`host.id`); that backend feed is
> **deferred to Phase 1** (it needs a running store). Until then, correlate's
> value is the consolidated inventory, and `reportingHosts` can be passed by
> hand for a test.

Read the coverage report:

```sh
# Summarises total/reporting/silent, coverage %, and tier/OS counts.
swamp model method run fleet report
swamp data get fleet report --json | jq '.attributes'
```

Enrich the inventory with device classes from fingerprinting:

```sh
# Feed in the output of @svendowideit/device-fingerprint (or mdns) to add
# deviceClass/vendor to matching hosts. Matches by any name or address.
swamp model method run fleet enrich \
  --input 'fingerprints:json=[{"host":"192.0.2.1","deviceClass":"unifi","vendor":"Ubiquiti"}]'
swamp data get fleet inventory --json | jq '.content.byClass'
```

## Details

`@svendowideit/fleet-inventory` ships one model type
(`@svendowideit/fleet-inventory`). Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `discover` | `cidr` (string), `ports` (array, default `[22,80,443]`), `feeds` (array of host objects), `timeoutMs` (integer, default 1000), `maxHosts` (integer, default 0 = whole CIDR) | Merge host feeds with an optional TCP-connect scan; write a `discovery` resource. **Accumulates** over the previous discovery, so repeated/chunked scans build one inventory. The CIDR is normalised to its network address, a timed-out connect is aborted (no fd leak), and `truncated` reports when `maxHosts` capped the sweep. |
| `probe` | `hosts` (array), `sshUser` (string), `timeoutMs` (integer, default 10000), `refresh` (boolean, default false) | SSH-probe hosts for facts and infer tiers; write a `probe` resource. **Empty `hosts` probes every inventoried host that has not already probed successfully** (from `discovery`, else the last `inventory`); pass `hosts` to probe a specific list, or `refresh=true` to re-probe all. Probes 16 at a time. Results **accumulate** across runs (`known` = cumulative probed machines; `probed`/`attempted`/`skipped` are this run's counts). Records unreachable hosts with `probed: false`. |
| `correlate` | `reportingHosts` (array) | Merge discovery + probe (probe facts win, including the `probed` flag), mark hosts absent from `reportingHosts` silent, write `inventory.json` and an `inventory` resource. With an empty `reportingHosts` it still builds the inventory but every host reads silent — supply the reporting set (a backend query, Phase 1) for real silent-host detection. |
| `network` | `domains` (array, default `[]`), `discoverDomains` (boolean, default true), `resolveDns` (boolean, default true), `dnsTimeoutMs` (integer, default 3000) | Build the address/MAC/DNS index from the inventory plus the **previous** index; write a `network` resource. Classifies each address `static` (configured manually), `dhcp-pinned` (same address as last sweep), `dhcp-dynamic` (the host's address changed) or `dhcp` (first sighting); records MACs that appear on more than one host (`moved`), physical NIC counts vs software-defined interfaces, DNS names that resolve away from the host's own addresses (`dnsMismatches`), and each host's `addressDrift`. Keeps MACs/addresses seen earlier but absent now, with their `lastSeen`. |
| `report` | none | Read the `inventory` **resource** (falling back to the on-disk `inventory.json`) and write a `report` resource (total, reporting, silent, coverage %, by tier/OS). |
| `enrich` | `fingerprints` (array of `{host, deviceClass, vendor}`) | Merge device-fingerprint results into the inventory: each host is matched by any of its names/addresses and gains `deviceClass`/`vendor`; writes the `inventory` resource (with a `byClass` tally) and `inventory.json`. |

Resources: `discovery`, `probe`, `inventory`, `network`, and `report`.

### Each step records only what it fills

Because the steps are a pipeline, each writes its own host shape rather than one
fat record with fields it cannot fill:

- `discover` → observed hosts: `name`, `address`, `mac`, `macs`, `hostnames`,
  `addresses`, `source`, `tier`, `os`, `lastSeen`.
- `probe` → probed hosts: `name`, `address`, `machineId`, `hostnames`,
  `addresses`, `macs`, `interfaces`, `addressKinds`, `searchDomains`,
  `reachedVia` (which candidate address or name actually answered), `source`,
  `tier`, `os`, `probed`, `lastSeen`.
- `inventory` → the merged, classified host: all of the above plus `deviceClass`,
  `vendor`, `reporting`, `silent`, `notes`, `mac`, `interfaces`,
  `addressKinds`, `addressDrift`. `byClass` is computed by both `correlate` and
  `enrich`, so a correlate after an enrich no longer drops the classes.

So a raw `probe` snapshot never shows empty `deviceClass`/`vendor`/`reporting`
fields — those exist only once `enrich`/`correlate` have run.

### Network awareness: addresses, MACs, DNS

`probe` collects the host's own network truth, and `network` indexes it across
sweeps:

- **interfaces** — `name`, `mac`, `physical` (the kernel exposes
  `/sys/class/net/<if>/device`), `kind`
  (`ethernet`/`wifi`/`vpn`/`bridge`/`virtual`/`loopback`), `method` (the NM
  `IP4.METHOD`, e.g. `manual`/`auto`) and every `addresses[]` entry in CIDR form.
  A physical NIC is therefore distinguishable from a container bridge or a
  tailscale interface without guessing from names.
- **address kinds** — `static`, `dhcp-pinned` (same address as the last sweep, so
  a reservation or a long lease), `dhcp-dynamic` (the host's address changed) or
  `dhcp` (first sighting; needs one more sweep to say).
- **MAC movement** — a MAC seen on two hosts is flagged `moved` with both hosts
  and both interface names: exactly how a USB NIC or a docking station shows up.
- **DNS** — every hostname is resolved on the controller and compared with the
  addresses the host reports; a name that reaches none of them is a
  `dnsMismatch` (the host-a case: `host-a` resolved to a stale address while
  `host-a.lan.example.net` was right).
- **drift** — `correlate` marks any stored address the host did not report as
  `addressDrift`, so an inventory record going stale is visible per host instead
  of presenting as a host that "went silent".

```sh
swamp model method run fleet network
swamp data get fleet network --json | jq '.content.summary'
# {
#   "hosts": 6, "physicalNics": 7, "softwareInterfaces": 24,
#   "macs": 12, "movedMacs": 1, "dnsMismatches": 1, "hostsWithDrift": 2
# }
```

The index is cumulative: a dock that is unplugged keeps its `lastSeen`, so the
history does not vanish when the hardware does.

### Domains: lan.example.net, swamp-served zones, and any others

A host's DNS identity is not one name. Each host is looked up **bare** and as
`<host>.<domain>` in every domain the model knows about, and the domains are
**discovered**, not just configured. Each entry carries a `source`:

| source | where it comes from | example |
| --- | --- | --- |
| `swamp` | each installed `@svendowideit/caddy` model's `baseDomain` — the zones swamp serves DNS and TLS for | `swamp.example.com` |
| `dhcp` | the host's own resolver/DHCP search domain (`resolv.conf` search, `nmcli IP4.DOMAIN`, `resolvectl domain`) | `lan.example.net`, `tailscale.example.net` |
| `configured` | the `domains` argument | anything you add by hand |

So a new zone swamp serves, and the domain your router hands out with every
lease, both appear without editing anything. `swampManaged` is still set for
swamp-served zones, and a subdomain used as a caddy `baseDomain`
(`swamp.example.com`) collapses into the widest zone it belongs to.

```sh
# lan.example.net is yours; swamp.example.com is discovered from the caddy models as swamp-managed
swamp model method run fleet network --input 'domains:json=["lan.example.net"]'
swamp data get fleet network --json | jq '.content.hosts[] | select(.host=="host-a") | .dns'
# [
#   { "domain": "",            "name": "host-a",              "addresses": ["198.51.100.78"], "matchesHost": true, "swampManaged": false },
#   { "domain": "swamp.example.com",       "name": "host-a.swamp.example.com",       "addresses": ["192.0.2.123"],  "matchesHost": true, "swampManaged": true  },
#   { "domain": "lan.example.net", "name": "host-a.lan.example.net", "addresses": ["192.0.2.123"],  "matchesHost": true, "swampManaged": false }
# ]
```

That answers, per host: which names reach it, in which domain; which domains have
no record for it (a host swamp does not serve yet); and which names resolve
somewhere else (`staleNames`) — the per-domain form of the host-a
`192.0.2.126` finding. `hostsWithNoDns` counts hosts no name reaches at all.

### The `fleet-inventory-sweep` workflow

One command for the whole pipeline: `discover → probe → fingerprint → enrich →
report`. It auto-creates its models by type (no pre-setup) and takes `cidr`,
`ports`, `sshUser`, `probeTimeoutMs`, and `fingerprint` inputs. Leave `cidr`
empty to reuse existing discovery; because `discover` accumulates, passing a new
`cidr` **adds** to the inventory. The fingerprint step needs
`@svendowideit/device-fingerprint` (declared as an extension dependency);
`correlate` is deliberately absent until the Phase 1 reporting feed exists.

```sh
swamp workflow run @svendowideit/fleet-inventory-sweep --input cidr=198.51.100.0/24
```

### Seeing the cumulative probed set

`swamp data get fleet probe` returns the **accumulated** probed set (every
machine probed so far, with its latest facts), not just the last run:

```sh
# The cumulative probed hosts, with machine id, addresses, tier and OS.
swamp data get fleet probe --json | jq '.content.hosts[] | select(.probed) | {name, machineId, addresses, tier, os}'
# This run's vs cumulative counts.
swamp data get fleet probe --json | jq '.content | {probed, attempted, known}'
```

### The host model

Each host record carries `name`, `address`, `mac`, `source`, `tier`, `os`,
`notes`, `probed`, `reporting`, `silent`, and `lastSeen`. Probe facts take
precedence over discovery when the same host is seen twice (they carry OS/tier).

### Tier inference

`inferTier` classifies a host from probe facts: container → `T0`, immutable →
`T4`, ≤4 GB memory → `T2`, else `T1`. A host whose facts are absent or
inconclusive falls back to the model's `defaultTier`.

### Silent-host detection

`correlate` compares inventoried host names and addresses (case-insensitively)
against `reportingHosts` — the names your backend query returns as currently
sending telemetry. A host in the inventory but not in that set is `silent`,
which is exactly the drift you want to alert on.

### Host identity and merging

One record per **machine**, keyed by an identity hierarchy:

1. **machine id** — the stable OS/hardware id where known (Linux `/etc/machine-id`,
   Windows `MachineGuid`, macOS `IOPlatformUUID`). Strongest: survives IP,
   hostname, and dock changes.
2. **hostname** — used when no machine id is known (un-probeable hosts, embedded
   devices). Two records sharing a name but carrying two *different* machine ids
   are **not** merged (duplicate name).
3. **address / MAC** — weak aliases merged **only when at least one side is
   anonymous** (no machine id and no name). So a scan that finds only an IP joins
   the host that later probed that address, but two *named* hosts are never glued
   together by a transiently shared IP (reused DHCP lease) or MAC (a roaming
   docking station).

A host accumulates **all** its `addresses`, `macs`, and `hostnames`, so a
multi-homed machine (wifi + wired) is one record with several addresses. Linux
and macOS hosts yield a machine id over SSH (`/etc/machine-id` and the
`IOPlatformUUID` respectively); Windows, Android, and ESP32 hosts have no such
id over a POSIX shell, so they fall to hostname/address — unless a feed supplies
a `machineId` (e.g. a Windows `MachineGuid`).

### Extending and testing

- Pure, exported helpers carry the logic: `parseCidr`, `expandCidr`,
  `numberToIp`, `mergeHosts`, `isIpAddress`, `inferTier`, `parseProbeFacts`,
  `correlate`, `tally`, `coveragePercent`, `renderProbeCommand`. Only `discover`
  (TCP) and `probe` (SSH) do IO.
- To add a fact, extend `renderProbeCommand` and `parseProbeFacts` together.
- Run the tests with the bundled deno:
  `~/.swamp/deno/deno test --allow-env --allow-read --allow-write --allow-net --allow-run extensions/models/fleet-inventory/fleet_inventory_test.ts`.

## License

MIT — see LICENSE.txt.
