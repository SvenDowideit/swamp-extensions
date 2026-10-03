# @figy/homelab-otel

Site-specific OpenTelemetry bootstrap for the **fi.gy homelab** — my domains,
meshes, and tiers wired into one swamp workflow. It is the concrete, private half
of an OTel fleet setup; the portable model types live in `@svendowideit`.

## What it does

Supplies my observability contract to the generic `@svendowideit` models and runs
the whole publish path:

1. **render** the contract under the dedicated `otel.fi.gy` sub-zone (tailscale
   `otlp.fi.gy` + wireguard `otlp.wg.otel.fi.gy` endpoints, home/sven attributes,
   14/90/7-day retention) via `@svendowideit/otel-settings`,
2. **publish** it as a versioned webroot via `@svendowideit/settings-server`,
3. **serve** it over HTTP(S) at `settings.otel.fi.gy` via `@svendowideit/caddy`
   (DNS-01 TLS with the Gandi driver), and
4. **verify** the live document.

This is site-specific by design: it encodes my domains, meshes, and gear, so it
is useless without them. That is the point — a stranger can use
`@svendowideit/otel-settings`, but only this extension knows the fi.gy layout.

Side effects: creates/updates swamp models and data, writes a staged webroot and
the rendered documents under `~/.local/share`, and (via Caddy) configures a route
serving that webroot at `settings.otel.fi.gy`. No cron triggers or webhooks.

## Install

```sh
swamp extension pull @figy/homelab-otel
```

Requires a `figy`-trusted repo (`swamp extension trust add figy`) and the
`@svendowideit/otel-settings`, `@svendowideit/settings-server`, and
`@svendowideit/caddy` extensions.

## Configuration

The workflow takes optional `--input` overrides so the same definition runs in
each environment. The site values themselves are fixed in the workflow's step
`globalArgs`.

| Input | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `deploymentEnvironment` | string | `dev` | `deployment.environment` — `dev` (this machine), `uat` (T440s), `prod` (Xeon). |
| `settingsHostname` | string | `settings.otel.fi.gy` | Hostname the settings documents are served on. |
| `webroot` | string | `~/.local/share/settings-server` | Directory Caddy serves the staged bundle from. |

## Examples

Run the full bootstrap (dev):

```sh
# Renders the fi.gy contract, stages it, serves it, and verifies the URL.
swamp workflow run @figy/homelab-otel-bootstrap
```

Promote the same definition to UAT (the T440s) and then prod (the Xeon):

```sh
# The only change between environments is the environment label.
swamp workflow run @figy/homelab-otel-bootstrap \
  --input deploymentEnvironment=uat
swamp workflow run @figy/homelab-otel-bootstrap \
  --input deploymentEnvironment=prod
```

Read the resolved contract from another model or a shell:

```sh
# CEL: data.latest("otel", "resolved").attributes.endpoints[0].otlp_grpc
swamp data get otel resolved --json | jq '.content.settingsUrl'
```

Fetch the served machine contract:

```sh
# The same document every agent consumes at runtime.
curl https://settings.otel.fi.gy/otel.json
curl https://settings.otel.fi.gy/otel.env
```

## Details

`@figy/homelab-otel` ships one model type (`@figy/homelab-otel`) and one workflow
(`homelab-otel-bootstrap`).

Model method:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `describe` | none | Emit the fi.gy topology (zone, DNS records, per-mesh endpoints, hosts) as a `topology` resource for other models and workflows to reference via CEL. |

Resource: `topology` (the site catalog).

### Workflow steps

| Step | Model type | Method | What it does |
| ---- | ---------- | ------ | ------------ |
| `render-settings` | `@svendowideit/otel-settings` (`otel`) | `render` | Resolve the fi.gy contract and write the HTTP document set. |
| `publish-bundle` | `@svendowideit/settings-server` (`settings`) | `publish` | Stage the documents into the webroot and flip `current`. |
| `serve-settings` | `@svendowideit/caddy` (`otel-caddy`) | `serveSettings` | Serve the webroot at `settings.otel.fi.gy` via `file_server`. |
| `verify-settings` | `@svendowideit/settings-server` (`settings`) | `verify` | Fetch the live index document (allowed to fail so a DNS/TLS delay does not block the run). |

### The fi.gy layout

| Name | Purpose |
| ---- | ------- |
| `otel.fi.gy` | Zone apex → core node. |
| `otlp.fi.gy` / `otlp.wg.otel.fi.gy` | Gateway OTLP endpoints (tailscale / wireguard). |
| `obs.otel.fi.gy` | OpenObserve UI/API (`obs.fi.gy` stays free for video streaming). |
| `settings.otel.fi.gy` | This settings server. |
| `<host>.otel.fi.gy` | Per-managed-host records. |

A single wildcard `*.otel.fi.gy` certificate (Caddy DNS-01 via Gandi) covers the
zone. `home.org.au` remains the DHCP/search suffix for now and is not automated.

### Extending and testing

- The site values live in the step `globalArgs` of
  `homelab-otel-bootstrap.yaml`. Edit them there, then re-run — the workflow
  auto-creates/updates the `otel`, `settings`, and `otel-caddy` models.
- Add a second region or mesh by adding an `endpoints` entry and, if needed, an
  internal DNS model; the generic renderer already supports multiple endpoints.
- Validate before running: `swamp workflow validate homelab-otel-bootstrap`.

### Secrets

Gandi (and any other provider) credentials are stored in swamp vaults and
referenced via Caddy's environment; they are never written into the served
documents. See the plan's §7.5.

## License

MIT — see LICENSE.txt.
