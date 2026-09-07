# Idea Factory — Implement an Idea (agent skill)

Implement an idea from the idea factory: write **code, docs, and tests** into the
idea's target, **iteratively** (MVP first, then each iteration), guided by the
plan's tasks and acceptance criteria.

This is **agent work**, not a single black-box call. The agent reads the plan and
idea from swamp, implements each phase, runs the tests, fixes failures, and
commits — showing real progress (LLM reasoning, files written, test results)
throughout.

## Prerequisites

- The idea has a `target` (directory / git-repo / new-project).
- The idea has a plan (with phases: `MVP`, `Iteration 1`, `Iteration 2`, …).

## Steps

### 1. Read the idea + plan from swamp

```bash
swamp data get ideas-factory ideas --json
swamp data get ideas-factory plans --json
```

Find the idea (by title or id) and its latest **non-superseded** plan. Note the
idea's `target` and the plan's `tasks` (grouped by `phase`).

### 2. Resolve the target + language

The idea's `target` says where the work lands:

- `directory` → write into `target.path`.
- `git-repo` → clone/checkout `target.url`.
- `new-project` → create a fresh project (use `target.language` + `target.structure`).

Detect the language/tooling from the target (authoritative — never guess):

| Marker                | Language / tooling          |
| --------------------- | --------------------------- |
| `.swamp.yaml` / `.swamp/` | TypeScript (swamp extension) |
| `go.mod`              | Go                          |
| `Cargo.toml`          | Rust                        |
| `deno.json` / `deno.jsonc` | Deno / TypeScript        |
| `package.json`        | Node / TypeScript           |
| `pyproject.toml`      | Python                      |

> **Critical:** a swamp extension is a **TypeScript model type**
> (`export const model = { type, version, globalArguments, resources, methods }`
> plus a `manifest.yaml`), *not* a plugin for the external tool the idea mentions.
> A "caddy extension" is a swamp extension that drives Caddy via its admin API —
> it is **not** a Go Caddy plugin.

### 3. Implement each phase in order (MVP first)

For each phase in order (`MVP`, then `Iteration 1`, `Iteration 2`, …):

1. **Read the phase's tasks** — each has `title`, `description`,
   `acceptanceCriteria`, `testStrategy`, `dependencies`, `effort`.
2. **Write the code + docs + tests** for those tasks, matching the language and
   the existing codebase's conventions. Implement exactly the tasks given — no
   more. The MVP is the smallest end-to-end working slice; defer generalization
   to later iterations.
3. **Run the test suite** (matching the detected tooling: `deno test`, `go test
   ./...`, `cargo test`, `npm test`, …).
4. **Fix any failures** — iterate until the tests pass (or record what's blocked).
5. **Commit** on the current branch (`git add -A && git commit`), one commit per
   phase, so each iteration is reviewable and revertible.
6. **Record the phase back to the factory** (REQUIRED — do not skip). This is
   what updates the board so the user can see and iterate on what exists:

   ```bash
   swamp model method run ideas-factory recordImplementation \
     --input ideaId=<idea-id> \
     --input phase=<phase-name> \
     --input 'files:json=["path/a.ts","path/b.ts"]' \
     --input testCommand="deno test" \
     --input testPassed=true \
     --input 'summary=implemented the MVP: add/remove proxy via the admin API' \
     --input boardPath=<board-path>
   ```

   `boardPath` is the path the board is served from (e.g.
   `explorer/idea-factory/kanban.html`); passing it re-renders the board so the
   update is visible immediately. This records an `implement` action (files +
   summary) and a `verification` (test result), and marks the phase's tasks
   `verified` when the tests pass.

### 4. Report back to the user

Also report back to the user:

- What was implemented (files written, per phase).
- Test results (pass/fail per acceptance criterion).
- Any remaining work, open questions, or blockers.

## Principles

- **MVP first.** Get a minimal working slice the user can review before building
  general-purpose components.
- **Acceptance criteria are the definition of done.** Each task is done when its
  acceptance criteria are met and its tests pass.
- **Match the codebase.** Follow the existing language, structure, and
  conventions — don't introduce a new language or framework.
- **Iterate, don't over-build.** Implement one phase, verify, then move on.
