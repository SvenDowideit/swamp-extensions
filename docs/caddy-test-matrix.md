# Caddy test matrix — planning & progress tracker

Master document for the caddy behavioural/regression test programme and the
fleet that builds it. Detail lives in the two companion docs:

- issue log + regression tests: `docs/caddy-setup-upgrade-issues-and-test-plan.md`
- full scenario prose: `docs/caddy-scenario-test-matrix.md`

This file is the source of truth for **status**. Update the Status columns and
the Progress board as work lands.

Status legend: `todo` · `wip` · `blocked` · `review` · `done` (merged) ·
`n/a`.

---

## 0. Invariants (every scenario asserts these)

- **I1 — never lose intent.** Desired state is persisted regardless of whether it
  can be applied now.
- **I2 — always serve something.** Reconcile never rejects the whole config; it
  applies as much as the host allows (degrading ports if needed).
- **I3 — never lie.** Every reported fact is **measured**; when it can't measure,
  it says so.

## 0.1 Conventions (fleet + PRs)

- Branch per item: `caddy/<item-id>` (e.g. `caddy/f0-dind-grants`).
- Every executing agent runs tests **only** through `@svendowideit/test-factory`
  (dind); never the host.
- PR template: lists closed issue IDs + the test-factory run/report evidence.
- Gate: a PR touching `caddy.ts`/workflows must include a test change.
- Serialiser (agent) rebases stacked caddy-behaviour PRs in a fixed order.
- Ledger: each worktree writes `.worktree-status/<branch>.json`.

---

## 1. Fleet plan

| Phase | Scope | Files | Parallelism |
| ----- | ----- | ----- | ----------- |
| **F0** | test-factory infrastructure (dind, per-test grants, ACME stub, scaffolding) | `extensions/test-factory/**`, `scripts/fleet/**` | serial (one branch per item) |
| **F1..Fn** | caddy behaviour scenarios (matrix groups) | `extensions/models/caddy/**` + `test-factory.yaml` | stacked (shared `caddy.ts`) |
| **F∞** | bug-regression tests | `extensions/models/caddy/test-factory.yaml` | parallel (no `caddy.ts` edits) |

Oversight: chunked `task` calls (plan→implement→dind-test→PR); shared status
ledger; WIP commits as the audit trail; test-factory report as definition of
done; optional swamp workflow wrapper with `manual_approval` before each PR.

---

## 2. F0 — infrastructure (blocker for everything)

| ID | Item | Branch | Status | Verify |
| -- | ---- | ------ | ------ | ------ |
| F0.1 | dind grants: `docker-rootful` implemented — installs + starts an **in-harness** `dockerd`, waits for `/var/run/docker.sock`, adds the harness user to the `docker` group; harness container is run `--privileged` when a `docker-*` grant is present | `caddy/f0-dind-grants` | review (implemented; dind run pending) | grant renders a real script (unit ✓); `installCaddy` under this grant makes `@svendowideit/sudo probe` find the `docker-run` route |
| F0.2 | harness runs every phase inside the dind container (own daemon, own ports/systemd) | `caddy/f0-b1-harness` | done | non-root harness **fixed** (B1); `runAs: tester` acceptance test passes end-to-end; docker-rootful in-harness `dockerd` proven |
| F0.3 | one documented "run one scenario in dind, emit report" command | `caddy/f0-run-command` | done | README: "Running one scenario in dind (the one command agents run)" — the `test` command, its `result`/`rollup` data pointers, `--input phases=tests`, `keepOnFailure`, and the CI workflow; grants section documents `docker-rootful` |
| F0.4 | per-test `runAs`/`grants` in `test-factory` (group tests by resolved grant; one container per group) | `caddy/f0-per-test-grants` | done | `TestSpec.runAs`/`grants` parsed; `groupTestsByGrant` splits; the scenario loop runs the first group with the full phase set and extra groups as `tests`-only under suffixed result names; 177 tests pass |
| F0.5 | ACME/DNS stub service (toggle accept/reject/delay) for cert + DNS timing tests | `caddy/f0-acme-stub` | done | `test/stub/` fixture (Python HTTP stub: accept/reject/delay/down via `/ctl?mode=`), built + validated container-to-container; documented for `acme_ca` (C2) + `issuer=internal` (issued); services test guards it |
| F0.6 | fleet scaffolding: `scripts/fleet/{start,test,pr,board}` + `.worktree-status/` ledger + board view | `caddy/f0-fleet-scaffold` | done | scripts + `scripts/fleet/README.md`; `start`/`board` verified (worktrees under `FLEET_WORKTREE_DIR`, ledger written, board renders); `pr` pushes over HTTPS and targets `main` |
| F0.7 | conventions doc + PR template + branch/gate checks | `caddy/f0-conventions` | done | `docs/fleet-conventions.md` (stresses one-worktree-per-agent + PRs-to-main), `.github/pull_request_template.md`, and `scripts/fleet/gate` (+ tests) — fails a behaviour change with no test change |

F0 gate: a trivial candidate (e.g. `@svendowideit/disk-auditor`) boots, runs and
passes **inside dind**, proving the fleet can rely on it.

### Blockers

| ID | Blocker | Evidence | Owner |
| -- | ------- | -------- | ----- |
| ~~**B1**~~ | **Resolved.** The non-root harness (`runAs: tester`) produced no result. Two permission bugs plus an env bug: (a) the read-only bundle at `/tf-scripts` was a 0700 temp dir owned by the host uid, unreadable by the container's non-root uid → `chmod 0o755`; (b) the result dir `/tf` was chowned by the harness to the non-root uid, leaving the host unable to read `result.json` → `chmod 0o755`; (c) `su` reset the environment, dropping `TF_DROPPED` → `su -p … -c "TF_DROPPED=1 /bin/sh $0"`. Unit-tested + proven by a `runAs: tester` acceptance run. | `runAs: tester` test passes; 173 test-factory tests pass | done |
| ~~**B2**~~ | **Resolved.** `@svendowideit/sudo` could prompt for a password from an automated run: `runCmd` inherited the terminal (stdin), and the `systemd-run` route lacked `--no-ask-password`, so polkit's text agent prompted. Fix: `Deno.Command` stdin `null` for every probe/route (EOF, never the TTY) and `--no-ask-password` on `systemd-run` (matching `run0`); a required credential now fails fast as `unavailable`. Unit-tested. | `@svendowideit/sudo` 2026.10.11.1 | done |

---

## 3. Regression matrix (from the 36-hour issue log)

| ID | Scenario | Test | Status |
| -- | -------- | ---- | ------ |
| R-A1 | upgrade chain terminates at the model version | quality gate | done |
| R-A2 | extension version comes from `manifest.yaml`, not the model/instance version | T1 | todo |
| R-A4 | `extensionFile` resolves the manifest in the **pulled** layout | T1 | todo |
| R-A5 | only shipped workflows are referenced | T9 | todo |
| R-B1 | setcap delegates to `@svendowideit/sudo` (no direct sudo) | T2 | todo |
| R-B2 | setcap attempted exactly once | T8 | todo |
| R-B3 | capability takes effect (service restarted after setcap) | T2/E10 | todo |
| R-B4 | no interactive prompt when no route is granted | T3 | todo |
| R-C1 | config never rejected on a privileged-port bind failure | T2/T3 | todo |
| R-C2 | `dnsRecords` without a provider never rejects reconcile | T4 | todo |
| R-C4 | status page written by default, incl. existing models | T5 | todo |
| R-D1 | docs reference only shipped workflows | T9 | todo |
| R-D2/D3 | `tls` before `dns`; provider inferred | T7 | todo |
| R-D6 | `startService` waits for the admin API | T2 | todo |
| R-E1..E4 | reporting is measured, never fabricated | T3/T6 | todo |
| R-F2 | setup discovery message is not upgrade-shaped | (cosmetic) | todo |

## 4. Behavioural scenario matrix

### 4.1 Elevation availability

| ID | Scenario | Status | Test |
| -- | -------- | ------ | ---- |
| E1 | passwordless sudo → cap granted, `:443` binds | todo | T2 |
| E2 | doas route | todo | T2b |
| E3 | interactive-only → no prompt, fail-closed, degrade | todo | T3 |
| E4 | no route → fail-closed, no fabricated https | todo | T3 |
| E5 | root / held-capability route | todo | T2c |
| E6 | binary pre-granted (held capability) | todo | T2c |
| E7 | upgrade re-grants after binary replace | todo | T2d |
| E8 | upgrade, no route → degrade | todo | T3b |
| E9 | setcap once | todo | T8 |
| E10 | cap takes effect on the running process | todo | E10 test |
| E11 | grant later → ports move back up | todo | T2e |

### 4.2 Partial configuration

| ID | Scenario | Status |
| -- | -------- | ------ |
| P1 | only baseDomain | todo |
| P2 | only email | todo |
| P3 | neither | todo |
| P4 | DNS plugin, no env file | todo |
| P5 | dnsRecords, no provider → skipped not rejected | todo |
| P6 | provider then records apply | todo |
| P7 | HTTP-01 impossible (NAT) | todo |
| P8 | apex pruned from subjects | todo |
| P9 | route derives subject + A record | todo |
| P10 | derivation off | todo |
| P11 | invalid email pre-flight | todo |

### 4.3 Drift / conflict

| ID | Scenario | Status |
| -- | -------- | ------ |
| M1 | listens edited → applied | todo |
| M2 | autoHttps toggled | todo |
| M3 | hand-removed swamp route → drift + restore | todo |
| M4 | stale binary (new plugin) → rebuild | todo |
| M5 | TLS changed → applied | todo |
| M6 | two-model route conflict named | todo |
| M7 | two-model TLS conflict named | todo |
| M8 | separate `serviceName` | todo |
| M9 | scratch instances ignored | todo |
| M10 | serviceName collides with foreign service | todo |

### 4.4 Foreign (non-swamp) config injection

| ID | Scenario | Status |
| -- | -------- | ------ |
| F1 | hand-added route preserved | todo |
| F2 | hand-edited Caddyfile preserved | todo |
| F3 | foreign `autosave.json` merged | todo |
| F4 | foreign listener untouched | todo |
| F5 | hand-removed swamp route restored | todo |
| F6 | older no-`@id` status route not duplicated | todo |

### 4.5 DNS reconciliation + timing

| ID | Scenario | Status |
| -- | -------- | ------ |
| D1 | records written via rfc2136 | done (existing suite) |
| D2 | edit/prune/remove RRsets | done (existing suite) |
| D3 | TTL applied | todo |
| D4 | explicit applyDnsRecords, no provider → clear error | todo |
| D5 | credential failure enriched | todo |
| D6 | authoritative vs propagation (no false reachable) | todo |
| D7 | replace existing value | todo |
| D8 | removal of absent record is a no-op | todo |
| D9 | provider inferred | todo |
| D10 | multi-field provider mapping | done (existing suite) |

### 4.6 Certificate reconciliation + timing

| ID | Scenario | Status |
| -- | -------- | ------ |
| C1 | `issuer=internal` serves TLS synchronously | todo |
| C2 | ACME unreachable → configured-not-issued reported | todo |
| C3 | async not-yet → issued transition reported | todo |
| C4 | HTTP-01 unreachable reported | todo |
| C5 | wildcard requires DNS-01 reported | todo |
| C6 | subject with no route not requested | todo |

### 4.7 Bind / port modes

| ID | Scenario | Status |
| -- | -------- | ------ |
| B1 | cap → `:443,:80` | todo |
| B2 | no cap → `:8080,:8443` plain HTTP, still serves | todo |
| B3 | cap later → move up | todo |
| B4 | foreign listener on `:80` | todo |
| B5 | autoHttps=off high ports | todo |
| B6 | unix-socket admin | todo |

### 4.8 Service lifecycle

| ID | Scenario | Status |
| -- | -------- | ------ |
| S1 | no unit → clear error | todo |
| S2 | unstarted → start + wait for admin API | todo |
| S3 | active + unchanged → no-op | todo |
| S4 | stopped → start; gap reports inactive | todo |
| S5 | stale autosave crash-loop → no false success | todo |
| S6 | unit regenerated → process reloads env | todo |
| S7 | admin API down → "could not measure" | todo |

### 4.9 Multiple models / instances

| ID | Scenario | Status |
| -- | -------- | ------ |
| X1 | routes union | todo |
| X2 | separate `serviceName` | todo |
| X3 | remote `target` | todo |
| X4 | `reconcile=false` | todo |

### 4.10 Workflows

| ID | Scenario | Status |
| -- | -------- | ------ |
| W1 | `caddy-setup` one command | todo |
| W2 | upgrade auto-discovers single model | todo |
| W3 | several models → list + stop | todo |
| W4 | already up to date → DONE, no gate | todo |
| W5 | approval gate / reject | todo |
| W6 | re-run is a no-op | todo |

### 4.11 Reporting honesty (assert in every run)

| ID | Check | Status |
| -- | ----- | ------ |
| R1 | no fabricated `https://` when degraded | todo |
| R2 | reported listens == live config | todo |
| R3 | capability line == `getcap` | todo |
| R4 | status-page version/plugins == binary | todo |
| R5 | "ready" only when measured-ready | todo |
| R6 | admin API down → no serving claim | todo |

### 4.12 Idempotency / retry

| ID | Scenario | Status |
| -- | -------- | ------ |
| I1 | second run no-op | todo |
| I2 | interrupted install converges | todo |
| I3 | async DNS/cert converge | todo |

---

## 5. Progress board

| Phase | Done / Total | Notes |
| ----- | ------------ | ----- |
| F0 | 7 / 7 | **F0 complete** — test-factory infra ready for the fleet. Next: F1..Fn (caddy behavioural matrix) |
| Regression | 1 / 16 | A1 fixed (quality gate) |
| Behavioural | 3 / ~86 | D1/D2/D10 covered by the existing suite |

**Blockers:** none open (B1 and B2 resolved).

_(Update this board as items land; keep it the at-a-glance summary.)_
