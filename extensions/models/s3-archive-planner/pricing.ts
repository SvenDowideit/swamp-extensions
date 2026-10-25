/**
 * Bundled fallback Amazon S3 pricing for the Australian regions.
 *
 * `live_pricing.ts` fetches current prices from AWS at run time. This module
 * supplies defaults for any field the live documents do not publish, and for
 * offline or `pricingRefresh=never` runs.
 *
 * Values are in USD, taken from the public AWS Price List API:
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/<region>/index.json
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3GlacierDeepArchive/current/<region>/index.json
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/<region>/index.json
 *
 * Sydney (`ap-southeast-2`) and Melbourne (`ap-southeast-4`) currently publish
 * the same S3 storage, request and retrieval rates, so one base catalog is
 * cloned for both regions. Refresh the numbers by re-reading the URLs above and
 * editing this module, or override individual values at run time with the
 * model's `priceOverrides` argument.
 *
 * @module
 */

/** Storage class identifiers used by this extension. */
export type Tier =
  | "STANDARD"
  | "STANDARD_IA"
  | "ONEZONE_IA"
  | "INTELLIGENT_TIERING"
  | "GLACIER_IR"
  | "GLACIER_FLEXIBLE"
  | "DEEP_ARCHIVE";

/** S3 Intelligent-Tiering access tiers. */
export type AccessTier =
  | "FREQUENT"
  | "INFREQUENT"
  | "ARCHIVE_INSTANT"
  | "ARCHIVE_ACCESS"
  | "DEEP_ARCHIVE_ACCESS";

/** Retrieval speed for classes that need a restore operation. */
export type RetrievalTier = "bulk" | "standard" | "expedited";

/** A storage price band. `upToGb: null` means "no upper bound". */
export interface TieredRate {
  upToGb: number | null;
  perGbMonth: number;
}

/** One storage class's prices and behaviour. */
export interface StorageClassPrice {
  label: string;
  tiers: TieredRate[];
  /** Minimum bytes billed per object (0 = no minimum). */
  minBillableBytes: number;
  /** Minimum storage duration before deletion/transition is free. */
  minStorageDays: number;
  /** Extra bytes added per object, charged at this class's rate. */
  metadataOverheadBytes: number;
  /** Extra bytes added per object, charged at the S3 Standard rate. */
  metadataStandardBytes: number;
  /** PUT/COPY/POST request price per 1,000 requests. */
  putPer1000: number;
  /** GET and other request price per 1,000 requests. */
  getPer1000: number;
  /** Lifecycle transition price per 1,000 objects. */
  transitionPer1000: number;
  /** Multipart UploadPart request price per 1,000 parts. */
  multipartPartPer1000: number;
  /** Retrieval price per GB, by retrieval speed. */
  retrievalPerGb: Partial<Record<RetrievalTier, number>>;
  /** Restore request price per 1,000 requests, by retrieval speed. */
  restoreRequestPer1000: Partial<Record<RetrievalTier, number>>;
  /** Whether reading the data requires a RestoreObject request. */
  requiresRestore: boolean;
}

/** S3 Intelligent-Tiering access-tier prices. */
export interface IntelligentTieringPrice {
  /** Frequent Access uses the same tiered price as S3 Standard. */
  frequentTiers: TieredRate[];
  infrequentPerGbMonth: number;
  archiveInstantPerGbMonth: number;
  archiveAccessPerGbMonth: number;
  deepArchiveAccessPerGbMonth: number;
  /** Per-object monitoring/automation fee. */
  monitoringPer1000ObjectsMonth: number;
  /** Objects smaller than this are not monitored and stay in Frequent Access. */
  minMonitoredBytes: number;
}

/** Complete pricing catalog for one region. */
export interface RegionPricing {
  region: string;
  label: string;
  asOf: string;
  source: string[];
  storage: Record<Tier, StorageClassPrice>;
  intelligentTiering: IntelligentTieringPrice;
  inventoryPerMillionObjects: number;
  batchOperations: {
    job: number;
    perMillionObjects: number;
    manifestPerMillionObjects: number;
  };
  computeChecksumPerGb: number;
  restoredCopyStoragePerGbMonth: number;
  /** Per-GB Glacier restore fee charged in addition to the retrieval fee. */
  glacierRestoreFeePerGb: number;
  egress: {
    freeGbPerMonth: number;
    tiers: TieredRate[];
  };
}

export const AU_REGIONS = ["ap-southeast-2", "ap-southeast-4"] as const;
export type AuRegion = (typeof AU_REGIONS)[number];

const STANDARD_TIERS: TieredRate[] = [
  { upToGb: 51_200, perGbMonth: 0.025 },
  { upToGb: 512_000, perGbMonth: 0.024 },
  { upToGb: null, perGbMonth: 0.023 },
];

const FLAT = (perGbMonth: number): TieredRate[] => [
  { upToGb: null, perGbMonth },
];

const EGRESS_TIERS: TieredRate[] = [
  { upToGb: 10_240, perGbMonth: 0.114 },
  { upToGb: 51_200, perGbMonth: 0.098 },
  { upToGb: 153_600, perGbMonth: 0.094 },
  { upToGb: null, perGbMonth: 0.092 },
];

function storage(
  label: string,
  tiers: TieredRate[],
  opts: {
    minBillableBytes?: number;
    minStorageDays?: number;
    metadataOverheadBytes?: number;
    metadataStandardBytes?: number;
    putPer1000: number;
    getPer1000: number;
    transitionPer1000: number;
    multipartPartPer1000: number;
    retrievalPerGb?: Partial<Record<RetrievalTier, number>>;
    restoreRequestPer1000?: Partial<Record<RetrievalTier, number>>;
    requiresRestore?: boolean;
  },
): StorageClassPrice {
  return {
    label,
    tiers,
    minBillableBytes: opts.minBillableBytes ?? 0,
    minStorageDays: opts.minStorageDays ?? 0,
    metadataOverheadBytes: opts.metadataOverheadBytes ?? 0,
    metadataStandardBytes: opts.metadataStandardBytes ?? 0,
    putPer1000: opts.putPer1000,
    getPer1000: opts.getPer1000,
    transitionPer1000: opts.transitionPer1000,
    multipartPartPer1000: opts.multipartPartPer1000,
    retrievalPerGb: opts.retrievalPerGb ?? {},
    restoreRequestPer1000: opts.restoreRequestPer1000 ?? {},
    requiresRestore: opts.requiresRestore ?? false,
  };
}

function baseCatalog(region: AuRegion, label: string): RegionPricing {
  return {
    region,
    label,
    asOf: "2026-10-15",
    source: [
      `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/${region}/index.json`,
      `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3GlacierDeepArchive/current/${region}/index.json`,
      `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/${region}/index.json`,
    ],
    storage: {
      STANDARD: storage("S3 Standard", STANDARD_TIERS, {
        putPer1000: 0.0055,
        getPer1000: 0.00044,
        transitionPer1000: 0,
        multipartPartPer1000: 0.0055,
      }),
      STANDARD_IA: storage("S3 Standard-IA", FLAT(0.0138), {
        minBillableBytes: 128 * 1024,
        minStorageDays: 30,
        putPer1000: 0.01,
        getPer1000: 0.001,
        transitionPer1000: 0.01,
        multipartPartPer1000: 0.01,
        retrievalPerGb: { standard: 0.01 },
      }),
      ONEZONE_IA: storage("S3 One Zone-IA", FLAT(0.011), {
        minBillableBytes: 128 * 1024,
        minStorageDays: 30,
        putPer1000: 0.01,
        getPer1000: 0.001,
        transitionPer1000: 0.01,
        multipartPartPer1000: 0.01,
        retrievalPerGb: { standard: 0.01 },
      }),
      INTELLIGENT_TIERING: storage(
        "S3 Intelligent-Tiering",
        STANDARD_TIERS,
        {
          putPer1000: 0.0055,
          getPer1000: 0.00044,
          transitionPer1000: 0.01,
          multipartPartPer1000: 0.0055,
          retrievalPerGb: { standard: 0, bulk: 0, expedited: 0.036 },
          restoreRequestPer1000: { standard: 0, bulk: 0, expedited: 0.012 },
          requiresRestore: true,
        },
      ),
      GLACIER_IR: storage("S3 Glacier Instant Retrieval", FLAT(0.005), {
        minBillableBytes: 128 * 1024,
        minStorageDays: 90,
        putPer1000: 0.02,
        getPer1000: 0.01,
        transitionPer1000: 0.02,
        multipartPartPer1000: 0.02,
        retrievalPerGb: { standard: 0.03 },
      }),
      GLACIER_FLEXIBLE: storage(
        "S3 Glacier Flexible Retrieval",
        FLAT(0.0045),
        {
          minStorageDays: 90,
          metadataOverheadBytes: 32 * 1024,
          metadataStandardBytes: 8 * 1024,
          putPer1000: 0.036,
          getPer1000: 0.00044,
          transitionPer1000: 0.036,
          multipartPartPer1000: 0.0055,
          retrievalPerGb: {
            standard: 0.012,
            bulk: 0,
            expedited: 0.036,
          },
          restoreRequestPer1000: {
            standard: 0.06,
            bulk: 0,
            expedited: 12,
          },
          requiresRestore: true,
        },
      ),
      DEEP_ARCHIVE: storage("S3 Glacier Deep Archive", FLAT(0.002), {
        minStorageDays: 180,
        metadataOverheadBytes: 32 * 1024,
        metadataStandardBytes: 8 * 1024,
        putPer1000: 0.06,
        getPer1000: 0.00044,
        transitionPer1000: 0.06,
        multipartPartPer1000: 0.0055,
        retrievalPerGb: { standard: 0.024, bulk: 0.005 },
        restoreRequestPer1000: { standard: 0.12, bulk: 0.03 },
        requiresRestore: true,
      }),
    },
    intelligentTiering: {
      frequentTiers: STANDARD_TIERS,
      infrequentPerGbMonth: 0.0138,
      archiveInstantPerGbMonth: 0.005,
      archiveAccessPerGbMonth: 0.0045,
      deepArchiveAccessPerGbMonth: 0.002,
      monitoringPer1000ObjectsMonth: 0.0025,
      minMonitoredBytes: 128 * 1024,
    },
    inventoryPerMillionObjects: 0.0028,
    batchOperations: {
      job: 0.25,
      perMillionObjects: 1.0,
      manifestPerMillionObjects: 0.015,
    },
    computeChecksumPerGb: 0.004,
    restoredCopyStoragePerGbMonth: 0.025,
    glacierRestoreFeePerGb: 0.008,
    egress: {
      freeGbPerMonth: 100,
      tiers: EGRESS_TIERS,
    },
  };
}

/** Return a fresh copy of the bundled catalog for a region. */
export function getPricing(region: AuRegion): RegionPricing {
  const label = region === "ap-southeast-2"
    ? "Asia Pacific (Sydney)"
    : "Asia Pacific (Melbourne)";
  return baseCatalog(region, label);
}

/** All bundled catalogs, keyed by region. */
export function allPricing(): Record<AuRegion, RegionPricing> {
  return {
    "ap-southeast-2": getPricing("ap-southeast-2"),
    "ap-southeast-4": getPricing("ap-southeast-4"),
  };
}
