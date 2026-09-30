# @svendowideit/opencode

Install and update the [opencode](https://opencode.ai) CLI, and manage its
themes. It ships the **Borland Modern Blue** theme and sets it as the default.

Release resolution, platform selection, checksum lookup and download are done by
[`@svendowideit/github-release-install`](../github-release-install). This
extension keeps the opencode-specific parts: locating and running the `opencode`
binary, extracting and installing it from the verified archive, the
package-manager guard, and reading/writing opencode's theme files.

## What it does

opencode is a terminal AI coding agent published as a single self-contained
binary. This extension answers the questions you have about it, on any machine
you run swamp on:

- **What is installed right now?** The `opencode` model finds the binary, runs
  `opencode --version`, and records the version and resolved path.
- **How do I install or upgrade it?** The bundled `opencode-install` workflow
  calls `@svendowideit/github-release-install-fetch` to land a checksum-verified
  archive, then `install` extracts the `opencode` binary from it, verifies it
  once more, and installs it atomically. Idempotent and package-manager aware.
- **How do I theme it?** `installTheme` writes a theme JSON into
  `~/.config/opencode/themes/`; `setTheme` selects it in
  `~/.config/opencode/tui.json` (preserving other keys). The reusable
  `opencode-theme` workflow does install and/or activate, separately or
  together.

Side effects: outbound HTTPS reads from `api.github.com` and the release
download URL (nothing is written there); install writes the binary into
`~/.opencode/bin`, `/usr/local/bin` or `~/.local/bin` and stages the verified
archive under the download directory; the theme methods write files under
`~/.config/opencode/`. No service or daemon is created.

## Install

```sh
swamp extension pull @svendowideit/opencode
```

The declared dependency `@svendowideit/github-release-install` is pulled
automatically.

## Configuration

### Workflow inputs — `@svendowideit/opencode-install`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `repo` | string | `anomalyco/opencode` | GitHub repository publishing the releases. |
| `installDir` | string | `""` | Where to install the binary. Empty auto-picks the first writable of `~/.opencode/bin`, `/usr/local/bin`, `~/.local/bin`. |
| `downloadDir` | string | `~/.cache/opencode` | Where the verified archive is staged before install extracts it. |
| `version` | string | `""` | Release to install (`1.18.33` or `v1.18.33`). Empty installs the latest. |
| `flavor` | `auto` \| `musl` \| `baseline` | `auto` | `auto` uses the stock build; `musl` the Alpine build; `baseline` the non-AVX2 build. |
| `theme` | string | `borland_modern_blue` | Theme to install and activate. |
| `installTheme` | boolean | `true` | Install the bundled theme and set it as the default. |
| `force` | boolean | `false` | Reinstall and rewrite the theme files even when unchanged. |
| `githubToken` | string | `""` | Token for the releases API. Empty falls back to `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`. |

### Workflow inputs — `@svendowideit/opencode-theme`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `theme` | string | `borland_modern_blue` | Theme name (written as `<configDir>/themes/<name>.json`). |
| `themePath` | string | `""` | Path to a theme JSON file to install. Empty uses the bundled theme. |
| `themeJson` | string | `""` | Inline theme JSON to install. Wins over `themePath` and the bundled theme. |
| `configDir` | string | `~/.config/opencode` | opencode config directory. |
| `install` | boolean | `true` | Write the theme file into `<configDir>/themes/`. |
| `set` | boolean | `true` | Select the theme in `<configDir>/tui.json`. |
| `force` | boolean | `false` | Rewrite the theme file even when it already matches. |

### `opencode` global arguments

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `path` | string | `""` | Path to the `opencode` binary. Empty auto-detects from `PATH` and the usual install locations; when set it is authoritative. |
| `configDir` | string | `~/.config/opencode` | opencode config directory holding `themes/` and `tui.json`. |
| `theme` | string | `borland_modern_blue` | Default theme name used by `installTheme`/`setTheme` when no `theme` input is given. |

### Rate limits and authentication

The releases API allows 60 anonymous requests/hour. `@svendowideit/github-release-install`
resolves a token from `githubToken`, `GITHUB_TOKEN`, `GH_TOKEN`, then the
authenticated `gh` CLI, so `gh auth login` is usually enough. See that
extension's README for details and its `authStatus` method.

## Examples

```sh
# Install or update opencode and activate the Borland theme. Idempotent.
swamp workflow run @svendowideit/opencode-install

# Pin a version, or install the musl build used on Alpine.
swamp workflow run @svendowideit/opencode-install \
  --input version=1.18.33 --input flavor=musl

# Update the binary but leave the theme alone.
swamp workflow run @svendowideit/opencode-install --input installTheme=false

# Install and activate the bundled theme without touching the binary.
swamp workflow run @svendowideit/opencode-theme

# Activate a theme that is already installed, without rewriting its file.
swamp workflow run @svendowideit/opencode-theme \
  --input install=false --input theme=github

# Install a theme from a file without activating it.
swamp workflow run @svendowideit/opencode-theme \
  --input set=false --input theme=my-theme --input themePath=./my-theme.json

# Ask what is installed right now, then read it back.
swamp model @svendowideit/opencode method run sync opencode
swamp data get opencode installed --json
```

## Details

### Models, methods and resources

| Model | Method | Arguments | Produces |
| ----- | ------ | --------- | -------- |
| `@svendowideit/opencode` | `sync` | `path` | `installed` — path, present flag, version. |
| `@svendowideit/opencode` | `install` | `version`, `archivePath`, `archiveName`, `checksum`, `installDir`, `force` | `install` — the install result (or `skipped: true`) with `checksumVerified` and `versionCommand`, and a refreshed `installed` resource. |
| `@svendowideit/opencode` | `installTheme` | `theme`, `themePath`, `themeJson`, `force` | `theme` — the theme write result (or `skipped: true`), with the target path and source. |
| `@svendowideit/opencode` | `setTheme` | `theme`, `createTui` | `setTheme` — the selection result (`changed`, `previousTheme`) and the `tui.json` path. |
| `@svendowideit/opencode` | `print` | `theme` | `summary` — the installed state and active theme. |

`install` requires `archivePath` — the checksum-verified archive produced by
`@svendowideit/github-release-install`'s `download` step. It re-verifies the
bytes against `checksum`, extracts the single `opencode` member, and installs.

### Pre-flight checks — `@svendowideit/opencode`

| Check | Label | Applies to | What it validates |
| ----- | ----- | ---------- | ----------------- |
| `valid-install-dir` | `policy` | `install` | The configured `path` global is absolute or `~`-prefixed. |

Skip it with `--skip-check valid-install-dir` or `--skip-check-label policy`. The
package-manager guard is a **runtime** check inside `install` (probes `dpkg -S` /
`rpm -qf` / `brew list`), and the same absolute-path rule is enforced at runtime
too, so a relative `installDir`/`archivePath` is rejected even when the check is
skipped.

### Workflows

`@svendowideit/opencode-install` — steps:
`fetch-release → install → install-theme → set-theme → verify`.

- `fetch-release` calls the release installer (resolve, checksum, download,
  verify). Its `assetPattern` is chosen from `flavor` (stock / musl / baseline),
  since opencode does not put the version in asset names.
- `install` re-verifies the archive and installs the binary; `install-theme`
  and `set-theme` are gated by `installTheme`; `verify` prints the result.
- One writer per resource per run keeps `data.latest(...)` unambiguous.

`@svendowideit/opencode-theme` — steps: `install-theme → set-theme`, each gated
by its input, so it installs only, activates only, or both.

### Structure and extending

- `opencode_shared.ts` — pure helpers: version parsing, install-dir/`PATH`
  selection, the package-manager probe, tar extraction, and the theme/`tui.json`
  file helpers.
- `opencode.ts` — the model: `sync`, `install`, `installTheme`, `setTheme`,
  `print`.
- `themes/borland_modern_blue.json` — the bundled opencode-format theme.
- `opencode-install.yaml` / `opencode-theme.yaml` — the bundled workflows
  (created with `swamp workflow create`; do not hand-edit their `id`).
- `opencode_shared_test.ts` / `opencode_test.ts` / `opencode_methods_test.ts` —
  pure and execute-level tests.

To ship another bundled theme, add `themes/<name>.json` to `additionalFiles:`
and pass `--input theme=<name>`. To change the release repository or asset
naming, adjust the workflow's `fetch-release` inputs.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/opencode/opencode_shared_test.ts \
  extensions/models/opencode/opencode_test.ts \
  extensions/models/opencode/opencode_methods_test.ts

~/.swamp/deno/deno check \
  extensions/models/opencode/opencode_shared.ts \
  extensions/models/opencode/opencode.ts
```

### Caveats

- `install` returns verified bytes; it does not run opencode.
- opencode publishes no `checksums.txt`, so the extension verifies against the
  per-asset digest the GitHub API exposes (`sha256:…`); that is recorded as the
  archive's checksum.
- Asset names carry no version (`opencode-linux-x64.tar.gz`), so the version
  comes from the release tag, not the file name.
- `install` refuses a binary a package manager owns unless `force=true`.
- The theme is selected in `tui.json`; it applies to opencode's TUI, not to the
  headless server.

## License

MIT — see LICENSE.txt.
