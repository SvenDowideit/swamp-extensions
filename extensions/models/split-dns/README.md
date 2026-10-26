# @svendowideit/split-dns

Split-horizon DNS for Debian, Ubuntu and NixOS: keep the nameservers learned
from DHCP for the whole host, but send selected zones to faster-updating
nameservers.

## What it does

The extension installs a small managed `dnsmasq` forwarder on a loopback
address and points the host's client resolver at it. dnsmasq forwards
everything to the DHCP-provided DNS — read live from systemd-resolved's
upstream `resolv.conf` or NetworkManager's `/run/NetworkManager/resolv.conf`,
or captured from `/etc/resolv.conf`, `resolvectl` or `nmcli` — and adds
`server=/<zone>/<ns>` rules for the zones you name. You can give the
nameservers explicitly, or let the extension discover the zone's authoritative
NS records.

Privilege is delegated to `@svendowideit/sudo`. The model stages an apply
script, a rollback script and a verification gate in an unprivileged directory;
the workflow runs the apply script through the sudo extension's `runScript`
operation. That means the extension uses whichever route the host has already
granted (sudo/doas, polkit/run0/systemd-run, a container runtime group, or a
held capability) and never writes a raw sudo invocation of its own. The staged
apply script validates before activation, verifies the live zone and a control
name after activation, and restores the pre-apply snapshot if anything fails.

The workflows are **host-local**: run them on the machine being configured, or
use the matching `-worker` variant to dispatch every step to that machine's
swamp worker. That is what lets the sudo extension elevate on the target host
rather than on the orchestrator.

Supported resolver layouts:

| Host | Client resolver management | Upstream source |
| ---- | -------------------------- | --------------- |
| Ubuntu / Debian + NetworkManager | `rc-manager=unmanaged` + static `/etc/resolv.conf` | `/run/systemd/resolve/resolv.conf`, else `/run/NetworkManager/resolv.conf`, `/etc/resolv.conf`, `resolvectl` or `nmcli` |
| Debian + resolvconf | `/etc/resolvconf/resolv.conf.d/head` + `resolvconf -u` | same |
| NixOS | generated NixOS module forces `resolv.conf` to loopback | `/run/systemd/resolve/resolv.conf`, else `/run/NetworkManager/resolv.conf` or captured DHCP view |

## Install

```sh
swamp extension pull @svendowideit/split-dns
```

One pull installs the model, all six workflows (the three host-local workflows
plus their worker variants), the README and the tests.
`@svendowideit/sudo` is pulled automatically as a dependency.

## Configuration

Global arguments (set at model creation with `--global-arg`, or per run with
`--input`):

| Argument | Type | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `hosts` | array | `[]` (local) | Targets for the read-only `plan`/`status` fan-out: `local`, `[user@]host[:port]`, or `{name,address,user,port,local}` |
| `sshUser` | string | current user | Default SSH user for read-only host entries |
| `identityFile` | string | `""` | SSH identity file for read-only host entries |
| `connectTimeoutSec` | integer | `10` | SSH connect timeout |
| `commandTimeoutSec` | integer | `600` | Per-command timeout |
| `parallel` | integer | `4` | Hosts processed at once by `plan`/`status` |
| `stagingDir` | string | `~/.cache/split-dns` | Unprivileged directory for apply/remove scripts |
| `configDir` | string | `/etc/split-dns` | Managed config, state, original snapshot and backups |
| `listenAddress` | string | `127.0.0.1` | Loopback address dnsmasq listens on |
| `listenPort` | integer | `53` | dnsmasq port; must be 53 when `manageResolver=true` |
| `manageResolver` | boolean | `true` | Point the host resolver at the forwarder |
| `installPackages` | boolean | `true` | apt-install `dnsmasq-base` and `bind9-dnsutils` when missing |
| `controlName` | string | `github.com` | Name outside the zone proving normal DNS still works |
| `testName` | string | `""` | Optional FQDN inside the zone for verification |
| `nixosRebuild` | boolean | `true` | Run `nixosRebuildCommand` on NixOS |
| `nixosRebuildCommand` | string | `nixos-rebuild switch -I nixos-config=/etc/nixos/split-dns-configuration.nix` | Activation command; override for flakes |
| `dnsmasqBinary` | string | `""` | Explicit dnsmasq path; empty auto-detects |
| `backupKeep` | integer | `5` | Pre-apply snapshots retained for diagnostics |

Apply workflow arguments add `zone`, `nameservers`, `replaceZones`,
`removeZone`, `sudoModel` (default `sudo-split-dns`), `sudoTimeoutSeconds`,
`stagingDir`, `runId` (used by `stage`), `testName`, `controlName` and
`dryRun`. The `-worker` variants add a `worker` input (default `figy-blue`) and
dispatch every step to it. `merge` is the default:
running once per zone accumulates exceptions. `replaceZones=true` starts from
an empty set. `removeZone=true` removes only that zone; the apply workflow then
skips its configured-zone check and the staged apply gate verifies a remaining
zone (or only the control name when none remain). When
`manageResolver=true`, `listenPort` must be 53 because `/etc/resolv.conf`
cannot carry a port; use `manageResolver=false` for a high-port test forwarder.
A zone nameserver equal to `listenAddress` at port 53 is rejected because
dnsmasq would forward the zone to itself.

## Examples

Run the apply workflow on the host being configured. It plans, stages and then
lets `@svendowideit/sudo` run the staged apply script as root:

```sh
# Configure fi.gy on this host using its authoritative nameservers.
swamp workflow run @svendowideit/split-dns-apply --input zone=fi.gy
```

Dispatch the same host-local workflow to blue's swamp worker from the
orchestrator. The staging and sudo steps both run on blue, so the sudo ladder is
evaluated there:

```sh
# Configure fi.gy on blue through its figy-blue worker.
swamp workflow run @svendowideit/split-dns-apply-worker \
  --server wss://swamp.x1yoga.fi.gy \
  --input worker=figy-blue \
  --input zone=fi.gy
```

On t440s, install this extension in t440s's own swamp repo
(`swamp extension pull @svendowideit/split-dns` after publishing) and run the
local workflow there; its repo already has `@svendowideit/sudo`. Alternatively,
enrol t440s as a worker and use the `split-dns-apply-worker` form above. Either
way the elevation happens on t440s.

Route a delegated sub-zone to a specific provider instead of discovering its
NS records:

```sh
# Pin dev.fi.gy to specific authoritative nameservers.
swamp workflow run @svendowideit/split-dns-apply \
  --input zone=dev.fi.gy \
  --input 'nameservers:json=["ns-164-a.gandi.net","ns-22-b.gandi.net"]'
```

Plan and stage without running the privileged step:

```sh
# Preflight only: render, dnsmasq --test, transient queries, staged scripts.
swamp workflow run @svendowideit/split-dns-apply --input dryRun=true
```

Read-only fleet preflight and status use the model's `hosts` global (the repo
model `split-dns` already lists x1yoga, t440s and blue):

```sh
# Read-only preflight of every host in the split-dns model.
swamp model method run split-dns plan --input zone=fi.gy

# Report managed zones, upstream, unit state and live queries per host.
swamp model method run split-dns status
```

Remove the forwarder and restore the pre-install resolver snapshot. The staged
remove script only deletes `configDir` when it contains nothing but the files
this extension manages, so a mistaken `configDir` cannot wipe an unrelated
directory:

```sh
# Stage, elevate through @svendowideit/sudo, and verify normal DNS answers.
swamp workflow run @svendowideit/split-dns-remove

# The same removal on a worker-dispatched host (e.g. blue).
swamp workflow run @svendowideit/split-dns-remove-worker \
  --server wss://swamp.x1yoga.fi.gy \
  --input worker=figy-blue
```

## Upgrade

After updating the extension, run the single upgrade workflow on each host, or
use the worker variant for a worker-dispatched host:

```sh
swamp workflow run @svendowideit/split-dns-upgrade

swamp workflow run @svendowideit/split-dns-upgrade-worker \
  --server wss://swamp.x1yoga.fi.gy \
  --input worker=figy-blue
```

It re-runs the host-local stage with no zone, which reconciles every zone
already stored on that host. The model's lazy `typeVersion` upgrade runs on the
first method call, so the new code is active before the reconcile. It refreshes
the DHCP-derived upstream view, stages the scripts, runs the apply, and verifies
the live queries. The apply is a no-op when nothing changed and re-applies when
the live verify gate finds drift. It is safe to re-run.

The default model instance is `split-dns` (auto-registered on first use). If the
repo has more than one split-DNS model, `swamp behavior list` lists them and
`--input model=<name>` selects one; the workflow never needs a model name for
the normal single-model case.

## Details

### Models and methods

Model `@svendowideit/split-dns`:

- `plan` — read-only. Accepts the `hosts` fan-out, inspects each host,
  discovers the zone's authoritative NS when `nameservers` is empty, renders
  the dnsmasq config, runs `dnsmasq --test`, and queries a temporary resolver
  on a high port.
- `stage` — host-local, unprivileged. Builds the plan for this host and writes
  `apply.sh`, `rollback.sh`, `remove.sh` and `verify.sh` into `stagingDir`, plus
  a `staged` resource with their paths and the `changed` flag.
- `stageRemove` — host-local, unprivileged. Writes `remove.sh` and its
  verification gate into `stagingDir`.
- `verify` — host-local, read-only. Runs after the sudo step and checks the
  live resolver. `expect=configured` proves the managed zone is present and
  resolves; `expect=removed` proves the service and generated files are gone
  and the control name still answers.
- `status` — read-only. Accepts the `hosts` fan-out and reports configured
  zones, upstream, service and live queries.

Resources:

- `hostResult` — one record per host: OS, resolver mode, managed zones,
  nameservers, upstream source, changed flag, validation checks and rollback
  outcome.
- `summary` — per-run counts and the error list.
- `staged` — this run's staging directory, script paths, `changed` flag and
  plan warnings. The workflow hands `applyScript` / `removeScript` to
  `@svendowideit/sudo`.

### How privilege and rollback work

1. **Plan.** The zone is normalised, explicit nameservers are resolved (or the
   zone's NS set is discovered and resolved), and the desired config is
   rendered.
2. **Preflight.** `dnsmasq --test` validates syntax. A temporary dnsmasq on a
   random high port answers the zone's SOA (or `testName`) and the control
   name before anything is changed.
3. **Stage.** The apply, rollback, remove and verification scripts are written
   into `~/.cache/split-dns/<run>/`. The first install keeps an immutable
   pre-install snapshot in `/etc/split-dns/original`; every apply keeps a
   timestamped pre-apply snapshot in `/etc/split-dns/backups/<timestamp>`.
   Staging needs no root.
4. **Elevate.** The workflow calls `@svendowideit/sudo`'s `run` method with
   `operation=runScript`, `args={script: <staged apply.sh>}` and
   `allowedOperations=["runScript"]`. The sudo extension probes its ladder and
   runs the script through the first route the host already grants. It never
   prompts for a password.
5. **Activate and verify.** The sudo model is configured with
   `containerNetwork: host` so the container route can run apt/dig. The script
   writes the config/state/unit (or NixOS module) atomically, starts the
   service, points the client resolver at it, and runs the staged verification
   gate. The gate checks the active unit,
   `dnsmasq --test`, local zone/control queries and system resolver queries
   (using `dig`, then `resolvectl`, then `getent`). If anything fails, the
   script runs the staged rollback script and exits nonzero with the failing
   output.
6. **Report.** The workflow's `verify` step re-checks the live resolver and
   fails the run with the exact query output if the host did not converge. A
   failed rollback is called out explicitly.

### Host-local orchestration and the fleet

`@svendowideit/sudo` elevates on the host where swamp runs. The workflow
therefore stages and elevates on the same host:

- **x1yoga** — run `split-dns-apply` locally. Its sudo ladder selects
  `docker-run` (the user is in the docker group), so no password is needed.
- **t440s** — run the workflow through t440s's own swamp serve (its repo has
  `@svendowideit/sudo`), or enrol it as a worker and use
  `split-dns-apply-worker --server ... --input worker=<name>`. Its ladder also
  selects `docker-run`.
- **blue** — dispatch to the `figy-blue` worker. At the time of writing blue's
  probe found no granted route: `sudo -n` asked for a password, `run0` and
  `systemd-run` required interactive authentication, no `doas`/`docker`/`podman`
  was installed, and the worker user is not in a container-runtime group. The
  apply step fails with that ladder. Grant blue one route (passwordless sudo
  for the specific run, a container runtime group, or `doas`) and re-run.

The read-only `plan`/`status` methods still fan out over SSH for a single
fleet-wide preflight, because they need no privilege.

### NixOS

The module at `/etc/nixos/split-dns.nix` runs dnsmasq from `pkgs.dnsmasq`,
forces `environment.etc."resolv.conf"` to the loopback nameserver, sets
`networking.resolvconf.enable = false` (required by NixOS when another file
owns resolv.conf), and adds `pkgs.dnsmasq` plus `pkgs.bind.dnsutils` to
`environment.systemPackages`. `/etc/nixos/split-dns-configuration.nix` imports
the host's normal `configuration.nix` plus that module, so the model does not
edit the user's configuration. The staged scripts export a NixOS `PATH`
(`/run/current-system/sw/bin`, `/run/wrappers/bin`) and a fallback `NIX_PATH`
pointing at the root channel, so `nixos-rebuild` works from the container
elevation route. The staged apply script runs `nixosRebuildCommand`;
the staged remove script builds a rollback wrapper that imports only the
original configuration. On a flakes-based host, override
`nixosRebuildCommand`, for example `nixos-rebuild switch --flake /etc/nixos#host`,
and make the flake's configuration import the generated
`/etc/nixos/split-dns.nix`; overriding the command alone does not add that
import.

The generated module keeps `services.resolved` enabled when it is already
enabled, so `/run/systemd/resolve/resolv.conf` can remain the live DHCP
upstream. On a NixOS host without resolved, provide the upstream through
`/run/NetworkManager/resolv.conf` or the captured `/etc/resolv.conf` view.

### Extending and testing

The pure helpers — zone normalisation, host parsing, resolv.conf and resolver
parsing, zone merging, config rendering, state fingerprints and the section
protocol — are exported from `split_dns.ts` and covered by
`split_dns_test.ts`. The staged shell scripts are exported as
`renderApplyScript`, `renderRollbackScript` and `renderRemoveScript` so the
test suite can syntax-check them with `sh -n`.

```sh
# Unit tests (the syntax test uses sh, so allow --run).
~/.swamp/deno/deno test --allow-run extensions/models/split-dns/split_dns_test.ts

# Type-check and slow-type lint.
~/.swamp/deno/deno check extensions/models/split-dns/split_dns.ts
~/.swamp/deno/deno doc --lint extensions/models/split-dns/split_dns.ts
```

To add a resolver layout, extend `resolveMode`, the inspect script's sections,
and `computeChanged`; the activation script branches on the mode. To change
the dnsmasq policy, edit `renderDnsmasqConfig`. The privileged seam is the
`runScript` operation and the workflow's `elevate` step; keep it as a workflow
step so worker placement runs it on the target.
