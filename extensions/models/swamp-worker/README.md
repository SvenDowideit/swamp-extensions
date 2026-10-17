# @svendowideit/swamp-worker

Enlist a host as a **swamp worker** for one `swamp serve` orchestrator, from a
declarative swamp model: install or upgrade it, reconcile its systemd user unit,
mint its enrollment token, and report or remove exactly the worker this repo
owns.

## What it does

`swamp serve` can fan workflow steps out across **workers** — disposable swamp
processes that dial home, enroll with a token, and execute dispatched method
bodies ([remote execution](https://swamp-club.com/manual)). This model owns the
*host* half of that:

| Method | What it does |
| ------ | ------------ |
| `renderUnit` | Render the worker's systemd user unit from the desired state and record it (writes nothing on the host unless `write=true`). |
| `renderProvision` | Render the per-node **provisioning script** (install/upgrade binary, lock token, write unit, start it) for a fan-out deploy, with the host label filled from each node's own hostname, so one script serves every node. |
| `renderRemoval` | Render the per-node **removal script** (stop, disable and delete the unit and its artifacts) for a fan-out teardown. |
| `install` | Ensure the swamp binary is installed at `swampBinPath`, downloading the release (or a requested `version`) when it is absent or `force`; otherwise a no-op. |
| `mintToken` | Mint **one** enrollment token on the orchestrator, keyed per target by `name` (`<identity>-<hostname>` by default), and stage its plaintext in a `0600` file `<stagingDir>/<name>.token`; the secret never enters swamp data. Call it once per node. Reuses an already-staged token unless `force`. |
| `clearStagedTokens` | Delete the orchestrator-side staged token files for the given token `names`, after they have been delivered. |
| `revokeToken` | Revoke one enrollment token by `name` (any worker using it is disconnected) and, by default, delete the local token file. |
| `ensureService` | Reconcile this host onto the desired worker state — install the staged token, write the unit if it changed, `daemon-reload`, `enable --now` with linger, and restart **only** when the unit or token changed. |
| `status` | Report live unit state **on this host** and whether this identity's workers are enrolled. |
| `remove` | **Completely decommission** the worker: revoke its token (so it can never re-enroll), then stop/disable the unit and delete the unit, cache dir and token/env files. `revokeToken=false` splits the two when the repo isn't reachable from the host. |
| `guidance` | Print every global option with its value and how to change it. |

**Install and upgrade are the same command.** `@svendowideit/swamp-worker-upgrade`
is one idempotent workflow: on a fresh host it mints a token, installs the swamp
binary, writes the unit and starts it; on a host that already runs the worker it
upgrades the binary to the requested release and reconciles the unit, restarting
only when the unit or token changed. See [Upgrade](#upgrade).

**Why not `swamp worker daemon enable`?** The built-in daemon hardcodes the unit
name `swamp-worker`, so only one worker can exist per host. This model namespaces
**every** artifact by `identity` — unit `swamp-worker-<identity>.service`, cache
dir, token and env files — so a worker this repo manages coexists with workers
*other* swamps install on the same host and never touches them. It is portable:
it knows no domain, no serve hostname and no node set of its own. A site
extension (for example `@figy/swamp-worker`) supplies those and drives this model
over SSH.

**Prerequisite — a running systemd user manager.** The worker is a systemd
*user* service, so `systemctl --user` must work on the host: a live `logind` and
`user@<uid>.service` with `/run/user/<uid>`. On a host where `logind` is dead (for
example a dangling unit dependency), there is no user manager, `systemctl --user`
fails, and `ensureService`/the provisioning script cannot install the unit.

**The worker binary and the serve must speak the same protocol.** When the serve
lags the release installed on the worker, the connect fails with `Worker protocol
version N does not match orchestrator version M` and the unit restart-loops. Keep
the serve current (for example `swamp model method run swamp-serve updateBinary`),
or pin the worker with the `version` argument to a release that matches.

## Install

```sh
swamp extension pull @svendowideit/swamp-worker
```

## Configuration

Global arguments are set at model creation (`swamp model create
@svendowideit/swamp-worker worker --global-arg key=value`) or edited later with
`swamp model edit worker`:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `identity` | string | `worker` | Slug that namespaces every artifact. Use one identity per repo. |
| `unitName` | string | `swamp-worker-<identity>` | Systemd unit name (without `.service`). |
| `swampBinPath` | string | `/usr/local/bin/swamp` | Absolute path to the swamp binary the unit runs. |
| `repoDir` | string | `.` | Repo dir used for local `swamp worker token` calls. |
| `configDir` | string | `~/.config/swamp-worker` | Dir for the identity's `0600` token/env files. |
| `cacheDirRoot` | string | `~/.local/share/swamp-worker` | Root for per-identity cache dirs (each holds the enrollment machine-id). |
| `unitDir` | string | `~/.config/systemd/user` | Dir where the unit file is written. |
| `swampHome` | string | `~/.swamp` | `SWAMP_HOME` exported into the unit. |
| `swampConfigDir` | string | `~/.config/swamp` | `SWAMP_CONFIG_DIR` exported into the unit. |
| `concurrency` | string | `auto` | Worker `--concurrency` (`auto` = CPU count). |
| `enableLinger` | boolean | `true` | Run `loginctl enable-linger` so the worker survives logout/reboot. |
| `otelSettingsModel` | string | `""` | Name of the `@svendowideit/otel-settings` model to export telemetry to (empty = telemetry off). |
| `otelServiceName` | string | `swamp-worker` | `OTEL_SERVICE_NAME` (and resource `service.name`) the worker reports. |
| `telemetryVault` | string | `""` | Vault holding the OTLP gateway bearer token (empty = unauthenticated). |
| `authRef` | string | `OTEL_EXPORTER_OTLP_TOKEN` | Vault key holding the bearer token (a reference, never the secret). |
| `releaseBaseUrl` | string | GitHub releases | Base URL for swamp release downloads. |

`swampBinPath` is the setting that bites: the model **exec's it on the
orchestrator** to mint and revoke tokens, so it must point at an existing swamp
binary there — a per-user install is usually `~/.local/bin/swamp`, not the
`/usr/local/bin/swamp` default (which yields `Failed to spawn '/usr/local/bin/swamp'`
on token minting). The provisioning script installs the same path on each node,
so on a set of hosts it must be a path each node's user can write.

**Telemetry.** Set `otelSettingsModel` to the site's `@svendowideit/otel-settings`
model (e.g. `otel`) and the worker unit gains that contract's
`OTEL_EXPORTER_OTLP_*` env — the default-mesh OTLP endpoint, protocol, service
name and resource attributes, plus `OTEL_BSP_USE`/`OTEL_BLRP_USE` batching. The
worker then exports **logs, metrics and traces**. Each node adds a `host=<node>`
resource attribute, so a single `service.name` (`otelServiceName`) stays
filterable per host. Set `telemetryVault`/`authRef` when the gateway requires a
bearer token. With `otelSettingsModel` empty (the default) the unit is
unchanged. The resolution mirrors `@svendowideit/swamp-serve`: it reads the
settings model's `settings` document; because the fan-out renders one unit for
all nodes, the `host` attribute carries the `@@TF_HOSTNAME@@` placeholder and
the provisioning script substitutes each node's real hostname at install time.

Per-call arguments:

| Method | Arguments |
| ------ | --------- |
| `renderUnit` | `serveUrl` (required), `host`, `labels` (KEY=VALUE), `concurrency`, `write` |
| `renderProvision` | `serveUrl` (required), `host`, `labels`, `concurrency`, `version` |
| `renderRemoval` | *(none)* |
| `install` | `version`, `force` |
| `mintToken` | `name` (default `<identity>-<hostname>`), `duration` (default `30d`), `force` |
| `clearStagedTokens` | `names` (list) |
| `revokeToken` | `name` (default `<identity>-<hostname>`), `purgeFile` (default `true`) |
| `ensureService` | `serveUrl` (required), `host`, `labels`, `concurrency`, `name`, `force` |
| `remove` | `name` (default `<identity>-<hostname>`), `revokeToken` (default `true`), `purgeData` (default `true`) |

The `host` label defaults to the machine hostname; every worker advertises
`serve=<identity>` and `host=<hostname>` plus any `labels` you pass.

## Examples

Run the whole thing — install on a fresh host, upgrade on an existing one — with
one idempotent command. This is the entry point to reach for; re-running it is a
no-op when nothing changed:

```sh
swamp workflow run @svendowideit/swamp-worker-upgrade \
  --input serveUrl=wss://swamp.x1yoga.fi.gy \
  --input identity=figy --input swampBinPath=~/.local/bin/swamp
```

Give the worker telemetry: set `otelSettingsModel` at creation so its unit
carries the site's `OTEL_EXPORTER_OTLP_*` env (logs, metrics and traces export
from every node), then re-run the upgrade to apply it:

```sh
swamp model create @svendowideit/swamp-worker worker \
  --global-arg identity=figy \
  --global-arg swampBinPath=~/.local/bin/swamp \
  --global-arg otelSettingsModel=otel
swamp workflow run @svendowideit/swamp-worker-upgrade \
  --input serveUrl=wss://swamp.x1yoga.fi.gy \
  --input identity=figy --input swampBinPath=~/.local/bin/swamp
```

Or drive the model methods directly — mint a token, then bring the unit up on
this host. `identity` namespaces the worker so it is unique per repo:

```sh
swamp model create @svendowideit/swamp-worker worker \
  --global-arg identity=figy \
  --global-arg swampBinPath=~/.local/bin/swamp
swamp model method run worker mintToken --input duration=30d
swamp model method run worker ensureService --input serveUrl=wss://swamp.x1yoga.fi.gy
```

Inspect the desired unit *without* changing the host, then read its state. Use
`renderUnit` to review what will be written (audit/diff) before applying it, and
`status` to confirm enrolment after:

```sh
swamp model method run worker renderUnit --input serveUrl=wss://swamp.x1yoga.fi.gy
swamp model method run worker status
```

Verify a **remote** worker after a fan-out deploy. `status` reports only the
local host, so check the node's unit directly and confirm enrolment on the
orchestrator:

```sh
ssh sven@host1.lan systemctl --user is-active swamp-worker-figy
swamp worker list
```

Add a scheduling label and reconcile. Re-running `ensureService` rewrites and
restarts the worker only when the desired state changed; run it again with no
change and it is a no-op:

```sh
swamp model method run worker ensureService \
  --input serveUrl=wss://swamp.x1yoga.fi.gy --input 'labels:json=["tier=prod"]'
```

Completely reverse it. `remove` revokes the token, stops and disables the unit
and deletes only this identity's artifacts; a foreign `swamp-worker-rc` unit on
the same host is left alone:

```sh
swamp model method run worker remove
```

Pass `revokeToken=false` when the token is revoked from the orchestrator
separately (for example when the host cannot reach the repo), and keep
`revokeToken`/`remove` as the two halves of a cross-host teardown.

For a **fan-out** deploy (many hosts, over SSH), the model renders the scripts
and token staging; the [`@figy/swamp-worker`](../figy/swamp-worker) site workflow
(or your own) ships them with `@swamp/ssh`. The primitives:

```sh
# Render the provisioning script (host label filled from each node's hostname),
# then mint and stage one 0600 token per node — one mintToken call per node, each
# keyed by its own name, so a slow node touches only its own file/record under
# stagingDir (/tmp/swamp-worker-staging):
swamp model method run worker renderProvision --input serveUrl=wss://swamp.x1yoga.fi.gy
swamp model method run worker mintToken --input name=figy-host1
swamp model method run worker mintToken --input name=figy-host2

# Then, from a workflow, feed them to @swamp/ssh:
#   copy   src=/tmp/swamp-worker-staging/<name>.token   (name=figy-<node>)
#          dst=/tmp/swamp-worker-token   (direction: to) — the script installs it
#   script script=<data.latest("worker","provision").attributes.script
# The removal script is data.latest("worker","removal").attributes.script.
```

Print every option and its current value, so a setting can be changed without
reading this file:

```sh
swamp model method run worker guidance
```

## Upgrade

Install and upgrade are the same idempotent workflow — there is no separate
upgrade command to remember:

```sh
# Re-run to upgrade this host's swamp binary to the newest release and reconcile
# its unit; no new inputs are needed. Pin a release with --input version=<tag> to
# hold the host back.
swamp workflow run @svendowideit/swamp-worker-upgrade \
  --input serveUrl=wss://swamp.x1yoga.fi.gy \
  --input identity=figy --input swampBinPath=~/.local/bin/swamp
```

It collects nothing it cannot infer: `identity` and `swampBinPath` are the
worker's own settings (pass them once, or set them as the `worker` model's globals
and they are reused). It then, in order, ensures the token (reusing any staged
one), upgrades `swampBinPath` to `version` (default `latest`), reconciles the
unit — writing it only when it differs and restarting only when the unit or the
token changed — and finally runs `status` so the run ends on verified reality.
Because every step is idempotent, re-running is safe and changes only what
differs.

## Details

`@svendowideit/swamp-worker` ships one model type (`@svendowideit/swamp-worker`)
and one workflow (`@svendowideit/swamp-worker-upgrade`). It installs nothing on
the host beyond a systemd user unit, the worker's cache dir, and `0600` token/env
files under `configDir`; it enables user lingering. When `otelSettingsModel` is
set, the unit also carries the contract's `OTEL_EXPORTER_OTLP_*` env (see
[Configuration](#configuration)), mirroring `@svendowideit/swamp-serve`'s
telemetry resolution. It does not install cron triggers or webhooks of its own.

Resources: `unit` (rendered content + path), `install` (binary presence),
`token` (**keyed by token name** — name, duration, path; never the secret),
`worker` (reconcile result: `changed`/`restarted`/`active`/`enabled` and the
label set), `status` (live unit state + enrolled workers). Every resource is
keyed by its target, never a fixed slot, so two hosts never overwrite one
another's record.

The unit is rendered by the pure `renderWorkerUnit` helper and the path helpers
(`unitPathFor`, `tokenFilePath`, `envFilePath`, `cacheDirFor`) — exported and
unit-tested — so the *same* code renders the unit a site workflow ships to a
remote host over SSH as the one `ensureService` writes locally. `remove` refuses
any unit that is not `swamp-worker-<identity>` (`assertOwnedUnit`), which is the
guard that keeps another repo's worker untouched.

### Developing and testing

```sh
# Type-check and unit-test the pure helpers.
~/.swamp/deno/deno check swamp_worker.ts
~/.swamp/deno/deno test --allow-env --allow-read --allow-write --allow-run swamp_worker_test.ts

# End-to-end, on a systemd host, through @svendowideit/test-factory in a container
# (the suite ships as test-factory.yaml): enrol, dispatch, reconcile, coexistence,
# teardown, and per-node token minting (isolation + idempotency).
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/swamp-worker/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

## License

MIT — see LICENSE.txt.
