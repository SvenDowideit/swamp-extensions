/**
 * Unit tests for the S3 archive report. The report is exercised through its
 * real `execute` entry point with a fake context, so handle lookup, decoding and
 * markdown rendering are all covered.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./s3_archive_planner_report.ts";
import {
  buildAnalysis,
  buildInventory,
  type PricingContext,
} from "./s3_archive_planner.ts";
import { convertCatalogCurrency } from "./live_pricing.ts";
import { getPricing } from "./pricing.ts";

const INVENTORY = buildInventory({
  sources: [
    {
      name: "Google Photos",
      kind: "google",
      bytes: 1_200_000_000_000,
      objectCount: 450_000,
      duplicateFraction: 0.1,
      downloadPerGb: 0,
      fixedCost: 0,
    },
    {
      name: "NAS",
      kind: "nas",
      bytes: 2_500_000_000_000,
      objectCount: 800_000,
      duplicateFraction: 0,
      downloadPerGb: 0,
      fixedCost: 0,
    },
  ],
  duplicateFraction: 0,
  annualGrowthPercent: 5,
  initialTransferMonths: 3,
});

const ANALYSIS = buildAnalysis(INVENTORY, {
  accessProfile: "family",
  maxRestoreHours: 48,
  years: 10,
  egress: true,
  verificationSampleFraction: 0.001,
  verificationSampleMinBytes: 10 * 1024 * 1024 * 1024,
  s3ComputesChecksum: false,
  useBatchOperations: false,
  priceOverrides: {},
}, {
  region: "ap-southeast-2",
  currency: "usd",
  pricingRefresh: "never",
  pricingMaxAgeHours: 24,
  taxPercent: 10,
  uploadBandwidthMbps: 100,
  transferEfficiency: 0.7,
  multipartThresholdBytes: 100 * 1024 * 1024,
  multipartPartSizeBytes: 64 * 1024 * 1024,
  multipartObjectFraction: 0,
  priceOverrides: {},
});

const BASE_PRICING = getPricing("ap-southeast-2");
const AUD_CONTEXT: PricingContext = {
  catalog: convertCatalogCurrency(BASE_PRICING, 1.5),
  catalogUsd: BASE_PRICING,
  currency: "AUD",
  asOf: BASE_PRICING.asOf,
  sources: BASE_PRICING.source,
  fx: {
    rate: 1.5,
    source: "test FX",
    asOf: "2026-10-24",
    manual: false,
  },
  warnings: [],
  fetchedAt: "2026-10-25T00:00:00.000Z",
};
const AUD_ANALYSIS = buildAnalysis(
  INVENTORY,
  {
    accessProfile: "family",
    maxRestoreHours: 48,
    years: 10,
    egress: true,
    verificationSampleFraction: 0.001,
    verificationSampleMinBytes: 10 * 1024 * 1024 * 1024,
    s3ComputesChecksum: false,
    useBatchOperations: false,
    priceOverrides: {},
  },
  {
    region: "ap-southeast-2",
    currency: "aud",
    pricingRefresh: "never",
    pricingMaxAgeHours: 24,
    taxPercent: 10,
    uploadBandwidthMbps: 100,
    transferEfficiency: 0.7,
    multipartThresholdBytes: 100 * 1024 * 1024,
    multipartPartSizeBytes: 64 * 1024 * 1024,
    multipartObjectFraction: 0,
    priceOverrides: {},
  },
  AUD_CONTEXT,
);

const CTX = {
  scope: "method" as const,
  modelType: "@svendowideit/s3-archive-planner",
  modelId: "family-photos",
  methodName: "analyse",
  executionStatus: "succeeded" as const,
  dataHandles: [
    { name: "current", specName: "analysis", kind: "resource" },
  ],
  dataRepository: {
    getContent: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(ANALYSIS))),
  },
  logger: { info: () => {} },
};

Deno.test("report renders the full analysis", async () => {
  const out = await report.execute(CTX);
  assertStringIncludes(out.markdown, "# S3 archive plan");
  assertStringIncludes(out.markdown, "## Inventory");
  assertStringIncludes(out.markdown, "## Recommendation");
  assertStringIncludes(out.markdown, "## Plan comparison");
  assertStringIncludes(out.markdown, "## Verification plan");
  assertStringIncludes(out.markdown, "## Break-even by access rate");
  assertStringIncludes(out.markdown, "## Packing small objects");
  assertStringIncludes(out.markdown, "SHA-256");
  assertEquals(out.json.planCount, ANALYSIS.plans.length);
  assertEquals(
    out.json.recommendedPlanId,
    ANALYSIS.recommendation.recommendedPlanId,
  );
});

Deno.test("report does nothing for a non-analysis method", async () => {
  const out = await report.execute({ ...CTX, methodName: "inventory" });
  assertEquals(out.markdown, "");
});

Deno.test("report fails softly on bad data", async () => {
  const out = await report.execute({
    ...CTX,
    dataRepository: {
      getContent: () => Promise.resolve(new TextEncoder().encode("{not-json")),
    },
  });
  assertEquals(out.markdown, "Analysis data could not be parsed.");
});

Deno.test("report handles a missing analysis handle", async () => {
  const out = await report.execute({ ...CTX, dataHandles: [] });
  assertEquals(out.markdown, "No analysis data produced.");
});

Deno.test("report labels live AUD conversions", async () => {
  const out = await report.execute({
    ...CTX,
    dataRepository: {
      getContent: () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(AUD_ANALYSIS)),
        ),
    },
  });
  assertStringIncludes(out.markdown, "AUD");
  assertStringIncludes(out.markdown, "converted live");
  assertStringIncludes(out.markdown, "A$");
  assertEquals(out.json.currency, "AUD");
});
