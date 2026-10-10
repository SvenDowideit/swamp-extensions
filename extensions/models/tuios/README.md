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
  restarts it after an upgrade, installs the bundled themes and picks a default
  if you have none, and prints where the binary landed and the exact
  `systemctl --user status` command.
- **How do I theme it?** Two themes ship with the extension — **Swamp Club**
  (neon green on near-black) and **Borland Modern Blue** (the classic turbo
  palette). `installTheme` writes a theme by id, from an inline JSON document,
  or from a file; `setTheme` makes one active by setting `appearance.theme` in
  `config.toml`. The reusable `@svendowideit/tuios-theme` workflow wraps both.
- **What do all those colours actually mean?** `renderThemeReport` writes a
  self-contained HTML page documenting every colour a theme sets and what each
  one is used for — the 16 ANSI slots with their roles and measured contrast,
  the interface accents TUIOS derives from them (or the theme's own `chrome`
  values), the dialog ramp with its ink tiers, and the selection colours.
  Defaults to the currently selected theme.

Side effects: outbound HTTPS reads from `api.github.com` and the release
download URL (nothing is written there); install writes a binary into
`/usr/local/bin`, `~/.local/bin` or `~/bin` and stages the verified archive
under the download directory; the workflow writes a systemd user unit, enables
lingering when `manageService` is true, and writes theme files plus the
`appearance.theme` line in `config.toml` when `installThemes` is true.
`renderThemeReport` writes one HTML file into the TUIOS cache directory.

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
| `installThemes` | boolean | `true` | Install the bundled themes and select a default when the user has none. |
| `defaultTheme` | string | `swamp_club` | Theme to select when `config.toml` has no `appearance.theme` yet. |
| `githubToken` | string | `""` | Token for the releases API (avoids the 60/hour anonymous limit). Empty falls back to `GITHUB_TOKEN`, `GH_TOKEN`, then the authenticated `gh` CLI. |

### `tuios-installed` global arguments

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `path` | string | `""` | Path to the `tuios` binary. Empty auto-detects from `PATH` and the usual install locations; when set it is authoritative. |
| `flavor` | `std` \| `ghostty` | `std` | Build flavor being tracked (reporting only; the archive is chosen by the release workflow). |
| `serviceName` | string | `tuios` | systemd user service name, used to print the `systemctl --user status` command. |

### Themes — `tuios-installed` methods

TUIOS loads `<id>.json` files from its themes directory and re-reads the
directory on every call, so a freshly written theme is selectable immediately,
with no restart. By default the directory is `$XDG_CONFIG_HOME/tuios/themes`,
falling back to `~/.config/tuios/themes`; both are overridable per call.

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `installTheme` | `themeId`, `themeJson`, `sourcePath`, `themesDir`, `select`, `force`, `configPath` | `theme` — where the theme landed, whether it changed, and whether it was selected. |
| `setTheme` | `themeId`, `configPath` | `themeSelection` — the previous theme and whether `config.toml` changed. |
| `installBundledThemes` | `themes`, `themesDir`, `defaultTheme`, `force`, `configPath` | `themes` — the ids installed vs already present, and the theme now selected. |
| `renderThemeReport` | `themeId`, `themesDir`, `configPath`, `outputPath`, `open` | `themeReport` — the theme's display name, the HTML path, byte size, the slots below their contrast floor, and whether it was opened. |

`installTheme` resolves its content in this order: inline `themeJson` → a
`sourcePath` file → the bundled theme of the same id. A non-bundled id with no
content is an error, and a document with no string `id` is refused rather than
written. `setTheme` writes the `appearance.theme` line in `config.toml`,
creating the file and the `[appearance]` table if needed.

`renderThemeReport` resolves the theme to document in this order: `themeId` →
the `appearance.theme` line in `config.toml`. It reads the theme file directly
(which carries any `chrome` object), and falls back to `tuios list-themes <id>
--json` for a built-in theme that has no file. The accents and dialog ramp are
derived with the same WCAG-contrast and OKLab maths TUIOS uses, so the page
shows what TUIOS actually draws. It writes `<cache>/tuios/theme-<id>.html`
(`$XDG_CACHE_HOME`, else `~/.cache`) unless `outputPath` is given, and with
`open=true` opens it in the default browser.

`installBundledThemes` is what the install workflow runs. It writes both bundled
themes, then selects `defaultTheme` (Swamp Club) **only if** `config.toml` has
no `appearance.theme` — a theme the user has already chosen is never
overwritten.

### Workflow — `@svendowideit/tuios-theme`

A reusable two-step workflow for another workflow to call.

| Input | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `themeId` | string | `swamp_club` | Theme id to install and/or select. |
| `themeJson` | string | `""` | Inline theme JSON to write. |
| `sourcePath` | string | `""` | Theme JSON file to install when `themeJson` is empty. |
| `themesDir` | string | `""` | Override the themes directory. |
| `configPath` | string | `""` | Override the `config.toml` path. |
| `select` | boolean | `true` | Also set `appearance.theme` to `themeId`. |
| `force` | boolean | `false` | Rewrite the theme file even when identical. |

Steps: `install-theme → select-theme`. `install-theme` is skipped when there is
nothing to write (no `themeJson`/`sourcePath` and a non-bundled id), so the
workflow doubles as a pure selector.

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

# Install a bundled theme and make it active — the reusable theme workflow
# wraps installTheme + setTheme, so another workflow can do this in one call.
swamp workflow run @svendowideit/tuios-theme --input themeId=borland_modern_blue

# Install a theme from an inline document (and select it).
swamp workflow run @svendowideit/tuios-theme \
  --input themeId=solarized \
  --input themeJson='{"id":"solarized","bg":"#002b36","fg":"#839496"}'

# Install a theme from a file without changing which theme is active.
swamp workflow run @svendowideit/tuios-theme \
  --input themeId=my_theme --input sourcePath=~/my_theme.json --input select=false

# Document the currently selected theme's colours: writes a self-contained HTML
# page (open it in any browser — no network) listing every colour and its role.
swamp model @svendowideit/tuios-installed method run renderThemeReport tuios-installed

# Document a named theme (bundled or built-in) and open it straight away; ask
# where it landed and which slots fall below their contrast floor.
swamp model @svendowideit/tuios-installed method run renderThemeReport \
  tuios-installed --input themeId=borland_modern_blue --input open=true
swamp data get tuios-installed theme-report --json

# Write just the bundled themes and pick a default only if none is set (the
# step the install workflow runs); ask what ended up installed and selected.
swamp model @svendowideit/tuios-installed method run installBundledThemes tuios-installed
swamp data get tuios-installed themes --json

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
| `@svendowideit/tuios-installed` | `installTheme` | `themeId`, `themeJson`, `sourcePath`, `themesDir`, `select`, `force`, `configPath` | `theme` — file path, changed flag, and whether it was selected. |
| `@svendowideit/tuios-installed` | `setTheme` | `themeId`, `configPath` | `themeSelection` — previous theme and whether `config.toml` changed. |
| `@svendowideit/tuios-installed` | `installBundledThemes` | `themes`, `themesDir`, `defaultTheme`, `force`, `configPath` | `themes` — installed vs skipped ids and the selected theme. |
| `@svendowideit/tuios-installed` | `renderThemeReport` | `themeId`, `themesDir`, `configPath`, `outputPath`, `open` | `themeReport` — HTML report path, byte size, the slots below their floor, and the theme's display name. |

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
start-daemon-service → restart-daemon-service → install-themes → verify`.

- `fetch-release` calls `@svendowideit/github-release-install-fetch`, which
  resolves the release, selects this platform's archive, records its expected
  SHA-256, downloads it and verifies the bytes, landing a checksum-verified
  archive on disk. It is the only writer of `release`/`archive`.
- `install` re-verifies the archive and installs the binary. It is the only
  writer of `installed`/`install`; `uninstall` of `uninstall`; `install-themes`
  of `themes`; `verify` of `summary`. One writer per resource per run keeps
  `data.latest(...)` unambiguous.
- `install` is idempotent: it locates the existing binary, and when its version
  already equals the target it records `skipped: true` (pass `force=true` to
  override).
- `restart-daemon-service` restarts the daemon after an actual upgrade.
  `systemctl --user enable --now` does **not** restart an already-active unit, so
  without this step the daemon would keep running the old binary. It is skipped
  when the install was a no-op, on uninstall, and when `manageService=false`.
- `install-themes` installs the two bundled themes and selects `defaultTheme`
  (Swamp Club) only when `config.toml` has no `appearance.theme` yet; a theme the
  user has already chosen is never overwritten. It is skipped on uninstall and
  when `installThemes=false`, and is `allowFailure: true`, so a theme problem
  never fails the binary install.
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
  probe, SHA-256 verification, tar extraction, version parsing and comparison,
  plus theme helpers (config-dir resolution, theme parsing, and the `config.toml`
  read/write of `appearance.theme`).
- `tuios_installed.ts` — the model: `sync`, `install` (verify the staged
  archive, extract, atomic install, package-manager guard), `uninstall`, `print`,
  and the theme methods `installTheme`, `setTheme`, `installBundledThemes`,
  `renderThemeReport`.
- `theme_report.ts` — the colour maths and HTML renderer behind
  `renderThemeReport`: a port of TUIOS's WCAG-luminance, OKLab-blend and
  contrast-floor helpers (`internal/theme`, `internal/overlay`), the palette and
  `chrome` normalisation, the accent and dialog-ramp derivation, the
  `tuios list-themes --json` fallback parser, and the self-contained HTML the
  method writes.
- `tuios-install.yaml` — the bundled install/upgrade workflow (created with
  `swamp workflow create`; do not hand-edit its `id`).
- `tuios-theme.yaml` — the reusable install/select theme workflow.
- `themes/swamp_club.json`, `themes/borland_modern_blue.json` — the bundled
  themes, read at runtime through `ctx.extensionFile("themes/<id>.json")` and
  declared in `additionalFiles` so they travel with the extension.
- `tuios_shared_test.ts` / `tuios_installed_test.ts` /
  `tuios_installed_methods_test.ts` / `theme_report_test.ts` — pure-helper and
  execute-level tests; the latter drive the real `execute` functions through
  `createModelTestContext` with subprocesses stubbed by `withMockedCommand`.
  There is no network in the install path — the archive is built on disk by the
  test. Theme methods are tested against temporary directories, with
  `extensionFile` pointed at the extension tree. `theme_report_test.ts` checks
  the colour maths, the accent/ramp derivation for both bundled themes, and the
  rendered HTML.

To add another bundled theme, drop `<id>.json` under `themes/`, add it to
`additionalFiles`, and add the id to `BUNDLED_THEMES` in `tuios_shared.ts`.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/tuios/tuios_shared_test.ts \
  extensions/models/tuios/tuios_installed_test.ts \
  extensions/models/tuios/tuios_installed_methods_test.ts \
  extensions/models/tuios/theme_report_test.ts

~/.swamp/deno/deno check \
  extensions/models/tuios/tuios_shared.ts \
  extensions/models/tuios/tuios_installed.ts \
  extensions/models/tuios/theme_report.ts
```

### Where things land and how to check them

```sh
# The binary (path is printed by install/verify; usually ~/.local/bin/tuios).
~/.local/bin/tuios --version

# The daemon, if manageService was used (default service name: tuios).
systemctl --user status tuios.service
systemctl --user is-enabled tuios.service

# The themes: what TUIOS sees, which is active, and where they live.
tuios list-themes --json | jq '{active, themes_dir}'
tuios list-themes swamp_club
```

Change the service name with `--input serviceName=<name>` (or the
`tuios-installed` `serviceName` global) if you use something other than `tuios`.
Theme files land in the TUIOS themes directory — usually
`~/.config/tuios/themes` — and the selected theme is the `theme` line of the
`[appearance]` table in `~/.config/tuios/config.toml`.

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
- `installBundledThemes` only selects the default theme when `config.toml` has
  no `appearance.theme`; if you want to change a theme you already picked, run
  the `tuios-theme` workflow (or `setTheme`) explicitly with the id you want.
- The themes directory defaults to `~/.config/tuios`; a TUIOS configured with a
  non-default config location needs `themesDir`/`configPath` passed per call.
- `renderThemeReport` documents the palette exactly, but a theme's derived
  accents and dialog ramp are computed the way TUIOS builds them; a built-in
  theme with no file is read from `tuios list-themes <id> --json`, which reports
  the palette but no `chrome` object (built-ins carry none). The report lands in
  the TUIOS cache directory (`$XDG_CACHE_HOME/tuios`, else `~/.cache/tuios`).
- An upgrade restarts the daemon; that ends any attached clients, but sessions
  persist because the daemon saves them. The daemon runs the binary present at
  the time it started, so a manual binary replacement outside the workflow also
  needs a `restartService`.

## License

MIT — see LICENSE.txt.
