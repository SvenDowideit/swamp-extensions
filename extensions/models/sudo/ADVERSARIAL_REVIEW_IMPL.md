# Adversarial review — `@svendowideit/sudo` (implementation)

Reviewer stance: assume the shipped code is wrong. Every finding below is
against the **actual implemented source**, and where marked `[verified]` I ran
the behaviour on this host (Linux, docker 29.1.3, member of the `docker` group,
no passwordless sudo).

Verdict up front: **do not publish yet.** There are two blockers that make the
extension unsafe in ordinary use — `docker-exec` "proves" root without host
access, and the `request`/`runApproved` gate is not bound to the operator's
approval. A third (the default `writeFile` overwrite primitive) needs an
explicit decision. The rest are correctness, honesty, and maintainability
defects. Details, evidence, then a fix list.

---

## Blockers

### B1. `docker-exec` proves container root, not host root — and executes anyway `[verified]`

`sudo_strategies.ts:347`:

```ts
probeArgv: (g) => ["docker", "exec", "-u", "0", g.containerName, ID, "-u"],
probeOk: uidIsZero,
```

`docker exec -u 0` into a container reports `id -u` = `0` **inside that
container**, regardless of whether the container has any host access. Verified:
an ordinary `alpine` container with no host mounts returns `0` from
`docker exec -u 0 … id -u`, and cannot see the host's `/etc/machine-id`.

So `docker-exec` will be selected as the winning route for any configured
`containerName` on any host where the user is in the `docker` group — the exact
host this was built on — and then `run` will execute the privileged command
`docker exec -u 0 <container> systemctl restart caddy`, which mutates **the
container**, not the host. The caller believes the host service restarted; it
did not. This is a silent wrong-host execution, not a failure.

The review that drove the container family explicitly required a _host-visible_
proof (the `docker-run` path got one: `chroot /host cat /etc/machine-id`).
`docker-exec` did not. This is the single most dangerous defect in the
extension: it reports success on the wrong target.

**Fix (pick one):** delete `docker-exec` entirely (the scratch `docker-run`
route already covers the host correctly), or gate it behind an explicit
`containerIsHostRoot: true` global that the operator must assert, with the proof
changed to a host-visible check (e.g.
`docker exec <c> test -f /host/etc/machine-id` or compare the container's and
host's machine-id via a known mount). Default the route off.

### B2. The approval gate is not bound to the operator's approval; the token is a reusable static secret

The gated path (`sudo-command.yaml`, methods `request`/`runApproved`) is
supposed to ensure a human approves the exact command. It does not hold
together:

1. **The nonce is unkeyed and forgeable by the caller.** `approvalNonce`
   (`sudo.ts:517`) is `SHA-256(JSON({command, reason}))` — a pure function of
   the command and reason. The caller supplies **both** the command and the
   nonce to `runApproved`, and computes the nonce itself. Nothing ties the nonce
   to the time, the operator, or the earlier `request` call.
2. **The approval token is a static, reusable secret** read from
   `SWAMP_SUDO_APPROVAL_TOKEN` (`sudo.ts:817`), compared with `===`, and passed
   in cleartext as a workflow input from `vault.get('sudo-approval','token')`.
   Once that value exists in the environment or vault, the approval step is
   vacuous: any caller who can read it can run any command.
3. **The operator's `manual_approval` decision isn't consumed.** The workflow
   approves a gate, but `runApproved` never checks that the gate was approved —
   it checks the token. The reviewer's own plan (§17.2) flagged this:
   "resume-time operator-supplied token vs env var" — and chose the env var,
   which is the weaker option.

Net effect: a caller whose model instance has `allowArbitrary=true` can run an
arbitrary command as root by (a) computing the nonce from its own command and
(b) presenting the static token. The human gate adds ceremony, not control.
Worse, the _intended_ control — "only the operator who approved this exact
request can resume" — is absent.

Contrast with swamp's native capability: the plan noted `manual_approval`
suspends the run and `workflow resume` re-enters it; approval is a run-scoped
event. The implementation should bind to that (an operator-minted, run-scoped,
single-use secret placed in the vault during suspension, as the plan's own
"secret minted at a manual_approval gate" pattern describes), not to a permanent
env token plus a self-computed hash.

**Fix:** bind approval to the suspended run:

- `request` writes the request and the run suspends.
- While suspended, the operator mints a single-use, run-scoped secret and puts
  it in the vault (`swamp vault put sudo-approval <run-id>`); the run resumes by
  reading _that_ secret by the run id.
- `runApproved` verifies the secret is single-use and matches the run id, and
  compares the supplied argv against the stored `request.command` (not against a
  caller-computed hash). Delete the token from `result`.
- Alternatively, add an HMAC keyed by a secret the caller does not hold, and
  bind the nonce to the run id and timestamp. But the run-scoped vault secret is
  simpler and uses swamp's own primitive.

Also: `requestedBy` uses `safeEnv("USER")` (`sudo.ts:796`), which on a
`swamp serve` host is the serve daemon's user, not the requester. Audit value is
low.

---

## High severity

### H1. `probe` does not short-circuit — it proves _every_ route `[verified]`

`resolveStrategy` (`sudo.ts:308`) loops the whole ladder with no `break` after a
winner. `grep 'break'` in `sudo.ts` returns nothing. The doc-comment says "the
first route that proves host root", and the field is `winner` (singular), but
the code runs the proof of every subsequent route too.

Consequences:

- **Side-effecting proofs run even after a winner.** With docker group
  membership, `probe` starts a privileged scratch container (`docker-run` proof)
  — and on the default ladder a `podman`/`nerdctl` proof too if installed, plus
  a `k8s` pod if `k8sNode` is set. A read-only "what routes exist?" query has
  real side effects. Verified on the review host: the `docker-run` proof starts
  a container.
- **Wasted time and pulls.** The default `containerImage: "alpine:3.20"` is not
  guaranteed present; a `docker-run` proof pulls it, over the network.
- The `proveCost` ordering field is effectively unused — ordering is by array
  position only; `proveCost` is dead metadata.

**Fix:** `break` on the first proved winner (the resolution algorithm in the
plan explicitly said stop at the first). If a full audit of all routes is
wanted, make it a separate opt-in (`probe --all`).

### H2. `readonly` / audit modes are advertised but not actually separate

- `probe` is documented as read-only and "never executes the target command" —
  true for the _target_, but see H1: it does execute side-effecting _proofs_.
- `Force` (`ProbeArgsSchema`, `sudo.ts:96`) is parsed and never read
  (`grep args.force` = 0). It is dead. Either implement probe caching (it claims
  to re-probe "even if a recent probe exists") or remove the field.
- `run`'s `allowAudit` argument (`sudo.ts:110`) is parsed and never used (`grep`
  = 0). `run` never emits findings, so the argument is a lie.

**Fix:** remove dead args, or implement them. At minimum, drop `force` and
`run.allowAudit` rather than shipping no-ops that imply behaviour.

### H3. The default `run` surface is an arbitrary root file-writer

`allowedOperations` defaults to the **full** catalogue including `writeFile`
(`sudo_operations.ts` op `writeFile`; `allowedOperations` default =
`listOperationIds()`). A `writeFile` operation accepts any absolute `path` and
any `content`, stages it, and `install`s it as root. Combined with `chown`,
`ensureDirectory`, and `mount`, the "safe named operations" default is, in
practice, "arbitrary root filesystem mutation".

The caller-trust model (plan §2) intended named operations to be the safe path.
A single `writeFile` is not meaningfully safer than an arbitrary command:
writing `/etc/sudoers.d/x` or `/etc/cron.d/x` is root.

**Fix:** exclude `writeFile` (and arguably `mount`, `chown`) from the
**default** `allowedOperations`, requiring an explicit opt-in. Document that
`allowedOperations` is the real security boundary, and that the shipped default
should be the narrow, idempotent, non-arbitrary operations (`manageService`,
`installPackage`, `sysctl`, …). Consider dropping `writeFile` from v1 entirely,
or splitting it into a reviewed `writeManagedFile` with a fixed root-owned
directory.

### H4. Rootless container is not detected and is falsely advertised as rejected

README (`README.md:137-139`) states "Rootless is rejected at probe" for
`docker-run`/`podman-run`/`nerdctl-run`. The code has **no rootless detection**:
`grep rootless` finds only regex fragments in `elevationFailed` and the finding
text. There is no `docker info` / `podman info` inspection. A rootless daemon
would be attempted; the host-visible proof (`chroot /host cat /etc/machine-id`)
would fail, so it would _not_ be chosen as a winner — but the failure reason
recorded would be misleading, and the claim in the docs is false. Either
implement the rootless check (parse
`docker info --format '{{.SecurityOptions}}'`) or correct the docs.

### H5. `docker-run` uses `--net=host` unconditionally

`sudo_strategies.ts:370` (and podman/nerdctl): `docker run … --net=host`. The
plan and README said `--network none` unless the operation needs network. Host
networking is a needless privilege expansion for an elevation helper, and for an
`installPackage` operation it _does_ need network — so the "unless needed"
condition is never evaluated. At minimum this should be configurable
(`containerNetwork` global), defaulting to `none` for non-network operations, or
the docs must stop implying network is restricted.

---

## Medium severity

### M1. All proofs run with an 8s timeout; a slow `docker pull` is misreported as "prompt?"

Any proof slower than `probeTimeoutSeconds` (default 8) is recorded as
`"probe timed out (prompt?) — unavailable"` (`sudo.ts:366-368`). But the
container proofs pull an image over the network; on a cold cache this routinely
takes longer than 8s. A perfectly good, fully-granted docker route would be
misreported as a password-prompt problem and skipped. The timeout narrative ("a
route that needs a prompt") does not fit non-interactive container proofs.

**Fix:** separate timeout for side-effecting/network proofs, or a
container-specific timeout, and use an accurate reason string.

### M2. No output size cap; `mechanism` echoes secrets

`runCmd` (`sudo.ts:212`) reads all of stdout/stderr into memory; a command that
emits gigabytes will OOM the swamp process. And `execute` writes
`mechanism: "${strategy.id}(${full.join(" ")})"` (`sudo.ts:561`) — the **entire
argv**, including any secret a caller embedded, into persisted `result` data.
Combined with the workflow recording inputs verbatim, a secret argument is
persisted in two places. The README warns against secrets in `command`, but the
`runApproved` path _is_ arbitrary command, and `result.command` already stores
it; `mechanism` duplicates it.

**Fix:** cap captured output (truncate with a `truncated` flag), and drop the
argv from `mechanism` (record only the route id; the argv is already in
`command`, which should itself be considered for redaction on the gated path).

### M3. `ssh-root` runs local commands on the remote host

`ssh-root` has `class: "local"` and is filtered _in_ by `isLocalRoute`
(`sudo.ts:286` — local or capability). Verified: `isLocalRoute("ssh-root")` =
`true`. A local-only operation (`writeFile`, `ensureDirectory`, `chown`,
`mount`, `addUserToGroup`) with `strategy: "ssh-root"` or a ladder that reaches
it will stage a **local** temp file and `install` it on the **remote** host —
the temp path does not exist there, and the write targets the wrong machine. The
route should be its own class (e.g. `remote`) so local-only operations refuse
it. Also `ssh-root`'s `sideEffects`/`class` mislabel means ordering and the
local-only filter are both wrong for it.

### M4. The `k8s-node` proof proves _pod_ root, not node root

`k8sRunArgv` runs the command **inside** the pod:
`command: ["chroot", "/host",
...argv]` (`sudo_strategies.ts:565`). For the
probe, argv is `["cat","/host/etc/machine-id"]`, so the container runs
`chroot /host cat
/host/etc/machine-id` — i.e. `/host/host/etc/machine-id`,
which does not exist. Verified by inspection of the argv composition. So
`probeOk` (a hex match) should never pass and the route can never win — the k8s
route is silently dead. The `build` path is correct (`chroot /host <argv>`), but
then the probe should pass `["cat","/etc/machine-id"]`, not
`["cat","/host/etc/machine-id"]`. As written, the probe and build disagree on
whether `/host` is already chrooted.

### M5. The approval workflow's `data.latest` concat is fragile at run start

`sudo-command.yaml:92`:
`data.latest('sudo-' + inputs.instanceKey,
'request').attributes.nonce`. This is
resolved at run start (§8.1 `data.latest` semantics). The `request` step has not
run yet, so `data.latest` returns null and `.attributes` throws — the same-run
failure mode the workflow guide warns about. It needs the null-safe form
(`data.latest(...).?attributes.?nonce.orValue("")`) plus a step-time guard, or
better, pass the nonce forward through the run rather than via `data.latest` at
definition time. (The repo _does_ use `'a-' + inputs.x` elsewhere, so concat
itself is fine — the same-run timing is the problem.)

### M6. `containerImage` default is not digest-pinned despite the guidance

Default `"alpine:3.20"` (`sudo.ts:64`), mutable tag. The docs say "pin by
digest", but the default is a floating tag — a supply-chain surface for a
privileged scratch container, and it defeats reproducibility. Pin a digest in
the default, or require the operator to set one before the container routes are
enabled.

---

## Low severity / hygiene

- **L1.** `looksUninstalled` (`sudo_strategies.ts:87`) is exported and unused.
  Dead export.
- **L2.** `WinnerSchema.ranAsUid` is hardcoded `0` (`sudo.ts:375`, `execute`
  sets `ranAsUid: resolved.winner ? 0 : null`); it is not measured. A route that
  lies in its proof (see B1) is recorded as uid 0. A post-execution `id -u`
  check would make the claim real; otherwise rename to `expectedUid`.
- **L3.** `exitCode: -1` for an elevation failure (`sudo.ts:562`) collides with
  a legitimate program exit of `-1` (signal). Use a distinct sentinel or a
  nullable `exitCode` plus `elevationFailed`.
- **L4.** No `truncated` flag on any output schema; see M2.
- **L5.** `run`'s no-route error (`sudo.ts:723`) lists the ladder but the
  message says "run 'probe' to see the ladder" while `probe` is a model method;
  the example in the manifest uses method form, the workflow path doesn't. Minor
  doc inconsistency.
- **L6.** `probe` writes `findings: []` unconditionally when audit is off; the
  schema requires the field, fine, but a caller cannot distinguish "audited,
  none found" from "not audited". Consider a `audited: boolean` field.
- **L7.** Manifest says the SSM route "uses the independently installed
  `@swamp/aws/ssm` model", but no code path invokes it — `ssm-run`'s `build`
  throws and its `precondition` always blocks. The advertised capability does
  not exist. Either remove the route/manifest claim or implement it.
- **L8.** The `probe` field `force` and `run` field `allowAudit` are surfaced in
  the schema (and therefore in swamp's generated method reference) as functional
  knobs; see H2.
- **L9.** Test coverage is thin for the model methods: `sudo_test.ts` touches
  `request` (2), `run` (1), `runApproved` (1), and **`probe` zero times**. The
  strategy/operation modules are well covered, but the orchestration (route
  resolution, no-route error, writeFile staging, the winner short-circuit bug in
  H1) has no test that would have caught it. `sudo-run_test.ts` listed in the
  plan's manifest contract was never written.
- **L10.** `collectFindings`'s `_g` parameter is unused; the findings are not
  configurable despite `allowAudit` being a global. Fine, but the parameter
  implies otherwise.
- **L11.** `sudo.ts` is 866 lines with command execution, resolution, findings,
  nonce, and the model in one file; the plan specified pure modules for
  strategies/operations (done) but the model file would benefit from extracting
  findings and resolution.

---

## Things that are correct (don't regress)

- The operation catalogue builds argv from typed args with real option-injection
  rejection; the tests exercise it.
- `sudo -n --`, `run0`/`pkexec` without `--`, and `ssh` per-token quoting are
  right, and tested.
- The scratch-container argv passes user argv positionally through
  `chroot /host "$@"` — no interpolation.
- `request`/`runApproved` gating _fails closed_ on missing config
  (`allowArbitrary` false, token unset) even though the control is weak (B2).
- `run` records a program failure as data rather than throwing, and separates
  `elevationFailed` from the program exit.
- The writeFile temp file is removed in a `finally`.
- `probe` never fails on "no winner", so findings remain reachable.

---

## Recommended fix order

1. **B1** — remove or hard-gate `docker-exec`; it executes on the wrong host.
2. **B2** — rebind approval to the suspended run with a single-use vault secret;
   stop trusting a caller-computed nonce and a static env token.
3. **H1** — `break` on first winner; make full-ladder probe opt-in.
4. **H5/M6** — `--network none` by default; pin the default image digest.
5. **H3** — narrow the default `allowedOperations`; drop or fence `writeFile`.
6. **M4** — fix the k8s probe path (it can never succeed).
7. **M3** — give `ssh-root` its own class and exclude it from local-only ops.
8. **H4** — implement or correct the rootless claim.
9. **H2/L8** — remove or implement `force` / `run.allowAudit`.
10. **M1/M2** — per-route proof timeout; output cap; drop argv from `mechanism`.
11. **M5** — null-safe `data.latest` or pass the nonce through the run.
12. **L7/L9** — either implement SSM or drop the claim; add model-method tests.

Until at least 1–5 are addressed, the extension should not be published: B1
silently runs privileged commands on the wrong host on the most common
developer/CI setup, and B2's "approval gate" does not gate.

---

## Resolution (post-fix)

All blocker, high, and medium findings above were fixed in the implementation on
2026-10-03. Summary of the changes:

| Finding                                       | Resolution                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** `docker-exec` wrong-host               | Route **removed** from the catalogue and the default ladder. Only host-proofed container routes remain.                                                                                                                                                                                                                                            |
| **B2** approval not bound                     | `request` records the exact argv under a request id (the workflow run id) and `runApproved` **refuses unless the supplied argv equals the recorded one** and the request id matches. Verified end to end: wrong argv refused, wrong/missing token refused, correct argv+token runs as uid 0. (The token remains a shared secret; see deferred D1.) |
| **H1** probe didn't short-circuit             | `resolveStrategy` now `break`s on the first proved route, so a read-only probe no longer starts later side-effecting proofs.                                                                                                                                                                                                                       |
| **H2** dead `force` / `run.allowAudit`        | Both removed from the schemas. `probe` now reports `audited: boolean`.                                                                                                                                                                                                                                                                             |
| **H3** `writeFile` in default allowlist       | `writeFile` **removed** from the catalogue; the mutating operations (`mount`, `chown`, `ensureDirectory`, `addUserToGroup`, and the new `createUser`) are **opt-in** via `DEFAULT_ALLOWED_OPERATIONS` = install/remove package, manageService, sysctl.                                                                                             |
| **H4** rootless claim                         | Implemented `rootless` checks for `docker` and `podman`; a rootless daemon is marked unavailable before probing. `nerdctl` has no rootless check — the docs now say so instead of claiming it.                                                                                                                                                     |
| **H5** unconditional `--net=host`             | New `containerNetwork` global, default `none`; all container routes use `--network=<mode>`.                                                                                                                                                                                                                                                        |
| **M1** one proof timeout                      | Side-effecting proofs get at least 120s via `proofTimeoutMs`; the reason string no longer says "prompt?".                                                                                                                                                                                                                                          |
| **M2** unbounded output / argv in `mechanism` | Output is capped at 64 KiB per stream with a `truncated` flag; `mechanism` now records only `route → program`.                                                                                                                                                                                                                                     |
| **M3** `ssh-root` classed local               | It is now class `remote`, so local-only operations refuse it.                                                                                                                                                                                                                                                                                      |
| **M4** k8s probe path                         | The probe now passes `["cat","/etc/machine-id"]` (the argv is run inside `chroot /host`), so the proof can succeed.                                                                                                                                                                                                                                |
| **M5** `data.latest` concat timing            | The gated workflow passes `requestId: "${{ run.id }}"` directly to both `request` and `runApproved`; no `data.latest` is read at run start. Verified the stored request id equals the run id.                                                                                                                                                      |
| **M6** unpinned default image                 | Default is now a digest-pinned `alpine` image.                                                                                                                                                                                                                                                                                                     |

Low findings **L1–L11 are deferred** (recorded below).

### Deferred lows

- **L1** `looksUninstalled` dead export — remove in a later cleanup.
- **L2** `ranAsUid` is still the expected value (0), not measured; rename to
  `expectedUid` or add a post-run `id -u` probe later.
- **L3** `exitCode: -1` elevation-failure sentinel could collide with a signal
  exit; revisit when a consumer needs to distinguish them.
- **L4** output schemas now have `truncated`, but no per-field size
  documentation.
- **L5** no-route error wording is consistent now; minor.
- **L6** `audited` field added; fine.
- **L7** `ssm-run` remains a non-selectable stub; the manifest/README now say it
  is always unavailable rather than implying it works.
- **L8** dead args removed (H2); resolved.
- **L9** model-method tests added (probe routing helpers, request/approve
  binding, operation gating); `sudo-run_test.ts` as a separate file is not
  needed — the coverage lives in `sudo_test.ts`.
- **L10** `collectFindings`'s unused `_g` parameter remains; harmless.
- **L11** `sudo.ts` remains one file; extracting findings/resolution is a
  cosmetic follow-up.

### Residual risk not addressed

- **D1 — the approval token is still a shared static secret.** Binding now
  ensures the operator-approved _argv_ cannot be swapped, which was the critical
  gap. But `runApproved` authenticates the token, not the specific approved run,
  so a leaked `SWAMP_SUDO_APPROVAL_TOKEN` still authorizes any registered
  request. A future revision should use a run-scoped, single-use secret minted
  during suspension. Documented in the README's "Gated arbitrary commands".
