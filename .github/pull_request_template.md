<!-- Caddy test-programme PR. Keep it short. -->

## Item

<!-- fleet item id, e.g. F0.7 — see docs/caddy-test-matrix.md -->

## Closes

<!-- plan/issue ids this closes, e.g. F0.7 in docs/caddy-test-matrix.md -->

## What changed

<!-- 1–3 bullets: the change and why -->

## Test-factory evidence

<!-- the dind gate that proves it. Paste the command and its result line, and
     the result/rollup data pointer so a reader can re-read it. -->

- command:
- result:

## Checklist

- [ ] Worked in an **isolated worktree** — never the shared repo working tree
      (see [docs/fleet-conventions.md](../docs/fleet-conventions.md))
- [ ] Branch is `caddy/<item>` and this PR bases on **`main`** (not stacked)
- [ ] `scripts/fleet/gate` passes (behaviour changes include a test change)
- [ ] Tests ran via `@svendowideit/test-factory` in **dind** — never the host
- [ ] If an extension changed: version bumped with a terminating `upgrades` entry
