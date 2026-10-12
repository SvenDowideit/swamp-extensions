# @svendowideit/obsidian-headless

Install and run the official Obsidian Sync headless client as a systemd user
service, and retire the desktop app's in-app sync for the vault it takes over.

This README is the extender/maintainer reference. The manifest carries the user
manual; this document explains the structure, the methods, and how to change or
test the extension.

## What it does

Obsidian's paid Sync normally runs only inside the desktop app, so a vault on a
server or always-on box stays stale unless someone opens the app. This extension
provisions the official [`obsidian-headless`](https://github.com/obsidianmd/obsidian-headless)
client (`ob`) on such a host and keeps it syncing continuously. It does three
jobs:

1. **Detects conflict with the desktop app.** It reads the Obsidian desktop
   vault registry and the vault's `.obsidian/core-plugins.json`, and reports
   whether the in-app `sync` core plugin is on. When it is, the bundled workflow
   pauses at a single manual approval step; approving disables the in-app plugin
   (with a timestamped backup of `core-plugins.json`) so the desktop app and the
   headless client do not fight over the vault.
2. **Installs on a managed runtime.** It ensures a Node.js 22+ runtime (reusing
   an existing one, or downloading and SHA-256-verifying the official build into
   a managed directory) and installs the `obsidian-headless` npm package into a
   managed prefix — no system-wide `npm install -g` against a Node the user may
   not have.
3. **Runs it under systemd.** Via [`@svendowideit/systemd-service`](https://github.com/svendowideit/swamp-extensions)
   it creates and starts a systemd *user* unit that keeps `ob sync --continuous`
   alive, enabling lingering so sync resumes at boot.

The client is installed **before** the pause, so the one approval prompt lists the
exact commands to run while the workflow waits, each on its own line: the absolute
`ob login` command (email, password, 2FA; needed only when the host is not logged
in), and `ob sync-setup --vault … --path …` for this vault — so an end-to-end
encryption password is entered now (or supplied up front via `e2ePassword`) and
the correct vault directory is used. If in-app sync is configured it also asks you
to close the Obsidian desktop app before approving. After you approve, the
workflow re-reads the host (so the login you just did is seen), reuses the sync
setup you performed, then configures and starts the service. Authentication never
passes through swamp — `ob login` stores the token on the host and the systemd
service reuses it.

## Install

```sh
swamp extension pull @svendowideit/obsidian-headless
```

The single pull also installs the declared `@svendowideit/systemd-service`
dependency.

## Prerequisites

- **Linux with systemd** (user units). The extension targets `linux-x86_64` and
  `linux-aarch64`.
- **A one-time interactive login.** Run `ob login` once on the host (email,
  password, 2FA) after the package is installed. The token is stored under the
  obsidian-headless config directory and reused by the systemd service — no
  secret ever passes through swamp.
- **An end-to-end encrypted vault needs its password once.** Either supply
  `e2ePassword` (wire it from a swamp vault), or run `ob sync-setup` during the
  pause — the prompt prints the exact command — which stores the vault key on the
  host for the service to reuse.
- **`tar` and `xz`** on the path (standard on Linux) for extracting the Node.js
  build.

## Configuration

Set global arguments when creating a model
(`swamp model create @svendowideit/obsidian-headless obsidian-headless --global-arg key=value`),
or override per call with `--input`. The same names are workflow inputs.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `vaultName` | string | `""` | Obsidian Sync remote vault name (or id). Required for a real setup. |
| `vaultPath` | string | `""` | Absolute local vault path. Required for a real setup. |
| `deviceName` | string | `""` | Device name in the sync version history; empty derives `<hostname>-headless`. |
| `configDir` | string | `".obsidian"` | Vault config directory name (a dotfolder). |
| `syncMode` | string | `bidirectional` | `bidirectional`, `pull-only`, or `mirror-remote`. |
| `nodeDir` | string | `~/.local/share/obsidian-headless/node` | Managed Node.js install directory. |
| `nodeVersion` | string | `22` | Node.js version to install when none is present. |
| `nodePath` | string | `""` | Explicit node binary to use instead of detecting/installing. |
| `packagePrefix` | string | `~/.local/share/obsidian-headless` | npm global prefix for the package. |
| `packageVersion` | string | `""` | obsidian-headless version; empty uses the npm `latest`. |
| `e2ePassword` | string | `""` | End-to-end encryption password, if the vault uses E2E. Supplied so `ob sync-setup` runs non-interactively; otherwise you are prompted for it at the pause. |
| `serviceName` | string | `obsidian-headless` | systemd user service name (no `.service` suffix). |
| `obsidianConfigDir` | string | `""` | Override the desktop app config directory (auto-detected). |

`e2ePassword` should be wired from a swamp vault rather than passed literally,
for example `--global-arg 'e2ePassword=${{ vault.get(obsidian, E2E_PASSWORD) }}'`.

## Setup

The `setup` method is the discovery step and is safe to run at any time. It is
also what the workflow calls first. Configuration is treated as precious and
cumulative:

- **Reused, not re-asked.** It reads the `config` resource this model persisted
  on a previous run and overlays your globals and inputs on top, so values you
  supplied before are never lost.
- **Persisted even when partial.** Whatever it resolves is written back to the
  `config` resource — an incomplete picture is saved, not discarded.
- **Capabilities enable progressively.** Detection works with nothing installed;
  each later step lights up as its input arrives. Supplying `vaultName` and
  `vaultPath` is enough to start.
- **Verified reality, not intent.** It tests the actual desktop registration,
  the real `core-plugins.json` flag, the resolved node and package, and the live
  account and remote vault — it does not echo the requested values back. A
  blocking gap (for example, not logged in) is stated plainly and stops the
  workflow rather than continuing and claiming success.

```sh
# Detect and persist config; prints desktop registration, in-app sync state,
# node, package, login and the resolved remote vault, and changes nothing.
swamp model @svendowideit/obsidian-headless method run setup obsidian-headless \
  --input vaultName="My Vault" --input vaultPath=/home/me/vault
```

## Examples

```sh
# Full setup for a vault, from any machine. The run pauses once: its prompt lists
# the exact commands to run on the host — `ob login` (if not logged in) and
# `ob sync-setup --vault … --path …` (so an E2E password is entered now) — and
# asks you to close the desktop app before it disables that vault's in-app sync.
swamp workflow run @svendowideit/obsidian-headless-install \
  --input vaultName="My Vault" --input vaultPath=/home/me/vault

# While it waits, do what the prompt says, then continue:
swamp workflow approve @svendowideit/obsidian-headless-install approve-setup
swamp workflow resume @svendowideit/obsidian-headless-install

# Install the tooling but leave the desktop app's in-app sync alone.
swamp workflow run @svendowideit/obsidian-headless-install \
  --input vaultName="My Vault" --input vaultPath=/home/me/vault \
  --input disableInAppSync=false

# Only install a Node runtime and the package, then stop (no vault needed).
swamp model @svendowideit/obsidian-headless method run install obsidian-headless

# Disable the in-app sync plugin for a vault directly (backup taken first);
# the workflow gates this behind approval, this does not.
swamp model @svendowideit/obsidian-headless method run disableInAppSync obsidian-headless \
  --input vaultPath=/home/me/vault

# Print the end state and how to inspect the systemd service.
swamp model @svendowideit/obsidian-headless method run print obsidian-headless
```

## Upgrade

Upgrade an existing install with the single bundled upgrade workflow. It is
idempotent and never touches the desktop app or the vault configuration: it
re-resolves the Node.js runtime, upgrades the obsidian-headless package, and
restarts the systemd service so it runs the new build. A daily trigger keeps it
current automatically.

```sh
# Upgrade Node + package in place and restart the sync service.
swamp workflow run @svendowideit/obsidian-headless-upgrade

# Pin the package version, or update the binaries without restarting the service.
swamp workflow run @svendowideit/obsidian-headless-upgrade \
  --input packageVersion=0.0.14 --input manageService=false
```

The `@svendowideit/obsidian-headless-install` workflow is also idempotent, so
re-running it is a valid upgrade path that additionally re-checks the vault and
the in-app sync state.

## Details

`@svendowideit/obsidian-headless` ships one model type,
`@svendowideit/obsidian-headless`, plus two workflows. Every method:

| Method | Arguments | Writes | Purpose |
| ------ | --------- | ------ | ------- |
| `setup` | config overrides (`vaultName`, `vaultPath`, `deviceName`, `configDir`, `syncMode`, `nodeDir`, `nodeVersion`, `packagePrefix`, `packageVersion`, `e2ePassword`, `serviceName`, `obsidianConfigDir`) | `config`, `status` | Detect host state; persist and reuse the resolved configuration. Read-only with respect to the host. |
| `installNode` | `force` | `node` | Ensure a Node.js 22+ runtime; download + SHA-256-verify the official build when none is usable. |
| `install` | `force` | `node`, `package` | Resolve Node, then install/upgrade the obsidian-headless npm package into the managed prefix. |
| `configureSync` | `force`, `e2ePassword` | `vault` | Resolve the remote vault by name and run `ob sync-setup` for the local vault, enforcing `syncMode`. Reuses an existing local config; `e2ePassword` lets it run non-interactively. |
| `disableInAppSync` | none | `inAppSync` | Rewrite the vault's `core-plugins.json` to turn the `sync` core plugin off, with a timestamped backup. |
| `print` | none | `summary` | Summarise vault, node, package, in-app sync and the systemd service. |

### Data resources

`config` (persisted settings), `status` (host snapshot), `node` (resolved
runtime), `package` (installed npm package), `vault` (remote + local sync
config), `inAppSync` (retirement result), `summary` (end state). All are stored
with `lifetime: infinite`.

### Workflows

- `@svendowideit/obsidian-headless-install` — `detect → install-node →
  install-package → approve-setup → [disable-in-app-sync] → recheck →
  configure-sync → create-service → start-service → verify`. The approval step is
  a `manual_approval` task whose prompt lists the `ob login` and `ob sync-setup`
  commands and the in-app-sync warning; the run suspends and is resumed with
  `swamp workflow approve @svendowideit/obsidian-headless-install approve-setup`
  (then `swamp workflow resume @svendowideit/obsidian-headless-install`).
- `@svendowideit/obsidian-headless-upgrade` — `install-node → install-package →
  restart-service → verify`, with a daily trigger. The systemd steps are
  `@svendowideit/systemd-service` methods against a `obsidian-headless-sync`
  instance.

### How the in-app sync detection works

The desktop app registers vaults in `obsidian.json` under its config directory
(`$XDG_CONFIG_HOME/obsidian` on Linux, `~/Library/Application Support/obsidian`
on macOS). A vault's in-app sync is the `sync` core plugin, recorded in
`<vaultPath>/.obsidian/core-plugins.json` (a `{"sync": true}` object, or a legacy
array). The extension treats in-app sync as *configured* only when **both** are
true — the vault is desktop-registered **and** the core plugin is enabled — which
is what `status.inAppSyncConfigured` reports and the workflow gates on. Disabling
rewrites the object to `sync: false` (or removes `"sync"` from the array) and
writes a `.pre-headless-<timestamp>` backup first.

### How the service is built

`createService` is called with `command` = the absolute node binary plus the
absolute `cli.js` path plus `sync --continuous`, and `workingDirectory` = the
vault path (`ob sync` with no `--path` syncs the current directory). Absolute
paths are used deliberately: a systemd user unit does not inherit the interactive
shell `PATH`, so a bare `ob` or an nvm-shell node would not resolve.

### Code structure

- `obsidian_headless.ts` — the model: zod schemas, global args, and thin
  `execute` wrappers.
- `obsidian_headless_shared.ts` — the injectable `Deps` surface (subprocesses,
  filesystem, fetch, crypto), the pure parsers/editors (`parseCorePlugins`,
  `disableSyncCorePlugin`, `parseRemoteVaults`, `pickNodeVersion`, …), and the
  builders (`detectStatus`, `ensureNode`, `ensurePackage`, `configureSync`,
  `disableInAppSyncForVault`, `buildSummary`).
- `obsidian_headless_test.ts` — unit tests driving the shared module through a
  fake `Deps`, so the suite touches no network or host.
- `obsidian-headless-install.yaml`, `obsidian-headless-upgrade.yaml` — the
  workflows, created with `swamp workflow create`.

To extend: add a parser/builder to the shared module behind `Deps` and a thin
method that calls it; keep host side effects in `Deps` so the new logic stays
unit-testable. To test:

```sh
~/.swamp/deno/deno check obsidian_headless.ts obsidian_headless_shared.ts
~/.swamp/deno/deno test obsidian_headless_test.ts
```

## License

MIT — see [LICENSE.txt](LICENSE.txt).
