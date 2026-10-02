# @svendowideit/otel-settings

A [swamp](https://swamp-club.com) model extension that resolves **one**
observability contract for a whole fleet and renders it as fetchable HTTP
documents. It is the "settings as the single source of truth" part of an
OpenTelemetry deployment: change the contract in one place, and every host,
container, and agent fetches it at runtime instead of being hand-configured.

## What it does

Resolves a typed contract — OTLP endpoint names per mesh, resource-attribute
conventions, sampling, retention, cardinality budget, and per-tier agent
defaults — and emits it in two forms:

- a **`settings` resource** that other swamp models reference via CEL
  expressions, and
- the **HTTP document set** written to a directory:
  `otel.json` (machine contract), `otel.env` (`OTEL_EXPORTER_OTLP_*` block),
  `agent-config/<tier>.yaml` (per-tier collector configs), `install/<os>-<arch>.json`
  (verified release-asset URLs), `otel.md` (human summary), `index.html` (landing
  page for `GET /`), and `version.json`.

Documents are **immutable and versioned**: each render writes a content hash and
a `v/<hash>` directory, then flips a `current` pointer (a symlink, or a copied
tree where symlinks are unavailable), so consumers pin a version or follow
`current`. It is generic — it makes no assumptions about your domains beyond the
zone you pass to `domain`.

Side effects: it writes files under `outputDir` (default
`~/.local/share/otel-settings`) and writes swamp resources. It changes nothing
else on the host.

## Install

```sh
swamp extension pull @svendowideit/otel-settings
```

No dependencies. To serve the rendered directory over HTTP(S), pair it with
`@svendowideit/settings-server`, which calls `@svendowideit/caddy`'s
`serveSettings`.

## Configuration

Global arguments are set at model creation (or `swamp model edit otel`). Only
`domain` is required; the rest have sensible defaults.

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `domain` | string | *(required)* | Observability zone (e.g. `otel.fi.gy`). `settingsUrl` derives as `https://settings.<domain>`. |
| `deploymentEnvironment` | string | `dev` | `deployment.environment` resource attribute (`dev` / `uat` / `prod`). |
| `site` | string | `""` | `site` resource attribute. |
| `owner` | string | `""` | `owner` resource attribute. |
| `endpoints` | array | `[]` | Gateway endpoints, one per mesh: `{otlp_grpc, otlp_http, otlp_grpc_url, otlp_http_url, mesh}`. Full URLs are derived from `host:port` when omitted. |
| `defaultMesh` | string | `""` | Mesh whose endpoint is marked as default; falls back to the first. |
| `attributes` | object | `{}` | Extra resource attributes merged into every agent config. |
| `sampling` | object | `{}` | Sampling policy (e.g. `{head_percent: 100}`). |
| `retention` | object | `{}` | Retention in days by signal (e.g. `{logs: 14, metrics: 90, traces: 7}`). |
| `cardinalityBudget` | integer | `100000` | Maximum active metric series for the fleet. |
| `tiers` | array | `[]` | Device tiers with agent defaults. When empty, the standard T0–T4 set ships. |
| `installBaseUrl` | string | derived | Release-asset base URL; empty derives `https://settings.<domain>/settings/install`. |
| `outputDir` | string | `~/.local/share/otel-settings` | Root directory for rendered documents; the `current` pointer lives inside. |
| `authMethod` | string | `bearer` | How agents authenticate to the gateway (`bearer` / `mtls` / `none`). |

## Examples

Create a model and render the document set:

```sh
# domain is required; deploymentEnvironment labels the contract (dev here).
swamp model create @svendowideit/otel-settings otel \
  --global-arg domain=otel.fi.gy \
  --global-arg deploymentEnvironment=dev
swamp model method run otel render
```

Add gateway endpoints and a retention policy, then re-render:

```sh
# endpoints:json is a list of per-mesh gateways; defaultMesh picks the default.
swamp model edit otel
# ...then set, e.g.:
#   endpoints:json=[{"otlp_grpc":"otlp.fi.gy:4317","otlp_http":"otlp.fi.gy:4318","mesh":"tailscale"}]
#   defaultMesh=tailscale
#   retention:json={"logs":14,"metrics":90,"traces":7}
swamp model method run otel render
```

Validate before rendering, and summarise the state afterwards:

```sh
# validate catches a malformed domain or endpoint without touching the disk.
swamp model method run otel validate

# status reports endpoint/tier counts and whether documents are rendered.
swamp model method run otel status
```

Read the resolved contract from another model or a shell:

```sh
# CEL: reference the contract from any other swamp model.
#   data.latest("otel", "settings").attributes.endpoints[0].otlp_grpc
swamp data get otel settings --json | jq '.attributes.settingsUrl'
```

Render to a specific directory (e.g. one Caddy already serves):

```sh
# Point outputDir at the directory Caddy serves; serveSettings then exposes it.
swamp model method run otel render --input outputDir=/srv/otel-settings
```

## Details

`@svendowideit/otel-settings` ships one model type
(`@svendowideit/otel-settings`). Methods:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `render` | `outputDir` (string, optional), `version` (string, optional) | Resolve the contract, write the full document set to `v/<version>` and flip the `current` pointer. Validates first and throws on errors. |
| `validate` | none | Check the contract for schema and endpoint consistency; writes a `validation` resource with `errors` and `warnings`. |
| `status` | none | Write a `status` resource: domain, endpoint/tier counts, environment, settings URL, and whether documents are rendered. |

Resources: `settings` (the resolved contract), `render` (the written document
manifest), `validation`, and `status`.

### The document set

Every render writes these, each with a stable URL (relative to the served
`current` directory) and content type:

| Path | Content type | Consumer |
| ---- | ------------ | -------- |
| `index.html` | `text/html` | Landing page served at `GET /`; explains the server and links every document. |
| `otel.json` | `application/json` | Agents/apps read endpoints, attributes, sampling, retention. |
| `otel.env` | `text/plain` | `OTEL_EXPORTER_OTLP_*` environment block for shells/systemd. |
| `otel.md` | `text/markdown` | Human-readable summary (endpoint + tier tables). |
| `agent-config/{tier}.yaml` | `application/yaml` | Per-tier collector config fragment. |
| `install/{os}-{arch}.json` | `application/json` | Verified install/upgrade asset URLs. |
| `version.json` | `application/json` | Content hash + list of documents. |
| `v/<hash>/*` | as above | Immutable per-version copy. |

### Versioning and caching

Each render computes a **stable content hash** over the contract (excluding the
render timestamp), writes the immutable `v/<hash>/` tree, and repoints `current`.
Because the hash is content-derived, an unchanged contract produces the same
version and cache keys — safe to re-run on a schedule. The `current` pointer is a
symlink when the filesystem supports it, otherwise a copied tree.

### The standard tiers

When `tiers` is empty the model ships the five standard tiers (T0 containers,
T1 servers/VMs, T2 small SBCs, T3 scrape-only appliances, T4 immutable nodes),
each with an `agent` variant, optional `memoryLimitMiB`, enabled `receivers`, and
whether it `push`es. Pass your own `tiers` array to override. See
`DEFAULT_TIERS` in `otel_settings.ts`.

### Extending and testing

- All rendering and validation logic is in pure, exported functions
  (`buildSettings`, `renderOtelJson`, `renderOtelEnv`, `renderAgentConfig`,
  `renderInstallManifest`, `buildDocuments`, `validateSettings`, …), unit-tested
  in `otel_settings_test.ts`. Add a new document kind by extending
  `buildDocuments` and adding a render function.
- `render` is the only method that touches the filesystem; keep it that way so
  the rest stays pure and easy to test.
- Run the tests with the bundled deno:
  `~/.swamp/deno/deno test --allow-env --allow-read --allow-write extensions/models/otel-settings/otel_settings_test.ts`.

### Secrets

Served documents never contain secrets — they carry endpoint names, attributes,
and URLs only. Gateway bearer tokens and other credentials live in swamp vaults
and are delivered to agents separately (or via a short-lived token endpoint),
never in the settings bundle.

## License

MIT — see LICENSE.txt.
