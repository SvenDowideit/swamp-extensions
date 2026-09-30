# sp — a Smalltalk-inspired browser for swamp

A terminal (TUI) browser for a swamp repository. It discovers workflows and
models from a running `swamp serve`, shows each one's detail (a workflow's
job/step DAG, or a model's methods and data output specs), and lets you drill
into the data each produces.

It is the first prototype from `docs/smalltalk-browser-research.md`: the
"System Browser" shell — selection-linked panes over one live object model,
built on the serve protocol rather than by shelling out to the `swamp` binary.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ swamp browser  swamp-project                        local serve :9090 (owned) │
│ ╭──────────────╮ ╭──────────────╮ ╭────────────────────────╮ ╭────────────╮ │
│ │ Workflows(41)│ │ Models (30)  │ │ Detail — caddy-ensure- │ │ Data (2)   │ │
│ │ caddy-…      │ │ bom          │ │          proxy         │ │ current    │ │
│ │ disk         │ │   bom-weather│ │ Jobs (1)               │ │   resource │ │
│ │ @x/tuios-…   │ │ ideas-factory│ │   ▸ main               │ │ summary    │ │
│ │              │ │ meta-factory │ │     • setup workflow:… │ │   report   │ │
│ │              │ │              │ │     • ensure … ← setup │ │            │ │
│ ╰──────────────╯ ╰──────────────╯ ╰────────────────────────╯ ╰────────────╯ │
│ [workflows]  ↑↓ move  enter open DAG  / filter  tab pane  s search  q quit   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Serve lifecycle (the important part)

When `sp` starts inside a swamp repo it will **not** shell out per request. It:

1. Walks up from the working directory for `.swamp.yaml` (or honours
   `SWAMP_REPO_DIR` / `--repo`).
2. Probes `GET /auth/info` on the chosen port. If a swamp serve is already
   there, it **adopts** it and leaves it running.
3. If nothing is listening, it starts `swamp serve --no-schedule` on the port,
   **owns** it, and waits for `GET /ready`.
4. On quit (including Ctrl-C / SIGTERM) it terminates the server **it started**
   — the whole process group, SIGTERM then SIGKILL — so no orphaned
   `swamp serve` survives the tool. A server it merely adopted is never
   stopped.

The ownership state is shown in the top-right: `local serve :9090 (owned)` vs
`existing serve`.

## Stack

Matches TUIOS: Go, [`charm.land/bubbletea/v2`](https://charm.land/bubbletea)
(Elm-architecture TUI runtime) and
[`charm.land/lipgloss/v2`](https://charm.land/lipgloss) (styling/layout), plus
`github.com/coder/websocket` for the serve transport and `golang.org/x/net/html`
for the built-in HTML→text renderer.

## Layout

```
sp/
  main.go                     # flags, repo+serve lifecycle, tea program
  internal/swamp/
    protocol.go               # request literals, wire envelope, error/event types
    client.go                 # WebSocket client: Request/Stream/typed helpers
    serve.go                  # repo discovery, EnsureServe, Stop (owns/kills)
    serve_integration_test.go # spawn+adopt+no-orphan tests (build tag: integration)
  internal/ui/
    model.go                  # state + async load commands
    update.go                 # key handling, filtering, selection, pane cycling
    view.go                   # pane layout (workflows/models/detail/data)
    viewer.go                 # run-output artifact viewer (dialog + fetch)
    views.go                  # contextual view registry (forecast/bars/table/fields/json)
    playground.go             # CEL query console (data.query + shape rendering)
    htmlrender.go, mdrender.go, inline.go, richtext.go  # HTML/markdown → text
    styles.go, util.go        # styling + JSON/size helpers
    *_test.go                 # deterministic render/selection tests
  cmd/probe/                  # dev aid: dump live serve response shapes
```

## Run

```sh
cd /home/sven/src/swamp-project/sp
go build -o sp .
./sp                    # discover repo from cwd, use/start serve on :9090
./sp --port 9099        # use/start serve on another port
./sp --no-spawn         # never start a server; fail if none is running
./sp --server ws://host:9090 --token <name>.<secret>   # attach to a remote serve
```

A **context-sensitive status bar** at the bottom always shows the keys valid for
the current state (which pane has focus, or whether you are typing). Hints that
would overflow a narrow terminal are dropped from the right.

Keys: `s` (or `ctrl+p`) opens the **Spotter** — one search box over models,
workflows, and the data catalog; type to filter, `↑`/`↓` to move, `enter` to
jump. Otherwise: `tab`/`h`/`l` switch panes, `↑`/`↓` move (or scroll the Detail
pane), `enter` open a workflow DAG or model detail / view content, `/` filter the
focused list, `esc` return to the owning pane, `r` reload, `q` quit.

## Panes

Four selection-linked panes, dropped responsively as the terminal narrows:

| Width  | Panes                              |
| ------ | ---------------------------------- |
| ≥ 110  | Workflows · Models · Detail · Data |
| 84–109 | Models · Detail · Data             |
| < 84   | Models · Detail                    |

- **Workflows** — from `workflow.search`. `enter` loads the DAG (jobs, ordered
  steps with dependency arrows, nested `workflow:` steps), that workflow's
  **recent runs** (`workflow.run.search`), and its produced data. `R` runs it.
- **Models** — from `model.search`. `enter` loads methods and data-output specs
  plus the model's data.
- **Detail** — the DAG (with recent runs) or method list; scrollable. `R` runs
  the workflow; `u` resumes at the failed step when the last run failed. For a
  workflow root, each run in **Recent runs** lists its outputs as selectable
  sub-bullets — see [Browsing a run's outputs](#browsing-a-runs-outputs).

The list panes **scroll to follow the selection**: moving past the bottom (or
jumping via Spotter) shifts the window so the selected row is always visible, and
the title shows a `first–last/total` indicator when the list overflows (e.g.
`Models (30) 9–19/30`).

Every pane whose content is longer than the pane shows a **persistent
proportional scrollbar** in its right-hand column — a thumb sized to
`visible/total` that tracks the scroll position (Workflows, Models, Data, and the
scrolling Detail pane). Panes whose content fits show no bar.
- **Data** — data produced by the selected workflow (`data.list` with
  `workflowName`) or model. `enter` fetches the item's content with a scoped
  `data.get`.

The Detail and Data panes always describe one **root** (a workflow or a model);
`esc` returns focus to the pane that owns it.

## Running a workflow (live)

`R` on a workflow starts `workflow.run` over the protocol and opens a **run
dialog** — a compact overlay (≈86% × 70% of the screen) that streams the run's
events. It floats over the browser rather than taking the whole screen, so the
context key bar and the surrounding panes stay visible:

```
│     ╭──────────────────────────────────────────────────────────────────────╮
│     │ Run — disk                                           ● running       │
│     │ event line 40                                                     █   │
│     │ event line 41                                                     █   │
│     │ …                                                                     │
│     │ ↑↓ scroll  c cancel run  esc detach (keeps running)                  │
│     ╰──────────────────────────────────────────────────────────────────────╯
[models]  ↑↓ move  enter open  / filter  tab pane  s search  r reload  q quit
```

The events handled are `validating_inputs`, `evaluating_workflow`, `started`,
`job_started`, `step_started`, `model_resolved`, `method_executing`,
`method_output` (stdout/stderr), `step_completed`/`step_failed`, `job_completed`,
and `completed` (which carries the final `run` status). The dialog has its own
proportional scrollbar, pinned to the tail while the run streams; `↑`/`↓` and
`pgup`/`pgdn` scroll back through history.

### Is it still running? Detach, and quitting

The run is **owned by `swamp serve`, not by the browser**. The dialogue is a
subscriber:

- **`esc` detaches** — the dialog closes but the run keeps streaming in the
  background. The header then shows a persistent `● running <id>  (o open)`
  chip, and `o` reopens the dialog. When a detached run finishes, the chip
  switches to `! ■ succeeded` / `! ■ failed` with `(o results)` until you look.
- **`q` while a run is active prompts** rather than quitting outright:
  `d` **detaches and quits** — it deliberately does *not* stop the serve it
  started, so the run continues after `sp` exits; `x` cancels the run and stops
  an owned serve before quitting; `esc` stays. (If `sp` merely attached to an
  existing serve, that serve was never going to be stopped regardless.)

So yes: start a long workflow, press `esc` to detach, then `q` → `d`, and the
workflow keeps running server-side. Re-run `sp` later and the run's history is
in the workflow's **Recent runs**.

If a workflow declares inputs, `R` first opens a small form generated from its
`inputs` JSON schema (`path`, `excludePatterns`, …), coercing each field to its
declared type (string/integer/boolean/array/object) before starting. Workflows
with no declared inputs run immediately.

If the most recent run failed, `u` sends `workflow.resume` with `from` set to the
failed step (and the failed `runId`) to re-enter the run at that point.

## Browsing a run's outputs

Workflows often produce things you actually want to *read*: model data, **reports**
(markdown/JSON), and **files** such as rendered HTML (`index.html`, `board`). The
Detail pane makes each of those a first-class, clickable bullet.

For a workflow root, every entry in **Recent runs** is followed by its outputs as
sub-bullets, each tagged by kind and step:

```
Recent runs (1)
  ● succeeded 09-21T23:29  5/5 steps  2s
      ◆ device-list  [sync · garmin-devices v31]        ← model data (resource)
      ▤ report @swamp/method-summary  [sync · ... v3]   ← a report (markdown)
      ◫ index.html  [render · pulse v21]                ← a file (e.g. HTML)
```

- `◆` model data · `▤` report · `◫` file.

Outputs come from `workflow.history.get` (run id → `jobs[].steps[].dataArtifacts`),
which is the only surface that links a run to the data/reports it produced —
`workflow.run.search` lists runs but not their artifacts, and reports are
model-scoped rather than `workflowRunId`-tagged.

In the **Detail** pane, `↑`/`↓` move the selection through these output bullets;
`enter` opens the selected one in the **artifact viewer** — a large overlay that
scrolls (`↑`/`↓`, `pgup`/`pgdn`, `g`/`G`) and closes with `esc`. Content is
fetched with a `data.get` scoped to the owning model and version, then rendered
by content type:

- **HTML** (`text/html`) → parsed and laid out to terminal text: headings,
  paragraphs, bullet/ordered lists, tables, blockquotes, fenced code, and inline
  bold/italic/code/links (link text is styled; the href is dimmed after it). No
  browser required, and it works over SSH.
- **Markdown** (`text/markdown`, i.e. reports) → headings, tables, lists,
  blockquotes, and inline emphasis, wrapped to the pane.
- **JSON** (`application/json`) → **contextual views** (see below).
- **Anything else** → wrapped as plain text.

If the run recorded an artifact whose data has since been **garbage-collected**
(reports keep only a few versions), the viewer says so plainly instead of erroring.

> HTML is rendered to text, not pixels — CSS layout and images are out of scope.

## Contextual views (the moldable inspector)

A JSON artifact is not just a blob — it has a *type*, and the right rendering
depends on it. This is the Moldable-Development layer the research doc calls
proposal C: the same data, shown as a forecast card, a bar chart, a table, or raw
JSON, chosen by shape.

The viewer runs a small **view registry** over every JSON artifact. Each view
declares the value shape it understands and returns `ok=false` when the data does
not fit, so detection is by structure, not by hard-coded model names:

| View        | Detected by                                              | Renders                                             |
| ----------- | -------------------------------------------------------- | --------------------------------------------------- |
| `forecast`  | an object with a `days[]` of per-day objects             | a per-day table with weather glyphs, min/max, rain  |
| `bars`      | an array with `fraction` / `totalBytes` / `bytes` / `count` | a proportional bar chart with sizes and percentages |
| `table`     | the largest array of objects                             | an aligned table of the first columns               |
| `fields`    | any object                                               | aligned key/value summary (timestamps shortened)    |
| `json`      | always (fallback)                                        | the pretty-printed raw document                     |

The most specific matching view is shown first; `v` **cycles** through the rest,
and the title shows the active view and position (`[bars] 1/4 views`). So a
`disk-auditor` snapshot opens as a size bar chart, a BOM `forecast` as a weather
table, and a generic resource as a table — with raw JSON always one keypress
away, and JSON only ever falling back to the raw dump.

```
╭──────────────────────────────────────────────────────────────────────╮
│ current  disk-auditor  [bars] 1/4 views                              │
│ Categories                                                          │
│   Other             103.8 GiB  ███████████████████░░░░░░░░░░  64%   │
│   VM/disk images    20.3 GiB   ███████░░░░░░░░░░░░░░░░░░░░░  13%    │
│   Databases         7.8 GiB    ██░░░░░░░░░░░░░░░░░░░░░░░░░░░   5%   │
│ ↑↓ scroll  g/G top/end  v next view  esc close                       │
╰──────────────────────────────────────────────────────────────────────╯
```

The **Data** pane opens items here too: `enter` on a data item opens the same
contextual inspector (falling back to inline rendering for non-JSON content).

### Extending the registry

`internal/ui/views.go` is the whole registry — `ctxViews` is an ordered slice of
`{name, render}`. Adding a view is one function that inspects a decoded value and
returns styled lines. This is deliberately the seam an extension would plug into
(the swamp-native end state: a **report extension** that declares "for data
matching X, render Y", per research proposal G), so it is kept small and
data-driven rather than a pile of per-model special cases.

## Playground (CEL query console)

The Playground is a Smalltalk **Workspace**: `p` opens an overlay where you
evaluate a [CEL](https://github.com/google/cel-spec) predicate over the whole
data catalog via `data.query`, then send the result to the viewer. It is the
"workspace → new view" dataflow the research doc calls Phase 4.

```
╭──────────────────────────────────────────────────────────────────────╮
│ Playground  data.query                                       7 rows  │
│ ▸ predicate modelName == "bom"                                       │
│   select    [modelName, name, string(version), dataType]             │
│ ──────────────────────────────────────────────────────────────────── │
│  bom  report-swamp-method-summary  52  report                        │
│  bom  observation                  13  resource                      │
│  bom  forecast                     11  resource                      │
│ e edit  tab field  enter run  ↑↓ row  v view row  [ ] history  esc … │
╰──────────────────────────────────────────────────────────────────────╯
```

- `p` — open the console (prefilled from the selected model when there is one).
  It opens on a **built-in help panel** the first time, so it teaches itself.
- `?` — show/hide that help panel at any time; `esc`/`h` hides it (and `esc`
  again closes the console).
- `e` / `i` — edit the focused field; `tab` switches between **predicate** and
  **select**; `enter` runs the query.
- `↑`/`↓` move through result rows; `v` (or `enter` on a row) opens it in the
  artifact viewer.
- `[` / `]` step back/forward through query **history**.
- `y` seeds a useful default `select` projection.

### Built-in help and examples

The panel is a cheat-sheet plus runnable examples, so you never have to leave the
tool to learn the syntax:

- **Fields** available to the predicate (`modelName`, `name`, `version`,
  `dataType`, `contentType`, `size`, `specName`, `tags.<key>`,
  `attributes.<key>`, `workflowName`, …).
- **Operators** and CEL string methods (`contains`, `startsWith`, `matches`,
  `has(...)`, `string(...)`).
- **Select shapes** — blank (whole records), `[a, b]` (positional table),
  `{x: a}` (named table), or a bare expression (scalars).
- **Eight runnable examples** — *Everything*, *One model*, *Files only*,
  *Reports*, *Large artifacts*, *JSON resources*, *By workflow*, *Name prefix*.
  `↑`/`↓` to pick one, `enter` to load **and run** it. The selected example shows
  its exact `predicate` and `select`, and the panel scrolls to keep it in view.

```
╭──────────────────────────────────────────────────────────────────────╮
│ Playground  data.query                                         help  │
│ ▸ predicate                                                          │
│   select                                                             │
│ ──────────────────────────────────────────────────────────────────── │
│ Query the data catalog with CEL                                      │
│ The predicate is a CEL expression evaluated over every data …        │
│                                                                      │
│ Fields                                                               │
│   modelName  name  version  dataType  contentType  size              │
│   tags.<key>        e.g. tags.type == "report"                       │
│                                                                      │
│ Examples — ↑↓ then enter to run                                      │
│   Everything       list every data artifact as a table               │
│ ▸ Files only       rendered files such as HTML pages                 │
│       pred  dataType == "file"                                       │
│       sel   [modelName, name, contentType, string(size)]             │
│ ↑↓ example  enter run example  ? hide help  esc close                │
╰──────────────────────────────────────────────────────────────────────╯
```

Results are rendered by the shape the select produces:

- **no select** → the raw `DataRecord`s, one selectable row each
  (`model · name · version · type · size`); each opens in the viewer.
- **list** `[...]` → a positional table.
- **map** `{...}` → a named-column table.
- **scalar** → a numbered list of values.

CEL errors come back with the server's caret snippet and are shown inline. This
is the same query primitive Spotter uses to index the catalog, exposed directly.

## Spotter (global search)

Pressing `s` builds a single in-memory index from three sources — `model.search`,
`workflow.search`, and a `data.query 'size >= 0'` projection over the data
catalog — and ranks matches: exact first, then prefix, then substring, then
subtitle, with models/workflows preferred over data on ties. Jumping to a model
selects it in the Models pane and loads its detail; jumping to a data item also
positions the Data pane on that item; jumping to a workflow selects it and loads
its DAG.

## Tests

```sh
go test ./...                                   # unit (render/layout/filter/DAG/run)
go test -tags integration -run TestEnsureServe ./internal/swamp/  # lifecycle
# drive the real TUI model against a live server:
swamp serve --port 9090 --no-schedule &
SP_SERVER=ws://127.0.0.1:9090 go test -tags integration ./internal/ui/
```

The lifecycle tests prove the hard requirements: a spawned server is reachable
after `EnsureServe`, is gone after `Stop`, a pre-existing server is adopted
rather than owned, and a **detached** server survives `Stop` (`Detach`). The live
tests load the real workflow list, render a DAG, drill into data content,
**start a real run and drain its event stream through the UI's Update loop to a
`succeeded` terminal state**, open each of a real run's outputs through the
viewer (including HTML), run real CEL queries through the Playground (records,
list/map/scalar projections, and a syntax error), select the right contextual
view for real JSON artifacts (forecast, bars) and cycle to raw json, and verify a
failed run's step is exposed for resume.

## Status / next

Prototype. Current surface:

- **Phase 0 — Spotter** (done): global search over models, workflows, and data.
- **System Browser** (done): models → methods + data-output specs → data
  contents (JSON pretty-printed), selection-linked panes.
- **Workflow pane + DAG** (done): workflows → job/step DAG with dependency
  arrows and nested-workflow steps → workflow data.
- **Live run browser** (done): `R` streams a workflow run's events into a console
  (with input form and cancel), recent runs in the detail, and `u` resume-at-step.
- **Run-output inspector** (done): each recent run's data/reports/files are
  selectable bullets in the Detail pane; `enter` opens an artifact viewer that
  renders markdown reports, JSON, plain text, and **HTML built-ins**.
- **Playground** (done): `p` opens a CEL console over `data.query`; results
  render by shape (records/list/map/scalar) and record rows open in the viewer.
- **Contextual inspector** (done): JSON artifacts render through a pluggable
  view registry (forecast/bars/table/fields → json), cycled with `v` — the
  moldable, type-specific layer.

The roadmap from `docs/smalltalk-browser-research.md` is now complete through
Phase 5 (the moldable view registry), with reports (proposal G) as the natural
next substrate for user-authored views.
