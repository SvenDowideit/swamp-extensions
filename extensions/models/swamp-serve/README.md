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
the Caddy you already configured. When `caddyModelName` is empty, `resolve`
auto-selects the only installed `@svendowideit/caddy` model; when several exist
it prints their names and the exact `swamp model edit … --global-arg
caddyModelName=…` command for each. When none exists it prints the
`@svendowideit/caddy-setup` command to create one. The bundled workflow marks the
Caddy steps `allowFailure`, so a host without Caddy still gets a running service,
and its final `guidance` step always spells out the next command.

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

The setup workflow is the supported entry point. It reads the `swamp-serve`
model's global arguments, so to change a setting you edit the model and re-run
the workflow — the workflow does not override your values:

```sh
# 1. See every option and the exact command that changes it.
swamp model method run swamp-serve guidance

# 2. Change one value on the real model instance.
swamp model edit swamp-serve --global-arg port=9091

# 3. Apply it (the workflow also creates the model on a first run).
swamp workflow run @svendowideit/swamp-serve-setup
```

The workflow's only input is `modelName` (default `swamp-serve`); it selects
which model instance to drive. Every setting comes from that model's global
arguments, so `--input` is never needed to change a setting.

`caddyModelName` selects the Caddy model. Leave it empty to auto-select the only
installed `@svendowideit/caddy` model, or list them and pick one:

```sh
swamp behavior list --json \
  | jq -r '.results[] | select(.type == "@svendowideit/caddy") | .name'

swamp model edit swamp-serve --global-arg caddyModelName=my-caddy
swamp workflow run @svendowideit/swamp-serve-setup
```

If there is no Caddy model yet, create and configure one, then re-run:

```sh
swamp workflow run @svendowideit/caddy-setup
swamp workflow run @svendowideit/swamp-serve-setup
```

The rest of the global arguments have defaults.

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
| `serviceHardening` | boolean | `true` | Apply systemd `PrivateTmp`/`ProtectSystem`. Set false when workflows started by the server must SSH: `PrivateTmp`'s user namespace maps root-owned SSH config files to `nobody`. |
| `authMode` | enum | `none` | `none` / `token` / `oauth`. `none` is loopback-only. |
| `admins` | string | `""` | Comma-separated admin principals. |
| `allowedUsers` | string | `""` | Comma-separated allowed swamp-club users. |
| `allowedCollectives` | string | `""` | Comma-separated collectives (OAuth). |
| `oauthProvider` | string | `""` | OAuth authorization server URL. |
| `trustProxy` | boolean | `true` | Trust `X-Forwarded-For` behind Caddy. |
| `trustedHosts` | array | `[]` | Host-header allowlist. |
| `swampHome` | string | `~/.swamp` | `SWAMP_HOME` pinned into the unit. |
| `swampConfigDir` | string | `~/.config/swamp` | `SWAMP_CONFIG_DIR` pinned into the unit. |
| `caddyModelName` | string | `""` | Caddy model whose records supply the host FQDN and IP. Empty auto-selects the only installed Caddy model; with several, guidance lists the exact choice commands. |
| `swampHostname` | string | *derived* | Serve hostname (empty derives `swamp.<host FQDN>`). |
| `dashboardHostname` | string | *derived* | Dashboard hostname (empty derives `dashboard.<host FQDN>`). |
| `otelSettingsModel` | string | `""` | `@svendowideit/otel-settings` model to read (empty = no telemetry). |
| `otelServiceName` | string | `swamp-serve` | `service.name`, set via both `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`. |
| `telemetryVault` | string | `""` | Vault holding the gateway OTLP bearer token. |
| `authRef` | string | `OTEL_EXPORTER_OTLP_TOKEN` | Vault key for the token. |
| `autoTrustedHosts` | boolean | `true` | Add the derived serve/dashboard hostnames to `--trusted-hosts`. |
| `command` | string | `""` | Full override for the unit's `ExecStart` (empty = rendered). |

Method arguments: `installBinary` takes `version`/`force`; `ensureService` takes
`restart`; `ensureTelemetry` takes `endpoint`; `remove` takes `removeRoutes`.

## Examples

**Set up the host in one command.** This is the primary instruction. It creates
the `swamp-serve` model on first run, installs the swamp binary, writes the serve
config, starts the systemd unit, adds the Caddy routes, applies telemetry, and
prints the guidance:

```sh
swamp workflow run @svendowideit/swamp-serve-setup

# Once DNS/TLS settle, both names answer. Change x1yoga.fi.gy to your own host.
curl -sI https://dashboard.x1yoga.fi.gy/dashboard
```

**Choose the Caddy model when there are several.** With one installed Caddy
model the workflow selects it automatically; with several, list them and set the
one for this host. `guidance` prints the same commands with the real names:

```sh
# Show every @svendowideit/caddy model instance in this repo.
swamp behavior list --json \
  | jq -r '.results[] | select(.type == "@svendowideit/caddy") | .name'

# Pick one; the two hostnames follow its baseDomain and A record for this host.
swamp model edit swamp-serve --global-arg caddyModelName=my-caddy
swamp workflow run @svendowideit/swamp-serve-setup
```

**Change a setting and re-apply it.** The workflow reads the model's global
arguments, so edit the model, then re-run the workflow. `guidance` prints every
option, its current and default value, and the exact edit command:

```sh
swamp model method run swamp-serve guidance
swamp model edit swamp-serve --global-arg port=9091
swamp workflow run @svendowideit/swamp-serve-setup

# The same applied value is visible in the rendered unit and status.
swamp model method run swamp-serve status
```

**Create a Caddy model first if the host has none.** The setup workflow reports
that no Caddy model exists and tells you to run this; after it creates one,
re-run the setup and the single Caddy is auto-selected:

```sh
swamp workflow run @svendowideit/caddy-setup
swamp workflow run @svendowideit/swamp-serve-setup
```

**Inspect what was resolved.** The `topology` resource records the selected
Caddy model, base domain, hostnames and IP; `status` checks the live service and
both hostnames:

```sh
swamp data query 'behavior("swamp-serve") && name == "topology"' --select content
swamp model method run swamp-serve status
```

**Advanced: run one phase directly.** These use the same persisted global
arguments as the workflow and are useful when you only want to re-apply the
config, restart, or add the proxy routes:

```sh
swamp model method run swamp-serve configure
swamp model method run swamp-serve ensureService
swamp model method run swamp-serve ensureProxy
```

**Maintain the installation.** Update the binary in place (verified replacement)
and restart the service, or tear the service down without touching the swamp
binary:

```sh
swamp model method run swamp-serve updateBinary
swamp model method run swamp-serve remove
```

## Details

`@svendowideit/swamp-serve` ships one model type (`@svendowideit/swamp-serve`)
and one workflow. Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `resolve` | none | Read the Caddy model and derive `swamp.<host FQDN>` / `dashboard.<host FQDN>` from its own A record; writes `topology`. When `caddyModelName` is empty, auto-selects the only installed Caddy, or errors with the exact choice commands. No side effects. |
| `installBinary` | `version`, `force` | Install swamp when absent (pinned `installVersion`), else report; never overwrites an existing binary unless `force`. |
| `updateBinary` | none | Run `swamp update`, then restart the service so it execs the new build. |
| `configure` | none | Write `.swamp/serve.yaml` and validate it with `swamp serve check-config`. |
| `ensureService` | `restart` | Render the unit (command + OTLP environment) and create/restart it via `@svendowideit/systemd-service`. |
| `ensureTelemetry` | `endpoint` | Read the settings contract, apply the OTLP environment, restart. |
| `ensureDns` | none | Verify the Caddy model owns the two A records (it reconciles only its own `dnsRecords`); reports any missing. |
| `ensureProxy` | none | Reverse-proxy both hostnames to the server via `ensureDnsProxy`. |
| `status` | none | systemd state, HTTP status of both hostnames, version, telemetry summary. |
| `guidance` | none | Every option with its current value, default and the exact `swamp model edit` command, plus every installed `@svendowideit/caddy` model and the exact command that selects each one. Always the last step of the setup workflow. |
| `remove` | `removeRoutes` | Stop/remove the unit and its routes; keeps the binary and data. |

Resources: `topology`, `binary`, `serveConfig`, `unit`, `service`, `telemetry`,
`proxy`, `dns`, `status`, `guidance`.

### How the hostnames are derived

`resolve` reads the caddy model named by `caddyModelName` (through
`context.readModelData`, reading its `desired` resource). When `caddyModelName`
is empty it queries the definition repository for every
`@svendowideit/caddy` model, uses the single one if there is exactly one, and
otherwise fails with a list and one exact `swamp model edit … --global-arg
caddyModelName=…` command per candidate. It then looks through the chosen
model's `dnsRecords` for an `A`/`AAAA` record under its `baseDomain`. It picks the
record whose leftmost label is this machine's hostname (else the deepest such
record), so a base domain of `fi.gy` with a record for `x1yoga.fi.gy` yields
<!-- swamp-quality-ignore ipv4-address-literals -->
`hostFqdn: x1yoga.fi.gy` and an IP of `10.10.13.208`. From those it computes
`swamp.x1yoga.fi.gy` and `dashboard.x1yoga.fi.gy`; an explicit
`swampHostname`/`dashboardHostname` overrides the derivation, and a label
already under the host FQDN is not double-suffixed. Because the host's identity
comes from the Caddy model, changing that model (or migrating to a real server)
changes this model's hostnames with no edit here.

### Who owns DNS and TLS

A Caddy model reconciles **only its own** `dnsRecords` and TLS subjects — a
method cannot edit another definition's persisted global arguments. So the
Caddy model itself owns the records and certificates. On a current
`@svendowideit/caddy`, `ensureDnsProxy` (called by `ensureProxy`) derives both
automatically: a route hostname under `baseDomain` gets a TLS subject and, when
a DNS provider is configured, an A record pointing at `routeIp` or at the IP the
Caddy already declares for the zone. Set `routeIp` on the Caddy model when this
host's address is not already one of its A records.

If the Caddy model is older, or a record is missing, the setup workflow's `dns`
step (`ensureDns`) reports the exact records it needs; add them to the Caddy
model's `dnsRecords` and run `applyDnsRecords`. In the site setup
(`@figy/swamp-serve-bootstrap`) the workflow declares the two A records and TLS
subjects explicitly for this reason.

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
