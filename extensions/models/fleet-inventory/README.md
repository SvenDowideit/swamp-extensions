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

Scan a subnet and merge feeds from discovery models:

```sh
# A host is live if any listed port accepts a connection. Accumulates across
# runs, so scanning a large range in chunks builds one inventory.
swamp model method run fleet discover \
  --input cidr=192.168.1.0/24 \
  --input 'ports:json=[22,80,443]'
```

Probe hosts over SSH for facts. Pass `hosts` to probe a specific list, or
**omit it to probe every inventoried host** (the whole discovered set):

```sh
# Probe named hosts only. Use this to (re)probe a few machines without waiting
# for a full sweep, or to probe hosts a feed supplied.
swamp model method run fleet probe \
  --input 'hosts:json=["core.otel.fi.gy","pi-01.otel.fi.gy"]' \
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
  --input 'reportingHosts:json=["core.otel.fi.gy","pi-01.otel.fi.gy"]'
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

## Details

`@svendowideit/fleet-inventory` ships one model type
(`@svendowideit/fleet-inventory`). Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `discover` | `cidr` (string), `ports` (array, default `[22,80,443]`), `feeds` (array of host objects), `timeoutMs` (integer, default 1000), `maxHosts` (integer, default 0 = whole CIDR) | Merge host feeds with an optional TCP-connect scan; write a `discovery` resource. **Accumulates** over the previous discovery, so repeated/chunked scans build one inventory. The CIDR is normalised to its network address, a timed-out connect is aborted (no fd leak), and `truncated` reports when `maxHosts` capped the sweep. |
| `probe` | `hosts` (array), `sshUser` (string), `timeoutMs` (integer, default 10000), `refresh` (boolean, default false) | SSH-probe hosts for facts and infer tiers; write a `probe` resource. **Empty `hosts` probes every inventoried host that has not already probed successfully** (from `discovery`, else the last `inventory`); pass `hosts` to probe a specific list, or `refresh=true` to re-probe all. Probes 16 at a time. Results **accumulate** across runs (`known` = cumulative probed machines; `probed`/`attempted`/`skipped` are this run's counts). Records unreachable hosts with `probed: false`. |
| `correlate` | `reportingHosts` (array) | Merge discovery + probe (probe facts win, including the `probed` flag), mark hosts absent from `reportingHosts` silent, write `inventory.json` and an `inventory` resource. With an empty `reportingHosts` it still builds the inventory but every host reads silent — supply the reporting set (a backend query, Phase 1) for real silent-host detection. |
| `report` | none | Read the `inventory` **resource** (falling back to the on-disk `inventory.json`) and write a `report` resource (total, reporting, silent, coverage %, by tier/OS). |

Resources: `discovery`, `probe`, `inventory`, and `report`.

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
