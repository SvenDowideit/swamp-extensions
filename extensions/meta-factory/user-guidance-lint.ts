/**
 * User-guidance lint for swamp extensions — **never make the user substitute a
 * value the extension already knows.**
 *
 * When an extension tells the user to run a command, that command must be
 * copy-and-paste ready. A placeholder such as
 * ``systemctl --user status <serve-unit>`` is a failure: the extension knows
 * which unit it is supervising, so it must print the real unit name, not an
 * angle-bracket blank for the user to fill in.
 *
 * The rule reports `substitution-placeholder` once per placeholder occurrence in
 * a user-facing command instruction. It scans the source of the extension's own
 * models/reports/vaults/datastores and its declared workflow YAML, not the
 * README or manifest (their examples are already covered by the `examples`
 * check).
 *
 * A legitimate exemption is a `// meta-factory-ignore user-guidance: <reason>`
 * comment (TypeScript) or `# meta-factory-ignore user-guidance: <reason>`
 * comment (workflow YAML) anywhere in the file. Naming a rule after the keyword
 * exempts only that rule.
 *
 * The lint is pure with respect to its input strings, so it is cheap to unit
 * test.
 *
 * @module
 */

import { stripComments } from "./version-source-lint.ts";

/** The anti-patterns this rule reports. */
export type UserGuidanceRule = "substitution-placeholder";

/** A single user-guidance problem in a source or workflow file. */
export interface UserGuidanceIssue {
  /** Always an error: the user cannot copy-and-paste the instruction as-is. */
  severity: "error";
  /** Which anti-pattern. */
  rule: UserGuidanceRule;
  /** Human-readable description, including the fix. */
  message: string;
  /** 1-based line number of the offending instruction. */
  line: number;
  /** The placeholder the user was expected to replace, e.g. `<serve-unit>`. */
  placeholder: string;
  /** The command instruction containing the placeholder. */
  command: string;
  /** Path of the offending file, when known. */
  path?: string;
}

/** One file to lint: a model/report/vault source or a workflow definition. */
export interface UserGuidanceFile {
  /** Path (repo- or extension-relative) used in messages. */
  path: string;
  /** Raw TypeScript (`.ts`) or workflow YAML. */
  source: string;
}

/** `meta-factory-ignore user-guidance[: rule]: <reason>` — exempt the file. */
const IGNORE_RE =
  /meta-factory-ignore\s+user-guidance(?:\s+([a-z][a-z-]*))?\s*:/i;

/**
 * An angle-bracket placeholder a human is expected to replace.
 *
 * Restricted to a variable-like name (lowercase word characters, `-`, `_`, or
 * spaces) so HTML tags, TypeScript generics (`<T>`), comparisons, and
 * `<https://…>` autolinks do not match by accident.
 */
const PLACEHOLDER_RE = /<([a-z][a-z0-9]*(?:[-_ ][a-z0-9_-]+)*)>/g;

/** Common HTML element names — never a command placeholder. */
const HTML_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "main",
  "map",
  "mark",
  "menu",
  "meta",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "param",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "slot",
  "small",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

/** A known command whose arguments must be concrete. */
const KNOWN_COMMAND_RE =
  /\b(?:swamp|systemctl|journalctl|curl|wget|ssh|scp|rsync|git|kubectl|docker|podman|sudo|npm|npx|pnpm|yarn|deno|brew|apt|apt-get|dnf|yum|pacman|snap|pip|pip3|python|python3|node|bash|sh|zsh|fish|launchctl|service|aws|gcloud|az|terraform|helm|sqlite3|psql|mysql|openssl|caddy|tail|grep|cat|find|jq)\b/i;

/** A runtime message that is printed to the user (error, warning, log). */
const RUNTIME_MESSAGE_RE =
  /\b(?:throw\s+new\s+Error|new\s+Error|logger\??\.(?:error|warn|info|debug)|console\.(?:error|warn|log))\b/;

/** Type names that appear as `<string>` in a code snippet, not a placeholder. */
const TYPE_NAMES: ReadonlySet<string> = new Set([
  "any",
  "bigint",
  "boolean",
  "false",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "true",
  "undefined",
  "unknown",
  "void",
]);

/** Whether `before` ends inside the value of an `--input key=` the user supplies. */
function isInputValue(before: string): boolean {
  return /[A-Za-z0-9_.-]+=[^\s]*$/.test(before) &&
    /(?:--input|--global-arg)\b/.test(before);
}

/** An instruction verb that introduces a command the user should run. */
const INSTRUCTION_RE =
  /\b(?:please\s+)?(?:run|re-?run|execute|invoke|try|check|call|inspect|debug)\b/i;

/** A shell prompt or a command line with options. */
const SHELL_PROMPT_RE = /(?:^|\s)(?:\$|>)\s+[a-z]/i;
const COMMAND_OPTION_RE = /\s-{1,2}[a-z0-9]/i;

/** A YAML key that carries a command or a user-facing message. */
const YAML_COMMAND_KEY_RE =
  /^\s*(?:command|commands|shell|exec|run|args|script|message|error|warning|hint|instructions?)\s*:/i;

/**
 * The backtick code span containing `index`, as `{ start, text }`, or null.
 *
 * A command is often written inline in a message (``Check `systemctl …` ``),
 * so the span is a tighter context than the whole line.
 */
function backtickSpanAt(
  line: string,
  index: number,
): { start: number; text: string } | null {
  const before = line.slice(0, index);
  const open = before.lastIndexOf("`");
  if (open < 0) return null;
  const close = line.indexOf("`", index);
  if (close < 0) return null;
  return { start: open + 1, text: line.slice(open + 1, close) };
}

/** Whether a placeholder occurrence sits in a command the user is told to run. */
function inCommandInstruction(line: string, index: number): boolean {
  const span = backtickSpanAt(line, index);
  if (span) {
    const context = span.text;
    return KNOWN_COMMAND_RE.test(context) ||
      COMMAND_OPTION_RE.test(context) ||
      SHELL_PROMPT_RE.test(context);
  }

  const before = line.slice(0, index);
  return COMMAND_OPTION_RE.test(before) ||
    SHELL_PROMPT_RE.test(before) ||
    INSTRUCTION_RE.test(before) ||
    YAML_COMMAND_KEY_RE.test(before);
}

/**
 * Mark source lines that belong to a runtime message (error/log) rather than
 * documentation (`.describe(...)`) or a helper returning prose.
 */
function tsRuntimeMask(lines: string[]): boolean[] {
  return lines.map((line, i) => {
    if (/\.describe\s*\(/.test(line)) return false;
    // A message may be built by concatenating several lines.
    const window = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
    return RUNTIME_MESSAGE_RE.test(window);
  });
}

/**
 * Mark YAML lines that carry a runtime command/message.
 *
 * `description:` is documentation, so it is skipped; the command, message,
 * error, and hint keys (including their block-scalar bodies) are kept.
 */
function yamlRuntimeMask(lines: string[]): boolean[] {
  const mask = lines.map(() => false);
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (trimmed === "") {
        mask[i] = true;
        continue;
      }
      if (indent > blockIndent) {
        mask[i] = true;
        continue;
      }
      blockIndent = -1;
    }
    if (trimmed.startsWith("#")) continue;
    if (YAML_COMMAND_KEY_RE.test(line)) {
      mask[i] = true;
      if (/[:>|]\s*[|>]\s*$/.test(line) || /:\s*$/.test(line)) {
        blockIndent = indent;
      }
    }
  }
  return mask;
}

/** The command snippet to quote in the issue message. */
function commandSnippet(line: string, index: number): string {
  const span = backtickSpanAt(line, index);
  if (span) return span.text.trim();
  return line.trim();
}

/** Lint one file of raw text (already comment-stripped by the caller). */
function lintText(
  text: string,
  path: string | undefined,
  ignored: Set<string>,
  ignoreAll: boolean,
  mask: boolean[],
): UserGuidanceIssue[] {
  if (ignoreAll || ignored.has("substitution-placeholder")) return [];
  const issues: UserGuidanceIssue[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i]) continue;
    const line = lines[i];
    PLACEHOLDER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_RE.exec(line)) !== null) {
      const placeholder = match[0];
      const name = match[1].toLowerCase();
      if (HTML_TAGS.has(name) || TYPE_NAMES.has(name)) continue;
      if (isInputValue(line.slice(0, match.index))) continue;
      if (!inCommandInstruction(line, match.index)) continue;
      issues.push({
        severity: "error",
        rule: "substitution-placeholder",
        line: i + 1,
        placeholder,
        command: commandSnippet(line, match.index),
        message: `\`${commandSnippet(line, match.index)}\` tells the user to ` +
          `substitute ${placeholder} — print the real value instead (the ` +
          `extension/workflow already knows it) so the command can be copied ` +
          `and pasted as-is (or add ` +
          `\`// meta-factory-ignore user-guidance: <reason>\`)`,
        path,
      });
    }
  }
  return issues;
}

/**
 * Lint one model source (`.ts`) or workflow definition for user-guidance
 * anti-patterns.
 *
 * Workflow files are detected by `.yaml`/`.yml`; everything else is treated as
 * TypeScript. Comments are excluded so a maintainer note is not mistaken for a
 * runtime instruction.
 */
export function lintUserGuidance(
  source: string,
  path?: string,
  kind?: "ts" | "yaml",
): UserGuidanceIssue[] {
  const ignored = new Set<string>();
  let ignoreAll = false;
  for (const line of source.split("\n")) {
    const m = IGNORE_RE.exec(line);
    if (!m) continue;
    if (m[1]) ignored.add(m[1].toLowerCase());
    else ignoreAll = true;
  }

  const isYaml = kind === "yaml" ||
    (kind === undefined && /\.ya?ml$/i.test(path ?? ""));
  if (!isYaml) {
    // Remove JS/TS comments but keep strings (where the guidance lives), and
    // only keep runtime error/log messages — not `.describe()` docs or helper
    // prose that merely mentions a variable name.
    const code = stripComments(source);
    const withoutCommentLines = code.split("\n").map((line) =>
      line.trimStart().startsWith("//") ? "" : line
    ).join("\n");
    const lines = withoutCommentLines.split("\n");
    return lintText(
      withoutCommentLines,
      path,
      ignored,
      ignoreAll,
      tsRuntimeMask(lines),
    );
  }

  // YAML comments are documentation, not runtime output; `description:` blocks
  // are docs too. Only command/message/error/hint values are user guidance.
  const code = source.split("\n").map((line) =>
    line.trimStart().startsWith("#") ? "" : line
  ).join("\n");
  const lines = code.split("\n");
  return lintText(code, path, ignored, ignoreAll, yamlRuntimeMask(lines));
}

/**
 * Command-hygiene rules for DOCUMENTATION text (a manifest `description:`
 * block or a README) — the commands a reader is told to paste.
 *
 * A command that cannot be pasted is as broken as a wrong one:
 *
 *   - `invalid-argv`  `swamp model <name> …`: `model` takes a subcommand, so a
 *                     model name there never runs — the name goes after
 *                     `method run`. Also catches a stray `method` in
 *                     `swamp behavior run <name> method …`.
 *   - `broken-continuation`  a command line that does not end in a backslash
 *                     but is followed by a line continuing its arguments
 *                     (`-…`), so the wrap is not a legal continuation.
 *   - `split-quote`   an unbalanced single quote with no trailing backslash: a
 *                     backslash-newline inside single quotes is literal, so
 *                     the value is corrupted rather than continued.
 *   - `unpasteable-line`  a command line longer than MAX_COMMAND_LINE. A
 *                     wrapping terminal hands the reader a broken command.
 *                     Warning, not an error: it still runs when unwrapped.
 *
 * Pure with respect to its input, so it is cheap to unit test.
 */
export type CommandRule =
  | "invalid-argv"
  | "broken-continuation"
  | "split-quote"
  | "unpasteable-line";

/** One documentation command-hygiene problem. */
export interface CommandIssue {
  /** `error` fails the guidance check; `warning` is reported only. */
  severity: "error" | "warning";
  /** Which rule. */
  rule: CommandRule;
  /** Human-readable description, including the fix. */
  message: string;
  /** 1-based line number of the offending command. */
  line: number;
  /** The offending command line, trimmed. */
  command: string;
  /** Path of the offending document, when known. */
  path?: string;
}

/** Longest command line that survives being wrapped and copied. */
export const MAX_COMMAND_LINE = 72;

/** `swamp model` subcommands; anything else in that position is a name. */
const MODEL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "cancel",
  "create",
  "delete",
  "edit",
  "evaluate",
  "get",
  "lease",
  "list",
  "method",
  "output",
  "search",
  "type",
  "upgrade",
  "validate",
]);

/** Why a `swamp …` invocation can never run, or "" when it is fine. */
export function invalidArgv(command: string): string {
  const token = command.split(/\s+/);
  if (token[1] === "model") {
    const sub = token[2] ?? "";
    if (sub !== "" && !sub.startsWith("-") && !MODEL_SUBCOMMANDS.has(sub)) {
      return `swamp model ${sub} cannot run: "model" takes a subcommand, not a ` +
        `name. Use "swamp behavior run ${sub} <method>" or the legacy ` +
        `"swamp model method run ${sub} <method>".`;
    }
  }
  if (token[1] === "behavior" || token[1] === "behaviour") {
    if (token[2] === "run" && token[4] === "method") {
      return `stray "method" in "swamp behavior run <name> method": the form ` +
        `is "swamp behavior run <name> <method>".`;
    }
  }
  return "";
}

/**
 * Lint one documentation text for command-hygiene problems.
 *
 * Only lines that invoke `swamp` are judged, so prose and other tools'
 * examples are untouched.
 */
export function lintCommandText(
  text: string,
  path?: string,
): CommandIssue[] {
  const issues: CommandIssue[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.replace(/^\s*\$\s+/, "").trimStart();
    if (!/^swamp\s/.test(trimmed)) continue;
    const command = trimmed.trimEnd();
    // Prose that merely begins with the word "swamp" ("swamp vault at run
    // time through `ctx.vaultService`, not interpolated…") is not a command: a
    // comma-space or a trailing full stop marks a sentence.
    if (/, /.test(command) || /\.$/.test(command)) continue;
    const continues = command.endsWith("\\");
    const add = (
      severity: "error" | "warning",
      rule: CommandRule,
      message: string,
    ) => issues.push({ severity, rule, message, line: i + 1, command, path });

    if (raw.length > MAX_COMMAND_LINE) {
      add(
        "warning",
        "unpasteable-line",
        `${raw.length} characters is past ${MAX_COMMAND_LINE}: a wrapping ` +
          `terminal hands the reader a broken command. Break it BETWEEN ` +
          `arguments with a trailing backslash, or pass the value from a ` +
          `file (--input-file) instead of inline.`,
      );
    }
    if (!continues) {
      const next = (lines[i + 1] ?? "").trim();
      if (/^--?[A-Za-z0-9]/.test(next)) {
        add(
          "error",
          "broken-continuation",
          `this line does not end in a backslash but the next line continues ` +
            `its arguments, so the wrap is not a legal continuation: the ` +
            `reader gets two broken commands.`,
        );
      }
    }
    const quotes = (command.match(/'/g) ?? []).length;
    if (quotes % 2 === 1 && !continues) {
      add(
        "error",
        "split-quote",
        `unbalanced single quote: a quoted value is broken across lines, and ` +
          `a backslash-newline inside single quotes is literal, so the value ` +
          `is corrupted rather than continued.`,
      );
    }
    const argvProblem = invalidArgv(command);
    if (argvProblem !== "") add("error", "invalid-argv", argvProblem);
  }
  return issues;
}

/** Lint every file; the issues carry each file's path. */
export function lintUserGuidances(
  files: UserGuidanceFile[],
): UserGuidanceIssue[] {
  const out: UserGuidanceIssue[] = [];
  for (const file of files) {
    out.push(...lintUserGuidance(file.source, file.path));
  }
  return out;
}
