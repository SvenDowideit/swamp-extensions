import { z } from "npm:zod@4";

/**
 * @svendowideit/esphome — identify and interrogate ESPHome devices on a LAN.
 *
 * Identity is the MAC address, never the IP: these devices take DHCP leases and
 * their hostnames/mDNS names may be changed by hand at any time, so neither an
 * address nor a name is stable enough to key an inventory on.
 *
 * Detection is deliberately multi-source because no single source sees every
 * device on a real network. Measured on the author's /20: mDNS saw 8, a TCP
 * sweep of 6053 saw 8, and they overlapped on only 6 — the union was 10.
 * Devices with `mdns:` removed are invisible to mDNS but still answer on 6053;
 * devices whose API is disabled never answer on 6053 but still serve HTTP.
 */

const TXT_KEYS = [
  "version",
  "mac",
  "platform",
  "board",
  "network",
  "config_hash",
  "api_encryption",
] as const;

const ACTUATOR_DOMAINS = new Set([
  "light",
  "switch",
  "fan",
  "cover",
  "climate",
  "lock",
  "valve",
  "siren",
  "media_player",
  "button",
  "select",
  "number",
  "text",
  "datetime",
  "time",
  "update",
  "alarm_control_panel",
  "water_heater",
]);

const EntitySchema = z.object({
  id: z.string(),
  domain: z.string().default("unknown"),
  name: z.string().default(""),
  entityCategory: z.number().int().default(0),
  uom: z.string().default(""),
  state: z.string().default(""),
  value: z.string().default(""),
  kind: z.enum(["sensor", "actuator", "diagnostic", "other"]).default(
    "other",
  ),
  capabilities: z.array(z.string()).default([]),
});

const DeviceSchema = z.object({
  mac: z.string().default(""),
  name: z.string().default(""),
  friendlyName: z.string().default(""),
  addresses: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  board: z.string().default(""),
  platform: z.string().default(""),
  esphomeVersion: z.string().default(""),
  configHash: z.string().default(""),
  network: z.string().default(""),
  apiEncryption: z.string().default(""),
  mdnsEnabled: z.boolean().default(false),
  apiPort: z.number().int().default(0),
  webServerPort: z.number().int().default(0),
  entities: z.array(EntitySchema).default([]),
  sensorCount: z.number().int().default(0),
  actuatorCount: z.number().int().default(0),
  interrogated: z.boolean().default(false),
  error: z.string().default(""),
});

const SummarySchema = z.object({
  generatedAt: z.string().default(""),
  pageTitle: z.string().default(""),
  pageHostname: z.string().default(""),
  scanned: z.number().int().default(0),
  devices: z.array(DeviceSchema).default([]),
  total: z.number().int().default(0),
  online: z.number().int().default(0),
  withWebServer: z.number().int().default(0),
  withoutMdns: z.number().int().default(0),
  versions: z.record(z.string(), z.number()).default({}),
  boards: z.record(z.string(), z.number()).default({}),
  issues: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

const CaddyServeSchema = z.object({
  hostname: z.string().default(""),
  root: z.string().default(""),
  serveModel: z.string().default(""),
  sourceModel: z.string().default(""),
  baseDomain: z.string().default(""),
  servedAt: z.string().default(""),
});

const GlobalArgsSchema = z.object({
  scanCidr: z.string().default("10.10.0.0/20").describe(
    "IPv4 CIDR to TCP-scan for ESPHome ports. Empty disables the sweep and relies on mDNS only.",
  ),
  apiPorts: z.array(z.number().int()).default([6053]).describe(
    "TCP ports that identify an ESPHome native API listener.",
  ),
  webPorts: z.array(z.number().int()).default([80]).describe(
    "TCP ports to try for the ESPHome web_server.",
  ),
  scanTimeoutMs: z.number().int().positive().default(400).describe(
    "Per-connection timeout for the sweep. WiFi devices need several hundred ms; too low a value under-reports the fleet.",
  ),
  scanConcurrency: z.number().int().positive().default(128).describe(
    "Parallel connections during the sweep.",
  ),
  mdnsPasses: z.number().int().positive().default(3).describe(
    "How many mDNS browse passes to union. A single pass is lossy: devices drop in and out between passes.",
  ),
  interrogateTimeoutMs: z.number().int().positive().default(3000).describe(
    "How long to read a device's web_server event stream.",
  ),
  outputDir: z.string().default("~/.local/share/esphome").describe(
    "Directory the HTML page is written under.",
  ),
  outputFile: z.string().default("").describe(
    "Explicit page path; empty uses <outputDir>/site/index.html.",
  ),
  pageTitle: z.string().default("ESPHome fleet"),
  pageHostname: z.string().default("esphome.x1yoga.fi.gy").describe(
    "Public hostname the page is served at.",
  ),
  caddyModelName: z.string().default("").describe(
    "Source @svendowideit/caddy model to read baseDomain/serviceName from. Empty auto-discovers the one that owns this machine.",
  ),
  caddyRouteHostname: z.string().default(""),
  caddyServeModel: z.string().default("esphome-caddy"),
});

const DiscoverArgsSchema = z.object({});
const InterrogateArgsSchema = z.object({
  macs: z.array(z.string()).default([]).describe(
    "Only interrogate these MACs. Empty interrogates every discovered device.",
  ),
  timeoutMs: z.number().int().positive().optional(),
});
const RenderArgsSchema = z.object({});
const CaddyServeArgsSchema = z.object({
  model: z.string().default(""),
  hostname: z.string().default(""),
  serveRoot: z.string().default(""),
  serveModel: z.string().default(""),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Device = z.infer<typeof DeviceSchema>;
type Entity = z.infer<typeof EntitySchema>;
type Summary = z.infer<typeof SummarySchema>;

export interface MethodContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    name: string,
    instance: string,
    content: unknown,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<unknown | null>;
}

// ---------------------------------------------------------------- helpers

export function expandHome(path: string, home?: string): string {
  if (!path.startsWith("~")) return path;
  const base = home ?? Deno.env.get("HOME") ?? "";
  return path.replace(/^~/, base);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      c === "&"
        ? "&amp;"
        : c === "<"
        ? "&lt;"
        : c === ">"
        ? "&gt;"
        : c === '"'
        ? "&quot;"
        : "&#39;",
  );
}

/** Normalise a MAC to lowercase colon form so it can key an inventory. */
export function normaliseMac(raw: string): string {
  const hex = (raw ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return "";
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Parse an ESPHome mDNS TXT payload.
 *
 * avahi hands back one flat string. `friendly_name` may itself contain spaces
 * ("Voice Living Room version=..."), so the known keys are matched by regex
 * instead of splitting on spaces, which would truncate the friendly name.
 */
export function parseEsphomeTxt(txt: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!txt) return out;

  // avahi -p emits each TXT entry separately quoted: "k=v" "k2=v2". A single
  // quoted blob, or none, means the entries were joined into one
  // space-separated string instead.
  const quoted = [...txt.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const flat = quoted.length === 1 ? quoted[0] : txt;

  if (quoted.length > 1) {
    for (const segment of quoted) {
      const eq = segment.indexOf("=");
      if (eq <= 0) continue;
      const key = segment.slice(0, eq).trim();
      const value = segment.slice(eq + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  }

  const friendly = flat.match(
    /friendly_name=(.*?)(?=\s+(?:version|mac|platform|board|network|config_hash|api_encryption)=|$)/,
  );
  if (friendly) out.friendly_name = friendly[1].trim();
  for (const key of TXT_KEYS) {
    const m = flat.match(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`));
    if (m) out[key] = m[1].trim();
  }
  return out;
}

/** Parse one `avahi-browse -p` resolved line (`=;iface;IPv4;...`). */
export function parseAvahiLine(line: string): {
  serviceName: string;
  serviceType: string;
  hostName: string;
  address: string;
  port: number;
  txt: string;
} | null {
  if (!line.startsWith("=")) return null;
  const parts = line.split(";");
  if (parts.length < 10) return null;
  const port = Number(parts[8]);
  // Keep the quotes: avahi -p emits each TXT entry separately quoted
  // ("k=v" "k2=v2"), and parseEsphomeTxt needs that structure.
  const txt = parts.slice(9).join(";").replace(/;$/, "");
  return {
    serviceName: parts[3],
    serviceType: parts[4],
    hostName: parts[6],
    address: parts[7],
    port: Number.isFinite(port) ? port : 0,
    txt,
  };
}

export function ipToInt(ip: string): number {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o))) {
    return -1;
  }
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) |
    octets[3]) >>> 0;
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((s) => (value >>> s) & 255).join(".");
}

/** Enumerate host addresses in a CIDR, capped so a typo cannot hang a run. */
export function expandCidr(cidr: string, maxHosts = 8192): string[] {
  const [base, bitsRaw] = cidr.trim().split("/");
  const bits = Number(bitsRaw);
  const start = ipToInt(base);
  if (start < 0 || !Number.isInteger(bits) || bits < 0 || bits > 32) return [];
  const size = 2 ** (32 - bits);
  if (bits >= 31) {
    return Array.from({ length: size }, (_, i) => intToIp(start + i));
  }
  const out: string[] = [];
  for (let i = 1; i < size - 1 && out.length < maxHosts; i++) {
    out.push(intToIp(start + i));
  }
  return out;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export async function runCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    // swamp-quality-ignore deno-command: fixed argv, never a shell string; avahi-browse and ip are documented dependencies, like openssl in @svendowideit/device-fingerprint.
    const proc = new Deno.Command(cmd, {
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

export async function portOpen(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Hold the connect promise so a connection that wins the race *after* the
  // timeout fired can still be closed; otherwise the socket leaks on every
  // timed-out probe, and a /20 sweep does thousands of them.
  const connecting = Deno.connect({ hostname: host, port });
  try {
    const conn = await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    try {
      conn.close();
    } catch {
      // already closed
    }
    return true;
  } catch {
    connecting.then((conn) => {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }).catch(() => undefined);
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read the neighbour table so a scanned address can be keyed by MAC. */
export async function readArpTable(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const res = await runCommand("ip", ["neigh", "show"]);
  if (res.code !== 0) return map;
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+.*lladdr\s+([0-9a-f:]{17})/i);
    if (!m) continue;
    const mac = normaliseMac(m[2]);
    if (mac) map.set(m[1], mac);
  }
  return map;
}

const ESPHOME_WEB_MARKERS = [
  /<esp-app[\s>]/i,
  /oi\.esphome\.io\/v\d+\/www\.js/i,
];

/**
 * True only when a web root is recognisably an ESPHome web_server.
 *
 * An open port 80 proves nothing: printers, NAS boxes and plain web servers all
 * answer there. ESPHome's web_server v2 serves a tiny shell that loads
 * oi.esphome.io/vN/www.js and contains an <esp-app> element, and that pair is
 * what identifies it.
 */
export function looksLikeEsphomeWebRoot(body: string): boolean {
  if (!body) return false;
  return ESPHOME_WEB_MARKERS.some((re) => re.test(body));
}

/**
 * True only when a 6053 greeting is ESPHome's plaintext hello frame.
 *
 * ESPHome sends a 0x00 indicator byte followed by a length-prefixed message
 * carrying the device name, so the frame starts with a NUL and contains
 * printable text. A TLS or HTTP listener will not look like this.
 */
export function looksLikeEsphomeApiHello(buf: Uint8Array): boolean {
  if (buf.length < 6) return false;
  if (buf[0] !== 0x00) return false;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const printable = text.replace(/[^\x20-\x7e]/g, "");
  return printable.length >= 3;
}

async function readApiHello(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  let conn: Deno.Conn | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    conn = await Promise.race([
      Deno.connect({ hostname: host, port }),
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(
          () => reject(new Error("connect timeout")),
          timeoutMs,
        );
      }),
    ]);
    const buf = new Uint8Array(256);
    const read = await Promise.race([
      conn.read(buf),
      new Promise<null>((resolve) => {
        readTimer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (read === null || read === undefined || read === 0) return null;
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    if (readTimer !== undefined) clearTimeout(readTimer);
    try {
      conn?.close();
    } catch {
      // already closed
    }
  }
}

async function fetchWebRoot(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/`, {
      signal: controller.signal,
    });
    if (!res.ok) return "";
    return (await res.text()).slice(0, 4096);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export interface Confirmation {
  confirmed: boolean;
  apiPort: number;
  webServerPort: number;
}

/**
 * Ask the device itself whether it is ESPHome.
 *
 * Open ports are not evidence. Only a recognised web_server root, or ESPHome's
 * plaintext API hello, confirms a swept host. Ports that did not answer with
 * ESPHome content are dropped, so a printer is never counted as a sensor.
 */
export async function confirmEsphome(
  host: string,
  apiPort: number,
  webPort: number,
  timeoutMs: number,
): Promise<Confirmation> {
  let confirmedApi = 0;
  let confirmedWeb = 0;
  if (apiPort > 0) {
    const hello = await readApiHello(host, apiPort, timeoutMs);
    if (hello && looksLikeEsphomeApiHello(hello)) confirmedApi = apiPort;
  }
  if (webPort > 0) {
    const body = await fetchWebRoot(host, webPort, timeoutMs);
    if (looksLikeEsphomeWebRoot(body)) confirmedWeb = webPort;
  }
  return {
    confirmed: confirmedApi > 0 || confirmedWeb > 0,
    apiPort: confirmedApi,
    webServerPort: confirmedWeb,
  };
}

const normName = (value: string): string => value.trim().toLowerCase();

/**
 * Key a device on its most stable identity it actually has.
 *
 * The previous form fell through to `name:` even when the name was empty, so
 * every nameless sweep-confirmed device shared one key and collapsed into a
 * single row.
 */
export function deviceKey(d: Device): string {
  if (d.mac) return d.mac;
  if (d.name) return `name:${normName(d.name)}`;
  if (d.addresses.length > 0) return `addr:${d.addresses[0]}`;
  return "addr:";
}

/**
 * Two records describe the same device when they agree on any stable identity.
 *
 * This is why duplicates appeared: `_esphomelib._tcp` publishes a MAC, while
 * `_http._tcp` for the same physical device publishes a name and no MAC, and
 * the two can differ in case. Keying on MAC alone gave one informative row plus
 * a default-valued twin.
 */
export function sameDevice(a: Device, b: Device): boolean {
  if (a.mac && b.mac && a.mac === b.mac) return true;
  if (a.addresses.some((addr) => b.addresses.includes(addr))) return true;
  if (a.name && b.name && normName(a.name) === normName(b.name)) return true;
  if (
    a.friendlyName && b.friendlyName &&
    normName(a.friendlyName) === normName(b.friendlyName)
  ) {
    return true;
  }
  return false;
}

export function mergeFields(cur: Device, next: Device): void {
  if (!cur.mac && next.mac) cur.mac = next.mac;
  if (!cur.friendlyName) cur.friendlyName = next.friendlyName;
  if (!cur.name) cur.name = next.name;
  if (!cur.board) cur.board = next.board;
  if (!cur.platform) cur.platform = next.platform;
  if (!cur.esphomeVersion) cur.esphomeVersion = next.esphomeVersion;
  if (!cur.configHash) cur.configHash = next.configHash;
  if (!cur.network) cur.network = next.network;
  if (!cur.apiEncryption) cur.apiEncryption = next.apiEncryption;
  if (next.apiPort) cur.apiPort = next.apiPort;
  if (next.webServerPort) cur.webServerPort = next.webServerPort;
  for (const a of next.addresses) {
    if (a && !cur.addresses.includes(a)) cur.addresses.push(a);
  }
  for (const s of next.sources) {
    if (!cur.sources.includes(s)) cur.sources.push(s);
  }
  if (!cur.interrogated && next.interrogated) {
    cur.entities = next.entities;
    cur.sensorCount = next.sensorCount;
    cur.actuatorCount = next.actuatorCount;
    cur.interrogated = true;
  }
}

export function mergeInto(target: Map<string, Device>, next: Device): void {
  const existing = target.get(deviceKey(next)) ??
    [...target.values()].find((cur) => sameDevice(cur, next));
  if (!existing) {
    target.set(deviceKey(next), next);
    return;
  }
  mergeFields(existing, next);
}

/**
 * Collapse duplicates created before two records could be linked.
 *
 * A MAC learned late, or a name arriving after the MAC, leaves a second entry
 * behind; this pass folds those together so the page never shows one device
 * twice.
 */
export function compactDevices(devices: Device[]): Device[] {
  const out: Device[] = [];
  for (const device of devices) {
    const match = out.find((cur) => sameDevice(cur, device));
    if (!match) {
      out.push({
        ...device,
        addresses: [...device.addresses],
        sources: [...device.sources],
      });
      continue;
    }
    mergeFields(match, device);
  }
  return out;
}

// ---------------------------------------------------------------- discovery

export async function browseMdns(
  serviceType: string,
  passes: number,
): Promise<Array<NonNullable<ReturnType<typeof parseAvahiLine>>>> {
  const seen = new Map<
    string,
    NonNullable<ReturnType<typeof parseAvahiLine>>
  >();
  for (let pass = 0; pass < passes; pass++) {
    const res = await runCommand("avahi-browse", ["-prt", serviceType]);
    for (const line of res.stdout.split("\n")) {
      const rec = parseAvahiLine(line);
      if (!rec) continue;
      const key = `${rec.serviceName}|${rec.address}|${rec.port}`;
      if (!seen.has(key)) seen.set(key, rec);
    }
    if (pass < passes - 1) await new Promise((r) => setTimeout(r, 400));
  }
  return [...seen.values()];
}

export async function sweepPorts(
  cidr: string,
  ports: number[],
  timeoutMs: number,
  concurrency: number,
): Promise<{ scanned: number; open: Map<string, number[]> }> {
  const hosts = expandCidr(cidr);
  const open = new Map<string, number[]>();
  await mapWithConcurrency(hosts, concurrency, async (host) => {
    const found: number[] = [];
    for (const port of ports) {
      if (await portOpen(host, port, timeoutMs)) found.push(port);
    }
    if (found.length > 0) open.set(host, found);
    return null;
  });
  return { scanned: hosts.length, open };
}

// ------------------------------------------------------------ interrogation

/**
 * Apply parsed SSE blocks to a device's entity map.
 *
 * ESPHome sends the full entity record on the first `state` event for an id and
 * only deltas afterwards, so catalog fields are written once and later events
 * merely refresh value/state. Overwriting per event would erase the catalog and
 * leave only the newest value.
 */
export function applySseEvents(
  state: { title: string; entities: Map<string, Entity> },
  payloads: Array<{ event: string; data: string }>,
): void {
  for (const { event, data } of payloads) {
    if (!data) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === "ping") {
      if (typeof parsed.title === "string" && parsed.title) {
        state.title = parsed.title;
      }
      continue;
    }
    if (event !== "state") continue;
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!id) continue;
    const existing = state.entities.get(id);
    const domain = typeof parsed.domain === "string" ? parsed.domain : "";
    if (!existing) {
      const capabilities: string[] = [];
      if (Array.isArray(parsed.effects)) {
        capabilities.push(
          ...(parsed.effects.filter((e) => typeof e === "string") as string[]),
        );
      }
      if (typeof parsed.color_mode === "string") {
        capabilities.push(`color_mode:${parsed.color_mode}`);
      }
      const entityCategory = typeof parsed.entity_category === "number"
        ? parsed.entity_category
        : 0;
      state.entities.set(id, {
        id,
        domain: domain || "unknown",
        name: typeof parsed.name === "string" ? parsed.name : id,
        entityCategory,
        uom: typeof parsed.uom === "string" ? parsed.uom : "",
        state: typeof parsed.state === "string" ? parsed.state : "",
        value: parsed.value === undefined || parsed.value === null
          ? ""
          : String(parsed.value),
        kind: entityCategory >= 1
          ? "diagnostic"
          : ACTUATOR_DOMAINS.has(domain || "")
          ? "actuator"
          : (domain === "sensor" || domain === "binary_sensor")
          ? "sensor"
          : "other",
        capabilities,
      });
      continue;
    }
    if (typeof parsed.state === "string") existing.state = parsed.state;
    if (parsed.value !== undefined && parsed.value !== null) {
      existing.value = String(parsed.value);
    }
  }
}

export async function interrogateDevice(
  device: Device,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const address = device.addresses[0];
  if (!address || !port) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const state = { title: "", entities: new Map<string, Entity>() };
  try {
    const res = await fetch(`http://${address}:${port}/events`, {
      signal: controller.signal,
    });
    if (!res.body) throw new Error(`no body (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      applySseEvents(
        state,
        blocks.map((block) => {
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          return { event, data };
        }),
      );
    }
    await reader.cancel().catch(() => undefined);
  } catch (err) {
    if (!state.entities.size) {
      device.error = err instanceof Error ? err.message : String(err);
      return;
    }
  } finally {
    clearTimeout(timer);
  }
  if (state.title && !device.friendlyName) device.friendlyName = state.title;
  device.entities = [...state.entities.values()].sort((a, b) =>
    a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name)
  );
  device.sensorCount =
    device.entities.filter((e) => e.kind === "sensor").length;
  device.actuatorCount =
    device.entities.filter((e) => e.kind === "actuator").length;
  device.interrogated = device.entities.length > 0;
}

// ------------------------------------------------------------- orchestration

export function label(d: Device): string {
  return d.friendlyName || d.name || d.mac || d.addresses[0] ||
    "unknown device";
}

export function summarise(
  g: GlobalArgs,
  devices: Device[],
  scanned: number,
  errors: string[],
): Summary {
  const versions: Record<string, number> = {};
  const boards: Record<string, number> = {};
  const issues: string[] = [];
  for (const d of devices) {
    const v = d.esphomeVersion || "unknown";
    versions[v] = (versions[v] ?? 0) + 1;
    const b = d.board || "unknown";
    boards[b] = (boards[b] ?? 0) + 1;
    if (!d.mdnsEnabled) {
      issues.push(
        `${
          label(d)
        } advertises no mDNS service — invisible to name-based discovery, only found by a port sweep.`,
      );
    }
    if (!d.board) {
      issues.push(
        `${
          label(d)
        } reports no board — its mdns component is off, so the compile target is unknowable without the native API handshake.`,
      );
    }
    if (!d.webServerPort) {
      issues.push(`${label(d)} has no web_server — entities cannot be read.`);
    }
    if (d.apiPort && !d.apiEncryption) {
      issues.push(
        `${label(d)} exposes an unencrypted native API on :${d.apiPort}.`,
      );
    }
    if (d.webServerPort && !d.interrogated) {
      issues.push(
        `${label(d)} answered on :${d.webServerPort} but exposed no entities (${
          d.error || "empty stream"
        }).`,
      );
    }
  }
  return SummarySchema.parse({
    generatedAt: new Date().toISOString(),
    pageTitle: g.pageTitle,
    pageHostname: g.pageHostname,
    scanned,
    devices,
    total: devices.length,
    online: devices.filter((d) => d.apiPort || d.webServerPort).length,
    withWebServer: devices.filter((d) => d.webServerPort).length,
    withoutMdns: devices.filter((d) => !d.mdnsEnabled).length,
    versions,
    boards,
    issues,
    errors,
  });
}

export function deriveOutputFile(g: GlobalArgs): string {
  if (g.outputFile) return expandHome(g.outputFile);
  return `${expandHome(g.outputDir)}/site/index.html`;
}

export function deriveSummaryFile(g: GlobalArgs): string {
  return `${expandHome(g.outputDir)}/summary.json`;
}

export async function writeSummaryFile(
  g: GlobalArgs,
  summary: Summary,
): Promise<string> {
  const file = deriveSummaryFile(g);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(file, JSON.stringify(summary, null, 2) + "\n");
  return file;
}

/**
 * Read the stored summary.
 *
 * The swamp resource is the source of truth, but reading it back through the
 * method context has proved unreliable, so the same summary is also written
 * beside the page and used as a fallback. Without that copy `render` fails even
 * though a summary exists.
 */
export async function readStoredSummary(
  g: GlobalArgs,
  context: MethodContext,
): Promise<Summary | null> {
  if (context.readResource) {
    try {
      const raw = await context.readResource("summary");
      if (raw) {
        const anyRaw = raw as Record<string, unknown>;
        const parsed = SummarySchema.safeParse(anyRaw.content ?? anyRaw);
        if (parsed.success) return parsed.data;
      }
    } catch {
      // fall through to the on-disk copy
    }
  }
  try {
    const text = await Deno.readTextFile(deriveSummaryFile(g));
    const parsed = SummarySchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // nothing stored yet
  }
  return null;
}

export async function readExistingDevices(
  context: MethodContext,
): Promise<Device[]> {
  if (!context.readResource) return [];
  try {
    const raw = await context.readResource("summary");
    if (!raw) return [];
    const anyRaw = raw as Record<string, unknown>;
    const parsed = SummarySchema.safeParse(anyRaw.content ?? anyRaw);
    return parsed.success ? parsed.data.devices : [];
  } catch {
    return [];
  }
}

export async function buildInventory(
  g: GlobalArgs,
  existing: Device[],
): Promise<Summary> {
  const errors: string[] = [];
  const devices = new Map<string, Device>();

  // 1. mDNS: the richest signal (version/board/platform) when it is enabled.
  for (const serviceType of ["_esphomelib._tcp", "_http._tcp"]) {
    let records: Array<NonNullable<ReturnType<typeof parseAvahiLine>>> = [];
    try {
      records = await browseMdns(serviceType, g.mdnsPasses);
    } catch (err) {
      errors.push(`mDNS ${serviceType}: ${String(err)}`);
      continue;
    }
    for (const rec of records) {
      if (!rec) continue;
      const txt = parseEsphomeTxt(rec.txt);
      const isApi = serviceType === "_esphomelib._tcp";
      if (!isApi && !txt.board && !txt.platform) {
        // An _http._tcp advertisement carrying no ESPHome TXT keys is some
        // other web server (printer, NAS). Only ESPHome keys make it ours, or
        // a name mDNS already told us about.
        const known = [...devices.values()].some((d) =>
          d.name && d.name === rec.serviceName
        );
        if (!known) continue;
      }
      mergeInto(
        devices,
        DeviceSchema.parse({
          mac: normaliseMac(txt.mac ?? ""),
          name: rec.serviceName,
          friendlyName: txt.friendly_name ?? "",
          addresses: [rec.address].filter(Boolean),
          sources: [isApi ? "mdns-api" : "mdns-http"],
          board: txt.board ?? "",
          platform: txt.platform ?? "",
          esphomeVersion: txt.version ?? "",
          configHash: txt.config_hash ?? "",
          network: txt.network ?? "",
          apiEncryption: txt.api_encryption ?? "",
          mdnsEnabled: true,
          apiPort: isApi ? rec.port : 0,
          webServerPort: isApi ? 0 : rec.port,
        }),
      );
    }
  }

  // 2. TCP sweep: finds devices whose mdns component is disabled, and
  //    web-only builds whose api is disabled. Neither shows up in step 1.
  let scanned = 0;
  if (g.scanCidr.trim()) {
    try {
      const ports = [...new Set([...g.apiPorts, ...g.webPorts])];
      const sweep = await sweepPorts(
        g.scanCidr,
        ports,
        g.scanTimeoutMs,
        g.scanConcurrency,
      );
      scanned = sweep.scanned;
      const arp = await readArpTable();
      for (const [address, openPorts] of sweep.open) {
        const apiPort = openPorts.find((p) => g.apiPorts.includes(p)) ?? 0;
        const webPort = openPorts.find((p) => g.webPorts.includes(p)) ?? 0;
        const byAddress = [...devices.values()].find((d) =>
          d.addresses.includes(address)
        );
        if (byAddress) {
          if (apiPort && !byAddress.apiPort) byAddress.apiPort = apiPort;
          if (webPort && !byAddress.webServerPort) {
            byAddress.webServerPort = webPort;
          }
          if (!byAddress.sources.includes("scan")) {
            byAddress.sources.push("scan");
          }
          continue;
        }
        // An open port is not evidence: confirm the device actually answers
        // with ESPHome content before it joins the inventory.
        const confirmation = await confirmEsphome(
          address,
          apiPort,
          webPort,
          Math.max(g.scanTimeoutMs * 4, 1000),
        );
        if (!confirmation.confirmed) continue;
        mergeInto(
          devices,
          DeviceSchema.parse({
            mac: arp.get(address) ?? "",
            addresses: [address],
            sources: ["scan-confirmed"],
            mdnsEnabled: false,
            apiPort: confirmation.apiPort,
            webServerPort: confirmation.webServerPort,
          }),
        );
      }
    } catch (err) {
      errors.push(`scan ${g.scanCidr}: ${String(err)}`);
    }
  }

  // 3. Carry forward the last good interrogation so a device that is briefly
  //    offline does not lose its entity catalogue between hourly runs.
  for (const previous of existing) {
    const cur = devices.get(deviceKey(previous));
    if (cur && !cur.interrogated && previous.interrogated) {
      cur.entities = previous.entities;
      cur.sensorCount = previous.sensorCount;
      cur.actuatorCount = previous.actuatorCount;
      cur.interrogated = true;
    }
  }

  const list = compactDevices([...devices.values()]).sort((a, b) =>
    label(a).localeCompare(label(b))
  );
  return summarise(g, list, scanned, errors);
}

// ------------------------------------------------------------------- render

export function renderTime(iso: string): string {
  if (!iso) return "never";
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`;
}

export function buildHtml(summary: Summary, pageUrl = ""): string {
  const deviceCards = summary.devices.map((d) => {
    const entities = d.entities.length
      ? `<table><thead><tr><th>Entity</th><th>Domain</th><th>State</th><th>Unit</th></tr></thead><tbody>${
        d.entities.map((e) =>
          `<tr><td>${escapeHtml(e.name || e.id)}</td><td>${
            escapeHtml(e.domain)
          } (${escapeHtml(e.kind)})</td><td>${
            escapeHtml(e.state || e.value)
          }</td><td>${escapeHtml(e.uom)}</td></tr>`
        ).join("")
      }</tbody></table>`
      : `<p class="muted">${
        d.webServerPort
          ? `No entities were returned from :${d.webServerPort}.`
          : "No web_server, so entities cannot be read."
      }</p>`;
    const facts = [
      d.esphomeVersion ? `v${d.esphomeVersion}` : "version unknown",
      d.platform || "platform unknown",
      d.board || "board unknown",
      d.mac || "MAC unknown",
    ].join(" · ");
    return `<details class="device">
  <summary>
    <strong>${escapeHtml(label(d))}</strong>
    <span class="muted">${escapeHtml(facts)}</span>
    <span class="muted">${escapeHtml(d.addresses.join(", "))}</span>
    ${
      d.mdnsEnabled
        ? `<span class="pill ok">mDNS</span>`
        : `<span class="pill warn">no mDNS</span>`
    }
    ${
      d.webServerPort
        ? `<span class="pill ok">web :${d.webServerPort}</span>`
        : `<span class="pill warn">no web</span>`
    }
    ${d.apiPort ? `<span class="pill ok">api :${d.apiPort}</span>` : ""}
    ${
      d.webServerPort
        ? `<span class="nums">${d.sensorCount} sensors · ${d.actuatorCount} actuators</span>`
        : ""
    }
  </summary>
  <div class="facts">sources: ${escapeHtml(d.sources.join(", "))}${
      d.configHash ? ` · config_hash ${escapeHtml(d.configHash)}` : ""
    }</div>
  ${entities}
</details>`;
  }).join("");

  const deviceRows = summary.devices.map((d) =>
    `<tr>
      <td><strong>${escapeHtml(label(d))}</strong></td>
      <td>${escapeHtml(d.esphomeVersion || "unknown")}</td>
      <td>${d.board ? `<code>${escapeHtml(d.board)}</code>` : "—"}</td>
      <td>${escapeHtml(d.platform || "—")}</td>
      <td>${d.mac ? `<code>${escapeHtml(d.mac)}</code>` : "—"}</td>
      <td>${
      d.configHash ? `<code>${escapeHtml(d.configHash)}</code>` : "—"
    }</td>
      <td>${d.apiEncryption ? "encrypted" : (d.apiPort ? "none" : "—")}</td>
      <td class="nums">${
      d.webServerPort ? `${d.sensorCount} / ${d.actuatorCount}` : "—"
    }</td>
    </tr>`
  ).join("");

  const versionRows = Object.entries(summary.versions)
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => `<tr><td>${escapeHtml(v)}</td><td>${n}</td></tr>`)
    .join("");
  const boardRows = Object.entries(summary.boards)
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => `<tr><td>${escapeHtml(b)}</td><td>${n}</td></tr>`)
    .join("");
  const issueList = summary.issues.length
    ? `<ul>${
      summary.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")
    }</ul>`
    : `<p class="muted">Nothing to flag.</p>`;
  const errorList = summary.errors.length
    ? `<div class="errors"><strong>Collector errors</strong><ul>${
      summary.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")
    }</ul></div>`
    : "";
  const pageLink = pageUrl
    ? `<a href="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3600">
<title>${escapeHtml(summary.pageTitle)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--panel:#fff;--text:#16181d;--muted:#666b76;--line:#e3e5ea;--good:#16794b;--warn:#a65a00;--bad:#b42318;--chip:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--panel:#1a1d23;--text:#eef0f4;--muted:#9aa1ae;--line:#2b303a;--good:#5bd39a;--warn:#ffc46b;--bad:#ff8a80;--chip:#252a33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 18px 60px}h1{font-size:1.55rem;margin:0}h2{font-size:1.12rem;margin:26px 0 10px}
.muted{color:var(--muted)}a{color:var(--info)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.card .num{font-size:1.55rem;font-weight:700;line-height:1.2}.card .label{color:var(--muted);font-size:.85rem}
section.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px}
details.device{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--panel)}
details.device summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;list-style:none}
details.device summary::-webkit-details-marker{display:none}
.pill{border-radius:999px;padding:2px 8px;font-size:.78rem;background:var(--chip)}.pill.ok{color:var(--good)}.pill.warn{color:var(--warn)}
.nums{font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:.88rem;margin:10px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86em;background:var(--chip);padding:1px 5px;border-radius:5px}
.facts{margin:8px 0;font-size:.86rem;color:var(--muted)}
.errors{border:1px solid var(--bad);border-radius:10px;padding:10px 12px;margin-top:14px}
footer{margin-top:26px;color:var(--muted);font-size:.82rem}
</style>
</head>
<body><main>
<header><div><h1>${escapeHtml(summary.pageTitle)}</h1>
<div class="muted">generated ${renderTime(summary.generatedAt)} · ${
    escapeHtml(summary.pageHostname || "local")
  }</div></div></header>
<div class="grid">
  <div class="card"><div class="num">${summary.total}</div><div class="label">devices</div></div>
  <div class="card"><div class="num">${summary.online}</div><div class="label">online</div></div>
  <div class="card"><div class="num">${summary.withWebServer}</div><div class="label">with web_server</div></div>
  <div class="card"><div class="num">${summary.withoutMdns}</div><div class="label">invisible to mDNS</div></div>
  <div class="card"><div class="num">${summary.scanned}</div><div class="label">addresses swept</div></div>
</div>
<section class="panel"><h2>Summary</h2>
<table><thead><tr><th>Device</th><th>Version</th><th>Board</th><th>Chip</th><th>MAC</th><th>Config hash</th><th>API crypto</th><th>Sensors / Actuators</th></tr></thead><tbody>${
    deviceRows ||
    `<tr><td colspan="8" class="muted">No ESPHome devices found.</td></tr>`
  }</tbody></table>
</section>
<section class="panel"><h2>What to work on</h2>${issueList}</section>
<section class="panel"><h2>Devices</h2>${
    deviceCards || `<p class="muted">No ESPHome devices found.</p>`
  }</section>
<section class="panel"><h2>Firmware versions</h2><table><thead><tr><th>Version</th><th>Devices</th></tr></thead><tbody>${
    versionRows || `<tr><td colspan="2" class="muted">none</td></tr>`
  }</tbody></table>
<h2>Boards</h2><table><thead><tr><th>Board</th><th>Devices</th></tr></thead><tbody>${
    boardRows || `<tr><td colspan="2" class="muted">none</td></tr>`
  }</tbody></table></section>
${errorList}
<footer><div>Refreshed hourly while <code>swamp serve</code> is running. Identity is the MAC address, so DHCP moves and renames do not create duplicate entries.</div>${
    pageLink ? `<div>${pageLink}</div>` : ""
  }</footer>
</main></body></html>`;
}

export async function writePage(
  g: GlobalArgs,
  summary: Summary,
): Promise<string> {
  const file = deriveOutputFile(g);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  await Deno.mkdir(dir, { recursive: true });
  const pageUrl = g.pageHostname ? `https://${g.pageHostname}` : "";
  await Deno.writeTextFile(file, buildHtml(summary, pageUrl));
  return file;
}

// -------------------------------------------------------------- caddy serve

export interface CaddyModelFacts {
  modelName: string;
  baseDomain: string;
  hostFqdn: string;
  serviceName: string;
  target: string;
}

export function parseCaddyModelFacts(
  modelName: string,
  raw: { globalArguments?: Record<string, unknown> },
  hostname = "",
): CaddyModelFacts {
  const g = (raw.globalArguments ?? {}) as Record<string, unknown>;
  const baseDomain = typeof g.baseDomain === "string" ? g.baseDomain : "";
  const serviceName = typeof g.serviceName === "string" && g.serviceName
    ? g.serviceName
    : "caddy";
  const target = typeof g.target === "string" ? g.target : "";
  const records = Array.isArray(g.dnsRecords)
    ? (g.dnsRecords as Array<Record<string, unknown>>)
    : [];
  const base = baseDomain.toLowerCase().replace(/^\.+/, "");
  const shortHost = hostname.split(".")[0].toLowerCase();
  const candidates: string[] = [];
  for (const r of records) {
    if (typeof r.name !== "string" || typeof r.type !== "string") continue;
    const type = r.type.toUpperCase();
    if (type !== "A" && type !== "AAAA") continue;
    const name = r.name.toLowerCase().replace(/^\.+/, "");
    if (base && name !== base && !name.endsWith(`.${base}`)) continue;
    const value = Array.isArray(r.value) ? r.value : [];
    if (!value.some((v) => typeof v === "string" && !!v)) continue;
    candidates.push(name);
  }
  const named = candidates.find(
    (n) => shortHost && n.split(".")[0] === shortHost,
  );
  const deepest = candidates.slice().sort(
    (a, b) => b.split(".").length - a.split(".").length,
  )[0];
  const hostFqdn = named ?? deepest ?? baseDomain;
  return { modelName, baseDomain, hostFqdn, serviceName, target };
}

export function caddyModelNames(listJson: string): string[] {
  try {
    const parsed = JSON.parse(listJson) as {
      results?: Array<{ name?: unknown; type?: unknown }>;
    };
    return (parsed.results ?? [])
      .filter((r) =>
        r.type === "@svendowideit/caddy" && typeof r.name === "string"
      )
      .map((r) => r.name as string);
  } catch {
    return [];
  }
}

export function pickSourceCaddy(
  facts: CaddyModelFacts[],
  hostname: string,
): CaddyModelFacts | null {
  const shortHost = hostname.split(".")[0].toLowerCase();
  const matches = facts.filter(
    (f) => shortHost && f.hostFqdn.split(".")[0] === shortHost,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  const withDomain = facts.filter((f) => f.baseDomain);
  return withDomain.length === 1 ? withDomain[0] : null;
}

export function machineHostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return Deno.env.get("HOSTNAME") ?? "";
  }
}

export async function runSwampCmd(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    // swamp-quality-ignore deno-command: optional caddy peer discovered at runtime; args are fixed literals plus typed model names/hostnames, never a shell string.
    const proc = new Deno.Command("swamp", {
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

// --------------------------------------------------------------------- model

export const model = {
  type: "@svendowideit/esphome",
  version: "2026.11.28.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.28.1",
      description:
        "Initial release: multi-source ESPHome discovery (mDNS TXT with repeated " +
        "union passes, a TCP sweep of the native API and web_server ports, and " +
        "the ARP table), keyed on the MAC address so DHCP moves and renames do " +
        "not fork a device's history; web_server /events interrogation for the " +
        "sensor and actuator catalogue; an hourly HTML page served through " +
        "@svendowideit/caddy.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    summary: {
      description: "Every discovered ESPHome device, keyed by MAC",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    device: {
      description: "One ESPHome device with its entity catalogue",
      schema: DeviceSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    caddyServe: {
      description: "The Caddy file_server route that serves the page",
      schema: CaddyServeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Find ESPHome devices from every available source: repeated mDNS " +
        "browse passes unioned together, a TCP sweep of the API and web_server " +
        "ports, and the ARP table for MAC identity. Merges by MAC.",
      arguments: DiscoverArgsSchema,
      execute: async (
        _args: z.infer<typeof DiscoverArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        context.logger?.info("Discovering ESPHome devices");
        const previous = await readExistingDevices(context);
        const summary = await buildInventory(g, previous);
        const handle = await context.writeResource(
          "summary",
          "current",
          summary,
        );
        context.logger?.info(
          "Discovered {n} ESPHome device(s): {mdns} via mDNS, {nmdns} invisible to mDNS",
          {
            n: summary.total,
            mdns: summary.total - summary.withoutMdns,
            nmdns: summary.withoutMdns,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    interrogate: {
      description:
        "Read each device's web_server /events stream to capture its sensor and " +
        "actuator catalogue. Devices without a web_server keep their facts only.",
      arguments: InterrogateArgsSchema,
      execute: async (
        args: z.infer<typeof InterrogateArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        const timeoutMs = args.timeoutMs ?? g.interrogateTimeoutMs;
        const current = await readStoredSummary(g, context);
        if (!current) {
          throw new Error(
            "No discovery summary yet — run the discover method first.",
          );
        }
        const wanted = new Set(args.macs.map((m) => normaliseMac(m)));
        const targets = current.devices.filter((d) =>
          d.webServerPort > 0 &&
          (wanted.size === 0 || wanted.has(d.mac))
        );
        context.logger?.info(
          "Interrogating {n} device(s) with a web_server",
          { n: targets.length },
        );
        await mapWithConcurrency(targets, 8, async (device) => {
          await interrogateDevice(device, device.webServerPort, timeoutMs);
          return null;
        });
        const summary = summarise(
          g,
          current.devices,
          current.scanned,
          current.errors,
        );
        const handle = await context.writeResource(
          "summary",
          "current",
          summary,
        );
        context.logger?.info("Interrogated {n} device(s)", {
          n: targets.filter((d) => d.interrogated).length,
        });
        return { dataHandles: [handle] };
      },
    },

    render: {
      description: "Render the HTML page from the stored summary.",
      arguments: RenderArgsSchema,
      execute: async (
        _args: z.infer<typeof RenderArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        const summary = await readStoredSummary(g, context);
        if (!summary) {
          throw new Error(
            "No discovery summary yet — run the discover method first.",
          );
        }
        const file = await writePage(g, summary);
        context.logger?.info("Rendered {file}", { file });
        return { dataHandles: [{ name: file }] };
      },
    },

    sync: {
      description:
        "The whole pipeline in one model-lock run: discover, interrogate every " +
        "reachable device, then render the page. Prefer this over calling the " +
        "methods separately, which contend on the model lock.",
      arguments: DiscoverArgsSchema,
      execute: async (
        _args: z.infer<typeof DiscoverArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        const previous = await readExistingDevices(context);
        context.logger?.info("Syncing the ESPHome fleet");
        let summary = await buildInventory(g, previous);
        const targets = summary.devices.filter((d) => d.webServerPort > 0);
        await mapWithConcurrency(targets, 8, async (device) => {
          await interrogateDevice(
            device,
            device.webServerPort,
            g.interrogateTimeoutMs,
          );
          return null;
        });
        summary = summarise(
          g,
          summary.devices,
          summary.scanned,
          summary.errors,
        );
        const handle = await context.writeResource(
          "summary",
          "current",
          summary,
        );
        await writeSummaryFile(g, summary);
        const file = await writePage(g, summary);
        context.logger?.info(
          "Synced {n} device(s); page written to {file}",
          { n: summary.total, file },
        );
        return { dataHandles: [handle] };
      },
    },

    "ensure-caddy-serve": {
      description:
        "When @svendowideit/caddy is installed, idempotently declare a Caddy " +
        "file_server route serving the page at the page hostname, reading the " +
        "domain from the caddy model that already owns this machine. Caddy " +
        "derives the TLS subject and A record from the route. Intended to run " +
        "from the hourly workflow, never in isolation.",
      arguments: CaddyServeArgsSchema,
      execute: async (
        args: z.infer<typeof CaddyServeArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const g = context.globalArgs;
        logger?.info("Ensuring the ESPHome page Caddy route");
        const probe = await runSwampCmd([
          "model",
          "type",
          "search",
          "@svendowideit/caddy",
          "--json",
        ]);
        const installed = probe.code === 0 &&
          probe.stdout.includes("@svendowideit/caddy");
        if (!installed) {
          logger?.info(
            "@svendowideit/caddy not installed — skipping page serving setup.",
          );
          return { dataHandles: [] };
        }
        const list = await runSwampCmd(["model", "list", "--json"]);
        if (list.code !== 0) {
          logger?.info(
            "Could not list models ({code}) — skipping page serving setup.",
            { code: list.code },
          );
          return { dataHandles: [] };
        }
        const names = caddyModelNames(list.stdout);
        if (names.length === 0) {
          logger?.info(
            "No @svendowideit/caddy model found — skipping page serving setup.",
          );
          return { dataHandles: [] };
        }
        const host = machineHostname();
        const facts: CaddyModelFacts[] = [];
        for (const name of names) {
          const got = await runSwampCmd(["model", "get", name, "--json"]);
          if (got.code !== 0) continue;
          try {
            facts.push(
              parseCaddyModelFacts(name, JSON.parse(got.stdout), host),
            );
          } catch {
            continue;
          }
        }
        const explicit = args.model.trim() || g.caddyModelName.trim();
        let source: CaddyModelFacts | null;
        if (explicit) {
          source = facts.find((f) => f.modelName === explicit) ?? null;
          if (!source) {
            logger?.info(
              "caddy model '{model}' not found — skipping page serving setup.",
              { model: explicit },
            );
            return { dataHandles: [] };
          }
        } else {
          source = pickSourceCaddy(facts, host);
          if (!source) {
            logger?.info(
              "Could not pick a single caddy model ({models}) — skipping. Set caddyModelName on this model to choose one.",
              { models: names.join(", ") },
            );
            return { dataHandles: [] };
          }
        }
        const hostname = args.hostname.trim() ||
          g.caddyRouteHostname.trim() ||
          g.pageHostname.trim() ||
          (source.baseDomain ? `esphome.${source.baseDomain}` : "");
        if (!hostname) {
          logger?.info(
            "caddy model '{model}' has no base domain — skipping page serving setup.",
            { model: source.modelName },
          );
          return { dataHandles: [] };
        }
        const pageFile = deriveOutputFile(g);
        const root = args.serveRoot.trim()
          ? expandHome(args.serveRoot.trim())
          : pageFile.slice(0, pageFile.lastIndexOf("/"));
        const serveModel = args.serveModel.trim() ||
          g.caddyServeModel.trim() ||
          "esphome-caddy";
        const existing = await runSwampCmd([
          "model",
          "get",
          serveModel,
          "--json",
        ]);
        if (existing.code !== 0) {
          const createArgs = [
            "model",
            "create",
            "@svendowideit/caddy",
            serveModel,
            "--global-arg",
            `baseDomain=${source.baseDomain}`,
            "--global-arg",
            `serviceName=${source.serviceName}`,
          ];
          if (source.target) {
            createArgs.push("--global-arg", `target=${source.target}`);
          }
          const create = await runSwampCmd(createArgs);
          if (create.code !== 0) {
            throw new Error(
              `Failed to create caddy model ${serveModel} (${create.code}): ${
                create.stderr || create.stdout
              }`,
            );
          }
          logger?.info(
            "Created caddy model {model} (baseDomain {domain}, unit {unit}) to serve the ESPHome page",
            {
              model: serveModel,
              domain: source.baseDomain,
              unit: source.serviceName,
            },
          );
        }
        const run = await runSwampCmd([
          "model",
          "method",
          "run",
          serveModel,
          "serveSettings",
          "--input",
          `hostname=${hostname}`,
          "--input",
          `root=${root}`,
          "--skip-reports",
        ]);
        if (run.code !== 0) {
          throw new Error(
            `serveSettings failed (${run.code}): ${run.stderr || run.stdout}`,
          );
        }
        logger?.info(
          "ESPHome page served: {hostname} -> {root} via caddy model {model} (domain from {source})",
          { hostname, root, model: serveModel, source: source.modelName },
        );
        const handle = await context.writeResource("caddyServe", "current", {
          hostname,
          root,
          serveModel,
          sourceModel: source.modelName,
          baseDomain: source.baseDomain,
          servedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
