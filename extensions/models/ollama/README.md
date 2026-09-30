# @svendowideit/ollama

Install, upgrade and configure Ollama on a machine with systemd — track the
installed version, resolve the newest release, install the right build for this
machine, and keep the `ollama serve` daemon running with your settings.

## What it does

Ollama ships an `install.sh` that downloads the right binary, installs it to
`/usr/local`, and sets up a systemd service. That is fine once, but it is not
repeatable, not idempotent, and not easy to customise: re-running it re-does
everything, and changing a service setting means hand-editing a unit file under
`/etc`. This extension turns the same work into swamp models and a workflow:

- **Knows what is installed** — `sync` locates the `ollama` binary and reads
  `ollama --version`.
- **Resolves the newest release** — via
  [`@svendowideit/github-release-install`](../github-release-install); the
  bundled workflow resolves the release, matches the exact asset for this
  OS/architecture/accelerator, and records its SHA-256 from the release's
  `sha256sum.txt`.
- **Downloads only when needed** — the workflow compares the installed version
  with the latest release and downloads the checksum-verified archive only when
  an update is actually available (or `force` is set), so a machine that is
  already current does not pull a multi-gigabyte release on every run.
- **Installs or upgrades idempotently** — `install` extracts the verified
  archive and installs the `ollama` binary and its `lib/ollama` runtime,
  skipping when the target version is already present (unless `force`).
- **Supports every build Ollama publishes** — the base Linux build (which
  already bundles CUDA for NVIDIA), Linux AMD ROCm (`rocm`), NVIDIA Jetson
  (`jetpack5`/`jetpack6`), macOS (`ollama-darwin.tgz`) and Windows
  (`ollama-windows-amd64.zip`). `plan` auto-detects the accelerator, or you set
  it explicitly.
- **Manages the service without clobbering** — `createService` writes a full
  systemd unit only when none exists, creating the unprivileged `ollama` user
  for a system unit; `configureService` writes a drop-in override
  (`ollama.service.d/10-swamp.conf`) with your `OLLAMA_HOST`, extra
  `Environment=` lines and serve arguments, so an existing upstream unit is
  customised, never overwritten; `restartService` enables and restarts it, so
  the running daemon is the new binary with the new settings.

Side effects: it downloads from `github.com`, writes the `ollama` binary and
`lib/ollama` runtime (to `/usr/local` for system scope, `~/.local` for user
scope), and manages a systemd unit. Extracting a Linux release needs the `zstd`
tool; managing a system service needs root.

## Install

```sh
swamp extension pull @svendowideit/ollama
```

This also pulls `@svendowideit/github-release-install` (declared as a
dependency). Extracting a Linux `.tar.zst` release needs the `zstd` tool
(`apt-get install zstd`, `dnf install zstd`, or `pacman -S zstd`) — the same
requirement Ollama's own installer has.

## Configuration

Every global argument can also be passed **per call with `--input`** (or, for a
workflow, with `--input` to `swamp workflow run`). The workflow inputs mirror
these names.

### Model globals — `@svendowideit/ollama`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `os` | string | `""` | Override the detected OS token (`Linux`, `Darwin`, `Windows`). Empty probes the host with `uname`. |
| `arch` | string | `""` | Override the detected architecture (`x86_64`, `arm64`). Empty probes the host. |
| `accel` | `auto` \| `base` \| `rocm` \| `mlx` \| `jetpack5` \| `jetpack6` | `auto` | Build variant. `auto` detects Jetson/ROCm, else `base` (bundles CUDA on Linux/amd64). |
| `installDir` | string | `""` | Where the binary lands. Empty picks `/usr/local/bin` (system) or `~/.local/bin` (user). |
| `downloadDir` | string | `~/.cache/ollama` | Where the verified archive is staged. |
| `serviceName` | string | `ollama` | systemd unit name (without `.service`). |
| `serviceScope` | `auto` \| `system` \| `user` | `auto` | Unit scope. `auto` uses an existing unit's scope, else `system`. |
| `unitDir` | string | `""` | Override the unit directory. Empty uses `/etc/systemd/system` or `~/.config/systemd/user`. |
| `serviceUser` | string | `ollama` | Run-as user for a system unit (created if missing). |
| `serviceGroup` | string | `ollama` | Run-as group for a system unit. |
| `host` | string | `""` | `OLLAMA_HOST` value (e.g. `0.0.0.0:11434`). Empty leaves the service default. |
| `environment` | string[] | `[]` | Extra `Environment=` lines as `KEY=VALUE`. |
| `extraEnvironment` | string | `""` | A newline/comma-separated `KEY=VALUE` block, merged into `environment`. |
| `extraArgs` | string | `""` | Extra arguments appended to `ollama serve` (e.g. `--flash-attention`). |
| `restart` | string | `always` | systemd `Restart=` policy. |
| `restartSec` | string | `3` | systemd `RestartSec=`. |
| `sudo` | string | `sudo` | Escalation command for system scope. |
| `sudoNonInteractive` | boolean | `true` | Pass `-n` to sudo (no tty to prompt). Set false for an interactive password prompt. |

### Method arguments

| Method | Arguments |
| ------ | --------- |
| `plan` | `os`, `arch`, `accel`, `serviceScope` |
| `sync` | `path` |
| `assess` | `latestVersion` |
| `install` | `version`, `archivePath`, `archiveName`, `checksum`, `verifyArchive` (default `true`), `installDir`, `serviceScope`, `force` |
| `uninstall` | `path`, `installDir`, `serviceName`, `serviceScope`, `purge` (default `false`) |
| `createService` | `serviceName`, `serviceScope`, `binaryPath`, `execArgs`, `serviceUser`, `serviceGroup`, `force` |
| `configureService` | `serviceName`, `serviceScope`, `host`, `environment`, `extraEnvironment`, `extraArgs`, `serviceUser`, `serviceGroup`, `restart`, `restartSec`, `createIfMissing` (default `true`), `restartService` (default `false`) |
| `restartService` | `serviceName`, `serviceScope`, `enable` (default `false`) |
| `status` | `serviceName`, `serviceScope` |
| `removeService` | `serviceName`, `serviceScope` |
| `print` | `serviceName`, `serviceScope` |

Per-call `--input` wins over the model global. `unitDir` exists mainly for
testing; production runs use the real systemd directories.

### Workflow inputs — `@svendowideit/ollama-install`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `repo` | string | `ollama/ollama` | GitHub repository publishing the releases. |
| `version` | string | `""` | Release to install. Empty = latest. |
| `os` / `arch` | string | `""` | Override the detected platform. |
| `accel` | string | `auto` | Build variant (see the model global). |
| `githubToken` | string | `""` | Raise the releases API rate limit. Empty falls back to `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`. |
| `downloadDir` | string | `~/.cache/ollama` | Where the verified archive is staged. |
| `installDir` | string | `""` | Where the binary lands. |
| `manageService` | boolean | `true` | Create/configure/restart the systemd service. |
| `uninstall` | boolean | `false` | Remove the binary and runtime instead of installing. |
| `purgeService` | boolean | `false` | On an uninstall run, also remove the unit and drop-in. |
| `serviceName` | string | `ollama` | systemd unit name. |
| `serviceScope` | `auto` \| `system` \| `user` | `auto` | Unit scope. |
| `unitDir` | string | `""` | Override the unit directory (advanced/testing). |
| `serviceUser` / `serviceGroup` | string | `ollama` | Run-as identity for a system unit. |
| `host` | string | `""` | `OLLAMA_HOST` value. |
| `environment` | string[] | `[]` | Extra `Environment=` lines. |
| `extraArgs` | string | `""` | Extra `ollama serve` arguments. |
| `restart` / `restartSec` | string | `always` / `3` | Restart policy. |
| `force` | boolean | `false` | Reinstall / rewrite even when current. |

## Examples

```sh
# Install or upgrade Ollama and keep `ollama serve` running under systemd,
# creating the unit if it is missing. Idempotent, so run it on a schedule.
swamp workflow run @svendowideit/ollama-install

# Pin a version, put the models on a big disk (OLLAMA_MODELS), and expose the
# API on the LAN (OLLAMA_HOST). Your service settings, applied as a drop-in.
swamp workflow run @svendowideit/ollama-install \
  --input version=0.35.0 \
  --input host=0.0.0.0:11434 \
  --input environment='OLLAMA_MODELS=/mnt/models'

# See what this machine would install, and whether a system unit already
# exists — without downloading anything. `plan` writes the plan resource.
swamp model @svendowideit/ollama method run plan ollama

# What version is installed right now, and where is the binary?
swamp model @svendowideit/ollama method run sync ollama
swamp model @svendowideit/ollama method run print ollama

# Check the service: its scope, unit path and active/enabled state.
swamp model @svendowideit/ollama method run status ollama

# Change only the service settings later, without reinstalling the binary —
# configureService writes the drop-in and restarts the daemon.
swamp model @svendowideit/ollama method run configureService ollama \
  --input host=0.0.0.0:11434 --input restartService=true

# Use a user service instead of a root-owned system one (no sudo required).
swamp workflow run @svendowideit/ollama-install --input serviceScope=user

# Remove the binary and the systemd service again.
swamp workflow run @svendowideit/ollama-install \
  --input uninstall=true --input purgeService=true
```

## Details

### Models, methods and resources

`@svendowideit/ollama` ships one model type (`@svendowideit/ollama`) and one
workflow (`@svendowideit/ollama-install`).

| Method | Description | Resource |
| ------ | ----------- | -------- |
| `plan` | Resolve OS/arch/accelerator, the exact asset name, install/lib paths and service scope. | `platform` |
| `sync` | Locate the binary, run `ollama --version`, record the version and path. | `installed` |
| `assess` | Compare the installed version with the latest release; records whether an update is available. | `assessment` |
| `install` | Extract the verified archive, install the binary + `lib/ollama` runtime. | `install`, `installed` |
| `uninstall` | Remove the binary and runtime (and optionally the service). | `uninstall`, `installed` |
| `createService` | Write a full unit when none exists (creating the run-as user). | `serviceCreate` |
| `configureService` | Write/update the drop-in override and `daemon-reload`. | `config` |
| `restartService` | Enable (optional) and restart the service, verify active. | `service` |
| `status` | Report scope, unit path, active/enabled. | `service` |
| `removeService` | Stop, disable, delete the unit and drop-in. | — |
| `print` | Log the stored installed summary and status command. | `summary` |

### Structure and extending

- `ollama_shared.ts` — pure helpers: asset/platform mapping, accelerator
  detection, version parsing, environment merging, systemd unit rendering,
  checksum verification and archive extraction (tar.gz/zip in memory). No
  network or system access, so it is fully unit tested.
- `ollama.ts` — the model. `plan` probes the platform; `install` streams the
  archive through `zstd` (tar.zst), Deno's gzip (tgz) or `fflate` (zip),
  installs with `sudo` when the target is root-owned, and re-syncs. The service
  methods render units/drop-ins and drive `systemctl` for the resolved scope.
- `ollama-install.yaml` — the bundled workflow, created with
  `swamp workflow create` (do not hand-edit its `id`). It plans, syncs the
  installed version, resolves the release, assesses whether an update is needed,
  downloads the verified archive only then, installs, and finally
  creates/configures/restarts the service.
- `ollama_shared_test.ts` / `ollama_methods_test.ts` — pure and execute-level
  tests; the latter drive the real methods through `createModelTestContext` with
  the command layer mocked by `withMockedCommand`, using a real `tar.zst`
  fixture for `install` and temp `unitDir`s so nothing touches `/etc`.

To support a new Ollama build variant, add it to `ACCEL_VARIANTS` and to
`assetStem` in `ollama_shared.ts` — no other change is needed. To change what a
service unit contains, edit `renderServiceUnit` (full unit) or `dropInContent`
(override) and their tests.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/ollama/ollama_shared_test.ts \
  extensions/models/ollama/ollama_methods_test.ts

~/.swamp/deno/deno check \
  extensions/models/ollama/ollama_shared.ts \
  extensions/models/ollama/ollama.ts
```

### Caveats

- **systemd is Linux-only.** On macOS and Windows the model installs the binary
  and `lib/ollama` runtime but does not manage a service (the workflow's service
  steps are skipped when `plan` reports no status command). Use the platform
  installer for the macOS app / Windows service.
- **System scope needs root.** `createService`/`configureService`/
  `removeService` write to `/etc/systemd/system` and `install` writes to
  `/usr/local`, both via `sudo`. Configure passwordless `sudo` for scheduled
  runs, or use `serviceScope=user`.
- **`zstd` is required on Linux.** The base/ROCm/Jetson releases are
  `.tar.zst`; install the `zstd` package (Ollama's installer has the same
  requirement).
- **Release downloads are large.** The Linux base build is over 1 GB; the
  archive is streamed from disk during extraction and streamed through
  `sha256sum` during verification, so memory stays bounded.
- **GitHub rate limits.** The releases API allows 60 anonymous requests/hour.
  Run `gh auth login` once (its token is used automatically), or set
  `GITHUB_TOKEN`.

## License

MIT — see LICENSE.txt.
