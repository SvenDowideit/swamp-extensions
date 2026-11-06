/**
 * Home-path lint for swamp extension model sources.
 *
 * **Rule:** an extension must not derive *swamp's own* operational paths
 * (`~/.swamp` or `SWAMP_HOME`) directly from `HOME`/`USERPROFILE` — those
 * low-level reads bypass `SWAMP_HOME` and break a relocated data directory.
 * Ordinary user locations (`~/.config`, `~/.local/share`, ...) are fine.
 *
 * A justified case is exempted with `// meta-factory-ignore home-paths: <reason>`.
 */

export type HomePathRule = "home-derived-swamp-path";

export interface HomePathIssue {
  severity: "error";
  rule: HomePathRule;
  message: string;
  line: number;
  path?: string;
}

export interface HomePathFile {
  path: string;
  source: string;
}

const IGNORE_RE = /meta-factory-ignore\s+home-paths\s*:/;

export function stripComments(source: string): string {
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
      } else out += " ";
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        i++;
      } else out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === quote) quote = null;
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
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

export function lintHomePaths(source: string, path?: string): HomePathIssue[] {
  const rawLines = source.split("\n");
  const lines = stripComments(source).split("\n");
  const exempt = new Set<number>();
  for (let i = 0; i < rawLines.length; i++) {
    if (IGNORE_RE.test(rawLines[i])) {
      exempt.add(i);
      exempt.add(i - 1);
      exempt.add(i + 1);
    }
  }
  const issues: HomePathIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (exempt.has(i)) continue;
    const code = lines[i];
    if (!/Deno\.env\.get\(\s*["'](HOME|USERPROFILE)["']\s*\)/.test(code)) {
      continue;
    }
    if (!/\.swamp/.test(code)) continue;
    if (/SWAMP_HOME/.test(code)) continue;
    issues.push({
      severity: "error",
      rule: "home-derived-swamp-path",
      path,
      line: i + 1,
      message:
        "do not derive swamp data paths directly from HOME/USERPROFILE; " +
        "honour SWAMP_HOME (getSwampDataDir / a SWAMP_HOME-aware expandHome).",
    });
  }
  return issues;
}

export function lintHomePathSources(
  files: readonly { path: string; source: string }[],
): HomePathIssue[] {
  const out: HomePathIssue[] = [];
  for (const f of files) out.push(...lintHomePaths(f.source, f.path));
  return out;
}
