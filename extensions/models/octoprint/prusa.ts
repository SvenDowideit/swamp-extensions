/**
 * Printer-domain parsing for `@svendowideit/octoprint`.
 *
 * Pure: no network, no ssh, no printer. The model owns HTTP, `@swamp/ssh` owns
 * ssh, and these functions turn text that already exists - a log line, a JPEG
 * header, `/boot/octopi.txt` - into facts, so every one is testable without a
 * printer.
 *
 * @module
 */

/** Extracted firmware version bits. */
export interface FirmwareVersion {
  name: string;
  /** First dotted numeric run found, e.g. "3.2.3"; "" when absent. */
  version: string;
}

/** Pull the version out of `Prusa-Firmware 3.2.3 based on Marlin` -> `3.2.3`. */
export function parseFirmwareVersion(name: string): FirmwareVersion {
  const text = name.trim();
  const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
  return { name: text, version: m ? m[1] : "" };
}

/** One release of the firmware repository. */
export interface FirmwareRelease {
  tag: string;
  prerelease: boolean;
  publishedAt: string;
}

/** Read a GitHub releases listing into tags, tolerant of shape changes. */
export function parseReleases(json: unknown): FirmwareRelease[] {
  if (!Array.isArray(json)) return [];
  const out: FirmwareRelease[] = [];
  for (const raw of json) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const tag = typeof r["tag_name"] === "string" ? r["tag_name"] : "";
    if (!tag) continue;
    out.push({
      tag: tag.replace(/^v/i, ""),
      prerelease: r["prerelease"] === true,
      publishedAt: typeof r["published_at"] === "string"
        ? r["published_at"]
        : "",
    });
  }
  return out;
}

/** Compare two dotted versions. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.split(/[.+-]/).map((p) => Number.parseInt(p, 10)).filter((n) =>
      !Number.isNaN(n)
    );
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The newest non-prerelease tag, or null when there is none. */
export function latestStable(
  releases: FirmwareRelease[],
): FirmwareRelease | null {
  const stable = releases.filter((r) => !r.prerelease);
  if (stable.length === 0) return null;
  return stable.reduce((best, r) =>
    compareVersions(r.tag, best.tag) > 0 ? r : best
  );
}

/**
 * Verdict for an installed firmware against a release list. An installed build
 * may be a community one numbering ahead of the official line, so "ahead" is a
 * separate verdict rather than being folded into "current".
 */
export type FirmwareVerdict =
  | "current"
  | "behind"
  | "ahead-of-known"
  | "unknown";

export function firmwareVerdict(
  installed: string,
  latest: string,
): FirmwareVerdict {
  if (!installed || !latest) return "unknown";
  const cmp = compareVersions(installed, latest);
  if (cmp === 0) return "current";
  return cmp < 0 ? "behind" : "ahead-of-known";
}

/**
 * Verdict against the releases of the *same* line (major.minor).
 *
 * A build whose line is not published at all is `unpublished-line`, not
 * "behind": the MK2S runs a 3.2.x firmware while `prusa3d/Prusa-Firmware`
 * publishes 3.13.x, and calling that "behind" would be a false alarm that sends
 * someone flashing the wrong firmware onto the machine.
 */
export type LineVerdict = "current" | "behind" | "unpublished-line" | "unknown";

export function verdictForLine(
  installed: string,
  releases: FirmwareRelease[],
): { verdict: LineVerdict; comparedTo: string } {
  if (!installed) return { verdict: "unknown", comparedTo: "" };
  // Nothing was fetched: we learned nothing, which is not the same as "the
  // installed line is unpublished".
  if (releases.length === 0) return { verdict: "unknown", comparedTo: "" };
  const line = (v: string) => v.split(".").slice(0, 2).join(".");
  const sameLine = releases.filter((r) =>
    !r.prerelease && line(r.tag) === line(installed)
  );
  if (sameLine.length === 0) {
    return { verdict: "unpublished-line", comparedTo: "" };
  }
  const latest = sameLine.reduce((best, r) =>
    compareVersions(r.tag, best.tag) > 0 ? r : best
  );
  const cmp = compareVersions(installed, latest.tag);
  return {
    verdict: cmp < 0 ? "behind" : "current",
    comparedTo: latest.tag,
  };
}

/** A build date embedded in a firmware string (ISO-ish); "" when absent. */
export function parseBuildDate(name: string): string {
  const m = name.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * Like `verdictForLine`, but also says which release it compared against and
 * when that release was published - a version number alone does not tell you
 * how old either side is.
 */
export function compareLine(
  installed: string,
  releases: FirmwareRelease[],
): {
  verdict: LineVerdict;
  comparedTo: string;
  comparedToPublishedAt: string;
} {
  const base = verdictForLine(installed, releases);
  if (!base.comparedTo) return { ...base, comparedToPublishedAt: "" };
  const match = releases.find((r) => r.tag === base.comparedTo);
  return {
    verdict: base.verdict,
    comparedTo: base.comparedTo,
    comparedToPublishedAt: match?.publishedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// M115 / M503
// ---------------------------------------------------------------------------

/** Marlin `M115` identification fields. */
export interface MachineIdentification {
  firmwareName: string;
  machineType: string;
  extruderCount: number | null;
  uuid: string;
}

/** Pull `KEY:value` pairs out of an M115 response. */
export function parseM115(text: string): MachineIdentification {
  const field = (key: string): string => {
    const m = text.match(new RegExp(`${key}:([^\\s]+)`));
    return m ? m[1].trim() : "";
  };
  const n = Number.parseInt(field("EXTRUDER_COUNT"), 10);
  return {
    firmwareName: field("FIRMWARE_NAME"),
    machineType: field("MACHINE_TYPE"),
    extruderCount: Number.isNaN(n) ? null : n,
    uuid: field("UUID"),
  };
}

/** The EEPROM settings an `M503` dump reports. */
export interface MachineSettings {
  stepsPerMm: Record<string, number>;
  maxFeedrate: Record<string, number>;
  maxAccel: Record<string, number>;
  acceleration: Record<string, number>;
  jerk: Record<string, number>;
  hotendPid: Record<string, number>;
  zOffset: number | null;
}

/** The `X1.00 Y2.00` tail of an M-code line as numbers. */
function axisValues(line: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of line.matchAll(/([A-Z])(-?\d+(?:\.\d+)?)/g)) {
    out[m[1]] = Number.parseFloat(m[2]);
  }
  return out;
}

/** Parse a Marlin `M503` dump; non-setting lines are ignored. */
export function parseM503(text: string): MachineSettings {
  const settings: MachineSettings = {
    stepsPerMm: {},
    maxFeedrate: {},
    maxAccel: {},
    acceleration: {},
    jerk: {},
    hotendPid: {},
    zOffset: null,
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // Real log lines are prefixed ("Recv: echo:  M92 ..."), so find the code
    // anywhere rather than anchoring at the start of the line.
    const match = line.match(/\b(M\d{2,3})\b/);
    if (!match || match.index === undefined) continue;
    const code = match[1];
    const values = axisValues(line.slice(match.index + code.length));
    switch (code) {
      case "M92":
        settings.stepsPerMm = values;
        break;
      case "M203":
        settings.maxFeedrate = values;
        break;
      case "M201":
        settings.maxAccel = values;
        break;
      case "M204":
        settings.acceleration = values;
        break;
      case "M205":
        settings.jerk = values;
        break;
      case "M301":
        settings.hotendPid = values;
        break;
      case "M851":
        if (typeof values["Z"] === "number") settings.zOffset = values["Z"];
        break;
      default:
        break;
    }
  }
  return settings;
}

/** True when an M503 parse actually found settings. */
export function hasSettings(s: MachineSettings): boolean {
  return Object.keys(s.stepsPerMm).length > 0 ||
    Object.keys(s.maxFeedrate).length > 0 ||
    Object.keys(s.hotendPid).length > 0;
}

// ---------------------------------------------------------------------------
// Webcam snapshots
// ---------------------------------------------------------------------------

/** Pixel dimensions from a JPEG Start-Of-Frame segment, or null. */
export function jpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 &&
      marker !== 0xc8 && marker !== 0xcc;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (isSof) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return { width, height };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/** Compact description of one snapshot, without decoding pixels. */
export function snapshotStats(bytes: Uint8Array): {
  bytes: number;
  width: number;
  height: number;
  pixels: number;
  bytesPerPixel: number;
  dark: boolean;
} {
  const dims = jpegDimensions(bytes);
  const width = dims?.width ?? 0;
  const height = dims?.height ?? 0;
  const pixels = width * height;
  const bytesPerPixel = pixels > 0 ? bytes.length / pixels : 0;
  return {
    bytes: bytes.length,
    width,
    height,
    pixels,
    bytesPerPixel: Math.round(bytesPerPixel * 10000) / 10000,
    // A black or obstructed frame compresses to roughly 0.01-0.03 bytes per
    // pixel; a normal webcam scene sits around 0.1-0.2. The threshold is set
    // low on purpose: a false "dark" on a healthy camera is worse than a
    // missed dim frame.
    dark: pixels > 0 && bytesPerPixel < 0.05,
  };
}

/** Hex SHA-256 of a body, for "has the image changed at all" comparisons. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer: a Uint8Array view may sit on a
  // SharedArrayBuffer, which crypto.subtle does not accept.
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copy.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Hex SHA-256 of a string. */
export async function sha256Text(text: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// Webcam configuration
// ---------------------------------------------------------------------------

export interface WebcamConfig {
  daemon: string;
  resolution: string;
  fps: number | null;
  device: string;
  settings: string[];
}

/**
 * Combine the cheap textual sources into one camera record: `/boot/octopi.txt`
 * (image config), `systemctl show webcamd` (the unit) and `ps -o args=` (the
 * running command line, which is the truth).
 */
export function parseWebcamConfig(input: {
  configText?: string;
  serviceShow?: string;
  processArgs?: string;
}): WebcamConfig {
  const configText = input.configText ?? "";
  const serviceShow = input.serviceShow ?? "";
  const processArgs = input.processArgs ?? "";

  const settings = configText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const daemonMatch = processArgs.match(
    /([a-z0-9_]+streamer|mjpg_streamer|ustreamer)/i,
  );
  const daemon = daemonMatch
    ? daemonMatch[1].toLowerCase()
    : (settings.some((l) => /ustreamer/i.test(l)) ? "ustreamer" : "");

  const res = processArgs.match(/-r\s+(\d{2,5}x\d{2,5})/) ??
    settings.map((l) => l.match(/(\d{2,5}x\d{2,5})/)).find((m) => m !== null);
  const resolution = res ? res[1] : "";

  const fpsMatch = processArgs.match(/-f\s+(\d{1,3})/);
  const fps = fpsMatch ? Number.parseInt(fpsMatch[1], 10) : null;

  const devMatch = processArgs.match(/-d\s+(\S+)/) ??
    (serviceShow.match(/Environment=.*?(\/dev\/video\d+)/) ?? null);
  const device = devMatch ? devMatch[1] : "";

  return { daemon, resolution, fps, device, settings };
}
