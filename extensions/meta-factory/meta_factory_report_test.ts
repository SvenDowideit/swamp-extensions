/**
 * Unit tests for the meta-factory report renderers.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  renderDefinitions,
  renderScore,
  renderSummary,
} from "./meta_factory_report.ts";

Deno.test("renderScore marks a below-threshold extension", () => {
  const md = renderScore({
    name: "@me/bad",
    manifest: "bad/manifest.yaml",
    score: 30,
    grade: "F",
    earned: 30,
    earnedMax: 100,
    wellDocumented: false,
    checks: [{
      id: "sections",
      label: "Canonical README sections",
      earned: 1,
      max: 5,
      status: "partial",
      note: "missing `## Install`",
    }],
    coverage: [
      { type: "@me/bad", name: "run", documented: true },
      { type: "@me/bad", name: "sync", documented: false },
    ],
    examples: [{
      source: "manifest",
      command: "swamp model method run my-model run",
      functional: true,
      explained: true,
    }],
    nextActions: ["sections: missing `## Install`"],
    manifestLint: [{ severity: "error", rule: "description", message: "TODO" }],
    readmeLint: [{
      severity: "warning",
      rule: "heading-levels",
      message: "jump",
    }],
    definitionIssues: [{
      severity: "error",
      rule: "id-duplicate",
      message: "copied",
      path: "models/copy.yaml",
    }],
  });
  assertStringIncludes(md, "below threshold");
  assertStringIncludes(md, "Undocumented methods");
  assertStringIncludes(md, "@me/bad.sync");
  assertStringIncludes(md, "Structure issues");
  assertStringIncludes(md, "definition/id-duplicate");
  assertStringIncludes(md, "Next actions");
});

Deno.test("renderDefinitions marks a failed scan and lists the fix", () => {
  const md = renderDefinitions({
    root: "/repo",
    scanned: 2,
    errorCount: 1,
    warningCount: 0,
    auditAvailable: true,
    auditHours: 168,
    confirmedCount: 1,
    definitions: [{
      path: "models/copy.yaml",
      kind: "model",
      name: "copy",
      id: "4f616d26-21d2-466d-b5a6-78d0b9065f71",
      expectedCommand: "swamp model create @me/tool copy",
      ok: false,
    }],
    issues: [{
      path: "models/copy.yaml",
      severity: "error",
      rule: "id-duplicate",
      message: "already used",
    }],
  });
  assertStringIncludes(md, "FAILED");
  assertStringIncludes(md, "id-duplicate");
  assertStringIncludes(md, "swamp model create @me/tool copy");
  assertStringIncludes(md, "confirmed a creation command for **1**");
});

Deno.test("renderDefinitions notes when the audit timeline is unavailable", () => {
  const md = renderDefinitions({
    root: "/repo",
    scanned: 1,
    errorCount: 0,
    warningCount: 0,
    auditAvailable: false,
    definitions: [],
    issues: [],
  });
  assertStringIncludes(md, "timeline unavailable");
});

Deno.test("renderSummary sorts lowest score first", () => {
  const md = renderSummary({
    root: "extensions",
    threshold: 75,
    count: 2,
    averageScore: 60,
    passCount: 1,
    failCount: 1,
    belowThreshold: [{
      name: "@me/bad",
      manifest: "bad/manifest.yaml",
      score: 20,
      topIssues: ["manifest: TODO"],
    }],
    scores: [
      {
        name: "@me/good",
        manifest: "good/manifest.yaml",
        score: 90,
        grade: "A",
      },
      { name: "@me/bad", manifest: "bad/manifest.yaml", score: 20, grade: "F" },
    ],
  });
  const badIdx = md.indexOf("@me/bad | 20/100");
  const goodIdx = md.indexOf("@me/good | 90/100");
  assertEquals(badIdx >= 0 && goodIdx >= 0 && badIdx < goodIdx, true);
  assertStringIncludes(md, "Below threshold (1)");
});

Deno.test("renderSummary omits the failure section when all pass", () => {
  const md = renderSummary({
    root: "extensions",
    threshold: 75,
    count: 1,
    averageScore: 95,
    passCount: 1,
    failCount: 0,
    belowThreshold: [],
    scores: [
      {
        name: "@me/good",
        manifest: "good/manifest.yaml",
        score: 95,
        grade: "A",
      },
    ],
  });
  assertEquals(md.includes("Below threshold"), false);
});
