/**
 * Unit tests for `@svendowideit/nanokvm-health-report`.
 *
 * The report only reads swamp data, so a fake workflow context with an
 * in-memory `dataRepository` covers both the "devices found" success path and
 * the "nothing recorded" path without touching a device.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./nanokvm_health_report.ts";

interface FakeHandle {
  name: string;
  specName: string;
  kind: string;
}

/** Build a report context whose repository answers from a name→JSON map. */
function contextWith(
  records: Array<{ specName: string; data: Record<string, unknown> }>,
  workflowStatus: "succeeded" | "failed" = "succeeded",
) {
  const stepExecutions = [{
    jobName: "health",
    stepName: "check",
    modelName: "nanokvm",
    modelType: "@svendowideit/nanokvm",
    methodName: "health",
    status: "succeeded" as const,
    modelId: "model-1",
    globalArgs: {},
    dataHandles: records.map((r, i): FakeHandle => ({
      name: `${r.specName}-${i}`,
      specName: r.specName,
      kind: "data",
    })),
  }];
  return {
    scope: "workflow" as const,
    repoDir: "/tmp",
    workflowName: "@figy/nanokvm-health",
    workflowStatus,
    stepExecutions,
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        dataName: string,
      ): Promise<Uint8Array | null> => {
        const idx = Number(dataName.split("-").pop());
        const record = records[idx];
        if (!record) return Promise.resolve(null);
        return Promise.resolve(
          new TextEncoder().encode(JSON.stringify(record.data)),
        );
      },
    },
    logger: { info: () => {} },
  };
}

Deno.test("report renders a device verdict, findings and emit summary", async () => {
  const context = contextWith([
    {
      specName: "health",
      data: {
        host: "192.0.2.10",
        verdict: "warn",
        reachable: true,
        authenticated: true,
        appVersion: "2.3.0",
        firmwareOutdated: true,
        mountedImage: "",
        hidMode: "normal",
        responseMs: 12,
        findings: [{
          code: "firmware_update",
          severity: "warn",
          message: "2.4.0 is available",
        }],
        checkedAt: "2026-10-17T00:00:00.000Z",
      },
    },
    {
      specName: "emit",
      data: {
        skipped: false,
        pushed: true,
        endpoint: "http://127.0.0.1:4318",
      },
    },
  ]);
  const result = await report.execute(context);
  assertEquals(result.json.overall, "warn");
  assertEquals(result.json.devicesTotal, 1);
  assertEquals(result.markdown.includes("firmware_update"), true);
  assertEquals(result.markdown.includes("http://127.0.0.1:4318"), true);
});

Deno.test("report fails a device and records nothing else", async () => {
  const context = contextWith([{
    specName: "health",
    data: {
      host: "192.0.2.11",
      verdict: "fail",
      reachable: false,
      authenticated: false,
      findings: [{
        code: "unreachable",
        severity: "error",
        message: "no reply",
      }],
      checkedAt: "2026-10-17T00:00:00.000Z",
    },
  }]);
  const result = await report.execute(context);
  assertEquals(result.json.overall, "fail");
  assertEquals(result.markdown.includes("❌"), true);
});

Deno.test("report says so when no device health was recorded", async () => {
  const result = await report.execute(contextWith([]));
  assertEquals(result.json.devicesTotal, 0);
  assertEquals(result.markdown.includes("No device health"), true);
});
