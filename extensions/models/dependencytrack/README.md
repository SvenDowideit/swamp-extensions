# @svendowideit/dependencytrack

Deploy and configure OWASP Dependency-Track v5 end to end — PostgreSQL, the API
server and frontend, and an agent API key — and hand a later model the key it
uploads SBOMs with, without a human ever copying it.

## What it does

The `@svendowideit/dependencytrack` **model** runs Dependency-Track v5's two
images — the stateless **API server** and the **frontend** SPA (v5 supports
PostgreSQL only) — as long-lived, restart-managed services against a database you
supply, then does the setup that makes the platform usable:

- Dependency-Track forces an **admin password change on first login**.
- Creating a team does **not** create an API key.
- A newly created key is shown **exactly once**.

`bootstrapAgentKey` performs that whole sequence **idempotently** and stores the
key in a swamp vault, so the SBOM uploader reads it with `vault.get(...)` and
nothing sensitive is ever written into a resource or a log.

The extension also ships three ready-to-run **workflows** that stand the stack up
end to end:

1. **PostgreSQL** — `@svendowideit/postgres-provision` provisions the database
   (container-first, vault-held password, idempotent).
2. **Dependency-Track** — `install` deploys the API server and frontend against
   that database.
3. **Agent API key** — `bootstrapAgentKey` rotates the forced first-login admin
   password, creates the `automation` team, grants it `BOM_UPLOAD`, and mints an
   API key stored in a swamp vault.
4. **Caddy (optional)** — when you name a Caddy model, two reverse-proxy routes:
   `dependencytrack.<domain>` → frontend and
   `backend.dependencytrack.<domain>` → API server, over TLS.
5. **Verification** — assertions that the API is ready and the frontend is
   running.

Prefer it over the project's docker-compose file: the database connection and
password come from the Postgres model's data and vault (it composes with the
rest of your swamp repo), the deployment is idempotent, readiness is reported by
polling the API rather than guessing, and every workflow re-run is the update
path.

## Install

```sh
swamp extension pull @svendowideit/dependencytrack
```

## Configuration

Global arguments (set at model creation with `--global-arg key=value`):

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `apiserverImage` | string | `ghcr.io/dependencytrack/apiserver:5.1.2` | API server image. |
| `frontendImage` | string | `ghcr.io/dependencytrack/frontend:5.1.2` | Frontend image. |
| `apiPort` | integer | `8080` | Host port for the API server. |
| `uiPort` | integer | `8081` | Host port for the frontend. |
| `bindAddress` | string | `127.0.0.1` | Bind address. |
| `publicBackendUrl` | string | `""` | `API_BASE_URL` for the frontend (default `http://<bind>:<apiPort>`). |
| `publicFrontendUrl` | string | `""` | CORS allow-origin (default `http://<bind>:<uiPort>`). |
| `network` | string | `swamp-postgres` | Container network; must match the database's. |
| `containerPrefix` | string | derived | Prefix for container names. |
| `vaultName` | string | `""` | Vault for admin password + agent key (**required**). |
| `adminUser` | string | `admin` | Admin username. |
| `adminSecretKey` | string | `DEPENDENCYTRACK_ADMIN_PASSWORD` | Vault key for the admin password. |
| `apiKeySecretKey` | string | `DEPENDENCYTRACK_API_KEY` | Vault key for the agent key. |
| `agentTeamName` | string | `automation` | Team that owns the key. |
| `serviceBackend` | `direct` \| `systemd` | `direct` | Passed to container-service. |
| `healthTimeoutMs` | integer | `180000` | Readiness wait budget. |

Model methods: `install`, `configure`, `bootstrapAgentKey`, `status`, `remove`.
`install`/`configure` take `dbHost`, `dbPort`, `dbDatabase`, `dbUsername`,
`dbPassword` (sensitive), `adminPassword` (sensitive), `force`.
`bootstrapAgentKey` takes `adminPassword` (sensitive) and `force`.

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

Deploy the model directly, wiring the database in from the companion Postgres
model via CEL:

```sh
swamp model create @svendowideit/dependencytrack dependencytrack \
  --global-arg vaultName=dependencytrack-secrets \
  --global-arg network=swamp-postgres
swamp model method run dependencytrack install \
  --input dbHost=${{ data.latest("postgres","current").attributes.host }} \
  --input dbDatabase=${{ data.latest("postgres","current").attributes.database }} \
  --input dbUsername=${{ data.latest("postgres","current").attributes.username }} \
  --input dbPassword=${{ vault.get("postgres-secrets","POSTGRES_PASSWORD") }}
```

Deploy the whole stack in one command (no TLS), writing the database password
and agent key into their vaults:

```sh
swamp vault create @svendowideit/systemd-creds postgres-secrets
swamp vault create @svendowideit/systemd-creds dependencytrack-secrets
swamp workflow run @svendowideit/dependencytrack-deploy \
  --input dbVaultName=postgres-secrets \
  --input vaultName=dependencytrack-secrets
```

Provision the agent API key on its own. This rotates the forced first-login admin
password and stores the key in the vault; re-running reuses a key that still
authenticates:

```sh
swamp model method run dependencytrack bootstrapAgentKey
```

Check both services are up and read the connection facts and SBOM upload
endpoint a later model should use (the key itself is in the vault, not in data):

```sh
swamp model method run dependencytrack status
swamp data query 'modelName == "dependencytrack" && name == "current"' --select content
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

- **Model type:** `@svendowideit/dependencytrack` (`dependencytrack.ts`).
- **Workflows:** `@svendowideit/dependencytrack-deploy` (the full stack:
  postgres → install → bootstrap → Caddy → asserts),
  `@svendowideit/dependencytrack-postgres` (thin database-only wrapper),
  `@svendowideit/postgres-provision` (reusable DB provisioning).
- **Composition:** model methods wired with CEL. The database's non-secret
  `connection` resource feeds the DT `install` inputs; its password comes from
  the vault via `vault.get(...)`. The model drives
  `@svendowideit/container-service` through `context.runModel` (declared under
  `dependencies:`), using its `network`, `service`, `serviceStatus`, and `exec`
  methods.
- **Resources:** `install` (`current`), `agentKey` (`current` — team, teamUuid,
  publicId, apiUrl, bomEndpoint, adminRotated, reused; **no key value**),
  `status` (`current`), `remove` (`last`).
- **Env wiring:** the API server is given `DT_DATASOURCE_URL` (JDBC),
  `DT_DATASOURCE_USERNAME`, `DT_DATASOURCE_PASSWORD`, and CORS settings; the
  frontend is given `API_BASE_URL`. The datasource password comes from the
  `dbPassword` method input, which callers supply via a vault expression, and is
  annotated `z.meta({ sensitive: true })` so it is never persisted.
- **Local vs public URLs:** readiness polling, login, team/key management, and
  `status` all talk to the **local** bind address
  (`http://<bindAddress>:<apiPort>`). `publicBackendUrl` is used only as the
  frontend's `API_BASE_URL` and as the reported SBOM endpoint. This matters
  because the public URL normally only resolves after a reverse proxy is
  created — often by a later workflow step — so control-plane calls must not
  depend on it.
- **Idempotency:** each model method is desired-state; Caddy steps carry a
  `guard` so they are skipped when no `caddyModel` is given. An existing vault
  key that still authenticates against `GET /api/v1/project` is reused unless
  `force=true`.
- **Vaults:** `postgres-secrets` (DB password) and `dependencytrack-secrets`
  (DT admin password + `DEPENDENCYTRACK_API_KEY`). No secret is ever written to
  a resource.
- **Bootstrap flow:** `loginWithRotation` handles the `FORCE_PASSWORD_CHANGE`
  401 by calling `forceChangePassword` then logging in again; `ensureTeam`
  creates the agent team if absent; `createApiKey` mints the key; the key is
  written to the vault with `swamp vault put` (value on stdin).
- **Dependencies:** `@svendowideit/container-service` (declared; pulled
  automatically), `@svendowideit/postgres` (used by the workflows), and
  optionally `@svendowideit/caddy`.

### Development

```sh
~/.swamp/deno/deno check extensions/models/dependencytrack/dependencytrack.ts
~/.swamp/deno/deno test  --allow-all extensions/models/dependencytrack/dependencytrack_test.ts
swamp workflow validate @svendowideit/dependencytrack-deploy
swamp workflow validate @svendowideit/dependencytrack-postgres
swamp workflow validate @svendowideit/postgres-provision
swamp extension fmt extensions/models/dependencytrack/manifest.yaml --check
```
