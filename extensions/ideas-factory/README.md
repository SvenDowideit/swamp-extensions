# @svendowideit/ideas-factory

A swamp model type that captures raw thoughts, classifies them, and turns them
into common ideas with an LLM — **everything stored in swamp model data
resources**.

This implements **Phase 0** (capture → classify) and **Phase 1** (cluster →
merge → refine) of the "idea factory" design in `docs/idea-factory.md`.

## Model type

`@svendowideit/ideas-factory` — one type, methods, all data in resources:

| Method            | Writes to        | Phase |
| ----------------- | ---------------- | ----- |
| `ingestThought`   | `inbox`          | 0     |
| `classifyThought` | `classification` | 0     |
| `routeTodos`      | `todos`          | 0 (deterministic) |
| `clusterThoughts` | `ideas`, `actions`, `questions` | 1 (LLM) |
| `mergeIntoIdea`   | `ideas`, `actions`, `questions` | 1 (LLM) |
| `refineIdea`      | `ideas`, `actions`, `questions` | 1 (LLM) |
| `revertAction`    | `ideas`, `actions` | 1 (manual) |
| `modifyAction`    | `ideas`, `actions` | 1 (manual) |
| `answerQuestion`  | `questions`      | 1 (manual) |
| `dismissQuestion` | `questions`      | 1 (manual) |
| `planIdea`        | `plans`, `actions`, `questions` | 2 (LLM) |
| `planFeedback`    | `inbox`, `classification`, `ideas`, `actions` | 2 (LLM) |
| `setTarget`       | `ideas`          | 3 (manual) |
| `renderBoard`     | `board` (file)   | 0     |

Resources: `inbox`, `classification`, `ideas`, `todos`, `actions`, `questions`,
`plans`.

The **todo branch** is a simple, deterministic path: a thought classified as
`todo` is routed by `routeTodos` into the `todos` resource with the right list
(shopping / household / appointments / errands / work / ideas / custom). The
todo's *lifecycle* (completion, recurrence, reminders) lives outside the factory.

Classification kinds: `new-idea`, `refinement`, `minor-rethink`,
`major-rethink`, `duplicate`, `todo`, `note`, `noise`.

## LLM config

The LLM steps use an OpenAI-compatible `/v1/chat/completions` endpoint (works
with Ollama). Configure via model global args:

```bash
swamp model create @svendowideit/ideas-factory ideas-factory \
  --global-arg llmBaseUrl=http://localhost:11434 \
  --global-arg llmModel=deepseek-v4-flash:cloud
```

Defaults: `llmBaseUrl=http://localhost:11434`, `llmModel=deepseek-v4-flash:cloud`.

## Usage

```bash
# Capture a thought
swamp model method run ideas-factory ingestThought --input 'raw=the caching layer should be write-through'

# Classify + cluster (LLM) + render the board
swamp workflow run @svendowideit/ideas-factory

# Cluster with a steering prompt (prompt injection)
swamp model method run ideas-factory clusterThoughts --input 'userPrompt=merge the two caddy thoughts into one idea'

# Manual controls
swamp model method run ideas-factory mergeIntoIdea --input thoughtId=<id> --input ideaId=<id> --input mode=manual --input body='...'
swamp model method run ideas-factory revertAction --input actionId=<id>
swamp model method run ideas-factory modifyAction --input actionId=<id> --input body='...'
swamp model method run ideas-factory answerQuestion --input questionId=<id> --input answer='...'

# Plan an idea (Phase 2): tasks + acceptance criteria + test strategy + constraints
swamp model method run ideas-factory planIdea --input ideaId=<id>
swamp model method run ideas-factory planIdea --input ideaId=<id> --input 'userPrompt=prefer small, independently-testable tasks'
```

The `ideas-factory` workflow runs `classifyThought → routeTodos →
clusterThoughts → renderBoard`. Merge/refine/plan are on-demand (via the UI or
CLI).

## Web UI

A kanban board is rendered to a static HTML file (`renderBoard`), and a capture
server serves it and exposes the actions:

```bash
~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  scripts/capture-server.ts   # http://127.0.0.1:8877
```

- `GET /` — the board: Thoughts / Ideas / Todos columns, each idea showing its
  actions (what the LLM did + reasoning) with revert/modify controls, a cluster
  prompt bar, and any pending LLM questions with answer forms.
- `POST /api/capture` — `{raw, source?}`.
- `POST /api/cluster` — `{userPrompt?}`.
- `POST /api/revert` — `{actionId}`.
- `POST /api/modify` — `{actionId, body?}`.
- `POST /api/answer` — `{questionId, answer}`.

## Tests

```bash
~/.swamp/deno/deno test idea_factory_test.ts
```

## Next (Phase 3)

Action the plan: `implementPlan` writes docs + tests for each task, `runTests`
verifies them, and `fixFailures` iterates on failures.
