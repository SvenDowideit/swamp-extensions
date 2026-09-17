# @svendowideit/swamp-pulse

A leaderboard-style activity dashboard for the swamp project itself.

Swamp Pulse tracks three streams of work — **swamp-club Lab issues**, **GitHub
commits**, and **GitHub releases** — across `swamp-club/swamp` and
`swamp-club/swamp-extensions`, ranks every item by a synthesized significance
hierarchy, and renders four linked static HTML pages: three detail pages
(changes, releases, issues) and one summary page styled after the swamp-club
leaderboard, with 24-hour / 7-day / current-month windows.

Every commit, release and issue entry links back to its source, and any commit
that touches documentation produces a **"New / changed documentation"** link to
both the published manual page (when one can be matched) and the exact source
file at that commit's SHA.

## Presentation: release-notes tour style

The detail pages follow the **interactive release-notes tour** format
popularised by the [VictoriaMetrics Go 1.27 tour](https://victoriametrics.com/blog/go-1-27/)
(itself continuing Anton Zhiyanov's `antonz.org` Go tours). Rather than dumping
a flat commit log, Pulse renders each notable item as a self-contained tour
section, so a reader can skim what changed and how it matters without reading
the raw history.

Each item is presented as:

- **A headline section with an anchor** (`<h2 id="…">`) and a sidebar
  table of contents, so every change is directly linkable and the page can be
  skimmed by heading.
- **A one-line "why it matters" lede** — the plain-language context, the way the
  tour opens each release note before showing code.
- **A short excerpt or example**, in a fenced/`<pre>` block with the rendered
  result beneath it (the tour's "code then output" pattern). For a commit this
  is the diff summary or the changed signature; for an issue it is the reported
  symptom; for a release it is the highlight of the body.
- **A trailing reference row** of labelled links in the tour's convention —
  **𝗗** docs/manual, **𝗣** the issue or proposal number, **𝗖𝗟** the commit SHA,
  **𝗔** the author — for each feature discussed.
- **Grouped tail sections** — *Other notable changes*, *Tooling*, *Hidden gems*
  (the lower-significance C-tier items), and *Final thoughts* (the window's
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

# The upstream GitHub extension it extends, plus the collective it lives in.
swamp extension pull @webframp/github
swamp extension trust add webframp
```

The `swamp-pulse` model instance is auto-registered on the first workflow run —
no manual `swamp model create` needed.

## Configure

Pulse reads public data by default. The swamp-club Lab issue API accepts an
optional `x-api-key`; without one you get the public issue list (types, status,
authors, timestamps). With one you also get the same view the CLI sees. Store it
in a vault and reference it:

```sh
swamp vault put my-vault swamp-club-api-key   # prompts for the value
```

Then set it in the instance's `globalArguments`:

```yaml
apiKey: ${{ vault.get('my-vault', 'swamp-club-api-key') }}
```

`apiKey` is **sensitive** — swamp rejects it as a literal value, so the vault
reference is required if you set it at all. Leave it unset to use the public
API.

Configurable global arguments: `repos` (default
`["swamp-club/swamp", "swamp-club/swamp-extensions"]`), `swampClubUrl`
(default `https://swamp-club.com`), `outputDir` (default
`~/.swamp/swamp-pulse`), `manualBaseUrl` (default `https://swamp-club.com/manual`),
`windows` (`["24h", "7d", "month"]`), scoring weights, and the optional
`pagesRepo` / `pagesBaseUrl` for git-pages publishing.

## Run

```sh
# Collect, rank, and render everything in one execution (the scheduled path).
swamp workflow run @svendowideit/swamp-pulse

# Or run the stages individually.
swamp model @svendowideit/swamp-pulse method run generate pulse
```

Optional inputs: `repos` (array, overrides the default), `windows` (array),
`outputDir` (per-run output location), `publish` (`false` | `caddy` | `git`).

```sh
swamp workflow run @svendowideit/swamp-pulse --input publish=caddy
```

### Where the generated HTML goes

All four pages land in one user-global directory so they survive repo moves and
`swamp serve`'s working-directory changes:

| Page             | Path                                |
|------------------|-------------------------------------|
| Summary          | `~/.swamp/swamp-pulse/index.html`   |
| Commits/changes  | `~/.swamp/swamp-pulse/changes.html` |
| Releases         | `~/.swamp/swamp-pulse/releases.html`|
| Lab issues       | `~/.swamp/swamp-pulse/issues.html`  |

Override with `outputDir` (model global arg or per-run input).

### Page layout (tour format)

Each of the three detail pages is a tour: a sticky sidebar ToC built from the
item anchors, tour sections in rank order, then the grouped tail sections
(*Other notable changes*, *Tooling*, *Hidden gems*, *Final thoughts*). The
summary page is the leaderboard view — it links into the tour anchors on the
detail pages rather than repeating the sections. A shared
`"New / changed documentation"` block is rendered on all four.

## How items are ranked

Pulse does not replicate the swamp-club user-activity leaderboard. It ranks the
tracked **work items** (issues, commits, releases) on a synthesized importance
hierarchy, falling back to recency when there is no stronger signal. Each ranked
item records a human-readable `rationale`.

| Tier | Signal |
|------|--------|
| **S** | Security issue shipped; release announcing a breaking change; commit fixing a security-labelled issue |
| **A** | Shipped bug/feature; non-patch release; `feat:` commit; docs updated alongside a fix |
| **B** | `in_progress`/`triaged` issues; `fix:`/`perf:` commits; patch release |
| **C** | Open issues; `docs:`/`refactor:`/`chore:` commits; prereleases |

The final score is `base_importance × recency_decay × corroboration_bonus`.
Recency decay uses a per-window half-life (24h → 12h, 7d → 3d, month → 10d), and
corroboration boosts items cross-referenced across sources — a commit message
mentioning `#2264`, a release body mentioning it, and the issue itself moving to
`shipped` compound into one higher-ranked story.

> Note on the month window: swamp-club's public leaderboard only exposes 24-hour,
> 7-day and all-time boards. The 24h and 7d Pulse windows can therefore be
> cross-checked against the real boards, but the **current month** window is
> derived entirely from Pulse's own collected activity — there is no upstream
> month board.

## Documentation links

For every changed path ending in `.md` (plus `design/**`, `README*`), Pulse
emits two links:

1. **Source** — `https://github.com/<repo>/blob/<sha>/<path>` (always available).
2. **Manual** — the closest `swamp-club.com/manual/...` page, matched from a
   cached `sitemap.xml` by slug similarity; the source link is the fallback when
   no page matches.

## Publishing

`publish` accepts three modes, all optional:

- **local** (always) — files written to `outputDir`.
- **caddy** — when [`@svendowideit/caddy`](https://github.com/svendowideit/swamp-extensions)
  is installed, ensure a reverse proxy to a small static server
  (`scripts/pulse-server.ts`, modelled on the news feedback server). Skipped with
  a log when Caddy is absent.
- **git** — clone `pagesRepo` via `@swamp/git`, write the four HTML files,
  commit and push.

## Models

| Type | Purpose |
|---|---|
| `@svendowideit/swamp-pulse` | Collects commits, releases and Lab issues; ranks them; renders the four HTML pages. |
| `@svendowideit/swamp-pulse-summary` | Report extension — markdown + JSON summary of a run (counts per window, top-ranked items, doc links). |

The model extends the upstream GitHub type rather than shelling out:

| Extension file | Target type | Adds |
|---|---|---|
| `github_commits.ts` | `@webframp/github` | `list_commits`, `list_commit_files` + `commits` / `commitFiles` resources |
| `lab_issues.ts` | `@webframp/swamp-club` | `search_lab_issues` + `labIssues` resource |

## Workflows

### `swamp-pulse` (every 6 hours)

1. **generate** — collect commits, commit files (doc-suspect commits only),
   releases and Lab issues for the union window; normalize; rank; link docs;
   render all four HTML pages.
2. **publish** — optionally stand up the Caddy proxy and/or push to git pages.

## Design notes

- **Direct HTTP, not the CLI.** A model method cannot call `swamp issue search`
  — it holds the per-model lock and would deadlock. Lab issues are fetched from
  `GET /api/v1/lab/issues` directly.
- **Bounded GitHub API use.** Per-commit file lists are fetched only for
  commits whose message looks doc-related, with a hard cap, to keep request
  volume predictable.
- **Unofficial endpoint.** The Lab issue API is not a published contract;
  access is isolated in `lab_issues.ts` so it can be adapted in one place.

## Implementation plan

Work-in-progress checklist — tick items off as they land.

**Scaffold**
- [ ] `manifest.yaml` (`paths.base: manifest`, README + LICENSE in `additionalFiles`, `dependencies: ["@webframp/github", "@webframp/swamp-club"]`)
- [ ] `LICENSE.txt`
- [ ] Register this directory in `.swamp-sources.yaml`

**Data sources**
- [ ] `github_commits.ts` — `export const extension` targeting `@webframp/github`; `list_commits { repo, since, until, max }`
- [ ] `list_commit_files { repo, sha }`, gated to doc-suspect commits + hard cap
- [ ] `lab_issues.ts` — `export const extension` targeting `@webframp/swamp-club`; `search_lab_issues { since, until, type?, status?, limit }` (paginated)
- [ ] Verify registration with `swamp model type search`
- [ ] `~/.swamp/deno/deno check` + unit tests for both

**Model**
- [ ] `swamp_pulse.ts` — `@svendowideit/swamp-pulse` global args (`repos`, `swampClubUrl`, `apiKey` sensitive, `outputDir`, `manualBaseUrl`, `windows`, scoring weights, `pagesRepo`, `pagesBaseUrl`)
- [ ] Resources: `commits`, `releases`, `labIssues`, `docChanges`, `ranked`, `summary`
- [ ] `collect` — fan-out fetch across repos/issues, union window, UTC month boundary
- [ ] `rank` — significance tiers + recency decay + corroboration; emit `rationale`
- [ ] Doc linking — sitemap cache, manual slug match, source-link fallback
- [ ] `render` — four HTML pages as `files` **and** to `outputDir`
- [ ] `generate` — `collect → rank → render`
- [ ] `publish` — local / caddy / git modes
- [ ] Scoring, window and doc-mapping unit tests; fixture-based render test (no network)

**Report**
- [ ] `swamp_pulse_report.ts` — `@svendowideit/swamp-pulse-summary` (markdown + JSON)

**Workflow**
- [ ] `swamp-pulse.yaml` — `generate → publish`, `trigger.schedule: "0 */6 * * *"`
- [ ] `swamp workflow validate @svendowideit/swamp-pulse`

**Pages (release-notes tour style)**
- [ ] `index.html` summary + `changes.html` + `releases.html` + `issues.html`, all cross-linked
- [ ] Tour sections: anchored `<h2 id>` headings, "why it matters" lede, excerpt/output block, 𝗗/𝗣/𝗖𝗟/𝗔 reference row
- [ ] Sidebar ToC generated from item anchors; sticky on the detail pages
- [ ] Grouped tails: *Other notable changes*, *Tooling*, *Hidden gems*, *Final thoughts*
- [ ] "New / changed documentation" section on every page

**Publishing**
- [ ] `scripts/pulse-server.ts` static server (news feedback-server pattern)
- [ ] Optional Caddy `ensureDnsProxy` + systemd-service steps (`allowFailure`)
- [ ] Optional git-pages push job

**Quality gate**
- [ ] `swamp extension fmt --check`, `quality`, version bump + upgrade entry
- [ ] Adversarial review written to the content-hash path from `push --dry-run`
- [ ] Dry-run push, then publish

## License

MIT
