# @svendowideit/swamp-pulse

A leaderboard-style activity dashboard for the swamp project itself.

Swamp Pulse tracks three streams of work — **swamp-club Lab issues**, **GitHub
commits**, and **GitHub releases** — across `swamp-club/swamp` and
`swamp-club/swamp-extensions`. Because a release, its commit and its PR are the
same event, the streams are **joined into one merged item per change** rather
than listed three times. Each item is ranked by a synthesized significance
hierarchy, and the result is rendered as four linked static HTML pages: three
detail pages (changes, releases, issues) and one summary page styled after the
swamp-club leaderboard, with 24-hour / 7-day / current-month windows.

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

Configurable global arguments on the pulse model: `repos` (default
`["swamp-club/swamp", "swamp-club/swamp-extensions"]`), `swampClubUrl` (default
`https://swamp-club.com`), `outputDir` (default `~/.swamp/swamp-pulse`),
`manualBaseUrl` (default `https://swamp-club.com/manual`), `windows`
(`["24h", "7d", "month"]`), scoring weights, and the optional `pagesRepo` /
`pagesBaseUrl` for git-pages publishing.

## Run

```sh
# Collect → rank → render in one DAG (the scheduled path).
swamp workflow run @svendowideit/swamp-pulse

# Or run the stages individually.
swamp model @svendowideit/swamp-pulse method run rank pulse
swamp model @svendowideit/swamp-pulse method run render pulse
```

Optional inputs: `repos` (array, overrides the default), `windows` (array),
`outputDir` (per-run output location), `publish` (`false` | `caddy` | `git`).

```sh
swamp workflow run @svendowideit/swamp-pulse --input publish=caddy
```

### Where the generated HTML goes

All four pages land in one user-global directory so they survive repo moves and
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
(_Other notable changes_, _Tooling_, _Hidden gems_, _Final thoughts_). The
summary page is the leaderboard view — it links into the tour anchors on the
detail pages rather than repeating the sections.

### New / changed documentation

Documentation changes get their own section at the bottom of the **summary
page**, in the same tour format as everything else: each entry shows its
significance tier, the changed file (linked to the exact source at that commit's
SHA), the parent change's title, the **date**, the repository, a link to the
published manual page (or an explicit "no published page"), and a reference row
back to the **originating Lab issue**, PR and commit.

Where a change's release body says which issue it closes (`Closes lab#N`), that
issue is linked in preference to any incidental mention — a commit often cites a
context issue before the one it actually resolves. Detail pages additionally
show a compact "Docs changed:" line on each affected item.

All interpolated text (commit titles, release bodies, issue bodies) is
**HTML-escaped**; release and issue bodies are rendered as sanitised text with
fenced code preserved. This is a tested requirement, not an afterthought.

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
- `collect_doc_changes { repos, since, until, maxCommits, maxFiles }` — filters
  each repo's commits to **doc-suspect** ones by message, then fetches their
  changed files via the single-commit endpoint. (`/commits` list results omit
  `files`; verified.)
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

1. **Source** — `https://github.com/<repo>/blob/<sha>/<path>` (always
   available).
2. **Manual** — the matching `swamp-club.com/manual/...` page, from a cached
   `sitemap.xml` plus an explicit **path→manual map** for known areas (e.g.
   `design/enablers/datastores.md` →
   `/manual/reference/datastore-configuration`). Fuzzy slug matches carry a
   confidence flag and are only linked above a threshold; below it, the source
   link is the sole link (never guess a manual page).

Whole-window changed files come from one `compare` API call per repo (verified:
returns the file list for a ref range); per-commit file lists are fetched only
for doc-suspect commits, bounded by a cap.

## Serving and publishing

Serving is a **workflow step** (`ensure-server`) backed by the pulse model's
`ensureServer` method; publishing is a separate optional step. All of it is
optional and degrades gracefully.

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

It serves the four allowlisted pages (`/`, `/changes.html`, `/releases.html`,
`/issues.html`) plus `/healthz`, and rejects path traversal.

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

### Publish to a git repository (optional)

**Not yet implemented.** Planned: clone the configured `pagesRepo` via
`@swamp/git`, write the four HTML files, commit and push. Requires push
credentials on the runner.

## Models

| Type                                | Purpose                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@svendowideit/swamp-pulse`         | Merges collected data, ranks it (tier-then-recency), renders the four HTML pages, and ensures the static server runs. |
| `@svendowideit/swamp-club`          | Vendored Lab adapter — anonymous-capable Lab issue search.                                                            |
| `@webframp/github` (extended)       | Upstream GitHub type, extended here with commit and body-inclusive release methods.                                   |
| `@svendowideit/swamp-pulse-summary` | Report extension — markdown + JSON run summary (counts per window, top-ranked items, doc links).                      |

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
   and writes all four pages
7. **ensure-server** — `@svendowideit/swamp-pulse ensureServer`, idempotently
   runs `scripts/pulse-server.ts` as a systemd user service via
   `@svendowideit/systemd-service` (`allowFailure`; skips with a log if absent)
8. **publish-caddy** — optional Caddy `ensureDnsProxy` pointing at the server
   (`allowFailure`, guarded to `publish=caddy`)

## Design notes

- **Direct HTTP, not the CLI.** A model method cannot call `swamp issue search`
  — it holds the per-model lock and would deadlock. Lab issues are fetched from
  `GET /api/v1/lab/issues` directly (in the vendored fork).
- **Incremental, not full re-fetch.** The pulse store persists a per-repo/per-
  source cursor; each run fetches only what is new since the cursor (with a
  bounded overlap) and merges into a rolling window store. This keeps API volume
  flat instead of re-pulling the whole month every hour.
- **Bounded GitHub API use.** Per-commit file lists are fetched only for
  doc-suspect commits, with a hard cap; whole-window doc changes use one
  `compare` call per repo.
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
      threshold + source fallback
- [x] `render` — four HTML pages as `files` **and** to `outputDir`; HTML-escape
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

- [x] `index.html` summary + `changes.html` + `releases.html` + `issues.html`,
      all cross-linked
- [x] Tour sections: anchored `<h2 id>` headings, "why it matters" lede, body
      block, 𝗗/𝗣/𝗖𝗟/𝗔 reference row
- [x] Sidebar ToC generated from item anchors; sticky on the detail pages
- [x] Grouped tail sections: _Other notable changes_, _Tooling_, _Hidden gems_
      (partitioned so each tail item appears in exactly one group)
- [x] "New / changed documentation" section on the summary page, in tour format
      (tier, file, date, repo, manual link, and refs back to the originating Lab
      issue / PR / commit); compact "Docs changed:" line on detail items

**Serving and publishing**

- [x] `scripts/pulse-server.ts` static server (allowlisted paths,
      traversal-safe)
- [x] `ensureServer` method + `ensure-server` workflow step — runs the server as
      a systemd user service via `@svendowideit/systemd-service`; skips with a
      log when absent; `createService`/`startService` failures degrade rather
      than fail the run
- [x] Optional Caddy `ensureDnsProxy` step, guarded to `publish=caddy` and
      `allowFailure`
- [ ] Optional git-pages push job (documented credentials) — remaining work

**Quality gate**

- [x] `swamp extension fmt --check`, `quality` (12/12, 100%)
- [x] Adversarial review written to the content-hash path from `push --dry-run`
- [x] Dry-run push clean; 78 unit tests + live end-to-end workflow run passing

## License

MIT for this extension. `swamp_club.ts` is a fork of `@webframp/swamp-club`,
licensed Apache-2.0 © Sean Escriva; its upstream SPDX header is retained and the
attribution is recorded in `NOTICE`.
