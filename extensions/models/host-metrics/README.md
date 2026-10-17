# @svendowideit/host-metrics

Sample every host in a swamp fleet — disk, network IO, load and memory — and
push each sample to the swamp-managed OpenTelemetry system, every 15 minutes.

## What it does

`@aaronge/host-health` reads the local machine's disk (`df`), load, memory and
thermal telemetry — but it reads no network counters, and it has no way to
*report* a host to telemetry. This extension adds the missing pieces and a way
to enumerate the fleet, as three methods on the `@svendowideit/host-metrics`
model:

- **`listWorkers`** reads the swarm worker pool the orchestrator knows about and
  writes the `workers` resource — ordinary data a workflow can fan a step out
  over, because control-plane `swamp/worker` records are invisible to workflow
  `data.query`.
- **`readNetwork`** reads `/proc/net/dev` and writes a `network` resource with
  per-interface receive/transmit byte counters and the deltas since the previous
  read on the same model instance.
- **`emit`** reads a per-host `@aaronge/host-health` instance's latest
  `filesystems`, `load`, `memory` and `thermal`, plus this instance's `network`,
  resolves the OTLP endpoint and bearer token from the
  `@svendowideit/otel-settings` contract, and POSTs one OTLP log record plus
  gauges to the collector — including the change in `/` free space since the
  previous emit. With no collector configured it is a no-op that records why.

`@svendowideit/host-metrics-fleet` runs the whole pipeline: it samples the serve
(orchestrator) host locally and every attached worker on its own host, then
pushes each to OTel, on a `*/15 * * * *` trigger.

It is a **standalone** type, not an augmentation of host-health: on a remote
execution worker, dispatch resolves a type's methods from its own bundle, and an
augmentation of a pulled type is not applied there. It reads the per-host
host-health instance by name instead. Each worker iteration is pinned with
`target: ${{ self.worker.name }}` so a sample always runs on the host it is
named for — fan-out alone spreads load and would pack several iterations onto
the largest worker.

## Install

```sh
swamp extension pull @svendowideit/host-metrics
```

## Configuration

Global arguments (set at model creation with `--global-arg key=value`):

| Argument               | Default                     | Purpose                                                            |
| ---------------------- | --------------------------- | ------------------------------------------------------------------ |
| `healthInstancePrefix` | `host-health-`              | Prefix for the per-host `@aaronge/host-health` instance name        |
| `otelModel`            | `otel`                      | `@svendowideit/otel-settings` model supplying the OTLP contract     |
| `otelVaultName`        | `""`                        | Vault holding the OTLP gateway bearer token                         |
| `otelTokenRef`         | `OTEL_EXPORTER_OTLP_TOKEN`  | Vault/environment key for the bearer token                          |

Method arguments:

| Method        | Arguments                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------ |
| `listWorkers` | none                                                                                       |
| `readNetwork` | none                                                                                       |
| `emit`        | `host`, `healthModel`, `endpoint`, `mesh`, `otelModel`, `otelVaultName`, `otelTokenRef`     |

Workflow inputs for `@svendowideit/host-metrics-fleet`: `otelModel`,
`otelVaultName`, `otelTokenRef`.

## Examples

Sample this machine once — the network counter, then the fleet report that
combines it with host-health's disk/load/memory/thermal:

```sh
swamp model @svendowideit/host-metrics method run readNetwork host-metrics-host
swamp model @svendowideit/host-metrics method run emit host-metrics-host \
  --input healthModel=host-health-host
```

List the worker pool as ordinary data, then read it back — this is the list the
fleet workflow fans out over:

```sh
swamp model @svendowideit/host-metrics method run listWorkers host-metrics-fleet
swamp data query 'modelName == "host-metrics-fleet" && name == "workers"' --select content
```

Run the scheduled pipeline now (through the orchestrator, so worker placement
applies) — use this to validate the sweep without waiting for the 15-minute
trigger:

```sh
swamp workflow run @svendowideit/host-metrics-fleet --server ws://127.0.0.1:9090
```

Confirm what each host pushed (endpoint, HTTP statuses, `/` free space and its
change since the previous cycle):

```sh
swamp data query 'modelType == "@svendowideit/host-metrics" && name == "emit"' --select content
```

## Details

**Model** `@svendowideit/host-metrics` (global args above).

- `listWorkers` → `workers` resource (`workers[]`, `capturedAt`); run locally on
  the orchestrator. Filters out `disconnected` workers and derives each entry's
  `host` from its `host` label.
- `readNetwork` → `network` resource (`host`, `interfaces[]` with `rxBytes`,
  `txBytes` and their deltas, non-loopback totals `totalRxBytes`/`totalTxBytes`
  and `totalRxBytesDelta`/`totalTxBytesDelta`, `capturedAt`). Reads through
  `cat` because swamp's method sandbox denies direct `/proc` reads.
- `emit` → `emit` resource (`host`, `skipped`, `reason`, `endpoint`, `mesh`,
  `logsStatus`, `metricsStatus`, `pushed`, `diskAvailBytes`,
  `diskAvailChangeBytes`, `capturedAt`, `emittedAt`). Resolves the contract from
  the `otelModel`'s `settings`-spec data; an explicit `endpoint` wins.

**Workflow** `@svendowideit/host-metrics-fleet` (trigger `*/15 * * * *`).

- `discover` → `list-workers` runs `listWorkers` locally on `host-metrics-fleet`.
- `workers` (`platform: linux`): five `forEach` steps over
  `data.latest("host-metrics-fleet", "workers").attributes.workers` —
  `readFilesystems`/`readLoad`/`readMemory` on `host-health-<host>`,
  `readNetwork` and `emit` on `host-metrics-<host>`. Each step carries
  `target: ${{ self.worker.name }}` to pin it to that worker.
- `serve-host`: the same five steps, unplaced (local), on `host-health-serve`
  and `host-metrics-serve`.

Every method is idempotent and safe to re-run. `emit` is a no-op that records
why when no `@svendowideit/otel-settings` contract or endpoint is configured.

## Upgrade

This extension installs nothing on any host, so an upgrade has nothing to
rebuild or reconcile. Refresh the pulled copy with one idempotent command:

```sh
swamp extension update
```

The `@aaronge/host-health` reads it consumes are upgraded by that extension's
own `upgrades` entry on the next method run.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
