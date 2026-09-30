# @svendowideit/github-release-install

Resolve any GitHub repository's latest (or pinned) release, select the archive
for this machine, verify it against the release's checksums, and download a
verified file. It is the reusable core of a binary auto-updater — TUIOS
([`@svendowideit/tuios`](../tuios)) is the worked example.

## What it does

Installing "the latest release" of a tool from GitHub is four separate jobs that
are easy to get subtly wrong: read the release, choose the right asset for this
OS and architecture, find the expected SHA-256, and refuse to write anything
that does not match. This extension does all four for any repository:

- **`check`** reads the GitHub releases API (latest, or a pinned version),
  probes `uname -s` / `uname -m`, matches the platform against each asset's
  parsed name, and records the selected archive plus its SHA-256 from the
  release's `checksums.txt`.
- **`download`** downloads the selected archive, verifies the bytes against that
  SHA-256, and writes the verified file to a path you choose. It refuses an
  archive with no checksum, or one whose hash does not match.
- **`print`** logs the resolved version, the platform archive, its SHA-256, the
  verified file path, and whether it is newer than a version you pass in.

Prefer it over a bare `curl` of a release URL: the download is verified before
it is written, the platform match is explicit and overridable, and one model
serves every repository that follows the common GoReleaser asset naming. The
same checksum-verified download pattern [`@swamp/deno-runner`](https://swamp.club/extensions/@swamp/deno-runner)
uses for Deno is generalised here to any repo, any release, and the tar.gz, zip
and raw archive formats.

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

### Model globals — `@svendowideit/github-release-install`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `repo` | string | `""` | GitHub repository (`owner/name`) publishing the releases. Required unless `apiUrl` is set. |
| `apiUrl` | string | `""` | Releases API URL. Empty derives it from `repo`. |
| `stem` | string | `""` | Required product name the asset name must carry (`tuios`, `tuios-ghostty`). Empty matches any. |
| `assetPattern` | string | `^(?<stem>…)_(?<version>…)_(?<os>…)_(?<arch>…)(?:\.(?<ext>…))?$` | Regex an archive asset name must match; must define named groups `version`, `os`, `arch` (and optionally `stem`, `ext`). |
| `checksumsName` | string | `checksums.txt` | Name of the release asset listing every archive's SHA-256. |
| `format` | `auto` \| `tar.gz` \| `zip` \| `raw` | `auto` | Archive format; `auto` derives it from the file name. |
| `githubToken` | string | `""` | Token to raise the API rate limit. Empty falls back to `GITHUB_TOKEN` / `GH_TOKEN`. |
| `userAgent` | string | `swamp-github-release/1.0` | `User-Agent` sent to the GitHub API and asset downloads. |
| `os` | string | `""` | Override the detected release OS token (`Linux`, `Darwin`, …). Empty probes the host. |
| `arch` | string | `""` | Override the detected architecture token (`x86_64`, `arm64`, …). Empty probes the host. |

### Method arguments

| Method | Arguments |
| ------ | --------- |
| `check` | `version`, `os`, `arch`, `stem`, `assetName`, `pattern`, `fetchChecksums` (default `true`), `requireChecksum` (default `true`) |
| `download` | `version`, `outputPath`, `assetName`, `downloadUrl`, `releaseVersion`, `checksum`, `checksumsUrl`, `os`, `arch`, `stem`, `pattern`, `format`, `requireChecksum` (default `true`), `force` (default `false`) |
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
# Resolve a repository's latest release and record this machine's archive.
# Use this to see what would be downloaded before downloading anything.
swamp model create @svendowideit/github-release-install rel \
  --global repo=Gaurav-Gosain/tuios --global stem=tuios
swamp model @svendowideit/github-release-install method run check rel

# Read back the resolved release and its expected SHA-256.
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

# Resolve a repo that does not use the GoReleaser naming, with a custom
# pattern whose named groups are version/os/arch.
swamp model create @svendowideit/github-release-install other \
  --global repo=acme/tool \
  --global 'assetPattern=^(?<stem>.+)-(?<version>\d+\.\d+\.\d+)-(?<os>linux|darwin)-(?<arch>amd64|arm64)(?<ext>)?$'
swamp model @svendowideit/github-release-install method run check other

# Download into memory only (no file) and print the summary.
swamp model @svendowideit/github-release-install method run download rel \
  --input outputPath=
swamp model @svendowideit/github-release-install method run print rel \
  --input installedVersion=0.7.0
```

## Details

### Models, methods and resources

| Model | Method | Produces |
| ----- | ------ | -------- |
| `@svendowideit/github-release-install` | `check` | `release` — tag/version, every asset, the platform's archive, its download URL, format and expected SHA-256. |
| `@svendowideit/github-release-install` | `download` | `archive` — the verified download: version, archive name, URL, expected checksum, computed sha256, whether it verified, format, size and the file path. |
| `@svendowideit/github-release-install` | `print` | `summary` — the logged release/archive and update availability. |

### Workflow — `@svendowideit/github-release-install-fetch`

Steps: `resolve → download → print`.

- `resolve` (`check`) is the only writer of `release`; `download` is the only
  writer of `archive`; `print` is the only writer of `summary`. One writer per
  resource per run keeps `data.latest(...)` unambiguous.
- `download` consumes `resolve`'s `release` via CEL (`archiveName`,
  `downloadUrl`, `version`, `checksum`), so the release is fetched once.
- `download=false` skips the download step and leaves only the resolved release.

### Structure and extending

- `github_release.ts` — the pure helpers and the two network calls
  (`fetchRelease`, `fetchChecksums`, `downloadAndVerify`): asset-name
  parsing/building, archive-format detection, asset selection, checksum and
  version parsing, URL derivation, platform mapping and SHA-256. Everything both
  the model and its tests need lives here.
- `github_release_install.ts` — the model. `check` resolves, `download` fetches
  and verifies (reusing a file already at `outputPath` when it matches, unless
  `force`), `print` summarises.
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
  A repo that names assets differently needs an `assetPattern`.
- A release with no checksums file, or one that does not list the selected
  archive, fails `check` (pass `requireChecksum=false` to record it unverified),
  and `download` refuses to write an unverified archive.

## License

MIT — see LICENSE.txt.
