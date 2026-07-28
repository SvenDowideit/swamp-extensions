# @svendowideit/wordpress-import

One-shot WordPress importer — migrates posts from a site's REST API (WP JSON)
into Markdown files under a local directory, typically on the `blog/` side of an
Obsidian git repo. Each post becomes `<date>-<slug>.md` with YAML frontmatter
(title, date, slug, source URL, wp_id, tags, categories, excerpt) and its rendered
HTML content converted to Markdown. Images are optionally downloaded alongside
and rewritten as relative links so the vault history stays self-contained on
first import.

## Installation

```sh
swamp extension pull @svendowideit/wordpress-import
```

Or use the source in this repo directly:

```sh
swamp extension source add <repo>/extensions/models
swamp doctor extensions --repair -y
```

## Usage

Point a new model instance at your WordPress site and target directory, then run
the single `import` method:

```sh
# Public posts (no token needed) — e.g. migrating https://jig.tools
swamp model create @svendowideit/wordpress-import my-wp \
  --global-arg siteUrl=https://jig.tools \
  --global-arg targetDir=/path/to/obsidian-vault/blog

# Run the one-shot import (pages until x-wp-totalpages is exhausted)
swamp model method run my-wp import \
  --input perPage=50 --input downloadImages=true
```

Optional bearer token for password-protected / private posts:

```sh
swamp model create @svendowideit/wordpress-import secret-wp \
  --global-arg siteUrl=https://private.example.com \
  --global-arg targetDir=/path/to/obsidian-vault/blog \
  --global-arg authToken=xxxxx_your_jw_token_xxxxxx

swamp model method run secret-wp import --input perPage=50
```

Results (summary + one data record per post) are written to swamp's datastore:

```sh
swamp data query my-wp result   # siteUrl, totalPosts, notesWritten, imagesDownloaded, errors
swamp data query my-wp post     # id, slug, title, date, url, tags, categories
```

## Configuration

| Global argument | Description                                                            | Default     |
|-----------------|------------------------------------------------------------------------|-------------|
| `siteUrl`       | WordPress base URL (e.g. https://jig.tools)                            | *(required)*|
| `targetDir`     | Directory to write Markdown posts into (created if missing)            | *(required)*|
| `authToken`     | Optional WP REST API bearer token for private content                  | _none_      |

Method inputs:

| Input              | Description                                              | Default  |
|--------------------|----------------------------------------------------------|----------|
| `perPage`          | Posts per request page (WP max is 100)                | `50`     |
| `categoriesPerPage`| WordPress category-lookup batch size                  | `100`    |
| `downloadImages`   | Download `<img>` and featured-image URLs; rewrite      | `true`   |
| `imageFolder`      | Subfolder (inside targetDir) for downloads            | `assets` |

## Output layout

```
blog/
├── 2022-12-01-personal-computing-is-stuck-in-the-90s.md
├── assets/
│   ├── personal-computing-is-stuck-in-the-90s-0.jpg
│   └── ...
└── README.md        # (only if you add one) — the importer doesn't touch this
```

## Development & tests

Tests target the pure helpers (`sanitize`, `decodeEntities`, `htmlToMarkdown`)
and the pagination logic, so they run without touching the network:

```sh
deno test --allow-net extensions/models/wordpress-migrator/wordpress_import_test.ts
```

Run swamp's extension lint/quality gate before publishing:

```sh
swamp extension fmt  extensions/models/wordpress-migrator/manifest.yaml
swamp extension quality extensions/models/wordpress-migrator/manifest.yaml
```