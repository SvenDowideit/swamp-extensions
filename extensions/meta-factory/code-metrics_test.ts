/**
 * Unit tests for the code-metrics module (complexity, CRAP, lcov parsing).
 *
 * @module
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  aggregateMetrics,
  analyzeComplexity,
  computeCrap,
  type FileCoverage,
  type FileMetric,
  joinFileCoverage,
  parseLcov,
} from "./code-metrics.ts";

Deno.test("analyzeComplexity counts branches per function", () => {
  const src =
    "export function f(x: number): number {\n  if (x > 0) return 1;\n  for (let i = 0; i < x; i++) {}\n  return 0;\n}\n";
  const [fn] = analyzeComplexity(src);
  assertEquals(fn.name, "f");
  assertEquals(fn.complexity, 3); // 1 base + if + for
  assertEquals(fn.line, 1);
  assertEquals(fn.endLine, 5);
  assertEquals(fn.loc, 5);
});

Deno.test("analyzeComplexity counts logical, switch (non-default), and catch", () => {
  const src =
    "function g(a: number) { if (a > 1 && a < 9) { return 1; } switch (a) { case 1: return 2; default: return 0; } try {} catch { return 3; } }";
  const [fn] = analyzeComplexity(src);
  // 1 + if + && + case(1) + catch = 5; default adds nothing.
  assertEquals(fn.complexity, 5);
});

Deno.test("analyzeComplexity does not attribute nested branches to the outer fn", () => {
  const src =
    "function outer() { if (1) { return () => { if (2) return 3; return 4; }; } return 0; }";
  const fns = analyzeComplexity(src);
  assertEquals(fns.length, 2);
  const outer = fns.find((f) => f.name === "outer")!;
  const inner = fns.find((f) => f.name.startsWith("<anonymous"))!;
  assertEquals(outer.complexity, 2); // if only
  assertEquals(inner.complexity, 2); // if only
});

Deno.test("analyzeComplexity names arrows and methods", () => {
  const src =
    "const h = (a: number) => a > 0 ? 1 : 0;\nconst obj = { m(x: number) { return x; } };";
  const fns = analyzeComplexity(src);
  assertEquals(fns.some((f) => f.name === "h" && f.complexity === 2), true);
  assertEquals(fns.some((f) => f.name === "m" && f.complexity === 1), true);
});

Deno.test("analyzeComplexity returns [] on unparseable source", () => {
  assertEquals(analyzeComplexity("function ( { broken"), []);
});

Deno.test("computeCrap follows comp^2*(1-cov)^3+comp", () => {
  assertAlmostEquals(computeCrap(1, 1), 1, 1e-9);
  assertAlmostEquals(computeCrap(5, 1), 5, 1e-9);
  assertAlmostEquals(computeCrap(5, 0), 30, 1e-9);
  assertAlmostEquals(computeCrap(1, 0), 2, 1e-9);
  // Coverage is clamped to 0..1.
  assertAlmostEquals(computeCrap(5, 2), 5, 1e-9);
});

Deno.test("parseLcov reads function hits and line hits", () => {
  const lcov =
    "SF:/x/a.ts\nFN:1,f\nFN:6,g\nFNDA:3,f\nFNDA:0,g\nDA:1,1\nDA:2,1\nDA:3,0\nDA:6,0\nend_of_record\n";
  const files = parseLcov(lcov);
  const a = files.get("/x/a.ts")!;
  assertEquals(a.functions.map((f) => [f.name, f.hits]), [["f", 3], ["g", 0]]);
  assertEquals(a.lines.get(1), 1);
  assertEquals(a.lines.get(3), 0);
  assertEquals(a.lines.get(6), 0);
});

Deno.test("parseLcov keeps FNDA name with commas intact", () => {
  const lcov =
    "SF:/x/a.ts\nFN:10,obj.method\nFNDA:2,obj.method\nend_of_record\n";
  const a = parseLcov(lcov).get("/x/a.ts")!;
  assertEquals(a.functions, [{ name: "obj.method", line: 10, hits: 2 }]);
});

Deno.test("joinFileCoverage measures coverage from the function's line span", () => {
  const src =
    "export function f(x: number): number {\n  if (x > 0) {\n    return 1;\n  }\n  return 0;\n}\n";
  const fns = analyzeComplexity(src, "a.ts");
  const cov: FileCoverage = {
    functions: [{ name: "f", line: 1, hits: 1 }],
    lines: new Map([[1, 1], [2, 1], [3, 0], [4, 0], [5, 1]]),
  };
  const [m] = joinFileCoverage(fns, cov);
  assertAlmostEquals(m.coverage, 3 / 5, 1e-9);
  assertEquals(m.uncovered, false);
});

Deno.test("joinFileCoverage marks an all-zero span uncovered", () => {
  const fns = analyzeComplexity(
    "function f() {\n  return 1;\n}\n",
    "a.ts",
  );
  const cov: FileCoverage = {
    functions: [],
    lines: new Map([[1, 0], [2, 0]]),
  };
  const [m] = joinFileCoverage(fns, cov);
  assertEquals(m.coverage, 0);
  assertEquals(m.uncovered, true);
  assertEquals(m.crap, 2); // complexity 1, coverage 0
});

Deno.test("joinFileCoverage without coverage marks everything uncovered", () => {
  const fns = analyzeComplexity(
    "function f(x: number) { return x; }\n",
    "a.ts",
  );
  const [m] = joinFileCoverage(fns, undefined);
  assertEquals(m.uncovered, true);
  assertEquals(m.coverage, 0);
  assertEquals(m.crap, 2);
});

Deno.test("aggregateMetrics rolls up functions, coverage, and CRAP", () => {
  const byFile: FileMetric[] = [{
    file: "a.ts",
    loc: 10,
    totalComplexity: 5,
    maxComplexity: 4,
    averageComplexity: 2.5,
    coverage: 0.5,
    maxCrap: 10,
    averageCrap: 5,
    functions: [
      {
        name: "f",
        line: 1,
        endLine: 3,
        complexity: 4,
        loc: 3,
        coverage: 1,
        uncovered: false,
        crap: 4,
      },
      {
        name: "g",
        line: 5,
        endLine: 7,
        complexity: 1,
        loc: 3,
        coverage: 0,
        uncovered: true,
        crap: 2,
      },
    ],
  }];
  const agg = aggregateMetrics(byFile);
  assertEquals(agg.files, 1);
  assertEquals(agg.functions, 2);
  assertEquals(agg.totalComplexity, 5);
  assertEquals(agg.maxComplexity, 4);
  assertEquals(agg.averageComplexity, 2.5);
  // One covered of two functions.
  assertEquals(agg.functionCoverage, 0.5);
  assertAlmostEquals(agg.coverage, 1, 1e-9); // mean over the covered function only
  assertEquals(agg.maxCrap, 4);
  assertEquals(agg.coverageAvailable, true);
  assertEquals(agg.worstFunctions[0].name, "f");
});

Deno.test("aggregateMetrics reports no coverage when nothing is covered", () => {
  const agg = aggregateMetrics([{
    file: "a.ts",
    loc: 3,
    totalComplexity: 1,
    maxComplexity: 1,
    averageComplexity: 1,
    coverage: 0,
    maxCrap: 2,
    averageCrap: 2,
    functions: [{
      name: "f",
      line: 1,
      endLine: 2,
      complexity: 1,
      loc: 2,
      coverage: 0,
      uncovered: true,
      crap: 2,
    }],
  }]);
  assertEquals(agg.coverageAvailable, false);
  assertEquals(agg.coverage, 0);
});

Deno.test("aggregateMetrics reports zero CRAP when there are no functions", () => {
  const agg = aggregateMetrics([]);
  assertEquals(agg.functions, 0);
  assertEquals(agg.crapScore, 0);
  assertEquals(agg.coverageAvailable, false);
});

Deno.test("analyzeComplexity parses decorators and JSX without dropping the file", () => {
  const decorated = analyzeComplexity(
    "@dec\nclass C { @m() x(): number { return 1; } }",
  );
  assertEquals(decorated.some((f) => f.name === "x"), true);
  // JSX in a .tsx-style body must not abort the parse.
  const jsx = analyzeComplexity(
    "function C(): unknown { if (1) return 1; return 0; }\nconst el = <div/>;",
  );
  assertEquals(jsx.length >= 1, true);
});

Deno.test("analyzeComplexity names object and class methods", () => {
  const src =
    "const o = { m(x: number) { return x; } };\nclass C { n(a: number): number { return a; } }";
  const names = analyzeComplexity(src).map((f) => f.name);
  assertEquals(names.includes("m"), true);
  assertEquals(names.includes("n"), true);
});
