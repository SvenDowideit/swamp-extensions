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

The result is stored as the `dedupe-result` data resource: group counts, number
of groups with duplicates, how many feeds were marked, and any per-feed fetch
errors.