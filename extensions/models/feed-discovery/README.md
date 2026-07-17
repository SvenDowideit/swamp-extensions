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

```sh
# Create the model instance
swamp model create @svendowideit/feed-discovery feed-discovery

# Run discovery (reads news-reader snapshot, writes to feed-catalog)
swamp model method run feed-discovery discover

# Dry run (discover but don't add to catalog)
swamp model method run feed-discovery discover --input dryRun=true

# Limit crawling and set a custom category
swamp model method run feed-discovery discover --input maxSitesToCrawl=5 --input category=tech

# View the discovery result
swamp data get feed-discovery discovery-result --json | jq -r '.content' | jq '.discoveredFeeds[] | .url'
```

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
