/**
 * PostgreSQL model type for swamp.
 *
 * Wires the Schema Manager and Versioning Adapter into swamp's model and data
 * lifecycle. Provides methods for creating versioned tables, running data
 * operations, querying current/historical data, listing versions, schema
 * migration, garbage collection, and importing existing tables.
 *
 * @module
 */
import { z } from "npm:zod@4";
import postgres from "npm:postgres@3";
import { createPeriodsAdapter } from "../versioning.ts";
import {
  createTable,
  importTable,
  migrateSchema,
  zodToSqlType,
} from "../schema.ts";
import type { VersioningAdapter } from "../versioning.ts";

function escIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function escLiteral(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

// ---------------------------------------------------------------------------
// JSON schema descriptor → Zod type conversion
// ---------------------------------------------------------------------------

type SchemaDescriptor = string | {
  type: string;
  format?: string;
  optional?: boolean;
  nullable?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
};

function parseDescriptor(raw: unknown): SchemaDescriptor {
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) return raw as SchemaDescriptor;
  return "string";
}

function descriptorToZod(raw: unknown): z.ZodType {
  const d = parseDescriptor(raw);
  if (typeof d === "string") return stringDescriptorToZod(d);
  return objectDescriptorToZod(d);
}

function stringDescriptorToZod(s: string): z.ZodType {
  switch (s) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "string.uuid":
      return z.string().uuid();
    case "string.email":
      return z.string().email();
    case "string.url":
      return z.string().url();
    case "string.datetime":
      return z.string().datetime();
    case "number.int":
      return z.number().int();
    case "number.safeint":
      return z.number().int();
    case "date":
      return z.string();
    case "json":
      return z.record(z.string(), z.unknown());
    case "array":
      return z.array(z.unknown());
    default:
      return z.string();
  }
}

function objectDescriptorToZod(
  d: {
    type: string;
    format?: string;
    optional?: boolean;
    nullable?: boolean;
    default?: unknown;
    min?: number;
    max?: number;
  },
): z.ZodType {
  let base: z.ZodType;

  switch (d.type) {
    case "string": {
      if (d.format === "uuid") base = z.string().uuid();
      else if (d.format === "email") base = z.string().email();
      else if (d.format === "url") base = z.string().url();
      else if (d.format === "datetime") base = z.string().datetime();
      else base = z.string();
      if (d.min != null) base = (base as z.ZodString).min(d.min);
      if (d.max != null) base = (base as z.ZodString).max(d.max);
      break;
    }
    case "number": {
      if (d.format === "int" || d.format === "safeint") base = z.number().int();
      else base = z.number();
      if (d.min != null) base = (base as z.ZodNumber).min(d.min);
      if (d.max != null) base = (base as z.ZodNumber).max(d.max);
      break;
    }
    case "boolean":
      base = z.boolean();
      break;
    case "date":
      base = z.string();
      break;
    case "json":
      base = z.record(z.string(), z.unknown());
      break;
    case "array":
      base = z.array(z.unknown());
      break;
    default:
      base = z.string();
  }

  if (d.default !== undefined) {
    // deno-lint-ignore no-explicit-any
    base = (base as any).default(d.default);
  }
  if (d.nullable) {
    base = base.nullable();
  }
  if (d.optional) {
    base = base.optional();
  }

  return base;
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, raw] of Object.entries(schema)) {
    shape[key] = descriptorToZod(raw);
  }
  return z.object(shape);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  connectionString: z.string().min(1).describe("PostgreSQL connection URI"),
  schema: z.string().default("swamp").describe("PostgreSQL schema"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CreateArgsSchema = z.object({
  tableName: z.string().min(1).describe("Name of the table to create"),
  schema: z.record(z.string(), z.unknown()).describe(
    "JSON representation of the Zod schema (field name → type descriptor)",
  ),
});

const RunArgsSchema = z.object({
  tableName: z.string().min(1).describe("Target table name"),
  operation: z.enum(["insert", "update", "delete"]).describe(
    "Data operation to perform",
  ),
  data: z.array(z.record(z.string(), z.unknown())).min(1).describe(
    "Array of records to insert, update, or delete",
  ),
});

const QueryArgsSchema = z.object({
  tableName: z.string().min(1).describe("Target table name"),
  versionId: z.string().optional().describe(
    "If provided, query rows as they existed at this version",
  ),
  columns: z.array(z.string()).optional().describe(
    "Columns to return (default: all)",
  ),
  where: z.string().optional().describe(
    "Raw SQL WHERE clause fragment (without the WHERE keyword)",
  ),
  limit: z.number().int().min(1).max(10000).default(100).describe(
    "Maximum rows to return",
  ),
});

const ListVersionsArgsSchema = z.object({
  tableName: z.string().min(1).describe("Target table name"),
});

const UpgradeArgsSchema = z.object({
  tableName: z.string().min(1).describe("Target table name"),
  newSchema: z.record(z.string(), z.unknown()).describe(
    "New JSON schema (field name → type descriptor)",
  ),
});

const GcArgsSchema = z.object({
  tableName: z.string().min(1).describe("Target table name"),
  keepCount: z.number().int().min(1).default(10).describe(
    "Number of recent versions to keep",
  ),
});

const ImportTableArgsSchema = z.object({
  sourceSchema: z.string().min(1).describe(
    "PostgreSQL schema where the table lives",
  ),
  sourceTable: z.string().min(1).describe(
    "Name of the table to import",
  ),
  mode: z.enum(["readonly", "readwrite"]).default("readonly").describe(
    "Access mode for the imported table",
  ),
  discoverSchema: z.boolean().default(true).describe(
    "Whether to discover the schema from information_schema",
  ),
  modelType: z.string().optional().describe(
    "Model type to register the import under (defaults to @svendowideit/postgres-model)",
  ),
});

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

interface PgContext {
  sql: postgres.Sql<Record<string, never>>;
  adapter: VersioningAdapter;
  pgSchema: string;
}

function createPgContext(globalArgs: GlobalArgs): PgContext {
  const sql = postgres(globalArgs.connectionString, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const pgSchema = globalArgs.schema;
  const adapter = createPeriodsAdapter(sql, pgSchema);
  return { sql, adapter, pgSchema };
}

async function closePgContext(ctx: PgContext): Promise<void> {
  await ctx.sql.end();
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/postgres-model",
  version: "2026.08.12.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Operation result data",
      schema: z.object({
        status: z.string(),
        message: z.string(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    table_metadata: {
      description: "Stored table schema for use during upgrades",
      schema: z.object({
        tableName: z.string(),
        schema: z.record(z.string(), z.unknown()),
        createdAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description:
        "Create a PostgreSQL table from a Zod schema definition with system versioning",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const ctx = createPgContext(context.globalArgs);
        try {
          const zodSchema = jsonSchemaToZod(args.schema);
          const fqName = await createTable(
            ctx.sql,
            ctx.pgSchema,
            args.tableName,
            zodSchema,
            ctx.adapter,
          );

          await context.writeResource("table_metadata", args.tableName, {
            tableName: args.tableName,
            schema: args.schema,
            createdAt: new Date().toISOString(),
          });

          const handle = await context.writeResource("result", "create", {
            status: "success",
            message: `Table created: ${fqName}`,
            data: {
              tableName: args.tableName,
              qualifiedName: fqName,
              fieldCount: Object.keys(args.schema).length,
            },
          });

          return { dataHandles: [handle] };
        } catch (error) {
          const handle = await context.writeResource("result", "create", {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return { dataHandles: [handle] };
        } finally {
          await closePgContext(ctx);
        }
      },
    },

    run: {
      description:
        "Execute a data operation (insert/update/delete) and create a version snapshot",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const ctx = createPgContext(context.globalArgs);
        try {
          const fqName = `${escIdent(ctx.pgSchema)}.${
            escIdent(args.tableName)
          }`;
          let affectedRows = 0;

          switch (args.operation) {
            case "insert": {
              const columns = Object.keys(args.data[0]);
              const colNames = columns.map(escIdent).join(", ");
              const valuePlaceholders = args.data
                .map((_, i) =>
                  `(${
                    columns.map((_, j) => `$${i * columns.length + j + 1}`)
                      .join(", ")
                  })`
                )
                .join(", ");
              const flatValues = args.data.flatMap((row) =>
                columns.map((col) => row[col] ?? null)
              );

              const result = await ctx.sql.unsafe(
                `INSERT INTO ${fqName} (${colNames}) VALUES ${valuePlaceholders}`,
                flatValues as postgres.ParameterOrJSON<never>[],
              );
              affectedRows = (result as { count: number }).count ?? args.data.length;
              break;
            }
            case "update": {
              for (const row of args.data) {
                const record = row as Record<string, unknown>;
                const keys = Object.keys(record);
                // UPDATE requires a key field. Prefer 'id', fall back to first field.
                const keyField = "id" in record ? "id" : keys[0];
                const keyValue = record[keyField];
                if (keyValue === undefined) {
                  throw new Error(
                    "UPDATE requires a key field in each data record",
                  );
                }
                const fields = { ...record };
                delete fields[keyField];
                const entries = Object.entries(fields);
                if (entries.length === 0) continue;
                const setClauses = entries
                  .map(([col], i) => `${escIdent(col)} = $${i + 1}`)
                  .join(", ");
                const values = entries.map(([, val]) => val ?? null);
                values.push(keyValue);
                const result = await ctx.sql.unsafe(
                  `UPDATE ${fqName} SET ${setClauses} WHERE ${
                    escIdent(keyField)
                  } = $${values.length}`,
                  values as postgres.ParameterOrJSON<never>[],
                );
                affectedRows += (result as { count: number }).count ?? 0;
              }
              break;
            }
            case "delete": {
              // DELETE requires a key field. Prefer 'id', fall back to first field.
              const firstRow = args.data[0] as Record<string, unknown>;
              const firstKeys = Object.keys(firstRow);
              const keyField = "id" in firstRow ? "id" : firstKeys[0];
              const ids = args.data.map((row) =>
                (row as Record<string, unknown>)[keyField]
              );
              const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
              const result = await ctx.sql.unsafe(
                `DELETE FROM ${fqName} WHERE ${
                  escIdent(keyField)
                } IN (${placeholders})`,
                ids as postgres.ParameterOrJSON<never>[],
              );
              affectedRows = (result as { count: number }).count ?? 0;
              break;
            }
          }

          const versionId = await ctx.adapter.createVersion(
            ctx.pgSchema,
            args.tableName,
            {
              versionId: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              method: "run",
              message: `${args.operation} ${affectedRows} row(s)`,
            },
          );

          const handle = await context.writeResource("result", "run", {
            status: "success",
            message:
              `${args.operation} completed: ${affectedRows} row(s) affected`,
            data: {
              operation: args.operation,
              affectedRows,
              versionId,
              recordCount: args.data.length,
            },
          });

          return { dataHandles: [handle] };
        } catch (error) {
          const handle = await context.writeResource("result", "run", {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return { dataHandles: [handle] };
        } finally {
          await closePgContext(ctx);
        }
      },
    },

    query: {
      description: "Query current or historical data from a versioned table",
      arguments: QueryArgsSchema,
      execute: async (
        args: z.infer<typeof QueryArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const ctx = createPgContext(context.globalArgs);
        try {
          const colList = args.columns && args.columns.length > 0
            ? args.columns.map(escIdent).join(", ")
            : "*";
          // WARNING: args.where is a raw SQL fragment interpolated directly.
          // This is a known injection vector. Validate/sanitize in production.
          const whereClause = args.where ? `WHERE ${args.where}` : "";
          const limitClause = `LIMIT ${args.limit}`;

          let rows: Record<string, unknown>[];

          if (args.versionId) {
            const [version] = await ctx.sql.unsafe(
              `SELECT timestamp FROM ${
                escIdent(ctx.pgSchema)
              }._versions WHERE version_id = $1`,
              [args.versionId],
            );
            if (!version) {
              throw new Error(`Version not found: ${args.versionId}`);
            }
            const ts = version.timestamp instanceof Date
              ? version.timestamp.toISOString()
              : String(version.timestamp);

            rows = await ctx.sql.unsafe(
              `SELECT ${colList} FROM ${escIdent(ctx.pgSchema)}.${
                escIdent(args.tableName + "__as_of")
              }('${escLiteral(ts)}') ${whereClause} ${limitClause}`,
            ) as Record<string, unknown>[];
          } else {
            rows = await ctx.sql.unsafe(
              `SELECT ${colList} FROM ${escIdent(ctx.pgSchema)}.${
                escIdent(args.tableName)
              } ${whereClause} ${limitClause}`,
            ) as Record<string, unknown>[];
          }

          const handle = await context.writeResource("result", "query", {
            status: "success",
            message: `Query returned ${rows.length} row(s)`,
            data: {
              tableName: args.tableName,
              versionId: args.versionId ?? null,
              rowCount: rows.length,
              rows: rows as unknown as Record<string, unknown>,
            },
          });

          return { dataHandles: [handle] };
        } catch (error) {
          const handle = await context.writeResource("result", "query", {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return { dataHandles: [handle] };
        } finally {
          await closePgContext(ctx);
        }
      },
    },

    list_versions: {
      description: "List all versions for a table, newest first",
      arguments: ListVersionsArgsSchema,
      execute: async (
        args: z.infer<typeof ListVersionsArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const ctx = createPgContext(context.globalArgs);
        try {
          const versions = await ctx.adapter.listVersions(
            ctx.pgSchema,
            args.tableName,
          );

          const handle = await context.writeResource(
            "result",
            "list_versions",
            {
              status: "success",
              message:
                `Found ${versions.length} version(s) for ${args.tableName}`,
              data: {
                tableName: args.tableName,
                count: versions.length,
                versions: versions as unknown as Record<string, unknown>,
              },
            },
          );

          return { dataHandles: [handle] };
        } catch (error) {
          const handle = await context.writeResource(
            "result",
            "list_versions",
            {
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          );
          return { dataHandles: [handle] };
        } finally {
          await closePgContext(ctx);
        }
      },
    },

    upgrade: {
      description: "Migrate a table schema using gradual row migration",
      arguments: UpgradeArgsSchema,
      execute: async (
        args: z.infer<typeof UpgradeArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          readResource: (
            instanceName: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const ctx = createPgContext(context.globalArgs);
        try {
          const stored = await context.readResource(args.tableName);
          if (!stored || !stored.schema) {
            throw new Error(
              `No stored schema found for table '${args.tableName}'. Was it created with this model?`,
            );
          }

          const oldZodSchema = jsonSchemaToZod(
            stored.schema as Record<string, unknown>,
          );
          const newZodSchema = jsonSchemaToZod(args.newSchema);

          const rowsMigrated = await migrateSchema(
            ctx.sql,
            ctx.pgSchema,
            args.tableName,
            oldZodSchema,
            newZodSchema,
            ctx.adapter,
          );

          await context.writeResource("table_metadata", args.tableName, {
            tableName: args.tableName,
            schema: args.newSchema,
            createdAt: new Date().toISOString(),
          });

          const handle = await context.writeResource("result", "upgrade", {
            status: "success",
            message: `Schema migrated for ${args.tableName}`,
            data: {
              tableName: args.tableName,
              rowsMigrated,
              oldFieldCount:
                Object.keys(stored.schema as Record<string, unknown>).length,
              newFieldCount: Object.keys(args.newSchema).length,
            },
          });

          return { dataHandles: [handle] };
        } catch (error) {
          const handle = await context.writeResource("result", "upgrade", {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return { dataHandles: [handle] };
        } finally {
          await closePgContext(ctx);
        }
      },
    },

    gc: {
      description: "Garbage-collect old versions, keeping the most recent",
      arguments: GcArgsSchema,
      execute: async (
        args: z.infer<typeof GcArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const ctx = createPgContext(context.globalArgs);
        try {
          const pruned = await ctx.adapter.pruneVersions(
            ctx.pgSchema,
            args.tableName,
            args.keepCount,
          );

          const handle = await context.writeResource("result", "gc", {
            status: "success",
            message: `Pruned ${pruned} old version(s) from ${args.tableName}`,
            data: {
              tableName: args.tableName,
              prunedCount: pruned,
              keepCount: args.keepCount,
            },
          });

          return { dataHandles: [handle] };
        } catch (error) {
          const handle = await context.writeResource("result", "gc", {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return { dataHandles: [handle] };
        } finally {
          await closePgContext(ctx);
        }
      },
    },

    import_table: {
      description:
        "Import an existing PostgreSQL table into the swamp schema manager",
      arguments: ImportTableArgsSchema,
      execute: async (
        args: z.infer<typeof ImportTableArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const ctx = createPgContext(context.globalArgs);
        try {
          const result = await importTable(ctx.sql, {
            sourceSchema: args.sourceSchema,
            sourceTable: args.sourceTable,
            swampSchema: ctx.pgSchema,
            modelType: args.modelType ?? "@svendowideit/postgres-model",
            mode: args.mode,
            discoverSchema: args.discoverSchema,
          });

          const discoveredShape: Record<string, string> = {};
          if (result.discoveredSchema) {
            const shape = (result.discoveredSchema as z.ZodObject<z.ZodRawShape>).shape ?? {};
            for (const [key, zodType] of Object.entries(shape)) {
              discoveredShape[key] = zodToSqlType(zodType as z.ZodType);
            }
          }

          const handle = await context.writeResource("result", "import_table", {
            status: "success",
            message: `Imported ${args.sourceSchema}.${args.sourceTable}`,
            data: {
              sourceSchema: args.sourceSchema,
              sourceTable: args.sourceTable,
              mode: result.mode,
              discoveredSchema: discoveredShape as unknown as Record<
                string,
                unknown
              >,
            },
          });

          return { dataHandles: [handle] };
        } catch (error) {
          const handle = await context.writeResource("result", "import_table", {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return { dataHandles: [handle] };
        } finally {
          await closePgContext(ctx);
        }
      },
    },
  },
};
