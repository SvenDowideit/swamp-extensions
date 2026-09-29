# @svendowideit/news

## What it does

The full news stack — feed discovery, catalog management, preference-aware
fetching, LLM story fusion, and static HTML rendering. It ships four model
extensions (`news-feed-discovery`, `news-feed-catalog`, `news-reader`,
`news-feed-analysis`), one report extension (`news_html_report`), the four news
workflows (`news-fetch`, `news-fusion`, `news-curation`, `news-full`), and the
decoupled feedback server that closes the 👍/👎 loop between the generated HTML
page and the workflows.

It turns a set of RSS/Atom feeds into a ranked, deduplicated, optionally
LLM-fused news digest, rendered as a static HTML page you can read or host. It
learns your preferences from the interest/ignore feedback on that page, clusters
related articles into one story, and — if you point it at an OpenAI-compatible
LLM — fuses each cluster into a single factual story with citations. Prefer it
over reading feeds by hand: every stage is a swamp method, so it composes,
resumes, and is auditable, and the fetch is incremental. It is LLM-optional:
without an LLM it still fetches, filters, and renders.

Side effects: it fetches the feeds in its catalog, writes the rendered pages and
story/feedback data under `~/.swamp/news-pages/`, and — when
`@svendowideit/systemd-service` is installed — runs the feedback server as a
systemd user service. Nothing else is installed on the host.

## Install

```sh
swamp extension pull @svendowideit/news
```

That's it. The workflows use direct type execution (`modelType` + `modelName`),
so swamp auto-registers the four model instances (`local-news`, `feed-catalog`,
`feed-discovery`, `feed-analysis`) on the first workflow run — no manual
`swamp model create` needed. Triggers come with the workflows (see
[Run on a schedule](#run-on-a-schedule)), so `swamp serve` wires everything up
on its own.

Add your first feeds before the first run (the catalog starts empty, and the
fetch step skips cleanly until it has something to fetch):

```sh
# Add two feeds to the catalog, tagged by category.
swamp model @svendowideit/news-feed-catalog method run add feed-catalog --input url="https://hnrss.org/frontpage" --input category=tech
swamp model @svendowideit/news-feed-catalog method run add feed-catalog --input url="https://feeds.bbci.co.uk/news/rss.xml" --input category=news
```

If you don't add any feeds, the workflows seed the catalog with the default
swamp-club feed (`https://swamp-club.com/feed.xml`) on their first run, so the
stack always has something to fetch.

Or pass feeds directly to a run without touching the catalog:

```sh
# One-off fetch of a single feed, without changing the catalog.
swamp workflow run @svendowideit/news-fetch --input 'feeds:json=["https://hnrss.org/frontpage"]'
```

## Configuration

Configure the news-reader instance before the first run (optional — fusion is
disabled until you set an LLM model). The `setup` method lists the current
config and validates any values you pass:

| Global argument | Default | Description |
| --------------- | ------- | ----------- |
| `llmBaseUrl` | `http://localhost:11434` | OpenAI-compatible LLM base URL (Ollama by default). |
| `llmModel` | `""` | Model tag for fusion; empty disables fusion. |
| `llmApiKey` | unset (sensitive) | API key for LLM servers that require auth. |
| `llmTemperature` | `0.1` | Sampling temperature for fusion calls. |
| `fusionMinClusterSize` | `2` | Minimum articles per cluster before LLM fusion triggers. |
| `citationRetentionDays` | `30` | How long article citations live before aging out. |
| `llmConcurrency` | `3` | Max concurrent LLM requests for fusion steps. |
| `maxFusions` | `25` | Hard cap on LLM calls per fusion step. |
| `llmTimeoutSec` | `120` | Per-call timeout for LLM requests. |
| `llmFailureThreshold` | `3` | Server-side LLM failures tolerated before a step halts. |
| `feedbackServerHost` | `127.0.0.1` | Interface the feedback server binds to. `127.0.0.1` is local-only; set a LAN address (or `0.0.0.0` behind a proxy) to expose it. |
| `feedbackServerPort` | `8765` | Port the feedback queue server listens on. |
| `feedbackServerServiceName` | `feedback-server` | systemd user service name for the feedback server. |

`feedbackServerHost`/`feedbackServerPort` are the **single source of truth** for
the feedback server's bind address. The `ensure-feedback-server` step reads them
from the `local-news` instance, and the `gatherFeedback`/`gatherPages` steps
derive their client URL from the same values — so changing the instance's
globals is the only way to move the server, and scheduled runs never rebind it
(the workflow no longer takes the bind address as a run input; a
`feedbackServerUrl` input remains only as an explicit one-off client override).

`@svendowideit/news-feed-catalog` has its own matching
`feedbackServerHost`/`feedbackServerPort` globals (defaults `127.0.0.1`/`8765`)
because `gatherFeedState` runs on that model; set them to match `local-news`
when the server is exposed beyond loopback.

The `news-feed-catalog`, `news-feed-discovery`, and `news-feed-analysis` models
each take their own small global arguments (catalog name, dedupe staleness,
news-reader model id); see their sections under [Details](#details).

## Examples

```sh
# List current config params (name, kind, default, current)
swamp model @svendowideit/news-reader method run setup local-news

# Enable LLM story fusion (Ollama default, or any OpenAI-compatible server)
swamp model @svendowideit/news-reader method run setup local-news --input llmModel=llama3 --input llmBaseUrl=http://localhost:11434

# Tune fusion behavior
swamp model @svendowideit/news-reader method run setup local-news --input llmTemperature=0.1 --input fusionMinClusterSize=2

# Point the feedback server at a specific LAN interface (persisted as a global;
# this is the supported way to move the server — not a workflow --input).
swamp model @svendowideit/news-reader method run setup local-news --input feedbackServerHost=192.168.1.10

# Persist your choices in the instance's globalArguments (setup only shows the
# diff; `swamp model edit` opens the definition to apply it).
swamp model edit local-news
```

Configurable params: `llmBaseUrl`, `llmModel` (empty = fusion off),
`llmApiKey`, `llmTemperature` (0..2), `fusionMinClusterSize` (int ≥ 1),
`citationRetentionDays` (int ≥ 0), `llmConcurrency` (1..20),
`maxFusions` (int ≥ 1, default 25), `llmTimeoutSec` (1..600s, default 120),
`llmFailureThreshold` (int ≥ 1, default 3), `feedbackServerHost`
(default `127.0.0.1`), `feedbackServerPort` (default `8765`).

`llmApiKey` is **sensitive** — swamp rejects it as a literal value in
`globalArguments` (it would be stored in cleartext in the definition YAML).
Store it in a vault and reference it instead:

```sh
swamp vault put my-vault llm-api-key   # prompts for the value
```

then set `llmApiKey: ${{ vault.get('my-vault', 'llm-api-key') }}` in the
instance's `globalArguments`. Ollama (the default) needs no key — leave it unset.

The last three bound how long a failing LLM server can stall a fusion step:
`maxFusions` caps the total LLM calls per step, `llmTimeoutSec` is the per-call
timeout, and `llmFailureThreshold` is how many *server-side* failures (outage,
no-response, HTTP 5xx) a step tolerates before it stops early — client-side
errors (4xx, bad JSON) are not counted. When a step stops early, whatever
stories were already written are kept as-is and the workflow moves on to the
next step (e.g. `fuse → seed → render`). Set `llmFailureThreshold=1` to fail
fast on the first server error, and `maxFusions=5` for a tighter cap.

## Run the workflows

The stack ships four workflows. Run them with `swamp workflow run <name>`:

```sh
# Fast path — feedback, fetch, dedupe, filter, generate HTML (every 4h)
swamp workflow run @svendowideit/news-fetch

# LLM story fusion — cluster, fuse, seed, render stories (every 12h)
swamp workflow run @svendowideit/news-fusion

# Catalog maintenance — dedupe, feed state, discovery, page analysis (daily 3am)
swamp workflow run @svendowideit/news-curation

# Full loop — discovery → catalog → fetch → filter → fuse → render in one run
swamp workflow run @svendowideit/news-full
```

Optional inputs for the fast path / full loop: `feeds` (array of feed URLs,
overrides the catalog), `action` (`fetch_generate` | `feedback`), `topN`
(article count in the HTML report, 0 = all), `discoverNewFeeds` (bool), plus
feedback fields `articleId`, `feedbackAction`, `source`, `title`.

```sh
swamp workflow run @svendowideit/news-fetch --input feeds:json='["https://hnrss.org/frontpage"]'
swamp workflow run @svendowideit/news-fetch --input topN=50
```

### Where the generated HTML goes

All three generated HTML pages land in a single user-global directory so they
survive repo moves and `swamp serve`'s working-directory changes:

| Page           | Path                             |
|----------------|----------------------------------|
| News summary   | `~/.swamp/news-pages/news.html`   |
| Mobile summary | `~/.swamp/news-pages/news-mobile.html` |
| Feeds catalog  | `~/.swamp/news-pages/feeds.html`  |
| Fused stories  | `~/.swamp/news-pages/stories.html`|

The directory is created on demand. To override (e.g. for a per-project output
location), pass `outputPath` — or run `swamp model @svendowideit/news-reader
method run generate local-news --input outputPath=/abs/path/to/news.html`;
`generateMobile` writes the mobile page (defaults to `news-mobile.html`, override
with `outputPath`); `feed-catalog generateFeedsHtml` and `local-news
renderStories` take the same `outputPath` argument.

## Run on a schedule

Each workflow YAML ships with a built-in `trigger.schedule` (cron) plus
`trigger.inputs` defaults, so no per-user trigger setup is required:

| Workflow                     | Schedule | Trigger inputs            |
|------------------------------|----------|---------------------------|
| `@svendowideit/news-fetch`   | every 4h  | `discoverNewFeeds: false` |
| `@svendowideit/news-fusion`  | every 12h | —                         |
| `@svendowideit/news-curation`| daily 3am | `discoverNewFeeds: true`  |
| `@svendowideit/news-full`    | disabled  | —                         |

`@svendowideit/news-full` ships with its schedule commented out — it's the
manual "run everything once" entry point, not a recurring job. The three
scheduled workflows (`news-fetch`, `news-fusion`, `news-curation`) cover the
same ground on their own cadences. To enable it, uncomment the `schedule:` line
in `news-full.yaml` (or set an override with `swamp workflow trigger set`).

Start the scheduler to register all four:

```sh
swamp serve          # runs scheduled triggers; live-reloads trigger changes
```

Notes:

- Schedules use standard 5-field cron (optional 6th = seconds field).
- If `serve` was down at a scheduled time, missed runs are NOT caught up —
  the next natural cron tick fires. Use `swamp serve --no-schedule` to
  disable scheduled runs (e.g. keep serve for the feedback server only).
- If one run is still in flight on a later tick, the later run is skipped
  with a warning (no overlap / queue build-up).

### Overriding the built-in schedule

The built-in trigger lives in the workflow YAML; to change it for your
machine, write a repo-local override (persisted to `serve.yaml`) with:

```sh
swamp workflow trigger set @svendowideit/news-fetch     --schedule "0 */6 * * *"
swamp workflow trigger set @svendowideit/news-fusion    --schedule "0 5,17 * * *"
swamp workflow trigger set @svendowideit/news-curation  --schedule "0 4 * * *"
```

Inspect and remove overrides the same way:

```sh
swamp workflow trigger get   @svendowideit/news-fusion    # built-in + local override
swamp workflow trigger remove @svendowideit/news-fusion   # fall back to the YAML default
```

Override precedence at fire time: `trigger.inputs` from the workflow YAML >
schema defaults. `swamp workflow trigger set` replaces the whole override map
(per workflow), so it's best for adjusting cadence rather than per-run inputs.

## Details

### Models

| Type | Purpose |
|---|---|
| `@svendowideit/news-reader` | Fetches RSS/Atom feeds, learns user preferences, generates a static HTML news summary page ranked by predicted interest. |
| `@svendowideit/news-feed-catalog` | Manages the curated list of RSS/Atom feeds. |
| `@svendowideit/news-feed-discovery` | Discovers new RSS/Atom feeds by crawling domains from the news-reader's article URLs and upserting them into the catalog. |
| `@svendowideit/news-feed-analysis` | Analyzes pages gathered by the news-reader, discovers RSS/Atom feeds in each page, and writes a page-discovery-result resource for catalog upsert. |
| `@svendowideit/news-html-report` | Report extension that renders the HTML page from the news-reader's snapshot. |

### Methods

`@svendowideit/news-reader`:

| Method | Description |
|---|---|
| `setup` | Print every config param (name, kind, default, current) and validate any values passed. |
| `fetch` | Fetch and parse the catalog's RSS/Atom feeds into a snapshot. |
| `dedupeArticles` | Group articles by URL, mark duplicates, annotate primaries with cross-feed sources. |
| `filterByAge` | Keep only articles within the configured time range (`newsAge`). |
| `generate` | Score articles against learned preferences and write the HTML page. |
| `generateMobile` | Write the mobile HTML page. |
| `feedback` | Record an interest/ignore click locally. |
| `gatherFeedback` | Poll the feedback queue server and import clicks into preferences. |
| `gatherPages` | Poll the pages queue server and add queued pages to the catalog. |
| `cleanupCdata` | Strip CDATA wrappers from stored keywords in snapshots and preferences. |
| `clusterArticles` | Deterministically group filtered articles into same-story clusters (no LLM). |
| `seedStories` | Create fresh persistent `Story` objects for clusters with no existing story. |
| `fuseStories` | Absorb each cluster's articles into an existing story, keeping per-claim provenance. |
| `regenStories` | Regenerate stories whose source set changed. |
| `renderStories` | Render accumulated stories into an inline fragment and a standalone page. |
| `ensureFeedbackServer` | Ensure the feedback server runs (as a systemd user service when available). |

`@svendowideit/news-feed-catalog`:

| Method | Description |
|---|---|
| `add` | Add a feed (or several) to the catalog. |
| `seed` | Seed the catalog with the default feeds when it is empty. |
| `dedupe` | Deduplicate feeds by content identity. |
| `gatherFeedState` | Gather per-feed enable/disable state from the feedback server. |
| `generateFeedsHtml` | Render the feeds.html catalog listing. |
| `remove` | Remove a feed from the catalog. |
| `list` | List the catalog's feeds. |
| `listCategories` | List the catalog's categories. |

`@svendowideit/news-feed-discovery`:

| Method | Description |
|---|---|
| `discover` | Crawl domains from article URLs and upsert discovered feeds into the catalog. |

`@svendowideit/news-feed-analysis`:

| Method | Description |
|---|---|
| `analyzePages` | Analyze gathered pages and discover RSS/Atom feeds in each. |

### Workflows

#### `news-fetch` (fast path, every 4h)

1. **Gather feedback** — polls the feedback queue server for 👍/👎 clicks from
   the HTML page, imports them into preferences.
2. **Fetch** — downloads RSS/Atom feeds from the catalog, parses articles,
   stores snapshot.
3. **Dedupe articles** — groups articles by URL, marks duplicates, annotates
   primary articles with cross-feed source info.
4. **Filter by age** — keeps only articles within the configured time range
   (default: last 3 days), skipping duplicate-marked articles.
5. **Generate HTML** — scores articles against learned keyword preferences,
   writes a static HTML page with fused stories rendered inline.
6. **Generate feeds HTML** — renders a feeds.html catalog listing with per-feed
   article counts, cross-feed sharing lines, and engagement-based sorting.

#### `news-fusion` (LLM, every 12h)

Clusters filtered articles into same-story groups and fuses them into
persistent story objects that survive the age-filter window:

1. **cluster** — `clusterArticles`: deterministically groups filtered articles
   into same-story clusters (no LLM). Guarded: skips if no `filtered-snapshot`
   exists yet.
2. **fuse** — `fuseStories`: absorbs each cluster's articles into an existing
   persistent story, keeping provenance per claim. Skips unchanged clusters
   (Phase 1.2 fingerprint comparison).
3. **seed** — `seedStories`: creates a fresh `Story` object for clusters with no
   existing story (parallel LLM calls, Phase 1.1).
4. **render** — `renderStories`: renders the accumulated stories into an inline
   `storiesHtml` fragment included in `news.html`, and writes a standalone
   `stories.html` page so fused stories are viewable on their own.

#### `news-curation` (daily 3am)

Catalog maintenance: dedupes feeds by content identity, gathers feed
enable/disable state from the feedback server, discovers new feeds, and
upserts them into the catalog.

#### `news-full` (combined loop)

The combined `@svendowideit/news-full` workflow — the full discovery → catalog →
fetch → filter → fuse → render loop in one run. This is the entry point most
users run.

## Feedback server

`scripts/feedback-server.ts` is a Deno HTTP server that decouples the HTML page
from the workflow (see `docs/news-fusing.md`).

When the [`@svendowideit/systemd-service`](https://github.com/svendowideit/swamp-extensions)
extension is installed, the workflow's `ensure-feedback-server` step stands the
server up as a long-lived systemd **user** service (`startService`). Because
`systemd-service` enables user **lingering** by default, the feedback server
then starts at boot — not just on login — so it keeps serving your generated
pages even when no one is signed in. If `@svendowideit/systemd-service` is *not*
installed, the step is skipped with a log and you can run the server manually
instead.

The server exposes the following endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/feedback` | Enqueue 👍/👎 clicks from the news page. |
| `GET /api/feedback` | Dequeue oldest feedback entries for the workflow. |
| `DELETE /api/feedback` | Remove processed feedback entries. |
| `POST /api/pages` | Enqueue page URLs for feed discovery. |
| `GET /api/pages` | Dequeue oldest page URLs. |
| `DELETE /api/pages` | Remove processed page URLs. |
| `POST /api/feed` | Enqueue feed enable/disable toggles. |
| `GET /api/feed` | Dequeue feed state changes. |
| `DELETE /api/feed` | Remove processed feed state entries. |
| `GET /` | Serve the generated `news.html`. |
| `GET /feeds.html` | Serve the feeds catalog listing. |
| `GET /stories.html` | Serve the standalone fused-stories page. |
| `GET /news-mobile.html` | Serve the mobile/tablet swipe news page. |

The server reads the HTML pages from the same `~/.swamp/news-pages/`
default the workflows write to, so no path flags are needed.

### Local (the default)

The server binds to **127.0.0.1** by default and has no authentication, so it is
only reachable from the machine it runs on. This is the safe default and the
only thing you need for a single-machine setup — just open the served page in a
local browser.

Run it by hand:

```sh
# from the extension directory (or pass explicit --html/--feeds/--stories paths
# to serve pages from elsewhere)
deno run --allow-net --allow-read --allow-write --allow-env scripts/feedback-server.ts
```

Or let the workflow manage it as a systemd user service (loopback, starts at
boot via lingering) — this is the default and needs no extra flags:

```sh
# ensure-feedback-server binds 127.0.0.1:8765 and enables lingering.
swamp workflow run @svendowideit/news-fetch
```

### Reachable from another device (opt in)

To read the page — and have the 👍/👎 buttons work — from your phone or another
machine, the server must bind an address that device can reach. The page posts
feedback to a **relative** URL (`/api/feedback`), so the browser that loaded the
page must be able to reach the server directly; a LAN address works, a
loopback-only server does not.

**This has no authentication**, and the server exposes an arbitrary-URL fetch
(`/api/frame-check`) plus the feedback/page write endpoints. Only bind it
non-locally on a trusted network or behind an authenticating reverse proxy.

Set the bind address on the **model instance** (recommended over `0.0.0.0` — a
specific LAN address limits the exposure to one interface). The scheduled
workflow then keeps the unit pointing at that address on every run:

```sh
# Validate and print the diff, then persist it into local-news' globalArguments.
swamp model @svendowideit/news-reader method run setup local-news \
  --input feedbackServerHost=192.168.1.10 --input feedbackServerPort=8765
swamp model edit local-news      # apply the diff setup printed

# The same settings on the catalog model, which owns gatherFeedState.
swamp model edit feed-catalog    # add feedbackServerHost/feedbackServerPort
```

Or run the script by hand on that interface:

```sh
deno run --allow-net --allow-read --allow-write --allow-env \
  scripts/feedback-server.ts --host 192.168.1.10 --port 8765
```

Because `ensure-feedback-server` creates the unit through
`@svendowideit/systemd-service`, the configured host/port are baked into the
unit's `ExecStart`, and user lingering makes it start at boot. Then open
`http://192.168.1.10:8765/` from the other device. Put an authenticating proxy
(e.g. Caddy with basic auth) in front if the network is not trusted.

### Upgrading from a pre-Sept-25 version

Before 2026.09.25 the feedback server's bind address could be set with a
**workflow input** (`--input feedbackServerHost=…`). That was a footgun: the
input defaulted to `127.0.0.1`, so the every-4-hours `news-fetch` trigger
re-passed it and silently rewrote an existing custom systemd unit back to
loopback. A one-off `--input` also only rewrote the unit file — `ensure-feedback-server`
never restarted the running process, so the change did not take effect until a
reboot or manual `systemctl --user restart feedback-server`.

The bind address is now a **model global**, so only configuration moves it.
If you set it via a workflow input before:

1. Persist the intended address on the instance (see above):

   ```sh
   swamp model @svendowideit/news-reader method run setup local-news \
     --input feedbackServerHost=192.168.1.10 --input feedbackServerPort=8765
   swamp model edit local-news
   ```

2. Apply it to the running service — `ensure-feedback-server` rewrites the unit
   but does not restart it:

   ```sh
   swamp model @svendowideit/systemd-service method run stopService feedback-server --input serviceName=feedback-server
   swamp model @svendowideit/systemd-service method run startService feedback-server --input serviceName=feedback-server
   ```

3. Remove any `feedbackServerHost`/`feedbackServerPort` from your
   `swamp workflow trigger set` overrides — they are now ignored (unknown
   inputs are accepted but unused). A `feedbackServerUrl` input still exists as
   an explicit one-off **client** override for `gatherFeedback`/`gatherPages`;
   leave it empty to follow the globals.

## Design notes

- `docs/news-fusing.md` — the fusion design & provenance model.
- `docs/PLAN.md`, `docs/LLM-FUSION.md` — implementation plans.

## License

MIT
