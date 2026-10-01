/**
 * Move or copy secrets between two configured swamp vaults.
 *
 * This companion model exists because swamp's `vault migrate` only changes a
 * vault's *backend type*: it cannot move keys between two vaults of the same
 * type. That is exactly what is needed when relocating secrets out of the
 * shared, pre-isolation `systemd-creds` global store into a per-vault one (see
 * the `@svendowideit/systemd-creds` vault's `global` option). It reads values
 * through the vault service, so it works between *any* two vaults, not just
 * systemd-creds.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Method arguments shared by `plan` and `migrate`. */
const MigrationArgsSchema = z.object({
  from: z.string().describe("Source vault name to read keys from."),
  to: z.string().describe("Target vault name to write keys into."),
  keys: z
    .array(z.string())
    .optional()
    .describe(
      "Only migrate these keys. Omit to migrate every key in the source.",
    ),
  force: z
    .boolean()
    .default(false)
    .describe(
      "Overwrite keys that already exist in the target. Without this, an existing target key is skipped.",
    ),
});

/** Arguments for `migrate`, extending `plan` with a delete-source switch. */
const MigrateArgsSchema = MigrationArgsSchema.extend({
  deleteSource: z
    .boolean()
    .default(true)
    .describe(
      "Delete each key from the source after it is copied (a move). Set false to copy and leave the source untouched.",
    ),
});

/** A single key's migration outcome. */
const KeyResultSchema = z.object({
  key: z.string(),
  action: z.string().describe("copied | skipped-exists | failed"),
  error: z.string().default(""),
});

/** Output resource: the outcome of one plan/migrate run. */
const ResultSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.string().describe("plan | copy | move"),
  sourceSupportsDelete: z.boolean(),
  keys: z.array(KeyResultSchema),
  copied: z.number(),
  skipped: z.number(),
  failed: z.number(),
  deleted: z.number(),
  summary: z.string(),
});

/** Method context slice this model uses (documented vault service surface). */
export type VaultService = {
  get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  put(
    vaultName: string,
    secretKey: string,
    secretValue: string,
    options?: unknown,
    caller?: string,
  ): Promise<void>;
  delete(vaultName: string, secretKey: string, caller?: string): Promise<void>;
  list(vaultName: string): Promise<string[]>;
  getVaultNames(): string[];
  supportsDelete(vaultName: string): boolean;
};

/** Minimal logger surface (structured placeholders, never secret values). */
export type MigrationLogger = {
  info(message: string, props?: Record<string, unknown>): void;
  warning(message: string, props?: Record<string, unknown>): void;
};

/** Context shape this model relies on. */
export type MigrationContext = {
  vaultService?: VaultService;
  logger?: MigrationLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Resolve the vault service or fail with an actionable message. */
function requireVaultService(
  context: MigrationContext,
): VaultService {
  const vs = context.vaultService;
  if (!vs) {
    throw new Error(
      "No vault service is available in this execution context; run via the swamp CLI with vaults configured.",
    );
  }
  return vs;
}

/** Validate the from/to pair and return the source key list to act on. */
async function planKeys(
  vs: VaultService,
  from: string,
  to: string,
  only: string[] | undefined,
): Promise<string[]> {
  if (from === to) {
    throw new Error("Source and target vaults must be different.");
  }
  const available = vs.getVaultNames();
  for (const v of [from, to]) {
    if (!available.includes(v)) {
      throw new Error(
        `Vault '${v}' not found. Available vaults: ${available.join(", ")}`,
      );
    }
  }
  const source = await vs.list(from);
  if (!only || only.length === 0) return source;
  const sourceSet = new Set(source);
  const missing = only.filter((k) => !sourceSet.has(k));
  if (missing.length > 0) {
    throw new Error(
      `Key(s) not present in '${from}': ${missing.join(", ")}`,
    );
  }
  return only;
}

/** Compute, per key, whether it exists in the target (for skip reporting). */
async function keysInTarget(
  vs: VaultService,
  to: string,
): Promise<Set<string>> {
  return new Set(await vs.list(to));
}

/** The model definition. */
export const model = {
  type: "@svendowideit/vault-migrate",
  version: "2026.10.01.1",
  globalArguments: z.object({}),
  upgrades: [
    {
      toVersion: "2026.10.01.1",
      description: "Initial release, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "valid-arguments": {
      description:
        "Require distinct, non-empty source and target vault names before mutating anything.",
      labels: ["policy"],
      appliesTo: ["plan", "migrate"],
      execute: (
        context: { unresolvedMethodArgs?: Record<string, unknown> },
      ): { pass: boolean; errors?: string[] } => {
        const a = context.unresolvedMethodArgs ?? {};
        const from = String(a.from ?? "");
        const to = String(a.to ?? "");
        const errors: string[] = [];
        if (!from) errors.push("`from` must be a non-empty vault name");
        if (!to) errors.push("`to` must be a non-empty vault name");
        if (from && to && from === to) {
          errors.push("`from` and `to` must be different vaults");
        }
        return { pass: errors.length === 0, errors };
      },
    },
  },
  resources: {
    result: {
      description: "Outcome of a vault plan/migrate run",
      schema: ResultSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    plan: {
      description:
        "Dry run: list the keys that a migrate would copy, skip, or fail, without writing anything.",
      arguments: MigrationArgsSchema,
      execute: async (
        args: z.infer<typeof MigrationArgsSchema>,
        context: MigrationContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const vs = requireVaultService(context);
        context.logger?.info(
          "Planning vault migration {from} -> {to}",
          { from: args.from, to: args.to },
        );
        const source = await planKeys(vs, args.from, args.to, args.keys);
        const inTarget = await keysInTarget(vs, args.to);

        const keys = source.map((key) => ({
          key,
          action: inTarget.has(key) && !args.force
            ? "skipped-exists"
            : "copied",
          error: "",
        }));
        const skipped = keys.filter((k) => k.action === "skipped-exists")
          .length;
        const toCopy = keys.length - skipped;

        const handle = await context.writeResource("result", "main", {
          from: args.from,
          to: args.to,
          mode: "plan",
          sourceSupportsDelete: vs.supportsDelete(args.from),
          keys,
          copied: 0,
          skipped,
          failed: 0,
          deleted: 0,
          summary: `${toCopy} to copy, ${skipped} already present${
            args.force ? " (force: would overwrite)" : ""
          }. Source delete supported: ${vs.supportsDelete(args.from)}.`,
        });
        return { dataHandles: [handle as { name: string }] };
      },
    },
    migrate: {
      description:
        "Copy secrets from one vault to another, then (by default) delete them from the source. Set deleteSource=false to copy only.",
      arguments: MigrateArgsSchema,
      execute: async (
        args: z.infer<typeof MigrateArgsSchema>,
        context: MigrationContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const vs = requireVaultService(context);
        const source = await planKeys(vs, args.from, args.to, args.keys);
        const inTarget = await keysInTarget(vs, args.to);
        const canDelete = vs.supportsDelete(args.from);
        const deleteSource = args.deleteSource && canDelete;
        context.logger?.info(
          "Migrating {count} key(s) {from} -> {to} ({mode})",
          {
            count: source.length,
            from: args.from,
            to: args.to,
            mode: deleteSource ? "move" : "copy",
          },
        );

        const keys: {
          key: string;
          action: string;
          error: string;
        }[] = [];
        let copied = 0;
        let skipped = 0;
        let failed = 0;
        let deleted = 0;

        for (const key of source) {
          if (inTarget.has(key) && !args.force) {
            keys.push({ key, action: "skipped-exists", error: "" });
            skipped++;
            continue;
          }
          // Copy and delete are accounted separately: a copy that succeeds
          // followed by a failed source-delete must not be reported as a
          // failure to copy (the value IS safely in the target).
          let copyErr: unknown = null;
          try {
            const value = await vs.get(args.from, key, "model:vault-migrate");
            await vs.put(args.to, key, value, undefined, "model:vault-migrate");
            copied++;
          } catch (error) {
            copyErr = error;
          }
          if (copyErr !== null) {
            failed++;
            keys.push({
              key,
              action: "failed",
              error: copyErr instanceof Error
                ? copyErr.message
                : String(copyErr),
            });
            continue;
          }
          if (deleteSource) {
            try {
              await vs.delete(args.from, key, "model:vault-migrate");
              deleted++;
              keys.push({ key, action: "copied", error: "" });
            } catch (error) {
              // Copied but not removed: surface it, but do not count as a
              // copy failure. `copied` already reflects the safe target copy.
              const detail = error instanceof Error
                ? error.message
                : String(error);
              context.logger?.warning(
                "Copied {key} to {to} but could not delete it from {from}: {detail}",
                { key, to: args.to, from: args.from, detail },
              );
              keys.push({
                key,
                action: "copied-delete-failed",
                error: detail,
              });
            }
          } else {
            keys.push({ key, action: "copied", error: "" });
          }
        }

        const mode = deleteSource ? "move" : "copy";
        const handle = await context.writeResource("result", "main", {
          from: args.from,
          to: args.to,
          mode,
          sourceSupportsDelete: canDelete,
          keys,
          copied,
          skipped,
          failed,
          deleted,
          summary:
            `${mode}: copied ${copied}, skipped ${skipped}, failed ${failed}` +
            (deleteSource
              ? `, deleted ${deleted} from source`
              : canDelete
              ? "; source left intact (deleteSource=false)"
              : "; source delete unsupported, left intact"),
        });
        return { dataHandles: [handle as { name: string }] };
      },
    },
  },
};
