# @svendowideit/github-release-install

Resolve any GitHub repository's latest (or pinned) release, select the archive
for this machine, verify it against the release's checksums, and download a
verified file. It is the reusable core of a binary auto-updater — TUIOS
([`@svendowideit/tuios`](../tuios)) is the worked example.

## What it does

Installing "the latest release" of a tool from GitHub is four separate jobs that
are easy to get subtly wrong: read the release, choose the right asset for this
OS and architecture, find the expected checksum, and refuse to write anything
that does not match. This extension does all four for any repository:

- **`check`** reads the GitHub releases API (latest, or a pinned version),
  probes `uname -s` / `uname -m`, matches the platform against each asset's
  parsed name, and records the selected archive plus its checksum from the
  release's checksums file. The full raw GitHub payload is preserved on the
  resource.
- **`download`** downloads the selected archive, verifies the bytes against that
  checksum, and writes the verified file to a path you choose. It refuses an
  archive with no checksum, or one whose digest does not match.
- **`render`** turns the preserved payload into a Markdown release document —
  title, version, publication time, release notes and an asset table.
- **`print`** logs the resolved version, the platform archive, its checksum, the
  verified file path, and whether it is newer than a version you pass in.

Facts it handles that a naive downloader does not:

- **Publisher naming.** OS/arch match by **family**, so a host probe of
  `Linux`/`x86_64` resolves a publisher that names assets `linux`/`amd64`
  (`caddyserver/caddy`). Any token can be overridden with `os`/`arch`.
- **Checksum variants.** SHA-1, SHA-256, SHA-384 and SHA-512 are all verified,
  the algorithm chosen from the digest length, and a version-prefixed checksums
  file (`caddy_2.11.4_checksums.txt`) is found without extra configuration.
- **Multiple archives per platform.** When a release ships several for one
  platform — tuios publishes `tuios` (main), `tuios-ghostty` and `tuios-web` —
  every match is recorded in preference order and the **base build** is chosen.
  Pass `stem` or `assetName` to select another.

Prefer it over a bare `curl` of a release URL: the download is verified before
it is written, the platform match is explicit and overridable, and one model
serves every repository. The same checksum-verified download pattern
[`@swamp/deno-runner`](https://swamp.club/extensions/@swamp/deno-runner) uses
for Deno is generalised here to any repo, any release, and the tar.gz, zip and
raw archive formats.

Side effects: outbound HTTPS reads from `api.github.com` and the asset download
URLs (nothing is written there); `download` writes one verified file when
`outputPath` is set. Nothing is installed on the host.

## Install

```sh
swamp extension pull @svendowideit/github-release-install
```

No dependencies. Set `GITHUB_TOKEN` (or the `githubToken` global) on machines
that call this often — the releases API allows 60 anonymous requests per hour.

## Configuration

Every global argument below can also be passed **per call with `--input`**, so a
direct type run needs no pre-created model instance:

```sh
swamp model @svendowideit/github-release-install method run check caddy \
  --input repo=caddyserver/caddy
```

That single command auto-creates a definition named `caddy` and runs `check`.
Alternatively `swamp model create … --global-arg …` once and reuse the instance.

### Model globals — `@svendowideit/github-release-install`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `repo` | string | `""` | GitHub repository (`owner/name`) publishing the releases. Required unless `apiUrl` is set. |
| `apiUrl` | string | `""` | Releases API URL. Empty derives it from `repo`. |
| `stem` | string | `""` | Required product name the asset name must carry (`tuios`, `caddy`, `tuios-ghostty`). Empty matches any. |
| `assetPattern` | string | `^(?<stem>…)_(?<version>…)_(?<os>…)_(?<arch>…)(?:\.(?<ext>…))?$` | Regex an archive asset name must match; must define named groups `version`, `os`, `arch` (and optionally `stem`, `ext`). |
| `checksumsName` | string | `checksums.txt` | Name of the release asset listing the digests. A version-prefixed name (e.g. `caddy_2.11.4_checksums.txt`) is also found when this does not match exactly. |
| `format` | `auto` \| `tar.gz` \| `zip` \| `raw` | `auto` | Archive format. `auto` derives it from the file name; a concrete value also **filters asset selection** — use it when a release offers the same platform as more than one format. |
| `githubToken` | string | `""` | Token to raise the API rate limit. Empty falls back to `GITHUB_TOKEN` / `GH_TOKEN`. |
| `userAgent` | string | `swamp-github-release/1.0` | `User-Agent` sent to the GitHub API and asset downloads. |
| `os` | string | `""` | Override the detected OS token (`Linux`, `linux`, `Darwin`, `macos`, …). Family-equivalent tokens all match. Empty probes the host. |
| `arch` | string | `""` | Override the detected architecture token (`x86_64`, `amd64`, `arm64`, `aarch64`, …). Family-equivalent tokens all match. Empty probes the host. |

### Method arguments

| Method | Arguments |
| ------ | --------- |
| `check` | `version`, `os`, `arch`, `stem`, `assetName`, `pattern`, `fetchChecksums` (default `true`), `requireChecksum` (default `true`) |
| `download` | `version`, `outputPath`, `outputDir`, `assetName`, `downloadUrl`, `releaseVersion`, `checksum`, `checksumsUrl`, `os`, `arch`, `stem`, `pattern`, `format`, `requireChecksum` (default `true`), `force` (default `false`) |
| `render` | `includeBody` (default `true`), `includeAssets` (default `true`), `maxBodyChars` (default `0` = full) |
| `print` | `installedVersion` |

Per-call `--input` wins over the model global. `download`'s `assetName` /
`downloadUrl` / `releaseVersion` / `checksum` are the consume-the-check-result
path: a workflow fills them from the `release` resource so `download` does not
re-fetch the release (see the bundled workflow).

### Workflow inputs — `@svendowideit/github-release-install-fetch`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `repo` | string | — (required) | GitHub repository (`owner/name`). |
| `version` | string | `""` | Release to resolve. Empty = latest. |
| `outputPath` | string | `""` | Absolute or `~`-prefixed path for the verified archive. Empty downloads into memory only. |
| `os` / `arch` | string | `""` | Override the detected platform. |
| `stem` | string | `""` | Required asset stem. |
| `assetPattern` | string | `""` | Override the asset-name pattern. Empty uses the model default. |
| `format` | string | `auto` | `auto`, `tar.gz`, `zip` or `raw`. |
| `userAgent` / `githubToken` | string | `""` | Headers/token; empty uses the model default. |
| `download` | boolean | `true` | Set `false` to resolve and checksum only. |
| `force` | boolean | `false` | Re-download even when `outputPath` already matches. |

## Examples

```sh
# One-shot: no model instance to create first. A direct type run with --input
# auto-creates the definition (`rel`) and resolves the release. Use this to see
# what would be downloaded before downloading anything.
swamp model @svendowideit/github-release-install method run check rel \
  --input repo=Gaurav-Gosain/tuios --input stem=tuios

# The equivalent with an explicit instance, so the globals live in a file you
# can edit and version-control.
swamp model create @svendowideit/github-release-install rel2 \
  --global-arg repo=Gaurav-Gosain/tuios --global-arg stem=tuios
swamp model @svendowideit/github-release-install method run check rel2

# Read back the resolved release and its expected checksum.
swamp data get rel release --json

# Download and verify the archive to a path in one workflow run — the common
# path for a caller that will extract or install the verified file next.
swamp workflow run @svendowideit/github-release-install-fetch \
  --input repo=Gaurav-Gosain/tuios --input stem=tuios \
  --input outputPath=~/.cache/tuios/tuios.tar.gz

# Pin a version, and ask what a *different* platform would download without
# touching this machine (useful for cross-platform release checks).
swamp model @svendowideit/github-release-install method run check rel \
  --input version=0.8.0 --input os=Darwin --input arch=arm64

# A lowercase-token publisher (caddy names assets linux/amd64): the host's
# Linux/x86_64 matches by family, and its SHA-512 checksums file is verified.
swamp model @svendowideit/github-release-install method run check caddy \
  --input repo=caddyserver/caddy

# A release with several archives per platform (tuios main + ghostty + web):
# all matches are recorded and the base build is chosen. Pick a variant with
# stem, or an exact file with assetName.
swamp model @svendowideit/github-release-install method run check rel \
  --input stem=tuios-web

# Use a custom asset-name pattern (named groups version/os/arch are required).
# Here an explicit pattern pins the release to Linux/arm64 tar.gz assets; any
# repo whose names differ from the GoReleaser default can be described this way.
swamp model @svendowideit/github-release-install method run check arm \
  --input repo=Gaurav-Gosain/tuios --input os=Linux --input arch=arm64 \
  --input 'assetPattern=^(?<stem>tuios)_(?<version>\d+\.\d+\.\d+)_(?<os>Linux)_(?<arch>arm64)\.(?<ext>tar\.gz)$'

# Download into memory only (no file) and print the summary.
swamp model @svendowideit/github-release-install method run download rel \
  --input outputPath=
swamp model @svendowideit/github-release-install method run print rel \
  --input installedVersion=0.7.0

# Render the release (notes + asset table) into a Markdown document resource,
# then read it back — useful for review summaries and changelog drafting.
swamp model @svendowideit/github-release-install method run render rel
swamp data get rel document --json
```

## Details

### Models, methods and resources

| Model | Method | Produces |
| ----- | ------ | -------- |
| `@svendowideit/github-release-install` | `check` | `release` — tag/version, every asset, the platform's chosen archive and all `candidates`, its download URL, format, expected `checksum`/`checksumAlgorithm` and the raw GitHub `payload`. |
| `@svendowideit/github-release-install` | `download` | `archive` — the verified download: version, archive name, URL, expected checksum, computed digest (`sha256`), `checksumAlgorithm`, whether it verified, format, size and the file path. |
| `@svendowideit/github-release-install` | `render` | `document` — the Markdown release document (`markdown` plus version/tag/body-size/asset-count metadata). |
| `@svendowideit/github-release-install` | `print` | `summary` — the logged release/archive and update availability. |

### Workflow — `@svendowideit/github-release-install-fetch`

Steps: `resolve → download → render → print`.

- `resolve` (`check`) is the only writer of `release`; `download` is the only
  writer of `archive`; `render` of `document`; `print` of `summary`. One writer
  per resource per run keeps `data.latest(...)` unambiguous.
- `download` consumes `resolve`'s `release` via CEL (`archiveName`,
  `downloadUrl`, `version`, `checksum`), so the release is fetched once.
- `render` turns the preserved payload into Markdown; skip it with
  `render=false`. `download=false` skips the download step and leaves only the
  resolved release.

### Structure and extending

- `github_release.ts` — the pure helpers and the network calls (`fetchRelease`,
  `fetchChecksums`, `downloadAndVerify`) plus `renderReleaseMarkdown`:
  asset-name parsing/building, archive-format detection, family-aware asset
  selection (`selectAssets`), multi-algorithm checksum parsing, URL derivation
  and platform mapping. Everything both the model and its tests need lives here.
- `github_release_install.ts` — the model. `check` resolves and preserves the
  payload, `download` fetches and verifies (reusing a file already at
  `outputPath` when it matches, unless `force`), `render` produces the Markdown
  document, `print` summarises.
- `github-release-install-fetch.yaml` — the bundled workflow (created with
  `swamp workflow create`; do not hand-edit its `id`).
- `github_release_test.ts` / `github_release_install_methods_test.ts` — pure and
  execute-level tests; the latter drive the real methods through
  `createModelTestContext` with the network stubbed by `withMockedFetch` and
  `uname` by `withMockedCommand`.

To support a publisher whose asset names differ, pass an `assetPattern` with
named groups `version`, `os`, `arch` (and optionally `stem`, `ext`) — no code
change is needed. To add an archive format, extend `ARCHIVE_TYPES` and
`detectArchiveType`.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/github-release-install/github_release_test.ts \
  extensions/models/github-release-install/github_release_install_methods_test.ts

~/.swamp/deno/deno check \
  extensions/models/github-release-install/github_release.ts \
  extensions/models/github-release-install/github_release_install.ts
```

### Caveats

- `download` returns verified bytes; it does not extract or install them.
  Extraction is the caller's job (see `@svendowideit/tuios`).
- The default pattern expects GoReleaser naming (`tool_<version>_<Os>_<arch>`).
  OS/arch tokens match by family (`Linux`↔`linux`, `x86_64`↔`amd64`), but a repo
  that orders or names the parts differently still needs an `assetPattern`.
- A release with several archives for one platform picks the base build; the
  full list is on `platform.candidates`. A variant needs `stem`/`assetName`.
- A release with no checksums file, or one that does not list the selected
  archive, fails `check` (pass `requireChecksum=false` to record it unverified),
  and `download` refuses to write an unverified archive.

### How TUIOS uses this

TUIOS publishes three archives per platform: `tuios` (the main build),
`tuios-ghostty` (bundles libghostty-vt) and `tuios-web` (the web server). This
extension records all three as `candidates` and selects `tuios` — the base
build — which is what `@svendowideit/tuios`'s installer expects. To install the
ghostty variant, pass `stem=tuios-ghostty` (which the tuios workflow does from
its `flavor` input).

## License

MIT — see LICENSE.txt.
