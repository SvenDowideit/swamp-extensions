# @svendowideit/sudo

Run one privileged operation on the host — install a package, restart a system
service, set a sysctl — from any workflow, without writing `sudo` logic and
without assuming `sudo` is installed.

## What it does

`@svendowideit/sudo` is a cross-distro Linux elevation primitive for swamp. A
caller names an **operation** and its typed arguments; the model finds the first
elevation route the host has already granted and uses it. That may be `sudo`,
`doas`, polkit (`pkexec`/`run0`), `systemd-run`, an ssh root key, an
already-held capability, a container runtime you are a member of
(docker/podman/containerd), or a Kubernetes node. Callers do not need to know
which route wins — the result records the exit code, output, and uid — and the
route stays invisible unless an audit is explicitly requested.

It never brute-forces, prompts for a password, or exploits a vulnerability. A
route is usable only when the host has already granted it; otherwise the run
fails with a report of what was tried. Arbitrary commands go through a separate,
approval-gated workflow, so the everyday path — a named operation — is safe to
call from automated and scheduled workflows.

## Install

```sh
swamp extension pull @svendowideit/sudo
```

## Configuration

Global arguments (set with `swamp model create ... --global-arg`, or as model
attributes):

| Argument              | Type     | Default                                            | Meaning                                                                                                                                                                              |
| --------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `strategyOrder`       | string[] | side-effect-ordered ladder                         | Routes to try, in order.                                                                                                                                                             |
| `allowedOperations`   | string[] | `installPackage`, `removePackage`, `manageService` | Operations `run` may execute. The filesystem/account-mutating and kernel-knob operations (`sysctl`, `ensureDirectory`, `chown`, `addUserToGroup`, `createUser`, `mount`) are opt-in. |
| `allowArbitrary`      | boolean  | `false`                                            | Enable `request`/`runApproved`.                                                                                                                                                      |
| `sshHost`             | string   | `""`                                               | Host for the `ssh-root` route; empty disables it.                                                                                                                                    |
| `sshKnownHosts`       | string   | `""`                                               | Pinned known_hosts for `ssh-root`.                                                                                                                                                   |
| `containerImage`      | string   | pinned `alpine` digest                             | Image for the scratch-container and k8s routes.                                                                                                                                      |
| `containerNetwork`    | string   | `none`                                             | Network mode for scratch containers (`none`, `host`, `bridge`).                                                                                                                      |
| `k8sNode`             | string   | `""`                                               | Node for `k8s-node`; empty disables it.                                                                                                                                              |
| `ssmInstanceId`       | string   | `""`                                               | Target for the AWS SSM route; empty disables it.                                                                                                                                     |
| `timeoutSeconds`      | number   | `120`                                              | Per-execution timeout.                                                                                                                                                               |
| `probeTimeoutSeconds` | number   | `8`                                                | Per-route proof timeout. Side-effecting proofs get at least 120s.                                                                                                                    |
| `allowAudit`          | boolean  | `false`                                            | Emit read-only residual-risk findings.                                                                                                                                               |
| `approvalVault`       | string   | `sudo-approval`                                    | Vault that holds the run-scoped, single-use approval secret for the gated command path.                                                                                              |

Container routes are additionally disabled when `DOCKER_HOST` or
`CONTAINER_HOST` names a remote daemon (`ssh://`, `tcp://`, …): acting on
another host while the caller believes the operation ran locally is refused.

## Examples

```sh
# Restart a system service. The workflow picks whichever route this host
# already grants and runs systemctl restart for you.
swamp workflow run @svendowideit/sudo-run \
  --input operation=manageService \
  --input 'args:json={"unit":"caddy","action":"restart"}'

# Install a package with this host's package manager. One named operation,
# typed arguments, no shell string to get wrong.
swamp workflow run @svendowideit/sudo-run \
  --input operation=installPackage \
  --input 'args:json={"manager":"apt","packages":["caddy"]}'

# Read-only: list every elevation route this host offers and how it was proved.
# (It runs no target command; a container route may briefly start a container to
# prove itself.)
swamp model @svendowideit/sudo method run probe sudo-default

# Audit only: the same probe plus a hardening report (container group,
# sudoers, writable root paths, polkit/LXD).
swamp model @svendowideit/sudo method run probe sudo-default --input allowAudit=true

# Arbitrary command, approval-gated. Requires allowArbitrary=true on the model.
swamp workflow run @svendowideit/sudo-command \
  --input 'command:json=["id","-u"]' \
  --input reason="verify elevation works end to end"
```

## Details

### Models

`@svendowideit/sudo` — global arguments above. Methods:

| Method        | Arguments                                                           | Data      | Notes                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`       | `strategy` (default `auto`), `allowAudit?`                          | `probe`   | Enumerates the ladder and stops at the first proved route; never runs the target command, but _may_ start a transient privileged container/pod to prove a container route; **always succeeds** (so findings are reachable) with `winner: null` when nothing is granted. `audited` says whether findings were collected. |
| `run`         | `operation`, `args`, `strategy` (default `auto`), `timeoutSeconds?` | `result`  | Runs a named operation. A non-zero program exit is recorded, not thrown; only "no route" or "operation not allowed" throw.                                                                                                                                                                                              |
| `request`     | `command` (array), `reason`, `requestId?`                           | `request` | Records the exact argv under a request id (defaults to the run id when the workflow supplies it). Requires `allowArbitrary=true`.                                                                                                                                                                                       |
| `runApproved` | `command`, `requestId`, `approvalToken`                             | `result`  | Runs an arbitrary argv only if it exactly matches the recorded request and the token matches the run-scoped secret minted into the approval vault under the request id, then **consumes** the request and secret (single use). Requires `allowArbitrary=true`.                                                          |

Resources: `probe` and `result` (lifetime `infinite`), `request` (lifetime
`1d`).

### Workflows

- `@svendowideit/sudo-run` — the everyday ungated path: `run` a named operation
  (the method resolves and logs the ladder itself). Inputs: `operation`
  (required), `args`, `instanceKey`, `strategy`, `timeoutSeconds`.
- `@svendowideit/sudo-command` — the gated arbitrary path: `request` →
  `manual_approval` → `runApproved`. Inputs: `command` (required), `reason`
  (required), `instanceKey` (defaults to `${{ run.id }}`, so each run gets its
  own instance). The request id is the run id, so the approved argv cannot be
  swapped after registration, and a single approval runs once.

### Operations

Each operation turns typed arguments into an argv array — never a shell string.
The catalogue is in `sudo_operations.ts`. **Only the default set is enabled**;
the others must be added to `allowedOperations`.

| Operation         | Arguments                                               | Default | argv                                                                                                            |
| ----------------- | ------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `installPackage`  | `manager` (apt/dnf/yum/zypper/apk/pacman), `packages[]` | on      | e.g. `apt-get install -y caddy`                                                                                 |
| `removePackage`   | same                                                    | on      | e.g. `apt-get remove -y caddy`                                                                                  |
| `manageService`   | `unit`, `action` (start/stop/restart/enable/disable)    | on      | `systemctl <action> <unit>`                                                                                     |
| `sysctl`          | `key`, `value`                                          | opt-in  | `sysctl -w key=value` — writes an arbitrary kernel knob (a root persistence primitive), so opt in deliberately. |
| `ensureDirectory` | `path`, `mode`, `owner?`, `group?`                      | opt-in  | `install -d -m <mode> [-o owner] [-g group] <path>`                                                             |
| `chown`           | `path`, `owner`, `group`, `recursive?`                  | opt-in  | `chown [-R] owner:group path`                                                                                   |
| `addUserToGroup`  | `user`, `group`                                         | opt-in  | `usermod -aG group user`                                                                                        |
| `createUser`      | `user`, `comment?`, `group?`, `groups[]`                | opt-in  | `useradd --system [--comment c] [--gid g] [--groups g…] user`                                                   |
| `mount`           | `source`, `target`, `fstype?`, `options?`               | opt-in  | `mount [-t fstype] [-o options] source target`                                                                  |

### Strategies

The ladder is in `sudo_strategies.ts`.

| id            | Tool / grant               | Execution argv                                                                            | Notes                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sudo-n`      | `sudo` NOPASSWD/cached     | `sudo -n -- <argv>`                                                                       | `--` needs sudo ≥1.8. A cached sudo **timestamp** also proves the probe, so selection is time-dependent (succeeds ~15 min after any interactive sudo, and probing refreshes the cache); drop `sudo-n` from `strategyOrder` or pin another strategy for deterministic scheduling. |
| `doas-n`      | `doas` `permit nopass`     | `doas -n <argv>`                                                                          | doas takes no `--`.                                                                                                                                                                                                                                                              |
| `run0`        | systemd v256+ polkit       | `run0 --no-ask-password --pipe <program> <argv>`                                          | No `--`.                                                                                                                                                                                                                                                                         |
| `systemd-run` | polkit + system bus        | `systemd-run --system --uid=0 --pipe --wait <argv>`                                       | Works when `run0` is absent.                                                                                                                                                                                                                                                     |
| `pkexec`      | polkit                     | `pkexec --disable-internal-agent <program> <argv>`                                        | No `--`; an external agent can still prompt, so a prompt/timeout means unavailable.                                                                                                                                                                                              |
| `nsenter`     | held `CAP_SYS_ADMIN`       | `nsenter --target 1 --mount --uts --ipc --net --pid -- <argv>`                            |                                                                                                                                                                                                                                                                                  |
| `setpriv`     | held `CAP_SETUID`          | `setpriv --reuid=0 --regid=0 --clear-groups <argv>`                                       |                                                                                                                                                                                                                                                                                  |
| `ssh-root`    | root key + pinned host key | `ssh … root@<host> <shell-quoted command>`                                                | Class `remote`; local-only operations refuse it. Disabled unless `sshHost`.                                                                                                                                                                                                      |
| `docker-run`  | docker group               | `docker run --rm --privileged --pid=host --network=<mode> -v /:/host … chroot /host "$@"` | Proves host root via the host's `/etc/machine-id`; rootless rejected at probe; network defaults to `none`; refused when the daemon is remote.                                                                                                                                    |
| `podman-run`  | podman group (rootful)     | same shape with `podman`                                                                  | Rootless rejected at probe; refused when the daemon is remote.                                                                                                                                                                                                                   |
| `nerdctl-run` | containerd socket group    | same shape with `nerdctl`                                                                 | Rootless is not detected for `nerdctl`; the host-root probe still gates selection; refused when the daemon is remote.                                                                                                                                                            |
| `k8s-node`    | RBAC on nodes/pods         | `kubectl run … --overrides …` (runs `chroot /host <argv>`)                                | Disabled unless `k8sNode`; transient pod removed in-call.                                                                                                                                                                                                                        |
| `ssm-run`     | AWS SSM agent              | (multi-step; not implemented in the argv executor)                                        | Always unavailable; use `@swamp/aws/ssm`.                                                                                                                                                                                                                                        |

Container routes prove themselves by reading the host's `/etc/machine-id`
through the host mount — `id -u` inside a container proves only _container_
root, so it is not used.

### Residual-risk findings

With `allowAudit=true`, `probe` also emits read-only findings (never executed as
root): `risk-container-group`, `risk-sudoers` (and a distinct "could not read
policy" result), `risk-writable-paths`, `risk-polkit-lxd`. These never change
the chosen route and never run a privileged command.

### Gated arbitrary commands

Before the first gated run, create the approval vault (referenced by the
`approvalVault` global, default `sudo-approval`):

```sh
# One-time: the vault the gate mints the run-scoped approval secret into.
swamp vault create local_encryption sudo-approval
```

`request` records the exact argv array under a request id; `runApproved` refuses
unless the supplied argv is byte-for-byte equal to what was recorded and the
approval token matches the run-scoped secret minted for that request, then
deletes the request and the secret so a single approval authorises exactly one
execution. The caller cannot run an unregistered command. The secret is minted
at the `manual_approval` gate into the `sudo-approval` vault under the request
id (the workflow run id), and is single-use by construction: at the gate, run
`swamp vault put sudo-approval <run-id> "<random>"` and let the operator resume.
A static, reusable token is deliberately not supported.

**Security properties and residual risk:**

- The approval token is passed as a method argument (`vault.get(...)` in
  `sudo-command.yaml`), and **swamp records method arguments verbatim** — so the
  token sits in plaintext in the run snapshot
  (`.swamp/workflows-evaluated/
  runs/<run-id>/`). Treat repo access as
  approval-equivalent: anyone who can read run history and resume a run holds
  the same power as the approver.
- **Single use applies to completed runs only.** The request record and secret
  are consumed _after_ execution, so a run killed mid-execution (or one that
  fails during elevation) leaves the request record, the minted secret, and the
  token in place — the approved command is replayable until they are cleaned up.
  After a killed or failed gated run, delete both:
  `swamp vault delete
  sudo-approval <run-id>` (the request record expires with
  its `1d` lifetime).
- A failed _elevation_ does not consume the approval: retrying the resumed run
  with the same token works, by design (the operator approved that argv once).

### Concurrency

Pass a unique `instanceKey` (e.g. `instanceKey: "${{ run.id }}"`) so the model
instance is `sudo-<key>` and concurrent callers do not collide on swamp's
per-model lock or overwrite each other's `result`/`probe` data. `sudo-run`
defaults to `default` (benign for `result` data since each write overwrites the
last result); `sudo-command` defaults to `${{ run.id }}` because gated callers
must never share an instance: the `request` resource uses one stable name per
instance, so two concurrent gated runs on the same `instanceKey` would clobber
each other's pending request (and then fail closed on the request-id mismatch).

### Forbidden mechanisms

There is no brute force, no interactive password capture or askpass helper that
answers a prompt, no CVE payload, and no elevation through a discovered writable
root-owned file. A route that needs an interactive password is treated as
unavailable.

### Extending

- Add an operation: append to `OPERATIONS` in `sudo_operations.ts` with a zod
  args schema and an argv builder; it becomes available only if listed in
  `allowedOperations` (the default is the narrow set).
- Add a strategy: append to `STRATEGIES` in `sudo_strategies.ts` with
  `precondition`, `probeArgv`, `probeOk`, `build`, and `elevationFailed`; add
  its id to `DEFAULT_STRATEGY_ORDER`. A route that targets another host must use
  class `remote`; a route with an optional rootless daemon should provide
  `rootless`. Add `containerPrecondition` to a route that runs through a
  container daemon so a remote `DOCKER_HOST` is refused.
- Keep both modules pure (no I/O) so they stay unit-testable.

### Testing

```sh
# The full suite; the two integration tests are skipped without --allow-run/env.
~/.swamp/deno/deno test extensions/models/sudo/
# Run including the real timeout and single-use tests.
~/.swamp/deno/deno test --allow-run --allow-env --allow-read --allow-sys \
  extensions/models/sudo/
~/.swamp/deno/deno check extensions/models/sudo/sudo.ts \
  extensions/models/sudo/sudo_strategies.ts extensions/models/sudo/sudo_operations.ts
```

The `*_test.ts` files cover argv builders, shell quoting, injection rejection,
rootless and remote-daemon detection, route-resolution short-circuiting, proof
timeouts, request/approve binding and single-use consumption, output capping,
and operation gating. The tests inject a `_exec` process runner on the method
context (never through method arguments, so the published schema is unchanged)
so route resolution and the gate can be tested without touching the host.

### Caveats

- **Which host does the operation run on?** The resolved route decides. `local`,
  `capability`, and `container` routes act on the machine swamp runs on. But
  when a **non-local** operation (`installPackage`, `removePackage`,
  `manageService`, `sysctl` are not `localOnly`) resolves to a remote-capable
  route, it executes **on the route's target, not on your host**: with `sshHost`
  configured, `manageService caddy restart` restarts caddy on the ssh host; with
  `k8sNode` set, the operation acts on that cluster node. To keep operations
  strictly local, omit `sshHost` and `k8sNode`, or pin `strategy` to a local
  route (e.g. `sudo-n`). Filesystem/account operations (`ensureDirectory`,
  `chown`, `addUserToGroup`, `createUser`, `mount`) are `localOnly` and already
  refuse remote/orchestrator routes.
- `ensureDirectory`, `chown`, `addUserToGroup`, `createUser`, and `mount` are
  **local-route only** — they are refused when the only available route is a
  remote/orchestrator/oob one. `ssh-root` is classed `remote` and `k8s-node`
  `orchestrator`, so both are excluded; container routes run on the host through
  `chroot /host` and _are_ allowed.
- `ssh-root` needs a pinned `sshKnownHosts` (or a pre-populated known_hosts) or
  host-key verification fails closed.
- The k8s/container/ssh routes are disabled until configured (`k8sNode`,
  `sshHost`).
- The container routes need network only if the operation does; set
  `containerNetwork=host` for `installPackage`, which defaults to `none`.
- Secrets must not appear in `command`/`args`: swamp records arguments verbatim.
  Reference secrets with `vault.get(...)` inside a step instead.
