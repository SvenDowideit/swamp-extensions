/**
 * Report extension for @svendowideit/s3-archive-planner — renders the latest
 * cost/access analysis as a human-readable markdown report.
 *
 * @module
 */
import type { AnalysisOutput, PlanResult } from "./s3_archive_planner.ts";
import { humanBytes, money } from "./s3_archive_planner.ts";

type DataHandle = {
  name: string;
  specName: string;
  kind: string;
  version?: number;
};

type MethodReportContext = {
  scope: "method";
  modelType: string;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
};

/** Report definition for the S3 archive analysis. */
export const report = {
  name: "@svendowideit/s3-archive-report",
  description:
    "Render S3 archive cost, transfer and verification analysis as a markdown report",
  scope: "method",
  labels: ["s3", "archive", "cost", "verification"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      context.executionStatus === "failed" || context.methodName !== "analyse"
    ) {
      return { markdown: "", json: {} };
    }

    const handle = context.dataHandles.find((h) => h.specName === "analysis");
    if (!handle) {
      return { markdown: "No analysis data produced.", json: {} };
    }

    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) {
      return { markdown: "Analysis data not found.", json: {} };
    }

    let analysis: AnalysisOutput;
    try {
      analysis = JSON.parse(new TextDecoder().decode(raw)) as AnalysisOutput;
    } catch {
      return { markdown: "Analysis data could not be parsed.", json: {} };
    }

    const markdown = formatReport(analysis);
    const rec = analysis.plans.find((p) =>
      p.id === analysis.recommendation.recommendedPlanId
    );
    return {
      markdown,
      json: {
        region: analysis.region,
        currency: analysis.display.currency,
        pricingAsOf: analysis.pricingAsOf,
        recommendedPlanId: analysis.recommendation.recommendedPlanId,
        recommendedAverageMonthly: rec?.averageMonthly ?? null,
        recommendedTotalOverHorizon: rec?.totalOverHorizon ?? null,
        planCount: analysis.plans.length,
      },
    };
  },
};

function moneyWithTax(
  value: number,
  display: AnalysisOutput["display"],
): string {
  const tax = display.taxPercent > 0 ? value * (display.taxPercent / 100) : 0;
  const total = value + tax;
  let out = money(value, display.currency);
  if (display.taxPercent > 0) {
    out += ` (+${display.taxPercent}% tax = ${money(total, display.currency)})`;
  }
  return out;
}

function planRow(plan: PlanResult, display: AnalysisOutput["display"]): string {
  const fmt = (value: number) => money(value, display.currency);
  const notes: string[] = [];
  if (!plan.valid) notes.push("invalid lifecycle");
  if (!plan.meetsAccessRequirement) notes.push("slower than limit");
  const direct = plan.warnings.find((w) =>
    w.includes("Direct PUT to Deep Archive")
  );
  if (direct) notes.push("direct PUT, one-way, 12-48h restore");
  const small = plan.warnings.find((w) =>
    w.includes("Average object is under 1 MiB")
  );
  if (small) notes.push("small objects: pack first");
  if (notes.length === 0 && plan.warnings.length > 0) {
    const text = plan.warnings[0];
    notes.push(text.length > 90 ? `${text.slice(0, 87)}...` : text);
  }
  return `| ${plan.name} | ${
    plan.restoreHours === 0 ? "instant" : `${plan.restoreHours}h`
  } | ${fmt(plan.firstYearTotal)} | ${fmt(plan.totalOverHorizon)} | ${
    fmt(plan.averageMonthly)
  } | ${plan.meetsAccessRequirement ? "yes" : "no"} | ${notes.join("; ")} |`;
}

function tierBytesAtEnd(plan: PlanResult): string {
  const entries = Object.entries(plan.bytesByTierAtEnd)
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "—";
  return entries.map(([tier, bytes]) =>
    `${tier.replaceAll("_", " ")} ${humanBytes(bytes)}`
  ).join(", ");
}

function formatReport(a: AnalysisOutput): string {
  const lines: string[] = [];
  const rec = a.plans.find((p) => p.id === a.recommendation.recommendedPlanId);
  const fmt = (value: number) => money(value, a.display.currency);
  const years = a.plans[0]?.monthly.length
    ? Math.round(a.plans[0].monthly.length / 12)
    : 10;

  lines.push(`# S3 archive plan — ${a.regionLabel}`);
  lines.push("");
  lines.push(
    `Generated ${a.generatedAt}; prices as of ${a.pricingAsOf} (${a.display.currency}, pre-tax). Region: \`${a.region}\`.`,
  );
  if (a.display.fx && !a.display.fx.manual) {
    lines.push(
      `AWS publishes USD. AUD is converted live at 1 USD = ${
        money(a.display.fx.rate, a.display.currency)
      } from ${a.display.fx.source} (${a.display.fx.asOf}).`,
    );
  } else if (a.display.fx?.manual) {
    lines.push(
      `AWS publishes USD. AUD uses the manual audPerUsd=${a.display.fx.rate} override.`,
    );
  } else if (a.display.currency === "USD") {
    lines.push(
      "No live AUD rate was available, so all figures are in USD.",
    );
  }
  lines.push("");

  lines.push("## Inventory");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| ------ | ----- |");
  lines.push(`| Source bytes | ${humanBytes(a.inventory.totalBytes)} |`);
  lines.push(
    `| Objects | ${Math.round(a.inventory.totalObjects).toLocaleString()} |`,
  );
  lines.push(
    `| Duplicates removed | ${humanBytes(a.inventory.duplicateBytes)} (${
      (a.inventory.duplicateFraction * 100).toFixed(1)
    }%) |`,
  );
  lines.push(`| Bytes to store | ${humanBytes(a.inventory.dedupedBytes)} |`);
  lines.push(
    `| Average object | ${humanBytes(a.inventory.avgObjectSizeBytes)} |`,
  );
  lines.push(
    `| Growth | ${a.inventory.annualGrowthPercent}%/year, initial transfer over ${a.inventory.initialTransferMonths} month(s) |`,
  );
  lines.push("");
  if (a.inventory.sources.length > 0) {
    lines.push("| Source | Kind | Bytes | Objects | Duplicate bytes |");
    lines.push("| ------ | ---- | ----- | ------- | --------------- |");
    for (const s of a.inventory.sources) {
      lines.push(
        `| ${s.name} | ${s.kind} | ${
          humanBytes(s.bytes)
        } | ${s.objectCount.toLocaleString()} | ${
          humanBytes(s.duplicateBytes)
        } |`,
      );
    }
    lines.push("");
  }

  lines.push("## Access profile");
  lines.push("");
  lines.push(`**${a.accessProfile.label}**`);
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| ----- | ----- |");
  lines.push(
    `| Restore volume | ${
      (a.accessProfile.restoreFractionPerYear * 100).toFixed(2)
    }% of stored bytes per year |`,
  );
  lines.push(`| Retrieval tier | ${a.accessProfile.restoreTier} |`);
  lines.push(
    `| Restored copy retention | ${a.accessProfile.restoreRetentionDays} days |`,
  );
  lines.push(
    `| Ordinary egress | ${a.accessProfile.extraEgressGbPerMonth} GB/month |`,
  );
  lines.push(
    `| Ordinary GETs | ${a.accessProfile.getRequestsPerMonth}/month |`,
  );
  lines.push(`| Max restore time | ${a.accessProfile.maxRestoreHours}h |`);
  lines.push("");

  lines.push("## Recommendation");
  lines.push("");
  if (rec) {
    lines.push(
      `**${rec.name}** — ${
        moneyWithTax(rec.averageMonthly, a.display)
      }/month average; ` +
        `first year ${moneyWithTax(rec.firstYearTotal, a.display)}; ` +
        `${years}-year total ${moneyWithTax(rec.totalOverHorizon, a.display)}.`,
    );
    lines.push("");
    lines.push(a.recommendation.rationale);
  } else {
    lines.push(a.recommendation.rationale);
  }
  lines.push("");
  lines.push(
    `Cheapest overall: **${a.recommendation.cheapestOverall ?? "—"}**; ` +
      `cheapest instant: **${a.recommendation.cheapestInstant ?? "—"}**; ` +
      `cheapest within 12h: **${
        a.recommendation.cheapestWithin12h ?? "—"
      }**; ` +
      `cheapest within 48h: **${a.recommendation.cheapestWithin48h ?? "—"}**.`,
  );
  lines.push("");

  lines.push(`## Plan comparison (${years} years)`);
  lines.push("");
  lines.push(
    "| Plan | Restore | First year | Total | Avg/month | Meets limit | Notes |",
  );
  lines.push(
    "| ---- | ------- | ---------- | ----- | --------- | ----------- | ----- |",
  );
  const sorted = [...a.plans].sort((x, y) =>
    x.totalOverHorizon - y.totalOverHorizon
  );
  for (const plan of sorted) {
    lines.push(planRow(plan, a.display));
  }
  lines.push("");

  if (rec) {
    lines.push("## Recommended plan breakdown");
    lines.push("");
    lines.push("| Cost | First year | Total over horizon |");
    lines.push("| ---- | ---------- | ------------------ |");
    lines.push(
      `| Storage | ${fmt(rec.firstYear.storage)} | ${
        fmt(rec.storageCostTotal)
      } |`,
    );
    lines.push(
      `| Upload requests | ${fmt(rec.firstYear.uploadRequests)} | ${
        fmt(rec.requestCostTotal)
      } |`,
    );
    lines.push(
      `| Retrieval + restore requests | ${
        fmt(rec.firstYear.retrieval + rec.firstYear.restoreRequests)
      } | ${fmt(rec.retrievalCostTotal)} |`,
    );
    lines.push(
      `| Restored-copy staging | ${fmt(rec.firstYear.staging)} | ${
        fmt(rec.stagingCostTotal)
      } |`,
    );
    lines.push(
      `| Internet egress | ${fmt(rec.firstYear.egress)} | ${
        fmt(rec.egressCostTotal)
      } |`,
    );
    lines.push(
      `| Monitoring / GETs | ${
        fmt(rec.firstYear.monitoring + rec.firstYear.getRequests)
      } | ${fmt(rec.monitoringCostTotal)} |`,
    );
    lines.push(
      `| **Total** | **${fmt(rec.firstYearTotal)}** | **${
        fmt(rec.totalOverHorizon)
      }** |`,
    );
    lines.push("");
    lines.push(
      `One-time initial transfer: **${fmt(a.transfer.totalOneTimeCost)}** ` +
        `(S3 ingress is ${
          fmt(a.transfer.s3IngressCost)
        }; request costs are included).`,
    );
    lines.push("");
    lines.push(`Bytes by class at end: ${tierBytesAtEnd(rec)}.`);
    lines.push("");
  }

  lines.push("## Initial transfer");
  lines.push("");
  lines.push("| Item | Value |");
  lines.push("| ---- | ----- |");
  lines.push(`| Bytes to upload | ${humanBytes(a.transfer.totalBytes)} |`);
  lines.push(
    `| Objects | ${Math.round(a.transfer.totalObjects).toLocaleString()} |`,
  );
  lines.push(`| S3 ingress | ${fmt(a.transfer.s3IngressCost)} |`);
  lines.push(`| S3 upload requests | ${fmt(a.transfer.uploadRequestCost)} |`);
  lines.push(
    `| Source download / courier | ${
      fmt(a.transfer.sourceEgressCost + a.transfer.sourceFixedCost)
    } |`,
  );
  lines.push(`| Initial verification | ${fmt(a.transfer.verificationCost)} |`);
  lines.push(
    `| **One-time total** | **${fmt(a.transfer.totalOneTimeCost)}** |`,
  );
  lines.push(
    `| Estimated wall-clock | ${a.transfer.estimatedDays.toFixed(1)} days |`,
  );
  lines.push("");
  lines.push(a.transfer.snowballNote);
  lines.push("");
  if (a.transfer.sources.length > 0) {
    lines.push(
      "| Source | Bytes | Objects | Download cost | Effective Mbps | Days |",
    );
    lines.push(
      "| ------ | ----- | ------- | ------------- | -------------- | ---- |",
    );
    for (const s of a.transfer.sources) {
      lines.push(
        `| ${s.name} | ${
          humanBytes(s.bytes)
        } | ${s.objectCount.toLocaleString()} | ${
          fmt(s.downloadCost + s.fixedCost)
        } | ${s.effectiveMbps} | ${s.estimatedDays.toFixed(1)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Break-even by access rate");
  lines.push("");
  lines.push(
    "| Cold plan | Hot plan | Storage saving/year | Break-even restore rate | Note |",
  );
  lines.push(
    "| --------- | -------- | ------------------- | ----------------------- | ---- |",
  );
  for (const row of a.breakEven) {
    const rate = row.breakEvenRestoreFractionPerYear === null
      ? "never (cold wins)"
      : `${(row.breakEvenRestoreFractionPerYear * 100).toFixed(1)}%/year`;
    lines.push(
      `| ${row.coldPlan} | ${row.hotPlan} | ${
        fmt(row.annualStorageSaving)
      } | ${rate} | ${row.note} |`,
    );
  }
  lines.push("");
  lines.push(
    "Break-even compares storage savings with the extra retrieval + egress cost per GB. It is a simplified marginal calculation; use the plan totals above for the actual modelled cost.",
  );
  lines.push("");

  lines.push("## Verification plan");
  lines.push("");
  lines.push("| Step | Cost | Time | Evidence |");
  lines.push("| ---- | ---- | ---- | -------- |");
  for (const step of a.verification.steps) {
    lines.push(
      `| **${step.name}** — ${step.what} | ${
        fmt(step.costUsd)
      } | ${step.time} | ${step.confidence} |`,
    );
  }
  lines.push("");
  lines.push(
    `Initial presence/metadata/checksum/batch cost: ${
      fmt(
        a.verification.initialPresenceCost +
          a.verification.initialMetadataCost +
          a.verification.checksumComputationCost +
          a.verification.batchOperationsCost,
      )
    }. Sample restore: ${humanBytes(a.verification.sampleRestoreBytes)} for ${
      fmt(a.verification.sampleRestoreCost)
    }. Full recovery rehearsal: ${fmt(a.verification.fullRestoreCost)}. ` +
      `Ongoing annual verification: ${
        fmt(a.verification.annualVerificationCost)
      }.`,
  );
  lines.push("");
  lines.push("**Confidence scale:**");
  for (const note of a.verification.confidenceNotes) {
    lines.push(`- ${note}`);
  }
  lines.push("");
  lines.push("**Verification warnings:**");
  for (const warning of a.verification.warnings) {
    lines.push(`- ${warning}`);
  }
  lines.push("");

  lines.push("## Packing small objects");
  lines.push("");
  lines.push(a.packing.reason);
  if (a.packing.recommended) {
    lines.push("");
    lines.push("| Item | Current | Packed (~1 GiB) |");
    lines.push("| ---- | ------- | --------------- |");
    lines.push(
      `| Objects | ${
        Math.round(a.packing.objectCount).toLocaleString()
      } | ${a.packing.packedObjectCount.toLocaleString()} |`,
    );
    lines.push(
      `| Annual metadata/overhead | ${
        fmt(a.packing.annualObjectOverheadCost)
      } | ${fmt(a.packing.packedAnnualObjectOverheadCost)} |`,
    );
    lines.push(
      `| Annual PUT requests | ${fmt(a.packing.annualPutRequestCost)} | ${
        fmt(a.packing.packedAnnualPutRequestCost)
      } |`,
    );
    lines.push(
      `| **Estimated saving** | | **${
        fmt(a.packing.estimatedAnnualSaving)
      }/year** |`,
    );
  }
  lines.push("");

  lines.push("## Assumptions");
  lines.push("");
  for (const assumption of a.assumptions) {
    lines.push(`- ${assumption}`);
  }
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  for (const warning of a.warnings) {
    lines.push(`- ${warning}`);
  }
  lines.push("");
  lines.push(
    `_Prices for ${a.regionLabel} are from the AWS Price List API (USD) as of ${a.pricingAsOf}. ` +
      `${
        a.display.currency === "AUD"
          ? "AUD is a live USD/AUD conversion, not an AWS-published AUD price list. "
          : ""
      }Verify current prices before committing. The analysis is a planning aid, not a bill._`,
  );
  lines.push("");

  return lines.join("\n");
}

export { formatReport };
