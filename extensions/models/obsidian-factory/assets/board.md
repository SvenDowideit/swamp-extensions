# Idea Factory board

![[Board.base#Board]]

The board is a Bases Kanban view over the notes in `{{folder}}/Cards`. Dragging a
card between columns changes that note's `status` property; nothing else is
stored in the board file.

## The flow

| Column | What happens | Who moves it on |
| --- | --- | --- |
| Uncharacterised | Raw thoughts are added to one inbox card. The factory routes each thought to an existing category card or creates a new one. | factory |
| Category | Ideas accumulate on a category card. When it has enough, the factory proposes a common subset as an action card. | factory |
| Proposed | Refine the action card: add background, constraints, project path and questions. | you |
| Please Plan | An agent researches the existing system, writes a plan, gets an adversarial review, and cleans the plan up. | factory |
| Work Planned | Read the plan. Add feedback or questions, then move it back to Please Plan, or on to Please Implement. | you |
| Please Implement | One agent writes completeness and correctness tests; another implements the plan. | factory |
| Please Test | The tests are run against the implementation. Failures go back to Please Implement. | factory |
| User Acceptance | Try it. Send it back to any earlier column with notes, or move it to Please Release. | you |
| Please Release | The full suite and the project's release process decide. A failure returns to User Acceptance with details. | factory |
| Done | Finished. The card can be archived with its outcome and reason, which takes it off the board and into `{{folder}}/Archive`. | you or the factory |

## Adding a thought

With the optional **Obsidian Factory** plugin, the top of this page has a capture
box: type the thought, press Enter, and it lands on the one inbox card. The
native Bases view cannot host an input widget, so the box comes from the plugin;
the command palette (**Capture an idea**) and the CLI work without it. The box,
the palette and the CLI all call the same board method, so the inbox note has
one writer.

Without the plugin, open the one card in the **Uncharacterised** column (its
note is `{{folder}}/Cards/uncharacterised.md`) and add a bullet under
`## Thoughts`, or run:

```sh
swamp behavior run obsidian-board capture \
  --input 'text=the factory should remember which category an idea came from'
```

## The card pages

Every card is a normal Obsidian note. Read `## At a glance` first: it says the
current stage, whether the plan is draft or final, what is known, what is still
unknown and what happens next. `## Plan` is a checkbox list of tasks and tests,
with what existing functionality changes and what functionality is added or
removed. `## Activity` is the detailed agent journal. Who writes what, in
reading order, is in the [Guide](Guide.md#reading-a-card).

The machine-written sections use markers (`swamp:summary`, `swamp:plan`,
`swamp:activity`); leave them alone. To hide the raw frontmatter block in
reading view and live preview, run `swamp behavior run obsidian-board
installCardCss` and enable the snippet in Settings → Appearance → CSS snippets.

## What a card shows in its column

A card's column decides what is worth reading on it, so with the optional
**Obsidian Factory** plugin the kanban card face shows the fields that matter
for the column the card sits in. The plugin reads each card's managed
`## At a glance` and `## Plan` (and the `project` property) and writes nothing.

| Column | What the card face shows |
| --- | --- |
| Uncharacterised | **Needs your input**, **Next** |
| Category | **Needs your input**, **Next** |
| Proposed | plus **Project**, so you can see where the work would land |
| Please Plan | plus **Plan** (draft or final), **Tasks** and **Tests** left |
| Work Planned | the same, so you can see what the plan still covers |
| Please Implement | the same, so you can see what is left to do |
| Please Test | plus **Checks**, the known lines that report a check run |
| User Acceptance | the plan fields, so you can see what you are trying |
| Please Release | plus **Checks** |
| Done | **Needs your input**, **Next** |

A field with no value is not shown, and a managed placeholder such as
_"Nothing recorded yet."_ is not a value. **Needs your input** shows the first
open question and how many more there are; open the card for all of them.

## Where kind, project, source and updated went

The kanban card face no longer shows **Kind**, **Project**, **Source** and
**Updated**: they are the same in every column, so they decided nothing there.
They are not gone:

- the note's frontmatter still holds them, and **Open in editor** shows them;
- the **All cards** and **Waiting for a person** tables, and the **Inbox and
  categories** cards view, still order by and show them;
- the card dialog shows **At a glance**, the brief and the Plan.

The plugin hides those four rows on the kanban card face only, and it matches
rows by their Bases property key class (`mod-kind`, `mod-project`,
`mod-source`, `mod-updated`) with the property's display name as a fallback, so
renaming a display name does not bring the row back.

Two things to know:

- The plugin is optional. Without it the card face keeps showing **Kind**,
  **Project**, **Source** and **Updated**, and nothing is hidden.
- `installBoard` writes `{{folder}}/Board.base` only when it is missing, or when
you pass `--input force=true`. An older `Board.base` is therefore left exactly
as you edited it, including its kanban order; the plugin's row hiding is what
changes the card face on that vault today. A freshly installed `Board.base`
orders the **Board** view by the card title only, while its tables keep every
property.

## Templates

`{{folder}}/Templates/` holds card, category and action templates for the core
Templates plugin. The inbox card is created once by `installBoard`; the factory
creates category and action cards itself.

## The factory

The state machine lives in the `obsidian-idea-factory` stagecraft factory. The
board is its tracker: every column is a stagecraft tracker status, and moving a
card to a person's column is the person's decision. The agent that drives the
factory reads the board, does the stage's work, records what it did and
learned, and advances the work item.
