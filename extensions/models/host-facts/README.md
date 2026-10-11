# @svendowideit/host-facts

This host's own identity as swamp data: the **FQDN**, hostname, stable machine
id, OS, architecture and local addresses — read straight off the machine with no
network and no SSH.

It is the local half of "know the hosts": [`@svendowideit/fleet-inventory`](../fleet-inventory)
surveys the fleet over the network; this reports the one machine it runs on.

## What it does

One `collect` method reads the host and writes a single `host` resource:

- **FQDN first.** `hostname -f` when the machine answers with a real, dotted
  FQDN. When it only has a short name (common: `/etc/hosts` maps `127.0.1.1` to
  the short name and no FQDN is configured), pass the site `domain` to compose
  `<hostname>.<domain>` (e.g. `fi.gy` → `x1yoga.fi.gy`); with neither, the short
  name stands. The FQDN is the primary `name` and is also exposed as `fqdn`.
  Note this is the one fact that is *not* purely local: an FQDN like
  `x1yoga.fi.gy` encodes your site's domain, which the OS does not know — hence
  the `domain` global rather than a guess.
- **Identity + facts.** The short `hostname`, the stable `machineId` (Linux
  `/etc/machine-id`, macOS `IOPlatformUUID`), the `os` (`/etc/os-release` `ID`,
  or the lowercased `uname -s`), the `arch`, and every local `address`.
- **Aligned vocabulary.** Field names match
  `@svendowideit/fleet-inventory`'s host record, so a consumer reads the same
  field from either source and a machine's local view lines up with its fleet
  record.

A `status` method reports whether a `host` record already exists, without
re-reading the host.

### Why not `$HOSTNAME`?

`$HOSTNAME` is a bash convenience variable: bash sets it for interactive shells
but does **not** export it, so a workflow's child process usually doesn't see
it — and even when it does, it names the *login* host, not the host the process
runs on. That is wrong or empty under `swamp serve`, on a [swamp
worker](https://swamp.club), or in a container. `host-facts` reads the
kernel/FQDN truth, so it is correct wherever it runs.

## Install

```sh
swamp extension pull @svendowideit/host-facts
```

No dependencies. It runs only the binaries every host has (`hostname`, `uname`,
and `ioreg` on macOS) and reads local files.

## Configuration

Global arguments (set at creation with `--global-arg`, or per call with
`--input`):

| Global arg         | Default    | Description |
| ------------------ | ---------- | ----------- |
| `fqdnOverride`     | `""`       | Override the detected FQDN. Empty detects it with `hostname -f`. |
| `hostnameOverride` | `""`       | Override the detected short hostname. Empty detects it with `hostname -s`. |
| `domain`           | `""`       | Site domain to append when the host reports only a short name (e.g. `fi.gy` → `x1yoga.fi.gy`). A host that already answers with a dotted FQDN is left alone. |

Method arguments: `collect` and `status` take none.

The `host` resource fields:

| Field | Meaning |
| ----- | ------- |
| `fqdn` | Fully-qualified domain name (primary). |
| `hostname` | Short hostname, without a domain. |
| `name` | Display name — the FQDN, else the short hostname (aligns with fleet-inventory). |
| `machineId` | Stable id — Linux `/etc/machine-id`, macOS `IOPlatformUUID`. |
| `hostnames` | Every name the host answers to (FQDN, short, aliases). |
| `address`, `addresses` | Primary local address, and all of them. |
| `os` | `/etc/os-release` `ID` (e.g. `ubuntu`), or lowercased `uname -s`. |
| `arch` | Machine architecture (e.g. `x86_64`). |
| `source` | Always `"self"`. |
| `tier`, `mac`, `macs`, `deviceClass`, `vendor`, `notes`, `reporting`, `silent` | Empty/by-design defaults, present for vocabulary alignment with fleet-inventory. |
| `probed` | Always `true`. |
| `lastSeen` | When the facts were read (ISO 8601). |

## Examples

```sh
# Read this host's facts and record them. Run once per host; auto-creates the
# model instance `my-host` on first use. The `host` resource is what every
# other step then reads. `domain` turns a bare `x1yoga` into `x1yoga.fi.gy`.
swamp model @svendowideit/host-facts method run collect my-host \
  --input domain=fi.gy

# Read the FQDN back — the field a dependency tracker or telemetry tag wants.
# The record also carries hostname, machineId, os, arch and addresses.
swamp data query 'model("my-host") && name == "host"' --select content

# Report whether a host record already exists, without re-reading the host —
# use it as a gate before a redundant `collect`.
swamp model @svendowideit/host-facts method run status my-host

# Force a specific identity (a worker, a container, or a host whose FQDN does
# not resolve) without changing the machine.
swamp model @svendowideit/host-facts method run collect worker-host \
  --input fqdnOverride=worker-1.svc --input hostnameOverride=worker-1
```

## Details

`@svendowideit/host-facts` ships one model with two methods and two resources:

| Method | Reads | Writes |
| ------ | ----- | ------ |
| `collect` | `hostname -f`/`-s`/`-A`/`-I`, `uname -s`/`-m`, `/etc/os-release`, `/etc/machine-id` (or `ioreg` on macOS) | `facts` → the `host` record |
| `status` | its own latest `host` record | `status` |

The pure field mapping lives in `buildHostFacts` (from `RawFacts`), and the host
read in `detectRaw(deps)`; both are exported and unit-tested, with the commands
faked, so the tests do not depend on the machine.

### Alignment with fleet-inventory

The shared fields (`name`, `machineId`, `hostnames`, `addresses`, `os`,
`source`, `tier`, `probed`, `lastSeen`, and the empty `mac`/`macs`/`deviceClass`/
`vendor`/`notes`/`reporting`/`silent`) use the same names and shapes as
`@svendowideit/fleet-inventory`'s `InventoryHost`, so the same reader works on
either source. `host-facts` adds `fqdn`, `hostname` and `arch`. The two are
independent extensions — there is no hard dependency in either direction — but
the vocabulary is kept deliberately in step.

### Extending

- The detection is injectable via `CollectDeps` (`run`, `readFile`, `uname`), so
  a new source (e.g. a container id) is a small addition to `detectRaw` plus a
  field on `HostSchema`.
- Keep new shared fields named as fleet-inventory names them.

## License

MIT — see LICENSE.txt.
