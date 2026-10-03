# @svendowideit/sudo

Run one privileged operation on the host — install a package, restart a system
service, write a file under `/etc`, add a user to a group — from any workflow,
without writing `sudo` logic and without assuming `sudo` is installed.

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
| `allowedOperations` | string[] | full catalogue | Operations `run` may execute. |
| `allowArbitrary` | boolean | `false` | Enable `request`/`runApproved`. |
| `sshHost` | string | `""` | Host for the `ssh-root` route; empty disables it. |
| `sshKnownHosts` | string | `""` | Pinned known_hosts for `ssh-root`. |
| `containerImage` | string | `alpine:3.20` | Image for scratch-container and k8s routes; pin by digest. |
| `containerName` | string | `""` | Host-root-equivalent container for `docker-exec`. |
| `k8sNode` | string | `""` | Node for `k8s-node`; empty disables it. |
| `ssmInstanceId` | string | `""` | Target for the AWS SSM route; empty disables it. |
| `timeoutSeconds` | number | `120` | Per-execution timeout. |
| `probeTimeoutSeconds` | number | `8` | Per-route proof timeout. |
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
| `probe` | `strategy` (default `auto`), `allowAudit?`, `force` (default `false`) | `probe` | Enumerates the ladder; never runs the target command; **always succeeds** (so findings are reachable) with `winner: null` when nothing is granted. |
| `run` | `operation`, `args`, `strategy` (default `auto`), `timeoutSeconds?`, `allowAudit?` | `result` | Runs a named operation. A non-zero program exit is recorded, not thrown; only "no route" or "operation not allowed" throw. |
| `request` | `command` (array), `reason` | `request` | Mints a nonce over the argv+reason. Requires `allowArbitrary=true`. |
| `runApproved` | `command`, `reason`, `nonce`, `approvalToken` | `result` | Runs an arbitrary argv only if the token matches `SWAMP_SUDO_APPROVAL_TOKEN` and the argv+reason still hash to the nonce. Requires `allowArbitrary=true`. |

Resources: `probe`, `result`, and `request` (lifetime `1d`).

### Workflows

- `@svendowideit/sudo-run` — the everyday ungated path: `probe` then `run` a
  named operation. Inputs: `operation` (required), `args`, `instanceKey`,
  `strategy`, `timeoutSeconds`, `allowAudit`.
- `@svendowideit/sudo-command` — the gated arbitrary path: `request` →
  `manual_approval` → `runApproved`. Inputs: `command` (required), `reason`
  (required), `instanceKey`.

### Operations

Each operation turns typed arguments into an argv array — never a shell string.
The catalogue is in `sudo_operations.ts`; `allowedOperations` restricts what
`run` may execute.

| Operation | Arguments | argv |
| --------- | --------- | ---- |
| `installPackage` | `manager` (apt/dnf/yum/zypper/apk/pacman), `packages[]` | e.g. `apt-get install -y caddy` |
| `removePackage` | same | e.g. `apt-get remove -y caddy` |
| `manageService` | `unit`, `action` (start/stop/restart/enable/disable) | `systemctl <action> <unit>` |
| `ensureDirectory` | `path`, `mode`, `owner?`, `group?` | `install -d -m <mode> [-o owner] [-g group] <path>` |
| `chown` | `path`, `owner`, `group`, `recursive?` | `chown [-R] owner:group path` |
| `addUserToGroup` | `user`, `group` | `usermod -aG group user` |
| `sysctl` | `key`, `value` | `sysctl -w key=value` |
| `mount` | `source`, `target`, `fstype?`, `options?` | `mount [-t fstype] [-o options] source target` |
| `writeFile` | `path`, `content`, `mode` | stages a temp file and `install -m <mode> <tmp> <path>` (local routes only) |

### Strategies

The ladder is in `sudo_strategies.ts`. Lower `proveCost` runs earlier when side
effects tie.

| id | Tool / grant | Execution argv | Notes |
| -- | ------------ | -------------- | ----- |
| `sudo-n` | `sudo` NOPASSWD/cached | `sudo -n -- <argv>` | `--` needs sudo ≥1.8. |
| `doas-n` | `doas` `permit nopass` | `doas -n <argv>` | doas takes no `--`. |
| `run0` | systemd v256+ polkit | `run0 --no-ask-password --pipe <program> <argv>` | No `--`. |
| `systemd-run` | polkit + system bus | `systemd-run --system --uid=0 --pipe --wait <argv>` | Works when `run0` is absent. |
| `pkexec` | polkit | `pkexec --disable-internal-agent <program> <argv>` | No `--`; an external agent can still prompt, so a prompt/timeout means unavailable. |
| `nsenter` | held `CAP_SYS_ADMIN` | `nsenter --target 1 --mount --uts --ipc --net --pid -- <argv>` | |
| `setpriv` | held `CAP_SETUID` | `setpriv --reuid=0 --regid=0 --clear-groups <argv>` | |
| `ssh-root` | root key + pinned host key | `ssh … root@<host> <shell-quoted command>` | No `--`; ssh stops option parsing at the hostname. Disabled unless `sshHost`. |
| `docker-exec` | docker group + privileged container | `docker exec -u 0 <container> <argv>` | Disabled unless `containerName`; only host-root if that container is privileged. |
| `docker-run` | docker group | `docker run --rm --privileged --pid=host --net=host -v /:/host … chroot /host "$@"` | Digest-pin `containerImage`; `--rm`; argv passed positionally. Rootless is rejected at probe. |
| `podman-run` | podman group (rootful) | same shape with `podman` | Rootless is rejected at probe. |
| `nerdctl-run` | containerd socket group | same shape with `nerdctl` | Rootless is rejected at probe. |
| `k8s-node` | RBAC on nodes/pods | `kubectl run … --overrides …` | Disabled unless `k8sNode`; transient pod removed in-call. |
| `ssm-run` | AWS SSM agent | (multi-step; not implemented in the argv executor) | Use `@swamp/aws/ssm`; disabled unless `ssmInstanceId`. |

Container routes prove themselves by reading the host's `/etc/machine-id`
through the host mount — `docker exec -u 0` alone only proves *container* root.

### Residual-risk findings

With `allowAudit=true`, `probe` also emits read-only findings (never executed):
`risk-container-group`, `risk-sudoers` (and a distinct "could not read policy"
result), `risk-writable-paths`, `risk-polkit-lxd`. These never change the chosen
route and never run a privileged command.

### Concurrency

Each caller should pass a unique `instanceKey` (e.g. `instanceKey: "${{ run.id }}"`
or `"${{ workflowRunId }}"`) so the model instance is `sudo-<key>` and concurrent
callers do not collide on swamp's per-model lock or overwrite each other's data.
The default key is `default`.

### Forbidden mechanisms

There is no brute force, no interactive password capture or askpass helper that
answers a prompt, no CVE payload, and no elevation through a discovered
writable root-owned file. A route that needs an interactive password is treated
as unavailable.

### Extending

- Add an operation: append to `OPERATIONS` in `sudo_operations.ts` with a zod
  args schema and an argv builder; it becomes available unless restricted by
  `allowedOperations`.
- Add a strategy: append to `STRATEGIES` in `sudo_strategies.ts` with
  `precondition`, `probeArgv`, `probeOk`, `build`, and `elevationFailed`; add its
  id to `DEFAULT_STRATEGY_ORDER`.
- Keep both modules pure (no I/O) so they stay unit-testable.

### Testing

```sh
~/.swamp/deno/deno test extensions/models/sudo/
~/.swamp/deno/deno check extensions/models/sudo/sudo.ts \
  extensions/models/sudo/sudo_strategies.ts extensions/models/sudo/sudo_operations.ts
```

`sudo_test.ts` covers argv builders, shell quoting, injection rejection, the
nonce, and the gating logic. Integration checks (host with/without a route) are
run manually; see `PLAN.md`.

### Caveats

- `writeFile`, `ensureDirectory`, `chown`, `addUserToGroup`, and `mount` are
  **local-route only** — they are refused when the only available route is a
  remote/orchestrator/oob one.
- `ssh-root` needs a pinned `sshKnownHosts` (or a pre-populated known_hosts) or
  host-key verification fails closed.
- The k8s/container/ssh routes are disabled until configured (`k8sNode`,
  `containerName`, `sshHost`).
- Secrets must not appear in `command`/`args`: swamp records arguments verbatim.
  Reference secrets with `vault.get(...)` inside a step instead.
