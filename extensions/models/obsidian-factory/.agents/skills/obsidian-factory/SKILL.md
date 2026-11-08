---
name: obsidian-factory
description: >
  Drive the Obsidian board stagecraft factory: read the board's queue, claim
  work items, do the idea, plan, implement, test, acceptance and release
  stages, record what each stage did and learned, and treat a card move as the
  person's decision. Use when working with @svendowideit/obsidian-factory,
  the obsidian-idea-factory factory, the Obsidian idea board, or when asked to
  "tick the factory", "drive the idea board", or "process the Obsidian board".
---

# Driving the idea factory

This is the agent skill for a board-driven stagecraft factory. Load the
`stagecraft` skill too: it defines the work-item loop, the propulsion rule and
the human-stop rules. This page adds the Obsidian board.

## The two sources of truth

- **The board is the tracker.** `@svendowideit/obsidian-factory` stores each
  ticket as a note in `Factory/Cards`, and the Bases Kanban view grouped by
  `note.status` is the board. A card's column is its ticket status.
- **stagecraft is the state machine.** `obsidian-idea-factory` pins the stages,
  products and transitions. The work item's journal is in swamp data; every
  publish replays it to the card's activity log and status.

A card move is a person's decision. A stagecraft work-item write is the
factory's. Never overwrite a person's card move just to make the board match
stagecraft; reconcile the work item to the card instead.

## The card has three kinds of writing

- **The person's prose** — the title, brief, ideas, questions and feedback.
  Never rewrite it unless the person asks.
- **The readable sections** — `## At a glance` and `## Plan`, each inside
  `swamp:summary` / `swamp:plan` markers. `## At a glance` is the first thing
  after the title, because the top of the page is what the person actually
  reads: it carries the stage, plan status, **Needs your input**, the next step,
  known and unknown. `## Plan` is below the person's Questions/Feedback and
  carries the checkbox list of tasks and tests. Update them with `setSummary`
  and `setPlan`, and put the open questions in `needsInput`, not only in the
  Plan below.
- **The activity log** — inside `swamp:activity` markers. This is the detailed
  agent journal. Do not summarise it away; leave it for deep investigation.

The `## Feedback` heading is only one place a person may write. Read the
whole card every time: the title, brief, questions, ideas, the managed At a
glance/Plan, ticked tasks and free prose anywhere. Any new or changed word is
feedback. If a managed section must be rewritten, copy the changed words into
the stage's feedback product first; never silently discard an edit.

`setSummary` and `setPlan` protect the managed sections with a stored hash. If
either refuses with `managed section ... was edited by a person`, that is not a
bug and not a reason to force it: read the current section in the error, quote
the person's changed words into the stage feedback or the plan's
`feedbackIncorporated`, then retry with `acceptEdits=true`. A first write after
this protection lands also refuses, because the current section has no stored
hash; review it instead of assuming it is factory text.

The card layout is deliberately top-heavy: title → `## At a glance` →
the brief/ideas/thoughts → `## Questions` → `## Feedback` → `## Plan` →
`## Definition` → Activity. The top is what the person reads and edits; the
Plan is the detail they can scroll to. Do not bury a question or a decision
only in the Plan or the Activity log.

The card viewer must be able to tell what is known and what is still unknown at
the current stage. Never leave a plan section saying "not planned" after a plan
exists, and never present a draft as final.

## Before the first run

```sh
# One per vault/repo.
swamp behavior run obsidian-board installBoard
swamp behavior run obsidian-board describe
# The tick does the CSS install/enable and card migration for you. These two
# commands are the manual fallbacks.
swamp behavior run obsidian-board migrateCards
swamp behavior run obsidian-board installCardCss

# One publisher in front of the tracker, named as the factory's tracker.
swamp behavior create @swamp/stagecraft/publisher obsidian-pub \
  --global-arg tracker=obsidian-board --json
# In its model file, set:
#   statuses:
#     uncharacterised: Uncharacterised
#     category: Category
#     proposed: Proposed
#     please-plan: Please Plan
#     work-planned: Work Planned
#     please-implement: Please Implement
#     please-test: Please Test
#     user-acceptance: User Acceptance
#     please-release: Please Release
#     done: Done

swamp behavior create @swamp/stagecraft/factory obsidian-idea-factory \
  --global-arg tracker=obsidian-pub --json
# Then put the `definition:` and `scenarios:` blocks into the factory's model
# file under globalArguments (the factory's definition is the only copy).
swamp behavior run obsidian-idea-factory validate
```

## One tick

0. **Board first. Every tick starts by reading the actual card columns.** Run
   `swamp behavior run obsidian-board scan` and `queue`, or read the tick
   report's `board` and `counts`. A card's column is the person's instruction;
   the work item follows it. Act on every `reconcile` row **before** any
   housekeeping or implementation. Never assume a card is where the work item
   says it is. If a card is in a column the work item cannot enter, stop and
   report it; do not ignore it.
1. **Run the factory tick.** The tick now reads and reports the actual board
   first, then does the idempotent housekeeping:
   - installs and keeps current the card CSS snippet, and sets Obsidian's global
     `cli: true` flag (with backups). The snippet still needs a reload or a
     one-time enable in **Settings → Appearance → CSS snippets**: Obsidian only
     reads the enabled-snippet list at startup, and the 1.15 CLI has no
     snippet-toggle or app-reload command.
   - adds the readable sections and `factory-card` class to cards that lack
     them,
   - progressively repins cards that have no recorded work to the current
     factory definition,
   - refreshes the queue.

   Pass the current factory definition version so the repin is idempotent:

   ```sh
   HASH=$(sha256sum models/@swamp/stagecraft/factory/obsidian-idea-factory.yaml | cut -d' ' -f1)
   swamp behavior run obsidian-board tick --input factoryDefinition=$HASH
   ```

   Read the tick report:
   `swamp data query 'behaviorName == "obsidian-board" && name == "tick"' --select content --single --json`.

   - `repinned` cards were restarted at `route` on the current definition; drive
     them in this tick.
   - `pinned` cards have recorded work and stay on the definition they started
     with. They move to the current definition when they finish or are reopened;
     say so rather than resetting them.
   - `errors` must be reported; the tick carries on with the rest.
2. **Ask the board what needs doing.**
   `swamp behavior run obsidian-board queue`, then
   `swamp data query 'behaviorName == "obsidian-board" && name == "queue"' --select content --single --json`.
   Each row has `id`, `kind`, `column`, `key`, `stage`, `cycle`, `era`,
   `terminal` and an `action`:
   - `claim` — no work item yet; run the claim workflow.
   - `work` — the card and the stage already agree; do the stage's work.
   - `reconcile` — the person moved the card out of the stage's column; treat
     the column as their instruction (see the table below).
   - `done` — the work item is terminal and the card has no new input; leave
     it.
   - `wait` — nothing to do yet.

   A `claim` row can also mean a finished work item should be reopened: the
   inbox has new thoughts, a category has more ideas than its last proposal
   covered, or a finished action card was moved back to **Proposed**. Claiming
   again starts a new work item at `route`; do not reset the old one. To reopen
   a finished action, move it to Proposed, not straight to a later column: the
   new work item starts at `route`, and `proposed` is the stage that re-anchors
   the card before planning.
3. **Read the card** you will work on:
   `swamp behavior run obsidian-board readCard --input id=<id>`.
4. **Claim new cards** through the shipped workflow, never with a hand-made
   key:
   ```sh
   swamp workflow run @swamp/stagecraft/claim --input tracker=obsidian-pub \
     --input issue=<id> --input factory=obsidian-idea-factory
   ```
   Run the `start` command it prints. If it says the card is already started,
   drive that work item.
5. **Read `status`** for the work item. The `queue` row carries the stage,
   cycle and era, but `status` is the only source of truth for the exits and
   the expectation.
6. **Do the stage's work**, record every product the dispatch packet names, and
   publish:
   ```sh
   swamp workflow run @swamp/stagecraft/publish \
     --input tracker=obsidian-pub --input workItem=<key>
   ```
   Publish after every write that changes the card: it moves the card and adds
   the journal entry to its activity log.
7. **Update the readable sections.** After the stage's report, run `setSummary`
   with the current stage, plan status (`none` / `draft` / `final`), the
   `needsInput` questions or decisions, the known list, the unknown list and
   the next step. `needsInput` is the top of the card and is what the person
   reads first: put the open questions there, not only in the Plan below. Do
   not repeat a `needsInput` question in `unknown`; keep `unknown` for technical
   unknowns. If `setSummary` or `setPlan` refuses because a person edited the
   section, quote that edit into the stage feedback and retry with
   `acceptEdits=true`; do not force it away. At
   `plan` and `plan-cleanup`, also run `setPlan` with the draft or final plan:
   checkbox tasks, planned tests, existing functionality changing,
   functionality added, functionality removed, and known/unknown. Use
   `--input-file` for long arrays.

## Reconciling a card move

The board's column is the person's instruction. Read it as follows.

| Card is in | Work item is at | What to do |
| --- | --- | --- |
| Proposed | `route` / `proposed` | The card is not ready for planning. Leave it; the person is refining it. |
| Please Plan | `proposed` | The person has asked for a plan. Record `refined-brief` from the card (title, brief, project, questions), then take the manual `plan` transition with `confirm=true`. |
| Work Planned | `plan-cleanup` | The factory has not published yet. Publish; then the card is in Work Planned. |
| Please Plan | `work-planned` | The person sent the plan back. Read the whole card, not only `## Feedback`; quote every new or changed word as `plan-feedback` (recordedBy person, on their behalf), then take the manual `revise` transition. |
| Work Planned | `implement` | The person sent the work back from implementation. Record `implementation-feedback` with their words, or the observed move when they added none, then take the manual `return` transition. The accepted plan is kept; the work item is back at Work Planned. |
| Please Plan | `implement` | The person wants the plan revised during implementation. Record `implementation-feedback`, then take the manual `revise` transition into plan. |
| Work Planned / Please Plan | `test` or `release` | Stop and report: this factory has no manual way back from test/release to work-planned yet. Do not invent one. |
| Please Implement | `work-planned` | The person accepted the plan. Record `implementation-brief` from the card, then take the manual `implement` transition. |
| Please Test | `implement` | The factory has not finished the stage. Do the implement work first; publish when it is done. |
| Please Implement | `test` | Tests failed, or the person sent it back. Record their feedback and take the manual `revise` transition into `implement`. |
| User Acceptance | `test` | The factory has passed the tests. Publish; the card moves to User Acceptance. |
| Please Plan / Please Implement / Please Test | `acceptance` | The person sent it back to that phase. Read the whole card, not only `## Feedback`; quote every new or changed word as `acceptance-feedback`, then take the matching manual transition. |
| Please Release | `acceptance` | The person accepted it. Record `release-go`, then take the manual `release` transition. |
| Done | anywhere | The work item should be terminal. If it is not, ask before forcing anything. |

If a card is in a column that is not a legal move from its stage, stop and ask
the person. Do not invent a transition.

A board move is the person's word for *that* decision. You do not need to ask
again for the same move, but you must record the move in the journal with
`onBehalfOf` naming them when the method takes it.

## Stage notes

- **route** — read the card's `kind` (`inbox`, `category`, `action`) and record
  `card-kind`. The factory branches on it. Do not change the card.
- **triage** — the inbox card. Record `triage` and `triage-report`, then
  `setSummary` ("Uncharacterised", plan none, known from the routing decisions,
  unknown as anything unclassified). For each bullet under `## Thoughts`,
  decide:
  move it to an existing category card with
  `swamp behavior run obsidian-board moveIdea --input from=inbox --input idea="..." --input to=<category-id>`,
  or create a category first with
  `swamp behavior run obsidian-board createCategory --input name="..."`.
  Record `triage` with every decision and reason, and `triage-report` with what
  you did and learned. Leave the inbox card's status alone when you finish.
- **propose** — a category card. Find the common subset of its ideas that is
  worth doing now. Create one action card in Proposed:
  `swamp behavior run obsidian-board createAction --input title="..." --input brief="..." --input source=<category-id> --input 'ideas=["..."]'`.
  Record `proposal` with the action id and the ideas it covers, and
  `proposal-report`; `setSummary` ("Category", plan none, known from the
  proposal, unknown as anything not covered).
- **plan** — read the whole card, not only `## Feedback`, then research the
  existing system before writing the plan. Record `plan` with the summary,
  ordered steps (files per step), testing strategy, existing-system notes, open
  questions, planned tests, existing behaviour, added/removed functionality and
  known/unknown. Put every new or changed word from the card into
  `feedbackIncorporated` before `setPlan` rewrites the managed sections.
  `plan-report` says what you did and learned. Then `setPlan` with status draft
  and `setSummary` ("Please Plan", plan draft).
- **plan-review** — adversarial reviewer. Read the injected `plan` and the
  code. Rate a finding critical or high only if the plan would ship a defect,
  lose data, break a stated rule, or make the checks meaningless. Record
  `plan-review` as findings. Do not soften a real defect; do not inflate style.
- **plan-cleanup** — resolve the review, remove process that is bigger than the
  change, and record `plan-final`. This is what the person reads in Work
  Planned.
- **implement** — two agents in parallel: one writes completeness and
  correctness tests, one implements. Record `tests`, `implementation` and
  `implement-report`. Both agents work in the card's `project` path. If the
  person moves the card back to Work Planned, record `implementation-feedback`
  and take the manual `return` transition; if they move it to Please Plan, take
  `revise` into plan.
- **test** — run the full test suite named by the plan. Record `checks` with one
  result per command, and `test-report`. A failed check sends the card back to
  Please Implement.
- **acceptance** — the person tries it. Read the whole card, not only
  `## Feedback`; record every new or changed word anywhere as
  `acceptance-feedback`, then take the move they made on the board.
- **release** — run the full suite and the project's release process. Record
  `release-checks`; only after it passes record `release` and move to Done. A
  failure returns to User Acceptance with the details in `release-checks`.

## The route warning

`validate` reports three ambiguous exits from `route`. They are not ambiguous in
practice: the card's `kind` is exactly one of `inbox`, `category` or `action`,
and the three cel gates test that one value. The graph checker does not compare
cel expressions, so it cannot prove it. Leave them as they are.

## Rules that still apply

- `status` first, and after every write. Pass the expectation back.
- Never approve, decline, grant an override, or take a manual exit without the
  person's word. On this board, moving the card to a person's column is that
  word; record it with `onBehalfOf`.
- A person records `plan-feedback`, `acceptance-feedback` and `release-go`: copy
  their words from the card, never invent them.
- Every working stage records its report product (`triage-report`,
  `proposal-report`, `plan-report`, `cleanup-report`, `implement-report`,
  `test-report`, `release-report`) with `did`, `learned` and `next`, so the next
  stage (and the person) can see what happened.
- **Read the whole card.** `## Feedback` is one place a person may write, not
  the only one. A ticked task, a changed plan task, a title or brief edit, a new
  question, or a note anywhere is the person's input. Never wait for the
  Feedback heading to fill up.
