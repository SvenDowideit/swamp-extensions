/**
 * @svendowideit/device-fingerprint — HTTP/TLS model.
 *
 * Identify devices on a network by their HTTP response and TLS certificate: the
 * `Server` header, the HTML `<title>`, and the certificate subject/issuer. This
 * catches things that answer HTTP(S) but not SSH or mDNS — routers, KVMs,
 * controllers, cameras, NAS. It is credential-free and read-only.
 *
 * Pure helpers (banner parsing, classification) are exported for unit testing;
 * the `fingerprint` method opens sockets and runs `openssl` for cert details.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  timeoutMs: z.number().int().positive().default(4000).describe(
    "Per-connection / per-request timeout in milliseconds",
  ),
  ports: z.array(z.number().int().min(1).max(65535)).default([443, 80])
    .describe(
      "Ports to try per host, in order (https first, then http)",
    ),
  userAgent: z.string().default("swamp-device-fingerprint/1.0").describe(
    "User-Agent sent with HTTP requests",
  ),
  deviceClasses: z.record(
    z.string(),
    z.object({ deviceClass: z.string(), vendor: z.string() }),
  ).default({}).describe(
    'Extend/override classification rules, e.g. {"myserver":"MikroTik"} matches Server header; keys are matched case-insensitively against the server banner',
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const FingerprintArgsSchema = z.object({
  hosts: z.array(z.string()).min(1).describe(
    "Hostnames or IPs to fingerprint (e.g. from the fleet inventory addresses)",
  ),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const FingerprintOutputSchema = z.object({
  deviceClass: z.string(),
  vendor: z.string(),
  server: z.string(),
  title: z.string(),
  certSubject: z.string(),
  certIssuer: z.string(),
  port: z.number(),
  url: z.string(),
  reachable: z.boolean(),
  detail: z.string(),
});

const FingerprintResultSchema = z.object({
  host: z.string(),
  fingerprints: z.array(FingerprintOutputSchema),
  deviceClass: z.string(),
  vendor: z.string(),
});

const FingerprintBatchSchema = z.object({
  hosts: z.array(FingerprintResultSchema),
  total: z.number(),
  identified: z.number(),
  fingerprintedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A single port's fingerprint for a host. */
export interface Fingerprint {
  /** Classified device class (e.g. `unifi`, `nanokvm`) or "". */
  deviceClass: string;
  /** Vendor when known, else "". */
  vendor: string;
  /** HTTP `Server` header value. */
  server: string;
  /** HTML `<title>`. */
  title: string;
  /** TLS cert subject (empty for plain HTTP). */
  certSubject: string;
  /** TLS cert issuer (empty for plain HTTP). */
  certIssuer: string;
  /** Port probed. */
  port: number;
  /** URL probed. */
  url: string;
  /** Whether the port answered at all. */
  reachable: boolean;
  /** Human-readable note (e.g. "no response"). */
  detail: string;
}

/** The fingerprint result for one host (first identifying port wins at the top). */
export interface HostFingerprint {
  /** Host name or IP. */
  host: string;
  /** Per-port fingerprints. */
  fingerprints: Fingerprint[];
  /** Best device class across the host's ports. */
  deviceClass: string;
  /** Best vendor across the host's ports. */
  vendor: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Extract the value of a header from a raw HTTP response head (case-insensitive). */
export function parseHeader(head: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  return (head.match(re)?.[1] ?? "").trim();
}

/** Extract the HTTP status code from a response head, or 0. */
export function parseStatus(head: string): number {
  const m = head.match(/^HTTP(?:\/\d\.\d)?\s+(\d{3})/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** Extract the first HTML `<title>` from a body (empty if none). */
export function extractTitle(body: string): string {
  return (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
}

/** Parse `openssl x509 -noout -subject -issuer` output into subject/issuer CNs. */
export function parseCert(output: string): { subject: string; issuer: string } {
  const line = (name: string) =>
    (output.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1] ?? "").trim();
  const subject = line("subject");
  const issuer = line("issuer");
  return { subject, issuer };
}

/**
 * Classify a device from its HTTP/TLS fingerprint. Generic, public rules only —
 * site-specific overrides come from the `deviceClasses` global arg (keys match
 * the Server banner, case-insensitively). Checks, in order: caller overrides,
 * TLS cert, Server header, HTML title.
 */
export function classifyHttp(
  fp: Pick<Fingerprint, "server" | "title" | "certSubject" | "certIssuer">,
  overrides: Record<string, { deviceClass: string; vendor: string }> = {},
): { deviceClass: string; vendor: string } {
  const server = (fp.server || "").toLowerCase();
  const title = (fp.title || "").toLowerCase();
  const cert = `${fp.certSubject} ${fp.certIssuer}`.toLowerCase();

  // 1. Caller overrides win (match the server banner).
  for (const [key, val] of Object.entries(overrides)) {
    if (server && server.includes(key.toLowerCase())) return val;
  }
  // 2. TLS certificate identity.
  if (cert.includes("unifi")) {
    return { deviceClass: "unifi", vendor: "Ubiquiti" };
  }
  if (cert.includes("glinet") || cert.includes("gl.inet")) {
    return { deviceClass: "glinet", vendor: "GL.iNet" };
  }
  // 3. HTTP Server banner.
  if (server.includes("one-two-three")) {
    return { deviceClass: "unifi", vendor: "Ubiquiti" };
  }
  if (server.includes("glinet") || server.includes("gl-")) {
    return { deviceClass: "glinet", vendor: "GL.iNet" };
  }
  if (server.includes("ship 2.0")) {
    // SHIP is a minimal embedded web server (OpenWrt-family).
    return { deviceClass: "openwrt", vendor: "" };
  }
  if (server.includes("caddy")) {
    return { deviceClass: "web-server", vendor: "" };
  }
  // 4. HTML title.
  if (title.includes("nanokvm") || title.includes("nano-kvm")) {
    return { deviceClass: "nanokvm", vendor: "Sipeed" };
  }
  if (title.includes("unifi os") || title.includes("unifi")) {
    return { deviceClass: "unifi", vendor: "Ubiquiti" };
  }
  if (title.includes("shelly")) {
    return { deviceClass: "shelly", vendor: "Shelly (Allterco)" };
  }
  if (
    title.includes("glinet") || title.includes("mudi") ||
    title.includes("slate")
  ) {
    return { deviceClass: "glinet", vendor: "GL.iNet" };
  }
  if (title.includes("openwrt") || title.includes("luci")) {
    return { deviceClass: "openwrt", vendor: "" };
  }
  if (/<title>\s*router\b/i.test(fp.title)) {
    return { deviceClass: "router", vendor: "" };
  }
  // Known-but-unclassified web server is still a useful signal.
  if (fp.server || fp.title) return { deviceClass: "http-device", vendor: "" };
  return { deviceClass: "", vendor: "" };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for the HTTP/TLS fingerprint model. */
export const model = {
  type: "@svendowideit/device-fingerprint/http",
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "openssl-available": {
      description: "Ensure openssl exists for TLS certificate inspection",
      labels: ["live"],
      appliesTo: ["fingerprint"],
      execute: async (): Promise<{ pass: boolean; errors?: string[] }> => {
        if (!(await hasCommand("openssl"))) {
          return {
            pass: false,
            errors: [
              "openssl not found on PATH (needed to read TLS certificate subject/issuer)",
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
        "Initial release: fingerprint hosts by HTTP Server header, HTML title, and TLS certificate subject/issuer; classify into a generic device class/vendor with caller overrides. Pairs with the mac model of the same extension and with @svendowideit/mdns classification.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    fingerprint: {
      description: "Per-host HTTP/TLS fingerprints and device classes",
      schema: FingerprintBatchSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    fingerprint: {
      description:
        "Probe hosts over HTTP(S) and classify them from Server/title/TLS certificate",
      arguments: FingerprintArgsSchema,
      execute: async (
        args: z.infer<typeof FingerprintArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const timestamp = new Date().toISOString();
        const results: HostFingerprint[] = [];
        for (const host of args.hosts) {
          results.push(await fingerprintHost(host, g));
        }
        const identified = results.filter((r) => r.deviceClass).length;
        const classes = [
          ...new Set(results.map((r) => r.deviceClass).filter(Boolean)),
        ];
        context.logger?.info(
          "Fingerprinted {total} host(s); {identified} identified{classes}",
          {
            total: results.length,
            identified,
            classes: classes.length ? ` [${classes.join(", ")}]` : "",
          },
        );
        const handle = await context.writeResource("fingerprint", "current", {
          hosts: results,
          total: results.length,
          identified,
          fingerprintedAt: timestamp,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Whether a command exists on PATH. */
async function hasCommand(cmd: string): Promise<boolean> {
  const path = Deno.env.get("PATH") ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try {
      const stat = await Deno.stat(`${dir}/${cmd}`);
      if (stat.isFile || stat.isSymlink) return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** Fingerprint one host across the configured ports. */
async function fingerprintHost(
  host: string,
  g: GlobalArgs,
): Promise<HostFingerprint> {
  const fingerprints: Fingerprint[] = [];
  for (const port of g.ports) {
    fingerprints.push(await fingerprintPort(host, port, g));
  }
  const best = fingerprints.find((f) => f.deviceClass) ?? fingerprints[0];
  return {
    host,
    fingerprints,
    deviceClass: best?.deviceClass ?? "",
    vendor: best?.vendor ?? "",
  };
}

/** Probe one host:port over HTTP(S) and classify it. */
async function fingerprintPort(
  host: string,
  port: number,
  g: GlobalArgs,
): Promise<Fingerprint> {
  const scheme = port === 443 || port === 8443 ? "https" : "http";
  const url = `${scheme}://${host}:${port}/`;
  const base: Fingerprint = {
    deviceClass: "",
    vendor: "",
    server: "",
    title: "",
    certSubject: "",
    certIssuer: "",
    port,
    url,
    reachable: false,
    detail: "no response",
  };

  // Reachability first, so an unreachable host is distinct from an open port
  // that speaks something other than HTTP.
  const open = await tcpOpen(host, port, g.timeoutMs);
  if (!open) return base;

  let head = "";
  let body = "";
  let certSubject = "";
  let certIssuer = "";

  if (scheme === "https") {
    // Fetch THROUGH openssl: appliances (KVMs, routers) commonly use self-signed
    // certs that Deno's fetch refuses, so a plain fetch would lose the banner and
    // title. openssl tolerates them and gives us the response in one connection.
    const got = await opensslGet(host, port, g.timeoutMs, g.userAgent);
    head = got.head;
    body = got.body;
    // The cert is fetched separately: `s_client -quiet` gives a clean HTTP
    // response but suppresses the certificate, and without -quiet the handshake
    // text is interleaved with the body. Two connections, each clean.
    if (got.head || got.body) {
      const cert = await opensslCert(host, port, g.timeoutMs);
      certSubject = cert.subject;
      certIssuer = cert.issuer;
    }
  } else {
    try {
      const resp = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(g.timeoutMs),
        headers: { "User-Agent": g.userAgent },
      });
      head = `HTTP ${resp.status}\n`;
      for (const [k, v] of resp.headers) head += `${k}: ${v}\n`;
      body = (await resp.text()).slice(0, 65536);
    } catch {
      // leave server/title empty; reachability is already known
    }
  }

  const server = parseHeader(head, "server");
  const title = extractTitle(body);
  const { deviceClass, vendor } = classifyHttp(
    { server, title, certSubject, certIssuer },
    g.deviceClasses,
  );
  return {
    ...base,
    reachable: true,
    server,
    title,
    certSubject,
    certIssuer,
    deviceClass,
    vendor,
    detail: server || title || certSubject ? "" : "open, no HTTP/TLS banner",
  };
}

/** TCP-connect test for a port. */
async function tcpOpen(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const conn = await Deno.connect({
      hostname: host,
      port,
      signal: AbortSignal.timeout(timeoutMs),
    });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch an HTTPS endpoint through `openssl s_client`: returns the peer
 * certificate's subject/issuer, the HTTP response head, and the body. This
 * tolerates self-signed certs (common on appliances), which plain fetch refuses.
 */
async function opensslGet(
  host: string,
  port: number,
  timeoutMs: number,
  userAgent: string,
): Promise<{
  subject: string;
  issuer: string;
  head: string;
  body: string;
}> {
  const empty = { subject: "", issuer: "", head: "", body: "" };
  const request =
    `GET / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: ${userAgent}\r\n` +
    `Connection: close\r\n\r\n`;
  let raw = "";
  try {
    const sc = new Deno.Command("openssl", {
      args: [
        "s_client",
        "-quiet",
        "-connect",
        `${host}:${port}`,
        "-servername",
        host,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = sc.spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, timeoutMs);
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(request));
    await writer.close();
    const out = await child.output();
    clearTimeout(timer);
    raw = new TextDecoder().decode(out.stdout);
  } catch {
    return empty;
  }

  // The peer certificate (first PEM block) is emitted before the HTTP response.
  let subject = "";
  let issuer = "";
  const pem = raw.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
  );
  if (pem) {
    const cert = await parseCertViaOpenssl(pem[0]);
    subject = cert.subject;
    issuer = cert.issuer;
  }

  // Split the response at the first HTTP status line.
  let head = "";
  let body = "";
  const idx = raw.indexOf("HTTP/");
  if (idx >= 0) {
    const respText = raw.slice(idx);
    const sep = respText.indexOf("\r\n\r\n");
    if (sep >= 0) {
      head = respText.slice(0, sep);
      body = respText.slice(sep + 4).slice(0, 65536);
    } else {
      head = respText.slice(0, 65536);
    }
  }
  return { subject, issuer, head, body };
}

/** Parse a PEM certificate's subject/issuer via `openssl x509`. */
async function parseCertViaOpenssl(
  pem: string,
): Promise<{ subject: string; issuer: string }> {
  try {
    const x = new Deno.Command("openssl", {
      args: ["x509", "-noout", "-subject", "-issuer"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const xc = x.spawn();
    const w = xc.stdin.getWriter();
    await w.write(new TextEncoder().encode(pem));
    await w.close();
    const xo = await xc.output();
    return parseCert(new TextDecoder().decode(xo.stdout));
  } catch {
    return { subject: "", issuer: "" };
  }
}

/** Fetch a peer certificate's subject/issuer via `openssl s_client`. */
async function opensslCert(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ subject: string; issuer: string }> {
  try {
    const sc = new Deno.Command("openssl", {
      args: ["s_client", "-connect", `${host}:${port}`, "-servername", host],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = sc.spawn();
    child.stdin.close();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, timeoutMs);
    const out = await child.output();
    clearTimeout(timer);
    const raw = new TextDecoder().decode(out.stdout);
    const pem = raw.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
    );
    if (!pem) return { subject: "", issuer: "" };
    return parseCertViaOpenssl(pem[0]);
  } catch {
    return { subject: "", issuer: "" };
  }
}
