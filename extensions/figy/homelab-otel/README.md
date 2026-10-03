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
`@svendowideit/otel-settings`, `@svendowideit/settings-server`,
`@svendowideit/caddy`, `@svendowideit/otel-backend`, `@svendowideit/otel-gateway`,
and `@svendowideit/openobserve` extensions.

`bootstrap-otel-backend` additionally needs Docker and the store's admin login in
a vault **before** it runs — the OpenObserve container seeds its first admin user
at first start, so both keys must exist or the container crash-loops:

```sh
swamp vault create @svendowideit/systemd-creds otel-openobserve-admin
swamp vault put otel-openobserve-admin ZO_ROOT_USER_EMAIL
swamp vault put otel-openobserve-admin ZO_ROOT_USER_PASSWORD
```

## Configuration

The workflow takes optional `--input` overrides so the same definition runs in
each environment. The site values themselves are fixed in the workflow's step
`globalArgs`.

| Input | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `deploymentEnvironment` | string | `dev` | `deployment.environment` — `dev` (this machine), `uat` (T440s), `prod` (Xeon). |
| `settingsHostname` | string | `settings.otel.fi.gy` | Hostname the settings documents are served on. |
| `webroot` | string | `~/.local/share/settings-server` | Directory Caddy serves the staged bundle from. |
| `bindAddress` | string | `127.0.0.1` | Address the store and gateway bind to. |
| `backendPort` | integer | `5080` | Host port for the store UI/API and OTLP/HTTP. |
| `vaultName` | string | `otel-openobserve-admin` | Vault holding the admin login. |
| `verifyMarker` | string | `phase1-bootstrap-verify` | Marker in the synthetic OTLP record. |

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

Bring up the whole Phase 1 core node — the store, the gateway, the DNS records,
and a synthetic round-trip to prove it — in one command. Run this when bringing
up a new core node (dev, then UAT, then prod):

```sh
swamp workflow run @figy/bootstrap-otel-backend
# The same definition on another host, with the environment label changed.
swamp workflow run @figy/bootstrap-otel-backend \
  --input deploymentEnvironment=uat --input bindAddress=0.0.0.0
```

Confirm the synthetic record landed by querying the store back with SQL:

```sh
swamp data get obs last --json | jq '.content.rows'
```

## Details

`@figy/homelab-otel` ships one model type (`@figy/homelab-otel`) and two
workflows (`homelab-otel-bootstrap`, `bootstrap-otel-backend`).

Model method:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `describe` | none | Emit the fi.gy topology (zone, DNS records, per-mesh endpoints, hosts) as a `topology` resource for other models and workflows to reference via CEL. |

Resource: `topology` (the site catalog).

### Workflow steps

`homelab-otel-bootstrap` (settings only):

| Step | Model type | Method | What it does |
| ---- | ---------- | ------ | ------------ |
| `render-settings` | `@svendowideit/otel-settings` (`otel`) | `render` | Resolve the fi.gy contract and write the HTTP document set. |
| `publish-bundle` | `@svendowideit/settings-server` (`settings`) | `publish` | Stage the documents into the webroot and flip `current`. |
| `serve-settings` | `@svendowideit/caddy` (`otel-caddy`) | `serveSettings` | Serve the webroot at `settings.otel.fi.gy` via `file_server`. |
| `verify-settings` | `@svendowideit/settings-server` (`settings`) | `verify` | Fetch the live index document (allowed to fail so a DNS/TLS delay does not block the run). |

`bootstrap-otel-backend` (the Phase 1 core node):

| Step | Model type | Method | What it does |
| ---- | ---------- | ------ | ------------ |
| `topology` | `@figy/homelab-otel` (`homelab-otel`) | `describe` | Emit the fi.gy topology used by later steps. |
| `render-settings` | `@svendowideit/otel-settings` (`otel`) | `render` | Resolve the contract the fleet will fetch. |
| `backend` | `@svendowideit/otel-backend` (`otel-backend`) | `install` | Start OpenObserve with the vault admin login. |
| `gateway` | `@svendowideit/otel-gateway` (`otel-gateway`) | `install` | Start the collector, exporting to the backend with vault Basic auth. |
| `dns-records` | `@svendowideit/caddy` (`otel-caddy`) | `applyDnsRecords` | Reconcile the `otel`/`otlp`/`settings`/`obs.otel` records (allowed to fail). |
| `verify-push` | `@svendowideit/otel-gateway` (`otel-gateway`) | `verify` | Push a synthetic OTLP record through the gateway. |
| `verify-query` | `@svendowideit/openobserve` (`obs`) | `query` | Query the record back from OpenObserve with SQL. |

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

- The site values live in the step `globalArgs` of the workflow YAMLs. Edit them
  there, then re-run — the workflows auto-create/update the `otel`, `settings`,
  `otel-caddy`, `otel-backend`, `otel-gateway`, and `obs` models.
- Add a second region or mesh by adding an `endpoints` entry and, if needed, an
  internal DNS model; the generic renderer already supports multiple endpoints.
- Validate before running: `swamp workflow validate homelab-otel-bootstrap` and
  `swamp workflow validate @figy/bootstrap-otel-backend`.

### Secrets

Gandi (and any other provider) credentials are stored in swamp vaults and
referenced via Caddy's environment; they are never written into the served
documents. See the plan's §7.5.

## License

MIT — see LICENSE.txt.
