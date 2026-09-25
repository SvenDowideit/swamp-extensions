# @svendowideit/web-cache

A managed, disk-backed HTTP GET cache. It is the single place where responses
are fetched, cached, paced, and retried — so other models can read the cache
instead of re-implementing (and re-hitting) the network.

## What it does

- **Fetches and caches** — `get` returns the raw UTF-8 body; `get-json` returns
  it parsed as JSON; `get-many` fetches many URLs in one call (fan-out). Every
  response is stored under `~/.swamp/web-cache` (configurable), keyed
  deterministically by URL, with the **full set of HTTP response headers**
  (Date, Last-Modified, ETag, Cache-Control, Age, Expires, Server, …) recorded
  next to the body.
- **Always prefers the cache** — a repeated call returns the cached copy and
  makes no network request unless the entry is missing, explicitly bypassed
  (`forceRefresh`), or stale (`maxAgeMs`).
- **Paces origin requests** — a tunable minimum delay between requests
  (`requestDelayMs`, default 1000ms) is enforced **across runs** (persisted in
  the cache dir). 429 responses are retried with backoff (`retryDelayMs` /
  `maxRetries`), honouring the origin's `Retry-After` header.
- **Caps origin fetches per call** — `maxFetches` (or global
  `maxFetchesPerCall`) limits how many *new* network requests a single
  `get-many`/`get` call makes. Cached hits don't count against the cap **and are
  still served once it is reached**, so a large list that is mostly cached drains
  across runs instead of stalling.
- **Is inspectable** — `cache-info` reports size, age, freshness, and the stored
  headers; `invalidate` drops one entry, one URL, or everything.

Side effects: it reads and writes a local cache directory (`cacheDir`) and
writes swamp resources. It makes outbound HTTP GETs only when an entry is
missing, bypassed, or stale. Nothing is installed on the host.

## Install

```sh
swamp extension pull @svendowideit/web-cache
```

No dependencies — it uses Deno's built-in fetch and the bundled deno binary
that swamp already ships.

## Sharing the cache

The cache key depends **only on the URL** (`<url-slug>-<fnv1a-hash>`), so any
model that knows a URL can locate the entry. `@svendowideit/wikipedia` uses the
same `cacheDir` and key scheme, and only *reads* entries this model has written.

The intended seam is a workflow:

```yaml
steps:
  - name: fetch
    task: { type: model_method, modelType: "@svendowideit/web-cache", modelName: cache, methodName: get, inputs: { url: ... } }
  - name: parse
    task: { type: model_method, modelType: "@svendowideit/wikipedia", modelName: wiki, methodName: get-page, inputs: { title: ... } }
```

## Details

`@svendowideit/web-cache` ships one model type (`@svendowideit/web-cache`) and
one workflow (`web-cache-fetch`). Its methods:

| Method        | Description |
| ------------- | ----------- |
| `get`         | Fetch a URL and return the raw body (cached). |
| `get-json`    | Fetch a URL and return the parsed JSON body (cached). |
| `get-many`    | Fetch many URLs in one call (fan-out; deduped by URL; origin fetches capped). |
| `invalidate`  | Drop one entry, one URL, or the whole cache. |
| `cache-info`  | Inspect the cache: size, age, freshness, stored headers. |

## Examples

```bash
# Fetch + cache a URL (raw body):
swamp model @svendowideit/web-cache method run get cache \
  --input url="https://en.wikipedia.org/w/api.php?action=opensearch&search=Alfred+Bester&limit=5&format=json"

# Fetch + cache as JSON:
swamp model @svendowideit/web-cache method run get-json cache \
  --input url="https://en.wikipedia.org/w/api.php?action=opensearch&search=Alfred+Bester&limit=5&format=json"

# Fetch many URLs in one call, capping origin fetches at 20 (cached hits free):
swamp model @svendowideit/web-cache method run get-many cache \
  --input 'urls:json=["https://en.wikipedia.org/w/api.php?action=opensearch&search=Alfred+Bester&limit=5&format=json","https://en.wikipedia.org/w/api.php?action=opensearch&search=Isaac+Asimov&limit=5&format=json"]' \
  --input maxFetches=20

# Tune the request rate: back off to one request every 3s, wait up to 10s
# before retrying a 429, and allow up to 2 retries:
swamp model @svendowideit/web-cache method run get cache \
  --global-arg requestDelayMs=3000 \
  --global-arg retryDelayMs=10000 \
  --global-arg maxRetries=2 \
  --input url="https://en.wikipedia.org/w/api.php?action=opensearch&search=Alfred+Bester&limit=5&format=json"

# Inspect the cache: size, age, freshness and stored headers.
swamp model @svendowideit/web-cache method run cache-info cache
```

## Configuration

The global arguments (all optional):


| Key               | Default                | Description |
| ----------------- | ---------------------- | ----------- |
| `cacheDir`        | `~/.swamp/web-cache`   | Where responses are cached |
| `userAgent`       | `swamp-web-cache/1.0 (local caching client)` | User-Agent header |
| `defaultMaxAgeMs` | `0`                    | Freshness window; `0` = always prefer cache |
| `requestDelayMs`  | `1000`                 | Minimum delay between origin requests (persisted across runs; `0` disables) |
| `retryDelayMs`    | `5000`                 | Wait after a 429 before retrying (origin `Retry-After` wins) |
| `maxRetries`      | `1`                    | Number of retries after a 429 |
| `maxFetchesPerCall` | `100`                | Cap on origin fetches per `get`/`get-many` call (cached hits don't count) |
| `acceptHeader`    | `application/json`     | Accept header sent with requests |

## Data

- `fetch` — result of a `get` / `get-many` (body, headers, cache state), keyed by URL hash.
- `json` — result of a `get-json` (parsed JSON, cache state), keyed by URL hash.
- `batch` — `get-many` summary (fetched/cached/skipped/remaining counts, `maxFetches`, and a `truncated` flag when the cap left URLs for a later run), keyed `get-many`.
- `cache` — cache inspection / invalidation results.

## Cache layout

```
~/.swamp/web-cache/
  <url-slug>-<fnv1a>/
    meta.json   # url, status, fetchedAt, headers, size
    body        # raw response body
  .last-request # pacing state (epoch ms)
```

## Testing

```bash
~/.swamp/deno/deno test --allow-read --allow-write \
  extensions/models/web-cache/web_cache_test.ts
```

Coverage includes the pure key helpers (`fnv1a`, `normalizeUrl`,
`webCacheKey`) plus every method execute path against a fake `fetch` and a
temp cache dir: cache hits / `forceRefresh` / staleness, non-2xx responses,
the 429 retry loop (success and give-up), network-error fallback to cache,
pacing via the persisted `.last-request`, `get-many` fan-out / dedupe /
`maxFetches` cap, and `invalidate` / `cache-info` (single entry and summary).
