# scripts/

## feedback-server.ts

A Deno HTTP server that acts as a decoupled feedback queue between the
news-reader HTML page and the swamp news workflow.

### Why

The news workflow generates a static HTML page with 👍/👎 buttons on each
article. Without a server, clicking a button could only copy a CLI command to
the clipboard — the user had to manually paste and run it. The feedback server
closes this loop: clicks are sent directly to the server via `fetch`, stored as
files on disk, and picked up by the workflow on its next run.

### How

```
Browser (HTML page)                  Deno server (:8765)              Filesystem
─────────────────────                ────────────────────              ──────────
click 👍 on article ──POST────────→ /api/feedback                     → 01JABC...json
                                     stores as ULID-named JSON file      (queued)

swamp workflow run news
  gather-feedback step ──GET────────→ /api/feedback?limit=20          ← reads oldest 20
                       ←──returns─── [{id, articleId, action, ...}]
                       imports into preferences
                       ──DELETE─────→ /api/feedback?ids=01JABC,...    → deletes files
```

### Endpoints

| Method | Path              | Description                                      |
| ------ | ----------------- | ------------------------------------------------ |
| POST   | `/api/feedback`   | Enqueue a feedback entry                         |
| GET    | `/api/feedback`   | Dequeue oldest N entries (`?limit=N`, default 20) |
| DELETE | `/api/feedback`   | Delete one entry (`?id=ULID`) or batch (`?ids=ULID1,ULID2`) |
| GET    | `/`               | Serve the HTML page (if `--html` flag provided)  |

### POST body

```json
{
  "articleId": "abc123",
  "action": "interested",
  "source": "hnrss.org",
  "title": "AI breakthrough in quantum computing",
  "keywords": ["ai", "quantum", "computing"]
}
```

### GET response

```json
{
  "items": [
    {
      "id": "01JABC...",
      "createdAt": "2026-08-01T06:00:00.000Z",
      "articleId": "abc123",
      "action": "interested",
      "source": "hnrss.org",
      "title": "AI breakthrough in quantum computing",
      "keywords": ["ai", "quantum", "computing"]
    }
  ],
  "remaining": 1
}
```

### Storage

Each feedback entry is stored as a single JSON file in the queue directory
(default: `~/.swamp/feedback-queue/`). Files are named `{ulid}.json` where
ULID is a time-sortable unique identifier — lexicographic sort equals
chronological order, so `Deno.readDir` naturally returns oldest-first.

### Idempotency

The `gatherFeedback` method in news-reader deduplicates by `articleId` within
each preference list (interested/ignored). Re-processing the same entry is a
no-op. The ULID ensures each queue file is unique, so even if a DELETE fails
after import, the next run will safely re-process the same entry.

### Usage

```sh
# Start the server (serves HTML page at / and feedback API at /api/feedback)
# If `deno` is not on your PATH, swamp installs it at ~/.swamp/deno/deno
deno run --allow-net --allow-read --allow-write scripts/feedback-server.ts --html news.html

# Custom port and queue directory
deno run --allow-net --allow-read --allow-write scripts/feedback-server.ts \
  --port 9999 --html news.html --queue-dir /tmp/my-feedback-queue

# Or via environment variables
FEEDBACK_PORT=9999 FEEDBACK_HTML_PATH=news.html FEEDBACK_QUEUE_DIR=/tmp/queue \
  deno run --allow-net --allow-read --allow-write scripts/feedback-server.ts
```

### Permissions

| Flag            | Why                                      |
| --------------- | ---------------------------------------- |
| `--allow-net`   | HTTP server on the configured port       |
| `--allow-read`  | Read HTML file and queue JSON files      |
| `--allow-write` | Create queue directory and write/delete JSON files |
| `--allow-env`   | Read `FEEDBACK_*` environment variables  |

---

## Pages-to-parse queue

The same server also hosts a second queue for *pages to parse* — URLs the user
(or a browser extension / bookmarklet) wants the news workflow to crawl for
feed discovery, in addition to the feed URLs already in the catalog. It behaves
exactly like the feedback queue, but the workflow imports each queued page as a
new catalog entry via `feed-catalog.add` instead of updating preferences.

### Endpoints

| Method | Path              | Description                                      |
| ------ | ----------------- | ------------------------------------------------ |
| POST   | `/api/pages`      | Enqueue a page URL to parse for feed discovery   |
| GET    | `/api/pages`      | List queued pages, oldest first (`?limit=N`, default 20, max 100) |
| DELETE | `/api/pages`      | Delete one (`?id=ULID`) or batch (`?ids=ULID1,ULID2`) |

### POST body

```json
{
  "url": "https://example.com/article/123"
}
```

`pageUrl` is accepted as an alias for `url`. Returns `{ "id": "01JABC...", "status": "queued" }`.

### GET response

```json
{
  "items": [
    { "id": "01JABC...", "url": "https://example.com/article/123", "createdAt": "2026-08-05T06:00:00.000Z" }
  ],
  "remaining": 1,
  "queued": 1
}
```

### Storage

Same file-per-entry layout as feedback, in the pages directory (default:
`~/.swamp/pages-queue/`).

### Workflow integration

The `news` workflow (`workflows/workflow-f04794eb-33d9-443f-a582-3f12699c54e1.yaml`)
adds two steps (plus the `dedupe` step — see the feed-catalog README — which
runs before `fetch` to flag duplicate catalog feeds so they're skipped):

- `gather-pages` — calls the news-reader `gatherPages` method, which polls
  `GET /api/pages?limit=N`, collects `{ url, name, category }` entries into the
  `pagesQueue` resource, and DELETEs the processed pages.
- `upsert-page` — `forEach` over `data.latest("news-reader","pages-queue").?attributes.?pages.orValue([])`,
  calling `feed-catalog.add` with `url`/`category`/`name` — the same inputs as
  the `feed-catalog add` CLI command.

New inputs: `pagesServerUrl`, `pagesBatchSize`, `pagesMaxBatches`,
`pagesCategory` (all default to the feedback equivalents).

### Pages-dir flag

Same mechanism as `--queue-dir` / `FEEDBACK_QUEUE_DIR`, but for pages:

| Flag / env              | Default                  |
| ----------------------- | ------------------------ |
| `--pages-dir`           | `~/.swamp/pages-queue/`  |
| `FEEDBACK_PAGES_DIR`    | (same default)           |
