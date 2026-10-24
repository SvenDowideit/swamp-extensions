/**
 * DreamHost DNS management via the official DreamHost API.
 *
 * A swamp model type (`@svendowideit/dreamhost/dns`) that wraps the only part
 * of the DreamHost API that still works in 2026: DNS records and API
 * introspection. DreamHost removed the account, domain, mail, database, and
 * user commands, so this model deliberately does not pretend to manage them.
 *
 * Methods:
 *   - `listRecords`  — fetch every DNS record on the account (optionally
 *                      filtered to one zone) into a versioned resource.
 *   - `listZones`    — derive the set of hosted zones from the DNS records,
 *                      which is the closest thing to a "list my domains"
 *                      call the live API still offers.
 *   - `listCommands` — ask the API which commands the configured key may
 *                      access; useful for diagnosing key-scope problems.
 *   - `addRecord`    — add one DNS record.
 *   - `removeRecord` — remove one DNS record (exact record/type/value match).
 *   - `syncRecords`  — idempotently reconcile a desired record set for a
 *                      zone, adding missing records and (optionally, with
 *                      `prune`) deleting editable records that are no longer
 *                      desired. DreamHost-managed records (`editable: 0`) are
 *                      never modified or deleted.
 *
 * The API key is supplied through the `authToken` global argument, usually as
 * a `${{ vault.get(...) }}` expression, so it never lands in the repository.
 *
 * Pure helpers (URL building, response normalization, record-name resolution,
 * and the sync diff) are exported for unit testing.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  authToken: z.string().optional().meta({ sensitive: true }).describe(
    "DreamHost API key; use a vault expression, e.g. " +
      "${{ vault.get('dreamhost', 'API_KEY') }}",
  ),
  apiBase: z.string().default("https://api.dreamhost.com").describe(
    "DreamHost API base URL",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ListRecordsArgsSchema = z.object({
  zone: z.string().optional().describe(
    "Only return records in this zone (domain), e.g. example.com",
  ),
});

const AddRecordArgsSchema = z.object({
  record: z.string().describe(
    "Record name: a full name (www.example.com), a short label (www) " +
      "resolved against the zone, or @ for the zone apex",
  ),
  type: z.string().describe(
    "Record type: A, AAAA, CNAME, MX, NAPTR, NS, SRV, or TXT",
  ),
  value: z.string().describe("Record value"),
  comment: z.string().optional().describe(
    "Optional comment stored with the record",
  ),
  zone: z.string().optional().describe(
    "Zone used to resolve a short record name (required when `record` has no dot)",
  ),
});

const RemoveRecordArgsSchema = z.object({
  record: z.string().describe("Record name (full name, short label, or @)"),
  type: z.string().describe("Record type"),
  value: z.string().describe("Record value (must match exactly)"),
  zone: z.string().optional().describe(
    "Zone used to resolve a short record name (required when `record` has no dot)",
  ),
});

const DesiredRecordSchema = z.object({
  record: z.string().describe("Full name, short label, or @ for the apex"),
  type: z.string().describe("Record type"),
  value: z.string().describe("Record value"),
  comment: z.string().optional().describe(
    "Comment to set when the record is added",
  ),
});

const SyncRecordsArgsSchema = z.object({
  zone: z.string().describe("Zone (domain) whose records are reconciled"),
  records: z.array(DesiredRecordSchema).describe(
    "Desired record set for the zone",
  ),
  prune: z.boolean().default(false).describe(
    "Delete editable records in the zone that are absent from `records`; " +
      "DreamHost-managed records are never deleted",
  ),
  dryRun: z.boolean().default(false).describe(
    "Compute the diff without applying any changes",
  ),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

export const RecordSchema = z.object({
  record: z.string(),
  type: z.string(),
  value: z.string(),
  comment: z.string(),
  zone: z.string(),
  editable: z.boolean(),
});

export const RecordsSchema = z.object({
  zone: z.string(),
  count: z.number(),
  editableCount: z.number(),
  records: z.array(RecordSchema),
  fetchedAt: z.string(),
});

export const ZonesSchema = z.object({
  count: z.number(),
  zones: z.array(z.object({
    zone: z.string(),
    recordCount: z.number(),
    editableCount: z.number(),
  })),
  fetchedAt: z.string(),
});

export const CommandsSchema = z.object({
  count: z.number(),
  commands: z.array(z.object({
    cmd: z.string(),
    args: z.string(),
    optargs: z.string(),
  })),
  fetchedAt: z.string(),
});

export const RecordChangeSchema = z.object({
  action: z.enum(["added", "removed"]),
  record: z.string(),
  type: z.string(),
  value: z.string(),
  zone: z.string(),
  message: z.string(),
  changedAt: z.string(),
});

export const SyncSchema = z.object({
  zone: z.string(),
  prune: z.boolean(),
  dryRun: z.boolean(),
  changed: z.boolean(),
  added: z.number(),
  removed: z.number(),
  unchanged: z.number(),
  protectedSkipped: z.number(),
  addedRecords: z.array(RecordSchema),
  removedRecords: z.array(RecordSchema),
  recordCount: z.number(),
  syncedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single DNS record as returned by `dns-list_records`. */
export interface DnsRecord {
  /** Fully-qualified record name. */
  record: string;
  /** Record type (A, AAAA, CNAME, MX, NAPTR, NS, SRV, TXT). */
  type: string;
  /** Record value. */
  value: string;
  /** Free-text comment; "" when unset. */
  comment: string;
  /** Zone (domain) the record belongs to. */
  zone: string;
  /** True when the customer may edit/delete the record. */
  editable: boolean;
}

/** A desired record supplied to `syncRecords`, after name resolution. */
export interface DesiredRecord {
  /** Fully-qualified record name. */
  record: string;
  /** Upper-cased record type. */
  type: string;
  /** Record value. */
  value: string;
  /** Optional comment used when adding. */
  comment: string;
}

/** The result of diffing a desired record set against the live records. */
export interface DnsSyncPlan {
  /** Records to add. */
  toAdd: DesiredRecord[];
  /** Existing records to delete (only when pruning). */
  toRemove: DnsRecord[];
  /** Desired records already present unchanged. */
  unchanged: DesiredRecord[];
  /** Desired-but-absent records skipped because DreamHost manages them. */
  protectedSkipped: DnsRecord[];
}

/** A minimal HTTP response abstraction used by the DreamHost client. */
export interface HttpResponse {
  /** HTTP status code. */
  status: number;
  /** Raw response body. */
  body: string;
}

/** An injected HTTP transport: the DreamHost API is a GET-only interface. */
export type FetchLike = (url: string) => Promise<HttpResponse>;

/** The record types DreamHost's DNS API accepts. */
export const RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NAPTR",
  "NS",
  "SRV",
  "TXT",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Lower-case and trim a domain or record name. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve a desired record name against a zone.
 *
 * `@` and the bare zone resolve to the zone apex; a name ending in the zone is
 * kept; a short label with no dot is appended to the zone; anything else (a
 * fully-qualified name in another zone) is kept as-is.
 */
export function resolveRecordName(name: string, zone: string): string {
  const n = normalizeName(name);
  const z = normalizeName(zone).replace(/\.+$/, "");
  if (n === "@" || n === "" || n === z) return z;
  if (n.endsWith(`.${z}`)) return n;
  if (!n.includes(".")) return `${n}.${z}`;
  return n;
}

/** Normalize a record type to upper case, validating against the allowed set. */
export function normalizeRecordType(type: string): string {
  const t = type.trim().toUpperCase();
  if (!(RECORD_TYPES as readonly string[]).includes(t)) {
    throw new Error(
      `Unsupported DNS record type '${type}'; expected one of ` +
        RECORD_TYPES.join(", "),
    );
  }
  return t;
}

/**
 * Build the API request URL for one command.
 *
 * `unique_id` guards against a command being applied twice: DreamHost only
 * consumes the id on success, so a retry with the same id is a no-op.
 */
export function buildApiUrl(
  base: string,
  key: string,
  cmd: string,
  params: Record<string, string> = {},
  uniqueId?: string,
): string {
  const url = new URL(base.replace(/\/+$/, "") + "/");
  url.searchParams.set("key", key);
  url.searchParams.set("cmd", cmd);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  if (uniqueId) url.searchParams.set("unique_id", uniqueId);
  return url.toString();
}

/** Extract the DreamHost error message from a parsed error response. */
export function errorMessage(raw: Record<string, unknown>): string {
  for (const key of ["data", "reason", "message", "error"]) {
    const value = raw[key];
    if (typeof value === "string" && value) return value;
  }
  return JSON.stringify(raw);
}

/** Normalize the `data` field of a `dns-list_records` response. */
export function parseRecords(data: unknown): DnsRecord[] {
  if (!Array.isArray(data)) return [];
  const records: DnsRecord[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.record !== "string") continue;
    records.push({
      record: normalizeName(raw.record),
      type: typeof raw.type === "string" ? raw.type.toUpperCase() : "",
      value: typeof raw.value === "string" ? raw.value : "",
      comment: typeof raw.comment === "string" ? raw.comment : "",
      zone: typeof raw.zone === "string" ? normalizeName(raw.zone) : "",
      editable: raw.editable === "1" || raw.editable === 1 ||
        raw.editable === true,
    });
  }
  return records;
}

/** Identity key for matching records: name, type, and value. */
export function recordKey(record: {
  record: string;
  type: string;
  value: string;
}): string {
  return `${
    normalizeName(record.record)
  }\u0000${record.type.trim().toUpperCase()}\u0000${record.value.trim()}`;
}

/**
 * Diff a desired record set against the live records for one zone.
 *
 * Only records belonging to `zone` are considered. With `prune`, editable
 * records absent from `desired` are removals; records DreamHost manages
 * (`editable: false`) are never proposed for deletion and are reported as
 * skipped instead.
 */
export function planDnsSync(
  desired: DesiredRecord[],
  current: DnsRecord[],
  zone: string,
  prune: boolean,
): DnsSyncPlan {
  const z = normalizeName(zone);
  const zoneRecords = current.filter((r) => r.zone === z);
  const liveByKey = new Map<string, DnsRecord>();
  for (const r of zoneRecords) liveByKey.set(recordKey(r), r);

  const desiredKeys = new Set<string>();
  const toAdd: DesiredRecord[] = [];
  const unchanged: DesiredRecord[] = [];
  for (const d of desired) {
    const key = recordKey(d);
    desiredKeys.add(key);
    if (liveByKey.has(key)) unchanged.push(d);
    else toAdd.push(d);
  }

  const toRemove: DnsRecord[] = [];
  const protectedSkipped: DnsRecord[] = [];
  if (prune) {
    for (const r of zoneRecords) {
      if (desiredKeys.has(recordKey(r))) continue;
      if (r.editable) toRemove.push(r);
      else protectedSkipped.push(r);
    }
  }

  return { toAdd, toRemove, unchanged, protectedSkipped };
}

// ---------------------------------------------------------------------------
// DreamHost API client
// ---------------------------------------------------------------------------

/** An error raised for a DreamHost API error response. */
export class DreamHostApiError extends Error {
  /** The command that failed. */
  readonly cmd: string;
  /** The raw error message returned by DreamHost. */
  readonly reason: string;

  /** Construct an API error for a command with DreamHost's reason text. */
  constructor(cmd: string, reason: string) {
    super(`DreamHost command '${cmd}' failed: ${reason}`);
    this.name = "DreamHostApiError";
    this.cmd = cmd;
    this.reason = reason;
  }
}

/** True when DreamHost asked the caller to slow down. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof DreamHostApiError &&
    /slow_down_bucko/i.test(err.reason);
}

/** Thin DreamHost API client over an injectable HTTP transport. */
export class DreamHostApi {
  private readonly base: string;
  private readonly key: string;
  private readonly fetchImpl: FetchLike;

  /** Construct a client from a base URL, API key, and HTTP transport. */
  constructor(opts: { base: string; key: string; fetchImpl: FetchLike }) {
    this.base = opts.base;
    this.key = opts.key;
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Call one API command and return its `data` payload.
   *
   * Throws {@link DreamHostApiError} when the response is an error envelope.
   */
  async call(
    cmd: string,
    params: Record<string, string> = {},
    uniqueId?: string,
  ): Promise<unknown> {
    const url = buildApiUrl(this.base, this.key, cmd, params, uniqueId);
    const res = await this.fetchImpl(url);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      throw new DreamHostApiError(
        cmd,
        `unparseable response (HTTP ${res.status}): ${res.body.slice(0, 200)}`,
      );
    }
    if (parsed.result !== "success") {
      throw new DreamHostApiError(cmd, errorMessage(parsed));
    }
    return parsed.data;
  }

  /** List every DNS record the key can see. */
  async listRecords(): Promise<DnsRecord[]> {
    return parseRecords(await this.call("dns-list_records"));
  }

  /** Add one DNS record. */
  async addRecord(
    record: string,
    type: string,
    value: string,
    comment?: string,
  ): Promise<string> {
    const params: Record<string, string> = { record, type, value };
    if (comment) params.comment = comment;
    const data = await this.call("dns-add_record", params, crypto.randomUUID());
    return typeof data === "string" ? data : "";
  }

  /** Remove one DNS record (exact record/type/value match). */
  async removeRecord(
    record: string,
    type: string,
    value: string,
  ): Promise<string> {
    const data = await this.call(
      "dns-remove_record",
      { record, type, value },
      crypto.randomUUID(),
    );
    return typeof data === "string" ? data : "";
  }

  /** List the API commands the configured key may access. */
  async listCommands(): Promise<
    Array<{
      cmd: string;
      args: string;
      optargs: string;
    }>
  > {
    const data = await this.call("api-list_accessible_cmds");
    if (!Array.isArray(data)) return [];
    const out: Array<{ cmd: string; args: string; optargs: string }> = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      if (typeof raw.cmd !== "string") continue;
      out.push({
        cmd: raw.cmd,
        args: typeof raw.args === "string"
          ? raw.args
          : JSON.stringify(raw.args ?? ""),
        optargs: typeof raw.optargs === "string"
          ? raw.optargs
          : JSON.stringify(raw.optargs ?? ""),
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
    warning?: (msg: string, props?: Record<string, unknown>) => void;
    error?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: WriteResource;
};

type CheckContext = {
  globalArgs: GlobalArgs;
  methodName: string;
};

/** Build an API client that talks over the platform `fetch`. */
function buildApi(g: GlobalArgs): DreamHostApi {
  if (!g.authToken) {
    throw new Error(
      "No DreamHost API key — set the `authToken` global argument, e.g. " +
        "${{ vault.get('dreamhost', 'API_KEY') }}",
    );
  }
  return new DreamHostApi({
    base: g.apiBase,
    key: g.authToken,
    fetchImpl: (url) =>
      fetch(url).then(async (r) => ({
        status: r.status,
        body: await r.text(),
      })),
  });
}

/** Resolve a desired record name, requiring a zone for short labels. */
function desiredRecord(
  args: { record: string; type: string; value: string; comment?: string },
  zone: string | undefined,
): DesiredRecord {
  const z = zone ? normalizeName(zone) : "";
  if (
    !z && !normalizeName(args.record).includes(".") &&
    normalizeName(args.record) !== "@"
  ) {
    throw new Error(
      `Record '${args.record}' is a short name; supply the \`zone\` argument ` +
        "so it can be resolved",
    );
  }
  return {
    record: z ? resolveRecordName(args.record, z) : normalizeName(args.record),
    type: normalizeRecordType(args.type),
    value: args.value.trim(),
    comment: args.comment ?? "",
  };
}

/** Swamp model definition for DreamHost DNS management. */
export const model = {
  type: "@svendowideit/dreamhost/dns",
  version: "2026.10.23.5",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-api-key": {
      description: "Validate that an API key is configured",
      labels: ["policy"],
      appliesTo: [
        "listRecords",
        "listZones",
        "listCommands",
        "addRecord",
        "removeRecord",
        "syncRecords",
      ],
      execute: (
        context: CheckContext,
      ): { pass: boolean; errors?: string[] } => {
        if (!context.globalArgs.authToken) {
          return {
            pass: false,
            errors: [
              "authToken is not set — supply the DreamHost API key via " +
              "${{ vault.get(...) }}",
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  resources: {
    records: {
      description: "DNS records fetched from the DreamHost API",
      schema: RecordsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    zones: {
      description: "Hosted zones derived from DNS records",
      schema: ZonesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    commands: {
      description: "API commands accessible to the configured key",
      schema: CommandsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    change: {
      description: "Result of a single add or remove operation",
      schema: RecordChangeSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    sync: {
      description: "Result of reconciling a desired DNS record set",
      schema: SyncSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    listRecords: {
      description:
        "Fetch DNS records (optionally filtered to one zone) into a resource",
      arguments: ListRecordsArgsSchema,
      execute: async (
        args: z.infer<typeof ListRecordsArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const api = buildApi(context.globalArgs);
        const zone = args.zone ? normalizeName(args.zone) : "";
        const all = await api.listRecords();
        const records = zone ? all.filter((r) => r.zone === zone) : all;
        context.logger?.info(
          "Fetched {count} DNS record(s){zone}",
          { count: records.length, zone: zone ? ` for ${zone}` : "" },
        );
        const handle = await context.writeResource("records", "records", {
          zone,
          count: records.length,
          editableCount: records.filter((r) => r.editable).length,
          records,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    listZones: {
      description:
        "Derive the hosted zones (domains) from the account's DNS records",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const api = buildApi(context.globalArgs);
        const records = await api.listRecords();
        const byZone = new Map<string, { records: number; editable: number }>();
        for (const r of records) {
          if (!r.zone) continue;
          const entry = byZone.get(r.zone) ?? { records: 0, editable: 0 };
          entry.records += 1;
          if (r.editable) entry.editable += 1;
          byZone.set(r.zone, entry);
        }
        const zones = [...byZone.entries()]
          .map(([zone, counts]) => ({
            zone,
            recordCount: counts.records,
            editableCount: counts.editable,
          }))
          .sort((a, b) => a.zone.localeCompare(b.zone));
        context.logger?.info("Found {count} zone(s)", { count: zones.length });
        const handle = await context.writeResource("zones", "zones", {
          count: zones.length,
          zones,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    listCommands: {
      description:
        "List the DreamHost API commands the configured key can access",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const api = buildApi(context.globalArgs);
        const commands = await api.listCommands();
        context.logger?.info("Key can access {count} command(s)", {
          count: commands.length,
        });
        const handle = await context.writeResource("commands", "commands", {
          count: commands.length,
          commands,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    addRecord: {
      description: "Add a DNS record to a zone",
      arguments: AddRecordArgsSchema,
      execute: async (
        args: z.infer<typeof AddRecordArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const api = buildApi(context.globalArgs);
        const desired = desiredRecord(args, args.zone);
        context.logger?.info(
          "Adding {type} {record} -> {value}",
          { type: desired.type, record: desired.record, value: desired.value },
        );
        const message = await api.addRecord(
          desired.record,
          desired.type,
          desired.value,
          desired.comment || undefined,
        );
        const handle = await context.writeResource("change", "change", {
          action: "added",
          record: desired.record,
          type: desired.type,
          value: desired.value,
          zone: args.zone ? normalizeName(args.zone) : "",
          message,
          changedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    removeRecord: {
      description: "Remove a DNS record from a zone",
      arguments: RemoveRecordArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveRecordArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const api = buildApi(context.globalArgs);
        const desired = desiredRecord(args, args.zone);
        context.logger?.info(
          "Removing {type} {record} -> {value}",
          { type: desired.type, record: desired.record, value: desired.value },
        );
        const message = await api.removeRecord(
          desired.record,
          desired.type,
          desired.value,
        );
        const handle = await context.writeResource("change", "change", {
          action: "removed",
          record: desired.record,
          type: desired.type,
          value: desired.value,
          zone: args.zone ? normalizeName(args.zone) : "",
          message,
          changedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    syncRecords: {
      description: "Idempotently reconcile a desired record set for a zone",
      arguments: SyncRecordsArgsSchema,
      execute: async (
        args: z.infer<typeof SyncRecordsArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const api = buildApi(context.globalArgs);
        const zone = normalizeName(args.zone);
        const desired = args.records.map((r) => desiredRecord(r, zone));
        const current = await api.listRecords();
        const plan = planDnsSync(desired, current, zone, args.prune);

        context.logger?.info(
          "syncRecords {zone}: +{add} -{remove} ={unchanged} " +
            "({protected} protected skipped)",
          {
            zone,
            add: plan.toAdd.length,
            remove: plan.toRemove.length,
            unchanged: plan.unchanged.length,
            protected: plan.protectedSkipped.length,
          },
        );

        const changed = plan.toAdd.length > 0 || plan.toRemove.length > 0;
        if (!args.dryRun) {
          for (const d of plan.toAdd) {
            await api.addRecord(
              d.record,
              d.type,
              d.value,
              d.comment || undefined,
            );
          }
          for (const r of plan.toRemove) {
            await api.removeRecord(r.record, r.type, r.value);
          }
        }

        const after = args.dryRun ? current : await api.listRecords();
        const handle = await context.writeResource("sync", "sync", {
          zone,
          prune: args.prune,
          dryRun: args.dryRun,
          changed,
          added: plan.toAdd.length,
          removed: plan.toRemove.length,
          unchanged: plan.unchanged.length,
          protectedSkipped: plan.protectedSkipped.length,
          addedRecords: plan.toAdd.map((d) => ({
            record: d.record,
            type: d.type,
            value: d.value,
            comment: d.comment,
            zone,
            editable: true,
          })),
          removedRecords: plan.toRemove,
          recordCount: after.filter((r) => r.zone === zone).length,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.23.5",
      description:
        "Version alignment with DreamHost extension release. Schema unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
