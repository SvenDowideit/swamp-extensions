# Swamp PostgreSQL Datastore Extension — Research & Implementation Plan

## Summary

A swamp datastore extension that uses PostgreSQL as the storage backend, with
native database versioning mapped to swamp's data versioning semantics. Swamp
model schemas (Zod) map directly to table schemas (DDL), and schema changes
trigger gradual, in-place row migration.

---

## 1. Backend Evaluation

Seven backend configurations were evaluated against these criteria:

1. **Native versioning** — does the DB have built-in versioning that maps to
   swamp's "latest version is current, query at version is history" model?
2. **Schema mapping** — can Zod schemas be mapped to DDL with constraints?
3. **Schema migration** — can schema changes be applied with gradual row
   migration?
4. **Maturity** — production-grade or beta?
5. **Self-host** — can it run on our own infrastructure?
6. **Managed** — is there a managed cloud offering?
7. **Postgres compatibility** — wire protocol, SQL dialect, extension ecosystem?

### Config A: DoltgreSQL

- **Website**: <https://www.doltgres.com/>
- **Source**: <https://github.com/dolthub/doltgresql>
- **License**: Apache 2.0
- **Stars**: ~2,100
- **Language**: Go

| Criterion | Assessment |
|-----------|-----------|
| **Native versioning** | ★★★★★ Git-like: `dolt_commit` = swamp version, `SELECT * FROM t` = HEAD, `AS OF` = history. `dolt.log`, `dolt.status`, branching/merging. Perfect semantic match. |
| **Schema mapping** | ★★★★★ Standard Postgres DDL. `CREATE TABLE`, `ALTER TABLE` work as expected. |
| **Schema migration** | ★★★★☆ DoltgreSQL tracks schema changes in commit history. Gradual row migration via batched `UPDATE`. Schema changes are themselves versioned. |
| **Maturity** | ★★☆☆☆ Beta. 91% sqllogictest correctness (4.7M/5.7M tests pass). ~5x slower reads, ~3.6x slower writes vs vanilla PG. No extension support. No DoltHub push yet. |
| **Self-host** | ★★★★★ Docker image, single binary (`doltgres`). Trivial to run. |
| **Managed** | ★☆☆☆☆ No managed offering. DoltHub push not yet supported for DoltgreSQL. |
| **PG compatibility** | ★★★★☆ Postgres wire protocol. Most SQL works. Missing: extensions, GSSAPI, some types/functions. |

**Verdict**: Best semantic fit for swamp versioning. The `dolt_commit`/`dolt.log`/`AS OF` model maps 1:1 to swamp's versioning. Risk is beta quality and performance gap. Worth targeting as a future backend once it stabilizes.

**Key versioning operations**:
```sql
-- Create a version (commit)
SELECT dolt_commit('-m', 'method run: sync servers');

-- Query current state (HEAD)
SELECT * FROM servers;

-- Query at a specific version
SELECT * FROM servers AS OF 'peqq98e2dl5gscvfvic71e7j6ne34533';

-- List versions (commit log)
SELECT * FROM dolt.log;

-- Branch for parallel work
SELECT dolt_branch('experiment');

-- Merge branch back
SELECT dolt_merge('experiment');
```

**Performance benchmarks** (DoltgreSQL v0.50.0 vs PostgreSQL):
- Reads: 6.3x mean multiplier (range: 2.8x–13.3x depending on query type)
- Writes: 3.6x mean multiplier (range: 3.1x–4.8x)
- Overall: 5.2x mean multiplier

**Correctness** (sqllogictest, v0.50.0):
- 5,691,305 total tests
- 5,188,604 OK (91.17%)
- 411,415 not OK
- 91,270 did not run
- 16 timeout

**Limitations** (from README):
- No Git-style CLI for version control (SQL interface only)
- Can't push to DoltHub or DoltLab (custom remotes only: filesystem, S3)
- Backup and replication are a work in progress
- No GSSAPI support
- No extension support
- Some Postgres syntax, types, functions, and features not yet implemented

### Config B: Vanilla PostgreSQL + System-Versioned Tables (self-hosted)

- **Website**: <https://www.postgresql.org/>
- **Source**: <https://git.postgresql.org/>
- **License**: PostgreSQL License (BSD-like)
- **Language**: C

| Criterion | Assessment |
|-----------|-----------|
| **Native versioning** | ★★★☆☆ Manual implementation: `sys_period TSTZRANGE` column + `BEFORE UPDATE` trigger that moves old rows to history. Current = `WHERE upper_inf(sys_period)`. History = `WHERE sys_period @> ts`. Well-understood SQL:2011 pattern. |
| **Schema mapping** | ★★★★★ Standard Postgres DDL. Full control. All constraints, indexes, types. |
| **Schema migration** | ★★★★☆ `ALTER TABLE` + batched `UPDATE` with trigger temporarily disabled. History rows keep old schema (system-versioned tables handle this naturally). |
| **Maturity** | ★★★★★ Production-grade. Every feature works. Full extension ecosystem (pgvector, PostGIS, etc.). |
| **Self-host** | ★★★★★ Docker, apt, any distro. Trivial. |
| **Managed** | ★★★★★ Works on RDS, Cloud SQL, Supabase, Neon, Crunchy, Aiven, etc. |
| **PG compatibility** | ★★★★★ Real PostgreSQL. |

**Verdict**: Safest, most portable choice. Versioning is DIY but the pattern is well-understood and battle-tested. Works everywhere. Recommended as the primary target.

**System-versioned table implementation** (SQL:2011 temporal pattern):

```sql
-- Main table with system-period column
CREATE TABLE servers (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    region VARCHAR(20) NOT NULL,
    tags JSONB DEFAULT '[]',
    metadata JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sys_period TSTZRANGE NOT NULL DEFAULT tstzrange(NOW(), NULL, '[)')
);

-- History table (same columns, no constraints except NOT NULL on versioning columns)
CREATE TABLE servers_history (
    LIKE servers INCLUDING DEFAULTS,
    version_id UUID NOT NULL,
    version_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: on UPDATE, move old row to history
CREATE OR REPLACE FUNCTION version_servers()
RETURNS TRIGGER AS $$
BEGIN
    -- Close the current row's validity period
    NEW.sys_period = tstzrange(NOW(), NULL, '[)');
    -- Move old row to history
    INSERT INTO servers_history
    SELECT OLD.*, current_setting('swamp.version_id')::UUID, NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER servers_versioning
    BEFORE UPDATE ON servers
    FOR EACH ROW EXECUTE FUNCTION version_servers();

-- Query current rows
SELECT * FROM servers WHERE upper_inf(sys_period);

-- Query at a specific version
SELECT * FROM servers_history
WHERE sys_period @> '2026-08-12T10:30:00Z'::TIMESTAMPTZ;

-- Query at a specific version ID
SELECT * FROM servers_history WHERE version_id = 'abc123...';
```

**References**:
- PostgreSQL temporal tables documentation: <https://www.postgresql.org/docs/current/ddl-system-versioning.html> (PG 17+)
- SQL:2011 system-versioned tables: ISO/IEC 9075:2011
- Temporal data in PostgreSQL blog series: <https://www.2ndquadrant.com/en/blog/temporal-data-postgresql-1/>

### Config C: Vanilla PostgreSQL + System-Versioned Tables (managed)

Same as Config B, but database is managed (RDS, Cloud SQL, etc.). The extension
only needs a connection string. No operational burden. Same recommendation.

Managed PostgreSQL providers that support custom triggers and extensions:
- **AWS RDS for PostgreSQL**: <https://aws.amazon.com/rds/postgresql/>
- **Google Cloud SQL for PostgreSQL**: <https://cloud.google.com/sql/postgresql>
- **Supabase**: <https://supabase.com/> (managed PG + extensions + realtime)
- **Neon**: <https://neon.com/> (serverless PG with branching)
- **Crunchy Bridge**: <https://www.crunchydata.com/products/crunchy-bridge>
- **Aiven for PostgreSQL**: <https://aiven.io/postgresql>
- **Tembo**: <https://tembo.io/> (PG with extension marketplace)

### Config D: XTDB

- **Website**: <https://xtdb.com/>
- **Source**: <https://github.com/xtdb/xtdb>
- **License**: MPL 2.0
- **Stars**: ~3,000
- **Language**: Clojure/Java

| Criterion | Assessment |
|-----------|-----------|
| **Native versioning** | ★★★★★ Native bitemporal: `FOR SYSTEM_TIME AS OF` (SQL:2011 standard). Immutable by design. Every row has system-time validity. Also supports valid-time (business time). Most sophisticated versioning model of all candidates. |
| **Schema mapping** | ★★☆☆☆ Dynamic schema — no strict DDL. Documents (rows) can have arbitrary nested data. Conflicts with strict Zod→DDL mapping. Schema enforcement would need to happen in the extension layer, not the DB. |
| **Schema migration** | ★★★☆☆ Schema changes are implicit (new columns appear in new rows). No `ALTER TABLE` needed. But this means swamp can't enforce schema at DB level — validation must happen in the extension. |
| **Maturity** | ★★★★☆ Production. 3k stars. Used in finance/compliance. JVM-based (Java/Clojure). |
| **Self-host** | ★★★☆☆ JVM + object storage. More complex than PG. Docker available. |
| **Managed** | ★★★☆☆ XTDB Cloud available. Smaller ecosystem than PG managed services. |
| **PG compatibility** | ★★★☆☆ Postgres wire protocol. SQL dialect is XTQL (extends SQL:2011). Not a Postgres fork — different engine. |

**Verdict**: Best versioning model (bitemporal > git-like for data auditing). Dynamic schema is a fundamental mismatch for strict Zod→DDL mapping. Would require schema enforcement in the extension layer, losing the benefit of DB-level constraints. Better suited for document-oriented use cases.

**Key versioning operations**:
```sql
-- Query current state
SELECT * FROM servers;

-- Query at a specific system time
SELECT * FROM servers FOR SYSTEM_TIME AS OF TIMESTAMP '2026-08-12T10:30:00Z';

-- Query over a time range (all versions between two timestamps)
SELECT * FROM servers
FOR SYSTEM_TIME FROM TIMESTAMP '2026-08-01T00:00:00Z'
TO TIMESTAMP '2026-08-12T00:00:00Z';

-- Bitemporal query (system time + valid time)
SELECT * FROM servers
FOR SYSTEM_TIME AS OF TIMESTAMP '2026-08-12T10:30:00Z'
FOR VALID_TIME AS OF TIMESTAMP '2026-08-10T00:00:00Z';
```

**Architecture**: XTDB uses a log as the central point of coordination (Kleppmann's "turning the database inside out" model). The columnar engine is built on Apache Arrow and designed for object storage. It speaks both SQL and XTQL over the Postgres wire protocol.

**References**:
- XTDB documentation: <https://docs.xtdb.com/>
- Bitemporal data model: <https://docs.xtdb.com/concepts/bitemporality/>
- Architecture: <https://xtdb.com/inside-out/>
- Martin Kleppmann's "Turning the database inside out": <https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/>

### Config E: CockroachDB

- **Website**: <https://www.cockroachlabs.com/>
- **Source**: <https://github.com/cockroachdb/cockroach>
- **License**: BSL (Business Source License) / Apache 2.0 for older versions
- **Stars**: ~30,000+
- **Language**: Go

| Criterion | Assessment |
|-----------|-----------|
| **Native versioning** | ★★★★☆ Native MVCC: `SELECT * FROM t AS OF SYSTEM TIME '-30s'`. Time-travel queries built in. Not as ergonomic as DoltgreSQL's commit model, but works. |
| **Schema mapping** | ★★★★★ Postgres-compatible DDL. `CREATE TABLE`, `ALTER TABLE` with online schema changes (no locking). |
| **Schema migration** | ★★★★★ Online schema changes are a first-class feature. No downtime for `ALTER TABLE`. Gradual row migration via batched updates. |
| **Maturity** | ★★★★★ Production. 30k+ stars. Distributed by default (Raft consensus). |
| **Self-host** | ★★★★☆ Single binary or Kubernetes. More complex than vanilla PG but well-documented. |
| **Managed** | ★★★★★ CockroachDB Cloud (Serverless + Dedicated). Free tier available. |
| **PG compatibility** | ★★★★☆ Postgres wire protocol. Most SQL works. Some PG-specific features missing (no extensions, some types). |

**Verdict**: Strong contender. Native time-travel, online schema changes, distributed resilience. The `AS OF SYSTEM TIME` model is a good fit for swamp versioning. The distributed nature adds operational complexity but also resilience. Good secondary target.

**Key versioning operations**:
```sql
-- Query current state
SELECT * FROM servers;

-- Query at a specific point in time (MVCC time travel)
SELECT * FROM servers AS OF SYSTEM TIME '-30s';

-- Query at an absolute timestamp
SELECT * FROM servers AS OF SYSTEM TIME '2026-08-12 10:30:00';

-- Query with bounded staleness (within last 5 seconds)
SELECT * FROM servers AS OF SYSTEM TIME experimental_follower_read_timestamp();

-- Online schema change (no table locking)
ALTER TABLE servers ADD COLUMN environment VARCHAR(50);
-- CockroachDB performs this as a background operation with zero downtime
```

**Online schema changes**: CockroachDB's schema changes are online by default — they don't block reads or writes. The schema change runs as a background job that backfills any new columns across all rows. This is a significant advantage for gradual row migration.

**References**:
- CockroachDB `AS OF SYSTEM TIME`: <https://www.cockroachlabs.com/docs/stable/as-of-system-time>
- Online schema changes: <https://www.cockroachlabs.com/docs/stable/online-schema-changes>
- MVCC architecture: <https://www.cockroachlabs.com/docs/stable/architecture/storage-layer#mvcc>

### Config F: Neon

- **Website**: <https://neon.com/>
- **Source**: <https://github.com/neondatabase/neon>
- **License**: Apache 2.0
- **Stars**: ~22,800
- **Language**: Rust

| Criterion | Assessment |
|-----------|-----------|
| **Native versioning** | ★★☆☆☆ Database branching: each swamp version = a Neon branch. `SELECT * FROM t` on branch = that version's data. Branching is designed for dev/test isolation, not data versioning. No branch merge. Each version = separate database endpoint. Awkward for "latest version is current" model. |
| **Schema mapping** | ★★★★★ Standard Postgres DDL. |
| **Schema migration** | ★★☆☆☆ Schema changes on a branch, then... merge? Neon branching doesn't have a merge operation. Each branch is an independent database. Schema changes would need to be applied to the parent branch separately. |
| **Maturity** | ★★★★★ Production. 22.8k stars. Now part of Databricks. |
| **Self-host** | ★★☆☆☆ Possible but complex: pageserver + safekeeper + compute (all Rust). Designed as a cloud service. |
| **Managed** | ★★★★★ Neon cloud (free tier available). Excellent developer experience. |
| **PG compatibility** | ★★★★★ Real PostgreSQL (forked, with storage layer replaced). |

**Verdict**: Branching model is elegant but designed for dev/test workflows, not data versioning. No branch merge means each version is a separate database — doesn't map well to swamp's "latest is current, query at version is history" model. Better suited as a managed PG provider for Config C than as a versioning backend.

**Architecture**: Neon separates storage and compute. The storage engine consists of:
- **Pageserver**: Scalable storage backend for compute nodes. Implements copy-on-write branching.
- **Safekeepers**: Redundant WAL service that receives WAL from compute and stores it durably.
- **Compute**: Stateless PostgreSQL nodes backed by the pageserver.

Branching is copy-on-write at the storage layer — creating a branch is instant and uses no additional storage until writes diverge. This is excellent for dev/test (create a branch, run migrations, test, discard) but doesn't provide the "query at version" semantics swamp needs.

**References**:
- Neon architecture: <https://neon.com/docs/introduction/architecture-overview>
- Branching: <https://neon.com/docs/introduction/branching>
- Storage engine: <https://github.com/neondatabase/neon>

### Config G: Vanilla PostgreSQL + `periods` Extension (SQL:2011 SYSTEM VERSIONING)

- **Source**: <https://github.com/xocolatl/periods>
- **License**: PostgreSQL License
- **Stars**: ~318
- **Language**: C (Postgres extension)
- **PG compatibility**: 9.5–15

| Criterion | Assessment |
|-----------|-----------|
| **Native versioning** | ★★★★★ Full SQL:2011/SQL:2016 `SYSTEM VERSIONING` implementation. `PERIOD FOR system_time`, `WITH SYSTEM VERSIONING`, `FOR system_time AS OF` / `FROM ... TO ...` / `BETWEEN ... AND ...` query syntax. History table auto-managed. Access control integrated. |
| **Schema mapping** | ★★★★★ Standard Postgres DDL. |
| **Schema migration** | ★★★★☆ `ALTER TABLE` requires temporarily dropping system versioning, altering both main and history tables, then re-enabling. Extension validates compatibility on re-enable. |
| **Maturity** | ★★★☆☆ Community-maintained, feature-complete per SQL standard. 318 stars. Active maintenance for PG version compatibility. |
| **Self-host** | ★★★★★ Any PG 9.5–15 with the extension installed. |
| **Managed** | ★★★☆☆ Only on providers that allow custom C extensions (RDS yes, Cloud SQL limited, Supabase yes). |
| **PG compatibility** | ★★★★★ Real PostgreSQL + extension. |

**Verdict**: The most complete SQL-standard system versioning implementation for vanilla PostgreSQL. Provides the `FOR SYSTEM_TIME AS OF` syntax that Config B (manual triggers) lacks. The `periods` extension is more feature-complete than the older `temporal_tables` extension (arkhipov, 1k stars, BSD-2-Clause) which only provides trigger-based history tracking without the standard SQL query syntax. Good upgrade path from Config B.

**Key operations**:
```sql
-- Create table with system versioning
CREATE TABLE servers (
    id bigint PRIMARY KEY,
    name text,
    region text
);
SELECT periods.add_system_time_period('servers', 'row_start', 'row_end');
SELECT periods.add_system_versioning('servers');

-- Query current state
SELECT * FROM servers;

-- Query at a specific point in time (standard SQL syntax)
SELECT * FROM servers__as_of('2026-08-12T10:30:00Z');

-- Query over a time range
SELECT * FROM servers__from_to('2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z');
SELECT * FROM servers__between('2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z');

-- Alter table (must temporarily drop system versioning)
BEGIN;
SELECT periods.drop_system_versioning('servers');
ALTER TABLE servers ADD COLUMN environment text;
ALTER TABLE servers_history ADD COLUMN environment text;
SELECT periods.add_system_versioning('servers');
COMMIT;

-- Exclude columns from triggering version history
SELECT periods.add_system_time_period('servers',
    excluded_column_names => ARRAY['last_login', 'login_count']);
```

**References**:
- `periods` extension: <https://github.com/xocolatl/periods>
- Older `temporal_tables` extension (trigger-only, no standard SQL syntax): <https://github.com/arkhipov/temporal_tables>
- PostgreSQL wiki on temporal extensions: <https://wiki.postgresql.org/wiki/Temporal_Extensions>
- SQL:2011/SQL:2016 system-versioned tables specification

### Note: PostgreSQL 18/19 Core Temporal Support

PostgreSQL 18 (released September 2025) added **temporal constraints** — `WITHOUT OVERLAPS` on PRIMARY KEY/UNIQUE constraints and `PERIOD` on FOREIGN KEY constraints. These enforce that time ranges don't overlap within a key, but they do **not** provide automatic history tracking or `FOR SYSTEM_TIME AS OF` queries. PostgreSQL 19 beta 2 (July 2026) does not add system versioning either.

In other words: PG 18/19 can enforce that two rows don't have overlapping valid-time periods, but it won't automatically archive old row versions or let you query "what did this table look like last Tuesday." System versioning remains the domain of extensions (`periods`, `temporal_tables`) or manual trigger-based implementations (Config B).

### Additional Candidates Considered but Not Evaluated in Detail

#### TimescaleDB
- **Website**: <https://www.timescale.com/>
- **Source**: <https://github.com/timescale/timescaledb>
- **Stars**: ~23,300
- **Why not**: Time-series optimized (hypertables, columnar compression, continuous aggregates). No native data versioning. Would need to build temporal tables on top. Wrong tool for the job.

#### TigerFS
- **Website**: <https://tigerfs.io/>
- **Source**: <https://github.com/timescale/tigerfs>
- **Why not**: Versioned FUSE filesystem over Postgres+TimescaleDB. Every write is versioned with atomic undo. But versioning is file-level, not row-level. Requires FUSE mount + TimescaleDB. Swamp already uses files — this adds a filesystem layer on top of a DB, which is the wrong direction for schema mapping.

#### Supabase Realtime
- **Website**: <https://supabase.com/realtime>
- **Source**: <https://github.com/supabase/realtime>
- **Stars**: ~7,600
- **Why not**: Not a database — a WebSocket server for Postgres CDC (change data capture), broadcast, and presence. Could be useful as a complementary component (streaming data changes to swamp) but not as a versioning backend.

#### pgvector
- **Website**: <https://github.com/pgvector/pgvector>
- **Stars**: ~22,600
- **Why not**: Vector similarity search extension. Not a versioning solution. Could be useful if swamp models need vector search, but orthogonal to the versioning problem.

#### nearform/temporal_tables (PL/pgSQL rewrite)
- **Source**: <https://github.com/nearform/temporal_tables>
- **Why not**: A PL/pgSQL rewrite of the arkhipov `temporal_tables` C extension, targeting managed databases (AWS RDS, Google Cloud SQL, Azure) where custom C extensions aren't permitted. Provides trigger-based system-period history tracking without the standard SQL query syntax. Useful as a fallback for managed environments that block C extensions, but the `periods` extension (Config G) is more feature-complete if C extensions are allowed.

#### pg_bitemporal
- **Source**: <https://github.com/hettie-d/pg_bitemporal>
- **Why not**: A bi-temporal extension supporting both system time (transaction time) and valid time (business time). Fork of an older, inactive implementation. More sophisticated than swamp needs — swamp only requires system-time versioning. Documentation is sparse (mostly presentation videos and slide decks). Over-engineered for this use case.

#### PostgreSQL Wiki: Temporal Extensions
- **URL**: <https://wiki.postgresql.org/wiki/Temporal_Extensions>
- **Relevance**: Comprehensive catalog of all PostgreSQL temporal extensions and features. Lists the four extensions covered in this document (`periods`, `temporal_tables`, `nearform/temporal_tables`, `pg_bitemporal`) plus PostgreSQL core features supporting temporality (range types, PERIOD types, temporal predicates). Confirms that no PostgreSQL core version (through 19 beta 2) includes native system versioning — it remains extension territory.

---

## 2. Recommendation

### Primary target: Config B/C — Vanilla PostgreSQL + System-Versioned Tables

- Safest, most portable, works on every PostgreSQL provider
- Versioning via `sys_period TSTZRANGE` + triggers is well-understood and battle-tested
- Full Postgres feature set: constraints, indexes, extensions, all types
- Works self-hosted (Docker) and managed (RDS, Cloud SQL, Supabase, etc.)
- Can upgrade to pg_temporal extension (Config G) for native `FOR SYSTEM_TIME AS OF` syntax

### Secondary target: Config A — DoltgreSQL

- Design the versioning adapter interface so DoltgreSQL can be swapped in when it matures
- The `dolt_commit`/`dolt.log`/`AS OF` model is the ideal semantic match
- Track DoltgreSQL releases; target when correctness > 99% and performance gap narrows

### Tertiary target: Config E — CockroachDB

- If distributed scale and online schema changes become important
- `AS OF SYSTEM TIME` is a good fit for time-travel queries
- Online schema changes eliminate migration downtime

### Not recommended for this use case

- **XTDB (Config D)**: Dynamic schema conflicts with strict Zod→DDL mapping
- **Neon (Config F)**: Branching model designed for dev/test, not data versioning
- **TimescaleDB**: No native data versioning; wrong tool for the job
- **TigerFS**: Filesystem layer on top of DB; wrong direction for schema mapping

---

## 3. Architecture

### 3.1 Layer Model

```
┌─────────────────────────────────────────────────┐
│  Swamp Core (model create, method run, data q)  │
├─────────────────────────────────────────────────┤
│  DatastoreProvider (locks, sync, health)        │
├─────────────────────────────────────────────────┤
│  Schema Manager (Zod→DDL, versioning, migrate)  │
├─────────────────────────────────────────────────┤
│  Versioning Adapter (swamp version ↔ DB native) │
├─────────────────────────────────────────────────┤
│  SQL Driver (pg client, connection pool)        │
└─────────────────────────────────────────────────┘
```

**Layer responsibilities**:

1. **SQL Driver**: Connection pooling, query execution, transaction management.
   Uses `npm:postgres@3` (Deno-compatible Postgres client). One pool per unique
   connection configuration.

2. **Versioning Adapter**: Abstracts database-specific versioning mechanisms.
   Swamp version IDs map to database-native version identifiers (commit hashes,
   timestamps, version UUIDs). Four planned implementations (see §3.2).

3. **Schema Manager**: Maps Zod schemas to DDL, diffs schemas, generates and
   executes migrations. Manages the lifecycle of tables (create, alter, drop).
   Handles imported external tables.

4. **DatastoreProvider**: Standard swamp datastore interface. Locks, health
   checks, namespace management, sync service. This is what swamp core sees.

### 3.2 Versioning Adapter Interface

The versioning adapter abstracts the database-specific versioning mechanism:

```typescript
interface VersioningAdapter {
  /** Create versioning infrastructure for a table (triggers, history table, etc.) */
  enableVersioning(schema: string, tableName: string): Promise<void>;

  /** Record a new version after a method run writes data.
   *  Returns a version identifier (commit hash, timestamp, etc.) */
  createVersion(
    schema: string,
    tableName: string,
    metadata: VersionMetadata,
  ): Promise<string>;

  /** Get current (latest) rows from a table */
  getCurrentRows(
    schema: string,
    tableName: string,
    columns?: string[],
  ): Promise<Row[]>;

  /** Get rows as they existed at a specific version */
  getRowsAtVersion(
    schema: string,
    tableName: string,
    versionId: string,
    columns?: string[],
  ): Promise<Row[]>;

  /** List all versions for a table, newest first */
  listVersions(
    schema: string,
    tableName: string,
  ): Promise<VersionMetadata[]>;

  /** Garbage-collect old versions, keeping at most `keepCount` */
  pruneVersions(
    schema: string,
    tableName: string,
    keepCount: number,
  ): Promise<number>;
}

interface VersionMetadata {
  versionId: string;
  timestamp: string;       // ISO 8601
  method?: string;         // e.g., "run", "sync"
  modelName?: string;      // swamp model name
  workflowId?: string;     // if part of a workflow run
  message?: string;        // human-readable description
}
```

#### Adapter Implementations

| Adapter | Backend | Versioning Mechanism | `createVersion` | `getRowsAtVersion` |
|---------|---------|---------------------|-----------------|-------------------|
| `SystemVersionedAdapter` | PG (Config B/C) | `sys_period` + triggers | INSERT into version metadata table | `WHERE sys_period @> version_ts` |
| `PeriodsAdapter` | PG + `periods` extension (Config G) | SQL:2011 `SYSTEM VERSIONING` | Extension-managed | `FROM t__as_of('timestamp')` |
| `DoltgresAdapter` | DoltgreSQL (Config A) | Git-like commits | `SELECT dolt_commit(...)` | `SELECT * AS OF 'commit_hash'` |
| `CockroachAdapter` | CockroachDB (Config E) | MVCC time travel | Record timestamp | `AS OF SYSTEM TIME version_ts` |

**Adapter selection**: The extension auto-detects the backend by running
`SELECT version()` on first connect. The result is matched against known
patterns:

| `SELECT version()` output | Adapter selected |
|---------------------------|-----------------|
| Contains `PostgreSQL` + `periods` extension found | `PeriodsAdapter` |
| Contains `PostgreSQL` (no pg_temporal) | `SystemVersionedAdapter` |
| Contains `DoltgreSQL` | `DoltgresAdapter` |
| Contains `CockroachDB` | `CockroachAdapter` |

Users can override auto-detection via config:
```yaml
versioning:
  adapter: "doltgres"  # force a specific adapter
```

### 3.3 Versioning Semantics

Swamp's versioning model: each method run produces a versioned data snapshot.
Multiple concurrent runs are serialized by the distributed lock. The versioning
adapter must ensure:

1. **Latest version is current**: `SELECT * FROM model_table` returns the most
   recent data. This is the default behavior of all adapters — the main table
   always contains current rows. History rows live in a separate table or are
   filtered out by the versioning mechanism.

2. **Version at point-in-time**: `swamp data get <model> --version <v>` returns
   the exact state after that method run completed. The adapter maps swamp
   version IDs to database-native version identifiers.

3. **Concurrent safety**: The distributed lock (`pg_advisory_lock`) ensures only
   one writer at a time. Version creation happens within the lock. The lock is
   acquired before any write and released after the version is recorded.

4. **Cross-model consistency**: When a method run writes to multiple models, all
   writes share the same version. The adapter creates one version record that
   covers all affected tables. This is achieved by:
   - Generating a single version UUID at the start of the method run
   - Setting `swamp.version_id` as a Postgres session variable
   - The trigger reads this variable when moving rows to history
   - All tables written during the run get the same version ID

**Version lifecycle**:
```
Method run starts
  → Acquire distributed lock
  → Generate version UUID
  → SET swamp.version_id = '<uuid>'
  → Execute method (writes to tables, triggers capture old rows with version_id)
  → INSERT INTO _versions (version_id, timestamp, method, model_name, ...)
  → Release distributed lock
Method run ends
```

### 3.4 Schema Management

#### Zod → DDL Type Mapping

| Zod type | PostgreSQL type | Notes |
|----------|----------------|-------|
| `z.string().uuid()` | `UUID` | |
| `z.string().min(n).max(m)` | `VARCHAR(m)` | + `CHECK (length >= n)` |
| `z.string().email()` | `VARCHAR(254)` | + `CHECK (col ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')` |
| `z.string().url()` | `VARCHAR(2048)` | + `CHECK (col ~ '^https?://...')` |
| `z.string().regex(/pattern/)` | `VARCHAR(N)` or `TEXT` | + `CHECK (col ~ 'pattern')` |
| `z.string()` (unconstrained) | `TEXT` | |
| `z.number().int()` | `BIGINT` | |
| `z.number().int().min(n).max(m)` | `BIGINT` | + `CHECK (col >= n AND col <= m)` |
| `z.number().min(n).max(m)` | `DOUBLE PRECISION` | + `CHECK (col >= n AND col <= m)` |
| `z.number()` | `DOUBLE PRECISION` | |
| `z.boolean()` | `BOOLEAN` | |
| `z.enum([...])` | `VARCHAR(N)` | N = max enum value length; + `CHECK (col IN (...))` |
| `z.iso.datetime()` | `TIMESTAMPTZ` | |
| `z.date()` | `DATE` | |
| `z.array(primitive)` | `JSONB` | Default `'[]'::jsonb` |
| `z.array(z.object({...}))` | `JSONB` | Default `'[]'::jsonb` |
| `z.object({...})` | `JSONB` | Nested objects stored as JSONB |
| `z.record(z.string(), T)` | `JSONB` | |
| `z.optional()` | nullable column | No `NOT NULL` constraint |
| `z.union([A, B, ...])` | `JSONB` | Tagged union stored as JSONB with discriminator |
| `z.literal(v)` | `VARCHAR` | + `CHECK (col = 'v')` |
| `z.bigint()` | `NUMERIC` | For arbitrary precision integers |
| `z.nan()` / `z.null()` | nullable column | |
| `z.undefined()` | column omitted | Not stored in DB |
| `z.default(value)` | column with DEFAULT | `DEFAULT value` in DDL |

**Primary key detection**: If the Zod schema has a field named `id` with type
`z.string().uuid()`, it becomes the primary key. Otherwise, a synthetic `id UUID
DEFAULT gen_random_uuid() PRIMARY KEY` is added.

**Index generation**: Fields used in common query patterns get automatic indexes:
- Primary key: automatic (from PK constraint)
- Fields ending in `_id` or `_key`: B-tree index
- `z.iso.datetime()` fields: B-tree index (for time-range queries)
- `z.enum([...])` fields: B-tree index (for filtering)

#### Schema Migration (Gradual Row Migration)

When a model schema changes (new version of the model extension), the Schema
Manager performs a multi-step migration:

**Step 1: Diff**
Compare old Zod schema to new Zod schema field-by-field. Detect:
- **Added columns**: field in new schema, not in old
- **Removed columns**: field in old schema, not in new
- **Type changes**: same field name, different Zod type
- **Constraint changes**: same type, different `.min()`/`.max()`/`.regex()` etc.
- **Optionality changes**: field gained or lost `.optional()`

**Step 2: Plan**
Generate ordered `ALTER TABLE` statements. Order matters:
1. Add new nullable columns first (safe, no data migration needed)
2. Add new constraints (CHECK, etc.)
3. Backfill data for new columns (batched UPDATE)
4. Add NOT NULL constraints (after backfill)
5. Drop removed columns (or soft-drop: rename to `_deprecated_col`)
6. Change column types (requires `USING` clause for casting)

**Step 3: Execute**
Apply changes in batches to avoid long locks:

```sql
-- Example: adding a required column with a default value
-- Step 1: Add as nullable
ALTER TABLE servers ADD COLUMN environment VARCHAR(50);

-- Step 2: Backfill in batches of 1000
-- The extension runs this in a loop until no NULLs remain
UPDATE servers
SET environment = 'production'
WHERE id IN (
  SELECT id FROM servers
  WHERE environment IS NULL
  LIMIT 1000
);

-- Step 3: Add NOT NULL constraint
ALTER TABLE servers ALTER COLUMN environment SET NOT NULL;
```

**Step 4: Version the migration**
Old versions keep old schema. System-versioned tables handle this naturally:
- History rows have the old column set to NULL (or the old type)
- The versioning adapter records which schema version each data version uses
- Querying an old version returns rows with the old schema (missing new columns
  appear as NULL)

**Migration safety**:
- All DDL runs in a transaction where possible (Postgres supports transactional DDL)
- If any step fails, the transaction rolls back
- For large tables, `ALTER TABLE` may require `SET lock_timeout` to avoid blocking
- Progress is logged so interrupted migrations can resume

**Type change migration examples**:

```sql
-- string → number
ALTER TABLE servers ALTER COLUMN port TYPE INTEGER USING port::INTEGER;

-- number → string
ALTER TABLE servers ALTER COLUMN port TYPE VARCHAR(10) USING port::VARCHAR;

-- string → enum (add constraint)
ALTER TABLE servers ADD CONSTRAINT servers_region_check
  CHECK (region IN ('us-east-1', 'eu-west-1', 'ap-southeast-1'));

-- optional → required (after backfill)
ALTER TABLE servers ALTER COLUMN name SET NOT NULL;

-- required → optional
ALTER TABLE servers ALTER COLUMN name DROP NOT NULL;
```

### 3.5 Multi-Database / Multi-Credential Support

The extension supports routing different model types to different PostgreSQL
databases, each with their own credentials:

```yaml
# .swamp.yaml
datastore:
  type: "@myorg/postgres-datastore"
  config:
    # Default connection for models without a specific mapping
    defaultConnection:
      host: "localhost"
      port: 5432
      database: "swamp"
      user: "swamp"
      password: "${vault:swamp-db/password}"       # vault reference
      ssl: false

    # Per-model-type connection overrides
    modelConnections:
      "@myorg/aws-ec2":
        database: "aws_inventory"
        user: "aws_reader"
        password: "${vault:aws-db/password}"
      "@myorg/k8s-clusters":
        host: "k8s-db.internal"
        port: 5432
        database: "kubernetes"
        user: "k8s_admin"
        password: "${vault:k8s-db/password}"

    # Connection pool settings
    pool:
      maxConnections: 20
      idleTimeoutMs: 30000
      connectTimeoutMs: 5000
```

**Credential resolution order**:
1. Per-model connection config in `.swamp.yaml` (with `${vault:...}` references resolved)
2. `defaultConnection` in `.swamp.yaml`
3. Standard PostgreSQL environment variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`)
4. `SWAMP_DATASTORE` environment variable (JSON config)

**Connection pool management**:
- One connection pool per unique `(host, port, database, user)` tuple
- Pools are lazily initialized on first use
- Each pool has its own health check (periodic `SELECT 1`)
- Idle connections are closed after `idleTimeoutMs`
- Connection errors trigger pool recreation

**Cross-database limitations**:
- No cross-database transactions (Postgres doesn't support them)
- Models that need atomic writes must share the same database
- The distributed lock (`pg_advisory_lock`) only works within a single database
- For multi-database setups, a dedicated "lock database" is used for advisory locks

### 3.6 Importing External Tables

The extension supports importing existing database tables that were not created
by swamp. This allows swamp to read (and optionally write to) tables managed by
other applications.

```typescript
// Extension method (not a swamp model method — an extension-level operation)
const imported = await schemaManager.importTable({
  sourceSchema: "production",           // PostgreSQL schema
  sourceTable: "servers",               // table name
  modelType: "@myorg/imported-server",  // swamp model type
  connection: "prod-readonly",          // connection alias from config
  mode: "readonly",                     // "readonly" | "readwrite"
  // Option A: auto-discover schema from table columns
  discoverSchema: true,
  // Option B: provide explicit Zod schema
  // schema: z.object({ hostname: z.string(), ip: z.string().ip() }),
});
```

**Read-only mode** (default): Swamp can `SELECT` but never `INSERT`/`UPDATE`/
`DELETE`/`ALTER`. The table is treated as an external data source. Write
attempts fail with a clear error message. This is the safest mode for tables
owned by other applications.

**Read-write mode**: Swamp can `INSERT`/`UPDATE`/`DELETE` but never modifies DDL.
The existing table schema is respected as-is. No `ALTER TABLE` is ever issued.
This is useful for tables that swamp should populate but whose schema is managed
externally (e.g., by a migration framework).

**Schema discovery**: When `discoverSchema: true`, the extension reads
`information_schema.columns` and generates a best-effort Zod schema from the
column types:

```sql
-- The extension runs this query to discover the schema
SELECT
    column_name,
    data_type,
    udt_name,
    is_nullable,
    column_default,
    character_maximum_length,
    numeric_precision,
    numeric_scale
FROM information_schema.columns
WHERE table_schema = 'production'
  AND table_name = 'servers'
ORDER BY ordinal_position;
```

The generated Zod schema is a starting point — users can refine it by providing
an explicit schema. The discovered schema is stored in the model metadata so
swamp knows the expected column layout.

**Import validation**:
- The connection must have appropriate permissions (SELECT for readonly, INSERT/UPDATE/DELETE for readwrite)
- The table must exist and be accessible
- If an explicit schema is provided, it's validated against the actual table columns
- Mismatches between the provided schema and actual columns are reported as warnings

---

## 4. Implementation Plan

### Phase 1: Core DatastoreProvider

**Goal**: A working swamp datastore that stores files in PostgreSQL.

- [ ] Scaffold extension at `extensions/datastores/postgres/mod.ts`
- [ ] Implement `DatastoreProvider` with `npm:postgres@3` connection pool
  - Parse config (`.swamp.yaml` + env vars + `SWAMP_DATASTORE` env var)
  - Create connection pools per unique connection config
  - Handle connection errors and reconnection
- [ ] Implement `DistributedLock` using `pg_advisory_lock` / `pg_try_advisory_lock`
  - Native PostgreSQL advisory locks: no heartbeat needed, automatically released on connection close
  - `pg_try_advisory_lock` for non-blocking acquire with retry loop
  - Lock key derived from datastore path hash
  - `LockInfo` stored in a `_locks` metadata table
- [ ] Implement `DatastoreVerifier` (connect + `SELECT 1` + latency measurement)
  - Check all configured connection pools
  - Return aggregate health status
- [ ] Implement `resolveDatastorePath` / `resolveCachePath`
  - For local-first: return repo's `.swamp/` path (files still stored on disk, PG is for model data)
  - For remote: return cache path, implement sync service
- [ ] Implement `registerNamespace` / `listNamespaces`
  - Each namespace = a PostgreSQL schema
  - `.namespace.json` manifest stored in a `_namespaces` metadata table
- [ ] Config schema: connection strings, pool settings, model→DB mappings
- [ ] Unit tests with `@swamp-club/swamp-testing` conformance suites:
  - `assertDatastoreExportConformance`
  - `assertLockConformance`
  - `assertVerifierConformance`

### Phase 2: Versioning Adapter

**Goal**: Abstract versioning across backends, implement primary adapter.

- [ ] Define `VersioningAdapter` interface (see §3.2)
- [ ] Implement `SystemVersionedAdapter` (Config B — vanilla PG temporal tables):
  - `enableVersioning`: create history table (`{table}_history`) + `BEFORE UPDATE` trigger
  - `createVersion`: insert version metadata row into `_versions` table
  - `getCurrentRows`: `SELECT * FROM t WHERE upper_inf(sys_period)`
  - `getRowsAtVersion`: `SELECT * FROM t_history WHERE version_id = $1`
  - `listVersions`: `SELECT * FROM _versions WHERE table_name = $1 ORDER BY created_at DESC`
  - `pruneVersions`: delete old history rows + version metadata beyond `keepCount`
- [ ] Implement `DoltgresAdapter` (Config A):
  - `enableVersioning`: no-op (DoltgreSQL tracks everything)
  - `createVersion`: `SELECT dolt_commit('-m', message)`
  - `getCurrentRows`: `SELECT * FROM t` (HEAD)
  - `getRowsAtVersion`: `SELECT * FROM t AS OF 'commit_hash'`
  - `listVersions`: `SELECT * FROM dolt.log`
  - `pruneVersions`: dolt garbage collection
- [ ] Implement `CockroachAdapter` (Config E):
  - `enableVersioning`: no-op (MVCC built-in)
  - `createVersion`: record timestamp in `_versions` table
  - `getCurrentRows`: `SELECT * FROM t`
  - `getRowsAtVersion`: `SELECT * FROM t AS OF SYSTEM TIME $1`
  - `listVersions`: query `_versions` table
  - `pruneVersions`: delete old version metadata (MVCC GC handles row history)
- [ ] Adapter selection: auto-detect via `SELECT version()` or explicit config
- [ ] Tests: create version, query current, query at version, list versions, GC

### Phase 3: Schema Manager

**Goal**: Map Zod schemas to DDL, handle schema changes with migration.

- [ ] Zod → DDL type mapping engine (see §3.4)
  - Type mapper: Zod type → SQL column definition
  - Constraint generator: Zod refinements → CHECK constraints
  - Index generator: heuristics for automatic indexes
  - Primary key detection
- [ ] `createTable(modelType, zodSchema, tableName)`:
  - Generate `CREATE TABLE` with columns, constraints, indexes
  - Enable versioning on the table (via adapter)
  - Register in `_schema_versions` metadata table
- [ ] `diffSchemas(oldSchema, newSchema)`:
  - Compare Zod schemas field-by-field
  - Detect: added columns, removed columns, type changes, constraint changes, optionality changes
  - Generate ordered `ALTER TABLE` statements
  - Return a `MigrationPlan` with steps and estimated impact
- [ ] `migrateSchema(tableName, oldSchema, newSchema)`:
  - Apply `ALTER TABLE` in correct order (add nullable first, then backfill, then NOT NULL)
  - Gradual row migration in configurable batch sizes
  - Progress tracking (how many rows migrated, estimated time remaining)
  - Rollback on failure (within a transaction where possible)
  - Record migration in `_schema_versions` table
- [ ] `importTable(sourceSchema, sourceTable, options)`:
  - Read `information_schema.columns` for schema discovery
  - Generate Zod schema from column types
  - Register as read-only or read-write model
  - Validate connection permissions
  - Store discovered schema in model metadata
- [ ] Multi-connection pool management:
  - One pool per unique `(host, port, database, user)` tuple
  - Lazy initialization on first use
  - Health checks on each pool (periodic `SELECT 1`)
  - Graceful shutdown on extension unload
- [ ] Integration tests with real PostgreSQL

### Phase 4: Swamp Integration

**Goal**: Wire the extension into swamp's model and data lifecycle.

- [ ] Hook into model lifecycle:
  - `model create` → `createTable` (if model has resources with schemas)
  - `model delete` → `DROP TABLE` (with confirmation prompt)
  - `model upgrade` → `diffSchemas` + `migrateSchema`
- [ ] Hook into method run:
  - Pre-run: generate version UUID, set session variable
  - Post-run: `createVersion` across all tables written to
  - Error handling: if method fails, version is not created (no partial versions)
- [ ] Hook into data query:
  - `swamp data latest <model>` → `getCurrentRows`
  - `swamp data get <model> --version <v>` → `getRowsAtVersion`
  - `swamp data list <model>` → `listVersions`
  - `swamp data query <model> '<CEL>'` → `getCurrentRows` + CEL filtering
- [ ] Hook into data GC:
  - `swamp data gc` → `pruneVersions` for all models
  - `swamp data gc <model>` → `pruneVersions` for specific model
- [ ] End-to-end workflow test:
  - Create model → table exists with correct schema
  - Run method → data written, version created
  - Query latest → returns current data
  - Query at version → returns historical data
  - Upgrade model schema → migration runs, old versions preserved
  - GC → old versions pruned, recent versions kept

### Phase 5: Polish & Publishing

- [ ] Adversarial review (per swamp extension guidelines)
- [ ] Quality scorecard (`swamp extension quality`)
- [ ] Documentation:
  - README with setup instructions
  - Connection configuration guide
  - Backend-specific guides (PG, DoltgreSQL, CockroachDB)
  - Schema migration guide
  - Import table guide
  - Troubleshooting guide
- [ ] Publish to swamp registry

---

## 5. Verification Plan

### 5.1 Unit Tests

- **DatastoreProvider conformance**: `assertDatastoreExportConformance`
- **Lock conformance**: `assertLockConformance` — verify `pg_advisory_lock` semantics:
  - Acquire/release lifecycle
  - `withLock` executes and releases
  - `withLock` releases on error
  - `inspect` when held/not held
  - `forceRelease` with correct/wrong nonce
  - Release is idempotent
  - Stale lock detection (simulate crashed process — connection close releases advisory lock)
- **Verifier conformance**: `assertVerifierConformance`
- **Zod→DDL mapping**: Every type combination produces correct SQL
  - Test each Zod type → correct column definition
  - Test constraints (min, max, regex, enum)
  - Test optional → nullable
  - Test default values
  - Test nested objects → JSONB
- **Schema diff**: Add column, drop column, change type, add/drop constraint
  - Test all change types
  - Test ordering of ALTER TABLE statements
  - Test detection of no-op changes (same schema)
- **Versioning adapter**: Create/list/query/prune for each backend
  - Test with empty table
  - Test with existing data
  - Test with multiple versions
  - Test GC with various keep counts

### 5.2 Integration Tests (per backend)

Run against Docker Compose with each backend:

- **PostgreSQL**: `docker run postgres:18`
- **DoltgreSQL**: `docker run dolthub/doltgresql:latest`
- **CockroachDB**: `docker run cockroachdb/cockroach:latest`

Test scenarios:

1. **Create model** → verify table exists with correct columns, types, constraints
2. **Run method** → verify data written, version created with correct metadata
3. **Query latest** → returns current rows, no history rows mixed in
4. **Query at version** → returns exact historical state (row count, values match)
5. **Multiple versions** → create 3 versions, verify each is queryable independently
6. **Schema upgrade (add column)** → add column, verify migration runs, old versions preserved
7. **Schema upgrade with data** → insert 10k rows, add column with default, verify all rows migrated
8. **Schema upgrade (change type)** → change column type, verify data converted correctly
9. **Schema upgrade (drop column)** → drop column, verify old versions still have it
10. **GC** → create 20 versions, prune to 5, verify only 5 remain
11. **Import table (read-only)** → read access works, write attempts rejected with clear error
12. **Import table (read-write)** → INSERT/UPDATE/DELETE work, ALTER TABLE rejected
13. **Multi-database** → models in different DBs work independently, no cross-contamination
14. **Concurrent writes** → two processes, one lock, no corruption, versions are sequential
15. **Crash recovery** → kill process mid-write, restart, verify lock released, data consistent

### 5.3 Performance Benchmarks

- **Version creation overhead**: TPS with versioning enabled vs disabled
  - Target: < 10% overhead for system-versioned tables
  - Measure: inserts/second with and without the BEFORE UPDATE trigger
- **Query-at-version latency**: vs query-current
  - With 1M rows, 100 versions
  - Target: < 2x latency for version queries
- **Schema migration time**: for 1M-row table
  - Add column with default value
  - Target: < 30 seconds with batch size 1000
- **Lock acquisition time**: under concurrent contention
  - 10 processes competing for the same lock
  - Target: all acquire within `maxWaitMs`

### 5.4 Correctness Checks

- `SELECT * FROM model_table` always returns latest version (no history rows)
- `swamp data get <model> --version <v>` returns exact historical state
- Schema migration never loses data (row count before = row count after)
- Concurrent writes are serialized (no lost updates, no duplicate versions)
- Imported read-only tables cannot be mutated (all write attempts fail)
- Imported read-write tables cannot have DDL modified (ALTER TABLE rejected)
- Version GC only removes old versions, never the latest N versions
- Cross-model consistency: all tables written in one method run share the same version ID

---

## 6. Configuration Reference

### Full `.swamp.yaml` Example

```yaml
datastore:
  type: "@myorg/postgres-datastore"
  config:
    # Default connection for models without a specific mapping
    defaultConnection:
      host: "localhost"
      port: 5432
      database: "swamp"
      user: "swamp"
      password: "${vault:swamp-db/password}"
      ssl: false

    # Per-model-type connection overrides
    modelConnections:
      "@myorg/aws-ec2":
        database: "aws_inventory"
        user: "aws_reader"
        password: "${vault:aws-db/password}"
      "@myorg/k8s-clusters":
        host: "k8s-db.internal"
        database: "kubernetes"
        user: "k8s_admin"
        password: "${vault:k8s-db/password}"

    # Connection pool settings
    pool:
      maxConnections: 20
      idleTimeoutMs: 30000
      connectTimeoutMs: 5000

    # Versioning adapter (auto-detect if not specified)
    versioning:
      adapter: "system-versioned"  # "system-versioned" | "doltgres" | "cockroachdb" | "auto"
      historyTableSchema: "swamp_history"  # schema for history tables

    # Schema migration settings
    migration:
      batchSize: 1000          # rows per batch during migration
      batchDelayMs: 100        # delay between batches
      lockTimeoutMs: 5000       # max time to wait for table lock

    # Garbage collection
    gc:
      defaultKeepVersions: 10  # versions to keep per model
```

### Environment Variable Override

```bash
# Full config as JSON
export SWAMP_DATASTORE='@myorg/postgres-datastore:{"defaultConnection":{"host":"localhost","port":5432,"database":"swamp","user":"swamp","password":"secret"}}'
```

Individual connection parameters can also be set via standard PG env vars:
```bash
export PGHOST=localhost
export PGPORT=5432
export PGDATABASE=swamp
export PGUSER=swamp
export PGPASSWORD=secret
export PGSSLMODE=disable
```

### Docker Compose (for development/testing)

```yaml
# docker-compose.yml for local development
version: "3.8"
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: swamp
      POSTGRES_PASSWORD: swamp
      POSTGRES_DB: swamp
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  doltgres:
    image: dolthub/doltgresql:latest
    environment:
      DOLTGRES_USER: swamp
      DOLTGRES_PASSWORD: swamp
    ports:
      - "5433:5432"
    volumes:
      - doltdata:/var/lib/doltgresql

  cockroachdb:
    image: cockroachdb/cockroach:latest
    command: start-single-node --insecure
    ports:
      - "26257:26257"
      - "8080:8080"
    volumes:
      - crdbdata:/cockroach/cockroach-data

volumes:
  pgdata:
  doltdata:
  crdbdata:
```

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| DoltgreSQL remains beta / slow | Can't use best versioning model | Primary target is vanilla PG; DoltgreSQL is a future optimization. Adapter interface makes swap possible. |
| System-versioned trigger overhead | Write performance degradation | Benchmark early. Consider pg_temporal extension for native implementation. Allow disabling versioning per-model. |
| Schema migration locks large tables | Downtime during model upgrades | Batched migration with configurable batch size. `lock_timeout` to avoid indefinite blocking. CockroachDB online schema changes as alternative. |
| Connection pool exhaustion | Denial of service under load | Configurable pool size. Connection timeout. Health checks with automatic pool recreation. |
| Cross-database transactions | No atomicity across DBs | Document limitation clearly. Recommend same DB for related models. Use dedicated lock database for advisory locks. |
| pg_advisory_lock across databases | Locks don't span databases | Use a dedicated "lock database" for advisory locks in multi-DB setups. Document this requirement. |
| Version storage growth | Disk usage over time | Configurable GC with default keep count. Automatic pruning. Consider tiered storage (S3) for old versions. |
| Zod schema complexity | Some Zod types have no direct SQL equivalent | Document mapping limitations. Use JSONB as fallback for complex types. Allow users to provide custom SQL types. |
| Concurrent schema migrations | Two processes trying to migrate the same table | Schema migrations run under the distributed lock. Only one process can migrate at a time. |
| Postgres version differences | Features vary between PG 13–18 | Target PG 15+ for `gen_random_uuid()`, system-versioned table support. Document minimum version. |

---

## 8. Future Enhancements

1. **pg_temporal extension support** (Config G): Use native `SYSTEM VERSIONING` instead of manual triggers for better performance and standard SQL syntax.

2. **DoltgreSQL maturity tracking**: Switch to DoltgreSQL adapter when correctness > 99% and performance gap < 2x. The adapter interface makes this a configuration change, not a code change.

3. **CockroachDB adapter**: For users who need distributed scale and online schema changes. The `AS OF SYSTEM TIME` model is already a good fit.

4. **Schema migration preview**: `swamp model upgrade --dry-run` shows the DDL diff before applying. Allows users to review and approve changes.

5. **Partial versioning**: Only version specific columns (reduces storage for large JSONB columns that don't need history).

6. **Version diff**: `swamp data diff <model> --from v1 --to v2` shows what changed between versions (row-level diff).

7. **Point-in-time recovery**: Restore entire database to a specific swamp version. Useful for disaster recovery.

8. **Read replicas**: Route read queries (`data get`, `data query`) to read replicas for better performance. Writes always go to primary.

9. **Streaming CDC**: Use PostgreSQL logical replication to stream data changes to swamp in real-time. Could enable reactive workflows.

10. **Schema recommendations**: Analyze query patterns and suggest indexes, partition strategies, and type optimizations.

11. **Cross-database foreign keys**: Validate referential integrity across databases (application-level, since Postgres doesn't support cross-DB FKs).

12. **Data export/import**: `swamp data export <model> --format pg_dump` and `swamp data import <model> --from dump.sql` for backup/restore and migration between backends.

---

## 9. Research References

### Databases evaluated
- DoltgreSQL: <https://github.com/dolthub/doltgresql> | <https://www.doltgres.com/>
- PostgreSQL: <https://www.postgresql.org/> | <https://git.postgresql.org/>
- XTDB: <https://github.com/xtdb/xtdb> | <https://xtdb.com/>
- CockroachDB: <https://github.com/cockroachdb/cockroach> | <https://www.cockroachlabs.com/>
- Neon: <https://github.com/neondatabase/neon> | <https://neon.com/>
- TimescaleDB: <https://github.com/timescale/timescaledb> | <https://www.timescale.com/>
- TigerFS: <https://github.com/timescale/tigerfs> | <https://tigerfs.io/>

### Extensions and tools
- pg_temporal: <https://github.com/arkhipov/temporal_tables>
- pgvector: <https://github.com/pgvector/pgvector>
- Supabase Realtime: <https://github.com/supabase/realtime>

### PostgreSQL temporal tables
- SQL:2011 system-versioned tables: ISO/IEC 9075:2011
- PostgreSQL temporal documentation: <https://www.postgresql.org/docs/current/ddl-system-versioning.html>
- Temporal data in PostgreSQL (2ndQuadrant): <https://www.2ndquadrant.com/en/blog/temporal-data-postgresql-1/>
- PostgreSQL wiki on temporal extensions: <https://wiki.postgresql.org/wiki/Temporal_Extensions>

### Swamp extension development
- Datastore API reference: `.agents/skills/swamp/references/extension/references/datastore/api.md`
- Datastore examples: `.agents/skills/swamp/references/extension/references/datastore/examples.md`
- Datastore testing: `.agents/skills/swamp/references/extension/references/datastore/testing.md`
- Datastore troubleshooting: `.agents/skills/swamp/references/extension/references/datastore/troubleshooting.md`
- Extension guide: `.agents/skills/swamp/references/extension/guide.md`
- Extension reference: `.agents/skills/swamp/references/extension/reference.md`

### Architecture and design
- Martin Kleppmann, "Turning the database inside out": <https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/>
- XTDB architecture (inside-out): <https://xtdb.com/inside-out/>
- Neon architecture: <https://neon.com/docs/introduction/architecture-overview>
- CockroachDB MVCC: <https://www.cockroachlabs.com/docs/stable/architecture/storage-layer#mvcc>
- Dolt architecture: <https://dolthub.com/docs/architecture/architecture>
