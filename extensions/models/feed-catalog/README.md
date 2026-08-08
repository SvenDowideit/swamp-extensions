# @svendowideit/feed-catalog

Manages a curated list of RSS/Atom feeds for the news reader.

Store your favorite feeds organized by category (tech, news, programming,
podcasting). The news workflow reads this catalog to know which feeds to fetch.

## Installation

```sh
swamp extension pull @svendowideit/feed-catalog
```

## Usage

Add feeds:

```sh
# Add a feed to the tech category
swamp model create @svendowideit/feed-catalog my-feeds --global-arg catalogName=default

# Or use the workflow
swamp workflow run news --input action=addFeed \
  --input url="https://feeds.bbci.co.uk/news/technology/rss.xml" \
  --input category=tech
```

List feeds:

```sh
# All feeds (up to limit)
swamp model method run @svendowideit/feed-catalog list my-feeds

# Filter by category
swamp model method run @svendowideit/feed-catalog list my-feeds --arg category=tech

# Unlimited feeds (limit=0)
swamp model method run @svendowideit/feed-catalog list my-feeds --arg limit=0
```

List categories:

```sh
swamp model method run @svendowideit/feed-catalog listCategories my-feeds
```

## Deduplication

The `dedupe` method keeps the catalog tidy by flagging feeds that duplicate
another feed already in the catalog:

```sh
swamp model method run @svendowideit/feed-catalog dedupe my-feeds
```

It fetches every feed, groups them by content identity (sorted normalized item
IDs, or a `self` link when there are no items), and within each group keeps the
most expressive feed (highest score for title/format/description/author/date/
link/items — ties broken by earliest `addedAt`) as canonical. The rest are
marked `duplicate: true` / `duplicateOf: <canonical>` so the news workflow's
`fetch` step skips them.

Because dedupe fetches every catalog feed (each with an up to 15s timeout), a
large catalog can take minutes. The method logs **periodic progress** — `Dedupe
progress: {done} of {total} feeds` at most once every 10 seconds (or every 10
feeds) — so long runs show how far along they are, and it logs **each decided
duplicate** as `Feed {url} ({name}) marked duplicate of {canonical} ({name})`
so you can see exactly which URLs were flagged.

### Invalid feeds

When a catalog URL turns out to be an **HTML page (or unknown content type)
instead of an RSS/Atom feed**, dedupe marks that entry `invalid: true` with
`invalidReason: "not a feed (HTML page or unknown content type)"`, so the news
workflow's `fetch` step stops re-fetching it on future runs. Entries already
marked invalid by a previous run are skipped entirely (not re-fetched). The
`dedupe-result` data resource reports how many were marked via `markedInvalid`.

The result is stored as the `dedupe-result` data resource: group counts, number
of groups with duplicates, how many were marked duplicate, how many were marked
invalid, and any per-feed fetch errors.

## HTML page

The `generateFeedsHtml` method renders a static HTML page listing all feeds in
the catalog, grouping each feed together with the duplicates that point back to
it:

```sh
# Write to feeds.html in the current directory (default)
swamp model method run @svendowideit/feed-catalog generateFeedsHtml my-feeds

# Custom output path and title
swamp model method run @svendowideit/feed-catalog generateFeedsHtml my-feeds \
  --arg outputPath=docs/feeds.html --arg title="My Feed Index"
```

Each canonical feed is shown with its duplicates indented underneath, flagged
with a `duplicate of …` badge. The page is written both to `outputPath` and as a
`report` file artifact (`feeds-page`), retrievable with
`swamp data get my-feeds feeds-page --version 1`.

### Per-feed article counts

When the news-reader's `prefs` and `snapshot` data are passed in (as the
workflow does), each feed card shows per-feed article engagement counts:

- **👁 seen / 📖 read / 👍 interested / 👎 ignored** — counts from the
  news-reader's preferences, matched by feed hostname
- **↗ deduped N away** — articles from this feed that were marked as duplicates
  of another feed's article
- **← N from others** — articles from this feed that are the primary/canonical
  copy, with duplicates coming from other feeds

### Cross-feed article sharing

Each feed card also shows cross-reference lines (only when non-zero):

- **↔ shares articles with: host1 host2 …** (purple tags, top 5) — feeds that
  share articles with this one
- **↗ deduped to: host1 host2 …** (red tags, top 3) — feeds whose articles were
  kept as primary over this feed's duplicates
- **← deduped from: host1 host2 …** (green tags, top 3) — feeds whose articles
  were marked as duplicates of this feed's

### Engagement-based sorting

Within each category, canonical feeds are sorted by an engagement score so the
feeds you interact with most float to the top and ignored feeds sink to the
bottom:

```
engagementScore = interested × 3 + read × 2 + seen × 1 − ignored × 2
```

Feeds marked `invalid: true` are hidden by default — the meta line reports the
count (e.g. `3 invalid`) and a "Show invalid feeds (N)" button toggles a
separate `Invalid feeds` section that renders each one with an `invalid` badge
and its `invalidReason`. The page includes a small inline script that powers
the toggle; if there are no invalid feeds, no button or section is rendered.

Each non-invalid feed has a **Disable/Enable** button that sends a `POST` to
`/api/feed` on the feedback server. The workflow's `gather-feed-state` step
polls the queue, applies the `enabled` flag to the catalog, and deletes
processed entries. Feeds with `enabled: false` are skipped by the `fetch` step
and shown with a greyed-out `disabled` style on the feeds page.

## Feed state sync

The `gatherFeedState` method polls the feedback server's `/api/feed` endpoint
and applies enabled/disabled state to the catalog:

```sh
swamp model method run @svendowideit/feed-catalog gatherFeedState my-feeds \
  --arg serverUrl=http://localhost:8765
```
