# Fleet conventions

How agents work on the caddy test programme. These exist because a shared
working tree is how work gets lost.

## 1. One worktree per agent — never the shared repo working tree

**Every agent works in its own git worktree, on its own branch. No agent edits,
`git checkout`s, `git reset`s, `git stash`es, or otherwise touches another
agent's worktree or the repository's primary working tree.**

This is not optional. The `~/src/swamp-project` checkout is the *primary*
worktree other agents and the user also use; changing its checked-out branch or
its index silently steals or strands their uncommitted work.

- Create it with `scripts/fleet/start <item>` (or `git worktree add … -b
  caddy/<item>`), and work **only** inside the path it prints.
- Put worktrees outside the repo — the scripts default to beside it but honour
  `FLEET_WORKTREE_DIR` (e.g. `/tmp/opencode`).
- Never run `git checkout`/`reset`/`clean`/`stash` in a worktree you did not
  create.
- Do not create sibling worktrees under `~/src` unless asked; prefer
  `FLEET_WORKTREE_DIR`.

## 2. One branch, one item

- Branch: `caddy/<item>` (e.g. `caddy/f0-fleet-scaffold`).
- Each item is one branch, one commit series, one PR.

## 3. Every PR targets `main` — no stacked PRs

Open PRs against **`main`**. Do **not** stack a PR on another feature branch: a
stacked PR merges into its base, not `main`, and its work strands. If a PR needs
another's changes, wait for it to merge, then rebase on the new `main`.

`scripts/fleet/pr` always pushes the branch and opens the PR with `--base main`.

## 4. All testing goes through test-factory in dind — never the host

Run tests only via `@svendowideit/test-factory` (the harness is a container; the
`docker-rootful` grant gives it an in-container `dockerd`). Never run the work on
the host:

```sh
scripts/fleet/test <item>            # or:
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=<candidate>/manifest.yaml --input scenario=<scenario>
```

See the test-factory README, "Running one scenario in dind".

## 5. Behaviour changes ship with a test change

`scripts/fleet/gate [base]` fails when a PR changes what a model type *does* —
its implementation (`.ts`) or a shipped workflow (an extension `.yaml`, not
`manifest.yaml`) — without changing a test (`*_test.ts`, a `test-factory.yaml`,
or a `test/` fixture). Docs, manifests, READMEs and version bumps may change
alone. Wire it into CI so it gates every PR; run it before you open one.

## 6. Extension release hygiene

If an extension changed, prepare it for release: bump the manifest **and** model
version together (use `swamp extension version --manifest …`), add a
terminating `upgrades` entry, verify (`deno test`, `deno check`,
`swamp extension fmt --check`, `swamp extension quality`), record the adversarial
review for the new content hash, and report the exact `swamp extension push`
command. Do not push unless asked.

## 7. Inspect before you retry

When a run fails, read its report/data before changing anything:
`swamp report get @svendowideit/test-factory-report --model tf --markdown`.

## 8. Status ledger

`scripts/fleet/{start,test,pr}` maintain `.worktree-status/<slug>.json`; run
`scripts/fleet/board` to see every item's phase, branch, test result and PR.
Keep it current — it is the fleet's shared, agent-independent progress view.
