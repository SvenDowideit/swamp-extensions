# @figy/sbom-to-dependencytrack

fi.gy's site-specific SBOM submission. Generates an SBOM for any target with
[`@svendowideit/generate-sbom-syft`](../models/generate-sbom-syft) and uploads it
to my Dependency-Track with [`@svendowideit/curl`](../models/curl), tagging each
project with the host it came from.

## What it does

One workflow, `@figy/sbom-to-dependencytrack`, that wires two portable pieces to
my infrastructure:

- **generate** — runs the generic `@svendowideit/generate-sbom` workflow (a
  syft scan of a host, image, binary or source tree), producing an `sbom` file
  as swamp data. This step is entirely portable; the workflow names no consumer.
- **upload** — POSTs the SBOM to my Dependency-Track as
  `multipart/form-data` via `@svendowideit/curl`. The BOM endpoint comes from my
  local `dependencytrack` model's `agentKey` data and the API key from my local
  vault.
- **host tag** — the project is tagged with the host it came from, detected from
  `$HOSTNAME` (override with `--input host=…`).

Dependency-Track is modelled as **one project per (software, version)** —
`projectName` is the software, `projectVersion` its version — with the host as a
project **tag**. So each machine's version of a piece of software becomes its
own project, and "which hosts run which version" is a tag filter in the
portfolio.

Side effects: outbound HTTPS to GitHub (syft release), to the target image's
registry, and to my Dependency-Track; it writes swamp resources and files.
Nothing is installed on the host.

## Install

```sh
swamp extension pull @figy/sbom-to-dependencytrack
```

`@svendowideit/generate-sbom-syft`, `@svendowideit/curl` and
`@svendowideit/dependencytrack` are pulled automatically. A running
Dependency-Track whose agent key can upload **and tag** is required (the
`dependencytrack` extension grants `TAG_MANAGEMENT` by default), with the key in
the `dependencytrack-secrets` vault.

## Configuration

Inputs (all optional except `target`, `projectName`, `projectVersion`):

| Input | Default | Description |
| ----- | ------- | ----------- |
| `target` | — | What to scan: a path, a binary, or a container image reference. |
| `targetType` | `""` | Syft source scheme: `dir`, `file`, `image`, `registry`, `docker`, `podman`, `oci-archive`, `oci-dir`, `singularity`, `purl`, `sbom`. |
| `projectName` | — | Dependency-Track project name — the software (e.g. `caddy`). |
| `projectVersion` | — | Dependency-Track project version (e.g. `2.11.6`). |
| `host` | `""` | Host tag; empty detects it from `$HOSTNAME`. |
| `format` | `cyclonedx-json` | SBOM format (`cyclonedx-json`/`-xml`, `spdx-json`/`-tag-value`, `syft-json`). |
| `label` | `sbom` | Swamp data name for the produced SBOM file. |
| `exclude` | `[]` | Syft glob exclusions (e.g. `**/proc/**`). |
| `catalogers` | `[]` | Syft catalogers to enable. |
| `scanModel` | `sbom-tool` | The `generate-sbom-syft` model instance to drive. |
| `uploadModel` | `dt-upload` | The `curl` model instance to drive. |
| `dtModel` | `dependencytrack` | The `dependencytrack` model instance whose `agentKey` endpoint is used. |
| `vaultName` | `dependencytrack-secrets` | Vault holding the agent API key. |
| `vaultKey` | `DEPENDENCYTRACK_API_KEY` | Vault key holding the agent API key. |
| `uploadUrl` | `""` | Override the BOM endpoint; empty uses the `dtModel` endpoint. |

## Examples

```sh
# SBOM a binary on this machine and upload it; the host tag is detected from
# $HOSTNAME (run `export HOSTNAME=$(hostname)` if your shell does not export it).
swamp workflow run @figy/sbom-to-dependencytrack \
  --input target=/home/sven/.local/bin/caddy --input targetType=file \
  --input projectName=caddy --input projectVersion=2.11.6

# SBOM a container image and tag the project with an explicit host.
swamp workflow run @figy/sbom-to-dependencytrack \
  --input target=ghcr.io/dependencytrack/apiserver:5.1.2 --input targetType=image \
  --input projectName=ghcr.io/dependencytrack/apiserver --input projectVersion=5.1.2 \
  --input host=x1yoga

# SBOM this host's whole filesystem, excluding the virtual filesystems.
swamp workflow run @figy/sbom-to-dependencytrack \
  --input target=/ --input targetType=dir \
  --input projectName=host-x1yoga --input projectVersion=1.0.0 \
  --input 'exclude:json=["**/proc/**","**/sys/**","**/dev/**","**/run/**"]'
```

## Upgrade

This extension installs nothing on the host — no services, daemons, cron
triggers or webhooks — so an upgrade has nothing to rebuild or reconcile.
Refresh the pulled workflow with one idempotent command:

```sh
swamp extension update
```

## Details

`@figy/sbom-to-dependencytrack` ships one workflow (no models). Steps:

| Step | Task | Produces |
| ---- | ---- | -------- |
| `generate` | workflow `@svendowideit/generate-sbom` | an `sbom` file on `scanModel` |
| `upload` | model_method `@svendowideit/curl` `post` | a `request` resource `upload-<label>` |
| `verify-upload` | assert `...attributes.ok == true` | — |

The `upload` step sends `multipart` fields `autoCreate`, `projectName`,
`projectVersion` and `projectTags` (the host), and attaches the SBOM with
`files` read from `data.latest(scanModel, label).path`.

### Why the split

Generation is portable and lives in `@svendowideit/generate-sbom-syft`; the
upload primitive lives in `@svendowideit/curl`. This extension is deliberately
site-specific: it encodes the fi.gy Dependency-Track instance, its vault and the
host naming convention, so it is useless without them. The portable halves carry
no dependency-tracker coupling and can feed any number of systems.

## License

MIT — see LICENSE.txt.
