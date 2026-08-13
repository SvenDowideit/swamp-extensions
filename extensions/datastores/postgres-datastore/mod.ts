/**
 * PostgreSQL datastore provider for swamp.
 *
 * Uses PostgreSQL with the `periods` extension for SQL:2011 SYSTEM VERSIONING.
 * Distributed locking via `pg_advisory_lock` (connection-scoped, no heartbeat needed).
 *
 * @module
 */
import { z } from "npm:zod@4";
import postgres from "npm:postgres@3";

const ConfigSchema = z.object({
  connectionString: z.string().min(1).describe("PostgreSQL connection URI"),
  schema: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .default("swamp")
    .describe("PostgreSQL schema for swamp tables"),
  ssl: z
    .enum(["disable", "require", "verify-ca"])
    .default("require")
    .describe("SSL mode"),
  sslCaPath: z
    .string()
    .optional()
    .describe("Path to CA certificate bundle"),
  pool: z
    .object({
      maxConnections: z.number().int().min(1).max(100).default(10),
      idleTimeoutMs: z.number().int().min(0).default(30000),
      connectTimeoutMs: z.number().int().min(1000).default(5000),
    })
    .default({
      maxConnections: 10,
      idleTimeoutMs: 30000,
      connectTimeoutMs: 5000,
    }),
});

type Config = z.infer<typeof ConfigSchema>;

interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
}

interface LockOptions {
  lockKey?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash >>>= 0;
  }
  return Math.abs(hash);
}

function jitter(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * baseMs * 0.5);
}

function buildSslConfig(
  parsed: Config,
): postgres.Options<Record<string, never>>["ssl"] {
  if (parsed.ssl === "disable") return false;
  if (parsed.ssl === "require") {
    return "require" as postgres.Options<Record<string, never>>["ssl"];
  }
  return {
    ca: parsed.sslCaPath ? Deno.readTextFileSync(parsed.sslCaPath) : undefined,
  } as postgres.Options<Record<string, never>>["ssl"];
}

function createSql(parsed: Config): postgres.Sql<Record<string, never>> {
  return postgres(parsed.connectionString, {
    max: parsed.pool.maxConnections,
    idle_timeout: Math.ceil(parsed.pool.idleTimeoutMs / 1000),
    connect_timeout: Math.ceil(parsed.pool.connectTimeoutMs / 1000),
    ssl: buildSslConfig(parsed),
  });
}

function createLockSql(parsed: Config): postgres.Sql<Record<string, never>> {
  return postgres(parsed.connectionString, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: Math.ceil(parsed.pool.connectTimeoutMs / 1000),
    ssl: buildSslConfig(parsed),
  });
}

async function ensureInfrastructure(
  sql: postgres.Sql<Record<string, never>>,
  schema: string,
): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS periods`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${schema}._locks (
      lock_key BIGINT PRIMARY KEY,
      holder TEXT NOT NULL,
      hostname TEXT NOT NULL,
      pid INTEGER NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ttl_ms INTEGER NOT NULL,
      nonce TEXT
    )
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${schema}._namespace (
      namespace TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** PostgreSQL datastore provider with periods extension for SQL:2011 SYSTEM VERSIONING. */
export const datastore = {
  type: "@svendowideit/postgres-datastore",
  name: "PostgreSQL Datastore",
  description:
    "PostgreSQL datastore with periods extension for SQL:2011 SYSTEM VERSIONING. Distributed locking via pg_advisory_lock.",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);

    return {
      createLock(
        datastorePath: string,
        options?: LockOptions,
      ): DistributedLock {
        const lockKey = options?.lockKey
          ? hashString(options.lockKey)
          : hashString(datastorePath);
        const ttlMs = options?.ttlMs ?? 30_000;
        const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
        const maxWaitMs = options?.maxWaitMs ?? 60_000;
        const holder = `${
          Deno.env.get("USER") ?? "unknown"
        }@${Deno.hostname()}`;
        const hostname = Deno.hostname();
        const pid = Deno.pid;
        const nonce = crypto.randomUUID();

        let lockSql: postgres.Sql<Record<string, never>> | null = null;

        return {
          async acquire(): Promise<void> {
            const deadline = Date.now() + maxWaitMs;

            while (Date.now() < deadline) {
              lockSql = createLockSql(parsed);
              const [result] = await lockSql.unsafe(
                `SELECT pg_try_advisory_lock(${lockKey}) AS acquired`,
              );

              if (result.acquired) {
                await ensureInfrastructure(lockSql, parsed.schema);
                await lockSql.unsafe(
                  `
                  INSERT INTO ${parsed.schema}._locks (lock_key, holder, hostname, pid, ttl_ms, nonce)
                  VALUES ($1, $2, $3, $4, $5, $6)
                  ON CONFLICT (lock_key) DO UPDATE SET
                    holder = EXCLUDED.holder,
                    hostname = EXCLUDED.hostname,
                    pid = EXCLUDED.pid,
                    acquired_at = NOW(),
                    ttl_ms = EXCLUDED.ttl_ms,
                    nonce = EXCLUDED.nonce
                `,
                  [lockKey, holder, hostname, pid, ttlMs, nonce],
                );
                return;
              }

              await lockSql.end();
              lockSql = null;

              const metaSql = createSql(parsed);
              try {
                await ensureInfrastructure(metaSql, parsed.schema);
                const [existing] = await metaSql.unsafe(`
                  SELECT pid, acquired_at, ttl_ms FROM ${parsed.schema}._locks WHERE lock_key = ${lockKey}
                `);

                if (existing) {
                  const age = Date.now() -
                    new Date(existing.acquired_at).getTime();
                  if (age > existing.ttl_ms) {
                    await metaSql.unsafe(
                      `SELECT pg_terminate_backend(${existing.pid})`,
                    );
                    await metaSql.unsafe(
                      `DELETE FROM ${parsed.schema}._locks WHERE lock_key = ${lockKey}`,
                    );
                    await metaSql.end();
                    continue;
                  }
                }
              } finally {
                await metaSql.end();
              }

              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              const waitMs = Math.min(jitter(retryIntervalMs), remaining);
              await new Promise((r) => setTimeout(r, waitMs));
            }

            throw new Error(
              `Lock timeout: could not acquire lock for '${datastorePath}' within ${maxWaitMs}ms`,
            );
          },

          async release(): Promise<void> {
            if (!lockSql) return;
            try {
              await lockSql.unsafe(
                `
                DELETE FROM ${parsed.schema}._locks
                WHERE lock_key = $1 AND nonce = $2
              `,
                [lockKey, nonce],
              );
            } catch {
              /* lock row may already be gone */
            }
            await lockSql.end();
            lockSql = null;
          },

          async withLock<T>(fn: () => Promise<T>): Promise<T> {
            await this.acquire();
            try {
              return await fn();
            } finally {
              await this.release();
            }
          },

          async inspect(): Promise<LockInfo | null> {
            const metaSql = createSql(parsed);
            try {
              await ensureInfrastructure(metaSql, parsed.schema);
              const [row] = await metaSql.unsafe(
                `
                SELECT holder, hostname, pid, acquired_at, ttl_ms, nonce
                FROM ${parsed.schema}._locks
                WHERE lock_key = $1
              `,
                [lockKey],
              );
              if (!row) return null;
              return {
                holder: row.holder,
                hostname: row.hostname,
                pid: row.pid,
                acquiredAt: row.acquired_at instanceof Date
                  ? row.acquired_at.toISOString()
                  : String(row.acquired_at),
                ttlMs: row.ttl_ms,
                nonce: row.nonce ?? undefined,
              };
            } finally {
              await metaSql.end();
            }
          },

          async forceRelease(expectedNonce: string): Promise<boolean> {
            const metaSql = createSql(parsed);
            try {
              await ensureInfrastructure(metaSql, parsed.schema);
              const [row] = await metaSql.unsafe(
                `
                SELECT pid FROM ${parsed.schema}._locks
                WHERE lock_key = $1 AND nonce = $2
              `,
                [lockKey, expectedNonce],
              );
              if (!row) return false;
              await metaSql.unsafe(
                `SELECT pg_terminate_backend(${row.pid})`,
              );
              await metaSql.unsafe(
                `DELETE FROM ${parsed.schema}._locks WHERE lock_key = ${lockKey}`,
              );
              return true;
            } finally {
              await metaSql.end();
            }
          },
        };
      },

      createVerifier(): DatastoreVerifier {
        return {
          async verify(): Promise<DatastoreHealthResult> {
            const start = performance.now();
            const sql = createSql(parsed);
            try {
              await ensureInfrastructure(sql, parsed.schema);
              await sql.unsafe("SELECT 1");
              const [ext] = await sql.unsafe(
                "SELECT extname FROM pg_extension WHERE extname = 'periods'",
              );
              const latencyMs = Math.round(performance.now() - start);

              if (!ext) {
                return {
                  healthy: false,
                  message: "periods extension is not installed",
                  latencyMs,
                  datastoreType: "@svendowideit/postgres-datastore",
                  details: { schema: parsed.schema },
                };
              }

              return {
                healthy: true,
                message: "OK",
                latencyMs,
                datastoreType: "@svendowideit/postgres-datastore",
                details: {
                  schema: parsed.schema,
                  periods: "available",
                },
              };
            } catch (error) {
              const latencyMs = Math.round(performance.now() - start);
              return {
                healthy: false,
                message: error instanceof Error ? error.message : String(error),
                latencyMs,
                datastoreType: "@svendowideit/postgres-datastore",
              };
            } finally {
              await sql.end();
            }
          },
        };
      },

      resolveDatastorePath(_repoDir: string): string {
        try {
          const url = new URL(parsed.connectionString);
          const dbName = url.pathname.replace(/^\//, "").replace(/\/$/, "") ||
            "postgres";
          return `pg://${url.hostname}:${
            url.port || 5432
          }/${dbName}/${parsed.schema}`;
        } catch {
          return `pg://${parsed.schema}`;
        }
      },

      resolveCachePath(_repoDir: string): undefined {
        return undefined;
      },

      async registerNamespace(
        _datastorePath: string,
        namespace: string,
        repoId: string,
      ): Promise<void> {
        const sql = createSql(parsed);
        try {
          await ensureInfrastructure(sql, parsed.schema);
          const [existing] = await sql.unsafe(
            `
            SELECT repo_id FROM ${parsed.schema}._namespace
            WHERE namespace = $1
          `,
            [namespace],
          );
          if (existing && existing.repo_id !== repoId) {
            throw new Error(
              `Namespace '${namespace}' is already claimed by repo '${existing.repo_id}'`,
            );
          }
          await sql.unsafe(
            `
            INSERT INTO ${parsed.schema}._namespace (namespace, repo_id)
            VALUES ($1, $2)
            ON CONFLICT (namespace) DO UPDATE SET repo_id = EXCLUDED.repo_id
          `,
            [namespace, repoId],
          );
        } finally {
          await sql.end();
        }
      },

      async listNamespaces(_datastorePath: string): Promise<string[]> {
        const sql = createSql(parsed);
        try {
          await ensureInfrastructure(sql, parsed.schema);
          const rows = await sql.unsafe(`
            SELECT namespace FROM ${parsed.schema}._namespace ORDER BY namespace
          `);
          return rows.map((r: Record<string, unknown>) =>
            r.namespace as string
          );
        } finally {
          await sql.end();
        }
      },
    };
  },
};
