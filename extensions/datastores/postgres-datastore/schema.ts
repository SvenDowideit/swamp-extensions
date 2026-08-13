/**
 * Schema Manager for PostgreSQL datastore.
 *
 * Maps Zod schemas to PostgreSQL DDL, diffs schemas, and handles gradual row
 * migration. Sits between the DatastoreProvider and the VersioningAdapter.
 *
 * @module
 */
import { z } from "npm:zod@4";
import postgres from "npm:postgres@3";
import type { VersioningAdapter } from "./versioning.ts";

/** Escape a PostgreSQL identifier by double-quoting. */
function escIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Escape a string literal for safe interpolation into SQL. */
function escLiteral(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

// ---------------------------------------------------------------------------
// Zod v4 introspection helpers
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type ZodInternal = { _def: any };

interface ZodCheckDef {
  check: string;
  minimum?: number;
  maximum?: number;
  value?: number;
  inclusive?: boolean;
  format?: string;
  pattern?: RegExp;
  regex?: RegExp;
}

function getChecks(zodType: z.ZodType): ZodCheckDef[] {
  // deno-lint-ignore no-explicit-any
  const def = (zodType as any)._def;
  if (!def || !Array.isArray(def.checks)) return [];
  // deno-lint-ignore no-explicit-any
  return def.checks.map((c: any) => {
    if (c && typeof c === "object") {
      const kind = c.kind ?? c._zod?.def?.check;
      if (!kind) return { check: "" };
      const val = c.value ?? c.min ?? c.max ??
        c._zod?.def?.value ?? c._zod?.def?.minimum ?? c._zod?.def?.maximum;
      return {
        check: kind,
        minimum: c.min ?? c._zod?.def?.minimum,
        maximum: c.max ?? c._zod?.def?.maximum,
        value: val,
        inclusive: c.inclusive ?? c._zod?.def?.inclusive,
        format: c.format ?? c._zod?.def?.format,
        pattern: c.regex ?? c._zod?.def?.pattern,
      };
    }
    return c._zod?.def ?? {};
  }).filter((d: ZodCheckDef) => d.check);
}

/**
 * Unwrap wrapper types to reach the inner type.
 *
 * Handles: ZodOptional, ZodExactOptional, ZodNullable, ZodDefault, ZodPrefault,
 * ZodSuccess, ZodCatch, ZodReadonly, ZodNonOptional, ZodPreprocess, ZodPipe.
 *
 * Note: Zod v4 `z.string().refine(...)` and `z.string().brand(...)` return
 * ZodString directly (not separate wrapper classes), so they need no unwrapping.
 * `z.string().transform(...)` returns ZodPipe.
 */
function unwrap(zodType: z.ZodType): z.ZodType {
  let current = zodType;
  while (true) {
    // deno-lint-ignore no-explicit-any
    const def = (current as any)._def;
    if (!def) break;

    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodExactOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodSuccess ||
      current instanceof z.ZodCatch ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodNonOptional
    ) {
      current = def.innerType as z.ZodType;
    } else if (current instanceof z.ZodPreprocess) {
      current = def.schema as z.ZodType;
    } else if (current instanceof z.ZodPipe) {
      current = def.in as z.ZodType;
    } else {
      break;
    }
  }
  return current;
}

function isOptionalType(zodType: z.ZodType): boolean {
  return zodType instanceof z.ZodOptional ||
    zodType instanceof z.ZodExactOptional ||
    zodType instanceof z.ZodNullable;
}

function hasDefaultValue(zodType: z.ZodType): boolean {
  let current = zodType;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodExactOptional ||
    current instanceof z.ZodNullable
  ) {
    current = (current as z.ZodOptional<z.ZodType>)._def.innerType;
  }
  return current instanceof z.ZodDefault || current instanceof z.ZodPrefault;
}

function getDefaultValue(zodType: z.ZodType): unknown {
  let current = zodType;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodExactOptional ||
    current instanceof z.ZodNullable
  ) {
    current = (current as z.ZodOptional<z.ZodType>)._def.innerType;
  }
  if (current instanceof z.ZodDefault || current instanceof z.ZodPrefault) {
    return (current as z.ZodDefault<z.ZodType>)._def.defaultValue;
  }
  return undefined;
}

function getShape(obj: z.ZodObject<z.ZodRawShape>): Record<string, z.ZodType> {
  return (obj as unknown as { shape: Record<string, z.ZodType> }).shape ?? {};
}

// ---------------------------------------------------------------------------
// 1. Zod → DDL Type Mapping
// ---------------------------------------------------------------------------

/**
 * Map a Zod type to its corresponding PostgreSQL column type.
 *
 * Unwraps optional/nullable/default wrappers to inspect the inner type,
 * then returns the appropriate SQL type string.
 */
export function zodToSqlType(zodType: z.ZodType): string {
  const inner = unwrap(zodType);
  const def = (inner as unknown as ZodInternal)._def;

  if (inner instanceof z.ZodISODateTime) return "TIMESTAMPTZ";
  if (inner instanceof z.ZodISODate) return "DATE";

  if (inner instanceof z.ZodString) {
    const checks = getChecks(inner);
    if (checks.some((c) => c.format === "uuid")) return "UUID";
    if (checks.some((c) => c.format === "email")) return "VARCHAR(254)";
    if (checks.some((c) => c.format === "url")) return "VARCHAR(2048)";
    if (checks.some((c) => c.format === "datetime")) return "TIMESTAMPTZ";
    const maxCheck = checks.find((c) =>
      c.check === "max" || c.check === "max_length"
    );
    if (maxCheck && typeof maxCheck.value === "number") {
      return `VARCHAR(${maxCheck.value})`;
    }
    return "TEXT";
  }

  if (inner instanceof z.ZodNumber) {
    const checks = getChecks(inner);
    if (checks.some((c) => c.format === "safeint")) return "BIGINT";
    return "DOUBLE PRECISION";
  }

  if (inner instanceof z.ZodBoolean) return "BOOLEAN";

  if (inner instanceof z.ZodEnum) {
    const entries: Record<string, string> = (def.entries ?? {}) as Record<
      string,
      string
    >;
    const values = Object.keys(entries);
    const maxLen = values.length > 0
      ? Math.max(...values.map((v) => v.length))
      : 1;
    return `VARCHAR(${maxLen})`;
  }

  if (inner instanceof z.ZodLiteral) {
    const val = def.value ??
      (Array.isArray(def.values) ? def.values[0] : undefined);
    const s = val != null ? String(val) : "";
    return `VARCHAR(${s.length || 1})`;
  }

  if (inner instanceof z.ZodBigInt) return "NUMERIC";
  if (inner instanceof z.ZodDate) return "DATE";
  if (inner instanceof z.ZodNull) return "TEXT";

  if (
    inner instanceof z.ZodArray ||
    inner instanceof z.ZodObject ||
    inner instanceof z.ZodRecord ||
    inner instanceof z.ZodUnion
  ) {
    return "JSONB";
  }

  return "TEXT";
}

// ---------------------------------------------------------------------------
// 2. Zod → CHECK Constraints
// ---------------------------------------------------------------------------

/**
 * Generate CHECK constraint SQL expressions for a Zod type.
 *
 * Unwraps optional/nullable/default wrappers to inspect the inner type's
 * validation rules, then returns an array of CHECK clause strings (without
 * the `CHECK` keyword or constraint name).
 */
export function zodToSqlConstraints(
  zodType: z.ZodType,
  columnName: string,
): string[] {
  const inner = unwrap(zodType);
  const def = (inner as unknown as ZodInternal)._def;
  const constraints: string[] = [];
  const col = escIdent(columnName);

  if (inner instanceof z.ZodString) {
    const checks = getChecks(inner);
    for (const check of checks) {
      switch (check.check) {
        case "min":
        case "min_length":
          if (typeof check.value === "number") {
            constraints.push(`char_length(${col}) >= ${check.value}`);
          }
          break;
        case "max":
        case "max_length":
          if (typeof check.value === "number") {
            constraints.push(`char_length(${col}) <= ${check.value}`);
          }
          break;
        case "string_format":
          if (check.format === "email") {
            constraints.push(
              `${col} ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$'`,
            );
          } else if (check.format === "url") {
            constraints.push(`${col} ~ '^https?://'`);
          } else if (
            check.format === "regex" && (check.pattern || check.regex)
          ) {
            const re = check.pattern || check.regex!;
            constraints.push(`${col} ~ '${re.source.replace(/'/g, "''")}'`);
          }
          break;
      }
    }
  }

  if (inner instanceof z.ZodNumber) {
    const checks = getChecks(inner);
    for (const check of checks) {
      switch (check.check) {
        case "min":
        case "greater_than":
          if (typeof check.value === "number") {
            constraints.push(`${col} >= ${check.value}`);
          }
          break;
        case "max":
        case "less_than":
          if (typeof check.value === "number") {
            constraints.push(`${col} <= ${check.value}`);
          }
          break;
      }
    }
  }

  if (inner instanceof z.ZodEnum) {
    const entries: Record<string, string> = def.entries ?? {};
    const values = Object.keys(entries);
    const quoted = values.map((v) => `'${escLiteral(v)}'`).join(", ");
    constraints.push(`${col} IN (${quoted})`);
  }

  if (inner instanceof z.ZodLiteral) {
    const val = def.value ??
      (Array.isArray(def.values) ? def.values[0] : undefined);
    if (typeof val === "string") {
      constraints.push(`${col} = '${escLiteral(val)}'`);
    } else if (typeof val === "number" || typeof val === "boolean") {
      constraints.push(`${col} = ${val}`);
    } else if (val === null) {
      constraints.push(`${col} IS NULL`);
    }
  }

  return constraints;
}

// ---------------------------------------------------------------------------
// 3. Schema diffing
// ---------------------------------------------------------------------------

/** Describes a single schema change between two Zod object schemas. */
export interface SchemaChange {
  type:
    | "add_column"
    | "drop_column"
    | "change_type"
    | "add_constraint"
    | "drop_constraint"
    | "change_optionality";
  columnName: string;
  oldType?: string;
  newType?: string;
  constraint?: string;
  wasOptional?: boolean;
  isOptional?: boolean;
}

/**
 * Compare two Zod object schemas field-by-field and return an ordered list of
 * changes. The order is safe for sequential application: add nullable columns
 * first, then required columns, then type changes, constraints, optionality
 * changes, and finally drops.
 */
export function diffSchemas(
  oldSchema: z.ZodObject<z.ZodRawShape>,
  newSchema: z.ZodObject<z.ZodRawShape>,
): SchemaChange[] {
  const oldShape = getShape(oldSchema);
  const newShape = getShape(newSchema);
  const oldFields = new Set(Object.keys(oldShape));
  const newFields = new Set(Object.keys(newShape));
  const changes: SchemaChange[] = [];

  const addedNullable: SchemaChange[] = [];
  const addedRequired: SchemaChange[] = [];
  const typeChanges: SchemaChange[] = [];
  const addedConstraints: SchemaChange[] = [];
  const droppedConstraints: SchemaChange[] = [];
  const optionalityChanges: SchemaChange[] = [];
  const dropped: SchemaChange[] = [];

  for (const field of newFields) {
    if (!oldFields.has(field)) {
      const ch: SchemaChange = {
        type: "add_column",
        columnName: field,
        newType: zodToSqlType(newShape[field]),
        isOptional: isOptionalType(newShape[field]),
      };
      if (ch.isOptional) {
        addedNullable.push(ch);
      } else {
        addedRequired.push(ch);
      }
    }
  }

  for (const field of oldFields) {
    if (!newFields.has(field)) {
      dropped.push({ type: "drop_column", columnName: field });
    }
  }

  for (const field of oldFields) {
    if (!newFields.has(field)) continue;

    const oldType = zodToSqlType(oldShape[field]);
    const newType = zodToSqlType(newShape[field]);

    if (oldType !== newType) {
      typeChanges.push({
        type: "change_type",
        columnName: field,
        oldType,
        newType,
      });
    }

    const oldOpt = isOptionalType(oldShape[field]);
    const newOpt = isOptionalType(newShape[field]);
    if (oldOpt !== newOpt) {
      optionalityChanges.push({
        type: "change_optionality",
        columnName: field,
        wasOptional: oldOpt,
        isOptional: newOpt,
      });
    }

    const oldConstrs = new Set(zodToSqlConstraints(oldShape[field], field));
    const newConstrs = new Set(zodToSqlConstraints(newShape[field], field));

    for (const c of newConstrs) {
      if (!oldConstrs.has(c)) {
        addedConstraints.push({
          type: "add_constraint",
          columnName: field,
          constraint: c,
        });
      }
    }

    for (const c of oldConstrs) {
      if (!newConstrs.has(c)) {
        droppedConstraints.push({
          type: "drop_constraint",
          columnName: field,
          constraint: c,
        });
      }
    }
  }

  changes.push(...addedNullable);
  changes.push(...addedRequired);
  changes.push(...typeChanges);
  changes.push(...addedConstraints);
  changes.push(...droppedConstraints);
  changes.push(...optionalityChanges);
  changes.push(...dropped);

  return changes;
}

// ---------------------------------------------------------------------------
// 4. Table creation
// ---------------------------------------------------------------------------

/**
 * Generate and execute a CREATE TABLE statement from a Zod object schema.
 *
 * Detects a primary key: if the schema has a field named `id` typed as
 * `z.string().uuid()`, it becomes the PK. Otherwise an auto-generated
 * `id UUID DEFAULT gen_random_uuid() PRIMARY KEY` column is added.
 *
 * Auto-creates indexes on fields ending in `_id` or `_key`, datetime fields,
 * and enum fields. Then enables system versioning via the adapter.
 *
 * @returns The fully-qualified table name.
 */
export async function createTable(
  sql: postgres.Sql<Record<string, never>>,
  schema: string,
  tableName: string,
  zodSchema: z.ZodObject<z.ZodRawShape>,
  versioningAdapter: VersioningAdapter,
): Promise<string> {
  const shape = getShape(zodSchema);
  const fqName = `${escIdent(schema)}.${escIdent(tableName)}`;

  let hasExplicitPk = false;
  const columnDefs: string[] = [];
  const indexDefs: string[] = [];

  for (const [fieldName, fieldType] of Object.entries(shape)) {
    if (fieldName === "id") {
      const inner = unwrap(fieldType);
      if (inner instanceof z.ZodString) {
        const checks = getChecks(inner);
        if (checks.some((c) => c.format === "uuid")) {
          hasExplicitPk = true;
          columnDefs.push(`${escIdent(fieldName)} UUID PRIMARY KEY`);
          continue;
        }
      }
    }

    const sqlType = zodToSqlType(fieldType);
    const parts: string[] = [escIdent(fieldName), sqlType];

    const isOpt = isOptionalType(fieldType);
    const hasDefault = hasDefaultValue(fieldType);

    if (hasDefault) {
      const dv = getDefaultValue(fieldType);
      if (dv === null) {
        parts.push("DEFAULT NULL");
      } else if (typeof dv === "string") {
        parts.push(`DEFAULT '${escLiteral(dv)}'`);
      } else if (typeof dv === "number" || typeof dv === "boolean") {
        parts.push(`DEFAULT ${dv}`);
      } else {
        parts.push(`DEFAULT '${escLiteral(String(dv))}'`);
      }
    }

    if (!isOpt && !hasDefault) {
      parts.push("NOT NULL");
    }

    columnDefs.push(parts.join(" "));

    const inner = unwrap(fieldType);
    if (
      fieldName.endsWith("_id") ||
      fieldName.endsWith("_key") ||
      inner instanceof z.ZodEnum ||
      inner instanceof z.ZodISODateTime ||
      inner instanceof z.ZodISODate ||
      inner instanceof z.ZodDate ||
      (inner instanceof z.ZodString &&
        getChecks(inner).some((c) =>
          c.format === "email" || c.format === "uuid" || c.format === "datetime"
        ))
    ) {
      indexDefs.push(
        `CREATE INDEX IF NOT EXISTS ${
          escIdent(`idx_${tableName}_${fieldName}`)
        } ON ${fqName} (${escIdent(fieldName)})`,
      );
    }
  }

  if (!hasExplicitPk) {
    columnDefs.unshift("id UUID DEFAULT gen_random_uuid() PRIMARY KEY");
  }

  const constraintDefs: string[] = [];
  for (const [fieldName, fieldType] of Object.entries(shape)) {
    if (fieldName === "id" && hasExplicitPk) continue;
    const checks = zodToSqlConstraints(fieldType, fieldName);
    for (let i = 0; i < checks.length; i++) {
      constraintDefs.push(
        `CONSTRAINT ${escIdent(`ck_${tableName}_${fieldName}_${i}`)} CHECK (${
          checks[i]
        })`,
      );
    }
  }

  const allDefs = [...columnDefs, ...constraintDefs];
  await sql.unsafe(`CREATE TABLE ${fqName} (\n  ${allDefs.join(",\n  ")}\n)`);

  for (const idx of indexDefs) {
    await sql.unsafe(idx);
  }

  await versioningAdapter.enableVersioning(schema, tableName);

  return fqName;
}

// ---------------------------------------------------------------------------
// 5. Schema migration
// ---------------------------------------------------------------------------

function constraintHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/**
 * Apply schema changes with gradual row migration.
 *
 * 1. Diffs old and new Zod schemas.
 * 2. Drops system versioning via the adapter.
 * 3. For each change, generates and executes the appropriate ALTER TABLE
 *    on both the main table and the history table.
 * 4. For new required columns: adds as nullable, backfills in batches, then
 *    sets NOT NULL.
 * 5. For type changes: uses a USING clause for casting.
 * 6. Re-enables system versioning via the adapter.
 *
 * @returns The number of rows backfilled during migration.
 */
export async function migrateSchema(
  sql: postgres.Sql<Record<string, never>>,
  schema: string,
  tableName: string,
  oldZodSchema: z.ZodObject<z.ZodRawShape>,
  newZodSchema: z.ZodObject<z.ZodRawShape>,
  versioningAdapter: VersioningAdapter,
  options?: { batchSize?: number; batchDelayMs?: number },
): Promise<number> {
  const batchSize = options?.batchSize ?? 1000;
  const batchDelayMs = options?.batchDelayMs ?? 0;
  const fqName = `${escIdent(schema)}.${escIdent(tableName)}`;
  const fqHistory = `${escIdent(schema)}.${escIdent(tableName + "_history")}`;
  const changes = diffSchemas(oldZodSchema, newZodSchema);
  let rowsMigrated = 0;

  if (changes.length === 0) return 0;

  await versioningAdapter.dropVersioning(schema, tableName);

  try {
    for (const change of changes) {
      switch (change.type) {
        case "add_column": {
          const col = escIdent(change.columnName);
          const colType = change.newType!;
          const isOpt = change.isOptional ?? true;

          await sql.unsafe(
            `ALTER TABLE ${fqName} ADD COLUMN ${col} ${colType}`,
          );
          await sql.unsafe(
            `ALTER TABLE ${fqHistory} ADD COLUMN ${col} ${colType}`,
          );

          if (!isOpt) {
            const newShape = getShape(newZodSchema);
            const dv = getDefaultValue(newShape[change.columnName]);
            if (dv !== undefined) {
              let defaultExpr: string;
              if (dv === null) {
                defaultExpr = "NULL";
              } else if (typeof dv === "string") {
                defaultExpr = `'${escLiteral(dv)}'`;
              } else if (typeof dv === "number" || typeof dv === "boolean") {
                defaultExpr = String(dv);
              } else {
                defaultExpr = `'${escLiteral(String(dv))}'`;
              }

              let batchCount = 0;
              while (true) {
                const result = await sql.unsafe(
                  `UPDATE ${fqName} SET ${col} = ${defaultExpr} WHERE id IN (SELECT id FROM ${fqName} WHERE ${col} IS NULL LIMIT ${batchSize})`,
                );
                batchCount = (result as { count: number }).count ?? 0;
                rowsMigrated += batchCount;
                if (batchCount < batchSize) break;
                if (batchDelayMs > 0) {
                  await new Promise((r) => setTimeout(r, batchDelayMs));
                }
              }
            }

            await sql.unsafe(
              `ALTER TABLE ${fqName} ALTER COLUMN ${col} SET NOT NULL`,
            );
          }
          break;
        }

        case "drop_column": {
          const col = escIdent(change.columnName);
          await sql.unsafe(`ALTER TABLE ${fqName} DROP COLUMN ${col}`);
          await sql.unsafe(`ALTER TABLE ${fqHistory} DROP COLUMN ${col}`);
          break;
        }

        case "change_type": {
          const col = escIdent(change.columnName);
          const newType = change.newType!;
          await sql.unsafe(
            `ALTER TABLE ${fqName} ALTER COLUMN ${col} TYPE ${newType} USING ${col}::${newType}`,
          );
          await sql.unsafe(
            `ALTER TABLE ${fqHistory} ALTER COLUMN ${col} TYPE ${newType} USING ${col}::${newType}`,
          );
          break;
        }

        case "add_constraint": {
          const cHash = constraintHash(
            `${tableName}_${change.columnName}_${change.constraint}`,
          );
          const cName = escIdent(
            `ck_${tableName}_${change.columnName}_${cHash}`,
          );
          await sql.unsafe(
            `ALTER TABLE ${fqName} ADD CONSTRAINT ${cName} CHECK (${change.constraint})`,
          );
          break;
        }

        case "drop_constraint": {
          const cHash = constraintHash(
            `${tableName}_${change.columnName}_${change.constraint}`,
          );
          const cName = escIdent(
            `ck_${tableName}_${change.columnName}_${cHash}`,
          );
          try {
            await sql.unsafe(
              `ALTER TABLE ${fqName} DROP CONSTRAINT ${cName}`,
            );
          } catch {
            /* constraint may not exist */
          }
          break;
        }

        case "change_optionality": {
          const col = escIdent(change.columnName);
          if (change.wasOptional && !change.isOptional) {
            await sql.unsafe(
              `ALTER TABLE ${fqName} ALTER COLUMN ${col} SET NOT NULL`,
            );
          } else if (!change.wasOptional && change.isOptional) {
            await sql.unsafe(
              `ALTER TABLE ${fqName} ALTER COLUMN ${col} DROP NOT NULL`,
            );
          }
          break;
        }
      }
    }
  } finally {
    await versioningAdapter.enableVersioning(schema, tableName);
  }

  return rowsMigrated;
}

// ---------------------------------------------------------------------------
// 6. Import external tables
// ---------------------------------------------------------------------------

/** Options for importing an existing PostgreSQL table. */
export interface ImportTableOptions {
  sourceSchema: string;
  sourceTable: string;
  swampSchema: string;
  modelType: string;
  mode: "readonly" | "readwrite";
  discoverSchema?: boolean;
  explicitSchema?: z.ZodObject<z.ZodRawShape>;
}

/** Result of importing a table. */
export interface ImportTableResult {
  modelType: string;
  discoveredSchema?: z.ZodObject<z.ZodRawShape>;
  mode: string;
}

async function ensureImportsTable(
  sql: postgres.Sql<Record<string, never>>,
  schema: string,
): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${escIdent(schema)}._imports (
      model_type TEXT PRIMARY KEY,
      source_schema TEXT NOT NULL,
      source_table TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('readonly', 'readwrite')),
      discovered_schema JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Map a PostgreSQL information_schema column type to a best-effort Zod type.
 */
function pgTypeToZod(
  dataType: string,
  charMaxLength: number | null,
  isNullable: boolean,
): z.ZodType {
  const dt = dataType.toLowerCase();
  let base: z.ZodType;

  if (dt === "uuid") {
    base = z.string().uuid();
  } else if (dt === "boolean") {
    base = z.boolean();
  } else if (
    dt === "bigint" || dt === "integer" || dt === "smallint" ||
    dt === "smallserial" || dt === "serial" || dt === "bigserial"
  ) {
    base = z.number().int();
  } else if (dt === "double precision" || dt === "real") {
    base = z.number();
  } else if (dt === "numeric" || dt === "decimal") {
    base = z.bigint();
  } else if (dt === "timestamp with time zone" || dt === "timestamptz") {
    base = z.string().datetime();
  } else if (dt === "timestamp without time zone" || dt === "timestamp") {
    base = z.string().datetime();
  } else if (dt === "date") {
    base = z.string();
  } else if (dt === "jsonb" || dt === "json") {
    base = z.record(z.string(), z.unknown());
  } else if (dt === "text") {
    base = z.string();
  } else if (dt === "character varying" || dt === "varchar") {
    if (charMaxLength != null && charMaxLength > 0) {
      base = z.string().max(charMaxLength);
    } else {
      base = z.string();
    }
  } else if (dt === "character" || dt === "char") {
    if (charMaxLength != null && charMaxLength > 0) {
      base = z.string().max(charMaxLength);
    } else {
      base = z.string();
    }
  } else {
    base = z.string();
  }

  if (isNullable) {
    return base.optional();
  }
  return base;
}

/**
 * Import an existing PostgreSQL table into the swamp schema manager.
 *
 * When `discoverSchema` is true, reads `information_schema.columns` and
 * generates a best-effort Zod schema from the column types.
 *
 * When `explicitSchema` is provided, validates it against the actual table
 * columns (warns on mismatches but does not reject).
 *
 * Registers the import in the `_imports` metadata table. Read-only mode
 * rejects writes; read-write mode allows INSERT/UPDATE/DELETE but never
 * ALTER TABLE.
 */
export async function importTable(
  sql: postgres.Sql<Record<string, never>>,
  options: ImportTableOptions,
): Promise<ImportTableResult> {
  await ensureImportsTable(sql, options.swampSchema);

  const columns = await sql.unsafe(
    `SELECT column_name, data_type, character_maximum_length, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [options.sourceSchema, options.sourceTable],
  ) as Array<{
    column_name: string;
    data_type: string;
    character_maximum_length: number | null;
    is_nullable: "YES" | "NO";
  }>;

  if (columns.length === 0) {
    throw new Error(
      `Table ${options.sourceSchema}.${options.sourceTable} not found in information_schema`,
    );
  }

  let discoveredSchema: z.ZodObject<z.ZodRawShape> | undefined;

  if (options.discoverSchema) {
    const shape: Record<string, z.ZodType> = {};
    for (const col of columns) {
      shape[col.column_name] = pgTypeToZod(
        col.data_type,
        col.character_maximum_length,
        col.is_nullable === "YES",
      );
    }
    discoveredSchema = z.object(shape);
  }

  if (options.explicitSchema) {
    const explicitShape = getShape(options.explicitSchema);
    const actualColumns = new Set(columns.map((c) => c.column_name));
    for (const field of Object.keys(explicitShape)) {
      if (!actualColumns.has(field)) {
        console.warn(
          `[importTable] Field "${field}" in explicitSchema does not exist in table ${options.sourceSchema}.${options.sourceTable}`,
        );
      }
    }
    for (const col of columns) {
      if (!(col.column_name in explicitShape)) {
        console.warn(
          `[importTable] Column "${col.column_name}" in table ${options.sourceSchema}.${options.sourceTable} is not covered by explicitSchema`,
        );
      }
    }
  }

  const schemaJson = discoveredSchema
    ? JSON.stringify(Object.fromEntries(
      Object.entries(getShape(discoveredSchema)).map((
        [k, v],
      ) => [k, zodToSqlType(v)]),
    ))
    : null;

  await sql.unsafe(
    `INSERT INTO ${
      escIdent(options.swampSchema)
    }._imports (model_type, source_schema, source_table, mode, discovered_schema)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (model_type) DO UPDATE SET
       source_schema = EXCLUDED.source_schema,
       source_table = EXCLUDED.source_table,
       mode = EXCLUDED.mode,
       discovered_schema = EXCLUDED.discovered_schema`,
    [
      options.modelType,
      options.sourceSchema,
      options.sourceTable,
      options.mode,
      schemaJson,
    ],
  );

  return {
    modelType: options.modelType,
    discoveredSchema,
    mode: options.mode,
  };
}
