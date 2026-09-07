# @svendowideit/ideas-factory

A swamp model type that captures raw thoughts, classifies them, and keeps them
visible on a kanban board — **everything stored in swamp model data resources**.

This is **Phase 0** of the "idea factory" design in `docs/idea-factory.md`:
**capture → classify → see the thought in the Thoughts column.**

Phase 0 does **not** create ideas or todos. Turning a classified thought into a
"common idea" requires the processing step (clustering thoughts by commonality),
which does not exist until Phase 1. So a thought stays a thought.

## Model type

`@svendowideit/ideas-factory` — one type, methods, all data in resources:

| Method            | Writes to        | Phase |
| ----------------- | ---------------- | ----- |
| `ingestThought`   | `inbox`          | 0     |
| `classifyThought` | `classification` | 0     |
| `renderBoard`     | `board` (file)   | 0     |
| `routeThought`    | `ideas`, `todos` | 1 (dormant) |

Resources: `inbox` (thoughts), `classification` (kinds). `ideas`/`todos` exist
as empty scaffolding for Phase 1.

Classification kinds: `new-idea`, `refinement`, `minor-rethink`,
`major-rethink`, `duplicate`, `todo`, `note`, `noise`.

## Usage

```bash
# Capture a thought
swamp model method run ideas-factory ingestThought --input 'raw=the caching layer should be write-through'

# Classify (thought stays in the Thoughts column) + render the board
swamp workflow run @svendowideit/ideas-factory

# View the classified thoughts
swamp data get ideas-factory classification --json
```

The `ideas-factory` workflow runs `classifyThought → renderBoard`. There is no
routing step in Phase 0.

## Web UI

A simple kanban board is rendered to a static HTML file (`renderBoard`), and a
tiny capture server lets you add thoughts from a browser:

```bash
~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  scripts/capture-server.ts   # http://127.0.0.1:8877
```

- `GET /` — the kanban board (Thoughts / Ideas / Todos columns). In Phase 0 only
  the Thoughts column is populated; Ideas and Todos are empty by design.
- `POST /api/capture` — `{ "raw": "…", "source": "…" }`; a browser form POST
  redirects back to the freshly-rendered board (303).

## Tests

```bash
~/.swamp/deno/deno test idea_factory_test.ts
```

## Next (Phase 1)

Add the processing step that Phase 0 deliberately omits: clustering thoughts
into common ideas (`clusterThoughts`) and refinement (`refineIdea`), so related
thoughts are merged and routed into the Ideas column — only then does routing
make sense.
