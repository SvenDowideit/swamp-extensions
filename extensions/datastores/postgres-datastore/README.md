# PostgreSQL Datastore Extension

## 1. Overview

The PostgreSQL datastore extension provides a fully versioned, schema-aware data layer for swamp. It maps swamp model schemas (Zod) directly to PostgreSQL table schemas (DDL), and schema changes trigger gradual, in-place row migration. Every data mutation is automatically versioned using SQL:2011 SYSTEM VERSIONING via the `periods` extension, giving you a complete audit trail and point-in-time query capability.

The extension has two components:

| Component | Package | Role |
|---|---|---|
| **Datastore** | `@svendowideit/postgres-datastore` | Stores swamp runtime data in PostgreSQL with distributed locking |
| **Model type** | `@svendowideit/postgres-model` | Creates versioned tables, runs data operations, queries history, migrates schemas |

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
│  │  user_table           user_table_history          │    │
│  │  (current rows)       (all historical rows)       │    │
│  │  + row_start          + periods extension         │    │
│  │  + row_end                                        │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## 1a. How Swamp Uses PostgreSQL Under the Hood

When you configure this datastore, swamp's internal runtime files (definitions,
workflows, data snapshots, outputs, bundles, etc.) are stored in PostgreSQL
instead of the local filesystem. This section explains what that looks like
from the database side — so you can inspect, query, and understand the data
using standard `psql` or any PostgreSQL client.

### Swamp's native tables

The datastore creates a `swamp.files` table (in the schema you configure) that
stores every swamp runtime file as a row:

```sql
-- The core storage table
SELECT path, hash, size, updated_at, deleted_at
FROM swamp.files
ORDER BY path
LIMIT 20;
```

| Column | Type | Description |
|--------|------|-------------|
| `path` | `TEXT PRIMARY KEY` | File path relative to the swamp data directory (e.g. `data/@myorg/aws-ec2/my-server/result.json`) |
| `hash` | `TEXT` | SHA-256 hash of the file content |
| `size` | `BIGINT` | File size in bytes |
| `content` | `BYTEA` | The actual file content (binary) |
| `updated_at` | `TIMESTAMPTZ` | When this row was last written |
| `deleted_at` | `TIMESTAMPTZ` | When this file was deleted (NULL = active, non-NULL = tombstone) |

This is the same data you'd see in `.swamp/data/`, `.swamp/definitions-evaluated/`,
`.swamp/workflows-evaluated/`, etc. — just stored in PostgreSQL instead of on disk.

### What normal swamp models and workflows look like in SQL

When you run a swamp model or workflow with this datastore configured, the
output data is stored as rows in `swamp.files`. Here's what happens step by step:

**1. Model definition is evaluated** — swamp writes the evaluated definition:

```sql
SELECT path, length(content) AS bytes
FROM swamp.files
WHERE path LIKE 'definitions-evaluated/%'
ORDER BY path;
```

Example output:
```
                    path                     | bytes
---------------------------------------------+-------
 definitions-evaluated/@myorg/aws-ec2/my-ec2 |  2048
```

**2. Method runs and writes output data** — swamp writes the method's output
as a JSON file:

```sql
SELECT path, length(content) AS bytes
FROM swamp.files
WHERE path LIKE 'data/@myorg/aws-ec2/%'
ORDER BY path;
```

Example output:
```
                        path                         | bytes
-----------------------------------------------------+-------
 data/@myorg/aws-ec2/my-ec2/result.json              |  4096
 data/@myorg/aws-ec2/my-ec2/result.json.meta         |   256
```

**3. Inspect the actual output data** — since it's stored as BYTEA, you can
cast it to text to read the JSON:

```sql
SELECT
  path,
  convert_from(content, 'UTF8') AS json_content
FROM swamp.files
WHERE path = 'data/@myorg/aws-ec2/my-ec2/result.json';
```

**4. Workflow runs** — workflow evaluation state is stored similarly:

```sql
SELECT path, updated_at
FROM swamp.files
WHERE path LIKE 'workflows-evaluated/%'
ORDER BY updated_at DESC
LIMIT 10;
```

**5. Workflow run history** — each workflow run produces output files:

```sql
SELECT path, updated_at
FROM swamp.files
WHERE path LIKE 'workflow-runs/%'
ORDER BY updated_at DESC
LIMIT 10;
```

### Finding all data for a specific model

```sql
-- Everything related to a specific model
SELECT
  path,
  pg_size_pretty(length(content)) AS size,
  updated_at
FROM swamp.files
WHERE path LIKE '%@myorg/aws-ec2%'
ORDER BY path;
```

### Finding recent activity

```sql
-- What happened in the last hour?
SELECT
  path,
  updated_at,
  CASE WHEN deleted_at IS NOT NULL THEN 'DELETED' ELSE 'active' END AS status
FROM swamp.files
WHERE updated_at > NOW() - INTERVAL '1 hour'
ORDER BY updated_at DESC;
```

### Storage usage

```sql
-- How much space is swamp using?
SELECT
  COUNT(*) AS file_count,
  pg_size_pretty(SUM(length(content))) AS total_size,
  pg_size_pretty(SUM(CASE WHEN deleted_at IS NULL THEN length(content) ELSE 0 END)) AS active_size,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS tombstone_count
FROM swamp.files;
```

### Sync state (team environments)

When multiple people share a swamp repo via this datastore, the sync state
tracks what's been pushed and pulled:

```sql
SELECT key, value, updated_at
FROM swamp.sync_state;
```

| key | value | Description |
|-----|-------|-------------|
| `commit_seq` | `42` | Monotonic commit counter — used to detect new changes |
| `last_pushed_at` | `"2026-08-13T10:30:00+00"` | When the last push happened (legacy watermark) |

### Distributed locks

When swamp operations are running, you can see active locks:

```sql
SELECT
  lock_key,
  holder,
  hostname,
  pid,
  acquired_at,
  ttl_ms,
  age(NOW(), acquired_at) AS lock_age
FROM swamp._locks
ORDER BY acquired_at DESC;
```

If a lock is older than its `ttl_ms`, the holder process has likely crashed
and the lock will be automatically reclaimed by the next acquirer.

### Namespace registry

In team setups, each repo gets a namespace:

```sql
SELECT namespace, repo_id, created_at
FROM swamp._namespace
ORDER BY namespace;
```

### How the datastore and model type work together

The datastore (`@svendowideit/postgres-datastore`) and the model type
(`@svendowideit/postgres-model`) serve different purposes:

| Layer | What it stores | Table(s) | Example query |
|-------|---------------|----------|---------------|
| **Datastore** | Swamp's internal runtime files (definitions, outputs, workflow state) | `swamp.files`, `swamp.sync_state`, `swamp._locks`, `swamp._namespace` | `SELECT path FROM swamp.files WHERE path LIKE 'data/%'` |
| **Model type** | Your application data in typed, versioned tables | Per-model tables (e.g. `swamp.servers`, `swamp.servers_history`) + `swamp._versions` | `SELECT * FROM swamp.servers` |

The datastore is always active when you use this extension — it replaces
swamp's filesystem storage. The model type is optional — you use it when you
want typed, versioned tables for your application data instead of JSON blobs
in `swamp.files`.

### Direct SQL access to model data

When you use the model type to create versioned tables, you can query them
directly with any PostgreSQL client:

```sql
-- Current data (always the latest version)
SELECT * FROM swamp.servers;

-- Historical data at a specific point in time
SELECT * FROM swamp.servers__as_of('2026-08-12T10:30:00Z');

-- All versions of a specific row
SELECT * FROM swamp.servers_history WHERE id = 'abc-123' ORDER BY row_end DESC;

-- Version metadata (who created each version, when, why)
SELECT version_id, timestamp, method, model_name, message
FROM swamp._versions
WHERE table_name = 'servers'
ORDER BY timestamp DESC;

-- Row-level changes between two versions
SELECT * FROM swamp.servers_history
WHERE row_end > (SELECT timestamp FROM swamp._versions WHERE version_id = 'v1')
  AND row_end <= (SELECT timestamp FROM swamp._versions WHERE version_id = 'v2')
ORDER BY row_end;
```

This means you can use standard BI tools (Metabase, Grafana, Tableau), ORMs,
or direct `psql` queries against your swamp-managed data — it's just regular
PostgreSQL tables with automatic version history.

## 2. Prerequisites

- **PostgreSQL 15+** — required for `gen_random_uuid()` (used for auto-generated primary keys)
- **`periods` extension** — automatically installed by the datastore on first use. The extension must be available in your PostgreSQL installation (it ships with most package managers as `postgresql-15-periods` or similar)
- **Deno** — swamp extensions run on Deno

### Docker Compose (local development)

```yaml
version: "3.8"
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

For production, install the `periods` extension via your distribution's package manager:

```bash
# Debian/Ubuntu
apt-get install postgresql-15-periods

# RHEL/Rocky
dnf install periods_15
```

## 3. Quick Start

### Step 1: Configure `.swamp.yaml`

Add the datastore to your swamp configuration:

```yaml
# .swamp.yaml
swampVersion: 20260806.001601.0
repoId: e46f92ff-737f-41b7-9d52-c141bb67a79c

datastore:
  type: "@svendowideit/postgres-datastore"
  config:
    connectionString: "postgres://swamp:swamp@localhost:5432/swamp"
    schema: "swamp"
    ssl: "disable"  # use "require" or "verify-ca" in production
```

### Step 2: Create the required schema (one-time)

The datastore auto-creates its infrastructure on first use. Run a health check to verify:

```bash
swamp datastore status
# Expected: healthy: true, periods: available
```

### Step 3: Create a model

Create a model that uses the PostgreSQL model type:

```bash
swamp model create users \
  --type "@svendowideit/postgres-model" \
  --global-args '{
    "connectionString": "postgres://swamp:swamp@localhost:5432/swamp",
    "schema": "swamp"
  }'
```

Create your first versioned table:

```bash
swamp model method run users create \
  --args '{
    "tableName": "users",
    "schema": {
      "id": "string.uuid",
      "name": "string",
      "email": "string.email",
      "role": {"type": "string", "optional": true, "default": "user"},
      "created_at": "string.datetime"
    }
  }'
```

### Step 4: Run data operations

```bash
# Insert rows
swamp model method run users run \
  --args '{
    "tableName": "users",
    "operation": "insert",
    "data": [
      {"id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "name": "Alice", "email": "alice@example.com", "created_at": "2026-01-01T00:00:00Z"},
      {"id": "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22", "name": "Bob", "email": "bob@example.com", "created_at": "2026-01-02T00:00:00Z"}
    ]
  }'

# Update a row
swamp model method run users run \
  --args '{
    "tableName": "users",
    "operation": "update",
    "data": [
      {"id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "name": "Alice Updated"}
    ]
  }'

# Delete a row
swamp model method run users run \
  --args '{
    "tableName": "users",
    "operation": "delete",
    "data": [
      {"id": "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22"}
    ]
  }'
```

### Step 5: Query current and historical data

```bash
# Query current data
swamp model method run users query \
  --args '{
    "tableName": "users",
    "where": "role = '\''user'\''",
    "limit": 10
  }'

# Query historical data at a specific version
swamp model method run users query \
  --args '{
    "tableName": "users",
    "versionId": "<version-uuid-from-list_versions>"
  }'
```

### Step 6: List versions

```bash
swamp model method run users list_versions \
  --args '{"tableName": "users"}'
```

## 4. Configuration Reference

### Full `.swamp.yaml` example

```yaml
swampVersion: 20260806.001601.0
repoId: e46f92ff-737f-41b7-9d52-c141bb67a79c

datastore:
  type: "@svendowideit/postgres-datastore"
  config:
    # Required: PostgreSQL connection URI
    connectionString: "postgres://user:pass@host:5432/dbname"

    # Optional: PostgreSQL schema for swamp tables (default: "swamp")
    schema: "swamp"

    # Optional: SSL mode (default: "require")
    #   "disable"  — no SSL (local development only)
    #   "require"  — SSL required, no certificate verification
    #   "verify-ca" — SSL required, verify CA certificate
    ssl: "require"

    # Optional: Path to CA certificate bundle (required for ssl: "verify-ca")
    sslCaPath: "/path/to/rds-ca-bundle.pem"

    # Optional: Connection pool settings
    pool:
      maxConnections: 10       # 1-100 (default: 10)
      idleTimeoutMs: 30000     # milliseconds (default: 30000)
      connectTimeoutMs: 5000   # milliseconds (default: 5000)
```

### Environment variable overrides

All config values can be overridden via environment variables. Use the `connectionString` field with `${env:VAR_NAME}` syntax:

```yaml
datastore:
  type: "@svendowideit/postgres-datastore"
  config:
    connectionString: "${env:DATABASE_URL}"
    ssl: "${env:PGSSLMODE}"
```

### Vault references

For credential management, use swamp vault references:

```yaml
datastore:
  type: "@svendowideit/postgres-datastore"
  config:
    connectionString: "postgres://${vault:postgres/user}:${vault:postgres/password}@${vault:postgres/host}:5432/${vault:postgres/database}"
```

### Connection string formats

```
# Standard URI
postgres://user:password@host:5432/database

# With query parameters
postgres://user:password@host:5432/database?sslmode=require&connect_timeout=10

# Unix socket
postgres://user:password@/database?host=/var/run/postgresql

# IPv6
postgres://user:password@[::1]:5432/database
```

### SSL modes

| Mode | When to use |
|---|---|
| `disable` | Local development, CI/CD pipelines |
| `require` | Staging, internal networks with TLS |
| `verify-ca` | Production, especially with cloud providers (RDS, Cloud SQL) |

For `verify-ca` with AWS RDS, download the CA bundle:

```bash
curl -o rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

Then reference it in config:

```yaml
ssl: "verify-ca"
sslCaPath: "./rds-ca-bundle.pem"
```

## 5. Model Methods Reference

All methods are invoked via `swamp model method run <model-name> <method>`.

### `create`

Creates a versioned PostgreSQL table from a Zod schema definition.

**Arguments:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Name of the table to create |
| `schema` | object | Yes | JSON schema descriptor (field name → type descriptor) |

**Type descriptors** can be simple strings or detailed objects:

```json
// Simple string descriptors
{ "name": "string", "age": "number", "active": "boolean" }

// Detailed object descriptors
{
  "email": { "type": "string", "format": "email" },
  "role": { "type": "string", "optional": true, "default": "user" },
  "score": { "type": "number", "format": "int", "min": 0, "max": 100 }
}
```

**Supported type descriptors:**

| Descriptor | PostgreSQL type |
|---|---|
| `"string"` | `TEXT` |
| `"string.uuid"` | `UUID` |
| `"string.email"` | `VARCHAR(254)` |
| `"string.url"` | `VARCHAR(2048)` |
| `"string.datetime"` | `TIMESTAMPTZ` |
| `"number"` | `DOUBLE PRECISION` |
| `"number.int"` | `BIGINT` |
| `"number.safeint"` | `BIGINT` |
| `"boolean"` | `BOOLEAN` |
| `"date"` | `DATE` |
| `"json"` | `JSONB` |
| `"array"` | `JSONB` |

**Primary key detection:** If the schema has a field named `id` typed as `"string.uuid"`, it becomes the primary key. Otherwise, an auto-generated `id UUID DEFAULT gen_random_uuid() PRIMARY KEY` column is added.

**Auto-created indexes:** Indexes are automatically created on fields ending in `_id` or `_key`, datetime fields, enum fields, and UUID/email fields.

**Example:**

```bash
swamp model method run users create \
  --args '{
    "tableName": "products",
    "schema": {
      "id": "string.uuid",
      "name": "string",
      "price": "number",
      "category": {"type": "string", "optional": true},
      "tags": "json"
    }
  }'
```

### `run`

Executes a data operation (insert, update, or delete) and automatically creates a version snapshot.

**Arguments:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table name |
| `operation` | string | Yes | `"insert"`, `"update"`, or `"delete"` |
| `data` | array | Yes | Array of records (minimum 1) |

**Insert example:**

```bash
swamp model method run users run \
  --args '{
    "tableName": "products",
    "operation": "insert",
    "data": [
      {"id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "name": "Widget", "price": 9.99},
      {"id": "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22", "name": "Gadget", "price": 19.99}
    ]
  }'
```

**Update example:**

Updates require a key field. The method prefers `id`, falling back to the first field in the record.

```bash
swamp model method run users run \
  --args '{
    "tableName": "products",
    "operation": "update",
    "data": [
      {"id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "price": 12.99, "name": "Widget Pro"}
    ]
  }'
```

**Delete example:**

Deletes require a key field (same preference as update).

```bash
swamp model method run users run \
  --args '{
    "tableName": "products",
    "operation": "delete",
    "data": [
      {"id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"},
      {"id": "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22"}
    ]
  }'
```

**Output:** Each `run` call returns the operation type, affected row count, and a new version UUID.

### `query`

Queries current or historical data from a versioned table.

**Arguments:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table name |
| `versionId` | string | No | Query rows as they existed at this version |
| `columns` | array | No | Columns to return (default: all) |
| `where` | string | No | Raw SQL WHERE clause fragment (without `WHERE` keyword) |
| `limit` | number | No | Maximum rows to return (default: 100, max: 10000) |

**Current data query:**

```bash
swamp model method run users query \
  --args '{
    "tableName": "products",
    "where": "price > 10.00",
    "limit": 50
  }'
```

**Historical data query:**

```bash
swamp model method run users query \
  --args '{
    "tableName": "products",
    "versionId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "columns": ["id", "name", "price"]
  }'
```

**Security note:** The `where` parameter accepts raw SQL and is interpolated directly into the query. This is a known injection vector. Always validate and sanitize user-supplied WHERE clauses. See [Security](#10-security) for details.

### `list_versions`

Lists all versions for a table, newest first.

**Arguments:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table name |

**Example:**

```bash
swamp model method run users list_versions \
  --args '{"tableName": "products"}'
```

**Output:** Array of version objects with `versionId`, `timestamp`, `method`, `modelName`, `workflowId`, and `message`.

### `upgrade`

Migrates a table schema using gradual row migration. Compares the stored schema (from the last `create` or `upgrade`) against the new schema, generates a diff, and applies changes.

**Arguments:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table name |
| `newSchema` | object | Yes | New JSON schema descriptor |

**Example:**

```bash
# Add a new required column with a default value
swamp model method run users upgrade \
  --args '{
    "tableName": "products",
    "newSchema": {
      "id": "string.uuid",
      "name": "string",
      "price": "number",
      "category": {"type": "string", "optional": true},
      "tags": "json",
      "in_stock": {"type": "boolean", "default": true}
    }
  }'
```

**Migration process:**

1. Diff old and new schemas field-by-field
2. Add nullable columns first, then required columns
3. For new required columns with defaults: add as nullable, backfill in batches, then set `NOT NULL`
4. Apply type changes with `USING` cast clauses
5. Add/drop constraints
6. Change optionality (nullable ↔ not null)
7. Drop removed columns last

**Before upgrading:** Always take a backup. See [Backup and Restore](#8-backup-and-restore).

### `gc`

Garbage-collects old versions, keeping only the most recent N versions. Prunes both the `_versions` metadata and the `_history` table rows.

**Arguments:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tableName` | string | Yes | Target table name |
| `keepCount` | number | No | Number of recent versions to keep (default: 10) |

**Example:**

```bash
swamp model method run users gc \
  --args '{
    "tableName": "products",
    "keepCount": 20
  }'
```

**Warning:** Pruned history data is permanently deleted and cannot be recovered. Ensure you have backups before running GC with a low `keepCount`.

### `import_table`

Imports an existing PostgreSQL table into the swamp schema manager. Useful for integrating with existing databases without migrating data.

**Arguments:**

| Field | Type | Required | Description |
|---|---|---|---|
| `sourceSchema` | string | Yes | PostgreSQL schema where the table lives |
| `sourceTable` | string | Yes | Name of the table to import |
| `mode` | string | No | `"readonly"` or `"readwrite"` (default: `"readonly"`) |
| `discoverSchema` | boolean | No | Auto-discover schema from `information_schema` (default: `true`) |
| `modelType` | string | No | Model type to register under (default: `"@svendowideit/postgres-model"`) |

**Read-only import:**

```bash
swamp model method run users import_table \
  --args '{
    "sourceSchema": "public",
    "sourceTable": "legacy_users",
    "mode": "readonly"
  }'
```

**Read-write import:**

```bash
swamp model method run users import_table \
  --args '{
    "sourceSchema": "public",
    "sourceTable": "legacy_users",
    "mode": "readwrite"
  }'
```

**Important notes:**
- Read-only tables reject write operations (INSERT/UPDATE/DELETE)
- Read-write tables allow writes but never run ALTER TABLE
- Imported tables are **not** versioned — no history tracking
- Schema discovery reads `information_schema.columns` and generates a best-effort Zod schema
- Import metadata is stored in the `_imports` table

## 6. Schema Management

### Zod to PostgreSQL type mapping

| Zod type | PostgreSQL type | Notes |
|---|---|---|
| `z.string()` | `TEXT` | |
| `z.string().uuid()` | `UUID` | |
| `z.string().email()` | `VARCHAR(254)` | |
| `z.string().url()` | `VARCHAR(2048)` | |
| `z.string().datetime()` | `TIMESTAMPTZ` | |
| `z.string().max(n)` | `VARCHAR(n)` | |
| `z.number()` | `DOUBLE PRECISION` | |
| `z.number().int()` | `BIGINT` | |
| `z.number().safeint()` | `BIGINT` | |
| `z.boolean()` | `BOOLEAN` | |
| `z.enum()` | `VARCHAR(n)` | n = longest enum value |
| `z.literal()` | `VARCHAR(n)` | n = stringified value length |
| `z.bigint()` | `NUMERIC` | |
| `z.date()` | `DATE` | |
| `z.isoDateTime()` | `TIMESTAMPTZ` | |
| `z.isoDate()` | `DATE` | |
| `z.null()` | `TEXT` | |
| `z.array()` | `JSONB` | |
| `z.object()` | `JSONB` | |
| `z.record()` | `JSONB` | |
| `z.union()` | `JSONB` | |

### CHECK constraints

Zod validation rules are translated to PostgreSQL CHECK constraints:

| Zod rule | CHECK constraint |
|---|---|
| `z.string().min(n)` | `char_length(col) >= n` |
| `z.string().max(n)` | `char_length(col) <= n` |
| `z.string().email()` | Regex pattern for email format |
| `z.string().url()` | `col ~ '^https?://'` |
| `z.number().min(n)` | `col >= n` |
| `z.number().max(n)` | `col <= n` |
| `z.enum(["a", "b"])` | `col IN ('a', 'b')` |
| `z.literal("x")` | `col = 'x'` |

### How schema changes work

Schema migration follows a three-phase process:

1. **Diff** — Compare the stored schema (from the last `create` or `upgrade`) against the new schema field-by-field. The diff algorithm produces an ordered list of changes: add columns (nullable first, then required), type changes, constraint changes, optionality changes, and drops.

2. **Plan** — Changes are ordered for safe sequential application. New nullable columns are added first (no data migration needed). New required columns are added as nullable, then backfilled, then set to `NOT NULL`. Type changes use `USING` casts. Drops happen last.

3. **Migrate** — Each change is applied as an `ALTER TABLE` statement. For new required columns with default values, rows are backfilled in batches.

### Gradual row migration

When a new required column is added with a default value, the migration backfills existing rows in configurable batches:

- **Default batch size:** 1000 rows per batch
- **Batch delay:** 0ms by default (configurable via `batchDelayMs`)
- **Process:** `UPDATE ... SET col = default WHERE col IS NULL LIMIT batch_size` repeated until all rows are backfilled
- **After backfill:** `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`

This approach avoids long-running transactions that could cause lock contention on large tables.

### What happens to old versions during migration

- **History tables are not altered.** The `_history` table retains the old schema. Historical queries (`__as_of`) against versions created before the migration will return data in the old schema shape.
- **New columns in history:** Rows written to history after the migration will include the new columns. Rows from before the migration will have `NULL` for new columns.
- **Dropped columns in history:** Dropped columns remain in the history table. Historical queries will still return them.

## 7. Versioning Model

### How system versioning works

The extension uses the PostgreSQL `periods` extension to implement SQL:2011 SYSTEM VERSIONING. When versioning is enabled on a table:

1. Two system columns are added: `row_start` (TIMESTAMPTZ) and `row_end` (TIMESTAMPTZ)
2. A companion `_history` table is created with the same schema
3. Triggers automatically copy old row versions to the history table on UPDATE and DELETE
4. `SELECT * FROM table` always returns only current rows (where `row_end IS NULL` or `row_end > now()`)

### Querying current data

Standard `SELECT` queries always return current data:

```sql
SELECT * FROM swamp.users;
-- Returns only current (non-deleted, latest version) rows
```

The `query` method without a `versionId` does exactly this.

### Querying historical data

The `periods` extension provides a `__as_of(timestamp)` function:

```sql
SELECT * FROM swamp.users__as_of('2026-01-15T12:00:00Z');
-- Returns rows as they existed at that timestamp
```

The `query` method with a `versionId` looks up the version's timestamp and uses `__as_of`:

```bash
swamp model method run users query \
  --args '{
    "tableName": "users",
    "versionId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
  }'
```

### How versions are created

Every `run` call (insert, update, delete) automatically creates a version snapshot:

1. The data operation executes
2. A new row is inserted into `_versions` with metadata (timestamp, method, model name, workflow ID, message)
3. The version UUID is returned in the operation result

### Listing versions

```bash
swamp model method run users list_versions \
  --args '{"tableName": "users"}'
```

Returns versions ordered by timestamp descending (newest first).

### Pruning versions

```bash
swamp model method run users gc \
  --args '{"tableName": "users", "keepCount": 10}'
```

Deletes old version metadata from `_versions` and corresponding history rows from `_history`. Only the most recent `keepCount` versions are retained.

### The `_versions` metadata table

```sql
CREATE TABLE swamp._versions (
    version_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name   TEXT NOT NULL,
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    method       TEXT,           -- e.g. "run", "sync"
    model_name   TEXT,           -- swamp model name
    workflow_id  TEXT,           -- workflow run ID if applicable
    message      TEXT            -- human-readable description
);

CREATE INDEX idx_versions_table_time
  ON swamp._versions (table_name, timestamp DESC);
```

## 8. Backup and Restore

**This section is critical. User data is your reputation. Test your backups regularly.**

### pg_dump: Full database backup

A full `pg_dump` captures all swamp tables, history tables, metadata tables, and the `periods` extension configuration:

```bash
# Full database backup (custom format, compressed)
pg_dump -h localhost -U swamp -d swamp \
  -Fc -v -f swamp_backup_$(date +%Y%m%d_%H%M%S).dump

# Full database backup (plain SQL, for manual inspection)
pg_dump -h localhost -U swamp -d swamp \
  -Fp -v -f swamp_backup_$(date +%Y%m%d_%H%M%S).sql
```

**What's included:**
- All versioned tables (current data)
- All `_history` tables (full audit trail)
- `_versions` metadata (version tracking)
- `_locks` table (current lock state)
- `_namespace` table (repo registrations)
- `_imports` table (imported table registrations)
- `periods` extension and its configuration

**Scheduling recommendations:**

| Frequency | Type | Retention |
|---|---|---|
| Daily | Full `pg_dump` | 30 days |
| Hourly | WAL archive (for PITR) | 7 days |
| Weekly | Full `pg_dump` to off-site storage | 12 months |

Example cron entry:

```bash
# Daily full backup at 2 AM
0 2 * * * pg_dump -h localhost -U swamp -d swamp -Fc -f /backups/swamp_$(date +\%Y\%m\%d).dump
```

### pg_dump per-model

To dump a single model's table, history, and metadata:

```bash
# Dump a specific table and its history
pg_dump -h localhost -U swamp -d swamp \
  -t swamp.users \
  -t swamp.users_history \
  -Fc -f users_backup.dump

# Include version metadata for that table
pg_dump -h localhost -U swamp -d swamp \
  -t swamp.users \
  -t swamp.users_history \
  --table="swamp._versions" \
  -Fc -f users_full_backup.dump
```

To restore just the version metadata for a specific table, filter after restore:

```sql
DELETE FROM swamp._versions WHERE table_name != 'users';
```

### Point-in-time recovery (PITR)

PITR allows recovery to any point in time, not just the last backup. This requires WAL (Write-Ahead Log) archiving.

**Enable WAL archiving** in `postgresql.conf`:

```ini
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f'
archive_timeout = 60  # seconds
```

**Recovery to a specific timestamp:**

1. Stop PostgreSQL
2. Restore the base backup
3. Create `recovery.conf` (PG 12+) or `recovery.signal` + custom config:

```ini
# postgresql.conf (PG 12+)
restore_command = 'cp /wal_archive/%f %p'
recovery_target_time = '2026-08-13 14:30:00 UTC'
recovery_target_action = 'promote'
```

4. Start PostgreSQL — it replays WAL up to the target time

**How PITR interacts with swamp versions:**

- WAL replay restores the exact database state at the target time
- All swamp version metadata (`_versions`) is restored
- `__as_of` queries will work for any timestamp within the recovered range
- You can recover to just before a bad migration or accidental deletion

### Restore procedure

**Step-by-step from a pg_dump backup:**

```bash
# 1. Create a fresh database (or drop and recreate)
psql -h localhost -U postgres -c "DROP DATABASE IF EXISTS swamp_restore;"
psql -h localhost -U postgres -c "CREATE DATABASE swamp_restore OWNER swamp;"

# 2. Restore the dump
pg_restore -h localhost -U swamp -d swamp_restore \
  -v --no-owner --no-acl \
  swamp_backup_20260813.dump

# 3. Verify the periods extension is enabled
psql -h localhost -U swamp -d swamp_restore \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'periods';"

# 4. Verify table structure
psql -h localhost -U swamp -d swamp_restore \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'swamp' ORDER BY table_name;"

# 5. Verify row counts
psql -h localhost -U swamp -d swamp_restore \
  -c "SELECT 'users' AS tbl, COUNT(*) FROM swamp.users
      UNION ALL
      SELECT 'users_history', COUNT(*) FROM swamp.users_history;"

# 6. Verify version metadata
psql -h localhost -U swamp -d swamp_restore \
  -c "SELECT table_name, COUNT(*) AS versions FROM swamp._versions GROUP BY table_name;"

# 7. Test a historical query
psql -h localhost -U swamp -d swamp_restore \
  -c "SELECT COUNT(*) FROM swamp.users__as_of(NOW() - INTERVAL '1 day');"
```

### Testing backups

**Never trust a backup you haven't restored.** Schedule regular restore tests:

```bash
#!/bin/bash
# Weekly backup verification script

BACKUP_FILE="/backups/swamp_$(date +%Y%m%d).dump"
TEST_DB="swamp_verify_$(date +%Y%m%d)"

# Restore to test database
psql -h localhost -U postgres -c "CREATE DATABASE $TEST_DB OWNER swamp;"
pg_restore -h localhost -U swamp -d "$TEST_DB" "$BACKUP_FILE"

# Run verification queries
psql -h localhost -U swamp -d "$TEST_DB" <<SQL
SELECT 'Current rows' AS check_name, COUNT(*) FROM swamp.users
UNION ALL
SELECT 'History rows', COUNT(*) FROM swamp.users_history
UNION ALL
SELECT 'Versions', COUNT(*) FROM swamp._versions
UNION ALL
SELECT 'Locks', COUNT(*) FROM swamp._locks;
SQL

# Verify historical queries work
psql -h localhost -U swamp -d "$TEST_DB" \
  -c "SELECT COUNT(*) FROM swamp.users__as_of(NOW() - INTERVAL '7 days');"

# Cleanup
psql -h localhost -U postgres -c "DROP DATABASE $TEST_DB;"

echo "Backup verification complete: $BACKUP_FILE"
```

## 9. Disaster Recovery

**This section is critical. Practice these procedures before you need them.**

### Database server failure

**Failover to a replica:**

If you're running streaming replication, promote the replica:

```bash
# On the replica
pg_ctl promote -D /var/lib/postgresql/15/main
```

**What happens to in-flight swamp operations:**

- Any operation that hasn't committed is lost (standard PostgreSQL behavior)
- The `_locks` table may contain stale lock entries from the failed primary
- New operations on the promoted replica will acquire fresh locks

**Lock recovery after failover:**

```sql
-- Identify stale locks (older than their TTL)
SELECT lock_key, holder, hostname, pid, acquired_at,
       EXTRACT(EPOCH FROM (NOW() - acquired_at)) * 1000 AS age_ms,
       ttl_ms
FROM swamp._locks
WHERE EXTRACT(EPOCH FROM (NOW() - acquired_at)) * 1000 > ttl_ms;

-- Clean up stale locks
DELETE FROM swamp._locks
WHERE EXTRACT(EPOCH FROM (NOW() - acquired_at)) * 1000 > ttl_ms;
```

The datastore's lock acquisition logic automatically detects and cleans stale locks (by terminating the backend PID and deleting the lock row) when it encounters a lock held beyond its TTL.

### Corrupted data

**Detection:**

```bash
# Enable data checksums (requires initdb with --data-checksums)
pg_verify_checksums -D /var/lib/postgresql/15/main

# Check for corruption in specific tables
psql -h localhost -U swamp -d swamp -c "SELECT * FROM swamp.users ORDER BY id;"
```

**Recovery from a known-good version:**

If you detect corruption in current data but have a known-good historical version:

```sql
-- 1. Identify the last known-good version
SELECT version_id, timestamp, message
FROM swamp._versions
WHERE table_name = 'users'
ORDER BY timestamp DESC;

-- 2. Extract known-good data from that version
-- (using the version's timestamp)
SELECT * FROM swamp.users__as_of('2026-08-13 10:00:00 UTC');

-- 3. Export known-good data
\copy (SELECT * FROM swamp.users__as_of('2026-08-13 10:00:00 UTC')) TO '/tmp/users_good.csv' CSV HEADER;

-- 4. Truncate and restore from known-good data
BEGIN;
DELETE FROM swamp.users;
\copy swamp.users FROM '/tmp/users_good.csv' CSV HEADER;
COMMIT;
```

### Accidental deletion

**Recovering deleted rows from the history table:**

When rows are deleted from a versioned table, they're moved to the `_history` table with a `row_end` timestamp. The current table no longer contains them, but the history does.

```sql
-- Find recently deleted rows
SELECT *
FROM swamp.users_history
WHERE row_end > NOW() - INTERVAL '1 hour'
  AND id NOT IN (SELECT id FROM swamp.users);

-- Undelete specific rows
INSERT INTO swamp.users (id, name, email, role, created_at)
SELECT id, name, email, role, created_at
FROM swamp.users_history
WHERE id IN ('uuid-1', 'uuid-2')
  AND row_end = (
    SELECT MAX(row_end)
    FROM swamp.users_history h2
    WHERE h2.id = swamp.users_history.id
  );
```

**Recovering to a point before deletion:**

```sql
-- Query the state 5 minutes before the deletion
SELECT * FROM swamp.users__as_of(NOW() - INTERVAL '5 minutes');

-- Re-insert all rows that existed at that time but don't exist now
INSERT INTO swamp.users
SELECT * FROM swamp.users__as_of(NOW() - INTERVAL '5 minutes') AS old
WHERE old.id NOT IN (SELECT id FROM swamp.users);
```

### Schema migration failure

**What happens if migration fails mid-way:**

- DDL changes (ALTER TABLE) that succeed are committed immediately — they are **not** rolled back
- Batched backfill is **not** transactional — rows backfilled before the failure remain backfilled
- The stored schema in `table_metadata` is only updated on success — it retains the old schema

**Recovery steps:**

```bash
# 1. Check the current table state
psql -h localhost -U swamp -d swamp -c "\d swamp.users"

# 2. Check which changes were applied
psql -h localhost -U swamp -d swamp -c "
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'swamp' AND table_name = 'users'
  ORDER BY ordinal_position;
"

# 3. Option A: Restore from backup (safest)
# Follow the restore procedure in Section 8

# 4. Option B: Manual rollback
# If only a few columns were added, drop them:
ALTER TABLE swamp.users DROP COLUMN new_column_name;

# If type changes were applied, revert them:
ALTER TABLE swamp.users ALTER COLUMN column_name TYPE old_type USING column_name::old_type;

# 5. Verify the schema matches the stored metadata
swamp model method run users query --args '{"tableName": "users", "limit": 1}'

# 6. Re-attempt the upgrade after fixing
swamp model method run users upgrade --args '{...}'
```

**Prevention:**

- Always take a backup before running `upgrade`
- Test migrations on a staging environment first
- For large tables, increase `batchDelayMs` to reduce load during backfill

### Complete datacenter loss

**Off-site backup strategy:**

1. **Automated off-site replication:**
   ```bash
   # Daily: copy pg_dump to off-site storage (S3, GCS, etc.)
   aws s3 cp swamp_backup_$(date +%Y%m%d).dump s3://disaster-recovery-bucket/postgres/
   ```

2. **Streaming replica in a different region:**
   - Set up a cross-region streaming replica
   - Keep WAL archives in the remote region's object storage

3. **Configuration backup:**
   ```bash
   # Backup swamp configuration
   tar czf swamp_config_$(date +%Y%m%d).tar.gz .swamp.yaml extensions/
   aws s3 cp swamp_config_$(date +%Y%m%d).tar.gz s3://disaster-recovery-bucket/config/
   ```

**RTO and RPO guidance:**

| Strategy | RPO | RTO |
|---|---|---|
| Daily pg_dump only | Up to 24 hours | 1-4 hours |
| Daily pg_dump + hourly WAL archive | Up to 1 hour | 1-4 hours |
| Streaming replica (same region) | Seconds | Minutes |
| Cross-region streaming replica | Seconds | 15-30 minutes |
| Cross-region replica + off-site WAL | Seconds | 15-30 minutes |

**Recovery procedure for complete datacenter loss:**

```bash
# 1. Provision a new PostgreSQL instance in the recovery region
# 2. Restore the latest pg_dump
pg_restore -h new-host -U swamp -d swamp -v latest_backup.dump

# 3. Apply WAL archives (if available)
# Configure recovery.conf on the new instance

# 4. Verify data integrity
psql -h new-host -U swamp -d swamp -c "
  SELECT table_name, COUNT(*) FROM swamp._versions GROUP BY table_name;
"

# 5. Update DNS / connection strings to point to the new instance
# 6. Update .swamp.yaml with the new connection string
# 7. Run a health check
swamp datastore status
```

## 10. Security

**This section is critical. A compromised database compromises all your data.**

### Connection security

**SSL modes:**

| Mode | Behavior | Use case |
|---|---|---|
| `disable` | No encryption | Local development only. Never use in production. |
| `require` | TLS required, no certificate verification | Internal networks, staging. Protects against eavesdropping but not MITM. |
| `verify-ca` | TLS required, CA verified | Production. Protects against both eavesdropping and MITM. |

**RDS CA bundle setup:**

```bash
# Download the AWS RDS CA bundle
curl -o rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# Configure in .swamp.yaml
ssl: "verify-ca"
sslCaPath: "./rds-ca-bundle.pem"
```

### Authentication

**Recommended:** `scram-sha-256` (PostgreSQL 14+)

```ini
# postgresql.conf
password_encryption = scram-sha-256

# pg_hba.conf
hostssl all all 0.0.0.0/0 scram-sha-256
```

**Never use in production:**
- `trust` authentication (no password)
- `password` authentication (cleartext)
- `md5` authentication (deprecated, weak)

### Network security

- **Never expose PostgreSQL to the public internet.** Bind to `localhost` or private network interfaces only.
- Use **VPC peering** or **private subnets** in cloud environments
- For remote access, use **SSH tunnels** or **VPN**:

```bash
# SSH tunnel (run on your local machine)
ssh -L 5432:db-host:5432 user@bastion-host

# Then connect via localhost
connectionString: "postgres://swamp:password@localhost:5432/swamp"
```

### Credential management

**Use swamp vault references** — never hardcode credentials:

```yaml
# .swamp.yaml
datastore:
  type: "@svendowideit/postgres-datastore"
  config:
    connectionString: "postgres://${vault:postgres/user}:${vault:postgres/password}@${vault:postgres/host}:5432/${vault:postgres/database}"
```

**Environment variable fallback:**

```yaml
connectionString: "${env:DATABASE_URL}"
```

```bash
export DATABASE_URL="postgres://user:pass@host:5432/db"
```

### Least privilege

The PostgreSQL user needs these minimum permissions:

```sql
-- Create the swamp user with minimal privileges
CREATE USER swamp WITH PASSWORD 'strong-password' LOGIN;

-- Grant schema creation (for the swamp schema)
GRANT CREATE ON DATABASE swamp_db TO swamp;

-- After the schema is created, grant usage
GRANT USAGE ON SCHEMA swamp TO swamp;
GRANT CREATE ON SCHEMA swamp TO swamp;

-- For existing tables, grant CRUD
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA swamp TO swamp;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA swamp TO swamp;

-- For future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA swamp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO swamp;
```

**Read-only user for imported tables:**

```sql
CREATE USER swamp_reader WITH PASSWORD 'reader-password' LOGIN;
GRANT USAGE ON SCHEMA public TO swamp_reader;
GRANT SELECT ON public.legacy_users TO swamp_reader;
```

### SQL injection

**The `query` method's `where` parameter accepts raw SQL and is interpolated directly into the query.** This is a known injection vector.

**Risk example:**

```bash
# DANGEROUS: User-supplied input in WHERE clause
swamp model method run users query \
  --args '{"tableName": "users", "where": "name = '\''$USER_INPUT'\''"}'
```

**Mitigations:**

1. **Validate and sanitize** all user-supplied input before passing it to the `where` parameter
2. **Use allowlists** for column names and operators
3. **Consider using a query builder** in your application layer that generates safe SQL
4. **Never pass unsanitized user input** directly to the `where` parameter
5. **Use parameterized queries** in your own code that wraps the swamp model

**Safe pattern:**

```typescript
// In your application code, validate before calling swamp
const ALLOWED_COLUMNS = ["id", "name", "email", "role"];
const ALLOWED_OPERATORS = ["=", ">", "<", ">=", "<=", "LIKE"];

function buildSafeWhere(filter: { column: string; operator: string; value: string }): string {
  if (!ALLOWED_COLUMNS.includes(filter.column)) throw new Error("Invalid column");
  if (!ALLOWED_OPERATORS.includes(filter.operator)) throw new Error("Invalid operator");
  const escaped = filter.value.replace(/'/g, "''");
  return `${filter.column} ${filter.operator} '${escaped}'`;
}
```

### Audit logging

Enable PostgreSQL audit logging:

```ini
# postgresql.conf
log_statement = 'mod'           # Log INSERT, UPDATE, DELETE, TRUNCATE, COPY
log_connections = on            # Log connection attempts
log_disconnections = on         # Log disconnections
log_duration = on               # Log statement duration
log_line_prefix = '%t [%p]: user=%u,db=%d,app=%a,client=%h '
```

**What to log:**
- All data modifications (`log_statement = 'mod'`)
- Connection attempts (success and failure)
- Long-running queries (set `log_min_duration_statement = 5000` for queries over 5s)
- Administrative operations (schema changes, user management)

**Reviewing logs:**

```bash
# Find all modifications to a specific table in the last hour
grep "users" /var/log/postgresql/postgresql-15-main.log | grep -E "INSERT|UPDATE|DELETE"

# Find failed connection attempts
grep "FATAL" /var/log/postgresql/postgresql-15-main.log

# Find long-running queries
grep "duration" /var/log/postgresql/postgresql-15-main.log | awk -F'duration: ' '{print $2}' | sort -rn | head -20
```

### Encryption at rest

**PostgreSQL TDE options:**

PostgreSQL does not have built-in TDE (Transparent Data Encryption). Options:

1. **Filesystem-level encryption:**
   ```bash
   # LUKS (Linux)
   cryptsetup luksFormat /dev/sdb
   cryptsetup luksOpen /dev/sdb pgdata
   mkfs.ext4 /dev/mapper/pgdata
   mount /dev/mapper/pgdata /var/lib/postgresql/15/main
   ```

2. **Cloud provider KMS:**
   - **AWS RDS:** Enable encryption at creation time (uses AWS KMS)
   - **GCP Cloud SQL:** Enabled by default (uses Google-managed keys)
   - **Azure Database for PostgreSQL:** Enabled by default

3. **pg_tde extension** (third-party, for self-managed PostgreSQL):
   ```sql
   CREATE EXTENSION pg_tde;
   -- Encrypt specific tablespaces
   ```

## 11. Upgrades

**This section is critical. Always back up before upgrading.**

### Extension upgrades

**Upgrading the swamp extension itself:**

```bash
# Pull the latest version
swamp extension pull @svendowideit/postgres-datastore
swamp extension pull @svendowideit/postgres-model

# Verify the new version
swamp extension list | grep postgres
```

**What happens to existing data:**
- Extension upgrades do **not** modify existing tables or data
- The `periods` extension and versioning infrastructure remain intact
- New features become available immediately after the pull
- Schema migration logic may change — test on staging first

**Migration path between major versions:**

1. Take a full backup
2. Pull the new extension version
3. Run health check: `swamp datastore status`
4. Test basic operations on a non-critical table
5. If issues arise, pull the previous version and restore from backup

### PostgreSQL version upgrades

**pg_upgrade procedure:**

```bash
# 1. Install the new PostgreSQL version
apt-get install postgresql-16 postgresql-16-periods

# 2. Stop both clusters
pg_ctlcluster 15 main stop
pg_ctlcluster 16 main stop

# 3. Run pg_upgrade
pg_upgrade \
  --old-datadir=/var/lib/postgresql/15/main \
  --new-datadir=/var/lib/postgresql/16/main \
  --old-bindir=/usr/lib/postgresql/15/bin \
  --new-bindir=/usr/lib/postgresql/16/bin \
  --check  # dry run first

# 4. If check passes, run without --check
pg_upgrade \
  --old-datadir=/var/lib/postgresql/15/main \
  --new-datadir=/var/lib/postgresql/16/main \
  --old-bindir=/usr/lib/postgresql/15/bin \
  --new-bindir=/usr/lib/postgresql/16/bin

# 5. Start the new cluster
pg_ctlcluster 16 main start

# 6. Verify
psql -p 5433 -U swamp -d swamp -c "SELECT version();"
psql -p 5433 -U swamp -d swamp -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'periods';"
```

**Testing on a clone first:**

```bash
# Create a clone from backup
pg_restore -h localhost -U swamp -d swamp_clone latest_backup.dump

# Run pg_upgrade on the clone
pg_upgrade --old-datadir=... --new-datadir=... --check

# Verify all swamp operations work on the clone
swamp datastore status  # (point to clone)
```

**Downtime planning:**
- `pg_upgrade --link` mode: minutes (uses hard links, no data copy)
- `pg_upgrade` without `--link`: proportional to data size (copies all data)
- Plan for 30-60 minutes of downtime for a typical upgrade

### Schema upgrades

**How `swamp model method run <model> upgrade` works:**

1. Reads the stored schema from `table_metadata` resource
2. Converts both old and new JSON schemas to Zod objects
3. Diffs the schemas field-by-field
4. Applies changes in safe order (add nullable → add required → type changes → constraints → optionality → drops)
5. Backfills new required columns in batches
6. Updates the stored schema in `table_metadata`

**Before upgrading:**

1. **Take a backup** (see Section 8)
2. **Check current schema:**
   ```bash
   swamp model method run users query --args '{"tableName": "users", "limit": 1}'
   ```
3. **Check row count:**
   ```bash
   swamp model method run users query --args '{"tableName": "users", "where": "true", "limit": 1}'
   ```
4. **Test on staging** with a copy of production data

**After upgrading:**

1. **Verify the new schema:**
   ```bash
   psql -h localhost -U swamp -d swamp -c "\d swamp.users"
   ```
2. **Verify data integrity:**
   ```bash
   swamp model method run users query --args '{"tableName": "users", "limit": 10}'
   ```
3. **Check for NULLs in new required columns:**
   ```sql
   SELECT COUNT(*) FROM swamp.users WHERE new_column IS NULL;
   ```
4. **Verify historical queries still work:**
   ```bash
   swamp model method run users list_versions --args '{"tableName": "users"}'
   ```

### Rollback

**Rolling back a failed schema migration:**

**Option A: Restore from backup (safest)**
```bash
# Follow the restore procedure in Section 8
pg_restore -h localhost -U swamp -d swamp pre_upgrade_backup.dump
```

**Option B: Manual DDL rollback**

If the migration only added columns:
```sql
ALTER TABLE swamp.users DROP COLUMN new_column_1;
ALTER TABLE swamp.users DROP COLUMN new_column_2;
```

If the migration changed types:
```sql
ALTER TABLE swamp.users ALTER COLUMN name TYPE TEXT;
```

If the migration changed constraints:
```sql
ALTER TABLE swamp.users ALTER COLUMN email DROP NOT NULL;
```

**After rollback, restore the stored schema:**
```bash
# The stored schema in table_metadata still has the old schema
# (it's only updated on successful upgrade)
# Verify by running a query — it should work with the old schema
swamp model method run users query --args '{"tableName": "users", "limit": 1}'
```

## 12. Monitoring and Observability

### Health checks

```bash
# Datastore health check
swamp datastore status
# Returns: healthy, message, latencyMs, datastoreType, details (schema, periods availability)
```

The health check verifies:
- Database connectivity
- Schema existence
- `periods` extension availability

### PostgreSQL monitoring

**Connection count:**

```sql
SELECT COUNT(*) AS total_connections,
       COUNT(*) FILTER (WHERE state = 'active') AS active,
       COUNT(*) FILTER (WHERE state = 'idle') AS idle,
       COUNT(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_transaction
FROM pg_stat_activity;
```

**Lock contention:**

```sql
SELECT blocked_locks.pid AS blocked_pid,
       blocked_activity.usename AS blocked_user,
       blocking_locks.pid AS blocking_pid,
       blocking_activity.usename AS blocking_user,
       blocked_activity.query AS blocked_query,
       blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
  AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
  AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

**Replication lag (if using replicas):**

```sql
SELECT client_addr,
       state,
       sent_lsn,
       write_lsn,
       flush_lsn,
       replay_lsn,
       PG_WAL_LSN_DIFF(sent_lsn, replay_lsn) AS lag_bytes
FROM pg_stat_replication;
```

**Disk usage:**

```sql
SELECT schemaname,
       tablename,
       pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
       pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS table_size,
       pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) AS index_size
FROM pg_tables
WHERE schemaname = 'swamp'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;
```

### Version growth monitoring

Monitor the `_versions` table and history table sizes over time:

```sql
-- Version count per table
SELECT table_name,
       COUNT(*) AS version_count,
       MIN(timestamp) AS oldest_version,
       MAX(timestamp) AS newest_version
FROM swamp._versions
GROUP BY table_name
ORDER BY version_count DESC;

-- History table sizes
SELECT tablename,
       pg_size_pretty(pg_total_relation_size('swamp.' || tablename)) AS total_size,
       n_live_tup AS estimated_rows
FROM pg_stat_user_tables
WHERE schemaname = 'swamp' AND tablename LIKE '%_history'
ORDER BY pg_total_relation_size('swamp.' || tablename) DESC;
```

Set up a cron job to track growth:

```bash
# Daily version growth report
0 8 * * * psql -h localhost -U swamp -d swamp -c "
  SELECT table_name, COUNT(*) AS versions,
         pg_size_pretty(SUM(pg_total_relation_size('swamp.' || table_name || '_history'))) AS history_size
  FROM swamp._versions GROUP BY table_name;
" >> /var/log/swamp_version_growth.log
```

### Alerting

**What to alert on:**

| Condition | Threshold | Severity |
|---|---|---|
| Connection failures | Any | Critical |
| Lock timeouts | > 0 in 5 minutes | High |
| Replication lag | > 100MB or > 60 seconds | High |
| Disk space | < 20% free | High |
| Disk space | < 10% free | Critical |
| Connection pool utilization | > 80% | Medium |
| Version count per table | > 1000 | Medium (run GC) |
| History table size | > 10GB per table | Medium (run GC) |
| Query latency | > 5 seconds p99 | Medium |

**Example alerting script:**

```bash
#!/bin/bash
# Check disk space
DISK_USAGE=$(df /var/lib/postgresql/15/main | tail -1 | awk '{print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 80 ]; then
  echo "CRITICAL: PostgreSQL disk usage at ${DISK_USAGE}%"
  # Send alert via your monitoring system
fi

# Check replication lag
LAG=$(psql -h localhost -U swamp -d swamp -t -c "
  SELECT COALESCE(MAX(PG_WAL_LSN_DIFF(sent_lsn, replay_lsn)), 0)
  FROM pg_stat_replication;
")
if [ "$LAG" -gt 104857600 ]; then  # 100MB
  echo "WARNING: Replication lag at $(($LAG / 1048576))MB"
fi
```

## 13. Troubleshooting

### "periods extension is not installed"

**Symptom:** `swamp datastore status` returns `healthy: false` with message "periods extension is not installed".

**Cause:** The `periods` extension is not available in your PostgreSQL installation.

**Solution:**

```bash
# Debian/Ubuntu
apt-get install postgresql-15-periods

# RHEL/Rocky
dnf install periods_15

# Verify installation
psql -h localhost -U swamp -d swamp -c "SELECT * FROM pg_available_extensions WHERE name = 'periods';"

# Install manually if needed
psql -h localhost -U swamp -d swamp -c "CREATE EXTENSION IF NOT EXISTS periods;"
```

### Lock timeout errors

**Symptom:** `Lock timeout: could not acquire lock for '...' within 60000ms`.

**Cause:** Another process holds the advisory lock and hasn't released it.

**Solution:**

```sql
-- Check current locks
SELECT lock_key, holder, hostname, pid, acquired_at,
       EXTRACT(EPOCH FROM (NOW() - acquired_at)) * 1000 AS age_ms,
       ttl_ms
FROM swamp._locks
ORDER BY acquired_at;

-- If a lock is stale (age > ttl_ms), the next acquire attempt will clean it automatically
-- To force-release a specific lock:
SELECT pg_terminate_backend(<pid>);
DELETE FROM swamp._locks WHERE lock_key = <lock_key>;
```

**Prevention:**
- Ensure swamp operations complete (don't kill processes mid-operation)
- Increase `maxWaitMs` in lock options for long-running operations
- Check for network issues causing connection drops

### Connection pool exhaustion

**Symptom:** Operations fail with "too many clients" or timeout errors.

**Cause:** All connections in the pool are in use.

**Solution:**

```sql
-- Check current connections
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE state = 'idle') AS idle,
       COUNT(*) FILTER (WHERE state = 'active') AS active,
       COUNT(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx
FROM pg_stat_activity;

-- Check connection limit
SHOW max_connections;

-- Kill idle connections if needed
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND query_start < NOW() - INTERVAL '5 minutes';
```

**Prevention:**
- Increase `pool.maxConnections` in `.swamp.yaml`
- Increase PostgreSQL `max_connections` if needed
- Ensure swamp operations properly close connections (the model type does this automatically in `finally` blocks)

### Version query returns wrong data

**Symptom:** `query` with a `versionId` returns unexpected data.

**Cause:** The version timestamp may not align with when you expect the data to have changed. System versioning captures the exact moment of the transaction commit.

**Solution:**

```sql
-- Check the version timestamp
SELECT version_id, timestamp, message
FROM swamp._versions
WHERE table_name = 'users'
ORDER BY timestamp DESC;

-- Query directly with __as_of to verify
SELECT * FROM swamp.users__as_of('<timestamp>');

-- Check the history table for the expected data
SELECT *, row_start, row_end
FROM swamp.users_history
WHERE id = '<expected-id>'
ORDER BY row_start DESC;
```

### Schema migration fails

**Symptom:** `upgrade` method returns an error.

**Common causes and solutions:**

1. **"No stored schema found":** The table wasn't created with this model type. Use `import_table` for existing tables, or `create` for new ones.

2. **Type change fails:** The `USING` cast may fail if existing data can't be converted.
   ```sql
   -- Check for incompatible data
   SELECT column_name FROM swamp.users WHERE column_name !~ '^[0-9]+$';
   -- Fix data before retrying
   ```

3. **NOT NULL constraint fails:** Existing rows have NULL in the new column and no default was provided.
   ```sql
   -- Check for NULLs
   SELECT COUNT(*) FROM swamp.users WHERE new_column IS NULL;
   -- Provide a default in the schema or update NULLs manually
   ```

4. **Constraint violation:** Existing data violates a new CHECK constraint.
   ```sql
   -- Find violating rows
   SELECT * FROM swamp.users WHERE NOT (new_constraint_condition);
   ```

### Import table fails

**Symptom:** `import_table` returns "Table not found in information_schema".

**Cause:** The source schema or table name is incorrect, or the PostgreSQL user lacks permissions.

**Solution:**

```sql
-- Verify the table exists
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name = 'expected_table';

-- Check permissions
SELECT table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE table_name = 'expected_table' AND grantee = 'swamp';
```

## 14. Performance Tuning

### Connection pool sizing

The datastore uses two separate connection pools:

1. **Main pool** (`pool.maxConnections`, default 10): Used for data operations, queries, and schema management
2. **Lock pool** (fixed at 1 connection): Used exclusively for advisory lock acquisition

**Guidelines:**
- Start with `maxConnections: 10` and monitor
- Increase if you see "too many clients" errors
- Don't exceed 80% of PostgreSQL's `max_connections`
- The lock pool uses a dedicated connection — it doesn't count against the main pool

```yaml
pool:
  maxConnections: 20       # Increase for high-concurrency workloads
  idleTimeoutMs: 30000     # Lower to release idle connections faster
  connectTimeoutMs: 10000  # Increase for high-latency networks
```

### Batch size for migrations

Schema migrations backfill new required columns in batches:

```typescript
// Default: batchSize = 1000, batchDelayMs = 0
migrateSchema(sql, schema, tableName, oldSchema, newSchema, {
  batchSize: 500,       // Smaller batches for large rows or high load
  batchDelayMs: 100,    // Add delay between batches to reduce load
});
```

**Guidelines:**
- **Small tables (< 100K rows):** Default batch size (1000) is fine
- **Medium tables (100K - 1M rows):** Reduce to 500, add 50ms delay
- **Large tables (> 1M rows):** Reduce to 100, add 100ms delay, run during off-peak hours
- **Very large tables (> 10M rows):** Consider partitioning first, or migrate in stages

### Index recommendations

The extension auto-creates indexes on:
- Fields ending in `_id` or `_key`
- UUID, email, datetime, date, and enum fields

**Additional indexes to consider:**

```sql
-- Composite indexes for common query patterns
CREATE INDEX idx_users_role_created ON swamp.users (role, created_at DESC);

-- Partial indexes for filtered queries
CREATE INDEX idx_users_active ON swamp.users (email) WHERE role = 'admin';

-- Index on history table for common historical queries
CREATE INDEX idx_users_history_id_start ON swamp.users_history (id, row_start DESC);

-- BRIN index for append-only history tables (very space-efficient)
CREATE INDEX idx_users_history_brin ON swamp.users_history USING BRIN (row_start);
```

### VACUUM strategy for history tables

History tables grow continuously and are append-only (rows are never updated, only inserted and eventually deleted by GC). Standard autovacuum may not be sufficient.

```sql
-- Check bloat
SELECT schemaname, tablename,
       pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS size,
       n_dead_tup, n_live_tup,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
WHERE schemaname = 'swamp' AND tablename LIKE '%_history';

-- Manual VACUUM if needed
VACUUM ANALYZE swamp.users_history;

-- Aggressive autovacuum settings for history tables
ALTER TABLE swamp.users_history SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- Vacuum after 1% of rows are dead
  autovacuum_analyze_scale_factor = 0.005,  -- Analyze after 0.5% changes
  autovacuum_vacuum_cost_limit = 1000       -- Higher cost limit for faster vacuum
);
```

### Partitioning large history tables

For tables with high write volume, partition the history table by time range:

```sql
-- Create a partitioned history table (requires manual setup)
-- Note: This is an advanced technique. The periods extension creates
-- the history table automatically, so you'd need to:
-- 1. Create the table without versioning
-- 2. Manually set up the partitioned history table
-- 3. Enable versioning manually

-- Example: monthly partitions
CREATE TABLE swamp.events_history (
  LIKE swamp.events INCLUDING ALL
) PARTITION BY RANGE (row_start);

CREATE TABLE swamp.events_history_2026_01
  PARTITION OF swamp.events_history
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE swamp.events_history_2026_02
  PARTITION OF swamp.events_history
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
```

## 15. Architecture Internals

### Locking

The datastore uses PostgreSQL advisory locks (`pg_try_advisory_lock`) for distributed locking. Advisory locks are:

- **Connection-scoped:** The lock is held for the lifetime of the connection. If the connection drops, the lock is automatically released by PostgreSQL.
- **No heartbeat needed:** Unlike Redis or etcd-based locks, there's no need for a heartbeat or TTL refresh loop.
- **Fast:** Advisory locks are in-memory and don't touch tables.

**Lock acquisition flow:**

1. Try `pg_try_advisory_lock(lockKey)` — non-blocking
2. If acquired: insert/update the `_locks` metadata row, return
3. If not acquired: check the `_locks` table for the current holder
4. If the holder's lock is older than its TTL: terminate the holder's backend (`pg_terminate_backend`), delete the lock row, retry
5. If the holder is still alive: wait with jitter, retry
6. If `maxWaitMs` is exceeded: throw lock timeout error

**Lock metadata table:**

```sql
CREATE TABLE swamp._locks (
    lock_key    BIGINT PRIMARY KEY,
    holder      TEXT NOT NULL,       -- "user@hostname"
    hostname    TEXT NOT NULL,
    pid         INTEGER NOT NULL,    -- PostgreSQL backend PID
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ttl_ms      INTEGER NOT NULL,    -- Lock TTL in milliseconds
    nonce       TEXT                 -- Unique nonce for safe release
);
```

**Stale lock detection:**

The lock acquisition loop checks if a held lock has exceeded its TTL. If so, it terminates the holder's backend via `pg_terminate_backend` and deletes the lock row. This handles crashed processes that left stale locks.

**Lock release:**

- Normal release: `DELETE FROM _locks WHERE lock_key = $1 AND nonce = $2` — the nonce prevents accidentally releasing another process's lock
- Connection drop: PostgreSQL automatically releases the advisory lock
- Force release: `forceRelease(nonce)` terminates the backend and deletes the lock row

### Versioning

The `periods` extension provides SQL:2011 SYSTEM VERSIONING:

1. **`periods.add_system_time_period(table, 'row_start', 'row_end')`** — adds two TIMESTAMPTZ columns to track row validity periods
2. **`periods.add_system_versioning(table)`** — creates a `_history` table and installs triggers that automatically copy old row versions on UPDATE and DELETE

**How it works under the hood:**

- **INSERT:** New row gets `row_start = NOW()`, `row_end = 'infinity'`
- **UPDATE:** Old row is copied to `_history` with `row_end = NOW()`, new row gets `row_start = NOW()`, `row_end = 'infinity'`
- **DELETE:** Row is copied to `_history` with `row_end = NOW()`, removed from main table
- **SELECT:** Always returns rows where `row_end > NOW()` (current rows only)
- **`__as_of(timestamp)`:** Returns rows where `row_start <= timestamp AND row_end > timestamp`

**Version metadata:**

The `_versions` table stores metadata about each version snapshot. Versions are created explicitly by the model type after each `run` operation. The version timestamp is used to query historical data via `__as_of`.

### Schema management

**Zod introspection:**

The schema manager introspects Zod v4 types to extract:
- Type information (string, number, boolean, etc.)
- Format constraints (uuid, email, url, datetime)
- Validation rules (min, max, enum values)
- Optionality and nullability
- Default values

**DDL generation:**

From the introspected Zod schema, the manager generates:
- `CREATE TABLE` with appropriate column types
- `CHECK` constraints for validation rules
- `NOT NULL` constraints for required fields
- `DEFAULT` clauses for default values
- Indexes on commonly queried fields

**Diff algorithm:**

The `diffSchemas` function compares two Zod object schemas field-by-field and produces an ordered list of changes:

1. **Added columns** (nullable first, then required)
2. **Type changes** (with USING cast)
3. **Added constraints** (CHECK)
4. **Dropped constraints**
5. **Optionality changes** (NOT NULL ↔ nullable)
6. **Dropped columns** (last, to avoid data loss from intermediate failures)

### Model type

**JSON schema descriptors:**

The model type uses a simplified JSON schema format (not raw Zod) for portability. Descriptors are converted to Zod types internally:

```json
{
  "id": "string.uuid",
  "name": "string",
  "email": {"type": "string", "format": "email"},
  "age": {"type": "number", "format": "int", "min": 0},
  "role": {"type": "string", "optional": true, "default": "user"}
}
```

**Connection lifecycle:**

Each method call creates a fresh PostgreSQL connection, executes the operation, and closes the connection in a `finally` block. This ensures connections are never leaked, even on errors.

**Resource storage:**

The model type stores two resources in swamp's data layer:
- `table_metadata`: Stores the current schema for each table (used by `upgrade` to diff against)
- `result`: Stores the output of each method call (status, message, data)

## 16. Limitations and Known Issues

### `query` method's `where` parameter is raw SQL

The `where` parameter accepts a raw SQL fragment that is interpolated directly into the query string. This is a SQL injection risk. Always validate and sanitize user-supplied input before passing it to the `where` parameter. See [Security](#10-security) for mitigation strategies.

### UPDATE/DELETE requires a key field

The `run` method's `update` and `delete` operations require a key field to identify rows. The method prefers `id`, falling back to the first field in the record. If your table doesn't have an `id` field and the first field isn't unique, updates and deletes may affect unintended rows.

### Batched backfill is not transactional

During schema migration, the backfill of new required columns happens in batches outside of a transaction. If the migration fails mid-backfill:
- Rows backfilled before the failure remain backfilled
- Rows not yet backfilled remain NULL
- The `NOT NULL` constraint is not applied (the migration fails before reaching that step)

This means a failed migration leaves the table in an intermediate state. Always back up before running `upgrade`.

### `periods` extension compatibility

The `periods` extension is compatible with PostgreSQL 9.5 through 15. It is **not yet compatible with PostgreSQL 16+**. If you're running PostgreSQL 16 or later, system versioning will not work. Check the [periods extension repository](https://github.com/xocolatl/periods) for updates.

### No cross-table transactions

Each model method call operates on a single table within its own transaction. There is no way to perform atomic operations across multiple tables. If you need cross-table consistency, use PostgreSQL-level transactions outside of swamp.

### Imported read-only tables can't be versioned

Tables imported with `mode: "readonly"` cannot be versioned. The `periods` extension is not enabled on imported tables, and no history is tracked. Read-write imported tables allow data modifications but still don't have versioning enabled.

### Connection pool per method call

Each method call creates a fresh connection pool (size 1) and closes it after the call. This is intentional for isolation but means high-frequency calls will create and destroy connections rapidly. For high-throughput scenarios, consider batching operations.

### No native partitioning support

The extension does not automatically partition history tables. For very large tables with high write volume, you'll need to set up partitioning manually. See [Performance Tuning](#14-performance-tuning) for guidance.

## 17. License

MIT
