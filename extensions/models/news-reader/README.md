# @svendowideit/news-reader

A swamp model extension that fetches RSS/Atom feeds, learns your preferences,
and generates a static HTML news summary page ranked by predicted interest.

## How it works

1. **Fetch** — downloads RSS/Atom feeds, parses articles (title, URL, summary,
   keywords), and stores them as a versioned data resource.
2. **Generate** — reads the latest articles, scores them against your learned
   keyword preferences, and writes a static HTML page with the top articles
   sorted by interest score.
3. **Feedback** — you mark articles as "interested" or "ignored" (via the HTML
   page's 👍/👎 buttons or the CLI). The model recomputes keyword weights from
   your feedback, so future reports surface more of what you like.

The preference learning is keyword-based: each article's title/summary keywords
are extracted, and your feedback adjusts per-keyword weights (+1 for interested,
-1 for ignored). New articles are scored by summing the weights of their
matching keywords.

## Installation

```sh
swamp extension pull @svendowideit/news-reader
```

## Usage

The news workflow reads feeds from the **`@svendowideit/feed-catalog`** model's
stored data by default — add feeds to the catalog once, and every news run picks
them up automatically:

```sh
# One-time setup: create feed-catalog and add feeds
swamp model create @svendowideit/feed-catalog feed-catalog
swamp model method run feed-catalog add --input url="https://hnrss.org/frontpage" --input category=tech --input name="Hacker News"
swamp model method run feed-catalog add --input url="https://feeds.bbci.co.uk/news/technology/rss.xml" --input category=tech --input name="BBC Tech"

# Run the news workflow — reads feeds from catalog automatically
swamp workflow run news

# View the HTML
swamp data get --workflow news news-page --json | jq -r '.content' > news.html
open news.html
```

You can also pass feeds directly to override the catalog:

```sh
swamp workflow run news --input 'feeds:json=["https://feeds.bbci.co.uk/news/science/rss.xml"]'
```

The workflow is also **scheduled** — it runs automatically every 4 hours via
`swamp serve` (see the `trigger.schedule` in the workflow YAML).

### Recording feedback

After viewing the HTML page, mark articles as interesting or ignored:

```sh
# Mark an article as interesting
swamp workflow run news --input action=feedback --input articleId=abc123 --input feedbackAction=interested \
  --input source=hnrss.org --input title="AI breakthrough in quantum computing"

# Mark an article as ignored
swamp workflow run news --input action=feedback --input articleId=def456 --input feedbackAction=ignored \
  --input source=bbc.co.uk --input title="Boring sports result"
```

The HTML page includes 👍/👎 buttons that copy the feedback command to your
clipboard — paste it into the terminal to record your preference.

## Methods

| Method     | Description                                | Key arguments                                        |
| ---------- | ------------------------------------------ | ---------------------------------------------------- |
| `fetch`    | Fetch RSS/Atom feeds and store articles    | `feeds` (URL[]), `maxArticlesPerFeed`                |
| `generate` | Generate HTML report from latest articles  | `topN`, `title`                                      |
| `feedback` | Record user interest/ignore for an article | `articleId`, `action`, `source`, `title`, `keywords` |

## Output

The `generate` method writes a static HTML file as a swamp data artifact
(`report` file spec). The HTML includes:

- **Interest profile** — top keywords with their weights (green = interesting,
  red = ignored)
- **Article cards** — title (links to original), source, date, summary,
  keywords, interest score badge (★/↑/↓/·), and feedback buttons
- **Keyboard shortcuts** — `j`/`k` to navigate between articles

The `fetch` method stores articles as a structured JSON resource (`snapshot`
spec) with all parsed metadata.

## Scheduled execution

The workflow YAML includes `trigger.schedule: "0 */4 * * *"` — every 4 hours.
When running `swamp serve`, the workflow fires automatically. Default feeds for
scheduled runs are set in `trigger.inputs.feeds`.

## Cross-platform

Uses only Deno runtime APIs (`fetch`, `crypto.subtle`, `TextDecoder`) — no
external CLI tools. The RSS parser is a lightweight regex-based implementation
that handles both RSS 2.0 and Atom feeds, including CDATA sections.

## License

MIT — see LICENSE.txt for details.
