# DuckDB + DuckLake + Quack — Swamp Datastore Evaluation

## Summary

DuckDB combined with the DuckLake lakehouse format and the Quack client-server
protocol forms a compelling candidate for a swamp datastore. DuckLake provides
native snapshot versioning with time-travel queries, and Quack enables
multi-process concurrent read/write over HTTP.

---

## DuckDB

- **Website**: <https://duckdb.org/>
- **Source**: <https://github.com/duckdb/duckdb>
- **License**: MIT
- **Stars**: ~40,200
- **Language**: C++
- **Type**: In-process OLAP database

DuckDB is a high-performance analytical database designed to run embedded within
applications. It supports a rich SQL dialect with PostgreSQL compatibility,
columnar storage, and a powerful extension mechanism. Key features:

- Full SQL with window functions, CTEs, correlated subqueries, complex types
  (arrays, structs, maps, unions)
- PostgreSQL compatibility mode
- Columnar storage engine with vectorized execution
- Extensions for file formats (Parquet, CSV, JSON, Iceberg, Delta Lake, Excel),
  network protocols (HTTP/S3, PostgreSQL, MySQL, SQLite), and specialized
  features (spatial, full-text search, vector search)
- Clients for Python, R, Java, Node.js, Go, Rust, C/C++, Wasm, ODBC
- Single-file database or in-memory

## DuckLake

- **Website**: <https://ducklake.select/>
- **DuckDB extension docs**: <https://duckdb.org/docs/current/core_extensions/ducklake>
- **License**: MIT
- **Released**: 1.0 in April 2026
- **Type**: Lakehouse table format (like Iceberg or Delta Lake, but DuckDB-native)

DuckLake is a lakehouse table format designed for DuckDB. It stores data as
Parquet files on object storage (local, S3, GCS, Azure) with a DuckDB-backed
metadata catalog. Key features:

- **Native snapshot versioning**: every write automatically creates a snapshot
- **Time-travel queries**: `SELECT * FROM t AT (VERSION => n)` or `AT (TIMESTAMP => ...)`
- **Snapshot listing**: `ducklake_snapshots()` function
- **Row-level change tracking**: `ducklake_table_changes()` returns inserts/deletes between snapshots
- **Built-in GC**: `ducklake_expire_snapshots()` prunes old versions
- **Schema evolution**: `ALTER TABLE` support with versioned schema history
- **Data inlining**: small tables can be stored directly in the metadata catalog
- **Partitioning**, sorted tables, upserting, conflict resolution
- **Row lineage**: track which snapshot created each row
- **Data change feed**: CDC-like stream of changes

### DuckLake Versioning Model

```sql
-- Create a DuckLake database
ATTACH 'ducklake:swamp.ducklake' AS swamp (DATA_PATH './swamp_data');
USE swamp;

-- Every write automatically creates a snapshot
CREATE TABLE servers (id BIGINT, name VARCHAR, region VARCHAR);
INSERT INTO servers VALUES (1, 'web-01', 'us-east-1');
UPDATE servers SET region = 'eu-west-1' WHERE id = 1;
DELETE FROM servers WHERE id = 1;

-- List all snapshots (versions)
SELECT * FROM ducklake_snapshots('swamp');
-- Returns: snapshot_id, snapshot_time, schema_version, changes

-- Time-travel to any snapshot
SELECT * FROM servers AT (VERSION => 3);
SELECT * FROM servers AT (TIMESTAMP => '2026-08-12 10:30:00');

-- Row-level changes between snapshots
SELECT * FROM ducklake_table_changes('swamp', 'main', 'servers', 1, 5);
-- Returns: snapshot_id, rowid, change_type (insert/delete), plus all table columns

-- Row insertions between snapshots
SELECT * FROM ducklake_table_insertions('swamp', 'main', 'servers', 1, 5);

-- Row deletions between snapshots
SELECT * FROM ducklake_table_deletions('swamp', 'main', 'servers', 1, 5);

-- GC old snapshots
CALL ducklake_expire_snapshots('swamp', older_than => NOW() - INTERVAL '30 days');

-- Maintenance operations
CALL ducklake_merge_adjacent_files('swamp');
CALL ducklake_cleanup_old_files('swamp');
```

### DuckLake Limitations

- **No indexes** — DuckLake does not support B-tree, hash, or any index types
- **No primary keys** — uniqueness must be enforced in the application layer
- **No foreign keys** — referential integrity must be enforced in the application layer
- **No UNIQUE or CHECK constraints** — all constraints must be enforced in the application layer
- **No cross-table atomic transactions** — each table write is independently versioned
- **No Postgres wire protocol** — uses DuckDB's own SQL dialect and client libraries

## Quack

- **Website**: <https://duckdb.org/quack/>
- **Docs**: <https://duckdb.org/docs/current/quack/overview>
- **Announcement**: <https://duckdb.org/2026/05/12/quack-remote-protocol.html>
- **License**: MIT
- **Released**: Beta in May 2026 (DuckDB v1.5.3), targeting production with DuckDB v2.0 (fall 2026)
- **Type**: Client-server protocol for DuckDB over HTTP

Quack turns a DuckDB instance into a server that other DuckDB instances (clients)
can connect to over HTTP. Key features:

- **HTTP-based**: standard HTTP/HTTPS, works with load balancers, firewalls, reverse proxies
- **Single round-trip per query**: after handshake, one request-response pair per query
- **`application/duckdb` serialization**: uses DuckDB's internal WAL serialization primitives
- **Concurrent multi-process read/write**: multiple clients can attach to the same server
- **Authentication**: token-based with pluggable auth callbacks (LDAP, custom SQL macros, etc.)
- **Authorization**: pluggable per-query authorization callbacks
- **Connection caching**: reuse HTTP connections across requests
- **Default port**: 9494

### Quack Benchmarks

**Bulk transfer** (60M TPC-H lineitem rows, 76 GB CSV):
| Rows | DuckDB Quack | Arrow Flight | PostgreSQL |
|------|-------------|-------------|-----------|
| 100k | 0.07s | 0.07s | 0.20s |
| 1M | 0.24s | 0.38s | 2.20s |
| 10M | 0.89s | 2.90s | 25.64s |
| 60M | 4.94s | 17.40s | 158.37s |

**Small writes** (transactions/second, 5s runs):
| Threads | DuckDB Quack | Arrow Flight | PostgreSQL |
|---------|-------------|-------------|-----------|
| 1 | 1,038 tx/s | 469 tx/s | 839 tx/s |
| 2 | 1,956 tx/s | 799 tx/s | 1,094 tx/s |
| 4 | 3,504 tx/s | 1,224 tx/s | 2,180 tx/s |
| 8 | 5,434 tx/s | 1,358 tx/s | 4,320 tx/s |

### Quack Server Setup

```sql
-- Server side (one DuckDB process, persistent)
INSTALL ducklake; LOAD ducklake;
INSTALL quack; LOAD quack;
ATTACH 'ducklake:swamp.ducklake' AS swamp (DATA_PATH './swamp_data');
CALL quack_serve('quack:localhost:9494', token => 'swamp-secret-token');

-- Client side (swamp extension connects here)
ATTACH 'quack:localhost:9494' AS remote (TOKEN 'swamp-secret-token');

-- Remote tables behave like local ones
CREATE TABLE remote.main.servers (id BIGINT, name VARCHAR);
INSERT INTO remote.main.servers VALUES (1, 'web-01');
SELECT * FROM remote.main.servers;

-- Ad-hoc queries scoped to the remote attachment
FROM remote.query('SELECT * FROM servers AT (VERSION => 3)');
```

### Quack Limitations

- **Beta**: protocol, function names, settings, and defaults still subject to change
- **No auto-install/auto-load yet**: must explicitly `INSTALL quack; LOAD quack;`
- **No replication protocol yet**: planned for future
- **Transaction scaling**: hits a limit around 8 concurrent writer threads (DuckDB core limitation, being worked on)

---

## Architecture for Swamp

```
┌──────────────────────────────────────────────────┐
│  Swamp Core (model create, method run, data q)   │
├──────────────────────────────────────────────────┤
│  DatastoreProvider (locks, sync, health)         │
├──────────────────────────────────────────────────┤
│  Schema Manager (Zod→DDL, versioning, migrate)   │
├──────────────────────────────────────────────────┤
│  DuckDB Adapter (Quack client, DuckLake ops)     │
├──────────────────────────────────────────────────┤
│  DuckDB Node.js client (@duckdb/node-api)        │
└──────────────────┬───────────────────────────────┘
                   │ Quack protocol (HTTP)
┌──────────────────▼───────────────────────────────┐
│  DuckDB Server Process (Quack + DuckLake)        │
│  - Persistent DuckDB instance                    │
│  - DuckLake catalog attached                     │
│  - Quack server listening on :9494              │
│  - Data stored as Parquet files on disk/S3       │
└──────────────────────────────────────────────────┘
```

The swamp datastore extension connects to a DuckDB Quack server as a client.
Model schemas map to DuckDB tables within a DuckLake catalog. Versioning is
handled natively by DuckLake snapshots — no triggers, no history tables, no
application-layer version tracking.

### Versioning Adapter Mapping

| Swamp operation | DuckLake equivalent |
|----------------|-------------------|
| `createVersion` | Automatic — every write creates a snapshot |
| `getCurrentRows` | `SELECT * FROM t` (latest snapshot) |
| `getRowsAtVersion` | `SELECT * FROM t AT (VERSION => n)` |
| `listVersions` | `SELECT * FROM ducklake_snapshots('catalog')` |
| `pruneVersions` | `CALL ducklake_expire_snapshots('catalog', ...)` |
| Row-level diff | `SELECT * FROM ducklake_table_changes('catalog', 'schema', 'table', v1, v2)` |

### Schema Migration

DuckLake supports schema evolution natively:
```sql
ALTER TABLE servers ADD COLUMN environment VARCHAR;
ALTER TABLE servers DROP COLUMN old_field;
ALTER TABLE servers RENAME COLUMN name TO hostname;
```

Schema changes are themselves versioned — old snapshots keep the old schema.
No need to temporarily disable versioning or manually alter history tables.

### Locking

DuckDB/Quack doesn't have native advisory locks like PostgreSQL. The swamp
extension would need to implement distributed locking at the application layer:
- Use a dedicated `_locks` table in DuckLake with conditional writes
- Or use an external lock service (Redis, etc.)
- Or rely on DuckLake's optimistic concurrency with conflict resolution

### Multi-Database / Multi-Credential

Multiple DuckLake catalogs can be attached to the same Quack server:
```sql
ATTACH 'ducklake:aws_inventory.ducklake' AS aws (DATA_PATH './aws_data');
ATTACH 'ducklake:kubernetes.ducklake' AS k8s (DATA_PATH './k8s_data');
```

Different Quack servers can be used for different model types, each with their
own authentication tokens.

---

## Evaluation

| Criterion | Assessment |
|-----------|-----------|
| **Native versioning** | ★★★★★ DuckLake snapshots are automatic, time-travel is native SQL syntax, row-level change tracking is built-in. No triggers, no history tables, no application code needed. |
| **Schema mapping** | ★★★★☆ Full SQL DDL. DuckDB types map well to Zod types. Missing: indexes, PKs, FKs, UNIQUE/CHECK constraints — must enforce in extension layer. |
| **Schema migration** | ★★★★★ Native schema evolution. `ALTER TABLE` works directly. Old snapshots preserve old schema. No manual history table management. |
| **Maturity** | ★★☆☆☆ DuckLake 1.0 is 4 months old (April 2026). Quack is 3 months old and beta (May 2026). DuckDB itself is mature (40k stars, production). |
| **Self-host** | ★★★★☆ Single DuckDB binary + extensions. Docker available. Need to manage the server process separately from swamp. |
| **Managed** | ★☆☆☆☆ No managed DuckLake or Quack offering. MotherDuck is a managed DuckDB service but doesn't support DuckLake/Quack yet. |
| **PG compatibility** | ★★☆☆☆ DuckDB has PostgreSQL compatibility mode for SQL syntax, but uses its own Quack protocol (HTTP), not the Postgres wire protocol. Different client libraries. |
| **Concurrency** | ★★★★☆ Quack enables multi-process read/write. Benchmarks show 5,434 tx/s at 8 threads. Single round-trip per query. |
| **Performance** | ★★★★★ 60M rows in 4.94s (bulk transfer). Beats PostgreSQL on both bulk and small writes. Columnar engine with vectorized execution. |
| **License** | ★★★★★ MIT for DuckDB, DuckLake, and Quack. Fully open source. |

### Pros

- **Best versioning model**: DuckLake snapshots are the closest match to swamp's
  "native database versioning" vision — automatic, queryable, garbage-collectable
- **No versioning code to write**: no triggers, no history tables, no
  application-layer version tracking
- **Row-level change tracking**: `ducklake_table_changes()` gives exact diffs
  between versions
- **Fast**: columnar engine, vectorized execution, efficient bulk transfers
- **MIT license**: fully open source, no restrictions
- **Schema evolution**: native `ALTER TABLE` with versioned schema history
- **Extensible**: DuckDB's extension ecosystem (Postgres connector, Iceberg,
  Delta Lake, spatial, etc.)

### Cons

- **Very new**: DuckLake 1.0 (April 2026), Quack beta (May 2026). Combined
  maturity is low.
- **No constraints**: must enforce PKs, FKs, UNIQUE, CHECK in the extension layer
- **No Postgres wire protocol**: requires DuckDB client libraries, not standard
  Postgres tooling
- **Separate server process**: DuckDB Quack server must run alongside swamp,
  not embedded in the Deno extension
- **No cross-table atomic transactions**: each table write is independently
  versioned in DuckLake
- **No advisory locks**: distributed locking must be implemented at the
  application layer
- **Quack is beta**: protocol may change before v2.0 production release

### Swamp Fit: ★★★★☆

DuckDB + DuckLake + Quack is architecturally the closest match to the original
vision of "native database versioning mapped to swamp versioning." The snapshot
model eliminates all versioning code from the extension. The main risks are
maturity (both DuckLake and Quack are very new) and the need to enforce
constraints in the extension layer.

---

## Complementary Roles

Even if not chosen as the primary datastore, DuckDB has valuable complementary
roles in a swamp ecosystem:

1. **Analytical queries over version history**: DuckDB's `postgres` extension
   can query swamp data stored in PostgreSQL for fast historical analysis.
   Example: "show me all changes to this model over the last 30 days" using
   DuckDB's columnar engine over Postgres data.

2. **Archival format for old versions**: DuckLake's snapshot model and Parquet
   storage make it ideal for archiving old swamp data versions. Move versions
   older than N days from PostgreSQL to DuckLake for cost-effective long-term
   storage with queryability.

3. **Cross-model analytics**: DuckDB can join data across multiple swamp models
   (potentially across different databases) for reporting and analysis.

4. **Data export**: DuckDB can export swamp data to Parquet, CSV, JSON, Iceberg,
   Delta Lake, Excel, and other formats for interoperability.

---

## Existing Implementation: `@zocc/duckdb`

- **Source**: <https://github.com/CCAgentOrg/swamp-zocc-extensions/tree/main/datastore/duckdb>
- **Type**: `@zocc/duckdb` (model) + `@zocc/duckdb-datastore` (datastore)
- **License**: Apache 2.0
- **Status**: Published, ships under OpenFlaw Manifesto

This is a **working DuckDB integration for swamp** — but it solves a
fundamentally different problem than what DUCKDB_IDEAS.md envisions.

### What it does

**Model component (`@zocc/duckdb`)** — a swamp model type that provides SQL
query methods against DuckDB database files:

- `list_tables` — list tables with column names, types, and nullability
- `query` — execute arbitrary SQL and return structured results
- `summarize` — quick overview with row counts per table
- `import_data` — load CSV, JSON, NDJSON, or Parquet into a DuckDB table
- `export_data` — export query results or tables to CSV, JSON, or Parquet

**Datastore component (`@zocc/duckdb-datastore`)** — a swamp datastore
provider that stores swamp's runtime files in a DuckDB database:

```yaml
# .swamp.yaml
datastore:
  type: "@zocc/duckdb-datastore"
  config:
    database: "/path/to/swamp-data.duckdb"
    schema: "swamp"
```

### Architecture

```
┌──────────────────────────────────────────┐
│  Swamp Core                              │
├──────────────────────────────────────────┤
│  @zocc/duckdb (model)                    │
│  - list_tables, query, summarize         │
│  - import_data, export_data              │
│  - Shells out to `duckdb` CLI binary     │
├──────────────────────────────────────────┤
│  @zocc/duckdb-datastore (datastore)      │
│  - File-based locking (nonce, 5s TTL)    │
│  - Stores swamp files in DuckDB tables   │
└──────────────────┬───────────────────────┘
                   │ subprocess (duckdb CLI)
┌──────────────────▼───────────────────────┐
│  DuckDB (embedded, single-file)          │
│  - No DuckLake, no Quack, no server mode │
│  - Single-process, file-locked           │
└──────────────────────────────────────────┘
```

### What it does NOT do (and DUCKDB_IDEAS.md envisions)

| Feature | `@zocc/duckdb` | DUCKDB_IDEAS.md vision |
|---------|---------------|------------------------|
| **DuckLake snapshot versioning** | No — plain DuckDB tables, no snapshots | Yes — `AT (VERSION => n)` time-travel, `ducklake_snapshots()`, built-in GC |
| **Quack client-server** | No — subprocess CLI, single-process | Yes — Quack server with multi-process concurrent read/write over HTTP |
| **Model schema → table mapping** | No — model is a SQL query tool, not a schema manager | Yes — Zod→DDL mapping, typed tables per model |
| **Data versioning** | No — plain tables, no history | Yes — native DuckLake snapshots on every write |
| **In-process DuckDB** | No — shells out to `duckdb` CLI binary (~50-100ms overhead per call) | Yes — `@duckdb/node-api` for direct in-process access |
| **Connection pooling** | No — each query spawns a new CLI process | Yes — persistent Quack connections with HTTP connection caching |

### Relationship to DUCKDB_IDEAS.md

The existing extension is a **pragmatic, working tool** — it lets swamp
workflows query and manipulate DuckDB databases using the CLI. It's a model
type for data analysis, not a versioned datastore. DUCKDB_IDEAS.md describes
a much more ambitious architecture (DuckLake snapshots, Quack server mode,
schema-to-table mapping) that doesn't exist yet.

The two are at completely different levels:

```
@zocc/duckdb (exists):              DUCKDB_IDEAS.md (research):
┌──────────────────────┐            ┌──────────────────────────┐
│  Model: SQL queries   │            │  Schema Manager          │
│  via duckdb CLI       │            │  (Zod→DDL, versioning)   │
├──────────────────────┤            ├──────────────────────────┤
│  Datastore: file      │            │  DuckDB Adapter           │
│  storage in DuckDB    │            │  (Quack client, DuckLake) │
└──────────────────────┘            ├──────────────────────────┤
                                    │  DuckDB Server Process    │
                                    │  (Quack + DuckLake)       │
                                    └──────────────────────────┘
```

### Known flaws (self-documented)

The extension ships under the [OpenFlaw Manifesto](https://ccagentorg.github.io/OpenFlaw/)
and honestly documents its limitations:

- **Subprocess overhead**: every query spawns `duckdb` CLI (~50-100ms latency)
- **No connection pooling**: concurrent queries serialize through CLI invocations
- **File-lock contention**: multi-process writes may retry on lock collision
- **Large result set truncation**: `limit=0` can OOM on huge tables
- **No in-process DuckDB**: requires CLI binary on PATH

---

## References

- DuckDB: <https://github.com/duckdb/duckdb> | <https://duckdb.org/>
- DuckLake: <https://ducklake.select/> | <https://github.com/duckdb/ducklake>
- Quack: <https://duckdb.org/quack/> | <https://github.com/duckdb/duckdb-quack>
- Quack announcement: <https://duckdb.org/2026/05/12/quack-remote-protocol.html>
- DuckLake 1.0 announcement: <https://ducklake.select/2026/04/13/ducklake-10/>
- DuckDB Node.js client: <https://duckdb.org/docs/current/clients/node_neo/overview>
- DuckDB PostgreSQL extension: <https://duckdb.org/docs/current/core_extensions/postgres/overview>
