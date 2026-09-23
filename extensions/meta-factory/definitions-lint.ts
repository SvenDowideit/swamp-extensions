/**
 * Definition-config lint for swamp extensions.
 *
 * Enforces the rule that a swamp *definition* (a model, workflow, vault, or
 * datastore config YAML) must be created with the matching swamp creation
 * command — `swamp model create`, `swamp workflow create`, `swamp vault create`
 * — rather than hand-written or copied from another definition.
 *
 * Two independent signals are combined:
 *
 * 1. **Structure.** A generation command always stamps a fresh, valid, unique
 *    `id:`. A copied file carries the source's `id:`, and a hand-written file
 *    has none or a fabricated one. These are provable from the file alone.
 * 2. **Audit evidence.** The `swamp audit` timeline records the creation
 *    commands that actually ran. A definition modified recently with no matching
 *    create command is reported as unconfirmed. This is best-effort: it depends
 *    on the audit hook being active and the definition falling inside the
 *    queried window, so it is a warning, not a hard failure.
 *
 * The lint is pure with respect to its inputs: {@link lintDefinitionSource} and
 * {@link parseCreationCommands} take strings, and {@link lintDefinitions} only
 * walks the filesystem, so the whole module is cheap to unit test. The audit
 * timeline is fetched by the caller (`meta_factory.ts`) and passed in.
 *
 * @module
 */
import { join, relative } from "jsr:@std/path@1";

/** The kind of swamp config a YAML file is. */
export type DefinitionKind =
  | "model"
  | "workflow"
  | "vault"
  /** A definition-shaped config that did not match a known creation command. */
  | "config"
  /** An extension `manifest.yaml` — never created by a definition command. */
  | "manifest"
  /** Not a swamp definition config (repo config, source list, …). */
  | "unknown";

/** A single definition-config problem. */
export interface DefinitionIssue {
  /** `error` breaks the creation-command rule; `warning` is advisory. */
  severity: "error" | "warning";
  /** Stable rule id. */
  rule:
    | "id-missing"
    | "id-format"
    | "id-duplicate"
    | "create-unconfirmed"
    | "name-missing"
    | "typeVersion-missing";
  /** Human-readable description, including the command that should have run. */
  message: string;
}

/** Result of linting one definition config. */
export interface DefinitionLintResult {
  /** False when any `error`-severity issue was found. */
  ok: boolean;
  /** What the file is. */
  kind: DefinitionKind;
  /** Declared `name:`, when present. */
  name?: string;
  /** Declared `id:`, when present. */
  id?: string;
  /** The command that should have produced this file. */
  expectedCommand?: string;
  /** Every issue found. */
  issues: DefinitionIssue[];
  /** Repo-relative path, when known. */
  path?: string;
  /**
   * Whether the `swamp audit` timeline confirmed a create command for this
   * definition. `undefined` when no audit evidence was supplied or the file is
   * older than the queried window.
   */
  createConfirmed?: boolean;
}

/** A canonical UUID (any version, case-insensitive) — swamp's assigned id form. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Files that are repo configuration, never a definition-command output. */
const REPO_CONFIG = /(^|\/)\.swamp(-sources)?\.yaml$/;

/** Read the first top-level scalar for `key` (quotes stripped). */
export function topLevelScalar(source: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const m = source.match(re);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "").trim() || null;
}

/**
 * Classify a YAML source by shape.
 *
 * Detection is by top-level keys so it works on raw text without a YAML parse:
 * manifests carry `manifestVersion`; workflows carry `jobs`; models carry
 * `type` plus `globalArguments`/`typeVersion`; vault configs carry `type` plus
 * `config`. Anything else that still has an `id:` is a generic `config`.
 */
export function classifyDefinition(source: string): DefinitionKind {
  if (/^manifestVersion:/m.test(source)) return "manifest";
  if (/^jobs:/m.test(source)) return "workflow";
  if (/^globalArguments:/m.test(source) || /^typeVersion:/m.test(source)) {
    return "model";
  }
  if (/^type:/m.test(source) && /^config:/m.test(source)) return "vault";
  if (/^id:/m.test(source)) return "config";
  return "unknown";
}

/** The creation command that produces a definition of `kind`. */
export function creationCommand(
  kind: DefinitionKind,
  fields: { type?: string | null; name?: string | null },
): string | undefined {
  const type = fields.type ?? "<type>";
  const name = fields.name ?? "<name>";
  switch (kind) {
    case "model":
      return `swamp model create ${type} ${name}`;
    case "workflow":
      return `swamp workflow create ${name}`;
    case "vault":
      return `swamp vault create ${type} ${name}`;
    default:
      return undefined;
  }
}

/**
 * A definition-creation command recovered from the `swamp audit` timeline.
 *
 * `swamp audit --json` returns a flat list of commands that ran, each with a
 * `summary` (the command line) and a `timestamp`. This is the public interface
 * the factory cross-references against the definitions on disk; how the audit
 * timeline is produced or persisted is deliberately not modelled here.
 */
export interface CreationCommand {
  /** Definition kind the command creates. */
  kind: "model" | "workflow" | "vault";
  /** The definition name passed to the command (collective prefix stripped). */
  name: string;
  /** ISO timestamp of the command. */
  timestamp: string;
  /**
   * False when the name still contained an unexpanded shell variable, so the
   * command cannot be matched to a specific definition.
   */
  resolved: boolean;
}

/** One entry from the `swamp audit --json` timeline. */
export interface AuditEntry {
  /** ISO timestamp of the command. */
  timestamp?: string;
  /** Command source (`swamp` or `direct`). */
  source?: string;
  /** The command line that ran. */
  summary?: string;
}

/**
 * Recover the definition-creation commands from an audit timeline.
 *
 * A command may appear anywhere in a shell pipeline (`swamp model create … &&
 * swamp model method run …`), so each `swamp <kind> create` occurrence in the
 * summary is extracted independently. Option tokens (and their values) are
 * skipped so the positional `<type> <name>` arguments are found; the name is the
 * argument after the type for models and vaults, and the first argument for
 * workflows.
 *
 * Two shell indirections that appear in real command histories are handled:
 *
 * - a `for <var> in <values>` loop is expanded so `swamp workflow create
 *   @me/$w` yields one command per value;
 * - a name that still contains an unresolved shell variable is recorded with
 *   `resolved: false`, so callers never treat it as proof that some other
 *   definition was *not* created.
 *
 * Names may carry a `@collective/` prefix that the definition on disk omits (or
 * vice versa); matching normalises it away.
 */
export function parseCreationCommands(
  entries: AuditEntry[],
): CreationCommand[] {
  const out: CreationCommand[] = [];
  const re = /\bswamp\s+(model|workflow|vault)\s+create\b/g;
  for (const entry of entries) {
    const summary = entry.summary ?? "";
    const timestamp = entry.timestamp ?? "";
    for (const match of summary.matchAll(re)) {
      const kind = match[1] as CreationCommand["kind"];
      // Stop at the end of this command in a pipeline.
      const rest = summary.slice((match.index ?? 0) + match[0].length);
      const segment = rest.split(/[|;&\n]/, 1)[0];
      for (const raw of expandShellVars(segment, summary)) {
        const positional = splitPositional(raw);
        const name = kind === "workflow" ? positional[0] : positional[1];
        if (!name) continue;
        out.push({
          kind,
          name: normalizeName(name),
          timestamp,
          resolved: !/\$\{?\w/.test(name),
        });
      }
    }
  }
  return out;
}

/**
 * Expand `for <var> in <values>` loop variables used in a command segment.
 *
 * Returns the segment unchanged when it has no `for … in` loop, one segment per
 * value when it does, and the segment with unresolved variables intact (the
 * downstream `resolved` flag then prevents a false "not created" verdict).
 */
function expandShellVars(segment: string, summary: string): string[] {
  const m = summary.match(
    /for\s+(\w+)\s+in\s+([^;]+?)\s*;\s*do\b/i,
  );
  if (!m) return [segment];
  const [, varName, rawValues] = m;
  const values = rawValues.trim().split(/\s+/).filter(Boolean);
  if (values.length === 0) return [segment];
  const ref = new RegExp(`\\$\\{?${varName}\\}?`, "g");
  return values.map((v) => segment.replace(ref, v));
}

/** Strip a `@collective/` prefix so both naming styles compare equal. */
export function normalizeName(name: string): string {
  return name.startsWith("@") ? name.split("/").slice(1).join("/") : name;
}

/** Whether an audit timeline confirms a create command for `name`. */
export function hasCreationCommand(
  commands: CreationCommand[],
  name: string,
): boolean {
  const target = normalizeName(name);
  return commands.some((c) => c.resolved && normalizeName(c.name) === target);
}

/**
 * Whether the timeline contained a create command that could not be resolved
 * (e.g. a shell variable the extractor could not expand). When true, an
 * unconfirmed definition cannot be concluded to be hand-written.
 */
export function hasUnresolvedCreationCommand(
  commands: CreationCommand[],
): boolean {
  return commands.some((c) => !c.resolved);
}

/**
 * Split a command segment into positional arguments, dropping option tokens.
 *
 * A `--flag value` pair is dropped as two tokens; a `--flag=value` or a
 * bare `--flag` as one. Redaction tokens (`<REDACTED>`) are ignored so they do
 * not shift the positional indexes.
 */
function splitPositional(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      // `--flag=value` is self-contained; a bare `--flag` consumes the next
      // token unless that token is itself a flag.
      if (
        !token.includes("=") && tokens[i + 1] && !tokens[i + 1].startsWith("-")
      ) {
        i++;
      }
      continue;
    }
    if (token.startsWith("-")) continue;
    const cleaned = token.replace(/^["']|["']$/g, "");
    if (cleaned === "<REDACTED>" || cleaned === "") continue;
    out.push(cleaned);
  }
  return out;
}

/**
 * Creation-command evidence gathered from `swamp audit`.
 *
 * `available` is false when the timeline could not be read (no audit hook, an
 * empty log, or the command failed), in which case no `create-unconfirmed`
 * warning is emitted — an absent audit log is not evidence of wrongdoing.
 */
export interface AuditEvidence {
  /** True only when a non-empty timeline was read. */
  available: boolean;
  /** Size of the window the timeline covers. */
  hours: number;
  /** Earliest instant the timeline covers (epoch ms), if known. */
  windowStartMs?: number;
  /** Definition-creation commands recovered from the timeline. */
  commands: CreationCommand[];
  /** Human-readable explanation of the timeline's availability. */
  detail?: string;
}

/**
 * Lint one definition-config source.
 *
 * @param source Raw YAML text.
 * @param opts.path Repo-relative path, used in messages and duplicate checks.
 * @param opts.knownIds Map of `id` → first path that declared it, so a copied
 *   id can be reported as a duplicate (the copy-paste symptom).
 * @param opts.audit Creation-command evidence from `swamp audit`, used to flag
 *   a recently-created definition with no matching create command.
 * @param opts.createdMs File creation time (birthtime), when the caller knows
 *   it. The rule is about how a definition was *created*, so a later edit must
 *   not pull it into the audit window.
 */
export function lintDefinitionSource(
  source: string,
  opts: {
    path?: string;
    knownIds?: Map<string, string>;
    audit?: AuditEvidence;
    createdMs?: number;
  } = {},
): DefinitionLintResult {
  const kind = classifyDefinition(source);
  const path = opts.path;
  const name = topLevelScalar(source, "name");
  const id = topLevelScalar(source, "id");
  const type = topLevelScalar(source, "type");
  const expectedCommand = creationCommand(kind, { type, name });
  const issues: DefinitionIssue[] = [];

  if (kind === "manifest" || kind === "unknown") {
    return {
      ok: true,
      kind,
      name: name ?? undefined,
      id: id ?? undefined,
      path,
      issues,
    };
  }

  if (expectedCommand === undefined) {
    // A definition-shaped file we cannot map to a creation command (e.g. a
    // datastore config written by `swamp datastore setup`). Only verify the id.
  }

  if (!id) {
    issues.push({
      severity: "error",
      rule: "id-missing",
      message: `no \`id:\` — this file was hand-written, not generated${
        expectedCommand ? `; create it with \`${expectedCommand}\`` : ""
      }`,
    });
  } else if (!UUID_RE.test(id)) {
    issues.push({
      severity: "error",
      rule: "id-format",
      message: `\`id: ${id}\` is not a UUID${
        expectedCommand
          ? ` — swamp assigns a UUID; run \`${expectedCommand}\``
          : ""
      }`,
    });
  } else if (opts.knownIds) {
    const other = opts.knownIds.get(id);
    if (other && other !== path) {
      issues.push({
        severity: "error",
        rule: "id-duplicate",
        message:
          `\`id: ${id}\` is already used by \`${other}\` — this definition was copied${
            expectedCommand
              ? `; re-run \`${expectedCommand}\` to get a fresh id`
              : ""
          }`,
      });
    }
  }

  if (!name) {
    issues.push({
      severity: "warning",
      rule: "name-missing",
      message: "no `name:` — generation commands always set one",
    });
  }
  if (kind === "model" && !topLevelScalar(source, "typeVersion")) {
    issues.push({
      severity: "warning",
      rule: "typeVersion-missing",
      message:
        "no `typeVersion:` — `swamp model create` records the installed type version",
    });
  }

  // Cross-reference the `swamp audit` timeline. Only a definition *created*
  // inside the window can be judged by it; one older than the window is simply
  // unverifiable here, not suspicious. A command the parser could not resolve
  // (an unexpanded shell variable) also suppresses the warning, because it may
  // well have created this very definition.
  const audit = opts.audit;
  let createConfirmed: boolean | undefined;
  if (
    expectedCommand && name && audit?.available &&
    opts.createdMs !== undefined &&
    (audit.windowStartMs === undefined ||
      opts.createdMs >= audit.windowStartMs)
  ) {
    const confirmed = hasCreationCommand(audit.commands, name);
    if (confirmed) {
      createConfirmed = true;
    } else if (hasUnresolvedCreationCommand(audit.commands)) {
      // At least one create command could not be resolved to a name, so a
      // negative verdict would be unsound.
      createConfirmed = undefined;
    } else {
      createConfirmed = false;
      issues.push({
        severity: "warning",
        rule: "create-unconfirmed",
        message:
          `no \`${expectedCommand}\` found in the \`swamp audit\` timeline for ` +
          `the last ${audit.hours}h, though the definition was modified in that ` +
          `window — create definitions with the swamp command rather than ` +
          `hand-writing or copying them`,
      });
    }
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    kind,
    name: name ?? undefined,
    id: id ?? undefined,
    expectedCommand,
    issues,
    path,
    createConfirmed,
  };
}

/** A linted definition discovered under a root. */
export interface ScannedDefinition extends DefinitionLintResult {
  /** Absolute path. */
  path: string;
}

/** Outcome of scanning a repository for definition configs. */
export interface DefinitionsScan {
  /** Number of definition configs found (manifests/repo config excluded). */
  scanned: number;
  /** Every definition found, with its issues. */
  definitions: ScannedDefinition[];
  /** All issues found, each prefixed with its path. */
  issues: Array<DefinitionIssue & { path: string }>;
}

/** Whether a YAML file could be an output of a swamp creation command. */
export async function isDefinitionConfig(path: string): Promise<boolean> {
  let source = "";
  try {
    source = await Deno.readTextFile(path);
  } catch {
    return false;
  }
  const kind = classifyDefinition(source);
  return kind !== "manifest" && kind !== "unknown";
}

/**
 * Recursively scan `root` for swamp definition configs and lint each.
 *
 * Repo configuration (`.swamp.yaml`, `.swamp-sources.yaml`), extension
 * manifests, and non-YAML files are skipped. Duplicate ids are detected across
 * the whole scan, so a definition copied from another surfaces as
 * `id-duplicate`. When `opts.audit` supplies a `swamp audit` timeline, a
 * recently-modified definition with no matching create command also surfaces as
 * `create-unconfirmed`.
 *
 * @param root Directory to scan.
 * @param opts.audit Creation-command evidence from `swamp audit`.
 */
export async function lintDefinitions(
  root: string,
  opts: { audit?: AuditEvidence } = {},
): Promise<DefinitionsScan> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile && e.name.endsWith(".yaml")) {
        if (!REPO_CONFIG.test(full)) files.push(full);
      }
    }
  }
  await walk(root);
  files.sort();

  const sources = new Map<string, string>();
  const createdTimes = new Map<string, number>();
  for (const file of files) {
    try {
      sources.set(file, await Deno.readTextFile(file));
      const stat = await Deno.stat(file);
      // Prefer birthtime (when the file was created); fall back to mtime on
      // filesystems that do not expose it. The rule judges creation, so a later
      // edit must not drag an old, legitimately-created file into the window.
      createdTimes.set(
        file,
        (stat.birthtime ?? stat.mtime)?.getTime() ?? 0,
      );
    } catch {
      // unreadable — skip
    }
  }

  // First pass: pick the canonical owner of each id. swamp names a generated
  // file after its `name:` (or after its `id:` when unnamed), so a file whose
  // basename matches neither is the likely copy. Ties fall back to path order.
  const candidate = new Map<
    string,
    Array<{ rel: string; generated: boolean }>
  >();
  for (const [file, source] of sources) {
    if (classifyDefinition(source) === "manifest") continue;
    const id = topLevelScalar(source, "id");
    if (!id) continue;
    const rel = relative(root, file) || file;
    const base = basenameNoExt(rel);
    const name = topLevelScalar(source, "name");
    const generated = base === id || (name !== null && base === name);
    const list = candidate.get(id) ?? [];
    list.push({ rel, generated });
    candidate.set(id, list);
  }
  const knownIds = new Map<string, string>();
  for (const [id, entries] of candidate) {
    entries.sort((a, b) =>
      Number(b.generated) - Number(a.generated) || a.rel.localeCompare(b.rel)
    );
    knownIds.set(id, entries[0].rel);
  }

  const definitions: ScannedDefinition[] = [];
  const issues: Array<DefinitionIssue & { path: string }> = [];
  for (const [file, source] of sources) {
    const rel = relative(root, file) || file;
    const result = lintDefinitionSource(source, {
      path: rel,
      knownIds,
      audit: opts.audit,
      createdMs: createdTimes.get(file),
    });
    if (result.kind === "manifest" || result.kind === "unknown") continue;
    definitions.push({ ...result, path: rel });
    for (const issue of result.issues) issues.push({ ...issue, path: rel });
  }

  return { scanned: definitions.length, definitions, issues };
}

/** Basename without its extension, for auto-named-file detection. */
function basenameNoExt(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/** Render a compact human summary of a definitions scan. */
export function renderDefinitionsScan(scan: DefinitionsScan): string {
  if (scan.issues.length === 0) {
    return `Definitions structure OK (${scan.scanned} config(s) checked)`;
  }
  const lines = scan.issues.map(
    (i) => `- [${i.severity}] ${i.path}: ${i.rule}: ${i.message}`,
  );
  return `Definitions structure: ${
    scan.issues.some((i) => i.severity === "error")
      ? "FAILED"
      : "OK with warnings"
  }\n${lines.join("\n")}`;
}
