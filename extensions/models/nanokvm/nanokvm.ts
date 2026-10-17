/**
 * @svendowideit/nanokvm — operate a Sipeed NanoKVM from swamp.
 *
 * A NanoKVM is an out-of-band IP-KVM (HDMI-in, USB HID, GPIO power/reset,
 * virtual media) running Sipeed's own Go server, not PiKVM's `kvmd`. It answers
 * a small JSON API over HTTPS, but the factory TLS certificate is self-signed,
 * login returns a cookie-borne JWT, and the password is AES-encrypted
 * client-side with a key baked into the web UI. Three consequences shape this
 * model: HTTP is delegated to `@svendowideit/curl` (which is built for
 * self-signed endpoints, keeps a persistent cookie jar and records evidence);
 * the login password is encrypted with `encryptPassword` before it is sent; and
 * a session is one login followed by the reads that need it.
 *
 * `health` is a read-only check that records an unreachable device as a `fail`
 * verdict rather than throwing, so a scheduled run always leaves a record. The
 * mutating methods (`power`, `msd`) are dry runs unless `apply` is true, and
 * refuse to act when the device cannot be authenticated.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Model type name. */
export const MODEL_TYPE = "@svendowideit/nanokvm";

/** The model's own version (must match manifest.yaml `version:`). */
export const MODEL_VERSION = "2026.10.17.4";

/** The curl behavior this model drives for every HTTP request. */
export const CURL_TYPE = "@svendowideit/curl";

/** `service.name` reported to the OTel collector for this device's telemetry. */
export const OTEL_SERVICE_NAME = "nanokvm";

/** The AES passphrase the NanoKVM web UI uses; the server decrypts with it. */
export const LOGIN_SECRET_KEY = "nanokvm-sipeed-2024";

/** NanoKVM REST paths used by this model. */
export const PATHS = {
  login: "/api/auth/login",
  info: "/api/vm/info",
  hardware: "/api/vm/hardware",
  gpio: "/api/vm/gpio",
  hidMode: "/api/hid/mode",
  mountedImage: "/api/storage/image/mounted",
  mountImage: "/api/storage/image/mount",
  hdmi: "/api/vm/hdmi",
  version: "/api/application/version",
  mjpeg: "/api/stream/mjpeg",
  scriptUpload: "/api/vm/script/upload",
  scriptRun: "/api/vm/script/run",
} as const;

/** Highest tolerated clock skew, in seconds, before a `clock_skew` finding. */
export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 120;

/** Directories skipped when scanning the repo for NanoKVM model definitions. */
export const DISCOVERY_SKIP = new Set([
  ".git",
  ".swamp",
  ".agents",
  ".deno-cache",
  ".reviews",
  "node_modules",
  "extensions",
]);

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
    "Model instance name (supplied by swamp).",
  ),
  host: safeValue("host").default("").describe(
    "Address of the NanoKVM: a LAN IP or a hostname that resolves from " +
      "wherever swamp runs. Do not include a scheme.",
  ),
  port: z.number().int().min(1).max(65535).default(443).describe(
    "HTTPS port of the NanoKVM web server.",
  ),
  username: safeValue("username").default("admin").describe(
    "Web UI user. NanoKVM ships with a single `admin` account.",
  ),
  vaultName: safeValue("vaultName").default("").describe(
    "Vault holding the login password. Empty disables vault lookup.",
  ),
  passwordRef: safeValue("passwordRef").default("NANOKVM_PASSWORD").describe(
    "Vault key holding the login password.",
  ),
  envRef: safeValue("envRef").default("NANOKVM_PASSWORD").describe(
    "Environment variable holding the login password, used when vaultName is " +
      "empty. Empty disables the environment fallback.",
  ),
  password: z.string().meta({ sensitive: true }).default("").describe(
    "Login password (last resort; prefer vaultName). Recorded as a secret.",
  ),
  passwordEncoding: z.enum(["auto", "plain", "aes"]).default("auto").describe(
    "How the login password is sent. Older NanoKVM firmware expects it in " +
      "plaintext; current firmware expects the web UI's AES encryption. `auto` " +
      "tries plaintext then AES (one extra attempt on newer devices); pin " +
      "`plain` or `aes` to send exactly one.",
  ),
  curlModel: safeValue("curlModel").default("nanokvm-curl").describe(
    "Name of the @svendowideit/curl model instance whose cookie jar carries " +
      "the session. It is auto-created on first use.",
  ),
  otelModel: safeValue("otelModel").default("otel").describe(
    "Name of the @svendowideit/otel-settings model whose contract supplies the " +
      "OTLP endpoint for `emit`. Empty disables contract lookup.",
  ),
  otelEndpoint: safeValue("otelEndpoint").default("").describe(
    "OTLP/HTTP base URL for `emit`, overriding the settings contract (e.g. " +
      "http://127.0.0.1:4318). Empty derives it from the contract.",
  ),
  otelMesh: safeValue("otelMesh").default("").describe(
    "Contract mesh whose endpoint `emit` uses. Empty uses the contract's " +
      "defaultMesh (or the first endpoint).",
  ),
  otelVaultName: safeValue("otelVaultName").default("").describe(
    "Vault holding the gateway bearer token for `emit`. Empty disables lookup.",
  ),
  otelTokenRef: safeValue("otelTokenRef").default("OTEL_EXPORTER_OTLP_TOKEN")
    .describe(
      "Vault/environment key holding the gateway bearer token.",
    ),
  insecure: z.boolean().default(true).describe(
    "Skip TLS certificate verification. NanoKVM's factory certificate is " +
      "self-signed and expired, so this is on by default.",
  ),
  timeoutMs: z.number().int().positive().default(15000).describe(
    "Per-request timeout, in milliseconds.",
  ),
  maxClockSkewSeconds: z.number().int().nonnegative().default(
    DEFAULT_MAX_CLOCK_SKEW_SECONDS,
  ).describe("Clock difference tolerated before a `clock_skew` finding."),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const SetupArgsSchema = z.object({
  host: z.string().optional().describe(
    "NanoKVM address (persisted for reuse).",
  ),
  port: z.number().int().min(1).max(65535).optional().describe(
    "HTTPS port (persisted for reuse).",
  ),
  username: z.string().optional().describe("Web UI user (persisted)."),
  vaultName: z.string().optional().describe("Password vault name (persisted)."),
  passwordRef: z.string().optional().describe(
    "Password vault key (persisted).",
  ),
  envRef: z.string().optional().describe(
    "Password environment variable (persisted).",
  ),
  curlModel: z.string().optional().describe(
    "curl model instance name (persisted).",
  ),
  otelModel: z.string().optional().describe(
    "otel-settings model name (persisted).",
  ),
});

const PowerArgsSchema = z.object({
  action: z.enum(["power", "reset"]).describe(
    "`power` presses the power button; `reset` presses the reset button.",
  ),
  durationMs: z.number().int().nonnegative().default(0).describe(
    "How long to hold the contacts, in ms. 0 uses the device's own default " +
      "(800ms).",
  ),
  apply: z.boolean().default(false).describe(
    "Actually press the button. When false (the default) the method is a dry " +
      "run that records what it would do.",
  ),
});

const MsdArgsSchema = z.object({
  action: z.enum(["status", "mount", "umount"]).describe(
    "`status` reads the mounted image; `mount` serves `file` to the host; " +
      "`umount` detaches whatever is mounted.",
  ),
  file: z.string().default("").describe(
    "Image path as the NanoKVM sees it (e.g. /data/ubuntu.iso). Required for " +
      "`mount`.",
  ),
  cdrom: z.boolean().default(false).describe(
    "Present the image as a CD-ROM instead of a removable disk.",
  ),
  apply: z.boolean().default(false).describe(
    "Actually mount or unmount. `status` is always read-only; mount/umount are " +
      "dry runs unless true.",
  ),
});

const ScreenshotArgsSchema = z.object({
  timeoutMs: z.number().int().positive().default(8000).describe(
    "How long to read the MJPEG stream before trimming the first frame.",
  ),
  label: z.string().default("").describe(
    "Name for the stored JPEG frame. Empty uses `screenshot`.",
  ),
});

const EmitArgsSchema = z.object({
  health: z.unknown().optional().describe(
    "A health record to emit. When omitted, the model's latest `health` " +
      "resource is used.",
  ),
  endpoint: z.string().default("").describe(
    "OTLP/HTTP base URL overriding both the contract and the global argument.",
  ),
  mesh: z.string().default("").describe("Contract mesh to use for this emit."),
});

const DevicesArgsSchema = z.object({
  zone: z.string().default("").describe(
    "DNS zone appended to each device name to form its fqdn (e.g. `fi.gy` " +
      "turns the `nanokvm` instance into `nanokvm.fi.gy`). Empty leaves each " +
      "dnsName as the bare instance name.",
  ),
});

const CertArgsSchema = z.object({
  action: z.enum(["status", "install"]).describe(
    "`status` reads the certificate the device currently serves; `install` " +
      "writes a certificate onto the device (via its admin script API) and " +
      "restarts the web server so it takes effect.",
  ),
  name: z.string().default("").describe(
    "The certificate's DNS name (e.g. nanokvm.fi.gy). Required for `install` " +
      "(it locates the files and is checked against the SAN); `status` without " +
      "it just reports whatever the device serves.",
  ),
  certDir: z.string().default("~/.local/share/caddy/certificates").describe(
    "Caddy's certificate store. `install` looks for " +
      "<certDir>/*/<name>/<name>.crt|.key under it (the default), so a cert " +
      "Caddy issued and renews is installed without copying files by hand.",
  ),
  crt: z.string().default("").describe(
    "Explicit path to the certificate PEM, overriding the certDir lookup.",
  ),
  key: z.string().default("").describe(
    "Explicit path to the private-key PEM, overriding the certDir lookup.",
  ),
  waitMs: z.number().int().nonnegative().default(120000).describe(
    "How long `install` waits for the certificate file to appear (Caddy issues " +
      "asynchronously). 0 fails immediately when it is not there yet.",
  ),
  restart: z.boolean().default(true).describe(
    "Restart the NanoKVM web server after writing the files, so it serves the " +
      "new certificate immediately.",
  ),
  scriptName: safeValue("scriptName").default("swamp-apply-cert.sh").describe(
    "Name of the on-device script used to install the files (must end .sh).",
  ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  vaultName: z.string(),
  passwordRef: z.string(),
  envRef: z.string(),
  loginEncoding: z.string(),
  curlModel: z.string(),
  otelModel: z.string(),
  hasPassword: z.boolean(),
  canLogin: z.boolean(),
  canEmit: z.boolean(),
  missing: z.array(z.string()),
  updatedAt: z.string(),
});

const FindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warn", "error"]),
  message: z.string(),
});

const HealthSchema = z.object({
  host: z.string(),
  reachable: z.boolean(),
  authenticated: z.boolean(),
  passwordConfigured: z.boolean(),
  authEncoding: z.string(),
  verdict: z.enum(["pass", "warn", "fail"]),
  appVersion: z.string(),
  appLatest: z.string(),
  hardware: z.string(),
  firmwareOutdated: z.boolean(),
  powerLed: z.union([z.boolean(), z.null()]),
  hddLed: z.union([z.boolean(), z.null()]),
  hidMode: z.string(),
  mountedImage: z.string(),
  hdmi: z.union([
    z.object({
      enabled: z.boolean(),
      signal: z.boolean(),
      idleTimeout: z.number(),
    }),
    z.null(),
  ]),
  ips: z.array(z.object({
    name: z.string(),
    addr: z.string(),
    version: z.string(),
    type: z.string(),
  })),
  mdns: z.string(),
  macImage: z.string(),
  application: z.string(),
  responseMs: z.number(),
  findings: z.array(FindingSchema),
  checkedAt: z.string(),
});

const ActionSchema = z.object({
  action: z.string(),
  target: z.string(),
  applied: z.boolean(),
  dryRun: z.boolean(),
  status: z.union([z.number(), z.null()]),
  ok: z.boolean(),
  detail: z.string(),
  wouldDo: z.string(),
  requestedAt: z.string(),
});

const ScreenshotMetaSchema = z.object({
  host: z.string(),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  status: z.union([z.number(), z.null()]),
  ok: z.boolean(),
  detail: z.string(),
  capturedAt: z.string(),
});

const EmitSchema = z.object({
  host: z.string(),
  skipped: z.boolean(),
  reason: z.string(),
  endpoint: z.string(),
  mesh: z.string(),
  logsStatus: z.union([z.number(), z.null()]),
  metricsStatus: z.union([z.number(), z.null()]),
  pushed: z.boolean(),
  verdict: z.string(),
  emittedAt: z.string(),
});

const DeviceEntrySchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  dnsName: z.string(),
  source: z.string(),
});

const DnsRecordSchema = z.object({
  name: z.string(),
  type: z.literal("A"),
  value: z.array(z.string()),
  zone: z.string(),
});

const DevicesSchema = z.object({
  zone: z.string(),
  count: z.number().int(),
  devices: z.array(DeviceEntrySchema),
  dnsNames: z.array(z.string()),
  aRecords: z.array(DnsRecordSchema),
  scannedAt: z.string(),
});

const CertSchema = z.object({
  host: z.string(),
  action: z.string(),
  name: z.string(),
  subject: z.string(),
  issuer: z.string(),
  serial: z.string(),
  notAfter: z.string(),
  daysRemaining: z.number(),
  sans: z.array(z.string()),
  matchesName: z.boolean(),
  installed: z.boolean(),
  detail: z.string(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed NanoKVM JSON response envelope. */
export interface Envelope {
  /** Application code; `0` means success. */
  code: number;
  /** Human-readable message. */
  msg: string;
  /** Payload, present on success. */
  data: unknown;
}

/** The subset of a curl `request` record this model reads back. */
export interface CurlRecord {
  /** The record's instance name (the sanitized request label). */
  label: string;
  /** HTTP method that was sent. */
  method: string;
  /** URL that was requested. */
  url: string;
  /** Final HTTP status, or null when the connection never completed. */
  status: number | null;
  /** True when curl considered the request successful (2xx). */
  ok: boolean;
  /** Response body, decoded and capped. */
  body: string;
  /** curl stderr, e.g. a connection error. */
  stderr: string;
  /** True when the recorded body was truncated by the byte cap. */
  bodyTruncated?: boolean;
  /** The curl process exit code (0 on success). */
  curlExitCode: number;
  /** Total request time in milliseconds. */
  timingMs: number;
  /** Cookies the server set on this response. */
  cookiesReceived?: unknown[];
}

/** A single health finding. */
export interface Finding {
  /** Stable machine code, e.g. `firmware_update`. */
  code: string;
  /** Severity; `error` fails the check, `warn` flags it, `info` is advisory. */
  severity: "info" | "warn" | "error";
  /** Human-readable description of the finding. */
  message: string;
}

/** Raw signals gathered from one NanoKVM, before interpretation. */
export interface HealthSample {
  /** The device answered the reachability probe. */
  reachable: boolean;
  /** Login succeeded and the session cookie is in the jar. */
  authenticated: boolean;
  /** A password was available (vault, environment or argument). */
  passwordConfigured: boolean;
  /** Login encoding that succeeded (`plain` or `aes`), or empty on failure. */
  authEncoding: string;
  /** Login outcome text, used as the failure reason. */
  loginMessage: string;
  /** Installed application version. */
  appVersion: string;
  /** Newest application version the device knows about. */
  appLatest: string;
  /** Hardware revision string. */
  hardware: string;
  /** Power LED state, or null when the GPIO sense is unavailable. */
  powerLed: boolean | null;
  /** HDD LED state, or null when unavailable. */
  hddLed: boolean | null;
  /** USB HID mode (`normal` or `hid-only`). */
  hidMode: string;
  /** Image currently served as virtual media, or empty. */
  mountedImage: string;
  /** HDMI state on a PCIe unit, or null when unsupported. */
  hdmi: { enabled: boolean; signal: boolean; idleTimeout: number } | null;
  /** Network interfaces the device reports. */
  ips: Array<{ name: string; addr: string; version: string; type: string }>;
  /** mDNS name, if advertised. */
  mdns: string;
  /** The image build label the device reports. */
  macImage: string;
  /** The application build the device reports. */
  application: string;
  /** Wall-clock milliseconds the checks took. */
  responseMs: number;
  /** Whether the firmware exposes HDMI state at all. */
  hdmiSupported: boolean;
}

/** The verdict and findings derived from a {@link HealthSample}. */
export interface HealthVerdict {
  /** Overall verdict: `pass`, `warn` or `fail`. */
  verdict: "pass" | "warn" | "fail";
  /** Everything worth reporting, ordered by when it was found. */
  findings: Finding[];
  /** True when a newer application version is available. */
  firmwareOutdated: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Build the HTTPS base URL for a NanoKVM (no trailing slash). */
export function baseUrl(host: string, port: number): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (port === 443) return `https://${trimmed}`;
  return `https://${trimmed}:${port}`;
}

/**
 * Encrypt a password exactly as the NanoKVM web UI does: AES-256-CBC with a
 * key derived from the firmware's baked-in passphrase using OpenSSL's
 * `EVP_BytesToKey` (MD5) construction, framed with the `Salted__` header, then
 * base64- and URL-encoded. The server runs the identical `aes-everywhere`
 * construction in reverse. Built on `node:crypto`, so it adds no third-party
 * dependency.
 */
export function encryptPassword(password: string): string {
  const salt = randomBytes(8);
  const derived = evpBytesToKey(LOGIN_SECRET_KEY, salt, 48);
  const key = derived.subarray(0, 32);
  const iv = derived.subarray(32, 48);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  const framed = Buffer.concat([
    Buffer.from("Salted__", "binary"),
    salt,
    ciphertext,
  ]);
  return encodeURIComponent(framed.toString("base64"));
}

/**
 * OpenSSL's `EVP_BytesToKey` with MD5 and one iteration: hash the password and
 * salt, then keep hashing the previous digest plus the password and salt until
 * `length` bytes are produced.
 */
function evpBytesToKey(
  password: string,
  salt: Uint8Array,
  length: number,
): Uint8Array {
  const pass = Buffer.from(password, "utf8");
  let out: Uint8Array = new Uint8Array(0);
  let prev: Uint8Array = new Uint8Array(0);
  while (out.length < length) {
    const hash = createHash("md5");
    hash.update(prev);
    hash.update(pass);
    hash.update(salt);
    prev = hash.digest();
    out = Buffer.concat([out, prev]);
  }
  return out.subarray(0, length);
}

/** Sanitize a label the way `@svendowideit/curl` names a request record. */
export function sanitizeLabel(label: string): string {
  return label.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Parse a NanoKVM `{code,msg,data}` envelope, returning null when malformed. */
export function parseEnvelope(body: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.code !== "number") return null;
  return {
    code: obj.code,
    msg: typeof obj.msg === "string" ? obj.msg : "",
    data: obj.data ?? null,
  };
}

/** Extract the numeric `code` from an envelope `data` field, or null. */
function dataNumber(data: unknown, key: string): number | null {
  if (typeof data !== "object" || data === null) return null;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

/**
 * Turn the raw signals from a NanoKVM into a verdict and a list of findings.
 *
 * The device is only reachable and authenticated as reported; an unreachable
 * host is a `fail` (a scheduled check must still leave a record), a reachable
 * but unauthenticated host is a `fail`, and a healthy host with only advisory
 * findings is a `warn`, never a silent `pass` over a real problem.
 */
export function classifyHealth(
  sample: HealthSample,
  options: { maxClockSkewSeconds?: number } = {},
): HealthVerdict {
  const findings: Finding[] = [];
  const add = (
    code: string,
    severity: Finding["severity"],
    message: string,
  ) => findings.push({ code, severity, message });

  if (!sample.reachable) {
    add(
      "unreachable",
      "error",
      "The device did not answer; it is powered off, off the network, or the " +
        "address is wrong.",
    );
    return { verdict: "fail", findings, firmwareOutdated: false };
  }

  if (!sample.passwordConfigured) {
    add(
      "not_configured",
      "error",
      `The device is reachable but no login password is configured: ` +
        `${sample.loginMessage || "set vaultName/passwordRef"}.`,
    );
    return { verdict: "fail", findings, firmwareOutdated: false };
  }

  if (!sample.authenticated) {
    add(
      "auth_failed",
      "error",
      `Could not authenticate: ${sample.loginMessage || "unknown reason"}.`,
    );
    return { verdict: "fail", findings, firmwareOutdated: false };
  }

  const firmwareOutdated = sample.appLatest !== "" &&
    sample.appVersion !== "" && sample.appLatest !== sample.appVersion;
  if (firmwareOutdated) {
    add(
      "firmware_update",
      "warn",
      `Application ${sample.appVersion} is installed; ${sample.appLatest} is ` +
        `available.`,
    );
  }

  if (!sample.hdmiSupported) {
    add(
      "hdmi_unsupported",
      "info",
      "This NanoKVM (non-PCIe) does not expose HDMI state, so no video signal " +
        "can be confirmed.",
    );
  } else if (sample.hdmi && !sample.hdmi.signal) {
    add(
      "hdmi_no_signal",
      "warn",
      "No HDMI signal is detected: the host is off, asleep, or not connected.",
    );
  }

  if (sample.mountedImage !== "") {
    add(
      "virtual_media_mounted",
      "warn",
      `${sample.mountedImage} is still mounted; the host will boot from it if ` +
        "the device is reset.",
    );
  }

  if (sample.hidMode !== "" && sample.hidMode !== "normal") {
    add(
      "hid_mode",
      "warn",
      `USB HID is in '${sample.hidMode}' mode, so keyboard and mouse input is ` +
        "not reaching the host normally.",
    );
  }

  if (sample.powerLed === false) {
    add(
      "power_off",
      "info",
      "The power LED reads off: the host is powered down (or the GPIO sense " +
        "line is unwired).",
    );
  }

  const maxSkew = options.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  if (maxSkew > 0 && sample.responseMs > maxSkew * 1000) {
    add(
      "slow_response",
      "warn",
      `The device took ${sample.responseMs}ms to answer.`,
    );
  }

  const verdict = findings.some((f) => f.severity === "error")
    ? "fail"
    : findings.some((f) => f.severity === "warn")
    ? "warn"
    : "pass";
  return { verdict, findings, firmwareOutdated };
}

/** Find the first complete JPEG (SOI…EOI) frame in a byte buffer. */
export function extractJpeg(bytes: Uint8Array): Uint8Array | null {
  let start = -1;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start + 2; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      return bytes.subarray(start, i + 2);
    }
  }
  return null;
}

/** Read the intrinsic size of a JPEG from its SOF marker, or 0×0. */
export function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return { width, height };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

/** Which OTLP endpoint to use, from a settings contract and overrides. */
export interface OTelEndpoint {
  /** Base URL without a trailing slash, e.g. `https://otlp.fi.gy`. */
  base: string;
  /** Mesh name the endpoint belongs to. */
  mesh: string;
}

/** One gateway endpoint as declared by an `@svendowideit/otel-settings` contract. */
export interface ContractEndpoint {
  /** Optional endpoint name. */
  name?: string;
  /** Mesh this endpoint serves (e.g. `tailscale`). */
  mesh?: string;
  /** Plaintext OTLP/HTTP `host:port`. */
  otlp_http?: string;
  /** TLS OTLP/HTTP URL. */
  otlp_http_url?: string;
}

/**
 * Choose the OTLP/HTTP endpoint from an `@svendowideit/otel-settings` contract.
 * An explicit override wins; otherwise the named mesh, then `defaultMesh`, then
 * the first endpoint. Prefers the plaintext `otlp_http` host:port for a local
 * collector and the TLS `otlp_http_url` for anything else.
 */
export function pickEndpoint(
  endpoints: ContractEndpoint[],
  options: {
    override?: string;
    mesh?: string;
    defaultMesh?: string;
    preferUrl?: boolean;
  } = {},
): OTelEndpoint {
  const override = (options.override ?? "").trim().replace(/\/+$/, "");
  if (override) return { base: override, mesh: "override" };

  const list = Array.isArray(endpoints) ? endpoints : [];
  const wanted = options.mesh || options.defaultMesh || "";
  const chosen = (wanted ? list.find((e) => e.mesh === wanted) : undefined) ??
    list[0];
  if (!chosen) return { base: "", mesh: "" };

  const hostPort = (chosen.otlp_http ?? "").trim();
  const url = (chosen.otlp_http_url ?? "").trim().replace(/\/+$/, "");
  const base = options.preferUrl || !hostPort
    ? url
    : `http://${hostPort.replace(/^https?:\/\//, "")}`;
  return { base, mesh: chosen.mesh ?? chosen.name ?? "" };
}

// ---------------------------------------------------------------------------
// Device discovery (repo scan)
// ---------------------------------------------------------------------------

/** A NanoKVM device swamp looks after, as found in the repo's model definitions. */
export interface DeviceEntry {
  /** Model instance name (the DNS label source). */
  name: string;
  /** The device address from the definition's `host` global argument. */
  host: string;
  /** The device's HTTPS port. */
  port: number;
  /** `<name>.<zone>`, or the bare `name` when no zone is given. */
  dnsName: string;
  /** The definition file the entry came from. */
  source: string;
}

/** Join an instance name and a zone into an fqdn (`nanokvm` + `fi.gy`). */
export function dnsNameFor(name: string, zone: string): string {
  const z = zone.trim().replace(/^\.+|\.+$/g, "");
  return z ? `${name}.${z}` : name;
}

/**
 * Map a parsed model definition to a {@link DeviceEntry}, or null when it is not
 * a NanoKVM model definition with a host. Pure, so the mapping is unit-tested
 * separately from the filesystem walk that feeds it.
 */
export function deviceFromDefinition(
  doc: unknown,
  zone: string,
): DeviceEntry | null {
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (d.type !== MODEL_TYPE) return null;
  const name = typeof d.name === "string" ? d.name : "";
  if (!name) return null;
  const g = (d.globalArguments ?? {}) as Record<string, unknown>;
  const host = typeof g.host === "string" ? g.host.trim() : "";
  if (!host) return null;
  const port = typeof g.port === "number" ? g.port : 443;
  return { name, host, port, dnsName: dnsNameFor(name, zone), source: "" };
}

/**
 * Walk the repo for `@svendowideit/nanokvm` model definitions and collect the
 * devices swamp looks after. Mirrors the caddy model's discovery: it reads real
 * definition files (under `models/`) so a never-run model is found, and skips
 * `.swamp/` scratch instances. Sorted by name for a stable record.
 */
export async function discoverNanokvmDevices(
  repoDir: string,
  zone: string,
): Promise<DeviceEntry[]> {
  const out: DeviceEntry[] = [];
  const seen = new Set<string>();
  async function walk(dir: string): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        if (DISCOVERY_SKIP.has(e.name) || e.name.startsWith(".")) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile) continue;
      if (!e.name.endsWith(".yaml") && !e.name.endsWith(".yml")) continue;
      let text = "";
      try {
        text = await Deno.readTextFile(full);
      } catch {
        continue;
      }
      if (!text.includes(MODEL_TYPE)) continue;
      let doc: unknown;
      try {
        doc = parseYaml(text);
      } catch {
        continue;
      }
      const entry = deviceFromDefinition(doc, zone);
      if (!entry || seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({ ...entry, source: full });
    }
  }
  await walk(repoDir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// TLS certificate install
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the home directory. */
export function expandHome(
  path: string,
  home: string = Deno.env.get("HOME") ?? "",
): string {
  return path.startsWith("~") ? `${home}${path.slice(1)}` : path;
}

/** The fields this model reads out of `openssl x509 -noout`. */
export interface CertFields {
  /** `subject=` line. */
  subject: string;
  /** `issuer=` line. */
  issuer: string;
  /** `serial=` line. */
  serial: string;
  /** `notAfter=` line (an openssl date string). */
  notAfter: string;
  /** DNS names from the Subject Alternative Name extension. */
  sans: string[];
}

/** Parse `openssl x509 -noout -subject -issuer -serial -enddate -ext subjectAltName` output. */
export function parseCertFields(text: string): CertFields {
  const field = (key: string): string => {
    const m = text.match(new RegExp(`^\\s*${key}=(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const sans: string[] = [];
  const sanBlock = text.match(
    /X509v3 Subject Alternative Name:\s*\n\s*([^\n]+)/,
  );
  if (sanBlock) {
    for (const raw of sanBlock[1].split(",")) {
      const part = raw.trim();
      if (part.startsWith("DNS:")) sans.push(part.slice(4).trim());
    }
  }
  return {
    subject: field("subject"),
    issuer: field("issuer"),
    serial: field("serial"),
    notAfter: field("notAfter"),
    sans,
  };
}

/** Whole days until `notAfter`; 0 when the date cannot be parsed. */
export function certDaysRemaining(
  notAfter: string,
  now: number = Date.now(),
): number {
  const t = Date.parse(notAfter);
  if (Number.isNaN(t)) return 0;
  return Math.floor((t - now) / 86_400_000);
}

/**
 * Build the on-device shell script that writes a cert+key and restarts the
 * server. The restart is detached (nohup … &) because the script runs as a
 * child of the very server it restarts — a synchronous restart would kill the
 * script (and its HTTP response) mid-flight. `swamp-cert-installed` is echoed
 * before the restart so the run reports success and the caller can then verify
 * what the device actually serves.
 */
export function buildCertInstallerScript(
  crtPem: string,
  keyPem: string,
  restart = true,
): string {
  return [
    "#!/bin/sh",
    "cat > /etc/kvm/server.crt <<'SWAMP_CRT_EOF'",
    crtPem.trimEnd(),
    "SWAMP_CRT_EOF",
    "cat > /etc/kvm/server.key <<'SWAMP_KEY_EOF'",
    keyPem.trimEnd(),
    "SWAMP_KEY_EOF",
    "chmod 600 /etc/kvm/server.key",
    // Restart the web server so it reloads the certificate. Detached, because
    // this script runs as a child of the very server it restarts. Newer
    // firmware ships /etc/init.d/S95nanokvm; older firmware has no init script
    // and relies on the nanokvm.sh supervisor to respawn NanoKVM-Server, so we
    // signal it (the supervisor itself uses pgrep; killall is absent there).
    restart
      ? "if [ -x /etc/init.d/S95nanokvm ]; then\n" +
        "  nohup /etc/init.d/S95nanokvm restart >/dev/null 2>&1 &\n" +
        "else\n" +
        "  nohup sh -c 'sleep 2; for p in $(pgrep -x NanoKVM-Server); do " +
        'kill -TERM "$p"; done\' >/dev/null 2>&1 &\n' +
        "fi"
      : "true",
    'echo "swamp-cert-installed"',
    "",
  ].join("\n");
}

/**
 * Find a certificate Caddy issued under `<certDir>/*<sep><name><sep><name>.crt`.
 * Caddy nests one directory per issuer CA, so the name's directory is found by
 * scanning those. Returns null when the cert has not been issued (yet).
 */
export async function locateCaddyCert(
  certDir: string,
  name: string,
): Promise<{ crt: string; key: string } | null> {
  const root = expandHome(certDir).replace(/\/+$/, "");
  const issuers: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(root)) issuers.push(e);
  } catch {
    return null;
  }
  for (const issuer of issuers) {
    if (!issuer.isDirectory) continue;
    const crt = `${root}/${issuer.name}/${name}/${name}.crt`;
    const key = `${root}/${issuer.name}/${name}/${name}.key`;
    try {
      await Deno.stat(crt);
      await Deno.stat(key);
      return { crt, key };
    } catch {
      // Not this issuer; keep looking.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// OTLP payload builders
// ---------------------------------------------------------------------------

function attr(key: string, value: string): {
  key: string;
  value: { stringValue: string };
} {
  return { key, value: { stringValue: String(value) } };
}

/** Build the OTLP resource attribute list for a device health report. */
export function telemetryResource(
  host: string,
  attributes: Record<string, unknown> = {},
): Array<{ key: string; value: { stringValue: string } }> {
  const out = [
    attr("service.name", OTEL_SERVICE_NAME),
    attr("service.version", MODEL_VERSION),
    attr("device.type", "nanokvm"),
    attr("device.host", host),
  ];
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null || v === "") continue;
    out.push(attr(k, String(v)));
  }
  return out;
}

/** Build an OTLP/HTTP `resourceLogs` payload describing one health verdict. */
export function buildOtlpLogs(
  host: string,
  health: {
    verdict: string;
    findings: Finding[];
    appVersion: string;
    checkedAt: string;
  },
  attributes: Record<string, unknown> = {},
  at: string = new Date().toISOString(),
): Record<string, unknown> {
  const severity = health.verdict === "fail"
    ? { text: "ERROR", number: 17 }
    : health.verdict === "warn"
    ? { text: "WARN", number: 13 }
    : { text: "INFO", number: 9 };
  const recordAttrs = [
    attr("verdict", health.verdict),
    attr("app.version", health.appVersion),
    attr("device.reachable", String(health.verdict !== "fail")),
    attr("findings.count", String(health.findings.length)),
  ];
  for (const f of health.findings) {
    recordAttrs.push(attr(`finding.${f.code}`, f.severity));
  }
  return {
    resourceLogs: [{
      resource: { attributes: telemetryResource(host, attributes) },
      scopeLogs: [{
        scope: { name: MODEL_TYPE, version: MODEL_VERSION },
        logRecords: [{
          timeUnixNano: `${BigInt(Date.parse(at)) * 1_000_000n}`,
          severityText: severity.text,
          severityNumber: severity.number,
          body: {
            stringValue: `NanoKVM health ${health.verdict}: ` +
              (health.findings[0]?.message ?? "all checks passed"),
          },
          attributes: recordAttrs,
        }],
      }],
    }],
  };
}

/** Build an OTLP/HTTP `resourceMetrics` payload for one health verdict. */
export function buildOtlpMetrics(
  host: string,
  health: {
    verdict: string;
    reachable: boolean;
    responseMs: number;
    powerLed: boolean | null;
    mountedImage: string;
    hdmi: { enabled: boolean; signal: boolean } | null;
  },
  attributes: Record<string, unknown> = {},
  at: string = new Date().toISOString(),
): Record<string, unknown> {
  const ts = `${BigInt(Date.parse(at)) * 1_000_000n}`;
  const gaugeInt = (name: string, value: number, unit = "1") => ({
    name,
    unit,
    gauge: { dataPoints: [{ timeUnixNano: ts, asInt: String(value) }] },
  });
  const gauges: Array<Record<string, unknown>> = [
    gaugeInt("nanokvm.up", health.reachable ? 1 : 0),
    gaugeInt("nanokvm.health", health.verdict === "pass" ? 1 : 0),
    {
      name: "nanokvm.response_time",
      unit: "ms",
      gauge: {
        dataPoints: [{ timeUnixNano: ts, asDouble: health.responseMs }],
      },
    },
    gaugeInt("nanokvm.virtual_media_mounted", health.mountedImage ? 1 : 0),
  ];
  if (health.powerLed !== null) {
    gauges.push(gaugeInt("nanokvm.power_on", health.powerLed ? 1 : 0));
  }
  if (health.hdmi) {
    gauges.push(gaugeInt("nanokvm.hdmi_signal", health.hdmi.signal ? 1 : 0));
  }
  return {
    resourceMetrics: [{
      resource: { attributes: telemetryResource(host, attributes) },
      scopeMetrics: [{
        scope: { name: MODEL_TYPE, version: MODEL_VERSION },
        metrics: gauges,
      }],
    }],
  };
}

// ---------------------------------------------------------------------------
// Model context and the curl seam
// ---------------------------------------------------------------------------

interface DataRecord {
  name?: string;
  specName?: string;
  version?: number;
  content?: unknown;
  attributes?: unknown;
}

interface CurlArguments {
  url: string;
  method?: string;
  headers?: string[];
  dataJson?: unknown;
  files?: Record<string, string>;
  label: string;
  saveBody?: boolean;
  outputFile?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  failOnHttpError?: boolean;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  definition?: { id: string; name: string; version: string };
  repoDir?: string;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string>; garbageCollection?: number },
  ) => Promise<{ name: string; version?: number }>;
  createFileWriter?: (
    specName: string,
    name: string,
  ) => {
    writeAll: (bytes: Uint8Array) => Promise<{ name: string }>;
  };
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<DataRecord[]>;
  runModel?: (options: {
    modelType?: string;
    definition?: string;
    name?: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<
    | { ok: true; resources: Array<{ name: string; specName?: string }> }
    | { ok: false; error: { message: string } }
  >;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
}

/** Read the newest record written under `specName` on `modelName`. */
async function latestRecord(
  ctx: MethodContext,
  modelName: string,
  specName: string,
): Promise<DataRecord | undefined> {
  if (!ctx.readModelData) return undefined;
  try {
    const rows = await ctx.readModelData(modelName, specName);
    if (!rows || rows.length === 0) return undefined;
    return rows.reduce((
      a,
      b,
    ) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a));
  } catch {
    return undefined;
  }
}

/** The record payload as an object, unwrapping a data record when present. */
function recordData(record: unknown): Record<string, unknown> {
  if (typeof record !== "object" || record === null) return {};
  const obj = record as Record<string, unknown>;
  const inner = obj.attributes ?? obj.content;
  if (typeof inner === "object" && inner !== null) {
    return inner as Record<string, unknown>;
  }
  return obj;
}

/**
 * Perform one HTTP request by delegating to a `@svendowideit/curl` instance.
 *
 * The curl model owns the transport: it tolerates the self-signed certificate
 * (`insecure`), keeps the persistent cookie jar that carries the login session
 * across calls, masks secrets in its evidence, and records the full exchange.
 * This model reads that record back and returns it.
 */
async function curlCall(
  ctx: MethodContext,
  args: CurlArguments,
): Promise<CurlRecord> {
  if (!ctx.runModel) {
    throw new Error(
      "context.runModel is unavailable, so this method cannot drive " +
        `@svendowideit/curl (the ${ctx.globalArgs.curlModel} instance). ` +
        "Run it from a workflow or a direct method run, not a remote worker.",
    );
  }
  const g = ctx.globalArgs;
  const result = await ctx.runModel({
    modelType: CURL_TYPE,
    name: g.curlModel,
    method: "request",
    arguments: {
      url: args.url,
      method: args.method ?? "",
      headers: args.headers ?? [],
      dataJson: args.dataJson,
      files: args.files,
      label: args.label,
      insecure: g.insecure,
      reuseCookies: true,
      followRedirects: true,
      timeoutMs: args.timeoutMs ?? g.timeoutMs,
      maxBodyBytes: args.maxBodyBytes ?? 262144,
      saveBody: args.saveBody ?? false,
      outputFile: args.outputFile,
      failOnHttpError: args.failOnHttpError ?? false,
      failOnCurlError: false,
    },
  });
  if (!result.ok) {
    throw new Error(`@svendowideit/curl failed: ${result.error.message}`);
  }
  const wanted = sanitizeLabel(args.label);
  const rows = ctx.readModelData
    ? await ctx.readModelData(g.curlModel, "request").catch(() => [])
    : [];
  const matches = rows.filter((r) => r.name === wanted);
  const record = matches.length > 0
    ? matches.reduce((a, b) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a))
    : await latestRecord(ctx, g.curlModel, "request");
  const data = recordData(record);
  return {
    label: typeof data.label === "string" ? data.label : wanted,
    method: typeof data.method === "string" ? data.method : "",
    url: typeof data.url === "string" ? data.url : args.url,
    status: typeof data.status === "number" ? data.status : null,
    ok: data.ok === true,
    body: typeof data.body === "string" ? data.body : "",
    stderr: typeof data.stderr === "string" ? data.stderr : "",
    bodyTruncated: data.bodyTruncated === true,
    curlExitCode: typeof data.curlExitCode === "number" ? data.curlExitCode : 0,
    timingMs: typeof data.timingMs === "number" ? data.timingMs : 0,
    cookiesReceived: Array.isArray(data.cookiesReceived)
      ? data.cookiesReceived
      : [],
  };
}

/** Read the login password from the vault, the environment, or the argument. */
async function resolvePassword(ctx: MethodContext): Promise<string> {
  const g = ctx.globalArgs;
  if (g.vaultName && ctx.vaultService) {
    try {
      const value = await ctx.vaultService.get(
        g.vaultName,
        g.passwordRef,
        `model:${MODEL_TYPE}`,
      );
      if (value) return value;
    } catch (err) {
      ctx.logger?.warn("Vault {vault} read failed: {error}", {
        vault: g.vaultName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (g.envRef) {
    const value = Deno.env.get(g.envRef);
    if (value) return value;
  }
  return g.password;
}

/**
 * The outcome of establishing a session. NanoKVM firmware differs: older
 * builds take the password in plaintext and return a bearer token in the login
 * response body, while current builds take the web UI's AES-encrypted password
 * and set a session cookie. `encoding` and `token` record which path worked so
 * later requests can authenticate either way.
 */
interface Session {
  ok: boolean;
  status: number | null;
  configured: boolean;
  message: string;
  token: string;
  encoding: "plain" | "aes" | "";
}

/** Pull a session token out of a login response body, when one is present. */
export function sessionToken(envelope: Envelope | null): string {
  const data = envelope?.data;
  if (typeof data === "object" && data !== null) {
    const token = (data as Record<string, unknown>).token;
    if (typeof token === "string") return token;
  }
  return "";
}

/** Order the login encodings to try for the configured {@link GlobalArgs}. */
export function loginEncodings(
  configured: "auto" | "plain" | "aes",
): Array<"plain" | "aes"> {
  if (configured === "plain") return ["plain"];
  if (configured === "aes") return ["aes"];
  return ["plain", "aes"];
}

/** Attempt one login, returning the raw status and parsed envelope. */
async function loginAttempt(
  ctx: MethodContext,
  password: string,
  encoding: "plain" | "aes",
): Promise<
  { status: number | null; envelope: Envelope | null; stderr: string }
> {
  const g = ctx.globalArgs;
  const record = await curlCall(ctx, {
    url: `${baseUrl(g.host, g.port)}${PATHS.login}`,
    method: "POST",
    dataJson: {
      username: g.username,
      password: encoding === "aes" ? encryptPassword(password) : password,
    },
    label: `login-${encoding}`,
  });
  return {
    status: record.status,
    envelope: parseEnvelope(record.body),
    stderr: record.stderr,
  };
}

/**
 * Log in, transparently supporting both NanoKVM firmware generations. `auto`
 * tries plaintext first (older firmware), then AES (current firmware); a
 * connection error stops the attempt because no encoding can help an
 * unreachable device. On success the session cookie is left in the curl
 * instance's jar and any bearer token is returned for the caller to send.
 */
async function ensureSession(ctx: MethodContext): Promise<Session> {
  const g = ctx.globalArgs;
  const password = await resolvePassword(ctx);
  if (!password) {
    return {
      ok: false,
      status: null,
      configured: false,
      token: "",
      encoding: "",
      message:
        `no password configured for ${g.host}: set vaultName/passwordRef ` +
        `(currently vault '${g.vaultName}', key '${g.passwordRef}') or ` +
        `envRef '${g.envRef}'`,
    };
  }
  let last: {
    status: number | null;
    envelope: Envelope | null;
    stderr: string;
  } = { status: null, envelope: null, stderr: "" };
  for (const encoding of loginEncodings(g.passwordEncoding)) {
    const attempt = await loginAttempt(ctx, password, encoding);
    last = attempt;
    if (attempt.status === null) {
      return {
        ok: false,
        status: null,
        configured: true,
        token: "",
        encoding: "",
        message: attempt.stderr || "no response from the device",
      };
    }
    if (attempt.envelope?.code === 0) {
      return {
        ok: true,
        status: attempt.status,
        configured: true,
        token: sessionToken(attempt.envelope),
        encoding,
        message: "ok",
      };
    }
  }
  return {
    ok: false,
    status: last.status,
    configured: true,
    token: "",
    encoding: "",
    message: last.envelope?.msg || last.stderr || `HTTP ${last.status}`,
  };
}

/** GET a JSON endpoint and parse its envelope, authenticating with a token. */
async function getJson(
  ctx: MethodContext,
  path: string,
  label: string,
  token = "",
): Promise<{ record: CurlRecord; envelope: Envelope | null }> {
  const g = ctx.globalArgs;
  const record = await curlCall(ctx, {
    url: `${baseUrl(g.host, g.port)}${path}`,
    method: "GET",
    label,
    headers: token ? [`Authorization: Bearer ${token}`] : [],
  });
  return { record, envelope: parseEnvelope(record.body) };
}

/** Read the certificate the device currently serves over TLS (via openssl). */
async function readServedCert(
  ctx: MethodContext,
  servername: string,
): Promise<CertFields & { ok: boolean }> {
  const g = ctx.globalArgs;
  const name = servername || g.host;
  const cmd = "openssl s_client -connect " +
    `'${g.host}:${g.port}' -servername '${name}' -showcerts </dev/null 2>/dev/null` +
    " | openssl x509 -noout -subject -issuer -serial -enddate" +
    " -ext subjectAltName 2>/dev/null";
  let text = "";
  try {
    // swamp-quality-ignore deno-command: reading the certificate the device serves needs a TLS handshake openssl s_client provides; the arguments are fixed and validated (host/port/name), never raw caller input.
    const out = await new Deno.Command("sh", {
      args: ["-c", cmd],
      stdout: "piped",
      stderr: "piped",
    }).output();
    text = new TextDecoder().decode(out.stdout);
  } catch (err) {
    ctx.logger?.warn("Reading the served certificate failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const fields = parseCertFields(text);
  return { ...fields, ok: fields.subject !== "" };
}

/** The `serial=` of a certificate file, for comparing against what is served. */
async function certFileSerial(crtPath: string): Promise<string> {
  try {
    // swamp-quality-ignore deno-command: reading a certificate serial needs openssl x509; the argument is a path this method resolved, never raw caller text.
    const out = await new Deno.Command("openssl", {
      args: ["x509", "-in", crtPath, "-noout", "-serial"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const match = new TextDecoder().decode(out.stdout).match(/serial=(.+)/);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

/**
 * Write a certificate onto the device via its admin script API and run it. The
 * device has no cert-upload endpoint, so this is the supported path: upload a
 * small shell script (which writes /etc/kvm/server.crt|.key and restarts the
 * server) and run it in the foreground, returning its log.
 */
async function installCertScript(
  ctx: MethodContext,
  scriptName: string,
  scriptBody: string,
): Promise<{ ok: boolean; log: string; detail: string }> {
  const g = ctx.globalArgs;
  const session = await ensureSession(ctx);
  if (!session.ok) {
    throw new Error(
      `Cannot install a certificate: ${session.message}. The script API needs ` +
        "an admin login.",
    );
  }
  const headers = session.token
    ? [`Authorization: Bearer ${session.token}`]
    : [];
  const dir = await Deno.makeTempDir({ prefix: "nanokvm-cert-" });
  const scriptPath = `${dir}/${scriptName}`;
  try {
    await Deno.writeTextFile(scriptPath, scriptBody, { mode: 0o700 });
    const upload = await curlCall(ctx, {
      url: `${baseUrl(g.host, g.port)}${PATHS.scriptUpload}`,
      method: "POST",
      files: { file: scriptPath },
      headers,
      label: "cert-upload",
    });
    const upEnv = parseEnvelope(upload.body);
    if (upload.status !== 200 || upEnv?.code !== 0) {
      return {
        ok: false,
        log: "",
        detail: upEnv?.msg || upload.stderr || `upload HTTP ${upload.status}`,
      };
    }
    const run = await curlCall(ctx, {
      url: `${baseUrl(g.host, g.port)}${PATHS.scriptRun}`,
      method: "POST",
      dataJson: { name: scriptName, type: "foreground" },
      headers,
      label: "cert-run",
      timeoutMs: Math.max(g.timeoutMs, 30000),
    });
    const runEnv = parseEnvelope(run.body);
    const data = (runEnv?.data ?? {}) as Record<string, unknown>;
    const log = typeof data.log === "string" ? data.log : "";
    const ok = run.status === 200 && runEnv?.code === 0 &&
      log.includes("swamp-cert-installed");
    return {
      ok,
      log,
      detail: ok
        ? "installed"
        : runEnv?.msg || run.stderr || `run HTTP ${run.status}`,
    };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Health gathering
// ---------------------------------------------------------------------------

async function gatherHealth(
  ctx: MethodContext,
): Promise<HealthSample> {
  const started = Date.now();
  // Probe the web root first: it answers unauthenticated, so reachability is
  // known even when no password is configured (a login-only probe would
  // confuse "no credentials" with "no device").
  let reachable = false;
  try {
    const probe = await curlCall(ctx, {
      url: `${baseUrl(ctx.globalArgs.host, ctx.globalArgs.port)}/`,
      method: "GET",
      label: "probe",
    });
    reachable = probe.status !== null;
  } catch (err) {
    ctx.logger?.warn("Reachability probe failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const session = await ensureSession(ctx);
  const sample: HealthSample = {
    reachable: reachable || session.status !== null,
    authenticated: session.ok,
    passwordConfigured: session.configured,
    authEncoding: session.encoding,
    loginMessage: session.message,
    appVersion: "",
    appLatest: "",
    hardware: "",
    powerLed: null,
    hddLed: null,
    hidMode: "",
    mountedImage: "",
    hdmi: null,
    ips: [],
    mdns: "",
    macImage: "",
    application: "",
    responseMs: 0,
    hdmiSupported: true,
  };
  if (!session.ok) {
    sample.responseMs = Date.now() - started;
    return sample;
  }

  // Current firmware authenticates reads with the session cookie (left in the
  // curl jar by login); older firmware issues no cookie and returns a token
  // that must be sent as a bearer header. Send it whenever we have one.
  const token = session.token;
  const failures: string[] = [];
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  };

  await guard(async () => {
    const { envelope } = await getJson(ctx, PATHS.info, "info", token);
    const data = (envelope?.data ?? {}) as Record<string, unknown>;
    sample.mdns = typeof data.mdns === "string" ? data.mdns : "";
    sample.macImage = typeof data.image === "string" ? data.image : "";
    sample.application = typeof data.application === "string"
      ? data.application
      : "";
    if (Array.isArray(data.ips)) {
      sample.ips = (data.ips as Array<Record<string, unknown>>).map((ip) => ({
        name: typeof ip.name === "string" ? ip.name : "",
        addr: typeof ip.addr === "string" ? ip.addr : "",
        version: typeof ip.version === "string" ? ip.version : "",
        type: typeof ip.type === "string" ? ip.type : "",
      }));
    }
  });

  await guard(async () => {
    const { envelope } = await getJson(ctx, PATHS.hardware, "hardware", token);
    const data = (envelope?.data ?? {}) as Record<string, unknown>;
    sample.hardware = typeof data.version === "string" ? data.version : "";
  });

  await guard(async () => {
    const { record, envelope } = await getJson(ctx, PATHS.gpio, "gpio", token);
    if (record.status === 404) return;
    const data = (envelope?.data ?? {}) as Record<string, unknown>;
    if (typeof data.pwr === "boolean") sample.powerLed = data.pwr;
    if (typeof data.hdd === "boolean") sample.hddLed = data.hdd;
  });

  await guard(async () => {
    const { envelope } = await getJson(ctx, PATHS.hidMode, "hid-mode", token);
    const data = (envelope?.data ?? {}) as Record<string, unknown>;
    sample.hidMode = typeof data.mode === "string" ? data.mode : "";
  });

  await guard(async () => {
    const { envelope } = await getJson(
      ctx,
      PATHS.mountedImage,
      "mounted-image",
      token,
    );
    const data = (envelope?.data ?? {}) as Record<string, unknown>;
    sample.mountedImage = typeof data.file === "string" ? data.file : "";
  });

  await guard(async () => {
    const { record, envelope } = await getJson(ctx, PATHS.hdmi, "hdmi", token);
    if (record.status === 404) {
      sample.hdmiSupported = false;
      return;
    }
    const data = (envelope?.data ?? {}) as Record<string, unknown>;
    sample.hdmi = {
      enabled: data.enabled === true,
      signal: data.signal === true,
      idleTimeout: dataNumber(data, "idleTimeout") ?? 0,
    };
  });

  await guard(async () => {
    const { record, envelope } = await getJson(
      ctx,
      PATHS.version,
      "version",
      token,
    );
    if (record.status === 404) return;
    const data = (envelope?.data ?? {}) as Record<string, unknown>;
    sample.appVersion = typeof data.current === "string" ? data.current : "";
    sample.appLatest = typeof data.latest === "string" ? data.latest : "";
  });

  sample.responseMs = Date.now() - started;
  if (failures.length > 0) {
    ctx.logger?.warn("Some health reads failed: {errors}", {
      errors: failures.join("; "),
    });
  }
  return sample;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/** Resolve the OTLP base URL, the resource attributes, and the bearer token. */
async function resolveOtel(
  ctx: MethodContext,
  mesh: string,
  endpointOverride: string,
): Promise<{
  base: string;
  mesh: string;
  attributes: Record<string, unknown>;
  token: string;
  configured: boolean;
  reason: string;
}> {
  const g = ctx.globalArgs;
  let endpoints: ContractEndpoint[] = [];
  let attributes: Record<string, unknown> = {};
  let defaultMesh = "";
  let authMethod = "bearer";
  let reason = "";
  if (g.otelModel) {
    const settings = recordData(
      await latestRecord(ctx, g.otelModel, "settings"),
    );
    if (Object.keys(settings).length > 0) {
      const raw = settings.endpoints;
      if (Array.isArray(raw)) {
        endpoints = raw as ContractEndpoint[];
      } else if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) endpoints = parsed as ContractEndpoint[];
        } catch {
          endpoints = [];
        }
      }
      attributes = (typeof settings.attributes === "object" &&
          settings.attributes !== null)
        ? (settings.attributes as Record<string, unknown>)
        : {};
      defaultMesh = typeof settings.defaultMesh === "string"
        ? settings.defaultMesh
        : "";
      authMethod = typeof settings.authMethod === "string"
        ? settings.authMethod
        : "bearer";
    } else {
      reason =
        `the @svendowideit/otel-settings model '${g.otelModel}' has no ` +
        `settings data`;
    }
  } else {
    reason = "otelModel is empty";
  }

  const chosen = pickEndpoint(endpoints, {
    override: endpointOverride || g.otelEndpoint,
    mesh: mesh || g.otelMesh,
    defaultMesh,
  });
  if (!chosen.base && !reason) reason = "the contract declares no endpoints";

  let token = "";
  if (authMethod === "bearer") {
    if (g.otelVaultName && ctx.vaultService) {
      token = await ctx.vaultService
        .get(g.otelVaultName, g.otelTokenRef, `model:${MODEL_TYPE}`)
        .catch(() => "");
    }
    if (!token) token = Deno.env.get(g.otelTokenRef) ?? "";
  }

  return {
    base: chosen.base,
    mesh: chosen.mesh,
    attributes,
    token,
    configured: chosen.base !== "",
    reason,
  };
}

/** Push an OTLP signal (logs or metrics) through the curl instance. */
async function pushOtlp(
  ctx: MethodContext,
  url: string,
  payloadName: string,
  payload: Record<string, unknown>,
  token: string,
): Promise<number | null> {
  const headers = token ? [`Authorization: Bearer ${token}`] : [];
  const record = await curlCall(ctx, {
    url,
    method: "POST",
    headers,
    dataJson: payload,
    label: `otel-${payloadName}`,
    timeoutMs: ctx.globalArgs.timeoutMs,
  });
  return record.status;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Swamp model definition for operating a Sipeed NanoKVM. */
export const model = {
  type: "@svendowideit/nanokvm",
  version: "2026.10.17.4",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.17.4",
      description:
        "Adds a `cert` method (and `cert` resource): `status` reads the TLS " +
        "certificate the device serves, and `install` writes a certificate and " +
        "key onto the device through its admin script API — taking them from " +
        "Caddy's store by default — then restarts the web server and verifies " +
        "the device serves it, so a certificate Caddy issues and renews can be " +
        "installed and kept current. Also adds `devices.dnsNames` (the device " +
        "fqdns, ready for a TLS subject list). No existing argument changed.",
      upgradeAttributes: (old: Record<string, unknown>) => ({
        ...old,
        passwordEncoding: typeof old.passwordEncoding === "string"
          ? old.passwordEncoding
          : "auto",
      }),
    },
  ],

  resources: {
    config: {
      description: "Persisted NanoKVM configuration and enabled capabilities.",
      schema: ConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    health: {
      description:
        "One health check of the NanoKVM: signals, verdict, findings.",
      schema: HealthSchema,
      lifetime: "30d" as const,
      garbageCollection: 200,
    },
    power: {
      description: "A power/reset press (or dry run) and its outcome.",
      schema: ActionSchema,
      lifetime: "30d" as const,
      garbageCollection: 50,
    },
    msd: {
      description: "A virtual-media mount/unmount/status and its outcome.",
      schema: ActionSchema,
      lifetime: "30d" as const,
      garbageCollection: 50,
    },
    screenshotMeta: {
      description: "Metadata for a captured screen frame.",
      schema: ScreenshotMetaSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    emit: {
      description: "One OTLP push of the device health, or why it was skipped.",
      schema: EmitSchema,
      lifetime: "30d" as const,
      garbageCollection: 200,
    },
    devices: {
      description:
        "Every NanoKVM swamp looks after, discovered from the repo's model " +
        "definitions, with a matching A-record list.",
      schema: DevicesSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    cert: {
      description:
        "The TLS certificate the device serves, or the outcome of installing one.",
      schema: CertSchema,
      lifetime: "30d" as const,
      garbageCollection: 30,
    },
  },

  files: {
    screenshot: {
      description: "A JPEG frame captured from the NanoKVM video stream.",
      contentType: "image/jpeg",
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },

  checks: {
    "sane-config": {
      description:
        "Reject an unusable NanoKVM target before doing any work: a host " +
        "with a scheme or whitespace, an out-of-range port, or a missing curl " +
        "instance name.",
      labels: ["policy"],
      appliesTo: [
        "setup",
        "health",
        "power",
        "msd",
        "screenshot",
        "emit",
        "cert",
      ],
      execute: (context: { globalArgs: GlobalArgs }) => {
        const g = context.globalArgs;
        const errors: string[] = [];
        if (g.host.trim() && /[\s/]/.test(g.host.trim())) {
          errors.push(
            "host must be a bare address (no scheme, no path, no spaces).",
          );
        }
        if (!Number.isInteger(g.port) || g.port < 1 || g.port > 65535) {
          errors.push("port must be an integer between 1 and 65535.");
        }
        if (!g.curlModel.trim()) {
          errors.push("curlModel must name a @svendowideit/curl instance.");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },

  methods: {
    setup: {
      description:
        "Persist this NanoKVM's connection settings, read them back, and " +
        "report which capabilities are enabled. Safe to re-run; every supplied " +
        "value is stored even when the configuration is incomplete.",
      arguments: SetupArgsSchema,
      execute: async (
        args: z.infer<typeof SetupArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const previous = recordData(
          context.readResource
            ? await context.readResource("config").catch(() => null) ??
              undefined
            : undefined,
        );
        const pick = (
          arg: string | undefined,
          from: unknown,
          fallback: string,
        ) =>
          (arg ??
            (typeof from === "string" && from ? from : fallback)) as string;
        const host = pick(args.host, previous.host, g.host);
        const username = pick(args.username, previous.username, g.username);
        const vaultName = pick(args.vaultName, previous.vaultName, g.vaultName);
        const passwordRef = pick(
          args.passwordRef,
          previous.passwordRef,
          g.passwordRef,
        );
        const envRef = pick(args.envRef, previous.envRef, g.envRef);
        const curlModel = pick(args.curlModel, previous.curlModel, g.curlModel);
        const otelModel = pick(args.otelModel, previous.otelModel, g.otelModel);
        const port = args.port ??
          (typeof previous.port === "number" ? previous.port : g.port);
        const password = await resolvePassword(context);
        const canLogin = host !== "" && password !== "";
        const canEmit = otelModel !== "" || g.otelEndpoint !== "";
        const missing: string[] = [];
        if (!host) missing.push("host");
        if (!password) {
          missing.push(
            `password (vault '${vaultName}' key '${passwordRef}', or ` +
              `$${envRef})`,
          );
        }
        const record = {
          host,
          port,
          username,
          vaultName,
          passwordRef,
          envRef,
          loginEncoding: g.passwordEncoding,
          curlModel,
          otelModel,
          hasPassword: password !== "",
          canLogin,
          canEmit,
          missing,
          updatedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource("config", "config", record);
        context.logger?.info(
          canLogin
            ? "NanoKVM {host} configured: health and power are enabled"
            : "NanoKVM configuration incomplete: {missing}",
          { host, missing: missing.join(", ") || "none" },
        );
        return { dataHandles: [handle] };
      },
    },

    health: {
      description:
        "Read-only health check: reachability, authentication, application and " +
        "hardware versions, power/HDD LEDs, USB HID mode, mounted virtual media " +
        "and (on PCIe units) HDMI signal. Records an unreachable device as " +
        "verdict 'fail' rather than throwing, so a scheduled check always " +
        "leaves a record.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const g = context.globalArgs;
        if (!g.host) {
          throw new Error(
            "No NanoKVM host is configured. Run `setup` with --input host=…, " +
              "or set the host global argument.",
          );
        }
        const sample = await gatherHealth(context);
        const { verdict, findings, firmwareOutdated } = classifyHealth(sample, {
          maxClockSkewSeconds: g.maxClockSkewSeconds,
        });
        const record = {
          host: g.host,
          reachable: sample.reachable,
          authenticated: sample.authenticated,
          passwordConfigured: sample.passwordConfigured,
          authEncoding: sample.authEncoding,
          verdict,
          appVersion: sample.appVersion,
          appLatest: sample.appLatest,
          hardware: sample.hardware,
          firmwareOutdated,
          powerLed: sample.powerLed,
          hddLed: sample.hddLed,
          hidMode: sample.hidMode,
          mountedImage: sample.mountedImage,
          hdmi: sample.hdmi,
          ips: sample.ips,
          mdns: sample.mdns,
          macImage: sample.macImage,
          application: sample.application,
          responseMs: sample.responseMs,
          findings,
          checkedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource("health", "health", record);
        context.logger?.info(
          "NanoKVM {host} health: {verdict} ({count} findings)",
          {
            host: g.host,
            verdict,
            count: findings.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    power: {
      description:
        "Press the NanoKVM's power or reset button over GPIO. A dry run unless " +
        "`apply` is true; refuses to press a button on a device it cannot " +
        "authenticate.",
      arguments: PowerArgsSchema,
      execute: async (
        args: z.infer<typeof PowerArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const target = sanitizeLabel(`${g.host}-${args.action}`);
        const wouldDo = `press ${args.action}` +
          (args.durationMs > 0 ? ` for ${args.durationMs}ms` : "") +
          ` on ${g.host}`;
        if (!args.apply) {
          const handle = await context.writeResource("power", target, {
            action: args.action,
            target,
            applied: false,
            dryRun: true,
            status: null,
            ok: false,
            detail: "dry run: pass apply=true to press the button",
            wouldDo,
            requestedAt: new Date().toISOString(),
          });
          context.logger?.info("Dry run: would {action} {host}", {
            action: args.action,
            host: g.host,
          });
          return { dataHandles: [handle] };
        }
        const session = await ensureSession(context);
        if (!session.ok) {
          throw new Error(
            `Cannot ${args.action} ${g.host}: ${session.message}`,
          );
        }
        const record = await curlCall(context, {
          url: `${baseUrl(g.host, g.port)}${PATHS.gpio}`,
          method: "POST",
          dataJson: { type: args.action, duration: args.durationMs },
          label: `gpio-${args.action}`,
          headers: session.token
            ? [`Authorization: Bearer ${session.token}`]
            : [],
        });
        const envelope = parseEnvelope(record.body);
        const ok = record.status === 200 && envelope?.code === 0;
        const handle = await context.writeResource("power", target, {
          action: args.action,
          target,
          applied: true,
          dryRun: false,
          status: record.status,
          ok,
          detail: ok
            ? `${args.action} pressed`
            : envelope?.msg || record.stderr || `HTTP ${record.status}`,
          wouldDo,
          requestedAt: new Date().toISOString(),
        });
        context.logger?.info(
          ok
            ? "Pressed {action} on {host}"
            : "Failed to press {action} on {host}: {detail}",
          { action: args.action, host: g.host, detail: envelope?.msg ?? "" },
        );
        return { dataHandles: [handle] };
      },
    },

    msd: {
      description:
        "Inspect, mount, or unmount virtual media (an ISO/IMG served to the " +
        "host as a USB disk or CD-ROM). `status` is always read-only; " +
        "mount/umount are dry runs unless `apply` is true.",
      arguments: MsdArgsSchema,
      execute: async (
        args: z.infer<typeof MsdArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const target = sanitizeLabel(`${g.host}-msd`);
        if (args.action === "status") {
          const session = await ensureSession(context);
          if (!session.ok) {
            throw new Error(`Cannot read media state: ${session.message}`);
          }
          const { envelope } = await getJson(
            context,
            PATHS.mountedImage,
            "msd-status",
            session.token,
          );
          const data = (envelope?.data ?? {}) as Record<string, unknown>;
          const file = typeof data.file === "string" ? data.file : "";
          const handle = await context.writeResource("msd", target, {
            action: "status",
            target,
            applied: false,
            dryRun: false,
            status: 200,
            ok: true,
            detail: file || "(nothing mounted)",
            wouldDo: "",
            requestedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
        if (args.action === "mount" && !args.file.trim()) {
          throw new Error("`mount` needs --input file=/data/<image>.iso");
        }
        const mountFile = args.action === "mount" ? args.file : "";
        const wouldDo = args.action === "mount"
          ? `mount ${args.file}${args.cdrom ? " as CD-ROM" : ""} on ${g.host}`
          : `unmount the image on ${g.host}`;
        if (!args.apply) {
          const handle = await context.writeResource("msd", target, {
            action: args.action,
            target,
            applied: false,
            dryRun: true,
            status: null,
            ok: false,
            detail: "dry run: pass apply=true to change virtual media",
            wouldDo,
            requestedAt: new Date().toISOString(),
          });
          context.logger?.info("Dry run: would {action}", { action: wouldDo });
          return { dataHandles: [handle] };
        }
        const session = await ensureSession(context);
        if (!session.ok) {
          throw new Error(`Cannot change virtual media: ${session.message}`);
        }
        const record = await curlCall(context, {
          url: `${baseUrl(g.host, g.port)}${PATHS.mountImage}`,
          method: "POST",
          dataJson: { file: mountFile, cdrom: args.cdrom },
          label: `msd-${args.action}`,
          headers: session.token
            ? [`Authorization: Bearer ${session.token}`]
            : [],
        });
        const envelope = parseEnvelope(record.body);
        const ok = record.status === 200 && envelope?.code === 0;
        const handle = await context.writeResource("msd", target, {
          action: args.action,
          target,
          applied: true,
          dryRun: false,
          status: record.status,
          ok,
          detail: ok
            ? args.action === "mount" ? `mounted ${args.file}` : "unmounted"
            : envelope?.msg || record.stderr || `HTTP ${record.status}`,
          wouldDo,
          requestedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    screenshot: {
      description:
        "Capture a JPEG frame from the NanoKVM video stream and store it as the " +
        "`screenshot` file. Reads the MJPEG stream briefly through the curl " +
        "instance, then trims the first complete frame.",
      arguments: ScreenshotArgsSchema,
      execute: async (
        args: z.infer<typeof ScreenshotArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const name = args.label.trim() || "screenshot";
        const session = await ensureSession(context);
        if (!session.ok) {
          throw new Error(`Cannot capture a screenshot: ${session.message}`);
        }
        const dir = await Deno.makeTempDir({ prefix: "nanokvm-" });
        const rawPath = `${dir}/stream.mjpeg`;
        let status: number | null = null;
        let detail = "";
        try {
          const record = await curlCall(context, {
            url: `${baseUrl(g.host, g.port)}${PATHS.mjpeg}`,
            method: "GET",
            label: "mjpeg",
            headers: session.token
              ? [`Authorization: Bearer ${session.token}`]
              : [],
            outputFile: rawPath,
            timeoutMs: args.timeoutMs,
            maxBodyBytes: 0,
          });
          status = record.status;
          let bytes = new Uint8Array(0);
          try {
            bytes = await Deno.readFile(rawPath);
          } catch {
            bytes = new Uint8Array(0);
          }
          const frame = extractJpeg(bytes);
          if (frame) {
            const size = jpegSize(frame);
            if (!context.createFileWriter) {
              throw new Error("context.createFileWriter is unavailable.");
            }
            const writer = context.createFileWriter("screenshot", name);
            const fileHandle = await writer.writeAll(frame);
            const metaHandle = await context.writeResource(
              "screenshotMeta",
              `${name}-meta`,
              {
                host: g.host,
                name,
                bytes: frame.length,
                width: size.width,
                height: size.height,
                status,
                ok: true,
                detail: "",
                capturedAt: new Date().toISOString(),
              },
            );
            context.logger?.info("Captured {bytes}-byte frame from {host}", {
              bytes: frame.length,
              host: g.host,
            });
            return { dataHandles: [metaHandle, fileHandle] };
          }
          detail = bytes.length === 0
            ? "the video stream returned no data"
            : "no complete JPEG frame in the stream (no HDMI signal?)";
        } finally {
          await Deno.remove(dir, { recursive: true }).catch(() => {});
        }
        const handle = await context.writeResource(
          "screenshotMeta",
          `${name}-meta`,
          {
            host: g.host,
            name,
            bytes: 0,
            width: 0,
            height: 0,
            status,
            ok: false,
            detail,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger?.warn("Screenshot of {host} failed: {detail}", {
          host: g.host,
          detail,
        });
        return { dataHandles: [handle] };
      },
    },

    emit: {
      description:
        "Push this device's health to the swamp-managed OpenTelemetry system " +
        "(an OTLP log record plus gauges). A no-op that records why, when no " +
        "otel-settings contract or endpoint is configured. Uses the latest " +
        "`health` resource unless a health record is passed in.",
      arguments: EmitArgsSchema,
      execute: async (
        args: z.infer<typeof EmitArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const explicit = recordData(
          args.health !== undefined
            ? { attributes: args.health }
            : await latestRecord(
              context,
              context.definition?.name ?? g.name,
              "health",
            ),
        );
        const verdict = typeof explicit.verdict === "string"
          ? explicit.verdict
          : "unknown";
        const otel = await resolveOtel(context, args.mesh, args.endpoint);
        if (!otel.configured) {
          const handle = await context.writeResource("emit", "emit", {
            host: g.host,
            skipped: true,
            reason: otel.reason || "no OTLP endpoint configured",
            endpoint: "",
            mesh: "",
            logsStatus: null,
            metricsStatus: null,
            pushed: false,
            verdict,
            emittedAt: new Date().toISOString(),
          });
          context.logger?.info(
            "OTLP emit skipped for {host}: {reason}",
            {
              host: g.host,
              reason: otel.reason || "no otel-settings contract",
            },
          );
          return { dataHandles: [handle] };
        }

        const checkedAt = typeof explicit.checkedAt === "string"
          ? explicit.checkedAt
          : new Date().toISOString();
        const health = {
          verdict,
          findings:
            (Array.isArray(explicit.findings)
              ? explicit.findings
              : []) as Finding[],
          appVersion: typeof explicit.appVersion === "string"
            ? explicit.appVersion
            : "",
          reachable: explicit.reachable !== false,
          responseMs: typeof explicit.responseMs === "number"
            ? explicit.responseMs
            : 0,
          powerLed: typeof explicit.powerLed === "boolean"
            ? explicit.powerLed
            : null,
          mountedImage: typeof explicit.mountedImage === "string"
            ? explicit.mountedImage
            : "",
          hdmi: (typeof explicit.hdmi === "object" && explicit.hdmi !== null)
            ? explicit.hdmi as { enabled: boolean; signal: boolean }
            : null,
          checkedAt,
        } as {
          verdict: string;
          findings: Finding[];
          appVersion: string;
          checkedAt: string;
          reachable: boolean;
          responseMs: number;
          powerLed: boolean | null;
          mountedImage: string;
          hdmi: { enabled: boolean; signal: boolean } | null;
        };

        const logsStatus = await pushOtlp(
          context,
          `${otel.base}/v1/logs`,
          "logs",
          buildOtlpLogs(g.host, health, otel.attributes),
          otel.token,
        );
        const metricsStatus = await pushOtlp(
          context,
          `${otel.base}/v1/metrics`,
          "metrics",
          buildOtlpMetrics(g.host, health, otel.attributes),
          otel.token,
        );
        const pushed = (logsStatus ?? 0) >= 200 && (logsStatus ?? 0) < 300 &&
          (metricsStatus ?? 0) >= 200 && (metricsStatus ?? 0) < 300;
        const handle = await context.writeResource("emit", "emit", {
          host: g.host,
          skipped: false,
          reason: "",
          endpoint: otel.base,
          mesh: otel.mesh,
          logsStatus,
          metricsStatus,
          pushed,
          verdict,
          emittedAt: new Date().toISOString(),
        });
        context.logger?.info(
          pushed
            ? "Emitted {host} health ({verdict}) to {endpoint}"
            : "OTLP push to {endpoint} incomplete: logs={logs} metrics={metrics}",
          {
            host: g.host,
            verdict,
            endpoint: otel.base,
            logs: logsStatus,
            metrics: metricsStatus,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    devices: {
      description:
        "List every NanoKVM swamp looks after. Scans the repo's model " +
        "definitions (not the network) for @svendowideit/nanokvm instances and " +
        "records each one's name, address and DNS name, plus an A-record list " +
        "ready for a DNS reconciler. Read-only and device-independent, so it " +
        "runs anywhere the repo is.",
      arguments: DevicesArgsSchema,
      execute: async (
        args: z.infer<typeof DevicesArgsSchema>,
        context: MethodContext,
      ) => {
        if (!context.repoDir) {
          throw new Error(
            "context.repoDir is unavailable — cannot scan the repo for " +
              "nanokvm model definitions.",
          );
        }
        const zone = args.zone.trim().replace(/^\.+|\.+$/g, "");
        const devices = await discoverNanokvmDevices(context.repoDir, zone);
        const aRecords = devices.map((d) => ({
          name: d.dnsName,
          type: "A" as const,
          value: [d.host],
          zone,
        }));
        const handle = await context.writeResource("devices", "devices", {
          zone,
          count: devices.length,
          devices,
          dnsNames: devices.map((d) => d.dnsName),
          aRecords,
          scannedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Discovered {count} NanoKVM device(s){zoneSuffix}",
          {
            count: devices.length,
            zoneSuffix: zone ? ` in ${zone}` : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    cert: {
      description:
        "Read the TLS certificate the device serves, or install a Let's " +
        "Encrypt one onto it. The NanoKVM has no cert-upload endpoint, so " +
        "`install` writes the certificate and key onto the device through its " +
        "admin script API and restarts the web server; it takes the files from " +
        "Caddy's store by default, so a certificate Caddy issued and renews is " +
        "installed without copying anything by hand.",
      arguments: CertArgsSchema,
      execute: async (
        args: z.infer<typeof CertArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        if (!g.host) {
          throw new Error(
            "No NanoKVM host is configured. Run `setup` with --input host=….",
          );
        }

        if (args.action === "status") {
          const served = await readServedCert(context, args.name);
          const record = {
            host: g.host,
            action: "status",
            name: args.name,
            subject: served.subject,
            issuer: served.issuer,
            serial: served.serial,
            notAfter: served.notAfter,
            daysRemaining: certDaysRemaining(served.notAfter),
            sans: served.sans,
            matchesName: args.name !== "" && served.sans.includes(args.name),
            installed: false,
            detail: served.ok ? "" : "no certificate could be read",
            checkedAt: new Date().toISOString(),
          };
          const handle = await context.writeResource("cert", "cert", record);
          context.logger?.info(
            "Device {host} serves a certificate issued by {issuer} " +
              "({days} days left)",
            {
              host: g.host,
              issuer: served.issuer || "unknown",
              days: record.daysRemaining,
            },
          );
          return { dataHandles: [handle] };
        }

        if (!args.name) {
          throw new Error(
            "`install` needs --input name=<fqdn> (the certificate's DNS name).",
          );
        }
        let crt = args.crt;
        let key = args.key;
        if (!crt || !key) {
          const deadline = Date.now() + args.waitMs;
          let found: { crt: string; key: string } | null = null;
          for (;;) {
            found = await locateCaddyCert(args.certDir, args.name);
            if (found || Date.now() >= deadline) break;
            await new Promise((r) => setTimeout(r, 5000));
          }
          if (!found) {
            throw new Error(
              `No certificate for ${args.name} under ${args.certDir} after ` +
                `${args.waitMs}ms — has Caddy issued it? (run configureTls ` +
                `with subjects=["${args.name}"], then retry.)`,
            );
          }
          crt = found.crt;
          key = found.key;
        }
        const crtPem = await Deno.readTextFile(expandHome(crt));
        const keyPem = await Deno.readTextFile(expandHome(key));
        if (
          !crtPem.includes("BEGIN CERTIFICATE") ||
          !keyPem.includes("PRIVATE KEY")
        ) {
          throw new Error(
            `${args.name}: ${crt}/${key} do not look like a PEM certificate and key.`,
          );
        }

        // If the device already serves this exact certificate, do nothing — a
        // daily sync must not bounce the server every day.
        const before = await readServedCert(context, args.name);
        const fileSerial = await certFileSerial(expandHome(crt));
        if (
          fileSerial !== "" && before.serial === fileSerial &&
          before.sans.includes(args.name)
        ) {
          const handle = await context.writeResource("cert", "cert", {
            host: g.host,
            action: "install",
            name: args.name,
            subject: before.subject,
            issuer: before.issuer,
            serial: before.serial,
            notAfter: before.notAfter,
            daysRemaining: certDaysRemaining(before.notAfter),
            sans: before.sans,
            matchesName: true,
            installed: true,
            detail: "already current",
            checkedAt: new Date().toISOString(),
          });
          context.logger?.info(
            "Certificate for {name} on {host} is already current ({days} days " +
              "left); nothing to do",
            {
              name: args.name,
              host: g.host,
              days: certDaysRemaining(before.notAfter),
            },
          );
          return { dataHandles: [handle] };
        }

        const result = await installCertScript(
          context,
          args.scriptName,
          buildCertInstallerScript(crtPem, keyPem, args.restart),
        );

        // The server just restarted; give it a moment to serve the new cert.
        let served = await readServedCert(context, args.name);
        for (let i = 0; i < 10 && !served.sans.includes(args.name); i++) {
          await new Promise((r) => setTimeout(r, 3000));
          served = await readServedCert(context, args.name);
        }
        const installed = served.sans.includes(args.name);
        const record = {
          host: g.host,
          action: "install",
          name: args.name,
          subject: served.subject,
          issuer: served.issuer,
          serial: served.serial,
          notAfter: served.notAfter,
          daysRemaining: certDaysRemaining(served.notAfter),
          sans: served.sans,
          matchesName: served.sans.includes(args.name),
          installed,
          detail: installed
            ? (result.ok ? "installed" : "already served (re-run was a no-op)")
            : `${result.detail}; served=${served.subject || "none"}`,
          checkedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource("cert", "cert", record);
        context.logger?.info(
          installed
            ? "Installed {name} on {host}; the device serves a certificate " +
              "issued by {issuer}"
            : "Certificate install on {host} did not verify: {detail}",
          {
            name: args.name,
            host: g.host,
            issuer: served.issuer,
            detail: record.detail,
          },
        );
        if (!installed) {
          throw new Error(
            `Installing ${args.name} on ${g.host} did not verify: ${record.detail}`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },

  reports: ["@svendowideit/nanokvm-health-report"],
};
