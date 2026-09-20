# @svendowideit/wikidata

A Wikidata domain client layered on top of the shared web cache owned by
[`@svendowideit/web-cache`](../web-cache). It **fetches nothing itself** — it
parses responses that `web-cache` has already fetched and cached.

It is the generalised counterpart to [`@svendowideit/wikipedia`](../wikipedia)
and covers the entity-resolution operations an ebook/author pipeline needs.

## What it does

- **Searches entities** — parses a cached `wbsearchentities` response into
  matching entities (id, label, description, URL).
- **Gets an entity** — parses a cached `wbgetentities` response for a QID into
  its label, description, sitelinks, and raw claims.
- **Resolves a title** — resolves a Wikipedia page title to a Wikidata QID via
  its sitelink (the step that turns "Alfred Bester" → `Q286116`).
- **Extracts claims** — pulls a single property's value QIDs (e.g. `P31`) out
  of an entity into a simple list.
- **Instance-of shortcut** — `get-instance-of` extracts `P31` (instance of),
  the standard way to classify *what a thing is* (human `Q5` vs book `Q571` vs
  …).

## How it works with web-cache

Fetching, caching, pacing and retry are `@svendowideit/web-cache`'s job. This
model only *reads* entries from the shared cache directory (default
`~/.swamp/web-cache`), keyed by a normalized URL. On a cache miss it returns an
empty result with `cached: false` — it never makes a network request.

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
          modelType: "@svendowideit/wikidata"
          modelName: wd
          methodName: get-entity
          inputs:
            id: ${{ inputs.id }}
        dependsOn:
          - step: fetch
            condition:
              type: always
```

## Models

### @svendowideit/wikidata

| Method            | Description |
| ----------------- | ----------- |
| `search`          | Parse a cached `wbsearchentities` response into entities. |
| `get-entity`      | Parse a cached `wbgetentities` response for a QID. |
| `resolve-title`   | Resolve a Wikipedia title to a QID via its sitelink. |
| `get-claims`      | Extract one property's claim values (e.g. `P31`). |
| `get-instance-of` | Extract instance-of (`P31`) values from an entity. |

## Quick start

```bash
swamp extension pull @svendowideit/web-cache
swamp extension pull @svendowideit/wikidata

# 1. Fetch + cache an entity (web-cache):
swamp model @svendowideit/web-cache method run get cache \
  --input url="https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q286116&props=claims%7Cdescriptions%7Clabels&languages=en&format=json"

# 2. Parse it (wikidata reads the cache):
swamp model @svendowideit/wikidata method run get-entity wd \
  --input id="Q286116"

# Extract instance-of (P31) — classify what the entity is:
swamp model @svendowideit/wikidata method run get-instance-of wd \
  --input id="Q286116"

# Resolve a Wikipedia title to a QID (after web-cache.get on the sitelink URL):
swamp model @svendowideit/wikidata method run resolve-title wd \
  --input title="Alfred Bester"
```

> **Note:** each method accepts an explicit `url` input so the workflow can
> pass the exact URL `web-cache.get` fetched. When omitted, the URL is derived
> from the other inputs (and normalized to the same cache key).

## Global arguments

| Key        | Default                            | Description |
| ---------- | ---------------------------------- | ----------- |
| `cacheDir` | `~/.swamp/web-cache`               | Shared cache dir to read from (must match web-cache) |
| `apiUrl`   | `https://www.wikidata.org/w/api.php` | Wikidata action API base |
| `language` | `en`                               | Language for labels/descriptions/search |
| `site`     | `enwiki`                           | Sitelink site id for `resolve-title` |

## Data

- `search` — parsed entity search results.
- `entity` — a parsed entity (id, label, description, sitelinks, claims).
- `resolution` — a resolved Wikipedia title → QID (site, title, id, label).
- `claims` — extracted property claim values.
- `instance-of` — extracted P31 (instance of) values.

## Example: classifying an author vs a book

```bash
# resolve the title to a QID (after fetching the sitelink URL via web-cache)
swamp model @svendowideit/wikidata method run resolve-title wd --input title="Alfred Bester"
# → id: "Q286116"

# classify what it is
swamp model @svendowideit/wikidata method run get-instance-of wd --input id="Q286116"
# → instanceOf: ["Q5"]  (human)
```
