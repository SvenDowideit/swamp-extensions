# @svendowideit/obsidian-theme

Install, list and select Obsidian CSS themes from swamp — with **Borland Modern
Blue** and **Swamp Club** bundled.

## What it does

Obsidian finds a theme by its folder name under `.obsidian/themes/<name>/` and
activates it through the `cssTheme` key in `.obsidian/appearance.json`. Doing
that by hand is easy to get wrong: the folder name must match `cssTheme`, the
manifest must be valid, and editing `appearance.json` can drop unrelated keys
such as the accent colour or enabled CSS snippets.

This extension makes the operation repeatable:

- `install` writes one or every bundled theme into the vault, skipping files
  that are already identical.
- `select` sets `cssTheme`, preserving every other appearance key.
- `list` reports every installed theme, its manifest metadata, whether it is one
  of the bundled themes, and which theme is active.
- `setup` is a read-only discovery step for when a theme does not appear.

It writes only the theme folders and `appearance.json` — never notes. Paths are
built with `@std/path`, so a Windows drive-letter or UNC vault works as well as
a macOS or Linux one. With no `vaultPath` the extension reads Obsidian's own
per-platform vault registry and uses the open (or only) vault, so a normal
desktop install needs no configuration. It backs up any file it overwrites and
preserves every other appearance key.

## Install

```sh
swamp extension pull @svendowideit/obsidian-theme
```

Self-contained: no other extension or host service is required. The vault must
have been opened in Obsidian at least once so `.obsidian` exists and is
registered.

## Configuration

Global arguments (set at creation with `--global-arg`, or per method call where
the command supports it):

| Argument | Type | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `vaultPath` | string | `""` | Obsidian vault folder. Empty auto-detects the open (or only) vault from Obsidian's registry. Absolute, `~`-prefixed, or a Windows drive/UNC path. |
| `vaultName` | string | `""` | Registered vault folder name to use when `vaultPath` is empty. Empty selects the open vault, or the only registered one. |
| `configDir` | string | `.obsidian` | Vault config dotfolder, relative to `vaultPath`. |
| `defaultTheme` | string | `borland-modern-blue` | Bundled theme selected when the vault has no `cssTheme` yet. |

**Vault detection.** With `vaultPath` empty, the extension reads Obsidian's own
registry: `%APPDATA%\obsidian\obsidian.json` on Windows,
`~/Library/Application Support/obsidian/obsidian.json` on macOS, and
`$XDG_CONFIG_HOME/obsidian/obsidian.json` or
`~/.config/obsidian/obsidian.json` on Linux. It uses the vault marked `"open"`
(or the only registered vault); if several are registered and none is open, it
fails with the list and asks for `vaultName` or `vaultPath`. `setup` reports the
registry path, the detection source (`explicit`, `registry-name`,
`registry-default` or `none`) and every registered vault.

Every method also accepts `vaultPath`, `vaultName` and `configDir` as **per-call
overrides** (empty uses the model global), so the examples below can target a
vault without changing the model definition.

Method arguments:

| Method | Argument | Type | Default | Meaning |
| ------ | -------- | ---- | ------- | ------- |
| all methods | `vaultPath`, `vaultName`, `configDir` | string | `""` | Per-call overrides; empty uses the model global. |
| `install` | `theme` | string | `""` | Bundled theme id or display name. Empty installs every bundled theme. |
| `install` | `force` | boolean | `false` | Rewrite even when the installed files are identical. |
| `installBundledThemes` | `selectDefault` | boolean | `true` | Select `defaultTheme` only when no theme is active. |
| `installBundledThemes` | `defaultTheme` | string | `""` | Per-call override of the global default theme. |
| `installBundledThemes` | `force` | boolean | `false` | Rewrite identical theme files. |
| `select` | `theme` | string | required | Installed display name or bundled theme id. |
| `setup`, `list` | — | — | — | No arguments. |

The bundled themes are:

| Id | Display name | Source |
| -- | ------------ | ------ |
| `borland-modern-blue` | Borland Modern Blue | Port of the herdr `borland-modern-blue` palette. |
| `swamp-club` | Swamp Club | Cyberpunk terminal theme inspired by swamp-club.com. Swamp Club imports its display fonts from Google Fonts; Borland uses local system fonts. |

## Setup

`setup` is read-only. It resolves the vault (explicit path, registry name, or
the open/only registry vault), reports the registry path and every registered
vault, whether the config folder, themes folder and `appearance.json` exist,
lists installed themes, marks the active one, and records any discovery error.
It writes only the `config` resource, never a vault file. Use it first on a new
machine, or when a theme does not show up in Obsidian. With no arguments it
shows what the registry detected:

```sh
swamp model @svendowideit/obsidian-theme method run setup obsidian-theme
```

To point it at a specific vault instead:

```sh
swamp model @svendowideit/obsidian-theme method run setup obsidian-theme \
  --input vaultPath=/home/me/vault
```

Because the configuration lives in the model's global arguments (Swamp persists
those) and the setup result is written as a resource, a later run reuses the
same vault and does not ask again. The setup report is verified reality: it
checks the filesystem rather than echoing the requested paths, and shows the
detection source so a stale registry entry is visible.

There is no approval gate. Setup, install and select are idempotent and safe to
run in any order; capabilities enable progressively: setup works with no
detected vault (it reports the error), install works once a vault is found, and
select works once a theme is installed. The `obsidian-theme-upgrade` workflow
composes install and select-if-none in one run.

## Examples

**Install every bundled theme into the detected vault.** With no `vaultPath`,
the extension reads Obsidian's registry and uses the open (or only) vault. This
is the normal desktop case. Identical files are left untouched; a differing file
is backed up once to `*.bak-obsidian-theme` and then replaced:

```sh
swamp model @svendowideit/obsidian-theme method run install obsidian-theme
```

**Target a specific vault, including a Windows path.** Use this when the
registry does not point at the vault you mean. Quote a Windows path so the shell
keeps the backslashes:

```sh
swamp model @svendowideit/obsidian-theme method run install obsidian-theme \
  --input vaultPath=/home/me/vault

swamp model @svendowideit/obsidian-theme method run install obsidian-theme \
  --input 'vaultPath=C:\Users\me\Documents\My Vault'
```

**Install one theme by id or display name.** Use this when the vault should
only receive one of the bundled themes:

```sh
swamp model @svendowideit/obsidian-theme method run install obsidian-theme \
  --input vaultPath=/home/me/vault \
  --input theme=swamp-club
```

**List installed themes and the active one.** Use this to confirm what the
vault actually contains before or after selecting:

```sh
swamp model @svendowideit/obsidian-theme method run list obsidian-theme \
  --input vaultPath=/home/me/vault
```

**Select a theme.** Select by bundled id or by the display name Obsidian shows.
The theme must already be installed; `select` will not create a missing folder:

```sh
swamp model @svendowideit/obsidian-theme method run select obsidian-theme \
  --input vaultPath=/home/me/vault \
  --input theme=borland-modern-blue
```

**Install and select in one idempotent run.** This is the single entry point:
it installs every bundled theme on a fresh vault and selects `defaultTheme`
only if no theme is active. An existing choice is never overwritten.

```sh
swamp workflow run @svendowideit/obsidian-theme-upgrade \
  --input vaultPath=/home/me/vault
```

## Upgrade

The same `obsidian-theme-upgrade` workflow is the install and the upgrade. On a
fresh vault it installs both bundled themes and selects the default; on an
existing vault (after `swamp extension update @svendowideit/obsidian-theme`) it
refreshes the bundled files without changing the selected theme:

```sh
swamp workflow run @svendowideit/obsidian-theme-upgrade \
  --input vaultPath=/home/me/vault
```

The workflow re-installs both themes, backs up any file whose content changed,
and finishes by listing what is installed and active. It is idempotent and safe
to re-run. It does **not** switch an existing selection; use the `select` method
for that.

## Details

### Methods

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `setup` | none | Read-only vault/theme discovery; writes the `config` resource. |
| `install` | `theme`, `force` | Install one bundled theme or all of them into `<vaultPath>/<configDir>/themes/<name>/`. Does not change selection. |
| `installBundledThemes` | `selectDefault`, `defaultTheme`, `force` | Install all bundled themes and select the default only when no theme is active. Used by the install/upgrade workflows. |
| `list` | none | List installed themes, manifest metadata, bundled flags and the active theme; writes the `themes` resource. |
| `select` | `theme` | Set `cssTheme` in `appearance.json`, preserving every other key; writes the `selection` resource. |

### Resources

| Resource | Written by | Contents |
| -------- | ---------- | -------- |
| `config` | `setup` | Resolved vault path and detection source, registry path, every registered vault, presence flags, active theme, bundled and installed theme state, any discovery error. |
| `themes` | `list` | Vault path/source, installed themes with manifest metadata, active/bundled flags. |
| `install` | `install`, `installBundledThemes` | Vault path/source, per-theme install status (`installed`, `updated`, `unchanged`), counts, and the selection outcome. |
| `selection` | `select` | Vault path/source, selected theme, previous theme, whether the file changed, and the appearance path. |

### How installation and selection work

A bundled theme is read through `ctx.extensionFile("themes/<dir>/...")`, so the
same code works for a source-loaded extension and a pulled one. swamp's
`additionalFiles` rejects `.css`, so the bundled stylesheet is stored as
`theme.css.txt` and written into the vault under the real `theme.css` name. The
`manifest.json` name must match the catalogue name; the folder Obsidian sees is
that display name, and `cssTheme` is set to the same string.

`install` compares both `theme.css` and `manifest.json` byte-for-byte. If they
are identical it writes nothing. If either differs it copies the old file to
`*.bak-obsidian-theme` once, then writes the new content. That makes an upgrade
safe while preserving a user's local edit for inspection.

`select` reads `appearance.json`, checks that the theme is actually installed,
and rewrites the file with `cssTheme` set. All other keys are preserved. The
previous `appearance.json` is backed up once to
`appearance.json.bak-obsidian-theme`. An invalid `appearance.json` is rejected
without writing. Selecting the active theme is a no-op.

### Paths, Windows and vault detection

All paths are built with `@std/path`. On Windows the module uses the Windows
variant, so `C:\Users\me\Vault` stays a drive path, UNC roots such as
`\\server\share\Vault` are preserved, and both `/` and `\` are accepted in
relative paths. `createDirectVaultPort` rejects `..` and absolute
vault-relative paths before touching the filesystem. (The generic
`@magistr/obsidian-vault` model prefixes `/` before the Windows drive letter,
producing `\C:\Users\...`, so it cannot open a drive-letter vault; this
extension therefore owns its three `.obsidian` files directly and does not
touch notes.)

Vault detection reads Obsidian's registry:

| OS | Registry path |
| -- | ------------- |
| Windows | `%APPDATA%\obsidian\obsidian.json`, else `%USERPROFILE%\AppData\Roaming\obsidian\obsidian.json` |
| macOS | `~/Library/Application Support/obsidian/obsidian.json` |
| Linux | `$XDG_CONFIG_HOME/obsidian/obsidian.json`, else `~/.config/obsidian/obsidian.json` |

`resolveVaultTarget` prefers an explicit `vaultPath`, then a `vaultName` match,
then the entry marked `"open"`, then the only registered vault. Ambiguity is an
error that lists the candidates, never a guess. The registry `path` may use
either separator; the name is the last component after splitting on both.

### Caveats

- Obsidian may need a reload (or a theme re-selection) to repaint after
  `appearance.json` changes. The CLI is not required.
- Swamp Club's `@import` fetches JetBrains Mono, Chakra Petch and Orbitron from
  Google Fonts; without network it falls back to the next font in its stack.
- A theme folder is identified by its **folder name**. Renaming the folder
  outside this extension will make `cssTheme` point at the old name until you
  run `select` again.
- The default theme is only selected when `cssTheme` is absent or empty. This is
  deliberate: running the install/upgrade workflow on a vault the person has
  already themed must not override their choice.
- On Windows both `C:\Users\me\Vault` and `C:/Users/me/Vault` work; quote a path
  with spaces. UNC paths (`\\server\share\Vault`) are supported.
- If several vaults are registered and none is marked open, `setup` lists them
  and the run asks for `vaultName` or `vaultPath`; it never guesses.
- Obsidian's registry keeps pointing at the old location after a vault is moved.
  `setup` reports the stale path and the missing `.obsidian`; pass `vaultPath` to
  the vault's current location.

### Extending and testing

The pure helpers are exported and unit-tested without touching a vault:
`resolveBundledTheme`, `normalizeConfigDir`, `parseAppearance`,
`setSelectedTheme`, `deriveInstalledThemeNames`, `readBundledTheme`,
`installBundledTheme`, `installThemes`, `listInstalledThemes`,
`selectInstalledTheme`, `setupVault`, `obsidianRegistryPath`,
`parseVaultRegistry`, `chooseVault`, `resolveVaultTarget`,
`vaultAbsolutePath`, and `createDirectVaultPort`. The tests use an in-memory
`VaultPort` for the install/select logic, a temporary directory for the direct
port, and Windows/macOS/Linux fixtures (including `@std/path/windows` on Linux)
for drive-letter, UNC, `%APPDATA%`, `~/Library` and XDG paths.

Add a theme by placing `themes/<dir>/theme.css.txt` (the bundled form of
`theme.css`) and `themes/<dir>/manifest.json` in the extension, adding an entry
to `BUNDLED_THEMES` in `obsidian_theme.ts`, and adding the two files to
`additionalFiles:` in `manifest.yaml`. The test "every bundled theme has a
matching manifest name and files" then verifies the catalogue and the manifests
agree.

Run the unit tests with the bundled Deno:

```sh
~/.swamp/deno/deno test --allow-all extensions/models/obsidian-theme/obsidian_theme_test.ts
```

The extension was also exercised end to end against a throwaway vault through
its direct filesystem port: `install` wrote both themes, the appearance backup
preserved the original JSON, the upgrade workflow left the selected theme
alone, and `select` switched to Swamp Club while preserving the other keys. A
no-argument `setup` against this machine detected the open vault from
`~/.config/obsidian/obsidian.json` and reported `registry-default`.
