/**
 * Tests for @svendowideit/swamp-ide-openobserve.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  basicAuth,
  buildAgentIdeDashboard,
  dashboardViewUrl,
  model,
  normaliseBaseUrl,
} from "./swamp_ide_openobserve.ts";

Deno.test("normaliseBaseUrl drops trailing slashes", () => {
  assertEquals(normaliseBaseUrl("https://obs.example/"), "https://obs.example");
});

Deno.test("basicAuth encodes the login", () => {
  assertEquals(
    basicAuth("a@example.com", "secret"),
    "Basic YUBleGFtcGxlLmNvbTpzZWNyZXQ=",
  );
});

Deno.test("buildAgentIdeDashboard separates routed and bypassed spans", () => {
  const body = buildAgentIdeDashboard("Swamp Agent IDE", "default", "default");
  assertEquals(body.version, 8);
  const tabs = body.tabs as Array<Record<string, unknown>>;
  const panels = tabs[0].panels as Array<Record<string, unknown>>;
  assertEquals(panels.length, 6);
  const sql = panels.map((panel) => {
    const queries = panel.queries as Array<Record<string, unknown>>;
    return String(queries[0].query ?? "");
  }).join("\n");
  assertStringIncludes(sql, "bypass.%");
  assertStringIncludes(sql, "bypass.bash.%");
  assertStringIncludes(sql, "tool.bash.%");
  assertStringIncludes(sql, "swamp-herdr-core");
  assertStringIncludes(sql, "swamp-vim");
  assertStringIncludes(sql, "swamp_outcome");
});

Deno.test("dashboardViewUrl points at the dashboard view", () => {
  const url = dashboardViewUrl(
    "https://obs.example",
    "default",
    "abc 123",
    "default",
  );
  assertStringIncludes(url, "/web/dashboards/view?");
  assertStringIncludes(url, "dashboard=abc%20123");
});

Deno.test("model exposes dashboard and status", () => {
  assertEquals(model.type, "@svendowideit/swamp-ide-openobserve");
  assertEquals(Object.keys(model.methods).sort(), ["dashboard", "status"]);
});
