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
- **JSON** (`application/json`) → pretty-printed, indented.
- **Anything else** → wrapped as plain text.

If the run recorded an artifact whose data has since been **garbage-collected**
(reports keep only a few versions), the viewer says so plainly instead of erroring.

> HTML is rendered to text, not pixels — CSS layout and images are out of scope.

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
viewer (including HTML), and verify a failed run's step is exposed for resume.

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

Deliberately not yet built, in the order the research doc recommends:

- Playground: evaluate a CEL predicate via `data.query` and send the result to a
  new view.
- Contextual data views (type-specific rendering) — the moldable layer.
