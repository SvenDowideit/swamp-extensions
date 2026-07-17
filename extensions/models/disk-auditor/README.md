# @svendowideit/disk-auditor

A swamp model extension that answers the question _"what is eating my disk
space?"_ for a local filesystem path. Unlike `df`-based extensions (which only
report per-mount free space), this extension walks the entire directory tree,
**classifies every file by content type** (video, audio, audiobooks, ebooks,
docker, VM images, parquet, databases, archives, code, node_modules, etc.), and
produces **semantic findings** — grouped insights like "3 large Docker images:
12 GiB" or "Books (audiobooks + ebooks): 22570 files, 27.7 GiB".

No need to specify depth or top-N limits — the extension adapts based on what it
finds. A directory 3 levels deep full of videos gets flagged with
`dominantCategory: "video"`; a large parquet file is called out specifically;
audiobooks and ebooks are noted both separately AND combined as "books".

It is **cross-platform**: the implementation uses only Deno runtime APIs
(`Deno.stat`, `Deno.readDir`, `Deno.lstat`) — no shelling out to `du`, `find`,
or PowerShell. The same extension runs unchanged on Linux, macOS, and Windows,
so you can audit disk usage across a heterogeneous fleet with one tool.

The walk is **iterative** (stack-based, not recursive), so it handles trees with
millions of files and deep nesting (e.g. `node_modules` inside `node_modules`)
without stack overflow. Progress is logged every 2 seconds with running totals,
the current directory being scanned, and the largest items found so far — so you
always know it's working.

## Installation

```sh
swamp extension pull @svendowideit/disk-auditor
```

## Usage

The simplest way to use the extension is via the `disk` workflow (included in
this repo under `workflows/`):

```sh
# Audit / — just say where, nothing else
swamp workflow run disk --input path=/

# Audit /home, skipping node_modules too
swamp workflow run disk --input path=/home --input 'excludePatterns:json=[".git","node_modules"]'
```

A **formatted summary table** prints automatically after the scan — no need to
run `swamp data get` separately. It shows findings (notable first), per-category
rollups, largest directories, and largest files, all in human-readable sizes:

```
# Disk Audit: /home/sven

507.0 GiB across 4,533,816 files in 124,744 dirs — scanned in 42.0s

## Findings
| Finding                                  | Size      | Count  | Notable |
| Other: 336904 files, 58.1 GiB (47%)      | 58.1 GiB  | 336904 | ★       |
| Books (audiobooks + ebooks): 22570 files | 27.7 GiB  | 22570  | ★       |
| Ebooks: 22563 files, 26.3 GiB (21%)      | 26.3 GiB  | 22563  | ★       |
...
```

If you forget the `--input path=` argument, the tool prints a help message with
all available inputs, their types, defaults, and usage examples — no cryptic
error.

Relative paths (`.`,``./foo`,`../bar`) and`~` are expanded to absolute,
canonical paths before scanning, so logs and recorded data are always fully
qualified and unambiguous.

To read the structured JSON data (e.g. for scripting):

```sh
# All findings, notable first
swamp data get --workflow disk current --json \
  | jq -r '.content' | jq '.findings[] | .title'

# Per-category rollup
swamp data get --workflow disk current --json \
  | jq -r '.content' | jq '.categories[] | {label, totalBytes, fraction}'

# Top 10 notable directories with their dominant content type
swamp data get --workflow disk current --json \
  | jq -r '.content' | jq '.notableDirs[0:10] | .[] | {name, bytes, dominantCategory, depth}'

# Largest individual files
swamp data get --workflow disk current --json \
  | jq -r '.content' | jq '.notableFiles[0:10] | .[] | {name, bytes, category}'
```

You can also use the model directly:

```sh
# Create a model that audits /var
swamp model create @svendowideit/disk-auditor var-disk \
  --global-arg path=/var

# Run the audit — no depth or top-N args needed
echo '{}' | swamp model method run var-disk audit --stdin

# Read the latest snapshot
swamp data get var-disk current --json
```

## Method arguments

| Argument          | Type     | Default              | Description                                                              |
| ----------------- | -------- | -------------------- | ------------------------------------------------------------------------ |
| `excludePatterns` | string[] | `[".git", ".swamp"]` | Glob-style directory names to skip                                       |
| `followSymlinks`  | boolean  | `false`              | Whether to follow symbolic links when summing sizes                      |
| `minNotableBytes` | integer  | `1048576`            | Minimum size in bytes for a file or dir to be considered notable (1 MiB) |

The `path` global argument sets the root to audit. There is **no depth or top-N
argument** — the walk is full-depth and the output adapts to what's found.

## Output structure

| Field          | Type   | Description                                                            |
| -------------- | ------ | ---------------------------------------------------------------------- |
| `totalBytes`   | number | Total bytes consumed by all files under the root                       |
| `totalFiles`   | number | Total number of files found                                            |
| `totalDirs`    | number | Total number of subdirectories found                                   |
| `categories`   | array  | Per-category rollups (label, totalBytes, fileCount, fraction)          |
| `notableDirs`  | array  | Large or category-dominant dirs (path, bytes, dominantCategory, depth) |
| `notableFiles` | array  | Large individual files (path, bytes, category)                         |
| `findings`     | array  | Semantic grouped insights (kind, title, category, totalBytes, count)   |
| `errors`       | array  | Per-path errors encountered during the walk (path, message)            |

## Content categories

Files are classified into one of 14 categories by extension and path context:

| Category     | Examples                                                        |
| ------------ | --------------------------------------------------------------- |
| video        | `.mp4`, `.mkv`, `.avi`, `.mov`, `.webm`, `.flv`, `.wmv`         |
| audio        | `.mp3`, `.ogg`, `.flac`, `.aac`, `.opus`, `.wav`                |
| audiobook    | `.m4b`, `.aax`, `.m4a` under audiobook/audible/librivox paths   |
| ebook        | `.epub`, `.mobi`, `.azw`, `.azw3`, `.pdf`, `.djvu`, `.fb2`      |
| image        | `.jpg`, `.png`, `.gif`, `.webp`, `.heic`, `.raw`, `.cr2`        |
| docker       | Docker storage dirs (`overlay2`, `containers`, `volumes`, ...)  |
| vm           | `.qcow2`, `.vmdk`, `.vdi`, `.vhd`, `.vhdx`, `.iso`, `.img`      |
| database     | `.db`, `.sqlite`, `.sqlitedb`, `.mdb`, `.accdb`                 |
| parquet      | `.parquet`, `.arrow`, `.orc`, `.avro`                           |
| archive      | `.zip`, `.tar`, `.gz`, `.bz2`, `.xz`, `.7z`, `.rar`, `.zst`     |
| code         | `.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.sh` |
| logs         | `.log`, `.out`, `.err`                                          |
| node_modules | `node_modules/` directories (detected by name)                  |
| other        | Anything that doesn't match the above                           |

## Semantic findings

The `findings` array groups related items into insights:

- **Per-category**: categories consuming >2% of total disk get a finding
  ("Ebooks: 22563 files, 26.3 GiB (21%)")
- **Books combined**: audiobooks + ebooks combined into one finding, AND each
  noted separately — so you see both "Books: 22570 files, 27.7 GiB" and "Ebooks:
  22563 files, 26.3 GiB"
- **Docker**: groups docker-category dirs into "3 Docker images: 12 GiB"
- **Parquet**: large parquet files called out specifically
- **VM images**: `.qcow2`/`.vmdk`/`.iso` files grouped together
- **node_modules**: all `node_modules/` dirs grouped and totalled

## How it works

The method walks the configured `path` iteratively (stack-based, not recursive)
using `Deno.readDir` and sizes each entry with `Deno.stat` (or `Deno.lstat` when
not following symlinks). Every file is classified by extension and path context
into a content category. Per-directory category breakdowns propagate up the
tree, so each directory's `dominantCategory` reflects what's actually inside it
(>50% of bytes in one category). Notable directories are selected if they are
large (> `minNotableBytes`), a significant fraction of the total (>1%), or have
a dominant content category.

Progress is logged every 2 seconds with: elapsed time, total bytes found
(human-readable), file/dir counts, error count, the current directory being
walked, and the 3 largest items found so far.

Errors (permission denied, broken symlinks, vanished files) are collected per
path and returned in the `errors` array rather than aborting the whole audit —
so a single unreadable subdirectory won't lose you the rest of the tree.

A **summary report** (`@svendowideit/disk-summary`) runs automatically after
each audit and prints a formatted markdown table with findings, categories,
largest directories, and largest files. The report is a standalone extension in
`extensions/reports/disk_audit_report.ts`, auto-attached via the model's
`reports` field. For very large trees (>1M files), use `--skip-reports` to
suppress the built-in `@swamp/method-summary` report (which can overflow on huge
outputs) — the `@svendowideit/disk-summary` report handles large trees fine.

No external services, credentials, or network access are required. The extension
only reads the local filesystem under the configured `path`.

## License

MIT — see LICENSE.txt for details.
