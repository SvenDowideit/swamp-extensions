# @svendowideit/dependencytrack-deploy

Deploy OWASP Dependency-Track v5 and its PostgreSQL database from swamp — and
auto-provision an agent API key a later model uploads SBOMs with.

## What it does

A ready-to-run workflow set that stands up Dependency-Track end to end:

1. **PostgreSQL** — provisioned by `@svendowideit/postgres` (container-first,
   vault-held password, idempotent).
2. **Dependency-Track** — the API server and frontend deployed by
   `@svendowideit/dependencytrack` against that database.
3. **Agent API key** — `bootstrapAgentKey` rotates the forced first-login admin
   password, creates the `automation` team, grants it `BOM_UPLOAD`, and mints an
   API key stored in a swamp vault.
4. **Caddy (optional)** — when you name a Caddy model, two reverse-proxy routes:
   `dependencytrack.<domain>` → frontend and
   `backend.dependencytrack.<domain>` → API server, over TLS.
5. **Verification** — assertions that the API is ready and the frontend is
   running.

Every step is idempotent, so re-running is the update path. The database
password and the agent key never leave the vault.

## Install

```sh
swamp extension pull @svendowideit/dependencytrack-deploy
```

## Configuration

`@svendowideit/dependencytrack-deploy` inputs:

| Input | Default | Meaning |
| --- | --- | --- |
| `postgresModel` | `postgres` | `@svendowideit/postgres` model instance. |
| `dbVaultName` | — | Vault holding the DB password (**required**). |
| `dbPasswordKey` | `POSTGRES_PASSWORD` | DB password vault key. |
| `dtModel` | `dependencytrack` | `@svendowideit/dependencytrack` instance. |
| `vaultName` | — | Vault for the DT admin password + agent key (**required**). |
| `network` | `swamp-postgres` | Shared container network. |
| `apiPort` / `uiPort` | `8080` / `8081` | Host ports. |
| `publicBackendUrl` | `""` | Frontend `API_BASE_URL` (empty = localhost). |
| `publicFrontendUrl` | `""` | CORS allow-origin (empty = localhost). |
| `caddyModel` | `""` | Caddy model to proxy through (empty = skip). |
| `caddyBaseDomain` | `""` | Domain for the proxy hostnames. |

`@svendowideit/dependencytrack-postgres` and `@svendowideit/postgres-provision` take `modelName`, `vaultName`,
`database`, `username`, `network`, `dataDir`.

## Examples

Deploy the whole stack (no TLS), writing the database password and agent key
into their vaults:

```sh
swamp vault create @svendowideit/systemd-creds postgres-secrets
swamp vault create @svendowideit/systemd-creds dependencytrack-secrets
swamp workflow run @svendowideit/dependencytrack-deploy \
  --input dbVaultName=postgres-secrets \
  --input vaultName=dependencytrack-secrets
```

Read the connection facts and the SBOM upload endpoint a later model should use
(the key itself is in the vault, not in data):

```sh
swamp data query 'modelName == "postgres" && name == "connection"' --select content
swamp data query 'modelName == "dependencytrack" && specName == "agentKey"' --select content
```

Add TLS proxying through your Caddy — `caddyBaseDomain` is your caddy model's
`baseDomain`, and the public URLs make the frontend talk to the backend over
TLS. The proxy steps rely on `@svendowideit/caddy` deriving a TLS subject and an
A record from each route (run `configureTls` once on the caddy model so it has a
DNS provider + ACME email); the workflow then applies the records:

```sh
swamp workflow run @svendowideit/dependencytrack-deploy \
  --input dbVaultName=postgres-secrets \
  --input vaultName=dependencytrack-secrets \
  --input caddyModel=my-caddy --input caddyBaseDomain=example.com \
  --input publicBackendUrl=https://backend.dependencytrack.example.com \
  --input publicFrontendUrl=https://dependencytrack.example.com
```

Provision just the database when that is all you need:

```sh
swamp workflow run @svendowideit/dependencytrack-postgres --input vaultName=postgres-secrets
```

The SBOM-upload contract for a consuming model:

```
POST <apiUrl>/api/v1/bom
X-Api-Key: ${{ vault.get("dependencytrack-secrets", "DEPENDENCYTRACK_API_KEY") }}
```

## Details

- **Workflows:** `@svendowideit/postgres-provision` (reusable DB provisioning),
  `@svendowideit/dependencytrack-postgres` (thin wrapper),
  `@svendowideit/dependencytrack-deploy` (the full stack).
- **Composition:** model methods wired with CEL. The database's non-secret
  `connection` resource feeds the DT `install` inputs; its password comes from
  the vault via `vault.get(...)`.
- **Idempotency:** each model method is desired-state; Caddy steps carry a
  `guard` so they are skipped when no `caddyModel` is given.
- **Vaults:** `postgres-secrets` (DB password) and `dependencytrack-secrets`
  (DT admin password + `DEPENDENCYTRACK_API_KEY`). No secret is ever written to
  a resource.
- **Dependencies:** `@svendowideit/postgres`, `@svendowideit/dependencytrack`
  (which pulls `@svendowideit/container-service`), and optionally
  `@svendowideit/caddy`.

### Development

```sh
swamp workflow validate @svendowideit/dependencytrack-deploy
swamp workflow validate @svendowideit/dependencytrack-postgres
swamp workflow validate @svendowideit/postgres-provision
swamp extension fmt extensions/workflows/dependencytrack/manifest.yaml --check
```
