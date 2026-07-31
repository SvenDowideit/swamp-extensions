# @svendowideit/astro-layout

A swamp model extension that generates an Astro static site layout from markdown files. It scans a directory of markdown files, creates page metadata for each, and detects dynamic component markers to generate placeholder comments for astro islands that users can implement later.

## How it works

1. **Scan** — reads all `.md` and `.markdown` files from the specified source directory
2. **Parse** — extracts frontmatter (title, date, slug, tags) and body content
3. **Detect dynamic components** — finds `$ComponentName$` markers in markdown for Astro islands
4. **Generate pages** — creates structured page metadata with option to write Astro project structure

## Features

- Automatically generates Astro-compatible slugs from filenames or frontmatter
- Detects `$ComponentName$` patterns in markdown content as placeholders for client-side islands
- Parses standard YAML frontmatter (title, date, slug, draft, tags, category)
- Supports both SSR and client-rendered component markers
- Creates structured page resources that can be used to build Astro pages

## Installation

```sh
swamp extension pull @svendowideit/astro-layout
```

Or use the source in this repo directly:

```sh
swamp extension source add <repo>/extensions/models
swamp doctor extensions --repair -y
```

## Usage

Create a model instance pointing at your markdown directory and base URL, then run the generate method:

```sh
# Create a model for your markdown site
swamp model create @svendowideit/astro-layout my-blog \
  --global-arg siteUrl=https://example.com \
  --global-arg sourceDir=/path/to/markdown/content

# Run generation (writes page resources and files to output directory)
swamp model method run my-blog generate --input outputDir=./my-astro-site

# With all options:
swamp model method run my-blog generate \
  --input outputDir=./my-astro-site \
  --input includeDynamicComponents=true

# View generated pages
swamp data query my-blog page --json

# Get the generation result summary
swamp data query my-blog result --json
```

### Dynamic Component Markers

Your markdown can include `$ComponentName$` markers to indicate where client-side island components should render:

```markdown
---
title: Interactive Demo
date: 2026-07-28
---

# My Page

This content renders on the server.

<InteractiveChart $data$ />

A button like this would be hydrated as an island client-side:
$ButtonComponent$
```

The extension will detect `ButtonComponent` and `InteractiveChart` as dynamic components that need to be implemented by users.

## Method arguments

Both methods share these global input arguments, set at model create time:

| Argument    | Description                          |
|-------------|--------------------------------------|
| `siteUrl`   | Base URL for the Astro site (e.g. https://example.com) — used as source for `clone`, emitted in layouts for both |
| `sourceDir` | Directory containing markdown files to process by `generate`; required positional, unused by `clone` |

### Generate method arguments

| Argument                 | Type    | Default              | Description                                            |
|--------------------------|---------|----------------------|--------------------------------------------------------|
| `outputDir`              | string  | `./astro-site`       | Output directory for generated Astro project          |
| `includeDynamicComponents` | boolean | `true`            | Generate placeholder comments for astro islands        |

### Clone method arguments

The `clone` method fetches an existing URL and produces a starter Astro layout that replicates its visual structure: CSS, fonts, body content and element classes.

| Argument          | Type    | Default              | Description                                            |
|-------------------|---------|----------------------|--------------------------------------------------------|
| `outputDir`       | string  | `./astro-clone`      | Output directory for the cloned Astro project         |
| `includeFonts`    | boolean | `true`               | Generate `@import`/`preconnect` links extracted from source |
| `siteUrl`         | string  | _(global siteUrl)_   | Override the model's global siteUrl for this clone run |

```sh
# Clone an existing site's layout (siteUrl is taken from global args)
swamp model create @svendowideit/astro-layout my-clone \
  --global-arg siteUrl=https://example.com \
  --global-arg sourceDir=/tmp/placeholder   # unused by clone, required by model

# Run the clone method — outputDir and includeFonts both optional (defaults: ./astro-clone / true)
swamp model method run my-clone clone \
  --input outputDir=./cloned-site \
  --input includeFonts=true

# Override the siteUrl for a single run without changing the model's global value
swamp model method run my-clone clone \
  --input siteUrl=https://another-site.com \
  --input outputDir=./cloned-site

# Serve the result locally in a container (see "Viewing your site locally" below)
make -f docker/Makefile.serve SERVE_DIR=./cloned-site
```

## Viewing your site locally

Both `generate` and `clone` produce an identical Astro project skeleton inside an output directory (`src/layouts/Layout.astro`, `package.json`, `astro.config.mjs`). The easiest way to preview the result without installing Node/npm/Astro on your host is to build a tiny dev-server image:

```sh
# 1️⃣ Generate (or clone) first — produces e.g. ./cloned-site or ./my-astro-site
swamp model method run my-blog generate --input outputDir=./my-astro-site
# …or: swamp model method run my-clone clone --input outputDir=./cloned-site

# 2️⃣ Serve that directory in a cached Astro container on host port 4321 -> container 0.0.0.0:4321
make -f extensions/models/astro-layout/docker/Makefile.serve \
   SERVE_DIR=./cloned-site      # PORT=4321 (override if already taken)

# Browse http://localhost:4321 — hot-reloading enabled, bind-mounted from your outputDir
```

How it works:

- `docker/Dockerfile.serve` builds a throwaway image that runs Astro's dev server with `--host 0.0.0.0`, so the preview is reachable on `http://localhost:<PORT>/` and listens inside the container's network namespace (no per-host Node setup needed).
- The Makefile binds your real outputDir into `/srv/astro-site` via a volume mount, so edits you make to `.astro`/`.mdx`/source files show up instantly with hot reload — nothing is copied.
- Stop with `make -f extensions/models/astro-layout/docker/Makefile.serve stop PORT=4321`.

> If you'd rather not use Docker: locally install Astro and run `npm install && npx astro dev --host 0.0.0.0` from inside your output directory, then open `http://localhost:4321/`.

| Argument    | Description                          |
|-------------|--------------------------------------|
| `siteUrl`   | Base URL for the Astro site (e.g. https://example.com) |
| `sourceDir` | Directory containing markdown files to process |

## Output structure

Pages are stored as swamp data resources with the following schema:

```json
{
  "slug": "my-page",
  "title": "My Page Title",
  "sourceFile": "/path/to/source.md",
  "hasDynamicComponents": true,
  "dynamicComponentKeys": ["ButtonComponent", "ChartWidget"]
}
```

The generation result includes:

- `siteUrl` — the configured base URL
- `totalPages` — total input files processed (including skipped)
- `pagesGenerated` — successfully processed pages  
- `skippedFiles` — list of files that were empty/skipped
- `errors` — any errors encountered with file paths

## Markdown Frontmatter Support

The extension parses these frontmatter fields:

| Field | Type    | Description |
|-------|---------|-------------|
| `title` | string  | Page title (defaults to filename or "Untitled") |
| `date` | string  | ISO date for the page |
| `slug` | string  | URL slug (auto-generated from filename if not provided) |
| `draft` | boolean | Whether this is a draft page |
| `tags` | string[]| Array of tags/categories |
| `category` | string | Single category label |

## Example Astro Project Structure

Once pages are generated, you can build an Astro project structure:

```
astro-site/
├── src/
│   ├── pages/
│   │   ├── index.astro
│   │   └── [slug].astro
│   ├── layouts/
│   │   └── Layout.astro
│   └── components/
│       └── ButtonComponent.tsx  # (implement your islands here)
├── public/
└── astro.config.mjs
```

## Development & tests

Tests target the pure helpers (`parseFrontmatter`, `sanitizeSlug`, `detectDynamicComponents`) and run without network access:

```sh
deno test extensions/models/astro-layout/astro_layout_test.ts
```

Run swamp's extension lint/quality gate before publishing:

```sh
swamp extension fmt extensions/models/astro-layout/manifest.yaml
swamp extension quality extensions/models/astro-layout/manifest.yaml
```

## License

MIT — see LICENSE.txt for details.
