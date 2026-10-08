/**
 * Swamp model that deploys and configures OWASP Dependency-Track v5.
 *
 * v5 ships as two images — `dependencytrack/apiserver` (the API/backend) and
 * `dependencytrack/frontend` (the SPA) — and supports PostgreSQL only. This
 * model runs both as long-lived services through
 * `@svendowideit/container-service`, wired to a PostgreSQL database whose
 * connection facts and password are supplied by the caller (typically produced
 * by `@svendowideit/postgres` and passed as method inputs via CEL).
 *
 * The reason this model exists rather than a few shell steps is
 * `bootstrapAgentKey`: Dependency-Track's very first login forces an admin
 * password change, a team does not get an API key by default, and the key is
 * shown exactly once. This model performs that sequence idempotently and stores
 * the key in a swamp vault, so a later SBOM-uploading model can read it without
 * a human ever seeing it.
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
  apiserverImage: safeValue("apiserverImage").default(
    "ghcr.io/dependencytrack/apiserver:5.1.2",
  ).describe("API server image."),
  frontendImage: safeValue("frontendImage").default(
    "ghcr.io/dependencytrack/frontend:5.1.2",
  ).describe("Frontend image."),
  apiPort: z.number().int().positive().default(8080).describe(
    "Host port for the API server.",
  ),
  uiPort: z.number().int().positive().default(8081).describe(
    "Host port for the frontend.",
  ),
  bindAddress: z.string().default("127.0.0.1").describe(
    "Host address to publish the ports on.",
  ),
  publicBackendUrl: z.string().default("").describe(
    "Public URL of the API server, baked into the frontend as API_BASE_URL. " +
      "Empty defaults to http://<bindAddress>:<apiPort>.",
  ),
  publicFrontendUrl: z.string().default("").describe(
    "Public URL of the frontend; used as the CORS allow-origin for the API " +
      "server. Empty defaults to http://<bindAddress>:<uiPort>.",
  ),
  network: safeValue("network").default("swamp-postgres").describe(
    "Container network the services join; must match the database's network.",
  ),
  containerPrefix: safeValue("containerPrefix").default("").describe(
    "Prefix for the container names (empty = derived from the model name).",
  ),
  vaultName: z.string().default("").describe(
    "Swamp vault for the admin password and the agent API key. Required.",
  ),
  adminUser: safeValue("adminUser").default("admin").describe(
    "Admin username seeded by Dependency-Track.",
  ),
  adminSecretKey: safeValue("adminSecretKey").default(
    "DEPENDENCYTRACK_ADMIN_PASSWORD",
  ).describe("Vault key holding the admin password."),
  apiKeySecretKey: safeValue("apiKeySecretKey").default(
    "DEPENDENCYTRACK_API_KEY",
  ).describe("Vault key the provisioned agent API key is stored under."),
  agentTeamName: safeValue("agentTeamName").default("automation").describe(
    "Team that owns the agent API key.",
  ),
  agentTeamPermissions: z.array(safeValue("agentTeamPermission")).default([
    "BOM_UPLOAD",
    "PROJECT_CREATION_UPLOAD",
    "VIEW_PORTFOLIO",
  ]).describe(
    "Permissions granted to the agent team so the key can upload SBOMs and " +
      "read the portfolio. BOM_UPLOAD and PROJECT_CREATION_UPLOAD are the " +
      "minimum for CI SBOM ingestion.",
  ),
  serviceBackend: z.enum(["direct", "systemd"]).default("direct").describe(
    "Passed through to container-service.",
  ),
  healthTimeoutMs: z.number().int().positive().default(180000).describe(
    "How long to wait for the API server to answer.",
  ),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

export const InstallArgsSchema = z.object({
  dbHost: safeValue("dbHost").describe(
    "Database host (a container name on the shared network, or a hostname).",
  ),
  dbPort: z.number().int().positive().default(5432).describe(
    "Database port as seen from inside the container network.",
  ),
  dbDatabase: safeValue("dbDatabase").describe("Database name."),
  dbUsername: safeValue("dbUsername").describe("Database role."),
  dbPassword: z.string().min(1).meta({ sensitive: true }).describe(
    "Database password — supply via ${{ vault.get('<db-vault>', " +
      "'POSTGRES_PASSWORD') }}. Never persisted.",
  ),
  adminPassword: z.string().min(8).meta({ sensitive: true }).optional()
    .describe(
      "Admin password to set on first bootstrap. Generated and stored when " +
        "empty.",
    ),
  force: z.boolean().default(false).describe(
    "Recreate the containers even if the desired state is unchanged.",
  ),
});

export type InstallArgs = z.infer<typeof InstallArgsSchema>;

export const BootstrapArgsSchema = z.object({
  adminPassword: z.string().min(8).meta({ sensitive: true }).optional()
    .describe(
      "Admin password to use. Read from the vault when empty (and set there on " +
        "first rotation).",
    ),
  force: z.boolean().default(false).describe(
    "Mint a new API key even if a working one already exists in the vault.",
  ),
});

export type BootstrapArgs = z.infer<typeof BootstrapArgsSchema>;

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

/** Derive the three container names this model manages. */
export function containerNames(prefix: string, modelName: string) {
  const p = prefix.trim() ||
    (modelName.trim() || "dependencytrack").replace(/[^A-Za-z0-9_.-]/g, "-");
  return {
    api: `${p}-api`,
    frontend: `${p}-frontend`,
    serviceModel: `${p}-svc`,
  };
}

/** The API base URL the frontend should use to reach the backend. */
export function resolveBackendUrl(
  g: Pick<GlobalArgs, "publicBackendUrl" | "bindAddress" | "apiPort">,
): string {
  return g.publicBackendUrl.trim() || `http://${g.bindAddress}:${g.apiPort}`;
}

/** The frontend URL used as the CORS allow-origin. */
export function resolveFrontendUrl(
  g: Pick<GlobalArgs, "publicFrontendUrl" | "bindAddress" | "uiPort">,
): string {
  return g.publicFrontendUrl.trim() || `http://${g.bindAddress}:${g.uiPort}`;
}

/**
 * The URL this model uses to talk to the API server directly — readiness
 * polling, login, team/key management, status.
 *
 * This is deliberately the LOCAL bind address, not `publicBackendUrl`: the
 * public URL only resolves once the reverse proxy exists, and the proxy is
 * created *after* install/bootstrap (and may not exist at all for a
 * localhost-only deployment). Using the public URL here would make bootstrap
 * fail on every deployment that publishes a backend hostname.
 */
export function resolveAdminBaseUrl(
  g: Pick<GlobalArgs, "bindAddress" | "apiPort">,
): string {
  return `http://${g.bindAddress}:${g.apiPort}`;
}

/** The JDBC URL Dependency-Track v5 uses for its datasource. */
export function jdbcUrl(
  host: string,
  port: number,
  database: string,
): string {
  return `jdbc:postgresql://${host}:${port}/${database}`;
}

/** Whether an HTTP status means "the API is up enough to talk to". */
export function isApiReadyStatus(status: number): boolean {
  return status >= 200 && status < 500 && status !== 404;
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
const SERVICE_SPEC: Record<string, string> = {
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

async function readVaultSecret(
  ctx: MethodContext,
  key: string,
): Promise<string> {
  if (!ctx.vaultService || !ctx.globalArgs.vaultName) return "";
  try {
    return await ctx.vaultService.get(
      ctx.globalArgs.vaultName,
      key,
      "model:dependencytrack",
    );
  } catch {
    return "";
  }
}

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

/** Generate a strong admin password (Dependency-Track requires 8+ chars). */
export function generateAdminPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Poll GET /api/version until it answers, or the deadline passes. */
export async function waitForApi(
  url: string,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<{ up: boolean; status: number; attempts: number }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let status = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetch(`${url}/api/version`, {
        signal: AbortSignal.timeout(Math.min(5000, intervalMs * 3)),
      });
      status = res.status;
      if (res.ok) return { up: true, status, attempts };
    } catch {
      status = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { up: false, status, attempts };
}

export function basicAuth(user: string, password: string): string {
  return "Basic " + btoa(`${user}:${password}`);
}

/** POST form-encoded to the login endpoint; returns the JWT or an error. */
export async function login(
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; token?: string; status: number; body: string }> {
  const res = await fetch(`${baseUrl}/api/v1/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
  });
  const body = await res.text();
  return {
    ok: res.ok,
    token: res.ok ? body.trim() : undefined,
    status: res.status,
    body,
  };
}

/** Get the bearer JWT for the admin, rotating the forced first password. */
export async function loginWithRotation(
  baseUrl: string,
  username: string,
  candidatePasswords: string[],
  newPassword: string,
  logger?: MethodContext["logger"],
): Promise<{ token: string; rotated: boolean; usedPassword: string }> {
  const candidates = [...new Set(candidatePasswords.filter((p) => p !== ""))];
  if (candidates.length === 0) candidates.push("admin");
  let lastStatus = 0;
  let lastBody = "";
  for (const current of candidates) {
    const first = await login(baseUrl, username, current);
    if (first.ok && first.token) {
      return { token: first.token, rotated: false, usedPassword: current };
    }
    lastStatus = first.status;
    lastBody = first.body;
    if (first.status === 401 && /FORCE_PASSWORD_CHANGE/i.test(first.body)) {
      logger?.info(
        "Dependency-Track requires a password change; rotating {user}.",
        { user: username },
      );
      const res = await fetch(`${baseUrl}/api/v1/user/forceChangePassword`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username,
          password: current,
          newPassword,
          confirmPassword: newPassword,
        }).toString(),
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`forceChangePassword failed (${res.status}): ${body}`);
      }
      const second = await login(baseUrl, username, newPassword);
      if (!second.ok || !second.token) {
        throw new Error(
          `login after password rotation failed (${second.status}): ${second.body}`,
        );
      }
      return { token: second.token, rotated: true, usedPassword: newPassword };
    }
    // INVALID_CREDENTIALS (or other): try the next candidate (e.g. the
    // Dependency-Track default "admin" on a freshly created database).
  }
  throw new Error(
    `login failed (${lastStatus}): ${lastBody} — tried ${candidates.length} ` +
      `password candidate(s).`,
  );
}

async function apiGet(
  baseUrl: string,
  path: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body };
}

async function apiSend(
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body };
}

interface Team {
  uuid: string;
  name: string;
}

/** Find a team by name, or create it. Returns the team. */
export async function ensureTeam(
  baseUrl: string,
  token: string,
  name: string,
): Promise<Team> {
  const listed = await apiGet(baseUrl, "/api/v1/team?pageSize=1000", token);
  if (listed.status !== 200 || !Array.isArray(listed.body)) {
    throw new Error(
      `GET /api/v1/team failed (${listed.status}): ${
        JSON.stringify(listed.body)
      }`,
    );
  }
  const teams = listed.body as Team[];
  const found = teams.find((t) => t.name === name);
  if (found) return found;

  const created = await apiSend(baseUrl, "PUT", "/api/v1/team", token, {
    name,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(
      `PUT /api/v1/team failed (${created.status}): ${
        JSON.stringify(created.body)
      }`,
    );
  }
  const team = created.body as Team;
  if (!team?.uuid) {
    // Some builds return the team without a uuid; re-list to find it.
    const again = await apiGet(baseUrl, "/api/v1/team", token);
    const t = (again.body as Team[]).find((x) => x.name === name);
    if (!t) throw new Error(`created team '${name}' but could not find it`);
    return t;
  }
  return team;
}

/** Grant a permission to a team (idempotent; 304 means already present). */
export async function grantTeamPermission(
  baseUrl: string,
  token: string,
  teamUuid: string,
  permission: string,
): Promise<void> {
  const res = await apiSend(
    baseUrl,
    "POST",
    `/api/v1/permission/${permission}/team/${teamUuid}`,
    token,
  );
  // 200 = granted (or already), 304 = already present.
  if (res.status !== 200 && res.status !== 304) {
    throw new Error(
      `granting ${permission} to team ${teamUuid} failed (${res.status}): ${
        JSON.stringify(res.body)
      }`,
    );
  }
}

/** Mint an API key for a team. The key value is in the response `key`. */
export async function createApiKey(
  baseUrl: string,
  token: string,
  teamUuid: string,
): Promise<{ key: string; publicId?: string }> {
  const res = await apiSend(
    baseUrl,
    "PUT",
    `/api/v1/team/${teamUuid}/key`,
    token,
  );
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `PUT /api/v1/team/${teamUuid}/key failed (${res.status}): ${
        JSON.stringify(res.body)
      }`,
    );
  }
  const body = res.body as { key?: string; publicId?: string };
  if (!body?.key) {
    throw new Error(
      "API key creation returned no key: " + JSON.stringify(res.body),
    );
  }
  return { key: body.key, publicId: body.publicId };
}

/** Whether an API key authenticates (probe a portfolio read). */
export async function apiKeyWorks(
  baseUrl: string,
  key: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/project`, {
      headers: { "X-Api-Key": key },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/dependencytrack",
  version: "2026.10.09.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.08.1",
      description:
        "Initial release: deploy Dependency-Track v5 apiserver + frontend as " +
        "long-lived services against a supplied PostgreSQL, rotate the forced " +
        "admin password, provision an agent-team API key into the vault, and " +
        "report status/connection facts. Readiness, auth and key management talk " +
        "to the local bind address (resolveAdminBaseUrl), never the public URL, " +
        "so bootstrap works before a reverse proxy exists; the public URL is " +
        "only baked into the frontend and reported as the SBOM endpoint.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.09.1",
      description:
        "Bundle the deployment workflows with the model: the deploy workflow " +
        "(postgres → install → bootstrap agent key → optional Caddy TLS → " +
        "asserts), the dependencytrack-postgres wrapper, and the reusable " +
        "postgres-provision workflow now ship in this extension alongside the " +
        "model, so a single pull installs the whole stack. No model API change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    install: {
      description: "Outcome of the last install/configure run.",
      schema: z.object({
        apiContainer: z.string(),
        frontendContainer: z.string(),
        apiPort: z.number(),
        uiPort: z.number(),
        backendUrl: z.string(),
        frontendUrl: z.string(),
        image: z.string(),
        frontendImage: z.string(),
        changed: z.boolean(),
        apiReady: z.boolean(),
        network: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    agentKey: {
      description:
        "The provisioned agent API key's identity — team, public id, endpoint. " +
        "The key value itself lives only in the vault.",
      schema: z.object({
        team: z.string(),
        teamUuid: z.string(),
        publicId: z.string().optional(),
        apiUrl: z.string(),
        bomEndpoint: z.string(),
        adminRotated: z.boolean(),
        createdAt: z.string(),
        reused: z.boolean(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    status: {
      description: "Readiness of the apiserver and frontend.",
      schema: z.object({
        apiReady: z.boolean(),
        apiState: z.string(),
        frontendRunning: z.boolean(),
        frontendState: z.string(),
        version: z.string().optional(),
        backendUrl: z.string(),
        frontendUrl: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    remove: {
      description: "Outcome of the last remove.",
      schema: z.object({
        removed: z.boolean(),
        containers: z.array(z.string()),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  checks: {
    "known-images": {
      description:
        "Reject an empty apiserver or frontend image before doing any work.",
      labels: ["policy"],
      appliesTo: ["install", "configure", "status", "remove"],
      execute: (ctx: { globalArgs: GlobalArgs }) => {
        const errors: string[] = [];
        if (!ctx.globalArgs.apiserverImage.trim()) {
          errors.push("apiserverImage must not be empty.");
        }
        if (!ctx.globalArgs.frontendImage.trim()) {
          errors.push("frontendImage must not be empty.");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },

  methods: {
    install: {
      description:
        "Deploy the API server and frontend as long-lived services on the " +
        "database's network, pointing the API at the supplied PostgreSQL. " +
        "Idempotent: an unchanged deployment is left alone. Waits for the API " +
        "to answer /api/version.",
      arguments: InstallArgsSchema,
      execute: async (args: InstallArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const modelName = ctx.definition?.name ?? "";
        const names = containerNames(g.containerPrefix, modelName);
        const backendUrl = resolveBackendUrl(g);
        const frontendUrl = resolveFrontendUrl(g);
        // Control-plane calls (readiness, login, key minting) go to the local
        // bind address; the public URL only exists once Caddy proxies it.
        const adminUrl = resolveAdminBaseUrl(g);

        // Network (shared with the database).
        const net = await callService(ctx, names.serviceModel, "network", {
          networkName: g.network,
          serviceBackend: g.serviceBackend,
        });
        void net;

        // API server.
        const api = await callService(ctx, names.serviceModel, "service", {
          containerName: names.api,
          action: "ensure",
          image: g.apiserverImage,
          env: {
            DT_DATASOURCE_URL: jdbcUrl(
              args.dbHost,
              args.dbPort,
              args.dbDatabase,
            ),
            DT_DATASOURCE_USERNAME: args.dbUsername,
            DT_DATASOURCE_PASSWORD: args.dbPassword,
            DT_CORS_ENABLED: "true",
            DT_CORS_ALLOWED_ORIGINS: frontendUrl,
          },
          volumes: [`${names.api}-data:/data`],
          ports: [`${g.bindAddress}:${g.apiPort}:8080`],
          network: g.network,
          restart: "unless-stopped",
          serviceBackend: g.serviceBackend,
        });

        // Frontend.
        const fe = await callService(ctx, names.serviceModel, "service", {
          containerName: names.frontend,
          action: "ensure",
          image: g.frontendImage,
          env: { API_BASE_URL: backendUrl },
          ports: [`${g.bindAddress}:${g.uiPort}:8080`],
          network: g.network,
          restart: "unless-stopped",
          serviceBackend: g.serviceBackend,
        });

        const apiReady = await waitForApi(adminUrl, g.healthTimeoutMs);
        if (!apiReady.up) {
          ctx.logger?.warn(
            "API server did not answer {url}/api/version within {ms}ms; it " +
              "may still be migrating the database.",
            { url: adminUrl, ms: g.healthTimeoutMs },
          );
        }

        const handle = await ctx.writeResource("install", "install", {
          apiContainer: names.api,
          frontendContainer: names.frontend,
          apiPort: g.apiPort,
          uiPort: g.uiPort,
          backendUrl,
          frontendUrl,
          image: g.apiserverImage,
          frontendImage: g.frontendImage,
          changed: api?.changed === true || fe?.changed === true,
          apiReady: apiReady.up,
          network: g.network,
        });
        ctx.logger?.info(
          "Dependency-Track deployed (api={api}, frontend={frontend}, " +
            "apiReady={ready})",
          { api: names.api, frontend: names.frontend, ready: apiReady.up },
        );
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description: "Re-apply the deployment (idempotent).",
      arguments: InstallArgsSchema,
      execute: (args: InstallArgs, ctx: MethodContext) =>
        (model.methods.install.execute as (
          a: InstallArgs,
          c: MethodContext,
        ) => Promise<{ dataHandles: Array<{ name: string }> }>)(args, ctx),
    },

    bootstrapAgentKey: {
      description:
        "Ensure the agent team exists and provision an API key for it, " +
        "rotating Dependency-Track's forced first-login admin password along " +
        "the way. The key is stored in the vault; a non-secret identity is " +
        "written as the agentKey resource. Idempotent: a stored key that still " +
        "authenticates is reused.",
      arguments: BootstrapArgsSchema,
      execute: async (args: BootstrapArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        if (!g.vaultName) {
          throw new Error(
            "vaultName is required: the agent API key is stored there. Create " +
              "one, e.g. `swamp vault create @svendowideit/systemd-creds " +
              "dependencytrack-secrets`, then set --global-arg " +
              "vaultName=dependencytrack-secrets.",
          );
        }
        const backendUrl = resolveBackendUrl(g);
        // Readiness, auth, and key management talk to the local bind address:
        // the public URL only answers once Caddy proxies it, which is a later
        // workflow step (and absent entirely for localhost-only deployments).
        const adminUrl = resolveAdminBaseUrl(g);
        const up = await waitForApi(adminUrl, g.healthTimeoutMs);
        if (!up.up) {
          throw new Error(
            `API server at ${adminUrl} is not answering /api/version ` +
              `(status ${up.status}) — run install first and give it time to ` +
              `migrate the database.`,
          );
        }

        // Reuse a working key unless forced.
        const existingKey = await readVaultSecret(ctx, g.apiKeySecretKey);
        if (
          !args.force && existingKey &&
          await apiKeyWorks(adminUrl, existingKey)
        ) {
          ctx.logger?.info(
            "Existing agent API key in vault {vault} still authenticates; " +
              "reusing it.",
            { vault: g.vaultName },
          );
          const handle = await ctx.writeResource("agentKey", "agentKey", {
            team: g.agentTeamName,
            teamUuid: "",
            apiUrl: backendUrl,
            bomEndpoint: `${backendUrl}/api/v1/bom`,
            adminRotated: false,
            createdAt: new Date().toISOString(),
            reused: true,
          });
          return { dataHandles: [handle] };
        }

        // Rotate the admin password (if needed) and get a JWT. Try the stored
        // password first, then the Dependency-Track default "admin" (in case
        // the vault holds a stale value from a database that was recreated).
        const storedAdmin = args.adminPassword ||
          await readVaultSecret(ctx, g.adminSecretKey);
        const newAdmin = args.adminPassword || generateAdminPassword();
        const session = await loginWithRotation(
          adminUrl,
          g.adminUser,
          [storedAdmin, "admin"],
          newAdmin,
          ctx.logger,
        );
        if (session.rotated || !storedAdmin) {
          await vaultPut(g.vaultName, g.adminSecretKey, newAdmin);
        }

        const team = await ensureTeam(
          adminUrl,
          session.token,
          g.agentTeamName,
        );
        for (const permission of g.agentTeamPermissions) {
          await grantTeamPermission(
            adminUrl,
            session.token,
            team.uuid,
            permission,
          );
        }
        const created = await createApiKey(
          adminUrl,
          session.token,
          team.uuid,
        );
        await vaultPut(g.vaultName, g.apiKeySecretKey, created.key);

        const handle = await ctx.writeResource("agentKey", "agentKey", {
          team: team.name,
          teamUuid: team.uuid,
          publicId: created.publicId,
          apiUrl: backendUrl,
          bomEndpoint: `${backendUrl}/api/v1/bom`,
          adminRotated: session.rotated,
          createdAt: new Date().toISOString(),
          reused: false,
        });
        ctx.logger?.info(
          "Provisioned agent API key for team '{team}' and stored it in vault " +
            "{vault} as {key}. SBOM upload: POST {bom} with header X-Api-Key.",
          {
            team: team.name,
            vault: g.vaultName,
            key: g.apiKeySecretKey,
            bom: `${backendUrl}/api/v1/bom`,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report whether the API server and frontend are running and the API " +
        "is answering.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const modelName = ctx.definition?.name ?? "";
        const names = containerNames(g.containerPrefix, modelName);
        const backendUrl = resolveBackendUrl(g);
        const frontendUrl = resolveFrontendUrl(g);
        const adminUrl = resolveAdminBaseUrl(g);

        const api = await callService(
          ctx,
          names.serviceModel,
          "serviceStatus",
          {
            containerName: names.api,
            serviceBackend: g.serviceBackend,
          },
        ) as { running?: boolean; state?: string } | undefined;
        const fe = await callService(ctx, names.serviceModel, "serviceStatus", {
          containerName: names.frontend,
          serviceBackend: g.serviceBackend,
        }) as { running?: boolean; state?: string } | undefined;

        const ready = await waitForApi(adminUrl, 5000, 1000);
        let version: string | undefined;
        if (ready.up) {
          try {
            const res = await fetch(`${adminUrl}/api/version`, {
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const body = await res.json() as { version?: string };
              version = body?.version;
            }
          } catch {
            version = undefined;
          }
        }

        const handle = await ctx.writeResource("status", "status", {
          apiReady: ready.up,
          apiState: api?.state ?? "absent",
          frontendRunning: fe?.running ?? false,
          frontendState: fe?.state ?? "absent",
          version,
          backendUrl,
          frontendUrl,
        });
        ctx.logger?.info(
          "Dependency-Track: api {apiState} (ready={ready}), frontend " +
            "{frontendState}",
          {
            apiState: api?.state ?? "absent",
            ready: ready.up,
            frontendState: fe?.state ?? "absent",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    remove: {
      description:
        "Stop and delete the API server and frontend containers (destructive). " +
        "The database is left untouched.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const modelName = ctx.definition?.name ?? "";
        const names = containerNames(g.containerPrefix, modelName);
        for (const c of [names.frontend, names.api]) {
          await callService(ctx, names.serviceModel, "service", {
            containerName: c,
            action: "remove",
            serviceBackend: g.serviceBackend,
          });
        }
        const handle = await ctx.writeResource("remove", "remove", {
          removed: true,
          containers: [names.frontend, names.api],
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
