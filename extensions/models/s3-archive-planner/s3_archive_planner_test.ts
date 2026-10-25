/**
 * Unit tests for the S3 archive planner.
 *
 * The tests exercise the pure cost model — inventory aggregation, tier minimum
 * durations, monthly simulation, break-even, transfer and verification — rather
 * than depending on AWS or the network.
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  applyPriceOverrides,
  buildAnalysis,
  buildInventory,
  humanBytes,
  model,
  money,
  parseCount,
  PLAN_CATALOG,
  type PricingContext,
  restoreHoursFor,
  tieredStorageCost,
  usd,
  validatePlan,
} from "./s3_archive_planner.ts";
import {
  convertCatalogCurrency,
  type Fetcher,
  fetchFxRate,
  fetchLivePricing,
} from "./live_pricing.ts";
import { getPricing } from "./pricing.ts";

const BASE_INVENTORY = {
  sources: [],
  duplicateFraction: 0,
  annualGrowthPercent: 0,
  initialTransferMonths: 1,
};

const BASE_ANALYSIS = {
  accessProfile: "occasional" as const,
  maxRestoreHours: 48,
  years: 1,
  egress: true,
  verificationSampleFraction: 0.001,
  verificationSampleMinBytes: 10 * 1024 * 1024 * 1024,
  s3ComputesChecksum: false,
  useBatchOperations: false,
  priceOverrides: {},
};

const GLOBAL = {
  region: "ap-southeast-2" as const,
  currency: "usd" as const,
  pricingRefresh: "never" as const,
  pricingMaxAgeHours: 24,
  taxPercent: 0,
  uploadBandwidthMbps: 100,
  transferEfficiency: 0.7,
  multipartThresholdBytes: 100 * 1024 * 1024,
  multipartPartSizeBytes: 64 * 1024 * 1024,
  multipartObjectFraction: 0,
  priceOverrides: {},
};

Deno.test("pricing includes the Glacier restore fee", () => {
  assertEquals(getPricing("ap-southeast-2").glacierRestoreFeePerGb, 0.008);
  assertEquals(getPricing("ap-southeast-4").glacierRestoreFeePerGb, 0.008);
});

Deno.test("tieredStorageCost applies Standard volume tiers", () => {
  const tiers = getPricing("ap-southeast-2").storage.STANDARD.tiers;
  assertEquals(tieredStorageCost(tiers, 1), 0.025);
  assertEquals(tieredStorageCost(tiers, 1024), 25.6);
  assertEquals(tieredStorageCost(tiers, 51_200), 1280);
  assertEquals(tieredStorageCost(tiers, 51_201), 1280.024);
});

Deno.test("humanBytes and usd are stable for reports", () => {
  assertEquals(humanBytes(0), "0 B");
  assertEquals(humanBytes(1024), "1.0 KiB");
  assertEquals(humanBytes(1024 * 1024), "1.0 MiB");
  assertEquals(usd(0.0025), "$0.0025");
  assertEquals(usd(1234.5), "$1,235");
});

Deno.test("buildInventory derives totals, dedupes and averages", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    sources: [
      {
        name: "Google",
        kind: "google",
        bytes: 2_000_000,
        objectCount: 100,
        duplicateFraction: 0.25,
        downloadPerGb: 0,
        fixedCost: 0,
      },
      {
        name: "NAS",
        kind: "nas",
        bytes: 3_000_000,
        objectCount: 200,
        duplicateFraction: 0,
        downloadPerGb: 0,
        fixedCost: 0,
      },
    ],
  });
  assertEquals(inv.totalBytes, 5_000_000);
  assertEquals(inv.totalObjects, 300);
  assertEquals(Math.round(inv.duplicateBytes), 500_000);
  assertEquals(inv.dedupedBytes, 4_500_000);
  assertEquals(inv.objectsAfterDedupe, 270);
  assertEquals(inv.avgObjectSizeBytes, 4_500_000 / 270);
});

Deno.test("buildInventory rejects an empty inventory", () => {
  let threw = false;
  try {
    buildInventory({ ...BASE_INVENTORY });
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "No inventory supplied");
  }
  assert(threw, "expected an error for an empty inventory");
});

Deno.test("validatePlan enforces minimum storage durations", () => {
  const pricing = getPricing("ap-southeast-2");
  const bad = validatePlan({
    id: "bad",
    name: "Bad",
    description: "GIR left too early",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "GLACIER_IR", afterDays: 10 },
      { tier: "DEEP_ARCHIVE", afterDays: 40 },
    ],
    tags: [],
    valid: true,
    issues: [],
  }, pricing);
  assertEquals(bad.valid, false);
  assertStringIncludes(bad.issues.join(" "), "90-day minimum");

  const good = validatePlan({
    id: "good",
    name: "Good",
    description: "GIR kept for 90 days",
    stages: [
      { tier: "STANDARD", afterDays: 0 },
      { tier: "GLACIER_IR", afterDays: 90 },
      { tier: "DEEP_ARCHIVE", afterDays: 180 },
    ],
    tags: [],
    valid: true,
    issues: [],
  }, pricing);
  assertEquals(good.valid, true);
  assertEquals(good.issues.length, 0);
});

Deno.test("Deep Archive is cheaper than Standard for a cold archive", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    totalBytes: 1_000 * 1_000_000_000,
    objectCount: 100_000,
  });
  const analysis = buildAnalysis(inv, {
    ...BASE_ANALYSIS,
    planIds: ["standard", "deep-archive"],
  }, GLOBAL);

  const standard = analysis.plans.find((p) => p.id === "standard")!;
  const deep = analysis.plans.find((p) => p.id === "deep-archive")!;
  assert(deep.firstYearTotal < standard.firstYearTotal);
  const deepStorageMonthly = deep.firstYear.storage / 12;
  assert(deepStorageMonthly > 1.9 && deepStorageMonthly < 2.2);
  assert(deep.averageMonthly < 3.5);
  assertEquals(deep.restoreHours, 12);
  assertEquals(deep.meetsAccessRequirement, true);
  assertEquals(analysis.recommendation.recommendedPlanId, "deep-archive");
});

Deno.test("maxRestoreHours=0 excludes Deep Archive from the recommendation", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    totalBytes: 1_000 * 1_000_000_000,
    objectCount: 100_000,
  });
  const analysis = buildAnalysis(inv, {
    ...BASE_ANALYSIS,
    maxRestoreHours: 0,
  }, GLOBAL);
  const rec = analysis.plans.find((p) =>
    p.id === analysis.recommendation.recommendedPlanId
  )!;
  assertEquals(rec.restoreHours, 0);
  assertEquals(rec.meetsAccessRequirement, true);
});

Deno.test("egress=false removes internet transfer from restores", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    totalBytes: 1_000 * 1_000_000_000,
    objectCount: 100_000,
  });
  const withEgress = buildAnalysis(inv, {
    ...BASE_ANALYSIS,
    planIds: ["deep-archive"],
    accessProfile: "custom",
    restoreFractionPerYear: 0.5,
    restoreTier: "standard",
    extraEgressGbPerMonth: 200,
    egress: true,
  }, GLOBAL);
  const withoutEgress = buildAnalysis(inv, {
    ...BASE_ANALYSIS,
    planIds: ["deep-archive"],
    accessProfile: "custom",
    restoreFractionPerYear: 0.5,
    restoreTier: "standard",
    extraEgressGbPerMonth: 200,
    egress: false,
  }, GLOBAL);
  assert(
    withEgress.plans[0]!.egressCostTotal >
      withoutEgress.plans[0]!.egressCostTotal,
  );
  assertEquals(withoutEgress.plans[0]!.egressCostTotal, 0);
});

Deno.test("price overrides change the catalog and the result", () => {
  const pricing = getPricing("ap-southeast-2");
  const overridden = applyPriceOverrides(pricing, {
    "storage.DEEP_ARCHIVE.tiers.0.perGbMonth": 0.001,
  });
  assertEquals(overridden.storage.DEEP_ARCHIVE.tiers[0]!.perGbMonth, 0.001);

  let threw = false;
  try {
    applyPriceOverrides(pricing, { "storage.NOT_A_TIER.perGbMonth": 1 });
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "unknown path");
  }
  assert(threw);
});

Deno.test("transfer uses the first stage and estimates days", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    sources: [
      {
        name: "NAS",
        kind: "nas",
        bytes: 10 * 1024 * 1024 * 1024,
        objectCount: 5_000,
        duplicateFraction: 0,
        downloadPerGb: 0,
        fixedCost: 0,
        throughputMbps: 100,
      },
    ],
  });
  const analysis = buildAnalysis(inv, {
    ...BASE_ANALYSIS,
    planIds: ["deep-archive"],
  }, GLOBAL);
  assertEquals(analysis.transfer.s3IngressCost, 0);
  assertEquals(analysis.transfer.totalObjects, 5_000);
  assert(analysis.transfer.estimatedDays > 0);
  assertEquals(analysis.transfer.sources.length, 1);
});

Deno.test("verification plan contains exact and strong evidence", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    totalBytes: 1_000 * 1_000_000_000,
    objectCount: 100_000,
  });
  const analysis = buildAnalysis(inv, {
    ...BASE_ANALYSIS,
    planIds: ["deep-archive"],
  }, GLOBAL);
  assert(analysis.verification.steps.length >= 5);
  assert(
    analysis.verification.steps.some((s) => s.confidence === "exact"),
  );
  assert(
    analysis.verification.steps.some((s) => s.confidence === "strong"),
  );
  assert(analysis.verification.sampleRestoreBytes >= 10 * 1024 * 1024 * 1024);
});

Deno.test("break-even explains that Deep Archive wins at high restore rates", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    totalBytes: 1_000 * 1_000_000_000,
    objectCount: 100_000,
  });
  const analysis = buildAnalysis(inv, BASE_ANALYSIS, GLOBAL);
  const row = analysis.breakEven.find((r) =>
    r.coldPlan.includes("Deep Archive") && r.hotPlan.includes("Standard-IA")
  );
  assert(row);
  assert(row!.breakEvenRestoreFractionPerYear !== null);
  assert(row!.breakEvenRestoreFractionPerYear! > 1);
  assert(row!.note.length > 0);
});

Deno.test("restoreHoursFor maps archived classes correctly", () => {
  assertEquals(restoreHoursFor("STANDARD", "standard"), 0);
  assertEquals(restoreHoursFor("GLACIER_IR", "standard"), 0);
  assertEquals(restoreHoursFor("GLACIER_FLEXIBLE", "standard"), 5);
  assertEquals(restoreHoursFor("GLACIER_FLEXIBLE", "bulk"), 12);
  assertEquals(restoreHoursFor("GLACIER_FLEXIBLE", "expedited"), 0.08);
  assertEquals(restoreHoursFor("DEEP_ARCHIVE", "standard"), 12);
  assertEquals(restoreHoursFor("DEEP_ARCHIVE", "bulk"), 48);
});

Deno.test("model exposes the documented surface", () => {
  assertEquals(model.type, "@svendowideit/s3-archive-planner");
  assertEquals(model.version, "2026.10.25.1");
  assert("inventory" in model.methods);
  assert("analyse" in model.methods);
  assert("pricing" in model.methods);
  assertEquals(model.reports, ["@svendowideit/s3-archive-report"]);
  assert(PLAN_CATALOG.some((p) => p.id === "deep-archive"));
  assert(
    PLAN_CATALOG.some((p) => p.id === "standard-90d-gir-90d-deep-archive"),
  );
});

Deno.test("parseCount accepts k/m/b strings and plain numbers", () => {
  assertEquals(parseCount("450k", "objects"), 450_000);
  assertEquals(parseCount("1.2m", "objects"), 1_200_000);
  assertEquals(parseCount("1.2b", "bytes"), 1_200_000_000);
  assertEquals(parseCount(" 2.5 M ", "bytes"), 2_500_000);
  assertEquals(parseCount("1,200,000", "bytes"), 1_200_000);
  assertEquals(parseCount("2e6", "bytes"), 2_000_000);
  assertEquals(parseCount(123, "bytes"), 123);
  let threw = false;
  try {
    parseCount("12x", "bytes");
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "450k, 1.2m, 1.2b");
  }
  assert(threw);
});

Deno.test("buildInventory accepts k/m/b source strings", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    sources: [
      {
        name: "NAS",
        kind: "nas",
        bytes: "2.5b",
        objectCount: "800k",
        duplicateFraction: 0,
        downloadPerGb: 0,
        fixedCost: 0,
      },
      {
        name: "Google",
        kind: "google",
        bytes: "1.2b",
        objectCount: "450k",
        duplicateFraction: 0.1,
        downloadPerGb: 0,
        fixedCost: 0,
      },
    ],
  });
  assertEquals(inv.totalBytes, 3_700_000_000);
  assertEquals(inv.totalObjects, 1_250_000);
  assertEquals(Math.round(inv.duplicateBytes), 120_000_000);
});

function makeAwsDoc(
  products: Record<
    string,
    {
      attributes: Record<string, string>;
      dims: { price: number; unit?: string; begin?: string; end?: string }[];
    }
  >,
): unknown {
  const doc: {
    publicationDate: string;
    products: Record<string, { attributes: Record<string, string> }>;
    terms: { OnDemand: Record<string, Record<string, unknown>> };
  } = {
    publicationDate: "2026-10-20T00:00:00Z",
    products: {},
    terms: { OnDemand: {} },
  };
  for (const [sku, product] of Object.entries(products)) {
    doc.products[sku] = { attributes: product.attributes };
    const dimensions: Record<string, unknown> = {};
    for (const [j, dim] of product.dims.entries()) {
      dimensions[`${sku}.DIM${j}`] = {
        unit: dim.unit ?? "GB-Mo",
        beginRange: dim.begin ?? "0",
        endRange: dim.end ?? "Inf",
        pricePerUnit: { USD: String(dim.price) },
      };
    }
    doc.terms.OnDemand[sku] = {
      [`${sku}.TERM`]: { priceDimensions: dimensions },
    };
  }
  return doc;
}

Deno.test("fetchLivePricing parses live AWS documents", async () => {
  const s3Doc = makeAwsDoc({
    STANDARD: {
      attributes: {
        usagetype: "APS2-TimedStorage-ByteHrs",
        storageClass: "General Purpose",
        volumeType: "Standard",
      },
      dims: [{ price: 0.03, end: "51200" }, { price: 0.025, end: "Inf" }],
    },
    STANDARD_PUT: {
      attributes: { usagetype: "APS2-Requests-Tier1" },
      dims: [{ price: 0.006, unit: "Requests" }],
    },
    GFR_RETRIEVAL: {
      attributes: {
        usagetype: "APS2-Standard-Retrieval-Bytes",
        operation: "RestoreObject",
      },
      dims: [{ price: 0.02, unit: "GB" }],
    },
    GFR_STAGING: {
      attributes: { usagetype: "APS2-TimedStorage-GlacierStaging" },
      dims: [{ price: 0.03, unit: "GB-Mo" }],
    },
    GLACIER_RESTORE_FEE: {
      attributes: { usagetype: "APS2-Peak-Restore-Bytes-Delta" },
      dims: [{ price: 0.01, unit: "GB" }],
    },
    INVENTORY: {
      attributes: { usagetype: "APS2-Inventory-ObjectsListed" },
      dims: [{ price: 0.000000003, unit: "Objects" }],
    },
  });
  const gdaDoc = makeAwsDoc({
    DEEP_ARCHIVE: {
      attributes: { usagetype: "APS2-TimedStorage-GDA-ByteHrs" },
      dims: [{ price: 0.003 }],
    },
    DEEP_ARCHIVE_PUT: {
      attributes: {
        usagetype: "APS2-Requests-GDA-Tier1",
        operation: "PutObject",
      },
      dims: [{ price: 0.07, unit: "Requests" }],
    },
    DEEP_ARCHIVE_STANDARD_RETRIEVAL: {
      attributes: {
        usagetype: "APS2-Standard-Retrieval-Bytes",
        operation: "DeepArchiveRestoreObject",
      },
      dims: [{ price: 0.03, unit: "GB" }],
    },
  });
  const dtDoc = makeAwsDoc({
    EGRESS: {
      attributes: {
        usagetype: "APS2-DataTransfer-Out-Bytes",
        fromLocation: "Asia Pacific (Sydney)",
        toLocation: "External",
        transferType: "AWS Outbound",
      },
      dims: [{ price: 0.2, unit: "GB" }],
    },
  });
  const fetcher: Fetcher = (url) => {
    const body = url.includes("AmazonS3GlacierDeepArchive")
      ? gdaDoc
      : url.includes("AWSDataTransfer")
      ? dtDoc
      : s3Doc;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const live = await fetchLivePricing("ap-southeast-2", fetcher);
  assertEquals(live.catalog.storage.STANDARD.tiers[0]!.perGbMonth, 0.03);
  assertEquals(live.catalog.storage.STANDARD.putPer1000, 6);
  assertEquals(live.catalog.storage.DEEP_ARCHIVE.tiers[0]!.perGbMonth, 0.003);
  assertEquals(live.catalog.storage.DEEP_ARCHIVE.putPer1000, 70);
  assertEquals(live.catalog.glacierRestoreFeePerGb, 0.01);
  assertEquals(live.catalog.inventoryPerMillionObjects, 0.003);
  assertEquals(live.catalog.egress.tiers[0]!.perGbMonth, 0.2);
  assertEquals(live.asOf, "2026-10-20");
});

Deno.test("fetchFxRate falls back to the second source", async () => {
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(new Response("no", { status: 500 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ rates: { AUD: 1.61 }, time_last_update_utc: "now" }),
        { status: 200 },
      ),
    );
  };
  const fx = await fetchFxRate(fetcher);
  assertEquals(fx.rate, 1.61);
  assertEquals(fx.source, "open.er-api.com");
  assertEquals(fx.manual, false);
});

Deno.test("AUD analysis converts the whole catalog and labels it", () => {
  const inv = buildInventory({
    ...BASE_INVENTORY,
    totalBytes: 1_000 * 1_000_000_000,
    objectCount: 100_000,
  });
  const base = getPricing("ap-southeast-2");
  const usdAnalysis = buildAnalysis(inv, BASE_ANALYSIS, GLOBAL);
  const context: PricingContext = {
    catalog: convertCatalogCurrency(base, 1.5),
    catalogUsd: base,
    currency: "AUD",
    asOf: base.asOf,
    sources: base.source,
    fx: {
      rate: 1.5,
      source: "test FX",
      asOf: "2026-10-24",
      manual: false,
    },
    warnings: [],
    fetchedAt: "2026-10-25T00:00:00.000Z",
  };
  const audAnalysis = buildAnalysis(
    inv,
    BASE_ANALYSIS,
    { ...GLOBAL, currency: "aud" },
    context,
  );
  assertEquals(audAnalysis.display.currency, "AUD");
  assertEquals(audAnalysis.display.fx?.rate, 1.5);
  assertStringIncludes(audAnalysis.warnings[0]!, "converted live");
  const usdDeep = usdAnalysis.plans.find((p) => p.id === "deep-archive")!;
  const audDeep = audAnalysis.plans.find((p) => p.id === "deep-archive")!;
  assert(audDeep.totalOverHorizon > usdDeep.totalOverHorizon * 1.4);
});

Deno.test("money formats AUD with an A$ prefix", () => {
  assertEquals(money(1.5, "USD"), "$1.50");
  assertEquals(money(1.5, "AUD"), "A$1.50");
});
