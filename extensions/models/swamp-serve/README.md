# @svendowideit/swamp-serve

Run a swamp repository as a long-lived, always-on `swamp serve` service: install
the binary, manage the systemd unit, write the serve config, reverse-proxy it
with TLS and DNS, and send its OpenTelemetry to the fleet gateway. The generic,
portable half of the `@figy/swamp-serve-bootstrap` site setup.

## What it does

A swamp repository only does useful background work if `swamp serve` is always
running — serving the dashboard, executing scheduled workflows, applying
extension hot-reload and auto-resuming runs after approvals. Standing that up by
hand means a unit file, a `serve.yaml`, a Caddy route, a DNS record, TLS, and a
telemetry environment that is easy to get subtly wrong (the classic failure is a
unit missing `SWAMP_HOME`, which makes scheduled runs fail with "Unknown model
type").

This model composes those pieces from **tested building blocks**: `swamp update`
for the verified in-place binary replacement, `@svendowideit/systemd-service` for
the unit, and `@svendowideit/caddy` for DNS, TLS and the reverse proxy. It
enables the **dashboard, hot-reload and auto-resume by default**.

The work splits into a **core** that needs nothing but swamp, and an optional
**exposure** layer that needs a working Caddy:

| Layer | Methods | Needs Caddy? |
| ----- | ------- | ------------ |
| Core — run the server | `installBinary`, `updateBinary`, `configure`, `ensureService`, `status`, `guidance`, `remove` | **No.** Works on any Linux host with systemd; reaches the dashboard on `127.0.0.1:<port>`. |
| Exposure — public hostnames | `resolve`, `ensureDns`, `ensureProxy` | **Yes.** Reads an existing `@svendowideit/caddy` model (its `baseDomain`, its A record for this host) and adds the two routes + DNS records + TLS. |
| Observability | `ensureTelemetry` | No (needs `@svendowideit/otel-settings`, not Caddy). |

So: to just **run** the server you need no Caddy setup at all. To reach it at
`swamp.<host>` / `dashboard.<host>` **with TLS**, you need a working Caddy model
first — the model reads it rather than inventing one, so those hostnames follow
the Caddy you already configured. `resolve`/`ensureDns`/`ensureProxy` fail with a
clear message if `caddyModelName` is unset, and the bundled workflow marks those
three steps `allowFailure`, so a host without Caddy still gets a running service.

Side effects: it downloads the swamp binary when absent, writes a systemd user
unit and a `.swamp/serve.yaml`, starts a user service (enabling lingering), and —
only when a Caddy model is configured — adds Caddy routes and DNS records. It
writes swamp resources; `remove` stops and deletes the unit and its routes but
leaves the swamp binary and data.

## Install

One command installs the model type and its bundled workflow; the extensions
it calls at runtime are pulled separately.

```sh
swamp extension pull @svendowideit/swamp-serve
```

## Configuration

Global arguments are set at creation or edited later with `swamp model edit`.
`caddyModelName` is required; the rest have defaults.

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `repoDir` | string | `.` | Repository the server runs (`WorkingDirectory` and `--repo-dir`). |
| `swampBinPath` | string | `~/.local/bin/swamp` | swamp binary the unit executes. |
| `installVersion` | string | `""` | Version to install when swamp is absent (empty = latest). |
| `serviceName` | string | `swamp-serve` | systemd user service name. |
| `host` | string | `127.0.0.1` | Bind address (loopback; Caddy terminates TLS). |
| `port` | integer | `9090` | Port swamp serve listens on. |
| `configPath` | string | `.swamp/serve.yaml` | Serve config file the unit is started with. |
| `dashboard` | boolean | `true` | Enable `--dashboard`. |
| `hotReload` | boolean | `true` | Enable `--hot-reload`. |
| `autoResume` | boolean | `true` | Enable `--auto-resume`. |
| `schedule` | boolean | `true` | Run scheduled workflows (`false` passes `--no-schedule`). |
| `authMode` | enum | `none` | `none` / `token` / `oauth`. `none` is loopback-only. |
| `admins` | string | `""` | Comma-separated admin principals. |
| `allowedUsers` | string | `""` | Comma-separated allowed swamp-club users. |
| `allowedCollectives` | string | `""` | Comma-separated collectives (OAuth). |
| `oauthProvider` | string | `""` | OAuth authorization server URL. |
| `trustProxy` | boolean | `true` | Trust `X-Forwarded-For` behind Caddy. |
| `trustedHosts` | array | `[]` | Host-header allowlist. |
| `swampHome` | string | `~/.swamp` | `SWAMP_HOME` pinned into the unit. |
| `swampConfigDir` | string | `~/.config/swamp` | `SWAMP_CONFIG_DIR` pinned into the unit. |
| `caddyModelName` | string | *(required)* | Caddy model whose records supply the host FQDN and IP. |
| `swampHostname` | string | *derived* | Serve hostname (empty derives `swamp.<host FQDN>`). |
| `dashboardHostname` | string | *derived* | Dashboard hostname (empty derives `dashboard.<host FQDN>`). |
| `otelSettingsModel` | string | `""` | `@svendowideit/otel-settings` model to read (empty = no telemetry). |
| `otelServiceName` | string | `swamp-serve` | `service.name`, set via both `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`. |
| `telemetryVault` | string | `""` | Vault holding the gateway OTLP bearer token. |
| `authRef` | string | `OTEL_EXPORTER_OTLP_TOKEN` | Vault key for the token. |
| `autoTrustedHosts` | boolean | `true` | Add the derived serve/dashboard hostnames to `--trusted-hosts`. |
| `trustedHosts` | string[] | `[]` | Extra `--trusted-hosts` entries (always kept). |
| `command` | string | `""` | Full override for the unit's `ExecStart` (empty = rendered). |

Method arguments: `installBinary` takes `version`/`force`; `ensureService` takes
`restart`; `ensureTelemetry` takes `endpoint`; `remove` takes `removeRoutes`.

## Examples

**Run the server first — this needs no Caddy.** Create the model, write the
config and start the unit; the dashboard is then on `127.0.0.1:9090/dashboard`,
with hot-reload and auto-resume already on:

```sh
# No caddyModelName: the core needs only swamp + systemd.
swamp model create @svendowideit/swamp-serve swamp-serve
swamp model method run swamp-serve configure
swamp model method run swamp-serve ensureService
curl -sI http://127.0.0.1:9090/dashboard            # 200 once it is up
```

**Then expose it with TLS** (optional) — point `caddyModelName` at an
`@svendowideit/caddy` model you already run, and the two hostnames are derived
from that model's own A record for this host:

```sh
# Reads my-caddy's x1yoga.fi.gy record -> swamp.x1yoga.fi.gy / dashboard.x1yoga.fi.gy.
swamp model edit swamp-serve --global-arg caddyModelName=my-caddy
swamp model method run swamp-serve resolve
swamp data get swamp-serve topology --json | jq '.content | {hostFqdn, swampHostname, dashboardHostname, hostIp}'
# Adds the DNS records and Caddy routes (TLS via the Caddy model's ACME).
swamp model method run swamp-serve ensureProxy
```

Push telemetry, then confirm everything is live (both hostnames return an HTTP
status once DNS/TLS have settled):

```sh
# Applies the OTLP environment from the otel-settings contract, then reports state.
swamp model method run swamp-serve ensureTelemetry
swamp model method run swamp-serve status
```

Run the whole sequence in one ordered pass — it creates the instance if missing
and marks the Caddy steps `allowFailure`, so a host without Caddy still gets a
running service:

```sh
swamp workflow run @svendowideit/swamp-serve-setup \
  --input caddyModelName=my-caddy
```

See every option and its current value without reading any source:

```sh
swamp model method run swamp-serve guidance
```

Update the binary in place (verified replacement) and restart the service, or
tear the service down without touching the swamp binary:

```sh
swamp model method run swamp-serve updateBinary
swamp model method run swamp-serve remove
```

## Details

`@svendowideit/swamp-serve` ships one model type (`@svendowideit/swamp-serve`)
and one workflow. Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `resolve` | none | Read the Caddy model and derive `swamp.<host FQDN>` / `dashboard.<host FQDN>` from its own A record; writes `topology`. No side effects. |
| `installBinary` | `version`, `force` | Install swamp when absent (pinned `installVersion`), else report; never overwrites an existing binary unless `force`. |
| `updateBinary` | none | Run `swamp update`, then restart the service so it execs the new build. |
| `configure` | none | Write `.swamp/serve.yaml` and validate it with `swamp serve check-config`. |
| `ensureService` | `restart` | Render the unit (command + OTLP environment) and create/restart it via `@svendowideit/systemd-service`. |
| `ensureTelemetry` | `endpoint` | Read the settings contract, apply the OTLP environment, restart. |
| `ensureDns` | none | Verify the Caddy model owns the two A records (it reconciles only its own `dnsRecords`); reports any missing. |
| `ensureProxy` | none | Reverse-proxy both hostnames to the server via `ensureDnsProxy`. |
| `status` | none | systemd state, HTTP status of both hostnames, version, telemetry summary. |
| `guidance` | none | Every option with its current value, default and update command. |
| `remove` | `removeRoutes` | Stop/remove the unit and its routes; keeps the binary and data. |

Resources: `topology`, `binary`, `serveConfig`, `unit`, `service`, `telemetry`,
`proxy`, `dns`, `status`, `guidance`.

### How the hostnames are derived

`resolve` reads the caddy model named by `caddyModelName` (through
`context.readModelData`, reading its `desired` resource) and looks through its
`dnsRecords` for an `A`/`AAAA` record under its `baseDomain`. It picks the
record whose leftmost label is this machine's hostname (else the deepest such
record), so a base domain of `fi.gy` with a record for `x1yoga.fi.gy` yields
`hostFqdn: x1yoga.fi.gy` and an IP of `10.10.13.208`. From those it computes
`swamp.x1yoga.fi.gy` and `dashboard.x1yoga.fi.gy`; an explicit
`swampHostname`/`dashboardHostname` overrides the derivation, and a label
already under the host FQDN is not double-suffixed. Because the host's identity
comes from the Caddy model, changing that model (or migrating to a real server)
changes this model's hostnames with no edit here.

### Who owns DNS and TLS

A Caddy model reconciles **only its own** `dnsRecords` and TLS subjects — a
method cannot edit another definition's persisted global arguments. So to make
the two hostnames resolve and get certificates, **the Caddy model itself must
declare them**. In the site setup (`@figy/swamp-serve-bootstrap`) that means
adding the two A records to the Caddy model's `dnsRecords` and including the two
names in its TLS `subjects` (the site does this; see that workflow). The generic
`ensureDns` and `ensureProxy` then verify and route; `ensureDns` reports exactly
which records are missing rather than silently doing nothing.

Cross-model calls use `context.runModel` and `context.readModelData` — never a
`swamp` CLI subprocess, which would reload the extensions and re-lock the
datastore (and deadlock against the caller's own lock).

### The systemd unit

The unit is rendered by `renderExecStart` and `renderUnitEnvironment` (pure,
unit-tested) and handed to `@svendowideit/systemd-service`:

```
ExecStart=<swampBinPath> serve --repo-dir <repoDir> --config <configPath>
  --host <host> --port <port> --dashboard --hot-reload --auto-resume
  --trust-proxy [--no-schedule] [--auth-mode …] [--admins …] [--trusted-hosts …]
Environment=SWAMP_HOME=… SWAMP_CONFIG_DIR=…
  OTEL_EXPORTER_OTLP_ENDPOINT=… OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  OTEL_EXPORTER_OTLP_HEADERS=… OTEL_SERVICE_NAME=… OTEL_RESOURCE_ATTRIBUTES=…
  OTEL_BSP_USE=1 OTEL_BLRP_USE=1
```

`SWAMP_HOME` and `SWAMP_CONFIG_DIR` are always pinned: without them a scheduled
run cannot resolve a pulled extension type. `OTEL_BSP_USE`/`OTEL_BLRP_USE`
switch the OTLP exporters to batching, which suits a long-running server.

### Trusted hosts (dashboard WebSockets)

Because the server is reached through Caddy, browsers open the dashboard's
WebSocket with an `Origin` of `https://dashboard.<host>` / `https://swamp.<host>`.
swamp validates that origin against `--trusted-hosts`, so without it every
upgrade is rejected (`untrusted origin`). With `autoTrustedHosts` on (the
default) `configure`/`ensureService` derive the two hostnames from the Caddy
model and add them to both `--trusted-hosts` and the `trusted-hosts` key in
`.swamp/serve.yaml`; explicit `trustedHosts` entries are always kept. It is
additive and tolerant: with no `caddyModelName`, or an unreadable model, the
render falls back to the explicit list so the service still comes up.

### Telemetry, and the stacks gap

`buildTelemetryEnv` turns the `settings` resource of the `otelSettingsModel`
into the OTLP environment: the default endpoint's `otlp_http_url`, the
`service.name`, `deployment.environment`/`site`/`owner` resource attributes, and
a bearer token read from `telemetryVault`. swamp appends `/v1/logs`,
`/v1/metrics` and `/v1/traces`, so **logs, metrics and traces all reach the
discovered gateway**.

`service.name` is written to **both** `OTEL_SERVICE_NAME` and
`OTEL_RESOURCE_ATTRIBUTES`. This is deliberate: swamp emits telemetry from two
OTel SDKs — a Node SDK that honours `OTEL_SERVICE_NAME`, and Deno's native (Rust)
SDK (instrumentation `deno::tools::bundle`, sdk `deno-opentelemetry`) used for
bundling, which reads `OTEL_RESOURCE_ATTRIBUTES` but ignores
`OTEL_SERVICE_NAME` and otherwise reports `unknown_service:deno`. Setting it in
the resource attributes names both. (To be certain which var your target honours,
push one record with each set and read the resulting `service_name`.)

**Stacks/profiles are not exported.** swamp's bundled OpenTelemetry SDK carries
logs, traces and metrics exporters only; there is no OTLP profiles exporter. The
`telemetry` resource records `stacks: "unsupported (documented gap …)"` and
`status` echoes it, so the gap is visible rather than silently assumed. Wiring a
pprof/`--inspect` sidecar is left for later; it is intentionally out of scope.

### Extending and testing

The pure helpers — `deriveHostnames`, `parseCaddyFacts`, `renderExecStart`,
`renderUnitEnvironment`, `renderServeConfig(Yaml)`, `buildTelemetryEnv`,
`describeOptions` — are exported and unit-tested, so a change to the command
line, the YAML shape or the telemetry mapping is verified without touching a
host. The methods run the swamp binary itself (`--version`, `update`) and
`systemctl` through the injectable `CommandRunner`; **cross-model calls go
through `context.runModel` / `context.readModelData`**, never a `swamp` CLI
subprocess (a subprocess reloads the extensions and re-locks the datastore, which
deadlocks against the caller's own lock).

### Container acceptance test (the full stack)

This extension ships a black-box acceptance suite (`test-factory.yaml` +
`test/bind/`) that assembles the whole stack in containers and proves it end to
end. `@svendowideit/test-factory` reads the file and stands up:

- **bind** — authoritative BIND for `example.com` (RFC2136/TSIG), so Caddy owns
  real A records.
- **openobserve** — the OTel backend, a sibling container (its distroless image
  is health-checked from the harness).
- **harness** — the swamp container (systemd user services) on two networks,
  where Caddy, the OTLP collector gateway, otel-settings and `swamp serve`
  itself all run.

The file also lists the sibling extensions this model calls by type
(`@svendowideit/caddy`, `@svendowideit/systemd-service`,
`@svendowideit/otel-settings`, `@svendowideit/otel-gateway`); test-factory
registers those local working copies so their types resolve.

Four tests build one running system and verify it:

1. **Install + DNS + TLS proxy** — Caddy (internal-CA TLS), otel-settings, the
   gateway and swamp serve install and start; the hostnames resolve via `dig`
   against BIND; and `curl --resolve` gets 200 over HTTPS through Caddy.
2. **API + dashboard reachable** — the serve API root answers 200 over HTTPS,
   and the dashboard is reverse-proxied at the dashboard hostname root
   (`rootPath=/dashboard`).
3. **CLI through serve** — a `swamp model method run … --server ws://…`
   invocation is executed by the running server and its output returned.
4. **Logs reach OpenObserve** — that command's OTLP log record is queried back
   from OpenObserve by the server's `service_name` and the command's output.

Run it on a systemd distro:

```sh
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/swamp-serve/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

It needs a local container runtime and network access to the swamp release, the
Caddy and otelcol release downloads, and the OpenObserve image. The bind assets
are in `test/bind/` (`Dockerfile.txt`, `named.conf.txt`, `db.example.com.txt`,
`tsig.key.txt`; `.txt` because swamp's `additionalFiles` allowlist only accepts
text files).

### Future work

Per the maintainer's guidance, the cross-model wiring — `ensureService` calling
`@svendowideit/systemd-service`, and `ensureDns`/`ensureProxy` calling
`@svendowideit/caddy` — should move out of the model and into the workflow as
explicit `model_method` steps, so models stay pure and the workflow owns the
orchestration (the usual swamp "workflows wire models" pattern). That rework is
tracked as a follow-up; the current in-process `runModel` calls are correct and
tested, just not the long-term shape. The Caddy side of that work also wants a
first-class `swamp.*` / `dashboard.*` route helper in `@svendowideit/caddy`
rather than the generic `rootPath` argument this release added.

```sh
~/.swamp/deno/deno check extensions/models/swamp-serve/swamp_serve.ts
~/.swamp/deno/deno test -A extensions/models/swamp-serve/swamp_serve_test.ts
swamp extension fmt extensions/models/swamp-serve/manifest.yaml --check
swamp workflow validate @svendowideit/swamp-serve-setup
```
