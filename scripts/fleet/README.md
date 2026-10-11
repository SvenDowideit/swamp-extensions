# Fleet scaffolding

Small, one-purpose scripts that run the caddy test programme as a **fleet**: one
isolated worktree per item, a status ledger, a dind test gate, and a PR per item.

**Rule:** all testing goes through `@svendowideit/test-factory` in a container
(the `docker-rootful` grant gives the harness its own `dockerd`). Never the host.

## The four commands

| Command | Does |
| ------- | ---- |
| `scripts/fleet/start <item> [base] [candidate] [scenario]` | Create an isolated worktree + branch `caddy/<slug>` based on `origin/main`, and open the item in the ledger. |
| `scripts/fleet/test <item> [candidate] [scenario] [extra…]` | Run the item's test-factory dind gate; record pass/fail + the run id. Extra args pass through (e.g. `--input phases=tests`). |
| `scripts/fleet/pr <item> [title] [body-file]` | Push the branch over HTTPS and open the PR **against `main`**; record the URL. |
| `scripts/fleet/board` | Print every item's phase, branch, test result and PR. |

Everything bases on and merges to **`main`** (no stacked PRs).

## Worked example

```sh
# 1. Start an item (worktrees land beside the repo by default).
scripts/fleet/start f0.6 \
  extensions/models/caddy/manifest.yaml ubuntu-systemd-standalone

# 2. Work in the worktree it prints, committing as you go.

# 3. Run the dind gate.
scripts/fleet/test f0.6

# 4. Open the PR to main.
scripts/fleet/pr f0.6 "test-factory: per-test grants (F0.6)"

# At any time:
scripts/fleet/board
```

## Configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `FLEET_WORKTREE_DIR` | `dirname <repo>` | Where item worktrees are created. Set `FLEET_WORKTREE_DIR=/tmp/opencode` on a locked-down host. |
| `FLEET_PUSH_URL` | `https://github.com/<owner>/<repo>.git` | Push URL. HTTPS is used by default so pushes work where host SSH is misconfigured; `gh`'s credential helper supplies the token. |

## Ledger

`.worktree-status/<slug>.json` (git-ignored) records the item:

```json
{ "item": "f0.6", "branch": "caddy/f0-fleet-scaffold", "phase": "testing",
  "candidate": "extensions/models/caddy/manifest.yaml",
  "scenario": "ubuntu-systemd-standalone",
  "pr": "", "testRunId": "", "testResult": "pass",
  "updatedAt": "2026-10-11T00:00:00Z", "notes": "", "log": [] }
```

`phase` moves `started → testing → review → done`. `board` reads these files, so
the fleet's state is always inspectable without asking an agent.

## Oversight

- Ledger + `board` for live state.
- WIP commits on each branch as an audit trail.
- The test-factory report/data pointer as the definition of done.
- PRs always target `main`; `pr` derives the title/body from the ledger when not
  given.
