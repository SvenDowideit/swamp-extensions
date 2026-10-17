# @svendowideit/nanokvm

A [swamp](https://swamp-club.com) model extension for the **Sipeed NanoKVM** —
an out-of-band IP-KVM (HDMI-in, USB HID, GPIO power/reset, virtual media) that
runs Sipeed's own Go server rather than PiKVM's `kvmd`.

## What it does

The NanoKVM answers a small JSON API over a self-signed HTTPS certificate. Two
firmware generations disagree on login — older builds take the password in
plaintext and return a bearer token, newer builds take an AES-encrypted password
(CryptoJS key `nanokvm-sipeed-2024`, baked into the web UI) and set a session
cookie — and this extension speaks both transparently. It wraps all of that in
one typed behavior so you can check a device, capture its screen, press its power
button, move virtual media, and forward its health into the swamp-managed
OpenTelemetry system.

Side effects: it talks to the NanoKVM over the network, talks to the OTLP
collector when `emit` is configured, writes swamp resources, and (for
`screenshot`) a JPEG file. It runs no service and installs nothing.

All HTTP is delegated to [`@svendowideit/curl`](../curl), which is built for
self-signed endpoints, keeps a persistent per-instance cookie jar (the login
session), masks secrets in its records, and stores the full request/response
exchange. This model never shells out to `curl` itself.

## Install

```sh
swamp extension pull @svendowideit/nanokvm
```

`@svendowideit/curl` is pulled automatically as a dependency.

## Configuration

Global arguments are set at model creation (`swamp model create … --global-arg
key=value`) or edited later with `swamp model edit`. Only `host` has no default.

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `host` | string | *(none)* | NanoKVM address, no scheme (e.g. `192.0.2.10`). |
| `port` | number | `443` | HTTPS port of the web server. |
| `username` | string | `admin` | Web UI user. NanoKVM ships one `admin` account. |
| `vaultName` | string | `""` | Vault holding the login password. Empty disables vault lookup. |
| `passwordRef` | string | `NANOKVM_PASSWORD` | Vault key holding the password. |
| `envRef` | string | `NANOKVM_PASSWORD` | Environment-variable fallback when `vaultName` is empty. |
| `password` | string (sensitive) | `""` | Literal password, last resort. Prefer the vault. |
| `passwordEncoding` | enum | `auto` | How login sends the password: `auto` (plaintext then AES), `plain`, or `aes`. |
| `curlModel` | string | `nanokvm-curl` | Name of the `@svendowideit/curl` instance to drive (auto-created). |
| `otelModel` | string | `otel` | `@svendowideit/otel-settings` model whose contract supplies the OTLP endpoint. |
| `otelEndpoint` | string | `""` | OTLP/HTTP base URL, overriding the contract (e.g. `http://127.0.0.1:4318`). |
| `otelMesh` | string | `""` | Contract mesh to use. Empty uses the contract's `defaultMesh`. |
| `otelVaultName` | string | `""` | Vault holding the gateway bearer token for `emit`. |
| `otelTokenRef` | string | `OTEL_EXPORTER_OTLP_TOKEN` | Vault/environment key for the token. |
| `insecure` | boolean | `true` | Skip TLS verification (the factory certificate is self-signed). |
| `timeoutMs` | number | `15000` | Per-request timeout in milliseconds. |
| `maxClockSkewSeconds` | number | `120` | Tolerated slowness before a `slow_response` finding. |

## Setup

`setup` is the entry point for a new device and implements the config
lifecycle:

1. **Persist** every value it is given — even when the configuration is
   incomplete — to the model's `config` resource.
2. **Read back** that resource on the next run and **reuse** it, so a value set
   once is not requested again.
3. **Enable progressively**: it reports `canLogin` (a host and a password are
   present) and `canEmit` (a collector contract or an explicit endpoint is
   present) and lists what is still `missing`.

```sh
swamp model @svendowideit/nanokvm method run setup nanokvm --input host=192.0.2.10
```

It does not claim success it cannot verify. `health` refuses to run without a
host, and reports a missing or rejected password as a `fail` verdict carrying
the reason, rather than a silent empty record. `emit` records
`skipped: true` and the reason when it has no collector to talk to.

## Examples

```sh
# Store the login password once, in the repo's systemd-creds vault. The secret
# never enters the model definition.
swamp vault create @svendowideit/systemd-creds nanokvm
swamp vault put nanokvm NANOKVM_PASSWORD

# Point the model at the device and record what is configured.
swamp model @svendowideit/nanokvm method run setup nanokvm --input host=192.0.2.10

# Check the device: reachability, auth, versions, LEDs, HID, media, HDMI.
# A scheduled check wants this because it always leaves a record, reachable or not.
swamp model @svendowideit/nanokvm method run health nanokvm

# Read the verdict back from swamp data.
swamp data query 'behavior("nanokvm") && name == "health"' --select content

# Grab a frame from the video stream (stored as the `screenshot` file).
swamp model @svendowideit/nanokvm method run screenshot nanokvm

# Press the power button. Mutating methods are dry runs unless apply=true.
swamp model @svendowideit/nanokvm method run power nanokvm \
  --input action=power --input apply=true

# Serve an ISO to the host (or detach it) — also a dry run without apply=true.
swamp model @svendowideit/nanokvm method run msd nanokvm \
  --input action=mount --input file=/data/ubuntu.iso --input apply=true

# Forward the latest health to the swamp-managed OTel collector. A no-op that
# records why when no contract or endpoint is configured.
swamp model @svendowideit/nanokvm method run emit nanokvm
```

## Upgrade

This extension installs nothing on the host, so an upgrade has nothing to
rebuild or reconcile. Refresh the pulled model and its bundled files with one
idempotent command:

```sh
swamp extension update
```

Model definitions record the version they were created with; the bundled
`upgrades` entry migrates them on the next method run. No swamp data is touched.

## Details

### Models and methods

`@svendowideit/nanokvm` ships one model type. Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `setup` | `host`?, `port`?, `username`?, `vaultName`?, `passwordRef`?, `envRef`?, `curlModel`?, `otelModel`? (all optional) | Persist connection settings, read them back, report enabled capabilities and what is missing. |
| `health` | none | Read-only check; writes the `health` resource with a verdict and findings. |
| `power` | `action` (`power`\|`reset`), `durationMs`?, `apply`? | Press the power or reset button over GPIO. Dry run unless `apply`. |
| `msd` | `action` (`status`\|`mount`\|`umount`), `file`?, `cdrom`?, `apply`? | Inspect, mount or detach virtual media. `status` is read-only; changes need `apply`. |
| `screenshot` | `timeoutMs`?, `label`? | Read the MJPEG stream briefly and store the first complete JPEG frame. |
| `emit` | `health`?, `endpoint`?, `mesh`? | Push the latest health to OTLP (log + gauges). No-op when unconfigured. |
| `devices` | `zone`? | List every NanoKVM swamp looks after (repo scan) with each device's DNS name and an A-record list. |

### Resources and files

| Spec | Kind | Lifetime | Contents |
| ---- | ---- | -------- | -------- |
| `config` | resource | infinite | Persisted connection settings and capability flags. |
| `health` | resource | 30d | One health check: signals, verdict, findings. |
| `power` | resource | 30d | A power/reset press (or dry run) and its outcome. |
| `msd` | resource | 30d | A virtual-media mount/unmount/status. |
| `screenshotMeta` | resource | 7d | Metadata for a captured frame. |
| `emit` | resource | 30d | One OTLP push, or why it was skipped. |
| `devices` | resource | 30d | Every NanoKVM discovered in the repo, with DNS names and an A-record list. |
| `screenshot` | file | 7d | The captured JPEG frame. |

### Reports

The extension ships `@svendowideit/nanokvm-health-report` (workflow scope). After
a workflow that ran one or more Nanokvm health checks it renders a fleet table —
per-device verdict, app version, response time, mounted media — plus the
non-info findings and an OTLP emit summary, as Markdown and JSON. It reads only
swamp data, so it is safe to run on a schedule.

```sh
# A workflow that requires it makes the report available under --workflow.
swamp report get @svendowideit/nanokvm-health-report --workflow <workflow> --markdown
```

### How it talks to the device

Every request is a `@svendowideit/curl` `request` method call on the
`curlModel` instance, via `context.runModel`. `health` does one `POST
/api/auth/login` and then the reads it needs: `/api/vm/info`,
`/api/vm/hardware`, `/api/vm/gpio`, `/api/hid/mode`,
`/api/storage/image/mounted`, `/api/vm/hdmi` and `/api/application/version`.
`/api/vm/hdmi` answers `404` on firmware that has no HDMI-state endpoint
(recorded as `hdmi_unsupported`, not a failure).

Login is firmware-agnostic. Two generations of NanoKVM disagree:

- **older firmware** takes the password in **plaintext** and returns a
  **bearer token** in the login response body (no session cookie); and
- **current firmware** takes the web UI's **AES-encrypted** password and sets a
  **session cookie**.

`passwordEncoding` (default `auto`) tries plaintext first, then AES; the winner
is recorded in the `health` resource as `authEncoding`. After login, the session
cookie stays in the curl instance's jar and, when the device returns a token,
every subsequent request also carries `Authorization: Bearer <token>` — so both
generations authenticate. Pin `plain` or `aes` to send exactly one attempt.

### Discovering devices

`devices` lists every NanoKVM swamp looks after without touching the network. It
walks the repo for `@svendowideit/nanokvm` model definitions (under `models/`,
ignoring `.swamp/` scratch instances) and records each one's instance name,
`host`/`port`, and DNS name — `<name>.<zone>` when `zone` is given, otherwise the
bare name. It also emits an `aRecords` list in the shape a DNS reconciler wants
(`{name, type:"A", value:[host], zone}`), so a site workflow can publish them
without any CEL mapping. Adding a device is just adding a model definition; the
next `devices` run picks it up.

```sh
# nanokvm (host 192.0.2.10) -> nanokvm.fi.gy, as an A record for fi.gy.
swamp model @svendowideit/nanokvm method run devices nanokvm --input zone=fi.gy
swamp data query 'behavior("nanokvm") && name == "devices"' --select content \
  | jq '.aRecords'
```

### Extending and testing

- Pure logic is exported and unit-tested: `encryptPassword`, `parseEnvelope`,
  `sessionToken`, `loginEncodings`, `classifyHealth`, `pickEndpoint`,
  `dnsNameFor`, `deviceFromDefinition`, `buildOtlpLogs`, `buildOtlpMetrics`,
  `extractJpeg`, `jpegSize`, `baseUrl`, `sanitizeLabel`. Add a health signal by
  extending `HealthSample`/`classifyHealth`, a new OTLP attribute in
  `telemetryResource`, a new auth shape in `loginAttempt`/`sessionToken`, and a
  new discovered field in `deviceFromDefinition`/`discoverNanokvmDevices`.
- The device I/O is isolated in `curlCall`/`ensureSession`/`getJson`; keep it
  that way so the rest stays pure.
- Run the tests with the bundled deno:

```sh
~/.swamp/deno/deno test -A extensions/models/nanokvm/nanokvm_test.ts
~/.swamp/deno/deno check extensions/models/nanokvm/nanokvm.ts
```

## License

MIT — see LICENSE.txt.
