# @svendowideit/swamp-pulse

A leaderboard-style activity dashboard for the swamp project itself.

Swamp Pulse tracks three streams of work — **swamp-club Lab issues**, **GitHub
commits**, and **GitHub releases** — across `swamp-club/swamp` and
`swamp-club/swamp-extensions`. Because a release, its commit and its PR are the
same event, the streams are **joined into one merged item per change** rather
than listed three times. Each item is ranked by a synthesized significance
hierarchy, and the result is rendered as five linked static HTML pages: a docs
summary, an activity leaderboard, and three detail pages (changes, releases,
issues) and one summary page styled after the swamp-club leaderboard, with
24-hour / 7-day / current-month windows.

Every merged item links back to its source, and any change that touches
documentation produces a **"New / changed documentation"** link to both the
published manual page (when one can be matched) and the exact source file at
that commit's SHA.

## Presentation: release-notes tour style

The detail pages follow the **interactive release-notes tour** format
popularised by the
[VictoriaMetrics Go 1.27 tour](https://victoriametrics.com/blog/go-1-27/)
(itself continuing Anton Zhiyanov's `antonz.org` Go tours). Rather than dumping
a flat commit log, Pulse renders each notable item as a self-contained tour
section, so a reader can skim what changed and how it matters without reading
the raw history.

Each item is presented as:

- **A headline section with an anchor** (`<h2 id="…">`) and a sidebar table of
  contents, so every change is directly linkable and the page can be skimmed by
  heading.
- **A one-line "why it matters" lede** — the plain-language context, the way the
  tour opens each release note before showing code.
- **A short excerpt or example**, in a fenced/`<pre>` block with the rendered
  result beneath it (the tour's "code then output" pattern). For a commit this
  is the diff summary or the changed signature; for an issue it is the reported
  symptom; for a release it is the highlight of the body.
- **A trailing reference row** of labelled links in the tour's convention —
  **𝗗** docs/manual, **𝗣** the issue or proposal number, **𝗖𝗟** the commit SHA,
  **𝗔** the author — for each feature discussed.
- **Grouped tail sections** — _Other notable changes_, _Tooling_, _Hidden gems_
  (the lower-significance C-tier items), and _Final thoughts_ (the window's
  themes, mirroring the tour's closing summary).

The summary page's 24h / 7d / month views select which items are promoted into
that tour layout; the three detail pages are the long-form versions.

> Credit: the interactive-tour format was started by
> [Anton Zhiyanov](https://antonz.org/) (Go 1.22–1.26) and picked up by
> [VictoriaMetrics](https://victoriametrics.com/blog/go-1-27/); this project
> borrows the presentation model, not the content.

## Install (new users)

```sh
swamp extension pull @svendowideit/swamp-pulse

# Required target type that this extension extends (see "Reuse" below).
swamp extension pull @webframp/github
swamp extension trust add webframp
```

Installing `@svendowideit/swamp-pulse` provides three model types, one report,
and one workflow:

| Content                     | Type / name                         |
| --------------------------- | ----------------------------------- |
| Pulse model                 | `@svendowideit/swamp-pulse`         |
| Vendored Lab adapter (fork) | `@svendowideit/swamp-club`          |
| GitHub methods extension    | extends `@webframp/github`          |
| Report                      | `@svendowideit/swamp-pulse-summary` |
| Workflow                    | `@svendowideit/swamp-pulse`         |

The model instances (`pulse`, `github`, `swamp-club`) are auto-registered on the
first workflow run — no manual `swamp model create` needed, and no credentials
required (see below).

## Configure

Pulse reads **public** data by default, with no secrets:

- The swamp-club Lab API (`GET /api/v1/lab/issues`) is public — anonymous works.
- `gh` uses its own CLI auth (`gh auth login`) if present; public repos need no
  token for these read calls.

Optionally, store a swamp-club API key in a vault to see the same issue view the
CLI sees (it also raises rate limits):

```sh
swamp vault put my-vault swamp-club-api-key   # prompts for the value
```

Then set it in the `swamp-club` instance's `globalArguments`:

```yaml
apiKey: ${{ vault.get('my-vault', 'swamp-club-api-key') }}
```

`apiKey` is **sensitive** and now **optional** in the vendored fork — swamp
still rejects a literal value, so the vault reference is required _if_ you set
it. Leave it unset to run anonymously.

Configurable global arguments on the pulse model: `outputDir` (default
`~/.swamp/swamp-pulse`), `manualBaseUrl` (default
`https://swamp-club.com/manual`), `windows` (`["24h", "7d", "month"]`),
`storeRetentionDays` (default 90), `docPathPattern` (default empty), and the
server settings `serverPort`, `serverServiceName`, `serverScriptPath`.

The repositories to track are a **workflow** input (`repos`), not a model global
— change them per run or in a trigger override:

```sh
swamp workflow run @svendowideit/swamp-pulse \
  --input 'repos:json=["swamp-club/swamp"]'
```

## Run

```sh
# Collect → rank → render in one DAG (the scheduled path).
swamp workflow run @svendowideit/swamp-pulse

# Or run the stages individually.
swamp model @svendowideit/swamp-pulse method run rank pulse
swamp model @svendowideit/swamp-pulse method run render pulse
```

Optional inputs: `repos` (array, overrides the default), `since` (ISO-8601
window start), `outputDir` (per-run output location), and `publish` (`false` |
`caddy` | `github-pages`). For Caddy mode: `hostname`, `upstream`. For GitHub
Pages mode: `pagesRepo`, `pagesBranch`, `pagesPath`, `pagesCname`. For the
systemd service: `serverPort`, `serviceName`.

The `since` input defaults to the empty string, and the collectors normalise
an empty `since` to 30 days ago — so a bare `swamp workflow run` (and every
scheduled/hourly run) collects the trailing 30-day window. Pass an explicit
ISO-8601 timestamp to narrow the window.

```sh
# Serve locally via Caddy
swamp workflow run @svendowideit/swamp-pulse --input publish=caddy

# Publish to GitHub Pages (requires a target)
swamp workflow run @svendowideit/swamp-pulse \
  --input publish=github-pages \
  --input pagesRepo=owner/repo --input pagesBranch=gh-pages
```

> **Guard polarity:** a step's `guard` is a _skip_ condition — a **truthy**
> guard means the step is skipped. Every optional publish step is skipped unless
> its mode is selected, e.g.
> `guard: ...mode != "github-pages" || ...configured == false`. (An inverted
> guard here once made the Caddy step run on every default run.)

### Where publishing config comes from

Two layers, resolved with this precedence:

**per-run input → model global argument → schema default**

#### See every setting first

Before changing anything, ask the model what it accepts:

```sh
swamp model @svendowideit/swamp-pulse method run setup pulse
```

That prints each global argument grouped by purpose, with its **valid values**,
**default**, **current value**, and a one-line explanation — plus what
publishing currently resolves to and what's missing for the selected mode:

```
--- publishing ---
publishMode [enum] default=false values=false|caddy|github-pages current=false — What publishing to do. …
pagesRepo [string] default="" current="" (empty) — Target repository as owner/name. Required for publishMode=github-pages.
pagesBranch [string] default="" current="" (empty) — Branch Pages serves from, e.g. gh-pages. Required for publishMode=github-pages.
Publishing resolves to: mode=false pagesRepo=(unset) pagesBranch=(unset) caddyHostname=(unset)
Publishing is off. To enable: --input publishMode=github-pages --input pagesRepo=owner/repo --input pagesBranch=gh-pages …
```

Pass values to have them **validated** and see the exact change to make — it
does not persist anything itself:

```sh
swamp model @svendowideit/swamp-pulse method run setup pulse \
  --input publishMode=github-pages \
  --input pagesRepo=owner/repo --input pagesBranch=gh-pages
```

```
Validated 3 setting(s) OK.
Would set:
  publishMode: "github-pages"
  pagesRepo: "owner/repo"
  pagesBranch: "gh-pages"
To persist, run `swamp model edit pulse` and set the values above in globalArguments:.
```

Because the method runs against the model type, **it works even before the
`pulse` instance exists** — running it creates the instance with all defaults
(same as the first workflow run), so you can inspect the configuration on a
fresh install.

#### Option A — configure the model once (recommended for scheduled runs)

The workflow runs against a model instance named **`pulse`**
(`@svendowideit/swamp-pulse`). Set the publishing globals on it and every
scheduled run honours them with no trigger inputs.

Create the instance up front with the values you want:

```sh
swamp model create @svendowideit/swamp-pulse pulse \
  --global-arg publishMode=github-pages \
  --global-arg pagesRepo=owner/repo \
  --global-arg pagesBranch=gh-pages
```

This writes `models/@svendowideit/swamp-pulse/pulse.yaml` (a normal, committable
file — not under `.swamp/`). Because it lists every global argument, the file is
also the easiest thing to inspect and edit by hand:

```yaml
type: "@svendowideit/swamp-pulse"
typeVersion: 2026.09.18.12
id: 508ebdd4-d95a-40be-b813-a64bc2030fee
name: pulse
version: 1
tags: {}
globalArguments:
  outputDir: ~/.swamp/swamp-pulse
  publishMode: github-pages # false | caddy | github-pages
  pagesRepo: owner/repo # required for github-pages
  pagesBranch: gh-pages # required for github-pages
  pagesPath: / # / or /docs
  pagesCname: "" # optional custom domain
  caddyHostname: "" # required for caddy
  caddyUpstream: 127.0.0.1:8899
methods: {}
```

To change it later, either edit that file directly, or run:

```sh
swamp model edit pulse          # opens $EDITOR; save and quit to apply
```

`swamp model edit` opens the definition in your editor. If `$EDITOR` is unset it
falls back to an interactive picker, so for a non-interactive script pipe the
whole definition in instead:

```sh
cat models/@svendowideit/swamp-pulse/pulse.yaml | swamp model edit pulse --json
```

Then simply run the workflow — no publish inputs needed:

```sh
swamp workflow run @svendowideit/swamp-pulse
```

If the `pulse` instance does not exist yet, running any method (including
`setup`) or the first workflow run auto-creates it under
`.swamp/auto-definitions/` with **all defaults** (publishing off).

This is also why `swamp model edit pulse` can fail with
**`Model not found:
pulse`** on a fresh install, and why `swamp model search`
shows no models even though workflows are running: auto-created definitions are
deliberately **not listed** by `swamp model search` or `swamp model list` — they
exist only for data ownership. `swamp model get pulse` shows them, and creating
the instance explicitly (as above) makes it visible and keeps it in a file you
can commit.

#### Option B — override for one run

Any of the publish settings can be supplied per run, overriding the model for
that invocation only:

```sh
swamp workflow run @svendowideit/swamp-pulse \
  --input publish=github-pages \
  --input pagesRepo=owner/repo --input pagesBranch=gh-pages
```

The full set of per-run publish inputs: `publish`, `pagesRepo`, `pagesBranch`,
`pagesPath`, `pagesCname`, and (Caddy mode) `hostname`, `upstream`.

An **empty** `publish` defers to the model, which is why its default is `""`
rather than `"false"` — a bare `swamp workflow run` never clobbers a configured
instance, and `--input publish=false` is how you switch publishing off for a
single run.

#### How it is resolved

`configure` is the first step of every run. It merges both layers into the
**`publishConfig`** resource, which is what the guards and the config assert
actually read — workflow guards and `assert` steps cannot read
`model.*.input.globalArguments.*`, only `data.latest(...)`.

```
configure  →  publishConfig resource  →  guards + require-pages-config assert
```

It publishes nothing itself. If the selected mode is missing something it needs
(say `github-pages` with no `pagesRepo`), it records an actionable `reason` and
the run **fails fast** rather than silently skipping the publish. Inspect what a
run resolved with:

```sh
swamp data get pulse publish-config --json
```

### Where the generated HTML goes

All six pages land in one user-global directory so they survive repo moves and
`swamp serve`'s working-directory changes:

| Page            | Path                                 |
| --------------- | ------------------------------------ |
| Summary         | `~/.swamp/swamp-pulse/index.html`    |
| Commits/changes | `~/.swamp/swamp-pulse/changes.html`  |
| Releases        | `~/.swamp/swamp-pulse/releases.html` |
| Lab issues      | `~/.swamp/swamp-pulse/issues.html`   |

Override with `outputDir` (model global arg or per-run input).

### Page layout (tour format)

Each of the three detail pages is a tour: a sticky sidebar ToC built from the
item anchors, tour sections in rank order, then the grouped tail sections
(_Other notable changes_, _Tooling_, _Hidden gems_, _Final thoughts_).

**`index.html` (Summary)** is the documentation view: the files changed in the
current month, one card per file, newest first. It carries only docs — the
activity board lives on its own page.

**`leaderboard.html`** is the activity view: ranked merged items, top 25 per
window, for 24h / 7d / month.

**`extensions.html`** is the registry view (see below). All six pages share the
same nav bar, so every page links to every other page.

### Extension registry

`extensions.html` reads the public registry API (`/api/v1/extensions/search`)
and presents three tabs — **New**, **Updated**, and **Popular** — with
CSS/JavaScript to show the selected tab's list and hide the others (the tab
bar also honours a `#new`/`#updated`/`#popular` URL hash for deep links):

1. **New** — extensions first published in the window.
2. **Updated** — extensions that published a new version in the window.
3. **Popular** — the highest all-time `pullCount`, regardless of window
   (labelled as such, since the API exposes no pull history).

Each entry links to the extension's **registry page** and its **source
repository** (`github.com`/`codeberg.org`), and shows the description, author,
latest version, quality grade, pull count, labels, and the relevant date —
localized like every other timestamp. The registry has ~1,600 extensions and
~600 change in a typical month, so the updated tab shows the 50 most recent
with the remainder behind a `<details>` fold (no JavaScript required).

The registry has no date filter, so windowing pages the `sort=updated` ordering
until a page falls before the window. That single ordering covers both streams:
a new extension has `createdAt == updatedAt`, so it appears in the same sweep
and is classified as _new_ rather than _updated_.

Every page's footer names the extension that generated it, linked to its
[registry page](https://swamp-club.com/extensions/@svendowideit/swamp-pulse),
shows the **version** used, and when it **last ran** — the latter rendered with
the same local-time logic as every other timestamp, so it reads "just now" or "4
hours ago" for recent runs.

### New / changed documentation

Documentation changes get their own section at the bottom of the **summary
page**, labelled with its period like every other section (e.g. "New / changed
documentation — This month").

Each **file is listed once** — files are ordered by most recently updated, and
the changes that touched that file within the period sit inside its card:

```
design/enablers/remote-execution.md
swamp-club/swamp · 1 change · updated 2026-09-17T23:38:48Z · published manual
  [A] 2026-09-17T23:38:48Z  reap stale worker records…  𝗗 release … 𝗖𝗟 a3e60933 𝗣 #2509 𝗔 lab#2192
```

The file header links to the exact source at the most recent commit's SHA, and
offers the published manual page (or an explicit "no published page"). Each
nested change carries its tier, date, title, and references back to the
**originating Lab issue**, PR and commit. Deduplication is by filename, not URL
— the URL carries the SHA, so the same file changed twice would otherwise appear
twice.

Where a change's release body says which issue it closes (`Closes lab#N`), that
issue is linked in preference to any incidental mention — a commit often cites a
context issue before the one it actually resolves. Detail pages additionally
show a compact "Docs changed:" line on each affected item.

All interpolated text (commit titles, release bodies, issue bodies) is
**HTML-escaped**; release and issue bodies are rendered as sanitised text with
fenced code preserved. This is a tested requirement, not an afterthought.

### Local time

Every timestamp is rendered server-side as a `<time datetime="…">` element
holding the raw UTC ISO value, so the page is correct without JavaScript. A
small script in each page then rewrites the visible text to the **viewer's
browser timezone**:

- **Within the last 24 hours** it shows relative wording — `just now`,
  `15 mins ago`, `1 hour ago`, `4 hours ago`.
- **Older** values show an absolute, localized date/time.
- A `data-time-format="date"` field (the leaderboard column) always stays a
  date, since "15 mins ago" reads wrong in a date column, and future timestamps
  fall back to absolute so clock skew can't print a negative age.
- The relative wording **refreshes every minute**, so a page left open stays
  honest, and the exact localized value is available on hover (`title`).

Months, day order and 12/24-hour convention follow the viewer's locale. This is
verified in a real headless browser, not just unit-tested.

## How items are ranked

Pulse does not replicate the swamp-club user-activity leaderboard. It ranks the
tracked **work items** on a synthesized importance hierarchy, **tier first,
recency as the tie-break** — recency only decides between items of equal
significance, it never promotes a low-significance item above a
high-significance one. Each ranked item records a human-readable `rationale`.

Items are **merged events**, not raw rows: a release, its commit and its PR are
one item (see "Releases are the primary unit" below). The tier is derived from
the merged item's conventional-commit type, its linked issue's type/status, and
whether it touches security or docs.

| Tier  | Signal                                                                                      |
| ----- | ------------------------------------------------------------------------------------------- |
| **S** | Security issue shipped; a breaking-change release; a merge fixing a security-labelled issue |
| **A** | Shipped bug/feature (`feat:`, `fix:`); docs updated alongside a fix                         |
| **B** | `in_progress`/`triaged` issues; `perf:`/`refactor:`/`chore:` merges                         |
| **C** | Open (untriaged) issues; `docs:`-only merges; prereleases                                   |

Ordering is lexicographic: `(tier_rank, recency)` per window. A numeric
`score = base_importance × corroboration_bonus` is retained for display and for
sorting _within_ a tier, but it never overrides the tier ordering.

**Corroboration** rewards an item whose merge explicitly links a Lab issue that
has moved to `shipped`. Issue and pull-request numbers are distinct namespaces
on GitHub: a merge title like `fix(cli): … (swamp-club#2254) (#2507)` references
lab issue **2254** and PR **2507**. Pulse parses `swamp-club#NNNN` / `lab#NNNN`
for issue linkage and treats a bare `#NNNN` as a PR reference only — a bare
number never corroborates a Lab issue. Getting this wrong would silently inflate
ranks.

> Note on the month window: swamp-club's public leaderboard only exposes
> 24-hour, 7-day and all-time boards. The 24h and 7d Pulse windows can be
> cross-checked against the real boards, but the **current month** window is a
> UTC calendar month derived entirely from Pulse's own collected activity —
> there is no upstream month board.

## Reuse: what is extended, forked, and why

Per the repo rule "extend, don't be clever", Pulse reuses existing types rather
than reimplementing `gh` or HTTP plumbing. Verification against the actual
published sources drove three decisions:

**1. Lab issues — vendored fork of `@webframp/swamp-club`.**

`@webframp/swamp-club` exposes only `get_lab_issue_context` (a single issue) and
its `apiKey` global argument is **required** (`z.string().min(1)`,
`meta({ sensitive: true })`, `.strict()` globals). Two problems follow: it
cannot list issues, and its required key breaks anonymous use and workflow
auto-registration. An `export const extension` **cannot** relax global
arguments, so a fork is genuinely required.

`swamp_club.ts` vendors an Apache-2.0 fork (© Sean Escriva), retaining the
upstream SPDX header and adding:

- `apiKey` made **optional** (anonymous access when unset).
- `search_lab_issues { since, until, type?, status?, limit, offset }` —
  paginated `GET /api/v1/lab/issues`, normalised with `createdAt`/`updatedAt`.
- `truncated` on the output schema.
- `host` default retained; timeout + `Retry-After`/429 handling.

Published under the type name `@svendowideit/swamp-club`.

**2. GitHub commits & releases — extend `@webframp/github`.**

`@webframp/github` has **no commit methods at all**, its `ReleaseSchema` is
`{tagName,name,publishedAt,isPrerelease,isDraft}` with **no `body`** and a
`--limit 10` cap, and its issue schema has no body. Rather than bypass it,
`github_commits.ts` is an `export const extension` targeting
`type: "@webframp/github"` that adds:

- `collect_commits { repos, since, until, max }` — commits for every repo in one
  fan-out call, normalised (sha, author, date, message), with `truncated`.
- `collect_doc_changes { repos, since, until, maxCommits, maxFiles }` — finds
  every changed documentation file in the range. It walks **all** commits, not
  just ones with a doc-sounding message (see the note below), inventories the
  range with the `compare` API, then attributes each doc file to the newest
  commit that touched it via the commits-by-path endpoint.
- `collect_releases { repos, since, max }` — body-inclusive releases for every
  repo via the **releases API**, because `gh release list` cannot return bodies
  (verified: the API does, ~2.9 KB each). Paginated, with `truncated`.

All three are fan-out methods taking a `repos` array, so a run acquires the
model lock once and the workflow stays generic over however many repositories
are configured.

> Naming matters: `@webframp/github` already defines `list_releases`. A
> colliding method name is **silently skipped** with an extension-load warning
> (verified in `model_kind_adapter.processSecondaryExport`), so the
> body-inclusive method is deliberately named `collect_releases`. Likewise
> `collect_commits` (not `list_commits`) and `collect_doc_changes`.

Adding methods to a foreign type is allowed: publish-time
`validateContentCollectives` checks models/vaults/workflows/datastores/reports/
webhooks but **not** `contentMetadata.extensions` (verified), and at runtime the
extension attaches as long as the target type is registered first — so
`@webframp/github` is a declared `dependencies:` entry and a documented install
step.

**3. Releases are the primary unit — no collapsing.**

Verification corrected an earlier assumption: a swamp release is **1:1 with a
merge**. In 30 recent releases, 29 bodies carried exactly one PR line
(`fix(workers): reap stale worker records… (swamp-club#2192) (#2509)`), and the
release tag embeds the commit SHA (`v20260917.233703.0-sha.a3e60933`). Volume is
high but meaningful — **273 in 30 days, 63 in 7 days, 16 in 24h** — so
collapsing to one per day would discard almost everything.

Releases are therefore kept **individually** and treated as the primary stream,
because each release body is already the curated, human-readable changelog for
that merge: conventional-commit type, scope, title, and the linked lab issue
and/or PR. Pulse parses the body into a structured item rather than reformatting
the raw commit.

**3b. One event, one item — dedupe across streams.**

Because a release, its commit and its PR are the _same_ event, the streams must
be joined, not listed three times: a release maps to its commit by the SHA in
the tag, and to its PR/issue by the numbers parsed from the body. The merged
item carries all three identifiers. Only commits with **no** corresponding
release (e.g. direct pushes, docs-only merges that skip a build) appear as
additional commit-only items, and PRs referenced in a release never appear as
separate entries. Without this join, significance ranking would triple-count
every merge.

## Documentation links

For every changed path ending in `.md` (plus `design/**`, `README*`), Pulse
emits two links:

1. **Source** — `https://github.com/<repo>/blob/main/<path>` (always
   available; links to the current `main` branch so readers see the final
   version rather than the snapshot at the triggering commit).
2. **Manual** — the matching `swamp-club.com/manual/...` page, from a cached
   `sitemap.xml` plus an explicit **path→manual map** for known areas (e.g.
   `design/enablers/datastores.md` →
   `/manual/reference/datastore-configuration`). Fuzzy slug matches carry a
   confidence flag and are only linked above a threshold; below it, the source
   link is the sole link (never guess a manual page).

Whole-window changed files come from the `compare` API (verified: returns the
file list for a ref range) rather than one call per commit, then each doc file
is attributed to its commit via the commits-by-path endpoint. A message-based
"doc-suspect" filter is deliberately **not** used — see the note under Design
notes.

## Serving and publishing

Serving is a **workflow step** (`ensure-server`) backed by the pulse model's
`ensureServer` method. Publishing is opt-in: **nothing is published by
default**, and each mode is a separate step that is skipped unless explicitly
selected.

### Serve the pages over HTTP (systemd user service)

The workflow's `ensure-server` step idempotently ensures the static server runs
as a systemd **user** service via
[`@svendowideit/systemd-service`](https://github.com/svendowideit/swamp-extensions):

```sh
swamp extension pull @svendowideit/systemd-service
swamp workflow run @svendowideit/swamp-pulse
```

Because `systemd-service` enables user **lingering** by default, the server
starts at boot — not just on login — so the pages stay served. The step is
`allowFailure: true` and the method skips with a log if the extension is not
installed, so nothing breaks without it. Tune it with
`--input serverPort=8899 --input serviceName=swamp-pulse-server`.

Without `systemd-service`, run the server manually:

```sh
~/.swamp/deno/deno run --allow-net --allow-read --allow-env \
  scripts/pulse-server.ts --port 8899 --dir ~/.swamp/swamp-pulse
```

It serves the six allowlisted pages (`/`, `/leaderboard.html`,
`/extensions.html`, `/changes.html`, `/releases.html`, `/issues.html`) plus
`/healthz`, and rejects path traversal.

### Publish on a hostname via Caddy (optional)

When [`@svendowideit/caddy`](https://github.com/svendowideit/swamp-extensions)
is installed and a `my-caddy` model exists (`baseDomain`, `letsEncryptEmail`),
the `publish-caddy` step points a reverse proxy at the pulse server:

```sh
swamp workflow run @svendowideit/swamp-pulse \
  --input publish=caddy --input hostname=pulse.example.com
```

It depends on `ensure-server` (either outcome) and is `allowFailure: true`, so
an absent Caddy degrades to local-only with a log.

### Publish to GitHub Pages (optional, opt-in)

Uses
[`@svendowideit/github-pages`](https://github.com/svendowideit/swamp-extensions)
to commit the rendered pages to a repository's Pages site via the GitHub REST
API — no `gh-pages` package, no extra checkout, no action runner. It hashes each
file as a git blob locally and uploads only what changed, so re-runs are cheap.

```sh
swamp extension pull @svendowideit/github-pages
swamp workflow run @svendowideit/swamp-pulse \
  --input publish=github-pages \
  --input pagesRepo=owner/repo --input pagesBranch=gh-pages \
  --input pagesPath=/ --input pagesCname=example.com   # last two optional
```

**Nothing is published by default.** Two guards enforce that:

1. `require-pages-config` — an assert step that **fails fast** when
   `publish=github-pages` is set without `pagesRepo` and `pagesBranch`, rather
   than silently doing nothing or guessing a repository.
2. `publish-github-pages` — guarded to run only when the mode is selected _and_
   both are set.

Authentication uses the `gh` CLI's credential (`gh auth login`), so no secret
needs storing. The step runs `publishDir` with `prune: true`, so files removed
from the output are removed from the branch too.

## Models

| Type                                | Purpose                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@svendowideit/swamp-pulse`         | Merges collected data, ranks it (tier-then-recency), renders the six HTML pages, and ensures the static server runs. |
| `@svendowideit/swamp-club`          | Vendored Lab adapter — anonymous-capable Lab issue search.                                                           |
| `@webframp/github` (extended)       | Upstream GitHub type, extended here with commit and body-inclusive release methods.                                  |
| `@svendowideit/swamp-pulse-summary` | Report extension — markdown + JSON run summary (counts per window, top-ranked items, doc links).                     |

## Workflows

### `swamp-pulse` (hourly)

The workflow is the composition layer — separate collector steps write data that
the pulse model consumes via CEL expressions (models cannot call each other's
methods):

1. **collect-issues** — `@svendowideit/swamp-club search_lab_issues`
2. **collect-commits** — `@webframp/github collect_commits` (fan-out over
   `repos`)
3. **collect-releases** — `@webframp/github collect_releases` (fan-out over
   `repos`)
4. **collect-docs** — `@webframp/github collect_doc_changes` (fan-out over
   `repos`)
5. **rank** — `@svendowideit/swamp-pulse rank`, CEL-wired from steps 1–4; joins
   releases↔commits↔PRs into merged items, merges into the rolling store,
   computes the three windows (UTC), links docs
6. **render** — `@svendowideit/swamp-pulse render`, reads the `ranked` resource
   and writes all six pages
7. **ensure-server** — `@svendowideit/swamp-pulse ensureServer`, idempotently
   runs `scripts/pulse-server.ts` as a systemd user service via
   `@svendowideit/systemd-service` (`allowFailure`; skips with a log if absent)
8. **publish-caddy** — optional Caddy `ensureDnsProxy` pointing at the server
   (`allowFailure`, skipped unless `publish=caddy`)
9. **require-pages-config** — assert that `pagesRepo`/`pagesBranch` are set when
   `publish=github-pages` (fails fast otherwise)
10. **publish-github-pages** — optional `@svendowideit/github-pages publishDir`
    commit (skipped unless selected and configured)

## Design notes

- **Direct HTTP, not the CLI.** A model method cannot call `swamp issue search`
  — it holds the per-model lock and would deadlock. Lab issues are fetched from
  `GET /api/v1/lab/issues` directly (in the vendored fork).
- **Incremental, not full re-fetch.** The pulse store persists a per-repo/per-
  source cursor; each run fetches only what is new since the cursor (with a
  bounded overlap) and merges into a rolling window store. This keeps API volume
  flat instead of re-pulling the whole month every hour.
- **Docs are found by path, not by message.** An early version filtered commits
  to ones whose message mentioned docs, which missed most documentation changes:
  in a sampled week, **39 commits touched `.md` files and only 3 had a
  doc-sounding message** (92% missed). The collector now inventories the whole
  range with `compare` and filters by changed **path** (`doc_paths.ts`), then
  attributes each file to its commit. Bounded by `maxCommits`/`maxFiles` with an
  explicit `truncated` flag.
- **Truncation is explicit.** Every paginated/capped collector output carries a
  `truncated` boolean so a silently-short list can never be mistaken for the
  full set.
- **Unofficial endpoint.** The Lab issue API is not a published contract; access
  is isolated in `swamp_club.ts` so it can be adapted in one place.

## Implementation plan

Status of the build. Ticked = implemented, tested and verified in a live
workflow run.

**Docs**

- [x] `README.md` (this file) — plan, verified design decisions, tour format

**Scaffold**

- [x] `manifest.yaml` (`paths.base: manifest`, README + LICENSE + NOTICE +
      tests + server in `additionalFiles`, `dependencies: ["@webframp/github"]`)
- [x] `LICENSE.txt` (MIT) + `NOTICE` (Apache-2.0 attribution for the vendored
      fork)
- [x] Register this directory in `.swamp-sources.yaml`

**Reused / forked data sources**

- [x] `swamp_club.ts` — Apache-2.0 fork of `@webframp/swamp-club`
      (`@svendowideit/swamp-club`), `apiKey` optional, `search_lab_issues`,
      `truncated`, 429/`Retry-After`
- [x] `github_commits.ts` — `export const extension` on `@webframp/github`;
      `collect_commits`, `collect_releases`, `collect_doc_changes` (fan-out over
      `repos`; names chosen to avoid colliding with upstream `list_releases`)
- [x] Confirm `swamp model type describe @webframp/github` shows the added
      methods
- [x] `~/.swamp/deno/deno check` + unit tests for both

> Implementation note: global-argument schemas are **not** `.strict()`. Swamp
> merges global args into method arguments, and a strict global schema rejects
> them — reproduced against the published upstream `@webframp/swamp-club`, so
> the fork drops `.strict()` on globals (argument/resource schemas keep it).

**Model**

- [x] `swamp_pulse.ts` — globals (`outputDir`, `manualBaseUrl`, `windows`,
      `storeRetentionDays`, `docPathPattern`)
- [x] Resources: `store` (rolling, cursor, 90d), `ranked`, `manualIndex`
- [x] `rank` — CEL-input merge, join releases↔commits↔PRs into merged items
      (dedupe by SHA **prefix** — release tags carry short SHAs), tier-then-
      recency ordering, namespace-aware `swamp-club#N`, UTC calendar-month
- [x] Doc linking — sitemap cache + explicit path→manual map + confidence
      threshold + source fallback; grouped one card per file, newest first, with
      the period in the heading
- [x] `render` — six HTML pages as `files` **and** to `outputDir`; HTML-escape
      all interpolated text
- [x] Releases kept individually (1:1 with merges — no collapsing)
- [x] Unit tests: event join/dedupe, scoring/ordering, number namespaces, window
      boundaries, doc mapping, CEL-guard round-trip; mocked success **and**
      failure paths; adversarial-content render fixture (HTML injection)

> Implementation note: collected free text is passed through `celEscape` /
> `celUnescapeDeep` (`cel_text.ts`). A real release body documenting
> `${{ env.VAR }}` aborted a run because swamp re-evaluates literal `${{ }}` in
> values flowing between steps.

**Report**

- [x] `swamp_pulse_report.ts` — `@svendowideit/swamp-pulse-summary` (markdown +
      JSON) with tests

**Workflow**

- [x] `swamp-pulse.yaml` — collect → rank → render → publish,
      `trigger.schedule: "0 * * * *"` (hourly)
- [x] `swamp workflow validate @svendowideit/swamp-pulse`

**Pages (release-notes tour style)**

- [x] `index.html` (docs summary, month) + `leaderboard.html` (24h/7d/month) +
      `extensions.html` (registry) + `changes.html` + `releases.html` +
      `issues.html`, all cross-linked
- [x] Tour sections: anchored `<h2 id>` headings, "why it matters" lede, body
      block, 𝗗/𝗣/𝗖𝗟/𝗔 reference row
- [x] Sidebar ToC generated from item anchors; sticky on the detail pages
- [x] Grouped tail sections: _Other notable changes_, _Tooling_, _Hidden gems_
      (partitioned so each tail item appears in exactly one group)
- [x] "New / changed documentation" as the summary page itself, in tour format
      (tier, file, date, repo, manual link, and refs back to the originating Lab
      issue / PR / commit); compact "Docs changed:" line on detail items

**Serving and publishing**

- [x] `scripts/pulse-server.ts` static server (allowlisted paths,
      traversal-safe)
- [x] `ensureServer` method + `ensure-server` workflow step — runs the server as
      a systemd user service via `@svendowideit/systemd-service`; skips with a
      log when absent; `createService`/`startService` failures degrade rather
      than fail the run
- [x] Optional Caddy `ensureDnsProxy` step, skipped unless `publish=caddy`
- [x] Optional GitHub Pages publish step
      (`@svendowideit/github-pages
      publishDir`), skipped unless
      `publish=github-pages`; an assert step fails fast if
      `pagesRepo`/`pagesBranch` are missing

**Quality gate**

- [x] `swamp extension fmt --check`, `quality` (12/12, 100%)
- [x] Adversarial review written to the content-hash path from `push --dry-run`
- [x] Timestamps localized to the viewer's timezone by an in-page script
      (`<time datetime>` + `toLocaleString`); relative wording within 24h
      (`15 mins ago` / `4 hours ago`), absolute beyond, refreshing each minute —
      verified case-by-case in headless Chromium
- [x] Page footer links the extension registry page and shows the generating
      version and last-run time (localized), via shared `EXTENSION_URL` /
      `EXTENSION_VERSION` constants so it cannot drift
- [x] Extension-registry collector (`swamp_ext_registry.ts`) + `extensions.html`
      — new / updated / most-pulled, each linked to its registry page and source
      repo; long list collapsed by default
- [x] Guard polarity corrected on all publish steps (truthy guard = skip; the
      Caddy step had been running on every default run)
- [x] Dry-run push clean; 104 unit tests + live end-to-end workflow run passing

## License

MIT for this extension. `swamp_club.ts` is a fork of `@webframp/swamp-club`,
licensed Apache-2.0 © Sean Escriva; its upstream SPDX header is retained and the
attribution is recorded in `NOTICE`.
