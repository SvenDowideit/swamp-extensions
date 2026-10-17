# @svendowideit/magnitude

Install, upgrade and configure **Magnitude** (https://magnitude.dev) — the
local inference engine that serves open models over an OpenAI-compatible API —
on a Linux machine with systemd, from a declarative swamp model.

> ## ⚠️ SECURITY WARNING — THIS CAN EXPOSE MAGNITUDE ON THE NETWORK
>
> Turning on the network API (`networkEnabled=true`, a non-empty `networkHost`,
> or `network.enabled` in `config.json`) makes Magnitude listen **beyond
> loopback**; with `networkHost=0.0.0.0` it listens on **every interface**. Any
> device that can route to port **10100** then reaches Magnitude's **web UI** and
> its **OpenAI-compatible inference API**. The API requires the network access
> key (`networkApiKey`), but the UI page is served to anyone who can reach the
> port, and inference is open if the key is unset/weak or `requireApiKey` is off.
> Only enable it on a network you trust, prefer binding a single interface over
> `0.0.0.0`, always set a **long random** `networkApiKey`, and put a TLS reverse
> proxy in front as soon as you can — see [TODO](#todo).

## What it does

`@svendowideit/magnitude` owns the whole lifecycle of a Magnitude install on
the machine it runs on. It reads the installed `magnitude --version`, resolves
the newest release, and installs the right distro package for this machine
(Debian `.deb`/apt, RPM `.rpm`/dnf, Arch `.pkg.tar.zst`/pacman) only when the
version actually changed — never re-downloading a ~200 MB package for a current
machine. It then registers and turns on the **Magnitude server** (the boot
service that serves models over the network) by creating its account and data
directory and enabling the shipped systemd unit, and
writes your settings (network access, API key, bind address) to
`/var/lib/magnitude/config.json`, restarting only when they changed. Every
privileged step is delegated to `@svendowideit/sudo`'s named operations, so any
elevation route the host already grants works. It is the repeatable-swamp
alternative to hand-running `apt install` and setting the server up yourself.

Magnitude is Linux/macOS/Windows; this extension manages the **Linux** install
only (macOS and Windows ship a desktop app, not a distro package).

## Install

```sh
swamp extension pull @svendowideit/magnitude
```

Pull installs the model type and both workflows, and pulls the two declared
dependencies (`@svendowideit/github-release-install`, `@svendowideit/sudo`)
automatically — there is nothing else to install first.

## Configuration

Global arguments are set at model creation
(`swamp model create @svendowideit/magnitude magnitude --global-arg key=value`)
or edited later with `swamp model edit magnitude`. Every argument is also a
workflow `--input`.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `distro` | string | `""` | Distro family override: `debian`, `rhel` or `arch`. Empty probes `/etc/os-release`. |
| `arch` | string | `""` | Architecture override: `x86_64` or `arm64`. Empty probes `uname -m`. |
| `repo` | string | `magnitudedev/magnitude` | GitHub repository publishing the releases. |
| `version` | string | `""` | Release to install. Empty installs the latest. Pinning is best-effort (Magnitude tags releases `@magnitudedev/cli@<version>`). |
| `assetPattern` | string | Magnitude pattern | Asset-name pattern handed to `github-release-install`. |
| `githubToken` | string | `""` | Raises the GitHub API rate limit; falls back to `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`. |
| `downloadDir` | string | `~/.cache/magnitude` | Where the verified package is downloaded. |
| `stagingDir` | string | `~/.cache/magnitude/staging` | Where the root-side scripts are rendered. |
| `packageName` | string | `magnitude-desktop` | Distro package name (used for removal). |
| `serviceName` | string | `magnitude` | systemd service name (without `.service`). |
| `serviceUser` | string | `magnitude` | Run-as user for the server (created when the server is registered). |
| `configDir` | string | `/var/lib/magnitude` | Server settings, models and logs directory. |
| `manageService` | `auto`\|`true`\|`false` | `auto` | `auto` sets the server up when the package is present; `false` installs the package only. |
| `networkEnabled` | boolean | `false` | Turn on the network (LAN/remote) API in `config.json`. **Exposes it — see the warning at the top.** |
| `networkApiKey` | string | `""` | Bearer key the network API requires. Empty leaves any existing key untouched. Use a long random value. |
| `networkHost` | string | `""` | Address the network API binds (`network.bind`, one IP of this machine). Empty binds all interfaces; `0.0.0.0` means every interface. **Exposes it — see the warning at the top.** |
| `sudoInstanceKey` | string | `default` | Instance key of the `@svendowideit/sudo` model the workflow elevates through. |
| `sudoAllowedOperations` | string[] | standard set | Operation allowlist passed to the sudo model for each step. |
| `force` | boolean | `false` | Reinstall even when the target version is already installed. |

### Getting the network access key

When you enable the network API you need its key to use it. There are three ways
to know it, in order of preference:

1. **You chose it.** If you ran with `--input networkApiKey=<long-random>`, that
   value *is* the key — the extension wrote it to `/var/lib/magnitude/config.json`
   and never stores it in swamp data.
2. **Read it from the server** (it lives only there, owned by the `magnitude`
   service account, so it needs root):

   ```sh
   sudo cat /var/lib/magnitude/config.json      # the key is "network"."apiKey"
   ```

   If `jq` is installed: `sudo jq -r '.network.apiKey' /var/lib/magnitude/config.json`.
   `magnitude status` never prints the key.
3. **From the browser UI.** Sign in to `http://<server>:10100` with the key and it
   is shown under **Settings → Network access**.

Clients then present it as a bearer token. For an agent or OpenAI-compatible app:

```sh
# Base URL: <server>:10100/inference/v1   ·   API key: the network access key
curl http://10.10.10.141:10100/inference/v1/models \
  -H "Authorization: Bearer <network-access-key>"
```

`x-api-key: <network-access-key>` is accepted too. To rotate the key, re-run the
workflow with a new `--input networkApiKey=<long-random>`; it rewrites the settings
and restarts the service.

### Setup

The `setup` method runs at the start of a reconciled run and is the discovery
half of the config lifecycle: it reads `/var/lib/magnitude/config.json` and the
previously persisted `settings` resource, merges any settings you pass over
what it found, and writes the effective values — partial values included — back
to the `settings` resource so the next run reuses them instead of asking again.
It reports which capabilities are enabled (`installed`, `configured`,
`network-api`) and whether an API key is set, but never stores the key itself:
that lives only in `config.json` on the host. `setup` changes nothing on the
host; the `@svendowideit/magnitude-install` workflow applies the settings as a
privileged step (the setup script, which also applies the settings), and stops at the
failing step with the exact commands to run by hand when no elevation route is
granted — rather than half-applying changes and claiming success. A run reports
the version it verified on the machine, never a desired state it did not reach.

```sh
# Discover and persist the server settings (read-only: nothing on the host changes).
swamp model @svendowideit/magnitude method run setup magnitude
```

## Examples

Install or upgrade Magnitude and register its server. This is the entry point to
reach for; re-running it is an idempotent no-op when nothing changed:

```sh
swamp workflow run @svendowideit/magnitude-install
```

Turn on the network API, set its key and bind it to the LAN. The settings are
written to `/var/lib/magnitude/config.json` and the service restarted:

```sh
swamp workflow run @svendowideit/magnitude-install \
  --input networkEnabled=true \
  --input networkApiKey=mag_examplekey --input networkHost=0.0.0.0
```

Read the installed version and the exact status command without changing
anything:

```sh
swamp model @svendowideit/magnitude method run sync magnitude
swamp model @svendowideit/magnitude method run print magnitude
```

Remove Magnitude again, keeping the downloaded models and settings:

```sh
swamp workflow run @svendowideit/magnitude-install --input uninstall=true
```

## Upgrade

Upgrading is one idempotent command with nothing to pass — install and upgrade
are the same reconciled loop:

```sh
swamp workflow run @svendowideit/magnitude-upgrade
```

It reads the installed `magnitude --version`, resolves the newest release,
installs the verified package only when the version actually changed, re-runs
re-registers the server and re-applies your saved settings, restarting the
service only when the package, unit or settings moved. It collects nothing it
cannot infer (the distro, architecture, package and paths all come from `plan`),
so there is no model name or secret to supply; it ends on verified reality by
printing the version now on the machine. Because every step is idempotent,
re-running is safe.

## Details

`@svendowideit/magnitude` ships one model type (`@svendowideit/magnitude`) and
two workflows: `@svendowideit/magnitude-install` (the full install/upgrade/
uninstall loop) and `@svendowideit/magnitude-upgrade` (a thin, documented entry
point that delegates to it). Release resolution and the checksum-verified
download are delegated to `@svendowideit/github-release-install`; every
privileged step runs through `@svendowideit/sudo`'s `sudo-run` workflow.

### Methods

| Method | Arguments | What it does |
| ------ | --------- | ------------ |
| `setup` | `networkEnabled?`, `networkApiKey?`, `networkHost?`, `binaryPath?` | Detect the server's current settings, merge supplied settings over them, and persist them to the `settings` resource (never the key). Writes `settings`. |
| `plan` | `distro?`, `arch?` | Resolve the distro family, architecture, package format/manager, the release-asset filter and every install/service path. Writes the `platform` resource. |
| `privilege` | — | Report how this run can escalate to root and, when it cannot, the exact commands to run by hand. Writes `privilege`. |
| `sync` | `path?`, `repo?`, `githubToken?`, `checkLatest?` | Locate `magnitude`, run `magnitude --version`, optionally resolve the latest release, and record installed + latest. Writes `installed`. |
| `assess` | `latestVersion`, `force?` | Compare the installed version with the resolved release and decide whether an update is available. Writes `assessment`. |
| `renderScripts` | `networkEnabled?`, `networkApiKey?`, `networkHost?`, `binaryPath?` | Render the root-side server scripts (setup, remove, settings) into `stagingDir`. Runs on every run. Writes `scripts`. |
| `stage` | `packagePath`, `packageName?`, `checksum?`, `manager?` | Verify the package's SHA-256 and render its install script into `stagingDir`. Writes `stage`. |
| `install` | `packagePath?`, `manager?`, `force?` | Install/upgrade the package with the host's package manager (the machine-local path; the workflow uses the sudo ladder). Writes `install`. |
| `serverSetup` | `binaryPath?`, `force?` | Register and start the server non-interactively (magnitude account, data directory, unit). Writes `server`. |
| `configure` | `networkEnabled?`, `networkApiKey?`, `networkHost?`, `restart?` | Write `/var/lib/magnitude/config.json` and restart. Writes `config`. |
| `service` | — | Report the systemd unit's active/enabled state. Writes `service`. |
| `uninstall` | `removePackage?`, `purgeData?` | Stop/remove the service and, optionally, the package and `/var/lib/magnitude`. Writes `uninstall`. |
| `print` | — | Log the stored installed/service summary and the status command. Writes `summary`. |

Resources (`settings`, `platform`, `privilege`, `installed`, `assessment`,
`scripts`, `stage`, `install`, `server`, `config`, `service`, `uninstall`,
`summary`) are
versioned swamp data; reference them with CEL, e.g.
`data.latest("magnitude", "platform").attributes.format`.

### Prerequisites and caveats

- **systemd and a Linux distro package.** The extension installs the package
  with apt/dnf/pacman and turns the shipped `magnitude.service` on. It is a
  no-op on unsupported distros, reporting the resolved family.
- **glibc 2.34+** (Ubuntu 22.04+, Debian 12+, RHEL 9+), as Magnitude requires.
- **Elevation.** The install needs root; the run uses whatever route
  `@svendowideit/sudo` proves. When none is granted, the failing step prints the
  ladder and the manual `apt-get` / `systemctl enable --now magnitude.service` equivalents.
- **The client is available to any account** on the machine after install
  (`/usr/bin/magnitude`); the models, settings and keys stay readable only by
  the `magnitude` service account.

### Developing and testing

```sh
# Type-check and unit-test the pure helpers and the model methods.
~/.swamp/deno/deno check magnitude.ts
~/.swamp/deno/deno test --allow-env --allow-read --allow-write --allow-run \
  magnitude_shared_test.ts magnitude_test.ts

# Score the documentation and code metrics.
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/models/magnitude/manifest.yaml
```

`magnitude_shared.ts` holds the pure helpers (distro/arch detection, asset-name
parsing, version handling, privilege and script/settings rendering) so they unit
test in isolation; `magnitude.ts` holds the model (schemas, resources, methods),
with `magnitude_test.ts` driving the real executes through a mocked command
layer. To extend it — for example to add macOS support or a `magnitude models`
sub-model — add a method to the model, a resource schema for its output, a step
to `magnitude-install.yaml`, and a test alongside the others.

## TODO

- **Revert the LAN exposure.** `p1gen4` currently binds `0.0.0.0`, so Magnitude's
  UI and API are reachable on the LAN (see the warning at the top). As soon as the
  reverse-proxy path below exists, set the bind back to loopback — leave
  `networkHost` empty or `127.0.0.1` — so only the proxy is exposed.
- **Front Magnitude with Caddy at `magnitude.<host>.<zone>`.** Add a reverse-proxy
  route (Caddy → `127.0.0.1:10100`) with automatic DNS and TLS, so the API and UI
  are reached over HTTPS on a named host instead of a plain LAN port. The
  `@svendowideit/caddy` extension's `ensureDnsProxy` is the intended tool — the
  same pattern the `kolibri-eieio` workflow uses, run as a job that lands on the
  same worker as the server.

## License

MIT — see LICENSE.txt.
