# @svendowideit/ebooks

Incrementally scans the local filesystem for ebook files, detects bibliographic
metadata for each, resolves authors/titles against Wikipedia + Wikidata, and
renders an HTML page linking to each file's location.

## What it does

Turns a filesystem full of ebooks into a catalogued, browsable library.

- **Resumable scan** — every `scan-disk` run picks up where the previous one left
  off. The scan state (a breadth-first directory frontier plus the discovered
  ebooks) is persisted as swamp data, so a run never re-enumerates directories it
  has already visited until the whole tree is covered. Symbolic links are **not**
  followed, so a link loop cannot recurse and a file reachable by both a real
  path and a link is recorded once.
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
- **Optional Caddy serving** — when `@svendowideit/caddy` is installed, the
  final `ebook-scan` step (`ensure-caddy-serve`) declares a Caddy `file_server`
  route serving the render directory at `ebooks.<host>.<domain>`. The host and
  domain are read from the caddy model that already owns this machine, so
  nothing is hardcoded; the route lives on a dedicated `ebooks-caddy` model that
  caddy merges with the models it already runs, and caddy derives the A record
  and certificate for the name. With caddy absent the step skips with a log.

Side effects: it reads the filesystem under `root` and the shared web-cache, and
writes swamp data plus the two HTML files named by `outputPath` and
`authorsOutputPath`. When caddy is present it also declares a route on the
shared Caddy (see [Serving the pages with Caddy](#serving-the-pages-with-caddy)).

## Install

```sh
swamp extension pull @svendowideit/ebooks
```

A single pull also installs the declared dependencies
(`@svendowideit/web-cache`, `@svendowideit/wikipedia`, `@svendowideit/wikidata`).
Nothing is installed on the host.

`@svendowideit/caddy` is an optional dependency (declared in the manifest's
`optionalDependencies:`). Pull it separately to enable the HTTP(S) serving step;
without it that step skips and the pages stay on disk.

## Configuration

Workflow inputs (all optional):

| Key | Default | Description |
| --- | ------- | ----------- |
| `root` | `~` | Root path to scan |
| `outputPath` | `~/.swamp/ebooks/ebooks.html` | Where to write the HTML listing |
| `authorsOutputPath` | `~/.swamp/ebooks/index.html` | Where to write the author index |
| `title` | `Ebooks` | Page title |
| `cacheDir` | `~/.swamp/web-cache` | Shared web-cache dir (must match web-cache + ebooks) |
| `maxFetches` | `20` | Cap on origin fetches per `web-cache.get-many` call (cached hits don't count) |
| `skipScan` | `false` | Skip the directory scan; only re-detect metadata and render |

Global arguments on the ebooks model:

| Key | Default | Description |
| --- | ------- | ----------- |
| `root` | `~` | Root path to scan |
| `outputPath` | `~/.swamp/ebooks/ebooks.html` | Where to write the HTML listing |
| `authorsOutputPath` | `~/.swamp/ebooks/index.html` | Where to write the author index |
| `extensions` | epub, mobi, azw, azw3, fb2, lit, djvu, pdf | Ebook extensions to match |
| `excludePatterns` | `.git`, `.swamp`, `node_modules`, `.cache`, `.Trash` | Dir names to skip |
| `cacheDir` | `~/.swamp/web-cache` | Shared web-cache dir to read resolution responses from |
| `caddyModelName` | `""` | `@svendowideit/caddy` model to read the ebooks host and domain from. Empty auto-discovers the caddy model that owns this machine. Only used by `ensure-caddy-serve`, when caddy is installed. |
| `caddyRouteHostname` | `""` | Override the full hostname the pages are served under. Empty derives `ebooks.<host>.<domain>` from the caddy model. |

## Examples

Run the bundled workflow, which auto-registers the `ebooks` model on first run:

```sh
# Scan $HOME, detect metadata, resolve names, and render the pages.
swamp workflow run @svendowideit/ebook-scan
```

Point the scan at a specific directory, or a different output path:

```sh
# Scan a books directory instead of $HOME.
swamp workflow run @svendowideit/ebook-scan --input root=/home/me/books

# Write the HTML listing somewhere else.
swamp workflow run @svendowideit/ebook-scan --input outputPath=/srv/ebooks.html
```

Re-process the already-discovered paths without re-walking the filesystem —
use this after changing metadata detection or rendering:

```sh
swamp workflow run @svendowideit/ebook-scan --input skipScan=true
```

Tune the resolution fetch rate. `maxFetches` caps origin fetches per
`web-cache.get-many` call (cached hits don't count); lower it to keep each run
short, raise it to drain the backlog faster:

```sh
swamp workflow run @svendowideit/ebook-scan --input maxFetches=50
```

Re-run the workflow to continue a long scan in five-minute increments; the page
regenerates each time.

Serve the rendered pages over HTTP(S). When `@svendowideit/caddy` is installed
and a caddy model already owns this machine, the workflow's final step declares
a Caddy `file_server` route at `ebooks.<host>.<domain>` — no extra flags needed:

```sh
# The serve-html step runs automatically at the end of every scan; the host and
# domain come from the caddy model that owns this machine (e.g. ebooks.x1yoga.fi.gy).
swamp workflow run @svendowideit/ebook-scan
```

Declaring (or refreshing) that route on its own — e.g. after changing the
`outputPath` or to serve a staging directory:

```sh
# Serve a directory explicitly instead of the configured outputPath's directory.
swamp model method run ebooks ensure-caddy-serve --input serveRoot=~/.swamp/ebooks/staging
```

Confirm the served hostname and the caddy model the route lives on:

```sh
swamp data get ebooks caddyServe --json
```

## Details

### Models

`@svendowideit/ebooks` — the scanner + decision engine:

| Method | Description |
| ------ | ----------- |
| `scan-disk` | Start/resume the filesystem scan (arg: `maxDurationMs`). |
| `detect-metadata` | Detect metadata for one file (`file`) or all discovered ebooks, up to `maxDurationMs`. |
| `plan-resolution` | Emit the authors/titles that still need resolving, capped at `maxNames`. Does no fetching. |
| `pick-candidate` | Choose one name's canonical candidate from its already-parsed search + page-props results (per name). |
| `classify` | Classify one name (author/book) from its infobox + Wikidata P31 and write the `resolution` record (per name). |
| `resolve-wikipedia` | DEPRECATED — back-compat; emits the name list (same as `plan-resolution`). |
| `render-html-list` | Render the full HTML listing (arg: `title`). |
| `render-html-authors` | Render an author-grouped index of ebooks with a detected author (arg: `title`). |
| `ensure-caddy-serve` | When `@svendowideit/caddy` is installed, declare a `file_server` route serving the render directory at `ebooks.<host>.<domain>`, on a dedicated `ebooks-caddy` model that caddy merges. Args: `model`, `serveModel`, `hostname`, `serveRoot`. Skips (with a log) when caddy is absent or no single caddy model can be chosen. |

`@svendowideit/book-metadata` — a generic, reusable metadata model (usable for
physical books too):

| Method | Description |
| ------ | ----------- |
| `detect` | Detect metadata from a file (`file`) and store a book record keyed by ISBN/slug. |
| `register` | Store metadata you already have (title, author, ISBN, dates, publisher, …). |

Both share the same `BookMetadata` shape, so ebook-detected metadata and
physical-book metadata are interchangeable.

### Resolution pipeline

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

### Data

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
- `caddyServe` — status of the Caddy `file_server` route serving the pages
  (hostname, root, the `ebooks-caddy` model it lives on, the source caddy model).
- `book` — a single detected/registered book record (book-metadata model).

### Serving the pages with Caddy

`ensure-caddy-serve` (the final `serve-html` step of `@svendowideit/ebook-scan`)
publishes the rendered directory over HTTP(S) when
[`@svendowideit/caddy`](https://github.com/svendowideit/swamp-extensions) is
installed. It is entirely optional and degrades to local-only with a log when
caddy, or a suitable caddy model, is absent.

It reads the **host** and **domain** from the caddy model that already owns this
machine (`swamp model list --json` + `swamp model get <name> --json`), derives
the host's FQDN from that model's A records (falling back to the base domain),
and serves `ebooks.<hostFqdn>` (e.g. `ebooks.x1yoga.fi.gy`). Nothing is
hardcoded; the same model that owns `x1yoga.fi.gy` yields `ebooks.x1yoga.fi.gy`.

The route is declared on a dedicated `ebooks-caddy` model (created on first run
via `swamp model create`), which carries only the source model's `baseDomain`
and `serviceName` — the **minimum** needed. Because `ebooks-caddy` shares the
source's (target, `serviceName`), the caddy extension **merges** its route with
the Caddy that is already running, and caddy's route derivation adds the TLS
subject (certificate) and, when a DNS provider is configured, the A record. So
one `serveSettings` call is the whole integration: no duplicated DNS records,
subjects, plugins or email — those come from the models already sharing the
Caddy.

Confirm the route landed in the running Caddy and is in sync:

```sh
# Read-only audit of every caddy model's desired routes against the live config.
swamp model @svendowideit/caddy method run ebooks-caddy audit caddy-status
swamp data get caddy-status audit --json | jq '.content.cadies[] | {target, desiredRoutes, inSync}'
```

Pin a specific source caddy model (when more than one exists) or override the
whole hostname:

```sh
# Point at a particular caddy model instead of auto-discovering this machine's.
swamp model get ebooks --json | jq '.globalArguments.caddyModelName="my-caddy"' | swamp model edit ebooks --json

# Override the hostname for a single run, bypassing derivation.
swamp model method run ebooks ensure-caddy-serve --input hostname=books.example.com
```

The `ebooks-caddy` model is a normal caddy model, so `swamp model get
ebooks-caddy --json` shows the base domain and unit it copied, and the
`@svendowideit/caddy-upgrade` workflow upgrades it with the others.

Because caddy is an optional peer discovered at runtime, `ensure-caddy-serve`
shells out to the swamp CLI (`swamp model list`/`get`/`create` and `swamp model
method run <serveModel> serveSettings`). Every argument it passes is a fixed
literal or a value derived from this model's own global args — never untrusted
input. It is skipped entirely when `swamp model type search @svendowideit/caddy`
does not report the type as installed.

### Extending and testing

The scan/decision logic lives in `ebooks.ts`; the book-metadata type, detection
and classification helpers live in `book_metadata.ts`; the HTML/author-index
rendering is in `ebooks.ts` (`renderHtml`, `renderAuthorsHtml`). Workflows are
the three YAML files listed in the manifest.

```sh
# Type-check and run the unit tests.
~/.swamp/deno/deno check ebooks.ts book_metadata.ts
~/.swamp/deno/deno test --allow-read --allow-write --allow-env ebooks_test.ts book_metadata_test.ts
```

`ebooks_test.ts` covers the scan state machine, name keying, planning, and the
HTML renderers; `book_metadata_test.ts` covers detection parsing and the
author/book classifier.

## License

MIT — see LICENSE.txt.
