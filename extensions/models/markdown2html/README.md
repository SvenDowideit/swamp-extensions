# @svendowideit/markdown2html

Render Markdown files into a static HTML site with an index page.

## What it does

`@svendowideit/markdown2html` scans a Markdown directory, parses optional
frontmatter, renders each file with marked, applies an optional template, and
writes per-page HTML plus an index page and rss.xml. No Python or marked CLI is required.

## Install

```sh
swamp extension pull @svendowideit/markdown2html
```

## Frontmatter, template tokens, and index ordering

Optional YAML frontmatter is read only when a file begins and ends with
`---`. Supported fields are `title`, `date`, `slug`, and `excerpt`. Values
fall back as follows:

- `title`: first H1, otherwise the file name
- `date`: empty string
- `slug`: file name without extension
- `excerpt`: first paragraph

Template tokens: `{{title}}`, `{{body}}`, `{{date}}`, `{{slug}}`,
`{{excerpt}}`, `{{siteTitle}}`, `{{recent_posts}}`, and `{{archives}}`.
`{{body}}`, `{{recent_posts}}`, and `{{archives}}` are inserted unescaped;
all other tokens are HTML-escaped.

Pages are sorted by optional frontmatter date from newest to oldest; files without dates sort after
dated files. Ties are ordered by title. The workflow writes one HTML file per
Markdown file and then writes `index.html` with the latest post in full and the
next four as summaries. `rss.xml` contains every post. `{{recent_posts}}` is
RSS followed by the latest five posts; `{{archives}}` lists every post.

## Configuration

Global arguments: `sourceDir`, `outputDir`, `siteTitle`, `indexTitle`,
`templatePath`, `recursive`. `indexTitle` controls the title of `index.html`
and `rss.xml`; it defaults to `siteTitle`.

Method: `generate` with optional overrides for these fields.

## Examples

```sh
# Render /home/me/notes into a static site.
swamp model method run pages generate \
  --input sourceDir=/home/me/notes \
  --input outputDir=/home/me/site
```

Render is a single command; it writes `index.html` automatically.

```sh
# Validate then run through a workflow when one is attached.
swamp workflow validate @figy/blog
```

Workflow validation is useful for catching bad inputs before deployment.

```sh
# Verify generated output locally.
ls /home/me/site/*.html
```

Confirming files exist shows the renderer ran successfully.

## Upgrade

```sh
swamp extension update
```

Nothing is installed on the host.

## Details

Model type: `@svendowideit/markdown2html`. Method: `generate`. No Python or
Markdown markers are required.
