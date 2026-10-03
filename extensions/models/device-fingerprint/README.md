# @svendowideit/device-fingerprint

A [swamp](https://swamp-club.com) extension that identifies the devices on a
network — router, KVM, ESPHome sensor, media box — from evidence, without
credentials. It is the "what is this host?" layer that turns an inventory of
anonymous IP addresses into named device classes.

## What it does

It ships **two models**, each a different, independent signal:

- **`@svendowideit/device-fingerprint/http`** — probes hosts over HTTP(S) and
  classifies them from the response `Server` header, the HTML `<title>`, and the
  TLS certificate subject/issuer. It fetches through `openssl`, so **self-signed
  appliance certs** (KVMs, routers) are readable rather than refused. Catches
  UniFi (`CN=unifi.local`), NanoKVM (`<title>NanoKVM</title>`), GL.iNet, and
  anything else that answers HTTP.
- **`@svendowideit/device-fingerprint/mac`** — resolves MAC addresses to their
  registered vendor (OUI) and a coarse device class, using the system IEEE OUI
  database. Works even when a device is offline or answers nothing, since a MAC
  is usually visible in ARP/DHCP.

Both are generic and public. Site-specific device knowledge is added through the
`deviceClasses` override, not hard-coded. It pairs with `@svendowideit/mdns`,
which classifies the mDNS services it discovers (ESPHome, Shelly, IKEA, Cast,
HomeKit, …).

A MAC/OUI vendor is a **hint, not identity** (virtualised MACs, randomised Wi-Fi
MACs, and USB Ethernet adapters that move between hosts). Use it to classify, not
to key a host — the fleet-inventory extension keys identity on machine-id /
hostname.

## Install

```sh
swamp extension pull @svendowideit/device-fingerprint
```

Requires `openssl` on PATH (for TLS certs). The MAC model needs an OUI database:
the Debian `ieee-data` package (`/usr/share/ieee-data/oui.txt`) or nmap's
`/usr/share/nmap/nmap-mac-prefixes`.

## Configuration

The **http** model's global arguments:

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `timeoutMs` | integer | `4000` | Per-connection / per-request timeout. |
| `ports` | array | `[443, 80]` | Ports to try per host, in order (https first, then http). |
| `userAgent` | string | `swamp-device-fingerprint/1.0` | User-Agent sent with requests. |
| `deviceClasses` | object | `{}` | Extend/override rules keyed on the `Server` banner (case-insensitive substring), e.g. `{"mikrotik":{"deviceClass":"router","vendor":"MikroTik"}}`. |

The **mac** model's global arguments:

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `ouiFile` | string | `/usr/share/ieee-data/oui.txt` | Path to the IEEE OUI database (falls back to nmap's prefixes). |
| `deviceClasses` | object | `{}` | Extend/override rules keyed on the OUI vendor name (case-insensitive substring), e.g. `{"tp-link":{"deviceClass":"kvm","vendor":"GL.iNet"}}`. |

## Examples

HTTP/TLS fingerprint a few hosts and see the classes:

```sh
# Create a model, then classify hosts. Self-signed certs are read via openssl.
swamp model create @svendowideit/device-fingerprint/http hosts
swamp model method run hosts fingerprint \
  --input 'hosts:json=["10.10.10.1","10.10.12.230"]'
swamp data get hosts fingerprint --json | jq '.content.hosts[] | {host, deviceClass, vendor}'
```

MAC/OUI fingerprint (works for offline devices, from ARP/DHCP MACs):

```sh
# Resolve MACs to vendors and coarse classes.
swamp model create @svendowideit/device-fingerprint/mac macs
swamp model method run macs lookup \
  --input 'macs:json=["d8:44:89:ab:7e:32","20:f8:3b:09:58:1f"]'
```

Add site-specific knowledge without changing code:

```sh
# A rule keyed on the Server banner (http) or vendor (mac).
swamp model method run hosts fingerprint \
  --input 'hosts:json=["10.10.10.50"]'
swamp model edit hosts --global-arg \
  'deviceClasses:json={"mikrotik":{"deviceClass":"router","vendor":"MikroTik"}}'
```

Pair with `@svendowideit/mdns` for the mDNS signal:

```sh
# mDNS discovery already classifies service types (esphome, shelly, ...).
swamp model method run mdns discover --input serviceType=_esphomelib._tcp
swamp data get mdns discovery --json | jq '.content.services[] | {serviceName, deviceClass, vendor}'
```

## Details

The extension ships two model types.

### `@svendowideit/device-fingerprint/http`

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `fingerprint` | `hosts` (array of hostnames/IPs) | For each host, TCP-checks each port, fetches HTTP(S) (through `openssl` for TLS, tolerating self-signed certs), reads `Server`, `<title>`, and cert subject/issuer, classifies the device, and writes a `fingerprint` resource. |

Output: `{ hosts: [{ host, fingerprints: [{ deviceClass, vendor, server, title, certSubject, certIssuer, port, url, reachable, detail }], deviceClass, vendor }], total, identified, fingerprintedAt }`.

Classification order (see `classifyHttp`): caller `deviceClasses` overrides →
TLS cert → `Server` header → HTML `<title>`. Generic classes include `unifi`,
`nanokvm`, `glinet`, `openwrt`, `router`, `shelly`, `web-server`, `http-device`.
Pure helpers: `parseHeader`, `parseStatus`, `extractTitle`, `parseCert`,
`classifyHttp`.

### `@svendowideit/device-fingerprint/mac`

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `lookup` | `macs` (array of MAC addresses, any separator style) | Normalises each MAC, looks up its 24-bit OUI in the system database, classifies the vendor, and writes a `lookup` resource. |

Output: `{ results: [{ mac, oui, vendor, deviceClass }], total, vendors, resolvedAt }`.

Generic vendor→class rules (see `classifyVendor`): `esphome` (Espressif),
`shelly` (Allterco), `sbc` (Raspberry Pi), `nanokvm` (Sipeed), `unifi`
(Ubiquiti), `network-device` (TP-Link), `google`, `apple`, `amazon`, `computer`.
Pure helpers: `normaliseMac`, `ouiPrefix`, `ouiKey`, `parseOui`,
`parseNmapPrefixes`, `classifyVendor`.

### Caveats

- The system OUI database may be **stale** and lack recent prefixes (some
  Espressif OUIs, for example); keep `ieee-data` updated, or pass a newer
  `ouiFile`. An unresolved MAC returns empty `vendor`/`deviceClass`, not an error.
- HTTP/TLS probing opens a connection to each host; classification is best-effort
  (an appliance that speaks a non-HTTP protocol yields an empty fingerprint but
  is reported as reachable).
- MAC/OUI does not prove identity (see the note above).

### Extending and testing

- Add a device class by extending the maps in `classifyHttp` / `classifyVendor`,
  or at runtime via the `deviceClasses` global arg. Keep them generic; put
  site-specific device knowledge in a `@figy` extension.
- Run the tests with the bundled deno:
  `~/.swamp/deno/deno test --allow-all extensions/models/device-fingerprint/`.

## License

MIT — see LICENSE.txt.
