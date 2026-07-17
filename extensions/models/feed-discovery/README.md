# @svendowideit/feed-discovery

A swamp model extension that discovers new RSS/Atom feeds by crawling domains
found in the news-reader's article URLs and upserting them into the
feed-catalog.

## How it works

1. Reads the **news-reader's** latest snapshot to get all article URLs
2. Extracts unique **domains** from those article URLs
3. Checks the **feed-catalog** to find which domains are already known
4. Crawls each new domain's root page (up to `maxSitesToCrawl`)
5. Parses the HTML for `<link rel="alternate" type="application/rss+xml">` and
   `<link rel="alternate" type="application/atom+xml">` tags, plus `<a>` tags
   linking to common feed paths (`/rss`, `/feed`, `.rss`, `/atom`)
6. **Upserts** discovered feeds into the feed-catalog under the `discovered`
   category (or a custom category via `--input category=...`)
7. Writes a discovery result with stats and all discovered feeds

This creates a **feedback loop**: news-reader fetches articles → feed-discovery
finds new feeds from those articles' domains → feed-catalog grows → news-reader
fetches from more sources next time.

## Installation

```sh
swamp extension pull @svendowideit/feed-discovery
```

## Usage

Feed discovery runs automatically as the last step of the **`news` workflow** —
every time the news workflow fetches articles and generates the HTML report, it
also discovers new feeds from the article URLs and upserts them into the
feed-catalog for the next run:

```sh
# Run the full loop: fetch → generate HTML → discover new feeds
swamp workflow run news

# The news workflow's discovery step is on by default — disable it:
swamp workflow run news --input discoverNewFeeds=false

# Or run discovery standalone (reads existing news-reader snapshot):
swamp model method run feed-discovery discover

# Dry run (discover but don't add to catalog)
swamp model method run feed-discovery discover --input dryRun=true

# Limit crawling and set a custom category
swamp model method run feed-discovery discover --input maxSitesToCrawl=5 --input category=tech
```

The discovery model needs to know where the news-reader and feed-catalog data
live — set the `newsReaderModelId` and `feedCatalogModelId` global args when
creating the model instance. The news workflow auto-creates these definitions.

## Method arguments

| Argument          | Type    | Default        | Description                                      |
| ----------------- | ------- | -------------- | ------------------------------------------------ |
| `maxSitesToCrawl` | integer | `10`           | Maximum new domains to crawl for feed discovery  |
| `category`        | string  | `"discovered"` | Category tag for discovered feeds in the catalog |
| `dryRun`          | boolean | `false`        | If true, discover feeds but don't add to catalog |

## Prerequisites

The discovery model needs to read data from two other models:

1. **news-reader** — must have a `feed-snapshot` resource (run the news
   workflow's `fetch` step first to populate it with article URLs)
2. **feed-catalog** — must exist (feeds discovered are upserted into it)

## Feedback loop

```
feed-catalog → news-reader.fetch → news-reader.snapshot → feed-discovery.discover
     ↑                                                           ↓
     └───────────── upsert discovered feeds ←─────────────────────┘
```

Each cycle grows the catalog with new sources, so the news reader fetches from
more feeds, which discovers more feeds, and so on.

## License

MIT — see LICENSE.txt for details.
