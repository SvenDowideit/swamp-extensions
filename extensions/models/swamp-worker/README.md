# @svendowideit/swamp-worker

Enlist a host as a **swamp worker** for one `swamp serve` orchestrator, from a
declarative swamp model: render and reconcile its systemd user unit, ensure the
swamp binary, mint its enrollment token, and report or remove exactly the worker
this repo owns.

## What it does

`swamp serve` can fan workflow steps out across **workers** — disposable swamp
processes that dial home, enroll with a token, and execute dispatched method
bodies ([remote execution](https://swamp-club.com/manual)). This model owns the
*host* half of that:

| Method | What it does |
| ------ | ------------ |
| `renderUnit` | Render the worker's systemd user unit from the desired state and record it (writes nothing on the host unless `write=true`). |
| `renderProvision` | Render the per-node **provisioning script** (install binary, lock token, write unit, start it) for a fan-out deploy, with the host label filled from each node's own hostname, so one script serves every node. |
| `renderRemoval` | Render the per-node **removal script** (stop, disable and delete the unit and its artifacts) for a fan-out teardown. |
| `stageTokens` | Mint one enrollment token **per node** on the orchestrator and stage each plaintext in a `0600` file, for a site workflow to `copy` to that node. |
| `install` | Ensure the swamp binary is installed at `swampBinPath`, downloading the release (or a requested `version`) when it is absent or `force`; otherwise a no-op. |
| `clearStagedTokens` | Delete the orchestrator-side staged token files for the given nodes, after they have been delivered. |
| `mintToken` | Mint a single enrollment token on the orchestrator and write it to a `0600` file; the plaintext never enters swamp data. Reuses an existing token unless `force` (so re-running is idempotent). |
| `revokeToken` | Revoke this identity's enrollment token (any worker using it is disconnected) and, by default, delete the local token file. |
| `ensureService` | Reconcile this host onto the desired worker state — write the unit if it changed, `daemon-reload`, `enable --now` with linger, and restart **only** when the unit changed. |
| `status` | Report live unit state and whether this identity's workers are enrolled. |
| `remove` | **Completely decommission** the worker: revoke its token (so it can never re-enroll), then stop/disable the unit and delete the unit, cache dir and token/env files. `revokeToken=false` splits the two when the repo isn't reachable from the host. |
| `guidance` | Print every global option with its value and how to change it. |

**Why not `swamp worker daemon enable`?** The built-in daemon hardcodes the unit
name `swamp-worker`, so only one worker can exist per host. This model namespaces
**every** artifact by `identity` — unit `swamp-worker-<identity>.service`, cache
dir, token and env files — so a worker this repo manages coexists with workers
*other* swamps install on the same host and never touches them. It is portable:
it knows no domain, no serve hostname and no node set of its own. A site
extension (for example `@figy/swamp-worker`) supplies those and drives this model
over SSH.

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
| `releaseBaseUrl` | string | GitHub releases | Base URL for swamp release downloads. |

Per-call arguments:

| Method | Arguments |
| ------ | --------- |
| `renderUnit` | `serveUrl` (required), `host`, `labels` (KEY=VALUE), `concurrency`, `write` |
| `renderProvision` | `serveUrl` (required), `host`, `labels`, `concurrency`, `version` |
| `renderRemoval` | *(none)* |
| `stageTokens` | `nodes` (list), `duration` (default `30d`) |
| `install` | `version`, `force` |
| `clearStagedTokens` | `nodes` (list) |
| `mintToken` | `node`, `duration` (default `30d`), `force` |
| `revokeToken` | `node`, `purgeFile` (default `true`) |
| `ensureService` | `serveUrl` (required), `host`, `labels`, `concurrency`, `force` |
| `remove` | `node`, `revokeToken` (default `true`), `purgeData` (default `true`) |

The `host` label defaults to the machine hostname; every worker advertises
`serve=<identity>` and `host=<hostname>` plus any `labels` you pass.

## Examples

Mint a token and bring the unit up on this host. Run these on the worker host;
`identity` namespaces the worker so it is unique per repo. This is the core
sequence — mint then reconcile:

```sh
swamp model create @svendowideit/swamp-worker worker \
  --global-arg identity=figy \
  --global-arg swampBinPath=/usr/local/bin/swamp
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

Add a scheduling label and reconcile. Re-running `ensureService` rewrites and
restarts the worker only when the desired state changed; run it again with no
change and it is a no-op. Dispatch a step to the label with a placed workflow
step (run through the orchestrator):

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
# Render the provisioning script (host label filled from each node's hostname)
# and stage one 0600 token per node under stagingDir (/tmp/swamp-worker-staging):
swamp model method run worker renderProvision --input serveUrl=wss://swamp.x1yoga.fi.gy
swamp model method run worker stageTokens --input 'nodes:json=["host1","host2"]'

# Then, from a workflow, feed them to @swamp/ssh:
#   copy   src=/tmp/swamp-worker-staging/figy-<node>.token
#          dst=/tmp/swamp-worker-token   (direction: to) — the script installs it
#   script script=<data.latest("worker","provision").attributes.script
# The removal script is data.latest("worker","removal").attributes.script.
```

Print every option and its current value, so a setting can be changed without
reading this file:

```sh
swamp model method run worker guidance
```

## Details

`@svendowideit/swamp-worker` ships one model type (`@svendowideit/swamp-worker`).
It installs nothing on the host beyond a systemd user unit, the worker's cache
dir, and `0600` token/env files under `configDir`; it enables user lingering. It
does not install cron triggers or webhooks of its own.

Resources: `unit` (rendered content + path), `install` (binary presence),
`token` (name, duration, path — never the secret), `worker` (reconcile result:
`changed`/`restarted`/`active`/`enabled` and the label set), `status` (live unit
state + enrolled workers).

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
# teardown.
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/swamp-worker/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

## License

MIT — see LICENSE.txt.
