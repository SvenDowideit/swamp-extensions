# @svendowideit/sudo

Run one privileged operation on the host — install a package, restart a system
service, set a sysctl — from any workflow, without writing `sudo` logic and
without assuming `sudo` is installed.

## What it does

`@svendowideit/sudo` is a cross-platform elevation primitive for swamp. A caller
names an **operation** and its typed arguments; the model finds the first
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

| Argument | Type | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `strategyOrder` | string[] | side-effect-ordered ladder | Routes to try, in order. |
| `allowedOperations` | string[] | `installPackage`, `removePackage`, `manageService`, `sysctl` | Operations `run` may execute. The filesystem/account-mutating operations are opt-in. |
| `allowArbitrary` | boolean | `false` | Enable `request`/`runApproved`. |
| `sshHost` | string | `""` | Host for the `ssh-root` route; empty disables it. |
| `sshKnownHosts` | string | `""` | Pinned known_hosts for `ssh-root`. |
| `containerImage` | string | pinned `alpine` digest | Image for the scratch-container and k8s routes. |
| `containerNetwork` | string | `none` | Network mode for scratch containers (`none`, `host`, `bridge`). |
| `k8sNode` | string | `""` | Node for `k8s-node`; empty disables it. |
| `ssmInstanceId` | string | `""` | Target for the AWS SSM route; empty disables it. |
| `timeoutSeconds` | number | `120` | Per-execution timeout. |
| `probeTimeoutSeconds` | number | `8` | Per-route proof timeout. Side-effecting proofs get at least 120s. |
| `allowAudit` | boolean | `false` | Emit read-only residual-risk findings. |

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

# Read-only: list every elevation route this host offers and how it was proved,
# without running any privileged command.
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

| Method | Arguments | Data | Notes |
| ------ | --------- | ---- | ----- |
| `probe` | `strategy` (default `auto`), `allowAudit?` | `probe` | Enumerates the ladder and stops at the first proved route; never runs the target command; **always succeeds** (so findings are reachable) with `winner: null` when nothing is granted. `audited` says whether findings were collected. |
| `run` | `operation`, `args`, `strategy` (default `auto`), `timeoutSeconds?` | `result` | Runs a named operation. A non-zero program exit is recorded, not thrown; only "no route" or "operation not allowed" throw. |
| `request` | `command` (array), `reason`, `requestId?` | `request` | Records the exact argv under a request id (defaults to the run id when the workflow supplies it). Requires `allowArbitrary=true`. |
| `runApproved` | `command`, `requestId`, `approvalToken` | `result` | Runs an arbitrary argv only if it exactly matches the recorded request and the token matches `SWAMP_SUDO_APPROVAL_TOKEN`. Requires `allowArbitrary=true`. |

Resources: `probe`, `result`, and `request` (lifetime `1d`).

### Workflows

- `@svendowideit/sudo-run` — the everyday ungated path: `probe` then `run` a
  named operation. Inputs: `operation` (required), `args`, `instanceKey`,
  `strategy`, `timeoutSeconds`.
- `@svendowideit/sudo-command` — the gated arbitrary path: `request` →
  `manual_approval` → `runApproved`. Inputs: `command` (required), `reason`
  (required), `instanceKey`. The request id is the run id, so the approved argv
  cannot be swapped after registration.

### Operations

Each operation turns typed arguments into an argv array — never a shell string.
The catalogue is in `sudo_operations.ts`. **Only the default set is enabled**;
the others must be added to `allowedOperations`.

| Operation | Arguments | Default | argv |
| --------- | --------- | ------- | ---- |
| `installPackage` | `manager` (apt/dnf/yum/zypper/apk/pacman), `packages[]` | on | e.g. `apt-get install -y caddy` |
| `removePackage` | same | on | e.g. `apt-get remove -y caddy` |
| `manageService` | `unit`, `action` (start/stop/restart/enable/disable) | on | `systemctl <action> <unit>` |
| `sysctl` | `key`, `value` | on | `sysctl -w key=value` |
| `ensureDirectory` | `path`, `mode`, `owner?`, `group?` | opt-in | `install -d -m <mode> [-o owner] [-g group] <path>` |
| `chown` | `path`, `owner`, `group`, `recursive?` | opt-in | `chown [-R] owner:group path` |
| `addUserToGroup` | `user`, `group` | opt-in | `usermod -aG group user` |
| `createUser` | `user`, `comment?`, `group?`, `groups[]` | opt-in | `useradd --system [--comment c] [--gid g] [--groups g…] user` |
| `mount` | `source`, `target`, `fstype?`, `options?` | opt-in | `mount [-t fstype] [-o options] source target` |

### Strategies

The ladder is in `sudo_strategies.ts`.

| id | Tool / grant | Execution argv | Notes |
| -- | ------------ | -------------- | ----- |
| `sudo-n` | `sudo` NOPASSWD/cached | `sudo -n -- <argv>` | `--` needs sudo ≥1.8. |
| `doas-n` | `doas` `permit nopass` | `doas -n <argv>` | doas takes no `--`. |
| `run0` | systemd v256+ polkit | `run0 --no-ask-password --pipe <program> <argv>` | No `--`. |
| `systemd-run` | polkit + system bus | `systemd-run --system --uid=0 --pipe --wait <argv>` | Works when `run0` is absent. |
| `pkexec` | polkit | `pkexec --disable-internal-agent <program> <argv>` | No `--`; an external agent can still prompt, so a prompt/timeout means unavailable. |
| `nsenter` | held `CAP_SYS_ADMIN` | `nsenter --target 1 --mount --uts --ipc --net --pid -- <argv>` | |
| `setpriv` | held `CAP_SETUID` | `setpriv --reuid=0 --regid=0 --clear-groups <argv>` | |
| `ssh-root` | root key + pinned host key | `ssh … root@<host> <shell-quoted command>` | Class `remote`; local-only operations refuse it. Disabled unless `sshHost`. |
| `docker-run` | docker group | `docker run --rm --privileged --pid=host --network=<mode> -v /:/host … chroot /host "$@"` | Proves host root via the host's `/etc/machine-id`; rootless rejected at probe; network defaults to `none`. |
| `podman-run` | podman group (rootful) | same shape with `podman` | Rootless rejected at probe. |
| `nerdctl-run` | containerd socket group | same shape with `nerdctl` | Rootless is not detected for `nerdctl`; the host-root probe still gates selection. |
| `k8s-node` | RBAC on nodes/pods | `kubectl run … --overrides …` (runs `chroot /host <argv>`) | Disabled unless `k8sNode`; transient pod removed in-call. |
| `ssm-run` | AWS SSM agent | (multi-step; not implemented in the argv executor) | Always unavailable; use `@swamp/aws/ssm`. |

Container routes prove themselves by reading the host's `/etc/machine-id`
through the host mount — `id -u` inside a container proves only *container*
root, so it is not used.

### Residual-risk findings

With `allowAudit=true`, `probe` also emits read-only findings (never executed as
root): `risk-container-group`, `risk-sudoers` (and a distinct "could not read
policy" result), `risk-writable-paths`, `risk-polkit-lxd`. These never change the
chosen route and never run a privileged command.

### Gated arbitrary commands

`request` records the exact argv array under a request id; `runApproved` refuses
unless the supplied argv is byte-for-byte equal to what was recorded and the
approval token matches. The caller cannot run an unregistered command. The token
is read from `SWAMP_SUDO_APPROVAL_TOKEN` in the operator environment; put the
same value in the `sudo-approval` vault as `token` for the bundled workflow to
supply it. Prefer a run-scoped, rotated value over a long-lived one.

### Concurrency

Pass a unique `instanceKey` (e.g. `instanceKey: "${{ run.id }}"`) so the model
instance is `sudo-<key>` and concurrent callers do not collide on swamp's
per-model lock or overwrite each other's `result`/`probe` data. Gated callers
must do so: the `request` resource uses one stable name per instance, so two
concurrent gated runs on the same `instanceKey` would clobber each other's
pending request (and then fail closed on the request-id mismatch).

### Forbidden mechanisms

There is no brute force, no interactive password capture or askpass helper that
answers a prompt, no CVE payload, and no elevation through a discovered
writable root-owned file. A route that needs an interactive password is treated
as unavailable.

### Extending

- Add an operation: append to `OPERATIONS` in `sudo_operations.ts` with a zod
  args schema and an argv builder; it becomes available only if listed in
  `allowedOperations` (the default is the narrow set).
- Add a strategy: append to `STRATEGIES` in `sudo_strategies.ts` with
  `precondition`, `probeArgv`, `probeOk`, `build`, and `elevationFailed`; add its
  id to `DEFAULT_STRATEGY_ORDER`. A route that targets another host must use
  class `remote`; a route with an optional rootless daemon should provide
  `rootless`.
- Keep both modules pure (no I/O) so they stay unit-testable.

### Testing

```sh
~/.swamp/deno/deno test extensions/models/sudo/
~/.swamp/deno/deno check extensions/models/sudo/sudo.ts \
  extensions/models/sudo/sudo_strategies.ts extensions/models/sudo/sudo_operations.ts
```

The `*_test.ts` files cover argv builders, shell quoting, injection rejection,
rootless detection, proof timeouts, request/approve binding, output capping, and
operation gating.

### Caveats

- `ensureDirectory`, `chown`, `addUserToGroup`, `createUser`, and `mount` are
  **local-route only** — they are refused when the only available route is a
  remote/orchestrator/oob one. `ssh-root` is classed `remote`, so it is excluded
  from those operations.
- `ssh-root` needs a pinned `sshKnownHosts` (or a pre-populated known_hosts) or
  host-key verification fails closed.
- The k8s/container/ssh routes are disabled until configured (`k8sNode`,
  `sshHost`).
- The container routes need network only if the operation does; set
  `containerNetwork=host` for `installPackage`, which defaults to `none`.
- Secrets must not appear in `command`/`args`: swamp records arguments verbatim.
  Reference secrets with `vault.get(...)` inside a step instead.
