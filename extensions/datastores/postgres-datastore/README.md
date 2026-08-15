# PostgreSQL Datastore

Stores swamp model data in PostgreSQL as typed, versioned tables. Swamp model
schemas (Zod) map directly to PostgreSQL table schemas (DDL) with native column
types. Every data mutation is automatically versioned using SQL:2011 SYSTEM
VERSIONING via the `periods` extension.

## Architecture

The extension has two components that work together:

| Component | Package | Role |
|---|---|---|
| **Datastore** | `@svendowideit/postgres-datastore` | Distributed locking, health checks, namespace registry |
| **Model type** | `@svendowideit/postgres-model` | Creates versioned tables, runs CRUD, queries history, migrates schemas, imports external tables |

```
┌──────────────────────────────────────────────────────────┐
│                      swamp CLI                           │
│  swamp model method run <model> create                   │
│  swamp model method run <model> run                      │
│  swamp model method run <model> query                    │
│  swamp model method run <model> upgrade                  │
└──────────────┬───────────────────────────┬───────────────┘
               │                           │
               ▼                           ▼
┌──────────────────────────┐  ┌────────────────────────────┐
│  @svendowideit/          │  │  @svendowideit/             │
│  postgres-datastore      │  │  postgres-model             │
│                          │  │                             │
│  • Distributed locking   │  │  • Table creation (DDL)     │
│  • Health checks         │  │  • CRUD operations          │
│  • Namespace registry    │  │  • Schema migration         │
│  • Connection pooling    │  │  • Version queries          │
│                          │  │  • Import existing tables   │
└──────────┬───────────────┘  └────────────┬────────────────┘
           │                               │
           └───────────────┬───────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    PostgreSQL 15+                         │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  _locks     │  │  _versions   │  │  _namespace     │  │
│  │  (advisory) │  │  (metadata)  │  │  (repo reg)    │  │
│  └─────────────┘  └──────────────┘  └─────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  servers              servers_history             │    │
│  │  (current rows)       (all historical rows)       │    │
│  │  + row_start           + periods extension         │    │
│  │  + row_end                                         │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  users                users_history               │    │
│  │  (current rows)       (all historical rows)       │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

Each swamp model gets its own PostgreSQL table with columns that match the
model's Zod schema types. The `periods` extension automatically maintains a
companion `_history` table with every previous version of every row.

## Prerequisites

- **PostgreSQL 15+** — required for `gen_random_uuid()`
- **`periods` extension** — installed in the target database. The datastore
  auto-installs it on first use if the PostgreSQL user has `CREATE EXTENSION`
  privileges.

>> Note: `apt install postgresql-18-periods` pretty much should do the trick, as postgresql-18 is a pre-req.

```sql
-- Manual install if auto-install is not available:
CREATE EXTENSION IF NOT EXISTS periods;
```

### Docker Compose (local development)

```yaml
services:
  postgres:
    image: pgxn/pgxn-tools:latest  # includes periods extension
    environment:
      POSTGRES_USER: swamp
      POSTGRES_PASSWORD: swamp
      POSTGRES_DB: swamp
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    command: |
      bash -c "
        docker-entrypoint.sh postgres &
        sleep 3
        psql -U swamp -d swamp -c 'CREATE EXTENSION IF NOT EXISTS periods;'
        wait
      "

volumes:
  pgdata:
```

## Configuration

Add the datastore to `.swamp.yaml`:

```yaml
datastore:
  type: "@svendowideit/postgres-datastore"
  config:
    connectionString: "postgres://swamp:swamp@localhost:5432/swamp"
    schema: "swamp"
    ssl: "disable"  # use "require" or "verify-ca" in production
```

Or via environment variable:

```bash
export SWAMP_DATASTORE='@svendowideit/postgres-datastore:{"connectionString":"postgres://user:pass@host:5432/db"}'
```

### Full config reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionString` | string | Yes | — | PostgreSQL connection URI |
| `schema` | string | No | `"swamp"` | PostgreSQL schema for swamp tables |
| `ssl` | enum | No | `"require"` | `"disable"`, `"require"`, or `"verify-ca"` |
| `sslCaPath` | string | No | — | Path to CA certificate bundle (for `verify-ca`) |
| `pool.maxConnections` | int | No | `10` | Connection pool size (1–100) |
| `pool.idleTimeoutMs` | int | No | `30000` | Idle connection timeout in ms |
| `pool.connectTimeoutMs` | int | No | `5000` | Connection timeout in ms (min 1000) |

### SSL modes

| Mode | When to use |
|---|---|
| `disable` | Local development, CI/CD |
| `require` | Staging, internal networks with TLS |
| `verify-ca` | Production, especially with cloud providers (RDS, Cloud SQL) |

For `verify-ca` with AWS RDS:

```bash
curl -o rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

```yaml
ssl: "verify-ca"
sslCaPath: "./rds-ca-bundle.pem"
```

## Quick Start

### 1. Verify the datastore is healthy

```bash
swamp datastore status
# Expected: healthy: true, periods: available
```

### 2. Create a model

```bash
swamp model create servers \
  --type "@svendowideit/postgres-model" \
  --global-args '{
    "connectionString": "postgres://swamp:swamp@localhost:5432/swamp",
    "schema": "swamp"
  }'
```

### 3. Create a versioned table

```bash
swamp model method run servers create \
  --args '{
    "tableName": "servers",
    "schema": {
      "id": "string.uuid",
      "hostname": "string",
      "ip": "string",
      "region": {"type": "string", "optional": true},
      "tags": "json",
      "created_at": "string.datetime"
    }
  }'
```

This creates a `swamp.servers` table with native PostgreSQL column types:

| Field | PostgreSQL type | Constraint |
|---|---|---|
| `id` | `UUID` | `PRIMARY KEY` |
| `hostname` | `TEXT` | `NOT NULL` |
| `ip` | `TEXT` | `NOT NULL` |
| `region` | `TEXT` | nullable |
| `tags` | `JSONB` | `NOT NULL` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL` |

Plus auto-created indexes on `created_at` (datetime field). The `periods`
extension adds `row_start` and `row_end` system columns and creates a
`servers_history` table for automatic row versioning.

### 4. Insert data

```bash
swamp model method run servers run \
  --args '{
    "tableName": "servers",
    "operation": "insert",
    "data": [
      {"id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "hostname": "web-01", "ip": "10.0.1.10", "region": "us-east-1", "tags": ["production", "frontend"], "created_at": "2026-01-15T10:00:00Z"},
      {"id": "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22", "hostname": "web-02", "ip": "10.0.1.11", "region": "us-east-1", "tags": ["production", "backend"], "created_at": "2026-01-15T10:00:00Z"}
    ]
  }'
```

### 5. Update data (creates a new version)

```bash
swamp model method run servers run \
  --args '{
    "tableName": "servers",
    "operation": "update",
    "data": [
      {"id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "region": "eu-west-1"}
    ]
  }'
```

### 6. Query current data

```bash
swamp model method run servers query \
  --args '{
    "tableName": "servers",
    "where": "region = '\''us-east-1'\''",
    "limit": 10
  }'
```

### 7. Query historical data

```bash
# First list versions to find a version ID
swamp model method run servers list_versions \
  --args '{"tableName": "servers"}'

# Then query at that version
swamp model method run servers query \
  --args '{
    "tableName": "servers",
    "versionId": "<version-uuid-from-above>"
  }'
```

### 8. Upgrade the schema

```bash
swamp model method run servers upgrade \
  --args '{
    "tableName": "servers",
    "newSchema": {
      "id": "string.uuid",
      "hostname": "string",
      "ip": "string",
      "region": {"type": "string", "optional": true},
      "tags": "json",
      "created_at": "string.datetime",
      "environment": {"type": "string", "default": "production"}
    }
  }'
```

This adds the `environment` column to both `servers` and `servers_history`,
backfills existing rows with `'production'`, then sets `NOT NULL`.

### 9. Garbage-collect old versions

```bash
swamp model method run servers gc \
  --args '{"tableName": "servers", "keepCount": 10}'
```

## Importing External Tables

Import an existing PostgreSQL table to interact with it through swamp:

```bash
swamp model method run servers import_table \
  --args '{
    "sourceSchema": "public",
    "sourceTable": "legacy_inventory",
    "mode": "readonly"
  }'
```

**Read-only mode** (`"readonly"`): Swamp can query the table but write
operations (insert/update/delete) are rejected. The table's schema is
discovered from `information_schema.columns` and a best-effort Zod schema is
generated.

**Read-write mode** (`"readwrite"`): Swamp can insert, update, and delete rows,
but never runs `ALTER TABLE`. The existing schema is respected as-is.

**Important:** Imported tables are **not** versioned — no history tracking, no
`_history` table, no version snapshots. They are external data sources that
swamp reads from (and optionally writes to).

## Under the Hood

### What PostgreSQL sees

After creating the `servers` table and inserting data, here's what exists in
the database:

```sql
-- List all swamp-managed tables
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'swamp'
ORDER BY table_name;
```

```
     table_name
--------------------
 _locks
 _namespace
 _versions
 servers
 servers_history
```

**`servers`** — current rows only:

```sql
SELECT id, hostname, ip, region, tags, created_at
FROM swamp.servers;
```

```
                  id                  | hostname |    ip    |  region   |          tags           |     created_at
--------------------------------------+----------+----------+-----------+-------------------------+---------------------
 a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 | web-01   | 10.0.1.10| eu-west-1 | ["production","frontend"]| 2026-01-15 10:00:00+00
 b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22 | web-02   | 10.0.1.11| us-east-1 | ["production","backend"] | 2026-01-15 10:00:00+00
```

**`servers_history`** — every previous version of every row:

```sql
SELECT id, hostname, region, row_start, row_end
FROM swamp.servers_history
ORDER BY row_start;
```

```
                  id                  | hostname |  region   |         row_start          |          row_end
--------------------------------------+----------+-----------+----------------------------+----------------------------
 a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 | web-01   | us-east-1 | 2026-01-15 10:00:00+00     | 2026-01-15 10:05:00+00
```

The old row (with `region = 'us-east-1'`) was moved to history when the update
changed it to `'eu-west-1'`. The `row_start`/`row_end` columns track exactly
when each version was current.

**`_versions`** — version metadata:

```sql
SELECT version_id, table_name, timestamp, method, message
FROM swamp._versions
WHERE table_name = 'servers'
ORDER BY timestamp DESC;
```

```
              version_id               | table_name |        timestamp         | method |          message
--------------------------------------+------------+--------------------------+--------+---------------------------
 33333333-3333-3333-3333-333333333333 | servers    | 2026-01-15 10:05:00+00  | run    | update 1 row(s)
 22222222-2222-2222-2222-222222222222 | servers    | 2026-01-15 10:00:00+00  | run    | insert 2 row(s)
```

**`_locks`** — distributed locks (active during swamp operations):

```sql
SELECT lock_key, holder, hostname, pid, acquired_at, ttl_ms
FROM swamp._locks;
```

**`_namespace`** — repo registrations (team setups):

```sql
SELECT namespace, repo_id, created_at
FROM swamp._namespace;
```

### Querying history directly

The `periods` extension provides `__as_of(timestamp)` functions for
point-in-time queries:

```sql
-- What did the servers table look like at a specific time?
SELECT * FROM swamp.servers__as_of('2026-01-15 10:02:00+00');

-- All history for a specific row
SELECT * FROM swamp.servers_history
WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
ORDER BY row_start;
```

### Schema migration under the hood

When you run `upgrade`, the migration:

1. Drops system versioning via `periods.drop_system_versioning()`
2. Applies `ALTER TABLE` to both `servers` and `servers_history`
3. For new required columns with defaults: backfills existing rows in batches
4. Re-enables system versioning via `periods.add_system_versioning()`

This ensures history queries continue to work after schema changes — both the
main table and the history table have the same column layout.

### Imported tables under the hood

When you import a table, the extension:

1. Reads `information_schema.columns` to discover the schema
2. Generates a best-effort Zod schema from the column types
3. Registers the import in the `_imports` metadata table

The imported table is **not** altered — no `periods` versioning is added, no
triggers are created. It remains an external table that swamp reads from (and
optionally writes to).

```sql
-- See what's been imported
SELECT model_type, source_schema, source_table, mode, created_at
FROM swamp._imports;
```

## Model Methods Reference

### `create` — Create a versioned table

| Argument | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Table name |
| `schema` | object | Yes | Field name → type descriptor mapping |

**Type descriptors:**

| Descriptor | PostgreSQL type | Notes |
|---|---|---|
| `"string"` | `TEXT` | |
| `"string.uuid"` | `UUID` | Becomes `PRIMARY KEY` if field is named `id` |
| `"string.email"` | `VARCHAR(254)` | + email regex CHECK |
| `"string.url"` | `VARCHAR(2048)` | + URL regex CHECK |
| `"string.datetime"` | `TIMESTAMPTZ` | |
| `"number"` | `DOUBLE PRECISION` | |
| `"number.int"` | `BIGINT` | |
| `"boolean"` | `BOOLEAN` | |
| `"date"` | `TEXT` | |
| `"json"` | `JSONB` | |
| `"array"` | `JSONB` | |

Object descriptors support `type`, `format`, `optional`, `nullable`, `default`,
`min`, and `max`:

```json
{
  "email": {"type": "string", "format": "email"},
  "role": {"type": "string", "optional": true, "default": "user"},
  "score": {"type": "number", "format": "int", "min": 0, "max": 100}
}
```

**Primary key detection:** A field named `id` with type `"string.uuid"` becomes
the primary key. Otherwise, an auto-generated `id UUID DEFAULT gen_random_uuid()
PRIMARY KEY` column is added.

**Auto-created indexes:** Fields ending in `_id` or `_key`, datetime fields,
enum fields, and UUID/email fields get automatic B-tree indexes.

### `run` — Insert, update, or delete data

| Argument | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table |
| `operation` | string | Yes | `"insert"`, `"update"`, or `"delete"` |
| `data` | array | Yes | Array of records (min 1) |

Each `run` call automatically creates a version snapshot. The version UUID is
returned in the result.

Updates and deletes use `id` as the key field (falls back to the first field in
the record if `id` is not present).

### `query` — Query current or historical data

| Argument | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table |
| `versionId` | string | No | Query at this version (omit for current data) |
| `columns` | array | No | Columns to return (default: all) |
| `where` | string | No | Raw SQL WHERE clause fragment |
| `limit` | int | No | Max rows (default: 100, max: 10000) |

### `list_versions` — List version history

| Argument | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table |

Returns versions ordered by timestamp descending (newest first).

### `upgrade` — Migrate a table schema

| Argument | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table |
| `newSchema` | object | Yes | New field name → type descriptor mapping |

Compares the stored schema against the new schema, generates a diff, and
applies changes to both the main table and the history table. New required
columns with defaults are backfilled in batches.

### `gc` — Garbage-collect old versions

| Argument | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table |
| `keepCount` | int | No | Versions to keep (default: 10) |

Prunes old version metadata from `_versions` and corresponding history rows
from `_history`.

### `import_table` — Import an existing table

| Argument | Type | Required | Description |
|---|---|---|---|
| `sourceSchema` | string | Yes | PostgreSQL schema containing the table |
| `sourceTable` | string | Yes | Table to import |
| `mode` | string | No | `"readonly"` (default) or `"readwrite"` |
| `discoverSchema` | boolean | No | Auto-discover schema (default: true) |
| `modelType` | string | No | Model type to register under |

## Backup and Restore

### Full database backup

```bash
pg_dump -h localhost -U swamp -d swamp \
  -Fc -v -f swamp_backup_$(date +%Y%m%d_%H%M%S).dump
```

This captures all versioned tables, history tables, `_versions` metadata,
`_locks`, `_namespace`, and `_imports`.

### Per-model backup

```bash
pg_dump -h localhost -U swamp -d swamp \
  -t swamp.servers \
  -t swamp.servers_history \
  -Fc -f servers_backup.dump
```

### Restore

```bash
pg_restore -h localhost -U swamp -d swamp_restore \
  -v --no-owner --no-acl \
  swamp_backup_20260813.dump
```

### Recovering deleted rows

Deleted rows are moved to the `_history` table. To recover them:

```sql
-- Find recently deleted rows
SELECT *
FROM swamp.servers_history
WHERE row_end > NOW() - INTERVAL '1 hour'
  AND id NOT IN (SELECT id FROM swamp.servers);

-- Undelete specific rows
INSERT INTO swamp.servers
SELECT * FROM swamp.servers__as_of(NOW() - INTERVAL '5 minutes') AS old
WHERE old.id NOT IN (SELECT id FROM swamp.servers);
```

## Security

### Connection security

Always use `ssl: "verify-ca"` in production. Never expose PostgreSQL to the
public internet — use VPC peering, SSH tunnels, or VPN.

### Credential management

Use swamp vault references — never hardcode credentials:

```yaml
datastore:
  type: "@svendowideit/postgres-datastore"
  config:
    connectionString: "postgres://${vault:postgres/user}:${vault:postgres/password}@${vault:postgres/host}:5432/${vault:postgres/database}"
```

### Least privilege

```sql
CREATE USER swamp WITH PASSWORD 'strong-password' LOGIN;
GRANT CREATE ON DATABASE swamp_db TO swamp;
GRANT USAGE, CREATE ON SCHEMA swamp TO swamp;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA swamp TO swamp;
ALTER DEFAULT PRIVILEGES IN SCHEMA swamp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO swamp;
```

### SQL injection

The `query` method's `where` parameter accepts raw SQL. Always validate and
sanitize user-supplied input before passing it to the `where` parameter.

## Upgrades

### Extension upgrades

```bash
swamp extension pull @svendowideit/postgres-datastore
```

Extension upgrades do not modify existing tables or data. The `periods`
extension and versioning infrastructure remain intact.

### PostgreSQL version upgrades

Use `pg_upgrade` for major version upgrades. Always take a full backup first.

```bash
pg_upgrade \
  --old-datadir=/var/lib/postgresql/15/main \
  --new-datadir=/var/lib/postgresql/16/main \
  --old-bindir=/usr/lib/postgresql/15/bin \
  --new-bindir=/usr/lib/postgresql/16/bin \
  --check  # dry run first
```
