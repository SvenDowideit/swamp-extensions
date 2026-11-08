# Archive

![[Archive.base#Archive]]

Finished cards leave the active board and live in `{{folder}}/Archive`. Each one
keeps its whole note — the title, **At a glance**, the Plan and the Activity log
— plus the outcome it ended with, why, and when.

| Outcome | Meaning |
| --- | --- |
| **done** | The work was finished; the card did what it was for. |
| **deleted** | The idea or work is dropped and will not be done. |
| **duplicate** | Another card covers it; the reason names the card. |

## Archiving a card

Use the command palette, the CLI, or the **Archive factory card** command in the
optional plugin:

```sh
swamp behavior run obsidian-board archiveCard --input id=fac-12 \
  --input outcome=done \
  --input reason="The ESPHome inventory shipped in 2026.11" \
  --input 'detail=Released with the fleet inventory report'
```

The factory writes a copy into `{{folder}}/Archive`, reads it back and compares
it with what it wrote, and only then moves the original to the vault's `.trash`.
If the copy does not read back unchanged, the copy is removed and the original
is kept. If the original cannot be trashed, both notes are kept and the error
names both paths. The inbox card is refused: it is the person's inbox, not
finished work.

## Putting one back

Archived cards can be restored. The card returns to the column it left (or
**Proposed** when that column no longer exists) and the archive fields are
cleared:

```sh
swamp behavior run obsidian-board unarchiveCard --input id=fac-12
```

The card is never silently overwritten: if a card with the same file name is
already on the board, unarchive refuses and says so.

## The files

`Archive.base` is the table over `{{folder}}/Archive`, grouped by outcome, with
a view per outcome. `Board.base` only ever filters `{{folder}}/Cards`, so an
archived card disappears from the board the moment its note leaves that folder.
