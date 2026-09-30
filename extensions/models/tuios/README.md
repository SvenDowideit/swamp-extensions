# @svendowideit/tuios

Keep [TUIOS](https://tuios.dev) current and always-on. It resolves the latest
TUIOS release and this machine's archive, downloads and verifies it, installs
the `tuios` binary, and runs the daemon under a systemd user service so sessions
survive logout and reboot.

Release resolution, platform selection, checksum lookup and download are done
by [`@svendowideit/github-release-install`](../github-release-install) — a
reusable GitHub-release installer. This extension keeps only the TUIOS-specific
parts: locating and running the `tuios` binary, extracting and installing it
from the verified archive, the package-manager guard, and the systemd daemon.

## What it does

TUIOS is a terminal window manager whose sessions live in a background daemon.
This extension answers the questions you actually have about it, on any machine
you run swamp on:

- **What is installed right now?** The `tuios-installed` model finds the `tuios`
  binary, runs `tuios --version`, and records the version, the VT backend and
  the resolved path.
- **How do I install or upgrade it, and keep it running?** The bundled
  `tuios-install` workflow calls `@svendowideit/github-release-install-fetch` to
  land a checksum-verified archive, then `install` extracts the `tuios` binary
  from it, verifies it once more, and installs it atomically; `uninstall`
  removes it. The workflow also starts a `tuios daemon` systemd *user* service,
  restarts it after an upgrade, and prints where the binary landed and the exact
  `systemctl --user status` command.

Side effects: outbound HTTPS reads from `api.github.com` and the release
download URL (nothing is written there); install writes a binary into
`/usr/local/bin`, `~/.local/bin` or `~/bin` and stages the verified archive
under the download directory; the workflow writes a systemd user unit and
enables lingering when `manageService` is true.

## Install

```sh
swamp extension pull @svendowideit/tuios
```

The declared dependencies `@svendowideit/github-release-install` and
`@svendowideit/systemd-service` are pulled automatically.

## Configuration

### Workflow inputs — `@svendowideit/tuios-install`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `repo` | string | `Gaurav-Gosain/tuios` | GitHub repository publishing the TUIOS releases. |
| `installDir` | string | `""` | Where to install the `tuios` binary. Empty auto-picks the first writable of `/usr/local/bin`, `~/.local/bin`, `~/bin`. |
| `downloadDir` | string | `~/.cache/tuios` | Where the checksum-verified archive is staged before install extracts it. |
| `version` | string | `""` | Release to install (`0.8.0` or `v0.8.0`). Empty installs the latest. |
| `flavor` | `std` \| `ghostty` | `std` | `std` is the pure-Go emulator; `ghostty` bundles libghostty-vt (Linux/Windows only). |
| `force` | boolean | `false` | Reinstall even when the target version is already present, and rewrite the systemd unit even if it matches. |
| `manageService` | boolean | `true` | Create and start a systemd user service running the TUIOS daemon. |
| `serviceName` | string | `tuios` | systemd user service name (without `.service`). |
| `uninstall` | boolean | `false` | Remove the binary instead of installing it. |
| `githubToken` | string | `""` | Token for the releases API (avoids the 60/hour anonymous limit). Empty falls back to `GITHUB_TOKEN`, `GH_TOKEN`, then the authenticated `gh` CLI. |

### `tuios-installed` global arguments

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `path` | string | `""` | Path to the `tuios` binary. Empty auto-detects from `PATH` and the usual install locations; when set it is authoritative. |
| `flavor` | `std` \| `ghostty` | `std` | Build flavor being tracked (reporting only; the archive is chosen by the release workflow). |
| `serviceName` | string | `tuios` | systemd user service name, used to print the `systemctl --user status` command. |

### Release resolution — `@svendowideit/github-release-install-fetch`

The workflow's `fetch-release` step calls this dependency. Its inputs (`repo`,
`version`, `stem`, `outputDir`, `force`, `os`/`arch`, `assetPattern`, `format`,
`githubToken`) are documented in that extension; TUIOS passes `stem` as
`tuios` or `tuios-ghostty` for the selected `flavor`.

TUIOS publishes **three** archives per platform, all matching the same
OS/architecture:

| Stem | Archive | Contents |
| ---- | ------- | -------- |
| `tuios` | `tuios_<v>_<Os>_<arch>.tar.gz` | the main build (pure-Go) |
| `tuios-ghostty` | `tuios-ghostty_<v>_<Os>_<arch>.tar.gz` | the same `tuios` binary built with libghostty-vt |
| `tuios-web` | `tuios-web_<v>_<Os>_<arch>.tar.gz` | the `tuios-web` server (a different binary) |

Because a `stem` is always passed, the release step selects exactly one — the
main build by default, or the ghostty build with `--input flavor=ghostty`. The
release dependency records all three in `platform.candidates`, so a caller can
see the alternatives; the installer extracts the `tuios` member, which both the
main and ghostty archives contain.

#### Authentication and rate limits

GitHub's releases API allows only 60 anonymous requests per hour per IP. The
`githubToken` workflow input is optional; when empty, the release dependency
falls back to `GITHUB_TOKEN`, `GH_TOKEN`, then the authenticated `gh` CLI. For
scheduled runs, authenticate once and the token is picked up automatically:

```sh
gh auth login                          # interactive; token then used automatically
export GITHUB_TOKEN=$(gh auth token)   # or export one for a headless job
```

To see what a run would use (it never prints the token):

```sh
swamp model @svendowideit/github-release-install method run authStatus gh \
  --input repo=Gaurav-Gosain/tuios
```

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

# Ask what the latest release is and what this machine would download, without
# downloading it — the release workflow with the download step disabled.
swamp workflow run @svendowideit/github-release-install-fetch \
  --input repo=Gaurav-Gosain/tuios --input stem=tuios --input download=false

# Ask what is installed right now, then read it back.
swamp model @svendowideit/tuios-installed method run sync tuios-installed
swamp data get tuios-installed installed --json

# Print the current state, binary path and systemctl status command (the
# workflow's verify step does this, but you can run it standalone any time).
swamp model @svendowideit/tuios-installed method run print tuios-installed

# Track the libghostty-vt build instead of the pure-Go one.
swamp workflow run @svendowideit/tuios-install --input flavor=ghostty

# Remove the binary via the workflow. It stops the daemon service (so a
# removed binary cannot leave the unit restart-looping) but leaves the unit
# file; the output says how to remove that too.
swamp workflow run @svendowideit/tuios-install --input uninstall=true

# Or directly, from a specific directory. Idempotent, and it refuses a
# package-manager-owned binary unless force=true.
swamp model @svendowideit/tuios-installed method run uninstall tuios-installed \
  --input installDir=~/.local/bin
```

## Details

### Models, methods and resources

| Model | Method | Arguments | Produces |
| ----- | ------ | --------- | -------- |
| `@svendowideit/tuios-installed` | `sync` | `path` | `installed` — path, present flag, version and backend. |
| `@svendowideit/tuios-installed` | `install` | `version`, `archivePath`, `archiveName`, `checksum`, `installDir`, `force` | `install` — the install result (or `skipped: true`), with `checksumVerified`, `versionCommand` and `serviceStatusCommand`, and a refreshed `installed` resource. |
| `@svendowideit/tuios-installed` | `uninstall` | `path`, `installDir`, `force`, `serviceName` | `uninstall` — the removal result (or `skipped: true`), with `serviceNote`/`serviceStatusCommand`, and a refreshed `installed` resource. |
| `@svendowideit/tuios-installed` | `print` | `serviceName` | `summary` — logs the installed state, the binary path and the `systemctl --user status` command. |

`install` requires `archivePath` — the checksum-verified archive produced by
`@svendowideit/github-release-install`'s `download` step. It re-verifies the
bytes against `checksum`, extracts the single `tuios` member, and installs.
When `archiveName` is omitted it derives the version from the staged file's
name (`tuios_0.8.0_Linux_x86_64.tar.gz`).

### Pre-flight checks — `@svendowideit/tuios-installed`

| Check | Label | Applies to | What it validates |
| ----- | ----- | ---------- | ----------------- |
| `valid-install-dir` | `policy` | `install`, `uninstall` | The configured `path` global is absolute or `~`-prefixed. |

Skip it with `--skip-check valid-install-dir` or `--skip-check-label policy`.

The package-manager guard is a **runtime** check inside `install` and
`uninstall`: both probe the target with `dpkg -S` / `rpm -qf` / `brew list` and
refuse a binary a package manager owns unless `force=true`. The same
absolute-path rule is enforced at runtime, so a relative `installDir`/`path` is
rejected even when the pre-flight check is skipped.

### Workflow — `@svendowideit/tuios-install`

Steps: `fetch-release → install → create-daemon-service →
start-daemon-service → restart-daemon-service → verify`.

- `fetch-release` calls `@svendowideit/github-release-install-fetch`, which
  resolves the release, selects this platform's archive, records its expected
  SHA-256, downloads it and verifies the bytes, landing a checksum-verified
  archive on disk. It is the only writer of `release`/`archive`.
- `install` re-verifies the archive and installs the binary. It is the only
  writer of `installed`/`install`; `uninstall` of `uninstall`; `verify` of
  `summary`. One writer per resource per run keeps `data.latest(...)`
  unambiguous.
- `install` is idempotent: it locates the existing binary, and when its version
  already equals the target it records `skipped: true` (pass `force=true` to
  override).
- `restart-daemon-service` restarts the daemon after an actual upgrade.
  `systemctl --user enable --now` does **not** restart an already-active unit, so
  without this step the daemon would keep running the old binary. It is skipped
  when the install was a no-op, on uninstall, and when `manageService=false`.
- The systemd steps are `allowFailure: true` — an install still succeeds on a
  machine without a user systemd session. Set `manageService=false` to skip
  them entirely.
- `verify` prints the installed version, the binary path (`<path> --version`),
  and `systemctl --user status <service>.service`.
- The bundled trigger runs daily at 04:00; remove the `trigger:` block to
  upgrade by hand.

### Structure and extending

- `tuios_shared.ts` — the TUIOS-specific pure helpers: build flavors and
  archive-name parsing, install-dir and `PATH` selection, the package-manager
  probe, SHA-256 verification, tar extraction, version parsing and comparison.
- `tuios_installed.ts` — the model: `sync`, `install` (verify the staged
  archive, extract, atomic install, package-manager guard), `uninstall`, `print`.
- `tuios-install.yaml` — the bundled workflow (created with
  `swamp workflow create`; do not hand-edit its `id`).
- `tuios_shared_test.ts` / `tuios_installed_test.ts` /
  `tuios_installed_methods_test.ts` — pure-helper and execute-level tests; the
  latter drive the real `execute` functions through `createModelTestContext`
  with subprocesses stubbed by `withMockedCommand`. There is no network in the
  install path — the archive is built on disk by the test.

To change the release repository or asset naming, adjust the workflow's
`fetch-release` inputs (or the dependency's `assetPattern`). To add a platform,
TUIOS's own artifact naming is handled by the release extension.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/tuios/tuios_shared_test.ts \
  extensions/models/tuios/tuios_installed_test.ts \
  extensions/models/tuios/tuios_installed_methods_test.ts

~/.swamp/deno/deno check \
  extensions/models/tuios/tuios_shared.ts \
  extensions/models/tuios/tuios_installed.ts
```

### Where things land and how to check them

```sh
# The binary (path is printed by install/verify; usually ~/.local/bin/tuios).
~/.local/bin/tuios --version

# The daemon, if manageService was used (default service name: tuios).
systemctl --user status tuios.service
systemctl --user is-enabled tuios.service
```

Change the service name with `--input serviceName=<name>` (or the
`tuios-installed` `serviceName` global) if you use something other than `tuios`.

### Caveats

- The `ghostty` flavor is published for Linux and Windows only; selecting it on
  macOS yields no archive and the release step reports `supported: false`.
- `tuios update` (the upstream command) is not used here: this extension
  installs from the verified release archive so the swamp run log records the
  version and checksum. Re-running the workflow is the upgrade path.
- Installing into `/usr/local/bin` requires that this user can write there;
  otherwise the model falls back to `~/.local/bin` and warns when that
  directory is not on `PATH`.
- `uninstall` removes the binary and stops the daemon service, but does not
  delete the unit file — remove it with `@svendowideit/systemd-service`'s
  `removeService`. The uninstall output says so.
- An upgrade restarts the daemon; that ends any attached clients, but sessions
  persist because the daemon saves them. The daemon runs the binary present at
  the time it started, so a manual binary replacement outside the workflow also
  needs a `restartService`.

## License

MIT — see LICENSE.txt.
