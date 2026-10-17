# @figy/nanokvm-health

fi.gy's site-specific, scheduled NanoKVM health pipeline: check the out-of-band
KVM on the LAN, forward its health to the swamp-managed OpenTelemetry collector,
publish a fleet health report, and publish every NanoKVM as a DNS record.

## What it does

The extension ships three workflows.

**`@figy/nanokvm-health`** runs every 15 minutes (`trigger.schedule`) and:

1. runs `@svendowideit/nanokvm`'s `health` method against the KVM on the LAN
   (password read from the `nanokvm` vault), producing a `pass`/`warn`/`fail`
   verdict with findings;
2. runs the model's `emit` method, which posts the latest verdict to the local
   OTLP receiver (`http://127.0.0.1:4318`) as a log record plus gauges
   (`nanokvm.up`, `nanokvm.health`, `nanokvm.response_time`, …);
3. publishes `@svendowideit/nanokvm-health-report` (workflow scope).

A device that is off or unreachable is **not** a workflow failure — it is a
`fail` verdict, emitted like any other sample, so a flapping device leaves a
trail and the report always has something to show.

**`@figy/nanokvm-dns`** publishes every NanoKVM swamp looks after as
`<name>.fi.gy` A records. It runs the model's `devices` method (a scan of the
repo's `@svendowideit/nanokvm` model definitions — not the network), then
reconciles an A record per device into the shared Caddy via the caddy **mixin**,
so adding a KVM is just adding a model definition. The records live on a
dedicated repo caddy model (`nanokvm-caddy`); the workflow runs `configureTls`
then `applyDnsRecords`, and declares each device name as a TLS subject with
`keyType=rsa2048` so Caddy issues and renews a **Let's Encrypt** certificate for
it via DNS-01 (no reverse-proxy route — the name points at the KVM itself). See
[The caddy model](#the-caddy-model-nanokvm-caddy).

**`@figy/nanokvm-cert`** installs that certificate **onto the device**, on a
daily schedule. The NanoKVM has no certificate-upload endpoint, so it drives the
model's `cert install`, which writes `/etc/kvm/server.crt` and `.key` through the
device's admin script API and restarts the web server, then verifies the device
actually serves a certificate carrying the device's name. The certificate is
RSA — the firmware's own `nanokvm.sh` supervisor runs `openssl rsa -check` and
would otherwise reject and regenerate a self-signed one — and it is fetched from
Caddy's store, so the workflow only ever syncs, never issues.

Side effects: it drives the device model (network calls to the KVM and the
collector), the caddy model (one DNS reconcile and one certificate issuance), and
writes swamp data. It installs nothing on the host.

## Install

```sh
swamp extension pull @figy/nanokvm-health
```

## Prerequisites

- A NanoKVM reachable at the configured `host`.
- Its login password in a swamp vault:

```sh
swamp vault create @svendowideit/systemd-creds nanokvm
swamp vault put nanokvm NANOKVM_PASSWORD
```

- A running OTLP gateway on `127.0.0.1:4318` (the `@svendowideit/otel-gateway`).
  Without it, `emit` still runs and records why it skipped.

## Configuration

Every input can be overridden per run with `--input key=value`. The defaults
are the fi.gy values.

| Input | Type | Default | Meaning |
| ----- | ---- | ------- | ------- |
| `device` | string | `nanokvm` | Name of the `@svendowideit/nanokvm` model instance to drive. |
| `host` | string | *this site's KVM* | NanoKVM address (no scheme); the concrete default is the `host` input in `figy-nanokvm-health.yaml`. |
| `port` | integer | `443` | HTTPS port of the web server. |
| `username` | string | `admin` | Web UI user. |
| `vaultName` | string | `nanokvm` | Vault holding the login password. |
| `passwordRef` | string | `NANOKVM_PASSWORD` | Vault key holding the password. |
| `curlModel` | string | `nanokvm-curl` | `@svendowideit/curl` instance that carries the session. |
| `otelModel` | string | `otel` | `@svendowideit/otel-settings` model for the OTLP contract. |
| `otelEndpoint` | string | `http://127.0.0.1:4318` | OTLP/HTTP base URL (empty = use the contract). |
| `otelMesh` | string | `tailscale` | Contract mesh to prefer when `otelEndpoint` is empty. |
| `otelVaultName` | string | `""` | Vault holding the OTLP bearer token (empty = none). |
| `otelTokenRef` | string | `OTEL_EXPORTER_OTLP_TOKEN` | Vault/env key for the token. |

The schedule is read-only inside an extension. Change it from the host:

```sh
# Read the current trigger, change the cadence, or remove it.
swamp workflow trigger get @figy/nanokvm-health
swamp workflow trigger set @figy/nanokvm-health --schedule "*/5 * * * *"
swamp workflow trigger remove @figy/nanokvm-health
```

### The caddy model (`nanokvm-caddy`)

`@figy/nanokvm-dns` drives a `@svendowideit/caddy` model named `nanokvm-caddy`
whose only desired state is the discovered records plus the settings every model
sharing one Caddy must agree on. It must be a **repo model** (under `models/`):
the caddy mixin merges models by `(target, serviceName)`, but treats
workflow/auto-created definitions as scratch and excludes them. Create it once:

```sh
swamp model create @svendowideit/caddy nanokvm-caddy \
  --global-arg baseDomain=fi.gy \
  --global-arg letsEncryptEmail=SvenDowideit@home.org.au \
  --global-arg environmentFile=$HOME/.config/caddy/dns.env \
  --global-arg 'plugins:json=["github.com/caddy-dns/gandi"]' \
  --global-arg 'dnsRecords:json=[]'
```

It shares `my-caddy`'s `serviceName` (`caddy`) and `target` (this machine), so the
two merge. Its `dnsRecords` are supplied per run by the workflow (built from the
model's `devices` scan), so it holds no records itself. `baseDomain`,
`letsEncryptEmail`, `environmentFile` and `plugins` mirror `my-caddy` because the
TLS email/provider must match across every model sharing the Caddy — the mixin
errors on a contradiction.

## Examples

```sh
# Run the pipeline once, now, instead of waiting for the trigger.
swamp workflow run @figy/nanokvm-health

# Check a different device on the same LAN.
swamp workflow run @figy/nanokvm-health --input host=192.0.2.10

# Read the fleet report the run produced (verdicts, findings, OTLP summary).
swamp report get @svendowideit/nanokvm-health-report \
  --workflow @figy/nanokvm-health --markdown

# Confirm the last emit reached the collector, and what it sent.
swamp data query 'behavior("nanokvm") && name == "emit"' --select content

# Publish every NanoKVM swamp looks after as <name>.fi.gy A records, merged
# into the shared Caddy (run after adding or moving a device). Caddy then issues
# and renews a Let's Encrypt certificate for each name.
swamp workflow run @figy/nanokvm-dns

# Install the renewed certificate onto the device (scheduled daily; also run
# after a firmware update, which can wipe /etc/kvm).
swamp workflow run @figy/nanokvm-cert

# See what the discovery found (the A records the DNS step reconciled).
swamp data query 'behavior("nanokvm") && name == "devices"' --select content \
  | jq '.aRecords'
```

## Upgrade

This extension installs nothing on the host, so an upgrade has nothing to
rebuild or reconcile. Refresh the pulled workflow with one idempotent command:

```sh
# Pull the newest published copy of the workflow (and the model it drives).
swamp extension update
```

The device model it drives is upgraded by `@svendowideit/nanokvm`'s own
`upgrades` entry on the next method run.

## Details

### Workflow

`@figy/nanokvm-health` — one job (`health`) with three steps:

| Step | Task | Purpose |
| ---- | ---- | ------- |
| `check` | `@svendowideit/nanokvm` `health` | Read-only device check; always writes a `health` record. |
| `emit` | `@svendowideit/nanokvm` `emit` | Forward the latest verdict to OTLP (no-op if unconfigured). |
| `assert-checked` | assert | Fails the run only if `check` produced no record at all. |

`reports.require` names `@svendowideit/nanokvm-health-report`, so every run
(including a failed one) gets a workflow-scope report at
`swamp report get @svendowideit/nanokvm-health-report --workflow @figy/nanokvm-health`.

### The DNS workflow

`@figy/nanokvm-dns` — one job (`dns`) with four steps, driving the
`nanokvm-caddy` caddy model (created per
[The caddy model](#the-caddy-model-nanokvm-caddy)):

| Step | Task | Purpose |
| ---- | ---- | ------- |
| `discover` | `@svendowideit/nanokvm` `devices` | Scan the repo's model definitions for NanoKVM devices; write the `devices` record with an A-record list. |
| `tls` | `@svendowideit/caddy` `configureTls` | Ensure a DNS provider so records can be written; no TLS subjects. |
| `dns` | `@svendowideit/caddy` `applyDnsRecords` | Reconcile the discovered A records — merged with the Caddy's peer models' records — into Caddy. |
| `assert-applied` | assert | Fails the run only if no `dnsConfig` record was written. |

The `dns` step passes the discovered records as a step `globalArgs.dnsRecords`,
so the caddy model's own desired state is the freshly discovered set each run;
the mixin merges it with `my-caddy`'s records, and running the workflow never
removes a peer's records. The record name is the model instance name plus the
zone (`nanokvm` -> `nanokvm.fi.gy`), so a device is published by adding a
`@svendowideit/nanokvm` model definition and re-running this workflow. The `tls`
step also declares the names as TLS subjects (`keyType=rsa2048`), so Caddy
obtains a Let's Encrypt certificate for each via DNS-01.

### The certificate workflow

`@figy/nanokvm-cert` — one job (`cert`) with two steps, on the daily
`trigger.schedule`, installing the Caddy-issued certificate onto the device:

| Step | Task | Purpose |
| ---- | ---- | ------- |
| `install` | `@svendowideit/nanokvm` `cert` (`action=install`) | Locate the certificate for `<device>.<zone>` in Caddy's store, write it onto the device via the admin script API, restart the web server and verify it is served. |
| `assert-installed` | assert | Fails the run if the device does not end up serving a certificate for its name. |

The NanoKVM cannot upload a certificate over its API, so the model writes
`/etc/kvm/server.crt` and `/etc/kvm/server.key` with a script run through the
admin script API and restarts the server — detached, because the script is a
child of the server it restarts, and version-agnostically (`S95nanokvm` on newer
firmware, otherwise signalling `NanoKVM-Server` for the `nanokvm.sh` supervisor
to respawn). The key must be **RSA**: the firmware's `makesure_https_crt` runs
`openssl rsa -check` and would otherwise delete the files and regenerate a
self-signed `CN=localhost` certificate — hence `keyType=rsa2048` on the `tls`
step. The workflow is idempotent (an unchanged certificate is a no-op that still
verifies) and re-installs after a firmware update, which can wipe `/etc/kvm`.

### Structure and how to extend it

The step `globalArgs` bind the generic model to this site's address, vault and
collector; nothing secret is in the file. To watch a second NanoKVM, add a step
for another model instance (a different `modelName` and `host`), or run the
workflow again with `--input host=… --input device=…`. To change the destination
collector, set `otelEndpoint` (or blank it to follow the `otel-settings`
contract). The report reads only swamp data, so it is safe to run on this
schedule.

On the DNS side, `--input caddy=…` targets a different repo caddy model and
`--input nanokvmModel=…` picks which instance runs the repo scan (its own
address is irrelevant). Change the DNS zone with `--input zone=…`.

### Testing

```sh
# Validate the DAGs before running them, then run each once (live).
swamp workflow validate @figy/nanokvm-health
swamp workflow run @figy/nanokvm-health
swamp workflow validate @figy/nanokvm-dns
swamp workflow run @figy/nanokvm-dns
swamp workflow validate @figy/nanokvm-cert
swamp workflow run @figy/nanokvm-cert
```

## License

MIT — see LICENSE.txt.
