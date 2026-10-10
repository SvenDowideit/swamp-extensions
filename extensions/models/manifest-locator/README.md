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
the **extension** version.

The model object also carries its own `version` — the **model-type / schema**
version that drives `typeVersion` and the `upgrades` chain. That is a different
version in swamp, and this demo keeps it deliberately different from the
manifest version to show the two are independent (an unchanged model keeps its
version across extension releases). `manifest_locator_version_test.ts` asserts
they stay different.

The `locate` method logs the path together with both versions and writes a
`location` resource containing:

| Field             | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `manifestPath`    | Absolute path to the extension's `manifest.yaml`              |
| `exists`          | Whether the file was found at that path                       |
| `manifestVersion` | The extension version: `version:` parsed from the manifest    |
| `modelVersion`    | The model schema version from the exported `model` object     |
| `versionsMatch`   | Whether the two are equal (they should not be)                |
| `manifest`        | The raw manifest contents                                     |

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

Run the method and print the manifest path and both versions:

```sh
swamp model @svendowideit/manifest-locator method run locate manifest-locator
```

Read the recorded path and versions from the resource:

```sh
swamp data query 'model("manifest-locator") && name == "location"' --select content
```

Confirm the model schema version differs from the extension version:

```sh
swamp data query 'model("manifest-locator") && name == "location"' --select content \
  | jq -r '"extension=\(.manifestVersion) model=\(.modelVersion) match=\(.versionsMatch)"'
```

## Details

- Model `@svendowideit/manifest-locator` (source `manifest_locator.ts`),
  schema version `MODEL_VERSION` (kept distinct from the manifest version).
- Method `locate` — writes the `location` resource; logs `manifest.yaml: <path>`,
  `extension (manifest) version: <v>`, `model (schema) version: <v>`, and
  `versions match: <bool>`.
- Tests: `manifest_locator_test.ts` (path resolution, both layouts) and
  `manifest_locator_version_test.ts` (versions stay different).
