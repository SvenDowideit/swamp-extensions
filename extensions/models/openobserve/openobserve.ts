/**
 * @svendowideit/openobserve
 *
 * Query and operate a self-hosted OpenObserve instance from swamp over its
 * REST/SQL API. OpenObserve is one engine for logs, metrics, and traces, so a
 * single SQL surface answers cross-signal questions — including the fleet
 * state-awareness joins ("inventory says these hosts are managed; the telemetry
 * says these are reporting; which are missing?").
 *
 * This model is read-mostly and idempotent: `query` runs arbitrary SQL, `streams`
 * lists streams and their doc counts, `retention` reports each stream's
 * configured retention, and `health` probes the instance (a refused connection
 * is a *health* result, not a model error, so a down instance is distinguishable
 * from a broken check). Credentials are read from a swamp vault and sent as a
 * Basic auth header — never inlined in a model definition.
 *
 * The SQL builder and response parsing are pure and unit-tested; only `health`,
 * `query`, `streams`, and `retention` touch the network.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

/** The vault key OpenObserve's own install seeds the login secret under. */
const DEFAULT_AUTH_REF = "ZO_ROOT_USER_PASSWORD";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().default("http://127.0.0.1:5080").describe(
    "OpenObserve base URL (no trailing slash)",
  ),
  organization: z.string().default("default").describe(
    "Organization to query and operate on",
  ),
  vaultName: z.string().default("").describe(
    "Vault holding the credentials (required unless user/password auth is disabled)",
  ),
  emailKey: z.string().default("ZO_ROOT_USER_EMAIL").describe(
    "Vault key holding the login email",
  ),
  authRef: z.string().default(DEFAULT_AUTH_REF).describe(
    "Vault key holding the login secret used for Basic auth",
  ),
  authHeaderKey: z.string().default("").describe(
    "Vault key holding a ready-made Authorization header value; wins over email/password when set",
  ),
  timeoutMs: z.number().int().positive().default(30000).describe(
    "Per-request timeout in milliseconds",
  ),
  defaultSize: z.number().int().min(1).max(10000).default(100).describe(
    "Default number of rows a query returns when no size is given",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const QueryArgsSchema = z.object({
  sql: z.string().min(1).describe(
    'SQL to run, e.g. select * from "my-stream" order by _timestamp desc limit 10',
  ),
  type: z.enum(["logs", "metrics", "traces"]).default("logs").describe(
    "Signal the query targets (selects the search endpoint)",
  ),
  startTime: z.number().int().optional().describe(
    "Start of the query window in microseconds since epoch; defaults to 1 hour before endTime",
  ),
  endTime: z.number().int().optional().describe(
    "End of the query window in microseconds since epoch; defaults to now",
  ),
  size: z.number().int().min(1).max(10000).optional().describe(
    "Maximum rows to return (defaults to the model's defaultSize)",
  ),
});

const StreamsArgsSchema = z.object({
  type: z.enum(["logs", "metrics", "traces"]).optional().describe(
    "Filter streams to one signal; empty lists every signal",
  ),
});

const RetentionArgsSchema = z.object({
  stream: z.string().optional().describe(
    "A single stream to report; empty reports every stream",
  ),
});

const HealthArgsSchema = z.object({}).describe("No arguments");

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const QueryOutputSchema = z.object({
  sql: z.string(),
  type: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  total: z.number(),
  took: z.number(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  queriedAt: z.string(),
});

const StreamsOutputSchema = z.object({
  count: z.number(),
  streams: z.array(
    z.object({
      name: z.string(),
      streamType: z.string(),
      storageType: z.string(),
      docNum: z.number(),
      storageSize: z.number(),
    }),
  ),
  fetchedAt: z.string(),
});

const RetentionOutputSchema = z.object({
  count: z.number(),
  streams: z.array(
    z.object({
      name: z.string(),
      streamType: z.string(),
      dataRetentionDays: z.number(),
    }),
  ),
  fetchedAt: z.string(),
});

const HealthOutputSchema = z.object({
  baseUrl: z.string(),
  reachable: z.boolean(),
  healthy: z.boolean(),
  statusCode: z.number(),
  status: z.string(),
  version: z.string(),
  checksAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~`; home is injectable so the helper stays pure. */
export function expandHome(path: string, homeDir?: string): string {
  if (!path.startsWith("~")) return path;
  const home = homeDir ?? Deno.env.get("HOME") ?? "~";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** Normalise a base URL (drop trailing slashes). */
export function normaliseBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Microseconds now, for the default query window. */
export function nowMicros(): number {
  return Date.now() * 1000;
}

/** Resolve the [startTime, endTime] window, defaulting to the last hour. */
export function resolveWindow(
  startTime: number | undefined,
  endTime: number | undefined,
): { startTime: number; endTime: number } {
  const end = endTime ?? nowMicros();
  const start = startTime ?? end - 3600 * 1_000_000;
  if (start >= end) {
    throw new Error(`startTime (${start}) must be before endTime (${end})`);
  }
  return { startTime: start, endTime: end };
}

/** Whether a SQL string looks like a mutation (OpenObserve search is read-only). */
export function looksLikeMutation(sql: string): boolean {
  return /^\s*(insert|update|delete|drop|alter|create|truncate|replace|merge)\b/i
    .test(sql);
}

/** The search endpoint URL for a signal type. */
export function searchUrl(
  baseUrl: string,
  organization: string,
  type: string,
): string {
  return `${
    normaliseBaseUrl(baseUrl)
  }/api/${organization}/_search?type=${type}`;
}

/** The streams endpoint URL for an organization. */
export function streamsUrl(
  baseUrl: string,
  organization: string,
  type?: string,
): string {
  const base = `${normaliseBaseUrl(baseUrl)}/api/${organization}/streams`;
  return type ? `${base}?type=${type}` : base;
}

/** The health endpoint URL. */
export function healthUrl(baseUrl: string): string {
  return `${normaliseBaseUrl(baseUrl)}/healthz`;
}

/**
 * Build the JSON body for an OpenObserve `_search` request. Times are
 * microseconds; the size defaults to `defaultSize`.
 */
export function buildSearchBody(args: {
  sql: string;
  startTime: number;
  endTime: number;
  size: number;
}): string {
  return JSON.stringify({
    query: {
      sql: args.sql,
      start_time: args.startTime,
      end_time: args.endTime,
    },
    size: args.size,
  });
}

/** Column names from a result row, in a stable order. */
export function columnsOf(row: Record<string, unknown>): string[] {
  return Object.keys(row).sort();
}

/** Extract the rows and metadata from an OpenObserve `_search` response. */
export function parseSearchResponse(body: unknown): {
  total: number;
  took: number;
  rows: Record<string, unknown>[];
} {
  const obj = (body ?? {}) as Record<string, unknown>;
  const hits = Array.isArray(obj.hits) ? obj.hits : [];
  return {
    total: typeof obj.total === "number" ? obj.total : hits.length,
    took: typeof obj.took === "number" ? obj.took : 0,
    rows: hits as Record<string, unknown>[],
  };
}

/** Extract the stream list from a `/streams` response. */
export function parseStreamsResponse(body: unknown): Array<{
  name: string;
  streamType: string;
  storageType: string;
  docNum: number;
  storageSize: number;
  dataRetentionDays: number;
}> {
  const obj = (body ?? {}) as { list?: unknown[] };
  const list = Array.isArray(obj.list) ? obj.list : [];
  return list.map((raw) => {
    const s = raw as Record<string, unknown>;
    const stats = (s.stats ?? {}) as Record<string, unknown>;
    const settings = (s.settings ?? {}) as Record<string, unknown>;
    return {
      name: String(s.name ?? ""),
      streamType: String(s.stream_type ?? ""),
      storageType: String(s.storage_type ?? ""),
      docNum: Number(stats.doc_num ?? 0),
      storageSize: Number(stats.storage_size ?? 0),
      dataRetentionDays: Number(settings.data_retention ?? 0),
    };
  });
}

/** Base64 of `email:password` (UTF-8 safe). */
export function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The Basic Authorization header value for email/password auth. */
export function basicAuth(email: string, password: string): string {
  return `Basic ${base64Encode(`${email}:${password}`)}`;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
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

async function readVaultSecret(
  ctx: MethodContext,
  key: string,
): Promise<string> {
  if (!ctx.vaultService || !ctx.globalArgs.vaultName || !key) return "";
  try {
    return await ctx.vaultService.get(
      ctx.globalArgs.vaultName,
      key,
      "model:openobserve",
    );
  } catch {
    return "";
  }
}

/** Resolve the Authorization header value from the vault. */
async function resolveAuth(ctx: MethodContext): Promise<string> {
  const g = ctx.globalArgs;
  if (g.authHeaderKey) {
    const header = await readVaultSecret(ctx, g.authHeaderKey);
    if (!header) {
      throw new Error(
        `vault '${g.vaultName}' has no secret '${g.authHeaderKey}' (authHeaderKey)`,
      );
    }
    return header;
  }
  const email = await readVaultSecret(ctx, g.emailKey);
  const password = await readVaultSecret(ctx, g.authRef);
  if (!email || !password) {
    throw new Error(
      `could not read credentials from vault '${g.vaultName}': store them with ` +
        `\`swamp vault put ${g.vaultName} ${g.emailKey}\` and ` +
        `\`swamp vault put ${g.vaultName} ${g.authRef}\``,
    );
  }
  return basicAuth(email, password);
}

/** GET a URL with the resolved auth, returning status and parsed JSON. */
async function getJson(
  ctx: MethodContext,
  url: string,
): Promise<{ status: number; body: unknown; text: string }> {
  const auth = await resolveAuth(ctx);
  try {
    const res = await fetch(url, {
      headers: { Authorization: auth, "User-Agent": "swamp-openobserve/1.0" },
      signal: AbortSignal.timeout(ctx.globalArgs.timeoutMs),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  } catch (err) {
    return {
      status: 0,
      body: null,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}

/** POST a search request with the resolved auth. */
async function postSearch(
  ctx: MethodContext,
  url: string,
  body: string,
): Promise<{ status: number; body: unknown; text: string }> {
  const auth = await resolveAuth(ctx);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "User-Agent": "swamp-openobserve/1.0",
      },
      body,
      signal: AbortSignal.timeout(ctx.globalArgs.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  } catch (err) {
    return {
      status: 0,
      body: null,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The swamp model definition for `@svendowideit/openobserve`. */
export const model = {
  type: "@svendowideit/openobserve",
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "read-only-sql": {
      description:
        "Reject a mutation before it reaches the read-only search API",
      labels: ["policy"],
      appliesTo: ["query"],
      execute: (context: {
        globalArgs: GlobalArgs;
        methodArgs?: { sql?: string };
      }): { pass: boolean; errors?: string[] } => {
        const sql = context.methodArgs?.sql ?? "";
        if (sql && looksLikeMutation(sql)) {
          return {
            pass: false,
            errors: [
              "query is read-only: use SQL that SELECTs (INSERT/UPDATE/DELETE/DDL are rejected)",
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
        "Initial release: query and operate a self-hosted OpenObserve over its REST/SQL API. Methods: query (arbitrary SQL, microsecond windows), streams (names + doc counts), retention (per-stream), health (instance probe). Vault-backed Basic auth; read-only SQL guard.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    query: {
      description: "Last SQL query result",
      schema: QueryOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    streams: {
      description: "Streams and their document counts",
      schema: StreamsOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    retention: {
      description: "Per-stream retention",
      schema: RetentionOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    health: {
      description: "Instance health result",
      schema: HealthOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    query: {
      description: "Run SQL against OpenObserve and store the rows",
      arguments: QueryArgsSchema,
      execute: async (
        args: z.infer<typeof QueryArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const window = resolveWindow(args.startTime, args.endTime);
        const size = args.size ?? g.defaultSize;
        const body = buildSearchBody({
          sql: args.sql,
          startTime: window.startTime,
          endTime: window.endTime,
          size,
        });
        const url = searchUrl(g.baseUrl, g.organization, args.type);
        const res = await postSearch(context, url, body);
        if (res.status !== 200) {
          throw new Error(
            `query failed (HTTP ${res.status}): ${truncate(res.text)}`,
          );
        }
        const parsed = parseSearchResponse(res.body);
        context.logger?.info("Query returned {total} row(s) in {took}ms", {
          total: parsed.total,
          took: parsed.took,
        });
        const handle = await context.writeResource("query", "last", {
          sql: args.sql,
          type: args.type,
          startTime: window.startTime,
          endTime: window.endTime,
          total: parsed.total,
          took: parsed.took,
          columns: parsed.rows.length > 0 ? columnsOf(parsed.rows[0]) : [],
          rows: parsed.rows,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    streams: {
      description:
        "List streams (optionally by signal) with their document counts",
      arguments: StreamsArgsSchema,
      execute: async (
        args: z.infer<typeof StreamsArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const res = await getJson(
          context,
          streamsUrl(g.baseUrl, g.organization, args.type),
        );
        if (res.status !== 200) {
          throw new Error(
            `listing streams failed (HTTP ${res.status}): ${
              truncate(res.text)
            }`,
          );
        }
        const all = parseStreamsResponse(res.body);
        const streams = args.type
          ? all.filter((s) => s.streamType === args.type)
          : all;
        context.logger?.info("Found {count} stream(s)", {
          count: streams.length,
        });
        const handle = await context.writeResource("streams", "streams", {
          count: streams.length,
          streams: streams.map((s) => ({
            name: s.name,
            streamType: s.streamType,
            storageType: s.storageType,
            docNum: s.docNum,
            storageSize: s.storageSize,
          })),
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    retention: {
      description: "Report the configured data retention for streams",
      arguments: RetentionArgsSchema,
      execute: async (
        args: z.infer<typeof RetentionArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const res = await getJson(
          context,
          streamsUrl(g.baseUrl, g.organization),
        );
        if (res.status !== 200) {
          throw new Error(
            `listing streams failed (HTTP ${res.status}): ${
              truncate(res.text)
            }`,
          );
        }
        let streams = parseStreamsResponse(res.body);
        if (args.stream) {
          streams = streams.filter((s) => s.name === args.stream);
        }
        const handle = await context.writeResource("retention", "retention", {
          count: streams.length,
          streams: streams.map((s) => ({
            name: s.name,
            streamType: s.streamType,
            dataRetentionDays: s.dataRetentionDays,
          })),
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    health: {
      description:
        "Probe the OpenObserve instance (a refusal is a health result, not an error)",
      arguments: HealthArgsSchema,
      execute: async (
        _args: z.infer<typeof HealthArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const res = await getJson(context, healthUrl(g.baseUrl));
        const body = (res.body ?? {}) as Record<string, unknown>;
        const reachable = res.status !== 0;
        const healthy = res.status === 200 &&
          String(body.status ?? "").toLowerCase() === "ok";
        // Also read the build version from /config when reachable.
        let version = "";
        if (reachable) {
          const cfg = await getJson(
            context,
            `${normaliseBaseUrl(g.baseUrl)}/config`,
          );
          version = String(
            ((cfg.body ?? {}) as Record<string, unknown>).version ?? "",
          );
        }
        context.logger?.info(
          "OpenObserve {baseUrl}: reachable={reachable} healthy={healthy}",
          {
            baseUrl: g.baseUrl,
            reachable,
            healthy,
          },
        );
        const handle = await context.writeResource("health", "health", {
          baseUrl: normaliseBaseUrl(g.baseUrl),
          reachable,
          healthy,
          statusCode: res.status,
          status: String(body.status ?? (reachable ? "" : res.text)),
          version,
          checksAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Truncate a response body for an error message. */
function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
