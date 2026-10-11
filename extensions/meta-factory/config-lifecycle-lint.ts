/**
 * Config-lifecycle lint for swamp extension model sources.
 *
 * **Rule:** configuration is precious and cumulative. An extension that manages
 * configuration must:
 *
 * 1. ship a `setup` method (so the config is discoverable and changeable);
 * 2. persist config to a durable resource — including incomplete values — and
 *    not discard what the user supplied;
 * 3. read existing config back before asking the user again; and
 * 4. prefer config another model/extension already saved
 *    (`readModelData` / `data.latest`) over asking again.
 *
 * The first three are **errors** (they are the load-bearing half of the rule);
 * reuse across extensions is a **warning**, because not every extension has a
 * peer to learn from. An extension with no configurable surface is skipped
 * entirely.
 *
 * A legitimate exemption is a `// meta-factory-ignore config-lifecycle: <reason>`
 * comment on any line of the file — it exempts the whole file. Naming a rule
 * after the keyword exempts only that rule, e.g.
 * `// meta-factory-ignore config-lifecycle config-not-reused: no peer extension`.
 *
 * The lint is pure with respect to its input strings, so it is cheap to unit
 * test.
 *
 * @module
 */

import { stripComments } from "./version-source-lint.ts";

/** The anti-patterns this rule reports. */
export type ConfigLifecycleRule =
  | "setup-method-missing"
  | "setup-recommended"
  | "config-not-persisted"
  | "config-not-read-back"
  | "config-not-reused";

/** A single config-lifecycle problem in a source file. */
export interface ConfigLifecycleIssue {
  /** `error` costs points in the scored check; `warning` is advisory. */
  severity: "error" | "warning";
  /** Which anti-pattern. */
  rule: ConfigLifecycleRule;
  /** Human-readable description, including the fix. */
  message: string;
  /** 1-based line number of the offending reference (or the setup method). */
  line: number;
  /** Path of the source file, when known. */
  path?: string;
}

/** One source file to lint. */
export interface ConfigLifecycleFile {
  /** Path (repo- or extension-relative) used in messages. */
  path: string;
  /** Raw TypeScript source. */
  source: string;
}

/**
 * `// meta-factory-ignore config-lifecycle[: rule]: <reason>` — exempt the file.
 * The rule name is optional; without it every rule is exempt.
 */
const IGNORE_RE =
  /meta-factory-ignore\s+config-lifecycle(?:\s+([a-z][a-z-]*))?\s*:/i;

/** A named or inline `globalArguments` / `GlobalArgsSchema` object. */
const GLOBALS_INLINE_RE =
  /(?:globalArguments|GlobalArgsSchema)\s*[:=]\s*(?:z\.)?object\s*\(\s*\{([^}]*)\}/;

/** A `globalArguments: SomeSchema` reference to a named schema. */
const GLOBALS_REF_RE = /globalArguments\s*:\s*([A-Za-z_$][\w$]*)\b/;

/** A `setup: {` method key somewhere inside a `methods:` block. */
const SETUP_METHOD_RE = /\bmethods\s*:\s*\{[\s\S]{0,20000}?^\s*setup\s*:\s*\{/m;

/** A resource spec or write targeting config-like durable state. */
const CONFIG_RESOURCE_RE =
  /\b(config|prefs|preferences|settings|options)\b[\s\S]{0,40}?(schema|writeResource)|writeResource\s*\(\s*["'`][^"'`]*(config|prefs|preferences|settings|options)/i;

/** A resource declaration named config/prefs/settings/options. */
const CONFIG_RESOURCE_DECL_RE =
  /^\s*(config|prefs|preferences|settings|options)\s*:\s*\{/im;

/** A durable config write via `writeResource`. */
const CONFIG_WRITE_RE =
  /writeResource\s*\(\s*["'`][^"'`]*(config|prefs|preferences|settings|options)/i;

/** Reading persisted config back — own resource, a peer model, or CEL. */
const READ_BACK_RE = /readResource\s*\(|readModelData\s*\(|data\.latest\s*\(/;

/** Cross-model discovery of config another extension already saved. */
const REUSE_RE = /readModelData\s*\(|data\.latest|\.lookup\s*\(/;

/** Whether the source declares configurable global arguments. */
export function hasConfigurableGlobals(source: string): boolean {
  const code = stripComments(source);
  const inline = GLOBALS_INLINE_RE.exec(code);
  if (inline) return /\w+\s*:/.test(inline[1]);
  const ref = GLOBALS_REF_RE.exec(code);
  if (ref) {
    const def = new RegExp(`\\b${ref[1]}\\s*=\\s*z\\.object\\s*\\(\\s*\\{`);
    return def.test(code);
  }
  return false;
}

/** Character index of the `setup` method key, or -1. */
function setupMethodIndex(source: string): number {
  const m = SETUP_METHOD_RE.exec(source);
  return m ? m.index : -1;
}

/** The 1-based line number of a character index. */
function lineOf(source: string, index: number): number {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Lint one model source for the config-lifecycle anti-patterns.
 *
 * @param source Raw TypeScript.
 * @param path Optional path used in the issue messages.
 */
export function lintConfigLifecycle(
  source: string,
  path?: string,
): ConfigLifecycleIssue[] {
  const raw = stripComments(source);

  // File-level exemption. An ignore naming a rule exempts only that rule.
  const ignored = new Set<string>();
  let ignoreAll = false;
  for (const line of source.split("\n")) {
    const m = IGNORE_RE.exec(line);
    if (!m) continue;
    if (m[1]) ignored.add(m[1].toLowerCase());
    else ignoreAll = true;
  }

  const applicable = hasConfigurableGlobals(source) ||
    CONFIG_RESOURCE_DECL_RE.test(raw) ||
    setupMethodIndex(raw) >= 0;
  if (!applicable) return [];

  const issues: ConfigLifecycleIssue[] = [];
  const push = (
    rule: ConfigLifecycleRule,
    severity: "error" | "warning",
    message: string,
    line: number,
  ) => {
    if (ignoreAll || ignored.has(rule)) return;
    issues.push({ severity, rule, message, line, path });
  };

  const setupIdx = setupMethodIndex(raw);
  const setupLine = lineOf(raw, setupIdx);

  if (setupIdx < 0) {
    const hasConfigResource = CONFIG_RESOURCE_DECL_RE.test(raw) ||
      CONFIG_RESOURCE_RE.test(raw);
    if (hasConfigResource) {
      push(
        "setup-method-missing",
        "error",
        "this extension persists configuration but ships no `setup` method — " +
          "add one that reports detected config, persists partial values, and " +
          "reads existing config back before asking again (or add " +
          "`// meta-factory-ignore config-lifecycle: <reason>`)",
        1,
      );
    } else {
      push(
        "setup-recommended",
        "warning",
        "configurable global arguments but no `setup` method — add one so the " +
          "config is discoverable, persisted (even when partial), and reused " +
          "rather than re-asked",
        1,
      );
    }
    return issues;
  }

  if (!CONFIG_WRITE_RE.test(raw)) {
    push(
      "config-not-persisted",
      "error",
      "`setup` never persists configuration to a durable resource — write the " +
        "supplied values (even incomplete ones) with `context.writeResource` " +
        "so the user is never asked twice (or add " +
        "`// meta-factory-ignore config-lifecycle: <reason>`)",
      setupLine,
    );
  }
  if (!READ_BACK_RE.test(raw)) {
    push(
      "config-not-read-back",
      "error",
      "`setup` never reads existing configuration back — read the persisted " +
        "resource (or a peer model's data) before asking, so the user is not " +
        "asked for information that is already known (or add " +
        "`// meta-factory-ignore config-lifecycle: <reason>`)",
      setupLine,
    );
  }
  if (!REUSE_RE.test(raw)) {
    push(
      "config-not-reused",
      "warning",
      "`setup` does not check whether another model/extension already saved " +
        "the config — prefer `context.readModelData` / `data.latest` over " +
        "asking again",
      setupLine,
    );
  }
  return issues;
}

/** Lint every source file; the issues carry each file's path. */
export function lintConfigLifecycles(
  files: ConfigLifecycleFile[],
): ConfigLifecycleIssue[] {
  const out: ConfigLifecycleIssue[] = [];
  for (const file of files) {
    out.push(...lintConfigLifecycle(file.source, file.path));
  }
  return out;
}
