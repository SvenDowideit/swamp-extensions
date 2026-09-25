/**
 * Code-quality metrics for the meta-factory.
 *
 * Computes a **CRAP score** ("Change Risk Anti-Patterns": complexity and
 * coverage combined) plus the complexity and coverage inputs it is derived
 * from, so the meta-factory can show where an extension's code sits without
 * gating on any of it. There are deliberately no rubric rules here — this is a
 * report, not a check.
 *
 * The pipeline is:
 *
 * 1. **Complexity** — parse each TypeScript entrypoint with `@babel/parser`
 *    (the maintained TypeScript/JSX parser), count decision points per function,
 *    and derive a cyclomatic-complexity number. This is the same shape of metric
 *    a linter like `eslint complexity` reports.
 * 2. **Coverage** — read the `lcov.info` Deno writes for `deno test
 *    --coverage`, giving per-function hit counts.
 * 3. **CRAP** — combine the two per function:
 *    `crap = comp^2 * (1 - coverage)^3 + comp`, the value used by many CI
 *    dashboards. A function that is complex *and* untested scores worst.
 *
 * The CRAP metric and its formula are defined by Alberto Savoia and Bob Evans
 * ("Change Risk Analysis and Prediction", 2007) and implemented by crap4j:
 * <https://www.artima.com/weblogs/viewpost.jsp?thread=215899>.
 * The canonical formula is `CRAP(m) = comp(m)^2 * (1 – cov(m)/100)^3 + comp(m)`;
 * here coverage is carried as a 0..1 fraction, so the division by 100 is folded
 * into the fraction.
 *
 * Parsing and maths are pure ({@link analyzeComplexity},
 * {@link computeCrap}) and unit-tested; filesystem and subprocess work lives in
 * `meta_factory.ts`.
 *
 * @module
 */
import { parse as parseTs } from "npm:@babel/parser@7.28.4";

/** Complexity and size of one function. */
export interface FunctionComplexity {
  /** Function name, or a `<anonymous@line>` placeholder. */
  name: string;
  /** 1-based line where the function starts. */
  line: number;
  /** 1-based line where the function ends. */
  endLine: number;
  /** Cyclomatic complexity (1 = no branches). */
  complexity: number;
  /** Source lines the function spans. */
  loc: number;
}

/** Per-function coverage from an lcov report. */
export interface FunctionCoverage {
  /** Function name as lcov reports it. */
  name: string;
  /** 1-based declaration line. */
  line: number;
  /** Times the function was called. */
  hits: number;
}

/** Per-file coverage from an lcov report: function hits plus line hits. */
export interface FileCoverage {
  /** lcov's top-level function records (named functions only). */
  functions: FunctionCoverage[];
  /** Line number -> execution count, from the `DA:` records. */
  lines: Map<number, number>;
}

/** A function's complexity, coverage, and derived CRAP score. */
export interface FunctionMetric extends FunctionComplexity {
  /** Coverage fraction 0..1 for the function (0 when unknown). */
  coverage: number;
  /** True when lcov had no record for this function. */
  uncovered: boolean;
  /** CRAP score: `comp^2 * (1 - coverage)^3 + comp`. */
  crap: number;
}

/** Aggregate code metrics for one source file. */
export interface FileMetric {
  /** Path relative to the extension directory. */
  file: string;
  /** Functions found in the file. */
  functions: FunctionMetric[];
  /** Total source lines in the file. */
  loc: number;
  /** Sum of function complexities. */
  totalComplexity: number;
  /** Highest function complexity. */
  maxComplexity: number;
  /** Mean function complexity (0 when no functions). */
  averageComplexity: number;
  /** Mean function coverage across functions with an lcov record. */
  coverage: number;
  /** Highest CRAP score in the file. */
  maxCrap: number;
  /** Mean CRAP across functions. */
  averageCrap: number;
}

/** Aggregate code metrics for a whole extension. */
export interface CodeMetrics {
  /** Number of source files analysed. */
  files: number;
  /** Total source lines. */
  loc: number;
  /** Total functions. */
  functions: number;
  /** Sum of function complexities. */
  totalComplexity: number;
  /** Highest single-function complexity. */
  maxComplexity: number;
  /** Mean function complexity. */
  averageComplexity: number;
  /** Line coverage fraction 0..1 across analysed files (0 when unknown). */
  coverage: number;
  /** Function coverage fraction 0..1 (0 when unknown). */
  functionCoverage: number;
  /** Highest CRAP score across all functions. */
  maxCrap: number;
  /** Mean CRAP across all functions. */
  averageCrap: number;
  /** CRAP score for the whole extension (complexity + coverage). */
  crapScore: number;
  /** True when a coverage report was available and joined. */
  coverageAvailable: boolean;
  /** Per-file breakdown. */
  byFile: FileMetric[];
  /** The worst functions by CRAP score, highest first (capped). */
  worstFunctions: FunctionMetric[];
}

// ---------------------------------------------------------------------------
// Complexity
// ---------------------------------------------------------------------------

/**
 * Count decision points in a subtree, excluding nested functions.
 *
 * Nested function bodies are skipped so complexity is attributed to the
 * function that owns the branch, not to every enclosing function — matching
 * how `eslint complexity` and `gocyclo` count. The `isRoot` flag lets the
 * function's own body be walked without the nested-function guard stopping at
 * the root itself.
 */
function branchCount(root: unknown): number {
  let count = 0;
  // deno-lint-ignore no-explicit-any
  const walk = (node: any, isRoot = false): void => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "IfStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "CatchClause":
      case "ConditionalExpression":
        count++;
        break;
      case "SwitchCase":
        // The default case is not a branch.
        if (node.test) count++;
        break;
      case "LogicalExpression":
        if (
          node.operator === "&&" || node.operator === "||" ||
          node.operator === "??"
        ) {
          count++;
        }
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        // Do not descend into a nested function: its branches belong to it.
        // The root function is exempt so its own body is walked.
        if (!isRoot) return;
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (
        key === "parent" || key === "loc" || key === "range" ||
        key === "start" || key === "end"
      ) {
        continue;
      }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) walk(c);
      } else if (child && typeof child.type === "string") {
        walk(child);
      }
    }
  };
  walk(root, true);
  return count;
}

/** A function node found during the walk, with its name and start line. */
interface FoundFunction {
  name: string;
  line: number;
  endLine: number;
  node: unknown;
}

/**
 * Babel AST node types that represent a callable function.
 *
 * Babel distinguishes `ObjectMethod`/`ClassMethod`/`ClassPrivateMethod` from a
 * plain function; all are counted so complexity is attributed to the method the
 * reader sees, not to a synthetic wrapper.
 */
const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

/** Derive a readable function name from a babel function/method node. */
// deno-lint-ignore no-explicit-any
function functionName(node: any): string {
  if (node.id?.name) return node.id.name;
  if (node.key) {
    if (node.key.name) return String(node.key.name);
    if (node.key.value !== undefined) return String(node.key.value);
  }
  if (node.parent?.type === "VariableDeclarator" && node.parent.id?.name) {
    return String(node.parent.id.name);
  }
  if (node.parent?.type === "AssignmentExpression") {
    const left = node.parent.left;
    if (left?.name) return String(left.name);
    if (left?.property?.name) return String(left.property.name);
  }
  return "";
}

/** Recursively collect every function-like node in the AST. */
function collectFunctions(ast: unknown): FoundFunction[] {
  const out: FoundFunction[] = [];
  // deno-lint-ignore no-explicit-any
  const walk = (node: any, parent: any): void => {
    if (!node || typeof node.type !== "string") return;
    node.parent = parent;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const line = node.loc?.start?.line ?? 0;
      const endLine = node.loc?.end?.line ?? line;
      const name = functionName(node) || `<anonymous@${line}>`;
      out.push({ name, line, endLine, node });
    }
    for (const key of Object.keys(node)) {
      if (key === "parent" || key === "loc" || key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) walk(c, node);
      } else if (child && typeof child.type === "string") {
        walk(child, node);
      }
    }
  };
  walk(ast, null);
  return out;
}

/**
 * Parse TypeScript source and return per-function complexity.
 *
 * Returns an empty array when the source cannot be parsed — a metrics report
 * must never fail a run — so callers can treat "no functions" as "nothing to
 * say" rather than an error.
 *
 * @param source TypeScript source text.
 * @param fileName File name used in parser diagnostics only.
 */
export function analyzeComplexity(
  source: string,
  fileName = "module.ts",
): FunctionComplexity[] {
  let ast: unknown;
  try {
    ast = parseTs(source, {
      sourceType: "module",
      plugins: [
        "typescript",
        "jsx",
        ["decorators", { decoratorsBeforeExport: true }],
      ],
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      sourceFilename: fileName,
    });
  } catch {
    return [];
  }
  return collectFunctions(ast).map((fn) => ({
    name: fn.name,
    line: fn.line,
    endLine: fn.endLine,
    complexity: 1 + branchCount(fn.node),
    loc: Math.max(1, fn.endLine - fn.line + 1),
  }));
}

// ---------------------------------------------------------------------------
// Coverage (lcov)
// ---------------------------------------------------------------------------

/** Parse a single `SF:`-delimited lcov record into function + line coverage. */
function parseLcovRecord(record: string): FileCoverage {
  const names = new Map<number, string>();
  // lcov's `FNDA` is `count,name`; map name -> hit count, then bind to the
  // declaration line from `FN:<line>,<name>`.
  const hitsByName = new Map<string, number>();
  const lines = new Map<number, number>();
  for (const raw of record.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("FN:")) {
      const [ln, ...rest] = line.slice(3).split(",");
      names.set(Number(ln), rest.join(","));
    } else if (line.startsWith("FNDA:")) {
      const [count, ...rest] = line.slice(5).split(",");
      hitsByName.set(rest.join(","), Number(count));
    } else if (line.startsWith("DA:")) {
      const [ln, count] = line.slice(3).split(",");
      lines.set(Number(ln), Number(count));
    }
  }
  const functions: FunctionCoverage[] = [];
  for (const [ln, name] of names) {
    functions.push({ name, line: ln, hits: hitsByName.get(name) ?? 0 });
  }
  return { functions, lines };
}

/**
 * Parse an lcov report into per-file coverage.
 *
 * @param lcov Raw `lcov.info` text.
 * @returns Map from absolute source path to function hits and line hits.
 */
export function parseLcov(lcov: string): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  for (const record of lcov.split("end_of_record")) {
    const sf = record.split("\n").find((l) => l.trim().startsWith("SF:"));
    if (!sf) continue;
    const path = sf.trim().slice(3).trim();
    out.set(path, parseLcovRecord(record));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRAP
// ---------------------------------------------------------------------------

/**
 * Compute the CRAP score for a function.
 *
 * `crap = comp^2 * (1 - coverage)^3 + comp`. A simple function stays low even
 * when untested; a complex, untested function scores worst. This is the formula
 * from Savoia & Evans' original CRAP metric (crap4j, 2007):
 * <https://www.artima.com/weblogs/viewpost.jsp?thread=215899>.
 *
 * @param complexity Cyclomatic complexity (>= 1).
 * @param coverage Coverage fraction 0..1.
 */
export function computeCrap(complexity: number, coverage: number): number {
  const c = Math.max(0, Math.min(1, coverage));
  const comp = Math.max(1, complexity);
  return comp * comp * Math.pow(1 - c, 3) + comp;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Join complexity rows with lcov coverage for one file.
 *
 * Coverage is computed from the **line hits** (`DA:` records) across the
 * function's own line span. lcov only emits top-level `FN:` records for named
 * functions, so using function-hit records alone would mark every arrow and
 * nested function uncovered; measuring the executed lines inside each
 * function's span works for all of them and matches line-based coverage.
 *
 * A function with no measured lines (e.g. all its lines are non-instrumentable)
 * is treated as covered when its nearest named-function record has hits, and
 * uncovered otherwise.
 */
export function joinFileCoverage(
  functions: FunctionComplexity[],
  coverage: FileCoverage | undefined,
): FunctionMetric[] {
  return functions.map((fn) => {
    let measured = 0;
    let hit = 0;
    if (coverage) {
      for (let line = fn.line; line <= fn.endLine; line++) {
        const count = coverage.lines.get(line);
        if (count === undefined) continue;
        measured++;
        if (count > 0) hit++;
      }
    }
    let coverageFraction: number;
    let uncovered: boolean;
    if (measured > 0) {
      coverageFraction = hit / measured;
      uncovered = hit === 0;
    } else if (coverage) {
      // No instrumented lines in this span: fall back to the nearest named
      // function record at or before the start line.
      const record = coverage.functions
        .filter((c) => c.line <= fn.line)
        .sort((a, b) => b.line - a.line)
        .find((c) => fn.line - c.line <= 2);
      coverageFraction = record ? (record.hits > 0 ? 1 : 0) : 0;
      uncovered = !record || record.hits === 0;
    } else {
      coverageFraction = 0;
      uncovered = true;
    }
    return {
      ...fn,
      coverage: coverageFraction,
      uncovered,
      crap: computeCrap(fn.complexity, coverageFraction),
    };
  });
}

/** Roll a set of per-file metrics into the extension-level aggregate. */
export function aggregateMetrics(byFile: FileMetric[]): CodeMetrics {
  const functions = byFile.flatMap((f) => f.functions);
  const loc = byFile.reduce((s, f) => s + f.loc, 0);
  const totalComplexity = functions.reduce((s, f) => s + f.complexity, 0);
  const maxComplexity = functions.reduce(
    (m, f) => Math.max(m, f.complexity),
    0,
  );
  const averageComplexity = functions.length > 0
    ? totalComplexity / functions.length
    : 0;

  const withCov = functions.filter((f) => !f.uncovered);
  const coverage = withCov.length > 0
    ? withCov.reduce((s, f) => s + f.coverage, 0) / withCov.length
    : 0;
  const functionCoverage = functions.length > 0
    ? functions.filter((f) => !f.uncovered).length / functions.length
    : 0;

  const crapValues = functions.map((f) => f.crap);
  const maxCrap = crapValues.reduce((m, c) => Math.max(m, c), 0);
  const averageCrap = crapValues.length > 0
    ? crapValues.reduce((s, c) => s + c, 0) / crapValues.length
    : 0;

  const worstFunctions = [...functions]
    .sort((a, b) => b.crap - a.crap)
    .slice(0, 10);

  return {
    files: byFile.length,
    loc,
    functions: functions.length,
    totalComplexity,
    maxComplexity,
    averageComplexity,
    coverage,
    functionCoverage,
    maxCrap,
    averageCrap,
    // Extension-level CRAP: average complexity against overall coverage. Zero
    // when there is nothing to measure, so an empty extension does not appear
    // to have a scored result.
    crapScore: functions.length > 0
      ? computeCrap(averageComplexity || 1, coverage)
      : 0,
    coverageAvailable: withCov.length > 0,
    byFile,
    worstFunctions,
  };
}
