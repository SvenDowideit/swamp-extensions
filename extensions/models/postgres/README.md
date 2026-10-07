# @svendowideit/postgres

Provision and configure a PostgreSQL server from swamp, and hand other models
a connection to it — without ever writing a password into a resource.

## What it does

Brings up PostgreSQL as a long-lived, health-gated service and creates the
application role and database, then writes a **non-secret** `connection`
resource that other models consume with CEL.

- **Secrets stay in the vault.** The database password is generated once,
  stored in a swamp vault, and reused on later runs. Role creation is fed to
  `psql` over **stdin** inside the container, so the password never appears in a
  resource, a log, or a process listing.
- **Idempotent.** `provision`/`configure` leave an already-correct server
  alone (the desired-state hash lives in the container-service layer).
- **Detached and restart-managed.** The server is run through
  [`@svendowideit/container-service`](../container-service/README.md): direct
  restart policy or a systemd unit, with a `pg_isready` health gate before the
  model reports success.
- **Container-first.** The current release runs the official `postgres` image.
  The native lane (package-manager install + `initdb` + `pg_hba` scram) is
  declared but **deferred** to a future `linux-package-installer` extension;
  `mode=native` fails with that guidance rather than doing half a job.

## Install

```sh
swamp extension pull @svendowideit/postgres
```

## Configuration

Global arguments (set at model creation with `--global-arg key=value`):

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `auto` \| `container` \| `native` | `auto` | Run lane; `native` deferred. |
| `version` | string | `18-alpine` | Postgres image tag. |
| `image` | string | `""` | Full image ref; overrides `version`. |
| `port` | integer | `5432` | Host port to publish. |
| `bindAddress` | string | `127.0.0.1` | Host address to publish on. |
| `database` | string | `app` | Application database. |
| `username` | string | `app` | Application role (owns the database). |
| `adminUser` | string | `postgres` | Image superuser (`POSTGRES_USER`). |
| `postgresDatabase` | string | `postgres` | Image default database (`POSTGRES_DB`). |
| `dataDir` | string | `~/.local/share/swamp-postgres` | Host data directory (the volume). |
| `network` | string | `swamp-postgres` | Container network peers join by name. |
| `containerName` | string | derived | Container name. |
| `vaultName` | string | `""` | Vault holding the password (**required**). |
| `passwordSecretKey` | string | `POSTGRES_PASSWORD` | Vault key for the password. |
| `serviceBackend` | `direct` \| `systemd` | `direct` | How the container is kept running. |
| `healthTimeoutMs` | integer | `60000` | Readiness wait budget. |

Methods: `provision`, `configure`, `status`, `backup`, `remove`.
`provision`/`configure` accept `database`, `username`, `forcePasswordReset`;
`remove` accepts `removeData`.

## Examples

Create the model and provision the server. The password is generated and stored
in the vault the first time, then reused:

```sh
swamp vault create @svendowideit/systemd-creds postgres-secrets
swamp model create @svendowideit/postgres postgres \
  --global-arg vaultName=postgres-secrets \
  --global-arg database=dtrack --global-arg username=dtrack
swamp model method run postgres provision
```

Confirm it is accepting connections before pointing a consumer at it:

```sh
swamp model method run postgres status
swamp data query 'modelName == "postgres" && name == "current"' --select content
```

Take a logical backup (the dump is written as a swamp file resource):

```sh
swamp model method run postgres backup
```

Tear it down. `removeData=true` is destructive and also deletes the host data
directory:

```sh
swamp model method run postgres remove --input removeData=true
```

## Details

- **Model type:** `@svendowideit/postgres` (`postgres.ts`).
- **Composition:** drives `@svendowideit/container-service` through
  `context.runModel` (declared under `dependencies:`), using its `network`,
  `service`, `exec`, and `serviceStatus` methods. No shell wrapping.
- **Resources:** `connection` (`current`) — `host`/`port` are the container-side
  coordinates (`<containerName>`:`5432`) peers use on the shared network, plus
  `hostPort` (the published host port), database, username, network,
  containerName, sslmode, jdbcUrl, and **no password**; `status` (`current`);
  `provision` (`last`); `backup` (`last`, plus a file); `remove` (`last`).
- **Password:** generated with `crypto.getRandomValues`, base64-URL encoded,
  written via `swamp vault put` (value on stdin). `readModelData` is used to
  read the service model's typed resources back.
- **Postgres 18 mount:** `dataMountFor()` mounts `/var/lib/postgresql` for 18+
  (the image relocated its data directory into a version-named subdirectory)
  and `/var/lib/postgresql/data` for earlier majors.
- **SQL:** `buildBootstrapSql()` quotes identifiers and literals and uses
  `\gexec` for the conditional `CREATE DATABASE`, so re-running is safe.
- **Deferred:** the native lane; see [What it does](#what-it-does).

### Development

```sh
~/.swamp/deno/deno check extensions/models/postgres/postgres.ts
~/.swamp/deno/deno test  --allow-all extensions/models/postgres/postgres_test.ts
swamp extension fmt extensions/models/postgres/manifest.yaml --check
```
