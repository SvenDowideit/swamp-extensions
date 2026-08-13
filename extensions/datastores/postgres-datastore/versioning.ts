/**
 * PeriodsAdapter — SQL:2011 SYSTEM VERSIONING adapter for PostgreSQL.
 *
 * Uses the `periods` extension (https://github.com/xocolatl/periods) to provide
 * automatic row history tracking. This adapter records version metadata so swamp
 * can list, query, and prune historical snapshots.
 *
 * @module
 */
import postgres from "npm:postgres@3";

/** Metadata recorded alongside each version snapshot. */
export interface VersionMetadata {
  versionId: string;
  /** ISO 8601 timestamp of when the version was created. */
  timestamp: string;
  /** Method that produced this version (e.g. "run", "sync"). */
  method?: string;
  /** Swamp model name. */
  modelName?: string;
  /** Workflow ID if this version was produced by a workflow run. */
  workflowId?: string;
  /** Human-readable description. */
  message?: string;
}

/** Adapter for querying and managing versioned table data. */
export interface VersioningAdapter {
  /** Create versioning infrastructure for a table using the periods extension. */
  enableVersioning(schema: string, tableName: string): Promise<void>;

  /** Record a new version after a method run writes data. Returns version UUID. */
  createVersion(
    schema: string,
    tableName: string,
    metadata: VersionMetadata,
  ): Promise<string>;

  /** Get current (latest) rows from a table. */
  getCurrentRows(
    schema: string,
    tableName: string,
    columns?: string[],
  ): Promise<Record<string, unknown>[]>;

  /** Get rows as they existed at a specific version. */
  getRowsAtVersion(
    schema: string,
    tableName: string,
    versionId: string,
    columns?: string[],
  ): Promise<Record<string, unknown>[]>;

  /** List all versions for a table, newest first. */
  listVersions(
    schema: string,
    tableName: string,
  ): Promise<VersionMetadata[]>;

  /** Garbage-collect old versions, keeping at most `keepCount`. Returns number of pruned versions. */
  pruneVersions(
    schema: string,
    tableName: string,
    keepCount: number,
  ): Promise<number>;
}

function escIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function ensureVersionsTable(
  sql: postgres.Sql<Record<string, never>>,
  schema: string,
): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${escIdent(schema)}._versions (
      version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_name TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      method TEXT,
      model_name TEXT,
      workflow_id TEXT,
      message TEXT
    )
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_versions_table_time
    ON ${escIdent(schema)}._versions (table_name, timestamp DESC)
  `);
}

function buildColumnList(columns?: string[]): string {
  if (!columns || columns.length === 0) return "*";
  return columns.map(escIdent).join(", ");
}

function mapVersionRow(row: Record<string, unknown>): VersionMetadata {
  return {
    versionId: String(row.version_id),
    timestamp: row.timestamp instanceof Date
      ? row.timestamp.toISOString()
      : String(row.timestamp),
    method: row.method != null ? String(row.method) : undefined,
    modelName: row.model_name != null ? String(row.model_name) : undefined,
    workflowId: row.workflow_id != null ? String(row.workflow_id) : undefined,
    message: row.message != null ? String(row.message) : undefined,
  };
}

/**
 * Create a PeriodsAdapter backed by the given PostgreSQL connection.
 *
 * The adapter uses the `periods` extension for SQL:2011 SYSTEM VERSIONING.
 * Each versioned table gets a companion `_history` table (managed by periods)
 * and version metadata is stored in `_versions`.
 */
export function createPeriodsAdapter(
  sql: postgres.Sql<Record<string, never>>,
  _schema: string,
): VersioningAdapter {
  return {
    async enableVersioning(_schema: string, tableName: string): Promise<void> {
      await ensureVersionsTable(sql, _schema);
      await sql.unsafe(
        `SELECT periods.add_system_time_period('${escIdent(_schema)}.${
          escIdent(tableName)
        }', 'row_start', 'row_end')`,
      );
      await sql.unsafe(
        `SELECT periods.add_system_versioning('${escIdent(_schema)}.${
          escIdent(tableName)
        }')`,
      );
    },

    async createVersion(
      _schema: string,
      tableName: string,
      metadata: VersionMetadata,
    ): Promise<string> {
      const versionId = metadata.versionId || crypto.randomUUID();
      await sql.unsafe(
        `INSERT INTO ${
          escIdent(_schema)
        }._versions (version_id, table_name, timestamp, method, model_name, workflow_id, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          versionId,
          tableName,
          metadata.timestamp || new Date().toISOString(),
          metadata.method ?? null,
          metadata.modelName ?? null,
          metadata.workflowId ?? null,
          metadata.message ?? null,
        ],
      );
      return versionId;
    },

    async getCurrentRows(
      _schema: string,
      tableName: string,
      columns?: string[],
    ): Promise<Record<string, unknown>[]> {
      const colList = buildColumnList(columns);
      const rows = await sql.unsafe(
        `SELECT ${colList} FROM ${escIdent(_schema)}.${escIdent(tableName)}`,
      );
      return rows as Record<string, unknown>[];
    },

    async getRowsAtVersion(
      _schema: string,
      tableName: string,
      versionId: string,
      columns?: string[],
    ): Promise<Record<string, unknown>[]> {
      const [version] = await sql.unsafe(
        `SELECT timestamp FROM ${
          escIdent(_schema)
        }._versions WHERE version_id = $1`,
        [versionId],
      );
      if (!version) {
        throw new Error(`Version not found: ${versionId}`);
      }
      const ts = version.timestamp instanceof Date
        ? version.timestamp.toISOString()
        : String(version.timestamp);

      const colList = buildColumnList(columns);
      const rows = await sql.unsafe(
        `SELECT ${colList} FROM ${escIdent(_schema)}.${
          escIdent(tableName + "__as_of")
        }($1)`,
        [ts],
      );
      return rows as Record<string, unknown>[];
    },

    async listVersions(
      _schema: string,
      tableName: string,
    ): Promise<VersionMetadata[]> {
      const rows = await sql.unsafe(
        `SELECT * FROM ${escIdent(_schema)}._versions
         WHERE table_name = $1
         ORDER BY timestamp DESC`,
        [tableName],
      );
      return (rows as Record<string, unknown>[]).map(mapVersionRow);
    },

    async pruneVersions(
      _schema: string,
      tableName: string,
      keepCount: number,
    ): Promise<number> {
      const [{ count: beforeCount }] = await sql.unsafe(
        `SELECT COUNT(*)::int AS count FROM ${
          escIdent(_schema)
        }._versions WHERE table_name = $1`,
        [tableName],
      ) as [{ count: number }];

      await sql.unsafe(
        `DELETE FROM ${escIdent(_schema)}._versions
         WHERE table_name = $1
         AND version_id NOT IN (
           SELECT version_id FROM ${escIdent(_schema)}._versions
           WHERE table_name = $1
           ORDER BY timestamp DESC
           LIMIT $2
         )`,
        [tableName, keepCount],
      );

      await sql.unsafe(
        `DELETE FROM ${escIdent(_schema)}.${escIdent(tableName + "_history")}
         WHERE row_end < (
           SELECT MIN(timestamp) FROM (
             SELECT timestamp FROM ${escIdent(_schema)}._versions
             WHERE table_name = $1
             ORDER BY timestamp DESC
             LIMIT $2
           ) AS kept
         )`,
        [tableName, keepCount],
      );

      const [{ count: afterCount }] = await sql.unsafe(
        `SELECT COUNT(*)::int AS count FROM ${
          escIdent(_schema)
        }._versions WHERE table_name = $1`,
        [tableName],
      ) as [{ count: number }];

      return beforeCount - afterCount;
    },
  };
}
