/**
 * Tests for the herdr-core terminal-session report.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { formatTerminalSession, report } from "./herdr_core_report.ts";

Deno.test("terminal-session report renders the method data", () => {
  const by = new Map<string, Array<Record<string, unknown>>>([
    ["run-result", [{
      address: "t7",
      state: "finished",
      exitCode: 0,
      reason: "exit",
      output: "tests passed",
    }]],
    ["exec-result", [{
      machine: "xeon",
      code: 0,
      ms: 12,
      stdout: "ok",
      stderr: "",
    }]],
    ["file-result", [{
      operation: "edit",
      machine: "",
      path: "src/x.ts",
      bytes: 42,
      lineCount: 2,
    }]],
    ["search-result", [{
      pattern: "needle",
      count: 1,
      truncated: false,
      matches: [{ path: "src/x.ts", line: 3, column: 5, text: "needle" }],
    }]],
    ["fleet", [{
      count: 2,
      byAgent: { pi: 2 },
      byMachine: { local: 2 },
    }]],
    ["otel-status", [{
      enabled: true,
      endpoint: "https://otlp.example/v1/traces",
      mesh: "tailscale",
      tokenPresent: false,
      reason: "otel-settings",
    }]],
  ]);
  const out = formatTerminalSession("exec", by);
  for (
    const expected of [
      "# Terminal session — exec",
      "## Run",
      "t7",
      "## Commands",
      "xeon",
      "## Files",
      "src/x.ts",
      "## Search",
      "needle",
      "## Terminals",
      "## Tracing",
    ]
  ) {
    assertStringIncludes(out.markdown, expected);
  }
  assertEquals(out.json.method, "exec");
});

Deno.test("terminal-session report renders failures", () => {
  const out = formatTerminalSession("run", new Map(), "boom");
  assertStringIncludes(out.markdown, "**Failed:** boom");
});

Deno.test("terminal-session report says when there is no data", () => {
  const out = formatTerminalSession("status", new Map());
  assertStringIncludes(out.markdown, "No summary data");
});

Deno.test("terminal-session report metadata", () => {
  assertEquals(report.name, "@svendowideit/terminal-session");
  assertEquals(report.scope, "method");
});
