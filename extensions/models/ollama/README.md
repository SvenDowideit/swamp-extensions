# @svendowideit/ollama

Install, upgrade and configure Ollama on a machine with systemd — track the
installed version, resolve the newest release, install the right build for this
machine, elevate the privileged steps through the `@svendowideit/sudo` ladder,
and keep the `ollama serve` daemon running with your settings (or run
binary-only on client machines).

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
- **Stages unprivileged, places privileged** — `stage` verifies the archive
  again and extracts it into an unprivileged staging dir; the workflow then
  places the binary, `lib/ollama` runtime, unit and drop-in as root through
  [`@svendowideit/sudo`](../sudo)'s named operations (`installFile`,
  `ensureDirectory`, `createUser`, `daemonReload`, `manageService`), so any
  route the host already grants works — passwordless sudo, doas, polkit
  (`run0`/`pkexec`), a container runtime, ssh — not just sudo. When no route is
  granted, the failing step reports the full ladder and the reason each route
  was rejected.
- **Tri-state service management** — `manageService=auto` (default) maintains
  the systemd service only when a unit already exists (a server) and upgrades
  the binary only otherwise (a client machine); `true` always creates/updates
  the service; `false` never touches units. The scheduled daily run therefore
  upgrades servers' services and clients' binaries without any per-machine
  configuration.
- **Supports every build Ollama publishes** — the base Linux build (which
  already bundles CUDA for NVIDIA), Linux AMD ROCm (`rocm`), NVIDIA Jetson
  (`jetpack5`/`jetpack6`), macOS (`ollama-darwin.tgz`) and Windows
  (`ollama-windows-amd64.zip`). `plan` auto-detects the accelerator, or you set
  it explicitly.
- **Manages the service without clobbering** — `prepareService` renders a full
  systemd unit only when none exists (the workflow places it with sudo's
  `installFile`), and always renders a drop-in override
  (`ollama.service.d/10-swamp.conf`) with your `OLLAMA_HOST`, extra
  `Environment=` lines and serve arguments, so an existing upstream unit is
  customised, never overwritten; the workflow's `manageService` step enables
  and restarts it, so the running daemon is the new binary with the new
  settings.
- **An official-installer mode** — `--input installScript=true` downloads
  Ollama's own `install.sh` and runs it as root through the same elevation
  ladder (sudo's `runScript` operation); the workflow then enables/restarts the
  service through it. Opt-in because it is less verifiable than the
  checksum-verified release flow.

Side effects: it downloads from `github.com` (or `ollama.com` in
installScript mode), writes the `ollama` binary and `lib/ollama` runtime (to
`/usr/local` for system scope, `~/.local` for user scope) via the sudo ladder,
and manages a systemd unit when `manageService` says so. Extracting a Linux
release needs the `zstd` tool.

## Install

```sh
swamp extension pull @svendowideit/ollama
```

This also pulls `@svendowideit/github-release-install` and
`@svendowideit/sudo` (declared as dependencies). Extracting a Linux `.tar.zst`
release needs the `zstd` tool (`apt-get install zstd`, `dnf install zstd`, or
`pacman -S zstd`) — the same requirement Ollama's own installer has.

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
| `manageService` | `auto` \| `"true"` \| `"false"` | `auto` | `auto` maintains an existing unit (server) and upgrades binary-only otherwise (client); `"true"` always manages; `"false"` never touches units. |
| `sudo` | string | `sudo` | Escalation command for the direct-method path. |
| `sudoNonInteractive` | boolean | `true` | Pass `-n` to sudo (no tty to prompt). Set false for an interactive password prompt. |
| `sudoInstanceKey` | string | `default` | Instance key of the `@svendowideit/sudo` model the workflow elevates through (`sudo-<instanceKey>`). |

### Method arguments

| Method | Arguments |
| ------ | --------- |
| `plan` | `os`, `arch`, `accel`, `serviceScope` |
| `privilege` | *(none)* |
| `sync` | `path` |
| `assess` | `latestVersion` |
| `install` | `version`, `archivePath`, `archiveName`, `checksum`, `verifyArchive` (default `true`), `installDir`, `serviceScope`, `force` |
| `stage` | `version`, `archivePath`, `archiveName`, `checksum`, `verifyArchive` (default `true`) |
| `prepareService` | `serviceName`, `serviceScope`, `binaryPath`, `host`, `environment`, `extraArgs`, `restart`, `restartSec`, `createIfMissing` (default `true`) |
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
| `manageService` | `auto` \| `"true"` \| `"false"` | `auto` | Tri-state service management (see the model global). |
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
| `installScript` | boolean | `false` | Install via the official install.sh through the sudo ladder instead of the checksum-verified release. |
| `installScriptUrl` | string | `https://ollama.com/install.sh` | Download URL for the official installer script. |
| `sudoInstanceKey` | string | `default` | Which sudo model instance to elevate through. |
| `sudoAllowedOperations` | string[] | the install set | Operation allowlist passed to the sudo model for this run. Default: `installPackage`, `removePackage`, `manageService`, `ensureDirectory`, `createUser`, `installFile`, `daemonReload`, `removePath`, `copyDirectory`. Add `runScript` for `installScript=true`. |
| `force` | boolean | `false` | Reinstall / rewrite even when current. |

### Elevation — `@svendowideit/sudo` globals (on the `sudo-ollama` instance)

The workflow's privileged steps pass `sudoAllowedOperations` to the sudo
model on every call, so the auto-created instance works out of the box. To
pre-create it with a persistent allowlist (also covers direct method calls):

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `allowedOperations` | string[] | `installPackage`, `removePackage`, `manageService` (an empty value falls back to this set) | Must include `ensureDirectory`, `createUser`, `installFile`, `daemonReload`, `removePath`, `copyDirectory` for the default flow — plus `runScript` for `installScript=true`. |

## Examples

```sh
# One-time, optional: pre-create the sudo instance with a persistent
# allowlist (the workflow also passes its own per-run allowlist, so this
# only matters for direct method calls against the sudo model).
swamp model create @svendowideit/sudo sudo-ollama \
  --global-arg 'allowedOperations=["installPackage","removePackage","manageService","ensureDirectory","createUser","installFile","daemonReload","removePath","copyDirectory"]'

# Install or upgrade Ollama and keep `ollama serve` running under systemd when
# a unit exists (a server) — or upgrade the binary only when none does (a
# client). Idempotent, so run it on a schedule.
swamp workflow run @svendowideit/ollama-install

# Pin a version, put the models on a big disk (OLLAMA_MODELS), and expose the
# API on the LAN (OLLAMA_HOST). Your service settings, applied as a drop-in.
swamp workflow run @svendowideit/ollama-install \
  --input version=0.35.0 \
  --input host=0.0.0.0:11434 \
  --input environment='OLLAMA_MODELS=/mnt/models'

# A client machine: upgrade the binary, never create or touch a unit.
swamp workflow run @svendowideit/ollama-install --input manageService=false

# Force a fresh server: create the unit even when none exists yet.
swamp workflow run @svendowideit/ollama-install --input manageService=true

# The three-way version report: the local binary's version (OLLAMA_HOST
# scrubbed), the server's version at the configured OLLAMA_HOST when it
# differs, and the latest release an install would bring.
swamp model @svendowideit/ollama method run sync ollama
swamp model @svendowideit/ollama method run print ollama

# Check the service: its scope, unit path and active/enabled state.
swamp model @svendowideit/ollama method run status ollama

# See which elevation route the sudo ladder proves on this host before you
# trust a scheduled run (read-only; proves routes with a uid-0 probe).
swamp model @svendowideit/sudo method run probe sudo-ollama

# See what this machine would install, and whether a system unit already
# exists — without downloading anything. `plan` writes the plan resource.
swamp model @svendowideit/ollama method run plan ollama

# Change only the service settings later, without reinstalling the binary —
# configureService writes the drop-in and restarts the daemon.
swamp model @svendowideit/ollama method run configureService ollama \
  --input host=0.0.0.0:11434 --input restartService=true

# Alternative installer: run Ollama's official install.sh as root through the
# elevation ladder (runScript is appended to the per-run allowlist).
swamp workflow run @svendowideit/ollama-install --input installScript=true

# Use a user service instead of a root-owned system one (no elevation at all).
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
| `plan` | Resolve OS/arch/accelerator, the exact asset name, install/lib paths, service scope, the tri-state manageService decision, and the host's sudo situation. | `platform` |
| `privilege` | Detect how this run can escalate to root and print the commands to run when it cannot. | `privilege` |
| `sync` | Locate the binary, run `ollama --version` **with `OLLAMA_HOST` scrubbed** (so this is the local binary's version), probe the configured server's `/api/version` separately, resolve the latest release version from GitHub (fails soft), and record installed + server + latest + update status. | `installed` |
| `assess` | Compare the installed version with the latest release; records whether an update is available. | `assessment` |
| `install` | Extract the verified archive and install the binary + `lib/ollama` runtime (the direct-method path, with sudo fallback and manual commands). | `install`, `installed` |
| `stage` | Verify and extract the archive into an unprivileged staging dir for the workflow's privileged placement steps. | `stage` |
| `prepareService` | Render the unit (when none exists) and drop-in into the staging tree for placement. | `servicePrepare` |
| `uninstall` | Remove the binary and runtime (and optionally the service). | `uninstall`, `installed` |
| `createService` | Write a full unit when none exists (creating the run-as user). | `serviceCreate` |
| `configureService` | Write/update the drop-in override and `daemon-reload`. | `config` |
| `restartService` | Enable (optional) and restart the service, verify active. | `service` |
| `status` | Report scope, unit path, active/enabled. | `service` |
| `removeService` | Stop, disable, delete the unit and drop-in. | — |
| `print` | Log the stored installed summary and status command. | `summary` |

### Workflow steps

`plan` → `privilege` → `sync` → (`resolve` → `assess` → `download`) →
`stage` → `place-binary` → `place-lib` → `create-user` → `stage-service` →
`place-service` → `place-dropin` → `daemon-reload` → `enable-restart` →
`verify`. The `place-*`, `daemon-reload` and `enable-restart` steps are
`@svendowideit/sudo-run` workflow calls; the guards use the plan's
`manageService` decision so a client machine skips every service step. On
`uninstall=true` the run goes `plan` → `privilege` → `sync` → `uninstall-step`
(removePath) → `purge-service` (when `purgeService=true`) → `verify`.

### Structure and extending

- `ollama_shared.ts` — pure helpers: asset/platform mapping, accelerator
  detection, version parsing, environment merging, systemd unit rendering,
  checksum verification and archive extraction (tar.gz/zip in memory). No
  network or system access, so it is fully unit tested.
- `ollama.ts` — the model. `plan` probes the platform and resolves the
  tri-state `manageService`; `stage` verifies + extracts; `prepareService`
  renders units/drop-ins into the staging tree; `install` keeps the direct
  privileged path (with its manual-commands fallback) for direct callers. The
  service methods drive `systemctl` for the resolved scope.
- `ollama-install.yaml` — the bundled workflow, created with
  `swamp workflow create` (do not hand-edit its `id`). It plans, syncs the
  installed version, resolves the release, assesses whether an update is
  needed, downloads the verified archive only then, stages it, places the
  tree through the `@svendowideit/sudo` ladder, and finally
  creates/configures/restarts the service when `manageService` says so.
- `ollama_shared_test.ts` / `ollama_test.ts` — pure and execute-level
  tests; the latter drive the real methods through `createModelTestContext` with
  the command layer mocked by `withMockedCommand`, using a real `tar.zst`
  fixture for `stage`/`install` and temp `unitDir`s so nothing touches `/etc`.

To support a new Ollama build variant, add it to `ACCEL_VARIANTS` and to
`assetStem` in `ollama_shared.ts` — no other change is needed. To change what a
service unit contains, edit `renderServiceUnit` (full unit) or `dropInContent`
(override) and their tests. To change how privileged placement happens, edit
the workflow's `place-*` steps (they call `@svendowideit/sudo-run` with named
operations).

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/ollama/ollama_shared_test.ts \
  extensions/models/ollama/ollama_test.ts

~/.swamp/deno/deno check \
  extensions/models/ollama/ollama_shared.ts \
  extensions/models/ollama/ollama.ts
```

### Caveats

- **systemd is Linux-only.** On macOS and Windows the model installs the binary
  and `lib/ollama` runtime but does not manage a service (the workflow's service
  steps are skipped when `plan` reports no status command). Use the platform
  installer for the macOS app / Windows service.
- **Privileged steps need a granted route.** The workflow's placement steps run
  through `@svendowideit/sudo`, whose ladder covers sudo, doas, polkit, pkexec,
  systemd-run, capabilities, containers, ssh and k8s — but if *none* is granted
  the run fails with the full ladder report. Probe first with
  `swamp model @svendowideit/sudo method run probe sudo-ollama`. The direct
  methods (`install`, `createService`, …) keep the older passwordless-sudo path
  and print copy-paste `manualCommands` when they cannot escalate.
- **Allowlist the operations.** The sudo model only runs operations listed in
  its `allowedOperations`; the default set covers `manageService` only, so set
  the allowlist shown in Examples before the first run.
- **`zstd` is required on Linux.** The base/ROCm/Jetson releases are
  `.tar.zst`; install the `zstd` package (Ollama's installer has the same
  requirement).
- **Release downloads are large.** The Linux base build is over 1 GB; the
  archive is streamed from disk during extraction and streamed through
  `sha256sum` during verification, so memory stays bounded.
- **`installScript=true` runs a shell script as root.** It downloads
  `https://ollama.com/install.sh` and executes it through the elevation ladder
  (the `runScript` operation, which must be allowlisted). Prefer the default
  checksum-verified flow; use the script mode only when you specifically want
  Ollama's own installer behaviour.
- **GitHub rate limits.** The releases API allows 60 anonymous requests/hour.
  Run `gh auth login` once (its token is used automatically), or set
  `GITHUB_TOKEN`.

## License

MIT — see LICENSE.txt.
