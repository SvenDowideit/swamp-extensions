# @svendowideit/otel-gateway

The central OpenTelemetry Collector gateway for a swamp-managed fleet: a single
OTLP endpoint (gRPC + HTTP) that every agent pushes to, fanning out to one or
more backend stores.

## What it does

A gateway decouples *telemetry producers* from *the backend*. Hosts and apps are
configured once to send OTLP to the gateway; the gateway exports to whatever
store you chose. That makes the backend swappable — a migration is a gateway
config change, not a fleet-wide re-instrumentation — and it lets you dual-write
to two backends during a transition.

This extension renders an [`otelcol-contrib`](https://github.com/open-telemetry/opentelemetry-collector-releases)
config from structured inputs, installs the checksum-verified release binary,
writes a `0600` environment file from vault-sourced credentials, and runs it as
a systemd user service with a health check.

- **Receivers:** OTLP gRPC (`4317`) and HTTP (`4318`), bound to `bindAddress`.
- **Exporters:** one or more OTLP/HTTP backend lanes; every enabled exporter is
  fanned into each signal pipeline it carries. Run two to dual-write.
- **Processors:** `memory_limiter`, `batch`, and an optional
  `probabilistic_sampler` for traces.
- **Credentials:** header values can reference `${env:NAME}`; the value is read
  from a swamp vault and written to the env file, so secrets never appear in the
  rendered config.
- **Verification:** the `health_check` extension is polled after start, so
  `install` reports whether the gateway actually came up.

## Install

```sh
swamp extension pull @svendowideit/otel-gateway
```

## Configuration

Global arguments set at creation:

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `version` | string | `""` | `otelcol-contrib` version (empty = latest release). |
| `installDir` | string | `~/.local/share/otel-gateway` | Where the binary, config, and env file live. |
| `binaryPath` | string | `""` | Override the binary path (default `<installDir>/otelcol-contrib`). |
| `configPath` | string | `""` | Override the config path (default `<installDir>/config.yaml`). |
| `serviceName` | string | `otel-gateway` | systemd user service name. |
| `grpcPort` | integer | `4317` | OTLP/gRPC receiver port. |
| `httpPort` | integer | `4318` | OTLP/HTTP receiver port. |
| `healthPort` | integer | `13133` | `health_check` extension port. |
| `metricsPort` | integer | `8888` | The collector's own prometheus metrics port. |
| `bindAddress` | string | `127.0.0.1` | Address the receivers bind to. Set a mesh/LAN address to accept the fleet. |
| `exporters` | array | `[]` | Backend lanes (see below). |
| `vaultName` | string | `""` | Vault holding values for any header that names a `valueEnv`. |
| `environmentFile` | string | `""` | Env file path (default `<installDir>/gateway.env`, mode `0600`). |
| `samplingHeadPercent` | number | `100` | Head sampling for traces (100 = off). |
| `memoryLimitMiB` | integer | `512` | Soft memory limit (`GOMEMLIMIT`). |
| `agentServiceName` | string | `otel-agent` | Co-located agent unit; a gateway host runs no agent. |
| `removeAgent` | boolean | `true` | Stop+remove a co-located agent on install/configure. |
| `githubToken` | string | `""` | GitHub token to raise the release API rate limit. |
| `healthTimeoutMs` | integer | `30000` | How long to wait for health after start. |

Each `exporters` entry:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | required | Exporter/stream name (e.g. `openobserve`). |
| `endpoint` | string | required | OTLP/HTTP base endpoint, **no trailing slash** (the collector appends `/v1/{logs,metrics,traces}`). |
| `headers` | array | `[]` | `{name, value}` or `{name, valueEnv}` (value from the vault). |
| `basicAuth` | object | unset | `{emailEnv, authEnv}` — build a Basic `Authorization` header from two vault keys. |
| `insecure` | boolean | `false` | Skip TLS for the exporter. |
| `signals` | array | `[logs, metrics, traces]` | Which signals this exporter carries. |
| `enabled` | boolean | `true` | Set false to keep it configured but out of the pipelines. |

## Examples

Create a gateway that exports to a local OpenObserve, reading the OpenObserve
auth header from a vault (`OO_AUTH`), and expose it on the LAN for the fleet:

```sh
swamp model create @svendowideit/otel-gateway otel-gateway \
  --global-arg vaultName=otel-openobserve-admin \
  --global-arg bindAddress=0.0.0.0 \
  --global-arg 'exporters=[{"name":"openobserve","endpoint":"http://127.0.0.1:5080/api/default","headers":[{"name":"Authorization","valueEnv":"OO_AUTH"},{"name":"stream-name","value":"default"}]}]'
```

Install it, then check it is healthy and see the endpoint agents should use — run
this after any change to confirm the service came back:

```sh
swamp model method run otel-gateway install
swamp model method run otel-gateway status
swamp data get otel-gateway status --json | jq '.content.endpoints, .content.exporters'
```

Add a second, disabled-until-ready exporter for a dual-write migration — enable
it when you are ready to compare the two lanes, with no agent changes:

```sh
swamp model edit otel-gateway \
  --global-arg 'exporters=[{"name":"openobserve","endpoint":"http://127.0.0.1:5080/api/default","headers":[{"name":"Authorization","valueEnv":"OO_AUTH"}]},{"name":"lgtm","endpoint":"http://127.0.0.1:4417/api","enabled":false}]'
swamp model method run otel-gateway configure
```

Push a synthetic record through the gateway to prove the receive path works —
run this after a config change, or to check the collector before pointing a
fleet at it. Then confirm it landed with `@svendowideit/openobserve`'s `query`:

```sh
swamp model method run otel-gateway verify --input marker=smoke
swamp data get otel-gateway verify --json | jq '.content | {marker, pushed, pushStatusCode}'
```

## Details

- **Model type:** `@svendowideit/otel-gateway` (a single model, `otel_gateway.ts`).
- **Methods:** `install`, `configure`, `status`, `remove`.
- **Resources:** `install`, `status`, `remove`.
- **Checks:** `sane-config` rejects an invalid service name, an empty enabled
  exporter set, duplicate exporter names, and a trailing slash on an endpoint
  before any work happens.
- **Release fetching:** resolves the latest `otelcol-contrib` release (or a
  pinned `version`), selects `otelcol-contrib_<v>_linux_<arch>.tar.gz` by host
  arch, verifies its SHA-256 from the release `checksums.txt`, extracts the
  binary, and `chmod 0755`s it. It reuses an already-installed binary whose
  `--version` matches.
- **Config:** `renderGatewayConfig` is a pure function (unit-tested) that emits
  `receivers` → `processors` → `exporters` → `extensions` → `service.pipelines`.
  Telemetry self-metrics address matches the `prometheus` exporter.
- **Secrets:** a header with `valueEnv` is read from `vaultName` via the model's
  vault service and written to `gateway.env` (mode `0600`, systemd-quoted); the
  config only ever contains `${env:NAME}`. An exporter with `basicAuth` builds a
  Basic header from two vault keys (`emailEnv` + `authEnv`), so the gateway
  can share the backend vault (`ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD`)
  without a pre-encoded header secret.
- **Service:** a systemd user unit with `EnvironmentFile=-…`, `Restart=on-failure`,
  and `WantedBy=default.target`; `install`/`configure` enable lingering and
  restart it, then poll `health_check`.
- **No co-located agent:** a gateway host must not also run an `otel-agent` —
  both bind the standard OTLP ports (`4317`/`4318`) and the metrics port
  (`8888`), so the second to start crash-loops with `address already in use`.
  `install`/`configure` detect an agent on the host (its unit file, or an active
  unit) and stop and remove it (`agentServiceName`, `removeAgent`), recording
  `agentRemoved` on the `install` resource. This makes promoting a host to be
  the gateway/backend self-correcting. The reverse rule lives in
  `@svendowideit/otel-agent`, whose `install` refuses a host that runs a gateway.
- **Platforms:** Linux (systemd user services, `uname`/`tar`).
- **Publishing:** generic — no site-specific values — so it lives in
  `@svendowideit`. The concrete exporters for a given setup (the site's backend
  URL and vault) belong in a `@figy` model/workflow.

### Development

```sh
~/.swamp/deno/deno check extensions/models/otel-gateway/otel_gateway.ts
~/.swamp/deno/deno test  extensions/models/otel-gateway/otel_gateway_test.ts
swamp extension fmt extensions/models/otel-gateway/manifest.yaml --check
swamp extension quality extensions/models/otel-gateway/manifest.yaml --json
```
