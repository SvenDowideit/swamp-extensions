# @svendowideit/news-workflow

A swamp workflow extension that orchestrates the full news feedback loop — from
fetching RSS/Atom feeds to generating a personalized HTML news summary.

## What it does

1. **Gather feedback** — polls the feedback queue server for 👍/👎 clicks from
   the HTML page, imports them into preferences.
2. **Dedupe catalog feeds** — flags duplicate feeds in the catalog so they're
   skipped during fetch.
3. **Gather feed state** — applies enable/disable toggles from the feeds page.
4. **Fetch** — downloads RSS/Atom feeds, parses articles, stores snapshot.
5. **Dedupe articles** — groups articles by URL, marks duplicates, annotates
   primary articles with cross-feed source info.
6. **Filter by age** — keeps only articles within the configured time range
   (default: last 3 days), skipping duplicate-marked articles.
7. **Generate HTML** — scores articles against learned keyword preferences,
   writes a static HTML page with cross-feed duplicate indicators.
8. **Generate feeds HTML** — renders a feeds.html catalog listing with per-feed
   article counts, cross-feed sharing lines, and engagement-based sorting.
9. **Discover new feeds** — crawls article domains to find new RSS/Atom feeds.
10. **Upsert discovered feeds** — adds newly discovered feeds to the catalog.
11. **Gather pages** — polls the pages queue for URLs to analyze.
12. **Analyze pages** — discovers feeds from queued page URLs.

## Installation

```sh
swamp extension pull @svendowideit/news-workflow
```

This pulls the workflow YAML and the feedback server scripts. The model
extensions it depends on must be pulled separately:

```sh
swamp extension pull @svendowideit/news-reader
swamp extension pull @svendowideit/feed-catalog
swamp extension pull @svendowideit/feed-discovery
swamp extension pull @svendowideit/feed-analysis
```

Then create the model instances the workflow references:

```sh
swamp model create @svendowideit/news-reader news-reader
swamp model create @svendowideit/feed-catalog feed-catalog
swamp model create @svendowideit/feed-discovery feed-discovery
swamp model create @svendowideit/feed-analysis feed-analysis
```

## Usage

### One-time setup

```sh
# Add feeds to the catalog
swamp model method run feed-catalog add --input url="https://hnrss.org/frontpage" --input category=tech --input name="Hacker News"
swamp model method run feed-catalog add --input url="https://feeds.bbci.co.uk/news/technology/rss.xml" --input category=tech --input name="BBC Tech"

# Start the feedback server (in a separate terminal)
deno run --allow-net --allow-read --allow-write scripts/feedback-server.ts --html news.html --feeds feeds.html
```

### Run the workflow

```sh
# Default: last 3 days, all catalog feeds
swamp workflow run @svendowideit/news

# Custom age range
swamp workflow run @svendowideit/news --input newsAge=1w

# Override feeds
swamp workflow run @svendowideit/news --input 'feeds:json=["https://feeds.bbci.co.uk/news/rss.xml"]'

# View the results
open http://localhost:8765           # news.html
open http://localhost:8765/feeds.html  # feeds listing
```

### Scheduled execution

The workflow includes a `trigger.schedule: "0 */4 * * *"` — every 4 hours.
When running `swamp serve`, the workflow fires automatically.

## Inputs

| Input | Type | Default | Description |
|---|---|---|---|
| `feeds` | `string[]` | `[]` | RSS/Atom feed URLs (overrides catalog if non-empty) |
| `newsAge` | `string` | `3d` | Time range (h/d/w/m) |
| `topN` | `integer` | `0` | Articles in HTML report (0=all) |
| `outputPath` | `string` | `news.html` | Output HTML file path |
| `discoverNewFeeds` | `boolean` | `true` | Whether to discover new feeds |
| `maxSitesToCrawl` | `integer` | `10` | Max domains to crawl for discovery |
| `dryRun` | `boolean` | `false` | Discover but don't add to catalog |
| `category` | `string` | `discovered` | Category for discovered feeds |
| `feedbackServerUrl` | `string` | `http://localhost:8765` | Feedback queue server URL |
| `feedbackBatchSize` | `integer` | `100` | Feedback entries per batch |
| `feedbackMaxBatches` | `integer` | `20` | Max batches per run |
| `pagesServerUrl` | `string` | `http://localhost:8765` | Pages queue server URL |
| `pagesBatchSize` | `integer` | `100` | Pages per batch |
| `pagesMaxBatches` | `integer` | `20` | Max batches per run |
| `pagesCategory` | `string` | `discovered` | Category for queued pages |
| `maxPagesPerRun` | `integer` | `50` | Max pages to analyze per run |
| `probeCommonPaths` | `boolean` | `true` | Probe common feed paths |
## Story fusion (LLM)

The workflow has an optional, LLM-driven fusion pass that turns short-lived
filtered articles into **persistent story objects** that survive the age-filter
window:

1. **cluster** — `clusterArticles`: deterministically groups filtered articles
   into same-story clusters (no LLM, gated by `fusionMinClusterSize`).
2. **fuse** — `fuseStories`: absorbs each cluster's articles into an existing
   persistent story, keeping provenance per claim.
3. **seed** — `seedStories`: creates a fresh `Story` object for clusters with no
   existing story.
4. **render** — `renderStories`: renders the accumulated stories into an inline
   `storiesHtml` fragment included in `news.html`.

`fuse`, `seed`, and `regen` call the LLM and are **disabled by default**: they
no-op (skip the LLM call) when the model instance has no `llmModel` configured.
The `render` step still runs, so previously fused stories remain on the page.

### Enabling fusion (the real switch)

Because the workflow calls existing model instances (not direct type execution),
there is **no workflow input** that gates fusion. The on/off switch is the model
instance `local-news` (`models/@svendowideit/news-reader/e2f17e65-f276-48b2-b381-85f84d8240fa.yaml`)
`globalArguments.llmModel`:

| Arg | Default | Description |
|---|---|---|
| `llmBaseUrl` | `http://localhost:11434` | Base URL of an OpenAI-compatible LLM server (Ollama). The `/v1/chat/completions` path is used. |
| `llmModel` | `""` | Model tag used by the fusion LLM calls. **Empty = fusion disabled**. Set a tag to enable. |
| `llmApiKey` | — | API key for LLM servers that require auth (Ollama usually doesn't). |
| `llmTemperature` | `0.1` | Sampling temperature (low = deterministic extraction). |
| `fusionMinClusterSize` | `2` | Minimum cluster size before LLM fusion triggers. |
| `citationRetentionDays` | `30` | How long article citations live before aging out; core facts always survive. |

With `globalArguments: {}` the defaults apply and `llmModel` is empty, so fusion
is **off** out of the box.

#### Enable against a local Ollama

Edit `models/@svendowideit/news-reader/e2f17e65-f276-48b2-b381-85f84d8240fa.yaml`:

```yaml
globalArguments:
  llmBaseUrl: http://localhost:11434
  llmModel: llama3
```

Then just run the workflow — no special input needed:

```sh
swamp workflow run @svendowideit/news
```

#### Enable a remote/proxied LLM with an API key

```yaml
globalArguments:
  llmBaseUrl: https://api.openai.com/v1
  llmModel: gpt-4o-mini
  llmApiKey: sk-...            # your key
  llmTemperature: 0.1
  fusionMinClusterSize: 2
  citationRetentionDays: 30
```

> Note: guards on workflow `inputs` are evaluated against schema **defaults**, not
> runtime `--input` bindings, so a workflow input cannot gate fusion. Configure
> the model instance's `globalArguments` instead.

## Dependencies

This workflow requires these extensions (pulled automatically):

- `@svendowideit/news-reader` — fetches feeds, learns preferences, generates HTML
- `@svendowideit/feed-catalog` — manages the curated list of RSS/Atom feeds
- `@svendowideit/feed-discovery` — discovers new feeds by crawling article domains
- `@svendowideit/feed-analysis` — analyzes queued pages to discover feeds

## Feedback server

The included `scripts/feedback-server.ts` is a Deno HTTP server that acts as a
decoupled queue between the HTML page and the workflow:

- **`POST /api/feedback`** — enqueue 👍/👎 clicks from the news page
- **`GET /api/feedback`** — dequeue oldest entries for the workflow
- **`DELETE /api/feedback`** — remove processed entries
- **`POST /api/pages`** — enqueue page URLs for feed discovery
- **`GET /api/pages`** — dequeue oldest page URLs
- **`DELETE /api/pages`** — remove processed pages
- **`POST /api/feed`** — enqueue feed enable/disable toggles
- **`GET /api/feed`** — dequeue feed state changes
- **`DELETE /api/feed`** — remove processed feed state entries
- **`GET /`** — serve the generated news.html
- **`GET /feeds.html`** — serve the feeds catalog listing

```sh
deno run --allow-net --allow-read --allow-write scripts/feedback-server.ts \
  --html news.html --feeds feeds.html
```

## License

MIT
