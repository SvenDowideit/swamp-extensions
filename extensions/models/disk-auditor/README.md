# @svendowideit/disk-auditor

A swamp model extension that answers the question _"what is eating my disk
space?"_ for a local filesystem path. Unlike `df`-based extensions (which only
report per-mount free space), this extension walks the directory tree and
attributes bytes to the directories and files actually consuming them — the
`ncdu`/`du` question, not the `df` question.

It is **cross-platform**: the implementation uses only Deno runtime APIs
(`Deno.stat`, `Deno.readDir`, `Deno.lstat`) — no shelling out to `du`, `find`,
or PowerShell. The same extension runs unchanged on Linux, macOS, and Windows,
so you can audit disk usage across a heterogeneous fleet with one tool.

## Installation

```sh
swamp extension pull @svendowideit/disk-auditor
```

## Usage

Create a model instance pointing at the path you want to audit, then run the
`audit` method. Results land as a versioned data resource you can query with CEL
or feed into workflows.

```sh
# Create a model that audits /var
swamp model create @svendowideit/disk-auditor var-disk \
  --global-arg path=/var

# Run the audit (depth 3, top 20 dirs/files, skip .git and .swamp)
echo '{"depth":3,"topDirs":20,"topFiles":20,"topExtensions":15,"excludePatterns":[".git",".swamp"]}' \
  | swamp model method run var-disk audit --stdin

# Read the latest snapshot
swamp data get var-disk current --json
```

The audit output is structured JSON, so you can pipe it through `jq` or query
historical versions with `swamp data query`:

```sh
# Top 5 directories by bytes from the latest snapshot
swamp data get var-disk current --json \
  | jq '.attributes.topDirs[0:5] | .[] | {name, bytes}'
```

## Method arguments

| Argument          | Type     | Default | Description                                                           |
| ----------------- | -------- | ------- | --------------------------------------------------------------------- |
| `depth`           | integer  | `3`     | Max directory recursion depth (0 = only the root's immediate entries) |
| `topDirs`         | integer  | `20`    | How many largest immediate subdirectories of the root to report       |
| `topFiles`        | integer  | `20`    | How many largest individual files found during the walk to report     |
| `topExtensions`   | integer  | `15`    | How many file extensions (by total bytes) to report                   |
| `excludePatterns` | string[] | `[]`    | Glob-style directory names to skip (e.g. `["node_modules", ".git"]`)  |
| `followSymlinks`  | boolean  | `false` | Follow symbolic links when summing sizes                              |

The `path` global argument sets the root to audit.

## How it works

The method recursively walks the configured `path` using `Deno.readDir` and
sizes each entry with `Deno.stat` (or `Deno.lstat` when not following symlinks).
Per-directory aggregates are computed bottom-up, so each reported directory's
`bytes` includes everything beneath it. Symbolic links are skipped by default to
avoid double-counting and cycles; set `followSymlinks: true` to follow them (the
walk guards against the obvious cycle case of a link pointing back at an
ancestor, but you should still be cautious on pathological trees).

Errors (permission denied, broken symlinks, vanished files) are collected per
path and returned in the `errors` array rather than aborting the whole audit —
so a single unreadable subdirectory won't lose you the rest of the tree.

No external services, credentials, or network access are required. The extension
only reads the local filesystem under the configured `path`.

## License

MIT — see LICENSE for details.
