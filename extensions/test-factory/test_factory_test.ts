/**
 * Execute-level tests for the test-factory model methods.
 *
 * These drive the real `execute` functions through `createModelTestContext`,
 * stubbing docker via the injectable `_run` runner. They prove the model wires
 * the catalog, harness builder, and result writer together correctly without
 * booting a single container.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";

import type { CmdResult } from "./docker.ts";
import { model } from "./test_factory.ts";

type Call = [string, ...string[]];

/** A canned harness result the stubbed container would have written. */
function harnessResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    installOk: true,
    swampVersion: "swamp 2026.09.30.1",
    doctorStatus: "pass",
    doctorStates: {},
    sourceAddOk: true,
    registeredTypes: ["@acme/thing"],
    modelTypes: ["@acme/thing"],
    missingTypes: [],
    definitions: [{ type: "@acme/thing", name: "tf-def-1", ok: true }],
    workflows: [],
    fixtures: [],
    ...overrides,
  });
}

/** Stub runner: answers docker + git deterministically. */
function stubRunner(
  opts: {
    dockerAvailable?: boolean;
    harness?: string;
    gitStdout?: string;
  } = {},
) {
  const calls: Call[] = [];
  const runner = (bin: string, args: string[]): Promise<CmdResult> => {
    calls.push([bin, ...args]);
    if (bin === "git") {
      return Promise.resolve({
        stdout: opts.gitStdout ?? "",
        stderr: "",
        code: 0,
      });
    }
    if (bin === "docker") {
      const sub = args.join(" ");
      if (sub.startsWith("version")) {
        return Promise.resolve({
          stdout: opts.dockerAvailable === false ? "" : "29.1.3",
          stderr: opts.dockerAvailable === false ? "no daemon" : "",
          code: opts.dockerAvailable === false ? 1 : 0,
        });
      }
      if (sub.startsWith("image inspect")) {
        return Promise.resolve({ stdout: "sha", stderr: "", code: 0 });
      }
      if (sub.startsWith("run -d")) {
        return Promise.resolve({ stdout: "container-id", stderr: "", code: 0 });
      }
      if (sub.includes("{{.State.Running}}")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      if (sub.startsWith("exec") && args.includes("cat")) {
        return Promise.resolve({
          stdout: opts.harness ?? harnessResult(),
          stderr: "",
          code: 0,
        });
      }
      if (sub.startsWith("exec")) {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (sub.startsWith("logs")) {
        return Promise.resolve({ stdout: "[tf] done", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  };
  return { runner, calls };
}

/** A temp candidate extension the model can inspect. */
async function writeCandidate(): Promise<{ manifest: string; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tf-candidate-" });
  await Deno.writeTextFile(
    `${dir}/manifest.yaml`,
    `manifestVersion: 1
name: "@acme/thing"
version: "2026.01.01.1"
models:
  - thing.ts
`,
  );
  await Deno.writeTextFile(
    `${dir}/thing.ts`,
    `export const model = { type: "@acme/thing", version: "1" };`,
  );
  return { manifest: `${dir}/manifest.yaml`, dir };
}

/**
 * Create a host output dir pre-populated with the harness result and its
 * completion sentinel, the way a real container would leave it, and return the
 * `_outBaseDir` the model should use.
 */
async function provisionOutput(harness: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tf-out-" });
  await Deno.writeTextFile(`${dir}/result.json`, harness);
  await Deno.writeTextFile(`${dir}/done`, "");
  return dir;
}

type MethodArgs = Record<string, unknown>;
type Executable = {
  execute: (args: MethodArgs, context: unknown) => Promise<unknown>;
};

async function runMethod(
  name: string,
  args: MethodArgs,
  ctxOpts: {
    repoDir: string;
    globalArgs?: Record<string, unknown>;
    harness?: string;
  },
) {
  const ctx = createModelTestContext({
    globalArgs: ctxOpts.globalArgs ?? {},
    methodName: name,
    repoDir: ctxOpts.repoDir,
  });
  const outBaseDir = await provisionOutput(
    ctxOpts.harness ?? harnessResult(),
  );
  const methods = model.methods as unknown as Record<string, Executable>;
  const promise = methods[name].execute(
    { ...args, _outBaseDir: outBaseDir },
    ctx.context as unknown,
  ) as Promise<{ dataHandles: unknown[] }>;
  return { promise, ctx };
}

Deno.test("test writes a result and a summary", async () => {
  const { runner } = stubRunner();
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise, ctx } = await runMethod(
      "test",
      {
        manifest,
        scenario: "debian-standalone",
        phases: "smoke,load,definitions",
        _run: runner,
      },
      { repoDir: dir },
    );
    const result = await promise;
    assertEquals(result.dataHandles.length, 2);
    const written = ctx.getWrittenResources();
    const results = written.filter((r) => r.specName === "result");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "debian-standalone");
    assertEquals(results[0].data.ok, true);
    assertEquals(results[0].data.doctorStatus, "pass");
    const summaries = written.filter((r) => r.specName === "summary");
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0].data.passCount, 1);
    assertEquals(summaries[0].data.count, 1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a failing harness yields a failed result", async () => {
  const { runner } = stubRunner();
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise, ctx } = await runMethod(
      "test",
      {
        manifest,
        scenario: "debian-standalone",
        phases: "smoke,load,definitions",
        _run: runner,
      },
      {
        repoDir: dir,
        harness: harnessResult({
          missingTypes: ["@acme/thing"],
          definitions: [
            { type: "@acme/thing", name: "x", ok: false, error: "boom" },
          ],
        }),
      },
    );
    await promise;
    const write = ctx.getWrittenResources().find((r) =>
      r.specName === "result"
    )!;
    assertEquals(write.data.ok, false);
    assertEquals(write.data.status, "fail");
    assertEquals((write.data.errors as string[]).length > 0, true);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("an expected-fail scenario passes when the install fails", async () => {
  const { runner } = stubRunner();
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise, ctx } = await runMethod(
      "test",
      {
        manifest,
        scenario: "alpine-standalone",
        phases: "smoke",
        _run: runner,
      },
      {
        repoDir: dir,
        harness: JSON.stringify({
          installOk: false,
          installError: "__res_init: symbol not found",
          swampVersion: "",
        }),
      },
    );
    await promise;
    const write = ctx.getWrittenResources().find((r) =>
      r.specName === "result"
    )!;
    assertEquals(write.data.ok, true);
    assertEquals(write.data.status, "pass");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test refuses to run without a container runtime", async () => {
  const { runner } = stubRunner({ dockerAvailable: false });
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise } = await runMethod(
      "test",
      { manifest, scenario: "debian-standalone", _run: runner },
      { repoDir: dir },
    );
    await assertRejects(
      () => promise,
      Error,
      "container runtime unavailable",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test requires a manifest", async () => {
  const { runner } = stubRunner();
  const { dir } = await writeCandidate();
  try {
    const { promise } = await runMethod(
      "test",
      { manifest: "", scenario: "debian-standalone", _run: runner },
      { repoDir: dir },
    );
    await assertRejects(() => promise, Error, "manifest");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("testAll sweeps every git-tracked manifest", async () => {
  const { runner, calls } = stubRunner({
    gitStdout: "extensions/a/manifest.yaml\nextensions/b/manifest.yaml\n",
  });
  const dir = await Deno.makeTempDir({ prefix: "tf-sweep-" });
  try {
    for (const name of ["a", "b"]) {
      await Deno.mkdir(`${dir}/extensions/${name}`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/extensions/${name}/manifest.yaml`,
        `manifestVersion: 1\nname: "@acme/${name}"\nversion: "1"\nmodels:\n  - ${name}.ts\n`,
      );
      await Deno.writeTextFile(
        `${dir}/extensions/${name}/${name}.ts`,
        `export const model = { type: "@acme/${name}", version: "1" };`,
      );
    }
    const { promise } = await runMethod(
      "testAll",
      {
        root: "extensions",
        scenario: "debian-standalone",
        phases: "smoke",
        _run: runner,
      },
      { repoDir: dir },
    );
    const result = await promise;
    // Two extensions x (one result + one summary).
    assertEquals(result.dataHandles.length, 4);
    assertEquals(
      calls.some((c) => c[0] === "git" && c[1] === "ls-files"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("listScenarios writes no data", async () => {
  const { promise } = await runMethod("listScenarios", {}, { repoDir: "/tmp" });
  const result = await promise;
  assertEquals(result.dataHandles, []);
});
