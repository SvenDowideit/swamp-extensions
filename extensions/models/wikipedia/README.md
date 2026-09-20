# @svendowideit/wikipedia

A Wikipedia/Wikidata domain client layered on top of the shared web cache owned
by [`@svendowideit/web-cache`](../web-cache). It **fetches nothing itself** — it
parses responses that `web-cache` has already fetched and cached.

## What it does

- **Parses many formats** — raw **wikitext** (default), rendered **html**,
  **parsoid** HTML, the REST **summary**, and raw action-API **json**.
- **Searches** — parses a cached `opensearch` response into corrected titles,
  short descriptions and URLs.
- **Extracts infoboxes** — pulls cached wikitext and parses the page's infobox
  template into `key → value` pairs, optionally restricted to a specific
  template name (`writer`, `book`, `person`, …).

## How it works with web-cache

Fetching, caching, pacing and retry are `@svendowideit/web-cache`'s
responsibility. This model only *reads* entries from the shared cache directory
(default `~/.swamp/web-cache`), keyed by URL. On a cache miss it returns an empty
result with `cached: false` — it never makes a network request.

The intended seam is a workflow:

```yaml
jobs:
  - name: main
    steps:
      - name: fetch
        task:
          type: model_method
          modelType: "@svendowideit/web-cache"
          modelName: cache
          methodName: get
          inputs:
            url: ${{ inputs.url }}
        dependsOn: []
      - name: parse
        task:
          type: model_method
          modelType: "@svendowideit/wikipedia"
          modelName: wiki
          methodName: get-page
          inputs:
            title: ${{ inputs.title }}
            format: wikitext
        dependsOn:
          - step: fetch
            condition:
              type: always
```

## Models

### @svendowideit/wikipedia

| Method          | Description |
| --------------- | ----------- |
| `search`        | Parse a cached opensearch response into titles, descriptions, URLs. |
| `get-page`      | Parse a cached page in a chosen format (wikitext default). |
| `get-infobox`   | Extract an infobox as key/value pairs from cached wikitext. |

## Quick start

```bash
swamp extension pull @svendowideit/web-cache
swamp extension pull @svendowideit/wikipedia

# 1. Fetch + cache the wikitext (web-cache):
swamp model @svendowideit/web-cache method run get cache \
  --input url="https://en.wikipedia.org/w/api.php?action=parse&page=Alfred+Bester&prop=wikitext&format=json"

# 2. Parse it (wikipedia reads the cache):
swamp model @svendowideit/wikipedia method run get-page wiki \
  --input title="Alfred Bester" --input format=wikitext

# Extract an infobox (from cached wikitext):
swamp model @svendowideit/wikipedia method run get-infobox wiki \
  --input title="Alfred Bester"
```

> **Note:** the URL passed to `web-cache.get` must match the URL `wikipedia`
> derives for the same `(title, format)`. Both use the same `apiUrl`/`restUrl`
> global arguments (defaults: en.wikipedia.org), so the two steps line up.

### Formats (`get-page`)

| `format`   | Source                         | Notes |
| ---------- | ------------------------------ | ----- |
| `wikitext` | action API `parse`             | **default** — raw markup |
| `html`     | action API `parse`             | rendered HTML of the page |
| `parsoid`  | REST v1 `/page/{title}/html`   | Parsoid HTML |
| `summary`  | REST v1 `/page/summary/{title}` | short summary JSON |
| `json`     | action API `query`             | raw query response |

## Global arguments

| Key        | Default                           | Description |
| ---------- | --------------------------------- | ----------- |
| `cacheDir` | `~/.swamp/web-cache`              | Shared cache dir to read from (must match web-cache) |
| `apiUrl`   | `https://en.wikipedia.org/w/api.php` | MediaWiki action API base |
| `restUrl`  | `https://en.wikipedia.org/api/rest_v1` | Wikipedia REST v1 base |

## Data

- `page` — parsed page content (from the shared cache).
- `search` — parsed search results.
- `infobox` — extracted infobox key/value pairs.
- `page-props` — canonical title → url, shortdesc and wikidataId (from `get-page-props`).
- `url` — a built MediaWiki URL (`search-url` / `page-url` / `page-props-url`) for the web-cache fetch seam.

## Testing

```bash
~/.swamp/deno/deno test --allow-read --allow-write \
  extensions/models/wikipedia/wikipedia_test.ts
```

Coverage includes the infobox helpers, the shared cache-key helpers, every URL
builder (all `get-page` format branches + search + page-props), `extractContent`
format handling, `parsePageProps` (including redirects), and every method
execute path against seeded temp cache dirs — `search`, `get-page`,
`get-infobox`, and `get-page-props`, for both cache hits and misses.
