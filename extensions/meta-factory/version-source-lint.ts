/**
 * Version-source lint for swamp extension model sources.
 *
 * **Rule:** when an extension needs to know its own version at run time, it
 * must read it from the bundled `manifest.yaml` — anchor on a shipped asset via
 * `ctx.extensionFile()` and walk up to the manifest — **not** take it from the
 * model instance.
 *
 * Two values look like "the version" but are not the extension (package)
 * version in `manifest.yaml`:
 *
 * - `model.version` — the model-type / data-schema version (it drives
 *   `typeVersion` and the `upgrades` chain);
 * - `context.definition.version` — the model *instance's* own version.
 *
 * Both are per-type/per-instance and independent of the extension version; an
 * unchanged model keeps its schema version across extension releases, and the
 * two are not required to be in lock-step. Reading either one and presenting it
 * as the extension version is the mistake this rule catches.
 *
 * A genuinely legitimate type-version use — e.g. comparing an instance's
 * `typeVersion` against the installed model version for staleness — is exempted
 * with a `// swamp-quality-ignore version-source: <reason>` comment on the line
 * or on the line directly above it.
 *
 * The lint is pure with respect to its input strings, so it is cheap to unit
 * test.
 *
 * @module
 */

/** The two anti-patterns this rule reports. */
export type VersionSourceRule =
  | "model-version-used"
  | "instance-version-used";

/** A single runtime-version-source problem in a source file. */
export interface VersionSourceIssue {
  /** Always an error: the value is not the extension version. */
  severity: "error";
  /** Which anti-pattern. */
  rule: VersionSourceRule;
  /** Human-readable description, including the fix. */
  message: string;
  /** 1-based line number of the offending reference. */
  line: number;
  /** Path of the source file, when known. */
  path?: string;
}

/** One source file to lint. */
export interface VersionSourceFile {
  /** Path (repo- or extension-relative) used in messages. */
  path: string;
  /** Raw TypeScript source. */
  source: string;
}

/** `// swamp-quality-ignore version-source: <reason>` — exempt a line. */
const IGNORE_RE = /swamp-quality-ignore\s+version-source\s*:/;

/** The model-type / schema version. */
const MODEL_VERSION_RE = /\bmodel\s*\.\s*version\b/;

/** The model instance's own version. */
const INSTANCE_VERSION_RE =
  /\bcontext\s*\.\s*definition\s*\??\s*\.\s*version\b/;

/** Drop comments so prose about the rule (line or block comments) is not matched. */
function stripComments(source: string): string {
  let out = "";
  let inBlock = false;
  let inLine = false;
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      } else {
        out += " ";
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        i++;
      } else {
        out += c === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
    out += c;
  }
  return out;
}

/**
 * Lint one model source for the version-source anti-patterns.
 *
 * @param source Raw TypeScript.
 * @param path Optional path used in the issue messages.
 */
export function lintVersionSource(
  source: string,
  path?: string,
): VersionSourceIssue[] {
  const rawLines = source.split("\n");
  const lines = stripComments(source).split("\n");

  // An ignore comment exempts its own line, the one above, and the one below.
  // Read the ignore from the raw lines: `stripComments` blanks comments out.
  const exempt = new Set<number>();
  for (let i = 0; i < rawLines.length; i++) {
    if (IGNORE_RE.test(rawLines[i])) {
      exempt.add(i);
      exempt.add(i - 1);
      exempt.add(i + 1);
    }
  }

  const issues: VersionSourceIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (exempt.has(i)) continue;
    const code = lines[i];
    if (MODEL_VERSION_RE.test(code)) {
      issues.push({
        severity: "error",
        rule: "model-version-used",
        line: i + 1,
        path,
        message:
          "`model.version` is the model-type / schema version, not the " +
          "extension (package) version — read the extension version from the " +
          "bundled manifest.yaml instead (anchor on a shipped asset with " +
          "`ctx.extensionFile()` and walk up to `manifest.yaml`). For a " +
          "legitimate type-version use (e.g. staleness), add " +
          "`// swamp-quality-ignore version-source: <reason>`.",
      });
    }
    if (INSTANCE_VERSION_RE.test(code)) {
      issues.push({
        severity: "error",
        rule: "instance-version-used",
        line: i + 1,
        path,
        message:
          "`context.definition.version` is the model instance's version, not " +
          "the extension (package) version — read the extension version from " +
          "the bundled manifest.yaml instead (anchor on a shipped asset with " +
          "`ctx.extensionFile()` and walk up to `manifest.yaml`).",
      });
    }
  }
  return issues;
}

/** Lint every source file; the issues carry each file's path. */
export function lintVersionSources(
  files: VersionSourceFile[],
): VersionSourceIssue[] {
  const out: VersionSourceIssue[] = [];
  for (const file of files) {
    out.push(...lintVersionSource(file.source, file.path));
  }
  return out;
}
