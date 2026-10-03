# @svendowideit/settings-server

A [swamp](https://swamp-club.com) model extension that stages a rendered settings
bundle into a versioned webroot and verifies it over HTTP. It is the "publish
the contract over the network" half of a settings-as-source-of-truth setup: pair
it with `@svendowideit/otel-settings` to render documents and
`@svendowideit/caddy` to serve them.

## What it does

Takes a directory of rendered documents (the `current` output of
`@svendowideit/otel-settings`, or any static tree) and stages it into a stable
webroot layout:

- immutable `v/<version>/` directories (content-addressed),
- a `current` pointer (symlink, or copied tree where symlinks are unavailable),
- an HTTP `verify` that fetches the index document and reports status/content
  type/size, and
- a `serve` method that reports the exact `@svendowideit/caddy serveSettings`
  wiring for the current webroot.

It does **not** run its own web server — static serving is delegated to Caddy, so
DNS, TLS, and file serving stay on one tested path.

Side effects: it writes files under `webroot` (default
`~/.local/share/settings-server`) and writes swamp resources. `verify` makes an
outbound HTTP request. Nothing else changes on the host.

## Install

```sh
swamp extension pull @svendowideit/settings-server
```

No dependencies. For HTTPS serving, add `@svendowideit/caddy`; for rendering the
documents, add `@svendowideit/otel-settings`.

## Configuration

Global arguments are set at model creation (or `swamp model edit settings`).
`sourceDir` and `hostname` are required.

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `sourceDir` | string | *(required)* | Directory containing the rendered documents (e.g. `~/.local/share/otel-settings/current`). |
| `hostname` | string | *(required)* | Public hostname the documents are served on (e.g. `settings.otel.fi.gy`). |
| `webroot` | string | `~/.local/share/settings-server` | Directory Caddy serves; `current` and `v/<version>` are staged here. |
| `indexDocument` | string | `otel.json` | Document fetched to verify the server is live. |
| `publishBaseUrl` | string | derived | Override the verification base URL; empty derives `https://<hostname>`. |

## Examples

Create a model and publish the rendered documents:

```sh
# sourceDir points at the otel-settings current output; hostname is the URL.
swamp model create @svendowideit/settings-server settings \
  --global-arg sourceDir=~/.local/share/otel-settings/current \
  --global-arg webroot=~/.local/share/settings-server \
  --global-arg hostname=settings.example.com
swamp model method run settings publish
```

Verify the live URL after Caddy is serving:

```sh
# Fetches https://settings.example.com/otel.json and reports its status.
swamp model method run settings verify
```

Pin a manual version label instead of the content-derived one:

```sh
# Useful when you want a human-readable version directory such as v/2026-10-01.
swamp model method run settings publish --input version=2026-10-01
```

Get the exact Caddy wiring for a workflow step:

```sh
# Reports hostname + current webroot and the serveSettings command to run.
swamp model method run settings serve
```

Verify a specific document (e.g. check the env block is served):

```sh
swamp model method run settings verify --input expectDocument=otel.env
```

## Details

`@svendowideit/settings-server` ships one model type
(`@svendowideit/settings-server`). Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `publish` | `sourceDir` (string, optional), `version` (string, optional) | Walk `sourceDir`, write each file into `v/<version>/`, compute SHA-256 per document, and flip `current`. Version defaults to the source `version.json` hash, else a content hash. |
| `verify` | `expectDocument` (string, optional), `timeoutMs` (integer, default 5000) | Fetch `https://<hostname>/settings/<document>` and write a `verify` resource with `ok`, `status`, `contentType`, and `bytes`. |
| `serve` | none | Write a `serve` resource describing the hostname, current webroot, URL, and the `@svendowideit/caddy serveSettings` command to apply. |

Resources: `publish` (staged bundle manifest), `verify` (HTTP result), and
`serve` (Caddy wiring).

### Webroot layout

```
<webroot>/
  current -> v/<version>        # symlink (or copied tree on symlink-less fs)
  v/<version>/
    otel.json
    otel.env
    otel.md
    agent-config/T1.yaml
    install/linux-amd64.json
    version.json
```

The `verify` method fetches `<base>/<indexDocument>` (documents are served at the
root, because the hostname already names the settings host — e.g.
`https://settings.otel.fi.gy/otel.json`). Caddy's `serveSettings` `root` must be
`<webroot>/current` and its route should mount the documents at `/`.

### Content-addressing and caching

`deriveVersion` prefers the `version` field in the source `version.json`
(written by `@svendowideit/otel-settings`) and otherwise hashes the sorted
`(path, size)` list, so identical trees always stage to the same directory. That
makes re-publishing idempotent and lets consumers pin `v/<version>` or follow
`current` for cache-friendly immutability.

### Extending and testing

- Pure, exported helpers carry the logic: `expandHome`, `baseUrl`,
  `contentTypeFor`, `deriveVersion`, `contentHashHex`, `validateConfig`. `publish`
  is the only filesystem method and `verify` the only network method.
- Add a new document type by writing it into `sourceDir`; staging is
  content-agnostic (it walks whatever is there).
- Run the tests with the bundled deno:
  `~/.swamp/deno/deno test --allow-env --allow-read --allow-write --allow-net extensions/models/settings-server/settings_server_test.ts`.

### Secrets

The served documents are static files; this model never injects secrets. Keep
credentials out of the rendered bundle (see `@svendowideit/otel-settings`) and
protect the route with Caddy auth where the documents are not public.

## License

MIT — see LICENSE.txt.
