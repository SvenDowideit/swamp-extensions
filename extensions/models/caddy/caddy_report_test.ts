import { assert, assertStringIncludes } from "jsr:@std/assert@1";

import { report } from "./caddy_report.ts";

// deno-lint-ignore no-explicit-any
function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    scope: "method",
    modelType: "@svendowideit/caddy",
    modelId: "m1",
    methodName: "audit",
    executionStatus: "succeeded",
    dataHandles: [{ name: "audit", specName: "audit", kind: "resource" }],
    dataRepository: {
      getContent: () =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify({
          cadies: [
            {
              target: "host\u0000caddy",
              adminApiAddr: "localhost:2019",
              serviceName: "caddy",
              models: ["a", "b"],
              conflicts: [],
              desiredRoutes: [
                {
                  hostname: "x.example.com",
                  kind: "proxy",
                  upstream: "127.0.0.1:8080",
                  root: "",
                  model: "a",
                },
              ],
              actualSwampRoutes: [],
              foreignRoutes: ["manual.example.com"],
              onlyDesired: ["y.example.com"],
              onlyActual: [],
              inSync: false,
              reachable: true,
              error: "",
            },
          ],
          modelCount: 2,
          inSync: false,
        }))),
    },
    logger: { info: () => {} },
    ...overrides,
  };
}

Deno.test("caddy-status report renders a table per caddy", async () => {
  const { markdown } = await report.execute(ctx());
  assertStringIncludes(markdown, "Caddy status");
  assertStringIncludes(markdown, "host · caddy");
  assertStringIncludes(markdown, "DRIFT");
  assertStringIncludes(markdown, "x.example.com");
  assertStringIncludes(markdown, "`a`");
  assertStringIncludes(markdown, "Wanted but not live");
  assertStringIncludes(markdown, "manual.example.com");
});

Deno.test("caddy-status report is silent for unrelated methods", async () => {
  const { markdown } = await report.execute(ctx({ methodName: "checkHealth" }));
  assert(markdown === "");
});

Deno.test("caddy-status report is silent on failure", async () => {
  const { markdown } = await report.execute(ctx({ executionStatus: "failed" }));
  assert(markdown === "");
});

Deno.test("caddy-status report handles plan shape (single caddy)", async () => {
  const planCtx = ctx({
    methodName: "plan",
    dataHandles: [{ name: "plan", specName: "plan", kind: "resource" }],
    dataRepository: {
      getContent: () =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify({
          target: "host\u0000caddy",
          adminApiAddr: "localhost:2019",
          serviceName: "caddy",
          models: ["a"],
          conflicts: [],
          desiredRoutes: [],
          actualSwampRoutes: [],
          foreignRoutes: [],
          onlyDesired: [],
          onlyActual: [],
          inSync: true,
          reachable: true,
          error: "",
        }))),
    },
  });
  const { markdown } = await report.execute(planCtx);
  assertStringIncludes(markdown, "in sync");
});
