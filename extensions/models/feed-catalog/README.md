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
swamp data get feed-catalog current --json | jq '.content'
```
