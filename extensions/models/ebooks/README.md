# @svendowideit/ebooks

Incrementally scans the local filesystem for ebook files, detects bibliographic
metadata for each, and renders an HTML page linking to each file's location.

## What it does

- **Resumable scan** — every `scan-disk` run picks up where the previous one left
  off. The scan state (a breadth-first directory frontier plus the discovered
  ebooks) is persisted as swamp data, so a run never re-enumerates directories it
  has already visited until the whole tree is covered.
- **Self-terminating** — each `scan-disk` / `detect-metadata` run enforces a
  wall-clock budget (`maxDurationMs`, default 5 minutes) and stops when it is
  exhausted, handing control back to the caller so the next step can run without
  rescanning completed ground.
- **Metadata detection** — `detect-metadata` derives author, title, ISBN,
  initial/edition publish dates, publisher, language and more from the file path,
  filename, filesystem metadata and (where parseable) the file contents (epub
  OPF, PDF info dictionary, ISBN/date regexes).
- **Author & title resolution (delegated fetch)** — resolution is a fetch-free
  decision pipeline in this model. It emits the Wikipedia/Wikidata URLs to
  fetch, and the `@svendowideit/web-cache` model does the actual fetching
  (pacing + caching). This model then reads the cached bodies and applies
  ebook-specific decisions: candidate selection from opensearch results,
  canonical-name correction (e.g. "K. A. Applegate" → "Katherine Applegate"),
  and author-vs-book classification from the page's infobox template and the
  Wikidata `instance-of` (P31) claims.
- **Classification via infobox + Wikidata** — the author-vs-book decision uses
  two ordered signals: the page's infobox template (e.g. `{{Infobox writer}}` /
  `{{Infobox book}}`), then the Wikidata `instance-of` values (e.g. `Q5` =
  human vs `Q571` = book). Because the raw wikitext and Wikidata entity are
  cached by web-cache (not re-fetched), already-resolved names can be
  re-analysed later (bump `CURRENT_RESOLUTION_VERSION`). The author index only
  links names actually classified as people — so false positives like `"3"` or
  a book title won't appear as linked authors.
- **HTML listing** — `render-html-list` renders every discovered ebook into a
  static HTML page, showing the detected title, author and edition date where
  available, or the plain file path otherwise.
- **Author index** — `render-html-authors` renders a second page (`index.html`)
  listing only ebooks with a detected author, grouped under a section titled by
  the author.

## Quick Start

```bash
swamp extension pull @svendowideit/web-cache
swamp extension pull @svendowideit/ebooks

# Run the bundled workflow (auto-registers the "ebooks" model on first run):
swamp workflow run @svendowideit/ebook-scan
swamp workflow run @svendowideit/ebook-scan --input root=/home/me/books
```

Re-run the workflow to continue a long scan in 5-minute increments; the page
regenerates each time.

### Skip the directory scan

To re-process the already-discovered ebook paths without re-walking the
filesystem (e.g. after changing the metadata detection or rendering), skip the
scan step:

```bash
swamp workflow run @svendowideit/ebook-scan --input skipScan=true
```

This runs only `detect-metadata -> … -> render-html-list -> render-html-authors`
against the ebook paths already recorded in `state`.

### Tune the fetch rate

Resolution fetching is delegated to `@svendowideit/web-cache`, whose `get-many`
calls are capped by `maxFetches` (origin fetches per call — cached hits don't
count). Lower it to keep each run short; raise it to drain the backlog faster:

```bash
swamp workflow run @svendowideit/ebook-scan --input maxFetches=50
```

## Models

### @svendowideit/ebooks

| Method                 | Description |
| ---------------------- | ----------- |
| `scan-disk`            | Start/resume the filesystem scan (arg: `maxDurationMs`). |
| `detect-metadata`      | Detect metadata for one file (`file`) or all discovered ebooks, up to `maxDurationMs`. |
| `plan-resolution`      | Emit the authors/titles that still need resolving, capped at `maxNames`. Does no fetching. |
| `pick-candidate`       | Choose one name's canonical candidate from its already-parsed search + page-props results (per name). |
| `classify`             | Classify one name (author/book) from its infobox + Wikidata P31 and write the `resolution` record (per name). |
| `resolve-wikipedia`    | DEPRECATED — back-compat; emits the name list (same as `plan-resolution`). |
| `render-html-list`     | Render the full HTML listing (arg: `title`). |
| `render-html-authors`  | Render an author-grouped index of ebooks with a detected author (arg: `title`). |

### @svendowideit/book-metadata

A generic, reusable metadata model (usable for physical books too):

| Method     | Description |
| ---------- | ----------- |
| `detect`   | Detect metadata from a file (`file`) and store a book record keyed by ISBN/slug. |
| `register` | Store metadata you already have (title, author, ISBN, dates, publisher, …). |

Both share the same `BookMetadata` shape, so ebook-detected metadata and
physical-book metadata are interchangeable.

## Resolution pipeline

Resolution is a fetch-free decision pipeline driven by workflows, with all
network I/O delegated (transitively) to `@svendowideit/web-cache`:

```
plan-resolution                     → emits the names still to resolve
  → forEach name: ebooks-resolve-name
      wikipedia-search              → candidate titles
      wikipedia-page-props          → canonical title / shortdesc / wikidataId
      ebooks.pick-candidate         → choose the best candidate
      wikipedia-infobox             → infobox template name
      wikidata-instance-of          → P31 value QIDs
      ebooks.classify               → classify (author/book) + write `resolution`
render-html-list / render-html-authors
```

Each of those child steps calls the wikipedia/wikidata workflows, which read the
bodies web-cache has already fetched and cached. The ebook model shares the same
`cacheDir` and URL-normalizing cache-key scheme as web-cache, so cache-hit vs
fetch is invisible here.

## Workflow inputs

| Key                 | Default                        | Description                            |
| ------------------- | ------------------------------ | -------------------------------------- |
| `root`              | `~`                            | Root path to scan                      |
| `outputPath`        | `~/.swamp/ebooks/ebooks.html`  | Where to write the HTML listing        |
| `authorsOutputPath` | `~/.swamp/ebooks/index.html`   | Where to write the author index        |
| `title`             | `Ebooks`                       | Page title                             |
| `cacheDir`          | `~/.swamp/web-cache`           | Shared web-cache dir (must match web-cache + ebooks) |
| `maxFetches`        | `20`                           | Cap on origin fetches per `web-cache.get-many` call (cached hits don't count) |
| `skipScan`          | `false`                        | Skip the directory scan; only re-detect metadata and render |

## Global arguments (ebooks model)

| Key               | Default                        | Description                            |
| ----------------- | ------------------------------ | -------------------------------------- |
| `root`            | `~`                            | Root path to scan                      |
| `outputPath`      | `~/.swamp/ebooks/ebooks.html`  | Where to write the HTML listing        |
| `authorsOutputPath` | `~/.swamp/ebooks/index.html` | Where to write the author index        |
| `extensions`      | epub, mobi, azw, azw3, fb2, lit, djvu, pdf | Ebook extensions to match |
| `excludePatterns` | `.git`, `.swamp`, `node_modules`, `.cache`, `.Trash` | Dir names to skip |
| `cacheDir`        | `~/.swamp/web-cache`           | Shared web-cache dir to read resolution responses from |

## Data

- `state` — resumable scan state (frontier, seen dirs, discovered ebooks).
- `metadata` — detected book metadata keyed by ebook path.
- `names` — the list of `{ name, expectKind, key }` items `plan-resolution`
  emitted this run (the fan-out driver), plus `planned`/`backlog`/`truncated`
  counts so a capped run honestly reports names left for a later run.
- `candidate` — a chosen candidate per name (`pick-candidate`).
- `resolution` — a per-name Wikipedia/Wikidata resolution record (`classify`).
  Each entry records the canonical name, kind, URL, infobox and Wikidata
  `instance-of` values (the raw bodies are cached by web-cache).
- `page` — result of the last HTML page generation (path, count, timestamp).
- `book` — a single detected/registered book record (book-metadata model).
