# @svendowideit/generate-sbom-syft

Generate Dependency-Track-ready SBOMs with [Anchore Syft](https://github.com/anchore/syft)
for a whole host, a container image, a single binary, or a source tree — one
model, four kinds of target. The Syft binary is fetched and checksum-verified
for you and cached; the SBOM is captured as swamp data so the next step can curl
it to Dependency-Track.

## What it does

- **One scanner for four targets** — `dir:` walks a complete host filesystem or
  a source repository, `file:` a single binary, and `image:`/`registry:`/`docker:`
  a container image. `targetType` prepends the right scheme; a target that
  already carries a known scheme is honored as-is.
- **Dependency-Track-ready output** — `outputFormat` (default `cyclonedx-json`)
  also supports `cyclonedx-xml`, `spdx-json`, `spdx-tag-value` and `syft-json`.
  Dependency-Track accepts the CycloneDX and SPDX forms directly.
- **Turnkey tool** — the syft release is resolved and checksum-verified through
  [`@svendowideit/github-release-install`](../github-release-install), extracted
  and cached under `stateDir`. An already-installed, working binary is reused.
  Point `syftPath` at your own syft to skip all of that.
- **Data, not loose files** — `generate` writes the SBOM as an `sbom` file
  resource (with the correct MIME type), optionally also to `outputFile`, and a
  `scan` resource summarising the run: format, spec version, package count,
  source name/version, size, duration and process outcome.
- **Tunable scans** — `catalogers`, `exclude` (syft glob syntax, e.g.
  `**/proc/**`), image `scope`/`platform`, and `sourceName`/`sourceVersion` to
  control how Dependency-Track names the project.
- **Generic, composable** — the bundled `@svendowideit/generate-sbom` workflow
  produces an SBOM and exposes its path; it names no consumer. A site-specific
  workflow (e.g. in your own collective) reads that path and submits the SBOM
  wherever you need — a Dependency-Track, a store, an S3 bucket.

Side effects: outbound HTTPS to GitHub (to fetch the verified syft release) and
to the target image's registry; it writes the cached binary and archive under
`stateDir` (default `~/.swamp/generate-sbom-syft`), the SBOM file, and swamp
resources. Nothing is installed on the host.

## Install

```sh
swamp extension pull @svendowideit/generate-sbom-syft
```

`@svendowideit/github-release-install` is pulled automatically. A `tar` binary
must be on `PATH` to extract the release.

## Configuration

Global arguments (set at model creation with `--global-arg key=value`):

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `syftPath` | string | `""` | Pre-installed syft binary; empty auto-installs and caches one. |
| `syftVersion` | string | `""` | Syft release to install; empty installs the latest. |
| `repo` | string | `anchore/syft` | GitHub repository publishing the releases. |
| `stateDir` | string | `~/.swamp/generate-sbom-syft` | Cache root for the binary and archives. |
| `githubToken` | string | `""` | Token for the release API (sensitive); empty falls back to `GITHUB_TOKEN` / `GH_TOKEN` / `gh`. |
| `outputFormat` | enum | `cyclonedx-json` | Default SBOM format. |
| `catalogers` | string[] | `[]` | Default catalogers (e.g. `os`, `python`); empty = all. |
| `exclude` | string[] | `[]` | Default exclusions, in syft glob syntax (`**/proc/**`). |
| `scope` | enum | `""` | Image layer scope: `""` (default), `squashed`, `all-layers`. |
| `sourceName` | string | `""` | Default SBOM source name (the Dependency-Track project). |
| `sourceVersion` | string | `""` | Default SBOM source version. |
| `timeoutMs` | number | `900000` | Maximum scan time (a host scan can take minutes). |

Per-call arguments for `generate`:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `target` | string | — | What to scan: a path, a binary, or an image reference (required). |
| `targetType` | enum | `""` | Scheme to prepend: `dir`, `file`, `image`, `registry`, `docker`, `podman`, `oci-archive`, `oci-dir`, `singularity`, `purl`, `sbom`. |
| `format` | enum | — | Override `outputFormat`. |
| `catalogers` / `exclude` | string[] | — | Override the globals. |
| `scope` | enum | — | Override the global image scope. |
| `platform` | string | `""` | Image platform, e.g. `linux/amd64`. |
| `sourceName` / `sourceVersion` | string | — | Override the globals. |
| `label` | string | `""` | Name for the SBOM file (empty = generated). |
| `outputFile` | string | `""` | Also write the SBOM to this path. |
| `timeoutMs` | number | — | Override the global timeout. |

`install` takes `force` (boolean). `status` takes no arguments.

## Examples

```sh
# Scan this whole host. `dir:/` walks the root filesystem; exclude the virtual
# filesystems so the scan stays fast, and name the project explicitly. Excludes
# use syft glob syntax, which must start with ./, */ or **/.
swamp model @svendowideit/generate-sbom-syft method run generate host \
  --input target=/ --input targetType=dir \
  --input sourceName=my-host --input sourceVersion=1.0.0 \
  --input 'exclude:json=["**/proc/**","**/sys/**","**/dev/**","**/run/**"]' \
  --input outputFile=~/sbom/my-host.cdx.json

# Scan a container image read straight from the registry (no local runtime
# needed) and emit SPDX 2.3 instead of CycloneDX.
swamp model @svendowideit/generate-sbom-syft method run generate image \
  --input target=alpine:3.19 --input targetType=registry \
  --input format=spdx-json

# Scan a single binary — useful for inventorying a vendored executable.
swamp model @svendowideit/generate-sbom-syft method run generate bin \
  --input target=/usr/bin/curl --input targetType=file

# Install (or refresh) the checksum-verified syft binary without scanning.
swamp model @svendowideit/generate-sbom-syft method run install syft --input force=true

# Or run the generic workflow, which scans the target and exposes the SBOM path
# for any caller to consume.
swamp workflow run @svendowideit/generate-sbom \
  --input target=/home/alice/.local/bin/caddy --input targetType=file \
  --input label=caddy
```

The produced file is at `data.latest("sbom", "caddy").path`. A site-specific
workflow composes this with whatever submits the SBOM (e.g. a Dependency-Track
via `@svendowideit/curl`) — see `@figy/sbom-to-dependencytrack` for a worked
example in the figy collective.

## Upgrade

This extension installs nothing on the host — no services, daemons, cron
triggers or webhooks — so an upgrade has nothing to rebuild or reconcile.
Refresh the pulled model type and its bundled files with one idempotent
command:

```sh
swamp extension update
```

The cached syft binary refreshes itself on the next scan (or immediately with
`install --input force=true`); swamp data is never touched.

## Details

`@svendowideit/generate-sbom-syft` ships one model type with three methods:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `generate` | `target`, `targetType`, `format`, `catalogers`, `exclude`, `scope`, `platform`, `sourceName`, `sourceVersion`, `label`, `outputFile`, `timeoutMs` | an `sbom` file; a `scan` resource |
| `install` | `force` | a `tool` resource |
| `status` | none | a `status` resource |

### Resources and files

- **`sbom`** (file) — the generated SBOM document, with a format-specific
  content type (`application/vnd.cyclonedx+json`, `application/spdx+json`, …).
  Reach it via `data.latest("<model>", "<label>").path`.
- **`scan`** — the run summary: `target`, `targetType`, `format`, `sbomFormat`,
  `specVersion`, `packageCount`, `sourceName`, `sourceVersion`, `toolVersion`,
  `toolPath`, `outputFile`, `sizeBytes`, `durationMs`, `exitCode`, `command`,
  `stderr`, `generatedAt`. Named `scan-<label>`.
- **`tool`** — the resolved binary: `path`, `version`, `source`
  (`path`|`installed`), `archivePath`, `cached`, `platform`, `installedAt`.
- **`status`** — `ready`, `stateDir`, `repo`, `syftVersion`, `outputFormat`,
  `syftPath`, `toolPath`, `installedVersions`.

### Workflow — `@svendowideit/generate-sbom`

A deliberately generic one-step workflow: `generate` (`@svendowideit/generate-sbom-syft`)
scans `target`/`targetType` and writes the SBOM file (named `label`, default
`sbom`) and a `scan` resource.

Inputs: `target`, `targetType`, `format`, `label`, `exclude`, `catalogers`,
`sourceName`, `sourceVersion`, `scanModel`.

It names no consumer. A caller reads the produced SBOM via
`data.latest(scanModel, label).path` and submits it wherever it needs — e.g.
`@figy/sbom-to-dependencytrack` uploads it to a Dependency-Track (multipart POST
via `@svendowideit/curl`, one project per software+version, tagged with the
host). Keeping generation and submission separate means this extension carries
no dependency-tracker coupling.

### Tool resolution

`generate` and `install` both call the same resolver: with `syftPath` set it
probes that binary; otherwise it asks `@svendowideit/github-release-install` to
download the verified release archive to `<stateDir>/downloads/`, extracts the
`syft` binary to `<stateDir>/bin/syft/<version>/<os>-<arch>/`, and caches it. An
existing, working binary is reused unless `install --input force=true`.

### Structure and testing

- `generate_sbom_syft.ts` — the model. Pure, exported helpers (`resolveTarget`,
  `buildSyftArgs`, `summarizeBom`, `parseSyftVersion`, `hostOs`, `hostArch`, …)
  carry the logic; `ensureTool` and `generate` wire them to subprocesses.
- `generate_sbom_syft_test.ts` — colocated tests. Unit tests cover the target
  resolver, argv builder and SBOM summariser; execute-level tests drive the real
  methods with a fake syft script (so they need no network), asserting the file
  and `scan`/`tool`/`status` records and the failure path.

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env \
  --allow-run --allow-net --allow-ffi \
  extensions/models/generate-sbom-syft/generate_sbom_syft_test.ts
```

## License

MIT — see LICENSE.txt.
