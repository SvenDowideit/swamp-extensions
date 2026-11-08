# Idea Factory — guide

The board is a Bases Kanban view over the notes in `{{folder}}/Cards`. Every card
is one note; its `status` property is its column. Dragging a card changes the
property, and the factory always reads the property, never a separate board
file.

## Capture

Add a bullet under `## Thoughts` on `{{folder}}/Cards/INBOX Uncharacterised.md`, or:

```sh
swamp behavior run obsidian-board capture --input 'text=...'
```

The inbox is one card on purpose: ideas arrive mixed up and the factory does
the separating. It routes each thought to an existing category card or creates
a new category, and records why in the inbox card's activity.

## Category cards

A category card collects related ideas. When the factory sees a common subset
worth doing, it creates an action card in **Proposed**. The action card links
back to its category.

## The person's columns

- **Proposed** — refine the brief: what it is, why, constraints, the project
  path, questions. Then drag it to **Please Plan**.
- **Work Planned** — read the plan. Add feedback anywhere on the card — the
  top is the easiest place — and drag back to **Please Plan**, or drag to
  **Please Implement**.
- **User Acceptance** — try it. Add notes, then drag back to any earlier column,
  or to **Please Release**.
- **Please Release** — the full suite and release process decide.

Moving a card is the instruction. The agent reads the whole card, quotes every
new or changed word, and records it in the activity log before it takes the
matching transition. You do not have to put feedback under `## Feedback`.

## The factory's columns

**Please Plan**, **Please Implement**, **Please Test** and **Please Release**
are worked by the factory. **Uncharacterised** and **Category** are worked by
the idea stages. **Done** is terminal.

## Opening a card as a dialog

The optional **Obsidian Factory** plugin opens a card in a read-only dialog
without leaving the board.

```sh
swamp behavior run obsidian-board installBoardPlugin
```

The install enables **Obsidian Factory** in `community-plugins.json` by default.
Then **restart Obsidian once** so the newly installed or replaced `main.js` is
loaded. If you passed `enable=false`, enable it in **Settings → Community
plugins** (turn off Restricted mode if needed); if it is not listed, restart
once first. Click a card link in the native Kanban view (or run **Open factory
card as dialog**).
The dialog shows the title, **At a glance** (including **Needs your input**), the
brief and the Plan. It omits frontmatter, the Definition section and the
Activity log; **Open in editor** is the path to the rest. The plugin only reads
the note.

## Ticking the factory

Use the ribbon icon or the command **Tick the Obsidian factory**. Set the swamp
repo path, swamp binary and agent in **Settings → Community plugins → Obsidian
Factory**. The tick runs the board-first housekeeping, refreshes the queue and
starts one agent to work the factory columns. The agent stops at your columns
and never publishes.

## Moving a card with buttons

The optional plugin shows the documented normal moves as buttons at the top of
the kanban card face and at the top of the card dialog, with **Open in editor**
in the same action row. The command palette (**Move factory card to <column>**)
offers the same moves. Clicking one writes the card's status; the next tick
follows the card. A card with no legal move shows no move buttons. The native
drag still works.

## Reading a card

Each card has three kinds of writing:

- **Your prose** — the title, brief, ideas, questions and feedback.
- **`## At a glance`** — the first thing under the title. It shows the current
  stage, whether the plan is absent, draft or final, **Needs your input**, the
  next step, and what is known and unknown. Put your questions and decisions
  here so they are visible without scrolling.
- **`## Questions` and `## Feedback`** — sit above the Plan, so they are easy
  to reach. Any new or changed word anywhere on the card is feedback.
- **`## Plan`** — a live checkbox list of tasks and tests, what existing
  functionality changes, what functionality is added or removed, and the
  known/unknown lists. The factory ticks a task when it is actually done and a
  test when it has run and passed. It is written as a draft by the plan stage
  and marked final after the adversarial review and cleanup. It is detail to
  scroll to, not the first thing you must read.
- **`## Activity`** — the detailed agent journal. Use it for deep
  investigations; it is not the summary.

The `swamp:summary`, `swamp:plan` and `swamp:activity` markers keep the
machine-written sections separate from your prose.

## Hiding the Obsidian metadata

The raw frontmatter block is the ticket's data; the board needs it. The
factory tick writes the `obsidian-factory` CSS snippet and adds it to
`enabledCssSnippets`, but Obsidian only reads that list at startup. Reload
Obsidian, or enable `obsidian-factory` once in **Settings → Appearance → CSS
snippets**. The manual fallback is:

```sh
swamp behavior run obsidian-board installCardCss
```

 If the change does
not appear immediately, reload Obsidian or toggle the snippet once in
**Settings → Appearance → CSS snippets**. The snippet hides the metadata block
in reading view and live preview for notes with the `factory-card` class; no
other note matches. Source mode still shows the YAML, because that is the file.
Existing cards get the class from:

```sh
swamp behavior run obsidian-board migrateCards
```

## Commands

```sh
# Install the board, page and templates (idempotent).
swamp behavior run obsidian-board installBoard

# Add a thought to the inbox.
swamp behavior run obsidian-board capture --input 'text=...'

# Read the board.
swamp behavior run obsidian-board scan

# Move an idea from the inbox to a category.
swamp behavior run obsidian-board moveIdea \
  --input from=inbox --input idea="the caching idea" --input to=fac-3

# Create a category or an action directly.
swamp behavior run obsidian-board createCategory --input name="Caching"
swamp behavior run obsidian-board createAction \
  --input title="Write-through cache" --input source=fac-3 \
  --input brief="Make the cache write-through before the next release"
```
