/**
 * @svendowideit/otel-backend
 *
 * Stand up a self-hosted observability backend (logs + metrics + traces) as a
 * long-lived service, from a small set of **profiles**. OpenObserve is the
 * profile shipped and tested first.
 *
 * The backend is modelled as a swappable profile rather than a hardcoded stack:
 * the contract — image, ports, data mount, environment variable names, OTLP
 * path shape, health path — is a plain data structure. A future LGTM /
 * VictoriaMetrics / ClickHouse lane is a new profile, not a rewrite. The
 * gateway (a collector) owns routing, so the lane can change without touching a
 * single host.
 *
 * The default `openobserve` profile runs the published container image under
 * Docker. The published static binaries are *not* used because
 * `downloads.openobserve.ai` rejects non-browser clients (HTTP 403), whereas the
 * container image is the supported, checksum-verified-by-the-registry path.
 *
 * All model and method logic that can be pure is pure and exported for unit
 * testing; the only side effects are Docker commands and reads of the swamp
 * vault, both in the `install`/`configure`/`upgrade`/`remove` methods.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Backend profiles
// ---------------------------------------------------------------------------

/** The provider-agnostic contract a backend profile must satisfy. */
export interface BackendProfile {
  /** Profile id (used by the `profile` global arg). */
  name: string;
  /** Human description. */
  description: string;
  /** Default container image (tag may be overridden by the `image` global arg). */
  image: string;
  /** Container ports: the UI/HTTP API and the OTLP gRPC receiver. */
  containerPorts: { ui: number; grpc: number };
  /** Where the profile expects its persistent data inside the container. */
  dataMount: string;
  /** Env var that points the profile at its data directory. */
  dataDirEnv: string;
  /** Env var for the admin/root user email. */
  rootUserEmailEnv: string;
  /** Env var for the admin/root user password. */
  rootUserPasswordEnv: string;
  /** Password policy the store enforces at first start, if any. */
  rootPasswordPolicy?: {
    /** Human description of the policy. */
    description: string;
    /** Whether a password satisfies the policy. */
    test: (password: string) => boolean;
  };
  /** Env var for the organization, when the profile has one. */
  orgEnv: string;
  /** Health endpoint path on the UI port. */
  healthPath: string;
  /** OTLP/HTTP base path for an organization, *without* a trailing slash. */
  otlpHttpBasePath: (org: string) => string;
  /** Documentation URL for ingestion configuration. */
  docsUrl: string;
}

/** OpenObserve: one Rust binary, Parquet storage, SQL across all signals. */
export const OPENOBSERVE_PROFILE: BackendProfile = {
  name: "openobserve",
  description:
    "OpenObserve single-node: one engine for logs, metrics, and traces (Parquet, SQL query API).",
  image: "public.ecr.aws/zinclabs/openobserve:latest",
  containerPorts: { ui: 5080, grpc: 5081 },
  dataMount: "/data",
  dataDirEnv: "ZO_DATA_DIR",
  rootUserEmailEnv: "ZO_ROOT_USER_EMAIL",
  rootUserPasswordEnv: "ZO_ROOT_USER_PASSWORD",
  rootPasswordPolicy: {
    description:
      "8-128 characters with at least one lowercase letter, one uppercase letter, one digit, and one special character",
    test: (password: string) =>
      password.length >= 8 && password.length <= 128 &&
      /[a-z]/.test(password) && /[A-Z]/.test(password) &&
      /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password),
  },
  orgEnv: "ZO_ORG",
  healthPath: "/healthz",
  otlpHttpBasePath: (org: string) => `/api/${org}`,
  docsUrl: "https://openobserve.ai/docs/ingestion/logs/otlp/",
};

/** All shipped profiles, keyed by profile name. */
export const PROFILES: Record<string, BackendProfile> = {
  [OPENOBSERVE_PROFILE.name]: OPENOBSERVE_PROFILE,
};

/** Resolve a profile by name, throwing a helpful error when unknown. */
export function resolveProfile(name: string): BackendProfile {
  const profile = PROFILES[name];
  if (!profile) {
    const known = Object.keys(PROFILES).sort().join(", ");
    throw new Error(`unknown backend profile '${name}' (known: ${known})`);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  profile: z.string().default("openobserve").describe(
    "Backend profile to run (openobserve)",
  ),
  image: z.string().default("").describe(
    "Container image to run; empty uses the profile's default image",
  ),
  port: z.number().int().min(1).max(65535).default(5080).describe(
    "Host port for the UI and OTLP/HTTP API",
  ),
  grpcPort: z.number().int().min(1).max(65535).default(5081).describe(
    "Host port for the OTLP/gRPC receiver",
  ),
  bindAddress: z.string().default("127.0.0.1").describe(
    "Host address to bind the published ports to (127.0.0.1 is local-only; set a mesh/LAN address to expose it)",
  ),
  dataDir: z.string().default("~/.local/share/otel-backend").describe(
    "Host directory persisted as the backend's data volume",
  ),
  vaultName: z.string().default("").describe(
    "Vault holding the admin credentials (never inlined); required for openobserve",
  ),
  rootUserEmail: z.string().default("").describe(
    "Admin email to seed on first start; read from the vault when empty",
  ),
  organization: z.string().default("default").describe(
    "Organization the backend serves and the OTLP path is scoped to",
  ),
  containerName: z.string().default("").describe(
    "Container name; empty derives it from the model name",
  ),
  restartPolicy: z.string().default("unless-stopped").describe(
    "Docker restart policy for the container",
  ),
  healthTimeoutMs: z.number().int().positive().default(60000).describe(
    "How long to wait for the backend to answer healthy after a (re)start",
  ),
  extraEnv: z.record(z.string(), z.string()).default({}).describe(
    "Extra environment variables passed to the container",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstallArgsSchema = z.object({
  image: z.string().optional().describe(
    "Override the global image for this run",
  ),
});
const ConfigureArgsSchema = z.object({}).describe("No arguments");
const StatusArgsSchema = z.object({}).describe("No arguments");
const UpgradeArgsSchema = z.object({
  image: z.string().optional().describe(
    "Explicit image tag to move to; empty uses the profile's default tag",
  ),
});
const RemoveArgsSchema = z.object({
  removeData: z.boolean().default(false).describe(
    "Also delete the persisted host data directory (destructive)",
  ),
});
const ProfileArgsSchema = z.object({}).describe("No arguments");

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const EndpointsSchema = z.object({
  ui: z.string(),
  otlpHttp: z.string(),
  otlpGrpc: z.string(),
  organization: z.string(),
});

const InstallOutputSchema = z.object({
  profile: z.string(),
  image: z.string(),
  containerName: z.string(),
  dataDir: z.string(),
  endpoints: EndpointsSchema,
  healthy: z.boolean(),
  created: z.boolean(),
  replaced: z.boolean(),
  pulled: z.boolean(),
  installedAt: z.string(),
});

const StatusOutputSchema = z.object({
  profile: z.string(),
  image: z.string(),
  containerName: z.string(),
  exists: z.boolean(),
  running: z.boolean(),
  containerStatus: z.string(),
  healthy: z.boolean(),
  healthStatusCode: z.number().int(),
  endpoints: EndpointsSchema,
  dataDir: z.string(),
  checkedAt: z.string(),
});

const ProfileOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  image: z.string(),
  containerPorts: z.object({ ui: z.number(), grpc: z.number() }),
  dataMount: z.string(),
  healthPath: z.string(),
  docsUrl: z.string(),
});

const RemoveOutputSchema = z.object({
  containerName: z.string(),
  removed: z.boolean(),
  dataDir: z.string(),
  dataRemoved: z.boolean(),
  dataRemoveError: z.string().default(""),
  removedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to `$HOME` (Deno does not expand it in paths). The home
 * directory is injectable so the helper stays pure and unit-testable.
 */
export function expandHome(path: string, homeDir?: string): string {
  if (!path.startsWith("~")) return path;
  const home = homeDir ?? Deno.env.get("HOME") ?? "~";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** A Docker-safe container name derived from a swamp model name. */
export function containerNameFor(modelName: string, override: string): string {
  if (override.trim()) return override.trim();
  const slug = modelName.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  return `otel-backend-${slug || "default"}`;
}

/** The resolved OTLP/UI endpoints for a backend on a host. */
export interface Endpoints {
  /** UI/HTTP API URL. */
  ui: string;
  /** OTLP/HTTP base URL (collector appends `/v1/{logs,metrics,traces}`). */
  otlpHttp: string;
  /** OTLP/gRPC host:port. */
  otlpGrpc: string;
  /** Organization the paths are scoped to. */
  organization: string;
}

/** Resolve the endpoints a collector or human should use. */
export function resolveEndpoints(args: {
  host: string;
  port: number;
  grpcPort: number;
  organization: string;
  profile: BackendProfile;
}): Endpoints {
  const { host, port, grpcPort, organization, profile } = args;
  return {
    ui: `http://${host}:${port}`,
    otlpHttp: `http://${host}:${port}${profile.otlpHttpBasePath(organization)}`,
    otlpGrpc: `${host}:${grpcPort}`,
    organization,
  };
}

/** Build the `docker run` argument vector for a backend container. */
export function buildRunArgs(args: {
  profile: BackendProfile;
  image: string;
  containerName: string;
  modelName: string;
  bindAddress: string;
  port: number;
  grpcPort: number;
  dataDir: string;
  restartPolicy: string;
  desiredHash: string;
  env: Record<string, string>;
}): string[] {
  const { profile, image, containerName, modelName } = args;
  const out: string[] = [
    "run",
    "-d",
    "--name",
    containerName,
    "--restart",
    args.restartPolicy,
    "-p",
    `${args.bindAddress}:${args.port}:${profile.containerPorts.ui}`,
    "-p",
    `${args.bindAddress}:${args.grpcPort}:${profile.containerPorts.grpc}`,
    "-v",
    `${args.dataDir}:${profile.dataMount}`,
    "-l",
    `swamp.model=${modelName}`,
    "-l",
    `swamp.desired=${args.desiredHash}`,
  ];
  for (const [key, value] of Object.entries(args.env).sort()) {
    if (value === "") continue;
    out.push("-e", `${key}=${value}`);
  }
  out.push(image);
  return out;
}

/**
 * A stable hash of everything that, if changed, requires recreating the
 * container: image, ports, bind, data dir, restart policy, and env names.
 *
 * Secret values are *not* hashed — changing a password should be applied by
 * `configure`, which recreates the container regardless — so the hash stays
 * non-sensitive.
 */
export function desiredHashFor(args: {
  image: string;
  port: number;
  grpcPort: number;
  bindAddress: string;
  dataDir: string;
  restartPolicy: string;
  envKeys: string[];
}): string {
  const canonical = JSON.stringify({
    image: args.image,
    port: args.port,
    grpcPort: args.grpcPort,
    bindAddress: args.bindAddress,
    dataDir: args.dataDir,
    restartPolicy: args.restartPolicy,
    envKeys: [...args.envKeys].sort(),
  });
  return fnv1aHex(canonical);
}

/** Small, dependency-free 32-bit FNV-1a hash rendered as 8 hex chars. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Base64 of `email:password`, the value of an OpenObserve `Authorization` header. */
export function basicAuthHeader(email: string, password: string): string {
  const raw = `${email}:${password}`;
  return `Basic ${base64Encode(raw)}`;
}

/** UTF-8 safe base64 (no Node Buffer). */
export function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Whether `docker inspect` reported a container exists and is running. */
export function parseContainerState(inspectJson: string): {
  exists: boolean;
  running: boolean;
  status: string;
  desiredHash: string;
} {
  try {
    const parsed = JSON.parse(inspectJson);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!entry) {
      return { exists: false, running: false, status: "", desiredHash: "" };
    }
    const running = entry?.State?.Running === true;
    const status = String(entry?.State?.Status ?? "");
    const labels = entry?.Config?.Labels ?? {};
    return {
      exists: true,
      running,
      status,
      desiredHash: String(labels["swamp.desired"] ?? ""),
    };
  } catch {
    return { exists: false, running: false, status: "", desiredHash: "" };
  }
}

/** Format a health result as a one-line summary for logs. */
export function healthSummary(result: {
  healthy: boolean;
  statusCode: number;
  attempts: number;
}): string {
  if (result.healthy) {
    return `healthy after ${result.attempts} attempt(s) (HTTP ${result.statusCode})`;
  }
  return result.statusCode === 0
    ? `no response after ${result.attempts} attempt(s)`
    : `unhealthy after ${result.attempts} attempt(s) (HTTP ${result.statusCode})`;
}

/** The exact curl that proves OTLP/HTTP ingestion works for a stream. */
export function ingestCurl(
  endpoints: Endpoints,
  stream = "smoke-test",
): string {
  return `curl -sS -X POST '${endpoints.otlpHttp}/v1/logs' \\
  -H 'Content-Type: application/json' \\
  -H 'stream-name: ${stream}' \\
  -H "Authorization: Basic \\$(printf '%s' '<email>:<password>' | base64 -w0)" \\
  -d '{"resourceLogs":[]}'`;
}

// ---------------------------------------------------------------------------
// Effectful helpers (Docker, HTTP, vault)
// ---------------------------------------------------------------------------

type CmdResult = { stdout: string; stderr: string; code: number };

async function runCmd(binary: string, args: string[]): Promise<CmdResult> {
  try {
    const proc = new Deno.Command(binary, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/** Whether the Docker CLI and daemon are reachable. */
export async function dockerAvailable(): Promise<boolean> {
  const res = await runCmd("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  return res.code === 0;
}

/** Inspect a container; returns "" when it does not exist. */
async function dockerInspect(containerName: string): Promise<string> {
  const res = await runCmd("docker", ["inspect", containerName]);
  return res.code === 0 ? res.stdout : "";
}

/**
 * Poll the health endpoint until it answers 2xx, or the deadline passes.
 * A refused connection or timeout is a *health* result, not a model error, so a
 * down backend is distinguishable from a broken check.
 */
export async function waitForHealth(
  url: string,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<{ healthy: boolean; statusCode: number; attempts: number }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let statusCode = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(5000, intervalMs * 4)),
      });
      statusCode = res.status;
      if (res.ok) return { healthy: true, statusCode, attempts };
    } catch {
      statusCode = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { healthy: false, statusCode, attempts };
}

// ---------------------------------------------------------------------------
// Method context (the subset of the swamp method API this model uses)
// ---------------------------------------------------------------------------

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
  ) => Promise<{ name: string }>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
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
      "model:otel-backend",
    );
  } catch {
    return "";
  }
}

/** Resolve the profile, image, container name, paths, and endpoints. */
function resolve(g: GlobalArgs, modelName: string) {
  const profile = resolveProfile(g.profile);
  const image = g.image.trim() || profile.image;
  const containerName = containerNameFor(modelName, g.containerName);
  const dataDir = expandHome(g.dataDir);
  const endpoints = resolveEndpoints({
    host: g.bindAddress === "0.0.0.0" || g.bindAddress === "::"
      ? "127.0.0.1"
      : g.bindAddress,
    port: g.port,
    grpcPort: g.grpcPort,
    organization: g.organization,
    profile,
  });
  return { profile, image, containerName, dataDir, endpoints };
}

/** The non-secret environment for the container, plus vault-sourced secrets. */
async function resolveEnv(
  ctx: MethodContext,
  profile: BackendProfile,
): Promise<Record<string, string>> {
  const g = ctx.globalArgs;
  const env: Record<string, string> = {
    [profile.dataDirEnv]: profile.dataMount,
    [profile.orgEnv]: g.organization,
    ...g.extraEnv,
  };
  const rawEmail = g.rootUserEmail.trim() ||
    (await readVaultSecret(ctx, profile.rootUserEmailEnv));
  const email = normaliseEmail(rawEmail, ctx, profile.rootUserEmailEnv);
  const password = await readVaultSecret(ctx, profile.rootUserPasswordEnv);
  if (email) env[profile.rootUserEmailEnv] = email;
  if (password) env[profile.rootUserPasswordEnv] = password;
  return env;
}

/**
 * Normalise the admin email before it reaches the container.
 *
 * OpenObserve's own email regex accepts only lowercase local/domain parts, so an
 * uppercase address (e.g. `SvenDowideit@home.org.au`) makes the container
 * crash-loop with a confusing "Please set root user email-id & password" panic.
 * Rather than let that happen, warn and lowercase it here.
 */
export function normaliseEmail(
  email: string,
  ctx?: {
    logger?: { warn: (msg: string, props?: Record<string, unknown>) => void };
  },
  key = "ZO_ROOT_USER_EMAIL",
): string {
  const trimmed = email.trim();
  if (trimmed !== "" && trimmed !== trimmed.toLowerCase()) {
    ctx?.logger?.warn(
      "{key} '{email}' contains uppercase letters, which the store rejects; " +
        "lowercasing it to '{lower}' on the way in.",
      { key, email: trimmed, lower: trimmed.toLowerCase() },
    );
  }
  return trimmed.toLowerCase();
}

/** Remove any existing container of this name (destructive to the container only). */
async function removeContainer(containerName: string): Promise<CmdResult> {
  return await runCmd("docker", ["rm", "-f", containerName]);
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/otel-backend`. */
export const model = {
  type: "@svendowideit/otel-backend",
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "known-profile": {
      description: "Reject an unknown backend profile before doing any work",
      labels: ["policy"],
      appliesTo: [
        "install",
        "configure",
        "status",
        "upgrade",
        "remove",
        "profile",
      ],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        if (!PROFILES[context.globalArgs.profile]) {
          return {
            pass: false,
            errors: [
              `unknown profile '${context.globalArgs.profile}' (known: ${
                Object.keys(PROFILES).sort().join(", ")
              })`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.03.1",
      description:
        "Initial release: profile-parameterised self-hosted observability backend. Ships the openobserve profile (Docker image, Parquet/SQL), install/configure/status/upgrade/remove/profile methods, vault-sourced admin credentials, and a health-gated install that prints the exact OTLP endpoint a gateway should export to and the curl that proves ingestion.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    install: {
      description: "Last install result",
      schema: InstallOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "Backend status and endpoints",
      schema: StatusOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    profile: {
      description: "The resolved backend profile contract",
      schema: ProfileOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    remove: {
      description: "Last remove result",
      schema: RemoveOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    install: {
      description:
        "Pull the backend image, run the container, and wait until it answers healthy",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const modelName = context.definition?.name ?? "";
        const resolved = resolve(g, modelName);
        const { profile, containerName, dataDir, endpoints } = resolved;
        const image = args.image?.trim() || resolved.image;

        if (!(await dockerAvailable())) {
          throw new Error(
            "Docker is not available. The openobserve profile runs the published " +
              "container image; install Docker (or point `image` at a reachable " +
              "runtime) and re-run install.",
          );
        }

        const env = await resolveEnv(context, profile);
        const desiredHash = desiredHashFor({
          image,
          port: g.port,
          grpcPort: g.grpcPort,
          bindAddress: g.bindAddress,
          dataDir,
          restartPolicy: g.restartPolicy,
          // Include the email value (non-secret) so correcting a rejected or
          // uppercased address forces the container to be recreated; exclude the
          // password value so no secret reaches the hash or container label.
          envKeys: Object.entries(env)
            .filter(([k]) => k !== profile.rootUserPasswordEnv)
            .map(([k, v]) => k === profile.rootUserEmailEnv ? `${k}=${v}` : k),
        });

        // Skip if an identical container is already running and healthy.
        const existing = parseContainerState(
          await dockerInspect(containerName),
        );
        const upToDate = existing.exists && existing.running &&
          existing.desiredHash === desiredHash;
        if (upToDate) {
          const health = await waitForHealth(
            `${endpoints.ui}${profile.healthPath}`,
            g.healthTimeoutMs,
          );
          if (health.healthy) {
            context.logger?.info(
              "Backend {containerName} already running and up to date ({health})",
              { containerName, health: healthSummary(health) },
            );
            const handle = await context.writeResource("install", "install", {
              profile: profile.name,
              image,
              containerName,
              dataDir,
              endpoints,
              healthy: true,
              created: false,
              replaced: false,
              pulled: false,
              installedAt: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }
          // Up to date by config but not answering — a crash-loop (often a
          // changed credential the container env still holds). Fall through and
          // recreate it with the current desired state.
          context.logger?.warn(
            "Backend {containerName} matches the desired state but is " +
              "{status}; recreating it.",
            { containerName, status: existing.status || "unhealthy" },
          );
        }

        const replaced = existing.exists;
        if (replaced) {
          await removeContainer(containerName);
        }

        // Only a *new* container initialises the admin user, so both credential
        // env vars are required here — a fresh container without them
        // crash-loops. An already-initialised container is reused above without
        // this check. The password is validated against the profile's policy
        // before the container starts, so a weak one fails fast with a clear
        // message rather than a crash-loop.
        const missing = [profile.rootUserEmailEnv, profile.rootUserPasswordEnv]
          .filter((key) => !env[key]);
        if (missing.length > 0) {
          throw new Error(
            `admin credentials not found: the ${profile.name} profile seeds its ` +
              `first admin user from ${profile.rootUserEmailEnv} and ` +
              `${profile.rootUserPasswordEnv} at first start, so both are ` +
              `required. Store the missing key(s) ${missing.join(", ")} with ` +
              missing.map((k) => `\`swamp vault put ${g.vaultName} ${k}\``)
                .join(" and ") +
              ` (and set the vaultName global arg). Without them the container ` +
              `crash-loops.`,
          );
        }
        const password = env[profile.rootUserPasswordEnv];
        if (
          profile.rootPasswordPolicy &&
          !profile.rootPasswordPolicy.test(password)
        ) {
          throw new Error(
            `admin password rejected by the ${profile.name} policy: ` +
              `${profile.rootPasswordPolicy.description}. Re-store ` +
              `${profile.rootUserPasswordEnv} in vault '${g.vaultName}' with a ` +
              `stronger value (the password is validated here and never logged).`,
          );
        }

        await Deno.mkdir(dataDir, { recursive: true });
        const pull = await runCmd("docker", ["pull", image]);
        const pulled = pull.code === 0;

        const runArgs = buildRunArgs({
          profile,
          image,
          containerName,
          modelName,
          bindAddress: g.bindAddress,
          port: g.port,
          grpcPort: g.grpcPort,
          dataDir,
          restartPolicy: g.restartPolicy,
          desiredHash,
          env,
        });
        const run = await runCmd("docker", runArgs);
        if (run.code !== 0) {
          throw new Error(
            `docker run failed (${run.code}): ${
              run.stderr.trim() || run.stdout.trim()
            }`,
          );
        }

        const health = await waitForHealth(
          `${endpoints.ui}${profile.healthPath}`,
          g.healthTimeoutMs,
        );
        context.logger?.info(
          "Backend {containerName} started ({health}); OTLP/HTTP {otlpHttp}",
          {
            containerName,
            health: healthSummary(health),
            otlpHttp: endpoints.otlpHttp,
          },
        );
        if (!health.healthy) {
          // A freshly created container that never becomes healthy is almost
          // always crash-looping (e.g. missing/invalid admin credentials), so
          // fail rather than reporting a false success. Include the container
          // state and the tail of its logs so the cause is visible.
          const state = parseContainerState(await dockerInspect(containerName));
          const logs = await runCmd("docker", [
            "logs",
            "--tail",
            "20",
            containerName,
          ]);
          const tail = (logs.stderr || logs.stdout).trim();
          throw new Error(
            `backend ${containerName} did not become healthy within ` +
              `${g.healthTimeoutMs}ms and is ${
                state.status || "not running"
              }. ` +
              `Check \`docker logs ${containerName}\`. Last output:\n${tail}`,
          );
        }

        const handle = await context.writeResource("install", "install", {
          profile: profile.name,
          image,
          containerName,
          dataDir,
          endpoints,
          healthy: health.healthy,
          created: true,
          replaced,
          pulled,
          installedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description:
        "Re-render the container's configuration and recreate it if it changed",
      arguments: ConfigureArgsSchema,
      execute: async (
        _args: z.infer<typeof ConfigureArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        // configure is install on the desired state; delegate.
        return await (model.methods.install.execute as (
          a: Record<string, never>,
          c: MethodContext,
        ) => Promise<{ dataHandles: [{ name: string }] }>)({}, context);
      },
    },

    status: {
      description: "Report container state, health, and the OTLP endpoints",
      arguments: StatusArgsSchema,
      execute: async (
        _args: z.infer<typeof StatusArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const modelName = context.definition?.name ?? "";
        const { profile, image, containerName, dataDir, endpoints } = resolve(
          g,
          modelName,
        );
        const state = parseContainerState(await dockerInspect(containerName));
        let healthy = false;
        let statusCode = 0;
        if (state.running) {
          const health = await waitForHealth(
            `${endpoints.ui}${profile.healthPath}`,
            5000,
            500,
          );
          healthy = health.healthy;
          statusCode = health.statusCode;
        }
        context.logger?.info(
          "Backend {containerName}: {status}, healthy={healthy}",
          { containerName, status: state.status || "absent", healthy },
        );
        const handle = await context.writeResource("status", "status", {
          profile: profile.name,
          image,
          containerName,
          exists: state.exists,
          running: state.running,
          containerStatus: state.status,
          healthy,
          healthStatusCode: statusCode,
          endpoints,
          dataDir,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    upgrade: {
      description: "Pull a newer image and recreate the container on it",
      arguments: UpgradeArgsSchema,
      execute: async (
        args: z.infer<typeof UpgradeArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const modelName = context.definition?.name ?? "";
        const resolved = resolve(g, modelName);
        const image = args.image?.trim() || resolved.image;
        context.logger?.info("Upgrading backend {containerName} to {image}", {
          containerName: resolved.containerName,
          image,
        });
        return await (model.methods.install.execute as (
          a: { image: string },
          c: MethodContext,
        ) => Promise<{ dataHandles: [{ name: string }] }>)({ image }, context);
      },
    },

    remove: {
      description:
        "Stop and remove the backend container (optionally its data)",
      arguments: RemoveArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const modelName = context.definition?.name ?? "";
        const { containerName, dataDir } = resolve(g, modelName);
        const state = parseContainerState(await dockerInspect(containerName));
        if (state.exists) {
          await removeContainer(containerName);
        }
        let dataRemoved = false;
        let dataRemoveError = "";
        if (args.removeData) {
          try {
            await Deno.remove(dataDir, { recursive: true });
            dataRemoved = true;
          } catch (err) {
            if (err instanceof Deno.errors.NotFound) {
              // already absent — treat as done
            } else if (err instanceof Deno.errors.PermissionDenied) {
              // The container runs as root, so its data files are root-owned;
              // an unprivileged model cannot delete them. Report it clearly
              // rather than throwing an opaque error.
              dataRemoveError =
                `data directory is owned by the container (root); remove it ` +
                `with: sudo rm -rf ${dataDir}`;
              context.logger?.warn(
                "Could not delete {dataDir} (root-owned): run `sudo rm -rf " +
                  "{dataDir}` to reclaim the space.",
                { dataDir },
              );
            } else {
              throw err;
            }
          }
        }
        context.logger?.info(
          "Backend {containerName} removed{data}",
          {
            containerName,
            data: args.removeData
              ? dataRemoved ? " (data deleted)" : " (data not deleted)"
              : "",
          },
        );
        const handle = await context.writeResource("remove", "remove", {
          containerName,
          removed: state.exists,
          dataDir,
          dataRemoved,
          dataRemoveError,
          removedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    profile: {
      description: "Print the resolved backend profile contract",
      arguments: ProfileArgsSchema,
      execute: async (
        _args: z.infer<typeof ProfileArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const profile = resolveProfile(context.globalArgs.profile);
        const handle = await context.writeResource("profile", "profile", {
          name: profile.name,
          description: profile.description,
          image: profile.image,
          containerPorts: profile.containerPorts,
          dataMount: profile.dataMount,
          healthPath: profile.healthPath,
          docsUrl: profile.docsUrl,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
