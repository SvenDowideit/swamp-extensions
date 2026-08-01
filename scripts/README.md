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
