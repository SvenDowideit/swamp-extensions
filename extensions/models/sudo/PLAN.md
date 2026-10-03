# PLAN — `@svendowideit/sudo`

A swamp extension that provides a **callable workflow** any other workflow can
invoke to run a single command with elevated (root) privileges on the host where
the model method executes, **without assuming `sudo` exists**.

Status: **draft for review** — not yet scaffolded.

---

## 1. Goal

Other swamp workflows constantly need one root-only action: install a package,
write to `/etc`, restart a system service, bind a privileged port, `chown` a
file, `mount`. Today each extension either inlines its own `sudo` shell-out (and
breaks on hosts without `sudo`, or with passwordless sudo disabled) or gives up.

This extension makes elevation a **first-class, reusable, auditable primitive**:

- A single **callable workflow** `@svendowideit/sudo-run` (task type `workflow`)
  that a parent workflow invokes with a command string.
- It resolves an **ordered list of legitimate, admin-sanctioned elevation
  mechanisms** and uses the first one that works — no assumption that `sudo` is
  installed.
- It reports **which mechanism succeeded**, the exit code, stdout/stderr, and
  the identity it actually ran as — as swamp data the caller can branch on.
- It **fails cleanly and diagnostically** when no sanctioned path exists, rather
  than silently doing the wrong thing.

### Why a workflow and not just a model method

The request is specifically for a workflow other workflows can call, so the
canonical entry point is a workflow. Inside it, the work is done by a model type
(`@svendowideit/sudo`) so the logic is reusable directly as a model method too,
and so the callable workflow is just a thin, typed shell around it (matching the
`@svendowideit/systemd-service-audit` pattern already in this repo).

---

## 2. Non-goals and safety scope (read first)

This extension is a **legitimate administration tool**, not a privilege
escalation toolkit.

- **Legitimate strategies may execute.** They only succeed when the operator or
  the host has *already granted* the privilege (sudoers NOPASSWD, doas `nopass`,
  a polkit rule, an ssh root key, etc.). If the grant is absent, they fail — we
  do not defeat it.
- **Exploit/enumeration strategies are detection-only.** Container-runtime
  sockets, SUID/`sudo -l` misconfig, writable root-owned files, and polkit/
  LXD surfaces are **inspected and reported as findings** — never exploited.
  They are **disabled by default**, emit no privilege change, and must be
  explicitly opted into (`allowAudit=true`). The output is a hardening report,
  not a shell.
- **No credential brute force, no CVE payloads, no interactive password
  capture.** Password-based paths are out of scope; only pre-established,
  non-interactive grants are used.
- **The caller supplies the command verbatim.** This extension does not
  interpolate untrusted workflow input into a shell string. `command` is passed
  as an argv array to an argv-array executor (`--` terminator), never
  `sh -c "<user string>"` built by concatenation.
- **Dry-run is the default for probe-only use.** `probe` never runs the target
  command; `run` is the only method that executes.

If a reviewer wants a pure "am I root-capable?" audit with zero elevation, they
run `probe` and never touch `run`.

---

## 3. Extension shape

Directory: `extensions/models/sudo/`

| File | Purpose |
| ---- | ------- |
| `manifest.yaml` | `@svendowideit/sudo` — model + callable workflow + README/LICENSE. |
| `sudo.ts` | Model type `@svendowideit/sudo`: global args, `probe`, `run` methods, pure strategy/parse helpers. |
| `sudo_ladder.ts` | Pure, unit-testable strategy catalogue: definitions, detection predicates, argv builders. No I/O. |
| `sudo-run.yaml` | Callable workflow `@svendowideit/sudo-run` (created with `swamp workflow create`). |
| `sudo_test.ts` | Unit tests for the pure helpers and argv builders. |
| `README.md` | Extender/maintainer doc; every method named. |
| `LICENSE.txt` | MIT (matches repo). |

Model type name: `@svendowideit/sudo`
Workflow name: `@svendowideit/sudo-run`

The model is executed by the workflow via **direct type execution**
(`modelType` + `modelName`), so a caller never has to pre-create a model
instance — same as `systemd-service-audit`.

---

## 4. Architecture

```
parent workflow
  └─ task: workflow  →  @svendowideit/sudo-run
        jobs:
          probe  → model @svendowideit/sudo  method probe   (enumerate ladder)
          run    → model @svendowideit/sudo  method run     (execute via winner)
                 dependsOn probe
        └─ writes data: "<modelName>/result" { strategyUsed, exitCode, stdout, ... }
  parent reads: data.latest("<modelName>", "result").attributes.strategyUsed
```

Because the child workflow runs in the same swamp repo/host as the parent's
local steps, "the host the model method is executing on" is exactly where the
elevation happens. (If a step is placed on a remote worker, the child workflow
runs on that worker too — the elevation is host-correct by construction.)

---

## 5. Strategy catalogue

The ladder is ordered. `probe` walks it top-to-bottom, records availability and
capability, and stops at the first **sanctioned, non-interactive** mechanism that
actually proves root. `run` uses the recorded winner unless the caller pins
`strategy`.

Each strategy has: `id`, `kind` (`legitimate` | `detection`), `detect()`
(installed + configured?), `prove()` (cheap no-op `id -u` == 0 check), and
`argv(command)` (the exact argv to execute).

### 5.1 Legitimate strategies (executed when sanctioned)

| # | id | Tool / setup | Detection | Execution argv | Notes |
| - | -- | ------------ | --------- | -------------- | ----- |
| L1 | `sudo-n` | `sudo` with NOPASSWD / cached credential | `command -v sudo` and `sudo -n true` succeeds | `sudo -n -- <argv>` | The common case. `-n` guarantees it never hangs on a prompt. If `sudo -A` (askpass) is configured we add a sub-path `sudo-askpass` that sets `SUDO_ASKPASS` to a configured helper; still non-interactive. |
| L2 | `doas-n` | OpenBSD/FreeBSD/Linux `doas` with `nopass` | `command -v doas` and `doas -n true` succeeds | `doas -n -- <argv>` | Common on Alpine/BSD and hardened Linux; no sudo at all. |
| L3 | `pkexec` | polkit `org.freedesktop.policykit.exec` granted (no auth or `auth_admin_keep`) | `command -v pkexec` and `pkexec --disable-internal-agent /usr/bin/id -u` returns `0` | `pkexec --disable-internal-agent -- <argv>` | `pkexec` does **not** accept `--` before the program on all versions; argv is assembled as `pkexec <program> <args...>` after validating the program is absolute. `--disable-internal-agent` forbids a GUI prompt, keeping it non-interactive. |
| L4 | `run0` | systemd v256+ `run0` (polkit-backed, no setuid) | `command -v run0` and `run0 --no-ask-password /usr/bin/id -u` returns `0` | `run0 --no-ask-password -- <argv>` | The modern distro default replacing sudo; uses the systemd manager. |
| L5 | `ssh-root-loopback` | key-based `ssh root@<host>` (`PermitRootLogin prohibit-password`) | an ssh host alias / host from global args resolves and `ssh -o BatchMode=yes root@… id -u` returns `0` | `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@<host> -- <quoted argv>` | Covers hosts where root is only reachable over ssh (containers, jump hosts, appliances). Command is passed as a single properly quoted argument; `BatchMode=yes` forbids prompts. |

Optional legitimate extras, considered but deliberately **not in the default
ladder** (documented as opt-in): `systemd-run --uid=0` over the system bus
(overlaps `run0`), `machinectl shell` (interactive), `su` (needs a TTY/password
— violates non-interactive), `ssh` with a non-root user + sudo (redundant with
L1). Kept out to avoid a ladder that surprises the operator.

### 5.2 Detection-only strategies (reported, never executed)

These are the classic "root-equivalent surface" checks that any host-hardening
audit performs. They set a `finding` in the probe output with `severity` and
`remediation`. **No command is run as root.** All are gated behind
`allowAudit=true`.

| # | id | Surface | What we detect (read-only) | Why it matters |
| - | -- | ------- | -------------------------- | -------------- |
| E1 | `container-socket` | Docker / containerd / Podman / CRI-O socket access | `docker info`, `ctr version`, `nerdctl`, `podman info` socket reachability, and whether the user is in `docker`/`containerd`/`podman` group | Membership in a container-runtime socket group is root-equivalent and is the most common real escalation surface on dev/CI hosts. Reported so it can be revoked. |
| E2 | `sudo-misconfig` | Over-permissive sudoers / SUID-GTFOBins | `sudo -n -l` parse (NOPASSWD entries, wildcards, `env_keep`, `SETENV`), and an inventory of SUID binaries cross-referenced against a bundled GTFOBins allowlist | A single `NOPASSWD: /usr/bin/find` or SUID `vim` is root. Reported as an exact, actionable line. |
| E3 | `writable-root-paths` | Writable root-owned files in high-risk locations | world/user-writable checks on `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, `/etc/sudoers.d/*`, `/etc/cron*`, `/etc/systemd/system/*` and PATH entries | A writable root-owned file or a writable PATH dir is an immediate escalation. |
| E4 | `polkit-lxd-surface` | polkit rules / LXD-LXC groups / exposed `pkexec` version | presence of permissive `.rules` under `/etc/polkit-1/rules.d`, membership in `lxd`/`lxc`, and package version of `polkit` (flag known-vulnerable ranges only — no exploit) | Polkit and LXD group membership are well-known elevation surfaces; version alone is a finding to patch. |

E-strategies are **informational**: they never change `strategyUsed`, never run
the target command, and never fail the run (they are `allowFailure` findings,
reported at the end).

---

## 6. Resolution algorithm

```
probe(command, strategy=auto, allowAudit=false):
  1. Build candidate order:
       - pinned strategy if strategy != "auto" (single candidate)
       - else legitimate ladder ordered by global `strategyOrder` (default L1..L5)
  2. For each legitimate candidate:
       a. detect()              -> { installed, configured, reason }
       b. if installed/configured: prove()  (runs `/usr/bin/id -u`, expect "0")
       c. first winner -> record { strategyUsed, ranAs: "uid 0", proof }
  3. If allowAudit: run E1..E4 detections, collect findings (no execution)
  4. Emit `probe` data: ladder[], winner|null, findings[], capability summary
  5. Return winner or null; `probe` never runs the target command.

run(command, strategy=auto, timeoutSeconds, allowAudit=false):
  1. Resolve winner (call probe if not already fresh in this run)
  2. If no winner: fail with an actionable error listing every path tried/why
  3. Execute winner.argv(command.split-to-argv) with timeout
  4. Capture exitCode, stdout, stderr, ranAs (from a post-check `id -u`)
  5. Emit `result` data + `run` report
```

Resolution is **first-win, no fallback after a winner fails the command**:
if `sudo -n` proves root but the target command exits 1, that is the command's
failure, not a reason to retry via `doas`. Fallback only happens during
*capability* probing (prove step), never after a real execution has begun — so
we never run a mutating command twice via two mechanisms.

---

## 7. Interfaces

### 7.1 Model global args (`@svendowideit/sudo`)

| Arg | Type | Default | Meaning |
| --- | ---- | ------- | ------- |
| `strategyOrder` | string[] | `["sudo-n","doas-n","pkexec","run0","ssh-root-loopback"]` | Order to try legitimate strategies. |
| `sshHost` | string | `"localhost"` | Host used by `ssh-root-loopback`. |
| `timeoutSeconds` | number | `120` | Per-execution timeout. |
| `probeTimeoutSeconds` | number | `10` | Per-probe timeout (proves must be fast). |
| `allowAudit` | boolean | `false` | Enable detection-only E-strategies. |
| `sudoAskpass` | string | `""` | Optional `SUDO_ASKPASS` helper for the `sudo-askpass` sub-path. |

### 7.2 Methods

**`probe`** — enumerate the ladder; run no target command.

| Input | Type | Default | Meaning |
| ----- | ---- | ------- | ------- |
| `strategy` | string | `"auto"` | Pin one strategy, or `auto` for the ordered ladder. |
| `allowAudit` | boolean | global | Override audit detection for this call. |
| `force` | boolean | `false` | Re-probe even if a cached probe exists. |

Writes data `probe`:
```json
{
  "winner": { "id": "sudo-n", "ranAs": 0 },
  "ladder": [
    { "id": "sudo-n", "kind": "legitimate", "installed": true, "configured": true, "proved": true, "reason": "sudo -n true ok" },
    { "id": "doas-n", "kind": "legitimate", "installed": false, "proved": false, "reason": "not found" }
  ],
  "findings": [
    { "id": "container-socket", "severity": "high", "detail": "user in docker group; /var/run/docker.sock accessible", "remediation": "remove user from docker group; use rootless or a socket proxy" }
  ],
  "capability": "root-via-sudo-n"
}
```

**`run`** — execute one command via the resolved winner.

| Input | Type | Required | Meaning |
| ----- | ---- | -------- | ------- |
| `command` | string[] | yes | argv array (preferred) — program plus args. |
| `commandLine` | string | alt | Convenience string; split with a strict argv tokenizer (no shell metachars executed). |
| `strategy` | string | `"auto"` | Pin a strategy. |
| `timeoutSeconds` | number | global | Override per call. |
| `allowAudit` | boolean | global | Enable audit findings. |

Writes data `result`:
```json
{
  "strategyUsed": "sudo-n",
  "command": ["apt-get","install","-y","caddy"],
  "exitCode": 0,
  "stdout": "…",
  "stderr": "",
  "ranAsUid": 0,
  "durationMs": 412,
  "mechanism": "sudo -n -- apt-get install -y caddy"
}
```

Fails (non-zero, structured) when no legitimate strategy resolves, with the
full ladder and the reason each candidate was rejected — never a bare
"permission denied".

### 7.3 Callable workflow `@svendowideit/sudo-run`

Inputs:

| Input | Type | Default | Meaning |
| ----- | ---- | ------- | ------- |
| `command` | string | — (required) | Command line to run as root. |
| `strategy` | string | `"auto"` | Pin a strategy. |
| `timeoutSeconds` | integer | `120` | Execution timeout. |
| `allowAudit` | boolean | `false` | Include detection-only findings in the result. |

Jobs / steps (using direct type execution, `modelName: sudo-run`):

```yaml
jobs:
  - name: elevate
    steps:
      - name: probe
        task:
          type: model_method
          modelType: "@svendowideit/sudo"
          modelName: sudo-run
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
          modelName: sudo-run
          methodName: run
          inputs:
            commandLine: ${{ inputs.command }}
            strategy: ${{ inputs.strategy }}
            timeoutSeconds: ${{ inputs.timeoutSeconds }}
            allowAudit: ${{ inputs.allowAudit }}
```

The parent workflow calls it and reads the result:

```yaml
- name: install-caddy
  task:
    type: workflow
    workflowIdOrName: "@svendowideit/sudo-run"
    inputs:
      command: "apt-get install -y caddy"
      timeoutSeconds: 300
```

```yaml
# Downstream step in the parent can branch on the outcome:
- name: check
  task:
    type: assert
    expr: >-
      int(data.latest("sudo-run", "result").attributes.exitCode) == 0
    message: "privileged install failed"
```

### 7.4 How other extensions consume it

Any extension's workflow adds one nested-workflow step. No dependency on
`sudo`, no per-extension elevation code, and the mechanism actually used is
recorded in swamp data for audit. This is the "extend, don't be clever" shape:
one model type owns elevation for the whole repo.

---

## 8. Data model & tags

| Data name | Written by | Tags | Used by |
| --------- | ---------- | ---- | ------- |
| `probe` | `probe` | `sudo`, `capability` | `run`, callers, dashboards |
| `result` | `run` | `sudo`, `elevation` | callers via `data.latest("sudo-run","result")` |

Callers should prefer the callable workflow's data over re-running `probe`
(rule 3: use the data model, don't re-fetch).

---

## 9. Security & consent model

1. **Detection-only by default.** E-strategies do nothing unless
   `allowAudit=true`.
2. **No shell injection.** `command` is tokenized to argv and passed after
   `--`; the `commandLine` convenience path uses a strict tokenizer that never
   invokes a shell and rejects metacharacters (`;`, `&&`, `|`, `` ` ``, `$(`,
   redirects) unless `shell: true` is explicitly and separately requested
   (off by default, with a warning).
3. **No secret capture.** Askpass/ssh are `BatchMode`/non-interactive; a prompt
   is treated as "not configured", not as something to answer.
4. **First-win, single-execution.** A real command runs through exactly one
   mechanism; fallback is probe-only.
5. **Full auditability.** The winning mechanism, the exact argv, the uid, exit
   code, and duration are all persisted as swamp data and in the method report.
6. **Least surprise.** A pinned `strategy` that is unavailable fails loudly
   rather than silently using another mechanism.

---

## 10. Testing plan

Pure logic in `sudo_ladder.ts` (no I/O) is unit-tested with the bundled Deno:

- argv builders produce exactly the documented argv for each legitimate
  strategy, including the `--` terminator and quoting for `ssh`.
- the tokenizer rejects shell metacharacters and splits quoted strings
  correctly.
- the ladder resolver returns the first *proved* winner, honours
  `strategyOrder`, and honours a pinned strategy.
- detection predicates are table-driven against fixture command-not-found /
  present cases (injected `which`/runner fakes).

Integration (manual / CI-optional, skipped when privileges absent):

- `probe` on a host with `sudo -n` present → winner `sudo-n`.
- `probe` on a host with neither sudo nor doas → `winner: null`, ladder fully
  explained, exit clean.
- `run` with `command=["id","-u"]` via whichever path works → `ranAsUid: 0`.
- `allowAudit=true` on a host where the user is in the `docker` group → an E1
  `finding` is emitted and **no container command is executed**.

Commands (bundled Deno, per repo rule):
```
~/.swamp/deno/deno test extensions/models/sudo/sudo_test.ts
~/.swamp/deno/deno check extensions/models/sudo/sudo.ts extensions/models/sudo/sudo_ladder.ts
```

---

## 11. Docs contract (extension-docs skill)

- `manifest.yaml` `description:` is the user manual, in canonical order:
  `WHAT IT DOES` (short pitch), `INSTALL`, `DEPENDENCIES`, `RUN`, `CONFIGURE`,
  `WHAT IT INSTALLS` — **no METHODS section**.
- Single-step install: `swamp extension pull @svendowideit/sudo`.
- **≥3 runnable, explained `swamp …` examples**, no placeholders:
  - `swamp model @svendowideit/sudo method run probe sudo-run` — see what
    elevation paths exist on this host.
  - `swamp workflow run @svendowideit/sudo-run --input command="id -u"` — smoke
    test that elevation works end to end.
  - `swamp model @svendowideit/sudo method run probe sudo-run --input allowAudit=true`
    — get the detection-only hardening findings (docker group, sudoers, etc.).
- `README.md` carries `## What it does`, `## Install`, `## Configuration`
  (argument table), `## Examples`, `## Details` naming **every method** and
  every legitimate + detection strategy with its exact argv.
- `WHAT IT INSTALLS`: **nothing on the host** — no service, no webhook, no cron.
- Verify with the meta-factory before release:
  `swamp workflow run @svendowideit/meta-factory --input manifest=extensions/models/sudo/manifest.yaml`

---

## 12. Release hygiene (per AGENTS.md)

When implemented:
1. `swamp extension version --manifest extensions/models/sudo/manifest.yaml` →
   set manifest `version:` and model `version:` to the returned `nextVersion`,
   matching; add the `upgrades:` entry.
2. Verify: deno test, deno check, `swamp extension fmt --check`,
   `swamp workflow validate @svendowideit/sudo-run`, meta-factory score ≥ 75.
3. Record the adversarial review for the new content hash.
4. Report old → new version, what changed, verification result, and the exact
   `swamp extension push` command — but do not push unless asked.

---

## 13. Open questions for review

1. **Ladder default order** — should `sudo-n` stay first, or should the operator
   be forced to set `strategyOrder`? (Proposed: keep the 5-item default,
   overridable.)
2. **`ssh-root-loopback` inclusion** — it needs `sshHost` config and may hit
   host-key prompts. Include by default, or make it opt-in like the E-strategies?
3. **E-strategy reporting depth** — how many sudoers/SUID details to emit before
   it becomes a full audit tool that deserves its own extension
   (e.g. hand off E2/E3 to a dedicated hardening report)?
4. **E-strategy default** — is `allowAudit=false` the right default, or should
   the callable workflow default it to `true` (findings are non-destructive) so
   callers get hardening value for free?
5. **Remote placement** — when a parent step is placed on a worker, the nested
   workflow runs on the worker; confirm that is the desired semantics (it is
   host-correct, but means the elevation target follows the step, not the
   parent's origin).

---

## 14. Milestones

1. Scaffold extension dir, LICENSE, manifest skeleton (swamp commands, not
   hand-written).
2. `sudo_ladder.ts` + tests (pure, no privileges required).
3. `sudo.ts` model (`probe`, `run`) + `deno check`.
4. `swamp workflow create @svendowideit/sudo-run` → author YAML → validate.
5. README + manifest manual; meta-factory score.
6. Bump version, run full verification, report for push.
