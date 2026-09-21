/**
 * README structural lint for swamp extensions.
 *
 * Enforces the *shape* of the "what / install / configuration / examples /
 * details" contract: canonical sections in order, no skipped heading levels,
 * a configuration table, and non-empty fenced code blocks. Scoring lives in
 * `quality-rubric.ts`; this module only reports structure.
 *
 * @module
 */

import {
  countCodeBlocks,
  type Manifest,
  readmeHeadings,
  sectionPresent,
  SECTIONS,
} from "./quality-rubric.ts";

/** A single README structural problem. */
export interface ReadmeIssue {
  /** `error` fails the contract; `warning` is advisory. */
  severity: "error" | "warning";
  /** Stable rule id. */
  rule: string;
  /** Human-readable description of the problem. */
  message: string;
}

/** Result of linting a README against the section contract. */
export interface ReadmeLintResult {
  /** True when no `error`-severity issues were found. */
  ok: boolean;
  /** Every issue found, in document order. */
  issues: ReadmeIssue[];
}

/**
 * Lint a README against the canonical section contract.
 *
 * @param readme README markdown.
 * @param manifest Parsed manifest (used only for messaging).
 */
export function lintReadme(
  readme: string,
  manifest: Manifest,
): ReadmeLintResult {
  const issues: ReadmeIssue[] = [];
  const headings = readmeHeadings(readme);
  const configPresent = sectionPresent(
    readme,
    SECTIONS.find((s) => s.id === "config")!,
  );

  if (!readme.trimStart().startsWith("# ")) {
    issues.push({
      severity: "error",
      rule: "title",
      message: "README must start with a level-1 title (`# <name>`)",
    });
  }

  if (
    !readme.toLowerCase().includes((manifest.name ?? "").toLowerCase()) &&
    manifest.name
  ) {
    issues.push({
      severity: "warning",
      rule: "names-extension",
      message:
        `README does not mention the extension name \`${manifest.name}\``,
    });
  }

  let lastLevel = 0;
  for (const line of readme.split("\n")) {
    const m = line.match(/^(#{1,6})\s+/);
    if (!m) continue;
    const level = m[1].length;
    if (level > lastLevel + 1 && lastLevel > 0) {
      issues.push({
        severity: "warning",
        rule: "heading-levels",
        message: `heading level jumps from h${lastLevel} to h${level}`,
      });
    }
    lastLevel = level;
  }

  const order: Array<{ id: string; index: number }> = [];
  for (const spec of SECTIONS) {
    if (spec.id === "examples" && !configPresent) continue;
    const names = new Set([
      spec.heading.toLowerCase(),
      ...(spec.aliases ?? []),
    ]);
    const index = headings.findIndex((h) => names.has(h));
    if (index < 0) {
      issues.push({
        severity: "error",
        rule: "missing-section",
        message: `missing required \`## ${spec.heading}\` section`,
      });
    } else {
      order.push({ id: spec.id, index });
    }
  }

  for (let i = 1; i < order.length; i++) {
    if (order[i].index < order[i - 1].index) {
      issues.push({
        severity: "warning",
        rule: "section-order",
        message: `\`${order[i].id}\` appears before \`${order[i - 1].id}\``,
      });
    }
  }

  if (configPresent) {
    const config = readme.slice(readme.toLowerCase().indexOf("## config"));
    const hasTable = /^\|[\s:|-]+\|\s*$/m.test(config);
    if (!hasTable) {
      issues.push({
        severity: "error",
        rule: "config-table",
        message: "`## Configuration` must contain a markdown table",
      });
    }
  }

  if (countCodeBlocks(readme) < 2) {
    issues.push({
      severity: "error",
      rule: "code-blocks",
      message: "README needs at least 2 fenced code blocks",
    });
  }

  // Detect empty fenced blocks by tracking fence state line-by-line, so two
  // adjacent blocks separated only by whitespace are not mistaken for one
  // empty block.
  let inFence = false;
  let fenceHasContent = false;
  for (const line of readme.split("\n")) {
    if (/^(```|~~~)/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceHasContent = false;
      } else {
        if (!fenceHasContent) {
          issues.push({
            severity: "warning",
            rule: "empty-code-block",
            message: "README contains an empty fenced code block",
          });
        }
        inFence = false;
      }
      continue;
    }
    if (inFence && line.trim().length > 0) fenceHasContent = true;
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
  };
}

/** Render a compact human summary of a lint result. */
export function renderReadmeLint(result: ReadmeLintResult): string {
  if (result.issues.length === 0) return "README structure OK";
  const lines = result.issues.map(
    (i) => `- [${i.severity}] ${i.rule}: ${i.message}`,
  );
  return `README structure: ${result.ok ? "OK with warnings" : "FAILED"}\n` +
    lines.join("\n");
}
