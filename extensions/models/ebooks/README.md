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
- **HTML listing** — `render-html-list` renders every discovered ebook into a
  static HTML page, showing the detected title, author and edition date where
  available, or the plain file path otherwise.
- **Author index** — `render-html-authors` renders a second page (`index.html`)
  listing only ebooks with a detected author, grouped under a section titled by
  the author.

## Quick Start

```bash
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

This runs only `detect-metadata -> render-html-list -> render-html-authors`
against the ebook paths already recorded in `state`.

## Models

### @svendowideit/ebooks

| Method             | Description |
| ------------------ | ----------- |
| `scan-disk`        | Start/resume the filesystem scan (arg: `maxDurationMs`). |
| `detect-metadata`  | Detect metadata for one file (`file`) or all discovered ebooks, up to `maxDurationMs`. |
| `render-html-list` | Render the full HTML listing (arg: `title`). |
| `render-html-authors` | Render an author-grouped index of ebooks with a detected author (arg: `title`). |

### @svendowideit/book-metadata

A generic, reusable metadata model (usable for physical books too):

| Method     | Description |
| ---------- | ----------- |
| `detect`   | Detect metadata from a file (`file`) and store a book record keyed by ISBN/slug. |
| `register` | Store metadata you already have (title, author, ISBN, dates, publisher, …). |

Both share the same `BookMetadata` shape, so ebook-detected metadata and
physical-book metadata are interchangeable.

## Workflow inputs

| Key                 | Default                        | Description                            |
| ------------------- | ------------------------------ | -------------------------------------- |
| `root`              | `~`                            | Root path to scan                      |
| `outputPath`        | `~/.swamp/ebooks/ebooks.html`  | Where to write the HTML listing        |
| `authorsOutputPath` | `~/.swamp/ebooks/index.html`   | Where to write the author index        |
| `title`             | `Ebooks`                       | Page title                             |
| `skipScan`          | `false`                        | Skip the directory scan; only re-detect metadata and render |

## Global arguments (ebooks model)

| Key               | Default                        | Description                            |
| ----------------- | ------------------------------ | -------------------------------------- |
| `root`            | `~`                            | Root path to scan                      |
| `outputPath`      | `~/.swamp/ebooks/ebooks.html`  | Where to write the HTML listing        |
| `authorsOutputPath` | `~/.swamp/ebooks/index.html` | Where to write the author index        |
| `extensions`      | epub, mobi, azw, azw3, fb2, lit, djvu, pdf | Ebook extensions to match |
| `excludePatterns` | `.git`, `.swamp`, `node_modules`, `.cache`, `.Trash` | Dir names to skip |

## Data

- `state` — resumable scan state (frontier, seen dirs, discovered ebooks).
- `metadata` — detected book metadata keyed by ebook path.
- `page` — result of the last HTML page generation (path, count, timestamp).
- `book` — a single detected/registered book record (book-metadata model).
