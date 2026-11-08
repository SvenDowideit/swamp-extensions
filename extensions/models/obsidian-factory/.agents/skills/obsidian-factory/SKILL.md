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

## The only source of truth

**The card is the state.** Its column and its content are the only truth. The
Bases Kanban column is the ticket status; the note body is the ticket body.

**stagecraft is an internal execution ledger.** Its stage, cycle and era are
implementation details. They never override the card. If the ledger disagrees
with the card, **the card wins**. Do not reset, pause, ask for a legal
transition, or call it a mismatch. Do the work the card's column implies and
record it in the ledger. If the ledger cannot represent the column, start a new
work item on the current definition and keep the old one as history; the card
is unchanged.

A card move — forward, backward or skipping a step — is normal. It is the
person's instruction, not an exception.

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
# Optional: the read-only card dialog. The bundle hash is verified and the
# plugin is added to community-plugins.json by default. Restart Obsidian once to
# load the new bundle. Pass enable=false to leave it disabled and enable it in
# Settings -> Community plugins instead.
swamp behavior run obsidian-board installBoardPlugin
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
   `terminal` and an `action`. The action is derived from **the card's column**,
   not the work item's stage:
   - `work` — the card is in a column the factory works; do that column's work.
   - `wait` — the card is in a person's column (Proposed, Work Planned, User
     Acceptance) or has no new input; wait for the person.
   - `claim` — the factory needs a ledger entry (a work item) before work, or a
     finished one should be reopened. Claiming starts a new work item; keep the
     old one as history.
   - `done` — the card is Done.
   - `reconcile` is no longer emitted. If an old queue has it, treat it as a
     legacy hint only.
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

## Progress tracking

The `## Plan` section is a live checklist. As work happens, mark the matching
task or test done with:

```sh
swamp behavior run obsidian-board markPlanProgress --input id=<card>   --input 'tasks=[{"match":"Add archiveCard","done":true}]'   --input 'tests=[{"match":"round-trip preserves content","done":true}]'
```

Mark only what actually happened. A test is done only after it ran and passed;
a task is done only when the work is complete. Do not mark the whole list done
at hand-off. If `markPlanProgress` refuses because the plan was edited, quote
that edit into the stage feedback and retry with `acceptEdits=true`.

## What the card column means

The column decides the work. The work item's stage is only a ledger.

| Card column | What the factory does |
| --- | --- |
| Uncharacterised | Triage new thoughts; wait if the inbox is empty. |
| Category | Propose from new ideas; wait if there are no new ideas. |
| Proposed | Wait for the person to refine the brief. |
| Please Plan | Plan or re-plan. |
| Work Planned | Wait for the person to read the plan. |
| Please Implement | Implement the accepted plan. |
| Please Test | Run the tests. |
| User Acceptance | Wait for the person to try the work. |
| Please Release | Run the full suite and release. |
| Done | Done. |

If the person moves a card forward, backward or across steps, the card is in
that column; do that column's work. Do not reset, pause, ask for a legal
transition, or call it a mismatch. If the ledger cannot represent the column,
start a new work item on the current definition and keep the old one as
history; the card is unchanged. The card's activity log records the move.

A board move is the person's word for *that* decision. You do not need to ask
again for the same move.

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
