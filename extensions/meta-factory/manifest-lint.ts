/**
 * Manifest structural lint for swamp extensions.
 *
 * Checks the manifest itself (required fields, CalVer version, placeholder
 * description, artifact declarations, `paths.base`) independently of the
 * README. Scoring lives in `quality-rubric.ts`; this module only reports
 * structure.
 *
 * @module
 */
import {
  checkInstallStep,
  checkNoMethodsSection,
  checkOrder,
  declaredArtifactFiles,
  type Manifest,
  MANUAL_ELEMENTS,
} from "./quality-rubric.ts";

/** A single manifest structural problem. */
export interface ManifestIssue {
  /** `error` fails the contract; `warning` is advisory. */
  severity: "error" | "warning";
  /** Stable rule id. */
  rule: string;
  /** Human-readable description of the problem. */
  message: string;
}

/** Result of linting a manifest. */
export interface ManifestLintResult {
  /** True when no `error`-severity issues were found. */
  ok: boolean;
  /** Every issue found. */
  issues: ManifestIssue[];
}

const PLACEHOLDER = /^(todo|tbd|n\/?a|none|untitled|-+|\.*)$/i;

/**
 * Lint a parsed manifest.
 *
 * `fileExists` is injected so callers can check declared artifacts on disk
 * without this module touching the filesystem.
 */
export function lintManifest(
  m: Manifest,
  opts: {
    fileExists?: (rel: string) => boolean;
    hasReadme?: boolean;
    /** Raw manifest YAML source, for order/install/format structural rules. */
    source?: string;
  } = {},
): ManifestLintResult {
  const issues: ManifestIssue[] = [];

  if (!m.name || !/^@[a-z0-9_-]+\/[a-z0-9_-]+$/.test(m.name)) {
    issues.push({
      severity: "error",
      rule: "name",
      message: "`name:` must be `@collective/name` (lowercase, hyphens ok)",
    });
  }
  if (!m.version) {
    issues.push({
      severity: "error",
      rule: "version",
      message: "`version:` is required",
    });
  } else if (!/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(m.version)) {
    issues.push({
      severity: "warning",
      rule: "version-calver",
      message: `\`version:\` "${m.version}" is not CalVer (YYYY.MM.DD.N)`,
    });
  }

  const desc = (m.description ?? "").trim();
  if (!desc || PLACEHOLDER.test(desc)) {
    issues.push({
      severity: "error",
      rule: "description",
      message: "`description:` is empty or a placeholder",
    });
  } else {
    // The description is the user-facing manual. Report every element it omits.
    for (const el of MANUAL_ELEMENTS) {
      if (!el.pattern.test(desc)) {
        issues.push({
          severity: "error",
          rule: `manual-${el.id}`,
          message: `\`description:\` does not cover ${el.label}`,
        });
      }
    }
    if (desc.length < 300) {
      issues.push({
        severity: "warning",
        rule: "description-short",
        message:
          "`description:` is short — expand it into the complete user manual",
      });
    }
  }

  // Order and install-step rules need the raw source layout.
  if (opts.source) {
    const order = checkOrder(opts.source);
    if (order.status !== "pass") {
      issues.push({
        severity: "error",
        rule: "manual-order",
        message: order.note ??
          "manual sections are out of order (installs must be last)",
      });
    }
    const install = checkInstallStep(opts.source);
    if (install.status !== "pass") {
      issues.push({
        severity: "error",
        rule: "install-single-step",
        message: install.note ?? "getting the extension is not a single step",
      });
    }
    const noMethods = checkNoMethodsSection(opts.source);
    if (noMethods.status !== "pass") {
      issues.push({
        severity: "error",
        rule: "no-methods-section",
        message: noMethods.note ??
          "remove the methods section from the manifest description",
      });
    }
  }

  if (!m.repository) {
    issues.push({
      severity: "warning",
      rule: "repository",
      message: "no `repository:` URL (loses repository-verified credit)",
    });
  } else if (!/^https:\/\//.test(m.repository)) {
    issues.push({
      severity: "error",
      rule: "repository-https",
      message: "`repository:` must be an HTTPS URL",
    });
  }

  const files = declaredArtifactFiles(m);
  if (files.length === 0) {
    issues.push({
      severity: "error",
      rule: "artifacts",
      message:
        "manifest declares no models/vaults/datastores/reports/workflows",
    });
  }

  if (!(m.additionalFiles ?? []).some((f) => /readme\.md$/i.test(f))) {
    issues.push({
      severity: "error",
      rule: "readme-packaged",
      message: "`README.md` is not listed in `additionalFiles:`",
    });
  }

  if (opts.hasReadme === false) {
    issues.push({
      severity: "error",
      rule: "readme-missing",
      message: "README.md not found next to the manifest",
    });
  }

  if (opts.fileExists) {
    for (const f of files) {
      if (!opts.fileExists(f)) {
        issues.push({
          severity: "error",
          rule: "artifact-exists",
          message: `declared artifact \`${f}\` not found`,
        });
      }
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}

/** Render a compact human summary of a manifest lint result. */
export function renderManifestLint(result: ManifestLintResult): string {
  if (result.issues.length === 0) return "Manifest structure OK";
  const lines = result.issues.map(
    (i) => `- [${i.severity}] ${i.rule}: ${i.message}`,
  );
  return `Manifest structure: ${result.ok ? "OK with warnings" : "FAILED"}\n${
    lines.join("\n")
  }`;
}
