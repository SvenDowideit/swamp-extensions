# @svendowideit/wikipedia

A caching client for the Wikipedia and Wikidata APIs, built as a swamp model so
any extension or workflow can fetch and re-analyse Wikipedia content without
repeatedly hitting the network.

## What it does

- **Fetches in many formats** — raw **wikitext** (the default), rendered
  **html**, **parsoid** HTML, the REST **summary**, and raw action-API **json**.
- **Searches** — tolerant title search via `opensearch`, returning corrected
  titles, short descriptions and URLs.
- **Extracts infoboxes** — pulls the raw wikitext and parses the page's infobox
  template into `key → value` pairs, optionally restricted to a specific
  template name (`writer`, `book`, `person`, …).
- **Caches everything on disk** — every response is stored under
  `~/.swamp/wikipedia` (configurable), keyed by a hash of the request URL, with
  the **full set of HTTP response headers** (Date, Last-Modified, ETag,
  Cache-Control, Age, Expires, Server, …) recorded next to the body.
- **Always prefers the cache** — a repeated call returns the cached copy and
  makes no external request unless the entry is missing, explicitly bypassed
  (`forceRefresh`), or stale.
- **Paces origin requests** — a tunable minimum delay between requests
  (`requestDelayMs`, default 1000ms) is enforced **across runs** (persisted in
  the cache dir), so bulk use stays within Wikipedia's acceptable rate. 429
  responses are retried with backoff (`retryDelayMs` / `maxRetries`), honouring
  the origin's `Retry-After` header. The wait is reported in the logs.

## How the cache decides freshness

A cached entry is reused unless it's considered stale, decided in this order:

1. **Caller / global `maxAgeMs`** — if set (> 0), an entry older than that is
   stale. `0` means "never expire".
2. **Origin `Cache-Control: max-age`** (adjusted for the origin's `Age` header) —
   respected when present. `no-store` / `no-cache` are treated as "don't reuse".
3. **Origin `Expires`** — respected when present.
4. **No directives** — defaults to never expiring, so the cache is sticky.

`cache-info` reports the age of every entry and the headers that were recorded,
so callers can reason about how fresh the data is.

## Models

### @svendowideit/wikipedia

| Method          | Description |
| --------------- | ----------- |
| `search`        | Search for a term; returns corrected titles, descriptions, URLs. |
| `get-page`      | Fetch a page's content in a chosen format (wikitext default). |
| `get-infobox`   | Fetch wikitext and extract the infobox as key/value pairs. |
| `invalidate`    | Drop one entry, one title, or the whole cache. |
| `cache-info`    | Inspect the cache: size, age, freshness, stored headers. |

## Quick start

```bash
swamp extension pull @svendowideit/wikipedia

# Fetch a page as wikitext (cached):
swamp model @svendowideit/wikipedia method run get-page wiki \
  --input title="Alfred Bester" --input format=wikitext

# Search (cached):
swamp model @svendowideit/wikipedia method run search wiki \
  --input query="Alfred Bester"

# Extract an infobox (cached):
swamp model @svendowideit/wikipedia method run get-infobox wiki \
  --input title="Alfred Bester"

# Tune the request rate (e.g. back off to one request every 3s, and wait up
# to 10s before retrying a 429):
swamp model @svendowideit/wikipedia method run get-page wiki \
  --global-arg requestDelayMs=3000 \
  --global-arg retryDelayMs=10000 \
  --global-arg maxRetries=2 \
  --input title="Alfred Bester" --input format=wikitext
```

### Formats (`get-page`)

| `format`   | Source                         | Notes |
| ---------- | ------------------------------ | ----- |
| `wikitext` | action API `parse`             | **default** — raw markup |
| `html`     | action API `parse`             | rendered HTML of the page |
| `parsoid`  | REST v1 `/page/{title}/html`   | Parsoid HTML |
| `summary`  | REST v1 `/page/summary/{title}` | short summary JSON |
| `json`     | action API `query`             | raw query response |

## Global arguments

| Key               | Default                          | Description |
| ----------------- | -------------------------------- | ----------- |
| `cacheDir`        | `~/.swamp/wikipedia`             | Where responses are cached |
| `apiUrl`          | `https://en.wikipedia.org/w/api.php` | MediaWiki action API base |
| `restUrl`         | `https://en.wikipedia.org/api/rest_v1` | Wikipedia REST v1 base |
| `wikidataUrl`     | `https://www.wikidata.org/w/api.php` | Wikidata action API base |
| `userAgent`       | `swamp-wikipedia/1.0 (local caching client)` | User-Agent header |
| `defaultMaxAgeMs` | `0`                              | Freshness window; `0` = always prefer cache |
| `requestDelayMs`  | `1000`                           | Minimum delay between origin requests (persisted across runs; `0` disables) |
| `retryDelayMs`    | `5000`                           | Wait after a 429 before retrying (origin `Retry-After` wins) |
| `maxRetries`      | `1`                              | Number of retries after a 429 |

## Data

- `page` — fetched page content plus cache metadata (keyed by URL hash).
- `search` — search results (keyed by URL hash).
- `infobox` — extracted infobox key/value pairs.
- `cache` — cache inspection / invalidation results.

## Cache layout

```
~/.swamp/wikipedia/
  <key>/
    meta.json   # URL, status, fetchedAt, headers, size
    body        # raw response body
```

Each `key` is `{method}-{url-slug}-{fnv1a-hash}`, stable across runs so the same
request always maps to the same cache entry.
