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
`github.com/coder/websocket` for the serve transport.

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
    styles.go, util.go        # styling + JSON/size helpers
    view_test.go              # deterministic render tests
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
  steps with dependency arrows, nested `workflow:` steps) and that workflow's
  produced data.
- **Models** — from `model.search`. `enter` loads methods and data-output specs
  plus the model's data.
- **Detail** — the DAG or method list; scrollable.
- **Data** — data produced by the selected workflow (`data.list` with
  `workflowName`) or model. `enter` fetches the item's content with a scoped
  `data.get`.

The Detail and Data panes always describe one **root** (a workflow or a model);
`esc` returns focus to the pane that owns it.

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
go test ./...                                   # unit (render/layout/filter/DAG)
go test -tags integration -run TestEnsureServe ./internal/swamp/  # lifecycle
# drive the real TUI model against a live server:
swamp serve --port 9090 --no-schedule &
SP_SERVER=ws://127.0.0.1:9090 go test -tags integration -run TestLiveWorkflowBrowser ./internal/ui/
```

The lifecycle test proves the hard requirement: a spawned server is reachable
after `EnsureServe`, is gone after `Stop`, and a pre-existing server is adopted
rather than owned. The live test loads the real workflow list, picks one that has
produced data, renders its DAG, and drills into a data item's content.

## Status / next

Prototype. Current surface:

- **Phase 0 — Spotter** (done): global search over models, workflows, and data.
- **System Browser** (done): models → methods + data-output specs → data
  contents (JSON pretty-printed), selection-linked panes.
- **Workflow pane + DAG** (done): workflows → job/step DAG with dependency
  arrows and nested-workflow steps → workflow data.

Deliberately not yet built, in the order the research doc recommends:

- Run browser with live event streaming (`workflow.run` / `run.attach`) and
  resume-at-step.
- Playground: evaluate a CEL predicate via `data.query` and send the result to a
  new view.
- Contextual data views (type-specific rendering) — the moldable layer.
