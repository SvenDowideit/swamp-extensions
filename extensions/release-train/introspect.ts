/**
 * Pure parsing helpers for release-train.
 *
 * Everything here takes text (a manifest, a model source, `git` output, the
 * upstream lockfile, a review warning) and returns plain objects. No filesystem,
 * subprocess, or network access lives in this module, so every branch is
 * directly unit-testable. The impure orchestration that feeds these parsers
 * lives in `release_train.ts`.
 *
 * @module
 */

/** The subset of an extension `manifest.yaml` release-train consumes. */
export interface ManifestInfo {
  /** Fully-qualified extension name, e.g. `@svendowideit/caddy`. */
  name: string;
  /** On-disk version from the manifest. */
  version: string;
  /** Declared dependency names (may include external extensions). */
  dependencies: string[];
  /** Declared model source files. */
  models: string[];
  /** Declared workflow files. */
  workflows: string[];
  /** Declared report source files. */
  reports: string[];
  /** Files the extension ships, e.g. README, LICENSE, `test-factory.yaml`. */
  additionalFiles: string[];
  /** The manifest `description:` block (the published user manual). */
  description: string;
}

/** Strip surrounding single/double quotes from a scalar. */
function unquote(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse an extension manifest's identity, list fields, and dependencies.
 *
 * A dependency-free YAML-subset parser (mirroring `test-factory/introspect.ts`)
 * so no YAML package is bundled. It handles the two list forms used in this
 * repo (`key: [a, b]` and indented `- item`) and a `|`/`>` description block
 * without corrupting `#` characters inside documented commands.
 */
export function parseManifest(text: string): ManifestInfo {
  const manifest: ManifestInfo = {
    name: "",
    version: "",
    dependencies: [],
    models: [],
    workflows: [],
    reports: [],
    additionalFiles: [],
    description: "",
  };
  const listKeys = [
    "dependencies",
    "models",
    "workflows",
    "reports",
    "additionalFiles",
  ] as const;
  const lines = text.split("\n");
  let currentList: (typeof listKeys)[number] | null = null;
  let inDescription = false;
  const description: string[] = [];

  for (const raw of lines) {
    // Strip a trailing `# comment` only outside a description block: a
    // documented command may contain `#` and stripping it would corrupt it.
    const line = inDescription
      ? raw.replace(/\s+$/, "")
      : raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    if (/^\S/.test(line)) {
      inDescription = false;
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "description") {
        inDescription = value.startsWith(">") || value.startsWith("|") ||
          value === "";
        if (!inDescription) description.push(unquote(value));
      }
      if (key === "name") {
        manifest.name = unquote(value);
        currentList = null;
        continue;
      }
      if (key === "version") {
        manifest.version = unquote(value);
        currentList = null;
        continue;
      }
      if ((listKeys as readonly string[]).includes(key)) {
        const listKey = key as (typeof listKeys)[number];
        currentList = listKey;
        const inline = /^\[(.*)\]$/.exec(value.trim());
        manifest[listKey] = inline
          ? inline[1]
            .split(",")
            .map((s) => unquote(s.trim()))
            .filter((s) => s.length > 0)
          : [];
        continue;
      }
      currentList = null;
      continue;
    }

    if (inDescription) {
      description.push(line.replace(/\s+$/, ""));
      continue;
    }
    if (currentList) {
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (item) {
        (manifest[currentList] as string[]).push(unquote(item[1].trim()));
      }
    }
  }

  manifest.description = description.join("\n");
  return manifest;
}

/**
 * Extract the `version:` of the exported model object from a source file.
 *
 * Matches the `version:` whose value looks like a CalVer string, so a nested
 * schema version is not mistaken for the model version. Returns `""` when none
 * is found.
 */
export function parseModelVersion(source: string): string {
  const m = /version:\s*["'`](\d{4}\.\d{2}\.\d{2}\.[0-9.]+)["'`]/.exec(source);
  return m ? m[1] : "";
}

/**
 * Extract the highest `toVersion:` from a model's `upgrades:` array.
 *
 * `upgrades` entries are ordered oldest→newest in every extension in this repo,
 * so the last match is the latest upgrade target. Returns `""` when the model
 * declares no upgrades.
 */
export function parseUpgradesToVersion(source: string): string {
  const versions = [...source.matchAll(
    /toVersion:\s*["'`](\d{4}\.\d{2}\.\d{2}\.[0-9.]+)["'`]/g,
  )].map((m) => m[1]);
  return versions.length ? versions[versions.length - 1] : "";
}

/**
 * Extract a workflow YAML's `name:` field.
 *
 * Used to address a declared workflow with `swamp workflow validate`. Returns
 * `""` when the file has no explicit name (swamp then uses the file basename).
 */
export function parseWorkflowName(text: string): string {
  const m = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text);
  return m ? m[1].trim() : "";
}

/** A parsed adversarial-review filename. */
export interface ReviewRef {
  /** Collective the filename belongs to, without the leading `@`. */
  collective: string;
  /** Extension name without the collective prefix. */
  name: string;
  /** Content-hash the review is bound to. */
  hash: string;
  /** The original filename. */
  file: string;
}

/**
 * Parse an adversarial-review filename of the form
 * `_<collective>_<name>-<sha256>.json`.
 *
 * The name segment may itself contain hyphens, so the hash is taken as the
 * final dash-delimited hex run. Returns `null` for anything else.
 */
export function parseReviewFilename(file: string): ReviewRef | null {
  const base = file.replace(/\.json$/i, "");
  const m = /^_([^_]+)_(.+)-([0-9a-f]{32,})$/i.exec(base);
  if (!m) return null;
  return { collective: m[1], name: m[2], hash: m[3], file };
}

/** One entry from the `upstream_extensions.json` lockfile. */
export interface UpstreamEntry {
  /** Installed version. */
  version: string;
  /** Installed release channel, or `""` when the entry omits it (stable). */
  channel: string;
}

/**
 * Parse the pulled-extension lockfile into a name-keyed map.
 *
 * The lockfile stores installed version and (optionally) the channel the
 * version was pulled from; both feed the diagram's "installed" axis.
 */
export function parseUpstreamExtensions(
  json: string,
): Record<string, UpstreamEntry> {
  const out: Record<string, UpstreamEntry> = {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    out[name] = {
      version: typeof v.version === "string" ? v.version : "",
      channel: typeof v.channel === "string" ? v.channel : "",
    };
  }
  return out;
}

/**
 * Parse `git status --porcelain` output into the changed paths.
 *
 * Returns the path portion of each line (the two status columns and the single
 * separating space are stripped), including renamed targets. Empty input yields
 * an empty list.
 */
export function parseGitStatusPorcelain(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    // `XY path` or `XY orig -> path` (rename/copy).
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = unquote(path);
    if (path) out.push(path);
  }
  return out;
}

/**
 * Parse `git ls-files` output into the paths that are exactly `manifest.yaml`.
 *
 * Pulled/generated copies under `.swamp/` and any `node_modules/` path are
 * excluded so only the repo's own extensions are graphed.
 */
export function parseGitLsFiles(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => /(^|\/)manifest\.yaml$/.test(s))
    .filter((s) => !s.includes("node_modules/"))
    .filter((s) => !s.startsWith(".swamp/") && !s.includes("/.swamp/"));
}

/** Review-readiness derived from `swamp extension push --dry-run --json`. */
export type ReviewState = "ok" | "stale" | "missing" | "issues" | "unknown";

/** One `reviewRuleWarnings[]` entry emitted by the push preflight. */
export interface ReviewWarning {
  /** Warning rule identifier, e.g. `adversarial-review-report`. */
  ruleId?: string;
  /** Hash-bound review file the warning refers to. */
  file?: string;
  /** Human-readable warning message. */
  message?: string;
}

/**
 * Classify review readiness from a push dry-run's `reviewRuleWarnings`.
 *
 * `adversarial-review-report` means no review exists for the current content
 * hash (missing or stale); `adversarial-review-dimension-issue` means a
 * completed review flagged a problem. Any other warning (or none) is not a
 * review signal, so an empty list is `ok` and a list with no review rule is
 * `unknown`.
 */
export function reviewStateFromWarnings(
  warnings: ReviewWarning[] | undefined,
): { state: ReviewState; path: string; note: string } {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return { state: "ok", path: "", note: "" };
  }
  const missing = warnings.find((w) =>
    w.ruleId === "adversarial-review-report"
  );
  if (missing) {
    return {
      state: "missing",
      path: missing.file ?? "",
      note: missing.message ?? "",
    };
  }
  const issue = warnings.find((w) =>
    w.ruleId === "adversarial-review-dimension-issue"
  );
  if (issue) {
    return {
      state: "issues",
      path: issue.file ?? "",
      note: issue.message ?? "",
    };
  }
  return { state: "unknown", path: "", note: "" };
}
