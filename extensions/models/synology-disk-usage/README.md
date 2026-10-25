# @svendowideit/synology-disk-usage

> **IMPORTANT — this can take a long time.** Inventorying a NAS disk can run for
> minutes on a small volume and hours on a large one. Start with the default
> `tree` mode (`du` per volume); use `mode=shares` for a quick answer and
> reserve `mode=files` for exact per-file categories.

A swamp model extension that answers _"what is using my Synology NAS space?"_
by category — Docker images, Synology app data, Google Drive/Photos backups,
ordinary backups, recycle bins, user files, media, and content types.

## What it does

Connects to a Synology DSM host over SSH, discovers `/volume*` and the
top-level shares on each volume, then classifies usage into Synology-aware
buckets. It knows the directories DSM actually uses: `@docker` (Container
Manager), `@appstore`, `@synologydrive`, `@cloudsync`, `@eaDir`, `@vmm`,
`#recycle`, `homes`, Hyper Backup / Active Backup / Time Machine destinations,
and Google Drive / Google Photos sync folders.

Three scan modes are available:

- **`tree` (default)** — one `du -k -d<treeDepth>` per volume. This is the
  safe choice for a large NAS: `du` walks the tree on the NAS and returns one
  line per directory, not one line per file. It gives the lay of the land and
  targets the large directories without streaming millions of paths over SSH.
- **`files`** — stream every file from `find` over SSH and classify it
  individually. Use this when you want exact per-file content categories or
  need to separate categories nested below `treeDepth`; it is much heavier on
  huge trees.
- **`shares`** — one `du -sk` per top-level share. The lightest option, with
  only share-level granularity.

Side effects: it opens SSH sessions, runs read-only `find`, `du`, and `df`
commands, and writes swamp resources (`config`, `discovery`, `audit`). It
installs nothing on the NAS and never modifies files.

## Install

```sh
swamp extension pull @svendowideit/synology-disk-usage
```

No other extension is required. You need an OpenSSH client on the machine
running swamp and key/agent access to the NAS — password prompts are disabled
(`BatchMode=yes`).

## Configuration

Set global arguments when creating the model (or with `swamp model edit nas`):

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `host` | string | `""` | SSH target, e.g. `admin@diskstation` or `diskstation`. Required before `audit`. |
| `sshUser` | string | `""` | SSH user when `host` has no `user@` prefix. |
| `identityFile` | string | `""` | Private key path. Omit to use your SSH agent/config. |
| `sshPort` | integer | unset | SSH port; omit for 22. |
| `volumes` | string[] | `[]` | Volume paths to scan. Empty auto-detects `/volume[0-9]*`. |
| `categories` | rule[] | `[]` | Custom path rules. Empty uses the built-in Synology rules (see below). |
| `excludePatterns` | string[] | `[]` | Case-insensitive regexes for paths to skip, e.g. `"/@eaDir/"`. |
| `minNotableBytes` | integer | `1073741824` | Minimum size for "notable" files/findings (1 GiB). |
| `maxFiles` | integer | `0` | Stop after this many files; `0` means unlimited. |
| `timeoutMs` | integer | `0` | SSH command timeout; `0` means no timeout. |
| `useSudo` | boolean | `false` | Run remote `find`/`du` through `sudo -n` to read root-only `@docker`/`@appstore` data. Requires NOPASSWD. |
| `oneFilesystem` | boolean | `false` | Stay on the volume's root filesystem. Default `false` crosses Synology shared-folder subvolumes/mounts, which is required to see `homes`, `photo`, `GoogleDrive`, etc. |
| `treeDepth` | integer | `3` | Directory depth for the default `du` tree scan. Depth 3 sees `homes/<user>/Google Drive`; raise it for deeper nesting. |

The `audit` method also accepts per-run overrides:

| Input | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `host` | string | `""` | Override the SSH target for this run. |
| `sshUser` | string | `""` | Override the SSH user for this run. |
| `volumes` | string[] | `[]` | Override the volume list for this run. |
| `mode` | `tree` \| `files` \| `shares` | `tree` | Fast directory tree, exact per-file walk, or share-level `du`. |
| `treeDepth` | integer | global value | Override the tree depth for this run. |
| `useSudo` | boolean | global value | Run remote `find`/`du` through `sudo -n` for this run. |
| `oneFilesystem` | boolean | global value | Stay on the volume's root filesystem for this run. |
| `categories` | rule[] | global value | Override the path category rules for this run. |
| `excludePatterns` | string[] | global value | Override the path exclusion regexes for this run. |
| `minNotableBytes` | integer | global value | Override the notable-size threshold for this run. |
| `maxFiles` | integer | global value | Override the file cap for this run. |
| `timeoutMs` | integer | global value | Override the command timeout for this run. |

`useSudo` applies to `audit` only; `setup` and `discover` never need it.

## Setup

Configuration is cumulative. `setup` reads the saved `config` resource first,
merges any `--input` overrides over it, writes the result back even when it is
incomplete, then verifies the **real** SSH connection by running discovery on
the NAS. It records the detected Synology model, DSM version, and volumes, so
the next run does not need to be told what the NAS is.

If the connection fails, `setup` writes `reachable: false` plus the SSH error
to the `config` resource and then stops with that error. It does not print a
success message for a connection it did not verify.

Capabilities enable progressively: `setup` and `discover` work as soon as
`host` is present, and `audit` unlocks immediately; nothing is applied to the
NAS without your explicit audit run.

```sh
# Persist the SSH target and verify it; this also discovers /volume*.
swamp model method run nas setup --input host=admin@diskstation

# Change the saved target later without re-creating the model.
swamp model method run nas setup --input host=admin@diskstation --input identityFile=~/.ssh/nas_ed25519
```

## Examples

Create the model with a concrete SSH target:

```sh
# The global host is used by setup, discover, and audit.
swamp model create @svendowideit/synology-disk-usage nas \
  --global-arg host=admin@diskstation
```

List volumes, capacity, and top-level shares without walking the filesystem:

```sh
# Use this first to see the share names on your NAS.
swamp model method run nas discover

# Read the discovered volumes and shares as JSON.
swamp data query 'behavior("nas") && name == "discovery"' --select content
```

Run the default tree audit (fast, safe for a large NAS):

```sh
# One du -d3 per volume; classifies the large directories without streaming
# every file over SSH.
swamp model method run nas audit
```

Go one level deeper when categories are nested below the default depth:

```sh
# Depth 4, e.g. homes/<user>/some-folder/Google Drive.
swamp model method run nas audit --input treeDepth=4
```

Use the exact per-file walk when you need content categories:

```sh
# Streams every file; much heavier, but classifies individual extensions.
swamp model method run nas audit --input mode=files
```

Run the lightest share-level audit:

```sh
# One du per top-level share; least granular.
swamp model method run nas audit --input mode=shares
```

Read root-only app data and Docker storage through sudo:

```sh
# Requires NOPASSWD for the remote find and du binaries; if sudo needs a
# password, the error prints the exact sudoers line and install command.
swamp model method run nas audit --input useSudo=true
```

Audit only one volume and skip Synology thumbnail directories:

```sh
# Faster full walk when you already know which volume is full.
swamp model method run nas audit \
  --input 'volumes:json=["/volume1"]' \
  --input 'excludePatterns:json=["/@eaDir/"]'
```

Add a custom category for a share name the defaults do not know:

```sh
# "FamilyVideos" becomes its own category instead of falling into "Media".
swamp model method run nas audit \
  --input 'categories:json=[{"id":"family-videos","label":"Family videos","patterns":["(^|/)FamilyVideos(/|$)"]}]'
```

Read the report after the run:

```sh
# Markdown summary: capacity, categories, largest shares/files, findings.
swamp report get @svendowideit/synology-disk-report --model nas --markdown
```

## Upgrade

This extension installs nothing on the host, so updating the package is the
whole upgrade:

```sh
# Pull the latest published version; the model definition upgrades lazily.
swamp extension update @svendowideit/synology-disk-usage
```

After updating, re-run `setup` if the SSH target changed and `audit` to refresh
the data. The audit data schema is additive across releases.

## Details

`@svendowideit/synology-disk-usage` ships one model type
(`@svendowideit/synology-disk-usage`) with three methods, plus one report
(`@svendowideit/synology-disk-report`).

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | `host`, `sshUser`, `identityFile`, `sshPort`, `volumes` (all optional overrides) | `config` resource; verifies SSH and discovers volumes. |
| `discover` | `host`, `sshUser`, `volumes` (optional overrides) | `discovery` resource with volumes, capacity, and top-level shares. |
| `audit` | `host`, `sshUser`, `volumes`, `mode` (optional overrides) | `audit` resource with categorized usage, shares, findings, and notable files. |

### How it works

1. `setup`/`discover` run a small POSIX shell script over SSH. It reads the
   Synology model from `/etc/synoinfo.conf`, the DSM version from
   `/etc.defaults/VERSION`, `df -kP` for each volume, and `find -maxdepth 1` for
   the top-level shares.
2. `audit` runs discovery again for current capacity, then either:
   - **`tree` mode (default)** — runs `du -k -d<treeDepth>` per volume. `du`
     walks the tree on the NAS and returns one line per directory; the model
     subtracts each child's cumulative size from its parent so every byte is
     counted exactly once.
   - **`files` mode** — probes `find -printf` support, then streams
     `find <volumes> -type f -printf '%s\t%p\0'` over SSH. Records are parsed as
     they arrive and aggregated by category and share.
   - **`shares` mode** — runs `du -sk` over each volume's top-level entries.
3. If `find -printf` is unavailable, the model automatically falls back to
   `shares` mode and logs why.

The scan is read-only. By default it crosses Synology shared-folder
subvolumes/mounts; set `oneFilesystem=true` to add `-x`/`-xdev` and stay on the
volume's root filesystem only.

Each audit compares the measured total with `df`'s used bytes. If less than
95% of the used space is readable, it adds a `scan-coverage` finding, prints a
report warning, and lists the discovered shares that produced no readable files.
The hint adapts to what is already enabled: with `useSudo=false` it suggests
enabling sudo; with sudo already on it points at Btrfs snapshots, iSCSI LUNs, or
system data; with `oneFilesystem=true` it suggests turning that off to cross
Synology shared-folder subvolumes.

### Why it spawns `ssh`

This extension is an SSH transport, so it invokes `ssh` with `Deno.Command`.
Every argument is built from the strict global schema: volume paths are
POSIX-shell-quoted, the target/user/key/port come from validated config,
`BatchMode=yes` disables password prompts, and only read-only `find`, `du`, and
`df` commands are run. The two call sites carry
`// swamp-quality-ignore deno-command` to record that deliberate choice.

### Default categories

Rules are tested against the full remote path, case-insensitively, in this
order. The first match wins; if nothing matches, the file's extension decides
the content category.

| Category id | Label | Typical paths |
| ----------- | ----- | ------------- |
| `google-photos` | Google Photos backups | `Google Photos/`, `GooglePhotos/` |
| `google-drive` | Google Drive backups | `Google Drive/`, `GoogleDrive/`, `gdrive/` |
| `docker` | Docker images & containers | `/volume1/@docker/`, `/volume1/docker/`, `docker/overlay2/` |
| `recycle-bin` | Recycle bins | `#recycle/` |
| `virtual-machines` | Virtual machines | `@vmm/`, `Virtual Machine Manager/` |
| `backups` | Backups | `Backups/`, `Hyper Backup/`, `Active Backup/`, `Time Machine/`, any `*backup*/` or `*snapshot*/` directory |
| `synology-app-data` | Synology app data | `@appstore/`, `@synologydrive/`, `@cloudsync/`, `@database/`, `@eaDir/`, any top-level `@.../`, `MailPlus/`, `surveillance/` |
| `media` | Media | `Media/`, `Movies/`, `TV/`, `Music/`, `Photos/`, including `homes/<user>/Photos/` |
| `user-files` | User files | Other files under `homes/`, `home/`, `users/` |
| `video` | Videos | extension fallback: `.mp4`, `.mkv`, `.mov`, … |
| `audio` | Audio | `.mp3`, `.flac`, `.wav`, … |
| `image` | Images | `.jpg`, `.png`, `.heic`, … |
| `document` | Documents | `.pdf`, `.docx`, `.txt`, `.epub`, … |
| `archive` | Archives | `.zip`, `.tar`, `.gz`, … |
| `code` | Source code | `.ts`, `.py`, `.go`, `.sh`, … |
| `database` | Databases | `.db`, `.sqlite`, … |
| `vm-image` | VM/disk images | `.qcow2`, `.vmdk`, `.iso`, … |
| `other` | Other | anything unmatched |

To replace the defaults, pass a `categories` array of
`{ "id": "...", "label": "...", "patterns": ["regex", ...] }` objects. To add
one rule while keeping the defaults, include the defaults you want plus your
new rule — the list is used exactly as supplied.

### Caveats

- **Tree depth.** `tree` mode reports directories up to `treeDepth` (default
  3) and does not count individual files or classify file extensions. Raise
  `treeDepth` for deeper nesting, or use `mode=files` for exact content
  categories. It is the right default for a large NAS: `du` runs on the NAS and
  only one line per directory crosses SSH.
- **Hardlinks.** `files` mode counts each directory entry; hardlinked blocks
  can be counted more than once. Synology's own `du` deduplicates hardlinks
  within one invocation, so `tree`/`shares` modes are the more conservative
  total for Docker-heavy volumes.
- **Permissions.** The SSH user must be able to read the shares you want
  measured. Unreadable paths are skipped by `find`/`du`; the audit reports what
  it could read, and SSH failures stop the run with the actual error. On many
  Synology setups `@docker` and `@appstore` are root-only: log in as `root`, or
  set `useSudo=true` and add a NOPASSWD entry for `find` and `du`. The audit's
  error prints the exact line and install commands after resolving the remote
  user and binary paths, for example:

  ```sudoers
  sven ALL=(ALL) NOPASSWD: /usr/bin/find, /usr/bin/du
  ```

  Synology has no `visudo`; write the file under `/etc/sudoers.d/` with
  `tee` + `chmod 0440`, then verify with `sudo -n /usr/bin/find /dev/null -print`
  and `sudo -n /usr/bin/du -sk /dev/null`. The audit error prints those exact
  commands for your user and paths. `sudo -n` never prompts; if a password is
  required the run stops with that remediation instead of producing a
  misleading partial total.
- **Shared-folder subvolumes.** On Btrfs, Synology shared folders such as
  `homes`, `photo`, and `GoogleDrive` are subvolumes/mounts. The default
  `oneFilesystem=false` deliberately crosses them so they are measured; setting
  `oneFilesystem=true` adds `find -xdev` and will leave them out.
- **`@eaDir`.** Synology thumbnail/metadata directories are included in
  `synology-app-data` by default. Exclude them with
  `excludePatterns=["/@eaDir/"]` if you want them out of the totals.
- **`shares` mode** cannot separate categories nested inside one share. Use
  `files` mode (the default) for Google Drive/Photos vs. user files inside
  `homes`.
- **Password auth is intentionally unsupported.** Use a key or SSH agent;
  `BatchMode=yes` prevents an interactive prompt from hanging a run.

### Extending and testing

The model lives in `synology_disk_usage.ts`; the summary is a standalone report
in `synology_disk_usage_report.ts`, attached via the model's `reports` field.
Pure helpers (`classifyPath`, `parseDiscoveryOutput`, `parseDuLine`,
`parseFileRecord`, `deriveShare`, `buildFindings`, command builders) are
exported so they can be tested without a NAS.

To add a category, add an entry to `DEFAULT_CATEGORY_RULES` (or pass custom
rules at run time). To add a content fallback, extend `EXT_CATEGORY` and
`CONTENT_CATEGORY_LABELS`.

```sh
# Type-check the model and report.
~/.swamp/deno/deno check synology_disk_usage.ts synology_disk_usage_report.ts

# Run the unit tests (no SSH or NAS required).
~/.swamp/deno/deno test --allow-env synology_disk_usage_test.ts synology_disk_usage_report_test.ts
```
