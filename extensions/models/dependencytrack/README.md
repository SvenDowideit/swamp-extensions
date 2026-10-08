# @svendowideit/dependencytrack

Deploy and configure OWASP Dependency-Track v5 — and hand a later model an agent
API key it can upload SBOMs with, without a human ever copying it.

## What it does

Runs Dependency-Track v5's two images — the stateless **API server** and the
**frontend** SPA (v5 supports PostgreSQL only) — as long-lived, restart-managed
services against a database you supply, then does the setup that makes the
platform usable:

- Dependency-Track forces an **admin password change on first login**.
- Creating a team does **not** create an API key.
- A newly created key is shown **exactly once**.

`bootstrapAgentKey` performs that whole sequence **idempotently** and stores the
key in a swamp vault, so the SBOM uploader reads it with `vault.get(...)` and
nothing sensitive is ever written into a resource or a log.

Prefer it over the project's docker-compose file: the database connection and
password come from the Postgres model's data and vault (it composes with the
rest of your swamp repo), the deployment is idempotent, and readiness is
reported by polling the API rather than guessing.

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

Methods: `install`, `configure`, `bootstrapAgentKey`, `status`, `remove`.
`install`/`configure` take `dbHost`, `dbPort`, `dbDatabase`, `dbUsername`,
`dbPassword` (sensitive), `adminPassword` (sensitive), `force`.
`bootstrapAgentKey` takes `adminPassword` (sensitive) and `force`.

## Examples

Deploy, wiring the database in from the companion Postgres model via CEL:

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

Provision the agent API key. This rotates the forced first-login admin password
and stores the key in the vault; re-running reuses a key that still
authenticates:

```sh
swamp model method run dependencytrack bootstrapAgentKey
```

Check both services are up and read the endpoint a later SBOM model should use:

```sh
swamp model method run dependencytrack status
swamp data query 'modelName == "dependencytrack" && name == "current"' --select content
```

The SBOM-upload contract is `POST <apiUrl>/api/v1/bom` with the header
`X-Api-Key: ${{ vault.get("dependencytrack-secrets","DEPENDENCYTRACK_API_KEY") }}`.

## Details

- **Model type:** `@svendowideit/dependencytrack` (`dependencytrack.ts`).
- **Composition:** drives `@svendowideit/container-service` through
  `context.runModel` (declared under `dependencies:`), using its `network`,
  `service`, `serviceStatus`, and `exec` methods.
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
- **Bootstrap flow:** `loginWithRotation` handles the `FORCE_PASSWORD_CHANGE`
  401 by calling `forceChangePassword` then logging in again; `ensureTeam`
  creates the agent team if absent; `createApiKey` mints the key; the key is
  written to the vault with `swamp vault put` (value on stdin).
- **Idempotency:** an existing vault key that still authenticates against
  `GET /api/v1/project` is reused unless `force=true`.

### Development

```sh
~/.swamp/deno/deno check extensions/models/dependencytrack/dependencytrack.ts
~/.swamp/deno/deno test  --allow-all extensions/models/dependencytrack/dependencytrack_test.ts
swamp extension fmt extensions/models/dependencytrack/manifest.yaml --check
```
