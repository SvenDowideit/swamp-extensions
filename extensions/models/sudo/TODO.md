# Adversarial Review Issues — @svendowideit/sudo (v2026.10.03.1)

Review date: 2026-10-03. Verified before review: 52/52 tests pass, `deno check`
clean, `swamp extension fmt --check` passes, both workflows validate,
meta-factory score 100 (A). No MECHANICAL (schema-write) failures.

**Status (2026-10-03):** MED-1, MED-2, and all DOC items below were applied
and re-verified the same day: 52/52 tests pass, `deno check` + `deno fmt`
clean, `swamp extension fmt --check` passes, both workflows validate,
meta-factory score 100 (A). The DEF items are still open.

Each issue lists: id, severity, where, what, and the chosen disposition
(documented / fixed / deferred). Code-level fixes were intentionally kept out of
scope for this pass per the caller.

## Medium — document before push

### MED-1 — Approval token is persisted in plaintext and the flow is replayable after a killed run

- **Where:** `sudo-command.yaml:96`
  (`approvalToken: "${{ vault.get('sudo-approval', run.id) }}"`),
  `sudo.ts:1052-1059` (consumption after execution), README "Gated arbitrary
  commands".
- **What:** The `run` step materializes the approval secret into a method input,
  so it is recorded verbatim in the run snapshot
  (`swamp records arguments verbatim` — the README's own caveat). Because
  consumption (`deleteResource("pending")` + vault delete) happens only _after_
  `addRoute`, a run killed mid-execution (or a failed elevation) leaves the
  request record, the minted secret, **and** the plaintext token in the run
  snapshot — the approved command is replayable by anyone with repo access.
- **Disposition: FIXED in docs** (manifest CONFIGURE + README gated-commands and
  caveats): the token is operator-supplied and lands in run history; single-use
  is guaranteed by _completed_ runs only; operators who keep repo access
  privileged, rotate/delete the minted secret after a killed run. (Deferred code
  fix: drop `approvalToken` and trust the model-side `vaultService.get`
  binding — see DEF-7.)

### MED-2 — Non-local operations execute on whatever host the route elevates, not the caller's host

- **Where:** `sudo_operations.ts` (`installPackage`, `removePackage`,
  `manageService`, `sysctl` all `localOnly: false`), `sudo_strategies.ts`
  `ssh-root` (class `remote`), `k8s-node` (class `orchestrator`), README
  "Caveats" + manifest RUN/CONFIGURE.
- **What:** With `sshHost` configured, `manageService` restarts the _remote_
  unit and `sysctl` writes the _remote_ kernel knob — with `k8sNode` set, on the
  cluster node — while the workflow docstring says "the extension finds the
  first route **the host** has already granted". Container routes got a
  remote-daemon refusal for exactly this confusion; the ssh/k8s routes got only
  `isLocalRoute` filtering for `localOnly` operations, which does not help the
  non-local ones above.
- **Disposition: FIXED in docs** (README Caveats + workflow descriptions): when
  a non-local operation resolves to a `remote`/`orchestrator` route it acts on
  `sshHost`/`k8sNode`, not the machine swamp runs on; pin `strategy` or omit
  `sshHost`/`k8sNode` to keep operations on the local host.

## Low / small — most documented in this pass

### DOC-1 — The approval vault itself is never created anywhere

- **Where:** manifest RUN (`swamp vault put sudo-approval ...` in the README
  gated-commands section), `sudo-command.yaml:96`.
- **What:** Both docs `vault put` into `sudo-approval`, and the model defaults
  `approvalVault` to it, but no doc says how the vault comes to exist — the
  first gated run fails at the gate with no actionable message.
- **Disposition: FIXED in docs** — README gated-commands now shows
  `swamp vault create local_encryption sudo-approval` before the `vault put`;
  manifest CONFIGURE mentions the vault must exist.

### DOC-2 — `sudo -n true` can succeed from a _cached_ credential timestamp

- **Where:** `sudo_strategies.ts` `sudo-n` `riskNote` (README Strategies table
  too).
- **What:** Probe success is not NOPASSWD-only; a cached sudo timestamp also
  proves it, so route selection becomes time-of-day dependent (works now, fails
  ~15 min later) and probing refreshes the cache.
- **Disposition: FIXED in docs** — riskNote and README note cached-timestamp
  nondeterminism; use `strategyOrder` without `sudo-n` or pin `strategy` for
  determinism.

### DOC-3 — "cross-platform" pitch overstates scope

- **Where:** manifest `WHAT IT DOES` line 1, README line 9.
- **What:** `platforms:` is linux-only; "cross-platform" reads as cross-OS.
- **Disposition: FIXED in docs** — manifest pitch, README, and both workflow
  descriptions now say Linux.

### DOC-4 — `sudo-command` default `instanceKey` collides for concurrent gated runs

- **Where:** `sudo-command.yaml` `instanceKey` default `command-default`; README
  "Concurrency".
- **What:** Two concurrent gated runs on the default instance clobber the single
  `pending` record and fail closed with the opaque "No registered request"
  error. README already warns; the workflow default still invites the collision.
- **Disposition: FIXED in docs + workflow default** — `sudo-command.yaml` now
  defaults `instanceKey` to `"${{ run.id }}"` (the request id already is the run
  id, so an instance per run is the collision-free shape). README Concurrency
  section updated to say the command workflow defaults to the run id. Deferred
  code note: the `sudo-run` default stays `default` because `result`/`probe`
  writes are per-instance benign.

### HYG-1 — Test fixture used a private-range IP literal

- **Where:** `sudo_test.ts:233` (`tcp://10.0.0.9:2375`) — published via
  `additionalFiles`.
- **What:** RFC 1918 address in a published fixture; the push-time analyzer only
  warns on `.md`/`.txt`, so this manual check exists precisely for it.
- **Disposition: FIXED (code)** — fixture now uses RFC 5737
  `tcp://192.0.2.9:2375`; 52/52 tests pass. Note: changing the file moved the
  content hash, so the adversarial-review report was re-recorded at the new
  push-reported path after this edit.

### DEF-1 (deferred, code) — `readCapped` swallows stream errors as `truncated: false`

- **Where:** `sudo.ts:272` (empty catch). A silently erroring stream returns a
  partial capture marked not-truncated.
- **Disposition: deferred** — set `truncated = true` in the catch path.

### DEF-2 (deferred, code) — `elevationFailed` stderr patterns are over-broad

- **Where:** `sudo_strategies.ts` doas `/permission denied/i`,
  `nsenter`/`setpriv` `/operation not permitted|permission denied/i`, `ssh-root`
  `/no such file/i`.
- **What:** A target program legitimately failing with those messages
  (post-elevation) is recorded as `elevationFailed: true, exitCode: -1`.
  `mechanismExitCode` keeps the truth; callers branching on `exitCode` get `-1`.
- **Disposition: deferred** — scope patterns to mechanism-prefixed errors
  (`doas:`, `ssh:`, `setpriv:`) or drop the loose patterns.

### DEF-3 (deferred, code) — `collectFindings` is not injectable and untested

- **Where:** `sudo.ts:546-667`; uses real `runCmd`, ignoring the `context._exec`
  seam everything else honors.
- **What:** Untested; runs against the real host whenever `allowAudit=true`.
- **Disposition: deferred** — thread an `exec`/`stat` seam through
  `collectFindings` and add tests (container-group, sudoers NOPASSWD,
  world-writable stat, polkit/LXD count paths).

### DEF-4 (deferred, code) — 18 exported symbols missing JSDoc

- **Where:** `sudo_strategies.ts` (13), `sudo_operations.ts` (5), `Exec`
  (`sudo.ts:216`); from `deno doc --lint --json`.
- **Disposition: deferred** — add JSDoc while next touching these files. The
  meta-factory check already passes, so this is hygiene, not a gate.

### DEF-5 (deferred, style) — `assertAbsoluteNoSymlinkIntent` promises a symlink check it does not perform

- **Where:** `sudo_operations.ts:54-62` (absolute path + control chars only).
- **Disposition: deferred** — rename `assertAbsolutePath`, or implement a real
  symlink policy.

### DEF-6 (deferred, code) — probe logs the full ladder at `info`

- **Where:** `sudo.ts:835-840` (probe logs every route at info; scheduled
  workflows get a wall of route noise).
- **Disposition: deferred** — demote per-route entries to `debug`, keep the
  winner (or the "no-granted-route" summary) at `info`.

### DEF-7 (deferred, code) — drop the plaintext `approvalToken` argument

- **Where:** `sudo-command.yaml:96` (`approvalToken: "${{ vault.get(...) }}"`),
  `sudo.ts` `RunApprovedArgsSchema.approvalToken`.
- **What:** Passing the token as an argument persists it in run history (the
  root cause of MED-1's plaintext finding). The model already reads the same
  secret via `vaultService`, and the `manual_approval` gate itself is the human
  proof — so the caller-supplied argument is arguably redundant.
- **Disposition: deferred** — remove the `approvalToken` argument and rely on
  the `vaultService.get` binding (requires verifying swamp always populates
  `vaultService` for model methods, including `swamp serve`/fleet runs, before
  removing the caller-supplied path).
