/**
 * Tests for the `@svendowideit/gpu-facts` model: probe selection (`detectGpus`)
 * and the execute-level `collect` run, with the probe commands faked so the
 * test is independent of the machine it runs on. The pure parsers are covered
 * in `gpu_facts_shared_test.ts`.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { detectGpus, type GpuDeps, model } from "./gpu_facts.ts";

const GLOBALS = { name: "gpu", vendorOverride: "auto", deviceIndex: -1 };

/** Build a fake deps whose `run` is backed by a per-command handler. */
function fakeDeps(
  handler: (bin: string, args: string[]) => { code: number; stdout: string },
  uname = "Linux",
): GpuDeps {
  return {
    run: (bin, args) => Promise.resolve(handler(bin, args)),
    readFile: () => Promise.resolve(""),
    uname,
    hardwareConcurrency: 8,
  };
}

Deno.test("detectGpus: nvidia probe wins under auto", async () => {
  const deps = fakeDeps((bin) => {
    if (bin === "nvidia-smi") {
      return { code: 0, stdout: "0, RTX 4090, 24564, 550.54, 8.9\n" };
    }
    return { code: -1, stdout: "" };
  });
  const d = await detectGpus(deps, "auto");
  assertEquals(d.length, 1);
  assertEquals(d[0].name, "RTX 4090");
});

Deno.test("detectGpus: falls back to system_profiler on Apple", async () => {
  const deps = fakeDeps((bin) => {
    if (bin === "system_profiler") {
      return {
        code: 0,
        stdout: JSON.stringify({
          SPDisplaysDataType: [{ sppci_model: "Apple M2 Pro" }],
        }),
      };
    }
    return { code: -1, stdout: "" };
  }, "Darwin");
  const d = await detectGpus(deps, "auto");
  assertEquals(d.length, 1);
  assertEquals(d[0].vendor, "apple");
});

Deno.test("detectGpus: none skips every probe", async () => {
  const deps = fakeDeps(() => ({ code: 0, stdout: "should not be read" }));
  assertEquals(await detectGpus(deps, "none"), []);
});

/** Fake probe commands for the execute-level test. */
function gpuHandler() {
  return (command: string, args: string[]) => {
    if (command === "uname" && args[0] === "-s") {
      return { stdout: "Linux\n", code: 0 };
    }
    if (command === "nvidia-smi") {
      return {
        stdout: "0, NVIDIA GeForce RTX 4090, 24564, 550.54.14, 8.9\n",
        code: 0,
      };
    }
    return { stdout: "", code: 1 };
  };
}

Deno.test("collect writes the gpu record", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "collect",
  });
  await withMockedCommand(gpuHandler(), async () => {
    await (model.methods.collect.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  });
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "gpu");
  assertEquals(written[0].name, "gpu");
  const d = written[0].data as Record<string, unknown>;
  assertEquals(d.runtime, "cuda");
  assertEquals(d.vendor, "nvidia");
  assertEquals(d.totalVramMiB, 24564);
  const devices = d.devices as Array<Record<string, unknown>>;
  assertEquals(devices.length, 1);
  assertEquals(devices[0].name, "NVIDIA GeForce RTX 4090");
});
