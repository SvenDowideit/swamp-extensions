/**
 * S3 archive planner — compare Amazon S3 storage tiers, lifecycle ladders and
 * access profiles for a photo/video archive, in Australia.
 *
 * This is a *planner*, not an uploader. It takes an inventory (bytes, object
 * count, source mix) plus an access profile, then models the monthly storage,
 * request, retrieval and egress cost of several plans: stay in S3 Standard,
 * move to Standard-IA/Glacier, transition down a lifecycle ladder, go straight
 * to Deep Archive, or keep a hot subset. It also costs the initial transfer and
 * a verification strategy that proves the S3 copy is byte-for-byte correct.
 *
 * Prices are fetched live from the public AWS Price List API (USD) for
 * `ap-southeast-2` (Sydney) and `ap-southeast-4` (Melbourne), with a live
 * USD/AUD rate for AUD output. No AWS credentials are used, and the model makes
 * no S3 bucket calls.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  convertCatalogCurrency,
  type Fetcher,
  fetchFxRate,
  fetchLivePricing,
  type FxInfo,
  type LivePricing,
} from "./live_pricing.ts";
import {
  getPricing,
  type RegionPricing,
  type RetrievalTier,
  type Tier,
  type TieredRate,
} from "./pricing.ts";

export type {
  AuRegion,
  RegionPricing,
  RetrievalTier,
  Tier,
  TieredRate,
} from "./pricing.ts";
export type { FxInfo } from "./live_pricing.ts";

const GB = 1_000_000_000;
const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;
const TiB = 1024 * 1024 * 1024 * 1024;
const DAYS_PER_MONTH = 365.25 / 12;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CountInput = z.union([z.number().nonnegative(), z.string().min(1)]);

const SourceSchema = z.object({
  name: z.string().min(1).describe("Human label, e.g. Google Photos"),
  kind: z.enum(["google", "nas", "optical", "other"]).default("other")
    .describe("Where the bytes come from"),
  bytes: CountInput.describe(
    "Source size in bytes (number, or string like 1.2b / 500m / 90k)",
  ),
  objectCount: CountInput.describe(
    "Number of files/objects (number, or string like 450k / 1.2m)",
  ),
  duplicateFraction: z.number().min(0).max(1).default(0).describe(
    "Fraction of this source already present in another source (0-1)",
  ),
  downloadPerGb: z.number().nonnegative().default(0).describe(
    "Cost per GB to read this source, in USD (0 for free Takeout/NAS reads)",
  ),
  fixedCost: z.number().nonnegative().default(0).describe(
    "One-off source cost in USD (courier, replacement drive, etc.)",
  ),
  throughputMbps: z.number().positive().optional().describe(
    "Observed/permitted source read throughput; defaults to uploadBandwidthMbps",
  ),
  notes: z.string().optional(),
}).strict();

/** Fields recorded by the inventory method (also used as method arguments). */
const InventoryFieldsSchema = z.object({
  sources: z.array(SourceSchema).default([]).describe(
    "Source breakdown (Google, NAS, optical media, ...)",
  ),
  totalBytes: CountInput.optional().describe(
    "Total source bytes when sources are not supplied (number or 1.2b/500m/90k)",
  ),
  objectCount: CountInput.optional().describe(
    "Total object count when sources are not supplied (number or 450k/1.2m)",
  ),
  avgObjectSizeBytes: CountInput.optional().describe(
    "Average object size (number or 3m/500k), used when one total is missing or for growth",
  ),
  duplicateFraction: z.number().min(0).max(1).default(0).describe(
    "Additional duplicate fraction across the whole collection (0-1)",
  ),
  annualGrowthPercent: z.number().min(0).max(1000).default(5).describe(
    "Expected annual growth in new archive bytes",
  ),
  initialTransferMonths: z.number().int().min(1).max(120).default(1).describe(
    "Spread the initial upload over this many months",
  ),
});

/** Arguments for the `inventory` method. */
/** Arguments for the `inventory` method. */
const InventoryArgsSchema = InventoryFieldsSchema;

/** Optional one-off replacement fields for the analysis inventory. */
const InventoryOverrideSchema = z.object({
  sources: z.array(SourceSchema).optional(),
  totalBytes: CountInput.optional(),
  objectCount: CountInput.optional(),
  avgObjectSizeBytes: CountInput.optional(),
  duplicateFraction: z.number().min(0).max(1).optional(),
  annualGrowthPercent: z.number().min(0).max(1000).optional(),
  initialTransferMonths: z.number().int().min(1).max(120).optional(),
}).strict();

/** Named access profiles supported by the planner. */
const AccessProfileSchema = z.enum([
  "cold",
  "occasional",
  "family",
  "frequent",
  "custom",
]);

/** Arguments for the `analyse` method. */
/** Arguments for the `analyse` method. */
const AnalyseArgsSchema = z.object({
  inventoryOverride: InventoryOverrideSchema.optional().describe(
    "Replace stored inventory fields for this analysis only",
  ),
  accessProfile: AccessProfileSchema.default("occasional").describe(
    "Preset access profile; custom uses the override fields",
  ),
  restoreFractionPerYear: z.number().min(0).max(100).optional().describe(
    "Fraction of stored bytes restored per year (0.01 = 1%)",
  ),
  restoreTier: z.enum(["bulk", "standard", "expedited"]).optional().describe(
    "Retrieval speed for Glacier/Deep Archive",
  ),
  restoreRetentionDays: z.number().int().min(1).max(30).optional().describe(
    "Days to keep a restored copy (charged at the Standard rate)",
  ),
  extraEgressGbPerMonth: z.number().nonnegative().optional().describe(
    "Ordinary downloads per month in addition to restores",
  ),
  getRequestsPerMonth: z.number().int().nonnegative().optional().describe(
    "Ordinary GET requests per month (browsing)",
  ),
  maxRestoreHours: z.number().nonnegative().default(48).describe(
    "Maximum acceptable restore time; plans slower than this are not recommended",
  ),
  years: z.number().int().min(1).max(50).default(10).describe(
    "Analysis horizon in years",
  ),
  planIds: z.array(z.string()).optional().describe(
    "Limit analysis to these plan ids (default: every plan)",
  ),
  egress: z.boolean().default(true).describe(
    "Include internet egress for restores (disable for same-region restore)",
  ),
  verificationSampleFraction: z.number().min(0).max(1).default(0.001)
    .describe("Fraction of archive bytes to restore in the sample drill"),
  verificationSampleMinBytes: z.number().nonnegative().default(10 * GiB)
    .describe("Minimum sample-drill size in bytes"),
  s3ComputesChecksum: z.boolean().default(false).describe(
    "Include S3's per-GB checksum computation fee",
  ),
  useBatchOperations: z.boolean().default(false).describe(
    "Include one S3 Batch Operations pass in the verification cost",
  ),
  priceOverrides: z.record(z.string(), z.number()).default({}).describe(
    "Flat path -> number overrides in the selected currency",
  ),
});

/** Arguments for the `pricing` method. */
const PricingArgsSchema = z.object({
  refresh: z.boolean().default(false).describe(
    "Force a live AWS/FX refresh even if a fresh cached catalog exists",
  ),
  priceOverrides: z.record(z.string(), z.number()).default({}).describe(
    "Flat path -> number overrides in the selected currency",
  ),
});

/** Global arguments for the model instance. */
const GlobalArgsSchema = z.object({
  region: z.enum(["ap-southeast-2", "ap-southeast-4"]).default(
    "ap-southeast-2",
  ).describe("AWS region for pricing"),
  currency: z.enum(["aud", "usd"]).default("aud").describe(
    "Display/calculation currency; AUD uses a live USD/AUD rate",
  ),
  audPerUsd: z.number().positive().optional().describe(
    "Optional manual AUD/USD rate override; omit to fetch the live rate",
  ),
  pricingRefresh: z.enum(["auto", "always", "never"]).default("auto")
    .describe(
      "auto: fetch when the cached catalog is stale; always: fetch every run; never: cached/bundled only",
    ),
  pricingMaxAgeHours: z.number().positive().default(24).describe(
    "Reuse a cached live catalog for this many hours in auto mode",
  ),
  taxPercent: z.number().min(0).max(100).default(0).describe(
    "Optional tax/GST percentage added to displayed totals",
  ),
  uploadBandwidthMbps: z.number().positive().default(100).describe(
    "Default upload bandwidth in Mbps for transfer-time estimates",
  ),
  transferEfficiency: z.number().min(0.1).max(1).default(0.7).describe(
    "Fraction of nominal bandwidth actually achieved",
  ),
  multipartThresholdBytes: z.number().int().positive().default(100 * MiB)
    .describe("Objects larger than this are assumed to use multipart upload"),
  multipartPartSizeBytes: z.number().int().positive().default(64 * MiB)
    .describe("Assumed multipart part size"),
  multipartObjectFraction: z.number().min(0).max(1).default(0).describe(
    "Fraction of objects that are multipart (0 = ignore part requests)",
  ),
  priceOverrides: z.record(z.string(), z.number()).default({}).describe(
    "Global price overrides (method priceOverrides win)",
  ),
}).strict();

type Source = z.infer<typeof SourceSchema>;
/** Inferred type of the inventory arguments. */
/** Inferred type of the inventory arguments. */
export type InventoryArgs = z.infer<typeof InventoryArgsSchema>;
/** Inferred type of the analysis arguments. */
/** Inferred type of the analysis arguments. */
export type AnalyseArgs = z.infer<typeof AnalyseArgsSchema>;
/** Inferred type of the global arguments. */
/** Inferred type of the global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One source in the recorded inventory and its deduplicated contribution. */
export interface SourceBreakdown {
  name: string;
  kind: string;
  bytes: number;
  objectCount: number;
  dedupedBytes: number;
  duplicateBytes: number;
  downloadPerGb: number;
  fixedCost: number;
  throughputMbps: number | null;
}

/** The recorded source inventory and its derived totals. */
export interface InventoryOutput {
  generatedAt: string;
  sources: SourceBreakdown[];
  totalBytes: number;
  totalObjects: number;
  dedupedBytes: number;
  duplicateBytes: number;
  duplicateFraction: number;
  objectsAfterDedupe: number;
  avgObjectSizeBytes: number;
  annualGrowthPercent: number;
  initialTransferMonths: number;
  smallObjectWarning: string | null;
}

/** Resolved access profile used by the cost simulation. */
export interface AccessProfileOutput {
  name: string;
  label: string;
  restoreFractionPerYear: number;
  restoreTier: RetrievalTier;
  restoreRetentionDays: number;
  extraEgressGbPerMonth: number;
  getRequestsPerMonth: number;
  maxRestoreHours: number;
  assumptions: string[];
}

/** One storage-class stage in a lifecycle plan. */
export interface Stage {
  tier: Tier;
  afterDays: number;
}

/** A candidate storage plan with optional hot/cold split. */
export interface PlanSpec {
  id: string;
  name: string;
  description: string;
  stages: Stage[];
  hotFraction?: number;
  hotTier?: Tier;
  intelligentTieringMode?: "basic" | "archive" | "deep-archive";
  tags: string[];
  valid: boolean;
  issues: string[];
}

/** One month of modelled costs and stored bytes. */
export interface MonthlyCost {
  month: number;
  storage: number;
  uploadRequests: number;
  transitionRequests: number;
  retrieval: number;
  restoreRequests: number;
  staging: number;
  egress: number;
  monitoring: number;
  getRequests: number;
  total: number;
  storedBytes: number;
  bytesByTier: Record<string, number>;
}

/** The simulated cost and access result for one plan. */
export interface PlanResult {
  id: string;
  name: string;
  description: string;
  tags: string[];
  valid: boolean;
  issues: string[];
  meetsAccessRequirement: boolean;
  restoreHours: number;
  dominantTier: Tier;
  intelligentTieringMode?: "basic" | "archive" | "deep-archive";
  firstYearTotal: number;
  totalOverHorizon: number;
  averageMonthly: number;
  averageAnnual: number;
  averageStoredBytes: number;
  bytesByTierAtEnd: Record<string, number>;
  storageCostTotal: number;
  requestCostTotal: number;
  retrievalCostTotal: number;
  stagingCostTotal: number;
  egressCostTotal: number;
  monitoringCostTotal: number;
  oneTimeUploadRequests: number;
  firstYear: {
    storage: number;
    uploadRequests: number;
    transitionRequests: number;
    retrieval: number;
    restoreRequests: number;
    staging: number;
    egress: number;
    monitoring: number;
    getRequests: number;
    total: number;
  };
  monthly: MonthlyCost[];
  warnings: string[];
}

/** Initial-transfer cost, time and per-source detail. */
export interface TransferPlan {
  sourceEgressCost: number;
  sourceFixedCost: number;
  s3IngressCost: number;
  uploadRequestCost: number;
  verificationCost: number;
  totalOneTimeCost: number;
  totalBytes: number;
  totalObjects: number;
  estimatedDays: number;
  snowballRecommended: boolean;
  snowballNote: string;
  sources: {
    name: string;
    kind: string;
    bytes: number;
    objectCount: number;
    downloadPerGb: number;
    downloadCost: number;
    fixedCost: number;
    effectiveMbps: number;
    estimatedDays: number;
  }[];
}

/** One verification step with its cost, time and evidence level. */
export interface VerificationStep {
  name: string;
  what: string;
  costUsd: number;
  time: string;
  confidence: "exact" | "strong" | "weak" | "process";
}

/** Costed strategy for proving the S3 copy is correct. */
export interface VerificationPlan {
  initialPresenceCost: number;
  initialMetadataCost: number;
  checksumComputationCost: number;
  batchOperationsCost: number;
  sampleRestoreBytes: number;
  sampleRestoreCost: number;
  sampleRestoreRetrieval: number;
  sampleRestoreEgress: number;
  sampleRestoreStaging: number;
  fullRestoreCost: number;
  annualVerificationCost: number;
  steps: VerificationStep[];
  warnings: string[];
  confidenceNotes: string[];
}

/** Break-even comparison between a cold plan and a hotter plan. */
export interface BreakEvenRow {
  coldPlan: string;
  hotPlan: string;
  annualStorageSaving: number;
  coldRetrievalPerGb: number;
  hotRetrievalPerGb: number;
  breakEvenBytesPerYear: number | null;
  breakEvenRestoreFractionPerYear: number | null;
  breakEvenRestoreCountPerYear: number | null;
  note: string;
}

/** Estimate of the saving from packing small objects before upload. */
export interface PackingAnalysis {
  recommended: boolean;
  reason: string;
  objectCount: number;
  avgObjectSizeBytes: number;
  packedObjectCount: number;
  annualObjectOverheadCost: number;
  annualPutRequestCost: number;
  packedAnnualObjectOverheadCost: number;
  packedAnnualPutRequestCost: number;
  estimatedAnnualSaving: number;
}

/** The recommended plan and the cheapest plan in each access band. */
export interface Recommendation {
  recommendedPlanId: string | null;
  rationale: string;
  cheapestOverall: string | null;
  cheapestInstant: string | null;
  cheapestWithin12h: string | null;
  cheapestWithin48h: string | null;
}

/** Complete analysis written by the `analyse` method. */
export interface AnalysisOutput {
  generatedAt: string;
  region: string;
  regionLabel: string;
  pricingAsOf: string;
  pricingSources: string[];
  display: {
    currency: "USD" | "AUD";
    taxPercent: number;
    fx: FxInfo | null;
  };
  inventory: InventoryOutput;
  accessProfile: AccessProfileOutput;
  plans: PlanResult[];
  recommendation: Recommendation;
  breakEven: BreakEvenRow[];
  transfer: TransferPlan;
  verification: VerificationPlan;
  packing: PackingAnalysis;
  assumptions: string[];
  warnings: string[];
}

/** Effective pricing catalog written by the `pricing` method. */
export interface PricingOutput {
  region: string;
  regionLabel: string;
  currency: "USD" | "AUD";
  asOf: string;
  fetchedAt: string;
  sources: string[];
  /** Catalog in the selected currency, before per-run overrides. */
  catalog: RegionPricing;
  /** Raw AWS USD catalog, for transparency. */
  catalogUsd: RegionPricing;
  fx: FxInfo | null;
  overrides: Record<string, number>;
  warnings: string[];
}

/** Resolved pricing plus FX metadata used by one analysis run. */
export interface PricingContext {
  catalog: RegionPricing;
  catalogUsd: RegionPricing;
  currency: "USD" | "AUD";
  asOf: string;
  sources: string[];
  fx: FxInfo | null;
  warnings: string[];
  fetchedAt: string;
  handle?: { name: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a byte count as a human-readable binary size. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** Format an amount in the selected currency with sensible precision. */
export function money(value: number, currency: "USD" | "AUD"): string {
  const formatted = usd(value);
  return currency === "AUD" ? formatted.replace("$", "A$") : formatted;
}

/** Format USD with sensible precision. */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `$${
    value.toLocaleString("en-AU", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  }`;
}

/** Format a month index as `Y1-M01` style. */
export function monthLabel(month: number): string {
  const year = Math.floor(month / 12) + 1;
  const m = (month % 12) + 1;
  return `Y${year}-M${String(m).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tierPricePerGbMonth(
  tiers: TieredRate[],
  gb: number,
): number {
  let remaining = Math.max(0, gb);
  let previous = 0;
  let cost = 0;
  for (const tier of tiers) {
    const upper = tier.upToGb ?? Number.POSITIVE_INFINITY;
    const band = Math.max(0, Math.min(remaining, upper - previous));
    cost += band * tier.perGbMonth;
    remaining -= band;
    previous = upper;
    if (remaining <= 0) break;
  }
  return cost;
}

/** Cost of `gb` at a tiered rate. */
export function tieredStorageCost(tiers: TieredRate[], gb: number): number {
  return tierPricePerGbMonth(tiers, gb);
}

function egressCost(pricing: RegionPricing, gb: number): number {
  const billable = Math.max(0, gb - pricing.egress.freeGbPerMonth);
  return tierPricePerGbMonth(pricing.egress.tiers, billable);
}

function retrievalPrice(
  pricing: RegionPricing,
  tier: Tier,
  retrievalTier: RetrievalTier,
): { perGb: number; restoreRequestPer1000: number } {
  if (tier === "INTELLIGENT_TIERING") {
    if (retrievalTier === "expedited") {
      return {
        perGb: pricing.storage.INTELLIGENT_TIERING.retrievalPerGb.expedited ??
          0,
        restoreRequestPer1000:
          pricing.storage.INTELLIGENT_TIERING.restoreRequestPer1000
            .expedited ?? 0,
      };
    }
    return { perGb: 0, restoreRequestPer1000: 0 };
  }
  const price = pricing.storage[tier];
  const allowed: RetrievalTier = tier === "DEEP_ARCHIVE" &&
      retrievalTier === "expedited"
    ? "standard"
    : retrievalTier;
  return {
    perGb: price.retrievalPerGb[allowed] ?? 0,
    restoreRequestPer1000: price.restoreRequestPer1000[allowed] ?? 0,
  };
}

/** Hours until a restore is available, for the plan's dominant class. */
export function restoreHoursFor(
  tier: Tier,
  retrievalTier: RetrievalTier,
  intelligentMode: "basic" | "archive" | "deep-archive" = "deep-archive",
): number {
  switch (tier) {
    case "STANDARD":
    case "STANDARD_IA":
    case "ONEZONE_IA":
    case "GLACIER_IR":
      return 0;
    case "INTELLIGENT_TIERING":
      return intelligentMode === "basic" ? 0 : 12;
    case "GLACIER_FLEXIBLE":
      return retrievalTier === "bulk"
        ? 12
        : retrievalTier === "expedited"
        ? 0.08
        : 5;
    case "DEEP_ARCHIVE":
      return retrievalTier === "bulk" ? 48 : 12;
  }
}

function retrievalTierForPlan(
  tier: Tier,
  requested: RetrievalTier,
): RetrievalTier {
  if (tier === "DEEP_ARCHIVE" && requested === "expedited") return "standard";
  if (
    tier !== "GLACIER_FLEXIBLE" && tier !== "DEEP_ARCHIVE" &&
    tier !== "INTELLIGENT_TIERING"
  ) {
    return "standard";
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Price overrides
// ---------------------------------------------------------------------------

function setPath(target: unknown, path: string, value: number): void {
  const parts = path.split(".");
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error(`priceOverrides: invalid path "${path}"`);
  }
  let current = target as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!(key in current)) {
      throw new Error(
        `priceOverrides: unknown path "${path}" (missing "${key}")`,
      );
    }
    const next = current[key];
    if (typeof next !== "object" || next === null) {
      throw new Error(
        `priceOverrides: "${path}" traverses non-object "${key}"`,
      );
    }
    current = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  if (!(leaf in current)) {
    throw new Error(
      `priceOverrides: unknown path "${path}" (missing "${leaf}")`,
    );
  }
  if (typeof current[leaf] !== "number") {
    throw new Error(
      `priceOverrides: "${path}" is not a numeric price`,
    );
  }
  current[leaf] = value;
}

/** Apply flat `dot.path` overrides to a cloned catalog. */
export function applyPriceOverrides(
  catalog: RegionPricing,
  overrides: Record<string, number>,
): RegionPricing {
  const copy = structuredClone(catalog);
  for (const [path, value] of Object.entries(overrides)) {
    setPath(copy, path, value);
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Parse a count that may be a number or a k/m/b-suffixed string. */
export function parseCount(value: number | string, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a finite non-negative number`);
    }
    return value;
  }
  const raw = value.trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
  if (raw === "") {
    throw new Error(`${field} must not be empty`);
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const match = /^([0-9]+(?:\.[0-9]+)?)([kmb])$/.exec(raw);
  if (!match) {
    throw new Error(
      `Invalid ${field} "${value}": use a number or a string like 450k, 1.2m, 1.2b`,
    );
  }
  const multiplier = match[2] === "k"
    ? 1_000
    : match[2] === "m"
    ? 1_000_000
    : 1_000_000_000;
  return Number(match[1]) * multiplier;
}

/** Validate and normalise an inventory, applying dedupe and growth defaults. */
function buildInventory(
  args: InventoryArgs,
  now = new Date().toISOString(),
): InventoryOutput {
  const avgInput = args.avgObjectSizeBytes === undefined
    ? undefined
    : parseCount(args.avgObjectSizeBytes, "avgObjectSizeBytes");
  const sources = args.sources.map((s) => ({
    ...s,
    bytes: parseCount(s.bytes, `${s.name}.bytes`),
    objectCount: Math.round(
      parseCount(s.objectCount, `${s.name}.objectCount`),
    ),
  }));
  let totalBytes = args.totalBytes === undefined
    ? 0
    : parseCount(args.totalBytes, "totalBytes");
  let totalObjects = args.objectCount === undefined
    ? 0
    : Math.round(parseCount(args.objectCount, "objectCount"));

  if (sources.length === 0) {
    if (totalBytes <= 0 && totalObjects <= 0) {
      throw new Error(
        "No inventory supplied. Provide `sources`, or `totalBytes` plus `objectCount` (or `avgObjectSizeBytes`). " +
          'Example: swamp model method run family-photos inventory --input \'sources:json=[{"name":"NAS","kind":"nas","bytes":"2.5b","objectCount":"800k"}]\'',
      );
    }
    if (totalBytes <= 0 && totalObjects > 0) {
      if (!avgInput) {
        throw new Error(
          "totalBytes is missing; provide totalBytes or avgObjectSizeBytes",
        );
      }
      totalBytes = totalObjects * avgInput;
    }
    if (totalObjects <= 0 && totalBytes > 0) {
      if (!avgInput) {
        throw new Error(
          "objectCount is missing; provide objectCount or avgObjectSizeBytes",
        );
      }
      totalObjects = Math.max(
        1,
        Math.round(totalBytes / avgInput),
      );
    }
  } else {
    totalBytes = sources.reduce((sum, s) => sum + s.bytes, 0);
    totalObjects = sources.reduce((sum, s) => sum + s.objectCount, 0);
    if (totalObjects === 0 && totalBytes > 0) {
      if (!avgInput) {
        throw new Error(
          "Source objectCount is zero; provide avgObjectSizeBytes to estimate objects",
        );
      }
      totalObjects = Math.max(
        1,
        Math.round(totalBytes / avgInput),
      );
    }
    if (totalBytes === 0 && avgInput) {
      totalBytes = totalObjects * avgInput;
    }
  }

  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error("Inventory must have a positive total byte count");
  }
  if (!Number.isFinite(totalObjects) || totalObjects <= 0) {
    throw new Error("Inventory must have a positive object count");
  }

  const sourceDuplicateBytes = sources.reduce(
    (sum, s) => sum + s.bytes * s.duplicateFraction,
    0,
  );
  const sourceDuplicateFraction = totalBytes > 0
    ? sourceDuplicateBytes / totalBytes
    : 0;
  const combinedDuplicateFraction = clamp(
    1 - (1 - sourceDuplicateFraction) * (1 - args.duplicateFraction),
    0,
    1,
  );
  const duplicateBytes = totalBytes * combinedDuplicateFraction;
  const dedupedBytes = totalBytes - duplicateBytes;
  const objectsAfterDedupe = Math.max(
    1,
    totalObjects * (1 - combinedDuplicateFraction),
  );
  const avgObjectSizeBytes = dedupedBytes / objectsAfterDedupe;

  const breakdown: SourceBreakdown[] = sources.map((s) => {
    const deduped = s.bytes * (1 - s.duplicateFraction) *
      (1 - args.duplicateFraction);
    return {
      name: s.name,
      kind: s.kind,
      bytes: s.bytes,
      objectCount: s.objectCount,
      dedupedBytes: deduped,
      duplicateBytes: s.bytes - deduped,
      downloadPerGb: s.downloadPerGb,
      fixedCost: s.fixedCost,
      throughputMbps: s.throughputMbps ?? null,
    };
  });

  const smallObjectWarning = avgObjectSizeBytes < 1 * MiB
    ? `The average object is ${
      humanBytes(avgObjectSizeBytes)
    }. Deep Archive adds 40 KiB of ` +
      "billable metadata per object, so millions of small files cost more than the headline $/GB. " +
      "Consider packing small sidecars/thumbnails into larger archives before upload."
    : null;

  return {
    generatedAt: now,
    sources: breakdown,
    totalBytes,
    totalObjects,
    dedupedBytes,
    duplicateBytes,
    duplicateFraction: combinedDuplicateFraction,
    objectsAfterDedupe,
    avgObjectSizeBytes,
    annualGrowthPercent: args.annualGrowthPercent,
    initialTransferMonths: args.initialTransferMonths,
    smallObjectWarning,
  };
}

// ---------------------------------------------------------------------------
// Access profiles
// ---------------------------------------------------------------------------

const PROFILE_PRESETS: Record<
  Exclude<z.infer<typeof AccessProfileSchema>, "custom">,
  Omit<AccessProfileOutput, "name" | "assumptions" | "maxRestoreHours">
> = {
  cold: {
    label: "Cold archive — 0.1%/year, bulk (48h) retrieval",
    restoreFractionPerYear: 0.001,
    restoreTier: "bulk",
    restoreRetentionDays: 3,
    extraEgressGbPerMonth: 0,
    getRequestsPerMonth: 0,
  },
  occasional: {
    label: "Occasional — 1%/year, standard (12h) retrieval",
    restoreFractionPerYear: 0.01,
    restoreTier: "standard",
    restoreRetentionDays: 3,
    extraEgressGbPerMonth: 0,
    getRequestsPerMonth: 10,
  },
  family: {
    label: "Family browsing — 5%/year, standard (12h) retrieval",
    restoreFractionPerYear: 0.05,
    restoreTier: "standard",
    restoreRetentionDays: 7,
    extraEgressGbPerMonth: 10,
    getRequestsPerMonth: 100,
  },
  frequent: {
    label: "Frequent — 20%/year, standard (12h) retrieval",
    restoreFractionPerYear: 0.2,
    restoreTier: "standard",
    restoreRetentionDays: 7,
    extraEgressGbPerMonth: 50,
    getRequestsPerMonth: 1000,
  },
};

/** Resolve a named access profile plus overrides into concrete assumptions. */
function buildAccessProfile(args: AnalyseArgs): AccessProfileOutput {
  const preset = args.accessProfile === "custom"
    ? PROFILE_PRESETS.occasional
    : PROFILE_PRESETS[args.accessProfile];
  const restoreTier = args.restoreTier ?? preset.restoreTier;
  const profile: AccessProfileOutput = {
    name: args.accessProfile,
    label: args.accessProfile === "custom"
      ? "Custom access profile"
      : preset.label,
    restoreFractionPerYear: args.restoreFractionPerYear ??
      preset.restoreFractionPerYear,
    restoreTier,
    restoreRetentionDays: args.restoreRetentionDays ??
      preset.restoreRetentionDays,
    extraEgressGbPerMonth: args.extraEgressGbPerMonth ??
      preset.extraEgressGbPerMonth,
    getRequestsPerMonth: args.getRequestsPerMonth ??
      preset.getRequestsPerMonth,
    maxRestoreHours: args.maxRestoreHours,
    assumptions: [
      "Restore volume is spread across the classes in proportion to the bytes stored in each class.",
      "Glacier/Deep Archive restores include the retrieval fee, the restore request, and a temporary copy charged at the S3 Standard rate for restoreRetentionDays.",
      "Internet egress is charged after the 100 GB/month free allowance. Disable `egress` when restoring inside the same AWS region.",
      "Restore times are the AWS-published best case: Deep Archive standard 12h / bulk 48h; Glacier Flexible standard 5h / bulk 12h / expedited 1-5min; IR/Standard-IA/Standard are instant.",
    ],
  };
  return profile;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** The built-in plans offered by the planner. */
const PLAN_CATALOG: PlanSpec[] = [
  {
    id: "standard",
    name: "S3 Standard forever",
    description: "Everything stays hot in S3 Standard. The baseline.",
    stages: [{ tier: "STANDARD", afterDays: 0 }],
    tags: ["hot", "instant"],
    valid: true,
    issues: [],
  },
  {
    id: "intelligent-tiering",
    name: "S3 Intelligent-Tiering (archive tiers on)",
    description:
      "Automatic tiering: Frequent, Infrequent, Archive Instant, then Deep Archive Access after 180 days.",
    stages: [{ tier: "INTELLIGENT_TIERING", afterDays: 0 }],
    intelligentTieringMode: "deep-archive",
    tags: ["auto", "cold", "12h"],
    valid: true,
    issues: [],
  },
  {
    id: "intelligent-tiering-basic",
    name: "S3 Intelligent-Tiering (no archive tiers)",
    description:
      "Automatic tiering down to Archive Instant Access; objects stay instantly readable.",
    stages: [{ tier: "INTELLIGENT_TIERING", afterDays: 0 }],
    intelligentTieringMode: "basic",
    tags: ["auto", "instant"],
    valid: true,
    issues: [],
  },
  {
    id: "standard-ia",
    name: "S3 Standard-IA from day 0",
    description:
      "Direct upload to Standard-IA; instant access, 128 KiB minimum.",
    stages: [{ tier: "STANDARD_IA", afterDays: 0 }],
    tags: ["warm", "instant"],
    valid: true,
    issues: [],
  },
  {
    id: "glacier-ir",
    name: "S3 Glacier Instant Retrieval from day 0",
    description: "Direct upload to Glacier IR; instant access, 90-day minimum.",
    stages: [{ tier: "GLACIER_IR", afterDays: 0 }],
    tags: ["cold", "instant"],
    valid: true,
    issues: [],
  },
  {
    id: "glacier-flexible",
    name: "S3 Glacier Flexible Retrieval from day 0",
    description: "Direct upload to Glacier Flexible; restore before reading.",
    stages: [{ tier: "GLACIER_FLEXIBLE", afterDays: 0 }],
    tags: ["archive", "12h"],
    valid: true,
    issues: [],
  },
  {
    id: "deep-archive",
    name: "S3 Glacier Deep Archive from day 0",
    description:
      "Direct upload to Deep Archive; cheapest storage, 12-48h restore, 180-day minimum.",
    stages: [{ tier: "DEEP_ARCHIVE", afterDays: 0 }],
    tags: ["archive", "48h"],
    valid: true,
    issues: [],
  },
  {
    id: "standard-30d-deep-archive",
    name: "Standard 30 days, then Deep Archive",
    description: "A one-month hot window before the archive transition.",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "DEEP_ARCHIVE", afterDays: 30 },
    ],
    tags: ["ladder", "archive"],
    valid: true,
    issues: [],
  },
  {
    id: "standard-180d-deep-archive",
    name: "Standard 180 days, then Deep Archive",
    description: "A six-month hot window before the archive transition.",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "DEEP_ARCHIVE", afterDays: 180 },
    ],
    tags: ["ladder", "archive"],
    valid: true,
    issues: [],
  },
  {
    id: "standard-365d-deep-archive",
    name: "Standard 1 year, then Deep Archive",
    description: "A one-year hot window before the archive transition.",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "DEEP_ARCHIVE", afterDays: 365 },
    ],
    tags: ["ladder", "archive"],
    valid: true,
    issues: [],
  },
  {
    id: "standard-30d-sia-30d-deep-archive",
    name: "Standard 30d -> Standard-IA 30d -> Deep Archive",
    description:
      "A cheap warm month after the hot month, then archive. Respects the 30-day Standard-IA minimum.",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "STANDARD_IA", afterDays: 30 },
      { tier: "DEEP_ARCHIVE", afterDays: 60 },
    ],
    tags: ["ladder", "archive"],
    valid: true,
    issues: [],
  },
  {
    id: "standard-90d-gir-90d-deep-archive",
    name: "Standard 90d -> Glacier IR 90d -> Deep Archive",
    description:
      "Three months instant access, three months Glacier IR, then Deep Archive. Respects both 90-day minimums.",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "GLACIER_IR", afterDays: 90 },
      { tier: "DEEP_ARCHIVE", afterDays: 180 },
    ],
    tags: ["ladder", "archive", "instant-window"],
    valid: true,
    issues: [],
  },
  {
    id: "standard-90d-gfr-90d-deep-archive",
    name: "Standard 90d -> Glacier Flexible 90d -> Deep Archive",
    description:
      "Three months hot, three months Glacier Flexible, then Deep Archive. Respects both 90-day minimums.",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "GLACIER_FLEXIBLE", afterDays: 90 },
      { tier: "DEEP_ARCHIVE", afterDays: 180 },
    ],
    tags: ["ladder", "archive"],
    valid: true,
    issues: [],
  },
  {
    id: "hybrid-10pct-standard-deep-archive",
    name: "10% Standard + 90% Deep Archive",
    description:
      "Keep a 10% hot subset in Standard and archive the remaining 90% directly.",
    stages: [{ tier: "DEEP_ARCHIVE", afterDays: 0 }],
    hotFraction: 0.1,
    hotTier: "STANDARD",
    tags: ["hybrid", "archive"],
    valid: true,
    issues: [],
  },
  {
    id: "hybrid-10pct-sia-deep-archive",
    name: "10% Standard-IA + 90% Deep Archive",
    description:
      "Keep a 10% warm subset in Standard-IA and archive the remaining 90% directly.",
    stages: [{ tier: "DEEP_ARCHIVE", afterDays: 0 }],
    hotFraction: 0.1,
    hotTier: "STANDARD_IA",
    tags: ["hybrid", "archive"],
    valid: true,
    issues: [],
  },
];

/** Validate lifecycle timing against the storage classes' minimum durations. */
export function validatePlan(
  plan: PlanSpec,
  pricing: RegionPricing,
): PlanSpec {
  const issues: string[] = [];
  const stages = [...plan.stages].sort((a, b) => a.afterDays - b.afterDays);
  if (stages.length === 0) {
    issues.push("Plan has no stages");
  }
  if (stages[0] && stages[0].afterDays !== 0) {
    issues.push("The first stage must start at day 0");
  }
  for (let i = 1; i < stages.length; i++) {
    if (stages[i]!.afterDays <= stages[i - 1]!.afterDays) {
      issues.push("Stage transition days must be strictly increasing");
    }
  }
  for (let i = 0; i < stages.length - 1; i++) {
    const current = stages[i]!;
    const next = stages[i + 1]!;
    const minDays = pricing.storage[current.tier].minStorageDays;
    const residence = next.afterDays - current.afterDays;
    if (residence < minDays) {
      issues.push(
        `${
          pricing.storage[current.tier].label
        } has a ${minDays}-day minimum, but the plan leaves after ${residence} days`,
      );
    }
  }
  if (plan.hotFraction !== undefined) {
    if (plan.hotFraction < 0 || plan.hotFraction > 1) {
      issues.push("hotFraction must be between 0 and 1");
    }
    if (!plan.hotTier) {
      issues.push("A hybrid plan needs hotTier");
    } else if (
      !["STANDARD", "STANDARD_IA", "INTELLIGENT_TIERING", "GLACIER_IR"]
        .includes(
          plan.hotTier,
        )
    ) {
      issues.push(
        "hotTier must be STANDARD, STANDARD_IA, INTELLIGENT_TIERING or GLACIER_IR",
      );
    }
  }
  return { ...plan, stages, valid: issues.length === 0, issues };
}

function selectedPlans(
  pricing: RegionPricing,
  planIds?: string[],
): PlanSpec[] {
  const ids = planIds?.length ? new Set(planIds) : null;
  const plans = PLAN_CATALOG.filter((p) => !ids || ids.has(p.id)).map((p) =>
    validatePlan(structuredClone(p), pricing)
  );
  if (ids && plans.length !== ids.size) {
    const found = new Set(plans.map((p) => p.id));
    const missing = [...ids].filter((id) => !found.has(id));
    throw new Error(
      `Unknown plan id(s): ${missing.join(", ")}. Available: ${
        PLAN_CATALOG.map((p) => p.id).join(", ")
      }`,
    );
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface Cohort {
  uploadMonth: number;
  bytes: number;
  objects: number;
}

interface PlanPart {
  bytes: number;
  objects: number;
  stages: Stage[];
}

function makeCohorts(
  inv: InventoryOutput,
  months: number,
): Cohort[] {
  const cohorts: Cohort[] = [];
  const initialMonths = Math.min(inv.initialTransferMonths, months);
  const initialBytesPerMonth = inv.dedupedBytes / initialMonths;
  const initialObjectsPerMonth = inv.objectsAfterDedupe / initialMonths;
  for (let m = 0; m < initialMonths; m++) {
    cohorts.push({
      uploadMonth: m,
      bytes: initialBytesPerMonth,
      objects: initialObjectsPerMonth,
    });
  }
  const g = inv.annualGrowthPercent / 100;
  if (g > 0) {
    for (let m = initialMonths; m < months; m++) {
      const factor = Math.pow(1 + g, m / 12) -
        Math.pow(1 + g, (m - 1) / 12);
      const bytes = inv.dedupedBytes * factor;
      cohorts.push({
        uploadMonth: m,
        bytes,
        objects: bytes / inv.avgObjectSizeBytes,
      });
    }
  }
  return cohorts;
}

function planParts(
  plan: PlanSpec,
  cohort: Cohort,
): PlanPart[] {
  const hot = plan.hotFraction ?? 0;
  if (hot > 0 && plan.hotTier) {
    return [
      {
        bytes: cohort.bytes * hot,
        objects: cohort.objects * hot,
        stages: [{ tier: plan.hotTier, afterDays: 0 }],
      },
      {
        bytes: cohort.bytes * (1 - hot),
        objects: cohort.objects * (1 - hot),
        stages: plan.stages,
      },
    ];
  }
  return [{
    bytes: cohort.bytes,
    objects: cohort.objects,
    stages: plan.stages,
  }];
}

function stageAt(stages: Stage[], ageDays: number): Stage {
  let selected = stages[0]!;
  for (const stage of stages) {
    if (ageDays >= stage.afterDays) selected = stage;
  }
  return selected;
}

function intelligentAccessTier(
  ageDays: number,
  mode: "basic" | "archive" | "deep-archive",
):
  | "FREQUENT"
  | "INFREQUENT"
  | "ARCHIVE_INSTANT"
  | "ARCHIVE_ACCESS"
  | "DEEP_ARCHIVE_ACCESS" {
  if (ageDays < 30) return "FREQUENT";
  if (ageDays < 90) return "INFREQUENT";
  if (mode === "basic") return "ARCHIVE_INSTANT";
  if (ageDays < 180) {
    return mode === "archive" ? "ARCHIVE_ACCESS" : "ARCHIVE_INSTANT";
  }
  return "DEEP_ARCHIVE_ACCESS";
}

function addTier(
  bytesByTier: Record<string, number>,
  objectsByTier: Record<string, number>,
  tier: string,
  bytes: number,
  objects: number,
): void {
  bytesByTier[tier] = (bytesByTier[tier] ?? 0) + bytes;
  objectsByTier[tier] = (objectsByTier[tier] ?? 0) + objects;
}

function storageCostForMonth(
  pricing: RegionPricing,
  bytesByTier: Record<string, number>,
  objectsByTier: Record<string, number>,
  inventory: InventoryOutput,
): { cost: number; monitoring: number } {
  let cost = 0;
  let standardMetadataBytes = 0;
  let standardBytes = 0;

  for (const tier of Object.keys(bytesByTier) as Tier[]) {
    const bytes = bytesByTier[tier] ?? 0;
    const objects = objectsByTier[tier] ?? 0;
    if (bytes <= 0 && objects <= 0) continue;
    if (tier === "INTELLIGENT_TIERING" || tier.startsWith("INT_")) {
      // The caller stores each Intelligent-Tiering access tier under INT_*.
      continue;
    }
    const price = pricing.storage[tier];

    if (price.metadataOverheadBytes > 0) {
      standardMetadataBytes += objects * price.metadataStandardBytes;
      cost += ((bytes + objects * price.metadataOverheadBytes) / GB) *
        price.tiers[0]!.perGbMonth;
    } else if (price.minBillableBytes > 0) {
      const billable = Math.max(bytes, objects * price.minBillableBytes);
      cost += (billable / GB) * price.tiers[0]!.perGbMonth;
    } else if (tier === "STANDARD") {
      standardBytes += bytes;
    } else {
      cost += (bytes / GB) * price.tiers[0]!.perGbMonth;
    }
  }

  // Standard is tiered, and the 8 KiB/object Glacier metadata is charged at
  // the Standard rate.
  const standardTotal = standardBytes + standardMetadataBytes;
  cost += tieredStorageCost(pricing.storage.STANDARD.tiers, standardTotal / GB);

  // Intelligent-Tiering access tiers are synthetic keys. Objects below the
  // monitoring threshold are not auto-tiered and always pay Frequent Access.
  const int = pricing.intelligentTiering;
  const intAllSmall = inventory.avgObjectSizeBytes < int.minMonitoredBytes;
  const intTotal = (bytesByTier.INT_FREQUENT ?? 0) +
    (bytesByTier.INT_INFREQUENT ?? 0) +
    (bytesByTier.INT_ARCHIVE_INSTANT ?? 0) +
    (bytesByTier.INT_ARCHIVE_ACCESS ?? 0) +
    (bytesByTier.INT_DEEP_ARCHIVE_ACCESS ?? 0);
  const intFrequent = intAllSmall ? intTotal : (bytesByTier.INT_FREQUENT ?? 0);
  const intInfrequent = intAllSmall ? 0 : (bytesByTier.INT_INFREQUENT ?? 0);
  const intArchiveInstant = intAllSmall
    ? 0
    : (bytesByTier.INT_ARCHIVE_INSTANT ?? 0);
  const intArchiveAccess = intAllSmall
    ? 0
    : (bytesByTier.INT_ARCHIVE_ACCESS ?? 0);
  const intDeepArchive = intAllSmall
    ? 0
    : (bytesByTier.INT_DEEP_ARCHIVE_ACCESS ?? 0);
  cost += tieredStorageCost(int.frequentTiers, intFrequent / GB);
  cost += (intInfrequent / GB) * int.infrequentPerGbMonth;
  cost += (intArchiveInstant / GB) * int.archiveInstantPerGbMonth;
  cost += (intArchiveAccess / GB) * int.archiveAccessPerGbMonth;
  cost += (intDeepArchive / GB) * int.deepArchiveAccessPerGbMonth;

  // Monitoring/automation: objects >=128 KiB only.
  const intObjects = (objectsByTier.INT_FREQUENT ?? 0) +
    (objectsByTier.INT_INFREQUENT ?? 0) +
    (objectsByTier.INT_ARCHIVE_INSTANT ?? 0) +
    (objectsByTier.INT_ARCHIVE_ACCESS ?? 0) +
    (objectsByTier.INT_DEEP_ARCHIVE_ACCESS ?? 0);
  const monitored = inventory.avgObjectSizeBytes >= int.minMonitoredBytes
    ? intObjects
    : 0;
  const monitoring = (monitored / 1000) * int.monitoringPer1000ObjectsMonth;

  return { cost, monitoring };
}

function intAccessKey(
  tier:
    | "FREQUENT"
    | "INFREQUENT"
    | "ARCHIVE_INSTANT"
    | "ARCHIVE_ACCESS"
    | "DEEP_ARCHIVE_ACCESS",
): string {
  return `INT_${tier}`;
}

/** Simulate storage, request, retrieval and egress costs for one plan. */
function simulatePlan(
  plan: PlanSpec,
  inv: InventoryOutput,
  access: AccessProfileOutput,
  pricing: RegionPricing,
  args: AnalyseArgs,
  global: GlobalArgs,
): PlanResult {
  const months = args.years * 12;
  const cohorts = makeCohorts(inv, months);
  const monthly: MonthlyCost[] = [];
  const warnings: string[] = [...plan.issues];

  if (inv.avgObjectSizeBytes < 1 * MiB) {
    warnings.push(
      "Average object is under 1 MiB: per-object metadata and request costs are significant. Packing small files first can change the ranking.",
    );
  }
  if (plan.stages.some((s) => s.tier === "ONEZONE_IA")) {
    warnings.push(
      "One Zone-IA is single-AZ and not recommended for irreplaceable family archives.",
    );
  }
  if (
    plan.stages[plan.stages.length - 1]!.tier === "DEEP_ARCHIVE" &&
    args.years * 365 < pricing.storage.DEEP_ARCHIVE.minStorageDays
  ) {
    warnings.push(
      "The analysis horizon is shorter than the 180-day Deep Archive minimum; an early deletion fee would apply if you delete at the end.",
    );
  }
  if (plan.id === "standard-30d-deep-archive" || plan.id === "deep-archive") {
    warnings.push(
      "Direct PUT to Deep Archive is cheaper than uploading to Standard and transitioning, but it is one-way and cannot be read without a 12-48h restore.",
    );
  }

  let oneTimeUploadRequests = 0;
  let storageCostTotal = 0;
  let requestCostTotal = 0;
  let retrievalCostTotal = 0;
  let stagingCostTotal = 0;
  let egressCostTotal = 0;
  let monitoringCostTotal = 0;
  let storedBytesSum = 0;

  for (let month = 0; month < months; month++) {
    const bytesByTier: Record<string, number> = {};
    const objectsByTier: Record<string, number> = {};
    let uploadRequests = 0;
    let transitionRequests = 0;
    let retrieval = 0;
    let restoreRequests = 0;
    let staging = 0;
    let egressBytes = 0;
    let storedBytes = 0;

    for (const cohort of cohorts) {
      if (month < cohort.uploadMonth) continue;
      const ageDays = (month - cohort.uploadMonth) * DAYS_PER_MONTH;
      for (const part of planParts(plan, cohort)) {
        if (part.bytes <= 0) continue;
        storedBytes += part.bytes;
        const stage = stageAt(part.stages, ageDays);
        const ageInTier = ageDays - stage.afterDays;

        if (stage.tier === "INTELLIGENT_TIERING") {
          const accessTier = intelligentAccessTier(
            ageInTier,
            plan.intelligentTieringMode ?? "deep-archive",
          );
          addTier(
            bytesByTier,
            objectsByTier,
            intAccessKey(accessTier),
            part.bytes,
            part.objects,
          );
        } else {
          addTier(
            bytesByTier,
            objectsByTier,
            stage.tier,
            part.bytes,
            part.objects,
          );
        }

        // Upload requests happen once, in the cohort's upload month.
        if (month === cohort.uploadMonth) {
          const uploadPrice = pricing.storage[
            part.stages[0]!.tier
          ];
          uploadRequests += (part.objects / 1000) * uploadPrice.putPer1000;
          if (
            global.multipartObjectFraction > 0 &&
            inv.avgObjectSizeBytes > global.multipartThresholdBytes
          ) {
            const parts = Math.ceil(
              inv.avgObjectSizeBytes / global.multipartPartSizeBytes,
            );
            uploadRequests += (part.objects * global.multipartObjectFraction /
              1000) * parts * uploadPrice.multipartPartPer1000;
          }
          if (cohort.uploadMonth < inv.initialTransferMonths) {
            oneTimeUploadRequests += (part.objects / 1000) *
              uploadPrice.putPer1000;
          }
        }

        // Lifecycle transitions: one request per object per destination stage.
        for (let i = 1; i < part.stages.length; i++) {
          const stageSpec = part.stages[i]!;
          const transitionMonth = cohort.uploadMonth +
            Math.ceil(stageSpec.afterDays / DAYS_PER_MONTH);
          if (month === transitionMonth) {
            const dest = pricing.storage[stageSpec.tier];
            transitionRequests += (part.objects / 1000) *
              dest.transitionPer1000;
          }
        }

        // Retrieval/access: allocate restore volume proportionally to stored bytes.
        const restoreBytesMonthly = part.bytes *
          (access.restoreFractionPerYear / 12);
        const tierForRetrieval = stage.tier === "INTELLIGENT_TIERING"
          ? "INTELLIGENT_TIERING"
          : stage.tier;
        const requestedTier = retrievalTierForPlan(
          tierForRetrieval,
          access.restoreTier,
        );
        const price = retrievalPrice(
          pricing,
          tierForRetrieval,
          requestedTier,
        );
        retrieval += (restoreBytesMonthly / GB) * price.perGb;
        if (
          tierForRetrieval === "GLACIER_FLEXIBLE" ||
          tierForRetrieval === "DEEP_ARCHIVE"
        ) {
          retrieval += (restoreBytesMonthly / GB) *
            pricing.glacierRestoreFeePerGb;
        }
        const restoreObjects = restoreBytesMonthly / inv.avgObjectSizeBytes;
        restoreRequests += (restoreObjects / 1000) *
          price.restoreRequestPer1000;
        const needsRestore = pricing.storage[tierForRetrieval].requiresRestore;
        if (needsRestore) {
          staging += (restoreBytesMonthly / GB) *
            (access.restoreRetentionDays / 30) *
            pricing.restoredCopyStoragePerGbMonth;
        }
        if (args.egress) egressBytes += restoreBytesMonthly;
      }
    }

    const storage = storageCostForMonth(
      pricing,
      bytesByTier,
      objectsByTier,
      inv,
    );
    storageCostTotal += storage.cost;
    monitoringCostTotal += storage.monitoring;

    const egressGb = args.egress
      ? egressBytes / GB + access.extraEgressGbPerMonth
      : 0;
    const egress = egressCost(pricing, egressGb);
    egressCostTotal += egress;

    const getRequests = (access.getRequestsPerMonth / 1000) *
      pricing.storage.STANDARD.getPer1000;

    requestCostTotal += uploadRequests + transitionRequests;
    retrievalCostTotal += retrieval;
    stagingCostTotal += staging;

    const total = storage.cost + storage.monitoring + uploadRequests +
      transitionRequests + retrieval + restoreRequests + staging + egress +
      getRequests;

    storedBytesSum += storedBytes;
    monthly.push({
      month,
      storage: storage.cost,
      uploadRequests,
      transitionRequests,
      retrieval,
      restoreRequests,
      staging,
      egress,
      monitoring: storage.monitoring,
      getRequests,
      total,
      storedBytes,
      bytesByTier,
    });
  }

  const firstYearMonths = monthly.slice(0, 12);
  const firstYear = {
    storage: firstYearMonths.reduce((s, m) => s + m.storage, 0),
    uploadRequests: firstYearMonths.reduce((s, m) => s + m.uploadRequests, 0),
    transitionRequests: firstYearMonths.reduce(
      (s, m) => s + m.transitionRequests,
      0,
    ),
    retrieval: firstYearMonths.reduce((s, m) => s + m.retrieval, 0),
    restoreRequests: firstYearMonths.reduce(
      (s, m) => s + m.restoreRequests,
      0,
    ),
    staging: firstYearMonths.reduce((s, m) => s + m.staging, 0),
    egress: firstYearMonths.reduce((s, m) => s + m.egress, 0),
    monitoring: firstYearMonths.reduce((s, m) => s + m.monitoring, 0),
    getRequests: firstYearMonths.reduce((s, m) => s + m.getRequests, 0),
    total: firstYearMonths.reduce((s, m) => s + m.total, 0),
  };

  const totalOverHorizon = monthly.reduce((s, m) => s + m.total, 0);
  const averageStoredBytes = storedBytesSum / months;
  const finalMonth = monthly[monthly.length - 1]!;
  const dominantStage = plan.stages[plan.stages.length - 1]!;
  const dominantTier = plan.hotFraction && plan.hotFraction > 0.5
    ? (plan.hotTier ?? dominantStage.tier)
    : dominantStage.tier;
  const requestedTier = retrievalTierForPlan(
    dominantTier,
    access.restoreTier,
  );
  const restoreHours = Math.max(
    restoreHoursFor(
      dominantTier,
      requestedTier,
      plan.intelligentTieringMode ?? "deep-archive",
    ),
    plan.hotTier
      ? restoreHoursFor(
        plan.hotTier,
        retrievalTierForPlan(plan.hotTier, access.restoreTier),
      )
      : 0,
  );

  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    tags: plan.tags,
    valid: plan.valid,
    issues: plan.issues,
    meetsAccessRequirement: restoreHours <= access.maxRestoreHours,
    restoreHours,
    dominantTier,
    intelligentTieringMode: plan.intelligentTieringMode,
    firstYearTotal: firstYear.total,
    totalOverHorizon,
    averageMonthly: totalOverHorizon / months,
    averageAnnual: totalOverHorizon / args.years,
    averageStoredBytes,
    bytesByTierAtEnd: finalMonth.bytesByTier,
    storageCostTotal,
    requestCostTotal,
    retrievalCostTotal,
    stagingCostTotal,
    egressCostTotal,
    monitoringCostTotal,
    oneTimeUploadRequests,
    firstYear,
    monthly,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

/** Estimate initial transfer cost, source egress and wall-clock time. */
function buildTransferPlan(
  inv: InventoryOutput,
  global: GlobalArgs,
  verification: VerificationPlan,
  plan: PlanResult,
): TransferPlan {
  const uploadRequestCost = plan.oneTimeUploadRequests;

  let sourceEgressCost = 0;
  let sourceFixedCost = 0;
  let estimatedDays = 0;
  const sources = inv.sources.map((s) => {
    const downloadCost = (s.dedupedBytes / GB) * s.downloadPerGb;
    sourceEgressCost += downloadCost;
    sourceFixedCost += s.fixedCost;
    const effectiveMbps = Math.min(
      s.throughputMbps ?? global.uploadBandwidthMbps,
      global.uploadBandwidthMbps,
    );
    const seconds = (s.dedupedBytes * 8) /
      (effectiveMbps * 1_000_000) / global.transferEfficiency;
    const days = seconds / 86_400;
    estimatedDays += days;
    return {
      name: s.name,
      kind: s.kind,
      bytes: s.dedupedBytes,
      objectCount: s.objectCount,
      downloadPerGb: s.downloadPerGb,
      downloadCost,
      fixedCost: s.fixedCost,
      effectiveMbps,
      estimatedDays: days,
    };
  });

  if (sources.length === 0) {
    const effectiveMbps = global.uploadBandwidthMbps;
    const seconds = (inv.dedupedBytes * 8) /
      (effectiveMbps * 1_000_000) / global.transferEfficiency;
    estimatedDays = seconds / 86_400;
  }

  const totalOneTimeCost = sourceEgressCost + sourceFixedCost +
    uploadRequestCost + verification.initialPresenceCost +
    verification.initialMetadataCost +
    verification.checksumComputationCost +
    verification.batchOperationsCost;

  const snowballRecommended = inv.dedupedBytes > 10 * TiB &&
    estimatedDays > 30;

  return {
    sourceEgressCost,
    sourceFixedCost,
    s3IngressCost: 0,
    uploadRequestCost,
    verificationCost: verification.initialPresenceCost +
      verification.initialMetadataCost +
      verification.checksumComputationCost +
      verification.batchOperationsCost,
    totalOneTimeCost,
    totalBytes: inv.dedupedBytes,
    totalObjects: inv.objectsAfterDedupe,
    estimatedDays,
    snowballRecommended,
    snowballNote: snowballRecommended
      ? "At this size and bandwidth, request an AWS Snowball Edge or DataSync quote; shipping a device is usually faster and can be cheaper than months of internet upload."
      : "Internet upload is practical at this size/bandwidth. S3 ingress itself is free; request costs are included above.",
    sources,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Build a costed SHA-256/presence/restore verification strategy. */
function buildVerificationPlan(
  inv: InventoryOutput,
  pricing: RegionPricing,
  args: AnalyseArgs,
  access: AccessProfileOutput,
  plan: PlanResult,
): VerificationPlan {
  const objects = inv.objectsAfterDedupe;
  const bytes = inv.dedupedBytes;
  const tier = plan.dominantTier;
  const retrievalTier = retrievalTierForPlan(tier, "bulk");
  const verificationHours = restoreHoursFor(
    tier,
    retrievalTier,
    plan.intelligentTieringMode ?? "deep-archive",
  );

  const initialPresenceCost = (objects / 1_000_000) *
    pricing.inventoryPerMillionObjects;
  const initialMetadataCost = (objects / 1000) *
    pricing.storage.STANDARD.getPer1000;
  const checksumComputationCost = args.s3ComputesChecksum
    ? (bytes / GB) * pricing.computeChecksumPerGb
    : 0;
  const batchOperationsCost = args.useBatchOperations
    ? pricing.batchOperations.job +
      (objects / 1_000_000) * pricing.batchOperations.perMillionObjects +
      (objects / 1_000_000) * pricing.batchOperations.manifestPerMillionObjects
    : 0;

  const sampleBytes = Math.min(
    bytes,
    Math.max(
      args.verificationSampleMinBytes,
      bytes *
        args.verificationSampleFraction,
    ),
  );
  const sampleObjects = Math.max(1, sampleBytes / inv.avgObjectSizeBytes);
  const billsRestoredCopy = tier === "GLACIER_FLEXIBLE" ||
    tier === "DEEP_ARCHIVE";
  const samplePrice = retrievalPrice(pricing, tier, retrievalTier);
  const sampleRetrieval = (sampleBytes / GB) * samplePrice.perGb +
    (billsRestoredCopy
      ? (sampleBytes / GB) * pricing.glacierRestoreFeePerGb
      : 0);
  const sampleRestoreRequests = (sampleObjects / 1000) *
    samplePrice.restoreRequestPer1000;
  const sampleStaging = billsRestoredCopy
    ? (sampleBytes / GB) * (access.restoreRetentionDays / 30) *
      pricing.restoredCopyStoragePerGbMonth
    : 0;
  const sampleEgress = args.egress ? egressCost(pricing, sampleBytes / GB) : 0;
  const sampleRestoreCost = sampleRetrieval + sampleRestoreRequests +
    sampleStaging + sampleEgress;

  const fullRestorePrice = retrievalPrice(pricing, tier, retrievalTier);
  const fullRestoreCost = (bytes / GB) * fullRestorePrice.perGb +
    (billsRestoredCopy ? (bytes / GB) * pricing.glacierRestoreFeePerGb : 0) +
    (objects / 1000) * fullRestorePrice.restoreRequestPer1000 +
    (billsRestoredCopy
      ? (bytes / GB) * (access.restoreRetentionDays / 30) *
        pricing.restoredCopyStoragePerGbMonth
      : 0) +
    (args.egress ? egressCost(pricing, bytes / GB) : 0);

  const weeklyInventoryCost = 52 * initialPresenceCost;
  const annualVerificationCost = weeklyInventoryCost + initialMetadataCost +
    sampleRestoreCost;

  const steps: VerificationStep[] = [
    {
      name: "Source SHA-256 manifest",
      what:
        "Hash every source file before upload (sha256sum/ddrescue for NAS and optical media; Google Drive's md5Checksum/sha256Checksum where available, otherwise hash after Takeout download). Store key -> size -> SHA-256.",
      costUsd: 0,
      time: `local CPU/disk time for ${humanBytes(bytes)}`,
      confidence: "exact",
    },
    {
      name: "Upload with checksums",
      what:
        "Send x-amz-checksum-sha256 with each PUT (or the equivalent rclone/AWS SDK option) so S3 stores a content checksum on the object. Do not rely on ETag for multipart uploads — it is not the MD5 of the whole object.",
      costUsd: checksumComputationCost,
      time: "same as the upload",
      confidence: "exact",
    },
    {
      name: "Inventory presence reconciliation",
      what:
        "Enable S3 Inventory (daily for the first month, weekly after) and compare the key set, size and storage class against the source manifest. Inventory is asynchronous and does not carry the checksum value; it proves presence, not bytes.",
      costUsd: initialPresenceCost,
      time: "first report usually within 48h",
      confidence: "strong",
    },
    {
      name: "HEAD / metadata checksum pass",
      what:
        "HeadObject every key and compare ContentLength, ChecksumSHA256 and StorageClass with the manifest. HeadObject works for Deep Archive without a restore. If the upload did not store a checksum, this pass is only key+size evidence.",
      costUsd: initialMetadataCost,
      time: `${(objects / 100).toFixed(1)}s at 100 HEAD/s`,
      confidence: "exact",
    },
    {
      name: "Sample restore drill",
      what: `Restore ${humanBytes(sampleBytes)} (${
        Math.round(sampleObjects).toLocaleString()
      } objects) with bulk retrieval, download and compare SHA-256. This is the only step that proves the archive and the restore path actually return the original bytes.`,
      costUsd: sampleRestoreCost,
      time: verificationHours > 0
        ? `${verificationHours}h restore + download time`
        : "download time only",
      confidence: "exact",
    },
    {
      name: "Full recovery drill (optional)",
      what: `Restore the entire ${
        humanBytes(bytes)
      } archive, download it and compare SHA-256. Treat this as a disaster-recovery rehearsal, not a routine check.`,
      costUsd: fullRestoreCost,
      time: verificationHours > 0
        ? `${verificationHours}h restore + multi-day download`
        : "multi-day download",
      confidence: "exact",
    },
  ];

  const warnings = [
    "S3 Inventory is not a checksum proof: it lists keys/sizes/classes, not the stored checksum value.",
    "ETag equals MD5 only for single-part uploads. For multipart uploads, use a full-object checksum or per-part checksums.",
    "Deep Archive objects cannot be read without a restore. Verification must allow 12-48h for the sample drill.",
    "S3 is not a backup by itself: enable versioning and Object Lock (or keep an immutable second copy) to protect against accidental deletion, ransomware and account compromise.",
    "Keep the original NAS/optical copy until the sample restore has passed. Do not delete sources to 'save space' on day one.",
  ];
  if (access.restoreTier === "expedited" && tier === "DEEP_ARCHIVE") {
    warnings.push(
      "Deep Archive does not support expedited retrieval; the verification plan uses standard (12h).",
    );
  }

  return {
    initialPresenceCost,
    initialMetadataCost,
    checksumComputationCost,
    batchOperationsCost,
    sampleRestoreBytes: sampleBytes,
    sampleRestoreCost,
    sampleRestoreRetrieval: sampleRetrieval,
    sampleRestoreEgress: sampleEgress,
    sampleRestoreStaging: sampleStaging,
    fullRestoreCost,
    annualVerificationCost,
    steps,
    warnings,
    confidenceNotes: [
      "exact: SHA-256 of the source bytes matches the checksum stored/returned by S3.",
      "strong: key + size + storage class match; content was not re-read.",
      "weak: key or size only; do not use as the sole duplicate proof.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Break-even and packing
// ---------------------------------------------------------------------------

function tierRetrievalCostPerGb(
  pricing: RegionPricing,
  tier: Tier,
  access: AccessProfileOutput,
  includeEgress: boolean,
): number {
  const retrievalTier = retrievalTierForPlan(tier, access.restoreTier);
  const price = retrievalPrice(pricing, tier, retrievalTier);
  const staging = pricing.storage[tier].requiresRestore
    ? (access.restoreRetentionDays / 30) *
      pricing.restoredCopyStoragePerGbMonth
    : 0;
  const glacierFee = tier === "GLACIER_FLEXIBLE" || tier === "DEEP_ARCHIVE"
    ? pricing.glacierRestoreFeePerGb
    : 0;
  const egress = includeEgress ? pricing.egress.tiers[0]?.perGbMonth ?? 0 : 0;
  return price.perGb + glacierFee + staging + egress;
}

/** Compute break-even restore rates for selected plan pairs. */
function buildBreakEven(
  plans: PlanResult[],
  inv: InventoryOutput,
  pricing: RegionPricing,
  access: AccessProfileOutput,
  args: AnalyseArgs,
): BreakEvenRow[] {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const pairs: [string, string][] = [
    ["deep-archive", "standard"],
    ["deep-archive", "standard-ia"],
    ["deep-archive", "glacier-ir"],
    ["deep-archive", "glacier-flexible"],
    ["glacier-flexible", "standard-ia"],
    ["glacier-ir", "standard-ia"],
  ];
  const rows: BreakEvenRow[] = [];
  for (const [coldId, hotId] of pairs) {
    const cold = byId.get(coldId);
    const hot = byId.get(hotId);
    if (!cold || !hot) continue;
    const annualNonRetrieval = (plan: PlanResult) =>
      (plan.storageCostTotal + plan.requestCostTotal +
        plan.monitoringCostTotal) / args.years;
    const annualSaving = annualNonRetrieval(hot) - annualNonRetrieval(cold);
    const coldRetrieval = tierRetrievalCostPerGb(
      pricing,
      cold.dominantTier,
      access,
      args.egress,
    );
    const hotRetrieval = tierRetrievalCostPerGb(
      pricing,
      hot.dominantTier,
      access,
      args.egress,
    );
    const denominator = coldRetrieval - hotRetrieval;
    const averageBytes = cold.averageStoredBytes;
    let breakEvenBytes: number | null = null;
    if (denominator > 0) {
      // annualSaving is USD/year, denominator is USD/GB, so this is GB/year.
      breakEvenBytes = (annualSaving / denominator) * GB;
    }
    const fraction = breakEvenBytes !== null && averageBytes > 0
      ? breakEvenBytes / averageBytes
      : null;
    const count = breakEvenBytes !== null && inv.avgObjectSizeBytes > 0
      ? breakEvenBytes / inv.avgObjectSizeBytes
      : null;
    let note = "";
    if (annualSaving <= 0) {
      note =
        `${hot.name} is already cheaper in this model; no restore break-even.`;
    } else if (denominator <= 0) {
      note =
        `${cold.name} is cheaper per stored GB and no more expensive per restore; it wins at every access level.`;
    } else if (fraction !== null && fraction > 10) {
      note = `You would need to restore more than ${
        (fraction * 100).toFixed(0)
      }% of the archive every year before ${hot.name} wins.`;
    } else {
      note = `Break-even is restoring ${
        (fraction! * 100).toFixed(1)
      }% of stored bytes per year (${humanBytes(breakEvenBytes!)}/year).`;
    }
    rows.push({
      coldPlan: cold.name,
      hotPlan: hot.name,
      annualStorageSaving: annualSaving,
      coldRetrievalPerGb: coldRetrieval,
      hotRetrievalPerGb: hotRetrieval,
      breakEvenBytesPerYear: breakEvenBytes,
      breakEvenRestoreFractionPerYear: fraction,
      breakEvenRestoreCountPerYear: count,
      note,
    });
  }
  return rows;
}

/** Estimate whether packing small objects repays its staging effort. */
function buildPacking(
  inv: InventoryOutput,
  pricing: RegionPricing,
  plan: PlanResult,
  currency: "USD" | "AUD",
): PackingAnalysis {
  const tier = plan.dominantTier;
  const price = pricing.storage[tier];
  const objectCount = inv.objectsAfterDedupe;
  const packedTargetBytes = 1 * GiB;
  const packedObjectCount = Math.max(
    1,
    Math.ceil(inv.dedupedBytes / packedTargetBytes),
  );

  const monitoringPerObjectYear = tier === "INTELLIGENT_TIERING" &&
      inv.avgObjectSizeBytes >= pricing.intelligentTiering.minMonitoredBytes
    ? (pricing.intelligentTiering.monitoringPer1000ObjectsMonth / 1000) * 12
    : 0;

  const annualObjectOverheadCost = price.metadataOverheadBytes > 0
    ? objectCount *
      ((price.metadataStandardBytes / GB) *
          pricing.storage.STANDARD.tiers[0]!.perGbMonth +
        (price.metadataOverheadBytes / GB) * price.tiers[0]!.perGbMonth) *
      12
    : objectCount * monitoringPerObjectYear;
  const packedAnnualObjectOverheadCost = price.metadataOverheadBytes > 0
    ? packedObjectCount *
      ((price.metadataStandardBytes / GB) *
          pricing.storage.STANDARD.tiers[0]!.perGbMonth +
        (price.metadataOverheadBytes / GB) * price.tiers[0]!.perGbMonth) *
      12
    : packedObjectCount * monitoringPerObjectYear;
  const annualPutRequestCost = (objectCount / 1000) * price.putPer1000;
  const packedAnnualPutRequestCost = (packedObjectCount / 1000) *
    price.putPer1000;
  const estimatedAnnualSaving = (annualObjectOverheadCost -
    packedAnnualObjectOverheadCost) + (annualPutRequestCost -
      packedAnnualPutRequestCost);

  const recommended = inv.avgObjectSizeBytes < 1 * MiB ||
    objectCount > 1_000_000;
  let reason = "";
  if (recommended) {
    reason = `With ${
      Math.round(objectCount).toLocaleString()
    } objects averaging ${
      humanBytes(inv.avgObjectSizeBytes)
    }, per-object metadata and PUT requests are a material cost. Packing small files into ~1 GiB archives cuts object count to about ${packedObjectCount.toLocaleString()} and should save roughly ${
      money(estimatedAnnualSaving, currency)
    }/year in this plan (before extra CPU/staging effort).`;
  } else {
    reason =
      "Object counts and average size are in a range where packing is unlikely to repay the extra staging effort.";
  }

  return {
    recommended,
    reason,
    objectCount,
    avgObjectSizeBytes: inv.avgObjectSizeBytes,
    packedObjectCount,
    annualObjectOverheadCost,
    annualPutRequestCost,
    packedAnnualObjectOverheadCost,
    packedAnnualPutRequestCost,
    estimatedAnnualSaving,
  };
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

function buildRecommendation(
  plans: PlanResult[],
  currency: "USD" | "AUD",
): Recommendation {
  const valid = plans.filter((p) => p.valid);
  const meets = valid.filter((p) => p.meetsAccessRequirement);
  const cheapest = (pool: PlanResult[]): PlanResult | null => {
    if (pool.length === 0) return null;
    return [...pool].sort((a, b) =>
      a.totalOverHorizon - b.totalOverHorizon
    )[0]!;
  };
  const recommended = cheapest(meets) ?? cheapest(
    valid.filter((p) => p.restoreHours <= 12),
  ) ?? cheapest(valid);
  const overall = cheapest(valid);
  const instant = cheapest(valid.filter((p) => p.restoreHours === 0));
  const within12 = cheapest(valid.filter((p) => p.restoreHours <= 12));
  const within48 = cheapest(valid.filter((p) => p.restoreHours <= 48));

  let rationale = "";
  if (recommended) {
    if (recommended.meetsAccessRequirement) {
      rationale =
        `${recommended.name} is the cheapest plan that meets the ${recommended.restoreHours}h restore requirement, at about ${
          money(recommended.averageMonthly, currency)
        }/month on average.`;
    } else {
      rationale =
        `No plan meets the restore-time requirement. The closest cheap option is ${recommended.name} (${recommended.restoreHours}h).`;
    }
  } else {
    rationale = "No valid plans were produced; check the plan definitions.";
  }

  return {
    recommendedPlanId: recommended?.id ?? null,
    rationale,
    cheapestOverall: overall?.id ?? null,
    cheapestInstant: instant?.id ?? null,
    cheapestWithin12h: within12?.id ?? null,
    cheapestWithin48h: within48?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Top-level analysis
// ---------------------------------------------------------------------------

/** Build the complete analysis for an inventory and argument set. */
function buildAnalysis(
  inventory: InventoryOutput,
  args: AnalyseArgs,
  global: GlobalArgs,
  pricingContext?: PricingContext,
  now = new Date().toISOString(),
): AnalysisOutput {
  const access = buildAccessProfile(args);
  const overrides = { ...global.priceOverrides, ...args.priceOverrides };
  const pricing = applyPriceOverrides(
    pricingContext?.catalog ?? getPricing(global.region),
    overrides,
  );
  const currency = pricingContext?.currency ?? "USD";
  const fx = pricingContext?.fx ?? null;
  const pricingAsOf = pricingContext?.asOf ?? pricing.asOf;
  const pricingSources = pricingContext?.sources ?? pricing.source;
  const pricingWarnings = pricingContext?.warnings ?? [];
  const plans = selectedPlans(pricing, args.planIds).map((plan) =>
    simulatePlan(plan, inventory, access, pricing, args, global)
  );
  const recommendation = buildRecommendation(plans, currency);
  const recommendedPlan =
    plans.find((p) => p.id === recommendation.recommendedPlanId) ??
      plans.find((p) => p.id === recommendation.cheapestOverall) ?? plans[0]!;
  const verification = buildVerificationPlan(
    inventory,
    pricing,
    args,
    access,
    recommendedPlan,
  );
  const transfer = buildTransferPlan(
    inventory,
    global,
    verification,
    recommendedPlan,
  );
  const breakEven = buildBreakEven(plans, inventory, pricing, access, args);
  const packing = buildPacking(inventory, pricing, recommendedPlan, currency);

  const pricingNote = fx && !fx.manual
    ? `AWS publishes its Price List API in USD; ${currency} figures are converted live at 1 USD = ${
      money(fx.rate, currency)
    } from ${fx.source} (${fx.asOf}).`
    : fx?.manual
    ? `AWS publishes its Price List API in USD; ${currency} figures use the manual audPerUsd=${fx.rate} override.`
    : currency === "USD"
    ? "Prices are shown in USD, the currency AWS publishes."
    : "No live AUD rate was available, so prices are shown in USD.";
  const warnings = [
    `${pricingNote} Prices exclude GST/tax. Set \`taxPercent=10\` for an Australian GST-inclusive display.`,
    "S3 storage is durable, not a backup strategy by itself: enable versioning + Object Lock and keep an independent copy (NAS or another region/provider) for irreplaceable family media.",
    "Deep Archive is one-way: you cannot lifecycle it back to a hotter class. You must restore and copy the object to move it out.",
    "Request and metadata costs grow with object count, not just bytes. Packing small files before upload can materially change the answer.",
    ...pricingWarnings,
  ];
  if (inventory.smallObjectWarning) warnings.push(inventory.smallObjectWarning);
  if (recommendedPlan.issues.length > 0) {
    warnings.push(
      `The recommended plan has lifecycle issues: ${
        recommendedPlan.issues.join("; ")
      }`,
    );
  }

  return {
    generatedAt: now,
    region: pricing.region,
    regionLabel: pricing.label,
    pricingAsOf,
    pricingSources,
    display: {
      currency,
      taxPercent: global.taxPercent,
      fx,
    },
    inventory,
    accessProfile: access,
    plans,
    recommendation,
    breakEven,
    transfer,
    verification,
    packing,
    assumptions: [
      "Storage is modelled monthly over the horizon; initial data is spread across `initialTransferMonths`, then growth compounds annually.",
      "Average object size is used for every object. If the library has a heavy tail of tiny files, set the average honestly or pack first — per-object minimums and metadata are applied to every object.",
      "S3 Standard and Intelligent-Tiering Frequent Access use the published volume tiers; other classes use the flat rate.",
      "Standard-IA, One Zone-IA and Glacier Instant Retrieval are billed at a 128 KiB minimum per object. Glacier Flexible and Deep Archive add 40 KiB of metadata per object (8 KiB Standard + 32 KiB class).",
      "Lifecycle transitions obey each class's minimum storage duration; a plan that leaves too early is marked invalid.",
      "Restores are allocated proportionally to the bytes stored in each class. Real access is lumpier; use `custom` with a higher restore fraction for a worst-case view.",
      "The initial transfer assumes internet upload; S3 ingress is free. Source egress is charged only when `downloadPerGb` is set.",
      "Verification costs include one inventory report, one HEAD pass, and one sample restore; ongoing weekly inventory and annual sample restores are shown separately.",
      pricingNote,
    ],
    warnings,
  };
}

function unwrapResource<T>(raw: unknown): T | null {
  if (!raw) return null;
  const obj = raw as Record<string, unknown>;
  const content = obj.content ?? obj;
  if (!content || typeof content !== "object") return null;
  return content as T;
}

function inventoryFromArgs(args: InventoryArgs): InventoryOutput {
  return buildInventory(args);
}

function mergeInventoryArgs(
  stored: InventoryOutput | null,
  override: z.infer<typeof InventoryOverrideSchema> | undefined,
): InventoryArgs {
  const base: InventoryArgs = stored
    ? {
      sources: stored.sources.map((s) => ({
        name: s.name,
        kind: s.kind as Source["kind"],
        bytes: s.bytes,
        objectCount: s.objectCount,
        // Reconstruct each source's effective duplicate fraction so rebuilding
        // from the stored inventory reproduces the same deduped total.
        duplicateFraction: s.bytes > 0
          ? Math.max(0, Math.min(1, 1 - s.dedupedBytes / s.bytes))
          : 0,
        downloadPerGb: s.downloadPerGb,
        fixedCost: s.fixedCost,
        throughputMbps: s.throughputMbps ?? undefined,
      })),
      totalBytes: stored.totalBytes,
      objectCount: stored.totalObjects,
      avgObjectSizeBytes: stored.avgObjectSizeBytes,
      duplicateFraction: stored.sources.length === 0
        ? stored.duplicateFraction
        : 0,
      annualGrowthPercent: stored.annualGrowthPercent,
      initialTransferMonths: stored.initialTransferMonths,
    }
    : {
      sources: [],
      duplicateFraction: 0,
      annualGrowthPercent: 5,
      initialTransferMonths: 1,
    };

  const merged: InventoryArgs = { ...base };
  if (override) {
    if (override.sources !== undefined) {
      merged.sources = override.sources;
    } else if (
      override.totalBytes !== undefined || override.objectCount !== undefined
    ) {
      // Totals replace the source list rather than being silently ignored.
      merged.sources = [];
    }
    if (override.totalBytes !== undefined) {
      merged.totalBytes = override.totalBytes;
    }
    if (override.objectCount !== undefined) {
      merged.objectCount = override.objectCount;
    }
    if (override.avgObjectSizeBytes !== undefined) {
      merged.avgObjectSizeBytes = override.avgObjectSizeBytes;
    }
    if (override.duplicateFraction !== undefined) {
      merged.duplicateFraction = override.duplicateFraction;
    }
    if (override.annualGrowthPercent !== undefined) {
      merged.annualGrowthPercent = override.annualGrowthPercent;
    }
    if (override.initialTransferMonths !== undefined) {
      merged.initialTransferMonths = override.initialTransferMonths;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Live pricing resolution and cache
// ---------------------------------------------------------------------------

function isStale(fetchedAt: string | undefined, maxAgeHours: number): boolean {
  if (!fetchedAt) return true;
  const time = Date.parse(fetchedAt);
  if (!Number.isFinite(time)) return true;
  return Date.now() - time > maxAgeHours * 3_600_000;
}

function fxMatchesCache(cached: PricingOutput, global: GlobalArgs): boolean {
  if (global.currency === "usd") return cached.currency === "USD";
  if (global.audPerUsd !== undefined) {
    return cached.currency === "AUD" && cached.fx?.manual === true &&
      cached.fx.rate === global.audPerUsd;
  }
  return cached.currency === "AUD" && cached.fx?.manual !== true;
}

function pricingContextFromOutput(output: PricingOutput): PricingContext {
  return {
    catalog: output.catalog,
    catalogUsd: output.catalogUsd,
    currency: output.currency,
    asOf: output.asOf,
    sources: output.sources,
    fx: output.fx,
    warnings: output.warnings ?? [],
    fetchedAt: output.fetchedAt,
  };
}

function bundledPricingContext(
  global: GlobalArgs,
  warnings: string[],
): PricingContext {
  const base = getPricing(global.region);
  const fx: FxInfo | null = global.currency === "aud" &&
      global.audPerUsd !== undefined
    ? {
      rate: global.audPerUsd,
      source: "manual audPerUsd",
      asOf: new Date().toISOString(),
      manual: true,
    }
    : null;
  if (global.currency === "aud" && !fx) {
    warnings.push(
      "No live AUD rate was available and no audPerUsd override was set; using bundled USD prices rather than a fixed conversion.",
    );
  }
  return {
    catalog: fx ? convertCatalogCurrency(base, fx.rate) : base,
    catalogUsd: base,
    currency: fx ? "AUD" : "USD",
    asOf: base.asOf,
    sources: base.source,
    fx,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

function pricingOutputFromContext(
  context: PricingContext,
  overrides: Record<string, number>,
): PricingOutput {
  const catalog = applyPriceOverrides(context.catalog, overrides);
  return {
    region: catalog.region,
    regionLabel: catalog.label,
    currency: context.currency,
    asOf: context.asOf,
    fetchedAt: context.fetchedAt,
    sources: context.sources,
    catalog,
    catalogUsd: context.currency === "USD" ? catalog : context.catalogUsd,
    fx: context.fx,
    overrides,
    warnings: context.warnings,
  };
}

async function resolvePricing(
  global: GlobalArgs,
  context: MethodContext,
  forceRefresh: boolean,
  fetcher: Fetcher = fetch,
): Promise<PricingContext> {
  const warnings: string[] = [];
  const raw = await context.readResource?.("pricing-cache") ?? null;
  const cached = unwrapResource<PricingOutput>(raw);
  const cacheValid = !!cached &&
    cached.region === global.region &&
    !!cached.catalog && !!cached.catalogUsd && !!cached.fetchedAt &&
    fxMatchesCache(cached, global);
  const shouldFetch = forceRefresh ||
    global.pricingRefresh === "always" ||
    (global.pricingRefresh === "auto" &&
      (!cacheValid || isStale(cached?.fetchedAt, global.pricingMaxAgeHours)));

  if (global.pricingRefresh === "never" || !shouldFetch) {
    if (cacheValid) return pricingContextFromOutput(cached!);
    if (global.pricingRefresh === "never") {
      return bundledPricingContext(global, [
        "pricingRefresh=never and no matching cached pricing was found; using bundled prices.",
      ]);
    }
  }

  try {
    const live: LivePricing = await fetchLivePricing(global.region, fetcher);
    let fx: FxInfo | null = null;
    if (global.currency === "aud") {
      if (global.audPerUsd !== undefined) {
        fx = {
          rate: global.audPerUsd,
          source: "manual audPerUsd",
          asOf: new Date().toISOString(),
          manual: true,
        };
      } else {
        try {
          fx = await fetchFxRate(fetcher);
        } catch (err) {
          warnings.push(
            `${
              err instanceof Error ? err.message : String(err)
            }; trying a cached FX rate instead.`,
          );
          if (cached?.fx) {
            fx = cached.fx;
            warnings.push(
              `Using cached FX from ${cached.fx.source} (${cached.fx.asOf}).`,
            );
          }
        }
      }
    }

    let currency: "USD" | "AUD" = "USD";
    let catalog = live.catalog;
    if (global.currency === "aud" && fx) {
      catalog = convertCatalogCurrency(live.catalog, fx.rate);
      currency = "AUD";
    } else if (global.currency === "aud") {
      warnings.push(
        "No live or cached AUD rate was available; showing USD rather than a fixed conversion.",
      );
    }

    const resolved: PricingContext = {
      catalog,
      catalogUsd: live.catalog,
      currency,
      asOf: live.asOf,
      sources: live.sources,
      fx,
      warnings: [...live.warnings, ...warnings],
      fetchedAt: live.fetchedAt,
    };
    const handle = await context.writeResource(
      "pricingCache",
      "pricing-cache",
      pricingOutputFromContext(resolved, {}),
    );
    return { ...resolved, handle };
  } catch (err) {
    warnings.push(
      `Live pricing fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }.`,
    );
    if (cacheValid) {
      warnings.push(`Using cached pricing from ${cached!.fetchedAt}.`);
      return {
        ...pricingContextFromOutput(cached!),
        warnings: [...cached!.warnings, ...warnings],
      };
    }
    return bundledPricingContext(global, warnings);
  }
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource?: (
    specName: string,
    dataName?: string,
  ) => Promise<unknown | null>;
};

/** Model definition for the S3 photo/video archive planner. */
export const model = {
  type: "@svendowideit/s3-archive-planner",
  version: "2026.10.25.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.25.1",
      description:
        "Initial release: live AWS/FX pricing, k/m/b inventory shorthand, cost/access planning, and transfer/verification plans.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    inventory: {
      description: "Recorded source inventory (bytes, objects, dedupe, growth)",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    analysis: {
      description:
        "Cost, transfer and verification analysis for the recorded inventory",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    pricing: {
      description:
        "Effective selected-currency catalog with overrides, for inspection",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    pricingCache: {
      description:
        "Raw live AWS USD catalog and live USD/AUD rate cache (no per-run overrides)",
      schema: z.unknown(),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    inventory: {
      description:
        "Record what you have: bytes, object count, source mix, cross-source duplicates and expected growth",
      arguments: InventoryArgsSchema,
      execute: async (args: InventoryArgs, context: MethodContext) => {
        const inventory = inventoryFromArgs(args);
        const handle = await context.writeResource(
          "inventory",
          "inventory",
          inventory,
        );
        context.logger?.info(
          "Inventory recorded: {bytes} across {objects} objects ({deduped} after dedupe)",
          {
            bytes: humanBytes(inventory.totalBytes),
            objects: Math.round(inventory.totalObjects).toLocaleString(),
            deduped: humanBytes(inventory.dedupedBytes),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    analyse: {
      description:
        "Compare S3 tier/lifecycle plans for the recorded inventory, including transfer and verification costs",
      arguments: AnalyseArgsSchema,
      execute: async (args: AnalyseArgs, context: MethodContext) => {
        const raw = await context.readResource?.("inventory") ?? null;
        const stored = unwrapResource<InventoryOutput>(raw);
        if (!stored && !args.inventoryOverride) {
          throw new Error(
            "No inventory found. Run `inventory` first, or pass `inventoryOverride` with totals or sources to this call. " +
              'Example: swamp model method run family-photos inventory --input \'sources:json=[{"name":"NAS","kind":"nas","bytes":"2.5b","objectCount":"800k"}]\'',
          );
        }
        const inventory = buildInventory(
          mergeInventoryArgs(stored, args.inventoryOverride),
        );
        const pricingContext = await resolvePricing(
          context.globalArgs,
          context,
          false,
        );
        const analysis = buildAnalysis(
          inventory,
          args,
          context.globalArgs,
          pricingContext,
        );
        const handle = await context.writeResource(
          "analysis",
          "analysis",
          analysis,
        );
        const rec = analysis.plans.find((p) =>
          p.id === analysis.recommendation.recommendedPlanId
        );
        context.logger?.info(
          "Analysis complete: recommended {plan} at {monthly}/month ({currency}); {plans} plans compared",
          {
            plan: rec?.name ?? "none",
            monthly: money(
              rec?.averageMonthly ?? 0,
              analysis.display.currency,
            ),
            currency: analysis.display.currency,
            plans: analysis.plans.length,
          },
        );
        const dataHandles = [handle];
        if (pricingContext.handle) dataHandles.push(pricingContext.handle);
        return { dataHandles };
      },
    },
    pricing: {
      description:
        "Show the effective bundled AWS pricing for the configured region, with any overrides applied",
      arguments: PricingArgsSchema,
      execute: async (
        args: z.infer<typeof PricingArgsSchema>,
        context: MethodContext,
      ) => {
        const pricingContext = await resolvePricing(
          context.globalArgs,
          context,
          args.refresh,
        );
        const overrides = {
          ...context.globalArgs.priceOverrides,
          ...args.priceOverrides,
        };
        const output = pricingOutputFromContext(pricingContext, overrides);
        const handle = await context.writeResource(
          "pricing",
          "pricing",
          output,
        );
        context.logger?.info(
          "Pricing: {region} in {currency} as of {asOf}; fetched {fetchedAt}; {count} overrides applied",
          {
            region: output.regionLabel,
            currency: output.currency,
            asOf: output.asOf,
            fetchedAt: output.fetchedAt,
            count: Object.keys(overrides).length,
          },
        );
        const dataHandles = [handle];
        if (pricingContext.handle) dataHandles.push(pricingContext.handle);
        return { dataHandles };
      },
    },
  },
  reports: ["@svendowideit/s3-archive-report"],
};

/** Exported for tests and for other extensions that want the same model. */
export {
  buildAccessProfile,
  buildAnalysis,
  buildBreakEven,
  buildInventory,
  buildPacking,
  buildTransferPlan,
  buildVerificationPlan,
  PLAN_CATALOG,
  simulatePlan,
};
