# @svendowideit/esphome

Know what ESPHome boards you have, what firmware they run, and what each one
can actually do — including the ones that hide from mDNS.

## What it does

Answers three questions from every channel a device offers:

1. **What do I have?** — version, platform, board, MAC, `config_hash`,
   `api_encryption`, addresses.
2. **What can it do?** — the full sensor/actuator catalogue, read from the
   device's own `web_server` event stream, with domain, unit and effects.
3. **What needs work?** — firmware spread, boards in use, devices that cannot be
   read at all, devices running an unencrypted native API.

No single discovery channel sees every device. Measured on a real /20:

| Source | Devices found |
| ------ | ------------- |
| mDNS `_esphomelib._tcp` | 8 |
| TCP sweep of port 6053 | 8 |
| **either one alone** | **8 — but they differ** |
| union of both | **10** |

mDNS found 2 devices the sweep missed; the sweep found 2 that mDNS never showed
(their `mdns:` component is removed). The extension unions mDNS TXT, a TCP sweep
of the API and web_server ports, and the ARP table.

## Install

```sh
swamp extension pull @svendowideit/esphome
```

## Identity is the MAC address

Devices take DHCP leases and get renamed, so neither an address nor a name is
stable. Merging is keyed on the MAC:

```sh
swamp behavior run @svendowideit/esphome sync esphome
```

Running this after a device moves or is renamed updates the existing entry
rather than adding a duplicate — that is the whole point of the MAC key, and
`esphome_test.ts` asserts it.

## Configuration

Global arguments:

| Argument | Default | Purpose |
| -------- | ------- | ------- |
<!-- swamp-quality-ignore ipv4-address-literals -->
| `scanCidr` | `10.10.0.0/20` | CIDR to sweep. Empty disables the sweep and relies on mDNS only. |
| `apiPorts` | `[6053]` | Ports that prove an ESPHome API listener. |
| `webPorts` | `[80]` | Ports to try for `web_server`. |
| `scanTimeoutMs` | `400` | Per-connection sweep timeout. **Too low silently under-reports WiFi devices.** |
| `scanConcurrency` | `128` | Parallel sweep connections. |
| `mdnsPasses` | `3` | Browse passes to union — one pass is lossy. |
| `interrogateTimeoutMs` | `3000` | How long to read a device's event stream. |
| `outputDir` | `~/.local/share/esphome` | Where the page is written. |
| `pageTitle` | `ESPHome fleet` | Page heading. |
| `pageHostname` | `esphome.x1yoga.fi.gy` | Hostname the page is served at. |
| `caddyModelName` | `""` | Source caddy model; empty auto-discovers the one owning this machine. |
| `caddyServeModel` | `esphome-caddy` | Dedicated caddy model carrying the route. |

## Examples

```sh
# Everything in one model-lock run: discover, interrogate, render.
# Prefer this over the individual methods, which contend on the model lock.
swamp behavior run @svendowideit/esphome sync esphome

# Discovery only — a cheap way to see whether new nodes appeared, and how
# many of them mDNS cannot see.
swamp behavior run @svendowideit/esphome discover esphome

# The hourly workflow: refresh the inventory, then idempotently declare the
# Caddy route. Its first run is also the setup path.
swamp workflow run @svendowideit/esphome-hourly

# Re-render the page without re-reading every device.
swamp behavior run @svendowideit/esphome render esphome

# Read the fleet directly: which boards, which firmware versions.
swamp data query 'modelName == "esphome" && name == "current"' --select content
```

## Details

One model type, `@svendowideit/esphome`.

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `discover` | — | mDNS (repeated passes), TCP sweep, ARP; merges by MAC; writes `summary`. |
| `interrogate` | `macs`, `timeoutMs` | Reads each `web_server` `/events` stream for the entity catalogue. |
| `sync` | — | `discover` + `interrogate` + `render` in one lock. |
| `render` | — | Rebuilds the HTML page from the stored `summary`. |
| `ensure-caddy-serve` | `model`, `hostname`, `serveRoot`, `serveModel` | Idempotently declares the Caddy `file_server` route. |

Resources: `summary` (the fleet, keyed by MAC), `device`, and `caddyServe`.

Workflow: `@svendowideit/esphome-hourly`, schedule `0 * * * *`, steps
`sync` → `ensure-caddy-serve`.

### Why the page says "board unknown"

The board comes from the mDNS TXT record `board=`. A device with `mdns:` removed
publishes nothing, `web_server` never carries a board, and the native API's
plaintext hello carries only name and MAC. So for those devices the compile
target is genuinely unknown. The page reports that rather than guessing; the fix
is the deferred Noise handshake needed to read `DeviceInfo`.

### Entity catalogue: first event wins

A `web_server` `/events` stream sends the **full** entity record on the first
`state` event for an id and only **deltas** afterwards:

```
event: state
data: {"id":"light/NeoPixel Light","domain":"light","name":"NeoPixel Light",
       "effects":["None","Color Wipe","Scan","Rainbow","Fireworks"], ...}

event: state
data: {"id":"light/NeoPixel Light","value":"OFF","state":"OFF"}
```

Overwriting per event would erase the catalogue and leave only the last value.
`applySseEvents` writes catalogue fields once and merges the rest.

### Serving

The page is written under `outputDir` and served by Caddy's existing
`file_server` route, declared through `@svendowideit/caddy`'s normal additive
reconcile — a dedicated `<caddyServeModel>` carrying only `baseDomain` and
`serviceName`, then `serveSettings`. Caddy derives the A record and TLS subject
from the route, so `esphome.x1yoga.fi.gy` needs no hand-written DNS entry or
Caddyfile edit. Nothing here starts a second web server.

## Tests

```sh
~/.swamp/deno/deno test --allow-all extensions/models/esphome/
```

