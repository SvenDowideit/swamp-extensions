# @svendowideit/feed-analysis

A swamp model extension that analyzes pages gathered by the news-reader's
`gather-pages` step, discovers RSS/Atom feeds in each page, and writes a
`page-discovery-result` resource for the news workflow's `upsert-page` step.

## How it works

1. Reads the news-reader's `pages-current` data resource
   (`{ pages: [{ url, name, category }], gatheredAt }`)
2. Fetches each page and detects feeds via:
   - `<link rel="alternate" type="application/rss+xml">` / Atom tags
   - `<a href>` anchors linking to feed paths
   - Direct feed responses (the page itself is a feed)
   - Probing common feed paths (`/rss`, `/feed`, `/atom.xml`, ...) on the site
     root when a page advertises no feed link
3. **Deduplicates** discovered feeds by URL across all pages
4. Writes a `page-discovery-result` resource listing all discovered feeds

## Installation

```sh
swamp extension pull @svendowideit/feed-analysis
```

## Usage

Feed analysis runs automatically in the **`news` workflow** as the
`analyze-pages` step between `gather-pages` and `upsert-page`. The
`upsert-page` step then iterates the discovered feeds and adds them to the
feed-catalog for the next run.

## Global arguments

| Argument           | Description                                                    |
| ------------------ | ------------------------------------------------------------- |
| `newsReaderModelId` | Model ID of the news-reader instance whose `pages-current` to read |

## Method arguments (`analyzePages`)

| Argument           | Default | Description                                    |
| ------------------ | ------- | ---------------------------------------------- |
| `maxPagesPerRun`   | `50`    | Maximum pages to analyze per run               |
| `probeCommonPaths` | `true`  | Probe common feed paths when no link is found  |
