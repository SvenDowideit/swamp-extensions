/**
 * Swamp model that provisions and configures a PostgreSQL server.
 *
 * Container-first: this version runs the official `postgres` image as a
 * long-lived service through `@svendowideit/container-service` (detached,
 * health-gated, restart-managed), creates the application role and database,
 * and writes a non-secret `connection` resource other models consume. The
 * native lane (apt/dnf/… + initdb) is deliberately deferred to a future
 * `linux-package-installer` extension; `provision` dispatches on `mode` so
 * adding it is additive.
 *
 * Secrets (the database password) live only in a swamp vault. The model never
 * writes a password into a resource, a log, or an argv — role creation is sent
 * to `psql` over stdin inside the container.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

function safeValue(label: string): z.ZodString {
  return z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );
}

export const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp; used to derive names).",
  ),
  mode: z.enum(["auto", "container", "native"]).default("auto").describe(
    "'container' runs the official Postgres image. 'native' is not " +
      "implemented yet (pending a linux-package-installer extension) and fails " +
      "with guidance. 'auto' currently resolves to container.",
  ),
  version: z.string().default("18-alpine").describe(
    "Postgres image tag (the image becomes postgres:<version>).",
  ),
  image: z.string().default("").describe(
    "Full image reference; overrides version when set.",
  ),
  port: z.number().int().positive().default(5432).describe(
    "Host port to publish for the server.",
  ),
  bindAddress: z.string().default("127.0.0.1").describe(
    "Host address to publish the port on.",
  ),
  database: safeValue("database").default("app").describe(
    "Application database to create.",
  ),
  username: safeValue("username").default("app").describe(
    "Application role to create and own the database.",
  ),
  adminUser: safeValue("adminUser").default("postgres").describe(
    "Superuser the image creates (POSTGRES_USER) and that runs the bootstrap " +
      "psql. Kept separate from the application role.",
  ),
  postgresDatabase: safeValue("postgresDatabase").default("postgres").describe(
    "The image's default database (POSTGRES_DB). Kept separate so the " +
      "application database can be created by the bootstrap without colliding.",
  ),
  dataDir: z.string().default("~/.local/share/swamp-postgres").describe(
    "Host directory persisted as the Postgres data volume.",
  ),
  network: safeValue("network").default("swamp-postgres").describe(
    "Container network the server joins; peers (e.g. Dependency-Track) join " +
      "the same network and reach it by container name.",
  ),
  containerName: safeValue("containerName").default("").describe(
    "Container name (empty = derived from the model name).",
  ),
  vaultName: z.string().default("").describe(
    "Swamp vault holding the database password. Required — the password is " +
      "generated once and reused from here on later runs.",
  ),
  passwordSecretKey: safeValue("passwordSecretKey").default(
    "POSTGRES_PASSWORD",
  ).describe("Vault key holding the database password."),
  serviceBackend: z.enum(["direct", "systemd"]).default("direct").describe(
    "Passed through to container-service: how the container is kept running.",
  ),
  healthTimeoutMs: z.number().int().positive().default(60000).describe(
    "How long to wait for Postgres to become ready.",
  ),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

export const ProvisionArgsSchema = z.object({
  database: safeValue("database").optional().describe(
    "Override the database to create for this run.",
  ),
  username: safeValue("username").optional().describe(
    "Override the role to create for this run.",
  ),
  forcePasswordReset: z.boolean().default(false).describe(
    "Regenerate and re-store the password even if the vault already has one.",
  ),
});

export type ProvisionArgs = z.infer<typeof ProvisionArgsSchema>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function expandHome(path: string): string {
  if (path === "~") {
    return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? path;
  }
  if (path.startsWith("~/")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (home) return `${home}${path.slice(1)}`;
  }
  return path;
}

/** Resolve the image reference from globals (explicit image wins). */
export function resolveImage(g: Pick<GlobalArgs, "image" | "version">): string {
  return g.image.trim() || `postgres:${g.version.trim()}`;
}

/**
 * The container path the data volume mounts.
 *
 * Postgres 18 relocated its data directory: the image now expects a single
 * mount at `/var/lib/postgresql` and keeps the cluster in a version-named
 * subdirectory (so `pg_upgrade --link` works). Earlier majors mount
 * `/var/lib/postgresql/data` directly.
 */
export function dataMountFor(image: string): string {
  const tag = image.includes(":")
    ? image.slice(image.lastIndexOf(":") + 1)
    : "";
  const major = parseInt(tag, 10);
  if (!Number.isNaN(major) && major >= 18) return "/var/lib/postgresql";
  // Also cover the unversioned/edge tags that currently ship 18.
  if (tag === "latest" || tag === "alpine" || tag === "") {
    return "/var/lib/postgresql";
  }
  return "/var/lib/postgresql/data";
}

/** Derive the container name from the model name when not set explicitly. */
export function containerNameFor(modelName: string, override: string): string {
  const base = override.trim() ||
    (modelName.trim() || "postgres").replace(/[^A-Za-z0-9_.-]/g, "-");
  return base;
}

/** The container-service instance this model drives. */
export function serviceModelName(
  modelName: string,
  override: string,
): string {
  return `${containerNameFor(modelName, override)}-svc`;
}

/** A strong random password (URL-safe, 32 chars). */
export function generatePassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The psql script that idempotently creates the role and database and sets the
 * role password. Sent to `psql` over stdin (never argv), so the password never
 * appears in a process listing. Identifiers are quoted.
 */
export function buildBootstrapSql(
  username: string,
  password: string,
  database: string,
): string {
  const role = quoteIdent(username);
  const db = quoteIdent(database);
  const lit = quoteLiteral(password);
  return [
    `\\set ON_ERROR_STOP on`,
    `DO $$ BEGIN`,
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${
      quoteLiteral(username)
    }) THEN`,
    `    CREATE ROLE ${role} LOGIN;`,
    `  END IF;`,
    `END $$;`,
    `ALTER ROLE ${role} WITH LOGIN PASSWORD ${lit};`,
    `SELECT format('CREATE DATABASE %I OWNER %I', ${quoteLiteral(database)}, ${
      quoteLiteral(username)
    })`,
    `  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${
      quoteLiteral(database)
    })\\gexec`,
    `GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${role};`,
    ``,
  ].join("\n");
}

/** Quote a Postgres identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a Postgres string literal. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build the JDBC/URL-safe connection facts other models consume. */
export function connectionFor(opts: {
  host: string;
  port: number;
  database: string;
  username: string;
  mode: string;
  network: string;
  containerName: string;
  sslmode: string;
}) {
  return {
    host: opts.host,
    port: opts.port,
    database: opts.database,
    username: opts.username,
    mode: opts.mode,
    network: opts.network,
    containerName: opts.containerName,
    sslmode: opts.sslmode,
    jdbcUrl:
      `jdbc:postgresql://${opts.host}:${opts.port}/${opts.database}?sslmode=${opts.sslmode}`,
  };
}
// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type RunModelResult =
  | { ok: true; resources: Array<{ name: string; specName?: string }> }
  | { ok: false; error: { message: string } };

interface MethodContext {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string>; garbageCollection?: number },
  ) => Promise<{ name: string }>;
  createFileWriter?: (specName: string, name: string) => {
    write: (chunk: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  };
  runModel?: (options: {
    modelType?: string;
    definition?: string;
    name?: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<RunModelResult>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<Array<{ content?: unknown; version?: number }>>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
}

/** Map a container-service method to the resource spec it writes. */
export const SERVICE_SPEC: Record<string, string> = {
  service: "serviceResult",
  serviceStatus: "serviceStatusResult",
  exec: "execResult",
  network: "networkResult",
};

async function callService(
  ctx: MethodContext,
  serviceName: string,
  method: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (!ctx.runModel) {
    throw new Error(
      "context.runModel is unavailable — cannot drive @svendowideit/" +
        "container-service.",
    );
  }
  const result = await ctx.runModel({
    modelType: "@svendowideit/container-service",
    name: serviceName,
    method,
    arguments: args,
  });
  if (!result.ok) {
    throw new Error(
      `container-service ${method} failed: ${result.error.message}`,
    );
  }
  return await latestServiceData(ctx, serviceName, SERVICE_SPEC[method]);
}

/** Read the most recent content of a resource the service model wrote. */
async function latestServiceData(
  ctx: MethodContext,
  serviceName: string,
  specName: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!specName || !ctx.readModelData) return undefined;
  try {
    const rows = await ctx.readModelData(serviceName, specName);
    if (!rows || rows.length === 0) return undefined;
    const latest = rows.reduce((a, b) =>
      (b.version ?? 0) >= (a.version ?? 0) ? b : a
    );
    return (latest.content ?? undefined) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

/** Read a secret from the configured vault, returning "" when absent. */
async function readVaultSecret(
  ctx: MethodContext,
  key: string,
): Promise<string> {
  if (!ctx.vaultService || !ctx.globalArgs.vaultName) return "";
  try {
    return await ctx.vaultService.get(
      ctx.globalArgs.vaultName,
      key,
      "model:postgres",
    );
  } catch {
    return "";
  }
}

/** Write a secret to the swamp vault via `swamp vault put` (value on stdin). */
async function vaultPut(
  vaultName: string,
  key: string,
  value: string,
): Promise<void> {
  // swamp-quality-ignore deno-command: writes the generated secret with the swamp CLI because the model API has no vault write; the value is piped on stdin, never argv
  const proc = new Deno.Command("swamp", {
    args: ["vault", "put", vaultName, key, "--json", "--force"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = proc.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(value));
  await writer.close();
  const out = await child.output();
  if (out.code !== 0) {
    throw new Error(
      `swamp vault put ${vaultName} ${key} failed (${out.code}): ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
}

/** Throw a clear error if the native lane is requested before it exists. */
export function assertModeSupported(mode: string): void {
  if (mode === "native") {
    throw new Error(
      "Postgres mode 'native' is not implemented yet — it needs a " +
        "linux-package-installer extension (apt/dnf/yum/zypper/apk/pacman + " +
        "initdb + pg_hba scram). Use mode=container (or mode=auto) for now.",
    );
  }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/postgres",
  version: "2026.10.07.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.07.1",
      description:
        "Initial release: container-first Postgres provisioning via " +
        "@svendowideit/container-service, vault-held password, idempotent " +
        "role/database bootstrap, connection resource, backup, status, remove. " +
        "Native lane deferred.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    connection: {
      description:
        "Non-secret connection facts for the provisioned database, for other " +
        "models to consume via CEL. The password is never here — read it from " +
        "the vault.",
      schema: z.object({
        host: z.string(),
        port: z.number(),
        database: z.string(),
        username: z.string(),
        mode: z.string(),
        network: z.string(),
        containerName: z.string(),
        sslmode: z.string(),
        jdbcUrl: z.string(),
        hostPort: z.number(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    status: {
      description: "Readiness, version, and listening port of the server.",
      schema: z.object({
        ready: z.boolean(),
        running: z.boolean(),
        state: z.string(),
        version: z.string().optional(),
        port: z.number(),
        containerName: z.string(),
        network: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    provision: {
      description: "Outcome of the last provision/configure run.",
      schema: z.object({
        changed: z.boolean(),
        mode: z.string(),
        image: z.string(),
        containerName: z.string(),
        database: z.string(),
        username: z.string(),
        passwordStored: z.boolean(),
        roleCreated: z.boolean(),
        databaseCreated: z.boolean(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    backup: {
      description: "Last logical backup metadata (file data holds the dump).",
      schema: z.object({
        database: z.string(),
        takenAt: z.string(),
        bytes: z.number(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    remove: {
      description: "Outcome of the last remove.",
      schema: z.object({
        removed: z.boolean(),
        containerName: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  checks: {
    "known-mode": {
      description: "Reject an unsupported Postgres mode before doing any work.",
      labels: ["policy"],
      appliesTo: ["provision", "configure", "status", "backup", "remove"],
      execute: (ctx: { globalArgs: GlobalArgs }) => {
        const mode = ctx.globalArgs.mode;
        if (mode === "auto" || mode === "container") return { pass: true };
        return {
          pass: false,
          errors: [
            `mode '${mode}' is not supported yet — see 'native' guidance in ` +
            `the method output.`,
          ],
        };
      },
    },
  },

  methods: {
    provision: {
      description:
        "Provision the Postgres server and application database. Ensures the " +
        "network and a long-lived, health-gated container; generates (or " +
        "reuses) the password from the vault; idempotently creates the role " +
        "and database; writes the connection resource.",
      arguments: ProvisionArgsSchema,
      execute: async (args: ProvisionArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        assertModeSupported(g.mode);
        const modelName = ctx.definition?.name ?? "";
        const containerName = containerNameFor(modelName, g.containerName);
        const serviceName = serviceModelName(modelName, g.containerName);
        const database = args.database ?? g.database;
        const username = args.username ?? g.username;
        const image = resolveImage(g);

        if (!g.vaultName) {
          throw new Error(
            "vaultName is required: the generated database password is stored " +
              "there. Create one, e.g. " +
              "`swamp vault create @svendowideit/systemd-creds postgres-secrets`, " +
              "then set --global-arg vaultName=postgres-secrets.",
          );
        }

        // 1. Network.
        await callService(ctx, serviceName, "network", {
          networkName: g.network,
          serviceBackend: g.serviceBackend,
        });

        // 2. Password: reuse from vault, or generate + store.
        let password = args.forcePasswordReset
          ? ""
          : await readVaultSecret(ctx, g.passwordSecretKey);
        let passwordStored = false;
        if (!password) {
          password = generatePassword();
          await vaultPut(g.vaultName, g.passwordSecretKey, password);
          passwordStored = true;
          ctx.logger?.info(
            "Generated and stored the database password in vault {vault} as " +
              "{key}.",
            { vault: g.vaultName, key: g.passwordSecretKey },
          );
        }

        // 3. Long-lived, health-gated container.
        const ensure = await callService(ctx, serviceName, "service", {
          containerName,
          action: "ensure",
          image,
          env: {
            POSTGRES_DB: g.postgresDatabase,
            POSTGRES_USER: g.adminUser,
            POSTGRES_PASSWORD: password,
          },
          volumes: [`${expandHome(g.dataDir)}:${dataMountFor(image)}`],
          ports: [`${g.bindAddress}:${g.port}:5432`],
          network: g.network,
          restart: "unless-stopped",
          healthCommand: ["pg_isready", "-U", g.adminUser],
          healthTimeoutMs: g.healthTimeoutMs,
          serviceBackend: g.serviceBackend,
        });
        const changed = ensure?.changed === true;

        // 4. Role + database (idempotent), password via psql stdin.
        const sql = buildBootstrapSql(username, password, database);
        const exec = await callService(ctx, serviceName, "exec", {
          containerName,
          command: [
            "psql",
            "-U",
            g.adminUser,
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            "-",
          ],
          input: sql,
        });
        if (exec && (exec.exitCode as number | undefined) !== 0) {
          throw new Error(
            `psql bootstrap failed (exit ${exec.exitCode}): ${exec.stderr}`,
          );
        }

        const conn = connectionFor({
          host: containerName,
          port: 5432,
          database,
          username,
          mode: "container",
          network: g.network,
          containerName,
          sslmode: "disable",
        });
        const handle = await ctx.writeResource("connection", "connection", {
          ...conn,
          hostPort: g.port,
        });
        const provisionHandle = await ctx.writeResource(
          "provision",
          "provision",
          {
            changed,
            mode: "container",
            image,
            containerName,
            database,
            username,
            passwordStored,
            roleCreated: true,
            databaseCreated: true,
          },
        );
        ctx.logger?.info(
          "Postgres '{container}' ready on network {network}; database " +
            "'{database}' owned by '{username}'.",
          {
            container: containerName,
            network: g.network,
            database,
            username,
          },
        );
        return { dataHandles: [handle, provisionHandle] };
      },
    },

    configure: {
      description:
        "Re-apply the desired state (idempotent). Same as provision without " +
        "forcing a password reset.",
      arguments: ProvisionArgsSchema,
      execute: (args: ProvisionArgs, ctx: MethodContext) =>
        (model.methods.provision.execute as (
          a: ProvisionArgs,
          c: MethodContext,
        ) => Promise<{ dataHandles: Array<{ name: string }> }>)(args, ctx),
    },

    status: {
      description:
        "Report server readiness, version, and listening port. Checks the " +
        "container state and runs pg_isready inside it.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const modelName = ctx.definition?.name ?? "";
        const containerName = containerNameFor(modelName, g.containerName);
        const serviceName = serviceModelName(modelName, g.containerName);

        const statusData = await callService(
          ctx,
          serviceName,
          "serviceStatus",
          {
            containerName,
            serviceBackend: g.serviceBackend,
          },
        ) as { running?: boolean; state?: string } | undefined;

        let ready = false;
        let version: string | undefined;
        try {
          const exec = await callService(ctx, serviceName, "exec", {
            containerName,
            command: ["pg_isready", "-U", g.adminUser],
            serviceBackend: g.serviceBackend,
          });
          ready = (exec?.exitCode as number | undefined) === 0;
          if (ready) {
            const v = await callService(ctx, serviceName, "exec", {
              containerName,
              command: [
                "psql",
                "-U",
                g.adminUser,
                "-tAc",
                "SHOW server_version",
              ],
              serviceBackend: g.serviceBackend,
            });
            const out = (v?.stdout as string | undefined)?.trim();
            if (v?.exitCode === 0 && out) version = out;
          }
        } catch {
          ready = false;
        }

        const handle = await ctx.writeResource("status", "status", {
          ready,
          running: statusData?.running ?? false,
          state: statusData?.state ?? "unknown",
          version,
          port: g.port,
          containerName,
          network: g.network,
        });
        ctx.logger?.info("Postgres '{container}': {state} (ready={ready})", {
          container: containerName,
          state: statusData?.state ?? "unknown",
          ready,
        });
        return { dataHandles: [handle] };
      },
    },

    backup: {
      description:
        "Take a logical backup of the database with pg_dump and store it as a " +
        "swamp file resource.",
      arguments: z.object({
        database: safeValue("database").optional(),
      }),
      execute: async (
        args: { database?: string },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const modelName = ctx.definition?.name ?? "";
        const containerName = containerNameFor(modelName, g.containerName);
        const serviceName = serviceModelName(modelName, g.containerName);
        const database = args.database ?? g.database;

        const exec = await callService(ctx, serviceName, "exec", {
          containerName,
          command: ["pg_dump", "-U", g.adminUser, "-d", database],
          serviceBackend: g.serviceBackend,
        });
        const dump = (exec?.stdout as string | undefined) ?? "";
        const bytes = new TextEncoder().encode(dump);

        if (ctx.createFileWriter) {
          const writer = ctx.createFileWriter("backup", "last");
          await writer.write(bytes);
          await writer.close();
        }
        const takenAt = new Date().toISOString();
        const handle = await ctx.writeResource("backup", "backup", {
          database,
          takenAt,
          bytes: bytes.length,
        });
        ctx.logger?.info("Backed up '{database}' ({bytes} bytes)", {
          database,
          bytes: bytes.length,
        });
        return { dataHandles: [handle] };
      },
    },

    remove: {
      description:
        "Stop and delete the Postgres container (destructive). The data " +
        "directory is left on disk unless removeData is set.",
      arguments: z.object({
        removeData: z.boolean().default(false),
      }),
      execute: async (
        args: { removeData: boolean },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const modelName = ctx.definition?.name ?? "";
        const containerName = containerNameFor(modelName, g.containerName);
        const serviceName = serviceModelName(modelName, g.containerName);

        await callService(ctx, serviceName, "service", {
          containerName,
          action: "remove",
          serviceBackend: g.serviceBackend,
        });
        if (args.removeData) {
          await Deno.remove(expandHome(g.dataDir), { recursive: true }).catch(
            () => {},
          );
        }
        const handle = await ctx.writeResource("remove", "remove", {
          removed: true,
          containerName,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
