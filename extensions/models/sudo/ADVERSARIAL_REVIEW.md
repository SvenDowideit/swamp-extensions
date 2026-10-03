# Adversarial review — `@svendowideit/sudo` PLAN

Reviewer stance: assume the plan is wrong somewhere and find where. Every claim
below is either verified on this host (a Linux box with `sudo`, `pkexec`,
`run0`, `docker`, no `doas`) or marked as a design objection.

Verdict up front: **the plan is salvageable, but its central abstraction — a
single trusted "run this command as root" primitive — has no caller trust model,
its ladder ordering is argued from a false premise, several argv recipes are
factually wrong, and the container-runtime path is miscategorised.** Fix those
five and it is a good extension. The rest of this document is the evidence.

---

## 1. The load-bearing flaw: there is no caller trust model

The plan describes who can *elevate* (host grants) but never who is *allowed to
ask*. It assumes the caller is an admin. That is the whole security question, and
the plan punts on it.

Concretely: `@svendowideit/sudo-run` is a repo-wide, globally-addressable
workflow. Any workflow in the repo — including one authored by a future
extension, a scheduled job, a webhook-triggered workflow, or an agent-driven
one — can invoke it with any `command`. The extension then does its best to
find *a* path to root and executes the string. There is no allowlist, no
caller identity, no confirmation, no dry-run gate on the mutating path.

This is a confused-deputy design: the extension holds no privilege itself, but
it is a convenient *launcher* that turns any workflow-write access into a
one-line root exec. On a CI host where workflows are generated from a PR, that
is the difference between "review the diff" and "the diff runs `curl | sh` as
root on the runner".

The plan's safety section answers the wrong threat: it defends against *the
extension escaping a withheld grant* (good, it doesn't) but not against *a
caller abusing a grant the host already gave*. Those are independent problems
and the second one is the dangerous one.

**Fix.** The primitive must not be "run arbitrary command as root". Pick one:

- **Allowlist by design.** `run` takes a named, versioned *operation* (e.g.
  `installPackage(name)`, `writeFile(path, content)`, `restartUnit(unit)`)
  declared by the consuming extension, not a free-form command string. The
  extension ships a small, reviewed catalogue. Reject unknown operations.
- **Or two-key consent.** `run` requires `confirm: <run-id>` minted by a first
  `request` call plus a `manual_approval` gate (swamp has this natively — the
  plan lists the task type but never uses it). Mutating elevation suspends
  until an operator approves. Then the free-form string is acceptable.
- **Or scoped callers.** Require a per-caller `purpose` + a configured
  `allowedPurposes` global, and refuse anything else. Weaker than the above,
  but better than nothing.

Without one of these, the extension is an operator convenience and an attacker
convenience in equal measure, and the "safety scope" section is decoration.

---

## 2. The "legitimate vs exploit" axis is the wrong axis

The plan sorts mechanisms by *social legitimacy* (sudo/doas = legitimate,
docker socket = detection-only). But the user's own message already exposes the
error: **`docker exec -u 0` / `docker run --privileged --pid=host --net=host
-v /:/host` is a normal, sanctioned administration tool for anyone in the
`docker` group.** On this host the reviewer's user is in `docker`
(`id -nG` → `… docker …`) and Docker's own security documentation states that
docker-group access is *root-equivalent by design*. Calling that an "exploit
surface to be detected, never executed" while calling `sudo -n` legitimate is
incoherent: both are pre-granted privilege. The distinction that actually
matters is **"does the host already grant this?"**, not "is it `sudo`?".

The plan conflates two separate questions:

1. **Is the mechanism sanctioned?** — always answered by "does the host grant
   it". `sudo -n`, `doas -n`, docker-group, a root ssh key, SSM, a privileged
   k8s pod: all sanctioned iff granted.
2. **Is the mechanism dangerous if used without consent?** — true of *all* of
   them, including `sudo`. `sudo` is not less dangerous than docker; it is just
   more familiar.

**Fix.** Drop the moral axis. Every mechanism is a `legitimate` strategy with a
`riskNote`, gated by the caller-trust model from §1. Keep an explicitly
*negative* list only for things that are wrong on any host: brute force,
interactive password capture, CVE payloads, defeating an explicit denial. Do not
put docker-group in a "never execute, only detect" bucket unless you also put
`sudo` there — and you don't want to.

---

## 3. Empirical findings that break the default ladder

Verified on the review host (Linux, docker 29.1.3, run0 from systemd ≥256,
polkit present, no `doas`):

| Probe | Observed | Implication for the plan |
| ----- | -------- | ------------------------ |
| `sudo -n true` | exit 1, "interactive authentication is required" | `sudo` present but **not** passwordless → L1 correctly rejected. But note `command -v sudo` is *not* a capability test; the plan does use `sudo -n true`, good. |
| `sudo -n -l` | exit 1 (needs auth) | Used by E2 to parse sudoers. On a password-protected host this returns nothing, so **E2 silently reports "no NOPASSWD entries" when it simply may not read the policy.** False negative. Must distinguish "parsed, none found" from "could not read". |
| `pkexec --disable-internal-agent /usr/bin/id -u` | exit **127**, "No authentication agent found" | Rejected here, but the flag only disables pkexec's *internal* text agent. On a desktop/logind session an **external** polkit agent can still pop a GUI prompt → pkexec can hang or prompt. The plan claims non-interactive; it is not guaranteed. Needs a hard timeout and "prompt ⇒ not configured". |
| `run0 --no-ask-password --pipe /usr/bin/id -u` | exit 1, "requires interactive authentication" | Correctly rejected. But `run0 --help` shows **no `--` separator**; the plan's argv `run0 --no-ask-password -- <argv>` is **wrong** and will likely be read as a command named `--`. Correct: `run0 --no-ask-password --pipe <program> <args…>`. |
| `docker` + membership in `docker` group + `/var/run/docker.sock` root:docker 660 | accessible | The strongest *available* elevation path on this host is **docker, not sudo** — the exact opposite of the plan's ordering. |
| `ssh` argv `ssh … root@host -- <cmd>` | — | **Wrong.** ssh stops option parsing at the hostname; everything after is the remote command. `--` would be sent *to the remote shell* as the first token. Correct: `ssh -o BatchMode=yes root@host "<quoted command>"` (or pass argv through a fixed remote wrapper). |
| `run0 --pipe /bin/false` | exit 1 | Program exit codes are mixed with elevation-failure codes; need normalisation (see §6). |

**Ladder ordering is argued from a false premise.** The plan defaults to
`sudo` first "because common". The *correct* ordering key is
**cheapest-and-most-targeted-that-is-already-proven**, and on container hosts
that is often the runtime socket. Ordering should be host-adaptive: order by
each strategy's `prove()` cost and the risk of side effects, with the
operator able to pin. At minimum the default `strategyOrder` must include the
container strategy and must not be hard-coded sudo-first in prose.

---

## 4. The container strategy as written is under-specified and unsafe

The user is right that it belongs. But "detection-only" is not the only problem;
executing it correctly is harder than the plan admits:

- **`docker exec -u 0` only proves container root, not host root.** It depends
  entirely on the target container being privileged / having host mounts. On an
  unprivileged container, `docker exec -u 0 <c> id -u` returns `0` and proves
  **nothing** about the host. The `prove()` step must be container-aware: exec
  into a container that is *known* host-root-equivalent, or launch a scratch
  container with explicit host access and check a host-observable effect.
- **Rootless is not host root.** `docker` may be rootless (or `podman`/`nerdctl`
  rootless). `docker info` must be parsed for rootless security options; a
  rootless daemon cannot elevate to host root and must be rejected as a
  *strategy*, not used and failed.
- **`docker run --privileged -v /:/host …` has side effects.** It pulls images
  (network), creates containers, and leaves them unless `--rm`. The plan's
  "prove is a cheap no-op" assumption is false here. Requirements: pinned image
  by digest (never `:latest`), `--rm`, `--network none` unless needed,
  `--read-only` where possible, and a cleanup/trap so a killed run does not
  leave privileged containers.
- **There is an existing extension for half of this.** `@keeb/docker` (community,
  verified) covers build/run/exec/compose over SSH. Per repo rule 1, the docker
  argv should not be hand-rolled if that type covers it — either depend on it or
  document why not. Hand-rolling `docker run --privileged` is exactly the
  "be clever" failure mode.
- **`ctr`/`nerdctl`/`podman`/`cri-o` sockets differ** (`--address`, `--namespace`,
  rootless paths). The plan lists them in one detection bucket; each is a
  separate argv builder and a separate rootless check.

**Fix.** Promote container runtime to a first-class `legitimate` strategy
family (one sub-id per runtime) with a container-aware `prove()` that
demonstrates a **host-visible** effect, rootless rejection, digest-pinned
images, `--rm`, and no network by default. Keep the "finding" for *unrequested*
use: if the caller pinned sudo but the host only has the socket, report the
socket as a `rootEquivalenceFinding` — that is the honest framing, and it is
consistent with reporting sudoers wildcards.

---

## 5. Architecture objections

### 5.1 The shared model instance serialises all elevation (AGENTS rule 6)

The workflow runs `probe`/`run` against a fixed auto-created model instance
`modelName: sudo-run`. Every caller in the repo shares that instance, and swamp
locks per model. Two parent workflows elevating in parallel will contend on the
lock, and the `result`/`probe` data names collide (last writer wins — a parent
may read *another* parent's result). This is exactly the anti-pattern AGENTS.md
rule 6 warns about.

**Fix.** Either (a) make the child workflow's `modelName` unique per parent run
(a per-call instance), or (b) don't expose shared data — inline the operation as
a direct method call so the result is returned in the child run, or (c) accept
serialisation explicitly and document it. Option (b) is cleanest: the parent
does not need shared data if it consumes the child's output through the nested
workflow result.

Related: the plan's parent-side read `data.latest("sudo-run","result")` assumes
child data is visible to the parent by model name. Under **remote placement**,
where the child runs on a worker, that assumption must be verified — data may
live on the worker. The plan's §7.4/§12 assume local. Flagged as unverified.

### 5.2 A workflow is the wrong place for the capability ladder

The nested workflow is justified for the request ("a workflow others can call"),
but the ladder is *host detection*, which is stateful and cacheable. Wrapping it
in a workflow means every caller pays probe cost unless the probe is cached in
data — and the shared-instance problem above makes that cache unsafe. Consider
splitting: `probe` is a model method callers run once (or a report); `run` is
the only nested workflow. The plan half-does this already; make it explicit.

### 5.3 `commandLine` tokenizer is a liability

`run` accepts `command[]` (good) *and* `commandLine` split by "a strict argv
tokenizer". Hand-rolled shell tokenizers are a classic source of bugs, and the
claim "rejects metacharacters" gives false confidence: quoted arguments, globs,
escaped characters, and `--` handling all differ from the shell a user expects.
Either make `commandLine` a thin wrapper that is *documented as not a shell*
(and reject rather than guess when quoting is ambiguous), or require argv arrays
in the model method and only accept a string at the workflow boundary, where it
is passed to the chosen mechanism's *own* tokenizer (sudo/pkexec/ssh all take a
command line). Do not write a fourth shell parser.

### 5.4 Secrets in `command` are persisted

Swamp records workflow inputs and method arguments verbatim. A privileged
command line may embed a token/password. The plan says nothing. Document:
secrets must come through `vault.get()` inside the command's argv, not as the
`command` input; or add a `sensitiveArgs` mechanism that avoids echoing.

### 5.5 Exit-code and stream fidelity is unimplemented

Each mechanism mangles exit codes and streams differently (`ssh` 255 on its own
errors, `pkexec` 126/127, `run0` 1 for elevation failure vs program failure,
`sudo` 1 for auth vs program). The plan promises structured `exitCode` but gives
no normalisation table. Add one, and a `elevationFailed` boolean distinct from
`exitCode != 0`.

---

## 6. Smaller correctness objections

- `sudo -n -- <argv>`: modern sudo is fine, but document the minimum version;
  older sudo parsed `--` inconsistently.
- `doas -n`: correct non-interactive flag; but `doas` config (`/etc/doas.conf`)
  may be `permit nopass` scoped to a command — a bare `doas -n true` can succeed
  while `doas -n <target>` fails. Prove with the *actual* command shape or a
  representative one.
- `ssh` known_hosts: `StrictHostKeyChecking=yes` fails without a pin. Either
  require `sshKnownHosts` config or use `accept-new` explicitly and document
  the TOFU risk.
- E2's "bundled GTFOBins allowlist" is itself a curated dual-use artifact and a
  maintenance burden. Replace with a small fixed SUID→risk table or an external
  link; do not ship a weaponisable catalogue.
- E4 "package version of polkit (flag known-vulnerable ranges)" silently becomes
  a CVE tracker; keep it to a version-compare finding + remediation, never a
  reproduction.
- The plan says "no slow types" / deno check but never pins the exact deno
  invocations to the bundled binary in the milestones; minor.
- `probe` must **not** fail when no winner exists (otherwise the findings are
  unreachable). The plan says `probe` returns null but also writes data; make it
  explicit that `probe` succeeds with `winner: null` and only `run` fails.

---

## 7. Five more ways to go about it

These are additional *legitimate* elevation mechanisms, beyond the original
five. Each is host-granted by construction and each needs its own
`prove()`/argv builder — they are not drop-in aliases.

### A. Container runtime as a first-class family (the user's point, done properly)

Treat `docker` / `podman` / `nerdctl` / `ctr` / `cri-o` as one strategy family
with a sub-id per runtime. Two execution shapes:

- **Attach to an existing privileged container:** `docker exec -u 0 <container>
  <argv>` — cheapest, no new container, but only host-root-equivalent if that
  container is privileged or has a host mount. Prove against a *known*
  privileged container, or fall back to (next).
- **Launch a scratch host-access container:** `docker run --rm --privileged
  --pid=host --net=host -v /:/host --entrypoint /bin/sh <image@digest>
  -c 'chroot /host <argv>'`.

Guardrails: reject rootless daemons; pin image by digest; `--rm`; `--network
none` unless needed; a cleanup trap; and treat "docker group but daemon down"
as unavailable, not as a failure. Record the *runtime* in `strategyUsed`
(`docker-exec`, `docker-run`, `podman-run`, …).

### B. Kubernetes node access (privileged pod / `kubectl debug node`)

On any host where `kubectl` has `pods/exec` plus `nodes` access, run root on the
node:

```
kubectl debug node/<node> -it --image=<pinned> -- chroot /host <argv>
kubectl run swamp-root -it --rm --privileged --hostPID --hostNetwork \
  --overrides='{"spec":{"nodeName":"<node>","containers":[{"name":"c","image":"<pinned>","command":["chroot","/host","<argv>"],"securityContext":{"privileged":true},"volumeMounts":[{"name":"root","mountPath":"/host"}]}],"volumes":[{"name":"root","hostPath":{"path":"/"}}]}}'
```

`prove()` = create a short-lived pod that reads the host's `/etc/machine-id`.
RBAC is the grant; no cluster-admin ⇒ not available. Distinct from docker: it
targets the *cluster node*, not the local host, which matters when swamp runs on
a laptop but the target is the cluster.

### C. systemd manager / polkit over the **system bus** (not `run0`)

`run0` is one front-end; the underlying capability is a polkit-authorised
transient unit on the system bus:

```
systemd-run --system --uid=0 --pipe --wait <argv>
```

plus the session/manager variants `machinectl shell root@` (interactive only —
reject) and `busctl call … StartTransientUnit`. `prove()` = `systemd-run
--system --uid=0 --pipe --wait /usr/bin/id -u`. This is the same grant as
`run0` but reachable when `run0` is absent (older systemd) and it works
non-interactively over the bus when a polkit rule permits. Add as a separate
strategy, or fold into the polkit family with `run0` as the preferred argv.

### D. Out-of-band admin channel (the command never needs local privilege)

The cleanest answer when the local host *has no* grant: send the operation to a
system that already runs as root and returns output.

- **Cloud SSM / agent:** AWS SSM `SendCommand` (`AWS-RunShellScript`),
  Azure Run Command, GCP OS Config — the agent runs as root on the instance.
  There is already `@swamp/aws/ssm` in the registry; the strategy should invoke
  it, not shell out.
- **Configuration management / orchestration:** Ansible `become`, `bolt`, or a
  dedicated root endpoint. The grant is the inventory/agent, not a local tool.
- **A pre-installed swamp root agent:** a socket-activated systemd service
  (`RootElevation=yes`-style) that accepts a signed, allowlisted command. This
  is the *only* variant that removes the confused-deputy problem in §1, because
  the root side can enforce the policy rather than trusting the caller.

`prove()` = a no-op ping through the channel.

### E. Capability / namespace primitives (when the host already grants them)

Sometimes the process already holds `CAP_SYS_ADMIN`/`CAP_SETUID`, or a
pre-granted file capability exists:

- **Enter host namespaces:** `nsenter --target 1 --mount --uts --ipc --net
  --pid -- <argv>` — root on the host if the caller has the capability.
- **Re-enter as uid 0 without a setuid tool:** `setpriv --reuid=0 --regid=0
  --clear-groups <argv>` or `capsh --user=root -- -c '<argv>'` when the
  capability is held.
- **Pre-granted helper:** an operator-installed file-capability wrapper
  (`setcap cap_setuid,cap_setgid+ep /usr/local/bin/swamp-elevate`) that the
  strategy calls. The grant is the file capability; `prove()` = run it with
  `id -u`.

These overlap `pkexec`/`run0` in effect but are the right path on stripped-down
containers/appliances where no polkit/sudo exists but a capability was left
set. They are also the ones most worth reporting as *findings* when not
explicitly requested, since a lingering capability is exactly the kind of
misconfiguration the audit is for.

---

## 8. What to change in PLAN.md (priority order)

1. **Add a caller-trust model** (allowlist operations, or a consent gate) —
   without this the rest is unsafe. (§1)
2. **Drop legitimate/detection as the primary axis**; make every mechanism a
   legitimate strategy gated by caller trust + a `riskNote`. Keep only a
   negative list (brute force, interactive capture, CVE payloads). (§2)
3. **Promote container runtime to a first-class strategy family** with
   container-aware proof, rootless rejection, digest pinning, `--rm`, cleanup.
   This is the user's correction and it is right. (§4, §7A)
4. **Fix the false ordering premise**: host-adaptive ordering, container in the
   default, and a normalised exit-code/stream table. (§3, §5.5)
5. **Fix the argv recipes** (`run0` has no `--`; `ssh` has no `--`; pkexec can
   still prompt) and add per-mechanism `prove()` costs. (§3, §6)
6. **Resolve the shared model-instance lock/data-collision** (AGENTS rule 6) —
   unique instance per run, or return the result through the child run. (§5.1)
7. **Add** the five extra mechanisms (§7) as strategies: container family,
   k8s node, systemd/polkit bus, out-of-band (SSM/agent), capability/namespace.
8. **Require argv arrays** at the model boundary; drop or strictly scope the
   `commandLine` tokenizer; document secret handling. (§5.3, §5.4)
9. **Make `probe` succeed with `winner: null`** so findings are retrievable; make
   E2/E4 report "could not read" distinctly from "none found". (§6)
10. **Verify nested-workflow data visibility under remote placement** before
    relying on it. (§5.1)

---

## 9. Things the plan gets right (don't regress)

- Probe-only is a genuinely good default; the audit path has real value.
- First-win, single-execution — never run a mutating command twice via two
  mechanisms — is correct and should survive the rewrite.
- Separating the thin model from the callable workflow matches the repo's
  `systemd-service-audit` pattern.
- Failing loudly on a pinned-but-unavailable strategy is the right call.
- Full audit trail (mechanism, argv, uid, exit code, duration) is the feature
  that makes this acceptable to run at all.
