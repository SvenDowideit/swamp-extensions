/**
 * Unit tests for the @svendowideit/fleet-inventory workflow report.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { type FleetReport, renderSummary } from "./fleet_inventory_report.ts";

function report(over: Partial<FleetReport> = {}): FleetReport {
  return {
    total: 47,
    reporting: 0,
    silent: ["a", "b"],
    coveragePercent: 0,
    byTier: { T1: 40, T2: 7 },
    byOs: { debian: 5 },
    byClass: { openwrt: 9, unifi: 2 },
    nextCommands: "swamp data get fleet inventory --json",
    ...over,
  };
}

Deno.test("renderSummary shows the gathered counts and breakdowns", () => {
  const md = renderSummary(report());
  assertStringIncludes(md, "47");
  assertStringIncludes(md, "- tier:");
  assertStringIncludes(md, "T1×40");
  assertStringIncludes(md, "- device:");
  assertStringIncludes(md, "openwrt×9");
});

Deno.test("renderSummary explains the zero-coverage case", () => {
  const md = renderSummary(report({ reporting: 0 }));
  assertStringIncludes(md, "Coverage is 0%");
  assertStringIncludes(md, "Phase 1");
});

Deno.test("renderSummary handles a missing report gracefully", () => {
  const md = renderSummary(null);
  assertStringIncludes(md, "No inventory was produced");
  assertStringIncludes(
    md,
    "swamp workflow run @svendowideit/fleet-inventory-sweep",
  );
});

Deno.test("renderSummary includes the view-commands section", () => {
  const md = renderSummary(
    report({
      nextCommands: "# explained\nswamp data get fleet inventory --json",
    }),
  );
  assertStringIncludes(md, "View the results:");
  assertStringIncludes(md, "swamp data get fleet inventory --json");
});

Deno.test("renderSummary renders empty breakdowns as an em dash", () => {
  const md = renderSummary(report({ byClass: {} }));
  assertStringIncludes(md, "- device: —");
  assertEquals(md.includes("undefined"), false);
});
