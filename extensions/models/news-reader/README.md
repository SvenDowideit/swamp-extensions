# @svendowideit/news-reader

A swamp model extension that fetches RSS/Atom feeds, learns your preferences,
and generates a static HTML news summary page ranked by predicted interest.

## How it works

1. **Gather feedback** — polls the feedback queue HTTP server for any pending
   👍/👎 clicks from the HTML page, imports them into preferences, and deletes
   processed entries from the queue.
2. **Dedupe** — the feed-catalog `dedupe` method fetches each catalog feed and
   flags feeds that duplicate another (marked `duplicate: true`). URLs that
   resolve to an **HTML page or unknown content type** instead of a feed are
   marked `invalid: true`, so they are skipped on future runs.
3. **Fetch** — downloads RSS/Atom feeds (skipping any marked `duplicate: true`
   or `invalid: true`), parses articles (title, URL, summary, keywords), and
   stores them as a versioned data resource. If a catalog URL turns out to be an
   **HTML page instead of a feed** (e.g. a page URL pasted into the catalog
   rather than a real RSS/Atom URL), the fetch step detects it and records it in
   the snapshot's `nonFeedUrls` list instead of silently producing "0 articles".
   Feeds already marked invalid by the `dedupe` step are skipped and never
   re-fetched.
4. **Filter by age** — filters fetched articles to show only those within the
   specified time range (default: last 3 days). Supports h/d/w/m suffixes
   (e.g., "2h", "7d", "4w", "1m").
5. **Generate** — reads the filtered articles, scores them against your learned
   keyword preferences, and writes a static HTML page with the top articles
   sorted by interest score.
6. **Feedback** — you mark articles as "interested" or "ignored" (via the HTML
   page's 👍/👎 buttons or the CLI). The model recomputes keyword weights from
   your feedback, so future reports surface more of what you like.

The preference learning is keyword-based: each article's title/summary keywords
are extracted, and your feedback adjusts per-keyword weights (+1 for interested,
-1 for ignored). New articles are scored by summing the weights of their
matching keywords.

## Feedback architecture

Feedback flows through a decoupled queue to avoid requiring a running server
during workflow execution:

```
┌──────────────┐   POST /api/feedback    ┌──────────────────┐
│  HTML Page   │ ──────────────────────→ │  Deno HTTP Server │
│  (browser)   │ ←────────────────────── │  :8765            │
└──────────────┘   JSON responses        │  feedback-queue/  │
                                          │    01J...json     │
                                          │    01J...json     │
                                          └──────────────────┘
                                                   ↑ GET/DELETE
┌───────────────────────────────────────────────────┘
│  swamp workflow run news
│    step: gather-feedback  ← polls API, imports, deletes
│    step: dedupe           ← feed-catalog flags duplicate feeds
│    step: fetch            ← skips feeds marked duplicate
│    step: filter
│    step: generate
│    ...
```

- **HTML page** — clicking 👍/👎 sends a `fetch` POST to the feedback server
  with the article's ID, source, title, and keywords. No clipboard copy-paste
  needed.
- **Feedback server** (`scripts/feedback-server.ts`) — a small Deno HTTP server
  that stores each feedback entry as a ULID-named JSON file in a queue
  directory. ULIDs are time-sortable, so `GET /api/feedback?limit=N` returns
  the oldest entries first. `DELETE /api/feedback?ids=...` removes processed
  entries.
- **gatherFeedback method** — the workflow's first step polls the server,
  imports entries into the `preferences` resource (same logic as the
  `feedback` method), and deletes them from the queue. The server is optional
  — if unreachable, the step is skipped (`allowFailure: true`) and the
  workflow proceeds with existing preferences.

This design is idempotent: each feedback entry has a unique ULID, so
re-processing the same entry is a no-op (the `feedback` method deduplicates by
`articleId` within each list).

## Installation

```sh
swamp extension pull @svendowideit/news-reader
```

## Usage

The news workflow reads feeds from the **`@svendowideit/feed-catalog`** model's
stored data by default — add feeds to the catalog once, and every news run picks
them up automatically:

```sh
# One-time setup: create feed-catalog and add feeds
swamp model create @svendowideit/feed-catalog feed-catalog
swamp model method run feed-catalog add --input url="https://hnrss.org/frontpage" --input category=tech --input name="Hacker News"
swamp model method run feed-catalog add --input url="https://feeds.bbci.co.uk/news/technology/rss.xml" --input category=tech --input name="BBC Tech"

# Start the feedback server (in a separate terminal)
# If `deno` is not on your PATH, swamp installs it at ~/.swamp/deno/deno
deno run --allow-net --allow-read --allow-write scripts/feedback-server.ts --html news.html

# Run the news workflow — reads feeds from catalog automatically, shows last 3 days by default
swamp workflow run news

# Show last 2 days of news:
swamp workflow run news --input newsAge=2d

# Show last week of news:
swamp workflow run news --input newsAge=1w

# View the HTML (served by the feedback server at http://localhost:8765)
open http://localhost:8765
```

You can also pass feeds directly to override the catalog:

```sh
swamp workflow run news --input 'feeds:json=["https://feeds.bbci.co.uk/news/science/rss.xml"]'
```

The workflow is also **scheduled** — it runs automatically every 4 hours via
`swamp serve` (see the `trigger.schedule` in the workflow YAML).

### Recording feedback

Click 👍 or 👎 on any article in the HTML page. The feedback is sent to the
queue server and picked up on the next workflow run. No clipboard copy-paste
needed.

### Pages-to-parse queue

Alongside feedback, the same queue server (`scripts/feedback-server.ts`) hosts
a **pages queue** (`POST/GET/DELETE /api/pages`). The news workflow's
`gather-pages` step polls it, and `upsert-page` adds each queued page to the
feed-catalog via `feed-catalog.add` (same inputs as the CLI command) — so a
page URL queued in the browser gets crawled and its feeds catalogued on the
next run. See `scripts/README.md`.

You can also record feedback directly via the CLI:

```sh
# Mark an article as interesting
swamp model method run news-reader feedback --input articleId=abc123 --input action=interested \
  --input source=hnrss.org --input title="AI breakthrough in quantum computing"

# Mark an article as ignored
swamp model method run news-reader feedback --input articleId=def456 --input action=ignored \
  --input source=bbc.co.uk --input title="Boring sports result"
```

## Methods

| Method           | Description                                              | Key arguments                                        |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `gatherFeedback` | Poll feedback queue server, import entries, delete them  | `serverUrl`, `batchSize`, `maxBatches`               |
| `gatherPages`    | Poll pages queue server, collect pages into `pagesQueue` resource, delete them | `serverUrl`, `batchSize`, `maxBatches`, `category` |
| `fetch`          | Fetch RSS/Atom feeds (skipping duplicates), detect non-feed HTML pages, store articles + `nonFeedUrls` | `feeds` (URL[]), `maxArticlesPerFeed`            |
| `filterByAge`    | Filter articles by age for HTML generation               | `newsAge` (default: "3d", supports h/d/w/m suffixes) |
| `generate`       | Generate HTML report from filtered articles              | `topN`, `title`                                      |
| `feedback`       | Record user interest/ignore for an article               | `articleId`, `action`, `source`, `title`, `keywords` |

## Output

The `generate` method writes a static HTML file as a swamp data artifact
(`report` file spec). The HTML includes:

- **Interest profile** — top keywords with their weights (green = interesting,
  red = ignored)
- **Article cards** — title (links to original), source, date, summary,
  keywords, interest score badge (★/↑/↓/·), and feedback buttons
- **Keyboard shortcuts** — `j`/`k` to navigate between articles
- **Age filter info** — shows the time range of news being displayed

The `fetch` method stores articles as a structured JSON resource (`snapshot`
spec) with all parsed metadata. Feed objects marked `duplicate: true` or
`invalid: true` (by the `dedupe` step) are skipped, so each distinct feed is
fetched only once and non-feed URLs are never re-fetched. The snapshot also
carries `nonFeedUrls` — catalog URLs that resolved to HTML pages (or unknown
content types) instead of feeds — so the feed-discovery step can re-crawl their
domains and find the real feed. The `filterByAge` method creates a filtered
snapshot that includes the age filter information.

## Scheduled execution

The workflow YAML includes `trigger.schedule: "0 */4 * * *"` — every 4 hours.
When running `swamp serve`, the workflow fires automatically. Default feeds for
scheduled runs are set in `trigger.inputs.feeds`.

## Cross-platform

Uses only Deno runtime APIs (`fetch`, `crypto.subtle`, `TextDecoder`) — no
external CLI tools. The RSS parser is a lightweight regex-based implementation
that handles both RSS 2.0 and Atom feeds, including CDATA sections.

## License

MIT — see LICENSE.txt for details.
