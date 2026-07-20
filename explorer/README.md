# Swamp Explorer

A web UI for navigating and operating a swamp repository. Visualizes the
relationships between workflows, models, extensions (types), and stored data,
and lets you trigger workflows and individual model methods with dynamically
generated input forms.

Built for the current setup at `/home/sven/src/swamp-project` — the server
auto-detects the swamp repo by walking up from the server directory looking for
`.swamp.yaml` (override with `SWAMP_REPO_DIR`).

## Stack

- **Backend**: Node + Express + TypeScript. Shells out to the `swamp` CLI with
  `--json` for every read/trigger operation. No direct DB access — the CLI is
  the only source of truth.
- **Frontend**: Vite + React + [`@xyflow/react`](https://reactflow.dev/) for
  the graph canvas.

## Layout

```
explorer/
  server/index.ts        # Express API + static SPA serving
  web/                   # Vite root
    src/
      App.tsx            # xyflow graph + selection + detail panel
      api.ts             # typed fetch client
      SchemaForm.tsx     # dynamic input form from JSON-schema method args
      TriggerDialog.tsx  # run workflow / method modal
      JsonViewer.tsx     # collapsible JSON viewer for data content
  vite.config.ts
  package.json
```

## Run

```bash
# Dev mode — runs server (5174) + vite dev (5173, proxies /api to 5174).
# Listens on localhost only by default.
npm run dev
# → open http://localhost:5173

# Dev mode exposed on all interfaces (for remote/headless hosts):
npm run dev:remote
# → open http://<host-ip>:5173
#   or set HOST explicitly: HOST=0.0.0.0 npm run dev

# Production — builds server + web, serves everything from 5174
npm run build
npm start
# → open http://localhost:5174
#   or HOST=0.0.0.0 npm start   (listens on all interfaces)
```

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `HOST` | `localhost` (vite) / `0.0.0.0` (server) | Listen address. Set `HOST=0.0.0.0` to expose on the network. |
| `PORT` | `5174` | Backend server port. |
| `BACKEND_PORT` | `5174` | Used by the vite dev proxy when `PORT` is overridden. |
| `SWAMP_REPO_DIR` | auto-detected (walks up for `.swamp.yaml`) | Swamp repository to operate on. |

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Repo dir + liveness |
| GET | `/api/models` | `swamp model list` |
| GET | `/api/models/:name` | `swamp model get <name>` |
| GET | `/api/types/:type` | `swamp model type describe <type>` (URL-encode `@collective/name`) |
| GET | `/api/workflows` | `swamp workflow list` |
| GET | `/api/workflows/:name` | `swamp workflow get <name>` |
| GET | `/api/data/:model` | `swamp data list <model>` |
| GET | `/api/data/:model/:name?version=N` | `swamp data get <model> <name> [--version N]` |
| GET | `/api/workflow-data/:name` | `swamp data list --workflow <name>` |
| GET | `/api/runs` | `swamp run history` |
| POST | `/api/runs/workflow/:name` | body `{ inputs: {...} }` → `swamp workflow run <name> --input k=v ...` |
| POST | `/api/runs/method/:model/:method` | body `{ inputs: {...} }` → `swamp model method run <model> <method> --input k=v ...` |

Complex input values (arrays/objects) are encoded with the CLI's `key=json=<json>`
syntax; scalars are passed as `key=value`.

## Graph semantics

- **Workflow nodes** (left, purple) → **Model nodes** (middle, blue): one edge
  per workflow step whose task targets that model (`modelName`).
- **Model nodes** → **Type nodes** (right, orange dashed): one edge per model
  to its `@collective/type`.
- **Model nodes** → **Data nodes** (rightmost, green): one edge per resource
  or file data item currently stored for that model (`produces-edge`).

Clicking a node selects it and populates the right-hand detail panel:
- **Model**: lists methods with per-method "Run" buttons.
- **Type**: lists data output specs and methods.
- **Workflow**: shows jobs/steps with a "Run workflow" button.
- **Data**: shows metadata and a collapsible JSON view of the content
  (fetched on demand).

## Triggering

Clicking a method chip on a model node, or a "Run" button in the detail panel,
opens a modal with a `SchemaForm` built from the method's `arguments` JSON
schema. Required fields are marked, defaults are auto-filled, arrays/objects
get JSON textareas, enums get selects, URIs get url inputs. Submitting posts to
`/api/runs/method/...` and surfaces success/failure via a toast.

Workflows currently use an empty input schema (the workflow detail's declared
inputs aren't exposed as a JSON schema by the CLI); pass workflow inputs by
extending `triggerWorkflow` in `App.tsx` if needed.