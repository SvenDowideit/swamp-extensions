# @svendowideit/obsidian-factory

An Obsidian Bases Kanban board that is a [stagecraft](https://swamp-club.com/extensions/@swamp/stagecraft)
tracker. Ideas arrive on one uncharacterised card, become category cards and
proposed actions, then move through plan, implement, test, acceptance and
release columns. Every card is a normal note; its `status` frontmatter is its
column, so dragging a card is the person's decision and the board is the ticket.

## What it does

The extension provides one model type, `@svendowideit/obsidian-factory`, which:

- implements stagecraft's tracker contract 1 (`describe` and `operate`), so a
  `@swamp/stagecraft/publisher` can publish a factory's work items to the board;
- creates the Obsidian assets — a Bases Kanban view, an embedding page, a guide
  and card templates — and the one uncharacterised inbox card;
- captures raw thoughts, scans the board, reads one card, updates a card, moves
  an idea into an existing or new category, and creates category and action
  cards;
- joins each card to its stagecraft work-item run (`queue`), so an agent knows
  which cards need a claim, work, or a person's move reconciled.

It never writes a vault file itself. Every note read and write goes through the
existing `@magistr/obsidian/vault` model via `context.runModel`; that model stays
the single writer of the vault. The extension is not a second vault manager.

The card body is the brief, ideas, questions, feedback and a managed activity
log. The activity log uses HTML markers so the factory can append to it without
touching the person's prose. When a stage declares a tracker entry, the entry
(and its summary) is written into that log; otherwise stagecraft's comments and
status moves are.

## Install

```sh
swamp extension pull @svendowideit/obsidian-factory
```

That single pull installs `@magistr/obsidian-vault` and `@swamp/stagecraft` too.

## Configuration

The model's global arguments:

| Argument | Default | Meaning |
| --- | --- | --- |
| `vaultModel` | `obsidian-vault` | The `@magistr/obsidian/vault` instance used for every note read and write |
| `folder` | `Factory` | Vault folder holding `Board.base`, `Board.md`, `Guide.md`, `Templates/` and `Cards/` |
| `prefix` | `fac` | Prefix for new ticket ids (`fac-1`, `fac-2`) |
| `trackerName` | `obsidian` | The name the factory definition uses in `tracker.kind` |
| `types` | `inbox`, `category`, `action` | Ticket types the tracker accepts; a type that is also a card kind sets that kind |
| `statuses` | the ten columns | Every status name a card may have |
| `statusForKind` | inbox → Uncharacterised, category → Category, action → Proposed | The column a new card starts in |
| `stageColumns` | the factory's stage → column map | What `queue` compares each card's column against |
| `factory` | `obsidian-idea-factory` | The stagecraft factory `queue` reports work items for |
| `allowDotObsidian` | `false` | Permit reads and writes inside `.obsidian` |

Method arguments:

| Method | Arguments |
| --- | --- |
| `describe` | none |
| `operate` | `operation`, `request`, `answer`, `run` |
| `installBoard` | `force` |
| `installBoardPlugin` | `enable` (default `true`) |
| `capture` | `text`, `source` |
| `scan` | `status`, `kind`, `includeBody` |
| `tick` | `factoryDefinition`, `upgradeDefinitions`, `dryRun` |
| `queue` | `status`, `kind` |
| `readCard` | `id` |
| `updateCard` | `id`, `title`, `body`, `status`, `project` |
| `setSummary` | `id`, `stage`, `planStatus`, `known`, `unknown`, `next` |
| `setPlan` | `id`, `status`, `summary`, `tasks`, `tests`, `existing`, `added`, `removed`, `known`, `unknown`, `acceptEdits` |
| `markPlanProgress` | `id`, `tasks` (`match`, `done`), `tests` (`match`, `done`), `acceptEdits` |
| `setDefinition` | `id`, `status`, `note` |
| `installCardCss` | `force` |
| `migrateCards` | none |
| `deleteCard` | `id`, `confirm`, `permanent`, `dryRun` |
| `archiveCard` | `id`, `outcome` (`done`/`deleted`/`duplicate`), `reason`, `detail`, `dryRun` |
| `unarchiveCard` | `id`, `dryRun` |
| `createCategory` | `name`, `summary`, `ideas` |
| `createAction` | `title`, `brief`, `source`, `ideas`, `project` |
| `moveIdea` | `from`, `idea`, `to`, `newCategory`, `newCategorySummary` |

A per-call `--input` wins over a global.

## Examples

```sh
# One-time: point the existing vault model at the vault that will hold the
# board. This is the only writer of note files; the factory calls it.
swamp model create @magistr/obsidian/vault obsidian-vault \
  --global-arg vaultRoot=$HOME/Obsidian/Factory

# Create the Bases board, the embedding page, the guide, the three templates
# and the one uncharacterised inbox card. Re-running is a no-op unless you pass
# --input force=true (which rewrites the board assets, never the inbox card).
swamp behavior run obsidian-board installBoard

# Optional: install the read-only card dialog plugin. The bundle hash is
# verified, changed files are backed up, and the plugin is left disabled for
# you to enable in Settings -> Community plugins.
swamp behavior run obsidian-board installBoardPlugin

# Capture a raw thought on the uncharacterised card. Use this from a phone,
# a script, or an agent; editing the card's ## Thoughts section does the same.
swamp behavior run obsidian-board capture \
  --input 'text=the cache should be write-through'

# Read every card and its column. This is the board as data; a person still
# sees the same cards in the Bases Kanban view.
swamp behavior run obsidian-board scan

# Join every card to its stagecraft run and get the next action per card:
# claim, work, reconcile, done or wait. This is what an agent runs first.
swamp behavior run obsidian-board queue

# Move one idea out of the inbox into a new category card, or into an existing
# one with --input to=fac-3. The inbox stays in Uncharacterised for the next
# thought.
swamp behavior run obsidian-board moveIdea \
  --input from=inbox --input idea="the caching idea" \
  --input newCategory="Caching" --input newCategorySummary="Where caching ideas live"

# Create an action card in Proposed from a category's common subset, then let
# the person refine it and drag it to Please Plan.
swamp behavior run obsidian-board createAction \
  --input title="Write-through cache" --input source=fac-3 \
  --input brief="Make the cache write-through before the next release" \
  --input 'ideas=["cache first","invalidate on write"]'

# The stagecraft side: a publisher in front of the tracker, then the factory.
# Set the publisher's statuses map to the ten column names (see the bundled
# skill for the exact YAML).
swamp behavior create @swamp/stagecraft/publisher obsidian-pub \
  --global-arg tracker=obsidian-board
swamp behavior create @swamp/stagecraft/factory obsidian-idea-factory \
  --global-arg tracker=obsidian-pub
swamp behavior run obsidian-idea-factory validate

# Check the tracker against stagecraft's contract. It files and changes
# tickets, so run it against a tracker you keep for testing.
swamp workflow run @swamp/stagecraft/conformance --input tracker=obsidian-pub \
  --input statusNames="Please Plan,Done" --input createType=action \
  --input entryStatus=Proposed --input entryTypes="inbox,category" \
  --input missing=fac-999999
```

## Details

### Model type

`@svendowideit/obsidian-factory` is a model type, not an extension of the
vault type. It composes `@magistr/obsidian/vault` through
`context.runModel`, so the vault model remains the only writer of note files.
The two extensions are declared in `dependencies:`, so one pull installs both.

### Reading a card

Each card has three layers:

- `## At a glance` — the current stage, whether the plan is absent, draft or
  final, what is known, what is still unknown, and the next step.
- `## Plan` — checkbox tasks and tests, existing functionality changing,
  functionality added/removed, and known/unknown. It is written as a draft by
  the plan stage and marked final after review and cleanup.
- `## Activity` — the detailed agent journal, for deep investigation.

The machine-written layers use `swamp:summary`, `swamp:plan` and
`swamp:activity` markers, so the factory can rewrite them without touching the
person's prose.

### The card

A card is one Markdown note in `<folder>/Cards/`. Its frontmatter is the ticket:

```yaml
id: fac-3
display: FAC-3
title: Write-through cache
kind: action
type: action
status: Please Plan
project: /home/me/src/cache
source: fac-2
created: 2026-11-07T10:00:00.000Z
updated: 2026-11-07T10:05:00.000Z
description: Make the cache write-through before the next release
relations: []
```

`id` is stable; `display` is what a person reads; `kind` is `inbox`, `category`
or `action`; `type` is the stagecraft ticket type; `status` is the column;
`description` is the body stagecraft's tracker contract returns. The note body
is the human page: title, brief, ideas, questions, feedback and the managed
activity block.

### The board

`installBoard` writes:

- `Factory/Board.base` — a Bases Kanban view grouped by `note.status`, with the
  ten columns in flow order, plus a table view and a "waiting for a person"
  view. Kanban requires Obsidian 1.14 or later.
- `Factory/Board.md` — a page embedding the board and explaining the flow.
- `Factory/Archive.base` — a table over `Factory/Archive` grouped by
  `note.archiveStatus`, with one view per outcome, the title, the reason, the
  optional detail, the archive date and the column the card left.
- `Factory/Archive.md` — a page embedding the archive and explaining how to
  archive and restore a card.
- `Factory/Guide.md` — the person's guide.
- `Factory/Templates/Card.md`, `Category.md`, `Action.md` — core Templates
  plugin templates.
- `Factory/Cards/INBOX Uncharacterised.md` — the one inbox card. It is never
  overwritten.

### Methods

- **`describe`** — writes the tracker description stagecraft binds against:
  contract 1, snapshot origin, history capability on, assign and pull-request
  capabilities off.
- **`operate`** — one tracker operation: `fetch_issue`, `create`, `comment`,
  `set_status`, `post_entry`, `set_type`, `relate`, `unrelate`. It writes an
  idempotent answer under the requested `answer` name; a failure is an answer
  with `ok:false`, never a thrown error.
- **`installBoard`** — writes the board assets and the inbox card.
- **`installBoardPlugin`** — installs the optional read-only dialog plugin into
  `.obsidian/plugins/obsidian-factory`. It verifies `main.js` against
  `main.js.sha256.txt`, backs up a changed file to `*.bak-obsidian-factory`, and
  by default adds `obsidian-factory` to `.obsidian/community-plugins.json`
  (backing that list up first). Pass `enable=false` to leave it disabled.
  Restart Obsidian once to load the bundle; replacing `main.js` is not loaded
  into the running app without a reload. If the plugin was never enabled, add it
  in **Settings -> Community plugins** if you passed `enable=false`.
- **`markPlanProgress`** — ticks or unticks Plan task/test checkboxes by a
  unique text match, updates the stored plan hash, and refuses a person-edited
  plan unless `acceptEdits=true`. This is how the factory keeps the visible
  checklist in step with the work.
- **`capture`** — appends a timestamped bullet under the inbox's `## Thoughts`.
- **`scan`** — writes `board`, a summary of every card with `id`, `display`,
  `title`, `kind`, `status`, `path`, `updated`, `project`, `ideaCount`,
  `openQuestions` and the legal `moves`.
- **`tick`** — the idempotent factory housekeeping: installs the card CSS
  snippet and enables it in Obsidian's appearance settings, migrates cards to
  the readable sections, progressively repins safe cards to the current factory
  definition, and refreshes the queue. Pass `factoryDefinition` (a hash of the
  factory model file) so a second tick is a no-op. Cards with recorded work are
  marked `pinned`, not reset.
- **`queue`** — writes `queue`, every card joined to its stagecraft run with
  `key`, `stage`, `cycle`, `era`, `terminal` and `action`.
- **`readCard`** — writes `card`, one card's body, status and relations.
- **`updateCard`** — changes a card's title, body, status or project path;
  the summary, plan and activity sections are preserved.
- **`setSummary`** — writes the card's readable `## At a glance` section:
  stage, plan status, known, unknown and next.
- **`setPlan`** — writes the readable `## Plan` section: checkbox tasks,
  planned tests, existing functionality changing, functionality added and
  removed, and the known/unknown lists.
- **`setDefinition`** — writes the card's `## Definition` section: `current`,
  `pinned`, `repinned`, `finished` or `unknown`, with a note.
- **`installCardCss`** — writes `.obsidian/snippets/obsidian-factory.css`, the
  CSS snippet that hides the raw frontmatter block on cards in reading view and
  live preview. The person enables it in Settings → Appearance → CSS snippets.
- **`migrateCards`** — adds the `factory-card` CSS class and the readable
  sections to cards created before this version; existing summaries and plans
  are not overwritten.
- **`deleteCard`** — deletes a card through the vault model (trash by default,
  permanent on request); requires `confirm=delete`.
- **`createCategory`** — creates a Category card, optionally with its first
  ideas.
- **`createAction`** — creates an action card in Proposed, optionally linked to
  its source category.
- **`moveIdea`** — removes one idea bullet from the inbox or a category and
  appends it to an existing or new category card.
- **`archiveCard`** — takes a finished card off the active board: it writes a
  copy into `Factory/Archive` with `archiveStatus` (`done`, `deleted` or
  `duplicate`), `archiveReason`, optional `archiveDetail`, `archivedAt` and
  `previousStatus`, reads the copy back and compares it with what it wrote, and
  only then moves the original to the vault's `.trash`. A mismatch removes the
  copy and keeps the original; a failed trash keeps both and names both paths.
  It refuses the inbox and never rewrites the person's prose — the archived
  note keeps its title, At a glance, Plan and Activity log.
- **`unarchiveCard`** — puts an archived card back: it restores the column in
  `previousStatus` (Proposed when that column is gone), clears the archive
  fields, verifies the restored note and only then trashes the archive copy. It
  refuses when a card with the same file name is already on the board.

### The archive

Cards are archived, not deleted, so the reason survives the work. An archived
card leaves the board because `Board.base` only ever filters `Factory/Cards`;
it keeps everything else.

```sh
# Finish a card: done, deleted or duplicate, with the reason the person needs
# later. The copy is verified before the original moves to the trash.
swamp behavior run obsidian-board archiveCard --input id=fac-12 \
  --input outcome=done \
  --input reason="The ESPHome inventory shipped in 2026.11"

# Put it back: the card returns to the column it left and the archive fields
# are cleared.
swamp behavior run obsidian-board unarchiveCard --input id=fac-12
```

Both are also workflows, so a button or a webhook can call the same model:

```sh
swamp workflow run @svendowideit/obsidian-factory-archive \
  --input id=fac-12 --input outcome=done --input 'reason=Shipped in 2026.11'
swamp workflow run @svendowideit/obsidian-factory-unarchive --input id=fac-12
```

A remote caller can put either workflow behind a `swamp serve` webhook:

```yaml
# .swamp/serve.yaml
webhooks:
  - route: /hooks/obsidian-archive
    workflow: "@svendowideit/obsidian-factory-archive"
    secret: "@env=OBSIDIAN_ARCHIVE_TOKEN"
    scheme: generic
```

The plugin's **Archive factory card** command and the card dialog's
**Archive...** button post to that route when **Archive webhook URL** is set in
the plugin settings, and otherwise run the archive workflow with `spawn` from
the configured repo path. Either way the model writes the note; the plugin
never does.

### The factory

The bundled skill `obsidian-factory` describes the board-driven loop for the
`obsidian-idea-factory` stagecraft factory: Uncharacterised → Category →
Proposed → Please Plan → Work Planned → Please Implement → Please Test → User
Acceptance → Please Release → Done. The card is the only source of truth: its
column and content decide the work. stagecraft is an internal execution ledger;
its stage, cycle and era are implementation details and never override the card.
A card move — forward, backward or skipping a step — is normal; the factory does
that column's work and records it, without resetting, pausing or asking for a
legal transition. The factory definition is the repository's
`models/@swamp/stagecraft/factory/obsidian-idea-factory.yaml`; the skill tells an
agent how to read the board, claim and drive work items, record what each stage
did and learned, and treat a card move as the person's decision. The person may
edit any part of a card, not only `## Feedback`; every stage reads the whole card
and treats new or changed words as feedback. The card is top-heavy on purpose:
`## At a glance` sits directly under the title and carries **Needs your input**,
while `## Questions` and `## Feedback` sit above the `## Plan` detail, so the
person sees the decisions without scrolling.

### Ticking the factory

The extension ships `@svendowideit/obsidian-factory-tick`, a workflow that:

1. runs `obsidian-board tick` (board first, then housekeeping),
2. runs `obsidian-board brief`: it reads the board, writes the queue and builds
   a self-contained prompt naming every card, its column and its action,
3. starts one headless agent with `@svendowideit/obsidian-agent` (`run`) using
   that brief. The brief orders the agent to read
   `.agents/skills/obsidian-factory/SKILL.md` first, act only on `work`/`claim`
   rows, and **not** read `context.md` or any other unrelated project task file.
   A generic "tick the factory" prompt let the agent wander into unrelated
   repository work; the brief removes that ambiguity.

The agent runner is a **separate behavior** from `obsidian-board` on purpose:
a board method holds the board's instance lock, and every nested board command
the agent needs would wait for that lock until the agent exits. The runner also
passes the swamp process environment (PATH, HOME, API keys) and uses
`pi --no-session`, so a long tick cannot inherit a stale conversation.

```sh
# One-time, after the extension is pulled: create the separate agent runner.
swamp behavior create @svendowideit/obsidian-agent obsidian-agent
```

The agent stops at the person's columns and never publishes.

**From the plugin.** The plugin adds a ribbon icon and the command **Tick the
Obsidian factory**. The tick writes `.obsidian/plugins/obsidian-factory/data.json`
with the repo path as the default when it is missing, so the button works after
a reload without manual setup. Override the repo path, swamp binary, agent or
model in **Settings → Community plugins → Obsidian Factory** if needed. When
the model setting is empty the plugin resolves pi's `defaultProvider` and
`defaultModel` from `~/.pi/agent/settings.json` and passes that explicit
`provider/model` to the tick; an unpinned pi can select a weak last-used local
model and hallucinate instead of doing the card work. The
button runs the workflow with `spawn` (no shell), passes the current factory
hash, and shows a persistent **status bar** entry: `Factory: ticking Ns`, then
`Factory: done` or `Factory: failed`. The status bar opens the live **factory
tick log**; the **Show factory tick log** command works too. On failure the log
opens automatically. The log has **Copy log** and **Pause** actions and its text
is selectable; the card dialog has **Copy card markdown** and is also
selectable, so either can go straight into an issue or a prompt.

The workflow declares `@svendowideit/obsidian-factory-tick-report`. Its
end-of-run summary is the board snapshot, every card's column/action, and the
agent's duration, exit code and output — rather than only the three step names
the generic workflow summary shows.

**From the CLI.**

```sh
swamp workflow run @svendowideit/obsidian-factory-tick   --input repo=/home/me/src/swamp-project   --input agent=pi
```

A remote caller can put the workflow behind a `swamp serve` webhook:

```yaml
# .swamp/serve.yaml
webhooks:
  - route: /hooks/obsidian-tick
    workflow: "@svendowideit/obsidian-factory-tick"
    secret: "@env=OBSIDIAN_TICK_TOKEN"
    scheme: generic
```

Set the repo input once with
`swamp workflow trigger set @svendowideit/obsidian-factory-tick --input repo=/path/to/repo`,
then reload/restart serve. The route secret is mandatory; use TLS. The local
ribbon/command needs no token. The factory still never publishes.

### The card dialog plugin

The optional plugin opens a factory card as a read-only prose dialog instead of
navigating away from the board. Click a card link in the native Bases Kanban (or
run the **Open factory card as dialog** command) and the dialog shows:

- the title
- `## At a glance`, including **Needs your input**
- the brief
- `## Plan`: tasks, tests, existing/added/removed functionality and known/unknown

The dialog also offers **Archive...** for a card on the active board; it asks
for the outcome, the reason and an optional detail, then hands them to
`archiveCard` (webhook or workflow, never a plugin write).

It deliberately omits frontmatter, the Definition section, the Activity log and
the `swamp:` markers. **Open in editor** is the path to the rest; **Close** and
Escape close the dialog.

The same plugin adds the documented normal moves as buttons at the top of the
Bases kanban card face and at the top of the card dialog, with **Open in
editor** in the same action row. The command palette
(`Move factory card to <column>`) offers the same moves. A move writes the
card's `status`; the next tick follows the card. A card with no legal move shows
no move buttons. The buttons are the person's move, not an agent decision.

The bundle is built from `obsidian-plugin/main.ts` by
`obsidian-plugin/build.ts` with pinned esbuild, and `main.js.sha256.txt` is checked
before install. The native Kanban works without the plugin.

**Source and packaging.** The source is
`obsidian-plugin/main.ts`, `model.ts` and `obsidian.d.ts`; `build.ts` builds
`main.js` and `main.js.sha256.txt`. The built `main.js` is committed and listed
under `binaries:` in `manifest.yaml`; the source, hash, plugin manifest and CSS
are listed under `additionalFiles:`. `swamp extension pull` ships all of them, so
a user does not need Deno or esbuild: `installBoardPlugin` reads the bundled
files from the installed extension and writes them into
`.obsidian/plugins/obsidian-factory`.

### Safety

- Every note read and write goes through `@magistr/obsidian/vault`, which confines
  paths to the vault, refuses symlinks and writes atomically.
- The activity block is delimited by `swamp:activity:begin` and
  `swamp:activity:end`; the factory appends inside it and leaves the rest of the
  note alone.
- The inbox card is never overwritten by `installBoard`; `force` only rewrites
  the board assets and templates.
- The tracker refuses unknown statuses and types, a ticket related to itself, a
  second parent, a parent cycle, a second duplicate and a duplicate chain, and
  returns `not_found` for a missing ticket.

### Upgrade

This extension installs nothing on the host and owns no service. Upgrade by
pulling the new version; the vault model and factory are unchanged.

```sh
swamp extension update @svendowideit/obsidian-factory
```

### Limitations

- The Kanban view needs Obsidian 1.14 or later. Older Obsidian still reads the
  notes, but not the board.
- Stagecraft's graph checker does not compare CEL expressions, so `validate`
  reports the three `route` exits as ambiguous. They are not: a card's `kind` is
  exactly one of `inbox`, `category` or `action`, and the three gates test that
  one value.
- The factory is agent-driven. Stagecraft's work modes are interactive; the
  bundled skill is what turns a board state into the next stage's work. The
  deterministic operations (claim, publish, tracker contract) are workflows and
  model methods.
