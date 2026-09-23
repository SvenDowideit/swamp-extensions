# @svendowideit/disk-auditor

A swamp model extension that answers the question _"what is eating my disk
space?"_ for a local filesystem path.

## What it does

Walks the entire directory tree under a path, **classifies every file by content
type** (video, audio, audiobooks, ebooks, docker, VM images, parquet, databases,
archives, code, node_modules, etc.), and produces **semantic findings** — grouped
insights like "Docker: 3 storage dirs, 12 GiB" or "Books (audiobooks + ebooks):
22570 files, 27.7 GiB". Unlike `df`-based tools that only report per-mount free
space, it tells you which files and directories are actually consuming it.

There is no depth or top-N argument — the output adapts to what it finds. It is
**cross-platform** (Deno runtime APIs only; no `du`, `find`, or PowerShell), and
the walk is **iterative** (stack-based, not recursive), so it handles trees with
millions of files and deep nesting without stack overflow. Side effects: it reads
the filesystem under `path` and writes one `audit` resource; it touches nothing
else.

## Install

```sh
swamp extension pull @svendowideit/disk-auditor
```

No dependencies — it uses only Deno runtime APIs and the bundled deno binary
that swamp already ships.

## Configuration

Set the `path` global argument when creating the model; the `audit` method takes
optional per-run inputs:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `path` (global arg) | string | required | Filesystem path to audit. |
| `excludePatterns` | string[] | `[".git", ".swamp"]` | Glob-style directory names to skip. |
| `followSymlinks` | boolean | `false` | Whether to follow symbolic links when summing sizes. |
| `minNotableBytes` | integer | `1048576` | Minimum size in bytes for a file or dir to be "notable" (1 MiB). |

Relative paths (`.`, `./foo`, `../bar`) and `~` are expanded to absolute,
canonical paths before scanning, so logs and recorded data are always fully
qualified and unambiguous. There is **no depth or top-N argument** — the walk is
full-depth and the output adapts to what is found.

## Examples

Create a model for a path and run the audit:

```sh
# Create a model that audits /home.
swamp model create @svendowideit/disk-auditor home-disk \
  --global-arg path=/home

# Run the audit — no depth or top-N args needed.
swamp model method run home-disk audit
```

Run without a persistent definition, passing the path at run time:

```sh
# Audit /var directly; the model definition is created on first use.
swamp model @svendowideit/disk-auditor method run audit var-disk \
  --input path=/var
```

Skip extra directories and read the structured result:

```sh
# Audit /home, also skipping node_modules.
swamp model @svendowideit/disk-auditor method run audit home-disk \
  --input path=/home \
  --input 'excludePatterns:json=[".git","node_modules"]'

# Read the latest snapshot as JSON, e.g. all finding titles.
swamp data get home-disk current --json \
  | jq -r '.content' | jq '.findings[] | .title'

# Per-category rollup.
swamp data get home-disk current --json \
  | jq -r '.content' | jq '.categories[] | {label, totalBytes, fraction}'

# Top 10 notable directories with their dominant content type.
swamp data get home-disk current --json \
  | jq -r '.content' | jq '.notableDirs[0:10] | .[] | {name, bytes, dominantCategory, depth}'
```

If you forget `path`, the tool prints a help message with every input, its type,
default, and an example — no cryptic error.

## Details

`@svendowideit/disk-auditor` ships one model type
(`@svendowideit/disk-auditor`) with one method, `audit`, and one report,
`@svendowideit/disk-summary`. The method writes an `audit` resource.

A **formatted summary table** prints automatically after each scan — no need to
run `swamp data get` separately. It shows findings (notable first), per-category
rollups, largest directories, and largest files, in human-readable sizes:

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

### Output structure

| Field | Type | Description |
| ----- | ---- | ----------- |
| `totalBytes` | number | Total bytes consumed by all files under the root. |
| `totalFiles` | number | Total number of files found. |
| `totalDirs` | number | Total number of subdirectories found. |
| `categories` | array | Per-category rollups (label, totalBytes, fileCount, fraction). |
| `notableDirs` | array | Large or category-dominant dirs (path, bytes, dominantCategory, depth). |
| `notableFiles` | array | Large individual files (path, bytes, category). |
| `findings` | array | Semantic grouped insights (kind, title, category, totalBytes, count). |
| `errors` | array | Per-path errors encountered during the walk (path, message). |

### Content categories

Files are classified into one of 14 categories by extension and path context:

| Category | Examples |
| -------- | -------- |
| video | `.mp4`, `.mkv`, `.avi`, `.mov`, `.webm`, `.flv`, `.wmv` |
| audio | `.mp3`, `.ogg`, `.flac`, `.aac`, `.opus`, `.wav` |
| audiobook | `.m4b`, `.aax`, `.m4a` under audiobook/audible/librivox paths |
| ebook | `.epub`, `.mobi`, `.azw`, `.azw3`, `.pdf`, `.djvu`, `.fb2` |
| image | `.jpg`, `.png`, `.gif`, `.webp`, `.heic`, `.raw`, `.cr2` |
| docker | Docker storage dirs (`overlay2`, `containers`, `volumes`, …) |
| vm | `.qcow2`, `.vmdk`, `.vdi`, `.vhd`, `.vhdx`, `.iso`, `.img` |
| database | `.db`, `.sqlite`, `.sqlitedb`, `.mdb`, `.accdb` |
| parquet | `.parquet`, `.arrow`, `.orc`, `.avro` |
| archive | `.zip`, `.tar`, `.gz`, `.bz2`, `.xz`, `.7z`, `.rar`, `.zst` |
| code | `.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.sh` |
| logs | `.log`, `.out`, `.err` |
| node_modules | `node_modules/` directories (detected by name) |
| other | Anything that doesn't match the above |

### Semantic findings

The `findings` array groups related items into insights:

- **Per-category**: categories consuming >2% of total disk get a finding
  ("Ebooks: 22563 files, 26.3 GiB (21%)").
- **Books combined**: audiobooks + ebooks combined into one finding, AND each
  noted separately — so you see both "Books: 22570 files, 27.7 GiB" and
  "Ebooks: 22563 files, 26.3 GiB".
- **Docker**: groups docker storage dirs (`overlay2`, `containers`, `volumes`, …)
  into "Docker: 3 storage dirs, 12 GiB".
- **Parquet**: large parquet files called out specifically.
- **VM images**: `.qcow2`/`.vmdk`/`.iso` files grouped together.
- **node_modules**: all `node_modules/` dirs grouped and totalled.

### How it works

The method walks the configured `path` iteratively (stack-based, not recursive)
using `Deno.readDir` and sizes each entry with `Deno.stat` (or `Deno.lstat` when
not following symlinks). Every file is classified by extension and path context
into a content category. Per-directory category breakdowns propagate up the tree,
so each directory's `dominantCategory` reflects what's actually inside it (>50%
of bytes in one category). Notable directories are selected if they are large
(> `minNotableBytes`), a significant fraction of the total (>1%), or have a
dominant content category.

Progress is logged every 2 seconds with elapsed time, total bytes found
(human-readable), file/dir counts, error count, the current directory being
walked, and the 3 largest items found so far.

Errors (permission denied, broken symlinks, vanished files) are collected per
path and returned in the `errors` array rather than aborting the whole audit —
so a single unreadable subdirectory won't lose you the rest of the tree.

### Extending and testing

The model lives in `disk_auditor.ts`; the summary table is a standalone report in
`disk_audit_report.ts`, attached via the model's `reports` field. For very large
trees (>1M files), use `--skip-reports` to suppress the built-in
`@swamp/method-summary` report (which can overflow on huge outputs) — the
`@svendowideit/disk-summary` report handles large trees fine.

```sh
# Type-check and run the unit tests.
~/.swamp/deno/deno check disk_auditor.ts
~/.swamp/deno/deno test --allow-read --allow-env disk_auditor_test.ts
```

To add a category, extend the `CATEGORIES` list and the extension/path matching
in `disk_auditor.ts`.

## License

MIT — see LICENSE.txt for details.
