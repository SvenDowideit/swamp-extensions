/**
 * `@svendowideit/garmin-devices` — device inventory and the derived capability
 * map that gates the other Garmin domain models.
 *
 * Garmin features are not uniform across accounts: golf, solar, HRV, SpO2,
 * respiration, training readiness and the rest only exist when the account has
 * a device that supports them. Rather than let every domain model fail on a
 * missing device, this model answers one question once — *what can this account
 * do?* — and writes a `capabilities` resource a workflow can guard on:
 *
 *   when: ${{ data.latest("garmin-devices", "device-capabilities").attributes.capabilities.hrv == true }}
 *
 * Like the other domain models, it **fetches nothing itself**. A workflow runs
 * `@svendowideit/garmin-connect`'s `fetch-many` for the paths this model
 * declares (`paths`), then `sync` reads those cached responses and parses them.
 * That keeps the parsing pure and unit-testable and leaves authentication,
 * token rotation and rate limiting in the one transport model.
 *
 * Capability derivation is **best-effort and conservative**: it classifies each
 * device by product line (watch, cycling computer, handheld, golf, …) from its
 * product key and display name, then unions the feature sets of those lines.
 * Every capability can be corrected by the user via `capabilityOverrides`
 * without touching code, and `confidence` records whether a value was derived
 * from a recognised product line or is only a heuristic.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { readCachedByPath } from "./garmin_cache.ts";

// ---------------------------------------------------------------------------
// Endpoints this model owns
// ---------------------------------------------------------------------------

/** Public `connectapi` paths the devices model needs cached. */
export const DEVICE_PATHS = {
  devices: "/device-service/deviceregistration/devices",
  settings: "/userprofile-service/userprofile/user-settings",
  primary: "/web-gateway/device-info/primary-training-device",
} as const;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  cacheDir: z.string()
    .default("~/.swamp/garmin-cache")
    .describe(
      "Shared cache directory to read the transport's responses from (must " +
        "match the @svendowideit/garmin-connect model's cacheDir).",
    ),
  capabilityOverrides: z.record(z.string(), z.boolean())
    .default({})
    .describe(
      "Force specific capabilities true/false, overriding detection. Use this " +
        "when a device is unknown or a feature is disabled on the account.",
    ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const SyncArgsSchema = z.object({
  overrides: z.record(z.string(), z.boolean())
    .optional()
    .describe("Per-run capability overrides, merged over the global ones"),
});

const SetupArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Product-line detection
// ---------------------------------------------------------------------------

/**
 * A device product line. A single device can belong to more than one (a
 * `fenix` is a `watch` that also plays `golf`).
 */
export type ProductLine =
  | "watch"
  | "cycling"
  | "handheld"
  | "golf"
  | "fitness"
  | "scale"
  | "dive"
  | "aviation"
  | "unknown";

/** Substrings that identify a product line, matched case-insensitively. */
const PRODUCT_LINE_MATCHERS: Record<ProductLine, string[]> = {
  watch: [
    "fenix",
    "forerunner",
    "fr",
    "venu",
    "vivoactive",
    "vivosmart",
    "vivomove",
    "instinct",
    "epix",
    "marq",
    "lily",
    "descent",
    "tactix",
    "enduro",
    "approach",
  ],
  cycling: ["edge"],
  handheld: ["gpsmap", "oregon", "montana", "etrex", "rino", "gps"],
  golf: ["approach", "golf"],
  fitness: ["vivosport", "vivofit", "vivo"],
  scale: ["index", "scale"],
  dive: ["descent", "mk"],
  aviation: ["d2", "d2air", "aviator"],
  unknown: [],
};

/** Wellness/performance features exposed by a modern wearable watch. */
const WATCH_FEATURES = [
  "sleep",
  "sleepScore",
  "stress",
  "bodyBattery",
  "hrv",
  "spo2",
  "respiration",
  "trainingStatus",
  "trainingReadiness",
  "vo2max",
  "racePredictions",
  "hillScore",
  "enduranceScore",
  "runningTolerance",
  "fitnessAge",
  "intensityMinutes",
  "hydration",
];

/** Features a cycling computer adds. */
const CYCLING_FEATURES = ["cycling", "powerZones", "ftp"];

/** Features a handheld adds (navigation-heavy, rarely wellness). */
const HANDHELD_FEATURES = ["navigation"];

/** Features a golf device adds. */
const GOLF_FEATURES = ["golf", "golfScorecard"];

/** Features a dive computer adds. */
const DIVE_FEATURES = ["dive"];

/** Features an aviation device adds. */
const AVIATION_FEATURES = ["aviation"];

/** Features a scale adds. */
const SCALE_FEATURES = ["weight", "bodyComposition"];

/**
 * Extra capabilities a recognised product family implies. `watch` already
 * carries the wellness set; this adds family-specific ones.
 */
const FAMILY_FEATURES: Record<string, string[]> = {
  fenix: ["solar", "golf", "maps"],
  epix: ["maps"],
  marq: ["solar", "golf", "maps"],
  enduro: ["solar"],
  instinct: ["solar"],
  forerunner: [],
  venu: [],
  vivoactive: [],
};

/**
 * Normalise a raw device into a stable shape.
 *
 * Garmin's field names drift, so this reads several spellings. `id` is a string
 * because device ids exceed `Number.MAX_SAFE_INTEGER`.
 */
export function normalizeDevice(
  raw: Record<string, unknown>,
): {
  id: string;
  name: string;
  category: string;
  productSku: string | null;
  applicationKey: string | null;
  softwareVersion: string | null;
  lines: ProductLine[];
} | null {
  const id = raw.deviceId ?? raw.deviceID ?? raw.id;
  if (id === undefined || id === null || id === "") return null;
  const name = String(
    raw.displayName ?? raw.productDisplayName ?? raw.deviceName ?? raw.name ??
      `device-${id}`,
  );
  const productSku = raw.productSku != null
    ? String(raw.productSku)
    : raw.partNumber != null
    ? String(raw.partNumber)
    : null;
  const applicationKey = raw.applicationKey != null
    ? String(raw.applicationKey)
    : raw.deviceCategoryKey != null
    ? String(raw.deviceCategoryKey)
    : null;
  const haystack = [
    name,
    productSku ?? "",
    applicationKey ?? "",
    raw.deviceCategory != null ? String(raw.deviceCategory) : "",
  ].join(" ").toLowerCase();

  const lines = detectProductLines(haystack);
  return {
    id: String(id),
    name,
    category: raw.deviceCategory != null ? String(raw.deviceCategory) : "",
    productSku,
    applicationKey,
    softwareVersion: raw.softwareVersion != null
      ? String(raw.softwareVersion)
      : null,
    lines,
  };
}

/**
 * Classify a lower-cased device string into product lines.
 *
 * Matching is substring-based against {@link PRODUCT_LINE_MATCHERS}. Short keys
 * like `fr` and `mk` are matched only as whole tokens (`fr965`, not `inFRa`) to
 * avoid false positives.
 */
export function detectProductLines(haystack: string): ProductLine[] {
  const lines = new Set<ProductLine>();
  const tokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
  for (const line of Object.keys(PRODUCT_LINE_MATCHERS) as ProductLine[]) {
    for (const key of PRODUCT_LINE_MATCHERS[line]) {
      const matched = key.length <= 2
        ? tokens.some((t) =>
          t === key || t.startsWith(`${key}-`) ||
          /^[a-z]{0,3}\d/.test(t) && t.includes(key)
        )
        : haystack.includes(key);
      if (matched) {
        lines.add(line);
        break;
      }
    }
  }
  if (lines.size === 0) lines.add("unknown");
  return [...lines];
}

/** Feature keys a product line implies (family extras are added separately). */
export function featuresForLine(line: ProductLine): string[] {
  switch (line) {
    case "watch":
      return [...WATCH_FEATURES];
    case "cycling":
      return [...CYCLING_FEATURES];
    case "handheld":
      return [...HANDHELD_FEATURES];
    case "golf":
      return [...GOLF_FEATURES];
    case "fitness":
      return ["steps", "sleep", "stress", "bodyBattery"];
    case "scale":
      return [...SCALE_FEATURES];
    case "dive":
      return [...DIVE_FEATURES];
    case "aviation":
      return [...AVIATION_FEATURES];
    default:
      return [];
  }
}

/** Extra capabilities implied by a recognised product family key. */
export function familyFeatures(haystack: string): string[] {
  const out: string[] = [];
  for (const [family, features] of Object.entries(FAMILY_FEATURES)) {
    if (haystack.includes(family)) out.push(...features);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capability map
// ---------------------------------------------------------------------------

/** A derived capability map plus the provenance a workflow/user can audit. */
export interface CapabilityMap {
  generatedAt: string;
  deviceCount: number;
  /** Whether any device was recognised as a watch/cycling/etc. line. */
  productLines: ProductLine[];
  /** Boolean capability flags, safe to use in workflow guards. */
  capabilities: Record<string, boolean>;
  /** `derived` = from a recognised product line; `override` = user-set. */
  confidence: Record<string, "derived" | "override">;
  /** Capabilities the user explicitly set, echoed for transparency. */
  overrides: Record<string, boolean>;
  /** Device names that matched no known product line (review these). */
  unknownProducts: string[];
  /** Units from Garmin user settings, when available. */
  measurementSystem: string | null;
  /** Resource payloads are open maps at the swamp boundary. */
  [key: string]: unknown;
}

/**
 * Build the capability map from normalised devices and user settings.
 *
 * Union semantics: a capability is true when *any* device implies it. Overrides
 * win over derivation and are recorded as such. Unknown products are surfaced
 * rather than silently ignored, so a user can see what was not classified.
 */
export function buildCapabilities(
  devices: ReturnType<typeof normalizeDevice>[],
  settings: Record<string, unknown> | null,
  overrides: Record<string, boolean>,
  nowMs: number,
): CapabilityMap {
  const capabilities: Record<string, boolean> = {};
  const confidence: Record<string, "derived" | "override"> = {};
  const productLines = new Set<ProductLine>();
  const unknownProducts: string[] = [];

  for (const device of devices) {
    if (!device) continue;
    const haystack = [
      device.name,
      device.productSku ?? "",
      device.applicationKey ?? "",
    ].join(" ").toLowerCase();
    let known = false;
    for (const line of device.lines) {
      productLines.add(line);
      if (line !== "unknown") known = true;
      for (const feature of featuresForLine(line)) {
        capabilities[feature] = true;
        confidence[feature] = "override" in confidence
          ? confidence[feature]!
          : "derived";
      }
    }
    for (const feature of familyFeatures(haystack)) {
      capabilities[feature] = true;
      confidence[feature] ??= "derived";
    }
    if (!known) unknownProducts.push(device.name);
  }

  // Garmin user settings can enable/disable tracked features per account.
  const userData = settings?.userData as Record<string, unknown> | undefined;
  const measurementSystem = userData?.measurementSystem != null
    ? String(userData.measurementSystem)
    : null;
  const menstrual = settings?.userMenstrualCycleSettings != null;
  const nutrition = settings?.userNutritionSettings != null ||
    settings?.nutritionSettings != null;
  if (menstrual) {
    capabilities.menstrual = true;
    confidence.menstrual = "derived";
  }
  if (nutrition) {
    capabilities.nutrition = true;
    confidence.nutrition = "derived";
  }

  for (const [key, value] of Object.entries(overrides)) {
    capabilities[key] = value;
    confidence[key] = "override";
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    deviceCount: devices.filter(Boolean).length,
    productLines: [...productLines].sort(),
    capabilities,
    confidence,
    overrides,
    unknownProducts,
    measurementSystem,
  };
}

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

type ResDataHandle = { name: string };

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info(msg: string, p?: Record<string, unknown>): void;
    debug?(msg: string, p?: Record<string, unknown>): void;
    warn?(msg: string, p?: Record<string, unknown>): void;
  };
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<ResDataHandle>;
};

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  productSku: z.string().nullable(),
  applicationKey: z.string().nullable(),
  softwareVersion: z.string().nullable(),
  lines: z.array(z.string()),
});

const DevicesResultSchema = z.object({
  generatedAt: z.string(),
  count: z.number(),
  primaryDeviceId: z.string().nullable(),
  devices: z.array(DeviceSchema),
  cached: z.boolean(),
});

const CapabilitiesResultSchema = z.object({
  generatedAt: z.string(),
  deviceCount: z.number(),
  productLines: z.array(z.string()),
  capabilities: z.record(z.string(), z.boolean()),
  confidence: z.record(z.string(), z.string()),
  overrides: z.record(z.string(), z.boolean()),
  unknownProducts: z.array(z.string()),
  measurementSystem: z.string().nullable(),
});

const PathsResultSchema = z.object({
  paths: z.array(z.string()),
});

const SetupSchema = z.object({ report: z.string() });

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Coerce a cached body that may be an array or a single object to a list. */
export function asList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["devices", "deviceList", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
    return [obj];
  }
  return [];
}

/** Extract the primary training device id from a primary-device response. */
export function primaryDeviceId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const primary = obj.primaryTrainingDevice as
    | Record<string, unknown>
    | undefined;
  const id = primary?.deviceId ?? obj.deviceId ?? obj.primaryDeviceId;
  return id === undefined || id === null ? null : String(id);
}

/** Parse a cached body as JSON, returning null on a miss or bad JSON. */
function parseCached(body: string | null): unknown | null {
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The `@svendowideit/garmin-devices` model definition. */
export const model = {
  type: "@svendowideit/garmin-devices",
  version: "2026.09.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    devices: {
      description: "Normalised registered device inventory",
      schema: DevicesResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    capabilities: {
      description:
        "Derived capability map that gates other Garmin domain models. Guard " +
        "on `.attributes.capabilities.<name>`.",
      schema: CapabilitiesResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    paths: {
      description:
        "The connectapi paths this model needs the transport to fetch",
      schema: PathsResultSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    setup: {
      description: "Configuration-readiness report",
      schema: SetupSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
  },
  methods: {
    setup: {
      description:
        "Report whether the device/settings responses are cached and what " +
        "capabilities were derived. Read-only.",
      arguments: SetupArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const lines: string[] = [];
        lines.push("Garmin devices configuration");
        lines.push(`  cache dir:    ${g.cacheDir}`);
        lines.push(
          `  overrides:    ${
            Object.keys(g.capabilityOverrides).length === 0
              ? "(none)"
              : JSON.stringify(g.capabilityOverrides)
          }`,
        );
        lines.push("");
        lines.push("Cached responses:");
        for (const [name, path] of Object.entries(DEVICE_PATHS)) {
          const { entry } = await readCachedByPath(g.cacheDir, path);
          lines.push(
            `  ${name}: ${entry ? `cached ${entry.fetchedAt}` : "not cached"}`,
          );
        }
        lines.push("");
        lines.push("To populate the cache, run:");
        lines.push("  swamp workflow run @svendowideit/garmin-devices-sync");
        const report = lines.join("\n");
        const handle = await ctx.writeResource("setup", "report", { report });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    paths: {
      description:
        "Return the connectapi paths this model needs. Feed the result to " +
        "@svendowideit/garmin-connect's fetch-many, then call `sync`.",
      arguments: SetupArgsSchema,
      execute: async (_args: unknown, ctx: MethodContext) => {
        const paths = Object.values(DEVICE_PATHS);
        const handle = await ctx.writeResource("paths", "paths", { paths });
        ctx.logger.info("Devices model needs {n} paths", { n: paths.length });
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Parse the cached device inventory and user settings, write the " +
        "normalised `devices` resource and the derived `capabilities` map. " +
        "Reads the shared cache; run the transport's fetch first (the " +
        "garmin-devices-sync workflow does both).",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const nowMs = Date.now();

        const devicesCache = await readCachedByPath(
          g.cacheDir,
          DEVICE_PATHS.devices,
        );
        const settingsCache = await readCachedByPath(
          g.cacheDir,
          DEVICE_PATHS.settings,
        );
        const primaryCache = await readCachedByPath(
          g.cacheDir,
          DEVICE_PATHS.primary,
        );

        if (devicesCache.body === null) {
          throw new Error(
            "No cached device list. Run the transport fetch first: " +
              "swamp workflow run @svendowideit/garmin-devices-sync",
          );
        }

        const raw = parseCached(devicesCache.body);
        const devices = asList(raw)
          .map((d) => normalizeDevice(d))
          .filter((d): d is NonNullable<typeof d> => d !== null);

        const settings = parseCached(settingsCache.body) as
          | Record<string, unknown>
          | null;
        const primary = primaryDeviceId(parseCached(primaryCache.body));

        const devicesResult = {
          generatedAt: new Date(nowMs).toISOString(),
          count: devices.length,
          primaryDeviceId: primary,
          devices,
          cached: true,
        };
        const devicesHandle = await ctx.writeResource(
          "devices",
          "device-list",
          devicesResult,
        );

        const overrides = {
          ...g.capabilityOverrides,
          ...(args.overrides ?? {}),
        };
        const map = buildCapabilities(devices, settings, overrides, nowMs);
        const capsHandle = await ctx.writeResource(
          "capabilities",
          "device-capabilities",
          map,
        );

        const enabled = Object.entries(map.capabilities)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .sort();
        ctx.logger.info(
          "Synced {n} device(s); {m} capabilities enabled{unknown}",
          {
            n: devices.length,
            m: enabled.length,
            unknown: map.unknownProducts.length
              ? ` (${map.unknownProducts.length} unrecognised device(s))`
              : "",
          },
        );
        return { dataHandles: [devicesHandle, capsHandle] };
      },
    },
  },
};
