/**
 * @svendowideit/octoprint
 *
 * The printer's control plane: one model per OctoPrint box, read-only by
 * default. Phase 1 covers the questions you actually ask about a 3D printer
 * that is meant to be *working* — is it up, what is it doing, what version of
 * OctoPrint and which plugins are installed, what firmware does the controller
 * report, and does the webcam still produce a JPEG.
 *
 * Why a dedicated model instead of ad-hoc `curl` calls: OctoPrint owns the
 * printer's serial port (`/dev/ttyACM0`). Everything here is HTTP against
 * OctoPrint's API, so the model never opens a serial device, never races the
 * running server, and never needs the Pi's shell. Anything that would move the
 * printer (start/pause/cancel a job) or change the box (restart OctoPrint,
 * apply plugin/core updates) is deliberately NOT in this model yet — the
 * guarded mutation methods are a later phase, behind an explicit `confirm`.
 *
 * Firmware itself is report-only. Flashing a MK2S is a physical/SD-card or
 * host-side avrdude action; this model answers "what am I running, what is
 * current, do they differ".
 *
 * Methods:
 *   - `status`    one shot: is it reachable, printer state, temperatures, job
 *                 progress, and which printer profile is selected
 *   - `version`   OctoPrint core version + API version + host it runs on
 *   - `plugins`   installed plugins, and Plugin Manager's pending updates
 *   - `firmware`  the controller firmware string OctoPrint already holds, plus
 *                 which source it was read from (never opens the serial port)
 *   - `webcam`    probe `/webcam/?action=snapshot` and record what came back
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The model type name. */
export const OCTOPRINT_TYPE = "@svendowideit/octoprint";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 262_144;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  baseUrl: z.string().default("").describe(
    "OctoPrint base URL including scheme (e.g. `http://10.10.3.253`). Leave it " +
      "empty to read it from the vault (`<vaultName>` key `<urlRef>`), which is " +
      "the default and keeps the endpoint in one place.",
  ),
  vaultName: z.string().default("octoprint-secrets").describe(
    "Swamp vault holding this printer's endpoint and API key. Read at run time, " +
      "so no secret is ever stored in the model definition.",
  ),
  urlRef: z.string().default("url").describe(
    "Vault key holding the base URL (used when `baseUrl` is empty).",
  ),
  apiKeyRef: z.string().default("apiKey").describe(
    "Vault key holding the OctoPrint API key, sent as `X-Api-Key`. Read at run " +
      "time; never logged and never written to a resource.",
  ),
  requestTimeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS)
    .describe("Per-request timeout in milliseconds."),
  maxBodyBytes: z.number().int().positive().default(DEFAULT_MAX_BODY_BYTES)
    .describe(
      "Maximum response bytes read per request (the recorded body is capped; a " +
        "webcam snapshot only needs its size and content type).",
    ),
  userAgent: z.string().default("swamp-octoprint/1.0")
    .describe("User-Agent header sent with every request."),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments (phase 1 is read-only, so these are empty)
// ---------------------------------------------------------------------------

const EmptyArgsSchema = z.object({});
type EmptyArgs = z.infer<typeof EmptyArgsSchema>;

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const TemperatureSchema = z.object({
  actual: z.number().nullable().default(null),
  target: z.number().nullable().default(null),
});

const ProfileSchema = z.object({
  id: z.string().default(""),
  name: z.string().default(""),
  model: z.string().default(""),
});

const StatusSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  checkedAt: z.string(),
  octoprintVersion: z.string().default(""),
  apiVersion: z.string().default(""),
  /**
   * Printer state: operational | printing | paused | error | offline |
   * unknown. `offline` means OctoPrint answered but has no printer connection.
   */
  state: z.string().default(""),
  stateText: z.string().default(""),
  temperatures: z.object({
    tool0: TemperatureSchema,
    bed: TemperatureSchema,
  }),
  job: z.object({
    file: z.string().default(""),
    progressPct: z.number().nullable().default(null),
    timeLeftSec: z.number().nullable().default(null),
    timeElapsedSec: z.number().nullable().default(null),
  }),
  profile: ProfileSchema,
  hostname: z.string().default(""),
  errors: z.array(z.string()).default([]),
});

export type OctoprintStatus = z.infer<typeof StatusSchema>;

const VersionSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  checkedAt: z.string(),
  octoprintVersion: z.string().default(""),
  apiVersion: z.string().default(""),
  hostname: z.string().default(""),
  os: z.string().default(""),
  python: z.string().default(""),
  errors: z.array(z.string()).default([]),
});

const PluginSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  version: z.string().default(""),
  enabled: z.boolean().default(true),
});

const PluginsSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  checkedAt: z.string(),
  count: z.number().int().default(0),
  plugins: z.array(PluginSchema).default([]),
  pluginManagerPresent: z.boolean().default(false),
  /** True when the Software Update plugin answered the update check. */
  softwareUpdatePresent: z.boolean().default(false),
  /** Which Software Update path answered (older and newer OctoPrint differ). */
  softwareUpdateEndpoint: z.string().default(""),
  /** Plugins Plugin Manager reports an update for. */
  updatesAvailable: z.array(z.object({
    id: z.string(),
    installed: z.string().default(""),
    available: z.string().default(""),
  })).default([]),
  errors: z.array(z.string()).default([]),
});

const FirmwareSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  checkedAt: z.string(),
  detected: z.boolean().default(false),
  value: z.string().default(""),
  source: z.string().default(""),
  printerModel: z.string().default(""),
  /** Paths/keys inspected, so an undetected firmware is diagnosable. */
  sourcesTried: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

const WebcamSchema = z.object({
  url: z.string(),
  streamUrl: z.string(),
  checkedAt: z.string(),
  ok: z.boolean().default(false),
  status: z.number().int().default(0),
  contentType: z.string().default(""),
  bytes: z.number().int().default(0),
  /** True when the body looks like a JPEG (FFD8FF magic). */
  looksLikeJpeg: z.boolean().default(false),
  errors: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// HTTP plumbing (injectable, so tests never touch the network)
// ---------------------------------------------------------------------------

/** Result of one HTTP request against OctoPrint. */
export interface HttpResult {
  path: string;
  url: string;
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  /** First three body bytes, so binary magic (JPEG) is checkable. */
  head: number[];
  truncated: boolean;
  error: string;
}

/** Request options this model needs. */
export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Skip decoding the body — only status, content type and size matter. */
  raw?: boolean;
}

/** A fetcher bound to one model instance (base URL + API key + timeouts). */
export type Fetcher = (
  path: string,
  opts?: HttpOptions,
) => Promise<HttpResult>;

/** The shape of the fetch implementation this model uses. */
export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Normalise a user-supplied base URL: trim it, default to `http://` when no
 * scheme is given, drop a trailing slash so paths concatenate cleanly, and
 * reject anything that is not http(s) — a `file://` base would otherwise be
 * accepted here and only fail later, at the fetch.
 */
export function normaliseBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return /^https?:\/\//i.test(withScheme) ? withScheme : "";
}

/** The connection settings a fetcher needs (globals plus the resolved key). */
export interface FetchOptions {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  userAgent: string;
}

/** Build a fetcher bound to one instance's base URL, key and limits. */
export function createFetcher(
  g: FetchOptions,
  fetchImpl: FetchImpl = (input, init) => globalThis.fetch(input, init),
): Fetcher {
  const base = normaliseBaseUrl(g.baseUrl);
  return async (path, opts = {}) => {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      "User-Agent": g.userAgent,
      ...(opts.raw ? {} : { "Accept": "application/json" }),
      ...(g.apiKey ? { "X-Api-Key": g.apiKey } : {}),
      ...(opts.headers ?? {}),
    };
    try {
      const res = await fetchImpl(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body,
        redirect: "follow",
        signal: AbortSignal.timeout(g.requestTimeoutMs),
      });
      const full = new Uint8Array(await res.arrayBuffer());
      const capped = full.slice(0, g.maxBodyBytes);
      return {
        path,
        url,
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: opts.raw ? "" : new TextDecoder().decode(capped),
        bytes: full.byteLength,
        head: Array.from(full.slice(0, 3)),
        truncated: full.byteLength > capped.byteLength,
        error: "",
      };
    } catch (err) {
      return {
        path,
        url,
        ok: false,
        status: 0,
        contentType: "",
        body: "",
        bytes: 0,
        head: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/** A JSON GET, with the failure recorded rather than thrown. */
export interface JsonGet {
  ok: boolean;
  status: number;
  json: unknown;
  error: string;
}

/** GET a path and parse it as JSON; a non-2xx or invalid body is data, not a throw. */
export async function getJson(
  fetcher: Fetcher,
  path: string,
): Promise<JsonGet> {
  const res = await fetcher(path);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      json: null,
      error: res.error ||
        `HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ""}`,
    };
  }
  try {
    return {
      ok: true,
      status: res.status,
      json: JSON.parse(res.body),
      error: "",
    };
  } catch {
    return {
      ok: false,
      status: res.status,
      json: null,
      error: "response was not valid JSON",
    };
  }
}

// ---------------------------------------------------------------------------
// Pure parsers (exported for unit testing)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Read `octoprint.version` / `api` out of `GET /api/version`. */
export function parseVersion(json: unknown): {
  octoprintVersion: string;
  apiVersion: string;
} {
  const root = isRecord(json) ? json : {};
  const octoprint = isRecord(root["octoprint"]) ? root["octoprint"] : {};
  // OctoPrint <= 1.9 answers `{api, server, text}`; newer builds also nest
  // `{octoprint: {version}}`. Any of the three carries the same string, so try
  // each and fall back to the leading version in `text` ("OctoPrint 1.9.3").
  const textVersion = str(root["text"]).match(
    /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?/,
  )?.[0] ?? "";
  return {
    octoprintVersion: str(octoprint["version"] ?? root["version"]) ||
      str(root["server"]) || textVersion,
    apiVersion: str(root["api"] ?? root["apiVersion"]),
  };
}

/** Read hostname / OS / python out of `GET /api/system/info` (admin only). */
export function parseSystemInfo(json: unknown): {
  hostname: string;
  os: string;
  python: string;
} {
  const root = isRecord(json) ? json : {};
  const system = isRecord(root["system"]) ? root["system"] : root;
  return {
    hostname: str(system["hostname"]),
    os: str(system["os"] ?? system["platform"]),
    python: str(system["python"] ?? root["python"]),
  };
}

/**
 * Map OctoPrint's `state.flags` onto one word. `offline` is this model's own
 * value for "OctoPrint answered, but no printer is connected".
 */
export function stateFromFlags(flags: unknown): string {
  const f = isRecord(flags) ? flags : {};
  const on = (k: string) => f[k] === true;
  if (on("error") || on("closedOrError")) return "error";
  if (on("printing")) return "printing";
  if (on("paused") || on("pausing")) return "paused";
  if (on("operational") || on("ready") || on("finishing")) return "operational";
  if (on("offline") || on("closed")) return "offline";
  return "unknown";
}

/** Read state, state text and the two temperatures out of `GET /api/printer`. */
export function parsePrinter(json: unknown): {
  state: string;
  stateText: string;
  temperatures: {
    tool0: { actual: number | null; target: number | null };
    bed: { actual: number | null; target: number | null };
  };
} {
  const root = isRecord(json) ? json : {};
  const printer = isRecord(root["printer"]) ? root["printer"] : root;
  const state = isRecord(printer["state"]) ? printer["state"] : {};
  const temp = isRecord(printer["temperature"]) ? printer["temperature"] : {};
  const pair = (v: unknown) => {
    const t = isRecord(v) ? v : {};
    return { actual: num(t["actual"]), target: num(t["target"]) };
  };
  return {
    state: stateFromFlags(state["flags"]),
    stateText: str(state["text"]),
    temperatures: { tool0: pair(temp["tool0"]), bed: pair(temp["bed"]) },
  };
}

/** Read the current job out of `GET /api/job`. */
export function parseJob(json: unknown): {
  file: string;
  progressPct: number | null;
  timeLeftSec: number | null;
  timeElapsedSec: number | null;
} {
  const root = isRecord(json) ? json : {};
  const job = isRecord(root["job"]) ? root["job"] : {};
  const fileField = job["file"];
  const file = isRecord(fileField)
    ? str(fileField["name"] ?? fileField["path"])
    : str(fileField);
  const progress = isRecord(root["progress"]) ? root["progress"] : {};
  const pct = num(progress["completion"]);
  return {
    file,
    progressPct: pct === null ? null : Math.round(pct * 10) / 10,
    timeLeftSec: num(progress["printTimeLeft"]),
    timeElapsedSec: num(progress["printTime"]),
  };
}

/**
 * Read the selected printer profile out of `GET /api/printerprofiles`. The
 * profile's `model` is what identifies *which* printer this is — the whole
 * point of not trusting an IP address.
 */
export function parseCurrentProfile(json: unknown): {
  id: string;
  name: string;
  model: string;
} {
  const root = isRecord(json) ? json : {};
  const profiles = isRecord(root["profiles"])
    ? Object.values(root["profiles"])
    : Array.isArray(root["profiles"])
    ? root["profiles"] as unknown[]
    : [];
  const records = profiles.filter(isRecord);
  const current = records.find((p) => p["current"] === true) ??
    records.find((p) => p["default"] === true) ?? records[0];
  if (!current) return { id: "", name: "", model: "" };
  return {
    id: str(current["id"]),
    name: str(current["name"]),
    model: str(current["model"]),
  };
}

/** Read the installed plugin map out of `GET /api/settings`. */
export function parsePlugins(settingsJson: unknown): Array<{
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}> {
  const root = isRecord(settingsJson) ? settingsJson : {};
  const plugins = isRecord(root["plugins"])
    ? root["plugins"]
    : isRecord(root["plugin"])
    ? root["plugin"] as Record<string, unknown>
    : {};
  const out: Array<{
    id: string;
    name: string;
    version: string;
    enabled: boolean;
  }> = [];
  for (const [key, value] of Object.entries(plugins)) {
    const p = isRecord(value) ? value : {};
    out.push({
      id: str(p["id"]) || key,
      name: str(p["name"]) || key,
      version: str(p["version"]),
      enabled: p["enabled"] !== false,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Read pending updates out of the Software Update plugin's `check` response —
 * the only place OctoPrint reports what is stale, for core and for plugins.
 * Shape: `{information: {octoprint: {...}, plugins: {id: {...}}}}` where each
 * entry has `current` and, when an update exists, `release.version`.
 */
export function parseSoftwareUpdateCheck(json: unknown): Array<{
  id: string;
  installed: string;
  available: string;
}> {
  const root = isRecord(json) ? json : {};
  const info = isRecord(root["information"]) ? root["information"] : root;
  const out: Array<{ id: string; installed: string; available: string }> = [];
  const add = (id: string, entry: unknown): void => {
    const e = isRecord(entry) ? entry : {};
    const installed = str(e["current"]);
    const release = isRecord(e["release"]) ? e["release"] : {};
    const available = str(release["version"] ?? e["available"]);
    if (!available) return;
    if (available === installed) return;
    out.push({ id, installed, available });
  };
  add("octoprint", info["octoprint"]);
  const plugins = isRecord(info["plugins"]) ? info["plugins"] : {};
  for (const [id, entry] of Object.entries(plugins)) add(id, entry);
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Keys whose string value is plausibly a controller firmware identification. */
const FIRMWARE_KEYS = [
  "firmware",
  "firmwareName",
  "firmware_name",
  "FIRMWARE_NAME",
  "firmwareVersion",
  "firmware_version",
  "FIRMWARE_VERSION",
  "m115",
  "M115",
];

/**
 * Search OctoPrint payloads for the controller firmware string it already
 * holds. Never opens the serial port: whatever OctoPrint parsed at connect time
 * is the only honest source while OctoPrint owns the port.
 */
export function findFirmware(
  sources: Array<{ source: string; value: unknown }>,
): {
  detected: boolean;
  value: string;
  source: string;
  sourcesTried: string[];
} {
  const tried: string[] = [];
  const usable = (v: unknown): string => {
    if (typeof v === "string") return v.trim();
    if (isRecord(v)) {
      const name = str(v["name"]);
      const version = str(v["version"]);
      if (name && version) return `${name} ${version}`.trim();
      if (name) return name;
      if (version) return version;
    }
    return "";
  };
  for (const { source, value } of sources) {
    tried.push(source);
    if (!isRecord(value)) continue;
    for (const [key, raw] of Object.entries(value)) {
      if (FIRMWARE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) {
        const found = usable(raw);
        if (found) {
          return {
            detected: true,
            value: found,
            source: `${source}.${key}`,
            sourcesTried: tried,
          };
        }
      }
    }
    // one level down (e.g. `{printer: {firmware: …}}`)
    for (const [key, child] of Object.entries(value)) {
      if (!isRecord(child)) continue;
      for (const [k, raw] of Object.entries(child)) {
        if (!FIRMWARE_KEYS.some((f) => f.toLowerCase() === k.toLowerCase())) {
          continue;
        }
        const found = usable(raw);
        if (found) {
          return {
            detected: true,
            value: found,
            source: `${source}.${key}.${k}`,
            sourcesTried: tried,
          };
        }
      }
    }
  }
  return { detected: false, value: "", source: "", sourcesTried: tried };
}

/** True when a body starts with the JPEG SOI marker (FF D8 FF). */
export function looksLikeJpeg(head: Uint8Array): boolean {
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 &&
    head[2] === 0xff;
}

// ---------------------------------------------------------------------------
// Model definition
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
}

interface MethodContext {
  globalArgs: GlobalArgs;
  /** Swamp's vault reader, present when the run has a vault backend. */
  vaultService?: VaultService;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The subset of swamp's vault service this model needs. */
export interface VaultService {
  get: (vaultName: string, key: string) => Promise<string | undefined>;
}

/** The endpoint and key a run needs, resolved once per method call. */
export interface Credentials {
  url: string;
  apiKey: string;
  errors: string[];
}

/**
 * Resolve the base URL and API key: an explicit global wins, otherwise they are
 * read from the vault. Reading at run time (rather than interpolating a secret
 * into the definition) means the model file never holds the key, and
 * `swamp doctor secrets` stays quiet.
 */
export async function resolveCredentials(
  g: Pick<GlobalArgs, "baseUrl" | "vaultName" | "urlRef" | "apiKeyRef">,
  vaultService?: VaultService,
): Promise<Credentials> {
  const errors: string[] = [];
  const readVault = async (key: string): Promise<string> => {
    if (!vaultService) return "";
    try {
      return ((await vaultService.get(g.vaultName, key)) ?? "").trim();
    } catch (err) {
      errors.push(
        `vault ${g.vaultName}/${key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "";
    }
  };
  const url = normaliseBaseUrl(g.baseUrl) ||
    normaliseBaseUrl(await readVault(g.urlRef));
  const apiKey = await readVault(g.apiKeyRef);
  if (!url) {
    throw new Error(
      `octoprint: no base URL — set \`baseUrl\`, or store it in vault ` +
        `\`${g.vaultName}\` under key \`${g.urlRef}\`, e.g. ` +
        `swamp vault put ${g.vaultName} ${g.urlRef} http://octopi.local`,
    );
  }
  if (!apiKey) {
    errors.push(
      `no API key — store one with ` +
        `swamp vault put ${g.vaultName} ${g.apiKeyRef} <key> (OctoPrint: Settings -> API)`,
    );
  }
  return { url, apiKey, errors };
}

const nowIso = () => new Date().toISOString();

/**
 * Where the Software Update plugin's update check has lived: the REST path on
 * older OctoPrint, the blueprint path on newer builds.
 */
export const SOFTWARE_UPDATE_PATHS = [
  "/api/plugin/softwareupdate/check",
  "/plugin/softwareupdate/check",
];

/** The update check, from whichever path this OctoPrint serves. */
export interface UpdateCheck {
  ok: boolean;
  path: string;
  json: unknown;
  errors: string[];
}

/**
 * Ask the Software Update plugin what is stale. The endpoint moved between
 * OctoPrint versions, so both known paths are tried and the one that answered
 * is reported — that is also how a caller learns the plugin is missing.
 */
export async function checkForUpdates(fetcher: Fetcher): Promise<UpdateCheck> {
  const errors: string[] = [];
  for (const path of SOFTWARE_UPDATE_PATHS) {
    const res = await getJson(fetcher, path);
    if (res.ok) return { ok: true, path, json: res.json, errors };
    if (res.status !== 404 && res.status !== 405) {
      errors.push(`${path}: ${res.error}`);
      break;
    }
  }
  return { ok: false, path: "", json: null, errors };
}

/**
 * A model that reads one OctoPrint box's state over HTTP, never touching the
 * printer's serial port.
 */
export const model = {
  // A string-literal `type` here (not an imported constant) is what lets the
  // registry catalogue this behaviour type.
  type: "@svendowideit/octoprint",
  version: "2026.11.26.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.11.26.1",
      description:
        "Initial release (phase 1, read-only): `status`, `version`, `plugins`, " +
        "`firmware` and `webcam` against OctoPrint's HTTP API. Reports printer " +
        "state and temperatures, job progress, the selected printer profile's " +
        "model, OctoPrint/API versions, installed plugins and Plugin Manager's " +
        "pending updates, the controller firmware string OctoPrint already " +
        "holds, and whether the webcam still returns a JPEG. No method moves " +
        "the printer, restarts OctoPrint or applies an update.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    status: {
      description:
        "One-shot health: reachability, printer state, temperatures, job " +
        "progress and the selected printer profile (whose `model` identifies " +
        "the machine).",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    version: {
      description:
        "OctoPrint core version, API version and the host it runs on.",
      schema: VersionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    plugins: {
      description:
        "Installed OctoPrint plugins, whether Plugin Manager is present, and " +
        "which plugins it reports an update for.",
      schema: PluginsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    firmware: {
      description:
        "The controller firmware string OctoPrint holds, which payload it came " +
        "from, and everything tried (so `detected: false` is diagnosable).",
      schema: FirmwareSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    webcam: {
      description:
        "One webcam snapshot probe: status, content type, byte count and " +
        "whether the body is a JPEG.",
      schema: WebcamSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    status: {
      description:
        "Report reachability, printer state and temperatures, job progress and " +
        "the selected printer profile in one call. A printer that is not " +
        "connected is reported as state `offline`, not as a failure.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: EmptyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const creds = await resolveCredentials(g, ctx.vaultService);
        const url = creds.url;
        const fetcher = createFetcher({
          ...g,
          baseUrl: creds.url,
          apiKey: creds.apiKey,
        });
        const errors: string[] = [...creds.errors];

        const versionRes = await getJson(fetcher, "/api/version");
        if (!versionRes.ok) {
          errors.push(`/api/version: ${versionRes.error}`);
        }
        const version = parseVersion(versionRes.json);

        const printerRes = await getJson(fetcher, "/api/printer");
        let printer = parsePrinter(printerRes.json);
        if (!printerRes.ok) {
          // 409 = OctoPrint is up but has no printer connection.
          if (printerRes.status === 409) {
            printer = {
              state: "offline",
              stateText: "no printer connection",
              temperatures: {
                tool0: { actual: null, target: null },
                bed: { actual: null, target: null },
              },
            };
          } else {
            errors.push(`/api/printer: ${printerRes.error}`);
          }
        }

        const jobRes = await getJson(fetcher, "/api/job");
        if (!jobRes.ok) errors.push(`/api/job: ${jobRes.error}`);
        const job = parseJob(jobRes.json);

        const profilesRes = await getJson(fetcher, "/api/printerprofiles");
        if (!profilesRes.ok) {
          errors.push(`/api/printerprofiles: ${profilesRes.error}`);
        }
        const profile = parseCurrentProfile(profilesRes.json);

        const sysRes = await getJson(fetcher, "/api/system/info");
        const system = parseSystemInfo(sysRes.json);

        const reachable = versionRes.ok || printerRes.ok || jobRes.ok;
        const record: OctoprintStatus = {
          url,
          reachable,
          checkedAt: nowIso(),
          octoprintVersion: version.octoprintVersion,
          apiVersion: version.apiVersion,
          state: printer.state,
          stateText: printer.stateText,
          temperatures: printer.temperatures,
          job,
          profile,
          hostname: system.hostname,
          errors,
        };
        const handle = await ctx.writeResource("status", "status", record);
        ctx.logger?.info(
          "octoprint {url}: {state} ({version}, profile {profile})",
          {
            url,
            state: `${record.state}${
              record.stateText ? ` - ${record.stateText}` : ""
            }`,
            version: record.octoprintVersion || "unknown",
            profile: record.profile.model || record.profile.name || "unknown",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    version: {
      description:
        "Report the OctoPrint core version, the API version and the host it runs " +
        'on. Use it to answer "is OctoPrint up to date".',
      arguments: EmptyArgsSchema,
      execute: async (
        _args: EmptyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const creds = await resolveCredentials(g, ctx.vaultService);
        const url = creds.url;
        const fetcher = createFetcher({
          ...g,
          baseUrl: creds.url,
          apiKey: creds.apiKey,
        });
        const errors: string[] = [...creds.errors];

        const versionRes = await getJson(fetcher, "/api/version");
        if (!versionRes.ok) errors.push(`/api/version: ${versionRes.error}`);
        const version = parseVersion(versionRes.json);

        const sysRes = await getJson(fetcher, "/api/system/info");
        if (!sysRes.ok) errors.push(`/api/system/info: ${sysRes.error}`);
        const system = parseSystemInfo(sysRes.json);

        const record = {
          url,
          reachable: versionRes.ok,
          checkedAt: nowIso(),
          octoprintVersion: version.octoprintVersion,
          apiVersion: version.apiVersion,
          hostname: system.hostname,
          os: system.os,
          python: system.python,
          errors,
        };
        const handle = await ctx.writeResource("version", "version", record);
        ctx.logger?.info("octoprint {url}: core {version}, API {api}", {
          url,
          version: record.octoprintVersion || "unknown",
          api: record.apiVersion || "unknown",
        });
        return { dataHandles: [handle] };
      },
    },

    plugins: {
      description:
        "List installed OctoPrint plugins from `/api/settings`, then ask Plugin " +
        "Manager what it has updates for. Reads only — nothing is upgraded.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: EmptyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const creds = await resolveCredentials(g, ctx.vaultService);
        const url = creds.url;
        const fetcher = createFetcher({
          ...g,
          baseUrl: creds.url,
          apiKey: creds.apiKey,
        });
        const errors: string[] = [...creds.errors];

        const settingsRes = await getJson(fetcher, "/api/settings");
        if (!settingsRes.ok) errors.push(`/api/settings: ${settingsRes.error}`);
        const plugins = parsePlugins(settingsRes.json);

        // The Software Update plugin is the only place OctoPrint reports what
        // is stale — for its own core and for every plugin with a release
        // source. Plugin Manager is a UI over it, not a separate API. The path
        // moved between versions (`/api/plugin/...` vs the `/plugin/...`
        // blueprint), so both are tried and the one that answered is recorded.
        let softwareUpdatePresent = false;
        let softwareUpdateEndpoint = "";
        let updatesAvailable: Array<{
          id: string;
          installed: string;
          available: string;
        }> = [];
        const updateCheck = await checkForUpdates(fetcher);
        softwareUpdatePresent = updateCheck.ok;
        softwareUpdateEndpoint = updateCheck.path;
        updatesAvailable = updateCheck.ok
          ? parseSoftwareUpdateCheck(updateCheck.json)
          : [];
        errors.push(...updateCheck.errors);

        const record = {
          url,
          reachable: settingsRes.ok,
          checkedAt: nowIso(),
          count: plugins.length,
          plugins,
          softwareUpdatePresent,
          softwareUpdateEndpoint,
          updatesAvailable,
          errors,
        };
        const handle = await ctx.writeResource("plugins", "plugins", record);
        ctx.logger?.info(
          "octoprint {url}: {count} plugin(s), {updates} update(s) available",
          {
            url,
            count: plugins.length,
            updates: updatesAvailable.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    firmware: {
      description:
        "Report the controller firmware string OctoPrint already holds, and " +
        "which payload it came from. Never opens the printer's serial port.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: EmptyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const creds = await resolveCredentials(g, ctx.vaultService);
        const url = creds.url;
        const fetcher = createFetcher({
          ...g,
          baseUrl: creds.url,
          apiKey: creds.apiKey,
        });
        const errors: string[] = [...creds.errors];

        const printerRes = await getJson(fetcher, "/api/printer");
        if (!printerRes.ok && printerRes.status !== 409) {
          errors.push(`/api/printer: ${printerRes.error}`);
        }
        const settingsRes = await getJson(fetcher, "/api/settings");
        if (!settingsRes.ok) errors.push(`/api/settings: ${settingsRes.error}`);
        const profilesRes = await getJson(fetcher, "/api/printerprofiles");
        if (!profilesRes.ok) {
          errors.push(`/api/printerprofiles: ${profilesRes.error}`);
        }

        // The Software Update plugin is also where a firmware-check plugin
        // publishes the controller's current/latest version, so its payload is
        // searched too before concluding the string is unavailable.
        const updateCheck = await checkForUpdates(fetcher);
        errors.push(...updateCheck.errors);

        const sources = [
          { source: "/api/printer", value: printerRes.json },
          { source: "/api/settings", value: settingsRes.json },
          { source: "/api/printerprofiles", value: profilesRes.json },
        ];
        if (updateCheck.ok) {
          sources.push({ source: updateCheck.path, value: updateCheck.json });
        }

        const found = findFirmware(sources);
        const profile = parseCurrentProfile(profilesRes.json);

        const record = {
          url,
          reachable: printerRes.ok || settingsRes.ok,
          checkedAt: nowIso(),
          detected: found.detected,
          value: found.value,
          source: found.source,
          printerModel: profile.model,
          sourcesTried: found.sourcesTried,
          errors,
        };
        const handle = await ctx.writeResource("firmware", "firmware", record);
        ctx.logger?.info(
          record.detected
            ? "octoprint {url}: firmware {value} (from {source})"
            : "octoprint {url}: firmware not exposed by this OctoPrint — tried {tried}",
          record.detected
            ? { url, value: record.value, source: record.source }
            : { url, tried: record.sourcesTried.join(", ") },
        );
        return { dataHandles: [handle] };
      },
    },

    webcam: {
      description:
        "Probe the webcam snapshot endpoint (`/webcam/?action=snapshot`) and " +
        "record the status, content type, size and whether the body is a JPEG. " +
        "Proves the camera, the daemon and the stream path all still work.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: EmptyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const creds = await resolveCredentials(g, ctx.vaultService);
        const url = creds.url;
        const fetcher = createFetcher({
          ...g,
          baseUrl: creds.url,
          apiKey: creds.apiKey,
        });
        const errors: string[] = [...creds.errors];

        const res = await fetcher("/webcam/?action=snapshot", { raw: true });
        const isImage = /^image\//i.test(res.contentType);
        if (!res.ok) {
          errors.push(
            res.error || `HTTP ${res.status} from /webcam/?action=snapshot`,
          );
        } else if (!isImage) {
          errors.push(
            `webcam answered ${res.status} but with content-type ` +
              `\`${res.contentType || "none"}\`, not an image`,
          );
        }

        const record = {
          url,
          streamUrl: `${url}/webcam/?action=stream`,
          checkedAt: nowIso(),
          ok: res.ok && isImage,
          status: res.status,
          contentType: res.contentType,
          bytes: res.bytes,
          looksLikeJpeg: res.ok && isImage &&
            looksLikeJpeg(Uint8Array.from(res.head)),
          errors,
        };
        const handle = await ctx.writeResource("webcam", "webcam", record);
        ctx.logger?.info(
          "octoprint {url}: webcam {state} ({bytes} bytes, {type})",
          {
            url,
            state: record.ok ? "ok" : "FAILING",
            bytes: record.bytes,
            type: record.contentType || "no content-type",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
