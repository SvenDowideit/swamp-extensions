# @svendowideit/herdr-app

Install, update and remove the [Herdr](https://herdr.dev) desktop app — and
herdr-core with it — on Linux, macOS and Windows, from swamp, on whichever
machine swamp is running: this one, a `swamp serve` server, a swamp worker, or a
host reached over SSH that has no swamp at all.

## What it does

Herdr ships a one-line installer per platform. This extension does the same work
as swamp methods, so an install can be planned, pinned, verified, reported and
repeated:

- **Resolve** the release manifest at `releases.herdr.dev`, picking the archive
  for this host's platform (`linux-x86_64`, `linux-aarch64`, `macos-aarch64`,
  `windows-x86_64`). macOS under Rosetta resolves the arm64 build, because the
  vendor publishes no Intel Mac app.
- **Verify** every download against the SHA-256 recorded in the manifest before
  anything is extracted. A damaged download fails the run and writes nothing.
- **Place** the app exactly where the vendor's installer does: a data directory
  plus a desktop entry and icon on Linux, `Herdr.app` in `~/Applications` on
  macOS (release signature verified, or ad-hoc signed with the PATH environment
  an unsigned build needs), and `%LOCALAPPDATA%\Programs\herdr-app` with a Start
  menu shortcut and a user PATH entry on Windows.
- **Install herdr-core only when the machine has none** — the vendor's rule,
  because the app keeps the core current afterwards — or update it when you ask.
  The macOS core keeps the vendor's `Herdr Core.app` installation path and its
  release-signature check.
- **Report reality.** `status` runs the installed binaries and records the
  versions they print; the workflows read that back and fail the run when what is
  on the machine is not what was planned, rather than claiming success.

It installs no services, daemons, cron triggers or webhooks.

### The four transports

The install runs wherever the method runs, so the transport is the only
difference between these:

| Transport | Workflow | Where the install happens |
| --------- | -------- | ------------------------- |
| Local | `herdr-app-install` | this machine |
| `swamp serve` | `herdr-app-install`, run with `--server` | the server's machine |
| swamp worker | `herdr-app-worker`, run with `--server` and a `target` | the worker the step is placed on |
| SSH, no swamp there | `herdr-app-ssh`, run with `sshHosts` | every named host, via `@swamp/ssh` |

The SSH transport resolves the release once, here, then pins the version, URL
and SHA-256 for every Linux and macOS target into a POSIX installer it pipes to
each host's `sh`. Each host picks its own branch, so a mixed fleet gets the right
build; no host parses a manifest, and every host verifies the same bytes. Windows
hosts need the local, serve or worker transport.

## Install

```sh
swamp extension pull @svendowideit/herdr-app
```

`@swamp/ssh` is an **optional** dependency: pull it as well to use the SSH
workflow.

```sh
swamp extension pull @swamp/ssh
```

## Configuration

The model has no global arguments — every setting is a method argument, so
`--input` works on a direct method run and on every bundled workflow.

| Argument | Type | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `version` | string | `""` | App version to install (e.g. `0.1.14`). Empty installs the newest release. |
| `coreVersion` | string | `""` | herdr-core version to install. Empty uses the newest core. |
| `core` | `auto` \| `always` \| `never` | `auto` | `auto` installs a core only when the machine has none; `always` also updates an existing core; `never` leaves it alone. |
| `force` | boolean | `false` | Reinstall even when the target version is already installed. |
| `appDir` | string | platform default | App location. Linux `$XDG_DATA_HOME/herdr-app`, macOS `~/Applications/Herdr.app`, Windows `%LOCALAPPDATA%\Programs\herdr-app`. |
| `binDir` | string | `~/.local/bin` | Directory holding the `herdr-app` (and `hc`) commands on Linux/macOS. On Windows the app directory goes on the user PATH instead. |
| `releasesUrl` | string | `https://releases.herdr.dev` | Release host to resolve and download from. A mirror's URLs are used verbatim (no `?src=` marker). |
| `downloadDir` | string | user cache dir | Where the verified archives are staged and reused. |
| `release` | object | — | A resolved `release` resource from `plan`, so one resolution can install many hosts. |
| `uninstall` | boolean | `false` | Workflow input: remove the app instead of installing it. |
| `removeCore` | boolean | `false` | Uninstall also removes herdr-core and its `hc` alias. |

`@svendowideit/herdr-app-ssh` additionally takes:

| Argument | Type | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `sshHosts` | string | — | Comma- or newline-separated `name=address` entries, or bare addresses. Required. |
| `sshUser` | string | `""` | SSH user for every host. Empty uses your ssh config and current user. |
| `sshPort` | integer | `22` | SSH port for every host. |
| `sshIdentityFile` | string | `""` | Identity file for every host. Empty uses your ssh config and agent. |
| `sshHostKeyChecking` | `yes` \| `accept-new` \| `no` \| `off` | `accept-new` | OpenSSH host-key policy. |
| `sshName` | string | `herdr-app-ssh` | Name of the `@swamp/ssh` fleet model that runs the script. |
| `verifyCoreSignature` | boolean | `true` | Verify the macOS `Herdr Core.app` release signature. Keep on for the vendor host. |

`@svendowideit/herdr-app-worker` additionally takes `target` (required): a worker
token name or instance uuid, as shown by `swamp worker list`.

Setting `appDir` moves the app without touching the machine's launcher entry, so
a custom location never rewrites (or removes) the entry that describes the
standard one.

## Examples

```sh
# Install or upgrade on this machine. Idempotent: a machine already on the
# target version downloads nothing and reports unchanged.
swamp workflow run @svendowideit/herdr-app-upgrade

# Pin a version and install the commands into ~/bin instead.
swamp workflow run @svendowideit/herdr-app-install \
  --input version=0.1.14 --input binDir=$HOME/bin

# Ask what an install would do, and read the resolved release. Touches nothing.
swamp model @svendowideit/herdr-app method run plan herdr-app
swamp data query 'modelName == "herdr-app" && name == "release"' --select content

# Install on the server's machine, not this one.
swamp workflow run @svendowideit/herdr-app-install --server wss://swamp.x1yoga.fi.gy

# Install on one enrolled worker; the platform detected and files placed are
# that worker's, while the data lands back on the orchestrator.
swamp workflow run @svendowideit/herdr-app-worker \
  --server wss://swamp.x1yoga.fi.gy --input target=figy-miix

# Install on hosts that have no swamp, over SSH, all on the same pinned release.
swamp workflow run @svendowideit/herdr-app-ssh \
  --input sshHosts=mac-mini=192.0.2.20,studio=studio.lan

# Force a core update even though the app is current.
swamp workflow run @svendowideit/herdr-app-install --input core=always

# Read back what the installed binaries report right now.
swamp model @svendowideit/herdr-app method run status herdr-app

# Remove the app, keeping the shared herdr-core.
swamp workflow run @svendowideit/herdr-app-install --input uninstall=true
```

## Upgrade

```sh
swamp workflow run @svendowideit/herdr-app-upgrade
```

One command, and the whole upgrade: resolve the newest release, install it only
if this machine is not already on it, ensure a core exists (or update it with
`core=always`), then read the installed binaries back and fail unless the app
reports the planned version. There is nothing to migrate — the app and core are
replaced in place — and re-running is safe. To upgrade a fleet, run the worker
workflow per worker, or the SSH workflow for hosts without swamp.

## Details

### Model `@svendowideit/herdr-app`

| Method | Arguments | What it does |
| ------ | --------- | ------------ |
| `plan` | `version`, `coreVersion`, `core`, `force`, `appDir`, `binDir`, `releasesUrl` | Resolves the app and core release, probes what is installed, writes `release` and `plan`. Downloads only the two manifests. |
| `install` | the same, plus `release` and `downloadDir` | Downloads and verifies only when the version differs, places the app and (per `core`) herdr-core, writes `install`. A verification failure writes a `failed` `install` resource before the error is raised, so the run's data says what broke. |
| `status` | `appDir`, `binDir` | Runs the installed binaries and writes `status`: presence, versions, paths, app shape, and where the core was found. |
| `uninstall` | `appDir`, `binDir`, `removeCore`, `force` | Removes the app, its command link and its launcher entry or shortcut; the shared core only with `removeCore=true`. Writes `install` with action `uninstalled`. |
| `renderScript` | `version`, `coreVersion`, `core`, `force`, `releasesUrl`, `verifyCoreSignature` | Resolves the release and renders the pinned POSIX installer used by the SSH workflow — one branch per Linux/macOS target, so a mixed fleet works — and writes `script`. Windows has no branch because the script is POSIX. |
| `sshFleet` | `fleet`, `hosts`, `user`, `port`, `identityFile`, `hostKeyChecking`, `connectTimeoutSec` | Turns the host list into an `@swamp/ssh` fleet (hosts plus transport) and writes `transport`. |

Resources: `release` (resolved versions, URLs, checksums, target), `plan` (what
an install would do and why), `install` (what a run did, including a failure),
`status` (what is on the machine now), `transport` (the `@swamp/ssh` fleet), and
and `script` (the rendered installer, its targets and its pins).

### Workflows

| Workflow | Steps | Transport |
| -------- | ----- | --------- |
| `@svendowideit/herdr-app-install` | `plan` → `install` \| `uninstall` → `status` → `verify-install`, `verify-core`, `verify-uninstall` | local, or the `--server` host |
| `@svendowideit/herdr-app-upgrade` | delegates to the install workflow | local, or the `--server` host |
| `@svendowideit/herdr-app-worker` | `plan` → `install` → `status` (all placed on `target`) → `verify-install`, `verify-core` | swamp worker, via `--server` |
| `@svendowideit/herdr-app-ssh` | `assert-hosts` → `render` → `fleet` → `install` (`@swamp/ssh` `script`) | SSH to hosts without swamp |

The verify steps are asserts, not claims: `verify-install` compares the version
`status` read off the binary with the version `plan` resolved, `verify-core`
fails when a core was asked for and is still absent, and `verify-uninstall` fails
if an uninstall run left the app present.

### How the code is structured

- `herdr_app_shared.ts` — pure logic: platform selection (including Rosetta and
  the Intel-Mac refusal), manifest parsing, layout derivation, version
  comparison, the Windows PowerShell snippets, and `renderInstallScript`, the
  POSIX installer for the SSH transport. No IO, so it is all unit-tested
  directly.
- `herdr_app.ts` — the model. `hostDeps()` is the single IO seam (fetch,
  subprocess, platform, environment); `resolveRelease`, `probeInstalled`,
  `installHerdr` and `uninstallHerdr` take it as an argument, so tests run the
  real extract/verify/place path in a temporary home with a stubbed `fetch` and
  a fake version probe.

To support another platform, add its target to `TARGETS` in
`herdr_app_shared.ts`, teach `targetFor`/`layoutFor` about it, add the placement
branch in `placeExtractedApp`, and extend `renderInstallScript` if the SSH
transport should cover it too.

### Testing

```sh
~/.swamp/deno/deno check extensions/models/herdr-app/herdr_app.ts
~/.swamp/deno/deno test --allow-all extensions/models/herdr-app/herdr_app_test.ts
~/.swamp/deno/deno test --allow-all extensions/models/herdr-app/herdr_app_shared_test.ts
```

The shared tests execute the rendered SSH installer for real, with a fake `curl`
and a temporary `$HOME` on Linux/macOS, proving: it installs, it reports
`unchanged` on a second run, it refuses a host of the wrong platform, and a
damaged download fails it without leaving an app behind. The model tests drive
the same install path through `installHerdr` with real gzipped tars built in the
test.

### Caveats

- The app is delivered for `macos-aarch64` only; Intel Macs are refused by name
  with a pointer to build from source.
- Windows arm64 is not published by the vendor, so only `windows-x86_64` is
  supported.
- A macOS install verifies the release signature. A Developer ID bundle is left
  untouched; an unsigned or ad-hoc build gets the PATH environment it needs and
  is re-signed ad-hoc, because macOS privacy grants follow the signature.
- `herdr-core` is shared by every Herdr install on a machine, which is why
  `uninstall` keeps it unless `removeCore=true` is set. On macOS the core is
  installed through the vendor's own `Herdr Core.app` path, so `removeCore`
  removes the `herdr-core` launcher and the `hc` alias rather than guessing at
  the bundle's location; the app reinstalls the core it needs when it opens.
- On macOS and Windows the app's own updater keeps running after the first
  launch; this extension installs the same builds at the same paths, so either
  one updating the app is fine.
