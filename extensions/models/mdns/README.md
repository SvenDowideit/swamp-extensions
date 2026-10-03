# @svendowideit/mdns

A [swamp](https://swamp-club.com) model extension that advertises and discovers
services on the local network with **mDNS** (Avahi/Zeroconf). It is the bootstrap
layer of a fleet: before DNS names resolve on a fresh or unconfigured host, mDNS
lets it find the backend — the host is then given a real DNS name and switches to
it.

## What it does

- **Advertise** — writes a systemd **user** unit that runs
  `avahi-publish-service`, `daemon-reload`s, and **starts + enables it**, keeping
  an mDNS service record alive (e.g. `_otlp-http._tcp` on port 4318 with TXT
  metadata). The `advertise` resource reports `started` and a `detail`.
- **Discover** — runs `avahi-browse` for a service type and parses the results
  into a typed `discovery` resource (name, host, address, port, TXT, **device
  class + vendor**). It classifies each service from a generic service-type map
  (esphome, shelly, ikea-dirigera, chromecast, homekit, …), extendable via the
  `deviceClasses` global arg.
- **Status / remove** — reports whether the advertisement unit exists and is
  active, and Avahi is available; `remove` stops + disables the unit and deletes
  it.

Side effects: it writes a systemd user unit under `unitDir` (default
`~/.config/systemd/user`), writes swamp resources, and (on `discover`) runs
`avahi-browse` for a bounded time. It installs no cron triggers or webhooks.

## Install

```sh
swamp extension pull @svendowideit/mdns
```

Requires `avahi-utils` (providing `avahi-publish-service` and `avahi-browse`) on
the host.

## Configuration

Global arguments are set at model creation (or `swamp model edit mdns`). All are
optional.

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `serviceName` | string | `mdns` | Unit-name **prefix** for this model's advertisements; each is `<serviceName>-<instance>.service`. |
| `serviceType` | string | `_otlp-http._tcp` | Default mDNS service type to advertise/browse. |
| `hostName` | string | `""` | Default advertised hostname; empty uses the system's own `<hostname>.local`. Only set a name that actually resolves (see [Advertised host must resolve](#advertised-host-must-resolve-or-discovery-wont-resolve)). |
| `unitDir` | string | `~/.config/systemd/user` | Directory for the generated systemd user units. |
| `advertiseArgs` | array | `[]` | Extra raw arguments appended to `avahi-publish-service`. |
| `deviceClasses` | object | `{}` | Extend/override the service-type classification map, e.g. `{"_mykvm._tcp":{"deviceClass":"kvm","vendor":"GL.iNet"}}`. |

## Examples

Create a model and advertise the OTel gateway over mDNS:

```sh
# serviceName is the unit-name prefix; hostName is left empty so avahi
# advertises the host's own <hostname>.local (only set a resolvable value).
swamp model create @svendowideit/mdns mdns \
  --global-arg serviceName=otel-mdns
swamp model method run mdns advertise \
  --input instance=otel-gateway \
  --input serviceType=_otlp-http._tcp \
  --input port=4318 \
  --input 'txt:json={"path":"/v1"}'
```

Discover what the LAN advertises (bounded browse):

```sh
# Waits up to timeoutMs for responses, then records them.
swamp model method run mdns discover \
  --input serviceType=_otlp-http._tcp \
  --input timeoutMs=5000
```

Advertise the gRPC endpoint as a **second, independent** advertisement:

```sh
# A different instance -> a different unit, so this does not replace the first.
swamp model method run mdns advertise \
  --input instance=otel-gateway-grpc \
  --input serviceType=_otel._tcp \
  --input port=4317
```

Remove just one advertisement, leaving the others running:

```sh
# Stops + disables + deletes only otel-mdns-otel-gateway-grpc.service.
swamp model method run mdns remove --input instance=otel-gateway-grpc
```

Check status and remove all advertisements when done:

```sh
# status lists every advertisement this model owns and whether each is active.
swamp model method run mdns status
# remove with no instance clears them all (use --input instance=X for one).
swamp model method run mdns remove
```

## Details

`@svendowideit/mdns` ships one model type (`@svendowideit/mdns`). Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `advertise` | `instance`, `serviceType`, `port`, `hostName`, `txt` (object) | Write **one** systemd user unit (`<globalServiceName>-<instance>.service`) that runs `avahi-publish-service`, `daemon-reload`, **start + enable** it, and record an `advertise` resource (`instance`, `unitName`, `started`, `detail`). One unit per advertisement, so instances are independent. A non-default `unitDir` is staged only (systemd cannot see it) and reported as not started. |
| `discover` | `serviceType`, `timeoutMs` | Run `avahi-browse -ptr <type>` for up to `timeoutMs`, parse the resolved records, **classify** each into a `deviceClass`/`vendor`, and record a `discovery` resource. |
| `status` | none | Record a `status` resource listing **every advertisement this model owns** (from its unit files) and whether each is active, plus Avahi availability. |
| `remove` | `instance` (optional) | Stop + disable + delete one advertisement's unit (`instance` given) or **all** of them (omitted), and refresh `status` (idempotent). |

Resources: `advertise`, `discovery`, and `status`.

### One unit per advertisement

`avahi-publish-service` registers exactly **one** DNS-SD record per process, so
each advertisement is its own systemd unit named
`<globalServiceName>-<instance>.service`. This is what makes adding and removing
advertisements independent: `advertise --input instance=X` adds/updates/restarts
only `…-X.service`, and `remove --input instance=X` stops only that one — the
others keep running. Omitting `instance` on `remove` clears all this model's
advertisements. The unit files in `unitDir` are the source of truth (what systemd
actually loads), so `status` reads them directly rather than a resource that
could drift.

### Bootstrap, not a DNS replacement

The plan is deliberately one-directional: mDNS finds the backend on the LAN, the
backend then assigns the host a real DNS name (via the provider API / Caddy), and
the host switches to it. Advertise only the core backend/gateway — not every
managed host — so discovery stays small and predictable.

### Parsing avahi-browse

`parseAvahiBrowse` understands the parseable format (`avahi-browse -ptr`):

```
=;eth0;IPv4;otel-gateway;_otlp-http._tcp;local;core.otel.fi.gy;192.0.2.10;4318;"path=/v1"
```

It keeps resolved (`=`) records, decodes `\032`-style escapes, strips the
trailing dot from hostnames, and folds the quoted TXT field into a map.

### Advertised host must resolve, or discovery won't resolve

`discover` only sees a service once `avahi-browse` can **resolve** it (`=` lines),
which needs the advertised hostname to be a real mDNS name. If you pass
`hostName` (the `-H` flag), use the machine's actual mDNS name — e.g.
`<hostname>.local` — not an arbitrary label like `otel.local` that nothing
answers for. With no `hostName`, avahi advertises the system's own
`<hostname>.local`, which always resolves.

Symptom of a bad `hostName`: `discover` returns 0 while `avahi-browse -ptr` shows
`+` (found) lines but no `=` (resolved) lines.

### Extending and testing

- Pure, exported helpers carry the logic: `renderAdvertiseArgs`,
  `renderAdvertiseUnit`, `advertisementUnitName`, `listAdvertiseUnits`,
  `parseAvahiBrowse`, `parseTxt`, `unescapeAvahi`, `validateAdvertise`,
  `shellQuote`. `advertise`/`remove`/`status` touch the filesystem and systemd;
  `discover` runs Avahi.
- To advertise a different protocol, pass its IANA service type (e.g.
  `_prometheus-http._tcp`) — no code change needed.
- Run the tests with the bundled deno:
  `~/.swamp/deno/deno test --allow-env --allow-read --allow-write --allow-run extensions/models/mdns/mdns_test.ts`.

## License

MIT — see LICENSE.txt.
