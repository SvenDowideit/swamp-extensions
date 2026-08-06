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

The result is stored as the `dedupe-result` data resource: group counts, number
of groups with duplicates, how many feeds were marked, and any per-feed fetch
errors.

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
