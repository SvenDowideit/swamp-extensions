# @svendowideit/idea-factory

A swamp model type that captures raw thoughts, classifies them, and routes them
into common ideas or todos — **everything stored in swamp model data resources**.

This is **Phase 0** of the "idea factory" design in `docs/idea-factory.md`: the
first working loop (capture → classify → route), with a deterministic keyword
classifier and a kanban board renderer.

## Model type

`@svendowideit/idea-factory` — one type, many methods, all data in resources:

| Method            | Writes to        | Deterministic |
| ----------------- | ---------------- | ------------- |
| `ingestThought`   | `inbox`          | yes           |
| `classifyThought` | `classification` | yes (keyword) |
| `routeThought`    | `ideas`, `todos` | yes           |
| `renderBoard`     | `board` (file)   | yes           |

Resources: `inbox`, `classification`, `ideas`, `todos` (+ `board` file).

Classification kinds: `new-idea`, `refinement`, `minor-rethink`,
`major-rethink`, `duplicate`, `todo`, `note`, `noise`.

## Usage

```bash
# Capture a thought
swamp model method run idea-factory ingestThought --input 'raw=build a caching layer'

# Classify + route + render the board
swamp workflow run idea-factory

# View data
swamp data get idea-factory ideas --json | jq .content.ideas
```

The `idea-factory` workflow chains `classifyThought → routeThought → renderBoard`
with idempotent guards (a `routed` flag prevents re-routing).

## Web UI

A simple kanban board is rendered to a static HTML file (`renderBoard`), and a
tiny capture server lets you add thoughts from a browser:

```bash
~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  scripts/capture-server.ts   # http://127.0.0.1:8877
```

- `GET /` — the kanban board (Thoughts / Ideas / Todos columns).
- `POST /api/capture` — `{ "raw": "…", "source": "…" }`, ingests and re-processes.

## Tests

```bash
~/.swamp/deno/deno test idea_factory_test.ts
```

## Next (Phase 1)

LLM-assisted classification behind `allowFailure`, clustering thoughts into
common ideas (`clusterThoughts`), and refinement/iteration (`refineIdea`).
