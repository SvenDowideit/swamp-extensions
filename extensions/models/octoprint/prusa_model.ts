/**
 * @svendowideit/prusa
 *
 * The machine, not the appliance: firmware currency, EEPROM settings, what the
 * camera is really doing, and what a frame actually contains.
 *
 * Split from `@svendowideit/octoprint` (plugins, core version, printer state):
 * that model answers "is the box current", this one "is the printer healthy".
 * Both are read-only and neither touches the printer's serial port.
 *
 * Where a fact lives in a log or config file the caller passes the text in
 * (collected by `@swamp/ssh`) and the parsers in `prusa.ts` turn it into data.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  compareLine,
  hasSettings,
  latestStable,
  parseBuildDate,
  parseFirmwareVersion,
  parseM115,
  parseM503,
  parseReleases,
  parseWebcamConfig,
  sha256Hex,
  sha256Text,
  snapshotStats,
} from "./prusa.ts";

/** The subset of swamp's vault reader this model needs. */
export interface VaultService {
  get: (vaultName: string, key: string) => Promise<string | undefined>;
}

/** Normalise a base URL; only http(s) is a real OctoPrint endpoint. */
export function normaliseBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return /^https?:\/\//i.test(withScheme) ? withScheme : "";
}

/** Resolve the OctoPrint base URL from a global or from the vault. */
export async function resolveBaseUrl(
  g: { baseUrl: string; vaultName: string; urlRef: string },
  vault?: VaultService,
): Promise<string> {
  const direct = normaliseBaseUrl(g.baseUrl);
  if (direct) return direct;
  let fromVault = "";
  if (vault) {
    try {
      fromVault = ((await vault.get(g.vaultName, g.urlRef)) ?? "").trim();
    } catch {
      fromVault = "";
    }
  }
  const url = normaliseBaseUrl(fromVault);
  if (!url) throw new Error("prusa: no base URL configured (global or vault)");
  return url;
}

/** GET a third-party JSON URL (firmware releases); failures are data. */
async function getJsonUrl(
  url: string,
  opts: { token?: string; userAgent?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; json: unknown; error: string }> {
  try {
    const res = await globalThis.fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": opts.userAgent ?? "swamp-prusa/1.0",
        ...(opts.token ? { "Authorization": `Bearer ${opts.token}` } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        json: null,
        error: `HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status, json: JSON.parse(text), error: "" };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** GET raw bytes from the printer (a snapshot needs the pixels). */
async function getBytes(url: string, timeoutMs: number) {
  try {
    const res = await globalThis.fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      bytes,
      contentType: res.headers.get("content-type") ?? "",
      error: "",
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      bytes: new Uint8Array(0),
      contentType: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const nowIso = () => new Date().toISOString();

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe("Model instance name."),
  baseUrl: z.string().default("").describe(
    "OctoPrint base URL; empty reads it from the vault.",
  ),
  vaultName: z.string().default("octoprint-secrets").describe(
    "Vault holding the endpoint. Read at run time.",
  ),
  urlRef: z.string().default("url").describe("Vault key holding the base URL."),
  requestTimeoutMs: z.number().int().positive().default(30_000)
    .describe("Per-request timeout in ms."),
  firmwareRepo: z.string().default("prusa3d/Prusa-Firmware").describe(
    "Repository whose releases are compared against the installed firmware.",
  ),
  // swamp-quality-ignore credentials-sensitive-field: optional, not needed
  githubToken: z.string().default("").describe(
    "Optional GitHub token, only to raise the release-lookup rate limit.",
  ),
  darkBytesPerPixel: z.number().positive().default(0.05).describe(
    "Bytes-per-pixel below which a frame is reported as suspiciously dark. A " +
      "black frame compresses to ~0.01-0.03; a normal scene is ~0.1-0.2.",
  ),
  userAgent: z.string().default("swamp-prusa/1.0").describe("User-Agent sent."),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const EmptyArgs = z.object({});
type Empty = z.infer<typeof EmptyArgs>;

const FirmwareCheckArgs = z.object({
  firmwareName: z.string().optional().describe(
    "The firmware string, e.g. Prusa-Firmware 3.2.3 based on Marlin.",
  ),
  logText: z.string().optional().describe(
    "Log excerpt containing 'Printer reports firmware name ...'.",
  ),
});
type FirmwareCheckArgsT = z.infer<typeof FirmwareCheckArgs>;

const ConfigArgs = z.object({
  logText: z.string().optional().describe(
    "Log excerpt containing an M503 dump and/or M115 line. Empty is fine.",
  ),
});
type ConfigArgsT = z.infer<typeof ConfigArgs>;

const WebcamConfigArgs = z.object({
  configText: z.string().optional().describe("Contents of /boot/octopi.txt."),
  serviceShow: z.string().optional().describe(
    "Output of systemctl show webcamd.",
  ),
  processArgs: z.string().optional().describe(
    "Output of ps -o args= for mjpg_streamer or ustreamer.",
  ),
});
type WebcamConfigArgsT = z.infer<typeof WebcamConfigArgs>;

const MachineSchema = z.object({
  firmwareName: z.string().default(""),
  machineType: z.string().default(""),
  extruderCount: z.number().nullable().default(null),
  uuid: z.string().default(""),
});

const SettingsSchema = z.object({
  stepsPerMm: z.record(z.string(), z.number()).default({}),
  maxFeedrate: z.record(z.string(), z.number()).default({}),
  maxAccel: z.record(z.string(), z.number()).default({}),
  acceleration: z.record(z.string(), z.number()).default({}),
  jerk: z.record(z.string(), z.number()).default({}),
  hotendPid: z.record(z.string(), z.number()).default({}),
  zOffset: z.number().nullable().default(null),
});

const FirmwareCheckSchema = z.object({
  url: z.string(),
  checkedAt: z.string(),
  repo: z.string().default(""),
  installedName: z.string().default(""),
  installedVersion: z.string().default(""),
  latestTag: z.string().default(""),
  comparedTo: z.string().default(""),
  comparedToPublishedAt: z.string().default(""),
  installedBuildDate: z.string().default(""),
  latestPublishedAt: z.string().default(""),
  releaseCount: z.number().int().default(0),
  verdict: z.string().default("unknown"),
  errors: z.array(z.string()).default([]),
});

const ConfigSchema = z.object({
  url: z.string(),
  checkedAt: z.string(),
  found: z.boolean().default(false),
  machine: MachineSchema,
  hash: z.string().default(""),
  settings: SettingsSchema,
  notes: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

const SnapshotSchema = z.object({
  url: z.string(),
  checkedAt: z.string(),
  ok: z.boolean().default(false),
  contentType: z.string().default(""),
  bytes: z.number().int().default(0),
  width: z.number().int().default(0),
  height: z.number().int().default(0),
  pixels: z.number().int().default(0),
  bytesPerPixel: z.number().default(0),
  dark: z.boolean().default(false),
  sha256: z.string().default(""),
  errors: z.array(z.string()).default([]),
});

const WebcamConfigSchema = z.object({
  url: z.string(),
  checkedAt: z.string(),
  daemon: z.string().default(""),
  resolution: z.string().default(""),
  fps: z.number().nullable().default(null),
  device: z.string().default(""),
  settings: z.array(z.string()).default([]),
  complete: z.boolean().default(false),
  errors: z.array(z.string()).default([]),
});

interface MethodContext {
  globalArgs: GlobalArgs;
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

export const model = {
  type: "@svendowideit/prusa",
  version: "2026.11.27.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.11.26.2",
      description:
        "Initial release: printer-domain read-only checks kept out of the " +
        "appliance model. firmwareCheck compares the installed build against " +
        "the configured repository's newest stable release and keeps 'ahead of " +
        "the known line' separate from 'current'. config parses an M503/M115 " +
        "log excerpt into EEPROM settings plus a drift hash and says so when " +
        "nothing was ever logged; it never sends M503. snapshot describes a " +
        "webcam frame without decoding pixels, so a black or frozen camera is " +
        "visible even though HTTP returns 200. webcamConfig reports which " +
        "daemon really runs, at what resolution, fps and device.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.27.1",
      description:
        "Documentation only: every command in the manifest and README now uses " +
        "the CLI's real argument order (`swamp behavior run <name> <method>`) " +
        "and fits a pasteable line, so the examples run as shown. No schema, " +
        "argument or resource change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    firmwareCheck: {
      description:
        "Installed firmware vs the newest stable release, with a verdict.",
      schema: FirmwareCheckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    config: {
      description:
        "EEPROM settings from an M503/M115 excerpt, plus a hash for drift.",
      schema: ConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    snapshot: {
      description:
        "One frame: dimensions, bytes/pixel, darkness flag, content hash.",
      schema: SnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    webcamConfig: {
      description: "Which camera daemon runs, at what resolution/fps/device.",
      schema: WebcamConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    firmwareCheck: {
      description:
        "Compare the installed firmware against the newest stable release of " +
        "the configured repository. Takes the string from the ssh log read or " +
        "a pasted excerpt; never asks the printer.",
      arguments: FirmwareCheckArgs,
      execute: async (
        args: FirmwareCheckArgsT,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const url = await resolveBaseUrl(g, ctx.vaultService);
        const errors: string[] = [];

        const quoted = (args.logText ?? "").match(/firmware name\s+"([^"]+)"/i);
        const name = args.firmwareName?.trim() || quoted?.[1] || "";
        const parsed = parseFirmwareVersion(name);

        const res = await getJsonUrl(
          `https://api.github.com/repos/${g.firmwareRepo}/releases?per_page=30`,
          {
            token: g.githubToken,
            userAgent: g.userAgent,
            timeoutMs: g.requestTimeoutMs,
          },
        );
        if (!res.ok) errors.push(`releases: ${res.error}`);
        const releases = parseReleases(res.json);
        const latest = latestStable(releases);
        // Compare like-for-like: a 3.2.x build is not "behind" a 3.13.x line.
        const byLine = compareLine(parsed.version, releases);

        const record = {
          url,
          checkedAt: nowIso(),
          repo: g.firmwareRepo,
          installedName: parsed.name,
          installedVersion: parsed.version,
          latestTag: latest?.tag ?? "",
          comparedTo: byLine.comparedTo,
          comparedToPublishedAt: byLine.comparedToPublishedAt,
          installedBuildDate: parseBuildDate(parsed.name),
          latestPublishedAt: latest?.publishedAt ?? "",
          releaseCount: releases.length,
          verdict: byLine.verdict,
          errors,
        };
        const handle = await ctx.writeResource(
          "firmwareCheck",
          "firmwareCheck",
          record,
        );
        ctx.logger?.info(
          "firmware {installed}{built} vs {latest} ({repo}, {published}): {verdict}",
          {
            installed: record.installedVersion || "unknown",
            built: record.installedBuildDate
              ? ` (built ${record.installedBuildDate})`
              : "",
            latest: record.latestTag || "unknown",
            repo: record.repo,
            published: record.latestPublishedAt || "unknown date",
            verdict: record.verdict,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    config: {
      description:
        "Parse an M503/M115 excerpt into EEPROM settings with a drift hash. " +
        "Sends nothing to the printer.",
      arguments: ConfigArgs,
      execute: async (
        args: ConfigArgsT,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const url = await resolveBaseUrl(g, ctx.vaultService);
        const errors: string[] = [];

        const text = args.logText ?? "";
        const settings = parseM503(text);
        const machine = parseM115(text);
        const found = hasSettings(settings);
        const hash = await sha256Text(JSON.stringify(settings));

        const record = {
          url,
          checkedAt: nowIso(),
          found,
          machine,
          hash,
          settings,
          notes: found ? [] : [
            "no M503 in the supplied text: OctoPrint only logs what was " +
            "sent, so a baseline needs one M503 from its terminal (never " +
            "sent automatically by this model)",
          ],
          errors,
        };
        const handle = await ctx.writeResource("config", "config", record);
        ctx.logger?.info("printer config from log: {state} (hash {hash})", {
          state: found ? "settings found" : "no M503 logged",
          hash: hash.slice(0, 12),
        });
        return { dataHandles: [handle] };
      },
    },

    snapshot: {
      description:
        "Fetch one webcam frame and describe it without decoding pixels: " +
        "dimensions, bytes-per-pixel, darkness flag and content hash.",
      arguments: EmptyArgs,
      execute: async (
        _args: Empty,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const url = await resolveBaseUrl(g, ctx.vaultService);
        const errors: string[] = [];

        const snap = await getBytes(
          `${url}/webcam/?action=snapshot`,
          g.requestTimeoutMs,
        );
        if (!snap.ok) {
          errors.push(`snapshot: ${snap.error || `HTTP ${snap.status}`}`);
        }
        const stats = snapshotStats(snap.bytes);
        const contentHash = snap.bytes.length > 0
          ? await sha256Hex(snap.bytes)
          : "";

        const record = {
          url,
          checkedAt: nowIso(),
          ok: snap.ok && snap.contentType.startsWith("image/"),
          contentType: snap.contentType,
          bytes: stats.bytes,
          width: stats.width,
          height: stats.height,
          pixels: stats.pixels,
          bytesPerPixel: stats.bytesPerPixel,
          dark: snap.bytes.length > 0 &&
            stats.bytesPerPixel < g.darkBytesPerPixel,
          sha256: contentHash,
          errors,
        };
        const handle = await ctx.writeResource(
          "snapshot",
          "snapshot",
          record,
        );
        ctx.logger?.info(
          "webcam frame {w}x{h}: {bytes} bytes, {bpp} bytes/px{dark}",
          {
            w: record.width,
            h: record.height,
            bytes: record.bytes,
            bpp: record.bytesPerPixel,
            dark: record.dark ? " (DARK)" : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    webcamConfig: {
      description:
        "Report which camera daemon runs and at what settings, from texts the " +
        "ssh step collects.",
      arguments: WebcamConfigArgs,
      execute: async (
        args: WebcamConfigArgsT,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const url = await resolveBaseUrl(g, ctx.vaultService);
        const errors: string[] = [];

        const parsed = parseWebcamConfig({
          configText: args.configText,
          serviceShow: args.serviceShow,
          processArgs: args.processArgs,
        });
        const record = {
          url,
          checkedAt: nowIso(),
          daemon: parsed.daemon,
          resolution: parsed.resolution,
          fps: parsed.fps,
          device: parsed.device,
          settings: parsed.settings,
          complete: parsed.daemon !== "",
          errors,
        };
        const handle = await ctx.writeResource(
          "webcamConfig",
          "webcamConfig",
          record,
        );
        ctx.logger?.info(
          "webcam daemon {daemon} at {res} @ {fps}fps on {dev}",
          {
            daemon: record.daemon || "unknown",
            res: record.resolution || "unknown",
            fps: record.fps ?? "unknown",
            dev: record.device || "unknown",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
