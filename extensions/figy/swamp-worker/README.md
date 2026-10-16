# @figy/swamp-worker

Site-specific fi.gy half of the swamp worker setup: deploy a `swamp worker` to a
**set of hosts over SSH** — and completely remove it — driving the generic
`@svendowideit/swamp-worker` model with `@swamp/ssh`.

## What it does

The portable model (`@svendowideit/swamp-worker`) knows how to render a worker
unit, mint a token and reconcile a service — but it takes no node set and speaks
no SSH. This extension supplies the fi.gy node set and the fan-out, as two
workflows:

| Workflow | Steps | What it does |
| -------- | ----- | ------------ |
| `@figy/swamp-worker-bootstrap` | `render` → `mint-token` → `deliver-tokens` → `provision` | Renders the per-node provisioning script, mints one token **per node** (`mintToken`, one call per node, staged `0600`, reused unless `force`), copies each node its own token over SSH to a staging path, then runs the provisioning script on every node (which installs the token to its final `0600` location, installs/updates the swamp binary, writes the `swamp-worker-figy` systemd user unit, restarts it if the unit **or the token** changed, and fails unless the unit is active). |
| `@figy/swamp-worker-rotate` | `render` → `mint-new` → `deliver-new` → `apply` → `revoke-previous` | Rotates the enrollment tokens before they expire **without ever stranding a worker**: mints a new token per node under a generation name (`<identity>-<node>-g<gen>`), delivers it, restarts the unit onto it, then revokes the previous token — the old token stays valid until the swap completes. |
| `@figy/swamp-worker-teardown` | `render-removal` → `remove-on-nodes` → `revoke-tokens` | Runs the removal script on every node over SSH (stop, disable and delete the unit, cache dir, token and env files), then revokes each node's token on the orchestrator, so a worker can never re-enrol. |

All three are re-runnable: `mintToken` is per-target, so a re-run reuses each
node's already-staged token (its `0600` staging file and the node's `0600` token
file are unchanged) and the provisioning script restarts the unit **only** when
it changed. Every artifact is namespaced by `identity`, so a worker this repo
deploys coexists with workers other repos deploy to the same hosts and never
touches them.

## Install

```sh
swamp extension pull @figy/swamp-worker
```

Requires `@svendowideit/swamp-worker` and `@swamp/ssh` (pulled separately), a
running fi.gy `swamp serve` the workers can reach, and OpenSSH key access to the
nodes.

## Configuration

Workflow inputs (identical on both workflows unless noted):

| Input | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `serveUrl` | string | — | The serve URL the workers dial (`wss://` for a TLS front). **Required** (bootstrap only). |
| `hosts` | array | `[]` | The node set, each `{name, address, [user], [port]}`. `name` is the worker's node name; the token name is `<identity>-<name>`. |
| `identity` | string | `figy` | Worker identity — must match the generic `worker` model's `identity`. |
| `duration` | string | `30d` | Enrollment token lifetime (a hard deadline). Bootstrap and rotate. |
| `generation` | string | — | Rotation generation; the new token is `<identity>-<node>-g<gen>`. **Required** (rotate only). |
| `previousSuffix` | string | `""` | Suffix of the token to revoke on a rotation (`""` first, `-g2` next). Rotate only. |

| `sshUser` | string | `sven` | Fleet-default SSH user. |
| `sshPort` | integer | `22` | Fleet-default SSH port. |
| `sshKey` | string | `~/.ssh/id_ed25519` | Fleet-default SSH private key path. |
| `strictHostKeyChecking` | string | `accept-new` | SSH `StrictHostKeyChecking` mode. |

The generic model `worker` must exist with `identity=figy` (and the default
`stagingDir`, `/tmp/swamp-worker-staging`).

## Examples

Create the generic model once, then deploy two hosts. This is the whole point:
one command enlists a set of hosts, and it is safe to run again to reconcile:

```sh
swamp model create @svendowideit/swamp-worker worker --global-arg identity=figy
swamp workflow run @figy/swamp-worker-bootstrap \
  --input serveUrl=wss://swamp.x1yoga.fi.gy \
  --input 'hosts=[{"name":"host1","address":"host1.lan"},{"name":"host2","address":"host2.lan"}]'
```

Deploy to a host reached on a non-standard SSH port with a specific key, then
check the worker's unit active on the node — useful while onboarding a new host:

```sh
swamp workflow run @figy/swamp-worker-bootstrap \
  --input serveUrl=wss://swamp.x1yoga.fi.gy \
  --input 'hosts=[{"name":"host3","address":"192.0.2.13"}]' \
  --input sshPort=2222 --input sshKey=~/.ssh/host3_ed25519
ssh -p 2222 -i ~/.ssh/host3_ed25519 sven@192.0.2.13 systemctl --user is-active swamp-worker-figy
```

Rotate the tokens before they expire — never stranding a worker. Run it on a
schedule with a new `generation` each time (the previous becomes `previousSuffix`):

```sh
swamp workflow run @figy/swamp-worker-rotate \
  --input serveUrl=wss://swamp.x1yoga.fi.gy \
  --input 'hosts=[{"name":"host1","address":"host1.lan"}]' \
  --input generation=2
```

Completely remove the deployed workers — the removal script runs on each node
and the tokens are revoked on the orchestrator, so nothing is left behind:

```sh
swamp workflow run @figy/swamp-worker-teardown \
  --input 'hosts=[{"name":"host1","address":"host1.lan"},{"name":"host2","address":"host2.lan"}]'
```

## Details

`@figy/swamp-worker` ships **no models or reports** — all behaviour lives in
`@svendowideit/swamp-worker` (script/token rendering) and `@swamp/ssh` (the SSH
transport). It ships three workflows, above. It installs nothing itself.

How the fan-out fits together:

- `renderProvision` (generic) renders the unit with the host label set to a node
  placeholder, and the provisioning script substitutes each node's own hostname
  at install time — so **one script serves every node** while each worker still
  advertises its real host.
- `mintToken` (generic) is called once per node (in a `forEach`, serialised) and
  writes each plaintext to `/tmp/swamp-worker-staging/<identity>-<node>.token`
  (`0600`); the secret never enters swamp data or a command line. It is
  per-target, so one node's mint cannot clobber another's file or record.
- `@swamp/ssh copy` moves each node its own token (the deterministic staging path
  is computed from the node name) to a fixed path on the node; the provisioning
  script installs it to `$HOME/.config/swamp-worker/figy.token` (`0600`), so the
  copy never needs to know the node user's home. `@swamp/ssh script` runs the
  provisioning script on every node, and it exits non-zero unless the unit is
  active (so there is no separate SSH "verify" step).
- `renderRemoval` (generic) renders the removal script with `$HOME`-portable
  paths; `@swamp/ssh script` runs it on every node; `revokeToken` revokes each
  node's token and drops its staging file.

### Developing and testing

```sh
# The suite proves the whole SSH deploy and teardown in one systemd container,
# using harness.sshd (an SSH server inside the harness as the "node"), with
# @swamp/ssh pulled as a declared dependency:
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/figy/swamp-worker/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

## License

MIT — see LICENSE.txt.
