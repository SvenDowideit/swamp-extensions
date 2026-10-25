/**
 * Live Amazon S3 pricing and USD/AUD exchange-rate fetching.
 *
 * AWS's Price List API publishes prices in USD only — there is no AUD price
 * list for the `aws` partition. To show AUD we therefore fetch the live AWS USD
 * catalog and a live USD/AUD rate from a public FX source, then convert every
 * monetary field. The source, rate and date are carried through to the report;
 * no fixed exchange rate is compiled into the extension.
 *
 * The parser starts from the bundled catalog and only replaces fields it can
 * find in the live documents. If AWS changes a usage type, the bundled value is
 * retained and a warning is recorded rather than silently costing the wrong
 * number.
 *
 * @module
 */
import { type AuRegion, getPricing, type RegionPricing } from "./pricing.ts";

/** A fetch-compatible function, injectable for tests. */
export type Fetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** A live USD/AUD rate and where it came from. */
export interface FxInfo {
  rate: number;
  source: string;
  asOf: string;
  manual: boolean;
}

/** Result of a live AWS catalog fetch. */
export interface LivePricing {
  catalog: RegionPricing;
  asOf: string;
  sources: string[];
  fetchedAt: string;
  warnings: string[];
}

interface RawDimension {
  unit?: string;
  beginRange?: string;
  endRange?: string;
  description?: string;
  pricePerUnit?: Record<string, string>;
}

interface RawProduct {
  attributes?: Record<string, string>;
}

interface RawDoc {
  publicationDate?: string;
  products?: Record<string, RawProduct>;
  terms?: {
    OnDemand?: Record<
      string,
      Record<string, { priceDimensions?: Record<string, RawDimension> }>
    >;
  };
}

interface PriceDimension {
  usd: number;
  unit: string;
  begin: number;
  end: number | null;
  description: string;
}

interface LiveTier {
  upToGb: number | null;
  perGbMonth: number;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { "user-agent": "swamp-s3-archive-planner/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return await response.json();
}

function productEntries(
  doc: RawDoc,
): { sku: string; attributes: Record<string, string> }[] {
  return Object.entries(doc.products ?? {}).map(([sku, product]) => ({
    sku,
    attributes: product.attributes ?? {},
  }));
}

function dimensions(doc: RawDoc, sku: string): PriceDimension[] {
  const out: PriceDimension[] = [];
  const terms = doc.terms?.OnDemand?.[sku] ?? {};
  for (const offer of Object.values(terms)) {
    for (const dim of Object.values(offer.priceDimensions ?? {})) {
      const usd = Number(dim.pricePerUnit?.USD);
      if (!Number.isFinite(usd)) continue;
      const end = dim.endRange === "Inf" ? null : Number(dim.endRange ?? 0);
      out.push({
        usd,
        unit: String(dim.unit ?? ""),
        begin: Number(dim.beginRange ?? 0),
        end: Number.isFinite(end as number) ? (end as number) : null,
        description: String(dim.description ?? ""),
      });
    }
  }
  return out.sort((a, b) => a.begin - b.begin);
}

function firstPrice(
  doc: RawDoc,
  predicate: (attributes: Record<string, string>) => boolean,
  unit?: string,
): number | null {
  for (const { sku, attributes } of productEntries(doc)) {
    if (!predicate(attributes)) continue;
    const dims = dimensions(doc, sku).filter((d) => !unit || d.unit === unit);
    if (dims.length > 0) return dims[0]!.usd;
  }
  return null;
}

function tiersFor(
  doc: RawDoc,
  predicate: (attributes: Record<string, string>) => boolean,
  unit = "GB-Mo",
): LiveTier[] | null {
  for (const { sku, attributes } of productEntries(doc)) {
    if (!predicate(attributes)) continue;
    const dims = dimensions(doc, sku).filter((d) => d.unit === unit);
    if (dims.length === 0) continue;
    return dims.map((d) => ({ upToGb: d.end, perGbMonth: d.usd }));
  }
  return null;
}

function ut(attributes: Record<string, string>): string {
  return attributes.usagetype ?? "";
}

function requestPer1000(
  doc: RawDoc,
  predicate: (attributes: Record<string, string>) => boolean,
): number | null {
  const perRequest = firstPrice(doc, predicate, "Requests");
  return perRequest === null ? null : perRequest * 1000;
}

function perMillionObjects(
  doc: RawDoc,
  predicate: (attributes: Record<string, string>) => boolean,
): number | null {
  const perObject = firstPrice(doc, predicate, "Objects");
  return perObject === null ? null : perObject * 1_000_000;
}

function setTiers(
  target: LiveTier[] | null,
  apply: (tiers: LiveTier[]) => void,
  label: string,
  warnings: string[],
): void {
  if (target && target.length > 0) apply(target);
  else {warnings.push(
      `AWS price list did not publish ${label}; using bundled value`,
    );}
}

function setNumber(
  value: number | null,
  apply: (value: number) => void,
  label: string,
  warnings: string[],
): void {
  if (value !== null && Number.isFinite(value)) apply(value);
  else {warnings.push(
      `AWS price list did not publish ${label}; using bundled value`,
    );}
}

function applyS3(
  catalog: RegionPricing,
  doc: RawDoc,
  warnings: string[],
): void {
  const storageSuffix = (suffix: string) => (a: Record<string, string>) =>
    ut(a).endsWith(suffix);

  setTiers(
    tiersFor(doc, (a) =>
      ut(a).endsWith("-TimedStorage-ByteHrs") &&
      a.storageClass === "General Purpose" && a.volumeType === "Standard"),
    (t) => {
      catalog.storage.STANDARD.tiers = t;
    },
    "S3 Standard storage",
    warnings,
  );
  setTiers(
    tiersFor(doc, storageSuffix("-TimedStorage-SIA-ByteHrs")),
    (t) => {
      catalog.storage.STANDARD_IA.tiers = t;
    },
    "S3 Standard-IA storage",
    warnings,
  );
  setTiers(
    tiersFor(doc, storageSuffix("-TimedStorage-ZIA-ByteHrs")),
    (t) => {
      catalog.storage.ONEZONE_IA.tiers = t;
    },
    "S3 One Zone-IA storage",
    warnings,
  );
  setTiers(
    tiersFor(doc, storageSuffix("-TimedStorage-GIR-ByteHrs")),
    (t) => {
      catalog.storage.GLACIER_IR.tiers = t;
    },
    "S3 Glacier Instant Retrieval storage",
    warnings,
  );
  setTiers(
    tiersFor(doc, storageSuffix("-TimedStorage-GlacierByteHrs")),
    (t) => {
      catalog.storage.GLACIER_FLEXIBLE.tiers = t;
    },
    "S3 Glacier Flexible Retrieval storage",
    warnings,
  );

  const intFrequent = tiersFor(
    doc,
    storageSuffix("-TimedStorage-INT-FA-ByteHrs"),
  );
  setTiers(
    intFrequent,
    (t) => {
      catalog.storage.INTELLIGENT_TIERING.tiers = t;
      catalog.intelligentTiering.frequentTiers = t;
    },
    "S3 Intelligent-Tiering Frequent Access storage",
    warnings,
  );
  const int = catalog.intelligentTiering;
  setNumber(
    firstPrice(doc, storageSuffix("-TimedStorage-INT-IA-ByteHrs"), "GB-Mo"),
    (v) => {
      int.infrequentPerGbMonth = v;
    },
    "S3 Intelligent-Tiering Infrequent Access storage",
    warnings,
  );
  setNumber(
    firstPrice(doc, storageSuffix("-TimedStorage-INT-AIA-ByteHrs"), "GB-Mo"),
    (v) => {
      int.archiveInstantPerGbMonth = v;
    },
    "S3 Intelligent-Tiering Archive Instant storage",
    warnings,
  );
  setNumber(
    firstPrice(doc, storageSuffix("-TimedStorage-INT-AA-ByteHrs"), "GB-Mo"),
    (v) => {
      int.archiveAccessPerGbMonth = v;
    },
    "S3 Intelligent-Tiering Archive Access storage",
    warnings,
  );
  setNumber(
    firstPrice(doc, storageSuffix("-TimedStorage-INT-DAA-ByteHrs"), "GB-Mo"),
    (v) => {
      int.deepArchiveAccessPerGbMonth = v;
    },
    "S3 Intelligent-Tiering Deep Archive Access storage",
    warnings,
  );
  const monitoring = firstPrice(
    doc,
    storageSuffix("-Monitoring-Automation-INT"),
    "Objects",
  );
  setNumber(
    monitoring === null ? null : monitoring * 1000,
    (v) => {
      int.monitoringPer1000ObjectsMonth = v;
    },
    "S3 Intelligent-Tiering monitoring fee",
    warnings,
  );

  // Request prices, converted from per-request to per-1,000.
  const req = (
    suffix: string,
    op?: string,
  ) =>
    requestPer1000(
      doc,
      (a) =>
        ut(a).endsWith(suffix) &&
        (op === undefined || (a.operation ?? "") === op),
    );

  setNumber(
    req("-Requests-Tier1"),
    (v) => {
      catalog.storage.STANDARD.putPer1000 = v;
    },
    "S3 Standard PUT requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier2"),
    (v) => {
      catalog.storage.STANDARD.getPer1000 = v;
    },
    "S3 Standard GET requests",
    warnings,
  );
  setNumber(
    req("-Requests-SIA-Tier1"),
    (v) => {
      catalog.storage.STANDARD_IA.putPer1000 = v;
    },
    "Standard-IA PUT requests",
    warnings,
  );
  setNumber(
    req("-Requests-SIA-Tier2"),
    (v) => {
      catalog.storage.STANDARD_IA.getPer1000 = v;
    },
    "Standard-IA GET requests",
    warnings,
  );
  setNumber(
    req("-Requests-ZIA-Tier1"),
    (v) => {
      catalog.storage.ONEZONE_IA.putPer1000 = v;
    },
    "One Zone-IA PUT requests",
    warnings,
  );
  setNumber(
    req("-Requests-ZIA-Tier2"),
    (v) => {
      catalog.storage.ONEZONE_IA.getPer1000 = v;
    },
    "One Zone-IA GET requests",
    warnings,
  );
  setNumber(
    req("-Requests-GIR-Tier1"),
    (v) => {
      catalog.storage.GLACIER_IR.putPer1000 = v;
    },
    "Glacier IR PUT requests",
    warnings,
  );
  setNumber(
    req("-Requests-GIR-Tier2"),
    (v) => {
      catalog.storage.GLACIER_IR.getPer1000 = v;
    },
    "Glacier IR GET requests",
    warnings,
  );
  setNumber(
    req("-Requests-GLACIER-Tier1", "PutObject"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.putPer1000 = v;
    },
    "Glacier Flexible PUT requests",
    warnings,
  );
  setNumber(
    req("-Requests-GLACIER-Tier2"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.getPer1000 = v;
    },
    "Glacier Flexible GET requests",
    warnings,
  );
  setNumber(
    req("-Requests-GLACIER-Tier1", "UploadPart"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.multipartPartPer1000 = v;
    },
    "Glacier Flexible multipart requests",
    warnings,
  );
  setNumber(
    req("-Requests-INT-Tier1"),
    (v) => {
      catalog.storage.INTELLIGENT_TIERING.putPer1000 = v;
    },
    "Intelligent-Tiering PUT requests",
    warnings,
  );
  setNumber(
    req("-Requests-INT-Tier2"),
    (v) => {
      catalog.storage.INTELLIGENT_TIERING.getPer1000 = v;
    },
    "Intelligent-Tiering GET requests",
    warnings,
  );

  // Lifecycle transitions (per destination class).
  setNumber(
    req("-Requests-Tier4", "S3-SIATransition"),
    (v) => {
      catalog.storage.STANDARD_IA.transitionPer1000 = v;
    },
    "Standard-IA transition requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier4", "S3-ZIATransition"),
    (v) => {
      catalog.storage.ONEZONE_IA.transitionPer1000 = v;
    },
    "One Zone-IA transition requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier4", "S3-GIRTransition"),
    (v) => {
      catalog.storage.GLACIER_IR.transitionPer1000 = v;
    },
    "Glacier IR transition requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier3", "S3-GlacierTransition"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.transitionPer1000 = v;
    },
    "Glacier Flexible transition requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier3", "S3-GDATransition"),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.transitionPer1000 = v;
    },
    "Deep Archive transition requests",
    warnings,
  );
  setNumber(
    req("-Requests-GDA-Tier2"),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.getPer1000 = v;
    },
    "Deep Archive GET requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier4", "S3-INTTransition"),
    (v) => {
      catalog.storage.INTELLIGENT_TIERING.transitionPer1000 = v;
    },
    "Intelligent-Tiering transition requests",
    warnings,
  );

  // Restore request prices.
  setNumber(
    req("-Requests-Tier3", "RestoreObject"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.restoreRequestPer1000.standard = v;
    },
    "Glacier Flexible standard restore requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier5"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.restoreRequestPer1000.bulk = v;
    },
    "Glacier Flexible bulk restore requests",
    warnings,
  );
  setNumber(
    req("-Requests-Tier6"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.restoreRequestPer1000.expedited = v;
    },
    "Glacier Flexible expedited restore requests",
    warnings,
  );
  setNumber(
    req("-Requests-INT-Tier6", "RestoreObjectExpedited"),
    (v) => {
      catalog.storage.INTELLIGENT_TIERING.restoreRequestPer1000.expedited = v;
    },
    "Intelligent-Tiering expedited restore requests",
    warnings,
  );

  // Retrieval fees per GB.
  const ret = (suffix: string, op?: string) =>
    firstPrice(
      doc,
      (a) =>
        ut(a).endsWith(suffix) &&
        (op === undefined || (a.operation ?? "") === op),
      "GB",
    );
  setNumber(
    ret("-Retrieval-SIA"),
    (v) => {
      catalog.storage.STANDARD_IA.retrievalPerGb.standard = v;
    },
    "Standard-IA retrieval fee",
    warnings,
  );
  setNumber(
    ret("-Retrieval-ZIA"),
    (v) => {
      catalog.storage.ONEZONE_IA.retrievalPerGb.standard = v;
    },
    "One Zone-IA retrieval fee",
    warnings,
  );
  setNumber(
    ret("-Retrieval-GIR"),
    (v) => {
      catalog.storage.GLACIER_IR.retrievalPerGb.standard = v;
    },
    "Glacier IR retrieval fee",
    warnings,
  );
  setNumber(
    ret("-Standard-Retrieval-Bytes", "RestoreObject"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.retrievalPerGb.standard = v;
    },
    "Glacier Flexible standard retrieval fee",
    warnings,
  );
  setNumber(
    ret("-Bulk-Retrieval-Bytes", "RestoreObject"),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.retrievalPerGb.bulk = v;
    },
    "Glacier Flexible bulk retrieval fee",
    warnings,
  );
  setNumber(
    ret("-Expedited-Retrieval-Bytes", ""),
    (v) => {
      catalog.storage.GLACIER_FLEXIBLE.retrievalPerGb.expedited = v;
      catalog.storage.INTELLIGENT_TIERING.retrievalPerGb.expedited ??= v;
    },
    "Glacier expedited retrieval fee",
    warnings,
  );

  // Management and insights.
  setNumber(
    perMillionObjects(doc, (a) => ut(a).endsWith("-Inventory-ObjectsListed")),
    (v) => {
      catalog.inventoryPerMillionObjects = v;
    },
    "S3 Inventory object fee",
    warnings,
  );
  setNumber(
    firstPrice(doc, (a) => ut(a).endsWith("-BatchOperations-Jobs"), "Jobs"),
    (v) => {
      catalog.batchOperations.job = v;
    },
    "S3 Batch Operations job fee",
    warnings,
  );
  setNumber(
    perMillionObjects(
      doc,
      (a) => ut(a).endsWith("-BatchOperations-Objects"),
    ),
    (v) => {
      catalog.batchOperations.perMillionObjects = v;
    },
    "S3 Batch Operations object fee",
    warnings,
  );
  setNumber(
    perMillionObjects(
      doc,
      (a) => ut(a).endsWith("-BatchOperations-Manifest"),
    ),
    (v) => {
      catalog.batchOperations.manifestPerMillionObjects = v;
    },
    "S3 Batch Operations manifest fee",
    warnings,
  );
  setNumber(
    firstPrice(
      doc,
      (a) => ut(a).endsWith("-Compute-Checksum-Processed-Bytes"),
      "GB",
    ),
    (v) => {
      catalog.computeChecksumPerGb = v;
    },
    "S3 checksum computation fee",
    warnings,
  );
  setNumber(
    firstPrice(
      doc,
      (a) => ut(a).endsWith("-Peak-Restore-Bytes-Delta"),
      "GB",
    ),
    (v) => {
      catalog.glacierRestoreFeePerGb = v;
    },
    "Glacier restore fee",
    warnings,
  );
  setNumber(
    firstPrice(
      doc,
      (a) => ut(a).endsWith("-TimedStorage-GlacierStaging"),
      "GB-Mo",
    ),
    (v) => {
      catalog.restoredCopyStoragePerGbMonth = v;
    },
    "Glacier restored-copy storage",
    warnings,
  );
}

function applyGda(
  catalog: RegionPricing,
  doc: RawDoc,
  warnings: string[],
): void {
  setTiers(
    tiersFor(doc, (a) => ut(a).endsWith("-TimedStorage-GDA-ByteHrs")),
    (t) => {
      catalog.storage.DEEP_ARCHIVE.tiers = t;
    },
    "Deep Archive storage",
    warnings,
  );
  const req = (
    suffix: string,
    op?: string,
  ) =>
    requestPer1000(
      doc,
      (a) =>
        ut(a).endsWith(suffix) &&
        (op === undefined || (a.operation ?? "") === op),
    );
  setNumber(
    req("-Requests-GDA-Tier1", "PutObject"),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.putPer1000 = v;
    },
    "Deep Archive PUT requests",
    warnings,
  );
  setNumber(
    req("-Requests-GDA-Tier1", "UploadPart"),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.multipartPartPer1000 = v;
    },
    "Deep Archive multipart requests",
    warnings,
  );
  setNumber(
    req("-Requests-GDA-Tier3"),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.restoreRequestPer1000.standard = v;
    },
    "Deep Archive standard restore requests",
    warnings,
  );
  setNumber(
    req("-Requests-GDA-Tier5"),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.restoreRequestPer1000.bulk = v;
    },
    "Deep Archive bulk restore requests",
    warnings,
  );
  setNumber(
    firstPrice(
      doc,
      (a) =>
        ut(a).endsWith("-Standard-Retrieval-Bytes") &&
        a.operation === "DeepArchiveRestoreObject",
      "GB",
    ),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.retrievalPerGb.standard = v;
    },
    "Deep Archive standard retrieval fee",
    warnings,
  );
  setNumber(
    firstPrice(
      doc,
      (a) =>
        ut(a).endsWith("-Bulk-Retrieval-Bytes") &&
        a.operation === "DeepArchiveRestoreObject",
      "GB",
    ),
    (v) => {
      catalog.storage.DEEP_ARCHIVE.retrievalPerGb.bulk = v;
    },
    "Deep Archive bulk retrieval fee",
    warnings,
  );
}

function applyDataTransfer(
  catalog: RegionPricing,
  doc: RawDoc,
  warnings: string[],
): void {
  const regionLabel = catalog.label;
  setTiers(
    tiersFor(
      doc,
      (a) =>
        a.fromLocation === regionLabel &&
        a.toLocation === "External" &&
        a.transferType === "AWS Outbound" &&
        ut(a).endsWith("-DataTransfer-Out-Bytes"),
      "GB",
    ),
    (t) => {
      catalog.egress.tiers = t;
    },
    `${regionLabel} internet egress`,
    warnings,
  );
  const free = firstPrice(
    doc,
    (a) =>
      ut(a) === "Global-DataTransfer-Out-Bytes" &&
      a.toLocation === "External",
    "GB",
  );
  if (free === 0) catalog.egress.freeGbPerMonth = 100;
}

/** Fetch and parse the three AWS Price List documents for a region. */
export async function fetchLivePricing(
  region: AuRegion,
  fetcher: Fetcher = fetch,
): Promise<LivePricing> {
  const base = getPricing(region);
  const urls = base.source;
  const results = await Promise.allSettled(
    urls.map((url) => fetchJson(url, fetcher)),
  );
  const catalog = structuredClone(base);
  const warnings: string[] = [];
  const publicationDates: string[] = [];

  const s3 = results[0];
  const gda = results[1];
  const dataTransfer = results[2];

  if (s3?.status === "fulfilled") {
    const doc = s3.value as RawDoc;
    applyS3(catalog, doc, warnings);
    if (doc.publicationDate) publicationDates.push(doc.publicationDate);
  } else {
    warnings.push(
      `S3 price list fetch failed (${
        reason(s3?.reason)
      }); using bundled S3 values`,
    );
  }
  if (gda?.status === "fulfilled") {
    const doc = gda.value as RawDoc;
    applyGda(catalog, doc, warnings);
    if (doc.publicationDate) publicationDates.push(doc.publicationDate);
  } else {
    warnings.push(
      `Deep Archive price list fetch failed (${
        reason(gda?.reason)
      }); using bundled Deep Archive values`,
    );
  }
  if (dataTransfer?.status === "fulfilled") {
    const doc = dataTransfer.value as RawDoc;
    applyDataTransfer(catalog, doc, warnings);
    if (doc.publicationDate) publicationDates.push(doc.publicationDate);
  } else {
    warnings.push(
      `Data transfer price list fetch failed (${
        reason(dataTransfer?.reason)
      }); using bundled egress values`,
    );
  }

  if (
    s3?.status === "rejected" && gda?.status === "rejected" &&
    dataTransfer?.status === "rejected"
  ) {
    throw new Error(
      "All AWS Price List requests failed; no live prices are available",
    );
  }

  const latest = publicationDates.filter(Boolean).sort().at(-1);
  if (latest) catalog.asOf = latest.slice(0, 10);

  return {
    catalog,
    asOf: catalog.asOf,
    sources: urls,
    fetchedAt: new Date().toISOString(),
    warnings,
  };
}

/** Fetch a live USD/AUD rate, trying three public no-key sources in order. */
export async function fetchFxRate(
  fetcher: Fetcher = fetch,
): Promise<FxInfo> {
  const attempts: {
    url: string;
    source: string;
    parse: (json: unknown) => { rate: number | null; asOf: string | null };
  }[] = [
    {
      url: "https://api.frankfurter.app/latest?from=USD&to=AUD",
      source: "Frankfurter (ECB reference rates)",
      parse: (json) => {
        const j = json as { rates?: { AUD?: number }; date?: string };
        return { rate: j.rates?.AUD ?? null, asOf: j.date ?? null };
      },
    },
    {
      url: "https://open.er-api.com/v6/latest/USD",
      source: "open.er-api.com",
      parse: (json) => {
        const j = json as {
          rates?: { AUD?: number };
          time_last_update_utc?: string;
        };
        return {
          rate: j.rates?.AUD ?? null,
          asOf: j.time_last_update_utc ?? null,
        };
      },
    },
    {
      url:
        "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      source: "jsDelivr currency-api",
      parse: (json) => {
        const j = json as { usd?: { aud?: number }; date?: string };
        return { rate: j.usd?.aud ?? null, asOf: j.date ?? null };
      },
    },
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const json = await fetchJson(attempt.url, fetcher);
      const parsed = attempt.parse(json);
      if (
        typeof parsed.rate === "number" && Number.isFinite(parsed.rate) &&
        parsed.rate > 0
      ) {
        return {
          rate: parsed.rate,
          source: attempt.source,
          asOf: parsed.asOf ?? new Date().toISOString(),
          manual: false,
        };
      }
      errors.push(`${attempt.source}: response did not contain an AUD rate`);
    } catch (err) {
      errors.push(`${attempt.source}: ${reason(err)}`);
    }
  }
  throw new Error(
    `Could not fetch a live USD/AUD rate (${errors.join("; ")})`,
  );
}

/**
 * Convert every monetary field in a catalog to another currency at `rate`.
 * Non-monetary values (region, free-tier GB, byte minimums) are unchanged.
 */
export function convertCatalogCurrency(
  catalog: RegionPricing,
  rate: number,
): RegionPricing {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid currency conversion rate: ${rate}`);
  }
  const c = structuredClone(catalog);
  const mul = (value: number) => value * rate;

  for (
    const tier of Object.keys(c.storage) as (keyof RegionPricing["storage"])[]
  ) {
    const s = c.storage[tier];
    s.tiers = s.tiers.map((t) => ({ ...t, perGbMonth: mul(t.perGbMonth) }));
    s.putPer1000 = mul(s.putPer1000);
    s.getPer1000 = mul(s.getPer1000);
    s.transitionPer1000 = mul(s.transitionPer1000);
    s.multipartPartPer1000 = mul(s.multipartPartPer1000);
    for (const key of Object.keys(s.retrievalPerGb)) {
      const k = key as keyof typeof s.retrievalPerGb;
      const value = s.retrievalPerGb[k];
      if (value !== undefined) s.retrievalPerGb[k] = mul(value);
    }
    for (const key of Object.keys(s.restoreRequestPer1000)) {
      const k = key as keyof typeof s.restoreRequestPer1000;
      const value = s.restoreRequestPer1000[k];
      if (value !== undefined) s.restoreRequestPer1000[k] = mul(value);
    }
  }

  const int = c.intelligentTiering;
  int.frequentTiers = int.frequentTiers.map((t) => ({
    ...t,
    perGbMonth: mul(t.perGbMonth),
  }));
  int.infrequentPerGbMonth = mul(int.infrequentPerGbMonth);
  int.archiveInstantPerGbMonth = mul(int.archiveInstantPerGbMonth);
  int.archiveAccessPerGbMonth = mul(int.archiveAccessPerGbMonth);
  int.deepArchiveAccessPerGbMonth = mul(int.deepArchiveAccessPerGbMonth);
  int.monitoringPer1000ObjectsMonth = mul(int.monitoringPer1000ObjectsMonth);

  c.inventoryPerMillionObjects = mul(c.inventoryPerMillionObjects);
  c.batchOperations.job = mul(c.batchOperations.job);
  c.batchOperations.perMillionObjects = mul(
    c.batchOperations.perMillionObjects,
  );
  c.batchOperations.manifestPerMillionObjects = mul(
    c.batchOperations.manifestPerMillionObjects,
  );
  c.computeChecksumPerGb = mul(c.computeChecksumPerGb);
  c.restoredCopyStoragePerGbMonth = mul(c.restoredCopyStoragePerGbMonth);
  c.glacierRestoreFeePerGb = mul(c.glacierRestoreFeePerGb);
  c.egress.tiers = c.egress.tiers.map((t) => ({
    ...t,
    perGbMonth: mul(t.perGbMonth),
  }));

  return c;
}
