# @svendowideit/ebooks

Incrementally scans the local filesystem for ebook files and renders an HTML
page linking to each file's location on disk.

## What it does

- **Resumable scan** — every `scan-disk` run picks up where the previous one left
  off. The scan state (a breadth-first directory frontier plus the discovered
  ebooks) is persisted as swamp data, so a run never re-enumerates directories it
  has already visited until the whole tree is covered.
- **Self-terminating** — each `scan-disk` run enforces a wall-clock budget
  (`maxDurationMs`, default 5 minutes) and stops when it is exhausted, handing
  control back to the caller so the next step can run without rescanning
  completed ground.
- **HTML listing** — `render-html-list` renders every discovered ebook into a
  static HTML page at a configured path, linking to each file's filesystem
  location.

## Quick Start

```bash
swamp extension pull @svendowideit/ebooks

# Run the bundled workflow (auto-registers the "ebooks" model on first run):
swamp workflow run @svendowideit/ebook-scan
swamp workflow run @svendowideit/ebook-scan --input root=/home/me/books
```

Re-run the workflow to continue a long scan in 5-minute increments; the page
regenerates each time.

## Model methods

- **scan-disk** — start or resume the scan. Arguments:
  - `maxDurationMs` (default `300000`) — per-run wall-clock budget.
- **render-html-list** — render the HTML page. Arguments:
  - `title` (default `"Ebooks"`) — page title.

## Global arguments

| Key               | Default                        | Description                            |
| ----------------- | ------------------------------ | -------------------------------------- |
| `root`            | `~`                            | Root path to scan                      |
| `outputPath`      | `~/.swamp/ebooks/ebooks.html`  | Where to write the HTML listing        |
| `extensions`      | epub, mobi, azw, azw3, fb2, lit, djvu, pdf | Ebook extensions to match |
| `excludePatterns` | `.git`, `.swamp`, `node_modules`, `.cache`, `.Trash` | Dir names to skip |

## Data

- `state` — resumable scan state (frontier, seen dirs, discovered ebooks).
- `page` — result of the last HTML page generation (path, count, timestamp).
