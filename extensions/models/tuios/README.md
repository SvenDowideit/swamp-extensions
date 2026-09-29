# @svendowideit/tuios

Keep [TUIOS](https://tuios.dev) current and always-on. Two models track the
latest TUIOS release and what is installed on this machine, one of them can
download, verify and install the binary, and one bundled workflow wires it all
together and hands the daemon to systemd so sessions survive logout and reboot.

## What it does

TUIOS is a terminal window manager whose sessions live in a background daemon.
This extension answers the three questions you actually have about it, on any
machine you run swamp on:

- **What is the latest release, and what should this machine download?** The
  `tuios-release` model reads the GitHub releases API and probes the local OS
  and architecture (`uname -s` / `uname -m`), maps them to the release's
  GoReleaser tokens, selects the matching archive, and records its SHA-256 from
  the release's `checksums.txt`.
- **What is installed right now?** The `tuios-installed` model finds the
  `tuios` binary, runs `tuios --version`, and records the version, the VT
  backend and the resolved path.
- **How do I install or upgrade it, and keep it running?** The `install`
  method downloads the platform archive, verifies it against the checksum, and
  atomically installs the binary. The bundled workflow runs the whole loop and
  starts a `tuios daemon` systemd *user* service so sessions are always
  available.

Side effects: outbound HTTPS reads from `api.github.com`,
`github.com/…/releases/download/…` and `raw.githubusercontent.com` (nothing is
written there); the `install` method writes a binary into `/usr/local/bin`,
`~/.local/bin` or `~/bin`; the workflow writes a systemd user unit and enables
lingering when `manageService` is true.

## Install

```sh
swamp extension pull @svendowideit/tuios
```

The declared dependency `@svendowideit/systemd-service` is pulled automatically.

## Configuration

### Workflow inputs — `@svendowideit/tuios-install`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `installDir` | string | `""` | Where to install the `tuios` binary. Empty auto-picks the first writable of `/usr/local/bin`, `~/.local/bin`, `~/bin`. |
| `version` | string | `""` | Release to install (`0.8.0` or `v0.8.0`). Empty installs the latest. |
| `flavor` | `std` \| `ghostty` | `std` | `std` is the pure-Go emulator; `ghostty` bundles libghostty-vt (Linux/Windows only). |
| `force` | boolean | `false` | Reinstall even when the target version is already present, and rewrite the systemd unit even if it matches. |
| `manageService` | boolean | `true` | Create and start a systemd user service running the TUIOS daemon. |
| `serviceName` | string | `tuios` | systemd user service name (without `.service`). |

### `tuios-release` global arguments

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `flavor` | `std` \| `ghostty` | `std` | Build flavor to track. |
| `repo` | string | `Gaurav-Gosain/tuios` | GitHub repository publishing the releases. |
| `apiUrl` | string | GitHub `releases/latest` URL | Releases API endpoint. |
| `userAgent` | string | `swamp-tuios/1.0` | `User-Agent` sent to the GitHub API. |
| `githubToken` | string | `""` | GitHub token to raise the API rate limit. Empty falls back to `GITHUB_TOKEN` / `GH_TOKEN`. |
| `os` | string | `""` | Override the detected release OS token (`Linux`, `Darwin`, …). Empty probes the host. |
| `arch` | string | `""` | Override the detected architecture token (`x86_64`, `arm64`, …). Empty probes the host. |

### `tuios-installed` global arguments

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `path` | string | `""` | Path to the `tuios` binary. Empty auto-detects from `PATH` and the usual install locations. |
| `flavor` | `std` \| `ghostty` | `std` | Build flavor to track. |
| `repo` | string | `Gaurav-Gosain/tuios` | GitHub repository publishing the releases. |
| `apiUrl` | string | GitHub `releases/latest` URL | Releases API endpoint. |
| `userAgent` | string | `swamp-tuios/1.0` | `User-Agent` sent to the GitHub API. |
| `githubToken` | string | `""` | GitHub token to raise the API rate limit. Empty falls back to `GITHUB_TOKEN` / `GH_TOKEN`. |
| `os` | string | `""` | Override the detected release OS token. Empty probes the host. |
| `arch` | string | `""` | Override the detected architecture token. Empty probes the host. |

Per-call overrides use `--input`, and a non-empty `--input` always wins over
the model global.

> **GitHub API rate limits.** The releases API allows 60 anonymous requests per
> hour per IP. A workflow run spends one on `check` (plus one for
> `checksums.txt`, which is not rate-limited). Export `GITHUB_TOKEN` (or set the
> `githubToken` global) on machines that run the workflow often, especially the
> scheduled trigger. The install method reuses the release fetched earlier in
> the same run, so a normal run spends a single API call.

## Examples

```sh
# Install or upgrade TUIOS on this machine and start its daemon as a systemd
# user service, so sessions survive logout and reboot. Idempotent — run it again
# and the install step skips.
swamp workflow run @svendowideit/tuios-install

# Pin a specific release and install it into ~/.local/bin.
swamp workflow run @svendowideit/tuios-install \
  --input version=0.8.0 --input installDir=~/.local/bin

# Install just the binary, no systemd service — useful in a container or CI.
swamp workflow run @svendowideit/tuios-install --input manageService=false

# Ask what the latest release is and what this machine would download.
swamp model @svendowideit/tuios-release method run check tuios-release

# Ask what is installed and whether an update is available, then read it back.
swamp model @svendowideit/tuios-installed method run sync tuios-installed
swamp data get tuios-installed installed --json

# Reinstall over an existing binary even when the version matches.
swamp model @svendowideit/tuios-installed method run install tuios-installed \
  --input force=true

# Track the libghostty-vt build instead of the pure-Go one.
swamp model @svendowideit/tuios-release method run check tuios-release \
  --input flavor=ghostty

# Remove the binary (the systemd service is left alone) via the workflow.
swamp workflow run @svendowideit/tuios-install --input uninstall=true

# Or directly, from a specific directory. Idempotent, and it refuses a
# package-manager-owned binary unless force=true.
swamp model @svendowideit/tuios-installed method run uninstall tuios-installed \
  --input installDir=~/.local/bin
```

## Details

### Models

| Model type | Method | Arguments | Produces |
| ---------- | ------ | --------- | -------- |
| `@svendowideit/tuios-release` | `check` | `os`, `arch`, `flavor`, `archiveName`, `fetchChecksums`, `requireChecksum` | `release` — the latest tag/version, every asset, the platform's archive, its download URL and SHA-256. |
| `@svendowideit/tuios-release` | `print` | `installedVersion` | `summary` — logs the release, the platform archive and whether an update is available. |
| `@svendowideit/tuios-installed` | `sync` | `path`, `checkLatest` | `installed` — path, present flag, version, backend, latest version and `updateAvailable`. |
| `@svendowideit/tuios-installed` | `install` | `version`, `installDir`, `archiveName`, `downloadUrl`, `releaseVersion`, `checksum`, `os`, `arch`, `flavor`, `force` | `install` — the install result (or a `skipped: true` record), and a refreshed `installed` resource. |
| `@svendowideit/tuios-installed` | `uninstall` | `path`, `installDir`, `force` | `uninstall` — the removal result (or a `skipped: true` no-op), and a refreshed `installed` resource. |
| `@svendowideit/tuios-installed` | `print` | none | `summary` — logs the installed state and update availability. |

### Pre-flight checks — `@svendowideit/tuios-installed`

| Check | Label | Applies to | What it validates |
| ----- | ----- | ---------- | ----------------- |
| `valid-install-dir` | `policy` | `install`, `uninstall` | The configured `path` global is absolute or `~`-prefixed. |

Skip it with `--skip-check valid-install-dir` or `--skip-check-label policy`.

The package-manager guard is a **runtime** check inside `install` and
`uninstall`, not a pre-flight check: pre-flight checks cannot see call-time
method arguments, so they could not validate the effective `installDir`. Both
methods probe the actual target with `dpkg -S` / `rpm -qf` / `brew list` and
refuse a binary a package manager owns unless `force=true`. The same absolute-
path rule is also enforced at runtime, so a relative `installDir`/`path` is
rejected even when the pre-flight check is skipped.

The `downloadUrl`, `releaseVersion` and `checksum` inputs on `install` are the
consume-the-check-result path: the bundled workflow fills them from
`tuios-release`'s `release` resource, so `install` reuses the release `check`
already resolved instead of spending a second GitHub API request. When they are
empty (a direct `install` call) or belong to a different pinned version,
`install` fetches the release itself. **A checksum is mandatory on both paths:**
`check` fails when the selected archive is not listed in `checksums.txt`
(unless `requireChecksum=false`), and `install` refuses to install an archive
with no available SHA-256 or one whose download does not match — it never
installs an unverified archive.

### Workflow — `@svendowideit/tuios-install`

Steps: `check-latest → install → create-daemon-service →
start-daemon-service → verify`.

- `check-latest` is the only writer of the `release` resource; `install` is the
  only writer of `installed`/`install`; `verify` is the only writer of
  `summary`. Keeping one writer per resource per run keeps `data.latest(...)`
  unambiguous.
- `install` is idempotent: it locates the existing binary, and when its version
  already equals the target it records `skipped: true` and does not download
  (pass `force=true` to override).
- The systemd steps are `allowFailure: true` — an install still succeeds on a
  machine without a user systemd session. Set `manageService=false` to skip
  them entirely.
- The bundled trigger runs daily at 04:00; remove the `trigger:` block to
  upgrade by hand.

### Structure and extending

- `tuios_shared.ts` — pure helpers plus the two network functions
  (`fetchLatestRelease`, `fetchChecksums`). Archive-name building/parsing,
  platform mapping, version comparison, checksum parsing, tar extraction and
  PATH/install-dir selection all live here so both models and their tests share
  one implementation.
- `tuios_release.ts` — the `tuios-release` model, with `parseReleasePayload` /
  `selectPlatformAsset` exported so the payload handling is testable without a
  network call.
- `tuios_installed.ts` — the `tuios-installed` model, including the atomic
  install (write to `<path>.new-<uuid>`, then rename).
- `tuios-install.yaml` — the bundled workflow (created with
  `swamp workflow create`; do not hand-edit its `id`).
- `tuios_*_test.ts` — pure-helper tests; `tuios_*_methods_test.ts` drive the
  real `execute` functions through `createModelTestContext`, with the network
  stubbed by `withMockedFetch` and subprocesses by `withMockedCommand`.

To add a platform, extend `mapUnameOs` / `mapUnameArch` and `RELEASE_OSES` in
`tuios_shared.ts`. To track another release flavor, add it to
`BUILD_FLAVORS` — the archive-name builder and asset selector are derived from
it.

### Testing

```sh
# Unit and execute-level tests (no network, no real subprocesses):
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/tuios/tuios_shared_test.ts \
  extensions/models/tuios/tuios_release_test.ts \
  extensions/models/tuios/tuios_installed_test.ts \
  extensions/models/tuios/tuios_release_methods_test.ts \
  extensions/models/tuios/tuios_installed_methods_test.ts

# Type-check every module:
~/.swamp/deno/deno check extensions/models/tuios/tuios_shared.ts \
  extensions/models/tuios/tuios_release.ts \
  extensions/models/tuios/tuios_installed.ts
```

### Caveats

- The `ghostty` flavor is published for Linux and Windows only; selecting it on
  macOS yields no archive and `check` reports `supported: false`.
- `tuios update` (the upstream command) is not used here: this extension
  installs from the verified release archive so the swamp run log records the
  version and checksum. Re-running the workflow is the upgrade path.
- Installing into `/usr/local/bin` requires that this user can write there;
  otherwise the model falls back to `~/.local/bin` and warns when that
  directory is not on `PATH`.

## License

MIT — see LICENSE.txt.
