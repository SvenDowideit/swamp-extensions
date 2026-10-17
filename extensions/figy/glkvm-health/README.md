# @figy/glkvm-health

fi.gy's site-specific, scheduled GL.iNet KVM health pipeline: check the
out-of-band KVM on the LAN, forward its verdict to the swamp-managed
OpenTelemetry collector, and require each run to leave a health record.

## What it does

`@sntxrr/glinet-kvm` can *check* a GL.iNet KVM (Comet GL-RM1 / GL-RM1PE) — a
read-only `health` method that returns a verdict and findings — but it has no way
to *report* that verdict anywhere. This extension supplies the reporting half.

It adds an `emit` method (and an `emit` resource) to the `@sntxrr/glinet-kvm`
type via `export const extension`, exactly mirroring the `emit` that
`@svendowideit/nanokvm` ships for the Sipeed device, plus one scheduled workflow:

1. every 15 minutes (`trigger.schedule`), run the `health` method against the KVM
   (the password is read from the `glkvm` vault by a `vault.get` expression on the
   `check` step), producing an `ok`/`warn`/`fail` verdict with findings;
2. run the added `emit` method, which posts the latest verdict to the local OTLP
   receiver (`http://127.0.0.1:4318`) as one log record plus gauges
   (`glkvm.up`, `glkvm.health`, `glkvm.update_available`, `glkvm.hid_online`,
   `glkvm.hdmi_signal`, `glkvm.virtual_media_mounted`,
   `glkvm.two_factor_enabled`);
3. assert that the `health` step produced a record.

A device that is off or unreachable is **not** a workflow failure — `health`
records a `fail` verdict, and `emit` forwards it like any other sample, so a
flapping device leaves a trail rather than a gap.

The extension ships a **second workflow**, `@figy/glkvm-dns`, that publishes the
KVM's address. It reconciles an A record (`glkvm.fi.gy` → the KVM) declared on a
dedicated `@svendowideit/caddy` model into the shared Caddy, using the caddy
**mixin** so the record merges with the Caddy's other models rather than needing
a Caddy of its own. The record is declared once on a repo model
(`glkvm-caddy`); the workflow runs `configureTls` then `applyDnsRecords`. See
[Configuration](#configuration) and [Details](#details).

Side effects: it drives the extended model and the caddy model (network calls to
the KVM and the collector, one DNS reconcile) and writes swamp data. It installs
nothing on the host.

## Install

```sh
swamp extension pull @figy/glkvm-health
```

## Configuration

Global arguments belong to the `@sntxrr/glinet-kvm` model the extension augments;
the workflow sets them on its `check` step. Every workflow input can be overridden
per run with `--input key=value`. The defaults are the fi.gy values.

| Argument / input | Type | Default | Meaning |
| ---------------- | ---- | ------- | ------- |
| `device` | string | `glkvm` | Name of the `@sntxrr/glinet-kvm` model instance to drive. |
| `host` | string | `10.10.6.150` | KVM address (no scheme); maps to the model's `host` global arg. |
| `port` | integer | `443` | HTTPS port of the KVM web server. |
| `username` | string | `admin` | KVM web UI user. |
| `vaultName` | string | `glkvm` | Vault holding the KVM login password. |
| `passwordRef` | string | `GLKVM_PASSWORD` | Vault key holding the login password. |
| `timeoutMs` | integer | `10000` | Per-request timeout for the KVM and the OTLP push. |
| `otelModel` | string | `otel` | `@svendowideit/otel-settings` model supplying the OTLP contract. |
| `otelEndpoint` | string | `http://127.0.0.1:4318` | OTLP/HTTP base URL (empty = use the contract). |
| `otelMesh` | string | `tailscale` | Contract mesh to prefer when `otelEndpoint` is empty. |
| `otelVaultName` | string | `""` | Vault holding the OTLP bearer token (empty = none). |
| `otelTokenRef` | string | `OTEL_EXPORTER_OTLP_TOKEN` | Vault/env key for the token. |

The KVM password is not a workflow input value: the `check` step computes it from
the vault with `${{ vault.get(inputs.vaultName, inputs.passwordRef) }}`, so no
secret is written into the workflow file.

The schedule is read-only inside an extension. Change it from the host:

```sh
# Read the current trigger, change the cadence, or remove it.
swamp workflow trigger get @figy/glkvm-health
swamp workflow trigger set @figy/glkvm-health --schedule "*/5 * * * *"
swamp workflow trigger remove @figy/glkvm-health
```

### The caddy model (`glkvm-caddy`)

`@figy/glkvm-dns` drives a `@svendowideit/caddy` model named `glkvm-caddy` whose
**only** desired state is the KVM's A record, plus the settings every model
sharing one Caddy must agree on. It must be a **repo model** (under `models/`):
the caddy extension's mixin merges models by `(target, serviceName)`, but treats
workflow/auto-created definitions as scratch and excludes them, so a model swamp
auto-creates from a workflow reference would not merge with `my-caddy` (which
already owns the `fi.gy` Caddy). Create it once with `swamp model create`:

```sh
swamp model create @svendowideit/caddy glkvm-caddy \
  --global-arg baseDomain=fi.gy \
  --global-arg letsEncryptEmail=SvenDowideit@home.org.au \
  --global-arg environmentFile=$HOME/.config/caddy/dns.env \
  --global-arg 'plugins:json=["github.com/caddy-dns/gandi"]' \
  --global-arg 'dnsRecords:json=[{"name":"glkvm.fi.gy","type":"A","value":["10.10.6.150"],"zone":"fi.gy"}]'
```

It shares `my-caddy`'s `serviceName` (`caddy`, the default) and `target` (this
machine, the default), so the two merge. Its `dnsRecords` value is the KVM's
address; change it and re-run the workflow when the KVM moves. `baseDomain`,
`letsEncryptEmail`, `environmentFile` and `plugins` mirror `my-caddy` because
`autoHttps` and the TLS email/provider must match across every model sharing the
Caddy — the mixin errors on a contradiction. `configureTls` infers the Gandi
provider (and its `bearer_token` field) from the `plugins` and `environmentFile`
globals; it is given **no TLS subjects**, so the Caddy issues no certificate for
a name that points at the KVM (the KVM presents its own self-signed cert).

After changing the model, reconcile it into the shared Caddy:

```sh
# configureTls then applyDnsRecords — merges this record with my-caddy's.
swamp workflow run @figy/glkvm-dns
```

## Examples

```sh
# Create (or let the workflow auto-create) the KVM model with the device address.
swamp model create @sntxrr/glinet-kvm glkvm --global-arg host=10.10.6.150 \
  --global-arg 'password=${{ vault.get("glkvm", "GLKVM_PASSWORD") }}'

# Run the whole pipeline once, now, instead of waiting for the trigger.
swamp workflow run @figy/glkvm-health

# Check a different GL.iNet KVM on the same LAN.
swamp workflow run @figy/glkvm-health --input host=10.10.6.151

# Confirm the last emit reached the collector, and what it sent.
swamp data query 'behavior("glkvm") && name == "emit"' --select content

# Read the latest verdict and findings the check left behind.
swamp data query 'behavior("glkvm") && name == "health"' --select content

# Publish the KVM's address: reconcile glkvm.fi.gy into the shared Caddy.
swamp workflow run @figy/glkvm-dns

# Confirm the A record was reconciled (provider, changed, records).
swamp data get glkvm-caddy current --json | jq '.content | {provider, changed, records}'
```

## Upgrade

This extension installs nothing on the host, so an upgrade has nothing to rebuild
or reconcile. Refresh the pulled copy with one idempotent command:

```sh
# Pull the newest published copy of the extension (and the model it extends).
swamp extension update
```

The `@sntxrr/glinet-kvm` model it augments is upgraded by that extension's own
`upgrades` entry on the next method run, so the added `emit` method follows it
automatically.

## Details

### The extension model

`@figy/glkvm-health` ships no type of its own. `glkvm_emit.ts` exports an
`extension` object that augments `@sntxrr/glinet-kvm`:

| Added | Kind | Purpose |
| ----- | ---- | ------- |
| `emit` | method | Read the model's latest `health` (or a passed-in record), resolve the OTLP endpoint and token, and POST one OTLP/HTTP log record plus gauges. |
| `emit` | resource | One push: `host`, `skipped`, `reason`, `endpoint`, `mesh`, `logsStatus`, `metricsStatus`, `pushed`, `verdict`, `emittedAt`. |

`emit` arguments: `health` (optional record; default the latest `health`
resource), `endpoint` (OTLP/HTTP base URL override), `mesh` (contract mesh),
`otelModel` (settings model name, default `otel`), `otelVaultName`, and
`otelTokenRef`. It is a no-op that records the reason when no endpoint resolves.

The endpoint and resource attributes come from the `@svendowideit/otel-settings`
contract: an explicit `endpoint` wins, else the named `mesh`, else the contract's
`defaultMesh`, else its first endpoint; a plaintext `otlp_http` `host:port` is
preferred for a local collector and the TLS `otlp_http_url` for anything else.
The bearer token is read from `otelVaultName`/`otelTokenRef` when the contract's
`authMethod` is `bearer`.

### The workflow

`@figy/glkvm-health` — one job (`health`) with three steps:

| Step | Task | Purpose |
| ---- | ---- | ------- |
| `check` | `@sntxrr/glinet-kvm` `health` | Read-only device check; always writes a `health` record. |
| `emit` | `@sntxrr/glinet-kvm` `emit` (added here) | Forward the latest verdict to OTLP (no-op if unconfigured). |
| `assert-checked` | assert | Fails the run only if `check` produced no record at all. |

### The DNS workflow

`@figy/glkvm-dns` — one job (`dns`) with three steps, driving the `glkvm-caddy`
caddy model (created per [Configuration](#the-caddy-model-glkvm-caddy)):

| Step | Task | Purpose |
| ---- | ---- | ------- |
| `tls` | `@svendowideit/caddy` `configureTls` | Ensure a DNS provider so records can be written; no TLS subjects. |
| `dns` | `@svendowideit/caddy` `applyDnsRecords` | Reconcile `glkvm.fi.gy` — merged with the Caddy's peer models' records — into Caddy. |
| `assert-applied` | assert | Fails the run only if no `dnsConfig` record was written. |

It depends on `@svendowideit/caddy` (declared in the manifest). The caddy mixin
merges every repo model sharing the `glkvm-caddy` model's `(target,
serviceName)`, so this one record is reconciled alongside `my-caddy`'s TLS,
routes and records; running the workflow never removes a peer's records.

### Structure and how to extend it

- The pure helpers are exported for testing: `telemetryResource`,
  `pickEndpoint`, `buildOtlpLogs`, `buildOtlpMetrics`, `normalizeHealth`, plus the
  `EXT_TYPE`/`EXT_VERSION`/`BASE_TYPE`/`OTEL_SERVICE_NAME` constants. Only the
  `emit` execute function does IO (one `fetch` per signal).
- To add another gauge, extend `buildOtlpMetrics` and its test together; to add a
  fact to the log record, extend `buildOtlpLogs`.
- To watch a second KVM, run the workflow again with `--input host=… --input
  device=…`; to change the collector, set `otelEndpoint` (or blank it to follow the
  `otel-settings` contract).
- Run the tests with the bundled deno:

```sh
~/.swamp/deno/deno test --allow-env --allow-read --allow-net extensions/figy/glkvm-health/glkvm_emit_test.ts
```

### Testing

```sh
# Validate the DAG before running it, then run it once against the live KVM.
swamp workflow validate @figy/glkvm-health
swamp workflow run @figy/glkvm-health
```

## License

MIT — see LICENSE.txt.
