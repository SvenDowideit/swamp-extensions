# PLAN — `@svendowideit/sudo`

A swamp extension that provides **callable workflows** any other workflow can
invoke to run a command with elevated (root) privileges on the host where the
model method executes, **without assuming `sudo` exists**.

Status: **revised after adversarial review** — see
[`ADVERSARIAL_REVIEW.md`](./ADVERSARIAL_REVIEW.md). Not yet scaffolded.

This revision changes the design in five material ways. Each is called out
inline with **(R#)** referring to the review section that drove it:

1. **(R§1)** A first-class **caller-trust model** — elevation is requested by
   named operations, or an approval-gated command; never a bare free-form
   "run this as root" for any caller.
2. **(R§2)** The `legitimate` vs `detection` axis is **dropped**. Every
   mechanism is a strategy carrying a `riskNote`; only a **negative list** of
   mechanisms is forbidden. Root-equivalence checks are residual-risk
   *findings*, not a separate execution class.
3. **(R§3–4, §7A)** Container runtime is a **first-class strategy family** with
   container-aware proof, rootless rejection, digest pinning, and cleanup.
4. **(R§3, §5.5, §6)** Argv recipes are corrected (`run0`/`ssh` have no `--`;
   `pkexec` can still prompt), ordering is host-adaptive, and exit codes are
   normalised.
5. **(R§5.1)** The shared model-instance lock/data-collision is removed via a
   caller-supplied **`instanceKey`**.

Five new mechanisms from the review (§7) are added: container family, k8s node,
systemd/polkit bus, out-of-band (SSM/agent), and capability/namespace.

---

## 1. Goal

Other swamp workflows constantly need one root-only action: install a package,
write to `/etc`, restart a system service, `chown` a file, mount, bind a
privileged port. Today each extension inlines its own `sudo` shell-out — which
breaks on hosts without `sudo`, or with passwordless sudo disabled.

This extension makes elevation a **first-class, reusable, auditable, consented
primitive**:

- Callable workflows that a parent invokes as a nested `type: workflow` step.
- A strategy ladder that finds the **first host-granted** elevation mechanism —
  sudo, doas, polkit/run0, session/systemd, ssh, capability, container runtime,
  Kubernetes, or an out-of-band admin channel — with no assumption that any one
  of them exists.
- Structured swamp data recording **which mechanism succeeded**, the exit code,
  stdout/stderr, uid, and duration, so a caller can branch on the outcome.
- A clean, diagnostic failure when no granted path exists.

### Why a workflow and not just a model

The request is a workflow other workflows can call, so the canonical entry point
is a workflow. The work is done by model type `@svendowideit/sudo` so the logic
is also reusable as a direct model method, and so the callable workflows are
thin typed shells (matching the existing `@svendowideit/systemd-service-audit`
pattern).

---

## 2. Caller-trust model (R§1 — read first)

The dangerous question is not "does the host grant root?" but "**who is allowed
to ask for root, and for what?**" A globally addressable workflow that runs an
arbitrary command as root turns any workflow-write access — including a
PR-generated or agent-authored workflow — into a one-line root exec. The
extension must not be a confused deputy.

Two entry points, with different trust:

### 2.1 Operations — the default, ungated path

`run` accepts a **named, versioned operation** from a reviewed catalogue (§11.2)
plus typed arguments. The caller cannot express arbitrary shell; it can only
request an operation whose argv is built by reviewed code. The catalogue is
small and each operation is one purpose.

- Global `allowedOperations` (default: the full shipped catalogue) restricts the
  set.
- Adding an operation is a code change, subject to review and version bump.
- This path never suspends and is safe for automated/cron parents.

### 2.2 Arbitrary command — the gated path

`@svendowideit/sudo-command` accepts an **argv array** and always runs behind a
`manual_approval` gate:

1. `request` — the model mints a nonce that hashes the exact argv, writes a
   `request` record (the exact command, who asked, why), and returns the nonce.
2. `manual_approval` — the workflow suspends; `swamp workflow approvals` shows
   the pending gate, whose prompt contains the exact argv. An operator approves
   and, on resume, supplies an `approvalToken`.
3. `runApproved` — executes only if `approvalToken` matches the operator secret
   **and** the argv hash matches the request nonce. A direct model call without
   the token fails.

Requires global `allowArbitrary=true` (default `false`). If `allowArbitrary` is
false, `@svendowideit/sudo-command` fails before doing anything.

### 2.3 Trust boundary (stated honestly)

This model defeats *accidental* and *opportunistic* abuse: a workflow cannot
silently obtain arbitrary root. It does **not** defend against a caller that can
also read the operator's approval secret or edit the reviewed catalogue — such a
caller already holds the capability. The design goal is that the *default* path
is safe and the *ungated* path is impossible.

---

## 3. Scope and forbidden mechanisms (R§2)

This is a **legitimate administration tool**. Its mechanisms succeed only when
the host has *already granted* the privilege (NOPASSWD sudoers, doas `nopass`,
a polkit rule, docker-group membership, a root ssh key, a capability, an SSM
agent). If the grant is absent, the strategy is unavailable — the extension does
not defeat it.

**Negative list — never implemented, in any strategy or finding:**

- Credential brute force or credential stuffing of any kind.
- Interactive password capture: never prompt, never read a TTY for a password,
  never install an askpass helper that answers a prompt. A mechanism that needs
  an interactive password is **unavailable**, not something to satisfy.
- CVE exploitation or reproduction, or shipping CVE payloads.
- Defeating an explicit denial (e.g. running a SUID binary because a *known
  vulnerability* makes it exploitable, rather than because it is a granted tool).
- Writing to a root-owned file discovered to be writable, as a *means* of
  elevation. Writable root-owned files are reported as a **finding** and used
  for nothing else.

There is no `legitimate`/`detection` binary. `sudo` and docker-group access are
both pre-granted privilege and both dangerous; the honest labels are
`riskNote`, `sideEffects`, and `proveCost` on each strategy, plus a separate set
of non-executing **residual-risk findings** (§7.5).

---

## 4. Extension shape

Directory: `extensions/models/sudo/`

| File | Purpose |
| ---- | ------- |
| `manifest.yaml` | `@svendowideit/sudo` — model + both workflows + README/LICENSE. |
| `sudo.ts` | Model type `@svendowideit/sudo`: globals, `probe`, `run`, `request`, `runApproved`, operation catalogue, I/O. |
| `sudo_strategies.ts` | Pure, unit-testable strategy catalogue: definitions, detection predicates, argv builders, exit-code normalisation. No I/O. |
| `sudo_operations.ts` | Pure operation catalogue: typed args → argv builders. No I/O. |
| `sudo-run.yaml` | Callable workflow `@svendowideit/sudo-run` — operations (ungated). |
| `sudo-command.yaml` | Callable workflow `@svendowideit/sudo-command` — arbitrary argv, approval-gated. |
| `sudo_test.ts` | Unit tests for the pure helpers, argv builders, and normalisation. |
| `sudo-run_test.ts` | Tests for the gated flow (nonce hashing, token check) with fakes. |
| `README.md` | Extender/maintainer doc; every method and strategy named. |
| `LICENSE.txt` | MIT (matches repo). |

Model type: `@svendowideit/sudo`
Workflows: `@svendowideit/sudo-run`, `@svendowideit/sudo-command`

---

## 5. Architecture

```
parent workflow (operation path)
  └─ task: workflow → @svendowideit/sudo-run
        inputs: { operation, args, instanceKey, strategy? }
        jobs:
          probe → model @svendowideit/sudo method probe
          run   → model @svendowideit/sudo method run    (dependsOn probe)
        model instance name: sudo-<instanceKey>
  parent reads: data.latest("sudo-<instanceKey>", "result")

parent workflow (arbitrary path)
  └─ task: workflow → @svendowideit/sudo-command
        inputs: { command: string[], reason, instanceKey }
        jobs:
          request → method request      (mint nonce; write request record)
          gate    → manual_approval      (operator sees the exact argv)
          run     → method runApproved   (requires approvalToken + nonce match)
```

### 5.1 Concurrency-safe instance keys (R§5.1)

The original design used one global auto-created `sudo-run` instance, which
serialises every elevation in the repo on swamp's per-model lock **and** makes
`probe`/`result` data collide between callers (last writer wins). AGENTS rule 6.

**Fix:** the callable workflow takes an `instanceKey` input, defaulting to
`"default"`. The model instance is `sudo-<instanceKey>`, so:

- Distinct callers use distinct instances → parallel, no lock contention, no
  data collision.
- The parent knows the key it supplied, so it can read
  `data.latest("sudo-<instanceKey>", "result")` deterministically.
- Identical concurrent calls on the same key serialise harmlessly (same work).
- Callers that may run concurrently **should** pass a unique key, e.g.
  `instanceKey: "${{ run.id }}"`; the docs make this explicit.

### 5.2 Remote placement (R§5.1, R§6)

A nested workflow runs wherever the parent step is placed, so elevation is
host-correct by construction: if the parent step is dispatched to a worker, the
child runs on that worker and elevates there. **Open item:** whether the parent
can read the child's model `result` data when the child ran on a remote worker
is unverified — §15 lists an explicit verification test. Until verified, remote
callers should consume the child step's returned artifacts rather than
`data.latest`.

---

## 6. Unified strategy model

Every mechanism — including container and out-of-band — is a **strategy** with
the same shape:

```ts
type Strategy = {
  id: string;                       // "sudo-n", "docker-run", "k8s-node", ...
  class: "local" | "container" | "orchestrator" | "oob";
  detects: () => DetectResult;      // installed/configured? no privilege change
  prove: () => ProveResult;         // cheap check that it truly yields host root
  argv: (cmd: string[]) => string[];// exact argv to execute
  riskNote: string;                 // e.g. "root-equivalent by design for docker group"
  sideEffects: "none" | "creates-container" | "creates-pod" | "remote-api";
  proveCost: number;                // relative ordering weight
};
```

There is no separate execution class for "container" or "detection"; ordering
and gating do the work, and `riskNote`/`sideEffects` make the danger legible.

---

## 7. Strategy catalogue

Detection predicates never change privilege. Proofs are cheap no-ops
(`id -u` == 0, or a host-visible marker) with a **hard timeout**; a prompt or
timeout means *unavailable*, not *answer it*.

### 7.1 Local, no-side-effect strategies (all corrected per R§3/§6)

| # | id | Tool / grant | Detection | Execution argv | riskNote |
| - | -- | ------------ | --------- | -------------- | -------- |
| L1 | `sudo-n` | `sudo`, NOPASSWD or cached | `sudo -n true` exits 0 (NOT `command -v sudo`) | `sudo -n -- <argv>` | full root; requires a NOPASSWD/cached grant. `--` requires sudo ≥1.8; document minimum. |
| L2 | `doas-n` | `doas` with `permit nopass` | `doas -n /usr/bin/id -u` returns `0` | `doas -n <argv>` (doas takes no `--`) | full root; prove with a representative command shape, since a `nopass` rule may be scoped. |
| L3 | `run0` | systemd v256+ `run0` (polkit, no setuid) | `run0 --no-ask-password --pipe /usr/bin/id -u` returns `0` | `run0 --no-ask-password --pipe <program> <args…>` (**no `--`**) | full root via polkit; needs a policy permitting the caller. |
| L4 | `pkexec` | polkit `org.freedesktop.policykit.exec` | `pkexec --disable-internal-agent /usr/bin/id -u` returns `0` **within probe timeout** | `pkexec --disable-internal-agent <program> <args…>` (**no `--`**) | full root via polkit. `--disable-internal-agent` stops pkexec's *internal* agent only — an external desktop agent can still prompt. A prompt/timeout ⇒ unavailable. |
| L5 | `systemd-run` | polkit + system bus transient unit | `systemd-run --system --uid=0 --pipe --wait /usr/bin/id -u` returns `0` | `systemd-run --system --uid=0 --pipe --wait <argv>` | same grant as `run0`, reachable when `run0` is absent (older systemd) or over the bus. |
| L6 | `ssh-root` | key-based `ssh root@host` (`PermitRootLogin prohibit-password`) | `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@<host> /usr/bin/id -u` returns `0` | `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@<host> <shell-quoted command>` | remote full root; command runs through the remote shell. **No `--`** (ssh stops option parsing at the hostname). `StrictHostKeyChecking=yes` requires a pinned host key — else configure `sshKnownHosts`, or `accept-new` with a documented TOFU caveat. |
| L7 | `nsenter` | process already holds `CAP_SYS_ADMIN` | `nsenter --target 1 --mount --uts --ipc --net --pid -- /usr/bin/id -u` returns `0` | `nsenter --target 1 --mount --uts --ipc --net --pid -- <argv>` | host root via an already-held capability; **no setuid tool needed**. |
| L8 | `setpriv`/`capsh` | process holds `CAP_SETUID`/`CAP_SETGID` | `setpriv --reuid=0 --regid=0 --clear-groups /usr/bin/id -u` returns `0` | `setpriv --reuid=0 --regid=0 --clear-groups <argv>` (or `capsh --user=root -- -c …`) | root from an already-held capability. |

`ssh` is the one place a shell is unavoidable (the remote side parses a command
line). It is safe because we shell-quote **each argv token ourselves** and never
concatenate caller text; a unit test asserts the quoting.

`su` and `machinectl shell` are deliberately absent: both are interactive
(password/TTY), which §3 forbids.

### 7.2 Container-runtime family (R§3, R§4, R§7A — user's correction)

**This is accepted as first-class.** For a user in the `docker` group (or
`podman`/`containerd` equivalents) container runtime access is root-equivalent
by design. On the review host it was the *only* available path while `sudo -n`
failed — the exact case the original plan mislabelled.

Two shapes, per runtime (`docker`, `podman`, `nerdctl`, `ctr`, `cri-o`):

- **Attach** — `docker exec -u 0 <container> <argv>`. Cheapest; **only**
  host-root-equivalent if `<container>` is privileged or has a host mount.
  `prove` must exec into a container known to be host-root-equivalent, or fall
  through to the launch shape.
- **Launch a scratch host-access container** (default):

```
docker run --rm --privileged --pid=host --net=host -v /:/host \
    --entrypoint /bin/sh <image>@<digest> \
    -c 'exec chroot /host "$@"' _ <argv…>
```

`chroot /host "$@"` passes argv positionally — no injection — and returns
program output/exit code through the container.

Mandatory guardrails:

- **Reject rootless.** Parse `docker info` (SecurityOptions `rootless`) /
  `podman info`; a rootless daemon cannot yield host root and must be
  *unavailable*, not used and failed.
- **Pin image by digest** — never `:latest`.
- `--rm` **and** a cleanup trap so a killed run leaves no privileged containers.
- `--network none` unless the operation needs network.
- Prove must demonstrate a **host-visible** effect (e.g. read the host's
  `/etc/machine-id` through `/host`), not merely `id -u` inside the container.

Strategy ids: `docker-exec`, `docker-run`, `podman-run`, `nerdctl-run`,
`ctr-run`. **Rule 1 check:** `@keeb/docker` (community, verified) covers
container lifecycle over SSH. Before hand-rolling, evaluate whether its run
method can execute a privileged one-shot with a host mount and return output; if
so, invoke it rather than shelling out. Otherwise document why the direct argv
is preferred (one-shot, no model instance, output streaming).

### 7.3 Kubernetes node access (R§7B)

For a host whose `kubectl` has `pods/exec` + `nodes` access, root on the *node*:

```
kubectl debug node/<node> -it --image=<pinned> -- chroot /host <argv>
```

or a one-shot privileged pod with `hostPID`, `hostNetwork`, and a `hostPath /`
volume, running `chroot /host "$@"`. `prove` creates a short-lived pod that
reads the host's `/etc/machine-id`. RBAC is the grant; no permission ⇒
unavailable. Distinct from docker: it targets the *cluster node*, which matters
when swamp runs on a laptop but the target is the cluster. Strategy id:
`k8s-node`. `sideEffects: creates-pod`, always namespaced and `--rm`-equivalent
(deleted in a `finally`).

### 7.4 Out-of-band admin channel (R§7D)

When the local host grants nothing, send the operation to a system that already
runs as root:

- **Cloud agent:** AWS SSM `SendCommand` (`AWS-RunShellScript`), Azure Run
  Command, GCP OS Config. **Rule 1 check:** `@swamp/aws/ssm` exists — invoke the
  model, do not shell out to `aws`. Strategy id `ssm-run`.
- **Orchestration:** Ansible `become`, `bolt`, or a dedicated root endpoint. The
  grant is the inventory/agent. Strategy id `ansible-become`.
- **Pre-installed swamp root agent:** a socket-activated systemd service that
  accepts a signed, **allowlisted** command. This is the only variant that
  removes the confused-deputy problem entirely, because the root side enforces
  policy instead of trusting the caller. Documented as the recommended
  production setup.

`prove` is a no-op ping. `sideEffects: remote-api`.

### 7.5 Residual-risk findings (never executed)

Reported only when `allowAudit=true`, always as `allowFailure` findings, never
changing `strategyUsed`, never running the target command. These are the old
"E" checks, reframed as findings rather than a pseudo-strategy class. Crucially
they distinguish **"none found"** from **"could not read"** (R§6).

| id | Surface | What is read | Notes |
| -- | ------- | ------------ | ----- |
| `risk-container-group` | container socket/group access | socket reachability + group membership | Reported because it is root-equivalent; the mechanism itself is now a first-class strategy (§7.2), so this finding is informative, not a restriction. |
| `risk-sudoers` | over-permissive sudoers / SUID | `sudo -n -l` parse + a **small fixed SUID→risk table** | If `sudo -n -l` fails, report `"could not read policy"` — never `"none found"`. Do **not** ship a bundled GTFOBins catalogue. |
| `risk-writable-paths` | writable root-owned files | `/etc/passwd`, `/etc/shadow`, `/etc/sudoers*`, `/etc/cron*`, `/etc/systemd/system/*`, PATH dirs | Immediate escalation surface; remediation only. |
| `risk-polkit-lxd` | polkit rules / LXD group / polkit version | permissive `.rules`, `lxd`/`lxc` membership, version compare | Version compare produces a patch finding; no reproduction. |

---

## 8. Ordering (R§3)

Ordering is **not** "sudo first because common". It is computed:

1. An explicit `strategy` pin wins, always.
2. Otherwise order by `sideEffects` then `proveCost`: no-side-effect local
   strategies (L1–L8) first, then capability/namespace, then the container
   family, then k8s, then out-of-band.
3. The default `strategyOrder` global **includes the container family**; it is
   overridable, and operators on known hosts are encouraged to pin.

The default order is a starting point, documented as such — not a claim that
sudo is universally best.

---

## 9. Resolution algorithm

```
probe(instanceKey, strategy="auto", allowAudit=false):
  1. Candidates: pinned strategy if set, else strategyOrder.
  2. For each candidate, in order:
       a. detects() -> { installed, configured, reason }
       b. if installed/configured: prove() within probeTimeout
       c. first proof of host root -> winner { id, ranAs: 0, proof }
  3. If allowAudit: run §7.5 findings; collect (never executes the command).
  4. Emit `probe` data { winner|null, ladder[], findings[], capability }.
  5. ALWAYS succeeds; probe never runs the target command and never fails on
     "no winner" (R§6), so findings remain reachable.

run(instanceKey, operation, args, strategy="auto"):
  1. Validate operation ∈ allowedOperations and args against its schema.
  2. Resolve winner (probe if not fresh), then build argv from the catalogue.
  3. Execute winner.argv(argv) with timeout; run exactly once.
  4. Capture exitCode, stdout, stderr, ranAsUid (post-check), durationMs.
  5. Emit `result` data + `run` report.

request(instanceKey, command[], reason):   # gated path
  1. Require allowArbitrary=true.
  2. nonce = hash(argv + reason + timestamp); write `request` record.
  3. Emit nonce.

runApproved(instanceKey, command[], nonce, approvalToken):
  1. Require allowArbitrary=true.
  2. Require approvalToken == operator secret (vault) AND nonce matches hash.
  3. Execute as in run(); emit `result`.
```

**First-win, single execution.** A real command runs through exactly one
mechanism. Fallback happens only during capability *probing*; it never re-runs a
mutating command. A pinned-but-unavailable strategy fails loudly rather than
silently substituting another.

---

## 10. Exit-code normalisation (R§5.5, R§6)

Each mechanism mangles exit codes. `result` carries both `exitCode` (the target
program's, where recoverable) and `elevationFailed: boolean`, plus
`mechanismExitCode`:

| Mechanism | Elevation-failure codes | Notes |
| --------- | ----------------------- | ----- |
| `sudo` | 1 with "authentication is required" on stderr | distinguish by stderr pattern |
| `doas` | 1 (auth), 126/127 | |
| `pkexec` | 126/127/128+, no agent | |
| `run0` | 1 "requires interactive authentication" | program codes pass through after success |
| `systemd-run` | 1 on unit start failure, `--wait` returns program code | |
| `ssh` | **255** on ssh's own errors | program code otherwise |
| container | container start failure vs program code; `docker` 125/126/127 | parse |
| `docker exec` | exec/program distinction | parse |

`elevationFailed` is true when the failure is the mechanism's, not the
program's. `probe` records the pattern per mechanism from the proof step.

---

## 11. Interfaces

### 11.1 Model global args

| Arg | Type | Default | Meaning |
| --- | ---- | ------- | ------- |
| `strategyOrder` | string[] | all ids, side-effect-ordered | Order to try strategies. |
| `allowedOperations` | string[] | full catalogue | Operations `run` may execute. |
| `allowArbitrary` | boolean | `false` | Enable `request`/`runApproved`. |
| `sshHost` | string | `""` | Host for `ssh-root`; empty disables it. |
| `sshKnownHosts` | string | `""` | Pinned known_hosts for `ssh-root`. |
| `containerImage` | string | `"<pinned>@<digest>"` | Image for scratch-container strategies. |
| `k8sNode` | string | `""` | Node for `k8s-node`; empty disables it. |
| `ssmInstanceId` | string | `""` | Target for `ssm-run`; empty disables it. |
| `timeoutSeconds` | number | `120` | Per-execution timeout. |
| `probeTimeoutSeconds` | number | `8` | Per-proof timeout; a prompt ⇒ unavailable. |
| `allowAudit` | boolean | `false` | Emit §7.5 findings. |

### 11.2 Operation catalogue (reviewed; each one purpose)

`run` takes `operation` + typed `args`; the catalogue builds argv — no shell.

| Operation | Args | argv |
| --------- | ---- | ---- |
| `installPackage` | `manager` (apt/dnf/yum/zypper/apk/pacman), `packages[]` | e.g. `apt-get install -y <packages…>` |
| `removePackage` | same | e.g. `apt-get remove -y <packages…>` |
| `writeFile` | `path`, `content`, `mode` | writes via a helper; path/mode validated absolute + non-symlink |
| `ensureDirectory` | `path`, `mode`, `owner`, `group` | `install -d -m -o -g` |
| `chown` | `path`, `owner`, `group`, `recursive` | `chown [-R] owner:group path` |
| `manageService` | `unit`, `action` (start/stop/restart/enable/disable) | `systemctl <action> <unit>` |
| `sysctl` | `key`, `value` | `sysctl -w key=value` |
| `addUserToGroup` | `user`, `group` | `usermod -aG group user` |
| `mount` | `source`, `target`, `fstype`, `options` | `mount [-t fstype] [-o options] source target` |
| `runScript` | `path` | executes an existing **root-owned** script at `path` |

### 11.3 Methods (data written)

- `probe` → data `probe`: `{ winner|null, ladder[], findings[], capability }`.
  Always succeeds.
- `run` → data `result`: `{ strategyUsed, operation, argv, exitCode,
  elevationFailed, mechanismExitCode, stdout, stderr, ranAsUid, durationMs,
  mechanism }`. Fails (structured) only when no strategy resolves or the
  operation is not allowed.
- `request` → data `request`: `{ nonce, argv, reason, requestedBy, requestedAt }`.
- `runApproved` → data `result` (same shape) plus `approvedBy`.

### 11.4 Callable workflow `@svendowideit/sudo-run` (operations)

Inputs: `operation` (string, required), `args` (object, default `{}`),
`instanceKey` (string, default `"default"`), `strategy` (string, default
`"auto"`), `timeoutSeconds` (integer, default `120`), `allowAudit` (boolean,
default `false`).

```yaml
jobs:
  - name: elevate
    steps:
      - name: probe
        task:
          type: model_method
          modelType: "@svendowideit/sudo"
          modelName: sudo-${{ inputs.instanceKey }}
          methodName: probe
          inputs:
            strategy: ${{ inputs.strategy }}
            allowAudit: ${{ inputs.allowAudit }}
      - name: run
        dependsOn:
          - step: probe
            condition: { type: succeeded }
        task:
          type: model_method
          modelType: "@svendowideit/sudo"
          modelName: sudo-${{ inputs.instanceKey }}
          methodName: run
          inputs:
            operation: ${{ inputs.operation }}
            args: ${{ inputs.args }}
            strategy: ${{ inputs.strategy }}
            timeoutSeconds: ${{ inputs.timeoutSeconds }}
```

Parent usage — install a package, then assert it worked:

```yaml
- name: install-caddy
  task:
    type: workflow
    workflowIdOrName: "@svendowideit/sudo-run"
    inputs:
      operation: installPackage
      args: { manager: apt, packages: ["caddy"] }
      instanceKey: "${{ run.id }}"
```

```yaml
- name: caddy-installed
  task:
    type: assert
    expr: >-
      int(data.latest("sudo-CADDY_RUN_ID", "result").attributes.exitCode) == 0
    message: "privileged package install failed"
```

(The docs show the working form with a literal key and explain the
`instanceKey` convention.)

### 11.5 Callable workflow `@svendowideit/sudo-command` (gated arbitrary)

Inputs: `command` (array of string, required), `reason` (string, required),
`instanceKey` (string, default `"default"`).

```yaml
jobs:
  - name: approve-and-run
    steps:
      - name: request
        task:
          type: model_method
          modelType: "@svendowideit/sudo"
          modelName: sudo-${{ inputs.instanceKey }}
          methodName: request
          inputs:
            command: ${{ inputs.command }}
            reason: ${{ inputs.reason }}
      - name: gate
        dependsOn:
          - step: request
            condition: { type: succeeded }
        task:
          type: manual_approval
          prompt: >-
            Approve running as root: ${{ inputs.command }}
            (reason: ${{ inputs.reason }})
      - name: run
        dependsOn:
          - step: gate
            condition: { type: succeeded }
        task:
          type: model_method
          modelType: "@svendowideit/sudo"
          modelName: sudo-${{ inputs.instanceKey }}
          methodName: runApproved
          inputs:
            command: ${{ inputs.command }}
            nonce: ${{ data.latest("sudo-INSTANCE", "request").attributes.nonce }}
            approvalToken: ${{ vault.get(sudo-approval, token) }}
```

There is **no `commandLine` string input and no hand-rolled tokenizer** (R§5.3).
The gated path takes an argv array; the operation path takes typed args. The
only place caller text reaches a shell is the remote/container side, where we
shell-quote each token ourselves.

### 11.6 How other extensions consume it

One nested-workflow step with a named operation. No dependency on `sudo`, no
per-extension elevation code, and the mechanism actually used is recorded in
swamp data. This is "extend, don't be clever": one model type owns elevation for
the repo.

---

## 12. Data model, tags, secrets

| Data name | Written by | Tags | Read by |
| --------- | ---------- | ---- | ------- |
| `probe` | `probe` | `sudo`, `capability` | `run`, callers |
| `result` | `run`/`runApproved` | `sudo`, `elevation` | callers via `data.latest("sudo-<key>","result")` |
| `request` | `request` | `sudo`, `approval` | `runApproved`, auditors |

**Secrets (R§5.4).** Swamp records method arguments and workflow inputs
verbatim. A privileged argv may embed a secret. Rules:

- Never pass a secret as the `command`/`args` value. Reference it with
  `vault.get()` **inside** the step inputs/command so only the reference is
  recorded.
- The operator approval token lives in a vault (`sudo-approval`), not in an
  input.
- `result`/`request` records include the argv by design (audit); callers must
  keep secrets out of argv.

---

## 13. Security and consent model

1. **Caller trust first.** Named reviewed operations by default; arbitrary
   commands only behind `allowArbitrary` + `manual_approval` + operator token.
2. **No forbidden mechanisms.** §3's negative list is absolute.
3. **No non-interactive prompts.** Every proof/execution has a hard timeout; a
   prompt is *unavailable*.
4. **No shell injection.** Operations build argv from typed args; the gated path
   takes argv; remote/container quoting is per-token and unit-tested.
5. **First-win, single execution.** Fallback is probe-only.
6. **Least surprise.** A pinned-but-unavailable strategy fails loudly.
7. **Full auditability.** Mechanism, exact argv, uid, exit code, duration, and
   (gated path) requester + approver are persisted.

---

## 14. Testing plan

Pure (`sudo_strategies.ts`, `sudo_operations.ts`, no I/O, bundled Deno):

- argv builders match the documented argv exactly, including: `sudo -n --`,
  `doas -n` (no `--`), `run0 --no-ask-password --pipe` (no `--`), `pkexec
  --disable-internal-agent` (no `--`), `ssh` **per-token shell quoting** (assert
  a malicious token cannot break out), container `chroot /host "$@"` positional
  passing, `nsenter`/`setpriv` argv.
- rootless detection parsing fixtures (`docker info` rootless / not).
- exit-code normalisation table, including ssh 255 and container 125/126/127.
- operation catalogue rejects unknown operations, relative paths, and unsafe
  `writeFile` targets.

Gated flow (`sudo-run_test.ts`, fakes):

- `request` nonce is a function of the exact argv; a changed argv yields a
  different nonce and `runApproved` refuses.
- `runApproved` refuses without a valid `approvalToken`.
- `allowArbitrary=false` blocks `request` and `runApproved`.

Integration (skipped when the privilege is absent):

- host with `sudo -n`: probe winner `sudo-n`; host with only docker-group:
  winner `docker-run` **and** a host-visible proof.
- host with neither: `probe` **succeeds** with `winner: null`, ladder fully
  explained.
- `run` `["id","-u"]` via whatever wins → `ranAsUid: 0`.
- rootless docker present → `docker-*` marked unavailable, not failed.
- `allowAudit=true` with docker-group → `risk-container-group` finding present.
- **Remote-placement test:** parent step dispatched to a worker; confirm whether
  the parent can read `data.latest("sudo-<key>","result")` (R§5.1/§5.2).

Commands (bundled Deno, per repo tooling rule):

```
~/.swamp/deno/deno test extensions/models/sudo/
~/.swamp/deno/deno check extensions/models/sudo/sudo.ts \
  extensions/models/sudo/sudo_strategies.ts extensions/models/sudo/sudo_operations.ts
```

---

## 15. Docs contract (extension-docs skill)

- `manifest.yaml` `description:` is the user manual, canonical order:
  `WHAT IT DOES` (a short pitch), `INSTALL`, `DEPENDENCIES`, `RUN`,
  `CONFIGURE`, `WHAT IT INSTALLS` — **no METHODS section**.
- Single-step install: `swamp extension pull @svendowideit/sudo`.
- **≥3 runnable, explained `swamp …` commands**, no placeholders:
  - `swamp model @svendowideit/sudo method run probe sudo-default` — see which
    elevation paths exist on this host (read-only; no command run).
  - `swamp workflow run @svendowideit/sudo-run --input operation=manageService --input 'args:json={"unit":"caddy","action":"restart"}'`
    — restart a service by name, no sudo assumption.
  - `swamp workflow run @svendowideit/sudo-command --input 'command:json=["id","-u"]' --input reason="smoke test"`
    — the approval-gated arbitrary path, for when no operation exists.
  - `swamp model @svendowideit/sudo method run probe sudo-default --input allowAudit=true`
    — residual-risk findings (docker group, sudoers, writable paths).
- `README.md`: `## What it does`, `## Install`, `## Configuration` (argument
  table), `## Examples`, `## Details` naming **every method, every strategy
  (with exact argv and riskNote), every operation, and the gated flow**.
- `WHAT IT INSTALLS`: nothing on the host (no service, webhook, or cron). If a
  production root-agent is recommended in Details, say so explicitly as an
  operator choice, not something the extension installs.
- Verify:
  `swamp workflow run @svendowideit/meta-factory --input manifest=extensions/models/sudo/manifest.yaml`

---

## 16. Release hygiene (per AGENTS.md)

1. `swamp extension version --manifest extensions/models/sudo/manifest.yaml` →
   set manifest `version:` and model `version:` to `nextVersion`, matching; add
   the `upgrades:` entry.
2. Verify: deno test, deno check, `swamp extension fmt --check`,
   `swamp workflow validate @svendowideit/sudo-run`,
   `swamp workflow validate @svendowideit/sudo-command`, meta-factory ≥ 75.
3. Record the adversarial review for the new content hash.
4. Report old → new version, what changed, verification result, and the exact
   `swamp extension push` command — do not push unless asked.

---

## 17. Open questions

1. **Operation catalogue scope** — is the §11.2 list right, or should
   `writeFile`/`runScript` be excluded from v1 (they are the closest to
   arbitrary) and added only by review?
2. **Approval token storage** — vault (`sudo-approval`) vs an env var. Vault is
   proposed; confirm the operator ergonomics on a headless cron host.
3. **Container launch image** — which pinned image/digest, and do we depend on
   `@keeb/docker` (rule 1) or ship the one-shot argv builder?
4. **k8s/ssm defaults** — both require target config (`k8sNode`, `ssmInstanceId`)
   and are empty→disabled by default. Confirm that is acceptable, or ship them
   enabled with discovery.
5. **`instanceKey` ergonomics** — `"${{ run.id }}"` is a mouthful; is a
   documented convention plus a helper enough, or should the workflow default it
   to a unique value automatically (and how would the parent then learn it)?

---

## 18. Milestones

1. Scaffold dir, LICENSE, manifest skeleton (swamp commands, not hand-written).
2. `sudo_strategies.ts` + `sudo_operations.ts` + tests (pure; no privileges).
3. `sudo.ts` model (`probe`, `run`, `request`, `runApproved`) + `deno check`.
4. `swamp workflow create @svendowideit/sudo-run` → author → validate.
5. `swamp workflow create @svendowideit/sudo-command` → author → validate.
6. Integration tests on hosts with/without each privilege; remote-placement test.
7. README + manifest manual; meta-factory score.
8. Bump version, full verification, report for push.
