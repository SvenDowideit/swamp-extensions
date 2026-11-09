# Idea Factory — guide

The board is a Bases Kanban view over the notes in `{{folder}}/Cards`. Every card
is one note; its `status` property is its column. Dragging a card changes the
property, and the factory always reads the property, never a separate board
file.

## Capture

On the kanban board page — the **Board** page — the **Obsidian Factory** plugin
adds a capture box above the columns: type the thought, press Enter or **Add
idea**, and it lands on the one **Uncharacterised** card. The box is part of the plugin because a native
Bases view cannot host an input widget; the command palette (**Capture an
idea**) does the same from anywhere in the vault.

Without the plugin, add a bullet under `## Thoughts` on the one card in the
**Uncharacterised** column (its note is
`{{folder}}/Cards/uncharacterised.md`), or run:

```sh
swamp behavior run obsidian-board capture --input 'text=...'
```

Empty text is refused: nothing is written until there is a thought to keep.
Every path calls the board model's `capture` method, which appends the bullet;
the plugin never writes the note itself. The inbox is one card on purpose:
ideas arrive mixed up and the factory does the separating. It routes each
thought to an existing category card or creates a new category, and records why
in the inbox card's activity.

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
Activity log; **Open in editor** is the path to the rest. **Copy card markdown**
copies the whole note for reuse, and the dialog text is selectable. The plugin
only reads the note.

## Ticking the factory

Use the ribbon icon or the command **Tick the Obsidian factory**. The tick
sets the plugin's default repo path in `data.json` when it is missing, so the
button works after a reload without manual setup. Override the repo path, swamp
binary, agent or model in **Settings → Community plugins → Obsidian Factory**
if needed. An empty model setting means the plugin resolves pi's configured
default provider/model and pins it explicitly, so pi cannot drift onto a weak
last-used local model. The tick runs the board-first housekeeping, builds a brief that names
the board and queue, and starts one agent to work the factory columns. The
brief tells the agent to read the factory skill first and not to wander into
unrelated project files. The agent stops at your columns and never publishes.
The status bar shows **ticking / done / failed**; click it or run **Show factory
tick log** to read the live output. The log has **Copy log** and **Pause** and
is selectable; the card dialog has **Copy card markdown** and is selectable
too. A failure opens the log automatically. The workflow report shows the
board, queue and the agent output. The plugin starts the tick through your
login shell, so an API key exported in `.bashrc` (for example
`OLLAMA_API_KEY`) is available even though Obsidian itself was launched from
the desktop. The Tick process adds the common agent
directories and nvm Node bins to PATH, so an agent that needs `node` can run
even when Obsidian's own PATH is minimal.

## Moving a card

Click a factory card in the kanban to open its dialog. The dialog has the
documented **Move to …** buttons and **Open in editor** at the top. The command
palette (**Move factory card to <column>**) offers the same moves. Clicking one
writes the card's status; the next tick follows the card. The native drag still
works. There are no move buttons on the card face itself — Bases cards are
native and the plugin no longer injects an action row into them.

## What a card shows in its column

The card face is native Bases, with three short content rows:

- **What** — the card intro or Plan summary, whichever is the current content;
- **Now** — the live state for that column: task/test progress, checks, the open
  need or the current questions;
- **Next** — the actual next move, when there is one.

The card dialog has the full At a glance, the brief and the Plan. Kind, project,
source and updated stay in the frontmatter and the table/cards views, not on the
kanban face. `installBoard --input force=true` updates an older `Board.base` to
this card face.

## Archiving a finished card

Finished cards leave the board instead of piling up in **Done**. Open
`{{folder}}/Archive.md` (or the `Archive.base` file) to read the history: every
archived card keeps its whole note, plus what happened, why and when.

Use the command palette (**Archive factory card**), the plugin button, or:

```sh
swamp behavior run obsidian-board archiveCard --input id=fac-12 \
  --input outcome=done --input reason="Shipped in 2026.11"
```

The outcome is **done**, **deleted** or **duplicate**, the reason is required,
and an optional detail line says more. The factory writes the copy first, reads
it back to check it, and only then moves the original to the vault's trash. If
anything does not match, the original stays on the board. The inbox card is
never archived.

To put a card back, run **Unarchive factory card** from the palette (open the
archived card, or run it from `{{folder}}/Archive.md`), or:

```sh
swamp behavior run obsidian-board unarchiveCard --input id=fac-12
```

It returns to the column it left (or **Proposed** if that column no longer
exists), and refuses rather than overwrite a card already on the board.

## Reading a card

Read a card top to bottom; the top is what the factory and you act on.

1. **The title** — one human-readable title. The card's id lives in the
   frontmatter and in links, not in the title or the filename.
2. **`## At a glance`** — the first thing under the title, written by the
   factory. It shows the current stage, whether the plan is absent, draft or
   final, **Needs your input**, the next step, and what is known and unknown.
   **Needs your input** holds the questions and decisions waiting on you, so
   you do not have to hunt for them. Put your own questions and decisions here
   too, and they stay visible without scrolling.
3. **Your prose** — the `## Brief`, the `## Ideas` bullets, the `## Thoughts`
   capture, `## Questions` and `## Feedback`. You write all of this; the
   factory only reads it, quotes it into the activity log and answers it. Any
   new or changed word here is feedback, and so is an edit anywhere else on the
   page.
4. **`## Questions` and `## Feedback`** — kept directly above the Plan so they
   are easy to reach. They are ordinary sections: using them is a habit, not a
   requirement.
5. **`## Plan`** — a live checkbox list of tasks and tests, what existing
   functionality changes, what functionality is added or removed, and the
   known/unknown lists. The factory writes it as a draft in **Please Plan** and
   marks it final after the adversarial review and cleanup. It ticks a task
   when the work is actually done and a test when it has run and passed. It is
   detail to scroll to, not the first thing you must read.
6. **`## Definition`** — one line saying which factory definition version the
   work item is pinned to. A running work item keeps the definition it started
   with, so editing the factory never changes work in flight.
7. **`## Activity`** — the detailed agent journal: what each stage did and
   learned, and every move a person made. Use it for deep investigations; it is
   not the summary.

The factory writes `## At a glance`, `## Plan`, `## Definition` and
`## Activity` between `swamp:summary`, `swamp:plan`, `swamp:definition` and
`swamp:activity` markers. The markers keep the machine-written sections
separate from your prose, and the factory refuses to overwrite one you have
edited until it has quoted your words back. Everything outside those blocks is
yours.

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
