# @svendowideit/manifest-locator

A minimal demonstration swamp extension whose method resolves, while running,
the absolute path to the `manifest.yaml` the model was loaded from.

## What it does

`ctx.extensionFile()` is the sanctioned way to resolve a bundled asset, but its
resolution root depends on how the extension was loaded: a source-loaded
extension resolves assets beside its `manifest.yaml`, while a *pulled* extension
resolves them under `<extension-dir>/files/` with the `manifest.yaml` one level
up. There is no API that returns the manifest path directly.

So the method anchors on an asset this extension always ships (`README.md`,
`LICENSE.txt`, then the extension files root itself) and **walks up** from
wherever that lands until it finds a `manifest.yaml`. That works in both the
source and pulled layouts, making the manifest the single source of truth for
the extension's version — with no version literal duplicated in the TypeScript.

The `locate` method logs that path and writes a `location` resource containing:

| Field          | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `manifestPath` | Absolute path to the extension's `manifest.yaml`               |
| `exists`       | Whether the file was found at that path                        |
| `version`      | The `version:` parsed from the manifest                        |
| `manifest`     | The raw manifest contents                                      |

## Install

For local development, register the source directory:

```sh
swamp extension source add extensions/models/manifest-locator
```

When published, install with:

```sh
swamp extension pull @svendowideit/manifest-locator
```

## Configuration

No global arguments.

## Examples

Run the method and print the manifest path and version:

```sh
swamp model @svendowideit/manifest-locator method run locate manifest-locator
```

Read the recorded path and version from the resource:

```sh
swamp data query 'model("manifest-locator") && name == "location"' --select content
```

Confirm the reported version matches the manifest on disk:

```sh
swamp data query 'model("manifest-locator") && name == "location"' --select content \
  | jq -r '.version'
```

## Details

- Model `@svendowideit/manifest-locator` (source `manifest_locator.ts`).
- Method `locate` — writes the `location` resource; logs `manifest.yaml: <path>`
  and `manifest.yaml version: <version>`.
