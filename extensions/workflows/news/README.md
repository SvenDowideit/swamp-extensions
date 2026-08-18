# @svendowideit/news

The full news stack — feed discovery, catalog management, preference-aware
fetching, LLM story fusion, and static HTML rendering. Ships four model
extensions (`news-feed-discovery`, `news-feed-catalog`, `news-reader`, `news-feed-analysis`),
one report extension (`news_html_report`), the four news workflows (`news`,
`news-fusion`, `news-curation`, `news-full`), and the decoupled feedback server
that closes the 👍/👎 loop between the generated HTML page and the workflows.

## Install (new users)

```sh
swamp extension pull @svendowideit/news
```

Then create the model instances the workflows reference:

```sh
swamp model create @svendowideit/news-reader local-news
swamp model create @svendowideit/news-feed-catalog news-feed-catalog
swamp model create @svendowideit/news-feed-discovery news-feed-discovery
swamp model create @svendowideit/news-feed-analysis news-feed-analysis
```

## Setup

Configure the news-reader instance before the first run (optional — fusion is
disabled until you set an LLM model). The `setup` method lists the current
config and validates any values you pass:

```sh
# List current config params (name, kind, default, current)
swamp model method run local-news setup

# Enable LLM story fusion (Ollama default, or any OpenAI-compatible server)
swamp model method run local-news setup --input llmModel=llama3 --input llmBaseUrl=http://localhost:11434

# Tune fusion behavior
swamp model method run local-news setup --input llmTemperature=0.1 --input fusionMinClusterSize=2

# Persist your choices in the instance's globalArguments
swamp model update @svendowideit/news-reader local-news --global-args '{"llmModel":"llama3","llmBaseUrl":"http://localhost:11434"}'
```

Configurable params: `llmBaseUrl`, `llmModel` (empty = fusion off),
`llmApiKey`, `llmTemperature` (0..2), `fusionMinClusterSize` (int ≥ 1),
`citationRetentionDays` (int ≥ 0), `llmConcurrency` (1..20),
`maxFusions` (int ≥ 1, default 25), `llmTimeoutSec` (1..600s, default 120),
`llmFailureThreshold` (int ≥ 1, default 3).

The last three bound how long a failing LLM server can stall a fusion step:
`maxFusions` caps the total LLM calls per step, `llmTimeoutSec` is the per-call
timeout, and `llmFailureThreshold` is how many *server-side* failures (outage,
no-response, HTTP 5xx) a step tolerates before it stops early — client-side
errors (4xx, bad JSON) are not counted. When a step stops early, whatever
stories were already written are kept as-is and the workflow moves on to the
next step (e.g. `fuse → seed → render`). Set `llmFailureThreshold=1` to fail
fast on the first server error, and `maxFusions=5` for a tighter cap.

## Run the workflows

The stack ships four workflows. Run them with `swamp workflow run <name>`:

```sh
# Fast path — feedback, fetch, dedupe, filter, generate HTML (every 4h)
swamp workflow run @svendowideit/news-fetch

# LLM story fusion — cluster, fuse, seed, render stories (every 12h)
swamp workflow run @svendowideit/news-fusion

# Catalog maintenance — dedupe, feed state, discovery, page analysis (daily 3am)
swamp workflow run @svendowideit/news-curation

# Full loop — discovery → catalog → fetch → filter → fuse → render in one run
swamp workflow run @svendowideit/news-full
```

Optional inputs for the fast path / full loop: `feeds` (array of feed URLs,
overrides the catalog), `action` (`fetch_generate` | `feedback`), `topN`
(article count in the HTML report, 0 = all), `discoverNewFeeds` (bool), plus
feedback fields `articleId`, `feedbackAction`, `source`, `title`.

```sh
swamp workflow run news --input feeds:json='["https://hnrss.org/frontpage"]'
swamp workflow run news --input topN=50
```

## Run on a schedule

Each workflow YAML ships with a built-in `trigger.schedule` (cron) plus
`trigger.inputs` defaults, so no per-user trigger setup is required:

| Workflow                     | Schedule | Trigger inputs            |
|------------------------------|----------|---------------------------|
| `@svendowideit/news-fetch`   | every 4h  | `discoverNewFeeds: false` |
| `@svendowideit/news-fusion`  | every 12h | —                         |
| `@svendowideit/news-curation`| daily 3am | `discoverNewFeeds: true`  |
| `@svendowideit/news-full`    | every 4h  | `discoverNewFeeds: true`  |

Start the scheduler to register all four:

```sh
swamp serve          # runs scheduled triggers; live-reloads trigger changes
```

Notes:

- Schedules use standard 5-field cron (optional 6th = seconds field).
- If `serve` was down at a scheduled time, missed runs are NOT caught up —
  the next natural cron tick fires. Use `swamp serve --no-schedule` to
  disable scheduled runs (e.g. keep serve for the feedback server only).
- If one run is still in flight on a later tick, the later run is skipped
  with a warning (no overlap / queue build-up).

### Overriding the built-in schedule

The built-in trigger lives in the workflow YAML; to change it for your
machine, write a repo-local override (persisted to `serve.yaml`) with:

```sh
swamp workflow trigger set @svendowideit/news-fetch     --schedule "0 */6 * * *"
swamp workflow trigger set @svendowideit/news-fusion    --schedule "0 5,17 * * *"
swamp workflow trigger set @svendowideit/news-curation  --schedule "0 4 * * *"
```

Inspect and remove overrides the same way:

```sh
swamp workflow trigger get   @svendowideit/news-fusion    # built-in + local override
swamp workflow trigger remove @svendowideit/news-fusion   # fall back to the YAML default
```

Override precedence at fire time: `trigger.inputs` from the workflow YAML >
schema defaults. `swamp workflow trigger set` replaces the whole override map
(per workflow), so it's best for adjusting cadence rather than per-run inputs.

## Models

| Type | Purpose |
|---|---|
| `@svendowideit/news-reader` | Fetches RSS/Atom feeds, learns user preferences, generates a static HTML news summary page ranked by predicted interest. |
| `@svendowideit/news-feed-catalog` | Manages the curated list of RSS/Atom feeds. |
| `@svendowideit/news-feed-discovery` | Discovers new RSS/Atom feeds by crawling domains from the news-reader's article URLs and upserting them into the catalog. |
| `@svendowideit/news-feed-analysis` | Analyzes pages gathered by the news-reader, discovers RSS/Atom feeds in each page, and writes a page-discovery-result resource for catalog upsert. |
| `@svendowideit/news-html-report` | Report extension that renders the HTML page from the news-reader's snapshot. |

## Workflows

### `news` (fast path, every 4h)

1. **Gather feedback** — polls the feedback queue server for 👍/👎 clicks from
   the HTML page, imports them into preferences.
2. **Fetch** — downloads RSS/Atom feeds from the catalog, parses articles,
   stores snapshot.
3. **Dedupe articles** — groups articles by URL, marks duplicates, annotates
   primary articles with cross-feed source info.
4. **Filter by age** — keeps only articles within the configured time range
   (default: last 3 days), skipping duplicate-marked articles.
5. **Generate HTML** — scores articles against learned keyword preferences,
   writes a static HTML page with fused stories rendered inline.
6. **Generate feeds HTML** — renders a feeds.html catalog listing with per-feed
   article counts, cross-feed sharing lines, and engagement-based sorting.

### `news-fusion` (LLM, every 12h)

Clusters filtered articles into same-story groups and fuses them into
persistent story objects that survive the age-filter window:

1. **cluster** — `clusterArticles`: deterministically groups filtered articles
   into same-story clusters (no LLM). Guarded: skips if no `filtered-snapshot`
   exists yet.
2. **fuse** — `fuseStories`: absorbs each cluster's articles into an existing
   persistent story, keeping provenance per claim. Skips unchanged clusters
   (Phase 1.2 fingerprint comparison).
3. **seed** — `seedStories`: creates a fresh `Story` object for clusters with no
   existing story (parallel LLM calls, Phase 1.1).
4. **render** — `renderStories`: renders the accumulated stories into an inline
   `storiesHtml` fragment included in `news.html`, and writes a standalone
   `stories.html` page so fused stories are viewable on their own.

### `news-curation` (daily 3am)

Catalog maintenance: dedupes feeds by content identity, gathers feed
enable/disable state from the feedback server, discovers new feeds, and
upserts them into the catalog.

### `news-full` (combined loop)

The combined `@svendowideit/news` workflow — the full discovery → catalog →
fetch → filter → fuse → render loop in one run. This is the entry point most
users run.

## Feedback server

`scripts/feedback-server.ts` is a Deno HTTP server that decouples the HTML page
from the workflow (see `docs/news-fusing.md`):

| Endpoint | Purpose |
|---|---|
| `POST /api/feedback` | Enqueue 👍/👎 clicks from the news page. |
| `GET /api/feedback` | Dequeue oldest feedback entries for the workflow. |
| `DELETE /api/feedback` | Remove processed feedback entries. |
| `POST /api/pages` | Enqueue page URLs for feed discovery. |
| `GET /api/pages` | Dequeue oldest page URLs. |
| `DELETE /api/pages` | Remove processed page URLs. |
| `POST /api/feed` | Enqueue feed enable/disable toggles. |
| `GET /api/feed` | Dequeue feed state changes. |
| `DELETE /api/feed` | Remove processed feed state entries. |
| `GET /` | Serve the generated `news.html`. |
| `GET /feeds.html` | Serve the feeds catalog listing. |
| `GET /stories.html` | Serve the standalone fused-stories page. |

```sh
deno run --allow-net --allow-read --allow-write scripts/feedback-server.ts \
  --html news.html --feeds feeds.html --stories stories.html
```

## Design notes

- `docs/news-fusing.md` — the fusion design & provenance model.
- `docs/PLAN.md`, `docs/LLM-FUSION.md` — implementation plans.

## License

MIT
