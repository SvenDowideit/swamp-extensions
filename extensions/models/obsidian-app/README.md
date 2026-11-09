# @svendowideit/obsidian-app

Install, update and configure the Obsidian desktop app **and its official CLI**
on Linux, rootlessly, from Obsidian's own release assets.

This README is the extender/maintainer reference. The manifest carries the user
manual; this document explains the structure, every method, and how to change or
test the extension.

## What it does

Obsidian's in-app updater replaces the app package (`resources/app.asar`) but
**not the installer**. A machine can therefore run a recent Obsidian from an old
installer — and the Obsidian CLI ships *inside the installer* (1.12.7+), so the
"Command line interface" setting never appears and `obsidian` is either missing
or resolves to the GUI binary. This extension fixes that end of the problem:

1. **Installs the real installer.** It resolves the newest desktop release
   through [`@svendowideit/github-release-install`](https://github.com/svendowideit/swamp-extensions),
   picks this machine's archive (`obsidian-<version>.tar.gz`, or
   `obsidian-<version>-arm64.tar.gz`), verifies the bytes against the SHA-256
   digest GitHub publishes for that asset, and unpacks it under
   `~/.local/share/obsidian` — no root, no system package, no Node runtime.
2. **Registers the CLI** the way Obsidian's own Linux registration does: it
   copies the installer's `obsidian-cli` to `~/.local/bin/obsidian` (mode 755),
   turns the app's `"cli": true` setting on in `obsidian.json` (with a
   timestamped backup, and only while the app is not running, because the app
   rewrites that file on exit), and reports which directory on `PATH` would
   actually answer `obsidian`.
3. **Makes sure it can actually start.** Obsidian is Electron, so Chromium
   builds a sandbox before the app runs: unprivileged user namespaces, or the
   setuid helper `chrome-sandbox` (root-owned, mode 4755). Ubuntu 23.10+ denies
   user namespaces to unconfined binaries, so a tarball unpacked by your own user
   has no working route and the app aborts with
   `FATAL:setuid_sandbox_host.cc:166`. The install workflow starts the app to
   find out, fixes the helper through `@svendowideit/sudo` (exactly what
   Obsidian's own .deb postinst does), and fails the run — with the precise
   `sudo install -D -m 4755 …` command — if it still cannot start. Optional
   routes: an AppArmor profile (`sandbox=apparmor`, no root-owned binary) or an
   explicit `--no-sandbox` wrapper (`sandbox=no-sandbox`, sandboxing off).
4. **Reports verified reality.** It reads back the recorded installer version,
   the `obsidian-<version>.asar` package the app updated itself to, the real
   `cli` flag, the CLI file's executable bit, and — when the app is running —
   runs `obsidian version` and compares the installer version the app reports
   with the one on disk. An old system package shadowing the CLI is named, not
   papered over.

Sync is deliberately out of scope: pair it with
`@svendowideit/obsidian-headless`, which installs the official Sync client and
retires the desktop app's in-app sync for the vault it takes over.

## Install

```sh
swamp extension pull @svendowideit/obsidian-app
```

The single pull also installs the declared `@svendowideit/github-release-install`
dependency.

## Prerequisites

- **Linux, x86_64 or arm64.** macOS and Windows are out of scope; use Obsidian's
  own installers there.
- **`tar` on `PATH`** (GNU tar, standard on Linux) for unpacking the release.
- **Obsidian 1.12.7+ installer** for the CLI itself. The installer is what ships
  `obsidian-cli`; an older system package has no CLI binary at all.
- **A working Chromium sandbox.** The app will not run without one. The install
  workflow arranges it (`sandbox=auto` fixes `chrome-sandbox` through
  `@svendowideit/sudo`; `sandbox=apparmor` stages a profile instead), and fails
  loudly when it cannot — see [Sandbox](#sandbox).
- **The CLI needs the app running.** It is a remote control for the desktop app,
  not a headless tool: with no app running, the first CLI command launches the
  app. That is why `registerCli` only executes `obsidian version` when the app is
  already up, and says so when it is not.

## Configuration

Set global arguments when the model instance is created
(`swamp model create @svendowideit/obsidian-app obsidian-app --global-arg key=value`),
or override per call with `--input`. The workflow inputs use the same names.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `installMode` | string | `tar` | Installer to use. `tar` is the official rootless tar.gz build and the only implemented mode; anything else fails with an explanation. |
| `installDir` | string | `~/.local/share/obsidian` | Where the installer is unpacked. |
| `cliDir` | string | `~/.local/bin` | Where `obsidian` is registered. |
| `appConfigDir` | string | `$XDG_CONFIG_HOME/obsidian` | The app's config directory (holds `obsidian.json`). |
| `downloadDir` | string | `~/.cache/obsidian-app` | Where the verified archive is staged. |
| `desktopEntry` | boolean | `true` | Write `$XDG_DATA_HOME/applications/obsidian.desktop` pointing at `installDir`, so the menu launches *this* installer rather than a stale system package. |
| `enableCli` | boolean | `true` | Turn the app's `cli` setting on. Skipped (and reported) while the app is running. |
| `sandbox` | string | `auto` | How to make Chromium's sandbox work: `auto`/`setuid` fix `chrome-sandbox` root-owned mode 4755 through `@svendowideit/sudo`; `apparmor` stage a profile to load; `no-sandbox` run with `--no-sandbox` (opt-in); `report` change nothing. |
| `repo` | string | `obsidianmd/obsidian-releases` | Repository publishing the installers (for a mirror or fork). |

Workflow-only inputs: `version` (pin a release), `force` (reinstall and
re-register unconditionally). Model-method-only inputs are documented per method
below.

## Setup

`setup` is the discovery step, and it changes nothing on the host. It reads the
`config` resource this model persisted on a previous run and layers the model's
global arguments and the method inputs over it, so **config is cumulative and
never asked for twice**. Anything supplied now is persisted even when the picture
is incomplete (for example: an `installDir` on a host with no install yet), and
`install` and `registerCli` persist the resolved config they actually used, so a
later upgrade with no inputs reuses those paths rather than the defaults.

Capabilities light up progressively from that config:

| Config present | What the methods can then do |
| -------------- | ---------------------------- |
| nothing | `setup` still reports platform, arch, any system package, the app package on disk, and the CLI state |
| `installDir` + a release | `plan` and `install` can unpack a verified installer |
| an install shipping `obsidian-cli` | `registerCli` can register and verify the CLI |
| `appConfigDir` | `registerCli` can read and set the `cli` setting |

`setup` reports **verified reality**, never the requested values: the installer
version comes from the marker this extension writes, the app package version from
the `obsidian-<version>.asar` files the app itself left in its config directory,
the `cli` flag from re-parsing `obsidian.json`, and `obsidian` resolution from
probing each `PATH` directory in order. It ends with the commands that still
need a person (retire the old system package, fix `PATH`, quit and reopen the
app). A blocking failure is stated and the run stops — it is never swallowed.

```sh
# Discovery run: read the host, persist the resolved config, change nothing.
swamp model @svendowideit/obsidian-app method run setup obsidian-app
```

## Sandbox

Obsidian is Electron, so Chromium establishes a sandbox before the app starts.
It has two routes on Linux:

1. **Unprivileged user namespaces** — the process calls `clone(CLONE_NEWUSER…)`
   itself. Preferred, needs no privileges. Ubuntu 23.10+ sets
   `kernel.apparmor_restrict_unprivileged_userns=1`, which denies this to
   unconfined binaries; verify with
   `unshare -U --map-root-user true` (fails with `Operation not permitted` when
   restricted).
2. **The setuid helper** — `chrome-sandbox`, a small binary that must be
   `root:root` with mode `4755`. Chromium uses it when route 1 is unavailable.
   The `.deb` gets this from its postinst; a tarball unpacked by a normal user
   cannot, so the helper is present but useless, and Chromium refuses to run
   rather than run unsandboxed:

   ```
   [FATAL:setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found,
   but is not configured correctly. Rather than run without sandboxing I'm
   aborting now. You need to make sure that <installDir>/chrome-sandbox is owned
   by root and has mode 4755.
   ```

`sandbox` decides what to do about it, and the install workflow does it:

| Route | What happens | Privileges |
| ----- | ------------ | ---------- |
| `auto` (default) | Resolves to `setuid`. | one `installFile` through `@svendowideit/sudo` |
| `setuid` | A user-owned copy is staged at `<installDir>/.chrome-sandbox.stage`; `@svendowideit/sudo` runs `install -D -m 4755` from it, so the helper becomes `root:root 4755`. The staged copy is removed by `verifySandbox`. | one `installFile` through `@svendowideit/sudo` |
| `apparmor` | Writes `<installDir>/obsidian.apparmor` (an unconfined profile with `userns,`) and prints the two commands to load it: `sudo install -D -m 644 … /etc/apparmor.d/obsidian` then `sudo apparmor_parser -r /etc/apparmor.d/obsidian`. Use it when you would rather not have a root-owned binary on disk. Upgrades never touch it. | a person runs two commands |
| `no-sandbox` | Writes `<installDir>/obsidian-no-sandbox` (`exec <binary> --no-sandbox "$@"`) and points the desktop entry at it. **Renderer sandboxing is off**; opt-in only. | none |
| `report` | Changes nothing; only records what is wrong and the command to fix it, so the final check fails. | none |

Why `auto` picks `setuid`: it is the only route that is a single, typed,
non-interactive elevation (`@svendowideit/sudo`'s `installFile` operation, which
never prompts), it works on every distro, and it is what Obsidian's own packages
ship. `@svendowideit/sudo` finds whatever elevation the host already grants; when
there is none, `fix-sandbox` fails (it is `allowFailure: true`), `sandbox-check`
re-probes, and the run fails naming the exact command.

A few details worth knowing:

- **Upgrades never fight the fix.** `installArchive` passes
  `--exclude=*/chrome-sandbox` whenever a helper already exists, because
  extracting the archive's user-owned copy over a root-owned `4755` file fails
  outright. Chromium's helper is version-independent (Debian ships it as its own
  package), so keeping it is correct — and it means a fixed machine needs no
  privileges again on upgrade.
- **The probe is a real launch.** `sandbox` and `verifySandbox` run
  `<installDir>/obsidian --version` with a 12 s timeout; it prints the CLI usage
  and exits on a healthy install, or — with no instance running in a desktop
  session — starts the app for real and is killed by the timeout. A timeout counts as *started* (a GUI answered
  by opening a window) because a sandbox refusal aborts immediately, and
  Chromium's two FATAL strings are matched exactly rather than guessed from the
  exit code.
- **A launch that fails for another reason is not blamed on the sandbox.** When
  the probe fails without either FATAL, it is repeated with `--no-sandbox`: if
  that fails identically the session simply has no display (a swamp workflow
  over ssh has no `DISPLAY`, and Obsidian logs `Loaded main app package …` then
  exits 1), so the sandbox is reported as *correct* with the app's own line
  quoted; if it succeeds only with the sandbox off, the sandbox is the blocker
  even when the wording changes. So a run over ssh says "sandbox correct, launch
  not confirmed in this session" rather than a false failure — start Obsidian in
  your desktop session to watch it come up.
- **`setup` does not launch anything.** It reports the helper's uid and mode and
  whether user namespaces are restricted, so a broken host is visible before
  anyone tries to start the app.

## Examples

```sh
# Install Obsidian and its CLI on a fresh machine, or upgrade an existing one —
# the same command works out which — with the defaults: ~/.local/share/obsidian
# for the app, ~/.local/bin/obsidian for the CLI, latest release.
swamp workflow run @svendowideit/obsidian-app-upgrade

# Pin a release and put both the app and the CLI somewhere else — useful on a
# shared machine, or to roll back a bad release.
swamp workflow run @svendowideit/obsidian-app-upgrade \
  --input version=1.15.0 --input installDir=~/opt/obsidian --input cliDir=~/bin

# See what the host actually has before changing anything: installer version,
# app package, system package, CLI registration and PATH resolution.
swamp model @svendowideit/obsidian-app method run setup obsidian-app

# Register (or re-register) the CLI after installing by hand — for example
# after extracting the tar.gz yourself, or to repair a missing ~/.local/bin/obsidian.
swamp model @svendowideit/obsidian-app method run registerCli obsidian-app

# Upgrade to whatever is latest (or nothing, when already current), and
# re-register the CLI against the new build.
swamp workflow run @svendowideit/obsidian-app-upgrade

# Prove the app starts without changing anything: starts it once with --version
# and records why Chromium refused, if it did. The fix is staged, not applied.
swamp model @svendowideit/obsidian-app method run sandbox obsidian-app

# Fix a broken sandbox with no root-owned binary: stage the AppArmor profile,
# then run the two commands the step prints.
swamp workflow run @svendowideit/obsidian-app-upgrade --input sandbox=apparmor

# Last resort on a machine whose sandbox cannot be fixed: run the app through a
# wrapper that passes --no-sandbox, and point the launcher at it.
swamp workflow run @svendowideit/obsidian-app-upgrade --input sandbox=no-sandbox
```

## Methods

Every method on `@svendowideit/obsidian-app`:

| Method | Arguments | What it does |
| ------ | --------- | ------------ |
| `setup` | `installMode`, `installDir`, `cliDir`, `appConfigDir`, `downloadDir`, `sandbox`, `repo` (strings, empty keeps the persisted value), `desktopEntry`, `enableCli` (booleans, omit to keep) | Detects the host state — install, app package, system package, CLI, PATH resolution, the sandbox helper's uid/mode and whether user namespaces are restricted — and persists the resolved `config`. Writes `config` and `status`. Reads only; never launches the app. |
| `plan` | `releaseModel` (default `github-release`), `arch` (empty probes the host) | Reads the peer release's `release` resource, picks this platform's installer archive, and records `asset` (URL, size, version, digest). Fails when the release ships no matching archive, or when the release came from a different repository than `repo`. |
| `install` | `archivePath`, `archiveName`, `version`, `checksum`, `force` | Verifies the archive's SHA-256 (when a checksum is given), unpacks it under `installDir` (with `--exclude=*/chrome-sandbox` when a helper already exists, so a setuid one survives), verifies `obsidian`, `obsidian-cli` and `resources/app.asar` are all present, records the version in `.swamp-obsidian-app.json`, and writes the desktop entry. Idempotent: skips when that version is installed unless `force`. Writes `config` and `install`. |
| `registerCli` | `sourcePath` (empty uses the install's own `obsidian-cli`, then `/opt/Obsidian/obsidian-cli`), `force` | Copies the CLI to `cliDir/obsidian` with mode 755, turns the app's `cli` setting on (backup, app-closed only), reports PATH shadowing, and verifies with `obsidian version` when the app runs. Writes `config` and `cli`. |
| `sandbox` | — | Starts the app once with `--version` and records whether Chromium let it run. Stages the fix it can make without privileges: the setuid helper copy at `.chrome-sandbox.stage` (with the `installFile` arguments for the privileged step), the AppArmor profile, or the `--no-sandbox` wrapper. Removes a stale wrapper when the sandbox works again. Writes `config` and `sandbox`. |
| `verifySandbox` | — | Re-probes the app *after* the privileged step, removes the staged helper, and **throws** — failing the workflow — when the sandbox is still broken, with the exact host command in the message. A correct helper in a session with no display passes with a note. Writes `sandbox`. |
| `print` | — | Re-reads the host and writes `summary`: installer version and path, app package version, the registered CLI, how `obsidian` resolves, whether it answered, whether the sandbox lets the app start, and every outstanding note. |

Resources: `config`, `status`, `asset`, `install`, `cli`, `sandbox`, `summary`.

## Workflows

- `@svendowideit/obsidian-app-upgrade` — the **one** lifecycle workflow:
  `fetch-release` (github-release-install `check`, no checksums file for
  Obsidian) → `plan` → `download` (verified) → `install-app` →
  `register-cli` → `sandbox` → `fix-sandbox` (guarded, runs
  @svendowideit/sudo's `installFile`) → `sandbox-check` → `print`. On a machine
  with no install it installs; on one with an older version it upgrades in
  place; on one that is current it unpacks, copies and elevates nothing. It
  carries a `0 5 * * *` trigger so the machine stays current; delete the
  `trigger:` block to run it by hand only.

Obsidian publishes **no checksums file**, so the workflows call `check` with
`fetchChecksums=false, requireChecksum=false` and rely on the per-asset SHA-256
`digest` GitHub's releases API returns; `download` refuses an archive whose bytes
do not match, and `install` re-verifies the same hash before unpacking.

## Upgrade

```sh
# Install on a machine with nothing installed, or upgrade one that has an older
# version — the same command, and it decides which. Safe to re-run.
swamp workflow run @svendowideit/obsidian-app-upgrade
```

There is no separate install workflow: `@svendowideit/obsidian-app-upgrade` is
the one lifecycle workflow, and it decides what to do from the host it finds. It
uses the config persisted by a previous run, so there is no model name, path or
vault to pass. It resolves the latest release, unpacks only when the version
changed (unless `force`), re-registers the CLI so `obsidian` matches the new
build, and proves the app starts. Re-running it on an up-to-date machine changes
nothing. A daily trigger does this automatically; remove `trigger:` from
`obsidian-app-upgrade.yaml` if you would rather drive it by hand.

After an upgrade while Obsidian was running, the `print` step compares the
installer version the running app reports with the one now on disk and says to
quit and reopen it — a green run never implies the running app is already on the
new installer.

## Details

- **Layout.** `obsidian_app_shared.ts` holds the pure helpers, the host side
  effects behind the `Deps` interface, and the resource builders;
  `obsidian_app.ts` holds the zod schemas and thin `execute` wrappers. Every
  branch worth testing lives in the shared module, driven through a fake `Deps`.
- **One lifecycle workflow.** `obsidian-app-upgrade.yaml` is both the install and
  the upgrade path — there is no `-install` workflow that can drift from it. The
  decision is made by the steps themselves, never by a flag: `install` skips when
  the marker records the wanted version, `registerCli` re-copies only when the
  bytes differ, `sandbox` probes and stages only when the helper is wrong, and
  `fix-sandbox` is guarded on `sandbox.sudoRequired`.
- **The marker.** `installDir/.swamp-obsidian-app.json` records
  `{version, archiveName, checksum, mode, installedAt}`. It is what makes
  `install` idempotent and what `setup` reports as the installer version — the
  app's own `obsidian-<version>.asar` files track the *app package*, which
  Obsidian updates without touching the installer.
- **Rootless for everything but the sandbox.** The install itself writes only
  under the user's `~/.local`, `~/.cache` and `~/.config`, and no `dpkg` path is
  used: a system package at `/opt/Obsidian` is detected and reported with the
  exact `sudo apt remove obsidian` command, never removed here. The single
  privileged action is the sandbox helper's owner and mode, because Chromium
  will not run without it; it goes through `@svendowideit/sudo` (typed
  `installFile`, no prompting), and `sandbox=apparmor` avoids it entirely.
- **The sandbox files.** `<installDir>/chrome-sandbox` (root-owned `4755` after
  the fix — Chromium's helper, not ours), `<installDir>/.chrome-sandbox.stage`
  (the user-owned copy that step installs from, removed by `verifySandbox`),
  `<installDir>/obsidian.apparmor` (`sandbox=apparmor`), and
  `<installDir>/obsidian-no-sandbox` (the `--no-sandbox` wrapper).
- **Why the CLI is a copy, not a symlink.** Obsidian's Linux registration copies
  `obsidian-cli` into a persistent directory because some install locations
  (AppImage, snap, temporary mounts) cannot be symlinked durably. This extension
  follows that rule, so the registered `obsidian` survives re-unpacking.
- **PATH shadowing.** `~/.local/bin` normally precedes `/usr/bin`, so the CLI
  wins — but not always. `registerCli` probes each `PATH` entry and reports the
  first one that would answer `obsidian`; when that is a GUI binary it says which
  file and how to fix the order.
- **Testing.** `~/.swamp/deno/deno test --allow-all extensions/models/obsidian-app/obsidian_app_test.ts`
  runs the unit suite (in-memory filesystem, scripted subprocesses, no root and
  no network). Type-check with `~/.swamp/deno/deno check` on both sources and the
  test file, and validate the workflows with
  `swamp workflow validate @svendowideit/obsidian-app-upgrade`.
- **Extending.** A new install mode (deb, AppImage) is a new
  `INSTALL_MODES` entry, an asset pattern in `assetPatternFor`, and a branch in
  `installArchive`; the CLI registration, status and summary code stay as they
  are because they read the install's own layout.
