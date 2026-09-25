# @svendowideit/github-pages

## What it does

Publish a local directory (and its subdirectories) to a GitHub repository's
GitHub Pages site, and idempotently set up Pages itself, using the GitHub REST
API. No `gh-pages` npm package, no extra checkout, no action runner required —
swamp commits straight to the Pages branch through the Git Data API.

Two problems this solves:

1. **Publishing a directory is awkward.** The common answer is a third-party
   tool or a GitHub Action. This extension walks a directory, hashes each file
   as a git blob locally, uploads only the blobs that actually changed, and
   creates a single commit — so re-running it is cheap and safe.
2. **Setting up Pages is a one-way manual step.** This extension reconciles the
   Pages site configuration (source branch, source path, build type, custom
   domain, HTTPS enforcement) via `GET` + `POST`/`PUT`, so running it twice is a
   no-op.

Side effects: it creates/updates the Pages site and commits to the target
repository's Pages branch over the API; it writes the `site`, `publish` and
`sync` resources. Nothing is installed on the host.

## Install

```sh
swamp extension pull @svendowideit/github-pages
```

The extension shells out to the `gh` CLI for authentication by default, so
`gh auth login` must have been run. A token can instead be supplied via the
`authToken` global argument or the `GH_TOKEN`/`GITHUB_TOKEN` environment
variables.

## Configuration

Global arguments (all optional):

| Global argument  | Default                                       | Description                                                      |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `repo`           | inferred from git origin                      | `owner/name`.                                                    |
| `branch`         | `gh-pages`                                    | Branch Pages serves from.                                        |
| `pagesPath`      | `/`                                           | Source path within the branch (`/` or `/docs`).                  |
| `buildType`      | `legacy`                                      | `legacy` (build from branch) or `workflow` (Actions).            |
| `cname`          | unset                                         | Custom domain. Pass `null` to `ensureSite` to remove one.        |
| `httpsEnforced`  | `true`                                        | Enforce HTTPS on the Pages site.                                 |
| `authToken`      | unset                                         | Token; otherwise `gh auth token`, `GH_TOKEN`, or `GITHUB_TOKEN`. |
| `apiBase`        | `https://api.github.com`                      | Override for GitHub Enterprise.                                  |
| `gitAuthorName`  | `swamp-github-pages`                          | Commit author name.                                              |
| `gitAuthorEmail` | `swamp-github-pages@users.noreply.github.com` | Commit author email.                                             |
| `commitMessage`  | `Publish site via swamp`                      | Commit message.                                                  |

Per-run overrides: `dir`, `prune` and `dryRun` on `publishDir`; `files` on
`publishFiles`; `cname` on `ensureSite`.

## Examples

Create a model, configure the repository, ensure Pages, then publish a
directory:

```sh
# Create a model for the target repository
swamp model create @svendowideit/github-pages my-site \
  --global repo=owner/repo \
  --global branch=gh-pages

# Idempotently configure Pages to serve gh-pages at /
swamp model method run my-site ensureSite

# Publish ./dist (recursively) as one commit
swamp model method run my-site publishDir --input dir=./dist

# Preview what would change without committing
swamp model method run my-site publishDir --input dir=./dist --input dryRun=true
```

Publishing to `main:/docs` instead is a configuration change, not a code change:

```sh
swamp model create @svendowideit/github-pages docs-site \
  --global repo=owner/repo \
  --global branch=main \
  --global pagesPath=/docs
swamp model method run docs-site ensureSite
swamp model method run docs-site publishDir --input dir=./site --input prune=true
```

Publish an explicit set of files with rewritten repository paths:

```sh
swamp model method run my-site publishFiles \
  --input 'files=[{"source":"./news.html","repoPath":"news/index.html"}]'
```

## Details

`@svendowideit/github-pages` ships one model type
(`@svendowideit/github-pages`) with four methods:

| Method         | Description                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `ensureSite`   | Idempotently create or update the Pages site (source, build type, CNAME, HTTPS enforcement).     |
| `publishDir`   | Recursively publish a directory as a single commit; `prune` deletes remote files absent locally. |
| `publishFiles` | Publish an explicit list of files, optionally remapped to repository paths.                      |
| `syncSite`     | Read the live Pages site + latest build into a drift snapshot.                                   |

### How it works

- **Blob reuse.** Each local file is hashed with SHA-1 as a git blob
  (`sha1("blob <len>\0" + content)`). Files whose hash matches the remote tree
  are not uploaded. If every file matches and nothing is pruned, no commit is
  created at all.
- **Atomic commit.** Changed blobs are uploaded, a tree is built from the
  previous tree plus the delta, and a commit is created and pointed at the
  branch. `publishDir` never does a local `git` operation.
- **Branch seeding.** If the target branch does not exist, it is seeded from the
  repository's default branch, so the first publish works on a fresh repo.
- **Traversal safety.** `..` path segments are rejected and symlinks are
  skipped, so a site directory cannot publish files outside its own tree.
- **Transient failures.** 429, 5xx, and secondary rate-limit 403 responses are
  retried with exponential backoff.

### Output data

Each method writes a versioned resource that can be referenced from other models
with CEL:

```yaml
# The commit SHA of the last publish
sha: ${{ data.latest("my-site", "publish").attributes.commitSha }}
# Whether the last ensureSite changed anything
changed: ${{ data.latest("my-site", "site").attributes.changed }}
```

`publish` records `added`/`modified`/`deleted`/`unchanged` counts and a per-file
list with statuses; `sync` records the live site status and latest build status.

### Requirements

- The token needs `repo` scope (classic PAT) or `Contents: read/write` +
  `Pages: read/write` (fine-grained PAT).
- Network access to `api.github.com` (or the configured `apiBase`).

### Extending and testing

The model lives in `github_pages.ts`; `github_pages_test.ts` exercises the pure
helpers (blob hashing, path safety, tree building, API reconciliation) with the
`gh`/HTTP layer stubbed.

```sh
# Type-check and run the unit tests.
~/.swamp/deno/deno check github_pages.ts
~/.swamp/deno/deno test --allow-read --allow-env github_pages_test.ts
```

## License

MIT — see LICENSE for details.

