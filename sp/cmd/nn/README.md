# nn — an nn-style reader for a swamp repository

`nn` is a terminal reader for **everything that arrives**: news, tasks, fleet
and object inventories, and the workflows you can run. It borrows its interface
from the 1984 Usenet reader `nn`: a menu of one line per item, single-keystroke
selection, and then you read only what you chose.

> `nn`'s goal is not to read news. You decide from headers, in bulk, before
> reading anything; then you read what you chose, and you are **done**.

Design and rationale: [`docs/nn-tui-plan.md`](../../../docs/nn-tui-plan.md).

## Run

```sh
go build -o nn ./cmd/nn
./nn                     # discover the repo from cwd, use/start serve on :9090
./nn --group news        # start in a group instead of the overview
./nn --check             # load every group, print a summary, exit (nncheck)
./nn --group runs:workflows/@svendowideit/news-fetch --check   # one history + its schema
./nn --group runs:methods/gtd.capture --check                  # a method's history + schema
```

`nn --check` is the `nncheck` of this suite: it answers "is my config right and
did the sources load?" without opening a TUI, and exits non-zero if any group
failed.

## Keys

Overview (`Y`): `j/k` move · `space`/`enter` open a group · `R` reload all ·
`Q` quit.

Menu: `a-z 0-9` select the row with that id · `.` toggle and advance ·
`j/k` move · `%` **peek** at the row under the cursor (a body pane under the
menu; `%`/`space`/`esc` closes it, `j/k` scrolls it, and it marks nothing) ·
`space` continue (mark this page seen, then read selections, then next page,
then next group) · `return` continue without marking · `N`/`P` next/previous
group · `/` filter · `Y` overview · `=` up · `R` reload · `Q` quit.

To read something: `%` to look, or mark it and press `space`. That two-step is
deliberate — it is how `nn` made triage cheap.

Reader: `space` page then next item · `b` back · `j/k` scroll · `=` menu ·
`N` next group · `Q` quit.

Run form: `tab`/`↑↓` field · `space` toggle a boolean · `enter` edit · `ctrl+r`
restore the last run's inputs · `ctrl+s` run · `=` cancel.

Live run: `q` detach (it keeps running) · `x` cancel · `j/k` scroll · `=` menu.

## Runnables

Two groups, one grammar:

- `runs:workflows` — one row per workflow. `space` opens its history: a pinned
  `+ run this workflow…` row, then the last 50 runs.
- `runs:methods` — one row per *model instance × method* (950 rows here), so
  narrow it with `/` first: `/gtd`, `/capture`. `space` opens the same history
  plus `+ run <method>`.

Selecting a runnable row with its letter and pressing `space` opens its history
(doorways are not read in bulk); reading one with `%`/the pager also tells you
where it leads, and `space`/`enter` there opens it too.

`+ run` opens a form generated from the declared arguments; `ctrl+s` runs it and
switches to a live view. Workflows run with `workflow.run`, methods with
`model.method.run` — the payload shapes come from the serve protocol, not from
guessing.

## Reading a menu line

```
▸ a· SEC arXiv cs.AI  Inference-time scaling revisited
  ↑ ↑  ↑   ↑          ↑
  | |  |   |          └─ menu columns from nn.groups.yaml
  | |  |   └─ badge (a flag field, e.g. a security update)
  | |  └─ attribute: · unread  , seen  * selected  = leave  . read
  | └─ article id: type this letter to select the row
  └─ cursor
```

Attributes are **explicit**. `space` marks the page it leaves *seen*;
`return` marks nothing; only paging past an item marks it *read*. Nothing is
ever marked read because time passed — that was `nn`'s `auto-junk-seen`, and it
was the behaviour its users complained about most.

## Sources

Groups come from the built-in defaults, or from `nn.groups.yaml` in the repo
root, which replaces them:

```yaml
version: 1
defaults:
  pageSize: 40
groups:
  - id: news
    kind: data                 # data | objects | runs
    model: local-news          # the model instance that owns the data
    resource: filtered-snapshot
    path: articles             # dotted path into the resource content
    id: id
    format: article            # article | text | markdown | html | row | run | form
    menu: [source, title]
    sort: "publishedAt desc"
    newSince: publishedAt
    body: summary
    meta: [source, publishedAt, url]
    link: url
```

Ordering of your attention is `nn.sequence`, if present:

```
inbox:all
news
tasks:inbox
! tasks:older          # never show
NEW                    # everything not named above
```

State (attributes, watermarks, positions, last run inputs) lives in
`$NN_STATE`, else `$XDG_DATA_HOME/nn/state.json`, else
`~/.local/share/nn/state.json`. Use `--no-state` for a throwaway session.

## Layout

```
cmd/nn/main.go        flags, serve lifecycle (own/adopt/stop), nncheck
internal/nn/
  types.go            Group, Item, Attr, GroupSpec
  config.go           built-in group set + nn.groups.yaml
  sequence.go         nn.sequence
  fields.go           field paths, timestamps, sorting, one-line menu rendering
  source.go           loaders: swamp data, workflows/models
  runs.go             loaders: runnables and their history
  state.go            attributes, watermarks, positions (atomic JSON)
  pager.go            read item UI (article/text/markdown/html/row/json)
  form.go             JSON Schema -> form fields -> validated inputs
  live.go / run_ui.go live run item UI + form/live keys
  shell.go            the shell: modes, keys, rendering
```

Everything talks to `swamp serve`; nothing shells out per keystroke, reads
`.swamp/`, or writes another extension's data.
