/**
 * Swamp model that wraps the `curl` binary as a tracked HTTP client.
 *
 * The point of this model is *evidence*: every request records what went out
 * (method, URL, the headers the wrapper applied, cookies sent, the body) and
 * what came back (status, every response header block including redirects,
 * cookies set, the body, timing, the exact curl argv, exit code and stderr).
 * Secrets are masked by default so the record is safe to keep.
 *
 * Cookies live in a persistent jar per model instance, so a sequence of
 * requests — a login followed by authenticated calls — can reuse the session
 * simply by running one method after another.
 *
 * Methods:
 *   - `request`    full-control HTTP request (any method, headers, body)
 *   - `get`        thin `request` wrapper for GET
 *   - `post`       thin `request` wrapper for POST
 *   - `cookie-jar` inspect or clear the persistent cookie jar
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Header names whose values are masked in recorded output by default. */
export const DEFAULT_REDACT_HEADERS: string[] = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "x-auth-token",
];

// ---------------------------------------------------------------------------
// Plain record shapes (exported so helper signatures stay free of zod types)
// ---------------------------------------------------------------------------

/** A cookie, as received (Set-Cookie) or read from a jar. */
export interface CookieRecord {
  /** The cookie name. */
  name: string;
  /** The cookie value (masked in records when redactCookieValues is set). */
  value: string;
  /** The domain the cookie is scoped to. */
  domain?: string;
  /** The path the cookie is scoped to. */
  path?: string;
  /** Whether the cookie is Secure. */
  secure?: boolean;
  /** Whether the cookie is HttpOnly. */
  httpOnly?: boolean;
  /** The Expires/Max-Age value, when the cookie declared one. */
  expires?: string;
}

/** A cookie the wrapper sent with a request. */
export interface SentCookieRecord {
  /** The cookie name. */
  name: string;
  /** The cookie value, or `***` when cookie values are redacted. */
  value: string;
  /** Whether the cookie came from the request arguments or the jar. */
  source: "explicit" | "jar";
}

/** One hop in the redirect chain. */
export interface RedirectRecord {
  /** The status of the redirecting response. */
  status: number | null;
  /** The Location header the redirect pointed at. */
  location: string;
}

/** One response header block: a redirect hop, an interim response, or the final response. */
export interface HeaderBlock {
  /** The raw `HTTP/1.1 200 OK` line. */
  statusLine: string;
  /** The numeric status, or null when it could not be parsed. */
  status: number | null;
  /** Header name (lowercase) → value; repeated headers are comma-joined. */
  headers: Record<string, string>;
  /** Raw `Name: Value` lines, in order — used to read Set-Cookie exactly. */
  lines: string[];
}

/** The outcome of running a subprocess. */
export interface ProcessResult {
  /** The process exit code. */
  code: number;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Everything the process wrote to stderr. */
  stderr: string;
}

/** Everything needed to build a curl command line. */
export interface CurlInvocation {
  /** The request URL (already carrying query parameters). */
  url: string;
  /** The resolved HTTP method. */
  method: string;
  /** Resolved request headers, with real values. */
  headers: [string, string][];
  /** Temp path curl dumps response header blocks into. */
  headerFile: string;
  /** Temp path curl writes the response body into. */
  bodyFile: string;
  /** Persistent cookie jar path, or "" to disable the jar. */
  cookieJar: string;
  /** Whether to send cookies already in the jar. */
  reuseCookies: boolean;
  /** Cookies to send as a single `name=value; ...` string. */
  explicitCookies: string;
  /** Body file to send (`--data-binary @file`), if any. */
  dataFile?: string;
  /** Multipart form fields (`--form name=value`). */
  multipart: [string, string][];
  /** Multipart file fields (`--form name=@path`). */
  files: [string, string][];
  /** `user:password` for basic auth, if any. */
  user?: string;
  /** Whether to follow redirects. */
  followRedirects: boolean;
  /** Maximum redirects to follow. */
  maxRedirects: number;
  /** Whether to skip TLS verification. */
  insecure: boolean;
  /** Total timeout in milliseconds. */
  timeoutMs: number;
  /** Connect timeout in milliseconds. */
  connectTimeoutMs: number;
  /** Extra argv items appended verbatim before the URL. */
  extraArgs: string[];
}

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

function safeValue(label: string): z.ZodString {
  return z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );
}

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp; used to derive the cookie jar).",
  ),
  curlPath: safeValue("curlPath").default("curl").describe(
    "Path to the curl binary (or its name on PATH).",
  ),
  stateDir: safeValue("stateDir").default("~/.swamp/curl").describe(
    "Directory for persistent per-model state when cookieJar is empty.",
  ),
  cookieJar: z.string().default("").describe(
    "Path to a persistent cookie jar file. Empty derives " +
      "<stateDir>/<modelName>/cookies.txt.",
  ),
  reuseCookies: z.boolean().default(true).describe(
    "Send cookies already stored in the jar on each request.",
  ),
  userAgent: safeValue("userAgent").default(
    "swamp-curl/1.0 (curl wrapper)",
  ).describe("User-Agent sent when a request supplies none."),
  defaultHeaders: z.array(safeValue("header")).default([]).describe(
    'Headers applied to every request, each as "Name: Value".',
  ),
  followRedirects: z.boolean().default(true).describe(
    "Follow HTTP redirects (curl --location).",
  ),
  maxRedirects: z.number().int().nonnegative().default(10).describe(
    "Maximum redirects to follow.",
  ),
  insecure: z.boolean().default(false).describe(
    "Skip TLS certificate verification (curl --insecure).",
  ),
  timeoutMs: z.number().int().positive().default(30000).describe(
    "Total request timeout in milliseconds.",
  ),
  connectTimeoutMs: z.number().int().positive().default(10000).describe(
    "Connection timeout in milliseconds.",
  ),
  maxBodyBytes: z.number().int().nonnegative().default(262144).describe(
    "Maximum bytes of a body recorded in a resource (0 records none).",
  ),
  redactHeaders: z.array(safeValue("redactHeader")).default(
    [...DEFAULT_REDACT_HEADERS],
  ).describe(
    "Header names whose values are masked in the recorded request/response.",
  ),
  redactCookieValues: z.boolean().default(true).describe(
    "Mask cookie values in the recorded output.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const RequestArgsSchema = z.object({
  url: z.string().min(1).describe("URL to request."),
  method: z.string().default("").describe(
    "HTTP method. Empty = auto (POST when a body is supplied, otherwise GET).",
  ),
  headers: z.array(safeValue("header")).default([]).describe(
    'Extra request headers, each as "Name: Value". Override globals.',
  ),
  query: z.record(z.string(), z.string()).default({}).describe(
    "Query parameters appended to the URL.",
  ),
  data: z.string().meta({ foreignTemplate: true }).optional().describe(
    "Raw request body, sent byte-for-byte and recorded (truncated).",
  ),
  dataJson: z.unknown().optional().describe(
    "Body serialized as JSON; sets Content-Type: application/json.",
  ),
  dataFile: z.string().optional().describe(
    "Path of a file to send as the body (curl --data-binary @file). The " +
      "content is not read into the record.",
  ),
  form: z.record(z.string(), z.string()).optional().describe(
    "Form fields sent as application/x-www-form-urlencoded.",
  ),
  multipart: z.record(z.string(), z.string()).optional().describe(
    "Multipart form fields (curl --form name=value). Use for APIs that take " +
      "multipart/form-data (e.g. the Dependency-Track BOM upload). Values are " +
      "recorded in the request record.",
  ),
  files: z.record(z.string(), z.string()).optional().describe(
    "Files attached as multipart fields (curl --form name=@path). Combine with " +
      "`multipart`; the file content is not read into the record.",
  ),
  cookies: z.array(z.string()).default([]).describe(
    'Cookies to send for this request, each as "name=value".',
  ),
  user: z.string().meta({ sensitive: true }).optional().describe(
    "user:password for HTTP basic auth (curl --user).",
  ),
  bearerToken: z.string().meta({ sensitive: true }).optional().describe(
    "Bearer token added as an Authorization header.",
  ),
  label: z.string().default("").describe(
    "Name for the request record (empty = a generated name). Also names a " +
      "saved body.",
  ),
  saveBody: z.boolean().default(false).describe(
    "Store the full response body as a `body` file resource.",
  ),
  outputFile: z.string().default("").describe(
    "Also write the response body to this path.",
  ),
  maxBodyBytes: z.number().int().nonnegative().optional().describe(
    "Override the global recorded-body cap for this request.",
  ),
  reuseCookies: z.boolean().optional().describe(
    "Override the global reuseCookies for this request.",
  ),
  followRedirects: z.boolean().optional().describe(
    "Override the global followRedirects for this request.",
  ),
  insecure: z.boolean().optional().describe(
    "Override the global insecure for this request.",
  ),
  timeoutMs: z.number().int().positive().optional().describe(
    "Override the global timeoutMs for this request.",
  ),
  failOnHttpError: z.boolean().default(false).describe(
    "Fail the run when the final status is 400+. The record is still written " +
      "first, so the evidence is kept.",
  ),
  failOnCurlError: z.boolean().default(false).describe(
    "Fail the run when curl exits non-zero. The record is still written " +
      "first, so the evidence is kept.",
  ),
});

type RequestArgs = z.infer<typeof RequestArgsSchema>;

const CookieJarArgsSchema = z.object({
  clear: z.boolean().default(false).describe(
    "Delete the cookie jar file after reporting its contents.",
  ),
  raw: z.boolean().default(false).describe(
    "Include the raw cookie jar text in the record.",
  ),
});

type CookieJarArgs = z.infer<typeof CookieJarArgsSchema>;

// ---------------------------------------------------------------------------
// Record schemas (module-private; the plain interfaces above mirror them)
// ---------------------------------------------------------------------------

const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  expires: z.string().optional(),
});

const SentCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  source: z.enum(["explicit", "jar"]),
});

const RedirectSchema = z.object({
  status: z.number().int().nullable(),
  location: z.string(),
});

const RequestRecordSchema = z.object({
  label: z.string(),
  method: z.string(),
  url: z.string(),
  effectiveUrl: z.string(),
  status: z.number().int().nullable(),
  statusText: z.string(),
  ok: z.boolean(),
  requestHeaders: z.array(z.string()),
  requestBody: z.string(),
  requestBodyBytes: z.number().int().nonnegative(),
  requestBodyTruncated: z.boolean(),
  multipartFields: z.array(z.object({ name: z.string(), value: z.string() })),
  uploadFiles: z.array(z.object({
    name: z.string(),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
  })),
  cookiesSent: z.array(SentCookieSchema),
  cookiesReceived: z.array(CookieSchema),
  responseHeaders: z.record(z.string(), z.string()),
  redirects: z.array(RedirectSchema),
  body: z.string(),
  bodyBytes: z.number().int().nonnegative(),
  bodyTruncated: z.boolean(),
  outputFile: z.string().nullable(),
  timingMs: z.number().nonnegative(),
  curlExitCode: z.number().int(),
  stderr: z.string(),
  command: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string(),
});

const CookieJarRecordSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  count: z.number().int().nonnegative(),
  cookies: z.array(CookieSchema),
  raw: z.string().optional(),
  cleared: z.boolean(),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(raw: string): string {
  if (raw === "~") {
    return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "~";
  }
  if (raw.startsWith("~/")) {
    // Swamp's own operational data (under ~/.swamp) follows SWAMP_HOME so a
    // relocated data dir is honoured instead of a stale home-relative path.
    if (raw === "~/.swamp" || raw.startsWith("~/.swamp/")) {
      const swampHome = Deno.env.get("SWAMP_HOME");
      if (swampHome) {
        const base = swampHome.replace(/\/+$/, "");
        const suffix = raw.slice("~/.swamp".length);
        return suffix ? `${base}${suffix}` : base;
      }
    }
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (home) return `${home}${raw.slice(1)}`;
  }
  return raw;
}

/** Deterministic 32-bit FNV-1a hash of a string, as 8 hex digits. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Split a `"Name: Value"` header line, or return null when malformed. */
export function parseHeader(line: string): [string, string] | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const name = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!name) return null;
  return [name, value];
}

/** Whether a resolved header list already contains a header (case-insensitive). */
export function hasHeader(
  headers: [string, string][],
  name: string,
): boolean {
  const lower = name.toLowerCase();
  return headers.some(([n]) => n.toLowerCase() === lower);
}

/**
 * Append query parameters to a URL. Parameters are appended (not merged), so
 * existing query strings are preserved.
 */
export function buildUrl(
  url: string,
  query: Record<string, string>,
): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  for (const key of keys) u.searchParams.append(key, query[key] ?? "");
  return u.toString();
}

/**
 * Resolve the HTTP method: an explicit method wins, otherwise POST when a
 * body is present and GET otherwise.
 */
export function resolveMethod(method: string, hasBody: boolean): string {
  const explicit = method.trim().toUpperCase();
  if (explicit) return explicit;
  return hasBody ? "POST" : "GET";
}

/**
 * Resolve the cookie jar path: the explicit global if set, else a per-model
 * file under the state directory.
 */
export function resolveCookieJar(
  g: { cookieJar: string; stateDir: string },
  modelName: string,
): string {
  const explicit = g.cookieJar.trim();
  if (explicit) return expandHome(explicit);
  const slug = (modelName.trim() || "curl").replace(/[^A-Za-z0-9_.-]+/g, "-");
  return `${expandHome(g.stateDir)}/${slug}/cookies.txt`;
}

/** A generated or label-derived name for a request record. */
export function requestInstanceName(
  label: string,
  method: string,
  url: string,
  startedAt: string,
): string {
  const clean = label.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  if (clean) return clean;
  return `req-${fnv1a(`${method} ${url} ${startedAt}`)}`;
}

/** Mask a header value when its name is in the redaction set. */
export function redactValue(
  name: string,
  value: string,
  set: Set<string>,
): string {
  return set.has(name.toLowerCase()) ? "***" : value;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Parse `curl --dump-header` output into one block per response. Redirects and
 * interim `1xx` responses produce multiple blocks; the final block is the real
 * response.
 */
export function parseHeaderBlocks(raw: string): HeaderBlock[] {
  const text = raw.replace(/\r\n/g, "\n");
  const blocks: HeaderBlock[] = [];
  for (const part of text.split(/\n\n/)) {
    const lines = part.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    if (!/^HTTP\//i.test(lines[0])) continue;
    const statusLine = lines[0];
    const m = statusLine.match(/^HTTP\/[\d.]+\s+(\d{3})/i);
    const status = m ? parseInt(m[1], 10) : null;
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const parsed = parseHeader(line);
      if (!parsed) continue;
      const name = parsed[0].toLowerCase();
      headers[name] = headers[name]
        ? `${headers[name]}, ${parsed[1]}`
        : parsed[1];
    }
    blocks.push({ statusLine, status, headers, lines: lines.slice(1) });
  }
  return blocks;
}

/** The human-readable reason phrase from a status line. */
export function statusTextOf(statusLine: string): string {
  return statusLine.replace(/^HTTP\/[\d.]+\s+\d{3}\s*/, "").trim();
}

/** Parse the attributes of a single `Set-Cookie` header value. */
export function parseSetCookie(
  value: string,
  host: string,
): CookieRecord | null {
  const parts = value.split(";");
  const first = parts[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const cookie: CookieRecord = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    domain: host,
  };
  for (const attr of parts.slice(1)) {
    const [rawName, ...rest] = attr.trim().split("=");
    const name = rawName.trim().toLowerCase();
    const val = rest.join("=").trim();
    if (name === "domain") cookie.domain = val.replace(/^\./, "");
    else if (name === "path") cookie.path = val;
    else if (name === "secure") cookie.secure = true;
    else if (name === "httponly") cookie.httpOnly = true;
    else if (name === "expires") cookie.expires = val;
    else if (name === "max-age" && !cookie.expires) cookie.expires = val;
  }
  return cookie;
}

/** Every Set-Cookie across all header blocks, in order. */
export function collectSetCookies(
  blocks: HeaderBlock[],
  host: string,
): CookieRecord[] {
  const out: CookieRecord[] = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      const parsed = parseHeader(line);
      if (!parsed || parsed[0].toLowerCase() !== "set-cookie") continue;
      const cookie = parseSetCookie(parsed[1], host);
      if (cookie) out.push(cookie);
    }
  }
  return out;
}

/** The redirect hops recorded across all but the final response block. */
export function collectRedirects(blocks: HeaderBlock[]): RedirectRecord[] {
  const out: RedirectRecord[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const location = blocks[i].headers["location"];
    if (location) out.push({ status: blocks[i].status, location });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cookie jar parsing
// ---------------------------------------------------------------------------

/** Parse a Netscape-format cookie jar into structured cookies. */
export function parseCookieJar(raw: string): CookieRecord[] {
  const out: CookieRecord[] = [];
  for (const line of raw.split("\n")) {
    let l = line;
    if (!l || l.startsWith("# ") || l === "#") continue;
    let httpOnly = false;
    if (l.startsWith("#HttpOnly_")) {
      httpOnly = true;
      l = l.slice("#HttpOnly_".length);
    } else if (l.startsWith("#")) {
      continue;
    }
    const fields = l.split("\t");
    if (fields.length < 7) continue;
    const expires = parseInt(fields[4], 10);
    out.push({
      domain: fields[0],
      path: fields[2],
      secure: fields[3].toUpperCase() === "TRUE",
      expires: Number.isNaN(expires) ? undefined : String(expires),
      name: fields[5],
      value: fields[6],
      httpOnly,
    });
  }
  return out;
}

/** Whether a jar cookie would be sent to a host/path (approximate). */
export function cookieMatches(
  cookie: CookieRecord,
  host: string,
  path: string,
): boolean {
  const domain = (cookie.domain ?? "").replace(/^\./, "");
  if (!domain) return false;
  const hostMatch = host === domain || host.endsWith(`.${domain}`);
  if (!hostMatch) return false;
  const cookiePath = cookie.path ?? "/";
  if (!path.startsWith(cookiePath)) return false;
  const expires = cookie.expires ? parseInt(cookie.expires, 10) : 0;
  if (expires && expires * 1000 < Date.now()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// curl invocation
// ---------------------------------------------------------------------------

/** Convert milliseconds to a curl seconds argument (e.g. `30`). */
export function secondsToCurl(ms: number): string {
  return (ms / 1000).toString();
}

/** Build the curl argv that performs the request and dumps the evidence. */
export function buildCurlArgs(inv: CurlInvocation): string[] {
  const args: string[] = [
    "--silent",
    "--show-error",
    "--request",
    inv.method,
    "--dump-header",
    inv.headerFile,
    "--output",
    inv.bodyFile,
    "--write-out",
    "%{json}",
  ];
  if (inv.followRedirects) {
    args.push("--location", "--max-redirs", String(inv.maxRedirects));
  } else {
    args.push("--no-location");
  }
  if (inv.insecure) args.push("--insecure");
  if (inv.timeoutMs > 0) args.push("--max-time", secondsToCurl(inv.timeoutMs));
  if (inv.connectTimeoutMs > 0) {
    args.push("--connect-timeout", secondsToCurl(inv.connectTimeoutMs));
  }
  for (const [name, value] of inv.headers) {
    args.push("--header", `${name}: ${value}`);
  }
  if (inv.user) args.push("--user", inv.user);
  if (inv.cookieJar && inv.reuseCookies) args.push("--cookie", inv.cookieJar);
  if (inv.explicitCookies) args.push("--cookie", inv.explicitCookies);
  if (inv.cookieJar) args.push("--cookie-jar", inv.cookieJar);
  if (inv.dataFile) args.push("--data-binary", `@${inv.dataFile}`);
  for (const [name, value] of inv.multipart) {
    args.push("--form", `${name}=${value}`);
  }
  for (const [name, path] of inv.files) {
    args.push("--form", `${name}=@${path}`);
  }
  for (const extra of inv.extraArgs) args.push(extra);
  args.push(inv.url);
  return args;
}

/**
 * Mask secrets in an argv before recording it: the values of `--user`,
 * `--cookie` and redacted `--header` arguments, keeping the evidence that the
 * option was supplied.
 */
export function redactArgv(argv: string[], set: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user") {
      out.push(arg, "***");
      i++;
      continue;
    }
    if (arg === "--cookie") {
      // The same option carries either a cookie jar path (not a secret) or an
      // inline `name=value` cookie string (potentially a secret). Mask only
      // the latter.
      const value = i + 1 < argv.length ? argv[i + 1] : "";
      out.push(arg, value.includes("=") ? "***" : value);
      i++;
      continue;
    }
    if (arg === "--header" && i + 1 < argv.length) {
      out.push(arg);
      const parsed = parseHeader(argv[i + 1]);
      out.push(
        parsed
          ? `${parsed[0]}: ${redactValue(parsed[0], parsed[1], set)}`
          : "***",
      );
      i++;
      continue;
    }
    if (arg === "--form" && i + 1 < argv.length) {
      // `--form name=value` records `name=***` when the field name is a
      // redacted one; a file field `name=@path` keeps its (non-secret) path.
      const value = argv[i + 1];
      const eq = value.indexOf("=");
      if (eq > 0 && !value.slice(eq + 1).startsWith("@")) {
        const name = value.slice(0, eq);
        out.push(arg, `${name}=${redactValue(name, value.slice(eq + 1), set)}`);
      } else {
        out.push(arg, value);
      }
      i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

/** Run a subprocess, capturing stdout/stderr and honouring an AbortSignal. */
export async function runProcess(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ProcessResult> {
  let child: Deno.ChildProcess;
  try {
    // swamp-quality-ignore deno-command: this extension is a curl wrapper — spawning curl is its purpose. Every argument is built by buildCurlArgs, not taken raw from the caller.
    child = new Deno.Command(bin, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    throw new Error(
      `Failed to start '${bin}': ${
        err instanceof Error ? err.message : String(err)
      }. Install curl or set --global-arg curlPath=/path/to/curl.`,
    );
  }
  const onAbort = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const status = await child.status;
  const [out, err] = await Promise.all([stdout, stderr]);
  if (signal) signal.removeEventListener("abort", onAbort);
  return { code: status.code, stdout: out, stderr: err };
}

/** Parse curl's `%{json}` write-out block into a metadata object. */
export function parseWriteOut(stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Decode the first `cap` bytes of a body, reporting whether it was cut. */
export function decodeCapped(
  bytes: Uint8Array,
  cap: number,
): { text: string; truncated: boolean } {
  const take = cap > 0 ? Math.min(cap, bytes.byteLength) : 0;
  const text = new TextDecoder().decode(bytes.subarray(0, take));
  return { text, truncated: bytes.byteLength > take };
}

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  signal?: AbortSignal;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    specName: string,
    name: string,
  ) => { writeAll: (bytes: Uint8Array) => Promise<{ name: string }> };
}

// ---------------------------------------------------------------------------
// Request flow
// ---------------------------------------------------------------------------

interface ResolvedHeaders {
  /** Headers actually passed to curl (with real secret values). */
  actual: [string, string][];
  /** The same headers with secrets masked, for the record. */
  shown: [string, string][];
}

/** Resolve the effective request headers from globals, args and auth. */
function resolveHeaders(
  g: GlobalArgs,
  args: RequestArgs,
  redact: Set<string>,
): ResolvedHeaders {
  const actual: [string, string][] = [];
  for (const line of g.defaultHeaders) {
    const parsed = parseHeader(line);
    if (parsed) actual.push(parsed);
  }
  for (const line of args.headers) {
    const parsed = parseHeader(line);
    if (parsed) actual.push(parsed);
  }
  if (!hasHeader(actual, "user-agent")) {
    actual.push(["User-Agent", g.userAgent]);
  }
  if (args.bearerToken && !hasHeader(actual, "authorization")) {
    actual.push(["Authorization", `Bearer ${args.bearerToken}`]);
  }
  if (args.dataJson !== undefined) {
    if (!hasHeader(actual, "content-type")) {
      actual.push(["Content-Type", "application/json"]);
    }
    if (!hasHeader(actual, "accept")) {
      actual.push(["Accept", "application/json"]);
    }
  }
  const shown = actual.map(([name, value]): [string, string] => [
    name,
    redactValue(name, value, redact),
  ]);
  return { actual, shown };
}

interface ResolvedBody {
  dataFile?: string;
  recorded: string;
  bytes: number;
  multipart: [string, string][];
  files: [string, string][];
}

/** Resolve the request body into a temp file (or multipart fields) + metadata. */
async function resolveBody(
  args: RequestArgs,
  tmpDir: string,
): Promise<ResolvedBody> {
  const scalarSources = [
    args.data !== undefined,
    args.dataJson !== undefined,
    args.dataFile !== undefined,
    args.form !== undefined,
  ].filter(Boolean).length;
  const multipartPresent = args.multipart !== undefined ||
    args.files !== undefined;
  if (scalarSources > 1) {
    throw new Error(
      "Provide only one request body source: data, dataJson, dataFile, form, " +
        "multipart or files.",
    );
  }
  if (scalarSources > 0 && multipartPresent) {
    throw new Error(
      "Do not combine a raw/urlencoded body (data, dataJson, dataFile, form) " +
        "with multipart/form-data (multipart, files).",
    );
  }
  if (multipartPresent) {
    const multipart: [string, string][] = Object.entries(args.multipart ?? {});
    const files: [string, string][] = Object.entries(args.files ?? {}).map(
      ([name, path]): [string, string] => [name, expandHome(path)],
    );
    let bytes = 0;
    const enc = new TextEncoder();
    for (const [, value] of multipart) bytes += enc.encode(value).byteLength;
    for (const [, path] of files) {
      try {
        bytes += (await Deno.stat(path)).size;
      } catch {
        // missing file — curl will report the error
      }
    }
    return { recorded: "", bytes, multipart, files };
  }
  const writeTemp = async (text: string): Promise<string> => {
    const file = `${tmpDir}/request-body`;
    await Deno.writeTextFile(file, text);
    return file;
  };
  if (args.dataJson !== undefined) {
    const json = JSON.stringify(args.dataJson);
    return {
      dataFile: await writeTemp(json),
      recorded: json,
      bytes: new TextEncoder().encode(json).byteLength,
      multipart: [],
      files: [],
    };
  }
  if (args.data !== undefined) {
    return {
      dataFile: await writeTemp(args.data),
      recorded: args.data,
      bytes: new TextEncoder().encode(args.data).byteLength,
      multipart: [],
      files: [],
    };
  }
  if (args.form !== undefined) {
    const encoded = new URLSearchParams(args.form).toString();
    return {
      dataFile: await writeTemp(encoded),
      recorded: encoded,
      bytes: new TextEncoder().encode(encoded).byteLength,
      multipart: [],
      files: [],
    };
  }
  if (args.dataFile !== undefined) {
    const path = expandHome(args.dataFile);
    let bytes = 0;
    try {
      bytes = (await Deno.stat(path)).size;
    } catch {
      bytes = 0;
    }
    return { dataFile: path, recorded: "", bytes, multipart: [], files: [] };
  }
  return { recorded: "", bytes: 0, multipart: [], files: [] };
}

/** Cap a recorded request body for the resource. */
function capRequestBody(
  recorded: string,
  cap: number,
): { text: string; truncated: boolean } {
  if (!recorded) return { text: "", truncated: false };
  return decodeCapped(new TextEncoder().encode(recorded), cap);
}

/** Merge explicit cookies with matching, non-expired jar cookies. */
function resolveSentCookies(
  g: GlobalArgs,
  args: RequestArgs,
  jarCookies: CookieRecord[],
  reuseCookies: boolean,
  url: string,
): SentCookieRecord[] {
  const redact = g.redactCookieValues;
  const sent: SentCookieRecord[] = [];
  for (const raw of args.cookies) {
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq).trim() : raw.trim();
    const value = eq > 0 ? raw.slice(eq + 1) : "";
    if (name) {
      sent.push({ name, value: redact ? "***" : value, source: "explicit" });
    }
  }
  if (!reuseCookies) return sent;
  let host = "";
  let path = "/";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname || "/";
  } catch {
    return sent;
  }
  for (const cookie of jarCookies) {
    if (!cookieMatches(cookie, host, path)) continue;
    sent.push({
      name: cookie.name,
      value: redact ? "***" : cookie.value,
      source: "jar",
    });
  }
  return sent;
}

/** Read a file as text, or "" when absent/unreadable. */
async function readTextSafe(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

/** Read a file as bytes, or an empty array when absent/unreadable. */
async function readBytesSafe(path: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(path);
  } catch {
    return new Uint8Array();
  }
}

/** Ensure the parent directory of a file path exists. */
async function ensureParent(path: string): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx > 0) await Deno.mkdir(path.slice(0, idx), { recursive: true });
}

/** Read the final status from curl metadata, falling back to the header block. */
function statusFrom(
  meta: Record<string, unknown>,
  last: HeaderBlock | undefined,
): number | null {
  const code = meta["http_code"];
  if (typeof code === "number" && code > 0) return code;
  return last?.status ?? null;
}

/** Read a string field from curl metadata, with a fallback. */
function stringMeta(
  meta: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = meta[key];
  return typeof value === "string" && value ? value : fallback;
}

/** Mask sensitive response header values for the record. */
function redactHeaders(
  headers: Record<string, string>,
  set: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = redactValue(name, value, set);
  }
  return out;
}

/** The core request implementation shared by `request`, `get` and `post`. */
async function runRequest(
  args: RequestArgs,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const modelName = ctx.definition?.name ?? "";
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const hasBody = args.data !== undefined || args.dataJson !== undefined ||
    args.dataFile !== undefined || args.form !== undefined ||
    args.multipart !== undefined || args.files !== undefined;
  const method = resolveMethod(args.method, hasBody);
  const url = buildUrl(args.url, args.query);
  const cookieJar = resolveCookieJar(g, modelName);
  const reuseCookies = args.reuseCookies ?? g.reuseCookies;
  const followRedirects = args.followRedirects ?? g.followRedirects;
  const insecure = args.insecure ?? g.insecure;
  const timeoutMs = args.timeoutMs ?? g.timeoutMs;
  const cap = args.maxBodyBytes ?? g.maxBodyBytes;
  const redact = new Set(g.redactHeaders.map((h) => h.toLowerCase()));

  const { actual, shown } = resolveHeaders(g, args, redact);

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-curl-" });
  const headerFile = `${tmpDir}/headers`;
  const bodyFile = `${tmpDir}/body`;
  try {
    const jarText = cookieJar ? await readTextSafe(cookieJar) : "";
    const jarCookies = reuseCookies ? parseCookieJar(jarText) : [];
    const sentCookies = resolveSentCookies(
      g,
      args,
      jarCookies,
      reuseCookies,
      url,
    );
    const explicit = args.cookies.length > 0 ? args.cookies.join("; ") : "";
    const body = await resolveBody(args, tmpDir);

    // Ensure the jar and output directories exist before curl writes to them.
    if (cookieJar) await ensureParent(cookieJar);
    if (args.outputFile) await ensureParent(expandHome(args.outputFile));

    const argv = buildCurlArgs({
      url,
      method,
      headers: actual,
      headerFile,
      bodyFile,
      cookieJar,
      reuseCookies,
      explicitCookies: explicit,
      dataFile: body.dataFile,
      multipart: body.multipart,
      files: body.files,
      user: args.user,
      followRedirects,
      maxRedirects: g.maxRedirects,
      insecure,
      timeoutMs,
      connectTimeoutMs: g.connectTimeoutMs,
      extraArgs: [],
    });
    const proc = await runProcess(g.curlPath, argv, ctx.signal);

    const rawHeaders = await readTextSafe(headerFile);
    const bodyBytesRaw = await readBytesSafe(bodyFile);
    const blocks = parseHeaderBlocks(rawHeaders);
    const meta = parseWriteOut(proc.stdout);
    const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;

    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }

    const status = statusFrom(meta, last);
    const decoded = decodeCapped(bodyBytesRaw, cap);
    const reqBody = capRequestBody(body.recorded, cap);
    const multipartFields = body.multipart.map(([name, value]) => ({
      name,
      value: redactValue(name, value, redact),
    }));
    const uploadFiles: Array<{ name: string; path: string; bytes: number }> =
      [];
    for (const [name, path] of body.files) {
      let fileBytes = 0;
      try {
        fileBytes = (await Deno.stat(path)).size;
      } catch {
        fileBytes = 0;
      }
      uploadFiles.push({ name, path, bytes: fileBytes });
    }

    if (args.outputFile) {
      try {
        await Deno.copyFile(bodyFile, expandHome(args.outputFile));
      } catch (err) {
        ctx.logger?.warn("Could not write outputFile {file}: {error}", {
          file: args.outputFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const record: z.infer<typeof RequestRecordSchema> = {
      label: requestInstanceName(args.label, method, url, startedAt),
      method,
      url: args.url,
      effectiveUrl: stringMeta(meta, "url_effective", url),
      status,
      statusText: last ? statusTextOf(last.statusLine) : "",
      ok: status !== null && status >= 200 && status < 400,
      requestHeaders: shown.map(([n, v]) => `${n}: ${v}`),
      requestBody: reqBody.text,
      requestBodyBytes: body.bytes,
      requestBodyTruncated: reqBody.truncated,
      multipartFields,
      uploadFiles,
      cookiesSent: sentCookies,
      cookiesReceived: blocks.length > 0 ? collectSetCookies(blocks, host) : [],
      responseHeaders: last ? redactHeaders(last.headers, redact) : {},
      redirects: collectRedirects(blocks),
      body: decoded.text,
      bodyBytes: bodyBytesRaw.byteLength,
      bodyTruncated: decoded.truncated,
      outputFile: args.outputFile ? expandHome(args.outputFile) : null,
      timingMs: Math.round(performance.now() - t0),
      curlExitCode: proc.code,
      stderr: proc.stderr.trim(),
      command: redactArgv([g.curlPath, ...argv], redact),
      startedAt,
      finishedAt: new Date().toISOString(),
    };

    const handles: Array<{ name: string }> = [];
    handles.push(await ctx.writeResource("request", record.label, record));
    if (args.saveBody) {
      const writer = ctx.createFileWriter("body", `body-${record.label}`);
      handles.push(await writer.writeAll(bodyBytesRaw));
    }

    ctx.logger?.info(
      "{method} {url} -> {status} ({ms}ms, {bytes}B, {redirects} redirect(s))",
      {
        method,
        url,
        status: status ?? "no response",
        ms: record.timingMs,
        bytes: record.bodyBytes,
        redirects: record.redirects.length,
      },
    );

    if (args.failOnCurlError && proc.code !== 0) {
      throw new Error(
        `curl exited ${proc.code} for ${method} ${url}: ${
          proc.stderr.trim() || "no stderr"
        } (request record '${record.label}' was written)`,
      );
    }
    if (args.failOnHttpError && status !== null && status >= 400) {
      throw new Error(
        `${method} ${url} returned HTTP ${status} (request record ` +
          `'${record.label}' was written)`,
      );
    }
    return { dataHandles: handles };
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** A tracked curl wrapper: every request's in/out evidence, with a cookie jar. */
export const model = {
  type: "@svendowideit/curl",
  version: "2026.10.23.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.11.1",
      description:
        "Initial release: a tracked curl wrapper. `request` performs any HTTP " +
        "request and records the method, URL, applied headers, cookies sent " +
        "and received, response header blocks (including redirects), body, " +
        "timing, argv, exit code and stderr, masking secrets by default. A " +
        "persistent per-instance cookie jar (reuseCookies) carries a session " +
        "across requests; `get`/`post` are thin wrappers and `cookie-jar` " +
        "inspects or clears the jar.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.11.2",
      description:
        "Add multipart/form-data requests: the `multipart` arg sends `--form " +
        "name=value` fields and `files` attaches `--form name=@path` uploads " +
        "(needed for the Dependency-Track BOM upload). Both are recorded " +
        "(multipartFields, uploadFiles) with field values redactable; no " +
        "existing argument changed.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.23.1",
      description:
        "Honour SWAMP_HOME when resolving ~/.swamp-relative state paths: " +
        "expandHome now maps ~/.swamp (and ~/.swamp/...) to SWAMP_HOME when set " +
        "(falling back to HOME/USERPROFILE as before), so a relocated swamp " +
        "data directory is used for the cookie-jar stateDir.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    request: {
      description:
        "Full in/out record of one curl request: headers, cookies, body, " +
        "redirects, timing and process outcome (secrets masked).",
      schema: RequestRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    cookieJar: {
      description: "Contents and state of the persistent cookie jar.",
      schema: CookieJarRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  files: {
    body: {
      description: "Full response body, stored when saveBody is set.",
      contentType: "application/octet-stream",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  checks: {
    "valid-config": {
      description:
        "Ensure curlPath is set and the state/header arguments are sane before " +
        "starting a request.",
      labels: ["policy"],
      execute: (ctx: { globalArgs: GlobalArgs }) => {
        const errors: string[] = [];
        if (!ctx.globalArgs.curlPath.trim()) {
          errors.push("curlPath must not be empty.");
        }
        if (
          !ctx.globalArgs.stateDir.trim() && !ctx.globalArgs.cookieJar.trim()
        ) {
          errors.push("stateDir must not be empty when cookieJar is unset.");
        }
        if (ctx.globalArgs.maxRedirects < 0) {
          errors.push("maxRedirects must be non-negative.");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },

  methods: {
    request: {
      description:
        "Perform an HTTP request with curl and record everything that went out " +
        "and came back. Any method; body via data/dataJson/dataFile/form, or a " +
        "multipart/form-data upload via multipart/files; headers, query, cookies " +
        "and basic/bearer auth. Secrets are masked. Cookies persist in a " +
        "per-instance jar unless reuseCookies is false.",
      arguments: RequestArgsSchema,
      execute: (args: RequestArgs, ctx: MethodContext) => runRequest(args, ctx),
    },

    get: {
      description: "Thin `request` wrapper that forces the GET method.",
      arguments: RequestArgsSchema,
      execute: (args: RequestArgs, ctx: MethodContext) =>
        runRequest({ ...args, method: args.method.trim() || "GET" }, ctx),
    },

    post: {
      description: "Thin `request` wrapper that forces the POST method.",
      arguments: RequestArgsSchema,
      execute: (args: RequestArgs, ctx: MethodContext) =>
        runRequest({ ...args, method: args.method.trim() || "POST" }, ctx),
    },

    "cookie-jar": {
      description:
        "Report the cookies in the persistent jar (optionally the raw text), " +
        "and optionally clear it.",
      arguments: CookieJarArgsSchema,
      execute: async (args: CookieJarArgs, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const path = resolveCookieJar(g, ctx.definition?.name ?? "");
        const raw = await readTextSafe(path);
        const exists = raw.length > 0;
        const cookies = parseCookieJar(raw);
        if (args.clear && exists) await Deno.remove(path).catch(() => {});
        const record: z.infer<typeof CookieJarRecordSchema> = {
          path,
          exists,
          count: cookies.length,
          cookies,
          raw: args.raw ? raw : undefined,
          cleared: args.clear && exists,
        };
        const handle = await ctx.writeResource(
          "cookieJar",
          "cookieJar",
          record,
        );
        ctx.logger?.info("Cookie jar {path}: {count} cookie(s){cleared}", {
          path,
          count: cookies.length,
          cleared: args.clear && exists ? " (cleared)" : "",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
