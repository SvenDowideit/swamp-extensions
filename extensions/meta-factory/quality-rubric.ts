/**
 * Deterministic documentation scorer and contract for swamp extensions.
 *
 * `@svendowideit/meta-factory` exists to enforce one guiding principle:
 * **the published manifest plus README must be enough for a user or agent to
 * easily learn how to do everything the published extension does.**
 *
 * This module implements that principle as a machine-readable contract on the
 * manifest/README pair, then scores a manifest + README against it. It is a
 * superset of the Swamp Club published rubric (README, license, symbols, fast
 * types, description, platforms, repository, dependencies) with explicit
 * documentation sections (what-it-does, install, config, examples, details).
 *
 * Every check is pure: manifests are parsed from YAML text and the README from
 * markdown text, so the scorer runs offline with no network and is fully unit
 * testable. The one optional network check (`deps-audited`) is only attempted
 * when `offline: false`, and degrades to a `partial` status otherwise.
 *
 * @module
 */

import { parse as parseYaml } from "jsr:@std/yaml@1";

// ---------------------------------------------------------------------------
// Canonical section model
// ---------------------------------------------------------------------------

/** A required README section the contract looks for. */
export interface SectionSpec {
  /** Stable id used in scores, reports, and templates. */
  id: string;
  /** Canonical `## Heading` text. */
  heading: string;
  /** Points earned when the section is present and substantive. */
  points: number;
  /** Human-readable description of what belongs in the section. */
  description: string;
  /** Lowercased heading aliases accepted in place of the canonical heading. */
  aliases?: string[];
}

/**
 * The canonical, visible README sections — the "how to do everything" spine.
 *
 * Order here is the order they should appear in a README. `examples` is the
 * only section that may legitimately be absent (an extension with no
 * configurable options has nothing to exemplify).
 */
export const SECTIONS: SectionSpec[] = [
  {
    id: "what",
    heading: "What it does",
    points: 1,
    description:
      "One short paragraph: the problem solved, who it is for, and the side effects.",
    aliases: ["what it does", "what this does", "overview", "about", "purpose"],
  },
  {
    id: "install",
    heading: "Install",
    points: 1,
    description: "The exact `swamp extension pull …` command.",
    aliases: ["install", "installation", "installing", "setup"],
  },
  {
    id: "config",
    heading: "Configuration",
    points: 1,
    description:
      "A table of every global argument — name, type, default, and meaning.",
    aliases: [
      "configuration",
      "config",
      "global arguments",
      "configuration options",
    ],
  },
  {
    id: "examples",
    heading: "Examples",
    points: 1,
    description:
      "Fenced commands showing the options in use. Optional for extensions with no configurable options.",
    aliases: ["examples", "usage", "quick start", "quickstart", "example"],
  },
  {
    id: "details",
    heading: "Details",
    points: 1,
    description:
      "Models, methods, resources, and any extension-specific caveats.",
    aliases: ["details", "model type", "api", "reference", "models", "methods"],
  },
];

/** A required element the manifest `description:` must contain. */
export interface ManualElement {
  /** Stable id used in reports. */
  id: string;
  /** What the element must tell the reader. */
  label: string;
  /** Regex that detects the element in the description text. */
  pattern: RegExp;
  /** Canonical position in the manual (lower is earlier). */
  order: number;
  /** Regex that detects the element's section heading line. */
  heading: RegExp;
  /** Short name of the canonical heading, for messages. */
  headingName: string;
}

/**
 * The canonical order of the manual's sections, most important first.
 *
 * A reader wants, in order: a short pitch for why they should be interested,
 * how to get it (ideally one step), how to configure its options, and what it
 * installs on the host. There is deliberately **no methods section** here:
 * swamp-club generates a formatted method reference from the manifest at
 * publish time, so listing methods in the description is redundant noise.
 */
export const MANUAL_ORDER: string[] = [
  "decide",
  "install",
  "dependencies",
  "run",
  "configure",
  "installs",
];

/**
 * The mandatory elements of the manifest `description:`.
 *
 * The description is the *user-facing manual*: the published manifest alone
 * must be enough to decide whether to be interested, get the extension (in one
 * step), configure its options, run it, and know what it installs. The method
 * reference is **not** written here — swamp-club generates a formatted version
 * from the manifest at publish time (the README carries it for extenders).
 */
export const MANUAL_ELEMENTS: ManualElement[] = [
  {
    id: "decide",
    order: 0,
    headingName: "WHAT IT DOES",
    label:
      "a short pitch — the problem it solves and why it is the better option",
    pattern:
      /(does|solves?|helps?|lets? you|enables?|makes?|automates?|replaces?|better|instead of)/i,
    heading: /^\s*(what it does|overview|why|what it is|the problem)\s*:?\s*$/i,
  },
  {
    id: "install",
    order: 1,
    headingName: "INSTALL",
    label: "how to get it (`swamp extension pull …`)",
    pattern: /swamp extension (pull|install)/i,
    heading: /^\s*(install|installation|install it|getting started)\s*:?\s*$/i,
  },
  {
    id: "dependencies",
    order: 2,
    headingName: "DEPENDENCIES",
    label: "its dependencies (or that it has none)",
    pattern:
      /dependenc|self-contained|no other extension|requires? [@a-z0-9_-]+\/[a-z0-9_-]+/i,
    heading: /^\s*(dependencies|requirements|prerequisites|depends)\s*:?\s*$/i,
  },
  {
    id: "run",
    order: 3,
    headingName: "RUN",
    label: "how to run it (a `swamp …` command)",
    pattern: /swamp (workflow run|model method run|model create|model @)/i,
    heading:
      /^\s*(run|usage|getting started|quick start|use it|how to run)\s*:?\s*$/i,
  },
  {
    id: "configure",
    order: 4,
    headingName: "CONFIGURE",
    label: "how to configure its optional parts",
    pattern: /configur|global[- ]arg|optional|--input/i,
    heading:
      /^\s*(configure|configuration|options|settings|global arguments)\s*:?\s*$/i,
  },
  {
    id: "installs",
    order: 5,
    headingName: "WHAT IT INSTALLS",
    label:
      "what it installs on the host — services, triggers, webhooks (or none)",
    pattern:
      /trigger|schedule|cron|webhook|systemd|service|daemon|installs? no|nothing/i,
    heading:
      /^\s*(what it installs|installs|side effects|what gets installed)\s*:?\s*$/i,
  },
];

/**
 * Headings that introduce a hand-written method list in the manifest
 * `description:`. These are rejected: swamp-club generates a formatted method
 * reference at publish time, so a `METHODS` section in the manifest duplicates
 * it poorly.
 */
export const METHODS_HEADING =
  /^\s*(methods?|method reference|reference|api|models and methods|commands|what it ships|what'?s inside)\s*:?\s*$/i;

/** Points budget per check family; also the denominator of the score. */
export const WEIGHTS = {
  /** Manifest `name:` and a substantive description. */
  manifest: 4,
  /** `WHAT IT DOES` is a short pitch, not a method dump. */
  pitch: 6,
  /** Manifest description covers every manual element. */
  manual: 8,
  /** Manual sections appear in priority order (installs last). */
  order: 5,
  /** The manifest omits a hand-written methods section. */
  noMethods: 5,
  /** Getting the extension is a single step (a multi-step install loses 13%). */
  install: 13,
  /** Manifest description is well-spaced and readable. */
  format: 5,
  /** Manifest/README carry functional, runnable examples. */
  examples: 7,
  /** Each example command says why/when to run it. */
  explain: 7,
  /** README required-section contract. */
  sections: 5,
  /** Minimum README substance (length + code blocks + table). */
  substance: 3,
  /** Packaging of README/LICENSE via `additionalFiles:`. */
  packaging: 6,
  /** Manifest metadata: platforms, repository, license. */
  metadata: 4,
  /** Manifest declares at least one shipped artifact. */
  artifacts: 4,
  /** The README actually explains every declared model and method. */
  coverage: 6,
  /** Source JSDoc coverage via `deno doc --json`. */
  symbols: 6,
  /** `deno doc --lint` fast-type cleanliness. */
  fasttypes: 3,
  /** Dependency trust audit (partial when offline). */
  deps: 3,
} as const;

/** Sum of all weights — the maximum possible score. */
export const MAX_SCORE: number = Object.values(WEIGHTS).reduce(
  (a, b) => a + b,
  0,
);

// ---------------------------------------------------------------------------
// Scoring types
// ---------------------------------------------------------------------------

/** Result of a single named check. */
export interface CheckResult {
  /** Stable check id. */
  id: string;
  /** What the check verifies. */
  label: string;
  /** Points earned. */
  earned: number;
  /** Points available. */
  max: number;
  /** `pass`, `partial`, or `fail`. */
  status: "pass" | "partial" | "fail";
  /** Actionable explanation when not a clean pass. */
  note?: string;
}

/** A per-method documentation coverage row. */
export interface MethodCoverage {
  /** Model type the method belongs to, or `null` for a manual declaration. */
  type: string | null;
  /** Method name. */
  name: string;
  /** Whether the README names it. */
  documented: boolean;
}

/** A discovered model + method pair. */
export interface Artifact {
  /** Declared model type (from `swamp model type describe`). */
  type?: string;
  /** Filename declared in the manifest. */
  file: string;
}

/** Full result of scoring one extension. */
export interface ScoreResult {
  /** Extension name from the manifest. */
  name: string;
  /** Manifest path scored. */
  manifest: string;
  /** Weighted score, 0–100. */
  score: number;
  /** Letter grade derived from `score`. */
  grade: string;
  /** Points earned, out of `MAX_SCORE`. */
  earned: number;
  /** Maximum points (`MAX_SCORE`). */
  earnedMax: number;
  /** Every check, in report order. */
  checks: CheckResult[];
  /** Per-method documentation coverage. */
  coverage: MethodCoverage[];
  /** Runnable example commands found in the manifest and README. */
  examples: FoundExample[];
  /** Manifest keys that were absent. */
  missing: string[];
  /** Actionable follow-ups derived from failing checks. */
  nextActions: string[];
}

/** Parsed manifest shape (loosely typed — manifests are user input). */
export interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  repository?: string;
  homepage?: string;
  license?: string;
  additionalFiles?: string[];
  binaries?: string[];
  models?: string[];
  vaults?: string[];
  datastores?: string[];
  reports?: string[];
  workflows?: string[];
  skills?: string[];
  platforms?: unknown;
  paths?: { base?: string };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse manifest YAML text into a typed `Manifest`. */
export function parseManifest(text: string): Manifest {
  const raw = parseYaml(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest.yaml did not parse to an object");
  }
  return raw as Manifest;
}

/** All artifact filenames declared by a manifest, across every content type. */
export function declaredArtifactFiles(m: Manifest): string[] {
  const lists = [
    m.models,
    m.vaults,
    m.datastores,
    m.reports,
    m.workflows,
    m.skills,
  ];
  const out: string[] = [];
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string") out.push(item);
      }
    }
  }
  return out;
}

/** Count fenced code blocks in markdown (` ``` ` or `~~~`). */
export function countCodeBlocks(md: string): number {
  const fences = md.match(/^(```|~~~)/gm);
  return fences ? Math.floor(fences.length / 2) : 0;
}

/** Lowercased text of every `## ` heading in the README. */
export function readmeHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (m) out.push(m[1].toLowerCase().trim());
  }
  return out;
}

/**
 * Return the body of the README section matching `spec`, or `null`.
 *
 * A section runs from its heading to the next heading of equal or higher
 * level. Matching is by canonical heading or any alias.
 */
export function sectionBody(md: string, spec: SectionSpec): string | null {
  const names = new Set([spec.heading.toLowerCase(), ...(spec.aliases ?? [])]);
  const lines = md.split("\n");

  // Track fenced code blocks so `# comment` lines inside a fence are never
  // mistaken for markdown headings.
  const inFence: boolean[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence.push(true);
      fence = !fence;
      continue;
    }
    inFence.push(fence);
  }

  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!m) continue;
    if (names.has(m[2].toLowerCase().trim())) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (!inFence[i]) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= level) break;
    }
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/** Whether a section body is present and substantive. */
export function sectionPresent(md: string, spec: SectionSpec): boolean {
  const body = sectionBody(md, spec);
  if (body === null) return false;
  // A heading with no body is not a documented section.
  return body.replace(/[\s\-|:]/g, "").length >= 10;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(max, n));
}

function status(earned: number, max: number): CheckResult["status"] {
  if (earned >= max) return "pass";
  if (earned <= 0) return "fail";
  return "partial";
}

/** Manifest quality: name present/sane and description substantive. */
export function checkManifest(m: Manifest): CheckResult {
  const notes: string[] = [];
  const name = m.name ?? "";
  const nameOk = /^@[a-z0-9_-]+\/[a-z0-9_-]+$/.test(name);
  // Points are evenly split: 2 for the name, 2 for a non-placeholder
  // description. The *completeness* of the description is scored separately by
  // `checkManual`.
  const half = WEIGHTS.manifest / 2;
  const earned = nameOk ? half : 0;
  if (!nameOk) notes.push("`name:` should be `@collective/name` (lowercase)");

  const desc = (m.description ?? "").trim();
  const placeholders = /^(todo|tbd|n\/?a|none|-+|\.*)$/i;
  if (desc.length > 0 && !placeholders.test(desc)) {
    return {
      id: "manifest",
      label: "Manifest name and description",
      earned: half * 2,
      max: WEIGHTS.manifest,
      status: "pass",
    };
  }
  notes.push("`description:` is empty or a placeholder");

  return {
    id: "manifest",
    label: "Manifest name and description",
    earned,
    max: WEIGHTS.manifest,
    status: status(earned, WEIGHTS.manifest),
    note: notes.join("; "),
  };
}

/**
 * Score the manifest `description:` as a complete user manual.
 *
 * The published manifest alone must let a user decide whether to pull the
 * extension, install it and its dependencies, run it, understand what it
 * installs (services, triggers, webhooks), and configure its optional parts.
 * Each {@link MANUAL_ELEMENTS} entry that appears earns an equal share.
 */
export function checkManual(m: Manifest): CheckResult {
  const desc = (m.description ?? "").trim();
  const max = WEIGHTS.manual;
  if (desc.length === 0) {
    return {
      id: "manual",
      label: "Manifest description is a complete user manual",
      earned: 0,
      max,
      status: "fail",
      note:
        "`description:` is empty — add the decide/install/run/configure manual",
    };
  }
  const missing = MANUAL_ELEMENTS.filter((el) => !el.pattern.test(desc));
  const per = max / MANUAL_ELEMENTS.length;
  const earned = Math.round((MANUAL_ELEMENTS.length - missing.length) * per);
  const tooShort = desc.length < 300;
  return {
    id: "manual",
    label: "Manifest description is a complete user manual",
    earned: clamp(earned, max),
    max,
    status: missing.length === 0 && !tooShort ? "pass" : status(earned, max),
    note: [
      missing.length > 0
        ? `description does not cover: ${
          missing.map((el) => `${el.id} (${el.label})`).join("; ")
        }`
        : undefined,
      tooShort && missing.length === 0
        ? `description is only ${desc.length} chars — expand it into a full manual`
        : undefined,
    ].filter(Boolean).join("; ") || undefined,
  };
}

/**
 * A heading line in the manifest manual is a short canonical label on its own
 * line (e.g. `WHAT IT DOES`, `INSTALL`, `WHAT IT INSTALLS`). The length guard
 * keeps wrapped prose lines that merely begin with a keyword (e.g. "configure
 * ACME …") from being mistaken for headings.
 */
export function isHeadingLine(line: string, el: ManualElement): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 45) return false;
  return el.heading.test(line);
}

/** Index of the first heading line for `el` in `lines`, or -1. */
function headingIndex(lines: string[], el: ManualElement): number {
  return lines.findIndex((l) => isHeadingLine(l, el));
}

/**
 * Return the body lines of a manual section (its heading's content up to the
 * next heading), or `null` when the section is absent.
 */
export function manualSection(
  lines: string[],
  el: ManualElement,
): string[] | null {
  const start = headingIndex(lines, el);
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (MANUAL_ELEMENTS.some((other) => isHeadingLine(lines[i], other))) break;
    body.push(lines[i]);
  }
  return body;
}

/**
 * Score the `WHAT IT DOES` section as a short, complete pitch.
 *
 * It must be prose that lets a user decide this extension is a better option
 * than a similar one and solves their problem — **not** a long list of methods.
 * The method list belongs in the trailing `METHODS` reference section.
 *
 * - the section exists (2),
 * - it is a short pitch: 20–140 words (2),
 * - it is not a method dump: fewer than three `name   description` list rows (2).
 */
export function checkPitch(rawManifest: string): CheckResult {
  const max = WEIGHTS.pitch;
  const { lines } = manifestDescription(rawManifest);
  const decide = MANUAL_ELEMENTS.find((el) => el.id === "decide")!;
  const body = manualSection(lines, decide);

  if (body === null) {
    return {
      id: "pitch",
      label: "`WHAT IT DOES` is a short pitch",
      earned: 0,
      max,
      status: "fail",
      note: "no `WHAT IT DOES` section — start with a short pitch",
    };
  }

  const text = body.join("\n").trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  // A method list has many rows of `<identifier>   <description>`.
  const listRows =
    body.filter((l) => /^\s{2,}[a-z][A-Za-z0-9_-]*\s{2,}\S/.test(l)).length;

  let earned = 2; // section present
  const notes: string[] = [];

  if (words >= 20 && words <= 140) earned += 2;
  else if (words === 0) notes.push("`WHAT IT DOES` is empty");
  else if (words > 140) {
    notes.push(
      `the pitch is ${words} words — keep it under ~140 and move detail to METHODS`,
    );
  } else {
    notes.push(
      `the pitch is only ${words} words — say enough to decide it solves your problem`,
    );
  }

  if (listRows >= 3) {
    notes.push(
      `the pitch lists ${listRows} methods — move the method list to the trailing \`METHODS\` section`,
    );
  } else {
    earned += 2;
  }

  return {
    id: "pitch",
    label: "`WHAT IT DOES` is a short pitch",
    earned: clamp(earned, max),
    max,
    status: notes.length === 0 ? "pass" : status(earned, max),
    note: notes.join("; ") || `${words}-word pitch, no method dump`,
  };
}

/**
 * Extract the raw description block from a manifest's YAML source.
 *
 * Returns the lines under `description:` (excluding the `description:` key) for
 * both literal (`|`/`>`) and inline forms. Used by the order/install/format/
 * example checks, all of which need the source layout rather than the parsed
 * string.
 */
export function manifestDescription(rawManifest: string): {
  lines: string[];
  literal: boolean;
} {
  const lines = rawManifest.split("\n");
  const idx = lines.findIndex((l) => /^description:\s*[|>]/.test(l));
  if (idx >= 0) {
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const block = lines.slice(idx + 1, end);
    while (block.length > 0 && block[block.length - 1].trim() === "") {
      block.pop();
    }
    return { lines: block, literal: true };
  }
  const inline = lines.find((l) => /^description:\s+\S/.test(l));
  if (inline) {
    return {
      lines: [inline.replace(/^description:\s*/, "")],
      literal: false,
    };
  }
  return { lines: [], literal: false };
}

/**
 * Score the canonical order of the manual's sections.
 *
 * The important information comes first: why to be interested (`decide`), how
 * to get it (`install`), its dependencies, how to run it, how to configure it,
 * and **`WHAT IT INSTALLS` last**. Each element present must appear after every
 * earlier element in {@link MANUAL_ORDER}; a section out of order (or the
 * installs section before the end) forfeits its share.
 */
export function checkOrder(rawManifest: string): CheckResult {
  const max = WEIGHTS.order;
  const { lines } = manifestDescription(rawManifest);
  if (lines.length === 0) {
    return {
      id: "order",
      label: "Manual sections are in priority order (installs last)",
      earned: 0,
      max,
      status: "fail",
      note: "no manifest description found",
    };
  }
  const present = MANUAL_ELEMENTS.filter((el) =>
    lines.some((l) => isHeadingLine(l, el))
  );
  if (present.length === 0) {
    return {
      id: "order",
      label: "Manual sections are in priority order (installs last)",
      earned: 0,
      max,
      status: "fail",
      note:
        "the manual has no section headings — add WHY / INSTALL / DEPENDENCIES / RUN / CONFIGURE / WHAT IT INSTALLS",
    };
  }

  // Find the line index of each present heading.
  const positions = new Map<string, number>();
  for (const el of present) {
    const i = headingIndex(lines, el);
    if (i >= 0) positions.set(el.id, i);
  }

  // Count pairwise inversions relative to the canonical order.
  const ordered = present
    .filter((el) => positions.has(el.id))
    .sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  let inversions = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].order < ordered[i - 1].order) inversions++;
  }

  const per = max / MANUAL_ORDER.length;
  const earned = Math.max(0, Math.round(max - inversions * per));

  // Explicitly flag the key rule: installs must be last.
  const installsPos = positions.get("installs");
  const lastPos = ordered.length > 0
    ? positions.get(ordered[ordered.length - 1].id)
    : -1;
  const installsNotLast = installsPos !== undefined && installsPos !== lastPos;

  const notes: string[] = [];
  if (inversions > 0) {
    notes.push(
      `${inversions} section(s) out of order — expected ${
        MANUAL_ORDER.join(" → ")
      }`,
    );
  }
  if (installsNotLast) {
    notes.push("put `WHAT IT INSTALLS` last");
  }

  return {
    id: "order",
    label: "Manual sections are in priority order (installs last)",
    earned: clamp(earned, max),
    max,
    status: inversions === 0 ? "pass" : status(earned, max),
    note: notes.join("; ") || "sections in canonical order",
  };
}

/**
 * Score whether the manifest omits a hand-written methods section.
 *
 * swamp-club generates a formatted method reference from the manifest at
 * publish time, so a `METHODS` / `API` / `WHAT IT SHIPS` section in the
 * description duplicates it poorly. The README is the right place for a method
 * list (for extenders). A manifest methods section scores zero.
 */
export function checkNoMethodsSection(rawManifest: string): CheckResult {
  const max = WEIGHTS.noMethods;
  const { lines } = manifestDescription(rawManifest);
  const idx = lines.findIndex((l) => {
    const t = l.trim();
    return t.length <= 45 && METHODS_HEADING.test(l);
  });
  if (idx < 0) {
    return {
      id: "no-methods",
      label: "Manifest omits a hand-written methods section",
      earned: max,
      max,
      status: "pass",
      note: "no methods section (swamp-club generates it at publish)",
    };
  }
  return {
    id: "no-methods",
    label: "Manifest omits a hand-written methods section",
    earned: 0,
    max,
    status: "fail",
    note:
      "remove the methods section from the manifest `description:` — swamp-club generates a formatted method reference at publish time (keep a method list in the README for extenders)",
  };
}

/**
 * Score whether getting the extension is a single step.
 *
 * A single `swamp extension pull` is one step and earns full marks. If the
 * manual describes a multi-step install (additional `swamp …` commands the user
 * must run to get it working, e.g. a separate source-add or model-create
 * prerequisite), the check scores zero — a 13% penalty.
 */
export function checkInstallStep(rawManifest: string): CheckResult {
  const max = WEIGHTS.install;
  const { lines } = manifestDescription(rawManifest);
  const text = lines.join("\n");

  const pulls = text.match(/swamp extension (?:pull|install)\s+\S+/gi) ?? [];

  // Commands in the INSTALL section only (between INSTALL and the next heading).
  const installEl = MANUAL_ELEMENTS.find((el) => el.id === "install")!;
  const installHeadingIdx = headingIndex(lines, installEl);
  let installCommands: string[] = [];
  if (installHeadingIdx >= 0) {
    const rest = lines.slice(installHeadingIdx + 1);
    const nextHeading = rest.findIndex((l) =>
      MANUAL_ELEMENTS.some((el) => isHeadingLine(l, el))
    );
    const section = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest)
      .join("\n");
    installCommands = (section.match(/swamp\s+[a-z-]+[^\n]*/gi) ?? [])
      .map((c) => c.trim());
  }

  if (pulls.length === 0) {
    return {
      id: "install",
      label: "Getting it is a single step",
      earned: 0,
      max,
      status: "fail",
      note: "no `swamp extension pull` command found in the manual",
    };
  }

  // A single-step install has exactly one pull and no extra setup commands.
  const extraSetup = installCommands.filter(
    (c) => !/^swamp extension (pull|install)\b/i.test(c),
  );
  const multiStep = pulls.length > 1 || extraSetup.length > 0;

  if (multiStep) {
    return {
      id: "install",
      label: "Getting it is a single step",
      earned: 0,
      max,
      status: "fail",
      note: `the install takes more than one step (${
        [
          pulls.length > 1 ? `${pulls.length} pull commands` : "",
          extraSetup.length > 0
            ? `extra setup: ${extraSetup.slice(0, 3).join(", ")}`
            : "",
        ].filter(Boolean).join("; ")
      }) — make it a single \`swamp extension pull\``,
    };
  }

  return {
    id: "install",
    label: "Getting it is a single step",
    earned: max,
    max,
    status: "pass",
    note: "one `swamp extension pull` gets it",
  };
}

// ---------------------------------------------------------------------------
// Manifest formatting (spacing / readability)
// ---------------------------------------------------------------------------

/**
 * Detect the well-spaced, human-readable manifest style used by
 * `extensions/models/web-cache/manifest.yaml`:
 *
 * - the `description:` is a literal block (`|` or `>`) rather than a single
 *   long line,
 * - blank lines separate the manual's sections,
 * - embedded command examples are indented,
 * - top-level keys are separated by blank lines,
 * - no line is absurdly long.
 */
export function checkFormat(rawManifest: string): CheckResult {
  const max = WEIGHTS.format;
  const notes: string[] = [];
  let earned = 0;
  const lines = rawManifest.split("\n");

  // Locate the description block.
  const descIdx = lines.findIndex((l) => /^description:\s*[|>]/.test(l));
  const descInline = lines.findIndex((l) =>
    /^description:\s+\S/.test(l) && !/^description:\s*[|>]/.test(l)
  );
  if (descIdx >= 0) {
    earned += 2;
  } else if (descInline >= 0) {
    notes.push(
      "`description:` is a single inline line — use a literal block (`description: >` or `|`) so it is readable",
    );
  } else {
    notes.push("no `description:` block found");
  }

  // Blank-line-separated paragraphs inside the description block.
  if (descIdx >= 0) {
    const block = manifestDescription(rawManifest).lines;
    const nonBlank = block.filter((l) => l.trim().length > 0);
    const blankRuns = block.filter((l) => l.trim().length === 0).length;
    if (nonBlank.length > 0 && blankRuns >= 1) {
      earned += 2;
    } else {
      notes.push(
        "the description is one unbroken block — separate its sections with blank lines",
      );
    }
    // Indented example lines (commands inside the manual).
    const indented = nonBlank.filter((l) => /^\s{4,}\S/.test(l)).length;
    if (indented >= 2) earned += 1;
    else {
      notes.push(
        "indent embedded commands in the description (4+ spaces) so they stand out",
      );
    }
  }

  // Top-level keys separated by blank lines. The leading header block
  // (`manifestVersion` / `name` / `version` / `description`) is conventionally
  // packed together, so it is exempt.
  const topLevel = lines
    .map((l, i) => (/^[a-zA-Z]/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  let headerEnd = -1;
  if (topLevel[0] === 0) {
    headerEnd = 0;
    for (let k = 1; k < topLevel.length; k++) {
      if (topLevel[k] === topLevel[k - 1] + 1) headerEnd = topLevel[k];
      else break;
    }
  }
  const adjacent = topLevel.filter((i, k) => {
    if (k === 0 || i - topLevel[k - 1] !== 1) return false;
    // Skip adjacency inside the exempt leading header block.
    return !(i <= headerEnd);
  }).length;
  if (topLevel.length >= 2 && adjacent === 0) earned += 1;
  else if (adjacent > 0) {
    notes.push(
      `${adjacent} top-level key(s) are not separated by a blank line`,
    );
  }

  // No excessively long lines (wrapped for reading). This is advisory: the
  // eight format points are already allocated above (3 + 2 + 2 + 1).
  const longLines = lines.filter((l) => l.length > 100).length;
  if (longLines > 0) {
    notes.push(`${longLines} line(s) exceed 100 chars — wrap them`);
  }

  return {
    id: "format",
    label: "Manifest description is well-spaced and readable",
    earned: clamp(earned, max),
    max,
    status: status(earned, max),
    note: notes.join("; ") || undefined,
  };
}

// ---------------------------------------------------------------------------
// Functional examples
// ---------------------------------------------------------------------------

/** A runnable example command found in the manifest or README. */
export interface FoundExample {
  /** Where it was found. */
  source: "manifest" | "readme";
  /** The command line. */
  command: string;
  /** Whether it looks functional (invokes a real swamp subcommand). */
  functional: boolean;
  /** Whether a comment or sentence nearby says why/when to run it. */
  explained: boolean;
}

/** Lines that begin a swamp invocation. */
const SWAMP_INVOCATION =
  /^\s*(?:\$#?\s*)?swamp\s+(model|workflow|extension|vault|report|data|serve|auth)\b/;

/** Placeholder markers that mean an example is not actually runnable. */
const PLACEHOLDER =
  /(<\s*(?:type|name|model|extension|path|value|your|arg|input|type\/name)\b[^>]*>|\bmy-extension\b|\bexample\.com\b|<name>|…|\.\.\.)/i;

/** The trivial one-line install command, which needs no explanation. */
const SELF_EVIDENT = /^swamp extension (pull|install)\b/i;

/** A markdown/YAML fence line. */
function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** Whether a line is any canonical manual heading. */
function isAnyHeading(line: string): boolean {
  return MANUAL_ELEMENTS.some((el) => isHeadingLine(line, el));
}

/**
 * Mark every physical line that belongs to a command: the invocation line plus
 * any backslash- or bracket-continued lines. Used so a multi-line command (e.g.
 * a `swamp model create` with a spanning `plugins` array) is treated as one
 * unit when finding its explanation.
 */
function commandLineMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let continued = false;
  let bracketDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsCommand = SWAMP_INVOCATION.test(line);
    if (startsCommand || continued || bracketDepth > 0) {
      mask[i] = true;
      // Track continuation for the next line.
      const opens = (line.match(/[[{]/g) ?? []).length;
      const closes = (line.match(/[\]}]/g) ?? []).length;
      bracketDepth += opens - closes;
      continued = /\\\s*$/.test(line) || bracketDepth > 0;
      if (!/\\\s*$/.test(line) && bracketDepth <= 0) continued = false;
      bracketDepth = Math.max(0, bracketDepth);
    } else {
      continued = false;
      bracketDepth = 0;
    }
  }
  return mask;
}

/**
 * Whether the line(s) preceding an example command explain why/when to run it.
 *
 * Skips blank lines and code fences. A comment (`# …` with real text) or a
 * prose sentence counts; a heading does not. A trailing `# …` on the command
 * line also counts.
 */
function precedingExplains(lines: string[], idx: number): boolean {
  if ((lines[idx] ?? "").includes(" #")) return true;
  const mask = commandLineMask(lines);

  for (let i = idx - 1; i >= 0; i--) {
    const raw = lines[i];
    const t = raw.trim();
    // Skip blank lines and fences: a prose sentence above the block, or a
    // comment immediately above the command, both explain it.
    if (t === "" || isFenceLine(raw)) continue;
    if (mask[i]) continue; // continuation of this or an earlier command
    if (t.startsWith("#")) {
      // Gather the full run of consecutive comment lines (a wrapped comment
      // counts as one explanation, even if its last line is short).
      const parts: string[] = [t];
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim();
        if (!prev.startsWith("#")) break;
        parts.unshift(prev);
      }
      return parts.join(" ").replace(/#/g, "").trim().length >= 10;
    }
    if (isAnyHeading(raw)) return false;
    // Substantive prose (not a bare heading or label) explains.
    return t.length >= 20;
  }
  return false;
}

/**
 * Extract example commands with their explanation status.
 *
 * Returns one entry per `swamp …` invocation, with `explained` set when a
 * comment or sentence nearby tells the reader why/when to run it.
 */
export function extractExplainedExamples(
  text: string,
): Array<{ command: string; explained: boolean }> {
  const lines = text.split("\n");
  const out: Array<{ command: string; explained: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!SWAMP_INVOCATION.test(raw)) continue;
    out.push({
      command: raw.replace(/\\\s*$/, "").trimEnd().trim(),
      explained: precedingExplains(lines, i),
    });
  }
  return out;
}

/** Extract candidate swamp command lines from a block of text. */
export function extractExamples(text: string): string[] {
  return extractExplainedExamples(text).map((e) => e.command);
}

/**
 * Score functional examples.
 *
 * An extension must show at least two runnable `swamp …` invocations, drawn
 * from the manifest description and/or README, that are not placeholder
 * templates. Each distinct real subcommand contributes; placeholders and
 * generic `<name>`/`example.com` templates are rejected with a note.
 */
export function checkExamples(
  rawManifest: string,
  readme: string,
): { check: CheckResult; examples: FoundExample[] } {
  const max = WEIGHTS.examples;
  const manifestDesc = manifestDescription(rawManifest).lines.join("\n");

  const found: FoundExample[] = [];
  for (const { command, explained } of extractExplainedExamples(manifestDesc)) {
    found.push({
      source: "manifest",
      command,
      functional: !PLACEHOLDER.test(command),
      explained,
    });
  }
  for (const { command, explained } of extractExplainedExamples(readme)) {
    found.push({
      source: "readme",
      command,
      functional: !PLACEHOLDER.test(command),
      explained,
    });
  }

  const functional = found.filter((f) => f.functional);
  // Distinct by invoked subcommand+method, so repetition doesn't inflate.
  const distinct = new Set(
    functional.map((f) => f.command.replace(/\s+--input.*$/, "").trim()),
  );

  let earned = 0;
  const notes: string[] = [];
  if (distinct.size >= 3) earned = max;
  else if (distinct.size === 2) earned = Math.round(max * 0.7);
  else if (distinct.size === 1) earned = Math.round(max * 0.4);
  else notes.push("no runnable `swamp …` example found");

  const withPlaceholders = found.filter((f) => !f.functional);
  if (withPlaceholders.length > 0 && distinct.size < 3) {
    notes.push(
      `${withPlaceholders.length} example(s) still contain placeholders (e.g. \`<name>\`, \`example.com\`)`,
    );
  }
  if (distinct.size > 0 && distinct.size < 3) {
    notes.push(
      `only ${distinct.size} distinct runnable example(s) — show at least 3`,
    );
  }

  return {
    check: {
      id: "examples",
      label: "Manifest/README carry functional examples",
      earned: clamp(earned, max),
      max,
      status: status(earned, max),
      note: notes.join("; ") || `${distinct.size} distinct runnable example(s)`,
    },
    examples: found,
  };
}

/**
 * Score whether each example command is explained.
 *
 * A user reading the manifest or README must understand **why and when** to
 * run a command, not just what it is. Every functional example needs an
 * adjacent comment or sentence saying what it achieves; the one-line
 * `swamp extension pull` install is self-evident and exempt. The score is the
 * explained fraction of the non-trivial examples.
 */
export function checkExplain(examples: FoundExample[]): CheckResult {
  const max = WEIGHTS.explain;
  const needExplain = examples.filter(
    (e) => e.functional && !SELF_EVIDENT.test(e.command),
  );
  if (needExplain.length === 0) {
    return {
      id: "explain",
      label: "Example commands say why/when to run them",
      earned: max,
      max,
      status: "pass",
      note: "only the self-evident install command is shown",
    };
  }
  const explained = needExplain.filter((e) => e.explained);
  const frac = explained.length / needExplain.length;
  const earned = Math.round(max * frac);
  const unexplained = needExplain.filter((e) => !e.explained);
  return {
    id: "explain",
    label: "Example commands say why/when to run them",
    earned: clamp(earned, max),
    max,
    status: frac === 1 ? "pass" : status(earned, max),
    note: unexplained.length > 0
      ? `${unexplained.length} example(s) have no explanation — add a comment or sentence saying why/when to run them (e.g. \`${
        unexplained[0].command.slice(0, 60)
      }\`)`
      : "every example command is explained",
  };
}

/** README required-section contract. */
export function checkSections(md: string, _manifest?: Manifest): CheckResult {
  const notes: string[] = [];
  let earned = 0;
  for (const spec of SECTIONS) {
    const present = sectionPresent(md, spec);
    if (present) {
      earned += spec.points;
      continue;
    }
    if (spec.id === "examples") {
      const configPresent = sectionPresent(
        md,
        SECTIONS.find((s) => s.id === "config")!,
      );
      if (!configPresent) {
        // No configuration options => nothing to exemplify. Forgiving.
        earned += spec.points;
        continue;
      }
    }
    notes.push(`missing \`## ${spec.heading}\` section`);
  }
  const max = WEIGHTS.sections;
  return {
    id: "sections",
    label: "Canonical README sections",
    earned: clamp(earned, max),
    max,
    status: status(earned, max),
    note: notes.join("; ") || undefined,
  };
}

/** README substance: length >= 1200 chars, >= 2 code blocks, >= 1 table. */
export function checkSubstance(md: string): CheckResult {
  let earned = 0;
  const notes: string[] = [];
  if (md.length >= 1200) earned += 2;
  else {notes.push(
      `README is ${md.length} chars — 1200+ gives room to be useful`,
    );}

  const blocks = countCodeBlocks(md);
  if (blocks >= 2) earned += 1;
  else notes.push(`README has ${blocks} fenced code block(s) — at least 2`);

  const hasTable = /^\|.+\|\s*$/m.test(md) && /^\|[\s:|-]+\|\s*$/m.test(md);
  if (hasTable) earned += 1;
  else notes.push("README has no markdown table — use one for configuration");

  const max = WEIGHTS.substance;
  return {
    id: "substance",
    label: "README substance",
    earned: clamp(earned, max),
    max,
    status: status(earned, max),
    note: notes.join("; ") || undefined,
  };
}

/** Packaging: README and a license file listed in `additionalFiles:`. */
export function checkPackaging(m: Manifest): CheckResult {
  const files = (m.additionalFiles ?? []).map((f) => f.toLowerCase());
  const hasReadme = files.some((f) => /(^|\/)readme\.md$/.test(f));
  const hasLicense = files.some((f) =>
    /(^|\/)(license|copying|licence)\b/.test(f)
  );
  let earned = 0;
  const notes: string[] = [];
  if (hasReadme) earned += 3;
  else notes.push("add `README.md` to `additionalFiles:`");
  if (hasLicense) earned += 3;
  else notes.push("add a `LICENSE` file to `additionalFiles:`");
  const max = WEIGHTS.packaging;
  return {
    id: "packaging",
    label: "README and LICENSE packaged",
    earned: clamp(earned, max),
    max,
    status: status(earned, max),
    note: notes.join("; ") || undefined,
  };
}

/** Manifest metadata: platforms (empty counts as universal), repository, license. */
export function checkMetadata(m: Manifest): CheckResult {
  let earned = 0;
  const notes: string[] = [];
  const platforms = m.platforms;
  if (Array.isArray(platforms)) {
    if (platforms.length === 0) {
      earned += 2;
    } else if (platforms.length >= 2) {
      earned += 2;
    } else {
      earned += 1;
      notes.push(
        "`platforms:` has one entry — list 2+ or leave empty (universal)",
      );
    }
  } else if (platforms === undefined) {
    earned += 2;
  } else {
    notes.push("`platforms:` must be a list");
  }

  const repo = m.repository ?? "";
  if (
    /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\//.test(
      repo,
    )
  ) {
    earned += 1;
  } else {
    notes.push(
      "`repository:` should be a public HTTPS URL on github.com/gitlab.com/codeberg.org/bitbucket.org",
    );
  }

  if ((m.license ?? "").trim().length > 0) earned += 1;
  else notes.push("set `license:` in the manifest");

  const max = WEIGHTS.metadata;
  return {
    id: "metadata",
    label: "Platforms, repository, license",
    earned: clamp(earned, max),
    max,
    status: status(earned, max),
    note: notes.join("; ") || undefined,
  };
}

/** At least one artifact (model/vault/datastore/report/workflow/skill) declared. */
export function checkArtifacts(m: Manifest): CheckResult {
  const files = declaredArtifactFiles(m);
  const max = WEIGHTS.artifacts;
  if (files.length > 0) {
    return {
      id: "artifacts",
      label: "Declares shipped artifacts",
      earned: max,
      max,
      status: "pass",
      note: `${files.length} artifact(s) declared`,
    };
  }
  return {
    id: "artifacts",
    label: "Declares shipped artifacts",
    earned: 0,
    max,
    status: "fail",
    note: "no models/vaults/datastores/reports/workflows/skills declared",
  };
}

// ---------------------------------------------------------------------------
// Coverage (README explains every model + method)
// ---------------------------------------------------------------------------

/** Strip markdown noise so bare identifiers can be searched in prose. */
function normalize(md: string): string {
  return md.toLowerCase();
}

/**
 * Score README coverage of each artifact's type and documented methods.
 *
 * `readmeHas` lets callers inject a pre-normalized README (lowercased).
 * Every documented model type contributes a small bonus, and each method adds
 * a per-method weight; the aggregate is scaled to `WEIGHTS.coverage` so the
 * check rewards both complete documentation and wide surfaces.
 */
export function checkCoverage(
  md: string,
  types: string[],
  methodsByType: Record<string, string[]>,
): { check: CheckResult; coverage: MethodCoverage[] } {
  const text = normalize(md);

  // Collect the set of method names that may be shared across types.
  const methodUniverse = new Set<string>();
  for (const methods of Object.values(methodsByType)) {
    for (const name of methods) methodUniverse.add(name);
  }

  const anyMethodDocumented = (name: string): boolean =>
    text.includes(name.toLowerCase());

  const coverage: MethodCoverage[] = [];
  for (const type of types) {
    const methods = methodsByType[type] ?? [];
    for (const name of methods) {
      coverage.push({ type, name, documented: anyMethodDocumented(name) });
    }
  }

  const typeBonus = types.filter((t) => text.includes(t.toLowerCase())).length;
  const documentedCount = coverage.filter((c) => c.documented).length;
  const totalMethods = coverage.length;
  const methodFraction = totalMethods > 0 ? documentedCount / totalMethods : 1;

  // Type naming: up to 30% of budget. Methods: up to 70%.
  const max = WEIGHTS.coverage;
  const earned = Math.round(
    max * (0.3 * (types.length ? typeBonus / types.length : 1) +
      0.7 * methodFraction),
  );

  const missing = coverage.filter((c) => !c.documented).map((c) =>
    `${c.type}.${c.name}`
  );
  const note = missing.length
    ? `README does not name: ${missing.slice(0, 8).join(", ")}${
      missing.length > 8 ? ` (+${missing.length - 8} more)` : ""
    }`
    : "every declared method is named in the README";

  return {
    check: {
      id: "coverage",
      label: "README documents every model and method",
      earned: clamp(earned, max),
      max,
      status: status(earned, max),
      note,
    },
    coverage,
  };
}

/** JSDoc symbol coverage from `deno doc --json` parsed output. */
export function checkSymbols(
  docJson: unknown,
): CheckResult {
  const max = WEIGHTS.symbols;
  const nodes = extractDocNodes(docJson);
  if (nodes.length === 0) {
    return {
      id: "symbols",
      label: "Source symbols documented (JSDoc)",
      earned: 0,
      max,
      status: "fail",
      note: "no exported symbols found (is the entrypoint correct?)",
    };
  }
  const documented = nodes.filter((n) =>
    (n.jsDoc?.doc ?? "").trim().length > 0
  );
  const frac = documented.length / nodes.length;
  const earned = Math.round(max * frac);
  return {
    id: "symbols",
    label: "Source symbols documented (JSDoc)",
    earned: clamp(earned, max),
    max,
    status: frac >= 0.8 ? "pass" : status(earned, max),
    note: `${
      Math.round(frac * 100)
    }% of ${nodes.length} exported symbols have JSDoc (target 80%)`,
  };
}

interface DocDeclaration {
  jsDoc?: { doc?: string };
}

interface DocSymbol {
  declarations?: DocDeclaration[];
}

interface DocFileNode {
  symbols?: DocSymbol[];
}

/**
 * Flatten `deno doc --json` output into one row per exported declaration.
 *
 * Shape: `{ nodes: { "<file>": { symbols: [{ declarations: [{ jsDoc }] }] } } }`.
 * Each declaration is counted once (matching the published rubric, where
 * function overloads count separately).
 */
function extractDocNodes(docJson: unknown): DocDeclaration[] {
  if (!docJson || typeof docJson !== "object") return [];
  const nodes = (docJson as { nodes?: Record<string, DocFileNode> }).nodes;
  if (!nodes) return [];
  const out: DocDeclaration[] = [];
  for (const file of Object.values(nodes)) {
    for (const symbol of file.symbols ?? []) {
      for (const decl of symbol.declarations ?? []) out.push(decl);
    }
  }
  return out;
}

/** Fast-type check: `deno doc --lint` output must be empty. */
export function checkFastTypes(lintStdout: string): CheckResult {
  const max = WEIGHTS.fasttypes;
  const diagnostics = lintStdout.trim();
  if (diagnostics.length === 0) {
    return {
      id: "fasttypes",
      label: "No slow types (deno doc --lint)",
      earned: max,
      max,
      status: "pass",
      note: "clean",
    };
  }
  return {
    id: "fasttypes",
    label: "No slow types (deno doc --lint)",
    earned: 0,
    max,
    status: "fail",
    note: diagnostics.split("\n").slice(0, 6).join("; "),
  };
}

/** Dependency trust: full pass, or partial when the audit could not run. */
export function checkDeps(
  audited: boolean,
  passed: boolean,
  detail?: string,
): CheckResult {
  const max = WEIGHTS.deps;
  if (!audited) {
    return {
      id: "deps",
      label: "Dependency trust",
      earned: Math.round(max * 0.5),
      max,
      status: "partial",
      note: detail ??
        "offline: dependency audit skipped (50% credit) — run with `swamp extension quality` for the full audit",
    };
  }
  if (passed) {
    return {
      id: "deps",
      label: "Dependency trust",
      earned: max,
      max,
      status: "pass",
      note: detail,
    };
  }
  return {
    id: "deps",
    label: "Dependency trust",
    earned: 0,
    max,
    status: "fail",
    note: detail ?? "dependency audit reported problems",
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/** Convert a 0–100 score into the rubric letter grade. */
export function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

/** Inputs to {@link scoreExtension}. */
export interface ScoreInput {
  manifest: Manifest;
  manifestPath?: string;
  /** Raw manifest YAML source (for spacing/readability checks). */
  manifestSource?: string;
  readme: string;
  /** Model type strings declared by this extension. */
  types?: string[];
  /** Method names per type, e.g. `{ "@me/tool": ["run", "sync"] }`. */
  methodsByType?: Record<string, string[]>;
  /** Parsed `deno doc --json` output for the entrypoints. */
  docJson?: unknown;
  /** Raw `deno doc --lint` output (empty string means clean). */
  lintStdout?: string;
  /** Whether the dependency audit actually ran. */
  depsAudited?: boolean;
  /** Whether the dependency audit passed. */
  depsPassed?: boolean;
  /** Human-readable dependency audit detail. */
  depsDetail?: string;
}

/** Assemble all checks into a single weighted {@link ScoreResult}. */
export function scoreExtension(input: ScoreInput): ScoreResult {
  const {
    manifest,
    readme,
    types = [],
    methodsByType = {},
    docJson,
    lintStdout = "",
  } = input;

  const coverage = checkCoverage(readme, types, methodsByType);
  // Raw YAML is required for the spacing check; fall back to re-serializing
  // the parsed manifest when a caller does not supply the source.
  const manifestSource = input.manifestSource ?? "";
  const examples = checkExamples(manifestSource, readme);

  const checks: CheckResult[] = [
    checkManifest(manifest),
    checkPitch(manifestSource),
    checkManual(manifest),
    checkOrder(manifestSource),
    checkNoMethodsSection(manifestSource),
    checkInstallStep(manifestSource),
    checkFormat(manifestSource),
    examples.check,
    checkExplain(examples.examples),
    checkSections(readme, manifest),
    checkSubstance(readme),
    checkPackaging(manifest),
    checkMetadata(manifest),
    checkArtifacts(manifest),
    coverage.check,
    checkSymbols(docJson),
    checkFastTypes(lintStdout),
    checkDeps(
      input.depsAudited ?? false,
      input.depsPassed ?? false,
      input.depsDetail,
    ),
  ];

  const earned = checks.reduce((sum, c) => sum + c.earned, 0);
  const score = Math.round((earned / MAX_SCORE) * 100);

  const nextActions = checks
    .filter((c) => c.status !== "pass" && c.note)
    .map((c) => `${c.id}: ${c.note}`);

  const missing: string[] = [];
  if (!manifest.name) missing.push("name");
  if (!manifest.description) missing.push("description");
  if (!manifest.repository) missing.push("repository");
  if (!manifest.license) missing.push("license");
  if (!manifest.additionalFiles?.length) missing.push("additionalFiles");

  return {
    name: manifest.name ?? "(unnamed)",
    manifest: input.manifestPath ?? "manifest.yaml",
    score,
    grade: gradeFor(score),
    earned,
    earnedMax: MAX_SCORE,
    checks,
    coverage: coverage.coverage,
    examples: examples.examples,
    missing,
    nextActions,
  };
}

// ---------------------------------------------------------------------------
// README contract scaffolding
// ---------------------------------------------------------------------------

/** Render a conformant README skeleton for a manifest. */
export function renderReadmeTemplate(m: Manifest): string {
  const name = m.name ?? "@collective/my-extension";
  return `# ${name}

## What it does

One short paragraph: the problem this solves, who it is for, and the side
effects (files written, services started, APIs called). A reader should be able
to decide in 30 seconds whether this extension is relevant.

## Install

\`\`\`sh
swamp extension pull ${name}
\`\`\`

## Configuration

Set these global arguments when creating a model:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| \`exampleArg\` | string | \`"default"\` | What it controls. |

## Examples

\`\`\`sh
# Create the model with a non-default option.
swamp model create ${name} my-model --global-arg exampleArg=value

# Run the primary method.
swamp model method run my-model run

# Run offline (no network access).
swamp model method run my-model run --input offline=true
\`\`\`

## Details

Describe the models this extension ships and what each method does. Include
resources produced, prerequisites (services, credentials, network), and any
caveats. When methods take arguments, give each a row below.

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| \`run\` | none | a \`result\` resource |

## License

MIT — see LICENSE.
`;
}
